/**
 * v3/tools/tunnelPath.js — the maths behind the Tunnel tool, with no render
 * objects, so it runs headlessly in tools/tunnelPathTest.mjs.
 *
 * A tunnel is a list of nodes { x, z, y, pinned } plus a cross-section
 * { width, height, thickness }. Node y is the FLOOR height (what you walk on).
 *
 *   resolveNodeHeights  — the two end nodes always use their own y; a middle
 *                         node uses its y only when pinned, otherwise it sits on
 *                         a straight grade between its neighbouring anchors.
 *                         So clicking a mouth, then over a mountain, then the
 *                         far mouth gives a tunnel THROUGH the mountain, not one
 *                         that climbs to the click on its summit.
 *   sampleTunnel        — centripetal Catmull-Rom through the resolved nodes,
 *                         ~1 m stations, each with a frame whose RIGHT axis is
 *                         horizontal, so the floor never rolls sideways.
 *   tunnelProfile       — horseshoe: flat floor, straight walls, elliptical
 *                         arch. Inner surface (seen from inside) and an outer
 *                         surface `thickness` further out, point for point.
 *   buildTunnelGeometry — sweeps both surfaces and caps the two portal rings.
 *   rasterizeTunnelHoles— which splat texels the terrain must be cut at: where
 *                         the ground passes THROUGH the tube's cross-section.
 */
import * as THREE from "three";

export const TUNNEL_DEFAULTS = Object.freeze({ width: 8, height: 7, thickness: 1 });
/** Floor sits this far above a mouth's ground, so ground and floor never z-fight. */
export const FLOOR_LIFT = 0.05;

export function tunnelDims({ width, height, thickness }) {
  const hw = Math.max(0.5, width * 0.5);
  const h = Math.max(hw, height);        // at least a half-circle
  const wallH = h - hw;
  const rise = h - wallH;                 // = hw unless the arch is squashed
  const T = Math.max(0.1, thickness);
  return { hw, height: h, wallH, rise, T };
}

// ── Heights ──────────────────────────────────────────────────────────────────

export function resolveNodeHeights(nodes) {
  const n = nodes.length;
  const ys = new Array(n);
  if (n === 0) return ys;
  const dist = new Array(n);
  dist[0] = 0;
  for (let i = 1; i < n; i++) {
    dist[i] = dist[i - 1] + Math.hypot(nodes[i].x - nodes[i - 1].x, nodes[i].z - nodes[i - 1].z);
  }
  const isAnchor = (i) => i === 0 || i === n - 1 || nodes[i].pinned === true;
  let prev = 0;
  for (let i = 0; i < n; i++) {
    if (isAnchor(i)) { ys[i] = nodes[i].y; prev = i; continue; }
    let next = i + 1;
    while (!isAnchor(next)) next++;
    const span = dist[next] - dist[prev];
    const t = span > 1e-6 ? (dist[i] - dist[prev]) / span : 0;
    ys[i] = nodes[prev].y + (nodes[next].y - nodes[prev].y) * t;
  }
  return ys;
}

// ── Centreline ───────────────────────────────────────────────────────────────

/**
 * @returns {null | { length:number, points:{x,y,z,s}[], tangents:THREE.Vector3[],
 *   rights:THREE.Vector3[], ups:THREE.Vector3[] }}
 */
export function sampleTunnel(tunnel, step = 1, maxStations = 4000) {
  const nodes = tunnel.nodes;
  if (!nodes || nodes.length < 2) return null;
  const ys = resolveNodeHeights(nodes);
  const pts = nodes.map((nd, i) => new THREE.Vector3(nd.x, ys[i] + FLOOR_LIFT, nd.z));
  const curve = pts.length === 2
    ? new THREE.LineCurve3(pts[0], pts[1])
    : new THREE.CatmullRomCurve3(pts, false, "centripetal");
  const length = curve.getLength();
  if (!(length > 0.5)) return null;
  const count = Math.max(2, Math.min(maxStations, Math.ceil(length / step)));

  const points = [], tangents = [], rights = [], ups = [];
  let lastRight = null;
  for (let k = 0; k <= count; k++) {
    const u = k / count;
    const p = curve.getPointAt(u);
    const t = curve.getTangentAt(u).normalize();
    // Horizontal right axis (t × worldUp), so the floor stays level across.
    let right = new THREE.Vector3(-t.z, 0, t.x);
    if (right.lengthSq() < 1e-8) right = lastRight ? lastRight.clone() : new THREE.Vector3(1, 0, 0);
    right.normalize();
    lastRight = right;
    const up = new THREE.Vector3().crossVectors(right, t).normalize();
    points.push({ x: p.x, y: p.y, z: p.z, s: u * length });
    tangents.push(t); rights.push(right); ups.push(up);
  }
  return { length, points, tangents, rights, ups };
}

// ── Cross-section ────────────────────────────────────────────────────────────

/**
 * Strips of the profile, in (x = right, y = up) metres from the floor centre.
 * Each strip has matching `inner` and `outer` point lists (same count), each
 * point { x, y, nx, ny } with its own normal, so corners stay sharp (a strip
 * boundary is a hard edge) while the arch stays smooth.
 * Walking the strips in order traces the whole loop once, ending where it began.
 */
export function tunnelProfile(dims, arcSegs = 16) {
  const { hw, wallH, rise, T } = tunnelDims(dims);
  const ho = hw + T, ro = rise + T;
  const strips = [];
  // Floor (inner, faces up) / underside (outer, faces down). Left → right.
  strips.push({
    floor: true,
    inner: [{ x: -hw, y: 0, nx: 0, ny: 1 }, { x: hw, y: 0, nx: 0, ny: 1 }],
    outer: [{ x: -ho, y: -T, nx: 0, ny: -1 }, { x: ho, y: -T, nx: 0, ny: -1 }],
  });
  // Right wall, up.
  strips.push({
    inner: [{ x: hw, y: 0, nx: -1, ny: 0 }, { x: hw, y: wallH, nx: -1, ny: 0 }],
    outer: [{ x: ho, y: -T, nx: 1, ny: 0 }, { x: ho, y: wallH, nx: 1, ny: 0 }],
  });
  // Arch, right → left over the top.
  const arch = { inner: [], outer: [] };
  for (let i = 0; i <= arcSegs; i++) {
    const a = (i / arcSegs) * Math.PI;
    const c = Math.cos(a), s = Math.sin(a);
    // Ellipse normal ∝ (cos/rx, sin/ry).
    let nx = c / hw, ny = s / rise;
    let nl = Math.hypot(nx, ny) || 1;
    arch.inner.push({ x: hw * c, y: wallH + rise * s, nx: -nx / nl, ny: -ny / nl });
    nx = c / ho; ny = s / ro; nl = Math.hypot(nx, ny) || 1;
    arch.outer.push({ x: ho * c, y: wallH + ro * s, nx: nx / nl, ny: ny / nl });
  }
  strips.push(arch);
  // Left wall, down.
  strips.push({
    inner: [{ x: -hw, y: wallH, nx: 1, ny: 0 }, { x: -hw, y: 0, nx: 1, ny: 0 }],
    outer: [{ x: -ho, y: wallH, nx: -1, ny: 0 }, { x: -ho, y: -T, nx: -1, ny: 0 }],
  });
  return strips;
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

// ── Mesh ─────────────────────────────────────────────────────────────────────

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
const _e1 = new THREE.Vector3(), _e2 = new THREE.Vector3(), _n = new THREE.Vector3();

/**
 * Sweep the profile along a sampled centreline. Winding is DERIVED per triangle
 * from the vertex normals (never assumed from right × up), so every face shows
 * on the side its normal points at.
 *
 * Attributes: position, normal, uv (metres along, metres around), aFloor (1 on
 * the walking floor), aShade (rock brightness, baked from world-space noise —
 * a per-pixel noise cost 1.7 ms with the tube filling a 4.8 Mpx frame).
 */
export function buildTunnelGeometry(sampled, dims, arcSegs = 16) {
  const strips = tunnelProfile(dims, arcSegs);
  const pos = [], nor = [], uv = [], flr = [], shd = [], idx = [];
  const P = sampled.points, R = sampled.rights, U = sampled.ups, TG = sampled.tangents;
  const rings = P.length;

  const addVert = (k, x, y, nx, ny, u, v, floor) => {
    const p = P[k], r = R[k], up = U[k];
    pos.push(p.x + r.x * x + up.x * y, p.y + r.y * x + up.y * y, p.z + r.z * x + up.z * y);
    nor.push(r.x * nx + up.x * ny, r.y * nx + up.y * ny, r.z * nx + up.z * ny);
    uv.push(u, v);
    flr.push(floor);
    const wx = pos[pos.length - 3], wy = pos[pos.length - 2], wz = pos[pos.length - 1];
    shd.push(0.8 + 0.24 * _vnoise3(wx * 0.18, wy * 0.18, wz * 0.18) + 0.1 * _vnoise3(wx * 0.55 + 17.1, wy * 0.55, wz * 0.55));
    return pos.length / 3 - 1;
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
  for (const strip of strips) {
    for (const side of ["inner", "outer"]) {
      const prof = strip[side];
      const m = prof.length;
      const around = [0];
      for (let j = 1; j < m; j++) around.push(around[j - 1] + Math.hypot(prof[j].x - prof[j - 1].x, prof[j].y - prof[j - 1].y));
      const floor = strip.floor && side === "inner" ? 1 : 0;
      const base = pos.length / 3;
      for (let k = 0; k < rings; k++) {
        for (let j = 0; j < m; j++) {
          const q = prof[j];
          addVert(k, q.x, q.y, q.nx, q.ny, P[k].s, vArc + around[j], floor);
        }
      }
      if (around[m - 1] > 1e-4) {
        for (let k = 0; k < rings - 1; k++) {
          for (let j = 0; j < m - 1; j++) {
            const a = base + k * m + j, b = a + 1, c = a + m + 1, d = a + m;
            tri(a, b, c); tri(a, c, d);
          }
        }
      }
    }
    vArc += strip.inner.length;
  }

  // Portal rings: the wall thickness between inner and outer, at both ends.
  const loopIn = [], loopOut = [];
  for (const strip of strips) {
    for (let j = 0; j < strip.inner.length; j++) {
      // Consecutive strips share their end point; skip the duplicate.
      if (j === 0 && loopIn.length) continue;
      loopIn.push(strip.inner[j]); loopOut.push(strip.outer[j]);
    }
  }
  for (const k of [0, rings - 1]) {
    const t = TG[k], sgn = k === 0 ? -1 : 1;
    // Cap normal is along ±tangent; express it in the (right, up) frame is not
    // possible, so write it straight into the normal array after addVert.
    const count = loopIn.length;
    const base = pos.length / 3;
    for (let j = 0; j < count; j++) {
      for (const q of [loopIn[j], loopOut[j]]) {
        const vi = addVert(k, q.x, q.y, 0, 0, q.x, q.y, 0);
        nor[vi * 3] = t.x * sgn; nor[vi * 3 + 1] = t.y * sgn; nor[vi * 3 + 2] = t.z * sgn;
      }
    }
    for (let j = 0; j < count - 1; j++) {
      const i0 = base + j * 2, o0 = i0 + 1, i1 = base + (j + 1) * 2, o1 = i1 + 1;
      tri(i0, i1, o1); tri(i0, o1, o0);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute("aFloor", new THREE.Float32BufferAttribute(flr, 1));
  g.setAttribute("aShade", new THREE.Float32BufferAttribute(shd, 1));
  g.setIndex(idx);
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

// ── Terrain holes ────────────────────────────────────────────────────────────

/**
 * Mark (255) every splat texel whose GROUND passes through the tube: within the
 * footprint (lateral ≤ inner half-width + half the wall), strictly between the
 * two portals, and with the ground height between the floor and the tube's
 * outer top. Ground above the top is the mountain over a buried tunnel and is
 * left alone; ground below the floor is under a raised tube and stays too.
 *
 * `out` is written with max(), so several tunnels share one buffer.
 *
 * @param {object} sampled   sampleTunnel() result
 * @param {object} dims      { width, height, thickness }
 * @param {(wx:number, wz:number) => number} heightAt   ground height, metres
 * @param {Uint8Array} out   res² bytes
 * @returns {number} texels marked
 */
export function rasterizeTunnelHoles(sampled, dims, heightAt, out, res, worldSize, opts = {}) {
  const vMargin = opts.vMargin ?? 0.6;
  const endInset = opts.endInset ?? 0.3;
  const topOverlap = opts.topOverlap ?? 0.4;
  const topInside = opts.topInside ?? 0.25;
  const { hw, T } = tunnelDims(dims);
  const latMax = hw + T * 0.5;
  const texel = worldSize / res, half = worldSize * 0.5;
  const P = sampled.points, n = P.length;
  let marked = 0;
  // Portal planes: the ground in front of a mouth is outside the tunnel even
  // where it is near a centreline joint. Horizontal tangents at the two ends.
  const t0 = sampled.tangents[0], t1 = sampled.tangents[n - 1];
  const l0 = Math.hypot(t0.x, t0.z) || 1, l1 = Math.hypot(t1.x, t1.z) || 1;
  const e0x = t0.x / l0, e0z = t0.z / l0, e1x = t1.x / l1, e1z = t1.z / l1;
  const A = P[0], B = P[n - 1];

  for (let i = 0; i < n - 1; i++) {
    const a = P[i], b = P[i + 1];
    const pad = latMax + texel;
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
        let t = lenSq > 1e-10 ? ((wx - a.x) * dx + (wz - a.z) * dz) / lenSq : 0;
        // Past either portal is outside the tunnel, not "the nearest end of it".
        if ((wx - A.x) * e0x + (wz - A.z) * e0z < endInset) continue;
        if ((wx - B.x) * e1x + (wz - B.z) * e1z > -endInset) continue;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const lat = Math.hypot(wx - (a.x + dx * t), wz - (a.z + dz * t));
        if (lat > latMax) continue;
        const floorY = a.y + (b.y - a.y) * t;
        const H = heightAt(wx, wz);
        // Top of the cut: just INSIDE the shell, so the ground overlaps the rock
        // instead of leaving a slit of sky above it (the 0.5 m splat texel
        // blurs the edge on a slope) — but never below the bore's own roof.
        const top = Math.max(innerRoofAt(dims, lat) + topInside, outerRoofAt(dims, lat) - topOverlap);
        if (H >= floorY - vMargin && H <= floorY + top) {
          out[o] = 255;
          marked++;
        }
      }
    }
  }
  return marked;
}
