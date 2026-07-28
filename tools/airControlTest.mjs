// EVERY air control still works — the regression guard this session needed and
// did not have.
//
// A heading hold was added to stop a barrel roll walking the car off its line.
// It was gated only on the YAW key, which broke the other two air controls
// outright: a FLIP reverses your heading legitimately (nose over tail), and the
// hold fought to drag it back, so Shift/Ctrl did nothing; and a Q/E spin handed
// the car back to a hold still aimed at the pre-spin heading, which yanked it
// round on landing.
//
// Roll, pitch and yaw are three separate controls and each has to survive the
// other two's assists. That is what this asserts.
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let fail = 0;
const check = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); if (!c) fail++; };
const R2D = 57.2958;

const TMP = join(ROOT, `.airctl.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, TIRE, FIXED_DT } = await import(pathToFileURL(TMP).href);
unlinkSync(TMP);

const ground = {
  baked: true,
  raycastFirst(o, d, far) {
    if (d.y >= -1e-6) return null;
    const t = o.y / -d.y;
    if (t < 0 || t > far) return null;
    return { point: { x: o.x, y: 0, z: o.z }, distance: t, faceIndex: 0, normal: { x: 0, y: 1, z: 0 } };
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

const _f = new THREE.Vector3();
const _up = new THREE.Vector3();
const _rt = new THREE.Vector3();

/** Fly with a held input and report how far each axis got. */
function fly({ steer = 0, pitch = 0, yaw = 0, secs = 1.6, speed = 40 } = {}) {
  const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  c.groundBvh = ground; c.enabled = true;
  c.body.pos.set(0, 300, 0);
  c.body.vel.set(0, 0, speed);
  c.body.quat.identity();
  c._airTime = 10;          // already armed: no ground contact has ever happened
  c._rackAirTime = 0;
  let roll = 0, pitchAcc = 0, yawAcc = 0, poseYaw = 0, prevHeading = 0;
  const n = Math.round(secs / FIXED_DT);
  for (let i = 0; i < n; i++) {
    _f.set(0, 0, 1).applyQuaternion(c.body.quat);
    _rt.set(1, 0, 0).applyQuaternion(c.body.quat);
    _up.set(0, 1, 0).applyQuaternion(c.body.quat);
    roll += c.body.angVel.dot(_f) * FIXED_DT * R2D;
    pitchAcc += c.body.angVel.dot(_rt) * FIXED_DT * R2D;
    yawAcc += c.body.angVel.dot(_up) * FIXED_DT * R2D;
    c.tick({ steerTarget: steer, throttle: 0, handbrake: false, yaw, pitch });
    _f.set(0, 0, 1).applyQuaternion(c.body.quat);
    const heading = Math.atan2(_f.x, _f.z);
    let dh = heading - prevHeading;
    while (dh > Math.PI) dh -= Math.PI * 2;
    while (dh < -Math.PI) dh += Math.PI * 2;
    poseYaw += dh * R2D;
    prevHeading = heading;
  }
  _f.set(0, 0, 1).applyQuaternion(c.body.quat);
  return {
    roll, pitch: pitchAcc, yaw: yawAcc, poseYaw,
    heading: Math.atan2(_f.x, _f.z) * R2D,
    nose: Math.asin(THREE.MathUtils.clamp(_f.y, -1, 1)) * R2D,
  };
}

console.log("=== ROLL (A/D) ===");
{
  const l = fly({ steer: 1 });
  const r = fly({ steer: -1 });
  check("A rolls the car", Math.abs(l.roll) > 180, `${l.roll.toFixed(0)}° in 1.6 s`);
  check("D rolls it the other way", Math.sign(r.roll) === -Math.sign(l.roll),
    `${r.roll.toFixed(0)}° vs ${l.roll.toFixed(0)}°`);
  check("and the two are symmetric", Math.abs(Math.abs(r.roll) - Math.abs(l.roll)) < 5,
    `${Math.abs(l.roll).toFixed(0)}° vs ${Math.abs(r.roll).toFixed(0)}°`);
}

console.log("\n=== PITCH / FLIP (Shift + Ctrl) ===");
// The one the heading hold broke: a flip takes the nose over the top, which
// REVERSES the heading, and an armed hold fought that all the way round.
{
  const up = fly({ pitch: 1, secs: 2.0 });
  const dn = fly({ pitch: -1, secs: 2.0 });
  check("Shift flips the car (nose up, over the top)", Math.abs(up.pitch) > 180,
    `${up.pitch.toFixed(0)}° of pitch in 2 s`);
  check("Ctrl flips it the other way", Math.sign(dn.pitch) === -Math.sign(up.pitch),
    `${dn.pitch.toFixed(0)}° vs ${up.pitch.toFixed(0)}°`);
  check("a flip is not fought by the heading hold",
    Math.abs(up.pitch) > 180 && Math.abs(dn.pitch) > 180,
    `up ${up.pitch.toFixed(0)}°, down ${dn.pitch.toFixed(0)}°`);
  // A flip may change the heading by design (nose over tail); what it must NOT
  // do is get dragged back mid-flip, which shows up as the pitch stalling.
  const half = fly({ pitch: 1, secs: 1.0 });
  check("…and it keeps rotating rather than stalling part-way",
    Math.abs(up.pitch) > Math.abs(half.pitch) * 1.6,
    `1.0 s → ${half.pitch.toFixed(0)}°, 2.0 s → ${up.pitch.toFixed(0)}°`);
}

console.log("\n=== FLAT SPIN (Q/E) ===");
{
  const e = fly({ yaw: 1 });
  const q = fly({ yaw: -1 });
  check("E spins the car", Math.abs(e.poseYaw) > 120, `${e.poseYaw.toFixed(0)}° in 1.6 s`);
  check("Q spins it the other way", Math.sign(q.poseYaw) === -Math.sign(e.poseYaw),
    `${q.poseYaw.toFixed(0)}° vs ${e.poseYaw.toFixed(0)}°`);
  check("the spin is symmetric", Math.abs(Math.abs(q.poseYaw) - Math.abs(e.poseYaw)) < 5,
    `${Math.abs(e.poseYaw).toFixed(0)}° vs ${Math.abs(q.poseYaw).toFixed(0)}°`);
}

console.log("\n=== THE HOLD ONLY EVER CLEANS UP AFTER A ROLL ===");
{
  // Released Q/E: the car must KEEP the heading the spin left it on, not be
  // dragged back to where the spin started.
  const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  c.groundBvh = ground; c.enabled = true;
  c.body.pos.set(0, 300, 0); c.body.vel.set(0, 0, 40); c.body.quat.identity();
  c._airTime = 10;
  for (let i = 0; i < 0.8 / FIXED_DT; i++) {
    c.tick({ steerTarget: 0, throttle: 0, handbrake: false, yaw: 1, pitch: 0 });
  }
  _f.set(0, 0, 1).applyQuaternion(c.body.quat);
  const spun = Math.atan2(_f.x, _f.z) * R2D;
  for (let i = 0; i < 1.5 / FIXED_DT; i++) {
    c.tick({ steerTarget: 0, throttle: 0, handbrake: false, yaw: 0, pitch: 0 });
  }
  _f.set(0, 0, 1).applyQuaternion(c.body.quat);
  const after = Math.atan2(_f.x, _f.z) * R2D;
  let drift = after - spun; while (drift > 180) drift -= 360; while (drift < -180) drift += 360;
  check("after a Q/E spin the car keeps where the spin left it",
    Math.abs(drift) < 25, `drifted ${drift.toFixed(0)}° in the 1.5 s after release`);
}

console.log(fail ? `\n${fail} FAILURE(S)` : "\nall green");
process.exit(fail ? 1 : 0);
