# Optimization inventory — instancing, culling, LOD, impostors, merging, asset pipeline

Started 2026-10-26 (read-only pass, nothing changed). Trigger: "everything about
instancing, culling, merging or any optimization should be general for every
one of my games". This file lists **what exists, who uses it, and where the same
job is done twice**, then a small-steps order to consolidate it. Line numbers
are from 2026-10-26; re-grep before acting.

Goal shape (where we want to end): **one engine layer in `v3/render/`** that
every game calls, and **one offline pipeline in `tools/`** that every asset goes
through. The editor only *places* things; games never re-implement cull / LOD /
instancing.

Related plan already in the repo: `v3/AUDIT.md` § "GPU culling and Hi-Z
occlusion" (line ~2371) — Hi-Z measured in the lab (net −0.18 ms at ground
level, auto-off at RTS height), next step = wire into leafField + scatterField.

---

## 1. Renderer-wide patches (installed once in `v3/app/main.js`)

| Module | What | Used by |
|---|---|---|
| `render/instanceMatrixSync.js:32` `installInstanceMatrixSync` | matrices uploaded the SAME frame (fix for flashing rocks) | main.js (all games), splitflap-lab |
| main.js:419-439 inline, `opts.instanceAttributes` | instance matrices as vertex attributes; upload only `mesh.count` | rtsPerfBoot (alg), namGame |
| `render/sharedInstanceBuilds.js:179` | one node build per material for instanced meshes (needs the above) | main.js `opts.shareInstanceBuilds` |
| `render/emptyDrawSkip.js:19` | skip count-0 draws (wraps `renderer.renderObject`) | main.js |
| `render/parallelPipelines.js:23` | async pipeline compile at boot | rtsPerfBoot, namGame |
| `render/gpuOnlyArrays.js` | free CPU copies of GPU-only buffers | scatter, crowd, grass, splat, algStones, nam, rtsPerfBoot |

**Overlap:** `render/instancePipeline.js:82` `shareInstancePipeline(mesh)` pads
each mesh to 1025 slots to force the attribute path — the same goal as
`instanceAttributes`, done per mesh. Used by propInstancer, rivers V2/V3 and ~14
modular-road files (modular-road never turns `instanceAttributes` on).
**Overlap:** `games/modular-road-v3/modularRoadPassCull.js:216` is a SECOND
`renderer.renderObject` monkey-patch (per-pass sphere cull, incl. shadows).

## 2. Instancing / batching

### GPU fields (compute cull → indirect draw)
- `render/scatter/scatterField.js:68` **ScatterField** — painted plants; frustum + dithered distance LOD + `lodFloors`; multi-indirect batching (`_buildBatches` :561). Also an optional CPU pre-cull `_cpuCull` :863 that re-implements its own GPU test (on in nam + rtsPerfBoot). Used by main.js, foliageSystem, flowerSystem.
- `render/culling/gpuInstanceField.js:33` **GpuInstanceField** — props: distance → frustum → Hi-Z → LOD → atomic append. **Lab only** (gpu-cull-lab). Planned PropInstancer replacement; missing LOD hysteresis + shadow lists (header :22).
- `render/staticInstanceBatch.js:42` `batchStaticInstances` — join static InstancedMeshes sharing a material, one indirect per member. Exported in engine.js but **only alg-rts** uses it (algGame.js:955).
- Hand-written indirect setups: `grass/hybridGrassSystem.js:516`, `grass/revoGrassSystem.js:272`, `ambient/ambientField.js:178`, `trees/leafFieldRenderer.js:302`.

### CPU-culled InstancedMesh managers (matrices rewritten per frame)
- `v3/tools/propInstancer.js:107` **PropInstancer** — editor props: cell + instance frustum, 3 LODs + autoLod, per-cascade shadow frusta.
- `games/modular-road-v3/modularRoadPropInstancer.js:253` **PropInstancer (same name, different class)** — track props.
- `render/foliage/treeLodRenderer.js`, `foliageLodRenderer.js` (+ `foliageSlotMerge.js`), `trees/impostorFieldRenderer.js` — via `app/treeEnvironment.js`.
- `games/modular-road-v3/modularRoadCityLodView.js` — city per-instance LOD on a 5 Hz tick.
- `games/shared-rts/unitRenderer.js` — units, x-ray copies, kit pools (alg + nam). Soldiers: `render/crowdSkinning.js` (one compute-skinned draw).
- shared-rts pooled "fields": healthBar, selectionRing/Frame, sprite, tracer, blood, flame, explosion, projectiles, rtsBirds — each has its own capacity/count/upload code.
- ~25 single-purpose pools in game modules (alg: damage, wrecks, droppedWeapons, stones, fields, landmarks, pointFlags, poles, villageLife, house, flares, paradrop, mortar/mg teams, nightLamps; nam: structures, building, resource, requisition, fire, animals; modular-road City*; v3/props/objects: floodlight, powerLine, ledMatrix, tireWall, streetLamp, hedge, gantry, brickKit).

### BatchedMesh
- `games/modular-road-v3/modularRoadCity.js:990` `buildBatched()` — the ONLY BatchedMesh in the repo.

### Static geometry merging (bucket by material → mergeGeometries)
- `v3/tools/roadDrawCallMerge.js:16` — editor roads (main.js only).
- `games/modular-road-v3/modularRoadBatching.js` — `mergeByMaterial` :192, `flattenInstanced` :149 (12 modular-road files).
- `games/modular-road-v3/roadGame.js:3984 / :5463` — inline merges.
- `v3/horse-lab/optimize.js` — `mergeStatic` / `mergeSkinned` / `mergeRigid` (horse-lab only, code is general).
- `render/objects/rtsParts.js:94` `assemble(parts)` — kit parts → one atlas mesh (~30 rts* builders); `rtsStencils.js:469` `mergeStencils`.

## 3. Culling

### GPU frustum tests — THREE copies
1. `render/scatter/gpuCull.js:32` `frustumVisibleAtClip` (+ `screenRadiusPixels`, `worldSizeForPixels`) — the shared one: scatter, gpuInstanceField, ambient, revoGrass (size only).
2. `render/grass/revoGrassSsboUtils.js:34` `computeFrustumVisibility` — revo + hybrid grass; **biased top margin** (subtracts radius).
3. `render/trees/leafFieldRenderer.js:57` `treeFrustumVisibility` — local copy written *because of* #2's bug (comment :50).

### Hi-Z occlusion
- `render/culling/hizPyramid.js:68` **HiZPyramid** — lab only. Plan in AUDIT.md (see top).

### CPU frustum + hysteresis LOD — written ~4 times with the SAME constants (`CULL_MARGIN` 12, `LOD_HYST` 0.1)
TreeLodRenderer :248, FoliageLodRenderer :792, PropInstancer :793/:822, PlacedFoliage :271 (alg labs + nam placedPlants).

### Ad-hoc `THREE.Frustum` loops
decalSystem :543, waterfallSystem :403, riverV2System :884, riverV3System :518,
oceanproCDLOD :140-221, shared-rts unitRenderer :1684/:1723/:2106, wildHerd
:180/:191/:304, nam enemyCamp :157, nam requisitionRenderer :98/:114 (hard-coded
300 m), alg algPointFlags :197/:218, alg showroom :510.

## 4. LOD

- `render/instancing/autoLod.js` — meshoptimizer `simplifyWithAttributes`, **runtime only** (never written back to the GLB). Used by propInstancer, proceduralRock (+worker), rtsAlgeria, main.js, gpuCullLab, alg (motorPool, sandbags, stones), stylized-lab, tools tests.
- `THREE.LOD` directly in games: alg `algHouse.js:122`, `algSangar.js:308`, `algMasonry.js:406`; thunderline `testTrack.js:277/316`.
- Hand-picked: gothicChurch `lodDistance`, masonry-lab, thunderCar LOD1 GLB, modular-road facade shader LOD.
- Blender far LODs: `tools/blender/bkit.py` `Kit.far()` (planar dissolve + decimate, `copy_normals`), ~25 alg scripts emit `_Far`.
- Terrain: `terrain/terrainLOD.js` — clipmap rings + far rings, no culling, main.js only. Water: `oceanproCDLOD.js` — separate CDLOD.
- **Knob names differ everywhere:** `lodDistances[]`, `lodDistance/lodDistance2`, `lodFloors`, `lod0Dist/lod1Dist`, `lodDistances.{lod1,lod2}`.

## 5. Impostors (octahedral)

- `render/foliage/octahedralCore.js` (908 lines) — **canonical**: atlas bake, aux textures, materials. Used by impostorBake + impostorFieldRenderer.
- `render/foliage/impostorBake.js` — `bakeSlotImpostor` :59 (treeEnvironment). `buildImpostorBillboard` :102 = **dead**.
- `render/trees/impostorFieldRenderer.js:29` — GPU distance-band gate + crossfade. Games get it via treeEnvironment (editor maps, modular-road city).
- `v3/authoring/octahedral-core.js` (879 lines) — **stale copy**, arborist.html only. The render copy is a strict superset: instanced centre/scale attributes, `uFadeStart/End` distance fade, and the bake-state fix (restores render target / autoClear / clear colour around every readback await; the authoring copy still has the bug that corrupts the HDR framebuffer during a bake).
- Impostors exist **only for trees**. Buildings / rocks / props have no impostor tier.

## 6. Offline asset pipeline (`tools/`)

### General (any path)
- `tools/optimizeGlb.mjs` — gltf-transform: resize `--max`, KTX2 UASTC (`--etc1s` for base colour), meshopt 16-bit positions. **Compression only** — no dedup / instance / weld / simplify / prune. Needs global `@gltf-transform/cli` + KTX-Software at a hardcoded path. No npm script.
- `tools/compressTextures.mjs` (`npm run textures`) + runtime `render/textureLoad.js` — loose images → `public/ktx2/` + manifest. Doc says a release build runs it: **vite.config.js has no such hook** (checked 2026-10-26).
- `tools/glbInspect.mjs` — per-file counts / sizes / bounds.
- `tools/v3projCompress.mjs` — gzip level containers.
- `tools/glbCoplanarCheck.mjs`, `tools/glbLodShadingCheck.mjs` — QA checks; default `public/models/alg`, accept other folders.

### Game-specific
- `tools/glbCoplanarTest.mjs` / `glbLodShadingTest.mjs` (+ `*Passed.json`) — in npm test, `DIR = public/models/alg` only.
- `tools/blender/bkit.py` — bake atlas, join, far LOD, deconflict, damaged states. General Blender code, alg materials / 1.3x scale.
- `tools/packMixamo.mjs` — soldiers pack (alg default paths, general method).
- `tools/packTextures.py` (car game), `tools/packBuildingTextures.py` (alg), perfAudit*.mjs (modular-road).
- `public/models/*_compressed.glb` — made by an outside optimizer; nothing in the repo produces them.

### Gaps vs a commercial optimizer (Translight etc.)
1. Duplicate meshes → instancing: none (offline or in loaders).
2. General merge by material / spatial cluster: only Blender `join` and runtime horse-lab merge.
3. Hidden / interior face removal: none.
4. Small-object removal: none.
5. Offline simplification written into the GLB: only Blender `far()` for alg kits.
6. KTX2: covered but adoption partial (Thunderline started, alg waiting, Apocalypse not started) and not in the build.
7. Texture size from screen coverage / texel density: none (manual `--max`).
8. Material consolidation / atlas for arbitrary GLBs: none.
9. One report ranking draws / tris / texture MB / duplicates for a scene: none.
10. One entry point (`npm run optimize`): none; external tools at hardcoded Windows paths.

## 7. Dead or lab-only

- Dead: `grassGemini.setupGrassPatches` (+ `createFieldInstancedGeometry`, `createGrassMaterialMega`), `impostorBake.buildImpostorBillboard`.
- Lab-only: `HiZPyramid`, `GpuInstanceField`.
- Arborist-only: `authoring/octahedral-core.js`.
- `games/rts-v3/` keeps older forks of healthBar, selectionRingField, spriteField, crowdSkinning (236 vs 572 lines), unitRenderer (717 vs 2241), projectiles, structuresRenderer. Kept on purpose (old games stay); just don't copy from them.

---

## PRIORITY (agreed 2026-10-26) — read this before the list below

Rule from the user: global ONLY for what ~90% of the games need; everything
else lives in its game (AI makes per-game code cheap). Global code must be
very solid (tests, small API through `v3/engine.js`, never break a game) and
the goal is finishing games and selling them on Steam. Rule of two: a thing
becomes global when a SECOND game needs it.

Order:
1. **One GPU frustum test** (= step 2 below) — small, global. CODE DONE
   2026-10-26 (not committed): revo + hybrid grass and leafField call
   `gpuCull.scatterFrustumVisible`; `computeFrustumVisibility` and
   `treeFrustumVisibility` deleted. Leaves: same result (pad above = below).
   Grass: screen top now `1 + r + pad` instead of `1 − r + pad` — keeps
   near blades at the top edge when looking down. VERIFIED 2026-10-26 in the
   editor (own Chrome, :5191): per view, normal culling vs pads=10 (cull
   off), pixel diff with time frozen → revo grass 5 ground views 1 px total,
   hybrid grass 5 views 0 px, leaves (fog-lab) 3 views at noise. Controls:
   pads=−0.6 changes the image (revo 39 %, hybrid 7 %), so the zeros are real.
   npm test 215/215. Stylized lab + road.html load clean.
   **FOUND (pre-existing, not from this change):** leafField culls its
   SHADOW casters with the camera frustum — under a tree, canopies behind the
   camera lose their ground shadow (fog-lab view 4: 3.6 % of the frame). Fix
   belongs to the spec's "shadow casters culled per LIGHT" rule.
2. **4× MSAA A/B** — does the scene pass need it? Costs every game; likely
   becomes a quality setting. Cheap test (quiet machine, same clock, per game).
   Also the open question from the Tidewater notes / AUDIT.md Hi-Z step 2.
3. **Culling + LOD + impostor spec** (a doc, agreed before code): one way to
   ask ("N copies of asset X, LODs, optional impostor"), backends picked by
   count (mesh + LOD / instanced CPU chunks / GPU compute + indirect), shared
   rules (one LOD settings name, hysteresis, crossfade/dither, impostor = last
   LOD tier, shadow casters culled per LIGHT, skinned bounds). GPU props
   (`GpuInstanceField`, AUDIT Hi-Z step 4) = the GPU backend, not its own
   project. Then: automated tests for the rules → extend `v3/gpu-cull-lab.html`
   with fixed scenes (single buildings, instanced rocks, 100k field, animated
   units, off-screen shadow casters, 180° turn + teleport, ground vs RTS
   height, runtime add/remove) → one real game system moved and measured.
   Lab props are cheap to shade: the final number comes from real content.
4. **Steam shell, through the first game shipped** — desktop wrapper
   (Electron), Steamworks (achievements, cloud saves, overlay), versioned
   save/load, player settings (quality presets, resolution scale, vsync,
   volume, language), input (keyboard/mouse/gamepad, rebinding, AZERTY),
   quality tiers + WebGPU fallback + minimum spec, loading screen + shader
   warm-up, crash log file, one release command. None exist yet (checked
   2026-10-26). Menu LOGIC global, each game keeps its own look.
   `games/empty-game` becomes the starter template with all of it working.
5. **Later, when a big-world game is next:** the Hi-Z occlusion track
   (AUDIT.md steps 1–3). Measured net −0.18 ms at ground level, nothing at RTS
   height — a big-world feature, not a 90% one.

Global keep-list from the steps below: 1 (one octahedral core), 2 (one frustum
test), 3 cut down to one small CPU cull/LOD helper (folded into the spec), 11
(one asset command). Steps 4–10 and 12 are per-game or optional later.

## Consolidation order (small steps, every game stays working)

Each step: one system, measured A/B where it touches perf (GPU ms, quiet
machine), `npm test` once before the commit, reload every touched page.

- [ ] **1. One octahedral core.** arborist imports `render/foliage/octahedralCore.js`; delete the authoring copy. Fixes the arborist bake-state bug for free. Smallest, safest first step.
- [ ] **2. One GPU frustum test.** revoGrass + hybridGrass + leafField move onto `gpuCull.frustumVisibleAtClip` (fixes the biased top margin). Visual check: no blades/leaves popping at the top edge.
- [ ] **3. One CPU cull + LOD helper** (`render/culling/cpuCull.js`: frustum test with margin, LOD tier with hysteresis, shared constants). TreeLod, FoliageLod, PropInstancer, PlacedFoliage call it; then the ad-hoc loops in decals / waterfall / rivers / games, one by one.
- [ ] **4. One LOD settings shape** (`{ distances: [..], hysteresis, floors }`) read by every system; old names accepted as aliases so old levels still load.
- [ ] **5. One mesh-merge helper** (`render/mergeByMaterial.js`) — roadDrawCallMerge, modularRoadBatching.mergeByMaterial, horse-lab mergeStatic call it.
- [ ] **6. One instance-pipeline path.** Decide: global `instanceAttributes` + sharedInstanceBuilds for every game, or per-mesh `shareInstancePipeline`. Measure modular-road with the global path before choosing.
- [ ] **7. One pooled-instance helper** (capacity / count / upload) for the shared-rts fields and the single-purpose game pools — new code uses it; old pools moved only when touched.
- [ ] **8. One indirect-args helper** for scatter / grass / ambient / leaf / staticInstanceBatch / gpuInstanceField.
- [ ] **9. Hi-Z + GpuInstanceField into real content** — follow AUDIT.md's plan (leafField + scatterField first, camera lists only).
- [ ] **10. Renderer patches in one place** — one `renderObject` wrapper owning empty-skip AND per-pass cull (modularRoadPassCull's idea, made general), so two patches don't stack.
- [ ] **11. Offline `npm run optimize`** — one entry: inspect report → dedup/instance → weld/prune → simplify LODs written into the GLB → KTX2 sized by use → meshopt; plus coplanar + LOD-shading checks for any folder (not just alg). Hook `npm run textures` into the release build as the doc already claims.
- [ ] **12. Impostor tier for non-tree assets** (far buildings / rocks / cliffs) — only once a big-world game needs it; measure first.
