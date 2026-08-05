// The climb ceiling, and what actually moves it.
//
// The car does not lose speed on a hill because it runs out of ENGINE — it runs
// out of REAR TYRE. RWD puts all 16 kN of drive on an axle carrying ~53% of the
// load, so the most thrust that can ever reach the road is μ · N_rear, and above
// a critical grade that is less than gravity down the slope. Then it is a death
// spiral: slower → less downforce → less load → less thrust → slower.
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = join(ROOT, `.slim.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, TIRE, AERO, CHASSIS, GRAVITY, FIXED_DT, DRIVETRAIN } =
  await import(pathToFileURL(TMP).href);
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
    spherecast() { return null; },
    closestPointWithNormal() { return null; },
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

/** Full throttle up the fall line. Returns the settled speed (0 = stalled). */
function climb(deg, v0, secs = 25) {
  const th = deg * D2R;
  const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  c.groundBvh = slopeGround(deg); c.enabled = true;
  c.body.pos.set(0, 0.65 / Math.cos(th), 0);
  c.body.quat.setFromEuler(new THREE.Euler(-th, Math.PI, 0, "YXZ"));
  c.body.vel.set(0, v0 * Math.sin(th), -v0 * Math.cos(th));
  // Up-slope unit vector in WORLD space — the car's own forward is not usable as
  // a reference here (it pitches, and it is what we are testing).
  const up = new THREE.Vector3(0, Math.sin(th), -Math.cos(th));
  let slid = false, minV = Infinity;
  for (let i = 0; i < Math.round(secs / FIXED_DT); i++) {
    c.tick({ steerTarget: 0, throttle: 1, handbrake: false, yaw: 0, pitch: 0 });
    const v = c.body.vel.dot(up);
    if (i > 60) minV = Math.min(minV, v);
    if (v < -0.5) slid = true;
  }
  return { v: c.body.vel.dot(up), min: minV, slid };
}

/** Steepest grade still climbable from a 12 m/s crawl, to 0.5°. */
function ceiling(label) {
  let lo = 0, hi = 70;
  for (let i = 0; i < 8; i++) {
    const mid = (lo + hi) / 2;
    if (climb(mid, 12, 20).v > 12) lo = mid; else hi = mid;
  }
  console.log(`  ${label.padEnd(34)} ${lo.toFixed(1).padStart(5)}°  (grade ${(Math.tan(lo * D2R) * 100).toFixed(0)}%)`);
  return lo;
}

const W = CHASSIS.mass * GRAVITY;
console.log("=== WHERE THE THRUST CEILING COMES FROM ===");
console.log(`  weight                    ${(W / 1000).toFixed(2)} kN`);
console.log(`  engine at v=0             ${(4 * TIRE.accelForce / 1000).toFixed(2)} kN  (4 wheels x accelForce)`);
console.log(`  rear axle static load     ${(W * 0.528 / 1000).toFixed(2)} kN  (measured 47/53 split)`);
console.log(`  RWD thrust ceiling        ${(TIRE.frictionCoeff * W * 0.528 / 1000).toFixed(2)} kN  = mu x N_rear  <-- THE LIMIT`);
console.log(`  AWD thrust ceiling        ${(TIRE.frictionCoeff * W / 1000).toFixed(2)} kN  = mu x N_total`);
console.log(`  predicted RWD crit grade  ${(Math.atan(TIRE.frictionCoeff * 0.528) / D2R).toFixed(1)}°`);
console.log(`  predicted AWD crit grade  ${(Math.atan(TIRE.frictionCoeff) / D2R).toFixed(1)}°`);

console.log("\n=== MEASURED CEILING (steepest grade held from a 12 m/s crawl) ===");
const base = ceiling(`SHIPPED (${DRIVETRAIN.layout}, mu ${TIRE.frictionCoeff})`);

DRIVETRAIN.layout = "AWD"; DRIVETRAIN.powerBias = 0.6;
ceiling("AWD, powerBias 0.6");
DRIVETRAIN.layout = "RWD";

const mu0 = TIRE.frictionCoeff;
TIRE.frictionCoeff = 2.2;
ceiling("RWD, frictionCoeff 2.2");
TIRE.frictionCoeff = mu0;

const df0 = AERO.downforce;
AERO.downforce = 12;
ceiling("RWD, downforce 12 (was 3)");
AERO.downforce = df0;

console.log("\n=== SETTLED SPEED ENTERING AT 45 m/s (162 km/h), SHIPPED SETUP ===");
console.log("  grade   settled km/h   note");
for (const deg of [10, 15, 20, 25, 27.4, 30, 35, 38, 40, 45]) {
  const r = climb(deg, 45, 25);
  const tag = r.v < 1 ? "  <-- STALLS / ROLLS BACK" : r.v < 15 ? "  <-- bogged" : "";
  console.log(`  ${deg.toFixed(1).padStart(5)}°  ${(Math.max(0, r.v) * 3.6).toFixed(0).padStart(10)}${tag}`);
}

console.log("\n=== WHAT THE KIT ACTUALLY BUILDS ===");
// slopePoints() uses smootherstep, whose peak derivative is 1.5 x H/L.
for (const [L, H] of [[26, 9], [26, 12], [26, 15], [26, 18], [20, 9], [40, 9]]) {
  const peak = Math.atan(1.5 * H / L) / D2R;
  console.log(`  slopeLength ${String(L).padStart(2)}  slopeRise ${String(H).padStart(2)}  -> peak grade ${peak.toFixed(1)}°` +
    `${peak > base ? "   OVER THE CEILING" : ""}`);
}
console.log(`  loop / ring (any radius) -> sweeps 0..90..180°   ALWAYS over the ceiling; it is pure momentum`);
