# v3 editor audit — what is left

Compared against Unity and Unreal terrain editors. Last updated 2026-09-14.
Ordered by value inside each section. 👁 = needs you to look at the result in
the game.

## Done so far

- Terrain tile grid base: was 27–33% of the terrain's GPU time, now under 0.1 ms.
- Sculpt stroke hitching: worst frame 59.5 ms → 27.1 ms (rect readback, grass
  reads the GPU surface bake).
- Tree/foliage height resync while sculpting: worst frame 57.7 ms → 26.1 ms.
- Tree and foliage thumbnail palettes.
- Paint layer settings survive a save; layer textures 1024.
- Per-layer triplanar; brush height/slope filters for sculpt and paint.
- Polish: sculpt panel layout, named layer cards, Set Height value + eyedropper.
- Procedural paint layers (Image | Procedural per slot), Genshin grass,
  Genshin path and shore.
- Irregular grass/path edge (height blend from a real blend height); Height
  Blend settings saved in the project.
- Brush stamps (Terrain3D set, MIT, license in `public/brush-stamps/`).
- Large-scale colour variation (paint panel, off by default, ~0.1 ms when on).
- Layers can block grass/susuki and tree/foliage placement (path and shore
  presets switch it on).

## Paint and ground look (the Genshin track)

1. ~~Fix the terrain bake's alpha bug~~ — DONE 2026-09-13. It was two bugs: the
   packed height always read 1, AND negative normal components were clamped to
   0 (every slope facing −X or −Z lit too flat).
2. ~~Retire Procedural Ground and Meadow~~ — DONE 2026-09-13. No saved project
   used either; a before/after render and the grass tint are pixel-identical.
   Paint slot 8's channel (splat slice 1 alpha) is now unused.
2b. ~~Triplanar cost ~4.2 ms with every switch off~~ — FIXED 2026-09-13: now
   compiled per layer only while that layer uses it. Painting cost at 4.76 Mpx:
   all off +5.6 → +1.6–2.1 ms; Rock triplanar on +2.3–2.6 ms. Toggling a layer's
   Triplanar recompiles the terrain shader (one-off pause).
3. **More Genshin textures** 👁: cliff rock, forest floor, wet sand, snow.
   **CLIFF ROCK — done differently, 2026-09-18: no texture at all.** A terrain
   cliff painted with a tiling rock texture can never match the procedural rock
   and cliff PROPS, because the drawn cracks and pebble blobs are exactly what
   the props do not have: a boulder standing against a painted cliff always
   read as a different material (checked side by side in the editor first).
   So a paint layer can now be SHADED like the props instead: Paint → layer →
   "Rock shading". The layer drops its albedo and runs the props' own recipe
   (v3/props/rockShading.js, now shared: `rockShadeUniforms`, `rockShadeTint`)
   off terrain data (v3/terrain/cliffRockTsl.js) —
   "how high on the rock" becomes height above the surrounding land (four taps
   at ~70 m; measured close, every point on a long face reads equally high and
   the wall comes out one flat value), and the chip-edge light becomes
   convexity over a short step (~9 m). Undersides, mottling and the base-to-top
   gradient are the shared code, so tuning the rocks tunes the cliffs.
   No new sampler (it re-reads the baked surface texture the terrain already
   samples — the fragment stage is at 16/16) and compiled per layer like
   triplanar, so a layer that does not ask for it pays nothing. The layer keeps
   its ORM and tint. Saved per layer (`rockShade`).
   Measured interleaved (6 rounds x 120 frames, rock layers over most of the
   view): 2.48 → 2.85 ms GPU, **+0.37 ms**.
   OPEN, for the look pass: the shared stone is very PALE (the props' base is a
   light cool grey), so a whole mountain reads near-white — both should
   probably come down to a mid grey, which is one shared knob. Also unjudged:
   whether the ridge highlight reads as chipped rock or too soft.
4. ~~**Target strength.**~~ — DONE 2026-09-17. Paint panel → Target strength
   (5-100%). The stroke core (splatMap.applySplatStroke) lerps the layer toward
   the TARGET instead of full weight and skips texels already at or above it,
   so scrubbing settles at the target (0.298 at 30% after 40 real strokes) and
   a low-target stroke never strips stronger paint. Other layers still make
   room and weights still sum to 1. Test: tools/paintTargetStrengthTest.mjs.
5. ~~**Per-layer tint and UV rotation**~~ — DONE 2026-09-17, to reuse one
   texture twice. Paint → layer settings: Tint (colour multiply, Reset = white)
   and UV rotate (0-359°). Saved in the project per layer; older files load
   white and unturned. The swatch shows the tint.
   Shader (splatOverlayTsl): one vec2 rotation per layer shared by its albedo
   and ORM taps, so no extra taps and no new sampler (the terrain is at 16/16).
   The normal map's tangent frame turns with it. Triplanar side projections
   stay unturned. The height blend reads the UNTINTED colour, so recolouring a
   layer does not move its edges.
   Measured INTERLEAVED (8 rounds x 120 frames, whole screen on a tinted 45°
   layer, 1745x808 @1.1): 3.164 -> 3.186 ms GPU, **+0.022 ms**, every round
   the same sign. Test: tools/paintLayerTintRotationTest.mjs.
6. **Roughness and normals at layer edges** still mix linearly (only visible on
   photo textures).
7. ~~Splat size allowed up to 4096~~ — CAPPED at 2048 2026-09-14, measured
   first: at 4096 a stamp costs 30 ms CPU (7 ms at 2048), a stroke start
   24-70 ms, ~300 MB of CPU copies. Older 4096 configs/projects clamp or
   resample to 2048.
7b. **Every paint stamp re-uploads both whole splat layers.** Measured at 2048:
   painting frames 23 ms median (16.7 idle), p90 29 ms, and a 50 ms hitch at
   stroke start (three full-size copies for undo). Fix: upload only the
   stamp's rectangle, and copy only the stroke's rectangle for undo.
   **RE-MEASURED 2026-09-17 — no longer felt, not fixed on purpose.** Same 2048²
   paint, stamping every frame (`__V3_DEBUG.paintSys` drives strokes): 15 m
   brush 16.7 ms median / 17.3 p90, 0 of 270 frames over 20 ms; 40 m brush the
   same; 80 m brush 2 of 120 frames over 20 ms (5.5 ms stamp CPU — brush-area
   work, not the upload). Stroke start 3-5 ms, not 50. What remains is ~+1 ms
   GPU while painting from the whole-layer uploads; the rectangle upload would
   mean writing the GPU texture behind three's back (three r184 uploads array
   layers whole), a real risk for a cost that is not felt. Reopen for a weaker
   machine.
8. **Top-N layer sampling.** A fully painted world costs 4.5 ms because all 7
   layers are read. Only worth it once worlds are heavily painted.
9. ~~**Procedural slider edits have no undo.**~~ — DONE 2026-09-17. Procedural
   paint layer edits (sliders, colours, pattern, seed, presets) are ACTIONS in
   the paint history (PaintSystem.recordAction), interleaved with strokes, so
   Ctrl+Z in Paint mode walks back through both in order. A step restores the
   settings, tile size and the path preset's blocks-grass/trees flags, and
   re-bakes. A slider drag is ONE step (same key < 800 ms apart; a stroke in
   between splits it; a drag back to the start leaves none). Verified live: a
   12-tick drag = 1 step, undo 55 → 8 with re-bake, redo back to 55.
   Also fixed on the way: paint history was never cleared on project load, so
   Ctrl+Z could paste the previous project's pixels into the new one —
   `paintSys.clearHistory()` now runs with the other history resets.
   Not covered: switching a slot's SOURCE (image ↔ procedural) — restoring an
   image needs its pixels. Test: tools/paintHistoryActionsTest.mjs.

## Sculpt

10. ~~Heightmap import/export in 16-bit PNG and RAW~~ — DONE 2026-09-13. Sculpt
    panel → Heightmap File (and the toolbar Load accepts .png/.raw/.r16). Round
    trip within half a 16-bit step; other sizes are resampled.
11. ~~Concavity filter~~ — DONE 2026-09-13. Brush filter → Concavity (hollows or
    ridges, radius, min depth, softness), sculpt and paint.
12. ~~Terrain holes~~ — phase 1 DONE 2026-09-13. Paint → Hole card (Alt fills
    back in): see-through terrain and shadow pass, grass/trees/foliage kept
    out, on-foot play falls in (underground rule + respawn), saved in the
    project. Cars, ball and plane still see solid ground.
    Phase 2 DONE 2026-09-13: Tunnel mode (O). Click both mouths; horseshoe
    rock tube with a walkable floor, openings cut automatically (their own
    hole source, re-cut after sculpting), collision, undo, saved.
    Phase 3 DONE 2026-09-14: caves on the same tool — Cave style (rough
    organic walls, flat floor), per-node size (chambers), closed ends (dead
    ends, one-entrance caves).
    2026-09-14 also DONE: dig-in entrances (ramp cutting + headwall built as
    mesh + opening, follows terrain edits), baked interior lighting (lamps,
    daylight at mouths, zero per-pixel cost), vehicles (car, stunt car, ball,
    plane) use openings and tunnel floors. Remaining: characters are not lit
    by the baked tunnel light.
13. ~~**Mirror, clone, copy-paste**~~ — DONE 2026-09-17, all three slices
    (terrain tools, not objects). Mirror: make one
    half of the terrain the mirror image of the other (symmetric maps). Clone
    brush: Alt+click a source, paint to copy its heights and paint elsewhere.
    Region copy-paste: copy a rectangle of terrain, paste it with rotate / flip
    / height offset.
    **MIRROR — DONE 2026-09-17** (slice 1 of 3). Sculpt → Mirror: Left/Right,
    Front/Back or Rotate 180 (point symmetry for two-player maps), keep the
    −/+ half, optional seam blend (Rotate starts at 30 m — a half-turn does not
    meet itself at the centre line), ground paint on/off, Apply.
    Heights: one full-map GPU pass (sculptBrush.mirror) reading the PRE-STROKE
    copy, so it never samples its own target; texel centres map onto texel
    centres, so the copy is exact. Paint + painted holes: the CPU twin
    (splatMap.mirrorPaint) with identical conventions, reading a pre-copy
    because the blend band reads across the axis.
    ONE undo step for both: sculpt strokes can now carry an attached
    `{undo, redo}` (sculptBrush.attachToStroke), restored with the heights.
    Paint undo keeps only the half + band that can change.
    Verified live on a generated 200 m terrain (54 of 81 left/right sample
    pairs differed by > 1 m): after Left/Right all 81 match to 0.00 m and the
    kept side is untouched; Rotate 180: 176/176 point-symmetric pairs, 0.000 m
    outside the seam, 1.27 m max step across the centre line over 2 m; paint
    blobs land at the symmetric points; undo/redo walks mirror → generator →
    mirror both ways with heights AND paint restored at each step.
    Not mirrored (stated in the panel): grass/foliage/flower/snow density,
    trees, props, roads, rivers. Test: tools/terrainMirrorPaintTest.mjs.
    **REGION COPY-PASTE — DONE 2026-09-17** (slice 2 of 3). Sculpt → Copy:
    drag a rectangle to copy heights (GPU clipboard RT, sculptBrush.copyRegion)
    and paint + painted holes (CPU patch, splatMap.copyRegionWorld); then every
    click pastes under the cursor. Rotation (free, +/-90 buttons), Flip X/Z,
    Height: Match ground (lines the copy's edge mean up with the edge mean of
    the ground it lands on) or Keep heights, plus an offset, Edge feather, Ground
    paint. Esc cancels a drag or clears the copy; the copy survives a project
    load, so terrain can move between worlds.
    One convention for GPU, CPU and the outline: world = centre + R(angle) *
    local on (x, z), R = [[cos, -sin], [sin, cos]], flips in local space. The
    paste pass goes BACK into clipboard space per destination texel, reads the
    destination from rtScratch, and renders only the turned box's bounds.
    Each paste is one sculpt stroke with the paint attached (one Ctrl+Z).
    Verified live on generated terrain: a 161 x 122 m copy pasted with Keep
    heights / no feather matches the source within 1.1 m where the source spans
    59-129 m (the residual is sub-metre click alignment on steep slopes); Match
    ground + 90 deg + 12 m feather onto a low flank lifts the centre 0.9 → 21.4 m
    with no step at the box edge; undo restores the destination to 0.000 m and
    redo reapplies. The outline drapes on the ground (yellow while selecting,
    blue turned preview while pasting).
    TRAP: three's WebGPU renderer does not draw THREE.LineLoop — it logs an
    error EVERY frame (25,560 in one test) and draws nothing; a `visible` check
    still passes. Use a Line closed by repeating its first point.
    **CLONE BRUSH — DONE 2026-09-17** (slice 3 of 3). Sculpt → Clone: Alt+click
    sets the source (magenta ring on the ground), then paint. Aligned (the
    source follows the brush, Photoshop-style) or fixed source; Height: Match
    ground (shifts the copy by the height difference between source and brush
    point at stroke start) or Keep heights; Opacity (default 60%); Ground paint.
    Heights: sculptBrush.clone reads rtPreStroke at uv + offset, so a stroke
    never re-clones its own output when source and destination overlap; blend =
    falloff^k × opacity × edge fade, nothing written where the source is off
    the map. Paint + painted holes: the CPU twin (splatMap.beginClone /
    cloneStamp / endClone) reads a snapshot taken at stroke start and returns
    before/after patches of the touched rect, attached to the sculpt stroke —
    one Ctrl+Z for the whole stroke, heights and paint together.
    Verified live on generated terrain: cloned heights match the source within
    0.43 m; undo puts the destination line back exactly, redo reapplies
    exactly; a painted blob clones 127 → 125 texels and undo returns it to 0.
    Test: tools/terrainClonePaintTest.mjs (no smear on overlap, opacity
    convergence, holes, off-map source, exact undo/redo patches).
    Test: tools/terrainRegionPasteTest.mjs (18 checks: in-place no-op, move,
    rotate 90 direction, flips, feather, holes, exact undo patch, off-map).
    Still to do: clone brush (slice 3).
14. **Non-destructive edit layers** like Unreal's. Large; roads and rivers
    already do this per tool.
15. ~~Modifier keys in the hints~~ — DONE 2026-09-14. The sculpt panel
    already had them; it now also lists Shift/Alt+scroll. The ? overlay was
    sculpt-only and out of date: rewritten by group (camera, sculpt, every
    brush, props, mode keys, project), each checked against the key handlers.

## Editor polish

15e. ~~Brush cursor ring~~ — FIXED 2026-09-18 (user: at a small radius the
    circle gets a big width). The outline was two hard steps at a FIXED
    ±0.003 of heightmap UV — about 6 m of ground whatever the brush, so a
    60 m brush drew a thin ring and a 5 m brush drew a band wider than
    itself; it also thickened as you zoomed in and had no antialiasing.
    Now the width comes from the distance field's own pixel footprint
    (`fwidth`, capped at a quarter of the radius), i.e. constant on screen
    like Unreal/Unity: MEASURED median 3 px at both a 60 m and a 5 m brush,
    2-3 px with the camera at 14 m instead of 90 m. Added the filled falloff
    preview underneath (10% of the cursor colour) built from the brush's real
    footprint, mask^falloff — the same the sculpt pass applies — so a square
    or diamond brush previews its own shape. A per-mode `uCursorFalloff`
    uniform feeds it. Editor-only code, compiled out of games.

## Grass and vegetation

15b. ~~Grass floats over crests / sinks into dips~~ — FIXED 2026-09-17. The
    grass was right: it read the exact heightmap (within 3 mm). The terrain
    MESH is not the heightmap: clipmap vertices sit on texel corners (a
    [1 2 1] blur, 0.86 m float on a 60° crest even at 1 m quads) and the outer
    rings are 2-16 m quads centred on the ORBIT TARGET, not the camera
    (measured up to +1.5 m over crests, -5.1 m in dips). The grass compute now
    rebuilds the clipmap triangle under each visible blade, stitching fans
    included (`terrainSurface` option, 3 taps, only for blades that pass the
    cull): max blade-vs-mesh error < 0.05 mm over ~600k blades in 4 views
    (was mean 8-33 cm, max 8 m). Cost ≈ +0.01 ms per ring dispatch at 109k
    visible blades. Also: the grass height bake now sizes itself to the
    heightmap (was a fixed 1024, so a 2048² project stood on half-res ground).
    Still open:
    - **Terrain-side mismatch** (trees, props, player, susuki and flowers all
      use the exact heightmap, so they float/sink the same way): vertices on
      texel centres, and maybe centre the editor clipmap on the camera.
    - Susuki and flowers do not use `terrainSurface` yet.
    - Grass ignores snow displacement of the terrain (as before).
    - Bake staleness after undo / generate / erosion / project load: checked
      after a whole-map replace only.
15c. ~~Terrain tint sampled the wrong half of the world~~ — FIXED 2026-09-18.
    The grass tint bake (main.js grassTintCam) flipped world X for the render
    target's axes but never Z, so blades took the ground colour MIRRORED in Z.
    Invisible while the ground was one colour; with the Genshin preset (tint
    at full takeover) it showed as grey-blue blades nowhere near any rock.
    MEASURED: painted rock at world z = +300, read the bake the way the blades
    do — green at +300, grey (sat 0.14) at -300; after swapping the camera's
    top/bottom, grey at +300 and green at -300, with X still correct.
15d. ~~Grass took the colour of rock, and grew on it~~ — FIXED 2026-09-18
    (user: "the tint is for matching ground grass texture, not to blend a
    blade with a rock texture, and there shouldn't be grass where the cliff
    texture is").
    - The tint bake now HOLDS OUT every layer flagged "Blocks grass"
      (splatOverlay.blend gains `layerKeep`; applied AFTER the auto-paint
      rules, so an auto-painted meadow still counts and only the auto-painted
      rock is dropped, and the removed share goes to the layers still painted
      there rather than to the base tile). MEASURED: tint over a rock blob
      went from grey (sat 0.14) to the meadow green (sat 0.87).
    - Rock/cliff procedural presets now set "Blocks grass" (and trees) like
      the path presets already did. MEASURED: blades inside a rock blob
      55,340 → 7,123 (the rest is the paint's soft edge), unchanged outside.
    - Both grass presets turn slope rejection ON, so the terrain field stops
      climbing steep faces; a cliff's grass is the cliff-top layer's job.
    - The far-field terrain colour needed no change: it already reads the
      MASKED density, so it paints nothing on a blocking layer.
16b. **Grass presets** — DONE 2026-09-18. `app/state/grassPresets.js` +
    a Preset dropdown at the top of the grass Appearance section: "Ghost of
    Tsushima" (today's realistic defaults, restored exactly — verified by a
    round trip) and "Genshin / Zelda" (blades take the ground colour at full
    tint, flat shading, 3 segments, wider blades, little SSS). A preset is
    only a set of panel values, applied through mergeKnownKeys; everything
    stays editable after. New control it needed: "Shade variation" (the
    per-blade and per-clump brightness scatter, 1 = realistic, 0 = flat) —
    the far-field colour uses the same value. Cost, same scene interleaved:
    GoT 3.30 ms, Genshin 2.77 ms. projectLookSaveTest now checks every preset
    key is a real grass setting and that no preset carries paint or view state.
16. **Grass panel cleanup** 👁: 59 controls, 16 of them two hand-placed light
    directions. Named presets plus a few real controls.
17. **Grass look pass** 👁: match the Genshin ground colour.
18. ~~Grass horizon~~ — DONE 2026-09-17, the Ghost of Tsushima way (their far
    LOD is a texture on the terrain). Past the last blade ring the terrain
    paints the colour the blades average to wherever grass is painted
    (`render/grass/grassFarTsl.js`, density read in the terrain VERTEX stage,
    feature flag `grassFar`). Blades and ground share one colour formula
    (`v2/render/hybridGrass/grassFieldColor.js`) and converge over the same
    band (180→360 m, or 80→180 m without Far blades), then the last ring
    shrinks away. Terrain cost: not measurable (2.741 vs 2.734 ms). Also:
    - Even thinning like GoT's "drop 3 of 4 blades": Far ring 2.08 m → 1.56 m
      spacing (384² → 512²), blades 0.7 → 0.5 m wide, 1 → 2 segments.
      Saved projects keep their own Mega width/segments.
    - "Far blades" toggle (LOD section), OFF by default (user choice): blades
      end at the Mid ring; saves 0.10 ms render.
    - Dark ring before the hand-off (reported 2026-09-17), MEASURED by row
      brightness from a low camera: a dip to 57 at ~95 m between 68 near and
      75 far. Not the AO (AO off kept the dip); it was the Mid ring's dark
      lower blade (root colour + AO ×0.55 floor) where it fully covers the
      ground, next to a field colour sampled from the upper blade only. Fix:
      field colour averages the whole blade height, and the far-ring AO floor
      is a "Far AO" slider (default 1.0, was a hard-coded 0.55). Now a smooth
      fade 68 → 60 → 59.
    - Blade folding (GoT: a short blade's vertices make two blades), DONE
      2026-09-17: blades shorter than "Fold below" × Blade height send their
      cross ribbon off as a separate blade (own spot in the blade cell,
      facing, 0.6-1x height). Same vertices, no measurable cost (3.162 vs
      3.127 ms). Default 1.1× = the shorter half (measured blade heights:
      0.65-1.5 m, median 1.09, 51% under 1.1 m at Blade height 1).
    - Mid ring at 3 segments (GoT far LOD is 7 vertices): +0.06 ms, not
      visible at 80-200 m on a 1296 px view; kept at 2 ("Far segments").
    - Clumping made GoT-style, 2026-09-17: nearest clump over the 3×3
      neighbouring cells (was the blade's own cell only, which cut clumps on
      straight cell edges), clump height/shade/facing/lean from their own
      random (was the same random that placed the centre), and "Clump pull"
      moves blades toward their clump centre (tufts with gaps). Near ring
      compute per dispatch, A/B against the committed module: 0.087-0.097 ms
      before, 0.069-0.099 ms after (38k visible blades).
    - Painted blade height (GoT's artist height data), DONE 2026-09-17: grass
      brush target "Height" eases a separate 512² layer toward a target
      (0.25-1.95× Blade height; Alt = back to 1×; Fill all / Clear all set or
      reset the field). Own layer because every density write fills all four
      channels, so old saves would read as random heights. Saved as
      `grassHeight` (absent = 1×), undo/redo on the grass stack (entries now
      tagged terrain/cliff/height). Verified: painted 0.30×, blades in the
      strip measured 0.31× the blades beside it; undo and redo exact. Cost:
      +0.003 ms per Near dispatch (noise); the cull pad doubles for 2× tall
      blades, ~3% more blades kept on screen.
    - Push field (GoT displacement buffer), DONE 2026-09-17 — item 19 too:
      `render/grass/grassPushField.js`, 256² over 64 m around the grass
      anchor, scrolls in whole texels like the snow trail. Play mode stamps
      the pawn (and each wheel of a car, spaced along the path); games call
      `stampGrassPush(x, z, radius, strength)`. Pushes recover over "Trail
      recovery" (default 2.5 s); "Trail strength" scales the bend. Near rings
      read it with one tap. MEASURED: one pass ≈ 0.09 ms, and passes run only
      while something stamps or recovers — 0 when idle, and 0 again once a
      pawn has stood still for the recovery window (checked in play mode:
      30/30 passes per half second, then 0/31). Near dispatch +~0.005 ms.
      First look was wrong (user, 2026-09-17), three causes measured:
      stamps pushed RADIALLY, so each new stamp pushed the grass behind it
      backward (trail leaned toward where the walker came from) — stamps now
      carry the motion direction (centreline after a walk: push 0.64, 0.63 of
      it forward); the push SHEARED the tip and squashed the blade — it now
      rotates the blade about its root, up to ~75° at the tip; and the old
      one-point player push ignored height, so a jumping player still bent
      grass — it fades out above the blade tops (extra bend near the player
      1.02 standing, 0.07 at a 2.9 m jump apex).
      Not yet: susuki, flowers and foliage still use their own one-point push.
    Still open for the GoT match: dithered terrain grass shadows in the far
    field. Ground UNDER near blades is still the painted ground (a GoT-look
    project should paint a grass-coloured ground there, or add a control).
19. **Trails through grass** from cars and characters (reuse the snow trail
    pattern).
20. **One global wind** for grass, susuki, trees and water.
21. **Fold susuki into the grass panel** (optional, touches undo). Merging the
    five vegetation modes is NOT recommended: undo is routed by mode and 23
    handlers are mode-gated.

## Roads — lane-based engine (v3/roads/), the target

Goal: a road builder at the level of Unreal/Unity road plugins, for a full
car-game city (GTA, Neverness to Everness, Forza Horizon). Smart Road 2 stays the
live road mode until this matches it; items 22-27 below are its old gaps.

Done:
- 2D engine + lab (`npm run dev:roads`, tools/laneRoadTest.mjs): alignments,
  lane stacks and sections, profiles, junctions, roundabouts, splits, derived
  markings, lane graph, blocks and lots, props by rule, traffic sim.
- 2026-09-14: 3D preview in the editor — Lane road mode
  (`editor.html?laneRoad=junction`). Flat ground only. Asphalt lanes and pads
  (earcut, island holes), 15 cm sidewalks with beveled curb faces, raised grass
  medians, roundabout apron + island + splitters, markings as thin geometry.
  4 draws; all three test scenes 12.6k triangles, ~20 ms rebuild; GPU +0.13 ms
  overview, +0.66 ms road filling the view, paint below timer resolution.
  tools/laneRoadMeshTest.mjs.

### Markings in the road shader

**DONE 2026-09-14 (50 + the lane-road half of 51 + 52)** 👁 — needs your eye:
- `v3/render/roads/laneRoadPaint.js` paints through a new `opts.paint` hook in
  modularRoadMaterial, built as `opts.plainDeck` (aZone/aCurve/aPlain become
  shader constants; the track's default path is unchanged, road material
  suites green). Paint is shaded by the track's own paint/wet terms.
- Lines along roads: analytic from `aEdges` (lateral position + style code,
  dash-run phase in the fraction), same rules as the lab (`sectionLines`).
  Checked against the engine's line data headless: straight lines exact, bent
  lines by painted fraction (the lab measures dashes along each offset line,
  the shader along the centreline — phases slide ~1.75% on a 400 m bend).
- Junction shapes: RG8 signed-distance atlas (`markingAtlas.js`), 6 cm
  texels; 4-way junction 3 MB / 5 ms, three test scenes 8.8 MB, downtown
  24 MB / 48 ms.
- Wear: the city street's edge-eating model (fraction of each shape's width);
  node shapes skip the wheel-path term so a worn edge does not step at the
  pad boundary. Weather panel: wet toggle (material swap), wetness, puddles.
- GPU at a road-filling view (1347×849): road hidden 1.44 ms, asphalt without
  paint 2.29, with paint 2.56 (+0.26), wet 2.95 (+0.39).
- Found, not changed: the engine does not interrupt bike and edge lines at
  crosswalks (a 25 cm bike line runs through the zebra bars, in the 2D lab
  too). Fix in `INTERRUPTED` / markRange if wanted.
- Left: the track deck and city street still use their own paint/asphalt
  (the other half of 51); atlas paging for city scale.
- 2026-09-14 later: bike/edge lines now break at crosswalks (engine rule,
  `CROSSING_INTERRUPTED` + `rr.walkRange`; test finds 56 crossings without it).
- 2026-09-14 later: **51 started** — `v3/render/roads/asphaltSurface.js` is the
  city street's surface re-keyed to a road frame (cellular stones, streaked
  macro, resurfacing patches, gloss variation, relief normal in road metres
  instead of screen space, wet with kerb drainage via `aPiece.y`). Lane road
  uses it; concrete got the city's slab joints and colours. GPU same view:
  previous asphalt 2.56 ms → city surface 2.49 (dry), 2.95 (wet). The city
  street and track deck can switch onto it next, each A/B'd.
- Road width: game city lanes are 8.5 m (34 m, 4 lanes) vs the engine's real
  3.0–3.25 m and a 2.10 m car. User chose a **road scale** setting — DONE
  2026-09-14: `data.roadScale` / `opts.roadScale` (1 = real) scales carriage
  lanes, medians, section lanes, corner radii and roundabout rings; sidewalks,
  paint and curves stay real. 2D lab and editor panel inputs; editor preview
  defaults to 1.3 (~4.2 m lanes). All demo scenes build at 1.3 with no errors.
  Pick the final value by driving on it (needs collision — later step).

The original plan, for reference:

50. **Paint in the asphalt shader, sharing its wear and wetness** 👁. Geometry
    paint cannot share the asphalt's wet film or eat its edges the way the
    modular-road city street does (wear subtracts from the line's WIDTH, which
    needs distance-to-edge in the shader), and thin lines shimmer at distance.
    - Lines along the road (~80-90% of paint): analytic per lane strip from
      edge line type/width/colour/dash attributes; wear bites the width; fwidth
      AA fades sub-pixel lines to average coverage. No texture.
    - Junction shapes (bars, stop/yield, arrows, hatch, ring lines): small
      signed-distance atlas per node area (5-8 cm texel; downtown ~one 4096²
      page, ~16 MB), same width-erosion wear. One sampler.
    - The asphalt deck is at WebGPU's 8 vertex-buffer limit: fold constant
      attributes into material options and pack the rest.
    - Remove the geometry paint mesh once this ships.
51. **One shared asphalt function** taking a road frame {along, across,
    lateral, wheelPath}: asphalt + paint + paint wear + wet (wetRoad).
    Lane roads first; track deck and city street switch over later, each A/B'd.
    Ends the city street's hand copy drifting from the track asphalt.
52. **Wetness in the editor**: wet amount / puddles panel (planar car
    reflections stay game-only).

### Surface and look

53. Coloured lane surfaces (red bus, green/blue bike, hatched fills).
54. Curb types: dropped curbs at crossings and driveways, flush curbs, granite
    vs concrete.
55. Sidewalk paving that follows the street, joints, tree pits.
56. Road crown and gutters so water pools at the curb (feeds 52).
57. Surface decals: manholes, drain grates, patches, cracks, oil, skid marks.
58. Grime and occlusion at curb bases and road edges.
59. District surface presets: new/old asphalt, concrete slabs, cobblestone, brick.
60. Night: retroreflective paint under headlights, raised pavement markers.

### More markings

61. Region styles EU / US / UK / JP.
62. Crosswalk styles: zebra, ladder, continental, piano.
63. Box junctions, bike boxes, dotted turn guide lines through junctions.
64. Text and symbols: STOP, BUS, TAXI, SLOW, speed numbers, bike, disabled,
    school zone.
65. Parking: angled, perpendicular, T-marks, loading zones, UK zigzags.
66. Merge / lane-drop / roundabout lane arrows, highway chevrons and gores,
    rumble strips.

### Geometry

67. ~~Terrain fitting (roadConformSystem), junction elevation blending on slopes,
    superelevation in curves.~~ **DONE 2026-09-15** 👁 (not committed yet):
    - `v3/roads/roadSurface.js`: every node sits on a plane fitted to the
      ground (junction ≤ 5 %, roundabout ≤ 3 %, ends/continuations ≤ 3 %
      across); a road IS that plane from its node to 4 m past the mouth, then
      blends into its own profile. Terrain profiles grade-limit outward from
      those pinned stretches. Node heights relax toward each other until every
      road can make its climb (hills test went from 119 % steps to all roads
      within limit; junctions move up to ~3.4 m in cut/fill). Mouth gap 0.000 mm,
      asphalt step across mouths ≤ 1.2 mm.
    - Crown 2.5 % per carriageway (the same crown line as the shader's drain
      coordinate), banking = curveDesign e on spiral road types (rural,
      motorway, ramp); city streets crowned only. Mesh splits strips on the
      crown line (+160 tris on the three scenes); warm mesh build unchanged
      (~21 ms, 13 of it the atlas).
    - Terrain grade: the lane road's OWN RoadConformSystem (base on mode entry,
      live re-grade restores the last, Bake / Remove grade buttons); shared
      `conformToRoadSurface` got per-footprint `halfWs` (Smart Road path
      bit-identical, 40 random cases). Target: surface − 0.3 m inside the
      footprint, sidewalk top − 5 cm past it, 14 m shoulder. Grade 85 ms warm on
      a 1 m-texel map (~¼ on the default 2 m), per edit only.
    - Collision `{ deck, solids }` (the game city's shape): deck = drawn meshes,
      solids = collision-only 0.5 m walls round roundabout islands, splitters
      and raised medians. Driven: kerbs climbed, island wall stops the car
      (0 = drive over it).
    - Play wheel **Game car (key 9)**: `v3/play/gameCarMode.js` drives the
      game's v3 Vehicle at its fixed 1/120 s tick (the stunt car is the old v2
      copy). Pick the final road scale with it.
    - GPU, eye-level road-filling view: road hidden 1.18 ms, shown 1.57 ms.
    - Left: batter slopes (shoulder is a fixed width, so a deep cut still reads
      steep), gutter pooling on banked curves (shader pools both edges), lane
      road not in the on-foot collider, network not saved in the project.
68. Driveways and alley entrances with curb cuts, bulb-outs, pedestrian refuge
    islands, median openings for turns.
69. Bus bays, lay-bys, parking lots, fuel-station aprons.
70. Bridges (deck, girders, piers, railings, expansion joints), tunnels with
    lights, overpasses with retaining walls, embankment and cut slopes.
71. Interchanges (cloverleaf, diamond, flyovers, multi-level ramps), 5-6 arm
    and staggered junctions.
72. Engine quirk: a raised median's end cap reaches ~0.45 x its width past the
    road end (into a dead-end sidewalk cap). Mesh uses median 18 cm vs curb
    15 cm to avoid coplanar faces; fix the cap in the engine.

### Props by rule

73. Traffic lights with signal phases; signs from lane data (stop, yield, speed,
    lane direction, street names).
74. Street lamps with night light pools, guardrails, Jersey barriers, bollards,
    fences.
75. Bus shelters, benches, hydrants, bins, utility poles and wires, billboards.
    All instanced (see 38-40 for the city-scale prop costs).

### Traffic and life

76. Render traffic on the lane graph (sim exists), obey signals and yield/stop.
77. Pedestrians on sidewalks and crosswalks; parked cars in parking lanes.
78. Racing lines and GPS routing on the lane graph; minimap.
79. Curb and island collision for car physics; surface types for tyre audio
    and grip (paint, asphalt, cobble, wet).

### City

80. Blocks and lots feed the city building system; districts and zoning pick
    road types and surface presets; street network generator; alleys;
    entrances meet sidewalks. Ties into 33.

### Editor and scale

81. Draw roads in 3D with snapping; drag nodes and PIs; lane stack and section
    editing in the viewport; junction editor (corner radius, crosswalks,
    control); engine issues shown in 3D; undo/redo; saved in the .v3proj.
    Then switch the road mode from Smart Road 2.
82. Chunked meshes for culling, per-road dirty rebuilds, build in a worker.
83. Cheaper far asphalt (full-screen road costs +0.66 ms today), shadow budget
    per chunk.

Suggested road order: 50-52 → 67 → 70 → 73-75 → 76-77 → 81 → 82-83 →
61-66 + 57 → 80.

## Roads — Smart Road 2 gaps (superseded by the lane-based engine)

22. **Per-edge road types.** One global width and profile today.
23. **Road undo.** None exists.
24. **Roads don't touch the ground.** Grass through the deck, no shoulder. The
    path texture and "Blocks grass" could be applied along the footprint.
25. **Road materials** with UVs that follow the road.
26. **Overpasses and piers, merges, junction polish, decorators, ramps.**
27. **Whole-network rebuild per edit; no grade limit or banking.** Bites around
    50 edges.

## Editor in general

28. ~~Select objects in the viewport~~ — DONE 2026-09-14 (View mode left-click;
    terrain in front hides objects, except at tunnel holes). (Unity/Unreal basics). Today only props
    select (right-click, Props mode only); tunnels, rivers, lakes and roads only
    inside their own mode. Wanted: left-click in View mode picks what is under
    the cursor (props, live props, tunnels/caves, rivers, lakes, roads, player
    start) with an outline and its inspector; props get the gizmo, spline
    objects open their mode with that item active. Painted trees, foliage and
    grass stay brush-edited (Unity cannot select terrain trees either).
29. ~~A real Scene list (outliner)~~ — DONE 2026-09-14 (groups, click, double-
    click frames, eye hides in the editor only; everything shows in play). The left panel only says "Terrain". List
    every object grouped by type; click selects, double-click or F frames it.
30. ~~Shared shortcuts~~ — DONE 2026-09-14: Shift+F frames (plain F stays
    Foliage), Ctrl+C / Ctrl+V props (paste at the cursor), Ctrl+D tunnels; props
    already had Delete / Ctrl+D / Esc / W E R Q.
31. ~~Textures from dropped local files don't survive a reload~~ — DONE
    2026-09-14: files imported from disk are kept INSIDE the .v3proj
    (`v3/io/projectAssets.js`, stored once per content, only referenced ones
    written). Covers paint maps, prop GLBs + LOD1/LOD2, GLB collectibles, prop
    material folders, flag texture, tree GLBs + preset JSON, foliage textures.
    Not covered: a tree preset's own trunk GLB / leaf texture (still by path),
    brush masks (tool state).
31b. ~~The world look is not saved~~ — DONE 2026-09-14: sky mode (and the HDR
    file), sun and exposure, both skies' settings incl. time of day, clouds,
    fog, lens flare and Post FX ride in `environment.look`. Merged per key on
    load. Games don't take it unless `startV3App({ projectWorldLook: true })`
    or `loadProjectFromUrl(url, { worldLook: true })` (they set their own
    look). Not saved: shadow quality, render scale, interior lighting, audio.
32. **Texture compression.** Paint layers use ~74 MB of VRAM; KTX2 would cut it
    for the games.
33. **City builder** — its own 4-phase track.
34. ~~Housekeeping: leftover `.name.PID.mjs` temp files~~ — DONE 2026-09-14.
    `runAll.mjs` already swept copies a killed run left; now all 48 harnesses
    delete their copy even when the import throws (`.finally`). Full lane
    158/158, 0 leftovers.

## Props and instancing (InstancedMesh2 study, measured 2026-09-14)

Source: agargaro/instanced-mesh read in full (all src, 25 docs pages, 24
examples, bvh.js). It is WebGL-only; what carries over is its CPU-side
algorithms. Measured in the editor on this laptop: 1k / 5k / 20k props (5
built-in shapes + a cliff) over 800x800 m, GPU at the real canvas 1347x849.

### Confirmed bugs (fix with the selection work)

35. ~~A different prop moves after a brush erase~~ — FIXED 2026-09-14 (ids). Props paint mode: right-click
    a prop (gizmo stays), Alt+paint over it, drag the gizmo -> another prop
    teleports (prop at x=90 jumped to x=20). Cause: swap-remove indices.
    Fix: stable ids (free-id pool + active flag, no compaction, like
    InstancedMesh2), and clear the selection when its prop is erased.
36. ~~4,096 props per mesh, extra ones silently dropped~~ — FIXED 2026-09-14 (6,000 placed, 4,096
    drawn). Fix: growable capacity (theirs: 1.5x + 512).
37. ~~Clicks hit boxes, not shapes~~ — FIXED 2026-09-14 (0.4 ms at 20k) (a sphere inside a torus hole picks the
    torus). Fix: BVH over instance bounds for candidates, then an exact
    triangle test with the per-type MeshBVH SolidCollider already builds.

### Measured performance (worth doing above ~10k props / city scale)

**The stress scene these numbers come from** — `__V3_DEBUG.propStress()` in the
editor console (v3/app/main.js). 12k spheres on a golden-angle spiral over
800 m with the camera at ground level in the middle; `propStress({ count,
shape, radius })` to vary it, `propStressClear()` to remove it. It goes through
the Props tool's own path (addPrimitive → registerPrimitive →
onTypeRegistered → auto-LOD) because **props added straight to the store never
render** — the instancer is told about a type by the app, not by the store.
The spiral is deterministic, so runs weeks apart are comparable.

Two traps that silently produce fake numbers, both hit on 2026-09-16:
- **A backgrounded tab freezes `renderer.info`.** Draws, triangles and
  timestamp all hold their last value, so an A/B returns identical figures and
  looks like "no difference". `select_page` with `bringToFront` first.
- **`sun.castShadow = false` does nothing** once the CSM shadow node is
  running: the cascade `LwLight`s carry their own `castShadow`. To measure what
  props cost the shadow pass, flip `castShadow` on the prop InstancedMeshes
  (`propInstancer.setCastShadow`).
Also take the MEAN of raw samples, not the median: the GPU timestamp is
quantised to a handful of values per 60 frames, so medians collapse onto the
same number for both sides of an A/B.

**A mixed world** for when identical spheres are too kind:
`await __V3_DEBUG.worldStress()` — 20k props over five primitive shapes at
mixed scales and tilts, ~3% procedural cliffs, plus 3k trees from the tree
tool's own test preset. Seeded, so it rebuilds identically. Measured
2026-09-16 with shadow lists + per-instance cull vs neither: ground level
4.560 → 3.861 ms (8.99 → 4.48 M tris), 120 m overview 5.388 → 4.645 ms. Here
the SHADOW LISTS carry the win and the per-instance cull adds only
0.05-0.19 ms, the reverse of the sphere scene — most scatter is cheap (a cube
is 12 triangles), so skipping off-screen ones saves little.
Found with it: **procedural cliffs never get auto-LOD** — they are
non-indexed, and simplifyGeometry skips non-indexed input. Not measurable at
589 cliffs (hiding them made the frame slower, probably because they occlude
what is behind them — unverified). Any replacement rock/cliff generator
should emit INDEXED geometry.

BASELINE 2026-09-16, 12k props over 800 m, 4 interleaved rounds × 90 frames:
whole frame **2.959 ms**, props not casting 1.576 ms, so the **prop shadow pass
is 1.383 ms — 47% of the frame**, with 6 prop meshes and 9.1 M triangles.

38b. ~~**Per-instance shadow culling**~~ — DONE 2026-09-16, the rest of 38.
    Each cascade now owns an instanced mesh on layer SHADOW_LAYER_BASE + i
    holding only the instances inside THAT cascade's box, drawn with the
    cheapest level the type has; the camera meshes drop to `castShadow = false`.
    Cascade cameras keep layer 0, so terrain, trees and the player are
    untouched, and with no CSM the old whole-tier gate still applies.
    Measured INTERLEAVED in one run (12k props, 800 m, 4 rounds × 90 frames,
    60 FPS confirmed): **2.532 → 2.275 ms, −0.257 ms**, shadow instance
    submissions 5,064 → 4,196, draws 14 → 11. A second run gave −0.254 ms; the
    absolutes moved 0.4 ms between runs (this laptop's clock drifts) while the
    delta held, which is why the A/B has to be interleaved.
    Instance split across cascades: 38 / 313 / 3,845. Less than the arithmetic
    promised, and the reason is worth remembering: cascade 2's box is 324 m
    across, so it picks up everything around AND behind the camera, where the
    old code only cast what was in front. Cascades 0 and 1 get the big cuts and
    cascade 2 gives most of it back.
    **The correctness half is the better half:** 577 of 4,237 casters (13.6%)
    are behind the camera and could never cast before.
    **What it really bought is item 39.** Camera and shadow shared one list, so
    culling what the camera cannot see deleted shadows those props should still
    cast. The lists are now independent, so the camera list can be culled
    per-instance — which is where the ~40% is.

38. ~~**Shadow pass draws every prop**~~ — DONE 2026-09-16 (tier gate here,
    per-instance half in 38b above). The CSM reaches
    80 m (maxFar), yet every detail level cast, so props from 150 m to 500 m
    were drawn into an 80 m shadow map. A tier now casts only when its NEAREST
    prop can still be inside it (`propInstancer.setShadowDistance`, fed from
    worldToolState.csm.maxFar each frame). Measured at 12k props: 2.818 → 2.425
    ms GPU (-0.39). Still open, and where the rest of the win is: PER-INSTANCE
    shadow culling — LOD1 spans 60-150 m and casts whole, so ~700 props between
    80 m and 150 m are still drawn into the map for nothing. That needs a
    shadow-only instance list per type (cull against the shadow camera, draw
    with the cheapest geometry), which is also what would let props BEHIND the
    camera cast into view — they cannot today.
39. ~~**Coarse culling**~~ — DONE 2026-09-16, and the biggest prop win so far.
    The camera list is now culled one instance at a time (bounding sphere vs
    the camera frustum, `perInstanceCull`) instead of one 256 m cell at a time.
    Only possible because 38b split the shadow lists off first: while the
    camera list also fed the shadow map, dropping an off-screen prop deleted a
    shadow it should still cast.
    Measured INTERLEAVED, 12k props over 800 m, 4 rounds × 90 frames at a
    confirmed 60 FPS: **2.681 → 1.755 ms GPU (−0.926)**, camera instances
    9,131 → 2,851, triangles 7.26 M → 2.92 M. CPU fell too, 4.4 → 3.5 ms.
    The rendered image is IDENTICAL — screenshotted both ways — and a 360°
    sweep in 45° steps keeps 31.2-31.3% of instances at every angle with no
    popping, spikes or collapses.
    The tier is still picked BEFORE the cull test, because tier hysteresis has
    to keep ticking for instances that are off screen; otherwise a prop that
    leaves the view and comes back returns at whatever level it left with.
    Still open here: the instance BVH (plane masking, a fully-inside subtree
    needing no further tests). The flat per-instance loop is cheap enough at
    12k that the BVH is not yet worth it — measure before building it.

39b. **Coarse culling, original finding.** 256 m cells: 51% of drawn props were off screen
    (7,395 of 14,622, ~4M triangles). Keeping only on-screen props cut 20k from
    9.2 to 5.4 ms. Fix: per-instance culling through the instance BVH (plane
    mask: a fully-inside subtree needs no more tests).
    **Why it could not be done naively, and the way in (checked 2026-09-16).**
    Camera and shadow share ONE instance list per tier, so culling what the
    camera cannot see also deletes shadows those props should still cast. The
    fix is separate lists, and three supports it: `ShadowNode.js:711` keeps a
    shadow camera's own layer mask as long as any layer above 0 is enabled
    (otherwise it overwrites it with the main camera's), and `Renderer.js:3054`
    layer-tests every object against the shadow camera. So camera meshes stay
    on layer 0 with `castShadow = false`, and each cascade gets its own
    shadow-only mesh on its own layer holding just the instances inside THAT
    cascade's ortho box, drawn with the cheapest geometry; every cascade camera
    keeps layer 0 enabled so terrain, trees and the character are untouched.
    The prize: props inside maxFar are currently drawn into all three cascades,
    but cascade 0's box is 23.5 m across and cascade 1's is 85 m — of the ~1,700
    props within 150 m, cascade 0 needs ~15 and cascade 1 ~135. `frustumCulled`
    is false on these meshes, so three removes none of it today. It also fixes
    the rest of 38 for free: culling against the LIGHT rather than the camera is
    what lets props behind the camera cast into view.
40. ~~**No automatic LOD**~~ — DONE 2026-09-16. v3/render/instancing/autoLod.js
    builds the missing levels with **meshoptimizer** when a prop type registers
    (LOD1 at 45% of the triangles, LOD2 at 35% of LOD1), chained off the render
    path and skipped for types that ship hand-made LOD GLBs. Better than the
    meshoptimizer example in the two ways the audit asked for:
    `simplifyWithAttributes` so normals and UVs steer the collapse, and the
    vertex buffer is COMPACTED afterwards (Sphere 561 → 153 vertices), where
    the example rewrites only the index and leaves the memory and the dead
    vertex-shader work in place. Generated levels follow LOD0's material, so a
    cliff whose material is wrapped after registration does not change
    appearance at the switch.
    Measured, 12k props over 800×800 m: **5.046 → 2.425 ms GPU and 22.6M →
    3.9M triangles** (-52% / -83%). Sphere 960 → 432 → 184 tris, Torus 1024 →
    460 → 164. Shapes under ~130 triangles (cone, cylinder) simplify to
    nothing the simplifier will accept and are left alone — they are already
    cheap. Test: tools/autoLodTest.mjs.
    Watch for: LOD distances are fixed metres (60/150), not screen size, so a
    very large prop or cliff switches at the same distance as a pebble.

### Measured, not felt on this laptop (do only as a side effect of 35-37)

41. **Every edit rebuilds all props.** Drag frame CPU 0.5 / 1.8 / 6.9 ms at
    1k / 5k / 20k; brush stamp + rebuild 7-17 ms at 20k; camera LOD <= 1 ms.
    0 dropped frames even at 20k. With stable ids, updates become per-prop
    (dirty ranges; BVH move that only re-inserts when a box leaves its parent,
    with a margin). Could matter on a weaker machine.
42. **Solid-prop collision loops over every solid prop** (0.23 ms per capsule
    query at 20k, collider resync 2.1 ms per edit). Use the same instance BVH
    at city scale.
43. ~~Click pick 2.1 ms at 20k~~ — now 0.4 ms (box broad phase + MeshBVH). — fine for clicks, too slow for hover
    highlight every frame; the BVH fixes it.

### Ideas to use later

44. **Per-prop colour / values** (hover and selection highlight on the prop
    itself, tint variation, per-prop roughness): one instanced buffer read by
    instanceIndex in TSL. Pairs with selection.
45. ~~Hide / show a prop without deleting it~~ — DONE with the Scene list. (visibility flag separate from
    active): for the Scene list's hide and isolate.
46. **Subtree LOD assignment** in the BVH: a node wholly inside one distance
    band assigns that LOD to all its props at once. Keep OUR per-prop tier
    memory (+-10%); theirs is stateless and does not really stop flicker.
47. **Sorting:** front-to-back for dense solid props, back-to-front for
    transparent ones (radix sort on 32-bit depth). Not measured; later.
48. **Animation LOD** (for live props, characters, crowds): animate only what
    is on screen, update rate by distance (their example: clamp(70 - d, 5, 60)
    fps), skip hand/foot bones at far LODs.
49. **One draw for many small prop types:** a per-prop atlas offset or texture
    array index. Draw calls are not a measured problem today.

Not taken: its WebGL shader patching and data textures (WebGPU uses storage
buffers), the per-copy entity objects (memory), per-instance morph textures,
its skinning texture (the crowd's compute skinning is better), its stateless
hysteresis, and the positions-only simplification.

Wrong claim, dropped: "props just off screen lose their shadows" — tested
twice with a pillar whose shadow crosses the view; the shadow was correct.

## Left in v2 — port before v2 is deleted (compared 2026-09-14)

Full v2 vs v3 editor comparison, mode by mode and UI. v2 is only deleted once
this section is empty; what v3 still imports from v2 moves, it is not lost.

### v3's own gaps found in the comparison (do first — games load the level)

84. ~~The .v3proj does not save everything~~ — DONE 2026-09-14. Now saved:
    grass appearance (`grass`, every panel control, merged per key), cliff-top
    grass density and the cliffPaint mask (blobs; the cliff-top surface is
    re-baked from the loaded cliffs), snow look (`snowParams`), and interior
    lighting (in `environment.look`). A file without the masks clears them;
    without `grass`/`snowParams` the current look stays. Shadow quality (CSM)
    stays out on purpose: cascades can't change live on r184, so a game sets
    it at boot (`startV3App({ csm })`). Also fixed: the Specular V2 Power
    slider jumped 12 → ~120 on first touch (listener missed its /10).
    Checked in the editor: author → save → scramble → load restores state,
    panel and uniforms; `tools/projectLookSaveTest.mjs` guards the tables.
85. ~~Undo gaps~~ — DONE 2026-09-14. Roads and lakes have undo
    (`v3/tools/snapshotHistory.js`: a snapshot after each finished edit, so a
    drag, a held +/- or a slider drag is one step and a select-only click is
    none). Road: add, connect, drag node/bend, delete, J, B, lift, Clear all,
    import. Lake: drag-place, delete, level/center/size sliders. Both reset on
    project load. Undo routing is one function (`undoInMode`) used by
    Ctrl+Z/Y AND the toolbar buttons (they only undid sculpt); the separate
    grass/susuki key handlers folded into it. Grass Fill/Clear (terrain and
    cliff) are now undo steps too. Not in history, like other panels: road
    width/profile settings and the lake water look. Grade bake/remove are
    terrain edits outside the road history. Checked in the editor with real
    mouse, keyboard and toolbar input.
86. ~~Stale shortcuts and hidden modes~~ — DONE 2026-09-15. Tooltips name only
    real shortcuts (Sculpt/Paint/Grass lost their S/P/G; no keys added: S
    would fire while flying with WASD, P is Play). Snow and Cliff paint got
    toolbar buttons (they were dropdown-only). The mode dropdown shows every
    real key (View V, Props I, Spline K…); Load tooltip matches what it does.
87. **The Audio mixer (World tab) is wired to nothing** — v3 creates no audio
    system. See 96.

### Editor UI (v2 has, v3 lacks)

88. ~~One shared widget module~~ — DONE 2026-09-14. `v3/ui/widgets.js` (section,
    separator, slider with log curve, color, toggle, dropdown, text, button,
    info, hint + fmt/clampSnap) replaces the copies in 15 panels and the depth
    water controls (up to 8 versions of one helper; −1,895 lines). Value
    widgets return `{ row, refresh() }` — the base for live resync (92) and
    the Inspector (89). Panels import under their old `_name`s, so call sites
    did not change. Measured in the editor: every panel has the same rows,
    sections, controls, labels, slider values and selections as before. Two
    visible changes: the six panels whose buttons used an unstyled class
    (lake, river, River v2, road, tunnel, lane road) now get the normal button
    look, and Susuki sliders/colours gained the number box / hex label every
    other panel has. Deleted: `v3/scripts/extract*.mjs` (regenerated panels
    from v2 line numbers — running one would overwrite a v3 panel) and their
    `*PanelWidgets.txt` output. `tools/uiWidgetsTest.mjs` fails if a panel
    grows its own copy again.
89. ~~Editable Inspector~~ — DONE 2026-09-15 (`v3/ui/inspectorPanel.js`). The
    Info tab is now the Inspector: a Scene-list click or a View-mode viewport
    click opens the object's properties there; a toolbar tool button goes
    back to Tools. New "Environment" group in the Scene list (Sun & light,
    Sky, Fog — not counted as objects). Per kind:
    - Prop: position / rotation° / scale fields, Focus, Duplicate, Delete;
      follows gizmo drags live. Multi-selection: count + Focus/Duplicate/Delete.
    - Lake: level, center, size, Delete (lake undo). Tunnel/cave: length,
      nodes, width/height/wall, Delete (tunnel undo). River: nodes, length.
      Road: nodes, segments, bridges. Player start: position, facing, place
      at camera, clear. Terrain: world/heightmap/splat facts. Groups: count.
    - Sun & light, Sky (mode + time of day), Fog: the key World-tab values;
      the World tab rebuilds before it is shown again after an edit here.
    Every edit goes through the tool's own calls (same undo, rebuild, save);
    "Edit in tool" opens the full panel. Selections made inside a tool
    (right-click a prop) update it; switching tools does not.
    Also fixed on the way: a prop GIZMO DRAG WAS NOT UNDOABLE (no snapshot at
    drag start). `propSys.beginEdit/endEdit` now brackets gizmo drags and
    Inspector fields as one step, none when nothing moved
    (`tools/propEditUndoTest.mjs`). Checked in the editor with real list,
    viewport, keyboard and toolbar input, incl. undo refreshing the Inspector.
    Not yet: per-node river/road values, the sky mode switch, props' material.
90. ~~Resizable panels~~ — DONE 2026-09-14 (`v3/ui/editorLayout.js`). Drag the
    inner edge of the Scene or right panel; double-click resets. Widths drive
    the grid's --left-w/--right-w, so the renderer and the stats overlay
    follow; remembered per browser; a panel keeps 160/240 px and the viewport
    never drops under 320 px (also when the window shrinks). Hidden in
    immersive play. (v2's bottom file-browser splitter has no v3 panel yet.)
91. ~~Status bar~~ — DONE 2026-09-14. Message on the left ("Project saved —
    name (MB)", "Project loaded", load errors in red), then mode, camera XYZ
    (FLY in fly mode), draw calls, triangles and frame time with a
    green/amber/red dot; written 4×/s. No GPU ms on purpose: main.js documents
    the stats-gl GPU number as unreliable, so it stays only in the overlay.
    Hidden in immersive play. Checked in the editor (drag, clamp, reset,
    reload, immersive, screenshot); `tools/editorLayoutTest.mjs`.
92. ~~Scene list search + right-click menu + live panel values~~ — DONE
    2026-09-15. (Sun/sky/fog in the list came with 89.)
    - Search box on the Scene list: every word must appear, any order;
      matching groups and prop types open while searching; "Nothing named…";
      Esc clears; typing does not trigger editor shortcuts.
    - Right-click a row: Inspect, Focus, Hide/Show in editor, and Delete for
      props, lakes, tunnels, rivers ("Delete all N" for a prop type, asks
      first), Clear for the player start — all through the tools' own calls
      and undo. Closes on outside click, Esc, scroll.
    - Live values: every shared widget registers; `refreshWidgets()` (4×/s,
      not in play) re-reads the visible ones, so the World tab, tool panels
      and Inspector follow undo, loads, presets and Inspector edits without a
      rebuild. Skips the field being typed in / slider being dragged; writes
      nothing when unchanged. Measured: 0.3 ms per pass with every World
      section open (271 controls), 0 writes idle. Found on the way: sliders
      holding an off-step value (0.145 on a 0.01 step) were rewritten every
      pass — now only a whole-step difference redraws. The Inspector's
      "rebuild the World tab when reopened" workaround is gone.
    - Not covered: the hand-written HTML panels (sculpt/paint/grass/snow
      sections in editor.html) — the grass look syncs on load via
      `syncPanelControls`.
    Later: a project asset browser (v2 had a File System Access folder browser).

### Gameplay (needed by games)

93. **Gameplay markers.** v2 actors mode places NPC / enemy spawns
    (`v2/tools/actors`). Don't port the capsule placeholders as-is: one
    markers mode (NPC, enemy, trigger zone, checkpoint) saved in the .v3proj.
    Dialogue runner + graphs (`v2/play/dialogue`) go game-side.
94. **Barrier (no-go) zones.** Painted invisible play boundary + "fill world
    edge" (`v2/tools/barrier`). v3 only has visible spline walls.
95. **Moving platforms / animated props** (`v2/play/movingPlatforms.js` is a
    demo; the racing game's elevator and movers are the stronger base).
96. **Audio system.** Howler buses master/sfx/music/voice/ui/vehicle
    (`v2/audio/createV2AudioSystem.js`); connect the World tab mixer (87).

### World life

97. **Waterfall** (`v2/tools/waterfall`, 525 lines): waterfall + impact splash,
    gizmo, saved. Do it after River v2 so falls sit on river drops.
98. **Ambient FX** — IN PROGRESS (slices 1-3 landed 2026-09-18/19). Ambient FX mode
    in the toolbar: butterflies and falling leaves, GPU-simulated. NOT a port
    of `v2/core/ambientfx` — that was taken as a list of effects someone
    wanted, nothing more. Built the way Niagara/VFX Graph do ambient work.

    Landed:
    - `v3/render/ambient/ambientField.js` — the shared core. A camera-following
      BOX (not scatterField's wrap tile: scatter is stateless placement, this
      is stateful simulation), one persistent pool statically sliced so an
      effect's BUDGET IS ITS SLICE LENGTH, one compute pass per frame, atomic
      compaction, indirect draws sliced by `firstInstance`.
    - Respawn is REJECTION SAMPLING against the effect's rule — no CPU, no
      prefix sum, self-balancing. A slot remembers where it last succeeded and
      samples a disc around it, so refill after a teleport is immediate rather
      than a second of fade-up.
    - Four cull gates, all in the compute: frustum (the SAME test the plants
      use — `scatterFrustumVisible` lifted into `v3/render/scatter/gpuCull.js`,
      scatterField now imports it), distance, SCREEN SIZE (below `minPixels` a
      card is not drawn; sub-pixel triangles crawl rather than fade — the
      starfield lesson), and near-camera.
    - Scalability tier: one uniform scaling every slice's live length. No
      reallocation, free to change per frame.
    - Two integrators (`ambientMotion.js`), plain JS inlining TSL rather than
      `Fn` (an Fn returning an object collapses to one node): WANDER, with the
      vertical bob locked to the wing beat that makes an insect read as one;
      and FALL, with the autorotation swing that makes a leaf a leaf and not
      snow, then SETTLE — it lies down on the terrain normal, which is written
      OVER the velocity it no longer needs, and holds for `settleTime`.
    - ONE DRAW CALL for every card effect (measured: 5 → 6). Draws are per
      SHAPE CLASS, not per effect; effects differ only by uniform row.
    - Painted artwork, not procedural shapes: `ambientAtlas.js` packs
      `butterfly.png` and `leaf1-tiny.png` into one texture at load. The
      texture exists from frame 0 and fills in, so no recompile and no stall.
      Each tile is a WHOLE shape and the card's two halves take the painting's
      two halves (`texU = 0.5 + side·u·0.5`), so a wing keeps its own painted
      asymmetry. Per-effect colour is a TINT over the art, 0 by default.
      A file that will not load draws a placeholder and WARNS — v2 loaded a
      `moth.png` that is not in the repo and silently showed nothing.
    - `tools/ambientFxTest.mjs` (32 checks) and `buildComputeWGSL` added to
      `tools/wgslBuilderStub.mjs` — until now nothing in this repo could ask
      whether a COMPUTE pass compiles without a browser, and several systems
      have one.
    - Console probes: `__V3_DEBUG.ambientFx()`, `.ambientSet()`,
      `.ambientStand()`, `.gpu()` (the timestamp panel, on demand).

    COST, measured and honest: +1 draw call and +1 compute dispatch, and the
    GPU time is BELOW THE 0.065 ms TIMESTAMP QUANTUM — at 1200 particles, at
    8000, and at a deliberately absurd worst case of 4000 metre-wide cards
    filling the screen. Four interleaved rounds, means not medians, tab in
    front. The deltas came back non-monotonic (600 particles "costing" more
    than 4000 big ones), which is the signature of noise, not a measurement.
    It is not "free" — it is unresolved. Separating it needs the pixel-ratio
    trick the world rain used (3×, 9× the pixels). For a budget decision the
    reading is: budget is not the constraint here.

    SLICE 2 (2026-09-19) — painted into a world, and a clock.
    - PAINT. `ScatterDensity` at 1024², one effect per RGBA channel, and the
      RAW texture rather than a masked copy: grass reads a copy with every
      "Blocks grass" layer and every terrain hole cut out because a plant
      cannot grow on a path, but a butterfly flies over the path. Skipping the
      mask skips its bake too.
    - Its OWN brush, deliberately not the shared vegetation one — an Alt-erase
      that clears every kind of plant must not also wipe the butterflies —
      with its own 12-step undo, Shift/Alt wheel, fill and per-effect clear.
    - Per effect, `area` is "painted" or "everywhere". A new effect starts
      everywhere so the mode shows something when you open it, and the FIRST
      brush stroke flips it to painted, because painting an effect that
      ignores paint is the one genuinely confusing state this could be in.
    - The paint is a PROBABILITY, not a mask: half-painted ground gets half
      the butterflies and a soft brush edge really does thin the swarm out
      instead of ending it on a line.
    - TIME OF DAY. A per-effect window on the world's clock that WRAPS, so
      fireflies at 19 → 5 is a normal thing to ask for and start === end means
      always. It gates SPAWNING, not opacity: an effect going out of season
      drains over a lifetime or two — butterflies going home one by one —
      which reads better than the whole swarm dimming together and costs
      nothing in the vertex stage. Butterflies ship at 07:00 → 19:00.
      `dayWindow()` is pure and tested; the wrap is the part that is easy to
      get wrong.
    - SAVE/LOAD. `ambientPaint` (blob), `ambientEffects` and `ambientField`.
      NOTE FOR THE NEXT PERSON ADDING A PAINT LAYER: a blob that is not
      registered in `v3/io/projectIO.js` is silently DROPPED on save — you
      find out by reopening a world and finding it empty. This nearly shipped
      exactly that; there is now a round-trip check for it.
    - Verified live: the day gate drains butterflies while the always-on
      leaves keep falling; `area: painted` with nothing painted shows nothing
      and Fill brings them back.

    SLICE 3 (2026-09-19) - polish, and the second shape class.
    - EDGE-ON SLIVERS FIXED. A butterfly in level flight holds its wings
      horizontal, so a camera at the same height saw the EDGE of the card: a
      one-pixel streak with no shape at all. Each effect now has `faceCamera`,
      which rolls the card part of the way toward showing its face. It is a
      lie about orientation that reads as the thing banking, which butterflies
      do anyway. Butterflies 0.6; leaves only 0.2, because the tumble is what
      makes a leaf read and faceCamera 1 stops a tumble dead.
      Done as a ROLL, not by blending the up vector: mix(worldUp, toCamera)
      passes through the zero vector for anything directly above the camera
      and the frame explodes. The angle is wrapped into +/-90 degrees first,
      so the discontinuity lands where the card is edge-on anyway - the one
      place a jump cannot be seen. And the DIFFERENCE is blended, not the
      absolute angle, or a rising faceCamera would drag a tumble to a halt.
    - THE BILLBOARD SHAPE CLASS, and with it dust motes and fireflies. A soft
      additive blob, single quad, no artwork - the honest shape for a mote
      catching the sun, and giving either of those a silhouette is how you get
      visible sprites. It is a second DRAW because it is a second PASS (cards
      are alpha-tested in the opaque pass for early-Z; these are additive with
      no depth write and must come after), which no uniform row could paper
      over. Everything else an effect wants to be is still free.
    - MOTION 2, FLOAT: almost no gravity and a very slow heading, so what you
      read is the wind rather than the particle. Dust that steers itself looks
      like insects.
    - Presets `dustMotes` and `fireflies`, both shipped DISABLED so no
      existing world suddenly hazes over. Fireflies blink (pulseAmount 0.85 -
      the blink is the whole of what makes a firefly one) and are out
      19:30 -> 04:30 on the day window from slice 2.
    - MEASURED, and a real saving: the billboard was first written DoubleSide,
      and three renders a double-sided TRANSPARENT material in two passes
      (back faces then front) to sort it - a whole extra draw call for a quad
      built from the camera's own axes, which never shows its back. FrontSide,
      and there is a test that says so.
    - Draw calls, measured with the mode toggled and several frames read per
      side: baseline 5, cards only 6, billboards only 6, ALL FOUR EFFECTS 7.
      One draw per shape class in use, two at most, whatever is painted.

    LOOKED AT, 2026-09-19, and the four things it changed. Screenshots at a
    fixed camera, A/B'd one term at a time.
    — THE SLIVER FIX WORKS, verified rather than assumed: at faceCamera 0
      roughly half the butterflies were flattened horizontal smears; at 0.6
      almost all read as butterflies. One residual case survives and always
      will — a butterfly flying directly toward or away from you, where
      rolling about the spine cannot change anything. That one is correct.
    — THE DEFAULT SIZE WAS WRONG, and this was the real finding. At the
      authored 8.5 cm a butterfly is 3-5 px at a normal distance, so the
      painted Ulysses was thrown away entirely and what was left crawled.
      Added `pixelFloor` (gpuCull.worldSizeForPixels): below it the card GROWS
      in world space rather than shrinking away — the birds' trick, and the
      same argument. Butterflies 14 px, leaves 11, fireflies 3.5, dust 0
      (dust SHOULD vanish with distance). Applied in the compute as well as
      the material, or the screen-size gate culls a particle at its authored
      size that the vertex stage was about to grow.
    — THE DEFAULT BUDGETS WERE 3-4x TOO HIGH. 500 butterflies inside a 36 m
      fade radius is one per 8 square metres, which is a plague, and 700
      leaves inside 42 m is a blizzard. 150 and 240 now.
    — Settled leaves lie flush and read as maples.

    Still to do:
    — The clipmap-float question is STILL OPEN, not verified: default terrain
      is dead flat, so there is no clipmap error to see. It needs sculpted
      ground to test.
    — Dust motes are invisible at their defaults over a bright sky and pale
      ground, because additive over near-white adds nothing. That is arguably
      correct — real motes only show in a shaft of light against something
      dark — but it means the preset cannot be judged in an empty test world.
    — Everything above was judged against a FEATURELESS GREY PLANE, which
      this repo's own note says is the unreliable way to do it. Density and
      brightness want a second look in a world with grass and trees.
    - The remaining spawn rules: near water (`waterSurfaceMap` — one tap,
      covers lakes AND rivers and gives the surface Y, so midges can hover
      just above it), near trees (needs a NEW `canopyMap.js`, ~120 lines,
      splatting TreeStore, which is what makes leaves fall from UNDER a canopy
      rather than out of the open sky), and weather.
    - More leaf art. Only ONE single-leaf PNG exists; `leaf_atlas.png` and the
      `Leaf-Billboard-Texture-*` files are canopy clusters, no good for a
      falling leaf. Drop singles into `public/textures/` and append to
      `AMBIENT_ART`.
    - Not built, architecture leaves room: the BILLBOARD shape class (a second
      draw) for dust motes, pollen, fireflies; the `float` and `rise`
      integrators.
    - Birds stay closed-form and separate (`modularRoadBirds.js`: 1 draw, 0
      compute, already tested). Agreed to move into the engine as
      `v3/render/ambient/birdFlocks.js` and host in this mode — NOT folded
      into the particle pool, which would cost a compute slice and lose the
      flock read. Not done; it touches a game file.
    - Watch for: settled leaves use `heightTex`, not the clipmap mesh. Grass
      floated for exactly this reason. Near the camera the error is small and
      a flat leaf hides it, but if they float, lift v2's `_clipmapGroundY` out
      of `hybridGrassSystem` into a shared TSL helper.
99. ~~**Flowers**~~ — DONE 2026-09-15: Flowers mode (M), rebuilt on the susuki
    skeleton instead of porting v2's CPU list. Painted areas, up to 4 types
    (one per channel of a 1024² density map; types mix), v2's bloom cup and 3
    silhouettes, optional stems, per-type colours/size/stem, per-plant size,
    yaw and colour jitter, shared grass wind + player push, lit by the scene,
    "Blocks grass" layers and holes respected, undo (16 strokes), saved
    (`flowerDensity` blob + `flowers`). ONE compute pass + ONE indirect draw
    for every flower (v2: full CPU rebuild per stroke and per sculpt, up to 12
    draws per 64 m chunk, no distance limit, transparent sorting, fixed light).
    Files: render/grass/flowerSystem.js, flowerDensity.js,
    app/state/flowerState.js, ui/buildFlowerPanel.js; tools/flowerPaintTest.mjs.
    Not ported: exact single-flower placement (painted areas by choice).

    **Flowers v2 — rebuild from scratch (user go 2026-09-15: "the best flower
    mode with the best performance", v2's mode is not a reference).** Gaps of
    the first version, vs Genshin / Ghost of Tsushima / UE / Unity flowers:
    1. Shading: faceted cups (no normals), paper-cutout petals, no light
       through petals, no shadows received (bright under trees).
    2. Placement: even spread, no clumps and gaps.
    3. Distance: nothing past ~85 m — fields vanish from a hill. Games tint the
       terrain with the flower colours far away.
    4. Shape: one textured cone; no separate curved petals, real centre, leaves,
       variety; petals do not flutter.
    5. Grass: stemless flowers sink into tall painted grass.
    6. Tools: erase one type only; rules (flat only, height band, near water,
       on a paint layer).
    7. Alpha-tested masks: edge shimmer and no early depth rejection.
    8. GPU cost never measured with a trace.
    Plan: phase 1 = procedural petal geometry per type (no masks, opaque, no
    alpha test), near/far geometry LOD chosen per plant in the compute (8 draws
    max, one shared indirect buffer, firstInstance offsets), soft normals +
    petal/leaf translucency + shadows near, clump noise, grass-aware height,
    petal flutter, presets. Phase 2 = far-field terrain tint from the flower
    density. Phase 3 = tools (per-type erase, placement rules).
    Phase 1 DONE 2026-09-15 (to judge by eye in a real scene 👁):
    flowerGeometry.js builds each type from numbers — curved petal strips with
    analytic normals (pointed tips fall back to the centre-line up), optional
    second layer, domed centre, stem, 0-3 leaves; near ~170-390 tris per
    preset, far ~22-100. Presets: daisy, poppy, cosmos, tulip, blue star,
    sunflower. No textures, no alpha test. flowerSystem.js: the compute picks
    type AND near/far per plant (switch spread ±2 m) and writes one compact
    list in 8 slices; 8 meshes share one material and one indirect buffer,
    each draw's firstInstance = its slice. Clump noise (2 octaves),
    grass-aware height (masked grass density × blade height), per-plant
    size/yaw/lean/colour, petal + leaf flutter, sun translucency (emissive),
    shadows on the near draws only, soft normals via a view-space normalNode.
    Scene with 4 types: 13 draws total, 60 fps. GPU cost still unmeasured by
    trace.
    Phase 2 DONE 2026-09-15: far-field colour (render/grass/flowerTintTsl.js,
    terrain feature `flowerTint`). Past the fade band the terrain takes the
    paint-weighted type colour × bloom coverage × the SAME clump noise
    (flowerNoise.js, shared with the compute) × a distance speckle, faded in
    across the band the 3D flowers fade out in. The paint is sampled in the
    terrain VERTEX stage: the fragment stage was already at WebGPU's 16-sampler
    limit, and a 17th texture made the terrain pipeline fail (caught before
    commit). Gated by an If on "anything painted".
    Phase 3 (part) DONE 2026-09-15: "Erase this flower only" and a per-type
    terrain height band (±2 m soft), applied in the compute AND the far tint.
    Rules DONE 2026-09-15: per type "grows on paint layer" (splat weight
    ≥ ~20%) and "near rivers within X m" (River v2 distance field), shared by
    the compute and the far tint through flowerRuleKeep (flowerNoise.js; the
    tint reads splat + river in the terrain vertex stage). Checked: cosmos on
    "Grass" vanished on unpainted ground and grew back only on a painted Grass
    patch.
    Look pass on a real level (rts.v3proj hills, 2026-09-15): white daisies
    read grey and petal undersides near-black with true curved normals → petal
    and leaf lighting normals now bent 55% to up and never back-face flipped
    (stems/centres keep real normals); stem height spread widened to ±35%.
    Result reads as a stylised game meadow 👁 (user to judge).
    Painting cost measured: a stamp is 0.05 ms CPU; while painting every frame
    the median frame is unchanged (16.3 ms), p90 22 ms, worst 27 ms — the 4 MB
    density upload + mask bake. Editor-only; WebGPU in three r184 has no
    partial texture upload. Leave unless painting feels heavy.
    Measured (GPU timestamps, 1347×825, a dense field filling the view): render
    1.31 → 2.03 ms with flowers (+0.7 ms); compute ≈0.07 ms total.
    The OLD flower (v2 cup + alpha masks + material) is archived, unused, in
    v3/render/grass/archive/v2FlowerShape.js with how to bring it back; its
    masks stay in public/textures/flowers/.
100. ~~**Decals**~~ — DONE 2026-09-15: Decals mode (C), written from scratch
     (v2's flat polygon-offset quads not used). The Unity/Unreal PROJECTED box
     decal: back faces of an oriented box, GreaterEqual depth test (works with
     the camera inside the box), the scene depth under each pixel rebuilt into
     the real surface point → decal space → texture UV. Follows terrain, props,
     roads, rocks with no decal mesh and no re-conform after sculpting. Lit by
     the engine (MeshStandardNodeMaterial; normal from depth derivatives + an
     optional normal map; shadows looked up at the surface point). Angle, edge
     and depth fades; tint, opacity, roughness, priority (overlap order).
     ONE instanced draw for every decal (one interleaved instance buffer —
     WebGPU caps a draw at 8 vertex buffers); textures are layers of two
     512² texture arrays, so any number of decal textures is two bindings. CPU
     sphere-frustum cull + priority sort only when the camera or a decal moved.
     Editor: click places (projected into the clicked surface or straight
     down, random or camera-facing rotation, ghost box under the cursor), click
     a decal selects it (gizmo W/E/R, Q space), Shift+click places on top,
     Ctrl+D, Del, Esc, undo; Scene list group, Inspector, View-mode click
     picking, Shift+F frame. Import PNG/JPG/WebP textures (+ normal maps) —
     they ride inside the .v3proj as assets; save key `decals`, loaded by games
     too. Files: render/decals/decalSystem.js, decalTextures.js, decalMath.js,
     tools/decalEditor.js, ui/buildDecalPanel.js; tools/decalEditorTest.mjs.
     Measured (1347×825, 167 overlapping decals filling the view): draw calls
     unchanged, GPU 0.18 → 0.47 ms.
     **Engine fix that came with it:** with Post FX off the editor drew
     straight onto the multisampled canvas, and WebGPU cannot copy depth out of
     a multisampled target, so any scene-depth reader (lakes, River v2, decals)
     got the whole frame rejected ("Sample count (4) … doesn't match").
     postFxPipeline.setSceneDepthRequired(): while water or decals exist and
     the full post chain is off, the frame goes through a minimal chain — a
     non-multisampled scene pass, tone mapping, FXAA. Decals sit in the opaque
     queue at renderOrder 9 with explicit alpha blending (the transparent queue
     had the same multisample copy problem).
     Known limit (as Unity without rendering layers): anything opaque inside the
     box receives the decal. Not done: decal layers/masks (receive on terrain
     only), atlases bigger than 512² per layer, road surface decals (57) still
     separate.
107. ~~**Foliage**~~ — REBUILT 2026-09-16 (phases 1-2 of 5). The v2 billboard
     cards are DELETED (v3/app/foliageEnvironment.js, state/foliageState.js and
     their panel): they drew `visible chunks × slots` draw calls, held three
     full copies of every instance matrix (one per LOD), had per-chunk LOD with
     a hard cut at 600 m, faked normals, ignored their own alignToNormal data,
     and their wind was a global `sin` that was off by default. The user never
     shipped a scene with them.
     **The scatter core** (v3/render/scatter/): the machinery every painted
     plant shares, pulled out of the flowers — camera-following wrap tile, ONE
     compute pass (paint, type, clumping, slope, per-type rules, map edge,
     distance fade, frustum cull, LOD pick, wind, player push), and one compact
     list sliced into indirect draws by `firstInstance`. A plant module adds
     only its geometry and its shader nodes.
     **ONE CORE — DONE 2026-09-17:** flowers and susuki now run on it too, so
     the three copies are one (flowerSystem 536 → 308 lines, susuki 835 → 601).
     The field gained PARTS (several meshes showing the same plants: susuki's
     opaque stems + alpha-tested plumes) and three per-system knobs (cull radius
     as a node, fade thinning, slope edge width), all defaulting to the old
     behaviour. Checked against the previous code at the same camera:
     susuki with wind frozen is pixel-identical (1 px of 875k); flowers land in
     the same places (the diff is only wind-motion outlines). Flowers also pick
     up the fixed frustum pad (a plant near a camera looking down no longer
     vanishes). Susuki's wind micro-sway is now the shared 0.10 at 4.1 Hz
     instead of its own 0.07 at 3.5 Hz.
     **ONE MODE — DONE 2026-09-17: Vegetation (F).** Susuki (U), Flowers (M)
     and Foliage (F) were three toolbar modes doing one job. Now one button and
     one mode-list entry; a header (v3/ui/buildVegetationHeader.js) holds the
     plant grid in three groups (Plants = the 8 foliage types with their baked
     pictures, Flowers = 4 drawn from their colours and petal count, Plumes =
     susuki drawn from its own strand texture), ONE brush (size, strength,
     falloff, erase), Fill the selected plant and Clear all vegetation. The
     selected plant's own settings show underneath. Picking a card switches
     which system paints; F reopens the kind last painted, U and M still jump
     straight to susuki and flowers.
     Internally the three modes, paint layers and save keys are unchanged, so
     projects load as before. The three brush objects keep their own `type`
     and read the shared settings through accessors.
     Erase (or Alt+paint) removes EVERY plant under the brush, whatever kind is
     selected; "Erase selected plant only" limits it. ONE undo history for all
     three: an entry snapshots each system the stroke could change, so an
     erase-everything is one Ctrl+Z and undo walks strokes in the order they
     happened across kinds. Verified live with real mouse events: fern + poppy +
     susuki on one spot, Alt-erase from Flowers clears all three, Ctrl+Z
     restores all three, redo clears them again, erase-selected-only removes
     just the poppy, two more undos walk back poppy-erase then the susuki
     stroke. Brush sliders and Shift+wheel share one radius (1-300 m, log).
     **PLANT SHADOWS — DONE 2026-09-17.** Painted plants never cast: their
     draws were culled against the camera, so casting from them would have
     dropped a plant's shadow the moment it left the screen, and cast every
     leaflet. The scatter compute now fills a SECOND list per type (opt-in,
     `shadows: true`): kept plants of a type that casts within a shadow
     distance of the camera, in front OR behind (±3 m per-plant dither so the
     edge is not a circle), drawn with the type's cheapest shape on
     LAYERS.SCATTER_SHADOW (8, new in the layer table), which only the cascade
     cameras whose near edge is inside that distance enable. Plants that only
     cast still get their wind. The pampas and susuki plume cards cast their
     strands, not rectangles (maskShadowNode — the shadow pass ignores
     opacityNode and alphaTest). Susuki's shadow head keeps 2 of its 5 plumes.
     Foliage: "Casts shadow" per plant (on for all but Ground cover), master
     switch + distance (35 m) under Light. Susuki: Cast shadows + distance.
     Flowers do not cast (too low to read).
     Measured INTERLEAVED, worst case = the whole map filled, camera at 2.5 m
     inside the field, 6 rounds x 120 frames: foliage (fern + bush everywhere)
     1.85 -> 2.08 ms GPU, **+0.22 ms**; susuki everywhere **+0.39 ms** at 35 m,
     +0.31 at 20 m (+0.98 before the shadow head was cut to 2 plumes). Compute
     +0.003 ms. A painted patch costs a fraction of this.
     Remaining: shadows only with CSM on (like the per-cascade prop lists).
     Card pictures: bakeFoliageThumbnail needs only the renderer, so the plant
     pictures bake the first time Vegetation opens, whichever kind it opens on
     (they used to wait for the foliage field to be built and showed initials).
     **SCATTER COMPUTE — MEASURED 2026-09-17, nothing to fix.** Each system's
     per-frame pass (reset + update, shadow lists included) costs **0.04-0.05
     ms wall time** whether a small patch is painted or the whole map is
     filled with the camera inside the field: foliage (65k slots) 0.048 /
     0.049, flowers (147k) 0.040 / 0.040, susuki (83k) 0.052 / 0.042. About
     half is dispatch overhead (a 1-invocation pass costs 0.026-0.038); the
     GPU work is 0.003-0.024 ms. A system with nothing painted does not
     dispatch at all (gated on hasData). So skipping the pass while the camera
     stands still would save under 0.15 ms for all three together, at the
     price of tracking every input that invalidates the lists (paint, sculpt,
     wind, push, settings) — not worth it. The cost of plants is the DRAW
     (foliage filled ~2 ms), not the scatter.
     Method (renderer.info.compute.timestamp is flat here — see the perf
     traps): k = 16/64/128 stacked dispatches between two
     onSubmittedWorkDone awaits, 10 interleaved rounds, least-squares slope,
     minus a 1-invocation pass.
     **PLACED PLANTS (GLB) — slice 5a DONE 2026-09-17.** Vegetation grid has a
     4th group, "Placed plants (GLB)": an Import card (click, or drop a GLB on
     it) and one card per imported plant with its baked picture. A placed plant
     IS a prop type (the prop instancer's LOD, per-instance cull, per-cascade
     shadows) whose slot carries `plant` brush rules (v3/tools/placedPlants.js):
     density per 100 m², min spacing against EVERY standing prop (a spacing
     grid built once per stroke — the store's hasNearby is O(N) per attempt),
     scale range, lean with slope (quaternion tilt then own-axis yaw, so the
     yaw never swings the lean off the slope), max slope, sink by a share of
     the plant's height, blocks-the-player (off by default). Import cuts leaf
     materials out (fixFoliageTransparency, now exported: alphaTest, both
     sides, depth-written) and turns collision off. Saved on the prop slot
     (`plant`), restored on load, games included.
     Erase and Clear all vegetation remove placed plants but NEVER other props;
     undo snapshots only the plant instances, so it cannot undo a rock. The
     shared brush and one undo history cover it like the other three kinds.
     Verified live with real mouse events on cliff_shrub_for_terrain.glb: drop
     import → picture + panel; paint 61, Alt-erase, undo, redo; two cubes
     under every erase and Clear all survive; a flowers-mode erase-all clears
     placed plants too; save → load keeps settings, cut-out leaves, collision
     and instances. Test: tools/placedPlantsTest.mjs (19 checks).
     **SUSUKI = A FOLIAGE PLANT — DONE 2026-09-17** (user: stems looked
     detached, plumes grey, stems too dark and too bendy, and why a separate
     section). The old renderer (susukiSystem.js: dark ribbon stems that taper
     to nothing under plume cards whose texture is empty at the root) and its
     panel are deleted. Susuki is now the foliage system run a second time with
     ONE plant — kind `susuki`: pampas's leaves and material with a FAN of 4
     plumes (plumesPerStem, plumeSpread) rising out of each stalk's tip — on
     its own far field (SUSUKI_FIELD: 400 m tile, 288² slots, fade 150-195 m;
     foliage's 192 m tile fades by 95 m). Stalks are canes: twice the strip
     width, barely lean, no bow, field flex 0.3; the stalk runs 8% into the
     plume base so the join reads. Card in Plants (the header's groups now
     hold cards from any system), the standard plant panel, shadows included.
     Paint layer unchanged; save key `susuki` is now `{ version: 2, plant,
     field }` — older files keep their paint and get the new look's defaults.
     Cost, worst case (whole map filled, camera inside): ~5.0 ms GPU vs ~4.1
     for the old renderer (leaves + full fans up close); its shadows are
     within noise. Fewer plumes/stalks or a shorter near-detail distance trim it.
     **PLANTS STRETCHED NEAR THE PLAYER — FIXED 2026-09-17** (user: "the player
     interaction makes the foliage stretch", then "it still stretches, look at
     the plumes"). THE REAL CAUSE was the bend, not the push: the foliage
     shader turned a vertex's `t` — how far along its OWN frond or plume it
     sits — into its bend angle. A plume's root has t = 0 and its tip t = 1, so
     the root stayed put while the tip swung: the head SHEARED into streaks
     instead of tilting. The angle now grows with a vertex's HEIGHT on the
     plant (each type's unscaled height, measured off its near mesh, rides in
     uniform row 3's w), so every vertex at one height turns by one angle: a
     head rides its stalk rigidly and only the stalk bends. Three smaller
     fixes found on the way: the push is scaled by uFlex like the wind (a
     stiff cane resists what bows a fern); the bend is CAPPED at 0.6 rad (35°,
     flowers 0.8) so nothing folds flat however close you stand; and the push
     radius went 1.4 → 2.2 m, since 1.4 m was barely wider than the character
     and nothing seemed to react. Verified in play mode: plants within the
     radius lean away (off/on diff = exactly the plant beside the character)
     and the plumes read as plumes again.
     **THE HAIRLINE — FIXED 2026-09-17.** A thin streak crossed the view near
     ferns. It was not the push (it survived wind, push and flex at zero) and
     not a stray triangle (every foliage mesh checked headless: no edge longer
     than the plant): a fern's RACHIS was one flat strip running the whole
     length of the frond, and a sheet seen edge-on draws one pixel wide. It is
     a CROSS of two strips now, so a stalk always shows a face (12 tris a
     frond; fern near 1,404 -> 1,529 tris, GPU unchanged at 1.54 ms with a
     filled field). Leaflets also roll about their own length, alternating and
     jittered, so a frond never presents one flat plane — free, and a real
     pinnate leaf is V-ed like that. And plants within uNearFade (0.9 m,
     susuki 0.7) of the CAMERA now thin out stochastically, so you never stand
     inside one; they keep casting shadows.
     **WIND FOR PLACED PLANTS — 5b DONE 2026-09-17.** An imported GLB plant is
     an instanced prop, and a prop's vertex shader runs BEFORE the instance
     transform (InstanceNode applies instanceMatrix to positionLocal after the
     material's positionNode), so a placed plant cannot know where it stands
     or which way it faces: its sway is LOCAL, each plant on its own phase,
     rather than a row leaning downwind together. Good for bushes and shrubs;
     a field of tall thin plants wants the painted systems.
     v3/render/instancing/plantSway.js: the GLB's materials become node
     materials (the loader's plain MeshStandardMaterials are mapped internally
     by the renderer and are not reachable) with a positionNode that bends by
     height (h^1.6) plus a faster leaf wobble. Amplitude and speed come from
     the world's wind × the plant's own "Wind ×" (slot.plant.wind), synced per
     frame; shadows follow, since the shadow pass reads the same positionNode.
     Generated LOD1/2 share LOD0's material and sway; an imported LOD carries
     its own and stands still. Not planned yet: impostors for
     GLB plants far away (the tree impostor baker takes prop-shaped entries).
     **Foliage mode (F)**: EIGHT painted plants (four types fit one RGBA
     density texture, so the layer carries two pages), each real geometry with
     no textures and no alpha test: a pinnate FERN (separate round-tipped
     leaflets on a pale stalk, built against a commercial fern pack), `bush`
     (leaves over a dome), `broadleaf` (ground cover), `blades` (reeds, tufts),
     `typha` (cattails — a slim CAPSULE head high on a straight stem, growing
     within 14 m of a river by default) and `plume` (a bottlebrush ear of
     hairs). Brush, per-plant shape/colour/rules, field, wind, light and
     distance controls, undo, and saving (`foliagePaint` blob + `foliagePlants`
     + `foliageField`).
     THREE detail levels, one silhouette: every leaflet (~1,400 tris) → a cut
     sheet (~400) → a plain blade (~120). Types nobody painted are not drawn (an
     empty indirect draw still costs a submission), so a two-plant scene is 6
     draws rather than 24. Measured: GPU 1.4-1.7 ms with jungle-scale plants
     filling the view.
     **The one textured plant:** `pampas` carries susuki's drawn plume texture
     (`drawPlumeTexture`) as the ALPHA of two crossed cards — hundreds of fine
     strands that geometry cannot afford. It has its own material, so only that
     plant pays the alpha test and every other plant keeps early depth
     rejection. That is the intended split: geometry for shape, a texture only
     where the detail is finer than triangles can be.
     **Bug found and fixed in the shared cull** (it hit the flowers too): the
     grass frustum test padded only the bottom edge and pulled the TOP edge in
     by the plant's radius, so a fern within ~2.5 m of a camera looking down
     vanished. It now pads all four edges outward and always keeps a plant
     closer than its own radius.
     **VEGETATION — WHAT REMAINS (left off 2026-09-17, in the order I would
     pick them up).** Everything above this line is done and committed; the
     work below has not been started.
     a. **Imported LOD meshes do not sway.** A plant's sway lives on its
        material, and generated LOD1/2 share LOD0's. A LOD you import yourself
        (importPropLod) brings its own material and stands still while the
        near one moves. Fix: run toPlantNodeMaterial + applySway over an
        imported LOD's materials too, with the same sway uniforms.
     b. **A plant-set brush**, the rock set's trick for plants: one stroke
        lays down a MIX (a fern here, two ground covers there, the odd bush),
        with per-plant weights. Placed plants already have the hook
        (propSys.scatterPlanner, v3/tools/rockSetBrush.js is the pattern);
        painted plants would mix by weighting the density channels a stroke
        writes.
     c. **Impostors for placed GLB plants.** A shrub is ~3k triangles and
        stays that at 200 m. The tree impostor baker (v2/render/foliage/
        impostorBake.js) already takes `{geometry, material, localMatrix}`
        entries, which is exactly a prop type's shape, so this is mostly
        wiring: bake per plant type, draw the far tier as the octahedral quad
        (v3/render/trees/impostorFieldRenderer.js is tied to the tree store
        and would need a prop-instancer twin).
     d. **Textured leaf cards** for plants geometry cannot afford (a birch,
        a palm): today only pampas and susuki carry a texture, on their
        plumes.
     e. **Vegetation in play mode, judged by eye** — the "Shade on vegetation"
        strength, and whether the shadow distance (35 m) is the right trade.
     Older notes, still true: phase 0 of the foliage rebuild (meshoptimizer
     auto-LOD and shadow LOD for painted plants — items 38-40 did this for
     props, not for the scatter fields) and painted foliage's own instance BVH
     if placed plants ever need collision beyond the prop box proxy.

108. ~~**CSM splits for an open world**~~ — DONE 2026-09-16. v3 now ships
     `maxFar: 150` with nearSplit-anchored cascades instead of v2's
     `practical`@80 (v3/app/csmSplits.js; v2 is untouched, v3 overrides in
     state/worldState.js).
     **Why 80 was there.** Found in commit 294dde4 (2026-06-19), in a comment
     that was lost when the cascade count changed: with FOUR cascades and
     practical splits, 80 m put the first split at ~11 m, so a character at
     5-15 m sat in a cascade only ~14 m wide — sub-centimetre texels. It was
     never a millisecond budget. A road-game measurement agrees: `maxFar`
     80→400 cost 0.19 ms and drew IDENTICAL triangles and draws, but stretched
     the near cascade until the car's contact shadow disappeared.
     **What had drifted.** Dropping to 3 cascades (the Windows WebGPU cap of 16
     samplers/stage) moved the first split 11 m → 15 m and made the near cascade
     ~35% coarser, without anyone re-picking the 80 that was chosen for 4.
     **The actual trap.** `practical` averages a uniform split with a
     logarithmic one anchored on `camera.near` — 0.5 m here, which flattens the
     log half to nothing. The first split therefore lands at ≈ maxFar/3, and
     shadow RANGE and contact-shadow sharpness fight over one knob.
     **The fix.** Anchor cascade 0 at a chosen distance (`nearSplit`, default
     10 m) and space the rest logarithmically to maxFar. three sizes each
     cascade to its slice's far-face DIAGONAL, so a cascade ending at d has a
     texel of `d·k/mapSize` while a screen pixel there is `d·k'/height` — both
     linear in d. Constant split ratios therefore put every cascade's far edge
     at ~1 texel per screen pixel (measured in-browser: 1.08 at all three).
     MEASURED in the editor at 2048, aspect 1.57: boxes 23.5 / 85 / 324 m =
     **1.15 / 4.15 / 15.8 cm per texel over 0.5–10 / 10–39 / 39–150 m**, against
     1.71 cm and 80 m for practical@80. A SHARPER near cascade with nearly
     double the reach, same cascade count, same map.
     **Why 150 and not more.** Prop LOD tiers start at 60 / 150 / 500 m and a
     tier casts only while its start is inside maxFar (item 38). At 80 the LOD1
     props from 80-150 m were drawn into shadow maps that stopped short of them;
     at 150 that work becomes visible shadow and LOD2 still never casts. Past
     150 a whole tier of casters switches on. 150 is the largest range that is
     free.
     Splits are LIVE (breaks are uniforms; `updateFrustums()` does not
     recompile), unlike `cascades`/`fade` — so Split mode, Near split and Max
     far all A/B from the World panel, which prints the bands and their texel
     sizes. Cost A/B'd interleaved (3 rounds × 60 frames): 1.638 ms both ways —
     but in an EMPTY scene, so that only proves the range itself is free, not a
     loaded one. Re-measure on a world with real casters.
     **Judge it yourself:** World → Shadows → "Shadow test scene"
     (v3/debug/shadowTestScene.js) lays ten identical stations at 3-175 m, each
     a pole, an arch with a gap under it, a six-tooth comb 18 cm apart and a
     ball resting on the ground, all on a white disc so the shadow is read
     against flat white rather than painted terrain. Pads are ringed and
     labelled with their cascade and its texel size, coloured strips mark the
     splits and maxFar, and everything re-labels live as you drag. "A/B: try
     practical @ 80" flips between v2's pairing and v3's in one click — the
     comb at 3 m goes 1.1 cm ↔ 1.6 cm per texel and the three farthest stations
     lose their shadows entirely. Costs ~370 draws / ~1.5 ms while shown,
     nothing when hidden, and it is editor-only.
     Known, not fixed: three's cascade-fade margin is computed against
     `Math.max(camera.far, maxFar)` and our camera.far is 4096, so the margin is
     ≈0 — the shader cross-fades without the bounds expansion it assumes. Watch
     for a band at the split distances. Bias may want re-tuning now the far
     cascade's texels are larger, and per-cascade `mapSize` is already possible
     (each cascade light owns its shadow) if the far one should drop to 1024.
     Not done, and the real answer past ~150 m: terrain self-shadowing by a
     ray-march against the height texture — resolution-independent, no cascade,
     kilometres of mountain shade. A cascade is the wrong tool for that.

109. ~~**Terrain self-shadowing**~~ — DONE 2026-09-16 for the TERRAIN
     (render/lighting/terrainSunShadow.js). Before it the terrain cast nothing
     at all: it is not a CSM caster, so a ridge at sunset lit both its sides.
     Each terrain VERTEX marches 32 exponential steps toward the sun through the
     heightmap with a k·clearance/t penumbra, and the result is interpolated.
     Vertex stage because the terrain FRAGMENT shader is still at exactly 16/16
     samplers (re-checked live); the vertex stage had room and already reads the
     heightmap, so this adds no binding. Nothing is baked: the sun can move every
     frame and a sculpt shows its new shadow at once.
     It reaches lighting by wrapping the SUN'S SHADOW NODE, not via
     `receivedShadowNode` — CSMShadowNode only calls that hook inside its
     cascades, so past maxFar (where mountain shade matters) it would never run.
     The wrapper branches at shader BUILD time on `material.terrainSunShadowNode`;
     every other material gets the plain CSM node and pays nothing.
     Verified in the editor on a 250 m ridge under a 14° sun: a ~1 km soft
     shadow across the plain, sunlit back-slope ridges correctly occluded, no
     acne on the sunny side, and the shadow swings round with the sun.
     Cost **+0.239 ms** (march compiled in vs out, 3 interleaved rounds, 60 FPS,
     whole world in view). Panel: World → Shadows → Terrain shadows + softness.
     **Then BAKED (same day).** The march now runs into a 1024² float texture
     (`createTerrainShadowMap`) storing the HEIGHT the shadow reaches (R) and the
     distance to what casts it (G), so any material can ask "am I above the
     shadow?" and the penumbra still widens with occluder distance. The terrain
     reads it once per vertex. Visually identical to the per-vertex march, and
     slightly sharper far away (1 m texels instead of coarse far vertices).
     Re-bakes: FULL when the terrain changes or shadows are switched on; while
     the SUN turns, one of 16 horizontal bands per frame (render-target
     scissor), sweeping until the sun stops; otherwise nothing.
     Measured interleaved: per-frame read **0.036 ms** (was 0.239). Bake cost
     taken as 40 stacked bakes against the 5-tap normal bake, because a single
     bake timed through `onSubmittedWorkDone` reads a ~3 ms FLOOR for any pass
     (the normal bake read 3 ms too — a harness artefact, not a cost): full
     bake **~0.5 ms**, one band **~0.15 ms**. So: fixed sun ≈ 0.04 ms/frame,
     animated time of day ≈ 0.19 ms/frame, sculpting +0.5 ms per stroke frame.
     Sweep verified live: one band per frame while the sun moves, the rest of
     the sweep after it stops, then zero; no seams between bands.
     **Then everything else receives it (same day).** Two paths:
     - Every SHADOW-RECEIVING material (props, trunks, the player, grass rings,
       near foliage/flower levels) gets it through `wrapSunShadow`: one read of
       the baked map at the fragment's world position, multiplied into the
       sun's shadow term — direct sun only, which is physically right.
     - Materials that skip shadows (far foliage/flower levels, susuki, v2 leaf
       cards, v3 leaf field, impostors) use `terrainShade(colour, vis)`, which
       darkens the colour toward "Shade on vegetation" (World → Shadows,
       default 0.45). It checks `receiveShadow` at BUILD time so a receiver is
       never darkened twice. Sun-driven emissive (grass SSS + specular, foliage
       and flower see-through light, susuki back-light) is multiplied by
       visibility on every level, since emissive never passes a shadow.
     v2 files are not made to import v3: the grass takes the helpers through a
     `terrainShadow` constructor option; v2's chunked leaf cards are shaded
     from treeEnvironment, once per material (`userData.terrainShaded`).
     TRAP FOUND: `positionWorld` is a varying built once from the PRE-instancing
     position. Read inside another VERTEX-stage varying on an InstancedMesh it
     is the local billboard corner near the world origin, so every impostor
     and prop read "lit". Proven with a debug colour (red = shaded, green =
     lit) and by reading the baked map at tree positions: a tree 80 m under the
     shadow top stayed bright at shade floor 0. Fix: the read is in the
     FRAGMENT stage, where positionWorld is the interpolated world position
     all lighting uses. The debug view then matched exactly, including a tall
     spire whose tip pokes above the shadow line and stays lit.
     Second trap: `material.needsUpdate` reuses the cached pipeline when the
     cache key is unchanged, so a runtime A/B of a BUILD-time switch needs a
     bumped `customProgramCacheKey` (proven: grass vertex shader 12,562 →
     10,950 chars).
     Costs, build-time switch in vs out, interleaved at 60 FPS:
     props + trees + impostors (43 materials) **+0.022 ms**; grass **+0.169 ms**
     until the colour/emissive read and the shadow-term read were made to
     share ONE node (`material.terrainSunShadowNode = sunVis`), then
     **+0.033 ms**. Foliage/flowers share the same way; not measured separately.
     `setActiveTerrainShadowMap(null)` before materials build is the game-level
     "off" that removes the reads entirely.
     Open:
     - The vegetation shade is a colour multiplier, not a direct-light removal:
       near (receiving) and far (shaded) foliage levels can differ slightly in
       a mountain's shade at the LOD boundary. Tune "Shade on vegetation" with
       eyes.
     - The toggle is a uniform; with the bake it costs almost nothing when off
       (bakes stop, one read per vertex remains).
     - At very fast day speeds a sweep's 16 frames can leave bands a fraction
       of a degree apart; invisible at normal speeds, not checked at extremes.
     - No terrain shadow while CSM is disabled (only the CSM node is wrapped).
     - Resolution is the clipmap's vertex spacing: 1 m near, coarser far, which
       suits mountain shade but cannot draw a thin distant ridge's shadow.

### Not ported — v3 is equal or better, or it was retired

Sculpt / procedural / erosion, paint and TSL ground/meadow, cliffs (v3
procedural cliffs + GLB), hole / cave / tunnel, trees and foliage (ported),
Gemini / revo / billboard grass, snow v1 and v2, all four v2 road systems,
v2 river and River+, water bodies, clouds v1-v3, sky / post / lens flare /
fog (in v3), Lotus and VVV cars (stunt car covers them), chunk streaming.
The old `games/rts` (v2 prototype) was deleted 2026-09-14.

**Rivers → River v2 only (DONE 2026-09-15):**
- DONE: River v2 Water look → Style: Realistic (default) / Stylized
  (riverV2StylizedMaterial.js — the old River's "Stylized v1" ported term for
  term: across = bank to bank at any width, along = a fixed pattern length
  instead of stretching over the whole river). Saved with the water state.
- DONE: `app.getWaterLevelAt` includes River v2 channels; new
  `app.getRiverChannels()`; rts-v3 navGrid stamps River v2 (no River+ reads left
  in games).
- DONE: River and River+ removed from v3 — toolbar button, mode dropdown,
  panels, systems (riverSystemGpu.js, the dead v3RiverCarvingSystem.js,
  buildRiverPanel.js, riverState.js), undo/delete keys, save keys `rivers` /
  `rivers2` (old files load without their rivers). v2/tools/river stays for
  the v2 editor.

**River v2 — add only if you ever need them** (River+ had both; not ported):
- **Tributaries that stay attached.** Today a river ending near another only
  copies that river's water level once. River+ kept a saved link: the branch
  mouth snapped onto the parent, kept the parent's level, followed it when the
  parent moved, and could branch from the middle of a river. The River v2
  solver already takes a `mouthLevel` (riverV2Channel.js solveRiver), unused.
- **Closed loops** (a moat, a river round an island). River v2's centreline is
  always open (riverV2Channel.js sampleCenterline).

## Engine / game split (agreed 2026-09-15)

The editor builds WORLDS; games add gameplay on top of a loaded level (the
rts-v3 model). Measured 2026-09-15: both games fetch v3/editor.html, inject the
whole editor and hide it — rts-v3 loads 249 modules incl. 25 editor panels,
17 editor tools and 60 v2 files. The ENVIRONMENT (sky, lights, clouds, shadows,
fog, ocean, post, lens flare) must be optional and replaceable: a game uses the
default, the level's, or its own (modular-road has its own sky, clouds, ocean).

101. ~~Step 1 — games stop fighting the editor~~ — DONE 2026-09-15.
     `startV3App({ editor: true })` from the editor page only; a game boots
     without it and gets no editor shortcuts (RTS: N switched the editor to
     Player start, P started editor play mode), no editor camera (wheel
     capture, double-click focus, fly/focus keys), no per-frame orbit
     re-enable or mouse-button rebinding (the game owns `controls`), no
     View-mode click-to-select, no gizmo helper in the scene, no Scene list /
     Inspector / panel refresh, no status bar or splitters. Also fixed: trees,
     leaf cards, foliage and snow were handed `worldEnv.getSunDir()`, which
     never existed — they always used a fixed default light direction; they now
     get the real light (the moon at night) 👁. Checked: RTS (N/P inert, game
     wheel zoom, dblclick inert, no gizmo helper), modular-road (boots, build
     wheel zoom now OrbitControls only — it was editor zoom + OrbitControls
     together, so one wheel step zooms less 👁), editor unchanged.
102. **Step 2 — environment as optional pieces.** Mostly DONE 2026-09-15:
     - `startV3App({ environment: false })`: none of it is built; the engine
       renders plainly; grass/susuki/trees/foliage/snow/lakes/rivers take the
       game's light (`app.environment.setLightDirection`) or a default; lakes
       get their clock from the loop. (Found: `syncGrassUniforms` returned
       early without an environment, skipping the whole grass look.)
     - Hooks on the default environment: `environment.sky.setVisible` (kept
       through sky-mode changes — replaces finding domes by name),
       `environment.ocean.state/set`, `light.sun/hemi/getDirection()`
       (replaces scene traversal), `shadows.csm` (live), `postFx.apply()`.
       Existing: `clouds.setSystem`, `envSky.set/invalidate`, `lensFlare.*`,
       `fog.*`, `light.set`.
     - `games/empty-game/`: starter template (boot, load a level incl. the
       reload-at-size pattern, `?env=none` with its own lights). Checked both
       ways, plus the editor, rts-v3 and modular-road unchanged.
     modular-road moved onto the hooks 2026-09-15: engine sky via
     `environment.sky.setVisible` (F8 A/B intact), shadow node, shadow light
     and sun via `shadows.csm` / `light.sun` (checked identical to the old
     scene lookups first), dev-panel post FX via `postFx.apply()`, and the
     per-frame mouse-button re-assert removed (the engine no longer rebinds).
     Left: boot options that skip BUILDING single pieces (ocean, post FX,
     lens flare) for games that never use them.
103. **Step 3 — world runtime without editor DOM.**
     3a DONE 2026-09-15 — game pages no longer touch editor.html:
     `startV3App({ container })` draws into the game's element; every editor
     element lookup (449 in main.js, the panel builders, tree/foliage env,
     editorShell) goes through `v3/ui/uiRoot.js` — the page in the editor, a
     hidden never-attached copy of the editor markup in a game (lazy chunk,
     ~117 KB, games only). rts-v3, modular-road and empty-game dropped the
     fetch/inject/hide-with-CSS code (empty-game doesn't even import
     editor.css). Checked in dev AND a production build (rts-v3 from `vite
     preview`: boots, 20 units, no editor.html request), editor panels
     identical to the baseline row counts.
     3b WRAPPED UP 2026-09-15 (partial, by choice): games no longer build the
     tool panels (trees, foliage, props, spline, spawn, lake, tunnel, lane
     road, river v2, rivers, road, susuki), the World panel (also rebuilt on
     every load), Scene list, Inspector, tab/section wiring, play physics /
     flight panels, fly HUD, gizmo hint or play fullscreen chrome. Editor
     panels checked identical control counts vs the previous commit; all
     three games boot clean. Measured: a game boot still makes ~440 lookups
     into the hidden copy, nearly all main.js sculpt/paint/generator/erosion/
     heightmap UI (~1200–2500) and grass/snow/cliff/auto-paint UI
     (~4000–4850), where panel code and runtime code the games need are
     tangled. Cost to games: ~15 KB gzip once + a few ms of DOM work, nothing
     on screen. ACCEPTED LEFTOVER — shrink it when those sections are edited
     for another reason; not worth a dedicated risky pass.
104. **Step 4 — split tools + public API.**
     4a DONE 2026-09-15 — one door and a guarded boundary:
     - `v3/engine.js`: `startV3App`, `createLevelLoader`, terrain size
       constants, and `PUBLIC_ENGINE_MODULES` (the building blocks a game may
       import by path: bloom/instancing/water/cloud helpers, wet road, vehicle
       physics, the v2 prop builders still to move). tools/
       gameImportBoundaryTest.mjs fails when a game imports anything else
       from v3/ or v2/, or when the engine imports from games/.
     - `v3/io/levelLoader.js` replaces three copied world loaders (rts-v3,
       modular-road, empty-game). The game's own level reloads at its terrain
       size without asking (before, a size mismatch silently dropped the
       heightmap); player-picked files ask. Every load ends with
       refreshWorldHeights. No HEAD probe (the dev server's fallback answers
       200 for missing files).
     - Wet road shading moved from games/modular-road-v3/modularRoadWet.js to
       v3/render/roads/wetRoad.js (v3's asphalt imported it from the game).
     - Deploy bug fixed: rts.v3proj was outside public/, so the built RTS
       404'd and ran on flat procedural terrain; now public/games/rts-v3/.
       Checked in a production build: reloads at the level size, 20 units,
       real heights.
     Terrain size per page (FIXED 2026-09-15): the size was one localStorage
     key for the whole site, so a game reloading at its level's size changed
     the editor's size too, and two games with different sizes reloaded each
     other. The editor keeps `v3.terrainConfig`; every other page saves under
     `v3.terrainConfig:<path>` (heightmapTexture.js). Checked: editor stays
     2048 m after the empty game reloads to 1024 m, and the game's second visit
     does not reload.
     Still to do: runtime half (build from data,
     meshes, colliders) vs editor half (handles, brushes, undo) for lakes,
     rivers, tunnels, roads, splines, props; one engine entry file; racing-game
     code out of v3/play; the v2 files still used move in.

## Rocks & cliffs — made in Blender, not generated (decided 2026-09-17)

105. **Procedural cliffs = the rock generator with a flat top (2026-09-17,
     look being judged 👁).** Two dead ends first: an SDF generator (rounded
     prisms + carved grooves, surface nets) and a "chipped column" generator
     (straight walls, stacked fused eggs) — both unusable: a chip plane only
     stays small on a surface that curves away in every direction, so straight
     walls turn chips into rim bevels or vertical strips. The reference cliffs
     are LUMPS with flat tops, so proceduralRock.js gained `topCut`,
     `maxChipUp` and `squareness` (rock kit output unchanged) and
     ROCK_CLIFF_PRESETS (Chip Pillar / Slab / Mesa / Block) go through addCliff.
     Facet size follows chip DEPTH (~sqrt(2·R·d) spread): cliff-scale facets
     need many shallow chips, few big cuts, simplifier error below chip depth.
     The strata kit (proceduralCliff.js, Crag/Butte/Spire/Wall/Ledge/Mesa) is
     DELETED; projects that used it skip those slots with a console warning.
     Open: user verdict; ~0.7 s per cliff on the main thread (worker/cache
     before it is a kit); the arch/holes stay Blender or kitbash.
106. **Procedural rock kit — shape approved 👁 2026-09-17; shading in
     (look being judged 👁).** Shading, shared by rocks and cliffs, no
     samplers: the generator bakes `rockShade` (x = edge bend from vertex
     normals, 2 blur passes; y = height 0..1) and props/rockShading.js turns it
     into a cool blue-grey base → light top gradient, darker downward faces,
     brighter chip edges (smoothstep 0.012–0.06 on the bend: flat facets
     measure ~0.002, edges 0.03–0.1), world-space mottling, base AO. All knobs
     are uniforms in `material.userData.rockShading` (tune live, no rebake).
     Boulders, lumps and cliffs weight the attribute in the simplifier so the
     edge band does not smear (`attributeWeights` added to autoLod
     simplifyGeometry; triangle budgets unchanged). Measured: +0.065 ms GPU at
     5k rocks (1.864 vs 1.799 ms, 5 interleaved rounds, 69 draws both).
     Fixed on the way: a project reload rebuilt every `solid` slot's material
     with the cliff grass blend, so boulders came back with grass tops; slots
     now carry `kit: "rock" | "cliff"` and one `_finishKitMaterial` is used on
     add, material change and load. Save → load round trip checked in the
     browser (instances, shading, blend, lodScale, collision flags).
     Earlier notes:
     v3/props/proceduralRock.js: dense sphere pushed radially to the nearer of
     an egg (lumps) and ~55 chip planes + a few big cuts, soft-min chip edges,
     then meshoptimizer to a budget. INDEXED. Kit = 12 types: Boulder A-D,
     Lump A-C, Stone A-C, Pebble A-B (props panel → Add Rock; restored on
     load). LOD0 budgets 1200 / 1000 / 400 / 200 tris; auto-LOD builds 1 & 2.
     Size classes, opt-in per type in propInstancer/propStore: `lodScale`
     (LOD + fade distances × 1 / 1 / 0.5 / 0.2), `maxShadowCascade`
     (stones ≤1, pebbles 0), collision solid / solid / box / `noCollide`.
     Measured (1296×825, 4 interleaved rounds × 90 frames, mean): 5k rocks
     +0.44 ms GPU with the size rules vs +0.65 ms without; 20k rocks +0.59 ms
     vs +1.15 ms, 69 draws either way, rock tris 1.04 M vs 2.88 M. Kit
     generation 0.7 s total. Debug: `__V3_DEBUG.rockPreview()`,
     `rockStress({ count, radius })`.
     Open: user look check on the shading; a real tileable detail texture
     (triplanar) instead of noise mottling; no crease AO yet (these shapes are
     convex, the bake found no concave vertices); boulder LOD0 reads a bit
     low-poly up close at scale 3+ (try 2000 tris, LOD1 takes over at 60 m).
     Rock-set brush DONE 2026-09-17 (look 👁): Props → Add Rock → "Paint as
     rock set", then Paint mode. v3/tools/rockSetBrush.js plans each stamp —
     class by mix weights (boulder/lump/stone/pebble sliders), random kit
     shape, per-class tilt, uneven scale, sink by height; size-aware spacing
     (similar sizes keep footprints apart, a pebble may touch a boulder's
     base); boulders/lumps drop 2-6 small "satellite" rocks. PropSystem gained
     an optional `scatterPlanner` hook; one stroke = one undo step (checked).
     Measured: 642 rocks from 6 strokes in 6.2 ms total (planner 0.06 ms per
     stamp in Node); big-rock footprints never overlap. Brush settings are
     session-only (not saved with the project).
     Panel thumbnails DONE 2026-09-17: Add Rock / Add Cliff are thumbnail
     card grids (same look as Procedural Objects). Baked in the background at
     editor boot, one tile per task, via bakeObjectThumbnails; cached in
     IndexedDB (props/rockThumbnailCache.js, key = generator params + size +
     THUMB_VERSION — bump it when the look changes without params changing).
     Geometry is memoised (getRockGeometry), so the thumbnail's generation is
     reused when a card is clicked: adding a cliff went ~0.7 s → 2 ms. Cold
     bake cost: four ~200 ms frames at boot (the cliffs), once; a warm load
     reads the 16 tiles from IndexedDB.

## Sky — four modes, one owner (started 2026-09-18)

The editor had three sky modes: `physical` (three's `SkyMesh`), `hdr` (an image,
which also lights the world) and `procedural` (`v3/render/sky/dayNightSky.js`,
our day/night dome). The racing game had a fourth of its own. This is the work
to share ONE sky and then decide what to delete — the river treatment: compare
first, port what is worth keeping, delete only on the user's go.

**Both domes are already Hillaire, and that reframes the whole comparison.**
`dayNightSky.js` runs a three-LUT chain (transmittance 256x64 → Ψms 32x32 →
sky-view 256x256) — it is NOT a painted gradient. The game's sky is a SECOND,
independent Hillaire implementation (sky-view 192x108) with different constants
(atmosphere top 6460 km vs 6420 km), so the two do not agree at the same hour.
That is the comparison, not a bug.

110. **Step 1 — the sky moved into the engine.** DONE 2026-09-18. Four files out
     of `games/modular-road-v3/` into `v3/render/sky/`: `modularRoadSky.js` →
     `atmosphereSkyDome.js`, `modularRoadSkyAtmosphere.js` → `skyAtmosphere.js`,
     `modularRoadMoon.js` → `moonSurface.js`, `modularRoadMilkyWay.js` →
     `milkyWay.js`, plus the three noise primitives they bake from into
     `v3/render/noise/periodicPerlin.js` (the game's 637-line cloud-noise file
     keeps its volume bakes and re-exports the primitives, so nothing there
     changed). `createModularRoadSky` → `createAtmosphereSky`; the dome mesh is
     `AtmosphereSkyDome`. Added to `PUBLIC_ENGINE_MODULES`; the game and four lab
     pages import from the new paths. `tools/shaderLint.mjs` and
     `tools/lookRebaseTest.mjs` re-pointed (lookRebase uses its existing
     `[path now, path at BASELINE]` form, same as the wet-road move).
     Checked: boundary test green, 178/178 fast lane, production build clean,
     the game boots with its sky drawing (60 FPS, 3.28 GPU ms, 29 draws).

     WHY THE SPLIT IS THE POINT, independent of which dome wins the look:
     `skyAtmosphere.js` hands out `skyRadiance(dir)` as a TSL node AND
     `sunTransmittanceCPU()` — the same T-LUT integral on the CPU. That is what
     lets a cloud deck take its key-light colour from the model the sky is drawn
     with, so the two agree through the day instead of drifting apart as two
     authored palettes. `dayNightSky.js` welds its LUT chain inside the dome,
     where nothing else can read it.

111. **Step 2 — a fourth editor mode, `atmosphere`.** DONE 2026-09-18.
     `toolState.atmosphereSky` (in `LOOK_SLICES`, so a project saves it; an older
     project without the block just takes the defaults — sparse merge). Built
     LAZILY on the first switch: measured **565 ms** of LUT bakes and shader
     compile, once per session, so nobody who never picks it pays at boot.
     - ONE CLOCK for both domes. Time of day, latitude, day of year and moon age
       stay in `proceduralSky` and are mirrored into the dome each frame, so
       switching modes does not teleport the sun. Both files derive the sun from
       those four numbers with the same formula (checked line for line) — leave
       them to drift and the dome paints its disc in one place while the light,
       the cascades and the flare use another, which reads as a shadow bug.
       `autoAdvance` is forced off on the dome so the hour is not advanced twice.
     - `skyMode === "procedural"` became `isDomeMode()` at ~12 sites: visibility,
       the night moon-key branch, the time-of-day clock, the IBL re-bake, env
       intensity, and the volumetric cloud deck's gate — the deck belongs to
       EITHER dome, or the new mode could only ever be judged with a bare sky.
     - THE IBL COMES FROM THE SKY YOU CAN SEE. `activeEnvSky()` picks the game's
       registered sky, else whichever dome the mode shows; switching between the
       two domes tears down the capture rig (it holds a CLONE of the mesh) and
       re-bakes. Without that the world is lit and reflected by one sky while a
       different one is drawn overhead — visible first on wet and metal.
     - The dome's own IBL re-bake key had to be written from scratch: a stale key
       freezes the environment at whatever it baked first, which looks like
       nothing is wrong until you drag the time of day and the world does not
       follow.
     - Fog `matchSky`, the cloud deck's key/ambient and the ocean's sky
       reflection all read `proceduralSky`'s authored day/night colour PAIRS,
       which this dome does not have (its look is a function of the hour). Each
       got an atmosphere branch fed from one per-frame evaluation. Deliberately
       NOT `getColors()`, which re-runs the full `evaluateSky` that `update()`
       just finished and allocates ~20 Colors doing it; the band weights are
       exported and allocation-free. Colours are LINEAR out of the look, so
       consumers `copy` and never `set` again.
     - Panel: the dropdown LABELS now name the implementation — "Physical
       (three.js)" / "Procedural (day/night)" / "Atmosphere (scattering)" —
       because "Physical" stopped meaning anything with two physical skies in
       the list. Saved values unchanged. Time-of-day controls factored into
       `_buildTimeOfDayControls` and shared by both dome panels.
     - THE FLOOR TRAP travelled with the dome and needed no new fix: below the
       horizon the model draws the planet as a sun-lit grey ball. The dome does
       not use it — downward rays sample the atmosphere AT the horizon (azimuth
       kept, so a sunset floor glows warm sunward) then deepen into the zenith
       blue. Two documented failed attempts: gating the mix to the authored nadir
       (itself a pale blue-grey), and mirroring the horizon band down with a
       gentle dim (stayed pale). Do NOT tint the model's ground albedo.

     TWO BUGS IN THE FIRST CUT, both found by the user looking at it, both mine:
     - **THE SKY WAS BLACK.** `createSkyAtmosphere` is handed IN to the dome, so
       whoever owns it owns its clock — and nothing was calling
       `atmosphere.update(sunDir, camY, moonDir)`, which is what bakes the
       sky-view LUT. `skyRadiance` is a plain sampler read of that target, so it
       returned black, and with `atmosphereMix: 1` that is the whole sky. It did
       NOT look like a bake failure: the stars, the moon and the authored
       gradient underneath all still drew correctly. The game has always had this
       on its own line right after the dome's update; the editor just never got
       it. Worth remembering as a shape: a handed-in resource with its own bake
       step is a second thing to drive, not just a second thing to construct.
     - **THE DOME DERIVED ITS OWN SUN.** Standalone it owns the clock; in the
       editor it must not, because the sun IS the directional light and time of
       day is only one of the things that writes it — dragging the sun sliders
       moves the light and never touches the clock. Measured on a default
       editor: clock at 21.27 while the light sat at +12° elevation, so the dome
       would have painted night over a world lit for midday even once the LUTs
       baked. `evaluateSky(P, override)` now takes `{ sunDir, moonDir }` and the
       editor passes the light's direction and `_skyMoonDir`, exactly as it has
       always done for dayNightSky. STILL ON THE CLOCK, and a known limit: the
       dawn-vs-dusk warmth bias (`duskBias`) reads `timeOfDay`, so if you place
       the sun by slider rather than by hour, twilight can pick the wrong one of
       the two warm palettes. Fix that by making time of day two-way, if it ever
       matters.

     CLOUDS — the editor has one deck, the game has two, and only one of those
     is a port gap:
     - The volumetric deck (`dayNightCloudLayer`) is the editor's own and now
       runs under BOTH domes (verified drawing under the atmosphere dome). It is
       `enabled: false` by default (v2/app/config.js) and always has been, in
       every sky mode — so "no clouds" in a fresh editor is the default, not the
       port. World → Cloud layer (volumetric).
     - The PAINTED deck is `games/modular-road-v3/modularRoadPaintedClouds.js`,
       still game-owned; the editor passes `null` for it, which leaves its
       texture fetches out of the compiled dome entirely. Bringing it over is a
       further move: ~2000 lines, and it pulls `makeWorley` and
       `normalizeChannel` out of the game's cloud-noise bakes, which deliberately
       did NOT move (their frequency budget is tuned for a car flying through the
       deck, not for an editor camera 2 km below a ceiling). NOT DONE — needs a
       decision, because it is the game's cheap tier rather than a better deck.

     FOUND AND FIXED ON THE WAY, pre-existing at HEAD: the World panel's sky-mode
     dropdown called a bare `refreshLiveSliders()` that is not defined in that
     module, so **every sky-mode change threw**, skipping both the widget swap
     and the pane refresh. Now guarded like every other call site.

112. **Step 2b — the CLOUDS came too ("stage A").** DONE 2026-09-18. Step 2
     shipped the dome only, over the EDITOR's cloud deck — which is a different
     deck (1900 m ceiling vs 260 m, tuned for a camera 2 km below rather than
     one flying through) and off by default. The user's read of "the game's sky"
     was the whole environment, and they were right: a sky and the clouds under
     it are ONE look, not two features. Six more modules moved:
     `modularRoadClouds.js` → `v3/render/clouds/volumetricCloudDeck.js`,
     `modularRoadPaintedClouds.js` → `paintedCloudDeck.js`,
     `modularRoadCloudNoise.js` → `cloudNoise.js` (+ its worker, which is loaded
     by `new URL(..., import.meta.url)` so it had to land in the same folder),
     `modularRoadCloudShadowMap.js` → `cloudShadowMap.js`,
     `modularRoadSkyEnv.js` → `v3/render/sky/skyEnvProbe.js`. The last two are
     LAB-ONLY — checked, `roadGame` imports neither — so they moved for tidiness,
     not for parity.

     THE ORCHESTRATION MOVED WITH THEM, which is the part that matters.
     `syncCloudSkyColours` (~120 lines inside roadGame) is now
     `v3/render/sky/cloudSkyLight.js` and BOTH the game and the editor use it —
     the game's local copy is gone, not duplicated. It is what makes the deck
     belong to the sky: key light is the real slant-path transmittance to the
     deck's mid-altitude (not the sky's disc colour, which floods every cloud
     flat salmon at golden hour), the moon takes the light slot once the sun is
     truly down, ambient leans off the horizon BAND toward the dome at twilight,
     and the aerial target is the horizon the clouds sit on. Every constant in
     there was arrived at by looking at a wrong frame; the comments say which.

     Editor state: `atmosphereSky.cloudTier` ("volumetric" | "painted" | "off",
     the game's three tiers), `atmosphereClouds` and `atmospherePaintedClouds`,
     all in LOOK_SLICES. Seeded from the GAME's art direction, not the module
     defaults — coverage 0.55 rather than 0.9, which is the difference between
     broken cumulus and a solid overcast sheet. The marched deck goes through
     the same `renderWithClouds` composite a registered game deck does, but a
     game's own system still wins. Checked: game boots unchanged (3.20 ms, 29
     draws, same as before the orchestration swap), editor draws the deck at
     1.93 ms GPU / 8 draws / 60 fps, all three tiers switch and switch back.

     TWO TRAPS, both cost time:
     - `createModularRoadClouds` does NOT parent its own mesh — it hands one
       back and the caller adds it (roadGame:770 always did). Miss that and
       everything constructs, no error is thrown, and nothing draws.
     - The tier switch had a `if (tier === toolState...cloudTier) return;`
       guard, and the panel dropdown is BOUND to that field — it writes the new
       value and THEN calls the handler, so the guard always found them equal
       and the tier silently never changed. Compare against what was actually
       BUILT (`_atmoBuiltTier`), never against the bound state.

     STILL NOT THERE (stage B): weather, aerial haze, world rain, lens rain —
     `modularRoadWeather.js`, `modularRoadAerial.js`, `modularRoadWorldRain.js`,
     `modularRoadRainLens.js`, ~2150 lines. Note the boundary agreed with the
     user: the weather chain also drives ROAD WETNESS and the car's grip, and
     that half is gameplay and stays in the game.

113. **Step 2c — the world lit BY the sky, and the flare.** DONE 2026-09-18.
     The user looked at the two side by side and said the editor was darker, the
     sun different, the flare different. All three were real, and the first was
     a piece of the sky system nobody had inventoried.

     MEASURED at the same moment, game vs editor: exposure 0.9969 / 0.70, env
     0.4466 / 0.20, sun 2.5771 / 2.20, ambient 0.5955 / 0.40. Every game value a
     computed fraction, every editor value a round default — which is the tell
     that one end was being driven and the other was not. The game has
     `syncWorldLightToSky`; the editor had nothing, so it drew the game's sky
     over a world lit by static defaults.
     - Now `v3/render/sky/skyWorldLight.js`, shared: the game's copy is gone.
       Key colour is the sun's own transmittance reduced to CHROMATICITY (the
       engine owns the brightness; feeding the full value dims twice and loses
       the sunset), floored at the horizon and handed to the moon below it —
       skip that and the world is lit by saturated sunset orange from dusk till
       dawn. Ambient is the sky's zenith and haze, over a night floor, because
       the sky's honest night radiance is #010104 and that renders silhouettes.
       Exposure and env strength ride the same daylight curve.
     - It COMPUTES, it does not apply: key-cached on solar elevation, so with a
       frozen clock it runs once and returns null forever. That is right for the
       sky and wrong for a lightning flash, which is why the game keeps its own
       `applyWorldLight` on top. (The first version of that, in the game, put
       the flash inside the cached function and it never fired once.)
     - The reference (noon: dir 2.6 / hemi 0.6 / exposure 1.0 / env 0.45) is the
       racing game's, and the game wrote down why: the editor's own 0.2 env /
       0.4 hemi is "why the scene reads dark — almost nothing fills the shadows".
       Held PER MODE, not written into `toolState.light`, so choosing this sky
       cannot relight the other three or a project saved under them; leaving the
       mode restores the previous lighting exactly (verified).
     - Flare: `SKY_LENS_FLARE_LOOK` moved to `v3/render/sky/skyLensFlareLook.js`
       and is applied ONCE on first entry to the mode (never re-applied, so
       anything dialled afterwards stays), leaving `enabled` alone — arriving in
       a sky mode is no reason to switch an effect on for someone. Per frame the
       flare's SIZE follows `sunSizeDeg / 3.4` and its COLOUR is the sky's live
       `sunColor` (already linear — converting again is the 5-10x error that
       stays self-consistent and hides).

     VERIFIED by matching numbers, not by eye: editor and game now agree to four
     decimals at 12 h, 19.2 h and 22 h — e.g. at 19.2 h both read exposure
     0.7731, env 0.2507, sun 0.8979, ambient 0.3343, key #ffb15a. Editor 61 fps,
     1.67 ms GPU, 8 draws.

     NOT A BUG, for the record: the "different sun" was just a different clock —
     game 14.2 h, editor 14.67 h. The editor's light was exactly consistent with
     its own hour (14.67 h at lat 45 / doy 172 → 51.04° computed, 51.07° actual).

     OPEN QUESTION the user raised: whether the EDITOR's global light defaults
     (2.2 / 0.4 / 0.2) should become the game's (2.6 / 0.6 / 0.45). It would make
     every mode brighter, and it would change how everything tuned against the
     current defaults reads — grass, terrain, cliffs and rocks were all tuned in
     the days before this. Needs the user's eyes, separately from the sky work.

114. **Step 2d — the editor BOOTS into it.** DONE 2026-09-18, at the user's ask:
     `skyMode: "atmosphere"` with `cloudTier: "painted"`, the same pair the
     racing game ships. Painted is the game's boot tier for the reason it gives —
     "the fallback became the shipping look": a marched slab with real thickness
     and self-occlusion, curving to a horizon, casting ground shadows, with a
     second cirrus layer, at ~0.29 ms against the volumetric deck's ~1.07 ms.
     Volumetric is one click away and is still the one you can fly through.
     A saved project keeps whatever it saved — `skyMode` rides in the look block.
     Editor measured after: 60 fps, 2.91 ms GPU, 5 draws.

     THE PAINTED DECK STILL NEEDS THE COMPOSITE SLOT, which is not obvious
     because you can already see it: the deck itself is drawn by the sky dome,
     and its `prepareFrame`/`compositeOntoLinearHDR` exist only to cast its
     GROUND SHADOWS and god rays. Route only the volumetric deck and you get
     painted clouds with no shadow under them.

     THREE BUGS THAT ONLY A DEFAULT COULD HAVE FOUND — all three were latent the
     whole time, hidden behind `skyMode === "atmosphere"` short-circuiting:
     - `driveFogSun()` runs during setup, ABOVE where the atmosphere state is
       declared, and reads `_atmoColors`. Booting into the mode turned that into
       a temporal-dead-zone ReferenceError and the editor failed to start.
       Scratch hoisted to the top with the rest.
     - The first `applySkyMode` sat above the lens flares and now drives the sky
       once, which touches the flare. Same TDZ, same result. Moved below them.
     - THE GAME GOT A SECOND SKY. `createWorldToolState` is shared, so the new
       default applied to games too — and modular-road hides the engine's dome at
       boot, so the engine built a whole atmosphere dome and painted deck, paid
       the LUT bakes and the shader compile, and hid it. Caught by counting
       meshes: the game's scene had TWO `AtmosphereSkyDome`s. The default is now
       EDITOR-ONLY (`createWorldToolState({ editor, skyMode })`), and a game can
       opt in with `startV3App({ skyMode: "atmosphere" })`. Verified after: the
       game is back to one dome and its own reference lighting (1.0 / 2.6 / 0.6).

115. **Step 2e — the editor and the game now boot on the SAME sky.** DONE
     2026-09-18. Diffed every default that feeds the sky, live, in both. All of
     them already agreed (latitude 45, day 172, moon age 0.55, cloud base 260 /
     thickness 220, atmosphereMix 1, cloudSea 0, sun 3.4° / disc 11 / aureole
     0.18) except three:
     - **The hour.** v2's 9.5 vs the game's `GAME_TIME_OF_DAY` 10.5. The clock is
       shared by both domes, so it moved to 10.5 (and `daySpeed` to the module's
       0.4, so they advance together).
     - **Painted coverage**, 0.46 vs 0.60. The game never authors 0.60 — it seeds
       the painted deck from the VOLUMETRIC deck (0.55 + 0.05) so that switching
       tier changes the cost and not the art direction. That rule only exists
       because the game switches at runtime; the editor boots straight into
       painted and takes the value the rule produces. Measured live to be sure.
     - **THE SUN WAS NOT WHERE THE CLOCK SAID.** The hour and the sun's angles
       are independent state: `setTimeOfDay` writes the angles from the hour, and
       nothing called it at startup. A fresh editor booted with a clock reading
       10.5 and a light at the v2 default 43° / 135° — which is 10.5 h nowhere on
       Earth (latitude 45, day 172 → 61.7°). It went unnoticed while the domes
       were driven purely by the light, because their look never consulted the
       clock; the atmosphere dome's dawn/dusk bias does. Now reconciled ONCE at
       boot, for a dome mode only — inside `applySkyMode` it would throw away
       hand-placed angles on every mode change, and a loaded project already
       reconciles the same way at the end of `importLook`. This also closes the
       `duskBias`-reads-a-stale-clock limit noted in 111.

     VERIFIED by reading both at boot: timeOfDay 10.5, sun 61.719° / 42.178°,
     exposure 1, env 0.45, dir 2.6, hemi 0.6, key #fff5e6, painted coverage
     0.6000000000000001 — identical on every value.

     WHAT STILL WILL NOT MATCH, and it is bigger than any of the above: CAMERA
     ALTITUDE. The dome blends its look across three altitude bands (below /
     inside / above), switching between ~180–280 m and ~450–580 m. The game's
     chase camera is a few metres up and always "below"; the editor's orbit
     camera starts at 300 m, already inside the blend. Same sky, same hour,
     genuinely different colours — and no default can fix it. For a real
     side-by-side, put the editor camera near the ground. (Then weather and
     aerial perspective, which are stage B.)

116. **Step 3 — judge it, then decide deletions.** OPEN — needs the user's eyes.
     MEASURED 2026-09-18, editor at 1347x825, camera aimed so the sky fills most
     of the frame, 5 interleaved rounds of 100 frames each (GPU timestamps
     quantise at 65.5 µs; frame means dither past it):

     | arm | GPU ms | runs |
     |---|---|---|
     | procedural, as shipped (cirrus ON) | **0.582** | .592 .579 .579 .583 .579 |
     | procedural, cirrus OFF | **0.277** | .269 .276 .279 .277 .282 |
     | atmosphere | **0.493** | .495 .493 .490 .491 .496 |

     THE RACING GAME'S A/B WAS MEASURING THE CIRRUS, NOT THE MODEL. That result
     ("physical scattering beats the dome AND is ~0.5 ms cheaper") compared two
     whole DOMES, and `dayNightSky.js` ships `cloudEnabled: true` — analytic
     painted cirrus streaks in the same shader, which is also what the A/B named
     as the fakest thing in the frame. Turn the cirrus off and the engine's dome
     is the CHEAPEST of the three by 0.216 ms, not the dearest. The atmosphere
     dome is 0.089 ms cheaper than procedural-as-shipped and that is the whole
     of its cost win.
     So the look question is still open and is now the only question. Left to
     judge, with the user's eyes, in the user's own worlds: day, night, twilight,
     and a high camera; and the honest arm is procedural WITH CIRRUS OFF.
     Nothing deleted, nothing chosen.

     KNOWN WART CARRIED OVER, not fixed: the dome's `cloudBase + cloudThickness`
     (260 + 220 = 480 m) drives its below/inside/above palette AND its fake
     "cloud sea", neither of which matches any real deck. In an editor you fly
     past 480 m routinely. The mode ships `cloudSea: 0` (as the game does) so the
     sea never appears; the band-weight mismatch is still there and would want a
     real number before this dome could be anyone's default.

## Performance

Nothing left that is felt: the game is vsync-locked with ~4× GPU headroom.
Reopen only for a specific target (a weaker machine, 120 Hz, 1440p).

Checked 2026-09-13 after the triplanar finding: the other switch-gated terrain
features (snow, lakebed, river sand, auto-paint, height blend) compiled OUT all
together save only 0.1–0.4 ms unpainted and 0.3–0.6 ms painted at 4.76 Mpx
(two runs each, ~0.03–0.15 ms native). Their gates work; no change made.
Large-scale variation was already measured free.

## Suggested order (updated 2026-09-17)

1. ~~Viewport selection + prop foundation~~ — DONE 2026-09-14 (28-30, 35-37,
   43, 45). Left open: per-prop highlight tint (44; the orange box outline
   stays) and per-prop incremental updates (41, not felt).
2. ~~Dropped textures surviving a reload (31)~~ — DONE 2026-09-14.
3. Grass look pass, panel and horizon (16-18), with your eyes.
4. ~~Before the city builder or any scene past ~10k props: shadow culling +
   shadow LOD (38), per-prop culling (39), meshoptimizer auto-LOD (40).~~ —
   DONE 2026-09-16 (38, 38b, 39, 40); CSM splits (108) and terrain
   self-shadowing (109) on top.
5. More Genshin textures (3). ~~Small paint gaps (4, 5)~~ — DONE 2026-09-17.
6. ~~Terrain mirror / clone / region copy-paste (13).~~ — DONE 2026-09-17.
7. Roads: the lane-based engine replaces Smart Road 2 — follow the road order in
   its section (shader paint with wear and wetness, 50-52, first).

v2 retirement track (agreed 2026-09-14, runs next to the above): save gaps and
shortcut fixes (84-87) → shared widget module, splitters, status bar (88, 90,
91) → Inspector + Scene list search/menu (89, 92) → gameplay markers, barrier
zones, audio (93-96) → waterfall, ambient FX, flowers, decals (97-100) → delete
v2 (what v3 still imports moves into `engine/`).
