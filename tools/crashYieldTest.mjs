/**
 * Crash yield — landing assists go quiet AFTER a real crash, not on a jump.
 *
 *   node tools/crashYieldTest.mjs
 */
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = join(ROOT, `.crashyield.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, FIXED_DT, CRASH } = await import(pathToFileURL(TMP).href);
unlinkSync(TMP);

const R2D = 57.2958;
let fail = 0;
const check = (n, c, d = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`);
  if (!c) fail++;
};

const road = {
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

function wall(wallX) {
  return {
    baked: true, raycastFirst() { return null; }, spherecast() { return null; },
    closestPointWithNormal(x, y, z, radius, outN) {
      const d = Math.abs(x - wallX) - 0.2;
      if (d > radius) return null;
      outN.set(x >= wallX ? 1 : -1, 0, 0);
      return { distance: Math.max(0, d) };
    },
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
Vehicle.prototype._syncWheelInstances = function () {};

const _up = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const rollDeg = (q) => {
  _up.set(0, 1, 0).applyQuaternion(q);
  _fwd.set(0, 0, 1).applyQuaternion(q);
  _right.crossVectors(_up, _fwd);
  return Math.atan2(_right.y, _up.y) * R2D;
};

function makeCar({ solids = null } = {}) {
  const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  c.groundBvh = road;
  if (solids) c.solidsBvh = solids;
  c.enabled = true;
  return c;
}

function dropRolled({ tiltDeg, secs, yieldHold = 0, vy = -4, h = 8 }) {
  const c = makeCar();
  c.body.pos.set(0, h, 0);
  c.body.quat.setFromAxisAngle(new THREE.Vector3(0, 0, 1), tiltDeg / R2D);
  c.body.vel.set(0, vy, 25);
  c._airTime = 0.2;
  if (yieldHold > 0) c._crashYield = yieldHold;
  const n = Math.round(secs / FIXED_DT);
  for (let i = 0; i < n; i++) {
    if (yieldHold > 0) c._crashYield = Math.max(c._crashYield, yieldHold);
    c.tick({ steerTarget: 0, throttle: 0, handbrake: false, yaw: 0, pitch: 0 });
  }
  return { roll: Math.abs(rollDeg(c.body.quat)), yield: c.crashYield, car: c };
}

console.log("=== ordinary crooked jump still gets the assist ===");
{
  const r = dropRolled({ tiltDeg: 25, secs: 0.55 });
  check("a 25° jump is mostly levelled before the ground", r.roll < 12,
    `roll ${r.roll.toFixed(1)}°`);
  check("and yield never armed", r.yield <= 0, `crashYield ${r.yield.toFixed(2)}`);
}

console.log("\n=== after a crash the assist does not un-flip ===");
{
  const r = dropRolled({ tiltDeg: 90, secs: 0.55, yieldHold: CRASH.hold });
  check("a 90° tumble stays a tumble while yielded", r.roll > 60,
    `roll ${r.roll.toFixed(1)}°`);
}

console.log("\n=== a hard wall hit arms yield ===");
{
  const c = makeCar({ solids: wall(3.0) });
  c.body.pos.set(0, 4, 0);
  c.body.vel.set(28, 0, 0);
  c._airTime = 0.2;
  let armed = false;
  let peakImpact = 0;
  const n = Math.round(0.4 / FIXED_DT);
  for (let i = 0; i < n; i++) {
    c.tick({ steerTarget: 0, throttle: 0, handbrake: false, yaw: 0 });
    peakImpact = Math.max(peakImpact, c.solidImpactSpeed);
    if (c.crashYield > 0) armed = true;
  }
  check("the hit was hard enough to count", peakImpact >= CRASH.wallSpeed,
    `peak close ${peakImpact.toFixed(1)} m/s vs ${CRASH.wallSpeed}`);
  check("yield armed from that hit", armed, `crashYield ${c.crashYield.toFixed(2)}`);
}

console.log("\n=== an upright car on all four wheels recovers immediately ===");
{
  const c = makeCar({ solids: wall(4.5) });
  c.body.pos.set(0, 0.55, 0);
  c.body.vel.set(0, 0, 18);
  c._crashYield = CRASH.hold;
  c.tick({ steerTarget: 0, throttle: 1, handbrake: false, yaw: 0 });
  check("wheels-down driving clears yield", c.crashYield <= 0,
    `crashYield ${c.crashYield.toFixed(2)}, wheels ${c.groundedCount}`);
}

console.log(fail ? `\n${fail} check(s) failed` : "\nall green");
process.exit(fail ? 1 : 0);
