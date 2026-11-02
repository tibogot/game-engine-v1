# Thunderline performance audit, 2026-11-02

This covers the game (the drive page), its editor (the builder), loading, and assets, on three r187.

- Measured on the MSI laptop (RTX 4050) in an uncapped Chrome, using the engine's GPU A/B harness (`__V3_DEBUG.gpuAB`: interleaved rounds, mean of frame totals).
- The code was read by three agents; I checked the claims against the measurements below.
- **Status:** nothing has been changed yet. Each item says whether it is a game-only fix or an ENGINE change (v3/ is shared with alg-rts and nam-rts, and the engine track is paused).

## Measured

**Drive page, by day, start view, 1584×805 — GPU 5.7 ms a frame:**
- **Removing parts:**

  | Removed | Saves |
  |---|---|
  | Ground (terrain) | 2.4 ms (the biggest) |
  | Sky | 0.8 ms |
  | Bloom | 0.25–0.55 ms |
  | Ghost car | 0.4 ms |

  Removing the track ADDS 2.1 ms: the ground then fills those pixels.
- **Post-processing:**

  | Change | Saves |
  |---|---|
  | FXAA off (it runs on top of 4× MSAA) | 0.09 ms |
  | Bloom at ¼ resolution | 0.22 ms |

  Post-processing is small. The main pass is about 90% of the frame.
- **Night lights** (2026-11-02): about 0.6 ms in all. The two road spots in the clustered pass cost about 0.45 ms; the haze and flares about 0.15 ms.

**Builder, lab track (85 pieces, 77 props):**
- **GPU 6.4 ms, of which the ground is 5.2 ms** (from above, the ground fills the screen).
- **CPU 8.3 ms on an IDLE frame, 424 draws.**
- **One edit:** a 295 ms freeze (the whole rebuild), then hitches up to 90 ms. About 1 GB of short-lived garbage per edit and prediction: the heap read 1.25 GB, and 132 MB live after a GC.

**Load:**
- Drive page: 8.9 s after a browser start, 10.5–11.5 s on later loads.
- Builder with the lab track: 17.5 s.
- About 250 requests, 4.4 MB transferred (from Vite's cache).
- Known since 10-30: about 5.7 s of the main thread is three building node materials, plus DXC shader compiles in the GPU process.

## 1. The ground: the biggest GPU cost in both views

- **1a. Game-only — turn off the terrain shader features Thunderline can never use.**
  - The features: `terrainFeatures: { snow:false, lakebed:false, riverSand:false, flowerTint:false, grassFar:false }`. Thunderline has no level data for any of them.
  - Where: drive.js:40 and builder3.js:328 pass only `cursor:false`, and terrainLOD.js:140 turns the others on.
  - Saves GPU and the biggest shader compile (the 208 KB terrain fragment).
  - The look must not change: check by eye.
- **1b. Game-only — flat worlds read only paint slot 0.**
  - Today: worlds.js:46 compiles 3 layers with hex tiling, far tone and far blend everywhere.
  - Fix: `layerBudget 1 / topK 1` for flat and flat_grid on the drive page.
  - The builder switches worlds, so it keeps 3 layers or rebuilds on a switch.
  - Measure the hex tiling separately (still open since 10-22: +0.5–1.3 ms).
- **1c. ENGINE — the grid.**
  - Today: `GRID_N` 256 makes 625k triangles plus about 196k in the far rings, never culled (terrainLOD.js:84, :830, :845). An earlier test of 128 saved about 1.2 ms.
  - Options: a per-app grid size, and/or cutting the clipmap into sectors so the half behind a ground-level chase camera is culled. The sector split changes nothing in the picture.

## 2. The builder's edit path (CPU): 295 ms per edit

**DONE 2026-11-03** (uncommitted until the user says). Lab track, 85 pieces + 77 props.

| | Before | After |
|---|---|---|
| Click freeze | 281 ms | 33–37 ms (103 ms when the edited 256 m cell is a crowded one) |
| Worst frame after an edit | 68–81 ms | 37–48 ms, none over 50 ms |

What changed:
- **Chunk cells are kept** (`testTrack.buildTrackMeshes(…, cache)`): only cells whose parts changed are merged again. Checked: identical meshes, instances and vertex checksum to a fresh build.
- **Obstacle looks and gates/rings are kept** while their record is unchanged (obstacles.js `cache`, builder3 `keptGate`).
- **The prediction reuses the last run's collision trees** when their inputs are the same (a new tree, never a re-bake, for a changed input), and yields a frame after a fresh bake. Checked: identical lap, lips, landings and end speed with fresh vs kept trees on White 1–3, Two gap jumps, Mixed (dev switch `__predFreshBvh`).
- **The duplicate refreshArcs + runChecks** at the prediction's end are gone.
- **The prediction's car leak** is fixed (the last car is removed from predScene).
- **reflow's passes lay out matrices only** (`layout()`) and draw once. Checked: byte-identical tracks after refit + mirror on White 1–5 (dev switch `__reflowFull`).

Measured and NOT changed:
- **2d picking:** 0.25 ms a frame while sweeping with a piece in hand. Fine.
- **2e prediction garbage:** GC about 1% of the 6 s after an edit, in physics that must stay bit-exact. Not worth it.
- **2f library writes:** under 1 ms with the current library. They grow with many tracks and thumbnails; on Steam, store one file per track.

LEFT: the deck collision tree is re-baked when road pieces change (40–80 ms in one frame, about 0.4 s after the edit). The fix is three-mesh-bvh's worker builder (GenerateMeshBVHWorker, 0.9.10) in an async RoadBvh bake. That is an ENGINE file, v3/play/modularRoadBvh.js; check that the tree is identical.

The original analysis follows:

- **2a.** `rebuild()` (builder3.js:756) is still WHOLE:
  - every piece's mesh group;
  - a new post InstancedMesh per piece;
  - all chunks, obstacles and lamps;
  - then save, arcs, checks and prediction.
  - `reflow()` (:2612) can rebuild up to 9×.
  - Fix:
    - split into layout() (matrices) and draw();
    - reflow loops on layout() and draws once;
    - keep piece groups by uid + signature and redraw only changed pieces and their 256 m chunk cells.
- **2b.** `runPrediction` runs `refreshArcs` + `runChecks` twice more, back to back (:1252–1253, :1264–1265), and the full lap twice again.
  - `refreshArcs` re-creates every lip label: a canvas, texture, material and sprite each.
  - Fix: drop the duplicates, cache labels by text.
- **2c.** The prediction car leaks: each `runPrediction` adds a `new PredCar` group to predScene, and nothing removes it (:1046).
- **2d.** Picking raycasts every triangle of the hidden piece meshes with no BVH, including per-instance posts. It runs in 11 places, some on every pointer move or snap change (:1756, :2361, :3232).
  - Fix: one deck-only `MeshBVH` per piece (three-mesh-bvh is already a dependency), with no posts or rails in picking.
- **2e.** The prediction allocates heavily: about 1 GB of garbage per edit.
  - Car ticks allocate: `trackFromRide` clones 3 vectors plus objects up to 3× per substep and scans every ride point when the car is more than 15 m off the line (stuntCar.js:170).
  - Fix: scratch objects and a grid lookup that returns the same nearest index — it must stay bit-exact (simStateTest, ghostTest, landingTest).
- **2f.** Ctrl+S parses and writes the whole library 3 times, with every thumbnail inside one localStorage string. The same happens at the finish line (`recordFinish` in the tick, plus the ghost's structured clone).
  - Fix: one key per track, thumbnails in IndexedDB (thumbStore exists), the finish writes deferred to idle time.

## 3. The builder at rest: 8.3 ms CPU a frame, 424 draws

- **3a.** The hidden pick meshes stay in the rendered scene. Chunks, gates and obstacles keep `matrixAutoUpdate`, so `updateMatrixWorld` walks them every frame, and again for the live sun-shadow render (sunShadows.js:242).
  - Fix:
    - put the pick meshes in a separate root that is never rendered;
    - static matrices;
    - `matrixWorldAutoUpdate=false` in the shadow render.
- **3b.** `builderFrame` (:3811) rebuilds status and hand keys every frame:
  - `JSON.stringify(spawn)`, filters, 16 `toFixed` calls from the camera;
  - arc points projected on each snap.
  - Fix: version counters; one camera-changed check.
- **3c.** It never rests: full frames plus 2 CSM cascades at 2048² and the clouds, all the time. That costs GPU heat and competes with your other work.
  - Fix: `app.setFrameThrottle(33)` after about 2 s without input.
- **3d.** `trackLamps.js:37` runs its own endless rAF loop. Fix: an app pre-render hook.

## 4. The drive page frame (smaller items)

- **4a.** physProps re-places every prop matrix and re-uploads every level each frame, even when all props are asleep (physProps.js:265–284). Fix: only on movement or a level-of-detail change.
- **4b.** Garbage in the tick: `tires.map/filter/clone` per substep (arcadeCar.js:269–271, 719, 731); the ghost recorder pushes an array per tick. Keep it bit-exact.
- **4c.** Night: the beams copy the depth buffer every frame (about 0.4 ms in the old game's measure; here the total haze was 0.15 ms). ENGINE: read the scene pass's depth instead.
- **4d.** FXAA over 4× MSAA: 0.09 ms, a sharper picture without it. Your call by eye.
- **4e.** Bloom at ¼ resolution: 0.22 ms. Check the glow by eye.
- **4f.** The sky haze: a full-resolution copy-back, and the march/temporal passes run with no shafts possible (skyproSky.js:376–380, skyproHaze.js:499). Plus exp² fog on every material: the atmosphere is done twice. ENGINE plus a look check.
- **4g.** The sky dome shades every pixel before the ground covers it (skyproSky.js:225, depthTest off). ENGINE: draw it last at the far plane. Needs a measurement.
- **4h.** The road is still DoubleSide (oldLook.js:22). FrontSide once the lids close every prism.
- **4i.** Deck and tubes have no far LOD; only rails and posts do. It matters on big tracks: the lab is geometry-bound.
- **4j.** The stats panel rewrites innerHTML 4×/s (debug). Hide it in a ship build.

## 5. Load time

- **5a.** Road scan textures and materials are loaded twice: builder3.js:395 and driveSession.js:146 each call `createOldLookMaterials()`, and loadTexture has no cache. That is 2× the 2K diffuse + normal (about 10 MB of VRAM wasted) and a second material set. Fix: pass the builder's materials to the rig, or memoise by URL.
- **5b.** `await bakeThumbs()` (:3783) builds and hashes every dock tile's geometry at each boot even when the pictures are kept, and `lookRev` fetches about 700 KB of source just to hash it. Fix: key by tile id + build version; bake in idle time.
- **5c.** `loadPhysAssets()` (6 glb, 21 KTX2, the palm, the LED builder) starts only after the whole module ran (:3782), then the boot awaits bakeThumbs → modelsReady → warm pipelines in a row. Start the loads right after startV3App.
- **5d.** Ground paint:
  - 12 JPGs (11 MB) are loaded one after another, each resized with a per-pixel JS loop (worlds.js:68–74, textureLibrary.js:433–485).
  - The CPU arrays keep 7 layers (56 MB of heap).
  - `releasePaintCpuCopies()` is never called.
  - Fix (game): parallel loads + the release.
  - Fix (ENGINE): CPU arrays sized to the GPU layers.
- **5e.** The palm forces the Draco decoder (about 0.6 MB wasm + workers) at every boot (physProps.js:162). Fix: a meshopt copy, or load it only when a track has a palm.
- **5f.** ENGINE:
  - The builder pulls in 479 modules (9.1 MB of source; 410 in v3/). main.js builds every editor system at boot: lakes, rivers, waterfalls, roads, tunnels, props, decals, snow.
  - It also parses editor.html before asking for the GPU.
  - Fix: dynamic imports behind the editor / feature flags.
- **5g.** Shader compiles (79 fragment programs) are the biggest part of the load. The Steam shell (Electron) with its own shader cache is the biggest lever for every launch after the first. List programs by material and merge the flag variants (side, transparency, maps present) — obstacles.js builds 25 materials, some per placement (:822, :865, :1022).

## 6. Memory (VRAM)

- **6a.** Tyre smoke: three 1536² webp flipbooks, not compressed (tyreSmoke.js:55–61). About 28 MB as RGBA8 against about 7 MB as BC7: `npm run textures` + loadTexture.
- **6b.** The bloom's emissive MRT attachment is RGBA16F per MSAA sample. It grows with resolution (about 130 MB at 1.5× on 1080p). ENGINE option: mask thresholds as parameters (alg uses the mask).
- **6c.** The live shadow map renders an R32F colour target AND depth at 3072² (sunShadows.js:35, :189). Depth only would save about 36 MB and the colour write.
- **6d.** Obstacle textures: 21 KTX2 files load whatever the track contains. 1024² for a cone or a drum is generous; check 512 close up.
- **6e.** The ghost car loads its own 9 textures + 11 materials (LOD1). It could share LOD0's.

## 7. Shipping

- **7a.** There is no production build for Thunderline: vite.config.js inputs don't list its pages, and `vite build` would copy all of public/ (985 MB; Thunderline uses about 40 MB). A Thunderline build config with an asset whitelist + minification.
- **7b.** Google Fonts come from the network (builder3.html:15, menu.html:10). Vendor the woff2 files for offline Steam players.
- **7c.** A quality menu: resolution scale (the frame falls off a cliff above about 1.75× on a 6 GB GPU), MSAA, bloom resolution.

## Checked and fine

- The car and obstacle glbs are meshopt + KTX2.
- Audio loads lazily.
- The drive page builds tile looks lazily.
- CSM does not render on the drive page (the custom shadow node replaces it).
- SSAO is off.
- r187 already skips MSAA on full-screen passes.
- The headlights are binned by the clustered lights.
