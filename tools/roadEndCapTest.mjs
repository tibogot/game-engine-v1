// Road-slab end caps — lids on un-mated sweep ends, not on every piece.
//
// The prism has no end faces. FrontSide looks into the cavity. Caps close
// that hole. They are OPT-IN on buildPiece so a mid-chain remesh stays cheap
// and a joined seam does not z-fight.
//
// Run: node tools/roadEndCapTest.mjs
import * as THREE from "three";
import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { buildPiece, initialConnector, pieceParams } =
  await import(pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadKit.js")).href);
const { ModularRoadBuilder } =
  await import(pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadBuilder.js")).href);

let fail = 0;
const check = (n, c, d = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`);
  if (!c) fail++;
};

const verts = (g) => g.getAttribute("position").count;
const pp = { ...pieceParams };
const conn = initialConnector();

const open = buildPiece("straight", conn, pp);
const both = buildPiece("straight", conn, pp, undefined, undefined, true, {
  capEntry: true, capExit: true,
});
const entry = buildPiece("straight", conn, pp, undefined, undefined, true, {
  capEntry: true,
});
const exitOnly = buildPiece("straight", conn, pp, undefined, undefined, true, {
  capExit: true,
});

console.log("=== BUILDPIECE DEFAULT IS UNLIDDED ===");
check("no caps is the default", verts(open.geometry) < verts(both.geometry),
  `${verts(open.geometry)} < ${verts(both.geometry)}`);
check("one cap sits between open and both",
  verts(entry.geometry) > verts(open.geometry)
  && verts(entry.geometry) < verts(both.geometry));
check("entry-only and exit-only are the same size",
  verts(exitOnly.geometry) === verts(entry.geometry));

console.log("=== TUBES HONOUR THE SAME FLAGS ===");
const tubeBoth = buildPiece("tube", conn, pp);
const tubeNone = buildPiece("tube", conn, pp, undefined, undefined, true, {
  capEntry: false, capExit: false,
});
const tubeEntry = buildPiece("tube", conn, pp, undefined, undefined, true, {
  capEntry: true, capExit: false,
});
const tubeExit = buildPiece("tube", conn, pp, undefined, undefined, true, {
  capEntry: false, capExit: true,
});
check("default tube still has both rings", verts(tubeBoth.geometry) > verts(tubeNone.geometry),
  `${verts(tubeBoth.geometry)} > ${verts(tubeNone.geometry)}`);
check("suppressing both rings matches the collision sweep",
  verts(tubeNone.geometry) === verts(tubeBoth.deckCollision),
  `${verts(tubeNone.geometry)} vs collision ${verts(tubeBoth.deckCollision)}`);
check("one ring sits between open and both",
  verts(tubeEntry.geometry) > verts(tubeNone.geometry)
  && verts(tubeEntry.geometry) < verts(tubeBoth.geometry));
check("entry-only and exit-only tube rings are the same size",
  verts(tubeExit.geometry) === verts(tubeEntry.geometry));

console.log("=== BUILDER: ONLY FREE ENDS GET LIDS ===");
const b = new ModularRoadBuilder({
  scene: new THREE.Scene(),
  material: new THREE.MeshBasicMaterial(),
  railMaterial: new THREE.MeshBasicMaterial(),
  shellMaterial: new THREE.MeshBasicMaterial(),
  decorMaterial: new THREE.MeshBasicMaterial(),
});
for (let i = 0; i < 5; i++) { b.setActivePiece("straight"); b.place(); }
const openN = verts(open.geometry);
const n = (i) => verts(b.pieces[i].mesh.geometry);
check("5-piece chain", b.pieces.length === 5);
check("middle pieces stay unlidded", n(1) === openN && n(2) === openN && n(3) === openN,
  `mid ${n(1)}/${n(2)}/${n(3)} vs open ${openN}`);
check("first piece has the entry lid", n(0) > openN, `${n(0)} vs ${openN}`);
check("last piece has the exit lid", n(4) > openN, `${n(4)} vs ${openN}`);
check("first and last are one-cap each (same size)", n(0) === n(4));

console.log("=== WIDER PIECE KEEPS THE LID THE NARROWER ONE DOES NOT FILL ===");
const platOpen = buildPiece("platform", conn, pp);
const platBoth = buildPiece("platform", conn, pp, undefined, undefined, true, {
  capEntry: true, capExit: true,
});
const platOne = buildPiece("platform", conn, pp, undefined, undefined, true, {
  capEntry: true,
});
check("platform lids are bigger than the open sweep",
  verts(platBoth.geometry) > verts(platOpen.geometry));

const wide = new ModularRoadBuilder({
  scene: new THREE.Scene(),
  material: new THREE.MeshBasicMaterial(),
  railMaterial: new THREE.MeshBasicMaterial(),
});
wide.setActivePiece("straight"); wide.place();
wide.setActivePiece("platform"); wide.place();
wide.setActivePiece("straight"); wide.place();
check("platform between two straights keeps BOTH lids",
  verts(wide.pieces[1].mesh.geometry) === verts(platBoth.geometry),
  `${verts(wide.pieces[1].mesh.geometry)} vs both ${verts(platBoth.geometry)}`);
check("the straight into the platform drops its exit lid",
  verts(wide.pieces[0].mesh.geometry) === verts(entry.geometry),
  `${verts(wide.pieces[0].mesh.geometry)} vs entry-only ${verts(entry.geometry)}`);
check("the straight out of the platform drops its entry lid",
  verts(wide.pieces[2].mesh.geometry) === verts(exitOnly.geometry),
  `${verts(wide.pieces[2].mesh.geometry)} vs exit-only ${verts(exitOnly.geometry)}`);

const twoPlat = new ModularRoadBuilder({
  scene: new THREE.Scene(),
  material: new THREE.MeshBasicMaterial(),
  railMaterial: new THREE.MeshBasicMaterial(),
});
twoPlat.setActivePiece("platform"); twoPlat.place();
twoPlat.setActivePiece("platform"); twoPlat.place();
check("two platforms of the same width still drop the joint lids",
  verts(twoPlat.pieces[0].mesh.geometry) === verts(platOne.geometry)
  && verts(twoPlat.pieces[1].mesh.geometry) === verts(platOne.geometry));

const nar = new ModularRoadBuilder({
  scene: new THREE.Scene(),
  material: new THREE.MeshBasicMaterial(),
  railMaterial: new THREE.MeshBasicMaterial(),
});
nar.setActivePiece("narrow"); nar.place();
nar.setActivePiece("straight"); nar.place();
const straightBoth = verts(both.geometry);
check("a straight after a narrow keeps the lid the narrow does not fill",
  verts(nar.pieces[1].mesh.geometry) === straightBoth,
  `${verts(nar.pieces[1].mesh.geometry)} vs both ${straightBoth}`);

console.log("=== BANKED MOUTHS ONLY NEST WHEN THE CUT MATCHES ===");
const tiltOpen = buildPiece("banktilt", conn, pp);
const tiltBoth = buildPiece("banktilt", conn, pp, undefined, undefined, true, {
  capEntry: true, capExit: true,
});
const tiltOne = buildPiece("banktilt", conn, pp, undefined, undefined, true, {
  capEntry: true,
});
check("a held-bank piece can still take lids",
  verts(tiltBoth.geometry) > verts(tiltOpen.geometry));

const tiltMesh = new THREE.Mesh(tiltBoth.geometry);
tiltMesh.updateMatrixWorld(true);
const f0 = tiltBoth.frames[0];
const fromOutside = f0.pos.clone().addScaledVector(f0.tangent, -1).addScaledVector(f0.up, -0.4);
const intoPiece = f0.tangent.clone();
const tiltHit = new THREE.Raycaster(fromOutside, intoPiece, 0, 2).intersectObject(tiltMesh)[0];
check("FrontSide sees the held-bank entry lid from outside",
  !!tiltHit && tiltHit.distance < 1.2,
  tiltHit ? `dist ${tiltHit.distance.toFixed(3)}` : "missed");

const flatBank = new ModularRoadBuilder({
  scene: new THREE.Scene(),
  material: new THREE.MeshBasicMaterial(),
  railMaterial: new THREE.MeshBasicMaterial(),
});
flatBank.setActivePiece("straight"); flatBank.place();
flatBank.setActivePiece("banktilt"); flatBank.place();
check("a held-bank after a straight keeps the joint lids (U vs flat)",
  verts(flatBank.pieces[0].mesh.geometry) === verts(both.geometry)
  && verts(flatBank.pieces[1].mesh.geometry) === verts(tiltBoth.geometry),
  `straight ${verts(flatBank.pieces[0].mesh.geometry)} vs both ${verts(both.geometry)}, bank ${verts(flatBank.pieces[1].mesh.geometry)} vs ${verts(tiltBoth.geometry)}`);

const ramp = new ModularRoadBuilder({
  scene: new THREE.Scene(),
  material: new THREE.MeshBasicMaterial(),
  railMaterial: new THREE.MeshBasicMaterial(),
});
ramp.setActivePiece("straight"); ramp.place();
ramp.setActivePiece("bankin"); ramp.place();
ramp.setActivePiece("banktilt"); ramp.place();
const bankinOpen = buildPiece("bankin", conn, ramp.pieces[1].pp);
check("bank-in onto a straight drops the flat joint",
  verts(ramp.pieces[0].mesh.geometry) === verts(entry.geometry),
  `${verts(ramp.pieces[0].mesh.geometry)} vs entry-only ${verts(entry.geometry)}`);
check("…and keeps a lid on its curled exit until a held-bank occupies it",
  verts(ramp.pieces[1].mesh.geometry) === verts(bankinOpen.geometry),
  `${verts(ramp.pieces[1].mesh.geometry)} vs open ${verts(bankinOpen.geometry)}`);
check("two held-bank mouths of the same lean drop the joint",
  verts(ramp.pieces[2].mesh.geometry) === verts(tiltOne.geometry),
  `${verts(ramp.pieces[2].mesh.geometry)} vs one-lid ${verts(tiltOne.geometry)}`);

console.log("=== BUILDER: TUBE RINGS DROP ONLY AT WALL JOINTS ===");
const tb = new ModularRoadBuilder({
  scene: new THREE.Scene(),
  material: new THREE.MeshBasicMaterial(),
  railMaterial: new THREE.MeshBasicMaterial(),
});
for (let i = 0; i < 5; i++) { tb.setActivePiece("tube"); tb.place(); }
const tubeN = (i) => verts(tb.pieces[i].mesh.geometry);
const tubeBothN = verts(tubeBoth.geometry);
const tubeNoneN = verts(tubeNone.geometry);
const tubeOneN = verts(tubeEntry.geometry);
check("5-tube chain", tb.pieces.length === 5);
check("middle tubes drop both rings",
  tubeN(1) === tubeNoneN && tubeN(2) === tubeNoneN && tubeN(3) === tubeNoneN,
  `mid ${tubeN(1)}/${tubeN(2)}/${tubeN(3)} vs open ${tubeNoneN}`);
check("first tube keeps the entry ring", tubeN(0) === tubeOneN, `${tubeN(0)} vs ${tubeOneN}`);
check("last tube keeps the exit ring", tubeN(4) === tubeOneN, `${tubeN(4)} vs ${tubeOneN}`);

const mix = new ModularRoadBuilder({
  scene: new THREE.Scene(),
  material: new THREE.MeshBasicMaterial(),
  railMaterial: new THREE.MeshBasicMaterial(),
});
mix.setActivePiece("straight"); mix.place();
mix.setActivePiece("tube"); mix.place();
mix.setActivePiece("straight"); mix.place();
check("a tube between two roads keeps both rings",
  verts(mix.pieces[1].mesh.geometry) === tubeBothN,
  `${verts(mix.pieces[1].mesh.geometry)} vs both ${tubeBothN}`);

const dangling = new ModularRoadBuilder({
  scene: new THREE.Scene(),
  material: new THREE.MeshBasicMaterial(),
  railMaterial: new THREE.MeshBasicMaterial(),
});
dangling.setActivePiece("straight"); dangling.place();
dangling.setActivePiece("tube_in"); dangling.place();
const inOpen = buildPiece("tube_in", conn, dangling.pieces[1].pp, undefined, undefined, true, {
  capEntry: false, capExit: false,
});
const inBoreOnly = buildPiece("tube_in", conn, dangling.pieces[1].pp, undefined, undefined, true, {
  capEntry: false, capExit: true,
});
check("tube_in onto a road still caps its bore (road does not fill the wall)",
  verts(dangling.pieces[1].mesh.geometry) === verts(inBoreOnly.geometry),
  `${verts(dangling.pieces[1].mesh.geometry)} vs bore-only ${verts(inBoreOnly.geometry)}`);
check("...and never lids its flat-road end",
  verts(inOpen.geometry) < verts(inBoreOnly.geometry));

const entryJoin = new ModularRoadBuilder({
  scene: new THREE.Scene(),
  material: new THREE.MeshBasicMaterial(),
  railMaterial: new THREE.MeshBasicMaterial(),
});
entryJoin.setActivePiece("straight"); entryJoin.place();
entryJoin.setActivePiece("tube_in"); entryJoin.place();
entryJoin.setActivePiece("tube"); entryJoin.place();
check("tube_in drops its bore ring once a tube occupies it",
  verts(entryJoin.pieces[1].mesh.geometry) === verts(inOpen.geometry),
  `${verts(entryJoin.pieces[1].mesh.geometry)} vs open ${verts(inOpen.geometry)}`);
check("the tube after tube_in drops its entry ring",
  verts(entryJoin.pieces[2].mesh.geometry) === tubeOneN,
  `${verts(entryJoin.pieces[2].mesh.geometry)} vs one-ring ${tubeOneN}`);

if (fail) {
  console.log(`\n${fail} failed`);
  process.exit(1);
}
console.log("\nall good");
