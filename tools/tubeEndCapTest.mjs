// Tube end caps — close the hollow wall cavity at both mouths.
//
// Tube / tube-long / tube-turn sweep a closed annulus. Half tubes sweep the
// same wall as an open U. Length ends were open, so you looked into the 0.6 m
// wall. Caps fill that strip at the first and last frames, both faces, painted
// as outer (zone 4). A closed tube gets a ring; a half tube gets the ring with
// the open arc left out, so the sky between the lips stays sky.
//
// They must NOT be a driveable shelf: the deck BVH keeps the uncapped sweep.
// Half tubes still use openLips as well (the longitudinal rims are a launch
// edge, not a shelf).
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

/* ══ Catalog ══════════════════════════════════════════════════════════════ */
console.log("— catalog —");
const tube = PIECE_BY_ID.get("tube");
const turn = PIECE_BY_ID.get("tube_curve");
check("tube and tube_curve flag tubeEndCaps", tube?.tubeEndCaps === true && turn?.tubeEndCaps === true);
/*
 * ENTRIES AND HALF TUBES ARE ON THIS PATH NOW — this used to assert they
 * stayed off, and that was the bug.
 *
 * The first miss was entries: their rim caps close the wall along the length,
 * but at the bore end a `tube_in` is an open annulus, and standing at the mouth
 * you look straight into the cavity. The second miss was half tubes: the same
 * cavity, just a U not a ring. Looking at either end of a `half_tube` you see
 * into the 0.6 m wall; the lips only hide it from the side.
 *
 * What decides it is per-END, not per-piece: appendTubeEndCaps caps an end iff
 * THAT end's own section is a thick wall (closed ring OR open U with height).
 * So an entry caps the mouth it opens into and leaves its flat-road end alone,
 * and a half tube caps both ends without chord-ing across the sky.
 */
check("full-ring entries and exits cap their bore mouth",
  PIECE_BY_ID.get("tube_in")?.tubeEndCaps === true
  && PIECE_BY_ID.get("tube_out")?.tubeEndCaps === true);
check("half tubes cap their mouths too — the wall is still hollow at the ends",
  PIECE_BY_ID.get("half_tube")?.tubeEndCaps === true
  && PIECE_BY_ID.get("half_tube_in")?.tubeEndCaps === true);
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

/* ══ Half tube — same cavity, open U ══════════════════════════════════════ */
console.log("\n— half tube —");
const half = buildPiece("half_tube", initialConnector(), pp());
check("half_tube still strips lips from collision (openLips)",
  PIECE_BY_ID.get("half_tube").openLips === true);
check("half_tube also caps its mouths (tubeEndCaps)",
  PIECE_BY_ID.get("half_tube").tubeEndCaps === true);
check("half_tube collision is the stripped-lip copy, not a clone of the whole mesh",
  half.deckCollision && half.deckCollision.getIndex().count < half.geometry.getIndex().count);

const halfFaces = endFaces(half.geometry);
check("half_tube caps BOTH mouths", halfFaces.near > 0 && halfFaces.far > 0,
  `near ${halfFaces.near}, far ${halfFaces.far}`);
check("...and those caps are visual only — the BVH still has no shelf",
  half.deckCollision && endFaces(half.deckCollision).near === 0
  && endFaces(half.deckCollision).far === 0);

const halfN = PIECE_BY_ID.get("half_tube").profile(pp()).pts.filter((p) => p.zone === 3).length - 1;
const halfExpected = 2 * 2 * halfN * 2; // 2 ends × 2 faces × n quads × 2 tris
check("half_tube extra end-plane triangles are the two two-sided U strips",
  halfFaces.near + halfFaces.far === halfExpected,
  `${halfFaces.near + halfFaces.far} end tris, expected ${halfExpected} (${halfN} segs)`);

// Wall cavity on the left 45° of the U — between inner and outer radius.
const aWall = -Math.PI * 0.75;
const rMid = RI + TW / 2;
const halfOrigin = new THREE.Vector3(Math.cos(aWall) * rMid, RI + Math.sin(aWall) * rMid, 1);
const halfDir = new THREE.Vector3(0, 0, -1);
const halfVisHit = hitZ(half.geometry, halfOrigin, halfDir);
const halfColHit = hitZ(half.deckCollision, halfOrigin, halfDir);
check("a ray into the half-tube wall cavity hits the visible lip",
  halfVisHit !== null && Math.abs(halfVisHit) < 0.05,
  halfVisHit === null ? "missed" : `z=${halfVisHit.toFixed(4)}`);
check("the same ray misses collision (no shelf across the mouth)", halfColHit === null,
  halfColHit === null ? "" : `hit z=${halfColHit.toFixed(4)}`);

// The wrap we must not do: a chord across the open sky between the lips.
const skyOrigin = new THREE.Vector3(0, RI + TW / 2, 1);
const skyHit = hitZ(half.geometry, skyOrigin, halfDir);
check("the open sky between the lips is not capped", skyHit === null,
  skyHit === null ? "" : `hit z=${skyHit.toFixed(4)}`);

const halfAttr = attrCount(half.geometry);
check("capped half-tube keeps every sweep attribute in count", !halfAttr.bad,
  halfAttr.bad ? `${halfAttr.bad} is ${halfAttr.got} not ${halfAttr.n}` : `${halfAttr.n} verts`);

/* ══ Per-end capping ══════════════════════════════════════════════════════ */
console.log("\n— each end is judged on its own section —");

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

const halfEntry = buildPiece("half_tube_in", initialConnector(), pp());
const heFaces = endFaces(halfEntry.geometry);
check("half_tube_in caps the U end", heFaces.far > 0, `${heFaces.far} triangles`);
check("...and leaves its flat-road end open", heFaces.near === 0);

const halfExit = buildPiece("half_tube_out", initialConnector(), pp());
const hxFaces = endFaces(halfExit.geometry);
check("half_tube_out caps the U end it comes OUT of", hxFaces.near > 0, `${hxFaces.near} triangles`);
check("...and leaves its flat-road end open", hxFaces.far === 0);

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

console.log("\n— occupancy can drop a wall ring without changing the section —");
const openTube = buildPiece("tube", initialConnector(), pp(), undefined, undefined, true, {
  capEntry: false, capExit: false,
});
check("suppressing both lids leaves the uncapped sweep (collision size)",
  openTube.geometry.getAttribute("position").count
    === built.deckCollision.getAttribute("position").count);

console.log(fail === 0 ? "\nAll tube end-cap checks passed." : `\n${fail} check(s) FAILED.`);
process.exit(fail === 0 ? 0 : 1);
