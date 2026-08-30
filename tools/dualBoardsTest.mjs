// Dual boards — a bridge you straddle. Left wheels on one plank, right on the
// other, void under the belly. That claim dies if the gap grows past the car's
// track (you fall in) or a board grows wide enough to hold the whole car
// (you just pick a side). Both are numbers, so both are asserted here.
//
// Wheel rays:
//   through the gap          → nothing (belly over void)
//   at each wheel track      → y = 0 (you are on both boards)
//   past an outer edge       → nothing (you fall off the side)
import * as THREE from "three";

const {
  PIECE_BY_ID, pieceParams, roadParams, buildDualDeckGeometry,
} = await import(new URL("../games/modular-road-v3/modularRoadKit.js", import.meta.url).href);
const { CATEGORY_PRESETS } = await import(
  new URL("../games/modular-road-v3/modularRoadBuilder.js", import.meta.url).href);

let fail = 0;
const check = (n, c, d = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`);
  if (!c) fail++;
};

const def = PIECE_BY_ID.get("dual");
const tile = CATEGORY_PRESETS.straight.find((t) => t.id === "dual_boards");
const PP = { ...pieceParams, ...(tile?.params ?? {}) };
const RP = roadParams;
const L = PP.dualLength;
const HW = PP.dualWidth / 2;
const GAP = PP.dualGap;
const INNER = GAP / 2;
const BOARD = (PP.dualWidth - GAP) / 2;
const CZ = -L / 2;
const HALF_TRACK = 0.92; // WHEEL_LAYOUT.halfTrack
const TRACK = HALF_TRACK * 2;

console.log("— piece definition —");
check("dual is in the catalog", !!def);
check("it authors its own geometry (a split deck is not a sweep)",
  typeof def?.geometry === "function");
check("it does NOT hand the BVH a solid stand-in — the gap is the point",
  !def?.deckCollision);
check("no kerbs or rails (they would turn the drop into a cage)",
  def?.noKerb === true);
check("Straight tab has a Dual boards tile", tile?.base === "dual");

console.log("\n— sizes: a bridge you straddle, not a canyon you pick a side of —");
check(`the gap is narrower than the car's track (${GAP} m < ${TRACK.toFixed(2)} m)`,
  GAP < TRACK - 0.3);
check(`each board is too narrow to hold the whole car (${BOARD.toFixed(2)} m < ${TRACK.toFixed(2)} m)`,
  BOARD < TRACK);
check("a centred wheel lands on a plank, not in the gap",
  HALF_TRACK > INNER && HALF_TRACK < INNER + BOARD,
  `wheel at ${HALF_TRACK} m, board ${INNER.toFixed(2)}–${(INNER + BOARD).toFixed(2)} m`);

console.log("\n— a wheel ray finds road on a plank and void everywhere else —");
const geo = buildDualDeckGeometry(PP, RP);
const meshOf = (g) => { const m = new THREE.Mesh(g); m.updateMatrixWorld(true); return m; };
const ray = new THREE.Raycaster();
const down = new THREE.Vector3(0, -1, 0);
const dropAt = (x, z) => {
  ray.set(new THREE.Vector3(x, 6, z), down);
  const hit = ray.intersectObject(meshOf(geo), false)[0];
  return hit ? hit.point.y : null;
};
const close = (a, b, eps = 1e-4) => Math.abs(a - b) < eps;

check("the gap is empty (void under the belly)",
  dropAt(0, CZ) === null);
check("left wheel track is on the left plank",
  close(dropAt(-HALF_TRACK, CZ) ?? NaN, 0));
check("right wheel track is on the right plank",
  close(dropAt(HALF_TRACK, CZ) ?? NaN, 0));
check("past the left outer edge is void",
  dropAt(-(HW + 0.5), CZ) === null);
check("past the right outer edge is void",
  dropAt(HW + 0.5, CZ) === null);
check("the gap is empty near the entry too",
  dropAt(0, -2) === null);

console.log("");
if (fail) {
  console.log(`${fail} FAIL`);
  process.exit(1);
}
console.log("all passed");
