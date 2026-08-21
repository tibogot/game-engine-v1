// Diagnostic: what does the predictive landing alignment do over TERRAIN?
//
// Every earlier instrument here lands the car on flat road, where the target is
// world up and the assist has almost nothing to correct. Reported symptom is on
// terrain — hills and slopes — where the car "completely shifts in the air".
//
// Two things are different about terrain and both point the same way:
//
//   1. THE TARGET IS NOT VERTICAL. The assist aligns the chassis up-axis to the
//      surface normal it is about to hit. On a side-slope that normal is tilted,
//      so a car flying PERFECTLY LEVEL reads as having a large roll error and is
//      rotated to match the hillside in mid-air. The need gate reaches full
//      authority at airLandErrFull = 0.30 rad = 17°, so any slope steeper than
//      that gets the full 32 kN·m on every single jump.
//
//   2. THE TARGET IS UNFILTERED. `_landN` is the raw triangle normal from one
//      ray (see the airborne branch of _applyLandingAssist). The TYRE contact
//      normal is low-passed at TIRE.normalSmooth = 18/s; this one is not. Over a
//      triangulated heightfield the ray sweeps across faces as the car descends,
//      so the target can step from face to face.
//
// Reports, per surface: how far the car rotated in the air with NO input, how
// tilted the target was, and how unstable it was tick to tick.
//
// An instrument, not a pass/fail test.
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { RoadBvh } from "../v3/play/modularRoadBvh.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = join(ROOT, `.terrmagnet.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, FIXED_DT } = await import(pathToFileURL(TMP).href);
unlinkSync(TMP);
const R2D = 57.2958;

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

/** A triangulated heightfield, so faceting is REAL rather than analytic. */
function terrain(height, { size = 400, seg = 80 } = {}) {
  const g = new THREE.PlaneGeometry(size, size, seg, seg);
  g.rotateX(-Math.PI / 2);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    p.setY(i, height(p.getX(i), p.getZ(i)));
  }
  g.computeVertexNormals();
  const bvh = new RoadBvh();
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial());
  m.updateMatrixWorld(true);
  bvh.bakeFromMeshes([m]);
  return bvh;
}

const _up = new THREE.Vector3(), _fwd = new THREE.Vector3(), _right = new THREE.Vector3();
const rollDeg = (q) => {
  _up.set(0, 1, 0).applyQuaternion(q);
  _fwd.set(0, 0, 1).applyQuaternion(q);
  _right.crossVectors(_up, _fwd);
  return Math.atan2(_right.y, _up.y) * R2D;
};

/**
 * Launch LEVEL with NO input over the given surface. Any roll the car acquires
 * in the air is the assist's doing — nothing else applies roll torque there.
 */
function fly(bvh, { z0 = -60, h = 12, vz = 30, vy = 6 }) {
  const car = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  car.setBvh(bvh, null);
  car.getFloorY = () => -200;
  car.enabled = true;
  const y0 = 0;
  car.body.pos.set(0, y0 + h, z0);
  car.body.quat.identity();
  car.body.vel.set(0, vy, vz);
  car.body.angVel.set(0, 0, 0);
  car._resetInterpolation();
  for (const t of car.tires) t._hadGround = false;
  car._airTime = 0.2; car._rackAirTime = 0.2; car._holdHeading = 0;

  const launchRoll = rollDeg(car.body.quat);
  const prevN = new THREE.Vector3(); const curN = new THREE.Vector3();
  let haveN = false, airRoll = 0, peakTargetTilt = 0, worstStep = 0, steps = 0, peakEngage = 0;
  // WHERE THE PROBE IS AIMING vs where the car actually ends up. The ray runs
  // along the velocity vector — a STRAIGHT LINE — but the car follows a
  // parabola, which falls below that line. So the probe always overshoots
  // downrange. On flat ground that costs nothing (every point has the same
  // normal); on terrain it means sampling a different piece of ground entirely.
  const aim = new THREE.Vector3(); let haveAim = false;

  for (let i = 0; i < 900; i++) {
    car.tick({ steerTarget: 0, rollTarget: 0, throttle: 0, handbrake: false, yaw: 0, pitch: 0 });
    if (car.groundedCount === 0) {
      airRoll = Math.max(airRoll, Math.abs(rollDeg(car.body.quat) - launchRoll));
      const eng = car._landEngage ?? 0;
      if (eng > 0.001) {
        peakEngage = Math.max(peakEngage, eng);
        if (!haveAim) {
          const d = car.body.vel.clone();
          if (d.y > -1 || d.lengthSq() < 1e-6) d.set(0, -1, 0); else d.normalize();
          const h = car._castGround(car.body.pos, d, 40);
          if (h && h.point) { aim.set(h.point.x, h.point.y, h.point.z); haveAim = true; }
        }
        curN.copy(car._landN);
        if (curN.lengthSq() > 1e-6) {
          curN.normalize();
          peakTargetTilt = Math.max(peakTargetTilt,
            Math.acos(Math.min(1, Math.max(-1, curN.y))) * R2D);
          if (haveN) {
            const d = Math.acos(Math.min(1, Math.max(-1, curN.dot(prevN)))) * R2D;
            if (d > worstStep) worstStep = d;
            if (d > 5) steps++;
          }
          prevN.copy(curN); haveN = true;
        }
      }
    } else if (car._isSupported()) break;
  }
  const land = car.body.pos.clone();
  const aimErr = haveAim ? Math.hypot(land.x - aim.x, land.z - aim.z) : 0;
  return { airRoll, peakTargetTilt, worstStep, steps, peakEngage, aimErr };
}

const D = Math.PI / 180;
const surfaces = [
  ["flat (control)",            () => 0],
  ["side-slope 10°",            (x) => x * Math.tan(10 * D)],
  ["side-slope 20°",            (x) => x * Math.tan(20 * D)],
  ["side-slope 30°",            (x) => x * Math.tan(30 * D)],
  ["down-slope 20° (no roll)",  (x, z) => -z * Math.tan(20 * D)],
  ["rolling hills (40 m)",      (x, z) => 4 * Math.sin(z / 40) * Math.cos(x / 40)],
  ["rough hills (15 m)",        (x, z) => 2.5 * Math.sin(z / 15) * Math.cos(x / 18)],
];

console.log("Landing assist over TERRAIN — launched LEVEL, zero input.\n");
console.log("surface                    | air roll | target tilt | worst step | engage | aim miss");
for (const [name, fn] of surfaces) {
  const bvh = terrain(fn);
  const r = fly(bvh, {});
  console.log(
    `${name.padEnd(26)} | ${r.airRoll.toFixed(1).padStart(7)}°`
    + ` | ${r.peakTargetTilt.toFixed(1).padStart(10)}°`
    + ` | ${r.worstStep.toFixed(1).padStart(9)}°`
    + ` | ${r.peakEngage.toFixed(2).padStart(6)}`
    + ` | ${r.aimErr.toFixed(1).padStart(6)} m`,
  );
}
console.log(`
air roll    = roll the car took on BY ITSELF in flight, with no input at all
target tilt = how far the aim normal sat from world up
worst step  = biggest single-tick jump in the aim normal (it is UNFILTERED)

On flat road the assist has nothing to do and does nothing. Any large "air roll"
here is the car being rotated in mid-air to match ground it has not reached.`);
