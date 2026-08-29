// UNDO / REDO on the real ModularRoadBuilder (headless: camera and domElement
// omitted so the TransformControls gizmo is skipped; buildPiece works with no GPU).
//
// WHY SNAPSHOTS AND NOT COMMAND/INVERSE. Every edit funnels through rebuildAll,
// which DERIVES each piece's entry seam by walking its chain from the anchor — so
// a piece's geometry is a pure function of a small structural record (order, id,
// chain, params, edges, tilt, detached pin) plus the chain anchors. Capturing
// that captures everything, including operations added later, with no inverse to
// write and none to get wrong. What it costs is a rebuild, and that is only
// affordable because restore rebuilds ONLY the pieces that differ: measured, a
// full rebuild is 152 ms on a 300-piece track and 478 ms if it is loops and
// tubes, which is far too slow to sit behind Ctrl+Z.
//
// The tests below therefore check three separate things, and all three have
// failed at some point in other undo systems:
//   1. the state comes back EXACTLY (not just the piece count)
//   2. redo is a real forward step, and a new edit forks the timeline
//   3. one user action is ONE entry — not one per internal step or per frame
import * as THREE from "three";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { ModularRoadBuilder } = await import(
  pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadBuilder.js")).href);

let fail = 0;
const check = (n, c, d = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`);
  if (!c) fail++;
};

const _p = new THREE.Vector3();
const posOf = (m) => _p.setFromMatrixPosition(m).clone();

/** A fingerprint of everything a player can see about the track. */
function fingerprint(b) {
  return b.pieces.map((p) => [
    p.id, p.chainId, p.edges ?? true, !!p.detached,
    posOf(p.connectorIn).toArray().map((n) => n.toFixed(4)).join(","),
    posOf(p.connectorOut).toArray().map((n) => n.toFixed(4)).join(","),
    p.tilt.toArray().map((n) => n.toFixed(4)).join(","),
  ].join("|")).join("\n");
}
function chainConnected(b, chainId) {
  const ps = b.pieces.filter((p) => p.chainId === chainId);
  for (let i = 1; i < ps.length; i++) {
    if (posOf(ps[i - 1].connectorOut).distanceTo(posOf(ps[i].connectorIn)) > 1e-6) return false;
  }
  return true;
}
function fresh(n = 5, id = "straight") {
  const b = new ModularRoadBuilder({
    scene: new THREE.Scene(),
    material: new THREE.MeshBasicMaterial(),
    railMaterial: new THREE.MeshBasicMaterial(),
    shellMaterial: new THREE.MeshBasicMaterial(),
    decorMaterial: new THREE.MeshBasicMaterial(),
  });
  for (let i = 0; i < n; i++) { b.setActivePiece(id); b.place(); }
  return b;
}

console.log("\n=== ONE ACTION, ONE STEP ===");
{
  const b = fresh(5);
  check("five places make five undo steps", b._undoStack.length === 5,
    `${b._undoStack.length}`);
  // The trap: an op that internally deletes+rebuilds must still be ONE step.
  const before = b._undoStack.length;
  b.replacePiece(b.pieces[2], "curve");
  check("a replace is a single step, not one per internal edit",
    b._undoStack.length === before + 1, `+${b._undoStack.length - before}`);
  const b2 = fresh(3);
  const n2 = b2._undoStack.length;
  b2.deletePiece(b2.pieces[1]);
  check("a delete is a single step", b2._undoStack.length === n2 + 1);
}

console.log("\n=== IT COMES BACK EXACTLY ===");
{
  // Not "the count matches" — the full geometry fingerprint, because a chain
  // re-flows when a middle piece goes and a count-only check cannot see that.
  const b = fresh(6);
  const before = fingerprint(b);
  b.deletePiece(b.pieces[2]);
  check("deleting a middle piece really changes the track", fingerprint(b) !== before);
  b.undo();
  check("undo restores it EXACTLY (every seam, tilt and flag)",
    fingerprint(b) === before);
  check("...and the chain is still connected", chainConnected(b, 0));
}
{
  const b = fresh(4);
  const before = fingerprint(b);
  b.setPieceTilt(b.pieces[1], new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.3));
  check("a tilt propagates down the chain", fingerprint(b) !== before);
  b.undo();
  check("undo of a tilt restores every downstream piece too",
    fingerprint(b) === before);
}
{
  const b = fresh(4);
  const before = fingerprint(b);
  b.replacePiece(b.pieces[1], "curve");
  b.undo();
  check("undo of a replace restores the original piece and the seams after it",
    fingerprint(b) === before);
}
{
  const b = fresh(3);
  const before = fingerprint(b);
  b.clear();
  check("clear empties the track", b.pieces.length === 0);
  b.undo();
  check("and CLEAR IS UNDOABLE — the whole track comes back",
    fingerprint(b) === before, `${b.pieces.length} pieces`);
}

console.log("\n=== REDO, AND FORKING THE TIMELINE ===");
{
  const b = fresh(4);
  const four = fingerprint(b);
  b.deletePiece(b.pieces[0]);
  const deleted = fingerprint(b);
  b.undo();
  check("undo went back", fingerprint(b) === four);
  check("redo is available after an undo", b.canRedo());
  b.redo();
  check("redo goes forward again, exactly", fingerprint(b) === deleted);
}
{
  const b = fresh(4);
  b.deletePiece(b.pieces[0]);
  b.undo();
  check("redo is armed", b.canRedo());
  b.setActivePiece("straight"); b.place();      // a NEW edit after an undo
  check("a new edit forks the timeline and clears redo", !b.canRedo(),
    "otherwise redo would splice in a branch the user abandoned");
}
{
  const b = fresh(8);
  const start = fingerprint(b);
  for (let i = 0; i < 5; i++) b.deletePiece(b.pieces[b.pieces.length - 1]);
  for (let i = 0; i < 5; i++) b.undo();
  check("five undos walk all the way back", fingerprint(b) === start,
    `${b.pieces.length} pieces`);
  // Keep going and it correctly unwinds the placements too, back to nothing —
  // then stops, rather than throwing or wrapping around.
  for (let i = 0; i < 50; i++) b.undo();
  check("undo unwinds all the way to an empty track, then stops",
    b.pieces.length === 0 && !b.canUndo(), `${b.pieces.length} pieces`);
}

console.log("\n=== A LOAD IS NOT AN EDIT ===");
{
  const b = fresh(4);
  b.loadDemo();
  check("loading a track clears the history",
    !b.canUndo() && !b.canRedo(),
    "undoing across a load would restore pieces from a track you have left");
}

console.log("\n=== THE REBUILD IS INCREMENTAL (why this is affordable) ===");
{
  const b = fresh(40);
  b.deletePiece(b.pieces[39]);          // last piece: nothing upstream moves
  // Capture AFTER the delete: deletePiece does a full rebuild of its own, so a
  // snapshot taken before it would show every geometry replaced no matter what
  // undo did, and this check would be measuring the delete, not the undo.
  const geoms = new Map(b.pieces.map((p) => [p.uid, p.mesh.geometry]));
  b.undo();
  const rebuilt = b.pieces.filter((p) => geoms.has(p.uid) && geoms.get(p.uid) !== p.mesh.geometry).length;
  check("undoing the LAST piece rebuilds ~1 piece, not all 40",
    rebuilt <= 2, `${rebuilt} of 40 rebuilt`);
}
{
  const b = fresh(40);
  const fp = fingerprint(b);
  b.deletePiece(b.pieces[0]);           // first piece: the whole chain re-flows
  const caps = (p) => JSON.stringify(b._endCapFlags(p, null));
  const restGeoms = new Map(b.pieces.map((p) => [p.uid, { geo: p.mesh.geometry, caps: caps(p) }]));
  b.undo();
  check("undoing the FIRST piece restores the track exactly", fingerprint(b) === fp,
    "the chain moved; relocate has to restamp every seam, not skip it");
  // This used to demand ZERO remeshes, which was right before pieces carried end
  // caps. They do now: deleting piece 0 makes piece 1 the head and gives it an
  // entry lid, so restoring piece 0 has to take that lid away again. A piece
  // whose cap flags changed MUST get new geometry. Assert the reason rather than
  // a count, so a genuinely wasteful remesh still fails.
  const remeshed = b.pieces.slice(1).filter((p) =>
    restGeoms.has(p.uid) && restGeoms.get(p.uid).geo !== p.mesh.geometry);
  const gratuitous = remeshed.filter((p) => restGeoms.get(p.uid).caps === caps(p));
  check("...remeshing only the pieces whose end caps actually changed",
    gratuitous.length === 0,
    gratuitous.length
      ? `${gratuitous.length} of ${remeshed.length} remeshed with unchanged caps `
        + `(indices ${gratuitous.map((p) => b.pieces.indexOf(p)).join(", ")}) — `
        + "they only slid, so the old geometry was still correct"
      : `${remeshed.length} of 39 remeshed, all cap-driven`);
}

console.log("\n=== UIDs ARE STABLE ===");
{
  const b = fresh(4);
  const uids = b.pieces.map((p) => p.uid);
  check("every piece has a distinct uid", new Set(uids).size === 4);
  b.deletePiece(b.pieces[1]);
  b.undo();
  check("uids survive an undo (identity, not array position)",
    b.pieces.map((p) => p.uid).join() === uids.join(),
    "array position is not identity — inserts and deletes renumber everything after them");
}

console.log("\n=== AND IT IS FAST ENOUGH TO SIT BEHIND Ctrl+Z ===\n");
{
  // A MEASURED guard, not a vibe. The reuse check silently did nothing for
  // freshly placed pieces at first, and the only symptom was undo costing
  // 100–243 ms while redo, on identical data, cost 1 ms — invisible to every
  // correctness test above, because the RESULT was right either way.
  const ids = ["straight", "curve", "banked", "slope", "crest", "jump", "landing", "tunnel"];
  const b = fresh(0);
  for (let i = 0; i < 300; i++) { b.setActivePiece(ids[i % ids.length]); b.place(); }
  const t0 = performance.now(); b.undo(); const undoMs = performance.now() - t0;
  const t1 = performance.now(); b.redo(); const redoMs = performance.now() - t1;
  const t2 = performance.now(); b.rebuildAll(); const fullMs = performance.now() - t2;
  console.log(`  300 mixed pieces: undo ${undoMs.toFixed(1)} ms, redo ${redoMs.toFixed(1)} ms ` +
    `— a FULL rebuild of the same track is ${fullMs.toFixed(0)} ms\n`);
  check("undo of the last placement is not a full rebuild",
    undoMs < fullMs / 10, `${undoMs.toFixed(1)} ms vs ${fullMs.toFixed(0)} ms full`);
  check("redo likewise", redoMs < fullMs / 10, `${redoMs.toFixed(1)} ms`);
}

console.log("\n=== THE SHORTCUT REACHES A NON-QWERTY KEYBOARD ===\n");
{
  // `e.code` names the PHYSICAL key by its US-QWERTY position. On AZERTY the key
  // labelled Z sits in the physical W slot, so a code-based match needs the user
  // to press the key labelled W — which with Ctrl is CLOSE TAB, and browsers do
  // not let preventDefault() stop it. So this does not just fail to undo, it
  // loses the track. Matching `e.key` follows the printed label on every layout.
  const { readFileSync } = await import("node:fs");
  const game = readFileSync(join(ROOT, "games/modular-road-v3/roadGame.js"), "utf8");
  const block = game.match(/if \(\(e\.ctrlKey[\s\S]{0,600}?\n    \}/)?.[0] ?? "";
  check("the undo/redo shortcut matches e.key, not e.code",
    /e\.key/.test(block) && !/e\.code/.test(block),
    "e.code would demand Ctrl+W on AZERTY — the browser closes the tab and the work is gone");
  check("and there is a layout-proof fallback on Backspace",
    /case "backspace":[\s\S]{0,200}?builder\.redo\(\)[\s\S]{0,80}?builder\.undo\(\)/.test(game),
    "Backspace carries no letter, so it cannot move between layouts");
}

console.log(fail ? `\n${fail} FAILURE(S)\n` : "\nall green\n");
process.exit(fail ? 1 : 0);
