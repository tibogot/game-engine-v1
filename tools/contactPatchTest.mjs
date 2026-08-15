// What changes when tyre force is applied at the CONTACT PATCH instead of the hub?
//
// The model applied lateral and longitudinal tyre force at the wheel hub, 0.46 m
// above the road. The vertical arm from the CoM is what turns cornering force
// into a roll moment and hence into load transfer:
//     hub    0.10 m below CoM ->   746 N per side at 1 g
//     patch  0.46 m below CoM ->  3434 N          "
// so the roll moment was understated 4.6x. Because `Fmax` is derived from the
// dynamic suspension load, that also means the outer tyres never gained the bite
// (and the inner ones never lost it) that a real car's do.
//
// This measures the consequences that matter: body roll, how unevenly the four
// corners are loaded, and whether cornering grip and stability actually change.
//
// An instrument, not a pass/fail test.
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = join(ROOT, `.patch.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, TIRE, BODYLEAN, FIXED_DT } = await import(pathToFileURL(TMP).href);
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
/** Roll angle about the car's own forward axis, degrees. */
function rollDeg(q) {
  _up.set(0, 1, 0).applyQuaternion(q);
  _fwd.set(0, 0, 1).applyQuaternion(q);
  _right.crossVectors(_up, _fwd);
  return Math.atan2(_right.y, _up.y) * R2D;
}

/** Hold a steady corner and report the settled state. */
function corner({ steer, throttle = 1, secs = 12, sampleAfter = 8 }) {
  const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  c.groundBvh = ground; c.enabled = true;
  c.body.pos.set(0, 0.6, 0);
  c.body.quat.identity();
  // Enter with speed so we measure a real corner, not a standing start.
  c.body.vel.set(0, 0, 25);
  c._resetInterpolation();

  let n = 0, roll = 0, loadOuter = 0, loadInner = 0, latG = 0, speed = 0, grounded = 0;
  let t = 0;
  while (t < secs) {
    c.tick({ steerTarget: steer, rollTarget: 0, throttle, handbrake: false, yaw: 0, pitch: 0 });
    t += FIXED_DT;
    if (t < sampleAfter) continue;
    n++;
    roll += Math.abs(rollDeg(c.body.quat));
    // Steering left (+) loads the wheels on the -X side. Compare the two sides'
    // suspension force, which IS the load the friction circle is scaled by.
    let lo = 0, li = 0;
    for (const tire of c.tires) {
      const f = tire.lastSuspension.length();
      if ((tire.localPos.x < 0) === (steer > 0)) lo += f; else li += f;
    }
    loadOuter += lo; loadInner += li;
    speed += Math.hypot(c.body.vel.x, c.body.vel.z);
    grounded += c.groundedCount;
    // Lateral acceleration from the actual path curvature.
    const v = Math.hypot(c.body.vel.x, c.body.vel.z);
    const yaw = c.body.angVel.y;
    latG += Math.abs(v * yaw) / 9.81;
  }
  if (!n) return null;
  return {
    roll: roll / n,
    outer: loadOuter / n,
    inner: loadInner / n,
    transfer: (loadOuter / n) - (loadInner / n),
    latG: latG / n,
    speed: speed / n,
    grounded: grounded / n,
  };
}

// The cosmetic lean would double-count once the body rolls for real; take it out
// so this measures PHYSICS roll only.
BODYLEAN.enabled = false;

const steers = [0.25, 0.5, 1.0];
console.log("Physics body roll and load transfer in a steady corner (BODYLEAN off)\n");
console.log("steer | patch |  roll   outerN   innerN  transfer  latG  speed  wheels");
for (const s of steers) {
  for (const k of [0, 1]) {
    TIRE.contactPatchForces = k;
    const r = corner({ steer: s });
    if (!r) { console.log(`${s} k=${k}: no data`); continue; }
    console.log(
      `${s.toFixed(2)}  |  ${k.toFixed(1)}  | ${r.roll.toFixed(2).padStart(5)}° `
      + `${r.outer.toFixed(0).padStart(7)} ${r.inner.toFixed(0).padStart(8)} `
      + `${r.transfer.toFixed(0).padStart(8)} ${r.latG.toFixed(2).padStart(6)} `
      + `${r.speed.toFixed(1).padStart(6)} ${r.grounded.toFixed(2).padStart(6)}`,
    );
  }
  console.log("");
}
TIRE.contactPatchForces = 0;
console.log("transfer = outer-side suspension force minus inner-side; it is what");
console.log("scales each tyre's friction circle, so it drives limit behaviour.");
