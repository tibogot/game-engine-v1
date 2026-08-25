// WHICH aZONE VALUES DOES THE SHARED ROAD MATERIAL ACTUALLY SEE?
//
// createRoadMaterial branches on aZone 0..5 (side / deck / kerb / tube inner /
// tube outer / lacquered panel) and every road fragment evaluates all of it.
// But rideable tubes were moved to their own cheap shader (createTubeMaterial),
// so the question is whether zones 3 and 4 — and the neon ring mask that goes
// with them — are still reachable on the road material at all, or are dead
// weight paid for on every pixel of every straight.
//
// Answered by building every piece in the kit and reading its aZone attribute,
// then splitting by which material the BUILDER would hand it
// (modularRoadBuilder._deckMaterial: `def.tubeShader` -> tubeMaterial).
//
// Run: node tools/roadZoneUsageAudit.mjs
import { register } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GAME = join(ROOT, "games/modular-road-v3");
register("./threeWebgpuHook.mjs", import.meta.url);
await import("three/webgpu");
const mod = (f) => import(pathToFileURL(join(GAME, f)).href);

const {
  PIECE_BY_ID, buildPiece, initialConnector, pieceParams, roadParams, guardrailParams,
} = await mod("modularRoadKit.js");

const ZONE_NAME = {
  0: "side/underside", 1: "deck", 2: "kerb",
  3: "tube inner", 4: "tube outer", 5: "lacquered panel",
};

const gp = { ...guardrailParams, enabled: false };
/** zone -> Set(pieceId) for pieces drawn with the SHARED ROAD material. */
const roadZones = new Map();
/** ...and for pieces the builder hands to the dedicated tube shader. */
const tubeZones = new Map();
const failed = [];

for (const [id, def] of PIECE_BY_ID) {
  if (def.noMesh) continue;
  let geo;
  try {
    geo = buildPiece(id, initialConnector(), pieceParams, roadParams, gp, true).geometry;
  } catch (e) {
    failed.push(`${id}: ${String(e).slice(0, 70)}`);
    continue;
  }
  const zn = geo?.getAttribute("aZone");
  if (!zn) { failed.push(`${id}: no aZone`); continue; }
  const target = def.tubeShader ? tubeZones : roadZones;
  for (let i = 0; i < zn.count; i++) {
    const z = Math.round(zn.getX(i));
    if (!target.has(z)) target.set(z, new Set());
    target.get(z).add(id);
  }
}

const report = (title, map) => {
  console.log(`\n=== ${title} ===`);
  for (const z of [...map.keys()].sort((a, b) => a - b)) {
    const ids = [...map.get(z)].sort();
    const shown = ids.slice(0, 6).join(", ") + (ids.length > 6 ? `, +${ids.length - 6} more` : "");
    console.log(`  zone ${z} (${ZONE_NAME[z] ?? "?"})  ${String(ids.length).padStart(3)} pieces   ${shown}`);
  }
};

report("SHARED ROAD MATERIAL (createRoadMaterial)", roadZones);
report("DEDICATED TUBE SHADER (createTubeMaterial)", tubeZones);

console.log("\n=== VERDICT ===");
let dead = 0;
for (const z of [3, 4]) {
  const live = roadZones.has(z);
  console.log(
    `  zone ${z} (${ZONE_NAME[z]}) on the road material: ${live ? "LIVE" : "DEAD"}`
    + (live ? ` — ${[...roadZones.get(z)].join(", ")}` : " — no piece reaches it"),
  );
  if (!live) dead++;
}
const panel = roadZones.has(5);
console.log(`  zone 5 (${ZONE_NAME[5]}) on the road material: ${panel ? "LIVE" : "DEAD"}`
  + (panel ? ` — ${[...roadZones.get(5)].join(", ")}` : ""));

if (dead === 2) {
  console.log(
    "\n  => The tube colour branches AND the neon ring mask are unreachable on the\n"
    + "     shared road material. Every road fragment evaluates tubeRingMask TWICE\n"
    + "     (colorNode + neonNode) plus two zone mixes, for geometry that is always\n"
    + "     drawn by createTubeMaterial instead.",
  );
}
if (failed.length) {
  console.log(`\n  (${failed.length} pieces could not be built here: ${failed.slice(0, 4).join(" | ")})`);
}
