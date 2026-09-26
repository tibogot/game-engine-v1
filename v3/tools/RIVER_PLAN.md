# River v2 → a river NETWORK: research, audit, plan

Status (2026-09-26): **P1 — the height layer stack — BUILT, verified, NOT yet
committed** (see §7). River v3 not started. Research/plan written the same day.

## Asks (recorded the turn they were made)

2026-09-26 — the brief:
- Make River v2 "the best river system it can be, with branches".
  **Don't code yet**: research, audit, then propose a plan for approval.
- Audit, against the nam-rts map `public/levels/nam-valley.v3proj`:
  - the conform rewriting the WHOLE terrain from its own `base`; other edits
    (pads, bridge landings, paddies) survive only via
    markExternalEdit / editBase / coversRect — fragile, caused lost pads.
    **The river should own ONLY its footprint.**
  - the look: the grab-free two-pass mode nam-rts uses, the screen-copy cost,
    banks, depth colour, foam, flow; "near the cliffs the map reads dark and
    muddy".
  - gameplay queries: getWaterLevelAt, nav blocking, shorelines, bridges
    (deck heights, landings), vegetation kept out of the water.
  - cost in GPU ms (ms, not fps). Measure with `__V3_DEBUG.gpuAB`.
  - keep in mind every other reader of the heightmap / water: grass and
    foliage scatter, decals, the paddies' terrain holes, the nav grid.
- Research (web + official docs, cited): Unreal Water plugin; Unity R.A.M,
  KWS, Crest, spline/flowmap tools; Gaea / World Machine / Houdini river and
  erosion workflows; rendering (flowmaps and their generation, depth colour
  and absorption, foam, wet banks, caustics, SSR vs planar vs probes; the
  paddies' post-chain SSR in games/nam-rts/paddyReflections.js).
- Deliverables, in order: (1) feature comparison both ways; (2) a river
  NETWORK data model (tributaries, confluences, splits, deltas, oxbows) with
  continuous conform / flow / level at junctions; (3) an architecture that
  replaces "rewrite the whole terrain from a base" (e.g. a river-owned height
  layer/delta), with costs; (4) a prioritised plan with a GPU-ms budget per
  feature, after measuring the current river.
- Put it all in this file and record every ask here the same turn.
- Rules: ask before every commit; work on main; NEVER commit
  `v3/render/water/oceanSurface.js` or `v3/ui/buildOceanV2Panel.js` (another
  session owns the ocean); nam-rts must keep working — check the map in the
  GAME; report GPU ms; judge objective visuals from my own screenshots, hand
  taste calls to the user.

2026-09-26 — follow-up (no code):
- "Wouldn't it be easier to test the river in the v3 EDITOR than in the game?
  The game is full of things; in the editor we can work on the river alone."
- "Since we are making many changes, shouldn't we build a RIVER V3 that
  replaces v2 later if everything is good?"
- Proposed answer (awaiting the user): yes to both, with the conditions in
  §6.

2026-09-26 — follow-up:
- Shortcut for River v3 mode: "don't worry for now" — no key yet.
- "Layer stack before River v3, or v3 first?" — user didn't follow the
  question and asked for my recommendation. Recommended: **layer stack
  first** (§6, "Order"). Awaiting the user's go.

2026-09-26 — "ok lets go": **approved: build the layer stack (P1) first**,
River v2 adapted as the river layer, checked in the game on nam-valley before
any River v3 work. Ask before every commit.

2026-09-26 — "are you sure all you did was for the best? I don't see a
difference yet" (brief answer, no code): answered — nothing visible by design;
the gain is edits near the river surviving; the cost is the slower editor
drag.

---

## 0. TL;DR

- **The architecture bug is real and it is one line.** The resolve pass
  (`riverV2System.js:406`) writes `target = natural` for every texel no river
  reached, i.e. **all 1,048,576 texels of the heightmap are rewritten from the
  river's private copy of the ground on every conform** — while the river's
  footprint on nam-valley is 73,134 texels (7%). Everything fragile
  (`_cpuBase`, `markExternalEdit`, `_foldExternal`, the 60 ms `_rebaseNow`,
  `editBase`, `coversRect`, `reassertPads`) exists to keep that private copy in
  sync with edits it should never have owned. **Fix: a height LAYER stack**
  (ground → river operator → stamps), the Unreal edit-layer model. §3.
- **The river is cheap.** 1.0 ms with the river filling ~40% of the frame at
  close play zoom, within noise (≤0.6 ms) at max zoom-out, ~0 off screen. Half
  the close-up cost is the second (add) draw. §4.1.
- **nam-valley's river is a 500 m torrent drawn as one smooth slope.** The
  upper 60% falls 95 m at 10–31% grade; 210 of 344 stations sit at the 9 m/s
  speed clamp with Froude 1.5–2.0. That is physically a cascade, rendered as a
  tilted glass sheet — and it is why foam had to be switched off (it would
  white-cap the whole upper river). Real torrents are step-pools: flat pools
  and short cascades. §4.2.
- **"Dark and muddy near the cliffs" is mostly slope, partly the river.** The
  dark patches measure 43–67°. Some are natural cliffs (cut 0 m); others are
  river cut banks 7–8 m deep, and at one station the channel is **24 m below
  the original ground**. The bank flare is capped at 4× bank width, so a deep
  cut ends up steeper than `maxBankSlope` (42°) and far steeper than the game's
  34° "unwalkable must look unwalkable" rule, which paints it dark. §4.3.
- **Nobody ships river→river junctions well.** Unreal's Water plugin documents
  none (rivers only meet lakes/oceans); Crest and HDRP have no network at all;
  R.A.M cross-fades overlapping meshes by vertex alpha. The winners come from
  Houdini-side tools and the literature. Our associative "nearest, then
  resolve" conform is already the right base for junctions. §1, §2.

---

## 1. Comparison — what others do that we don't, and the reverse

Sources are listed per tool at the end of the section. "Ours" = River v2 as of
bbd31f0.

### 1.1 Feature matrix

| Feature | Unreal Water (5.x) | Unity HDRP Water | R.A.M 3 | KWS2 | Crest 5 | Houdini HDAs / HZD | **Ours (River v2)** |
|---|---|---|---|---|---|---|---|
| Spline metadata | width, depth, velocity, audio per point | — (no splines) | cross-section profile per point, height painter | — (sim) | waves, flow, foam, absorption, scatter per point | width ramp from slope, per-spline whitewater | width, depth, bank, level (auto/pinned) per node |
| Velocity | authored per point | painted current map | UV direction + painted | simulated | spline/paint inputs | from curve + terrain | **solved** (Manning from the profile) |
| Network / junctions | river↔lake/ocean only; **no river↔river** | none | split/connect; vertex-alpha crossfade | emergent from sim | not documented | split/merge with "waterfall stepping" | endpoint pins to neighbour's level; global nearest-segment conform |
| Non-destructive carve | **yes — edit-layer brush stack**, Alpha/Min/Max/Additive modes | no carve | carve + paint (likely destructive) | no carve | no carve | regenerates the heightfield | "non-destructive" via a private base copy — **fragile** (§3) |
| Cut AND fill (lift a river) | Alpha blend mode | — | — | — | — | HZD: "never higher, only lower" | **yes**, with flaring levee banks |
| Flow data for shading | velocity baked into the water-info texture, blurred | painted RG map | mesh UV + painted | sim velocity | flow LOD data | flowmap baked from curve/obstacles | per-vertex `aFlow` on the ribbon, two-phase advection |
| Foam sources | velocity foam (reported broken since 5.0); 5.6 shallow-water sim whitewater | generators, shore-wave deformer | vertex paint, slope cascades | speed threshold, advected, particles | shoreline depth, inputs | distance-to-obstacle, vorticity | Froude rapids, shallows, **screen-space wake** (grab mode only) |
| Shoreline / wet bank | weightmap gradient array painted along the carve | shore deformer | object wetness | shoreline + wetness | depth-cache shallow shading | skirt mesh / DBuffer wetness | flat tan **sand recolour band** (riverSandTsl); no wetness |
| Depth colour | Single Layer Water absorption + scatter | built in | shallow/deep gradient | yes | absorption + scattering inputs | material | per-channel Beer-Lambert + inscatter |
| Reflections | SSR / Lumen | HDRP | probes | yes | yes | engine | sky gradient; SSR in grab mode only (off by default) |
| Waterfalls | not native | box deformers | automatic from mesh slope | "water doesn't fall" | not documented | waterfall stepping on steep drops | **dedicated waterfall system sharing the river shader**; open-mouth attach |
| Lake/ocean transition | River-to-Lake / River-to-Ocean materials + overlap priority | n/a | vertex alpha | zones pass flow | shared data textures | ocean blend | none (level must just agree) |
| Water mesh / LOD | one quadtree tile mesh for all bodies, morphing | instanced quads | CPU/GPU tessellation | zone mesh | LOD rings | static mesh | tessellated ribbon per river, 13 m cull chunks |
| Gameplay query | `GetWaterSurfaceInfoAtLocation` (height, normal, **velocity**, depth) | `ProjectPointOnWaterSurface` (Burst CPU mirror) | runtime API | API | depth probe | — | `sampleFlow` / `sampleFlowAt` / `flowForceAt` (height, bed, depth, velocity, turbulence), 0.3 µs |
| Vegetation exclusion | weightmaps / PCG `Get Water Spline Data` | — | "remove foliage" | — | — | scatter toggles | waterSurfaceMap tap in every scatter + both grass systems + placement gate |

### 1.2 What they do that we don't (the ones worth having)

1. **Carving as a regenerated LAYER, never an edit (Unreal).** The river carve
   is re-rendered from the splines on its own edit layer; hand sculpting lives
   on other layers; removing the river restores the terrain; nothing is kept in
   sync by hand. This is exactly the fix for our lost-pads class of bug (§3).
2. **Per-body blend modes (Unreal).** Alpha / Min / Max. Epic's own confluence
   rule: where a river meets a lake, use **Min**, "to prevent the river from
   raising the elevation inside the lake's carved-out terrain". We need the
   same rule river↔river: a tributary may never FILL its parent's bed.
3. **One world-space water-info texture (Unreal, Crest).** Height, depth,
   velocity for every water body rendered top-down into one texture, velocity
   **blurred** — the blur is what makes the flow continuous across a junction.
   We already have half of this (waterSurfaceMap holds height only).
4. **Bank material painted by distance from the waterline (Unreal weightmap
   gradient array, Lagarde wet surfaces).** A wet band, then mud, then gravel,
   instead of one flat recolour.
5. **Cascades from slope (R.A.M, Houdini "waterfall stepping", HZD
   "reservoirs and cascade areas").** A steep reach is broken into flat pools
   and short drops instead of one inclined sheet. This is the fix for
   nam-valley's upper river (§4.2).
6. **Discharge-driven sizing (Gaea Rivers, World Machine).** Tributary size
   comes from accumulated water, not a hand-set width; meander size grows with
   bankfull width (World Machine River device).
7. **Asymmetric bends (World Machine "migrating deepest points";
   geomorphology).** Thalweg toward the outer bank, steep cut bank, gentle
   point bar.
8. **Velocity in the gameplay query (Unreal).** We already have it — noted
   because it is the one place we are level with the best.

### 1.3 What ours does that they don't

1. **Cut AND fill with a solved profile.** A river can be lifted above its
   valley and grows a levee that flares until it meets `maxBankSlope`. Unreal's
   Alpha mode moves height, but nothing there flares a bank; HZD's rule is
   literally "never higher, only lower".
2. **Solved hydraulics.** Velocity from Manning, whitewater from the Froude
   number. Everyone else authors or paints velocity, or runs a sim.
3. **An associative conform.** "Nearest, then resolve": passes compose in any
   order, a river can fold back on itself (verified on a 26 m hairpin, 0.01 m
   bed error), and all rivers share one path texture so a confluence resolves
   by construction. Unreal's forum shows river pieces splitting into separate
   planes on height edits; we fixed exactly that class.
4. **Screen-space obstacle wake.** Any drawn object in the water grows a foam
   tail with no per-object work. Unreal's river material has this as an open
   feature request. (Grab mode only — nam-rts runs grab-free and loses it.)
5. **The waterfall IS the river shader.** Shared code guarantees the two match.
6. **Grab-free exact per-channel compositing** (multiply + add passes). The
   same idea as McGuire & Mara's phenomenological transparency; none of the
   tools above ship it.
7. **Headless solver with tests** (riverV2ChannelTest.mjs, 74 checks).

### 1.4 Sources

- Unreal Water bodies, spline metadata, carving, blend modes, transitions:
  https://dev.epicgames.com/documentation/en-us/unreal-engine/water-body-actors-in-unreal-engine
- `UWaterSplineMetadata`: https://dev.epicgames.com/documentation/en-us/unreal-engine/API/Plugins/Water/UWaterSplineMetadata
- Landscape edit layers: https://dev.epicgames.com/documentation/en-us/unreal-engine/landscape-edit-layers-in-unreal-engine
- Landscape Blueprint brushes (Landmass): https://dev.epicgames.com/documentation/en-us/unreal-engine/landscape-blueprint-brushes-in-unreal-engine
- Water mesh / Single Layer Water: https://dev.epicgames.com/documentation/en-us/unreal-engine/water-meshing-system-and-surface-rendering-in-unreal-engine
- Water zone / water-info texture (5.5 Python API): https://dev.epicgames.com/documentation/en-us/unreal-engine/python-api/class/WaterZone?application_version=5.5
- Surface query: https://dev.epicgames.com/documentation/en-us/unreal-engine/BlueprintAPI/WaterBody/GetWaterSurfaceInfoatLocation
- 5.4 PCG `Get Water Spline Data`: https://dev.epicgames.com/documentation/unreal-engine/unreal-engine-5.4-release-notes?application_version=5.4
- 5.6 Shallow Water River (and users calling it destructive): https://forums.unrealengine.com/t/community-tutorial-new-in-unreal-engine-5-6-turn-your-water-body-river-into-a-game-ready-niagara-2d-fluid-simulation/2583651 ,
  https://forums.unrealengine.com/t/5-6-are-shallow-water-river-destructive/2659509
- UE river foam issues: https://forums.unrealengine.com/t/water-plugin-in-ue5-does-anyone-know-how-to-use-the-foam-on-rivers-see-video-linked/688819 ,
  https://forums.unrealengine.com/t/minor-uefn-distance-fields-water-foam-in-the-material-of-the-river-on-obstructions-ripples/654754
- River splitting into planes: https://forums.unrealengine.com/t/water-body-river-split-into-separated-planes/1856214
- Unity HDRP water: https://docs.unity3d.com/Packages/com.unity.render-pipelines.high-definition@14.0/manual/WaterSystem-Overview.html ;
  current map https://docs.unity3d.com/Packages/com.unity.render-pipelines.high-definition@17.0/manual/water-create-a-current-in-the-water-system.html ;
  deformers https://docs.unity3d.com/Packages/com.unity.render-pipelines.high-definition@17.0/manual/water-deform-a-water-surface.html ;
  queries https://docs.unity3d.com/Packages/com.unity.render-pipelines.high-definition@16.0/manual/water-scripting-in-the-water-system.html
- R.A.M: https://naturemanufacture.com/river-auto-material-3/ , https://naturemanufacture.com/r-a-m-river-auto-material-2019/ ,
  https://80.lv/articles/naturemanufacture-s-river-auto-material-3-for-unity-is-out-now
- KWS2: https://kripto289.gitbook.io/kripto289-docs/manual/getting-started/dynamic-simulation.md ,
  https://kripto289.gitbook.io/kripto289-docs/manual/water-modules-settings/dynamic-simulation-zone-settings.md
- Crest: https://docs.crest.waveharmonic.com/Components/Inputs/ , https://docs.crest.waveharmonic.com/Packages/Splines/Introduction.html ,
  https://crest.readthedocs.io/en/stable/user/shallows-and-shorelines.html
- Fluid Flux: https://imaginaryblend.com/2025/01/10/fluid-flux-documentation/
- Houdini: flow fields https://www.sidefx.com/docs/houdini/heightfields/flowfields.html ; flowmaps https://www.sidefx.com/tutorials/flowmaps-houdini-for-games/ ;
  river HDA with waterfall stepping https://ajhaworth.com/tech-art/landscape-river/
- Horizon Zero Dawn rivers: https://80.lv/articles/horizon-zero-dawn-procedural-rivers-wires ; breakdown https://simonschreibt.de/gat/river/
- Gaea Rivers: https://docs.quadspinner.com/Reference/Water/Rivers.html ; Erosion_2 https://docs.gaea.app/using/using-gaea/understanding-erosion/erosion_2/index.html
- World Machine River device: https://help.world-machine.com/topic/device-river/ ; Flow Restructure https://help.world-machine.com/topic/device-flowrestructure/
- Godot Waterways (flow/foam bake from a bezier): https://github.com/Arnklit/Waterways

Not verified (fetch failed or no public source): Epic's 5.0 docs page (403),
the R.A.M manual (403), the full Vlachos / Uncharted 4 / Far Cry 5 / Peytavie
PDFs (only abstracts and summaries read), and any public river talk for RDR2,
Ghost of Tsushima, Witcher 3 or Assassin's Creed (none found).

---

## 2. Branches — a river NETWORK data model

### 2.1 What real networks look like (defaults to author with)

| Rule | Default | Source |
|---|---|---|
| Hydraulic geometry (downstream) | w ∝ Q^0.5, d ∝ Q^0.4, v ∝ Q^0.1 — two equal tributaries make a trunk ~1.41× wider, ~1.32× deeper | Leopold & Maddock 1953; review https://agupubs.onlinelibrary.wiley.com/doi/full/10.1029/2003WR002484 |
| Playfair's law | water surfaces are **accordant** at a junction; a small tributary's BED may sit higher and drop into a scour hole | https://en.wikipedia.org/wiki/Playfair's_law ; discordance https://www.sciencedirect.com/science/article/abs/pii/S0169555X1400261X |
| Junction angle | ~72° humid climates, ~45° arid → **60–75° for Vietnam** | Seybold et al. https://www.osti.gov/pages/biblio/1473898-climate-watermark-geometry-stream-networks |
| Confluence bed | avalanche faces at each mouth, central **scour hole**, bar in the separation zone at the downstream inner corner; shear layer between the two flows | Best 1987/88 https://onlinelibrary.wiley.com/doi/abs/10.1111/j.1365-3091.1988.tb00999.x |
| Meander wavelength | 10–14 × width (~11) | https://en.wikipedia.org/wiki/Meander |
| Riffle–pool | pools at bend apexes, riffles at inflections, every 5–7 widths | https://en.wikipedia.org/wiki/Riffle-pool_sequence |
| Bend section | deepest at the outer cut bank (steep), gentle inner point bar (bare sand) | https://en.wikipedia.org/wiki/Cut_bank |
| Delta splits | mouth-bar bifurcations ~70° (70.4° ± 2.6°), discharge split unequally | Coffey & Shaw 2017 https://agupubs.onlinelibrary.wiley.com/doi/full/10.1002/2017GL074873 |
| Oxbows | cut-off loops → oxbow lake → marsh → meander scar | https://en.wikipedia.org/wiki/Meander_cutoff |
| Stream order | Strahler: order = max(a,b), +1 if equal | https://en.wikipedia.org/wiki/Strahler_number |
| Procedural precedent | Génevaux 2013 (drainage graph → terrain), Peytavie 2019 "Procedural Riverscapes" (blend-flow tree for the water surface), Paris 2023 (meander migration + cutoffs) | https://dl.acm.org/doi/10.1145/2461912.2461996 , https://perso.liris.cnrs.fr/eric.galin/Articles/2019-riverscapes.pdf , https://dl.acm.org/doi/10.1145/3618350 |

### 2.2 The model: a directed graph of REACHES joined at JUNCTIONS

```js
network = {
  junctions: [{
    id, x, z,
    kind: "source" | "confluence" | "split" | "mouth" | "fall" | "lake" | "end",
    level: null | number,      // null = AUTO (solved), number = PINNED
    // confluence/split only:
    scour: { depth, length } | null,   // null = derived from angle + Q ratio
    // fall only: the drop is carried by the waterfall system
    // lake/mouth only: the lake/ocean id whose level this junction takes
    target: { kind: "lake" | "ocean", id } | null,
  }],
  reaches: [{
    id,
    from: junctionId, to: junctionId,   // direction = downstream, always
    nodes: [{ x, z, y, width, depth, bank }], // INTERIOR control points only
    flow: { q: null | number, split: null | number }, // q at a source reach,
                                        // split fraction on a split's out-reach
    still: false,                       // true = oxbow / backwater: level from
                                        // the ground, zero velocity
  }],
}
```

What each river feature is in this model:

- **Tributary / confluence**: two reaches end at one `confluence` junction,
  one reach leaves it.
- **Split / distributary / braid**: one reach enters a `split`, several leave
  with `split` fractions (default 60/40). A braid is a split followed by a
  confluence downstream (directed, still acyclic).
- **Delta**: a tree of splits ending in `mouth` junctions that take the
  ocean's (or a lake's) level.
- **Oxbow**: a `still` reach between two `end` junctions (not connected) —
  or simply a lake from lakeSystem placed on the old loop. `still` reaches
  conform like any other but have flat level and zero velocity.
- **Waterfall**: a `fall` junction. The upstream reach ends at the lip, the
  downstream one starts in the pool, and the waterfall system attaches to the
  junction. This **replaces the open-mouth hack** (`setMouthOpen`, the per-point
  half-plane in `pathTex` row 1).
- **Lake / ocean inflow**: a `lake` / `mouth` junction whose level is the
  body's level.

Today's data is a special case: every current river is one reach from a
`source` to an `end`. Import converts losslessly; a mouth snapped to another
river (`_snapMouthToNeighbour`) becomes a `confluence` that splits the parent
reach at the nearest station.

### 2.3 Keeping level, flow and conform continuous at a junction

**Level (Playfair).** A junction has ONE level, shared by every reach end that
touches it. Solve in two stages:

1. *Junction levels*, in topological order (sources → mouths). AUTO level =
   corridor minimum at the junction; ceiling = min over incoming reaches of
   `upstreamLevel − minGradient·length`; pinned junctions hold and report red
   arrows if they break the descent — the same rules `solveRiver` already
   applies to nodes, lifted to the graph. Mouth/lake junctions take the body's
   level.
2. *Each reach*, with BOTH end levels pinned to its junctions (`solveRiver`
   already accepts `mouthLevel`; it gains `sourceLevel`). Interior nodes keep
   AUTO/pinned exactly as now.

**Flow (discharge).** `Q` is set at source reaches (default from Strahler
order or the author) and propagated: `Q_out = ΣQ_in` at a confluence,
`Q_i = split_i·Q_in` at a split. Defaults for width and depth come from
hydraulic geometry (`w = a·Q^0.5`, `d = c·Q^0.4`) and are overridden by any
per-node value — **the author still wins**. Velocity becomes continuity
`v = Q / A(w, d, bedCurve)`, clamped, with Manning used only to suggest the
AUTO depth. That makes speed conserve across a junction (today every reach's
speed is independent of its neighbours, and the torrent is pinned to the
9 m/s clamp).

**Conform.** The associative nearest search already resolves every reach in
one field. What changes at a junction:

- The nearest field keeps the **two best winners from different reaches**
  (RGBA = d²A, idxA, d²B, idxB; `t` is recomputed in the resolve from the
  index). Cost: the same loop, one extra compare.
- The resolve combines them with a fixed rule: inside EITHER channel → the
  **lower bed** (a smooth-min over ~0.3·depth, so the union of two channels is
  a clean junction); on the banks → the nearer reach's section, with its lip
  suppressed where it falls inside the other's channel. This is Unreal's "Min
  at the confluence" rule, generalised.
- A `confluence` junction adds a **scour** (an ellipse deepening the bed just
  downstream of the junction centre, depth from the angle and Q ratio) and a
  **bar** (a raised deposit at the downstream inner corner). Both are shaped
  by the junction, not by a reach.

**Water surface.** Two overlapping ribbons in grab-free mode multiply the
background twice: a visibly darker wedge at every junction (the waterfall
crest hit exactly this, "stacking absorbs the light twice"). Fix, one tap:
each ribbon fragment reads the nearest field at its XZ and **discards unless
its own reach is the winner**. Levels are equal at the seam by construction,
so the seam cannot show. The waterSurfaceMap bake is unaffected (it keeps the
highest surface, and the surfaces agree).

**Flow direction for shading.** The per-vertex `aFlow` is fine inside a reach.
At a junction the two flows must converge. The resolve pass already knows both
winners, so it can write a **world-space flow texture** at the same time:
RG = blended velocity (weighted by distance to each winner), B = shear
(|vA − vB| where both are in range → the confluence foam line), A = distance
to the bank. That is the Unreal/Crest water-info idea, baked at conform time
(not per frame). The shader reads it only near junctions, or everywhere if it
proves cheap enough.

### 2.4 Editing UX (kept small)

The interaction model the user already asked for in River+ (click a node to
branch, prepend to trace upstream) carries over. New: drag a reach end onto
another reach → confluence (or split, if the dragged end is upstream);
junction handles get a kind dropdown; `Shift` reverses a reach. Flow arrows
stay the validity check (red = climbs against the flow) and now also show Q
by thickness.

---

## 3. Architecture — the river owns only its footprint

### 3.1 What happens today (audited)

- `applyConform` → `_resolve()` → a full-screen pass writes EVERY texel of the
  height RT from `_baseSrc` (the river's private CPU copy of the ground). No
  river = `target = natural` — still a write.
- To keep that copy current, the river folds other edits in: `markExternalEdit`
  + `_foldExternal` (mirror edits), a 60 ms debounced `_rebaseNow` (GPU
  sculpt), both only OUTSIDE the coverage mask. Inside the mask the base never
  takes an outside edit by design, so pads and bridge landings there must call
  `editBase` (via `coversRect` in flattenRect, unconditionally in gradeRamp).
- Writers with NO river path that are silently undone inside the footprint on
  the next conform: `remapHeights` (paddies), `raiseBerm`, `flattenArea`
  (sitePlanner), road/lane conform, erosion, spline plateau. Coverage includes
  the whole bank flare, so a berm or paddy edge near the river gets clipped.
- **Conform storms at boot**: each `gradeRamp` (4 landings + the temple), each
  covering `flattenRect`, and `reassertPads` (3×) triggers a full resolve, and
  most also schedule a debounced rebase that resolves again.
- `editBase` changes the ground the solver reads, so an AUTO node near a pad
  can **move the water level** — after the nav grid was built.
- The resolve writes the height RT with its own `_render`, bypassing
  sculptBrush's version/dirty-rect funnel, so normal/grass/shadow bakes only
  refresh after a river-only conform when something else bumps the version.
- `sampleFlow` returns null on the cut banks (the flow index reach is the
  channel + margin, the conform reach is channel + 4× bank) — outside the
  channel that is correct for water, but nothing else can ask "is this ground
  river-shaped?".

### 3.2 The proposal: a three-layer height stack

```
final = STAMPS( RIVER( GROUND ) )
```

| Layer | Holds | Written by | Stored as |
|---|---|---|---|
| **GROUND** | the natural terrain | sculpt brushes, import, erosion, terrace tools, Node patch scripts | raster (the saved heightmap — same semantics as today's saved "base", so **old files load unchanged**) |
| **RIVER** | nothing — an OPERATOR over GROUND, evaluated only inside its footprint | River v2 (network) | procedural (splines + params) |
| **STAMPS** | pads, bridge landings, berms, paddies, temple stairs | flattenRect / gradeRamp / raiseBerm / remapHeights / flattenArea | an ordered list of analytic stamps (rect/ramp/berm/remap-with-region), regenerable |

Rules:

- The river **never stores a copy of anything**. It reads GROUND and writes
  only texels inside its footprint rects (the union of its chunk scissors);
  every other texel of FINAL is GROUND (plus stamps) by construction.
- Stamps sit ABOVE the river, so a pad or a bridge landing next to the water
  always wins, and never moves the water level (the solver reads GROUND, not
  FINAL). `editBase`, `coversRect`, `markExternalEdit`, `_foldExternal`,
  `_rebaseNow`, `_cpuBase`, `exportBaseHeightmap` and `reassertPads` all go.
- Sculpting inside the channel edits GROUND; the river re-applies over it (the
  bank eases back to the NEW ground). A later option, if wanted: a "detail
  above water" raster for boulders on banks.
- Recomposition is **dirty-rect only**: a pad recomposes its rect; a river
  edit recomposes its old ∪ new footprint; a sculpt stroke its brush rect.
- One version counter for FINAL (`heightVersion`), bumped by every compose, so
  normals/grass/shadows/nav/bridge decks/minimap have one thing to watch.

### 3.3 Where the compose runs — CPU authority, GPU upload

Today the truth lives on the GPU and the CPU mirror chases it with async
readbacks — the race behind lost pads mechanism #1. Proposal: **the CPU owns
FINAL** for everything except live editor brushes.

- The river operator already exists on the CPU in all but name:
  `buildFlowIndex` + `bedDrop` reuse the conform's own bed formula. The bank
  (lip + flare + ease) is ported next to it — the same maths, headless-tested
  against the GPU resolve.
- Compose of a dirty rect on the CPU, then `upload` that rect to the height RT.
  `getWorldHeight` becomes exact and synchronous; nothing reads back.
- The GPU path stays for **interactive river dragging** in the editor (the
  current nearest/resolve passes, scissored to the footprint instead of full
  screen), with the CPU compose run on mouse-up as the commit.
- Sculpt brushes stay GPU and read back their rect at stroke end into GROUND,
  as now.

### 3.4 Costs

| Item | Today (measured on nam-valley) | Proposed (estimate) |
|---|---|---|
| Full river conform CPU (drag step, no mesh rebuild) | 1.26 ms | same (GPU path kept for drag) |
| Commit: coverage mask rebuild | 4.12 ms | gone |
| Commit: base upload (1M texels + 16 MB texture) | 1.76 ms | gone; replaced by a rect upload |
| CPU river operator, whole river | — | ~73k texels × ~0.3 µs ≈ **20–25 ms**, once per river commit (editor mouse-up, level load) |
| CPU compose, one pad (20×20 m) | full-map resolve + rebase | ~400 texels ≈ **0.1 ms** |
| GPU per-frame | 0 | 0 (compose runs only on edits) |
| GPU memory | base DataTexture 16 MB + scratch + 2 nearest RTs | GROUND RT replaces the base texture: net ≈ 0 |
| CPU memory | cpuHeightmap 4 MB + `_cpuBase` 4 MB | GROUND 4 MB + FINAL 4 MB + stamps (KB) |
| GPU conform pass time | **not measurable here**: every single-pass timing read the ~16 ms `onSubmittedWorkDone` floor (trap #5) | — |

Boot on nam-rts gets cheaper: the conform storms (≥8 full resolves + rebases)
become one river compose plus rect composes per stamp.

### 3.5 Save format and migration

- The saved `heightmap` blob is GROUND — identical to today's saved base. Old
  `.v3proj` files load unchanged.
- `riversV2` (list of rivers) → `riverNetwork` (junctions + reaches); the
  importer converts the old slice.
- Editor-placed stamps (if the editor ever gets pads) save as a `heightStamps`
  list. Game stamps (nam-rts pads) are regenerated at boot as now, but go
  through the stamp layer, so `reassertPads` is deleted.
- **nam-valley's Node patch tools** (`tools/terraceTerrain.mjs`,
  `tools/patchNamValley.mjs`) keep editing the heightmap blob = GROUND, which
  is now the right thing everywhere (today it is right outside the river and
  silently overridden inside it).

### 3.6 Who else is affected (checked)

- **Grass, foliage, flowers, scatter**: read the height RT + waterSurfaceMap;
  unchanged, but should key off `heightVersion` instead of today's accidental
  refresh.
- **Decals**: glued to the live heightmap in the vertex stage; unchanged.
- **Paddies**: terrain holes are splat-only (unchanged); their `remapHeights`
  becomes a stamp, so a paddy near the river can no longer be clipped by the
  bank flare.
- **Nav grid**: rebuilds on `heightVersion` / `riverVersion` instead of once at
  boot; today a late conform (3 s `reassertPads`, a mouth opening) leaves nav
  stale.
- **Bridge decks**: remeasured on `riverVersion`.
- **Waterfalls**: read GROUND for the brink march (today `sampleBase`) — same
  data, new name.

---

## 4. Audit findings (measured in the game, 2026-09-26)

Setup: own Chrome on a debug port (the MCP profile was locked by another
session), `http://localhost:5173/games/nam-rts/nam.html`, 1904×905, DPR 1,
renderScale 1, clean profile (no stale localStorage). River grab-free (the
nam-rts default), foam off (the map's setting). Screenshots in the session
scratchpad, not the repo.

### 4.1 GPU cost

`__V3_DEBUG.gpuAB`, 4 interleaved rounds × 90 frames. River hidden with
`layers.set(31)` (not `.visible`, which `cullForCamera` re-asserts every
frame). Cross-checked with rAF frame time at pixel ratio ×1.6, where vsync
cannot clamp (the GPU counter is known to under-report in nam-rts).

| Camera | River cost (gpuAB) | noise | add pass alone | rAF ×1.6 delta |
|---|---|---|---|---|
| close play zoom (dist 52), river ~40% of frame | **1.00 ms** | 0.60 | 0.46 ms | 1.34 ms |
| max zoom-out (dist 130), river ~15% of frame | 0.60 ms | 0.94 | 0.26 ms | 0.51 ms |
| river off screen | ≈ 0 (culling fixed 2026-09-24) | — | — | — |

Reading: at play distance the river is at most ~1 ms, and **half of it is the
second (add) draw**, which re-runs the entire shader (normals, FBM, fresnel)
to emit `rest`. The zoom-out delta is inside the noise.

CPU per edit: `_solveAll` 0.32 ms, drag conform 1.26 ms (2.03 with mesh
rebuild), coverage 4.12 ms, base upload 1.76 ms.

### 4.2 The profile: a torrent drawn as a ramp

| arc (station) | level m | width m | slope | speed m/s | Froude |
|---|---|---|---|---|---|
| 0 (source) | 95.6 | 7 | 31.4% | 9 (clamp) | 2.03 |
| 51 | 62.6 | 10.6 | 16.2% | 9 | 1.87 |
| 102 | 43.1 | 14.5 | 21.0% | 9 | 1.73 |
| 154 | 13.9 | 18.2 | 18.5% | 9 | 1.63 |
| 205 | 0.9 | 21.9 | 3.4% | 9 | 1.54 |
| 222 | 0.2 | 23.1 | 0.5% | 4.27 | 0.72 |
| 257–343 (estuary) | 0 → −0.2 | 25–33 | 0.05–0.09% | 1.5–2.0 | 0.24–0.30 |

210 of 344 stations are at the 9 m/s clamp. The surface is one continuous
inclined sheet from 95 m to sea level. Consequences: flow speed cannot read
(everything is "max"), the Froude foam would saturate the whole upper river
(which is why the map has foam off), and the water looks like a tilted mirror.
**Step-pools** (flat pools + short cascades, auto-inserted where the grade
exceeds a threshold — HZD's "reservoirs and cascade areas", Houdini's
"waterfall stepping", R.A.M's slope cascades) fix all three at once, and make
bridges and fords easier to place (flat pools).

### 4.3 "Dark and muddy near the cliffs"

Probed the dark areas of a zoomed-out gorge frame (station 68, x −138 z −100)
with `pickWorldAtClient` + `getWorldNormal`:

| probe | slope | height − ground-before-river | verdict |
|---|---|---|---|
| (−142, −81) | 66.7° | −7.1 m | river cut bank |
| (−155, −86) | 61.8° | −8.3 m | river cut bank |
| (−103, −111) | 49.9° | −0.2 m | natural cliff |
| (−97, −126) | 43.0° | −0.1 m | natural cliff |
| (−166, −92) | 42.0° | −0.1 m | natural cliff |
| channel (−141, −97) | 21° | **−24.1 m** | the river bed, 24 m under the old ground |

Causes, all objective:
1. The bank flare is clamped to `bank × bankFlareMax` (4×). Where the cut is
   deep the flare runs out and the wall ends steeper than `maxBankSlope`
   (0.9 = 42°) — measured 62–67°.
2. `maxBankSlope` 42° is steeper than the game's 34° slope rule, so even a
   correctly flared bank is painted dark rock and nav-blocked.
3. AUTO levels + force-downhill let the channel sink 24 m under a ridge — the
   River+ "canyon through the mountain" problem, back in River v2 because it
   has no `maxGorgeDepth` clamp.
4. The water itself: a uniform teal, a hard waterline, then a flat tan sand
   band with no wet darkening. Whether a brown silty Mekong look would read
   better is a **taste call for the user** — the parameters exist (absorption,
   inscatter); it costs nothing.

### 4.4 Gameplay

- `getWaterLevelAt` (main.js:7124): ocean → lakes → `sampleFlow().inChannel`.
  Correct for the channel. Nav, units (air), jungle canopy, specimen plants,
  enemy line, birds, fog banks, minimap and the site planner all read it.
- Nav (navGrid.js:213–254): slope > 34°, or water at centre/corners, then
  shoreline dilation 3.5 m, river circles from `getRiverChannels`, bridges
  carved last. **Built once at boot**; later re-conforms leave it stale.
- Bridges: placement by hand (the deck-height method in memory); landings
  `gradeRamp` → `editBase`; decks raycast once at boot. `gradeBridgeLandings`
  measures the live (conformed) ground while writing the base, and would
  double-grade if run twice (`reseatWorld`).
- Vegetation: waterSurfaceMap everywhere + CPU placement gate. Good; keep.

---

## 5. The plan — prioritised, with a GPU-ms budget

Budget rule: **the river stays ≤ 1.0 ms at close play zoom (today's cost)
with every feature below turned on**, paid for by P3's pass merge. Each step
ships with a `gpuAB` A/B (river on / off / feature off) at close and max
zoom, and a look check in the GAME on nam-valley (not the editor). Ask before
every commit.

| # | Step | Why first | GPU ms budget (close zoom) | CPU |
|---|---|---|---|---|
| **P1** | **Height layer stack** (§3): GROUND raster, RIVER operator (footprint-scissored), STAMPS list; CPU compose + rect upload; `heightVersion`; delete `_cpuBase`/editBase/coversRect/markExternalEdit/rebase/reassertPads; route flattenRect, gradeRamp, raiseBerm, remapHeights, flattenArea through stamps | the root of the lost-pads class of bug; everything else builds on it | **0** (edit-time only) | river commit ~20–25 ms, pad ~0.1 ms |
| **P2** | **Network data model** (§2): junctions + reaches, graph level solve, Q propagation, top-2 nearest field, junction combine rule, scour/bar, per-pixel ribbon ownership discard; import old `riversV2`; `fall` junction replaces open mouths | the ask; P1 makes it safe | **+0.05** (1 nearest-field tap per water pixel) | solve +<1 ms |
| **P3** | **Cheap second pass**: the multiply draw needs only `K` (thickness from the heightmap + a flat-normal fresnel + opacity) — no normal maps, no FBM. Foam moves to the add pass as additive white. Dual-source blending (one draw) investigated as a follow-up: three r184 has only the WGSL directive, no `src1` blend factors | pays for P4–P6 | **−0.3 to −0.4** (the measured add/multiply split is 0.46 / 0.54) | 0 |
| **P4** | **Step-pools**: auto-insert cascade segments where the grade exceeds ~4%: flat pools, short steep drops with Froude foam; `maxGorgeDepth` clamp; flare that always honours `maxBankSlope`; default `maxBankSlope` ≤ tan 34° for walkable banks | fixes the ramp, the 9 m/s clamp, the dark gorge walls | 0 (bake) + foam below | 0 |
| **P5** | **Banks**: wet darkening + roughness drop in the terrain shader above the waterline (Lagarde), driven by the waterSurfaceMap tap the lakebed already takes; bank bands by distance (wet → mud → gravel) replacing the flat sand recolour | the "muddy" read; the user parked the sand look earlier | **≤ 0.1** (terrain shader, river-adjacent pixels) | 0 |
| **P6** | **Foam that means something**: re-enable foam, driven by cascades (P4), confluence shear (P2 flow texture B), shallow shore — never by a whole reach; advected by the flow | foam is off because it lies today | **≤ 0.2** | 0 |
| **P7** | **Gameplay API**: `getWaterInfoAt(x,z)` (height, depth, velocity, reach, junction), `findCrossings({ deckClearance })` (the deck-height bridge method moved into the engine), fords (depth < 0.8 m), `riverVersion` event → nav rebuild, bridge-deck remeasure | nav/bridges stop going stale | 0 | per query µs |
| **P8** | **Look presets** (taste — user decides): clear jungle stream vs brown silty lowland river (high scattering, 0.3–1 m visibility); per-reach look along the network (clear torrent upstream, brown estuary) | cheap, but needs the user's eye | 0 | 0 |
| **P9** | Optional: world-space flow texture everywhere (not just junctions), directional-flow normals for fast reaches, SSR of banks via the paddies' post-chain pass (`paddyReflections.js` reuses the scene pass's colour/depth — no copy) | nice to have; low value at RTS pitch where fresnel is ~2–10% | **≤ 0.3** each, individually A/B'd | — |

Out of scope: runtime shallow-water simulation (Unreal 5.6 / KWS2 — both
reported destructive to spline edits; a bake-over-spline option can come
later), caustics (little value in silty water), planar reflections.

### 5.1 Verification per step

- Headless: extend `tools/riverV2ChannelTest.mjs` — graph level solve
  (accordance at every junction), Q conservation, CPU operator == GPU resolve
  on a sampled grid, stamp-over-river precedence, old-file import.
- In game, nam-valley: all padded pieces flat (sample ≥1.2 m inside a pad —
  the bilinear trap), both bridges' landings meet their decks, nav walkable
  count unchanged or explained, water drawn = `getWaterLevelAt`.
- `gpuAB` close + far, river on/off/feature off, reported in ms.
- Screenshots from the angle being judged, zoomed in at junctions; taste calls
  (colour, foam amount, bank look) handed to the user.

### 5.2 Open questions for the user

1. Approve the layer-stack architecture (P1) — it touches every height writer.
2. Order: P1 → P2 as listed, or P4 (step-pools) first because it fixes the
   look of the river the game already ships?
3. nam-valley: convert the upper river to step-pools (changes the map's look
   and possibly the bridge sites), or keep the ramp there?
4. Water colour direction (P8): clear teal (today) or brown silty?

---

## 6. Where to work, and River v3 (proposed, not approved)

**Editor first, game as the gate.**
- Build and debug in the v3 editor: a small test project (one river, one
  confluence, one split, one fall, a pad next to the bank) plus nam-valley
  loaded in the editor for the real river without units, fog and foliage.
- The game stays the ACCEPTANCE test at each milestone, because some things
  exist only there: the grab-free two-pass water (the editor uses the grab
  path), the RTS camera and zoom-dependent cost, and the pads / bridge
  landings / paddies that the layer stack must protect. Look is judged in the
  game.

**River v3 beside v2, not a rewrite in place.**
- New mode and folder (`v3/tools/riverV3/`), new save key `riverNetwork`,
  importer from `riversV2`. v2 stays untouched and nam-rts keeps running on
  it until v3 passes the game gate on nam-valley.
- Fork what changes (network model, graph solve, conform/resolve, editing);
  IMPORT what doesn't: the water material and the waterfall shader are
  shared, never copied ("two shaders tuned toward each other never match").
- Never both conforming one terrain: a project uses v2 OR v3; the editor
  offers "Convert to River v3".
- The height layer stack (P1) is engine-wide, not a river feature: it lands
  as its own step with v2 adapted to it (or kept on its base path behind a
  flag) so nam-rts never breaks in between.
- Once v3 replaces v2, delete v2 and the old River+ (`riverSystemGpu.js`) so
  the engine has one river system, not three.

**Order (recommended): layer stack first, then River v3 on top of it.**
- v3's terrain shaping is written ONCE, against the stack. Starting v3 on
  today's "private copy of the ground" design would mean writing its conform
  twice and carrying the lost-pads bug into the new system.
- The stack fixes today's game too: pads, bridge landings and paddies stop
  being erasable by River v2 in nam-rts before v3 exists.
- Cost: it touches every height writer, so it is the riskiest step. Kept
  small (ground + stamps + v2 adapted as the river layer) and checked in the
  game on nam-valley before any v3 work starts.
- The alternative (v3 first) shows a new river sooner but reworks it later.

---

## 7. P1 done — the height layer stack (2026-09-26)

**What changed**
- `v3/terrain/heightLayers.js` (new): FINAL = STAMPS(RIVER(GROUND)). FINAL
  is main.js's `cpuHeightmap`. `compose(rect)`, `setRiver(op, dirty)`,
  `addStamp(key, rect, apply)` / `removeStamp`, `absorb(rect, quantize)` for
  writers that don't know about layers, `reset(heights)` on load.
- `v3/tools/riverV2Terrain.js` (new): River v2's cross-section on the CPU,
  the RIVER operator. Same path data, the same nearest-segment rule (mouth
  half-plane included), the same maths as the old GPU resolve.
  `riverDirtyRect` limits a re-conform to where the river actually changed.
- `riverV2System.js`: the private base and everything that kept it in sync
  are gone (`_cpuBase`, base texture, resolve pass, `editBase`,
  `coversRect`, `markExternalEdit`, `_foldExternal`, the debounced rebase,
  coverage mask, `exportBaseHeightmap`, `resetForLoad`). The GPU nearest
  field stays because bank sand, flowers and "grows near water" read it.
- `main.js`: flattenRect / gradeRamp / raiseBerm / remapHeights are stamps.
  Readbacks and legacy writers are absorbed into GROUND. Layer changes
  upload only their rect (`sculpt.uploadHeightRect`, new, no undo snapshot);
  legacy full-map writers keep their full upload and sculpt undo step. Save
  writes GROUND, the same data as the old saved base, so files are unchanged.
- `tools/heightLayersTest.mjs` (new, 25 checks), in the `npm test` lane.

**Measured**
- CPU river op vs the old GPU resolve on nam-valley (editor, before the
  switch): 1,048,568 texels within 1 mm, 8 within 7.8 mm, 0 worse; the GPU
  changed nothing outside the op's rect.
- After the switch: GPU heightmap == composed stack, 0 m difference (editor
  load, after a drag, and in the game).
- nam-rts, new vs old code (HEAD worktree on :5174), same boot:
  | check | old | new |
  |---|---|---|
  | pads flat (54, sampled 1.2 m inside) | 54 | 54 |
  | pads flat after 3 forced river re-conforms | 54 | 54 |
  | bridge landings, ground − deck at 0.5 m | −0.10…0.41 | identical |
  | nav cells open | 56,787 | 56,786 |
  | console errors | 0 (2 old warnings) | 0 (same 2 warnings) |
  | **+1.5 m bank edit (remapHeights) in the river footprint** | **erased within 1.5 s, no one touched the river** | **kept after settle and after a forced re-conform** |
- `npm test`: 195/195 suites green.
- Editor: save writes exactly the loaded ground (0 m); a sculpt far from the
  river lands in GROUND and on the GPU (+3 m each); a sculpt on the channel
  lands in GROUND while the bed stays the river's.

**Known, not fixed**
- **Drag cost ~29 ms CPU per step** on nam-valley's 857 m river (old GPU path
  ~1.3 ms CPU + GPU). Moving a node shifts EVERY station, because stations are
  spaced along the whole river, so the dirty rect is the whole river. Fix
  (River v3): anchor stations per node span, so a drag only changes the
  spans next to the node. Commit (mouse-up) is ~7 ms because nothing changed
  since the last drag step.
- A NON-additive brush (flatten, smooth) inside the river footprint is taken
  into GROUND as a difference. The river bed is unaffected, but the hidden
  ground under the river moves by that difference (measured +8.26 m for a
  "flatten to ground+3" on the bed). It only shows if the river is later moved
  away. Before the stack, such a stroke was simply discarded.
- `reassertPads` in nam-rts is now redundant but harmless (a same-key stamp
  replaces itself). Left in place.
- Road conform still keeps its own base copy (`roadConformSystem.js`). Its
  writes are absorbed into GROUND. A road crossing a river could bake the
  river's carve into GROUND under the road if the river later moves. Making
  it a layer is future work.
- The editor's debug-hook load (`__V3_DEBUG.loadProjectFromBuffer`) does not
  do the terrain-size reload the UI does; nam-valley needs
  `localStorage["v3.terrainConfig"] = {worldSize:1024, maxHeight:250, …}`
  first, or heights read ×2 (a test-setup trap, not a bug in the stack).
