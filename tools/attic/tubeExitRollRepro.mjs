// Reported: the FIRST roll after coming out of a tube upside down doesn't rotate
// the car about its own centre — it swings around some other pivot, a "big
// radius" roll. Roll again after that and it behaves.
//
// A rigid body ALWAYS rotates about its centre of mass. So an apparent pivot
// somewhere else can only be one of two things:
//
//   (A) CONING. The rotation axis is not the chassis forward axis, so the nose
//       describes a cone instead of staying put. Orbiting a tube spins the car
//       about the TUBE's axis; leave the wall and that angular momentum is still
//       there, off-axis by the helix angle.
//   (B) A CURVED PATH. The centre of mass is being ACCELERATED sideways while it
//       rotates. Rotation about the COM plus a curving COM reads exactly as
//       "rotating about a point over there". While airborne the only honest
//       acceleration is gravity (and a little drag), so any non-gravitational
//       acceleration right after the exit is a smoking gun.
//
// This measures both, off a CONSTRUCTED exit: the car is placed on the tube wall
// at a chosen bank, orbiting at a chosen rate, a couple of metres from the open
// end. That is far more controllable than driving it there (and the car cannot
// actually drive that far — see tubeControlRepro's transit section).
//
// An instrument, not a pass/fail test.
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const TMP = join(ROOT, `.tubeexit.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, TIRE, WHEEL, FIXED_DT, GRAVITY, SURFACE_GRIP } =
  await import(pathToFileURL(TMP).href);
unlinkSync(TMP);

const R2D = 57.2958;
const R = 8;            // kit tubeRadius
const CY = R;           // axis height -> floor at y = 0
const TUBE_END = 30;    // the wall stops here
const RIDE = WHEEL.radius + 0.18;

console.log("=== SETUP ===");
console.log(`  tube r=${R}, open end at z=${TUBE_END}`);
console.log(`  airRollRate ${TIRE.airRollRate} rad/s   airSettle ${TIRE.airSettle}`
  + `   airResponse ${TIRE.airResponse}`);
console.log(`  SURFACE_GRIP enabled ${SURFACE_GRIP.enabled} gain ${SURFACE_GRIP.gain}`
  + ` ease ${SURFACE_GRIP.ease}`);

function inwardNormalAt(x, y, out) {
  const u = x, v = y - CY;
  const d = Math.hypot(u, v) || 1e-9;
  return out.set(-u / d, -v / d, 0);
}
function castInner(o, d, far, radius = R) {
  if (o.z > TUBE_END) return null;
  const u = o.x, v = o.y - CY;
  const a = d.x * d.x + d.y * d.y;
  if (a < 1e-12) return null;
  const b = 2 * (u * d.x + v * d.y);
  const c = u * u + v * v - radius * radius;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const t = (-b + Math.sqrt(disc)) / (2 * a);
  if (t < 0 || t > far) return null;
  const pz = o.z + d.z * t;
  if (pz > TUBE_END) return null;
  const px = o.x + d.x * t, py = o.y + d.y * t;
  const n = inwardNormalAt(px, py, new THREE.Vector3());
  return { distance: t, point: { x: px, y: py, z: pz }, normal: { x: n.x, y: n.y, z: n.z }, faceIndex: 0 };
}
const _cpN = new THREE.Vector3();
const tube = {
  baked: true,
  raycastFirst: (o, d, f) => castInner(o, d, f),
  spherecast(ox, oy, oz, rad, dx, dy, dz, md) {
    const l = Math.hypot(dx, dy, dz) || 1;
    return castInner({ x: ox, y: oy, z: oz }, { x: dx / l, y: dy / l, z: dz / l },
      md, Math.max(0.01, R - rad));
  },
  closestPointWithNormal(px, py, pz, md, outN) {
    if (pz > TUBE_END) return null;
    const u = px, v = py - CY, d = Math.hypot(u, v), gap = R - d;
    if (gap > md || d < 1e-9) return null;
    inwardNormalAt(px, py, _cpN); outN.copy(_cpN);
    return { x: (u / d) * R, y: CY + (v / d) * R, z: pz, distance: Math.max(0, gap) };
  },
};
const noSolids = { baked: false, closestPointWithNormal: () => null };

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
const _prevV = new THREE.Vector3();
const _acc = new THREE.Vector3();

function coneDeg(c) {
  const w = c.body.angVel, wl = w.length();
  if (wl < 1e-4) return 0;
  _f.set(0, 0, 1).applyQuaternion(c.body.quat);
  return Math.acos(THREE.MathUtils.clamp(Math.abs(w.dot(_f)) / wl, 0, 1)) * R2D;
}

/**
 * Place the car on the wall at `bank`, orbiting at `orbit` rad/s, `startBack`
 * metres short of the open end. Then roll.
 */
function run({ bank = 180, orbit = 2.2, vz = 26, startBack = 3, secs = 2.2,
  rollInput = 1, grip = null }) {
  const savedGrip = SURFACE_GRIP.enabled;
  if (grip !== null) SURFACE_GRIP.enabled = grip;

  const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  c.groundBvh = tube; c.solidsBvh = noSolids; c.getFloorY = () => -1e4; c.enabled = true;

  const th = bank / R2D;
  const r = R - RIDE;
  c.body.pos.set(r * Math.sin(th), CY - r * Math.cos(th), TUBE_END - startBack);
  // Chassis up -> inward normal, forward -> +Z. That is a rotation about Z by th.
  c.body.quat.setFromAxisAngle(new THREE.Vector3(0, 0, 1), th);
  // Orbiting the tube = spinning about the TUBE axis (+Z), with the matching
  // circumferential velocity.
  c.body.angVel.set(0, 0, orbit);
  c.body.vel.set(orbit * r * Math.cos(th), orbit * r * Math.sin(th), vz);

  let leftAt = null, exit = null;
  const rows = [];
  _prevV.copy(c.body.vel);
  for (let i = 0; i < (secs + 4) / FIXED_DT; i++) {
    const air = c.groundedCount === 0;
    c.tick({
      steerTarget: air && leftAt !== null ? rollInput : 0,
      throttle: air ? 0 : 1, handbrake: false, yaw: 0, pitch: 0,
    });
    // Acceleration this tick that is NOT gravity.
    _acc.copy(c.body.vel).sub(_prevV).multiplyScalar(1 / FIXED_DT);
    _acc.y += GRAVITY;
    _prevV.copy(c.body.vel);

    if (leftAt === null && air && c.body.pos.z > TUBE_END) {
      leftAt = i * FIXED_DT;
      exit = { cone: coneDeg(c), w: c.body.angVel.length() * R2D, bank, sg: c._sgMag ?? 0 };
    }
    if (leftAt !== null) {
      const t = i * FIXED_DT - leftAt;
      if (rows.length === 0 || t - rows[rows.length - 1].t >= 0.1) {
        _f.set(0, 0, 1).applyQuaternion(c.body.quat);
        const _rr = new THREE.Vector3(1, 0, 0).applyQuaternion(c.body.quat);
        const _uu = new THREE.Vector3(0, 1, 0).applyQuaternion(c.body.quat);
        rows.push({
          t, cone: coneDeg(c), w: c.body.angVel.length() * R2D,
          roll: c.body.angVel.dot(_f) * R2D,
          pitch: c.body.angVel.dot(_rr) * R2D,
          yaw: c.body.angVel.dot(_uu) * R2D,
          aOff: _acc.length(), sg: c._sgMag ?? 0, g: c.groundedCount,
        });
      }
      if (t > secs) break;
    }
  }
  SURFACE_GRIP.enabled = savedGrip;
  return { leftAt, exit, rows };
}

console.log("\n=== 1. CONING: IS THE ROTATION AXIS THE CAR'S OWN LENGTH? ===");
console.log("  cone 0° = a clean barrel roll. Large = the nose sweeps a circle.\n");
console.log("   exit bank   orbit rate   cone at exit   cone @0.5s   @1.0s   @2.0s");
for (const bank of [90, 140, 180]) {
  for (const orbit of [0, 2.2]) {
    const r = run({ bank, orbit });
    if (!r.exit) { console.log(`   bank ${bank}, orbit ${orbit}: never exited`); continue; }
    const at = (t) => r.rows.reduce((b, x) => (Math.abs(x.t - t) < Math.abs(b.t - t) ? x : b), r.rows[0]).cone;
    console.log(
      `   ${String(bank).padStart(8)}°   ${orbit.toFixed(1).padStart(9)}`
      + `   ${r.exit.cone.toFixed(0).padStart(11)}°   ${at(0.5).toFixed(0).padStart(9)}°`
      + `   ${at(1.0).toFixed(0).padStart(5)}°   ${at(2.0).toFixed(0).padStart(5)}°`,
    );
  }
}

console.log("\n=== 2. IS THE CENTRE OF MASS BEING PUSHED WHILE IT ROLLS? ===");
console.log("  Airborne, the only real acceleration is gravity. Anything left over");
console.log("  curves the flight path, and a rotating car on a curving path is exactly");
console.log("  'it isn't turning about its own centre'. Units m/s^2, gravity removed.\n");
console.log("      t    non-gravity accel   surface-grip force   wheels");
{
  const r = run({ bank: 180, orbit: 2.2 });
  for (const s of r.rows.slice(0, 14)) {
    console.log(
      `   ${s.t.toFixed(2).padStart(5)}   ${s.aOff.toFixed(2).padStart(15)}`
      + `   ${(s.sg / 1000).toFixed(2).padStart(16)} kN   ${s.g}`,
    );
  }
}

console.log("\n=== 3. A/B: IS THE SURFACE-GRIP ASSIST STILL PUSHING ON THE WAY OUT? ===");
console.log("  SURFACE_GRIP eases its force out over ~1/ease s. If the ease keeps");
console.log("  pushing after the wall has gone, it curves the exit.\n");
console.log("   surface grip   peak non-gravity accel after exit   total impulse");
for (const g of [true, false]) {
  const r = run({ bank: 180, orbit: 2.2, grip: g });
  let peak = 0, sum = 0;
  for (const s of r.rows) { peak = Math.max(peak, s.aOff); sum += s.aOff * 0.1; }
  console.log(
    `   ${(g ? "ON" : "OFF").padStart(12)}   ${peak.toFixed(2).padStart(31)}`
    + `   ${sum.toFixed(2).padStart(13)} m/s`,
  );
}

console.log("");
console.log("=== 4. WHICH COMPONENT KEEPS THE AXIS TILTED? ===");
console.log("  Air control drives ROLL to the commanded rate and PITCH toward zero");
console.log("  (airSettle). YAW is applied KINEMATICALLY, so the PHYSICAL yaw component");
console.log("  of angVel is never driven anywhere by the rate model.");
console.log("");
console.log("      t     roll     pitch      yaw     cone");
{
  const r = run({ bank: 180, orbit: 2.2 });
  for (const s of r.rows.slice(0, 16)) {
    console.log(
      "   " + s.t.toFixed(2).padStart(5)
      + "  " + s.roll.toFixed(0).padStart(6) + "\u00B0"
      + "  " + s.pitch.toFixed(0).padStart(6) + "\u00B0"
      + "  " + s.yaw.toFixed(0).padStart(6) + "\u00B0"
      + "  " + s.cone.toFixed(0).padStart(5) + "\u00B0",
    );
  }
}
console.log("");
