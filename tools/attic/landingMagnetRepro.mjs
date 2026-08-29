// Diagnostic: does the landing assist act on landings that never needed it?
//
// Reported symptom: on a PLAIN jump — no roll input — the car visibly re-poses
// itself in the last part of the fall, "like a magnet". That is the predictive
// landing alignment (TIRE.airLandTorque / airLandDamp): it engages purely on
// time-to-impact, so a car arriving 5° off gets the same 32 kN·m authority as
// one arriving 70° off mid-barrel-roll.
//
// This measures the magnet directly: launch identical jumps with a small
// residual tilt / roll rate (what a real ramp edge leaves) and NO input, and
// report how much the car's attitude changes IN THE AIR — any in-air change on
// an input-free jump is the assist's doing, nothing else touches roll there.
// The barrel-roll cases are the regression guard: those MUST keep the assist.
//
// An instrument, not a pass/fail test.
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const TMP = join(ROOT, `.landmagnet.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, FIXED_DT } = await import(pathToFileURL(TMP).href);
unlinkSync(TMP);
const R2D = 57.2958;

const ground = {
  baked: true,
  raycastFirst(o, d, far) {
    if (d.y >= -1e-6) return null;
    const t = o.y / -d.y;
    if (t < 0 || t > far) return null;
    return { point: { x: o.x + d.x * t, y: 0, z: o.z + d.z * t }, distance: t, faceIndex: 0, normal: { x: 0, y: 1, z: 0 } };
  },
  spherecast() { return null; },
  closestPointWithNormal() { return null; },
};
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

const _up = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
// ROLL, not total tilt — total tilt would count the arc assist's intended
// nose-down pitch as "magnet". Same decomposition as the game's debug readout.
const tiltDeg = (q) => {
  _up.set(0, 1, 0).applyQuaternion(q);
  _fwd.set(0, 0, 1).applyQuaternion(q);
  _right.crossVectors(_up, _fwd);
  return Math.abs(Math.atan2(_right.y, _up.y)) * R2D;
};
const headingDeg = (q) => {
  _fwd.set(0, 0, 1).applyQuaternion(q);
  return Math.atan2(_fwd.x, _fwd.z) * R2D;
};

/**
 * One jump. Launched directly (no ramp) so the initial tilt / roll rate is an
 * exact, controlled input. `rollFor` holds Z/X from launch; everything else is
 * dead-stick until 1.5 s after touchdown.
 */
function jump({ tilt0 = 0, rollRate0 = 0, roll = 0, rollFor = 0 }) {
  const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  c.groundBvh = ground; c.enabled = true;
  c.body.pos.set(0, 8, 0);
  c.body.quat.setFromAxisAngle(new THREE.Vector3(0, 0, 1), tilt0 / R2D);
  c.body.vel.set(0, 6, 30);
  c.body.angVel.set(0, 0, rollRate0);
  c._resetInterpolation();
  for (const t of c.tires) t._hadGround = false;
  // The car spawned airborne mid-"flight": mark it so the assist arms normally.
  c._airTime = 0.2; c._rackAirTime = 0.2; c._holdHeading = headingDeg(c.body.quat) / R2D;

  const launchTilt = tiltDeg(c.body.quat);
  const launchHead = headingDeg(c.body.quat);
  let t = 0, landed = -1, tiltAtLand = 0, maxAirTiltChange = 0;
  while (t < 6) {
    const rolling = roll !== 0 && t < rollFor;
    c.tick({ steerTarget: 0, rollTarget: rolling ? roll : 0, throttle: 0, handbrake: false, yaw: 0, pitch: 0 });
    t += FIXED_DT;
    if (landed < 0) {
      const airChange = Math.abs(tiltDeg(c.body.quat) - launchTilt);
      // Only meaningful on the input-free cases; during a commanded roll the
      // "change" is the trick itself.
      if (roll === 0) maxAirTiltChange = Math.max(maxAirTiltChange, airChange);
      if (c._isSupported()) { landed = t; tiltAtLand = tiltDeg(c.body.quat); }
    } else if (t - landed > 1.5) break;
  }
  return {
    landed,
    tiltAtLand,
    maxAirTiltChange,
    headDrift: ((headingDeg(c.body.quat) - launchHead + 540) % 360) - 180,
    slideX: Math.abs(c.body.pos.x),
    settledTilt: tiltDeg(c.body.quat),
  };
}

const cases = [
  ["clean jump (no tilt, no input)",          { }],
  ["6° residual tilt, NO input",              { tilt0: 6 }],
  ["12° residual tilt, NO input",             { tilt0: 12 }],
  ["0.4 rad/s roll rate, NO input",           { rollRate0: 0.4 }],
  ["held roll 0.6 s (barrel roll, released)", { roll: 1, rollFor: 0.6 }],
  ["held roll to the ground",                 { roll: 1, rollFor: 99 }],
];

console.log("case                                       | air Δtilt | tilt@land | settled | headΔ  | slideX");
for (const [name, cfg] of cases) {
  const r = jump(cfg);
  console.log(
    `${name.padEnd(42)} | ${r.maxAirTiltChange.toFixed(1).padStart(8)}° | ${r.tiltAtLand.toFixed(1).padStart(8)}° | ${r.settledTilt.toFixed(1).padStart(6)}° | ${r.headDrift.toFixed(1).padStart(5)}° | ${r.slideX.toFixed(2).padStart(5)} m`,
  );
}
console.log("\nair Δtilt on a NO-INPUT case = attitude the car changed by itself in flight (the magnet).");
