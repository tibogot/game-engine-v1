// WHERE DOES THE CAR ACTUALLY SIT ON SCREEN?
//
// The chase rig was reported as "not aligned with the car — sometimes the camera
// is up, sometimes down; on a steep ramp you only see the tip of the car; when
// upside down the camera is below and the car above; on flat road it's centred
// and it should ALWAYS look centred".
//
// Every one of those is the same measurement — the car's SCREEN POSITION — so
// this measures that directly instead of reasoning about the rig.
//
//     ndc.y = 0   car dead centre
//     ndc.y = -1  car on the BOTTOM edge of the frame
//     |ndc.y| > 1 car OFF SCREEN            <- "I only see the tip of the car"
//
// Measured on the two-frame rig this replaced: flat road −0.41, steep ramp +0.12,
// vertical wall +0.38, a −60° descent −1.22 (off the bottom of the screen) and
// inverted +0.41 with the camera 3.2 m BELOW the car. A spread of 53° of framing
// from nothing but attitude.
//
// The rig now builds the camera position AND the aim point from one shared frame,
// which makes the car's off-axis angle a constant of the four framing numbers —
// so the bar here is not "close enough", it is "identical at every attitude".
//
// PART A is static attitudes: pure geometry, no physics, so a framing bug cannot
// hide behind a transient. PART B is speed and framerate. PART C drives the real
// Vehicle through a real loop piece, off the top inverted, through an air roll
// and into a landing, because that is where a transient WOULD show up.
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
 * Car centre in normalised device coords, plus its on-screen roll.
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
  const ndc = pos.clone().project(camera);
  // Screen-space direction of the car's up-axis: project a point 1 m above the
  // car and compare. Aspect-corrected, so the angle is a real screen angle.
  const tip = pos.clone()
    .addScaledVector(new THREE.Vector3(0, 1, 0).applyQuaternion(quat), 1)
    .project(camera);
  const dx = (tip.x - ndc.x) * camera.aspect;
  const dy = tip.y - ndc.y;
  // THE CAMERA'S OWN ROLL — the axis that causes motion sickness. In a roll-free
  // frame the camera's right vector is exactly horizontal, so its tilt out of the
  // world's horizontal plane IS the roll. Measured on the camera, not on what it
  // is looking at, so a rolling road cannot disguise a rolling camera.
  const camRight = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
  return {
    x: ndc.x,
    y: ndc.y,
    ang,
    roll: Math.atan2(dx, dy) * R2D,
    camRoll: Math.asin(THREE.MathUtils.clamp(camRight.y, -1, 1)) * R2D,
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
  // NEGATED so the labels are honest: rotating +Z about +X by a positive angle
  // gives (0, −sin a, cos a), i.e. nose DOWN. Without this every row in the
  // table below is named as the opposite of the attitude it actually tests.
  const q = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(-pitch / R2D, 0, roll / R2D, "YXZ"));
  vehicle.body.quat.copy(q);
  vehicle.groundedCount = grounded ? 4 : 0;
  // Travel along the car's own forward — i.e. up the ramp, round the loop.
  vehicle.body.vel.set(0, 0, 1).applyQuaternion(q).multiplyScalar(speed);
}

/** Hold a pose for `SETTLE` s (advancing the car along its velocity), then read. */
function holdPose(label, pose, out, dt = DT) {
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 5000);
  const vehicle = makeStubCar();
  const chase = createChaseCamera({ camera, vehicle });
  poseCar(vehicle, pose);
  chase.reset();
  for (let t = 0; t < SETTLE; t += dt) {
    vehicle.body.pos.addScaledVector(vehicle.body.vel, dt);
    chase.update(dt);
  }
  const m = measure(camera, vehicle.body.pos, vehicle.body.quat);
  console.log(
    `  ${label.padEnd(26)} ndc.y ${m.y.toFixed(2).padStart(6)}  ` +
    `off-axis ${m.ang.toFixed(1).padStart(6)}°  ` +
    `CAM ROLL ${m.camRoll.toFixed(1).padStart(5)}°  car roll ${m.roll.toFixed(0).padStart(4)}°  ` +
    `dist ${m.dist.toFixed(1).padStart(5)} m${Math.abs(m.y) > 1 ? "  <-- OFF SCREEN" : ""}`);
  out.push(m);
  return chase;
}

console.log("\n═══ A. STATIC ATTITUDES (grounded, 25 m/s along the car's forward) ═══");
console.log("  ndc.y    : 0 = centred, -1 = bottom edge, |y|>1 = off screen");
console.log("  CAM ROLL : tilt of the camera's own horizon — the nausea axis, must be 0");
console.log("  car roll : on-screen angle of the car's up-axis — SHOULD track the road\n");
const statics = [];
let lastChase = null;
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
]) lastChase = holdPose(label, pose, statics);

const ys = statics.map((m) => m.y);
const angs = statics.map((m) => m.ang);
const spread = Math.max(...angs) - Math.min(...angs);
const maxRoll = Math.max(...statics.map((m) => Math.abs(m.roll)));
const dists = statics.map((m) => m.dist);
// The rig can state where the car BELONGS from the four framing constants alone.
// Checking the measurement against that prediction is what proves the framing is
// geometry rather than a coincidence that happens to hold for these 14 poses.
const predicted = lastChase.state.framingDeg;
console.log("");
check(spread < 0.5,
  `framing is attitude-INVARIANT: the car sits ${angs[0].toFixed(1)}° off the view axis at every one of ` +
  `14 attitudes (spread ${spread.toFixed(2)}° < 0.5°)`);
check(Math.abs(angs[0] - predicted) < 0.5,
  `and it sits where the RIG SAYS it must: ${predicted.toFixed(1)}° is just \`carBelowCentre\`, the one
         number that can move the car on screen — measured ${angs[0].toFixed(1)}°. dist/height change ` +
  `where you
         watch FROM, and provably not where the car lands`);
check(Math.max(...statics.map((m) => Math.abs(m.x))) < 1e-6,
  `and dead on the vertical centre line: worst |ndc.x| ` +
  `${Math.max(...statics.map((m) => Math.abs(m.x))).toExponential(1)}`);
check(Math.max(...ys.map(Math.abs)) < 0.9,
  `car always comfortably in frame: worst |ndc.y| ${Math.max(...ys.map(Math.abs)).toFixed(2)} (< 0.9)`);
const maxCamRoll = Math.max(...statics.map((m) => Math.abs(m.camRoll)));
check(maxCamRoll < 0.01,
  `THE CAMERA NEVER ROLLS: worst horizon tilt ${maxCamRoll.toFixed(4)}° across all 14 attitudes (< 0.01°).
         Roll about the view axis is the motion that causes sickness, and a frame that follows the
         road's normal rolls hard in a tube. Here \`up\` is derived from yaw+pitch, so it cannot`);
// The flip side of a level camera: the ROAD is what turns over on screen. Banking
// 30° must read as 30°, and inverted must read as inverted — if the car also sat
// upright in frame, nothing on screen would tell you that you are upside down.
const banked = statics[8], inverted = statics[11];
check(Math.abs(Math.abs(banked.roll) - 30) < 2 && Math.abs(Math.abs(inverted.roll) - 180) < 2,
  `and the CAR is what rolls instead: banked 30° reads ${Math.abs(banked.roll).toFixed(0)}° on screen, ` +
  `inverted reads ${Math.abs(inverted.roll).toFixed(0)}°`);
check(Math.max(...dists) - Math.min(...dists) < 0.3,
  `chase distance holds: ${Math.min(...dists).toFixed(1)}..${Math.max(...dists).toFixed(1)} m (spread < 0.3)`);

// ═══ PART B — SPEED AND FRAMERATE ═══════════════════════════════════════════
// An exponential follow lags a moving target, so without compensation the chase
// distance grows with speed — the car shrinks into the distance exactly when you
// most need to see it. The frame rates are here because the lag term is a
// property of the DISCRETE filter: get it wrong and the chase distance quietly
// depends on how fast the machine renders.
console.log("\n═══ B. SPEED AND FRAMERATE — framing and distance must not drift ═══\n");
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

// ═══ PART C — REAL PHYSICS: LOOP, INVERTED EXIT, AIR ROLL, LANDING ══════════

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

const mkBvh = (gs) => {
  if (!gs.length) return null;
  const b = new RoadBvh();
  b.bakeFromMeshes(gs.map((geo) => {
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial());
    m.updateMatrixWorld(true);
    return m;
  }));
  return b.baked ? b : null;
};

/**
 * Run-up → half loop → off the top inverted → floor. The floor matters: without
 * a landing pad the car never touches down, and touchdown is exactly where a
 * transient would spike.
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
  return { deck: mkBvh(deck), solids: mkBvh(rails) };
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
function driveRing({ v0 = 45, secs = 12, rollDir = -1 } = {}) {
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
  chase.reset();

  const fwd = new THREE.Vector3();
  let airborne = false, tAir = 0, landT = null;
  let aMin = Infinity, aMax = -Infinity, xMax = 0;
  let yMin = Infinity, yMax = -Infinity;
  let dMin = Infinity, dMax = 0;
  // SNAP DETECTORS. Raw camera speed relative to the car is NOT one: through a
  // loop the rig legitimately carries the camera round the car on an 8 m arc,
  // which is 24 m/s of "relative speed" with nothing wrong at all. What a real
  // discontinuity does is move the camera IN or OUT (radial) and shift the car
  // ON SCREEN — so measure those two rates instead.
  let prevDist = null, prevAng = null, peakRadial = 0, peakFrameRate = 0, peakFrameAt = "";
  let loopRows = [], peakCarRoll = 0;
  // CAN THE CAMERA ACTUALLY SEE THE CAR? Everything else here measures where the
  // car would land on screen ASSUMING it is visible. A camera buried in the
  // loop's own tube frames the car perfectly and shows you tarmac.
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
      aMin = Math.min(aMin, m.ang); aMax = Math.max(aMax, m.ang);
      yMin = Math.min(yMin, m.y); yMax = Math.max(yMax, m.y);
      xMax = Math.max(xMax, Math.abs(m.x));
      dMin = Math.min(dMin, m.dist); dMax = Math.max(dMax, m.dist);
      if (Math.abs(m.y) > 1) offScreen++;
      // How far over the car appears to go ON SCREEN while it is on the road. The
      // frame rides the road round the loop, so this should stay near zero and the
      // world should be what rotates.
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
        loopRows.push(`    loop t=${(i * FIXED_DT).toFixed(2)}s  carUp.y ${cu.y.toFixed(2).padStart(5)}` +
          `  camAbove ${m.camAboveCar.toFixed(1).padStart(5)} m` +
          `  CAR ON SCREEN: roll ${m.roll.toFixed(0).padStart(4)}°  off-axis ${m.ang.toFixed(1).padStart(6)}°`);
      }
      if (prevDist !== null) {
        peakRadial = Math.max(peakRadial, Math.abs(m.dist - prevDist) / FIXED_DT);
        const fr = Math.abs(m.ang - prevAng) / FIXED_DT;
        if (fr > peakFrameRate) {
          peakFrameRate = fr;
          peakFrameAt = `t=${(i * FIXED_DT).toFixed(2)}s ` +
            (landT !== null ? "after landing" : airborne ? "in flight" : "on the ground");
        }
      }
      prevDist = m.dist; prevAng = m.ang;
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
          rows.push(`    air ${tAir.toFixed(2).padStart(5)}s   off-axis ${m.ang.toFixed(1).padStart(6)}°` +
            `   dist ${m.dist.toFixed(1).padStart(4)} m   car rolled ${bodyRoll.toFixed(0).padStart(4)}°` +
            `   shown ${screenRoll.toFixed(0).padStart(4)}°`);
        }
      } else if (tAir > 0 && landT !== null && i % 10 === 0 && rows.length < 40) {
        rows.push(`    land+${(tAir).toFixed(2)}s  off-axis ${m.ang.toFixed(1).padStart(6)}°   dist ${m.dist.toFixed(1).padStart(4)} m`);
      }
      if (landT !== null) { tAir += FIXED_DT; if (tAir > landT + 1.5) break; }
    }
  }
  return { blocked, losFrames, peakCarRoll, loopRows, aMin, aMax, yMin, yMax, xMax,
    dMin, dMax, peakRadial, peakFrameRate, peakFrameAt, offScreen, frames,
    bodyRoll, screenRoll, rows };
}

console.log("\n═══ C. REAL PHYSICS — run-up, half loop, inverted exit, air roll, landing ═══\n");
const ring = driveRing();
for (const r of ring.loopRows.slice(-22)) console.log(r);
console.log("");
for (const r of ring.rows) console.log(r);
console.log(
  `\n  off-axis over the whole run  ${ring.aMin.toFixed(1)}° .. ${ring.aMax.toFixed(1)}°` +
  `   (static value ${predicted.toFixed(1)}°)`);
console.log(`  ndc.y over the whole run     ${ring.yMin.toFixed(2)} .. ${ring.yMax.toFixed(2)}` +
  `   (${ring.offScreen}/${ring.frames} frames off screen)`);
console.log(`  |ndc.x| worst                ${ring.xMax.toFixed(2)}`);
console.log(`  car's roll ON SCREEN, on road ${ring.peakCarRoll.toFixed(0)}° (180 = fully inverted to the viewer)`);
console.log(`  LINE OF SIGHT BLOCKED        ${ring.blocked}/${ring.losFrames} frames ` +
  `(${(ring.blocked / Math.max(1, ring.losFrames) * 100).toFixed(1)}% — road between the camera and the car)`);
console.log(`  camera->car distance         ${ring.dMin.toFixed(1)} .. ${ring.dMax.toFixed(1)} m`);
console.log(`  peak radial rate             ${ring.peakRadial.toFixed(1)} m/s in/out (a handover vaults)`);
console.log(`  peak framing rate            ${ring.peakFrameRate.toFixed(1)} °/s — ${ring.peakFrameAt}`);
console.log(`  air roll: car turned ${ring.bodyRoll.toFixed(0)}°, screen showed ` +
  `${ring.screenRoll.toFixed(0)}° (${(ring.screenRoll / Math.max(1, ring.bodyRoll) * 100).toFixed(0)}%)\n`);

// Rolling the other way. The rig levels itself out of the inverted exit, which is
// a ONE-OFF ~180° of view roll that adds to a roll one way and subtracts the
// other — so the two directions cannot be identical, but neither may swamp the
// trick.
const ringR = driveRing({ rollDir: 1 });
const fracL = ring.screenRoll / Math.max(1, ring.bodyRoll);
const fracR = ringR.screenRoll / Math.max(1, ringR.bodyRoll);

check(ring.blocked / Math.max(1, ring.losFrames) < 0.02,
  `THE CAMERA CAN SEE THE CAR: road blocks the view on ${ring.blocked}/${ring.losFrames} frames ` +
  `(< 2%).
         Measuring the framing is worthless if the shot is looking at the inside of the tube`);
check(ring.offScreen === 0 && ringR.offScreen === 0,
  `car never leaves the frame through a loop + inverted exit + landing (${ring.offScreen + ringR.offScreen} bad frames)`);
check(ring.aMax - ring.aMin < 0.5,
  `framing holds under REAL PHYSICS too, not just held poses: off-axis range ` +
  `${(ring.aMax - ring.aMin).toFixed(2)}° (< 0.5°)
         across a run-up, a loop, an inverted exit, ${ring.bodyRoll.toFixed(0)}° of air roll and a landing`);
check(ring.peakCarRoll > 150,
  `the car visibly turns UPSIDE DOWN on screen through the loop: ${ring.peakCarRoll.toFixed(0)}° of on-screen
         roll (> 150°) against a camera horizon that never moves — the car rotates, the view does not`);
check(ring.dMin > 5.5,
  `chase distance never collapses onto the car: min ${ring.dMin.toFixed(1)} m (> 5.5)`);
// These two caught a real bug and are kept tight because of it. Feeding the
// velocity forward to cancel follow lag — the obvious fix, and what the previous
// rig did — puts a position offset proportional to `vel` in the rig, so the
// impulse that arrests a landing TELEPORTS the camera: measured 2.06 m in one
// step (248 m/s radial) at the touchdown frame, with the car's own position
// perfectly continuous. Carrying the car's displacement instead cannot do that.
check(ring.peakRadial < 0.5,
  `no vault: the camera holds its radius to ${ring.peakRadial.toFixed(2)} m/s of in/out (< 0.5)`);
check(ring.peakFrameRate < 5,
  `no framing snap: worst ${ring.peakFrameRate.toFixed(2)} °/s = ` +
  `${(ring.peakFrameRate * FIXED_DT).toFixed(3)}° in one step (< 5 °/s)`);
check(fracL > 0.6 && fracR > 0.6,
  `the player's air roll is VISIBLE both ways: ${(fracL * 100).toFixed(0)}% / ${(fracR * 100).toFixed(0)}% reaches the screen (> 60%).
         The frame levels to world up in flight instead of following the car, so the roll is the car's`);

// ═══ PART D — THE TUBE. The piece that started this. ════════════════════════
//
// A corkscrew / tube rolls the ROAD about the travel axis while the travel axis
// itself barely moves. A frame built on the road's normal therefore rolls about
// the VIEW axis — the one camera motion the inner ear cannot reconcile with
// sitting still, and the reason the road-following frame was reported as "the
// camera rotates and it's really giving a headache". So drive the real pieces
// and measure the camera's own horizon, not the car's.
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
  return { deck: mkBvh(deck), solids: mkBvh(rails) };
}

/** Drive a piece run and return the worst camera-horizon tilt and framing spread. */
function drivePieces(ids, { v0 = 40, secs = 7 } = {}) {
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
  let camRoll = 0, carRoll = 0, aMin = Infinity, aMax = -Infinity, off = 0;
  // HOW FAST THE WHOLE VIEW TURNS. This is the metric a chase camera lives or
  // dies by and it is invisible to every other column here: the car can be pinned
  // dead centre, the horizon dead level, and the shot still be unwatchable
  // because the world whips around behind it. Every failed attempt in this file's
  // history showed up here first — 636°/s, 1184°/s, 20099°/s in a single step.
  // IS IT SMOOTH? Rate does not answer that — a fast but steady sweep reads as
  // smooth and a small twitch reads as brutal, so the quantity that matters is
  // the rate's rate of change. It is also the only column here that noticed the
  // rig was harsh at all: framing, horizon, distance and astern were already
  // perfect when the camera was still snapping at 200 g.
  let turn = 0, turnAcc = 0, prevTurn = 0, prevQ = null;
  // IS THE CAMERA BEHIND THE CAR? Boom direction dotted with the car's FORWARD
  // AXIS: negative = astern (you see the tail), positive = the camera has got in
  // front and you are looking at the nose. Suppressing the loop's azimuth flip did
  // exactly that over the top, and no other column here notices — the car is still
  // pinned dead centre and the horizon still dead level while you stare at the
  // wrong end of it.
  //
  // Against the car's AXIS, not its velocity, and the difference is not academic:
  // coming back down a quarterpipe the car slides backwards, so the rig correctly
  // trails its FACING (the `reversing` branch) and a velocity-based test calls
  // that a failure. "Show the back of the car" is about the car's tail.
  //
  // GROUNDED ONLY. Airborne the car's attitude is trick input and the rig
  // deliberately stops chasing it — a boom that followed an air roll would swing
  // the camera bodily around the car. So "astern of a tumbling car" is not a
  // property this rig has, or should have; off a quarterpipe lip the car flies and
  // spins and the camera rightly holds its own line.
  let facing = -1, facingAir = -1;
  // Line of sight, and whether the camera is buried in the road it is swinging
  // past. Both matter for the sideways swing specifically.
  let blocked = 0, los = 0;
  const _bd = new THREE.Vector3(), _tv = new THREE.Vector3();
  for (let i = 0; i < Math.round(secs / FIXED_DT); i++) {
    car.tick({ steerTarget: 0, throttle: 1, handbrake: false, yaw: 0, pitch: 0 });
    car.syncVisuals(FIXED_DT, 1);
    chase.update(FIXED_DT);
    camera.updateMatrixWorld(true);
    if (i <= 30) { prevQ = camera.quaternion.clone(); continue; }
    const m = measure(camera, car.body.pos, car.body.quat);
    _tv.set(0, 0, 1).applyQuaternion(car.body.quat);
    _bd.copy(camera.position).sub(car.body.pos).normalize();
    if (car.groundedCount > 0) facing = Math.max(facing, _bd.dot(_tv));
    else facingAir = Math.max(facingAir, _bd.dot(_tv));
    _bd.copy(car.body.pos).sub(camera.position);
    const dl = _bd.length();
    if (dl > 1e-3) {
      _bd.multiplyScalar(1 / dl);
      los++;
      if (track.deck.raycastFirst(camera.position, _bd, dl - 1.5)) blocked++;
    }
    camRoll = Math.max(camRoll, Math.abs(m.camRoll));
    carRoll = Math.max(carRoll, Math.abs(m.roll));
    aMin = Math.min(aMin, m.ang); aMax = Math.max(aMax, m.ang);
    if (Math.abs(m.y) > 1) off++;
    const rate = 2 * Math.acos(
      Math.min(1, Math.abs(prevQ.dot(camera.quaternion)))) * R2D / FIXED_DT;
    turn = Math.max(turn, rate);
    turnAcc = Math.max(turnAcc, Math.abs(rate - prevTurn) / FIXED_DT);
    prevTurn = rate;
    prevQ.copy(camera.quaternion);
  }
  return { camRoll, carRoll, spread: aMax - aMin, off, turn, turnAcc, facing, facingAir, blocked, los };
}

// ── D1. SCRIPTED MANOEUVRES ─────────────────────────────────────────────────
// CORNERS CANNOT BE TESTED BY DRIVING THEM WITH ZERO STEERING — the car simply
// leaves the road and everything after that is crash noise. Driving the banked
// pieces that way measured 48° of camera roll with the car reading 95° on
// screen, i.e. lying on its side in a ditch. So the two cases that matter most
// here — a BANKED CORNER (must not roll the camera) and a CORKSCREW (the piece
// that started all this) — are scripted kinematically instead. No physics, no
// track, exact motion, and the camera roll is then unambiguous.
function scripted(label, step, { secs = 3, speed = 35 } = {}) {
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 5000);
  const vehicle = makeStubCar();
  const chase = createChaseCamera({ camera, vehicle });
  chase.reset();
  let camRoll = 0, carRoll = 0, aMin = Infinity, aMax = -Infinity, xMax = 0;
  for (let i = 0, t = 0; t < secs; i++, t += DT) {
    step(vehicle.body.quat, t, speed);
    vehicle.body.vel.set(0, 0, 1).applyQuaternion(vehicle.body.quat).multiplyScalar(speed);
    vehicle.body.pos.addScaledVector(vehicle.body.vel, DT);
    chase.update(DT);
    if (t < 0.6) continue; // let the rig seat itself
    const m = measure(camera, vehicle.body.pos, vehicle.body.quat);
    camRoll = Math.max(camRoll, Math.abs(m.camRoll));
    carRoll = Math.max(carRoll, Math.abs(m.roll));
    xMax = Math.max(xMax, Math.abs(m.x));
    aMin = Math.min(aMin, m.ang); aMax = Math.max(aMax, m.ang);
  }
  console.log(`  ${label.padEnd(28)} CAMERA horizon ${camRoll.toFixed(2).padStart(6)}°   ` +
    `car on screen ${carRoll.toFixed(0).padStart(4)}°   ` +
    `framing ${(aMax - aMin).toFixed(2).padStart(4)}°  |ndc.x| ${xMax.toFixed(3)}`);
  return { camRoll, carRoll, spread: aMax - aMin };
}
const yawQ = (a) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), a);
const pitchQ = (a) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), a);
const rollQ = (a) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), a);

console.log("\n═══ D1. SCRIPTED MANOEUVRES — exact motion, unambiguous roll ═══\n");
const sc = {};
sc.straight = scripted("flat straight", (q) => q.identity());
sc.corner = scripted("flat corner, R 30 m", (q, t, v) => q.copy(yawQ(v / 30 * t)));
sc.banked = scripted("BANKED corner, R 30 m, 30deg",
  (q, t, v) => q.copy(yawQ(v / 30 * t)).multiply(rollQ(30 / R2D)));
sc.hardBank = scripted("BANKED corner, R 20 m, 45deg",
  (q, t, v) => q.copy(yawQ(v / 20 * t)).multiply(rollQ(45 / R2D)));
sc.corkscrew = scripted("CORKSCREW — road rolls 360deg",
  (q, t) => q.copy(rollQ(Math.min(1, t / 1.6) * 2 * Math.PI)));
sc.loop = scripted("LOOP, R 15 m", (q, t, v) => q.copy(pitchQ(-v / 15 * t)), { secs: 3.5 });
console.log("");
const worstFlatCam = Math.max(sc.straight.camRoll, sc.corner.camRoll,
  sc.banked.camRoll, sc.hardBank.camRoll, sc.corkscrew.camRoll);
check(worstFlatCam < 0.01,
  `THE HEADACHE IS GONE: the horizon does not tilt on a corner, on a 45° BANKED corner, or through a
         full 360° CORKSCREW — worst ${worstFlatCam.toFixed(4)}° (< 0.01°). The corkscrew is the piece that
         was reported: the road rolls right over and the camera does not follow it`);
check(sc.corkscrew.carRoll > 150 && sc.hardBank.carRoll > 35,
  `and the ROAD is what rolls on screen instead: ${sc.corkscrew.carRoll.toFixed(0)}° through the corkscrew, ` +
  `${sc.hardBank.carRoll.toFixed(0)}° on the 45° bank.
         (The bank reads a few degrees under its true 45°, and should: the boom's smoothing leaves the
         camera slightly off the car's centreline mid-corner, so the bank is seen a little obliquely.)`);
check(sc.loop.camRoll < 0.01,
  `and a LOOP does not move it either: ${sc.loop.camRoll.toFixed(4)}°. It is the case that USED to be
         unfixable — a road-following boom sweeps through vertical, where "level" reverses rather than
         merely vanishing — and poleGuard is what makes the answer always exist`);

console.log("\n═══ D2. REAL KIT PIECES, DRIVEN ═══\n");
const RUN = ["straight", "straight", "straight", "straight", "straight", "straight"];
const pieces = {};
for (const [label, ids] of [
  ["flat straights", RUN],
  ["quarterpipe", [...RUN, "quarterpipe", "straight"]],
  ["jump ramp", [...RUN, "jump", "straight", "straight"]],
  ["LOOP", [...RUN, "loop", "straight"]],
  ["LOOP half", [...RUN, "loop_half"]],
  ["TWIST (corkscrew)", [...RUN, "twist", "straight"]],
]) {
  const r = drivePieces(ids);
  pieces[label] = r;
  console.log(`  ${label.padEnd(20)} horizon ${r.camRoll.toFixed(2).padStart(5)}°  ` +
    `car ${r.carRoll.toFixed(0).padStart(4)}°  framing ${r.spread.toFixed(2).padStart(4)}°  ` +
    `turn ${r.turn.toFixed(0).padStart(4)}°/s  jolt ${r.turnAcc.toFixed(0).padStart(5)}°/s²  ` +
    `astern ${r.facing < 0 ? "yes" : "NO "}(${r.facing.toFixed(2).padStart(5)}, air ${r.facingAir.toFixed(2)})  ` +
    `blocked ${r.blocked}/${r.los}${r.off ? `  ${r.off} OFF SCREEN` : ""}`);
}
console.log("");
const worstCam = Math.max(...Object.values(pieces).map((r) => r.camRoll));
const worstSpread = Math.max(...Object.values(pieces).map((r) => r.spread));
const totalOff = Object.values(pieces).reduce((s, r) => s + r.off, 0);
check(worstCam < 0.01,
  `on the REAL KIT the horizon is dead level on every piece too: worst ${worstCam.toFixed(4)}° (< 0.01°)`);
check(pieces["TWIST (corkscrew)"].carRoll > 90 && pieces["LOOP"].carRoll > 90,
  `and you can still SEE that you are inverted, because the car rolls instead: ` +
  `${pieces["TWIST (corkscrew)"].carRoll.toFixed(0)}° on the corkscrew,
         ${pieces["LOOP"].carRoll.toFixed(0)}° in the loop (> 90°)`);
check(worstSpread < 0.5 && totalOff === 0,
  `and the framing never moved to buy any of it: worst spread ${worstSpread.toFixed(2)}° over all runs, ` +
  `${totalOff} frames off screen`);
// SHOW THE BACK OF THE CAR. A loop reverses the travel heading, so the camera's
// azimuth has to travel 180°; suppressing that flip kept the shot stable but put
// the camera in FRONT over the top, looking at the nose. The sideways swing gets
// the azimuth round through 90° instead, so the camera stays astern the whole way.
const worstFacing = Math.max(...Object.values(pieces).map((r) => r.facing));
check(worstFacing < 0,
  `THE CAMERA STAYS BEHIND THE CAR on every piece, loops included: worst boom·forward ` +
  `${worstFacing.toFixed(2)} (negative = astern).
         It gets round a loop's 180° of heading reversal by swinging out to the SIDE — which is also
         what stops the boom passing through the pole. The tight case is the quarterpipe launch,
         where the boom's smoothing lag briefly puts the camera abeam; that is what caps
         \`boomSmoothTime\` at 0.28 (at 0.40 it goes to +0.10, i.e. in front)`);
const totalBlocked = Object.values(pieces).reduce((s, r) => s + r.blocked, 0);
const totalLos = Object.values(pieces).reduce((s, r) => s + r.los, 0);
check(totalBlocked === 0,
  `and it never swings INTO the road doing it: ${totalBlocked}/${totalLos} frames with tarmac between
         the camera and the car`);
// The one every earlier attempt failed. A pinned car and a level horizon are
// worth nothing if the world whips around behind them.
const worstTurn = Math.max(...Object.values(pieces).map((r) => r.turn));
// SMOOTHNESS. The rig reached this point with framing, horizon, distance and
// astern all perfect and still read as "a bit too brutal" — because none of those
// look at ACCELERATION. A first-order ease plus a hard rate cap was snapping at
// 21655°/s² through a loop and 20991°/s² on a quarterpipe (roughly 200 g of camera
// acceleration); the critically-damped spring brought those to 754 and 3223. For
// scale, the CAR's own chassis hits 5320–23695°/s² on the same pieces, so the shot
// is now several times smoother than the thing it is following.
const worstJolt = Math.max(...Object.values(pieces).map((r) => r.turnAcc));
check(worstJolt < 1200,
  `AND IT IS SMOOTH: worst view acceleration ${worstJolt.toFixed(0)}°/s² over every piece (< 1200).
         Rate alone cannot see this — a fast steady sweep reads as smooth, a small twitch reads as
         brutal — so it is the second derivative that has to be bounded, not the first`);
check(worstTurn < 300,
  `AND THE VIEW NEVER WHIPS: worst ${worstTurn.toFixed(0)}°/s over every piece (< 300°/s, the rig's own
         \`boomMaxRate\` backstop is 260). Earlier rigs hit 636, 1184 and 20099°/s here — the last of
         those a single-step snap, from the boom's interpolation path crossing straight over the pole`);

console.log(`\n${failed ? `FAIL — ${failed} check(s)` : "all checks green"}\n`);
process.exit(failed ? 1 : 0);
