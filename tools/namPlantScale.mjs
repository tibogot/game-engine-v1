/**
 * PLANT PROPORTIONS — write the corrected sizes into nam-valley.
 *
 * WHY THIS SCRIPT HAS TO EXIST. The presets in foliageScatterState.js are only
 * DEFAULTS for a new plant. A saved project carries its own copy of every
 * plant's numbers, so the palm, the banana and everything else on nam-valley
 * kept the values they were authored with — and every proportion fixed in the
 * engine on 2026-09-23 was invisible in the actual game. The map is the thing
 * the player sees; until a number is written here it has not shipped.
 *
 * WHAT IS BEING CORRECTED, and the sum behind each (soldier = 2.34 m):
 *
 *   PALM 11 m -> 17. It stood 4.7 soldiers high where a real coconut palm
 *   reads as about 14, and it was a sapling beside a 26 m tree. Raised WITH
 *   its proportions rather than by scaling: a coconut trunk stays ~35 cm
 *   however tall it grows (stemWidth 1 -> 0.7) and its fronds stay 5-6 m
 *   (plumeSpread 50% -> 32%), so scaling the whole plant would have given it
 *   a metre-thick trunk and nine-metre fronds. Leaf-scar rings up 30 -> 36 to
 *   keep their spacing.
 *
 *   BANANA 3.5 m -> 5, leaf length 70% -> 92% of the stem. Measured off
 *   plantation photographs: the bearing stem is 3-4 m and the leaves reach
 *   2-3 m BEYOND it. At 3.5 m with short leaves it was chest height — a
 *   houseplant. `spread` also drives the sucker count now, so a banana on the
 *   map becomes a mat rather than a single stem.
 *
 * Colours are NOT touched: those were set by namVegPalette.mjs against this
 * map's light and are the map's own, not the preset's.
 *
 * Run:  node tools/namPlantScale.mjs [--dry]
 */
import { readProject, writeProject } from "./lib/v3proj.mjs";

const FILE = "public/levels/nam-valley.v3proj";

/** Tall plants, by slot name: only the keys that changed. */
const TALL = {
  Palm: { size: 17, stemWidth: 0.7, plumeSpread: 32, leaflets: 36 },
};

/** Ground foliage, by slot name. */
const GROUND = {
  Banana: { size: 5, plumeSpread: 92, fronds: 11 },
};

const dry = process.argv.includes("--dry");

const proj = await readProject(FILE);
const m = proj.manifest;
const changes = [];

const apply = (plant, patch, where) => {
  for (const [k, v] of Object.entries(patch)) {
    const had = plant[k];
    if (had === v) continue;
    plant[k] = v;
    changes.push(`${where} ${plant.name}: ${k} ${had} -> ${v}`);
  }
};

for (const plant of m.susuki?.plants ?? []) {
  if (TALL[plant.name]) apply(plant, TALL[plant.name], "tall");
}
// foliagePlants is keyed "0".."7", not an array.
for (const key of Object.keys(m.foliagePlants ?? {})) {
  const plant = m.foliagePlants[key];
  if (GROUND[plant?.name]) apply(plant, GROUND[plant.name], "ground");
}

if (!changes.length) {
  console.log("nothing to change — the map already has these numbers.");
} else {
  console.log(changes.map((c) => "  " + c).join("\n"));
  if (dry) console.log("\n--dry: not written.");
  else {
    await writeProject(FILE, proj);
    console.log(`\nwritten to ${FILE}`);
  }
}
