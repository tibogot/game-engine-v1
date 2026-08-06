// Reported: exit a "Loop half" inverted, hold roll to get back onto the wheels,
// and the FIRST 180° is not a roll about the car — it swings through a wide arc,
// "like the rotation origin is not the car". Past 180° it rolls on itself
// correctly.
//
// A rigid body always rotates about its centre of mass, so an apparent pivot
// elsewhere is one of exactly two things:
//
//   (A) CONING. The total angular velocity is not along the chassis forward
//       axis, so the nose sweeps a cone instead of staying put. Half-angle
//       atan(|perpendicular rate| / |roll rate|).
//   (B) A CURVED PATH. The COM is being accelerated sideways while it rotates.
//       Airborne, the only honest acceleration is gravity + drag, so any large
//       non-gravitational acceleration is a smoking gun.
//
// The ring-half is the case that matters and it had never been instrumented:
// every earlier air-roll tool launched off a RAMP, which leaves ~0.74 rad/s of
// pitch. A loop exit leaves v/R — on the kit's 25 m ring at 35 m/s that is
// 1.4 rad/s, twice the ramp's, and it is the whole ingredient.
//
// An instrument, not a pass/fail test.
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = join(ROOT, `.ringroll.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, TIRE, FIXED_DT, GRAVITY } = await import(pathToFileURL(TMP).href);
const { RoadBvh } = await import(pathToFileURL(join(ROOT, "v3/play/modularRoadBvh.js")).href);
const KIT = await import(pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadKit.js")).href);
unlinkSync(TMP);
const { buildPiece, pieceParams } = KIT;

const R2D = 57.2958;
/** Roll actually delivered (deg) at which the cone half-angle is sampled. */
const MILESTONES = [45, 90, 180, 360];

Vehicle.prototype._buildMeshes = function () {
  this.group = new THREE.Group(); this.chassisMesh = new THREE.Object3D();
  this.tireGroups = [0, 0, 0, 0].map(() => new THREE.Group());
  this.arrowGroup = new THREE.Group(); this.arrowGroup.visible = false;
  this.arrows = [0, 0, 0, 0].map(() => ({})); this.wheelSpin = [0, 0, 0, 0];
  this.headlights = []; this.headlightTargets = []; this.headlamps = []; this.taillights = [];
  this._wheelInstances = []; this._wheelParts = [];
};
Vehicle.prototype._updateTaillights = function () {};

/** Straight run-up, then the kit's "loop half" set to the entry→top slice. */
function buildRingHalf(runUp = 3) {
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
  const mk = (geos) => {
    if (!geos.length) return null;
    const bvh = new RoadBvh();
    const meshes = geos.map((g) => new THREE.Mesh(g, new THREE.MeshBasicMaterial()));
    for (const m of meshes) m.updateMatrixWorld(true);
    bvh.bakeFromMeshes(meshes);
    return bvh.baked ? bvh : null;
  };
  return { deck: mk(deck), solids: mk(rails) };
}

/**
 * Drive up the ring half, then hold roll from the moment the car goes airborne.
 * `purity` overrides TIRE.airRollPurity for the sweep.
 */
function run(track, v0, { purity = null, rollDir = -1, secs = 8, log = false, mut = null } = {}) {
  const saved = TIRE.airRollPurity;
  if (purity !== null) TIRE.airRollPurity = purity;
  // Turn individual assists off, the same way tools/jumpDebugTrack.mjs bisects
  // the ramp case.
  const savedMut = {};
  if (mut) for (const k of Object.keys(mut)) { savedMut[k] = TIRE[k]; TIRE[k] = mut[k]; }
  const car = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  car.setBvh(track.deck, track.solids);
  car.getFloorY = () => -200;
  car.enabled = true;
  car.body.pos.set(0, 0.65, -4);
  car.body.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
  car.body.vel.set(0, 0, -v0);

  const fwd = new THREE.Vector3(), up = new THREE.Vector3();
  const perp = new THREE.Vector3(), prevVel = new THREE.Vector3(), nose0 = new THREE.Vector3();
  let airborne = false, tAir = 0, rolled = 0, prevRollSign = 0;
  let exitOmega = null, exitTilt = null, maxCone = 0;
  const coneAt = {};
  const rows = [];
  let peakNonGrav = 0;

  for (let i = 0; i < Math.round(secs / FIXED_DT); i++) {
    const grounded = car.tires.filter((t) => t.grounded).length;
    // Hold roll from the instant the car leaves the ring's top.
    const rolling = airborne;
    prevVel.copy(car.body.vel);
    car.tick({ steerTarget: rolling ? rollDir : 0, throttle: 1, handbrake: false, yaw: 0, pitch: 0 });

    if (!airborne && grounded === 0 && car.body.pos.y > 20) {
      airborne = true;
      fwd.set(0, 0, 1).applyQuaternion(car.body.quat);
      exitOmega = car.body.angVel.clone();
      // How far the exit spin is from the roll axis the player is about to use.
      exitTilt = Math.acos(THREE.MathUtils.clamp(
        exitOmega.clone().normalize().dot(fwd), -1, 1)) * R2D;
      nose0.copy(fwd);
    }
    if (!airborne) continue;
    tAir += FIXED_DT;

    fwd.set(0, 0, 1).applyQuaternion(car.body.quat);
    up.set(0, 1, 0).applyQuaternion(car.body.quat);
    // Roll actually delivered = component of angular velocity on the roll axis.
    const rollRate = car.body.angVel.dot(fwd);
    rolled += rollRate * FIXED_DT;
    // Everything NOT on the roll axis — this is what cones the nose.
    perp.copy(car.body.angVel).addScaledVector(fwd, -rollRate);
    const cone = Math.atan2(perp.length(), Math.abs(rollRate)) * R2D;
    if (tAir > 0.05) maxCone = Math.max(maxCone, cone);
    // Cone measured at fixed milestones of roll ACTUALLY DELIVERED. `maxCone`
    // alone is misleading: it is always ~80°, but that is the first two frames,
    // before the roll rate has spun up through `airResponse` at all — it says
    // nothing about the part of the manoeuvre the player is complaining about.
    const rolledDeg = Math.abs(rolled) * R2D;
    for (const m of MILESTONES) {
      if (coneAt[m] === undefined && rolledDeg >= m) coneAt[m] = cone;
    }
    // (B): acceleration of the COM that is NOT gravity.
    const accel = car.body.vel.clone().sub(prevVel).divideScalar(FIXED_DT);
    accel.y += GRAVITY;
    peakNonGrav = Math.max(peakNonGrav, accel.length());

    if (log && i % 8 === 0 && tAir < 2.2) {
      rows.push(
        `  ${tAir.toFixed(2).padStart(5)}  rolled ${(rolled * R2D).toFixed(0).padStart(5)}°` +
        `  rollRate ${(rollRate * R2D).toFixed(0).padStart(5)}°/s` +
        `  perp ${(perp.length() * R2D).toFixed(0).padStart(4)}°/s` +
        `  CONE ${cone.toFixed(1).padStart(5)}°` +
        `  up.y ${up.y.toFixed(2).padStart(5)}` +
        `  non-grav a ${accel.length().toFixed(1).padStart(5)} m/s²`);
    }
    if (car.tires.some((t) => t.grounded)) break;
  }
  TIRE.airRollPurity = saved;
  if (mut) for (const k of Object.keys(savedMut)) TIRE[k] = savedMut[k];
  return { exitOmega, exitTilt, maxCone, coneAt, rows, tAir, peakNonGrav };
}

const track = buildRingHalf();
console.log(`ring radius ${pieceParams.loopRadius} m   airRollRate ${TIRE.airRollRate} rad/s ` +
  `(${(TIRE.airRollRate * R2D).toFixed(0)}°/s)   airRollPurity ${TIRE.airRollPurity} (τ=${(1 / TIRE.airRollPurity).toFixed(2)} s)`);
console.log(`180° of roll at the commanded rate takes ${(Math.PI / TIRE.airRollRate).toFixed(2)} s\n`);

console.log("=== EXIT STATE OFF THE TOP OF THE RING HALF ===");
console.log("  entry m/s   exit |ω|      v/R predicted   angle(ω, roll axis)   peak non-grav accel");
for (const v0 of [35, 45, 55]) {
  const r = run(track, v0);
  if (!r.exitOmega) { console.log(`  ${String(v0).padStart(9)}   never got airborne`); continue; }
  console.log(`  ${String(v0).padStart(9)}   ${r.exitOmega.length().toFixed(2).padStart(8)} rad/s` +
    `   ${(v0 / pieceParams.loopRadius).toFixed(2).padStart(13)} rad/s` +
    `   ${r.exitTilt.toFixed(0).padStart(19)}°   ${r.peakNonGrav.toFixed(1).padStart(18)} m/s²`);
}

console.log("\n=== (A) CONING vs (B) CURVED PATH — 45 m/s entry, roll held ===");
const trace = run(track, 45, { log: true });
for (const line of trace.rows) console.log(line);
console.log(`\n  peak cone half-angle: ${trace.maxCone.toFixed(1)}°`);
console.log(`  peak non-gravitational acceleration: ${trace.peakNonGrav.toFixed(2)} m/s²` +
  `  (drag only ⇒ (B) is ruled out, the COM path is ballistic)`);

console.log("\n=== HOW MUCH airRollPurity DRIVES IT (45 m/s entry) ===");
console.log("Cone half-angle at each milestone of roll ACTUALLY DELIVERED — this is what the");
console.log("player sees. Past ~10° the nose visibly swings instead of the car rolling.");
console.log("(`peak cone` is useless here: it is always ~80°, but that is the first two");
console.log(" frames, before the roll rate has spun up through airResponse at all.)");
console.log("  purity   τ (s)" + MILESTONES.map((m) => `@${m}°`.padStart(9)).join(""));
for (const p of [0.5, 1.2, 2.5, 5, 10, 20, 40]) {
  const r = run(track, 45, { purity: p });
  console.log(`  ${p.toFixed(1).padStart(6)}   ${(1 / p).toFixed(2).padStart(5)}` +
    MILESTONES.map((m) => (r.coneAt[m] === undefined ? "—" : r.coneAt[m].toFixed(1) + "°").padStart(9)).join(""));
}

// ── WHICH TERM ACTUALLY MAKES THE NOSE SWING? ───────────────────────────────
// The rate-threshold idea is dead (tools/airRollRegimes.mjs: the ramp's own
// perpendicular rate is LARGER than the loop's, so no threshold separates
// them). So bisect the controller instead, exactly as jumpDebugTrack does for
// the ramp: turn each assist off in turn and see which one flattens the cone.
console.log("\n=== WHICH TERM MAKES THE NOSE SWING? (45 m/s entry, roll held) ===");
console.log("  term disabled" + " ".repeat(24) + MILESTONES.map((m) => `@${m}°`.padStart(9)).join(""));
const show = (name, r) => console.log(`  ${name.padEnd(36)}` +
  MILESTONES.map((m) => (r.coneAt[m] === undefined ? "—" : r.coneAt[m].toFixed(1) + "°").padStart(9)).join(""));
show("as shipped", run(track, 45));
for (const [name, mut] of [
  ["heading hold off",              { airHeadingHold: 0 }],
  ["idle-axis damping off",         { airSettle: 0, airRollPurity: 0 }],
  ["arc assist off",                { airTrajectoryAlign: 0 }],
  ["landing assist off",            { airLandAssist: 0 }],
  ["stabilizer damping off",        { stabilizerDamp: 0 }],
  ["arc + landing assists off",     { airTrajectoryAlign: 0, airLandAssist: 0 }],
]) show(name, run(track, 45, { mut }));
