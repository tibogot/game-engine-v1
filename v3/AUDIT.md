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
7. **Splat size allowed up to 4096.** Paint is CPU-side, so that is 64 MB per
   layer per stroke. Cap at 2048, or measure first.
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
15. **Modifier keys in the hints** (Shift lowers, Ctrl smooths, Alt flattens),
    since Unity and Unreal use different ones.

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

## Roads (later; Smart Road 2 plan has the details)

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
34. **Housekeeping:** test harnesses leave `.name.PID.mjs` temp files when
    interrupted (a try/finally would stop it).

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
7. Roads when ready (road undo, 23, first).
