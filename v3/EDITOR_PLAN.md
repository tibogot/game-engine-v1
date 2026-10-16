# Editor plan: sculpt, paint, texture (2026-10-16)

Goal: the editor makes the terrain for ANY kind of game (user, 2026-10-16): a ~600 m RTS map
(alg-rts), a racing track, an open world, a flight game seen from altitude to the horizon, anything
built on terrain. So features are generic (layers, rules, splines, zones), never one genre's tool. Built from an inventory of the editor and a web survey of Unreal 5.7,
Unity 6 Terrain Tools, Gaea 2.2, World Creator, Houdini, RTS editors (SC2, CoH, AoE IV, Total War) and
WebGPU techniques. One item at a time, between game work (see `/MIGRATION.md`).

## What the editor already has (do not rebuild)

- Sculpt on the GPU: raise/lower/smooth/flatten (+eyedropper), noise, terrace, smudge, contrast,
  thermal erode, Hydro (GPU erosion, cuts only), ramp, mirror, region copy, clone; 35 16-bit stamps;
  brush masks; **height / slope / concavity filters on every brush** (Unity's best feature, already
  there); 25-step undo.
- Procedural: GPU generator (ridge / FBM, warp, dropoffs, 5 presets), droplet erosion (CPU ~12.7 s),
  stream-power erosion (dendritic valleys).
- Paint: 7 layers + base, albedo/ORM texture arrays, per-layer triplanar, height blend, macro variation,
  per-pixel top-3 layers + far blend, live slope/height auto-material with "bake to splat",
  procedural layer bakes, decals, holes, ground cache (opt-in, alg-rts uses it).
- Height layers (`v3/terrain/heightLayers.js`): FINAL = STAMPS(OPERATORS(GROUND)). Rivers v2/v3 are
  already recomputable operators; game stamps (`flattenRect`, `gradeRamp`, `raiseBerm`) are
  re-applied live but not saved.
- World: GPU clipmap, far terrain to about ±4 km; sizes up to 8 km at 2 m/texel (heightmap capped at 4096²).

## The gaps, ranked by value for the effort

1. **Runevision erosion filter as a terrain operator.** Already ported and measured in
   `v3/erosion-lab.html` (`v3/terrain/erosionFilterTsl.js`, about 4-6 ms per bake), not in the editor.
   It does NOT replace "Fluvial (stream power)", which the editor has: stream power is a simulation
   (seconds, written into the terrain) that shapes the big valley network; the filter is a function
   (milliseconds, live sliders, recomputable) that adds the fine gullies and ridges on top, at any scale.
   Complementary. **The lab is NOT finished (user, 2026-10-17): ugly saw-tooth on edges**, which is why it
   was never connected. Before it goes anywhere: reproduce the saw-tooth in the lab, find the cause,
   fix it, and have the user judge the look. Until then it waits; the layer panel (2) comes first.
   As an operator in `heightLayers`: sliders, on/off, saved; also outputs a ridge/gully map for
   texturing, and works for far terrain. Small effort, big look.
   https://blog.runevision.com/2026/03/fast-and-gorgeous-erosion-filter.html
2. **A layer panel** (AUDIT #14). Unreal Edit Layers.
   https://dev.epicgames.com/documentation/unreal-engine/landscape-edit-layers-in-unreal-engine
   - ~~Step 1, sculpt layers~~ DONE 2026-10-17: Scene list → Terrain shows Base + layers (click = brushes
     write there, eye = hide); Inspector: name, visible, strength 0-200 %, locked, add / merge down /
     clear / delete; right-click menu. Generate and heightmap imports write BASE and keep the layers on
     top; undo/redo go back to the layer a step was made in (even hidden or locked); a hidden / locked
     layer refuses new strokes with a message. Saved in the .v3proj (`heightLayers` manifest + blob;
     the heightmap is still GROUND, so games and tools read levels as before). Undo is now a CHANGE
     (before − after), not a picture. Files: `v3/terrain/heightLayers.js`, `sculptBrush.js`,
     `proceduralGenGpu.js`, `v3/io/projectIO.js`, `v3/app/main.js`, `v3/ui/inspectorPanel.js`;
     tests in `tools/heightLayersTest.mjs` (58).
   - Step 2: show the operators (River v2 / v3, game stamps) in the same list, hideable.
   - Known limits: layers are additive, so their order does not matter (no "replace" layers); layer
     operations (hide, strength, clear, delete, merge) are not in the undo history; legacy CPU tools
     (erosion sims, road bake) write the ACTIVE layer, like the brushes.
3. **Pads as saved objects** (Unreal Landscape Patches): a flatten pad (circle/rect, falloff, optional
   paint) placed in the editor, attachable to a building/prop: move the building, the pad and its ground
   paint follow. The maths exists (`flattenRect`, `gradeRamp`); this makes it an editor object. The
   core RTS-map win. https://dev.epicgames.com/documentation/unreal-engine/landscape-patch-system
4. **Roads as an operator, like rivers** (today: live grade, then a destructive "Bake"). Fits the new
   lane roads: one spline system that carves, paints and clears vegetation as a layer.
5. **Gameplay layers for RTS maps**: painted impassable / out-of-bounds / deploy / capture zones,
   saved in the level, with a "why is this blocked" overlay (slope in red, painted in yellow, like CoH's
   editor). Part of the generic markers/zones foundation.
6. **Texturing from erosion data** (Gaea 2.2 / World Creator): the erosion sims and the filter output
   flow, deposition and wetness maps → auto-material rules beyond slope/height (sediment in valleys,
   wet banks, worn ridges); add a curvature rule.
7. **GPU painting + a packed control map** (Godot Terrain3D): today paint is a CPU per-texel loop with
   whole-layer uploads, splat ≤ 2048, 7 layers, and the terrain is at the 16-sampler limit. A
   32-bit-per-texel control map (base id, overlay id, blend…) read with `textureLoad` costs no sampler,
   allows 32 layers and bigger splats, and paints on the GPU. Bigger job; the open-world enabler.
   https://terrain3d.readthedocs.io/en/latest/docs/controlmap_format.html
8. **Biomes + rule-based scatter** (Unreal PCG-lite): a biome = ground rules + grass + foliage + trees
   + rocks; paint a biome mask, everything appears and re-runs on edit. Poisson scatter (AUDIT #21b).
   No biome concept exists today.
9. **Big views and big worlds** (open worlds, and above all a FLIGHT game: at 100 m/s, 8 km is crossed
   in 80 s, and the terrain is seen from altitude out to the horizon): worlds beyond 8 km
   (tiled/streamed heightmap), clipmap detail far out (AUDIT #15f: coarse rings lose detail →
   CDLOD-style morphing), far texturing (macro variation, the ground cache far rings), far terrain
   past ±4 km. Done when the first game that needs it starts.
10. **Polish:** hex tiling on the nearest layer (Mikkelsen 2022, 3 taps), roughness/normal height
    blending at layer edges (AUDIT #6), a "bake erosion here" region sim that writes flow/deposition masks.

## Suggested order

1 → 2 → 3 (each one small, visible, and they build the layer stack together), then 4 with the road work,
5 for the next RTS map, 6-7 for texturing, 8 for open worlds.

Stale lines in `v3/AUDIT.md` to update when touched: #8 (top-N is built: `topK`), #13 ("clone brush" is done).
