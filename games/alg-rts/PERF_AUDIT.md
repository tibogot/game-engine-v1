# alg-rts — the performance + load-time audit (brief, 2026-10-03)

Written at the end of the long alg-rts session, for a NEW chat that runs the
audit. Read this, then `games/alg-rts/TODO.md` (the LOAD TIME item and the
PERF + QUALITY AUDIT section at the top), then the memory index.

## The goal (the user's words, condensed)

"The best performant and optimized game", one that would hold up as a real
release (Steam later, likely wrapped in Electron, but SOLID first). Two halves:

1. **LOAD TIME**: the boot "seems quite slow". Is it the best we can do?
2. **FRAME COST**: anything we can merge, instance, cull, bake or move to the
   GPU. Use WebGPU tricks ourselves where three.js lacks them.

## What is allowed

- Changing the **v3 engine** (`v3/`) is fine when it is for performance.
- Leaving v3's terrain for a separate one is allowed **if the numbers justify
  it**. The previous session's view: keep v3. Every cost measured so far is
  specific (foliage, shadows, the scene pass, boot bakes), none is
  architectural, and the editor is the user's world tool. Argue it from
  measurements, not taste.
- nam-rts shares `games/shared-rts`: a shared change must not break nam (two
  different games; share only identical machinery).

## How to measure (rules from memory, all learned the hard way)

- **Report GPU ms, not fps.** The game is vsync-locked at 60.
- **gpuBench** (`games/alg-rts/gpuBench.js`, `abCases`): renders N times back
  to back + `onSubmittedWorkDone`. It is focus-free and the reference tool.
  rAF timing is quantised to 16.7 ms and lies.
- **ONE app tab** while testing (a second tab shares the GPU).
- The test Chrome (chrome-devtools MCP) goes on the user's **second screen**,
  visible, NOT minimised. A minimised or covered window stops drawing.
  Already launched with `--disable-backgrounding-occluded-windows`,
  `--disable-renderer-backgrounding` and `--disable-background-timer-throttling`.
  `--disable-features=CalculateNativeWinOcclusion` was added 2026-10-03 (the
  user's OK; `~/.claude.json`, chrome-devtools entry): Windows no longer calls
  a covered window occluded. Only minimising still stops it.
- The laptop (MSI Thin 15) **throttles at ~87 °C after ~2 min**. Run A/B pairs
  back to back, take breaks, and don't trust one long run.
- Check the **console, warnings too**, after every boot. A known warning:
  "Multiple active KTX2 loaders".
- Per-origin localStorage can rig an A/B (stale dev-panel settings): see the
  memory note.
- `npm test` (fast lane, ~30 s) once before each commit; gate on "N/N suites
  green". **Ask before every commit.** Work on main.

## What is already known (do not re-measure blindly)

- `proj_alg_rts_perf_pass`: the hill spike was the cedars (alpha discard kills
  early-z), fixed with a foliage depth pre-pass, 20.7 → 6.6 ms.
- `proj_scene_pass_lean_mrt`: the post scene pass wrote 4 unread MSAA
  attachments. Now colour only, −2 to −3 ms at scale 1.
- `proj_v3_sun_shadow_cost_2026_10`: the whole map's shadow 0.2-0.8 ms; the
  games have no cascades; a shadow cache is not built.
- `proj_v3_hiz_occlusion`: Hi-Z ground −0.66 ms render, the pyramid +0.48
  (MSAA depth reads); auto = off for the RTS.
- `proj_nam_rts_frame_budget`: foliage is cost #1 in nam.
- TODO.md audit round 1: painted foliage ≈ 0 ms; PlacedFoliage culled
  (0.8-1.0 → ≈0 close, 0.26 default, 0.5-0.7 max); herds and crowd skinning
  skip off screen.
- `proj_nam_rts_load_time`: nam went 46 → 24 s. Do the same here: time each
  stage first (alg.html already records stage times for its progress bar,
  `localStorage` key in alg.html).
- Suspected load costs (unmeasured): the animal morphs (~4.5 s), shader
  compile / warm-up, the ground cache bake, plants and props built on the
  main thread, textures not compressed.

## Where to look for tricks (read, then rank against OUR numbers)

- **Tidewater**, `C:\Users\tibog\Downloads\tidewater-main` (MIT, raw WebGPU +
  WGSL). Memory `ref_tidewater_analysis` holds a ranked take-list.
- **revo-realms**, github.com/alezen9/revo-realms (WebGPU/TSL). Memory
  `ref_revo_realms_reusables`.
- **InstancedMesh2**, agargaro/instanced-mesh (per-instance frustum culling,
  LOD, BVH; WebGL-only). Measured 2026-09-14: memory
  `proj_v3_props_instancing_measured`, v3/AUDIT.md "Props and instancing".
- **WebGPU itself**, where three.js has nothing: compute culling + indirect
  draws, render bundles, occlusion queries, timestamp queries per pass,
  workers / OffscreenCanvas for the boot bakes, pipeline-compile ordering.
- v3/AUDIT.md "## Performance" and the "Engine / game split" sections.

## The deliverable

1. A **measured baseline**:
   - boot time per stage;
   - GPU ms per pass at the start view, the busiest view (the post, villages,
     fight) and max zoom out;
   - draw calls, triangles, CPU ms per frame (sim and the DOM HUD:
     squadBadges, markers, minimap).
2. A **ranked list**: each item with its measured or estimated gain, its cost
   to build, its risk, and which game it touches. Load time and frame time
   are separate lists.
3. Then build it in order, measuring each step (A/B in gpuBench), keeping
   `npm test` green, asking before each commit. Write results into TODO.md
   and memory as they land.
