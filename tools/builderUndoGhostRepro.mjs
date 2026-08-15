// REPRO: "undo after placing a piece puts the next piece in a totally new place"
//
// builderHistoryTest.mjs only ever appends to ONE chain, so it never touches the
// state that actually decides WHERE the next piece lands: the ghost pose, the
// detached flag, and the free-placement anchor. None of those are in _snapshot(),
// so undo silently teleports the cursor.
import * as THREE from "three";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { ModularRoadBuilder } = await import(
  pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadBuilder.js")).href);

let fail = 0;
// The detail line is the FAILURE explanation, so it only prints on a failure —
// printed under a PASS it reads as if the bug were still there.
const check = (n, c, d = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${!c && d ? "\n        " + d : ""}`);
  if (!c) fail++;
};
const _p = new THREE.Vector3();
const pos = (m) => _p.setFromMatrixPosition(m).clone();
const fmt = (v) => `(${v.x.toFixed(1)}, ${v.y.toFixed(1)}, ${v.z.toFixed(1)})`;

function fresh() {
  return new ModularRoadBuilder({
    scene: new THREE.Scene(),
    material: new THREE.MeshBasicMaterial(),
    railMaterial: new THREE.MeshBasicMaterial(),
    shellMaterial: new THREE.MeshBasicMaterial(),
    decorMaterial: new THREE.MeshBasicMaterial(),
  });
}

/** What dragging the ghost gizmo out into empty space does (no gizmo headless). */
function dragGhostTo(b, x, y, z, yaw = 0) {
  b._gizmoTarget = "ghost";
  b.ghostDetached = true;
  b._ghostPos.set(x, y, z);
  b._setGhostYaw(yaw);
  b.refreshGhost();
}

console.log("\n=== 1. FREE-PLACED PIECE: where does the NEXT one land after undo? ===");
{
  const b = fresh();
  b.setActivePiece("straight");
  b.place(); b.place();                         // a starter chain at the origin
  dragGhostTo(b, 400, 0, -400);                 // fly off and start a new chain
  b.place();
  const placedAt = pos(b.pieces.at(-1).connectorIn);
  check("the free-placed piece went where the ghost was",
    placedAt.distanceTo(new THREE.Vector3(400, 0, -400)) < 1e-6, fmt(placedAt));

  b.undo();
  check("undo removed it", b.pieces.length === 2, `${b.pieces.length} pieces`);

  // Now press place again — the user's intent was "put it back where I had it".
  b.place();
  const again = pos(b.pieces.at(-1).connectorIn);
  check("re-placing after undo lands where the ghost was, not on the old chain",
    again.distanceTo(placedAt) < 1e-6,
    `wanted ${fmt(placedAt)}, got ${fmt(again)} — the ghost was teleported back to ` +
    `chain 0's open end by _restore(), so redo-by-hand rebuilds a different track`);
}

console.log("\n=== 2. CHAIN-ANCHOR DRAG: does _freePos survive an undo? ===");
{
  const b = fresh();
  // Drag the chain-0 anchor (what the translate gizmo does on an empty chain).
  b._freePos.set(120, 0, 0);
  b._activeChain().anchor = b._anchorFromFree();
  b.rebuildAll();
  b._commit();

  b.setActivePiece("straight");
  b.place();
  b.undo();                                     // back to "anchor at 120, no pieces"
  const anchorAt = pos(b._activeChain().anchor);
  check("the anchor is still where it was dragged",
    anchorAt.distanceTo(new THREE.Vector3(120, 0, 0)) < 1e-6, fmt(anchorAt));

  // Two more undos should walk the anchor back to the origin.
  b.undo();
  const anchor2 = pos(b._activeChain().anchor);
  const free2 = b._freePos.clone();
  check("after undoing the anchor drag, _freePos agrees with the anchor",
    anchor2.distanceTo(free2) < 1e-6,
    `anchor ${fmt(anchor2)} vs gizmo/_freePos ${fmt(free2)} — the gizmo is drawn at ` +
    `_freePos, and the next drag writes _freePos straight back into chain.anchor, ` +
    `so the chain snaps to the stale spot the moment the gizmo is touched`);
}

console.log("\n=== 3. DO GHOST DRAGS CREATE EMPTY UNDO STEPS? ===");
{
  const b = fresh();
  b.setActivePiece("straight");
  b.place();
  const n = b._undoStack.length;
  // Every gizmo drag-end commits, whether or not it changed anything structural.
  for (let i = 0; i < 3; i++) { dragGhostTo(b, 100 + i * 10, 0, 0); b._commit(); }
  const added = b._undoStack.length - n;
  check("moving the ghost does not add do-nothing undo steps", added === 0,
    `${added} extra steps for 3 ghost drags — each Ctrl+Z then appears to do ` +
    `nothing at all, because the ghost pose is not part of the snapshot`);
}

console.log("\n=== 4. THE CHAIN A FREE PLACEMENT CREATED GOES WITH IT ===");
{
  const b = fresh();
  b.setActivePiece("straight");
  b.place();
  dragGhostTo(b, 300, 0, 0);
  b.place();
  const newChain = b.activeChainId;
  b.undo();
  check("undo removed the chain the free placement created",
    b.chains.length === 1 && !b.chains.some((c) => c.id === newChain),
    `${b.chains.length} chains (ids ${b.chains.map((c) => c.id).join()})`);
  // The restored cursor still points at a chain that no longer exists, so
  // activeChainId must fall back to a live one — but it stays DETACHED, which is
  // what makes the next place fork a fresh chain at the ghost instead of
  // appending to whatever chain the fallback picked.
  check("the append target is a chain that actually exists",
    b.chains.some((c) => c.id === b.activeChainId), `active = ${b.activeChainId}`);
  check("and the ghost is still detached at the pose it was placed from",
    b.ghostDetached && b._ghostPos.distanceTo(new THREE.Vector3(300, 0, 0)) < 1e-6,
    `detached=${b.ghostDetached} at ${fmt(b._ghostPos)}`);
}

console.log("\n=== 5. REDO PUTS THE CURSOR BACK TOO ===");
{
  const b = fresh();
  b.setActivePiece("straight");
  b.place();
  dragGhostTo(b, 300, 0, 0);
  b.place();
  const after = b._ghostPos.clone();   // ghost handed to the new chain's open end
  b.undo();
  b.redo();
  check("redo restores the piece", b.pieces.length === 2, `${b.pieces.length}`);
  check("redo restores the cursor it left the track at",
    b._ghostPos.distanceTo(after) < 1e-6, `${fmt(b._ghostPos)} vs ${fmt(after)}`);
}

console.log("\n=== 6. UNDOING Clear() DOES NOT LET TWO CHAINS SHARE AN id ===");
{
  const b = fresh();
  b.setActivePiece("straight");
  b.place();
  dragGhostTo(b, 300, 0, 0);
  b.place();                              // chain 1
  const ids = b.chains.map((c) => c.id).join();
  b.clear();                              // resets chainSeq to 1
  b.undo();
  dragGhostTo(b, -300, 0, 0);
  b.place();                              // must NOT be handed id 1 again
  const after = b.chains.map((c) => c.id);
  check("chain ids stay unique across an undone Clear",
    new Set(after).size === after.length,
    `was ${ids}, now ${after.join()} — a duplicate id silently merges two chains ` +
    `because _chainPieces filters on it`);
}

console.log(fail ? `\n${fail} FAILURE(S)\n` : "\nall green\n");
