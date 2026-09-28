// SKY PRO — the atmosphere and the sky dome (sun, moon, stars): Tidewater's sky/Atmosphere.js and
// sky/Sky.js on three.js WebGPURenderer + TSL (MIT, Copyright (c) 2026 DRG Software Solutions LLC —
// see v3/skypro-real/tidewater/LICENSE; the reference runs in v3/skypro-real-lab.html).
//
// THIS IS THE SKY PRO MODE'S OWN ATMOSPHERE, on purpose (user's decision, 2026-09-28): not
// v3/render/sky/skyAtmosphere.js and not dayNightSky.js. Same Hillaire 2020 model, Tidewater's own
// constants and LUT layout (e.g. Mie extinction 4.44e-3/km where skyAtmosphere uses 3.996 + 4.4), so
// the clouds, cirrus, haze and environment of the mode sit in exactly the sky they were made under.
// Units are Tidewater's: the sun's illuminance outside the atmosphere is SUN_ILLUMINANCE = 11.
//
// HOW IT IS PORTED (the same "hybrid" as the clouds): the WGSL is Tidewater's, run through wgslFn;
// three owns the resources and passes. Changes are marked `// PORT:`.
//  - The BAKES (transmittance 256x64, multiple scattering 32^2, sky view 192x108, irradiance) read
//    their uniforms from a private copy `atmosphereParams`, filled by atLoad() at the kernel's start.
//  - The LOOKUPS every consumer needs are STATELESS WGSL functions in ONE shared code node
//    (`atmo.code`): their inputs are parameters (`ap` = sun direction + view height, the LUT textures,
//    a sampler), so any number of consumers can include them in one shader without clashing:
//      atmosphereSampleTransmittance( rKm, mu, tT, smp ) -> vec3f
//      atmosphereSkyLuminanceP( dir, ap, svT, smp ) -> vec3f          (atmosphereSkyLuminance)
//      atmosphereSampleMultiScat( rKm, cosSun, mT, smp ) -> vec3f
//      skySunDiskP / skyStarsP / skyMoonP / skyMoonSkyP / skyBackgroundP (Tidewater Sky.js)
//    `ap` = vec4( real sun direction, view height km ); `sp0` = vec4( moon direction, star intensity );
//    `sp1` = vec4( sun disc intensity, time s, night 0..1, - ).
//  - PI is ATMO_PI (three's WGSL may define its own).
//
// CPU side: transmittanceCPU( rKm, mu ) is the transmittance bake's integral in JS (the sun's colour at
// any altitude without a GPU round trip, as skyAtmosphere.js does); the sky irradiance, the sea-level
// sun transmittance and the horizon colour are read back from the GPU every 0.25 s like Tidewater's.

import * as THREE from "three/webgpu";
import { Fn, If, wgsl, wgslFn, uniform, texture, sampler, textureStore, globalId, uvec2, uint, float, vec2, instancedArray } from "three/tsl";

export const RG_KM = 6360.0;
export const RT_KM = 6460.0;
export const SUN_ILLUMINANCE = 11.0;
export const SUN_ANGULAR_RADIUS = 0.004675 * 1.15;

const T_W = 256, T_H = 64;
const MS_RES = 32;
const SV_W = 192, SV_H = 108;
const LOG_STEP = Math.log(1.02);
const STAR_CELLS = 160;
const STAR_SIGMA = 0.1;
const MW = new THREE.Vector3(0.3, 0.2, 1).normalize();
export const STAR_REFLECTION = 0.08;

const f = (x) => {
  const s = String(x);
  return s.includes(".") || s.includes("e") ? s : s + ".0";
};
const piFix = (code) => code.replace(/\bPI\b/g, "ATMO_PI");

// ------------------------------------------------------------------ stateless lookups (shared)
const SAMPLE_WGSL = piFix(/* wgsl */`
const ATMO_PI: f32 = 3.141592653589793;
const ATMO_RG: f32 = ${f(RG_KM)};
const ATMO_RT: f32 = ${f(RT_KM)};

// (r, mu) -> transmittance LUT uv
fn atmosphereTransmittanceUV( r: f32, mu: f32 ) -> vec2f {
	let H = sqrt( ATMO_RT * ATMO_RT - ATMO_RG * ATMO_RG );
	let rho = sqrt( max( r * r - ATMO_RG * ATMO_RG, 0.0 ) );
	let disc = r * r * ( mu * mu - 1.0 ) + ATMO_RT * ATMO_RT;
	let d = max( 0.0, - r * mu + sqrt( max( disc, 0.0 ) ) );
	let dMin = ATMO_RT - r;
	let dMax = rho + H;
	let xMu = ( d - dMin ) / ( dMax - dMin );
	let xR = rho / H;
	return vec2f( ( xMu + ${f(0.5 / T_W)} ) * ${f(T_W / (T_W + 1))}, ( xR + ${f(0.5 / T_H)} ) * ${f(T_H / (T_H + 1))} );
}

// nearest positive ray-sphere intersection from ro (km, planet centered), -1 if none
fn atmosphereRaySphereNearest( ro: vec3f, rd: vec3f, radius: f32 ) -> f32 {
	let b = dot( ro, rd );
	let c = dot( ro, ro ) - radius * radius;
	let disc = b * b - c;
	let sq = sqrt( max( disc, 0.0 ) );
	let t0 = - b - sq;
	let t1 = - b + sq;
	return select( select( select( -1.0, t1, t1 > 0.0 ), t0, t0 > 0.0 ), -1.0, disc < 0.0 );
}

// PORT: the LUTs are parameters (tT transmittance, mT multiple scattering, svT sky view)
fn atmosphereSampleTransmittance( r: f32, mu: f32, tT: texture_2d<f32>, smp: sampler ) -> vec3f {
	return textureSampleLevel( tT, smp, atmosphereTransmittanceUV( r, mu ), 0.0 ).rgb;
}
fn atmosphereSampleMultiScat( r: f32, cosSun: f32, mT: texture_2d<f32>, smp: sampler ) -> vec3f {
	let uv = vec2f( cosSun * 0.5 + 0.5, ( r - ATMO_RG ) / ( ATMO_RT - ATMO_RG ) );
	let suv = uv * ${f((MS_RES - 1) / MS_RES)} + ${f(0.5 / MS_RES)};
	return textureSampleLevel( mT, smp, suv, 0.0 ).rgb;
}
// Sky luminance (no sun disk) for world direction dir (normalized). PORT: ap = ( sun dir, view height km )
fn atmosphereSkyLuminanceP( dir: vec3f, ap: vec4f, svT: texture_2d<f32>, smp: sampler ) -> vec3f {
	let viewH = ap.w;
	let vHorizon = sqrt( max( viewH * viewH - ATMO_RG * ATMO_RG, 0.0 ) );
	let beta = acos( vHorizon / viewH );
	let zenithHorizonAngle = PI - beta;
	let viewZenithAngle = acos( clamp( dir.y, -1.0, 1.0 ) );

	let vCoordA = ( 1.0 - sqrt( max( 1.0 - viewZenithAngle / zenithHorizonAngle, 0.0 ) ) ) * 0.5;
	let vCoordB = sqrt( max( ( viewZenithAngle - zenithHorizonAngle ) / beta, 0.0 ) ) * 0.5 + 0.5;
	let v = select( vCoordB, vCoordA, viewZenithAngle < zenithHorizonAngle );

	let sunH = normalize( vec2f( ap.x, ap.z ) + vec2f( 1e-5, 0.0 ) );
	let dirH = normalize( vec2f( dir.x, dir.z ) + vec2f( 1e-5, 0.0 ) );
	let lightViewCos = dot( sunH, dirH );
	let u = sqrt( clamp( lightViewCos * -0.5 + 0.5, 0.0, 1.0 ) );

	let suv = vec2f( u * ${f((SV_W - 1) / SV_W)} + ${f(0.5 / SV_W)}, v * ${f((SV_H - 1) / SV_H)} + ${f(0.5 / SV_H)} );
	return textureSampleLevel( svT, smp, suv, 0.0 ).rgb;
}

// ---- Tidewater sky/Sky.js (PORT: parameters instead of skyParams / frame / atmosphereParams)
fn skyHash13( p: vec3f ) -> f32 {
	var p3 = fract( p * vec3f( 0.1031, 0.1030, 0.0973 ) );
	p3 += dot( p3, p3.yzx + 33.33 );
	return fract( ( p3.x + p3.y ) * p3.z );
}
fn skySunDiskP( dir: vec3f, ap: vec4f, sp1: vec4f, tT: texture_2d<f32>, smp: sampler ) -> vec3f {
	let cosA = dot( dir, ap.xyz );
	let ang = acos( clamp( cosA, -1.0, 1.0 ) );
	let r = ang / ${f(SUN_ANGULAR_RADIUS)};
	let mask = smoothstep( 1.0, 0.9, r );
	let mu = sqrt( max( 1.0 - r * r, 0.0 ) );
	let limb = 1.0 - 0.6 * ( 1.0 - mu );
	let T = atmosphereSampleTransmittance( ap.w, dir.y, tT, smp ); // atmosphereTransmittanceToSpace
	return T * mask * limb * 2500.0 * sp1.x * smoothstep( -0.02, 0.0, dir.y );
}
fn skyStarsP( dir: vec3f, ap: vec4f, sp0: vec4f, sp1: vec4f ) -> vec3f {
	let a = abs( dir );
	let onX = a.x > a.y && a.x > a.z;
	let onY = a.y > a.z;
	let face = select( select( sign( dir.z ) + 8.0, sign( dir.y ) + 5.0, onY ), sign( dir.x ) + 2.0, onX );
	let uv = select( select( dir.xy / a.z, dir.xz / a.y, onY ), dir.yz / a.x, onX ) * ${f(STAR_CELLS)};
	let cell = vec3f( floor( uv ), face );
	let h = skyHash13( cell );
	let bx = dot( dir, vec3f( ${f(MW.x)}, ${f(MW.y)}, ${f(MW.z)} ) ) * 4.0;
	let band = exp( - bx * bx );
	let has = h < band * 0.035 + 0.025;
	let uc = max( skyHash13( cell + 7.7 ), 2e-4 );
	let m = log2( uc ) * 0.602 + 6.5;
	let dark = 1.0 - smoothstep( -0.28, -0.1, ap.y );
	let vis = smoothstep( m - 0.6, m + 0.6, dark * 7.5 - 1.0 ) * select( 0.0, 1.0, has );
	let sp = ( floor( uv ) + vec2f( skyHash13( cell + 3.1 ), skyHash13( cell + 5.7 ) ) * 0.4 + 0.3 ) / ${f(STAR_CELLS)};
	let sdir = normalize( select( select( vec3f( sp, sign( dir.z ) ), vec3f( sp.x, sign( dir.y ), sp.y ), onY ), vec3f( sign( dir.x ), sp ), onX ) );
	let d = length( dir - sdir ) * ${f(STAR_CELLS)};
	let flux = pow( uc, -0.8 );
	let size = log2( flux ) * 0.08 + 1.0;
	let psf = exp( d * d / ( size * size ) * ${f(-0.5 / (STAR_SIGMA * STAR_SIGMA))} ) / ( size * size );
	let tw = sin( sp1.y * ( skyHash13( cell + 13.3 ) * 9.0 + 5.0 ) + h * 60.0 ) * mix( 0.18, 0.06, clamp( dir.y * 2.0, 0.0, 1.0 ) ) + 1.0;
	let col = mix( vec3f( 1.0, 0.8, 0.6 ), vec3f( 0.75, 0.85, 1.0 ), skyHash13( cell + 17.0 ) ) * 0.5 + 0.5;
	let star = col * ( psf * flux * vis * tw * 0.0075 );
	let glow = vec3f( 0.55, 0.6, 0.75 ) * ( band * dark * 0.0035 );
	return ( star + glow ) * sp0.w * smoothstep( 0.0, 0.2, dir.y );
}
fn skyMoonP( dir: vec3f, sp0: vec4f ) -> vec3f {
	let cosA = dot( dir, sp0.xyz );
	let ang = acos( clamp( cosA, -1.0, 1.0 ) );
	let r = ang / 0.0048;
	let mask = smoothstep( 1.0, 0.92, r );
	return vec3f( 0.9, 0.92, 1.0 ) * mask * 3.0 * sp0.w * smoothstep( -0.02, 0.02, dir.y );
}
fn skyMoonSkyP( dir: vec3f, sp0: vec4f, sp1: vec4f ) -> vec3f {
	let cosA = dot( dir, sp0.xyz );
	let ang = acos( clamp( cosA, -1.0, 1.0 ) );
	let aureole = exp( ang * -14.0 ) * 2.4 + exp( ang * -2.5 ) * 0.9;
	let grad = mix( 1.7, 1.0, clamp( dir.y * 3.0, 0.0, 1.0 ) );
	let up = smoothstep( -0.05, 0.15, sp0.y );
	return vec3f( 0.005, 0.0068, 0.0105 ) * ( grad + aureole ) * sp1.z * up;
}
// everything behind the clouds except the sun and moon disks
fn skyBackgroundP( dir: vec3f, starK: f32, ap: vec4f, sp0: vec4f, sp1: vec4f, svT: texture_2d<f32>, smp: sampler ) -> vec3f {
	var L = atmosphereSkyLuminanceP( dir, ap, svT, smp );
	if ( sp0.w > 0.001 ) {
		L += skyMoonSkyP( dir, sp0, sp1 ) + skyStarsP( dir, ap, sp0, sp1 ) * starK;
	}
	return L;
}
`);

// ------------------------------------------------------------------ bake-side state + medium
const CORE_WGSL = piFix(/* wgsl */`
// PORT: the uniform block as a private copy, filled by atLoad
struct AtmosphereParamsP {
	rayleighScale: f32, mieScale: f32, mieG: f32, ozoneScale: f32,
	groundAlbedo: vec3f, viewHeight: f32,
	sunIlluminance: vec3f,
	sunDir: vec3f,
};
var<private> atmosphereParams: AtmosphereParamsP;
fn atLoad( a0: vec4f, a1: vec4f, a2: vec4f, a3: vec4f ) -> f32 {
	atmosphereParams.rayleighScale = a0.x; atmosphereParams.mieScale = a0.y; atmosphereParams.mieG = a0.z; atmosphereParams.ozoneScale = a0.w;
	atmosphereParams.groundAlbedo = a1.xyz; atmosphereParams.viewHeight = a1.w;
	atmosphereParams.sunIlluminance = a2.xyz;
	atmosphereParams.sunDir = a3.xyz;
	return 1.0;
}
struct AtmosphereMedium {
	rayScat: vec3f,
	mieScat: f32,
	extinction: vec3f,
	scattering: vec3f,
};
fn atmosphereMedium( hKm: f32 ) -> AtmosphereMedium {
	let rayDensity = exp( - hKm / 8.0 );
	let mieDensity = exp( - hKm / 1.2 );
	let ozoneDensity = max( 0.0, 1.0 - abs( hKm - 25.0 ) / 15.0 );
	var m: AtmosphereMedium;
	m.rayScat = vec3f( 5.802e-3, 13.558e-3, 33.1e-3 ) * rayDensity * atmosphereParams.rayleighScale;
	m.mieScat = 3.996e-3 * mieDensity * atmosphereParams.mieScale;
	let mieExt = 4.440e-3 * mieDensity * atmosphereParams.mieScale;
	let ozoneAbs = vec3f( 0.650e-3, 1.881e-3, 0.085e-3 ) * ozoneDensity * atmosphereParams.ozoneScale;
	m.extinction = m.rayScat + mieExt + ozoneAbs;
	m.scattering = m.rayScat + m.mieScat;
	return m;
}
`);

// ------------------------------------------------------------------ the bakes (Atmosphere.js kernels, bodies verbatim)
const TRANS_FN = piFix(/* wgsl */`
fn atTransmittance( gate: f32, px: vec2u ) -> vec4f {
	let uv = ( vec2f( px ) + 0.5 ) / vec2f( ${f(T_W)}, ${f(T_H)} );
	let xMu = ( uv.x - ${f(0.5 / T_W)} ) * ${f(T_W / (T_W - 1))};
	let xR = ( uv.y - ${f(0.5 / T_H)} ) * ${f(T_H / (T_H - 1))};
	let H = sqrt( ATMO_RT * ATMO_RT - ATMO_RG * ATMO_RG );
	let rho = xR * H;
	let r = sqrt( rho * rho + ATMO_RG * ATMO_RG );
	let dMin = ATMO_RT - r;
	let dMax = rho + H;
	let d = dMin + xMu * ( dMax - dMin );
	let mu = clamp( select( ( H * H - rho * rho - d * d ) / ( 2.0 * r * d ), 1.0, d == 0.0 ), -1.0, 1.0 );
	let ro = vec3f( 0.0, r, 0.0 );
	let rd = vec3f( sqrt( max( 1.0 - mu * mu, 0.0 ) ), mu, 0.0 );
	let tMax = atmosphereRaySphereNearest( ro, rd, ATMO_RT );
	let steps = 40;
	let dt = tMax / f32( steps );
	var od = vec3f( 0.0 );
	for ( var i = 0; i < steps; i++ ) {
		let t = ( f32( i ) + 0.5 ) * dt;
		let p = ro + rd * t;
		let h = length( p ) - ATMO_RG;
		od += atmosphereMedium( h ).extinction * dt;
	}
	return vec4f( exp( - od ), 1.0 );
}`);

const MS_FN = piFix(/* wgsl */`
fn atMultiScat( gate: f32, px: vec2u, tT: texture_2d<f32>, smp: sampler ) -> vec4f {
	let uv = ( ( vec2f( px ) + 0.5 ) / ${f(MS_RES)} - ${f(0.5 / MS_RES)} ) * ${f(MS_RES / (MS_RES - 1))};
	let cosSun = uv.x * 2.0 - 1.0;
	let r = ATMO_RG + clamp( uv.y, 0.001, 0.999 ) * ( ATMO_RT - ATMO_RG );
	let sunDir = normalize( vec3f( 0.0, cosSun, - sqrt( max( 1.0 - cosSun * cosSun, 0.0 ) ) ) );
	let ro = vec3f( 0.0, r, 0.0 );
	var Lsum = vec3f( 0.0 );
	var fmsSum = vec3f( 0.0 );
	const SQ = 8;
	let isoPhase = 1.0 / ( 4.0 * PI );
	for ( var i = 0; i < SQ * SQ; i++ ) {
		let ii = ( f32( i % SQ ) + 0.5 ) / f32( SQ );
		let jj = ( f32( i / SQ ) + 0.5 ) / f32( SQ );
		let theta = ii * 2.0 * PI;
		let phi = acos( 1.0 - jj * 2.0 );
		let rd = vec3f( cos( theta ) * sin( phi ), cos( phi ), sin( theta ) * sin( phi ) );
		let tBottom = atmosphereRaySphereNearest( ro, rd, ATMO_RG );
		let tTop = atmosphereRaySphereNearest( ro, rd, ATMO_RT );
		let hitGround = tBottom > 0.0;
		let tMax = select( tTop, tBottom, hitGround );
		let steps = 20;
		let dt = tMax / f32( steps );
		var throughput = vec3f( 1.0 );
		var L = vec3f( 0.0 );
		var fms = vec3f( 0.0 );
		for ( var s = 0; s < steps; s++ ) {
			let t = ( f32( s ) + 0.3 ) * dt;
			let p = ro + rd * t;
			let pr = length( p );
			let m = atmosphereMedium( pr - ATMO_RG );
			let up = p / pr;
			let cosSunP = dot( up, sunDir );
			let Tsun = atmosphereSampleTransmittance( pr, cosSunP, tT, smp );
			let shadowT = atmosphereRaySphereNearest( p, sunDir, ATMO_RG );
			let earthShadow = select( 1.0, 0.0, shadowT > 0.0 );
			let S = Tsun * earthShadow * m.scattering * isoPhase;
			let Tstep = exp( - m.extinction * dt );
			let ext = max( m.extinction, vec3f( 1e-6 ) );
			L += throughput * ( S - S * Tstep ) / ext;
			fms += throughput * ( m.scattering - m.scattering * Tstep ) / ext;
			throughput *= Tstep;
		}
		if ( hitGround ) {
			let p = ro + rd * tMax;
			let up = normalize( p );
			let cosS = dot( up, sunDir );
			let Tsun = atmosphereSampleTransmittance( ATMO_RG, cosS, tT, smp );
			L += Tsun * throughput * max( cosS, 0.0 ) * atmosphereParams.groundAlbedo / PI;
		}
		Lsum += L * ( 4.0 * PI / f32( SQ * SQ ) );
		fmsSum += fms * ( 4.0 * PI / f32( SQ * SQ ) );
	}
	let Lin = Lsum * isoPhase;
	let fmsAvg = fmsSum * isoPhase;
	let Lms = Lin / ( vec3f( 1.0 ) - fmsAvg );
	return vec4f( Lms, 1.0 );
}`);

const SV_FN = piFix(/* wgsl */`
fn atSkyView( gate: f32, px: vec2u, tT: texture_2d<f32>, mT: texture_2d<f32>, smp: sampler ) -> vec4f {
	let uv = ( vec2f( px ) + 0.5 ) / vec2f( ${f(SV_W)}, ${f(SV_H)} );
	let u = ( uv.x - ${f(0.5 / SV_W)} ) * ${f(SV_W / (SV_W - 1))};
	let v = ( uv.y - ${f(0.5 / SV_H)} ) * ${f(SV_H / (SV_H - 1))};
	let viewH = atmosphereParams.viewHeight;
	let vHorizon = sqrt( max( viewH * viewH - ATMO_RG * ATMO_RG, 0.0 ) );
	let beta = acos( vHorizon / viewH );
	let zenithHorizonAngle = PI - beta;
	var vzA = 0.0;
	if ( v < 0.5 ) {
		var c = v * 2.0;
		c = 1.0 - c;
		c = c * c;
		c = 1.0 - c;
		vzA = zenithHorizonAngle * c;
	} else {
		var c = v * 2.0 - 1.0;
		c = c * c;
		vzA = zenithHorizonAngle + beta * c;
	}
	let cosViewZenith = cos( vzA );
	let sinViewZenith = sin( vzA );
	let cu = u * u;
	let lightViewCos = - ( cu * 2.0 - 1.0 );
	let lightViewSin = sqrt( max( 1.0 - lightViewCos * lightViewCos, 0.0 ) );
	let sunCosZ = atmosphereParams.sunDir.y;
	let sunSinZ = sqrt( max( 1.0 - sunCosZ * sunCosZ, 0.0 ) );
	let sunDir = vec3f( sunSinZ, sunCosZ, 0.0 );
	let rd = vec3f( sinViewZenith * lightViewCos, cosViewZenith, sinViewZenith * lightViewSin );
	let ro = vec3f( 0.0, viewH, 0.0 );
	let tBottom = atmosphereRaySphereNearest( ro, rd, ATMO_RG );
	let tTop = atmosphereRaySphereNearest( ro, rd, ATMO_RT );
	let tMax = select( tTop, tBottom, tBottom > 0.0 );
	let steps = 32;
	let cosTheta = dot( rd, sunDir );
	let rayPhase = ${f(3 / (16 * Math.PI))} * ( cosTheta * cosTheta + 1.0 );
	let g = atmosphereParams.mieG;
	let g2 = g * g;
	let miePhase = ${f(3 / (8 * Math.PI))} * ( ( 1.0 - g2 ) * ( cosTheta * cosTheta + 1.0 ) )
		/ ( ( g2 + 2.0 ) * pow( max( g2 + 1.0 - g * cosTheta * 2.0, 1e-4 ), 1.5 ) );
	var throughput = vec3f( 1.0 );
	var L = vec3f( 0.0 );
	for ( var i = 0; i < steps; i++ ) {
		let t0 = f32( i ) / f32( steps );
		let t1 = ( f32( i ) + 1.0 ) / f32( steps );
		let ta = t0 * t0 * tMax;
		let tb = t1 * t1 * tMax;
		let t = mix( ta, tb, 0.3 );
		let dt = tb - ta;
		let p = ro + rd * t;
		let pr = length( p );
		let m = atmosphereMedium( pr - ATMO_RG );
		let up = p / pr;
		let cosSunP = dot( up, sunDir );
		let Tsun = atmosphereSampleTransmittance( pr, cosSunP, tT, smp );
		let shadowT = atmosphereRaySphereNearest( p, sunDir, ATMO_RG );
		let earthShadow = select( 1.0, 0.0, shadowT > 0.0 );
		let ms = atmosphereSampleMultiScat( pr, cosSunP, mT, smp );
		let phaseScat = m.rayScat * rayPhase + vec3f( m.mieScat * miePhase );
		let S = Tsun * earthShadow * phaseScat + ms * m.scattering;
		let Tstep = exp( - m.extinction * dt );
		let ext = max( m.extinction, vec3f( 1e-6 ) );
		L += throughput * ( S - S * Tstep ) / ext;
		throughput *= Tstep;
	}
	return vec4f( L * atmosphereParams.sunIlluminance, 1.0 );
}`);

// irradiance kernel, one entry per output: 0 sky irradiance (E / PI), 1 sea-level sun transmittance, 2 horizon
const IRR_FN = piFix(/* wgsl */`
fn atIrradiance( which: u32, ap: vec4f, tT: texture_2d<f32>, svT: texture_2d<f32>, smp: sampler ) -> vec4f {
	if ( which == 0u ) {
		var sum = vec3f( 0.0 );
		const N = 16;
		for ( var i = 0; i < N * N; i++ ) {
			let a = ( f32( i % N ) + 0.5 ) / f32( N );
			let b = ( f32( i / N ) + 0.5 ) / f32( N );
			let r = sqrt( b );
			let phi = a * 2.0 * PI;
			let dir = vec3f( r * cos( phi ), sqrt( max( 1.0 - b, 0.0 ) ), r * sin( phi ) );
			sum += atmosphereSkyLuminanceP( dir, ap, svT, smp );
		}
		return vec4f( sum / f32( N * N ), 1.0 );
	}
	if ( which == 1u ) {
		return vec4f( atmosphereSampleTransmittance( ATMO_RG + 0.001, ap.y, tT, smp ), 1.0 );
	}
	var hs = vec3f( 0.0 );
	for ( var i = 0; i < 16; i++ ) {
		let phi = f32( i ) * ( 2.0 * PI / 16.0 );
		hs += atmosphereSkyLuminanceP( normalize( vec3f( cos( phi ), 0.03, sin( phi ) ) ), ap, svT, smp );
	}
	return vec4f( hs / 16.0, 1.0 );
}`);

// the dome (Sky.js skyRadiance / skyRadianceWithClouds without the clouds; the caller composites them)
const RADIANCE_FN = /* wgsl */`
fn skyRadianceP( dir: vec3f, withSun: f32, starK: f32, ap: vec4f, sp0: vec4f, sp1: vec4f,
	tT: texture_2d<f32>, svT: texture_2d<f32>, smp: sampler ) -> vec3f {
	var L = skyBackgroundP( dir, starK, ap, sp0, sp1, svT, smp );
	if ( withSun > 0.5 ) { L += skyMoonP( dir, sp0 ) + skySunDiskP( dir, ap, sp1, tT, smp ); }
	return L;
}`;

/**
 * @param {object} o
 * @param {THREE.WebGPURenderer} o.renderer
 */
export function createSkyProAtmosphere({ renderer }) {
  const lut = (w, h, name) => {
    const t = new THREE.StorageTexture(w, h);
    t.type = THREE.HalfFloatType;
    t.minFilter = t.magFilter = THREE.LinearFilter;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.generateMipmaps = false;
    t.name = name;
    return t;
  };
  const transmittanceLUT = lut(T_W, T_H, "skypro transmittance");
  const multiScatLUT = lut(MS_RES, MS_RES, "skypro multiscat");
  const skyViewLUT = lut(SV_W, SV_H, "skypro sky view");
  const irradianceTex = lut(4, 1, "skypro irradiance"); // 0 sky E/PI, 1 sun T at sea level, 2 horizon
  irradianceTex.minFilter = irradianceTex.magFilter = THREE.NearestFilter;
  const irrBuf = instancedArray(4, "vec4"); // the same three, for the CPU

  // Tidewater's AtmosphereParams, as JS (the three-style { value } handles keep its names)
  const params = {
    rayleighScale: 1, mieScale: 1, mieG: 0.8, ozoneScale: 1,
    groundAlbedo: [0.06, 0.08, 0.1],
    sunIlluminance: SUN_ILLUMINANCE,
  };
  const uA = [0, 1, 2, 3].map(() => uniform(new THREE.Vector4())); // bake params (atLoad)
  const uAP = uniform(new THREE.Vector4(0, 1, 0, RG_KM + 0.002)); // ( real sun dir, view height km )
  const uSP0 = uniform(new THREE.Vector4(-0.3, 0.5, 0.8, 0)); // ( moon dir, star intensity )
  const uSP1 = uniform(new THREE.Vector4(1, 0, 0, 0)); // ( sun disc intensity, time, night, - )

  const code = wgsl(SAMPLE_WGSL);
  const core = wgsl(CORE_WGSL, [code]);
  const gate = wgslFn(`fn atLoadCall( a0: vec4f, a1: vec4f, a2: vec4f, a3: vec4f ) -> f32 { return atLoad( a0, a1, a2, a3 ); }`, [core]);
  const g = () => gate(...uA);

  const tNode = texture(transmittanceLUT), mNode = texture(multiScatLUT), svNode = texture(skyViewLUT);
  const smp = sampler(tNode); // linear clamp (every LUT is linear clamp)

  const transFn = wgslFn(TRANS_FN, [core]);
  const msFn = wgslFn(MS_FN, [core]);
  const svFn = wgslFn(SV_FN, [core]);
  const irrFn = wgslFn(IRR_FN, [code]);
  const radFn = wgslFn(RADIANCE_FN, [code]);
  const lumFn = wgslFn(`fn atSkyLum( dir: vec3f, ap: vec4f, svT: texture_2d<f32>, smp: sampler ) -> vec3f { return atmosphereSkyLuminanceP( normalize( dir ), ap, svT, smp ); }`, [code]);
  const sunFn = wgslFn(`fn atSunDisk( dir: vec3f, ap: vec4f, sp1: vec4f, tT: texture_2d<f32>, smp: sampler ) -> vec3f { return skySunDiskP( normalize( dir ), ap, sp1, tT, smp ); }`, [code]);
  const moonFn = wgslFn(`fn atMoon( dir: vec3f, sp0: vec4f ) -> vec3f { return skyMoonP( normalize( dir ), sp0 ); }`, [code]);
  const bgFn = wgslFn(`fn atBackground( dir: vec3f, starK: f32, ap: vec4f, sp0: vec4f, sp1: vec4f, svT: texture_2d<f32>, smp: sampler ) -> vec3f { return skyBackgroundP( normalize( dir ), starK, ap, sp0, sp1, svT, smp ); }`, [code]);
  const transCpuFn = wgslFn(`fn atTransToSpace( dir: vec3f, ap: vec4f, tT: texture_2d<f32>, smp: sampler ) -> vec3f { return atmosphereSampleTransmittance( ap.w, normalize( dir ).y, tT, smp ); }`, [code]);

  const inside = (id, w, h) => id.x.lessThan(uint(w)).and(id.y.lessThan(uint(h)));
  const transPass = Fn(() => {
    const id = globalId.xy;
    If(inside(id, T_W, T_H), () => { textureStore(transmittanceLUT, id, transFn(g(), id)); });
  })().compute([T_W / 8, T_H / 8, 1], [8, 8, 1]).setName("SkyPro Transmittance");
  const msPass = Fn(() => {
    const id = globalId.xy;
    If(inside(id, MS_RES, MS_RES), () => { textureStore(multiScatLUT, id, msFn(g(), id, tNode, smp)); });
  })().compute([MS_RES / 8, MS_RES / 8, 1], [8, 8, 1]).setName("SkyPro MultiScat");
  const svPass = Fn(() => {
    const id = globalId.xy;
    If(inside(id, SV_W, SV_H), () => { textureStore(skyViewLUT, id, svFn(g(), id, tNode, mNode, smp)); });
  })().compute([SV_W / 8, Math.ceil(SV_H / 8), 1], [8, 8, 1]).setName("SkyPro SkyView");
  const irrPass = Fn(() => {
    for (let k = 0; k < 3; k++) {
      const v = irrFn(uint(k), uAP, tNode, svNode, smp).toVar();
      textureStore(irradianceTex, uvec2(k, 0), v);
      irrBuf.element(k).assign(v);
    }
  })().compute([1, 1, 1], [1, 1, 1]).setName("SkyPro Irradiance");

  // ---- CPU mirror of the transmittance bake (Tidewater's medium, 40 steps, km)
  function transmittanceCPU(r, muIn, out = [0, 0, 0]) {
    const RT = RT_KM, RG = RG_KM;
    // The LUT's parameterisation clamps below-horizon directions to the horizon (the ground is NOT
    // an occluder in it — the earth's shadow is a separate term in the sky bake), so the mirror does too.
    const muHorizon = -Math.sqrt(Math.max(0, 1 - (RG * RG) / (r * r)));
    const mu = Math.min(1, Math.max(muIn, muHorizon));
    // ray from (0, r, 0) along (sqrt(1-mu^2), mu, 0) to the top of the atmosphere
    const b = r * mu, c = r * r - RT * RT, d2 = b * b - c;
    const tMax = d2 < 0 ? 0 : -b + Math.sqrt(d2);
    const steps = 40, dt = tMax / steps;
    const sx = Math.sqrt(Math.max(1 - mu * mu, 0));
    let o0 = 0, o1 = 0, o2 = 0;
    for (let i = 0; i < steps; i++) {
      const t = (i + 0.5) * dt;
      const px = sx * t, py = r + mu * t;
      const h = Math.hypot(px, py) - RG;
      const ray = Math.exp(-h / 8) * params.rayleighScale;
      const mie = 4.44e-3 * Math.exp(-h / 1.2) * params.mieScale;
      const oz = Math.max(0, 1 - Math.abs(h - 25) / 15) * params.ozoneScale;
      o0 += (5.802e-3 * ray + mie + 0.650e-3 * oz) * dt;
      o1 += (13.558e-3 * ray + mie + 1.881e-3 * oz) * dt;
      o2 += (33.1e-3 * ray + mie + 0.085e-3 * oz) * dt;
    }
    out[0] = Math.exp(-o0); out[1] = Math.exp(-o1); out[2] = Math.exp(-o2);
    return out;
  }

  // ---- state
  let needsStatic = true, svValid = false;
  const svLast = new Float32Array(16);
  let irrTimer = 0, irrPending = false;
  const api = {
    params,
    /** read back every 0.25 s (null until the first): sky irradiance (E / PI), sea-level sun transmittance, horizon */
    skyIrradiance: null, sunTransmittance: null, horizon: null,
    textures: { transmittance: transmittanceLUT, multiScat: multiScatLUT, skyView: skyViewLUT, irradiance: irradianceTex },
    /** the shared stateless WGSL (include it: wgslFn(..., [atmo.code])) and its inputs */
    code, uniforms: { ap: uAP, sp0: uSP0, sp1: uSP1 }, nodes: { transmittance: tNode, skyView: svNode, multiScat: mNode, sampler: smp },
    // ---- TSL
    /** sky luminance toward dir (no sun or moon disc) — Tidewater atmosphereSkyLuminance */
    skyLuminance: (dir) => lumFn(dir, uAP, svNode, smp),
    /** everything behind the clouds but the discs (starK: 1 view, STAR_REFLECTION for reflections) */
    skyBackground: (dir, starK = float(1)) => bgFn(dir, starK, uAP, uSP0, uSP1, svNode, smp),
    /** Sky.js skyRadiance( dir, withSun ): sky + moon + sun disc (withSun 1) or the sky alone (0) */
    skyRadiance: (dir, withSun = float(1), starK = float(1)) => radFn(dir, withSun, starK, uAP, uSP0, uSP1, tNode, svNode, smp),
    sunDisk: (dir) => sunFn(dir, uAP, uSP1, tNode, smp),
    moon: (dir) => moonFn(dir, uSP0),
    transmittanceToSpace: (dir) => transCpuFn(dir, uAP, tNode, smp),
    transmittanceCPU,
    /** the sun's illuminance at altitude altM (m) for a sun elevation cosine mu: Tidewater's sunColor / scDirect */
    sunColorAt(altM, mu, out = [0, 0, 0]) {
      transmittanceCPU(RG_KM + Math.max(0.001, altM / 1000), mu, out);
      out[0] *= params.sunIlluminance; out[1] *= params.sunIlluminance; out[2] *= params.sunIlluminance;
      return out;
    },
    viewHeightKm: () => uAP.value.w,
    /** TSL: the sky irradiance E / PI (radiance units; Tidewater frame.skyIrradiance, day part) and the horizon colour */
    irradianceNode: texture(irradianceTex).sample(vec2(0.125, 0.5)).level(0).rgb,
    horizonNode: texture(irradianceTex).sample(vec2(0.625, 0.5)).level(0).rgb,
    update,
    invalidate() { needsStatic = true; svValid = false; },
    passes: { transPass, msPass, svPass, irrPass },
  };

  /**
   * Per frame (Tidewater Atmosphere.update + Sky's uniforms).
   * @param {object} o  dt, cameraY (m), sunDir (the REAL sun, may be below the horizon), moonDir,
   *                    starIntensity (0..1), night (0..1), time (s), sunDiskIntensity (1)
   */
  function update(o) {
    const y = Math.max(0.5, (o.cameraY ?? 0) + 0.5);
    const yq = y < 100 ? Math.round(y / 2) * 2 : Math.exp(Math.round(Math.log(y) / LOG_STEP) * LOG_STEP);
    const viewH = RG_KM + Math.max(0.001, yq / 1000);
    const s = o.sunDir;
    uA[0].value.set(params.rayleighScale, params.mieScale, params.mieG, params.ozoneScale);
    uA[1].value.set(params.groundAlbedo[0], params.groundAlbedo[1], params.groundAlbedo[2], viewH);
    uA[2].value.set(params.sunIlluminance, params.sunIlluminance, params.sunIlluminance, 0);
    uA[3].value.set(s.x, s.y, s.z, 0);
    uAP.value.set(s.x, s.y, s.z, viewH);
    if (o.moonDir) uSP0.value.set(o.moonDir.x, o.moonDir.y, o.moonDir.z, o.starIntensity ?? 0);
    uSP1.value.set(o.sunDiskIntensity ?? 1, o.time ?? 0, o.night ?? 0, 0);

    let dirty = false;
    if (needsStatic) {
      needsStatic = false;
      dirty = true;
      renderer.compute(transPass);
      renderer.compute(msPass);
    }
    // the sky view only when a parameter changed (sun, height, scattering)
    const cur = [...uA[0].value.toArray(), ...uA[1].value.toArray(), ...uA[2].value.toArray(), ...uA[3].value.toArray()];
    for (let i = 0; i < 16 && !dirty; i++) dirty = cur[i] !== svLast[i];
    if (dirty || !svValid) {
      svLast.set(cur);
      svValid = true;
      renderer.compute(svPass);
    }
    // irradiance: every 0.25 s, read back for the CPU (lights, fog colour)
    irrTimer -= o.dt ?? 0;
    if (irrTimer <= 0 && !irrPending) {
      irrTimer = 0.25;
      renderer.compute(irrPass);
      irrPending = true;
      renderer.getArrayBufferAsync(irrBuf.value).then((buf) => {
        const fl = new Float32Array(buf);
        api.skyIrradiance = [fl[0], fl[1], fl[2]];
        api.sunTransmittance = [fl[4], fl[5], fl[6]];
        api.horizon = [fl[8], fl[9], fl[10]];
        irrPending = false;
      }).catch(() => { irrPending = false; });
    }
  }

  return api;
}
