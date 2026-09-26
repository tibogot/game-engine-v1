/**
 * Headless checks for River v3 — the network solver (v3/tools/riverV3/
 * riverV3Network.js) and its terrain operator (riverV3Terrain.js).
 *
 * The ones that matter most:
 *   3 — levels are ACCORDANT at a junction (every reach end, one level)
 *   4 — discharge is conserved (trunk = sum of tributaries)
 *   2 — a drag changes only the spans next to the node (fast editing)
 *   7 — a tributary never fills the trunk's channel
 * Run: node tools/riverV3NetworkTest.mjs   (picked up by npm test)
 */
import { solveNetwork } from "../v3/tools/riverV3/riverV3Network.js";
import {
  packReaches, buildRiverV3TerrainOp, snapshotReaches, networkDirtyRect,
} from "../v3/tools/riverV3/riverV3Terrain.js";
import { createHeightLayers } from "../v3/terrain/heightLayers.js";

let pass = 0, fail = 0;
function ok(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}

const WORLD = 1024, MAXH = 250, SIZE = 256;
/** Ground falling gently to −z, with a little cross slope. */
const ground = (x, z) => 60 + z * 0.04 + x * 0.005;
const node = (x, z, o = {}) => ({ x, z, y: null, width: 10, depth: 1.8, bank: 8, ...o });

// ── 1. One reach: downhill, stations on the nodes ───────────────────────────
{
  const reaches = [{ id: 1, from: null, to: null, nodes: [node(0, 200), node(10, 100), node(-10, 0), node(0, -100)] }];
  const { reaches: out } = solveNetwork({ junctions: [], reaches, sampleGround: ground });
  const s = out.get(1);
  let down = true;
  for (let i = 1; i < s.count; i++) if (s.level[i] > s.level[i - 1] + 1e-6) down = false;
  ok("single reach: level never climbs", down);
  ok("single reach: first and last station sit on the end nodes",
    Math.abs(s.x[0] - 0) < 1e-4 && Math.abs(s.z[0] - 200) < 1e-4 && Math.abs(s.x[s.count - 1]) < 1e-4 && Math.abs(s.z[s.count - 1] + 100) < 1e-4);
  const atNode = [...s.span].findIndex((k, i) => i > 0 && k === 1 && s.span[i - 1] === 0);
  ok("single reach: a station lands exactly on each interior node",
    atNode > 0 && Math.abs(s.x[atNode] - 10) < 1e-4 && Math.abs(s.z[atNode] - 100) < 1e-4);
}

// ── 2. A drag changes only the spans that depend on the moved node ──────────
{
  const mk = (dx) => [{
    id: 1, from: null, to: null,
    nodes: Array.from({ length: 10 }, (_, k) => node(k === 5 ? dx : 0, 400 - k * 80, { y: 80 - k })),
  }];
  const a = solveNetwork({ junctions: [], reaches: mk(0), sampleGround: ground }).reaches.get(1);
  const b = solveNetwork({ junctions: [], reaches: mk(12), sampleGround: ground }).reaches.get(1);
  // Node 5 moves spans 3..5 (curve) and the interpolation of spans 3..6.
  let farSame = true, nearDiff = false;
  const idx = (s, lo, hi) => [...s.span].map((k, i) => (k >= lo && k <= hi ? i : -1)).filter((i) => i >= 0);
  const A0 = idx(a, 0, 1), B0 = idx(b, 0, 1);
  for (let j = 0; j < A0.length; j++) if (a.x[A0[j]] !== b.x[B0[j]] || a.level[A0[j]] !== b.level[B0[j]]) farSame = false;
  const A8 = idx(a, 8, 8), B8 = idx(b, 8, 8);
  for (let j = 0; j < A8.length; j++) if (a.x[A8[j]] !== b.x[B8[j]] || a.z[A8[j]] !== b.z[B8[j]]) farSame = false;
  const A4 = idx(a, 4, 4), B4 = idx(b, 4, 4);
  for (let j = 0; j < Math.min(A4.length, B4.length); j++) if (a.x[A4[j]] !== b.x[B4[j]]) nearDiff = true;
  ok("drag: spans far from the moved node are bit-identical", farSame);
  ok("drag: the spans next to it do change", nearDiff);
}

// ── 3/4/5. A confluence: accordant levels, conserved discharge ──────────────
const J = 7;
const conf = {
  junctions: [{ id: J, x: 0, z: 0, y: null }],
  reaches: [
    { id: 1, from: null, to: J, nodes: [node(-150, 250, { width: 8 }), node(-60, 100, { width: 8 }), node(0, 0, { width: 8 })] },
    { id: 2, from: null, to: J, nodes: [node(160, 240, { width: 6 }), node(70, 90, { width: 6 }), node(0, 0, { width: 6 })] },
    { id: 3, from: J, to: null, nodes: [node(0, 0, { width: 12, depth: 2.4 }), node(10, -150, { width: 12, depth: 2.4 }), node(-10, -300, { width: 12, depth: 2.4 })] },
  ],
};
{
  const sol = solveNetwork({ ...conf, sampleGround: ground });
  const r1 = sol.reaches.get(1), r2 = sol.reaches.get(2), r3 = sol.reaches.get(3);
  const L = sol.junctions.get(J).level;
  ok("confluence: all three reach ends at ONE level (Playfair)",
    Math.abs(r1.level[r1.count - 1] - L) < 1e-5 && Math.abs(r2.level[r2.count - 1] - L) < 1e-5 && Math.abs(r3.level[0] - L) < 1e-5,
    `${r1.level[r1.count - 1]} ${r2.level[r2.count - 1]} ${r3.level[0]} vs ${L}`);
  ok("confluence: junction reported as a confluence", sol.junctions.get(J).kind === "confluence");
  ok("confluence: trunk Q = sum of tributaries", Math.abs(r3.q - (r1.q + r2.q)) < 1e-9, `${r3.q} vs ${r1.q}+${r2.q}`);
  ok("confluence: Q from width (w = 2.5·√Q): 8 m → 10.24 m³/s", Math.abs(r1.q - 10.24) < 1e-9, `${r1.q}`);
  const v3 = r3.speed[5], expect = r3.q / (r3.width[5] * r3.depth[5] * (1 - 0.55 / 3));
  ok("confluence: trunk speed = Q / A", Math.abs(v3 - Math.min(9, expect)) < 1e-4, `${v3} vs ${expect}`);
  let down = true;
  for (const s of [r1, r2, r3]) for (let i = 1; i < s.count; i++) if (s.level[i] > s.level[i - 1] + 1e-6) down = false;
  ok("confluence: every reach runs downhill through the junction", down);
}

// ── 5. A split divides the flow by width², and conserves it ─────────────────
{
  const sol = solveNetwork({
    junctions: [{ id: 1, x: 0, z: 0, y: null }],
    reaches: [
      { id: 1, from: null, to: 1, nodes: [node(0, 200, { width: 12 }), node(0, 0, { width: 12 })] },
      { id: 2, from: 1, to: null, nodes: [node(0, 0, { width: 9 }), node(-80, -200, { width: 9 })] },
      { id: 3, from: 1, to: null, nodes: [node(0, 0, { width: 6 }), node(80, -200, { width: 6 })] },
    ],
    sampleGround: ground,
  });
  const q1 = sol.reaches.get(1).q, q2 = sol.reaches.get(2).q, q3 = sol.reaches.get(3).q;
  ok("split: outflows sum to the inflow", Math.abs(q2 + q3 - q1) < 1e-9);
  ok("split: shared by width² (81:36)", Math.abs(q2 / q3 - 81 / 36) < 1e-9);
  ok("split: junction reported as a split", sol.junctions.get(1).kind === "split");
}

// ── 6. A cycle is reported, not an infinite loop ────────────────────────────
{
  const sol = solveNetwork({
    junctions: [{ id: 1, x: 0, z: 0, y: null }, { id: 2, x: 0, z: -100, y: null }],
    reaches: [
      { id: 1, from: 1, to: 2, nodes: [node(0, 0), node(0, -100)] },
      { id: 2, from: 2, to: 1, nodes: [node(0, -100), node(0, 0)] },
    ],
    sampleGround: ground,
  });
  ok("cycle: both reaches reported cyclic, solve returns", sol.cyclic.length === 2);
}

// ── 7. Terrain: the tributary never fills the trunk's channel ───────────────
const toGrid = () => {
  const g = new Float32Array(SIZE * SIZE);
  for (let z = 0; z < SIZE; z++) for (let x = 0; x < SIZE; x++) {
    g[z * SIZE + x] = ground(((x + 0.5) / SIZE - 0.5) * WORLD, ((z + 0.5) / SIZE - 0.5) * WORLD) / MAXH;
  }
  return g;
};
const U = { bedCurve: 0.55, freeboardN: 0.6 / MAXH, lipFrac: 0.28, slopeToUv: MAXH / (0.9 * WORLD), flareMax: 4 };
{
  const sol = solveNetwork({ ...conf, sampleGround: ground });
  const list = [1, 2, 3].map((id) => ({ id, solved: sol.reaches.get(id) }));
  const g = toGrid();
  const all = Float32Array.from(g);
  buildRiverV3TerrainOp({ packed: packReaches(list, { worldSize: WORLD, maxHeight: MAXH }), size: SIZE, u: U }).apply(all, g, { x0: 0, z0: 0, x1: SIZE - 1, z1: SIZE - 1 });
  const trunkOnly = Float32Array.from(g);
  buildRiverV3TerrainOp({ packed: packReaches([list[2]], { worldSize: WORLD, maxHeight: MAXH }), size: SIZE, u: U }).apply(trunkOnly, g, { x0: 0, z0: 0, x1: SIZE - 1, z1: SIZE - 1 });
  // Texels inside the trunk's channel near the junction.
  const r3 = sol.reaches.get(3);
  let worstFill = 0, checked = 0;
  for (let z = 0; z < SIZE; z++) for (let x = 0; x < SIZE; x++) {
    const wx = ((x + 0.5) / SIZE - 0.5) * WORLD, wz = ((z + 0.5) / SIZE - 0.5) * WORLD;
    if (Math.hypot(wx, wz) > 40) continue;
    let dmin = Infinity;
    for (let i = 0; i < r3.count; i++) dmin = Math.min(dmin, Math.hypot(wx - r3.x[i], wz - r3.z[i]));
    if (dmin > r3.width[0] * 0.4) continue;
    checked++;
    worstFill = Math.max(worstFill, (all[z * SIZE + x] - trunkOnly[z * SIZE + x]) * MAXH);
  }
  ok(`junction: no tributary fill inside the trunk channel (${checked} texels)`, checked > 3 && worstFill < 1e-3, `worst +${worstFill.toFixed(3)} m`);
  // The junction centre is at or below the trunk's own bed (the scour).
  const jc = Math.floor(0.5 * SIZE) * SIZE + Math.floor(0.5 * SIZE);
  ok("junction: centre is at or below the trunk bed", all[jc] <= trunkOnly[jc] + 1e-7);
}

// ── 8/9. Dirty rect per reach id: partial == full, and small ────────────────
{
  const moved = structuredClone(conf);
  moved.reaches[1].nodes[0].x += 20;                // drag the top of tributary 2
  const pk = (net) => {
    const sol = solveNetwork({ ...net, sampleGround: ground });
    return packReaches([1, 2, 3].map((id) => ({ id, solved: sol.reaches.get(id) })), { worldSize: WORLD, maxHeight: MAXH });
  };
  const pA = pk(conf), pB = pk(moved);
  const opA = buildRiverV3TerrainOp({ packed: pA, size: SIZE, u: U });
  const opB = buildRiverV3TerrainOp({ packed: pB, size: SIZE, u: U });
  const dirty = networkDirtyRect(snapshotReaches(pA, opA.maxReach, "k"), snapshotReaches(pB, opB.maxReach, "k"), SIZE);
  const g = toGrid();
  const fP = new Float32Array(SIZE * SIZE), fF = new Float32Array(SIZE * SIZE);
  const LP = createHeightLayers({ final: fP, size: SIZE }), LF = createHeightLayers({ final: fF, size: SIZE });
  LP.reset(g); LF.reset(g);
  LP.setOperator("riverV3", opA); LF.setOperator("riverV3", opA);
  LP.setOperator("riverV3", opB, dirty); LF.setOperator("riverV3", opB);
  ok("network drag: partial recompose == full, bit for bit", fP.every((v, i) => v === fF[i]));
  const area = dirty ? (dirty.x1 - dirty.x0 + 1) * (dirty.z1 - dirty.z0 + 1) : SIZE * SIZE;
  const full = (opB.rect.x1 - opB.rect.x0 + 1) * (opB.rect.z1 - opB.rect.z0 + 1);
  ok("network drag: dirty area smaller than the whole network", !!dirty && area < full, `${area} vs ${full}`);
}

// ── 11. A tributary drawn from LOW ground does not drag the junction down ───
// (seen in the editor: the trunk dug a 34 m pit to meet it). The trunk sets
// the level; the low tributary is flagged uphill instead.
{
  const lowEast = (x, z) => (x > 60 ? 20 : 60 + z * 0.04);
  const net = {
    junctions: [{ id: 9, x: 0, z: 0, y: null }],
    reaches: [
      { id: 1, from: null, to: 9, nodes: [node(0, 200, { width: 12 }), node(0, 100, { width: 12 }), node(0, 0, { width: 12 })] },
      { id: 2, from: null, to: 9, nodes: [node(200, 150, { width: 6 }), node(100, 60, { width: 6 }), node(0, 0, { width: 6 })] },
      { id: 3, from: 9, to: null, nodes: [node(0, 0, { width: 13 }), node(0, -200, { width: 13 })] },
    ],
  };
  const sol = solveNetwork({ ...net, sampleGround: lowEast });
  const L = sol.junctions.get(9).level;
  ok("low tributary: junction stays at the trunk's level, not the tributary's", L > 50, `level ${L.toFixed(2)}`);
  ok("low tributary: it is flagged as climbing (red arrows)", sol.reaches.get(2).hasUphill);
}

// ── 10. One reach, no junction: v3's terrain == v2's, texel for texel ──────
{
  const { buildRiverTerrainOp } = await import("../v3/tools/riverV2Terrain.js");
  const sol = solveNetwork({ junctions: [], reaches: [conf.reaches[2]].map((r) => ({ ...r, from: null })), sampleGround: ground });
  const pk = packReaches([{ id: 3, solved: sol.reaches.get(3) }], { worldSize: WORLD, maxHeight: MAXH });
  const n = pk.u.length, R1 = 4096 * 4, pd = new Float32Array(4096 * 8);
  for (let j = 0; j < n; j++) {
    pd.set([pk.u[j], pk.v[j], pk.level[j], pk.halfW[j]], j * 4);
    pd.set([pk.depth[j], pk.bank[j], -1, 0], R1 + j * 4);
  }
  // v2 reads Float32 path data; give v3 the same rounded numbers.
  for (let j = 0; j < n; j++) {
    pk.u[j] = pd[j * 4]; pk.v[j] = pd[j * 4 + 1]; pk.level[j] = pd[j * 4 + 2]; pk.halfW[j] = pd[j * 4 + 3];
    pk.depth[j] = pd[R1 + j * 4]; pk.bank[j] = pd[R1 + j * 4 + 1];
  }
  const g = toGrid(), a = Float32Array.from(g), b = Float32Array.from(g);
  const full = { x0: 0, z0: 0, x1: SIZE - 1, z1: SIZE - 1 };
  buildRiverV3TerrainOp({ packed: pk, size: SIZE, u: U }).apply(a, g, full);
  buildRiverTerrainOp({ pathData: pd, rowStride: R1, layout: [{ offset: 0, count: n }], size: SIZE, u: U }).apply(b, g, full);
  let worst = 0;
  for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]) * MAXH);
  ok("single reach: v3 terrain == v2 terrain", worst < 1e-4, `worst ${worst.toFixed(5)} m`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
