/**
 * THE CANOPY TREE — put the dipterocarp into nam-valley's fourth tall-plant
 * slot (the alpha channel of the tall-plant paint, reserved for jungle trees).
 *
 * The map saved three tall plants (fan palm, bamboo, palm); the fourth slot
 * fell back to the engine's default. The game paints where the canopy grows
 * (games/nam-rts/jungleCanopy.js, at boot) — this only says WHAT grows there,
 * so the editor shows the species too.
 *
 * Run:  node tools/namJungle.mjs [--dry]
 */
import { readProject, writeProject } from "./lib/v3proj.mjs";
import { FOLIAGE_PRESETS } from "../v3/app/state/foliageScatterState.js";

const FILE = "public/levels/nam-valley.v3proj";
const dry = process.argv.includes("--dry");

const p = await readProject(FILE);
const m = p.manifest;
const plants = m.susuki?.plants;
if (!Array.isArray(plants)) throw new Error("namJungle: no susuki.plants array in the map");

const tree = {
  name: "Canopy tree",
  preset: "dipterocarp",
  castShadow: true,
  ...structuredClone(FOLIAGE_PRESETS.dipterocarp),
  heightMin: -200, heightMax: 900, onLayer: -1, nearRiver: 0,
};
const before = plants[3] ? `${plants[3].name} (${plants[3].kind})` : "(default)";
plants[3] = tree;
console.log(`tall 3: ${before} -> ${tree.name} (${tree.kind}, ${tree.size} m)`);
if (!dry) {
  await writeProject(FILE, p);
  console.log(`wrote ${FILE}`);
}
