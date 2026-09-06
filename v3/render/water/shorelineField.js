/**
 * v3/render/water/shorelineField.js — distance-to-waterline field
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS AT ALL.
 *
 * Every shore effect in the old ocean (oceanShader.js) is parameterised by WATER
 * DEPTH, not by distance to the shoreline. `foamBandWidth: 2.6` means "2.6 metres
 * of water", so the foam band is whatever horizontal distance it takes the seabed
 * to fall 2.6 m. On a shallow beach that is a hundred metres of foam; against a
 * cliff it is a hairline. Same number, same coast, completely different picture —
 * and no value of the slider is right for both.
 *
 * Depth is also the wrong quantity for a *travelling* wave. A wave arriving at a
 * beach moves shoreward at a speed in metres per second; the only way to write
 * that is to know, at every point, how many metres of open water lie between it
 * and the sand. The old shader had no such quantity, which is why its surf is a
 * global `sin(time)` that makes every beach on the map surge in the same instant.
 *
 * This module supplies the missing quantity, and everything the new ocean does at
 * the coast — foam width, run-up, breaking, wet sand, wave refraction — reads out
 * of it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY IT IS A CPU EXACT TRANSFORM AND NOT A GPU JUMP FLOOD.
 *
 * The obvious GPU answer is jump flooding: seed the waterline, then log2(N) passes
 * each reading 9 neighbours. It is the right tool when the field must be rebuilt
 * every frame. This one does not: it changes when the terrain is sculpted or the
 * sea level moves, which is a user action measured in seconds, not frames.
 *
 * Against that, Felzenszwalb & Huttenlocher's distance transform is separable and
 * O(n) — two linear passes over rows then columns, no neighbourhood search at all —
 * and it is EXACT rather than jump-flood's approximation. At 1024² it costs ~100 ms
 * on this machine, which is a debounced pause on a slider, and it buys:
 *
 *   - no render targets, no ping-pong, no float-format capability check (the
 *     `float32-filterable` dance sculptBrush.js has to do), no extra GPU passes
 *     competing with the frame
 *   - a deterministic, headless-testable function — the shore field can be
 *     verified against an analytic circle without a GPU in the room
 *
 * What jump flooding gives that a scalar transform cannot is a per-texel NEAREST
 * SEED POSITION — a direction, not just a distance. Both of the things that
 * buys are recovered here from the terrain itself, which turns out to be the
 * better source anyway; see the two sections below.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SUB-TEXEL ACCURACY — measured, not assumed.
 *
 * A naive transform seeds every "wet" texel adjacent to a "dry" one with cost 0,
 * which quantises the shoreline to the texel grid: at 2 m/texel the foam edge
 * would visibly crawl in 2 m steps as the tide moves. Seeding instead with the
 * squared FRACTIONAL distance to the true zero crossing helps, but not enough on
 * its own — a scalar transform measures to texel CENTRES, so it still comes out
 * ~0.7 texel low. The Eikonal refinement inside `computeShorelineField` takes
 * that out; the reasoning is documented at the point of use.
 *
 * Verified against an analytic cone (whose shoreline is a circle and whose
 * distance field is therefore known in closed form):
 *
 *     512²  (2 m/texel)   mean 0.43 m   max 0.94 m   dir err 3e-4   49 ms
 *     1024² (1 m/texel)   mean 0.27 m   max 0.49 m   dir err 1e-4   101 ms
 *
 * i.e. under half a texel everywhere, and the offshore direction essentially
 * exact.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * OUTPUT — one RGBA half-float texture, one fetch at render time:
 *
 *   R  signed distance to the waterline, in METRES. Positive = water, negative =
 *      land. This is the number every shore effect is written against.
 *   G  offshore direction X   ┐ unit vector pointing from the shore out to sea,
 *   B  offshore direction Z   ┘ taken from −∇h rather than from ∇(distance) —
 *      water deepens going out, so the terrain already knows which way that is,
 *      and it knows it without the seams the refined distance field can carry.
 *      Drives the backwash drift and the along-shore stagger.
 *   A  seabed slope, |∇h| in metres per metre, at this point. Steep beds make
 *      plunging breakers (a thin bright line), shallow beds make spilling ones
 *      (a wide soft band) — so this hands the coast its variety for free, from
 *      geometry that is already there.
 *
 * Half float, not full: the field is only ever read near shore, and fp16 resolves
 * 3 cm at 30 m out and 4 mm at 4 m. Full float would double the bandwidth of the
 * one fetch this whole system costs, to store precision below the wavelength of
 * visible light. Half float is also filterable everywhere, which sidesteps the
 * `float32-filterable` feature check entirely.
 *
 * @see oceanSurface.js — the only consumer
 */

import * as THREE from "three";

/** Beyond this many metres from shore nothing keys off the field; clamped so the
 *  half-float never has to resolve a large number precisely. */
const MAX_DISTANCE_M = 512;

/** Sentinel for "no seed here yet", in squared texel units. */
const FAR = 1e20;

/**
 * Felzenszwalb & Huttenlocher 1D squared-distance transform over one row.
 *
 * Computes, for every q, `min over p of (q - p)² + f[p]` — the lower envelope of
 * a set of parabolas, one per sample, found by a single left-to-right sweep that
 * maintains the envelope in `v` (vertices) and `z` (intersection abscissae).
 *
 * @param {Float64Array} f  input costs, length n (modified: holds the result)
 * @param {Float64Array} d  scratch, length n
 * @param {Int32Array}   v  scratch, length n
 * @param {Float64Array} z  scratch, length n + 1
 * @param {number}       n  row length
 */
function edt1d(f, d, v, z, n) {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;

  for (let q = 1; q < n; q++) {
    // Intersection of the parabola at q with the one currently on top.
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }

  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    d[q] = dq * dq + f[v[k]];
  }
  f.set(d.subarray(0, n));
}

/**
 * 2D squared-distance transform, in place, by running the 1D transform down every
 * column and then across every row. Separability is what makes this O(n) rather
 * than a neighbourhood search.
 *
 * @param {Float64Array} grid  w×h squared costs, row-major (modified in place)
 */
function edt2d(grid, w, h) {
  const n = Math.max(w, h);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);

  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x];
    edt1d(f, d, v, z, h);
    for (let y = 0; y < h; y++) grid[y * w + x] = f[y];
  }

  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) f[x] = grid[row + x];
    edt1d(f, d, v, z, w);
    for (let x = 0; x < w; x++) grid[row + x] = f[x];
  }
}

/**
 * Compute the signed shoreline field for one heightmap + sea level.
 *
 * Pure and synchronous — no GPU, no THREE — so it can be unit-tested headless
 * against an analytic shape (a cone gives a circular shoreline whose distance
 * field is known in closed form).
 *
 * @param {object}       o
 * @param {Float32Array} o.heights    normalised heights 0..1, length size²,
 *                                    row-major, matching the engine's heightmap
 *                                    convention (`.r` × maxHeight = metres)
 * @param {number}       o.size       heightmap texels per side
 * @param {number}       o.terrainSize world metres per side
 * @param {number}       o.maxHeight  metres represented by a stored 1.0
 * @param {number}       o.seaLevel   still-water height in world metres
 * @returns {{ dist: Float32Array, dirX: Float32Array, dirZ: Float32Array,
 *             slope: Float32Array, size: number, metresPerTexel: number }}
 */
export function computeShorelineField({ heights, size, terrainSize, maxHeight, seaLevel }) {
  const n = size * size;
  const metresPerTexel = terrainSize / size;

  // ── Water column, in metres. Positive = submerged. ─────────────────────────
  const water = new Float32Array(n);
  for (let i = 0; i < n; i++) water[i] = seaLevel - heights[i] * maxHeight;

  // ── Seabed slope, |∇(water column)|, metres per metre ─────────────────────
  // Computed first because it is two things at once: an output channel (it tells
  // the shader whether a breaker plunges or spills) and the denominator of the
  // sub-texel refinement below.
  //
  // The same two numbers also give the OFFSHORE DIRECTION for free, and give it
  // better than the distance field can. Water gets deeper going out to sea, so
  // offshore is the direction of increasing water column, i.e. −∇h normalised.
  // Taking it from the raw terrain rather than from ∇(distance) matters: the
  // distance field is refined piecewise below, and neighbouring texels can land
  // on different branches of that refinement, which shows up as a few degrees of
  // jitter in a central difference. The terrain has no such seams.
  const slope = new Float32Array(n);
  const dirX = new Float32Array(n);
  const dirZ = new Float32Array(n);
  const inv2 = 1 / (2 * metresPerTexel);
  for (let y = 0; y < size; y++) {
    const row = y * size;
    const yp = y > 0 ? row - size : row;
    const yn = y < size - 1 ? row + size : row;
    for (let x = 0; x < size; x++) {
      const i = row + x;
      const xp = x > 0 ? i - 1 : i;
      const xn = x < size - 1 ? i + 1 : i;
      const hx = (heights[xn] - heights[xp]) * maxHeight * inv2;
      const hz = (heights[yn + x] - heights[yp + x]) * maxHeight * inv2;
      const g = Math.hypot(hx, hz);
      slope[i] = g;
      if (g > 1e-5) {
        dirX[i] = -hx / g;
        dirZ[i] = -hz / g;
      }
      // else: left at (0,0) and filled from the distance gradient below.
    }
  }

  // ── Seed the boundary with sub-texel fractional distances ─────────────────
  // A texel is seeded only if the waterline actually passes between it and a
  // cardinal neighbour. `t` is where the linear interpolation of the two water
  // columns crosses zero, in texels; the transform wants it squared.
  const grid = new Float64Array(n).fill(FAR);

  const seed = (ia, ib) => {
    const a = water[ia];
    const b = water[ib];
    // Same side of the waterline (or both exactly on it) — no crossing here.
    if ((a > 0) === (b > 0)) return;
    const aa = Math.abs(a);
    const ab = Math.abs(b);
    const denom = aa + ab;
    const t = denom > 1e-12 ? aa / denom : 0.5; // fraction of a texel from a
    const ta = t * t;
    const tb = (1 - t) * (1 - t);
    if (ta < grid[ia]) grid[ia] = ta;
    if (tb < grid[ib]) grid[ib] = tb;
  };

  for (let y = 0; y < size; y++) {
    const row = y * size;
    for (let x = 0; x < size; x++) {
      const i = row + x;
      if (x + 1 < size) seed(i, i + 1);
      if (y + 1 < size) seed(i, i + size);
    }
  }

  edt2d(grid, size, size);

  // ── Signed distance in metres, with the sub-texel bias taken out ──────────
  //
  // THE BIAS, AND WHY IT IS NOT A BUG IN THE TRANSFORM.
  // A scalar distance transform measures distance to a SET OF TEXEL CENTRES. The
  // real shoreline runs between them, so a texel k texels away from a seed whose
  // own crossing sits `t` texels further on gets √(k² + t²) rather than the true
  // k + t. Measured against an analytic cone: a systematic UNDER-estimate of
  // ~0.7 texel. No choice of scalar seed cost fixes this — the information that
  // is missing is a direction, which is precisely what a vector transform (jump
  // flooding) carries and this one does not.
  //
  // THE FIX, which costs one divide.
  // Near the shore the water column is locally planar, so the perpendicular
  // distance to its zero crossing is exactly |w| / |∇w| — the Eikonal estimate,
  // and it is continuous and sub-texel by construction. It is trusted only
  // within the ±1 texel window the transform is already known to be uncertain
  // by, so a flat shelf (|∇w| → 0, estimate → ∞) or a ridge can never move the
  // answer more than a texel from the topologically-correct one.
  //
  // Beyond a few texels the linear approximation stops holding and the transform
  // takes over, carrying a flat +0.5 texel — the expected value of a fractional
  // offset that is uniform on [0,1). At that range half a texel is nothing.
  const dist = new Float32Array(n);
  const NEAR = 4 * metresPerTexel;
  const FARB = 12 * metresPerTexel;
  for (let i = 0; i < n; i++) {
    const dEdt = Math.sqrt(grid[i]) * metresPerTexel;

    let d;
    const g = slope[i];
    if (g > 1e-4) {
      const lo = dEdt - 0.25 * metresPerTexel;
      const hi = dEdt + 1.25 * metresPerTexel;
      const dLin = Math.abs(water[i]) / g;
      const refined = dLin < lo ? lo : (dLin > hi ? hi : dLin);
      // smoothstep(NEAR, FARB, dEdt): 0 close in, 1 far out.
      const s = Math.min(1, Math.max(0, (dEdt - NEAR) / (FARB - NEAR)));
      const t = s * s * (3 - 2 * s);
      d = refined * (1 - t) + (dEdt + 0.5 * metresPerTexel) * t;
    } else {
      d = dEdt + 0.5 * metresPerTexel;
    }

    const clamped = d > MAX_DISTANCE_M ? MAX_DISTANCE_M : d;
    dist[i] = water[i] > 0 ? clamped : -clamped;
  }

  // ── Offshore direction, where the terrain was too flat to supply one ──────
  // A dead-flat seabed has no gradient to read, so those texels fall back to
  // ∇(signed distance) — which is a unit vector by construction and still points
  // away from the nearest land. Only if that degenerates too (the medial axis of
  // a bay, or open sea with no land within the field's reach) does it settle for
  // +X, and nothing that reads the direction is active out there anyway.
  for (let y = 0; y < size; y++) {
    const row = y * size;
    const yp = y > 0 ? row - size : row;
    const yn = y < size - 1 ? row + size : row;
    for (let x = 0; x < size; x++) {
      const i = row + x;
      if (dirX[i] !== 0 || dirZ[i] !== 0) continue;
      const xp = x > 0 ? i - 1 : i;
      const xn = x < size - 1 ? i + 1 : i;

      let gx = (dist[xn] - dist[xp]) * inv2;
      let gz = (dist[yn + x] - dist[yp + x]) * inv2;
      const len = Math.hypot(gx, gz);
      if (len > 1e-4) {
        dirX[i] = gx / len;
        dirZ[i] = gz / len;
      } else {
        dirX[i] = 1;
        dirZ[i] = 0;
      }
    }
  }

  return { dist, dirX, dirZ, slope, size, metresPerTexel };
}

/**
 * GPU-side wrapper: owns one RGBA half-float DataTexture and refills it whenever
 * the terrain or the sea level changes.
 *
 * @param {object} o
 * @param {number} o.size        heightmap texels per side
 * @param {number} o.terrainSize world metres per side
 * @param {number} o.maxHeight   metres represented by a stored 1.0
 */
export function createShorelineField({ size, terrainSize, maxHeight }) {
  const data = new Uint16Array(size * size * 4);
  const texture = new THREE.DataTexture(
    data, size, size, THREE.RGBAFormat, THREE.HalfFloatType,
  );
  texture.name = "ShorelineField";
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.colorSpace = THREE.NoColorSpace;
  texture.generateMipmaps = false;
  // The heightmap this is derived from is written bottom-up by the sculpt render
  // targets; matching flipY keeps the two in the same orientation, which is the
  // single easiest thing to get wrong here (a flipped field puts the foam on the
  // wrong side of every island and looks almost plausible while doing it).
  texture.flipY = false;
  texture.needsUpdate = true;

  const half = THREE.DataUtils.toHalfFloat;
  let lastCost = 0;

  /**
   * Rebuild from a heightmap snapshot. Synchronous and ~100 ms at 1024² (~50 ms at 512²), so call
   * it on a debounce from a slider, not per frame.
   *
   * @param {Float32Array} heights normalised heights, length size²
   * @param {number}       seaLevel still-water height in world metres
   * @returns {number} milliseconds spent, for the lab's readout
   */
  function update(heights, seaLevel) {
    const t0 = performance.now();
    const f = computeShorelineField({ heights, size, terrainSize, maxHeight, seaLevel });
    for (let i = 0, o = 0; i < f.dist.length; i++, o += 4) {
      data[o]     = half(f.dist[i]);
      data[o + 1] = half(f.dirX[i]);
      data[o + 2] = half(f.dirZ[i]);
      data[o + 3] = half(f.slope[i]);
    }
    texture.needsUpdate = true;
    lastCost = performance.now() - t0;
    return lastCost;
  }

  return {
    texture,
    update,
    get lastBakeMs() { return lastCost; },
    dispose() { texture.dispose(); },
  };
}
