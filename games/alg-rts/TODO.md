# alg-rts — the list

A second RTS on the same engine and in the same style as nam-rts, set in the
Algerian War (1954–1962). Started 2026-09-26. `[x]` done · `[ ]` open · `[~]`
started · **you** = your call or your work.

Keep this file current: tick things off here, add new asks here.

## WHAT IS LEFT — the overview (2026-10-03, you: "make a list of what is remaining")

One screen, most important first. Details stay in the sections below;
"(sugg.)" = my suggestion, not yet your ask.

**1. Performance + load time** (next, in a NEW chat: PERF_AUDIT.md)
- **Baseline + ranked list DONE 2026-10-03** (section "PERF + LOAD AUDIT 2"
  below) — waiting for your go on what to build.
- Measured baseline → ranked list → build it. Load time (animal morphs
  ~4.5 s, shader warm-up, ground cache bake, main-thread builds, textures),
  frame cost (foliage, shadows, scene pass), WebGPU tricks, the editor out of
  the game build. Smaller tech debt: the far grid (4 MB of Float32), tiling
  at full zoom-out, the overlay's ~2-billion triangle count, a black band in
  very high orbit views, a ~1.5k-tri crowd LOD for the bodies.

**2. Gameplay — to make it a whole game**
- VETERANCY per squad (CoH stars).
- The ALN AI goes for the supply points and cuts the lines; its bands
  shown as squads once seen; balance it against paras and Légion.
- MUNITIONS has one use (grenades): more to spend it on (sugg.) — weapon
  upgrades, smoke, a mortar barrage, sappers laying mines, call-ins
  (air strike, napalm).
- PATHS: a "can't go there" cursor; rock where it's too steep.
- Poles: the FLN cuts the line → the post loses its radio (minimap).
- Mines: a minimap mark once spotted, the sapper clears faster; an attack
  order shouldn't end a patrol.
- A game around the battle (sugg.): main menu, options (gore switch,
  sound, keys), pause, end screens that lead somewhere; later missions /
  a campaign.
- Balance passes after you play: prices and incomes, squad sizes, retreat,
  reinforce, the difficulty levels, the bleed rate.
- Check: the "STARTING army still has armour" item (PARKED section) — may be
  stale since the squads start (12 appelés + 2 sapeurs).

**3. Destruction and combat feel**
- Blow apart VEHICLES and BUILDINGS (the men's gib cut for the rest);
  houses COLLAPSE (a village is one merged mesh today); battle damage;
  real wreck shapes.
- ANIMALS DIE (death clips, blood, bodies stay; the rest bolt).
- A tank shell's direct hit gibs a man; dark caps on cut ends; a man
  caught in wire.
- VFX: fire extras (embers, a soot column), the paused "more VFX vs CoH"
  list, a colour-grade LUT + vignette.

**4. HUD / UX**
- Selection card: the squad's name and n/size pips; retreat / reinforce
  icons; real unit icons (mine are drawn stand-ins); building portraits.
- MINIMAP JUMP: the ground texture lags after a jump.
- A third cover colour (red, negative cover) once craters / mud count.
- Sound: a squelch per alert; voices (parked: the free API plan refuses).

**5. World and content**
- FILL THE MAP: dense scrub along the wadis, orchards as a field kind,
  oasis gardens and a second oasis, graded terraces and tracks.
- Buildings: a second outpost (SAS post), the H-34 gunship + a helipad.
- Animals: shepherds with the flocks, flocks that stay together, the hyena
  / gazelle / camel into the game, dressed donkeys and camels; more birds.
- Soldiers that fit French Algeria (today's pack is Vietnam-era); Colonel
  Delorme (built, not in the game), the FLN chief; faces; crawl / prone
  clips.
- Weather: the sandstorm. Night: parked until Sky Pro has its night.
- LATER: the Men of War camera, fog of war without the shroud.

**6. Waiting on you (look / play)** — the "you, look" and "you, play it"
lines below: the new HUD (badges, rings, arrows, minimap, resource strip),
the economy's numbers, the squads, the last-seen markers, the plants, the
ground, soldier1 vs soldier3, the hero in the lab.

## PERF + LOAD AUDIT 2 (2026-10-03, PERF_AUDIT.md) — baseline + ranked list, **waiting for you**

Measured on the dev server (Vite), test Chrome on the 2nd screen, canvas
1440x732 @ DPR 1.1, render scale 1, GPU healthy (gpuHealth 100%). Frame =
gpuBench timeFrames (pipelined CPU+GPU, focus-free). Boot = alg.html stage
times (raw, learned table blanked) + a main-thread trace parsed by caller.

### Baseline — LOAD (warm, 3 boots: 44.9 / 43.7 / 43.3 s)

| stage | s | what is in it (trace) |
|---|---|---|
| page + modules | 1.3 | ~700 unbundled modules (dev server) |
| engine | 1.7 | |
| level + v3proj | 5.4 | project loaded at 7.6 s |
| showroom | 1.5 | contact-AO bake 0.9, kit assembly 0.5 |
| **Mustering** | **20.9** | unit renderer + clip bakes 1.5 · **3D unit thumbnails: 1.2 s PNG encode + ~5.5 s IDLE waiting on readbacks** · scatterField init 2.2 · **portraits (toBlob) ~6 s** · frames behind the screen |
| splats, stones, fields | 1.0 | |
| herds | 5.1 | **groundClamp 3.0 s** + feetFollow 0.6 (per species, CPU skinning every 5th vertex per key per clip) |
| hens | 0.4 | |
| warm-up | 4.2 | 312 drawables |
| bakeAll + 2 frames | 2.3 | |

- **The GPU process compiles ~390 pipelines (519 WGSL programs, 6 MB) EVERY
  boot**: ~26 s of long GPU-process tasks. The main thread's idle gaps and the
  portrait / thumbnail stalls are waits on it. **No shader cache across page
  loads in this Chrome**: the same WGSL after a reload compiled in 66-140 ms
  (= a fresh miss; same page 5-13 ms). 465 of 517 programs are byte-identical
  between loads; 52 (197 KB) change every load (would defeat any cache).
- The scene renders behind the loading screen (throttled 1/s): 10.7 s of
  main thread, mostly first-draw material builds — they would move to the
  warm-up, not vanish.
- Console after boot: only the known "Multiple active KTX2 loaders" warning.

### Baseline — FRAME (ms, scale 1)

| view | frame | CPU | draws | limit |
|---|---|---|---|---|
| post, close | 8.2 | 8.2 | 234 | CPU |
| post, default | 9.3 | 9.8 | 271 | CPU |
| post, max | 12.7 | 10.4 | 300 | GPU |
| Ksar el Hamra default / max | 8.7 / 12.4 | 8.3 / 8.9 | 226 / 236 | CPU / GPU |
| Mechta Ouled Ali (oasis) default / max | 11.7 / 12.4 | 9.4 / 8.9 | 261 / 279 | GPU |
| Dechra default / max | 8.9 / 13.0 | 8.1 / 8.9 | 233 / 253 | CPU / GPU |
| **FIGHT** (49 men + half-track, Mechta, default) | **13.6** | **12.2** | 319 | CPU |
| fight, close | 9.7 | 10.3 | 276 | CPU |

- **Hiding EVERYTHING saves only 0.9 / 1.3 / 1.9 ms** (close / default / max
  at the post): the frame is fixed cost, mostly CPU. GPU per system at the
  post, max zoom (hide-it, noise ±0.4-1.4): terrain 2.2 · post 1.7 · haze
  0.7 · lakes 0.4 · shadow map 0.4 · everything else ≤ 0.3. Default zoom:
  all ≤ 0.8 (inside the noise; the view is CPU-bound).
- **CPU, live trace at the post** (~12 ms/frame under tracing): three's
  render submission 77% (~9 ms for ~300 draws, ~30 µs a draw). In it
  `writeBuffer` 1.6 ms: **1,807 buffer writes, 2.85 MB uploaded per frame**;
  ~1.3 MB of it is INSTANCE-MATRIX uniform buffers of STATIC things (stones
  55 KB each, field walls 20 KB ×2 with their shadow pass, birds, x-ray) re-sent
  every frame — three's buffer binding reports "changed" every draw. Game JS
  ~2.5 ms: units 1.0 (1.7 in the fight), herds 0.67, flag cloth 0.37, fog of
  war 0.24, sky driver 0.15, timestamp resolve 0.2 (dev), HUD markers +
  minimap ~0.15. Fight: **algLastSeen 0.37 ms = getBoundingClientRect every
  frame (forced layout)**.
- Draws at the post, default (297): main pass 209, shadow map 64, bloom 10
  (it is ON: the threshold bloom of 2026-10-02), PMREM ~4 (Sky Pro env re-bake
  every 90 frames ≈ 340 draws in one frame; measured ≤ +5 ms that frame,
  no visible spike in 200 frames). Biggest: tall plants 72 + 12 shadow,
  foliage 33 + 8, kit/unit meshes 27, stones 21 + 2.
- Triangles: the renderer's counter never resets (reads 15.7 billion) — no
  number; fix the counter if you want it.

### Ranked — LOAD (44 s now; target ~25 s first boot, less with a shader cache)

| # | what | gain | build | risk | touches |
|---|---|---|---|---|---|
| L1 | Portraits: pre-cut faces offline (packPortraits.py writes one WebP per face) — no 38 toBlob encodes at boot | **~5 s** (6 s measured at boot, 0.36 s idle) | small | low | alg |
| L2 | Skip the 3D unit thumbnail bake for every type that has a portrait (they are replaced); structure thumbnails after the screen lifts or baked to files | **3-6 s** (1.2 s encode + 5.5 s waiting, partly compiles of thumbnail-only pipelines) | small | low | alg (shared baker untouched) |
| L3 | Animal morph ground clamp: bake each species' lift curves once (tool → JSON, or IndexedDB keyed by a code hash) or test only the candidate lowest verts | **~3.5 s** | medium | medium — every animal re-checked vs its approved shots | alg + engine animalMorph (nam if it uses morphs) |
| L4 | Shader cache: find why Chrome keeps none across loads (origin / flag / Dawn blob cache), test in Electron; make the 52 per-load-varying programs stable; trim pipeline variants (390) | **10-20 s on 2nd+ boots** if a cache works; first boot unchanged | medium (investigation) | low | engine, both games |
| L5 | Overlap GPU compiles with CPU work: start compileAsync of the known materials early (warm-up list) while morphs / scatter / thumbnails run on the CPU | 2-5 s (estimate) | medium | low-medium | shared-rts warm-up |
| L6 | scatterField init 2.2, ground-cache tiles 1.7 + final bakeAll 2.3, contact AO 0.9: cache or bake fewer before the screen lifts | 1-3 s | medium | low | engine |
| L7 | Measure on a PRODUCTION build (vite build), the thing Steam/Electron ships; dev modules cost ~1.3 s+ | ~1 s + honest numbers | small | none | build |

### Ranked — FRAME (the frame is CPU-bound in play: draws × three's per-draw cost)

| # | what | gain (est.) | build | risk | touches |
|---|---|---|---|---|---|
| F1 | Stop re-uploading unchanged buffers: a buffer binding uploads only when its attribute/array version moved (and the camera "render" group once per pass, not per draw) | 0.5-1 ms CPU every view | small-medium (three patch kept in v3) | medium — anything that edits an array without bumping its version freezes; test both games | engine, both |
| F2 | Render bundles (three r184 `BundleGroup`) for STATIC draws: kit pieces, stones, walls, poles, ruins | 1-2 ms CPU | medium | medium (bundles freeze uniforms; shadows) | engine, both |
| F3 | Tall plants: 3 variants in ONE geometry per species/LOD (per-instance variant) — 72 + 12 draws → ~28 | ~1 ms CPU | medium | low (same image) | engine scatter, nam too |
| F4 | Game JS: algLastSeen rect cached on resize (0.37 ms in fights), flag cloth at 30 Hz / off screen (0.37), herds off screen at low rate (~0.4), timestamp queries only while the dev panel shows (0.2) | ~1-1.3 ms CPU | small | low | alg (+ shared wildHerd) |
| F5 | Units hook 1.0 → 1.7 ms in a 49-man fight: profile it (combat, separate, grid rebuild) before it grows with bigger battles | 0.5+ ms in fights | small | low | shared-rts |
| F6 | GPU at max zoom (12.4-13 ms, GPU-bound): bloom 5 mip levels → 3 or half-res, haze 0.7, terrain 2.2 (keep v3: 2.2 ms of 12 is no case for a new terrain) | ~0.5-1 ms at max zoom | small | low-medium (look) | alg / post |
| F7 | Sky Pro env re-bake: only when the clouds visibly changed (≤5 ms once every 1.5 s) — **you** said leave the sky alone: your call | small | small | low | engine sky |
| — | NOT worth it now: compute culling + indirect draws, Hi-Z (the GPU is not the limit at play zoom), a new terrain | | | | |

### Built (2026-10-03, your go: "L1 → L2 → F4")

- [x] **L1 portraits**: tools/packPortraits.py cuts one WebP per face
      (public/textures/ui/portraits/s<cell>.webp, v<cell>.webp, 424 KB;
      `--split` re-cuts from the atlases); ui/portraits.js only hands out URLs.
- [x] **L2**: no 3D unit thumbnails for types with a portrait (all 12):
      createUnitRenderer `thumbnailFor` (shared; null = nam unchanged).
      ?portraits=0 bakes them again. Structure thumbnails unchanged.
- [x] MEASURED L1+L2: boot 43.3-44.9 → **41.0-42.0 s (−2.5 s)**, not the ~9 s
      estimated: Mustering 20.9 → 12.0 s, but herds 5.1 → 8.1-8.4 and the
      warm-up + last bake 6.5 → 11.3-11.6. Pipelines 389 → 385. **The boot is
      bound by the GPU process compiling ~385 pipelines one after another**:
      freeing the main thread moves the wait to the next thing that needs
      the GPU. → **L4 / L5 (a shader cache, fewer pipelines, overlap) are
      the only big load levers left**; L3 (morphs) and L6 will mostly move
      waits too until the compiles shrink.
- [x] **F4 last-seen markers**: canvas rect cached (ResizeObserver), nothing
      done with no markers (was a forced layout every frame, 0.37 ms in a fight).
- [x] **F4 cloth**: flags + windsocks only step when in view (20 m sphere,
      dt kept and caught up): away from the post 0.52 ms → ≈0 a frame.
- [—] F4 herds off screen at a lower rate: NOT done — it changes their
      steps (slope checks, trails, sidesteps) for ~0.3 ms; animals must not
      break each other.
- [x] Stats overlay OFF by default (you: "off the stats panel"; it cost
      0.4-0.8 ms a frame). ?stats=1 / Dev → Performance brings it back.
- [x] **OUR PERF LINE** (you: "our own perf stats ui"): ui/perfHud.js, top
      left — frame ms + worst, CPU ms + worst, draws, JS heap, twice a second
      off the engine's counters (app.takeFrameStats: two clock reads a frame);
      a GPU button runs gpuBench.measureView (the honest frame cost + what
      limits it). ?perf=0 hides; Dev → Performance → "Perf line".
- [x] **F1 INSTANCE MATRICES** (engine opt `instanceAttributes`, alg + nam
      on; ?instubo=1 = old): three kept ≤1024-instance matrices in a uniform
      buffer re-sent on EVERY draw of every pass; now the instanced vertex
      buffer (uploaded only on needsUpdate) + only the DRAWN instances upload
      (kit pieces: 640 slots, 40 KB, for a dozen men). Uploads 2,853 → 1,658
      KB a frame. **alg at the post: 8.0 / 8.9 / 12.2 → 6.4 / 8.0 / 11.2 ms**
      (close / default / max, interleaved loads, stats off both sides); nam
      within noise (8.9 vs 8.7, CPU 8.2 vs 9.1). Checked: men, kit, jeep,
      stones, walls in place and moving; both consoles clean.
- [—] **TRIED, NO GAIN: parallel pipeline compiles in the warm-up**
      (createRenderPipelineAsync for every new pipeline, draws skipped, all
      awaited at once — 16 pipelines 1.0 s one by one vs 0.21 s together in
      isolation). In the game: 134 pipelines in the window, warm-up stage
      11.0 vs 10.4 s without. That stage is main-thread bound (node builds
      ~1.4 s, texture uploads ~1.2 s on first draw). Reverted.
- [x] **L3 ANIMAL MORPHS, faster, same animals**: groundClamp's lowest-point
      search did three's per-vertex getVertexPosition (rebuilds bone ×
      inverse per vertex); now each bone's matrix once per pose and a tight
      loop — 640-730 → 257-274 ms a species, track values within 2.4e-7 (one
      float32 step on values up to 7.85). The builder's read-only measurements
      (hoof flex, walk contact, smoothness) off in the game
      (setMorphDiagnostics(false)): clips and geometry IDENTICAL (diff 0),
      −20-100 ms a species. window.__slowClamp = the old search.
      Herds stage 8.1-8.9 → 5.4 s.
- [x] **L5 PIPELINES IN PARALLEL FOR THE WHOLE BOOT** (v3/render/
      parallelPipelines.js, ?parboot=0 = old): every new pipeline of the GAME
      SCENE is created async (Chrome compiles them side by side) and three
      skips its draws behind the loading screen until it is ready; bakes keep
      the synchronous path (their own scenes). All awaited after the warm-up.
      **Boot 39.5-41.3 → 32.0-33.3 s** (A/B same build; one disturbed run
      53.7). Checked: 0 of 562 draws not ready on the first frames after the
      screen lifts; console clean. (The warm-up-only version had no gain: by
      then ~250 pipelines had queued one at a time.)
- [ ] **nam gets all of this LATER** (you, 2026-10-03: "do this for nam too …
      later, we continue with alg"): the port list is at the top of
      games/nam-rts/TODO.md (boot measure, parallel pipelines, gpuOnly
      release, perf line).
- [ ] Persistent shader cache: Chrome writes DawnWebGPUCache (62 MB) but a
      compute pipeline from a previous load compiled at full cost (46-93 ms)
      in a probe — unproven either way (the probe's device limits differ).
      52 programs change text every load: three names unnamed buffers
      `NodeBuffer_<global id>` (WGSLNodeBuilder) — name them to make the text
      stable before any cache can help.
- [x] **JS HEAP** (perf line read 0.9-1.6 GB): NO LEAK (floor flat over a
      minute; the 1.6 GB was boot garbage before a major GC). After a forced
      full GC: **830 MB live → 566 MB**. 666 MB were typed arrays; ~260 MB of
      them CPU copies of buffers ONLY THE GPU WRITES (crowd skinning output +
      sources, hybrid grass, plant scatter field, revo grass). Now
      v3/render/gpuOnlyArrays.js: systems markGpuOnly() those arrays, the
      game calls releaseGpuOnly() after the boot and every 5 s (a crowd gets
      its buffers with its first man): the ArrayBuffer is DETACHED
      (transfer(0)) — three's storage binding keeps its own reference, so
      swapping the array freed nothing. A released array asked to upload
      logs an error. ?gpuonly=0 keeps them. Checked: grass, palms, reeds,
      soldiers running, ALN spawned later and fighting; console clean.
- [x] **HEAP ROUND 2: 566 → 475 MB live**: the terrain paint layers' CPU
      copies (TextureLibrary.releaseCpuCopies via app.releasePaintCpuCopies,
      56 MB; a slot change afterwards is refused with an error; preview
      colours cached) and the ground-cache SPLAT PHOTOS (splatMaterials, 2 ×
      17 MB, now markGpuOnly: data textures are released once three's
      uploaded version is current). Checked: lit ground at the post (paint,
      track, mud splats, grass) and a re-baked far village (same as
      ?gpuonly=0 — dark only from the fog of war); console clean.
      In one boot the perf line read 505 MB vs 1,470 MB with ?gpuonly=0.
- [x] **PRODUCTION BUILD MEASURED** (vite build + vite preview, port 4173):
      boot **31.9 s** (page + modules ~0.5 s before the engine starts vs
      ~1.3 s on the dev server), frame at the start view 8.8 ms (CPU 9.0,
      CPU-bound — same as dev), **live heap 388 MB** (the dev server's module
      text and source maps gone). Console clean.
- [x] **FIRST LAUNCH RELOADED ITSELF**: on a clean install the engine started
      at its default terrain size, the level was another size → saved + page
      reload, a whole boot thrown away: **39 s → 31.6 s** (cold HTTP cache).
      alg.html writes the level's terrain config before the engine loads (a
      level of another size still takes the reload path). Every new player
      saw this; Electron's first run would have too.
- [x] gpuBench / the GPU button worked only in dev (window.__V3_DEBUG):
      falls back to the game's app.renderer.
- [x] **PLANT FIELDS: EMPTY DRAWS CULLED ON THE CPU** (engine opt
      plantCpuCull, ScatterField.setCpuDensity; ?plantcull=0 = old). The
      fields draw every species × variant × detail level every frame (125
      draws at the post, 45% of the frame); the GPU fills each, often with
      nothing (26 of 36 tall-plant meshes empty at the post). Each frame the
      CPU now proves, from the PAINTED density (a superset of what the GPU
      reads), the tile + outer radius, the detail bands (+ margins), the
      species' height band and THE COMPUTE'S OWN padded frustum + near-depth
      slab as planes, which draws CANNOT hold a plant, and hides them.
      PROOF: GPU counts read back over 48 views + 240 frames of fast pan/zoom/
      spin — no hidden draw ever had a plant (a plain frustum DID miss 1-7
      foliage plants for 4 frames: the compute pads NDC 0.35-0.6). Hides
      ~17% (tall) / 12% (foliage) — the rest are empty only by chance (thin
      density), which cannot be culled safely. **Frame: −0.72 close, −0.40
      default, −0.42 cedars, −0.71 oasis, ±0 max** (interleaved, same page).
- [—] **RENDER BUNDLES for the plant fields: NOT KEPT.** An A/B said −1 ms,
      but the CEDARS DISAPPEARED: inside a bundle the colour pass (depth-equal,
      after the depth pre-pass) lost its order — the "saving" was trees not
      drawn (found by looking: shadows on the ground, no trees). Doing it right
      = the pre-pass meshes in their own bundle drawn first. Gain unknown.
- [x] MEASURED, NOT WORTH IT (2026-10-03, same session, continued):
      - Shadow pass: switching off the 21 shadow draws of every static caster
        (buildings, walls, outcrops, stones, poles — 58 → 37) saved NOTHING at
        close/default, 0.4 ms at max. Shadow draws are cheap on the CPU (depth
        materials). Merging them: no.
      - Static buildings etc.: hiding ALL 79 static meshes saves 0.74 / 0.86 /
        2.35 ms — their whole cost incl. GPU shading; a merge only takes the
        per-draw CPU part (~0.3 ms). No.
      - Bloom mask from a small effects-only pass (no MSAA mask attachment):
        built, measured WORSE in CPU-bound views (+0.5-1.35 ms: a second scene
        walk + the effects twice), −1 ms at max only, and its occlusion was an
        approximation (the effects write the mask through their own mrtNode,
        so no per-fragment depth test). Reverted. Bloom itself costs 1.0
        (default) / 1.7 ms (max) — turning it off is a LOOK call (yours).
      - 4x MSAA: off saves 1.3 ms at max zoom, ~0 elsewhere (CPU-bound).
        Kept. ?msaa=0 to measure (engine opt `antialias`).
      - HouseRubble draws with 0 instances (1 wasted draw, negligible).
- [x] **BOOT ~31 → 26.6 s: the plant fields built their shaders 6-36x over.**
      Fresh boot trace: the boot is now MAIN-THREAD bound (30.7 of 35.7 s
      busy; GPU process 37 → 14 s after the parallel pipelines), 10.5 s in
      the frames behind the loading screen = three building node shaders.
      renderer._nodes.nodeBuilderCache: 579 builds, 178 distinct shaders —
      three adds the object's uuid to the cache key of anything with
      count > 1, and every plant-field mesh had count = plant capacity (its
      draw is INDIRECT: the GPU sets the count). count = 1 → 402 builds, GPU
      pipelines 385 → 223. Frame unchanged (6.3 / 8.05 / 11.1). Checked:
      cedars (variants, shadows), oasis at max zoom (palms, oleander, hedges,
      grass, far slopes) — all there; console clean.
- [x] **BOOT 26.6 → ~22 s (20.6 / 24.2), same output bit for bit:**
      - bakeContactAO (rtsParts, every kit piece): the 125-neighbour kernel
        built once (offsets + weights) instead of a hypot and a radius test
        per neighbour per vertex: 3.3x faster, max diff 0 (Node test against
        the old function). Showroom 2.1 → 1.5 s.
      - animal morphs' feetFollow: each time posed once for the four legs (was
        once per leg per key): ~100 ms less a species, clips max diff 0 (in
        page against the committed module). Herds 3.1 → 2.6 s.
      - Left in the boot (trace): the frames behind the loading screen (~7 s:
        three building node shaders + first texture uploads — the paint and
        splat arrays, ~90 MB, once), the level file 4.4 s, the engine 1.9 s.
- [x] LEVEL STAGE looked into (~2.5-3 s): decode 0.11, sky look 0.33,
      decals 0.51, paint layers 0.25, refreshWorldHeights 0.7 — no single big
      wait left. The level was DECODED TWICE (the loader's size check, then
      loadProjectFromBuffer): the loader now passes its `decoded` (~0.1 s).
      TRIED, NEUTRAL: the parallel-pipeline window opened by the engine from
      its first frame (instead of after startV3App) — the stage did not move
      (its idle gap was not the early compiles). Reverted.
- [x] **BIG FIGHT PROFILED** (83 men + 3 vehicles engaged, Mechta Ouled
      Ali): the units hook ~2.0 ms a frame; in it the squad badges' per-frame
      getBoundingClientRect (a forced layout: 144 ms of a 5 s trace). Now
      shared-rts/canvasRect.js `rectOf(el)` — cached, dropped on resize /
      scroll, re-read at most once a second — in the squad badges, the battle
      HUD markers, the unit hover test and the camera's edge scroll (all read
      the canvas rect every frame). Hook 638 → 530 ms (−0.35 ms a frame in that
      fight). Badges checked on their squads. The sim step (~0.7 ms at 83 men)
      is spread thin (separation 0.14, influence 0.07, avoidance 0.05 …):
      nothing worth cutting yet.
- [x] **STONES: ONE MATERIAL** (you: "do the stones anyway"): the five
      ground photos as one texture array (rows packed as the image textures
      sampled them), each stone's ground a per-instance attribute (layer +
      tint); one instanced mesh per shape variant: 23 → 9 meshes. Same 5,742
      stones, same per-ground counts, each keeps its old sink/scale jitter
      (its index in the old list). Draws −14 in every view (175 / 230 / 276),
      builds 402 → 392, frame within noise. Side by side at a scree slope: the
      same; crops differ 1.5-4 levels of 255 (plants and haze move). The
      array's CPU pixels are released (markGpuOnly). clearWhere moves the
      ground index with the matrix.
- [x] SHARED NODE BUILDS (engine render/sharedInstanceBuilds.js, 2026-10-03,
      found in nam's boot): instanced meshes on ONE material now share one
      build (three keyed each on its uuid). alg: builds 389 → 289,
      main-thread build time 7.0 → 4.2 s; frame A/B within noise (default
      9.1 vs 9.3, max 11.9 vs 12.2 ms); matrices proven by GPU readback.
      ?instshare=0 = one build each. (nam: 728 → 405.)
- [ ] **REPO STUDY (2026-10-03, analysis only, nothing measured) — ranked
      engine work for BOTH games:**
      1. ~~STABLE WGSL TEXT~~ MEASURED 2026-10-03, LOW VALUE: 339 of 355 of
         nam's shaders are ALREADY identical between launches (node ids come
         out in the same order). And Chrome's disk cache only HALVES a
         compile: a new 68 KB shader 0.9 s, the same after a reload 0.45 s,
         in the same page 7 ms. The 16 that differ compile in parallel —
         under ~1 s to win. Not worth a three patch.
      2. ONE per-draw uniform buffer (dynamic offsets, one writeBuffer a
         frame) instead of three's per-object buffers + bind groups
         (Tidewater MeshRenderer). MEASURED 2026-10-03, alg default view, 183
         draws, trace 1.2-4.6 s: the render path ~4.8 ms CPU a frame, of it
         per-object bindings ~2.0 ms (_updateBindings; writeBuffer alone
         0.7 ms), the native draws 0.4 ms, the shadow render ~0.9 ms. So up
         to ~1-1.5 ms a frame to win. Deepest change on the list (three's
         Bindings/backend); do it only behind a flag with a pixel A/B.
         **FIRST STEP DONE 2026-10-03, no three patch needed:** counting the
         uploads found 1,067 a frame (1.1 MB) for 227 draws, almost all
         `uniformArray`s in three's default PER-OBJECT group, re-sent for
         every draw of every pass: the plant fields' type tables
         (scatterField uTypes/uShadowCast, placedFoliage uTypes) and the
         interior-lighting hook's 5 arrays, which are on EVERY material through
         the fog (unused in the RTS games). Moved to the shared renderGroup:
         **1,067 → 353 uploads, 1.1 MB → 280 KB a frame; binding update
         ~1.5 → ~1.1 ms CPU** (alternating loads, both zooms). Pixel A/B at
         a frozen frame: identical except animated cloth/wire and the HUD.
         nam after: 459 uploads, 399 KB.
         **SECOND STEP DONE 2026-10-03:** the per-object blocks were re-sent
         because GLOBAL uniforms sat in every material's per-object block:
         the fog's 28 (scene.fogNode, uValleyTime ticks every frame) and the
         cloud shadows' 10 (through the sun light; `offset` drifts every
         frame, even with cloud shadows off) → three's shared FRAME group
         (sent once a frame per material, only when changed). The interior
         arrays got a shared group of their own that uploads ONLY when
         syncFromRegistry runs (named "render" so it joins that bind group
         instead of taking a 4th slot) — proven: 0 uploads, 68 the frame
         after a sync, then 0. **alg: 1,067 → 110 uploads a frame, 1.1 MB →
         37 KB; binding update ~1.5 → ~0.8 ms CPU. nam: 459 → 118, 36 KB.**
         Pixel A/B identical (only cloth, wire, birds' flight, HUD differ).
         What is left (~50 per-object uploads) is real per-object data. The
         Tidewater-style one-buffer rewrite of three would now win at most
         ~0.5 ms: parked.
      3. MULTI-TYPE INDIRECT BATCH for props (Tidewater ReefBatch / the
         custom path three r184 already allows: one merged geometry,
         geometry.setIndirect with many offsets, compute cull writes the
         counts) → ~80 prop renderObjects a pass become 1. One material:
         per-type textures via texture arrays (the alg stones pattern).
      4. ~~STAGGERED CASCADES~~ DOES NOT APPLY: the games have no cascades
         (one fitted map; the editor-only stagger was built and reverted
         2026-10-01, ~0.2 ms). MEASURED 2026-10-03 (alg, map frozen with
         app.shadows.debugSkipMask(1), interleaved x4): the WHOLE map costs
         default 8.60 → 7.89 ms frame (CPU 5.8 → 5.2), max zoom 11.19 →
         10.61 (CPU 6.4 → 5.5). Redrawing it every 2nd frame = ~0.3 ms on
         average, paid for with unit/animal shadows stepping at 30 Hz and the
         fit lagging a frame on pans. Parked unless you want it.
      5. Shadow LOD picked from the MAIN camera's distance (InstancedMesh2);
         LOD hysteresis if missing.
      6. Render bundles only around GPU-indirect draws (args read at replay,
         so culling still works); static props otherwise freeze culling.
      NOT worth it: InstancedMesh2 (WebGL-only), BatchedMesh +/- agargaro's
      extensions (r184 WebGPU still issues one drawIndexed per instance,
      CPU culling), multiDrawIndirect (Chrome-experimental, three unused).
- [ ] Remaining duplicate builds (~115 now): mostly DIFFERENT materials with the
      same structure (stone sets, walls, outcrops, vehicle parts — three must
      build per material: the build binds its textures) and the placed
      foliage's per-object buffers. Cutting them = content work: e.g. the
      stones as ONE material + texture array (also ~20 fewer draws).
- [ ] **NEXT (proposed 2026-10-03, continue later)**:
      1. SHADOW PASS — 62 draws a frame at the post, many small (one per
         outcrop / wall / building piece): merge or skip casters too small to
         matter at the RTS camera.
      2. MERGE THE STATIC BUILDINGS — ~24 draws (showroom kit pieces): a few
         merged meshes per material (they never move).
      3. MAX-ZOOM GPU (12-13 ms, GPU-bound): terrain shader 2.2 ms, post 1.7
         (bloom 10 passes, haze).
      4. Plant render bundles done right (the depth pre-pass in its own bundle
         drawn first) — only if 1-2 leave the CPU still the limit.
      5. BOOT (~32 s): fresh production trace to re-rank; stable WGSL names
         (NodeBuffer_<id>) so a shader cache can work — test in Electron.
- [ ] One flaky suite: npm test read 197/198 once, 198/198 twice after
      (which one not caught).
- [ ] Heap left (475 MB): ~150 MB is the DEV SERVER's module text and
      source maps (gone in a production build); texture arrays kept on the
      CPU after upload (2 DataArrayTextures 58 MB, DataTextures ~25 MB);
      the splat map's working copies (~50 MB, the game samples it on the CPU);
      the ground cache's bake index (~34 MB). GPU side: three 16 MB heightmap
      readback staging buffers created at boot (check they are destroyed).
- [ ] Remaining per-frame uploads (1.66 MB): our own buffer()/uniformArray
      nodes (oven smoke 60 KB, x-ray 48, birds 48, sprite/bars ~100) use the
      per-object group → one upload per draw per pass; a shared uniform group
      bumped on change uploads once (three: sharedUniformGroup + needsUpdate).

## PERF + QUALITY AUDIT (2026-10-01, you: "measure first, popping, culling, shadows, errors")

Method: games/alg-rts/gpuBench.js (render N frames through the loop +
onSubmittedWorkDone, cases interleaved; scale 1 = what you play, scale 2 to
magnify GPU costs). The stats overlay's
GPU ms and the per-pass timer are NOT reliable for A/Bs here.

- [x] **Scene pass wrote 4 MSAA targets nobody read** (diffuse + normal for an
      SSAO that is off, emissive for a bloom that is off): colour only now,
      a target joins when something asks for it (bloom on → emissive back).
      Before → after at YOUR resolution (scale 1): close 13.9 → 12.2,
      default 15.9 → 13.9, max 18.7 → 15.7 ms (at 2x: 37 → 25, 56 → 37,
      84 → 41 — the targets ran out of bandwidth there). nam keeps what it
      reads (bloom, paddy normals).
- [!] YOUR GPU WAS IN THE THROTTLE LATCH during this audit (885 of 3105 MHz,
      23 W, reason 0x24 at 66 °C): absolute ms here are ~3x high; the A/B
      deltas are interleaved and hold. EC reset when convenient.
- [x] Render error on the first render-scale change (Sky Pro haze history
      bound before it existed) — fixed.
- [x] Boot warning "timestamp queries exceeded" (ground cache bakeAll) — fixed.
- [x] Ground cache vs live blend (?gc=0): the cache is 10.2 ms CHEAPER at max zoom.
- [x] CLEAN NUMBERS after the EC reset (GPU 41-45 W, 1.7-1.85 GHz), scale 1,
      base view: frame 12.0 ms default / 12.5 max (GPU-bound; CPU 8-9.5 ms).
      Cost of each (hide it, interleaved, ±0.4 noise), default / max:
      terrain 2.75 / 3.2 · lakes 1.5 / 1.6 · Sky Pro update + dome 1.1 / 1.8
      (never on screen in the RTS view) · haze 1.3 / 1.2 · shadow map 0.7 /
      1.3 · stones 0.6 / 0.7 · buildings, units, animals, birds 0.1-0.4 each ·
      trees + foliage −0.5 (they hide terrain that costs more to shade).
   - [—] Sky Pro skip-when-unseen (~1-1.8 ms): NO — you, 2026-10-01: leave
         the sky alone (the free camera / future third-person views).
   - [x] LAKES: every frame an oasis was in view the frame was copied 4 times
         (1 depth + 3 COLOUR): each .sample() clones three's viewport node and
         every clone copies. Now one colour copy per render
         (lakeMaterial CopyOnceSharedTextureNode; rivers share it): 4 → 2,
         water unchanged. ms: not clean (latched GPU) — 0 to −0.9 ms; lakes
         hidden at the base now ≈ 0 (the clean breakdown had 1.4).
         A/B: __V3_DEBUG.waterGrabPerSample = true.
   - [—] Haze: the full-res copy back into the frame: MEASURED 0.09-0.23 ms
         (healthy GPU, skipped by a probe). Not worth changing the post /
         Sky Pro hand-off shared with Apex Rush and nam for ~1% of a frame.
- [x] POPPING (engine, both games): the plant fields' tile now centres on the
      GROUND ON SCREEN (main.js viewFootprint) and fades past the farthest
      corner (max zoom: fade at 186/194 m from the view's centre; before 173/
      180 m from the CAMERA while corners reached 250-263 m); detail switches
      measured from the camera. Plant shadows cover the WHOLE view (was a 35 m
      circle sliding under the screen). Orchards' far detail casts. The RTS
      camera moves at the START of the frame (app.addPreUpdateHook) — the
      clipmap, plants and shadow fit no longer see last frame's view (alg;
      nam still updates its camera in its tick).
      Cost (scale 1, interleaved): alg +0.3 ms (anchor), shadows within noise;
      nam +0.7 (anchor) +0.55 (shadows). Debug: __V3_DEBUG.scatterCameraAnchor
      / scatterShadowCircle = true for the old behaviour.
   - [ ] **you, look**: plants now shaded all over the view (darker canopies,
         was pale/flat outside the circle) — keep? nam too (+1.3 ms there).
   - [x] SHADING BAND (you: "the bottom of the screen has those shadows, the
         top doesn't"): only the nearest plant detail level RECEIVED shadows
         (8/24 foliage, 12/36 tree meshes) — past ~105/131 m from the camera
         crowns went flat bright green, a band following the camera. Now all
         three levels receive (boot option scatterReceiveLods: 3 in alg; the
         engine default stays 1). Before/after at a wooded slope: crowns shaded
         across the whole view. Cost: within noise (≤0.3 ms, latched GPU) at
         wooded default/max and the base. ?recvlods=1 = the old way.
   - [x] GRASS CUT (you): the oasis grass blades fade at a FIXED 44-68 m from
         the camera (revo grass) — mid-screen at default zoom — and past them
         the ground went BARE: the terrain's far-grass tint had been compiled
         out (grassFar: false) when the map had no grass. grassFar back ON:
         the ground takes the blades' colour across the same fade band, so the
         blades hand over to green ground. Before/after (oasis far up the
         screen): bare → green to the top. Cost +0.2-0.8 ms (latched GPU;
         max zoom the most). ?grassfar=0 to compare. Blades further out: only
         if you still see a seam (a much bigger cost).
   - [x] **FAR GRASS THAT LOOKS LIKE GRASS** (you: "looks like bad tiling
         texture, not grass from far"): baked into the ground cache
         (groundCache farGrass): Poly Haven rocky_terrain_02 (aerial, 90 m,
         public/textures/grassfar), luminance only, hex-tiled, on the blades'
         own average colour, noise clumps (the tint's were sines = the tiled
         look), on rings past the blades' fade. The live tint is off (only
         with ?gc=0 / ?fargrass=0 / ?grassfar=1). SPLATS no longer bake
         inside painted grass (the mud patches were tan holes in the meadow).
         Cost: a wash vs the tint (±0.5 ms, latched GPU); no re-bake while
         still.
   - [ ] **you, look**: the oasis meadows from default and max zoom; the
         hand-over from blades; the near oasis without its dirt patches.
- [x] **GROUND SHARPNESS — the cache loses detail with distance** (you: "CoH
      looks really good resolution"). MEASURED 2026-10-01, same frame, cache
      vs live paint (?gc=0, mips + anisotropic): the cache keeps 64% of the
      fine detail at the top of the screen, 75% mid, 88% near. Cause: the
      rings have NO mips and no anisotropic filtering, and a pixel picks its
      ring by its LONGEST axis on the ground (an RTS pixel is long and thin)
      → blur, growing up the screen. uLodBias −1 recovers 80/91/94% but the
      far ground still streaks sideways (no aniso) and risks shimmer. Fix:
      mip levels per ring (rebuilt per baked tile: 128/64/32/16), ring by the
      SHORT axis, hardware anisotropic sampling. Needs your go. 2k source
      photos would NOT help (the cache limits, not the photos).
   - [x] TRIED, NO GAIN: ring by the short axis + 4 taps along the long one
         (shader anisotropy): sharpness unchanged at default AND close zoom
         (1.00-1.01) — the ring a pixel reads is set by how far each ring
         REACHES from the focus (ring 0 only ±20 m, ring 1 ±41 m), not by
         the pixel's shape. Removed. Mip chains per tile: ~16 more passes a
         tile, not built.
   - [x] Hex tiling costs a little: 72% (hex) vs 77% (grid) of the live
         paint's detail far — kept (groundCache hexBake, ?gchex=0 to A/B).
   - [x] FXAA WAS BLURRING THE WHOLE FRAME: it ran on top of the 4x MSAA.
         Off in alg (?fxaa=1 back), + a light CAS sharpen 0.3 (?sharpen=).
         Same frame: fine detail ×2.7 (FXAA off), ×4 with the sharpen —
         stones defined instead of blobs. Cost ~0. **you**: judge shimmer
         on leaves / thin wires while panning (FXAA was their only AA).
   - [x] DETAIL LAYER (groundCache detail, alg 1, ?detail=0): the bake
         stores the dominant paint layer (normal alpha) and the paint
         fraction (colour alpha; splats + far grass lower it); the terrain
         adds that layer's band-passed grain at draw time (photo sharp ÷
         photo at the cache texel). +29% fine detail far, +11% mid, ~0 near
         (by design). Cost ≤0.25 ms. Rings centred on the screen ground:
         NOT done (far edge 50 m vs ring 1's 41 m reach — no gain, re-bakes).
   - [ ] **you, look** in the game: crispness, shimmer, the grain on the
         ground (too strong? uDetail is live: __ALG.groundCache.uDetail.value).
   - [x] nam: its camera (+ foliage thinning) moved to addPreUpdateHook.
         Checked: panning 0.9 m a frame, the plant field's camera = the real
         camera on every frame (gap 0; was one frame behind).
- [x] DRAW CALLS (you: "~293 at the base, is it plenty?"): 287-310 a frame =
      tall plants 84 (4 species × 3 variants × 3 details, depth pre-pass +
      colour, + shadows), VEHICLES ~68 (6 types × body/gear/stencil + x-ray
      twin + shadow — one of each, drawn wherever the camera looked), foliage
      33, stones 22, soldiers' kit 13. CPU ≈ 8.5 ms a frame, ~16 µs a draw.
      FIXED: an instanced vehicle out of view (and its shadow's reach: 12 m,
      aircraft 60 m) writes no instance — away from the vehicles 283 → 205.
   - [ ] Tall plants: 3 variants (your pick for variety) = 24 of the 84; the
         depth pre-pass doubles them but saved ~14 ms on the cedars. Keep.
   - [x] Crowd soldiers + herds off screen: no longer skinned, drawn,
         shadowed or x-rayed unless near the view (on screen + 12 m shadow
         reach); their clip / graze state still advances. Checked: soldiers
         12 at the base → 0 away → 12 back; herds 23 of 142 animals drawn at
         the flock, 0 away (before: all 142 every frame). Both games.
- [x] PANNING costs +2.7-2.9 ms a frame at every zoom: ALL of it the ground
      cache's tile bakes (3 tiles × ~0.8-1 ms). Splats per tile now only those
      that overlap it, in list order (was all 4207 per tile): −0.1 ms a tile.
   - [x] MERGED PASSES (groundCache O.mergedPasses, default on): paint,
         splats, decals and cavity are meshes of ONE scene per target →
         7 render passes + 7 submits a tile become 2 (21 → 6 a panning
         frame). Output BYTE-IDENTICAL (layer cleared, both paths baked,
         colour + normal read back, rings 0/2/4: max diff 0). The ms saved
         MEASURED CLEAN (GPU 1.8-2.1 GHz, interleaved, panning 40 m/s):
         default zoom 13.2 → 11.6 ms (−1.7 min / −1.9 mean), max zoom −0.2 /
         −1.1. Panning now costs ~1.5-2 ms over still (was ~3).
- [ ] Static shadows into the cache: NOT worth it now — the whole shadow map
      measured ≤0.5-1 ms in every A/B of this audit (the bar was 1.5 ms).
- [x] PERF PANEL (Dev → Performance, gpuBench.js): **Check GPU health**
      (a fixed compute kernel's TFLOPS vs the best this browser has seen —
      catches the latch: it read 1.8-2.9 latched), **Measure this view**
      (frame ms min/mean, CPU ms, draws, GPU- or CPU-bound), **Break it
      down** (~40 s: each system hidden in turn, order rotated per round,
      with a noise figure from a second untouched base). The old hint that
      called the pass timer trustworthy is gone.
   - [ ] **you**: press Check GPU health once right after a fresh EC reset,
         so "best seen" is a healthy reference.

## SQUADS + RETREAT + REINFORCE (2026-10-03, you: "let's go")
- [x] algSquads.js — a LAYER over the men (every man stays a unit in
      units.list). French infantry is bought, selected and ordered by SQUAD:
      Groupe 6 appelés (300), Génie 2 sapeurs (150), Stick 5 paras (450),
      Légion 5 (650). Slot = look role (0 leader, 1 radio, 2 FM gunner;
      units.spawn `lookRole`). Start army: 2 groupes + 1 génie team.
      · shared selection `squadOf` (opt-in, nam unchanged): a man selects his
        squad, shift toggles it, a move forms each squad round its own spot.
      · RETRAITE (T): hold fire, can't be pinned, 140% speed, 60% damage, to
        the muster; a new order calls it off. In the post's zone (48 m) the
        wounded HEAL (3 hp/s, out of fire).
      · RENFORCER (Y): at the post, one man per click (30/45/60/80), out of
        the gate in the dead man's slot (his kit), to his squad.
      · army tabs: one stable tab per squad, n/size, RETR state.
      Tested in game: select-one → 6; losses → slots freed; retreat → home,
      healing; 2 reinforcements → slots 2 and 4 refilled with roles 2 and 4.
- [ ] you, play it: squad sizes and prices, the retreat's speed, the reinforce cost.
- [x] LAST SEEN markers (algLastSeen.js, 2026-10-03): an FLN man seen then
      lost → a faint red ring + "? ×n, N s" where he was LAST SEEN (men lost
      within 12 m merged). Goes when one is seen again near it, when you look
      back at the spot after it was out of sight, or after 35 s. Dead men: none.
      Tested with scripted men (merge, re-seen, look-again).
- [ ] you, play it: the markers' size and how long they last (35 s).

## FROM YOUR PLAY (2026-10-03)
- [x] CANCEL a queued unit: click its portrait in the building's queue (a ✕
      on hover), full refund (algProducer `cancel`, the economy's `refund`).
- [x] Fields drawn OVER a sapper's site: worked soil (FieldSurfaces, draped
      +0.1 m) hid the 6%-high foundation. The field shader now has HOLES
      (up to 24 footprints, soft 0.5 m): a site clears the field under it
      (algFields `cutHole`, called by algBuild; wire excepted).
- [ ] **MINIMAP JUMPS: the ground texture takes time to update** (you): the
      ground cache re-bakes its rings round the new focus, and until it has
      the terrain shows unbaked / wrong. Ideas: a coarse ring covering the
      WHOLE play box, baked once and never dropped (a jump always lands on
      something right); bake the new focus centre-out first; or hold the old
      tiles until the new ones are in.
- [x] **THREE RESOURCES** (you: "the full three-resource economy", CoH):
      algEconomy.js — Effectifs (from Algiers, 280/min less UPKEEP past 14
      men and 5 per vehicle, floor 100), Carburant and Munitions from the
      land. 6 SUPPLY POINTS on the pistes (Puits d'Ain Tighanimine M,
      Carrefour C, Gué de l'oued C, Col du ravin M, Source d'Aïn Kerma M,
      Débouché du ravin C; 12/min each, 22 m ring, capture 1.6x faster than
      a village) + the villages pay all three. A point pays only while
      LINKED to the post: a chain of held points ≤ 180 m apart (the ksar
      needs the col, the far mechta the ford, the dechra Aïn Kerma); cut
      off = amber, pays nothing. Costs: infantry effectifs; vehicles, the
      Alouette and the tiers + fuel; the Légion + munitions; a GRENADE 15
      munitions. The ALN keeps one purse. Strip top right: three stocks +
      incomes; buttons show each resource; tooltip says what is missing;
      a convoy brings 20/10/15.
- [ ] you, play it: the prices and incomes (algEconomy P + COSTS, tiers in
      algTiers) — first numbers, not tuned in a full game yet.
- [ ] The ALN AI does not go for the supply points on purpose (its bands
      take them only passing through): raid cut-off points, cut the lines.
- [x] **PATH DOTS** (you, CoH screenshot): algPathDots.js — white dots
      every 2.4 m along each selected squad's A* route (units.route, new
      read-only getter in shared units.js), one trail per squad, eaten as
      it walks. One draw (the ring field, filled discs).
- [ ] PATHS, the rest: a cursor that says "can't go there", rock where
      it's too steep.
- [x] **MINIMAP BIGGER + CoH** (you): 236 → 320 px; TERRITORY sectors (each
      point owns the ground nearest it, tinted by holder, borders; redrawn
      only when a point changes hands); the SUPPLY LINES dashed from the
      post; supply points as C / M tokens; ONE marker per French squad.
- [ ] you, look: the minimap (sector tint strength, the line, the badges).
- [x] **CoH LOOK PASS on selection** (you, 2026-10-03, watching CoH):
      path dots keep their size ON SCREEN (radius = camera distance x
      0.0032, 0.07-0.3 m; 0.32 fixed was too big, 0.15 vanished); rings a
      10% band (18%), building brackets 0.2 m (0.45), bars 0.28 m (0.55) —
      opt-in options, nam unchanged. SQUAD BADGES (ui/squadBadges.js): over
      each French squad its men left, a shield with its type (rifle,
      spanner, parachute, Légion grenade) and ONE thin bar; the men lose
      their own bars (unitRenderer `barFor`). Click = select the squad,
      double click = camera. Fixed: path dots and the minimap grouped by
      `squadOf` — a fresh array each call — so nothing grouped (now
      `squads.of`).
- [x] Path dots back to FIXED 0.15 m every 1.8 m (you: the distance-scaled
      size was worse).
- [x] **ORDER CHEVRONS** (you, CoH: "that yellow thing" instead of the
      pulsing ring): ui/orderMarks.js — a golden double chevron drops over
      EACH MAN's spot, bobs, fades in 1.6 s. Colour = COVER there, as CoH:
      GREEN heavy (algCover ≥ 0.45: walls, sandbags, banks), YELLOW light /
      open; an attack: one red over the target. Shared selection got an
      opt-in `orderMarker(x, y, z, units, kind)` hook (nam keeps its ring).
- [x] The order mark is CoH's now (your screenshots): FOUR small flat arrows
      in a ring round each man's spot, tilted like petals, closing in and
      pointing down at it, unlit and bright; one instanced opaque mesh. (A
      lit 3D chevron came first: "not that type of 3D".)
- [x] **THE FIELDS OVER EVERYTHING — fixed for good** (you: "smoke, then a
      site, now the white dots; it should never happen again"): see-through
      things draw by renderOrder, the fields were 40 and the rings, path
      dots, brackets, searchlight pools, bird shadows, the build ghost were
      0-4 → drawn first, covered. ONE table now, games/shared-rts/
      renderOrder.js (GROUND 40-44 < ON_GROUND 46 < AIR 49-53 < HUD 1000);
      every order in shared-rts + alg-rts uses it. tools/
      renderOrderBandTest.mjs fails on a bare number, on a transparent
      material with no band, and on a band used without its import.
- [ ] maybe a THIRD colour (CoH: red = negative cover — a crater, open
      mud): we have no negative cover yet.
- [ ] you, look: badge size, the icons (drawn by me — game-icons.net was
      unreachable), ring/bar thickness.
- [ ] **THE PERF + LOAD AUDIT** (you, 2026-10-03): its brief is
      games/alg-rts/PERF_AUDIT.md — run it in a NEW chat.
- [ ] **LOAD TIME** (you, 2026-10-03: "quite slow, is it the best we can
      do?" — later): measure the boot's stages first (alg.html already
      logs them for its progress bar), then the usual suspects: the animal
      morphs (~4.5 s), shader compiles / warm-up, the ground cache bake,
      plants and props built on the main thread, textures not compressed.
      nam went 46 → 24 s the same way.
- [ ] **BLOW APART VEHICLES AND BUILDINGS** (you, 2026-10-03: "we have a way
      to make the soldiers explode to pieces, it would be cool for vehicles
      and buildings"): the men's GIBS cut (algCombat gib, unitRenderer
      `gibs`) for the rest — a vehicle's wreck throwing its parts (wheels,
      hatch, turret popped off and tumbling, burning hulk left), a building
      or sangar collapsing in chunks with dust (rubble left, its footprint
      opened on the nav grid). Ties into BATTLE DAMAGE on buildings below.
- [ ] **ANIMALS DIE** (you, 2026-10-03: "they have death animations, we
      have blood and splashes"): the herds' animals take hits — stray
      bullets, grenades, shells, napalm, fire — play their death clip, bleed
      (the shared bloodField pools + spray, as the men), the body stays;
      the rest bolt. Nobody aims at them. Later: a village whose flock you
      killed turns against you. (Was parked below under BLOOD.)
- [ ] next on this: veterancy per squad; the FLN's bands shown as squads to
      the player (their tabs when seen); retreat/reinforce icons (game-icons
      unreachable from here — text labels for now); the selection card
      showing the squad's name and its n/size pips.

## PARKED / NEXT (2026-09-30)

- [~] **THE COH GROUND** (2026-10-01; you: "that same CoH terrain texture,
      whatever we need to do"). CoH uses ≤4 tiles + hundreds of SPLATS baked
      into a terrain texture cache; we did the same:
      · [x] GROUND CACHE (v3/terrain/groundCache.js, on in alg, `?gc=0` =
        the live blend): 7 rings × 2048² (2 cm → 1.28 m texels, 235 MB),
        paint + splats + decals baked in 256² tiles around the look point,
        the terrain reads 4 taps. Decals no longer draw live (no depth copy).
        Verified: same pixels as the live blend at the post (A/B in-page).
      · [x] CAVITY baked in: hollows darker/warmer, crests lifted (uCavity).
      · [x] SPLATS (algSplats.js, rules from paint/slope/hollows/villages):
        ~4200 over PLAY+90 m from 18 Poly Haven materials (512² webp,
        public/textures/splats/, tools/fetchSplatMaterials.mjs). Colour-
        matched to the ground under them; lobed, holed outlines.
        `?splats=0` = without.
      · [x] Round 2 (you: "textures are tiling … look wrong", "moving the
        camera drops perf"): every layer was 3-12× its photo's real size
        and nothing broke the repeat. HEX TILING in the bake (every layer,
        splatOverlayTsl hexSample) — no grid. Scree gravelly_sand (pure
        orange sand) → rocks_ground_02; ridge + cliff → rock_boulder_dry
        (grey-beige limestone; the orange cliff_side read as red paint)
        — tools/algGroundLayers.mjs, level backup .orig/.bak (not to
        commit). Perf: rings follow the camera FOCUS (turning/zooming
        re-baked whole rings), tiles render straight into the cache (no
        copies), 3 tiles/frame, coarse rings first. Stats overlay ON
        (?stats=0 to hide).
      · [ ] **GPU ms A/B cache vs live** — needs you: focus the page, one tab.
        In-page: `__v3TerrainLOD.buildVariant(feats, { groundCache: null })`.
      · [ ] **you, look**: default zoom over soil, scree, the wadis, the
        hamlets (rubble at the walls, furrowed fields), close zoom.
      · [ ] Next: bake STATIC SHADOWS (buildings, trees, rocks) into the
        cache → the live shadow map only for units; contact blobs under
        units/vehicles; craters + scorches written into the cache for good.
      · [ ] Editor: the cache re-bakes EVERYTHING on any paint/height change
        (fine for a game, too slow to paint with) — invalidate by region
        before turning it on in the editor.

- [ ] **PARKED until Sky Pro has its night** (you, in another session): the
      searchlight at night (read Sky Pro's night amount, judge it lit), lit
      windows / lanterns / the mirador lamp — see "DUSK/NIGHT IS BLACK".
- [x] **A BETTER MINIMAP** (you, 2026-10-01: "reads small; a rotated square
      inside a square doesn't look nice"; then "the camera must read as in the
      game — a rotated map shouldn't sit in a non-rotated parent").
      · SHAPED LIKE THE PLAY AREA: turned with the start camera (the view
        outline upright, as on screen), the canvas CLIPPED to the play area
        (CSS clip-path), its own border (SVG) round it, no square panel; a
        drop shadow follows the shape. (A 90°-snapped square was tried first:
        it filled the box but the view outline read crooked — you rejected it.)
      · Bigger: 172 → 236 px block. Villages drawn as TERRITORY (the capture
        ring tinted in the holder's colour, the capture arc on its rim, a big
        marker, the NAME); the post and the cave marked and named; the
        fields as a patchwork; a north arrow; unit dots larger. Names drawn
        last (on top of units) and slid inside the shape.
   - [ ] you, look: size (236 — bigger?), the territory tint strength.
- [x] **A REAL ENEMY + A GAME THAT EXPLAINS ITSELF** (2026-10-01; you: "way
      too easy, almost no enemies … something should be written to explain").
      · DIFFICULTY (algDifficulty.js; chosen on the briefing, remembered,
        ?difficulty=): the ALN purse / income / fighter price, the AI's pace
        (firstBandAt, bandEvery, maxLive — algAI params + restartClock), a
        head start of fighters at the cave's rally, the French purse.
        Normal: ALN 480 + 45/min, 30 a fighter, 8 out at the start, bands
        every 50-85 s, up to 26 out (was 240 + 15/min, 40, 0, 80-140 s, 18).
        MEASURED on Normal: 2 bands out by 1:36, 20 FLN on the map at 2:00,
        the ksar taken at 2:22 (the old game: 9 FLN at 4:30, first village
        at 5:17). Easy / Hard either side.
      · OBJECTIVES (top left, always on): hold more villages (bleeding in
        red), "Take <nearest village not yours>" (FLN men inside counted),
        destroy the cave (its %), keep the post — each clickable.
      · ADVICE (brass tips in the alert feed, each once, 14 s apart): how to
        move men, the capture ring, holding a village, cover (V) under fire,
        bleeding, train a sapper, how an FLN band fights.
      · VILLAGE TOOLTIP (hover a marker): who it backs and how far, its
        income, men of each side in its ring, how to win it.
   - [x] **3 — the AI, round 1 (2026-10-01, algAI.js; mine now)** — TESTED
         on Hard:
         · GARRISON: a village turns → the band leaves a cell of 2-3 men in
           cover among the houses (cellSpots: the best cover of a ring), the
           rest re-plan; a second band arriving at a held village moves on; a
           band too small to split becomes the cell. The cell holds fire,
           FIGHTS IN PLACE when the French come (tactics: cover, grenades),
           runs only at 70% lost or when the village is lost. Seen: the ksar
           and the dechra each garrisoned (2 and 3 men).
         · SANGAR: the cell raises one at the village's edge facing the post
           (searched 20-60 m out, ±0.9 rad: the ksar's walls blocked every
           spot within 40 m), one per village, paid by the ALN. Seen: built
           in ~25 s.
         · RETAKE: a village the FLN loses is the next band's mission for 5
           min, and the next band comes within 15 s. Seen: a band of 5 for
           the ksar ~20 s after it was lost.
         · AMBUSH SCREEN: a band lying up puts one up in front of itself
           after 3 s (algBuild.place `stay`: the builders don't leave their
           spot). Seen: placed and built in 10 s.
         · WIRE: a band stuck short of its spot with wire within 30 m cuts it
           (state "cut", algWire.cut), then goes on. (Not seen in a test.)
   - [x] **AI round 2a (2026-10-01): the FM GUNNER + the caches.** New unit
         `fmTeam` (algUnitTypes: weapon "mg", 80 hp, 42 m, slower; 70 a man)
         in a new look `alnGunners` (soldierLooks: the section's look, every
         man with the FM 24/29 — checked: 24/24 loadouts). Each standing
         ARMS CACHE arms two (algAI mgRoom: caches × 2 − out − queued); a
         band forming adds one while there's room. TESTED on Hard: the first
         gunner out at 0:41; a 5-man section in the open at 32 m PINNED in
         ~4.5 s; cache destroyed → no more queued, the objective reads "all
         destroyed: no more FLN machine guns". Battle: an alert the first
         time an FLN MG is seen, an advice tip (cover, flank, the caches), a
         "Destroy the FLN arms caches" objective (count, click to go).
   - [x] **HIDDEN CACHES + FOG OF WAR ON (2026-10-01)**:
         · 3 more caches (algLandmarks: in the FLN's half, ≥ 260 m from the
           post, ≥ 70 m from villages, ≥ 28 m off tracks, 110 m apart, the
           scrubbiest of 900 candidates; pads) = 4 → up to 8 FM gunners.
           algStructures adds every showroom `armsCacheN`.
         · FOG OF WAR ON by default (?fow=0 off) with RIDGE SIGHT (shared
           fogOfWar `ridgeLOS` opt-in, nam unchanged): a cell is seen only if
           the ground never rises above the line from the eye (men 2.2 m,
           vehicles 3, buildings 0.9 × their height up to 14, aircraft 40) to
           a man's head. Height grid at the fog's resolution, built once.
           MEASURED: a man on broken ground saw 60% of his 40 m disk, 90-99%
           on open ground. Bake throttled (`bakeHz` 15): fog CPU 1.2 → 0.31
           ms a frame.
         · Objective "Find and destroy the FLN arms caches": how many are
           LEFT is known, WHERE only once seen (click goes to a found one);
           an alert when one comes into sight. Minimap: the shroud at half
           strength (the land readable), villages always shown.
   - [x] **NEW ARMS CACHES (2026-10-02, algAI stepCaches)**: while the FLN has
         fewer caches than it started with (min 2), every 45 s (first at
         2:00) a village it HOLDS with a cell hides a new one among the
         houses (the most concealed spot that takes it; algBuild armsCache,
         120 ALN supplies, 40 s, the cell builds it). Hidden from the French
         until SEEN (site and cache; late-built enemy structures need real
         sight, not "explored" — algStructures builtLate). Tested (x5): a
         cache destroyed → a new one at Ksar el Hamra, built, unseen, 4 again.
         Holding villages back is how the caches stop coming back.
   - [x] **THE MULE TRAIN (2026-10-01, algAI convoy)**: every 200-280 s
         (first at 2:30) 3 porters enter at the play box's edge on the FLN's
         side (a point with a ROUTE to the cache: the corner was a cliff) and
         walk to the cache furthest from the post at the DONKEYS' pace
         (~0.85 m/s: a convoy takes minutes — time to intercept), holding
         fire; French within 35 m: they stop and fight. Three loaded donkeys
         follow (algHerds `convoy`: a reserved train in the loaded-train
         herd, no new draw; `place` moves them to the start; shared
         wildHerd `anyGround`: a led animal goes where its men go — the
         trail rule stopped the last one on steep ground). ARRIVES: ALN +150
         and that cache arms one more gunner (extraMG). ESCORT KILLED: the
         load is lost. TESTED: arrived (+150, alert); escort killed → "Mule
         train destroyed: its arms are lost". Alerts when seen / destroyed /
         arrived-if-seen; an advice tip.
   - [ ] The convoy's donkeys are NOT fogged (herd animals ignore the fog of
         war): a mule train shows under the shroud. Fog the herds (per-animal
         hide), or accept it as a "spotted by shepherds" hint (you, taste).
   - [x] **REFUGES + LOOKOUTS (2026-10-01)**: new kit pieces (rtsAlgeria
         buildRefuge — an earth-and-brush mound, stone-cheeked mouth, 2.1k
         tris; buildLookout — a stone ring on a crest under a brush shade,
         1.1k; both pass the z-fight tests). Placed by algLandmarks: 2
         refuges in the FLN's half (in scrub, off tracks), 3 lookouts on
         crests (5 m+ over the land 50 m round); trees cleared off them.
         · REFUGE: bands go to ground at the NEAREST refuge, not the far cave
           (homeFor; tested: from the ksar → north refuge, the hamlet → east
           refuge, near the camp → the cave). Men gone to ground (3+) come
           back out FREE as the next band, at the refuge nearest the front.
         · LOOKOUT + WHAT THE FLN KNOWS: the AI only targets French its men
           (50 m), its villages (90 m) or its lookouts (110 m) can see
           (knownFrench; it knew every unit before). A lookout that starts
           seeing French hurries the next band (≤ 12 s). Tested: 0 known →
           4 known when a squad walked into a lookout's view; signal fired.
           Knowing nobody, a band works a village or lies in wait by a piste
           150-380 m from the post (it used to sit at the rally).
         · Alerts when one is found (what it does, why destroy it).
   - [ ] you, look: the refuge and lookout pieces up close; whether the FLN
         now feels too blind / too sharp (seeMen 50, seeLookout 110,
         seeVillage 90 in algAI P).
- [x] **FRENCH TIERS (2026-10-01, algTiers.js)** — you: "motor pool →
      helipad → armour". Tier 1 (start): appelés, sapeurs, jeep, GMC. Tier 2
      "Moyens héliportés" (150, hold 1 village): paras + Alouette (the
      helipad), the half-track. Tier 3 "Blindés" (250, hold 2 villages):
      EBR, AMX-13, the Légion. Bought from the POST's card (a brass ▲
      button: greyed with the reason while villages are short; live when
      only the price is missing); locked units show greyed on their
      building's card with the tier that opens them, and can't be queued.
      The card re-renders when its options change (a village taken). An
      alert on unlock, an advice tip when the next tier becomes buyable.
      TESTED: 0 villages → locked "hold 1 village (you hold 0)"; 1 village
      → live; bought → helipad opens (Para 110, Alouette 320), next shows
      "hold 2 villages"; motor pool: half-track T2, EBR / AMX T3, a locked
      click queues nothing. The other two asks were STALE: health bars on
      the post and motor pool and vehicles out of the motor pool's doors
      already worked (checked in the game).
   - [ ] The STARTING army still has an AMX-13, an EBR, a half-track and the
         Alouette (the showroom's park). Suggested (CoH: you start with an HQ
         and a few squads; vehicles come from tiers): START LEANER — 2
         appelé sections, a sapeur, a jeep; the armour and the Alouette
         parked as SCENERY (unselectable, "in maintenance") or removed. Your
         call.
- [ ] **WEAPON FIRE THAT LOOKS LIKE COMPANY OF HEROES** (you, 2026-10-01: "it
      looks like a futuristic laser, not realistic bullets"). Research CoH's
      look first (articles / breakdowns), then: no continuous beams — short,
      thin, fast tracers only on SOME rounds (MGs every ~4th, rifles rarely),
      bright-headed and fading; muzzle flash a 1-2 frame star + a puff of
      smoke at the barrel; dust kicks / sparks where rounds land (miss
      feedback); a faint smoke trail on tank shells; sound-synced. Today's
      tracers: games/shared-rts/tracerField.js.
   - [x] **Round 1 (2026-10-01)**. RESEARCH (agent, sources in its report):
         CoH3 data — `fx_tracer_speed` 100 for rifles and MGs (~1/8 of real:
         readable), every small arm has its own faint trail, cannons /
         mortars have NO tracer (a visible munition); misses throw randomised
         ground puffs; Relic explosions = directional dirt/debris JETS that
         fall and kick secondary dust, staged, dust over fire; real belts
         1 tracer in 4-5; a Men of War mod fixed "blasters" with smaller,
         dimmer, less saturated streaks. DONE (alg only — opt-ins, nam as
         it was): projectiles.js `weapons` (tracerEvery, dim, dark, jitter,
         dirt) + `tracerColours`; algCombat ALG_FIRE: rifle 1 tracer in 6
         (1.6 × 0.09 m, dim 0.45, 6 m dark from the muzzle), MG 1 in 4
         (2.5 × 0.12 m, dim 0.6), both 100 m/s; one desaturated red-orange
         for both sides (no Soviet green: the ALN used French / German
         arms). combatFx style "coh": a 45 ms muzzle flash + a faint grey
         wisp; explosions = a short flash, a smaller fireball, a FAN of dirt
         clods under gravity (spriteField `gravity`, opt-in), a dust column
         staged after it and a ring of secondary puffs where the clods land;
         grenades the same, smaller. SEEN: a firefight with no laser lines
         (a faint streak now and then, gun smoke, dust kicks); an explosion
         with the clods arcing out of the blast. Tuned after the first look:
         gun smoke halved (grey blobs round every rifleman), clods bigger and
         soft (0.55 m: invisible; hard quads: black squares), dust delayed
         so the fireball shows.
   - [ ] **you, look in motion** (stills can't judge it): tracer
         frequency and brightness, the clods (size, colour), the dust
         column's grey (the flipbook's own tint — a sandier dust wants a
         tinted book), the fireball size.
   - [x] **Round 2 (2026-10-01)**: SPARKS — a bullet off a vehicle throws 5
         white-hot specks (additive, gravity, ~0.35 s); off a wall, 3 stone
         chips + a small grey kick (combat.js calls the game's
         `fx.bulletHit` when it has one; nam keeps its flare). SHELL TRAIL —
         a tank shell leaves 6 smoke puffs along its flight as it passes
         (projectiles `trail` events, only when the game's fx has `trail`).
         DUST RING — a tank gun firing raises 5 low dust puffs round it.
         BLOOD PUFF on hits: already there (alg's bloodField sprays from the
         wound — seen in the earlier fight). MEASURED: the whole combat FX
         update 0.002 ms a frame idle, 0.033 ms in a heavy burst (40 bullet
         hits + a trail + a tank shot + an explosion); the new fields draw
         nothing when empty (visible = count > 0) — +2 draws only while
         sparks / trails are alive. Seen: the tank's dust ring and trail;
         the sparks spawn and draw (too short-lived for a screenshot).
- [ ] **FIRE, SMOKE AND EXPLOSIONS, CoH style** (you, 2026-10-01: the
      explosion flipbook "looks not so good for this game"): research CoH's
      explosions (a fast bright flash, a dirt column / clods thrown up, a
      dark lingering smoke, debris), then replace the flipbook (combatFx /
      explosionField) — dust-coloured for this desert, black for vehicles
      burning, grey-white for buildings; fires that burn and smoke for a
      while. Measure the cost.
   - [x] **Step 1 (2026-10-02): LIT SMOKE** — your "honestly, better than
         the flipbook?": better FLIPBOOKS (CoH does the same), lit by our
         sun. tools/bakeSixWaySmoke.mjs bakes a procedural billowing dust
         puff (8x8 frames of 192 px, ~7 s, PIL → webp, 500 KB) lit from the
         six axes + motion vectors; shared litSmoke.js mixes them by the
         real sun (app.light) and sky (Sky Pro has no hemi light: a pale
         blue a tenth of the sun), slides frames along the motion. One
         instanced draw (ring buffer 384), rows written once. Every puff in
         combatFx goes through it (blast columns, deaths, dirt kicks, tank
         dust ring, muzzle smoke, shell trails); ?litsmoke=0 / the lab's
         checkbox = the old book, live. MEASURED (lab, frozen scenes,
         interleaved x3): 5 puffs = noise; 40 big puffs over half the
         screen +0.18 ms vs the old book.
      · FIXED on the way (you: "the fields go on top of the smoke"): every
        effect in the air drew BEFORE the ground layers (fields 40, tyre
        marks 41, craters + pools 42, cover overlay 44) — smoke 12, sprites
        0. Now sprites + blood drops 49, smoke 50, flames 51, tracers 52
        (shared: nam had the same bug). And each smoke card's border showed
        as a pale line through a cloud (mips + motion slide): faded out.
      - [ ] you, look in the lab (Smoke test, Lit smoke on/off, Sun/Sky
            sliders): the dust colour, brightness, softness (the old book
            had crisper curls; the bake can sharpen).
   - [x] **Step 2 (2026-10-02): EXPLOSIONS FROM MANY PIECES** (combatFx
         litBlast, lit smoke on): the flash and the clods as before, then
         — all lit puffs, ONE draw — a fireball of 4-8 small HOT puffs
         (litSmoke `heat`: fire in the thick core, edges cooling to dark
         red, then soot), a dirt jet thrown up in a cone, an 11-puff skirt
         along the ground, a column of two big puffs that climbs and DRIFTS
         WITH THE MAP'S WIND (algWind, 8-15 s). Shells in the desert: fire
         0.6; vehicles (size ≥ 12): 1; grenades: a small one (0.35); a
         shell on a hull: fire + smoke, no earth. Spawned in DRAW ORDER
         (column, skirt, jet, fire last: the skirt hid the fire). Flashes,
         impacts and sparks now draw OVER the smoke (53). Cards fade into
         the ground (one heightmap tap, as the flames: a hard line where a
         card cut the terrain). Seen at 0.1 / 0.4 / 1.5 / 5 s. MEASURED
         (lab, frozen at its heaviest, 1.5 s, close zoom, x3): +0.14 ms vs
         nothing (the old one +0.03), for a few seconds per blast.
      - [ ] you, look in motion (lab: Big blast / Mortar on a squad, ×¼):
            the fire's colour and life, the skirt, the column's drift.
   - [ ] Step 3: fire extras — embers, a black (soot) smoke column from
         wrecks (SMOKE_TINTS.soot), a ground glow.
   - [ ] **MORE VFX vs CoH** (proposed 2026-10-02, you asked; PAUSED for a
         play + UI, then back here). Rough order of what reads most:
         1. Bullet strikes on sand: small directional spurts (lit puffs
            thrown away from the shooter), not round puffs.
         2. Shells on BUILDINGS: plaster/stone dust bursting off the wall,
            chunks falling, a dust curtain sliding down the face.
         3. Tank gun: a forward muzzle-blast cone + side puffs from the
            brake; the AMX-13 rocking back already.
         4. Smoke screens: the mortar's / a grenade's white smoke that
            BLOCKS sight (nam has the LOS rule: shared smoke columns).
         5. Craters: a burnt ring and scattered debris stones round them.
         6. Ricochets: a tracer bouncing off stone or a hull into the sky.
         7. Alouette downwash: a dust ring on landing / low hover.
         8. Vehicle exhaust puffs on pulling away (lit grey).
         9. Dust devils on the plain (ambience; the wind).
        10. Heat haze over fires (a screen distortion: costs a copy —
            measure first, maybe only near the camera).
- [x] **PLOUGHED FIELDS LOOK FLAT** (you, 2026-10-02: "too flat, not
      realistic enough; CoH looks way better — without hurting perf"). Done
      the same day, still ONE draw (algFields buildSurface):
      · RELIEF: the furrows bend the normal (narrow crests, wide grooves:
        h = c^2.5 and its exact slope; uneven ridge heights), on the
        TERRAIN'S normal (4 heightmap taps a vertex — it was lit as if flat
        whatever the slope), plus clod tilt from two noise octaves.
      · SOIL: darker, moist grooves, dry pale crests, crumbs, wet/dry patches.
      · HEADLAND: a 2-3 m trampled band round the edge where the rows stop.
      · STUBBLE: broken straw along the rows, dry soil between, stalks.
        BARLEY: plants on the rows with gaps, soil showing.
      MEASURED (lab, a field filling much of a close view, on/off x3): all
      the fields together +0.09 ms.
   - [x] **THE GROUND'S REPEATING PATTERN (2026-10-02, you: crops of a
         fine diagonal repeat by the oasis village)**. Two things:
         · Paint layer 3 "Oasis grove" was forrest_ground_01 (a ~2 m forest
           floor close-up, twigs, stretched to 7 m and repeated): now Poly
           Haven rocky_terrain_02 (a 90 m AERIAL photo), 64 m tile, tint
           #ffe0b4 (tools/algOasisGround.mjs patches the .v3proj; backup in
           the session scratchpad).
         · THE PATTERN ITSELF was the ground cache's DETAIL pass (algGame
           detail 1): it re-reads the paint photo at its plain repeat over a
           cache baked HEX-tiled, so they never line up — a regular diagonal
           hatch over all the ground. A/B there: on = the hatch, off = gone.
           Now detail 0 (?detail=1 to compare). A detail pass that follows
           the hex bake would get the grain back without the hatch: later,
           if the ground ever reads soft.
         - [ ] **NOT FIXED FOR YOU** (you, same day: "it makes no difference
               for me, I still see that pattern where my other textures
               don't"). Parked for later. Next suspects, in order: the
               hex bake's own cell grid on this layer (A/B ?gchex=0 at the
               spot), the paint splat blend between Oasis grove and Valley
               soil (heightBlend 0.55 can print the photos' own grain as a
               pattern), the ground splats laid there (algSplats), the
               far-grass bake (?fargrass=0). Ask for the exact spot and the
               zoom; A/B each from YOUR view.
   - [x] **PHOTOGRAPHED, round 2 (same day)** — you: "still not convinced,
         not realistic next to the image textures — find a texture". The
         procedural soil is gone: Poly Haven CC0 photo sets
         (tools/fetchFieldMaterials.mjs → public/textures/fields/, one 2x2
         atlas: colour + normal/height, 3.2 MB): farm_furrows (ploughed;
         the photo is a PATCH — cropped to its even middle and groove to
         groove, tiled mirrored both ways: no seam), raked_dirt (stubble,
         tinted straw, in windrows), sparse_grass (barley, in rows),
         farm_soil (headland, soil between rows). 4 taps a pixel, the mip
         chosen in the shader and the cell inset (no atlas bleeding), the
         photo's normals on the terrain's. Same cost as before (on/off x3:
         within noise). ambientCG checked too (its API works, CC0): good
         bare grounds (Ground104 "crumbly"…), nothing for stubble or crops.
   - [ ] you, look at play zoom and close: the soil colour, the tints, the
         furrow scale (TILE_M), the stubble's bands, the barley's green.
- [ ] **THE GROUND PASS — CoH-detailed terrain (2026-10-02, you: "any RTS I
      see has very detailed textures")**. Research (agent): CoH = a few base
      tiles + hundreds of low-opacity splats + texture SPLINES for roads; SupCom
      861 decals from 21; BAR / SupCom a macro colour layer over tiling detail;
      grass mostly painted texture. Built so far (NOT baked into the map yet —
      the GROUND LAB, ground-lab.html, holds it; ◀ Before / After ▶, key B):
      · tools/fetchGroundSets.mjs: 12 more Poly Haven CC0 sets (4 AERIAL,
        20-25 m a photo) + sets.json for the lab (27 sets).
      · MACRO PHOTO (splatOverlayTsl, engine, opt-in): an aerial photo's
        luminance ratio at tens of metres a tile, two rotated scales, read
        with texel LOADS (no sampler: the shader is at its limit), baked in
        the ground cache = free per frame. Proposal: dirt_aerial_02, 0.7, 45 m.
      · RELIEF: normal 2.5 on valley soil / scree / track (was 1).
      · WHEEL RUTS, PROCEDURAL: groundCache RUT STRIPS (warp < 0) chained
        down every piste (119); the shader draws two grooves (sometimes a
        second vehicle's pair) that wander, narrow, fade and come back, along
        the road's arc length (continuous strip to strip), in smoothed pale
        packed dust with soft walls + berms. Only the ruts draw. An image
        version (tread texture) was tried and dropped: straight, read as
        rails. Lab sliders: rut width, wander, opacity, relief. ?ruts=0 = off.
        (The thin straight black lines over the piste are the TELEGRAPH WIRES.)
      PLANT PASS (2026-10-02, PLANT LAB: games/alg-rts/plant-lab.html — a bed
      of each of 12 species beside the post, close + play views):
      · STRIPES on the prickly pear = foliage self-shadow at the fitted
        shadow's ~17 cm texel. foliageSystem: receivedShadowPositionNode
        looks the shadow up 3 m toward the sun (0.8 / 1.8 m still hatched):
        a plant skips its OWN shadow, walls / trees / units still shade it.
      · PRICKLY PEAR: pads drawn by the shader (areole lattice, pale rim, old
        pads darker and bigger at the foot, the odd dried one, true rounded
        light); fewer, smaller fruit at mixed RIPENESS (green → orange →
        magenta). Was: flat green paddles, big orange eggs everywhere.
      · THISTLE: rosette of long toothed folded leaves, 2-4 branching stalks
        with clasping leaves, green spiny bract globes + a purple floret
        brush, some still buds. Was: a white cup + pink ball on a stick.
      · ASPHODEL: dense strap-leaf tuft, candelabra stalk, white six-petal
        stars, green capsules below, brown buds above. Was: white blobs.
      · Mid/far detail kept at the old triangle budget (thistle 421/141,
        asphodel 484/140 vs 456/168, 470/178). Map colours: node
        tools/algPlantLook.mjs (copies FOLIAGE_PRESETS looks into the map).
      GRASS DENSITY (revo-realms re-read 2026-10-02; the map runs revo
      "openWorld" ultra: 590k blades / 140 m tile = 30 per m², fade 44→68 m,
      faceCamera 1). His: 1.28M / 130 m = 76 per m², and the look comes from
      (1) far blades 1→4× WIDER (6% of the blades keep 25% coverage),
      (2) 8-blade TUFTS + a dome normal per tuft (ours: jittered grid, normal
      tilted toward up = flat), (3) the terrain under the grass shaded with
      the blade lighting at full weight (gaps read as grass), (4) a 5-colour
      palette per clump, (5) 3 LODs (11/7/3 tris; ours 7 everywhere), (6) a
      per-clump compute cache (ours ~7 texture reads per blade per frame).
      Cards with alpha instead of blades = NO: alpha test loses early-z and
      overdraws (our cedar lesson); solid strips facing the camera are right.
      Also: wind streaks (12 compute ribbons), grass-only wind particles.
      PLANT AUDIT ROUND 1 (2026-10-03, gpuBench interleaved, scale 2):
      · painted Foliage ≈ 0 ms, Tall plants ≈ 0, RevoGrass 0-0.4 ms,
        vegetation shadows 0.1-0.75 ms (noisy).
      · PLACED plants were the cost: 0.8-1.0 ms — all 1,467 hedge prickly
        pears + 72 brooms + the rest drawn AND cast every frame, map-wide
        (PlacedFoliage had no culling). FIXED: view-frustum culling per plant
        (sphere + 14 m shadow margin, re-binned on 2 m / a turn). Now:
        close 16 plants ≈ 0 ms, default 74 plants 0.26 ms, max zoom 288
        plants 0.5-0.7 (≈ 0.2-0.3 of it their shadows).
      · open: heavy NEAR levels (betoum 15.9k, tamarisk 15.1k, broom 6.8k,
        oleander 6.4k, prickly pear 5.7k, asphodel 5.5k) — only drawn within
        ~60-70 m, measured cheap today; revisit if a map packs them.
      · open: small plants casting (alfa/thistle/asphodel) → baked ground patch?
      PLANT AUDIT — when every Plant Lab bed is done (you, 2026-10-02: "see
      if we can optimize, merge, or anything so it's as optimized as
      possible"): triangles per LOD × how often each plant is drawn; types
      sharing a material merged into fewer draws; self-shadow for the small
      plants (real vs a baked ground patch); LOD switch distances; the
      alpha-cut cards' cost (tamarisk, oleander, palms); one in-game GPU
      A/B before and after (ask for focus).
      PLANT PASS 2 (2026-10-02, the LIGHT Plant Lab — plant-lab.html: no map,
      the game's sun / shadow / exposure, loads in ~2.5 s):
      · shared shader: baked per-vertex SELF-OCCLUSION (in the normal's
        length, aoNode too), dry↔lush MACRO tint per plant, waxy sheen;
        DOME cards (parts 2.4 / 5.25 / 5.35 behind FOLIAGE_DOME_CARDS) keep
        their rounded normal — the "turn to the viewer" flip made the light
        follow the camera (kept for nam-rts's dipterocarps too, you chose).
      · WIND: placed plants bow DOWNWIND with gusts rolling across the
        ground (was a per-plant wobble); leaf flutter a sideways swish.
      · done: prickly pear (round pads, bloom, cork trunk), alfa (60 wiry
        blades, 30% straw), thistle (marbled leaves), asphodel, agave
        (blue-grey, spine tips), agave mast v2 (candelabrum; the big
        "cushion" tufts were tried and rejected), broom (forking round
        rods), oleander (own builder: vase of stems, whorls of 3, blossom
        clusters), tamariskShrub (NEW weeping one — not in the game yet;
        the old fuller "tamarisk" tree kept).
      · costs: alfa A/B in game = noise (≤0.2 ms); oleander mid 1.7k tris
        (was 0.9k) — measure in game when focused.
      [x] BUG (2026-10-02, you): small FLASHING blue / orange / purple
      lights — the BLOOM (gone with bloom off). Read off the GPU: the scene
      colour holds lone FIREFLY pixels (60-16 000× white, a frame each, at
      steady screen spots — even with every scene object hidden, so not a
      plant / unit / building); × any sliver of glow mask, the 1/8-res blur
      spread them into flashing coloured blobs. FIX (postFxPipeline mask
      mode): the bloom takes at most 8× white from a pixel (firefly clamp),
      and the mask ignores weak emissive (saturate((m − 0.5)/0.7), plants'
      leaf light no longer glows). You: no flashes with bloom on. FX glows
      (flash, explosion, flame, tracer, sprites) write their own mask.
      [ ] the firefly pixels' SOURCE is still unknown (they're harmless now:
          clipped on screen, clamped in the bloom).
      PLANT PASS 3 (2026-10-02): reed-mace (18 strap leaves taller than the
      stalks, chocolate heads); asphodel rebuilt from the plant (keeled leaves,
      curved stems, six-tepal flowers with the brown midrib); TAMARISK = the
      grown weeping tree (buildTamariskTree; old weeping shrub removed);
      BETOUM (Atlas pistachio, betoumGeometry.js) — NEW big tree, a grown
      skeleton meshed as one continuous parallel-transport tube per branch,
      children buried in their parent with a collar, root flare, shader bark
      (part 3.4), leaf CLUSTER cards from tools/makeBetoumLeaves.py (CC0 leaf
      photos → public/textures/leaves/betoum_clusters.png), crown-proxy
      normals. 15.8k / 3.3k / 0.5k tris.
      KEEP (you): the OLD big tree ("tamarisk" key, the map's slot) stays as
      it is — the betoum is an extra tree, not a replacement. Juniper scrub
      and doum palm: keep as they are unless a NEW, better model is built
      beside them (never edit them in place).
      Next plants: juniper / doum palm (new models beside them), where the
      betoum and tamarisk go on the map; tamarisk TREE look
      (own builder, feathery needle cards, clump colour); agave mast still
      "cheap" (you: which part?); where the tamarisk shrub goes; then the
      PLANT AUDIT above.
      Next: you judge in the lab → bake (map + algSplats); worn ground round
      the post / villages; more splats; grass as texture. Only dirt_aerial_02
      is committed; the other lab sets: node tools/fetchGroundSets.mjs.
- [x] **AN ENEMY THAT FIGHTS (2026-10-02, algAI; you: "the enemies don't
      even try to fire at me")**. Bands held fire walking, occupying, mining,
      running home, and broke off after 12-22 s. Now:
      · FIRED ON (hit, suppressed or shot at), any band fires back — on its
        way, in a village, laying a mine, cutting wire, in ambush.
      · Strikes 18-30 s and go on (+8 s at a time, up to 50) while not losing.
      · Running home, pressed by men within 35 m: one REARGUARD (6-10 s).
      · DEFENCE: French within 90 m of a village it holds → a band out
        within 450 m is diverted (else the next one within 8 s); it fights
        from the houses and moves on only 25 s after the French go.
      · ASSAULTS: from 5:30, every 220-320 s, 8-11 men (two FMs while the
        caches allow) against a French-held village (fewest guards), else an
        outpost, else troops, else the post's outskirts: staged in cover,
        then in, firing, with an alert. Breaks at 55% lost; a village taken
        gets a cell.
      Tested: a village band fired on at 45 m → 8/8 firing; an assault went
      in firing; French near Ksar el Hamra → a 7-man band diverted to defend.
   - [ ] you, play it: too hard now? (assault pace, size, strike length.)
- [x] **CHEAP BLOOM (2026-10-02)**: on by default in alg. Stock selective
      bloom MEASURED 6.6-8.9 ms (scale 2): most of it was the 4th MSAA
      attachment (emissive) written per sample, the blur ~1 ms. Now THRESHOLD
      mode (1.6: only HDR light — flashes, fireballs, sparks, tracers; the
      white post and the sky stay under it) and the blur chain from an EIGHTH
      of the frame (new postFxPipeline bloom `resolution`, default 0.5 = stock,
      nam unchanged). MEASURED interleaved (scale 2, play zoom): 0.42-0.47 ms.
      ?bloom=0 = off.
   - [x] ROUND 2 (same day; you: "everything white blooms — the flags, the
         sheep, the hens"): threshold mode was wrong (in this sun a white
         sheep is as bright as a flash). Back to SELECTIVE, with a 1-byte
         glow MASK attachment (postFxPipeline bloom `mask`: R8, the bloom =
         scene colour × mask) instead of the RGBA16F colour. Seen: the
         fireball glows; the flag, the white post, the sand do not.
         MEASURED (scale 2, interleaved x6): 1.6-1.8 ms (≈0.5 at the normal
         scale) vs 6.6-8.9 stock.
   - [ ] you, look in a fight: the strength (1.2).
- [x] **CLICKING A UNIT SOMETIMES MISSED (2026-10-02, you; vehicles most)**:
      · VEHICLES: three computes an InstancedMesh's bounding sphere ONCE (the
        first raycast) and tests every ray against it first — a vehicle that
        had driven out of its type's old sphere could not be clicked. Now
        dropped every frame, rebuilt only by a click (unitRenderer). Plus a
        screen-space backup: a click within a vehicle's outline picks it
        (selection.js).
      · SOLDIERS: picked against one point 1 m up within 22 px — zoomed in, a
        click on the chest or head missed. Now the feet→head segment, the
        reach growing with his size on screen; box-select tests his middle.
      Tested with real clicks after the jeep drove 80 m: jeep 9/9, two
      appelés 18/18 (3 zooms × feet, chest, head).
- [x] **3x FRENCH INCOME (2026-10-02, you: "it takes long to build")**:
      Algiers 40 → 120/min, villages 25/40/50 → 40/60/80, start 400 → 600
      (Easy 750, Hard 500). An appelé every 30 s with nothing held. Later
      (proposed): a second resource (fuel / ammunition from villages and
      convoys) for vehicles, tiers, grenades — CoH-style.
   - [ ] Next post-FX from the list: a colour-grade LUT + vignette (near
         free), then GTAO (measure, keep only under ~1.5 ms).
- [ ] **SOLDIERS' VOICES + RADIO CALLS, French and Arabic** (you,
      2026-10-02, first minutes of a match: "the soldiers' communication is
      missing, the enemies' too; radio calls in French and Arabic"). Today:
      a radio squelch on orders, no voices. Plan: ~150-250 short lines
      generated ONCE with neural TTS (ElevenLabs: acted, shouted, FR + AR;
      or Azure neural: fr-FR + ar-DZ, Algerian Arabic voices), a few
      voices per side, baked to small files (~2 MB); the RADIO sound made
      live in Web Audio (band-pass + crackle) over the same lines.
      · French barks: acknowledge, move, attack, under fire, pinned,
        grenade, man down, retreat, sapper at work, vehicle crews.
      · Radio (HQ, CoH-style): village taken / lost, reinforcements, cache
        found, "contact" with a direction.
      · ALN barks in Algerian Arabic (Darija), Chaoui/French words mixed as
        in the Aurès — heard when near them (positional), your eyes on them.
        Lines to be checked by a native speaker.
      DECIDE: which TTS (an account / key is needed). → ElevenLabs (you).
   - [x] BUILT (2026-10-02), waiting for the key to generate:
         · tools/algVoiceLines.mjs: the script — 11 French bark lines (39
           texts), 15 HQ radio lines (24), 7 ALN lines in Darija (18, the
           English beside each; to check by a native speaker).
         · tools/genVoices.mjs: ElevenLabs multilingual v2, 3 French
           voices, 1 HQ, 3 ALN (premade ids, `--list` to swap), shouted
           settings; resumable; writes public/sounds/alg/voices/ +
           manifest. ~6k characters (the free tier covers it).
         · games/alg-rts/algVoices.js: barks from the man who speaks
           (panned, by distance; ALN only when seen and near), one voice per
           man, one speaker per side at a time, a cooldown per line; triggers
           on order, selection, contact, suppressed / pinned, grenade, man
           down, sapper at work. HQ through a live radio filter after the
           squelch, on algBattle's alerts and the tier unlock. Inert until
           the files exist. ?voices=0 = off.
   - [ ] **PARKED (2026-10-02)**: on the FREE plan the API refuses the
         native French / Algerian library voices ("paid plan", some "Creator
         tier"); the free default voices (multilingual v2, then the
         expressive v3 with [shouting] tags) were tested and judged "not
         convincing at all — flat, wrong intonation" (you). The system stays
         in, silent (no manifest = inert). Ways back: a Creator plan (native
         voices: Théo / Hugo / Christophe, Algerian Amin / Ben Chamsou /
         Ilyass — ids in tools/genVoices.mjs), or RECORD the lines (you /
         friends; any mp3 named as the manifest expects). French script
         fixed once ("On est bloqués !"); you check the rest.
- [ ] **LATER — MEN OF WAR CAMERA + FOG OF WAR WITHOUT THE SHROUD** (you,
      2026-10-02: "with these fogs do I still need fog of war? Men of War
      lets you pivot the camera"). Atmospheric fog is the LOOK; fog of war
      is the RULE (what your men can see) — the ALN's ambushes, hidden
      caches and refuges need the rule. Keep it, drop the dark overlay:
      enemies unseen by your men are simply not drawn (the renderer already
      does this), terrain fully lit, the weather fog for depth. Then a
      freer camera (pivot down toward the horizon, as MoW): the shroud is
      what looks wrong at low angles. Costs to plan: far views draw more
      (vegetation LOD, far terrain, the frame budget), picking at grazing
      angles, a "last seen" ghost marker for enemies that drop out of sight.
- [x] **HUD round 1 (2026-10-02, you: "the bottom UI could be better")**:
      · the selection + command card FOLD AWAY when nothing is selected
        (hudBar setCollapsed): only the supply strip stays.
      · ARMY TABS (ui/armyTabs.js), the CoH squad tabs, down the right edge:
        each vehicle a tab; men of one type standing together (15 m links)
        one tab, split when they split. Portrait, count, health together,
        state (PIN / SUP / FEU / » / ABRI), a red pulsing edge under fire,
        brass when selected. Click: select (shift: add); double-click: the
        camera there. Regrouped 4×/s, DOM only on change. Seen: Appelés ×12,
        Sapeur, Willys; a click selected the 12 and opened the card.
   - [x] **HUD round 2 (same day; you: "change it completely if you want")**:
         · COMMAND CARD rebuilt (ui/commandCard.js): a fixed 4-wide grid of
           ICON squares (game-icons.net, CC BY 3.0, public/textures/ui/icons/
           + CREDITS.md, drawn as CSS masks in brass), hotkey in the corner
           (mnemonic, clear of the camera keys: H halt, F camera, P patrol,
           G grenade, X cut wire, Del cancel), price, a cooldown sweep,
           locked = grey + lock; a real tooltip above the panel (name, price,
           what it does, why locked, key). Buildings: the queue as portraits
           (the first with its bar), training buttons as portraits.
         · SELECTION CARD rebuilt (ui/unitBar.js): portrait, name, ×count, a
           health PIP PER MAN, state chips (PINNED / SUPPRESSED / FIRING /
           MOVING, HARD / LIGHT COVER, CONCEALED), weapon and speed.
         · RESOURCES top right (+ troop count); the bottom strip is gone.
         · QUEUE BADGES over every building training something
           (ui/queueBadges.js): portrait, progress, +n.
         Seen: appelés (12 pips, 4 orders), the post (queue + locked tier).
   - [ ] you, play it: the sizes, the hotkeys, the tooltip; what's missing.
   - [x] **PAINTED PORTRAITS IN (2026-10-02)**: your two ChatGPT sheets
         (soldiers 8x4: rows 1-2 French, 3-4 ALN; vehicles 3x2) packed by
         tools/packPortraits.py (cells FOUND from the gutters) into
         public/textures/ui/portraits_soldiers.webp (240 KB) + _vehicles
         (50 KB); the 4.8 MB PNGs deleted as you asked. ui/portraits.js
         cuts one blob URL per type at load into the shared thumbnail map:
         tabs, selection card, command card, queue badges all show them.
         Faces per type: appelé 8, sapeur 3, para 2 (red berets), légion 2
         (képis), colonel (officer's képi), moudjahid 10, FM 5 (bandoliers),
         Si Tahar (hooded kachabia); faceOf(unit) gives each man his own.
         ?portraits=0 = the 3D ones. Buildings keep their 3D portraits.
   - [ ] Building portraits (the list in chat), and faceOf() per man where
         one man is shown (a single-man selection, the death notices).
   - [ ] **PORTRAITS — keep for later** (you, 2026-10-02): an atlas of 32
         painted portraits (public/textures/alg-atlas.png, 1536×1024, 3 MB:
         rows 1-2 French, 3-4 ALN) for the tabs and the selection card
         instead of the 3D thumbnails. You'll redo it to match the troops
         (red berets, green berets…). Then: crop the cells, ~160×200 each
         into one WebP (~150 KB), a face per type (and per man, varied).
      · THE ALN HERO (you, 2026-10-02: "we need a hero for the ALN too, even
        if not built yet"), the counterpart of Colonel Delorme — FICTIONAL,
        not a real commander: **Commandant Si Tahar**, an ALN katiba leader
        of the Aurès, early 40s, lean and weathered, short greying beard and
        moustache, dark watchful eyes. Khaki battledress (surplus jacket)
        under a long brown KACHABIA (hooded wool cloak: the silhouette that
        reads at RTS zoom), a sand chèche loose round the neck, a captured
        MAT 49 on a sling, binoculars, a map case and a holstered pistol,
        the officer's star on his chest. Role, as the colonel's: an aura
        over the bands near him, 2-3 abilities, comes back if he falls.
- [x] **THE BATTLE LAB (2026-10-02, battle-lab.html + battleLab.js)** (you:
      "everything related to the fight in a lab"). The REAL game booted lean
      (URL defaults ai=0 battle=0 fow=0 herds/hens/birds=0, any game option
      still works) on the flattest open patch ≥140 m from any armed building,
      its plants cleared. Panel: two squads of any ground type (French left,
      ALN right) N each, spacing, sandbag walls in front; Open / Hold fire;
      grenade / mortar 81 / tank shell / big blast on either squad or where
      you click (shift-click: keep dropping); time ×1 ×½ ×¼ ×0.1, pause (P),
      one step (.); camera frame / play zoom / close on each side; tracer
      look live (projectiles.weapons); blood on/off. Game hooks: app.timeScale
      / app.timeStep in algUnits' loop (1 / 0 in the game). Seen: appelés vs
      moudjahidine behind sandbags, an AMX-13 vs a band (gun smoke, shell,
      blood), pause + step exact (1/60 s), Clear leaves no bodies. Console clean.
   - [ ] you, look: is anything missing (a vehicle side, wounded, ranges)?
   - [ ] The ALN's second wall can be refused on a slope (survey): a note.
- [x] **MEN BLOWN APART (CoH 1 style, 2026-10-02)** (you: "separate the
      soldiers into parts — exploded legs, heads"). Built IN THE SKINNING
      PASS (shared crowdSkinning GIB, opt-in: nam unchanged):
      · Each body re-cut at load into 6 parts by every vertex's strongest
        bone (head from the neck, arms from the shoulder joint, legs from
        the hip, the trunk); triangles never span a cut (seam verts doubled).
      · A man a blast kills close by comes apart in his LAST POSE, his own
        look: each part thrown out from the chest, spinning, falling under
        22 m/s², lying where it lands (the feet give the ground). His kit
        goes with its bone's part (helmet with the head, rifle with the arm,
        pack with the trunk) — the CPU twin of the kernel's motion, sharing
        its random table. Blood: three sprays, a pool under the trunk, small
        ones under most limbs (bloodField pool `scale`).
      · ITS OWN SMALL CROWD (40 per body) beside the living one, sharing the
        baked clips: the living keep the uncut body. MEASURED (48 men, A/B
        alternating loads): the cut on every man cost +0.10 ms (6-9% more
        verts) → moved to the gib crowd: 4.48/4.30 off vs 4.29/4.30 on = 0.
        20 men blown apart at once: +0.015 ms GPU. Empty: no dispatch, no
        draw; its pipeline is built at load (one dispatch).
      · Rule (algCombat GIBS): inside 30% of the blast radius, or 40% of
        the time inside half of it — when the blast KILLS him. A mortar (45)
        can't kill a fresh man (60 hp): only the wounded; a grenade (70) can.
        OFF BY DEFAULT (you, 2026-10-02: "not by default for this war, but
        we should be able to enable it"): ?gore=1 boots it on, Dev → Gore and
        the lab switch it live (Off / CoH / every blast kill). ?gibs=0 = the
        old kernel (A/B).
   - [ ] you, look in the lab (×¼, Close): the throw height and spread, the
         cut ends (open: no red cap yet).
- [x] **KNEELING FIRE LOOPED idle ⇄ fire (2026-10-02, you)**: a kneeling man
      in range dropped to the crouch idle (rifle down) after every shot —
      there is no crouch-AIM clip. Now (unitRenderer soldierClip + sync) the
      crouch-fire clip is his aim: a shot plays it from the start, then it
      HOLDS its last frame (CROUCH_AIM_AT 0.98) instead of looping; kneeling
      into aim with no shot yet starts on that frame. Lab, both sides behind
      sandbags, 6 s: 914 of 949 kneeling samples on crouch-fire, the rest the
      drop to the knee. Not touched: prone ⇄ prone-fire (same pattern, if it
      shows).
   - WHY THE FLN "DON'T CROUCH" (you): the same rules for both sides
     (infantryPosture): a man KNEELS when sheltered from his target (cover
     map, terrain too) or suppressed (≥ 0.4). Rifles alone suppress little
     (0.07 a round, −0.3/s: fights sat at 0.1-0.26), so it was cover: in the
     lab the French stood behind a rise of ground facing the FLN and knelt,
     the FLN had nothing in front. Behind sandbags both kneel. MGs pin.
   - [x] RIFLES SUPPRESS (you: "yes, as CoH"): alg perRound.rifle 0.07 →
         0.12, capped at 0.8 by rifles alone (shared POSTURE capByWeapon,
         opt-in): 0.12 uncapped PINNED men flat in the lab. Now, 8 v 8 in the
         open: both sides ~45% kneeling, none prone; FM gunners still pin.
   - [ ] Cut caps: dark-red discs over the open ends (they show inside the
         body at close zoom).
   - [ ] A tank shell hitting a man directly (not a splash) doesn't gib yet.
- [x] **THE HENS in alg (2026-10-01, algHens.js)**: your bird-lab hens
      (birdMorph white / speckled / black, 40/35/25%) — 25 round the village
      houses (a third of them) and 4 in each farmstead's yard, at 1.3×, on
      the shared wildHerd (`clipNames`: the chicken's own idle / walk / run
      clips — an opt-in, the other herds unchanged): peck, potter 4 m round
      their spot, scatter from men and vehicles. 3 draws. Seen in a yard by
      the oven. ?hens=0 off. (A one-off "multiple KTX2 loaders" warning at
      load: birdMorph's own RGBA loader, disposed right after — harmless.)
   - [ ] you, look: the hens' size at play zoom; more of them? the souk.
- [x] (done — see above) THE HENS in alg (you, 2026-10-01): your white / speckled / black
      hens from the bird lab (v3/props/birdMorph.js, commit 8d9fae2) round
      the villages, the farmsteads' yards and the ksar's souk, as the other
      animals (nam already runs chickens: games/nam-rts/chickenFlock.js —
      the shared machinery to reuse; alg's own placement). Scratch-feeding,
      scatter from men and vehicles, at unit scale (1.3×).
   - [ ] A gunner formed after his band is gathered waits at the rally for
         the next band (bands take the first men standing).
   - [x] AI round 2b: the mule train; the refuge (casemate); the lookout (all 2026-10-01).
   - [ ] you, play it: Normal hard enough? (Hard = 700 + 70/min, 12 out.)
- [x] **FLOWERS + SMALL PLANTS, round 1** (2026-10-01; you: "the pink flowers
      are flat quads; still Algeria; the cactus"). Season kept: LATE SUMMER.
      · OLEANDER: real blossoms — 5-petal lobed stars (a fan round a darker
        heart), ~6 a cane in a dome, petals exaggerated so the pink carries
        at play zoom (foliageGeometry buildLeafy `flowers`; were two crossed
        flat quads per flower).
      · PRICKLY PEAR: red-orange FRUIT along the top pads' rims (`fruit`: 2
        a pad; a leaf part flagged rand ≥ 3 takes the type's colorBase —
        foliageSystem, opt-in, nothing else sets it; the "dead leaf" brown
        read pale cream). Map re-generated (algVegetation) for the painted.
      · AGAVE (new kinds `agave` + `agaveMast`, foliageGeometry): blue-grey
        rosette of thick V-section leaves, outer ones arching, a few folded;
        the mast a 6 m candelabrum with drying ochre clumps. PLACED, not
        painted (they're planted by people): a row before each farmstead's
        yard, short rows along the pistes near the villages; 28 agaves, 5
        masts (algLandmarks.js). PlacedFoliage MAX_TYPES 8 → 12 (alg hit 8).
   - [x] **Round 2 (2026-10-01): colour drifts.** New kinds in
         foliageGeometry: THISTLE (spiny-lobed silvery rosette, 3 stalks,
         purple heads in green bract cups), ASPHODEL (blade tuft, branched
         stalk lined with pale drying buds), BROOM (dome of ~110 grey-green
         rods, yellow 6-point flowers on the upper half). Thistle + asphodel
         take the last 2 PAINTED slots (algVegetation: thistles in patches on
         open ground < 16° within ~220 m of a village; asphodel on 5-25°
         grazed hillsides); broom PLACED in 14 clumps on 8-30° slopes (70
         bushes, algLandmarks). Heads, buds and rods EXAGGERATED after the
         first look (pinpricks / wisps at play zoom). Seen: an asphodel
         hillside of pale spikes, a silver-and-purple thistle patch.
         NOT A/B'd: the GPU timer read empty; the overlay showed ~4 ms at
         close views as before.
   - [ ] Low cushions (thyme, lavender, cistus) — the painted slots are
         FULL (8/8): a second painted layer, or placed.
   - [ ] you, look: the thistle purple (subtle at play zoom — more?), the
         asphodel density, the broom size.
   - [ ] you, look: the oleander pink at play zoom, the fruit density, the
         agave colour and size, the mast (thin; taller?).
- [x] **THE LAND BETWEEN THE VILLAGES** (2026-10-01, algLandmarks.js; you:
      wires, farmsteads + ruins, outcrops + lone trees). MEASURED: on vs off
      (outcrops + the 7 pieces) +0.06 ms (noise 0.06); the whole frame at
      full zoom-out 1.70 ms; load: outcrops + trees 22 ms.
      · TELEGRAPH WIRES fixed: thin RIBBONS in a cross (flat + upright),
        drawn fat (4.4 cm), sag 2.6% varying per span, 16 segments; one
        draw, 4096 tris (was 1 px GL lines with a 1.4% sag: ruled lines).
      · FARMSTEADS (rtsAlgVillage buildFarmstead, ~5k tris, one draw each):
        house + byre in an L on socles, walled yard with the oven, thorn pen,
        straw, fig + olives, prickly pear; houses block, the yard is open,
        walls are hard cover; its oven smokes (key "mechtaFarm*").
      · RUINS: buildRomanRuin (podium, standing / broken columns, fallen
        drums, blocks) ×2, buildBurntFarm (roofless soot-blackened stucco,
        charred rafters, a corner of tiles, rubble) ×1. All showroom
        entries (pads, nav, cover, trees come with it), placed by a seeded
        search: 70 m from villages / bases, 25 m from minor sites, a farm
        12-95 m from a track, 115 m apart, ruins placed first. Today: 2
        ruins + the burnt farm + 4 farmsteads (of 7 wanted: no more room).
      · OUTCROPS (rtsAlgeria buildRockOutcrop, 540 tris, 4 seeds = 4 draws):
        42 on 9-32° slopes, 34 m apart, off tracks / fields / pieces; HARD
        cover (algCover reads coverCircles), impassable (nav footprint).
      · LONE TREES: 24 big olives / holm oaks / figs (×1.15-1.55), 60%
        beside a track, 55 m apart (the showroom's PlacedFoliage: no draws).
   - [ ] you, look: the burnt farm's soot (dark panels), the outcrops'
         size (they may want to be bigger), the barley green (saturated).
- [x] **FIELDS + HEDGES — filling the land** (2026-10-01, algFields.js; you:
      "it still looks empty for an RTS", picked 1 + 2 of the fill list).
      SEEN IN THE GAME: 45 plots, 1072 wall segments, 1064 hedge plants,
      65 stones lifted out of the fields. GPU on vs off (surfaces + walls,
      gpuAB): 3.46 vs 3.33 ms = +0.13 (noise 0.11). Cover at a wall 0.89,
      concealment by a hedge 0.6 (the map's max), open ground 0.
      · Plots round the 4 villages (10 / 12 / 15 by kind), 14-190 m out,
        < 15° and < 5.5 m relief (11° / 3.5 m found only 18), off tracks /
        wadi / cliffs / water / every placed piece (+4 m lanes), long side
        along the contour; scrub, grass and loose stones cleared
        (algStones.clearWhere). Surface = ONE draped draw, LIT soil of its
        own (a 2× multiply over the ground photo kept its pebbles: the
        field read as darker stony ground), furrows EXAGGERATED to 1.5 m
        (0.7 m vanished at play zoom), stubble / barley rows 1.1 m.
      · Low dry-stone walls on ~3 sides with a gate: rtsAlgVillage
        buildFieldWallSegment (220 tris) INSTANCED, 3 variants = 3 draws;
        hard cover (algCover reads coverCircles; re-baked after).
      · Prickly-pear hedges outside open sides and along the pistes near the
        villages (runs of 24-60 m, gaps): the showroom's PlacedFoliage, no
        new draws; CONCEALMENT within 1.8 m (algCover concealExtra).
   - [ ] **you, look**: the field colours (stubble may be too bright and
         even), furrow strength, hedge density (1.05 m, half doubled), how
         close the fields come to the villages. Close up the soil is clean:
         a fine clod grain if it shows at play zoom.
   - [ ] Unwalled field sides could get a cleared-stone line (cheaper wall).
   - [ ] Orchards as a field kind (rows of olives / almonds — placed foliage).
- [x] **BARBED WIRE THAT MATTERS** (2026-10-01, algWire.js; CoH's wire):
      the sappers' wire is a NO-FOOT footprint (shared navGrid.js cell 3,
      nam unchanged): infantry of both sides path ROUND it (tested: 22 m on
      foot vs 14 m for a vehicle across one piece), vehicles drive over and
      CRUSH it, a grenade or shell BLOWS it, men beside it CUT it (8 s one
      man, ~5 s two; tested). Sappers: the "Couper" order (nearest wire,
      40 m). Wire leaves the grid at once, no rebuild (clearNoFootFootprint).
   - [x] (2026-10-01, AI round 1: a stuck band cuts wire; sangars and screens built) **you (algAI.js)**: the FLN cutting wire that stands between a band
         and its goal — `app.algWire.cutNearest(men, x, z)`; today they
         only go round. Same for building: `app.algBuild.place("sangar" |
         "ambushScreen", x, z, yaw, men)`.
   - [ ] A man caught in wire (pushed in by a blast): slowed / snagged.
- [x] **THE LAND AT WAR** (2026-10-01, you: "poles, tyre tracks, damage
      states — always optimized"). MEASURED: all of it on vs hidden, same
      view, gpuAB 4 rounds: 3.15 vs 3.22 ms — inside the noise (0.22).
      · TELEGRAPH LINE (algPoles.js; rtsAlgeria buildTelegraphPole, 146
        tris): 20 poles along the pistes, 5.5 m off the centre, ~42 m apart;
        ONE instanced draw (+ its shadow) and ONE line draw for the 640 wire
        segments, sagging. Each pole blocks a 2 × 2 m nav cell (a tank drove
        through one). ?poles=0.
      · TYRE / TRACK MARKS (shared-rts/trackMarks.js, wired in
        algAmbience.js): one instanced draw, draped in the vertex shader,
        ruts drawn in the fragment shader (tyres plain, tracks with links),
        fade over 50 s in the shader; MULTIPLY blend (reads the same in
        shadow); each mark uploads only its own slot. Per-vehicle gauge.
      · DAMAGE (algDamage.js, fed by algCombat's explosion wrapper):
        SANDBAGS breached by a blast ≥ grenade (rtsAlgeria
        buildFrSandbagWallBreached, swapped in; cover hard → soft, one
        re-bake 1.5 s after the last breach). HOUSES hit by a shell/mortar:
        burn ~25 s on the roof, smoulder ~2 min (algAmbience.smoulder),
        RUBBLE heap at the wall's foot toward the impact (rtsAlgeria
        buildRubbleHeap, one InstancedMesh, ≤ 2 per house). BUILDINGS under
        half health smoke (thicker the worse); a wreck smokes 90 s more.
        All new kit pieces pass rtsPropsCoplanarTest + rtsGroundBandTest.
   - [ ] Houses don't COLLAPSE: a village is one merged mesh with no house id
         per vertex. Bake a house id into the village geometry, then a
         shader can drop a hit house's roof and char its walls (one uniform
         array per village).
   - [ ] you, look: the poles' side and spacing; the rut strength (tint
         0x9a8a78); the burning-house smoke (the ovens' grey, thicker).
   - [x] (FIXED 2026-10-01: ribbons, see THE LAND BETWEEN THE VILLAGES) **The wires read as ruled straight lines** (you, 2026-10-01). Why:
         they are 1 px GL lines (always 1 px, any zoom, no shading), and the
         sag is only 1.4% of the span (~0.6 m on 42 m) — nearly straight.
         Fix: real wires as thin RIBBONS (the barbed wire's trick: drawn fat,
         ~2.5 cm, so they keep a pixel or two and catch the light), one
         merged mesh, still ONE draw; sag ~2.5-3% (1-1.3 m: a PTT line hangs
         visibly); 16 segments a span so the curve is smooth; a faint
         per-span sag variation. Judge at play zoom AND close.
   - [ ] Poles: the FLN cuts the line → the post loses its radio (minimap
         intel) — gameplay, later.
- [x] **THE BATTLE — a goal, and the game telling you what happens**
      (2026-10-01, algBattle.js + ui/battleHud.js; you: "no enemies, what
      do I do with the village? very confused"). CoH victory points:
      · the 4 VILLAGES are the points. 500 each side; the side holding
        fewer bleeds 0.35/s per village of difference (all 4 vs 0: ~6 min).
        Cave destroyed = victory, post destroyed = defeat.
      · SCORE bar top centre (both counts, villages held, who bleeds);
        a MARKER over each village (name, owner colour, capture bar);
        ALERTS left above the minimap (contact, a village worked / won /
        lost, a band seen, mines spotted / cleared / gone up, buildings
        lost, the post or the cave under fire) — click or SPACE goes there,
        a brass ping on the minimap; a BRIEFING at the start, a VICTORY /
        DEFEAT screen (keep watching / play again). ?battle=0, ?brief=0.
      · Capture slowed (algEconomy push 0.02 → 0.01): 4 men turned the
        ksar 10 s after the warning. Now ~20 s from neutral, ~53 s back.
      · TESTED in a real game: the first FLN alert came at 4:33 (a band
        out of the camp), the ksar worked at 5:07, turned at 5:17 (old rate).
   - [ ] **you, play it**: is 0.35/s the right bleed? Is the first 4½ min
         too quiet (the AI's pace — algAI.js, yours)?
   - [ ] Sound for the alerts (a radio squelch per alert) — sound is off
         by default now, so later.
- [x] **2026-09-30, second batch**:
      · DOUM back on the slopes (8-26°, in clumps; 204k texels). The "flat
        green mats" were NOT the far LOD (pushed out, same look): a low clump
        is past the foliage shadow distance (35 m) at every RTS zoom, so its
        fans could not shade each other and every one sat at the pale tip
        colour. Fix: `crownShade` (fanPalmGeometry.js, opt-in, doum 0.75)
        takes the older, lower fans down the colour ramp. nam's fan and
        sugar palms don't set it: unchanged. you, look: the pale dot at each
        clump's heart (the short petioles meeting) — keep it or darken it.
      · SAPPER SITES: an amber progress bar over each (algBuild's own bar
        field; shared healthBar.add takes an optional colour, nam
        unchanged). A site is PICKED like a structure (the selection's
        buildingRenderer): the card says "Chantier · <piece>", Under
        construction, **Annuler (+cost)** = the whole price back (CoH), the
        foundation gone, the cells free again (a nav rebuild, ~70 ms, once).
      · ALN BUILDS: BUILDS.sangar (60, 16 s: becomes the sangar structure,
        MG and all) and BUILDS.ambushScreen (25, 8 s), paid from the ALN
        purse, raised by moudjahidine (`by`). An ALN site is the fog's:
        hidden until explored, its bar and its digging sound only while
        seen. The SCREEN now CONCEALS: the strip behind its hedge reads as
        full scrub (shared cover.js `concealExtra`, nam unchanged; the
        showroom's screen too) — 0.6 behind, 0 in front. TESTED: a
        moudjahid raised both. NOT DONE: the AI deciding to build — that is
        algAI.js (you): `app.algBuild.place("sangar", x, z, yaw, [men])`
        resolves to the site, or null (`survey(...).why` says why).
- [x] **The GAZELLE in the game** (2026-09-30, algHerds.js): the deer loaded
      beside the donkey; 3 groups of 3-6 (a fawn in five) on open, bare,
      gentle ground in the south half, 70 m clear of every site; they graze,
      wander 18 m, and BOLT (tested: a whole group 55-65 m off a soldier in
      ~5 s). 14 on the map. you, look: whether they read at play zoom
      (fawn on fawn ground — the white rump is what shows).
- [x] **2026-09-30**:
      · MAP EDGE: outside PLAY darkened (CoH) or a dust haze (Dev → Map
        edge: on/off, style, strength, colour — you: pick the default);
        orders outside go 8 m inside.
      · AMBIENCE (algAmbience.js, one draw each): vehicle DUST (pale, blown
        downwind, ~3 s), OVEN SMOKE from 3 roofs per village (ray-found
        roof heights, burning on and off); LAUNDRY on ~half the ksar's
        roofs (own random stream: the town unchanged); 2 DONKEYS in the souk.
      · BIRDS in flight: smooth lofted bodies, smooth wings with separate
        fingered primaries, fanned tails, sRGB colours (alg only). PAUSED —
        fine-tune later (you).
      · COH CAMERA: FOV 60 → 40 (was ~103° across on a 2:1 window), zoom
        28-80-190 m (was 18-52-130), tilt 35°→60° (start 43°, CoH's editor
        default 45). Dev → Camera → FOV to try others. Shared rtsCamera
        options; nam unchanged.
      · PERF CHECK after the week's additions: perfBench 332.8 (27-09: 342.2),
        GPU 1.1-1.4 ms per view (timer), ambience + birds ≈ 0 GPU; CPU
        herds + birds + ambience ≈ 1 ms of ~6.6. Nothing to trim.
      · PISTE DU KSAR (algTracks --route --add --only: the other tracks
        untouched): 253 m from the Oued piste up to the souk's steps.
        A* now capped (an unreachable end ran for minutes).
      · STONES THAT MATCH THE GROUND (algStones.js): 5,745 stones from the
        map's paint — scree 4,345, soil 714, wadi 385, limestone 208, piste
        shoulders 93 — each kind textured with its layer's own photo
        (triplanar), shapes from the engine's rock generator (48-520 tris),
        sunk 20-35 %, tilted to the slope; 23 draws, 554 k tris; lumps and
        boulders cast shadows. GPU on/off: +0.15 ms scree close-up, noise at
        the start view and zoomed out. you, look: density, colour (a shade
        lighter than the ground), the gravel along the pistes (sparse).
      · HEALTH BARS at close range (shared healthBar.js): closer than 25 m a
        bar keeps its on-screen size, none within 2.5 m — a camera down among
        the men drew a bar as a big dark box. Play zooms unchanged.
      · SOUND (algSounds.js on the shared mixer, games/shared-rts/rtsAudio.js
        — moved from nam's namAudio.js unchanged; nam keeps its manifest,
        OFF default): 22 slots, 3 CC0 candidates each where found
        (tools/algFetchSounds.mjs → public/sounds/alg/, 13 MB), loudness and
        trims measured in the browser (algSounds.measure()) and baked. French
        rifle vs ALN rifle, MG, tank gun, impacts, blasts near/far, mortar
        whistle, cries (55% of deaths), jeep/truck/Alouette/fire loops,
        sappers digging; WIND bed + CICADAS by day; dogs when soldiers near a
        village, flocks bleating, donkeys braying, the CALL TO PRAYER from the
        ksar every 4-6 min; UI clicks, radio on orders. ON by default here.
        Dev → Sound: mute, 4 buses, every slot's candidates (▶ to hear).
        Measured in a 16-man fight: 15-18 voices, peak -6..-9 dB, no clipping.
        you, LISTEN: pick the candidates (they were chosen blind, by search).
      · THE POST'S GATE: its rubble footing ran a knee-high wall ACROSS the
        gateway (men walked through it) — now either side of the arch, a
        threshold slab in the passage.

---

## YOUR ASKS — 2026-09-29: soldiers from Mixamo

Pipeline: `assets-src/soldiers/` (the SOURCES — the Mixamo FBX rig + clips,
unrigged GLB soldiers, the rig's textures; outside public/, so they don't
ship) → `node tools/packMixamo.mjs --skip soldier3 --rig-texture originalsoldier` →
`public/models/soldiers/soldiers.glb` (one skeleton, clips once, every soldier
skinned to it) → judged in `games/shared-rts/soldier-lab.html`. In alg-rts
(appelé, sapeur, para, légion, moudjahid); soldier3 waits for nam's own pack.

- [x] Pack tool + lab. soldier1 (the Mixamo rig) and soldier3 (your GLB, given
      the rig's skeleton by nearest-surface weight transfer: median 0.4 cm off
      the rig's skin, unchanged through every clip — no tearing).
- [ ] **you**: judge soldier1 vs soldier3 in the lab (close + RTS camera,
      "Skin weights" view), then download the full RIFLE clip set (~14–20,
      "In Place", short idles 2–4 s) and drop the other soldiers in.
- [x] **THE SOLDIER LAB, reworked** (you, 2026-09-30: "no button for a whole
      section; the selection is buggy, it changes"). The bug: picking a LOOK
      silently switched Body to All and reset the Weapon to the look's (and
      stayed there); a lone man was dressed as man #0 = the section leader.
      Now: Body and Weapon have AUTO (the look's own bodies / each man's own
      weapon as the game gives it) and a hand pick STAYS; "On show" and
      "Carried: MAT 49 ×15, …" say what is really there. SQUAD: 1 of each
      body / groupe 12 / section 30 (roles every 12th man, as in the game);
      formation ranks / column / loose (CoH); BATTLE MIX (each man his own
      idle/aim/fire/reload, standing, kneeling or lying). Clips grouped
      (standing, kneeling, lying, posture moves, work, deaths); a TIME
      scrubber + "in step"; the RTS view and the sun's shadow box fit the
      group; HUD text no longer selects on a drag, a clicked button gives
      its focus back (Space no longer re-presses it).
   - [ ] **you, look**: a section of 30 in battle mix, from the RTS view
- [x] **GRIP EDITOR** (you, 2026-10-01: "fine-tune the weapons in the hand
      and on the back"). games/shared-rts/soldierGrips.js holds the hand-placed
      corrections: per CLIP (baked by the pack into the weapon bone; on
      aim/fire clips before the arm IK, so the right hand follows the rifle),
      per WEAPON (baked into its geometry by procWeapons build()), the SLING
      (baked into its bone). All free in the game. The soldier lab's Grip
      editor: a gizmo on the first man's weapon (W move / E rotate) or typed cm
      and °, markers on the palms and the shoulder pocket, close-up views (his
      right / left / top / over the shoulder); edits kept in the browser,
      "Copy grips" → paste to Claude → pack. Checked: an empty file packs
      byte-identical; test grips land exactly (5.00 cm along the barrel,
      10.00°, sling 3.00 cm); the lab moves the rifle exactly as typed.
   - [x] **THE HAND POINT** (you, 2026-10-01: "in idle it's perfect but other
         clips move the gun weirdly"). Measured: your five clip fixes were the
         SAME fix (~10 cm forward, ~8 up) — the pack grabbed halfway from the
         wrist to the index knuckle, which on this hand is the WRIST; every
         unset clip kept it (the rifle jumped 6-14 cm on a clip change), and
         the aim/fire fixes would have pushed the butt 13 cm off the shoulder
         once baked (the arm chases the rifle). Now GRIPS.hand: one point in
         the hand for EVERY clip — a carry hangs the rifle from it, an
         aim/fire clip bends the arm so it lands on the grip; the lab runs the
         pack's IK live, so the lab = the bake. Default 6 cm toward the
         fingers (the stock wrist through the middle of the fist, close-up).
         Checked: pack — every clip's keys shift exactly 6.00 cm, the 4 aim
         clips re-bend the arm; lab — the hand point on the grip to 0.00 cm in
         every clip, paused or playing (a paused mixer kept last frame's bent
         arm: fixed). Empty grips still pack byte-identical.
   - [x] **THE GRIPS SET** (you, 2026-10-01: "why can't you do it yourself?"
         — Claude did, in the lab, measured + a four-view sheet per clip):
         the LEFT fist was 5-8.5 cm to his right of the barrel in every clip
         the hand holds the rifle — the lab's new AUTO-FIT turns each clip so
         the barrel runs through it (carries in the right fist, aim/fire about
         the butt so it stays in the shoulder); reload / crawl / posture moves
         (the left hand lets go) left alone. The SLING lay underside-in, held
         8 cm off the back by the magazine: rolled flat, 6 cm in. Checked on
         a test pack, nothing corrected live: right fist on the grip 0.0 cm,
         left fist 0.0-1.4 cm off the forestock line over every clip; MAT 49
         and FM 24/29 looked at too. In soldierGrips.js, packed 2026-10-02.
   - [x] **CLOSE-UP PASS** (you, 2026-10-01: "zoom on the hands, only
         confirm when it really looks right; the shovel can be better"):
         · the HAND POINTS measured, not guessed: the middle of each fist's
           own mesh (right (3.1, 6, 1.6), left (-4.1, 4.2, 1.8) cm in the hand,
           steady to ~1 cm across clips) — the left hand has its own now;
         · the SHOVEL: aimed fist to fist (the right hand gripped 20 cm down
           the shaft, the left on the socket, the blade 7 cm off the ground);
           the top fist wraps the shaft with the D-grip clear above it, the
           blade reaches the ground. The shovel MODEL's D-grip floated 2.5
           cm off the handle: now a crossbar on two arms (procWeapons);
         · the left-hand auto-fit re-run with the measured fist;
         · a test that a held line is IN the fist: around it, the fist's
           skin leaves no gap over 87° on any frame of 12 clips (the first
           setup: 206-248°, beside the hand). Same on a baked test pack;
           the shovel bakes to 0.04 cm / 0.16° of the lab's.
   - [x] re-pack soldiers.glb with them (2026-10-02: lab finds all packed, both fists IN on the real file; the game loads it clean at 60 fps)
   - [ ] **you, look** in the lab / the game after the re-pack
- [~] **HERO: COLONEL MARC DELORME** (you, 2026-10-02: "a recognisable
      leader, better looking than the others; the FLN one later"; "do with
      what we have" — no new model; "show me in the lab first"). FICTIONAL,
      a para colonel in the Bigeard mould.
   - [x] his LOOK, in the soldier lab ("Colonel (hero)", soldierLooks.js):
         the para body; casquette Bigeard, sunglasses, a cleaner léopard
         smock, MAT 49, binoculars, and three new pieces no other man has —
         a chest tab with five gold galons, a leather map case on the left
         hip (strap across the chest), a holster on the right hip. The scarf
         left off (a tan block at the throat on him).
   - [ ] **you, look** in the lab, then say if he goes into the game
   - [ ] LATER, the game (built once, taken out until you decide): a
         "colonel" type (160 hp, one of him, at the post's gate); 6 % taller
         in the shared crowd (no extra draw); a gold ring that always shows;
         AURA (men on foot within 20 m shed suppression +0.35/s, shoot ×1.15
         — an accMul in algAccuracy); RALLIEMENT on the command card (60 s:
         suppression and pins gone within 25 m); he FALLS: a shock on the men
         round him, an alert, back at the post in 90 s.
   - [ ] the FLN's chief, the same way (a fictional Aurès katiba leader)
- [~] **Weapons in their hands.** Built 2026-09-29: procedural MAS 49/56,
      MAT 49, MAS 36 (games/shared-rts/procWeapons.js, 180–280 tris) on a
      WEAPON bone the pack tool adds under the right hand, aimed per clip at the
      left hand (Mixamo's rifle clips hold the rifle at different angles — one
      fixed grip was ~15 cm off; per clip the left hand stays within 1 cm).
      **you**: judge in the lab on the rifle clips, set the grip trim. Then:
      merge the weapon into the crowd mesh (skinned to the weapon bone), and
      if the procedural guns don't convince, you find models online.
- [x] Clips by ROLE: the pack tool names Mixamo titles (rifle_idle,
      rifle_aim_idle, rifle_prone_idle, …; table in tools/packMixamo.mjs) and
      decides the rifle hold from the MOTION (left hand on the rifle or not),
      so you drop files in with Mixamo's names. Firing/aiming clips are
      shouldered (butt in the shoulder pocket, right arm IK'd onto the grip).
- [~] **Faction looks v1** (games/shared-rts/soldierLooks.js, in the lab):
      uniform recolour by hue in the shader (appelé olive, para léopard camo,
      ALN khaki), helmet removed (its own UV region; a bare head with hair
      under it), low-poly headgear on the Head bone (bush hat, casquette
      Bigeard, red beret, chèche, ALN field cap). **you**: judge colours and
      hats — the colours are a first pass from memory, check against photos.
- [x] Looks v2 (2026-09-29, checked in Chrome): helmet found as mesh PIECES
      (soldier1's nose, eyes and hands reach into the helmet's UV region — the
      appelé's olive nose), chin straps + soldier3's goggles removed with the
      helmet, hats refitted to the measured head, léopard camo in the shader
      on the smock AND the Bigeard cap, silver winged-dagger badge on the
      beret, per-soldier variation (cloth fade, skin tone, camo offset) and
      SECTION looks that mix headgear (appelé: helmets + bush hats; para:
      Bigeard caps + berets).
- Decisions (you, 2026-09-29): alg-rts French = **soldier1 only** for now,
  varied by looks; soldier3 stays for the Vietnam game. Of the pack's other
  bodies: **medic** = the medic unit later (and a 2nd French silhouette if
  squads look too uniform — its white armband is painted in, needs a mask);
  **headband + boonie** = the two ALN bodies; **crew** = vehicle crews later.
- [x] Kit + insignia (2026-09-29, in the lab, checked in Chrome): KIT pieces
      on bones in soldierLooks.js — pack with blanket roll (Spine2), backpack
      radio with a 1.3 m whip antenna (Spine2; one radioman per section, index
      `radioman`), belt with ammo pouches + canteen (Hips). Looks: "Appelé,
      radio", "Légion para" (green beret, gilt seven-flame grenade).
      Modelled around soldier1's MEASURED torso — another body needs its own
      numbers.
- [x] French extras (2026-09-29, checked in Chrome): per-soldier EXTRAS
      rolled per look (sunglasses — mostly paras —, mustache, cigarette, sand
      neck scarf, chest grenades) and section ROLES by index: 0 leader (MAT 49
      + binoculars), 1 radioman, 2 FM 24/29 gunner (new procedural LMG, top
      magazine + bipod). soldierLooks.js loadout(); the lab's "All extras"
      switch shows every piece on one man.
- [x] Aviator sunglasses redone (2026-09-30): big teardrop lenses in a gold
      wire rim, double bridge, lenses turned back to follow the face.
- [x] **ALN v1** (2026-09-30, checked in Chrome) on aln1 (the headband body,
      fits the rig: median 0.8 cm). "ALN section": chèches (white / sand /
      pulled over the face), field caps, bare heads with the body's own
      headband; beards (with mustache) and mustaches; one or two crossed
      bandoliers with brass cartridges; musette bag; cloth per man from khaki
      drill to civilian brown; North African skin range; leader MAT 49, LMG
      FM 24/29, rest MAS 36. Fixes on the way: helmet detection needs a
      helmet-sized piece (aln1's hair tufts share the helmet's UV area), face
      pieces shift by each body's crown offset (aln1's head sits 4 cm higher),
      clothRef per look (aln1's cloth is far darker).
- [x] ALN v2 (2026-09-30, checked in Chrome): chèche wound in slanted turns
      over a shaded under-layer, a long loose end over the shoulder; aln2 (the
      boonie body, fits: median 0.8 cm) mixed into the section with aln1
      (`bodies` per look); "own headwear" variant keeps aln1's headband / aln2's
      boonie. HEADWEAR rule (soldierLooks.js): helmet pieces, thin straps and
      cords, goggles, and anything sticking out of the bare head — removes
      aln2's whole boonie (202 tris), leaves soldier1/3 unchanged.
- [x] Blocky cloth (2026-09-30): the pack paints mud as pixel blocks + ETC1S
      blocks; the recolour now classifies and shades repainted cloth from a
      softer mip (bias 1.5) — lightened ALN cloth no longer doubles the blocks.
      Untouched texels keep the pack's look (your call: keep it).
- [x] ALN v3 (2026-09-30, checked in Chrome): Mauser 98k + Lee-Enfield (SMLE)
      procedural; ALN `weaponMix` per man (MAS 36 / Mauser / Enfield); FLN
      flag on a back pole for the standard-bearer (role 3, since removed);
      KACHABIA — an
      open-front hooded wool cape, the first SKINNED kit piece (spine above
      the hips, blended hips → each thigh below): follows a walk without
      tearing. Look "ALN, kachabia"; 20 % of an ALN section wears one.
      The lab moved to games/shared-rts/soldier-lab.html (the engine must not
      import games/ — gameImportBoundaryTest).
- [x] Clips (2026-09-30, 8f7c090): 14 rifle-era clips — idle, aim idle,
      walk, run, crouch walk, kneel idle, kneel fire, fire, prone idle,
      reload, grenade throw, dig, death forward, death backward. SLING +
      TOOL bones: the rifle goes to the back and a shovel to the hands for
      digging / the throw, by per-clip bone scale.
- [ ] Clips later (when the game uses them): crawling + prone firing
      (pinned), flying back death (mortar), hit reaction, sprint (retreat), a
      2nd idle, stand/crouch/prone transitions. Trim the two 8 s idles to 2–4 s.
- [ ] **Into the game** (the rules for hundreds of soldiers):
   - [x] crowd renderer (2026-09-30): every clip baked; per-soldier state —
         run (paced to the unit's measured speed, no skating), aim with a
         target in range, the firing clip on each shot (the cooldown reset),
         idle; 0.2 s crossfades; deaths play once, hold, the body stays 14 s.
         Checked in the game (Chrome) + nam unchanged (idle/run fallback).
   - [x] **X-RAY, CoH rules** (2026-09-30, checked in Chrome, both games):
         only the WORLD hides a unit. By draw order, no stencil (the post
         chain samples scene depth; a depth-stencil texture can't be sampled):
         world opaque → silhouettes (renderOrder 30, opaque list, blended —
         the depth buffer holds the world only) → units (31) paint over any
         silhouette behind them. No glow through another unit or through the
         unit itself (the per-vehicle Huey-sized depth lift is gone: one 2.5 m
         lift for all, against grass and the ground). alg-rts now passes its
         heightmap too: no silhouettes through hills (only nam did).
   - [ ] x-ray later: overlapping silhouettes still stack their alpha (a
         squad behind one wall reads a bit patchy); CoH's is one flat layer.
   - [x] CoH INFANTRY BEHAVIOUR (2026-09-30, your go; checked in Chrome):
         shared-rts/infantryPosture.js — every round fired at a man on foot
         SUPPRESSES him (rifle 0.07, MG 0.2 and its target's squad within 6 m
         at 60 %, a shell's blast 0.9), draining 0.3/s. Suppressed (0.4):
         KNEELS, 70 % speed, 80 % fire. PINNED (1.0, up again below 0.55):
         PRONE, crawls at 30 %, half rate of fire. A man sheltered from his
         target (the shared directional cover), or standing still behind
         something, KNEELS and fires kneeling. Sapeurs raising a site are
         marked `working`, face it and DIG (shovel out, rifle slung). Hooks
         only in the sim: units.js moveMul, combat.js fireMul + onShot /
         onSplash. MEASURED: an 8-man band under the post's MG pinned in ~2 s;
         0.16 ms a sim step at 600 men. (A first version suppressed only the
         man an MG aimed at: the band only ever knelt.)
   - [x] the GRENADE (2026-09-30, algGrenades.js, checked in Chrome): a
         command-card ability + G; a blast ring follows the cursor (green in
         the thrower's 24 m reach, amber: he walks up first), click throws,
         right-click / Esc cancels. ONE man throws (the nearest ready), rifle
         quiet, the pack's throw clip from 0.6 s, the grenade leaving his hand
         1.25 s later (MEASURED on the clip: the throwing arm peaks at 1.85 s);
         an arcing shell → combat.splashAt (70 at the centre, 5 m) → damage +
         SUPPRESSION round it. 30 s cooldown per man. appelé, para, légion,
         moudjahid carry them (`grenade: true`). Measured: 4 of 5 bunched ALN
         killed, the fifth pinned. Mortar bombs now show their landing rings
         too (projectiles.drawWarnings was never called in this game).
   - [x] A MAN SHOT no longer leaves a fire and a crater (combat.onImpact,
         both games): men on foot go down in their dust puff only.
   - [x] THE ALN FIGHTS WITH THE COH MECHANICS (2026-09-30, algAI.js,
         checked in Chrome): it knows the French MGs (post, miradors, nests,
         jeeps, half-tracks — the buildings from algStructures) — no ambush
         spot inside one's reach + 8 m, and the way in goes ROUND one it would
         cross (a via point off to the side, in cover / low ground; measured:
         a line across the post detours 180 m south). Fired on while sneaking
         in: it opens up. Striking: a man fired on out of cover runs to the
         best shelter within 12 m away from the shooter (infantryPosture now
         records `firedOnBy`); half the band PINNED: it pulls back; one
         GRENADE per band every 6 s, at French bunched / in cover / an MG
         nest (measured: thrown 0.5 s into a strike, from 22 m). A thrower's
         rifle is quiet through combat's own `throwing` check (the grenade no
         longer touches holdFire, which the AI owns).
   - [ ] **you, look**: a raid on a patrol — the grenades, the dash to
         cover, the pull-back when your MG pins them
   - [x] THE GRENADE LOOKED LIKE A BOMB (you, 2026-09-30): it flew as the
         mortar's 1.8 m shell and burst as a shell (6 m fireball, 3.5 m
         crater, the ring from twice its blast). Now `kind: "grenade"`
         (projectiles.spawnArc → combat.splashAt): hand-sized (~0.25 m) and
         tumbling end over end; its own burst (combatFx.grenade: a small
         flash, a short dark burst, the earth thrown up, a 1.5 m scorch); its
         warning ring closes in from just past its 5 m blast. Checked close up
         in the game. Mortars unchanged.
   - [x] a crawl clip for pinned men who move — Mixamo's rifle "Prone
         Forward" (rifle_crawl), in the game since c3808f7
   - [x] **INFANTRY BALANCE: ACCURACY** (2026-09-30, algAccuracy.js via
         combat.js `hitChance`; nam unchanged): every round hit before — 6 on
         5 at 22 m lost 40 % in 2 s. Now a round rolls: by range (rifle 0.4 →
         0.15, MG 0.55 → 0.3), × 0.8 kneeling, × 0.5 prone, × 0.75 moving,
         × (1 − 0.3 cover). A miss flies into the dirt and still suppresses.
         MEASURED in scripted duels (5 v 5 at 26 m): open ground decided in
         12-21 s (~16, CoH's pace); a section behind a wall wins 5-0 (the
         damage cut behind cover) — the grenade and the flank are the answer.
         ?acc=0 = the old fights; `app.algAccuracy` = the live table.
   - [ ] **you, look**: a firefight now — long enough? the misses kicking
         dirt round the men; the post's MG (it hits half as often now; its
         suppression is the same)
- [x] **BLOOD** (2026-09-30, shared-rts/bloodField.js, checked in Chrome
      close up): (1) a man HIT sprays a few dark droplets out of the wound,
      away from the shooter, falling under gravity, and a faint mist — ~0.4 s,
      combat.onHit; (2) a man DOWN lies in a POOL under his torso (the
      renderer says where: the pack's deaths travel forward 0.30 m / backward
      0.83 m) — a draped decal whose outline is grown in the shader (noise
      lobes + a ragged rim, seeded per man: no texture), stretched along the
      body, spreading ~3.5 s after the fall, wet dark red drying to brown from
      the rim in, fading with the corpse (18 s). TWO draws for the whole
      battle; the CPU writes floats only when something spawns (the flight and
      the spread are GPU-side). ?blood=0 boots without. The flipbook dropped
      (your call).
- [ ] blood: a gore switch in an options menu (the game has none yet)
- [ ] (moved up to FROM YOUR PLAY 2026-10-03) **ANIMALS DIE in the fighting** (you, later): shells, grenades, napalm
      and fire kill the herds' animals near them (their death clips; the body
      stays, like the soldiers'); the rest bolt (they do). Nobody aims at them.
      Later: a village whose flock you killed turns against you.
- [ ] **BATTLE DAMAGE on buildings** (you, later: "a city that just had an
      explosion"). Proposal: (1) SCORCH — a world-space top-down scorch map
      the blasts paint into, sampled by the buildings' shaders: walls go black
      where the fire was, one small texture for the whole map (NOT the
      terrain's: it is at its 16-sampler limit — the ground keeps its crater
      decals); (2) rubble piles + lingering smoke; (3) DAMAGE STATES for the
      procedural kit buildings — the roof caved, a wall breached, generated
      like the buildings themselves — and the cover map re-baked (a breached
      wall stops covering).
   - [ ] **you, play it**: MG pinning speed, how often men kneel in cover
   - [~] **TRANSITIONS** (you, 2026-09-30: "look at all of them and see if
         everything is right and natural"). games/shared-rts/transition-lab.html
         plays every pair the game switches between through the game's OWN
         crowd skinning (it mixes skinned POSITIONS, not bone rotations), with
         a film strip of the fade at 0/25/50/75/100 %. Judged and fixed:
         per-pair fades (soldierTransitions.js: shots 0.08 s — the recoil was
         eaten; stand ⇄ kneel 0.35; into / out of prone 0.45-0.5; dig, throw);
         a man PINNED or KNEELING who dies no longer stands up first (every
         death clip starts standing: deathFrom); the rifle / shovel SWAP at
         mid-fade instead of a shrinking rifle in the hands AND a growing one
         on the back for the whole fade (the pack stows by bone scale).
         The Rifle Crouch Walk in the pack is Mixamo's "Rifle Walking RIGHT
         Crouched" (a strafe; matched by frame count, and it side-steps).
   - [x] NEW CLIPS PACKED (2026-09-30, judged in the lab's MOVES): Rifle
         Stand To Kneel / Kneel To Stand / Kneel To Prone / Prone To Kneel,
         Prone Forward (crawl), Prone Firing Rifle, Prone Death, Death
         Crouching Headshot Front, Crouch Walking (the forward one, lower —
         the old "Rifle Crouch Walk" is Mixamo's strafe, kept as
         rifle_crouch_strafe). The pack now pins the hips: loops that travel
         ramped in place (Crouch Walking walked 1.29 m); transitions ramped to
         START on the from-clip's hips and END on the to-clip's (Stand To Kneel
         ended 21 cm off). soldierTransitions.js MOVES: which clips a posture
         change plays; transition-lab "Moves" plays them as the game will.
         Verdicts: the four transitions and stand ⇄ prone through the kneel
         natural; crouch walk, prone fire, prone death good; the CRAWL's rifle
         points into the ground; the headshot kneeling death stands him up
         (you added "Crouch Death" to try instead).
   - [x] THE GAME PLAYS THE MOVES (2026-09-30, traced in Chrome with the new
         unitRenderer.clipOf): pinned standing → Stand To Kneel → Kneel To
         Prone → prone (1.98 s: the drop sped up — 1.25× / 1.6× — the sim has
         him pinned at once; it was 2.9 s), released → Prone To Kneel → Kneel
         To Stand. Only standing still: ordered off mid-move he drops it and
         fades. Pinned + moving → the CRAWL (its rifle now along the forearm:
         the pack aims it per frame — the average grip pointed it into the
         ground); pinned + shooting → prone fire; deaths by posture: prone →
         Prone Death, kneeling → Crouch Death (you added it; the headshot one
         stood him up, kept aside), standing → the standing falls; the blood
         under each one's chest (DEATH_CHEST).
   - [ ] **you, look**: the moves in the game (the drop speed; the lab's
         "Moves" shows each)
   - [x] a dead man's rifle falls away (2026-09-30, unitRenderer dropRifle):
         part-way through the fall (at once from prone) it leaves the hand,
         drops in 0.3 s and lies on its side on the ground beside him; same
         instanced rifle draw. Checked: standing, kneeling, prone deaths
   - [x] skinning work sized to the LIVE soldiers (renderer.compute count)
   - [x] alg-rts types on the pack: appelé + sapeur = soldier1 / "appele",
         moudjahid = aln1 / "alnSection" (crowd shader looks, per-man seed)
   - [x] WEAPONS in the game (2026-09-30, checked in Chrome: in the hands,
         shouldered when firing): one InstancedMesh per weapon (+ its slung
         copy, + the shovel) per soldier type, placed by the baked bone matrix
         (crowdSkinning boneMatrix, the same table the GPU skins with); no
         shadow; ALN draw MAS 36 / Mauser / Enfield per man.
   - [x] HATS + KIT + EXTRAS in the game (2026-09-30, checked in Chrome):
         every piece a look can roll is an InstancedMesh per soldier type,
         made at load (warmed with the rest); per-soldier loadout at spawn
         (variant, role by spawn order mod 12, kit, extras, weapon); the body's
         own headwear hidden PER SOLDIER (markHeadwear + a flag in extra.w →
         collapsed triangles). Types: appelé = "appeleSection", sapeur =
         "sapeur" (new look), moudjahid = "alnSection" on BOTH ALN bodies (a
         crowd per body). Trap on the way: the skin's bind space is the
         MESH's (8 units/m, flipped), not the pack world — hats came out 1/8.
   - [x] the KACHABIA in the game (2026-09-30, checked in Chrome): the
         skinned kit is MERGED into the body's crowd geometry (unitRenderer
         withSkinnedKit: welded — 232 verts, +11 % skinning on the ALN bodies
         only — weighted to the bones, in the mesh's space), skinned by the
         same pass, no draw of its own; hidden per soldier by a bit in his
         extra.w (soldierFlags / hiddenNode, as the headwear). ~20 % of an ALN
         section wears it. Its wool lightened 0x5d4633 → 0x7d6147: under the
         game's exposure and ACES the lab's brown read near-black.
   - [ ] **you, look**: the kachabia's brown in the game (and the lab's now
         lighter one)
   - [x] PARAS and the LÉGION (2026-09-30, trained + checked in Chrome):
         `para` "Paras coloniaux" at the HELIPAD (the heliborne reserve; they
         walk off the pad's edge — only aircraft launch) 110, 10 s: hp 80,
         6.3 m/s, range 26, dmg 7, 3.0/s, Bigeard caps + red berets, MAT 49 /
         MAS 49/56 mix. `legion` "Légionnaires" (1er REP) at the POST 150,
         14 s: hp 95, 5.8 m/s, range 30, dmg 8, 2.6/s, green beret + grenade
         badge (new look legionSection). ALN standard-bearer role removed
         (you); the flag kit stays in the lab.
   - [ ] balance paras / légion against the ALN once the AI fights them
   - [x] looks in the crowd shader; per-soldier variation from the instance
   - [ ] a ~1.5k-tri distance LOD of each body (meshoptimizer), judged from
         the RTS camera; (soldier1's colour map → KTX2: see Asset cuts); no shadows on tiny kit
   - [ ] alg-rts swaps its stand-in (testsolanim.glb) for soldier1 + aln1/aln2
   - [x] MEASURED (2026-09-30, one tab focused, soldiers 4 m apart idle on
         screen, split over the five soldier types; CPU = the frame callback):
         | soldiers | CPU frame | fps | sim step | combat | unitRenderer.sync |
         | 0   | 7.3 ms  | 60 | 0.1 | 0   | 0.2 |
         | 100 | 9.8 ms  | 60 | 0.9 | 0.3 | 0.6 |
         | 300 | 14.6 ms | 60 | 3.3 | 1.0 | 1.4 |
         | 600 | 27.3 ms | 38 | 6.2 × 1.55 steps/frame | 2.2 | 2.2 |
         GPU: the crowds stay cheap (under ~0.5 ms at 600, inside the timer's
         noise). THE WALL IS THE SIM: units.update ≈ 10 µs a soldier a step
         at 60 Hz; past ~450 men the frame passes 16.7 ms and the fixed step
         starts owing extra steps (1.55/frame at 600). Packed 1.6 m apart it
         was 23.6 ms a step (separation). A trace blamed the windsock's
         computeVertexNormals (84 %): FALSE — an A/B with it off changed
         nothing; it is a real 0.6 ms/frame to shave, no more.
   - [x] **THE SIM for hundreds** (2026-09-30, measured, both games' shared
         code): SEPARATION — each pair resolved by its larger unit, reach
         3 × own radius (was own + 3 × the map's LARGEST, the Alouette's 6 m:
         a 40 m square per soldier, twice a step). COMBAT — a unit with no
         target searches every 0.2 s, staggered (was every step). Off-screen
         units skip their pieces and health bar (frustum); bar pool 512 → 1536
         (past 512 bars silently vanished). Same bench, CPU ms:
         | soldiers | frame (was) | sim step (was) | combat (was) |
         | 300 idle | 10.1 (14.6) | 0.6 (3.3) | 0.1 (1.0) |
         | 600 idle | 14.4 (27.3), 57–59 fps (38) | 1.3 (6.2) | 0.3 (2.2) |
         | 600 packed 1.6 m | 16.2 | 2.8 (23.6) | 0.5 |
         | 600 MARCHING 60 m | 15.7 med / 19.5 p95, 55 fps | 3.0 | — |
         unitRenderer.sync at 600: 1.3 ms on screen, 0.5 off. The 30 Hz sim +
         interpolation now buys only ~1.5 ms at 600 — not worth it yet.
         Minimap 0.8 ms at 600: NOT the blips (batching them changed nothing,
         reverted) — the canvas redraw itself; throttle it if it matters.
   - [x] Health bars as in CoH (your yes, 2026-09-30): only on a SELECTED,
         HOVERED or DAMAGED unit, both games. Hover found in screen space in
         unitRenderer.sync (crowd soldiers have no mesh), `unitRenderer.hovered`.
         Checked in Chrome: 0 bars → 5 (3 hurt + 2 selected) → 6 on hover.
   - [x] **A NEW MINIMAP** (your ask + go, 2026-09-30; ui/minimap.js,
         checked in Chrome): CoH orientation kept (the katiba up); the corners
         show the terrain BEYOND the play area, dimmed, so the square is all
         map; baked at the slot's real pixel size (crisp); hill-shaded relief,
         rust on steep ground, tracks, the BUILDINGS' PLAN rasterized from the
         meshes' roofs and wall tops. Layers redrawn only when needed (fog 4/s,
         units 12/s, camera outline when it moves). Infantry dots, vehicle
         squares, aircraft arrows, a red pulse where a unit fires or is hit.
         Left click = camera, RIGHT click = move the selection
         (selection.orderMove, shared with the ground's right-click).
         MEASURED at 600 units: 0.05 ms a frame (was 0.8); the bake 30 ms at
         boot (a first version handed 190k triangles to the canvas path
         filler: 3.3 s).
   - [ ] **you, look**: the new minimap (colours, marker sizes, the pulse)
- [ ] Faces: the pack's faces stay cartoon-American — for close-ups a North
      African head (AI-generated or reworked in Blender) is the real fix. Not
      stars (generals only) or medals (parade dress); rank goes in the UI plus
      leader kit (MAT 49, binoculars).
- [ ] **Soldiers that fit French Algeria** — the current ones are Vietnam-war
      US soldiers (stand-ins). Find/modify: French appelés (M1947 or
      Satin 300 fatigues, bush hat / beret / M51 helmet, MAS 49/56), paras
      (leopard camo "tenue léopard", casquette Bigeard), ALN moudjahidine
      (mixed khaki, civilian clothes, keffiyeh/chèche). Same body + pose as
      the rig so they get its skeleton for free.
- [x] Asset cuts, part 1 (2026-09-30): the sources moved to assets-src/
      (~12 MB no longer shipped); the pack drops the unarmed test clips
      (--unarmed keeps them) and soldier3 (--skip): soldiers.glb 2.63 → 2.12 MB.
- [x] soldier1's colour map is KTX2 (2026-09-30): from YOUR
      originalsoldier_compressed.glb (the body Mixamo was given, KTX2 like the
      ALN ones) via `--rig-texture originalsoldier` — checked, not trusted:
      shape identical (0.00 cm), UVs identical (worst 0.0000, seam-aware);
      the rig keeps Mixamo's mesh and weights. 342 KB PNG (512²) → 141 KB
      KTX2 (1024², sharper): soldiers.glb 2.12 → 1.92 MB. Every French look
      checked in Chrome (the hue recolour reads the KTX2 colours fine).
- [ ] Asset cuts, later: lower-poly crowd version (~1.5k tris; skin cost =
      verts × soldiers) if the GPU ever asks; trim the two 8 s idles.
- [x] ONE CROWD PER BODY (2026-09-30, checked in Chrome, both games):
      appelé, sapeur, para, légion share soldier1's crowd — one GLB parse, one
      clip bake, one skinning dispatch, one skin buffer, ONE set of pieces
      (82 piece meshes, was 101), one x-ray; each type's LOOK is a view (a mesh
      over its range of the crowd, own shader: crowdSkinning view()). Crowds
      6 → 3 (soldier1, aln1, aln2). The 160 cap is now per type but POOLED:
      312 appelés drawn (was 160). Corpses and static figures ride lane 2+ in
      the anim record → no silhouette. Frame time unchanged (it was never the
      renderer: see the MEASURED table above — the sim is the wall).

## NOTE FROM THE NAM SESSION — 2026-09-28: cloud shadows in games
- [ ] Read this before the next Sky Pro commit. cloudShadowsLite's sampler-free
      4-textureLoad read cost nam 1.2-1.6 ms (0.14 before, same camera, gpuAB);
      about 1 ms of that stayed even at darkness 0. It now has a `sampled` path
      (one linear-filtered read). worldEnvironment picks it for a GAME whose
      BOOT skyMode is not "skypro". The editor and alg-rts `?sky=pro` (boot
      skyMode "skypro") keep your load path and setMap, unchanged. A sampled
      game that switches into Sky Pro later gets a console warning and keeps
      the baked field (its map is NEAREST half-float and can't use the linear
      sampler slot).

## YOUR ASKS — 2026-09-27

- [x] **Searchlight tower** (steel lattice, railed platform, caged ladder,
      generator shed; the lamp its own mesh, `userData.lamp` with a `beam`
      origin, to sweep at night; 2.2k tris) and **SAS post** (2.8k tris).
- [x] **SAS post = the French lever on a HAMLET, not a forward base**
      (decided 2026-09-27 — you weren't sure; history says the SAS were
      civil-military posts IN villages: school, free clinic, the officer
      who ran the douar). Built beside a hamlet; raises French support
      there, reveals ALN buildings nearby; reinforcing there is a small
      extra. Whitewashed house + veranda, "S.A.S." over the school door,
      a medical cross over the clinic's, walled yard, well, water tank,
      cloth tricolour, sandbagged corner, radio mast.
- [x] **Buildings must clear the map's vegetation under them** (seen: the
      oasis palms grow through the SAS post in the showroom). The SAS post
      cleared only its HOUSE (userData.clearRects) — the yard kept the
      oasis's palms and grass. Now its whole walled compound (2026-09-29;
      measured: no foliage density left inside). Still to do when the
      player builds: the build system clears the footprint on placing.
- [x] **The shiny texture = "Valley soil"** (`brown_mud_dry`, the base
      layer under most of the map; your screenshot). Its roughness map sits
      ~0.5 — glossy for dirt — so the Aurès sun laid a silvery satin sheen
      over whole slopes. Now roughStr 0 (a flat 0.88, matte), normalStr 0.5,
      and its tile twice as big (uvScale 128 → 64: ~16 m, was ~8 m, the
      "Y" marks repeated every few metres). Saved in alg-aures.v3proj.
      Lesson: I looked at pebbles and cliffs; it was the GROUND everywhere.
- [ ] Tiling still shows at full zoom-out: the far tile (farBlend, ×5)
      blends albedo only. A proper anti-tiling (stochastic / rotated
      second sample) for the base layer if it still reads as a pattern.
- [x] **Windsock in the wind** (algWind.js): ONE shared wind (direction,
      strength, gusts) drives the flags AND the sock. The sock turns into
      the wind with a lag, fills and lifts with the speed, hangs limp at 0,
      flutters toward the tail; ~450 verts on the CPU. Dev panel → Wind.
      v2 after your look: it JITTERED in gusts — the flutter phase was
      time × speed, so every speed change jumped the phase; now accumulated
      phases on a low-passed speed (measured at full gusts: tail steps
      ~8 mm/frame, step change ≤1.2 mm). Bands were blurry vertex colours
      on 8 rings; now a crisp striped nylon texture (weave, stitched band
      edges), 16 rings.
- [x] **Replace the "Wadi bed" texture** (you: `dry_river_pebbles` fakes
      stones — big painted cobbles, and it looks wrong). 2026-09-30:
      `rocky_trail` (Poly Haven CC0, fine gravel in sand), a ~4 m tile,
      tint #f4ece0 — in the map and in algWadi.mjs; the wadi stones take the
      same photo. (`rocks_ground_02` was browner, muddy: not used.)
- [x] (Done above, algWind.js.) **Windsock that moves with the wind, like the flags** (you). Cheap: one
      small mesh. Better as a VERTEX-animated cone than a cloth sim — it
      swings to the wind direction, fills and droops with wind speed,
      flutters at the tail — and shares ONE wind (direction + strength)
      with the flags, smoke and, later, the sandstorm.
- [ ] **FILL THE MAP** once buildings and vehicles are done (you): see
      "SUGGESTIONS — look & world" below, the first block.

## UNITS & UI — started 2026-09-27 (your go)

Decisions (you): nam's soldiers as STAND-INS (you will replace them);
share only the machinery (selection, orders, nav, sim, combat) in
games/shared-rts; this game's UI is its OWN files from day one (starts as
a copy of nam's layout, redesigned later). Production buildings open:
the post's gate swings, vehicles roll out of the motor pool, helicopters
lift off the pad; the ALN comes out of the cave mouth.

0. [x] **Machinery moved to games/shared-rts** (2026-09-27): navGrid,
       spatialGrid, units, unitRenderer, crowdSkinning, xraySilhouette,
       terrainDrape, teams, thumbnails, healthBar, selectionRingField,
       selection, simClock. units + unitRenderer now take the game's unit
       list (`types`, `typeKeys`, `procedural`); nam keeps thin wrappers that
       pass its own, so nam is unchanged (checked in its page: 34 units, paths,
       selection, HUD, no errors; fast lane green).
1. [x] Nav grid for alg-aures: shared createNavGrid + every showroom
       building's footprint stamped (28; vehicles excluded). **TODO**: the
       dechra is stamped whole — its lanes should be walkable; the post's
       courtyard too (gate open → walk in).
2. [x] Select + move: a section of 12 appelés (algUnitTypes.js, nam's
       soldier as STAND-IN model) musters out of the post's gate; drag-select
       + right-click move tested with real pointer events: 12 selected, all
       moved 50 m and formed up, around the post not through it.
3. [x] HUD + command card — Algeria's OWN files in games/alg-rts/ui/
       (hudBar, unitBar, commandCard, minimap), day-one copies of nam's to
       redesign later. Minimap on from the start (the post's radio mast),
       in Aurès colours. Control groups (Ctrl+1–9) moved to shared-rts.
       nam checked after the move: loads, 34 units, HUD, no errors.
       Still nam's in the copies: the command card's structure labels
       (radio/relay/enemy base), the HUD's olive/brass styling.
4. [x] Production: gate opens/closes as units march out (algPost.js).
       The post is a selectable structure (an invisible pick box over its
       footprint, so a click in the open courtyard counts); command card
       "Appelé", 6 s each, queue of 8. The gate leaves (real hinged parts
       of rtsFrenchPost.js now, both z-fight tests) swing open at 80% of a
       man's build, he walks out as a ghost to the rally point, and they
       shut 3.5 s after the last one. Tested: 3 queued → 3 out, 6 s apart.
       Selected, the post gets nam's CORNER BRACKETS round its footprint
       (square buildings brackets, round ones and units rings — you,
       2026-09-27); selectionFrameField.js moved to shared-rts.
4b. [x] Vehicles are units (behaviour = nam's for now, you 2026-09-27):
       the six parked showroom pieces (Willys, GMC, half-track, AMX-13, EBR,
       Alouette) spawn as units where they stood, in French paint. Each
       plays like its nam counterpart (numbers copied, named in
       algUnitTypes.js). Tested: click-select, box-select, right-click move
       (half-track 39 m), unit bar thumbnails, no console errors.
       Fixed on the way, nam too: every vehicle type shared ONE running-gear
       odometer (indexed per instance → jeep #0 and tank #0 wrote one slot);
       now one per type (rtsRunningGearMaterial `channel`).
4c. [x] The MOTOR POOL produces vehicles through its own doors (2026-09-27).
       Its right bay is now the GARAGE BAY: two corrugated leaves on steel
       frames, hinged on the columns, swinging OUT (userData.gate, as the
       post; both z-fight tests), a lintel over them. The bay was cleared:
       bench to bay 2's back wall, tyres and drums out on the apron by the
       left end. Bays 1-2 stay open (the ramps and the hoist are the look).
       The post's code became algProducer.js, one producer for both (and any
       later); what each builds is PRODUCTION in algUnits.js: the post
       appelés (6 s), the motor pool Willys 10 s, GMC 12, half-track 16,
       EBR 20, AMX-13 24 — no costs yet. Tested: selected, 5 buttons, Willys
       + GMC queued → doors open at 80%, both out, doors shut; post still
       fine; console clean.
       Then (you: "doors on a building open to the side look weird"): the
       garage bay is now CLOSED — a corrugated partition against the open
       shed and the same cladding outside the end columns, sheets to the tie
       and a flat gable to the roof. A closed garage with doors, built onto
       the open maintenance shed.
4d. [x] BUILDING PORTRAITS, as nam's (structureThumbnails.js): the post and the
       motor pool baked into the units' thumbnail map ("struct:<typeKey>"),
       built by the showroom's kitView (French paint, markings, doors shut),
       turned so their FRONT meets the portrait camera at 3/4. The post frames
       only its walls (shared baker: optional per-item `frame(box)`), or the
       23 m mast and the wire made it a speck. Every new building gets a line
       in ITEMS.
4e. [x] The HELIPAD produces the Alouette (30 s): it appears on the H, sits
       while its rotor SPOOLS UP (2.2 s, rotorSpin 0→1), rises off the DECK
       (not the ground under it), then flies to a holding point off the pad,
       where the next one takes off (measured: 0-2 s on the deck, 2.5 s +1.4
       m, 4.5 s at hover 35 m away). Shared units.launch(dur, {hold, fromY})
       + the renderer reading rotorSpin; nam's call is unchanged. The
       Alouette parked at the start moves off the pad too. Portrait baked.
4f. [x] THE ALN'S CAVE MOUTH produces moudjahidine (4 s each, team enemy).
       A fighter appears deep in the tunnel, in the dark, and walks out
       through the gap the breastwork leaves; the band gathers 22 m out
       TOWARD THE VALLEY (straight out of the mouth ran them to the plateau's
       edge — the camp is in a corner of the map). The tunnel is the gate.
       No AI yet: Dev panel → ALN → "Send out a band (5)".
       The moudjahid: same stand-in model as the appelé, DYED dun-brown
       (`crowdTint`, one per type — no cost per man); minimap blips of the
       enemy now red (were blue).
       Two shared fixes it needed (nam benefits too):
       · TWO CROWDS DREW ONE BUFFER: a second crowd built from the same
         model had a node graph identical but for its storage buffer; three
         keyed them as ONE program, so the moudjahid mesh drew the appelés'
         first 3 skinned soldiers (on top of them — invisible). Each crowd
         material (and its x-ray) now has its own customProgramCacheKey.
         nam has 6 crowds; checked after: soldiers render, 34 units.
       · AN EMPTY CROWD COSTS NOTHING: the skinning dispatch is sized to
         capacity (160 soldiers) and ran every frame even with no one in it;
         now no upload, no dispatch, no draw at 0 (measured: 61 dispatches/s
         before any fighter, 122 with both crowds live).
   - [ ] Measure one crowd's GPU ms with the tab FOCUSED (the numbers taken
         here were poisoned: an empty queue took 46 ms in a background tab).
   - [x] THE ALN AI (2026-09-28, algAI.js) — hit and run, this game's own.
         A band GATHERS at the cave (4-7, the cave's queue), picks French
         troops out in the OPEN (away from the post first), finds an AMBUSH
         spot 40-65 m from them on its own side (scrub, tall plants, high
         ground), APPROACHES holding fire, WAITS until they come within 32 m
         (or goes in after a minute if they are near), STRIKES 12-22 s,
         breaks off at 40% losses or French armour within 55 m, WITHDRAWS
         holding fire into the cave mouth and goes to ground (they vanish;
         they count toward the next band). First band ~45 s, then every
         80-140 s, max 18 fighters out. Dev → ALN: AI on, a band now, bands
         readout. ?ai=0 = without.
         Measured (headless, 240 s sim): a 6-man band gathered in 27 s,
         lay up 40-65 m from a 4-man patrol, went in after its minute,
         killed the patrol in ~6 s losing one, withdrew; a second band
         was lying in wait, a third gathering.
         Fixed on the way: a man stuck without a route dragged the band's
         CENTRE 100 m back and it never "arrived" — arrival is now 60% of
         the band at the spot; a straggler is re-ordered once, then sent
         home.
   - [ ] **you, look / taste**: the ambush in real time (Dev → ALN → "A band
         now", send a few appelés out toward the cave). Balance: a 4-man
         patrol lasted ~6 s — the numbers are still nam's.
   - [ ] They vanish at the mouth's threshold, not inside it: walk in (a
         ghost walk into the tunnel, as `emerge` backwards).
   - [ ] With no French out in the open they harass the post (ambush spots
         60 m+ from it): mines on the track and hamlets (SAS) instead.
   - [x] **COVER ROUTES (2026-10-02, algAI coverRoute)**: A* on a 12 m grid
         round both ends, priced by MG reach, sight of known French, crests,
         against concealment and LOW ground; waypoints every ~48 m walked in
         turn. 1-6 ms a plan. Measured vs the straight line: 10-15% more
         concealment, 0.3-0.7 m lower than the ground round, 5-15% longer.
   - (was) Routes: bands go straight at their spot; hug the gullies and scrub
         (a path cost for exposure) — the approach IS the ambush.
4g. [x] COMBAT (2026-09-27, algCombat.js). nam's fighting machinery moved to
       games/shared-rts (nam keeps re-export shims): combat.js (acquire,
       chase, fire, damage, death; "a man on foot" now reads `type.foot`,
       was nam's "soldier"), projectiles.js (visible rounds by `weapon`:
       rifle, mg, cannon, gunship), tracerField, spriteField, bloom,
       combatFx (muzzle flashes, impacts, blasts), explosionField,
       flameField (burning wrecks), craterSystem (scorch marks). Blasts
       flush the birds; every shot puts up standing storks.
       Tested: 12 appelés vs 5 moudjahidine → all 5 dead in ~200 steps, the
       French scratched; a second band met by the vehicles' guns (fires,
       craters). nam after the move: loads, its soldiers kill 4 test
       enemies, no errors.
   - [x] BUILDINGS AT WAR (2026-09-28, algStructures.js): all ten placed
         buildings are combat structures. French: the post (its two tower
         MGs — rtsFrenchPost `userData.towerGuns` — each fires from the
         tower nearer its target), motor pool, helipad, mirador (MG), MG
         nest (the gun traverses), the 81 mm MORTAR PIT (arcs 25-120 m,
         splash; cover does not help), searchlight. ALN: the cave, the arms
         cache, the sangar (MG, traverses). A hit building shows its bar;
         at 0 it goes up (blast, fire, crater) and stays a WRECK — charred
         (its own darkened material), gun drooped, burning 30-60 s. A
         wrecked producer stops and refuses orders (a dead cave = no bands).
         Yours are selectable (brackets); the ALN's right-click to attack.
         Tested: 6 ALN 34 m from the MG nest → the nest (11 bursts), the
         mortar and the appelés killed them in 10 s; 8 ALN ordered at the
         post → its towers fired 21 bursts (+ the Alouette, the armour),
         the post took 24 damage; the arms cache wrecked (charred, burning).
   - [ ] Portraits for the new structures (mirador, MG nest, mortar,
         searchlight, cache, sangar) in structureThumbnails.js.
   - [ ] A real wreck shape (roof fallen, walls broken) instead of charring.
   - [x] **Line of sight for FIRE** (2026-09-29, algSight.js; shared
         combat.js `blocksSight`, nam passes none): the GROUND (heightmap,
         every 2 m, eye 1.6 m / 2.2 m vehicles → chest) and TALL buildings
         (> 2 m above the ground, baked at load: a BVH per placed piece and a
         vertical ray every 2 m — 29 pieces, 934 cells, 79 ms) stop a shot.
         Low walls, sandbags, terraces stay COVER, not blockers (you shoot
         over them). An auto target out of sight is dropped; an explicit
         attack order MOVES to get a line (measured: round the mechta, a
         line in 7.5 s). Measured: every dechra row blocks, the mechta
         blocks, a garden wall doesn't; ground blocks 12% of 20-60 m lines
         in the valley, 28% round the dechra, 40% in the massif. 2 µs a
         query. `?los=0` to A/B.
   - [ ] **you, play it**: does the massif (40% blocked) feel like the
         ALN's country, or too cluttered to fight in?
   - [x] **SKY PRO is the default** (you, 2026-09-29): algGame.js SKY_PRO
         unless `?sky=atmosphere` (the old sky + its tuned Aurès light, to
         A/B). Boots clean, cloud shadows on.
   - [x] Dev → **Sky** (2026-09-29, devPanel.js): presets (Clear, Partly
         cloudy, Broken, Overcast, Dust: cover + cirrus + haze), time of day,
         cloud cover, cirrus and its height, cloud shadows (Sky Pro's own map:
         engine cloudShadowsLite `mapOn`, the baked field's `enabled` never
         covered it), the clouds FOLLOW the game's one wind (Dev → Wind; drift
         = 4 + 24 × strength m/s) unless you move the drift, haze, sun shafts,
         god rays, exposure, ground light, Copy values. Light keeps only the
         grade under Sky Pro (its sun sliders drive the Atmosphere sky).
   - [ ] **you, look**: pick a preset / values, Copy, and I'll bake them in as
         the game's look (today: Sky Pro's defaults, "Partly cloudy").
   - [ ] Re-judge the Aurès look under Sky Pro (it brings its own sun and
         haze); GPU ms A/B against `?sky=atmosphere` in a focused tab.
   - [x] **FAR TERRAIN** (you, 2026-09-29: "the flat view is only good if
         there is an ocean"; "should be coherent with the satellite terrain";
         "for the editor too"). An ENGINE feature (v3/terrain/farTerrain.js):
         a project can carry a far heightmap (manifest.farTerrain + blob
         "farHeight"), and the TERRAIN ITSELF draws it past the heightmap —
         same shader, layers, blend, lighting, haze: no seam (a separate
         backdrop mesh was tried twice and never matched: "completely wrong
         texture", "bad tiling"). Height blended from the map's own edge over
         250 m and stood up ×2.5 with distance; normal from the far ground;
         paint by a slope/height RULE into chosen slots (splatOverlayTsl);
         two extra clipmap rings (±4 km) only while it's on; the far grid read
         with textureLoad (no sampler: the terrain is at 16). Editor: World →
         Far Terrain (on/off, blend, stand, the rule's slots and bands); saved
         with the project; nam unchanged (none). Cost below noise (free cam
         8.67 vs 8.93 ms off, noise 0.4).
         tools/algMountains.mjs: the ring outside PLAY is YOUR ERODED SAVE again
         (alg-aures.v3proj.bak × 0.6019, rms 0.64 m — the border fade undone,
         the wadis leave through gaps); the far grid is the real DEM round the
         site (30.5 km, the same transform, fitted), NOT eroded (Stream Power on
         the coarse grid made staircases). tools/lib/terrarium.mjs shared with
         algDem.mjs. Vegetation's height bands pinned; outside PLAY thinned.
   - [ ] **you, look**: from the play camera and the free camera; the stand
         (×2.5) and the rule's bands are the taste knobs (World → Far Terrain).
   - [ ] The map grew 7.0 → 11.0 MB (the far grid is 4 MB of Float32): store
         it as 16-bit or at 512² if the size matters.
   - [ ] Far terrain has no vegetation, no cloud-shadow bake difference
         checked, and getWorldHeight() still reads 0 out there (nothing walks
         there; a free camera can dip into it).
   - [x] COVER AND CONCEALMENT (2026-09-28, algCover.js). nam's rule moved
         to games/shared-rts (cover.js + coverOverlay.js; nam keeps shims):
         concealment stops you being SEEN (acquire range), cover stops you
         being HURT (from its side), firing reveals a hidden man for 4 s.
         Per game: `params` and `extra` obstacles; new `concealCeil` (nam 1).
         The Aurès: MEASURED 82.5% of walkable ground has no vegetation,
         scrub 0.5-0.6 → concealment from 0.2, full at 0.65 (the thickest
         scrub: seen at 40% range); 14.2% of the ground conceals. Cover from
         the placed pieces (no rock props on this map): HARD for stone and
         sandbags, none for wire, brush screens, thorn pens, pads. Big
         buildings stamp cover along their WALLS only (tiled over the
         footprint, a man 35 m in front of the gate had cover 0.94 in the
         open). The ALN AI now scores ambush spots with the same rule.
         V = the overlay (green cover, cyan concealment; Dev → Navigation →
         pin). Tested: a band in the scrub vs 4 appelés lost 1, in the open 2.
   - [x] (2026-09-29, shared cover.js terrainCover) Terrain cover: wadi banks, ridge crests, gully floors — the Aurès'
         real cover is the ground itself (no rock props yet either).
   - [ ] Cedars and palms: their trunks as cover in the groves.
   - [x] FOG OF WAR (2026-09-28): nam's vision grid moved to games/shared-rts
         (fogOfWar.js; nam keeps a shim), an entity may carry its own
         `vision`. What the French see: units by type (appelé 42 m,
         Alouette 72 m), buildings by kind (mirador 110 m, searchlight 100,
         post 90, MG nest 55…). Outside it the ALN is not drawn; their
         buildings stay hidden until first seen. The minimap's shroud is
         turned with the map (the canvas transform of the CoH frame). The
         fog banks go BEFORE it in the post chain (algFog rehook), as nam.
         OFF by default while the map is being built, as nam: Dev →
         Navigation → Fog of war, or `?fow=1`.
         Tested: ?fow=1 → the post's ground clear, the rest shrouded, the
         cave hidden; an ALN man out of sight not drawn, one next to the
         appelés drawn (and shot). nam: loads, its fog of war works.
   - [x] (2026-10-01: ON by default, ?fow=0 off) **you**: fog of war ON by default once the map is built?
   - [x] (2026-10-01: ridgeLOS) Line of sight for vision (ridges hide the far side), as for fire.
   - [x] (2026-09-30: algSounds.js) Sound (nam's recordings are there: rifle, MG, cannon, Huey…).
4h. [x] N shows the NAV GRID (as nam), and Dev → Navigation → "Nav grid (N)".
   - [x] (STALE, checked 2026-10-01: both show their bar when hurt or selected; the helipad is a producer) The post and the motor pool have no health bar yet; the helipad
         (the Alouette lands and takes off) and the other buildings are not
         selectable yet. Set rally by right-click with a building selected.
   - [ ] A vehicle appears INSIDE the open bay (as the man in the
         courtyard): a fade-in, or the doors hiding it, if it reads wrong.
       Minimap turned the CoH way: up = the start camera's forward (VIEW_YAW,
       toward the ALN), our post at the bottom. The world square is diagonal
       to that view, so it reads as a diamond; the view is a trapezoid
       (far edge capped at 2.5x the near one), not a wedge to the horizon.
   - [x] (STALE, done 2026-09-27 91d2f47: a jeep rolled out of the doors in the 2026-10-01 check) Next: vehicles as units (motor pool rolls them out through its
         own doors, helipad helicopters), set-rally-point by right-click,
         and the HQ/post card's own labels (still nam's).
   - [x] (2026-10-01: the minimap IS the diamond now, 236 px) Minimap diamond uses 71% of the square — if it reads too small,
         a rotated square map crop (cut the far corners) is the other way.
5. [~] Animals alongside: donkeys — DONE 2026-09-29 (see ALGERIAN DONKEY
       below); on the tracks (walking between villages) still to do;
       chickens (Chicken_001_compressed.glb) in the mechta yards
- [~] **HENS — white, speckled, black** (you, 2026-10-01: the pack's brown
      hen won't read on our ochre map). v3/props/birdMorph.js + the new
      v3/bird-lab.html (ochre ground): the chicken's texture is read once
      (KTX2 transcoded to plain RGBA — the GLB's BC7 can't be read back) into
      one colour per face, sorted by class — feathers, comb (bright red only:
      a looser rule took the red-brown neck), beak/legs, eyes — and repainted
      per kind. Same skeleton and 3 clips (idle, walk, run); crowd format.
      Not in the game yet.
   - [x] you approved them (2026-10-01).
   - [x] (2026-10-01, algHens.js) In the mechta yards — mostly white, a few speckled / black (the
         game chat places them: createBirdTemplate on the crowd path).
   - [ ] More birds from the chicken: Barbary partridge (scrub slopes,
         flushes), turkey / guinea fowl (yards), white stork (roofs).
- [~] **Camel** — being built in v3/sheep-lab.html ("camel-morph", 2026-09-27):
      the pack's DONKEY mesh reshaped into an Arabian camel (hump, S-neck,
      pads), same quad look, plays the donkey's 13 clips. Saharan edge more
      than the Aurès. Not in the game yet.
- [~] **STRIPED HYENA** (you, 2026-09-28; "hyena-morph" in v3/sheep-lab.html):
      built from the pack's HUSKY (same rig as the donkey: paws, dog head,
      carnivore gait) through the same morph builder. Round 2 after photos of
      Hyaena hyaena (you: "stripes don't look right at all, doesn't look like
      a hyena"): head carried LOW (neck bent 30 deg), sloping back (hind legs
      0.7, spine pitched 14.5 deg, all four paws on the ground in the walk),
      smaller narrow head with a longer muzzle, big ears, mane along neck and
      back, bushy hanging tail, warm buff coat, 10 thin leaning stripes
      PLANE-SLICED into the mesh (clean bands, still closed), banded lower
      legs, dark muzzle, black throat. 0 open edges, 0 flips. Not in the game.
   - [ ] **you, look** at it in the lab (face, ears, stripes, mane).
   - [ ] Where it lives in the game (night scavenger near the mechtas?
         flees soldiers like the herds).
- [~] **DORCAS GAZELLE** (you, 2026-09-29; "gazelle-morph" in the lab, not
      in the game yet): from the pack's DEER (same rig), compared against
      Wikipedia photos. Slim, long legs, long slender neck, narrow muzzle,
      big pale-lined ears, ringed black LYRE horns, warm fawn with a rufous
      flank band (plane-sliced), white belly + rump, black tail tip, face
      stripes (white above / dark below the eye line), rufous forehead.
      0 open edges. See-through scan: Idle 0, Walk 1, Eating 1, Gallop 21 px
      — the gallop's are where a leg crosses the body (armpit fold): the
      magenta view at the gallop shows no hole. Face (2026-09-30): white
      stripe over the dark one, eye to nose (only SIDEWAYS faces: the deer's
      coarse bridge otherwise made a white bar across the face). Real size
      ~0.6 m at the shoulder (x1.3 in the game, like every animal).
   - [ ] **you, look** in the lab; then in the game: small groups on the
         open, dry ground toward the south edge (the Saharan side), bolting
         like the herds — needs the deer loaded (initAnimalMorph(donkey,
         { deer })) in algHerds.js.
- [~] **ALGERIAN DONKEY** ("donkey-morph" in the lab, 2026-09-28): the pack's
      donkey untouched in shape and clips, recoloured as a North African
      village donkey — ash grey-brown, pale muzzle / eye rings / belly, dark
      mane, ear tips and tail tuft, a dark DORSAL STRIPE and SHOULDER CROSS
      plane-sliced into the mesh (clean bands). Presets: Aurès grey, Brown,
      Pale dun (DONKEY_PRESETS).
   - [x] LOAD (PDK.load "panniers", default): a kilim blanket (deep red,
         ochre / black end borders, cream lower border, a rope over it) as a
         shell over the back — sliced edges, closed rim — and two woven
         baskets (straw bands, rim, load inside) LEANING on the flanks
         (measured body width top → bottom). Part of the donkey's mesh (one
         draw), skinned to the back: rides through every clip. 0 open edges.
   - [x] IN THE GAME (2026-09-29, algHerds.js): 3-4 tied just outside each
         village's walls and 2 at each spring — 13 donkeys, ~1/3 loaded
         (you: "only few of them carry"); two crowd draws (bare / loaded).
         Working animals: they graze on a 3 m rope and never bolt from
         soldiers (shared herd: new `bolt` / `roam` options, defaults keep
         nam, sheep and goats unchanged).
   - [ ] **you, look** in the game; then more loads (jars, firewood, sacks),
         the other coats (Brown / Pale dun) as extra templates, donkeys
         walking the tracks between villages, a lab toggle for load / preset.
- [x] **GOAT: gap on top of the head while EATING** (you, 2026-09-29) — FIXED
      268553d: the poll was skinned to the ear bone; now Head + a smoothed
      head/neck seam (Eating 371 → ~0 see-through px, Gallop 342 → 28).
- [x] **GOAT: a thin see-through slit low on the body while walking** (you,
      2026-09-28) — SOLVED in the sheep lab (you, 2026-09-29: "we spent many
      times on it"). This entry was stale; do not reopen the goat.
- [ ] **LATER — dressed animals: camels AND donkeys carrying things** (you,
      2026-09-27; your reference: a caravan camel with a striped saddle
      blanket, a wooden saddle, woven baskets and jars hung on the flanks,
      a bridle with tassels and a lead rope). Rigid pieces on the back /
      neck bones, one draw per animal; variants: caravan, pack, ridden.
- [x] **SHEEP AND GOAT FLOCKS** (2026-09-27, algHerds.js): mixed flocks
      (~12 sheep + ~6 goats, lambs and kids among them) on 5 pastures —
      both mechtas, the dechra's slope, both springs; outside the walls, the
      water and 90 m from the post and the katiba; goats take steeper ground.
      They graze, wander and BOLT from soldiers (the shared herd, as nam's
      deer). The animals are the pack's donkey reshaped
      (v3/props/animalMorph.js — the SAME builder the lab uses, so tuning in
      v3/sheep-lab.html is what the game gets). 59 sheep + 28 goats, one GPU
      crowd draw per kind; builds in ~4.5 s at boot. `?herds=0` = without.
   - [ ] **you, look** at them in the game (colours under the Aurès sun: the
         sheep is a Hamra-like white fleece with a red-brown face).
   - [ ] Boot cost ~4.5 s: cache the built templates (or build them in a
         worker) if load time matters.
   - [ ] A shepherd with each flock (a man or a boy walking with it), dogs.
   - [ ] The flock keeps together when it bolts (now each animal runs its
         own way, like deer).
- [x] **BIRDS** (2026-09-27, algBirds.js). nam's bird system moved to
      games/shared-rts: rtsBirds.js (flocks, stands, flushes, circling,
      one draw + one for the shadows) and birdKit.js (the shape pieces);
      each game passes its own species. nam's wrapper keeps nam identical
      (its bird geometry fingerprint unchanged; 21 birds live after).
      Sand & Blood's: WHITE STORKS (white, black flight feathers, the neck
      held out, red bill and legs) crossing in loose Vs and landing in the
      open fields and at the oasis (382 open spots found — this map is
      open); CROWS; GRIFFON VULTURES (2.6 m, tawny, six fingers, gliding
      9/10) circling for good 42-52 m up (the camera is 9-110 m: at 80-100
      they were above it, never seen) over the katiba, the Kef and
      the cedar spring; a STORK'S NEST on the dechra's minaret (a twig bowl
      round the finial, part of the dechra: no extra draw) with the pair on
      it, one standing, one brooding. Birds lift off for men on foot, jeeps,
      helicopters (the shared threat test now reads `type.foot`).
   - [ ] **you, look**: storks crossing (Dev: `__ALG.algBirds.spawnTransit("stork")`),
         the minaret nest, the vultures over the katiba.
   - [ ] Sparrow flocks bursting out of the gardens and palms (a small
         species; flushed by shots once combat exists — `birds.flush`).
   - [ ] At close zoom a flock can fly at the camera's height and a bird
         pass the lens (cruise 20-32 m): cap the cruise under the camera.
   - [ ] Storks on the koubba and the SAS post roof too, and a mate that
         circles the nest now and then.

## FILLING THE MAP — foliage first, then villages (started 2026-09-27)

Order: foliage → villages → animals & birds → ground detail.

- [x] **Date palms as GROVES** (you: "different trunk shapes, some curved").
      palmGeometry.js grew `trunks` (a clump from one root, clumpStems):
      a tall upright/leaning trunk, others curving out of the ground and
      rising, sweeping over, S-bent; often a young offshoot with its crown
      on the ground. `fruit: "dates"` hangs bunches instead of coconuts.
      New preset `dateGrove` (3 trunks); the oasis slot uses it
      (tools/algVegetation.mjs). Single palms (nam) unchanged — same code
      path and random stream when `trunks` is unset.
      First pass curved too hard from one point: a grove read as a vase of
      spider legs; now gentler and spread apart.
- [x] **Palm leaves greener** (you: grey-green, flat): date palms now
      #2c4c22 → #6f9a3c, deeper V-fold (38 → 50°), more sun through.
      **you**: judge the green — close up it may now be a touch lime.
- [x] **Oasis reeds** in desert colours (olive, straw tips, dark brown
      heads) — overridden in algVegetation.mjs only; nam's typha unchanged.
- [x] **No tree inside a building**: the showroom clears the painted
      plants under every piece (`app.clearVegetation`, tiled over its
      footprint or its own `userData.clearRects`). The SAS post clears only
      the house + veranda, so its garden palm stays. The build system must
      do the same when it places.
- [x] **Fog** (you: nam's fogs here?): the FOG BANKS (raymarched volume
      mist at places) moved to games/shared-rts/fogBanks.js + its panel;
      nam keeps its own siting and is unchanged (checked in its page). Here
      (algFog.js): 8 banks — both oases, three stretches of each wadi — and
      WEATHER presets that set time, banks, ground fog and far haze at once:
      Clear afternoon · Dawn mist (07:30, white in the hollows) · Dust haze
      (ochre). Dev → Weather & fog, Dev → Fog banks. +0.4 ms GPU with banks.
- [ ] Weather next: the SANDSTORM as a fourth preset (dust wall rolling in
      on the shared wind); fog banks drift WITH the shared wind.
- [ ] Light panel's time slider doesn't follow a weather change.
- [x] **Shape variants** (engine, 2026-09-27): ScatterField `variants` —
      each plant picks a variant by its own hash, each variant its own mesh
      grown from another seed. `startV3App({ tallPlantVariants: 3 })`; this
      game asks for 3 (`?variants=1` to A/B). Default 1 = unchanged (nam,
      editor). MEASURED over the oasis: 1.08 ms → 1.10 ms.
- [x] **Single date palms**: `trunksByVariant: [3, 2, 1]` — the date-grove
      slot's variants are a clump of 3, a pair and a lone palm leaning hard.
- [x] **Oleander** on the wadi banks (the cane-clump builder + new
      `flowers`: pink clusters at the cane tops, kept on the far level).
      First pass read as pink flowers on sticks; now denser, darker, smaller
      flowers. **you**: judge the size/density at play zoom.
- [x] **Tamarisk** behind the oleander and round the oases (grey-green).
- [x] **Prickly pear** hedges round the hamlets — a new builder
      (buildOpuntia: tiers of flat oval pads from pad rims).
- [x] **Dev → Fog = nam's** (you): Model (Analytic / Valley band / Monsoon)
      with each model's own rows, Height fog, Color, Dist. fog, Dist.
      density; Post-FX section as nam's. Weather presets and Fog banks stay.
- [x] **Wind on the ground plants** (you: reeds and oleander were frozen):
      the engine ships foliage wind OFF ("judged at rest"); the map now turns
      it on (algVegetation.mjs), and the game's one wind (algWind.js) now
      drives the grass/plant wind too (new `app.setWind`). Flags, windsock and
      plants agree.
- [x] **PERF PASS 2026-09-27** (you: "optimize until 5 iterations < 5%"):
      report in the session; bench = games/alg-rts/perfBench.js (7 views,
      frame time at 2x). 368.1 → 342.2 ms summed (−7.0%), CPU 28.5 → 23.6 ms
      (−17%). Kept: bloom OFF (it drew nothing — nothing emissive yet;
      re-enable with the first tracer), fog-bank pass unhooked while the banks
      are off, unused terrain features compiled out (riverSand, grassFar,
      flowerTint), stats-gl overlay off in the game (was ~20% of the main
      thread; Dev → Performance to show it), clipmap drawn nearest-first.
      Tried, no gain, reverted/kept off: biplanar cliff (engine opt-in, off),
      plant shadows off, far-tile fade. FOUND: the terrain paint shader is
      ~70% of every view (hiding it → vsync); all 6 layers are painted. The
      real next step is structural (index-blended splat, TODO below).
- [ ] **Terrain: index-blended splat** — store the top-3 layer ids + weights
      per texel so the shader does 3 layer taps whatever the count (see memory
      proj_v3_terrain_only_static_taps). The one lever left that is big.
- [x] ~~Heading-dependent cost~~ — a MEASURING error (vsync-quantised rAF,
      a second tab open, the GPU timer). Measured properly (30 renders back
      to back, one tab): the spike was the ATLAS CEDARS, 10–14 ms at the
      massif; terrain a steady 3–4 ms everywhere.
- [x] **Cedar fix: depth pre-pass for cut-out leaf cards** (engine,
      FoliageScatterSystem `depthPrepass`, `startV3App({ foliageDepthPrepass })`,
      default off; this game on, `?prepass=0` to A/B). Cause: the cut-out
      (discard) turned off early depth, so every hidden card was fully lit.
      Now an unlit depth pass, then colour depth-EQUAL. MEASURED 1919x888,
      scene only: cedar massif 20.7 → 6.6 ms; base 6.6→6.3, oasis 7.4→6.3,
      hills 7.8→6.5, wadi/aln 5.7→5.0, zoom-out 7.2→6.3. Image identical
      (0.001% px, frozen plants). Offer it to nam (palms, jungle).
- [ ] Re-measure the earlier perf-pass changes with the correct method.
- [x] **Tracks** (2026-09-29, tools/algTracks.mjs → games/alg-rts/tracks.js):
      the PISTE out of the post's gate (beside the sandbag chicane), past the
      oasis to Mechta Ouled Ali, over the Oued Tighanimine at a ford to
      Mechta el Oued, and west along the valley floor to the dechra (~600 m);
      MULE PATHS dechra → koubba, dechra → west gully mouth → katiba, Ouled
      Ali → east gully mouth → katiba (~800 m). ROUTED by A* over the real
      ground (a truck holds ≤ ~12% on the flat, fords at the fords; a mule
      climbs), round every placed piece, branches riding the trunk; a guarded
      simplify (a straight run only where it is itself a legal move — the
      unguarded one cut down a wadi bank at 235%). PAINT: slot 6 (was the
      unused Snow, same textures bound → no sampler added) = "Dirt track",
      dry_mud_field_001 tinted pale; DECALS: 104 photographic ruts / foot-worn
      paths baked on the same dust photo (decalPhotoArt `photo`/`tileM`
      overrides), laid along each 10 m chord, none on tight bends, uneven
      strength and gaps (full-strength ruts read as rails). Vegetation keeps
      slot 6 bare (algVegetation.mjs). Minimap draws them (piste pale, mule
      paths dashed). The ALN's ROAD AMBUSH: French on a track → the band lies
      up 15-45 m off THAT track (measured 19/20 and 15/20 spots in the band).
      Plan: `node tools/algPlanView.mjs --layout games/alg-rts/layout.js --view play`.
   - [ ] **you, look**: the piste's colour (a smooth tan band — paler?),
         the ruts' strength, the mule paths (faint by design).
   - [x] (2026-10-01, algPoles.js) Telegraph poles along the piste (a kit piece; the post's radio
         mast is the only wire today).
   - [x] (2026-09-29, algPatrols.js + algMines.js; the sapper still open) Patrol order ALONG a track; convoys (GMC) on the piste; ALN mines
         on it (the sapper); donkeys on the mule paths.
   - [ ] Tracks are paint + decals only: no grading. A cut bench where the
         piste crosses a slope, if vehicles look wrong on the tilt.
- [x] **Village dressing** (2026-09-29, rtsAlgVillage.js, placed in
      showroom.js GARDENS): walled GARDENS (dry stone chest high, a gate with
      two post stones and a thorn bundle, cleared stones heaped in a corner,
      olives in loose rows / figs / mixed, a prickly-pear hedge outside the
      back and one side) ×5; almond TERRACES (dry-stone retaining walls along
      the contour, as high as the slope makes them, a row of trees per step,
      turned to climb straight uphill) ×4 — three round the dechra, one
      above Mechta el Oued; THRESHING FLOORS (a paved earth dome, a kerb of
      stones on edge, a straw heap and a fork) ×3; the wells' troughs ROUGH
      stone now (and the zeriba's); the dechra's two end lanes are STAIRS
      (risers + paving, the first try read as a ladder) and some lower-row
      houses have walled COURTYARDS (a tabouna, jars, or a fig). Spots
      MEASURED (clear of pieces, tracks, wadi beds, oases; relief / slope).
      Trees are PLANTED, not painted: a piece lists `userData.trees` / `hedge`
      and the game puts them down with placedFoliage.js (new presets olive,
      fig, almond; 60 trees, 87 prickly pears). NAV: `userData.navRects` —
      terraces and floors walkable, a garden's walls block and its gate lets
      men in. Both z-fight tests pass; 197/197 suites green.
   - [ ] **you, look**: olives (second pass: smaller, airier, trunk showing),
         figs, almonds; the threshing floor's paving (second pass: bigger
         slabs); the straw heap (reads a bit like a beehive hut?).
   - [ ] Terraces are walls on the untouched slope: grade each tread flat
         (a terrain edit) if they read wrong close up.
   - [x] **Cover from walls and ground** (2026-09-29): pieces list their
         walls (`userData.coverLines`, algCover.js) — gardens, terraces, the
         dechra's yards: HARD cover along the wall, not over the plot; the
         threshing floor none (was a false outline). TERRAIN cover (shared
         cover.js `terrainCover`, alg 0.5, nam off): the ground toward the
         shooter rising into the line of fire, sampled to 10 m — a man in a
         wadi bed 0.5 from the plain, 0 from a man on the bank above him, 0
         along the wadi (measured). Random 50 m shots over the play box:
         31% find cover (12% walls/buildings, the rest the massif's banks
         and gullies). The overlay (V) and the ALN's spot scoring see banks.
         Command card: the HARD / LIGHT COVER and CONCEALED chips.
   - [x] **Tracks at war** (2026-09-29): PATROUILLE (algPatrols.js, a
         command-card button): the nearest track in file (vehicles the
         piste), to the end and back, fights and resumes, any order ends it —
         measured 4 men within 4 m of the line, 2-5 m apart. CONVOI: a GMC
         on patrol through a French-held village delivers +30 (flash on the
         supply strip). MINES (algMines.js): the ALN's "mine" mission (~30%
         of bands) lays one on the piste far from the French (measured on the
         dechra piste, 284 m out); a vehicle over it sets it off (a GMC dies,
         a half-track limps); infantry spot it (a red stake) and clear it in
         5 s — measured spotted in 2 s, cleared by 8 s, nobody hurt.
   - [ ] **you, play it**: patrol + convoy + a mine; is 30 a delivery and
         30% of bands mining the right pace?
   - [x] **Flocks on the move + donkey trains** (2026-09-29, algHerds.js,
         shared wildHerd.js "anchor"): each flock has a MOVING HOME that
         walks a loop round its village on a sheep-legal foot path (the
         pasture, other grazing, down to the well — 4 of 5 flocks drink;
         Ain el Oued has no well in reach), resting 1-2 min at each; the
         animals keep their places round it (goats in front), catch up in
         bursts, trot when far, follow the home's breadcrumbs round houses,
         sidestep what's in the way, regroup after a bolt. Measured over 8
         minutes: median 6-7 m from their place, worst 32 m, none lost (the
         first version lost whole flocks 100 m back — five separate causes,
         each measured). A DONKEY TRAIN on each ravine mule path: a loaded
         donkey on the lead, a bare one 3.4 m behind, up to the gully mouth
         and back, resting at the ends. nam's wild herds unchanged (checked).
   - [ ] **you, look**: the flock's pace (0.45 m/s home, rests 1-2 min),
         goats leading; the trains (the west one walks under the cedars at
         the koubba, hard to see).
   - [ ] A shepherd with each flock (a civilian stand-in until yours);
         scatter at gunfire / blasts, not only soldiers close; a goat on a
         mine; bells.
   - [ ] A mine's minimap mark once spotted; the sapper (clears faster,
         finds from further); the ALN laying mines on the mule paths too.
   - [ ] Attack orders don't end a patrol (it resumes after the kill) —
         right for CoH, say if not.
   - [ ] GPU cost of the dressing: A/B said −0.07 ms, but the frame read
         0.58 ms total (this view is normally 5-7) — re-measure in a focused tab.
- [x] Doum: fix its far LOD (flat green mats) and paint it back (2026-09-30:
      it was not the LOD — see PARKED / NEXT).
- [x] **Villages** (v3/render/objects/rtsAlgVillage.js, 2026-09-27):
      DECHRA (4 terraced rows of Chaouia houses — the mechta's own `house()`
      — each on a stone socle down to the real ground; a whitewashed mosque
      with a square minaret mid-village; a stone lane up the side), KOUBBA
      (white cube, octagonal drum, dome, iron finial, green door, jars;
      a whitewashed court wall that steps with the ground), CEMETERY (low
      mounds with stone borders, upright head- and footstones, all graves
      turned toward Mecca — qibla ~108° from the Aurès), WELL (curb, forked
      posts, pulley, bucket, troughs, jars), ZERIBA (a tangle of grey thorn
      branches, the gap, trough, fodder). All pass both z-fight tests.
      Builders take `groundAt(x, z)`: the showroom's new `ground` mode seats
      each house/grave/branch on the real slope, no pad, no tilt.
      SITES MEASURED: dechra (-224, 136) on a 17° slope rising straight away
      from the player's camera; koubba on the crest 28 m above (-273, 86);
      cemetery beside it; pens clear of every piece and off the wadi bed.
      First siting was wrong: I had the camera direction reversed (the slope
      faced away from the player).
- [ ] **you, look**: the dechra, the koubba and its cemetery (Dev →
      Showroom → Go to). Taste: house density, the minaret's height.
- [x] (2026-09-29) Well troughs are plain blocks — make them rough stone.
- [x] (2026-09-29) Dechra: stepped lanes, a few courtyards. [ ] Laundry still open.
- [x] **The kit atlas stayed GREY — caught and fixed** (2026-09-27). Seen
      again live: the whole atlas canvas was still the placeholder, yet the
      worker's promise had resolved with no error, so the worker handed back a
      BLANK bitmap (its canvas under the boot's GPU load, most likely).
      rtsAtlas() now checks the pixels that landed (one read of a 4x6
      downscale, a pixel per cell) and, if blank, builds the atlas on the
      main thread instead. Fixes nam too (same atlas).

## SUGGESTIONS — look & world (not gameplay) — ranked, 2026-09-27

**1. Fill the map (the biggest visual gap: it is bare ground now)**
- Palms, several trunk SHAPES (you): straight, leaning, CURVED (the trunk
  bending up out of a lean, as date palms do by water), clumps of 2-4 from
  one root, young ones with the old frond skirt still on. Date palms in the
  oases and wadi floors, Canary palms planted at the post and the SAS post,
  doum palms as scrub on dry slopes (the doum's far LOD is still owed).
- Atlas cedar on the heights (the Aurès's signature: the Belezma and
  Chélia cedar forests), Aleppo pine and holm oak lower down.
- Oleander along every wadi — pink in flower, the most recognisable line
  in a dry Algerian valley. Tamarisk in the wadi beds.
- Prickly pear hedges round the villages and gardens; fig and olive trees
  in walled gardens; almond on terraces.
- Alfa (esparto) grass steppe on the open slopes; juniper and lentisk scrub.
- Villages: more mechtas and a DECHRA (a stone village climbing a ridge,
  flat roofs stepping down), terraced gardens, a KOUBBA (a marabout's white
  domed tomb) on a hilltop — the one white thing that isn't French — a
  cemetery of upright stones, threshing floors, a well with a trough,
  zeribas (thorn-brush animal pens).
- Animals: goat and sheep herds with a shepherd (they move, graze, flee
  shooting), donkeys and mules (packed), dogs at the villages, a few camels
  on the plain edge.
- Birds: storks nesting on the koubba and the SAS roof, kites and vultures
  circling high (their shadows cross the ground), ravens on the cliffs, a
  flock of sparrows flushing from the gardens. nam's bird system carries
  over.

**2. The ground itself**
- The shiny rock layer (above).
- Tracks: the French piste between the post and the hamlets (dust, ruts,
  telegraph poles along it), footpaths up to the ALN's side.
- Dry-stone terrace walls on the gardened slopes.
- Decals: wheel ruts, animal tracks, spent-case scatter and scorch at
  positions, dark stains under drums.

**3. Air and light**
- One shared WIND for flags, windsock, smoke, dust (above).
- Dust devils crossing the plain now and then; heat shimmer over the far
  ground at midday; dust kicked up behind every moving vehicle.
- Smoke from the mechtas' cooking fires in the morning and evening.
- Cloud shadows crossing the ground (the engine has them, opt-in).
- The sandstorm (already on the list).
- Night: stars, searchlight beams sweeping from the post, the villages'
  lamp-lit doorways, flares.

**4. Sound (ambience, not gameplay)**
- Wind over the ridges, cicadas in the heat, goat bells, dogs in the
  villages, the searchlight generator's hum at the post.

**5. Finish**
- The black band under the horizon at very high orbit (on the list).
- A far LOD for every placed asset, and the impostor for the doum.

## Decisions so far

- Same style as nam-rts for now (may change later). Same engine, same editor.
- **Terrain first.** The first map is Aurès country (red rock, cedar, dry
  riverbeds): it's the region most unlike Vietnam, and where the war began on
  1 Nov 1954. Kabylie comes second.
- Maps are cut from **real elevation**, then eroded and painted in the editor.
- Same world size and scale as nam-valley (1024 m map, MAX_HEIGHT 250,
  RTS_SCALE 1.3 for units and man-made things, nature real), so the camera,
  vegetation distances and unit sizes carry over unchanged.
- Treat the history seriously: no atrocity as a game mechanic, civilians are
  people rather than resources, show consequences through the story.

## Session 2026-09-26 (you away): what was done

- [x] **Shared camera**: games/nam-rts/namCamera.js → games/shared-rts/rtsCamera.js
      (git mv, unchanged). nam imports it from there; verified nam boots and
      the camera works. First piece of the shared RTS core.
- [x] **The game page**: games/alg-rts/alg.html + algGame.js (vite input
      `algRts`). Boots in ~4.5 s: nam's settings (fitted shadow, lean terrain,
      top-3 + far tiling, terrain drawn last), the Aurès map, the shared camera.
      No gameplay. `?light=flat` `?fog=0` `?showroom=0`.
- [x] **Light and sky**: Atmosphere sky (`skyMode: "atmosphere"` must be asked
      for at boot, or setWorldLight does nothing), real latitude 35.2°, mid-July
      15:12. Measured: mean luma 57-76 → 118-140, near-black 9-21% → 0-3%.
      Dust haze matched to the horizon.
- [x] **The plain outside the map**: new engine call `app.setGroundBase({
      baseColor, lineColor, ao })` (runtime, not saved). Matched by eye to the
      textured soil: #a39480.
- [x] **Atlas cell 19 = dry-stone rubble** (`MAT.rubble`, the LAST free cell):
      ragged limestone blocks, deep earth joints, chinking. For the post, the
      mechtas, terraces.
- [x] **Stencil sheet 1024 → 1024×2048**: the old half untouched; the new half
      holds France: tricolour, cockade, "POSTE DE TIGHANIMINE" board, vehicle
      plate, ARMÉE DE TERRE ×2, unit code, helicopter serial, S.A.S. board,
      and two fallen-plaster patches (drawn with the rubble surface).
- [x] **French post (HQ)** `v3/render/objects/rtsFrenchPost.js`: bordj-style
      walled square (28.6 m ×1.3), rubble footing, whitewash, merlons,
      loopholes, wall-walk, two towers with sandbagged MGs, arched gatehouse
      with the name board and a painted tricolour, barracks, command post,
      radio mast, flag, stores, water tank, sandbag chicane, double-apron
      wire. 13.7k tris, one draw + markings.
- [x] **Panhard EBR** `v3/render/objects/rtsVehiclesFr.js`: symmetric boat
      hull, 4 tyred + 4 steel wheels (roll with the odometer), FL-11 turret
      with the long 75 mm, stowage, both drivers' stations; plate, turret
      tricolour, roof cockade.
- [x] **French paint**: `rtsObjectMaterialTinted(FR_PAINT_TINT)` tints only the
      painted surface — US olive drab went lime in the Aurès light.
- [x] **Showroom** games/alg-rts/showroom.js: new assets placed on the map
      under the real light (post at 40,150; vehicles by the gate; hamlet at
      150,60; plants on the massif and round the post). Temporary.
- [x] **Willys MB jeep** and **GMC CCKW 353** (rtsVehiclesFr.js): jeep with
      folded windscreen, .30 on its pedestal, driver + gunner, plates; GMC
      with banjo wings, closed cab, duals, canvas tilt on its bows.
- [x] Rolling gear tinted too: `rtsRunningGearMaterial(paintTint)` (the US
      default is unchanged).
- [x] **The mechta** (v3/render/objects/rtsMechta.js): 10 Chaouia houses in
      attached rows along a lane, rubble walls, earth roofs with parapets,
      beam ends under the eaves, limewash/mud skins, some second storeys,
      lean-tos, yards with dry-stone walls, a tabouna oven, jars, a threshing
      floor. 4.4k tris, one draw.
- [x] **Aurès vegetation** (FOLIAGE_PRESETS): `atlasCedar` (new builder
      cedarGeometry.js: forked trunk, tiers of level plates; new card
      cedarNeedleTexture.js: sprays of needle rosettes combed out along the
      branch), `holmOak`, `juniperScrub` (the dipterocarp builder, domed /
      shrub-sized), `alfa` (blades). Hand-placed via PlacedFoliage for now;
      the map's paint slots are untouched.
      Rejected on the way: round clump cards on the cedar (read as green
      coins), the bush builder for scrub (90 tris, invisible at 1.6 m), the
      first holm oak (a bright savanna tree on a pole).
- [x] Verified after all engine changes: nam-rts boots, clean console, its
      stencils (Quonset star) intact; alg page clean console; boundary test
      and fast lane 196/196 green.

- [x] You looked (2026-09-26): "look nice, continue".
- [x] **Cedars tiered**: 5 tiers, flat cards (8°), each shelf lit on top and
      dark to its rim. From the side: the Atlas cedar's stacked shelves.
- [x] **Holm oak / scrub**: new `crownDepth` key on the dipterocarp builder
      (default 0.6 = unchanged); oak 1.25 = round crown down to head height
      (was an acacia on a pole), scrub 1.1 and twice the foliage.
- [x] **Alouette II** (rtsVehiclesFr.js `buildAlouette`): glass bubble with its
      frame, bare Artouste turbine, open triangular lattice boom with the
      drive shaft, fin + stabiliser, 3-blade main and tail rotors (spinning in
      the showroom, the Huey's rotor contract), skids, stretcher panniers.
      `blade` added to VEHICLE_KIT.
- [x] **AMX-13** `buildAMX13`: low hull, engine louvres + driver front, 5 road
      wheels, front sprocket, rear idler, return rollers (shared `trackSide`
      helper), FL-10 turret set back with the long 75 mm and its bustle;
      turret contract as the M113 (turret geo + pivot + muzzle).
- [x] **M3 half-track** `buildHalfTrack`: roller, armoured bonnet, wheels +
      rear track unit, open armoured box, .50 on its ring, crew, mine racks.
- [x] Checked: clean console, boundary test + fast lane green.

- [x] **C key** = RTS camera ⇄ free orbit on this page (was only bound in
      nam's dev panel), matched on `e.key` for AZERTY.
- [x] **Alouette II rebuilt from ALAT photos** (your "looks really bad"): a
      lofted teardrop cabin, solid lower nose + see-through glass (own
      material, crew visible), frame bows and hoops, the box centre body,
      the uncowled Artouste with its big exhaust on top, an N-truss lattice
      boom, hoop tail skid, long low skids with arched cross tubes, dark
      ALAT olive, white serial + cockade + ARMÉE DE TERRE.
- [x] **Palms**: `datePalm` (oasis), `canaryPalm` (avenue/post gate),
      `doumPalm` (dwarf fan palm on the slopes). First date palm was a spiky
      pompom on a pole: now 46 long arching fronds. Doum was trees on sticks:
      now low fan clumps.
- [x] **Oasis** (tools/algOasis.mjs): a lobed basin carved in the valley floor
      at (132, 128), a lake 1.5 m under the rim, grove ground (grass_ground,
      Poly Haven) feathered round it; date-palm clumps, reed-mace at the
      edge. Water tuned for a small pool: depthDistance 20 → 3.5 m (at 20 the
      shallow pool read as SAND), a silt bed, faint caustics. Map backed up
      before the carve (scratchpad alg-aures.pre-oasis.v3proj).
- [x] Budget at play zoom with everything placed: 77-97 draws, ~680k tris,
      CPU ~2 ms (nam-valley: ~176 draws). Clean console; tests green.

Asset follow-ups:
- [ ] **STONES that match the stony ground** (you, 2026-09-29, after the
      oasis): loose rocks and stone scatter on the map whose colour and grain
      are the ground textures' own (gravelly_sand scree, rock_boulder_cracked
      limestone, the valley soil's pebbles), so they sit IN the ground instead
      of on it — placed where those layers are painted (scree slopes, ridges,
      wadi banks). The kit's fieldStone is limestone-grey and reads foreign.
      Also: a broken gravel SHOULDER along the pistes (the stones a wheel
      pushes aside) — as stones, not paint (algTracks only owns slot 6).
- [x] **Animals at unit scale** (you, 2026-09-29: "most of them are barely
      visible"): sheep, goats and donkeys 1.3x like the men (algHerds.js
      `S = RTS_SCALE`), and every length with them — walk/run speeds (the
      clip stride), flock spread, roam, the goats' lead, tied donkeys' gap,
      the train's spacing, the flock's pace. Seen: a donkey's back at a
      soldier's chest; the flocks read at play zoom. shared wildHerd.js and
      nam-rts untouched. Next if still hard to see: contrast (fleece/coat).
- [x] **KSAR EL HAMRA** (you, 2026-09-29, a photo of Ghardaïa): a M'zab-
      style plastered town up the one clear knoll in the play box (-10,-120),
      ALN-leaning, the 4th village (50/min; held from its SOUK, layout.js
      sitePoint — the town itself blocks the nav). rtsAlgVillage.js
      buildKsar: 56 houses in rings, walls running down the slope (the
      stacking), parapets with horns, roof rooms, palm shades; the mosque and
      a 25 m tapering minaret on top; an arcaded souk (extruded arches, dark
      galleries, merlons, lanterns), square, fountain, 3 palms, stair lane.
      Two new atlas plasters (MAT.plaster 22 ochre, plasterPale 23 cream —
      THE ATLAS IS NOW FULL). The souk stands on a `pad` (new showroom option
      for ground pieces). 12.7k tris, builds in ~160 ms; coplanar + ground-
      band tests pass (flat and knoll).
- [x] **Ksar, second pass** (you, 2026-09-29: "a perfect circle looks
      weird", palms inside the gate, the white circles not aligned):
      real M'zab ksour follow their rock, dense and labyrinthine — the town
      is now an irregular outline wide along the hillside (29 m each side,
      15 behind the mosque, 26 down to the souk, lobed), 64 houses packed
      at random wall to wall (oriented-rect test, a second pass of small
      cubes), each facing down the slope; winding alleys (the stair to the
      souk, two more out); no ring wall (it made a round fort). Overlapping
      neighbours whose flat faces met are lifted 2.3 cm (checked pair by
      pair). Palms in a grove OUTSIDE, never in the souk or over a roof.
      CAPTURE RINGS: centred on each village's placed footprint (the
      mechtas' sat off to one side), and shown only while men are selected
      or someone stands in one (CoH), not always.
- [ ] Ksar, next: YOU LOOK (colours, minaret height, density); a piste to
      it (algTracks ROUTES + --route); a stork on the minaret; donkeys and
      people in the souk; the square's facing (the right wing hides part of
      it from the play camera — turn, or open that wing).
- [ ] **What next — environment / buildings / vehicles** (proposed
      2026-09-29, your pick): stones matching the ground (above); a road
      network that reads (pistes to every village, a French tarmac road with
      milestones and a bridge); palm groves + seguias round the oases;
      the French side's colonial buildings (a farm/"ferme coloniale", a
      school, a gendarmerie in stucco and tile — rtsColonial.js is Indochina's);
      villages that LIVE (people at wells, laundry, smoke from ovens); damage
      states (burnt, collapsed houses after shelling); more vehicles (Dodge
      6x6, Jeep with recoilless, Piper Cub, H-21 "banane"); weather
      (sandstorm, night with the searchlight); sound for the ksar (muezzin, souk).
- [x] **The pistes looked flat and ruled** (you, 2026-09-29):
      1. The Dirt track is slot 6, and alg compiled `layerBudget: 6` (slots
         0-5): the tracks drew the flat base colour, NO texture at all. Now 7
         (`?layers=6` to A/B). MEASURED +0.11 ms GPU (1.235 → 1.348, one
         round each, same view).
      2. The straight band was the rut DECALS' halo on the exact centreline:
         opacity 0.7 → 0.45, each 10 m segment ±0.4 m sideways.
      3. The paint edge: two octaves of wobble (9 m, 2.2 m) and a fade
         thresholded by a 1.1 m noise, so stone bites in and dust spills out.
      4. Valley soil normal 0.5 → 1.0 (you: "bump normals a bit"); the
         pebbles now catch the sun. Set in the map only (it came from the
         editor, no tool owns it).
- [x] **A better-looking OASIS** (you, 2026-09-29): the ground round the
      water read as neither desert nor garden. tools/algOasisLook.mjs, per
      lake: slot 3 is now "Oasis grove" (forrest_ground_01, tint #f2f5e6)
      painted out to poolR×1.4+10 m with a noisy edge (never over wadi beds
      or tracks); grass only in the damp ring 2.5 m → grove edge, and it is
      nam-rts's grass ("far better", you): tools/algGrassFromNam.mjs copies
      nam-valley's system (revo) and its look; 24 + 17
      photo MUD decals (new `soil` source, textures/decals/alg/mud_*) along
      the waterline; the date grove denser
      and sized from the real pool radius (algVegetation `_poolR`).
      **Ain el Oued sat on the Oued el Abiod's bank** and its 51 m lake
      square flooded the dry bed: tools/algOasisMove.mjs refilled the old
      basin to the eroded ground, moved it to (-136, 352), lake fitted tight
      to the pool (31×35 m, level 3.92), 0 wadi texels wet.
      Order: algOasisMove → algOasisLook → algVegetation.
- [ ] Oasis extras: small walled palm gardens (the garden kit) and seguias;
      the grove's edge is still quite round from above — you, look.
- [ ] Oasis: a second one, and paint the lake params per map in the editor
      (all lakes in a map share one water setting).
- [ ] Put the plants into the map's paint (4 tall slots: cedar, oak, scrub,
      alfa) once the look is agreed.
- [ ] Post walls could use more weathering (grime under the merlons).
- [ ] Next assets: H-34 "Pirate" gunship helicopter, a French helipad,
      buildables (mirador watchtower, MG post) in the post's style, SAS post,
      olive grove + prickly pear for Kabylie, the ALN's side (cave mouths,
      a mountain hideout).
- [x] Soldiers: **you** make them (2026-09-26), as in nam-rts.
- [x] **Cloth flag** (your ask): the post's painted flag and pole removed;
      the post now reports `userData.flagMount` and the game plants the
      engine's Verlet cloth flag there (games/alg-rts/algFlag.js, the same
      createFlag as nam's baseFlag), with a drawn tricolour texture.
- [x] **Vegetation moved INTO the map** (step 2, 2026-09-26):
      tools/algVegetation.mjs writes the species into the map's plant slots
      and the density into its paint (derived from height, slope, the oasis,
      clear of the post / vehicle park / hamlet). Tall: cedar, holm oak, date
      palm, juniper scrub. Ground: alfa, reed-mace. The showroom only places
      the two Canary palms at the gate now. Verified in the editor: slots and
      paint load from the file.
      First pass was a forest (GPU counter ~12 ms in a close view): densities
      cut to Aurès sparseness (~6 ms same view). Map backed up first
      (scratchpad alg-aures.pre-veg.v3proj).
- [x] Doum palm: out of the painted field — the fan-palm builder's far LOD
      draws it as flat green mats. Fix the far LOD (or a card) and repaint.
      (2026-09-30: fixed by crownShade, repainted.)
- [ ] The stats overlay's triangle count reads ~2 billion since the tall
      field went in (a counter artefact of indirect draws? unverified; the
      frame holds 60 fps).
- [x] **Step 3, the layout** (2026-09-26) — games/alg-rts/layout.js, plan
      image games/alg-rts/layout-plan.png (`node tools/algPlanView.mjs
      --layout games/alg-rts/layout.js --out ...`): French at the post (valley,
      south-centre); ALN camp high in the NW massif (-350, -315); objectives:
      2 hamlets, 2 oases, 2 gully mouths (the ALN's ways down), cedar spring,
      ridge watch. Sites moved to the flattest ground nearby (relief ≤ 8.5 m).
- [x] **Wadis** (tools/algWadi.mjs, from the layout): Oued Tighanimine 600 m
      north of the hamlet, Oued el Abiod 634 m in the south-west; beds forced
      downhill, 42° banks (past the 34° nav limit), 3 fords each at 16° —
      the valley's chokepoints. Bed painted slot 4 (dry_river_pebbles).
- [x] **Second oasis** "Ain el Oued" (-120, 330) r16, in the southern wadi's
      bed (a guelta). Second hamlet placed. Vegetation re-run: clearings now
      from the layout, nothing on the wadi beds, palms at both oases.
      Map backed up before the carve (scratchpad alg-aures.pre-wadi.v3proj).
- [x] **Starts on the long diagonal** (your question, 2026-09-26: "shouldn't
      they be opposite?"): French post moved to the SE ridge bench (305, 345),
      25 m up, gate facing NW; ALN stays in the NW massif; ~930 m apart (was
      ~600 m with the post near the centre). Objectives rebalanced by
      distance: 4 lean ALN (cedar spring, both gully mouths, new Kef lookout),
      4 lean French (both oases, both hamlets), 1 middle (new Col de l'Ouest).
      The post's vehicle park / helipad / gate palms now follow the post
      (showroom.js BASE_PARK, post-local). The camera starts on the base
      facing the enemy: new `rtsCamera.setYaw` (shared camera; nam unchanged).
- [x] **Facing rule** (your correction, twice): buildings turn their fronts
      toward the player's camera at THREE-QUARTERS — ~25-45° off, never
      square-on, never away (Company of Heroes). layout.js: `VIEW_YAW` + a
      per-site `turn`, `siteYaw(site)`. The post's park moved to its flanks.
- [x] **ALN command post** (v3/render/objects/rtsAlnCamp.js, 3.3k tris, one
      draw): the stone house they took over (rubble, earth roof heaped with
      brushwood), a cave in angular limestone blocks behind it (timber
      lintel, sacks), a log-roofed dugout, three stone sangars with guns, a
      stores lean-to, cooking fire, radio aerial; the FLN flag as live cloth
      (algFlag.js drawFlnDataUrl). Placed at the layout's ALN site; HQs 930 m
      apart.
      Rejected on the way: the first rock was one smooth dome (a loaf of
      bread) — now a cluster of flat-faced blocks.
- [x] **Z-fighting in the committed assets fixed** (post, mechta, ALN camp,
      all French vehicles): both kit tests now cover this game
      (rtsPropsCoplanarTest, rtsGroundBandTest). New tool:
      `node tools/rtsCoplanarWhy.mjs <module> <builder>` names the PART
      pairs behind an overlap (rtsParts ASSEMBLE_TRACE). Wire/masts/braces
      use `wirePart` (round, per-strand twist — same-roll boxes coplanar).
- [x] **Buildables, first four** (v3/render/objects/rtsAlgeria.js):
      sandbag wall (5 courses + firing step), barbed wire (double apron +
      ONE continuous concertina coil — separate rings read as a toy), mirador
      (9 m, braced legs, plank cabin, searchlight, MG), MG nest (berm, bag
      ring, half-roof; gun its own mesh on a pivot to traverse). Shown in
      the showroom round the post.
- [x] **Floating pieces fixed** (you saw them): every pad's rim reshaped
      the ground under the pieces seated before it (bags 1.1 m up, the
      post's wire 0.3 m). Now all pads first, then seat; pads get +1.5 m
      margin; bags, wire and vehicles lie ON the slope (plane fit, lowest
      corner decides), no pad. Measured: nothing floats > 7 cm.
      **Build-system rule:** a pad + rim must not reach another pad.
- [x] Vehicles on bumpy ground sank a wheel (the tilt was the terrain normal
      at the centre). shared-rts unitRenderer: the ground under the four
      wheels (wheelbase from the unit radius), the body fitted to them and
      lifted until no wheel is under ground. MEASURED at 1702 spots, a
      4.6 m vehicle: worst sink 4.39 m → 0, mean 0.24 m → 0 (2026-09-29;
      nam's vehicles too — same machinery).
- [x] **Dev panel** (your ask): games/alg-rts/devPanel.js on a SHARED shell
      (games/shared-rts/devPanelShell.js — frame, folding sections, row
      helpers; nam's panel untouched). Sections: Camera, Light (live, Copy →
      AURES_LIGHT), Haze & bloom, Showroom (go to / hide), Performance
      (render scale, GPU pass timings). `?dev=0` hides it.
- [x] **Grey-then-textured at load fixed** (you saw it): the kit atlas is
      painted in a worker; the game now starts it first and holds the
      loading screen until it lands (algGame.js, rtsAtlasReady).
- [x] **Helipad, motor pool, mortar pit** (rtsAlgeria.js, 2026-09-27):
      helipad = graded bed, cement square + painted H, whitewashed stone
      border, windsock, fuel drums behind bags; the Alouette stands on it
      (showroom `on`). Motor pool = open steel-truss shed, corrugated roof +
      back wall, whitewashed workshop ("ARMÉE DE TERRE"), inspection ramps,
      chain-hoist gantry over an engine, bench, tyres, drums, jerrycans.
      Mortar pit = 81 mm Brandt (own mesh, traverses) in a lumpy spoil berm,
      bag parapet, ammo, red/white aiming stakes. 3.4k / 8.8k / 3k tris.
- [x] **Atlas row six: `MAT.spoil`** — dry ochre earth with pebbles, for
      berms, pits and graded ground (the kit's earth is dark Vietnamese mud:
      it read as a brown square on the Aurès). Cells 21-23 free. Berms are
      now irregular smooth heaps (earthBerm), not turned pots; the MG nest's
      too, and both bag rings closed (they had gaps).
- [x] **ALN buildables** (rtsAlgeria.js, 2026-09-27), the other side's
      language — low, stone and brush, never white: cave entrance (rock
      shelter, shored mouth into the dark, brush over it; 3.5k tris), arms
      cache (a matmora grain pit, lid aside, crates, rifle tripod, the
      guard's gourbi; 4.2k), sangar (dry-stone C, brush on the lip, FM 24/29
      on its own pivot; 2.6k), ambush screen (cut scrub in a stone footing
      between rocks; 3.3k), mine marker (turned earth + a three-stone cairn).
      Shared helpers: dryStone (courses of field stones along a path),
      crag (big rocks: noise + bedding, faceted), brushClump (lumps + bare
      twigs). Shown round the ALN camp on its gentle flanks (MEASURED: the
      camp is a hilltop, its front too steep).
- [x] **Atlas cell 21: `MAT.limestone`** — one stone's face, warm buff-grey.
      The rubble cell is a wall (its joints went black on single stones) and
      the Khmer sandstone read olive. The ALN camp's rocks moved to it too.
- [ ] **you, taste**: the brush — green lumps + dry bundles + twigs — and
      the stone colour. Judge them at play zoom.
- [ ] **Next buildables**: searchlight tower, SAS post (still **you**:
      forward base or not?).
- [ ] Very high orbit views show a black band under the horizon (the env
      bake's black lower hemisphere, ref_v3_env_bake_black_floor); not seen at
      play zoom.
- [ ] **you**: a second French outpost (SAS post) north of Oued
      Tighanimine, as a forward base?
- [ ] **LATER — sandstorm** (your ask, 2026-09-26): a weather event —
      wall of dust rolling in, haze thickening to a brown-out, wind-driven
      dust sheets, the light going orange and flat; gameplay: sight ranges
      shrink, helicopters grounded. Candidates: the engine's fog + smoke
      flipbooks + a dust-particle layer.

## MAP SCALE — a Company of Heroes-sized battle (your call, 2026-09-28)

- [x] The terrain was fine; the BATTLE was too big: the starts ~930 m apart
      on the diagonal, units at 11 m/s (a sprinter), 82.5% of the ground
      bare. Now:
      · the starts moved IN along the same diagonal, ~470 m apart
        (layout.js), sites MEASURED: the post on the valley floor 95 m from
        the oasis (1.2 m relief over its pad), the katiba high in the broken
        ground (51 m up); the line turned 7°, buildings still 3/4 on;
      · a PLAYABLE AREA, 610 m (layout.js PLAY): the camera (shared
        rtsCamera.setBounds), the paths (four blocked strips in the nav
        grid) and the minimap (it frames the box) stay in it; the terrain
        outside is scenery — the Kef, the Col, the far corners;
      · CoH speeds: appelé 5.5 m/s, moudjahid 6, Willys 12, EBR 13,
        half-track 10, GMC 9, AMX-13 8.5, Alouette 24;
      · the vegetation re-baked (tools/algVegetation.mjs) so nothing grows
        on the new sites; every piece round both starts checked: pads
        level, dry, no trees.
      Measured: a band from the cave to an ambush on a patrol 120 m out of
      the post in ~52 s (was ~72 s at a sprint over twice the ground).
- [x] Mark the out-of-bounds ground (CoH darkens it) — 2026-09-30: the fog
      of war's post pass (shared, `bounds` option; nam passes none) darkens
      the ground and what stands on it outside PLAY by 45%, a third
      desaturated, over a 14 m soft edge — fog of war on or off.
- [x] A move order outside the box: go to the nearest point inside —
      2026-09-30: shared selection `clampOrder` (ground and minimap orders),
      alg clamps to 8 m inside PLAY. Tested: 3 men ordered to (360, 260)
      walked to ~(282, 260) and stopped.
- [ ] Fill the box densely (scrub along the wadis, terraces and orchards
      round the villages); thin the vegetation OUTSIDE it (frame time).
- [x] (2026-09-29, `--view play`, tracks drawn) tools/algPlanView.mjs: redraw the plan image with the new layout.

## ECONOMY — first cut in (2026-09-28, algEconomy.js), per the proposal below

- [x] Two purses: the French **Ravitaillement** (start 400) and the ALN's
      (start 240). Income: the French 40/min from Algiers + each village
      they hold (mechta 25, dechra 40); the ALN 15/min + each village it
      holds + 15/min per standing ARMS CACHE (burn them, the katiba starves).
- [x] The VILLAGES (both mechtas, the dechra) are the points: an influence
      meter −1…+1 that MEN ON FOOT within 40 m push their way (up to 3
      count; both there, the stronger pushes), drifting to neutral when
      nobody is there; held past ±0.6, lost back through 0. Tested: 4
      appelés at Mechta Ouled Ali — 0.30 at 5 s, held at 10 s, income
      40 → 65/min.
- [x] Every unit COSTS, charged when queued, refused if the purse can't pay
      (appelé 60, Willys 90, GMC 110, half-track 160, EBR 220, AMX-13 260,
      Alouette 320; moudjahid 40 from the ALN purse — the AI's bands are
      only as big as it can pay for, refunded if under 3).
- [x] Shown: the supply strip (Ravitaillement · +/min · villages n/3 · ALN
      n), prices on the production buttons (greyed when short), a ring
      round each village in its holder's colour, the minimap's diamonds.
- [x] **THE GÉNIE SAPPER + BUILDING PLACEMENT** (2026-09-29, algBuild.js):
      the post trains SAPEURS (80); a sapper's card offers sandbags 20,
      wire 15, MG nest 90, mortar 130, mirador 110, searchlight 60. The
      ghost is the piece itself, green/red (why: out of the play box, water,
      blocked, too steep > 18°, no supplies — algBuild.why); R turns it 45°,
      Shift-click keeps placing, right-click/Esc cancels. Placing pays,
      levels a pad (pits, towers) or lays the piece ON the slope (bags,
      wire), blocks the nav, clears the plants, lays a foundation; sappers
      at the site raise it (two 1.4x as fast). Done: a structure like the
      rest (algStructures.addBuilt: fights, sees, picked; live lists now),
      cover re-baked (bags: hard). The post STARTS BARE (?defences=1 = the
      old pre-placed set). Tested: nest + bags placed, paid 110, both up in
      ~15 s, the nest in the structures, cover 1.0 behind the bags.
- [x] **The storks in the fields WALK** (2026-09-29, shared bird kit — see
      nam's TODO): legs stride, head bobs, feet don't skate; ~0 GPU.
- [x] **THE PROJECTEUR WORKS AS A SEARCHLIGHT** (you, 2026-09-29;
      algSearchlight.js): every searchlight tower (pre-placed or a sapper's)
      sweeps ±63° in front, and when the beam passes near an ALN man
      within 75 m it LOCKS on and follows him; whoever stands in its 6 m
      pool is SPOTTED (cover.reveal: scrub hides nobody) and the pool sees
      through the fog of war. No real light: an additive cone (soft edges)
      + an additive disc on the slope; faint by day, full at dusk. The drum
      tips and turns to its aim. Tested: locked 6.5 s after a man appeared
      in front, pool 0 m off him, revealed the whole time. GPU: on 2.036 /
      off 2.040 ms (noise).
- [ ] **DUSK/NIGHT IS BLACK**: setTimeOfDay 19.3 (sun 0.05 up) renders the
      whole world black (not the searchlight — measured without it). The
      night item needs real dusk/night light (moon, ambient) before the
      searchlight can be judged at night — you, look then.
      DECIDED (2026-09-29): night lives in SKY PRO (you are building it in
      another session: moon light, ambient/exposure floor, twilight). When it
      lands: read its night amount (0-1) in algSearchlight.js instead of the
      sun's height, then lit windows / lanterns / mirador lamp off the same
      value.
- [ ] **DETAILS THAT COST ~NOTHING** (you asked for more like the projecteur,
      2026-09-29 — only if they stay near free: no dynamic lights with
      shadows, shared particle/decal fields, instanced):
      · Sappers at work: a dust puff and a spade/hammer swing while a site
        rises; a small tricolour on a finished mirador.
      · Barbed wire that MATTERS: the ALN must cut it (a few seconds, a
        sapper-like action) or go round; it snags a man for a moment.
      · Dust trails behind vehicles on the pistes (one shared particle
        field), tyre-track decals fading behind them (DONE 2026-10-01, trackMarks.js).
      · Oven smoke from a few village houses, laundry on a ksar roof,
        a donkey tied at the souk (the herds already have donkeys).
      · Night: lit windows (emissive, no lights) in the post, villages and
        the ksar; a lantern at the souk arcades; the mirador lamp.
      · Built pieces WEAR (sandbags + houses + smoke DONE 2026-10-01, algDamage.js): sandbags slump and burst when shot (swap to a
        damaged variant), a burnt MG nest keeps its wreck (as structures).
      · Spent brass / a scorch decal at an MG nest after long firing.
      · Ambience: cicadas by day, the muezzin from the ksar at set hours,
        dogs barking in villages when soldiers come near.
- [~] Génie, next: ~~a construction bar over the site; cancel/refund~~;
      ~~ALN builds (sangar, ambush screen) the same way~~ (all 2026-09-30);
      the AI's sappers?; the ALN AI CALLING place() (you — algAI.js is
      yours); the mirador into the line-of-sight bake; pads read as a pale
      mound on a slope (the flatten rim) — you, look.
- [ ] Not yet from the proposal: tiers (motor pool → helipad → armour), the SAS post raising support,
      the arms cache UNLOCKING MG / mortar / bazooka teams (it pays income
      for now), militia (moussebilines) recruited in ALN villages, the
      ALN purse named "Soutien" on screen.
- [x] The ALN FIGHTS FOR THE VILLAGES (2026-09-28, algAI.js): about half
      its bands (when one is worth it) do POLITICAL WORK — into a village
      the ALN does not hold (French-held first, then neutral; near, few
      French round it), holding fire, which swings it their way; French
      within 35 m → strike, then melt back to the cave. Tested (headless):
      a band of 5 took the dechra (held at 73 s, ALN income 30 → 70/min);
      6 appelés sent, the band struck when they arrived, withdrew with all
      5 and went to ground; the dechra stays theirs until the French work
      it back through 0.
- [~] The ALN leaving a few men as a village cell (moussebilines) — DONE
      already (algAI leaveCell: 2-3 men + a sangar); still to do: 
      the French answer: cordon-and-search (a mission, not just walking in).
- [ ] Balance: all numbers are first guesses.

## PROPOSAL — economy and base-building (2026-09-26, waiting for **you**)

Shared core (nam's, moved to games/shared-rts): capture points held by
INFANTRY pay income every second; a builder unit places structures; the
HQ pays a small trickle. On top, the two sides play differently:

**French — "Ravitaillement" (supplies), one currency.**
- Income: held points + HQ trickle; the valley points (hamlets, oases)
  lean French.
- Builder: the Génie sapper. Tiers unlock by building:
  1. Post (start): infantry (appelés, then paras/légion)
  2. Motor pool: jeep, GMC, half-track, EBR
  3. Helipad: Alouette II (medevac, recon), H-34 (troops, gunship)
  4. Armour (after both): AMX-13
- Defences: sandbag wall, barbed wire, mirador watchtower (sight),
  MG nest, mortar pit, searchlight (night).
- **SAS post**: a forward base on a hamlet: reinforce there, sight
  radius, raises French support in that hamlet.

**ALN — "Soutien" (support), one currency, earned differently.**
- Income: held points (the mountain ones lean ALN) + hamlet SUPPORT:
  each hamlet has a support meter; the side with more presence there
  gets its income. Abstract, never atrocity mechanics.
- No heavy vehicles, no air. Instead:
  - **Hidden**: ALN buildings are invisible to the French until a French
    unit comes close (nam's tunnel rule, 35 m).
  - **Cave entrance**: spawn and reinforce point, only in rough ground.
  - **Arms cache**: stores smuggled weapons: unlocks MG / mortar / bazooka
    teams.
  - **Sangar**: stone MG position.
  - **Mines / booby traps**: nam's trap kit (a per-man roll to find).
  - **Ambush position**: brush screen; units inside are hidden until they
    fire.
  - Hamlet **recruits** militia (moussebilines) where support is high.
- Build rule: ALN may build only on rough or high ground (near cover), the
  French anywhere they can level a pad.

**Assets this needs** (buildable, kit style, 3/4 facing):
French: sandbag wall, barbed wire, mirador, MG nest, mortar pit, helipad,
motor pool (hangar), searchlight tower, SAS post.
ALN: cave entrance, arms cache, sangar (from the camp), ambush screen,
mine / trap markers.

## Open decisions — **you**

- [x] **How the code starts**: (b), a shared RTS core, one system at a time
      (you, 2026-09-26). Camera moved first.
- [x] Playable side: **French** first; choosing the side comes later (you).
- [x] Title: **SAND & BLOOD** (your cover art, 2026-09-27): launcher card
      beside NAM, loading screen on the art (alg.html, as nam.html).

## Terrain — the first map

Tool: `node tools/algDem.mjs --site <name> --out <dir>` (or `--site all`,
or `--lat --lon --span`). It writes a 16-bit heightmap PNG (editor: Sculpt →
Heightmap File), a raw `.f32` (the .v3proj `heightmap` blob as-is) and a
shaded preview (red = steeper than the 34° nav limit, green = the biggest
connected ≤15° patch), and prints the three RTS metrics.

Candidates measured 2026-09-26 (real slopes, `--vscale 1`, smooth 3):

| site | real span | game relief | walkable | biggest gentle patch |
|---|---|---|---|---|
| aures-arris | 4 km | 4–127 m | 99.8% | 71.6 ha of 105 |
| **aures-tighanimine** | 4 km | 4–207 m | 99.3% | 44.4 ha |
| aures-oued-abdi | 5 km | 4–166 m | 97.4% | 20.1 ha |
| aures-ghoufi | 3 km | 4–110 m | 96.8% | 62.8 ha |
| kabylie-irathen | 4 km | 4–181 m | 92.9% | **1.9 ha**: all ridges; a hard map later, not the first |

What this showed:
- The source data is ~30 m SRTM and carries fine horizontal striping. The tool
  samples it bicubic (bilinear left a crease every ~4 texels) and blurs 3 px.
- **At real slopes the Aurès is almost all walkable at game scale.** The data
  smooths the real cliffs, so "mountain war" legibility (cliffs as walls,
  ramps as doors) has to be ADDED: terracing (tools/terraceTerrain.mjs) and
  rock bands at 34°, not taken from the data.
- Ghoufi has a dead-straight diagonal wall at bottom-left that looks like a
  data artifact. Check before using it.

Steps:
- [x] DEM → heightmap tool, 5 candidate sites measured
- [ ] **you**: pick the site (recommended: Tighanimine: NW massif, a wide
      diagonal valley, a SE ridge, 207 m relief)
- [ ] **you (2026-09-26): the RTS doesn't need big mountains.** Flatten
      with `--vscale` (e.g. Tighanimine at 0.6 ≈ 125 m relief), or take
      Arris (127 m at real slopes). Keep the drama at the map edges.
- [x] Tighanimine heightmap generated at real slopes (`--vscale 1`):
      games/alg-rts/terrain/aures-tighanimine.png. The user's fluvial erosion
      (Sculpt → Stream Power) flattens a lot, so it does the flattening, not
      `--vscale`.
- [x] New project in the editor (1024 m / 1024 / max 250), PNG imported,
      fluvial erosion (iters 160, strength 20, uplift 0, smooth 5), saved as
      **public/levels/alg-aures.v3proj** (3.7 MB, verified read-back)
- [x] Re-measured. Fluvial CARVES, it does not flatten: relief stayed
      4.5–206 m; walkable 99.3 → 88.3%; gentle 49.4 → 36.1%; biggest
      connected gentle patch 44.5 → 30.6 ha. Weakest tile 65% (SW).
- [x] Relief ×0.6 and the border faded to the plain (your "you choose",
      2026-09-26). Outside the heightmap the engine draws flat ground at
      0 m, so the edge was a wall. Far mountains would need terrain beyond
      the heightmap (engine work, and the terrain shader is at its sampler
      limit), so the border fades to exactly 0 over 170 m, edge wobbled by
      noise. Tool: `node tools/algShapeMap.mjs --in
      public/levels/alg-aures.v3proj.bak --out public/levels/alg-aures.v3proj
      --scale 0.6 --band 170 --warp 50`. The .bak is the untouched eroded save;
      re-run with other numbers from it.
      Result: 0–96 m, walkable 93.4%, gentle 62.8%, biggest connected gentle
      patch **61.3 ha** (nam-valley 49), NW massif tiles 67/78%.
- [x] (2026-09-29: the foliage picker's thumbnail bake — an all-card plant
      left an empty FIRST material group; and the editor's favicon 404.)
      Console: one "Draw with an index count of 0" warning after loading
      the map in the editor. Some empty mesh is being drawn; find which.
- [ ] Later, maybe: far mountains beyond the map (a backdrop ring) if the
      flat plain round the map reads wrong from the game camera.
- [ ] Wadis (dry riverbeds) as River v2 carves with no water: the walkable
      corridors
- [ ] Cliffs and ramps: terracing on chosen slopes, so impassable ground is
      readable
- [x] Surface layers, first pass (2026-09-26), `node tools/algPaint.mjs
      --file public/levels/alg-aures.v3proj` writes the slots + splat:
      slot 0 Valley soil `brown_mud_dry` · slot 2 Scree `gravelly_sand`
      (13–22° up) · slot 5 Cliff strata `cliff_side`, triplanar, from 34°
      (= nav limit) · slot 1 Limestone ridge `rock_boulder_cracked` (land
      height p80→p95 = 45→75 m). Coverage 66 / 25 / 4 / 5%. Poly Haven CC0,
      1k, in public/textures/ground/. Judged with ?topk=3&far=1 (what the game
      compiles) at a ~150 m play camera.
      Rejected at play distance: `dry_ground_rocks` (dark patches repeat as
      diagonal bands every 8 m), `sandy_gravel_02` (flat, still bands),
      `aerial_ground_rock` (white spots in a grid).
- [ ] The plain OUTSIDE the map renders white; should be soil-coloured so
      the edge doesn't show.
- [ ] Tints / colour pass once the light is set (judge in the game).
- [ ] Unused slots 3, 4, 6 still load the editor's default palette (12 images
      decoded for nothing); clear them.
- [ ] Sky and light: harsh sun, pale sky, dust haze (a preset, and the fog
      band in METRES belongs to the map)
- [ ] Save to public/levels/ and verify it round-trips

## Vegetation — the one genuinely new asset job

- [ ] Atlas cedar (Aurès heights)
- [ ] Holm oak / Aleppo pine
- [ ] Lentisk and juniper scrub
- [ ] Alfa grass (esparto) tufts
- [ ] Olive groves (Kabylie), prickly pear (villages)

## Later — gameplay ideas already discussed

- Open ground, long sightlines: height-based line of sight and dead ground
  matter more than foliage concealment
- French: helicopters (H-21, H-34, Alouette II), paratroopers, cordon and
  sweep, T-6 ground attack, napalm (historically used), jeep, GMC, M3
  half-track, AMX-13, Panhard EBR
- ALN: katibas, ambushes, mines, caves as hidden bases (terrain holes and
  tunnels), night movement, arms smuggled across the borders
- Mechta and dechra villages (stone, flat or tiled roofs, along the ridge)
- Set pieces: the Morice Line (electrified border fence), winter in Kabylie
  (snow system), Casbah of Algiers (1957) as an expansion
- Reading: Horne, *A Savage War of Peace*; Courrière (4 volumes); the film
  *The Battle of Algiers* (1966)
