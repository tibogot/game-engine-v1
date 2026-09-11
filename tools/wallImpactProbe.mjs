// ============================================================================
// WALL-IMPACT PROBE — what a collision actually DOES to the car.
//
// Every other collision harness asks a safety question: did the car go through
// the wall, did it launch, is it stuck. All of those can pass while the car
// still hits like a pinball, and that is exactly what shipped. This one asks
// the FEEL question instead, as numbers:
//
//   • exitRatio   speed kept, after / before. A glancing blow should keep most
//                 of its speed; only a head-on should stop the car.
//   • rebound     speed gained ALONG the wall's outward normal. This is the
//                 pinball number. A car is not a ball: a few m/s at worst.
//   • energyRatio total kinetic energy out / in, linear + rotational. A passive
//                 contact can never exceed 1. Above 1 the collider is a spring.
//   • yaw / roll  peak rates. A corner clip should turn the car; a flat hit
//                 should not spin it like a top.
//
// Geometry is a FLAT DECK plus a FLAT VERTICAL WALL along x = +6, so the impact
// angle is exactly the car's heading and nothing else in the kit (kerbs, rail
// caps, posts) muddies the measurement.
//
// Run:  node tools/wallImpactProbe.mjs [--json]
// ============================================================================
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "v3/play/modularRoadVehicle.js");
const TMP = join(ROOT, `.wallProbe.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(SRC, "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));

const { Vehicle, CHASSIS, FIXED_DT } = await import(pathToFileURL(TMP).href);
const { RoadBvh } = await import(pathToFileURL(join(ROOT, "v3/play/modularRoadBvh.js")).href);
unlinkSync(TMP);

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

/** The wall's outward normal — it faces −x, back toward the car. */
export const WALL_N = new THREE.Vector3(-1, 0, 0);
export const WALL_X = 6;

function bake(geos) {
  const bvh = new RoadBvh();
  const meshes = geos.map((g) => new THREE.Mesh(g, new THREE.MeshBasicMaterial()));
  for (const m of meshes) m.updateMatrixWorld(true);
  bvh.bakeFromMeshes(meshes);
  return bvh.baked ? bvh : null;
}

/**
 * Flat deck (top at y=0) plus one vertical wall at x=+6. Deliberately plain: a
 * measurement of the CONTACT MODEL must not also be a measurement of the kit's
 * rail profile.
 */
export function buildWallScene() {
  const deck = new THREE.BoxGeometry(400, 1, 400);
  deck.translate(0, -0.5, 0);
  const wall = new THREE.BoxGeometry(1, 3, 400);
  wall.translate(WALL_X + 0.5, 1.5, 0);
  return { deck: bake([deck]), solids: bake([wall]) };
}

export function makeCar(track) {
  const car = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  car.setBvh(track.deck, track.solids);
  car.getFloorY = () => -50;
  car.enabled = true;
  return car;
}

/** Total kinetic energy, linear + rotational, in the body's own inertia. */
function kineticEnergy(body) {
  const lin = 0.5 * body.mass * body.vel.lengthSq();
  // ω·I·ω needs I, and the body stores I⁻¹ in local space. Rotate ω into local,
  // divide by the local inverse diagonal, dot back.
  const wl = body.angVel.clone().applyQuaternion(body.quat.clone().invert());
  const e = body.localInvInertia.elements;
  const rot = 0.5 * (wl.x * wl.x / e[0] + wl.y * wl.y / e[4] + wl.z * wl.z / e[8]);
  return { lin, rot, total: lin + rot };
}

/**
 * Drive the car at the wall from `angleDeg` off the wall's face and report what
 * the contact did. 0° would be parallel; 90° is dead head-on.
 *
 * `planted` runs the car on its wheels (the common case). `airborne` launches it
 * with no ground contact, which isolates the contact model from the tyres.
 */
export function probe({ track, angleDeg, speed, ticks = 260, planted = true, throttle = 0 }) {
  const car = makeCar(track);
  const a = (angleDeg * Math.PI) / 180;
  // Heading: +x is into the wall, +z is along it.
  const dir = new THREE.Vector3(Math.sin(a), 0, Math.cos(a)).normalize();
  car.body.pos.set(WALL_X - 14, planted ? 0.6 : 1.6, -20);
  car.body.vel.copy(dir).multiplyScalar(speed);
  car.body.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(dir.x, dir.z));
  car.body.angVel.set(0, 0, 0);

  let touched = false;
  let pre = null, post = null, preE = null;
  let peakRebound = 0, peakYaw = 0, peakRoll = 0, peakEnergy = 0;
  let sinceTouch = -1;
  const fwd = new THREE.Vector3();
  const right = new THREE.Vector3();

  for (let i = 0; i < ticks; i++) {
    // The tick BEFORE first contact is the "before" state — sampled every tick
    // until contact so it is always the immediately preceding one.
    if (!touched) {
      pre = { vel: car.body.vel.clone(), speed: car.body.vel.length() };
      preE = kineticEnergy(car.body);
    }
    car.tick({ steerTarget: 0, throttle, handbrake: false, yaw: 0 });
    if (car._solidTouch) { if (!touched) sinceTouch = 0; touched = true; }
    // MEASURE THE CONTACT, NOT THE REST OF THE CAR'S LIFE. The window closes
    // 0.25 s after first touch, which is long after a hit has resolved at
    // 120 Hz and long before the car has landed, rolled and been picked up by
    // something else. Without the bound this probe was reporting the INVERTED
    // LAUNCHER (see tools/attic/invertedLaunchProbe.mjs) — a car that lands
    // past 90 deg of roll gains energy through the tyre path, with no solid
    // contact anywhere near it — as though the wall had thrown it.
    if (touched && sinceTouch < 30) {
      sinceTouch++;
      const vN = car.body.vel.dot(WALL_N);
      if (vN > peakRebound) peakRebound = vN;
      fwd.set(0, 0, 1).applyQuaternion(car.body.quat);
      right.set(1, 0, 0).applyQuaternion(car.body.quat);
      peakYaw = Math.max(peakYaw, Math.abs(car.body.angVel.y));
      peakRoll = Math.max(peakRoll, Math.abs(car.body.angVel.dot(fwd)));
      peakEnergy = Math.max(peakEnergy, kineticEnergy(car.body).total);
      // 0.25 s after first contact the hit has fully resolved but the tyres
      // have not yet re-shaped the result. That is the contact model's answer.
      if (sinceTouch === 30) post = { vel: car.body.vel.clone(), speed: car.body.vel.length(), e: kineticEnergy(car.body) };
    }
  }
  if (!touched) return { touched: false };
  if (!post) post = { vel: car.body.vel.clone(), speed: car.body.vel.length(), e: kineticEnergy(car.body) };

  const headingIn = Math.atan2(pre.vel.x, pre.vel.z);
  const headingOut = Math.atan2(post.vel.x, post.vel.z);
  return {
    touched: true,
    inSpeed: pre.speed,
    outSpeed: post.speed,
    exitRatio: post.speed / Math.max(1e-6, pre.speed),
    rebound: peakRebound,
    energyRatio: peakEnergy / Math.max(1e-6, preE.total),
    yaw: peakYaw,
    roll: peakRoll,
    deflectDeg: ((headingOut - headingIn) * 180) / Math.PI,
    endY: car.body.pos.y,
  };
}

const ANGLES = [10, 20, 30, 45, 60, 90];
const SPEEDS = [12, 25, 40, 55];

export function runMatrix(track, opts = {}) {
  const rows = [];
  for (const speed of SPEEDS) {
    for (const angleDeg of ANGLES) {
      const r = probe({ track, angleDeg, speed, ...opts });
      if (r.touched) rows.push({ speed, angleDeg, ...r });
    }
  }
  return rows;
}

function table(rows, title) {
  console.log(`\n=== ${title} ===`);
  console.log("  spd  ang |  in    out   keep  | rebnd  energy |  yaw   roll | deflect");
  console.log("  ---------|---------------------|---------------|-------------|--------");
  for (const r of rows) {
    const warn = r.energyRatio > 1.02 ? " !" : "  ";
    console.log(
      `  ${String(r.speed).padStart(3)}  ${String(r.angleDeg).padStart(3)} |`
      + ` ${r.inSpeed.toFixed(1).padStart(4)} ${r.outSpeed.toFixed(1).padStart(5)}`
      + ` ${(r.exitRatio * 100).toFixed(0).padStart(4)}% |`
      + ` ${r.rebound.toFixed(1).padStart(5)} ${r.energyRatio.toFixed(2).padStart(6)}${warn}|`
      + ` ${r.yaw.toFixed(2).padStart(5)} ${r.roll.toFixed(2).padStart(6)} |`
      + ` ${r.deflectDeg.toFixed(0).padStart(5)}°`,
    );
  }
}

function summary(rows, label) {
  const glance = rows.filter((r) => r.angleDeg <= 20);
  const headOn = rows.filter((r) => r.angleDeg >= 60);
  const avg = (a, f) => (a.length ? a.reduce((s, r) => s + f(r), 0) / a.length : 0);
  const max = (a, f) => (a.length ? Math.max(...a.map(f)) : 0);
  console.log(`\n--- ${label} ---`);
  console.log(`  glancing (<=20 deg) keeps ${(avg(glance, (r) => r.exitRatio) * 100).toFixed(0)}% of its speed`);
  console.log(`  head-on  (>=60 deg) keeps ${(avg(headOn, (r) => r.exitRatio) * 100).toFixed(0)}% of its speed`);
  console.log(`  worst rebound along the wall normal: ${max(rows, (r) => r.rebound).toFixed(1)} m/s`);
  console.log(`  worst energy ratio (must be <= 1):   ${max(rows, (r) => r.energyRatio).toFixed(2)}`);
  console.log(`  peak yaw ${max(rows, (r) => r.yaw).toFixed(2)} rad/s, peak roll ${max(rows, (r) => r.roll).toFixed(2)} rad/s`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const track = buildWallScene();
  const planted = runMatrix(track, { planted: true });
  const air = runMatrix(track, { planted: false });
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ planted, air }, null, 1));
  } else {
    table(planted, "PLANTED — car on its wheels, driving into the wall");
    summary(planted, "planted");
    table(air, "AIRBORNE — no ground contact, the contact model alone");
    summary(air, "airborne");
  }
}

export { THREE, CHASSIS, FIXED_DT };
