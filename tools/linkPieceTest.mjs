// THE LINK — the piece that closes a gap between two ends built separately.
//
// A chain is a RIGID sequence: its end-to-end transform is fixed by the pieces
// in it, so you can weld one end onto a target but not both, unless what you
// happened to place adds up to exactly the right span AND heading. Rejoining an
// alternate route into a merge junction pins both ends, so something in the
// middle has to solve for the leftover. Nothing in the kit did.
//
// The bar is simple and it is the whole point: after linking, the chain's exit
// must equal the target connector EXACTLY — position and heading — and the road
// in between must be drivable.
import * as THREE from "three";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { ModularRoadBuilder } = await import(
  pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadBuilder.js")).href);
const { buildPiece, pieceParams, initialConnector, socketMatrix, linkCurvature } =
  await import(pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadKit.js")).href);

let fail = 0;
const check = (n, c, d = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${!c && d ? "\n        " + d : ""}`);
  if (!c) fail++;
};
const V = (x, y, z) => new THREE.Vector3(x, y, z);
const pos = (m) => new THREE.Vector3().setFromMatrixPosition(m);
const dir = (m) => V(0, 0, -1).applyMatrix4(new THREE.Matrix4().extractRotation(m)).normalize();
const f = (v) => `(${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)})`;
function fresh() {
  return new ModularRoadBuilder({
    scene: new THREE.Scene(),
    material: new THREE.MeshBasicMaterial(),
    railMaterial: new THREE.MeshBasicMaterial(),
    shellMaterial: new THREE.MeshBasicMaterial(),
    decorMaterial: new THREE.MeshBasicMaterial(),
  });
}

console.log("\n=== 1. THE PIECE ITSELF HITS ITS TARGET ===");
{
  // Straight from the kit, no builder: does `link` end where its params say?
  const cases = [
    ["straight ahead", { linkX: 0, linkY: 0, linkZ: -60, linkYawDeg: 0 }],
    ["off to the right", { linkX: 40, linkY: 0, linkZ: -60, linkYawDeg: 0 }],
    ["a 90° arrival", { linkX: 40, linkY: 0, linkZ: -40, linkYawDeg: 90 }],
    ["a 90° the other way", { linkX: -40, linkY: 0, linkZ: -40, linkYawDeg: -90 }],
    ["climbing", { linkX: 10, linkY: 12, linkZ: -70, linkYawDeg: 0 }],
    ["a full U-turn", { linkX: 34, linkY: 0, linkZ: -10, linkYawDeg: 180 }],
    ["a tiny nudge", { linkX: 3, linkY: 0, linkZ: -24, linkYawDeg: 6 }],
  ];
  for (const [name, over] of cases) {
    const pp = { ...pieceParams, ...over };
    const built = buildPiece("link", initialConnector(), pp, undefined, undefined, true);
    const want = V(over.linkX, over.linkY, over.linkZ);
    const got = pos(built.connectorOut);
    const yaw = THREE.MathUtils.degToRad(over.linkYawDeg);
    const wantDir = V(-Math.sin(yaw), 0, -Math.cos(yaw));
    const dp = got.distanceTo(want);
    const dd = dir(built.connectorOut).dot(wantDir);
    check(`link lands on its target — ${name}`, dp < 1e-9 && dd > 1 - 1e-9,
      `off by ${dp.toExponential(1)} m, heading dot ${dd.toFixed(6)}`);
  }
}
{
  const pp = { ...pieceParams, linkX: 0, linkY: 0, linkZ: -60, linkYawDeg: 0 };
  check("a straight-ahead link really is straight", linkCurvature(pp) > 1e4,
    `tightest radius ${linkCurvature(pp).toFixed(0)} m`);
  const tight = { ...pieceParams, linkX: 6, linkY: 0, linkZ: -8, linkYawDeg: 170 };
  const r = linkCurvature(tight);
  check("...and a cruel ask reports a tight radius instead of pretending", r < 30,
    `${r.toFixed(1)} m — the editor needs this to warn rather than build a hairpin`);
  console.log(`        (tightest radius: straight ${linkCurvature(pp).toFixed(0)} m, cruel ask ${r.toFixed(1)} m)`);
}

console.log("\n=== 2. THE REAL JOB: REJOINING A MERGE ===");
{
  // Exactly the layout that could not be built before: main line, split off it,
  // an alternate route, and a merge further down that the route must rejoin.
  const b = fresh();
  b.setActivePiece("straight"); b.place();
  b.setActivePiece("junction_split"); b.place();
  b.setActivePiece("straight"); b.place(); b.place();
  b.setActivePiece("junction_merge"); b.place();
  b.setActivePiece("straight"); b.place();
  const mainChain = b.activeChainId;

  const split = b.branchConnectors().find((x) => x.piece.id === "junction_split");
  const merge = b.branchConnectors().find((x) => x.piece.id === "junction_merge");
  check("setup: the split and the merge both published a branch", !!split && !!merge);

  // Build the alternate route off the split, the way anyone would: out, along,
  // and back in. A route that stops 18 m short while still pointing AWAY cannot
  // be joined by anything — see the refusal case below.
  b._putGhostOnBranch(split.matrix);
  b.setActivePiece("straight");
  b.place();
  const alt = b.activeChainId;
  check("the alternate route is its own chain", alt !== mainChain);

  const gapBefore = pos(b.currentConnector).distanceTo(merge.pos);
  check("...and it does NOT reach the merge on its own", gapBefore > 1,
    `${gapBefore.toFixed(1)} m short — if this is ever 0 the test has stopped being a test`);

  const target = b.linkTargets().find((t) => t.branch && t.branch.piece.id === "junction_merge");
  check("the merge socket is offered as a link target", !!target);

  const res = b.linkTo(target);
  check("the link was built", res.ok, res.reason);
  console.log(`        (closed a ${res.gap?.toFixed(1)} m gap; tightest radius ${res.radius?.toFixed(0)} m)`);

  // THE BAR: the route's exit is now the merge socket, exactly — and pointing
  // INTO the junction, which is the reverse of the socket's outward direction.
  const end = b.pieces.filter((p) => p.chainId === alt).at(-1).connectorOut;
  check("the route now ENDS exactly on the merge socket",
    pos(end).distanceTo(merge.pos) < 1e-9,
    `${f(pos(end))} vs ${f(merge.pos)} — off by ${pos(end).distanceTo(merge.pos).toExponential(1)} m`);
  check("...and arrives pointing INTO the junction, not just at its position",
    dir(end).dot(dir(merge.matrix)) < -1 + 1e-9,
    `dot ${dir(end).dot(dir(merge.matrix)).toFixed(9)} — a merge socket points back up ` +
    `the track (it is authored for building a feeder outward), so a road that ` +
    `ARRIVES there must run against it`);
  check("...and the join is drivable, not a cusp", res.radius >= 6,
    `${res.radius?.toFixed(1)} m`);
  check("the merge branch now reads as USED", b.openBranchCount === 0,
    `${b.openBranchCount} still free — a branch a road ARRIVES at is as taken as ` +
    `one a road starts from`);
  check("nothing on the main line moved",
    b.pieces.filter((p) => p.chainId === mainChain).length === 6);
}
{
  // The refusal, measured: a stub that stops short while still pointing away.
  const b = fresh();
  b.setActivePiece("straight"); b.place();
  b.setActivePiece("junction_split"); b.place();
  b.setActivePiece("straight"); b.place(); b.place();
  b.setActivePiece("junction_merge"); b.place();
  const merge = b.branchConnectors().find((x) => x.piece.id === "junction_merge");
  b._putGhostOnBranch(b.branchConnectors().find((x) => x.piece.id === "junction_split").matrix);
  b.setActivePiece("straight"); b.place(); b.place();
  const r = b.linkTo({ ...merge, end: "branch" });
  check("a hairpin ask is refused, with the radius and advice", !r.ok && r.radius < 10,
    JSON.stringify(r));
  console.log(`        ("${r.reason}")`);
}

console.log("\n=== 3. IT SURVIVES THE THINGS EVERY PIECE MUST ===");
{
  // The same split → route → merge layout as above, which is known to produce a
  // clean join. (Linking a one-piece stub straight back onto the main line's
  // tail is a hairpin and is correctly refused — that is section 4's job, not a
  // fixture for these.)
  const b = fresh();
  b.setActivePiece("straight"); b.place();
  b.setActivePiece("junction_split"); b.place();
  b.setActivePiece("straight"); b.place(); b.place();
  b.setActivePiece("junction_merge"); b.place();
  b.setActivePiece("straight"); b.place();
  b._putGhostOnBranch(b.branchConnectors().find((x) => x.piece.id === "junction_split").matrix);
  b.setActivePiece("straight"); b.place();
  const alt = b.activeChainId;
  const target = b.linkTargets().find((t) => t.branch && t.branch.piece.id === "junction_merge");
  const res = b.linkTo(target);
  check("linked an alternate route into the merge", res.ok, res.reason);
  const endOf = (c) => pos(b.pieces.filter((p) => p.chainId === c).at(-1).connectorOut);
  const joined = endOf(alt).clone();

  b.undo();
  check("undo removes the link", !b.pieces.some((p) => p.id === "link"));
  b.redo();
  check("redo puts it back exactly", endOf(alt).distanceTo(joined) < 1e-9);

  const json = JSON.parse(JSON.stringify(b.exportTrackPieces()));
  const b2 = fresh();
  b2.importTrackPieces(json);
  const link2 = b2.pieces.find((p) => p.id === "link");
  check("a link round-trips through save/load", !!link2, "no link piece after import");
  if (link2) {
    check("...and still lands in the same place",
      pos(link2.connectorOut).distanceTo(
        pos(b.pieces.find((p) => p.id === "link").connectorOut)) < 1e-6);
  }
  // A rebuild must re-derive it from its params like any other piece.
  const before = pos(b.pieces.find((p) => p.id === "link").connectorOut).clone();
  b.rebuildAll();
  check("a full rebuild reproduces it",
    pos(b.pieces.find((p) => p.id === "link").connectorOut).distanceTo(before) < 1e-9);
}

console.log("\n=== 4. IT REFUSES RATHER THAN BUILDING NONSENSE ===");
{
  const b = fresh();
  b.setActivePiece("straight"); b.place();
  check("no target ⇒ a reason, not a crash", b.linkToNearestEnd().ok === false);
  check("...and it says why", !!b.linkToNearestEnd().reason,
    JSON.stringify(b.linkToNearestEnd()));
}
{
  const b = fresh();
  b.setActivePiece("straight"); b.place(); b.place();
  b.toggleBuildEnd(); // aiming at the HEAD
  const r = b.linkTo({ matrix: socketMatrix(V(50, 0, -50), V(0, 0, -1), V(0, 1, 0)) });
  check("linking from the head is declined with a reason", !r.ok && !!r.reason, JSON.stringify(r));
}
{
  const b = fresh();
  b.setActivePiece("straight"); b.place();
  const here = b.currentConnector.clone();
  const r = b.linkTo({ matrix: here });
  check("linking to where you already are is declined", !r.ok, JSON.stringify(r));
}

console.log(fail ? `\n${fail} FAILURE(S)\n` : "\nall green\n");
process.exit(fail ? 1 : 0);
