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

16. **Grass panel cleanup** 👁: 59 controls, 16 of them two hand-placed light
    directions. Named presets plus a few real controls.
17. **Grass look pass** 👁: match the Genshin ground colour.
18. **Grass horizon.** Blades stop around 400 m and bare ground shows beyond.
    Tint the terrain where grass is painted.
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
    lateral, wheelPath}: asphalt + paint + paint wear + wet (modularRoadWet).
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

38. **Shadow pass draws every prop.** The sun's shadow map covers 160 m, but all
    ~13k visible props are drawn into it. GPU: nothing measurable up to ~8k
    props; +1.8 ms at 11k, +4.4 ms at 17k, +5.9 ms at 20k (about 2/3 of it
    shadows). Fix: per-camera culling (cull again with the shadow camera; the
    modular-road pass culler already does this) + **shadow LOD** (separate
    cheap shadow meshes; frustum from the shadow camera, level chosen from the
    main camera; proxy switch tied to the shadow box size).
39. **Coarse culling.** 256 m cells: 51% of drawn props were off screen
    (7,395 of 14,622, ~4M triangles). Keeping only on-screen props cut 20k from
    9.2 to 5.4 ms. Fix: per-instance culling through the instance BVH (plane
    mask: a fully-inside subtree needs no more tests).
40. **No automatic LOD.** LOD1/LOD2 exist only if hand-made GLBs are imported;
    built-in shapes and procedural cliffs have none (a 960-triangle sphere at
    500 m). Fix: generate LODs with **meshoptimizer** (used in their skinning
    example). Do it better than the example: simplifyWithAttributes (keeps
    normals/UVs) and compact the vertex buffer (the example only rewrites the
    index, so memory is not saved). The same simplified meshes serve as shadow
    LODs (38).

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
86. **Stale shortcuts and hidden modes.** Toolbar tooltips say Sculpt (S),
    Paint (P), Grass (G), River (V): S and G do nothing, P starts play, V is
    View. Snow, Cliff Paint and River+ exist only in the mode dropdown.
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
99. **Flowers** (`v2/core/legacy/fleur-painter.js`): ground or stemmed, 3 bloom
    shapes, colour presets, wind and interaction. Rebuild on a density map like
    susuki rather than copying the position list.
100. **Decals** (`v2/tools/decals`): image decals, conform to terrain, gizmo.
     Shares work with road surface decals (57).

### Not ported — v3 is equal or better, or it was retired

Sculpt / procedural / erosion, paint and TSL ground/meadow, cliffs (v3
procedural cliffs + GLB), hole / cave / tunnel, trees and foliage (ported),
Gemini / revo / billboard grass, snow v1 and v2, all four v2 road systems,
v2 river and River+, water bodies, clouds v1-v3, sky / post / lens flare /
fog (in v3), Lotus and VVV cars (stunt car covers them), chunk streaming.
The old `games/rts` (v2 prototype) was deleted 2026-09-14.

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
103. **Step 3 — world runtime without editor DOM.** `createWorld()` (renderer,
     terrain+heights, vegetation, props, water, roads/splines/tunnels,
     collision, project load); the editor attaches on top; game pages stop
     injecting editor.html. System by system. applyProjectData has ~15
     editor-panel calls to move out.
104. **Step 4 — split tools + public API.** Runtime half (build from data,
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
