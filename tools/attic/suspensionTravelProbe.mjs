// ============================================================================
// HOW FAR DOES THE STRUT THINK IT IS COMPRESSED?
//
// Tire.apply computes `compression = TIRE.restLength - distFromHub` and applies
// the resulting force along CHASSIS-UP. Two things make that dangerous once the
// car is past horizontal:
//
//   • `distFromHub` can be NEGATIVE (the contact sits above the hub), and
//     nothing bounds it, so `compression` can exceed the strut's real travel by
//     any amount. Past `bottomOutThresh` the extra is squared.
//   • chassis-up is not up any more. On its side the car is shoved SIDEWAYS.
//
// This measures the compression actually reached in three situations, so the
// launching one can be told apart from the legitimate one (a loop bottoms its
// struts constantly under centripetal load, and must keep working).
//
// WHAT IT ESTABLISHED (2026-09-12)
//
// The first column is the fix that shipped. Every legitimate case stays under
// 0.433 m on a 0.55 m strut, so bounding compression at the strut's own rest
// length is free — those rows are bit-identical — while the launcher's 0.83 to
// 1.14 m is cut to 0.55 and its peak force from 448 to 53 car-weights.
//
// THREE DISCRIMINATORS THAT DO NOT WORK. All three were measured here, and all
// three overlap between a fast TUBE wall-ride (which must keep working) and a
// car landing on its side (which must not launch). Do not retry them:
//
//   • negative hub distance   tube reaches -0.54, launcher -0.59. Identical.
//   • peak strut force        tube 54.0 car-weights, launcher 53.2. Identical,
//                             because both sit on the clamp.
//   • chassis-up · normal     tube reaches -0.02 and 0.31, launcher 0.12 and
//                             0.27. Overlapping, so no threshold separates them.
//
// (A fourth, the raw triangle normal's direction, is ruled out separately in
// wheelNormalFlipProbe.mjs — it is a coin flip in every situation.)
//
// What is left of the launcher therefore needs what the note in Tire.apply
// always said it needed: a signed inside/outside query against closed geometry,
// telling you the wheel is behind the road rather than on it. No scalar read off
// a single contact can stand in for it.
//
// Run:  node tools/attic/suspensionTravelProbe.mjs
// ============================================================================
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const TMP = join(ROOT, `.suspProbe.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, FIXED_DT, TIRE, CHASSIS, GRAVITY } = await import(pathToFileURL(TMP).href);
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

function bake(geos) {
  const b = new RoadBvh();
  const ms = geos.map((g) => new THREE.Mesh(g, new THREE.MeshBasicMaterial()));
  for (const m of ms) m.updateMatrixWorld(true);
  b.bakeFromMeshes(ms);
  return b.baked ? b : null;
}
function straightTrack(n) {
  let conn = new THREE.Matrix4();
  const geos = [];
  for (let i = 0; i < n; i++) {
    const p = buildPiece("straight", conn);
    const g = p.geometry.clone(); g.applyMatrix4(p.world); geos.push(g);
    conn = p.connectorOut;
  }
  return bake(geos);
}
function loopTrack() {
  let conn = new THREE.Matrix4();
  const geos = [];
  const push = (p) => {
    for (const g of [p.geometry, p.shellGeometry]) {
      if (!g) continue;
      const c = g.clone(); c.applyMatrix4(p.world); geos.push(c);
    }
  };
  for (let i = 0; i < 8; i++) { const p = buildPiece("straight", conn); push(p); conn = p.connectorOut; }
  push(buildPiece("loop", conn));
  return bake(geos);
}
function makeCar(deck) {
  const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  c.setBvh(deck, null);
  c.getFloorY = () => -50;
  c.enabled = true;
  return c;
}

const WEIGHT = CHASSIS.mass * GRAVITY;
console.log(`TIRE.restLength ${TIRE.restLength}  springStrength ${TIRE.springStrength}`);
console.log(`bottomOutThresh ${TIRE.bottomOutThresh} (= ${(TIRE.restLength * TIRE.bottomOutThresh).toFixed(3)} m)`
  + `  bottomOutMult ${TIRE.bottomOutMult}`);
console.log(`car weight ${(WEIGHT / 1000).toFixed(1)} kN — a force in car-weights is the useful unit\n`);

function run(label, setup, ticks, throttle, steer = 0) {
  const car = setup();
  let maxComp = -Infinity, minHub = Infinity, maxF = 0, peakV = 0;
  // Is the strut actually FACING the surface it is pushing against? The force
  // goes out along chassis-up, so `chassisUp · contactNormal` is the fraction of
  // it that opposes the ground at all. Sampled only on the loaded struts, since
  // an unloaded one pushes nothing and its geometry does not matter.
  let minFacingLoaded = Infinity;
  const up = new THREE.Vector3();
  const v0 = car.body.vel.length();
  for (let i = 0; i < ticks; i++) {
    car.tick({ steerTarget: steer, throttle, handbrake: false, yaw: 0, pitch: 0 });
    peakV = Math.max(peakV, car.body.vel.length());
    up.set(0, 1, 0).applyQuaternion(car.body.quat);
    for (const t of car.tires) {
      if (!t.grounded) continue;
      maxComp = Math.max(maxComp, t.compression);
      minHub = Math.min(minHub, t.hitDistance);
      maxF = Math.max(maxF, t.lastSuspension.length());
      if (t.compression > 0.30) minFacingLoaded = Math.min(minFacingLoaded, up.dot(t.hitNormal));
    }
  }
  console.log(`${label.padEnd(30)} maxCompression ${maxComp === -Infinity ? "  n/a" : maxComp.toFixed(3).padStart(7)} m`
    + `   minHubDist ${minHub === Infinity ? "  n/a" : minHub.toFixed(3).padStart(7)} m`
    + `   peak strut ${(maxF / WEIGHT).toFixed(1).padStart(7)} car-weights`
    + `   up·n ${minFacingLoaded === Infinity ? " n/a" : minFacingLoaded.toFixed(2).padStart(5)}`
    + `   |v| ${v0.toFixed(0)} -> ${peakV.toFixed(0)}`);
}

const flat = straightTrack(14);
const loop = loopTrack();

console.log("── LEGITIMATE: normal driving, and a loop (struts bottom under load) ──");
run("cruising a flat straight", () => {
  const c = makeCar(flat);
  c.body.pos.set(0, 0.6, -10);
  c.body.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
  c.body.vel.set(0, 0, -40);
  return c;
}, 240, 1);
// The harshest landings the game can actually produce. 60 m/s down is the
// documented realistic worst case: terminal speed from the 200 m build ceiling
// is about 63 m/s (see the note in chassisCollisionTest.run.mjs).
for (const vy of [40, 50, 60]) {
  run(`hard landing, ${vy} m/s down`, () => {
    const c = makeCar(flat);
    c.body.pos.set(0, 6, -10);
    c.body.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
    c.body.vel.set(0, -vy, -20);
    return c;
  }, 240, 0);
}
for (const [vy, pitch] of [[45, 25], [45, -25]]) {
  run(`landing pitched ${pitch}°, ${vy} m/s down`, () => {
    const c = makeCar(flat);
    c.body.pos.set(0, 6, -10);
    c.body.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI)
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), (pitch * Math.PI) / 180));
    c.body.vel.set(0, -vy, -25);
    return c;
  }, 240, 0);
}
{
  // A quarterpipe, which loads the struts through a real transition.
  let conn = new THREE.Matrix4();
  const geos = [];
  const push = (p) => {
    for (const g of [p.geometry, p.shellGeometry]) {
      if (!g) continue;
      const c = g.clone(); c.applyMatrix4(p.world); geos.push(c);
    }
  };
  for (let i = 0; i < 6; i++) { const p = buildPiece("straight", conn); push(p); conn = p.connectorOut; }
  push(buildPiece("quarterpipe", conn));
  const qp = bake(geos);
  for (const v0 of [35, 50]) {
    run(`QUARTERPIPE at ${(v0 * 3.6).toFixed(0)} km/h`, () => {
      const c = makeCar(qp);
      c.body.pos.set(0, 0.65, -4);
      c.body.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
      c.body.vel.set(0, 0, -v0);
      return c;
    }, Math.round(6 / FIXED_DT), 1);
  }
}
for (const v0 of [35, 50, 55]) {
  run(`LOOP at ${(v0 * 3.6).toFixed(0)} km/h`, () => {
    const c = makeCar(loop);
    c.body.pos.set(0, 0.65, -4);
    c.body.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
    c.body.vel.set(0, 0, -v0);
    return c;
  }, Math.round(8 / FIXED_DT), 1);
}

// TUBES — the case the note in Tire.apply says killed the earlier attempt at
// bounding this ("tears the car off the wall — measured r 97 against a tube wall
// at r 8, and the loop falling from 49 m to 38 m"). If a tube wall-ride also
// stays on the positive side of the hub then a bound placed at the hub cannot
// reach it, and that objection no longer applies to THIS fix.
{
  let conn = new THREE.Matrix4();
  const geos = [];
  const push = (p) => {
    for (const g of [p.geometry, p.shellGeometry]) {
      if (!g) continue;
      const c = g.clone(); c.applyMatrix4(p.world); geos.push(c);
    }
  };
  for (let i = 0; i < 2; i++) { const p = buildPiece("straight", conn); push(p); conn = p.connectorOut; }
  for (let i = 0; i < 4; i++) { const p = buildPiece("tube", conn); push(p); conn = p.connectorOut; }
  const tube = bake(geos);
  for (const [v0, steer] of [[35, 0.6], [45, 0.6], [55, 0.9]]) {
    run(`TUBE wall-ride at ${(v0 * 3.6).toFixed(0)} km/h`, () => {
      const c = makeCar(tube);
      c.body.pos.set(0, 0.65, -4);
      c.body.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
      c.body.vel.set(0, 0, -v0);
      return c;
    }, Math.round(6 / FIXED_DT), 1, steer);
  }
}

console.log("\n── THE LAUNCHER: landing rolled onto its side ──");
for (const roll of [90, 110, 135, 160, 180]) {
  run(`landing rolled ${roll}°`, () => {
    const c = makeCar(flat);
    c.body.pos.set(0, 1.3, -20);
    c.body.vel.set(0, -0.1, -22);
    c.body.quat.setFromAxisAngle(new THREE.Vector3(0, 0, 1), (roll * Math.PI) / 180);
    return c;
  }, 120, 0);
}
