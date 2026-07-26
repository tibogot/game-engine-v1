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

// ── THE WHOLE CURVE, NOT ITS ENDPOINTS ──────────────────────────────────────
// A previous donut fix raised maxSteerAngle 0.55 → 0.95 and raised
// steerSpeedReduce 0.50 → 0.70 to compensate, then verified ONLY that top speed
// still landed on ~16°. It did. But the reduction is linear in speed, so the
// middle of the range — where the car is actually driven — silently gained
// 38–64% more lock and the car became twitchy and hard to control.
//
// Checking both ends of a curve does not check the curve. So this samples the
// whole range against the pre-donut reference and demands they match ABOVE the
// boost's cutoff, which is the only region ordinary driving happens in.
const PRE_DONUT = (v) => 0.55 * (1 - 0.50 * Math.min(1, v / 45)) * R2D;

console.log("\n=== DRIVING FEEL: MUST MATCH THE PRE-DONUT CURVE ABOVE THE CUTOFF ===");
console.log("  speed   pre-donut     now     delta");
let maxDelta = 0;
for (let v = 0; v <= 45; v += 2.5) {
  const ref = PRE_DONUT(v), now = lockAt(v);
  const d = now - ref;
  if (v >= TIRE.lowSpeedLockRef) maxDelta = Math.max(maxDelta, Math.abs(d));
  const tag = v < TIRE.lowSpeedLockRef ? "  (boost)" : (Math.abs(d) < 0.05 ? "  =" : "  ← DRIFTED");
  console.log(`  ${String(v).padStart(4)}  ${ref.toFixed(1).padStart(8)}  ${now.toFixed(1).padStart(7)}  ${d >= 0 ? "+" : ""}${d.toFixed(1).padStart(6)}${tag}`);
}
check("EVERY speed at/above the cutoff matches the pre-donut curve exactly",
  maxDelta < 0.05, `worst deviation ${maxDelta.toFixed(3)}° over ${TIRE.lowSpeedLockRef}→45 m/s`);
check("the boost is strictly additive — it can never REDUCE lock anywhere",
  Array.from({ length: 46 }, (_, v) => lockAt(v) >= PRE_DONUT(v) - 1e-6).every(Boolean));
check("lock is monotonically decreasing with speed (no bump to steer through)",
  Array.from({ length: 45 }, (_, v) => lockAt(v) >= lockAt(v + 1) - 1e-6).every(Boolean));

console.log("\n=== THE TWO ENDS STILL DO THEIR JOBS ===");
check("standstill lock is drift-car wide (~54°)", Math.abs(lockAt(0) - 54.4) < 1, `${lockAt(0).toFixed(1)}°`);
check("still ~50° at the 4 m/s a donut is actually held at",
  lockAt(4) > 45, `${lockAt(4).toFixed(1)}°`);
check("top-speed lock is the original 15.8°, not merely close to it",
  Math.abs(lockAt(45) - 15.8) < 0.05, `${lockAt(45).toFixed(1)}°`);
const need = Math.atan(2.8 / 26) * R2D;
check("ample margin for the kit's tightest 26 m curve", lockAt(30) > need * 2,
  `${lockAt(30).toFixed(1)}° available vs ${need.toFixed(1)}° needed`);

console.log("\n=== THE BOOST IS WHAT MAKES DONUTS POSSIBLE ===");
{
  const saved = TIRE.lowSpeedExtraLock;
  TIRE.lowSpeedExtraLock = 0;
  const without = donut();
  TIRE.lowSpeedExtraLock = saved;
  check("removing the boost widens the circle back out of donut range",
    without.r > d.r, `${d.r.toFixed(1)} m with boost → ${without.r.toFixed(1)} m without`);
}

console.log(fail ? `\n${fail} FAILURE(S)` : "\nall green");
process.exit(fail ? 1 : 0);
