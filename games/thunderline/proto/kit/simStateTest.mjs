// node games/thunderline/proto/kit/simStateTest.mjs
// THE INCREMENTAL TEST LAP MUST BE EXACT (simState.js): the builder's lap resumes from a saved car instead of
// driving from the start, and the author time comes from it. The test track, driven by the shared autopilot
// through the car rules: saved at several ticks, driven to the end; each save restored into the car and
// driven again — every ending must be the same as the full run's, bit for bit.
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { TILES, integrate, deckFrame, SECTIONS } from "./kit.js";
import { layoutTestTrack } from "./testTrack.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

// the car, loaded the way tools/chassisCollisionTest.mjs does (strip the two GPU-only imports)
const SRC = join(ROOT, "v3/play/modularRoadVehicle.js");
const TMP = join(ROOT, `.ghostTest.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(SRC, "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, FIXED_DT, TIRE, AERO, CHASSIS } = await import(pathToFileURL(TMP).href).finally(() => unlinkSync(TMP));
const { RoadBvh } = await import(pathToFileURL(join(ROOT, "v3/play/modularRoadBvh.js")).href);
const { createVehicleGround } = await import(pathToFileURL(join(ROOT, "v3/play/modularRoadGround.js")).href);
const { buildSweepGeometry, buildProfile, ROAD_PARAM_DEFAULTS } = await import(pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadKit.js")).href);
const { buildRailCollision } = await import(pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadRail.js")).href);

Vehicle.prototype._buildMeshes = function () {
  this.group = new THREE.Group();
  this.chassisMesh = new THREE.Object3D();
  this.tireGroups = this.tires.map(() => new THREE.Group());
  this.arrowGroup = new THREE.Group();
  this.arrowGroup.visible = false;
  this.arrows = this.tires.map(() => ({}));
  this.wheelSpin = [0, 0, 0, 0];
  this.headlights = []; this.headlightTargets = []; this.headlamps = []; this.taillights = [];
  this._wheelInstances = []; this._wheelParts = [];
};
Vehicle.prototype._updateTaillights = function () {};

// ---- the same tune and track as drive.html ----
const TOP = 63;
TIRE.topSpeed = TOP;
TIRE.steerSpeedRef = TOP * 0.9;
const built = {};
for (const [id, t] of Object.entries(TILES)) built[id] = { b: integrate(t) };
const lay = layoutTestTrack({ built, speed: TOP * 0.91, jumpSpeeds: [55.8, 48.6, 50.6], airDrag: AERO.drag / CHASSIS.mass });
if (lay.warnings.length) { console.log("track warnings:", lay.warnings); process.exit(1); }

// collision, as drive.js: the old kit's sweep on the new paths (deck) + the rail collision proxy (solids)
const deckGeos = [], solidGeos = [];
for (const p of lay.placements) {
  const t = TILES[p.id];
  const hw = SECTIONS[t.section ?? "road"].hw;
  const rp = t.section === "wide" ? { ...ROAD_PARAM_DEFAULTS, width: hw * 2 } : ROAD_PARAM_DEFAULTS;
  const frames = [];
  let lastS = -1;
  for (const r of integrate(t, { maxGap: 2 }).rings) {
    if (r.s - lastS < 0.05) continue;
    lastS = r.s;
    const f = deckFrame(r, hw);
    frames.push({ pos: f.P, tangent: r.T.clone(), up: f.U, right: f.R });
  }
  const deck = buildSweepGeometry(frames, buildProfile(rp, !p.open), {}).clone();
  deck.applyMatrix4(p.M);
  const mesh = new THREE.Mesh(deck, new THREE.MeshBasicMaterial());
  mesh.userData.roadHold = ["bank_in_22", "bank_out_22", "fast_turn_128"].includes(p.id.replace(/_L$/, ""));
  deckGeos.push(mesh);
  if (!p.open) {
    const rail = buildRailCollision(frames, rp);
    if (rail) { const g = rail.clone(); g.applyMatrix4(p.M); solidGeos.push(new THREE.Mesh(g, new THREE.MeshBasicMaterial())); }
  }
}
const bake = (meshes) => { for (const m of meshes) m.updateMatrixWorld(true); const b = new RoadBvh(); b.bakeFromMeshes(meshes); return b.baked ? b : null; };
const deckBvh = bake(deckGeos), solidsBvh = bake(solidGeos);
// through the same ground adapter the drive page uses (sky mode: no terrain), so Node and Chrome
// run the identical code path
const ground = createVehicleGround({ getTerrainHeight: () => NaN });
ground.setRoadBvh(deckBvh);
ground.setRoadSolidsBvh(solidsBvh);

const startPos = new THREE.Vector3().setFromMatrixPosition(lay.start);
const startFwd = new THREE.Vector3(0, 0, -1).transformDirection(lay.start);
const spawnPos = startPos.clone().addScaledVector(startFwd, 12).add(new THREE.Vector3(0, 0.6, 0));
const spawnQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(startFwd.x, startFwd.z));
const boostPads = lay.placements.filter((p) => p.id.startsWith("boost")).map((p) => p.M.clone().invert());

function makeCar() {
  const car = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  car.SUBSTEPS = 3;
  car.setBvh(ground.ground, ground.solids);
  car.getFloorY = () => NaN;
  car.setSolidCapsules([]);
  car.setSpawn(spawnPos, spawnQuat);
  car.enabled = true;
  car.respawn();
  return car;
}

// the same boost as drive.js
function boostTick(car, state) {
  const lp = new THREE.Vector3();
  for (const inv of boostPads) {
    lp.copy(car.body.pos).applyMatrix4(inv);
    if (Math.abs(lp.x) < 8 && lp.y > -1 && lp.y < 3 && lp.z < -4 && lp.z > -28) state.boost = 2.0;
  }
  if (state.boost > 0 && car.groundedCount > 0) car.body.vel.addScaledVector(new THREE.Vector3(0, 0, 1).applyQuaternion(car.body.quat), 14 * FIXED_DT);
  state.boost = Math.max(0, state.boost - FIXED_DT);
}

// the autopilot from drive.js (steer at the centreline 25 m ahead, brake for flat brake turns)
function autopilot(car, st) {
  const ride = lay.ride, p = car.body.pos;
  let best = st.idx, bd = Infinity;
  for (let i = Math.max(0, st.idx - 20); i < Math.min(ride.length, st.idx + 400); i++) {
    const d = ride[i].P.distanceToSquared(p);
    if (d < bd) { bd = d; best = i; }
  }
  st.idx = best;
  const aim = (dist) => { let i = best, acc = 0; while (i + 1 < ride.length && acc < dist) { acc += ride[i].P.distanceTo(ride[i + 1].P); i++; } return ride[i]; };
  const inv = car.body.quat.clone().invert();
  const local = aim(25).P.clone().sub(p).applyQuaternion(inv);
  const steer = THREE.MathUtils.clamp((local.x / Math.max(local.z, 4)) * 2.5, -1, 1);
  const far = aim(90).T;
  const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(car.body.quat);
  const bend = Math.acos(THREE.MathUtils.clamp(far.dot(fwd), -1, 1));
  const v = car.body.vel.length();
  const throttle = bend > 1.1 && Math.abs(far.y) < 0.4 && Math.abs(fwd.y) < 0.4 && v > 26 && !ride[best].air ? -1 : 1;
  return { steerTarget: steer, rollTarget: 0, throttle, handbrake: false, yaw: 0, pitch: 0, analog: true };
}

const state = (car) => [...car.body.pos.toArray(), ...car.body.vel.toArray(), ...car.body.quat.toArray(), ...car.body.angVel.toArray()];


import { createAutopilot } from "./autopilot.js";
import { createCarRules } from "./carRules.js";
import { saveState, restoreState } from "./simState.js";

const car = makeCar();
const pilot = createAutopilot(lay.ride);
const rules = createCarRules(car, { boostPads });
const END = 120 * 75;
const SAVES = [600, 2400, 4800, 7200];
const saved = new Map();
const pose = () => state(car);
const runFrom = (t0) => {
  for (let i = t0; i < END; i++) {
    if (!saved.has(i) && SAVES.includes(i)) saved.set(i, { car: saveState(car), rules: rules.getState(), pilot: pilot.getState() });
    rules.step(pilot.input(car), FIXED_DT);
  }
  return pose();
};
const full = runFrom(0);
let bad = 0;
for (const t of SAVES) {
  const s = saved.get(t);
  restoreState(car, s.car); rules.setState(s.rules); pilot.setState(s.pilot);
  const again = runFrom(t);
  const diff = Math.max(...again.map((v, k) => Math.abs(v - full[k])));
  console.log(`resumed at tick ${t}: ${diff === 0 ? "same ending, bit for bit" : `DIFFERENT (max ${diff})`}`);
  if (diff !== 0) bad++;
}
// …and INTO A NEW CAR (the builder builds a new one for every lap): fresh car, rules and autopilot
for (const t of SAVES) {
  const s = saved.get(t);
  const c2 = makeCar(), p2 = createAutopilot(lay.ride), r2 = createCarRules(c2, { boostPads });
  restoreState(c2, s.car); r2.setState(s.rules); p2.setState(s.pilot);
  for (let i = t; i < END; i++) r2.step(p2.input(c2), FIXED_DT);
  const again = state(c2);
  const diff = Math.max(...again.map((v, k) => Math.abs(v - full[k])));
  console.log(`new car from tick ${t}: ${diff === 0 ? "same ending, bit for bit" : `DIFFERENT (max ${diff})`}`);
  if (diff !== 0) bad++;
}
console.log(bad ? "NOT EXACT" : "EXACT: every resumed run ends as the full run");
process.exit(bad ? 1 : 0);
