// Junction BRANCHES on the real ModularRoadBuilder (headless — no camera/DOM, so
// the TransformControls gizmo is skipped). The branch model is "a side road is
// just another chain that starts at a junction socket", so this checks the parts
// that claim makes: branches are published, K parks the ghost on one, placing
// forks a chain there, the branch then reads as used, and all of it survives
// undo / redo and a save-load round trip.
import * as THREE from "three";
import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { ModularRoadBuilder } = await import(pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadBuilder.js")).href);

let fail = 0;
const check = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); if (!c) fail++; };
const posOf = (m) => new THREE.Vector3().setFromMatrixPosition(m);

function fresh() {
  return new ModularRoadBuilder({
    scene: new THREE.Scene(),
    material: new THREE.MeshBasicMaterial(),
    railMaterial: new THREE.MeshBasicMaterial(),
    shellMaterial: new THREE.MeshBasicMaterial(),
    decorMaterial: new THREE.MeshBasicMaterial(),
  });
}
const put = (b, id) => { b.setActivePiece(id); return b.place(); };

// MARKERS NOW COVER EVERY OPEN END, not just branches — chain heads and tails
// draw one too (see endMarkersTest.mjs), because a floating arrow on a junction
// and nothing at all on the end you are actually building from was the reason
// nobody could find where the track could grow. So count BRANCH markers by
// material rather than counting the whole group.
const branchMarkerCount = (b) =>
  b.branchMarkers.children.filter((m) => m.material === b.endMarkerMats.branch
    || (m.material === b.endMarkerMats.aimed && b.ghostOnBranch)).length;

// ── a crossroads publishes two branches, and they start out free ────────────
{
  const b = fresh();
  put(b, "straight");
  put(b, "junction_cross");
  put(b, "straight");
  check("crossroads publishes 2 branches", b.branchConnectors().length === 2, `${b.branchConnectors().length}`);
  check("both branches start free", b.openBranchCount === 2, `${b.openBranchCount}`);
  check("a plain straight publishes none", (b.pieces[0].branches ?? []).length === 0);
  check("one marker per free branch", branchMarkerCount(b) === 2, `${branchMarkerCount(b)} branch markers of ${b.branchMarkers.children.length} total`);
  check("the through line still chains", posOf(b.pieces[1].connectorOut).distanceTo(posOf(b.pieces[2].connectorIn)) < 1e-6);
}

// ── K parks the ghost on a branch; placing forks a new chain there ──────────
{
  const b = fresh();
  put(b, "straight");
  put(b, "junction_t");
  const chainsBefore = b.chainCount;
  const target = b.branchConnectors().find((x) => !x.used);

  check("snapGhostToNearestBranch finds one", b.snapGhostToNearestBranch() === true);
  check("ghost reports it is on a branch", b.ghostOnBranch === true && b.ghostDetached === true);
  check("ghost sits exactly on the socket", b._ghostPos.distanceTo(target.pos) < 1e-6,
    `${b._ghostPos.distanceTo(target.pos).toExponential(1)}`);

  const side = put(b, "straight");
  check("placing on a branch forks a new chain", b.chainCount === chainsBefore + 1, `${chainsBefore} → ${b.chainCount}`);
  check("the side road starts AT the branch", posOf(side.userData.piece.connectorIn).distanceTo(target.pos) < 1e-6);
  check("the branch now reads as used", b.openBranchCount === 0, `${b.openBranchCount} free`);
  check("its marker is gone", branchMarkerCount(b) === 0, `${branchMarkerCount(b)} branch markers of ${b.branchMarkers.children.length} total`);
  check("ghost is off the branch after placing", b.ghostOnBranch === false);

  // The side road must run the way the socket points, not down the main line.
  const e = target.matrix.elements;
  const outDir = new THREE.Vector3(-e[8], -e[9], -e[10]).normalize();
  const ran = posOf(side.userData.piece.connectorOut).sub(target.pos).normalize();
  check("the side road runs the way the branch points", ran.dot(outDir) > 0.999, `dot=${ran.dot(outDir).toFixed(4)}`);

  // ...and it must not be following the junction's own chain.
  check("the side road is its own chain", side.userData.piece.chainId !== b.pieces[1].chainId);
}

// ── undo / redo ─────────────────────────────────────────────────────────────
{
  const b = fresh();
  put(b, "junction_cross");
  b.snapGhostToNearestBranch();
  put(b, "straight");
  check("before undo: 1 branch used", b.openBranchCount === 1, `${b.openBranchCount}`);
  b.undo();
  check("undo frees the branch again", b.openBranchCount === 2, `${b.openBranchCount}`);
  check("undo restores the marker", branchMarkerCount(b) === 2, `${branchMarkerCount(b)} branch markers of ${b.branchMarkers.children.length} total`);
  b.redo();
  check("redo re-uses it", b.openBranchCount === 1, `${b.openBranchCount}`);
}

// ── the branch travels with the junction ───────────────────────────────────
{
  const b = fresh();
  put(b, "junction_cross");
  const before = b.branchConnectors()[0].pos.clone();
  b.setFreePlacement(new THREE.Vector3(64, 24, -96), 0); // drag the chain anchor
  const after = b.branchConnectors()[0].pos.clone();
  check("dragging the chain moves its branches", before.distanceTo(after) > 50,
    `moved ${before.distanceTo(after).toFixed(1)}m`);
  check("branches rise with the chain", Math.abs(after.y - 24) < 1e-4, `y=${after.y.toFixed(2)}`);
}

// ── save / load: no format change, branches come back from the geometry ────
{
  const b = fresh();
  put(b, "junction_roundabout");
  b.snapGhostToNearestBranch();
  put(b, "straight");
  const json = JSON.parse(JSON.stringify(b.exportTrackPieces()));

  const b2 = fresh();
  b2.importTrackPieces(json);
  check("round trip keeps every piece", b2.count === b.count, `${b.count} → ${b2.count}`);
  check("round trip republishes branches", b2.branchConnectors().length === b.branchConnectors().length);
  check("round trip keeps the used flag", b2.openBranchCount === b.openBranchCount,
    `${b.openBranchCount} → ${b2.openBranchCount}`);
}

// ── R flips the side a T / split uses ───────────────────────────────────────
{
  // Driven through flip() — the actual R key — rather than by poking the shared
  // `pieceParams`. A tile is a block now: selecting a piece resolves its numbers
  // from the kit defaults into the builder's own `activeParams`, so writing the
  // global no longer reaches the piece about to be placed (that WAS the bug).
  const b = fresh();
  put(b, "junction_t");
  const right = b.branchConnectors()[0].pos.x;
  b.clear();
  b.setActivePiece("junction_t");
  b.flip();
  b.place();
  const left = b.branchConnectors()[0].pos.x;
  check("R mirrors the T's arm", right > 1 && left < -1 && Math.abs(right + left) < 1e-6,
    `x ${right.toFixed(1)} vs ${left.toFixed(1)}`);
}

console.log(fail ? `\n${fail} FAILED` : "\nall good");
process.exit(fail ? 1 : 0);
