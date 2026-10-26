# Culling, LOD & impostors — the engine spec

Status: AGREED (2026-10-26) — decisions in §6. Nothing here is built yet
except what is marked PROVEN. Inventory of what exists today:
`v3/OPTIMIZATION_INVENTORY.md`.

## Why this exists

Every game puts many copies of things on a map: trees, rocks, props, plants,
buildings. Today ~12 systems each do their own culling and LOD, with the same
constants copied (`CULL_MARGIN` 12, `LOD_HYST` 0.1), five names for the same
LOD distances, and two shadow bugs found by accident. This spec makes it
**one way to ask, a few backends, one set of rules**, so a new game gets
correct culling, LOD, shadows and smooth edges for free.

**Global (this spec):** the rules, the one API, the backends, the tests.
**Per game (not this spec):** unit renderers, effect pools, city/road
special cases. They may call the rule helpers (R1–R3) but keep their code.

## 1. One way to ask

```js
const field = app.instances.create({
  name: "pines",
  asset: {
    lods: [lod0, lod1, lod2],      // { geometry, material } each, near → far
    impostor: null,                 // or an octahedral bake (R5)
    radius: 6,                      // bounding sphere, metres (canopy, not trunk)
    height: 14,                     // for the shadow sweep (R2)
  },
  backend: "auto",                  // "unique" | "instanced" | "gpu" — see §2
  lod: { distances: [60, 180], hysteresis: 0.1, fade: 8,
         impostorFrom: 400, cullFrom: 900, floors: null },
  shadows: { cast: true, receive: true, maxDistance: 150, castFromLod: 1 },
});
const id = field.add(matrix);       // place
field.set(id, matrix);              // move
field.remove(id);                   // delete
field.setVisible(false);
```

Every backend implements exactly this. The editor's placement tools and every
game call it; nobody writes a cull loop again.

## 2. The backends (picked by count, or forced)

| Backend | For | How it culls | Today's code that becomes it |
|---|---|---|---|
| **unique** | a few big things: buildings, hero props, bridges | per object, CPU, `THREE.LOD`-like tiers | alg `algHouse` / `algSangar` THREE.LOD, gothicChurch `lodDistance` |
| **instanced** | hundreds–~10k static copies: rocks, props, trunks | per cell (chunk) then per instance, CPU; matrices repacked when the camera moves | `v3/tools/propInstancer.js`, `treeLodRenderer`, `foliageLodRenderer`, `placedFoliage` |
| **gpu** | 10k–1M: plants, grass, leaves, debris | compute pass per instance → indirect draw | `scatterField`, `leafFieldRenderer`, grass, `gpuInstanceField` (lab) |

`backend: "auto"` picks unique under ~50 copies, instanced under ~10k, gpu
above — thresholds to measure, not guess. Skinned/animated things (units,
horses) are not a backend here: they stay per game, but must follow R1–R3
(bounds = the animation's extent, not the bind pose).

## 3. The rules (the contract every backend keeps)

**R1 — One frustum test.** PROVEN. GPU: `render/scatter/gpuCull.js`
`frustumVisibleAtClip` / `scatterFrustumVisible` (radius padded on every
side, things closer than their radius always kept). CPU: the same test as
planes (today inside `scatterField._cpuCull`) — to be lifted into
`render/culling/cpuCull.js` so the instanced/unique backends use the exact
same margins. Grass and leaves moved onto the GPU one: fe8e1703.

**R2 — Shadow casters are culled by where their SHADOW lands, per light.**
PROVEN for GPU: `render/culling/shadowCasters.js` `shadowSweepVisible`
(6cfc89b8 — trees behind the camera kept their shadow; free at a normal sun,
~0.4–0.7 ms in long evening shadows). CPU: not needed with 100 m chunks
(measured, even at a 10° sun); the instanced backend's cells must stay ≥ ~50
m or add the box sweep. Shadow LOD: casters may use a cheaper tier
(`castFromLod`); casters beyond `shadows.maxDistance` never draw into the
shadow map.

**R3 — One LOD settings shape and one distance.** `{ distances, hysteresis,
fade, impostorFrom, cullFrom, floors }`, metres. Tiers change with
hysteresis (demote past d·(1+h), promote under d·(1−h)) so nothing flickers on
a boundary. Old names (`lodDistances`, `lodDistance/lodDistance2`,
`lod0Dist/lod1Dist`, `lodFloors`) are read as aliases so old levels load.
DISTANCE: true 3D camera distance × the global bias (§6 D1).

**R4 — No pops.** Between tiers: a screen-space dither cross-fade over
`fade` metres (the haystack's IGN dither is the pattern: the near draws
exactly the pixels the far gives up). Leaf clouds may thin continuously
instead (leafField's `keepP`). A hard switch only where the tiers are
pixel-identical.

**R5 — The impostor is the last tier, not a separate system.** Octahedral,
one core: `render/foliage/octahedralCore.js` (the arborist's old copy goes).
Baked at load or offline per asset. Cast no shadow (far beyond the shadow
range anyway). Only assets seen far need one: big worlds, flight. RTS
cameras rarely do.

**R6 — Cut-out cards use one helper.** PROVEN: `render/materials/
alphaCutout.js` `applyAlphaCutout` — centred alpha-to-coverage with MSAA
(smooth edges, full crowns), the plain alpha test without, the shadow cut
always (2cd67b6c, b8b9fa43, 506052a5).

**R7 — Too small to see → not drawn (or drawn bigger on purpose).**
`screenRadiusPixels` / `worldSizeForPixels` (gpuCull.js): below ~1–2 px a
copy crawls instead of fading; the field says "drop" or "keep a minimum size"
(birds, ambient FX).

**R8 — Occlusion (Hi-Z) is optional and GPU-only.** Measured −0.18 ms net at
ground level, nothing at RTS height (AUDIT.md). Wired only when a big-world
game needs it; auto-off by camera height. Camera lists only, never shadows.

**R9 — Editing is cheap.** add / set / remove touch one cell (instanced) or
queue a debounced repack (gpu, 250 ms like leafField). No full rebuild per
brush stamp.

**R10 — Quality hooks for the settings menu.** One global LOD bias
(multiplies every `distances`), shadow distance, density (thinning, like
scatterField's `uThin`), MSAA / alpha-to-coverage (`?msaa=0`, `?a2c=0`
today). The Steam shell's Low / Medium / High presets only set these.

## 4. How it is checked

**Automated (Node, no browser — `npm test`):** R1 CPU planes vs the GPU
formula on random spheres (same answer); R3 tier choice + hysteresis +
aliases; R2 CPU box sweep; the API (add / set / remove / counts). Pure maths,
fast, and what keeps a global module solid when one game changes it.

**Pixel A/B (the method used for R1, R2, R6):** per view, normal culling vs
culling switched off (pads 10), wind and clock frozen, pixel diff with a
noise baseline and a control that must change the image. Becomes a reusable
tool (`tools/cullPixelAB.mjs` + the page hooks) instead of scratch scripts.

**The lab — `v3/gpu-cull-lab.html`, extended**, fixed scenes on keys:
single buildings with LOD + impostor · 5k instanced rocks · a 100k plant
field · 50 walking units · off-screen shadow casters (low sun) · 180° turn
and a teleport (pops, late arrivals) · ground camera vs RTS height · live
add/remove. On screen: draws, copies per tier, CPU ms, GPU ms.

**Real content last:** every step ends in a real game view (alg auresNew,
an editor map), measured with whole-frame timing (gpuBench.timeFrames; the
GPU timestamp misreads multi-pass frames) on a quiet machine.

## 5. Order of work (small steps, every game keeps working)

1. `cpuCull.js` (R1 CPU twin + R3 tier/hysteresis helper) + its Node tests.
   No behaviour change: scatterField's `_cpuCull` and the CPU renderers call
   it, pixel A/B identical. — DONE 2026-10-26: `render/culling/cpuCull.js`
   (`CULL_MARGIN`, `LOD_HYSTERESIS`, `TIER_UNSET`, `lodTier`,
   `paddedClipPlanes`, `sphereVisibleCpu`); `tools/cpuCullTest.mjs` pins
   lodTier to verbatim copies of the old prop + trunk tier code (200k cases
   each, a 0.02 hysteresis error fails it) and sphereVisibleCpu to the GPU
   formula (200k spheres). Adopted: propInstancer (`_pickTier`),
   treeLodRenderer, scatterField's planes. Pixel check, same frozen views
   before / after: editor fog-lab + rock-lab (427 props) and alg auresNew
   identical to the noise floor (one rock-lab run caught the grass's own
   state; re-run: 0 px). Left for later: foliageLodRenderer (its boundaries
   use different distances per edge — needs `lodTier` with a distance per
   boundary) and placedFoliage.
2. The LOD settings shape + aliases (R3). Editor and level files read it.
3. One octahedral core (R5): the arborist on `render/foliage/octahedralCore.js`.
4. The API (§1) as a thin facade over today's systems — instanced →
   propInstancer, gpu → scatterField — so games can start using it before
   the internals merge.
5. Lab scenes (§4), then move one real system at a time behind the facade,
   pixel A/B + timing each: placedFoliage, then the tree renderers, then
   propInstancer onto gpuInstanceField when a game needs >10k props.
6. R8 Hi-Z and impostors for non-trees: only when a big-world game is next.

## 6. Decisions (the user, 2026-10-26: "your recommendation seems the most clever")

- **D1 — LOD distance is true 3D camera distance**, times one global LOD
  bias (R10). Not XZ: a high RTS camera made things under it "near" (they
  are 70 m away) — the reason `lodFloors` exists. Floors stay readable as an
  alias but should become unnecessary. Changes where LOD boundaries fall on
  existing maps: checked per game (alg auresNew, editor maps) when moved.
- **D2 — The backend is picked automatically by count** (unique < ~50,
  instanced < ~10k, gpu above; thresholds measured, not guessed), with a
  manual override per field / asset.
- **D3 — Card facing is a per-tree-preset setting** (`faceCamera` 0…1),
  its default by camera type: RTS / orbit cameras → fixed (0), close
  third-person → camera-facing (1).
- **D4 — Impostors for buildings and rocks wait** for the next big-world
  game. Trees keep theirs.
- **D5 — The API lives on the app: `app.instances`** (like `app.decals`),
  exported through `v3/engine.js`.
