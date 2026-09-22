// ============================================================================
// AFTER A BIG CRASH, DOES THE CAR STILL DRIVE STRAIGHT?
//
// Reported: "after a big crash the car is uncontrollable, it turns by itself
// when driving straight". Reproduce it as a number — heading drift and yaw rate
// with the steering input held at EXACTLY ZERO — and say which steering
// subsystem is commanding the turn.
//
// Real kit geometry with rails, and REAL crashes driven through the contact
// path, because a synthetic tumble (set angVel, set _crashYield) does not
// reproduce it: the car settles and drives perfectly straight.
//
// Run:  node tools/attic/postCrashStraightProbe.mjs
// ============================================================================
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const TMP = join(ROOT, `.postCrash.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, FIXED_DT, TURN_ASSIST, TIRE } = await import(pathToFileURL(TMP).href);
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

// Real straights with real guardrails, 40 pieces so there is room to crash and
// then drive for several seconds afterwards.
let conn = new THREE.Matrix4();
const deckGeos = [], railGeos = [];
for (let i = 0; i < 40; i++) {
  const p = buildPiece("straight", conn);
  const g = p.geometry.clone(); g.applyMatrix4(p.world); deckGeos.push(g);
  if (p.railGeometry) { const r = p.railGeometry.clone(); r.applyMatrix4(p.world); railGeos.push(r); }
  conn = p.connectorOut;
}
const bake = (geos) => {
  if (!geos.length) return null;
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
  return c;
}

const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _flatV = new THREE.Vector3();

/** Body slip angle: heading against the direction of travel, degrees. */
function slipDeg(car) {
  _fwd.set(0, 0, 1).applyQuaternion(car.body.quat);
  _flatV.copy(car.body.vel); _flatV.y = 0;
  if (_flatV.lengthSq() < 1e-6) return 0;
  _flatV.normalize();
  _fwd.y = 0;
  if (_fwd.lengthSq() < 1e-6) return 0;
  _fwd.normalize();
  const cross = _fwd.x * _flatV.z - _fwd.z * _flatV.x;
  return Math.atan2(cross, _fwd.dot(_flatV)) * 57.2958;
}

/**
 * `setup` puts the car into the crash. Afterwards the steering is pinned to
 * ZERO and the throttle held, for `driveSecs`. Anything that curves is the car.
 */
function run({ label, setup, crashSecs = 4, driveSecs = 6 }) {
  const car = makeCar();
  setup(car);
  const nCrash = Math.round(crashSecs / FIXED_DT);
  for (let i = 0; i < nCrash; i++) {
    car.tick({ steerTarget: 0, throttle: 0, handbrake: false, yaw: 0, pitch: 0 });
  }
  // Now DRIVE STRAIGHT. Zero steering, throttle on.
  const rows = [];
  const nDrive = Math.round(driveSecs / FIXED_DT);
  for (let i = 0; i < nDrive; i++) {
    car.tick({ steerTarget: 0, throttle: 1, handbrake: false, yaw: 0, pitch: 0 });
    _fwd.set(0, 0, 1).applyQuaternion(car.body.quat);
    _up.set(0, 1, 0).applyQuaternion(car.body.quat);
    rows.push({
      i,
      heading: Math.atan2(_fwd.x, _fwd.z) * 57.2958,
      yawRate: car.body.angVel.y,
      slip: slipDeg(car),
      grounded: car.groundedCount,
      upY: _up.y,
      steerIn: car.input.steer,
      assistMix: car._turnAssistMix,
      assistCmd: car._turnAssistCmd,
      gripCut: car._gripLimitCut,
      yield: car._crashYield,
      speed: car.body.vel.length(),
      y: car.body.pos.y,
    });
  }
  // Judge the LAST two seconds, on wheels and upright: "driving straight
  // afterwards" means after everything has settled.
  const tail = rows.filter((r) => r.i > nDrive - 240 && r.grounded >= 3 && r.upY > 0.7);
  const ok = tail.length > 60;
  const meanYaw = ok ? tail.reduce((s, r) => s + r.yawRate, 0) / tail.length : NaN;
  const meanSlip = ok ? tail.reduce((s, r) => s + r.slip, 0) / tail.length : NaN;
  const drift = ok ? tail[tail.length - 1].heading - tail[0].heading : NaN;
  const meanSteer = ok ? tail.reduce((s, r) => s + r.steerIn, 0) / tail.length : NaN;
  const meanCut = ok ? tail.reduce((s, r) => s + r.gripCut, 0) / tail.length : NaN;
  const last = rows[rows.length - 1];
  console.log(`${label.padEnd(42)}`
    + (ok
      ? ` yaw ${meanYaw.toFixed(3).padStart(7)}  drift ${drift.toFixed(1).padStart(7)}°`
      + `  slip ${meanSlip.toFixed(1).padStart(6)}°  steerIn ${meanSteer.toFixed(3).padStart(6)}`
      + `  gripCut ${meanCut.toFixed(2).padStart(5)}  v ${last.speed.toFixed(0).padStart(3)}`
      : `  never settled on its wheels (ended y ${last.y.toFixed(1)}, ${last.grounded}/4, up.y ${last.upY.toFixed(2)})`));
  return { meanYaw, drift, meanSlip, ok, rows };
}

console.log(`TURN_ASSIST ${TURN_ASSIST.enabled}  maxG ${TURN_ASSIST.maxG}   TIRE.steerGripLimit ${TIRE.steerGripLimit}`);
console.log("Steering is pinned to ZERO for the whole drive. A straight car reads yaw 0.\n");
console.log("scenario                                        meanYaw    drift    slip   steerIn  gripCut  speed");
console.log("──────────────────────────────────────────────────────────────────────────────────────────────────");

// Control.
run({
  label: "CONTROL — no crash at all",
  crashSecs: 1,
  setup: (c) => {
    c.body.pos.set(0, 0.6, -20);
    c.body.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
    c.body.vel.set(0, 0, -30);
  },
});

// Real crashes, all driven through the contact path on real rails.
for (const [name, pos, vel, quat] of [
  ["glance the rail at 50 m/s", new THREE.Vector3(5, 0.6, -20), new THREE.Vector3(14, 0, -48), null],
  ["hard into the rail, 55 m/s", new THREE.Vector3(4, 0.6, -20), new THREE.Vector3(30, 0, -46), null],
  ["big air, land flat", new THREE.Vector3(0, 12, -20), new THREE.Vector3(0, -18, -40), null],
  ["big air, land nose-down", new THREE.Vector3(0, 12, -20), new THREE.Vector3(0, -20, -40),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -0.7)],
  ["barrel roll, land on the wheels", new THREE.Vector3(0, 10, -20), new THREE.Vector3(0, -14, -42),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI * 2)],
  ["spun 120°, landing sideways", new THREE.Vector3(0, 8, -20), new THREE.Vector3(0, -14, -42),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (120 * Math.PI) / 180)],
]) {
  run({
    label: name,
    setup: (c) => {
      c.body.pos.copy(pos);
      c.body.vel.copy(vel);
      if (quat) c.body.quat.copy(quat);
      else c.body.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(vel.x, vel.z));
    },
  });
}

// And the shape the report describes most directly: thrown into the air BY a
// crash, tumbling, then landing and trying to drive away.
for (const spin of [3, 6, 9]) {
  run({
    label: `tumbling crash, ${spin} rad/s of spin`,
    crashSecs: 5,
    setup: (c) => {
      c.body.pos.set(0, 6, -20);
      c.body.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
      c.body.vel.set(3, 9, -40);
      c.body.angVel.set(spin * 0.4, spin, spin * 0.7);
      c._crashYield = 1.8;
    },
  });
}
