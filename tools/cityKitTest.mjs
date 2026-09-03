// City kit / facade / assembly harness — everything about the skyline that can
// be checked without a GPU.
//
// What it is guarding, in order of how expensive the bug would be to find later:
//
//  1. mergeGeometries returning NULL on an attribute mismatch. Silent, and the
//     symptom is an invisible city (see the mergeGeometries note in the repo's
//     history — a null merge produces a mesh that renders nothing at all).
//  2. LOD tiers disagreeing on silhouette. If L2's envelope is not exactly as
//     tall as L0, every tower visibly grows or shrinks as you drive past it.
//  3. Footprints spilling out of their lot. The facade identifies a building by
//     `floor(worldXZ / lotSize)`, so a tower wider than its lot changes tint
//     and window seed partway up — which reads as a shader bug and is not one.
//  4. The facade material actually building its node graph, including the
//     bloom MRT hookup, in the same three build the browser uses.
//  5. The LOD pass doing something as the camera moves, on BOTH backends.
import { register } from "node:module";

register("./threeWebgpuHook.mjs", import.meta.url);
const THREE = await import("three/webgpu");
const { buildCityKit, KIT_DEFAULTS } = await import("../games/modular-road-v3/modularRoadCityKit.js");
const { createCityFacadeMaterial, FACADE_DEFAULTS } = await import("../games/modular-road-v3/modularRoadCityFacade.js");
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
  // L0 -> L1 happens at ~220 m, where a changing roofline would be obvious, so
  // those two must agree EXACTLY on height. L1 drops ledges and string courses
  // only, which are facade detail.
  worstNear = Math.max(worstNear, Math.abs(l0.boundingBox.max.y - l1.boundingBox.max.y));
  // L2 is the massing envelope: the mast is deliberately not in it.
  worstMass = Math.max(worstMass, Math.abs(l2.boundingBox.max.y - a.massHeight));
  worstBase = Math.max(worstBase, Math.abs(l0.boundingBox.min.y));
  worstFoot = Math.max(worstFoot, a.footprint);
  // Detail must fall as the tier rises, or the LOD is buying nothing.
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

// Determinism — a seed has to give the same city twice or nothing is tunable.
const kitB = buildCityKit({ seed: 20260902 });
check(
  "same seed, same kit",
  kitB.archetypes.every((a, i) => Math.abs(a.height - kit.archetypes[i].height) < 1e-9),
);

// ── 2. Facade material ───────────────────────────────────────────────────────
console.log("\n── FACADE ──");
const facade = createCityFacadeMaterial({ params: { lotSize: 34 } });
check("material builds", !!facade.material && facade.material.isNodeMaterial === true);
// This is the check that caught the `Fn`-returning-an-object trap: property
// access on a collapsed Fn result is parsed as a swizzle, so every slot came
// back undefined and the material compiled to a default grey.
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
check(
  "lit windows opt into selective bloom",
  !!facade.material.mrtNode && !!facade.material.mrtNode.outputNodes?.emissive,
);
check("lotSize override reached the uniform", facade.uniforms.lotSize.value === 34);

facade.params.floorHeight = 4.25;
check("params proxy writes the uniform", facade.uniforms.floorHeight.value === 4.25);
facade.params.glassColor = 0x112233;
check(
  "colour params go through THREE.Color",
  facade.uniforms.glassColor.value.getHex() === 0x112233,
);

// ── 3. Assembly, both backends ───────────────────────────────────────────────
console.log("\n── ASSEMBLY ──");
const avoid = (x) => Math.abs(x);
const cam = new THREE.PerspectiveCamera(62, 1.6, 0.5, 8192);

for (const backend of ["batched", "instanced"]) {
  const city = createModularRoadCity({ seed: 20260902, avoid, params: { backend } });
  const n = city.stats.buildings;

  check(`${backend}: buildings placed`, n > 200, `${n} buildings`);

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
  check(
    `${backend}: LOD pass stays cheap`,
    city.stats.lastLodMs < 8,
    `${city.stats.lastLodMs.toFixed(2)} ms for ${n} buildings`,
  );

  if (backend === "batched") {
    check("batched: the whole city is one mesh", city.stats.meshes === 1);
  } else {
    check(
      "instanced: one mesh per archetype per tier",
      city.stats.meshes > 1 && city.stats.meshes <= kit.stats.count * 3,
      `${city.stats.meshes} meshes`,
    );
    // The reason to keep this backend at all.
    let casters = 0, tier0 = 0;
    city.group.traverse((o) => {
      if (!o.isInstancedMesh) return;
      if (o.castShadow) casters++;
      if (/_l0$/.test(o.name)) tier0++;
    });
    city.setShadows(true);
    let castersOn = 0;
    city.group.traverse((o) => { if (o.isInstancedMesh && o.castShadow) castersOn++; });
    check(
      "instanced: shadows gate to the near tier only",
      casters === 0 && castersOn === tier0 && tier0 > 0,
      `${castersOn} of ${city.stats.meshes} meshes cast`,
    );
  }

  // Triangle budget, which is the number that decides whether any of this is
  // affordable at all.
  const mix = nearSplit[0] * kit.stats.avgTrisL0
    + nearSplit[1] * kit.stats.avgTrisL1
    + nearSplit[2] * kit.stats.avgTrisL2;
  const allL0 = n * kit.stats.avgTrisL0;
  console.log(
    `       ${backend}: ${(mix / 1000).toFixed(0)}k tris with LOD, ` +
    `${(allL0 / 1000).toFixed(0)}k without (${(100 - (mix / allL0) * 100).toFixed(0)}% saved)`,
  );

  city.dispose();
}

// ── 4. Corridor ──────────────────────────────────────────────────────────────
console.log("\n── CORRIDOR ──");
{
  const wide = createModularRoadCity({ seed: 20260902, avoid, params: { avoidRadius: 200 } });
  const narrow = createModularRoadCity({ seed: 20260902, avoid, params: { avoidRadius: 0 } });
  check(
    "a wider keep-out clears more lots",
    wide.stats.buildings < narrow.stats.buildings,
    `${narrow.stats.buildings} → ${wide.stats.buildings} at 200 m`,
  );
  wide.dispose();
  narrow.dispose();
}

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILURE(S)`);
process.exit(fail === 0 ? 0 : 1);
