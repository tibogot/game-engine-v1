// ============================================================================
// ROOFTOPS — is the clutter actually ON the roofs?
//
// Everything here is placed from numbers the eye cannot check: a deck height
// that depends on a per-instance Y-scale, a footprint that shrinks at every
// setback, a penthouse in the middle to keep out of. Get any of them wrong and
// the result is plant floating over a tower, or buried in it, or growing
// through the crown — and from a sky track, at speed, all three look the same.
//
// So this checks the placements against the archetypes they were derived from.
// ============================================================================
import { register } from "node:module";

register("./threeWebgpuHook.mjs", import.meta.url);
const THREE = await import("three/webgpu");
const { buildCityKit } = await import("../games/modular-road-v3/modularRoadCityKit.js");
const { createCityRoofs } = await import("../games/modular-road-v3/modularRoadCityRoofs.js");
const { createModularRoadCity, CITY_DEFAULTS } = await import("../games/modular-road-v3/modularRoadCity.js");

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) { pass++; console.log(`PASS  ${name}${extra ? `  — ${extra}` : ""}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? `  — ${extra}` : ""}`); }
};

// ── The archetype has to describe its own top deck ──────────────────────────
const kit = buildCityKit({ seed: 20260902 });
let withRoof = 0, badRoof = 0;
for (const a of kit.archetypes) {
  if (!a.roof) { badRoof++; continue; }
  withRoof++;
  // The deck cannot be above the massing top, and cannot be wider than the base.
  if (!(a.roof.y > 0 && a.roof.y <= a.massHeight + 0.01)) badRoof++;
  else if (!(a.roof.w > 0 && a.roof.w <= a.width + 0.01)) badRoof++;
  else if (!(a.roof.d > 0 && a.roof.d <= a.depth + 0.01)) badRoof++;
}
check("every archetype describes its top deck", badRoof === 0 && withRoof === kit.archetypes.length,
  `${withRoof} of ${kit.archetypes.length}, ${badRoof} bad`);

// Setbacks mean the top deck is usually NARROWER than the footprint. If it
// never is, `roof` is reporting the base and the clutter will hang off edges.
const narrower = kit.archetypes.filter((a) => a.roof.w < a.width - 0.5).length;
check("setback towers report a narrower top deck than their base",
  narrower > 0, `${narrower} of ${kit.archetypes.length} are narrower`);

// The parapet has to be IN the geometry, or the deck is still a bare plate.
// It shows up as geometry above the top tier but inside its footprint.
{
  const g = kit.archetypes[0].lods[0];
  const pos = g.getAttribute("position");
  const a = kit.archetypes[0];
  let atRim = 0;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i), x = pos.getX(i), z = pos.getZ(i);
    if (y <= a.roof.y + 0.01 || y > a.roof.y + 1.2) continue;
    const onRim = Math.abs(Math.abs(x) - a.roof.w / 2) < 0.35 || Math.abs(Math.abs(z) - a.roof.d / 2) < 0.35;
    if (onRim) atRim++;
  }
  check("a parapet stands on the rim of the top deck", atRim > 0, `${atRim} vertices on the rim`);
}

// ── The placements ──────────────────────────────────────────────────────────
const city = createModularRoadCity({ params: { extent: 500 } });
const stats = city.stats.roofs;
check("roofs were built with the city", !!stats, JSON.stringify(stats));
check("something actually got placed", stats.total > 20, `${stats.total} items`);
check("every kind is represented",
  stats.plant > 0 && stats.tanks > 0 && stats.stacks > 0 && stats.dishes > 0,
  `plant ${stats.plant}, tanks ${stats.tanks}, stacks ${stats.stacks}, dishes ${stats.dishes}`);

// Now the thing that matters: is each item standing ON the deck of the
// building under it, and inside its parapet?
const byXZ = new Map();
for (const b of city.buildings) byXZ.set(`${b.cx},${b.cz}`, b);
const lot = CITY_DEFAULTS.lotSize;

let checked = 0, wrongY = 0, outside = 0, inCrown = 0, worstY = 0;
const _p = new THREE.Vector3();
city.group.traverse((o) => {
  if (!o.isInstancedMesh || !/^CityRoof/.test(o.name)) return;
  const m = new THREE.Matrix4();
  for (let i = 0; i < o.count || i < o.instanceMatrix.count; i++) {
    if (i >= o.instanceMatrix.count) break;
    o.getMatrixAt(i, m);
    _p.setFromMatrixPosition(m);
    const b = byXZ.get(`${Math.floor(_p.x / lot)},${Math.floor(_p.z / lot)}`);
    if (!b) continue;                        // straddles a cell edge; skip
    const a = city.kit.archetypes[b.arch];
    checked++;
    // Height: the deck is the local roof height times the instance's Y scale.
    const deckY = b.y + a.roof.y * b.scaleY;
    const dy = Math.abs(_p.y - deckY);
    worstY = Math.max(worstY, dy);
    if (dy > 0.1) wrongY++;
    // Inside the parapet.
    const lx = _p.x - b.x, lz = _p.z - b.z;
    if (Math.abs(lx) > a.roof.w / 2 || Math.abs(lz) > a.roof.d / 2) outside++;
    // Not growing through the mechanical penthouse.
    if (a.roof.crownW > 0
      && Math.abs(lx) < a.roof.crownW / 2 && Math.abs(lz) < a.roof.crownD / 2) inCrown++;
  }
});
check("items were matched to their buildings", checked > 20, `${checked} matched`);
check("every item stands exactly on its deck", wrongY === 0,
  `${wrongY} off; worst ${worstY.toFixed(3)} m`);
check("nothing hangs over the parapet", outside === 0, `${outside} outside`);
check("nothing grows through the penthouse", inCrown === 0, `${inCrown} inside the crown`);

// ── The distance cull ───────────────────────────────────────────────────────
const meshes = [];
city.group.traverse((o) => { if (o.isInstancedMesh && /^CityRoof/.test(o.name)) meshes.push(o); });
// dt of 5 s, because the LOD pass is throttled to lodInterval (0.2 s) AND to
// how far the camera has moved — two 16 ms ticks from the same spot run it
// once and the second measurement would just be the first one again.
const roofParams = city.roofs;
const eye = { position: new THREE.Vector3(0, 400, 0) };
// THREE ticks per measurement, not one: the LOD consumers take turns (see the
// round-robin in city.update), so a single tick is not guaranteed to be the
// roofs' turn. Pumping three guarantees exactly one roof pass.
const pump = () => { for (let i = 0; i < 3; i++) { eye.position.y += 1; city.update(5, eye); } };
roofParams.range = 200;
pump();
const near = meshes.reduce((a, m) => a + m.count, 0);
roofParams.range = 1e6;
pump();
const all = meshes.reduce((a, m) => a + m.count, 0);
check("the distance cull actually cuts", near < all, `${near} drawn at 200 m vs ${all} at ∞`);

// And it is FOUR-ish draws for the whole city, not one per roof.
check("the whole city's roof clutter is a handful of draws",
  meshes.length <= 5, `${meshes.length} instanced meshes`);

console.log(`\n${fail === 0 ? "ALL PASS" : `${fail} FAILURE(S)`}  (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
