// ROUND TOWERS — the one silhouette a kit of boxes cannot make.
//
// A round tower reserves a CORNER lot before the lot loop, like a gate, and
// brings its own geometry, material and collider, so the facade, the archetype
// collider, the roof clutter and the adverts never meet a curve. Every claim is
// measured against the real city build:
//
//   PLACEMENT   a corner lot, clear of plazas, gates, the viaduct and the
//               underpass, outside the landmark core; its lot is not also built
//   STABILITY   density and the track corridor may remove a tower, never move
//               one or reshuffle anything else
//   SOLID       the podium stops the car at its radius; one collider for all
//   ONE DRAW    every round tower in the city in one mesh, one material
//   SEAM        a whole number of mullion bays round each drum, so atan2's jump
//               lands on a mullion
//   SHADER      the material generates WGSL without leaking undefined/NaN
//
// Run: node tools/cityRoundTowerTest.mjs
import { buildWGSL, THREE } from "./wgslBuilderStub.mjs";

const { createModularRoadCity } = await import("../games/modular-road-v3/modularRoadCity.js");
const RT = await import("../games/modular-road-v3/modularRoadCityRoundTower.js");
const { MeshBVH } = await import("three-mesh-bvh");

let fail = 0;
const check = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); if (!c) fail++; };

const SEED = 20260902;
const build = (params = {}, extra = {}) => createModularRoadCity({
  seed: SEED, params: { furnitureParams: { treeSource: "procedural" }, ...params }, ...extra,
});
let surfaces = null;
const city = build({}, { onRebuilt: (s) => { surfaces = s; } });
const P = city.params;
const towers = city.stats.roundTowerList;
const T = RT.ROUND_TOWER_DEFAULTS;
const pitch = P.blockLots + P.streetLots;
const pmod = (a, n) => ((a % n) + n) % n;
const oX = Math.floor(P.centerX / P.lotSize), oZ = Math.floor(P.centerZ / P.lotSize);

console.log("\n═══ ROUND TOWERS ═══\n");

console.log("=== PLACEMENT ===");
{
  check("the default city has round towers", towers.length >= 2, `${towers.length}`);
  check("...in both styles", new Set(towers.map((t) => t.style)).size === 2, towers.map((t) => t.style).join(","));
  let notCorner = 0, offCentre = 0, inCore = 0;
  for (const t of towers) {
    const ix = pmod(t.cx - oX, pitch), iz = pmod(t.cz - oZ, pitch);
    const edge = (i) => i === 0 || i === P.blockLots - 1;
    if (!edge(ix) || !edge(iz)) notCorner++;
    if (Math.abs(t.x - (t.cx + 0.5) * P.lotSize) > 1e-6 || Math.abs(t.z - (t.cz + 0.5) * P.lotSize) > 1e-6) offCentre++;
    if (Math.hypot(t.x - P.centerX, t.z - P.centerZ) < T.minRadiusFromCentre) inCore++;
  }
  check("every round tower stands on a corner lot", notCorner === 0, `${notCorner} not on a corner`);
  check("...centred on its lot cell", offCentre === 0);
  check("...and out of the landmark core", inCore === 0);
  check("its drum fits its lot, podium included",
    towers.every((t) => t.radius + T.podiumGrow < P.lotSize / 2),
    `largest ${Math.max(...towers.map((t) => t.radius + T.podiumGrow)).toFixed(1)} m of ${P.lotSize / 2}`);

  const built = new Set(city.buildings.map((b) => `${b.cx},${b.cz}`));
  check("no box tower is also built on a round tower's lot", towers.every((t) => !built.has(t.cell)));
  check("the replaced lots are counted", city.stats.culledRound === towers.length, `${city.stats.culledRound}`);
  const gateCells = new Set(city.stats.gateList.flatMap((g) => g.cells));
  check("a round tower never takes a gate's lot", towers.every((t) => !gateCells.has(t.cell)));

  // No neighbouring box tower's footprint reaches into the drum.
  const kit = city.kit.archetypes;
  let intrude = 0;
  for (const b of city.buildings) {
    const a = kit[b.arch];
    for (const t of towers) {
      const dx = Math.max(Math.abs(b.x - t.x) - a.width / 2, 0), dz = Math.max(Math.abs(b.z - t.z) - a.depth / 2, 0);
      if (Math.hypot(dx, dz) < t.radius + T.podiumGrow) intrude++;
    }
  }
  check("no box tower reaches into a drum", intrude === 0, `${intrude}`);
}

console.log("\n=== STABILITY ===");
{
  const key = (t) => `${t.cell},${t.style},${t.radius.toFixed(4)}`;
  const base = new Set(towers.map(key));
  const sparse = build({ density: 0.5 });
  const same = sparse.stats.roundTowerList.map(key);
  check("a lower density keeps exactly the same round towers", same.length === base.size && same.every((k) => base.has(k)));
  sparse.dispose?.();

  if (towers.length) {
    const t = towers[0];
    const avoid = (x, z) => Math.hypot(x - t.x, z - t.z);
    const edited = build({}, { avoid });
    const after = edited.stats.roundTowerList.map(key);
    check("a track through a round tower removes it", !after.includes(key(t)));
    check("...and never adds or moves another", after.every((k) => base.has(k)));
    const builtBefore = new Set(city.buildings.map((b) => `${b.cx},${b.cz},${b.arch}`));
    let grown = 0;
    for (const b of edited.buildings) if (!builtBefore.has(`${b.cx},${b.cz},${b.arch}`)) grown++;
    check("...and no box tower grows on its empty lot, or anywhere", grown === 0, `${grown}`);
    edited.dispose?.();
  }
}

console.log("\n=== SOLID, AND CLEAR AROUND IT ===");
{
  const cols = city.roadCollision().solids.filter((m) => m.name === "CityRoundTowerCollision");
  check("one collider for every round tower in the city", cols.length === 1, `${cols.length}`);
  if (cols[0]) {
    const bvh = new MeshBVH(cols[0].geometry);
    let off = 0, worst = 0;
    for (const t of towers) {
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2 + 0.13;
        const dir = new THREE.Vector3(-Math.cos(a), 0, -Math.sin(a));
        const o = new THREE.Vector3(t.x + Math.cos(a) * 40, P.groundY + 1.2, t.z + Math.sin(a) * 40);
        const h = bvh.raycastFirst(new THREE.Ray(o, dir), THREE.DoubleSide);
        const r = h ? Math.hypot(h.point.x - t.x, h.point.z - t.z) : Infinity;
        // A 20-sided collider is inside the true circle by at most R(1-cos(π/20)).
        const tol = (t.radius + T.podiumGrow) * (1 - Math.cos(Math.PI / 20)) + 1e-3;
        const err = Math.abs(r - (t.radius + T.podiumGrow));
        worst = Math.max(worst, err);
        if (err > tol) off++;
      }
    }
    check("a car driving at a podium meets it at the drum's radius", off === 0, `worst ${worst.toFixed(3)} m`);
  }
  let caps = 0;
  for (const t of towers) {
    for (const c of city.obstacleCapsulesNear(t.x, t.z, 60)) {
      const x = c.a?.x ?? c.x, z = c.a?.z ?? c.z;
      if (Math.hypot(x - t.x, z - t.z) < t.radius + T.podiumGrow) caps++;
    }
  }
  check("no lamp, light, tree or car stands inside a drum", caps === 0, `${caps}`);
}

console.log("\n=== ONE DRAW, ONE MATERIAL, NO SEAM ===");
{
  const meshes = [];
  city.group.traverse((o) => { if (o.name === "CityRoundTowers") meshes.push(o); });
  check("every round tower in the city is one draw", meshes.length === 1 && city.stats.roundTowerMesh?.draws === 1);
  check("it casts shadows", meshes[0]?.castShadow === true);
  check("the rain collider is told about it", !!meshes[0] && surfaces?.includes(meshes[0]));

  const { geometry } = RT.buildRoundTowerGeometry({ towers, params: T });
  const tw = geometry.getAttribute("aTower");
  let bad = 0;
  const seen = new Set();
  for (let i = 0; i < tw.count; i++) {
    const r = tw.getX(i), p = tw.getY(i);
    const k = `${r.toFixed(5)}|${p.toFixed(5)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const bays = (Math.PI * 2 * r) / p;
    if (Math.abs(bays - Math.round(bays)) > 1e-3) bad++;
  }
  check("a whole number of mullion bays goes round every drum", bad === 0, `${bad} of ${seen.size} drums`);
  geometry.computeBoundingBox();
  check("every drum stands on the street", Math.abs(geometry.boundingBox.min.y - P.groundY) < 1e-6);
  geometry.dispose();
}

console.log("\n=== ON TERRAIN, A DRUM STANDS ON THE GROUND ===");
{
  // Round towers are buildings, so unlike the gates they also exist with
  // terrain on — and must sit on it the way a box tower does: base at the lowest
  // corner minus the sink. A gentle slope keeps every lot under `slopeLimit`.
  const heightAt = (x, z) => 3 + x * 0.002 + z * 0.001;
  const hilly = build({ ground: false }, { heightAt });
  const list = hilly.stats.roundTowerList;
  check("round towers are still built with terrain on", list.length > 0, `${list.length}`);
  let wrong = 0;
  for (const tw of list) {
    const f = tw.radius + T.podiumGrow;
    const lo = Math.min(heightAt(tw.x, tw.z), heightAt(tw.x - f, tw.z - f), heightAt(tw.x + f, tw.z - f),
      heightAt(tw.x - f, tw.z + f), heightAt(tw.x + f, tw.z + f));
    if (Math.abs(tw.y - (lo - P.sinkBias)) > 1e-6) wrong++;
  }
  check("...each based at its lowest corner minus the sink, like a box tower", wrong === 0, `${wrong} of ${list.length}`);
  hilly.dispose?.();
}

console.log("\n=== SHADER ===");
{
  const { material } = RT.makeRoundTowerMaterial({});
  let b = null, err = null;
  try { b = buildWGSL(material); } catch (e) { err = e; }
  check("the round tower material generates WGSL", err === null, err ? err.message : "");
  if (b) {
    const frag = b.fragmentShader || "";
    check("no 'undefined' leaked into it", !/undefined/.test(frag));
    check("and no NaN literals", !/NaN/.test(frag));
    check("small: one drum shader, not a second facade", frag.length < 40 * 1024, `${(frag.length / 1024).toFixed(1)} kB`);
  }
}

console.log(`\n${fail === 0 ? "ALL PASS" : `${fail} FAILED`}`);
process.exit(fail === 0 ? 0 : 1);
