// Diagnostic: HOW FAST does the predictive landing alignment re-pose the car,
// and how much time did it actually have?
//
// The need gate (airLandErrDead/errFull, airLandRateDead/rateFull) decides
// WHETHER the assist acts. It does not decide how fast. The assist is a PD
// controller — P = airLandTorque * sin(err), D = airLandDamp * tiltRate — and
// `engage` scales BOTH, so it cancels out of the ratio: the steady slew rate is
// (airLandTorque / airLandDamp) * sin(err) whatever the gate says.
//
// That is why a small error reads as a magnet and a blown barrel roll reads as a
// save. Both are corrected at the same 5/s proportional slew, but a 12° error is
// gone in a couple of hundred ms while 60° takes long enough to look deliberate.
//
// This measures the two numbers that decide whether a correction is visible:
//   • peak rate  — deg/s the assist actually rotated the car at
//   • need rate  — deg/s that would have sufficed to be level BY TOUCHDOWN
// A correction running many times faster than "need rate" is doing in a blink
// what it had the whole descent to do.
//
// An instrument, not a pass/fail test.
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = join(ROOT, `.landrate.${process.pid}.mjs`);
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
    return {
      point: { x: o.x + d.x * t, y: 0, z: o.z + d.z * t },
      distance: t, faceIndex: 0, normal: { x: 0, y: 1, z: 0 },
    };
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
/** Roll only — the arc assist's intended nose-down pitch is not "re-posing". */
const rollDeg = (q) => {
  _up.set(0, 1, 0).applyQuaternion(q);
  _fwd.set(0, 0, 1).applyQuaternion(q);
  _right.crossVectors(_up, _fwd);
  return Math.atan2(_right.y, _up.y) * R2D;
};

function jump({ tilt0 = 0, rollRate0 = 0, roll = 0, rollFor = 0, vz = 30, vy = 6, h = 8 }) {
  const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  c.groundBvh = ground; c.enabled = true;
  c.body.pos.set(0, h, 0);
  c.body.quat.setFromAxisAngle(new THREE.Vector3(0, 0, 1), tilt0 / R2D);
  c.body.vel.set(0, vy, vz);
  c.body.angVel.set(0, 0, rollRate0);
  c._resetInterpolation();
  for (const t of c.tires) t._hadGround = false;
  c._airTime = 0.2; c._rackAirTime = 0.2;
  c._holdHeading = 0;

  let t = 0, landed = -1;
  let peakRate = 0;      // deg/s of roll change while the assist was engaged
  let peakEngage = 0;
  let errAtEngage = 0, ttiAtEngage = 0;
  let prevRoll = rollDeg(c.body.quat);

  while (t < 6) {
    const rolling = roll !== 0 && t < rollFor;
    c.tick({ steerTarget: 0, rollTarget: rolling ? roll : 0, throttle: 0, handbrake: false, yaw: 0, pitch: 0 });
    t += FIXED_DT;
    const r = rollDeg(c.body.quat);
    const rate = Math.abs(r - prevRoll) / FIXED_DT;
    prevRoll = r;

    const eng = c._landEngage ?? 0;
    // Only count rotation the ASSIST is responsible for: while it is engaged and
    // the player is not the one rolling the car.
    if (eng > 0.01 && !rolling) {
      if (eng > peakEngage) peakEngage = eng;
      if (rate > peakRate) peakRate = rate;
      if (errAtEngage === 0) {
        errAtEngage = Math.abs(r);
        // Ballistic time to the deck, the same closed form the assist uses.
        const vyNow = c.body.vel.y, drop = c.body.pos.y;
        ttiAtEngage = (vyNow + Math.sqrt(Math.max(0, vyNow * vyNow + 2 * 9.81 * drop))) / 9.81;
      }
    }
    if (landed < 0 && c._isSupported()) { landed = t; break; }
  }
  const needRate = ttiAtEngage > 0.01 ? errAtEngage / ttiAtEngage : 0;
  return { peakRate, peakEngage, errAtEngage, ttiAtEngage, needRate, landRoll: Math.abs(prevRoll) };
}

const cases = [
  ["clean jump, no input",           { }],
  ["6° residual tilt",               { tilt0: 6 }],
  ["12° residual tilt",              { tilt0: 12 }],
  ["20° residual tilt",              { tilt0: 20 }],
  ["0.4 rad/s roll rate (ramp lip)", { rollRate0: 0.4 }],
  ["barrel roll 0.6 s, released",    { roll: 1, rollFor: 0.6 }],
  ["barrel roll held to ground",     { roll: 1, rollFor: 99 }],
];

console.log("Landing alignment — how fast does it re-pose the car?\n");
console.log("case                           | err@engage |  tti | peak rate | need rate | excess | roll@land");
for (const [name, cfg] of cases) {
  const r = jump(cfg);
  const excess = r.needRate > 0.5 ? `${(r.peakRate / r.needRate).toFixed(1)}x` : "  —";
  console.log(
    `${name.padEnd(30)} | ${r.errAtEngage.toFixed(1).padStart(8)}°`
    + ` | ${r.ttiAtEngage.toFixed(2).padStart(4)}s`
    + ` | ${r.peakRate.toFixed(0).padStart(6)}°/s`
    + ` | ${r.needRate.toFixed(0).padStart(6)}°/s`
    + ` | ${excess.padStart(6)}`
    + ` | ${r.landRoll.toFixed(1).padStart(6)}°`,
  );
}
console.log(`
err@engage = roll error when the assist first took hold
tti        = ballistic seconds to the deck at that moment
peak rate  = fastest the assist actually rotated the car
need rate  = err/tti, i.e. the leisurely rate that still arrives level in time
excess     = peak/need. 1x reads as the car settling; 10x reads as a magnet.`);
