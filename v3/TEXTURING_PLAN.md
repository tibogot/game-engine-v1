# Terrain texturing: audit and plan (2026-10-17)

EDITOR_PLAN item 7 ("GPU painting + a packed control map"). Audit read-only; numbers quoted from the
measured notes, not new measurements (Phase 0 re-measures).

## Today

- **Data:** `v3/terrain/splatMap.js` — one RGBA8 array texture, 2 slices: L1-L4 in slice 0, L5-L7 in
  slice 1 RGB, slice 1 alpha = holes; L0 = 1 − Σ. 512² default, 2048² max (8 bytes per texel).
- **Painting:** CPU per-texel loop in JS (`applySplatStroke`), brush filters on the CPU; EVERY stamp
  re-uploads both whole slices (AUDIT #7b, ~+1 ms GPU while painting; three r184 uploads array layers whole).
  Undo = dirty-rect copies, 32 steps.
- **Materials:** `textureLibrary.js` — 7 slots, 1024², albedo + ORM arrays (normal XY packed in ORM),
  anisotropy 8, ~74 MB with mips. Whole array re-uploaded on any map change.
- **Shader:** `splatOverlayTsl.js` — classic (2 taps × 7 layers) or `topK` (2 × K, +K with farBlend);
  the editor, alg-rts and nam-rts run top-3 + far. Live auto-material (slope/height) as a gate.
- **Ground cache** (alg-rts only): bakes the same blend + decals + CoH splats into 7 camera rings;
  the terrain then reads 4 taps. Any paint change invalidates ALL tiles.
- **Sampler budget:** at 16/16 per the notes (6 CSM, 3 paint arrays, surface bake, snow, lakebed,
  2 river sand, cursor, probably IBL). Not re-verified live — Phase 0.
- **Games:** no game paints at runtime. alg-rts paint is built offline by `tools/alg*.mjs` into the level;
  `algSplats.js` reads paint weights to place its splats; rock-lab maps paint slot → grip.

Measured (from the notes): fully painted 7 layers "4.5 ms" before top-K; top-3 at 3840×1778 "35.5 → 33.7 ms";
7 → 4 compiled layers "−1.5 ms"; anisotropy 8 → 1 "−0.59 ms"; alg: "terrain paint shader ~70% of every
view", "a steady 3-4 ms", but "hiding the WHOLE scene saves only 0.9-1.9 ms: the frame is CPU".

## What a control map buys — honestly

- **Not frame time.** Index-based blending (Godot Terrain3D) reads ~as many material taps as today's
  top-3. Expect ±0.x ms, to be measured, not promised.
- **Capability:** up to 32 materials (vs 7); half the paint memory per texel → 4096² paint for the memory
  of 2048² today; GPU painting (no JS loop, no whole-layer uploads); a clean base for layered paint
  (paint under pads / along splines), biomes and rule-based texturing (slope, height, erosion flow).
- **Cost to manage:** 32 material slots at 1024² would be ~340 MB VRAM. Arrays sized to the materials a
  level USES, and KTX2 compression later (AUDIT #32).

## Design

- **Control map:** RGBA8, read with `textureLoad` (NEAREST, no sampler): R = base material id,
  G = overlay material id, B = blend, A = flags (holes; room for nav / no-grass). 4 texel reads,
  manual bilinear weights → up to 8 (id, weight) pairs → the top-K picker that exists today chooses
  2-3 materials → albedo + ORM taps as now.
- **GPU painting:** a ping-pong render pass writes the control map inside the brush rect (paint material
  M: raise M as overlay / base, Terrain3D's rules), brush filters on the GPU (the sculpt brush already has
  them), a dirty-rect readback keeps the CPU mirror for gameplay (`samplePaintWeights`, foliage
  blocking, minimap). Undo: dirty-rect snapshots like sculpt (change-based).
- **Compatibility:** old 7-weight levels convert at load (top-2 per texel → ids + blend) behind a
  per-level switch; the old path stays until every level and game is converted and A/B'd. The ground
  cache and `algSplats.js` read through the same blend / weight API.

## Goal and order (user, 2026-10-17): the BEST-LOOKING terrain textures, very optimized

The look of AAA terrain comes first from blending, anti-tiling and weathering, then from variety, so the
look work goes FIRST, on the current system, and the control map after it. Every step: GPU ms with
`__V3_DEBUG.gpuAB` + screenshot A/B on real maps (fog off), the user judges the look.

0. ~~**Baseline**~~ DONE 2026-10-17. Live, from the compiled shader (stylized-lab, editor): **16/16
   sampler slots** (13 sampler + 3 sampler_comparison), 21 textures — steps 1-3 add no texture, the
   control map reads with textureLoad (no sampler). GPU (gpuAB, tab in front, interleaved):
   stylized-lab in the editor, mid view at 893×644: **terrain = 1.17 ms** (4.69 vs 3.52 hidden, noise
   0.13) — ~4 ms at 1080p, it scales with pixels. alg-rts default view at 1413×702: whole frame
   **1.39 ms GPU**, hiding the terrain changes nothing (+0.06, noise 0.03): the ground cache's 4 taps.
   So every look step reaches alg-rts THROUGH THE CACHE BAKE (it runs the same blend) at ~zero frame
   cost — only the bake gets dearer. Reference screenshot: scratchpad ref_alg_default.png (session only).
1. ~~**Height blend on EVERY channel**~~ DONE 2026-10-17 (AUDIT #6): normal and roughness/AO follow the
   same height-blended weights as colour, so a stone layer pokes through sand instead of fading into it.
   `uHeightBlendChannels` (1 = all channels, 0 = old colour-only) for A/Bs. alg-aures transition at
   x64 z132, terrain only, in ONE load: noise 0.07 mean, change 10.6 % of pixels > 8 levels (mean 3.3) —
   stones keep their own relief where their colour wins. GPU: same shader both ways (+0.28 ms, under the
   0.62 noise); vs the old code only a few `mix` per pixel, no texture tap.
2. ~~**Anti-tiling near the camera**~~ DONE 2026-10-17: `SPLAT_FEATURES.hexNear` (compile switch, top-K
   only) — `hexSamplePair`: albedo + ORM through the same 3 lattice windows, luminance-weighted
   (Mikkelsen's contrast fix), weights normalised before the power (a high power underflowed every
   weight to 0 and showed the sky), gradients taken outside the distance branch, faded out
   uHexEnd − uHexBand → uHexEnd (20 → 30 m). Cells are OFFSET, NOT TURNED by default (uHexRotate 0):
   scanned photos carry baked light and turned cells read muddy (edge energy 48.3 plain, 43.1
   turned, 45.7 offset-only — looks as crisp as plain). Explicit-gradient taps = implicit ones
   (diff 0.04), so no anisotropy is lost. GPU at 0.58 Mpx, whole view inside 30 m (the worst case),
   one load: +0.2..0.45 ms (3 runs, noise 0.3-0.5). Compiled in but not taken: +0.5..1.3 ms across
   loads (throttling laptop, not pinned down) — so it is OFF by default; the editor compiles it
   (`?hex=0` to A/B), close-camera games opt in, the RTS games do not (alg-rts: ground cache).
3. **Weathering rules:** cavity / curvature from the baked surface (darker hollows, worn ridges), then
   flow / wetness masks; rules the auto-material and the bakes use.
   - ~~Cavity~~ DONE 2026-10-17: terrainNormalMap packs (n.x, CAVITY, n.z, h) — normal Y rebuilt in
     surfaceAt/normalAt (regression vs the old bake: mean 0.006, max 8 on one pixel). Cavity = metres
     below the mean of two rings (4 m ×1, 14 m ×0.35), baked per height edit. Shader: hollows darker
     and richer + a little glossier, ridges paler and duller (uCavityDark, uRidgeWear, uCavityDepth),
     paint panel "Weathering", saved in paintBlend (old levels load OFF). GPU: frame −0.06 ms (noise
     0.37), re-bake every frame while sculpting +0.28 ms (noise 0.33) at 1024². No new texture/tap.
     Levels (2026-10-17): 0.5 / 0.35 / 0.6 m in nam-valley, tidewater-bay and the river (ridges 0) / rock /
     stylized labs (the last three are flat — no visible change). The alg-* levels stay 0: alg-rts's
     ground cache has its OWN tuned cavity (groundCache cavityFactor, over splats and decals too), so
     the cache bake calls blend({ weathering: false }) and the hollows are never darkened twice.
     Seen: river banks read as ridges → a pale outline along carved channels (wetness should win
     there — the flow step).
   - ~~Flow / wetness~~ DONE 2026-10-17: flowMap.js (+ flowMapCompute.js, flowMapWorker.js) —
     multiple-flow-direction drainage (Freeman, slope^1.1), log2(upstream texels) in an R8 read
     with textureLoad (no sampler; the device allows 48 textures, 16 samplers). Computed in a
     WORKER ~0.7 s after the last height write, only while wetness > 0: 151 ms at 1024² off the
     main thread (worst frame 21 ms during it). A 3×3 MAX, not a blur: the lines are 1-2 texels
     and a blur halved them (measured: 8-11 octaves → ~5). Values on nam-valley: most of the map
     < 6 octaves, drainage 5-11 → defaults start 4, range 4. Shader: darker, richer, roughness ×0.5.
     GPU −0.01 ms (noise 0.04). Panel: Wetness, Catchment; saved paintBlend.wetness / wetStart.
     Levels: 0.6 in nam-valley, tidewater-bay and the labs; alg-* untouched (cache skips it).
     Limit seen: flat ground beside a carved river does not drain into it, so banks stay dry.
   - ~~Auto-material gully rule~~ DONE 2026-10-17: Auto paint → "Gully layer" + "Gully from"
     (log2 catchment, range 3): a layer where rain gathers, after the cliff and before height and
     flat. Shader (live + preview) and the CPU Bake (splatMap.applyAutoRules, flowBytes) share the
     rule; the Bake brings the flow map up to date first. nam-valley, gully = Dirt road: preview vs
     baked 3.6 % of pixels > 8 levels, 0.1 % > 20 (the breakup noise differs CPU/GPU, as before).
     The flow map is computed while wetness OR an active gully rule wants it. Auto-paint settings
     are still per session (not saved with a level) — as before this step.
3b. ~~**Near detail**~~ DONE 2026-10-17 (chosen over 2048² / KTX2, see below): `SPLAT_FEATURES.nearDetail`
   (compile switch, top-K; editor on, `?neardetail=0` to A/B). Within uDetailEnd (16 m, band 8)
   each chosen layer is read again at a 4× finer tile: the fine read's HIGH-PASS multiplies the
   colour, the fine normal is added, roughness/AO mix. nam-valley 2-8 m: edge energy 7.97 → 8.83,
   brightness unchanged; a plain colour mix LOST detail (7.98 → 7.69). GPU worst case (all pixels
   near) +0.1..0.3 ms at 0.58 Mpx. Why not 2048²: measured texel density — alg valley 3.1 cm,
   nam jungle 1.4 cm, wadi 0.8 cm per texel goes soft only closer than ~29 / 13 / 7 m at 1080p,
   so RTS cameras (60 m+) would see NOTHING from 2048², and close cameras gain more from a finer
   tile at no memory. Compression (KTX2/BC7) stays for shipping (memory, download), not the look.
4. **Control map + read path:** POSTPONED 2026-10-17 until a game needs > 7 materials — the
   inventory (paint shader, holes in slice-1 alpha, ground cache, grass/scatter masks, ~15 game
   reads by slot index, ~17 offline generators, every brush op) makes it several sessions for no
   visible change. data, conversion at load, shader read through top-K. Old path kept.
5. ~~**GPU painting**~~ not needed for smooth painting (2026-10-17, BIG_WORLDS_PLAN 1): the cost was whole-layer
   uploads + a full undo copy per stroke, now rect uploads + lazy undo tiles; 4096² paint is smooth.
   GPU stamping can still come with the control map if the CPU loop ever becomes the limit.
6. **More materials:** arrays sized to what the level uses; then KTX2.
7. **Biomes / layered paint** on top.
8. **DISTANCE anti-tiling — DONE 2026-10-22 (Thunderline):** SPLAT_FEATURES.farTone (top-K, off by
   default): from uToneStart → uToneEnd (250 → 1100 m) each layer fades (uToneAmt 0.85) to the SAME
   texture at a tile uToneRatio (20) × bigger — one explicit-gradient tap in a distance branch. Its
   plain average (last mip) was tried first: no repeat, but the mountains went flat and plastic. Plus
   uMacroBig / uMacroBigScale: a third, LARGE macro-noise octave (0 = unchanged) for whole hillsides.
   The full anti-tiling stack a ground-level game uses (Thunderline worlds.js GROUND_FEATURES): hexNear
   to 45 m → farBlend ×5 (30-110 m) → farTone ×20 (250 m-1.1 km) + macro tint at 70 m and 900 m.
   Seen: the 60 m-high checkerboard of 6 m grass tiles gone; the far ranges' speckled rock repeat gone.
   COST NOT YET MEASURED (needs a quiet GPU).
