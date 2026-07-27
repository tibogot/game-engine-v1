// Two things spotted with the new debug camera:
//
//   (1) "the front wheels go INSIDE the chassis on some obstacles"
//   (2) "at speed I don't see the front wheels TURN, but I do see them
//        counter-turning for the drift"
//
// Both are visual-layer questions, so both are measured against the same numbers
// the renderer uses.
//
// GEOMETRY, for reference (all chassis-local metres):
//     hub y            −0.10        WHEEL_LOCAL
//     wheel radius      0.36        WHEEL.radius
//     chassis box       ±0.30       CHASSIS.height / 2
//     rest length       0.55        TIRE.restLength
//     droop clamp       0.22        TIRE.maxDroop   <- there is a limit DOWN…
//                                                      …and none UP.
// The renderer places the wheel at  hub − suspExt·up, where
//     suspExt = clamp(hitDistance − radius, 0, maxDroop)
// The lower clamp is 0, i.e. the wheel is allowed to travel all the way up to
// the HUB. Settled, suspExt is ~0.14 m, so a hard hit lifts the wheel 0.14 m
// into an arch that the GLB was fitted to at the settled position.
//
// An instrument, not a pass/fail test.
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = join(ROOT, `.wheelvis.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, TIRE, WHEEL, CHASSIS, WHEEL_LOCAL, DRIFT, FIXED_DT } =
  await import(pathToFileURL(TMP).href);
unlinkSync(TMP);
const R2D = 57.2958;

/** Flat ground, optionally with a step of height `h` at z >= `at`. */
const makeGround = (h = 0, at = Infinity) => ({
  baked: true,
  raycastFirst(o, d, far) {
    if (d.y >= -1e-6) return null;
    const surf = o.z >= at ? h : 0;
    const t = (o.y - surf) / -d.y;
    if (t < 0 || t > far) return null;
    return { point: { x: o.x, y: surf, z: o.z }, distance: t, faceIndex: 0, normal: { x: 0, y: 1, z: 0 } };
  },
  spherecast() { return null; },
  closestPointWithNormal() { return null; },
});
Vehicle.prototype._buildMeshes = function () {
  this.group = new THREE.Group(); this.chassisMesh = new THREE.Object3D();
  this.tireGroups = [0, 0, 0, 0].map(() => new THREE.Group());
  this.arrowGroup = new THREE.Group(); this.arrowGroup.visible = false;
  this.arrows = [0, 0, 0, 0].map(() => ({})); this.wheelSpin = [0, 0, 0, 0];
  this.headlights = []; this.headlightTargets = []; this.headlamps = []; this.taillights = [];
  this._wheelInstances = []; this._wheelParts = [];
};
Vehicle.prototype._updateTaillights = function () {};

const make = (ground, y = 1.2) => {
  const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  c.groundBvh = ground; c.enabled = true;
  c.body.pos.set(0, y, 0); c.body.quat.identity();
  return c;
};
/** What the suspension ASKS for, before the visual clamps. */
const rawExtOf = (t) => {
  const target = t.grounded ? t.hitDistance : TIRE.rayLength;
  return Math.max(0, target - WHEEL.radius);
};
/** EXACTLY the renderer's formula (modularRoadVehicle.js) — both clamps. */
const suspExtOf = (t) => {
  const e = rawExtOf(t);
  if (e > TIRE.maxDroop) return TIRE.maxDroop;
  if (e < TIRE.minSuspExt) return TIRE.minSuspExt;
  return e;
};
/** Wheel TOP in chassis-local y. The body box bottom is at −CHASSIS.height/2. */
const wheelTopY = (t) => WHEEL_LOCAL[0].pos.y - suspExtOf(t) + WHEEL.radius;

console.log("=== (1) HOW FAR DOES THE WHEEL TRAVEL UP INTO THE BODY? ===\n");
{
  // Settle on flat ground first — that is the pose the GLB arches were fitted to.
  const c = make(makeGround());
  for (let i = 0; i < 2 / FIXED_DT; i++) c.tick({ steerTarget: 0, throttle: 0, handbrake: false, yaw: 0, pitch: 0 });
  const restExt = suspExtOf(c.tires[0]);
  console.log(`  settled: suspExt ${restExt.toFixed(3)} m`
    + `   wheel centre y ${(WHEEL_LOCAL[0].pos.y - restExt).toFixed(3)}`
    + `   wheel top y ${wheelTopY(c.tires[0]).toFixed(3)}`);
  console.log(`  (the GLB arches are fitted HERE — chassisModel.js: "the wheels land`);
  console.log(`   exactly in the arches with no scaling")\n`);

  console.log("  drop height   peak compression   min suspExt   wheel rose   above the arch");
  for (const h of [0.5, 1.0, 2.0, 4.0, 8.0]) {
    const v = make(makeGround(), 0.6 + h);
    let minExt = Infinity, maxComp = 0;
    for (let i = 0; i < 3 / FIXED_DT; i++) {
      v.tick({ steerTarget: 0, throttle: 0, handbrake: false, yaw: 0, pitch: 0 });
      if (!v.tires[0].grounded) continue;
      minExt = Math.min(minExt, suspExtOf(v.tires[0]));
      maxComp = Math.max(maxComp, v.tires[0].compression);
    }
    const rose = restExt - minExt;
    console.log(`  ${h.toFixed(1)} m         ${maxComp.toFixed(3)} m`
      + `           ${minExt.toFixed(3)} m      ${rose.toFixed(3)} m`
      + `      ${(rose * 100).toFixed(0)} cm`);
  }
  console.log("\n  'wheel rose' is how far ABOVE its fitted position the wheel mesh goes.");
  console.log("  Anything past the arch clearance is the wheel disappearing into the body.");
}

console.log("\n=== DRIVING ONTO A STEP (the reported 'obstacle') ===\n");
{
  console.log("  step height   raw suspExt   DRAWN suspExt   wheel rose above fitted   bottomed?");
  for (const h of [0.05, 0.10, 0.20, 0.35]) {
    const c = make(makeGround(h, 5), 0.6);
    let minRaw = Infinity, minExt = Infinity, maxComp = 0;
    for (let i = 0; i < 4 / FIXED_DT; i++) {
      c.tick({ steerTarget: 0, throttle: 1, handbrake: false, yaw: 0, pitch: 0 });
      if (!c.tires[0].grounded) continue;
      minRaw = Math.min(minRaw, rawExtOf(c.tires[0]));
      minExt = Math.min(minExt, suspExtOf(c.tires[0]));
      maxComp = Math.max(maxComp, c.tires[0].compression);
    }
    const rose = 0.137 - minExt;
    console.log(`  ${h.toFixed(2)} m        ${minRaw.toFixed(3)} m      ${minExt.toFixed(3)} m`
      + `         ${rose.toFixed(3)} m`
      + `                 ${maxComp > TIRE.restLength * TIRE.bottomOutThresh ? "yes" : "no"}`);
  }
  console.log("\n  'raw' is what the suspension asked for; 'DRAWN' is after the bump stop.");
  console.log(`  minSuspExt is ${TIRE.minSuspExt} m, so the rise tops out at`
    + ` ${(0.137 - TIRE.minSuspExt).toFixed(3)} m however hard the hit.`);
}

console.log("\n=== (2) DO THE FRONT WHEELS ACTUALLY TURN AT SPEED? ===\n");
// The physical lock is cut by steerSpeedReduce as speed rises; the DRIFT
// counter-steer overlay is not speed-limited the same way. If the overlay can
// exceed the lock, the only steering you SEE at speed is the counter-steer.
{
  console.log(`  maxSteerAngle ${(TIRE.maxSteerAngle * R2D).toFixed(1)}°`
    + `   steerSpeedReduce ${TIRE.steerSpeedReduce} at ${TIRE.steerSpeedRef} m/s`
    + `   maxVisualSteer ${(DRIFT.maxVisualSteer * R2D).toFixed(1)}°`
    + `   counterSteerVisual ${DRIFT.counterSteerVisual}`);
  // A NORMAL fast corner, not a spin: a steady half-lock turn held to settle.
  // Full lock at 35 m/s just spins the car, and a spin is not what was reported.
  console.log("\n  speed   lock avail   physical (½ input)   visual (what you SEE)   counter   slip");
  for (const target of [5, 15, 25, 35, 45]) {
    const c = make(makeGround(), 0.6);
    for (let i = 0; i < 10 / FIXED_DT; i++) {
      const sp = Math.abs(c.body.vel.z);
      if (sp >= target) break;
      c.tick({ steerTarget: 0, throttle: 1, handbrake: false, yaw: 0, pitch: 0 });
    }
    let phys = 0, vis = 0, slip = 0, sp = 0;
    for (let i = 0; i < 1.5 / FIXED_DT; i++) {
      c.tick({ steerTarget: 0.5, throttle: 0.35, handbrake: false, yaw: 0, pitch: 0 });
      // _visSteer is written by the RENDER path, which the headless mesh stub
      // never runs — so drive it here, exactly as _updateVisuals would.
      vis = c._visualSteerAngle(FIXED_DT);
      phys = c._steerAngle();
      slip = c.slipAngle;
      sp = Math.hypot(c.body.vel.x, c.body.vel.z);
    }
    const t = Math.min(1, sp / TIRE.steerSpeedRef);
    const lock = TIRE.maxSteerAngle * (1 - TIRE.steerSpeedReduce * t);
    console.log(`  ${sp.toFixed(0).padStart(3)} m/s   ${(lock * R2D).toFixed(1).padStart(6)}°`
      + `      ${(phys * R2D).toFixed(1).padStart(10)}°`
      + `            ${(vis * R2D).toFixed(1).padStart(10)}°`
      + `      ${((vis - phys) * R2D).toFixed(1).padStart(6)}°`
      + `  ${(slip * R2D).toFixed(1).padStart(6)}°`);
  }
  console.log("\n  'visual' is what the wheel MESH is turned to. If it collapses toward 0");
  console.log("  (or flips sign) while 'physical' stays positive, the counter-steer");
  console.log("  overlay is cancelling the steering you are trying to see.");
  console.log("\n  CAVEAT: half lock held for 1.5 s at 30+ m/s is a SPIN, not a corner —");
  console.log("  slip above runs to −55°. The sweep below is the honest test: find the");
  console.log("  largest steady input at each speed that keeps slip under 15°, i.e. an");
  console.log("  ordinary fast corner, and ask what the wheels are drawn doing there.");
}

console.log("\n=== THE SAME QUESTION, IN A CORNER THE CAR IS NOT SPINNING OUT OF ===\n");
{
  /** Hold `steer` at `target` m/s and report the settled state. */
  const corner = (target, steer) => {
    const c = make(makeGround(), 0.6);
    for (let i = 0; i < 12 / FIXED_DT; i++) {
      if (Math.abs(c.body.vel.z) >= target) break;
      c.tick({ steerTarget: 0, throttle: 1, handbrake: false, yaw: 0, pitch: 0 });
    }
    let phys = 0, vis = 0, slip = 0, sp = 0, peakSlip = 0;
    for (let i = 0; i < 1.2 / FIXED_DT; i++) {
      c.tick({ steerTarget: steer, throttle: 0.3, handbrake: false, yaw: 0, pitch: 0 });
      vis = c._visualSteerAngle(FIXED_DT);
      phys = c._steerAngle();
      slip = c.slipAngle;
      if (Math.abs(slip) > Math.abs(peakSlip)) peakSlip = slip;
      sp = Math.hypot(c.body.vel.x, c.body.vel.z);
    }
    return { phys, vis, slip, sp, peakSlip };
  };
  console.log("  speed   input   slip    physical   visual    verdict");
  for (const target of [15, 25, 35]) {
    for (const steer of [0.12, 0.2, 0.3, 0.45]) {
      const r = corner(target, steer);
      if (Math.abs(r.slip * R2D) > 25) continue; // that one IS a slide, skip
      const flipped = Math.sign(r.vis) !== Math.sign(r.phys) && Math.abs(r.vis * R2D) > 1;
      const shrunk = Math.abs(r.vis) < Math.abs(r.phys) * 0.5;
      console.log(`  ${r.sp.toFixed(0).padStart(3)} m/s   ${steer.toFixed(2)}   ${(r.slip * R2D).toFixed(1).padStart(5)}°`
        + `   ${(r.phys * R2D).toFixed(1).padStart(7)}°  ${(r.vis * R2D).toFixed(1).padStart(7)}°`
        + `   ${flipped ? "POINTS THE WRONG WAY" : shrunk ? "barely turns" : "reads correctly"}`);
    }
  }
  console.log("\n  This is the reported case: an ordinary fast corner, car still gripping.");
}

console.log("\n=== PICKING A DEADBAND: THE CORNER MUST READ, THE DRIFT MUST SURVIVE ===\n");
// Two things have to be true at once, so measure both for every candidate:
//   • ordinary fast corner (slip ~15°)  -> wheels point INTO the corner
//   • handbrake drift (slip 40°+)       -> wheels visibly counter-steer
// Tuning one without the other is how this ended up where it is.
{
  const setup = (target) => {
    const c = make(makeGround(), 0.6);
    for (let i = 0; i < 12 / FIXED_DT; i++) {
      if (Math.abs(c.body.vel.z) >= target) break;
      c.tick({ steerTarget: 0, throttle: 1, handbrake: false, yaw: 0, pitch: 0 });
    }
    return c;
  };
  /** Steady corner at 30 m/s, moderate input — must read as steering INTO it. */
  const cornerCase = () => {
    const c = setup(30);
    let phys = 0, vis = 0, slip = 0;
    for (let i = 0; i < 1.2 / FIXED_DT; i++) {
      c.tick({ steerTarget: 0.2, throttle: 0.3, handbrake: false, yaw: 0, pitch: 0 });
      vis = c._visualSteerAngle(FIXED_DT); phys = c._steerAngle(); slip = c.slipAngle;
    }
    return { phys, vis, slip };
  };
  /** Handbrake drift — must still show a big opposite-lock look. */
  const driftCase = () => {
    const c = setup(35);
    let peakCounter = 0, peakSlip = 0, peakVis = 0;
    for (let i = 0; i < 1.6 / FIXED_DT; i++) {
      c.tick({ steerTarget: 1, throttle: 1, handbrake: true, yaw: 0, pitch: 0 });
      const vis = c._visualSteerAngle(FIXED_DT), phys = c._steerAngle();
      if (Math.abs(vis - phys) > Math.abs(peakCounter)) peakCounter = vis - phys;
      if (Math.abs(c.slipAngle) > Math.abs(peakSlip)) peakSlip = c.slipAngle;
      if (Math.abs(vis) > Math.abs(peakVis)) peakVis = vis;
    }
    return { peakCounter, peakSlip, peakVis };
  };

  const saveD = DRIFT.counterDeadband, saveC = DRIFT.counterSteerVisual;
  console.log("  deadband  gain    CORNER: slip / phys / visual     DRIFT: counter / visual");
  for (const [dead, gain] of [
    [0.06, 0.7], [0.15, 0.7], [0.25, 0.7], [0.35, 0.7],
    [0.25, 0.9], [0.35, 1.0], [0.45, 1.0],
  ]) {
    DRIFT.counterDeadband = dead; DRIFT.counterSteerVisual = gain;
    const co = cornerCase();
    const dr = driftCase();
    const ok = Math.sign(co.vis) === Math.sign(co.phys) && Math.abs(co.vis) > Math.abs(co.phys) * 0.5;
    const flag = (dead === saveD && gain === saveC) ? " <= shipped" : "";
    console.log(`  ${dead.toFixed(2)} (${(dead * R2D).toFixed(0).padStart(2)}°)  ${gain.toFixed(1)}`
      + `   ${(co.slip * R2D).toFixed(0).padStart(4)}° ${(co.phys * R2D).toFixed(1).padStart(6)}° ${(co.vis * R2D).toFixed(1).padStart(6)}° ${ok ? "OK " : "BAD"}`
      + `      ${(dr.peakCounter * R2D).toFixed(0).padStart(5)}°  ${(dr.peakVis * R2D).toFixed(0).padStart(4)}°${flag}`);
  }
  DRIFT.counterDeadband = saveD; DRIFT.counterSteerVisual = saveC;
  console.log("\n  Want: CORNER 'OK' (wheels into the corner) AND a DRIFT counter still");
  console.log("  worth tens of degrees. The cap that matters is the RACK: the wheels");
  console.log(`  physically cannot exceed ${((TIRE.maxSteerAngle + TIRE.lowSpeedExtraLock) * R2D).toFixed(0)}° `
    + `— maxVisualSteer is ${(DRIFT.maxVisualSteer * R2D).toFixed(0)}°.`);
}

console.log("\n=== HOW BIG DOES THE COUNTER-STEER OVERLAY GET? ===\n");
{
  console.log("  a handbrake drift at speed, sampling the visual angle each tick:\n");
  const c = make(makeGround(), 0.6);
  for (let i = 0; i < 6 / FIXED_DT; i++) {
    if (Math.abs(c.body.vel.z) >= 35) break;
    c.tick({ steerTarget: 0, throttle: 1, handbrake: false, yaw: 0, pitch: 0 });
  }
  let peakVis = 0, peakPhys = 0, peakSlip = 0, peakCounter = 0;
  console.log("     t    slip     physical   visual    counter-only");
  for (let i = 0; i < 2.2 / FIXED_DT; i++) {
    c.tick({ steerTarget: 1, throttle: 1, handbrake: true, yaw: 0, pitch: 0 });
    const phys = c._steerAngle();
    const vis = c._visualSteerAngle(FIXED_DT);
    if (Math.abs(vis) > Math.abs(peakVis)) peakVis = vis;
    if (Math.abs(phys) > Math.abs(peakPhys)) peakPhys = phys;
    if (Math.abs(c.slipAngle) > Math.abs(peakSlip)) peakSlip = c.slipAngle;
    if (Math.abs(vis - phys) > Math.abs(peakCounter)) peakCounter = vis - phys;
    if (i % 24 === 0) {
      console.log(`   ${(i * FIXED_DT).toFixed(2)}  ${(c.slipAngle * R2D).toFixed(1).padStart(6)}°`
        + `   ${(phys * R2D).toFixed(1).padStart(7)}°  ${(vis * R2D).toFixed(1).padStart(7)}°`
        + `   ${((vis - phys) * R2D).toFixed(1).padStart(8)}°`);
    }
  }
  console.log(`\n  peaks:  slip ${(peakSlip * R2D).toFixed(1)}°`
    + `   physical ${(peakPhys * R2D).toFixed(1)}°`
    + `   visual ${(peakVis * R2D).toFixed(1)}°`
    + `   counter-only ${(peakCounter * R2D).toFixed(1)}°`);
  console.log(`  cap: maxVisualSteer ${(DRIFT.maxVisualSteer * R2D).toFixed(1)}°`);
}

void CHASSIS;
