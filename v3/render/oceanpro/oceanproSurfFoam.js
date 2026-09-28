// OCEAN PRO — the surf-zone foam look (part of the "pro" ocean mode, v3/render/oceanpro/). Port of
// Tidewater's ocean/SurfFoam.js shader hooks (MIT, Copyright (c) 2026 DRG Software Solutions LLC — see
// v3/skypro-real/tidewater/LICENSE). The WGSL is Tidewater's; changes are marked `// PORT:`.
//
// Whitewater is a volume of bubbles: a dense mat that is bright from every side, with a lumpy, bubbly
// surface (darker in its own dips), tearing into patches and then into lace (thin bubble strands around
// clear holes) as it decays. Thin foam is translucent over the water colour.
//
// The pattern lives in world space, carried by the water with a dual-phase flow map: two copies of the
// lace, half a cycle apart, each advected by the local flow (from the shore simulation) for one cycle
// and then re-placed at random, cross-faded so neither is ever stretched for long. Steep whitewater
// faces use a vertical projection that rolls down the face.
//
// PORT:
//  - the lace texture + its sampler and the shore field are parameters (threaded through)
//  - the flow direction from the shore field itself (Tidewater: its low-resolution direction texture,
//    whose own fallback is exactly this)
//  - @diagnostic( off, derivative_uniformity ) on the functions that take derivatives (Tidewater turns it
//    off for every shader)

import { LACE_TILE } from "./oceanproShoreSim.js";

const f = (x) => {
  const s = String(x);
  return s.includes(".") || s.includes("e") ? s : s + ".0";
};

const BUMP = 0.7; // relief of the whitewater and of thick foam (normal perturbation strength)
const PERIOD = 1.2; // s, flow map cycle
const MAX_FLOW = 2.5; // m/s, the pattern lags behind faster flow (bounds the distortion per cycle)
const LT = "surfFoamLaceTex: texture_2d<f32>, smpAnisoRepeat: sampler";
const LA = "surfFoamLaceTex, smpAnisoRepeat";

export function surfFoamCode() {
  return /* wgsl */`
struct SurfFoamArgs {
	coverage: f32,
	foam: f32,
	footprint: f32,
	depth: f32,
	bubbles: f32,
	lagXZ: vec2f,
	normal: vec3f,
	baseNormal: vec3f,
	fresh: f32,
	sim: f32,
	simState: vec4f,
	roller: f32,
	P: vec3f,
};

struct SurfFoamInfo {
	foam: f32,
	density: f32,
	height: f32,
	surf: f32,
	ww: f32,
	relief: f32,
	selfShadow: f32,
	cavity: f32,
	// relief split into world-space patterns and their weights: only the patterns are differentiated
	reliefPat: f32, // whitewater lumps (m), relief = reliefPat * reliefK
	reliefK: f32,
	thinPat: f32, // thin foam: height = thinPat * thinK + bubPat * bubK
	thinK: f32,
	bubPat: f32,
	bubK: f32,
};

// Henyey-Greenstein phase (1/sr)
fn surfFoamPhaseHG( cosT: f32, g: f32 ) -> f32 {
	let g2 = g * g;
	return ( ( 1.0 - g2 ) / ( 4.0 * PI ) ) / pow( max( 1.0 + g2 - cosT * 2.0 * g, 1e-4 ), 1.5 );
}

fn surfFoamHash11( x: f32 ) -> f32 { return fract( sin( x * 91.7 + 17.3 ) * 43758.5453 ); }

// Lace distance (0 on a bubble strand .. 1 in a hole) at pattern coordinates q (m), carried by
// flow (m/s in the same coordinates) with the dual-phase flow map. salt decorrelates layers.
@diagnostic( off, derivative_uniformity )
fn surfFoamFlowLace( q: vec2f, flow: vec2f, salt: f32, ${LT} ) -> vec4f {
	let t = frame.time / ${f(PERIOD)};
	let v = clamp( flow, vec2f( - ${f(MAX_FLOW)} ), vec2f( ${f(MAX_FLOW)} ) ) * ${f(PERIOD)};
	var out = vec4f( 0.0 );
	for ( var k = 0; k < 2; k++ ) {
		let tk = t + ( f32( k ) * 0.5 + salt * 0.37 );
		let ph = fract( tk );
		let cycle = floor( tk ) + ( f32( k ) * 13.1 + salt * 5.7 );
		let jitter = vec2f( surfFoamHash11( cycle ), surfFoamHash11( cycle + 0.5 ) ) * 7.0;
		let p = ( q - v * ( ph - 0.5 ) ) / ${f(LACE_TILE)} + jitter;
		let w = 1.0 - abs( ph * 2.0 - 1.0 );
		out += textureSample( surfFoamLaceTex, smpAnisoRepeat, p ) * w;
	}
	return out; // the two weights always add up to 1
}

@diagnostic( off, derivative_uniformity )
fn surfFoamBigAt( qq: vec2f, pflow: vec2f, ${LT} ) -> f32 {
	return sqrt( surfFoamFlowLace( qq / 6.0, pflow / 6.0, 2.0, ${LA} ).x );
}

// coverage: total foam amount (0..1, all sources); foam: the default (offshore whitecap) foam;
// footprint: pixel size on the surface (m); depth: sea depth; bubbles: fine bubble detail;
// normal: surface normal; fresh: whitewater made by the breaking wave right here (roller,
// plunge point, swash front); sim: foam carried by the water (the shore simulation, already kept off
// the clear face of plunging waves); simState: shoreSimSample() at this pixel; roller: relief of
// the whitewater roller (m)
@diagnostic( off, derivative_uniformity )
fn surfFoamShading( a: SurfFoamArgs, ${LT}, shoreTex: texture_2d<f32> ) -> SurfFoamInfo {
	let P = select( a.P, vec3f( a.lagXZ.x, frame.seaLevel, a.lagXZ.y ), all( a.P == vec3f( 0.0 ) ) );
	let xz = P.xz;
	let coverage = a.coverage;
	var opacity = a.foam;
	var density = sat( coverage );
	var height = 0.0;
	var wwOut = 0.0; // how much of it is whitewater (deeper crevices)
	var wwRelief = 0.0; // relief of the whitewater (m)
	var wwShadow = 1.0; // sun visibility inside the churn
	var wwCav = 1.0; // sky visibility in its crevices
	var reliefPat = 0.0; var reliefK = 0.0;
	var thinPat = 0.0; var thinK = 0.0;
	var bubPat = 0.0; var bubK = 0.0;
	// surf look near the beach, the default whitecap look offshore
	let surf = smoothstep( 7.0, 3.0, a.depth ) * shoreSimInside( shoreSimUvOf( xz ) );
	if ( surf > 0.0 && coverage > 0.04 ) {

		// flow of the water here, from the shore simulation (along the local wave direction)
		// PORT: the direction from the shore field (Tidewater's direction texture's own fallback)
		let dirE = terrainShoreSample( xz, shoreTex ).yz;
		let dir = dirE / max( length( dirE ), 1e-4 );
		let speed = a.simState.w;
		let flow = dir * speed;

		// --- pattern: world-space lace carried by the flow; on steep faces a vertical projection
		// (along the crest x height) rolling down the face with the roller
		let steep = smoothstep( 0.82, 0.5, a.baseNormal.y );
		let ww = sat( a.fresh * 1.4 );
		// far pixels (a lace cell under a few pixels) only use the pattern's average
		let farOnly = a.footprint >= 0.12;
		var flat = vec4f( 0.5 );
		if ( ! farOnly ) { flat = surfFoamFlowLace( xz, flow, 0.0, ${LA} ); }
		var lace = flat;
		// lumps of tumbling whitewater (~0.6 m), only where there is whitewater
		var lumps = 0.5;
		let tangent = vec2f( - dir.y, dir.x );
		let al = dot( xz, tangent );
		let qv = vec2f( al + sin( al * 0.19 + 0.8 ) * 2.1 + sin( al * 0.47 + 2.9 ) * 0.6 + sin( P.y * 1.7 + al * 0.11 ) * 0.5, P.y * 1.1 );
		if ( steep > 0.01 && ! farOnly ) {
			let vert = surfFoamFlowLace( qv, vec2f( 0.0, -0.9 ), 1.0, ${LA} );
			lace = mix( flat, vert, steep );
		}
		// Churning whitewater is a pile of foam lumps at several scales: a relief (m) for the normals,
		// sunlit caps and self-shadowed crevices (a short march toward the sun through the lump field)
		if ( ww > 0.02 && ! farOnly ) {
			let L = frame.sunDir;
			let pq = mix( xz, qv, steep );
			let pflow = mix( flow, vec2f( 0.0, -0.9 ), steep );
			let big = surfFoamBigAt( pq, pflow, ${LA} );
			let mid = sqrt( surfFoamFlowLace( pq / 2.2, pflow / 2.2, 3.0, ${LA} ).x );
			lumps = big * 0.6 + mid * 0.4;
			let A = 0.22; // relief of the lumps (m)
			reliefPat = big * A + mid * ( A * 0.45 ) + ( 1.0 - lace.x ) * ( A * 0.12 );
			wwRelief = reliefPat * ww;
			// the sun direction in the pattern's coordinates, and its elevation above the local surface
			let Lp = mix( L.xz, vec2f( dot( L.xz, tangent ), L.y * 1.1 ), steep );
			let Ld = Lp / max( length( Lp ), 1e-3 );
			let NdL = dot( a.normal, L );
			let tanE = NdL / max( length( L - a.normal * NdL ), 0.05 );
			var occ = 0.0;
			let steps = array<f32, 3>( 0.14, 0.34, 0.7 );
			for ( var i = 0; i < 3; i++ ) {
				let d = steps[ i ];
				let hk = surfFoamBigAt( pq + Ld * d, pflow, ${LA} );
				occ = max( occ, smoothstep( 0.0, 0.05, ( hk - big ) * A - tanE * d ) );
			}
			wwShadow = 1.0 - occ * mix( 0.85, 0.7, steep );
			// crevices between the lumps: occluded from the sky too
			wwCav = mix( 0.5, 1.0, smoothstep( 0.05, 0.75, lumps ) );
		}

		// --- whitewater: the aerated mass of a roller / plunge / swash front
		let boil = lace.x * 0.7 + lace.z * 0.3;
		let wwEdge = smoothstep( 0.25, 0.75, ww * 1.35 - boil * 0.3 - ( 1.0 - lumps ) * 0.5 );
		let whitewater = ( ww * 0.25 + wwEdge * 0.75 ) * ( ( 1.0 - boil ) * 0.12 + 0.88 );

		// --- foam carried by the water: a lacy web of bubble strands and clusters around holes
		let c = sat( ( a.sim + max( coverage - a.sim - a.fresh, 0.0 ) * 0.5 - 0.05 ) / 0.95 );
		let w = max( pow( c, 1.4 ) * 0.9 * ( lace.z * 0.5 + 0.75 ) + ( lace.y - 0.5 ) * 0.06, 0.0 );
		let soft = 0.05 + a.footprint * 4.5;
		let mat = ( 1.0 - smoothstep( w - soft, w + soft, lace.x ) ) * smoothstep( 0.0, 0.05, c );
		// scattered bubbles in the holes next to the strands
		let bub = lace.y * smoothstep( w + 0.25, w, lace.x ) * smoothstep( 0.02, 0.2, c ) * 0.5;
		// thin foam is translucent and uneven, thick foam is opaque
		let inner = sat( ( w - lace.x ) / 0.25 );
		let laceFoam = max( mat * sat( inner * 0.35 + 0.45 + lace.z * 0.3 ), bub );

		// once a lace cell (~0.2 m) covers a few pixels, use the average of the pattern
		let far = smoothstep( 0.03, 0.12, a.footprint );
		let average = max( sat( pow( w, 1.45 ) * 1.9 ) * 0.8, ww * 0.95 );
		let near = max( laceFoam, whitewater );
		opacity = mix( a.foam, mix( near, average, far ), surf );

		density = max( sat( c * 1.3 ) * ( inner * 0.5 + 0.5 ), ww );
		let reliefThin = inner * sat( c * 1.5 );
		let relief = reliefThin * ( 1.0 - ww );
		wwOut = ww * ( 1.0 - far * 0.6 );
		wwShadow = mix( wwShadow, 0.82, far );
		wwCav = mix( wwCav, 0.8, far );
		wwRelief *= 1.0 - far;
		height = ( relief + a.bubbles * 0.15 ) * surf * ( 1.0 - far );
		reliefK = ww * ( 1.0 - far );
		thinPat = reliefThin;
		thinK = ( 1.0 - ww ) * surf * ( 1.0 - far );
		bubPat = a.bubbles * 0.15;
		bubK = surf * ( 1.0 - far );
	}

	return SurfFoamInfo( opacity, density, height, surf, wwOut, wwRelief, wwShadow, wwCav, reliefPat, reliefK, thinPat, thinK, bubPat, bubK );
}

// Foam radiance: a dense scatterer, wrapped diffuse sun (light diffuses through the bubbles),
// sky ambient, darker in the dips of the bubbly relief, glowing at thin edges when backlit.
@diagnostic( off, derivative_uniformity )
fn surfFoamLight( info: SurfFoamInfo, N: vec3f, L: vec3f, V: vec3f, sun: vec3f, P: vec3f ) -> vec3f {
	let ww = info.ww;
	let cavity = info.cavity;
	// relief normal from the screen-space gradient of the height (Mikkelsen surface gradient)
	let kb = ${f(BUMP * 0.04)};
	let dpx = dpdx( P );
	let dpy = dpdy( P );
	let dhdx = dpdx( info.reliefPat ) * info.reliefK + ( dpdx( info.thinPat ) * info.thinK + dpdx( info.bubPat ) * info.bubK ) * kb;
	let dhdy = dpdy( info.reliefPat ) * info.reliefK + ( dpdy( info.thinPat ) * info.thinK + dpdy( info.bubPat ) * info.bubK ) * kb;
	let r1 = cross( dpy, N );
	let r2 = cross( N, dpx );
	let det = dot( dpx, r1 );
	let grad = ( r1 * dhdx + r2 * dhdy ) * sign( det );
	let Nf = normalize( N * abs( det ) - grad + N * 1e-6 );
	let NdL = dot( Nf, L );
	let wrap = mix( 0.45, 0.12, ww );
	let diff = sat( NdL * ( 1.0 - wrap ) + wrap ) * mix( 1.0, info.selfShadow, ww );
	let ao = mix( mix( 1.0, info.height * 0.3 + 0.76, info.surf ), cavity, ww );
	let thin = ( 1.0 - info.density ) * 0.8 + ww * ( 1.0 - cavity ) * 0.3;
	let trans = surfFoamPhaseHG( dot( - V, L ), 0.55 ) * thin * 1.3;
	let transCol = mix( vec3f( 1.0 ), vec3f( 0.6, 0.92, 0.82 ), ww * 0.7 + 0.3 );
	let sky = frame.skyIrradiance;
	let skyGrey = vec3f( dot( sky, vec3f( 0.2126, 0.7152, 0.0722 ) ) );
	let amb = mix( sky, skyGrey, ww * 0.35 ) * ao + sun * ( ww * 0.05 ) * ao;
	return ( sun * ( diff * mix( 1.0, sqrt( cavity ), ww ) / PI + transCol * trans ) + amb ) * 0.86;
}
`;
}
