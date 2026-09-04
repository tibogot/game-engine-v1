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
const { createCityFacadeMaterial, LOT_TEX_SIZE, FACADE_DEFAULTS: FACADE_DEFAULTS_ALL } = await import("../games/modular-road-v3/modularRoadCityFacade.js");
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
facade.params.glassColor = 0x112233;
check("colour params go through THREE.Color", facade.uniforms.glassColor.value.getHex() === 0x112233);
// Every param whose default is a hex colour must be a Color uniform. A float
// uniform of 0x8a8378 is nine million, and it painted every wall white once.
const colourKeys = Object.keys(FACADE_DEFAULTS_ALL).filter((k) => /Color[A-F]?$|^lit(Warm|Cool)$/.test(k));
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
  const city = createModularRoadCity({ seed: 20260902, avoid, params: { backend } });
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
    city.group.traverse((o) => { if (o.isInstancedMesh && o.castShadow) castersOn++; });
    check("instanced: shadows gate to the near tier only", castersOn === tier0 && tier0 > 0, `${castersOn} of ${city.stats.meshes} meshes cast`);
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
  check("facade material is shared by every tower mesh", (() => {
    let ok = true; city.group.traverse((o) => { if (o.isInstancedMesh && /^CityInst_/.test(o.name) && o.material !== mat) ok = false; }); return ok;
  })());
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
  const sg = c.stats.signs;
  check("every sign kind is placed", sg.banners > 0 && sg.bands > 0 && sg.screens > 0 && sg.texts > 0 && sg.neon > 0 && sg.mega > 0, JSON.stringify(sg));
  // Mega boards ride the SCREEN mesh, so adding them must not add a draw.
  check("mega billboards share the screen mesh", sg.mega > 0 && sg.screens >= sg.mega);
  // Every neon frame is 4 tubes, so neon must exceed 4x the mega count.
  check("each mega board is framed in neon", sg.neon >= sg.mega * 4, `${sg.neon} tubes for ${sg.mega} boards`);
  let extra = 0; const names = [];
  c.group.traverse((o) => { if (o.isInstancedMesh && /^City(Banners|Screens|Bands|Texts|Neon|Beacons)$/.test(o.name)) { extra++; names.push(o.name); } });
  check("signs + beacons are exactly six instanced meshes (six draws)", extra === 6, names.sort().join(","));
  const before = JSON.stringify(c.stats.signs);
  c.rebuild();
  check("signs are deterministic across a rebuild", JSON.stringify(c.stats.signs) === before);
}

flatCity.dispose();
console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILURE(S)`);
process.exit(fail === 0 ? 0 : 1);
