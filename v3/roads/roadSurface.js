// Road surface heights: node planes, crown, banking.
//
// The height of a road at station s and lateral offset t is
//
//   y(s, t) = profile(s) + offset(s, t)
//
// profile (roadProfile.js) is the centreline elevation; offset is the cross
// section:
//   - CROWN: each carriageway falls from its middle to its kerbs (2.5 %), so
//     rain drains to the gutters. The crown line is the same one the asphalt
//     shader pools water against (aPiece.y in laneRoadMesh.js).
//   - BANKING: on road types designed with spirals (rural roads, motorways,
//     ramps) the section rotates about the reference line into the design
//     superelevation for its curvature, e = curveDesign(speed, R).e. The
//     adverse crown is removed first; the inside keeps its fall until the bank
//     is steeper. Spirals ramp the curvature, so the bank ramps with it. City
//     streets are crowned only.
//   - NODE PLANES: every node sits on a tilted plane fitted to the ground
//     under it, its slope capped (junction 5 %, roundabout 3 %, never over the
//     arms' own grade limit). Near a node a road IS that plane — profile and
//     cross slope — from the node out to `pin` metres past the arm's trim,
//     then blends into its own profile, crown and bank over `blend` metres.
//     So a pad, its corner sidewalks and every arm mouth share one flat
//     surface, and arms leave it with a continuous grade.
//
// Outside the carriageway (sidewalks, verges) the offset is the kerb line's
// height carried level across, tilted with the node plane where one applies.
// Raised strips add their own kerb height on top (the mesh builder does that).

import { clamp, smooth01, pointInPolygon, polygonArea } from "./roadMath.js";
import { layoutAt, layoutEdges } from "./roadCrossSection.js";
import { curveDesign, profileAt } from "./roadProfile.js";
import { evalAlignment } from "./roadAlignment.js";

export const SURFACE_DEFAULTS = {
  crown: 0.025, // cross fall from a carriageway's crown to its kerbs
  banking: true, // superelevation on types designed with spirals
  pin: 4, // metres past an arm's trim that stay exactly on the node plane
  junctionGrade: 0.05, // steepest junction plane
  roundaboutGrade: 0.03, // steepest roundabout plane
  sideGrade: 0.03, // steepest tilt ACROSS the road at an end, continuation or split
};

/* ------------------------------------------------------------------ nodes */

/** Farthest point of a node's geometry from its centre (pad, corners, ring), at least 6 m. */
export function nodeReach(node) {
  let r2 = 0;
  const add = (p) => {
    const d = (p[0] - node.x) ** 2 + (p[1] - node.z) ** 2;
    if (d > r2) r2 = d;
  };
  if (node.pad) node.pad.forEach(add);
  for (const c of node.corners || []) {
    c.propChain?.forEach(add);
    c.curbChain?.forEach(add);
  }
  if (node.ring) r2 = Math.max(r2, node.ring.Rp ** 2);
  return Math.max(6, Math.sqrt(r2));
}

/**
 * The node's outer outline (its corner property chains in order), or null when
 * it encloses no area (continuations, splits).
 */
export function nodeOutline(node) {
  if (node.kind !== "junction" && node.kind !== "roundabout" && node.kind !== "end") return null;
  const pts = [];
  for (const c of node.corners || []) if (c.propChain) pts.push(...c.propChain);
  if (node.kind === "end" && node.corners?.[0]?.curbChain) {
    // The cap's open side runs across the road end.
    const arm = node.arms[0];
    if (arm) {
      const e = arm.edges;
      pts.push([arm.ox + arm.nx * e.propL, arm.oz + arm.nz * e.propL]);
    }
  }
  if (pts.length < 3 || Math.abs(polygonArea(pts)) < 1) return null;
  return pts;
}

/**
 * Fit the node's plane to the ground: node.y (centre height) and
 * node.plane = { gx, gz } (rise per metre along x and z). A node with an
 * authored y stays level at that height.
 */
export function fitNodePlane(node, ground, o = SURFACE_DEFAULTS) {
  node.reach = nodeReach(node);
  node.outline = nodeOutline(node);
  node.plane = { gx: 0, gz: 0 };
  if (node.src.y != null || !node.arms.length) return;
  // Rings of samples symmetric about the centre: the least-squares plane then
  // separates into a mean and two independent slopes.
  const R = node.reach;
  let n = 0, sy = 0, sxx = 0, szz = 0, sxy = 0, szy = 0;
  const put = (dx, dz) => {
    const y = ground(node.x + dx, node.z + dz);
    n++; sy += y;
    sxx += dx * dx; szz += dz * dz; sxy += dx * y; szy += dz * y;
  };
  put(0, 0);
  for (const [f, cnt] of [[0.35, 8], [0.7, 12], [1, 16]]) {
    for (let k = 0; k < cnt; k++) {
      const a = (k / cnt) * Math.PI * 2;
      put(Math.cos(a) * R * f, Math.sin(a) * R * f);
    }
  }
  const mean = sy / n;
  let gx = sxy / sxx, gz = szy / szz;
  let cap = Infinity;
  for (const a of node.arms) cap = Math.min(cap, (a.type.maxGrade ?? 0.08) * 0.92);
  if (node.kind === "junction" || node.kind === "roundabout") {
    cap = Math.min(cap, node.kind === "junction" ? o.junctionGrade : o.roundaboutGrade);
    const g = Math.hypot(gx, gz);
    if (g > cap) { gx *= cap / g; gz *= cap / g; }
  } else {
    // Ends, continuations, splits: one road runs through, so the plane may climb
    // along it as steeply as the road, but only tilts a little across it.
    const h = node.split ? node.split.H : node.arms[0].th;
    const dx = Math.cos(h), dz = Math.sin(h), nx = Math.sin(h), nz = -Math.cos(h);
    const along = clamp(gx * dx + gz * dz, -cap, cap);
    const across = clamp(gx * nx + gz * nz, -o.sideGrade, o.sideGrade);
    gx = along * dx + across * nx;
    gz = along * dz + across * nz;
  }
  node.y = mean;
  node.plane = { gx, gz };
}

/** How readily a node's height gives way to its roads' grade limits (0 = authored, fixed). */
const GIVE = { end: 1, continuation: 1, split: 0.7, junction: 0.5, roundabout: 0.35 };

/**
 * Move node heights until every road can climb between its two pinned ends
 * within its grade limit (with a margin for the profile's smoothing). Plane
 * slopes stay; only heights move. Call after setupRoadSurface on every road.
 */
export function relaxNodeHeights(nodes, roads) {
  const links = [];
  for (const rr of roads) {
    const { A, B } = rr.surf;
    if (A.node === B.node) continue;
    const pa = evalAlignment(rr.al, A.pin), pb = evalAlignment(rr.al, rr.L - B.pin);
    links.push({
      A: A.node, B: B.node,
      offA: planeY(A.node, pa.x, pa.z) - A.node.y,
      offB: planeY(B.node, pb.x, pb.z) - B.node.y,
      lim: rr.type.maxGrade * 0.92 * 0.9 * Math.max(1, rr.L - A.pin - B.pin),
    });
  }
  const give = (n) => (n.src.y != null ? 0 : GIVE[n.kind] ?? 0.5);
  for (let pass = 0; pass < 60; pass++) {
    let worst = 0;
    for (const k of links) {
      const dy = k.B.y + k.offB - (k.A.y + k.offA);
      const excess = Math.abs(dy) - k.lim;
      if (excess <= 1e-4) continue;
      const wa = give(k.A), wb = give(k.B);
      if (wa + wb <= 0) continue;
      const shift = Math.sign(dy) * excess;
      k.A.y += (shift * wa) / (wa + wb);
      k.B.y -= (shift * wb) / (wa + wb);
      worst = Math.max(worst, excess);
    }
    if (worst < 1e-3) break;
  }
}

export function planeY(node, x, z) {
  const p = node.plane;
  return p ? node.y + p.gx * (x - node.x) + p.gz * (z - node.z) : node.y;
}

/* ------------------------------------------------------------------ roads */

/**
 * Where a road is pinned to its node planes and how far it takes to blend out.
 * Call after the alignment (rr.L) and node planes exist.
 */
export function setupRoadSurface(rr, o = SURFACE_DEFAULTS) {
  const blend = clamp(rr.type.speed * 0.5, 20, 55);
  const end = (arm) => ({ node: arm.node, pin: arm.trim + o.pin, B: blend });
  const A = end(rr.armA), B = end(rr.armB);
  const room = rr.L - A.pin - B.pin;
  if (room < A.B + B.B) {
    const f = Math.max(0, room) / (A.B + B.B);
    A.B *= f; B.B *= f;
  }
  if (room < 0) {
    const f = rr.L / (A.pin + B.pin);
    A.pin *= f; B.pin *= f;
    rr.issues.push({ level: "info", code: "short-blend", msg: "Road is too short to blend between the planes of its two nodes", x: (rr.A.x + rr.B.x) / 2, z: (rr.A.z + rr.B.z) / 2, roadId: rr.id });
  }
  rr.surf = { crown: o.crown, bank: !!o.banking && !!rr.type.spirals, A, B, L: rr.L };
}

/** How much of each end's plane applies at station s: [wA, wB], wA + wB ≤ 1. */
export function endWeights(surf, s) {
  const w = (d, e) => (e.B > 1e-6 ? 1 - smooth01((d - e.pin) / e.B) : d <= e.pin ? 1 : 0);
  return [w(s, surf.A), w(surf.L - s, surf.B)];
}

/**
 * For a terrain-following profile: the plane height over each end's pinned
 * stretch, null elsewhere. buildProfile grade-limits outward from these, so the
 * climb away from a junction obeys the road's maximum grade.
 */
export function pinnedProfile(rr) {
  const surf = rr.surf;
  return (s) => {
    const e = s <= surf.A.pin + 1e-6 ? surf.A : surf.L - s <= surf.B.pin + 1e-6 ? surf.B : null;
    if (!e) return null;
    const p = evalAlignment(rr.al, s);
    return planeY(e.node, p.x, p.z);
  };
}

/**
 * Pull an authored (linear / design) profile onto the node planes near each
 * end. A terrain profile is already pinned (pinnedProfile) and left alone. The
 * table's samples are 4 m apart and `pin` is 4 m past the mouth, so the samples
 * bracketing the mouth are both on the plane and the height there is exact.
 */
export function blendProfileEnds(rr) {
  const P = rr.prof, surf = rr.surf;
  const N = P.s.length;
  if (P.mode === "terrain") return;
  for (let i = 0; i < N; i++) {
    const [wA, wB] = endWeights(surf, P.s[i]);
    if (wA + wB <= 0) continue;
    const e = evalAlignment(rr.al, P.s[i]);
    P.y[i] = P.y[i] * (1 - wA - wB) + wA * planeY(surf.A.node, e.x, e.z) + wB * planeY(surf.B.node, e.x, e.z);
  }
  let maxG = 0;
  for (let i = 0; i < N; i++) {
    const a = Math.max(0, i - 1), b = Math.min(N - 1, i + 1);
    P.g[i] = (P.y[b] - P.y[a]) / Math.max(1e-6, P.s[b] - P.s[a]);
    if (Math.abs(P.g[i]) > Math.abs(maxG)) maxG = P.g[i];
  }
  P.maxGrade = maxG;
}

/**
 * Everything the cross section needs at one station, computed once per row.
 *   th  heading, k curvature, lay layoutAt(stack, s, L)
 */
export function surfaceFrame(rr, s, th, k, lay) {
  const surf = rr.surf;
  const [wA, wB] = surf ? endWeights(surf, s) : [0, 0];
  const nx = Math.sin(th), nz = -Math.cos(th);
  const lat = (node) => (node.plane ? node.plane.gx * nx + node.plane.gz * nz : 0);
  const gl = surf ? wA * lat(surf.A.node) + wB * lat(surf.B.node) : 0;
  const ed = layoutEdges(lay);
  const ck = rr.stack.center.kind;
  let e = 0;
  if (surf?.bank && Math.abs(k) > 1e-6) e = Math.sign(k) * curveDesign(rr.type.speed, 1 / Math.abs(k), false).e;
  return {
    w: 1 - wA - wB, gl, e, crown: surf?.crown ?? 0,
    curbL: ed.curbL, curbR: ed.curbR, propL: ed.propL, propR: ed.propR,
    half: lay.cw / 2, raised: !!rr.center && (ck === "raised" || ck === "barrier"),
  };
}

/** The carriageway [lo, hi] a lateral offset drains in (a raised median splits the road in two). */
export function carriagewayOf(f, t) {
  if (f.raised) return t >= 0 ? [f.half, f.curbL] : [f.curbR, -f.half];
  return [f.curbR, f.curbL];
}

/** Crowned / banked height at t inside a carriageway, relative to the reference line. */
function crossAt(f, t) {
  const [lo, hi] = carriagewayOf(f, t);
  if (hi - lo < 0.1) return f.e * t;
  const c = (lo + hi) / 2, cr = f.crown, ae = Math.abs(f.e);
  const d = t - c;
  // Outer half (the side the bank raises): −crown → +e, reaching e once e ≥ crown.
  const up = cr > 1e-9 ? -cr + (ae + cr) * Math.min(1, ae / cr) : ae;
  const down = Math.max(cr, ae);
  const outer = f.e !== 0 && Math.sign(d) === Math.sign(f.e);
  return f.e * c + (outer ? up * Math.abs(d) : -down * Math.abs(d));
}

/** Height of the road surface at lateral offset t, relative to profile(s). */
export function surfaceOffset(f, t) {
  let road;
  if (f.raised && Math.abs(t) < f.half) {
    const a = crossAt(f, -f.half), b = crossAt(f, f.half);
    road = a + ((b - a) * (t + f.half)) / (2 * f.half);
  } else {
    road = crossAt(f, clamp(t, f.curbR, f.curbL));
  }
  return f.w * road + f.gl * t;
}

/** Road surface height (asphalt level) at station s, offset t. */
export function roadSurfaceY(rr, s, t) {
  const e = evalAlignment(rr.al, s);
  const f = surfaceFrame(rr, s, e.th, e.k, layoutAt(rr.stack, s, rr.L));
  return profileAt(rr.prof, s).y + surfaceOffset(f, t);
}

/* ------------------------------------------------------------------ terrain targets */

/** Is the outermost strip on this side a raised one (sidewalk, verge)? */
function raisedEdge(f, side) {
  return side > 0 ? f.propL > f.curbL + 0.05 : f.propR < f.curbR - 0.05;
}

/**
 * What the ground should do at plan point (x, z), for terrain fitting.
 *   { y, out } — y is the surface height at the nearest point of the road
 *   footprint (asphalt level inside it; at its property edge, the top of the
 *   raised strip there); out is how far (m) the point lies outside the
 *   footprint (0 inside). null when nothing is within `reach`.
 *
 * Grading asks this for every texel near a road (60k+ times on a 1 m
 * heightmap), so the index behind it is built once per result and options
 * (groundTargets) and kept on the result.
 *
 * @param {object} result buildRoadNetwork() output
 * @param {{ curbHeight?: number, reach?: number }} [o]
 */
export function groundTargetAt(result, x, z, o = {}) {
  const key = `${o.curbHeight ?? 0.15}|${o.reach ?? 40}`;
  if (result._groundTargets?.key !== key) result._groundTargets = { key, at: groundTargets(result, o) };
  return result._groundTargets.at(x, z);
}

const CELL = 8;

/** profileAt(...).y without the object. */
function profileY(prof, st) {
  const s = prof.s, N = s.length;
  if (st <= s[0]) return prof.y[0];
  if (st >= s[N - 1]) return prof.y[N - 1];
  const f = (st / s[N - 1]) * (N - 1);
  const i = Math.min(N - 2, Math.floor(f));
  return prof.y[i] + (prof.y[i + 1] - prof.y[i]) * (f - i);
}

/** A (x, z) → { y, out } | null query over a network; see groundTargetAt. */
export function groundTargets(result, o = {}) {
  const H = o.curbHeight ?? 0.15;
  const reach = o.reach ?? 40;

  // Per road: property edges at every sample (layoutEdges allocates).
  const segs = [];
  const cells = new Map();
  const put = (x0, z0, x1, z1, id) => {
    for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) {
      for (let cz = Math.floor(z0 / CELL); cz <= Math.floor(z1 / CELL); cz++) {
        const k = cx * 73856093 ^ cz * 19349663;
        let arr = cells.get(k);
        if (!arr) cells.set(k, (arr = { segs: [], nodes: [] }));
        arr[id.kind].push(id.i);
      }
    }
  };
  for (const rr of result.roads) {
    const S = rr.smp;
    if (!S || S.s.length < 2) continue;
    const N = S.s.length;
    const pL = new Float64Array(N), pR = new Float64Array(N);
    // One cross-section frame per sample: crown, bank and plane blend change
    // slowly over a sample step (≤ 6 m), the profile height is interpolated.
    const frames = new Array(N);
    let wide = 0;
    for (let i = 0; i < N; i++) {
      frames[i] = surfaceFrame(rr, S.s[i], S.th[i], S.k[i], rr.lays[i]);
      pL[i] = frames[i].propL; pR[i] = frames[i].propR;
      wide = Math.max(wide, Math.abs(pL[i]), Math.abs(pR[i]));
    }
    for (let i = 1; i < N; i++) {
      const pad = wide + reach;
      const id = segs.length;
      segs.push({ rr, i, pL, pR, frames });
      put(Math.min(S.x[i - 1], S.x[i]) - pad, Math.min(S.z[i - 1], S.z[i]) - pad,
        Math.max(S.x[i - 1], S.x[i]) + pad, Math.max(S.z[i - 1], S.z[i]) + pad, { kind: "segs", i: id });
    }
  }
  const nodes = result.nodes.filter((n) => n.outline);
  nodes.forEach((n, i) => {
    const pad = n.reach + reach;
    put(n.x - pad, n.z - pad, n.x + pad, n.z + pad, { kind: "nodes", i });
  });
  const raisedNode = nodes.map((n) => !!n.corners?.some((c) => c.sw));

  return (x, z) => {
    const cell = cells.get(Math.floor(x / CELL) * 73856093 ^ Math.floor(z / CELL) * 19349663);
    if (!cell) return null;
    let bestOut = Infinity, bestY = 0;

    for (const ni of cell.nodes) {
      const node = nodes[ni];
      const P = node.outline;
      if (pointInPolygon(x, z, P)) return { y: planeY(node, x, z), out: 0 };
      let d2 = Infinity;
      for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
        const ax = P[j][0], az = P[j][1], abx = P[i][0] - ax, abz = P[i][1] - az;
        const l2 = abx * abx + abz * abz;
        const u = l2 > 0 ? clamp(((x - ax) * abx + (z - az) * abz) / l2, 0, 1) : 0;
        const fx = ax + abx * u - x, fz = az + abz * u - z;
        const d = fx * fx + fz * fz;
        if (d < d2) d2 = d;
      }
      const out = Math.sqrt(d2);
      if (out < bestOut) { bestOut = out; bestY = planeY(node, x, z) + (raisedNode[ni] ? H : 0); }
    }

    let pick = null, pickScore = Infinity, pickU = 0, pickT = 0, pickTh = 0;
    for (const si of cell.segs) {
      const sg = segs[si];
      const S = sg.rr.smp, i = sg.i;
      const ax = S.x[i - 1], az = S.z[i - 1], abx = S.x[i] - ax, abz = S.z[i] - az;
      const l2 = abx * abx + abz * abz;
      const u = l2 > 0 ? clamp(((x - ax) * abx + (z - az) * abz) / l2, 0, 1) : 0;
      const fx = x - (ax + abx * u), fz = z - (az + abz * u);
      const dth = S.th[i] - S.th[i - 1];
      const th = S.th[i - 1] + u * Math.atan2(Math.sin(dth), Math.cos(dth));
      const t = fx * Math.sin(th) - fz * Math.cos(th);
      const k = u < 0.5 ? i - 1 : i;
      const out = t > sg.pL[k] ? t - sg.pL[k] : t < sg.pR[k] ? sg.pR[k] - t : 0;
      // Off the end of a segment the point is also some way ALONG the road from
      // it (a neighbouring segment scores better if the point is really there).
      const along = u <= 0 || u >= 1 ? Math.max(0, Math.sqrt(fx * fx + fz * fz) - Math.abs(t)) : 0;
      const score = along > 0 ? Math.hypot(out, along) : out;
      if (score < pickScore) { pickScore = score; pick = sg; pickU = u; pickT = t; pickTh = th; }
    }
    if (pick && pickScore < bestOut) {
      const rr = pick.rr, S = rr.smp, i = pick.i, u = pickU;
      const s = S.s[i - 1] + (S.s[i] - S.s[i - 1]) * u;
      const f = pick.frames[u < 0.5 ? i - 1 : i];
      const y0 = profileY(rr.prof, s);
      if (pickScore <= 0) return { y: y0 + surfaceOffset(f, pickT), out: 0 };
      const tc = clamp(pickT, f.propR, f.propL);
      const raised = raisedEdge(f, tc >= 0 ? 1 : -1) || (f.raised && Math.abs(tc) < f.half);
      return { y: y0 + surfaceOffset(f, tc) + (raised ? H : 0), out: pickScore };
    }
    return bestOut < Infinity ? { y: bestY, out: bestOut } : null;
  };
}
