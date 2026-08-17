// A PALETTE TILE IS A BLOCK — it means one fixed thing, every time.
//
// It used to mean "an edit to global state". Clicking a tile did
// `Object.assign(pieceParams, tile.params)` on the one shared parameter object
// and left it there, and every piece placed afterwards read that object. So a
// tile's effect depended on what you had clicked before it, and — worse —
// fourteen tiles that are not straights at all write `straightLength`, so
// picking Banked → "Straight Right" silently turned your next Straight from
// 22 m into 32 m.
//
// On a point-to-point stunt track that number is a RUN-UP LENGTH: how fast the
// car reaches a takeoff, i.e. the whole jump. Changing under you, with nothing
// on screen to say so.
//
// Now every tile resolves to {...PIECE_DEFAULTS, ...tile.params} into the
// builder's own `activeParams`, and the shared object is never written.
import * as THREE from "three";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { ModularRoadBuilder, CATEGORY_PRESETS } = await import(
  pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadBuilder.js")).href);
const { pieceParams } = await import(
  pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadKit.js")).href);

let fail = 0;
const check = (n, c, d = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${!c && d ? "\n        " + d : ""}`);
  if (!c) fail++;
};
function fresh() {
  return new ModularRoadBuilder({
    scene: new THREE.Scene(),
    material: new THREE.MeshBasicMaterial(),
    railMaterial: new THREE.MeshBasicMaterial(),
    shellMaterial: new THREE.MeshBasicMaterial(),
    decorMaterial: new THREE.MeshBasicMaterial(),
  });
}
const allTiles = Object.entries(CATEGORY_PRESETS)
  .flatMap(([cat, list]) => list.map((t) => ({ cat, ...t, preset: t.preset ?? t })));
const tile = (id) => allTiles.find((t) => t.id === id);
const span = (b) => b.activePieceMetrics.span;

console.log("\n=== 1. THE SAME TILE ALWAYS GIVES THE SAME PIECE ===");
{
  const b = fresh();
  const longTile = tile("straight_long");
  check("setup: the Long tile exists", !!longTile);

  b.setActivePreset(longTile.preset);
  const first = span(b);

  // Click every other tile in the kit, then come back to Long.
  for (const t of allTiles) b.setActivePreset(t.preset);
  b.setActivePreset(longTile.preset);
  check("Long is the same size after clicking all 130+ other tiles",
    Math.abs(span(b) - first) < 1e-9,
    `${first.toFixed(2)} m -> ${span(b).toFixed(2)} m`);
}
{
  // THE ORIGINAL BUG, exactly: a BANKED tile resizing a STRAIGHT.
  const b = fresh();
  b.setActivePiece("straight");
  const before = span(b);
  const culprit = tile("bank_straight_right");
  check("setup: the Banked/Straight Right tile exists", !!culprit);
  b.setActivePreset(culprit.preset);
  b.setActivePiece("straight");
  check("a Banked tile no longer resizes your next Straight",
    Math.abs(span(b) - before) < 1e-9,
    `${before.toFixed(1)} m -> ${span(b).toFixed(1)} m — this is the exact sequence ` +
    `that made a test track come out one piece length short`);
}
{
  // ...and the tube tiles, which set straightLength up to 110.
  const b = fresh();
  b.setActivePiece("straight");
  const before = span(b);
  for (const t of allTiles.filter((x) => x.cat === "tubes")) b.setActivePreset(t.preset);
  b.setActivePiece("straight");
  check("nor do the Tubes tiles (one of them sets 110 m)",
    Math.abs(span(b) - before) < 1e-9, `${before.toFixed(1)} -> ${span(b).toFixed(1)} m`);
}

console.log("\n=== 2. THE SHARED OBJECT IS NEVER WRITTEN ===");
{
  const b = fresh();
  const snapshot = JSON.stringify(pieceParams);
  for (const t of allTiles) b.setActivePreset(t.preset);
  b.setActivePiece("curve");
  b.flip();
  b.setActivePiece("straight");
  for (let i = 0; i < 3; i++) b.place();
  check("selecting, flipping and placing leave pieceParams untouched",
    JSON.stringify(pieceParams) === snapshot,
    "something still writes the shared object — that is the whole bug");
}
{
  const b = fresh();
  const snapshot = JSON.stringify(pieceParams);
  b.loadDemo();
  check("...and so does loading the demo track", JSON.stringify(pieceParams) === snapshot);
  b.loadBigCircuit();
  check("...and the big circuit", JSON.stringify(pieceParams) === snapshot);
}

console.log("\n=== 3. WHAT THE TILE SAYS IS WHAT GETS PLACED ===");
{
  const b = fresh();
  for (const id of ["straight_std", "straight_short", "straight_long"]) {
    const t = tile(id);
    if (!t) { check(`tile ${id} exists`, false); continue; }
    b.setActivePreset(t.preset);
    const readout = span(b);
    b.place();
    const placed = b.pieces.at(-1).pp.straightLength;
    check(`"${t.label}" places exactly what the readout says`,
      Math.abs(readout - placed) < 1e-9 && Math.abs(placed - t.preset.params.straightLength) < 1e-9,
      `tile says ${t.preset.params.straightLength}, readout ${readout.toFixed(2)}, placed ${placed}`);
  }
}
{
  // The default block is now ON the menu — it never was.
  const b = fresh();
  b.setActivePiece("straight");
  const bootSpan = span(b);
  const std = tile("straight_std");
  check("there is a Straight tile for the size the editor boots on", !!std);
  if (std) {
    b.setActivePreset(std.preset);
    check("...and clicking it gives exactly that size",
      Math.abs(span(b) - bootSpan) < 1e-9,
      `boots at ${bootSpan.toFixed(1)} m, tile gives ${span(b).toFixed(1)} m`);
  }
}

console.log("\n=== 4. FLIP STAYS LOCAL TO THE SELECTION ===");
{
  const b = fresh();
  b.setActivePiece("curve");
  const d0 = b.activeParams.curveDir;
  b.flip();
  check("flip reverses the active piece", b.activeParams.curveDir === -d0);
  b.setActivePiece("straight");
  b.setActivePiece("curve");
  check("...and picking the piece again gives the kit's direction back",
    b.activeParams.curveDir === d0,
    `still ${b.activeParams.curveDir} — a flip must not outlive the selection`);
}

console.log("\n=== 5. A LOADED TRACK CANNOT RESIZE YOUR NEXT PIECE ===");
{
  // importTrack writes the saved pieceParams into the shared object. Nothing on
  // the placement path reads it any more, so the palette keeps meaning what it
  // says even after loading a track authored with different numbers.
  const b = fresh();
  b.setActivePiece("straight");
  const before = span(b);
  Object.assign(pieceParams, { straightLength: 77 }); // as a track load would
  const after = span(b);
  Object.assign(pieceParams, { straightLength: 22 }); // put it back for later tests
  check("poking the shared object does not change the active piece",
    Math.abs(after - before) < 1e-9,
    `${before.toFixed(1)} -> ${after.toFixed(1)} m`);
}

console.log("\n=== 6. PLACED TRACK IS UNAFFECTED (regression guard) ===");
{
  const b = fresh();
  b.setActivePreset(tile("straight_long").preset);
  b.place(); b.place();
  b.setActivePreset(tile("straight_short").preset);
  b.place();
  const lens = b.pieces.map((p) => p.pp.straightLength);
  check("each piece keeps the size it was placed at", lens.join() === "32,32,14",
    lens.join() + " — placed pieces freeze their own params and must not follow the palette");
  const before = lens.join();
  b.setActivePreset(tile("straight_std").preset);
  check("...and picking another tile does not touch them",
    b.pieces.map((p) => p.pp.straightLength).join() === before);
}

console.log(fail ? `\n${fail} FAILURE(S)\n` : "\nall green\n");
process.exit(fail ? 1 : 0);
