# Raw WebGPU beyond three.js — what we could use

three.js's WebGPURenderer exposes only part of WebGPU. We can reach the rest on three's own device
(`renderer.backend.device`, `renderer.backend.get(tex).texture`), as Ocean Pro and Sky Pro already do
(raw compute, storage views, timestamp queries — see the Ocean Pro notes and THREE_UPGRADES.md).
Written 2026-10-20 after the "three.js vs Godot / Unity" talk: the real ceiling is the CPU (JS, one
thread; alg-rts measured CPU-bound), so the list is ranked by what takes load off it.

Nothing here is built yet. Each item: measure before and after (the profiler, item 4, first).

## Worth doing (ranked for alg-rts)

1. **Render bundles** — record the static world's draws once (terrain, walls, houses, rocks),
   replay them every frame. three re-encodes every draw on the CPU each frame. three has an
   experimental `BundleGroup`; raw bundles go further. Likely the biggest CPU win.
2. **Game logic on the GPU** — fog of war, line of sight, cover maps, flow fields for many units:
   grid work a compute pass does in a fraction of a ms; results read back with `mapAsync`
   (async, no stall). Takes load off the JS thread.
3. **Higher device limits** — three requests the spec minimums (16 sampled textures per stage,
   4 storage textures per stage — Ocean Pro hit the 4). Most GPUs allow more if the device asks
   for the adapter's limits. If the terrain's "16-sampler limit" (memory: ref_terrain_sampler_limit)
   is the TEXTURE limit, not the sampler one, this could lift it — check which first.
4. **A per-pass GPU profiler** — timestamp queries on every pass (shadows, terrain, foliage, post,
   raw compute). three's timer misses raw compute (Ocean Pro). Build this first: it proves the rest.

## Useful, more targeted

5. **shader-f16** — half precision: half the memory traffic for grass / foliage / particle compute
   and their buffers.
6. **Subgroups** — fast reductions and prefix sums: scatter compaction (instead of atomics), auto
   exposure, fog-of-war counts.
7. **rg11b10ufloat-renderable** — a 32-bit HDR scene target instead of 64-bit float: half the
   bandwidth, cheaper MSAA.
8. **GPU-driven culling → indirect draws** — Hi-Z occlusion (v3 Hi-Z lab) writing draw counts
   directly, no CPU round trip. Multi-draw-indirect is still experimental in Chrome.
9. **GPU picking** — an ID buffer for units and houses instead of CPU raycasts over instanced fields.

## Not in WebGPU at all

Ray tracing, mesh shaders, bindless textures — AAA features, not needed for our games.

## Check before relying on one

Features (`shader-f16`, `subgroups`, `rg11b10ufloat-renderable`, `timestamp-query`) are optional:
test `adapter.features` and keep a fallback. Electron ships Chromium, so the desktop build sees the
same set as Chrome on the same machine.
