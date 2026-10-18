// node games/thunderline/proto/kit/ghostTest.mjs
// P5 (DESIGN.md §9): can a ghost be just the INPUTS? The real car (old physics, top 63, 3 substeps,
// boost pads) drives the test track under the autopilot while every tick's input is recorded; then a
// fresh car replays only those inputs. Deterministic physics → every tick matches bit for bit.
// Apex Rush's biggest complaint was physics that is NOT deterministic — this is the check that ours is.
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

// ---- run 1: autopilot, record inputs + state per tick ----
const TICKS = 120 * 90; // up to 90 s
const car1 = makeCar();
const st = { idx: 0 }, b1 = { boost: 0 };
const inputs = [], states1 = [];
let lapTicks = TICKS, fell = false;
const t0 = performance.now();
for (let i = 0; i < TICKS; i++) {
  const inp = autopilot(car1, st);
  inputs.push(inp);
  car1.tick(inp);
  boostTick(car1, b1);
  states1.push(state(car1));
  if (car1.body.pos.y < lay.start.elements[13] - 200) { fell = true; lapTicks = i; break; }
  if (st.idx >= lay.ride.length - 5) { lapTicks = i; break; }
}
const ms1 = performance.now() - t0;

// ---- run 2: a fresh car, replaying ONLY the inputs ----
const car2 = makeCar();
const b2 = { boost: 0 };
let firstDiff = -1, maxErr = 0;
for (let i = 0; i < inputs.length; i++) {
  car2.tick(inputs[i]);
  boostTick(car2, b2);
  const s2 = state(car2), s1 = states1[i];
  for (let k = 0; k < s1.length; k++) {
    const e = Math.abs(s1[k] - s2[k]);
    if (e > maxErr) maxErr = e;
    if (e !== 0 && firstDiff < 0) firstDiff = i;
  }
}

const lapS = (lapTicks * FIXED_DT).toFixed(3);
console.log(`run 1 (autopilot): ${inputs.length} ticks, ${fell ? "FELL" : `lap ${lapS} s`}, ${(ms1 / inputs.length).toFixed(3)} ms/tick`);
console.log(`run 2 (inputs only): first difference at tick ${firstDiff}, max |difference| ${maxErr}`);
console.log(`ghost = inputs: ${inputs.length} ticks × 7 values; as bytes ≈ ${(inputs.length * 3 / 1024).toFixed(0)} KB (steer i8, throttle i8, flags u8)`);
// fingerprint of the final state, to compare against the SAME run inside Chrome (cross-environment)
console.log(`final state: ${JSON.stringify(states1[states1.length - 1])}`);
if (process.argv.includes("--trace")) {
  for (const t of [0, 1, 2, 9, 59, 119, 599, 1199, 2399, 4799])
    console.log(`tick ${t}: ${JSON.stringify(states1[t])}`);
}
const ok = !fell && firstDiff === -1;
console.log(ok ? "DETERMINISTIC: the replay matches every tick bit for bit" : "NOT deterministic (or the lap failed)");
process.exit(ok ? 0 : 1);
