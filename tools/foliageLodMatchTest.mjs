// FOLIAGE LOD MATCH (2026-10-07, you: "the LOD doesn't match the original, it pops"): each of
// alg-aures' painted plant types at LOD 0/1/2 — triangles, and how much of LOD 0's SILHOUETTE (seen
// from the RTS camera, ~50° down) each coarse level keeps (IoU) and its area ratio. The coarse
// levels must be SUBSETS of the near plant (the same leaves, fewer), or every plant pops at the
// switch. Floors below for the types made nested; the rest are reported.
//   node tools/foliageLodMatchTest.mjs
import { readProject } from "./lib/v3proj.mjs";
import { createFoliageTypeGeometry } from "../v3/render/foliage/foliageGeometry.js";
const p = await readProject(new URL("../public/levels/alg-aures.v3proj", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const N = 96, pitch = 50 * Math.PI / 180, cp = Math.cos(pitch), sp = Math.sin(pitch);
const proj = (x, y, z) => [x, z * sp + y * cp];   // view from -z side, tilted down
function mask(g, box) {
  const m = new Uint8Array(N * N), pos = g.attributes.position.array, idx = g.index.array;
  const [x0, y0, x1, y1] = box, sx = (N - 1) / (x1 - x0), sy = (N - 1) / (y1 - y0);
  for (let t = 0; t < idx.length; t += 3) {
    const v = [0, 1, 2].map((k) => { const i = idx[t + k] * 3; const [a, b] = proj(pos[i], pos[i + 1], pos[i + 2]); return [(a - x0) * sx, (b - y0) * sy]; });
    const minX = Math.max(0, Math.floor(Math.min(...v.map((q) => q[0])))), maxX = Math.min(N - 1, Math.ceil(Math.max(...v.map((q) => q[0]))));
    const minY = Math.max(0, Math.floor(Math.min(...v.map((q) => q[1])))), maxY = Math.min(N - 1, Math.ceil(Math.max(...v.map((q) => q[1]))));
    const e = (a, b, c) => (c[0] - a[0]) * (b[1] - a[1]) - (c[1] - a[1]) * (b[0] - a[0]);
    const area = e(v[0], v[1], v[2]); if (Math.abs(area) < 1e-9) continue;
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      const q = [x + 0.5, y + 0.5], w0 = e(v[1], v[2], q), w1 = e(v[2], v[0], q), w2 = e(v[0], v[1], q);
      if ((w0 >= 0 && w1 >= 0 && w2 >= 0) || (w0 <= 0 && w1 <= 0 && w2 <= 0)) m[y * N + x] = 1;
    }
  }
  return m;
}
// Mid-LOD floors for the nested builders (measured 2026-10-07: doum 0.92, alfa 0.72, reed-mace 0.75).
const FLOOR = { fanPalm: 0.88, blades: 0.65, typha: 0.68 };
let failed = 0;
for (const t of p.manifest.foliagePlants) {
  const gs = [0, 1, 2].map((lod) => createFoliageTypeGeometry(t, { lod }));
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const { geometry: g } of gs) { const a = g.attributes.position.array; for (let i = 0; i < a.length; i += 3) { const [u, v] = proj(a[i], a[i + 1], a[i + 2]); x0 = Math.min(x0, u); x1 = Math.max(x1, u); y0 = Math.min(y0, v); y1 = Math.max(y1, v); } }
  const ms = gs.map(({ geometry }) => mask(geometry, [x0, y0, x1, y1]));
  const cnt = (m) => m.reduce((s, v) => s + v, 0);
  const iou = (a, b) => { let i = 0, u = 0; for (let k = 0; k < a.length; k++) { i += a[k] & b[k]; u += a[k] | b[k]; } return u ? i / u : 1; };
  const c0 = cnt(ms[0]);
  const i1 = iou(ms[0], ms[1]);
  const floor = FLOOR[t.kind];
  if (floor != null) { const ok = i1 >= floor; if (!ok) failed++; console.log(ok ? "PASS" : "FAIL", `${t.name}: mid LOD keeps ${(i1 * 100).toFixed(0)}% of the near silhouette (floor ${floor * 100}%)`); }
  console.log("     ", t.name.padEnd(15), t.kind.padEnd(11), gs.map((g) => String(g.triangles).padStart(5)).join(" /"), " tris | LOD1 IoU", iou(ms[0], ms[1]).toFixed(2), "area", (cnt(ms[1]) / c0).toFixed(2), "| LOD2 IoU", iou(ms[0], ms[2]).toFixed(2), "area", (cnt(ms[2]) / c0).toFixed(2));
}
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
