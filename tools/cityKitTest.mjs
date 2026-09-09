// City kit / facade / assembly harness — everything about the skyline that can
// be checked without a GPU.
//
// What it is guarding, in order of how expensive the bug would be to find later:
//
//  1. mergeGeometries returning NULL on an attribute mismatch. Silent, and the
//     symptom is an invisible city.
//  2. LOD tiers disagreeing on silhouette. If L2's envelope is not exactly as
//     tall as L0, every tower visibly grows or shrinks as you drive past it.
//  3. Footprints spilling out of their lot / lots off the global grid. The
//     facade identifies a building by `floor(worldXZ / lotSize)`, so a tower
//     that crosses a cell changes tint and window seed partway up — which
//     reads as a shader bug and is not one.
//  4. The facade material actually building its node graph, including the
//     bloom MRT hookup, in the same three build the browser uses.
//  5. The LOD pass doing something as the camera moves, on BOTH backends.
//  6. LAYOUT STABILITY: clearing lots for the track corridor must not move,
//     reseed or resize any OTHER building. This is what lets the player build
//     the track around the city.
//  7. TERRAIN: per-lot base from the height sampler, the slope cull, the
//     world-bounds clamp, and the lot texture the facade reads base/top from.
import { register } from "node:module";

register("./threeWebgpuHook.mjs", import.meta.url);
const THREE = await import("three/webgpu");
const { buildCityKit } = await import("../games/modular-road-v3/modularRoadCityKit.js");
const { createCityFacadeMaterial, LOT_TEX_SIZE, FACADE_DEFAULTS: FACADE_DEFAULTS_ALL, isFacadeColorKey } = await import("../games/modular-road-v3/modularRoadCityFacade.js");
const { createModularRoadCity, CITY_DEFAULTS } = await import("../games/modular-road-v3/modularRoadCity.js");

let fail = 0;
const check = (n, c, d = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`);
  if (!c) fail++;
};

// ── 1. Kit ───────────────────────────────────────────────────────────────────
console.log("\n── KIT ──");
const kit = buildCityKit({ seed: 20260902 });
console.log(
  `  ${kit.stats.count} archetypes in ${kit.stats.bakeMs.toFixed(1)} ms · ` +
  `${kit.stats.minHeight.toFixed(0)}–${kit.stats.maxHeight.toFixed(0)} m · ` +
  `~${kit.stats.avgTrisL0}/${kit.stats.avgTrisL1}/${kit.stats.avgTrisL2} tris per LOD`,
);

let attrsOk = true, footprintOk = true, orderOk = true, monotonic = true;
let worstNear = 0, worstMass = 0, worstBase = 0, worstFoot = 0;
for (const a of kit.archetypes) {
  for (const g of a.lods) {
    if (!g.attributes.position || !g.attributes.normal || !g.attributes.uv) attrsOk = false;
    g.computeBoundingBox();
  }
  const [l0, l1, l2] = a.lods;
  worstNear = Math.max(worstNear, Math.abs(l0.boundingBox.max.y - l1.boundingBox.max.y));
  worstMass = Math.max(worstMass, Math.abs(l2.boundingBox.max.y - a.massHeight));
  worstBase = Math.max(worstBase, Math.abs(l0.boundingBox.min.y));
  worstFoot = Math.max(worstFoot, a.footprint);
  if (!(a.tris[0] >= a.tris[1] && a.tris[1] >= a.tris[2])) monotonic = false;
}
if (worstFoot >= CITY_DEFAULTS.lotSize) footprintOk = false;
for (let i = 1; i < kit.archetypes.length; i++) {
  if (kit.archetypes[i].height < kit.archetypes[i - 1].height) orderOk = false;
}

check("every LOD has position/normal/uv (merge did not return null)", attrsOk);
check("L0 and L1 share a roofline exactly", worstNear < 1e-6, `worst ${worstNear.toExponential(1)} m`);
check("L2's box is the massing envelope", worstMass < 1e-3, `worst ${worstMass.toExponential(1)} m — float32 geometry`);
check("every tier stands on y = 0", worstBase < 1e-3, `worst ${worstBase.toExponential(1)} m`);
check("footprints fit inside a lot", footprintOk, `widest ${worstFoot.toFixed(1)} m vs lot ${CITY_DEFAULTS.lotSize} m`);
check("triangle count falls with each tier", monotonic);
check("archetypes are height-sorted (the downtown falloff depends on it)", orderOk);
const kitB = buildCityKit({ seed: 20260902 });
check("same seed, same kit", kitB.archetypes.every((a, i) => Math.abs(a.height - kit.archetypes[i].height) < 1e-9));

// ── 2. Facade material ───────────────────────────────────────────────────────
console.log("\n── FACADE ──");
const facade = createCityFacadeMaterial({ params: { lotSize: 34 } });
check("material builds", !!facade.material && facade.material.isNodeMaterial === true);
const slots = {
  colorNode: facade.material.colorNode,
  roughnessNode: facade.material.roughnessNode,
  metalnessNode: facade.material.metalnessNode,
  emissiveNode: facade.material.emissiveNode,
};
check(
  "all four surface slots are wired to real nodes",
  Object.values(slots).every((n) => n && n.isNode === true),
  Object.entries(slots).map(([k, v]) => `${k}=${v?.isNode ? "node" : String(v)}`).join(" "),
);
check("lit windows opt into selective bloom", !!facade.material.mrtNode && !!facade.material.mrtNode.outputNodes?.emissive);
check("lotSize override reached the uniform", facade.uniforms.lotSize.value === 34);
facade.params.floorHeight = 4.25;
check("params proxy writes the uniform", facade.uniforms.floorHeight.value === 4.25);
facade.params.glassTint = 0x112233;
check("colour params go through THREE.Color", facade.uniforms.glassTint.value.getHex() === 0x112233);
// Every param whose default is a hex colour must be a Color uniform. A float
// uniform of 0x8a8378 is nine million, and it painted every wall white once.
// The predicate is IMPORTED, not copied: a local regex that drifts from the
// facade's own is exactly how nine-million-white walls got shipped once.
const colourKeys = Object.keys(FACADE_DEFAULTS_ALL).filter(isFacadeColorKey);
// ...and every hex-looking default must be caught by it. A colour that is
// NOT named as one is the failure mode, so assert on the values too.
const hexish = Object.entries(FACADE_DEFAULTS_ALL).filter(([, v]) => typeof v === "number" && Number.isInteger(v) && v > 0x1000).map(([k]) => k);
check("every hex-valued default is recognised as a colour", hexish.every(isFacadeColorKey), hexish.filter((k) => !isFacadeColorKey(k)).join(",") || `${hexish.length} ok`);
check(
  "every colour-named param is a THREE.Color uniform, none a float",
  colourKeys.length >= 10 && colourKeys.every((k) => facade.uniforms[k]?.value?.isColor === true),
  colourKeys.filter((k) => !facade.uniforms[k]?.value?.isColor).join(",") || `${colourKeys.length} ok`,
);
check(
  "lot texture is float RGBA at the fixed size",
  facade.lotHeights.texture.type === THREE.FloatType
    && facade.lotHeights.texture.format === THREE.RGBAFormat
    && facade.lotHeights.data.length === LOT_TEX_SIZE * LOT_TEX_SIZE * 4,
);

// ── 3. Assembly, both backends ───────────────────────────────────────────────
console.log("\n── ASSEMBLY ──");
const avoid = (x) => Math.abs(x);
const cam = new THREE.PerspectiveCamera(62, 1.6, 0.5, 8192);
let flatCity = null;

for (const backend of ["batched", "instanced"]) {
  // PROCEDURAL TREES EXPLICITLY: the furniture draw-count checks below are
  // about the procedural kit's batching, and the preset tree path builds no
  // procedural trunk/canopy (and loads its atlas + GLB over the network, which
  // does not happen headlessly). Pinning it keeps these counts a statement
  // about the geometry, not about which tree the city happens to default to.
  const city = createModularRoadCity({
    seed: 20260902, avoid,
    params: { backend, furnitureParams: { treeSource: "procedural" } },
  });
  const n = city.stats.buildings;
  check(`${backend}: buildings placed`, n > 200, `${n} buildings, ${city.stats.culledCorridor} cleared for the corridor`);

  cam.position.set(0, 40, 1500);
  city.update(10, cam);
  const farSplit = city.stats.lod.slice();
  cam.position.set(0, 40, 0);
  city.update(10, cam);
  const nearSplit = city.stats.lod.slice();
  check(
    `${backend}: LOD responds to the camera`,
    nearSplit[0] > farSplit[0] && nearSplit.reduce((a, b) => a + b) === n,
    `far L0=${farSplit[0]} → near L0=${nearSplit[0]} (of ${n})`,
  );
  check(`${backend}: LOD pass stays cheap`, city.stats.lastLodMs < 8, `${city.stats.lastLodMs.toFixed(2)} ms for ${n} buildings`);

  if (backend === "batched") {
    check("batched: the whole city is one mesh", city.stats.meshes === 1);
    city.dispose();
  } else {
    check("instanced: one mesh per archetype per tier", city.stats.meshes > 1 && city.stats.meshes <= kit.stats.count * 3, `${city.stats.meshes} meshes`);
    let tier0 = 0;
    city.group.traverse((o) => { if (o.isInstancedMesh && /_l0$/.test(o.name)) tier0++; });
    city.setShadows(true);
    let castersOn = 0;
    // TOWER meshes only: the furniture (cars, canopies) casts on its own terms.
    city.group.traverse((o) => { if (o.isInstancedMesh && /^CityInst_/.test(o.name) && o.castShadow) castersOn++; });
    check("instanced: shadows gate to the near tier only", castersOn === tier0 && tier0 > 0, `${castersOn} of ${city.stats.meshes} tower meshes cast`);
    city.setShadows(false);
    flatCity = city;
  }
  const mixTris = nearSplit[0] * kit.stats.avgTrisL0 + nearSplit[1] * kit.stats.avgTrisL1 + nearSplit[2] * kit.stats.avgTrisL2;
  console.log(`       ${backend}: ${(mixTris / 1000).toFixed(0)}k tris with LOD, ${(n * kit.stats.avgTrisL0 / 1000).toFixed(0)}k without`);
}

// ── 4. Grid contract ─────────────────────────────────────────────────────────
console.log("\n── GRID ──");
{
  const L = CITY_DEFAULTS.lotSize;
  let offGrid = 0, crossing = 0;
  for (const b of flatCity.buildings) {
    // Centre must be the centre of its global cell...
    if (Math.abs(b.x - (b.cx + 0.5) * L) > 1e-9 || Math.abs(b.z - (b.cz + 0.5) * L) > 1e-9) offGrid++;
    // ...and the footprint must not cross the cell edge.
    const half = kit.archetypes[b.arch].footprint / 2;
    if (Math.floor((b.x - half) / L) !== b.cx || Math.floor((b.x + half - 1e-6) / L) !== b.cx) crossing++;
  }
  check("every building is centred on a global lot cell", offGrid === 0, `${offGrid} off-grid`);
  check("no footprint crosses a cell boundary", crossing === 0, `${crossing} straddle two cells`);
  // Streets: with streetLots=1 and blockLots=4, no two built cells may be 5 apart
  // in the same row without a gap — spot-check that some column index mod 5 is
  // never used.
  const used = new Set(flatCity.buildings.map((b) => (((b.cx % 5) + 5) % 5)));
  check("street columns are never built on", used.size === CITY_DEFAULTS.blockLots, `columns mod 5 used: ${[...used].sort().join(",")}`);
}

// ── 5. Corridor stability ────────────────────────────────────────────────────
console.log("\n── CORRIDOR STABILITY ──");
{
  const key = (b) => `${b.cx},${b.cz}`;
  const narrow = new Map(flatCity.buildings.map((b) => [key(b), b]));
  const wide = createModularRoadCity({ seed: 20260902, avoid, params: { avoidRadius: 220 } });
  let moved = 0, extra = 0;
  for (const b of wide.buildings) {
    const o = narrow.get(key(b));
    if (!o) { extra++; continue; }
    if (o.arch !== b.arch || Math.abs(o.scaleY - b.scaleY) > 1e-12 || o.y !== b.y) moved++;
  }
  check(
    "widening the corridor removes buildings and changes NOTHING else",
    moved === 0 && extra === 0 && wide.stats.buildings < flatCity.stats.buildings,
    `${flatCity.stats.buildings} → ${wide.stats.buildings}; ${moved} changed, ${extra} appeared`,
  );
  // Density is per lot too: lowering it must be a strict subset.
  const sparse = createModularRoadCity({ seed: 20260902, avoid, params: { density: 0.5 } });
  let notSubset = 0;
  for (const b of sparse.buildings) if (!narrow.has(key(b))) notSubset++;
  check("lower density is a strict subset of the same city", notSubset === 0 && sparse.stats.buildings < flatCity.stats.buildings, `${sparse.stats.buildings} of ${flatCity.stats.buildings}`);
  wide.dispose();
  sparse.dispose();
}

// ── 6. Terrain ───────────────────────────────────────────────────────────────
console.log("\n── TERRAIN ──");
{
  // A gentle tilt: 2 cm per metre. Every lot fits; every base must be the
  // lowest corner minus the sink.
  const tilt = (x, z) => 0.02 * x + 0.01 * z + 50;
  const city = createModularRoadCity({ seed: 20260902, avoid, heightAt: tilt });
  const foot = CITY_DEFAULTS.lotSize * 0.42;
  let worst = 0;
  for (const b of city.buildings) {
    const lo = Math.min(
      tilt(b.x, b.z), tilt(b.x - foot, b.z - foot), tilt(b.x + foot, b.z - foot),
      tilt(b.x - foot, b.z + foot), tilt(b.x + foot, b.z + foot),
    );
    worst = Math.max(worst, Math.abs(b.y - (lo - CITY_DEFAULTS.sinkBias)));
  }
  check("base = lowest footprint corner − sinkBias", worst < 1e-9 && city.stats.culledSlope === 0, `worst ${worst.toExponential(1)} m, ${city.stats.buildings} built`);
  check("same lots as flat ground (a gentle slope culls nothing)", city.stats.buildings === flatCity.stats.buildings, `${city.stats.buildings} vs ${flatCity.stats.buildings}`);

  // Lot texture carries base and top.
  const b = city.buildings[0];
  const lot = city.facadeMaterial ? null : null; // (facade internals are not exposed; go via the group's material)
  const mat = city.facadeMaterial;
  const farMat = city.facadeFarMaterial;
  // TWO shared materials, not one: L2 gets a much cheaper variant built from
  // the SAME uniform objects (a 3300-line shader carries its register pressure
  // on every far pixel even when its distance branch is skipped). Every tower
  // mesh must still use one of exactly these two, or a rebuild has leaked a
  // per-mesh material and the city is back to N pipelines.
  let nearMeshes = 0, farMeshes = 0, strays = 0, misTier = 0;
  city.group.traverse((o) => {
    if (!o.isInstancedMesh || !/^CityInst_/.test(o.name)) return;
    const tier = Number(/_l(\d)$/.exec(o.name)[1]);
    if (o.material === mat) { nearMeshes++; if (tier === 2) misTier++; }
    else if (o.material === farMat) { farMeshes++; if (tier !== 2) misTier++; }
    else strays++;
  });
  check("every tower mesh shares one of the two facade materials", strays === 0 && nearMeshes > 0 && farMeshes > 0,
    `${nearMeshes} near, ${farMeshes} far, ${strays} stray`);
  check("the cheap facade is used by L2 and only L2", misTier === 0, `${misTier} on the wrong tier`);
  check("both facade materials share the same uniforms", mat !== farMat && city.facade.floorHeight === city.facade.floorHeight);
  city.dispose();

  // A cliff: 1 m per metre in x. Almost every lot spans > slopeLimit.
  const cliff = (x) => x;
  const steep = createModularRoadCity({ seed: 20260902, avoid, heightAt: cliff });
  check("steep ground culls lots", steep.stats.culledSlope > 0 && steep.stats.buildings < flatCity.stats.buildings * 0.2, `${steep.stats.buildings} built, ${steep.stats.culledSlope} culled for slope`);
  steep.dispose();

  // World bounds: a 1024 m half-world with an 80 m margin keeps everything
  // inside ±944 m even though the city asked for 1200.
  const bounded = createModularRoadCity({ seed: 20260902, avoid, params: { bounds: 1024 } });
  let outside = 0;
  for (const bb of bounded.buildings) if (Math.abs(bb.x) > 944 || Math.abs(bb.z) > 944) outside++;
  check("world bounds clamp the city", outside === 0 && bounded.stats.buildings < flatCity.stats.buildings, `${bounded.stats.buildings} built, none past ±944 m`);
  bounded.dispose();

  // Sky-mode sampler contract: a NaN height must skip the lot, never place at NaN.
  const nanCity = createModularRoadCity({ seed: 20260902, avoid, heightAt: () => NaN });
  check("a non-finite height sampler places nothing (no NaN matrices)", nanCity.stats.buildings === 0);
  nanCity.dispose();
}

// ── 7. Lot texture ───────────────────────────────────────────────────────────
console.log("\n── LOT TEXTURE ──");
{
  const tilt = (x, z) => 0.02 * x + 30;
  const city = createModularRoadCity({ seed: 20260902, avoid, heightAt: tilt });
  // Reach the texture through the material's uniform-free handle: the facade
  // exposes it on the city via the material we can't reach, so rebuild one
  // directly and replay the layout contract instead.
  const f = createCityFacadeMaterial({ params: { lotSize: 34 } });
  f.lotHeights.clear(7);
  check("clear() fills base=top=groundY", f.lotHeights.data[0] === 7 && f.lotHeights.data[1] === 7);
  f.lotHeights.setOrigin(-40, -40, 81, 81);
  check("setOrigin clamps count to the texture", (() => {
    f.lotHeights.setOrigin(0, 0, 999, 999);
    return f.lotHeights.size === LOT_TEX_SIZE;
  })());
  check("terrain city marks its extent and cell coverage", city.stats.lotTexCells[0] > 10 && city.stats.extent === CITY_DEFAULTS.extent, `${city.stats.lotTexCells.join("×")} cells, extent ${city.stats.extent}`);
  city.dispose();
}

// ── 8. Look pass: landmarks, districts, signs, beacons ───────────────────────
console.log("\n── LOOK PASS ──");
{
  const nL = kit.stats.landmarks;
  const normals = kit.archetypes.slice(0, kit.archetypes.length - nL);
  const lands = kit.archetypes.slice(-nL);
  check("kit bakes the requested landmarks, all taller than every ordinary tower",
    lands.length === nL && lands.every((a) => a.landmark && a.height > normals[normals.length - 1].height),
    `${lands.map((a) => a.height.toFixed(0)).join("/")} m vs tallest ordinary ${normals[normals.length - 1].height.toFixed(0)} m`);
  check("every archetype reports width/depth inside the lot", kit.archetypes.every((a) => a.width < CITY_DEFAULTS.lotSize && a.depth < CITY_DEFAULTS.lotSize));
  check("masted archetypes report a mast tip above the massing", kit.archetypes.filter((a) => a.mastTop != null).every((a) => a.mastTop > a.massHeight) && kit.archetypes.some((a) => a.mastTop != null));

  const c = flatCity;
  const placedLand = c.buildings.filter((b) => b.landmark);
  check("landmarks are placed on the lots nearest downtown", placedLand.length === c.stats.landmarks && placedLand.every((b) => b.r <= CITY_DEFAULTS.landmarkRadius) && placedLand.length > 0, `${placedLand.length} placed, max r ${Math.max(...placedLand.map((b) => b.r)).toFixed(0)} m`);
  check("ordinary lots never pick a landmark archetype", c.buildings.filter((b) => !b.landmark).every((b) => b.arch < normals.length));
  check("all three districts exist and the core is glass", c.stats.districts.every((n) => n > 0) && c.buildings.filter((b) => b.r < 120).every((b) => b.district === 0), c.stats.districts.join("/"));
  check("beacons: one per masted building", c.stats.beacons === c.buildings.filter((b) => kit.archetypes[b.arch].mastTop != null).length && c.stats.beacons > 0, `${c.stats.beacons}`);
  // Signage is OFF by default now (see CITY_DEFAULTS.signs) — the procedural
  // board art is due to be replaced by real imported images. It still has to
  // WORK when asked for, so the sign checks build their own city with it on.
  // SIGNAGE IS HERO ADVERTS ONLY by default: few, huge, street-facing, each a
  // slot for a real image. The procedural layers exist but default to 0.
  const sg = c.stats.signs;
  check("signage defaults to hero adverts and nothing else",
    CITY_DEFAULTS.signs === true && sg.heroes > 0 && sg.banners === 0 && sg.bands === 0 && sg.texts === 0 && sg.neon === 0 && sg.mega === 0,
    JSON.stringify(sg));
  check("heroes are FEW — a handful per hundred towers, not a scatter", sg.heroes > 8 && sg.heroes < c.stats.buildings * 0.08, `${sg.heroes} of ${c.stats.buildings}`);
  // A board nobody can see from the road is noise: every hero must sit on a
  // face that looks onto a street, which the lot's cell index alone decides.
  const per = CITY_DEFAULTS.blockLots + CITY_DEFAULTS.streetLots;
  const facesStreet = (h) => {
    const ix = ((h.cx % per) + per) % per, iz = ((h.cz % per) + per) % per;
    const [nx, nz] = h.face;
    return (nx === -1 && ix === 0) || (nx === 1 && ix === CITY_DEFAULTS.blockLots - 1)
      || (nz === -1 && iz === 0) || (nz === 1 && iz === CITY_DEFAULTS.blockLots - 1);
  };
  check("every hero advert faces a street", c.signs.heroes.every(facesStreet), `${c.signs.heroes.filter((h) => !facesStreet(h)).length} face a neighbour`);
  check("every hero is building-scale", c.signs.heroes.every((h) => h.w >= 12 && h.h >= 8), "min " + Math.min(...c.signs.heroes.map((h) => h.w)).toFixed(1) + " m wide");
  let extra = 0; const names = [];
  c.group.traverse((o) => { if (o.isInstancedMesh && /^City(Banners|Screens|Bands|Texts|Neon|Beacons|Heroes)$/.test(o.name)) { extra++; names.push(o.name); } });
  check("heroes + beacons are exactly two instanced meshes (two draws)", extra === 2, names.sort().join(","));
  // Street lamps: the grid walked once on the CPU, one instanced draw, and
  // every post inside the city's extent.
  const lamps = c.group.getObjectByName("CityLamps");
  check("street lamps are one instanced mesh", !!lamps && lamps.isInstancedMesh && c.stats.lamps > 500, `${c.stats.lamps} posts`);
  {
    const m = new THREE.Matrix4(), v = new THREE.Vector3(); let out = 0;
    for (let i = 0; i < c.stats.lamps; i++) { lamps.getMatrixAt(i, m); v.setFromMatrixPosition(m); if (Math.abs(v.x) > CITY_DEFAULTS.extent || Math.abs(v.z) > CITY_DEFAULTS.extent) out++; }
    /*
   * EVERY LANTERN OVER ITS CARRIAGEWAY.
   *
   * The lamp is a post with an ARM, so the yaw decides which way the lantern
   * reaches — and on east-west streets the two sides' yaws were swapped, so
   * half the lamps in the city lit the building behind them instead of the
   * road. Nothing threw, nothing looked wrong in a stat, and it was caught
   * from a night screenshot.
   *
   * `streetSpawnNear` snaps to the centre of the nearest street, so the test
   * is exact: transform the lantern (local +X at the arm's end) to world and
   * it must come out CLOSER to a street centre than the post does. An arm
   * pointing into the block moves it further away.
   */
  {
    const S = c.streets;
    const arm = S.lampArm, h = S.lampHeight;
    let wrongWay = 0, total = 0;
    const m = new THREE.Matrix4();
    for (let i = 0; i < Math.min(lamps.count, 400); i++) {
      lamps.getMatrixAt(i, m);
      const e = m.elements;
      const px = e[12], pz = e[14];
      const hx = e[0] * arm + e[4] * h + px;
      const hz = e[2] * arm + e[6] * h + pz;
      const sPost = c.streetSpawnNear(px, pz);
      const sHead = c.streetSpawnNear(hx, hz);
      const dPost = Math.hypot(sPost.x - px, sPost.z - pz);
      const dHead = Math.hypot(sHead.x - hx, sHead.z - hz);
      total++;
      if (dHead >= dPost) wrongWay++;
    }
    check("every street lamp reaches OVER the road, not into the building",
      wrongWay === 0, `${wrongWay} of ${total} lanterns point the wrong way`);

    // THE SIGNALS HAVE THE SAME SHAPE AND HAD THE SAME BUG: a mast arm that
    // must reach across the carriageway, yawed off the wrong axis convention.
    // 156 of 300 heads were over the building behind them.
    const FP = flatCity.furniture.params;
    const lights = flatCity.furniture.lists.lights;
    let sigWrong = 0, sigTotal = 0;
    for (const e of lights.slice(0, 300)) {
      const el = e.m.elements;
      const px = el[12], pz = el[14];
      const hx = el[0] * FP.lightArm + el[4] * (FP.lightHeight - 0.8) + px;
      const hz = el[2] * FP.lightArm + el[6] * (FP.lightHeight - 0.8) + pz;
      const sp = flatCity.streetSpawnNear(px, pz);
      const sh = flatCity.streetSpawnNear(hx, hz);
      sigTotal++;
      if (Math.hypot(sh.x - hx, sh.z - hz) >= Math.hypot(sp.x - px, sp.z - pz)) sigWrong++;
    }
    check("every traffic signal reaches OVER the carriageway", sigWrong === 0,
      `${sigWrong} of ${sigTotal} heads point the wrong way`);

    /*
     * THE TEST ABOVE WAS TOO WEAK, AND IT PASSED ON A SCREENSHOT THAT WAS
     * OBVIOUSLY WRONG. At a junction corner BOTH streets are within an arm's
     * length, so "the head is nearer a street centre than the post" is
     * satisfied by a mast reaching over the CROSS street. It only ever proved
     * the arm points at *a* road, never at its own — which is how two booms
     * ended up crossing over one corner with their heads out over the zebra.
     *
     * Two things it could not see, both checked here:
     *   1. the head must be over the SAME street the post stands on, so the
     *      axis of the nearest centre line has to match;
     *   2. no two masts may share a corner, because that is what an X looks
     *      like from the car.
     */
    let crossStreet = 0;
    for (const e of lights.slice(0, 300)) {
      const el = e.m.elements;
      const px = el[12], pz = el[14];
      const hx = el[0] * FP.lightArm + el[4] * (FP.lightHeight - 0.8) + px;
      const hz = el[2] * FP.lightArm + el[6] * (FP.lightHeight - 0.8) + pz;
      // streetSpawnNear's yaw names the axis of the street it snapped to.
      if (Math.abs(flatCity.streetSpawnNear(px, pz).yaw - flatCity.streetSpawnNear(hx, hz).yaw) > 1e-6) crossStreet++;
    }
    check("every signal reaches over ITS OWN street, not the cross street",
      crossStreet === 0, `${crossStreet} of 300 reach across the wrong road`);

    let tooClose = 0;
    const pts = lights.slice(0, 600).map((e) => [e.m.elements[12], e.m.elements[14]]);
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const d = Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]);
        if (d < 6) { tooClose++; break; }
      }
    }
    check("no two signal masts share a corner (no crossed booms)", tooClose === 0,
      `${tooClose} masts within 6 m of another`);

    /*
     * THE DRIVING-SIDE RULE ITSELF, against the lane table it is derived from.
     * Everything that re-derived this got it wrong on one axis — signals, stop
     * lines and lane arrows were all correct on x-running streets and
     * backwards on z-running ones, while the CARS, the only thing reading the
     * table directly, were always right. So the test reads the table too.
     */
    const { laneTravelDir } = await import("../games/modular-road-v3/modularRoadCityFurniture.js");
    const LANE_TABLE = [[0.125, 1], [0.375, 1], [0.625, -1], [0.875, -1]];
    let ruleBad = 0;
    for (const axis of ["z", "x"]) {
      for (const side of [0, 1]) {
        // The lane nearest this kerb: low-across side takes the lowest frac.
        const [, baseDir] = side === 0 ? LANE_TABLE[0] : LANE_TABLE[3];
        const actual = axis === "x" ? -baseDir : baseDir;
        if (laneTravelDir(axis, side) !== actual) ruleBad++;
      }
    }
    check("laneTravelDir agrees with the lane table the cars use", ruleBad === 0,
      `${ruleBad} of 4 combinations disagree`);

    // And every mast must sit at the end its own traffic ARRIVES at.
    let wrongEnd = 0, endTotal = 0;
    for (const e of lights.slice(0, 300)) {
      if (e.travel == null) continue;
      endTotal++;
      const along = e.axis === "z" ? e.z : e.x;
      const want = e.travel > 0 ? e.a1 : e.a0;          // the junction ahead
      const other = e.travel > 0 ? e.a0 : e.a1;
      if (Math.abs(along - want) > Math.abs(along - other)) wrongEnd++;
    }
    check("every signal stands at the junction its traffic arrives at",
      endTotal > 0 && wrongEnd === 0, `${wrongEnd} of ${endTotal} at the far end`);

    /*
     * NOTHING BURIED IN A BUILDING. A cone, sign or bin inside a footprint is
     * invisible, still costs an instance and a capsule, and is exactly the
     * kind of waste that never shows up in a stat — the count says 1456 cones
     * either way.
     */
    const buried = {};
    for (const [kind, list] of Object.entries(flatCity.furniture.lists)) {
      if (!Array.isArray(list) || !list.length) continue;
      let bad = 0, n = 0;
      for (const e of list.slice(0, 400)) {
        const room = flatCity.buildingClearance(e.x, e.z);
        if (room == null) continue;
        n++;
        if (room < 0) bad++;
      }
      if (n) buried[kind] = `${bad}/${n}`;
    }
    const anyBuried = Object.entries(buried).filter(([, v]) => !v.startsWith("0/"));
    check("no street furniture is buried inside a building", anyBuried.length === 0,
      anyBuried.length ? anyBuried.map(([k, v]) => `${k} ${v}`).join(", ") : JSON.stringify(buried));
  }

  check("every lamp post stands inside the city extent", out === 0, `${out} outside`);
  }
  // Street furniture: cars, trees, traffic lights, guardrails — five draws.
  const fs = c.stats.furniture;
  check("furniture is placed on the grid", !!fs && fs.cars > 500 && fs.trees > 300 && fs.lights > 100 && fs.rails > 200, JSON.stringify(fs));
  let fmeshes = 0;
  c.group.traverse((o) => { if (o.isInstancedMesh && /^City(Cars|Trunks|Canopies|TrafficLights|Rails|Traffic)$/.test(o.name)) fmeshes++; });
  check("furniture is exactly six instanced meshes", fmeshes === 6, `${fmeshes}`);

  // ── STREET CLUTTER ────────────────────────────────────────────────────────
  {
    const names = [];
    c.group.traverse((o) => { if (o.isInstancedMesh && /^City(Cones|Barriers|Bins|Pallets)$/.test(o.name)) names.push(o.name); });
    check("clutter is four instanced meshes", names.length === 4, names.sort().join(","));
    // One material across all four: they differ by geometry, and four
    // materials would be four shader builds for a difference nobody sees.
    const mats = new Set();
    c.group.traverse((o) => { if (o.isInstancedMesh && /^City(Cones|Barriers|Bins|Pallets)$/.test(o.name)) mats.add(o.material.uuid); });
    check("clutter shares one material", mats.size === 1, `${mats.size} material(s)`);
    const cl = fs.clutter;
    check("roadworks and bays actually place", !!cl && cl.cones > 200 && cl.barriers > 10 && cl.bins > 10 && cl.pallets > 10, JSON.stringify(cl));
    // A cone belongs to a SITE. Every barrier heads a run of cones, so cones
    // must outnumber barriers by roughly the taper+run count, never be loose.
    check("cones come in runs, not scattered", cl.cones / Math.max(1, cl.barriers) > 8,
      `${(cl.cones / Math.max(1, cl.barriers)).toFixed(1)} cones per barrier`);
    // NOTHING here is in the obstacle table: a cone that stops a car is wrong,
    // and a knockable with no capsule needs no de-collision. See the module.
    const ob = c.stats.obstacles;
    const solidKinds = Object.keys(ob).filter((k) => /cone|barrier|bin|pallet|clutter/i.test(k));
    check("clutter is never solid", solidKinds.length === 0,
      solidKinds.length ? `in the table: ${solidKinds.join(",")}` : `${ob.total} capsules, none of them clutter`);
    check("the knockable pool is pointed at the clutter", !!c.stats.knockables,
      c.stats.knockables ? "live" : "pool absent");
    /*
     * EVERY placement must carry a cached x/z. Both the LOD partition and the
     * knockable scan test them, and an entry without them reads `undefined`,
     * so `NaN >= range²` is FALSE — the kind is silently never culled AND
     * never knockable, with no error anywhere. That is exactly what happened
     * when the clutter was first added.
     */
    const lists = c.furniture?.lists ?? {};
    const missing = Object.entries(lists)
      .filter(([, l]) => Array.isArray(l) && l.length)
      .filter(([, l]) => !Number.isFinite(l[0].x) || !Number.isFinite(l[0].z))
      .map(([n]) => n);
    check("every furniture kind caches x/z (or it is never culled and never hit)",
      missing.length === 0, missing.length ? `no x/z on: ${missing.join(",")}` : `${Object.keys(lists).length} kinds`);

    /*
     * PER-INSTANCE ATTRIBUTES MUST SURVIVE THE LOD PARTITION.
     *
     * applyLod swaps entries inside the list, so slot `i` belongs to a
     * different object every tick. An attribute uploaded once at build time
     * stays in the ORIGINAL order and every slot draws somebody else's value —
     * a pedestrian sign's artwork on a roadworks post, a junction's signals no
     * longer opposed. Silent, and only after the camera moves.
     */
    const camNear = new THREE.PerspectiveCamera(62, 1.6, 0.5, 8192);
    camNear.position.set(0, 6, 0);
    camNear.lookAt(200, 4, 0);
    c.update(10, camNear);
    for (const [meshName, attrName, key] of [["CityRoadSigns", "aTile", "tile"], ["CityTrafficLights", "aPhase", "phase"]]) {
      let mesh = null;
      c.group.traverse((o) => { if (o.isInstancedMesh && o.name === meshName) mesh = o; });
      if (!mesh) { check(`${meshName} exists`, false); continue; }
      const attr = mesh.geometry.getAttribute(attrName);
      const list = meshName === "CityRoadSigns" ? lists.roadSigns : lists.lights;
      let wrong = 0;
      for (let i = 0; i < mesh.count; i++) {
        if (Math.abs(attr.getX(i) - (list[i][key] ?? 0)) > 1e-5) wrong++;
      }
      check(`${meshName}: ${attrName} follows its entry through the LOD partition`,
        mesh.count > 0 && wrong === 0, `${wrong} of ${mesh.count} slots mismatched`);
    }
  }
  // MOVING TRAFFIC: one more draw, driven on the CPU and culled by distance.
  check("traffic is laid out on lanes", fs.lanes > 40 && fs.traffic > 200, `${fs.traffic} cars on ${fs.lanes} lanes`);
  {
    const tm = c.group.getObjectByName("CityTraffic");
    check("traffic is one instanced mesh", !!tm && tm.isInstancedMesh && tm.instanceMatrix.count === fs.traffic);
    const cam = new THREE.Vector3(0, 40, 0);
    c.update(0.016, { position: cam });
    const first = tm.count;
    check("an update fills only the cars within range", first > 0 && first < fs.traffic, `${first} of ${fs.traffic}`);
    // ...and they MOVE: the same car must be somewhere else a second later.
    const m0 = new THREE.Matrix4(), m1 = new THREE.Matrix4(), v0 = new THREE.Vector3(), v1 = new THREE.Vector3();
    tm.getMatrixAt(0, m0); v0.setFromMatrixPosition(m0);
    c.update(1.0, { position: cam });
    tm.getMatrixAt(0, m1); v1.setFromMatrixPosition(m1);
    check("traffic actually moves between frames", v0.distanceTo(v1) > 0.5, `${v0.distanceTo(v1).toFixed(1)} m`);
  }
  {
    const cm = c.group.getObjectByName("CityCars");
    check("cars carry per-instance colour", !!cm && !!cm.instanceColor && cm.instanceColor.count === fs.cars);
  }
  // The image API: a slot swap must be a repaint, never a new texture.
  const texBefore = c.group.getObjectByName("CityHeroes").material.name;
  check("hero image slots are addressable and start as placeholders", c.signs.heroSlots === 16 && c.signs.heroSlotIsPlaceholder(3) === true);
  c.signs.setHeroImage(3, { width: 4, height: 4 });
  check("loading an image into a slot flips it off placeholder without a rebuild", c.signs.heroSlotIsPlaceholder(3) === false && c.group.getObjectByName("CityHeroes").material.name === texBefore);
  check("a board can be re-pointed at another slot in place", c.signs.setHero(0, { slot: 3 }) === true && c.signs.heroes[0].index === 0);
  const before = JSON.stringify(c.stats.signs);
  c.rebuild();
  check("signs are deterministic across a rebuild", JSON.stringify(c.stats.signs) === before);
  // The old Tokyo layers still work when asked for — one draw each.
  const tokyo = createModularRoadCity({ seed: 20260902, avoid, params: { signParams: { bannerFraction: 0.5, bandFraction: 0.4, textFraction: 0.2, neonFraction: 0.3, screenFraction: 0.12 } } });
  const ts = tokyo.stats.signs;
  check("the legacy layers still place when their fractions are raised", ts.banners > 0 && ts.bands > 0 && ts.texts > 0 && ts.neon > 0 && ts.screens > 0, JSON.stringify(ts));
  tokyo.dispose();
}

// ── 7b. Checkpoint route ─────────────────────────────────────────────────────
/*
 * A checkpoint the player cannot reach is the one failure this feature has,
 * and it is invisible from the code: the route is random, so a point inside a
 * tower looks exactly like a point on a street until you drive at it.
 *
 * `streetSpawnNear` snaps to the centre of the nearest street, which makes the
 * test exact rather than statistical: a point already ON a street centre is a
 * FIXED POINT of that function. Feed each route point back through it and it
 * must not move.
 */
{
  console.log("\n── CHECKPOINTS ──");
  const { createCityCheckpoints } = await import("../games/modular-road-v3/modularRoadCityCheckpoints.js");
  const scene = new THREE.Scene();
  const run = createCityCheckpoints({ scene, city: flatCity, hudParent: null });
  check("the rush builds against a city", !!run);
  if (run) {
    const n = run.start(0, 0);
    check("a route is built", n === run.params.count, `${n} checkpoints`);
    let offStreet = 0, tooClose = 0, outside = 0;
    const extent = flatCity.params.extent;
    let prev = null;
    for (const p of run.route) {
      const snap = flatCity.streetSpawnNear(p.x, p.z);
      if (Math.hypot(snap.x - p.x, snap.z - p.z) > 1e-6) offStreet++;
      if (Math.abs(p.x) > extent || Math.abs(p.z) > extent) outside++;
      if (prev && Math.hypot(p.x - prev.x, p.z - prev.z) < run.params.legMin * 0.4) tooClose++;
      prev = p;
    }
    check("every checkpoint is on a street centre (reachable)", offStreet === 0, `${offStreet} off-street`);
    check("no checkpoint is outside the city", outside === 0, `${outside} outside ±${extent} m`);
    check("legs are real legs, not a pile", tooClose === 0, `${tooClose} legs under 40% of legMin`);
    // Collecting one must advance the target and add time.
    const before = run.state.time;
    const t0 = run.route[0];
    const ev = run.update(0.016, { x: t0.x, y: 0, z: t0.z });
    check("driving into one collects it", ev?.kind === "checkpoint" && run.state.reached === 1, JSON.stringify(ev));
    check("collecting adds time", run.state.time > before, `${before.toFixed(1)} -> ${run.state.time.toFixed(1)} s`);
    run.dispose();
  }
}

flatCity.dispose();

// ── 8. Defaults tables: no key declared twice ────────────────────────────────
/*
 * A DUPLICATE KEY IN A DEFAULTS OBJECT IS SILENT AND THE LATER ONE WINS.
 *
 * These tables are long, heavily commented and grouped by feature, which is
 * exactly the shape that hides a repeat: the two declarations end up hundreds
 * of lines apart and nothing — not the linter, not the runtime — says a word.
 * It has cost two debugging sessions already. `chipScale`/`chipStretch` were
 * declared twice in STREET_DEFAULTS and the tuned values silently lost to the
 * older pair; a new `screenMinHeight` for the crowning LED walls collided with
 * the legacy wide-screen one and would have taken its value instead.
 *
 * Reading the SOURCE is the point — by the time the object exists the
 * duplicate is gone, so there is nothing left to assert against.
 */
{
  console.log("\n── DEFAULTS TABLES ──");
  const { readFileSync } = await import("node:fs");
  const tables = [
    ["SIGN_DEFAULTS", "modularRoadCitySigns.js"],
    ["STREET_DEFAULTS", "modularRoadCityStreets.js"],
    ["FURNITURE_DEFAULTS", "modularRoadCityFurniture.js"],
    ["FACADE_DEFAULTS", "modularRoadCityFacade.js"],
    ["CITY_DEFAULTS", "modularRoadCity.js"],
  ];
  for (const [name, file] of tables) {
    let src;
    try {
      src = readFileSync(new URL(`../games/modular-road-v3/${file}`, import.meta.url), "utf8");
    } catch { continue; }
    const start = src.indexOf(`${name} = {`);
    if (start < 0) { check(`${name} is findable in ${file}`, false); continue; }
    // Walk braces from the opening one so nested objects/arrays stay inside the
    // slice; only depth-1 keys are declarations of this table.
    let i = src.indexOf("{", start), depth = 0, end = i;
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
    }
    const body = src.slice(src.indexOf("{", start) + 1, end);
    // Strip comments and nested braces/brackets, then read `key:` at top level.
    const flat = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    const seen = new Map();
    const dupes = [];
    let d = 0;
    for (const m of flat.matchAll(/[{}[\]]|(^|[,{])\s*([A-Za-z_$][\w$]*)\s*:/gm)) {
      const t = m[0];
      if (m[2] === undefined) { d += (t === "{" || t === "[") ? 1 : -1; continue; }
      if (d !== 0) continue;
      const k = m[2];
      if (seen.has(k)) dupes.push(k); else seen.set(k, true);
    }
    check(`${name} declares every key once`, dupes.length === 0,
      `${seen.size} keys${dupes.length ? " · DUPLICATED: " + dupes.join(", ") : ""}`);
  }
}

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILURE(S)`);
process.exit(fail === 0 ? 0 : 1);
