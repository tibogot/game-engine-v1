// Plain 2D math for the lane-based road engine. No three.js — the engine runs
// in node tests, the 2D lab and (later) the 3D builder from the same source.
//
// CONVENTIONS (every file in v3/roads/ follows them):
//   - Plan coordinates are world (x, z) in metres. Seen from above with +X to
//     the right, +Z points DOWN the screen — that is the real top view of a
//     Y-up world, not a mirror image.
//   - A heading θ points along (cos θ, sin θ). θ INCREASING turns RIGHT.
//   - The lateral normal n(θ) = (sin θ, −cos θ) points to the driver's LEFT.
//     A lateral offset t > 0 is left of the reference line, t < 0 is right.
//   - Curvature k = dθ/ds, so k > 0 is a right-hand bend.
//   - Right-hand traffic: a road's RIGHT lanes run forward (a → b).

export const TAU = Math.PI * 2;

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;

export function smooth01(t) {
  t = clamp(t, 0, 1);
  return t * t * (3 - 2 * t);
}

/** Wrap an angle to (−π, π]. */
export function wrapPi(a) {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

/** Wrap an angle to [0, 2π). */
export function wrap2Pi(a) {
  a %= TAU;
  return a < 0 ? a + TAU : a;
}

export const headingOf = (dx, dz) => Math.atan2(dz, dx);
export const dist = (ax, az, bx, bz) => Math.hypot(bx - ax, bz - az);

/** Point at station σ along heading θ from (x, z), shifted t to the left. */
export function frameOffset(x, z, th, sigma, t) {
  const c = Math.cos(th), s = Math.sin(th);
  return [x + c * sigma + s * t, z + s * sigma - c * t];
}

/** Intersection of two infinite lines p + d·u and q + e·v → { u, v } or null. */
export function lineIntersect(px, pz, dx, dz, qx, qz, ex, ez) {
  const den = dx * ez - dz * ex;
  if (Math.abs(den) < 1e-9) return null;
  const wx = qx - px, wz = qz - pz;
  return { u: (wx * ez - wz * ex) / den, v: (wx * dz - wz * dx) / den };
}

/** Segment AB × segment CD → { t, u, x, z } (t on AB, u on CD) or null. */
export function segIntersect(ax, az, bx, bz, cx, cz, dx, dz) {
  const rx = bx - ax, rz = bz - az, sx = dx - cx, sz = dz - cz;
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-12) return null;
  const qx = cx - ax, qz = cz - az;
  const t = (qx * sz - qz * sx) / den;
  const u = (qx * rz - qz * rx) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { t, u, x: ax + rx * t, z: az + rz * t };
}

/** Squared distance from P to segment AB, and the parameter of the foot. */
export function pointSegDist2(px, pz, ax, az, bx, bz) {
  const abx = bx - ax, abz = bz - az;
  const l2 = abx * abx + abz * abz;
  let t = l2 > 0 ? ((px - ax) * abx + (pz - az) * abz) / l2 : 0;
  t = clamp(t, 0, 1);
  const fx = ax + abx * t - px, fz = az + abz * t - pz;
  return { d2: fx * fx + fz * fz, t };
}

/** Signed shoelace area. Bounded road faces come out POSITIVE (see roadBlocks.js). */
export function polygonArea(pts) {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

export function polygonCentroid(pts) {
  let a = 0, cx = 0, cz = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    const c = p[0] * q[1] - q[0] * p[1];
    a += c;
    cx += (p[0] + q[0]) * c;
    cz += (p[1] + q[1]) * c;
  }
  if (Math.abs(a) < 1e-9) {
    let sx = 0, sz = 0;
    for (const p of pts) { sx += p[0]; sz += p[1]; }
    return [sx / pts.length, sz / pts.length];
  }
  return [cx / (3 * a), cz / (3 * a)];
}

export function pointInPolygon(x, z, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0], zi = pts[i][1], xj = pts[j][0], zj = pts[j][1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

export function polylineLength(pts) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += dist(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
  return L;
}

export function cumulative(pts) {
  const cum = new Float64Array(pts.length);
  for (let i = 1; i < pts.length; i++) {
    cum[i] = cum[i - 1] + dist(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
  }
  return cum;
}

/** Point + heading at arc distance d along a polyline with a cumulative table. */
export function polylineAt(pts, cum, d) {
  const n = pts.length;
  if (n === 1) return { x: pts[0][0], z: pts[0][1], th: 0 };
  const total = cum[n - 1];
  d = clamp(d, 0, total);
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= d) lo = mid; else hi = mid;
  }
  const seg = cum[hi] - cum[lo];
  const f = seg > 1e-9 ? (d - cum[lo]) / seg : 0;
  const a = pts[lo], b = pts[hi];
  return {
    x: a[0] + (b[0] - a[0]) * f,
    z: a[1] + (b[1] - a[1]) * f,
    th: Math.atan2(b[1] - a[1], b[0] - a[0]),
  };
}

/** Open-polyline offset by d along the LEFT normal (miter, clamped). */
export function offsetPolyline(pts, d) {
  const n = pts.length;
  if (n < 2) return pts.slice();
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    let th;
    if (i === 0 || i === n - 1) {
      th = Math.atan2(b[1] - a[1], b[0] - a[0]);
      out[i] = [p[0] + Math.sin(th) * d, p[1] - Math.cos(th) * d];
      continue;
    }
    const th0 = Math.atan2(p[1] - a[1], p[0] - a[0]);
    const th1 = Math.atan2(b[1] - p[1], b[0] - p[0]);
    const half = wrapPi(th1 - th0) / 2;
    th = th0 + half;
    const m = 1 / Math.max(0.25, Math.cos(half));
    out[i] = [p[0] + Math.sin(th) * d * m, p[1] - Math.cos(th) * d * m];
  }
  return out;
}

export function cubicPoints(p0, p1, p2, p3, n) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, e = t * t * t;
    out.push([
      a * p0[0] + b * p1[0] + c * p2[0] + e * p3[0],
      a * p0[1] + b * p1[1] + c * p2[1] + e * p3[1],
    ]);
  }
  return out;
}

/** Points on a circle from angle a0 to a1 (radians, either direction), ≤ step rad apart. */
export function arcPoints(cx, cz, r, a0, a1, step = 0.12) {
  const n = Math.max(1, Math.ceil(Math.abs(a1 - a0) / step));
  const out = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    out.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r]);
  }
  return out;
}

/**
 * Clip a polygon to the half-plane nx·x + nz·z ≤ c (Sutherland–Hodgman).
 * `flags[i]` tags edge i→i+1 (e.g. "fronts a street"); edges made by the cut
 * get `cutFlag`. Returns { pts, flags }.
 */
export function clipHalfPlane(pts, flags, nx, nz, c, cutFlag = false) {
  const outP = [], outF = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    const dp = p[0] * nx + p[1] * nz - c;
    const dq = q[0] * nx + q[1] * nz - c;
    const f = flags ? flags[i] : false;
    if (dp <= 0) {
      outP.push(p);
      if (dq <= 0) outF.push(f);
      else {
        const t = dp / (dp - dq);
        outF.push(f);
        outP.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
        outF.push(cutFlag);
      }
    } else if (dq <= 0) {
      const t = dp / (dp - dq);
      outP.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
      outF.push(f);
    }
  }
  return { pts: outP, flags: outF };
}

/**
 * Tidy a closed polygon: drop duplicate points, zero-width spikes (a path that
 * walks out and straight back — sharp property corners produce them) and small
 * self-intersection loops. Keeps the larger side of any crossing.
 */
export function cleanPolygon(input, eps = 0.02) {
  let pts = [];
  for (const p of input) {
    const q = pts[pts.length - 1];
    if (!q || Math.abs(q[0] - p[0]) > eps || Math.abs(q[1] - p[1]) > eps) pts.push(p);
  }
  if (pts.length > 2) {
    const a = pts[0], b = pts[pts.length - 1];
    if (Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps) pts.pop();
  }
  // Spikes: p → q → back along the same line.
  for (let pass = 0; pass < 3 && pts.length > 3; pass++) {
    const out = [];
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const a = pts[(i - 1 + n) % n], p = pts[i], b = pts[(i + 1) % n];
      const ux = p[0] - a[0], uz = p[1] - a[1], vx = b[0] - p[0], vz = b[1] - p[1];
      const cross = ux * vz - uz * vx, dot = ux * vx + uz * vz;
      const lu = Math.hypot(ux, uz), lv = Math.hypot(vx, vz);
      if (lu > 1e-9 && lv > 1e-9 && Math.abs(cross) < 1e-6 * lu * lv * 50 && dot < 0) continue;
      out.push(p);
    }
    if (out.length === pts.length) break;
    pts = out;
  }
  // Self-intersection loops (O(n²), faces are small).
  for (let guard = 0; guard < 20 && pts.length > 4; guard++) {
    const n = pts.length;
    let cut = null;
    outer: for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      for (let j = i + 2; j < n; j++) {
        if (i === 0 && j === n - 1) continue;
        const c = pts[j], d = pts[(j + 1) % n];
        const hit = segIntersect(a[0], a[1], b[0], b[1], c[0], c[1], d[0], d[1]);
        if (hit) { cut = { i, j, x: hit.x, z: hit.z }; break outer; }
      }
    }
    if (!cut) break;
    const loopA = [[cut.x, cut.z], ...pts.slice(cut.i + 1, cut.j + 1)];
    const loopB = [...pts.slice(cut.j + 1), ...pts.slice(0, cut.i + 1), [cut.x, cut.z]];
    const aA = Math.abs(polygonArea(loopA)), aB = Math.abs(polygonArea(loopB));
    pts = aA >= aB ? loopA : loopB;
  }
  return pts;
}

/** Deterministic RNG (mulberry32). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform hash grid of segments for proximity queries. */
export class SegmentGrid {
  constructor(cell = 24) {
    this.cell = cell;
    this.map = new Map();
    this.items = [];
  }
  _key(ix, iz) { return ix * 73856093 ^ iz * 19349663; }
  add(ax, az, bx, bz, data) {
    const id = this.items.length;
    this.items.push({ ax, az, bx, bz, data });
    const c = this.cell;
    const x0 = Math.floor(Math.min(ax, bx) / c), x1 = Math.floor(Math.max(ax, bx) / c);
    const z0 = Math.floor(Math.min(az, bz) / c), z1 = Math.floor(Math.max(az, bz) / c);
    for (let ix = x0; ix <= x1; ix++) {
      for (let iz = z0; iz <= z1; iz++) {
        const k = this._key(ix, iz);
        let arr = this.map.get(k);
        if (!arr) this.map.set(k, (arr = []));
        arr.push(id);
      }
    }
  }
  /** Items whose cells touch the box [x ± r, z ± r]. De-duplicated. */
  query(x, z, r) {
    const c = this.cell, seen = new Set(), out = [];
    const x0 = Math.floor((x - r) / c), x1 = Math.floor((x + r) / c);
    const z0 = Math.floor((z - r) / c), z1 = Math.floor((z + r) / c);
    for (let ix = x0; ix <= x1; ix++) {
      for (let iz = z0; iz <= z1; iz++) {
        const arr = this.map.get(this._key(ix, iz));
        if (!arr) continue;
        for (const id of arr) {
          if (seen.has(id)) continue;
          seen.add(id);
          out.push(this.items[id]);
        }
      }
    }
    return out;
  }
}
