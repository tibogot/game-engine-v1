# Biomes: plan (2026-10-17) — PARKED, a note for later

> Parked by the user (2026-10-17): every game made with this editor will have its own plants and
> look, so presets would not carry over. If it comes back, start with the generic core only:
> "generate vegetation from rules" for the existing density systems (no presets, no biome map).

EDITOR_PLAN item 8. Goal: paint "jungle" or "desert" and the ground paint, grass, plants, trees and
rocks all appear by rule; saved in the level, applied in games with no game code. The biggest
"make games fast" win left in the editor.

## What exists (inventory, 2026-10-17)

- **Density map + rules, on the GPU (a biome can drive these directly):** grass (512², `.r`
  coverage + blade height), flowers (1024² × 4 types), foliage (1024² × 8), tall plants (512² × 4,
  also used for GPU trees: cedar, oak, palms in alg/nam), ambient FX. The GPU already applies
  Blocks-grass layers, holes, "nothing under water", a slope cutoff per field, and a per-type rule
  `(heightMin, heightMax, onLayer, nearRiver)` (scatterNoise.js `scatterRuleKeep`).
- **Ground paint rules:** auto-paint flat / cliff / high / gully (live shader + Bake).
- **Per-instance lists (need a generator):** trees (TreeStore, brush + mass-place with slope /
  Blocks-trees / water rejects), props and rock sets (propStore; no terrain rules), placed GLB plants.
- **Offline generators already doing biome work for games:** tools/algVegetation.mjs (per-species
  rules → tall-plant + foliage density), namGrassPaint, namFanPalms, rockLabLevel.
- **Gaps:** no biome/region map; scatter has no per-type slope / cavity / wetness rule; grass has no
  height or layer rule; every bake overwrites hand edits; prop/rock/placed-plant brushes ignore
  water, holes and Blocks-trees.

## Design

- **A biome = a recipe**, stored in the level: ground rules (the auto-paint layers), grass
  (coverage, height), up to N plant entries (which foliage / flower / tall-plant channel, density,
  slope / height / cavity / wetness windows, clumping), trees and rocks (type, density, spacing,
  same windows). Presets ship as JSON (jungle, savanna, desert, alpine, temperate) and a level can
  edit its own copy.
- **A biome map**: which biome where, painted with a brush (default: one biome everywhere). 512²,
  up to 4 biomes blended (RGBA weights). CPU only: it drives GENERATION, never the terrain shader,
  so it costs nothing per frame and no sampler.
- **Generation** (a worker, seeded, deterministic): for every texel, weight of each biome × its
  rules (slope, height, cavity, flow — the data step 3 built) → the density channels it owns;
  trees and rocks are planned with blue-noise spacing (Poisson) into instances TAGGED with the
  biome, so a re-run replaces only its own and never a hand-placed one.
- **Hand edits survive**: generated density and the user's brush strokes are kept apart
  (generated × (1 − erased) + added), so re-generating after a sculpt keeps what was painted by hand.
  v1 can start with a Generate button (undoable, like the auto-paint Bake) and move to live re-runs.
- **Cost**: zero per frame beyond the plants themselves (the same density systems, same budgets).

## Order

1. Biome recipe + presets + the biome map (brush, one-biome fill) + Generate for the density
   systems (grass, foliage, flowers, tall plants) and the ground rules. Undoable, saved, in games.
2. Trees and rocks as tagged instances (Poisson), with the missing water / hole / Blocks-trees
   rejects added to the prop and rock brushes too.
3. Hand edits kept apart (override layers) → live re-generation after sculpting.
4. Per-type slope / cavity / wetness windows in the GPU rule (a second rule row), so plants react
   live without a re-generate.
