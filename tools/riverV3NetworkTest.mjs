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
  const v3 = r3.speed[5], expect = r3.q / (r3.width[5] * r3.flowDepth[5]);
  const dN = Math.pow((r3.q * 0.04) / (r3.width[5] * Math.sqrt(Math.max(0.0006, r3.slope[5]))), 0.6);
  ok("confluence: trunk speed = Q / (w · flow depth)", Math.abs(v3 - Math.min(9, expect)) < 1e-4, `${v3} vs ${expect}`);
  ok("confluence: flow depth = Manning normal depth, capped by the channel",
    Math.abs(r3.flowDepth[5] - Math.min(r3.depth[5] * (1 - 0.55 / 3), Math.max(0.03, dN))) < 1e-4);
  let down = true;
  for (const s of [r1, r2, r3]) for (let i = 1; i < s.count; i++) if (s.level[i] > s.level[i - 1] + 1e-6) down = false;
  ok("confluence: every reach runs downhill through the junction", down);
  // Backwater: within the junction's reach of it, every surface IS the
  // junction level — so the surfaces meet at one height on the seam.
  const flatEnd = (s, fromEnd, m) => {
    let worst = 0;
    for (let i = 0; i < s.count; i++) {
      const d = fromEnd ? s.total - s.arc[i] : s.arc[i];
      if (d <= m) worst = Math.max(worst, Math.abs(s.level[i] - L));
    }
    return worst;
  };
  const Lb = 6 + 4 + 2;   // the two widest half widths at J (12 m, 8 m wide) + 2
  const wTrib = Math.max(flatEnd(r1, true, Lb), flatEnd(r2, true, Lb), flatEnd(r3, false, Lb));
  ok("confluence: backwater — every surface holds the junction level near it", wTrib < 1e-6, `worst ${wTrib}`);
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

// ── 12. An open mouth (waterfall lip) stops the reach dead ──────────────────
{
  const sol = solveNetwork({ junctions: [], reaches: [{ id: 1, from: null, to: null, nodes: [node(0, 200), node(0, 0), node(0, -150)] }], sampleGround: ground });
  const s = sol.reaches.get(1);
  const g = toGrid();
  const shut = Float32Array.from(g), open = Float32Array.from(g);
  const full = { x0: 0, z0: 0, x1: SIZE - 1, z1: SIZE - 1 };
  buildRiverV3TerrainOp({ packed: packReaches([{ id: 1, solved: s }], { worldSize: WORLD, maxHeight: MAXH }), size: SIZE, u: U }).apply(shut, g, full);
  buildRiverV3TerrainOp({ packed: packReaches([{ id: 1, solved: s, mouth: { x: 0, z: -50 } }], { worldSize: WORLD, maxHeight: MAXH }), size: SIZE, u: U }).apply(open, g, full);
  const at = (z) => Math.floor((z / WORLD + 0.5) * SIZE) * SIZE + Math.floor(0.5 * SIZE);
  ok("open mouth: past the lip is natural ground", open[at(-100)] === g[at(-100)] && shut[at(-100)] !== g[at(-100)]);
  ok("open mouth: before the lip the channel is unchanged", open[at(50)] === shut[at(50)]);
}

// ── 13. Operators CHAIN: a river carves the eroded ground it is handed ──────
// (the editor's erosion filter runs first). From bare GROUND the bank stepped
// back to un-eroded ground at the footprint edge.
{
  const g = toGrid();
  const offset = new Float32Array(SIZE * SIZE);
  for (let z = 0; z < SIZE; z++) for (let x = 0; x < SIZE; x++) offset[z * SIZE + x] = (2 + 1.5 * Math.sin(x * 0.11) * Math.cos(z * 0.07)) / MAXH;
  const erosion = {
    rect: { x0: 0, z0: 0, x1: SIZE - 1, z1: SIZE - 1 }, first: true,
    apply(out, _g, r) { for (let z = r.z0; z <= r.z1; z++) for (let x = r.x0; x <= r.x1; x++) out[z * SIZE + x] += offset[z * SIZE + x]; },
  };
  const final = new Float32Array(SIZE * SIZE);
  const L = createHeightLayers({ final, size: SIZE });
  L.reset(g);
  const sol = solveNetwork({ junctions: [], reaches: [{ id: 1, from: null, to: null, nodes: [node(0, 200), node(0, 0), node(0, -150)] }], sampleGround: ground });
  const op = buildRiverV3TerrainOp({ packed: packReaches([{ id: 1, solved: sol.reaches.get(1) }], { worldSize: WORLD, maxHeight: MAXH }), size: SIZE, u: U });
  L.setOperator("riverV3", op);
  L.setOperator("erosion", erosion);          // registered later, but `first`
  // Away from the river: ground + erosion.
  let farOk = true;
  for (let z = 0; z < SIZE; z++) for (let x = 0; x < SIZE; x++) {
    const i = z * SIZE + x;
    const inRect = x >= op.rect.x0 && x <= op.rect.x1 && z >= op.rect.z0 && z <= op.rect.z1;
    if (!inRect && Math.abs(final[i] - (g[i] + offset[i])) > 1e-7) farOk = false;
  }
  ok("chain: outside the river, FINAL = GROUND + erosion", farOk);
  // The exact property: erosion-then-river == the river carving a ground that
  // already holds the erosion. (Bare-GROUND naturals broke this at the bank.)
  const pre = Float32Array.from(g, (h, i) => h + offset[i]);
  const ref = Float32Array.from(pre);
  op.apply(ref, pre, { x0: 0, z0: 0, x1: SIZE - 1, z1: SIZE - 1 });
  let worst = 0;
  for (let i = 0; i < SIZE * SIZE; i++) worst = Math.max(worst, Math.abs(final[i] - ref[i]) * MAXH);
  ok("chain: erosion → river == river over the eroded ground, everywhere", worst < 1e-4, `worst ${worst.toFixed(4)} m`);
  // The probe sees GROUND + erosion under the river, not the carved channel.
  const tx = 128, tz = 128, u = tx / (SIZE - 1), v = tz / (SIZE - 1), i = tz * SIZE + tx;
  // underKey: moves when what is UNDER the river moves, not when the river does.
  const k0 = L.underKey("riverV3");
  L.setOperator("riverV3", op);
  const k1 = L.underKey("riverV3");
  erosion.version = 1;
  const k2 = L.underKey("riverV3");
  ok("underKey: the river's own re-conform leaves it alone; an erosion re-bake moves it", k0 === k1 && k2 !== k1, `${k0} ${k1} ${k2}`);
  ok("chain: sampleUnderNormalized('riverV3') = GROUND + erosion",
    Math.abs(L.sampleUnderNormalized("riverV3", u, v) - (g[i] + offset[i])) < 1e-6,
    `${L.sampleUnderNormalized("riverV3", u, v)} vs ${g[i] + offset[i]}`);
}

// ── 14. STEP-POOLS: a steep reach becomes pools and cascades ────────────────
{
  const steepGround = (x, z) => 80 + z * 0.12;            // 12 % down to −z
  const mk = (on) => solveNetwork({
    junctions: [], params: { stepPools: on },
    reaches: [{ id: 1, from: null, to: null, nodes: [node(0, 120), node(4, 40), node(-4, -40), node(0, -120)] }],
    sampleGround: steepGround,
  }).reaches.get(1);
  const s = mk(true), ramp = mk(false);
  let climbs = 0, flat = 0, casc = 0;
  for (let i = 1; i < s.count; i++) {
    if (s.level[i] > s.level[i - 1] + 1e-6) climbs++;
    if (Math.abs(s.level[i] - s.level[i - 1]) < 1e-6) flat++;
    if (s.cascade[i]) casc++;
  }
  ok("step-pools: never climbs", climbs === 0);
  ok("step-pools: mostly flat pools, some cascades", flat > s.count * 0.5 && casc > 3, `flat ${flat}/${s.count}, cascade ${casc}`);
  ok("step-pools: same total drop as the ramp (ends unchanged)",
    Math.abs(s.level[0] - ramp.level[0]) < 1e-4 && Math.abs(s.level[s.count - 1] - ramp.level[ramp.count - 1]) < 1e-4);
  let vPool = 0, nPool = 0, vCasc = 0, nCasc = 0;
  for (let i = 0; i < s.count; i++) { if (s.cascade[i]) { vCasc += s.speed[i]; nCasc++; } else { vPool += s.speed[i]; nPool++; } }
  ok("step-pools: cascades run faster than pools", vCasc / nCasc > 2 * (vPool / nPool), `${(vCasc / nCasc).toFixed(2)} vs ${(vPool / nPool).toFixed(2)} m/s`);
  // A gentle reach (1.5 %) is untouched.
  const gentle = (x, z) => 40 + z * 0.015;
  const g1 = solveNetwork({ junctions: [], params: { stepPools: true }, reaches: [{ id: 1, from: null, to: null, nodes: [node(0, 120), node(0, -120)] }], sampleGround: gentle }).reaches.get(1);
  const g0 = solveNetwork({ junctions: [], params: { stepPools: false }, reaches: [{ id: 1, from: null, to: null, nodes: [node(0, 120), node(0, -120)] }], sampleGround: gentle }).reaches.get(1);
  ok("step-pools: a gentle reach is untouched", g1.level.every((v, i) => v === g0.level[i]));
}

// ── 15. SMOOTHED carve: creases soften, nothing else changes ────────────────
{
  const US = { ...U, smooth: 2 };
  const g = toGrid();
  const full = { x0: 0, z0: 0, x1: SIZE - 1, z1: SIZE - 1 };
  const sol = solveNetwork({ ...conf, sampleGround: ground });
  const pk = packReaches([1, 2, 3].map((id) => ({ id, solved: sol.reaches.get(id) })), { worldSize: WORLD, maxHeight: MAXH });
  const exact = Float32Array.from(g), soft = Float32Array.from(g);
  buildRiverV3TerrainOp({ packed: pk, size: SIZE, u: U }).apply(exact, g, full);
  const opS = buildRiverV3TerrainOp({ packed: pk, size: SIZE, u: US });
  opS.apply(soft, g, full);
  const steepest = (h) => { let m = 0; for (let z = 1; z < SIZE; z++) for (let x = 1; x < SIZE; x++) { const i = z * SIZE + x; m = Math.max(m, Math.abs(h[i] - h[i - 1]), Math.abs(h[i] - h[i - SIZE])); } return m * MAXH; };
  const sE = steepest(exact), sS = steepest(soft);
  ok("smooth: the sharpest texel step drops by a third or more", sS < sE * 0.67, `${sS.toFixed(2)} vs ${sE.toFixed(2)} m`);
  let outside = 0;
  for (let i = 0; i < SIZE * SIZE; i++) {
    const x = i % SIZE, z = (i / SIZE) | 0;
    if ((x < opS.rect.x0 || x > opS.rect.x1 || z < opS.rect.z0 || z > opS.rect.z1) && soft[i] !== g[i]) outside++;
  }
  ok("smooth: nothing outside the (grown) footprint changes", outside === 0, `${outside}`);
  // Partial == full under smoothing (the dirty margin covers the spill).
  const moved = structuredClone(conf); moved.reaches[1].nodes[0].x += 20;
  const pk2 = (net) => { const so = solveNetwork({ ...net, sampleGround: ground }); return packReaches([1, 2, 3].map((id) => ({ id, solved: so.reaches.get(id) })), { worldSize: WORLD, maxHeight: MAXH }); };
  const pA = pk2(conf), pB = pk2(moved);
  const oA = buildRiverV3TerrainOp({ packed: pA, size: SIZE, u: US }), oB = buildRiverV3TerrainOp({ packed: pB, size: SIZE, u: US });
  const dirty = networkDirtyRect(snapshotReaches(pA, oA.maxReach, "s"), snapshotReaches(pB, oB.maxReach, "s"), SIZE);
  const fP = new Float32Array(SIZE * SIZE), fF = new Float32Array(SIZE * SIZE);
  const LP = createHeightLayers({ final: fP, size: SIZE }), LF = createHeightLayers({ final: fF, size: SIZE });
  LP.reset(g); LF.reset(g);
  LP.setOperator("riverV3", oA); LF.setOperator("riverV3", oA);
  LP.setOperator("riverV3", oB, dirty); LF.setOperator("riverV3", oB);
  let worst = 0; for (let i = 0; i < SIZE * SIZE; i++) worst = Math.max(worst, Math.abs(fP[i] - fF[i]));
  ok("smooth: partial recompose == full", worst * MAXH < 1e-4, `${(worst * MAXH).toFixed(5)} m`);
}

// ── 16. NOT STAIRS: irregular steps, shaped crests, plunge pools ────────────
{
  const steepGround = (x, z) => 80 + z * 0.12;
  const steepNet = { junctions: [], reaches: [{ id: 1, from: null, to: null, nodes: [node(0, 120), node(4, 40), node(-4, -40), node(0, -120)] }] };
  const mk = (params, net = steepNet) => solveNetwork({ ...net, params: { stepPools: true, ...params }, sampleGround: steepGround }).reaches.get(1);
  const s = mk({});
  const starts = [];
  for (let i = 1; i < s.count; i++) if (s.cascade[i] && !s.cascade[i - 1]) starts.push(s.arc[i]);
  const gaps = starts.slice(1).map((a, i) => a - starts[i]);
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const cv = Math.sqrt(gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length) / mean;
  ok("steps: spacing is irregular (not stairs)", gaps.length >= 3 && cv > 0.15, `cv ${cv.toFixed(2)} over ${gaps.length} gaps`);
  const again = mk({});
  ok("steps: deterministic (same network → same steps)", s.level.every((v, i) => v === again.level[i]));
  const flat0 = mk({ crestShape: 0 });
  ok("crest shape 0: every crest straight across", flat0.crA.every((v) => v === 0) && flat0.crN.every((v) => v === 0) && flat0.stepZone.some((v) => v === 1));
  ok("crest shape 1: crests are tilted / notched", s.crA.some((v) => v !== 0) && s.crN.some((v) => v > 0));
  const { crestShift } = await import("../v3/tools/riverV3/riverV3Network.js");
  ok("crest shift: square to both banks (tapered to 0 at |a| = 1)",
    crestShift(2, 1, 1.5, 0.9, 1) === 0 && crestShift(2, 1, 1.5, -0.9, -1) === 0 && crestShift(2, 1, 1.5, 0, 0.2) !== 0);
  ok("plunge pools: the bed is scoured below the drops", s.scour.some((v) => v > 0.2), `max ${Math.max(...s.scour).toFixed(2)} m`);
  // Partial recompose == full on a STEPPED reach (the dirty rect grows by the
  // crest shift: a texel reads stations up to maxShift along the reach).
  const US = { ...U, smooth: 2 };
  const g = new Float32Array(SIZE * SIZE);
  for (let z = 0; z < SIZE; z++) for (let x = 0; x < SIZE; x++) g[z * SIZE + x] = steepGround(((x + 0.5) / SIZE - 0.5) * WORLD, ((z + 0.5) / SIZE - 0.5) * WORLD) / MAXH;
  const moved = structuredClone(steepNet); moved.reaches[0].nodes[1].x += 6;
  const pk = (net) => packReaches([{ id: 1, solved: mk({}, net) }], { worldSize: WORLD, maxHeight: MAXH });
  const pA = pk(steepNet), pB = pk(moved);
  const oA = buildRiverV3TerrainOp({ packed: pA, size: SIZE, u: US }), oB = buildRiverV3TerrainOp({ packed: pB, size: SIZE, u: US });
  const dirty = networkDirtyRect(snapshotReaches(pA, oA.maxReach, "t"), snapshotReaches(pB, oB.maxReach, "t"), SIZE);
  const fP = new Float32Array(SIZE * SIZE), fF = new Float32Array(SIZE * SIZE);
  const LP = createHeightLayers({ final: fP, size: SIZE }), LF = createHeightLayers({ final: fF, size: SIZE });
  LP.reset(g); LF.reset(g);
  LP.setOperator("riverV3", oA); LF.setOperator("riverV3", oA);
  LP.setOperator("riverV3", oB, dirty); LF.setOperator("riverV3", oB);
  let worst = 0; for (let i = 0; i < SIZE * SIZE; i++) worst = Math.max(worst, Math.abs(fP[i] - fF[i]));
  ok("steps: partial recompose == full", worst * MAXH < 1e-4, `${(worst * MAXH).toFixed(5)} m`);
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
