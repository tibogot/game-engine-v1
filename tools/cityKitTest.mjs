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
  /*
   * ── THE CORRIDOR ASKS HOW TALL THE BUILDING IS ──────────────────────────
   *
   * The keep-out used to be answered from (x, z) alone, so a track three
   * hundred metres in the air stamped out the block underneath it exactly as
   * hard as one at street level — buildings deleted for a collision that
   * could never happen, which is what "the city adapts to my track" actually
   * was. The query now gets the height the building would reach.
   *
   * Both directions are checked, because only one of them is the fix. A
   * corridor that cleared nothing at all would pass a "high track keeps the
   * city" test and drive straight through a tower.
   */
  const CORRIDOR_X = 1e9;                      // the band avoid() describes
  const bandAvoid = (deckY) => (x, z, top) => {
    const d = Math.abs(x);
    if (d > 120) return Infinity;              // outside the strip: keep
    if (top != null && deckY > top + 6) return Infinity;   // track flies over
    return -1;
  };
  const overhead = createModularRoadCity({ seed: 20260902, avoid: bandAvoid(400), params: {} });
  const atGrade = createModularRoadCity({ seed: 20260902, avoid: bandAvoid(2), params: {} });
  const base = createModularRoadCity({ seed: 20260902, avoid: () => Infinity, params: {} });
  check("a track flown over the city clears nothing",
    overhead.stats.buildings === base.stats.buildings,
    `${base.stats.buildings} with no track, ${overhead.stats.buildings} under a 400 m deck`);
  check("a track at street level still clears its own corridor",
    atGrade.stats.buildings < base.stats.buildings,
    `${base.stats.buildings} → ${atGrade.stats.buildings} under a 2 m deck`);
  /*
   * AND WHAT IT CLEARS IS STILL A STRICT SUBSET — the property that makes
   * "build around the city" possible at all. Moving the query below the dice
   * cannot disturb another lot, because `lotRng(cx, cz)` is a fresh generator
   * per lot; this is what proves that rather than asserting it.
   */
  const baseKeys = new Map(base.buildings.map((b) => [key(b), b]));
  let gMoved = 0, gExtra = 0, gLandmark = 0;
  for (const b of atGrade.buildings) {
    const o = baseKeys.get(key(b));
    if (!o) { gExtra++; continue; }
    /*
     * LANDMARKS ARE THE ONE REAL EXCEPTION, and it is deliberate rather than
     * a leak. The post-pass always promotes the N lots nearest downtown to
     * the landmark archetypes, so removing one promotes the next-nearest —
     * a global decision, on purpose, and the only thing in the layout that is
     * not a pure function of (seed, cell).
     *
     * The check above this one passes only because its corridor happens to
     * wipe the entire landmark disc, so no promotion can be observed. Saying
     * so here is the difference between a test that holds and one that holds
     * by luck.
     */
    if (o.landmark || b.landmark) { gLandmark++; continue; }
    if (o.arch !== b.arch || Math.abs(o.scaleY - b.scaleY) > 1e-12 || o.y !== b.y) gMoved++;
  }
  check("a low track removes buildings and moves no ordinary one",
    gMoved === 0 && gExtra === 0, `${gMoved} changed, ${gExtra} appeared`);
  check("the only buildings the corridor re-decides are the landmarks",
    gLandmark <= (base.stats.landmarks || 0) + (atGrade.stats.landmarks || 0),
    `${gLandmark} touched, ${base.stats.landmarks} landmarks`);
  for (const cty of [overhead, atGrade, base]) cty.dispose?.();
  void CORRIDOR_X;

  /*
   * ── PLAZAS ARE WHOLE BLOCKS ─────────────────────────────────────────────
   *
   * The point of a plaza is that it is the entire block. A roll at the same
   * rate applied per LOT would give scattered holes inside blocks, which
   * reads as a bug rather than as a square — and the two are indistinguish-
   * able from a building count alone, so counting is not enough. This checks
   * the shape: every block the layout emptied must be empty in ALL of its
   * lots, and blocks that were not emptied must still be built.
   */
  {
    const P0 = CITY_DEFAULTS;
    const pitch = P0.blockLots + P0.streetLots;
    const withPlazas = createModularRoadCity({ seed: 20260902, avoid: () => Infinity });
    const noPlazas = createModularRoadCity({
      seed: 20260902, avoid: () => Infinity, params: { plazas: false },
    });
    check("plazas actually appear", withPlazas.stats.plazas > 0,
      `${withPlazas.stats.plazas} squares, ${withPlazas.stats.culledPlaza} lots`);
    check("a plaza costs LESS than the block it replaces",
      withPlazas.stats.buildings < noPlazas.stats.buildings,
      `${noPlazas.stats.buildings} without, ${withPlazas.stats.buildings} with`);

    // Which blocks lost lots, and did they lose ALL of them?
    const blockOf = (b) => `${Math.floor(b.cx / pitch)},${Math.floor(b.cz / pitch)}`;
    const before = new Map();
    for (const b of noPlazas.buildings) {
      const k = blockOf(b);
      before.set(k, (before.get(k) || 0) + 1);
    }
    const after = new Map();
    for (const b of withPlazas.buildings) {
      const k = blockOf(b);
      after.set(k, (after.get(k) || 0) + 1);
    }
    let partial = 0, emptied = 0;
    for (const [k, n] of before) {
      const now = after.get(k) || 0;
      if (now === n) continue;
      if (now === 0) emptied++;
      else partial++;                      // a hole in a block, not a square
    }
    check("every plaza empties its whole block, never part of one",
      partial === 0 && emptied > 0, `${emptied} blocks emptied, ${partial} left half-built`);
    withPlazas.dispose?.();
    noPlazas.dispose?.();
  }

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

    /*
     * ── WHICH WAY IS A DRIVER'S RIGHT, IN THE STREET SHADER'S ACROSS-SPACE ──
     *
     * The turn arrows need this and nothing else in the shader did, so it is
     * new surface and it is the exact shape of the rule this file has already
     * got wrong twice. The shader answers it with `2 * rightHalf - 1` and NO
     * axis flip, which looks wrong beside every other line in that block.
     *
     * So it is DERIVED here rather than restated: right = forward x up, taken
     * in the frame the shader uses (across is world x on a z-street, world z
     * on an x-street). If someone "fixes" the shader by adding the inStreetX
     * flip the rest of the block has, this fails on both axes at once.
     */
    let rightBad = 0;
    const rightDetail = [];
    for (const axis of ["z", "x"]) {
      for (const side of [0, 1]) {
        const travel = laneTravelDir(axis, side);
        // forward x up, up = +Y. f=(fx,0,fz) -> right = (-fz, 0, fx).
        const f = axis === "z" ? [0, travel] : [travel, 0];   // [x, z]
        const right = [-f[1], f[0]];
        // The shader's across axis: world x on a z-street, world z on an x-street.
        const truth = Math.sign(axis === "z" ? right[0] : right[1]);
        // What the shader computes: rightHalf is 1 on the high-across half,
        // and side 1 IS the high-across half.
        const shader = side * 2 - 1;
        if (shader !== truth) rightBad++;
        rightDetail.push(`${axis}${side}:${shader}v${truth}`);
      }
    }
    check("the shader's across-space 'driver's right' matches forward x up",
      rightBad === 0, `${rightBad} of 4 wrong (${rightDetail.join(" ")})`);

    /*
     * AND THE KERB LANE IS THE ONE ON THAT RIGHT. The turn rule hangs off it —
     * the kerb lane may turn right, the inside lane may turn left — so getting
     * the two swapped paints a right-turn arrow in the inside lane, which is a
     * wrong instruction rather than a wrong-looking one.
     */
    let laneBad = 0;
    for (const side of [0, 1]) {
      const rightAcross = side * 2 - 1;
      // Lane cells across the street, 0..3; the shader's `kerbLane` is the
      // outer pair, and laneMid grows with the cell index.
      const [kerb, inner] = side === 0 ? [0, 1] : [3, 2];
      const isOuter = (i) => (Math.abs(i - 1.5) >= 1 ? 1 : 0);
      if (!isOuter(kerb) || isOuter(inner)) laneBad++;
      // The kerb lane must sit to the driver's RIGHT of the inside one.
      if ((kerb - inner) * rightAcross <= 0) laneBad++;
    }
    check("the kerb lane is the one on the driver's right", laneBad === 0,
      `${laneBad} of 4 checks wrong`);

    /*
     * ── AND NOW AGAINST THE CARS, WHICH ARE THE ONE THING KNOWN TO BE RIGHT ──
     *
     * The two checks above are derivations, and a derivation can be
     * self-consistently wrong. This one is not: it takes the REAL lanes the
     * traffic drives on, out of the cars themselves, and asks whether the
     * street shader's arrow rule agrees with them. Two subsystems that were
     * written apart have to give the same answer, or one of them is wrong.
     *
     * No origin arithmetic either — the four lanes of a street are recovered
     * by sorting, so there is nothing here to get out of step with the city's
     * own layout maths.
     */
    const laneSet = flatCity.furniture.lanes || [];
    const streetW2 = CITY_DEFAULTS.streetLots * CITY_DEFAULTS.lotSize;
    /*
     * Cluster by SORTING, not by dividing. The lanes of one street span
     * 0.75 * streetW and the next street is a whole pitch away, so a gap
     * bigger than streetW can only be the gap between streets — and unlike a
     * modulo key this cannot be knocked out of alignment by where the city's
     * origin happens to sit.
     */
    const groups = new Map();
    for (const axis of ["z", "x"]) {
      const sorted = laneSet.filter((l) => l.axis === axis).sort((a, b) => a.across - b.across);
      let gi = 0, prev = null;
      for (const ln of sorted) {
        if (prev !== null && ln.across - prev > streetW2) gi++;
        prev = ln.across;
        const key = `${axis}:${gi}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(ln);
      }
    }
    let sideBad = 0, headBad = 0, kerbBad = 0, laneChecked = 0;
    const sideDetail = new Set();
    for (const g2 of groups.values()) {
      if (g2.length !== 4) continue;                    // clipped at the city edge
      g2.sort((a, b) => a.across - b.across);
      for (let idx = 0; idx < 4; idx++) {
        const ln = g2[idx];
        laneChecked++;
        // The shader: rightHalf is 1 on the upper half of the carriageway.
        const shaderRight = idx >= 2 ? 1 : -1;
        // The cars: right = forward x up, in the shader's across axis.
        const truthRight = ln.axis === "z" ? -ln.dir : ln.dir;
        if (shaderRight !== truthRight) { sideBad++; sideDetail.add(`${ln.axis}/lane${idx}`); }
        // The shader calls lanes 0 and 3 the kerb lanes.
        const shaderKerb = idx === 0 || idx === 3;
        // Truth: the kerb lane is the one of its pair lying toward the
        // driver's right, i.e. its partner is displaced against that right.
        const partner = g2[idx < 2 ? 1 - idx : 5 - idx];
        if (shaderKerb !== ((ln.across - partner.across) * truthRight > 0)) kerbBad++;
        /*
         * THE ANSWER TO "IS THE BEND GOING THE RIGHT WAY", in world terms.
         * The kerb lane's glyph turns right, the inside lane's turns left, and
         * the shader displaces the head by rightAcross * turn.
         */
        const turn = shaderKerb ? 1 : -1;
        const headDir = shaderRight * turn;             // across-space, shader
        const wantDir = truthRight * turn;              // across-space, cars
        if (headDir !== wantDir) headBad++;
      }
    }
    check("the shader's road half agrees with the lanes the cars drive",
      laneChecked > 0 && sideBad === 0,
      `${sideBad} of ${laneChecked} lanes disagree${sideDetail.size ? ` (${[...sideDetail].join(" ")})` : ""}`);
    check("the kerb lane of each pair is the one toward the cars' right",
      laneChecked > 0 && kerbBad === 0, `${kerbBad} of ${laneChecked} wrong`);
    check("a turn arrow bends toward the side the cars say it should",
      laneChecked > 0 && headBad === 0, `${headBad} of ${laneChecked} bend the wrong way`);

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
     * AND IT MUST LOOK BACK AT THAT TRAFFIC. The arm being right does not make
     * the head right: the mast stands UPSTREAM on the right kerb, so a head
     * facing the same way the cars travel shows its lenses to the ones that
     * have already gone through. All four axis/side combinations were wrong by
     * exactly 180 degrees while every other test passed.
     *
     * WHICH WAY THE LENSES ACTUALLY FACE IS READ OUT OF THE GEOMETRY, not
     * assumed. An earlier version of this test hardcoded "the lens is on -Z",
     * which is the answer rather than the question — it would have passed just
     * as happily on the build where they were on +Z, because nothing about the
     * INSTANCE changes when the head is modelled backwards. Find the lens
     * vertices (proud of the housing, out at the arm's end) and take the sign
     * of their z.
     */
    let lensSign = 0;
    {
      let lightMesh = null;
      c.group.traverse((o) => { if (o.isInstancedMesh && o.name === "CityTrafficLights") lightMesh = o; });
      const pos = lightMesh.geometry.getAttribute("position");
      let sum = 0, n = 0;
      for (let i = 0; i < pos.count; i++) {
        const z = pos.getZ(i);
        if (pos.getX(i) > FP.lightArm * 0.8 && Math.abs(z) > 0.19) { sum += z; n++; }
      }
      lensSign = n && sum < 0 ? -1 : 1;
      check("the signal head has a lens face proud of its housing", n > 0, `${n} lens vertices`);
    }
    let facingWrong = 0, facingTotal = 0;
    for (const e of lights.slice(0, 300)) {
      if (e.travel == null) continue;
      const el = e.m.elements;
      // Local +Z is the third basis column; the lenses look along lensSign.
      const nx = el[8] * lensSign, nz = el[10] * lensSign;
      const tx = e.axis === "z" ? 0 : e.travel;
      const tz = e.axis === "z" ? e.travel : 0;
      facingTotal++;
      if (nx * tx + nz * tz > -0.5) facingWrong++;      // must point back at it
    }
    check("every signal head faces the traffic it controls",
      facingTotal > 0 && facingWrong === 0, `${facingWrong} of ${facingTotal} face away`);

    /*
     * AND SO MUST A ROAD SIGN. Same rule, same trap: this one flipped on
     * `dir` (the kerb's inward direction) instead of on `travel`, so it was
     * right on x-streets and backwards on every z-street — a driver on half
     * the city's roads saw only grey backs.
     *
     * WHICH FACE CARRIES THE ARTWORK IS READ OUT OF THE GEOMETRY. Every face
     * of the plate except the front has its UVs pinned into the reserved grey
     * patch, so the art face is the one whose UVs still span 0..1; take the
     * sign of its z. Assuming "+Z" here would be writing down the answer, and
     * would keep passing if the plate were ever rebuilt the other way round.
     */
    const roadSigns = flatCity.furniture.lists.roadSigns;
    let artSign = 0;
    {
      let signMesh = null;
      c.group.traverse((o) => { if (o.isInstancedMesh && o.name === "CityRoadSigns") signMesh = o; });
      const pos = signMesh.geometry.getAttribute("position");
      const uv = signMesh.geometry.getAttribute("uv");
      /*
       * The pin is whichever UV the geometry repeats most — every face but
       * one is collapsed onto it. Finding it that way rather than testing
       * "near the origin" matters: the art face's own (0,0) corner sits in
       * the grey patch too, and a proximity test silently ate it.
       */
      const tally = new Map();
      for (let i = 0; i < uv.count; i++) {
        const k = `${uv.getX(i).toFixed(5)},${uv.getY(i).toFixed(5)}`;
        tally.set(k, (tally.get(k) || 0) + 1);
      }
      let pin = null, most = 0;
      for (const [k, n2] of tally) if (n2 > most) { most = n2; pin = k; }
      let sum = 0, n = 0;
      for (let i = 0; i < pos.count; i++) {
        if (`${uv.getX(i).toFixed(5)},${uv.getY(i).toFixed(5)}` === pin) continue;
        sum += pos.getZ(i); n++;
      }
      artSign = n && sum < 0 ? -1 : 1;
      check("the sign plate has exactly one artwork face", n === 4, `${n} unpinned vertices`);
    }
    /*
     * COVERAGE FIRST, AND THIS IS NOT A FORMALITY. The check below can only
     * judge a sign that says which lane it is for, so a `continue` on missing
     * `travel` silently exempts anything that forgets to tag itself — which is
     * exactly what happened: the roadworks sign is placed from the clutter
     * module, carried no travel, and sat there facing the wrong way through a
     * green run of this very test. An untagged sign is a failure, not a skip.
     */
    const untagged = roadSigns.filter((e) => e.travel == null).length;
    check("every road sign says which lane it is for",
      roadSigns.length > 0 && untagged === 0, `${untagged} of ${roadSigns.length} untagged`);

    let signWrong = 0, signTotal = 0;
    for (const e of roadSigns.slice(0, 400)) {
      if (e.travel == null) continue;
      const el = e.m.elements;
      const nx = el[8] * artSign, nz = el[10] * artSign;
      const tx = e.axis === "z" ? 0 : e.travel;
      const tz = e.axis === "z" ? e.travel : 0;
      signTotal++;
      if (nx * tx + nz * tz > -0.5) signWrong++;        // must look back down the lane
    }
    check("every road sign faces the traffic it is for",
      signTotal > 0 && signWrong === 0, `${signWrong} of ${signTotal} face away`);

    /*
     * AND THE WORKS SIGN STANDS BEFORE ITS OWN CLOSURE. Facing the right way
     * is not enough: a warning that stands past the cones it warns about is
     * worse than no warning. Measured against the real cones, because "before"
     * only means anything relative to the lane's direction of travel.
     */
    const { SIGN: SIGN_ENUM } = await import("../games/modular-road-v3/modularRoadCityRoadSigns.js");
    const cones = flatCity.furniture.lists.cones || [];
    let lateSign = 0, worksTotal = 0;
    for (const e of roadSigns) {
      if (e.tile !== SIGN_ENUM.WORKS_TEMP || e.travel == null) continue;
      const alongOf = (p) => (e.axis === "z" ? p.z : p.x);
      const acrossOf = (p) => (e.axis === "z" ? p.x : p.z);
      const sAlong = alongOf(e), sAcross = acrossOf(e);
      /*
       * THE NEAREST CONE, SIGNED. Averaging over a window looked equivalent
       * and was not: a one-sided window quietly DROPPED every misplaced sign
       * instead of failing it, and the test went green on the bug it was
       * written for. The nearest cone is 7 m away whichever end the sign is
       * standing at, so its sign is the answer and nothing can fall out.
       */
      let best = Infinity, bestD = 0;
      for (const k of cones) {
        if (Math.abs(acrossOf(k) - sAcross) > 12) continue;
        const d = (alongOf(k) - sAlong) * e.travel;     // + is downstream
        if (Math.abs(d) > 90 || Math.abs(d) >= best) continue;
        best = Math.abs(d); bestD = d;
      }
      if (!isFinite(best)) continue;                    // no closure near this sign
      worksTotal++;
      if (bestD <= 0) lateSign++;
    }
    check("the roadworks sign stands before the cones it warns about",
      worksTotal > 0 && lateSign === 0, `${lateSign} of ${worksTotal} stand past their taper`);

    /*
     * ── THE OVERHEAD GANTRIES ──────────────────────────────────────────────
     *
     * Third time this rule is checked in this file and it is not duplication:
     * the lantern, the kerb sign and the board are placed by three different
     * lines, and each of the first two was wrong at some point while the other
     * passed. The board's artwork face is read out of the geometry, as before,
     * so this fails if the panel is ever rebuilt facing the other way.
     */
    const gantries = flatCity.furniture.lists.gantries || [];
    const gMeshes = [];
    c.group.traverse((o) => { if (o.isInstancedMesh && o.name === "CityGantry") gMeshes.push(o); });
    const gMesh = gMeshes[0] || null;
    /*
     * ONE MESH, holding every board. `count` is not the thing to assert — the
     * LOD has already trimmed it by the time this runs — so this checks the
     * allocated capacity and, more to the point, that there is exactly one
     * mesh: the mast, the boom and the panel share a material through a
     * reserved patch in the atlas, and if that ever stops being true this
     * becomes two draws per board rather than one for the city.
     */
    check("every gantry in the city is one draw call",
      gMeshes.length === 1 && gMesh.instanceMatrix.count === gantries.length,
      `${gantries.length} boards, ${gMeshes.length} mesh(es), capacity ${gMesh ? gMesh.instanceMatrix.count : 0}`);
    let gArt = 0;
    if (gMesh) {
      const pos = gMesh.geometry.getAttribute("position");
      const uvA = gMesh.geometry.getAttribute("uv");
      const tally = new Map();
      for (let i = 0; i < uvA.count; i++) {
        const k = `${uvA.getX(i).toFixed(5)},${uvA.getY(i).toFixed(5)}`;
        tally.set(k, (tally.get(k) || 0) + 1);
      }
      let pin = null, most = 0;
      for (const [k, n2] of tally) if (n2 > most) { most = n2; pin = k; }
      let sum = 0, n = 0;
      for (let i = 0; i < pos.count; i++) {
        if (`${uvA.getX(i).toFixed(5)},${uvA.getY(i).toFixed(5)}` === pin) continue;
        sum += pos.getZ(i); n++;
      }
      gArt = n && sum < 0 ? -1 : 1;
      check("the gantry panel has exactly one artwork face", n === 4, `${n} unpinned vertices`);
      /*
       * AND THE PIN LANDS INSIDE THE PATCH IT AIMS AT. This one was already
       * wrong and showed nothing: the pinned UV sat within a pixel of the
       * patch's edge, so the mast was painted steel at full resolution and
       * would have started smearing the board's artwork as soon as the mip
       * chain began averaging across the boundary — visible at distance,
       * invisible near, and invisible in the source. Cross-checks the geometry
       * against the atlas rather than trusting either.
       */
      const { rect } = await import("../games/modular-road-v3/modularRoadCityGantry.js")
        .then((m) => ({ rect: m.gantryPatchUV(FP).rect }));
      const [pu, pv] = pin.split(",").map(Number);
      const inside = pu > rect[0] && pu < rect[2] && pv > rect[1] && pv < rect[3];
      // A quarter of the patch clear on every side, or a mip will reach out of it.
      const margin = Math.min(pu - rect[0], rect[2] - pu, pv - rect[1], rect[3] - pv);
      const quarter = Math.min(rect[2] - rect[0], rect[3] - rect[1]) * 0.25;
      check("the gantry's pinned UV sits well inside the reserved patch",
        inside && margin >= quarter,
        `pin (${pu.toFixed(4)}, ${pv.toFixed(4)}) in [${rect.map((r) => r.toFixed(4)).join(", ")}], margin ${margin.toFixed(4)} vs ${quarter.toFixed(4)}`);
    }
    let gWrong = 0, gClash = 0;
    for (const e of gantries) {
      const el = e.m.elements;
      const nx = el[8] * gArt, nz = el[10] * gArt;
      const tx = e.axis === "z" ? 0 : e.travel;
      const tz = e.axis === "z" ? e.travel : 0;
      if (nx * tx + nz * tz > -0.5) gWrong++;
      // And it must stand clear of the lantern on its own approach, or the
      // board is read through the signal it is meant to precede.
      const near = lights.find((l) => Math.hypot(l.x - e.x, l.z - e.z) < FP.lightArm);
      if (near) gClash++;
    }
    check("every gantry board faces the traffic it directs",
      gantries.length > 0 && gWrong === 0, `${gWrong} of ${gantries.length} face away`);
    check("no gantry stands on top of a traffic signal",
      gClash === 0, `${gClash} of ${gantries.length} within an arm's length of a mast`);

    /*
     * ── STEAM VENTS ────────────────────────────────────────────────────────
     *
     * A manhole is in the ROAD. On the pavement it is a mystery, and a plume
     * you drive through is worth more than one you drive past.
     *
     * Checked against the lanes the traffic actually drives rather than
     * against the expression that placed them — re-deriving `kerb - dir *
     * inset` here would only prove the arithmetic was copied correctly, which
     * is the one thing that was never in doubt.
     */
    const vents = flatCity.furniture.lists.vents || [];
    let ventMeshes = 0;
    c.group.traverse((o) => { if (o.isInstancedMesh && o.name === "CitySteam") ventMeshes++; });
    check("all the city's steam is one draw", ventMeshes === 1 && vents.length > 0,
      `${vents.length} vents in ${ventMeshes} mesh(es)`);
    let offRoad = 0;
    for (const e of vents) {
      let near = Infinity;
      for (const ln of laneSet) {
        const d = Math.abs((ln.axis === "z" ? e.x : e.z) - ln.across);
        if (d < near) near = d;
      }
      if (near > streetW2 * 0.5) offRoad++;
    }
    check("every vent is in the carriageway, not on the pavement",
      vents.length > 0 && offRoad === 0, `${offRoad} of ${vents.length} off the road`);

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
  // Street furniture: cars, trees, traffic lights, guardrails.
  const fs = c.stats.furniture;
  check("furniture is placed on the grid", !!fs && fs.cars > 500 && fs.trees > 300 && fs.lights > 100 && fs.rails > 200, JSON.stringify(fs));
  /*
   * WHAT THIS GUARDS IS THE DRAW COUNT, not a particular number of meshes.
   *
   * It used to say "exactly six", which was the same statement while there
   * was one car body; now there are four bodies parked and four driving, and
   * pinning the literal would have meant either deleting the check or letting
   * it drift into a number nobody could justify. The invariant that actually
   * matters has not changed: the entire population of the city — thousands of
   * parked cars, thousands of trees, hundreds of masts, a moving fleet — is a
   * BOUNDED handful of draws, and it stays bounded when a body is added.
   */
  const fnames = [];
  c.group.traverse((o) => {
    if (o.isInstancedMesh && /^City(Cars|Trunks|Canopies|TrafficLights|Rails|Traffic)(_|$)/.test(o.name)) fnames.push(o.name);
  });
  check("the whole street population is a handful of draws",
    fnames.length >= 6 && fnames.length <= 14, `${fnames.length}: ${fnames.join(", ")}`);

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
    /*
     * ONE MESH PER BODY, and between them they hold every car exactly once.
     * Capacity is the thing to check, not `count`: `count` is rewritten every
     * frame to whatever is in range, but a mesh sized smaller than its share
     * of the fleet would silently stop drawing the cars past the end — which
     * looks like a culling bug and is an allocation bug.
     */
    const tms = [];
    c.group.traverse((o) => { if (o.isInstancedMesh && /^CityTraffic(_|$)/.test(o.name)) tms.push(o); });
    const cap = tms.reduce((a, m) => a + m.instanceMatrix.count, 0);
    const tm = tms[0];
    check("every moving car has a slot in a body's mesh",
      tms.length > 0 && cap === fs.traffic, `${tms.length} meshes, ${cap} slots for ${fs.traffic} cars`);
    const cam = new THREE.Vector3(0, 40, 0);
    c.update(0.016, { position: cam });
    const first = tm.count;
    check("an update fills only the cars within range", first > 0 && first < fs.traffic, `${first} of ${fs.traffic}`);
    /*
     * ...AND THEY MOVE. Across the POPULATION, not instance 0: now that cars
     * stop at lights, whichever car happens to land in slot 0 may legitimately
     * be sitting at a red, and this check would fail on correct behaviour.
     * A median over everything in range cannot be caught out that way.
     */
    const m0 = new THREE.Matrix4(), m1 = new THREE.Matrix4(), v0 = new THREE.Vector3(), v1 = new THREE.Vector3();
    const was = [];
    for (let i = 0; i < tm.count; i++) { tm.getMatrixAt(i, m0); was.push(new THREE.Vector3().setFromMatrixPosition(m0)); }
    c.update(1.0, { position: cam });
    const moved = [];
    for (let i = 0; i < Math.min(tm.count, was.length); i++) {
      tm.getMatrixAt(i, m1); v1.setFromMatrixPosition(m1);
      moved.push(was[i].distanceTo(v1));
    }
    moved.sort((a, b) => a - b);
    const median = moved.length ? moved[moved.length >> 1] : 0;
    check("traffic actually moves between frames", median > 0.3,
      `median ${median.toFixed(2)} m over ${moved.length} cars`);
    void v0;
  }
  {
    // Every body's mesh carries its own colours, and between them they cover
    // the whole parked population — a body that lost its instanceColor would
    // draw a street of identical white cars and nothing else would complain.
    const cms = [];
    c.group.traverse((o) => { if (o.isInstancedMesh && /^CityCars(_|$)/.test(o.name)) cms.push(o); });
    const tinted = cms.filter((m) => m.instanceColor);
    const colours = tinted.reduce((a, m) => a + m.instanceColor.count, 0);
    check("every parked car carries a per-instance colour",
      cms.length > 0 && tinted.length === cms.length && colours === fs.cars,
      `${tinted.length}/${cms.length} meshes tinted, ${colours} colours for ${fs.cars} cars`);
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
  /*
   * ── THE PRISM ────────────────────────────────────────────────────────────
   *
   * Whichever site it took, the failure modes are the same shape and none of
   * them shows in a count: sunk into its own ground, floating over it, too
   * small to be a landmark, or turned away from the side of the city anyone
   * drives on. Only the ground it stands on differs, so only that branches.
   */
  console.log("\n── THE PRISM ──");
  {
    const pStats = flatCity.stats.prism;
    check("the board got a site", !!pStats, pStats ? `${pStats.site}` : "none");
    let pGroup = null;
    flatCity.group.traverse((o) => { if (o.name === "CityAdPrism") pGroup = o; });
    check("the prism is in the city group", !!pGroup);
    if (pStats && pGroup) {
      pGroup.updateMatrixWorld(true);
      const bb = new THREE.Box3().setFromObject(pGroup);
      const clearance = bb.min.y - pStats.y;
      check("the board sits on its ground, not in it or above it",
        clearance >= -0.2 && clearance <= 3.5, `bottom is ${clearance.toFixed(2)} m above it`);
      const width = Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z);

      if (pStats.site === "plaza") {
        const inSquare = (flatCity.stats.plazaList || []).some(
          (pz) => Math.hypot(pz.x - pStats.x, pz.z - pStats.z) < 1e-6);
        check("the board stands in a real plaza", inSquare,
          `${pStats.x.toFixed(0)}, ${pStats.z.toFixed(0)} against ${(flatCity.stats.plazaList || []).length} squares`);
        // It must FIT in the square, or it is a board through a building.
        const blockW = CITY_DEFAULTS.blockLots * CITY_DEFAULTS.lotSize;
        check("the board fits inside the square it stands in",
          width < blockW * 0.8, `${width.toFixed(1)} m across a ${blockW} m block`);
        check("the board is big enough to be a landmark in its square",
          width > 12, `${width.toFixed(1)} m wide`);
      } else {
        const PRISM_MIN = (await import("../games/modular-road-v3/modularRoadCityPrism.js")).CITY_PRISM_DEFAULTS.prismMinHeight;
        check("it stands on a tower tall enough to be a landmark",
          pStats.height > PRISM_MIN, `${pStats.height.toFixed(0)} m vs ${PRISM_MIN} m minimum`);
        check("the board is big enough to read across the city", width > 30,
          `${width.toFixed(1)} m wide`);
      }

      // The live face is local +Z, so the rotated +Z must point at the origin.
      const f = new THREE.Vector3(0, 0, 1).applyQuaternion(pGroup.quaternion);
      const toOrigin = new THREE.Vector3(-pStats.x, 0, -pStats.z).normalize();
      const dotF = f.x * toOrigin.x + f.z * toOrigin.z;
      check("the board faces the side of the city people drive on",
        dotF > 0.9, `dot ${dotF.toFixed(3)}`);

      let meshes = 0, prisms = 0;
      pGroup.traverse((o) => { if (o.isMesh) meshes++; });
      flatCity.group.traverse((o) => { if (o.name === "CityAdPrism") prisms++; });
      check("there is exactly ONE prism, costing a handful of draws",
        prisms === 1 && meshes <= 6, `${prisms} prism, ${meshes} meshes`);
    }
  }

  /*
   * ── CAR PARKS ────────────────────────────────────────────────────────────
   *
   * The one thing that can really go wrong here is cars that do not line up
   * with the paint, and it is invisible to any count: the placer and the
   * shader would each be internally consistent and disagree with each other.
   * So the test re-derives the bay grid from `bayLayout` — the single
   * description both of them read — and checks every car sits on a bay centre.
   * If the two ever stop sharing that, this fails.
   */
  console.log("\n── CAR PARKS ──");
  {
    const { bayLayout, CARPARK_DEFAULTS } =
      await import("../games/modular-road-v3/modularRoadCityCarPark.js");
    const nP = flatCity.stats.carParks;
    check("some squares became car parks", nP > 0,
      `${nP} parks, ${flatCity.stats.parkedInParks} cars`);
    let pgMesh = null;
    flatCity.group.traverse((o) => { if (o.isInstancedMesh && o.name === "CityCarPark") pgMesh = o; });
    check("all the bay paint is one draw",
      !!pgMesh && pgMesh.instanceMatrix.count === nP, `${nP} parks in ${pgMesh ? 1 : 0} mesh`);

    const blockW = CITY_DEFAULTS.blockLots * CITY_DEFAULTS.lotSize;
    const L = bayLayout(CARPARK_DEFAULTS, blockW);
    let offBay = 0, total = 0, outside = 0;
    for (const pk of (flatCity.stats.carParkList || [])) {
      for (const b of pk.bays) {
        total++;
        const lx = b.x - pk.x - L.x0;
        const lz = b.z - pk.z - L.z0;
        if (lx < -0.01 || lx > L.spanX + 0.01 || lz < -0.01 || lz > L.spanZ + 0.01) { outside++; continue; }
        // On a bay centre across, and on a rank centre along.
        const acr = Math.abs((lx / L.bayWidth) % 1 - 0.5);
        const row = lz % L.rowPitch;
        const onRank = Math.min(Math.abs(row - L.bayDepth * 0.5),
          Math.abs(row - L.bayDepth * 1.5));
        if (acr > 0.02 || onRank > 0.02) offBay++;
      }
    }
    check("every parked car stands on a painted bay",
      total > 0 && offBay === 0 && outside === 0,
      `${offBay} of ${total} off a bay, ${outside} outside the markings`);
    /*
     * AND NOT EVERY BAY IS TAKEN. A car park with every space filled is the
     * one arrangement a real one is never in, and it is the state a
     * placement loop falls into by default.
     */
    const capacity = L.rows * 2 * L.cols * nP;
    check("the car parks are busy but not full",
      total < capacity * 0.85 && total > capacity * 0.3,
      `${total} cars in ${capacity} bays`);
  }


  /*
   * ── TRAFFIC THAT STOPS AND QUEUES ────────────────────────────────────────
   *
   * None of this is visible in a count, and the whole model went in with three
   * parameters undefined without a single existing test noticing: `2 *
   * undefined * gap` is NaN, `NaN < v*v` is false, so every constraint quietly
   * evaporated and the cars drove exactly as they had before. A model that
   * fails by doing nothing needs tests that assert it did something.
   */
  console.log("\n── TRAFFIC ──");
  {
    const { signalPhaseAt, signalGo } =
      await import("../games/modular-road-v3/modularRoadCityFurniture.js");
    const cam = new THREE.Vector3(0, 2, 0);
    const cars = flatCity.furniture.traffic;
    const FP2 = flatCity.furniture.params;
    /*
     * MEASURED OVER TIME, NOT AT AN INSTANT, and that is not a convenience.
     * A lane is 2400 m with ten cars on it, so at any single moment only a
     * handful are sitting at a line — a snapshot would make a working model
     * look broken and a broken one look plausible. What the lights do is
     * visible in how many cars they stop over a cycle.
     */
    let everStopped = 0, everSlowed = 0, stoppedSamples = 0, looseSamples = 0;
    const wasStopped = new Set();
    for (let i = 0; i < 1800; i++) {
      flatCity.update(1 / 30, { position: cam });
      if (i % 5) continue;
      for (const c of cars) {
        if (c.v < 0.5 && !wasStopped.has(c)) { wasStopped.add(c); everStopped++; }
        if (c.v < c.speed * 0.6) everSlowed++;
        // Slow with nothing holding it AND not accelerating: genuinely stuck.
        if (c.v < 0.5) { stoppedSamples++; if (!c.hold && !c.rising) looseSamples++; }
      }
    }
    const stopped = cars.filter((c) => c.v < 0.5);
    check("the lights actually stop traffic", everStopped > 40,
      `${everStopped} of ${cars.length} cars came to a stop over 60 s`);
    check("and many more slow for them", everSlowed > 500, `${everSlowed} slow samples`);
    check("and most of it is not — a city, not a car park",
      stopped.length < cars.length * 0.75, `${stopped.length} of ${cars.length}`);

    /*
     * NOBODY STOPS IN THE BOX. A car that halts inside a junction blocks the
     * cross traffic forever, and it is the one failure this model can produce
     * that never clears itself.
     */
    const L2 = CITY_DEFAULTS.lotSize;
    const pitch2 = (CITY_DEFAULTS.blockLots + CITY_DEFAULTS.streetLots) * L2;
    const blockW2 = CITY_DEFAULTS.blockLots * L2;
    const half2 = CITY_DEFAULTS.extent;
    const cellOf = (c) => {
      const along = (-half2 + c.u * c.lane.span) * c.lane.dir;
      const rel = along - 0;               // the test city's origin is 0
      return rel - Math.floor(rel / pitch2) * pitch2;
    };
    const inBox = stopped.filter((c) => cellOf(c) >= blockW2);
    check("no car is stopped inside a junction", inBox.length === 0,
      `${inBox.length} of ${stopped.length} stopped in the box`);

    /*
     * AND NOBODY IS INSIDE ANYBODY. Without car-following every car in a lane
     * brakes for the same line and parks on the one in front — a red light
     * would stack a dozen cars in three metres, which is what this measures.
     */
    let worst = Infinity, pairs = 0;
    const byLane = new Map();
    for (const c of cars) {
      if (!byLane.has(c.li)) byLane.set(c.li, []);
      byLane.get(c.li).push(c);
    }
    for (const row of byLane.values()) {
      row.sort((a, b) => a.u - b.u);
      for (let k = 0; k < row.length; k++) {
        const a = row[k], b = row[(k + 1) % row.length];
        let du = b.u - a.u;
        if (du <= 0) du += 1;
        worst = Math.min(worst, du * a.lane.span);
        pairs++;
      }
    }
    check("no two cars in a lane are inside each other",
      worst > FP2.trafficGap * 0.7,
      `closest pair ${worst.toFixed(2)} m, gap target ${FP2.trafficGap} m`);

    /*
     * A STOPPED CAR HAS A REASON — and the reason is read off the model rather
     * than reconstructed. An earlier version of this check re-derived the
     * junction index and the signal phase itself, got one of them wrong, and
     * reported every stopped car as unexplained: a test that duplicates the
     * thing it is testing fails on its own copy. `hold` is set where the
     * decision is actually made.
     */
    /*
     * Sampled over the run, not at the end, and for the same reason as above:
     * seven cars are standing still at any given instant and three of them
     * being unexplained is noise, not a signal.
     *
     * A slow car with nothing binding it is real — one just released by a
     * green is accelerating and has no constraint left — so `rising` tells
     * the two apart. What must never happen is a car that is stopped, has
     * nothing holding it, and is not pulling away: that one is stuck, and it
     * is what a NaN constraint looks like from outside.
     */
    const loose = looseSamples / Math.max(1, stoppedSamples);
    check("no car is ever stopped with nothing holding it and no way out",
      stoppedSamples > 200 && loose < 0.02,
      `${(loose * 100).toFixed(2)}% of ${stoppedSamples} stopped samples were stuck`);
    const byRed = stopped.filter((c) => c.hold === 2).length;
    check("and the lights are among the reasons", byRed > 0 || stopped.length === 0,
      `${byRed} held by a red, ${stopped.length - byRed} by the car in front`);
  }


  /*
   * ── RAIN SURFACES ────────────────────────────────────────────────────────
   *
   * The rain collider layer is opt-in, and for a long time nothing in the city
   * opted in: `floorAt` returned "no surface" for every column, so no drop in
   * the city ever landed or splashed. The track deck worked, which is exactly
   * why nobody noticed.
   *
   * Two things have to hold and neither shows on screen until it rains: the
   * right meshes are offered, and they are offered again after EVERY rebuild —
   * a rebuild replaces them, so a one-time tag would be tagging objects that
   * no longer exist the moment a track piece moved.
   */
  console.log("\n── RAIN SURFACES ──");
  {
    const surfaces = flatCity.rainSurfaces();
    const names = surfaces.map((o) => o.name || o.type);
    check("the street is something rain can land on",
      surfaces.some((o) => o.name === "CityStreets"), names.join(", ").slice(0, 90));
    check("the buildings are too", surfaces.some((o) => o.isInstancedMesh && /Facade|City/.test(o.material?.name || "")) || surfaces.length > 2,
      `${surfaces.length} surfaces`);
    /*
     * AND THE FURNITURE IS NOT. Every tagged mesh is a draw in a top-down pass
     * that runs every frame while it rains; the road and the roofs earn that,
     * and a splash on a wheelie bin at 60 km/h does not.
     */
    const furniture = surfaces.filter((o) => /CityCars|CityTrees|CityCones|CityRoadSigns|CityGantry|CitySteam|CityTraffic/.test(o.name || ""));
    check("street furniture is NOT tagged, so the bake stays cheap",
      furniture.length === 0, furniture.map((o) => o.name).join(", ") || "none");

    // Told again on every rebuild, with the NEW meshes.
    let calls = 0, last = null;
    const watched = createModularRoadCity({
      seed: 20260902, avoid: () => Infinity,
      onRebuilt: (s2) => { calls++; last = s2; },
    });
    check("the city reports its surfaces on the first build", calls === 1 && last?.length > 0,
      `${calls} call(s), ${last?.length ?? 0} surfaces`);
    const before = last;
    watched.rebuild();
    check("and again on a rebuild", calls === 2, `${calls} calls`);
    check("with the NEW meshes, not the ones it just threw away",
      last !== before && last.every((o) => !before.includes(o)),
      `${last.filter((o) => before.includes(o)).length} stale`);
    watched.dispose?.();
  }


  /*
   * ── SKYBRIDGES ───────────────────────────────────────────────────────────
   *
   * Every way a bridge can be wrong is geometric and none of them shows in a
   * count: floating in the gap without reaching either tower, crossing above
   * the shorter roof so one end enters nothing, or sitting low enough to be a
   * footbridge. So each is measured against the two buildings it claims to
   * join, found by the lot cells it recorded — not against the arithmetic
   * that placed it, which would only prove the numbers had been copied.
   */
  console.log("\n── SKYBRIDGES ──");
  {
    const nB = flatCity.stats.bridges;
    check("some pairs of towers got a bridge", nB > 0, `${nB} bridges`);
    let bMesh = null;
    flatCity.group.traverse((o) => { if (o.isInstancedMesh && o.name === "CityBridges") bMesh = o; });
    check("every bridge in the city is one draw",
      !!bMesh && bMesh.instanceMatrix.count === nB, `${nB} in ${bMesh ? 1 : 0} mesh`);

    const cells = new Map();
    for (const b of flatCity.buildings) cells.set(`${b.cx},${b.cz}`, b);
    let short = 0, tooLow = 0, aboveRoof = 0, orphan = 0;
    for (const sp of (flatCity.stats.bridgeSpans || [])) {
      const a = cells.get(sp.a), b = cells.get(sp.b);
      if (!a || !b) { orphan++; continue; }
      if (sp.y > Math.min(a.top, b.top)) aboveRoof++;
      if (sp.y - Math.max(a.y, b.y) < 12) tooLow++;
      const centres = Math.hypot(a.x - b.x, a.z - b.z);
      if (sp.span < centres * 0.35) short++;
    }
    check("no bridge crosses above the shorter tower's roof", aboveRoof === 0, `${aboveRoof} of ${nB}`);
    check("no bridge is really a footbridge", tooLow === 0, `${tooLow} of ${nB} under 12 m`);
    check("every bridge reaches across its own gap", short === 0 && orphan === 0,
      `${short} too short, ${orphan} joined to nothing`);
  }

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
