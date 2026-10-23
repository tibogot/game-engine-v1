/**
 * Coplanar overlaps (z-fighting) in a geometry — shared by tools/rtsPropsCoplanarTest.mjs (the JS-built kits) and
 * tools/glbCoplanarCheck.mjs (the Blender models). See the first for the rules.
 */
/** Visible coplanar overlapping pairs in a geometry, with the first one found. */
export function coplanarOverlaps(geo) {
  const p = geo.attributes.position, idx = geo.index;
  const nt = idx ? idx.count / 3 : p.count / 3;
  const vi = (k) => (idx ? idx.getX(k) : k);
  const V = (i) => [p.getX(i), p.getY(i), p.getZ(i)];
  const buckets = new Map();
  for (let t = 0; t < nt; t++) {
    const a = V(vi(3 * t)), b = V(vi(3 * t + 1)), c = V(vi(3 * t + 2));
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const len = Math.hypot(n[0], n[1], n[2]);
    if (len < 1e-7) continue;
    n = n.map((x) => x / len);
    const y = (a[1] + b[1] + c[1]) / 3;
    if (n[1] < -0.9 && y < 0.35) continue;               // a bottom on the ground
    const d = n[0] * a[0] + n[1] * a[1] + n[2] * a[2];
    // Coarse buckets (normal to ~3 deg, offset to 1 cm), each face in its offset
    // bin AND the next, so no pair is lost across a bin edge; `truly` below
    // does the exact test. (Fine bins hid real pairs by the model's orientation.)
    const nk = n.map((x) => Math.round(x * 20)).join(",");
    const dk = Math.floor(d * 100);
    const ax = Math.abs(n[0]) > Math.abs(n[1]) ? (Math.abs(n[0]) > Math.abs(n[2]) ? 0 : 2) : (Math.abs(n[1]) > Math.abs(n[2]) ? 1 : 2);
    const pr = (q) => (ax === 0 ? [q[1], q[2]] : ax === 1 ? [q[0], q[2]] : [q[0], q[1]]);
    let P = [pr(a), pr(b), pr(c)];
    const cx = (P[0][0] + P[1][0] + P[2][0]) / 3, cy = (P[0][1] + P[1][1] + P[2][1]) / 3;
    P = P.map(([x, z]) => [cx + (x - cx) * 0.97, cy + (z - cy) * 0.97]);
    const entry = { t, P, n, d, V: [a, b, c], at: [a, b, c].map((q) => q.map((x) => +x.toFixed(2))) };
    for (const key of [nk + "|" + dk, nk + "|" + (dk + 1)]) {
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(entry);
    }
  }
  const separated = (A, B) => {
    for (const T of [A, B]) {
      for (let i = 0; i < 3; i++) {
        const [x1, y1] = T[i], [x2, y2] = T[(i + 1) % 3];
        const nx = y2 - y1, ny = x1 - x2;
        let amin = Infinity, amax = -Infinity, bmin = Infinity, bmax = -Infinity;
        for (const q of A) { const s = q[0] * nx + q[1] * ny; amin = Math.min(amin, s); amax = Math.max(amax, s); }
        for (const q of B) { const s = q[0] * nx + q[1] * ny; bmin = Math.min(bmin, s); bmax = Math.max(bmax, s); }
        if (amax <= bmin || bmax <= amin) return true;
      }
    }
    return false;
  };
  // The bucket key is only a pre-filter: a plane's offset is measured from the
  // ORIGIN, so on geometry metres away a sub-degree tilt moves it by
  // centimetres and faces 1.6 cm apart (the Huey's glazing over its skin) can
  // share a bucket. A pair counts only if it REALLY is coplanar: normals within
  // 1.5 deg and every corner of each within 2.5 mm of the other's plane.
  const truly = (A, B) => {
    if (A.n[0] * B.n[0] + A.n[1] * B.n[1] + A.n[2] * B.n[2] < Math.cos(1.5 * Math.PI / 180)) return false;
    const off = (T, q) => Math.abs(T.n[0] * q[0] + T.n[1] * q[1] + T.n[2] * q[2] - T.d);
    return B.V.every((q) => off(A, q) < 0.0025) && A.V.every((q) => off(B, q) < 0.0025);
  };
  let pairs = 0, first = null;
  const all = [];   // (every pair's first triangle centre: where to look)
  const seen = new Set();
  for (const list of buckets.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (!truly(list[i], list[j])) continue;
        const id = list[i].t < list[j].t ? list[i].t * 1e7 + list[j].t : list[j].t * 1e7 + list[i].t;
        if (seen.has(id)) continue;
        seen.add(id);
        if (!separated(list[i].P, list[j].P)) { pairs++; first ??= [list[i].at, list[j].at]; all.push(list[i].at); }
      }
    }
  }
  return { pairs, first, all, tris: nt };
}
