/**
 * SPATIAL GRID (games/nam-rts/spatialGrid.js) and the unit code built on it.
 *
 * The grid replaced O(n²) loops in avoidance, separation and acquisition, and
 * it is only allowed to be a SPEED change. Its callers keep their own exact
 * distance tests, so the one property that has to hold is that a query never
 * misses anything inside its circle — checked here against brute force, at the
 * awkward places: cell edges, outside the filed box, a spread that forces the
 * cells to grow, an empty grid, items filed off-map.
 *
 * Then the units: a crowd driven through itself must come out the same on two
 * identical runs (the sim is deterministic — nothing may depend on how the
 * grid filed things), must not leave anyone overlapping, and the dead must not
 * be steered around.
 *
 *   node tools/spatialGridTest.mjs
 */
import { createSpatialGrid } from "../games/nam-rts/spatialGrid.js";
import { createUnits } from "../games/nam-rts/units.js";

let failed = 0;
const ok = (name, cond, extra = "") => {
  if (cond) console.log(`  ok   ${name}${extra ? "  " + extra : ""}`);
  else { failed++; console.log(`  FAIL ${name}${extra ? "  " + extra : ""}`); }
};

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

// ── The grid against brute force ─────────────────────────────────────────────
function supersetCheck(label, items, queries, cellSize = 4) {
  const g = createSpatialGrid({ cellSize });
  g.rebuild(items, () => true);
  const out = [];
  let missed = 0, dupes = 0, returned = 0, inside = 0;
  for (const [x, z, r] of queries) {
    g.query(x, z, r, out);
    const got = new Set(out);
    if (got.size !== out.length) dupes++;
    returned += out.length;
    for (const it of items) {
      const dx = it.position.x - x, dz = it.position.z - z;
      if (dx * dx + dz * dz <= r * r) { inside++; if (!got.has(it)) missed++; }
    }
  }
  ok(`${label}: no item inside a query circle is missed`, missed === 0, `${inside} inside, ${missed} missed`);
  ok(`${label}: no item is returned twice`, dupes === 0);
  return { returned, inside };
}

{
  const R = rng(1);
  const items = Array.from({ length: 2000 }, () => ({ position: { x: (R() - 0.5) * 300, z: (R() - 0.5) * 300 }, radius: 0.5 }));
  const qs = Array.from({ length: 400 }, () => [(R() - 0.5) * 360, (R() - 0.5) * 360, 0.5 + R() * 30]);
  const { returned, inside } = supersetCheck("random 2000", items, qs);
  ok("random 2000: the superset stays tight (not the whole list)", returned < inside * 6 && returned < 2000 * qs.length * 0.1,
    `${returned} returned for ${inside} inside`);

  // Exactly on cell boundaries, and circles grazing them.
  const edge = [];
  for (let i = -20; i <= 20; i++) for (let j = -20; j <= 20; j++) edge.push({ position: { x: i * 4, z: j * 4 }, radius: 0.5 });
  supersetCheck("cell-edge lattice", edge, [[0, 0, 4], [2, 2, 2.0001], [-4, 8, 8], [3.999, -4.001, 0.002]]);

  // Queries entirely outside the filed box, and straddling it.
  supersetCheck("outside the box", items, [[1000, 1000, 50], [-155, 0, 10], [0, 170, 25]]);

  // A spread wider than MAX_DIM × cellSize: the cells must grow, not clip.
  const wide = Array.from({ length: 500 }, () => ({ position: { x: (R() - 0.5) * 4000, z: (R() - 0.5) * 4000 }, radius: 1 }));
  supersetCheck("4 km spread (cells grow)", wide, Array.from({ length: 200 }, () => [(R() - 0.5) * 4000, (R() - 0.5) * 4000, 5 + R() * 200]));

  const g = createSpatialGrid();
  g.rebuild([], () => true);
  ok("empty grid answers nothing", g.query(0, 0, 100, []).length === 0);
  g.rebuild(items, (it, i) => i % 2 === 0);
  ok("accept() filters what is filed", g.count === 1000);
  ok("maxRadius tracks the largest radius", createSpatialGrid().maxRadius === 0 && g.maxRadius === 0.5);
}

// ── Units on the grid ────────────────────────────────────────────────────────
const fakeApp = {
  worldSize: 1024,
  getWorldHeight: (x, z) => Math.sin(x * 0.02) * 2 + Math.cos(z * 0.015) * 2,
};

function crowdRun(ticks) {
  const R = rng(777);
  const saved = Math.random;
  Math.random = R;
  try {
    const units = createUnits({ app: fakeApp, navGrid: null, spawn: { soldier: 160, jeep: 12, helicopter: 4 }, origin: { x: 0, z: 0 } });
    units.list.forEach((u, i) => { if (!u.isAir) u.moveOrder?.((i % 2 ? 1 : -1) * 30, (i % 7) * 3 - 10); });
    for (let t = 0; t < ticks; t++) units.update(1 / 60);
    return units;
  } finally {
    Math.random = saved;
  }
}

{
  const a = crowdRun(400), b = crowdRun(400);
  let maxD = 0;
  a.list.forEach((u, i) => { maxD = Math.max(maxD, Math.hypot(u.position.x - b.list[i].position.x, u.position.z - b.list[i].position.z)); });
  ok("a crowd driven through itself is deterministic", maxD === 0, `max difference ${maxD} m`);

  // Separation is a last-resort fix and this is a deliberate crush (everyone
  // ordered onto two points), so squeeze is expected: the all-pairs code this
  // replaced left the same 49% here, bit for bit. What a broken grid does —
  // missing neighbours — is leave units standing INSIDE each other (~100%).
  let worst = 0;
  const L = a.list.filter((u) => u.alive && !u.isAir);
  for (let i = 0; i < L.length; i++) {
    for (let j = i + 1; j < L.length; j++) {
      const d = Math.hypot(L[i].position.x - L[j].position.x, L[i].position.z - L[j].position.z);
      const overlap = (L[i].radius + L[j].radius - d) / (L[i].radius + L[j].radius);
      if (overlap > worst) worst = overlap;
    }
  }
  ok("after the crush, no two ground units stand inside each other", worst < 0.75, `worst ${(worst * 100).toFixed(0)}%`);
}

{
  // A dead unit stays in units.list; nobody may steer around it.
  const saved = Math.random;
  Math.random = rng(5);
  try {
    const units = createUnits({ app: fakeApp, navGrid: null, spawn: { soldier: 2 }, origin: { x: 0, z: 0 } });
    const [walker, corpse] = units.list;
    walker.position.set(0, 0, 0);
    corpse.position.set(0, 0, 3);
    corpse.alive = false;
    walker.moveOrder?.(0, 12);
    for (let t = 0; t < 240; t++) units.update(1 / 60);
    ok("the dead are not steered around", walker.position.z > 3 && Math.abs(walker.position.x) < 1e-6,
      `walker at z ${walker.position.z.toFixed(2)}, drifted ${walker.position.x.toFixed(3)} m sideways`);
    const near = units.near(0, 3, 5, []);
    ok("near() never returns the dead", !near.includes(corpse));
  } finally {
    Math.random = saved;
  }
}

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
