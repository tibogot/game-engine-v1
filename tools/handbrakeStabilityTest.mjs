// HOLDING THE HANDBRAKE MUST NOT SPIN THE CAR ON ITS OWN — and must still drift.
//
// Both halves matter, and a one-sided test is worthless here: raising the assist
// until the spin stops is trivial if you are allowed to kill the slide with it.
//
// THE BUG THIS GUARDS. `driftYawAssistMul` scales the yaw-rate damping while the
// handbrake is down. At 0.25 the car was directionally UNSTABLE the whole time
// Space was held — not "unstable if provoked". Holding it dead straight with no
// input at all, the yaw rate grew from 2.3e-17 (floating-point round-off) by ~25×
// per second, steadily, through thirteen orders of magnitude, until at ~12 s it
// became a visible spin:
//
//     t 0  v40  yawRate 2.34e-17      t 8  v28  yawRate 2.10e-5
//     t 4  v34  yawRate 6.19e-11      t10  v25  yawRate 5.07e-3
//     t 6  v31  yawRate 4.76e-8       t12  v22  yawRate 6.34e-1   <- spins
//
// So the delay is not a timer, it is how long noise takes to grow — which is why
// it read as "the car starts turning on its own after some time", and why a
// SHORT test cannot see it. Anything under ~12 s here proves nothing.
//
// It also fought the scoring directly: driftScore.js loses the chain past 110° of
// slip and wants ~17.5 s of unbroken slide for the full multiplier.
//
// Run: node tools/handbrakeStabilityTest.mjs
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const R2D = 57.2958;
const TMP = join(ROOT, `.hbs.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, FIXED_DT, TIRE } = await import(pathToFileURL(TMP).href);
const { RoadBvh } = await import(pathToFileURL(join(ROOT, "v3/play/modularRoadBvh.js")).href);
const { DRIFT_SCORE } = await import(
  pathToFileURL(join(ROOT, "games/modular-road-v3/driftScore.js")).href);
unlinkSync(TMP);

let fail = 0;
const check = (n, c, d = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`);
  if (!c) fail++;
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

const plane = new THREE.PlaneGeometry(8000, 8000);
plane.rotateX(-Math.PI / 2);
const bvh = new RoadBvh();
bvh.bakeFromMeshes([(() => {
  const m = new THREE.Mesh(plane, new THREE.MeshBasicMaterial());
  m.updateMatrixWorld(true); return m;
})()]);

const SPIN = DRIFT_SCORE.spinAngle * R2D;

/** Accelerate from rest like a player, then apply the inputs under test. */
function drive({ steer = 0, throttle = 0, handbrake = false, secs }) {
  const car = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  car.setBvh(bvh, null);
  car.getFloorY = () => -50;
  car.enabled = true;
  car.body.pos.set(0, 0.65, 0);
  car.body.quat.identity();
  car.body.vel.set(0, 0, 0);
  car._resetInterpolation();
  for (let i = 0; i < Math.round(20 / FIXED_DT); i++) {
    car.tick({ steerTarget: 0, throttle: 1, handbrake: false, yaw: 0, pitch: 0 });
    car.syncVisuals(FIXED_DT, 1);
    if (car.body.vel.length() >= 40) break;
  }
  const f0 = new THREE.Vector3(0, 0, 1).applyQuaternion(car.body.quat);
  const h0 = Math.atan2(f0.x, f0.z);

  let peakSlip = 0, peakYaw = 0, slideTime = 0;
  const fwd = new THREE.Vector3();
  for (let i = 0; i < Math.round(secs / FIXED_DT); i++) {
    car.tick({ steerTarget: steer, throttle, handbrake, yaw: 0, pitch: 0 });
    car.syncVisuals(FIXED_DT, 1);
    const a = Math.abs(car.slipAngle) * R2D;
    peakSlip = Math.max(peakSlip, a);
    peakYaw = Math.max(peakYaw, Math.abs(car.body.angVel.y));
    if (a > 8 && a < SPIN) slideTime += FIXED_DT;
  }
  fwd.set(0, 0, 1).applyQuaternion(car.body.quat);
  let dh = (Math.atan2(fwd.x, fwd.z) - h0) * R2D;
  while (dh > 180) dh -= 360; while (dh < -180) dh += 360;
  return { drift: Math.abs(dh), peakSlip, peakYaw, slideTime };
}

console.log(`\n  driftYawAssistMul ${TIRE.driftYawAssistMul} · gripHandbrake ${TIRE.gripHandbrake}`);
console.log(`  drift chain lost past ${SPIN.toFixed(0)}° of slip; full multiplier needs ` +
  `~${(DRIFT_SCORE.comboStep * DRIFT_SCORE.maxMultiplier).toFixed(1)} s of unbroken slide\n`);

// ── 1. IT MUST NOT SPIN ITSELF ──────────────────────────────────────────────
// 15 s, deliberately: the growth is exponential from round-off, so a 6 s test
// sits at 5e-8 rad/s and reports a clean pass on a car that is about to spin.
console.log("=== accelerate, release the throttle, hold ONLY the handbrake (15 s) ===\n");
const straight = drive({ handbrake: true, secs: 15 });
console.log(`  drift ${straight.drift.toFixed(0)}°   peak slip ${straight.peakSlip.toFixed(0)}°   ` +
  `peak yaw rate ${straight.peakYaw.toExponential(1)} rad/s\n`);
check("holding the handbrake straight does not turn the car",
  straight.drift < 15, `${straight.drift.toFixed(0)}° over 15 s (was 61° at driftYawAssistMul 0.25)`);
check("...and never reaches the angle that breaks a drift chain",
  straight.peakSlip < SPIN, `peak slip ${straight.peakSlip.toFixed(0)}° vs ${SPIN.toFixed(0)}°`);

// ── 2. AND IT MUST STILL DRIFT ──────────────────────────────────────────────
// The half that makes the first half meaningful. Killing the slide would pass
// every check above and ruin the game.
console.log("\n=== steer into it with the handbrake down — the rear must still go ===\n");
const steered = drive({ steer: 0.6, throttle: 0.6, handbrake: true, secs: 8 });
console.log(`  peak slip ${steered.peakSlip.toFixed(0)}°   ` +
  `time in the scoring window ${steered.slideTime.toFixed(1)} s\n`);
check("the handbrake still breaks the rear away on demand",
  steered.peakSlip > 90, `peak slip ${steered.peakSlip.toFixed(0)}° — initiation comes from ` +
  `gripHandbrake (${TIRE.gripHandbrake}), which this must not quietly compensate for`);
check("and there is real time inside the drift-scoring window",
  steered.slideTime > 3, `${steered.slideTime.toFixed(1)} s between 8° and ${SPIN.toFixed(0)}°`);

console.log(fail ? `\n${fail} FAILURE(S)\n` : "\nall green\n");
process.exit(fail ? 1 : 0);
