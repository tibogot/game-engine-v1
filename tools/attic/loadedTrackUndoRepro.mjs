// REPRO: on a LOADED track (rushline.json), deleting a piece and pressing Undo
// scrambles the track and makes pieces unpickable.
//
// importTrackPieces builds its piece objects by hand instead of going through
// _makePieceEntry, and the hand-built literal has no `uid`. Every loaded piece
// therefore carries `uid === undefined`, and _restore keys the whole rebuild off
// uid — so an undo maps all N slots onto the SAME piece object.
//
// builderHistoryTest.mjs never caught it because `fresh()` builds its tracks with
// place(), which does go through _makePieceEntry. The bug only exists on a track
// that came off disk — which is every real one.
import * as THREE from "three";
import { readFileSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const { ModularRoadBuilder } = await import(
  pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadBuilder.js")).href);

let fail = 0;
const check = (n, c, d = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${!c && d ? "\n        " + d : ""}`);
  if (!c) fail++;
};
const _p = new THREE.Vector3();
const pos = (m) => _p.setFromMatrixPosition(m).clone();
const fmt = (v) => `(${v.x.toFixed(1)}, ${v.y.toFixed(1)}, ${v.z.toFixed(1)})`;

/** Everything a player can see about the track. */
const fingerprint = (b) => b.pieces.map((p) => [
  p.id, p.chainId,
  pos(p.connectorIn).toArray().map((n) => n.toFixed(3)).join(","),
  pos(p.connectorOut).toArray().map((n) => n.toFixed(3)).join(","),
].join("|")).join("\n");

function load(file) {
  const b = new ModularRoadBuilder({
    scene: new THREE.Scene(),
    material: new THREE.MeshBasicMaterial(),
    railMaterial: new THREE.MeshBasicMaterial(),
    shellMaterial: new THREE.MeshBasicMaterial(),
    decorMaterial: new THREE.MeshBasicMaterial(),
  });
  const json = JSON.parse(readFileSync(join(ROOT, "games/modular-road-v3", file), "utf8"));
  b.importTrackPieces(json.pieces);
  return b;
}

console.log("\n=== LOADED PIECES MUST HAVE IDENTITY ===");
{
  const b = load("rushline.json");
  console.log(`  rushline: ${b.pieces.length} pieces, ${b.chains.length} chain(s)`);
  const uids = b.pieces.map((p) => p.uid);
  check("every loaded piece has a uid", uids.every((u) => u != null),
    `${uids.filter((u) => u == null).length} of ${uids.length} pieces have uid === undefined`);
  check("...and they are all distinct", new Set(uids).size === uids.length,
    `${new Set(uids).size} distinct uids for ${uids.length} pieces — _restore keys ` +
    `off uid, so duplicates make it map several slots onto one piece`);
}

console.log("\n=== DELETE + UNDO ON A LOADED TRACK ===");
{
  const b = load("rushline.json");
  const before = fingerprint(b);
  const n = b.pieces.length;

  b.deletePiece(b.pieces[Math.floor(n / 2)]);       // pull a piece out of the middle
  check("the delete landed", b.pieces.length === n - 1, `${b.pieces.length}`);

  b.undo();
  check("undo brings the piece count back", b.pieces.length === n, `${b.pieces.length}`);
  check("undo puts every piece back EXACTLY where it was",
    fingerprint(b) === before,
    "the track came back scrambled — pieces are somewhere else entirely");

  const objs = new Set(b.pieces);
  check("the pieces are still N DISTINCT objects after the undo",
    objs.size === b.pieces.length,
    `${objs.size} distinct piece objects for ${b.pieces.length} slots — the array ` +
    `is aliased, so every duplicate slot draws and picks as the same piece`);

  const meshes = new Set(b.pieces.map((p) => p.mesh));
  check("...and N distinct meshes, so right-click can still pick them",
    meshes.size === b.pieces.length,
    `${meshes.size} distinct meshes for ${b.pieces.length} pieces — pickPiece ` +
    `raycasts this set, so the missing ones are unclickable`);
}

console.log("\n=== THE SAME THING, ON THE OTHER SHIPPED TRACK ===");
{
  const b = load("modular-road-track (1).json");
  const before = fingerprint(b);
  const n = b.pieces.length;
  b.deletePiece(b.pieces[1]);
  b.undo();
  check("apex track: delete + undo is a no-op", fingerprint(b) === before,
    `${b.pieces.length} of ${n} pieces, fingerprint differs`);
}

console.log("\n=== AND UNDO STILL WORKS ACROSS A RELOAD ===");
{
  // resetHistory() re-seeds the baseline from the loaded pieces, so the uids it
  // captures have to be the ones the pieces actually carry.
  const b = load("rushline.json");
  const before = fingerprint(b);
  b.setActivePiece("straight");
  b.place();
  b.undo();
  check("place + undo on a loaded track is a no-op", fingerprint(b) === before,
    `${b.pieces.length} pieces`);
}

console.log("\n=== RENDER + COLLISION FLAGS FOLLOW THE PIECE TYPE ===");
{
  // The other half of the same class of bug: `_restore` put `p.id` back but not
  // the flags that ride on the MESH. rebuildAll/_applyBuilt only swap geometry,
  // so undoing a makeGap left noRender + noCollision + the gap material on a
  // piece that was a straight again — road you cannot see and fall through, and
  // it saves to the track file in that state.
  const b = load("rushline.json");
  const p = b.pieces[3];
  const wasId = p.id;
  const flags = (q) => `${!!q.mesh.userData.noRender}/${!!q.mesh.userData.noCollision}`;
  const before = flags(p);

  b.makeGap(p);
  check("makeGap marks the piece as neither drawn nor collidable",
    flags(p) === "true/true", flags(p));

  b.undo();
  check("undo puts the piece type back", p.id === wasId, `${p.id}`);
  check("...AND its render/collision flags", flags(p) === before,
    `noRender/noCollision = ${flags(p)}, want ${before} — invisible road the car ` +
    `drops straight through`);
  check("...AND its material", p.mesh.material === b.material,
    "still the faint gap marker");

  b.redo();
  check("redo re-applies the gap flags", flags(p) === "true/true", flags(p));
}

console.log(fail ? `\n${fail} FAILURE(S)\n` : "\nall green\n");
process.exit(fail ? 1 : 0);
