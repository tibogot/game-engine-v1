/**
 * Inverted landing on TERRAIN — the lid must rest on the dirt, not jitter
 * through it.
 *
 *   node tools/invertedTerrainTest.mjs
 *
 * The heightfield probe is a vertical projection. An inverted wheel origin
 * still "hits" it and the strut pushes into the world. This test is the
 * discriminator loops cannot provide: no road mesh, only getTerrainHeight.
 */
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { createVehicleGround } from "../v3/play/modularRoadGround.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = join(ROOT, `.invterr.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, DECK_CONTACT, FIXED_DT, STUCK } = await import(pathToFileURL(TMP).href);
unlinkSync(TMP);

Vehicle.prototype._buildMeshes = function () {
  this.group = new THREE.Group(); this.chassisMesh = new THREE.Object3D();
  this.tireGroups = [0, 0, 0, 0].map(() => new THREE.Group());
  this.arrowGroup = new THREE.Group(); this.arrowGroup.visible = false;
  this.arrows = [0, 0, 0, 0].map(() => ({})); this.wheelSpin = [0, 0, 0, 0];
  this.headlights = []; this.headlightTargets = []; this.headlamps = []; this.taillights = [];
  this._wheelInstances = []; this._wheelParts = [];
};
Vehicle.prototype._updateTaillights = function () {};
Vehicle.prototype._syncWheelInstances = function () {};

let fail = 0;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!cond) fail++;
};

function makeCar() {
  const ground = createVehicleGround({ getTerrainHeight: () => 0 });
  const car = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  car.setBvh(ground.ground, ground.solids);
  car.getFloorY = () => 0;
  car.enabled = true;
  return car;
}

function run({ quat, pos, vel, ticks = 360 }) {
  const car = makeCar();
  if (quat) car.body.quat.copy(quat);
  car.body.pos.copy(pos);
  car.body.vel.copy(vel);
  let minY = Infinity, nan = false, roofTicks = 0, maxGrounded = 0, peakStuck = 0;
  for (let i = 0; i < ticks; i++) {
    car.tick({ steerTarget: 0, throttle: 0, handbrake: false, yaw: 0 });
    const y = car.body.pos.y;
    if (!Number.isFinite(y) || !Number.isFinite(car.body.vel.y)) nan = true;
    minY = Math.min(minY, y);
    if (car.roofTouch) roofTicks++;
    maxGrounded = Math.max(maxGrounded, car.groundedCount);
    peakStuck = Math.max(peakStuck, car.stuckTime);
  }
  return {
    y: car.body.pos.y, vy: car.body.vel.y, minY, nan, roofTicks, maxGrounded,
    speed: car.body.vel.length(), peakStuck, beached: car.isBeached,
    upY: (() => {
      const u = new THREE.Vector3(0, 1, 0).applyQuaternion(car.body.quat);
      return u.y;
    })(),
  };
}

const INVERTED = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI);
const restY = DECK_CONTACT.roofY;

console.log("=== inverted drop onto flat terrain ===");
{
  const r = run({
    quat: INVERTED,
    pos: new THREE.Vector3(0, 4, 0),
    vel: new THREE.Vector3(0, -12, 0),
    ticks: Math.round(2.5 / FIXED_DT),
  });
  check("no NaN", !r.nan);
  check("never goes under the world", r.minY > -0.35,
    `min y ${r.minY.toFixed(2)}`);
  check("comes to rest on the lid", r.y > restY - 0.35 && r.y < restY + 0.45,
    `y ${r.y.toFixed(2)} vs roof height ${restY.toFixed(2)}`);
  check("vertical speed has died", Math.abs(r.vy) < 1.5,
    `vy ${r.vy.toFixed(2)} m/s`);
  check("the roof is reported as the contact", r.roofTicks > 10,
    `roofTouch on ${r.roofTicks} ticks`);
  check("inverted wheels do not drive the dirt", r.maxGrounded === 0,
    `peak groundedCount ${r.maxGrounded}`);
  check("stays on its lid", r.upY < -0.5,
    `chassis-up.y ${r.upY.toFixed(2)}`);
}

console.log("\n=== lid rest is not a stuck trap ===");
{
  const r = run({
    quat: INVERTED,
    pos: new THREE.Vector3(0, 4, 0),
    vel: new THREE.Vector3(0, -12, 0),
    ticks: Math.round(4 / FIXED_DT),
  });
  check("does not count as beached", !r.beached);
  check("never reaches the recover-to-ramp timer",
    r.peakStuck < STUCK.respawnAfter,
    `peak stuckTime ${r.peakStuck.toFixed(2)}s vs respawnAfter ${STUCK.respawnAfter}`);
  check("still on the lid after that wait", r.y > restY - 0.35 && r.upY < -0.5,
    `y ${r.y.toFixed(2)}, chassis-up.y ${r.upY.toFixed(2)}`);
}

console.log("\n=== upright drop still lands on the tyres ===");
{
  const r = run({
    pos: new THREE.Vector3(0, 3, 0),
    vel: new THREE.Vector3(0, -8, 0),
    ticks: Math.round(2 / FIXED_DT),
  });
  check("upright does not go under", r.minY > -0.2, `min y ${r.minY.toFixed(2)}`);
  check("upright rests near ride height", r.y > 0.25 && r.y < 1.2,
    `y ${r.y.toFixed(2)}`);
  check("upright wheels still find the ground", r.maxGrounded >= 3,
    `peak groundedCount ${r.maxGrounded}`);
}

console.log(fail ? `\n${fail} check(s) failed` : "\nall green");
process.exit(fail ? 1 : 0);
