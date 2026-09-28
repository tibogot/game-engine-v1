// SKY PRO — air haze + sun shafts on three.js / TSL (part of the Sky Pro sky mode, v3/render/skypro/) — port of Tidewater's post/AirHaze.js (MIT, Copyright (c)
// 2026 DRG Software Solutions LLC — see v3/skypro-real/tidewater/LICENSE). WGSL verbatim through
// wgslFn; changes marked `// PORT:`.
//
// What it does (Tidewater's own summary, abridged):
//  - aerial perspective + marine haze: two exponential height layers (a thin dense marine layer at sea
//    level, H 110 m, and an aerosol layer, H 1400 m), analytic optical depth along the view ray. The
//    haze takes the colour of the sky just above the horizon in the view direction, so distant land
//    fades into the actual horizon sky, sun glow included. Sky pixels get none.
//  - volumetric sun shafts: the haze's sun in-scatter ray-marched at half resolution (16 quadratic
//    steps to 2.5 km) through the sun shadow map and the cloud shadow, jittered per pixel and frame and
//    accumulated over ~10 frames, depth-aware upsampled. Near geometry gets the lit in-scatter (bright
//    shafts between shadowed air); far and toward the sky only the shadowed deficit (crepuscular rays).
//  - screen-space god rays when the sun is in view and low: a sky mask round the sun x cloud
//    transmittance, blurred toward the sun in 3 passes of 8 taps (512 effective samples).
//
// PORT changes:
//  - camera: three's standard WebGPU depth (0..1, sky = 1) instead of reversed-Z; the view ray from
//    the camera's frustum tangents; no underwater (the lab has no water)
//  - the sun shadow: ONE three.js DirectionalLight shadow map (Tidewater: 3 cascades), read with
//    textureLoad and the light's view-projection matrix; no terrain hill-shadow texture (hills beyond
//    the shadow map cast no shafts)
//  - fog colour: the Sky Pro atmosphere's lookups (atmosphereSkyLuminance + skyMoonSky, with their
//    inputs as parameters); frame.skyIrradiance: that atmosphere's irradiance texture
//  - the sun mask pass is TSL (it reads the cloud view through the TSL viewSample)
//
// Use: const haze = createAirHaze( { renderer, atmosphere, clouds } );   (atmosphere: createSkyProAtmosphere)
//      per frame after the scene render: haze.render( { colorTex, depthTex, camera, light, sunDir,
//      sunColor, drawingBufferSize, viewDir(TSL fn) } ) -> the hazed HDR texture

import * as THREE from "three/webgpu";
import { Fn, wgsl, wgslFn, uniform, texture, sampler, screenCoordinate, screenUV, uv, vec4, float, exp, dot, select } from "three/tsl";

const STEPS = 16;
const MARCH_DIST = 2500;
const NEAR = 900;
const FAR_CLAMP = 60000;
const SS_TAPS = 8;
const SS_DECAY = [0.9, 0.97, 1.0];
const SS_GAIN = 3.5;
const MARINE = { sigma: 1.5e-4, H: 110 };
const AEROSOL = { sigma: 3.2e-5, H: 1400 };

const f = (x) => {
  const s = String(x);
  return s.includes(".") || s.includes("e") ? s : s + ".0";
};

// ------------------------------------------------------------------ shared WGSL
// PORT: the uniforms as private copies; hzLoad fills them (every entry calls it first)
const COMMON = /* wgsl */`
const HZ_PI: f32 = 3.141592653589793;
const HZ_MARINE_SIGMA: f32 = ${f(MARINE.sigma)};
const HZ_MARINE_H: f32 = ${f(MARINE.H)};
const HZ_AEROSOL_SIGMA: f32 = ${f(AEROSOL.sigma)};
const HZ_AEROSOL_H: f32 = ${f(AEROSOL.H)};
const HZ_FAR_CLAMP: f32 = ${f(FAR_CLAMP)};
const HZ_NEAR: f32 = ${f(NEAR)};
// 0 (density, shafts, enabled, frame) 1 (sunUV, ssFade, histValid) 2 (camPos, seaLevel) 3 (tanX, tanY, near, far)
// 4 (sunDir, -) 5 (sunColor, -) 6 (cloud shadow centre xz, size, strength) 7 (the atmosphere lookup's ap:
// real sun dir, view height km) 8 (prevCamPos, shadow on) 9 (sky sp0: moon dir, star intensity) 10 (sky sp1)
var<private> hzU: array<vec4f, 11>;
var<private> hzCamWorld: mat4x4f;
var<private> hzShadowM: mat4x4f;
var<private> hzPrevVP: mat4x4f;
fn hzLoad( u0: vec4f, u1: vec4f, u2: vec4f, u3: vec4f, u4: vec4f, u5: vec4f, u6: vec4f, u7: vec4f, u8: vec4f,
	u9: vec4f, u10: vec4f, camWorld: mat4x4f, shadowM: mat4x4f, prevVP: mat4x4f ) -> f32 {
	hzU[ 0 ] = u0; hzU[ 1 ] = u1; hzU[ 2 ] = u2; hzU[ 3 ] = u3; hzU[ 4 ] = u4; hzU[ 5 ] = u5; hzU[ 6 ] = u6; hzU[ 7 ] = u7; hzU[ 8 ] = u8;
	hzU[ 9 ] = u9; hzU[ 10 ] = u10;
	hzCamWorld = camWorld; hzShadowM = shadowM; hzPrevVP = prevVP;
	return 1.0;
}
fn hzSat( x: f32 ) -> f32 { return clamp( x, 0.0, 1.0 ); }
fn hzLuminance( c: vec3f ) -> f32 { return dot( c, vec3f( 0.2126, 0.7152, 0.0722 ) ); }
fn hzIGN( p: vec2f ) -> f32 { return fract( 52.9829189 * fract( dot( p, vec2f( 0.06711056, 0.00583715 ) ) ) ); }



fn hazeLayerDepth( sigma: f32, H: f32, hc: f32, vy: f32, d: f32 ) -> f32 {
	let base = exp( hc / - H ) * sigma;
	let k = vy * d / H;
	let fk = select( H * ( 1.0 - exp( - k ) ) / vy, d, abs( k ) < 1e-3 );
	return base * fk;
}
fn hazeInScatter( hc: f32, vy: f32, d: f32 ) -> f32 {
	return 1.0 - exp( - ( hazeLayerDepth( HZ_MARINE_SIGMA, HZ_MARINE_H, hc, vy, d ) + hazeLayerDepth( HZ_AEROSOL_SIGMA, HZ_AEROSOL_H, hc, vy, d ) ) * hzU[ 0 ].x );
}
fn hazePhase( cosT: f32 ) -> f32 {
	let g = 0.62; let g2 = g * g;
	let cs = 3.0 * ( 1.0 - g2 ) / ( 8.0 * HZ_PI * ( 2.0 + g2 ) ) * ( cosT * cosT + 1.0 ) / pow( max( 1.0 + g2 - cosT * 2.0 * g, 1e-4 ), 1.5 );
	return cs * 0.7 + 0.3 / ( 4.0 * HZ_PI );
}

struct HazeRay { dist: f32, dir: vec3f, sky: bool, rayLen: f32 };
// PORT: three's WebGPU depth (0 near .. 1 far, cleared to 1 = sky); the view ray from the frustum tangents.
// DEPTH_T is the scene depth's type, set when the passes are built: the engine's scene pass is
// multisampled (texture_depth_multisampled_2d), the lab's is not; textureLoad reads sample 0 of either.
fn hazeRay( uv: vec2f, depthT: DEPTH_T ) -> HazeRay {
	let size = vec2f( textureDimensions( depthT ) );
	let d = textureLoad( depthT, vec2i( clamp( uv, vec2f( 0.0 ), vec2f( 0.9999 ) ) * size ), 0 );
	let ndc = vec2f( uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0 );
	let ray = vec3f( ndc.x * hzU[ 3 ].x, ndc.y * hzU[ 3 ].y, -1.0 );
	var r: HazeRay;
	r.rayLen = length( ray );
	r.sky = d >= 0.9999999;
	let n = hzU[ 3 ].z; let fa = hzU[ 3 ].w;
	let viewDist = n * fa / max( fa - ( fa - n ) * d, 1e-6 ); // -viewZ
	r.dist = select( min( viewDist * r.rayLen, HZ_FAR_CLAMP ), HZ_FAR_CLAMP, r.sky );
	r.dir = normalize( ( hzCamWorld * vec4f( ray, 0.0 ) ).xyz );
	// PORT: a sky pixel BELOW the horizon is the sky dome's ground at sea level (Tidewater's sea always
	// covered these): the air ends there. Marched on, the ray went underground, every sample read as
	// shadowed, and the shaft deficit took the pixel to black.
	if ( r.sky && r.dir.y < -1e-4 ) {
		r.dist = min( r.dist, max( hzU[ 2 ].y - hzU[ 2 ].w, 0.0 ) / - r.dir.y );
	}
	// PORT: the far sea (Ocean Pro) draws what lies beyond the far plane pulled in to just inside it:
	// a surface there, below the horizon, is sea at sea level, as far away as the ray meets it
	if ( ! r.sky && r.dir.y < -1e-4 && viewDist > fa * 0.96 ) {
		r.dist = min( max( r.dist, max( hzU[ 2 ].y - hzU[ 2 ].w, 0.0 ) / - r.dir.y ), HZ_FAR_CLAMP );
	}
	return r;
}

// PORT: the cloud shadow (skyProCloudsTSL scCloudsShadow)
fn hzCloudsShadow( worldXZ: vec2f, sT: texture_2d<f32> ) -> f32 {
	let res = vec2i( textureDimensions( sT ) );
	let uv = ( worldXZ - hzU[ 6 ].xy ) / hzU[ 6 ].z + 0.5;
	let st = uv * vec2f( res ) - 0.5;
	let i0 = vec2i( floor( st ) );
	let fr = fract( st );
	let m = res - 1;
	let a = textureLoad( sT, clamp( i0, vec2i( 0 ), m ), 0 ).x;
	let b = textureLoad( sT, clamp( i0 + vec2i( 1, 0 ), vec2i( 0 ), m ), 0 ).x;
	let c = textureLoad( sT, clamp( i0 + vec2i( 0, 1 ), vec2i( 0 ), m ), 0 ).x;
	let e = textureLoad( sT, clamp( i0 + vec2i( 1, 1 ), vec2i( 0 ), m ), 0 ).x;
	let s = mix( mix( a, b, fr.x ), mix( c, e, fr.x ), fr.y );
	let ee = abs( uv - 0.5 );
	let inside = smoothstep( 0.5, 0.42, max( ee.x, ee.y ) );
	return mix( 1.0, s, hzU[ 6 ].w * inside );
}
fn hazeVisibilityRest( P: vec3f, v0: f32, cloudT: texture_2d<f32> ) -> f32 {
	var v = v0;
	if ( v > 0.0 ) {
		let L = hzU[ 4 ].xyz;
		let g = P.xz - L.xz * ( max( P.y, 0.0 ) / max( L.y, 0.08 ) );
		v *= hzCloudsShadow( g, cloudT );
	}
	return v;
}
`;

// ------------------------------------------------------------------ the march (half resolution)
const MARCH_FN = /* wgsl */`
fn hzMarch( gate: f32, uv: vec2f, px: vec2f, depthT: DEPTH_T, shadowT: texture_depth_2d, cloudT: texture_2d<f32> ) -> vec4f {
	let R = hazeRay( uv, depthT );
	var out = vec4f( 0.0, 0.0, R.dist, 1.0 );
	if ( hzU[ 0 ].z > 0.5 && hzU[ 0 ].y > 0.0 ) {
		let cam = hzU[ 2 ].xyz;
		let tMax = min( R.dist, ${f(MARCH_DIST)} );
		let jitter = fract( hzIGN( px ) + hzU[ 0 ].w * 0.61803398875 );
		let sigM = HZ_MARINE_SIGMA * hzU[ 0 ].x;
		let sigA = HZ_AEROSOL_SIGMA * hzU[ 0 ].x;
		var lit = 0.0; var all = 0.0; var tau = 0.0; var tPrev = 0.0;
		// PORT: one shadow map; the ray in its light space is linear in t (orthographic light)
		let sc0 = hzShadowM * vec4f( cam, 1.0 );
		let scd = hzShadowM * vec4f( R.dir, 0.0 );
		let shSize = vec2f( textureDimensions( shadowT ) );
		for ( var i = 0; i < ${STEPS}; i++ ) {
			let u = ( f32( i ) + jitter ) / ${f(STEPS)};
			let t = u * u * tMax;
			let dt = u * ${f(2 / STEPS)} * tMax;
			let P = cam + R.dir * t;
			let h = max( P.y - hzU[ 2 ].w, 0.0 );
			let sig = exp( h / - HZ_MARINE_H ) * sigM + exp( h / - HZ_AEROSOL_H ) * sigA;
			tau += sig * ( t - tPrev );
			tPrev = t;
			let Tr = exp( - tau );
			let w = sig * Tr * dt;
			var v = 1.0;
			if ( hzU[ 8 ].w > 0.5 ) {
				let sc = sc0 + scd * t;
				let suv = vec2f( sc.x * 0.5 + 0.5, 0.5 - sc.y * 0.5 );
				if ( ! ( any( suv <= vec2f( 0.0 ) ) || any( suv >= vec2f( 1.0 ) ) || sc.z > 1.0 || sc.z < 0.0 ) ) {
					let d = textureLoad( shadowT, vec2i( suv * shSize ), 0 );
					v = select( 0.0, 1.0, sc.z - 2e-4 <= d ); // PORT: the bias of one three shadow map
				}
			}
			lit += w * hazeVisibilityRest( P, v, cloudT );
			all += w;
		}
		let exact = hazeInScatter( max( cam.y - hzU[ 2 ].w, 0.0 ), R.dir.y, tMax );
		out = vec4f( lit / max( all, 1e-12 ), all / max( exact, 1e-12 ), R.dist, 1.0 );
	}
	return out;
}`;

// ------------------------------------------------------------------ temporal accumulation of the march
const TEMPORAL_FN = /* wgsl */`
fn hzTemporal( gate: f32, uv: vec2f, px: vec2f, depthT: DEPTH_T, curT: texture_2d<f32>, prevT: texture_2d<f32>, smp: sampler ) -> vec4f {
	let size = vec2i( textureDimensions( curT ) );
	let p = vec2i( px );
	let cur = textureLoad( curT, p, 0 );
	var out = cur;
	if ( hzU[ 1 ].w > 0.5 ) {
		var lo = cur.xy; var hi = cur.xy;
		for ( var k = 0; k < 9; k++ ) {
			let s = textureLoad( curT, clamp( p + vec2i( k % 3 - 1, k / 3 - 1 ), vec2i( 0 ), size - 1 ), 0 ).xy;
			lo = min( lo, s ); hi = max( hi, s );
		}
		let R = hazeRay( uv, depthT );
		let world = hzU[ 2 ].xyz + R.dir * cur.z;
		let clip = hzPrevVP * vec4f( world, 1.0 );
		if ( clip.w > 1e-4 ) {
			let puv = clip.xy / clip.w * vec2f( 0.5, -0.5 ) + 0.5;
			if ( all( puv >= vec2f( 0.0 ) ) && all( puv <= vec2f( 1.0 ) ) ) {
				let prev = textureSampleLevel( prevT, smp, puv, 0.0 );
				let expect = length( world - hzU[ 8 ].xyz );
				if ( abs( prev.z - expect ) < expect * 0.05 + 0.3 ) {
					out = vec4f( mix( clamp( prev.xy, lo, hi ), cur.xy, 0.12 ), cur.z, 1.0 );
				}
			}
		}
	}
	return out;
}`;

// ------------------------------------------------------------------ god rays: one radial blur pass
const blurFn = (p) => {
  const span = 0.95 / Math.pow(SS_TAPS, p);
  const decay = SS_DECAY[p];
  let taps = "", wSum = 0;
  for (let j = 0; j < SS_TAPS; j++) {
    const w = Math.pow(decay, j);
    taps += `\t\tacc += textureSampleLevel( src, smp, uv + stp * ( ${f(j)} + jit ), 0.0 ).r * ${f(w)};\n`;
    wSum += w;
  }
  return /* wgsl */`
fn hzBlur${p}( gate: f32, uv: vec2f, px: vec2f, src: texture_2d<f32>, smp: sampler ) -> vec4f {
	var out = vec4f( 0.0 );
	if ( hzU[ 1 ].z > 0.001 ) {
		let stp = ( hzU[ 1 ].xy - uv ) * ${f(span / SS_TAPS)};
		let jit = fract( hzIGN( px ) + hzU[ 0 ].w * 0.61803398875 + ${f(p * 0.37)} ) - 0.5;
		var acc = 0.0;
${taps}
		out = vec4f( acc / ${f(wSum)}, 0.0, 0.0, 1.0 );
	}
	return out;
}`;
};

// ------------------------------------------------------------------ the composite (hazeApply)
const APPLY_FN = /* wgsl */`
fn hzApply( gate: f32, uv: vec2f, c: vec4f, depthT: DEPTH_T, lowT: texture_2d<f32>, ssT: texture_2d<f32>, smp: sampler,
	irrT: texture_2d<f32>, skT: texture_2d<f32>, skS: sampler ) -> vec4f {
	var out = c.rgb;
	if ( hzU[ 0 ].z > 0.5 ) {
		let R = hazeRay( uv, depthT );
		let dist = R.dist; let dir = R.dir; let sky = R.sky;
		let camH = max( hzU[ 2 ].y - hzU[ 2 ].w, 0.0 );

		let vh = normalize( vec3f( dir.x, max( dir.y, 0.02 ), dir.z ) );
		// PORT: the Sky Pro atmosphere's lookups with their inputs (atmosphereSkyLuminance + skyMoonSky)
		let fog = atmosphereSkyLuminanceP( vh, hzU[ 7 ], skT, skS ) + skyMoonSkyP( vh, hzU[ 9 ], hzU[ 10 ] );

		let Ep = hzU[ 5 ].xyz * hazePhase( dot( dir, hzU[ 4 ].xyz ) );
		let eL = hzLuminance( Ep );
		let skyIrr = textureLoad( irrT, vec2i( 0, 0 ), 0 ).rgb; // PORT: frame.skyIrradiance
		let fSun = eL / ( eL + hzLuminance( skyIrr ) + 1e-5 ) * min( hzU[ 0 ].y, 1.0 );
		let h = select( smoothstep( 0.0, HZ_NEAR, dist ), 1.0, sky );

		if ( ! sky ) {
			let tau = ( hazeLayerDepth( HZ_MARINE_SIGMA, HZ_MARINE_H, camH, dir.y, dist ) + hazeLayerDepth( HZ_AEROSOL_SIGMA, HZ_AEROSOL_H, camH, dir.y, dist ) ) * hzU[ 0 ].x;
			let T = exp( - tau );
			out = out * T + fog * ( 1.0 - T ) * ( 1.0 - fSun * ( 1.0 - h ) );
		}

		if ( hzU[ 0 ].y > 0.0 ) {
			let ls = vec2i( textureDimensions( lowT ) );
			let pa = uv * vec2f( ls ) - 0.5;
			let i0 = floor( pa );
			let fr = pa - i0;
			var acc = vec2f( 0.0 );
			var wSum = 1e-6;
			for ( var k = 0; k < 4; k++ ) {
				let o = vec2i( k & 1, k >> 1u );
				let s = textureLoad( lowT, clamp( vec2i( i0 ) + o, vec2i( 0 ), ls - 1 ), 0 );
				let wb = select( 1.0 - fr.x, fr.x, o.x == 1 ) * select( 1.0 - fr.y, fr.y, o.y == 1 );
				let rel = abs( s.z - dist ) / max( dist, 0.5 );
				let q = rel * 10.0 + 1.0;
				let wd = 1.0 / ( q * q );
				let wt = wb * wd + 1e-5;
				acc += s.xy * wt;
				wSum += wt;
			}
			let sh = acc / wSum;
			let all = sh.y * hazeInScatter( camH, dir.y, min( dist, ${f(MARCH_DIST)} ) );
			let lit = hzSat( sh.x ) * all;
			let near = Ep * lit * ( 1.0 - h ) * hzU[ 0 ].y;
			let deficit = fog * fSun * ( all - lit ) * h;
			out = max( out + near - deficit, vec3f( 0.0 ) );
		}

		if ( hzU[ 1 ].z > 0.001 ) {
			let rays = textureSampleLevel( ssT, smp, uv, 0.0 ).r;
			let k = 1.0 - exp( - HZ_MARINE_SIGMA * 300.0 * hzU[ 0 ].x );
			out += Ep * rays * k * hzU[ 0 ].y * hzU[ 1 ].z * ${f(SS_GAIN)};
		}
	}
	return vec4f( out, c.a );
}`;

// the sky test of the god-ray mask, in WGSL so it reads a multisampled depth as well
const SKY_AT_FN = /* wgsl */`
fn hzSkyAt( uv: vec2f, depthT: DEPTH_T ) -> f32 {
	let size = vec2f( textureDimensions( depthT ) );
	let d = textureLoad( depthT, vec2i( clamp( uv, vec2f( 0.0 ), vec2f( 0.9999 ) ) * size ), 0 );
	return select( 0.0, 1.0, d >= 0.9999999 );
}`;

export function createAirHaze({ renderer, atmosphere, clouds }) {
  // The WGSL, per scene-depth type (plain or multisampled): built on first use of each.
  const U = Array.from({ length: 11 }, () => uniform(new THREE.Vector4()));
  const uCamWorld = uniform(new THREE.Matrix4());
  const uShadowM = uniform(new THREE.Matrix4());
  const uPrevVP = uniform(new THREE.Matrix4());
  const codeByType = new Map();
  function codeFor(ms) {
    if (codeByType.has(ms)) return codeByType.get(ms);
    const T = (s) => s.replaceAll("DEPTH_T", ms ? "texture_depth_multisampled_2d" : "texture_depth_2d");
    const common = wgsl(T(COMMON), [atmosphere.code]);
    const loadFn = wgslFn(/* wgsl */`fn hzLoadCall( u0: vec4f, u1: vec4f, u2: vec4f, u3: vec4f, u4: vec4f, u5: vec4f, u6: vec4f, u7: vec4f, u8: vec4f,
	u9: vec4f, u10: vec4f, camWorld: mat4x4f, shadowM: mat4x4f, prevVP: mat4x4f ) -> f32 { return hzLoad( u0, u1, u2, u3, u4, u5, u6, u7, u8, u9, u10, camWorld, shadowM, prevVP ); }`, [common]);
    const c = {
      gate: () => loadFn(...U, uCamWorld, uShadowM, uPrevVP),
      marchFn: wgslFn(T(MARCH_FN), [common]),
      temporalFn: wgslFn(T(TEMPORAL_FN), [common]),
      blurFns: [0, 1, 2].map((p) => wgslFn(blurFn(p), [common])),
      applyFn: wgslFn(T(APPLY_FN), [common]),
      skyAtFn: wgslFn(T(SKY_AT_FN)),
    };
    codeByType.set(ms, c);
    return c;
  }
  const isMultisampled = (tex) => (renderer.backend?.utils?.getTextureSampleData?.(tex)?.primarySamples ?? 1) > 1;

  const params = { density: 1.6, shafts: 1.0, enabled: true, godRays: true };

  // targets: half-res march + 2 history, quarter-res god rays x4, full-res output
  const rtOf = (type = THREE.HalfFloatType) => new THREE.RenderTarget(1, 1, { type, depthBuffer: false });
  const low = rtOf();
  const hist = [rtOf(), rtOf()];
  const ss = [0, 1, 2, 3].map(() => rtOf());
  const out = rtOf();
  let hc = 0, histValid = false;

  const skyNode = texture(atmosphere.textures.skyView);
  const irrNode = texture(atmosphere.textures.irradiance);
  const cloudShadowNode = texture(clouds.textures.shadowMap);

  // passes are built on the first render (the scene depth and the shadow map exist by then)
  let passes = null;
  const quadOf = (node) => {
    const m = new THREE.MeshBasicNodeMaterial();
    m.fragmentNode = node;
    m.depthTest = false; m.depthWrite = false;
    return new THREE.QuadMesh(m);
  };
  const colorNode = texture(new THREE.Texture()); // .value = the scene colour (set per frame)
  function build(depthTex, shadowTex, viewDir) {
    if (passes) {
      for (const q of [passes.march, ...passes.temporal, passes.mask, ...passes.blur, passes.apply]) q.material.dispose();
    }
    const ms = isMultisampled(depthTex);
    const { gate, marchFn, temporalFn, blurFns, applyFn, skyAtFn } = codeFor(ms);
    const depthNode = texture(depthTex);
    const shadowNode = texture(shadowTex);
    const px = screenCoordinate.xy;
    const march = quadOf(marchFn(gate(), screenUV, px, depthNode, shadowNode, cloudShadowNode));
    const temporal = [0, 1].map((src) => {
      const cur = texture(low.texture), prev = texture(hist[src].texture);
      return quadOf(temporalFn(gate(), screenUV, px, depthNode, cur, prev, sampler(prev)));
    });
    // PORT: the sun mask in TSL (the cloud view is a TSL function): sky pixels round the key light x
    // the cumulus transmittance
    const mask = quadOf(Fn(() => {
      const dir = viewDir();
      const cloudT = clouds.sunTransmittance(clouds.viewSample(dir).a);
      const c = dot(dir, U[4].xyz);
      const glow = exp(c.sub(1.0).mul(600.0)).add(exp(c.sub(1.0).mul(50.0)).mul(0.25));
      // (raw WGSL reads of render targets need no flip, as in the passes above)
      const isSky = skyAtFn(screenUV, depthNode).greaterThan(0.5);
      return vec4(select(U[1].z.greaterThan(0.001).and(isSky), glow.mul(cloudT), float(0.0)), 0, 0, 1);
    })());
    const blur = [0, 1, 2].map((p) => {
      const src = texture(ss[p].texture);
      return quadOf(blurFns[p](gate(), screenUV, px, src, sampler(src)));
    });
    const lowNode = texture(hist[0].texture); // .value = the newest history
    const ssNode = texture(ss[3].texture);
    const apply = quadOf(applyFn(gate(), screenUV, colorNode.sample(uv()).level(0), depthNode, lowNode, ssNode, sampler(ssNode), irrNode, skyNode, sampler(skyNode)));
    passes = { march, temporal, mask, blur, apply, lowNode, depthNode, shadowNode, ms };
    histValid = false;
  }

  let frameNo = 0;
  const w0 = new THREE.Vector2(-1, -1);
  const prevVP = new THREE.Matrix4(), prevPos = new THREE.Vector3();
  let havePrev = false;
  const _v = new THREE.Vector3();

  /**
   * @param {object} o  colorTex, depthTex (the scene render), camera, light (THREE.DirectionalLight with
   *   a rendered shadow map, or null), sunDir (key light), sunColor (Vector3, our units), size (Vector2,
   *   drawing buffer), viewDir (TSL Fn: world view direction at screenUV)
   * @returns the hazed HDR texture
   */
  // stands in for the shadow map when there is none (a cleared 1x1 depth; the march then skips it)
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

  function render(o) {
    const shadowTex = o.shadowDepth || null;
    if (!o.depthTex) return o.colorTex;
    // (a switch between a multisampled scene pass and a plain one changes the WGSL types: rebuild)
    if (!passes || passes.ms !== isMultisampled(o.depthTex)) build(o.depthTex, shadowTex || placeholderShadow(), o.viewDir);
    // The engine's depth and shadow textures are replaced on a resize or a cascade rebuild:
    // rebind them (a texture swap, no recompile) rather than read the old ones.
    if (passes.depthNode.value !== o.depthTex) passes.depthNode.value = o.depthTex;
    if (shadowTex && passes.shadowNode.value !== shadowTex) passes.shadowNode.value = shadowTex;
    const { x: W, y: H } = o.size;
    if (W !== w0.x || H !== w0.y) {
      w0.set(W, H);
      low.setSize(Math.round(W * 0.5), Math.round(H * 0.5));
      for (const r of hist) r.setSize(Math.round(W * 0.5), Math.round(H * 0.5));
      for (const r of ss) r.setSize(Math.round(W * 0.25), Math.round(H * 0.25));
      out.setSize(W, H);
      histValid = false;
    }
    colorNode.value = o.colorTex;
    frameNo = (frameNo + 1) % 1024;

    const cam = o.camera, L = o.sunDir;
    // key light on screen; the god rays fade as it leaves the frame and as it climbs (Tidewater update())
    const m = cam.matrixWorld.elements;
    const vx = m[0] * L.x + m[1] * L.y + m[2] * L.z;
    const vy = m[4] * L.x + m[5] * L.y + m[6] * L.z;
    const vz = m[8] * L.x + m[9] * L.y + m[10] * L.z;
    const tanY = Math.tan(THREE.MathUtils.degToRad(cam.fov * 0.5));
    const tanX = tanY * cam.aspect;
    const ssm = THREE.MathUtils.smoothstep;
    let fade = 0, su = 0.5, sv = 0.5;
    if (vz < -0.02) {
      su = 0.5 + 0.5 * (vx / -vz) / tanX;
      sv = 0.5 - 0.5 * (vy / -vz) / tanY;
      fade = (1 - ssm(Math.max(Math.abs(su - 0.5), Math.abs(sv - 0.5)), 0.6, 1.15)) * ssm(-vz, 0.02, 0.25) * (1 - ssm(L.y, 0.3, 0.75));
    }
    if (!params.enabled || params.shafts <= 0 || !params.godRays) fade = 0;
    const on = params.enabled && params.shafts > 0;

    U[0].value.set(params.density, params.shafts, params.enabled ? 1 : 0, frameNo);
    U[1].value.set(su, sv, fade, histValid && on ? 1 : 0);
    U[2].value.set(cam.position.x, cam.position.y, cam.position.z, o.seaLevel ?? 0);
    U[3].value.set(tanX, tanY, cam.near, cam.far);
    U[4].value.set(L.x, L.y, L.z, 0);
    U[5].value.set(o.sunColor.x, o.sunColor.y, o.sunColor.z, 0);
    const su2 = clouds.shadowUniforms;
    U[6].value.set(su2.center.value.x, su2.center.value.y, su2.size.value, su2.strength.value);
    U[7].value.copy(atmosphere.uniforms.ap.value);
    U[8].value.set(prevPos.x, prevPos.y, prevPos.z, shadowTex ? 1 : 0);
    U[9].value.copy(atmosphere.uniforms.sp0.value);
    U[10].value.copy(atmosphere.uniforms.sp1.value);
    uCamWorld.value.copy(cam.matrixWorld);
    if (o.light && shadowTex) {
      const sc = o.light.shadow.camera;
      uShadowM.value.multiplyMatrices(sc.projectionMatrix, sc.matrixWorldInverse);
    }
    if (havePrev) uPrevVP.value.copy(prevVP); else uPrevVP.value.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);

    const prevTarget = renderer.getRenderTarget();
    const draw = (q, rt) => { renderer.setRenderTarget(rt); q.render(renderer); };
    draw(passes.march, low);
    draw(passes.temporal[hc], hist[1 - hc]);
    passes.lowNode.value = hist[1 - hc].texture;
    hc = 1 - hc;
    histValid = on;
    if (fade > 0.001) {
      draw(passes.mask, ss[0]);
      for (let i = 0; i < 3; i++) draw(passes.blur[i], ss[i + 1]);
    }
    draw(passes.apply, out);
    renderer.setRenderTarget(prevTarget);

    prevVP.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    prevPos.copy(cam.position);
    havePrev = true;
    void _v;
    return out.texture;
  }

  return { params, render, targets: { low, hist, ss, out } };
}
