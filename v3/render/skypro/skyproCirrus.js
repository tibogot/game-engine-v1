// SKY PRO — the cirrus veil on three.js / TSL (part of the Sky Pro sky mode, v3/render/skypro/) — port of the cirrus in Tidewater's sky/Clouds.js (the layer that sat
// above its first cumulus; MIT, Copyright (c) 2026 DRG Software Solutions LLC — see
// v3/skypro-real/tidewater/LICENSE). Tidewater's live build (Sky Pro cumulus) does not draw it; here it
// goes over the Sky Pro port: `clOver( cumulus, cirrus )`, exactly how Clouds.js layered its own.
//
// What it is: a thin sheet on a curved-earth shell at 9 km, so its fibres converge toward the horizon
// in true perspective. Coverage varies over hundreds of km; long, gently curved fibres (line integral
// convolution along a meandering flow, with hooked tufts) follow the upper wind, which blows 1.6x the
// lower one. The fibre texture is filtered anisotropically by the pixel footprint (3 taps along the
// long axis, cubic B-spline each), so distant fibres melt into a smooth veil. Lighting: ice crystals —
// a strong forward peak, a faint 22 degree halo, some backscatter, a little multiple scattering, sky
// light — lit by the sun at 9 km (it stays lit after sunset at the ground) and cut by the earth's shadow.
//
// PORT changes (marked `// PORT:` in the WGSL):
//   - uniforms are passed in (a private copy, `ciP`), textures and samplers as parameters;
//   - the key light at 9 km: Tidewater read its transmittance LUT per pixel. Here a 128-entry table of
//     the Sky Pro atmosphere's transmittance at 9 km (skyproAtmosphere sunColorAt) over the local sun cosine, so the
//     per-pixel sunset colour across the sheet is kept;
//   - frame.skyIrradiance: the Sky Pro atmosphere's irradiance texture (Tidewater's own irradiance
//     kernel, run by skyproAtmosphere.js); atmosphereSkyLuminance: the shared lookup with its inputs;
//   - the upper-wind frame follows the live wind direction (Tidewater froze it at start), and the drift
//     offset wraps at 4096 km instead of the cumulus tile (32.8 km), which popped the coverage;
//   - the three bakes are fragment passes into render targets (three builds the fibre mips).
//
// Public:
//   const cirrus = createCirrus( { renderer, atmosphere } );  (bakes at once)
//   cirrus.sample( dir, pxAngle )  TSL: vec4( in-scattered radiance, transmittance ), (0,0,0,1) if none
//   cirrus.update( dt, camera, { lightDir, sunDir, moonE, windDir, windSpeed, coverage } )
//   cirrus.amount.value (0..1, Tidewater 0.5), cirrus.altitude.value (m, 9000)
//   (the sky irradiance it is lit by is the atmosphere's: atmosphere.irradianceNode / .horizonNode)

import * as THREE from "three/webgpu";
import { wgsl, wgslFn, uniform, texture, sampler, screenCoordinate, vec4 } from "three/tsl";

const PI = Math.PI;
const EARTH_R = 6360000;
const SYN_RES = 256, SYN_SIZE = 409600; // m
const FIB_RES = 1024, FIB_TILE = 40000; // m
const AP_DIST = 30000;
const E_RES = 128, E_MU0 = -0.3; // key-light table: mu from E_MU0 to 1
const WRAP = SYN_SIZE * 10;

const f = (x) => {
  const s = String(x);
  return s.includes(".") || s.includes("e") ? s : s + ".0";
};

// ------------------------------------------------------------------ WGSL: Tidewater's noise helpers (verbatim)
const NOISE_WGSL = /* wgsl */`
const CI_PI: f32 = ${f(PI)};
fn clMod2( x: vec2f, y: vec2f ) -> vec2f { return x - y * floor( x / y ); }
fn clHash2( p: vec2f ) -> f32 { return fract( sin( dot( p, vec2f( 127.1, 311.7 ) ) ) * 43758.5453 ); }
fn clGh( i: vec2f, f: vec2f, o: vec2f, cells: vec2f ) -> f32 {
	let c = clMod2( i + o, cells );
	let a = clHash2( c ) * ${f(2 * PI)};
	return dot( vec2f( cos( a ), sin( a ) ), f - o );
}
fn clGnoise2( p: vec2f, cells: vec2f ) -> f32 {
	let q = p * cells;
	let i = floor( q );
	let f = fract( q );
	let u = f * f * ( f * ( f * 6.0 - 15.0 ) + 10.0 ); // (sic: the original's fade, f^2 not f^3)
	return mix( mix( clGh( i, f, vec2f( 0.0, 0.0 ), cells ), clGh( i, f, vec2f( 1.0, 0.0 ), cells ), u.x ),
		mix( clGh( i, f, vec2f( 0.0, 1.0 ), cells ), clGh( i, f, vec2f( 1.0, 1.0 ), cells ), u.x ), u.y );
}
fn clGfbm( p: vec2f, cells: vec2f, seed: f32 ) -> f32 {
	return ( clGnoise2( p + seed, cells ) * 0.55 + clGnoise2( p + seed * 1.7, cells * 2.0 ) * 0.3 + clGnoise2( p + seed * 2.3, cells * 4.0 ) * 0.15 ) * 1.6 + 0.5;
}
fn ciSat( x: f32 ) -> f32 { return clamp( x, 0.0, 1.0 ); }
`;

// ------------------------------------------------------------------ bakes (Clouds.js syn / aux / fib kernels)
// PORT: fragment passes; `px` is the fragment coordinate (texel centre), as gid + 0.5 was
const SYN_FN = /* wgsl */`
fn ciSyn( px: vec2f ) -> vec4f {
	let p = px / ${f(SYN_RES)};
	let cov = clGfbm( p, vec2f( 2.0, 3.0 ), 0.31 );
	let streets = clGfbm( p, vec2f( 4.0, 14.0 ), 0.59 );
	let patches = clGfbm( p, vec2f( 10.0, 14.0 ), 0.83 ) * 0.7 + clGfbm( p, vec2f( 28.0, 40.0 ), 0.21 ) * 0.3;
	return clamp( vec4f( cov, streets, patches, 1.0 ), vec4f( 0.0 ), vec4f( 1.0 ) );
}`;

const AUX_CODE = /* wgsl */`
fn ciPsi( q: vec2f ) -> f32 { return clGnoise2( q, vec2f( 3.0 ) ) * 0.5 + clGnoise2( q + 0.37, vec2f( 7.0 ) ) * 0.25 + clGnoise2( q + 0.71, vec2f( 15.0 ) ) * 0.1; }
fn ciPoints( p: vec2f, cluster: f32, n: f32, prob: f32, sigma: f32, seed: f32 ) -> f32 {
	let q = p * n;
	let ip = floor( q );
	let fp = fract( q );
	var v = 0.0;
	for ( var y = -1; y <= 1; y++ ) { for ( var x = -1; x <= 1; x++ ) {
		let o = vec2f( f32( x ), f32( y ) );
		let c = clMod2( ip + o, vec2f( n ) ) + seed;
		let pos = o + vec2f( clHash2( c ), clHash2( c + 19.7 ) ) * 0.8 + 0.1;
		let on = select( 0.0, 1.0, clHash2( c + 41.3 ) < cluster * prob );
		let d = pos - fp;
		v = max( v, exp( dot( d, d ) * ( -0.5 / ( sigma * sigma ) ) ) * on * ( clHash2( c + 7.1 ) * 0.7 + 0.3 ) );
	} }
	return v;
}`;
const AUX_FN = /* wgsl */`
fn ciAux( px: vec2f ) -> vec4f {
	let p = px / ${f(FIB_RES)};
	let e = ${f(1 / FIB_RES)};
	let curl = vec2f( ciPsi( p + vec2f( 0.0, e ) ) - ciPsi( p - vec2f( 0.0, e ) ), ciPsi( p - vec2f( e, 0.0 ) ) - ciPsi( p + vec2f( e, 0.0 ) ) ) / ( 2.0 * e );
	let dir = normalize( vec2f( 1.0, 0.0 ) + vec2f( 0.0, clGnoise2( p + 0.13, vec2f( 3.0 ) ) * 0.5 ) + curl * 0.05 );
	let cluster = ciSat( clGfbm( p, vec2f( 5.0 ), 0.9 ) * 1.6 - 0.3 );
	let seeds = max( ciPoints( p, cluster, 110.0, 0.3, 0.18, 0.0 ), ciPoints( p, cluster, 44.0, 0.3, 0.18, 3.3 ) * 0.8 );
	let tuft = ciPoints( p, cluster, 40.0, 0.4, 0.1, 6.1 );
	let droop = ciPoints( p, cluster, 40.0, 0.4, 0.3, 6.1 );
	return vec4f( seeds, atan2( dir.y, dir.x ), tuft, droop );
}`;

const FIB_FN = /* wgsl */`
fn ciFib( px: vec2f, auxTex: texture_2d<f32>, smp: sampler ) -> vec4f {
	const LIC_STEPS = 44;
	let LIC_STEP = ${f(1 / FIB_RES)};
	let p = px / ${f(FIB_RES)};
	var x1 = p; var x2 = p;
	var fib = 0.0;
	var head = 0.0;
	for ( var i = 0; i < LIC_STEPS; i++ ) {
		let k = f32( i );
		let a = textureSampleLevel( auxTex, smp, x1, 0.0 );
		fib += a.x * sin( ( k + 0.5 ) * ${f(PI / 44)} );
		x1 -= vec2f( cos( a.y ), sin( a.y ) ) * LIC_STEP;
		let b = textureSampleLevel( auxTex, smp, x2, 0.0 );
		head += b.z * exp( k * ${f(-1 / 12)} );
		x2 -= normalize( vec2f( cos( b.y ), sin( b.y ) + b.w * 1.2 ) ) * LIC_STEP;
	}
	let breakup = ciSat( clGfbm( p, vec2f( 24.0 ), 0.71 ) * 1.6 - 0.25 );
	let wisps = ( 1.0 - exp( fib * -0.8 ) ) * breakup;
	let hooks = 1.0 - exp( head * -0.5 );
	let veil = clGfbm( p, vec2f( 4.0 ), 0.33 );
	return vec4f( ciSat( max( wisps, hooks ) ), ciSat( veil ), 0.0, 1.0 );
}`;



// ------------------------------------------------------------------ the veil (Clouds.js cloudsHigh + helpers)
const HIGH_CODE = /* wgsl */`
// PORT: the uniforms (see createCirrus: P0..P5)
var<private> ciP: array<vec4f, 6>;
fn cloudsToWind( v: vec2f ) -> vec2f { let hc = ciP[ 4 ].x; let hs = ciP[ 4 ].y; return vec2f( v.x * hc + v.y * hs, v.y * hc - v.x * hs ); }
fn clPhaseHG( c: f32, g: f32 ) -> f32 { return ( ( 1.0 - g * g ) / ( 4.0 * CI_PI ) ) / pow( max( 1.0 + g * g - c * 2.0 * g, 1e-4 ), 1.5 ); }
fn cloudsShell( camY: f32, rd: vec3f, H: f32 ) -> f32 {
	let b = rd.y * ( camY + ${f(EARTH_R)} );
	let cc = ( camY - H ) * ( camY + H + 2.0 * ${f(EARTH_R)} );
	let disc = b * b - cc;
	return - b + sqrt( max( disc, 0.0 ) );
}
fn cloudsBspline( uv: vec2f, lod: f32, fibT: texture_2d<f32>, fS: sampler ) -> vec4f {
	let size = ${f(FIB_RES)} / exp2( lod );
	let st = uv * size - 0.5;
	let i = floor( st );
	let fr = st - i;
	let f2 = fr * fr; let f3 = f2 * fr;
	let w0 = ( - f3 + f2 * 3.0 - fr * 3.0 + 1.0 ) / 6.0;
	let w1 = ( f3 * 3.0 - f2 * 6.0 + 4.0 ) / 6.0;
	let w3 = f3 / 6.0;
	let w2 = 1.0 - w0 - w1 - w3;
	let g0 = w0 + w1; let g1 = w2 + w3;
	let p0 = ( i - 0.5 + w1 / g0 ) / size; let p1 = ( i + 1.5 + w3 / g1 ) / size;
	return textureSampleLevel( fibT, fS, vec2f( p0.x, p0.y ), lod ) * ( g0.x * g0.y )
		+ textureSampleLevel( fibT, fS, vec2f( p1.x, p0.y ), lod ) * ( g1.x * g0.y )
		+ textureSampleLevel( fibT, fS, vec2f( p0.x, p1.y ), lod ) * ( g0.x * g1.y )
		+ textureSampleLevel( fibT, fS, vec2f( p1.x, p1.y ), lod ) * ( g1.x * g1.y );
}
fn cloudsFibres( q: vec2f, fA: vec2f, fB: vec2f, tile: f32, rot: f32, fibT: texture_2d<f32>, fS: sampler ) -> vec4f {
	let cr = cos( rot ); let sr = sin( rot );
	let wq = cloudsToWind( q ); let wa = cloudsToWind( fA ); let wb = cloudsToWind( fB );
	let uv = vec2f( wq.x * cr + wq.y * sr, wq.y * cr - wq.x * sr ) / tile;
	let a = vec2f( wa.x * cr + wa.y * sr, wa.y * cr - wa.x * sr ) / tile;
	let b = vec2f( wb.x * cr + wb.y * sr, wb.y * cr - wb.x * sr ) / tile;
	let la = length( a ) * ${f(FIB_RES)}; let lb = length( b ) * ${f(FIB_RES)};
	let major = select( b, a, la > lb );
	const n = 3;
	let lod = max( log2( max( min( la, lb ), max( la, lb ) / f32( n ) ) ), 0.0 );
	var sum = vec4f( 0.0 );
	for ( var i = 0; i < n; i++ ) {
		sum += cloudsBspline( uv + major * ( ( f32( i ) + 0.5 ) / f32( n ) - 0.5 ), lod, fibT, fS );
	}
	return sum / f32( n );
}
// PORT: the key light's illuminance at the sheet for a local sun cosine: OUR transmittance at 9 km
// (a table over mu, linear filtering by hand) x sun intensity; the moon when it is the key light
fn ciKeyE( muS: f32, eT: texture_2d<f32> ) -> vec3f {
	let x = clamp( ( muS - ${f(E_MU0)} ) / ${f(1 - E_MU0)}, 0.0, 1.0 ) * ${f(E_RES - 1)};
	let i0 = i32( floor( x ) ); let i1 = min( i0 + 1, ${E_RES - 1} );
	return mix( textureLoad( eT, vec2i( i0, 0 ), 0 ).rgb, textureLoad( eT, vec2i( i1, 0 ), 0 ).rgb, fract( x ) );
}
fn cloudsEarthShadow( dir: vec3f, isMoon: bool, alt: f32, pxz: vec2f ) -> f32 {
	let mu = dir.y + dot( dir.xz, pxz ) / ${f(EARTH_R)};
	let lit = smoothstep( -0.006, 0.006, mu + sqrt( max( alt, 0.0 ) * ${f(2 / EARTH_R)} ) );
	return select( lit, 1.0, isMoon );
}`;

const HIGH_FN = /* wgsl */`
fn ciHigh( rd: vec3f, pxAngle: f32, p0: vec4f, p1: vec4f, p2: vec4f, p3: vec4f, p4: vec4f, p5: vec4f,
	synT: texture_2d<f32>, synS: sampler, fibT: texture_2d<f32>, fS: sampler, eT: texture_2d<f32>, irrT: texture_2d<f32>,
	skT: texture_2d<f32>, skS: sampler ) -> vec4f {
	// PORT: P0 = ( amount, altitude, camY, cumulus coverage ), P1 = ( camX, camZ, hOffX, hOffZ ),
	// P2 = ( key light dir, isMoon ), P3 = ( moon E, - ), P4 = ( upper wind cos, sin, -, - ),
	// P5 = the atmosphere lookup's ap ( real sun dir, view height km )
	ciP[ 0 ] = p0; ciP[ 1 ] = p1; ciP[ 2 ] = p2; ciP[ 3 ] = p3; ciP[ 4 ] = p4; ciP[ 5 ] = p5;
	if ( rd.y <= -0.01 || p0.x <= 0.0 || p0.z >= p0.y - 50.0 ) { return vec4f( 0.0, 0.0, 0.0, 1.0 ); } // PORT: below the horizon / off / camera at or above the sheet
	let H = p0.y;
	let sunDir = p2.xyz;
	let isMoon = p2.w > 0.5;
	let cosT = dot( rd, sunDir );

	let t = cloudsShell( p0.z, rd, H );
	let pxz = rd.xz * t;
	let up = normalize( vec3f( pxz.x / ${f(EARTH_R)}, 1.0, pxz.y / ${f(EARTH_R)} ) );
	let mu = max( dot( rd, up ), 0.02 );
	let radial = normalize( rd.xz + vec2f( 1e-6, 0.0 ) );
	let fA = vec2f( - radial.y, radial.x ) * ( t * pxAngle );
	let fB = radial * ( t * pxAngle / mu );
	let q = pxz + p1.xy - p1.zw;

	let syn = textureSampleLevel( synT, synS, cloudsToWind( q ) * ${f(1 / SYN_SIZE)}, 0.0 );
	let cov = smoothstep( 0.15, 0.85, syn.x ) * smoothstep( 0.4, 0.72, syn.z ) * ( syn.y * 0.4 + 0.6 );
	let f1 = cloudsFibres( q, fA, fB, ${f(FIB_TILE)}, 0.0, fibT, fS );
	let f2 = cloudsFibres( q, fA, fB, ${f(FIB_TILE * 2.3)}, 0.5, fibT, fS );
	let fib = f1.x * 0.6 + f2.x * 0.4;
	let veil = f1.y * 0.5 + f2.y * 0.5;
	let amount = p0.x * ( p0.w * 0.5 + 0.78 );
	let tau = amount * 0.4 * cov * ( fib * 0.75 + 0.25 ) * ( veil * 0.4 + 0.8 );
	let alpha = 1.0 - exp( - tau / max( mu, 0.25 ) );

	let muS = dot( sunDir, up );
	let E = select( ciKeyE( muS, eT ), p3.xyz, isMoon ) * cloudsEarthShadow( sunDir, isMoon, H, pxz ); // PORT: ciKeyE
	let hd = ( acos( clamp( cosT, -1.0, 1.0 ) ) - 0.384 ) / 0.02;
	let halo = exp( - hd * hd ) * 0.04;
	let phase = clPhaseHG( cosT, 0.85 ) * 0.4 + clPhaseHG( cosT, 0.3 ) * 0.35 + clPhaseHG( cosT, -0.15 ) * 0.25 + halo;
	let Ts = exp( tau * -0.5 / max( muS, 0.1 ) );
	let skyIrr = textureLoad( irrT, vec2i( 0, 0 ), 0 ).rgb; // PORT: frame.skyIrradiance
	let L = ( E * ( phase * Ts + ( 1.0 - Ts ) * 0.06 ) + skyIrr * 0.9 ) * alpha;
	let tr = exp( t * ${f(-0.25 / AP_DIST)} );
	let skyL = atmosphereSkyLuminanceP( rd, p5, skT, skS ); // PORT: the LUT and its inputs as parameters
	return vec4f( L * tr + skyL * alpha * ( 1.0 - tr ), 1.0 - alpha );
}`;

export function createCirrus({ renderer, atmosphere }) {
  const noise = wgsl(NOISE_WGSL);

  // ---- bakes
  const rt = (res, type, mips) => {
    const t = new THREE.RenderTarget(res, res, { type, depthBuffer: false, generateMipmaps: mips,
      minFilter: mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter, magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping });
    t.texture.wrapS = t.texture.wrapT = THREE.RepeatWrapping;
    return t;
  };
  const synRT = rt(SYN_RES, THREE.UnsignedByteType, false);
  const auxRT = rt(FIB_RES, THREE.HalfFloatType, false);
  const fibRT = rt(FIB_RES, THREE.UnsignedByteType, true);

  const synFn = wgslFn(SYN_FN, [noise]);
  const auxFn = wgslFn(AUX_FN, [wgsl(AUX_CODE, [noise])]);
  const fibFn = wgslFn(FIB_FN, [noise]);
  const auxNode = texture(auxRT.texture);
  const bake = (target, node) => {
    const m = new THREE.MeshBasicNodeMaterial();
    m.fragmentNode = node; // the whole vec4 (a colorNode loses alpha)
    const q = new THREE.QuadMesh(m);
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(target);
    q.render(renderer);
    renderer.setRenderTarget(prev);
    m.dispose();
  };
  bake(synRT, synFn(screenCoordinate.xy));
  bake(auxRT, auxFn(screenCoordinate.xy));
  bake(fibRT, fibFn(screenCoordinate.xy, auxNode, sampler(auxNode)));

  // ---- key-light table: the atmosphere's transmittance at the sheet over the local sun cosine, x the
  // sun's illuminance (Tidewater: atmosphereSampleTransmittance( 6360 + H / 1000, muS ) x sunIlluminance)
  const eData = new Float32Array(E_RES * 4);
  const eTex = new THREE.DataTexture(eData, E_RES, 1, THREE.RGBAFormat, THREE.FloatType);
  eTex.minFilter = eTex.magFilter = THREE.NearestFilter;
  let eKey = "";
  const T = [0, 0, 0];
  function bakeKeyTable(alt) {
    const P = atmosphere.params;
    const key = `${alt}|${P.sunIlluminance}|${P.rayleighScale}|${P.mieScale}|${P.ozoneScale}`;
    if (key === eKey) return;
    eKey = key;
    for (let i = 0; i < E_RES; i++) {
      const mu = E_MU0 + (1 - E_MU0) * i / (E_RES - 1);
      atmosphere.sunColorAt(alt, mu, T);
      eData.set([T[0], T[1], T[2], 1], i * 4);
    }
    eTex.needsUpdate = true;
  }

  // ---- the veil
  const A = atmosphere.nodes;
  const irrNode = texture(atmosphere.textures.irradiance);
  const uP = [0, 1, 2, 3, 4, 5].map(() => uniform(new THREE.Vector4()));
  const highFn = wgslFn(HIGH_FN, [wgsl(HIGH_CODE, [noise, atmosphere.code])]);
  const synNode = texture(synRT.texture), fibNode = texture(fibRT.texture), eNode = texture(eTex);
  const sample = (dir, pxAngle) => highFn(dir, pxAngle, ...uP, synNode, sampler(synNode), fibNode, sampler(fibNode), eNode, irrNode, A.skyView, A.sampler);

  const amount = { value: 0.5 };
  const altitude = { value: 9000 };
  const offset = new THREE.Vector2();

  /**
   * @param {object} o  lightDir (key light), sunDir (the real sun), moonE (Vector3: the moon's light when it
   *   is the key light), windDir (Vector2), windSpeed (m/s at the cumulus), coverage (the cumulus's)
   */
  function update(dt, camera, o) {
    bakeKeyTable(altitude.value);
    const L = o.lightDir, cp = camera.position;
    const isMoon = L.dot(o.sunDir) < 0.9999;
    const wl = Math.hypot(o.windDir.x, o.windDir.y) || 1;
    const wx = o.windDir.x / wl, wz = o.windDir.y / wl;
    // the upper wind: 1.6x the lower one, its frame veered 0.6 rad from it (Clouds.js CL_HC / CL_HS)
    offset.x = (((offset.x + wx * o.windSpeed * dt * 1.6) % WRAP) + WRAP) % WRAP;
    offset.y = (((offset.y + wz * o.windSpeed * dt * 1.6) % WRAP) + WRAP) % WRAP;
    const ha = Math.atan2(wz, wx) + 0.6;
    uP[0].value.set(amount.value, altitude.value, cp.y, o.coverage);
    uP[1].value.set(cp.x, cp.z, offset.x, offset.y);
    uP[2].value.set(L.x, L.y, L.z, isMoon ? 1 : 0);
    uP[3].value.set(o.moonE.x, o.moonE.y, o.moonE.z, 0);
    uP[4].value.set(Math.cos(ha), Math.sin(ha), 0, 0);
    uP[5].value.copy(atmosphere.uniforms.ap.value); // the atmosphere lookup's ( real sun, view height )
  }

  return {
    sample, update, amount, altitude,
    textures: { syn: synRT.texture, aux: auxRT.texture, fib: fibRT.texture },
  };
}

/** Layer a (in-scattered radiance, transmittance) in front of layer b (Clouds.js clOver). TSL. */
export const clOver = (a, b) => vec4(a.rgb.add(b.rgb.mul(a.a)), a.a.mul(b.a));

