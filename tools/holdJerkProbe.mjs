// WHERE DOES THE FLIP RAMP'S CHASSIS JERK COME FROM?
//
// MEASURED (tools/flipCameraTest.mjs): the car's nose pitches at 15800-28378
// deg/s2 partway up the curl -- an order of magnitude rougher than anything the
// camera does, and the last unexplained roughness in the trick.
//
// Two things are already known and both were surprises:
//   * it is NOT the segment joins. Easing the profile's curvature (flipRampEase)
//     did not improve it -- 15800/16070/28378 became 26797/20092/22244.
//   * it is NOT the launch. It happens at nose ~89 deg, VERTICAL, with all four
//     wheels still on the road.
//
// So the suspect is the road hold, which is doing all the work at that attitude,
// and which contains three hard corners: the curvature feed-forward's maxOmega
// clamp, the `accel < 0` floor, and the maxG cap on the force itself. A clamp is
// a discontinuity in the applied force, and this prints which of them -- if any
// -- is engaged at the moment the chassis is roughest.
//
//   node tools/holdJerkProbe.mjs
import * as THREE from "three";
import { writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GAME = join(ROOT, "games/modular-road-v3");
const { ModularRoadBuilder, CATEGORY_PRESETS } = await import(
  pathToFileURL(join(GAME, "modularRoadBuilder.js")).href);
const { roadParams } = await import(pathToFileURL(join(GAME, "modularRoadKit.js")).href);

const TMP = join(ROOT, `.holdjerk.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const V = await import(pathToFileURL(TMP).href);
unlinkSync(TMP);
const { Vehicle, WHEEL, FIXED_DT, ROAD_HOLD, CHASSIS, GRAVITY } = V;
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

const START = 70, R2D = 180 / Math.PI;
const pos = (m) => new THREE.Vector3().setFromMatrixPosition(m);
/** The per-corner ceiling the hold force is clamped to. See ROAD_HOLD.maxG. */
const CAP = ROAD_HOLD.maxG * CHASSIS.mass * GRAVITY * 0.25;

function build(over = null) {
  const b = new ModularRoadBuilder({
    scene: new THREE.Scene(),
    material: new THREE.MeshBasicMaterial(), railMaterial: new THREE.MeshBasicMaterial(),
    shellMaterial: new THREE.MeshBasicMaterial(), decorMaterial: new THREE.MeshBasicMaterial(),
  });
  const tile = (id) => {
    for (const list of Object.values(CATEGORY_PRESETS)) {
      const t = list.find((x) => x.id === id);
      if (t) return t.preset ?? t;
    }
    throw new Error(`no tile ${id}`);
  };
  b.setSnap({ enabled: true, step: 8, yawDeg: 15 });
  b.beginNewChain(new THREE.Vector3(0, START, 0), 0, { exact: true });
  b.setActivePiece("start"); b.place();
  b.setActivePreset(tile("straight_long")); b.place(); b.place();
  const ramp = tile("flip_ramp_std");
  b.setActivePreset(over ? { ...ramp, params: { ...ramp.params, ...over } } : ramp);
  b.place();
  return b;
}

function bakeGround(b) {
  b.scene.updateMatrixWorld(true);
  const decks = [], solids = [];
  for (const p of b.pieces) {
    const m = p.mesh;
    if (m && !m.userData.noCollision) {
      const proxy = m.userData.collisionGeometry;
      decks.push(proxy
        ? { geometry: proxy, matrixWorld: m.matrixWorld, userData: m.userData, updateMatrixWorld() {} }
        : m);
    }
    for (const extra of [p.railMesh, p.shellMesh]) {
      if (!extra) continue;
      const proxy = extra.userData.collisionGeometry;
      solids.push(proxy
        ? { geometry: proxy, matrixWorld: extra.matrixWorld, updateMatrixWorld() {} }
        : extra);
    }
  }
  const d = new RoadBvh(); d.bakeFromMeshes(decks);
  const g = createVehicleGround({ getTerrainHeight: () => -1e4 });
  g.setRoadBvh(d);
  if (solids.length) { const s = new RoadBvh(); s.bakeFromMeshes(solids); g.setRoadSolidsBvh(s); }
  return g;
}

/** @returns per-tick samples through the climb. */
function climb(speed, over = null) {
  const b = build(over);
  const ground = bakeGround(b);
  const startM = b.pieces.find((p) => p.id === "start").connectorOut;
  const startRot = new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().extractRotation(startM));
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(startRot);

  const car = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  car.groundBvh = ground.ground; car.solidsBvh = ground.solids;
  car.getFloorY = () => -1e4; car.enabled = true;
  car.body.pos.copy(pos(startM)).addScaledVector(fwd, 4);
  car.body.pos.y += WHEEL.radius + 0.25;
  car.body.quat.copy(startRot).multiply(
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI));
  car.body.vel.copy(fwd).multiplyScalar(speed);

  const f = new THREE.Vector3();
  const out = [];
  let prevNose = null, prevRate = null, t = 0, prevW = null;
  const wNow = new THREE.Vector3();
  for (let i = 0; i < Math.round(8 / FIXED_DT); i++) {
    car.tick({ steerTarget: 0, throttle: 1, handbrake: false, yaw: 0, pitch: 0, airSteer: 0 });
    t += FIXED_DT;
    f.set(0, 0, 1).applyQuaternion(car.body.quat);
    const nose = Math.asin(THREE.MathUtils.clamp(f.y, -1, 1)) * R2D;
    let acc = 0;
    if (prevNose !== null) {
      const rate = (nose - prevNose) / FIXED_DT;
      if (prevRate !== null) acc = Math.abs(rate - prevRate) / FIXED_DT;
      prevRate = rate;
    }
    prevNose = nose;
    // THE SAME QUANTITY, TAKEN FROM THE BODY. `acc` above differentiates
    // asin(forward.y) -- which is fine anywhere except where the nose passes
    // VERTICAL, because d(asin)/dy is unbounded as y -> 1. This one reads the
    // rigid body's own angular velocity and has no such pole.
    let trueAcc = 0;
    if (prevW !== null) trueAcc = wNow.copy(car.body.angVel).sub(prevW).length() / FIXED_DT * R2D;
    (prevW ??= new THREE.Vector3()).copy(car.body.angVel);
    const grounded = car.groundedCount;
    if (grounded > 0 && nose > 20) {
      // PER TYRE, not per car: the hold is computed and clamped in each tyre,
      // so a cap that bites on one corner is invisible in any average.
      let hold = 0, omega = 0, atCap = false, atOmega = false, live = 0;
      for (const tr of car.tires) {
        const f = tr.roadHoldForce ?? 0;
        if (f > hold) hold = f;
        if (f >= CAP - 1e-6) atCap = true;
        if (f > 1e-9) live++;
        const w = tr._holdOmega ?? 0;
        if (Math.abs(w) > Math.abs(omega)) omega = w;
        if (Math.abs(w) >= ROAD_HOLD.maxOmega - 1e-9) atOmega = true;
      }
      // What the SUSPENSION is doing. At vertical, gravity has no component into
      // the surface at all, so the only thing loading these tyres is the curl's
      // own centripetal demand -- which is exactly the regime where a strut can
      // top out, drop its load to nothing, and slam back on.
      let minComp = 9, maxComp = 0, load = 0;
      for (const tr of car.tires) {
        const c = tr.compression ?? 0;
        if (c < minComp) minComp = c;
        if (c > maxComp) maxComp = c;
        load += tr.lastFz ?? tr.normalForce ?? tr.load ?? 0;
      }
      out.push({ t, nose, acc, grounded, hold, omega, atCap, atOmega,
        holdZero: live === 0, minComp, maxComp, load, trueAcc,
        upY: new THREE.Vector3(0, 1, 0).applyQuaternion(car.body.quat).y,
        wy: car.body.angVel.length() });
    }
    if (grounded === 0 && out.length > 40) break;
  }
  return out;
}

console.log("\nWHERE THE FLIP RAMP'S CHASSIS JERK COMES FROM\n");
console.log(`  hold force cap = ${CAP.toFixed(0)} N per corner `
  + `(ROAD_HOLD.maxG ${ROAD_HOLD.maxG} g)\n`);

// ── 1. NOT THE ROAD HOLD, AND NOT THE SUSPENSION? ─────────────────────
// The hold was the obvious suspect and is ruled out below. The next one is the
// strut: at vertical the surface normal is horizontal, so gravity pulls the car
// ALONG the road rather than into it, and the only thing holding the tyres down
// is the curl's centripetal demand.
{
  const s = climb(26);
  const peak = s.reduce((a, x) => (x.acc > a.acc ? x : a), s[0]);
  const liveFrames = s.filter((x) => !x.holdZero).length;
  const negOmega = s.filter((x) => x.omega < 0).length;
  console.log(`  worst chassis pitch ${peak.acc.toFixed(0)}\u00b0/s\u00b2 at nose `
    + `${peak.nose.toFixed(0)}\u00b0, ${peak.grounded} wheels down`);
  console.log(`  over ${s.length} ticks of climb: hold force applied on ${liveFrames}, `
    + `omega negative on ${negOmega}`);
  console.log("  => NOT the hold. Its feed-forward is gated on `_holdOmega > 0`, and on");
  console.log("     the curl the car is on the CONCAVE side, so omega is negative all the");
  console.log("     way up and the assist correctly adds nothing.\n");

  const at = s.indexOf(peak);
  console.log("      nose   asin-jerk   strut compression   chassis spin   TRUE jerk");
  for (let i = Math.max(0, at - 5); i <= Math.min(s.length - 1, at + 4); i++) {
    const x = s[i];
    console.log(`   ${i === at ? ">" : " "} ${x.nose.toFixed(1).padStart(5)}\u00b0 `
      + `${x.acc.toFixed(0).padStart(7)}  `
      + `${x.minComp.toFixed(3)}..${x.maxComp.toFixed(3)} m   `
      + `${x.wy.toFixed(2)} rad/s   `
      + `real ${x.trueAcc.toFixed(0).padStart(5)}`);
  }
  console.log("");
}

// ── 2. IS IT THE TESSELLATION? ──────────────────────────────────────────────
// The peak is a ONE-TICK spike, and the omega the hold measures through the curl
// sits at 2.5-3.4 rad/s -- which is the figure the hold's own comments give for
// the PER-FACET peak on a faceted deck. Both point at the car crossing a
// triangle boundary, where the contact normal steps and the chassis is pitched
// in a single tick.
//
// So rebuild the same ramp with a tighter sagitta budget -- the knob that sets
// how finely the profile is swept -- and drive it again. If the jerk scales down
// with the facet size then it is tessellation and nothing else.
const BASE = roadParams.stepSagitta;
console.log("  sagitta    ramp verts    worst chassis pitch at 26 / 32 / 38 m/s");
console.log("  " + "-".repeat(66));
for (const mul of [1, 0.25, 0.0625]) {
  roadParams.stepSagitta = BASE * mul;
  const row = [];
  for (const v of [26, 32, 38]) {
    const s = climb(v);
    row.push(s.reduce((a, x) => (x.trueAcc > a.trueAcc ? x : a), s[0]).trueAcc);
  }
  const b = build();
  const ramp = b.pieces.find((p) => p.id === "flip_ramp");
  const verts = ramp?.mesh?.geometry?.attributes?.position?.count ?? 0;
  console.log(`  ${(BASE * mul).toFixed(5)}  ${String(verts).padStart(8)}    `
    + row.map((x) => `${x.toFixed(0).padStart(8)}`).join("  ")
    + (mul === 1 ? "    <- shipped" : ""));
}
roadParams.stepSagitta = BASE;
console.log("");

// ── 3. AND DOES THE EASEMENT ACTUALLY DO ANYTHING? ──────────────────────────
// It was added to cure the jerk and judged a failure on the asin metric, which
// is now known to have been measuring a singularity rather than the car. Worth
// asking the question again with a number that means something.
console.log("  flipRampEase   TRUE worst chassis jerk at 26 / 32 / 38 m/s");
console.log("  " + "-".repeat(60));
for (const e of [0, 1]) {
  const row = [];
  for (const v of [26, 32, 38]) {
    const s = climb(v, { flipRampEase: e });
    row.push(s.reduce((a, x) => (x.trueAcc > a.trueAcc ? x : a), s[0]).trueAcc);
  }
  console.log(`  ${e === 0 ? "0 (plain)   " : "1 (eased)   "}   `
    + row.map((x) => `${x.toFixed(0).padStart(8)}`).join("  "));
}
console.log("");
