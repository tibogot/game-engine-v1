// POINTING AT THE TRACK, and STEPPING THROUGH JUNCTION BRANCHES.
//
// Two fixes for the same complaint — "the snapping doesn't really work, the
// gizmo just moves the piece freely in XYZ":
//
//  1. aimAtCursor: the next piece now follows the MOUSE, the way a prop ghost
//     always has. Before, the only way to move it was to drag a gizmo that
//     translates on the three WORLD axes and then land inside a 6 m magnet
//     sphere — on a kit whose pieces are 22–44 m long, with an 8 m grid that
//     divides none of them.
//  2. snapGhostToNearestBranch: K now CYCLES. It used to re-pick the branch
//     nearest `currentConnector`, which jumping to a branch does not move, so
//     three presses on a crossroads landed on the same arm three times and the
//     second arm was unreachable from the keyboard.
import * as THREE from "three";
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
const P = (v) => `(${v.x.toFixed(1)}, ${v.y.toFixed(1)}, ${v.z.toFixed(1)})`;

// A camera + a fake canvas, which is all aimAtCursor needs. No renderer, no
// gizmo: the whole point is that aiming is a projection, not a drag.
const W = 1280, H = 720;
function fresh() {
  const b = new ModularRoadBuilder({
    scene: new THREE.Scene(),
    material: new THREE.MeshBasicMaterial(),
    railMaterial: new THREE.MeshBasicMaterial(),
    shellMaterial: new THREE.MeshBasicMaterial(),
    decorMaterial: new THREE.MeshBasicMaterial(),
  });
  const cam = new THREE.PerspectiveCamera(60, W / H, 0.1, 5000);
  b._camera = cam;
  b._domElement = { getBoundingClientRect: () => ({ left: 0, top: 0, width: W, height: H }) };
  return b;
}
/** Look at `at` from `from`, and return the screen position of a world point. */
function aimCam(b, from, at) {
  b._camera.position.copy(from);
  b._camera.lookAt(at);
  b._camera.updateMatrixWorld(true);
  b._camera.updateProjectionMatrix();
}
function toScreen(b, v) {
  const p = v.clone().project(b._camera);
  return { x: (p.x * 0.5 + 0.5) * W, y: (-p.y * 0.5 + 0.5) * H };
}
const posOf = (m) => new THREE.Vector3().setFromMatrixPosition(m);

console.log("\n=== 1. THE NEXT PIECE FOLLOWS THE CURSOR ===");
{
  const b = fresh();
  b.setActivePiece("straight");
  for (let i = 0; i < 4; i++) b.place();          // chain 0 runs off down -Z
  // A second chain somewhere else entirely.
  b.beginNewChain(new THREE.Vector3(200, 0, 0), 0);
  b.setActivePiece("straight");
  for (let i = 0; i < 3; i++) b.place();
  const c0 = b.chains[0].id, c1 = b.chains[1].id;
  check("setup: two separate chains", b.chains.length === 2 && b.pieces.length === 7,
    `${b.chains.length} chains, ${b.pieces.length} pieces`);

  // Look at the whole thing from above.
  aimCam(b, new THREE.Vector3(100, 260, 120), new THREE.Vector3(100, 0, -50));

  const tail0 = posOf(b.pieces.filter((p) => p.chainId === c0).at(-1).connectorOut);
  const head0 = posOf(b._chainHead(c0));
  const tail1 = posOf(b.pieces.filter((p) => p.chainId === c1).at(-1).connectorOut);

  // Point at chain 1's tail — the chain we are NOT currently appending to.
  b.activeChainId = c0;
  const s = toScreen(b, tail1);
  const moved = b.aimAtCursor(s.x, s.y);
  check("pointing at another chain's end moves the aim there", moved);
  check("...and makes that chain the append target", b.activeChainId === c1,
    `active = ${b.activeChainId}, wanted ${c1}`);
  check("...with the ghost exactly on that end",
    b._ghostPos.distanceTo(tail1) < 1e-6, `${P(b._ghostPos)} vs ${P(tail1)}`);
  check("...and appending, not prepending", b.buildEnd === "tail", b.buildEnd);

  // Point at chain 0's HEAD — should switch chain AND flip to prepend.
  const sh = toScreen(b, head0);
  b.aimAtCursor(sh.x, sh.y);
  check("pointing at a chain's START switches to it", b.activeChainId === c0,
    `active = ${b.activeChainId}`);
  check("...and flips to building backwards", b.buildEnd === "head", b.buildEnd);

  // Point at chain 0's tail again.
  const st = toScreen(b, tail0);
  b.aimAtCursor(st.x, st.y);
  check("pointing back at its far end returns to appending",
    b.activeChainId === c0 && b.buildEnd === "tail", `${b.activeChainId}/${b.buildEnd}`);
}

console.log("\n=== 2. IT ONLY ACTS WHEN YOU ARE ACTUALLY NEAR AN END ===");
{
  const b = fresh();
  b.setActivePiece("straight");
  for (let i = 0; i < 3; i++) b.place();
  aimCam(b, new THREE.Vector3(0, 200, 100), new THREE.Vector3(0, 0, -40));
  const tail = posOf(b.pieces.at(-1).connectorOut);
  const s = toScreen(b, tail);

  // Deliberately free-place, then wave the mouse across empty sky.
  b._gizmoTarget = "ghost";
  b.ghostDetached = true;
  b._ghostPos.set(500, 0, 500);
  const parked = b._ghostPos.clone();
  const acted = b.aimAtCursor(s.x + 400, s.y + 300);
  check("a cursor far from every end does nothing", acted === false);
  check("...and a free-placed piece is left exactly where you put it",
    b._ghostPos.distanceTo(parked) < 1e-6 && b.ghostDetached,
    `${P(b._ghostPos)}, detached=${b.ghostDetached} — an idle mouse move must not ` +
    `steal a piece you positioned by hand`);

  // Now point AT the end: it should take over.
  check("pointing at the end does take over", b.aimAtCursor(s.x, s.y));
  check("...and re-attaches the ghost", !b.ghostDetached && b._ghostPos.distanceTo(tail) < 1e-6);
}
{
  const b = fresh();
  b.setActivePiece("straight");
  for (let i = 0; i < 3; i++) b.place();
  aimCam(b, new THREE.Vector3(0, 200, 100), new THREE.Vector3(0, 0, -40));
  const s = toScreen(b, posOf(b.pieces.at(-1).connectorOut));
  check("the first aim reports a change", b.aimAtCursor(s.x, s.y));
  check("...and holding still on the same end reports none",
    b.aimAtCursor(s.x + 2, s.y + 2) === false,
    "otherwise every mousemove would rebuild the status line and the ghost");
  // Editing a placed piece owns the gizmo — the cursor must keep out of it.
  b.selectPiece(b.pieces[1]);
  check("aiming is inert while a placed piece is selected",
    b.aimAtCursor(s.x, s.y) === false, `gizmoTarget=${b.gizmoMode}`);
}

console.log("\n=== 3. K STEPS THROUGH EVERY BRANCH ===");
{
  const b = fresh();
  b.setActivePiece("straight"); b.place();
  b.setActivePiece("junction_cross"); b.place();
  check("a crossroads offers two branches", b.openBranchCount === 2, `${b.openBranchCount}`);

  const seen = [];
  for (let i = 0; i < 4; i++) {
    b.snapGhostToNearestBranch();
    seen.push(`${b._ghostPos.x.toFixed(1)},${b._ghostPos.z.toFixed(1)}`);
  }
  check("four presses of K visit BOTH arms", new Set(seen).size === 2,
    `visited ${new Set(seen).size} distinct arm(s): ${seen.join("  ")} — it used to ` +
    `re-pick the nearest every time, so the second arm was unreachable`);
  check("...and it wraps rather than sticking on the last one",
    seen[0] === seen[2] && seen[1] === seen[3], seen.join("  "));
}
{
  // Two junctions, four branches: still reachable, still stable.
  const b = fresh();
  b.setActivePiece("straight"); b.place();
  b.setActivePiece("junction_cross"); b.place();
  b.setActivePiece("straight"); b.place();
  b.setActivePiece("junction_t"); b.place();
  const n = b.openBranchCount;
  const seen = new Set();
  for (let i = 0; i < n * 2; i++) {
    b.snapGhostToNearestBranch();
    seen.add(`${b._ghostPos.x.toFixed(1)},${b._ghostPos.z.toFixed(1)}`);
  }
  check(`K reaches all ${n} open branches across two junctions`, seen.size === n,
    `reached ${seen.size} of ${n}`);
}
{
  const b = fresh();
  b.setActivePiece("straight"); b.place();
  check("K reports false when there are no branches at all",
    b.snapGhostToNearestBranch() === false);
}
{
  // Building on a branch consumes it, and K then only offers what is left.
  const b = fresh();
  b.setActivePiece("straight"); b.place();
  b.setActivePiece("junction_cross"); b.place();
  b.snapGhostToNearestBranch();
  b.setActivePiece("straight"); b.place();          // forks a chain on that arm
  check("building on a branch consumes it", b.openBranchCount === 1, `${b.openBranchCount}`);
  b.snapGhostToNearestBranch();
  const only = `${b._ghostPos.x.toFixed(1)},${b._ghostPos.z.toFixed(1)}`;
  b.snapGhostToNearestBranch();
  check("K then parks on the one remaining arm",
    only === `${b._ghostPos.x.toFixed(1)},${b._ghostPos.z.toFixed(1)}`);
}

console.log("\n=== 4. AIMING IS NOT AN EDIT ===");
{
  const b = fresh();
  b.setActivePiece("straight");
  for (let i = 0; i < 3; i++) b.place();
  aimCam(b, new THREE.Vector3(0, 200, 100), new THREE.Vector3(0, 0, -40));
  const tail = toScreen(b, posOf(b.pieces.at(-1).connectorOut));
  const head = toScreen(b, posOf(b._chainHead(0)));
  const undo0 = b._undoStack.length;
  const fp = () => b.pieces.map((p) => p.id + p.connectorIn.elements.join()).join("|");
  const before = fp();
  for (let i = 0; i < 10; i++) { b.aimAtCursor(tail.x, tail.y); b.aimAtCursor(head.x, head.y); }
  check("twenty aim moves add no undo steps", b._undoStack.length === undo0,
    `${b._undoStack.length - undo0} added — pointing at the track is not an edit`);
  check("...and do not touch a single placed piece", fp() === before);
}

console.log(fail ? `\n${fail} FAILURE(S)\n` : "\nall green\n");
process.exit(fail ? 1 : 0);
