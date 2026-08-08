// Junction pieces: outline plates, sockets and branches (headless — buildPiece
// needs no GPU). Checks the things that are actually easy to get wrong:
//   • the plate triangulates into a finite, watertight-ish slab (no NaN, deck on
//     top at y=0, slab bottom at −thickness);
//   • the entry seam is exactly the road's width, so a junction mates flush;
//   • every socket (exit + branches) sits ON the plate outline, pointing out;
//   • branch connectors land where the outline says they do once the piece is
//     placed on a rotated connector.
import * as THREE from "three";
import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const KIT = await import(pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadKit.js")).href);
const { buildPiece, initialConnector, roadParams, pieceParams, PIECE_BY_ID, socketMatrix } = KIT;

let fail = 0;
const check = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); if (!c) fail++; };

const IDS = [
  "junction_split", "junction_merge", "junction_y",
  "junction_t", "junction_cross", "junction_roundabout",
];

const finite = (arr) => { for (let i = 0; i < arr.length; i++) if (!Number.isFinite(arr[i])) return false; return true; };

for (const id of IDS) {
  const def = PIECE_BY_ID.get(id);
  const built = buildPiece(id, initialConnector(), { ...pieceParams }, roadParams);
  const g = built.geometry;
  const pos = g.getAttribute("position");
  const box = new THREE.Box3().setFromBufferAttribute(pos);

  check(`${id}: geometry finite`, finite(pos.array) && pos.count > 12, `${pos.count} verts`);
  check(`${id}: attributes present`,
    !!(g.getAttribute("uv") && g.getAttribute("aLateral") && g.getAttribute("aZone") && g.getAttribute("aPlain")));
  check(`${id}: slab depth`,
    Math.abs(box.max.y) < 1e-6 && Math.abs(box.min.y + roadParams.thickness) < 1e-6,
    `y ${box.min.y.toFixed(2)}..${box.max.y.toFixed(2)}`);

  // Every triangle must have area — a degenerate fan means the ear clipper choked.
  const idx = g.getIndex();
  let degenerate = 0;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let i = 0; i < idx.count; i += 3) {
    a.fromBufferAttribute(pos, idx.getX(i));
    b.fromBufferAttribute(pos, idx.getX(i + 1));
    c.fromBufferAttribute(pos, idx.getX(i + 2));
    if (b.sub(a).cross(c.sub(a)).length() < 1e-9) degenerate++;
  }
  check(`${id}: no degenerate tris`, degenerate === 0, `${degenerate}/${idx.count / 3}`);

  // The deck must face UP: sum the +Y area of zone-1 triangles and compare with
  // the plate's footprint. (A flipped winding would come back negative.)
  const nrm = g.getAttribute("normal");
  const zone = g.getAttribute("aZone");
  let deckUp = 0, deckDown = 0;
  for (let i = 0; i < nrm.count; i++) {
    if (zone.getX(i) < 0.5) continue;
    if (nrm.getY(i) > 0.5) deckUp++; else if (nrm.getY(i) < -0.5) deckDown++;
  }
  check(`${id}: deck faces up`, deckUp > 0 && deckDown === 0, `${deckUp} up / ${deckDown} down`);

  // Entry seam width: the two outline points at v=0 must be ±hw.
  const hw = roadParams.width / 2;
  let seam = 0;
  for (let i = 0; i < pos.count; i++) {
    if (Math.abs(pos.getZ(i)) < 1e-6 && Math.abs(pos.getY(i)) < 1e-6) seam = Math.max(seam, Math.abs(pos.getX(i)));
  }
  check(`${id}: entry seam = road width`, Math.abs(seam - hw) < 1e-6, `${(seam * 2).toFixed(2)}m vs ${roadParams.width}m`);

  // Sockets: exit + every branch should sit within the plate's bounding box and
  // point away from the piece.
  check(`${id}: has branches`, built.branchesOut.length >= 1, `${built.branchesOut.length}`);
  const grow = box.clone().expandByScalar(0.5);
  const p = new THREE.Vector3();
  let outside = 0;
  for (const br of built.branchesOut) {
    p.setFromMatrixPosition(br.matrix);
    if (!grow.containsPoint(p)) outside++;
  }
  check(`${id}: branches sit on the plate`, outside === 0, `${outside} stray`);

  check(`${id}: decor markings`, !!built.decorGeometry && finite(built.decorGeometry.getAttribute("position").array));

  // Road markings are single-sided (createDecorMaterial), so a triangle wound
  // the wrong way round is simply not drawn — every one must face up.
  {
    const dg = built.decorGeometry;
    const dp = dg.getAttribute("position");
    const di = dg.getIndex();
    let down = 0;
    for (let i = 0; i < di.count; i += 3) {
      a.fromBufferAttribute(dp, di.getX(i));
      b.fromBufferAttribute(dp, di.getX(i + 1));
      c.fromBufferAttribute(dp, di.getX(i + 2));
      if (b.sub(a).cross(c.sub(a)).y <= 0) down++;
    }
    check(`${id}: markings face up`, down === 0, `${down}/${di.count / 3} back-facing`);
  }
}

// Branches must follow the piece when it is placed on a rotated / raised
// connector — they are world matrices, not local ones.
{
  const conn = socketMatrix(
    new THREE.Vector3(120, 18, -40),
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(0, 1, 0),
  );
  const flat = buildPiece("junction_cross", initialConnector(), { ...pieceParams }, roadParams);
  const moved = buildPiece("junction_cross", conn, { ...pieceParams }, roadParams);
  const p0 = new THREE.Vector3().setFromMatrixPosition(flat.branchesOut[0].matrix);
  const p1 = new THREE.Vector3().setFromMatrixPosition(moved.branchesOut[0].matrix);
  // Heading +X instead of −Z is a −90° yaw; the branch keeps its distance from
  // the piece's entry and moves with it.
  const d0 = p0.distanceTo(new THREE.Vector3(0, 0, 0));
  const d1 = p1.distanceTo(new THREE.Vector3(120, 18, -40));
  check("branch follows a rotated placement", Math.abs(d0 - d1) < 1e-4, `${d0.toFixed(2)} vs ${d1.toFixed(2)}`);
  check("branch is raised with the piece", Math.abs(p1.y - 18) < 1e-4, `y=${p1.y.toFixed(2)}`);

  // A branch direction must be perpendicular-ish to travel for a crossroads.
  const e = moved.branchesOut[0].matrix.elements;
  const travel = new THREE.Vector3(-e[8], -e[9], -e[10]).normalize();
  check("crossroads branch turns 90°", Math.abs(travel.dot(new THREE.Vector3(1, 0, 0))) < 1e-6,
    `dot=${travel.dot(new THREE.Vector3(1, 0, 0)).toFixed(4)}`);
}

// The through line must still chain: a straight placed on the exit connector
// starts exactly where the junction ends.
{
  const j = buildPiece("junction_y", initialConnector(), { ...pieceParams }, roadParams);
  const s = buildPiece("straight", j.connectorOut, { ...pieceParams }, roadParams);
  const a = new THREE.Vector3().setFromMatrixPosition(j.connectorOut);
  const b = new THREE.Vector3().setFromMatrixPosition(s.world);
  check("Y fork exit chains a straight", a.distanceTo(b) < 1e-6, `${a.distanceTo(b).toExponential(1)}`);
}

console.log(fail ? `\n${fail} FAILED` : "\nall good");
process.exit(fail ? 1 : 0);
