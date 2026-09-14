// 3D meshes from a lane-road build result (buildRoadNetwork).
//
// Plain JS, no three.js: the output is typed arrays per material, so the same
// builder runs headless in the tests and in the editor (v3/tools/laneRoadSystem.js
// wraps it in BufferGeometry).
//
// WHAT IS BUILT
//   asphalt  — every carriage lane as its own strip along the road samples,
//              junction and roundabout pads (earcut, the central island cut out
//              as a hole). Height from the road's elevation profile / node.y.
//   concrete — sidewalks, barriers, splitter islands, roundabout apron, and
//              every curb face: a vertical face along each curb edge with a
//              small 45° bevel on top, plus the curb band around grass tops.
//              Property edges get a back face that runs below ground (`skirt`).
//   grass    — verges, raised medians, the roundabout's central island.
//
// MARKINGS ARE PAINTED BY THE ASPHALT SHADER (v3/render/roads/laneRoadPaint.js),
// not built as geometry, so they share the asphalt's wear and wet film:
//   - lines along a road come from per-quad lane data (aEdges), drawn
//     analytically — any distance, no texture;
//   - node shapes (crosswalks, stop/yield lines, arrows, hatching, ring lines)
//     come from a signed-distance atlas (markingAtlas.js) sampled at the local
//     x/z position; aMark says which region.
//
// ATTRIBUTES (asphalt), for modularRoadMaterial's `plainDeck` (so aZone, aCurve
// and aPlain are shader constants and 7 of WebGPU's 8 vertex buffers are used):
//   uv       x = metres along the road (station), y = metres across (lateral t);
//            pads use plan x/z.
//   aLateral −1..1 across EACH driving lane (lane strips are not welded to each
//            other), so the wheel-path bands land in every lane. 0 elsewhere.
//   aPiece   (per-road noise phase, drain: −1..1 across the carriageway, 0 at the crown)
//   aEdges   (inner line t, outer line t, inner line code, outer line code) —
//            the line on each side of this lane strip; codes from lineCode(),
//            with the dash phase of the line's run as the fraction.
//            Asphalt is built as one quad per sample segment so a code can
//            change between segments without bleeding into its neighbour.
//   aMark    (atlas offset u, v, 1 = in a node region, 1 = parking bay ticks)
// concrete carries aKind: 0 slab, 1 curb stone, 2 apron setts.
//
// Triangles are wound from the normal they are meant to have, so nothing here
// depends on the winding the engine happened to build a polygon with.

import { LANE_TYPES, layoutEdges } from "../roadCrossSection.js";
import { profileAt } from "../roadProfile.js";
import { cleanPolygon } from "../roadMath.js";
import { armPoint } from "../roadJunction.js";
import { boundaryKind, centerKind, markingStyle, INTERRUPTED, CROSSING_INTERRUPTED } from "../roadMarkings.js";
import { dedupe, ring, miters, insideSide, triangulate, offsetLeft } from "./triangulate.js";
import { buildMarkingAtlas } from "./markingAtlas.js";

export const MESH_DEFAULTS = {
  curbHeight: 0.15, // sidewalks, splitter islands, dead-end caps
  medianHeight: 0.18, // raised medians — a touch taller, and never coplanar with a sidewalk
  apronHeight: 0.07, // roundabout truck apron (mountable)
  islandHeight: 0.18, // roundabout central island
  bevel: 0.02, // 45° chamfer on every curb's top edge (0 = sharp)
  curbBand: 0.15, // concrete curb stone around grass tops
  skirt: 0.6, // how far back faces run below the road surface
  markings: true,
  atlasTexel: 0.06, // metres per texel of the junction marking atlas (grows to fit 4096²)
};

export const CONCRETE_KIND = { slab: 0, curb: 1, apron: 2 };
const UP = [0, 1, 0];

/* ------------------------------------------------------------------ line codes */

const DASH_INDEX = { "3,5": 1, "3,9": 2, "6,12": 3, "1.5,1.5": 4 };
export const DASH_PATTERNS = [null, [3, 5], [3, 9], [6, 12], [1.5, 1.5]];

/**
 * A marking style as one float the shader decodes:
 *   width in cm + 50 · dash pattern index + 500 · yellow + 1000 · double.
 * 0 = no line. Widths stay under 50 cm, so the fields never overlap.
 */
export function lineCode(st) {
  if (!st) return 0;
  const cm = Math.max(1, Math.min(49, Math.round(st.width * 100)));
  const dash = st.dash ? (DASH_INDEX[`${st.dash[0]},${st.dash[1]}`] ?? 1) : 0;
  return cm + 50 * dash + (st.color === "yellow" ? 500 : 0) + (st.double ? 1000 : 0);
}

/** Inverse of lineCode; `phase` is the dash phase (0..1 of a period) carried as the fraction. */
export function decodeLineCode(value) {
  const code = Math.floor(value + 1e-6);
  const phase = Math.max(0, value - code);
  const dbl = code >= 1000 ? 1 : 0;
  let c = code - dbl * 1000;
  const yellow = c >= 500 ? 1 : 0;
  c -= yellow * 500;
  const dash = Math.floor((c + 0.5) / 50);
  return { width: (c - dash * 50) / 100, dash: DASH_PATTERNS[dash], yellow: !!yellow, double: !!dbl, phase };
}

/**
 * The painted line on each side of every lane at one cross-section — the same
 * rules as buildRoadMarkings (roadMarkings.js), so the 3D paint matches the lab.
 * Curbs and pave edges are not paint (code 0).
 */
function sectionLines(rr, lay, s, style) {
  const rank = rr.type.rank;
  const mr = rr.markRange;
  const inRange = s >= mr[0] - 1e-6 && s <= mr[1] + 1e-6;
  const wr = rr.walkRange || [-Infinity, Infinity];
  const inWalk = s >= wr[0] - 1e-6 && s <= wr[1] + 1e-6;
  const codeOf = (kind) => {
    if (!kind || kind === "curb" || kind === "paveEdge") return 0;
    if (INTERRUPTED.has(kind) && !inRange) return 0;
    if (CROSSING_INTERRUPTED.has(kind) && !inWalk) return 0;
    return lineCode(markingStyle(kind, style, rank));
  };
  const out = { center: { tA: 0, tB: 0, codeA: 0, codeB: 0 } };
  const first = {};
  for (const side of ["left", "right"]) {
    const L = lay[side];
    const lines = L.map(() => ({ inT: 0, inCode: 0, outT: 0, outCode: 0 }));
    for (let b = 0; b < L.length; b++) {
      if (!L[b].present) continue;
      if (first[side] == null) first[side] = b;
      let next = -1;
      for (let k = b + 1; k < L.length; k++) if (L[k].present) { next = k; break; }
      const code = codeOf(boundaryKind(L[b], next >= 0 ? L[next] : null));
      lines[b].outT = L[b].tOut; lines[b].outCode = code;
      if (next >= 0) { lines[next].inT = L[b].tOut; lines[next].inCode = code; }
    }
    out[side] = lines;
  }
  const cKind = rr.stack.center.kind;
  const fl = first.left, fr = first.right;
  const aL = fl != null ? lay.left[fl] : null, aR = fr != null ? lay.right[fr] : null;
  if (lay.cw < 0.3) {
    const code = codeOf(centerKind(aL, aR, cKind));
    const t = ((aL ? aL.tIn : lay.cw / 2) + (aR ? aR.tIn : -lay.cw / 2)) / 2;
    if (aL) { out.left[fl].inT = t; out.left[fl].inCode = code; }
    if (aR) { out.right[fr].inT = t; out.right[fr].inCode = code; }
    out.center = { tA: t, tB: t, codeA: code, codeB: 0 };
  } else {
    const kind = cKind === "raised" ? "curb" : cKind === "barrier" ? "edge" : "medianEdge";
    const code = codeOf(kind);
    const tl = aL ? aL.tIn : lay.cw / 2, tr = aR ? aR.tIn : -lay.cw / 2;
    if (aL) { out.left[fl].inT = tl; out.left[fl].inCode = code; }
    if (aR) { out.right[fr].inT = tr; out.right[fr].inCode = code; }
    out.center = { tA: tr, tB: tl, codeA: code, codeB: code };
  }
  return out;
}

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/* ------------------------------------------------------------------ buffers */

class Part {
  constructor(extras = {}) {
    this.pos = []; this.nrm = []; this.uv = []; this.idx = [];
    this.extras = Object.entries(extras).map(([name, size]) => ({ name, size, data: [] }));
  }

  get count() { return this.pos.length / 3; }

  vert(x, y, z, n, u, v, ex) {
    const i = this.count;
    this.pos.push(x, y, z);
    this.nrm.push(n[0], n[1], n[2]);
    this.uv.push(u, v);
    for (const e of this.extras) {
      const val = ex?.[e.name] ?? 0;
      if (e.size === 1) e.data.push(val);
      else for (let k = 0; k < e.size; k++) e.data.push(val[k] ?? 0);
    }
    return i;
  }

  /** Triangle wound so its face normal agrees with `n`; degenerate ones are dropped. */
  tri(a, b, c, n) {
    const P = this.pos;
    const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
    const ux = P[b * 3] - ax, uy = P[b * 3 + 1] - ay, uz = P[b * 3 + 2] - az;
    const vx = P[c * 3] - ax, vy = P[c * 3 + 1] - ay, vz = P[c * 3 + 2] - az;
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    const d = cx * n[0] + cy * n[1] + cz * n[2];
    if (cx * cx + cy * cy + cz * cz < 1e-12) return;
    if (d >= 0) this.idx.push(a, b, c);
    else this.idx.push(a, c, b);
  }

  /** a b c d in order around the quad. */
  quad(a, b, c, d, n) {
    this.tri(a, b, c, n);
    this.tri(a, c, d, n);
  }

  finish() {
    const vertexCount = this.count;
    const attributes = {};
    for (const e of this.extras) attributes[e.name] = { array: Float32Array.from(e.data), itemSize: e.size };
    return {
      position: Float32Array.from(this.pos),
      normal: Float32Array.from(this.nrm),
      uv: Float32Array.from(this.uv),
      index: vertexCount < 65536 ? Uint16Array.from(this.idx) : Uint32Array.from(this.idx),
      attributes,
      vertexCount,
      triangleCount: this.idx.length / 3,
    };
  }
}

function norm3(x, y, z) {
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}

function norm2(x, z) {
  const l = Math.hypot(x, z) || 1;
  return [x / l, z / l];
}

function hashPhase(id) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return ((h >>> 0) % 100000) / 100;
}

/* ------------------------------------------------------------------ shared pieces */

/**
 * A vertical face along a polyline, with an optional 45° bevel on top.
 *   P      [{ x, z, yb, yt, u }] — bottom/top heights and the along coordinate
 *   out(i) outward unit normal at vertex i ([nx, nz])
 *   seg(k) outward unit normal of segment k (used at creases)
 *   crease(i) true → both segments keep their own flat normal at vertex i
 *   inset(i) inward miter vector (perpendicular distance 1) for the bevel's top edge
 *   skip(k) leave segment k out (zero-width strip)
 */
function wall(part, P, { closed = false, out, seg, crease = () => false, inset, bevel = 0, ex, skip }) {
  const n = P.length;
  const segs = closed ? n : n - 1;
  for (let k = 0; k < segs; k++) {
    if (skip?.(k)) continue;
    const i = k, j = (k + 1) % n;
    const pi = P[i], pj = P[j];
    const sn = seg(k);
    const ni = crease(i) ? sn : out(i);
    const nj = crease(j) ? sn : out(j);
    const b = Math.max(0, Math.min(bevel, (pi.yt - pi.yb) * 0.5, (pj.yt - pj.yb) * 0.5));
    const fi = [ni[0], 0, ni[1]], fj = [nj[0], 0, nj[1]];
    const a0 = part.vert(pi.x, pi.yb, pi.z, fi, pi.u, 0, ex);
    const a1 = part.vert(pi.x, pi.yt - b, pi.z, fi, pi.u, pi.yt - b - pi.yb, ex);
    const b0 = part.vert(pj.x, pj.yb, pj.z, fj, pj.u, 0, ex);
    const b1 = part.vert(pj.x, pj.yt - b, pj.z, fj, pj.u, pj.yt - b - pj.yb, ex);
    part.quad(a0, b0, b1, a1, [sn[0], 0, sn[1]]);
    if (b > 0) {
      const ii = inset(i), ij = inset(j);
      const ci = norm3(ni[0], 1, ni[1]), cj = norm3(nj[0], 1, nj[1]);
      const c0 = part.vert(pi.x, pi.yt - b, pi.z, ci, pi.u, 0, ex);
      const c1 = part.vert(pi.x + ii[0] * b, pi.yt, pi.z + ii[1] * b, ci, pi.u, b, ex);
      const d0 = part.vert(pj.x, pj.yt - b, pj.z, cj, pj.u, 0, ex);
      const d1 = part.vert(pj.x + ij[0] * b, pj.yt, pj.z + ij[1] * b, cj, pj.u, b, ex);
      part.quad(c0, d0, d1, c1, norm3(sn[0], 1, sn[1]));
    }
  }
}

/**
 * Wall along an open or closed polyline that bounds `poly`; outward is the side
 * away from the polygon. Returns the bevel's inner (top) edge, for the cap.
 */
function boundaryWall(part, pts, poly, { closed = false, yb, yt, bevel = 0, ex }) {
  const inside = insideSide(closed ? [...pts, pts[0]] : pts, poly);
  const { m, segN, creased } = miters(pts, closed);
  let acc = 0;
  const P = pts.map((p, i) => {
    if (i > 0) acc += Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]);
    return { x: p[0], z: p[1], yb: yb(p), yt: yt(p), u: acc };
  });
  wall(part, P, {
    closed,
    out: (i) => norm2(-inside * m[i][0], -inside * m[i][1]),
    seg: (k) => [-inside * segN[k][0], -inside * segN[k][1]],
    crease: (i) => creased[i],
    inset: (i) => [inside * m[i][0], inside * m[i][1]],
    bevel, ex,
  });
  if (bevel <= 0) return pts.slice();
  return pts.map((p, i) => [p[0] + inside * m[i][0] * bevel, p[1] + inside * m[i][1] * bevel]);
}

/** Flat cap over an outer ring with holes; uv = world x/z. */
function cap(part, outer, holes, yAt, ex) {
  const o = ring(outer);
  if (!o) return 0;
  const hs = holes.map((h) => ring(h)).filter(Boolean);
  const { pts, tris } = triangulate(o, hs);
  const id = pts.map((p) => part.vert(p[0], yAt(p), p[1], UP, p[0], p[1], ex));
  for (let t = 0; t < tris.length; t += 3) part.tri(id[tris[t]], id[tris[t + 1]], id[tris[t + 2]], UP);
  return tris.length / 3;
}

/**
 * A raised island: curb wall all round, then a concrete top, or a grass top
 * inside a concrete curb band. `hole` cuts a ring out of the top (the apron
 * around the central island).
 */
function island(parts, poly, o, { yAt, height, base = 0, grass = false, kind = CONCRETE_KIND.slab, hole = null }) {
  const cleaned = cleanPolygon(dedupe(poly, true));
  const r = ring(cleaned);
  if (!r) return null;
  const top = boundaryWall(parts.concrete, r, r, {
    closed: true,
    yb: (p) => yAt(p) + base,
    yt: (p) => yAt(p) + height,
    bevel: o.bevel,
    ex: { aKind: CONCRETE_KIND.curb },
  });
  const yTop = (p) => yAt(p) + height;
  const holes = hole ? [hole] : [];
  if (grass && o.curbBand > 0) {
    const inside = insideSide([...r, r[0]], r);
    const band = offsetLeft(top, true, inside * o.curbBand);
    const bandRing = ring(band, 0.5);
    if (bandRing && sameSense(top, band)) {
      cap(parts.concrete, top, [bandRing], yTop, { aKind: CONCRETE_KIND.curb });
      cap(parts.grass, bandRing, holes, yTop, null);
      return r;
    }
  }
  if (grass) cap(parts.grass, top, holes, yTop, null);
  else cap(parts.concrete, top, holes, yTop, { aKind: kind });
  return r;
}

/** An inset ring that folded through itself flips its signed area. */
function sameSense(a, b) {
  const area = (pts) => {
    let s = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      s += p[0] * q[1] - q[0] * p[1];
    }
    return s;
  };
  const A = area(a), B = area(b);
  return A * B > 0 && Math.abs(B) < Math.abs(A);
}

/* ------------------------------------------------------------------ roads */

/**
 * Cross-sections the asphalt is built from: every alignment sample, plus the
 * stations where a node's marking zone or the parking-bay run starts or ends,
 * so those boundaries fall on a quad edge. Inserted rows interpolate between
 * the two samples on either side (on the chord, like the curb edges built from
 * the samples, so asphalt and curb stay flush).
 */
function asphaltRows(rr, extra) {
  const S = rr.smp, N = S.s.length;
  const rows = [];
  const fromSample = (i) => ({ s: S.s[i], x: S.x[i], z: S.z[i], th: S.th[i], lay: rr.lays[i] });
  const stations = [...new Set(extra.filter((s) => s > S.s[0] + 0.05 && s < S.s[N - 1] - 0.05))].sort((a, b) => a - b);
  let e = 0;
  for (let i = 0; i < N; i++) {
    while (e < stations.length && stations[e] < S.s[i] - 0.05) {
      const st = stations[e++];
      if (i === 0) continue;
      const f = (st - S.s[i - 1]) / (S.s[i] - S.s[i - 1]);
      const a = rr.lays[i - 1], b = rr.lays[i];
      const lerpSide = (side) => a[side].map((la, k) => {
        const lb = b[side][k];
        const w = la.w + (lb.w - la.w) * f;
        return { ...la, w, tIn: la.tIn + (lb.tIn - la.tIn) * f, tOut: la.tOut + (lb.tOut - la.tOut) * f, present: w > 0.05 };
      });
      const dth = Math.atan2(Math.sin(S.th[i] - S.th[i - 1]), Math.cos(S.th[i] - S.th[i - 1]));
      rows.push({
        s: st, x: S.x[i - 1] + (S.x[i] - S.x[i - 1]) * f, z: S.z[i - 1] + (S.z[i] - S.z[i - 1]) * f,
        th: S.th[i - 1] + dth * f,
        lay: { cw: a.cw + (b.cw - a.cw) * f, left: lerpSide("left"), right: lerpSide("right") },
      });
    }
    while (e < stations.length && Math.abs(stations[e] - S.s[i]) <= 0.05) e++;
    rows.push(fromSample(i));
  }
  for (const r of rows) {
    const p = profileAt(rr.prof, r.s);
    r.y = p.y; r.g = p.g;
    r.lx = Math.sin(r.th); r.lz = -Math.cos(r.th);
  }
  return rows;
}

function buildRoad(rr, parts, o, ctx) {
  const S = rr.smp;
  if (!S || S.s.length < 2) return;
  const N = S.s.length;
  const lays = rr.lays;
  const y = new Float64Array(N), g = new Float64Array(N);
  const lx = new Float64Array(N), lz = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const p = profileAt(rr.prof, S.s[i]);
    y[i] = p.y; g[i] = p.g;
    lx[i] = Math.sin(S.th[i]); lz[i] = -Math.cos(S.th[i]);
  }
  const upAt = (i) => norm3(-g[i] * Math.cos(S.th[i]), 1, -g[i] * Math.sin(S.th[i]));
  const at = (i, t) => [S.x[i] + lx[i] * t, S.z[i] + lz[i] * t];
  const phase = hashPhase(rr.id);
  const deck = { aPiece: [phase, 0], aEdges: [0, 0, 0, 0], aMark: [0, 0, 0, 0] };

  // ── ASPHALT: one quad per segment, carrying the lines and the marking region.
  const zone = ctx.atlas?.zones.get(rr.id) || {};
  const regionOf = (nodeId) => ctx.atlas?.regions.get(nodeId);
  const mr = rr.markRange || [rr.s0, rr.s1];
  const parkFrom = mr[0] + 2, parkTo = mr[1] - 4;
  const rows = asphaltRows(rr, [zone.a?.sEnd, zone.b?.sStart, parkFrom, parkTo].filter((v) => v != null));
  const lines = ctx.markings ? rows.map((r) => sectionLines(rr, r.lay, r.s, ctx.style)) : null;
  const markAt = (sMid) => {
    const reg = zone.a && sMid < zone.a.sEnd ? regionOf(zone.a.nodeId)
      : zone.b && sMid > zone.b.sStart ? regionOf(zone.b.nodeId) : null;
    return reg ? [reg.offset[0], reg.offset[1], 1] : [0, 0, 0];
  };
  const rowUp = (r) => norm3(-r.g * Math.cos(r.th), 1, -r.g * Math.sin(r.th));
  /**
   * −1..1 across the CARRIAGEWAY this point drains in, 0 at its crown: the
   * asphalt shader pools water toward ±1 (the kerbs). A raised median splits
   * the road into two carriageways, each with its own crown.
   */
  const drainAt = (r, t) => {
    const e = layoutEdges(r.lay);
    let lo = e.curbR, hi = e.curbL;
    if (raisedCenter) { if (t >= 0) lo = r.lay.cw / 2; else hi = -r.lay.cw / 2; }
    const w = hi - lo;
    return w < 0.1 ? 0 : Math.max(-1, Math.min(1, (2 * (t - lo)) / w - 1));
  };
  /** A line keeps its code over a segment only if it is painted at both ends (as in the lab). */
  const segCode = (c0, c1) => (c0 && c1 ? c0 : 0);

  /**
   * Asphalt between lateral offsets over every segment.
   *   tA/tB(r)      edges of the strip at row index r
   *   edge(r)       { inT, outT, inCode, outCode } for row r, or null
   *   lateral       [value at tA, value at tB]
   *   parking       bay ticks allowed on this strip
   */
  const asphaltStrip = (tA, tB, edge, lateral, parking, width) => {
    const P = parts.asphalt;
    // Line code per segment for each side, with the dash phase of its RUN folded
    // into the fraction: the lab restarts a dash pattern wherever a line starts
    // or changes style (a pocket's solid line after a dashed one), so a dash
    // here starts where the lab's does. Both strips sharing a boundary compute
    // the same runs, so the two halves of a line stay in step.
    const segs = rows.length - 1;
    const codes = { in: new Float64Array(segs), out: new Float64Array(segs) };
    for (const role of ["in", "out"]) {
      const key = role === "in" ? "inCode" : "outCode";
      let start = 0;
      for (let k = 0; k < segs; k++) {
        const e0 = edge ? edge(k) : null, e1 = edge ? edge(k + 1) : null;
        const c = e0 && e1 ? segCode(e0[key], e1[key]) : 0;
        if (k === 0 || c !== Math.floor(codes[role][k - 1])) start = rows[k].s;
        let frac = 0;
        const dash = c ? decodeLineCode(c).dash : null;
        if (dash) {
          const period = dash[0] + dash[1];
          frac = Math.min(0.999, (((start % period) + period) % period) / period);
        }
        codes[role][k] = c ? c + frac : 0;
      }
    }
    for (let k = 0; k + 1 < rows.length; k++) {
      const r0 = rows[k], r1 = rows[k + 1];
      if (Math.abs(tB(k) - tA(k)) < 0.01 && Math.abs(tB(k + 1) - tA(k + 1)) < 0.01) continue;
      const e0 = edge ? edge(k) : null, e1 = edge ? edge(k + 1) : null;
      const inCode = codes.in[k];
      const outCode = codes.out[k];
      const sMid = (r0.s + r1.s) / 2;
      const m = markAt(sMid);
      const park = parking && ctx.markings && sMid > parkFrom && sMid < parkTo && width(k) > 1.5 && width(k + 1) > 1.5 ? 1 : 0;
      const n = rowUp(r0);
      const ids = [];
      for (const [r, ri, e] of [[r0, k, e0], [r1, k + 1, e1]]) {
        const up = rowUp(r);
        for (const [t, lat] of [[tA(ri), lateral[0]], [tB(ri), lateral[1]]]) {
          ids.push(P.vert(r.x + r.lx * t, r.y, r.z + r.lz * t, up, r.s, t, {
            aLateral: lat,
            aPiece: [phase, drainAt(r, t)],
            aEdges: [e ? e.inT : 0, e ? e.outT : 0, inCode, outCode],
            aMark: [m[0], m[1], m[2], park],
          }));
        }
      }
      P.quad(ids[0], ids[1], ids[3], ids[2], n);
    }
  };

  /** Top strip between lateral offsets tA(i) and tB(i), lifted `lift`. */
  const strip = (part, tA, tB, lift, exA, exB) => {
    const ia = new Array(N), ib = new Array(N);
    for (let i = 0; i < N; i++) {
      const n = upAt(i);
      const a = at(i, tA(i)), b = at(i, tB(i));
      ia[i] = part.vert(a[0], y[i] + lift, a[1], n, S.s[i], tA(i), exA);
      ib[i] = part.vert(b[0], y[i] + lift, b[1], n, S.s[i], tB(i), exB);
    }
    for (let i = 0; i + 1 < N; i++) {
      if (Math.abs(tB(i) - tA(i)) < 0.01 && Math.abs(tB(i + 1) - tA(i + 1)) < 0.01) continue;
      part.quad(ia[i], ib[i], ib[i + 1], ia[i + 1], upAt(i));
    }
  };

  /** Vertical face along lateral offset t(i); outwardSign +1 faces +t (left). */
  const edgeWall = (part, t, outwardSign, yb, yt, bevel, ex, skip) => {
    const P = [];
    for (let i = 0; i < N; i++) {
      const p = at(i, t(i));
      P.push({ x: p[0], z: p[1], yb: y[i] + yb, yt: y[i] + yt, u: S.s[i] });
    }
    wall(part, P, {
      out: (i) => [outwardSign * lx[i], outwardSign * lz[i]],
      seg: (k) => norm2(outwardSign * (lx[k] + lx[k + 1]), outwardSign * (lz[k] + lz[k + 1])),
      inset: (i) => [-outwardSign * lx[i], -outwardSign * lz[i]],
      bevel, ex, skip,
    });
  };

  const ck = rr.stack.center.kind;
  const raisedCenter = !!rr.center && (ck === "raised" || ck === "barrier");
  if (!raisedCenter) {
    let any = false;
    for (const r of rows) if (r.lay.cw > 0.01) { any = true; break; }
    if (any) {
      asphaltStrip((k) => -rows[k].lay.cw / 2, (k) => rows[k].lay.cw / 2,
        lines ? (k) => { const c = lines[k].center; return { inT: c.tA, outT: c.tB, inCode: c.codeA, outCode: c.codeB }; } : null,
        [0, 0], false, (k) => rows[k].lay.cw);
    }
  }

  for (const side of ["left", "right"]) {
    const sg = side === "left" ? 1 : -1;
    const lanes = rr.stack.sides[side];
    const kindOf = (b) => {
      if (b < 0) return raisedCenter ? "raised" : "asphalt";
      if (b >= lanes.length) return "none";
      return LANE_TYPES[lanes[b].type]?.carriage ? "asphalt" : "raised";
    };
    lanes.forEach((lane, b) => {
      const L = (i) => lays[i][side][b];
      const tIn = (i) => L(i).tIn, tOut = (i) => L(i).tOut;
      const empty = (k) => L(k).w < 0.01 && L(k + 1).w < 0.01;

      if (kindOf(b) === "asphalt") {
        const drive = !!LANE_TYPES[lane.type]?.drive;
        const R = (k) => rows[k].lay[side][b];
        asphaltStrip((k) => R(k).tIn, (k) => R(k).tOut, lines ? (k) => lines[k][side][b] : null,
          drive ? [-1, 1] : [0, 0], lane.type === "parking", (k) => R(k).w);
        // Nothing beyond the last carriage lane: close the edge down into the ground.
        if (kindOf(b + 1) === "none") {
          edgeWall(parts.asphalt, tOut, sg, -o.skirt, 0, 0, { ...deck, aLateral: 0 }, empty);
        }
        return;
      }

      const H = o.curbHeight;
      const curb = { aKind: CONCRETE_KIND.curb };
      const curbIn = kindOf(b - 1) === "asphalt";
      const curbOut = kindOf(b + 1) === "asphalt";
      let topIn = tIn, topOut = tOut;
      if (curbIn) {
        edgeWall(parts.concrete, tIn, -sg, 0, H, o.bevel, curb, empty);
        topIn = (i) => tIn(i) + sg * o.bevel;
      }
      if (curbOut) {
        edgeWall(parts.concrete, tOut, sg, 0, H, o.bevel, curb, empty);
        topOut = (i) => tOut(i) - sg * o.bevel;
      } else if (kindOf(b + 1) === "none") {
        edgeWall(parts.concrete, tOut, sg, -o.skirt, H, 0, { aKind: CONCRETE_KIND.slab }, empty);
      }

      if (lane.type === "verge") {
        // Grass inside a curb stone on whichever edge meets the road.
        const band = (i) => Math.max(0, Math.min(o.curbBand, (L(i).w - 2 * o.bevel) / 3));
        let gIn = topIn, gOut = topOut;
        if (curbIn) {
          const edge = topIn;
          gIn = (i) => edge(i) + sg * band(i);
          strip(parts.concrete, edge, gIn, H, curb, curb);
        }
        if (curbOut) {
          const edge = topOut;
          gOut = (i) => edge(i) - sg * band(i);
          strip(parts.concrete, gOut, edge, H, curb, curb);
        }
        strip(parts.grass, gIn, gOut, H, null, null);
      } else {
        const ex = { aKind: lane.type === "sidewalk" ? CONCRETE_KIND.slab : CONCRETE_KIND.curb };
        strip(parts.concrete, topIn, topOut, H, ex, ex);
      }
    });
  }

  if (raisedCenter) {
    // Nearest sample gives the height under any point of the median outline.
    const yAt = (p) => {
      let best = 0, bd = Infinity;
      for (let i = 0; i < N; i++) {
        const d = (S.x[i] - p[0]) ** 2 + (S.z[i] - p[1]) ** 2;
        if (d < bd) { bd = d; best = i; }
      }
      return y[best];
    };
    island(parts, rr.center.poly, o, { yAt, height: o.medianHeight, grass: ck === "raised" });
  }
}

/* ------------------------------------------------------------------ nodes */

function cornerSidewalk(parts, curbChain, propChain, yNode, o) {
  const cc = dedupe(curbChain, false), pc = dedupe(propChain, false);
  if (cc.length < 2 || pc.length < 2) return;
  const poly = [...cc, ...pc.slice().reverse()];
  if (!ring(poly)) return;
  const H = o.curbHeight;
  const topCurb = boundaryWall(parts.concrete, cc, poly, {
    yb: () => yNode, yt: () => yNode + H, bevel: o.bevel, ex: { aKind: CONCRETE_KIND.curb },
  });
  boundaryWall(parts.concrete, pc, poly, {
    yb: () => yNode - o.skirt, yt: () => yNode + H, bevel: 0, ex: { aKind: CONCRETE_KIND.slab },
  });
  cap(parts.concrete, [...topCurb, ...pc.slice().reverse()], [], () => yNode + H, { aKind: CONCRETE_KIND.slab });
}

function deadEnd(parts, node, o) {
  const arm = node.arms[0];
  if (!arm) return;
  const e = arm.edges;
  const depth = Math.max(0, e.curbR - e.propR, e.propL - e.curbL);
  if (depth <= 0.05) return;
  const y0 = node.y;
  const H = o.curbHeight, b = o.bevel;
  const PR = armPoint(arm, 0, e.propR), PL = armPoint(arm, 0, e.propL);
  const CR = armPoint(arm, -depth, e.propR), CL = armPoint(arm, -depth, e.propL);
  // Curb across the carriageway end, facing the road (+σ).
  const P = [armPoint(arm, 0, e.curbR), armPoint(arm, 0, e.curbL)].map((p, i) => ({ x: p[0], z: p[1], yb: y0, yt: y0 + H, u: i ? e.curbL - e.curbR : 0 }));
  const outN = [arm.dx, arm.dz];
  wall(parts.concrete, P, { out: () => outN, seg: () => outN, inset: () => [-arm.dx, -arm.dz], bevel: b, ex: { aKind: CONCRETE_KIND.curb } });
  // Back faces round the three property sides.
  const outline = [PR, CR, CL, PL, armPoint(arm, 0, e.curbL), armPoint(arm, 0, e.curbR)];
  boundaryWall(parts.concrete, [PR, CR, CL, PL], outline, { yb: () => y0 - o.skirt, yt: () => y0 + H, ex: { aKind: CONCRETE_KIND.slab } });
  // Top, notched back by the bevel between the curbs.
  const top = [PR, CR, CL, PL, armPoint(arm, 0, e.curbL), armPoint(arm, -b, e.curbL), armPoint(arm, -b, e.curbR), armPoint(arm, 0, e.curbR)];
  cap(parts.concrete, top, [], () => y0 + H, { aKind: CONCRETE_KIND.slab });
}

function buildNode(node, parts, o, ctx) {
  const yNode = node.y;
  const flat = () => yNode;
  const reg = ctx.atlas?.regions.get(node.id);
  const deck = {
    aLateral: 0, aPiece: [hashPhase(node.id), 0], aEdges: [0, 0, 0, 0],
    aMark: reg ? [reg.offset[0], reg.offset[1], 1, 0] : [0, 0, 0, 0],
  };

  if (node.kind === "end") { deadEnd(parts, node, o); return; }
  if (node.kind !== "junction" && node.kind !== "roundabout" && node.kind !== "continuation") return;

  let apronRing = null;
  if (node.kind === "roundabout") {
    const apron = node.islands.find((i) => i.kind === "apron");
    const grassIsland = node.islands.find((i) => i.kind === "grass");
    apronRing = apron ? ring(apron.poly) : null;
    const grassRing = grassIsland ? ring(grassIsland.poly) : null;
    if (apronRing) {
      island(parts, apronRing, o, { yAt: flat, height: o.apronHeight, kind: CONCRETE_KIND.apron, hole: grassRing });
    }
    if (grassRing) {
      island(parts, grassRing, o, { yAt: flat, base: apronRing ? o.apronHeight : 0, height: o.islandHeight, grass: true });
    }
    for (const isl of node.islands) {
      if (isl.kind === "raised") island(parts, isl.poly, o, { yAt: flat, height: o.curbHeight });
    }
  }

  if (node.pad) {
    const pad = ring(cleanPolygon(dedupe(node.pad, true)));
    if (pad) cap(parts.asphalt, pad, apronRing ? [apronRing] : [], flat, deck);
  }

  for (const c of node.corners || []) {
    if (!c.sw || !c.curbChain || !c.propChain) continue;
    cornerSidewalk(parts, c.curbChain, c.propChain, yNode, o);
  }
}

/* ------------------------------------------------------------------ entry */

/**
 * @param {object} result  buildRoadNetwork() output
 * @param {Partial<typeof MESH_DEFAULTS>} [opts]
 * @returns {{ asphalt, concrete, grass, atlas, stats: { ms, vertices, triangles } }}
 *   atlas: markingAtlas.js output (RGBA data + scale) or null
 */
export function buildLaneRoadMesh(result, opts = {}) {
  const t0 = now();
  const o = { ...MESH_DEFAULTS, ...opts };
  const parts = {
    asphalt: new Part({ aLateral: 1, aPiece: 2, aEdges: 4, aMark: 4 }),
    concrete: new Part({ aKind: 1 }),
    grass: new Part({}),
  };
  const atlas = o.markings ? buildMarkingAtlas(result, { texel: o.atlasTexel }) : null;
  const ctx = { atlas, markings: !!o.markings, style: result.style || "eu" };
  for (const rr of result.roads) buildRoad(rr, parts, o, ctx);
  for (const node of result.nodes) buildNode(node, parts, o, ctx);
  const out = { atlas };
  let vertices = 0, triangles = 0;
  for (const [name, part] of Object.entries(parts)) {
    out[name] = part.finish();
    vertices += out[name].vertexCount;
    triangles += out[name].triangleCount;
  }
  out.stats = { ms: now() - t0, vertices, triangles };
  return out;
}
