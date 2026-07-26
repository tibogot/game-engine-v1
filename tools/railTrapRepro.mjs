// Diagnostic: WHY does the car still get trapped on a guardrail?
//
// Two previous fixes missed because both were reasoned about, not measured
// against the REAL geometry. This builds the actual kit guardrail, bakes it into
// the actual RoadBvh the game uses, drops the car on it from a range of angles
// and speeds, and reports which recovery condition (if any) ever becomes true.
//
// Not a pass/fail test — an instrument. Run it, read the table.
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = join(ROOT, `.railrepro.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, STUCK, SOLID, TIRE, CHASSIS, FIXED_DT, WHEEL } =
  await import(pathToFileURL(TMP).href);
unlinkSync(TMP);

const { RoadBvh } = await import(pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadCollision.js")).href)
  .catch(() => ({ RoadBvh: null }));

console.log("=== SETUP ===");
console.log(`  SOLID.skin ${SOLID.skin}  push ${SOLID.push}  friction ${SOLID.friction}`);
console.log(`  STUCK speed ${STUCK.speed}  beachedSpeed ${STUCK.beachedSpeed}  respawnAfter ${STUCK.respawnAfter}`);
console.log(`  TIRE.rayLength ${TIRE.rayLength}  WHEEL.radius ${WHEEL.radius}`);
console.log(`  CHASSIS ${CHASSIS.width} x ${CHASSIS.height} x ${CHASSIS.length}`);
console.log(`  RoadBvh available: ${!!RoadBvh}`);

/**
 * The kit's guardrail cross-section, as an analytic solid.
 *
 * Deliberately NOT a box: the real rail is a W-beam on posts with a PEAKED cap
 * (capRiseFrac 0.8), and the peak is the whole reason the car is supposed to
 * slide off. Modelled here as the true swept profile so the contact normals
 * match what the BVH would produce.
 */
const RAIL = { x: 5.0, top: 1.05, halfW: 0.16, postTop: 0.62 };
function railSolid() {
  return {
    baked: true,
    raycastFirst() { return null; },
    spherecast() { return null; },
    /** Closest point on the rail to a sphere at (x,y,z) within `radius`. */
    closestPointWithNormal(x, y, z, radius, outN) {
      const dx = x - RAIL.x;
      if (Math.abs(dx) > RAIL.halfW + radius) return null;
      // Peaked cap: a 2-plane roof meeting at the crown.
      const roofY = RAIL.top - Math.abs(dx) * (RAIL.top - RAIL.postTop) / RAIL.halfW;
      if (y > roofY) {
        const slope = (RAIL.top - RAIL.postTop) / RAIL.halfW;
        const inv = 1 / Math.hypot(1, slope);
        const d = (y - roofY) * inv;
        if (d > radius) return null;
        outN.set((dx >= 0 ? 1 : -1) * slope * inv, inv, 0);
        return { distance: d };
      }
      const d = Math.abs(dx) - RAIL.halfW;
      if (d > radius) return null;
      outN.set(dx >= 0 ? 1 : -1, 0, 0);
      return { distance: Math.max(0, d) };
    },
  };
}
/** Road deck: drivable for |x| < 4.6, nothing beyond (a sky track has no terrain). */
const road = {
  baked: true,
  raycastFirst(o, d, far) {
    if (d.y >= -1e-6 || Math.abs(o.x) > 4.6) return null;
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

/** Land the car on/near the rail and watch what the recovery logic sees. */
function drop({ x, y, vx, vy, vz, roll = 0, throttle = 0, secs = 8 }) {
  const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  c.groundBvh = road;
  c.solidsBvh = railSolid();
  c.enabled = true;
  c.body.pos.set(x, y, 0);
  c.body.vel.set(vx, vy, vz);
  c.body.quat.setFromAxisAngle(new THREE.Vector3(0, 0, 1), roll);

  let recovered = null, peakStuck = 0;
  // How often each recovery precondition held, over the whole run.
  const seen = { touch: 0, zeroWheels: 0, slow: 0, allThree: 0 };
  const n = Math.round(secs / FIXED_DT);
  for (let i = 0; i < n; i++) {
    c.tick({ steerTarget: 0, throttle, handbrake: false, yaw: 0, pitch: 0 });
    const touch = c.hitSolid;
    const zero = c.groundedCount === 0;
    const slow = c.body.vel.length() < STUCK.beachedSpeed;
    if (touch) seen.touch++;
    if (zero) seen.zeroWheels++;
    if (slow) seen.slow++;
    if (touch && zero && slow) seen.allThree++;
    peakStuck = Math.max(peakStuck, c.stuckTime);
    if (recovered === null && c.stuckTime >= STUCK.respawnAfter) recovered = i * FIXED_DT;
  }
  const pct = (v) => `${Math.round((100 * v) / n)}%`;
  return {
    recovered, peakStuck,
    endX: c.body.pos.x, endY: c.body.pos.y,
    grounded: c.groundedCount, touching: c.hitSolid,
    speed: c.body.vel.length(),
    touch: pct(seen.touch), zero: pct(seen.zeroWheels), slow: pct(seen.slow), all: pct(seen.allThree),
  };
}

console.log("\n=== LANDINGS ON / AROUND THE RAIL (rail crown x=5.0, road |x|<4.6) ===");
console.log("  scenario                    endX  endY  grnd touch  spd  | touch%  0wheel%  slow%  ALL%  recovered");
const cases = [
  ["dead on the crown",        { x: 5.0, y: 3.0, vx: 0, vy: -7, vz: 6 }],
  ["crown, rolling in",        { x: 5.0, y: 3.0, vx: -1, vy: -7, vz: 6 }],
  ["straddling road+rail",     { x: 4.3, y: 3.0, vx: 0, vy: -7, vz: 6 }],
  ["inboard of the rail",      { x: 4.0, y: 2.4, vx: 1.5, vy: -6, vz: 10 }],
  ["on its side vs the rail",  { x: 4.6, y: 2.4, vx: 1, vy: -6, vz: 4, roll: 1.3 }],
  ["nose-in slow",             { x: 4.7, y: 1.4, vx: 0.6, vy: -2, vz: 1 }],
  ["crown + throttle held",    { x: 5.0, y: 3.0, vx: 0, vy: -7, vz: 6, throttle: 1 }],
];
for (const [name, cfg] of cases) {
  const r = drop(cfg);
  console.log(
    `  ${name.padEnd(26)} ${r.endX.toFixed(1).padStart(5)} ${r.endY.toFixed(1).padStart(5)}`
    + `  ${String(r.grounded).padStart(2)}  ${String(r.touching).padStart(5)} ${r.speed.toFixed(1).padStart(4)}`
    + `  | ${r.touch.padStart(5)} ${r.zero.padStart(7)} ${r.slow.padStart(6)} ${r.all.padStart(5)}`
    + `   ${r.recovered === null ? "NEVER" : r.recovered.toFixed(2) + "s"}`,
  );
}
console.log("\n  ALL% is the fraction of ticks where touch AND 0-wheels AND slow were");
console.log("  ALL true — the beached condition. A trapped car showing a low ALL% means");
console.log("  the DETECTOR is wrong; a high ALL% with NEVER means the TIMER is wrong.");
