// Diagnostic: "after a jump, if I turn, it's very abrupt."
//
// THE SUSPECT. A/D is TWO controls on one key: it rolls the car in the air and
// steers the front wheels on the ground. But `_smoothSteer` runs in tick()
// unconditionally — it does not know or care whether the wheels are touching
// anything — so every millisecond you spend rolling in the air is also winding
// the STEERING RACK toward full lock. Touch down and the tyres are handed
// whatever lock accumulated up there, all at once.
//
// If that is what is happening, the car does not "turn abruptly after a jump";
// it lands with the wheels ALREADY turned, which is a different bug with a
// different fix.
//
// Measures the steering state at the instant of touchdown, and the heading
// swing that follows, against a car that made the same jump with no air input.
//
// An instrument, not a pass/fail test.
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const TMP = join(ROOT, `.landsteer.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, TIRE, FIXED_DT } = await import(pathToFileURL(TMP).href);
unlinkSync(TMP);
const R2D = 57.2958;

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
const heading = (q) => {
  _f.set(0, 0, 1).applyQuaternion(q);
  return Math.atan2(_f.x, _f.z) * R2D;
};

/**
 * Jump, hold the steer key in the AIR for `holdFor` seconds (releasing
 * `releaseBefore` seconds before touchdown is not possible to know in advance,
 * so `holdFor` is measured from launch), then land with NO further input.
 */
function jump({ air = 0, holdFor = Infinity, speed = 35, up = 5, secs = 4 }) {
  const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  c.groundBvh = ground; c.enabled = true;
  c.body.pos.set(0, 8, 0);
  c.body.vel.set(0, up, speed);
  c.body.quat.identity();

  let land = null;
  const n = Math.round(secs / FIXED_DT);
  for (let i = 0; i < n; i++) {
    const t = i * FIXED_DT;
    const grounded = c.groundedCount >= 3;
    // The player is rolling in the air; once down they let go entirely, so
    // anything that happens next is the CAR's doing, not theirs.
    const steer = (!land && !grounded && t < holdFor) ? air : 0;
    c.tick({ steerTarget: steer, throttle: 0.4, handbrake: false, yaw: 0, pitch: 0 });

    if (!land && c.groundedCount >= 3) {
      _f.set(0, 0, 1).applyQuaternion(c.body.quat);
      land = {
        t,
        rack: c.input.steer,               // what the TYRES were handed
        airSteer: c.input.airSteer,        // what the ROLL axis was using
        angle: c._steerAngle() * R2D,      // actual front-wheel angle, degrees
        hdg: heading(c.body.quat),
        yawRate: c.body.angVel.y,
        slip: c.slipAngle * R2D,
      };
    }
    if (land) {
      const dt = t - land.t;
      if (dt <= 1.0) {
        const d = heading(c.body.quat) - land.hdg;
        if (Math.abs(d) > Math.abs(land.swing ?? 0)) land.swing = d;
      }
    }
  }
  return land ?? {};
}

const f = (v, w = 7, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : "—").padStart(w);

console.log("=== WHAT THE TYRES ARE HANDED AT TOUCHDOWN ===");
console.log("Steer key held in the AIR (to roll), released the moment the wheels land.\n");
console.log("  air input        rack at land   front wheels   yaw rate   slip    heading swing");
for (const [label, air] of [
  ["none", 0],
  ["left  held", 1],
  ["right held", -1],
]) {
  const r = jump({ air });
  console.log(
    `  ${label.padEnd(16)} ${f(r.rack, 7, 2)}      ${f(r.angle)}°      ${f(r.yawRate, 6, 2)}   ${f(r.slip, 6)}°   ${f(r.swing)}°`,
  );
}
console.log("\n  'rack at land' is input.steer, i.e. how far the steering rack has wound");
console.log("  itself while the player was only asking for ROLL. 1.0 is full lock.");

console.log("\n=== HOW LONG IN THE AIR IS ENOUGH TO WIND IT UP? ===");
// The rack ramps at steerAttack (7/s, further cut by steerRateSpeedDrop), so
// this is really "how long is the jump" — and any real jump is long enough.
{
  console.log("  key held   rack at land   front wheels   heading swing after landing");
  for (const hold of [0.1, 0.2, 0.4, 0.8, Infinity]) {
    const r = jump({ air: 1, holdFor: hold });
    const name = hold === Infinity ? "all flight" : `${hold.toFixed(1)}s`;
    console.log(`  ${name.padEnd(10)} ${f(r.rack, 7, 2)}      ${f(r.angle)}°      ${f(r.swing)}°`);
  }
}

console.log("\n=== IS IT THE RACK, OR SOMETHING ELSE ABOUT LANDING? ===");
// Separate the two candidate causes by neutering each in turn:
//   • zero steerAttack  → the rack cannot wind up at all, but the car still
//     lands with whatever attitude and yaw rate the roll gave it.
//   • zero air roll     → no roll at all, so no attitude, but the rack still
//     winds (the key is still held).
{
  const save = { atk: TIRE.steerAttack, roll: TIRE.airRollRate };
  const row = (label) => {
    const r = jump({ air: 1 });
    console.log(`  ${label.padEnd(30)} rack ${f(r.rack, 5, 2)}   wheels ${f(r.angle)}°   swing ${f(r.swing)}°`);
  };
  row("as shipped");
  TIRE.steerAttack = 0.0001; // rack effectively frozen
  row("rack cannot wind (steerAttack~0)");
  TIRE.steerAttack = save.atk;
  TIRE.airRollRate = 0;
  row("no air roll (airRollRate 0)");
  TIRE.airRollRate = save.roll;
  console.log("\n  Whichever row collapses the swing is the cause. If it is the rack row,");
  console.log("  the car is landing with its wheels already turned and the fix is to stop");
  console.log("  the AIR input driving the ground steering rack.");
}

console.log("\n=== THE THINGS THE FIX COULD BREAK ===");
// Returning the rack to centre in the air is only correct if it leaves the two
// legitimate cases alone: a short hop taken mid-corner, and a player who is
// genuinely steering as they land.
{
  /**
   * Hop over a crest with the steering HELD the whole way, and report how much
   * lock survives. `airFor` is how long the wheels are off the ground.
   */
  const hop = (airFor) => {
    const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
    c.groundBvh = ground; c.enabled = true;
    c.body.pos.set(0, 0.55, 0);
    c.body.vel.set(0, 0, 30);
    c.body.quat.identity();
    // Settle on the ground with full lock wound on, so there is something to lose.
    for (let i = 0; i < 1.0 / FIXED_DT; i++) {
      c.tick({ steerTarget: 1, throttle: 0.4, handbrake: false, yaw: 0, pitch: 0 });
    }
    const before = c.input.steer;
    // Launch, stay airborne for `airFor`, keeping the key held throughout.
    c.body.vel.y = 0.5 * GRAV * airFor; // up-speed for a ballistic hop of that length
    // PEAK, not the final value: _rackAirTime resets the moment the tyres take
    // load again, so sampling it after the hop always reads 0.
    let peakAir = 0;
    for (let i = 0; i < airFor / FIXED_DT; i++) {
      c.tick({ steerTarget: 1, throttle: 0.4, handbrake: false, yaw: 0, pitch: 0 });
      peakAir = Math.max(peakAir, c._rackAirTime);
    }
    return { before, after: c.input.steer, air: peakAir };
  };
  const GRAV = 9.81;
  // The x-axis is `_rackAirTime`, NOT the launch duration: the suspension stays
  // loaded for part of a small hop, so the time the car is genuinely UNSUPPORTED
  // is shorter than the time it spends off its rest height. Reporting the launch
  // figure made a 0.35 s hop look like it kept 100% "for free".
  console.log("  launch   unsupported   lock before   at touchdown   kept");
  for (const t of [0.10, 0.20, 0.35, 0.60, 1.20]) {
    const r = hop(t);
    const kept = r.before > 1e-6 ? (r.after / r.before) * 100 : 0;
    console.log(`  ${t.toFixed(2)}s     ${f(r.air, 6, 2)}s       ${f(r.before, 6, 2)}       ${f(r.after, 6, 2)}        ${f(kept, 5, 0)}%`);
  }
  console.log("\n  Short hops must keep their lock — that is a corner with a bump in it,");
  console.log(`  not a jump. The grace is ${TIRE.airSteerCenterDelay}s.`);

  // …and steering that is actually asked for on landing must still arrive.
  const steerOnLanding = () => {
    const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
    c.groundBvh = ground; c.enabled = true;
    c.body.pos.set(0, 8, 0); c.body.vel.set(0, 5, 35); c.body.quat.identity();
    let land = null, at200 = 0;
    for (let i = 0; i < 4 / FIXED_DT; i++) {
      const t = i * FIXED_DT;
      // Holding right the WHOLE time, through the air and after landing.
      c.tick({ steerTarget: 1, throttle: 0.4, handbrake: false, yaw: 0, pitch: 0 });
      if (!land && c.groundedCount >= 3) land = t;
      if (land && t - land >= 0.2 && !at200) at200 = c._steerAngle() * R2D;
    }
    return at200;
  };
  console.log(`\n  holding steer THROUGH the landing: ${steerOnLanding().toFixed(1)}° of lock`
    + " 200 ms after touchdown");
  console.log("  (it winds up from the ground on steerAttack — ordinary turn-in.)");
}

console.log("\n=== HOW FAST DOES THE RACK UNWIND ONCE YOU LET GO? ===");
// Even if you release on touchdown, steerRelease decides how long the car keeps
// turning. This is the "it kept going after I let go" half of the complaint.
{
  const r = jump({ air: 1 });
  const tau = 1 / TIRE.steerRelease;
  console.log(`  steerRelease ${TIRE.steerRelease}/s → ${(tau * 1000).toFixed(0)} ms time constant;`
    + ` from ${f(r.rack, 4, 2)} it takes ~${(Math.log(r.rack / 0.05) / TIRE.steerRelease * 1000).toFixed(0)} ms`
    + " to fall under 0.05.");
  console.log("  At 35 m/s that is several car lengths of unrequested steering.");
}
