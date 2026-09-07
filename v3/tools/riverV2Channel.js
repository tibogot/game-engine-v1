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

  const speed = new Float32Array(count);
  const slope = new Float32Array(count);
  const uphill = new Uint8Array(count);
  let maxTurb = 1e-6;
  const turb = new Float32Array(count);

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

    // Turbulence: steep AND fast. Froude-flavoured rather than exact — what
    // matters is that it peaks in the same places whitewater does.
    turb[i] = Math.max(0, fall) * speed[i];
    if (turb[i] > maxTurb) maxTurb = turb[i];
  }
  // Normalise turbulence against this river's own worst reach, so the shader's
  // whitewater sliders mean the same thing on a mountain torrent and a lowland
  // stream. Rivers with no gradient at all stay at zero.
  const turbNorm = maxTurb > 1e-4 ? 1 / maxTurb : 0;
  for (let i = 0; i < count; i++) turb[i] = Math.min(1, turb[i] * turbNorm);

  return {
    count, total,
    x: sx, z: sz, arc, tanX, tanZ,
    level, width, depth, bank,
    speed, slope, turb, uphill,
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
