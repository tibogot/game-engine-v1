// Does per-wheel (Ackermann) steering change how the car turns?
//
// Both front tyres used to receive one identical angle, which is only correct
// for a turn of infinite radius. The inside wheel traces a tighter circle and
// must be turned further; steering them in parallel makes the two fight and
// scrub. The error scales with lock, so it is nothing in ordinary cornering and
// large at the standstill lock this car runs for donuts:
//
//     commanded   ideal inner   ideal outer   spread
//        11.5°        12.3°         10.8°       1.5°
//        54.4°        68.9°         43.8°      25.1°
//
// This measures the consequence rather than the geometry: circle radius held at
// a given lock and speed, with TIRE.ackermann at 0 (the old parallel steering)
// and 1 (true geometry). The mid-speed rows are the regression guard — if those
// move much, this changed ordinary driving, which it has no business doing.
//
// An instrument, not a pass/fail test.
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = join(ROOT, `.ackermann.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, TIRE, FIXED_DT } = await import(pathToFileURL(TMP).href);
unlinkSync(TMP);

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
 * Hold full steer + throttle and fit a circle to the path the car settles on.
 * Radius comes from the LAST lap of travel, so the entry transient is excluded.
 */
function circle({ steer = 1, throttle = 1, secs = 14, sampleAfter = 8 }) {
  const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  c.groundBvh = ground; c.enabled = true;
  c.body.pos.set(0, 0.6, 0);
  c.body.quat.identity();
  c._resetInterpolation();

  const pts = [];
  let t = 0;
  let peakSpeed = 0;
  while (t < secs) {
    c.tick({ steerTarget: steer, rollTarget: 0, throttle, handbrake: false, yaw: 0, pitch: 0 });
    t += FIXED_DT;
    const sp = Math.hypot(c.body.vel.x, c.body.vel.z);
    if (sp > peakSpeed) peakSpeed = sp;
    if (t >= sampleAfter) pts.push({ x: c.body.pos.x, z: c.body.pos.z });
  }
  if (pts.length < 20) return { radius: NaN, speed: 0 };
  // Algebraic circle fit (Kasa) over the settled path.
  let sx = 0, sz = 0;
  for (const p of pts) { sx += p.x; sz += p.z; }
  const mx = sx / pts.length, mz = sz / pts.length;
  let Suu = 0, Svv = 0, Suv = 0, Suuu = 0, Svvv = 0, Suvv = 0, Svuu = 0;
  for (const p of pts) {
    const u = p.x - mx, v = p.z - mz;
    Suu += u * u; Svv += v * v; Suv += u * v;
    Suuu += u * u * u; Svvv += v * v * v; Suvv += u * v * v; Svuu += v * u * u;
  }
  const det = 2 * (Suu * Svv - Suv * Suv);
  if (Math.abs(det) < 1e-9) return { radius: NaN, speed: 0 };
  const uc = (Svv * (Suuu + Suvv) - Suv * (Svvv + Svuu)) / det;
  const vc = (Suu * (Svvv + Svuu) - Suv * (Suuu + Suvv)) / det;
  const radius = Math.sqrt(uc * uc + vc * vc + (Suu + Svv) / pts.length);
  const finalSpeed = Math.hypot(c.body.vel.x, c.body.vel.z);
  return { radius, speed: finalSpeed, peakSpeed };
}

const cases = [
  ["full lock, full throttle (donut)", { steer: 1, throttle: 1 }],
  ["full lock, light throttle",        { steer: 1, throttle: 0.35 }],
  ["half lock, full throttle",         { steer: 0.5, throttle: 1 }],
  ["quarter lock, full throttle",      { steer: 0.25, throttle: 1 }],
];

console.log("case                                | ackermann 0 (parallel) | ackermann 1 (geometric) | change");
console.log("                                    |  radius     speed      |  radius     speed       |");
for (const [name, cfg] of cases) {
  TIRE.ackermann = 0;
  const a = circle(cfg);
  TIRE.ackermann = 1;
  const b = circle(cfg);
  const dr = ((b.radius - a.radius) / a.radius) * 100;
  console.log(
    `${name.padEnd(35)} | ${a.radius.toFixed(2).padStart(7)} m ${a.speed.toFixed(1).padStart(6)} m/s |`
    + ` ${b.radius.toFixed(2).padStart(7)} m ${b.speed.toFixed(1).padStart(6)} m/s |`
    + ` ${(dr >= 0 ? "+" : "") + dr.toFixed(1)}%`,
  );
}
console.log("\nThe low-lock rows should barely move — Ackermann is a big-lock effect.");
