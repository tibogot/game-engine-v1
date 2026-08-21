// Incremental rebuild: restamp world matrices instead of remeshing a piece
// whose shape did not change. A mid-chain delete / tilt / prepend used to call
// buildPiece on every downstream piece; the vertices were identical, only the
// connector moved. That is the CPU hitch behind every placement on a long lap.
//
// These tests pin three things:
//   1. reuse+relocate matches a full remesh (connectors, first-vertex world pos)
//   2. downstream pieces KEEP their geometry buffer (proof they were not remeshed)
//   3. that path is actually cheaper than remeshing the whole chain
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
const _v = new THREE.Vector3();
const posOf = (m) => _p.setFromMatrixPosition(m).clone();

function fingerprint(b) {
  return b.pieces.map((p) => [
    p.id, p.chainId, p.edges ?? true, !!p.detached,
    posOf(p.connectorIn).toArray().map((n) => n.toFixed(4)).join(","),
    posOf(p.connectorOut).toArray().map((n) => n.toFixed(4)).join(","),
    p.tilt.toArray().map((n) => n.toFixed(4)).join(","),
  ].join("|")).join("\n");
}

function firstWorld(p) {
  const attr = p.mesh.geometry.attributes.position;
  if (!attr || attr.count < 1) return null;
  return _v.fromBufferAttribute(attr, 0).applyMatrix4(p.mesh.matrix).clone();
}

function chainConnected(b) {
  const ps = b.pieces;
  for (let i = 1; i < ps.length; i++) {
    if (posOf(ps[i - 1].connectorOut).distanceTo(posOf(ps[i].connectorIn)) > 1e-5) return false;
  }
  return true;
}

function fresh(n = 8, id = "straight") {
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

function cloneTrack(src) {
  const b = fresh(0);
  b.importTrackPieces(src.exportTrackPieces());
  return b;
}

console.log("\n=== RELOCATE MATCHES A FULL REMESH ===");
{
  const a = fresh(8);
  const b = cloneTrack(a);
  a.deletePiece(a.pieces[0]);
  b.deletePiece(b.pieces[0]);
  // a already reused; force b to remesh every remaining piece
  b.rebuildAll();
  check("delete-first connectors match a full remesh", fingerprint(a) === fingerprint(b));
  check("the chain is still seam-tight", chainConnected(a));

  const lastA = firstWorld(a.pieces.at(-1));
  const lastB = firstWorld(b.pieces.at(-1));
  check("last piece's first vertex lands in the same world spot",
    lastA && lastB && lastA.distanceTo(lastB) < 1e-4,
    lastA && lastB ? `${lastA.distanceTo(lastB).toExponential(2)} m` : "missing vertex");
}

{
  const a = fresh(6);
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.3);
  a.setPieceTilt(a.pieces[1], q);
  const b = cloneTrack(fresh(6));
  b.setPieceTilt(b.pieces[1], q);
  b.rebuildAll();
  check("a mid-chain tilt matches a full remesh", fingerprint(a) === fingerprint(b));
  check("tilt still leaves the chain connected", chainConnected(a));
}

{
  const a = fresh(5);
  check("setup: can build from the head", a.toggleBuildEnd());
  a.place();
  const b = fresh(5);
  b.toggleBuildEnd();
  b.place();
  b.rebuildAll();
  check("a prepend matches a full remesh", fingerprint(a) === fingerprint(b));
}

console.log("\n=== DOWNSTREAM GEOMETRY IS KEPT ===");
{
  const b = fresh(10);
  const kept = b.pieces[7].mesh.geometry;
  const railKept = b.pieces[7].railMesh?.geometry;
  b.deletePiece(b.pieces[2]);
  // pieces[7] slid to index 6
  check("a piece past the delete kept its deck buffer",
    b.pieces[6].mesh.geometry === kept);
  if (railKept) {
    check("and its rail buffer", b.pieces[6].railMesh?.geometry === railKept);
  }
}

{
  const b = fresh(8);
  const kept = b.pieces[5].mesh.geometry;
  b.replacePiece(b.pieces[1], "curve");
  // replace remeshes index 1; everything after relocates
  check("pieces after a replace kept their deck buffer",
    b.pieces[5].mesh.geometry === kept);
}

{
  const b = fresh(6, "tube");
  const kept = b.pieces[4].mesh.geometry;
  const proxy = b.pieces[4].mesh.userData.collisionGeometry;
  b.deletePiece(b.pieces[0]);
  check("a tube past the delete kept its deck buffer",
    b.pieces[3].mesh.geometry === kept);
  check("and its collision proxy (end-cap stand-in)",
    b.pieces[3].mesh.userData.collisionGeometry === proxy);
}

console.log("\n=== IT IS ACTUALLY CHEAPER ===\n");
{
  const ids = ["straight", "curve", "banked", "slope", "crest", "jump", "landing", "tunnel"];
  const a = fresh(0);
  for (let i = 0; i < 80; i++) { a.setActivePiece(ids[i % ids.length]); a.place(); }
  const b = cloneTrack(a);

  const t0 = performance.now();
  a.deletePiece(a.pieces[0]);
  const reuseMs = performance.now() - t0;

  const t1 = performance.now();
  b.deletePiece(b.pieces[0]);
  b.rebuildAll();
  const fullMs = performance.now() - t1;

  console.log(`  80 mixed pieces, delete first: reuse ${reuseMs.toFixed(1)} ms, `
    + `full remesh ${fullMs.toFixed(0)} ms\n`);
  check("deleting the first piece is not a full remesh",
    reuseMs < fullMs / 3 || reuseMs < 8,
    `${reuseMs.toFixed(1)} ms vs ${fullMs.toFixed(0)} ms full`);
}

console.log("\n=== PALETTE PICKS DO NOT CLAIM A COLLISION BAKE ===\n");
{
  const b = fresh(3);
  let last = null;
  b.onChange = (info) => { last = info; };
  b.setActivePiece("curve");
  check("setActivePiece says collision: false", last?.collision === false);
  last = null;
  b.selectPiece(b.pieces[0]);
  check("selecting a piece says collision: false", last?.collision === false);
  last = null;
  b.deletePiece(b.pieces[1]);
  check("a real edit still notifies a collision bake", last?.collision !== false);
}

console.log(fail ? `\n${fail} FAILURE(S)\n` : "\nall green\n");
process.exit(fail ? 1 : 0);
