// ============================================================================
// CITY CULLING — frustum per instance, lamps in range, towers front to back.
//
// Three behaviours, each with a specific failure this file exists to catch:
//
//   FRUSTUM   towers behind the camera stop being submitted — but NEVER the
//             L0 tier, which casts shadows into the frame from outside it.
//   LAMPS     the 4262 posts had no cull at all; now they range and frustum.
//   ORDER     within a tier mesh, nearer buildings come first, so early-Z
//             rejects hidden facade fragments before the shader runs.
//
// And the one that would break the tests: a camera with no projection matrix
// (the other suites hand in `{ position }`) must still work, range-only.
// ============================================================================
import { register } from "node:module";

register("./threeWebgpuHook.mjs", import.meta.url);
const THREE = await import("three/webgpu");
const { createModularRoadCity } = await import("../games/modular-road-v3/modularRoadCity.js");

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) { pass++; console.log(`PASS  ${name}${extra ? `  — ${extra}` : ""}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? `  — ${extra}` : ""}`); }
};

const city = createModularRoadCity({ params: { extent: 700 } });
const meshes = { towers: [], lamps: null, furn: new Map(), roofs: [] };
city.group.traverse((o) => {
  if (!o.isInstancedMesh) return;
  if (/^CityInst_/.test(o.name)) meshes.towers.push(o);
  else if (o.name === "CityLamps") meshes.lamps = o;
  else if (/^CityRoof/.test(o.name)) meshes.roofs.push(o);
  else meshes.furn.set(o.name, o);
});
const tierOf = (m) => Number(m.name.match(/_l(\d)$/)[1]);
const tierCount = (t) => meshes.towers.filter((m) => tierOf(m) === t).reduce((a, m) => a + m.count, 0);
const furnCount = (n) => meshes.furn.get(n)?.count ?? 0;
const roofCount = () => meshes.roofs.reduce((a, m) => a + m.count, 0);

// A real camera at street level in the middle of the city, so half of it is
// behind and there is plenty of everything in range.
const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.5, 5000);
/** Aim and pump enough ticks that every staggered consumer has run. */
function look(yawDeg) {
  cam.position.set(17, 3, 0);
  const a = yawDeg * Math.PI / 180;
  cam.lookAt(17 + Math.sin(a) * 100, 3, Math.cos(a) * 100);
  cam.updateMatrixWorld();
  for (let i = 0; i < 4; i++) { cam.position.y += 0.01; city.update(5, cam); }
}

look(0);
const A = { l0: tierCount(0), l1: tierCount(1), l2: tierCount(2), lamps: meshes.lamps.count,
  trunks: furnCount("CityTrunks"), cars: furnCount("CityCars"), roofs: roofCount(), culled: city.stats.culled };
look(180);
const B = { l0: tierCount(0), l1: tierCount(1), l2: tierCount(2), lamps: meshes.lamps.count,
  trunks: furnCount("CityTrunks"), cars: furnCount("CityCars"), roofs: roofCount(), culled: city.stats.culled };

const total = city.stats.buildings;
check("the frustum actually drops towers", A.culled > total * 0.2,
  `${A.culled} of ${total} culled looking one way`);
check("and drops different ones looking the other way",
  A.culled > 0 && B.culled > 0 && A.l1 + A.l2 < total && B.l1 + B.l2 < total,
  `submitted L1+L2: ${A.l1 + A.l2} vs ${B.l1 + B.l2}`);
check("the L0 tier is NEVER frustum-culled (it casts shadows)",
  A.l0 === city.stats.lod[0] && B.l0 === city.stats.lod[0],
  `L0 submitted ${A.l0} / ${B.l0}, assigned ${city.stats.lod[0]}`);
check("in-view + culled accounts for every L1/L2 building",
  A.l1 + A.l2 + A.culled === city.stats.lod[1] + city.stats.lod[2],
  `${A.l1 + A.l2} + ${A.culled} = ${city.stats.lod[1] + city.stats.lod[2]}`);

// ── Lamps ───────────────────────────────────────────────────────────────────
const allLamps = city.stats.lamps;
check("lamp posts are range-culled", A.lamps < allLamps, `${A.lamps} of ${allLamps} drawn`);
check("and frustum-culled — turning round changes the set",
  A.lamps !== B.lamps || A.lamps < allLamps * 0.5, `${A.lamps} vs ${B.lamps}`);

// ── Furniture: non-casters culled, casters range-only ──────────────────────
const allTrees = city.stats.furniture.trees;
check("tree trunks (no shadow) are frustum-culled", A.trunks < allTrees * 0.6,
  `${A.trunks} of ${allTrees}`);
// Cars cast, so looking the other way must NOT change how many are submitted:
// the same range disc, whichever way the camera faces.
check("parked cars (casters) are range-only: same count facing either way",
  A.cars === B.cars, `${A.cars} vs ${B.cars}`);
check("roof clutter is frustum-culled", A.roofs < city.stats.roofs.total * 0.5,
  `${A.roofs} of ${city.stats.roofs.total}`);

// ── Front to back ───────────────────────────────────────────────────────────
// For each L1/L2 mesh with a few instances, the first must be nearer the
// camera than the last. One reversed mesh is a real bug, so it is all or none.
look(0);
const _m = new THREE.Matrix4(), _p = new THREE.Vector3();
let checked = 0, reversed = 0, worst = 0;
for (const im of meshes.towers) {
  if (tierOf(im) === 0 || im.count < 4) continue;
  im.getMatrixAt(0, _m); _p.setFromMatrixPosition(_m);
  const dFirst = _p.distanceTo(cam.position);
  im.getMatrixAt(im.count - 1, _m); _p.setFromMatrixPosition(_m);
  const dLast = _p.distanceTo(cam.position);
  checked++;
  if (dFirst > dLast) { reversed++; worst = Math.max(worst, dFirst - dLast); }
}
check("every tier mesh is packed front to back", checked > 5 && reversed === 0,
  `${reversed} of ${checked} meshes reversed${worst ? `, worst by ${worst.toFixed(0)} m` : ""}`);

// And strictly non-decreasing along the whole buffer, on the biggest mesh.
{
  const big = meshes.towers.filter((m) => tierOf(m) !== 0).sort((a, b) => b.count - a.count)[0];
  let breaks = 0, prev = -1;
  for (let i = 0; i < big.count; i++) {
    big.getMatrixAt(i, _m); _p.setFromMatrixPosition(_m);
    const d = _p.distanceTo(cam.position);
    // The sort key is distance to the building's MIDPOINT, not its base, so
    // allow the slack a tall neighbour introduces.
    if (d < prev - 60) breaks++;
    prev = Math.max(prev, d);
  }
  check("the biggest mesh is sorted along its whole buffer", breaks === 0,
    `${breaks} order breaks in ${big.count} instances (${big.name})`);
}

// ── The turn trigger ────────────────────────────────────────────────────────
// A heading change alone — no time, no movement — must fire the tick, or a
// pan shows the edge of the frame empty until the clock does.
look(0);
const before = city.stats.culled;
cam.lookAt(17 + Math.sin(Math.PI / 2) * 100, 3, Math.cos(Math.PI / 2) * 100);   // 90° right
cam.updateMatrixWorld();
city.update(0.001, cam);                                                        // 1 ms, no move
check("a turn fires the LOD tick on its own", city.stats.culled !== before,
  `culled ${before} → ${city.stats.culled} after a 90° turn in 1 ms`);

// ── Degraded camera ─────────────────────────────────────────────────────────
// `{ position }` only: no frustum, everything in range is in view.
const fake = { position: new THREE.Vector3(17, 3, 0) };
for (let i = 0; i < 4; i++) { fake.position.y += 0.01; city.update(5, fake); }
check("a camera without a projection still works, range-only",
  city.stats.culled === 0 && tierCount(1) + tierCount(2) === city.stats.lod[1] + city.stats.lod[2],
  `culled ${city.stats.culled}, submitted ${tierCount(1) + tierCount(2)}`);

// ── THE PER-BUILDING-TYPE SPLIT ─────────────────────────────────────────────
//
// With `facadeTypeSplit` on there is one mesh row per (archetype, TYPE), and an
// instance may only sit in a row whose material was compiled for its own wall
// system. Put a curtain-wall tower in the punched mesh and it still draws, at
// full speed, with no warning — it is just wearing the wrong facade. So this
// checks the two things that would be silent: that every building is still
// placed, and that it is placed in a mesh built for ITS type.
{
  const c2 = createModularRoadCity({ params: { extent: 700, facadeTypeSplit: true } });
  const rows = [];
  c2.group.traverse((o) => { if (o.isInstancedMesh && /^CityInst_/.test(o.name)) rows.push(o); });
  const fake2 = { position: new THREE.Vector3(17, 3, 0) };
  for (let i = 0; i < 4; i++) { fake2.position.y += 0.01; c2.update(5, fake2); }

  check("the split names a type into every tower mesh",
    rows.length > 0 && rows.every((m) => /_t\d_l\d$/.test(m.name)),
    `${rows.length} meshes`);

  // Nothing lost and nothing double-counted: submitted must equal assigned.
  const submitted = rows.reduce((a, m) => a + m.count, 0);
  const assigned = c2.stats.lod[0] + c2.stats.lod[1] + c2.stats.lod[2];
  check("every building still lands in a mesh once", submitted === assigned,
    `${submitted} submitted vs ${assigned} assigned`);

  // The material a row draws with has to be the one compiled for its type —
  // the name carries the type, and so does the material's.
  const TYPE_NAMES = ["Punched", "Curtain", "Ribbon"];
  const wrong = rows.filter((m) => {
    const t = Number(m.name.match(/_t(\d)_l/)[1]);
    return !(m.material.name || "").endsWith(TYPE_NAMES[t]);
  });
  check("each row draws with the material compiled for its own type",
    wrong.length === 0,
    wrong.length ? `${wrong[0].name} uses ${wrong[0].material.name}` : `${rows.length} rows`);

  // All three wall systems must actually be present, or the split is being
  // measured on a city that only ever had one of them.
  const seen = new Set(rows.filter((m) => m.count > 0)
    .map((m) => Number(m.name.match(/_t(\d)_l/)[1])));
  check("all three building types are drawn", seen.size === 3, `types ${[...seen].sort()}`);
  c2.dispose();
}

console.log(`\n${fail === 0 ? "ALL PASS" : `${fail} FAILURE(S)`}  (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
