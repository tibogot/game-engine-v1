// Prototype: does a slope-aware drive bias fix the bog without touching the
// flat-road drift feel? Blends RWD -> AWD only as the road pitches up.
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = join(ROOT, `.fix.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, TIRE, FIXED_DT } = await import(pathToFileURL(TMP).href);
unlinkSync(TMP);

const D2R = 1 / 57.2958;
function slopeGround(deg) {
  const t = Math.tan(deg * D2R);
  const n = { x: 0, y: Math.cos(deg * D2R), z: Math.sin(deg * D2R) };
  return {
    baked: true,
    raycastFirst(o, d, far) {
      const den = d.y + t * d.z;
      if (Math.abs(den) < 1e-9) return null;
      const s = -(o.y + t * o.z) / den;
      if (s < 0 || s > far) return null;
      return { point: { x: o.x + d.x * s, y: o.y + d.y * s, z: o.z + d.z * s }, distance: s, faceIndex: 0, normal: n };
    },
    spherecast() { return null; }, closestPointWithNormal() { return null; },
  };
}
Vehicle.prototype._buildMeshes = function () {
  this.group = new THREE.Group(); this.chassisMesh = new THREE.Object3D();
  this.tireGroups = [0, 0, 0, 0].map(() => new THREE.Group());
  this.arrowGroup = new THREE.Group(); this.arrowGroup.visible = false;
  this.arrows = [0, 0, 0, 0].map(() => ({})); this.wheelSpin = [0, 0, 0, 0];
  this.headlights = []; this.headlightTargets = []; this.headlamps = []; this.taillights = [];
  this._wheelInstances = []; this._wheelParts = [];
};
Vehicle.prototype._updateTaillights = function () {};

// ── THE PATCH ───────────────────────────────────────────────────────────────
// Climbing is the ONLY thing this changes. `climb` is how steeply the car is
// pointing up the surface it is standing on; on flat road it is 0 and the
// drivetrain is exactly the shipped RWD, so drift feel cannot regress.
const CLIMB_AWD = { startDeg: 12, fullDeg: 34, bias: 0.55 };
const shippedBias = Vehicle.prototype._driveBias;
const _n = new THREE.Vector3(), _f = new THREE.Vector3();
function patchedBias() {
  const base = shippedBias.call(this);
  let n = 0;
  for (const t of this.tires) if (t.grounded) n++;
  if (!n) return base;
  // Chassis forward is local +z. Its world-y component IS sin(climb angle).
  _f.set(0, 0, 1).applyQuaternion(this.body.quat);
  const climbDeg = Math.asin(Math.max(-1, Math.min(1, _f.y))) / D2R;
  const s = CLIMB_AWD.startDeg, f = CLIMB_AWD.fullDeg;
  const k = Math.max(0, Math.min(1, (climbDeg - s) / (f - s)));
  return base + (CLIMB_AWD.bias - base) * k;
}

function climb(deg, v0, secs = 20) {
  const th = deg * D2R;
  const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  c.groundBvh = slopeGround(deg); c.enabled = true;
  c.body.pos.set(0, 0.65 / Math.cos(th), 0);
  c.body.quat.setFromEuler(new THREE.Euler(-th, Math.PI, 0, "YXZ"));
  c.body.vel.set(0, v0 * Math.sin(th), -v0 * Math.cos(th));
  const up = new THREE.Vector3(0, Math.sin(th), -Math.cos(th));
  let minV = Infinity;
  for (let i = 0; i < Math.round(secs / FIXED_DT); i++) {
    c.tick({ steerTarget: 0, throttle: 1, handbrake: false, yaw: 0, pitch: 0 });
    if (i > 60) minV = Math.min(minV, c.body.vel.dot(up));
  }
  return { v: c.body.vel.dot(up), min: minV };
}
function ceiling() {
  let lo = 0, hi = 70;
  for (let i = 0; i < 9; i++) {
    const mid = (lo + hi) / 2;
    if (climb(mid, 12, 18).v > 12) lo = mid; else hi = mid;
  }
  return lo;
}
/** 0–100 km/h on the flat — the number that must NOT change. */
function zeroTo100() {
  const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  c.groundBvh = slopeGround(0); c.enabled = true;
  c.body.pos.set(0, 0.65, 0);
  c.body.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
  for (let i = 0; i < Math.round(20 / FIXED_DT); i++) {
    c.tick({ steerTarget: 0, throttle: 1, handbrake: false, yaw: 0, pitch: 0 });
    if (c.body.vel.length() >= 100 / 3.6) return i * FIXED_DT;
  }
  return NaN;
}

for (const [label, fn] of [["SHIPPED (pure RWD)", shippedBias], ["slope-aware AWD blend", patchedBias]]) {
  Vehicle.prototype._driveBias = fn;
  console.log(`\n=== ${label} ===`);
  console.log(`  climb ceiling from a crawl   ${ceiling().toFixed(1)}°`);
  console.log(`  0-100 km/h on the flat       ${zeroTo100().toFixed(2)} s   <- must not change`);
  console.log("  grade   from 45 m/s   from 12 m/s   (km/h settled)");
  for (const deg of [20, 27.4, 35, 40, 45, 50]) {
    const hi = climb(deg, 45), lo = climb(deg, 12);
    console.log(`  ${deg.toFixed(1).padStart(5)}°  ${(Math.max(0, hi.v) * 3.6).toFixed(0).padStart(11)}  ` +
      `${(Math.max(0, lo.v) * 3.6).toFixed(0).padStart(12)}`);
  }
}
Vehicle.prototype._driveBias = shippedBias;
