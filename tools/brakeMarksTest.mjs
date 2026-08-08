// DOES HARD BRAKING LAY RUBBER?
//
// Every trigger in the tyre-mark and smoke modules measured LATERAL slip, so a
// straight-line stop — measured at 1.71 g, 40 m/s to standstill in 44 m — emitted
// nothing at all: the car has no sideways velocity, so as far as those modules
// were concerned nothing was happening. `tire.overDemand` is the same measurement
// in the other axis (how far past its grip the tyre's longitudinal demand went),
// and it is what makes braking visible.
//
// Guards both directions. Braking must mark; and coasting, cruising and gentle
// driving must NOT, or the track is permanently black.
//
// Run: node tools/brakeMarksTest.mjs
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = join(ROOT, `.bm.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, FIXED_DT, TIRE } = await import(pathToFileURL(TMP).href);
const { RoadBvh } = await import(pathToFileURL(join(ROOT, "v3/play/modularRoadBvh.js")).href);
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

const plane = new THREE.PlaneGeometry(4000, 4000);
plane.rotateX(-Math.PI / 2);
const bvh = new RoadBvh();
bvh.bakeFromMeshes([(() => {
  const m = new THREE.Mesh(plane, new THREE.MeshBasicMaterial());
  m.updateMatrixWorld(true); return m;
})()]);

/** Drive the real Vehicle and report the peak rear `overDemand` it produced. */
function run({ steer = 0, throttle = 0, handbrake = false, v0 = 40, secs = 1.5 }) {
  const car = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  car.setBvh(bvh, null);
  car.getFloorY = () => -50;
  car.enabled = true;
  car.body.pos.set(0, 0.65, 0);
  car.body.quat.identity();
  car.body.vel.set(0, 0, v0);
  car._resetInterpolation();
  for (let i = 0; i < 40; i++) {
    car.tick({ steerTarget: 0, throttle: 0, handbrake: false, yaw: 0, pitch: 0 });
    car.syncVisuals(FIXED_DT, 1);
  }
  let peak = 0;
  for (let i = 0; i < Math.round(secs / FIXED_DT); i++) {
    car.tick({ steerTarget: steer, throttle, handbrake, yaw: 0, pitch: 0 });
    car.syncVisuals(FIXED_DT, 1);
    if (car.body.vel.length() < 5) break; // below the mark speed gate anyway
    for (const t of car.tires) if (!t.canSteer) peak = Math.max(peak, t.overDemand ?? 0);
  }
  return peak;
}

console.log("\n=== overDemand: is the tyre past its longitudinal grip? ===\n");
const cases = {
  "coasting (no input)": run({ throttle: 0 }),
  "cruising on the throttle": run({ throttle: 1 }),
  "gentle turn on throttle": run({ throttle: 1, steer: 0.25 }),
  "BRAKING hard": run({ throttle: -1 }),
  "braking while turning": run({ throttle: -1, steer: 0.6 }),
};
for (const [k, v] of Object.entries(cases)) {
  console.log(`  ${k.padEnd(28)} ${v.toFixed(3)}`);
}
console.log("");

check("braking pushes the rear tyres past their grip", cases["BRAKING hard"] > 0.05,
  `overDemand ${cases["BRAKING hard"].toFixed(2)} — this is what the marks read`);
check("...and so does braking into a corner", cases["braking while turning"] > 0.05);
// The other half, and the one that would ruin the track: normal driving must be
// completely clean, or every lap paints the circuit black.
check("COASTING leaves the tyres well inside their grip", cases["coasting (no input)"] < 0.01,
  `${cases["coasting (no input)"].toFixed(3)}`);
check("cruising on the throttle does not mark", cases["cruising on the throttle"] < 0.01,
  `${cases["cruising on the throttle"].toFixed(3)}`);
check("nor does an ordinary turn under power", cases["gentle turn on throttle"] < 0.01,
  `${cases["gentle turn on throttle"].toFixed(3)}`);

console.log("\n=== IT IS WIRED INTO BOTH CONSUMERS ===\n");
for (const [file, konst] of [
  ["modularRoadTireMarks.js", "BRAKE_MARK"],
  ["modularRoadDriftSmoke.js", "BRAKE_SMOKE"],
]) {
  const src = readFileSync(join(ROOT, "games/modular-road-v3", file), "utf8");
  check(`${file} reads tire.overDemand`, /tire\.overDemand/.test(src));
  check(`${file} folds it into driftIntensity`,
    /driftIntensity = Math\.max\([^)]*brakeAmount/.test(src));
  check(`${file} can be switched off with ${konst} = 0`,
    new RegExp(`${konst}\\s*>\\s*0`).test(src));
}

// The airborne reset matters: apply() returns before the force block when there
// is no ground, so a stale value would restart the smoke on touchdown.
const veh = readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8");
check("overDemand is cleared when a wheel leaves the ground",
  /this\.grounded = false;[\s\S]{0,400}?this\.overDemand = 0;/.test(veh),
  "otherwise a tyre keeps its last ground value and smokes on landing");
check("recording it applies no force (read-only instrumentation)",
  /this\.overDemand = Fmax > 1e-6/.test(veh) && !/addForce[^\n]*overDemand/.test(veh));

console.log(fail ? `\n${fail} FAILURE(S)\n` : "\nall green\n");
process.exit(fail ? 1 : 0);
