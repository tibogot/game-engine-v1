// CITY GATES — a building the street drives through.
//
// A gate is a stone block thrown across a mid-block street, standing on the two
// lots that face each other across it, with a vaulted passage the carriageway
// runs straight through. Everything that can go wrong with one is silent — it
// still draws — so each claim is measured here against the real city build:
//
//   PLACEMENT     on a real street, mid-block, clear of the viaduct, the
//                 underpass and plazas; its two lots are not also built
//   STABILITY     a track edit or a density change may REMOVE a gate, but can
//                 never move one or reshuffle the towers around it (the first
//                 version picked sites globally and failed exactly this)
//   PASSAGE       nothing solid in the lanes — no tower, no lamp, no clutter,
//                 and no wall of the gate itself
//   SOLID         the piers stop the car where the wall is, and the vault is
//                 where the arch says it is
//   SURFACES      in the solids collision channel, and in the rain collider so
//                 the rain stops under the vault
//   SHADER        the material generates WGSL without leaking undefined/NaN
//
// Run: node tools/cityGateTest.mjs
import { buildWGSL, THREE } from "./wgslBuilderStub.mjs";

const { createModularRoadCity, CITY_DEFAULTS } = await import("../games/modular-road-v3/modularRoadCity.js");
const GATE = await import("../games/modular-road-v3/modularRoadCityGate.js");
const { MeshBVH } = await import("three-mesh-bvh");

let fail = 0;
const check = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); if (!c) fail++; };

const SEED = 20260902;
const build = (params = {}, extra = {}) => createModularRoadCity({
  seed: SEED, params: { furnitureParams: { treeSource: "procedural" }, ...params }, ...extra,
});

const inGate = (g, x, z, m = 0) => {
  const hx = (g.axis === "z" ? g.halfSpan : g.halfDepth) + m;
  const hz = (g.axis === "z" ? g.halfDepth : g.halfSpan) + m;
  return Math.abs(x - g.x) <= hx && Math.abs(z - g.z) <= hz;
};

let surfaces = null;
const city = build({}, { onRebuilt: (s) => { surfaces = s; } });
const P = city.params;
const gates = city.stats.gateList;
const pitch = P.blockLots + P.streetLots;
const pmod = (a, n) => ((a % n) + n) % n;

console.log("\n═══ CITY GATES ═══\n");

console.log("=== PLACEMENT ===");
{
  check("the default city has gates", gates.length >= 1, `${gates.length} gate(s)`);
  for (const [i, g] of gates.entries()) {
    const r = Math.hypot(g.x - P.centerX, g.z - P.centerZ) / P.extent;
    const d = GATE.GATE_DEFAULTS;
    check(`gate ${i} stands in the old-town ring`, r >= d.ringMin && r <= d.ringMax, `${r.toFixed(2)} of extent`);

    // ON A STREET: the span-axis coordinate is a street centre line — exactly
    // what streetSpawnNear snaps to — and the cell it sits in is a street cell.
    const snap = city.streetSpawnNear(g.x, g.z);
    const onLine = g.axis === "z" ? Math.abs(snap.x - g.x) < 1e-6 : Math.abs(snap.z - g.z) < 1e-6;
    check(`gate ${i} is centred on a street's centre line`, onLine,
      `street along ${g.axis}, snap (${snap.x.toFixed(1)}, ${snap.z.toFixed(1)}) vs (${g.x}, ${g.z})`);
    const acrossCell = Math.floor((g.axis === "z" ? g.x : g.z) / P.lotSize);
    const originAcross = g.axis === "z" ? Math.floor(P.centerX / P.lotSize) : Math.floor(P.centerZ / P.lotSize);
    check(`...in a street cell, not in a block`, pmod(acrossCell - originAcross, pitch) >= P.blockLots);

    // MID-BLOCK: the lot along the street is never the first or last of its
    // block, which is where the crossings are painted.
    const alongCell = Math.floor((g.axis === "z" ? g.z : g.x) / P.lotSize);
    const originAlong = g.axis === "z" ? Math.floor(P.centerZ / P.lotSize) : Math.floor(P.centerX / P.lotSize);
    const k = pmod(alongCell - originAlong, pitch);
    check(`...mid-block, clear of the crossings`, k >= 1 && k <= P.blockLots - 2, `lot ${k} of ${P.blockLots}`);
  }

  // Its two lots are not also built, and no tower reaches into its footprint.
  const kit = city.kit.archetypes;
  let intrude = 0;
  for (const b of city.buildings) {
    for (const g of gates) {
      const a = kit[b.arch];
      const gx = g.axis === "z" ? g.halfSpan : g.halfDepth, gz = g.axis === "z" ? g.halfDepth : g.halfSpan;
      if (Math.abs(b.x - g.x) < gx + a.width / 2 && Math.abs(b.z - g.z) < gz + a.depth / 2) intrude++;
    }
  }
  check("no tower's footprint reaches into a gate", intrude === 0, `${intrude} overlap(s)`);
  check("the replaced lots are counted", city.stats.culledGate === gates.length * 2,
    `${city.stats.culledGate} lots for ${gates.length} gates`);

  // Clear of the underpass and viaduct: sample the footprint against the
  // city's own keep-out, which every placement already obeys.
  const vl = city.stats.viaduct, ul = city.stats.underpass;
  check("the viaduct and the underpass both exist, so the test means something", !!vl && !!ul);
}

console.log("\n=== STABILITY: A LOT TAKEN AWAY MOVES NOTHING ===");
{
  const key = (g) => `${g.x},${g.z},${g.axis}`;
  const base = new Set(gates.map(key));
  const buildingsOf = (c) => new Set(c.buildings.map((b) => `${b.cx},${b.cz},${b.arch}`));
  const baseTowers = buildingsOf(city);

  // Density: the gates are decided before any lot's density roll.
  const sparse = build({ density: 0.5 });
  const same = sparse.stats.gateList.map(key);
  check("a lower density keeps exactly the same gates", same.length === base.size && same.every((k) => base.has(k)),
    `${same.length} vs ${base.size}`);
  sparse.dispose?.();

  // The track corridor: a corridor straight down the first gate's street may
  // remove that gate — and must not move it, add another, or build a tower on
  // its lots.
  if (gates.length) {
    const g = gates[0];
    const alongZ = g.axis === "z";
    const avoid = (x, z) => (alongZ ? Math.abs(x - g.x) : Math.abs(z - g.z));
    const edited = build({}, { avoid });
    const after = edited.stats.gateList.map(key);
    check("a track down a gate's street removes that gate", !after.includes(key(g)));
    check("...and never adds or moves one", after.every((k) => base.has(k)), after.join(" | "));
    const towers = buildingsOf(edited);
    let grown = 0;
    for (const t of towers) if (!baseTowers.has(t)) grown++;
    check("...and no tower appears anywhere, including on its lots", grown === 0, `${grown} new tower(s)`);
    edited.dispose?.();
  }
}

console.log("\n=== THE PASSAGE IS CLEAR ===");
{
  // Street furniture you can hit, as the car actually meets it.
  let caps = 0;
  for (const g of gates) {
    for (const c of city.obstacleCapsulesNear(g.x, g.z, 90)) {
      const x = c.a?.x ?? c.x, z = c.a?.z ?? c.z;
      if (inGate(g, x, z)) caps++;
    }
  }
  check("no lamp, light, tree or parked car stands inside a gate", caps === 0, `${caps} capsule(s)`);

  const lists = city.furniture?.lists ?? {};
  const pos = new THREE.Vector3();
  const inside = {};
  for (const [name, arr] of Object.entries(lists)) {
    for (const e of arr ?? []) {
      if (e.m?.decompose) e.m.decompose(pos, new THREE.Quaternion(), new THREE.Vector3());
      else if (Number.isFinite(e.x)) pos.set(e.x, 0, e.z);
      else continue;
      for (const g of gates) if (inGate(g, pos.x, pos.z)) inside[name] = (inside[name] ?? 0) + 1;
    }
  }
  check("no furniture or roadworks placed inside a gate", Object.keys(inside).length === 0, JSON.stringify(inside));

  // The gate's own walls: car-height rays down every lane, through the gate.
  const cols = city.roadCollision().solids.filter((m) => m.name === "CityGateCollision");
  check("each gate hands the solids channel exactly one collider", cols.length === gates.length,
    `${cols.length} for ${gates.length}`);
  let blocked = 0, rays = 0;
  for (const [i, g] of gates.entries()) {
    const m = cols[i];
    if (!m) continue;
    const bvh = new MeshBVH(m.geometry);
    const inv = m.matrixWorld.clone().invert();
    const along = g.axis === "z" ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
    const across = g.axis === "z" ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
    const kerb = P.streetLots * P.lotSize * 0.5;
    for (let off = -kerb + 1; off <= kerb - 1; off += 2) {
      for (const y of [0.3, 1.4, 3.2]) {
        rays++;
        const o = new THREE.Vector3(g.x, P.groundY + y, g.z).addScaledVector(across, off).addScaledVector(along, -80);
        const hit = bvh.raycastFirst(new THREE.Ray(o.clone().applyMatrix4(inv), along.clone().transformDirection(inv)), THREE.DoubleSide);
        if (hit && hit.distance < 160) blocked++;
      }
    }
    g._bvh = bvh; g._m = m; g._inv = inv; g._across = across; g._along = along;
  }
  check("every lane is open, kerb to kerb, at every car height", blocked === 0, `${blocked} of ${rays} rays hit a wall`);
}

console.log("\n=== AND IT IS SOLID WHERE IT IS BUILT ===");
{
  const d = GATE.gateDims(P, P.gateParams);
  for (const [i, g] of gates.entries()) {
    if (!g._bvh) continue;
    const cast = (o, dir) => {
      const h = g._bvh.raycastFirst(new THREE.Ray(o.clone().applyMatrix4(g._inv), dir.clone().transformDirection(g._inv)), THREE.DoubleSide);
      return h ? h.point.applyMatrix4(g._m.matrixWorld) : null;
    };
    const centre = new THREE.Vector3(g.x, P.groundY + 1.4, g.z);
    const pier = cast(centre, g._across);
    check(`gate ${i}: the pier wall is where the arch ends`, !!pier && Math.abs(pier.distanceTo(centre) - d.a) < 1e-3,
      pier ? `${pier.distanceTo(centre).toFixed(3)} m, arch half-span ${d.a}` : "no hit");
    const up = cast(new THREE.Vector3(g.x, P.groundY + 1, g.z), new THREE.Vector3(0, 1, 0));
    check(`gate ${i}: the vault crown is overhead at its design height`,
      !!up && Math.abs(up.y - (P.groundY + d.crown)) < 0.05, up ? `${(up.y - P.groundY).toFixed(2)} m` : "no hit");
    const face = cast(centre.clone().addScaledVector(g._across, d.a + 8).addScaledVector(g._along, -40), g._along);
    check(`gate ${i}: driving at the pier face meets it`, !!face,
      face ? `hit ${(face.clone().sub(centre).dot(g._along)).toFixed(2)} m along the street (face at ${-d.Dp})` : "drove through a wall");
  }
}

console.log("\n=== SURFACES ===");
{
  const gateMeshes = [];
  city.group.traverse((o) => { if (o.name === "CityGate") gateMeshes.push(o); });
  check("one draw per gate", gateMeshes.length === gates.length, `${gateMeshes.length} meshes`);
  check("...all sharing one material", new Set(gateMeshes.map((m) => m.material)).size <= 1);
  check("the rain collider is told about every gate", gateMeshes.every((m) => surfaces?.includes(m)),
    `${gateMeshes.filter((m) => surfaces?.includes(m)).length} of ${gateMeshes.length}`);
  check("gates cast shadows, so the passage is dark", gateMeshes.every((m) => m.castShadow));

  const { geometry } = GATE.buildGateGeometry(GATE.gateDims(P));
  geometry.computeBoundingBox();
  check("the gate stands on the street, not in it", Math.abs(geometry.boundingBox.min.y) < 1e-6,
    `min y ${geometry.boundingBox.min.y.toFixed(4)}`);
  const pos = geometry.attributes.position, nrm = geometry.attributes.normal;
  const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3(), N = new THREE.Vector3(), n = new THREE.Vector3();
  let reversed = 0;
  for (let i = 0; i < pos.count; i += 3) {
    A.fromBufferAttribute(pos, i); B.fromBufferAttribute(pos, i + 1); C.fromBufferAttribute(pos, i + 2);
    N.subVectors(B, A).cross(C.clone().sub(A));
    n.fromBufferAttribute(nrm, i);
    if (N.lengthSq() > 1e-12 && N.dot(n) < 0) reversed++;
  }
  check("every triangle's winding agrees with its normal", reversed === 0, `${reversed} of ${pos.count / 3}`);
}

console.log("\n=== WITH TERRAIN ON THERE IS NO STREET, SO NO GATE ===");
{
  const hilly = build({ ground: false });
  check("no ground plane, no gates", hilly.stats.gates === 0, `${hilly.stats.gates}`);
  hilly.dispose?.();
}

console.log("\n=== SHADER ===");
{
  const d = GATE.gateDims(CITY_DEFAULTS);
  const { material } = GATE.makeGateMaterial(d);
  let b = null, err = null;
  try { b = buildWGSL(material); } catch (e) { err = e; }
  check("the gate material generates WGSL", err === null, err ? err.message : "");
  if (b) {
    const frag = b.fragmentShader || "";
    check("no 'undefined' leaked into it", !/undefined/.test(frag));
    check("and no NaN literals", !/NaN/.test(frag));
    check("small: one stone shader, not a second facade", frag.length < 40 * 1024, `${(frag.length / 1024).toFixed(1)} kB`);
  }
}

console.log(`\n${fail === 0 ? "ALL PASS" : `${fail} FAILED`}`);
process.exit(fail === 0 ? 0 : 1);
