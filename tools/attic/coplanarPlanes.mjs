// Scratch: which PLANES of a kit geometry carry coplanar overlaps (same test as
// rtsPropsCoplanarTest, grouped by plane so each clash shows once).
//   node tools/attic/coplanarPlanes.mjs
import { buildColonialHQ } from "../../v3/render/objects/rtsColonial.js";
import { buildMolotova, buildPT76 } from "../../v3/render/objects/rtsVehicles.js";

const WHICH = {
  colonial: () => buildColonialHQ(),
  molotova: () => buildMolotova(),
  molotovaGear: () => buildMolotova().userData.gear,
  pt76: () => buildPT76(),
};
const geo = (WHICH[process.argv[2]] ?? WHICH.colonial)();
const p = geo.attributes.position, idx = geo.index;
const nt = idx.count / 3;
const V = (i) => [p.getX(i), p.getY(i), p.getZ(i)];
const buckets = new Map();
for (let t = 0; t < nt; t++) {
  const a = V(idx.getX(3 * t)), b = V(idx.getX(3 * t + 1)), c = V(idx.getX(3 * t + 2));
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  let n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
  const len = Math.hypot(...n);
  if (len < 1e-7) continue;
  n = n.map((x) => x / len);
  const y = (a[1] + b[1] + c[1]) / 3;
  if (n[1] < -0.9 && y < 0.35) continue;
  const d = n[0] * a[0] + n[1] * a[1] + n[2] * a[2];
  const key = n.map((x) => Math.round(x * 50)).join(",") + "|" + Math.round(d * 400);
  const ax = Math.abs(n[0]) > Math.abs(n[1]) ? (Math.abs(n[0]) > Math.abs(n[2]) ? 0 : 2) : (Math.abs(n[1]) > Math.abs(n[2]) ? 1 : 2);
  const pr = (q) => (ax === 0 ? [q[1], q[2]] : ax === 1 ? [q[0], q[2]] : [q[0], q[1]]);
  let P = [pr(a), pr(b), pr(c)];
  const cx = (P[0][0] + P[1][0] + P[2][0]) / 3, cy = (P[0][1] + P[1][1] + P[2][1]) / 3;
  P = P.map(([x, z]) => [cx + (x - cx) * 0.97, cy + (z - cy) * 0.97]);
  if (!buckets.has(key)) buckets.set(key, []);
  buckets.get(key).push({ P, c: [(a[0] + b[0] + c[0]) / 3, y, (a[2] + b[2] + c[2]) / 3].map((v) => +v.toFixed(2)) });
}
const separated = (A, B) => {
  for (const T of [A, B]) for (let i = 0; i < 3; i++) {
    const [x1, y1] = T[i], [x2, y2] = T[(i + 1) % 3];
    const nx = y2 - y1, ny = x1 - x2;
    let amin = Infinity, amax = -Infinity, bmin = Infinity, bmax = -Infinity;
    for (const q of A) { const s = q[0] * nx + q[1] * ny; amin = Math.min(amin, s); amax = Math.max(amax, s); }
    for (const q of B) { const s = q[0] * nx + q[1] * ny; bmin = Math.min(bmin, s); bmax = Math.max(bmax, s); }
    if (amax <= bmin || bmax <= amin) return true;
  }
  return false;
};
for (const [key, list] of buckets) {
  let n = 0, ex = null;
  const all = [];
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) if (!separated(list[i].P, list[j].P)) { n++; ex ??= [list[i].c, list[j].c]; all.push(JSON.stringify([list[i].P, list[j].P].map((T) => T.map((q) => q.map((v) => +v.toFixed(2)))))); }
  if (n) console.log(`${key.padEnd(22)} ${String(n).padStart(4)} pairs  e.g. ${JSON.stringify(ex)}`);
  if (n && n < 6 && process.argv[2] === "all") for (const s of all) console.log("   ", s);
}
