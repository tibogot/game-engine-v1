// Full-tube end caps — close the hollow wall cavity at both mouths.
//
// Tube / tube-long / tube-turn sweep a closed annulus. The length ends were
// open, so you looked into the 0.6 m wall. Caps fill that ring at the first
// and last frames, both faces, painted as outer (zone 4).
//
// They must NOT be a driveable shelf: the deck BVH keeps the uncapped sweep.
// Entries / half tubes already have rim caps along the length and stay off
// this path (they still use openLips).
import * as THREE from "three";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const KIT = join(ROOT, "games/modular-road-v3/modularRoadKit.js");
const KIT_SRC = readFileSync(KIT, "utf8");
let fail = 0;
const check = (n, c, d = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`);
  if (!c) fail++;
};

const { PIECE_BY_ID, pieceParams, buildPiece, initialConnector } =
  await import(new URL("../games/modular-road-v3/modularRoadKit.js", import.meta.url).href);

const RI = 8;
const TW = 0.6;
const pp = (extra = {}) => ({ ...pieceParams, straightLength: 26, tubeRadius: RI, tubeWall: TW, ...extra });

const hitZ = (geo, origin, dir) => {
  const mesh = new THREE.Mesh(geo);
  mesh.updateMatrixWorld(true);
  const hits = new THREE.Raycaster(origin, dir, 0, 8).intersectObject(mesh);
  return hits.length ? hits[0].point.z : null;
};

const attrCount = (geo) => {
  const n = geo.getAttribute("position").count;
  const names = ["uv", "aLateral", "aZone", "aPlain", "aCurve", "normal"];
  for (const name of names) {
    const a = geo.getAttribute(name);
    if (!a || a.count !== n) return { n, bad: name, got: a?.count ?? -1 };
  }
  return { n, bad: null };
};

/* ══ Catalog ══════════════════════════════════════════════════════════════ */
console.log("— catalog —");
const tube = PIECE_BY_ID.get("tube");
const turn = PIECE_BY_ID.get("tube_curve");
check("tube and tube_curve flag tubeEndCaps", tube?.tubeEndCaps === true && turn?.tubeEndCaps === true);
/*
 * ENTRIES ARE ON THIS PATH NOW — this used to assert the opposite, and the
 * opposite was the bug.
 *
 * The reasoning was that an entry's rim caps "already close it along the
 * length", which is true of the HALF tubes (their lips sweep the whole way and
 * you see wall thickness from the side) and false of the full-ring ones: at the
 * bore end a `tube_in` is an open annulus, and standing at the mouth you look
 * straight into the wall cavity. Reported as "missing the face that makes the
 * depth at the exit". It was only ever hidden when the neighbouring `tube`
 * happened to cap the shared seam.
 *
 * What decides it is now per-END, not per-piece: appendTubeEndCaps caps an end
 * iff THAT end's own section is a closed ring (sectionIsClosedRing). So an entry
 * caps the bore it opens into and leaves its flat-road end alone, and the half
 * tubes stay off the path because an arc never closes.
 */
check("full-ring entries and exits cap their bore mouth",
  PIECE_BY_ID.get("tube_in")?.tubeEndCaps === true
  && PIECE_BY_ID.get("tube_out")?.tubeEndCaps === true);
check("half tubes stay off this path — an arc has no mouth to close",
  !PIECE_BY_ID.get("half_tube")?.tubeEndCaps
  && !PIECE_BY_ID.get("half_tube_in")?.tubeEndCaps);
check("the flag is on the piece defs, not a one-off in buildPiece",
  /tubeEndCaps: true/.test(KIT_SRC));

/* ══ Straight tube ════════════════════════════════════════════════════════ */
console.log("\n— straight tube —");
const built = buildPiece("tube", initialConnector(), pp());
const vis = built.geometry;
const col = built.deckCollision;
check("the visible mesh has a collision stand-in", !!col);
check("collision is a different geometry (caps are visual-only)", col !== vis);

const visN = vis.getIndex().count / 3;
const colN = col.getIndex().count / 3;
check("the mesh has more triangles than the BVH", visN > colN,
  `${visN} visible vs ${colN} collision`);

const nSeg = tube.profile(pp()).pts.filter((p) => p.zone === 3).length - 1;
const extraTris = visN - colN;
const expected = 2 * 2 * nSeg * 2; // 2 ends × 2 faces × n quads × 2 tris
check("extra triangles are exactly the two two-sided rings", extraTris === expected,
  `${extraTris} extra, expected ${expected} (${nSeg} segs)`);

const visAttr = attrCount(vis);
check("capped mesh keeps every sweep attribute in count", !visAttr.bad,
  visAttr.bad ? `${visAttr.bad} is ${visAttr.got} not ${visAttr.n}` : `${visAttr.n} verts`);

const midY = RI + RI + TW / 2; // top of the wall, between inner and outer
const origin = new THREE.Vector3(0, midY, 1);
const dir = new THREE.Vector3(0, 0, -1);
const visHit = hitZ(vis, origin, dir);
const colHit = hitZ(col, origin, dir);
check("a ray into the wall cavity hits the visible lip", visHit !== null && Math.abs(visHit) < 0.05,
  visHit === null ? "missed" : `z=${visHit.toFixed(4)}`);
check("the same ray misses collision (no shelf across the mouth)", colHit === null,
  colHit === null ? "" : `hit z=${colHit.toFixed(4)}`);

/* ══ Curve + long preset ══════════════════════════════════════════════════ */
console.log("\n— tube turn and long —");
const curved = buildPiece("tube_curve", initialConnector(), pp());
check("tube_curve also caps and keeps an open BVH",
  curved.deckCollision
  && curved.geometry.getIndex().count > curved.deckCollision.getIndex().count);

const long = buildPiece("tube", initialConnector(), pp({ straightLength: 52 }));
const longExtra = long.geometry.getIndex().count / 3 - long.deckCollision.getIndex().count / 3;
check("a long tube adds the same cap triangles (length does not grow the rings)",
  longExtra === expected, `${longExtra} extra`);

/* ══ Neighbours unchanged ═════════════════════════════════════════════════ */
console.log("\n— neighbours stay as they were —");
const half = buildPiece("half_tube", initialConnector(), pp());
check("half_tube still uses openLips, not tubeEndCaps",
  PIECE_BY_ID.get("half_tube").openLips === true && !PIECE_BY_ID.get("half_tube").tubeEndCaps);
check("half_tube collision is the stripped-lip copy, not a clone of the whole mesh",
  half.deckCollision && half.deckCollision.getIndex().count < half.geometry.getIndex().count);

/* ══ Per-end capping ══════════════════════════════════════════════════════ */
console.log("\n— each end is judged on its own section —");

/** Triangles lying flat in the plane of the near (z max) and far (z min) end. */
function endFaces(geo) {
  const pos = geo.getAttribute("position"), idx = geo.getIndex();
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    lo = Math.min(lo, pos.getZ(i)); hi = Math.max(hi, pos.getZ(i));
  }
  let near = 0, far = 0;
  for (let i = 0; i < idx.count; i += 3) {
    const z = [idx.getX(i), idx.getX(i + 1), idx.getX(i + 2)].map((v) => pos.getZ(v));
    if (z.every((v) => Math.abs(v - hi) < 1e-4)) near++;
    if (z.every((v) => Math.abs(v - lo) < 1e-4)) far++;
  }
  return { near, far };
}

const entry = buildPiece("tube_in", initialConnector(), pp());
const eFaces = endFaces(entry.geometry);
check("tube_in caps the BORE end", eFaces.far > 0, `${eFaces.far} triangles`);
check("...and leaves its flat-road end open", eFaces.near === 0);
check("...and the caps are visual only — the BVH still has no shelf",
  entry.deckCollision && endFaces(entry.deckCollision).far === 0);

const exit = buildPiece("tube_out", initialConnector(), pp());
const xFaces = endFaces(exit.geometry);
check("tube_out caps the bore end it comes OUT of", xFaces.near > 0, `${xFaces.near} triangles`);
check("...and leaves its flat-road end open", xFaces.far === 0);

// THE CASE A SHARED REFERENCE SECTION COULD NOT DO: two mouths, two radii.
const red = buildPiece("tube_reduce", initialConnector(),
  { ...pp(), tubeEntryLength: 30, tubeRadius: 8, tubeRadius2: 12 });
const rFaces = endFaces(red.geometry);
check("a reducer caps BOTH mouths", rFaces.near > 0 && rFaces.far > 0);
const rp2 = red.geometry.getAttribute("position");
let lo = Infinity, hi = -Infinity;
for (let i = 0; i < rp2.count; i++) {
  lo = Math.min(lo, rp2.getZ(i)); hi = Math.max(hi, rp2.getZ(i));
}
const spanAt = (z, cy) => {
  let a = Infinity, b = 0;
  for (let i = 0; i < rp2.count; i++) {
    if (Math.abs(rp2.getZ(i) - z) > 1e-4) continue;
    const r = Math.hypot(rp2.getX(i), rp2.getY(i) - cy);
    a = Math.min(a, r); b = Math.max(b, r);
  }
  return { a, b };
};
const nearR = spanAt(hi, 8), farR = spanAt(lo, 12);
check("...each at its OWN radius, which one shared section could never do",
  Math.abs(nearR.a - 8) < 1e-3 && Math.abs(farR.a - 12) < 1e-3,
  `near ${nearR.a.toFixed(2)}–${nearR.b.toFixed(2)}, far ${farR.a.toFixed(2)}–${farR.b.toFixed(2)}`);

console.log(fail === 0 ? "\nAll tube end-cap checks passed." : `\n${fail} check(s) FAILED.`);
process.exit(fail === 0 ? 0 : 1);
