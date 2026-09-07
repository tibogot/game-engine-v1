/**
 * v3/tools/riverV2Channel.js — the River v2 solver.
 *
 * Pure maths: nodes in, stations out. No THREE render objects, no GPU, no DOM,
 * so it can be run headlessly and checked against hand-computed numbers.
 *
 * The model, in one paragraph. A river is a list of NODES, each carrying a
 * position, a channel shape (width / depth / bank) and a water level that is
 * either AUTO (dropped onto the local valley floor) or PINNED (the author's
 * number). The solver walks a Catmull-Rom centreline through the nodes, lays
 * out evenly spaced STATIONS along it, and interpolates every per-node quantity
 * across them with a monotone cubic — monotone specifically so that a cubic can
 * never overshoot between two nodes and invent a puddle the author never asked
 * for, or a negative width. Velocity then falls out of the solved profile via
 * Manning, so a reach that steepens or narrows speeds up on its own.
 *
 * What is deliberately NOT here: any reading of the terrain except to place AUTO
 * node levels. Between nodes the profile is the author's curve, not a trace of
 * the ground. That is the whole point — the terrain conforms to this, and a
 * profile that re-derived itself from the ground could never be lifted.
 */

import * as THREE from "three";

/** Below this a river cannot be solved at all. */
export const MIN_NODES = 2;

/** Hard ceilings, so a pathological spline cannot allocate unbounded memory. */
const MAX_STATIONS = 2048;
const MAX_SUB = 256;

/**
 * Monotone cubic (Fritsch-Carlson / PCHIP) interpolant through (xs, ys).
 *
 * Chosen over Catmull-Rom for the profile because an interpolating cubic
 * overshoots: two nodes at 20 m with a third at 12 m produce a curve that dips
 * below 12 m between them. On a water surface that overshoot is a hole the
 * conform then digs, and it appears nowhere in the author's input. The monotone
 * limiter removes it by construction, at the cost of slightly flatter joins.
 *
 * @param {number[]} xs strictly increasing
 * @param {number[]} ys
 * @returns {(x:number)=>number}
 */
export function monotoneCubic(xs, ys) {
  const n = xs.length;
  if (n === 0) return () => 0;
  if (n === 1) return () => ys[0];

  const h = new Float64Array(n - 1);
  const d = new Float64Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    h[i] = Math.max(xs[i + 1] - xs[i], 1e-9);
    d[i] = (ys[i + 1] - ys[i]) / h[i];
  }

  const m = new Float64Array(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    // A sign change means this node is a local extremum: flat tangent, or the
    // curve would swing past it.
    if (d[i - 1] * d[i] <= 0) m[i] = 0;
    else m[i] = (d[i - 1] + d[i]) * 0.5;
  }
  // Fritsch-Carlson limiter: no tangent may exceed 3x the smaller neighbouring
  // secant, which is the exact condition for the segment to stay monotone.
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }

  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    // Binary search for the containing span.
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] > x) hi = mid; else lo = mid;
    }
    const t = (x - xs[lo]) / h[lo];
    const t2 = t * t;
    const t3 = t2 * t;
    // Hermite basis.
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    return h00 * ys[lo] + h10 * h[lo] * m[lo] + h01 * ys[lo + 1] + h11 * h[lo] * m[lo + 1];
  };
}

/**
 * Densely sample the centreline and return the polyline plus, for each node,
 * the arc length at which it sits.
 *
 * Catmull-Rom passes through its control points at t = k/(n-1), so sampling a
 * multiple of (n-1) divisions lands a sample exactly on every node — that is
 * how the node arc lengths come out exact rather than snapped to the nearest
 * sample.
 */
function sampleCenterline(nodes, spacing) {
  const n = nodes.length;
  const pts = nodes.map((p) => new THREE.Vector3(p.x, 0, p.z));
  const curve = new THREE.CatmullRomCurve3(pts, false, "catmullrom", 0.5);

  let maxChord = 0;
  for (let i = 0; i < n - 1; i++) {
    maxChord = Math.max(maxChord, Math.hypot(
      nodes[i + 1].x - nodes[i].x, nodes[i + 1].z - nodes[i].z,
    ));
  }
  // Half the station spacing, so resampling walks a polyline finer than its own
  // output and curvature is not lost to the intermediate representation.
  const sub = Math.max(8, Math.min(MAX_SUB, Math.ceil(maxChord / Math.max(spacing * 0.5, 0.25))));
  const divisions = (n - 1) * sub;

  const poly = curve.getPoints(divisions);
  const cum = new Float64Array(poly.length);
  for (let i = 1; i < poly.length; i++) {
    cum[i] = cum[i - 1] + Math.hypot(poly[i].x - poly[i - 1].x, poly[i].z - poly[i - 1].z);
  }

  const nodeArc = new Float64Array(n);
  for (let k = 0; k < n; k++) nodeArc[k] = cum[Math.min(k * sub, poly.length - 1)];

  return { poly, cum, nodeArc, total: cum[cum.length - 1] };
}

/** Walk a cumulative-length polyline and return the point at arc length `s`. */
function pointAtArc(poly, cum, s, out) {
  const last = poly.length - 1;
  if (s <= 0) { out.set(poly[0].x, poly[0].z); return; }
  if (s >= cum[last]) { out.set(poly[last].x, poly[last].z); return; }
  let lo = 0, hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] > s) hi = mid; else lo = mid;
  }
  const span = Math.max(cum[lo + 1] - cum[lo], 1e-9);
  const t = (s - cum[lo]) / span;
  out.set(
    poly[lo].x + (poly[lo + 1].x - poly[lo].x) * t,
    poly[lo].z + (poly[lo + 1].z - poly[lo].z) * t,
  );
}

/**
 * Lowest ground within the channel footprint at (x, z), across the perpendicular.
 *
 * Sampling the centreline alone is wrong on a hillside: the downhill flank sits
 * below it, so a surface placed at the centreline height would spill out of its
 * own channel on that side. Taking the corridor minimum puts an AUTO level under
 * the lowest rim, which is also where a real river ends up.
 */
function corridorMin(sampleGround, x, z, tx, tz, reach) {
  const px = -tz, pz = tx;
  let lo = Infinity;
  for (let i = -2; i <= 2; i++) {
    const o = (i / 2) * reach;
    const h = sampleGround(x + px * o, z + pz * o);
    if (h < lo) lo = h;
  }
  return lo === Infinity ? 0 : lo;
}

/**
 * Solve one river.
 *
 * @param {object}   opts
 * @param {Array}    opts.nodes      [{ x, z, y|null, width, depth, bank }]
 * @param {function} opts.sampleGround (x, z) => metres, the UNCONFORMED terrain
 * @param {object}   opts.params     the riverV2 tool slice
 * @param {number}   [opts.mouthLevel] level forced onto the LAST node, for a
 *   tributary joining a parent — applied before the downhill pass so the reach
 *   above it is solved against the real junction height.
 * @returns {null|object} stations, or null if the river is too short to solve
 */
export function solveRiver({ nodes, sampleGround, params, mouthLevel = null }) {
  if (!nodes || nodes.length < MIN_NODES) return null;

  const spacing = Math.max(0.5, params.stationSpacing ?? 2.5);
  const { poly, cum, nodeArc, total } = sampleCenterline(nodes, spacing);
  if (!(total > 0)) return null;

  const count = Math.max(2, Math.min(MAX_STATIONS, Math.round(total / spacing) + 1));

  // ── Stations: position, tangent, arc ──────────────────────────────────────
  const sx = new Float32Array(count);
  const sz = new Float32Array(count);
  const arc = new Float32Array(count);
  const tanX = new Float32Array(count);
  const tanZ = new Float32Array(count);
  const _p = { x: 0, z: 0, set(a, b) { this.x = a; this.z = b; } };

  for (let i = 0; i < count; i++) {
    const s = (i / (count - 1)) * total;
    arc[i] = s;
    pointAtArc(poly, cum, s, _p);
    sx[i] = _p.x;
    sz[i] = _p.z;
  }
  for (let i = 0; i < count; i++) {
    const a = Math.max(0, i - 1);
    const b = Math.min(count - 1, i + 1);
    let dx = sx[b] - sx[a];
    let dz = sz[b] - sz[a];
    const len = Math.hypot(dx, dz) || 1;
    tanX[i] = dx / len;
    tanZ[i] = dz / len;
  }

  // ── Per-node channel shape ────────────────────────────────────────────────
  const n = nodes.length;
  const xs = Array.from(nodeArc);
  // Guard against two nodes dropped on the same spot: a zero-width span would
  // divide by ~0 in the interpolant.
  for (let k = 1; k < n; k++) if (xs[k] <= xs[k - 1]) xs[k] = xs[k - 1] + 1e-3;

  const nWidth = nodes.map((p) => Math.max(0.5, p.width ?? params.newWidth));
  const nDepth = nodes.map((p) => Math.max(0.05, p.depth ?? params.newDepth));
  const nBank = nodes.map((p) => Math.max(0.5, p.bank ?? params.newBank));

  // ── Per-node level: AUTO from the ground, PINNED from the author ──────────
  const nLevel = new Float64Array(n);
  const pinned = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    if (Number.isFinite(nodes[k].y)) {
      nLevel[k] = nodes[k].y;
      pinned[k] = 1;
      continue;
    }
    // Tangent at the node, for the corridor sample.
    const a = Math.max(0, k - 1);
    const b = Math.min(n - 1, k + 1);
    let dx = nodes[b].x - nodes[a].x;
    let dz = nodes[b].z - nodes[a].z;
    const len = Math.hypot(dx, dz) || 1;
    nLevel[k] = corridorMin(
      sampleGround, nodes[k].x, nodes[k].z, dx / len, dz / len,
      nWidth[k] * 0.5 + nBank[k],
    );
  }

  // A tributary's mouth is not the author's choice and not the ground's — it is
  // whatever the parent is doing at the junction. Treat it as pinned.
  if (mouthLevel != null && Number.isFinite(mouthLevel)) {
    nLevel[n - 1] = mouthLevel;
    pinned[n - 1] = 1;
  }

  // Smooth only the AUTO levels: they come from a corridor minimum that is noisy
  // on rough ground. Pinned levels are held exactly.
  const smoothing = Math.max(0, Math.round(params.levelSmoothing ?? 2));
  for (let pass = 0; pass < smoothing; pass++) {
    const prev = Float64Array.from(nLevel);
    for (let k = 1; k < n - 1; k++) {
      if (pinned[k]) continue;
      nLevel[k] = prev[k - 1] * 0.25 + prev[k] * 0.5 + prev[k + 1] * 0.25;
    }
  }

  // ── Force downhill, AUTO nodes only ───────────────────────────────────────
  // Node order is downstream, always. A pinned node that breaks the descent is
  // left exactly where the author put it and reported through `uphill` instead —
  // silently "fixing" it is how a lifted river snaps back to the ground.
  if (params.forceDownhill !== false) {
    const g = Math.max(0, params.minGradient ?? 0.0008);
    for (let k = 1; k < n; k++) {
      if (pinned[k]) continue;
      const ceiling = nLevel[k - 1] - g * (xs[k] - xs[k - 1]);
      if (nLevel[k] > ceiling) nLevel[k] = ceiling;
    }
  }

  // ── Interpolate every per-node quantity across the stations ───────────────
  const fLevel = monotoneCubic(xs, Array.from(nLevel));
  const fWidth = monotoneCubic(xs, nWidth);
  const fDepth = monotoneCubic(xs, nDepth);
  const fBank = monotoneCubic(xs, nBank);

  const level = new Float32Array(count);
  const width = new Float32Array(count);
  const depth = new Float32Array(count);
  const bank = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const s = arc[i];
    level[i] = fLevel(s);
    width[i] = Math.max(0.5, fWidth(s));
    depth[i] = Math.max(0.05, fDepth(s));
    bank[i] = Math.max(0.5, fBank(s));
  }

  // ── Flow: Manning, from the solved profile ────────────────────────────────
  // v = (1/n)·R^(2/3)·√S with hydraulic radius approximated by depth. This is
  // what makes a narrow, steep reach white-cap without anyone authoring it: the
  // same discharge through a smaller section has to move faster.
  const manningN = Math.max(0.005, params.manningN ?? 0.04);
  const flowScale = params.flowScale ?? 1;
  const minSlope = Math.max(0, params.minSlope ?? 0.0006);
  const minSpeed = params.minSpeed ?? 0.08;
  const maxSpeed = params.maxSpeed ?? 9;

  // Whitewater threshold, as a FROUDE NUMBER — an absolute measure, not a
  // relative one. The first version normalised turbulence against the river's
  // own worst reach, which is wrong in the most common case there is: a river
  // of uniform gradient has one turbulence value everywhere, so dividing by the
  // maximum gave 1.0 along its whole length and painted a glass-calm stream
  // solid white. Fr = v / sqrt(g·d) says how close the flow is to going
  // supercritical, which is physically when water actually breaks, and it means
  // the same thing on a mountain torrent and a lowland stream.
  const froudeStart = params.froudeStart ?? 0.8;
  const froudeFull = Math.max(froudeStart + 0.01, params.froudeFull ?? 1.8);
  const G = 9.81;

  const speed = new Float32Array(count);
  const slope = new Float32Array(count);
  const uphill = new Uint8Array(count);
  const turb = new Float32Array(count);
  const froude = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    const a = Math.max(0, i - 1);
    const b = Math.min(count - 1, i + 1);
    const ds = Math.max(arc[b] - arc[a], 1e-4);
    // Positive = the water surface falls downstream, which is the normal case.
    const fall = (level[a] - level[b]) / ds;
    slope[i] = fall;
    if (fall < -1e-4) uphill[i] = 1;

    const S = Math.max(minSlope, fall);
    const v = (1 / manningN) * Math.pow(depth[i], 2 / 3) * Math.sqrt(S) * flowScale;
    speed[i] = Math.min(maxSpeed, Math.max(minSpeed, v));

    froude[i] = speed[i] / Math.sqrt(G * Math.max(depth[i], 1e-3));
    turb[i] = Math.min(1, Math.max(0, (froude[i] - froudeStart) / (froudeFull - froudeStart)));
  }

  return {
    count, total,
    x: sx, z: sz, arc, tanX, tanZ,
    level, width, depth, bank,
    speed, slope, turb, froude, uphill,
    nodeArc: xs,
    nodeLevel: Array.from(nLevel),
    nodePinned: Array.from(pinned),
    /** True if any station climbs against the flow direction. */
    hasUphill: uphill.some((v) => v === 1),
  };
}

/**
 * Nearest solved station to a world XZ, for snapping a tributary mouth onto a
 * parent. Returns null when the point is further away than `maxDist`.
 */
export function closestStation(solved, x, z, maxDist = Infinity) {
  if (!solved) return null;
  let best = -1;
  let bestD2 = maxDist * maxDist;
  for (let i = 0; i < solved.count; i++) {
    const dx = solved.x[i] - x;
    const dz = solved.z[i] - z;
    const d2 = dx * dx + dz * dz;
    if (d2 < bestD2) { bestD2 = d2; best = i; }
  }
  if (best < 0) return null;
  return {
    index: best,
    dist: Math.sqrt(bestD2),
    x: solved.x[best], z: solved.z[best],
    level: solved.level[best],
    width: solved.width[best],
  };
}

/**
 * Segments the conform shader's inner loop can visit. Compile-time: TSL unrolls
 * it, so it is a hard ceiling on how many stations one pass may consider.
 */
export const LOOP_SEGS = 96;
/**
 * Split a river into conform passes.
 *
 * Each pass is SCISSORED to its own chunk of stations but must SEE `margin`
 * stations either side. A texel inside a chunk's rect sits up to `maxReach`
 * metres from the centreline, so its true nearest segment can be that far along
 * the river — i.e. in a neighbouring chunk. A pass that cannot see that segment
 * measures the distance to a far one instead, its cross-section evaluates to
 * "natural ground", and it fills the channel straight back in: the river comes
 * out cut into pieces exactly one chunk long. That was a real, visible bug.
 *
 * The invariant that prevents it is `margin * spacing >= maxReach`.
 *
 * @param {number} count    solved station count
 * @param {number} spacing  metres between stations
 * @param {number} maxReach widest the conform reaches from the centreline, metres
 */
/**
 * Split a river's path into conform passes.
 *
 * Each pass only ever looks at its OWN segments. That is safe because the
 * passes do not write terrain — they carry the nearest-segment search forward,
 * and `min` over distance is associative, so the passes compose in any order
 * and a later resolve turns the winner into a height. See riverV2System's
 * "nearest, then resolve" note.
 *
 * Two earlier designs had each pass write the terrain directly, which made a
 * pass's answer depend on seeing every segment that could be nearest for any
 * texel in its rect. Neither an arc-length margin nor a spatial window can
 * guarantee that: a river folding back on itself puts two arms within a bank
 * width of each other while they are most of the river apart along its length.
 * Both shipped a visibly gappy river. The associative formulation removes the
 * requirement instead of trying to satisfy it.
 */
export function planConformChunks(count, loopSegs = LOOP_SEGS) {
  const chunks = [];
  if (count < 2) return { chunks, loopSegs };
  const step = Math.max(1, loopSegs);
  for (let a = 0; a < count - 1; a += step) {
    chunks.push({ a, b: Math.min(a + step, count - 1) });
  }
  return { chunks, loopSegs };
}

/**
 * Decimation stride for one river's conform path, so all rivers together fit
 * the shared path texture. Purely a memory budget — accuracy along the channel
 * is set by the solver's station spacing, not by this.
 */
export function conformStride(count, budget) {
  if (count <= budget) return 1;
  return Math.max(1, Math.ceil((count - 1) / Math.max(1, budget - 1)));
}

// ═══════════════════════════════════════════════════════════════════════════
// Flow query — what the water is doing at a world position
// ═══════════════════════════════════════════════════════════════════════════
//
// The renderer is not the only thing that needs to know where the water is and
// which way it is going: buoyancy, a swimming player, a boat, drifting debris
// and audio all want the same answer on the CPU, every frame, for arbitrary
// points. The solver already has it — surface level, velocity and the channel
// cross-section at every station — so this is a lookup, not a second model. It
// deliberately reuses the SAME bed formula the conform writes, so the depth a
// query reports is the depth the terrain actually has.
//
// Queries are cheap because the stations go into a uniform grid whose cell is
// at least the widest reach in the scene: any station that could be nearest to
// a point is then in that point's own cell or one of its eight neighbours, so a
// query tests a handful of segments rather than thousands.

/** Extra metres beyond the water's edge that a query still reports on. */
const FLOW_MARGIN = 2;

/**
 * Build the lookup structure. Cheap enough to rebuild whenever a river changes.
 *
 * @param {Array<object|null>} solvedList one entry per river, from solveRiver
 * @param {object} opts
 * @param {number} opts.worldSize
 * @param {number} [opts.bedCurve] the tool's cross-section shape, so the depth
 *   a query reports matches the terrain the conform wrote
 */
export function buildFlowIndex(solvedList, { worldSize, bedCurve = 0.55 } = {}) {
  const rivers = (solvedList || []).filter((s) => s && s.count >= 2);
  if (!rivers.length) return null;

  let maxReach = 1;
  for (const s of rivers) {
    for (let i = 0; i < s.count; i++) {
      const r = s.width[i] * 0.5 + FLOW_MARGIN;
      if (r > maxReach) maxReach = r;
    }
  }
  // One cell is at least the widest reach, which is what makes a 3x3 scan
  // sufficient rather than merely likely.
  const cell = Math.max(maxReach, 4);
  const half = worldSize * 0.5;
  const dim = Math.max(1, Math.ceil(worldSize / cell));
  const cells = new Map();

  for (let ri = 0; ri < rivers.length; ri++) {
    const s = rivers[ri];
    for (let i = 0; i < s.count - 1; i++) {
      // Register the SEGMENT in every cell either endpoint falls in, so a long
      // segment spanning a cell boundary is found from both sides.
      const put = (x, z) => {
        const cx = Math.max(0, Math.min(dim - 1, Math.floor((x + half) / cell)));
        const cz = Math.max(0, Math.min(dim - 1, Math.floor((z + half) / cell)));
        const key = cz * dim + cx;
        let list = cells.get(key);
        if (!list) { list = []; cells.set(key, list); }
        // Segments are short relative to a cell, so duplicates are rare and a
        // linear check is cheaper than a Set per cell.
        const tag = ri * 100000 + i;
        if (list[list.length - 1] !== tag) list.push(tag);
      };
      put(s.x[i], s.z[i]);
      put(s.x[i + 1], s.z[i + 1]);
    }
  }

  return { rivers, cells, cell, dim, half, bedCurve, maxReach };
}

/** Bed height below the surface at `dist` from the centreline. Mirrors the
 *  conform's cross-section exactly — see riverV2System's resolve pass. */
function bedDrop(dist, halfW, depth, bedCurve) {
  const u = Math.min(1, Math.max(0, dist / Math.max(halfW, 1e-6)));
  const flat = 1 - Math.pow(u, 8);
  const para = 1 - u * u;
  return depth * (flat * (1 - bedCurve) + para * bedCurve);
}

/**
 * What is the water doing at (x, z)?
 *
 * @returns {null|{
 *   riverIndex:number, distance:number, inChannel:boolean,
 *   surfaceY:number, bedY:number, depth:number,
 *   speed:number, dirX:number, dirZ:number,
 *   width:number, halfWidth:number, arc:number, turbulence:number
 * }} null when no river is near enough to have an opinion.
 */
export function sampleFlow(index, x, z) {
  if (!index) return null;
  const { rivers, cells, cell, dim, half, bedCurve } = index;

  const cx = Math.floor((x + half) / cell);
  const cz = Math.floor((z + half) / cell);

  let bestD2 = Infinity;
  let bestRi = -1, bestSi = -1, bestT = 0;

  for (let oz = -1; oz <= 1; oz++) {
    const gz = cz + oz;
    if (gz < 0 || gz >= dim) continue;
    for (let ox = -1; ox <= 1; ox++) {
      const gx = cx + ox;
      if (gx < 0 || gx >= dim) continue;
      const list = cells.get(gz * dim + gx);
      if (!list) continue;
      for (let k = 0; k < list.length; k++) {
        const tag = list[k];
        const ri = (tag / 100000) | 0;
        const i = tag - ri * 100000;
        const s = rivers[ri];
        const ax = s.x[i], az = s.z[i];
        const abx = s.x[i + 1] - ax, abz = s.z[i + 1] - az;
        const len2 = abx * abx + abz * abz || 1e-9;
        let t = ((x - ax) * abx + (z - az) * abz) / len2;
        t = t < 0 ? 0 : (t > 1 ? 1 : t);
        const dx = x - (ax + abx * t);
        const dz = z - (az + abz * t);
        const d2 = dx * dx + dz * dz;
        if (d2 < bestD2) { bestD2 = d2; bestRi = ri; bestSi = i; bestT = t; }
      }
    }
  }
  if (bestRi < 0) return null;

  const s = rivers[bestRi];
  const i = bestSi, j = bestSi + 1, t = bestT;
  const lerp = (arr) => arr[i] + (arr[j] - arr[i]) * t;

  const distance = Math.sqrt(bestD2);
  const width = lerp(s.width);
  const halfWidth = width * 0.5;
  // Beyond the channel plus a small margin there is nothing useful to say.
  if (distance > halfWidth + FLOW_MARGIN) return null;

  const surfaceY = lerp(s.level);
  const depthMax = lerp(s.depth);
  const drop = bedDrop(distance, halfWidth, depthMax, bedCurve);
  const bedY = surfaceY - drop;

  let dirX = s.tanX[i] + (s.tanX[j] - s.tanX[i]) * t;
  let dirZ = s.tanZ[i] + (s.tanZ[j] - s.tanZ[i]) * t;
  const dl = Math.hypot(dirX, dirZ) || 1;
  dirX /= dl; dirZ /= dl;

  return {
    riverIndex: bestRi,
    distance,
    inChannel: distance <= halfWidth,
    surfaceY,
    bedY,
    depth: Math.max(0, surfaceY - bedY),
    speed: lerp(s.speed),
    dirX, dirZ,
    width, halfWidth,
    arc: lerp(s.arc),
    turbulence: lerp(s.turb),
  };
}

/**
 * Flow at a 3D point, with the one extra fact a physics step actually wants:
 * whether the point is under the surface, and how far.
 *
 * @returns {null|object} the sampleFlow result plus `submerged` and
 *   `submergedDepth` (metres of water above the point, 0 when it is not).
 */
export function sampleFlowAt(index, x, y, z) {
  const f = sampleFlow(index, x, z);
  if (!f) return null;
  const above = f.surfaceY - y;
  f.submerged = f.inChannel && above > 0;
  f.submergedDepth = f.submerged ? above : 0;
  return f;
}
