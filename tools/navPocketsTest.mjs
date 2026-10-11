// NAV POCKETS — the guarantees behind "men never get trapped in a village" (2026-10-12, you: a squad's
// men stuck in a walled yard, "this should never ever happen"; 345 sealed pockets measured on the Aurès).
// On a flat 200 m world, a YARD closed by a house and three walls (the mechta's layout):
//   1. the yard is SEALED (blocked for everyone — sealPockets), the lane beside it is not;
//   2. a formation spot INSIDE the yard comes back as reachable ground (nearestReachable, CoH's trick),
//      near the yard; a spot in open ground comes back EXACTLY;
//   3. a yard closed only by WIRE (no-foot) is sealed, and walkable again once the wire is cut;
//   4. a big enclosed area (over 600 m²) is real ground: never sealed.
import { createNavGrid } from "../games/shared-rts/navGrid.js";

let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && detail ? `\n      ${detail}` : ""}`);
  if (!ok) fail++;
};

const app = {
  worldSize: 200,
  getWorldHeight: () => 0,
  getWorldNormal: () => ({ x: 0, y: 1, z: 0 }),
  scene: { add() {}, remove() {} },
};
const nav = createNavGrid({ app, maxCellsPerSide: 100, minCell: 2 });
const foot = true;
const open = (x, z) => !nav.isBlockedAtWorld(x, z, foot);

// THE YARD: x -10..10, z 10..24 — the house along its south side (z 6..10), walls on west, east, north.
nav.addFootprint(0, 8, 12, 2);          // the house
nav.addFootprint(-11, 17, 1, 9);        // west wall
nav.addFootprint(11, 17, 1, 9);         // east wall
nav.addFootprint(0, 25, 12, 1);         // north wall
check("the yard's middle is sealed (no man can be sent or snapped there)", !open(0, 17));
check("the yard's corner is sealed too", !open(-8, 22));
check("the lane south of the house is open", open(0, 2));
check("open ground beside the yard is open", open(20, 17));
check("some cells were sealed", nav.sealedPockets > 0, `sealedPockets ${nav.sealedPockets}`);

// THE FORMATION SPOT (CoH): from the squad's spot in the lane, a man's spot inside the yard.
const fix = nav.nearestReachable(0, 2, 0, 17, { foot });
check("a spot in the yard comes back as reachable ground", !!fix && open(fix.x, fix.z), JSON.stringify(fix));
check("…not inside the yard", !!fix && !(Math.abs(fix.x) < 10 && fix.z > 10 && fix.z < 24), JSON.stringify(fix));
check("…and near it (within 20 m)", !!fix && Math.hypot(fix.x, fix.z - 17) < 20, JSON.stringify(fix));
const same = nav.nearestReachable(0, 2, 30, -20, { foot });
check("a spot in open ground comes back exactly", !!same && same.x === 30 && same.z === -20, JSON.stringify(same));

// WIRE: a yard closed on its open side by barbed wire only (no-foot) — sealed; cut — open again.
nav.addFootprint(-40, 8, 8, 1);         // a house
nav.addFootprint(-49, 15, 1, 8);        // west wall
nav.addFootprint(-31, 15, 1, 8);        // east wall
const wire = nav.addFootprint(-40, 23, 8, 1, 0, { noFoot: true });
check("a yard closed by wire is sealed", !open(-40, 15));
nav.clearNoFootFootprint(wire);
check("…and walkable again once the wire is cut", open(-40, 15));

// A BIG enclosure (30 × 30 m = 900 m²): real ground, never sealed.
nav.addFootprint(60, 40, 16, 1);
nav.addFootprint(60, 72, 16, 1);
nav.addFootprint(44, 56, 1, 16);
nav.addFootprint(76, 56, 1, 16);
check("a big enclosed field (900 m²) is not sealed", open(60, 56));

console.log(fail ? `\n${fail} failed` : "\nall passed");
process.exit(fail ? 1 : 0);
