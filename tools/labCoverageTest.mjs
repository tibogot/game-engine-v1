/**
 * THE LAB SHOWS EVERYTHING THE GAME PLACES — in npm test (2026-10-25, you: "be careful with some assets not being in
 * the lab … I'm very confused, we need better organization now"). The lab (games/alg-rts/lab.html) grew entry by entry
 * as pieces were redone, so what was never redone — the burnt farm, the ruined huts, the terraces, the lookouts… — was
 * in the game and nowhere in the lab.
 *
 * Reads what the game places, from the code that places it:
 *   · the maps' placement keys     showroom.js, algLandmarks.js, algGame.js   (`key: "…"`, digits and the villages'
 *                                  suffixes dropped: gardenOA1 → garden, terracesD2 → terraces)
 *   · the buildables               algBuild.js BUILDS
 *   · the Blender kits' types      algHouse.js *_TYPES                        ("kit:<type>")
 * and checks each against labCatalog.js PLACED: a lab entry (that exists — META, and a builder in buildingLab.js) or
 * { none: why }. A piece placed without one FAILS: give it its lab entry first.
 *
 *   node tools/labCoverageTest.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const G = path.join(ROOT, "games", "alg-rts");
const src = (f) => fs.readFileSync(path.join(G, f), "utf8");
const { PLACED, SYSTEMS, META } = await import(`file://${path.join(G, "labCatalog.js").replace(/\\/g, "/")}`);

// what the game places
const placed = new Map();   // key → where
const add = (k, where) => { if (!placed.has(k)) placed.set(k, where); };
for (const f of ["showroom.js", "algLandmarks.js", "algGame.js"]) {
  for (const m of src(f).matchAll(/key: [`"]([A-Za-z]+)/g)) add(m[1].replace(/\d+$/, ""), f);
}
for (const m of src("algBuild.js").matchAll(/^ {2}(\w+): \{ label:/gm)) add(m[1], "algBuild.js");
for (const m of src("algHouse.js").matchAll(/^export const \w+_TYPES = \[([^\]]*)\]/gm)) {
  for (const t of m[1].matchAll(/"([^"]+)"/g)) add(`kit:${t[1]}`, "algHouse.js");
}
// the lab's entries: catalogued (META), and built (a key or a key family in buildingLab.js)
const lab = src("buildingLab.js");
const built = (k) => new RegExp(`^ {2}${k}: \\{`, "m").test(lab) || [["plant_", "`plant_${"], ["mzab_", "`mzab_${"], ["blanche_", "`blanche_${"], ["pointBlender_", "`pointBlender_${"]]
  .some(([p, t]) => k.startsWith(p) && lab.includes(t)) || /^(colonne|colonnade|voie|arc|pressoir|rocheBanc|rocheBloc|rocheDalle)$/.test(k) && lab.includes(`${k}:`);

let failed = 0;
const fail = (msg) => { failed++; console.log(`FAIL  ${msg}`); };
const resolve = (k) => PLACED[k] ?? PLACED[k.replace(/[A-Z]+$/, "")];   // (gardenOA → garden, threshEO → thresh)
for (const [k, where] of placed) {
  const to = resolve(k);
  if (to == null) fail(`${k} (${where}): placed by the game, not in labCatalog PLACED — give it its lab entry`);
  else if (typeof to === "string" && !META[to]) fail(`${k} → "${to}": no such entry in labCatalog META`);
}
for (const [what, to] of [...Object.entries(PLACED), ...Object.entries(SYSTEMS)]) {
  if (typeof to !== "string") { if (!to?.none) fail(`${what}: neither a lab entry nor { none: why }`); continue; }
  if (!META[to]) fail(`${what} → "${to}": not in META`);
  else if (!built(to)) fail(`${what} → "${to}": catalogued but no builder in buildingLab.js`);
}
for (const k of Object.keys(META)) if (!built(k)) fail(`META "${k}": no builder in buildingLab.js (a stale row?)`);

const shown = [...placed.keys()].filter((k) => typeof resolve(k) === "string").length;
console.log(failed ? `\n${failed} FAILED` : `\nALL PASS — ${placed.size} placed kinds (${shown} in the lab, ${placed.size - shown} with a reason), ${Object.keys(SYSTEMS).length} systems, ${Object.keys(META).length} lab entries`);
process.exit(failed ? 1 : 0);
