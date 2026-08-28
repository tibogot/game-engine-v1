// ============================================================================
// WHAT ACTUALLY HAPPENS WHEN YOU HIT SOMETHING?
//
// The player's report: "this car doesn't have collision physics — it should be
// stable, the assist is cool for a stunt game, BUT shouldn't we have a crash?
// Barrel, flip, the way most games do."
//
// A CRASH block already exists (crash yield: assists go quiet, restitution and
// spin go up). This measures whether it ever actually engages, and what the car
// does when it does. Not pass/fail — an instrument. Read the table.
//
//   node tools/crashResponseRepro.mjs
// ============================================================================
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "v3/play/modularRoadVehicle.js");
const TMP = join(ROOT, `.crashRepro.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(SRC, "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));

const { Vehicle, FIXED_DT, CRASH, SOLID, TIRE } = await import(pathToFileURL(TMP).href);
const { RoadBvh } = await import(pathToFileURL(join(ROOT, "v3/play/modularRoadBvh.js")).href);
const { buildPiece, roadParams } = await import(pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadKit.js")).href);
unlinkSync(TMP);

Vehicle.prototype._buildMeshes = function () {
  this.group = new THREE.Group();
  this.chassisMesh = new THREE.Object3D();
  this.tireGroups = this.tires.map(() => new THREE.Group());
  this.arrowGroup = new THREE.Group();
  this.arrowGroup.visible = false;
  this.arrows = this.tires.map(() => ({}));
  this.wheelSpin = [0, 0, 0, 0];
  this.headlights = []; this.headlightTargets = []; this.headlamps = []; this.taillights = [];
  this._wheelInstances = []; this._wheelParts = [];
};
Vehicle.prototype._updateTaillights = function () {};

console.log("=== the knobs ===");
console.log(`  CRASH.enabled ${CRASH.enabled}  wallSpeed ${CRASH.wallSpeed}  hold ${CRASH.hold}s`);
console.log(`  while yielded: restitution ${CRASH.restitution} spin ${CRASH.spin} maxSpin ${CRASH.maxSpin}`);
console.log(`  otherwise:     restitution ${SOLID.restitution} spin ${SOLID.spin} maxSpin ${SOLID.maxSpin}`);
console.log(`  recovery clears the yield at ${CRASH.recoverWheels} wheels + up.y > ${CRASH.recoverUp}`);
console.log(`  stabilizer ${TIRE.stabilizerStrength} / damp ${TIRE.stabilizerDamp}\n`);

/** Straight track + the guardrail as the thing to hit. */
let conn = new THREE.Matrix4();
const deckGeos = [], solidGeos = [];
for (let i = 0; i < 8; i++) {
  const p = buildPiece("straight", conn);
  const g = p.geometry.clone(); g.applyMatrix4(p.world); deckGeos.push(g);
  const proxy = p.railCollision ?? p.railGeometry;
  if (proxy) { const r = proxy.clone(); r.applyMatrix4(p.world); solidGeos.push(r); }
  conn = p.connectorOut;
}
const mk = (geos) => {
  const bvh = new RoadBvh();
  const meshes = geos.map((g) => new THREE.Mesh(g, new THREE.MeshBasicMaterial()));
  for (const m of meshes) m.updateMatrixWorld(true);
  bvh.bakeFromMeshes(meshes);
  return bvh;
};
const deck = mk(deckGeos), solids = mk(solidGeos);
const hw = roadParams.width / 2;
const railX = hw - Math.min(Math.max(0, roadParams.railWidth), hw * 0.45) * 0.5;

const up = new THREE.Vector3();
const fwd = new THREE.Vector3();

/**
 * Drive into the right-hand rail at `angleDeg` and watch the response.
 * Reports what a player would actually see: did it spin, did it roll, did the
 * crash state ever engage, and for how long.
 */
function hit({ speed, angleDeg, secs = 5 }) {
  const car = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  car.setBvh(deck, solids);
  car.getFloorY = () => -50;
  car.enabled = true;
  const a = (angleDeg * Math.PI) / 180;
  car.body.pos.set(railX - 5, 0.55, -20);
  car.body.vel.set(speed * Math.sin(a), 0, -speed * Math.cos(a));
  car.body.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI - a);

  let yieldTicks = 0, peakYield = 0, minUpY = 1;
  let rollRate = 0, pitchRate = 0, yawRate = 0, flipped = false;
  const right = new THREE.Vector3();
  const n = Math.round(secs / FIXED_DT);
  for (let i = 0; i < n; i++) {
    car.tick({ steerTarget: 0, throttle: 0, handbrake: false, yaw: 0, pitch: 0 });
    if (car.crashYield > 0) yieldTicks++;
    peakYield = Math.max(peakYield, car.crashYield);
    up.set(0, 1, 0).applyQuaternion(car.body.quat);
    fwd.set(0, 0, 1).applyQuaternion(car.body.quat);
    right.set(1, 0, 0).applyQuaternion(car.body.quat);
    // Split the spin by CHASSIS axis — a barrel roll is roll, a spin-out is yaw,
    // and "peak angular speed" cannot tell them apart.
    rollRate = Math.max(rollRate, Math.abs(car.body.angVel.dot(fwd)));
    pitchRate = Math.max(pitchRate, Math.abs(car.body.angVel.dot(right)));
    yawRate = Math.max(yawRate, Math.abs(car.body.angVel.dot(up)));
    minUpY = Math.min(minUpY, up.y);
    if (up.y < 0) flipped = true;
    if (car.body.pos.y < -10) break;
  }
  return {
    endSpeed: car.body.vel.length(),
    yieldTime: yieldTicks * FIXED_DT,
    peakYield, rollRate, pitchRate, yawRate, minUpY, flipped,
  };
}

console.log("=== driving into the guardrail ===");
console.log("  angle  speed | end spd  crash  held   roll   pitch    yaw   min up.y  flipped");
for (const angleDeg of [90, 55, 30, 15]) {
  for (const speed of [20, 30, 45, 60]) {
    const r = hit({ speed, angleDeg });
    console.log(
      `  ${String(angleDeg).padStart(5)}° ${String(speed).padStart(5)} |`
      + ` ${r.endSpeed.toFixed(1).padStart(7)}  ${(r.peakYield > 0 ? "YES" : "no ").padStart(5)}`
      + ` ${r.yieldTime.toFixed(2).padStart(5)}s ${r.rollRate.toFixed(2).padStart(6)}`
      + `  ${r.pitchRate.toFixed(2).padStart(6)} ${r.yawRate.toFixed(2).padStart(6)}`
      + `   ${r.minUpY.toFixed(2).padStart(7)}  ${r.flipped ? "YES" : "no"}`,
    );
  }
}

console.log("\n  roll / pitch / yaw are peak rad/s about the CHASSIS axes. A barrel");
console.log("  roll is ROLL; a spin-out is YAW. min up.y is how far over it ever got");
console.log("  (1.00 = never leaned, −1.00 = fully inverted).");

/**
 * SLIDING SIDEWAYS INTO IT — the case a rollover actually comes from.
 *
 * The car keeps its nose down the road and carries a lateral component into the
 * barrier, which is what a spun or drifting car does. Above, a square hit simply
 * stops the car, so there is no slide left to trip over.
 */
function slide({ along, lateral, secs = 5 }) {
  const car = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  car.setBvh(deck, solids);
  car.getFloorY = () => -50;
  car.enabled = true;
  car.body.pos.set(railX - 3, 0.55, -20);
  car.body.vel.set(lateral, 0, -along);
  car.body.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI); // nose down the road

  let rollRate = 0, minUpY = 1, yieldTicks = 0, flipped = false;
  const n = Math.round(secs / FIXED_DT);
  for (let i = 0; i < n; i++) {
    car.tick({ steerTarget: 0, throttle: 0, handbrake: false, yaw: 0, pitch: 0 });
    if (car.crashYield > 0) yieldTicks++;
    up.set(0, 1, 0).applyQuaternion(car.body.quat);
    fwd.set(0, 0, 1).applyQuaternion(car.body.quat);
    rollRate = Math.max(rollRate, Math.abs(car.body.angVel.dot(fwd)));
    minUpY = Math.min(minUpY, up.y);
    if (up.y < 0) flipped = true;
    if (car.body.pos.y < -10) break;
  }
  return { rollRate, minUpY, flipped, yieldTime: yieldTicks * FIXED_DT };
}

/**
 * CLIPPING IT IN THE AIR — where a stunt track's flips really come from.
 *
 * No wheels on anything, so there is nothing to trip over and nothing holding
 * the car flat either: the response's own off-centre torque is free to tumble
 * it, provided the airborne controller is not settling the rotation away.
 */
function airClip({ along, lateral, drop, secs = 6 }) {
  const car = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  car.setBvh(deck, solids);
  car.getFloorY = () => -50;
  car.enabled = true;
  car.body.pos.set(railX - 2.5, 2.0, -20);
  car.body.vel.set(lateral, drop, -along);
  car.body.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);

  let rollRate = 0, minUpY = 1, yieldTicks = 0, flips = 0, wasUp = true;
  const n = Math.round(secs / FIXED_DT);
  for (let i = 0; i < n; i++) {
    car.tick({ steerTarget: 0, throttle: 0, handbrake: false, yaw: 0, pitch: 0 });
    if (car.crashYield > 0) yieldTicks++;
    up.set(0, 1, 0).applyQuaternion(car.body.quat);
    fwd.set(0, 0, 1).applyQuaternion(car.body.quat);
    rollRate = Math.max(rollRate, Math.abs(car.body.angVel.dot(fwd)));
    minUpY = Math.min(minUpY, up.y);
    // Count inversions rather than a single flag — a barrel roll passes through
    // upside-down once per revolution.
    if (wasUp && up.y < -0.3) { flips++; wasUp = false; }
    if (!wasUp && up.y > 0.3) wasUp = true;
    if (car.body.pos.y < -10) break;
  }
  return { rollRate, minUpY, flips, yieldTime: yieldTicks * FIXED_DT };
}

console.log("\n=== clipping the guardrail AIRBORNE ===");
console.log("  along  lateral  drop | yield held  peak roll  min up.y  inversions");
for (const along of [25, 45, 65]) {
  for (const lateral of [5, 12]) {
    for (const drop of [0, -8]) {
      const r = airClip({ along, lateral, drop });
      console.log(
        `  ${String(along).padStart(5)} ${String(lateral).padStart(8)} ${String(drop).padStart(5)} |`
        + ` ${r.yieldTime.toFixed(2).padStart(9)}s  ${r.rollRate.toFixed(2).padStart(9)}`
        + `  ${r.minUpY.toFixed(2).padStart(8)}  ${String(r.flips).padStart(10)}`,
      );
    }
  }
}

console.log("\n=== sliding sideways into the guardrail (nose down the road) ===");
console.log("  along  lateral | yield held  peak roll  min up.y  onto its side  flipped");
for (const along of [20, 40, 60]) {
  for (const lateral of [6, 12, 20]) {
    const r = slide({ along, lateral });
    console.log(
      `  ${String(along).padStart(5)} ${String(lateral).padStart(8)} |`
      + ` ${r.yieldTime.toFixed(2).padStart(9)}s  ${r.rollRate.toFixed(2).padStart(9)}`
      + `  ${r.minUpY.toFixed(2).padStart(8)}  ${(r.minUpY < 0.3 ? "YES" : "no").padStart(13)}`
      + `  ${r.flipped ? "YES" : "no"}`,
    );
  }
}
