// WHAT COUNTS AS A DRIFT — the gate that decides whether the tyres smoke at all.
//
// THE BUG: reversing in a dead straight line produced a bigger cloud than any
// real drift. The slip term was `acos(vel · fwd / |vel|)`, and that dot is −1
// when the car travels straight backwards — so `acos` returned 180°, the
// largest angle it can produce, and `driftAmount` pinned at 1. Measured in the
// game before the fix: 59 km/h in reverse read a 179.9° "drift angle" and 685
// live puffs, which is the pool full.
//
// A tyre rolls along its own plane in either direction and scrubs in neither.
// What makes smoke is how far the velocity lies OFF that plane — an angle to an
// AXIS, not to a direction — so the dot is taken absolute. Rolling forwards and
// rolling backwards are both 0°; sideways is 90°.
//
// The thing this must NOT do is stop a spin from smoking, so that is checked
// too: a car coming round passes through 90° at full intensity, and only stops
// once it is genuinely travelling straight backwards with the tyres rolling.
import { register } from "node:module";
register("./threeWebgpuHook.mjs", import.meta.url);

const THREE = await import("three");
const { ModularRoadDriftSmoke, DEFAULT_DRIFT_SMOKE_SETTINGS } =
  await import("../games/modular-road-v3/modularRoadDriftSmoke.js");

let fail = 0;
const check = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); if (!c) fail++; };

const DT = 1 / 60;

/**
 * A car whose heading and velocity can be set independently, so "pointing this
 * way, travelling that way" is expressible — which is the whole subject here.
 * @param {number} headingDeg  where the car POINTS (0 = +Z)
 * @param {number} courseDeg   where it TRAVELS (0 = +Z, 180 = straight back)
 */
function car(headingDeg, courseDeg, speed) {
  const quat = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(headingDeg));
  const course = THREE.MathUtils.degToRad(courseDeg);
  const vel = new THREE.Vector3(Math.sin(course), 0, Math.cos(course)).multiplyScalar(speed);
  const body = {
    pos: new THREE.Vector3(0, 0.5, 0),
    quat, vel,
    // Every contact travels with the body: no yaw rate, so the only slip is the
    // one the course/heading difference creates.
    getVelocityAtPoint: (_p, out) => out.copy(vel),
  };
  const tire = (x, z, canSteer) => ({
    canSteer, grounded: true, overDemand: 0,
    hitPoint: new THREE.Vector3(x, 0, z),
    hitNormal: new THREE.Vector3(0, 1, 0),
    worldPos: new THREE.Vector3(x, 0.3, z),
  });
  return {
    enabled: true, body, groundedCount: 4,
    input: { throttle: 0, handbrake: false },
    tires: [tire(-0.92, 1.4, true), tire(0.92, 1.4, true),
            tire(-0.92, -1.4, false), tire(0.92, -1.4, false)],
  };
}

/** Puffs emitted over `frames` of that state. */
function puffsOver(vehicle, frames = 30, tweak = {}) {
  const scene = new THREE.Scene();
  const settings = structuredClone(DEFAULT_DRIFT_SMOKE_SETTINGS);
  Object.assign(settings, tweak);
  // The engine's plume is a separate source and would only add noise here.
  settings.exhaust.enabled = false;
  const smoke = new ModularRoadDriftSmoke(scene, settings);
  const cam = new THREE.PerspectiveCamera();
  cam.position.set(0, 3, -10);
  let n = 0;
  const real = smoke.emitAt.bind(smoke);
  smoke.emitAt = (emitter, ...a) => { if (emitter === smoke.puffEmitter) n++; return real(emitter, ...a); };
  for (let i = 0; i < frames; i++) smoke.updateFromVehicle(vehicle, cam, DT, {});
  return n;
}

const SPEED = 16.5;   // 59 km/h, the speed the bug was measured at

console.log("=== ROLLING IS ROLLING, IN EITHER DIRECTION ===");
{
  const forwards = puffsOver(car(0, 0, SPEED));
  const backwards = puffsOver(car(0, 180, SPEED));
  check("driving straight ahead makes no smoke", forwards === 0, `${forwards} puffs`);
  check("REVERSING straight makes no smoke either", backwards === 0,
    `${backwards} puffs — this was the pool, full`);
  check("the two directions agree", forwards === backwards);

  // The same at a crawl and at a real speed, since the gate also has a speed term.
  check("nor at 20 km/h in reverse", puffsOver(car(0, 180, 5.6)) === 0);
  check("nor at 110 km/h in reverse", puffsOver(car(0, 180, 30)) === 0);
}

console.log("\n=== SIDEWAYS STILL SMOKES ===");
{
  const sideways = puffsOver(car(0, 90, SPEED));
  check("travelling at 90° to the nose is a full drift", sideways > 100,
    `${sideways} puffs`);
  // The trigger is 13°, so these straddle it.
  const gentle = puffsOver(car(0, 8, SPEED));
  const real = puffsOver(car(0, 25, SPEED));
  check("8° of slip is under the trigger — an ordinary corner stays clean",
    gentle === 0, `${gentle} puffs`);
  check("25° of slip is over it — the car is visibly sideways", real > 0,
    `${real} puffs`);
  check("...and further sideways makes more", sideways > real,
    `${sideways} vs ${real}`);
}

console.log("\n=== A SPIN IS NOT A REVERSE ===");
{
  // Coming round: 135° between nose and course is still a slide, because the
  // tyres are being dragged across their own plane at 45°.
  const midSpin = puffsOver(car(0, 135, SPEED));
  check("135° — halfway round — still smokes", midSpin > 0, `${midSpin} puffs`);
  check("...and 45° off the axis matches its mirror at 45°",
    Math.abs(midSpin - puffsOver(car(0, 45, SPEED))) <= 2,
    `${midSpin} vs ${puffsOver(car(0, 45, SPEED))}`);
  // Only once the car is genuinely travelling backwards does the slip term stop.
  const nearlyBack = puffsOver(car(0, 170, SPEED));
  check("170° is nearly straight back, so the slip term is nearly out",
    nearlyBack < midSpin, `${nearlyBack} vs ${midSpin}`);

  // And the handbrake is a separate term, so a reverse handbrake still locks up.
  const v = car(0, 180, SPEED);
  v.input.handbrake = true;
  check("the handbrake still smokes in reverse", puffsOver(v) > 0,
    `${puffsOver(v)} puffs`);
}

console.log("\n=== THE HEADING FRAME, NOT THE WORLD ===");
{
  // The measurement has to be relative to the car, so it cannot depend on which
  // way the car happens to be pointing in the world.
  const a = puffsOver(car(0, 40, SPEED));
  const b = puffsOver(car(140, 180, SPEED));   // same 40° of slip, rotated
  const c = puffsOver(car(-95, -55, SPEED));   // and again
  check("the same slip reads the same at any heading",
    Math.abs(a - b) <= 2 && Math.abs(a - c) <= 2, `${a} / ${b} / ${c}`);
}

console.log(fail ? `\n${fail} FAILED` : "\nall green");
process.exit(fail ? 1 : 0);
