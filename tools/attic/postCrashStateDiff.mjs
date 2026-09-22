// ============================================================================
// WHAT IS DIFFERENT ABOUT THE CAR AFTER A BIG CRASH?
//
// "After a big crash the car is uncontrollable, it turns by itself." Rather
// than guess which subsystem, snapshot EVERY scalar and flag on the vehicle and
// its four tyres while it cruises steadily, crash it, let it recover, cruise
// steadily again, and diff the two snapshots. Anything that did not come back
// to where it started is a candidate.
//
// Both snapshots are taken in the same state — on the road, straight, full
// throttle, zero steering, at settled speed — so a difference is a LATCH, not a
// difference in what the car is doing.
//
// Run:  node tools/attic/postCrashStateDiff.mjs
// ============================================================================
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const TMP = join(ROOT, `.stateDiff.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, FIXED_DT } = await import(pathToFileURL(TMP).href);
const { RoadBvh } = await import(pathToFileURL(join(ROOT, "v3/play/modularRoadBvh.js")).href);
const { buildPiece } = await import(pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadKit.js")).href);
unlinkSync(TMP);

Vehicle.prototype._buildMeshes = function () {
  this.group = new THREE.Group(); this.chassisMesh = new THREE.Object3D();
  this.tireGroups = [0, 0, 0, 0].map(() => new THREE.Group());
  this.arrowGroup = new THREE.Group(); this.arrowGroup.visible = false;
  this.arrows = [0, 0, 0, 0].map(() => ({})); this.wheelSpin = [0, 0, 0, 0];
  this.headlights = []; this.headlightTargets = []; this.headlamps = []; this.taillights = [];
  this._wheelInstances = []; this._wheelParts = [];
};
Vehicle.prototype._updateTaillights = function () {};

// Long straight WITH rails, so a crash keeps the car on the road.
let conn = new THREE.Matrix4();
const deckGeos = [], railGeos = [];
for (let i = 0; i < 200; i++) {
  const p = buildPiece("straight", conn);
  const g = p.geometry.clone(); g.applyMatrix4(p.world); deckGeos.push(g);
  if (p.railGeometry) { const r = p.railGeometry.clone(); r.applyMatrix4(p.world); railGeos.push(r); }
  conn = p.connectorOut;
}
const bake = (geos) => {
  const b = new RoadBvh();
  const ms = geos.map((g) => new THREE.Mesh(g, new THREE.MeshBasicMaterial()));
  for (const m of ms) m.updateMatrixWorld(true);
  b.bakeFromMeshes(ms);
  return b.baked ? b : null;
};
const deck = bake(deckGeos), solids = bake(railGeos);

function makeCar() {
  const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  c.setBvh(deck, solids);
  c.getFloorY = () => -50;
  c.enabled = true;
  c.body.pos.set(0, 0.6, -20);
  c.body.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
  c.body.vel.set(0, 0, -35);
  return c;
}

/** Every own scalar / boolean on the vehicle, plus the same for each tyre. */
function snapshot(car) {
  const out = {};
  const take = (obj, prefix) => {
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (typeof v === "number" || typeof v === "boolean") out[prefix + k] = Number(v);
    }
  };
  take(car, "");
  car.tires.forEach((t, i) => take(t, `tire${i}.`));
  take(car.input, "input.");
  // Things worth seeing that are not plain own properties.
  out["body.angVel.y"] = car.body.angVel.y;
  out["groundedCount"] = car.groundedCount;
  const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(car.body.quat);
  out["speed"] = car.body.vel.length();
  out["heading"] = Math.atan2(fwd.x, fwd.z) * 57.2958;
  return out;
}

/** Cruise straight until the state is steady, then snapshot. */
function cruise(car, secs) {
  for (let i = 0; i < Math.round(secs / FIXED_DT); i++) {
    car.tick({ steerTarget: 0, throttle: 1, handbrake: false, yaw: 0, pitch: 0 });
  }
  return snapshot(car);
}

const car = makeCar();
const before = cruise(car, 6);

// A REAL crash: slam the rail hard enough to arm the yield and throw the car.
car.body.vel.set(26, 2, -44);
car.body.angVel.set(0, 0, 0);
for (let i = 0; i < Math.round(6 / FIXED_DT); i++) {
  car.tick({ steerTarget: 0, throttle: 0, handbrake: false, yaw: 0, pitch: 0 });
}
const justAfter = snapshot(car);

// Let it settle and cruise again, in the same state the first snapshot was in.
const after = cruise(car, 10);

// Fields that are MEANT to differ (where the car is, how fast, which way).
const EXPECTED = new Set([
  "speed", "heading", "groundedCount", "body.angVel.y",
]);

console.log("Both snapshots: on the road, zero steering, full throttle, settled.");
console.log(`  before  speed ${before.speed.toFixed(1)}  heading ${before.heading.toFixed(1)}°  grounded ${before.groundedCount}`);
console.log(`  after   speed ${after.speed.toFixed(1)}  heading ${after.heading.toFixed(1)}°  grounded ${after.groundedCount}`);
console.log(`  (mid-crash: yield ${justAfter._crashYield?.toFixed?.(2)}, grounded ${justAfter.groundedCount})\n`);

const rows = [];
for (const k of Object.keys(before)) {
  const a = before[k], b = after[k];
  if (a === b) continue;
  const d = b - a;
  const rel = Math.abs(a) > 1e-9 ? Math.abs(d / a) : Infinity;
  if (Math.abs(d) < 1e-6) continue;
  rows.push({ k, a, b, d, rel, expected: EXPECTED.has(k) });
}
rows.sort((x, y) => Math.abs(y.d) - Math.abs(x.d));

console.log("STATE THAT DID NOT COME BACK (largest change first)");
console.log("  field                                   before        after        delta");
console.log("  ─────────────────────────────────────────────────────────────────────────");
for (const r of rows.slice(0, 40)) {
  console.log(`  ${(r.expected ? "(expected) " : "").padStart(0)}${r.k.padEnd(38 - (r.expected ? 11 : 0))}`
    + ` ${r.a.toFixed(4).padStart(12)} ${r.b.toFixed(4).padStart(12)} ${r.d.toFixed(4).padStart(12)}`);
}
if (!rows.length) console.log("  nothing — every scalar came back to its pre-crash value.");
