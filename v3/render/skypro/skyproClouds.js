// SKY PRO — the cumulus: Sky Pro WebGPU clouds on three.js WebGPURenderer + TSL. Part of the Sky Pro
// sky mode (v3/render/skypro/), lit by that mode's own atmosphere (skyproAtmosphere.js).
//
// Port of v3/skypro-real/tidewater/src/sky/SkyProClouds.js (Sky Pro WebGPU, "Partly cloudy",
// "high" quality — MIT, Copyright (c) 2026 DRG Software Solutions LLC; see
// v3/skypro-real/tidewater/LICENSE). The reference runs in v3/skypro-real-lab.html; this file must
// keep matching it.
//
// HOW IT IS PORTED ("hybrid"): the WGSL maths is kept VERBATIM and run through `wgslFn`, the
// resources and passes are three's (StorageTextures, compute nodes, renderer.compute). Every change
// to the WGSL is marked `// PORT:`. The kinds of change:
//   1. Uniforms. Sky Pro reads two uniform structs (`scf` frame, `scs` settings) as globals. wgslFn
//      cannot see bindings, so the structs are module-scope `var<private>` copies filled at the start
//      of every kernel by `scLoad( u0 … u50 )` from ONE uniformArray (51 vec4) — the CPU side
//      packs it exactly as Sky Pro's UniformBlocks were packed.
//   2. Textures and samplers are threaded through the helper functions as parameters (WGSL allows
//      texture / sampler function parameters; private variables cannot hold them).
//   3. Tidewater's atmosphere, through the Sky Pro mode's own copy (skyproAtmosphere.js): `scSky`
//      is Tidewater's (atmosphereSkyLuminance + the night ambient) with the sky-view LUT as a
//      parameter; the key light (`scDirect`) is computed on the CPU by that module's exact mirror
//      of the transmittance bake at the deck altitude (the moon's colour when it is the key light).
//      Tidewater's units (sun illuminance 11).
//   4. The temporal resolve's 11x11 workgroup tile was only a cache of textureLoads: the port
//      loads straight from the texture (identical values, no shared memory).
//   5. The cloud shadow map is rgba16float (x), not r32float: rg/r 16-bit formats are not core
//      storage formats and r32float is unfilterable; the values are transmittances in 0..1.
//
// THREE INTERNALS USED (lab-grade, flagged): three r184 cannot upload mip levels of a 3D texture, so
// the noise volume's mips 1..n are written straight into its GPUTexture via renderer.backend.get().
//
// Public:
//   const clouds = createSkyProClouds( { renderer, atmosphere } ); await clouds.ready;   (atmosphere: createSkyProAtmosphere)
//   clouds.update( dt, camera, { sunDir, lightDir, windDir, moonColor, nightAmbient, drawingBufferSize } )  — records the compute passes
//   clouds.viewSample( dir )   TSL: vec4( rgb in-scattered, a transmittance ) for the main view
//   clouds.panoSample( dir )   TSL: the panorama (reflections / environment)
//   clouds.shadowAt( xz )      TSL: cloud shadow transmittance on the ground (1 = clear)
//   clouds.coverage, clouds.resolutionScale, clouds.resetHistory(), clouds.invalidate()

import * as THREE from "three/webgpu";
import {
  Fn, If, wgsl, wgslFn, uniform, uniformArray, texture, texture3D, sampler, textureStore,
  globalId, uvec2, vec2, vec3, vec4, float, int, ivec2, uint, normalize, dot, clamp, smoothstep,
  sqrt, acos, atan, fract, mix, max, select, all,
} from "three/tsl";

const DEG = Math.PI / 180;
const f = (x) => {
  const s = Number(x).toString();
  return /[.eE]/.test(s) ? s : s + ".0";
};

// "Partly cloudy" (verbatim from SkyProClouds.js)
const PRESET = {
  atmosphere: { multipleScattering: 0.99 },
  shape: {
    altitude: 4000, thickness: 5200, density: 0.019, coverage: 0.49,
    horizonCoverageStart: 20000, horizonCoverageRamp: 45000, horizonCoverageAmount: 0.12,
    edgeSoftness: 0.095, edgeSoftnessFalloff: 1, weatherScale: 29000, baseScale: 7500, baseStrength: 0.69,
    erosionScaleBaseMultiplier: 0.13, erosionStrengthBase: 0.24, erosionStrengthPeak: 2.15, erosionShape: 1,
    baseWeatherStrength: 0.54, baseWeatherHeightStart: 0, baseWeatherHeightEnd: 0.13,
  },
  lighting: {
    scatteringAlbedo: 1, powderStrength: 0.7, ambientIntensity: 0.7,
    groundBounceAlbedo: [0.009134058699157796, 0.015208514418949472, 0.018500220124016652],
    baseShadowStrength: 0.88, baseShadowHeight: 0.13, moonGain: 0.65,
  },
  wind: { speed: 12, evolutionSpeed: 60.8 * 12 / 89, skew: 1750 },
  fade: { hazeDensityScale: 0.62, horizonMeltStart: 25000, horizonMeltEnd: 45000 },
  weather: { resolution: 1024, mainMass: [4, 5, 0, 1.32], detail: [6, 6, 1, 0.13], coverage: 0.26 },
};
// sky-pro "high" quality
const QUALITY = { historyDivisor: 2, lattice: 4, maxSteps: 256, lightTaps: 6, stepMeters: 25, fullLightingAlpha: 0.5, lightReuseSteps: 3, historyWeight: 0.9 };

// LAB CHANGE, not Sky Pro: while the key light moves, trace EVERY history pixel instead of 1 in 16, so
// nothing is stale or upscaled (a dragged time slider was blocky; 2x2 was still blocky or ghosted)
const MOVING_LATTICE = 1;
const MOVING_EPS_DEG = 0.02;

const PANO_W = 512, PANO_H = 160;
const PANO_LATTICE = 4;
const SHADOW_RES = 256;
const AP_DIST = 30000;

// ------------------------------------------------------------------ uniform layout (51 vec4)
const F_FIELDS = ["position", "right", "up", "forward", "previousPosition", "previousRight", "previousUp", "previousForward",
  "viewport", "sampling", "clock", "wind", "windDelta", "march", "temporal", "display", "pano", "shadow"];
const S_FIELDS = ["shell", "shape", "erosion", "base", "horizon", "cloudLight", "shadow", "bounce", "wind", "fade",
  "weatherMass", "weatherDetail", "weather"];
// PORT: what Tidewater's `frame` / atmosphere gave the clouds
const X_FIELDS = ["sunDir", "direct", "nightAmb", "sky"]; // sky: the atmosphere lookup's ap = ( real sun dir, view height km )
const LIGHT_OFS = F_FIELDS.length; // 18
const LIGHT_LODS = LIGHT_OFS + 8; // 26
const S0 = LIGHT_LODS + 8; // 34
const X0 = S0 + S_FIELDS.length; // 47
const N_U = X0 + X_FIELDS.length; // 51

const DECLS = /* wgsl */`
// PORT: the uniform structs as private copies (filled by scLoad)
struct ScFrame {
${F_FIELDS.map((k) => `\t${k}: vec4f,`).join("\n")}
\tlightOffsets: array<vec4f, 8>,
\tlightLods: array<vec4f, 8>,
};
struct ScSettings {
${S_FIELDS.map((k) => `\t${k}: vec4f,`).join("\n")}
};
struct ScExtra {
${X_FIELDS.map((k) => `\t${k}: vec4f,`).join("\n")}
};
var<private> scf: ScFrame;
var<private> scs: ScSettings;
var<private> scx: ScExtra;
var<private> scMetaOut: vec4f;
const SC_PI: f32 = 3.141592653589793;
`;

const LOAD_FN = /* wgsl */`
fn scLoad( ${Array.from({ length: N_U }, (_, i) => `u${i}: vec4f`).join(", ")} ) -> f32 {
${F_FIELDS.map((k, i) => `\tscf.${k} = u${i};`).join("\n")}
${Array.from({ length: 8 }, (_, i) => `\tscf.lightOffsets[ ${i} ] = u${LIGHT_OFS + i};`).join("\n")}
${Array.from({ length: 8 }, (_, i) => `\tscf.lightLods[ ${i} ] = u${LIGHT_LODS + i};`).join("\n")}
${S_FIELDS.map((k, i) => `\tscs.${k} = u${S0 + i};`).join("\n")}
${X_FIELDS.map((k, i) => `\tscx.${k} = u${X0 + i};`).join("\n")}
\treturn 1.0;
}
`;

// ------------------------------------------------------------------ WGSL: shared core (verbatim but for PORT:)
const CORE_WGSL = /* wgsl */`
const SC_EARTH: f32 = 6371.0;
const SC_FAR: f32 = 250000.0;
const SC_AP_DIST: f32 = ${f(AP_DIST)};

fn scRay( uv: vec2f ) -> vec3f {
	let ndc = vec2f( uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0 );
	return normalize( scf.forward.xyz + scf.right.xyz * ( ndc.x * scf.right.w * scf.position.w )
		+ scf.up.xyz * ( ndc.y * scf.position.w ) );
}
fn scSourceUV( pixel: vec2f ) -> vec2f {
	return ( pixel * scf.sampling.z + scf.sampling.xy + 0.5 ) / scf.viewport.zw;
}
fn scProjectPrevious( p: vec3f ) -> vec3f {
	let v = p - scf.previousPosition.xyz;
	let z = dot( v, scf.previousForward.xyz );
	let denom = max( z, 0.001 ) * scf.previousPosition.w;
	return vec3f( vec2f( dot( v, scf.previousRight.xyz ) / ( denom * scf.previousRight.w ),
		-dot( v, scf.previousUp.xyz ) / denom ) * 0.5 + 0.5, z );
}
fn scHG( mu: f32, g: f32 ) -> f32 {
	let d = max( 1.0 + g * g - 2.0 * g * mu, 0.001 );
	return ( 1.0 - g * g ) / ( 4.0 * SC_PI * d * sqrt( d ) ); // PORT: PI -> SC_PI
}
fn scPhases( mu: f32 ) -> vec3f {
	return vec3f( scHG( mu, 0.8 ), scHG( mu, 0.4 ), scHG( mu, 0.2 ) ) * 0.8
		+ vec3f( scHG( mu, -0.2 ), scHG( mu, -0.1 ), scHG( mu, -0.05 ) ) * 0.2;
}

struct ScCandidate {
	conservative: f32, edge: f32, top: f32, floorMask: f32,
	shellHeight: f32, localHeight: f32, coverage: f32, position: vec3f,
};
fn scShellHeight( p: vec3f ) -> f32 {
	let horizontal = p.xz - scf.position.xz;
	let altitude = p.y + dot( horizontal, horizontal ) / ( 2.0 * SC_EARTH * 1000.0 );
	return ( altitude - scs.shell.x ) / scs.shell.y;
}
fn scConeLod( footprint: f32, scale: f32 ) -> f32 { return max( 0.0, log2( max( footprint * 64.0 / scale, 1.0 ) ) ); }
// PORT: + textures (nT noise, wT weather, smp linear repeat)
fn scCandidate( p: vec3f, coverage: f32, lod: f32, nT: texture_3d<f32>, wT: texture_2d<f32>, smp: sampler ) -> ScCandidate {
	let h = scShellHeight( p );
	var result: ScCandidate;
	result.conservative = 0.0;
	if ( h < -0.1 || h > 1.3 || coverage <= 0.0 ) { return result; }
	let windDirection = scs.wind.xy;
	let shapePosition = p - vec3f( scf.wind.x, 0.0, scf.wind.y )
		- vec3f( windDirection.x, 0.0, windDirection.y ) * ( scs.wind.z * max( h, 0.0 ) - scf.wind.z );
	let weather = textureSampleLevel( wT, smp, ( p.xz - scf.wind.xy ) / scs.shape.x, 0.0 ).r;
	let edge = max( scs.base.y * exp2( -max( h, 0.0 ) * scs.base.z ), 0.0001 );
	let maximumTop = weather + coverage - 1.0 + 1.34 * scs.shape.z * coverage;
	if ( maximumTop < h - edge ) { return result; }
	let required = ( 1.0 - smoothstep( scs.base.w, max( scs.erosion.w, scs.base.w + 0.001 ), h ) ) * scs.base.x;
	let floorMask = smoothstep( required - 0.1, required, weather );
	if ( floorMask <= 0.0 ) { return result; }
	let baseSample = textureSampleLevel( nT, smp, shapePosition / scs.shape.y, lod ).rgb;
	let dilation = dot( baseSample, vec3f( 0.7, 0.41, 0.23 ) ) * scs.shape.z;
	let top = weather + coverage - 1.0 + dilation * coverage;
	result.conservative = smoothstep( -edge, edge, top - h ) * smoothstep( -edge, edge, h ) * floorMask;
	result.edge = edge; result.top = top; result.floorMask = floorMask;
	result.shellHeight = h; result.localHeight = clamp( h / max( top, 0.001 ), 0.0, 1.0 );
	result.coverage = coverage; result.position = shapePosition;
	return result;
}
fn scErodedDensity( c: ScCandidate, lod: f32, nT: texture_3d<f32>, smp: sampler ) -> f32 { // PORT: + textures
	if ( c.conservative <= 0.0 ) { return 0.0; }
	let strength = mix( scs.erosion.x, scs.erosion.y, c.localHeight );
	let maximumErosion = 0.173 * strength * c.coverage;
	if ( min( c.top - c.shellHeight, c.shellHeight ) >= maximumErosion + c.edge ) { return c.floorMask; }
	let s = textureSampleLevel( nT, smp, c.position / ( scs.shape.y * scs.shape.w ), lod ).rgb;
	let field = mix( 1.0 - s, s, scs.erosion.z );
	let erosion = dot( field, vec3f( 0.113, 0.04, 0.02 ) ) * strength * c.coverage;
	return smoothstep( -c.edge, c.edge, c.top - erosion - c.shellHeight )
		* smoothstep( -c.edge, c.edge, c.shellHeight - erosion ) * c.floorMask;
}
fn scLightDensity( p: vec3f, coverage: f32, lods: vec2f, cheap: bool, nT: texture_3d<f32>, wT: texture_2d<f32>, smp: sampler ) -> f32 { // PORT: + textures
	let c = scCandidate( p, coverage, lods.x, nT, wT, smp );
	if ( cheap ) { return c.conservative; }
	return scErodedDensity( c, lods.y, nT, smp );
}
fn scShellRoots( direction: vec3f, altitude: f32, originHeight: f32 ) -> vec2f {
	let radius = SC_EARTH * 1000.0;
	let b = ( radius + originHeight ) * direction.y;
	let c = ( originHeight - altitude ) * ( 2.0 * radius + originHeight + altitude );
	let h = b * b - c;
	if ( h < 0.0 ) { return vec2f( -1.0 ); }
	let q = -b - select( -sqrt( h ), sqrt( h ), b >= 0.0 );
	let other = c / select( -0.0001, q, abs( q ) > 0.0001 );
	return vec2f( min( q, other ), max( q, other ) );
}
fn scCloudInterval( dir: vec3f, originHeight: f32 ) -> vec2f {
	let inner = scShellRoots( dir, scs.shell.x, originHeight );
	let outer = scShellRoots( dir, scs.shell.x + scs.shell.y, originHeight );
	var start = 0.0; var end = min( outer.y, SC_FAR );
	if ( outer.y <= 0.0 ) { return vec2f( 0.0 ); }
	if ( originHeight < scs.shell.x ) { start = max( inner.y, 0.0 ); }
	else {
		if ( originHeight > scs.shell.x + scs.shell.y ) { start = max( outer.x, 0.0 ); }
		if ( inner.x >= 0.0 ) { end = min( end, inner.x ); }
	}
	let ground = scShellRoots( dir, 0.0, originHeight );
	if ( ground.x > 0.0 ) { end = min( end, ground.x ); }
	return vec2f( start, end );
}
`;

// ------------------------------------------------------------------ WGSL: the march (verbatim but for PORT:)
const MARCH_WGSL = /* wgsl */`
fn scCoverageAt( t: f32 ) -> f32 {
	return scs.shell.w + scs.horizon.z * smoothstep( scs.horizon.x, scs.horizon.x + max( scs.horizon.y, 1.0 ), t );
}
fn scHeightAlongRay( t: f32, dir: vec3f, originHeight: f32 ) -> f32 {
	let altitude = originHeight + dir.y * t + dot( dir.xz, dir.xz ) * t * t / ( 2.0 * SC_EARTH * 1000.0 );
	return ( altitude - scs.shell.x ) / scs.shell.y;
}
fn scCellIsEmpty( t: f32, end: f32, dir: vec3f, originHeight: f32, maximumWeather: f32 ) -> bool {
	let turningPoint = -dir.y * SC_EARTH * 1000.0 / max( dot( dir.xz, dir.xz ), 0.000001 );
	let minHeight = scHeightAlongRay( clamp( turningPoint, t, end ), dir, originHeight );
	let maxHeight = max( scHeightAlongRay( t, dir, originHeight ), scHeightAlongRay( end, dir, originHeight ) );
	let coverage = scCoverageAt( end );
	let maximumTop = maximumWeather + coverage - 1.0 + 1.34 * scs.shape.z * coverage;
	let edgeHeight = select( maxHeight, minHeight, scs.base.z >= 0.0 );
	let edge = max( scs.base.y * exp2( -max( edgeHeight, 0.0 ) * scs.base.z ), 0.0001 );
	let required = ( 1.0 - smoothstep( scs.base.w, max( scs.erosion.w, scs.base.w + 0.001 ), maxHeight ) ) * scs.base.x;
	return maximumTop < minHeight - edge || maximumWeather <= required - 0.1;
}
fn scLightOpticalDepth( p: vec3f, coverage: f32, lods: vec2f, cheap: bool, nT: texture_3d<f32>, wT: texture_2d<f32>, smp: sampler ) -> f32 { // PORT: + textures
	var opticalDepth = 0.0;
	for ( var i = 1u; i < 8u; i++ ) {
		if ( i >= u32( scf.march.z ) ) { break; }
		let tap = scf.lightOffsets[ i ];
		opticalDepth += scLightDensity( p + tap.xyz, coverage, max( lods, scf.lightLods[ i ].xy ), cheap, nT, wT, smp ) * tap.w * scs.shell.z;
		if ( opticalDepth >= 32.0 ) { break; }
	}
	return opticalDepth;
}
fn scLightEnergy( opticalDepth: f32, phase: vec3f ) -> f32 {
	let quarter = exp( -opticalDepth * 0.25 );
	let halfT = quarter * quarter;
	return dot( vec3f( halfT * halfT, halfT * 0.5, quarter * 0.25 ), phase );
}

// Tidewater's sky (the atmosphere's sky view LUT; the night sky's ambient). PORT: the LUT as a
// parameter; frame.skyIrradiance * frame.night comes in as scx.nightAmb
fn scSky( dir: vec3f, skT: texture_2d<f32>, skS: sampler ) -> vec3f {
	return atmosphereSkyLuminanceP( dir, scx.sky, skT, skS ) + scx.nightAmb.xyz;
}
// PORT: the key light is computed on the CPU (sun at deck altitude, or the moon)
fn scDirect() -> vec3f { return scx.direct.xyz; }

struct ScMarch { color: vec3f, alpha: f32, depth: f32, steps: u32 };

// PORT: + textures (bT weather bounds, skT/skS our sky LUT)
fn scMarch( origin: vec3f, dir: vec3f, dither: f32, pixelConeAngle: f32, stepConeAngle: f32, maxSteps: u32, useBounds: bool,
	nT: texture_3d<f32>, wT: texture_2d<f32>, bT: texture_2d<f32>, skT: texture_2d<f32>, smp: sampler, skS: sampler ) -> ScMarch {
	var out: ScMarch;
	out.color = vec3f( 0.0 ); out.alpha = 0.0; out.depth = SC_FAR; out.steps = 0u;
	let interval = scCloudInterval( dir, origin.y );
	var color = vec3f( 0.0 ); var transmission = 1.0; var weightedDepth = 0.0;
	var steps = 0u;
	if ( interval.y > interval.x && scs.shell.w > 0.0 && scs.shell.z > 0.0 ) {
		let L = scx.sunDir.xyz; // PORT: frame.sunDir
		let lightCosine = dot( dir, L );
		let phase = scPhases( lightCosine );
		let direct = scDirect();
		let zenith = scSky( vec3f( 0.0, 1.0, 0.0 ), skT, skS );
		let horizon = scSky( normalize( vec3f( L.x, 0.03, L.z ) + vec3f( 1e-5, 0.0, 0.0 ) ), skT, skS );
		let bounce = scs.bounce.rgb * direct * max( L.y, 0.0 );
		var t = interval.x + dither * scf.march.x;
		var coarse = true; var emptyRun = 0u; var accumulatedDepth = 0.0;
		var refineEnd = -1.0;
		var cellEnd = -1.0; var cellStart = -1.0; var maximumWeather = 1.0;
		var shadowAt = -SC_FAR; var shadowDensity = -1.0; var shadowTau = 0.0; var skyTau = 0.0; var shadowCheap = false;
		let hasDirectLight = max( direct.x, max( direct.y, direct.z ) ) > 0.00001;
		for ( var i = 0u; i < maxSteps; i++ ) {
			if ( t >= interval.y || transmission < 0.003 ) { break; }
			steps++;
			if ( coarse && useBounds ) {
				if ( t >= cellEnd || t < cellStart ) {
					let size = vec2i( textureDimensions( bT ) );
					let grid = ( origin.xz + dir.xz * t - scf.wind.xy ) / scs.shape.x * vec2f( size );
					let cell = vec2i( floor( grid ) );
					maximumWeather = textureLoad( bT, ( ( cell % size ) + size ) % size, 0 ).r;
					let distance = select( fract( grid ), 1.0 - fract( grid ), dir.xz >= vec2f( 0.0 ) )
						/ max( abs( dir.xz ) * vec2f( size ) / scs.shape.x, vec2f( 0.0000001 ) );
					cellStart = t; cellEnd = min( interval.y, t + max( min( distance.x, distance.y ), 0.05 ) );
				}
				if ( scCellIsEmpty( t, cellEnd, dir, origin.y, maximumWeather ) ) { t = cellEnd + 0.05; continue; }
			}
			let footprint = t * pixelConeAngle;
			let fineStep = max( scf.march.x, t * stepConeAngle * 1.5 );
			let p = origin + dir * t;
			let coverage = scCoverageAt( t );
			let baseLod = scConeLod( footprint, scs.shape.y );
			let c = scCandidate( p, coverage, baseLod, nT, wT, smp );
			let erosionLod = scConeLod( footprint, scs.shape.y * scs.shape.w );
			if ( coarse ) {
				if ( c.conservative > 0.0 ) {
					if ( scErodedDensity( c, erosionLod, nT, smp ) > 0.0 ) {
						refineEnd = t;
						t = max( interval.x, t - fineStep * 4.0 ) + fineStep;
						t = min( t, refineEnd );
						coarse = false; emptyRun = 0u;
						continue;
					}
				}
				t += fineStep * 4.0;
				continue;
			}
			let density = scErodedDensity( c, erosionLod, nT, smp );
			if ( density <= 0.0 ) {
				shadowAt = -SC_FAR;
				emptyRun++;
				if ( t < refineEnd ) { t = min( t + fineStep, refineEnd ); continue; }
				if ( emptyRun >= 4u ) { coarse = true; }
				t += select( fineStep, fineStep * 4.0, coarse ); continue;
			}
			emptyRun = 0u; refineEnd = -1.0;
			let sigmaT = density * scs.shell.z;
			let surfaceStep = clamp( 0.5 / max( sigmaT, 0.000001 ), fineStep * 0.15, fineStep );
			let stepLength = min( mix( surfaceStep, fineStep * 3.0, smoothstep( 1.0, 3.0, accumulatedDepth ) ), interval.y - t );
			let height = clamp( c.shellHeight, 0.0, 1.0 );
			let baseShadow = mix( 1.0, mix( 0.15, 1.0, smoothstep( 0.0, max( scs.shadow.y, 0.001 ), height ) ), scs.shadow.x );
			let powderWeight = scs.cloudLight.y * ( 1.0 - smoothstep( 0.2, 0.95, lightCosine ) );
			let powder = mix( 1.0, 1.0 - exp( -density * 2.0 ), powderWeight );
			var energy = 0.0;
			let cheap = ( 1.0 - transmission ) >= scf.march.w;
			let reuseDistance = min( fineStep * scf.display.y, max( 20.0, scs.shape.y * scs.shape.w * 0.03 ) );
			if ( abs( t - shadowAt ) >= reuseDistance || abs( density - shadowDensity ) > 0.08 || cheap != shadowCheap ) {
				let lods = vec2f( baseLod, erosionLod );
				if ( hasDirectLight ) { shadowTau = scLightOpticalDepth( p, coverage, lods, cheap, nT, wT, smp ); }
				let skyLods = lods + vec2f( 1.0 );
				skyTau = ( scLightDensity( p + vec3f( 0.0, 125.0, 0.0 ), coverage, skyLods, true, nT, wT, smp ) * 250.0
					+ scLightDensity( p + vec3f( 0.0, 600.0, 0.0 ), coverage, skyLods, true, nT, wT, smp ) * 700.0 ) * scs.shell.z;
				shadowAt = t; shadowDensity = density; shadowCheap = cheap;
			}
			if ( hasDirectLight ) {
				energy = scLightEnergy( shadowTau + sigmaT * scf.lightOffsets[ 0 ].w, phase );
			}
			let skyVisibility = 0.2 + 0.8 / ( 1.0 + ( skyTau + sigmaT * 25.0 ) * 0.35 );
			let ambient = ( mix( mix( zenith, horizon, 0.55 ), zenith, sqrt( height ) ) * skyVisibility + bounce * ( 1.0 - height ) )
				* scs.cloudLight.z * ( 1.0 + scs.cloudLight.w );
			let light = ( direct * energy * powder * baseShadow + ambient ) * scs.cloudLight.x;
			let stepT = exp( -sigmaT * stepLength );
			let alpha = transmission * ( 1.0 - stepT );
			color += alpha * light; weightedDepth += alpha * t;
			transmission *= stepT; accumulatedDepth += sigmaT * stepLength; t += stepLength;
		}
	}
	let alpha = 1.0 - transmission;
	var depth = SC_FAR;
	if ( alpha > 0.0 ) {
		depth = weightedDepth / alpha;
		let sky = scSky( dir, skT, skS );
		let ap = exp( -depth / SC_AP_DIST );
		color = color * ap + sky * alpha * ( 1.0 - ap );
		let melt = smoothstep( scs.fade.y, max( scs.fade.z, scs.fade.y + 1.0 ), depth );
		color = mix( color, sky * alpha, melt );
	}
	out.color = color; out.alpha = alpha; out.depth = depth; out.steps = steps;
	return out;
}
`;

// ------------------------------------------------------------------ WGSL: weather (verbatim)
const WEATHER_WGSL = /* wgsl */`
fn scHash33( cell: vec3u ) -> vec3u {
	var p = cell * 1664525u + 1013904223u;
	p.x += p.y * p.z; p.y += p.z * p.x; p.z += p.x * p.y;
	p = p ^ ( p >> vec3u( 16u ) );
	p.x += p.y * p.z; p.y += p.z * p.x; p.z += p.x * p.y;
	return p;
}
fn scGradient( cell: vec3i, period: i32, offset: vec3f ) -> f32 {
	let wrapped = vec3u( ( ( cell % vec3i( period ) ) + vec3i( period ) ) % vec3i( period ) );
	let h = ( scHash33( wrapped ).x >> 24u ) & 15u;
	let u = select( offset.y, offset.x, h < 8u );
	let v = select( select( offset.z, offset.x, h == 12u || h == 14u ), offset.y, h < 4u );
	return select( -u, u, ( h & 1u ) == 0u ) + select( -v, v, ( h & 2u ) == 0u );
}
fn scPerlin( p: vec3f, period: i32 ) -> f32 {
	let cell = vec3i( floor( p ) ); let fr = fract( p ); let w = fr * fr * fr * ( fr * ( fr * 6.0 - 15.0 ) + 10.0 );
	return mix( mix( mix( scGradient( cell, period, fr ), scGradient( cell + vec3i( 1, 0, 0 ), period, fr - vec3f( 1, 0, 0 ) ), w.x ),
		mix( scGradient( cell + vec3i( 0, 1, 0 ), period, fr - vec3f( 0, 1, 0 ) ), scGradient( cell + vec3i( 1, 1, 0 ), period, fr - vec3f( 1, 1, 0 ) ), w.x ), w.y ),
		mix( mix( scGradient( cell + vec3i( 0, 0, 1 ), period, fr - vec3f( 0, 0, 1 ) ), scGradient( cell + vec3i( 1, 0, 1 ), period, fr - vec3f( 1, 0, 1 ) ), w.x ),
		mix( scGradient( cell + vec3i( 0, 1, 1 ), period, fr - vec3f( 0, 1, 1 ) ), scGradient( cell + vec3i( 1, 1, 1 ), period, fr - vec3f( 1, 1, 1 ) ), w.x ), w.y ), w.z );
}
fn scFbm( uv: vec2f, profile: vec4f ) -> f32 {
	var frequency = max( 1.0, round( profile.x ) ); var weight = 0.5;
	var sum = 0.0; var weights = 0.0;
	for ( var i = 0u; i < u32( profile.y ); i++ ) {
		sum += scPerlin( vec3f( uv, profile.z * 13.37 + 0.5 ) * frequency, i32( frequency ) ) * weight;
		weights += weight; weight *= 0.5; frequency *= 2.0;
	}
	return sum / max( weights, 0.001 ) * 0.5 + 0.5;
}
`;

// ------------------------------------------------------------------ WGSL: temporal resolve helpers (verbatim but for PORT:)
const TEMPORAL_WGSL = /* wgsl */`
// PORT: the workgroup tile was a cache of textureLoads; load directly (identical values)
// PORT: clamp to the ACTIVE source area (history size / lattice): the source texture is allocated for
// the denser 2x2 lattice used while the sun moves, and the 4x4 lattice fills only part of it
fn scSourceClamp( p: vec2i, cC: texture_2d<f32> ) -> vec2i { return clamp( p, vec2i( 0 ), vec2i( scf.viewport.zw / scf.sampling.z ) - 1 ); }
fn scHistoryAt( uv: vec2f, size: vec2f, pC: texture_2d<f32>, smp: sampler ) -> vec4f {
	let position = uv * size;
	let center = floor( position - 0.5 ) + 0.5;
	let fr = position - center;
	let w0 = fr * ( fr * ( -0.5 * fr + 1.0 ) - 0.5 );
	let w1 = fr * fr * ( 1.5 * fr - 2.5 ) + 1.0;
	let w2 = fr * ( fr * ( -1.5 * fr + 2.0 ) + 0.5 );
	let w3 = fr * fr * ( 0.5 * fr - 0.5 );
	let w12 = w1 + w2;
	let uv0 = ( center - 1.0 ) / size;
	let uv3 = ( center + 2.0 ) / size;
	let uv12 = ( center + w2 / w12 ) / size;
	let weights = vec4f( w12.x * w0.y, w0.x * w12.y, w12.x * w12.y, w3.x * w12.y );
	let bottomWeight = w12.x * w3.y;
	let value = textureSampleLevel( pC, smp, vec2f( uv12.x, uv0.y ), 0.0 ) * weights.x
		+ textureSampleLevel( pC, smp, vec2f( uv0.x, uv12.y ), 0.0 ) * weights.y
		+ textureSampleLevel( pC, smp, uv12, 0.0 ) * weights.z
		+ textureSampleLevel( pC, smp, vec2f( uv3.x, uv12.y ), 0.0 ) * weights.w
		+ textureSampleLevel( pC, smp, vec2f( uv12.x, uv3.y ), 0.0 ) * bottomWeight;
	return value / ( dot( weights, vec4f( 1.0 ) ) + bottomWeight );
}
fn scFreshHistoryWeight( color: vec4f, depth: f32 ) -> f32 {
	let retain = select( mix( 0.25, 0.65, smoothstep( 8.0, 30.0, depth ) ), 0.25, color.a < 0.0001 );
	return min( scf.temporal.x, retain ) * ( 1.0 - scf.temporal.y );
}
// PORT: scResolve wrote both textures; here it returns the colour and leaves the metadata in scMetaOut
fn scResolve( color: vec4f, depth: f32, carriedDepth: f32, cost: f32, weight: f32 ) -> vec4f {
	scMetaOut = vec4f( depth, carriedDepth, cost, weight );
	return vec4f( max( color.rgb, vec3f( 0.0 ) ), clamp( color.a, 0.0, 1.0 ) );
}
`;

// ------------------------------------------------------------------ kernels (entry functions)
const COMMON = [DECLS, CORE_WGSL].join("\n");

export function createSkyProClouds({ renderer, atmosphere }) {
  const P = PRESET, q = QUALITY, sh = P.shape, li = P.lighting;

  // ---- uniforms (the CPU packs Sky Pro's two blocks + the PORT extras)
  const U = uniformArray(Array.from({ length: N_U }, () => new THREE.Vector4()), "vec4");
  const u = U.array;
  const setU = (i, a, b = 0, c = 0, d = 0) => u[i].set(a, b, c, d);
  const Fi = Object.fromEntries(F_FIELDS.map((k, i) => [k, i]));
  const Si = Object.fromEntries(S_FIELDS.map((k, i) => [k, S0 + i]));
  const Xi = Object.fromEntries(X_FIELDS.map((k, i) => [k, X0 + i]));
  setU(Si.shell, sh.altitude, sh.thickness, sh.density, sh.coverage);
  setU(Si.shape, sh.weatherScale, sh.baseScale, sh.baseStrength, sh.erosionScaleBaseMultiplier);
  setU(Si.erosion, sh.erosionStrengthBase, sh.erosionStrengthPeak, sh.erosionShape, sh.baseWeatherHeightEnd);
  setU(Si.base, sh.baseWeatherStrength, sh.edgeSoftness, Math.log2(Math.max(sh.edgeSoftnessFalloff, 0.001)) * sh.thickness * 0.001, sh.baseWeatherHeightStart);
  setU(Si.horizon, sh.horizonCoverageStart, sh.horizonCoverageRamp, sh.horizonCoverageAmount, 0);
  setU(Si.cloudLight, li.scatteringAlbedo, li.powderStrength, li.ambientIntensity, P.atmosphere.multipleScattering);
  setU(Si.shadow, li.baseShadowStrength, li.baseShadowHeight, li.moonGain, 0);
  setU(Si.bounce, ...li.groundBounceAlbedo, 0);
  setU(Si.wind, 0, 1, P.wind.skew, 0);
  setU(Si.fade, P.fade.hazeDensityScale, P.fade.horizonMeltStart, P.fade.horizonMeltEnd, 0);
  setU(Si.weatherMass, ...P.weather.mainMass);
  setU(Si.weatherDetail, ...P.weather.detail);
  setU(Si.weather, P.weather.coverage, 0, 0, 0);
  const uArgs = Array.from({ length: N_U }, (_, i) => U.element(i));

  // ---- textures
  const storage2D = (w, h, type = THREE.HalfFloatType, name = "") => {
    const t = new THREE.StorageTexture(w, h);
    t.type = type;
    t.format = THREE.RGBAFormat;
    t.minFilter = THREE.LinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.generateMipmaps = false;
    t.name = name;
    return t;
  };
  const W = P.weather.resolution;
  const weatherMap = storage2D(W, W, THREE.UnsignedByteType, "cloud weather");
  weatherMap.wrapS = weatherMap.wrapT = THREE.RepeatWrapping;
  const weatherBounds = storage2D(64, 64, THREE.UnsignedByteType, "cloud weather bounds");
  const panorama = storage2D(PANO_W, PANO_H, THREE.HalfFloatType, "cloud panorama");
  panorama.wrapS = THREE.RepeatWrapping;
  const shadowMap = storage2D(SHADOW_RES, SHADOW_RES, THREE.HalfFloatType, "cloud shadow");
  // trace + history are (re)allocated with the view size
  let source, sourceMeta, colors, metas;

  const noise = new THREE.Data3DTexture(new Uint8Array(4), 1, 1, 1); // replaced by _loadNoise
  const blue = new THREE.DataTexture(new Uint8Array(64 * 64), 64, 64, THREE.RedFormat, THREE.UnsignedByteType);
  blue.minFilter = blue.magFilter = THREE.NearestFilter;

  const skyTex = atmosphere.textures.skyView;

  // ---- WGSL functions
  const common = wgsl(COMMON);
  const march = wgsl(MARCH_WGSL, [common, atmosphere.code]);
  const weatherCode = wgsl(WEATHER_WGSL, [common]);
  const temporalCode = wgsl(TEMPORAL_WGSL, [common]);
  // every kernel starts with scLoad( u0 … u50 ): its result is passed on as the `gate` argument so
  // the private copies are filled before anything reads them
  const loadFn = wgslFn(LOAD_FN.replace(/^\s*/, ""), [common]);

  const weatherFn = wgslFn(/* wgsl */`
fn scWeatherAt( gate: f32, id: vec2u, size: vec2u ) -> vec4f {
	let uv = vec2f( id ) / vec2f( size );
	let mass = clamp( ( scFbm( uv, scs.weatherMass ) - 0.5 ) * scs.weatherMass.w + 0.5, 0.0, 1.0 );
	let detail = ( scFbm( uv, scs.weatherDetail ) * 2.0 - 1.0 ) * scs.weatherDetail.w;
	return vec4f( clamp( mass + detail + scs.weather.x - 0.5, 0.0, 1.0 ), 0.0, 0.0, 1.0 );
}`, [weatherCode]);

  const boundsFn = wgslFn(/* wgsl */`
fn scBoundsAt( gate: f32, id: vec2u, size: vec2u, wT: texture_2d<f32> ) -> vec4f {
	let sourceSize = vec2i( textureDimensions( wT ) );
	let scale = vec2f( sourceSize ) / vec2f( size );
	let lo = vec2i( floor( vec2f( id ) * scale - 0.5 ) );
	let hi = vec2i( ceil( vec2f( id + 1u ) * scale - 0.5 ) );
	var maximum = 0.0;
	for ( var y = lo.y; y <= hi.y; y++ ) {
		for ( var x = lo.x; x <= hi.x; x++ ) {
			let p = ( ( vec2i( x, y ) % sourceSize ) + sourceSize ) % sourceSize;
			maximum = max( maximum, textureLoad( wT, p, 0 ).r );
		}
	}
	return vec4f( min( 1.0, maximum + 1.0 / 255.0 ), 0.0, 0.0, 1.0 );
}`, [common]);

  const traceFn = wgslFn(/* wgsl */`
fn scTraceAt( gate: f32, id: vec2u, nT: texture_3d<f32>, wT: texture_2d<f32>, bT: texture_2d<f32>, blT: texture_2d<f32>,
	skT: texture_2d<f32>, smp: sampler, skS: sampler ) -> vec4f {
	let uv = scSourceUV( vec2f( id ) );
	let dir = scRay( uv );
	let noise = textureLoad( blT, vec2i( id % 64u ), 0 ).r;
	let dither = select( 0.5, fract( noise + scf.clock.x * 0.61803398875 ), scf.temporal.x > 0.0 );
	let pixelConeAngle = 2.0 * scf.position.w / scf.viewport.y;
	let stepConeAngle = 2.0 * scf.position.w / scf.viewport.w;
	let m = scMarch( scf.position.xyz, dir, dither, pixelConeAngle, stepConeAngle, u32( scf.march.y ), scf.display.y > 0.0,
		nT, wT, bT, skT, smp, skS );
	scMetaOut = vec4f( m.depth * 0.001, 1.0, f32( m.steps ) / scf.march.y, 0.0 );
	return vec4f( m.color, m.alpha );
}`, [march]);

  const metaFn = wgslFn(/* wgsl */`
fn scMeta( after: vec4f ) -> vec4f { return scMetaOut; }`, [common]);

  // temporal reconstruction: sky-pro temporal.wgsl main(), tile reads replaced by texture loads
  const resolveFn = wgslFn(/* wgsl */`
fn scResolveAt( gate: f32, id: vec2u, cC: texture_2d<f32>, cM: texture_2d<f32>, pC: texture_2d<f32>, pM: texture_2d<f32>, smp: sampler ) -> vec4f {
	let size = textureDimensions( pC );
	let uv = ( vec2f( id.xy ) + 0.5 ) / vec2f( size );
	let lattice = u32( scf.sampling.z );
	let fresh = all( id.xy % lattice == vec2u( scf.sampling.xy ) );
	let source = ( vec2f( id.xy ) - scf.sampling.xy ) / scf.sampling.z;
	let center = scSourceClamp( vec2i( round( source ) ), cC );
	let metadata = textureLoad( cM, center, 0 );
	let central = textureLoad( cC, center, 0 );
	let currentDepth = max( metadata.x, 0.001 );
	let stored = textureLoad( pM, vec2i( id.xy ), 0 );
	let historyValid = scf.sampling.w > 0.5 && scf.temporal.x > 0.0;

	if ( scf.temporal.z > 0.5 && historyValid && stored.y >= 0.001 ) {
		let history = textureLoad( pC, vec2i( id.xy ), 0 );
		if ( fresh ) {
			let weight = scFreshHistoryWeight( central, currentDepth );
			return scResolve( mix( central, history, weight ), currentDepth, currentDepth, metadata.z, weight );
		}
		return scResolve( history, stored.x, stored.y, stored.z, 1.0 );
	}

	var color = vec4f( 0.0 ); var weightSum = 0.0;
	let base = vec2i( floor( source ) ); let fraction = fract( source );
	for ( var y = 0; y < 2; y++ ) {
		for ( var x = 0; x < 2; x++ ) {
			let pos = scSourceClamp( base + vec2i( x, y ), cC );
			let tap = textureLoad( cC, pos, 0 ); let depth = textureLoad( cM, pos, 0 ).x;
			let bilinear = select( 1.0 - fraction.x, fraction.x, x == 1 ) * select( 1.0 - fraction.y, fraction.y, y == 1 );
			let weight = bilinear * exp( -abs( depth - metadata.x ) / max( 0.1, metadata.x * 0.1 ) - abs( tap.a - central.a ) * 4.0 );
			color += tap * weight; weightSum += weight;
		}
	}
	color = select( central, color / max( weightSum, 0.00001 ), weightSum > 0.00001 );
	if ( fresh ) { color = central; }
	if ( ! historyValid ) {
		return scResolve( color, currentDepth, currentDepth, metadata.z, 0.0 );
	}

	var low = color; var high = color;
	var reprojectionDepth = select( SC_FAR * 0.001, stored.y, stored.y >= 0.001 );
	for ( var y = -1; y <= 1; y++ ) {
		for ( var x = -1; x <= 1; x++ ) {
			let tap = textureLoad( cC, scSourceClamp( center + vec2i( x, y ), cC ), 0 );
			low = min( low, tap ); high = max( high, tap );
			let neighbor = clamp( vec2i( id.xy ) + vec2i( x, y ), vec2i( 0 ), vec2i( size ) - 1 );
			let depth = textureLoad( pM, neighbor, 0 ).y;
			if ( depth >= 0.001 ) { reprojectionDepth = min( reprojectionDepth, depth ); }
		}
	}
	if ( stored.y < 0.001 ) { reprojectionDepth = min( reprojectionDepth, currentDepth ); }
	var world = scf.position.xyz + scRay( uv ) * ( reprojectionDepth * 1000.0 );
	world -= vec3f( scf.windDelta.x, 0.0, scf.windDelta.y );
	let previous = scProjectPrevious( world );
	let previousPixel = clamp( vec2i( previous.xy * vec2f( size ) ), vec2i( 0 ), vec2i( size ) - 1 );
	let oldMeta = textureLoad( pM, previousPixel, 0 );
	let valid = previous.z > 0.0 && all( previous.xy >= vec2f( 0.0 ) ) && all( previous.xy <= vec2f( 1.0 ) ) && oldMeta.y >= 0.001;
	var carriedDepth = currentDepth; var historyFraction = 0.0;
	if ( valid ) {
		let history = clamp( scHistoryAt( previous.xy, vec2f( size ), pC, smp ), low, high );
		let motionPixels = length( ( previous.xy - uv ) * vec2f( size ) );
		historyFraction = select( 1.0, scFreshHistoryWeight( central, currentDepth ), fresh );
		color = mix( color, history, historyFraction );
		let expectedDepth = length( world - scf.previousPosition.xyz ) * 0.001;
		if ( ! fresh && ( motionPixels <= 0.5 || abs( oldMeta.y - expectedDepth ) < max( 0.001, expectedDepth * 0.15 ) ) ) {
			carriedDepth = oldMeta.y;
		}
	}
	return scResolve( color, currentDepth, carriedDepth, metadata.z, historyFraction );
}`, [temporalCode]);

  const panoFn = wgslFn(/* wgsl */`
fn scPanoAt( gate: f32, texel: vec2u, size: vec2u, nT: texture_3d<f32>, wT: texture_2d<f32>, bT: texture_2d<f32>,
	skT: texture_2d<f32>, smp: sampler, skS: sampler ) -> vec4f {
	let uv = ( vec2f( texel ) + 0.5 ) / vec2f( size );
	let elev = uv.y * uv.y * ${f(94 * DEG)} - ${f(4 * DEG)};
	let az = uv.x * ${f(2 * Math.PI)};
	let dir = vec3f( cos( elev ) * cos( az ), sin( elev ), cos( elev ) * sin( az ) );
	let cone = ${f(2 * Math.PI / PANO_W)};
	let m = scMarch( scf.position.xyz, dir, 0.5, cone, cone, 128u, true, nT, wT, bT, skT, smp, skS );
	return vec4f( m.color, 1.0 - m.alpha );
}`, [march]);

  const shadowFn = wgslFn(/* wgsl */`
fn scShadowAt( gate: f32, texel: vec2u, size: vec2u, nT: texture_3d<f32>, wT: texture_2d<f32>, smp: sampler ) -> vec4f {
	let xz = scf.shadow.xy + ( ( vec2f( texel ) + 0.5 ) / vec2f( size ) - 0.5 ) * scf.shadow.z;
	let L = scx.sunDir.xyz; // PORT: frame.sunDir
	let ly = max( L.y, 0.08 );
	let t0 = scs.shell.x / ly;
	let t1 = ( scs.shell.x + scs.shell.y ) / ly;
	let n = 16;
	let dt = ( t1 - t0 ) / f32( n );
	var tau = 0.0;
	for ( var i = 0; i < n; i++ ) {
		let t = t0 + ( f32( i ) + 0.5 ) * dt;
		let p = vec3f( xz.x, 0.0, xz.y ) + vec3f( L.x, ly, L.z ) * t;
		tau += scLightDensity( p, scs.shell.w, vec2f( 2.0, 2.0 ), false, nT, wT, smp ) * scs.shell.z * dt;
		if ( tau > 12.0 ) { break; }
	}
	let T = exp( -tau ) * 0.8 + exp( -tau * 0.25 ) * 0.2;
	return vec4f( T, 0.0, 0.0, 1.0 );
}`, [common]);

  // ---- TSL passes
  const uWeatherSize = uniform(new THREE.Vector2(W, W));
  const uBoundsSize = uniform(new THREE.Vector2(64, 64));
  const uSourceSize = uniform(new THREE.Vector2(1, 1));
  const uHistorySize = uniform(new THREE.Vector2(1, 1));
  const uPanoLattice = uniform(new THREE.Vector3(0, 0, 1)); // xy offset, z step
  const uShadowPhase = uniform(0); // row phase, <0 = all rows

  const loadAll = () => loadFn(...uArgs);
  const noiseNode = texture3D(noise);
  const smpRepeat = sampler(noiseNode);
  const weatherNode = texture(weatherMap);
  const boundsNode = texture(weatherBounds);
  const skyNode = texture(skyTex);
  const skySmp = sampler(skyNode);

  const inside = (id, size) => id.x.lessThan(uint(size.x)).and(id.y.lessThan(uint(size.y)));

  const weatherPass = Fn(() => {
    const id = globalId.xy;
    If(inside(id, uWeatherSize), () => {
      textureStore(weatherMap, id, weatherFn(loadAll(), id, uvec2(uWeatherSize)));
    });
  })().compute([W / 8, W / 8, 1], [8, 8, 1]).setName("Cloud Weather");

  const boundsPass = Fn(() => {
    const id = globalId.xy;
    If(inside(id, uBoundsSize), () => {
      textureStore(weatherBounds, id, boundsFn(loadAll(), id, uvec2(uBoundsSize), weatherNode));
    });
  })().compute([8, 8, 1], [8, 8, 1]).setName("Cloud Weather Bounds");

  const panoPass = Fn(() => {
    const texel = globalId.xy.mul(uint(uPanoLattice.z)).add(uvec2(uPanoLattice.xy));
    If(texel.x.lessThan(uint(PANO_W)).and(texel.y.lessThan(uint(PANO_H))), () => {
      textureStore(panorama, texel, panoFn(loadAll(), texel, uvec2(PANO_W, PANO_H), noiseNode, weatherNode, boundsNode, skyNode, smpRepeat, skySmp));
    });
  })().compute([PANO_W / 8, PANO_H / 8, 1], [8, 8, 1]).setName("Clouds Panorama");

  const shadowPass = Fn(() => {
    const id = globalId.xy;
    const full = uShadowPhase.lessThan(0.0);
    const phased = uvec2(id.x, id.y.mul(4).add(uint(max(uShadowPhase, 0.0))));
    const texel = select(full, id, phased);
    If(texel.x.lessThan(uint(SHADOW_RES)).and(texel.y.lessThan(uint(SHADOW_RES))), () => {
      textureStore(shadowMap, texel, shadowFn(loadAll(), texel, uvec2(SHADOW_RES, SHADOW_RES), noiseNode, weatherNode, smpRepeat));
    });
  })().compute([SHADOW_RES / 8, SHADOW_RES / 8, 1], [8, 8, 1]).setName("Clouds Shadow");

  let tracePass = null;
  const resolvePasses = [null, null];

  function buildViewPasses() {
    tracePass = Fn(() => {
      const id = globalId.xy;
      If(inside(id, uSourceSize), () => {
        const c = traceFn(loadAll(), id, noiseNode, weatherNode, boundsNode, texture(blue), skyNode, smpRepeat, skySmp).toVar();
        textureStore(source, id, c);
        textureStore(sourceMeta, id, metaFn(c));
      });
    })().compute([1, 1, 1], [8, 8, 1]).setName("Clouds Trace");

    // ping-pong: pass k writes colors[k] / metas[k] and reads the other pair
    for (let k = 0; k < 2; k++) {
      const outC = colors[k], outM = metas[k], prevC = colors[1 - k], prevM = metas[1 - k];
      const prevNode = texture(prevC);
      resolvePasses[k] = Fn(() => {
        const id = globalId.xy;
        If(inside(id, uHistorySize), () => {
          const c = resolveFn(loadAll(), id, texture(source), texture(sourceMeta), prevNode, texture(prevM), sampler(prevNode)).toVar();
          textureStore(outC, id, c);
          textureStore(outM, id, metaFn(c));
        });
      })().compute([1, 1, 1], [8, 8, 1]).setName("Clouds Resolve");
    }
  }

  // ---- display-side TSL (the sky material reads these)
  const uViewRight = uniform(new THREE.Vector3(1, 0, 0));
  const uViewUp = uniform(new THREE.Vector3(0, 1, 0));
  const uViewFwd = uniform(new THREE.Vector3(0, 0, -1));
  const uViewTan = uniform(new THREE.Vector2(1, 1));
  const uViewValid = uniform(0);
  const uHorizonMask = uniform(0);
  const uShadowCenter = uniform(new THREE.Vector2());
  const uShadowSize = uniform(12000);
  const uShadowStrength = uniform(0.85);
  const viewTexNode = texture(panorama); // .value = the current history colour (set in update)
  const panoNode = texture(panorama);

  /** vec4( rgb in-scattered radiance, a transmittance ) — the panorama (cloudsSample). */
  const panoSample = Fn(([dirIn]) => {
    const dir = normalize(dirIn);
    const az = atan(dir.z, dir.x);
    const uu = fract(az.div(2 * Math.PI));
    const elev = acos(clamp(dir.y, -1.0, 1.0)).negate().add(Math.PI / 2);
    const t = clamp(elev.add(4 * DEG).div(94 * DEG), 0.0, 1.0);
    const s = panoNode.sample(vec2(uu, sqrt(t))).level(0);
    const below = smoothstep(-0.07, -0.03, dir.y);
    return vec4(s.rgb.mul(below), mix(float(1.0), s.a, below));
  });

  /** The main view's clouds (cloudsSampleView): the reconstructed history, else the panorama. */
  const viewSample = Fn(([dirIn]) => {
    const dir = normalize(dirIn);
    const x = dot(dir, uViewRight), y = dot(dir, uViewUp), z = dot(dir, uViewFwd);
    const zz = max(z, 1e-4);
    const uvv = vec2(x.div(zz).div(uViewTan.x).mul(0.5).add(0.5), float(0.5).sub(y.div(zz).div(uViewTan.y).mul(0.5)));
    const ok = uViewValid.greaterThan(0.5).and(z.greaterThan(0.01))
      .and(all(uvv.greaterThanEqual(vec2(0.0)))).and(all(uvv.lessThanEqual(vec2(1.0))));
    // three samples render-target textures with a y flip; a StorageTexture is not one, so no flip
    const v = max(viewTexNode.sample(uvv).level(0), vec4(0.0));
    // Tidewater's below-horizon mask, optional (api.horizonMask): off, the march's own ground stop
    // is what ends a downward ray, so clouds show from above and inside the deck
    const above = select(uHorizonMask.greaterThan(0.5), smoothstep(-0.05, -0.03, dir.y), float(1.0));
    const inView = vec4(v.rgb.mul(above), float(1.0).sub(v.a.min(1.0).mul(above)));
    return select(ok, inView, panoSample(dir));
  });

  /** Sun disc transmittance behind the clouds (cloudsSunTransmittance). */
  const sunTransmittance = Fn(([T]) => T.mul(smoothstep(0.004, 0.04, T)));

  const shadowLookupFn = wgslFn(/* wgsl */`
fn scCloudsShadow( worldXZ: vec2f, center: vec2f, size: f32, strength: f32, sT: texture_2d<f32> ) -> f32 {
	let uv = ( worldXZ - center ) / size + 0.5;
	let st = uv * ${f(SHADOW_RES)} - 0.5;
	let i0 = vec2i( floor( st ) );
	let fr = fract( st );
	let m = vec2i( ${SHADOW_RES - 1} );
	let a = textureLoad( sT, clamp( i0, vec2i( 0 ), m ), 0 ).x;
	let b = textureLoad( sT, clamp( i0 + vec2i( 1, 0 ), vec2i( 0 ), m ), 0 ).x;
	let c = textureLoad( sT, clamp( i0 + vec2i( 0, 1 ), vec2i( 0 ), m ), 0 ).x;
	let d = textureLoad( sT, clamp( i0 + vec2i( 1, 1 ), vec2i( 0 ), m ), 0 ).x;
	let s = mix( mix( a, b, fr.x ), mix( c, d, fr.x ), fr.y );
	let e = abs( uv - 0.5 );
	let inside = smoothstep( 0.5, 0.42, max( e.x, e.y ) );
	return mix( 1.0, s, strength * inside );
}`);
  const shadowNode = texture(shadowMap);
  /** Cloud shadow on the ground at world xz (1 = clear). */
  const shadowAt = (xz) => shadowLookupFn(xz, uShadowCenter, uShadowSize, uShadowStrength, shadowNode);

  // ---- CPU state (SkyProClouds.update, ported line for line)
  const state = {
    w: 0, h: 0, scale: 1, sourceWidth: 1, sourceHeight: 1, historyWidth: 1, historyHeight: 1,
    frameIndex: 0, historyValid: false, weatherDirty: true, panoWarm: true,
    windX: 0, windZ: 0, evolution: 0, elapsed: 0, prevCam: null, prevLight: new THREE.Vector3(),
    lastCoverage: -1, pp: 0, shadowInit: false,
  };
  const api = {
    coverage: { value: sh.coverage },
    /** the cloud trace's resolution relative to the drawing buffer (1 = Sky Pro's "high": half-res history) */
    resolutionScale: 1,
    /** Drift at the deck, m/s. Tidewater runs 12 (the preset's 89 is "a time-lapse"); the shapes
     *  evolve in proportion, as Tidewater scales them. */
    windSpeed: { value: P.wind.speed },
    /** LAB CHANGE, not Sky Pro: the sun may jump this far (deg) in ONE frame before the history is
     *  dropped. Sky Pro drops it past ~2.6 deg (dot < 0.999), and a dragged time slider moves the sun
     *  ~3 deg per frame = history reset every frame = only 1/16 of the pixels traced = blocky. The
     *  resolve's neighbourhood clamp already pulls stale lighting to the fresh trace, so moderate
     *  jumps keep the history. 2.56 = Sky Pro. */
    lightResetDeg: 2.56,
    /** Tidewater hides clouds below the horizon (a camera that never looks down on them). Off =
     *  clouds seen from above and inside the deck. true = exactly the reference. */
    horizonMask: false,
    /** LAB CHANGE: trace every pixel instead of 4x4 while the key light moves (see MOVING_LATTICE). */
    denseWhileMoving: true,
    lattice: QUALITY.lattice,
    viewSample, panoSample, shadowAt, sunTransmittance,
    /** the shadow map's placement (world xz centre, size m, strength), for raw-WGSL readers (the haze) */
    shadowUniforms: { center: uShadowCenter, size: uShadowSize, strength: uShadowStrength },
    textures: { weatherMap, weatherBounds, panorama, shadowMap, noise },
    get historyColor() { return colors ? colors[state.pp === 0 ? 1 : 0] : null; },
    update, resetHistory() { state.historyValid = false; }, invalidate() { state.panoWarm = true; state.historyValid = false; },
    ready: null,
    passes: {},
  };

  function allocate(w, h) {
    const scale = api.resolutionScale;
    state.sourceWidth = Math.max(1, Math.ceil(w * scale / q.historyDivisor / q.lattice));
    state.sourceHeight = Math.max(1, Math.ceil(h * scale / q.historyDivisor / q.lattice));
    state.historyWidth = state.sourceWidth * q.lattice;
    state.historyHeight = state.sourceHeight * q.lattice;
    for (const t of [source, sourceMeta, ...(colors || []), ...(metas || [])]) if (t) t.dispose();
    // sized for the densest lattice used (MOVING_LATTICE while the sun moves); the 4x4 one fills a part
    const srcW = state.historyWidth / MOVING_LATTICE, srcH = state.historyHeight / MOVING_LATTICE;
    source = storage2D(srcW, srcH, THREE.HalfFloatType, "cloud radiance");
    sourceMeta = storage2D(srcW, srcH, THREE.HalfFloatType, "cloud depth + cost");
    colors = [0, 1].map((i) => storage2D(state.historyWidth, state.historyHeight, THREE.HalfFloatType, `cloud history ${i}`));
    metas = [0, 1].map((i) => storage2D(state.historyWidth, state.historyHeight, THREE.HalfFloatType, `cloud history meta ${i}`));
    uHistorySize.value.set(state.historyWidth, state.historyHeight);
    buildViewPasses();
    state.historyValid = false;
    state.pp = 0;
  }

  const _L = new THREE.Vector3();
  const _T = [0, 0, 0];
  /**
   * @param {number} dt
   * @param {THREE.PerspectiveCamera} camera
   * @param {object} o  sunDir (the true sun, for the sky LUT), lightDir (key light: sun or moon),
   *                    windDir (Vector2), night (0..1), moonColor (linear, key-light units), drawingBufferSize (Vector2)
   */
  function update(dt, camera, o) {
    const F = Fi, S = Si, X = Xi;
    dt = Math.min(0.1, Math.max(0, dt));

    // ---- output size
    const size = o.drawingBufferSize;
    if (size.x !== state.w || size.y !== state.h || api.resolutionScale !== state.scale) {
      state.w = size.x; state.h = size.y; state.scale = api.resolutionScale;
      allocate(size.x, size.y);
    }

    // ---- settings: coverage, wind direction
    const cov = api.coverage.value;
    if (cov !== state.lastCoverage) {
      u[S.shell].w = cov;
      state.lastCoverage = cov;
      state.historyValid = false;
      state.panoWarm = true;
    }
    const wd = o.windDir;
    const wl = Math.hypot(wd.x, wd.y) || 1;
    const wx = wd.x / wl, wz = wd.y / wl;
    u[S.wind].x = wx; u[S.wind].y = wz;

    // ---- PORT: the atmosphere's inputs (Tidewater's frame.sunDir / scDirect / scSky)
    const L = _L.copy(o.lightDir).normalize();
    u[X.sunDir].set(L.x, L.y, L.z, 0);
    const trueSun = o.sunDir;
    const isMoon = L.dot(trueSun) < 0.9999;
    if (isMoon) {
      const mc = o.moonColor;
      u[X.direct].set(mc.x, mc.y, mc.z, 0);
    } else {
      // Tidewater scDirect: atmosphereSampleTransmittance( 6360 + shell.x / 1000, sunDir.y ) x sunIlluminance
      atmosphere.sunColorAt(sh.altitude, L.y, _T);
      u[X.direct].set(_T[0], _T[1], _T[2], 0);
    }
    const na = o.nightAmbient || [0, 0, 0];
    u[X.nightAmb].set(na[0], na[1], na[2], 0);
    u[X.sky].set(trueSun.x, trueSun.y, trueSun.z, atmosphere.viewHeightKm());

    if (state.weatherDirty) {
      renderer.compute(weatherPass);
      renderer.compute(boundsPass);
      state.weatherDirty = false;
    }

    // ---- camera
    camera.updateMatrixWorld();
    const e = camera.matrixWorld.elements;
    const cp = camera.position;
    const tanY = Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5)) / (camera.zoom || 1);
    const aspect = camera.aspect;
    const nrm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
    const R = nrm([e[0], e[1], e[2]]), Up = nrm([e[4], e[5], e[6]]), Fw = nrm([-e[8], -e[9], -e[10]]);
    const cur = { position: [cp.x, cp.y, cp.z, tanY], right: [...R, aspect], up: [...Up, 0], forward: [...Fw, 0] };
    const prev = state.prevCam;
    if (!prev
      || Math.hypot(cp.x - prev.position[0], cp.y - prev.position[1], cp.z - prev.position[2]) > 1000
      || Fw[0] * prev.forward[0] + Fw[1] * prev.forward[1] + Fw[2] * prev.forward[2] < 0.7
      || Math.abs(tanY - prev.position[3]) > 0.01) state.historyValid = false;
    // a JUMP of the light since last frame (Sky Pro: dot < 0.999, ~2.6 deg; see lightResetDeg). A
    // dragged time slider moves the sun ~3 deg per frame, which reset Sky Pro's history every frame.
    const lightCos = L.dot(state.prevLight);
    if (lightCos < Math.cos(api.lightResetDeg * DEG)) {
      state.historyValid = false;
      state.panoWarm = true;
    }
    const lightMoving = api.denseWhileMoving && lightCos < Math.cos(MOVING_EPS_DEG * DEG);
    state.prevLight.copy(L);
    const src = state.historyValid && prev ? prev : cur;
    u[F.position].fromArray(cur.position); u[F.right].fromArray(cur.right); u[F.up].fromArray(cur.up); u[F.forward].fromArray(cur.forward);
    u[F.previousPosition].fromArray(src.position); u[F.previousRight].fromArray(src.right);
    u[F.previousUp].fromArray(src.up); u[F.previousForward].fromArray(src.forward);
    state.prevCam = cur;

    // ---- sampling lattice (Morton-style permutation over the 4x4 cycle)
    const lat = lightMoving ? MOVING_LATTICE : q.lattice, index = state.frameIndex % (lat * lat);
    const activeW = state.historyWidth / lat, activeH = state.historyHeight / lat;
    uSourceSize.value.set(activeW, activeH);
    api.lattice = lat;
    let lx = 0, ly = 0;
    for (let bit = 0; (1 << bit) < lat; bit++) {
      const pair = (index >> (bit * 2)) & 3;
      lx |= ((pair >> 1) ^ (pair & 1)) << (Math.log2(lat) - bit - 1);
      ly |= (pair & 1) << (Math.log2(lat) - bit - 1);
    }
    u[F.viewport].set(size.x * api.resolutionScale, size.y * api.resolutionScale, state.historyWidth, state.historyHeight);
    u[F.sampling].set(lx, ly, lat, state.historyValid ? 1 : 0);

    // ---- clock and wind
    state.elapsed += dt;
    const speed = api.windSpeed.value;
    const evolutionSpeed = P.wind.evolutionSpeed * speed / P.wind.speed; // Tidewater: 60.8 * speed / 89
    const dx = wx * speed * dt, dz = wz * speed * dt;
    state.windX += dx; state.windZ += dz; state.evolution += evolutionSpeed * dt;
    u[F.clock].set(state.frameIndex % 4096, state.elapsed, dt, 0);
    u[F.wind].set(state.windX, state.windZ, state.evolution, 0);
    u[F.windDelta].set(dx, dz, 0, 0);
    u[F.march].set(q.stepMeters, q.maxSteps, q.lightTaps, q.fullLightingAlpha);
    u[F.temporal].set(q.historyWeight, Math.min(1, evolutionSpeed * dt / 100), 0, 0);
    u[F.display].set(0, q.lightReuseSteps, 0, 0);

    // ---- light march taps: a 25 m local segment, then geometric growth over a cone
    const lxd = L.x, lyd = L.y, lzd = L.z;
    let tx = lzd, ty = 0, tz = -lxd;
    if (Math.abs(lyd) > 0.99) { tx = 0; ty = -lzd; tz = lyd; }
    const inv = 1 / Math.hypot(tx, ty, tz);
    tx *= inv; ty *= inv; tz *= inv;
    const bx = lyd * tz - lzd * ty, by = lzd * tx - lxd * tz, bz = lxd * ty - lyd * tx;
    u[LIGHT_OFS].set(0, 0, 0, 25);
    u[LIGHT_LODS].set(0, 0, 0, 0);
    for (let i = 1; i < 8; i++) {
      const growth = 1.7 ** i, mid = 25 * ((growth - 1) / 0.7 + growth * 0.5);
      const angle = i * 2.399963, radius = Math.sqrt((i + 0.5) / q.lightTaps);
      const uu = Math.cos(angle) * radius * 0.05 * mid, vv = Math.sin(angle) * radius * 0.05 * mid;
      u[LIGHT_OFS + i].set(lxd * mid + tx * uu + bx * vv, lyd * mid + ty * uu + by * vv, lzd * mid + tz * uu + bz * vv, 25 * growth);
      const footprint = mid * 0.1;
      u[LIGHT_LODS + i].set(
        Math.max(0, Math.log2(footprint * 64 / sh.baseScale)),
        Math.max(0, Math.log2(footprint * 64 / (sh.baseScale * sh.erosionScaleBaseMultiplier))), 0, 0);
    }

    // ---- shadow map: a quarter of the rows per frame around a snapped centre
    const phase = state.frameIndex % 4;
    if (phase === 0 || !state.shadowInit) {
      const cell = uShadowSize.value / SHADOW_RES * 4;
      uShadowCenter.value.set(Math.round(cp.x / cell) * cell, Math.round(cp.z / cell) * cell);
    }
    u[F.shadow].set(uShadowCenter.value.x, uShadowCenter.value.y, uShadowSize.value, phase);

    // ---- dispatches
    if (!state.shadowInit) {
      u[F.shadow].w = -1;
      uShadowPhase.value = -1;
      renderer.compute(shadowPass, [SHADOW_RES / 8, SHADOW_RES / 8, 1]);
      state.shadowInit = true;
    } else {
      uShadowPhase.value = phase;
      renderer.compute(shadowPass, [SHADOW_RES / 8, SHADOW_RES / 32, 1]);
    }

    if (state.panoWarm) {
      uPanoLattice.value.set(0, 0, 1);
      u[F.pano].set(0, 0, 1, 0);
      renderer.compute(panoPass, [PANO_W / 8, PANO_H / 8, 1]);
      state.panoWarm = false;
    } else {
      const k = state.frameIndex % (PANO_LATTICE * PANO_LATTICE);
      uPanoLattice.value.set(k % PANO_LATTICE, Math.floor(k / PANO_LATTICE), PANO_LATTICE);
      u[F.pano].set(k % PANO_LATTICE, Math.floor(k / PANO_LATTICE), PANO_LATTICE, 0);
      renderer.compute(panoPass, [Math.ceil(PANO_W / PANO_LATTICE / 8), Math.ceil(PANO_H / PANO_LATTICE / 8), 1]);
    }

    renderer.compute(tracePass, [Math.ceil(activeW / 8), Math.ceil(activeH / 8), 1]);
    renderer.compute(resolvePasses[state.pp], [Math.ceil(state.historyWidth / 8), Math.ceil(state.historyHeight / 8), 1]);
    viewTexNode.value = colors[state.pp];
    state.pp = 1 - state.pp;
    uViewRight.value.set(R[0], R[1], R[2]);
    uViewUp.value.set(Up[0], Up[1], Up[2]);
    uViewFwd.value.set(Fw[0], Fw[1], Fw[2]);
    uViewTan.value.set(tanY * aspect, tanY);
    uViewValid.value = 1;
    uHorizonMask.value = api.horizonMask ? 1 : 0;
    state.historyValid = true;

    state.frameIndex++;
  }

  // ---- assets: the Sky Pro noise volume (64³ RGBA8, all mips) and the 64² blue noise
  async function loadNoise() {
    const base = (import.meta.env && import.meta.env.BASE_URL) || "/";
    const get = async (name) => {
      const r = await fetch(base + "clouds/" + name);
      if (!r.ok) throw new Error(`clouds: ${name} HTTP ${r.status}`);
      return r;
    };
    const [noiseRes, blueRes] = await Promise.all([get("baseShape64.bin"), get("blueNoise.bin")]);
    // gzip'd blob: 16 byte header ('NZZ1', version, channels, dims, mip count) + RGBA8 mips
    const data = new Uint8Array(await new Response(noiseRes.body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (view.getUint32(0, true) !== 0x315a5a4e) throw new Error("clouds: bad noise blob");
    const dims = [view.getUint16(6, true), view.getUint16(8, true), view.getUint16(10, true)];
    const mips = view.getUint8(12);
    const levels = [];
    let offset = 16;
    for (let m = 0; m < mips; m++) {
      const d = dims.map((x) => Math.max(1, x >> m));
      const bytes = d[0] * d[1] * d[2] * 4;
      levels.push({ data: data.subarray(offset, offset + bytes), width: d[0], height: d[1], depth: d[2] });
      offset += bytes;
    }
    // three uploads level 0 of a 3D texture only; declaring `mipmaps` makes it allocate the whole
    // chain (and not try to generate it), then the other levels go straight into the GPUTexture
    noise.image = { data: levels[0].data, width: dims[0], height: dims[1], depth: dims[2] };
    noise.mipmaps = levels;
    noise.format = THREE.RGBAFormat;
    noise.type = THREE.UnsignedByteType;
    noise.minFilter = THREE.LinearMipmapLinearFilter;
    noise.magFilter = THREE.LinearFilter;
    noise.wrapS = noise.wrapT = noise.wrapR = THREE.RepeatWrapping;
    noise.generateMipmaps = false;
    noise.unpackAlignment = 1;
    noise.needsUpdate = true;
    renderer.initTexture(noise);
    const gpuTex = renderer.backend.get(noise).texture;
    if (!gpuTex || gpuTex.mipLevelCount !== mips) throw new Error(`clouds: noise texture has ${gpuTex && gpuTex.mipLevelCount} mips, expected ${mips}`);
    const device = renderer.backend.device;
    for (let m = 1; m < mips; m++) {
      const L = levels[m];
      device.queue.writeTexture({ texture: gpuTex, mipLevel: m }, L.data, { bytesPerRow: L.width * 4, rowsPerImage: L.height },
        { width: L.width, height: L.height, depthOrArrayLayers: L.depth });
    }
    blue.image.data.set(new Uint8Array(await blueRes.arrayBuffer()));
    blue.needsUpdate = true;
  }

  api.ready = loadNoise();
  api.passes = { weatherPass, boundsPass, panoPass, shadowPass, get tracePass() { return tracePass; }, resolvePasses };
  return api;
}
