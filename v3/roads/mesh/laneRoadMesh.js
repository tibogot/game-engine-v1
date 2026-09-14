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
//   paint    — every marking as thin geometry `paintLift` above the surface it
//              sits on: lane/edge/centre lines as ribbons (dashes cut in
//              metres), crosswalk bars, stop lines, yield teeth and arrow heads
//              triangulated, gore hatching clipped to its area. aPaint 0 white,
//              1 yellow. Height comes from result.locate(), so paint follows
//              the road profile or the node it lies on.
//
// ATTRIBUTES (asphalt) match games/modular-road-v3/modularRoadMaterial.js:
//   uv       x = metres along the road (station), y = metres across (lateral t);
//            pads use world x/z (their asphalt fields are high-frequency, so
//            the phase change at the pad edge is invisible — see that file).
//   aLateral −1..1 across EACH driving lane (lane strips are not welded to each
//            other), so the wheel-path bands land in every lane. 0 elsewhere.
//   aPiece   (per-road noise phase, −1e4 = no start/finish checker)
//   aCurve 0, aPlain 1 (no track paint), aZone 1 (deck).
// concrete carries aKind: 0 slab, 1 curb stone, 2 apron setts.
//
// Triangles are wound from the normal they are meant to have, so nothing here
// depends on the winding the engine happened to build a polygon with.

import { LANE_TYPES } from "../roadCrossSection.js";
import { profileAt } from "../roadProfile.js";
import { cleanPolygon, cumulative, polylineAt } from "../roadMath.js";
import { armPoint } from "../roadJunction.js";
import { dedupe, ring, miters, insideSide, triangulate, offsetLeft } from "./triangulate.js";

export const MESH_DEFAULTS = {
  curbHeight: 0.15, // sidewalks, splitter islands, dead-end caps
  medianHeight: 0.18, // raised medians — a touch taller, and never coplanar with a sidewalk
  apronHeight: 0.07, // roundabout truck apron (mountable)
  islandHeight: 0.18, // roundabout central island
  bevel: 0.02, // 45° chamfer on every curb's top edge (0 = sharp)
  curbBand: 0.15, // concrete curb stone around grass tops
  skirt: 0.6, // how far back faces run below the road surface
  // Paint above the asphalt. With the editor's 0.5 m near plane a 24-bit depth
  // step is ~5 mm at 200 m, so 1 cm plus the material's depth bias holds out to
  // a few hundred metres, where a 12 cm line is under a pixel anyway.
  paintLift: 0.01,
  markings: true,
};

export const PAINT_COLOR = { white: 0, yellow: 1 };

export const CONCRETE_KIND = { slab: 0, curb: 1, apron: 2 };
const NO_CHECKER = -1e4;
const UP = [0, 1, 0];

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

function buildRoad(rr, parts, o) {
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
  const deck = { aPiece: [phase, NO_CHECKER], aCurve: 0, aPlain: 1, aZone: 1 };

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
    for (let i = 0; i < N; i++) if (lays[i].cw > 0.01) { any = true; break; }
    if (any) {
      const ex = { ...deck, aLateral: 0 };
      strip(parts.asphalt, (i) => -lays[i].cw / 2, (i) => lays[i].cw / 2, 0, ex, ex);
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
        strip(parts.asphalt, tIn, tOut, 0, { ...deck, aLateral: drive ? -1 : 0 }, { ...deck, aLateral: drive ? 1 : 0 });
        // Nothing beyond the last carriage lane: close the edge down into the ground.
        if (kindOf(b + 1) === "none") {
          edgeWall(parts.asphalt, tOut, sg, -o.skirt, 0, 0, { ...deck, aLateral: 0, aZone: 0 }, empty);
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

function buildNode(node, parts, o) {
  const yNode = node.y;
  const flat = () => yNode;
  const deck = { aLateral: 0, aPiece: [hashPhase(node.id), NO_CHECKER], aCurve: 0, aPlain: 1, aZone: 1 };

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

/* ------------------------------------------------------------------ markings */

/** Split a polyline into dash pieces, `dash = [on, off]` in metres from its start. */
export function dashPieces(pts, dash) {
  if (!dash) return [pts];
  const cum = cumulative(pts);
  const total = cum[cum.length - 1];
  const [on, off] = dash;
  const period = on + off;
  const at = (d) => { const p = polylineAt(pts, cum, d); return [p.x, p.z]; };
  const out = [];
  for (let d0 = 0; d0 < total - 0.05; d0 += period) {
    const d1 = Math.min(total, d0 + on);
    if (d1 - d0 < 0.2) continue;
    const piece = [at(d0)];
    for (let i = 0; i < pts.length; i++) if (cum[i] > d0 + 1e-3 && cum[i] < d1 - 1e-3) piece.push(pts[i]);
    piece.push(at(d1));
    out.push(piece);
  }
  return out;
}

function paintLine(part, pts, width, color, yAt) {
  const p = dedupe(pts, false);
  if (p.length < 2 || width <= 0) return;
  const L = offsetLeft(p, false, width / 2), R = offsetLeft(p, false, -width / 2);
  const ex = { aPaint: PAINT_COLOR[color] ?? 0 };
  let u = 0;
  const ids = [];
  for (let i = 0; i < p.length; i++) {
    if (i) u += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
    const y = yAt(p[i]);
    ids.push([part.vert(L[i][0], y, L[i][1], UP, u, 0, ex), part.vert(R[i][0], y, R[i][1], UP, u, width, ex)]);
  }
  for (let i = 0; i + 1 < p.length; i++) part.quad(ids[i][0], ids[i][1], ids[i + 1][1], ids[i + 1][0], UP);
}

function paintPoly(part, pts, color, yAt) {
  const r = ring(pts, 1e-4);
  if (!r) return;
  const { pts: P, tris } = triangulate(r);
  const ex = { aPaint: PAINT_COLOR[color] ?? 0 };
  const id = P.map((q) => part.vert(q[0], yAt(q), q[1], UP, q[0], q[1], ex));
  for (let t = 0; t < tris.length; t += 3) part.tri(id[tris[t]], id[tris[t + 1]], id[tris[t + 2]], UP);
}

/** Parallel stripes at `angle`, `spacing` apart, clipped to the polygon. */
function paintHatch(part, m, yAt) {
  const poly = ring(m.poly);
  if (!poly) return;
  const dx = Math.cos(m.angle), dz = Math.sin(m.angle);
  const nx = -dz, nz = dx;
  let lo = Infinity, hi = -Infinity;
  for (const p of poly) { const c = p[0] * nx + p[1] * nz; lo = Math.min(lo, c); hi = Math.max(hi, c); }
  for (let c = lo + m.spacing / 2; c < hi; c += m.spacing) {
    const hits = [];
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length];
      const dp = p[0] * nx + p[1] * nz - c, dq = q[0] * nx + q[1] * nz - c;
      if ((dp < 0) === (dq < 0)) continue;
      const t = dp / (dp - dq);
      const x = p[0] + (q[0] - p[0]) * t, z = p[1] + (q[1] - p[1]) * t;
      hits.push({ x, z, u: x * dx + z * dz });
    }
    hits.sort((a, b) => a.u - b.u);
    for (let k = 0; k + 1 < hits.length; k += 2) {
      if (hits[k + 1].u - hits[k].u < 0.1) continue;
      paintLine(part, [[hits[k].x, hits[k].z], [hits[k + 1].x, hits[k + 1].z]], m.width, m.color, yAt);
    }
  }
}

function buildMarkings(result, part, o) {
  // Paint sits on whatever surface is under it: a pad, a road at its profile
  // height. The fallback only matters for a point just outside every footprint.
  const heightAt = (fallback) => (p) => (result.locate(p[0], p[1])?.y ?? fallback) + o.paintLift;
  for (const rr of result.roads) {
    const yAt = heightAt(rr.yMean ?? 0);
    for (const line of rr.lines || []) {
      for (const piece of dashPieces(line.pts, line.dash)) paintLine(part, piece, line.width, line.color, yAt);
    }
  }
  for (const node of result.nodes) {
    const yAt = heightAt(node.y);
    for (const m of node.markings || []) {
      if (m.kind === "poly") paintPoly(part, m.pts, m.color, yAt);
      else if (m.kind === "line") {
        for (const piece of dashPieces(m.pts, m.dash)) paintLine(part, piece, m.width, m.color, yAt);
      } else if (m.kind === "hatch") paintHatch(part, m, yAt);
    }
  }
}

/* ------------------------------------------------------------------ entry */

/**
 * @param {object} result  buildRoadNetwork() output
 * @param {Partial<typeof MESH_DEFAULTS>} [opts]
 * @returns {{ asphalt, concrete, grass, paint, stats: { ms, vertices, triangles } }}
 */
export function buildLaneRoadMesh(result, opts = {}) {
  const t0 = now();
  const o = { ...MESH_DEFAULTS, ...opts };
  const parts = {
    asphalt: new Part({ aLateral: 1, aPiece: 2, aCurve: 1, aPlain: 1, aZone: 1 }),
    concrete: new Part({ aKind: 1 }),
    grass: new Part({}),
    paint: new Part({ aPaint: 1 }),
  };
  for (const rr of result.roads) buildRoad(rr, parts, o);
  for (const node of result.nodes) buildNode(node, parts, o);
  if (o.markings) buildMarkings(result, parts.paint, o);
  const out = {};
  let vertices = 0, triangles = 0;
  for (const [name, part] of Object.entries(parts)) {
    out[name] = part.finish();
    vertices += out[name].vertexCount;
    triangles += out[name].triangleCount;
  }
  out.stats = { ms: now() - t0, vertices, triangles };
  return out;
}
