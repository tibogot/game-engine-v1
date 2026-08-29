// Reported: the FIRST roll after leaving a tube sweeps a "big radius", as if the
// origin of the roll were not the car. Keep rolling and every roll after that
// looks normal.
//
// "Only the first one" is the tell. The car's physics cannot know which roll it
// is on — torque about the chassis forward axis is torque about the chassis
// forward axis, and rotation about the centre of mass has no radius to be big.
// Something that IS different on the first roll: the CHASE CAMERA is still
// unwinding its loop-follow blend from the tube.
//
//   _camLoop saturates toward 1 while the car is inverted and grounded (the tube)
//   on leaving, _loopAir counts up; the blend is HELD for loopAirHold (0.35 s)
//   and only then eases out at loopAirLerp (1.2/s) — about a second of transition
//   during which:
//       _camDesired.lerpVectors(_wDesired, _cDesired, _camLoop)
//   places the camera BETWEEN the world rig and the car-frame rig, and the arc
//   re-projection right below it deliberately SWINGS the camera around the car
//   rather than cutting across the chord.
//
// So for roughly the first second out of a tube the camera is orbiting the car
// while the car rolls. Composition of the two is a roll that appears to sweep a
// wide arc. By the second roll _camLoop is 0, the rig is static world-up, and
// the same physical roll looks like a clean spin in place.
//
// This runs the REAL chaseCamera.js headless against a scripted car, and
// measures what the player actually sees: how far the camera itself travels
// around the car, and how much of the on-screen rotation is the car versus the
// rig. No renderer, no GPU — the camera module is pure maths.
//
// An instrument, not a pass/fail test.
import * as THREE from "three";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const { createChaseCamera, CHASE_CAM } =
  await import(pathToFileURL(join(ROOT, "games/modular-road-v3/chaseCamera.js")).href);

const R2D = 57.2958;
const DT = 1 / 60;

console.log("=== SETUP ===");
console.log(`  loopStart ${CHASE_CAM.loopStart}  loopFull ${CHASE_CAM.loopFull}`
  + `  loopLerp ${CHASE_CAM.loopLerp}`);
console.log(`  loopAirHold ${CHASE_CAM.loopAirHold} s   loopAirLerp ${CHASE_CAM.loopAirLerp}/s`
  + `   upLerp ${CHASE_CAM.upLerp}`);
console.log(`  dist ${CHASE_CAM.dist}  height ${CHASE_CAM.height}  posLerp ${CHASE_CAM.posLerp}`);

/** A car we drive by hand: pose, velocity and contact are all scripted. */
function makeFakeCar() {
  return {
    body: {
      pos: new THREE.Vector3(),
      vel: new THREE.Vector3(),
      quat: new THREE.Quaternion(),
    },
    groundedCount: 4,
    get renderPos() { return this.body.pos; },
    get renderQuat() { return this.body.quat; },
  };
}

const _off = new THREE.Vector3();
const _prevOff = new THREE.Vector3();
const _carUp = new THREE.Vector3();
const _camFwd = new THREE.Vector3();
const _camRight = new THREE.Vector3();
const _screenUp = new THREE.Vector3();

/**
 * Run one exit and report, per frame, what the eye sees.
 *
 * `tubeSecs` is how long the car sits inverted-and-grounded first — that is what
 * charges _camLoop. Zero means "the same roll, but not out of a tube", which is
 * the control: identical physics, cold camera.
 */
function exitAndRoll({ tubeSecs = 1.2, rollRate = 3.6, secs = 2.2, label = "" }) {
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 2000);
  const car = makeFakeCar();
  const chase = createChaseCamera({
    camera, vehicle: car, orbit: null, isOrbit: () => false,
  });

  // ── Phase 1: inverted on the tube wall, grounded. Charges the loop blend. ──
  car.body.pos.set(0, 14, 0);
  car.body.vel.set(0, 0, 30);
  car.body.quat.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI); // inverted
  car.groundedCount = 4;
  for (let i = 0; i < tubeSecs / DT; i++) {
    car.body.pos.z += 30 * DT;
    chase.update(DT);
  }

  // ── Phase 2: airborne, rolling — the first roll out of the tube. ──
  car.groundedCount = 0;
  const rows = [];
  let camSweep = 0, carRoll = 0, screenRoll = 0;
  _prevOff.copy(camera.position).sub(car.body.pos).normalize();
  let prevScreen = null;

  const n = Math.round(secs / DT);
  for (let i = 0; i < n; i++) {
    // Ballistic, rolling about the chassis forward axis at a constant rate.
    car.body.vel.y -= 9.81 * DT;
    car.body.pos.addScaledVector(car.body.vel, DT);
    _camFwd.set(0, 0, 1).applyQuaternion(car.body.quat);
    const q = new THREE.Quaternion().setFromAxisAngle(_camFwd, rollRate * DT);
    car.body.quat.premultiply(q);
    carRoll += rollRate * DT;

    chase.update(DT);

    // How far the CAMERA moved around the car this frame (deg of arc).
    _off.copy(camera.position).sub(car.body.pos).normalize();
    const d = Math.acos(THREE.MathUtils.clamp(_off.dot(_prevOff), -1, 1));
    camSweep += d;
    _prevOff.copy(_off);

    // What the roll LOOKS like: the car's up-axis projected onto the screen
    // plane. This is the number the player's eye integrates.
    _carUp.set(0, 1, 0).applyQuaternion(car.body.quat);
    _camFwd.copy(car.body.pos).sub(camera.position).normalize();
    _camRight.crossVectors(_camFwd, camera.up).normalize();
    _screenUp.crossVectors(_camRight, _camFwd).normalize();
    const sx = _carUp.dot(_camRight);
    const sy = _carUp.dot(_screenUp);
    const ang = Math.atan2(sx, sy);
    if (prevScreen !== null) {
      let dd = ang - prevScreen;
      if (dd > Math.PI) dd -= 2 * Math.PI; else if (dd < -Math.PI) dd += 2 * Math.PI;
      screenRoll += dd;
    }
    prevScreen = ang;

    if (i % Math.round(0.15 / DT) === 0) {
      rows.push({
        t: i * DT,
        camDist: camera.position.distanceTo(car.body.pos),
        camUpY: camera.up.y,
        sweep: camSweep * R2D,
        carRoll: carRoll * R2D,
        screenRoll: screenRoll * R2D,
      });
    }
  }
  return {
    label,
    camSweepDeg: camSweep * R2D,
    carRollDeg: carRoll * R2D,
    screenRollDeg: screenRoll * R2D,
    rows,
  };
}

console.log("\n=== 1. FIRST ROLL OUT OF A TUBE vs THE SAME ROLL, COLD CAMERA ===");
console.log("  Identical car motion in both: same ballistic arc, same constant roll rate");
console.log("  about the chassis forward axis. The ONLY difference is whether the camera");
console.log("  arrives with the tube's loop-follow blend still wound up.\n");
console.log("  'camera sweep' is how far the camera itself travelled around the car.");
console.log("  On a clean roll it should be near zero — the rig just trails.\n");
console.log("   case                       car roll   camera sweep   on-screen roll");
for (const [label, tubeSecs] of [
  ["out of a tube (first roll)", 1.2],
  ["cold camera (control)", 0],
]) {
  const r = exitAndRoll({ tubeSecs, label });
  console.log(
    `   ${label.padEnd(26)}  ${r.carRollDeg.toFixed(0).padStart(7)}°`
    + `   ${r.camSweepDeg.toFixed(0).padStart(11)}°`
    + `   ${r.screenRollDeg.toFixed(0).padStart(13)}°`,
  );
}

console.log("\n=== 2. WHERE THE SWEEP HAPPENS (out of a tube) ===");
console.log("  If the extra motion is the blend unwinding, it is front-loaded and gone");
console.log("  by ~1 s — which is exactly 'only the first roll'.\n");
console.log("      t    cam dist   cam up.y   sweep so far   car roll   screen roll");
{
  const r = exitAndRoll({ tubeSecs: 1.2 });
  for (const s of r.rows) {
    console.log(
      `   ${s.t.toFixed(2).padStart(5)}   ${s.camDist.toFixed(2).padStart(7)} m`
      + `   ${s.camUpY.toFixed(2).padStart(7)}`
      + `   ${s.sweep.toFixed(0).padStart(11)}°`
      + `   ${s.carRoll.toFixed(0).padStart(7)}°`
      + `   ${s.screenRoll.toFixed(0).padStart(10)}°`,
    );
  }
}

console.log("\n=== 3. SECOND ROLL (blend already unwound) ===");
console.log("  Same car motion again, but starting from where the previous run ended —");
console.log("  i.e. the roll the player says looks fine.\n");
{
  const r = exitAndRoll({ tubeSecs: 1.2, secs: 4.4 });
  const half = Math.floor(r.rows.length / 2);
  const first = r.rows[half - 1], last = r.rows[r.rows.length - 1];
  const sweep2 = last.sweep - first.sweep;
  const roll2 = last.carRoll - first.carRoll;
  console.log(`   first half   car roll ${first.carRoll.toFixed(0).padStart(5)}°`
    + `   camera sweep ${first.sweep.toFixed(0).padStart(5)}°`);
  console.log(`   second half  car roll ${roll2.toFixed(0).padStart(5)}°`
    + `   camera sweep ${sweep2.toFixed(0).padStart(5)}°`);
  console.log(`\n   -> the camera does ${(first.sweep / Math.max(1, sweep2)).toFixed(1)}x`
    + ` more travelling during the first roll than the second.`);
}

console.log("\n=== 4. THE KNOB: loopAirLerp (how fast the blend lets go) ===");
console.log("  Higher = the rig returns to world-frame sooner after the wheels leave.\n");
console.log("   loopAirLerp   camera sweep   on-screen roll   (car roll is 454° in all)");
for (const rate of [1.2, 3, 6, 12]) {
  const saved = CHASE_CAM.loopAirLerp;
  CHASE_CAM.loopAirLerp = rate;
  const r = exitAndRoll({ tubeSecs: 1.2 });
  CHASE_CAM.loopAirLerp = saved;
  console.log(
    `   ${rate.toFixed(1).padStart(11)}   ${r.camSweepDeg.toFixed(0).padStart(11)}°`
    + `   ${r.screenRollDeg.toFixed(0).padStart(13)}°`
    + (rate === saved ? "   <= shipped" : ""),
  );
}

console.log("");
