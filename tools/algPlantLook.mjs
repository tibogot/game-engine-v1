/**
 * THE PLANT LOOK (alg-aures.v3proj foliagePlants) — you, 2026-10-02: "the
 * purple flowers we have look way too cheap, same for the cactus with the red
 * fruit… this white flower looks very bad". The plants were rebuilt in the
 * engine (foliageGeometry buildOpuntia / buildThistle / buildAsphodel /
 * buildOleander / buildTamarisk) and their colours moved in FOLIAGE_PRESETS;
 * a map keeps its OWN copy of every painted type, so this copies the presets
 * into the map's types of the same preset: the whole plant recipe (kind,
 * shape counts and colours), the map's own placement rules (name, heights,
 * layer, river, shadow) kept.
 *
 *   node tools/algPlantLook.mjs
 */
import { readProject, writeProject } from "./lib/v3proj.mjs";
import { FOLIAGE_PRESETS } from "../v3/app/state/foliageScatterState.js";

const FILE = "public/levels/alg-aures.v3proj";
const PRESETS = ["pricklyPear", "thistle", "asphodel", "alfa", "oleander", "tamarisk", "typha"];
const KEEP = new Set(["name", "preset", "castShadow", "heightMin", "heightMax", "onLayer", "nearRiver"]);

const p = await readProject(FILE);
for (const t of p.manifest.foliagePlants ?? []) {
  if (!PRESETS.includes(t.preset)) continue;
  const src = FOLIAGE_PRESETS[t.preset];
  const changed = [];
  for (const [k, v] of Object.entries(src)) {
    if (KEEP.has(k) || JSON.stringify(t[k]) === JSON.stringify(v)) continue;
    changed.push(`${k} ${JSON.stringify(t[k])}→${JSON.stringify(v)}`);
    t[k] = structuredClone(v);
  }
  console.log(`${t.name}: ${changed.join(", ") || "(same)"}`);
}
await writeProject(FILE, p);
