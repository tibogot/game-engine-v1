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
4. **Control map + read path:** data, conversion at load, shader read through top-K. Old path kept.
5. **GPU painting** into the control map + CPU mirror + undo.
6. **More materials:** arrays sized to what the level uses; then KTX2.
7. **Biomes / layered paint** on top.
