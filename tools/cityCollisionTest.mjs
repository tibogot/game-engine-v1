// City collision — the buildings you must not drive through.
//
// What this guards, in order of how expensive the bug would be:
//
//  1. A query INSIDE a tower must report a hit with the normal pointing OUT.
//     Get that backwards and the chassis is sucked in rather than pushed off.
//  2. The Y-SCALE. A building is its archetype scaled in Y only, so local
//     space is stretched vertically: a local distance is not a world distance
//     and a local normal is not a world normal. Both are converted here, and
//     both are easy to get subtly wrong in a way that only shows as "the car
//     sticks to tall buildings".
//  3. It must be CHEAP to rebuild. The corridor restamp changes the building
//     set on every track edit; if that rebuilt a tree the editor would hitch.
//  4. Empty ground must return null, or the car collides with the sky.
import { register } from "node:module";

register("./threeWebgpuHook.mjs", import.meta.url);
const THREE = await import("three/webgpu");
const { buildCityKit } = await import("../games/modular-road-v3/modularRoadCityKit.js");
const { createModularRoadCity, CITY_DEFAULTS } = await import("../games/modular-road-v3/modularRoadCity.js");
const { createCityCollider } = await import("../games/modular-road-v3/modularRoadCityCollider.js");

let fail = 0;
const check = (n, c, d = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`);
  if (!c) fail++;
};

const avoid = (x) => Math.abs(x);
const city = createModularRoadCity({ seed: 20260902, avoid });
const kit = city.kit;
const col = city.getCollider();
const N = new THREE.Vector3();

console.log("\n── BUILD ──");
console.log(
  `  ${col.stats.archetypes} archetype trees · ${col.stats.tris} tris total · ` +
  `${col.stats.buildMs.toFixed(1)} ms · ${col.stats.buildings} buildings`,
);
check("one tree per archetype, not per building",
  col.stats.archetypes === kit.archetypes.length && col.stats.archetypes < 40);
// The whole point of the design: a merged city tree would be ~54k triangles.
// The ceiling was 4000 when an archetype's L0 was ~150 triangles; the roofline
// pass (coping, finials, stepped crowns, hipped roofs) took it to ~280, and a
// car landing on a roof SHOULD meet those, so the collider keeps baking L0.
// Still an order of magnitude under city-sized.
check("the trees are archetype-sized, not city-sized", col.stats.tris < 9000, `${col.stats.tris} tris`);
check("the build is fast enough to be invisible", col.stats.buildMs < 60, `${col.stats.buildMs.toFixed(1)} ms`);
check("the collider is live", col.baked === true);

console.log("\n── QUERIES ──");
// A tall tower away from the corridor, so the test is not at the mercy of the
// keep-out cull.
const b = city.buildings
  .filter((x) => x.top - x.y > 70)
  .sort((p, q) => Math.hypot(p.x, p.z) - Math.hypot(q.x, q.z))[0];
const a = kit.archetypes[b.arch];
const midY = b.y + (b.top - b.y) * 0.4;
console.log(`  probe tower: ${a.width.toFixed(1)} x ${a.depth.toFixed(1)} m, ` +
  `${(b.top - b.y).toFixed(0)} m tall, scaleY ${b.scaleY.toFixed(2)}`);

// ── 1. Just outside a wall: a hit, pointing back at the query point ─────────
{
  const px = b.x + a.width / 2 + 1.0;
  const r = col.closestPointWithNormal(px, midY, b.z, 3, N);
  check("a point just outside a wall finds it", !!r && r.distance < 3, r ? `${r.distance.toFixed(2)} m` : "no hit");
  check("the outward normal points away from the wall", !!r && N.x > 0.7, r ? `n.x = ${N.x.toFixed(2)}` : "");
}

// ── 2. INSIDE the tower: still a hit, and the normal must push OUT ──────────
{
  const r = col.closestPointWithNormal(b.x, midY, b.z, 40, N);
  check("a point inside a tower reports a hit", !!r, r ? `${r.distance.toFixed(1)} m to the nearest wall` : "no hit");
  // `behind` means the face was pointing away from the query — the collider
  // flips the normal so it always shoves the chassis toward open air.
  const dot = r ? (b.x - r.x) * N.x + (midY - r.y) * N.y + (b.z - r.z) * N.z : -1;
  check("the normal is oriented toward the inside point (pushes the car out)", dot > 0, `dot = ${dot.toFixed(2)}`);
}

// ── 3. Empty ground: nothing ───────────────────────────────────────────────
{
  // A street cell: columns where cx % 5 === 4 are never built on.
  const L = CITY_DEFAULTS.lotSize;
  const emptyX = (4 + 0.5) * L, emptyZ = (4 + 0.5) * L;
  const r = col.closestPointWithNormal(emptyX, 2, emptyZ, 4, N);
  check("open street returns no hit", r === null);
  const far = col.closestPointWithNormal(0, 4000, 0, 5, N);
  check("high above the city returns no hit", far === null);
}

// The TRUE top and half-width of a placed building, from its archetype's own
// geometry. `b.top` is the MASSING top and is not the highest point: masts and
// water tanks stand above it, and a tower with setbacks is narrower up there
// than `a.width` says. Measuring against either is how a correct collider gets
// called broken.
function geomBox(bld) {
  const g = kit.archetypes[bld.arch].lods[0];
  if (!g.boundingBox) g.computeBoundingBox();
  return g.boundingBox;
}
const topOf = (bld) => bld.y + geomBox(bld).max.y * bld.scaleY;

// ── 4. The Y scale ─────────────────────────────────────────────────────────
{
  // Straight down onto the highest point of the geometry, from a known height.
  const r = col.closestPointWithNormal(b.x, topOf(b) + 2.0, b.z, 6, N);
  const ok = !!r && Math.abs(r.distance - 2.0) < 1.2;
  check("distance above the top is measured in WORLD units, not stretched ones",
    ok, r ? `${r.distance.toFixed(2)} m for a 2.0 m gap` : "no hit");
}

// ── 4b. The Y scale, on a building that is ACTUALLY stretched ──────────────
// The probe tower above can legitimately come out at scaleY 1.00, which
// exercises none of the conversion. Pick the most-stretched building in the
// city and repeat the two measurements that the scale can corrupt.
{
  const sc = city.buildings
    .filter((x) => x.top - x.y > 40)
    .sort((p, q) => Math.abs(q.scaleY - 1) - Math.abs(p.scaleY - 1))[0];
  const sa = kit.archetypes[sc.arch];
  console.log(`  stretched tower: scaleY ${sc.scaleY.toFixed(3)}, ${(sc.top - sc.y).toFixed(0)} m tall`);
  check("the test actually found a stretched building", Math.abs(sc.scaleY - 1) > 0.05, `scaleY ${sc.scaleY.toFixed(3)}`);

  // Sideways, AT THE BASE — above the first setback the tower is narrower than
  // its footprint. X is never scaled, so this distance must be exact whatever
  // Y does; a mishandled scale would not move it, which is the point.
  const bx = geomBox(sc);
  const side = col.closestPointWithNormal(sc.x + bx.max.x + 1.5, sc.y + 2.0, sc.z, 4, N);
  check("a stretched tower's WALL is still at its true distance",
    !!side && Math.abs(side.distance - 1.5) < 0.35, side ? `${side.distance.toFixed(2)} m for a 1.5 m gap` : "no hit");
  check("that wall's normal points out along +X", !!side && N.x > 0.7, side ? `n.x=${N.x.toFixed(2)}` : "");

  // Vertically: this is the one the scale corrupts if the conversion is wrong.
  const top = topOf(sc);
  const over = col.closestPointWithNormal(sc.x, top + 3.0, sc.z, 8, N);
  check("a stretched tower's TOP is at its true distance",
    !!over && Math.abs(over.distance - 3.0) < 1.0, over ? `${over.distance.toFixed(2)} m for a 3.0 m gap` : "no hit");
  check("the normal there is still unit-length", !!over && Math.abs(N.length() - 1) < 1e-3, `|n|=${N.length().toFixed(4)}`);

  // And the ray, whose direction takes the same inverse scale.
  const rh = col.raycastFirst(
    new THREE.Vector3(sc.x, top + 30, sc.z), new THREE.Vector3(0, -1, 0), 60);
  check("a ray down onto a stretched tower reports the world distance",
    !!rh && Math.abs(rh.distance - 30) < 2.0, rh ? `${rh.distance.toFixed(1)} m (expected ~30)` : "no hit");
}

// ── 5. Raycast ─────────────────────────────────────────────────────────────
{
  const from = new THREE.Vector3(b.x + a.width / 2 + 25, midY, b.z);
  const dir = new THREE.Vector3(-1, 0, 0);
  const h = col.raycastFirst(from, dir, 60);
  check("a ray fired at a tower hits its near face", !!h && Math.abs(h.distance - 25) < 3,
    h ? `${h.distance.toFixed(1)} m (expected ~25)` : "no hit");
  const miss = col.raycastFirst(new THREE.Vector3(b.x, b.top + 200, b.z), new THREE.Vector3(0, 1, 0), 100);
  check("a ray into the sky hits nothing", miss === null);
}

// ── 6. Rebuild cost — the reason this design exists ────────────────────────
console.log("\n── REBUILD ──");
{
  const t0 = performance.now();
  for (let i = 0; i < 20; i++) col.setBuildings(city.buildings);
  const per = (performance.now() - t0) / 20;
  check("a layout change is a map refill, not a rebuild", per < 5, `${per.toFixed(2)} ms per restamp`);
}

// ── 7. Query cost ──────────────────────────────────────────────────────────
{
  const pts = [];
  for (let i = 0; i < 500; i++) {
    const bb = city.buildings[(i * 7919) % city.buildings.length];
    pts.push([bb.x + 4, bb.y + 15, bb.z + 4]);
  }
  const ITER = 40;
  const t0 = performance.now();
  let hits = 0;
  for (let k = 0; k < ITER; k++) {
    for (const [x, y, z] of pts) if (col.closestPointWithNormal(x, y, z, 3, N)) hits++;
  }
  const us = ((performance.now() - t0) * 1000) / (ITER * pts.length);
  check("a closest-point query is microseconds", us < 20, `${us.toFixed(2)} µs each (${hits} hits)`);
  console.log(`       a physics tick doing 8 probes ≈ ${(us * 8 / 1000).toFixed(4)} ms`);
}

// ── 8. The street floor ────────────────────────────────────────────────────
console.log("\n── STREET ──");
{
  // Flat ground only: with terrain on, the terrain IS the ground.
  check("the street is a finite floor inside the city", isFinite(city.streetHeightAt(0, 0)));
  check("the street floor is at groundY", city.streetHeightAt(120, -80) === CITY_DEFAULTS.groundY);
  check("there is no floor beyond the plane", !isFinite(city.streetHeightAt(99999, 0)));
  const noGround = createModularRoadCity({ seed: 20260902, avoid, params: { ground: false } });
  check("no street plane, no floor", !isFinite(noGround.streetHeightAt(0, 0)));
  noGround.dispose();
}

city.dispose();
console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILURE(S)`);
process.exit(fail === 0 ? 0 : 1);
