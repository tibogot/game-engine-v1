// OCEAN PRO — spray from the breakers (part of the "pro" ocean mode, v3/render/oceanpro/).
// Port of Tidewater's fx/Spray.js (MIT, Copyright (c) 2026 DRG Software Solutions LLC — see
// v3/skypro-real/tidewater/LICENSE). The WGSL is Tidewater's; changes are marked `// PORT:`.
//
// GPU spray particles: drops, ligaments, dense spray and mist. One ring of particles written by the
// breaking waves (the crest finder, oceanproBreakers.js) through an atomic head. Particles are
// integrated with gravity + drag toward the air around them (the wind; for mist first the air pushed
// along by the wave) and die when they fall back into the water or onto the sand.
//
// Rendering (soft camera-facing sprites):
//  * drops and ligaments are clear water: sub-pixel drops are drawn as motion-blurred streaks whose
//    opacity conserves the drop's cross-section, so their visual weight is the amount of water; they
//    show the bright sky they refract, a tiny sun glint, and light up strongly when backlit
//  * dense spray (clouds of drops) is white from every side (multiple scattering), with a forward
//    lobe and its own shadow on the far side
//  * mist is a thin, strongly forward-scattering, sky-tinted veil
//  * all of it is darkened in the shadow of the wave that made it and of the clouds
//
// PORT:
//  - the particle state lives in two float textures three owns (ping-pong: rgba32float storage
//    textures can't be read_write), 3 texels per particle ( pos + age, vel + radius, kind + life +
//    water height + tag ), 256 particles per row. The emitters write into the current one, the update
//    reads it and writes the other, the sprites read the result. Raw WebGPU compute on three's device.
//  - GPU emitters only: no CPU emit API (boat spray, splashes), no body collisions, no clear sheets
//  - soft intersections: against the water / sand height under the particle (no scene depth copy)
//  - no foam deposit into the shore simulation where drops fall back in
//  - the water height a particle meets: sea level + the shore waves + the short FFT cascades at its
//    point (Tidewater's water query)
//  - blending: the premultiplied output ( col * a, a ) is handed to three as straight alpha

import * as THREE from "three/webgpu";
import { Fn, uniform, texture, sampler, instanceIndex, positionGeometry, varyingProperty, wgsl, wgslFn, screenSize } from "three/tsl";
import { shoreCode } from "./oceanproShore.js";
import { SHARED_WGSL, threeWgsl } from "./oceanproShader.js";

const GRAVITY = 9.81;
const ROW = 256; // particles per texture row
const NG = 32768; // ring size (power of two: the index wraps with the uint head)
const ROWS = NG / ROW;

// per-kind constants: droplet (a drop of a few mm, ballistic), mist (fine drops that follow the air),
// ligament (an elongated blob of water, ~1-2 cm, torn off a sheet or jet), spray (a cloud of drops:
// the white of splashes), sheet (unused here: a boat's bow sheet)
const KIND = {
  tau: [3.0, 0.35, 5.0, 1.8, 2.5], // drag time constant toward the air velocity (s): ~ drop size^2
  grav: [GRAVITY, 0.3, GRAVITY, 8.5, GRAVITY], // effective gravity (mist barely settles; torn sheets fall back)
  turb: [0, 0.5, 0, 0.3, 0.1], // turbulent wander (m/s^2, zero mean)
  grow: [0, 0.22, 0, 0.3, 0.7], // size growth (1/s)
  dies: [1, 0, 1, 1, 1], // killed when falling into the water (else skims over it)
  stretch: [1 / 40, 0, 1 / 40, 1 / 30, 1 / 60], // motion blur (s of travel)
  alpha: [0.55, 0.06, 0.8, 0.66, 0.22], // (dense spray: see-through, streaked by its motion, never cotton wool)
  fadeIn: [0.02, 0.2, 0.02, 0.12, 0.02], // (dense spray blooms out of the splash instead of popping in)
  fadeOut: [0.8, 0.45, 0.8, 0.7, 0.5], // fraction of life when it starts to fade
};

const fl = (x) => {
  const s = String(x);
  return /[.e]/.test(s) ? s : s + ".0";
};
// select a per-kind constant (WGSL expression)
const byKind = (kind, arr) => `sprayByKind( ${kind}, ${arr.map(fl).join(", ")} )`;

// helpers shared by the kernels and the sprite material (no bindings)
const SPRAY_COMMON = /* wgsl */`
const SPRAY_DROPLET: f32 = 0.0;
const SPRAY_MIST: f32 = 1.0;
const SPRAY_LIGAMENT: f32 = 2.0;
const SPRAY_SPRAY: f32 = 3.0;
const SPRAY_SHEET: f32 = 4.0;
const SPRAY_NG: u32 = ${NG}u;

// PCG hash of a uint -> [0, 1)
fn sprayHash( seed: u32 ) -> f32 {
	let state = seed * 747796405u + 2891336453u;
	let word = ( ( state >> ( ( state >> 28u ) + 4u ) ) ^ state ) * 277803737u;
	return f32( ( word >> 22u ) ^ word ) * ( 1.0 / 4294967296.0 );
}

// select a per-kind constant
fn sprayByKind( kind: f32, a: f32, b: f32, c: f32, d: f32, e: f32 ) -> f32 {
	return select( select( select( select( e, d, kind < 3.5 ), c, kind < 2.5 ), b, kind < 1.5 ), a, kind < 0.5 );
}

// Henyey-Greenstein phase (1/sr)
fn sprayPhaseHG( cosT: f32, g: f32 ) -> f32 {
	let g2 = g * g;
	return ( ( 1.0 - g2 ) / ( 4.0 * PI ) ) / pow( max( 1.0 + g2 - 2.0 * g * cosT, 1e-4 ), 1.5 );
}

// PORT: texel k (0: pos + age, 1: vel + radius, 2: kind + life + water height + tag) of particle i
fn sprayTexel( i: u32, k: u32 ) -> vec2u {
	return vec2u( ( i & ${ROW - 1}u ) * 3u + k, i >> ${Math.log2(ROW)}u );
}
`;

/**
 * The emitter API for the crest finder (its bindings `head` and `target` come after its own).
 * WGSL: sprayReserve( n ) -> base, spraySlot( base, i ), sprayWrite( slot, p, v, size, kind, life, seed ),
 * sprayRand( a, b ); `sprayFrameSeed` (var<private>) is set by the kernel from its uniforms.
 */
export function sprayEmitterWGSL(headBinding, targetBinding) {
  return /* wgsl */`
${SPRAY_COMMON}
@group( 0 ) @binding( ${headBinding} ) var<storage, read_write> sprayHead: array<atomic<u32>>;
@group( 0 ) @binding( ${targetBinding} ) var sprayTarget: texture_storage_2d<rgba32float, write>;
var<private> sprayFrameSeed: u32;

// Reserve n ring slots; returns the base (pass it to spraySlot)
fn sprayReserve( n: u32 ) -> u32 { return atomicAdd( &sprayHead[ 0 ], n ); }
fn spraySlot( base: u32, i: u32 ) -> u32 { return ( base + i ) & ( SPRAY_NG - 1u ); }

fn sprayWrite( slot: u32, p: vec3f, v: vec3f, size: f32, kind: f32, life: f32, seed: f32 ) {
	textureStore( sprayTarget, sprayTexel( slot, 0u ), vec4f( p, 0.0 ) );
	textureStore( sprayTarget, sprayTexel( slot, 1u ), vec4f( v, size ) );
	textureStore( sprayTarget, sprayTexel( slot, 2u ), vec4f( kind, life, p.y, seed ) );
}

fn sprayRand( a: u32, b: u32 ) -> f32 {
	return sprayHash( a + b * 1664525u + sprayFrameSeed * 2654435761u );
}
`;
}

// ------------------------------------------------------------------ the update (raw compute)

function updateKernelCode(fftDisp) {
  return /* wgsl */`
const PI: f32 = 3.141592653589793;
fn sat( x: f32 ) -> f32 { return clamp( x, 0.0, 1.0 ); }
struct OpFrame { seaLevel: f32, time: f32, dt: f32, terrainSize: f32, maxHeight: f32, heightBase: f32, zenith: f32, pad: f32, windDir: vec2f, windSpeed: f32 };
var<private> frame: OpFrame;
// U0 ( seaLevel, time, dt, terrainSize )  U1 ( maxHeight, heightBase, flip, amplitude )  U2..U4 shore
// U5 ( windDir, windSpeed, - )
@group( 0 ) @binding( 0 ) var<uniform> U: array<vec4f, 6>;
@group( 0 ) @binding( 1 ) var terrainHeight: texture_2d<f32>;
@group( 0 ) @binding( 2 ) var shoreTex: texture_2d<f32>;
@group( 0 ) @binding( 3 ) var oceanDisplacement: texture_2d_array<f32>;
@group( 0 ) @binding( 4 ) var smpLinearRepeat: sampler;
@group( 0 ) @binding( 5 ) var stateIn: texture_2d<f32>;
@group( 0 ) @binding( 6 ) var stateOut: texture_storage_2d<rgba32float, write>;
${SHARED_WGSL}
${shoreCode()}
${SPRAY_COMMON}

fn sprayFftDisp( p: vec2f, depth: f32 ) -> vec3f {
	var d = vec3f( 0.0 );
${fftDisp}	return d * U[ 1 ].w;
}

// PORT: Tidewater's waterQueryHeightAtXZ: the sea level, the shore waves and the short FFT cascades
fn sprayWaterHeight( xz: vec2f, ground: f32 ) -> f32 {
	let depth = frame.seaLevel - ground;
	var h = frame.seaLevel + sprayFftDisp( xz, max( depth, 0.0 ) ).y;
	if ( depth > -2.0 && depth < 26.0 && shoreP.enabled > 0.0 ) {
		let sw = shoreEvaluateNoNormal( xz, depth, ground, terrainHeight, shoreTex );
		h += sw.disp.y;
		if ( sw.swashCovered > 0.5 ) { h = max( h, sw.swashLevel ); }
	}
	return h;
}

@compute @workgroup_size( 64, 1, 1 )
fn main( @builtin( global_invocation_id ) gid: vec3u ) {
	let i = gid.x;
	if ( i >= SPRAY_NG ) { return; }
	frame.seaLevel = U[ 0 ].x; frame.time = U[ 0 ].y; frame.dt = U[ 0 ].z; frame.terrainSize = U[ 0 ].w;
	frame.maxHeight = U[ 1 ].x; frame.heightBase = U[ 1 ].y; frame.zenith = U[ 1 ].z;
	frame.windDir = U[ 5 ].xy; frame.windSpeed = U[ 5 ].z;
	shoreLoad( U[ 2 ], U[ 3 ], U[ 4 ] );

	let t0 = sprayTexel( i, 0u );
	let t1 = sprayTexel( i, 1u );
	let t2 = sprayTexel( i, 2u );
	let info = textureLoad( stateIn, t2, 0 );
	// (a dead slot only needs its life: the emitters write all three texels)
	if ( info.y <= 0.0 ) {
		textureStore( stateOut, t2, vec4f( 0.0 ) );
		return;
	}
	let P = textureLoad( stateIn, t0, 0 );
	let Vv = textureLoad( stateIn, t1, 0 );
	let dt = frame.dt;
	var p = P.xyz;
	var v = Vv.xyz;
	let age = P.w + dt;
	let kind = info.x;

	// wind near the surface (~70% of the 10 m wind), gusty
	let gust = sin( frame.time * 0.7 + p.x * 0.05 ) * 0.25 + 0.85;
	let wind = vec3f( frame.windDir.x, 0.0, frame.windDir.y ) * ( frame.windSpeed * 0.7 * gust );
	// drag toward the wind: small drops follow the air, mist drifts with it
	// mist first keeps moving with the air the wave pushes ahead of it, then joins the wind
	let isMist = kind > 0.5 && kind < 1.5;
	let tau = ${byKind("kind", KIND.tau)} * select( 1.0, exp( age * - 1.2 ) * 4.0 + 1.0, isMist );
	let grav = ${byKind("kind", KIND.grav)};
	let turb = vec3f(
		sin( age * 2.1 + fract( info.w ) * 40.0 ),
		sin( age * 1.7 + fract( info.w ) * 17.0 ) * 0.5,
		cos( age * 1.9 + fract( info.w ) * 29.0 ) ) * ${byKind("kind", KIND.turb)};
	v += ( ( wind - v ) / tau + turb ) * dt;
	v.y -= grav * dt;
	p += v * dt;

	var life = info.y;

	// water surface and ground below
	let ground = terrainHeightAt( p.xz, terrainHeight );
	let hw = sprayWaterHeight( p.xz, ground );
	let top = max( hw, ground );

	// drops die in the water / on the sand; mist and foam skim over it
	if ( p.y < top && v.y < 0.0 && age > 0.04 ) {
		if ( ${byKind("kind", KIND.dies)} > 0.5 ) {
			life = 0.0;
		} else {
			p.y = top + 0.02;
			v.y = max( v.y, 0.0 );
			v = vec3f( v.x * 0.95, v.y, v.z * 0.95 );
		}
	}

	if ( age > life ) { life = 0.0; }

	// mist and spray clouds grow as they dilute
	let size = Vv.w * ( 1.0 + dt * ${byKind("kind", KIND.grow)} );
	textureStore( stateOut, t0, vec4f( p, age ) );
	textureStore( stateOut, t1, vec4f( v, size ) );
	textureStore( stateOut, t2, vec4f( info.x, life, top, info.w ) );
}
`;
}

// ------------------------------------------------------------------ the sprites (three material)

// PORT: Tidewater's sprite vertex / output snippets as functions; the state and crest textures,
// the terrain and the cloud shadow as parameters. Vertex result columns:
//   ( world position, half-width in pixels ) vCol ( radiance, opacity ) vMisc ( kind + life, water /
//   sand height, size, seed ) ( forward-scattered sun, - )
const SPRAY_RENDER = /* wgsl */`
${SPRAY_COMMON}

// Sun visibility (0..1) for a spray particle made by one of the crests (Tidewater's
// breakersSprayShadow): in front of the wave with the sun behind it (a beach view into the sun) the
// particles below the crest line are in the shadow of the wave (and of the overhanging lip while it
// plunges). seedTag: the particle's tag. PORT: the crest record from the crest texture.
fn spraySprayShadow( p: vec3f, seedTag: f32, crest: texture_2d<f32> ) -> f32 {
	var out = 1.0;
	let idx = floor( seedTag ) - 1.0;
	if ( idx >= 0.0 && idx < f32( textureDimensions( crest ).y * 2u ) ) {
		let st = i32( u32( idx ) >> 1u );
		let e = i32( ( u32( idx ) & 1u ) * 3u );
		let c0 = textureLoad( crest, vec2i( e, st ), 0 );
		let c1 = textureLoad( crest, vec2i( e + 1, st ), 0 );
		let c2 = textureLoad( crest, vec2i( e + 2, st ), 0 );
		let L = frame.sunDir;
		let d2 = c2.xy;
		let Ld = dot( L.xz, d2 ); // < 0: the sun is on the sea side of the wave
		if ( c2.w > 0.5 && Ld < -0.02 ) {
			let root = c0.xyz;
			let b = c0.w;
			let H = c1.w;
			let q = clamp( b / 0.9, 0.0, 1.0 ) * ( 1.0 - smoothstep( 1.0, 1.3, b ) );
			// vertical plane through the crest (moved forward under the overhanging lip)
			let plane = root.xz + d2 * ( H * 0.8 * q * 0.6 );
			let s = dot( p.xz - plane, d2 ); // > 0: in front of it
			let tau = s / - Ld;
			let yRay = p.y + L.y * tau; // height of the ray toward the sun where it crosses the plane
			let top = root.y + 0.05;
			let shade = smoothstep( top, top - 0.4, yRay ) * smoothstep( -0.1, 0.1, s ) * smoothstep( 14.0, 6.0, s );
			out = 1.0 - shade * 0.55;
		}
	}
	return out;
}

fn opSprayVertex( gate: f32, inst: u32, corner: vec2f, state: texture_2d<f32>, crest: texture_2d<f32>,
	terrainHeight: texture_2d<f32>, cloudShadow: texture_2d<f32>, resolution: vec2f, intensity: f32, maxDistance: f32 ) -> mat4x4f {
	let info = textureLoad( state, vec2i( sprayTexel( inst, 2u ) ), 0 );
	let dead = mat4x4f( vec4f( 0.0, -1e5, 0.0, 0.0 ), vec4f( 0.0 ), vec4f( 0.0 ), vec4f( 0.0 ) );
	if ( info.y <= 0.0 ) { return dead; }
	let posA = textureLoad( state, vec2i( sprayTexel( inst, 0u ) ), 0 );
	let velA = textureLoad( state, vec2i( sprayTexel( inst, 1u ) ), 0 );
	let p = posA.xyz;
	let age = posA.w;
	let vel = velA.xyz;
	let kind = info.x;
	let life = info.y;
	let isDrop = kind < 0.5;
	let isLig = kind > 1.5 && kind < 2.5;
	let isMist = kind > 0.5 && kind < 1.5;
	let water = isDrop || isLig; // clear water: drops and ligaments
	let alive = life > 0.0 && age < life;

	let toCam = frame.cameraPos - p;
	let dist = max( length( toCam ), 0.05 );
	let Vd = toCam / dist;

	// pixel footprint at this distance: drops are drawn at least ~1.3 px wide
	let p11 = frame.proj[ 1 ][ 1 ];
	let pixel = dist * 2.0 / ( p11 * resolution.y );
	let r0 = velA.w; // radius (m)
	// dense spray is thrown out of the splash as a compact mass and spreads (grows from ~half size)
	let tAge = age / max( life, 1e-3 );
	let r = select( r0, r0 * mix( 0.45, 1.0, smoothstep( 0.0, 0.25, tAge ) ), kind > 2.5 && kind < 3.5 );
	let size = max( r, pixel * 1.3 );

	// motion blur along the velocity projected on the view plane; ligaments are elongated anyway
	let vPerp = vel - Vd * dot( vel, Vd );
	let speed = length( vPerp );
	let stretchLen = speed * ${byKind("kind", KIND.stretch)};
	let elong = select( 0.0, r * 2.0, isLig );
	let up = select( vec3f( 0.0, 1.0, 0.0 ), vPerp / max( speed, 1e-3 ), speed > 1e-3 );
	// clouds: random rotation that slowly turns
	let rot = fract( info.w ) * 6.283 + age * ( fract( info.w ) - 0.5 );
	let camRight = normalize( cross( vec3f( 0.0, 1.0, 0.0 ), Vd ) + vec3f( 1e-5, 0.0, 0.0 ) );
	let camUp = cross( Vd, camRight );
	let mRight = camRight * cos( rot ) + camUp * sin( rot );
	let mUp = camUp * cos( rot ) - camRight * sin( rot );
	// torn sheets (dense spray) are drawn along their motion too, tilted a little at random and
	// stretched by their speed: fibrous, streaked silhouettes instead of round puffs
	let isSheet = kind > 2.5;
	let isClear = kind > 3.5; // clear sheet (bow sheet)
	let side = normalize( cross( Vd, up ) );
	let tilt = ( fract( info.w * 7.31 ) - 0.5 ) * 0.7;
	let sUp = up * cos( tilt ) + side * sin( tilt );
	let sSide = side * cos( tilt ) - up * sin( tilt );
	// mist streams with the air: drawn along its motion, stretched by its speed (wisps, not discs)
	let alongMotion = isSheet || ( isMist && speed > 0.3 );
	let axisY = select( select( mUp, sUp, alongMotion ), up, water );
	let axisX = select( select( mRight, sSide, alongMotion ), side, water );
	let sheetLen = select( 0.0, size * clamp( speed * 0.08, 0.0, 0.8 ), isSheet );
	let mistLen = select( 0.0, size * clamp( ( speed - 0.3 ) * 0.35, 0.0, 1.4 ), isMist );
	let halfY = size + stretchLen * 0.5 + elong + sheetLen + mistLen;
	let halfX = select( size, size * 1.05, isSheet );
	let world = p + axisX * ( corner.x * halfX ) + axisY * ( corner.y * halfY );

	// coverage that conserves the water's cross-section: the drop's projected area (and the time it
	// spends on each pixel of its streak) spread over the drawn footprint. For the gaussian
	// footprint exp( -k d^2 ) the peak is k r (r + elong) / ( halfX halfY ). Clouds: lost to the clamp.
	let kShape = select( 3.5, 4.5, isLig );
	let cover = select( sat( r / size ), min( r * ( r + elong ) * kShape / ( halfX * halfY ), 1.0 ), water );

	// ---- lighting (per particle)
	let L = frame.sunDir;
	let cosT = dot( - Vd, L ); // 1 = looking toward the sun through the particle
	let cosA = dot( Vd, L );
	let sunVis = cloudsShadow( p.xz, cloudShadow ) * spraySprayShadow( p, info.w, crest );
	let sun = frame.sunColor * sunVis;
	// clear water (drop, ligament): the bright sky it refracts and reflects, a strong forward lobe
	// (diffraction + refraction) when backlit, a small glint from any side
	let cWater = frame.skyIrradiance * 0.9 + sun * ( sprayPhaseHG( cosT, 0.85 ) * 1.2 + 0.12 );
	// dense spray: multiply scattered, white from any side (a diffuse sphere: its far side is in its
	// own shadow), plus a forward lobe
	let lambert = ( sqrt( max( 1.0 - cosA * cosA, 0.0 ) ) + ( PI - acos( clamp( cosA, -1.0, 1.0 ) ) ) * cosA ) / PI;
	// (the forward lobe is passed on separately: thin, torn parts glow with it, thick parts shade it)
	let cSpray = sun * ( ( lambert * 0.65 + 0.35 ) / PI ) + frame.skyIrradiance * 1.15;
	let fSpray = sun * ( sprayPhaseHG( cosT, 0.6 ) * 0.9 );
	// mist: a thin veil of fine drops, strongly forward scattering, tinted by the sky
	let cMist = sun * ( 0.25 / PI ) + frame.skyIrradiance * 0.9;
	let fMist = sun * sprayPhaseHG( cosT, 0.75 );
	// clear sheet: thin water, the sky it shows and a little sun off its surface
	let cClear = frame.skyIrradiance * 0.95 + sun * 0.05;
	let fClear = sun * ( sprayPhaseHG( cosT, 0.8 ) * 1.1 );
	let col = select( select( select( cSpray, cClear, isClear ), cMist, isMist ), cWater, water );
	let fwd = select( select( select( fSpray, fClear, isClear ), fMist, isMist ), vec3f( 0.0 ), water );

	// opacity over the particle's life
	let t = age / max( life, 1e-3 );
	let fadeIn = smoothstep( 0.0, ${byKind("kind", KIND.fadeIn)}, t );
	let fadeOut = 1.0 - smoothstep( ${byKind("kind", KIND.fadeOut)}, 1.0, t );
	let baseA = ${byKind("kind", KIND.alpha)};
	// far: fade out; very near the eye: sheets and mist would fill the screen (and cost a lot of overdraw)
	let distFade = smoothstep( maxDistance, maxDistance * 0.55, dist ) * select( smoothstep( 0.6, 3.0, dist ), 1.0, water );
	let a = baseA * fadeIn * fadeOut * cover * distFade * intensity;
	if ( !( alive && a > 1e-4 ) ) { return dead; }
	// PORT: the water surface under the particle is the one the update met; the sand too (y of info)
	let under = max( info.z, terrainHeightAt( p.xz, terrainHeight ) );
	return mat4x4f(
		vec4f( world, halfX / pixel ),
		vec4f( col, a ),
		// x: kind + 0.45 * life fraction (the kind tests below have 0.5 of margin)
		vec4f( kind + sat( t ) * 0.45, under, size, fract( info.w ) ),
		vec4f( fwd, 0.0 ) );
}

// PORT: returns ( colour, alpha ) as STRAIGHT alpha ( Tidewater's ( col * a, a ) )
fn opSprayFragment( uv: vec2f, pos: vec3f, vCol: vec4f, vMisc: vec4f, vFwd: vec4f, halfPx: f32,
	sprayPuff: texture_2d<f32>, sprayPuffS: sampler, sprayDots: texture_2d<f32>, sprayDotsS: sampler ) -> vec4f {
	let kind = vMisc.x;
	let isDrop = kind < 0.5;
	let isLig = kind > 1.5 && kind < 2.5;
	let isSheet = kind > 2.5;
	let isClear = kind > 3.5;
	let t = sat( fract( kind ) / 0.45 ); // life fraction
	let r2 = dot( uv, uv );
	let sd = vec2f( vMisc.w, vMisc.w * 1.7 );
	// drop: gaussian streak; ligament: a slightly sharper, beaded blob
	let drop = max( exp( r2 * - 3.5 ) - 0.03, 0.0 );
	let lig = max( exp( r2 * - 4.5 ) * ( sin( uv.y * 5.0 + vMisc.w * 40.0 ) * 0.2 + 0.9 ) - 0.03, 0.0 );
	// torn sheet: noise streaked along the motion (uv.y), eroded from its edges inward and more and
	// more as it ages, so it tears into strands and fragments instead of shrinking
	let env = sat( 1.0 - r2 );
	let fib = textureSample( sprayPuff, sprayPuffS, vec2f( uv.x * 0.5, uv.y * 0.26 ) + sd ).x;
	let fine = textureSample( sprayPuff, sprayPuffS, vec2f( uv.x * 1.2, uv.y * 0.6 ) + sd * 2.3 ).x;
	let field = fib * 0.6 + fine * 0.4 + ( env - 0.55 ) * 0.75 - smoothstep( 0.8, 1.0, r2 );
	// a torn sheet only a few pixels across can't show its tears: drawn thinner and more torn
	let farK = smoothstep( 14.0, 3.0, halfPx ) * select( 0.0, 1.0, isSheet && ! isClear );
	let erode = mix( 0.26, 0.7, t ) + farK * 0.16;
	let dens = sat( ( field - erode ) * 3.0 );
	// torn edges are thin, translucent water: soft and see-through, the core dense white
	let torn = smoothstep( erode - 0.04, erode + 0.2, field ) * ( dens * 0.45 + 0.55 );
	// ... which breaks up into a cluster of drops: many small dots in a ragged envelope
	let dots = textureSample( sprayDots, sprayDotsS, uv * vec2f( 0.5, 0.32 ) + sd * 3.7 ).x;
	let swarm = dots * smoothstep( 0.25, 0.55, fib + env * 0.45 - t * 0.2 ) * ( 1.0 - t * 0.5 );
	let sheet = max( torn * ( 1.0 - smoothstep( 0.15, 0.6, t ) ), swarm );
	// mist: a soft veil of low-frequency noise that drifts and thins, never a disc
	let m1 = textureSample( sprayPuff, sprayPuffS, uv * 0.2 + sd ).x;
	let m2 = textureSample( sprayPuff, sprayPuffS, uv * 0.55 + sd * 3.1 ).x;
	let veil = smoothstep( 0.28, 0.8, m1 * 0.7 + m2 * 0.3 + env * 0.3 - 0.12 ) * sqrt( env ) * ( 1.0 - t * 0.4 );
	let shape = select( select( select( veil, sheet, isSheet ), lig, isLig ), drop, isDrop );
	// self-shadowing inside thick sheets; the forward-scattered sun lights up the thin parts
	let shade = select( 1.0, 1.0 - dens * 0.15, isSheet && ! isClear );
	let glow = select( select( 1.0, 1.0 - dens * 0.6, isSheet ), 1.0 - dens * 0.3, isClear );

	// soft intersections. PORT: only with the water / sand under the particle (no scene depth)
	let soft = vMisc.z * 1.5 + 0.03;
	let fadeWater = sat( ( pos.y - vMisc.y ) / ( soft * 0.6 ) + 0.15 );
	let aOut = vCol.w * shape * fadeWater * ( 1.0 - farK * 0.4 );
	if ( aOut < 0.002 ) { discard; }
	return vec4f( vCol.rgb * shade + vFwd.xyz * glow, aOut );
}
`;

export class OceanProSpray {
  constructor({ renderer, scene, fftDisp }) {
    this.renderer = renderer;
    this.device = renderer.backend.device;
    this.scene = scene;
    this.N = NG;
    this.intensity = uniform(1);
    this.maxDistance = uniform(320);
    const dev = this.device;

    // the ring (ping-pong state) and its head
    const mk = (name) => {
      const t = new THREE.StorageTexture(ROW * 3, ROWS);
      t.name = name;
      t.type = THREE.FloatType;
      t.format = THREE.RGBAFormat;
      t.magFilter = t.minFilter = THREE.NearestFilter;
      t.generateMipmaps = false;
      renderer.initTexture(t);
      return t;
    };
    this.state = [mk("oceanpro spray A"), mk("oceanpro spray B")];
    this.cur = 0; // the state the emitters write into and the sprites read
    this.head = dev.createBuffer({ label: "oceanpro spray head", size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    this._headRead = dev.createBuffer({ label: "oceanpro spray head read", size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    this._readPending = false;
    this._hist = [];
    this.budget = 0.3; // emission scale for the drops that keeps the ring from wrapping (see _budget)
    this.frameSeed = 0;

    this._ubo = new Float32Array(24);
    this.uniformBuffer = dev.createBuffer({ label: "oceanpro spray", size: this._ubo.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.dispSampler = dev.createSampler({ addressModeU: "repeat", addressModeV: "repeat", magFilter: "linear", minFilter: "linear", mipmapFilter: "linear" });
    const code = updateKernelCode(fftDisp);
    this.pipeline = dev.createComputePipeline({
      label: "OceanPro Spray Update", layout: "auto",
      compute: { module: dev.createShaderModule({ label: "oceanpro spray update", code }), entryPoint: "main" },
    });
    this._binds = new Map();
    this._bindKey = null;
    this.puff = makePuffTexture();
    this.dots = makeDotsTexture();
    this.mesh = null;
  }

  /** The state texture the emitters write into this frame (three's texture; its GPU texture via the backend). */
  get target() { return this.state[this.cur]; }

  /** The sprites, shaded with the ocean's frame (its shared WGSL and uniform gate). */
  buildMesh({ all, loadFn, gate, cloudNode, crestTexture, heightTexNode }) {
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    geo.instanceCount = NG;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);

    // (one code node for both functions: three includes it once)
    const renderCode = wgsl(threeWgsl(SPRAY_RENDER));
    const vertexFn = wgslFn(`fn opSprayVertexCall( gate: f32, inst: u32, corner: vec2f, state: texture_2d<f32>, crest: texture_2d<f32>,
	terrainHeight: texture_2d<f32>, cloudShadow: texture_2d<f32>, resolution: vec2f, intensity: f32, maxDistance: f32 ) -> mat4x4f {
	return opSprayVertex( gate, inst, corner, state, crest, terrainHeight, cloudShadow, resolution, intensity, maxDistance );
}`, [all, renderCode]);
    const fragmentFn = wgslFn(`fn opSprayFragmentCall( uv: vec2f, pos: vec3f, vCol: vec4f, vMisc: vec4f, vFwd: vec4f, halfPx: f32,
	sprayPuff: texture_2d<f32>, sprayPuffS: sampler, sprayDots: texture_2d<f32>, sprayDotsS: sampler ) -> vec4f {
	return opSprayFragment( uv, pos, vCol, vMisc, vFwd, halfPx, sprayPuff, sprayPuffS, sprayDots, sprayDotsS );
}`, [all, renderCode]);

    this.stateNode = texture(this.state[this.cur]);
    const crestNode = texture(crestTexture);
    const puffNode = texture(this.puff);
    const dotsNode = texture(this.dots);
    const v0 = varyingProperty("vec4", "vSpr0");
    const v1 = varyingProperty("vec4", "vSpr1");
    const v2 = varyingProperty("vec4", "vSpr2");
    const v3 = varyingProperty("vec4", "vSpr3");
    const vUV = varyingProperty("vec2", "vSprUV");
    const m = new THREE.MeshBasicNodeMaterial();
    m.name = "OceanProSpray";
    m.transparent = true;
    m.depthWrite = false;
    m.depthTest = true;
    m.side = THREE.DoubleSide;
    m.fog = true;
    m.positionNode = Fn(() => {
      const out = vertexFn(gate(loadFn), instanceIndex, positionGeometry.xy, this.stateNode, crestNode, heightTexNode, cloudNode,
        screenSize, this.intensity, this.maxDistance).toVar();
      v0.assign(out.element(0));
      v1.assign(out.element(1));
      v2.assign(out.element(2));
      v3.assign(out.element(3));
      vUV.assign(positionGeometry.xy);
      return out.element(0).xyz;
    })();
    const res = fragmentFn(vUV, v0.xyz, v1, v2, v3, v0.w, puffNode, sampler(puffNode), dotsNode, sampler(dotsNode)).toVar();
    m.colorNode = res.xyz;
    m.opacityNode = res.w;
    const mesh = new THREE.Mesh(geo, m);
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    // over the water and the lip
    mesh.renderOrder = 62;
    mesh.name = "OceanProSpray";
    if (this.mesh) { this.scene.remove(this.mesh); this.mesh.material.dispose(); this.mesh.geometry.dispose(); }
    this.mesh = mesh;
    this.scene.add(mesh);
    return mesh;
  }

  /**
   * One step (after the emitters): the particles move, fall, die; the sprites then read the result.
   * o: dt, time, seaLevel, terrainSize, maxHeight, heightBase, flip, amplitude, shore, windDir, windSpeed,
   * heightTexture, fieldTexture, dispTexture (three textures)
   */
  update(o) {
    const r = this.renderer;
    const gpu = (t) => r.backend.get(t)?.texture;
    const src = this.state[this.cur], dst = this.state[1 - this.cur];
    const hT = gpu(o.heightTexture), fT = gpu(o.fieldTexture), dT = gpu(o.dispTexture), sT = gpu(src), wT = gpu(dst);
    if (!hT || !fT || !dT || !sT || !wT) return;
    // one bind group per direction of the ping-pong (rebuilt when an input texture changes)
    const key = [hT, fT, dT];
    if (!this._bindKey || key.some((t, i) => t !== this._bindKey[i])) { this._bindKey = key; this._binds.clear(); }
    let bind = this._binds.get(this.cur);
    if (!bind) {
      bind = this.device.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.uniformBuffer } },
          { binding: 1, resource: hT.createView() },
          { binding: 2, resource: fT.createView() },
          { binding: 3, resource: dT.createView({ dimension: "2d-array" }) },
          { binding: 4, resource: this.dispSampler },
          { binding: 5, resource: sT.createView() },
          { binding: 6, resource: wT.createView() },
        ],
      });
      this._binds.set(this.cur, bind);
    }
    const u = this._ubo;
    u.set([o.seaLevel, o.time, Math.max(o.dt, 1e-4), o.terrainSize, o.maxHeight, o.heightBase, o.flip ? 1 : 0, o.amplitude ?? 1], 0);
    u.set(o.shore[0], 8); u.set(o.shore[1], 12); u.set(o.shore[2], 16);
    u.set([o.windDir.x, o.windDir.y, o.windSpeed, 0], 20);
    this.device.queue.writeBuffer(this.uniformBuffer, 0, u);
    const enc = this.device.createCommandEncoder({ label: "oceanpro spray update" });
    const pass = enc.beginComputePass({ label: "OceanPro Spray Update" });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bind);
    pass.dispatchWorkgroups(Math.ceil(NG / 64), 1, 1);
    pass.end();
    // the ring head, read back a few frames late for the emission budget
    if (!this._readPending) enc.copyBufferToBuffer(this.head, 0, this._headRead, 0, 4);
    this.device.queue.submit([enc.finish()]);
    if (!this._readPending) this._readHead(o.time);
    this.cur = 1 - this.cur;
    if (this.stateNode) this.stateNode.value = this.state[this.cur];
    this.frameSeed = (this.frameSeed + 1) % 16777216;
  }

  // Emission budget (Tidewater Breakers._budget). The emitters write into the ring (NG slots):
  // emitting faster than NG per particle lifetime overwrites particles a few frames after they're born.
  // The head is read back and the emission scale steered so the ring holds ~2 s of spray.
  _readHead(time) {
    this._readPending = true;
    this._headRead.mapAsync(GPUMapMode.READ).then(() => {
      const head = new Uint32Array(this._headRead.getMappedRange(0, 4))[0];
      this._headRead.unmap();
      this._readPending = false;
      const H = this._hist;
      if (!H.length || H[H.length - 1].t !== time) H.push({ head, t: time });
      while (H.length > 2 && time - H[0].t > 2.5) H.shift();
      if (H.length > 1) {
        const a = H[0], b = H[H.length - 1];
        const dt = b.t - a.t;
        if (dt > 1.0) {
          const rate = ((b.head - a.head) >>> 0) / dt; // particles / s (uint wrap safe)
          const target = NG / 2.0;
          const want = rate > 1 ? this.budget * Math.sqrt(target / rate) : 1;
          this.budget = Math.min(1, Math.max(0.05, this.budget + (want - this.budget) * 0.04));
        }
      }
    }).catch(() => { this._readPending = false; });
  }

  setVisible(on) { if (this.mesh) this.mesh.visible = !!on; }

  dispose() {
    this.head.destroy();
    this._headRead.destroy();
    this.uniformBuffer.destroy();
    for (const t of this.state) t.dispose();
    this.puff.dispose();
    this.dots.dispose();
    if (this.mesh) { this.scene.remove(this.mesh); this.mesh.material.dispose(); this.mesh.geometry.dispose(); }
  }
}

// mipmapped rgba8 texture from CPU data (repeat wrap)
function mipTexture(data, size, name) {
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.name = name;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

// Small tileable value-noise texture for mist puffs (generated once on the CPU).
function makePuffTexture(size = 64) {
  const data = new Uint8Array(size * size * 4);
  const rnd = (i, j, o) => {
    const s = Math.sin((i % o) * 127.1 + (j % o) * 311.7 + o * 17.3) * 43758.5453;
    return s - Math.floor(s);
  };
  const vnoise = (x, y, o) => {
    const i = Math.floor(x), j = Math.floor(y);
    const fx = x - i, fy = y - j;
    const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
    const a = rnd(i, j, o), b = rnd(i + 1, j, o), c = rnd(i, j + 1, o), d = rnd(i + 1, j + 1, o);
    return (a * (1 - ux) + b * ux) * (1 - uy) + (c * (1 - ux) + d * ux) * uy;
  };
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
    let s = 0, a = 0.5, n = 0;
    for (let o = 4; o <= 32; o *= 2) {
      s += vnoise(i / size * o, j / size * o, o) * a;
      n += a;
      a *= 0.55;
    }
    const v = Math.max(0, Math.min(1, (s / n - 0.2) * 1.6));
    const k = (j * size + i) * 4;
    data[k] = data[k + 1] = data[k + 2] = Math.round(v * 255);
    data[k + 3] = 255;
  }
  return mipTexture(data, size, "oceanpro spray puff");
}

// Tileable texture of scattered drops (r: coverage), for clusters of drops. Heavy-tailed radii: many
// tiny drops, a few large ones.
function makeDotsTexture(size = 128, count = 150) {
  const data = new Uint8Array(size * size * 4);
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const cov = new Float32Array(size * size);
  for (let k = 0; k < count; k++) {
    const cx = rnd() * size, cy = rnd() * size;
    const r = Math.min(0.9 * Math.pow(1 - rnd() * 0.97, -0.55), 6);
    const R = Math.ceil(r + 1.5);
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const x = ((Math.floor(cx) + dx) % size + size) % size, y = ((Math.floor(cy) + dy) % size + size) % size;
      const d = Math.hypot(Math.floor(cx) + dx + 0.5 - cx, Math.floor(cy) + dy + 0.5 - cy);
      const c = Math.max(0, Math.min(1, r + 0.5 - d));
      cov[y * size + x] = Math.max(cov[y * size + x], c);
    }
  }
  for (let i = 0; i < size * size; i++) {
    const v = Math.round(cov[i] * 255);
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  }
  return mipTexture(data, size, "oceanpro spray dots");
}
