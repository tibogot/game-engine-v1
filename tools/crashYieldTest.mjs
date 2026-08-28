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

console.log("\n=== driving again ends the crash — but not before minHold ===");
{
  // THIS USED TO ASSERT "recovers IMMEDIATELY", and that single tick was the
  // reason no crash ever happened. `recovered` is evaluated in the same call
  // that arms the yield, so a hit taken with the wheels down — i.e. every crash
  // you have while driving — armed and cleared on the same substep. Measured
  // before the fix: a 60 m/s head-on into a barrier held the crash state for
  // 0.00 s and rolled the car 1° (tools/crashResponseRepro.mjs).
  //
  // The contract now has two halves, and both matter: the crash must survive
  // long enough to become one, and it must still end as soon as you are driving.
  const drive = (ticks) => {
    const c = makeCar({ solids: wall(4.5) });
    c.body.pos.set(0, 0.55, 0);
    c.body.vel.set(0, 0, 18);
    c._crashYield = CRASH.hold;
    for (let i = 0; i < ticks; i++) {
      c.tick({ steerTarget: 0, throttle: 1, handbrake: false, yaw: 0 });
    }
    return c;
  };
  const early = drive(1);
  check("wheels down does NOT cancel the crash on the spot", early.crashYield > 0,
    `crashYield ${early.crashYield.toFixed(2)}, wheels ${early.groundedCount}`);

  const late = drive(Math.round((CRASH.minHold + 0.15) / FIXED_DT));
  check("...but driving clears it once minHold has passed", late.crashYield <= 0,
    `crashYield ${late.crashYield.toFixed(2)}, wheels ${late.groundedCount}`);
}

console.log("\n=== yielded airborne slam bounces; a slow on-road clip stays dead ===");
{
  const slam = (y, vx) => {
    const c = makeCar({ solids: wall(3.0) });
    c.body.pos.set(0, y, 0);
    c.body.vel.set(vx, 0, 0);
    c._airTime = 0.2;
    const n = Math.round(0.25 / FIXED_DT);
    for (let i = 0; i < n; i++) {
      c.tick({ steerTarget: 0, throttle: 0, handbrake: false, yaw: 0 });
    }
    return c;
  };
  const air = slam(4, 22);
  check("airborne slam rebounds instead of dying", air.body.vel.x < -4,
    `vx ${air.body.vel.x.toFixed(1)} m/s`);
  {
    const c = makeCar({ solids: wall(6.0) });
    c.body.pos.set(0, 0.55, 0);
    for (let i = 0; i < Math.round(0.35 / FIXED_DT); i++) {
      c.tick({ steerTarget: 0, throttle: 0, handbrake: false, yaw: 0 });
    }
    c.body.vel.set(8, 0, 0);
    for (let i = 0; i < Math.round(0.9 / FIXED_DT); i++) {
      c.tick({ steerTarget: 0, throttle: 0, handbrake: false, yaw: 0 });
    }
    check("a slow on-road clip is still a dead barrier",
      c.body.vel.x > -2 && c.crashYield <= 0,
      `vx ${c.body.vel.x.toFixed(1)} m/s, yield ${c.crashYield.toFixed(2)}, wheels ${c.groundedCount}`);
  }
}

console.log("\n=== a moving solid at wrecking-ball speed arms yield ===");
{
  const w = wall(2.5);
  const c = makeCar();
  c.dynamicMovers = [{
    bvh: w,
    velocityAt(_p, out) { return out.set(-8, 0, 0); },
  }];
  c.body.pos.set(1.4, 0.55, 0);
  c.body.vel.set(0, 0, 0);
  const n = Math.round(0.2 / FIXED_DT);
  let armed = false, peak = 0;
  for (let i = 0; i < n; i++) {
    c.tick({ steerTarget: 0, throttle: 0, handbrake: false, yaw: 0 });
    peak = Math.max(peak, c.solidImpactSpeed);
    if (c.crashYield > 0) armed = true;
  }
  check("relative close-speed counts the mover", peak >= CRASH.moverSpeed,
    `peak ${peak.toFixed(1)} m/s vs moverSpeed ${CRASH.moverSpeed}`);
  check("yield stays on even with wheels down (wrecking ball)", armed,
    `crashYield ${c.crashYield.toFixed(2)}, wheels ${c.groundedCount}`);
}

console.log("\n=== a crash while DRIVING actually throws the car about ===");
{
  // The end the whole block exists for, asserted on what a player would see
  // rather than on the flag. Every piece of this was silently zero before: the
  // yield never survived arming, so `violent` never engaged, so a hit landed
  // with SOLID's deliberately dead 0.05 restitution and 0.15 spin and the car
  // simply stopped. Wheels are DOWN throughout — that is the case that was
  // broken, and the one every real crash happens in.
  const c = makeCar({ solids: wall(6.0) });
  c.body.pos.set(0, 0.55, 0);
  for (let i = 0; i < Math.round(0.3 / FIXED_DT); i++) {
    c.tick({ steerTarget: 0, throttle: 0, handbrake: false, yaw: 0 });
  }
  // Sideways into it at well over wallSpeed, nose still down the road.
  c.body.vel.set(26, 0, -20);
  const fwd = new THREE.Vector3();
  const up = new THREE.Vector3();
  let peakSpin = 0, peakRoll = 0, minUpY = 1, armed = false;
  for (let i = 0; i < Math.round(1.2 / FIXED_DT); i++) {
    c.tick({ steerTarget: 0, throttle: 0, handbrake: false, yaw: 0 });
    if (c.crashYield > 0) armed = true;
    fwd.set(0, 0, 1).applyQuaternion(c.body.quat);
    up.set(0, 1, 0).applyQuaternion(c.body.quat);
    peakSpin = Math.max(peakSpin, c.body.angVel.length());
    peakRoll = Math.max(peakRoll, Math.abs(c.body.angVel.dot(fwd)));
    minUpY = Math.min(minUpY, up.y);
  }
  check("a hard hit while driving arms the crash", armed,
    `crashYield peaked above 0`);
  check("...and it genuinely throws the car", peakSpin > 2.0,
    `peak spin ${peakSpin.toFixed(2)} rad/s (was 0.15–0.47 before the fix)`);
  check("...including roll, not just a flat spin", peakRoll > 1.5,
    `peak roll ${peakRoll.toFixed(2)} rad/s, leaned to up.y ${minUpY.toFixed(2)}`);
}

console.log(fail ? `\n${fail} check(s) failed` : "\nall green");
process.exit(fail ? 1 : 0);
