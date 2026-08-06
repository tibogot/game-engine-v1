// WHERE DOES THE CAR ACTUALLY SIT ON SCREEN?
//
// The chase rig was reported as "not aligned with the car — sometimes the camera
// is up, sometimes down; on a steep ramp you only see the tip of the car; when
// upside down the camera is below and the car above". All of those are the same
// measurement — the car's SCREEN POSITION — and it is supposed to be constant.
// So this measures it directly instead of reasoning about the rig.
//
//     ndc.y = 0   car dead centre
//     ndc.y = -1  car on the BOTTOM edge of the frame
//     |ndc.y| > 1 car OFF SCREEN            <- "I only see the tip of the car"
//
// Measured on the rig this replaced: flat road −0.41, steep ramp +0.12, vertical
// wall +0.38, a −60° descent −1.22 (off the bottom of the screen) and inverted
// +0.41 with the camera 3.2 m BELOW the car. A spread of 1.6 — more than a full
// frame height — from nothing but attitude.
//
// PART A is static attitudes: pure geometry, no physics, so a framing bug cannot
// hide behind a transient. PART B drives the real Vehicle through a real loop
// piece, off the top inverted, through an air roll and into a landing, because
// that is where a rig HANDOVER would show up and part A cannot see one.
//
// Run: node tools/chaseFramingTest.mjs
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const R2D = 57.2958;
const DT = 1 / 60;
const SETTLE = 4.0; // seconds of steady state before part A reads anything

const { createChaseCamera } = await import(
  pathToFileURL(join(ROOT, "games/modular-road-v3/chaseCamera.js")).href);

let failed = 0;
const check = (ok, msg) => {
  if (!ok) failed++;
  console.log(`${ok ? "  ok   " : "  FAIL "}${msg}`);
};

// ═══ SHARED MEASUREMENT ═════════════════════════════════════════════════════

/**
 * Car centre in normalised device coords, its on-screen roll, and the range.
 *
 * `ang` is the same framing as `y` but in DEGREES off the view axis, which is
 * what the rig actually controls: ndc additionally moves with the FOV, and the
 * speed-FOV kick deliberately widens the view by 12°, so ndc alone reads a
 * perfectly steady rig as drifting 0.08 between a crawl and top speed.
 */
function measure(camera, pos, quat) {
  camera.updateMatrixWorld(true);
  const toCar = pos.clone().sub(camera.position).normalize();
  const camFwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  const camUp = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
  const ang = Math.atan2(toCar.dot(camUp), toCar.dot(camFwd)) * R2D;
  // How far round the SIDE the camera has swung: the angle between "straight
  // astern" and where it actually is, measured in the car's own up-plane. This
  // is the loop-swing flourish, and it must be able to move without `ang`
  // (the vertical framing) budging at all.
  const carUp = new THREE.Vector3(0, 1, 0).applyQuaternion(quat);
  const carBack = new THREE.Vector3(0, 0, -1).applyQuaternion(quat);
  const behind = camera.position.clone().sub(pos);
  behind.addScaledVector(carUp, -behind.dot(carUp)).normalize();
  const carRight = new THREE.Vector3().crossVectors(carUp, carBack);
  const side = Math.atan2(behind.dot(carRight), behind.dot(carBack)) * R2D;
  const ndc = pos.clone().project(camera);
  // Screen-space direction of the car's up-axis: project a point 1 m above the
  // car and compare. Aspect-corrected, so the angle is a real screen angle.
  const tip = pos.clone()
    .addScaledVector(new THREE.Vector3(0, 1, 0).applyQuaternion(quat), 1)
    .project(camera);
  const dx = (tip.x - ndc.x) * camera.aspect;
  const dy = tip.y - ndc.y;
  return {
    x: ndc.x,
    y: ndc.y,
    ang,
    side,
    roll: Math.atan2(dx, dy) * R2D,
    dist: camera.position.distanceTo(pos),
    camAboveCar: camera.position.y - pos.y,
  };
}

// ═══ PART A — STATIC ATTITUDES ══════════════════════════════════════════════

/** Minimal stand-in for the Vehicle fields the rig reads. */
function makeStubCar() {
  const body = {
    pos: new THREE.Vector3(),
    vel: new THREE.Vector3(),
    quat: new THREE.Quaternion(),
  };
  return { body, renderPos: body.pos, renderQuat: body.quat, groundedCount: 4 };
}

/** Put the car in an attitude and let it travel along its own forward axis. */
function poseCar(vehicle, { pitch = 0, roll = 0, speed = 25, grounded = true }) {
  // Car forward is +Z. Yaw 0, pitch about X, roll about Z.
  const q = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(pitch / R2D, 0, roll / R2D, "YXZ"));
  vehicle.body.quat.copy(q);
  vehicle.groundedCount = grounded ? 4 : 0;
  // Travel along the car's own forward — i.e. up the ramp, round the loop.
  vehicle.body.vel.set(0, 0, 1).applyQuaternion(q).multiplyScalar(speed);
}

/** Hold a pose for `SETTLE` s (advancing the car along its velocity), then read. */
function holdPose(label, pose, out, dt = DT, patch = null) {
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 5000);
  const vehicle = makeStubCar();
  const chase = createChaseCamera({ camera, vehicle });
  if (patch) Object.assign(chase.params, patch);
  poseCar(vehicle, pose);
  chase.reset();
  for (let t = 0; t < SETTLE; t += dt) {
    vehicle.body.pos.addScaledVector(vehicle.body.vel, dt);
    chase.update(dt);
  }
  const m = measure(camera, vehicle.body.pos, vehicle.body.quat);
  console.log(
    `  ${label.padEnd(26)} ndc.y ${m.y.toFixed(2).padStart(6)}  ` +
    `off-axis ${m.ang.toFixed(1).padStart(6)}°  side ${m.side.toFixed(0).padStart(4)}°  ` +
    `roll ${m.roll.toFixed(0).padStart(4)}°  ` +
    `dist ${m.dist.toFixed(1).padStart(5)} m  ` +
    `camAbove ${m.camAboveCar.toFixed(1).padStart(5)} m${Math.abs(m.y) > 1 ? "  <-- OFF SCREEN" : ""}`);
  out.push(m);
}

console.log("\n═══ A. STATIC ATTITUDES (grounded, 25 m/s along the car's forward) ═══");
console.log("  ndc.y: 0 = centred, -1 = bottom edge, |y|>1 = off screen");
console.log("  roll : on-screen angle of the car's up-axis (0 = looks upright)\n");
const statics = [];
for (const [label, pose] of [
  ["flat road", { pitch: 0 }],
  ["gentle climb 15deg", { pitch: 15 }],
  ["ramp climb 30deg", { pitch: 30 }],
  ["steep ramp 45deg", { pitch: 45 }],
  ["very steep ramp 70deg", { pitch: 70 }],
  ["vertical wall 90deg", { pitch: 90 }],
  ["descent -30deg", { pitch: -30 }],
  ["descent -60deg", { pitch: -60 }],
  ["banked 30deg", { roll: 30 }],
  ["wall ride 80deg roll", { roll: 80 }],
  ["past vertical 120deg", { pitch: 120 }],
  ["loop apex, inverted", { pitch: 180 }],
  ["airborne, nosed up 40", { pitch: 40, grounded: false }],
  ["airborne, nosed down 40", { pitch: -40, grounded: false }],
]) holdPose(label, pose, statics);

const ys = statics.map((m) => m.y);
const angs = statics.map((m) => m.ang);
const spread = Math.max(...angs) - Math.min(...angs);
const maxRoll = Math.max(...statics.map((m) => Math.abs(m.roll)));
const dists = statics.map((m) => m.dist);
console.log("");
check(spread < 0.5,
  `framing is attitude-INVARIANT: the car sits ${angs[0].toFixed(1)}° off the view axis at every one of ` +
  `14 attitudes (spread ${spread.toFixed(2)}° < 0.5°)`);
check(Math.max(...ys.map(Math.abs)) < 0.9,
  `car always comfortably in frame: worst |ndc.y| ${Math.max(...ys.map(Math.abs)).toFixed(2)} (< 0.9)`);
check(maxRoll < 2,
  `OUTSIDE a loop the car reads upright at every attitude, inverted included: worst screen roll ` +
  `${maxRoll.toFixed(1)}° (< 2°).
         A held attitude is not a loop — the loop shot is triggered by ` +
  `the road turning over, and it deliberately
         does the opposite (see THE LOOP SHOT below)`);
check(Math.max(...dists) - Math.min(...dists) < 0.3,
  `chase distance holds: ${Math.min(...dists).toFixed(1)}..${Math.max(...dists).toFixed(1)} m (spread < 0.3)`);

// ── SPEED, and FRAMERATE ────────────────────────────────────────────────────
// An exponential follow lags a moving target, so without compensation the chase
// distance grows with speed — the car shrinks into the distance exactly when you
// most need to see it, and the framing goes with it. The frame rates are here
// because the lag term is a property of the DISCRETE filter: get it wrong and
// the chase distance quietly depends on how fast the machine renders.
console.log("\n  Flat road, rising speed — framing and distance must not drift:\n");
const bySpeed = [];
for (const speed of [5, 15, 25, 35, 50]) holdPose(`${speed} m/s @60fps`, { speed }, bySpeed);
for (const [fps, dt] of [[30, 1 / 30], [144, 1 / 144]]) {
  holdPose(`25 m/s @${fps}fps`, { speed: 25 }, bySpeed, dt);
}
console.log("");
const sa = bySpeed.map((m) => m.ang), sd = bySpeed.map((m) => m.dist);
check(Math.max(...sa) - Math.min(...sa) < 0.5,
  `framing is SPEED- and FRAMERATE-invariant: off-axis spread ${(Math.max(...sa) - Math.min(...sa)).toFixed(2)}° (< 0.5°). ` +
  `The ndc
         column moves only because the speed-FOV kick widens the view by 12° on purpose`);
check(Math.max(...sd) - Math.min(...sd) < 0.15,
  `chase distance doesn't stretch with speed: ${Math.min(...sd).toFixed(2)}..${Math.max(...sd).toFixed(2)} m (spread < 0.15)`);

// ── LOOP SWING, PART 1: THE DISCRIMINATOR, ON SCRIPTED MANOEUVRES ───────────
//
// The swing has to come out on a loop and on NOTHING else, and the two cases it
// is easiest to get wrong — a flat corner and a BANKED corner — cannot be tested
// by driving real pieces at all: with no steering input the car simply leaves
// the road and everything after that is crash noise (a "plain curve" measured a
// 10 m radius that way, tighter than the loop). So script the manoeuvres
// directly. No physics, no track, exact motion, and the one number that decides
// it — the road radius the rig infers — is readable straight off.
//
// Note also that a HELD attitude, however inverted, produces no swing at all and
// never should: the key is the road turning over, not how far over you are.
function scripted(label, step, { secs = 3, speed = 35 } = {}) {
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 5000);
  const vehicle = makeStubCar();
  const chase = createChaseCamera({ camera, vehicle });
  chase.reset();
  let peak = 0, minR = Infinity, maxT = 0;
  for (let i = 0, t = 0; t < secs; i++, t += DT) {
    step(vehicle.body.quat, t, speed);
    vehicle.body.vel.set(0, 0, 1).applyQuaternion(vehicle.body.quat).multiplyScalar(speed);
    vehicle.body.pos.addScaledVector(vehicle.body.vel, DT);
    chase.update(DT);
    if (t > 1.0) { // let the low-pass fill
      peak = Math.max(peak, Math.abs(chase.state.swing));
      minR = Math.min(minR, chase.state.radius);
      maxT = Math.max(maxT, chase.state.turned);
    }
  }
  console.log(`  ${label.padEnd(28)} swing ${peak.toFixed(0).padStart(3)}°   ` +
    `road radius ${(minR > 9999 ? "flat" : minR.toFixed(0) + " m").padStart(6)}` +
    `   turned ${maxT.toFixed(0).padStart(4)}°`);
  return peak;
}

const yawQ = (a) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), a);
const pitchQ = (a) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), a);
const rollQ = (a) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), a);

console.log("\n  Loop swing — which manoeuvres does it consider a loop?\n");
const swung = {};
swung.straight = scripted("flat straight", (q) => q.identity());
swung.corner = scripted("flat corner, R 30 m", (q, t, v) => q.copy(yawQ(v / 30 * t)));
swung.banked = scripted("BANKED corner, R 30 m, 30deg",
  (q, t, v) => q.copy(yawQ(v / 30 * t)).multiply(rollQ(30 / R2D)));
swung.ramp = scripted("ramp up to 30deg, then held",
  (q, t) => q.copy(pitchQ(Math.min(1, t / 0.6) * 30 / R2D)));
swung.steep = scripted("steep ramp to 70deg, then held",
  (q, t) => q.copy(pitchQ(Math.min(1, t / 0.9) * 70 / R2D)));
swung.crest = scripted("crest: +15deg and back",
  (q, t) => q.copy(pitchQ(Math.sin(Math.min(Math.PI, t * 2.6)) * 15 / R2D)));
swung.loop = scripted("LOOP, R 15 m", (q, t, v) => q.copy(pitchQ(v / 15 * t)));
swung.bigLoop = scripted("LOOP, R 25 m", (q, t, v) => q.copy(pitchQ(v / 25 * t)));
swung.slowLoop = scripted("LOOP, R 15 m, at 15 m/s",
  (q, t, v) => q.copy(pitchQ(v / 15 * t)), { speed: 15, secs: 4 });
console.log("");
const worstNot = Math.max(swung.straight, swung.corner, swung.banked, swung.ramp,
  swung.steep, swung.crest);
check(worstNot < 5,
  `the swing ignores everything that is not a loop — flat, corners, BANKED corners, ` +
  `ramps up to 70°\n         and crests all stay dead astern (worst ${worstNot.toFixed(1)}° < 5°)`);
check(swung.loop > 55 && swung.bigLoop > 40,
  `and comes fully out on a loop: ${swung.loop.toFixed(0)}° at R 15 m, ${swung.bigLoop.toFixed(0)}° at R 25 m`);
check(Math.abs(swung.slowLoop - swung.loop) < 8,
  `the same loop taken SLOWLY swings the same: ${swung.slowLoop.toFixed(0)}° at 15 m/s vs ` +
  `${swung.loop.toFixed(0)}° at 35 m/s — keyed on the road's curvature, not on rate,\n` +
  `         which would have made the effect a high-speed-only accident`);

// ═══ PART B — REAL PHYSICS: LOOP, INVERTED EXIT, AIR ROLL, LANDING ══════════

const TMP = join(ROOT, `.chasefr.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, FIXED_DT } = await import(pathToFileURL(TMP).href);
const { RoadBvh } = await import(pathToFileURL(join(ROOT, "v3/play/modularRoadBvh.js")).href);
const { buildPiece, pieceParams } = await import(
  pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadKit.js")).href);
unlinkSync(TMP);

// Headless: no renderer, so strip the mesh building.
Vehicle.prototype._buildMeshes = function () {
  this.group = new THREE.Group(); this.chassisMesh = new THREE.Object3D();
  this.tireGroups = [0, 0, 0, 0].map(() => new THREE.Group());
  this.arrowGroup = new THREE.Group(); this.arrowGroup.visible = false;
  this.arrows = [0, 0, 0, 0].map(() => ({})); this.wheelSpin = [0, 0, 0, 0];
  this.headlights = []; this.headlightTargets = []; this.headlamps = []; this.taillights = [];
  this._wheelInstances = []; this._wheelParts = [];
};
Vehicle.prototype._updateTaillights = function () {};

/**
 * Run-up → half loop → off the top inverted → floor. The floor matters: without
 * a landing pad the car never touches down, and touchdown is exactly where a rig
 * handover would spike.
 */
function buildRingHalf(runUp = 14) {
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
  const g = new THREE.PlaneGeometry(200, 260);
  g.rotateX(-Math.PI / 2);
  g.translate(0, 0, -130);
  deck.push(g);
  const mk = (gs) => {
    if (!gs.length) return null;
    const b = new RoadBvh();
    b.bakeFromMeshes(gs.map((geo) => {
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial());
      m.updateMatrixWorld(true);
      return m;
    }));
    return b.baked ? b : null;
  };
  return { deck: mk(deck), solids: mk(rails) };
}

/**
 * Drive it and watch the SCREEN, not the rig internals.
 *
 * `screenRoll` vs `bodyRoll` is the one that decides the air behaviour: the rig
 * levels itself in flight, and if it happened to level at the same rate the
 * player rolls, the trick would cancel out on screen and the roll would be
 * INVISIBLE. The ratio is how much of the player's roll actually reaches the
 * screen — 1.0 is a roll shown in full.
 */
function driveRing({ v0 = 45, secs = 12, rollDir = -1, patch = null } = {}) {
  const track = buildRingHalf();
  const car = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  car.setBvh(track.deck, track.solids);
  car.getFloorY = () => -200;
  car.enabled = true;
  car.body.pos.set(0, 0.65, -4);
  car.body.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
  car.body.vel.set(0, 0, -v0);
  car._resetInterpolation();

  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 5000);
  const chase = createChaseCamera({ camera, vehicle: car });
  if (patch) Object.assign(chase.params, patch);
  chase.reset();

  const fwd = new THREE.Vector3();
  let airborne = false, tAir = 0, landT = null;
  let yMin = Infinity, yMax = -Infinity, xMax = 0;
  let dMin = Infinity, dMax = 0;
  // SNAP DETECTORS. Raw camera speed relative to the car is NOT one: through a
  // loop the rig legitimately carries the camera round the car on an 8 m arc,
  // which is 24 m/s of "relative speed" with nothing wrong at all. What a rig
  // handover actually does is move the camera IN or OUT (radial) and shift the
  // car ON SCREEN — so measure those two rates instead.
  let prevDist = null, prevY = null, peakRadial = 0, peakFrameRate = 0, peakFrameAt = "";
  let peakSide = 0, sideRows = [], peakCarRoll = 0;
  // CAN THE CAMERA ACTUALLY SEE THE CAR? Everything else in this file measures
  // where the car would land on screen ASSUMING it is visible. A camera buried
  // in the loop's own tube frames the car perfectly and shows you tarmac.
  let blocked = 0, losFrames = 0;
  const _losDir = new THREE.Vector3();
  let bodyRoll = 0, screenRoll = 0, prevRoll = null, offScreen = 0, frames = 0;
  const rows = [];

  for (let i = 0; i < Math.round(secs / FIXED_DT); i++) {
    const groundedNow = car.tires.some((t) => t.grounded);
    if (!airborne && !groundedNow && car.body.pos.y > 20) airborne = true;
    // Steering is roll input once airborne — that is the trick we're measuring.
    car.tick({ steerTarget: airborne && landT === null ? rollDir : 0, throttle: 1, handbrake: false, yaw: 0, pitch: 0 });
    // The rig follows the INTERPOLATED render pose, and only syncVisuals writes
    // it — without this the camera chases a pose frozen at the spawn point.
    car.syncVisuals(FIXED_DT, 1);
    chase.update(FIXED_DT);

    const m = measure(camera, car.body.pos, car.body.quat);
    // Ignore the first moments: the rig is still seating itself from reset().
    if (i > 30) {
      frames++;
      yMin = Math.min(yMin, m.y); yMax = Math.max(yMax, m.y);
      xMax = Math.max(xMax, Math.abs(m.x));
      dMin = Math.min(dMin, m.dist); dMax = Math.max(dMax, m.dist);
      if (Math.abs(m.y) > 1) offScreen++;
      peakSide = Math.max(peakSide, Math.abs(m.side));
      // THE POINT OF THE LOOP SHOT: how far over the car appears to go ON
      // SCREEN. A frame that rides the road all the way round keeps this near 0
      // and turns the world over instead — which is the thing that was wrong.
      if (!airborne) peakCarRoll = Math.max(peakCarRoll, Math.abs(m.roll));
      // Raycast camera -> car against the deck. Anything hit before we reach the
      // car is road between the two, i.e. the shot is blind. Stop a little short
      // so the deck the car is standing ON doesn't count as an obstruction.
      _losDir.copy(car.body.pos).sub(camera.position);
      const losLen = _losDir.length();
      if (losLen > 1e-3) {
        _losDir.multiplyScalar(1 / losLen);
        losFrames++;
        if (track.deck.raycastFirst(camera.position, _losDir, losLen - 1.5)) blocked++;
      }
      if (!airborne && i % 10 === 0) {
        const cu = new THREE.Vector3(0, 1, 0).applyQuaternion(car.body.quat);
        sideRows.push(`    loop t=${(i * FIXED_DT).toFixed(2)}s  carUp.y ${cu.y.toFixed(2).padStart(5)}` +
          `  loop ${(chase.state.loop * 100).toFixed(0).padStart(3)}%` +
          `  swing ${chase.state.swing.toFixed(0).padStart(3)}°  side ${m.side.toFixed(0).padStart(4)}°` +
          `  CAR ON SCREEN: roll ${m.roll.toFixed(0).padStart(4)}°  ndc.y ${m.y.toFixed(2).padStart(5)}`);
      }
      if (prevDist !== null) {
        peakRadial = Math.max(peakRadial, Math.abs(m.dist - prevDist) / FIXED_DT);
        const fr = Math.abs(m.y - prevY) / FIXED_DT;
        if (fr > peakFrameRate) {
          peakFrameRate = fr;
          // WHERE it happened matters more than the number: a spike at the loop
          // entry is the frame legitimately swinging onto a new surface, one at
          // touchdown would be a handover.
          peakFrameAt = `t=${(i * FIXED_DT).toFixed(2)}s ` +
            (landT !== null ? "after landing" : airborne ? "in flight" : "on the ground");
        }
      }
      prevDist = m.dist; prevY = m.y;
    }

    if (airborne) {
      if (car.tires.some((t) => t.grounded) && landT === null) landT = tAir;
      if (landT === null) {
        tAir += FIXED_DT;
        fwd.set(0, 0, 1).applyQuaternion(car.body.quat);
        bodyRoll += Math.abs(car.body.angVel.dot(fwd)) * FIXED_DT * R2D;
        if (prevRoll !== null) {
          let d = m.roll - prevRoll;
          while (d > 180) d -= 360;
          while (d < -180) d += 360;
          screenRoll += Math.abs(d);
        }
        prevRoll = m.roll;
        if (i % 10 === 0) {
          rows.push(`    air ${tAir.toFixed(2).padStart(5)}s   ndc.y ${m.y.toFixed(2).padStart(6)}` +
            `   dist ${m.dist.toFixed(1).padStart(4)} m   car rolled ${bodyRoll.toFixed(0).padStart(4)}°` +
            `   shown ${screenRoll.toFixed(0).padStart(4)}°`);
        }
      } else if (tAir > 0 && landT !== null && i % 10 === 0 && rows.length < 40) {
        rows.push(`    land+${(tAir).toFixed(2)}s  ndc.y ${m.y.toFixed(2).padStart(6)}   dist ${m.dist.toFixed(1).padStart(4)} m`);
      }
      if (landT !== null) { tAir += FIXED_DT; if (tAir > landT + 1.5) break; }
    }
  }
  return { blocked, losFrames, peakSide, peakCarRoll, sideRows, yMin, yMax, xMax, dMin, dMax, peakRadial, peakFrameRate, peakFrameAt, offScreen, frames,
    bodyRoll, screenRoll, rows };
}

// ── "ONLY FOR LOOPING" — the swing must ignore everything that is not a loop ─
// This is the trap the old rig's own notes describe: TILT cannot tell a loop
// from a steep ramp, because both lay the car over by the same angle. The swing
// is keyed on a low-passed rotation RATE instead — "does the road keep turning
// over" rather than "how far over am I" — and the only honest way to know
// whether that discriminates is to drive the other pieces and look.
function buildTrack(ids) {
  const pp = { ...pieceParams, loopHalf: "in" };
  let conn = new THREE.Matrix4();
  const deck = [], rails = [];
  for (const id of ids) {
    const p = buildPiece(id, conn, pp);
    for (const g of [p.geometry, p.shellGeometry]) {
      if (!g) continue;
      const c = g.clone(); c.applyMatrix4(p.world); deck.push(c);
    }
    if (p.railGeometry) { const r = p.railGeometry.clone(); r.applyMatrix4(p.world); rails.push(r); }
    conn = p.connectorOut;
  }
  const g = new THREE.PlaneGeometry(400, 500);
  g.rotateX(-Math.PI / 2);
  g.translate(0, -0.05, -220);
  deck.push(g);
  const mk = (gs) => {
    if (!gs.length) return null;
    const b = new RoadBvh();
    b.bakeFromMeshes(gs.map((geo) => {
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial());
      m.updateMatrixWorld(true);
      return m;
    }));
    return b.baked ? b : null;
  };
  return { deck: mk(deck), solids: mk(rails) };
}

/** Biggest swing round the side over a whole run down `ids`. */
function peakSwing(ids, { v0 = 40, secs = 7 } = {}) {
  const track = buildTrack(ids);
  const car = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  car.setBvh(track.deck, track.solids);
  car.getFloorY = () => -200;
  car.enabled = true;
  car.body.pos.set(0, 0.65, -4);
  car.body.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
  car.body.vel.set(0, 0, -v0);
  car._resetInterpolation();
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 5000);
  const chase = createChaseCamera({ camera, vehicle: car });
  chase.reset();
  let peak = 0, peakRate = Infinity, maxTurn = 0;
  for (let i = 0; i < Math.round(secs / FIXED_DT); i++) {
    car.tick({ steerTarget: 0, throttle: 1, handbrake: false, yaw: 0, pitch: 0 });
    car.syncVisuals(FIXED_DT, 1);
    chase.update(FIXED_DT);
    // The rig's OWN swing, not where the camera ended up — see the note on
    // `state` in chaseCamera.js.
    if (i > 30) {
      peak = Math.max(peak, Math.abs(chase.state.swing));
      peakRate = Math.min(peakRate, chase.state.radius);
      maxTurn = Math.max(maxTurn, chase.state.turned);
    }
  }
  return { swing: peak, radius: peakRate, turned: maxTurn };
}

console.log("\n═══ B. LOOP SWING — does it fire on loops, and ONLY on loops? ═══\n");
const RUN = ["straight", "straight", "straight", "straight", "straight", "straight"];
const swingBy = {};
for (const [label, ids] of [
  ["flat straights", RUN],
  ["slope (climb)", [...RUN, "slope", "straight", "straight"]],
  ["crest (hump)", [...RUN, "crest", "straight", "straight"]],
  ["jump ramp", [...RUN, "jump", "straight", "straight"]],
  ["dive", [...RUN, "dive", "straight", "straight"]],
  ["quarterpipe", [...RUN, "quarterpipe", "straight"]],
  ["banked turn", [...RUN, "bankin", "banked", "banked", "bankout"]],
  ["plain curve", [...RUN, "curve", "curve", "curve"]],
  ["wallride", [...RUN, "wallride", "straight"]],
  ["LOOP", [...RUN, "loop", "straight"]],
  ["LOOP twist (corkscrew)", [...RUN, "twist", "straight"]],
  ["LOOP half", [...RUN, "loop_half"]],
]) {
  const r = peakSwing(ids);
  swingBy[label] = r.swing;
  console.log(`  ${label.padEnd(22)} peak swing ${r.swing.toFixed(0).padStart(3)}°   ` +
    `(tightest radius ${r.radius > 9999 ? "  flat" : r.radius.toFixed(0).padStart(6) + " m"}, ` +
    `turned ${r.turned.toFixed(0).padStart(4)}°)`);
}
console.log("");
const worstNonLoop = Math.max(...Object.entries(swingBy)
  .filter(([k]) => !k.startsWith("LOOP")).map(([, v]) => v));
// The quarterpipe is the one partial case and it is a deliberate trade, not a
// leak: it genuinely turns 56° on a 23 m radius, more loop-like than anything
// else in the kit, and it comes out as a ~10° lean rather than a profile view.
// Excluding it entirely would need the turn gate above 56°, which would eat most
// of a loop_half — the piece where the effect matters most.
check(worstNonLoop < 15,
  `on the REAL kit the swing stays off for every non-loop piece: worst ${worstNonLoop.toFixed(0)}° across ` +
  `slopes,
         crests, jump ramps, dives, banked turns, plain curves and wallrides — the only
` +
  `         mover is the quarterpipe, a deliberate ~10° lean (< 15°)`);
// The corkscrew is grouped with the loops on purpose: its road really does roll
// all the way over, continuously, which is exactly the rule.
check(swingBy["LOOP"] > 40 && swingBy["LOOP half"] > 40 && swingBy["LOOP twist (corkscrew)"] > 40,
  `and comes right out on all three loop-class pieces: loop ${swingBy["LOOP"].toFixed(0)}°, ` +
  `half ${swingBy["LOOP half"].toFixed(0)}°, corkscrew ${swingBy["LOOP twist (corkscrew)"].toFixed(0)}° (> 40°)`);

console.log("\n═══ C. REAL PHYSICS — run-up, half loop, inverted exit, air roll, landing ═══\n");
const ring = driveRing();
for (const r of ring.sideRows.slice(-26)) console.log(r);
console.log("");
for (const r of ring.rows) console.log(r);
console.log(
  `\n  ndc.y over the whole run   ${ring.yMin.toFixed(2)} .. ${ring.yMax.toFixed(2)}` +
  `   (${ring.offScreen}/${ring.frames} frames off screen)`);
console.log(`  |ndc.x| worst              ${ring.xMax.toFixed(2)}`);
console.log(`  peak SIDE swing            ${ring.peakSide.toFixed(0)}° round the car`);
console.log(`  car's roll ON SCREEN       ${ring.peakCarRoll.toFixed(0)}° (180 = fully upside down to the viewer)`);
console.log(`  LINE OF SIGHT BLOCKED      ${ring.blocked}/${ring.losFrames} frames ` +
  `(${(ring.blocked / Math.max(1, ring.losFrames) * 100).toFixed(1)}% — road between the camera and the car)`);
console.log(`  camera->car distance       ${ring.dMin.toFixed(1)} .. ${ring.dMax.toFixed(1)} m`);
console.log(`  peak radial rate           ${ring.peakRadial.toFixed(1)} m/s in/out (a handover vaults)`);
console.log(`  peak framing rate          ${ring.peakFrameRate.toFixed(2)} ndc/s (a handover jumps) — ${ring.peakFrameAt}`);
console.log(`  air roll: car turned ${ring.bodyRoll.toFixed(0)}°, screen showed ` +
  `${ring.screenRoll.toFixed(0)}° (${(ring.screenRoll / Math.max(1, ring.bodyRoll) * 100).toFixed(0)}%)\n`);

// Rolling the other way. The rig levels itself out of the inverted exit, which
// is a ONE-OFF ~180° of view roll that adds to a roll one way and subtracts the
// other — so the two directions cannot be identical, but neither may swamp the
// trick. Both must show most of the roll, and the rig's own contribution must
// stay inside that single level-out.
const ringR = driveRing({ rollDir: 1 });
const fracL = ring.screenRoll / Math.max(1, ring.bodyRoll);
const fracR = ringR.screenRoll / Math.max(1, ringR.bodyRoll);
const rigL = Math.abs(ring.screenRoll - ring.bodyRoll);
const rigR = Math.abs(ringR.screenRoll - ringR.bodyRoll);

check(ring.blocked / Math.max(1, ring.losFrames) < 0.02,
  `THE CAMERA CAN SEE THE CAR: road blocks the view on ${ring.blocked}/${ring.losFrames} frames ` +
  `(< 2%).
         Measuring the framing is worthless if the shot is looking at the inside of the tube`);
check(ring.peakCarRoll > 150,
  `THE LOOP SHOT: the car visibly turns UPSIDE DOWN on screen — ${ring.peakCarRoll.toFixed(0)}° of ` +
  `on-screen roll
         through the loop (> 150°). Riding the road round instead keeps this near 0 ` +
  `and rotates the world`);
check(ring.offScreen === 0 && ringR.offScreen === 0,
  `car never leaves the frame through a loop + inverted exit + landing (${ring.offScreen + ringR.offScreen} bad frames)`);
check(ring.yMax - ring.yMin < 0.45,
  `framing stays put under real physics: ndc.y range ${(ring.yMax - ring.yMin).toFixed(2)} (< 0.45)`);
check(ring.dMin > 5.5,
  `chase distance never collapses onto the car: min ${ring.dMin.toFixed(1)} m (> 5.5)`);
check(ring.peakRadial < 6,
  `no vault: the camera never rushes in/out faster than ${ring.peakRadial.toFixed(1)} m/s (< 6)`);
check(ring.peakFrameRate < 3.0,
  `no framing snap: worst ${ring.peakFrameRate.toFixed(2)} ndc/s = ${(ring.peakFrameRate * FIXED_DT).toFixed(3)} of a half-frame in one step (< 3.0). A real handover
         moves the camera 2*height = 6.4 m in a couple of tenths, which is several ndc/s`);
check(fracL > 0.6 && fracR > 0.6,
  `the player's air roll is VISIBLE both ways: ${(fracL * 100).toFixed(0)}% / ${(fracR * 100).toFixed(0)}% reaches the screen (> 60%)`);
check(rigL < 250 && rigR < 250,
  `the rig adds no more than its one level-out: ${rigL.toFixed(0)}° / ${rigR.toFixed(0)}° of view roll (< 250°)`);

console.log(`\n${failed ? `FAIL — ${failed} check(s)` : "all checks green"}\n`);
process.exit(failed ? 1 : 0);
