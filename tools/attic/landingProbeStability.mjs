// Diagnostic: is the landing assist aiming at the RIGHT SURFACE?
//
// The predictive alignment picks its target from a SINGLE ray cast from the
// chassis origin along the velocity vector (`_castGround(body.pos, _landDir,
// airLandRange)`). Whatever that ray hits becomes the attitude the car is
// rotated toward, at up to 32 kN·m.
//
// On flat ground that is unambiguous. On a real track it is not: the ray can
// graze a guardrail, catch the deck's end face or side, or skip between the
// road and whatever is beyond it as the car descends. Each time it does, the
// TARGET STEPS — and a discontinuous target under a large torque is the
// ugliest possible version of "a magnet repositioned the car", because the
// destination itself teleports.
//
// This flies real track geometry (deck + rails from the actual piece builder)
// and reports how stable the target normal is during the descent:
//   • jumps   — consecutive-tick changes in the target normal above 5°
//   • worst   — the largest single-tick change
//   • tilt    — how far the final target sits from world up
// A clean descent should show 0 jumps and a target within a degree of vertical.
//
// An instrument, not a pass/fail test.
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { buildTrack, DECK_TOP } from "../chassisCollisionTest.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const TMP = join(ROOT, `.landprobe.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, FIXED_DT } = await import(pathToFileURL(TMP).href);
unlinkSync(TMP);
const R2D = 57.2958;

// This module makes its OWN copy of the vehicle, so it needs its own headless
// mesh stub — the one chassisCollisionTest installs is on a different copy.
Vehicle.prototype._buildMeshes = function () {
  this.group = new THREE.Group(); this.chassisMesh = new THREE.Object3D();
  this.tireGroups = this.tires.map(() => new THREE.Group());
  this.arrowGroup = new THREE.Group(); this.arrowGroup.visible = false;
  this.arrows = this.tires.map(() => ({})); this.wheelSpin = [0, 0, 0, 0];
  this.headlights = []; this.headlightTargets = []; this.headlamps = []; this.taillights = [];
  this._wheelInstances = []; this._wheelParts = [];
};
Vehicle.prototype._updateTaillights = function () {};
Vehicle.prototype._syncWheelInstances = function () {};

const track = buildTrack(14);

function fly({ x = 0, h = 10, vz = -30, vy = 2, tilt = 0 }) {
  const car = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  car.setBvh(track.deck, track.solids);
  car.getFloorY = () => -50;
  car.enabled = true;
  // Pieces run toward -Z from the origin, so the car flies down-track.
  car.body.pos.set(x, DECK_TOP + h, -6);
  car.body.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
  if (tilt) {
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), tilt / R2D);
    car.body.quat.multiply(q);
  }
  car.body.vel.set(0, vy, vz);
  car.body.angVel.set(0, 0, 0);
  car._resetInterpolation();
  for (const t of car.tires) t._hadGround = false;
  car._airTime = 0.2; car._rackAirTime = 0.2;

  const prev = new THREE.Vector3();
  const cur = new THREE.Vector3();
  let have = false, jumps = 0, worst = 0, samples = 0, finalTilt = 0;

  for (let i = 0; i < 600; i++) {
    car.tick({ steerTarget: 0, rollTarget: 0, throttle: 0, handbrake: false, yaw: 0, pitch: 0 });
    const airborne = car.groundedCount === 0;
    const eng = car._landEngage ?? 0;
    if (airborne && eng > 0.001) {
      cur.copy(car._landN);
      if (cur.lengthSq() > 1e-6) {
        cur.normalize();
        samples++;
        finalTilt = Math.acos(Math.min(1, Math.max(-1, cur.y))) * R2D;
        if (have) {
          const d = Math.acos(Math.min(1, Math.max(-1, cur.dot(prev)))) * R2D;
          if (d > worst) worst = d;
          if (d > 5) jumps++;
        }
        prev.copy(cur); have = true;
      }
    }
    if (car._isSupported()) break;
  }
  return { jumps, worst, samples, finalTilt, endX: car.body.pos.x };
}

// Half road width, so "edge" and "over the rail" are real positions.
console.log("Landing probe stability on REAL track geometry (deck + guardrails)\n");
console.log("case                        | samples | jumps>5° | worst step | target tilt");
const cases = [
  ["centre of the road",       { x: 0 }],
  ["off-centre 2 m",           { x: 2 }],
  ["near the edge 3.4 m",      { x: 3.4 }],
  ["right on the rail line",   { x: 3.9 }],
  ["outside the rail 4.3 m",   { x: 4.3 }],
  ["centre, rolled 30°",       { x: 0, tilt: 30 }],
  ["centre, shallow & fast",   { x: 0, h: 4, vz: -50, vy: 0 }],
  ["edge, shallow & fast",     { x: 3.4, h: 4, vz: -50, vy: 0 }],
];
for (const [name, cfg] of cases) {
  const r = fly(cfg);
  console.log(
    `${name.padEnd(27)} | ${String(r.samples).padStart(7)}`
    + ` | ${String(r.jumps).padStart(8)}`
    + ` | ${r.worst.toFixed(1).padStart(9)}°`
    + ` | ${r.finalTilt.toFixed(1).padStart(10)}°`,
  );
}
console.log(`
jumps>5°   = ticks where the AIM point moved more than 5°, i.e. the target teleported
worst step = biggest single-tick change in the target normal
target tilt= how far the final target sat from world up (a flat road should be ~0°)`);
