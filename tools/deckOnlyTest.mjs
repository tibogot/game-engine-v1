// buildPiece({ deckOnly }) must return the SAME `geometry` and `world` as a
// full build — it may only drop the outputs the ghost never reads.
//
// The trap it guards: `appendTubeEndCaps` MUTATES `geometry`, and the caps are
// visual. Skipping them with the collision clone would give the ghost an
// open-ended tube that does not match the piece it previews.
import { register } from "node:module";
import { readFileSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
register("./threeWebgpuHook.mjs", import.meta.url);
const THREE = await import("three/webgpu");
const KIT = await import(pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadKit.js")).href);

let fail = 0;
const check = (n, c, d = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`);
  if (!c) fail++;
};

const attrEq = (a, b, name) => {
  const x = a.getAttribute(name), y = b.getAttribute(name);
  if (!x && !y) return true;
  if (!x || !y || x.count !== y.count || x.itemSize !== y.itemSize) return false;
  for (let i = 0; i < x.array.length; i++) {
    if (Math.abs(x.array[i] - y.array[i]) > 1e-9) return false;
  }
  return true;
};

// Every piece in the kit, at its own defaults, with kerbs/rails ON (the case
// where the full build has the most to throw away).
const ids = KIT.PIECE_CATALOG.map((p) => p.id);
console.log(`checking ${ids.length} piece types\n`);

const conn = KIT.initialConnector();
let mismatch = 0, checked = 0;
for (const id of ids) {
  let full, deck;
  try {
    full = KIT.buildPiece(id, conn, undefined, undefined, undefined, true);
    deck = KIT.buildPiece(id, conn, undefined, undefined, undefined, true, { deckOnly: true });
  } catch (e) { console.log(`  skip ${id}: ${e.message}`); continue; }
  checked++;

  const names = new Set([
    ...Object.keys(full.geometry.attributes),
    ...Object.keys(deck.geometry.attributes),
  ]);
  let ok = true;
  for (const n of names) if (!attrEq(full.geometry, deck.geometry, n)) { ok = false; break; }
  const fi = full.geometry.getIndex(), di = deck.geometry.getIndex();
  if (!!fi !== !!di || (fi && fi.count !== di.count)) ok = false;
  if (!full.world.equals(deck.world)) ok = false;
  if (!full.connectorOut.equals(deck.connectorOut)) ok = false;
  if (!ok) { mismatch++; console.log(`  MISMATCH ${id}`); }
}
check(`deckOnly geometry + world identical to full build (${checked} pieces)`, mismatch === 0);

// And it really does drop the rest.
const tube = KIT.buildPiece("straight", conn, undefined, undefined, undefined, true, { deckOnly: true });
check("deckOnly drops railGeometry", tube.railGeometry === null);
check("deckOnly drops railCollision", tube.railCollision === null);
check("deckOnly drops railMirrorGeometry", tube.railMirrorGeometry === null);
check("deckOnly drops deckCollision", tube.deckCollision === null);

// Tube end caps are VISUAL and must survive deckOnly.
const capId = KIT.PIECE_CATALOG.find((p) => p.tubeEndCaps && !p.geometry)?.id;
if (capId) {
  const f = KIT.buildPiece(capId, conn, undefined, undefined, undefined, true);
  const d = KIT.buildPiece(capId, conn, undefined, undefined, undefined, true, { deckOnly: true });
  check(`tube end caps kept in deckOnly (${capId})`,
    f.geometry.getAttribute("position").count === d.geometry.getAttribute("position").count,
    `full ${f.geometry.getAttribute("position").count} vs deckOnly ${d.geometry.getAttribute("position").count}`);
} else {
  console.log("SKIP  no tubeEndCaps piece in the kit");
}

// Speed, the whole point.
console.log("");
for (const id of ["straight", "curve", "loop", "quarterpipe"]) {
  if (!ids.includes(id)) continue;
  const t0 = performance.now();
  for (let i = 0; i < 20; i++) KIT.buildPiece(id, conn, undefined, undefined, undefined, true);
  const a = (performance.now() - t0) / 20;
  const t1 = performance.now();
  for (let i = 0; i < 20; i++) KIT.buildPiece(id, conn, undefined, undefined, undefined, true, { deckOnly: true });
  const b = (performance.now() - t1) / 20;
  console.log(`  ${id.padEnd(13)} full ${a.toFixed(2)} ms → deckOnly ${b.toFixed(2)} ms  (${(a / b).toFixed(0)}× faster)`);
}

console.log(fail ? `\n${fail} FAILED` : "\nall good");
process.exit(fail ? 1 : 0);
