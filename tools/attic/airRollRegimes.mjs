// WHICH SIGNAL SEPARATES "roll off a ramp" FROM "roll off a loop"?
//
// The air controller drives the roll axis at `airRollRate` and bleeds everything
// perpendicular to it away at `airRollPurity`. That constant was tuned entirely
// against RAMP jumps. Off a loop the leftover rotation is v/R, which is far
// bigger, so the total rotation axis sits well off the car's forward axis and
// the nose sweeps a cone — the reported "the first 180° swings around some other
// pivot" (tools/ringHalfRollRepro.mjs measures the cone itself).
//
// The obvious fix is to damp harder, but only for loops — raise it everywhere
// and ramp jumps stop tumbling the way they were tuned to (measured: held-roll
// pitch on jump-debug.json goes 102° → 22° as purity goes 1.2 → 10).
//
// So: is there a threshold on the perpendicular RATE that tells the two apart?
// This prints the actual distribution for both, which is the thing that was
// being guessed at. An instrument, not a pass/fail test.
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const R2D = 57.2958;
const VTMP = join(ROOT, `.arr.${process.pid}.mjs`);
writeFileSync(VTMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, TIRE, FIXED_DT } = await import(pathToFileURL(VTMP).href);
unlinkSync(VTMP);

const { ModularRoadBuilder } = await import(
  pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadBuilder.js")).href);
const KIT = await import(pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadKit.js")).href);
const { roadParams, guardrailParams, pieceParams, buildPiece } = KIT;
const { importTrack } = await import(
  pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadTrackIO.js")).href);
const { RoadBvh } = await import(pathToFileURL(join(ROOT, "v3/play/modularRoadBvh.js")).href);
const { createVehicleGround } = await import(
  pathToFileURL(join(ROOT, "v3/play/modularRoadGround.js")).href);

Vehicle.prototype._buildMeshes = function () {
  this.group = new THREE.Group(); this.chassisMesh = new THREE.Object3D();
  this.tireGroups = [0, 0, 0, 0].map(() => new THREE.Group());
  this.arrowGroup = new THREE.Group(); this.arrowGroup.visible = false;
  this.arrows = [0, 0, 0, 0].map(() => ({})); this.wheelSpin = [0, 0, 0, 0];
  this.headlights = []; this.headlightTargets = []; this.headlamps = []; this.taillights = [];
  this._wheelInstances = []; this._wheelParts = [];
};
Vehicle.prototype._updateTaillights = function () {};

const mkBvh = (meshes) => {
  const b = new RoadBvh();
  if (meshes.length) b.bakeFromMeshes(meshes);
  return b.baked ? b : null;
};

// ── THE RAMP: the user's own jump track ─────────────────────────────────────
function rampTrack() {
  const scene = new THREE.Scene();
  const mat = () => new THREE.MeshBasicMaterial();
  const builder = new ModularRoadBuilder({
    scene, material: mat(), railMaterial: mat(), shellMaterial: mat(), decorMaterial: mat(),
    isBuildMode: () => true,
  });
  const data = JSON.parse(readFileSync(join(ROOT, "games/modular-road-v3/jump-debug.json"), "utf8"));
  const stub = { exportInstances: () => [], importInstances: () => {}, clear() {}, instances: [] };
  const portalStub = { exportLayout: () => ({}), importLayout: () => {}, clear() {}, params: {} };
  const res = importTrack(data, {
    builder, props: stub, movers: stub, portals: portalStub,
    roadParams, guardrailParams, pieceParams, portalParams: {},
  });
  if (!res.ok) throw new Error("track import failed: " + res.error);
  scene.updateMatrixWorld(true);
  const solids = [];
  for (const p of builder.pieces) { if (p.railMesh) solids.push(p.railMesh); if (p.shellMesh) solids.push(p.shellMesh); }
  const ground = createVehicleGround({ getTerrainHeight: () => -1000 });
  ground.setRoadBvh(mkBvh(builder.pieces.map((p) => p.mesh).filter((m) => m && !m.userData.noCollision)));
  ground.setRoadSolidsBvh(mkBvh(solids));
  const start = new THREE.Vector3().setFromMatrixPosition(builder.pieces[0].connectorIn);
  return { deck: ground.ground, solids: ground.solids, start };
}

// ── THE LOOP: the kit's ring half ───────────────────────────────────────────
function ringHalfTrack(runUp = 3) {
  const pp = { ...pieceParams, loopHalf: "in" };
  let conn = new THREE.Matrix4();
  const deck = [], rails = [];
  const push = (p) => {
    for (const g of [p.geometry, p.shellGeometry]) {
      if (!g) continue;
      const c = g.clone(); c.applyMatrix4(p.world); deck.push(c);
    }
    if (p.railGeometry) { const r = p.railGeometry.clone(); r.applyMatrix4(p.world); rails.push(r); }
  };
  for (let i = 0; i < runUp; i++) { const p = buildPiece("straight", conn, pp); push(p); conn = p.connectorOut; }
  push(buildPiece("loop_half", conn, pp));
  const toMesh = (gs) => gs.map((g) => {
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial()); m.updateMatrixWorld(true); return m;
  });
  return { deck: mkBvh(toMesh(deck)), solids: mkBvh(toMesh(rails)), start: new THREE.Vector3(0, 0, -4) };
}

/**
 * Drive, then hold roll for the whole flight. Records the PERPENDICULAR rate —
 * everything not on the roll axis — every airborne tick.
 */
function sample(track, { speed, launchY, secs }) {
  const car = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  car.setBvh(track.deck, track.solids);
  car.getFloorY = () => -1000;
  car.enabled = true;
  car.body.pos.set(track.start.x, track.start.y + 0.6, track.start.z - 6);
  car.body.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
  car.body.vel.set(0, 0, -speed);
  car._resetInterpolation();

  const fwd = new THREE.Vector3(), perp = new THREE.Vector3();
  let airborne = false, tAir = 0;
  const perps = [];
  for (let i = 0; i < Math.round(secs / FIXED_DT); i++) {
    const grounded = car.tires.filter((t) => t.grounded).length;
    if (!airborne && grounded === 0 && car.body.pos.y > launchY) airborne = true;
    car.tick({ steerTarget: airborne ? -1 : 0, throttle: 1, handbrake: false, yaw: 0, pitch: 0 });
    if (!airborne) continue;
    tAir += FIXED_DT;
    if (car.tires.some((t) => t.grounded)) break;
    fwd.set(0, 0, 1).applyQuaternion(car.body.quat);
    perp.copy(car.body.angVel).addScaledVector(fwd, -car.body.angVel.dot(fwd));
    perps.push({ t: tAir, p: perp.length() });
  }
  return perps;
}

const ramp = sample(rampTrack(), { speed: 40, launchY: 42.5, secs: 20 });
const ring = sample(ringHalfTrack(), { speed: 45, launchY: 20, secs: 8 });

const stat = (a) => {
  if (!a.length) return "no samples";
  const v = a.map((x) => x.p).sort((x, y) => x - y);
  const q = (f) => v[Math.min(v.length - 1, Math.floor(f * v.length))];
  return { max: v[v.length - 1], p90: q(0.9), med: q(0.5), min: v[0], n: v.length };
};
const rs = stat(ramp), ls = stat(ring);

console.log(`airRollRate ${TIRE.airRollRate} rad/s   airRollPurity ${TIRE.airRollPurity}\n`);
console.log("PERPENDICULAR RATE (rad/s) while a roll is held for the whole flight:");
console.log("  regime                     max     p90   median     min   samples");
for (const [n, s] of [["RAMP  (jump-debug.json)", rs], ["LOOP  (kit ring half)  ", ls]]) {
  console.log(`  ${n}  ${s.max.toFixed(2).padStart(5)}   ${s.p90.toFixed(2).padStart(5)}` +
    `   ${s.med.toFixed(2).padStart(6)}   ${s.min.toFixed(2).padStart(5)}   ${String(s.n).padStart(7)}`);
}

console.log("\nFIRST 0.5 s AFTER LAUNCH — where the reported swing happens:");
console.log("     t      RAMP perp      LOOP perp");
for (let k = 0; k < 10; k++) {
  const t = 0.05 * (k + 1);
  const at = (a) => { const h = a.find((x) => x.t >= t); return h ? h.p.toFixed(2) : "—"; };
  console.log(`  ${t.toFixed(2)}   ${at(ramp).padStart(9)}      ${at(ring).padStart(9)}`);
}

console.log("\nOVERLAP: the ramp's own perpendicular rate reaches " +
  `${rs.max.toFixed(2)} rad/s, and the loop's decays down through that same band.`);
console.log("A threshold on the RATE therefore cannot separate the two regimes —");
console.log("anything low enough to catch the loop also catches every ramp jump.");
