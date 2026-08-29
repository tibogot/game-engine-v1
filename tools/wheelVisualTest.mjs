// The two wheel-VISUAL defects found by driving with the debug orbit camera.
// Both are renderer-side: the physics is identical before and after.
//
//  (1) "the front wheels go INSIDE the chassis on some obstacles"
//      The renderer clamped how far a wheel may DROOP (TIRE.maxDroop) but not
//      how far it may rise, so a hard hit drove the tyre all the way up to its
//      hub — 0.14 m above the settled pose the GLB arches were modelled around.
//
//  (2) "if I go fast and turn I don't see the front wheels turning, but I see
//      them counter-turning for the drift"
//      The drift counter-steer overlay fired from 3.4° of slip, which is an
//      ordinary corner, while the physical lock was simultaneously being cut by
//      steerSpeedReduce — so past ~13 m/s the overlay outgrew the steering and
//      the wheels were drawn pointing OUT of the corner.
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = join(ROOT, `.wheelvistest.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, TIRE, WHEEL, WHEEL_LOCAL, DRIFT, FIXED_DT } =
  await import(pathToFileURL(TMP).href);
unlinkSync(TMP);

let fail = 0;
const check = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); if (!c) fail++; };
const R2D = 57.2958;

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

const make = (ground, y = 0.6) => {
  const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  c.groundBvh = ground; c.enabled = true;
  c.body.pos.set(0, y, 0); c.body.quat.identity();
  return c;
};
/**
 * What the renderer ACTUALLY drew, read back off the vehicle.
 *
 * This used to be a copy of the clamp chain written out again here — which is
 * how it survived the arch-lift work unchanged while quietly testing a formula
 * the renderer had stopped using. Read the real field; a duplicated rule only
 * ever tests itself.
 */
const drawnExt = (t) => t.visualExt;
/** Arch gap actually presented to the bodywork: the wheel's own extension plus
 *  whatever lift the body took on to keep that gap open. */
const archGap = (c, t) => t.visualExt + c._archLift;
/** Advance BOTH the sim and the visual layer — visualExt only exists after a
 *  syncVisuals, and it eases, so it has to be stepped every tick. */
const step1 = (c, input = {}) => {
  c.tick({ steerTarget: 0, throttle: 0, handbrake: false, yaw: 0, pitch: 0, ...input });
  c.syncVisuals(FIXED_DT, 1);
};
const settle = (c, secs = 2) => {
  for (let i = 0; i < secs / FIXED_DT; i++) step1(c);
};

console.log("=== (1) THE WHEEL CANNOT CLIMB INTO THE BODY ===");
{
  const rest = make(makeGround());
  settle(rest);
  const restExt = drawnExt(rest.tires[0]);
  check(
    "the settled pose is unchanged — the GLB arches are fitted to THIS",
    Math.abs(restExt - 0.137) < 0.01,
    `${restExt.toFixed(3)} m of extension`,
  );
  check(
    "the bump stop sits below the settled pose, or the car would ride high",
    TIRE.minSuspExt < restExt,
    `minSuspExt ${TIRE.minSuspExt} < rest ${restExt.toFixed(3)}`,
  );
  check(
    "the two visual clamps are the right way round",
    TIRE.minSuspExt < TIRE.maxDroop,
    `minSuspExt ${TIRE.minSuspExt} < maxDroop ${TIRE.maxDroop}`,
  );

  // THE ARCH GAP IS NOW HELD OPEN BY THE BODY, NOT BY CLAMPING THE WHEEL.
  //
  // This assertion used to be "the wheel never rises more than the bump travel
  // above its fitted spot", which was the right property while `minSuspExt` was
  // a hard floor on the drawn wheel. It no longer is: the wheel goes wherever
  // the ground is (that is the point — a floor can only push the tyre DOWN, into
  // the road), and the BODY lifts to keep the gap. So the thing to check is the
  // gap itself, which is what the bodywork actually cares about.
  const probeStep = (step) => {
    const c = make(makeGround(step, 5));
    let minGap = Infinity, sink = 0;
    for (let i = 0; i < 4 / FIXED_DT; i++) {
      step1(c, { throttle: 1 });
      const t = c.tires[0];
      if (!t.grounded) continue;
      minGap = Math.min(minGap, archGap(c, t));
      // …and the other half of the same trade: the wheel must not be drawn
      // BELOW the surface it just measured.
      sink = Math.max(sink, drawnExt(t) - (t.hitDistance - WHEEL.radius));
    }
    return { gap: minGap, sink };
  };

  // DRIVABLE obstacles — a kerb, a ramp lip. This is the range the mechanism is
  // specified for, and the range a road deck can actually present.
  let worstGap = Infinity, worstSink = 0;
  const rows = [];
  for (const step of [0.05, 0.1, 0.2]) {
    const r = probeStep(step);
    worstGap = Math.min(worstGap, r.gap);
    worstSink = Math.max(worstSink, r.sink);
    rows.push(`${step}m→${(r.gap * 100).toFixed(1)}cm`);
  }
  // NOT a stale threshold. archLiftBody is 1, so the body is meant to absorb the
  // WHOLE shortfall — but archLiftMax caps the lift at 12 cm, and a 0.2 m step
  // drives the wheel to about -5.7 cm extension, needing ~15.7 cm. The cap is
  // the binding constraint, not the clamp this check names. Either archLiftMax
  // rises to cover the range the mechanism claims, or the claimed range stops
  // below 0.2 m — a driving-feel call, so it is reported rather than silently
  // re-baselined.
  const needed = TIRE.minSuspExt - (worstGap - TIRE.archLiftMax);
  check(
    "over drivable obstacles the body keeps the wheel-arch gap open",
    worstGap >= TIRE.minSuspExt - 1e-6,
    `worst gap ${(worstGap * 100).toFixed(1)} cm vs target ${(TIRE.minSuspExt * 100).toFixed(1)} cm`
    + ` — needs ${(needed * 100).toFixed(1)} cm of body lift, archLiftMax caps it at `
    + `${(TIRE.archLiftMax * 100).toFixed(1)} cm`,
  );
  check(
    "…and the wheel is never drawn below the surface it measured",
    worstSink <= 1e-4,
    `worst ${(worstSink * 100).toFixed(2)} cm below contact`,
  );
  console.log(`      arch gap: ${rows.join("  ")}`);

  // BEYOND THE CAP — reported, deliberately not asserted.
  //
  // TIRE.archLiftMax (0.25 m) bounds both the body lift and how far above its
  // hub a wheel may be drawn. A step taller than that is not a bump the
  // suspension absorbs, it is a WALL: at 0.60 m the hub itself ends up below the
  // new surface (0.497 m of static hub height against a 0.60 m rise), so there
  // is no wheel placement and no bounded lift that keeps the tyre out of it.
  // The chassis collider owns that case, not the visual layer.
  //
  // Left visible rather than tuned away, because if these numbers ever appear on
  // a real track it means a deck has a cliff in it.
  console.log("      beyond the cap (walls, not bumps — chassis collision's job):");
  for (const step of [0.35, 0.6]) {
    const r = probeStep(step);
    console.log(`        ${step} m step → arch gap ${(r.gap * 100).toFixed(1)} cm,`
      + ` wheel ${(r.sink * 100).toFixed(1)} cm below contact`);
  }

  // Falling off a ledge must still show the suspension EXTEND — the clamps
  // must not have accidentally frozen the travel.
  const air = make(makeGround(), 6);
  for (let i = 0; i < 0.5 / FIXED_DT; i++) step1(air);
  check(
    "airborne, the wheels still hang down on the droop stop",
    Math.abs(drawnExt(air.tires[0]) - TIRE.maxDroop) < 1e-6,
    `${drawnExt(air.tires[0]).toFixed(3)} m = maxDroop`,
  );
}

console.log("\n=== (1b) THE WHEEL IS KEPT OUT OF SOLIDS TOO, NOT JUST THE ROAD ===");
// The tyre probe only ever queried the GROUND bvh (terrain + road decks), while
// guardrails, tunnel shells and gates live in a SEPARATE solids bvh used for
// chassis collision only — so a wheel resting on a rail passed straight through
// it. That was a missing query, not a bad number. See TIRE.wheelSolidClear.
{
  /** A solid whose flat top is at `topY`, everywhere. Mirrors the shape of
   *  RoadBvh.closestPointWithNormal: nearest point + outward normal. */
  const slab = (topY) => ({
    baked: true,
    closestPointWithNormal(px, py, pz, maxDist, out) {
      const d = Math.abs(py - topY);
      if (d > maxDist) return null;
      out.set(0, py >= topY ? 1 : -1, 0); // outward = toward the query point
      return { x: px, y: topY, z: pz, distance: d };
    },
  });

  const TOP = 0.2; // a low rail cap the car is sitting across
  const onSlab = (clear) => {
    const save = TIRE.wheelSolidClear;
    TIRE.wheelSolidClear = clear;
    const c = make(makeGround());
    c.solidsBvh = slab(TOP);
    settle(c);
    let lowest = Infinity;
    for (let i = 0; i < 4; i++) {
      lowest = Math.min(lowest, c.tireGroups[i].position.y - WHEEL.radius);
    }
    TIRE.wheelSolidClear = save;
    return lowest;
  };

  const off = onSlab(0);
  const on = onSlab(1);
  console.log(`      lowest tyre point: ${off.toFixed(3)} m without the probe,`
    + ` ${on.toFixed(3)} m with it (rail cap at ${TOP})`);
  check(
    "without it the tyre is drawn inside the rail — the defect",
    off < TOP - 0.05,
    `${((TOP - off) * 100).toFixed(1)} cm inside`,
  );
  check(
    "with it the tyre rests ON the rail instead of through it",
    on >= TOP - 1e-3,
    `${((on - TOP) * 100).toFixed(2)} cm clear`,
  );

  // A VERTICAL face must be ignored: a wheel beside a wall is not sinking into
  // anything, and the 1/(n·up) correction would throw it at the sky.
  const wall = {
    baked: true,
    closestPointWithNormal(px, py, pz, maxDist, out) {
      const d = Math.abs(px - 0.2);
      if (d > maxDist) return null;
      out.set(px >= 0.2 ? 1 : -1, 0, 0); // purely horizontal normal
      return { x: 0.2, y: py, z: pz, distance: d };
    },
  };
  const flat = make(makeGround());
  settle(flat);
  const before = flat.tireGroups[0].position.y;
  const beside = make(makeGround());
  beside.solidsBvh = wall;
  settle(beside);
  check(
    "a vertical wall beside the wheel is ignored, not treated as ground",
    Math.abs(beside.tireGroups[0].position.y - before) < 1e-3,
    `moved ${((beside.tireGroups[0].position.y - before) * 100).toFixed(2)} cm`,
  );
}

console.log("\n=== PHYSICS IS UNTOUCHED BY THE VISUAL CLAMP ===");
// The whole point of fixing this in the renderer: compression, and therefore the
// spring, the bottom-out and the handling, must be exactly as before.
{
  const c = make(makeGround(0.2, 5));
  let maxComp = 0, minExt = Infinity;
  for (let i = 0; i < 4 / FIXED_DT; i++) {
    c.tick({ steerTarget: 0, throttle: 1, handbrake: false, yaw: 0, pitch: 0 });
    if (!c.tires[0].grounded) continue;
    maxComp = Math.max(maxComp, c.tires[0].compression);
    minExt = Math.min(minExt, Math.max(0, c.tires[0].hitDistance - WHEEL.radius));
  }
  // Compression the bump stop would correspond to, if it were a physics limit.
  const drawnComp = TIRE.restLength - (TIRE.minSuspExt + WHEEL.radius);
  check(
    "the suspension still compresses past what is drawn — the spring is unclamped",
    maxComp > drawnComp && minExt < TIRE.minSuspExt,
    `compression reached ${maxComp.toFixed(3)} m vs the drawn stop at ${drawnComp.toFixed(3)} m;`
    + ` raw extension bottomed at ${minExt.toFixed(3)} m`,
  );
}

console.log("\n=== (2) IN A CORNER, THE FRONT WHEELS POINT INTO THE CORNER ===");
{
  const corner = (target, steer) => {
    const c = make(makeGround());
    for (let i = 0; i < 12 / FIXED_DT; i++) {
      if (Math.abs(c.body.vel.z) >= target) break;
      c.tick({ steerTarget: 0, throttle: 1, handbrake: false, yaw: 0, pitch: 0 });
    }
    let phys = 0, vis = 0, slip = 0, sp = 0;
    for (let i = 0; i < 1.2 / FIXED_DT; i++) {
      c.tick({ steerTarget: steer, throttle: 0.3, handbrake: false, yaw: 0, pitch: 0 });
      vis = c._visualSteerAngle(FIXED_DT);
      phys = c._steerAngle();
      slip = c.slipAngle;
      sp = Math.hypot(c.body.vel.x, c.body.vel.z);
    }
    return { phys, vis, slip, sp };
  };
  let allOk = true;
  const rows = [];
  for (const [speed, steer] of [[15, 0.2], [25, 0.2], [35, 0.2], [25, 0.12], [35, 0.12]]) {
    const r = corner(speed, steer);
    const sameWay = Math.sign(r.vis) === Math.sign(r.phys);
    const visible = Math.abs(r.vis) > Math.abs(r.phys) * 0.5;
    if (!sameWay || !visible) allOk = false;
    rows.push(`${r.sp.toFixed(0)}m/s slip${(r.slip * R2D).toFixed(0)}° ${(r.phys * R2D).toFixed(1)}°→${(r.vis * R2D).toFixed(1)}°`);
  }
  check(
    "the wheels are never drawn steering OUT of a corner the car is gripping",
    allOk,
    rows.join("  "),
  );
}

console.log("\n=== …AND A REAL DRIFT STILL COUNTER-STEERS HARD ===");
// The fix must not cost the drift look, which is the whole reason the overlay
// exists. Raising the gain alongside the deadband makes it stronger, not weaker.
{
  const c = make(makeGround());
  for (let i = 0; i < 12 / FIXED_DT; i++) {
    if (Math.abs(c.body.vel.z) >= 35) break;
    c.tick({ steerTarget: 0, throttle: 1, handbrake: false, yaw: 0, pitch: 0 });
  }
  let peakCounter = 0, peakSlip = 0, peakVis = 0;
  for (let i = 0; i < 1.6 / FIXED_DT; i++) {
    c.tick({ steerTarget: 1, throttle: 1, handbrake: true, yaw: 0, pitch: 0 });
    const vis = c._visualSteerAngle(FIXED_DT);
    const phys = c._steerAngle();
    if (Math.abs(vis - phys) > Math.abs(peakCounter)) peakCounter = vis - phys;
    if (Math.abs(c.slipAngle) > Math.abs(peakSlip)) peakSlip = c.slipAngle;
    if (Math.abs(vis) > Math.abs(peakVis)) peakVis = vis;
  }
  check(
    "a handbrake drift still swings the wheels tens of degrees of opposite lock",
    Math.abs(peakCounter * R2D) > 40,
    `peak counter ${(peakCounter * R2D).toFixed(0)}° at ${(peakSlip * R2D).toFixed(0)}° of slip (was −60°)`,
  );
  check(
    "and the drawn angle never exceeds the visual cap",
    Math.abs(peakVis) <= DRIFT.maxVisualSteer + 1e-6,
    `${(peakVis * R2D).toFixed(1)}° vs cap ${(DRIFT.maxVisualSteer * R2D).toFixed(1)}°`,
  );
}

console.log("\n=== THE DEADBAND IS WHERE A SLIDE BEGINS, NOT WHERE A CORNER DOES ===");
{
  check(
    "the deadband is past ordinary cornering slip",
    DRIFT.counterDeadband * R2D > 12,
    `${(DRIFT.counterDeadband * R2D).toFixed(0)}° (was 3.4°, which is a corner)`,
  );
  check(
    "…but still well inside a real drift, or the look would never fire",
    DRIFT.counterDeadband * R2D < 35,
    `${(DRIFT.counterDeadband * R2D).toFixed(0)}°`,
  );
  // Zero slip must add NO cosmetic offset — the mesh follows the tyre, subject
  // only to the visual cap (which full lock plus the low-speed donut boost does
  // exceed, and that clamp is deliberate).
  const c = make(makeGround());
  settle(c);
  let vis = 0, phys = 0;
  for (let i = 0; i < 1.5 / FIXED_DT; i++) {
    c.tick({ steerTarget: 1, throttle: 0, handbrake: false, yaw: 0, pitch: 0 });
    vis = c._visualSteerAngle(FIXED_DT); // must be ticked every step, it eases
    phys = c._steerAngle();
  }
  const want = Math.min(Math.abs(phys), DRIFT.maxVisualSteer) * Math.sign(phys);
  check(
    "parked with the wheel turned, the mesh follows the tyre (no drift offset)",
    Math.abs(vis - want) * R2D < 0.5,
    `${(phys * R2D).toFixed(1)}° physical, capped to ${(want * R2D).toFixed(1)}°, drawn ${(vis * R2D).toFixed(1)}°`,
  );
}

void WHEEL_LOCAL;
console.log(fail ? `\n${fail} FAILURE(S)` : "\nall green");
process.exit(fail ? 1 : 0);
