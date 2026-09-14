// City blocks = the faces of the road graph, bounded by PROPERTY lines.
//
// Walk half-edges: go along a road with the block on your right (its right
// property line), and at the far node turn onto the previous arm in the node's
// sorted order, following that corner's property chain. Every closed walk is a
// face; bounded faces come out with POSITIVE shoelace area in (x, z) because
// "block on your right" is clockwise on screen. The outer face is negative.
//
// The boundary is exact: curb returns, sidewalk widths, roundabout rings and
// dead-end caps are all already in the corner chains, so a building placed on a
// lot can never overhang a sidewalk.
//
// Lots: recursive split across the long axis of each piece's minimum-area
// bounding box (CityEngine-style), jittered, until pieces are lot-sized. A lot
// that lost all street frontage is flagged `street: false` (courtyard / park).

import { cleanPolygon, polygonArea, clipHalfPlane, rng, polygonCentroid, pointInPolygon } from "./roadMath.js";

export function buildBlocks(nodes, roads, opts = {}) {
  const visited = new Set();
  const blocks = [];
  const key = (id, dir) => `${id}|${dir}`;
  for (const start of roads) {
    for (const dir0 of ["ab", "ba"]) {
      if (visited.has(key(start.id, dir0))) continue;
      const poly = [];
      let cur = { rr: start, dir: dir0 };
      let closed = false;
      const roadIds = new Set();
      for (let guard = 0; guard < 4000; guard++) {
        const k = key(cur.rr.id, cur.dir);
        if (visited.has(k)) { closed = cur.rr === start && cur.dir === dir0; break; }
        visited.add(k);
        roadIds.add(cur.rr.id);
        const E = cur.rr.edgesPts;
        if (!E) break;
        if (cur.dir === "ab") poly.push(...E.propR);
        else for (let i = E.propL.length - 1; i >= 0; i--) poly.push(E.propL[i]);
        const arm = cur.dir === "ab" ? cur.rr.armB : cur.rr.armA;
        const node = arm.node;
        const arms = node.arms;
        const k0 = arms.indexOf(arm);
        const prev = (k0 - 1 + arms.length) % arms.length;
        const corner = node.corners?.[prev];
        if (corner?.propChain) for (let i = corner.propChain.length - 1; i >= 0; i--) poly.push(corner.propChain[i]);
        const nxt = arms[prev];
        cur = { rr: nxt.road, dir: nxt.end === "a" ? "ab" : "ba" };
      }
      if (!closed || poly.length < 3) continue;
      const clean = cleanPolygon(poly);
      if (clean.length < 3) continue;
      const area = polygonArea(clean);
      if (area < (opts.minBlockArea ?? 40)) continue;
      blocks.push({ id: `b${blocks.length}`, poly: clean, area, roads: [...roadIds], center: polygonCentroid(clean) });
    }
  }
  // A face that another road runs through is not a block — it comes from
  // roads crossing at different levels (an overpass is not a graph edge).
  const kept = blocks.filter((b) => {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const p of b.poly) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); z0 = Math.min(z0, p[1]); z1 = Math.max(z1, p[1]); }
    const own = new Set(b.roads);
    for (const rr of roads) {
      if (own.has(rr.id) || !rr.smp) continue;
      const S = rr.smp;
      for (let i = 0; i < S.s.length; i++) {
        const x = S.x[i], z = S.z[i];
        if (x < x0 || x > x1 || z < z0 || z > z1) continue;
        if (pointInPolygon(x, z, b.poly)) return false;
      }
    }
    return true;
  });
  kept.forEach((b, i) => (b.id = `b${i}`));
  for (const b of kept) {
    b.lots = opts.lots === false ? [] : subdivideBlock(b.poly, hashSeed(b.center), opts.lot || {});
  }
  return kept;
}

function hashSeed([x, z]) {
  return (Math.round(x * 7) * 73856093) ^ (Math.round(z * 7) * 19349663);
}

export function subdivideBlock(poly, seed, o = {}) {
  const target = o.target ?? 850;
  const minArea = o.minArea ?? 90;
  const maxDepth = o.maxDepth ?? 11;
  const rand = rng(seed);
  const lots = [];
  const split = (pts, flags, depth) => {
    const area = Math.abs(polygonArea(pts));
    if (area < minArea * 0.25) return;
    if (area <= target * 1.35 || depth >= maxDepth) {
      lots.push({ poly: pts, area, street: flags.some(Boolean) });
      return;
    }
    // Minimum-area box over the piece's edge directions.
    let best = null;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (len < 0.5) continue;
      const ux = (q[0] - p[0]) / len, uz = (q[1] - p[1]) / len;
      let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
      for (const r of pts) {
        const u = r[0] * ux + r[1] * uz, v = -r[0] * uz + r[1] * ux;
        if (u < u0) u0 = u; if (u > u1) u1 = u;
        if (v < v0) v0 = v; if (v > v1) v1 = v;
      }
      const a = (u1 - u0) * (v1 - v0);
      if (!best || a < best.a) best = { a, ux, uz, u0, u1, v0, v1 };
    }
    if (!best) { lots.push({ poly: pts, area, street: flags.some(Boolean) }); return; }
    const alongU = best.u1 - best.u0 >= best.v1 - best.v0;
    const ax = alongU ? best.ux : -best.uz, az = alongU ? best.uz : best.ux;
    const lo = alongU ? best.u0 : best.v0, hi = alongU ? best.u1 : best.v1;
    const c = lo + (hi - lo) * (0.5 + (rand() - 0.5) * 0.22);
    const A = clipHalfPlane(pts, flags, ax, az, c, false);
    const B = clipHalfPlane(pts, flags, -ax, -az, -c, false);
    if (A.pts.length < 3 || B.pts.length < 3) { lots.push({ poly: pts, area, street: flags.some(Boolean) }); return; }
    split(A.pts, A.flags, depth + 1);
    split(B.pts, B.flags, depth + 1);
  };
  split(poly, poly.map(() => true), 0);
  return lots;
}
