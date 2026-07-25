// Donuts — can the car pivot in a tight circle, and is high-speed feel intact?
//
// THE FIX WAS STEERING LOCK, NOT DRIFT TUNING. The tightest circle a car can
// pivot is geometric: wheelbase / tan(lock). At the old 0.55 rad (31.5°) that
// floor was 4.6 m and the measured circle was 6.7 m — a donut needs ~2–4 m, so
// it was unreachable no matter how the drift physics was tuned.
//
// Counter-intuitive result worth keeping: WEAKENING the yaw assist makes donuts
// WORSE (3.9 m at full assist → 6.1 m with it off). The assist keeps the nose
// aligned so the car turns properly instead of ploughing. Don't "fix" donuts by
// turning it down.
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = join(ROOT, `.donut.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, TIRE, FIXED_DT } = await import(pathToFileURL(TMP).href);
unlinkSync(TMP);

let fail = 0;
const check = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); if (!c) fail++; };
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

/** Full lock + throttle from a crawl, held. Returns the settled circle. */
function donut({ handbrake = false } = {}) {
  const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  c.groundBvh = ground; c.enabled = true;
  c.body.pos.set(0, 0.6, 0); c.body.vel.set(0, 0, -3);
  c.body.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
  const s = c.body.pos.clone();
  let maxR = 0, total = 0, slipSum = 0, n = 0;
  for (let i = 0; i < 900; i++) {
    c.tick({ steerTarget: 1, throttle: 1, handbrake, yaw: 0, pitch: 0 });
    total += c.body.angVel.y * FIXED_DT;
    maxR = Math.max(maxR, Math.hypot(c.body.pos.x - s.x, c.body.pos.z - s.z));
    if (i > 300) { slipSum += Math.abs(c.slipAngle); n++; } // steady state only
  }
  return { r: maxR / 2, turns: Math.abs(total) / (2 * Math.PI), slip: (slipSum / n) * R2D };
}
/** Steer angle actually delivered at a given forward speed. */
function lockAt(v) {
  const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  c.body.vel.set(0, 0, v); c.body.quat.identity(); c.input.steer = 1;
  return c._steerAngle() * R2D;
}

console.log("=== DONUT ===");
const d = donut();
console.log(`  throttle only: ${d.turns.toFixed(1)} turns, radius ${d.r.toFixed(1)} m, mean slip ${d.slip.toFixed(0)}°`);
const hb = donut({ handbrake: true });
console.log(`  with handbrake: ${hb.turns.toFixed(1)} turns, radius ${hb.r.toFixed(1)} m, mean slip ${hb.slip.toFixed(0)}°`);

check("pivots in a donut-sized circle (was 6.7 m before the lock fix)", d.r < 4.5, `${d.r.toFixed(1)} m`);
check("keeps rotating rather than washing out", d.turns >= 1.5, `${d.turns.toFixed(1)} turns`);
check("handbrake tightens it further (that's how you'd really do it)",
  hb.r < d.r, `${d.r.toFixed(1)} m → ${hb.r.toFixed(1)} m`);
check("the circle is stable, not spiralling out", d.r < 4.5 && d.turns >= 1.5);

console.log("\n=== HIGH-SPEED FEEL MUST BE UNCHANGED ===");
console.log("  speed      lock");
for (const v of [0, 10, 25, 45]) console.log(`  ${String(v).padStart(2)} m/s   ${lockAt(v).toFixed(1).padStart(5)}°`);
check("standstill lock is drift-car wide (~54°)", Math.abs(lockAt(0) - 54.4) < 1, `${lockAt(0).toFixed(1)}°`);
check("top-speed lock unchanged (~16°, was 15.8° at the old settings)",
  Math.abs(lockAt(45) - 15.8) < 1.0, `${lockAt(45).toFixed(1)}°`);
const need = Math.atan(2.8 / 26) * R2D;
check("ample margin for the kit's tightest 26 m curve", lockAt(30) > need * 2,
  `${lockAt(30).toFixed(1)}° available vs ${need.toFixed(1)}° needed`);

console.log("\n=== maxSteerAngle AND steerSpeedReduce ARE A PAIR ===");
{
  const savedR = TIRE.steerSpeedReduce;
  TIRE.steerSpeedReduce = 0.5; // the old value against the new lock
  const leaked = lockAt(45);
  TIRE.steerSpeedReduce = savedR;
  check("raising lock without raising the reduction would leak into high speed",
    leaked > 25, `${leaked.toFixed(1)}° at top speed vs the intended ${lockAt(45).toFixed(1)}°`);
}

console.log(fail ? `\n${fail} FAILURE(S)` : "\nall green");
process.exit(fail ? 1 : 0);
