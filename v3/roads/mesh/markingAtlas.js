// Junction markings as a signed-distance atlas for the asphalt shader.
//
// Lines that run ALONG a road are drawn analytically by the shader from lane
// data (laneRoadMesh.js, aEdges). Everything else a node paints — crosswalk
// bars, stop lines, yield teeth, arrows, gore hatching, a roundabout's ring
// lines — is irregular, so it is rasterised here into one RG8 texture:
//
//   R  signed distance to the nearest marking edge, positive INSIDE paint,
//      clamped to ±RANGE and stored as 0..255 (so bilinear filtering gives a
//      sharp, antialiasable edge at any zoom)
//   G  half-width of that nearest marking in metres (0..1 → 0..255), so the
//      shader's wear can bite a FRACTION of each shape's own width — the same
//      rule the city street uses, which keeps a thin arrow shaft from being
//      eaten away while a wide crossing bar still frays.
//
// No colour channel: every node marking the engine emits is white (lines along
// roads, where yellow lives, are analytic and carry their own colour).
//
// Measured 2026-09-14: a 4-way junction is ~1230² texels at 6 cm (3 MB, 5 ms);
// the downtown demo's 23 junctions 3288×3600 (24 MB, 48 ms). City scale will
// want tighter per-arm regions or paging.
//
// One REGION per node, axis-aligned in plan space. It covers the node's pad,
// every marking, and the stretch of each connecting road that carries them (a
// crosswalk or an arrow sits on the road past the junction trim). Those road
// stretches are ZONES: the mesh builder tags asphalt in a zone with the node's
// region so the shader samples the right part of the atlas.
//
// Plain JS, no three.js.

import { polylineLength, cumulative, polylineAt, pointInPolygon } from "../roadMath.js";
import { evalAlignment } from "../roadAlignment.js";
import { layoutAt, layoutEdges } from "../roadCrossSection.js";

export const ATLAS_RANGE = 0.3; // metres of distance stored either side of an edge
const PAD_TEXELS = 4;
const MAX_SIZE = 4096;

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

/** Parallel stripes clipped to a polygon → 2-point segments. */
function hatchSegments(m) {
  const poly = m.poly;
  const dx = Math.cos(m.angle), dz = Math.sin(m.angle);
  const nx = -dz, nz = dx;
  let lo = Infinity, hi = -Infinity;
  for (const p of poly) { const c = p[0] * nx + p[1] * nz; lo = Math.min(lo, c); hi = Math.max(hi, c); }
  const segs = [];
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
      if (hits[k + 1].u - hits[k].u >= 0.1) segs.push([[hits[k].x, hits[k].z], [hits[k + 1].x, hits[k + 1].z]]);
    }
  }
  return segs;
}

/** Every node marking as a rasterisable shape: { kind:'poly', pts } | { kind:'line', pts, hw }. */
export function nodeShapes(node) {
  const shapes = [];
  for (const m of node.markings || []) {
    const yellow = m.color === "yellow";
    if (m.kind === "poly") shapes.push({ kind: "poly", pts: m.pts, yellow });
    else if (m.kind === "line") {
      for (const piece of dashPieces(m.pts, m.dash)) shapes.push({ kind: "line", pts: piece, hw: m.width / 2, yellow });
    } else if (m.kind === "hatch") {
      for (const seg of hatchSegments(m)) shapes.push({ kind: "line", pts: seg, hw: m.width / 2, yellow });
    }
  }
  return shapes;
}

function segDist(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const L2 = dx * dx + dz * dz;
  const t = L2 > 1e-12 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / L2)) : 0;
  return Math.hypot(px - ax - dx * t, pz - az - dz * t);
}

/**
 * Regions and road zones for every node that paints something.
 * @returns {{ regions: object[], zones: Map<string, { a?: {sEnd, nodeId}, b?: {sStart, nodeId} }> }}
 */
export function planMarkings(result) {
  const regions = [];
  const zones = new Map();
  for (const node of result.nodes) {
    const shapes = nodeShapes(node);
    if (!shapes.length) continue;
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    const grow = (x, z, r = 0) => { x0 = Math.min(x0, x - r); z0 = Math.min(z0, z - r); x1 = Math.max(x1, x + r); z1 = Math.max(z1, z + r); };
    const pts = [];
    for (const sh of shapes) for (const p of sh.pts) { pts.push(p); grow(p[0], p[1], (sh.hw || 0) + ATLAS_RANGE); }
    for (const p of node.pad || []) grow(p[0], p[1]);

    // Road stretches that carry this node's paint: how far along each arm it reaches.
    for (const arm of node.arms) {
      const rr = arm.road;
      if (!rr.smp) continue;
      let reach = -Infinity;
      for (const p of pts) {
        const ox = p[0] - arm.ox, oz = p[1] - arm.oz;
        const lat = ox * arm.nx + oz * arm.nz;
        if (lat < arm.edges.propR - 1 || lat > arm.edges.propL + 1) continue;
        reach = Math.max(reach, ox * arm.dx + oz * arm.dz);
      }
      reach += 0.75;
      const z = zones.get(rr.id) || {};
      if (arm.end === "a") {
        if (reach <= rr.s0) continue;
        z.a = { sEnd: Math.min(reach, rr.s1), nodeId: node.id };
        for (const s of [rr.s0, z.a.sEnd]) footprint(rr, s, grow);
      } else {
        const sStart = rr.L - reach;
        if (sStart >= rr.s1) continue;
        z.b = { sStart: Math.max(sStart, rr.s0), nodeId: node.id };
        for (const s of [z.b.sStart, rr.s1]) footprint(rr, s, grow);
      }
      zones.set(rr.id, z);
    }
    regions.push({ nodeId: node.id, shapes, bbox: [x0, z0, x1, z1] });
  }
  return { regions, zones };
}

/** Both carriage edges of a road at station s, into the region's box. */
function footprint(rr, s, grow) {
  const e = evalAlignment(rr.al, s);
  const ed = layoutEdges(layoutAt(rr.stack, s, rr.L));
  const sx = Math.sin(e.th), sz = -Math.cos(e.th);
  for (const t of [ed.propL, ed.propR]) grow(e.x + sx * t, e.z + sz * t, 0.5);
}

/** Shelf-pack region rectangles (in texels). Sizes need not be powers of two. */
function pack(regions, texel) {
  for (const r of regions) {
    r.w = Math.ceil((r.bbox[2] - r.bbox[0]) / texel) + 2 * PAD_TEXELS;
    r.h = Math.ceil((r.bbox[3] - r.bbox[1]) / texel) + 2 * PAD_TEXELS;
  }
  const area = regions.reduce((a, r) => a + r.w * r.h, 0);
  const widest = Math.max(...regions.map((r) => r.w));
  const W = Math.ceil(Math.max(widest, Math.sqrt(area * 1.15)) / 4) * 4;
  const order = regions.slice().sort((a, b) => b.h - a.h);
  let x = 0, y = 0, shelf = 0;
  for (const r of order) {
    if (x + r.w > W) { x = 0; y += shelf; shelf = 0; }
    r.px = x; r.py = y;
    x += r.w;
    shelf = Math.max(shelf, r.h);
  }
  return { W, H: Math.ceil((y + shelf) / 4) * 4 };
}

/**
 * Build the atlas for a network.
 * @param {object} result  buildRoadNetwork() output
 * @param {{ texel?: number }} [opts]  metres per texel (grows until it fits MAX_SIZE)
 */
export function buildMarkingAtlas(result, opts = {}) {
  const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
  const { regions, zones } = planMarkings(result);
  if (!regions.length) return null;
  let texel = opts.texel ?? 0.06;
  let size;
  for (;;) {
    size = pack(regions, texel);
    if ((size.W <= MAX_SIZE && size.H <= MAX_SIZE) || texel > 0.5) break;
    texel *= 1.2;
  }
  const { W, H } = size;
  // RG8: R = signed distance, G = half-width. Zero = far outside, no width.
  const data = new Uint8Array(W * H * 2);
  const byNode = new Map();
  for (const r of regions) {
    r.bx0 = r.bbox[0] - PAD_TEXELS * texel;
    r.bz0 = r.bbox[1] - PAD_TEXELS * texel;
    for (const sh of r.shapes) rasterShape(sh, r, texel, data, W);
    // uv = xz · scale + offset, with scale = 1 / (texel · size).
    byNode.set(r.nodeId, { offset: [(r.px - r.bx0 / texel) / W, (r.py - r.bz0 / texel) / H], bbox: r.bbox });
  }
  const t1 = typeof performance !== "undefined" ? performance.now() : Date.now();
  return {
    data, width: W, height: H, texel, range: ATLAS_RANGE, channels: 2,
    scale: [1 / (texel * W), 1 / (texel * H)],
    regions: byNode, zones,
    stats: { ms: t1 - t0, regions: regions.length, shapes: regions.reduce((a, r) => a + r.shapes.length, 0), bytes: data.length },
  };
}

/**
 * Signed distance of one shape into the texels near it. Union of shapes =
 * the larger distance, compared on the stored byte (2.4 mm steps), so no float
 * buffer is needed. A polygon's half-width is its deepest inside distance.
 */
function rasterShape(sh, r, texel, data, W) {
  const pts = sh.pts;
  const closed = sh.kind === "poly";
  if (pts.length < (closed ? 3 : 2)) return;
  const margin = (sh.hw || 0) + ATLAS_RANGE;
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p[0]); z0 = Math.min(z0, p[1]); x1 = Math.max(x1, p[0]); z1 = Math.max(z1, p[1]); }
  const ix0 = Math.max(0, Math.floor((x0 - margin - r.bx0) / texel)), ix1 = Math.min(r.w - 1, Math.ceil((x1 + margin - r.bx0) / texel));
  const iz0 = Math.max(0, Math.floor((z0 - margin - r.bz0) / texel)), iz1 = Math.min(r.h - 1, Math.ceil((z1 + margin - r.bz0) / texel));
  if (ix1 < ix0 || iz1 < iz0) return;
  const nw = ix1 - ix0 + 1, nh = iz1 - iz0 + 1;
  const local = new Float32Array(nw * nh);
  const segs = closed ? pts.length : pts.length - 1;
  let deepest = 0;
  for (let iz = 0; iz < nh; iz++) {
    const pz = r.bz0 + (iz0 + iz + 0.5) * texel;
    for (let ix = 0; ix < nw; ix++) {
      const px = r.bx0 + (ix0 + ix + 0.5) * texel;
      let m = Infinity;
      for (let s = 0; s < segs; s++) {
        const a = pts[s], b = pts[(s + 1) % pts.length];
        const dx = b[0] - a[0], dz = b[1] - a[1];
        const L2 = dx * dx + dz * dz;
        const t = L2 > 1e-12 ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (pz - a[1]) * dz) / L2)) : 0;
        const ex = px - a[0] - dx * t, ez = pz - a[1] - dz * t;
        const d2 = ex * ex + ez * ez;
        if (d2 < m) m = d2;
      }
      m = Math.sqrt(m);
      const d = closed ? (pointInPolygon(px, pz, pts) ? m : -m) : sh.hw - m;
      local[iz * nw + ix] = d;
      if (d > deepest) deepest = d;
    }
  }
  const hwByte = Math.round(Math.min(1, closed ? deepest : sh.hw) * 255);
  for (let iz = 0; iz < nh; iz++) {
    const row = (r.py + iz0 + iz) * W;
    for (let ix = 0; ix < nw; ix++) {
      const d = Math.max(-ATLAS_RANGE, Math.min(ATLAS_RANGE, local[iz * nw + ix]));
      const byte = Math.round((d / ATLAS_RANGE * 0.5 + 0.5) * 255);
      const o = (row + r.px + ix0 + ix) * 2;
      if (byte > data[o]) { data[o] = byte; data[o + 1] = hwByte; }
    }
  }
}

/** Polyline length helper re-exported for tests. */
export { polylineLength };
