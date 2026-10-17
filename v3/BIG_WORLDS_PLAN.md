# Big worlds (open world, flight): measured, then planned (2026-10-17)

The user plans an open-world game and a flight game. Before building anything, the editor was run
at 8 km and measured against the default 2 km (scratchpad stress test, my own Vite + Chrome,
small editor viewport 893×644, laptop GPU).

## Measured

| | 2 km / 1024² height / 512² paint (default) | 8 km / 4096² height / 2048² paint |
|---|---|---|
| Boot to ready | ~7-10 s | ~7 s |
| JS heap at boot | ~300 MB | **1,181 MB** |
| JS heap after generate + edits + erosion + flow | ~350 MB | **1,712 MB** |
| GPU per frame, empty terrain | ~3 ms (terrain ~1.6) | **22-28 ms (terrain ~22)** |
| Generate | 1.5 s, one 1.45 s freeze | 1.5 s, 1.75 s freeze |
| Erosion filter, warm re-bake | 130 ms | **3.0 s, freezes up to 2 s** |
| Flow map (worker, no freeze) | 0.18 s | 3.1 s |

Isolating the GPU cost (fresh loads, same view):

| | GPU | terrain share |
|---|---|---|
| 2 km, 1024² height | 3.1 ms | ~1.6 ms |
| 8 km, **1024²** height | 3.5 ms | ~2.2 ms |
| 2 km, **4096²** height | **16.1 ms** | **~15 ms** |

**The world SIZE costs almost nothing; the HEIGHTMAP RESOLUTION does.** A 4096² heightmap makes
the terrain draw ~15 ms dearer at ANY world size, and it does not depend on screen resolution
(half render scale: same ms) or on what is in view (straight down from 40 m: same ms) — so it is
per-vertex or a fixed per-draw cost on the big textures, not per-pixel. The mesh is the same
~400k vertices at both sizes. Not yet pinned down; first suspects: vertex fetches from the
4096² float textures with no mip chain, and the 256 MB RGBA32F surface bake.

Also seen at 8 km: the editor camera starts inside the generated mountains; the generator's
features keep their 2 km size (an 8 km map reads flat from altitude); every full-map pass
(surface bake, erosion bake + blur + compose, flow map, Generate) is ×16 the work.

## What it means

1. **One big heightmap does not scale.** 2 m detail over 8 km = 4096²: +15 ms GPU and ~1.2 GB of
   CPU mirrors before anything is painted. Detail must be resident only NEAR the camera.
2. **Every full-map job freezes the editor.** Edits must re-bake only the region they touched.
3. **Paint stops at 2048²** (CPU painting) = 4 m per paint texel at 8 km.
4. **Vegetation density maps are one size per world** (512-1024²) = 8-32 m per texel at 8 km.

## Plan (each stage usable on its own; alg-rts / nam-rts checked after each)

0. **Find the 4096² cost** (one session). If it is a sampling mistake (no mips, filtering a float
   texture in the vertex stage, the surface bake read more often than needed), a fix gives every
   map a finer heightmap. Measure with the same isolation.
1. **GPU painting + the control map** (TEXTURING_PLAN step 4, its inventory is done). Paint at
   4096²+, more than 7 materials, no CPU stroke cost. Helps every map, small ones too.
2. **World tiles.** A world = a grid of tiles (e.g. 1-2 km, each a heightmap + paint + vegetation
   at today's resolution); the height stack, layers, operators and bakes work per tile and only
   re-bake dirty tiles; the editor edits across tile borders; saved per tile.
3. **Streaming.** Games keep only the tiles near the camera resident (CPU + GPU), with coarse
   versions further out; the clipmap rings read from a fixed-size resident window instead of one
   whole-world texture. three.js has nothing built in for this (checked r180-r186) — it is ours.
4. **Flight: generated terrain beyond the authored tiles.** The erosion filter is a pointwise GPU
   function, so tiles can be generated at runtime from rules (height noise + erosion + the
   texturing rules), with no size limit and nothing stored; authored tiles (airfields, cities,
   missions) override them. Far-distance detail (CDLOD morphing, macro texturing) for views to
   the horizon.
5. **Rule-based vegetation** (BIOME_PLAN.md core, without presets) — the way to fill tiles nobody
   paints by hand.
