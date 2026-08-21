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
check("entries and half tubes stay off this path",
  !PIECE_BY_ID.get("tube_in")?.tubeEndCaps
  && !PIECE_BY_ID.get("half_tube")?.tubeEndCaps
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

const entry = buildPiece("tube_in", initialConnector(), pp());
check("tube_in is not end-capped (its rims already close along the length)",
  !PIECE_BY_ID.get("tube_in").tubeEndCaps && entry.deckCollision);

console.log(fail === 0 ? "\nAll tube end-cap checks passed." : `\n${fail} check(s) FAILED.`);
process.exit(fail === 0 ? 0 : 1);
