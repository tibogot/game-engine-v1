// OCEAN PRO — plunging breakers: the thrown lip (part of the "pro" ocean mode, v3/render/oceanpro/).
// Port of Tidewater's ocean/Breakers.js (MIT, Copyright (c) 2026 DRG Software Solutions LLC — see
// v3/skypro-real/tidewater/LICENSE). The WGSL is Tidewater's; changes are marked `// PORT:`.
//
// Stations are laid out every ~0.6 m along the shoreline. Each frame a compute pass marches every
// station's transect through the surf zone and finds the crests of the breaking waves as crossings of
// the wave phase s = (t - T) / period + wobble with integers (the same analytic field that drives the
// water surface, so the crest found here is exactly the crest of the rendered surface). For every crest
// it stores the lip root, the breaking progress and the wave height.
//
// The thrown lip is a separate ribbon mesh extruded along the crest (Thuerey et al. 2007): a ballistic
// curtain leaving the crest horizontally and falling in front of the concave face, shaded like the
// water (Fresnel sky reflection, light through the thin sheet, aerated streaks that grow toward the
// tip) and blended over the water. Its root lies on the crest of the water surface and fades in there,
// so there is no visible seam.
//
// PORT:
//  - stations: Tidewater marches one hard-coded beach. Here the WHOLE coastline is extracted from the
//    heightmap (marching squares at sea level, linked into polylines, smoothed, resampled every 0.6 m,
//    each pointing to the sea) wherever the swell reaches it, and each frame the stations near the
//    camera's view (up to CAP) go to the GPU. Consecutive stations of different stretches of coast are
//    kept apart by a distance test in the lip's vertex stage.
//  - the crest finder is a raw WebGPU compute pipeline on three's device writing the crest data into a
//    float texture three owns (6 x CAP texels: slot x (root+b, back+H, dir+trough+id)); the lip
//    material reads it with loads
//  - the spray emitters write into oceanproSpray.js's ring (its emitter WGSL is part of this kernel);
//    their uniforms (camera, wind, budget) ride in U5..U7
//  - blending: the premultiplied output ( col * a, a ) is handed to three as straight alpha

import * as THREE from "three/webgpu";
import {
  Fn, attribute, uniform, float, texture, sampler, select, frontFacing, varyingProperty, wgsl, wgslFn,
} from "three/tsl";
import { shoreCode } from "./oceanproShore.js";
import { SHARED_WGSL, threeWgsl } from "./oceanproShader.js";
import { LACE_TILE, makeLaceTexture } from "./oceanproShoreSim.js";
import { sprayEmitterWGSL } from "./oceanproSpray.js";

const NV = 20; // profile vertices across the lip (2 on the back of the crest + 18 along the curtain)
const CAP = 1024; // stations on the GPU at once (~600 m of coast)
const SPACING = 0.6; // m between stations
const GRAVITY = 9.81;

const f = (x) => {
  const s = String(x);
  return s.includes(".") || s.includes("e") ? s : s + ".0";
};

// ------------------------------------------------------------------ the coastline (CPU)

/**
 * PORT: shoreline stations for a whole map: marching squares on heightAt at `seaLevel` over the map
 * (cell `step` m), linked into polylines, smoothed, resampled by arc length. Returns runs of
 * Float32Array( n * 4 ) ( x, z, nx, nz ), n toward the sea.
 */
export function buildCoastStations({ heightAt, seaLevel, half, step = 1.0, spacing = SPACING, keep = null }) {
  const n = Math.ceil((2 * half) / step) + 1;
  const x0 = -half, z0 = -half;
  const H = new Float32Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) H[j * n + i] = heightAt(x0 + i * step, z0 + j * step) - seaLevel;
  // edges: horizontal (i,j)-(i+1,j) id = (j*n+i)*2, vertical (i,j)-(i,j+1) id = (j*n+i)*2+1
  const pts = new Map(); // edge id -> [x, z]
  const cross = (a, b, xa, za, xb, zb) => {
    const t = a / (a - b);
    return [xa + (xb - xa) * t, za + (zb - za) * t];
  };
  const edgePoint = (id) => {
    if (pts.has(id)) return id;
    const k = id >> 1, i = k % n, j = (k / n) | 0;
    const xa = x0 + i * step, za = z0 + j * step;
    if (id & 1) pts.set(id, cross(H[k], H[k + n], xa, za, xa, za + step));
    else pts.set(id, cross(H[k], H[k + 1], xa, za, xa + step, za));
    return id;
  };
  const adj = new Map();
  const link = (a, b) => {
    (adj.get(a) ?? adj.set(a, []).get(a)).push(b);
    (adj.get(b) ?? adj.set(b, []).get(b)).push(a);
  };
  for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) {
    const k = j * n + i;
    const a = H[k] > 0, b = H[k + 1] > 0, c = H[k + n + 1] > 0, d = H[k + n] > 0;
    const code = (a ? 1 : 0) | (b ? 2 : 0) | (c ? 4 : 0) | (d ? 8 : 0);
    if (code === 0 || code === 15) continue;
    const eB = edgePoint(k * 2), eR = edgePoint((k + 1) * 2 + 1), eT = edgePoint((k + n) * 2), eL = edgePoint(k * 2 + 1);
    // the crossed edges, paired (saddles resolved one fixed way: they are rare at the waterline)
    const E = [];
    if (a !== b) E.push(eB);
    if (b !== c) E.push(eR);
    if (c !== d) E.push(eT);
    if (d !== a) E.push(eL);
    if (E.length === 2) link(E[0], E[1]);
    else if (E.length === 4) { link(E[0], E[1]); link(E[2], E[3]); }
  }
  // walk the chains
  const seen = new Set();
  const runs = [];
  for (const start of adj.keys()) {
    if (seen.has(start)) continue;
    // go to one end first (an open chain), then walk
    let s = start, prev = -1;
    for (let guard = 0; guard < 1e6; guard++) {
      const nb = adj.get(s).filter((x) => x !== prev);
      if (!nb.length || nb[0] === start) break;
      prev = s; s = nb[0];
      if (s === start) break;
    }
    const chain = [];
    prev = -1;
    let cur = s;
    for (let guard = 0; guard < 1e6 && cur !== undefined && !seen.has(cur); guard++) {
      seen.add(cur);
      chain.push(pts.get(cur));
      const nb = adj.get(cur).filter((x) => x !== prev && !seen.has(x));
      prev = cur;
      cur = nb[0];
    }
    if (chain.length > 8) runs.push(chain);
  }
  // smooth, resample, orient toward the sea, keep what `keep` accepts (the exposed coast)
  const out = [];
  for (let sm of runs) {
    for (let it = 0; it < 12; it++) {
      sm = sm.map((p, k) => {
        if (k === 0 || k === sm.length - 1) return p;
        return [(sm[k - 1][0] + 2 * p[0] + sm[k + 1][0]) * 0.25, (sm[k - 1][1] + 2 * p[1] + sm[k + 1][1]) * 0.25];
      });
    }
    let acc = 0, next = 0;
    let cur = [];
    const flush = () => { if (cur.length >= 8) out.push(new Float32Array(cur)); cur = []; };
    for (let k = 1; k < sm.length; k++) {
      const [ax, az] = sm[k - 1], [bx, bz] = sm[k];
      const seg = Math.hypot(bx - ax, bz - az);
      if (seg < 1e-6) continue;
      while (next <= acc + seg) {
        const t = (next - acc) / seg;
        const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
        const tx = (bx - ax) / seg, tz = (bz - az) / seg;
        // the normal toward the sea: of the two sides, the lower ground
        let nx = -tz, nz = tx;
        if (heightAt(x + nx * 2, z + nz * 2) > heightAt(x - nx * 2, z - nz * 2)) { nx = -nx; nz = -nz; }
        if (!keep || keep(x, z, nx, nz)) cur.push(x, z, nx, nz);
        else flush();
        next += spacing;
      }
      acc += seg;
    }
    flush();
  }
  return out;
}

// ------------------------------------------------------------------ the crest finder (raw compute)

// ------------------------------------------------------------------ the spray emitters
// Spray from one crest (station i, crest slot `slot`), per frame. Positions and velocities come from
// the analytic wave state; rates are per station (0.6 m of crest) and scale with the energy the
// breaker releases (~ H^2.5 for the plunge, ~ Hb^2.5 for the roller). Tidewater Breakers._emitCode;
// PORT: breakersP.* from U5 / U6 (spray gain, budget, emit range, camera).
const EMIT_WGSL = /* wgsl */`
struct BrkCtx {
	root: vec3f,
	d3: vec3f,
	tg: vec3f,
	Yi: f32,
	Wt: f32,
	wB: f32,
	trough: f32,
	xr: f32,
	Xi: f32,
	q: f32,
};

struct BrkPN { p: vec3f, n: vec3f };

// A point on the front of the wave, on the water surface (the same curve as ShoreWaves' profile:
// concave tube face while plunging, convex roller front of the bore), and its outward normal.
// s: 0 = crest top .. 1 = foot. Everything the breaker throws starts just outside it.
fn breakersFacePoint( C: BrkCtx, sp: f32 ) -> BrkPN {
	let up = vec3f( 0.0, 1.0, 0.0 );
	let th = sp * ${f(Math.PI / 2)};
	let ct = cos( th );
	let st = sin( th );
	let fx = mix( 1.0 - ct, st, C.wB );
	let fy = mix( 1.0 - st, ct, C.wB );
	let n = normalize( C.d3 * ( C.Yi * mix( ct, st, C.wB ) ) + up * ( C.Wt * mix( st, ct, C.wB ) + 0.02 ) );
	let p = C.root + C.d3 * ( C.Wt * fx );
	return BrkPN( vec3f( p.x, C.trough + C.Yi * fy, p.z ), n );
}

// the plunge point: in the trough ahead of the face while the tube is open; once the bore front
// has formed over it, on the lower part of that front
fn breakersPlunge( C: BrkCtx, r: f32, r2: f32 ) -> BrkPN {
	let f = breakersFacePoint( C, r2 * 0.45 + 0.55 );
	let t = C.root + C.d3 * ( C.xr + ( r - 0.5 ) * 0.5 );
	let inTrough = vec3f( t.x, C.trough + 0.03, t.z );
	let open = C.xr > C.Wt + 0.1;
	return BrkPN( select( f.p + f.n * 0.04, inTrough, open ), select( f.n, vec3f( 0.0, 1.0, 0.0 ), open ) );
}

// the leading edge of the falling lip
fn breakersTipAt( C: BrkCtx, r: f32 ) -> vec3f {
	return C.root + C.d3 * ( C.Xi * C.q * ( r * 0.12 + 0.88 ) ) - vec3f( 0.0, 1.0, 0.0 ) * ( C.Yi * C.q * C.q );
}

fn breakersAlong( C: BrkCtx, r: f32 ) -> vec3f {
	return C.tg * ( ( r - 0.5 ) * ${f(SPACING * 1.15)} );
}

fn breakersCount( rate: f32, gain: f32, seed: u32, salt: u32 ) -> u32 {
	return u32( floor( rate * gain + sprayRand( seed, salt ) ) );
}

fn breakersEmit( i: u32, slot: u32, root: vec3f, dir: vec2f, b: f32, H: f32, trough: f32, c: f32, m: f32, depth: f32, bore: vec4f ) {
	let camFade = smoothstep( U[ 5 ].w, U[ 5 ].w * 0.35, length( root - U[ 6 ].xyz ) );
	let gain = U[ 5 ].z * camFade * frame.dt;
	if ( gain <= 0.0 ) { return; }
	// the many sub-pixel drops and ligaments take the ring budget; the few, visible spray and mist
	// sprites always get their full rate
	let gainD = gain * U[ 5 ].y;
	let d3 = vec3f( dir.x, 0.0, dir.y );
	let tg = vec3f( - dir.y, 0.0, dir.x );
	let up = vec3f( 0.0, 1.0, 0.0 );
	let Hc = clamp( H, 0.15, 3.0 );
	// (the energy released goes as H^2.5, but what reads on screen saturates: bigger breakers make
	// bigger, longer-lived structures, not ever more particles)
	let E = pow( Hc, 1.7 );
	let Hb = max( bore.x, 0.0 );
	let Eb = pow( min( Hb, 2.0 ) / 0.6, 1.7 );
	let Wt = bore.y;
	let q = clamp( b / 0.9, 0.0, 1.0 );
	let Xi = H * 0.8;
	let Yi = max( root.y - trough, 0.05 );
	let seed = i * 7919u + u32( m - floor( m / 64.0 ) * 64.0 ) * 31u;
	// integer part: which crest made the particle (its wave shadow, see sprayShadow); fraction: random
	let tag = f32( i * 2u + slot + 1u );
	let offshore = max( - dot( frame.windDir, dir ), 0.0 ) * frame.windSpeed;
	let wB = bore.w;
	let xr = Xi - bore.z; // horizontal distance from the crest top
	let C = BrkCtx( root, d3, tg, Yi, Wt, wB, trough, xr, Xi, q );

	// ---- stages of the breaker (weights 0..1)
	let lipShed = smoothstep( 0.5, 0.75, b ) * ( 1.0 - smoothstep( 0.86, 0.93, b ) );
	// the splash-up is a fast burst (~0.15-0.2 s) as the lip hits the trough; its mist lingers
	let impact = smoothstep( 0.87, 0.92, b ) * ( 1.0 - smoothstep( 1.0, 1.14, b ) );
	let haze = smoothstep( 0.9, 1.0, b ) * ( 1.0 - smoothstep( 1.2, 1.5, b ) );
	let spit = smoothstep( 0.98, 1.08, b ) * ( 1.0 - smoothstep( 1.15, 1.3, b ) );
	let roller = smoothstep( 1.05, 1.3, b ) * smoothstep( 0.06, 0.25, Hb );
	let clash = roller * smoothstep( 0.1, 0.2, depth ) * smoothstep( 0.7, 0.35, depth );
	let drift = smoothstep( 9.0, 15.0, offshore ) * smoothstep( -0.4, 0.1, b ) * ( 1.0 - smoothstep( 0.75, 0.9, b ) );

	// ---- drops and ligaments (ballistic)
	let n0 = breakersCount( lipShed * 9.0 * E, gainD, seed, 1u ); // drops off the lip
	let n1 = n0 + breakersCount( lipShed * 5.0 * E, gainD, seed, 2u ); // ligaments off the lip
	let n2 = n1 + breakersCount( impact * 240.0 * E, gainD, seed, 3u ); // splash-up drops
	let n3 = n2 + breakersCount( impact * 90.0 * E, gainD, seed, 4u ); // splash-up ligaments (torn strands)
	let n4 = n3 + breakersCount( roller * 45.0 * Eb, gainD, seed, 5u ); // roller front (breaks up its silhouette)
	let n5 = n4 + breakersCount( clash * 40.0 * Eb, gainD, seed, 6u ); // bore / backwash collision
	let n6 = n5 + breakersCount( drift * 24.0 * Hc, gainD, seed, 7u ); // spindrift
	if ( n6 > 0u ) {
		let base = sprayReserve( n6 );
		for ( var j = 0u; j < n6; j++ ) {
			let ring = spraySlot( base, j );
			let h = seed + j * 13u;
			let r0 = sprayRand( h, 11u );
			let r1 = sprayRand( h, 12u );
			let r2 = sprayRand( h, 13u );
			let r3 = sprayRand( h, 14u );
			let r4 = sprayRand( h, 15u );
			let isLip = j < n1;
			let isImp = j < n3;
			let isRol = j < n4;
			let isCl = j < n5;
			let lig = ( j >= n0 && j < n1 ) || ( j >= n2 && j < n3 );
			// lip: moving with the jet (thrown forward a little faster than the wave, falling)
			let vLip = d3 * ( c * ( r2 * 0.2 + 1.05 ) ) - up * ( q * sqrt( Yi * ${f(2 * GRAVITY)} ) * ( r3 * 0.3 + 0.7 ) ) + tg * ( ( r4 - 0.5 ) * 0.6 );
			// splash-up: most drops stay low, some reach ~1.3 H; thrown up and forward, out of the surface
			let pl = breakersPlunge( C, r1, r2 );
			let vUp = sqrt( Hc * ( r3 * r3 * 1.0 + 0.3 ) * ${f(2 * GRAVITY)} );
			let vImp = up * vUp + pl.n * ( r4 * 1.5 ) + d3 * ( c * ( r2 * 0.6 + 0.15 ) - 0.3 ) + tg * ( ( r4 - 0.5 ) * 2.0 );
			// roller: tossed forward and up by the tumbling front (from its upper part)
			let fr = breakersFacePoint( C, r1 * r1 * 0.7 ); // mostly from the tumbling top
			let vRol = d3 * ( c * ( r2 * 0.3 + 0.95 ) ) + up * ( ( r3 * 1.6 + 0.6 ) * sqrt( Hb / 0.5 ) ) + fr.n * 0.5 + tg * ( ( r4 - 0.5 ) * 1.2 );
			// bore running into the backwash: thrown straight up from its front
			let fc = breakersFacePoint( C, r1 * 0.5 + 0.3 );
			let vCl = up * ( ( r3 * 1.6 + 0.8 ) * sqrt( Hb / 0.4 ) ) + d3 * ( r2 * 2.0 - 0.6 ) + tg * ( ( r4 - 0.5 ) * 1.5 );
			// spindrift: fine drops blown back over the crest
			let vDr = d3 * ( - ( offshore * ( r2 * 0.3 + 0.35 ) ) ) + up * ( r3 * 1.5 + 0.8 ) + tg * ( ( r4 - 0.5 ) * 0.5 );
			let p = select( select( select( select( root + up * 0.04, fc.p + fc.n * 0.03, isCl ), fr.p + fr.n * 0.03, isRol ), pl.p, isImp ), breakersTipAt( C, r1 ), isLip ) + breakersAlong( C, r0 );
			let v = select( select( select( select( vDr, vCl, isCl ), vRol, isRol ), vImp, isImp ), vLip, isLip );
			// radius (m): drops of a few mm (smaller off the roller, finest in the spindrift), ligaments ~1-2 cm
			// heavy-tailed drop sizes (many fine drops, a few big ones): r = r0 (1 - u)^-0.7
			let tail = pow( 1.0 - r4 * 0.98, -0.7 );
			let rDrop = min( select( select( select( 0.0005, 0.001, isLip ), 0.0008, isRol ), 0.001, isImp || isCl ) * tail, 0.012 );
			let rLig = 0.005 + r4 * r4 * select( 0.008, 0.016, isImp );
			let kind = select( SPRAY_DROPLET, SPRAY_LIGAMENT, lig );
			sprayWrite( ring, p, v, select( rDrop, rLig, lig ), kind, 2.5, tag + r0 * 0.999 );
		}
	}

	// ---- dense spray (clouds of drops: the white of the splash-up), a puff out of the barrel
	let c0 = breakersCount( impact * 110.0 * E, gain, seed, 21u );
	let c1 = c0 + breakersCount( spit * 10.0 * E, gain, seed, 22u );
	let c2 = c1 + breakersCount( roller * 0.6 * Eb, gain, seed, 23u ); // (rare: a row of them reads as cotton puffs)
	let c3 = c2 + breakersCount( clash * 2.0 * Eb, gain, seed, 24u );
	if ( c3 > 0u ) {
		let base = sprayReserve( c3 );
		for ( var j = 0u; j < c3; j++ ) {
			let ring = spraySlot( base, j );
			let h = seed + j * 29u;
			let r0 = sprayRand( h, 41u );
			let r1 = sprayRand( h, 42u );
			let r2 = sprayRand( h, 43u );
			let r3 = sprayRand( h, 44u );
			let isImp = j < c0;
			let isSpit = j < c1;
			let isRol = j < c2;
			// torn sheets of the splash-up (half-width): many small ones, a few big
			// (heavy-tailed: many small torn sheets, a few big ones; never a row of equal puffs)
			let sz = select( select( select( 0.05 + r2 * r2 * 0.08, sqrt( Hb / 0.5 ) * ( r2 * r2 * 0.06 + 0.03 ), isRol ), sqrt( Hc ) * ( r2 * r2 * 0.14 + 0.05 ), isSpit ), sqrt( Hc ) * ( r2 * r2 * r2 * 0.18 + 0.05 ), isImp );
			// splash-up: sheets thrown up and forward out of the plunge line, rising up to ~1.3 H and
			// falling back as curtains
			let pl = breakersPlunge( C, r1, r3 );
			let pImp = pl.p + pl.n * ( sz * 0.4 ) + up * ( r2 * Hc * 0.1 );
			let vImp = up * sqrt( Hc * ( r3 * r3 * 0.95 + 0.35 ) * ${f(2 * GRAVITY)} ) + pl.n * 0.8 + d3 * ( c * ( r2 * 0.5 + 0.2 ) ) + tg * ( ( r1 - 0.5 ) * 1.2 );
			// the puff blown out of the collapsing barrel: out of the middle of the front, along the crest
			let fs = breakersFacePoint( C, r1 * 0.3 + 0.35 );
			let pSpit = fs.p + fs.n * ( sz * 0.5 );
			let vSpit = d3 * ( c * 0.7 ) + fs.n * 1.2 + tg * ( ( r1 - 0.5 ) * 4.0 );
			// the tumbling top of the roller
			let fr = breakersFacePoint( C, r1 * 0.4 );
			let pRol = fr.p + fr.n * ( sz * 0.4 );
			let vRol = d3 * ( c * 0.85 ) + up * ( r3 * 0.5 + 0.3 );
			let fc = breakersFacePoint( C, r1 * 0.5 + 0.3 );
			let pCl = fc.p + fc.n * ( sz * 0.5 );
			let vCl = up * ( ( r3 * 1.2 + 0.8 ) * sqrt( Hb / 0.4 ) ) + d3 * ( r2 - 0.3 );
			let p = select( select( select( pCl, pRol, isRol ), pSpit, isSpit ), pImp, isImp ) + breakersAlong( C, r0 );
			let v = select( select( select( vCl, vRol, isRol ), vSpit, isSpit ), vImp, isImp );
			let life = select( select( r3 * 0.3 + 0.5, 0.9, isSpit ), r3 * 0.5 + 1.0, isImp );
			sprayWrite( ring, p, v, sz, SPRAY_SPRAY, life, tag + r0 * 0.999 );
		}
	}

	// ---- mist: the fine spray that drifts off with the wind (and the air pushed by the wave)
	// (few, large, faint sprites: mist is the biggest overdraw of the spray)
	let m0 = breakersCount( haze * 5.0 * E + spit * 3.0 * E, gain, seed, 31u );
	// the lip feathers as it throws: a thin wisp torn off the crest and carried by the air
	let mL = breakersCount( lipShed * 1.6 * E, gain, seed, 33u );
	// the churning top of the bore smokes: a thin haze drifting off it softens its silhouette
	let m1 = m0 + breakersCount( roller * 4.5 * Eb, gain, seed, 32u );
	if ( mL > 0u ) {
		let base = sprayReserve( mL );
		for ( var j = 0u; j < mL; j++ ) {
			let ring = spraySlot( base, j );
			let h = seed + j * 23u;
			let r0 = sprayRand( h, 61u );
			let r1 = sprayRand( h, 62u );
			let r2 = sprayRand( h, 63u );
			let p = breakersTipAt( C, r1 * 0.4 ) + up * ( r2 * 0.1 ) + breakersAlong( C, r0 );
			let v = d3 * ( c * ( r1 * 0.2 + 0.85 ) ) + up * ( r2 * 0.8 + 0.3 );
			sprayWrite( ring, p, v, ( r2 * r2 * 0.2 + 0.1 ) * sqrt( Hc ), SPRAY_MIST, r1 * 0.8 + 0.7, tag + r0 * 0.999 );
		}
	}
	if ( m1 > 0u ) {
		let base = sprayReserve( m1 );
		for ( var j = 0u; j < m1; j++ ) {
			let ring = spraySlot( base, j );
			let h = seed + j * 17u;
			let r0 = sprayRand( h, 51u );
			let r1 = sprayRand( h, 52u );
			let r2 = sprayRand( h, 53u );
			let r3 = sprayRand( h, 54u );
			let isImp = j < m0;
			let pl = breakersPlunge( C, r1, r3 );
			let ft = breakersFacePoint( C, r1 * 0.3 );
			let p = select( ft.p + ft.n * 0.15 + up * ( r2 * r2 * Hb * 0.35 ), pl.p + pl.n * 0.2 + up * ( r2 * Hc * 0.4 ), isImp ) + breakersAlong( C, r0 );
			let v = select( d3 * ( c * ( r1 * 0.3 + 0.65 ) ) + up * ( r2 * 0.4 + 0.15 ), d3 * ( c * ( r1 * 0.3 + 0.4 ) ) + up * ( r3 * 0.9 + 0.4 ), isImp );
			let size = select( ( r3 * r3 * 0.35 + 0.18 ) * sqrt( max( Hb, 0.2 ) / 0.6 ), sqrt( Hc ) * ( r3 * 0.3 + 0.45 ), isImp );
			let life = select( r3 * r3 * 3.0 + 1.2, r3 * 1.5 + 2.5, isImp );
			sprayWrite( ring, p, v, size, SPRAY_MIST, life, tag + r0 * 0.999 );
		}
	}
}
`;

/**
 * FFT displacement at a Lagrangian point (the short cascades that survive in the surf zone), with
 * WaterSurface.cascadeAttenuation inlined (the long cascades vanish in shallow water): the body of a
 * WGSL function of ( p: vec2f, depth: f32 ) accumulating into `d` (oceanDisplacement, smpLinearRepeat).
 */
export function fftDispCode(fft) {
  let fftCode = "";
  for (let c = 1; c < fft.cascades; c++) {
    const L = fft.sizes[c];
    const texel = L / 256;
    const level = Math.max(Math.log2(0.35 / texel) + 0.7, 0);
    const d0 = Math.min(40, L * 0.08);
    const floorAmt = [0.0, 0.05, 0.25, 0.5][c] ?? 0.5;
    fftCode += `	d += textureSampleLevel( oceanDisplacement, smpLinearRepeat, p / ${f(L)}, ${c}, ${f(level)} ).xyz * mix( ${f(floorAmt)} * smoothstep( 0.0, 0.6, depth ), 1.0, smoothstep( 0.0, ${f(d0)}, depth ) );\n`;
  }
  return fftCode;
}

function crestKernelCode(fft) {
  const fftCode = fftDispCode(fft);
  const STEP = 2.0, K = 64; // transects: 128 m seaward from the shoreline
  return /* wgsl */`
const PI: f32 = 3.141592653589793;
fn sat( x: f32 ) -> f32 { return clamp( x, 0.0, 1.0 ); }
struct OpFrame { seaLevel: f32, time: f32, dt: f32, terrainSize: f32, maxHeight: f32, heightBase: f32, zenith: f32, pad: f32, windDir: vec2f, windSpeed: f32 };
var<private> frame: OpFrame;
// U0 ( seaLevel, time, dt, terrainSize )  U1 ( maxHeight, heightBase, flip, amplitude )  U2..U4 shore
// U5 ( station count, drop budget, spray gain, emit range )  U6 ( cameraPos, windSpeed )
// U7 ( windDir, frame seed, - )
@group( 0 ) @binding( 0 ) var<uniform> U: array<vec4f, 8>;
@group( 0 ) @binding( 1 ) var terrainHeight: texture_2d<f32>;
@group( 0 ) @binding( 2 ) var shoreTex: texture_2d<f32>;
@group( 0 ) @binding( 3 ) var oceanDisplacement: texture_2d_array<f32>;
@group( 0 ) @binding( 4 ) var smpLinearRepeat: sampler;
@group( 0 ) @binding( 5 ) var<storage, read> breakersStations: array<vec4f>;
@group( 0 ) @binding( 6 ) var breakersCrestW: texture_storage_2d<rgba32float, write>;
${SHARED_WGSL}
${shoreCode()}
${sprayEmitterWGSL(7, 8)}
const BRK_GRAVITY: f32 = ${f(GRAVITY)};

fn breakersFftDisp( p: vec2f, depth: f32 ) -> vec3f {
	var d = vec3f( 0.0 );
${fftCode}	return d * U[ 1 ].w;
}

// PORT: the crest record ( 3 texels per slot ) into the crest texture
fn breakersStore( i: u32, slot: u32, a: vec4f, b: vec4f, c: vec4f ) {
	textureStore( breakersCrestW, vec2u( slot * 3u, i ), a );
	textureStore( breakersCrestW, vec2u( slot * 3u + 1u, i ), b );
	textureStore( breakersCrestW, vec2u( slot * 3u + 2u, i ), c );
}

${EMIT_WGSL}

// One crest of wave m at Lagrangian point pc (station i): store the lip frame and emit spray.
fn breakersProcessCrest( i: u32, pc: vec2f, m: f32 ) {
	let ph = shorePhaseAt( pc, shoreTex );
	let dir = ph.dir;
	let along = ph.along;
	let ground = terrainHeightAt( pc, terrainHeight );
	let depth = frame.seaLevel - ground;
	let A = shoreWaveAmp( m, along );
	let cr = shoreCrest( A, depth ); // ( b, H, trough, lipThrow )
	let b = cr.x;
	let env = smoothstep( 26.0, 13.0, depth ) * sat( ph.exposure * 1.4 ) * shoreP.enabled;

	// followed from before it breaks until the bore reaches the shore (the lip sheet only uses b < 1.25)
	if ( b > -0.6 && env > 0.3 && depth > 0.12 ) {
		let c = sqrt( clamp( depth, 0.3, 25.0 ) * BRK_GRAVITY );
		let lam = c * shoreP.period;
		let s0 = shoreShape( 0.0, A, depth, lam );
		let ub = 0.4 / lam;
		let s1 = shoreShape( ub, A, depth, lam );
		let fd = breakersFftDisp( pc, depth );
		let d3 = vec3f( dir.x, 0.0, dir.y );
		let root = vec3f( pc.x, frame.seaLevel, pc.y ) + d3 * ( s0.x * env ) + vec3f( 0.0, s0.y * env, 0.0 ) + fd;
		let back = vec3f( pc.x, frame.seaLevel, pc.y ) + d3 * ( s1.x * env - 0.4 ) + vec3f( 0.0, s1.y * env, 0.0 ) + fd;
		let H = cr.y * env;
		let trough = frame.seaLevel + cr.z * env + fd.y;
		// slot by wave parity (neighbouring stations agree on it), id = wave index mod 1024, + 1 (0 = none)
		let slot = u32( m - floor( m * 0.5 ) * 2.0 );
		let id = m - floor( m / 1024.0 ) * 1024.0 + 1.0;
		breakersStore( i, slot, vec4f( root, b ), vec4f( back, H ), vec4f( dir, trough, id ) );
		breakersEmit( i, slot, root, dir, b, H, trough, c, m, depth, shoreBore( A, depth ) );
	}
}

@compute @workgroup_size( 64, 1, 1 )
fn main( @builtin( global_invocation_id ) gid: vec3u ) {
	let i = gid.x;
	if ( i >= ${CAP}u ) { return; }
	frame.seaLevel = U[ 0 ].x; frame.time = U[ 0 ].y; frame.dt = U[ 0 ].z; frame.terrainSize = U[ 0 ].w;
	frame.maxHeight = U[ 1 ].x; frame.heightBase = U[ 1 ].y; frame.zenith = U[ 1 ].z;
	frame.windDir = U[ 7 ].xy; frame.windSpeed = U[ 6 ].w;
	sprayFrameSeed = u32( U[ 7 ].z );
	shoreLoad( U[ 2 ], U[ 3 ], U[ 4 ] );
	// clear both slots
	breakersStore( i, 0u, vec4f( 0.0 ), vec4f( 0.0 ), vec4f( 0.0 ) );
	breakersStore( i, 1u, vec4f( 0.0 ), vec4f( 0.0 ), vec4f( 0.0 ) );
	if ( f32( i ) >= U[ 5 ].x ) { return; }
	let st = breakersStations[ i ];
	let o = st.xy;
	let n = st.zw; // toward the sea

	var sPrev = 0.0;
	for ( var k = 0; k < ${K}; k++ ) {
		let dist = f32( k ) * ${f(STEP)};
		let s = shorePhaseAt( o + n * dist, shoreTex ).s;
		// s grows seaward: a crest (integer phase) lies between this sample and the previous one
		if ( k > 0 && floor( s ) > floor( sPrev ) ) {
			let m = floor( s );
			// secant refinement on the exact phase
			var lo = dist - ${f(STEP)};
			var hi = dist;
			var sLo = sPrev;
			var sHi = s;
			var x = lo + ( m - sLo ) / max( sHi - sLo, 1e-5 ) * ${f(STEP)};
			for ( var it = 0; it < 2; it++ ) {
				let sx = shorePhaseAt( o + n * x, shoreTex ).s;
				if ( sx < m ) {
					lo = x;
					sLo = sx;
				} else {
					hi = x;
					sHi = sx;
				}
				x = lo + ( m - sLo ) / max( sHi - sLo, 1e-5 ) * ( hi - lo );
			}
			let pc = o + n * x;
			breakersProcessCrest( i, pc, m );
		}
		sPrev = s;
	}
}`;
}

// ------------------------------------------------------------------ the lip sheet (three material)

// PORT: Tidewater's lip vertex / output snippets as functions (the crest texture as a parameter)
const LIP_WGSL = /* wgsl */`
const BRK_LACE_TILE: f32 = ${f(LACE_TILE)};
const BRK_NV: f32 = ${f(NV)};

fn brkCrest( crest: texture_2d<f32>, station: u32, j: u32 ) -> vec4f {
	return textureLoad( crest, vec2i( i32( j ), i32( station ) ), 0 );
}

// columns: ( world position, fade ), ( normal, - ), vLip ( v, b, along, curtain length )
fn opLipVertex( gate: f32, id: vec4f, crest: texture_2d<f32> ) -> mat4x4f {
	let seg = u32( id.x );
	let slot = u32( id.y );
	let side = u32( id.z );
	let k = id.w;
	let st = seg + side;
	let ot = seg + ( 1u - side );
	let e = slot * 3u;
	let c0 = brkCrest( crest, st, e );
	let c1 = brkCrest( crest, st, e + 1u );
	let c2 = brkCrest( crest, st, e + 2u );
	let mOther = brkCrest( crest, ot, e + 2u ).w;
	let cOther = brkCrest( crest, ot, e );
	let bOther = cOther.w;
	// (the crests are followed until the bore reaches the shore; the sheet is gone after the plunge)
	// (both ends of a segment must pass the b test, else a vertex pair collapses to one side only)
	// PORT: and both ends on the same stretch of coast (stations of the GPU window are packed runs)
	let near = length( cOther.xz - c0.xz ) < ${f(SPACING * 6)};
	let valid = c2.w > 0.5 && abs( mOther - c2.w ) < 0.5 && c0.w < 1.25 && bOther < 1.25 && near;

	let root = c0.xyz;
	let b = c0.w;
	let back = c1.xyz;
	let H = c1.w;
	let d3 = vec3f( c2.x, 0.0, c2.y );
	let trough = c2.z;
	let q = clamp( b / 0.9, 0.0, 1.35 );
	let Xi = max( H * 0.8, 0.05 );
	let Yi = max( root.y - trough, 0.05 );
	// profile parameter: k = 0, 1 on the back of the crest (-1, -0.45), then 0..1 along the curtain
	let pv = select( select( ( k - 2.0 ) / ( BRK_NV - 3.0 ), -0.45, k < 1.5 ), -1.0, k < 0.5 );
	let xl = Xi * q * max( pv, 0.0 );
	let fl = xl / Xi;
	let yl = - Yi * ( fl * fl ); // ballistic: the jet leaves the crest horizontally
	let onLip = root + d3 * xl + vec3f( 0.0, yl, 0.0 );
	let onCap = mix( root, back, max( - pv, 0.0 ) ) + vec3f( 0.0, 0.012, 0.0 );
	let P = select( onLip, onCap, pv < 0.0 );
	// outward normal of the curtain (upper surface of the lip)
	let slope = Yi * 2.0 * xl / ( Xi * Xi );
	let N = normalize( vec3f( 0.0, 1.0, 0.0 ) + d3 * slope );
	let vLip = vec4f( pv, b, f32( st ) * ${f(SPACING)}, Xi * q + Yi * q * q ); // w: curtain length (m)
	// the cap fades in over the crest; the whole lip fades out once it has become whitewater
	let capA = smoothstep( -1.0, -0.1, pv );
	// once the jet has re-entered the water the curtain is gone (the splash and the roller take over)
	let fade = capA * smoothstep( 0.02, 0.12, q ) * ( 1.0 - smoothstep( 1.0, 1.2, b ) );
	let wp = select( vec3f( 0.0, -1e5, 0.0 ), P, valid );
	return mat4x4f( vec4f( wp, fade ), vec4f( N, 0.0 ), vLip, vec4f( 0.0 ) );
}

// PORT: Tidewater's lip output: returns ( colour, alpha ) as STRAIGHT alpha ( its ( col * a, aOut ) )
@diagnostic( off, derivative_uniformity )
fn opLipFragment( gate: f32, pos: vec3f, front: f32, lipN: vec3f, vLip: vec4f, vLipFade: f32, sheet: f32,
	brkLace: texture_2d<f32>, smpAnisoRepeat: sampler, cloudShadow: texture_2d<f32>, skyEnv: texture_2d<f32>, skyEnvS: sampler ) -> vec4f {
	let v = vLip.x;
	let b = vLip.y;
	let a = vLip.z;
	let len = vLip.w;
	let V = normalize( frame.cameraPos - pos );
	let Nw = normalize( lipN );
	let N0 = select( - Nw, Nw, front > 0.5 );
	let t = frame.time;
	// The water of the jet is stretched along the flow: streaks and ripples running down the
	// curtain (the lace pattern stretched ~8x along the jet and moving with it)
	let flowS = v * len - t * 1.1;
	// along-crest coordinate warped by low-frequency noise
	let aw = a + sin( a * 0.23 + 1.7 ) * 1.6 + sin( a * 0.61 + 4.2 ) * 0.4 + sin( a * 1.37 + 0.4 ) * 0.12;
	let sv = textureSample( brkLace, smpAnisoRepeat, vec2f( aw / 0.83, flowS / 3.0 ) );
	// and broad bands (sections of the lip thicker or thinner than others), visible from afar
	let sbv = textureSample( brkLace, smpAnisoRepeat, vec2f( aw / 2.9, flowS / 9.0 ) + vec2f( 0.37, 0.61 ) );
	let sb = sbv.z;
	let hS = sv.x * 0.02 + sv.z * 0.012;
	let dpx = dpdx( pos );
	let dpy = dpdy( pos );
	let r1 = cross( dpy, N0 );
	let r2 = cross( N0, dpx );
	let det = dot( dpx, r1 );
	let grad = ( r1 * dpdx( hS ) + r2 * dpdy( hS ) ) * sign( det );
	let N = normalize( N0 * abs( det ) - grad + N0 * 1e-9 );
	let NdV = max( dot( N, V ), 1e-3 );
	let F = fresnelDielectric( NdV, 1.333 );
	let L = frame.sunDir;
	let sun = frame.sunColor * cloudsShadow( pos.xz, cloudShadow );

	// reflection: sky + sun glint
	let Rr = reflect( - V, N );
	let R = normalize( vec3f( Rr.x, max( Rr.y, 0.004 ), Rr.z ) );
	let refl = skyReflectionRadiance( R, skyEnv, skyEnvS );
	let Hh = normalize( L + V );
	let spec = sun * ( pow( max( dot( N, Hh ), 0.0 ), 180.0 ) * 12.0 ) * F;

	// light through the thin sheet: turquoise when backlit
	let tint = vec3f( 0.16, 0.62, 0.56 );
	let back = pow( sat( dot( - V, L ) * 0.5 + 0.5 ), 4.0 );
	let thin = mix( 1.5, 0.7, v ) * ( sv.z * 0.3 + 0.8 ) * ( sb * 0.8 + 0.6 );
	let glow = ( sun * tint * ( back * 0.9 + 0.08 ) + frame.skyIrradiance * tint * 1.4 ) * thin;
	let aW = F + min( ( 1.0 - F ) * mix( 0.42, 0.16, v ) * ( sv.x * 0.5 + 0.75 ) * ( sb * 0.7 + 0.65 ), 0.85 );
	let cW = refl * F + spec + glow * ( 1.0 - F ) * 0.42;

	// The jet stays clear, glassy water while it is in the air: only its leading edge tears into
	// aerated fingers. Sections of the lip differ a little.
	let flowM = v * len - t * 1.1;
	let fuv = vec2f( aw / 1.9 + 0.53, flowM / 1.8 );
	let fl = textureSample( brkLace, smpAnisoRepeat, fuv );
	let sect = fl.z;
	let vary = sect - 0.5 + sin( aw * 0.29 + b * 2.1 ) * 0.15;
	let tipN = sin( aw * 1.3 + t * 0.3 ) * 0.6 + sin( aw * 4.7 + 1.3 ) * 0.4;
	let edge = v + tipN * 0.03 + vary * 0.04;
	let thrown = smoothstep( 0.35, 0.8, b );
	let rim = smoothstep( 0.9, 0.96, edge ) * ( fl.z * 0.2 + 0.2 ) * thrown;
	let fing = ( sv.w * 0.55 + sv.z * 0.2 ) * ( smoothstep( 0.25, 0.75, sbv.w * 0.6 + sb * 0.4 ) * 0.8 + 0.2 ) * 0.34;
	let wh = smoothstep( ( 1.0 - v ) * 0.18 + 0.9 - fing, ( 1.0 - v ) * 0.18 + 1.0 - fing, b ); // from the tip up
	let lc = textureSample( brkLace, smpAnisoRepeat, vec2f( aw * 0.83 + 1.9, v * len - t * 1.3 ) / ( BRK_LACE_TILE * 0.8 ) );
	let blot = lc.z * 0.7 + lc.y * 0.3;
	let gone = smoothstep( 1.0, 1.25, b );
	let clumpW = smoothstep( gone - 0.12, gone + 0.12, blot );
	let clumps = sat( ( blot - gone ) * 2.5 );
	let fil = ( 1.0 - smoothstep( 0.02, 0.12, sv.x ) ) * smoothstep( 0.15, 0.8, v ) * ( sv.w * 0.5 + 0.25 ) * ( sb * 0.9 + 0.3 ) * thrown;
	let aer = mix( max( rim, fil ), 0.95, wh );
	// aerated water is a dense scatterer: bright from every side, glowing when backlit
	let foamLit = ( sun * ( max( dot( N, L ), 0.0 ) * 0.5 + 0.5 + back * 1.2 ) / PI + frame.skyIrradiance ) * 0.9;

	let tip = 1.0 - smoothstep( 0.93, 1.0, edge );
	let alpha = vLipFade * tip * sheet * mix( 1.0, clumpW, wh );
	let aF = aer * 0.92;
	let col = foamLit * mix( 1.0, clumps * 0.4 + 0.75, wh ) * aF + cW * ( 1.0 - aF );
	let aOut = ( aF + aW * ( 1.0 - aF ) ) * alpha;
	// PORT: straight alpha: ( col * alpha ) / aOut over the water with weight aOut
	return vec4f( col * alpha / max( aOut, 1e-4 ), aOut );
}
`;

export class OceanProBreakers {
  /**
   * @param {object} o renderer, scene, fft, shader ( buildOceanProShader's result: its `all` include
   *   and loadFn ), gate ( (loadFn) => the ocean's opLoad call ), textures: { cloud, sky, clamp }
   */
  constructor({ renderer, scene, fft, spray }) {
    this.renderer = renderer;
    this.spray = spray;
    this.device = renderer.backend.device;
    this.fft = fft;
    this.scene = scene;
    this.runs = [];
    this.stationData = new Float32Array(CAP * 4);
    this.count = 0;
    this.sheet = uniform(1);

    const dev = this.device;
    this.stations = dev.createBuffer({ label: "oceanpro breaker stations", size: CAP * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this._ubo = new Float32Array(32);
    this.uniformBuffer = dev.createBuffer({ label: "oceanpro breakers", size: this._ubo.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.crest = new THREE.StorageTexture(6, CAP);
    this.crest.name = "oceanpro breaker crests";
    this.crest.type = THREE.FloatType;
    this.crest.format = THREE.RGBAFormat;
    this.crest.magFilter = this.crest.minFilter = THREE.NearestFilter;
    this.crest.generateMipmaps = false;
    renderer.initTexture(this.crest);
    this.dispSampler = dev.createSampler({ addressModeU: "repeat", addressModeV: "repeat", magFilter: "linear", minFilter: "linear", mipmapFilter: "linear" });
    const code = crestKernelCode(fft);
    this.pipeline = dev.createComputePipeline({
      label: "OceanPro Surf Crests", layout: "auto",
      compute: { module: dev.createShaderModule({ label: "oceanpro surf crests", code }), entryPoint: "main" },
    });
    this._bindRefs = null;
    this.lace = makeLaceTexture();
    this.mesh = null;
  }

  /** The lip mesh, built on the ocean's shader (its common WGSL and uniform gate). */
  buildMesh({ all, loadFn, gate, cloudNode, skyNode, clampNode }) {
    const nSeg = CAP - 1;
    const vertsPerStrip = NV * 2;
    const nStrips = nSeg * 2;
    const ids = new Float32Array(nStrips * vertsPerStrip * 4);
    const pos = new Float32Array(nStrips * vertsPerStrip * 3);
    const index = new Uint32Array(nStrips * (NV - 1) * 6);
    let p = 0, q = 0;
    for (let seg = 0; seg < nSeg; seg++) for (let slot = 0; slot < 2; slot++) {
      const v0 = (seg * 2 + slot) * vertsPerStrip;
      for (let side = 0; side < 2; side++) for (let k = 0; k < NV; k++) {
        ids[p++] = seg; ids[p++] = slot; ids[p++] = side; ids[p++] = k;
      }
      for (let k = 0; k < NV - 1; k++) {
        const a = v0 + k, b = v0 + k + 1, c = v0 + NV + k, d = v0 + NV + k + 1;
        index[q++] = a; index[q++] = c; index[q++] = b;
        index[q++] = b; index[q++] = c; index[q++] = d;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("sheetId", new THREE.BufferAttribute(ids, 4));
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);

    const vertexFn = wgslFn(`fn opLipVertexCall( gate: f32, id: vec4f, crest: texture_2d<f32> ) -> mat4x4f { return opLipVertex( gate, id, crest ); }`, [all, this._lipCode ??= LIP_CODE()]);
    const fragmentFn = wgslFn(`fn opLipFragmentCall( gate: f32, pos: vec3f, front: f32, lipN: vec3f, vLip: vec4f, vLipFade: f32, sheet: f32,
	brkLace: texture_2d<f32>, smpAnisoRepeat: sampler, cloudShadow: texture_2d<f32>, skyEnv: texture_2d<f32>, skyEnvS: sampler ) -> vec4f {
	return opLipFragment( gate, pos, front, lipN, vLip, vLipFade, sheet, brkLace, smpAnisoRepeat, cloudShadow, skyEnv, skyEnvS );
}`, [all, this._lipCode]);

    const crestNode = texture(this.crest);
    const laceNode = texture(this.lace.tex);
    const vP = varyingProperty("vec4", "vLipP");
    const vN = varyingProperty("vec4", "vLipN");
    const vL = varyingProperty("vec4", "vLip");
    const m = new THREE.MeshBasicNodeMaterial();
    m.name = "OceanProBreakerLip";
    m.transparent = true;
    m.depthWrite = false;
    m.depthTest = true;
    m.side = THREE.DoubleSide;
    m.fog = true;
    m.positionNode = Fn(() => {
      const out = vertexFn(gate(loadFn), attribute("sheetId", "vec4"), crestNode).toVar();
      vP.assign(out.element(0));
      vN.assign(out.element(1));
      vL.assign(out.element(2));
      return out.element(0).xyz;
    })();
    const res = fragmentFn(gate(loadFn), vP.xyz, select(frontFacing, float(1), float(0)), vN.xyz, vL, vP.w, this.sheet,
      laceNode, sampler(laceNode), cloudNode, skyNode, sampler(clampNode)).toVar();
    m.colorNode = res.xyz;
    m.opacityNode = res.w;
    const mesh = new THREE.Mesh(geo, m);
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    // over the water (it is blended onto it)
    mesh.renderOrder = 60;
    mesh.name = "OceanProBreakerLips";
    if (this.mesh) { this.scene.remove(this.mesh); this.mesh.material.dispose(); this.mesh.geometry.dispose(); }
    this.mesh = mesh;
    this.scene.add(mesh);
    return mesh;
  }

  /** The coastline stations (all of them, CPU): rebuilt when the shore field is. */
  setCoast(runs) {
    this.runs = runs;
    this._lastFocus = null;
  }

  /** Put the stations nearest `focus` (world xz) on the GPU: whole runs, nearest first, up to CAP. */
  _select(focus, radius = 260) {
    if (this._lastFocus && this._lastFocus.distanceTo(focus) < 20) return;
    this._lastFocus = focus.clone();
    const r2 = radius * radius;
    const parts = [];
    for (const run of this.runs) {
      // the stretch of this run inside the radius (contiguous pieces)
      let start = -1;
      const n = run.length / 4;
      for (let i = 0; i <= n; i++) {
        const inside = i < n && ((run[i * 4] - focus.x) ** 2 + (run[i * 4 + 1] - focus.y) ** 2) < r2;
        if (inside && start < 0) start = i;
        if (!inside && start >= 0) {
          let dmin = Infinity;
          for (let k = start; k < i; k++) dmin = Math.min(dmin, (run[k * 4] - focus.x) ** 2 + (run[k * 4 + 1] - focus.y) ** 2);
          parts.push({ run, a: start, b: i, d: dmin });
          start = -1;
        }
      }
    }
    parts.sort((u, v) => u.d - v.d);
    let c = 0;
    for (const pt of parts) {
      const take = Math.min(pt.b - pt.a, CAP - c);
      if (take <= 0) break;
      this.stationData.set(pt.run.subarray(pt.a * 4, (pt.a + take) * 4), c * 4);
      c += take;
    }
    this.count = c;
    this.device.queue.writeBuffer(this.stations, 0, this.stationData, 0, Math.max(c, 1) * 4);
    // only the segments between live stations are drawn
    if (this.mesh) this.mesh.geometry.setDrawRange(0, Math.max(0, c - 1) * 2 * (NV - 1) * 6);
  }

  /** o: focus (Vector2), dt, time, seaLevel, terrainSize, maxHeight, heightBase, flip, shore, heightTexture, fieldTexture. */
  update(o) {
    if (!this.runs.length) { this.count = 0; }
    else this._select(o.focus);
    const r = this.renderer;
    const gpu = (t) => r.backend.get(t)?.texture;
    const hT = gpu(o.heightTexture), fT = gpu(o.fieldTexture), dT = gpu(this.fft.displacementTexture), cT = gpu(this.crest);
    if (!hT || !fT || !dT || !cT) return;
    const sp = this.spray;
    const sT = gpu(sp.target);
    if (!sT) return;
    // one bind group per spray target (the ring's ping-pong), rebuilt when an input changes
    const refs = [hT, fT, dT, cT];
    if (!this._bindRefs || refs.some((t, i) => t !== this._bindRefs[i])) { this._bindRefs = refs; this._binds = new Map(); }
    if (!this._binds.has(sT)) {
      this._binds.set(sT, this.device.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.uniformBuffer } },
          { binding: 1, resource: hT.createView() },
          { binding: 2, resource: fT.createView() },
          { binding: 3, resource: dT.createView({ dimension: "2d-array" }) },
          { binding: 4, resource: this.dispSampler },
          { binding: 5, resource: { buffer: this.stations } },
          { binding: 6, resource: cT.createView() },
          { binding: 7, resource: { buffer: sp.head } },
          { binding: 8, resource: sT.createView() },
        ],
      }));
    }
    const u = this._ubo;
    u.set([o.seaLevel, o.time, Math.max(o.dt, 1e-4), o.terrainSize, o.maxHeight, o.heightBase, o.flip ? 1 : 0, 1], 0);
    u.set(o.shore[0], 8); u.set(o.shore[1], 12); u.set(o.shore[2], 16);
    u.set([this.count, sp.budget, o.sprayGain ?? 0, o.emitRange ?? 240], 20);
    u.set([o.cameraPos.x, o.cameraPos.y, o.cameraPos.z, o.windSpeed ?? 0], 24);
    u.set([o.windDir?.x ?? 1, o.windDir?.y ?? 0, sp.frameSeed, 0], 28);
    this.device.queue.writeBuffer(this.uniformBuffer, 0, u);
    const enc = this.device.createCommandEncoder({ label: "oceanpro surf crests" });
    const pass = enc.beginComputePass({ label: "OceanPro Surf Crests" });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this._binds.get(sT));
    pass.dispatchWorkgroups(Math.ceil(CAP / 64), 1, 1);
    pass.end();
    this.device.queue.submit([enc.finish()]);
  }

  setVisible(on) { if (this.mesh) this.mesh.visible = !!on && this.count > 1; }

  dispose() {
    this.stations.destroy();
    this.uniformBuffer.destroy();
    this.crest.dispose();
    if (this.mesh) { this.scene.remove(this.mesh); this.mesh.material.dispose(); this.mesh.geometry.dispose(); }
  }
}

// (a function so the include is one CodeNode per breakers instance)
function LIP_CODE() { return wgsl(threeWgsl(LIP_WGSL)); }
