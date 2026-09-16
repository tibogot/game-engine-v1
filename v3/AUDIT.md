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
4. **Target strength.** The Opacity slider only scales stroke strength, so a
   stroke still drives a layer to full weight. Unity caps it (a 30% mud scatter).
5. **Per-layer tint and UV rotation**, to reuse one texture twice.
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
8. **Top-N layer sampling.** A fully painted world costs 4.5 ms because all 7
   layers are read. Only worth it once worlds are heavily painted.
9. **Procedural slider edits have no undo.**

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
13. **Mirror, clone, copy-paste** (terrain tools, not objects). Mirror: make one
    half of the terrain the mirror image of the other (symmetric maps). Clone
    brush: Alt+click a source, paint to copy its heights and paint elsewhere.
    Region copy-paste: copy a rectangle of terrain, paste it with rotate / flip
    / height offset.
14. **Non-destructive edit layers** like Unreal's. Large; roads and rivers
    already do this per tool.
15. ~~Modifier keys in the hints~~ — DONE 2026-09-14. The sculpt panel
    already had them; it now also lists Shift/Alt+scroll. The ? overlay was
    sculpt-only and out of date: rewritten by group (camera, sculpt, every
    brush, props, mode keys, project), each checked against the key handlers.

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
    Still open for the GoT match: dithered terrain grass shadows in the far
    field, blade folding, displacement buffer for all objects, painted blade
    height. Ground UNDER near blades is still the painted ground (a GoT-look
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

38. **Shadow pass draws every prop** — PARTLY DONE 2026-09-16. The CSM reaches
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
98. **Ambient FX:** painted butterfly and falling-leaf emitters, 3 leaf types
    with physics (`v2/core/ambientfx`). Cheap, a lot of life.
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
101. ~~**Foliage**~~ — REBUILT 2026-09-16 (phases 1-2 of 5). The v2 billboard
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
     only its geometry and its shader nodes. Flowers already share the noise and
     the density layer; moving the rest of flowers (and susuki, the third copy
     of this architecture) onto it is the next clean-up.
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
     Remaining: phase 0 (meshoptimizer auto-LOD, shadow LOD — items 38-40),
     GLB import with impostors, placed (non-painted) foliage with the instance
     BVH, and textured cards for plants geometry cannot afford.

102. ~~**CSM splits for an open world**~~ — DONE 2026-09-16. v3 now ships
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

102b. ~~**Terrain self-shadowing**~~ — DONE 2026-09-16 for the TERRAIN
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

## Performance

Nothing left that is felt: the game is vsync-locked with ~4× GPU headroom.
Reopen only for a specific target (a weaker machine, 120 Hz, 1440p).

Checked 2026-09-13 after the triplanar finding: the other switch-gated terrain
features (snow, lakebed, river sand, auto-paint, height blend) compiled OUT all
together save only 0.1–0.4 ms unpainted and 0.3–0.6 ms painted at 4.76 Mpx
(two runs each, ~0.03–0.15 ms native). Their gates work; no change made.
Large-scale variation was already measured free.

## Suggested order (updated 2026-09-14)

1. ~~Viewport selection + prop foundation~~ — DONE 2026-09-14 (28-30, 35-37,
   43, 45). Left open: per-prop highlight tint (44; the orange box outline
   stays) and per-prop incremental updates (41, not felt).
2. ~~Dropped textures surviving a reload (31)~~ — DONE 2026-09-14.
3. Grass look pass, panel and horizon (16-18), with your eyes.
4. Before the city builder or any scene past ~10k props: shadow culling +
   shadow LOD (38), per-prop culling (39), meshoptimizer auto-LOD (40).
5. More Genshin textures (3), small paint gaps (4, 5).
6. Terrain mirror / clone / region copy-paste (13).
7. Roads: the lane-based engine replaces Smart Road 2 — follow the road order in
   its section (shader paint with wear and wetness, 50-52, first).

v2 retirement track (agreed 2026-09-14, runs next to the above): save gaps and
shortcut fixes (84-87) → shared widget module, splitters, status bar (88, 90,
91) → Inspector + Scene list search/menu (89, 92) → gameplay markers, barrier
zones, audio (93-96) → waterfall, ambient FX, flowers, decals (97-100) → delete
v2 (what v3 still imports moves into `engine/`).
