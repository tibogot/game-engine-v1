/**
 * Headless checks for the SOFTEN CREASES operator (v3/terrain/creaseOperator.js):
 * straight ground is left alone (even steep, even at the map edge), a terrace
 * step is rounded at its lip and foot, fine relief is kept, and a sculpt
 * edit's partial re-bake gives the same map as a full one.
 * Run: node tools/creaseOperatorTest.mjs   (picked up by npm test)
 */
import { creaseOffset, createCreaseOperator, CREASE_OP_DEFAULTS } from "../v3/terrain/creaseOperator.js";
import { createHeightLayers } from "../v3/terrain/heightLayers.js";

let pass = 0, fail = 0;
function ok(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}

const S = 128, N = S * S, WORLD = 128, MAXH = 100;     // 1 m texels, as nam-valley
const P = { size: S, worldSize: WORLD, maxHeight: MAXH, ...CREASE_OP_DEFAULTS, enabled: true };
const off = new Float32Array(N), tmp = new Float32Array(N), blur = new Float32Array(N);
const maxAbs = (a) => a.reduce((m, v) => Math.max(m, Math.abs(v)), 0) * MAXH;

// 1. A straight slope — steep, diagonal — is untouched, right up to the edges.
{
  const g = new Float32Array(N);
  for (let z = 0; z < S; z++) for (let x = 0; x < S; x++) g[z * S + x] = (10 + x * 0.6 + z * 0.35) / MAXH;
  creaseOffset(g, off, tmp, blur, P);
  ok("straight slope: no offset anywhere (edges included)", maxAbs(off) < 1e-3, `${maxAbs(off).toFixed(4)} m`);
}

// A terrace: 12 m wall over 3 texels, running DIAGONALLY to the grid (where
// the triangles draw teeth). Height in metres at (x, z).
const terrace = (x, z) => {
  const u = (x + 0.6 * z) / Math.hypot(1, 0.6) - 60;  // distance across the wall
  return 36 + 12 * Math.min(1, Math.max(0, 0.5 - u / 3));
};
const toGrid = (f) => { const g = new Float32Array(N); for (let z = 0; z < S; z++) for (let x = 0; x < S; x++) g[z * S + x] = f(x, z) / MAXH; return g; };

// 2. The step is rounded: the sharpest bend (second difference) drops a lot,
//    the lip comes down, the foot comes up, the flats far from it stay.
{
  const g = toGrid(terrace);
  creaseOffset(g, off, tmp, blur, P);
  const h = (i) => (g[i] + off[i]) * MAXH;
  const bend = (src) => {
    let m = 0;
    for (let z = 2; z < S - 2; z++) for (let x = 2; x < S - 2; x++) {
      const i = z * S + x;
      m = Math.max(m, Math.abs(src(i - 1) - 2 * src(i) + src(i + 1)), Math.abs(src(i - S) - 2 * src(i) + src(i + S)));
    }
    return m;
  };
  const b0 = bend((i) => g[i] * MAXH), b1 = bend(h);
  ok("terrace: the sharpest bend is at least halved", b1 < b0 * 0.5, `${b1.toFixed(2)} vs ${b0.toFixed(2)} m`);
  let lipDown = 0, footUp = 0, flatMoved = 0;
  for (let i = 0; i < N; i++) {
    const x = i % S, z = (i / S) | 0, u = (x + 0.6 * z) / Math.hypot(1, 0.6) - 60;
    if (Math.abs(u + 1.5) < 0.5) lipDown = Math.min(lipDown, off[i] * MAXH);
    if (Math.abs(u - 1.5) < 0.5) footUp = Math.max(footUp, off[i] * MAXH);
    if (Math.abs(u) > 10 && x > 4 && x < S - 4 && z > 4 && z < S - 4) flatMoved = Math.max(flatMoved, Math.abs(off[i]) * MAXH);
  }
  ok("terrace: the lip rounds over (comes down)", lipDown < -0.5, `${lipDown.toFixed(2)} m`);
  ok("terrace: the foot fills in (comes up)", footUp > 0.5, `${footUp.toFixed(2)} m`);
  ok("terrace: the flats away from the wall stay put", flatMoved < 1e-3, `${flatMoved.toFixed(4)} m`);
  let wallMin = Infinity;
  for (let i = 0; i < N; i++) {
    const x = i % S, z = (i / S) | 0, u = (x + 0.6 * z) / Math.hypot(1, 0.6) - 60;
    if (Math.abs(u) < 0.5 && x > 1 && x < S - 2) wallMin = Math.min(wallMin, Math.abs(h(i + 1) - h(i - 1)) / 2);
  }
  ok("terrace: the wall stays far steeper than walkable (34°)", Math.atan(wallMin) * 180 / Math.PI > 50, `${(Math.atan(wallMin) * 180 / Math.PI).toFixed(0)}°`);
}

// 3. Fine relief smaller than `detail` is kept (±0.1 m bumps 4 texels apart).
{
  const g = toGrid((x, z) => 40 + 0.1 * Math.sin(x * 1.57) * Math.sin(z * 1.57));
  creaseOffset(g, off, tmp, blur, P);
  ok("fine relief below `detail` is kept (≥ 70 % of a 0.1 m bump)", maxAbs(off) < 0.03, `${maxAbs(off).toFixed(3)} m`);
}

// 4. In the stack: first (before a river), and an edit's partial re-bake == full.
{
  const final = new Float32Array(N);
  const L = createHeightLayers({ final, size: S });
  L.reset(toGrid(terrace));
  const op = createCreaseOperator({ heightLayers: L, size: S, worldSize: WORLD, maxHeight: MAXH });
  const order = [];
  const FULL = { x0: 0, z0: 0, x1: S - 1, z1: S - 1 };
  L.setOperator("riverV3", { rect: FULL, apply() { order.push("river"); } });
  op.importData({ enabled: true });
  order.length = 0;
  L.compose({ x0: 0, z0: 0, x1: 3, z1: 3 });
  ok("creases apply before the river", L.operator("creases") && order.length === 1, order.join(","));
  // A sculpt edit: a 6 m mound written into FINAL near the lip, then absorbed.
  for (let z = 20; z < 30; z++) for (let x = 40; x < 50; x++) final[z * S + x] += 6 / MAXH;
  L.absorb({ x0: 40, z0: 20, x1: 49, z1: 29 });
  ok("the edit makes it stale", op.isStale());
  op.bake();
  ok("re-baked", !op.isStale());
  const finalFull = new Float32Array(N);
  const LF = createHeightLayers({ final: finalFull, size: S });
  LF.reset(Float32Array.from(L.ground));
  const opF = createCreaseOperator({ heightLayers: LF, size: S, worldSize: WORLD, maxHeight: MAXH });
  opF.importData({ enabled: true });
  let worst = 0; for (let i = 0; i < N; i++) worst = Math.max(worst, Math.abs(final[i] - finalFull[i]));
  ok("edit: partial re-bake == full bake", worst * MAXH < 1e-4, `${(worst * MAXH).toFixed(5)} m`);
  op.set({ enabled: false });
  let back = 0; for (let i = 0; i < N; i++) back = Math.max(back, Math.abs(final[i] - L.ground[i]));
  ok("switching off restores the ground", back * MAXH < 1e-5 && !L.operator("creases"));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
