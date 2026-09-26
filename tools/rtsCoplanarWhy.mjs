/**
 * WHY does a kit piece z-fight? rtsPropsCoplanarTest.mjs says HOW MANY
 * coplanar overlapping triangle pairs a piece has; this names the PARTS
 * behind them (the entries of the `parts` list it was assembled from), so
 * the fix is a one-line nudge instead of a hunt.
 *
 *   node tools/rtsCoplanarWhy.mjs <module path> <builder name> [top N]
 *   node tools/rtsCoplanarWhy.mjs v3/render/objects/rtsFrenchPost.js buildFrenchPost 20
 *
 * Same test as the suite (normals within 1.5 deg, every corner within
 * 2.5 mm of the other's plane, outlines overlapping once shrunk 3%).
 * Reported per part PAIR: index, material id, position, and pair count.
 * Only the top-level assembly is traced (sub-assemblies show as one part).
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ASSEMBLE_TRACE } from "../v3/render/objects/rtsParts.js";

const [modPath, fnName, topArg] = process.argv.slice(2);
if (!modPath || !fnName) throw new Error("usage: node tools/rtsCoplanarWhy.mjs <module> <builder> [top]");
ASSEMBLE_TRACE.on = true;
const mod = await import(pathToFileURL(path.resolve(modPath)).href);
let geo = mod[fnName]();
if (process.argv.includes("--gear")) geo = geo.userData.gear;
const trace = geo.userData.partTrace;
if (!trace) throw new Error("no partTrace: was it assembled through rtsParts.assemble?");
// Triangle index → part index. The geometry was scaled after assembly (x1.3);
// positions below are in the part list's own (pre-scale) metres.
const starts = [];
let acc = 0;
for (const t of trace) { starts.push(acc); acc += t.tris; }
const partOf = (tri) => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (starts[m] <= tri) lo = m; else hi = m - 1; } return lo; };

const p = geo.attributes.position, idx = geo.index;
const nt = idx ? idx.count / 3 : p.count / 3;
const vi = (k) => (idx ? idx.getX(k) : k);
const V = (i) => [p.getX(i), p.getY(i), p.getZ(i)];
const buckets = new Map();
for (let t = 0; t < nt; t++) {
  const a = V(vi(3 * t)), b = V(vi(3 * t + 1)), c = V(vi(3 * t + 2));
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  let n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
  const len = Math.hypot(...n);
  if (len < 1e-7) continue;
  n = n.map((x) => x / len);
  if (n[1] < -0.9 && (a[1] + b[1] + c[1]) / 3 < 0.35) continue;
  const d = n[0] * a[0] + n[1] * a[1] + n[2] * a[2];
  const nk = n.map((x) => Math.round(x * 20)).join(","), dk = Math.floor(d * 100);
  const ax = Math.abs(n[0]) > Math.abs(n[1]) ? (Math.abs(n[0]) > Math.abs(n[2]) ? 0 : 2) : (Math.abs(n[1]) > Math.abs(n[2]) ? 1 : 2);
  const pr = (q) => (ax === 0 ? [q[1], q[2]] : ax === 1 ? [q[0], q[2]] : [q[0], q[1]]);
  let P = [pr(a), pr(b), pr(c)];
  const cx = (P[0][0] + P[1][0] + P[2][0]) / 3, cy = (P[0][1] + P[1][1] + P[2][1]) / 3;
  P = P.map(([x, z]) => [cx + (x - cx) * 0.97, cy + (z - cy) * 0.97]);
  const e = { t, P, n, d, V: [a, b, c] };
  for (const key of [nk + "|" + dk, nk + "|" + (dk + 1)]) { if (!buckets.has(key)) buckets.set(key, []); buckets.get(key).push(e); }
}
const separated = (A, B) => {
  for (const T of [A, B]) for (let i = 0; i < 3; i++) {
    const [x1, y1] = T[i], [x2, y2] = T[(i + 1) % 3], nx = y2 - y1, ny = x1 - x2;
    let amin = Infinity, amax = -Infinity, bmin = Infinity, bmax = -Infinity;
    for (const q of A) { const s = q[0] * nx + q[1] * ny; amin = Math.min(amin, s); amax = Math.max(amax, s); }
    for (const q of B) { const s = q[0] * nx + q[1] * ny; bmin = Math.min(bmin, s); bmax = Math.max(bmax, s); }
    if (amax <= bmin || bmax <= amin) return true;
  }
  return false;
};
const truly = (A, B) => {
  if (A.n[0] * B.n[0] + A.n[1] * B.n[1] + A.n[2] * B.n[2] < Math.cos(1.5 * Math.PI / 180)) return false;
  const off = (T, q) => Math.abs(T.n[0] * q[0] + T.n[1] * q[1] + T.n[2] * q[2] - T.d);
  return B.V.every((q) => off(A, q) < 0.0025) && A.V.every((q) => off(B, q) < 0.0025);
};
const byPair = new Map(), seen = new Set();
let total = 0;
for (const list of buckets.values()) for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
  if (!truly(list[i], list[j])) continue;
  const id = Math.min(list[i].t, list[j].t) * 1e7 + Math.max(list[i].t, list[j].t);
  if (seen.has(id) || separated(list[i].P, list[j].P)) continue;
  seen.add(id); total++;
  const pa = partOf(list[i].t), pb = partOf(list[j].t);
  const k = Math.min(pa, pb) + "-" + Math.max(pa, pb);
  const r = byPair.get(k) ?? { a: Math.min(pa, pb), b: Math.max(pa, pb), n: 0, at: list[i].V[0].map((x) => +x.toFixed(2)), normal: list[i].n.map((x) => +x.toFixed(2)) };
  r.n++; byPair.set(k, r);
}
const fmt = (i) => { const t = trace[i]; return `#${i} mat ${t.mat ?? "sub"} pos ${JSON.stringify(t.pos ?? (t.matrix ? "matrix" : [0, 0, 0]))}${t.rot ? " rot " + JSON.stringify(t.rot.map((x) => +(+x).toFixed(2))) : ""}`; };
const rows = [...byPair.values()].sort((x, y) => y.n - x.n).slice(0, +(topArg ?? 15));
console.log(`${fnName}: ${total} overlapping pairs across ${byPair.size} part pairs (${trace.length} parts)`);
for (const r of rows) console.log(`${String(r.n).padStart(5)}  ${r.a === r.b ? "SELF " : ""}${fmt(r.a)}  <>  ${fmt(r.b)}   n ${JSON.stringify(r.normal)} at ${JSON.stringify(r.at)}`);
