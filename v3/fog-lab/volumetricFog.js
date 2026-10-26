// VOLUMETRIC FOG — valley fog / mist with sun shafts, as a post pass on the linear HDR frame.
//
// Written to leave the lab: it knows nothing about the lab, the editor or a sky. Everything it
// needs comes in per frame (the scene depth, the camera, the key light, the ambient, the sun's
// shadow cascades), so any game, any terrain and any sky mode can feed it.
//
// The model, in world space (metres):
//  - a height layer: full density below `top`, an exponential tail above it (`falloff` m), so the
//    fog pools in the valleys and the hills stand out of it. `topBreakup` lifts and drops the top
//    with the noise, so it is not a flat lid.
//  - a tiling 3D noise (baked once, 64^3, value fbm + inverted Worley) drifting with the wind
//    carves it into banks and wisps (`noiseAmount`, `coverage`, `detail`).
//  - `haze`: an optional thin density everywhere, so shafts also show in clear air.
//
// The light, per march step:
//  - sun: shadowed by the sun's cascades (the trees' and hills' shafts), dimmed by the fog
//    above the sample toward the sun (analytic optical depth of the height layer: no light
//    march), with a 2-octave multiple-scattering approximation (Wrenninge) so thick fog glows
//    instead of going grey. Phase: Henyey-Greenstein `anisotropy` blended with isotropic.
//  - ambient: the sky, dimmed by the fog overhead.
//  - energy-conserving step integration (Hillaire 2015).
//
// Cost control, the same shape as Sky Pro's haze: the march runs at `resolution` (0.5 = half
// res) with a per-pixel jitter that changes every frame, a reprojected history clamped to the
// neighbourhood removes the noise, and a depth-aware upsample composites at full resolution.
// Without haze the ray is clipped to the layer's slab first: a pixel whose ray never enters the
// layer costs only the depth read.
//
// Use:
//   const fog = createVolumetricFog({ renderer });
//   per frame, on the linear HDR frame `rt` (read, then overwritten):
//   fog.composite(rt, { depthTex, camera, size, dt, sunDir, sunColor, ambient, cascades })
//     sunDir   Vector3 toward the key light          sunColor  [r,g,b] irradiance (scene units)
//     ambient  [r,g,b] the sky's radiance (scene units, e.g. sky irradiance / PI)
//     cascades [{ matrix: Matrix4 (light projection x view), depthTex }] near to far, 0..4

import * as THREE from "three/webgpu";
import { wgsl, wgslFn, uniform, texture, texture3D, sampler, screenCoordinate, screenUV, uv } from "three/tsl";

const MAX_STEPS = 128;
const MAX_CASCADES = 4;

export const VOLUMETRIC_FOG_DEFAULTS = {
  enabled: true,
  /** extinction inside the layer, 1/m (0.005 = a 400 m view through it keeps ~13 %) */
  density: 0.005,
  /** world Y of the layer's top (m) */
  top: 40,
  /** the tail above the top (m) */
  falloff: 18,
  /** how far the noise lifts and drops the top (m) */
  topBreakup: 14,
  /** extinction everywhere, 1/m (0 = only the layer; >0 shafts in clear air, costs the clip) */
  haze: 0,
  /** no fog nearer than this (m): keeps the foreground crisp when the camera stands in the layer */
  startDist: 0,
  /** noise cells per metre (1/120 = banks ~120 m across) */
  noiseFreq: 1 / 140,
  /** 0 = uniform layer .. 1 = fully carved by the noise */
  noiseAmount: 0.75,
  /** how much of the noise is fog */
  coverage: 0.6,
  /** the second, finer noise tap */
  detail: 0.5,
  /** m/s */
  windSpeed: 3,
  windDeg: 30,
  /** Henyey-Greenstein g (forward scattering toward the sun) */
  anisotropy: 0.55,
  /** multiples of the key light (1 = the scene's own sun) */
  sunScale: 1,
  ambientScale: 1,
  /** multiple scattering octave strength */
  multiScatter: 0.6,
  /** how strongly the fog above shades the fog below (1 = physical, from its own density) */
  selfShadow: 0.6,
  /** ambient dimming under the layer */
  ambientOcclusion: 0.35,
  /** fog colour (albedo); white = the light's own colour */
  tint: "#ffffff",
  steps: 40,
  /** march distance (m) */
  maxDist: 1800,
  /** march resolution (0.5 = half) */
  resolution: 0.5,
  /** new-frame weight of the temporal blend (lower = smoother, more lag) */
  temporalBlend: 0.12,
  /** the sun cascades' depth bias */
  shadowBias: 2e-4,
  shadows: true,
};

const f = (x) => {
  const s = String(x);
  return s.includes(".") || s.includes("e") ? s : s + ".0";
};

// ------------------------------------------------------------------ shared WGSL
// 0 (density, haze, top, falloff) 1 (noiseFreq, noiseAmount, coverage, topBreakup) 2 (wind offset xyz, frame)
// 3 (tanX, tanY, near, far) 4 (camPos, maxDist) 5 (sunDir, g) 6 (sun colour, multiScatter)
// 7 (ambient, ambientOcclusion) 8 (steps, selfShadow, histValid, cascades) 9 (tint, detail)
// 10 (enabled, temporalBlend, shadowBias, startDist)
const COMMON = /* wgsl */`
const VF_PI: f32 = 3.141592653589793;
var<private> vfU: array<vec4f, 11>;
var<private> vfCamWorld: mat4x4f;
var<private> vfPrevVP: mat4x4f;
var<private> vfShM: array<mat4x4f, ${MAX_CASCADES}>;
fn vfLoad( u0: vec4f, u1: vec4f, u2: vec4f, u3: vec4f, u4: vec4f, u5: vec4f, u6: vec4f, u7: vec4f, u8: vec4f,
	u9: vec4f, u10: vec4f, camWorld: mat4x4f, prevVP: mat4x4f, m0: mat4x4f, m1: mat4x4f, m2: mat4x4f, m3: mat4x4f ) -> f32 {
	vfU[ 0 ] = u0; vfU[ 1 ] = u1; vfU[ 2 ] = u2; vfU[ 3 ] = u3; vfU[ 4 ] = u4; vfU[ 5 ] = u5; vfU[ 6 ] = u6; vfU[ 7 ] = u7;
	vfU[ 8 ] = u8; vfU[ 9 ] = u9; vfU[ 10 ] = u10;
	vfCamWorld = camWorld; vfPrevVP = prevVP;
	vfShM[ 0 ] = m0; vfShM[ 1 ] = m1; vfShM[ 2 ] = m2; vfShM[ 3 ] = m3;
	return 1.0;
}
fn vfIGN( p: vec2f ) -> f32 { return fract( 52.9829189 * fract( dot( p, vec2f( 0.06711056, 0.00583715 ) ) ) ); }

struct VfRay { dist: f32, dir: vec3f, sky: bool };
// three's WebGPU depth (0 near .. 1 far, cleared to 1 = sky); the view ray from the frustum tangents.
// DEPTH_T is the scene depth's type (plain or multisampled), set when the passes are built.
fn vfRay( uv: vec2f, depthT: DEPTH_T ) -> VfRay {
	let size = vec2f( textureDimensions( depthT ) );
	let d = textureLoad( depthT, vec2i( clamp( uv, vec2f( 0.0 ), vec2f( 0.9999 ) ) * size ), 0 );
	let ndc = vec2f( uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0 );
	let ray = vec3f( ndc.x * vfU[ 3 ].x, ndc.y * vfU[ 3 ].y, -1.0 );
	var r: VfRay;
	r.sky = d >= 0.9999999;
	let n = vfU[ 3 ].z; let fa = vfU[ 3 ].w;
	let viewDist = n * fa / max( fa - ( fa - n ) * d, 1e-6 );
	r.dist = select( viewDist * length( ray ), 1e9, r.sky );
	r.dir = normalize( ( vfCamWorld * vec4f( ray, 0.0 ) ).xyz );
	return r;
}
fn vfHG( mu: f32, g: f32 ) -> f32 {
	let d = max( 1.0 + g * g - 2.0 * g * mu, 1e-4 );
	return ( 1.0 - g * g ) / ( 4.0 * VF_PI * d * sqrt( d ) );
}
`;

// (wgslFn takes ONE function per block: the march's helpers are an include)
const MARCH_HELPERS = /* wgsl */`
// optical depth of the height layer from height h upward along a direction of height component dy
fn vfTauUp( h: f32, dy: f32 ) -> f32 {
	let d = vfU[ 0 ].x; let top = vfU[ 0 ].z; let F = max( vfU[ 0 ].w, 1.0 );
	var tau = 0.0; var h2 = h;
	if ( h < top ) { tau = ( top - h ) * d; h2 = top; }
	tau += d * F * exp( -( h2 - top ) / F );
	return tau / max( dy, 0.05 );
}
fn vfShadowOne( M: mat4x4f, P: vec3f, t: texture_depth_2d ) -> f32 {
	let sc = M * vec4f( P, 1.0 );
	let suv = vec2f( sc.x * 0.5 + 0.5, 0.5 - sc.y * 0.5 );
	if ( any( suv <= vec2f( 0.0 ) ) || any( suv >= vec2f( 1.0 ) ) || sc.z > 1.0 || sc.z < 0.0 ) { return -1.0; }
	let d = textureLoad( t, vec2i( suv * vec2f( textureDimensions( t ) ) ), 0 );
	return select( 0.0, 1.0, sc.z - vfU[ 10 ].z <= d );
}
// the nearest cascade that holds P (they are nested by distance), lit outside them all
fn vfShadow( P: vec3f, s0: texture_depth_2d, s1: texture_depth_2d, s2: texture_depth_2d, s3: texture_depth_2d ) -> f32 {
	let n = i32( vfU[ 8 ].w );
	var r = -1.0;
	if ( n > 0 ) { r = vfShadowOne( vfShM[ 0 ], P, s0 ); }
	if ( r < 0.0 && n > 1 ) { r = vfShadowOne( vfShM[ 1 ], P, s1 ); }
	if ( r < 0.0 && n > 2 ) { r = vfShadowOne( vfShM[ 2 ], P, s2 ); }
	if ( r < 0.0 && n > 3 ) { r = vfShadowOne( vfShM[ 3 ], P, s3 ); }
	return select( r, 1.0, r < 0.0 );
}
fn vfDensity( P: vec3f, noiseT: texture_3d<f32>, s: sampler ) -> f32 {
	let q = P * vfU[ 1 ].x + vfU[ 2 ].xyz;
	let n1 = textureSampleLevel( noiseT, s, q, 0.0 ).r;
	var n = n1;
	if ( vfU[ 9 ].w > 0.0 ) {
		let n2 = textureSampleLevel( noiseT, s, q * 3.71 + vec3f( 0.31, 0.17, 0.53 ) + vfU[ 2 ].xyz * 0.9, 0.0 ).r;
		n = n1 - ( 1.0 - n2 ) * vfU[ 9 ].w * 0.3;
	}
	let top = vfU[ 0 ].z + ( n1 - 0.5 ) * 2.0 * vfU[ 1 ].w;
	let hT = exp( -max( P.y - top, 0.0 ) / max( vfU[ 0 ].w, 1.0 ) );
	let c = vfU[ 1 ].z;
	let m = smoothstep( 1.0 - c - 0.25, 1.0 - c + 0.25, n );
	return vfU[ 0 ].x * hT * mix( 1.0, m, vfU[ 1 ].y ) + vfU[ 0 ].y;
}`;

const MARCH_FN = /* wgsl */`
fn vfMarch( gate: f32, uv: vec2f, px: vec2f, depthT: DEPTH_T, noiseT: texture_3d<f32>, noiseS: sampler,
	s0: texture_depth_2d, s1: texture_depth_2d, s2: texture_depth_2d, s3: texture_depth_2d ) -> vec4f {
	var out = vec4f( 0.0, 0.0, 0.0, 1.0 );
	if ( vfU[ 10 ].x < 0.5 ) { return out; }
	let R = vfRay( uv, depthT );
	let cam = vfU[ 4 ].xyz;
	var t0 = 0.0;
	var t1 = min( R.dist, vfU[ 4 ].w );
	// no haze: only the layer's slab holds fog
	if ( vfU[ 0 ].y <= 0.0 ) {
		let hMax = vfU[ 0 ].z + vfU[ 1 ].w + vfU[ 0 ].w * 6.0;
		if ( cam.y > hMax ) {
			if ( R.dir.y >= -1e-4 ) { return out; }
			t0 = ( cam.y - hMax ) / -R.dir.y;
		} else if ( R.dir.y > 1e-4 ) {
			t1 = min( t1, ( hMax - cam.y ) / R.dir.y );
		}
	}
	t0 = max( t0, vfU[ 10 ].w );
	if ( t0 >= t1 ) { return out; }

	let N = i32( vfU[ 8 ].x );
	let fN = f32( N );
	let jitter = fract( vfIGN( px ) + vfU[ 2 ].w * 0.61803398875 );
	// from the camera: denser steps near it (shafts are near); from above the slab: uniform
	let k = select( 1.0, 1.7, t0 <= 0.0 );
	let span = t1 - t0;
	let L = vfU[ 5 ].xyz;
	let mu = dot( R.dir, L );
	let g = vfU[ 5 ].w;
	let iso = 1.0 / ( 4.0 * VF_PI );
	let ph0 = mix( vfHG( mu, g ), iso, 0.3 );
	let ph1 = mix( vfHG( mu, g * 0.5 ), iso, 0.5 );
	let sunC = vfU[ 6 ].xyz;
	let ms = vfU[ 6 ].w;
	let amb = vfU[ 7 ].xyz;
	let alb = vfU[ 9 ].xyz;
	var T = 1.0;
	var scat = vec3f( 0.0 );
	for ( var i = 0; i < ${MAX_STEPS}; i++ ) {
		if ( i >= N ) { break; }
		let ua = f32( i ) / fN;
		let ub = f32( i + 1 ) / fN;
		let dt = span * ( pow( ub, k ) - pow( ua, k ) );
		let t = t0 + span * pow( ( f32( i ) + jitter ) / fN, k );
		let P = cam + R.dir * t;
		let sig = vfDensity( P, noiseT, noiseS );
		if ( sig > 1e-7 ) {
			var vis = 1.0;
			if ( vfU[ 8 ].w > 0.5 ) { vis = vfShadow( P, s0, s1, s2, s3 ); }
			let tauS = vfTauUp( P.y, L.y ) * vfU[ 8 ].y;
			let tauA = vfTauUp( P.y, 1.0 ) * vfU[ 7 ].w;
			let sunL = sunC * vis * ( exp( -tauS ) * ph0 + ms * exp( -tauS * 0.25 ) * ph1 );
			let S = ( sunL + amb * exp( -tauA ) ) * alb * sig;
			let e = exp( -sig * dt );
			scat += T * ( S - S * e ) / sig;
			T *= e;
			if ( T < 0.003 ) { break; }
		}
	}
	out = vec4f( scat, T );
	return out;
}`;

const TEMPORAL_FN = /* wgsl */`
fn vfTemporal( gate: f32, uv: vec2f, px: vec2f, depthT: DEPTH_T, curT: texture_2d<f32>, prevT: texture_2d<f32>, smp: sampler ) -> vec4f {
	let size = vec2i( textureDimensions( curT ) );
	let p = vec2i( px );
	let cur = textureLoad( curT, p, 0 );
	if ( vfU[ 8 ].z < 0.5 ) { return cur; }
	var lo = cur; var hi = cur;
	for ( var k = 0; k < 9; k++ ) {
		let s = textureLoad( curT, clamp( p + vec2i( k % 3 - 1, k / 3 - 1 ), vec2i( 0 ), size - 1 ), 0 );
		lo = min( lo, s ); hi = max( hi, s );
	}
	let R = vfRay( uv, depthT );
	let world = vfU[ 4 ].xyz + R.dir * min( R.dist, vfU[ 4 ].w );
	let clip = vfPrevVP * vec4f( world, 1.0 );
	if ( clip.w <= 1e-4 ) { return cur; }
	let puv = clip.xy / clip.w * vec2f( 0.5, -0.5 ) + 0.5;
	if ( any( puv < vec2f( 0.0 ) ) || any( puv > vec2f( 1.0 ) ) ) { return cur; }
	let prev = textureSampleLevel( prevT, smp, puv, 0.0 );
	return mix( clamp( prev, lo, hi ), cur, vfU[ 10 ].y );
}`;

// full resolution: depth-aware upsample of the fog, then  colour x transmittance + in-scatter
const APPLY_FN = /* wgsl */`
fn vfApply( gate: f32, uv: vec2f, c: vec4f, depthT: DEPTH_T, lowT: texture_2d<f32> ) -> vec4f {
	if ( vfU[ 10 ].x < 0.5 ) { return c; }
	let R = vfRay( uv, depthT );
	let dist = min( R.dist, vfU[ 4 ].w );
	let ls = vec2i( textureDimensions( lowT ) );
	let pa = uv * vec2f( ls ) - 0.5;
	let i0 = floor( pa );
	let fr = pa - i0;
	var acc = vec4f( 0.0 );
	var wSum = 0.0;
	for ( var k = 0; k < 4; k++ ) {
		let o = vec2i( k & 1, k >> 1u );
		let q = clamp( vec2i( i0 ) + o, vec2i( 0 ), ls - 1 );
		let s = textureLoad( lowT, q, 0 );
		let Rq = vfRay( ( vec2f( q ) + 0.5 ) / vec2f( ls ), depthT );
		let dq = min( Rq.dist, vfU[ 4 ].w );
		let wb = select( 1.0 - fr.x, fr.x, o.x == 1 ) * select( 1.0 - fr.y, fr.y, o.y == 1 );
		let rel = abs( dq - dist ) / max( dist, 0.5 );
		let qq = rel * 10.0 + 1.0;
		let w = wb / ( qq * qq ) + 1e-5;
		acc += s * w;
		wSum += w;
	}
	let fog = acc / wSum;
	return vec4f( c.rgb * fog.a + fog.rgb, c.a );
}`;

// ------------------------------------------------------------------ the noise volume
// Tiling 3D noise: value fbm (4 octaves) blended with inverted Worley, R8. Baked once (~60 ms).
function hash3(x, y, z, seed) {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 2147483647) + Math.imul(seed, 144665);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function makeNoiseVolume(N = 64) {
  const data = new Uint8Array(N * N * N);
  const smooth = (t) => t * t * (3 - 2 * t);
  const valueAt = (x, y, z, period, seed) => {
    const fx = (x / N) * period, fy = (y / N) * period, fz = (z / N) * period;
    const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz);
    const tx = smooth(fx - ix), ty = smooth(fy - iy), tz = smooth(fz - iz);
    const w = (a) => ((a % period) + period) % period;
    const v = (a, b, c) => hash3(w(ix + a), w(iy + b), w(iz + c), seed);
    const l = (a, b, t) => a + (b - a) * t;
    return l(
      l(l(v(0, 0, 0), v(1, 0, 0), tx), l(v(0, 1, 0), v(1, 1, 0), tx), ty),
      l(l(v(0, 0, 1), v(1, 0, 1), tx), l(v(0, 1, 1), v(1, 1, 1), tx), ty),
      tz,
    );
  };
  const CELLS = 5;
  const pts = [];
  for (let z = 0; z < CELLS; z++) for (let y = 0; y < CELLS; y++) for (let x = 0; x < CELLS; x++) {
    pts.push([(x + hash3(x, y, z, 7)) / CELLS, (y + hash3(x, y, z, 11)) / CELLS, (z + hash3(x, y, z, 13)) / CELLS]);
  }
  const worleyAt = (px, py, pz) => {
    const cx = Math.floor(px * CELLS), cy = Math.floor(py * CELLS), cz = Math.floor(pz * CELLS);
    let best = 1e9;
    for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const ax = cx + dx, ay = cy + dy, az = cz + dz;
      const wx = ((ax % CELLS) + CELLS) % CELLS, wy = ((ay % CELLS) + CELLS) % CELLS, wz = ((az % CELLS) + CELLS) % CELLS;
      const p = pts[wx + wy * CELLS + wz * CELLS * CELLS];
      const ox = p[0] + Math.floor(ax / CELLS) - px, oy = p[1] + Math.floor(ay / CELLS) - py, oz = p[2] + Math.floor(az / CELLS) - pz;
      best = Math.min(best, ox * ox + oy * oy + oz * oz);
    }
    return Math.min(1, Math.sqrt(best) * CELLS * 0.75);
  };
  let i = 0;
  for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const fbm = valueAt(x, y, z, 4, 1) * 0.5 + valueAt(x, y, z, 8, 2) * 0.25 + valueAt(x, y, z, 16, 3) * 0.15 + valueAt(x, y, z, 32, 4) * 0.1;
    const wor = 1 - worleyAt(x / N, y / N, z / N);
    const v = Math.min(1, Math.max(0, (fbm * 0.6 + wor * 0.4 - 0.15) * 1.45));
    data[i++] = Math.round(v * 255);
  }
  const tex = new THREE.Data3DTexture(data, N, N, N);
  tex.format = THREE.RedFormat;
  tex.type = THREE.UnsignedByteType;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}

// ------------------------------------------------------------------ the module
export function createVolumetricFog({ renderer, params = {} }) {
  const P = { ...VOLUMETRIC_FOG_DEFAULTS, ...params };

  const U = Array.from({ length: 11 }, () => uniform(new THREE.Vector4()));
  const uCamWorld = uniform(new THREE.Matrix4());
  const uPrevVP = uniform(new THREE.Matrix4());
  const uShM = Array.from({ length: MAX_CASCADES }, () => uniform(new THREE.Matrix4()));
  const codeByType = new Map();
  function codeFor(ms) {
    if (codeByType.has(ms)) return codeByType.get(ms);
    const T = (s) => s.replaceAll("DEPTH_T", ms ? "texture_depth_multisampled_2d" : "texture_depth_2d");
    const common = wgsl(T(COMMON));
    const loadFn = wgslFn(/* wgsl */`fn vfLoadCall( u0: vec4f, u1: vec4f, u2: vec4f, u3: vec4f, u4: vec4f, u5: vec4f, u6: vec4f, u7: vec4f, u8: vec4f,
	u9: vec4f, u10: vec4f, camWorld: mat4x4f, prevVP: mat4x4f, m0: mat4x4f, m1: mat4x4f, m2: mat4x4f, m3: mat4x4f ) -> f32 {
	return vfLoad( u0, u1, u2, u3, u4, u5, u6, u7, u8, u9, u10, camWorld, prevVP, m0, m1, m2, m3 ); }`, [common]);
    const c = {
      gate: () => loadFn(...U, uCamWorld, uPrevVP, ...uShM),
      marchFn: wgslFn(T(MARCH_FN), [common, wgsl(MARCH_HELPERS)]),
      temporalFn: wgslFn(T(TEMPORAL_FN), [common]),
      applyFn: wgslFn(T(APPLY_FN), [common]),
    };
    codeByType.set(ms, c);
    return c;
  }
  const isMultisampled = (tex) => (renderer.backend?.utils?.getTextureSampleData?.(tex)?.primarySamples ?? 1) > 1;

  const noiseTex = makeNoiseVolume(64);
  const rtOf = () => new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
  const low = rtOf();
  const hist = [rtOf(), rtOf()];
  const out = rtOf();
  let hc = 0, histValid = false;

  // stands in for a missing cascade (a cleared 1x1 depth; never read: the cascade count gates it)
  let noShadow = null;
  function placeholderShadow() {
    if (!noShadow) {
      noShadow = new THREE.RenderTarget(1, 1, { depthBuffer: true });
      noShadow.depthTexture = new THREE.DepthTexture(1, 1);
      const prev = renderer.getRenderTarget();
      renderer.setRenderTarget(noShadow);
      renderer.clear();
      renderer.setRenderTarget(prev);
    }
    return noShadow.depthTexture;
  }

  const quadOf = (node) => {
    const m = new THREE.MeshBasicNodeMaterial();
    m.fragmentNode = node;
    m.depthTest = false; m.depthWrite = false;
    return new THREE.QuadMesh(m);
  };
  const colorNode = texture(new THREE.Texture());
  const copySrc = texture(new THREE.Texture());
  const copyQuad = quadOf(copySrc.sample(uv()).level(0)); // render target to render target: uv()

  let passes = null;
  function build(depthTex) {
    if (passes) for (const q of [passes.march, ...passes.temporal, passes.apply]) q.material.dispose();
    const ms = isMultisampled(depthTex);
    const { gate, marchFn, temporalFn, applyFn } = codeFor(ms);
    const depthNode = texture(depthTex);
    const noiseNode = texture3D(noiseTex);
    const shadowNodes = Array.from({ length: MAX_CASCADES }, () => texture(placeholderShadow()));
    const px = screenCoordinate.xy;
    const march = quadOf(marchFn(gate(), screenUV, px, depthNode, noiseNode, sampler(noiseNode), ...shadowNodes));
    const temporal = [0, 1].map((src) => {
      const cur = texture(low.texture), prev = texture(hist[src].texture);
      return quadOf(temporalFn(gate(), screenUV, px, depthNode, cur, prev, sampler(prev)));
    });
    const lowNode = texture(hist[0].texture); // .value = the newest history
    const apply = quadOf(applyFn(gate(), screenUV, colorNode.sample(uv()).level(0), depthNode, lowNode));
    passes = { march, temporal, apply, lowNode, depthNode, shadowNodes, ms };
    histValid = false;
  }

  const size0 = new THREE.Vector2(-1, -1);
  let res0 = -1;
  let frameNo = 0;
  const wind = new THREE.Vector3();
  const tint = new THREE.Color();
  const prevVP = new THREE.Matrix4();
  let havePrev = false;
  let lastCam = null;

  /** Fog the frame in `rt` (the linear HDR target: read, then overwritten). */
  function composite(rt, o) {
    if (!P.enabled || !o.depthTex) { histValid = false; return; }
    if (!passes || passes.ms !== isMultisampled(o.depthTex)) build(o.depthTex);
    if (passes.depthNode.value !== o.depthTex) passes.depthNode.value = o.depthTex;

    const W = o.size.x, H = o.size.y;
    if (W !== size0.x || H !== size0.y || P.resolution !== res0) {
      size0.set(W, H); res0 = P.resolution;
      const lw = Math.max(1, Math.round(W * P.resolution)), lh = Math.max(1, Math.round(H * P.resolution));
      low.setSize(lw, lh);
      for (const r of hist) r.setSize(lw, lh);
      out.setSize(W, H);
      histValid = false;
      // a resized target is only re-created when drawn INTO: clear the histories so both exist
      const prev = renderer.getRenderTarget();
      for (const r of hist) { renderer.setRenderTarget(r); renderer.clear(); }
      renderer.setRenderTarget(prev);
    }

    const cam = o.camera;
    if (cam !== lastCam) { lastCam = cam; havePrev = false; histValid = false; }
    cam.updateMatrixWorld();
    frameNo = (frameNo + 1) % 1024;
    // the noise drifts with the wind (and slowly rises, so it evolves instead of only sliding)
    const dt = Math.min(o.dt ?? 1 / 60, 0.1);
    const wr = THREE.MathUtils.degToRad(P.windDeg);
    wind.x -= Math.cos(wr) * P.windSpeed * P.noiseFreq * dt;
    wind.z -= Math.sin(wr) * P.windSpeed * P.noiseFreq * dt;
    wind.y -= 0.15 * P.windSpeed * P.noiseFreq * dt;
    wind.set(wind.x % 64, wind.y % 64, wind.z % 64);

    const cascades = P.shadows ? (o.cascades ?? []).filter((c) => c?.depthTex).slice(0, MAX_CASCADES) : [];
    for (let i = 0; i < MAX_CASCADES; i++) {
      const c = cascades[i];
      if (c) {
        uShM[i].value.copy(c.matrix);
        if (passes.shadowNodes[i].value !== c.depthTex) passes.shadowNodes[i].value = c.depthTex;
      }
    }

    const tanY = Math.tan(THREE.MathUtils.degToRad(cam.fov * 0.5));
    const sun = o.sunColor ?? [0, 0, 0], amb = o.ambient ?? [0, 0, 0], L = o.sunDir;
    tint.set(P.tint);
    U[0].value.set(P.density, P.haze, P.top, P.falloff);
    U[1].value.set(P.noiseFreq, P.noiseAmount, P.coverage, P.topBreakup);
    U[2].value.set(wind.x, wind.y, wind.z, frameNo);
    U[3].value.set(tanY * cam.aspect, tanY, cam.near, cam.far);
    U[4].value.set(cam.position.x, cam.position.y, cam.position.z, P.maxDist);
    U[5].value.set(L.x, L.y, L.z, P.anisotropy);
    U[6].value.set(sun[0] * P.sunScale, sun[1] * P.sunScale, sun[2] * P.sunScale, P.multiScatter);
    U[7].value.set(amb[0] * P.ambientScale, amb[1] * P.ambientScale, amb[2] * P.ambientScale, P.ambientOcclusion);
    U[8].value.set(Math.min(MAX_STEPS, Math.max(4, Math.round(P.steps))), P.selfShadow, histValid ? 1 : 0, cascades.length);
    U[9].value.set(tint.r, tint.g, tint.b, P.detail);
    U[10].value.set(1, P.temporalBlend, P.shadowBias, Math.max(0, P.startDist));
    uCamWorld.value.copy(cam.matrixWorld);
    if (havePrev) uPrevVP.value.copy(prevVP);
    else uPrevVP.value.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);

    const prevTarget = renderer.getRenderTarget();
    const draw = (q, target) => { renderer.setRenderTarget(target); q.render(renderer); };
    draw(passes.march, low);
    draw(passes.temporal[hc], hist[1 - hc]);
    passes.lowNode.value = hist[1 - hc].texture;
    hc = 1 - hc;
    histValid = true;
    colorNode.value = rt.texture;
    draw(passes.apply, out);
    copySrc.value = out.texture;
    draw(copyQuad, rt);
    renderer.setRenderTarget(prevTarget);

    prevVP.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    havePrev = true;
  }

  function dispose() {
    if (passes) for (const q of [passes.march, ...passes.temporal, passes.apply]) q.material.dispose();
    copyQuad.material.dispose();
    for (const r of [low, ...hist, out]) r.dispose();
    noShadow?.dispose();
    noiseTex.dispose();
  }

  return {
    params: P,
    composite,
    /** forget the history (after a camera cut) */
    resetHistory() { histValid = false; havePrev = false; },
    dispose,
    targets: { low, hist, out },
  };
}
