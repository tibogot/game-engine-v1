// BUILDING FROM EITHER END — growing a chain backwards from its head.
//
// A chain is a linear array walked FORWARD from its anchor, so for a long time
// the only place a piece could go was the tail. `insertPieceBefore` on the first
// piece is NOT the missing feature: it pins the head and shoves the entire track
// forward by one piece length, which breaks every seam you had already aligned.
//
// Prepending is the same walk started one step earlier — put the piece at the
// front of the array and move the anchor back by exactly that piece's own
// transform, so its exit lands on the old head. The maths is exact because a
// piece's exit is a fixed local transform of its entry (exit = entry · L, L a
// pure function of id+params; measured drift 5.7e-14 across all 45 kit pieces),
// so the new anchor is precisely `oldHead · L⁻¹`.
//
// What these tests pin down, in order of what would hurt most if it broke:
//   1. the REST OF THE TRACK DOES NOT MOVE (the whole reason to prepend)
//   2. the new piece actually joins the old head, seam-tight
//   3. a head that is already joined to something is not offered as open
//   4. it survives undo, save/load, and mixes with appending
import * as THREE from "three";
import { readFileSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { ModularRoadBuilder } = await import(
  pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadBuilder.js")).href);

let fail = 0;
const check = (n, c, d = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${!c && d ? "\n        " + d : ""}`);
  if (!c) fail++;
};
const _p = new THREE.Vector3();
const pos = (m) => _p.setFromMatrixPosition(m).clone();
const fmt = (v) => `(${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)})`;

/** Pose of every piece — what "the track did not move" has to mean. */
const poses = (b) => b.pieces.map((p) => ({
  uid: p.uid,
  in: p.connectorIn.clone(),
  out: p.connectorOut.clone(),
}));
/** Largest movement of any piece that existed in BOTH states. */
function maxDrift(before, after) {
  const by = new Map(after.map((e) => [e.uid, e]));
  let d = 0;
  for (const e of before) {
    const f = by.get(e.uid);
    if (!f) continue;
    d = Math.max(d, pos(e.in).distanceTo(pos(f.in)), pos(e.out).distanceTo(pos(f.out)));
  }
  return d;
}
/**
 * Worst seam gap within a chain.
 *
 * DETACHED pieces are skipped: a detached piece sits at its own absolute pin and
 * is SUPPOSED to be off the previous exit — that is what detaching means. A real
 * stunt track is full of them (rushline's chain 1 has a deliberate 177 m jump),
 * so counting those would make this measure the track's design rather than the
 * edit under test.
 */
function seamGap(b, chainId) {
  const ps = b.pieces.filter((p) => p.chainId === chainId);
  let g = 0;
  for (let i = 1; i < ps.length; i++) {
    if (ps[i].detached) continue;
    g = Math.max(g, pos(ps[i - 1].connectorOut).distanceTo(pos(ps[i].connectorIn)));
  }
  return g;
}
/** Seam gaps per chain, so a test can assert they are UNCHANGED by an edit. */
const allSeams = (b) => b.chains.map((c) => `${c.id}:${seamGap(b, c.id).toFixed(6)}`).join(" ");

function fresh() {
  return new ModularRoadBuilder({
    scene: new THREE.Scene(),
    material: new THREE.MeshBasicMaterial(),
    railMaterial: new THREE.MeshBasicMaterial(),
    shellMaterial: new THREE.MeshBasicMaterial(),
    decorMaterial: new THREE.MeshBasicMaterial(),
  });
}
/** A chain of `n` pieces, then the ghost moved onto its HEAD. */
function withHead(n = 4, id = "straight") {
  const b = fresh();
  b.setActivePiece(id);
  for (let i = 0; i < n; i++) b.place();
  check(`setup: toggleBuildEnd() finds the head of a ${n}-piece chain`, b.toggleBuildEnd());
  return b;
}

console.log("\n=== 1. THE REST OF THE TRACK DOES NOT MOVE ===");
{
  const b = withHead(4);
  const before = poses(b);
  const headBefore = b._chainHead(b.activeChainId).clone();

  const uidsBefore = new Set(b.pieces.map((p) => p.uid));
  b.place();
  check("a piece was added", b.pieces.length === 5, `${b.pieces.length}`);
  check("it went to the FRONT of the chain", !uidsBefore.has(b.pieces[0].uid),
    `first piece uid ${b.pieces[0].uid} was already there — prepend must splice at index 0`);
  const drift = maxDrift(before, poses(b));
  check("every pre-existing piece is exactly where it was", drift < 1e-9,
    `worst drift ${drift.toFixed(6)} m — this is the whole reason to prepend rather ` +
    `than insertPieceBefore, which shifts the track by a piece length`);
  check("the new piece's exit lands on the old head",
    pos(b.pieces[0].connectorOut).distanceTo(pos(headBefore)) < 1e-9,
    `${fmt(pos(b.pieces[0].connectorOut))} vs ${fmt(pos(headBefore))}`);
  check("...and its ORIENTATION matches too, not just its position",
    b.pieces[0].connectorOut.elements.every(
      (v, i) => Math.abs(v - headBefore.elements[i]) < 1e-9),
    "a position-only match would leave a kinked seam");
  check("no seam opened anywhere in the chain", seamGap(b, 0) < 1e-9,
    `worst seam ${seamGap(b, 0).toFixed(6)} m`);
}

console.log("\n=== 2. insertPieceBefore IS NOT THIS (the old workaround) ===");
{
  const b = fresh();
  b.setActivePiece("straight");
  for (let i = 0; i < 4; i++) b.place();
  const before = poses(b);
  b.insertPieceBefore(b.pieces[0], "straight");
  const shifted = maxDrift(before, poses(b));
  check("insertPieceBefore genuinely shifts the whole track", shifted > 1,
    `moved ${shifted.toFixed(1)} m — if this ever becomes 0 the two operations ` +
    `have merged and this test is measuring nothing`);
  console.log(`        (it moves the track ${shifted.toFixed(1)} m; prepend moves it 0)`);
}

console.log("\n=== 3. CURVES: THE PREVIEW AND THE PLACEMENT AGREE ===");
{
  // A curve that ARRIVES at a seam is the mirror of the one that leaves it, so
  // previewing at the head socket would draw the wrong shape in the wrong place.
  const b = withHead(3, "straight");
  b.setActivePiece("curve");
  const previewed = b._placementConnector().clone();
  b.place();
  check("the piece was built exactly where the ghost previewed it",
    b.pieces[0].connectorIn.elements.every(
      (v, i) => Math.abs(v - previewed.elements[i]) < 1e-9),
    `preview ${fmt(pos(previewed))} vs built ${fmt(pos(b.pieces[0].connectorIn))}`);
  check("the curve still closes its seam onto the chain", seamGap(b, 0) < 1e-9,
    `${seamGap(b, 0).toFixed(6)} m`);
}

console.log("\n=== 4. PREPENDING REPEATEDLY, AND MIXING WITH APPENDING ===");
{
  const b = withHead(3);
  const tailBefore = pos(b.pieces.at(-1).connectorOut);
  for (let i = 0; i < 4; i++) b.place();          // four more onto the head
  check("four prepends all landed", b.pieces.length === 7, `${b.pieces.length}`);
  check("the tail never moved through any of them",
    pos(b.pieces.at(-1).connectorOut).distanceTo(tailBefore) < 1e-9);
  check("chain still seam-tight", seamGap(b, 0) < 1e-9);

  b.toggleBuildEnd();                              // back to the tail
  check("toggling returns to the tail", b.buildEnd === "tail", b.buildEnd);
  const known = new Set(b.pieces.map((p) => p.uid));
  b.place();
  check("appending still works after prepending", b.pieces.length === 8);
  check("the appended piece went to the END", !known.has(b.pieces.at(-1).uid),
    `last uid ${b.pieces.at(-1).uid} was already in the chain`);
  check("chain still seam-tight after mixing both", seamGap(b, 0) < 1e-9);
}

console.log("\n=== 5. A JOINED HEAD IS NOT AN OPEN END ===");
{
  // A chain that starts on a junction branch is CONNECTED at its head. Offering
  // to prepend there would tear the side road off the junction it was built onto.
  const b = fresh();
  b.setActivePiece("junction_t");
  b.place();
  check("the junction published a branch", b.openBranchCount > 0, `${b.openBranchCount}`);
  check("jumped the ghost to the branch", b.snapGhostToNearestBranch());
  b.setActivePiece("straight");
  b.place();                                       // side road, chain 1
  b.place();
  const sideChain = b.activeChainId;
  check("the side road is its own chain", sideChain !== 0, `chain ${sideChain}`);
  const heads = b._openConnectors().filter((oc) => oc.end === "head");
  check("the side road's head is NOT offered as open",
    !heads.some((h) => h.chainId === sideChain),
    `heads offered: ${heads.map((h) => h.chainId).join() || "none"} — prepending ` +
    `onto a branch-anchored chain would pull it off the junction`);
  check("toggleBuildEnd refuses there", b.toggleBuildEnd() === false,
    "it should decline rather than silently do nothing or prepend anyway");
}
{
  const b = fresh();
  b.setActivePiece("straight");
  b.place(); b.place();
  const heads = b._openConnectors().filter((oc) => oc.end === "head");
  check("an ordinary free-standing chain DOES offer its head",
    heads.length === 1 && heads[0].chainId === 0, `${heads.length} head(s)`);
}
{
  const b = fresh();
  b.setActivePiece("straight");
  b.place();
  const heads = b._openConnectors().filter((oc) => oc.end === "head");
  check("a ONE-piece chain offers its head too", heads.length === 1, `${heads.length}`);
  const empty = fresh();
  check("an EMPTY chain publishes one end, not two",
    empty._openConnectors().length === 1, `${empty._openConnectors().length}`);
}

console.log("\n=== 6. UNDO, AND SAVE/LOAD ===");
{
  const b = withHead(4);
  const before = poses(b);
  b.place();
  b.undo();
  const back = poses(b);
  check("undo removes the prepended piece", b.pieces.length === 4, `${b.pieces.length}`);
  check("...and leaves the track exactly as it was", maxDrift(before, back) < 1e-9,
    `drift ${maxDrift(before, back).toFixed(6)} m`);
  check("...and the anchor went back with it",
    b.buildEnd === "head", `still aiming at ${b.buildEnd} — undo should restore the cursor`);
  b.redo();
  check("redo re-prepends", b.pieces.length === 5, `${b.pieces.length}`);
}
{
  const b = withHead(3);
  b.place(); b.place();
  const exported = b.exportTrackPieces();
  const c = fresh();
  c.importTrackPieces(exported);
  check("a prepended track round-trips through save/load",
    c.pieces.length === b.pieces.length && seamGap(c, 0) < 1e-6,
    `${c.pieces.length} pieces, seam ${seamGap(c, 0).toFixed(6)} m`);
}

console.log("\n=== 7. ON A REAL TRACK ===");
{
  const b = fresh();
  const json = JSON.parse(readFileSync(join(ROOT, "games/modular-road-v3/rushline.json"), "utf8"));
  b.importTrackPieces(json.pieces);
  const before = poses(b);
  const seamsBefore = allSeams(b);
  const n = b.pieces.length;
  const openHeads = b._openConnectors().filter((oc) => oc.end === "head");
  console.log(`        rushline: ${n} pieces, ${b.chains.length} chains, ` +
    `${openHeads.length} head(s) growable`);
  check("rushline has at least one chain you can grow backwards", openHeads.length > 0);

  b.activeChainId = openHeads[0].chainId;
  b._syncGizmoToOpenEnd({ end: "head" });
  b.setActivePiece("straight");
  b.place();
  check("the prepend landed", b.pieces.length === n + 1);
  check("and nothing else on the 41-piece track moved", maxDrift(before, poses(b)) < 1e-9,
    `worst drift ${maxDrift(before, poses(b)).toFixed(6)} m`);
  // UNCHANGED, not zero: this track's jumps are deliberate gaps between detached
  // pieces, so the bar is "the prepend introduced nothing new".
  check("every chain's seams are exactly as they were before the prepend",
    allSeams(b) === seamsBefore, `${seamsBefore}\n        -> ${allSeams(b)}`);
}

console.log(fail ? `\n${fail} FAILURE(S)\n` : "\nall green\n");
process.exit(fail ? 1 : 0);
