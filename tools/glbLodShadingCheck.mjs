/**
 * THE FAR MODEL SHADES LIKE THE NEAR ONE (2026-10-23, you at the ksar: shadows that "disappear when the camera comes
 * close" were the FAR models' bad shading — a long dark streak down the minaret, combed stripes on the walls, dark
 * wedges in the windows — gone when the clean near model took over at 60 m; "be sure this normal problem will never
 * happen again"). A gate, as the Blender game-skill repos run one after every export: every `X` / `X_Far` pair of a
 * model is compared ON THE SURFACE — points sampled over the far model's triangles (area-weighted), each point's
 * interpolated shading normal against the near model's at the closest point of its surface. The share of the far
 * surface whose shading turns more than LIMIT_DEG away is the score; over MAX_BAD the model FAILS.
 *
 * TWO KINDS OF FAR LEVEL. A far level DECIMATED from the near (bkit.far) must shade like it: MAX_BAD, strict — that
 * is where the bug came from. A far level BUILT on its own as a simpler shape (a piece's `farBuilder`: the mirador's
 * flat roof for corrugated sheet, a tent's coarser tarp) differs by design, so a fixed limit says nothing: its value
 * as ACCEPTED (by eye, near vs far renders) is kept in glbLodShadingBaseline.json, and it fails only if it gets WORSE
 * by more than SLACK points. `--accept` writes the current values of those models as the new baseline.
 *
 *   node tools/glbLodShadingCheck.mjs [dir|file.glb …] [--all] [--accept]      (default: public/models/alg)
 */
import fs from "node:fs";
import path from "node:path";
import { readGlb } from "./lib/glbRead.mjs";

const LIMIT_DEG = 25, MAX_BAD = 0.04;   // (4 % of the surface off by more than 25 deg: a streak you see)
const SLACK = 0.03;
// the kits whose far levels are BUILT, not decimated (tools/blender/*.py with a farBuilder)
const BUILT_FAR = new Set(["postkit.glb", "mirador.glb", "sltower.glb", "fieldposts.glb", "flnposts.glb", "armscache.glb", "barbedwire.glb", "sangar.glb", "ambushscreen.glb", "hedges.glb",
  "fortpoint.glb", "mgnest.glb", "mortarpit.glb", "smallprops.glb", "points.glb"]);
const BASE_FILE = new URL("./glbLodShadingBaseline.json", import.meta.url);
const baseline = fs.existsSync(BASE_FILE) ? JSON.parse(fs.readFileSync(BASE_FILE, "utf8")) : {};
const SAMPLES = 6000;
const args = process.argv.slice(2), all = args.includes("--all"), accept = args.includes("--accept");
const inputs = args.filter((a) => !a.startsWith("--"));
const files = (inputs.length ? inputs : ["public/models/alg"]).flatMap((p) =>
  fs.statSync(p).isDirectory() ? fs.readdirSync(p).filter((f) => f.endsWith(".glb")).map((f) => path.join(p, f)) : [p]);

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** The near model's triangles in a grid, for the closest point on its surface and the normal interpolated there. */
function surface(n) {
  const P = n.positions, N = n.normals, I = n.indices, T = I.length / 3;
  let lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
  for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], P[i + k]); hi[k] = Math.max(hi[k], P[i + k]); }
  const cell = Math.max(0.25, Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 48), grid = new Map();
  const key = (x, y, z) => `${Math.floor((x - lo[0]) / cell)},${Math.floor((y - lo[1]) / cell)},${Math.floor((z - lo[2]) / cell)}`;
  for (let t = 0; t < T; t++) {
    // every cell the triangle's box touches
    const v = [0, 1, 2].map((k) => I[3 * t + k]);
    const mn = [0, 1, 2].map((c) => Math.min(...v.map((i) => P[3 * i + c]))), mx = [0, 1, 2].map((c) => Math.max(...v.map((i) => P[3 * i + c])));
    for (let x = Math.floor((mn[0] - lo[0]) / cell); x <= Math.floor((mx[0] - lo[0]) / cell); x++)
      for (let y = Math.floor((mn[1] - lo[1]) / cell); y <= Math.floor((mx[1] - lo[1]) / cell); y++)
        for (let z = Math.floor((mn[2] - lo[2]) / cell); z <= Math.floor((mx[2] - lo[2]) / cell); z++) {
          const k = `${x},${y},${z}`; let l = grid.get(k); if (!l) grid.set(k, (l = [])); l.push(t);
        }
  }
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const V = (i) => [P[3 * i], P[3 * i + 1], P[3 * i + 2]], NN = (i) => [N[3 * i], N[3 * i + 1], N[3 * i + 2]];
  // closest point on triangle (Ericson), with its barycentrics
  function closest(p, a, b, c) {
    const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a), d1 = dot(ab, ap), d2 = dot(ac, ap);
    if (d1 <= 0 && d2 <= 0) return [1, 0, 0];
    const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
    if (d3 >= 0 && d4 <= d3) return [0, 1, 0];
    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return [1 - v, v, 0]; }
    const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
    if (d6 >= 0 && d5 <= d6) return [0, 0, 1];
    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return [1 - w, 0, w]; }
    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / ((d4 - d3) + (d5 - d6)); return [0, 1 - w, w]; }
    const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
    return [1 - v - w, v, w];
  }
  /** The near shading normal at the surface point closest to p (within a few cells), the far normal's best side. */
  return (p, fn) => {
    const cx = Math.floor((p[0] - lo[0]) / cell), cy = Math.floor((p[1] - lo[1]) / cell), cz = Math.floor((p[2] - lo[2]) / cell);
    let best = Infinity, bn = null;
    for (let r = 0; r <= 2 && !bn; r++) {
      const seen = new Set();
      for (let x = cx - r; x <= cx + r; x++) for (let y = cy - r; y <= cy + r; y++) for (let z = cz - r; z <= cz + r; z++) {
        for (const t of grid.get(`${x},${y},${z}`) ?? []) {
          if (seen.has(t)) continue; seen.add(t);
          const i = [I[3 * t], I[3 * t + 1], I[3 * t + 2]], a = V(i[0]), b = V(i[1]), c = V(i[2]), w = closest(p, a, b, c);
          const q = [0, 1, 2].map((k) => a[k] * w[0] + b[k] * w[1] + c[k] * w[2]), d = Math.hypot(...sub(p, q));
          if (d > best + 0.02) continue;
          const na = NN(i[0]), nb = NN(i[1]), nc = NN(i[2]);
          let nv = [0, 1, 2].map((k) => na[k] * w[0] + nb[k] * w[1] + nc[k] * w[2]); const l = Math.hypot(...nv) || 1; nv = nv.map((v) => v / l);
          // two surfaces at one place (a wall and its window reveal): the nearest that faces the same way
          if (d < best - 0.02 || dot(nv, fn) > dot(bn ?? [0, 0, 0], fn)) { best = Math.min(best, d); bn = nv; }
        }
      }
      if (bn && best > cell * (r + 1)) bn = null;   // (a closer one may sit a ring further out)
    }
    return bn ? { n: bn, d: best } : null;
  };
}

function score(near, far) {
  const at = surface(near), R = rng(7), P = far.positions, N = far.normals, I = far.indices, T = I.length / 3;
  const area = new Float64Array(T); let tot = 0;
  for (let t = 0; t < T; t++) {
    const a = 3 * I[3 * t], b = 3 * I[3 * t + 1], c = 3 * I[3 * t + 2];
    const u = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]], v = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
    tot += area[t] = Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
  }
  const cdf = new Float64Array(T); let acc = 0; for (let t = 0; t < T; t++) cdf[t] = acc += area[t] / tot;
  let bad = 0, n = 0, worst = 0;
  const lim = Math.cos((LIMIT_DEG * Math.PI) / 180);
  for (let s = 0; s < SAMPLES; s++) {
    const r = R(); let lo = 0, hi = T - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (cdf[m] < r) lo = m + 1; else hi = m; }
    let w1 = R(), w2 = R(); if (w1 + w2 > 1) { w1 = 1 - w1; w2 = 1 - w2; } const w0 = 1 - w1 - w2;
    const ids = [I[3 * lo], I[3 * lo + 1], I[3 * lo + 2]], ws = [w0, w1, w2];
    const p = [0, 1, 2].map((k) => ids.reduce((s2, id, j) => s2 + P[3 * id + k] * ws[j], 0));
    let fn = [0, 1, 2].map((k) => ids.reduce((s2, id, j) => s2 + N[3 * id + k] * ws[j], 0)); const l = Math.hypot(...fn) || 1; fn = fn.map((x) => x / l);
    const m = at(p, fn); if (!m || m.d > 0.25) continue;   // (far surface with no near surface close: a decimated shape, not shading)
    n++;
    const c = fn[0] * m.n[0] + fn[1] * m.n[1] + fn[2] * m.n[2];
    if (c < lim) bad++;
    worst = Math.max(worst, Math.acos(Math.max(-1, Math.min(1, c))) * 180 / Math.PI);
  }
  return { bad: n ? bad / n : 0, n };
}

let failed = 0;
for (const f of files) {
  const { nodes } = await readGlb(f);
  const by = new Map(nodes.map((n) => [n.name, n]));
  const rows = [];
  for (const far of nodes.filter((n) => /_Far$/.test(n.name))) {
    const near = by.get(far.name.replace(/_Far$/, ""));
    if (!near || !near.normals.some((v) => v !== 0) || !far.normals.some((v) => v !== 0)) continue;
    const r = score(near, far);
    rows.push([far.name, r]);
  }
  if (!rows.length) continue;
  const built = BUILT_FAR.has(path.basename(f));
  if (built && accept) for (const [nm, r] of rows) baseline[nm] = +r.bad.toFixed(4);
  const limit = (nm) => (built ? (baseline[nm] ?? MAX_BAD) + SLACK : MAX_BAD);
  const bad = rows.filter(([nm, r]) => r.bad > limit(nm));
  if (bad.length) failed++;
  console.log(`  ${bad.length ? "FAIL" : "ok  "} ${path.basename(f)}  ${rows.length} far models${built ? " (built far levels: against the accepted baseline)" : ""}${bad.length ? `, ${bad.length} shade unlike their near` : ""}`);
  for (const [nm, r] of (all ? rows : bad).slice(0, all ? 99 : 6)) console.log(`         ${nm.padEnd(32)} ${(r.bad * 100).toFixed(1)}% of its surface off > ${LIMIT_DEG}°  (limit ${(limit(nm) * 100).toFixed(1)}%, ${r.n} samples)`);
}
if (accept) fs.writeFileSync(BASE_FILE, JSON.stringify(Object.fromEntries(Object.entries(baseline).sort()), null, 1) + "\n");
console.log(failed ? `\n${failed} models whose far level shades unlike the near` : "\nall far levels shade like their near");
process.exit(failed ? 1 : 0);
