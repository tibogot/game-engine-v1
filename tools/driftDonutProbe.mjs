// Why is a held donut a GRIP circle rather than a DRIFT?
//
// Reported: "it does a circle, but the speed drops and it doesn't look like the
// steady, constant-speed donuts in drift videos". Correct — donutTest measures a
// mean slip angle of 14°, and 14° is a cornering car. A real drift donut holds
// 30-60° of slip at a roughly constant speed, with the rear sliding the whole
// time and the throttle balancing the scrub.
//
// The suspects are the arcade stability layer, which exists precisely to stop
// large slip angles:
//   TIRE.alignTorque      12000 N·m per rad past a 4.6° deadband, pulling the
//                         nose back onto the velocity vector
//   TIRE.slipClampTorque  30000 N·m per rad past slipMax (40°), a hard wall
//   TIRE.yawRateDamp       4000 N·m per rad/s of yaw-rate error
//   TIRE.driftYawAssistMul  0.70 — how much of the above survives the handbrake
// and the grip split (gripRear / gripHandbrake) that decides whether the rear
// can break away at all.
//
// This sweeps them and reports what actually comes out: slip angle held, whether
// SPEED IS STEADY (the thing the report is really about), and whether the car
// stays controllable or spins. Note the known trap recorded in the tuning
// history — driftYawAssistMul 0.25 made the car directionally unstable, with the
// yaw rate growing ~25x/s from floating-point noise until it span at ~12 s. So a
// row that drifts beautifully for 6 s is not automatically a shippable setting.
//
// An instrument, not a pass/fail test.
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = join(ROOT, `.drift.${process.pid}.mjs`);
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

/**
 * Hold full lock + throttle (+ handbrake) from a crawl for `secs`, then report
 * the SETTLED behaviour over the back half.
 */
function donut({ handbrake = false, secs = 16 } = {}) {
  const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  c.groundBvh = ground; c.enabled = true;
  c.body.pos.set(0, 0.6, 0);
  c.body.quat.identity();
  c.body.vel.set(0, 0, 3);
  c._resetInterpolation();

  let t = 0;
  const slips = [], speeds = [];
  let spun = false;
  while (t < secs) {
    c.tick({ steerTarget: 1, rollTarget: 0, throttle: 1, handbrake, yaw: 0, pitch: 0 });
    t += FIXED_DT;
    if (t < secs * 0.5) continue;
    const slip = Math.abs(c.slipAngle) * R2D;
    slips.push(slip);
    speeds.push(Math.hypot(c.body.vel.x, c.body.vel.z));
    if (Math.abs(c.body.angVel.y) > 6) spun = true;
  }
  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const sMin = Math.min(...speeds), sMax = Math.max(...speeds);
  return {
    slip: mean(slips),
    speed: mean(speeds),
    // "Constant speed" is the whole complaint — this is how steady it actually is.
    speedSwing: sMax - sMin,
    steady: (sMax - sMin) / Math.max(0.1, mean(speeds)),
    spun,
  };
}

const base = { mul: TIRE.driftYawAssistMul, rear: TIRE.gripRear, hb: TIRE.gripHandbrake, assist: TIRE.yawAssist };
const rows = [];
const run = (label, patch, hb) => {
  Object.assign(TIRE, base, patch);
  const r = donut({ handbrake: hb });
  rows.push({ label, hb, ...r });
  Object.assign(TIRE, base);
};

run("SHIPPED", {}, false);
run("SHIPPED", {}, true);
run("driftYawAssistMul 0.40", { driftYawAssistMul: 0.40 }, true);
run("driftYawAssistMul 0.20", { driftYawAssistMul: 0.20 }, true);
run("driftYawAssistMul 0.00", { driftYawAssistMul: 0.00 }, true);
run("yawAssist 0 (no stability at all)", { yawAssist: 0 }, true);
run("gripHandbrake 0.20 (looser rear)", { gripHandbrake: 0.20 }, true);
run("gripRear 0.75 (loose rear, no hb)", { gripRear: 0.75 }, false);

console.log("A real drift donut = big slip, STEADY speed, no spin.\n");
console.log("setting                              hb |  slip   speed  swing  steady?  spun");
for (const r of rows) {
  console.log(
    `${r.label.padEnd(36)} ${r.hb ? "Y" : "n"} | ${r.slip.toFixed(0).padStart(4)}° `
    + `${r.speed.toFixed(1).padStart(6)} ${r.speedSwing.toFixed(2).padStart(6)} `
    + `${(r.steady < 0.1 ? "steady" : "varies").padStart(7)}  ${r.spun ? "SPUN" : "-"}`,
  );
}
Object.assign(TIRE, base);
console.log("\nswing = max-min speed over the settled half (m/s). 'steady' = under 10% of mean.");

// ── WHY 14°: IT IS NOT THE ASSIST, IT IS THE SPEED ────────────────────────
// Slip only exists if the lateral demand exceeds what the rear can hold.
// Demand is v^2/r, so a tight slow circle asks for almost nothing:
//     3 m/s in a 2.0 m circle -> 4.5 m/s^2 = 0.46 g
// and the handbraked rear can hold mu 1.5 x 0.35 = 0.53 g. The rear is inside
// its budget, so it grips, and a gripping car has a small slip angle no matter
// what the stability layer is doing. That is why yawAssist 0 changed nothing.
//
// A real drift donut is the opposite trade: MORE speed on LESS lock, so the
// demand clears the rear's budget and stays there.
function entry({ speed, steer, handbrake, secs = 14 }) {
  const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  c.groundBvh = ground; c.enabled = true;
  c.body.pos.set(0, 0.6, 0);
  c.body.quat.identity();
  c.body.vel.set(0, 0, speed);
  c._resetInterpolation();
  let t = 0;
  const slips = [], speeds = [];
  let spun = false;
  while (t < secs) {
    c.tick({ steerTarget: steer, rollTarget: 0, throttle: 1, handbrake, yaw: 0, pitch: 0 });
    t += FIXED_DT;
    if (t < secs * 0.5) continue;
    slips.push(Math.abs(c.slipAngle) * R2D);
    speeds.push(Math.hypot(c.body.vel.x, c.body.vel.z));
    if (Math.abs(c.body.angVel.y) > 6) spun = true;
  }
  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const sMin = Math.min(...speeds), sMax = Math.max(...speeds);
  const m = mean(speeds);
  return { slip: mean(slips), speed: m, swing: sMax - sMin, steady: (sMax - sMin) / Math.max(0.1, m) < 0.1, spun };
}

console.log("\n\nENTERING WITH SPEED, on less than full lock (the real technique)\n");
console.log("entry  lock  hb |  slip   speed  swing  steady?  spun");
for (const sp of [10, 18, 26]) {
  for (const st of [0.35, 0.6]) {
    for (const hb of [true, false]) {
      const r = entry({ speed: sp, steer: st, handbrake: hb });
      console.log(
        `${String(sp).padStart(4)}  ${st.toFixed(2)}   ${hb ? "Y" : "n"} | ${r.slip.toFixed(0).padStart(4)}° `
        + `${r.speed.toFixed(1).padStart(6)} ${r.swing.toFixed(2).padStart(6)} `
        + `${(r.steady ? "steady" : "varies").padStart(7)}  ${r.spun ? "SPUN" : "-"}`,
      );
    }
  }
}
