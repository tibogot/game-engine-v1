# v3 editor audit — what is left

Compared against Unity and Unreal terrain editors. Last updated 2026-09-13.
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
11. **Concavity filter** (the third Unity brush filter).
12. **Terrain holes** for caves and tunnels (rendering, collision, readback).
    Only with a real need.
13. **Mirror, clone, copy-paste.**
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

28. **Textures from dropped local files don't survive a reload** (only the name
    is saved). An "import to /textures" step would close this.
29. **Texture compression.** Paint layers use ~74 MB of VRAM; KTX2 would cut it
    for the games.
30. **City builder** — its own 4-phase track.
31. **Housekeeping:** test harnesses leave `.name.PID.mjs` temp files when
    interrupted (a try/finally would stop it).

## Performance

Nothing left that is felt: the game is vsync-locked with ~4× GPU headroom.
Reopen only for a specific target (a weaker machine, 120 Hz, 1440p).

Checked 2026-09-13 after the triplanar finding: the other switch-gated terrain
features (snow, lakebed, river sand, auto-paint, height blend) compiled OUT all
together save only 0.1–0.4 ms unpainted and 0.3–0.6 ms painted at 4.76 Mpx
(two runs each, ~0.03–0.15 ms native). Their gates work; no change made.
Large-scale variation was already measured free.

## Suggested order

1. Grass look pass, panel and horizon (16–18), with your eyes.
2. More Genshin textures (3), small paint gaps (4, 5, 7).
3. Roads when ready.
