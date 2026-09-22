// ============================================================================
// REVO GRASS — the second grass system, and the parts of it that fail quietly.
//
//   · THE SHADERS COMPILING. Everything this system does happens on the GPU in
//     one compute pass and one vertex stage; a TSL mistake in either is a blank
//     field in a browser and nothing in a console. The headless builder answers
//     it without one.
//
//   · THE DRAW BEING INDIRECT. The compute compacts visible blades and writes
//     the instance count itself. If the geometry ever loses its indirect
//     attribute the mesh silently draws ONE instance — one blade, which reads
//     as "the grass did not load", not as a plumbing bug.
//
//   · THE CONFIG ARITHMETIC. count, spacing and the tile half-size have to
//     agree or the tile grows seams and bald rows as it wraps.
//
//   · THE SHARED CLIPMAP GROUND. Both grass systems stand blades on the same
//     helper now; the hybrid one must still be calling it.
// ============================================================================

const { buildWGSL, buildComputeWGSL, THREE, TSL } = await import("./wgslBuilderStub.mjs");
const { revoGrassConfig, createRevoGrassState, REVO_GRASS_QUALITY, REVO_GRASS_GEOMETRY_KEYS, REVO_GRASS_DEFAULTS, REVO_GRASS_PRESETS } =
  await import("../v3/app/state/revoGrassState.js");
const { RevoGrassSystem } = await import("../v3/render/grass/revoGrassSystem.js");
const { createRevoBladeGeometry } = await import("../v2/core/revoGrass/revoGrassGeometry.js");
const { createClipmapGroundY } = await import("../v2/core/terrain/clipmapGroundY.js");

let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n      ${detail}`}`);
  if (!ok) fail++;
};

const dataTex = (v) => {
  const t = new THREE.DataTexture(
    new Float32Array([v, v, v, 1]), 1, 1, THREE.RGBAFormat, THREE.FloatType,
  );
  t.needsUpdate = true;
  return t;
};

/* ── 1 · the config ───────────────────────────────────────────────────────── */

{
  const cfg = revoGrassConfig(createRevoGrassState());
  check("count is the grid squared", cfg.count === cfg.bladesPerSide ** 2, `${cfg.count}`);
  check("spacing tiles exactly", Math.abs(cfg.spacing * cfg.bladesPerSide - cfg.tileSize) < 1e-9);
  check("half-size is half", cfg.tileHalfSize * 2 === cfg.tileSize);
  check("every quality is a real grid", Object.values(REVO_GRASS_QUALITY)
    .every((q) => Number.isInteger(q.bladesPerSide) && q.bladesPerSide > 0));
  check("an unknown quality falls back rather than making NaN blades",
    Number.isInteger(revoGrassConfig({ quality: "nope" }).count));
  check("segments are clamped to what the blade builder can index",
    revoGrassConfig({ segments: 99 }).segments <= 8 && revoGrassConfig({ segments: 0 }).segments >= 1);
  check("a tiny tile cannot collapse the spacing to zero", revoGrassConfig({ tileSize: 0 }).spacing > 0);
}

{
  // Every key the panel and the save file touch must exist in the defaults, or
  // mergeKnownKeys drops it on load and the setting silently resets.
  const state = createRevoGrassState();
  check("the geometry keys all name real settings",
    REVO_GRASS_GEOMETRY_KEYS.every((k) => k in state), REVO_GRASS_GEOMETRY_KEYS.join());
  // Same rule for the camera-style presets — a preset key that is not a real
  // setting is a value that applies once and vanishes on the next save.
  const strayPreset = Object.entries(REVO_GRASS_PRESETS)
    .flatMap(([id, p]) => Object.keys(p.values).filter((k) => !(k in state)).map((k) => `${id}.${k}`));
  check("every preset value names a real setting", strayPreset.length === 0, strayPreset.join(", "));
  check("both camera styles say which way the blade faces",
    Object.values(REVO_GRASS_PRESETS).every((p) => typeof p.values.faceCamera === "number"));
  check("the open-world style keeps blades upright and the RTS one does not",
    REVO_GRASS_PRESETS.openWorld.values.faceCamera === 0 && REVO_GRASS_PRESETS.rts.values.faceCamera > 0.5);
  check("the defaults carry no painted data", !("paint" in REVO_GRASS_DEFAULTS));
  check("fade goes outward, not inward", REVO_GRASS_DEFAULTS.fadeEnd > REVO_GRASS_DEFAULTS.fadeStart);
}

/* ── 2 · the blade ────────────────────────────────────────────────────────── */

{
  const segments = 4;
  const geom = createRevoBladeGeometry({ segments, bladeHeight: 1, bladeWidth: 0.07 });
  const verts = geom.getAttribute("position").count;
  check("the strip is two vertices a row plus one tip", verts === segments * 2 + 1, `${verts}`);
  // quadCount * 6 + 3 for the tip triangle
  check("the index count matches the strip", geom.index.count === (segments - 1) * 6 + 3, `${geom.index.count}`);
  const idx = geom.index.array;
  check("no index points past the strip", [...idx].every((i) => i < verts));
  check("the tip is at the top", Math.abs(geom.getAttribute("position").array[(verts - 1) * 3 + 1] - 1) < 1e-6);
}

/* ── 3 · the system: shaders, and the indirect draw ──────────────────────── */

let sys = null;
try {
  sys = new RevoGrassSystem({
    scene: new THREE.Scene(),
    renderer: { isWebGPURenderer: true, computeAsync: async () => {} },
    worldSize: 2048,
    heightTex: dataTex(0),
    terrainNormalTex: dataTex(1),
    densityTex: dataTex(1),
    bladeHeightTex: dataTex(0.5),
    // The real push field, because its tap is inside the compute's visible
    // branch — the one place a swizzle mistake would never reach a console.
    pushField: { textureNode: TSL.texture(dataTex(0)), center: new THREE.Vector2(), worldSize: 64 },
    terrainSurface: { centerXZ: new THREE.Vector2(), baseStep: 1, levels: 6, halfCells: 64 },
    terrainShadow: null,
    rp: createRevoGrassState(),
    gp: { slopeEnabled: true, slopeMin: 0.65, slopeMax: 0.85 },
  });
  // A smaller grid than the default: this builds real buffers, and the test
  // only cares about what the pass GENERATES, not how many blades it runs on.
  sys.rp.quality = "balanced";
  sys._noiseTex = dataTex(0.5);
  await sys.rebuild();
  check("the system builds", !!sys.mesh);
} catch (err) {
  check("the system builds", false, err.stack?.split("\n").slice(0, 3).join("\n      "));
}

if (sys?.mesh) {
  const geom = sys.mesh.geometry;
  const indirect = geom.indirect ?? geom._indirect ?? null;
  check("the draw is indirect", !!indirect, "without it the mesh draws one instance");
  check("the indirect args start with this blade's index count",
    indirect?.array?.[0] === geom.index.count, `${indirect?.array?.[0]} vs ${geom.index.count}`);
  check("the instance count starts at zero — the GPU writes it",
    indirect?.array?.[1] === 0);
  check("the tile is not frustum-culled on the CPU (it is culled per blade)",
    sys.mesh.frustumCulled === false);
  check("grass does not cast shadows (262k shadow blades is not a look, it is a bill)",
    sys.mesh.castShadow === false);

  try {
    const builder = buildComputeWGSL(sys.computeUpdate);
    const wgsl = builder.computeShader ?? "";
    check("the update pass compiles", wgsl.length > 0, `${wgsl.length} chars`);
    check("it appends to the draw list atomically", /atomicAdd/.test(wgsl), "no atomic append — nothing would draw");
    check("it reads the terrain height more than once (the clipmap triangle)",
      (wgsl.match(/textureSampleLevel|textureLoad/g) ?? []).length >= 4);
  } catch (err) {
    check("the update pass compiles", false, err.message);
  }

  try {
    const builder = buildComputeWGSL(sys.computeInit);
    check("the init pass compiles", (builder.computeShader ?? "").length > 0);
  } catch (err) {
    check("the init pass compiles", false, err.message);
  }

  try {
    const out = buildWGSL(sys.material);
    const vs = out.vertexShader ?? "";
    const fs = out.fragmentShader ?? "";
    check("the blade's vertex stage compiles", vs.length > 0);
    check("the blade's fragment stage compiles", fs.length > 0);
    check("the material is lit by the scene, not painted flat",
      /light|Light/.test(fs), "an unlit grass never notices the sun set");
  } catch (err) {
    check("the blade's vertex stage compiles", false, err.message);
  }
}

/* ── 4 · the save file ────────────────────────────────────────────────────── */

{
  // A look block that is not registered in projectIO is silently DROPPED on
  // save — you find out by reopening a world and finding the other grass
  // system back at its defaults.
  const { encodeProjectFile, decodeProjectFile } = await import("../v3/io/projectIO.js");
  const { mergeKnownKeys } = await import("../v3/app/state/mergeKnownKeys.js");
  const terrain = { worldSize: 100, heightmapSize: 4, splatSize: 4, maxHeight: 10 };
  const heightmap = new Float32Array(16).fill(1);
  const revo = { ...createRevoGrassState(), tileSize: 70, baseColor: "#123456", quality: "ultra" };
  const grass = { system: "revo", bladeHeight: 1 };
  const d = await decodeProjectFile(await encodeProjectFile({ terrain, heightmap, grass, revoGrass: revo }));
  check("the revo look survives a save and a load", JSON.stringify(d.revoGrass) === JSON.stringify(revo));
  check("which system runs is saved with the grass", d.grass?.system === "revo");
  check("a file written before this existed simply has none",
    (await decodeProjectFile(await encodeProjectFile({ terrain, heightmap }))).revoGrass === null);
  // The load path is a per-key merge, like every other look block.
  const state = createRevoGrassState();
  mergeKnownKeys(state, { tileSize: 70, retired: 9 });
  check("loading merges per key and resurrects nothing",
    state.tileSize === 70 && !("retired" in state) && state.bladeHeight === REVO_GRASS_DEFAULTS.bladeHeight);
}

/* ── 5 · the shared ground helper ─────────────────────────────────────────── */

{
  check("the clipmap helper is callable per system", typeof createClipmapGroundY({
    centerXZ: new THREE.Vector2(), baseStep: 1, levels: 6, halfCells: 64,
  }) === "function");
  const src = await import("node:fs").then((fs) =>
    fs.readFileSync("v2/render/hybridGrass/hybridGrassSystem.js", "utf8"));
  check("the hybrid grass uses the SHARED helper, not a second copy",
    /createClipmapGroundY/.test(src) && !/const stepW = base\.mul/.test(src),
    "two copies of the clipmap triangle math drift apart silently");
}

console.log(fail === 0 ? "\nAll revo grass checks passed." : `\n${fail} revo grass check(s) FAILED.`);
process.exit(fail === 0 ? 0 : 1);
