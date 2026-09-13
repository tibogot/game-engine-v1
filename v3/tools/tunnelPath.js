/**
 * v3/tools/tunnelPath.js — the maths behind Tunnel mode, with no render
 * objects, so it runs headlessly in tools/tunnelPathTest.mjs.
 *
 * A tunnel is { nodes, width, height, thickness, style, roughness,
 * closedStart, closedEnd }. Nodes are { x, z, y, pinned, scale }, y = FLOOR
 * height (what you walk on), scale = local size multiplier (a chamber).
 *
 *   resolveNodeHeights  — an OPEN end node uses its own y (the mouth is where
 *                         you clicked); a middle node, or a CLOSED end (a dead
 *                         end inside the hill), uses its y only when pinned,
 *                         otherwise it follows the grade — or stays level with
 *                         the last anchor past it.
 *   sampleTunnel        — centripetal Catmull-Rom through the resolved nodes,
 *                         ~1 m stations, each with a frame whose RIGHT axis is
 *                         horizontal (the floor never rolls), a size scale
 *                         (node sizes eased between nodes, tapered to a dome at
 *                         a closed end) and a roughness fade (0 at open mouths).
 *   tunnelProfile       — "tunnel": flat floor, straight walls, elliptical arch.
 *                         "cave": the same outline as ONE smooth shell over a
 *                         flat floor, so displacement can make it organic.
 *                         Inner (seen from inside) + outer, point for point.
 *   buildTunnelGeometry — sweeps both surfaces, caps the portal rings, closes a
 *                         closed end. Cave style pushes the shell outward by
 *                         world-space noise.
 *   computeCuttings     — "dig in" at an open end: the mouth drops below the
 *                         ground and a straight ramp cutting (floor, sloped
 *                         walls, a headwall over the portal) leads down to it.
 *                         Built as MESH + terrain opening, never by editing
 *                         heights, so it follows every edit and undo for free.
 *   rasterizeTunnelHoles— which splat texels the terrain must be cut at: where
 *                         the ground passes THROUGH the tube's cross-section,
 *                         and over each cutting.
 *
 * Lighting is BAKED into the mesh (aEmit: lamp pools + daylight near open
 * mouths; aGlow: the lamp fixtures), so it costs nothing per pixel.
 */
import * as THREE from "three";

export const TUNNEL_DEFAULTS = Object.freeze({ width: 8, height: 7, thickness: 1 });
export const CAVE_DEFAULTS = Object.freeze({ width: 7, height: 6, thickness: 1.5, roughness: 0.9 });
/** Entrance cutting: ground left over the arch at the portal, ramp length (0 = auto), wall run per metre of rise. */
export const CUT_DEFAULTS = Object.freeze({ cover: 1.5, length: 0, slope: 0.5 });
/** Baked lighting: lamp spacing (m), brightness, colour; daylight near open mouths. */
export const LIGHT_DEFAULTS = Object.freeze({ lampSpacing: 14, lampIntensity: 1, lampColor: "#ffd49a", daylight: 0.7 });
const SKY_LIGHT = [0.62, 0.72, 0.86];
/** Floor sits this far above a mouth's ground, so ground and floor never z-fight. */
export const FLOOR_LIFT = 0.05;
export const MIN_NODE_SCALE = 0.3;
export const MAX_NODE_SCALE = 6;
/** Size a closed end tapers to before its cap (fraction of the full section). */
const CLOSED_TIP = 0.12;

export function tunnelDims({ width, height, thickness }) {
  const hw = Math.max(0.5, width * 0.5);
  const h = Math.max(hw, height);        // at least a half-circle
  const wallH = h - hw;
  const rise = h - wallH;                 // = hw unless the arch is squashed
  const T = Math.max(0.1, thickness);
  return { hw, height: h, wallH, rise, T };
}

const _smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const _nodeScale = (nd) => Math.min(MAX_NODE_SCALE, Math.max(MIN_NODE_SCALE, Number.isFinite(nd?.scale) ? nd.scale : 1));

// ── Heights ──────────────────────────────────────────────────────────────────

/** How far a dug-in mouth's floor sits below the ground at its node. */
export function digDepth(tunnel, node) {
  const h = tunnel.height ?? TUNNEL_DEFAULTS.height, T = tunnel.thickness ?? TUNNEL_DEFAULTS.thickness;
  return h * _nodeScale(node) + T + (tunnel.cutCover ?? CUT_DEFAULTS.cover);
}

export function resolveNodeHeights(nodes, opts = {}) {
  const { closedStart = false, closedEnd = false, digStart = false, digEnd = false } = opts;
  const n = nodes.length;
  const ys = new Array(n);
  if (n === 0) return ys;
  // Node y is the GROUND where an open end was clicked; dug in, the floor is
  // below it. A pinned node's y is always the floor itself.
  const yOf = (i) => {
    const nd = nodes[i];
    if (nd.pinned) return nd.y;
    if ((i === 0 && digStart && !closedStart) || (i === n - 1 && digEnd && !closedEnd)) return nd.y - digDepth(opts, nd);
    return nd.y;
  };
  const dist = new Array(n);
  dist[0] = 0;
  for (let i = 1; i < n; i++) {
    dist[i] = dist[i - 1] + Math.hypot(nodes[i].x - nodes[i - 1].x, nodes[i].z - nodes[i - 1].z);
  }
  const isAnchor = (i) => nodes[i].pinned === true
    || (i === 0 && !closedStart) || (i === n - 1 && !closedEnd);
  let prev = -1;
  for (let i = 0; i < n; i++) {
    if (isAnchor(i)) { ys[i] = yOf(i); prev = i; continue; }
    let next = i + 1;
    while (next < n && !isAnchor(next)) next++;
    if (prev < 0 && next >= n) { ys[i] = nodes[i].y; continue; }     // no anchor at all
    if (prev < 0) { ys[i] = yOf(next); continue; }                    // level with the first anchor
    if (next >= n) { ys[i] = yOf(prev); continue; }                   // level with the last anchor
    const span = dist[next] - dist[prev];
    const t = span > 1e-6 ? (dist[i] - dist[prev]) / span : 0;
    ys[i] = yOf(prev) + (yOf(next) - yOf(prev)) * t;
  }
  return ys;
}

// ── Centreline ───────────────────────────────────────────────────────────────

/**
 * @returns {null | { length:number, points:{x,y,z,s}[], tangents:THREE.Vector3[],
 *   rights:THREE.Vector3[], ups:THREE.Vector3[], scales:number[], fades:number[] }}
 */
export function sampleTunnel(tunnel, step = 1, maxStations = 4000) {
  const nodes = tunnel.nodes;
  if (!nodes || nodes.length < 2) return null;
  const n = nodes.length;
  const ys = resolveNodeHeights(nodes, tunnel);
  const pts = nodes.map((nd, i) => new THREE.Vector3(nd.x, ys[i] + FLOOR_LIFT, nd.z));
  const curve = n === 2
    ? new THREE.LineCurve3(pts[0], pts[1])
    : new THREE.CatmullRomCurve3(pts, false, "centripetal");
  const length = curve.getLength();
  if (!(length > 0.5)) return null;
  const count = Math.max(2, Math.min(maxStations, Math.ceil(length / step)));

  const halfW = (tunnel.width ?? TUNNEL_DEFAULTS.width) * 0.5;
  const T = tunnel.thickness ?? TUNNEL_DEFAULTS.thickness;
  const s0 = _nodeScale(nodes[0]), s1 = _nodeScale(nodes[n - 1]);
  // Closed end: a dome over roughly the section's half-width.
  const taperStart = Math.max(2, halfW * s0 * 1.2), taperEnd = Math.max(2, halfW * s1 * 1.2);
  // Roughness fades out toward an OPEN mouth, where the terrain cut must meet a
  // predictable shell.
  const fadeStart = halfW * s0 + T + 2, fadeEnd = halfW * s1 + T + 2;

  const points = [], tangents = [], rights = [], ups = [], scales = [], fades = [];
  let lastRight = null;
  for (let k = 0; k <= count; k++) {
    const u = k / count;
    const s = u * length;
    const p = curve.getPointAt(u);
    const t = curve.getTangentAt(u).normalize();
    // Horizontal right axis (t × worldUp), so the floor stays level across.
    let right = new THREE.Vector3(-t.z, 0, t.x);
    if (right.lengthSq() < 1e-8) right = lastRight ? lastRight.clone() : new THREE.Vector3(1, 0, 0);
    right.normalize();
    lastRight = right;
    const up = new THREE.Vector3().crossVectors(right, t).normalize();

    // Node sizes, eased between the two nodes this station lies between.
    const ct = n === 2 ? u : curve.getUtoTmapping(u);
    const seg = ct * (n - 1);
    const i0 = Math.min(n - 2, Math.floor(seg));
    let sc = THREE.MathUtils.lerp(_nodeScale(nodes[i0]), _nodeScale(nodes[i0 + 1]), _smooth(seg - i0));
    let fade = 1;
    if (tunnel.closedStart && s < taperStart) {
      const q = 1 - s / taperStart;
      sc *= Math.max(CLOSED_TIP, Math.sqrt(Math.max(0, 1 - q * q)));
    } else if (!tunnel.closedStart) {
      fade = Math.min(fade, _smooth(s / fadeStart));
    }
    if (tunnel.closedEnd && length - s < taperEnd) {
      const q = 1 - (length - s) / taperEnd;
      sc *= Math.max(CLOSED_TIP, Math.sqrt(Math.max(0, 1 - q * q)));
    } else if (!tunnel.closedEnd) {
      fade = Math.min(fade, _smooth((length - s) / fadeEnd));
    }

    points.push({ x: p.x, y: p.y, z: p.z, s });
    tangents.push(t); rights.push(right); ups.push(up);
    scales.push(sc); fades.push(fade);
  }
  return { length, points, tangents, rights, ups, scales, fades };
}

// ── Cross-section ────────────────────────────────────────────────────────────

/**
 * Strips of the profile, in (x = right, y = up) metres from the floor centre.
 * Each strip has matching `inner` and `outer` point lists (same count), each
 * point { x, y, nx, ny }. A strip boundary is a hard edge. Walking the strips
 * in order traces the whole loop once, ending where it began. The point COUNT
 * depends only on style and arcSegs, never on the size, so rings of different
 * sizes along one tunnel always line up.
 */
export function tunnelProfile(dims, arcSegs = 16, style = "tunnel") {
  const { hw, wallH, rise, T } = tunnelDims(dims);
  const ho = hw + T, ro = rise + T;
  const floor = {
    floor: true,
    inner: [{ x: -hw, y: 0, nx: 0, ny: 1 }, { x: hw, y: 0, nx: 0, ny: 1 }],
    outer: [{ x: -ho, y: -T, nx: 0, ny: -1 }, { x: ho, y: -T, nx: 0, ny: -1 }],
  };
  const archPts = (from, to) => {
    const inner = [], outer = [];
    for (let i = from; i <= to; i++) {
      const a = (i / arcSegs) * Math.PI;
      const c = Math.cos(a), s = Math.sin(a);
      let nx = c / hw, ny = s / rise, nl = Math.hypot(nx, ny) || 1;
      inner.push({ x: hw * c, y: wallH + rise * s, nx: -nx / nl, ny: -ny / nl });
      nx = c / ho; ny = s / ro; nl = Math.hypot(nx, ny) || 1;
      outer.push({ x: ho * c, y: wallH + ro * s, nx: nx / nl, ny: ny / nl });
    }
    return { inner, outer };
  };

  if (style === "cave") {
    // One smooth shell: right wall (fixed 3 steps) → arch → left wall. The wall
    // steps exist even when wallH is 0 (they collapse onto the arch's foot), so
    // the point count stays fixed while the size changes along the cave.
    const WALL = 3;
    const shell = { inner: [], outer: [] };
    for (let i = 0; i < WALL; i++) {
      const y = (wallH * i) / WALL;
      shell.inner.push({ x: hw, y, nx: -1, ny: 0 });
      shell.outer.push({ x: ho, y: i === 0 ? -T : y, nx: 1, ny: 0 });
    }
    const arch = archPts(0, arcSegs);
    shell.inner.push(...arch.inner); shell.outer.push(...arch.outer);
    for (let i = WALL - 1; i >= 0; i--) {
      const y = (wallH * i) / WALL;
      shell.inner.push({ x: -hw, y, nx: 1, ny: 0 });
      shell.outer.push({ x: -ho, y: i === 0 ? -T : y, nx: -1, ny: 0 });
    }
    return [floor, shell];
  }

  return [
    floor,
    {
      inner: [{ x: hw, y: 0, nx: -1, ny: 0 }, { x: hw, y: wallH, nx: -1, ny: 0 }],
      outer: [{ x: ho, y: -T, nx: 1, ny: 0 }, { x: ho, y: wallH, nx: 1, ny: 0 }],
    },
    archPts(0, arcSegs),
    {
      inner: [{ x: -hw, y: wallH, nx: 1, ny: 0 }, { x: -hw, y: 0, nx: 1, ny: 0 }],
      outer: [{ x: -ho, y: wallH, nx: -1, ny: 0 }, { x: -ho, y: -T, nx: -1, ny: 0 }],
    },
  ];
}

/** Height of the tube's INNER top above the floor at lateral offset `lat` (0 outside the bore). */
export function innerRoofAt(dims, lat) {
  const { hw, wallH, rise } = tunnelDims(dims);
  const q = Math.abs(lat) / hw;
  return q >= 1 ? 0 : wallH + rise * Math.sqrt(1 - q * q);
}

/** Height of the tube's OUTER top above the floor at lateral offset `lat` (≤ hw + T). */
export function outerRoofAt(dims, lat) {
  const { hw, wallH, rise, T } = tunnelDims(dims);
  const ho = hw + T, q = Math.min(1, Math.abs(lat) / ho);
  return wallH + (rise + T) * Math.sqrt(Math.max(0, 1 - q * q));
}

// Smooth 3D value noise in [0, 1].
function _h3(x, y, z) {
  let n = (x * 374761393 + y * 668265263 + z * 1274126177) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}
function _vnoise3(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const fx = x - xi, fy = y - yi, fz = z - zi;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy), uz = fz * fz * (3 - 2 * fz);
  const l = (a, b, t) => a + (b - a) * t;
  return l(
    l(l(_h3(xi, yi, zi), _h3(xi + 1, yi, zi), ux), l(_h3(xi, yi + 1, zi), _h3(xi + 1, yi + 1, zi), ux), uy),
    l(l(_h3(xi, yi, zi + 1), _h3(xi + 1, yi, zi + 1), ux), l(_h3(xi, yi + 1, zi + 1), _h3(xi + 1, yi + 1, zi + 1), ux), uy),
    uz);
}

// ── Entrance cuttings ────────────────────────────────────────────────────────

/**
 * One cutting per dug-in OPEN end. A straight ramp along the mouth's outward
 * (horizontal) direction, from the tube floor up to the ground `length` away,
 * `B` = the tube's outer half-width + 0.4 m either side of it, walls leaning
 * out by `slope` metres per metre of rise until they meet the ground.
 *
 * Returns data (no THREE objects) shared by the mesh and the holes, so both
 * are cut from the same numbers.
 */
export function computeCuttings(sampled, tunnel, heightAt) {
  const cuts = [];
  if (!heightAt || !sampled) return cuts;
  const n = sampled.points.length;
  for (const which of ["start", "end"]) {
    const dig = which === "start"
      ? tunnel.digStart && !tunnel.closedStart
      : tunnel.digEnd && !tunnel.closedEnd;
    if (!dig) continue;
    const k = which === "start" ? 0 : n - 1;
    const P = sampled.points[k], t = sampled.tangents[k];
    const tl = Math.hypot(t.x, t.z) || 1;
    const sgn = which === "start" ? -1 : 1;
    const ex = (sgn * t.x) / tl, ez = (sgn * t.z) / tl;   // out of the tunnel
    const rx = -ez, rz = ex;                                // across the cutting
    const sc = sampled.scales?.[k] ?? 1;
    const dims = { width: tunnel.width * sc, height: tunnel.height * sc, thickness: tunnel.thickness };
    const { hw, T } = tunnelDims(dims);
    const B = hw + T + 0.4;
    const run = Math.max(0, tunnel.cutSlope ?? CUT_DEFAULTS.slope);
    const depth = Math.max(0, heightAt(P.x, P.z) - P.y);
    const L = (tunnel.cutLength ?? 0) > 0 ? tunnel.cutLength : Math.max(12, depth * 5);
    const rampTop = Math.max(P.y, heightAt(P.x + ex * L, P.z + ez * L));
    const steps = Math.max(2, Math.ceil(L));
    const stations = [];
    for (let i = 0; i <= steps; i++) {
      const d = (i / steps) * L;
      const cx = P.x + ex * d, cz = P.z + ez * d;
      const y = P.y + (rampTop - P.y) * (d / L);
      const side = (s) => {
        const g = (l) => heightAt(cx + rx * l * s, cz + rz * l * s);
        const cope = (lat, h) => ({ lat, h, copeLat: lat + CUT_COPE, copeH: Math.max(h, g(lat + CUT_COPE)) + CUT_COPE_LIFT });
        if (run < 1e-3) return cope(B, Math.max(y, g(B)));
        let l = B;
        while (l < B + 80 && g(l) > y + (l - B) / run) l += 0.25;
        // Refine the crossing between the last two march steps.
        let lo = Math.max(B, l - 0.25), hi = l;
        for (let it = 0; it < 8 && hi > lo; it++) {
          const m = (lo + hi) * 0.5;
          if (g(m) > y + (m - B) / run) lo = m; else hi = m;
        }
        return cope(hi, y + (hi - B) / run);
      };
      stations.push({ d, cx, cz, y, left: side(-1), right: side(1) });
    }
    cuts.push({
      which, P: { x: P.x, y: P.y, z: P.z }, ex, ez, rx, rz, B, run, L, steps, stations, dims,
      groundAtPortal: (l) => heightAt(P.x + rx * l, P.z + rz * l),
    });
  }
  return cuts;
}

/** Flat ledge along each wall top, over the ground: it hides the blurred edge of the ground cut. */
const CUT_COPE = 0.8, CUT_COPE_LIFT = 0.08;

function _cutStationAt(cut, a) {
  const f = Math.max(0, Math.min(1, a / cut.L)) * cut.steps;
  return cut.stations[Math.min(cut.steps, Math.round(f))];
}

// ── Mesh ─────────────────────────────────────────────────────────────────────

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
const _e1 = new THREE.Vector3(), _e2 = new THREE.Vector3(), _n = new THREE.Vector3();

/**
 * Sweep the profile along a sampled centreline. Winding is DERIVED per triangle
 * from the analytic normals (never assumed from right × up), so every face
 * shows on the side it should.
 *
 * Cave style: every shell point moves OUTWARD from the section centre by
 * roughness × noise(world position of the undisplaced inner point). Inner and
 * outer move together (wall thickness kept), and two points at the same place
 * — strip corners, the portal ring — get the same push, so nothing cracks.
 * The push is zero at floor level (walkable) and at open mouths (fade), and
 * shrinks with the section so a closed end still closes. Normals are then
 * recomputed from the displaced surface.
 *
 * Attributes: position, normal, uv (metres along, metres around), aFloor (1 on
 * the walking floor), aShade (rock brightness, baked from world-space noise —
 * a per-pixel noise cost 1.7 ms with the tube filling a 4.8 Mpx frame), aEmit
 * (baked interior light, multiplied by the rock colour) and aGlow (emitted
 * light of the lamp fixtures).
 *
 * @param {object} [opts]  { arcSegs = 16, cuts = [] } — cuts from computeCuttings
 */
export function buildTunnelGeometry(sampled, tunnel, opts = {}) {
  if (typeof opts === "number") opts = { arcSegs: opts };
  const arcSegs = opts.arcSegs ?? 16;
  const cuts = opts.cuts ?? [];
  const style = tunnel.style === "cave" ? "cave" : "tunnel";
  const rough = style === "cave" ? Math.max(0, tunnel.roughness ?? CAVE_DEFAULTS.roughness) : 0;
  const P = sampled.points, R = sampled.rights, U = sampled.ups, TG = sampled.tangents;
  const rings = P.length;
  const scales = sampled.scales ?? P.map(() => 1);
  const fades = sampled.fades ?? P.map(() => 1);

  // Per-ring profile (sizes vary along the tunnel; point counts do not).
  const ringDims = scales.map((sc) => ({ width: tunnel.width * sc, height: tunnel.height * sc, thickness: tunnel.thickness }));
  const ringStrips = ringDims.map((d) => tunnelProfile(d, arcSegs, style));
  const stripCount = ringStrips[0].length;

  // Outward push for (ring, strip, point) from the INNER point.
  const pushAt = (k, qi) => {
    if (rough <= 0) return null;
    const dm = tunnelDims(ringDims[k]);
    const cy = dm.height * 0.45;
    const dl = Math.hypot(qi.x, qi.y - cy) || 1;
    const amp = rough * fades[k] * Math.min(1, scales[k]) * _smooth((qi.y - 0.15) / 1.6);
    if (amp <= 0) return null;
    const p = P[k], r = R[k], up = U[k];
    const wx = p.x + r.x * qi.x + up.x * qi.y, wy = p.y + r.y * qi.x + up.y * qi.y, wz = p.z + r.z * qi.x + up.z * qi.y;
    const nz = 0.7 * _vnoise3(wx * 0.28, wy * 0.28, wz * 0.28) + 0.3 * _vnoise3(wx * 0.75 + 31.7, wy * 0.75, wz * 0.75);
    const d = amp * nz;
    return { dx: (qi.x / dl) * d, dy: ((qi.y - cy) / dl) * d };
  };

  const pos = [], nor = [], uv = [], flr = [], shd = [], idx = [];
  const lit = [], glow = [];   // lit: 1 on the bore's inner surface (receives baked light)
  let curLit = 0;
  const addWorld = (wx, wy, wz, nx, ny, nz, u, v, floor) => {
    pos.push(wx, wy, wz);
    nor.push(nx, ny, nz);
    uv.push(u, v);
    flr.push(floor);
    shd.push(0.8 + 0.24 * _vnoise3(wx * 0.18, wy * 0.18, wz * 0.18) + 0.1 * _vnoise3(wx * 0.55 + 17.1, wy * 0.55, wz * 0.55));
    lit.push(curLit);
    glow.push(0, 0, 0);
    return pos.length / 3 - 1;
  };
  const addVert = (k, x, y, nx, ny, u, v, floor) => {
    const p = P[k], r = R[k], up = U[k];
    return addWorld(
      p.x + r.x * x + up.x * y, p.y + r.y * x + up.y * y, p.z + r.z * x + up.z * y,
      r.x * nx + up.x * ny, r.y * nx + up.y * ny, r.z * nx + up.z * ny, u, v, floor);
  };
  const tri = (i0, i1, i2) => {
    _a.fromArray(pos, i0 * 3); _b.fromArray(pos, i1 * 3); _c.fromArray(pos, i2 * 3);
    _e1.subVectors(_b, _a); _e2.subVectors(_c, _a); _n.crossVectors(_e1, _e2);
    const dot = _n.x * (nor[i0 * 3] + nor[i1 * 3] + nor[i2 * 3])
      + _n.y * (nor[i0 * 3 + 1] + nor[i1 * 3 + 1] + nor[i2 * 3 + 1])
      + _n.z * (nor[i0 * 3 + 2] + nor[i1 * 3 + 2] + nor[i2 * 3 + 2]);
    if (dot >= 0) idx.push(i0, i1, i2); else idx.push(i0, i2, i1);
  };

  let vArc = 0;
  for (let si = 0; si < stripCount; si++) {
    for (const side of ["inner", "outer"]) {
      const m = ringStrips[0][si][side].length;
      const floor = ringStrips[0][si].floor && side === "inner" ? 1 : 0;
      curLit = side === "inner" ? 1 : 0;
      const base = pos.length / 3;
      let degenerate = true;
      for (let k = 0; k < rings; k++) {
        const strip = ringStrips[k][si];
        let around = 0;
        for (let j = 0; j < m; j++) {
          const q = strip[side][j];
          if (j > 0) around += Math.hypot(q.x - strip[side][j - 1].x, q.y - strip[side][j - 1].y);
          const push = pushAt(k, strip.inner[j]);
          addVert(k, q.x + (push?.dx ?? 0), q.y + (push?.dy ?? 0), q.nx, q.ny, P[k].s, vArc + around, floor);
        }
        if (around > 1e-4) degenerate = false;
      }
      if (!degenerate) {
        for (let k = 0; k < rings - 1; k++) {
          for (let j = 0; j < m - 1; j++) {
            const a = base + k * m + j, b = a + 1, c = a + m + 1, d = a + m;
            tri(a, b, c); tri(a, c, d);
          }
        }
      }
    }
    vArc += 4;
  }

  curLit = 0;
  // Portal rings (wall thickness between inner and outer) at both ends, and at
  // a CLOSED end a fan over the (tiny) bore, facing back into the tunnel.
  for (const k of [0, rings - 1]) {
    const loopIn = [], loopOut = [];
    for (const strip of ringStrips[k]) {
      for (let j = 0; j < strip.inner.length; j++) {
        if (j === 0 && loopIn.length) continue; // consecutive strips share an end point
        const push = pushAt(k, strip.inner[j]);
        const dx = push?.dx ?? 0, dy = push?.dy ?? 0;
        loopIn.push({ x: strip.inner[j].x + dx, y: strip.inner[j].y + dy });
        loopOut.push({ x: strip.outer[j].x + dx, y: strip.outer[j].y + dy });
      }
    }
    const t = TG[k], out = k === 0 ? -1 : 1;
    const setN = (vi, sgn) => { nor[vi * 3] = t.x * sgn; nor[vi * 3 + 1] = t.y * sgn; nor[vi * 3 + 2] = t.z * sgn; };
    const count = loopIn.length;
    const closed = k === 0 ? tunnel.closedStart : tunnel.closedEnd;
    if (!closed) {
      const base = pos.length / 3;
      for (let j = 0; j < count; j++) {
        setN(addVert(k, loopIn[j].x, loopIn[j].y, 0, 0, loopIn[j].x, loopIn[j].y, 0), out);
        setN(addVert(k, loopOut[j].x, loopOut[j].y, 0, 0, loopOut[j].x, loopOut[j].y, 0), out);
      }
      for (let j = 0; j < count - 1; j++) {
        const i0 = base + j * 2, o0 = i0 + 1, i1 = base + (j + 1) * 2, o1 = i1 + 1;
        tri(i0, i1, o1); tri(i0, o1, o0);
      }
    } else {
      // Two lids instead of a ring: the bore's (facing back in) and the outer
      // shell's (facing out) — two nested closed surfaces, no three-way edges.
      const fan = (loop, sgn) => {
        let cx = 0, cy = 0;
        for (const q of loop) { cx += q.x; cy += q.y; }
        const fanBase = pos.length / 3;
        for (let j = 0; j < count; j++) setN(addVert(k, loop[j].x, loop[j].y, 0, 0, 0, 0, 0), sgn);
        const c = addVert(k, cx / count, cy / count, 0, 0, 0, 0, 0);
        setN(c, sgn);
        for (let j = 0; j < count - 1; j++) tri(c, fanBase + j, fanBase + j + 1);
      };
      curLit = 1;
      fan(loopIn, -out);
      curLit = 0;
      fan(loopOut, out);
    }
  }

  // ── Entrance cuttings ──────────────────────────────────────────────────────
  const OVER = 0.3;   // walls and headwall stand this far proud of the ground, hiding the 0.5 m splat edge
  for (const cut of cuts) {
    const { stations, rx, rz, ex, ez, B, run } = cut;
    const W = (st, lat) => [st.cx + rx * lat, st.cz + rz * lat];
    // Ramp floor.
    const fBase = pos.length / 3;
    for (const st of stations) {
      const [ax, az] = W(st, -B), [bx, bz] = W(st, B);
      addWorld(ax, st.y, az, 0, 1, 0, st.d, 0, 1);
      addWorld(bx, st.y, bz, 0, 1, 0, st.d, 2 * B, 1);
    }
    for (let i = 0; i < stations.length - 1; i++) {
      const a = fBase + i * 2;
      tri(a, a + 1, a + 3); tri(a, a + 3, a + 2);
    }
    // Side walls: bottom edge on the ramp, top edge at the ground — then a flat
    // ledge running out over the ground. The ground is opened a little way under
    // that ledge, so the blurred 0.5 m edge of the cut never shows in front of
    // the wall.
    for (const s of [-1, 1]) {
      const wBase = pos.length / 3, cBase = wBase + stations.length * 2;
      const copeVerts = [];
      for (const st of stations) {
        const top = s < 0 ? st.left : st.right;
        const rise = Math.max(0, top.h - st.y), outRun = top.lat - B;
        // Inward normal of a wall leaning out: (-rise across, +outRun up), normalised.
        const nl = Math.hypot(rise, outRun) || 1;
        const nAcross = (-rise / nl) * s, nUp = rise > 1e-4 ? outRun / nl : 1;
        const [bx, bz] = W(st, s * B), [tx, tz] = W(st, s * top.lat), [cx, cz] = W(st, s * top.copeLat);
        addWorld(bx, st.y, bz, rx * nAcross, nUp, rz * nAcross, st.d, 0, 0);
        addWorld(tx, top.h + CUT_COPE_LIFT, tz, rx * nAcross, nUp, rz * nAcross, st.d, rise, 0);
        copeVerts.push([tx, top.h + CUT_COPE_LIFT, tz, cx, top.copeH, cz, st.d]);
      }
      for (const [tx, ty, tz, cx, cy, cz, d] of copeVerts) {
        addWorld(tx, ty, tz, 0, 1, 0, d, 0, 0);
        addWorld(cx, cy, cz, 0, 1, 0, d, CUT_COPE, 0);
      }
      for (let i = 0; i < stations.length - 1; i++) {
        const a = wBase + i * 2, c = cBase + i * 2;
        tri(a, a + 1, a + 3); tri(a, a + 3, a + 2);
        tri(c, c + 1, c + 3); tri(c, c + 3, c + 2);
      }
    }
    // Headwall: a slab across the portal, from the tube's outer top (or the
    // ramp floor beside it) up past the ground, 0.8 m thick.
    const st0 = stations[0], ho = cut.dims.width * 0.5 + cut.dims.thickness;
    const lats = new Set();
    const lMin = -st0.left.copeLat, lMax = st0.right.copeLat;
    for (let l = lMin; l < lMax; l += 0.5) lats.add(+l.toFixed(3));
    for (const l of [lMin, lMax, -ho, ho, -B, B, 0, -st0.left.lat, st0.right.lat]) if (l >= lMin && l <= lMax) lats.add(+l.toFixed(3));
    const L = [...lats].sort((a, b) => a - b);
    const bottomAt = (l) => {
      const al = Math.abs(l);
      if (al < ho) return st0.y + outerRoofAt(cut.dims, l);
      const wallTop = l < 0 ? st0.left.lat : st0.right.lat;
      if (al > wallTop) return _cutGround(cut, l) - 0.3;   // under the ledge
      if (al <= B || run < 1e-3) return st0.y;
      return st0.y + (al - B) / run;
    };
    const TH = 0.8, P0 = cut.P;
    const px = (l, back) => P0.x + rx * l - ex * back, pz = (l, back) => P0.z + rz * l - ez * back;
    const topAt = (l) => Math.max(bottomAt(l), _cutGround(cut, l) + OVER);
    // front face (+e), back face (-e), top (+y)
    for (const [back, nx, nz] of [[0, ex, ez], [TH, -ex, -ez]]) {
      const base = pos.length / 3;
      for (const l of L) {
        addWorld(px(l, back), bottomAt(l), pz(l, back), nx, 0, nz, l, 0, 0);
        addWorld(px(l, back), topAt(l), pz(l, back), nx, 0, nz, l, 1, 0);
      }
      for (let i = 0; i < L.length - 1; i++) {
        const a = base + i * 2;
        tri(a, a + 1, a + 3); tri(a, a + 3, a + 2);
      }
    }
    const tBase = pos.length / 3;
    for (const l of L) {
      addWorld(px(l, 0), topAt(l), pz(l, 0), 0, 1, 0, l, 0, 0);
      addWorld(px(l, TH), topAt(l), pz(l, TH), 0, 1, 0, l, TH, 0);
    }
    for (let i = 0; i < L.length - 1; i++) {
      const a = tBase + i * 2;
      tri(a, a + 1, a + 3); tri(a, a + 3, a + 2);
    }
  }

  // ── Lamp fixtures ──────────────────────────────────────────────────────────
  const lampsOn = tunnel.lamps === true;
  const spacing = Math.max(4, tunnel.lampSpacing ?? LIGHT_DEFAULTS.lampSpacing);
  const lampCol = _hexRgb(tunnel.lampColor ?? LIGHT_DEFAULTS.lampColor);
  const lampI = Math.max(0, tunnel.lampIntensity ?? LIGHT_DEFAULTS.lampIntensity);
  const lamps = [];
  const total = sampled.length;
  if (lampsOn && lampI > 0) {
    for (let s = spacing * 0.5; s < total - 1.5; s += spacing) {
      if (s < 1.5) continue;
      const k = Math.min(rings - 1, Math.round((s / total) * (rings - 1)));
      const dm = tunnelDims(ringDims[k]);
      const drop = Math.min(0.6, dm.height * 0.08);
      const p = P[k], up = U[k], r = R[k], t = TG[k];
      const lx = p.x + up.x * (dm.height - drop), ly = p.y + up.y * (dm.height - drop), lz = p.z + up.z * (dm.height - drop);
      lamps.push({ s, x: lx, y: ly - 0.25, z: lz, k });
      // A small glowing panel facing down.
      const hwL = 0.55, hlL = 0.14, base = pos.length / 3;
      for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const vi = addWorld(
          lx + r.x * a * hwL + t.x * b * hlL, ly + r.y * a * hwL + t.y * b * hlL - 0.02, lz + r.z * a * hwL + t.z * b * hlL,
          -up.x, -up.y, -up.z, 0, 0, 0);
        glow[vi * 3] = lampCol[0] * 3 * lampI; glow[vi * 3 + 1] = lampCol[1] * 3 * lampI; glow[vi * 3 + 2] = lampCol[2] * 3 * lampI;
      }
      tri(base, base + 1, base + 2); tri(base, base + 2, base + 3);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute("aFloor", new THREE.Float32BufferAttribute(flr, 1));
  g.setAttribute("aShade", new THREE.Float32BufferAttribute(shd, 1));
  g.setIndex(idx);
  // Displaced (or domed) surfaces light from their real shape. The duplicated
  // vertices at strip and cap boundaries keep those edges crisp.
  if (rough > 0 || tunnel.closedStart || tunnel.closedEnd) g.computeVertexNormals();

  // ── Baked interior light ───────────────────────────────────────────────────
  // Per inner-surface vertex: lamp pools (inverse-square-ish falloff, facing
  // term) plus sky light leaking in from each OPEN mouth, fading with distance.
  const emit = new Float32Array(pos.length);
  const day = Math.max(0, tunnel.daylight ?? LIGHT_DEFAULTS.daylight);
  const openStart = !tunnel.closedStart, openEnd = !tunnel.closedEnd;
  const N = g.getAttribute("normal");
  const reach = Math.max(3, Math.max(tunnel.width ?? 8, tunnel.height ?? 7) * 0.75);
  const cutoff = Math.max(10, spacing * 1.3);
  for (let i = 0, n = pos.length / 3; i < n; i++) {
    if (!lit[i]) continue;
    const s = uv[i * 2];
    const vx = pos[i * 3], vy = pos[i * 3 + 1], vz = pos[i * 3 + 2];
    const nx = N.getX(i), ny = N.getY(i), nz = N.getZ(i);
    let r = 0, gC = 0, b = 0;
    if (lamps.length) {
      const j0 = Math.max(0, Math.floor((s - cutoff) / spacing)), j1 = Math.min(lamps.length - 1, Math.ceil((s + cutoff) / spacing));
      for (let j = j0; j <= j1; j++) {
        const L = lamps[j];
        const dx = L.x - vx, dy = L.y - vy, dz = L.z - vz;
        const d = Math.hypot(dx, dy, dz);
        if (d > cutoff) continue;
        const facing = Math.max(0.2, (dx * nx + dy * ny + dz * nz) / (d || 1));
        const w = lampI * facing / (1 + (d / reach) * (d / reach)) * (1 - _smooth((d - cutoff * 0.6) / (cutoff * 0.4)));
        r += lampCol[0] * w; gC += lampCol[1] * w; b += lampCol[2] * w;
      }
    }
    if (day > 0) {
      const dist = Math.min(openStart ? s : Infinity, openEnd ? total - s : Infinity);
      if (Number.isFinite(dist)) {
        const w = day * Math.exp(-dist / 9);
        r += SKY_LIGHT[0] * w; gC += SKY_LIGHT[1] * w; b += SKY_LIGHT[2] * w;
      }
    }
    emit[i * 3] = r; emit[i * 3 + 1] = gC; emit[i * 3 + 2] = b;
  }
  g.setAttribute("aEmit", new THREE.BufferAttribute(emit, 3));
  g.setAttribute("aGlow", new THREE.Float32BufferAttribute(glow, 3));
  g.userData.lampCount = lamps.length;
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

function _hexRgb(hex) {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
}

/** Ground height along the portal plane (sampled when the cutting was computed). */
function _cutGround(cut, l) {
  return cut.groundAtPortal ? cut.groundAtPortal(l) : cut.stations[0].y;
}

// ── Terrain holes ────────────────────────────────────────────────────────────

/**
 * Mark (255) every splat texel whose GROUND passes through the tube: within the
 * footprint (lateral ≤ local half-width + half the wall), strictly between the
 * two portal planes, and with the ground height between the floor and the top
 * of the cut. Ground above is the mountain over a buried tunnel and stays;
 * ground below the floor is under a raised tube and stays too.
 *
 * `out` is written with max(), so several tunnels share one buffer.
 *
 * @param {object} sampled   sampleTunnel() result
 * @param {object} tunnel    { width, height, thickness, style?, roughness? }
 * @param {(wx:number, wz:number) => number} heightAt   ground height, metres
 * @param {Uint8Array} out   res² bytes
 * @returns {number} texels marked
 */
export function rasterizeTunnelHoles(sampled, tunnel, heightAt, out, res, worldSize, opts = {}) {
  const vMargin = opts.vMargin ?? 0.6;
  const endInset = opts.endInset ?? 0.3;
  const topOverlap = opts.topOverlap ?? 0.4;
  const topInside = opts.topInside ?? 0.25;
  const rough = tunnel.style === "cave" ? Math.max(0, tunnel.roughness ?? CAVE_DEFAULTS.roughness) : 0;
  const T = Math.max(0.1, tunnel.thickness);
  const texel = worldSize / res, half = worldSize * 0.5;
  const P = sampled.points, n = P.length;
  const SC = sampled.scales ?? P.map(() => 1), FD = sampled.fades ?? P.map(() => 1);
  let marked = 0;
  // Portal planes: the ground in front of a mouth is outside the tunnel even
  // where it is near a centreline joint. Horizontal tangents at the two ends.
  const t0 = sampled.tangents[0], t1 = sampled.tangents[n - 1];
  const l0 = Math.hypot(t0.x, t0.z) || 1, l1 = Math.hypot(t1.x, t1.z) || 1;
  const e0x = t0.x / l0, e0z = t0.z / l0, e1x = t1.x / l1, e1z = t1.z / l1;
  const A = P[0], B = P[n - 1];

  for (let i = 0; i < n - 1; i++) {
    const a = P[i], b = P[i + 1];
    const pad = Math.max(0.5, tunnel.width * 0.5 * Math.max(SC[i], SC[i + 1])) + T + texel;
    const x0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - pad + half) / texel));
    const x1 = Math.min(res - 1, Math.ceil((Math.max(a.x, b.x) + pad + half) / texel));
    const z0 = Math.max(0, Math.floor((Math.min(a.z, b.z) - pad + half) / texel));
    const z1 = Math.min(res - 1, Math.ceil((Math.max(a.z, b.z) + pad + half) / texel));
    const dx = b.x - a.x, dz = b.z - a.z;
    const lenSq = dx * dx + dz * dz;

    for (let pz = z0; pz <= z1; pz++) {
      const wz = (pz + 0.5) * texel - half;
      for (let px = x0; px <= x1; px++) {
        const o = pz * res + px;
        if (out[o] === 255) continue;
        const wx = (px + 0.5) * texel - half;
        if ((wx - A.x) * e0x + (wz - A.z) * e0z < endInset) continue;
        if ((wx - B.x) * e1x + (wz - B.z) * e1z > -endInset) continue;
        let t = lenSq > 1e-10 ? ((wx - a.x) * dx + (wz - a.z) * dz) / lenSq : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const sc = SC[i] + (SC[i + 1] - SC[i]) * t;
        const hw = Math.max(0.5, tunnel.width * 0.5 * sc);
        const lat = Math.hypot(wx - (a.x + dx * t), wz - (a.z + dz * t));
        if (lat > hw + T * 0.5) continue;
        const dims = { width: tunnel.width * sc, height: tunnel.height * sc, thickness: T };
        const fade = FD[i] + (FD[i + 1] - FD[i]) * t;
        const floorY = a.y + (b.y - a.y) * t;
        const H = heightAt(wx, wz);
        // Top of the cut: just INSIDE the shell, so the ground overlaps the rock
        // instead of leaving a slit of sky above it (the 0.5 m splat texel
        // blurs the edge on a slope) — but never below the bore's roof, which a
        // cave's rough shell can push up by as much as its roughness.
        const top = Math.max(innerRoofAt(dims, lat) + topInside + rough * fade, outerRoofAt(dims, lat) - topOverlap);
        if (H >= floorY - vMargin && H <= floorY + top) {
          out[o] = 255;
          marked++;
        }
      }
    }
  }

  // Cuttings: everything between the walls, from just behind the portal plane
  // (under the headwall slab) to the top of the ramp, where the ground stands
  // above the ramp floor.
  for (const cut of opts.cuts ?? []) {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const st of cut.stations) {
      const w = Math.max(st.left.lat, st.right.lat) + 1;
      minX = Math.min(minX, st.cx - w); maxX = Math.max(maxX, st.cx + w);
      minZ = Math.min(minZ, st.cz - w); maxZ = Math.max(maxZ, st.cz + w);
    }
    const x0 = Math.max(0, Math.floor((minX + half) / texel)), x1 = Math.min(res - 1, Math.ceil((maxX + half) / texel));
    const z0 = Math.max(0, Math.floor((minZ + half) / texel)), z1 = Math.min(res - 1, Math.ceil((maxZ + half) / texel));
    for (let pz = z0; pz <= z1; pz++) {
      const wz = (pz + 0.5) * texel - half;
      for (let px = x0; px <= x1; px++) {
        const o = pz * res + px;
        if (out[o] === 255) continue;
        const wx = (px + 0.5) * texel - half;
        const a = (wx - cut.P.x) * cut.ex + (wz - cut.P.z) * cut.ez;
        if (a < -0.4 || a > cut.L) continue;
        const lat = (wx - cut.P.x) * cut.rx + (wz - cut.P.z) * cut.rz;
        const st = _cutStationAt(cut, a);
        // Up to part-way under the wall-top ledge (see the mesh).
        if (lat > st.right.lat + CUT_COPE * 0.7 || -lat > st.left.lat + CUT_COPE * 0.7) continue;
        if (heightAt(wx, wz) > st.y - vMargin) { out[o] = 255; marked++; }
      }
    }
  }
  return marked;
}
