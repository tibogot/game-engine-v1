// THE BARREL ROLL: is `twist` a piece, or a trap?
//
// It is fully built — 3840 tris, a `roll` function, end tangents, a params
// entry — and it is in NO palette tab. Before wiring one up, the question that
// decides whether it can BE a tile: can the car drive it?
//
// The physics says no, and says why. `twistPoints` is a dead-straight
// centreline:
//
//     for (i) pts.push(new V3(0, 0, -L * (i / n)));
//
// with a 360° roll laid on top. A LOOP holds you upside down because the ring
// is curved — the path's centripetal acceleration is what presses you into the
// deck, and v²/R is why loops have an entry-speed requirement. A straight path
// has R = infinity, so that term is exactly zero at every speed. Once the deck
// passes vertical there is nothing but gravity, and gravity does not care how
// fast you were going.
//
// That is a prediction with a signature: the car should come off at ~90° of
// roll, at EVERY speed, and going faster should not help. Speed changes WHERE
// along the piece you fall off (you cover more ground first), not WHETHER. This
// measures that, on the real kit geometry through the real Vehicle — the same
// path halfTubeAirMeshRepro uses — because "I reasoned about it" is not a
// finding and a shipped undrivable tile is worse than a missing one.
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = join(ROOT, `.twist.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, WHEEL, FIXED_DT, SURFACE_GRIP } = await import(pathToFileURL(TMP).href);
unlinkSync(TMP);

const { buildPiece, pieceParams, initialConnector } =
  await import(new URL("../games/modular-road-v3/modularRoadKit.js", import.meta.url).href);
const { RoadBvh } = await import(new URL("../v3/play/modularRoadBvh.js", import.meta.url).href);
const { createVehicleGround } = await import(new URL("../v3/play/modularRoadGround.js", import.meta.url).href);

Vehicle.prototype._buildMeshes = function () {
  this.group = new THREE.Group(); this.chassisMesh = new THREE.Object3D();
  this.tireGroups = [0, 0, 0, 0].map(() => new THREE.Group());
  this.arrowGroup = new THREE.Group(); this.arrowGroup.visible = false;
  this.arrows = [0, 0, 0, 0].map(() => ({})); this.wheelSpin = [0, 0, 0, 0];
  this.headlights = []; this.headlightTargets = []; this.headlamps = []; this.taillights = [];
  this._wheelInstances = []; this._wheelParts = [];
};
Vehicle.prototype._updateTaillights = function () {};

const LEAD = 40; // flat run-up, so the car arrives settled and at speed

/**
 * straight (LEAD) → the piece under test → straight (40), baked as one BVH.
 * No terrain: the floor is a long way down, so "came off" is unambiguous.
 */
function makeRun(id, params) {
  let conn = initialConnector();
  const meshes = [];
  let entryZ = null;
  for (const [pieceId, pp] of [
    ["straight", { straightLength: LEAD }],
    [id, params],
    ["straight", { straightLength: 40 }],
  ]) {
    const built = buildPiece(pieceId, conn.clone(), { ...pieceParams, ...pp });
    if (pieceId === id) entryZ = new THREE.Vector3().setFromMatrixPosition(built.world).z;
    const m = new THREE.Mesh(built.deckCollision ?? built.geometry);
    m.applyMatrix4(built.world);
    m.updateMatrixWorld(true);
    meshes.push(m);
    conn = built.connectorOut;
  }
  const bvh = new RoadBvh();
  bvh.bakeFromMeshes(meshes);
  const g = createVehicleGround({ getTerrainHeight: () => -1e4 });
  g.setRoadBvh(bvh.baked ? bvh : null);
  return { g, entryZ, tris: bvh.triCount };
}

/**
 * Drive in at `speed` and report where contact was FIRST lost inside the piece.
 *
 * "First" matters and "deepest" is a trap. The deck rolls a full 360°, so it
 * comes back under you: a car that falls off at 140° can land on the deck again
 * at 300°, and a naive high-water mark then reports 300° as if it had been
 * carried round. It also has to be measured INSIDE the piece — run the clock
 * long enough and every car eventually drives off the far end of the road, which
 * is what made the first version of this file's own control fail.
 */
function drive({ run, speed, length, turns = 1, secs = 6 }) {
  const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  c.groundBvh = run.g.ground;
  c.solidsBvh = run.g.solids;
  c.getFloorY = () => -1e4;
  c.enabled = true;
  c.body.pos.set(0, WHEEL.radius + 0.18, -4);
  c.body.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI); // nose down -Z
  c.body.vel.set(0, 0, -speed);
  c.body.angVel.set(0, 0, 0);

  const n = Math.round(secs / FIXED_DT);
  let offAtRoll = null;   // deck roll the first time contact was lost, inside the piece
  let carriedTo = 0;      // roll actually reached with UNBROKEN contact
  let exitRoll = 0;       // furthest into the piece the car got at all
  let enteredPiece = false;
  let deckY = 0;          // the deck's own height, to tell "fell off" from "still on"
  for (let i = 0; i < n; i++) {
    c.tick({ steerTarget: 0, throttle: 1, handbrake: false, yaw: 0, pitch: 0 });
    const u = (run.entryZ - c.body.pos.z) / length;
    if (u < 0 || u > 1) continue;
    enteredPiece = true;
    const rollDeg = 360 * turns * u;
    exitRoll = Math.max(exitRoll, rollDeg);
    /*
     * DRIVING, not merely touching. `groundedCount > 0` alone is not the
     * question, and trusting it is what made an early version of this file
     * report a 52 m run as reaching 229° — past inverted, which would have been
     * a remarkable result. Tracing that run frame by frame showed what it
     * actually was:
     *
     *     roll    x      y     grounded   car-up.y
     *      115°   1.82   1.74      3        0.084
     *      141°   3.24   1.49      3       -0.379
     *      179°   6.12  -0.40      4       -0.825
     *      192°   7.28  -1.79      3       -0.747
     *      230°   7.34  -7.36      0       -0.693
     *
     * The car is upright and tracking the deck to ~115°. After that its own up
     * vector is BELOW horizontal and x climbs monotonically out to the plate's
     * 7.25 m half-width — it is sliding down the tilting deck and off the low
     * edge, catching wheel rays the whole way, and from 230° it is in free fall.
     * A slide off the edge is not a barrel roll.
     *
     * So: on the plate (the centreline is straight and the deck rotates about
     * it, so the deck sweeps a cylinder of the road's half-width about the axis)
     * AND still the right way up.
     */
    const HW = 14.5 / 2;
    const carUpY = new THREE.Vector3(0, 1, 0).applyQuaternion(c.body.quat).y;
    const onDeck = Math.hypot(c.body.pos.x, c.body.pos.y) < HW && carUpY > 0;
    if (offAtRoll === null) {
      if (c.groundedCount > 0 && onDeck) carriedTo = rollDeg;
      else { offAtRoll = rollDeg; deckY = c.body.pos.y; }
    }
  }
  return { offAtRoll, carriedTo, exitRoll, deckY, endY: c.body.pos.y, enteredPiece,
    completed: enteredPiece && offAtRoll === null && exitRoll > 355 * turns };
}

let fail = 0;
const ok = (cond, label, detail = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
  if (!cond) fail++;
};

console.log("\n=== CONTROL: the same harness, same distance, over a plain straight ===");
{
  const run = makeRun("straight", { straightLength: 26 });
  const r = drive({ run, speed: 30, length: 26 });
  ok(r.completed, "a flat straight is crossed with unbroken contact",
    `carried the full length, never lost the deck`);
}

console.log("\n=== THE BARREL ROLL, ACROSS A BAND OF SPEEDS ===");
console.log("  \"Carried to\" = the deck roll the car reached still UPRIGHT and still on");
console.log("  the plate. 90° is the deck vertical, 180° a ceiling, 360° completes it.\n");
console.log("   speed   carried to   came off at   ended at");
const rolls = [];
for (const speed of [20, 30, 40, 50, 60, 70]) {
  const run = makeRun("twist", { twistLength: 26, twistTurns: 1 });
  const r = drive({ run, speed, length: 26 });
  rolls.push(r.carriedTo);
  console.log(
    `   ${String(speed).padStart(4)}   ${r.carriedTo.toFixed(0).padStart(9)}°`
    + `   ${(r.offAtRoll === null ? "never" : r.offAtRoll.toFixed(0) + "°").padStart(11)}`
    + `   ${r.endY.toFixed(0).padStart(6)} m`,
  );
}
const worst = Math.max(...rolls);
ok(worst < 180, "no speed carries the car past the deck going vertical",
  `best was ${worst.toFixed(0)}° with unbroken contact — a full roll needs 360°`);
// The signature of "no centripetal term": more speed does not buy more roll.
ok(Math.max(...rolls) - Math.min(...rolls) < 60,
  "and going faster does not help — the limit is not about speed",
  `${Math.min(...rolls).toFixed(0)}°–${worst.toFixed(0)}° across 20–70 m/s`);

console.log("\n=== DOES A LONGER, SLOWER ROLL HELP? ===");
console.log("  If the problem were roll RATE, stretching the piece would fix it.\n");
console.log("   length   roll rate   carried to   came off at");
const byLen = [];
for (const length of [26, 52, 104, 200]) {
  const run = makeRun("twist", { twistLength: length, twistTurns: 1 });
  const r = drive({ run, speed: 40, length, secs: 14 });
  byLen.push(r.carriedTo);
  console.log(
    `   ${String(length).padStart(5)} m   ${(360 / (length / 40)).toFixed(0).padStart(7)}°/s`
    + `   ${r.carriedTo.toFixed(0).padStart(9)}°`
    + `   ${(r.offAtRoll === null ? "never" : r.offAtRoll.toFixed(0) + "°").padStart(11)}`,
  );
}
ok(Math.max(...byLen) < 180, "no length gets it round either — it is not the roll rate",
  `best ${Math.max(...byLen).toFixed(0)}° over lengths 26–200 m`);

console.log(
  fail === 0
    ? "\nCONFIRMED: `twist` cannot be driven. A straight centreline has no\n"
      + "centripetal term, so past vertical there is nothing holding the car on,\n"
      + "at any speed and any length. It is geometry, not a tile.\n"
    : `\n${fail} EXPECTATION(S) NOT MET — re-read the numbers above before acting.\n`,
);
process.exit(fail === 0 ? 0 : 1);
