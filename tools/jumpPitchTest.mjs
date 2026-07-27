// Does the car pitch through a jump, and does it stay out of the way otherwise?
//
// Left to pure rigid-body physics the chassis holds its launch attitude for the
// whole flight — correct, and it looks wrong: measured over a 35 m/s launch the
// trajectory swings +14° → −7° while the nose sits at exactly 0.0°, so the car
// sails out flat, lands flat, and a jump reads as a hop.
//
// TIRE.airTrajectoryAlign rotates the nose toward the direction of travel. The
// interesting part is everything it must NOT do: fight a deliberate flip, right
// an inverted car, or fire at parking speed. Those gates are what this covers.
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = join(ROOT, `.jump.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, TIRE, FIXED_DT } = await import(pathToFileURL(TMP).href);
unlinkSync(TMP);

let fail = 0;
const check = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); if (!c) fail++; };
const R2D = 57.2958;

const ground = {
  baked: true,
  raycastFirst(o, d, far) {
    if (d.y >= -1e-6) return null;
    const t = o.y / -d.y;
    if (t < 0 || t > far) return null;
    return { point: { x: o.x + d.x * t, y: 0, z: o.z + d.z * t }, distance: t, faceIndex: 0, normal: { x: 0, y: 1, z: 0 } };
  },
  spherecast() { return null; },
  closestPointWithNormal() { return null; },
};
Vehicle.prototype._buildMeshes = function () {
  this.group = new THREE.Group(); this.chassisMesh = new THREE.Object3D();
  this.tireGroups = [0, 0, 0, 0].map(() => new THREE.Group());
  this.arrowGroup = new THREE.Group(); this.arrowGroup.visible = false;
  this.arrows = [0, 0, 0, 0].map(() => ({})); this.wheelSpin = [0, 0, 0, 0];
  this.headlights = []; this.headlightTargets = []; this.headlamps = []; this.taillights = [];
  this._wheelInstances = []; this._wheelParts = [];
};
Vehicle.prototype._updateTaillights = function () {};

const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
/** Launch ballistically and sample nose vs trajectory each tick. */
function fly({ vy = 9, vz = 35, input = {}, quat = null, steps = 170 } = {}) {
  const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  c.groundBvh = ground; c.enabled = true;
  c.body.pos.set(0, 3, 0); c.body.vel.set(0, vy, vz);
  if (quat) c.body.quat.copy(quat); else c.body.quat.identity();
  const rows = [];
  for (let i = 0; i < steps; i++) {
    c.tick({ steerTarget: 0, throttle: 0, handbrake: false, yaw: 0, pitch: 0, ...input });
    const v = c.body.vel;
    _fwd.set(0, 0, 1).applyQuaternion(c.body.quat);
    _up.set(0, 1, 0).applyQuaternion(c.body.quat);
    rows.push({
      t: i * FIXED_DT, y: c.body.pos.y, upY: _up.y,
      traj: Math.atan2(v.y, Math.hypot(v.x, v.z)) * R2D,
      nose: Math.atan2(_fwd.y, Math.hypot(_fwd.x, _fwd.z)) * R2D,
    });
  }
  return rows;
}
/** Total nose rotation, unwrapped — a flip is 360°. */
const sweep = (rows) => {
  let t = 0;
  for (let i = 1; i < rows.length; i++) {
    let d = rows[i].nose - rows[i - 1].nose;
    if (d > 180) d -= 360; if (d < -180) d += 360;
    t += d;
  }
  return Math.abs(t);
};

console.log("=== THE NOSE FOLLOWS THE ARC ===");
{
  const r = fly();
  const air = r.filter((x) => x.y > 0);
  const settled = air.slice(45);
  const meanErr = settled.reduce((a, b) => a + Math.abs(b.nose - b.traj), 0) / settled.length;
  const last = air[air.length - 1];
  console.log(`  nose ${r[0].nose.toFixed(1)}° → ${last.nose.toFixed(1)}°   trajectory ${r[0].traj.toFixed(1)}° → ${last.traj.toFixed(1)}°`);
  console.log(`  mean |mismatch| once settled: ${meanErr.toFixed(1)}°`);

  // NOSE-DOWN IS MEASURED IN FLIGHT, LEVEL IS MEASURED AT TOUCHDOWN. These are
  // two different goals and the earlier version conflated them: it asserted the
  // nose was still pitched when the wheels arrived, which is precisely the
  // see-sawing landing that had to be removed.
  const deepest = Math.min(...air.map((x) => x.nose));
  const steepestTraj = Math.min(...air.map((x) => x.traj));
  // Measured RELATIVE to the arc, not as an absolute angle: a jump whose
  // trajectory is nearly flat at touchdown SHOULD land flat, so a fixed
  // threshold would fail correct behaviour on the fastest, flattest jumps.
  check("the car does NOT stay flat — the nose tracks a real share of the arc",
    Math.abs(deepest) > Math.abs(steepestTraj) * 0.25,
    `nose ${deepest.toFixed(1)}° against a ${steepestTraj.toFixed(1)}° arc`);
  check("the nose points DOWN on the way in, never up", deepest < 0);
  // Half the arc, not all of it — matching the trajectory exactly landed 16°
  // nose-down with the front wheels 150 ms ahead of the rear.
  check("it follows only a FRACTION of the arc, so touchdown is not a slam",
    Math.abs(deepest) < Math.abs(Math.min(...air.map((x) => x.traj))) * 0.9,
    `nose ${deepest.toFixed(1)}° vs trajectory ${Math.min(...air.map((x) => x.traj)).toFixed(1)}°`);
  check("and it LEVELS OUT for the landing, rather than arriving nose-first",
    Math.abs(last.nose) < 4, `${last.nose.toFixed(1)}° at touchdown`);
}

console.log("\n=== IT YIELDS TO THE PLAYER ===");
{
  const on = sweep(fly({ input: { pitch: 1 } }));
  const saved = TIRE.airTrajectoryAlign;
  TIRE.airTrajectoryAlign = 0;
  const off = sweep(fly({ input: { pitch: 1 } }));
  TIRE.airTrajectoryAlign = saved;
  console.log(`  pitch held: ${on.toFixed(0)}° with alignment, ${off.toFixed(0)}° without`);
  check("a deliberate flip is not dragged back", Math.abs(on - off) < 2,
    `${Math.abs(on - off).toFixed(1)}° difference`);
}

console.log("\n=== AIR ROLL DIRECTION ===");
// Press RIGHT, roll RIGHT — right side down, i.e. CLOCKWISE from a chase camera.
// This shipped INVERTED, and the sign is genuinely easy to get wrong: WHEEL_LOCAL
// labels the +X wheels "R", but +X is SCREEN-LEFT for a camera behind a car that
// faces +Z. So "right" is defined here by a REAL camera, not by reasoning about
// handedness. Ground steering was always correct — only the air axis was flipped.
{
  const cam = new THREE.PerspectiveCamera(60, 1.6, 0.1, 1000);
  cam.position.set(0, 3, -9);   // behind a car facing +Z
  cam.lookAt(0, 1, 0);
  cam.updateMatrixWorld();
  const camRight = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0).normalize();

  const rollWith = (steerTarget) => {
    const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
    c.groundBvh = ground; c.enabled = true;
    c.body.pos.set(0, 80, 0); c.body.vel.set(0, 0, 30); c.body.quat.identity();
    for (let i = 0; i < 60; i++) {
      c.tick({ steerTarget, throttle: 0, handbrake: false, yaw: 0, pitch: 0 });
    }
    // Top tipping toward screen-right = clockwise (12 o'clock toward 3).
    return new THREE.Vector3(0, 1, 0).applyQuaternion(c.body.quat).dot(camRight);
  };
  const groundWith = (steerTarget) => {
    const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
    c.groundBvh = ground; c.enabled = true;
    c.body.pos.set(0, 0.6, 0); c.body.vel.set(0, 0, 18); c.body.quat.identity();
    for (let i = 0; i < 200; i++) {
      c.tick({ steerTarget, throttle: 0.5, handbrake: false, yaw: 0, pitch: 0 });
    }
    return c.body.pos.dot(camRight);
  };
  // roadGame: kbSteer = (left?1:0) - (right?1:0)  =>  LEFT = +1, RIGHT = -1
  const RIGHT = -1, LEFT = 1;
  console.log(`  press RIGHT: roll ${rollWith(RIGHT).toFixed(2)}  ground ${groundWith(RIGHT).toFixed(1)}`);
  console.log(`  press LEFT : roll ${rollWith(LEFT).toFixed(2)}  ground ${groundWith(LEFT).toFixed(1)}`);
  console.log("  (positive = screen-right)");

  check("press RIGHT rolls CLOCKWISE — right side down, as in every flight sim",
    rollWith(RIGHT) > 0.1, `${rollWith(RIGHT).toFixed(2)}`);
  check("press LEFT rolls COUNTER-CLOCKWISE", rollWith(LEFT) < -0.1,
    `${rollWith(LEFT).toFixed(2)}`);
  check("roll is symmetric between the two inputs",
    Math.abs(rollWith(RIGHT) + rollWith(LEFT)) < 0.02);
  check("GROUND steering still matches the key (it was never wrong)",
    groundWith(RIGHT) > 1 && groundWith(LEFT) < -1,
    `right ${groundWith(RIGHT).toFixed(1)}, left ${groundWith(LEFT).toFixed(1)}`);
  check("air roll and ground steer agree in direction — press right, go right",
    Math.sign(rollWith(RIGHT)) === Math.sign(groundWith(RIGHT)));
}

console.log("\n=== AIR ROLL MUST NOT TURN THE CAR ===");
// Reported as "landing straight after a roll, something turns the car abruptly".
// It was never a landing bug: rolling a PITCHED body leaks into world yaw as a
// matter of geometry, and the nose-follows-arc assist pitches the nose for the
// whole descent. Measured before the fix: 0.6 s of roll input left the car 33°
// across its direction of travel at touchdown, and the tyres then snapped it
// straight — which is the "abrupt turn" the player sees.
//
// No axis choice removes it (picking better axes only got 17° → 9°), so
// TIRE.airYawLock damps accidental world-vertical rotation instead.
{
  const R2D3 = 57.2958;
  const headingOf = (q) => {
    const f = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    return Math.atan2(f.x, f.z) * R2D3;
  };
  /** Jump, roll for a while, land with the steering dead centre. */
  const rollJump = (roll, rollFor = 0.6) => {
    const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
    c.groundBvh = ground; c.enabled = true;
    c.body.pos.set(0, 6, 0); c.body.vel.set(0, 3, 28); c.body.quat.identity();
    let landed = null, hdgAtLand = 0, worst = 0;
    for (let i = 0; i < 4 / FIXED_DT; i++) {
      const t = i * FIXED_DT;
      c.tick({
        steerTarget: (landed === null && t < rollFor) ? roll : 0,
        throttle: 0, handbrake: false, yaw: 0, pitch: 0,
      });
      if (landed === null && c.groundedCount >= 3) { landed = t; hdgAtLand = headingOf(c.body.quat); }
      if (landed !== null && t - landed <= 1.5) {
        const d = headingOf(c.body.quat) - hdgAtLand;
        if (Math.abs(d) > Math.abs(worst)) worst = d;
      }
    }
    return { landed, worst, lateral: c.body.pos.x };
  };

  const none = rollJump(0);
  const right = rollJump(-1);
  const left = rollJump(1);
  console.log(`  no roll: ${none.worst.toFixed(1)}°   roll right: ${right.worst.toFixed(1)}°   roll left: ${left.worst.toFixed(1)}°`);

  check("a straight jump lands dead straight", Math.abs(none.worst) < 0.5,
    `${none.worst.toFixed(2)}°`);
  check("rolling in the air does not swing the car on landing (was 17°)",
    Math.abs(right.worst) < 5, `${right.worst.toFixed(1)}°`);
  check("and it is symmetric left/right",
    Math.abs(right.worst + left.worst) < 0.5,
    `${right.worst.toFixed(1)}° vs ${left.worst.toFixed(1)}°`);
  // The fix is that the arc assist STANDS DOWN while rolled — a pitch torque on
  // a rolled body acquires a yaw component through the asymmetric inertia
  // tensor, which no choice of torque axis avoids. (A world-Y "heading lock" was
  // tried and removed: it fought the roll itself.)
  check("the arc assist stands down well before the car is far from upright",
    TIRE.airAlignMinUp >= 0.8,
    `minUp ${TIRE.airAlignMinUp} = stands down past ${(Math.acos(TIRE.airAlignMinUp) * R2D3).toFixed(0)}° tilt`);

  // The lock must be gated on yaw input, or it kills deliberate flat spins.
  const spun = (() => {
    const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
    c.groundBvh = ground; c.enabled = true;
    c.body.pos.set(0, 60, 0); c.body.vel.set(0, 3, 28); c.body.quat.identity();
    for (let i = 0; i < 1.2 / FIXED_DT; i++) {
      c.tick({ steerTarget: 0, throttle: 0, handbrake: false, yaw: 1, pitch: 0 });
    }
    return Math.abs(headingOf(c.body.quat));
  })();
  check("a DELIBERATE flat spin is untouched by the lock", spun > 45,
    `${spun.toFixed(0)}° of spin`);
}

console.log("\n=== LANDING AFTER A ROLL MUST NOT SLIDE ===");
// The reported bug was NOT a rotation, which is why three attempts that measured
// heading found nothing. At realistic speed the car arrives still rolled ~30°,
// the tyres bite at an angle and shove it SIDEWAYS — up to 4.8 m of lateral
// slide with almost no heading change. Only visible if you measure translation.
{
  const bigJump = (rollFor, throttle) => {
    const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
    c.groundBvh = ground; c.enabled = true;
    c.body.pos.set(0, 14, 0); c.body.vel.set(0, 9, 45); c.body.quat.identity();
    const up = new THREE.Vector3();
    let landed = null, xAtLand = 0, tilt = 0, lateral = 0;
    for (let i = 0; i < 6 / FIXED_DT; i++) {
      const t = i * FIXED_DT;
      c.tick({
        steerTarget: (landed === null && t < rollFor) ? -1 : 0,
        throttle, handbrake: false, yaw: 0, pitch: 0,
      });
      if (landed === null && c.groundedCount >= 3) {
        landed = t; xAtLand = c.body.pos.x;
        up.set(0, 1, 0).applyQuaternion(c.body.quat);
        tilt = Math.acos(THREE.MathUtils.clamp(up.y, -1, 1)) * 57.2958;
      }
      if (landed !== null && t - landed <= 2) lateral = c.body.pos.x - xAtLand;
    }
    return { tilt, lateral };
  };

  let worstSlide = 0, worstTilt = 0;
  for (const rollFor of [0, 0.3, 0.6, 1.0, 1.6]) {
    for (const thr of [0, 1]) {
      const r = bigJump(rollFor, thr);
      worstSlide = Math.max(worstSlide, Math.abs(r.lateral));
      worstTilt = Math.max(worstTilt, r.tilt);
    }
  }
  console.log(`  worst lateral slide ${worstSlide.toFixed(1)} m, worst tilt at touchdown ${worstTilt.toFixed(0)}°`);
  check("landing after a roll does not slide the car sideways (was 4.8 m)",
    worstSlide < 1.5, `${worstSlide.toFixed(1)} m`);
  // The slide is caused by landing rolled, so the assist must actually level it.
  check("the landing assist levels the ROLL before touchdown (was 30°)",
    worstTilt < 25, `${worstTilt.toFixed(0)}°`);
  // Torque and damping are a PAIR: 5x the torque with the old damping drove a
  // long barrel roll straight past level into a 113° spin.
  check("landing damping is scaled to the landing torque",
    TIRE.airLandDamp / TIRE.airLandTorque > 0.1,
    `damp ${TIRE.airLandDamp} vs torque ${TIRE.airLandTorque}`);
}

console.log("\n=== FLIP FEEL ===");
// "Too brutal" was measurable: at rate 3.6 / shared response 9, a 0.3 s tap of
// Shift/Ctrl rotated 91° and a 0.5 s press 158°, so a light input on a ~1.5 s
// jump left you inverted. Pitch now has its own softer response.
{
  const R2D2 = 57.2958;
  /** Degrees of nose rotation from holding pitch for `hold` seconds. */
  const rotFor = (hold) => {
    const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
    c.groundBvh = ground; c.enabled = true;
    c.body.pos.set(0, 60, 0); c.body.vel.set(0, 0, 35); c.body.quat.identity();
    const R = new THREE.Vector3();
    let tot = 0;
    for (let i = 0; i < 180; i++) {
      const t = i * FIXED_DT;
      c.tick({ steerTarget: 0, throttle: 0, handbrake: false, yaw: 0, pitch: t < hold ? 1 : 0 });
      R.set(1, 0, 0).applyQuaternion(c.body.quat);
      tot += Math.abs(c.body.angVel.dot(R)) * FIXED_DT;
    }
    return tot * R2D2;
  };
  const tap = rotFor(0.3), press = rotFor(0.5);
  const full360 = 360 / (TIRE.airPitchRate * R2D2);
  console.log(`  0.3s tap ${tap.toFixed(0)}°   0.5s press ${press.toFixed(0)}°   full 360 in ${full360.toFixed(2)}s`);

  check("a light tap is a nudge, not a quarter-flip (was 91°)", tap < 80, `${tap.toFixed(0)}°`);
  // Slightly more than before (113° vs 89°) because the arc assist now stands
  // down during a flip instead of quietly opposing it — which is correct: an
  // automatic assist should not be fighting a deliberate trick.
  check("a half-second press stays well short of inverted (was 158°)",
    press < 125, `${press.toFixed(0)}°`);
  check("a 360 is still landable inside a big jump's airtime", full360 < 2.4,
    `${full360.toFixed(2)}s`);
  check("pitch is softer than roll — roll was never the complaint",
    TIRE.airPitchResponse < TIRE.airResponse && TIRE.airPitchRate <= TIRE.airRollRate,
    `pitch ${TIRE.airPitchRate}/${TIRE.airPitchResponse} vs roll ${TIRE.airRollRate}/${TIRE.airResponse}`);
  // If pitch rate ever drops to/below the align cutoff, the nose-follows-arc
  // assist stops standing down and starts dragging deliberate flips back.
  check("airPitchRate stays ABOVE airAlignMaxSpin, or the assist fights flips",
    TIRE.airPitchRate > TIRE.airAlignMaxSpin,
    `${TIRE.airPitchRate} > ${TIRE.airAlignMaxSpin}`);
}

console.log("\n=== THE GATES ===");
{
  // Inverted: "point at where you're going" would try to right the car mid-trick.
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI);
  const inv = fly({ quat: q, steps: 60 });
  check("does not fire while inverted (upright gate)",
    inv.every((x) => x.upY < 0), `up.y stayed ${inv[inv.length - 1].upY.toFixed(2)}`);

  // Below airAlignMinSpeed the velocity vector is noise, not a heading.
  const slow = fly({ vy: 2, vz: 3, steps: 40 });
  check("does not fire below airAlignMinSpeed", Math.abs(slow[20].nose) < 2,
    `${slow[20].nose.toFixed(2)}°`);

  const saved = TIRE.airTrajectoryAlign;
  TIRE.airTrajectoryAlign = 0;
  const flat = fly();
  TIRE.airTrajectoryAlign = saved;
  check("setting airTrajectoryAlign to 0 restores the old flat behaviour",
    Math.abs(flat[80].nose) < 0.01, `${flat[80].nose.toFixed(3)}°`);
}

console.log("\n=== IT WORKS ACROSS THE RANGE OF JUMPS THE KIT BUILDS ===");
{
  console.log("  launch              nose@touchdown   traj@touchdown");
  let ok = true;
  for (const [vy, vz] of [[6, 20], [9, 35], [13, 45], [5, 48]]) {
    const air = fly({ vy, vz }).filter((x) => x.y > 0);
    const L = air[air.length - 1];
    console.log(`  ${String(vz).padStart(2)} m/s fwd, ${String(vy).padStart(2)} up  ${L.nose.toFixed(1).padStart(9)}°     ${L.traj.toFixed(1).padStart(9)}°`);
    // Never nose-UP, and never steeper than the arc it is following. A jump
    // arriving on a −1.3° trajectory landing at −0.0° is CORRECT — the old
    // "always nose-down" rule failed the flattest jumps for behaving properly.
    if (L.nose > 0.5 || L.nose < L.traj - 1) ok = false;
  }
  check("no jump lands nose-UP, and none lands steeper than its own arc", ok);
}

console.log("\n=== A LOW RAMP ON FLAT GROUND MUST STILL LET YOU ROLL ===");
// Reported: put a ramp obstacle on the ground, hit it, hold roll, and "something
// is resisting" — the car barely turns over.
//
// It was the predictive landing assist. Its `engage` came from
// (probe range / speed), and while the car is CLIMBING the probe points straight
// down — so it divided the current HEIGHT by the current SPEED, which is not a
// time to anything. A car 1.5 m off the deck at 31 m/s read 0.05 s to impact and
// engaged at 0.94 on the way UP. At 32000 N·m against the 13600 N·m ceiling the
// rate model can ask for on roll (3.6 rad/s × response 9 × 420 kg·m²), the
// player simply loses: 39° of roll reached against 180° with the assist off.
//
// engage is now a real ballistic time-to-impact, so a climbing car reads seconds.
{
  const lowRamp = (assist) => {
    const save = TIRE.airLandAssist;
    TIRE.airLandAssist = assist;
    const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
    c.groundBvh = ground; c.enabled = true;
    c.body.pos.set(0, 0.45, 0); c.body.vel.set(0, 8, 30); c.body.quat.identity();
    let peak = 0, engageWhileClimbing = 0;
    for (let i = 0; i < 2 / FIXED_DT; i++) {
      c.tick({ steerTarget: -1, throttle: 1, handbrake: false, yaw: 0, pitch: 0 });
      _up.set(0, 1, 0).applyQuaternion(c.body.quat);
      _fwd.set(0, 0, 1).applyQuaternion(c.body.quat);
      const right = new THREE.Vector3().crossVectors(_up, _fwd);
      const roll = Math.abs(Math.atan2(right.y, _up.y) * R2D);
      if (roll > peak) peak = roll;
      if (c.groundedCount === 0 && c.body.vel.y > 1) {
        engageWhileClimbing = Math.max(engageWhileClimbing, c._landEngage ?? 0);
      }
    }
    TIRE.airLandAssist = save;
    return { peak, engageWhileClimbing };
  };
  const on = lowRamp(1);
  const off = lowRamp(0);
  check(
    "the landing assist never engages while the car is still going UP",
    on.engageWhileClimbing < 0.05,
    `peak engage while climbing ${on.engageWhileClimbing.toFixed(2)} (was 0.94)`,
  );
  check(
    "holding roll off a low ground ramp gets the car over",
    on.peak > 150,
    `${on.peak.toFixed(0)}° with the assist, ${off.peak.toFixed(0)}° without (was 78° vs 179°)`,
  );
}

console.log("\n=== BUT THE ASSIST MUST STILL SAVE A RELEASED ROLL ===");
// The other half: it yields to a HELD roll, so it must still level the car once
// the player lets go. Landing rolled is not a cosmetic problem — the tyres bite
// at an angle and shove the car sideways (see airLandTorque).
{
  const bigJump = (assist) => {
    const save = TIRE.airLandAssist;
    TIRE.airLandAssist = assist;
    const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
    c.groundBvh = ground; c.enabled = true;
    c.body.pos.set(0, 14, 0); c.body.vel.set(0, 9, 45); c.body.quat.identity();
    let landed = null, tilt = 0, xAtLand = 0, lateral = 0;
    for (let i = 0; i < 6 / FIXED_DT; i++) {
      const t = i * FIXED_DT;
      c.tick({
        steerTarget: (landed === null && t < 0.3) ? -1 : 0, // released well before landing
        throttle: 1, handbrake: false, yaw: 0, pitch: 0,
      });
      if (landed === null && c.groundedCount >= 3) {
        landed = t; xAtLand = c.body.pos.x;
        _up.set(0, 1, 0).applyQuaternion(c.body.quat);
        tilt = Math.acos(THREE.MathUtils.clamp(_up.y, -1, 1)) * R2D;
      }
      if (landed !== null && t - landed <= 2) lateral = Math.abs(c.body.pos.x - xAtLand);
    }
    TIRE.airLandAssist = save;
    return { tilt, lateral };
  };
  const on = bigJump(1);
  const off = bigJump(0);
  check(
    "roll is levelled before touchdown once the input is released",
    on.tilt < 15 && on.tilt < off.tilt,
    `${on.tilt.toFixed(0)}° tilt with the assist vs ${off.tilt.toFixed(0)}° without`,
  );
  check(
    "and the car does not get shoved sideways on landing",
    on.lateral < 1.0 && on.lateral <= off.lateral + 0.05,
    `${on.lateral.toFixed(1)} m slide vs ${off.lateral.toFixed(1)} m`,
  );
}

console.log("\n=== THE NOSE STAYS DOWN THROUGH TOUCHDOWN ===");
// Reported: the nose points down in flight (correct) but the car "gets flat and
// stabilised" in the last few metres, so it slaps down on all four wheels at
// once. That was the assist's PITCH half cancelling everything the arc assist
// built, plus the arc assist handing its axis over to it. The assist now levels
// ROLL only, so the nose leads and the rear follows — which is what a real car
// does off a jump.
{
  const attitude = () => {
    const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
    c.groundBvh = ground; c.enabled = true;
    c.body.pos.set(0, 8, 0); c.body.vel.set(0, 6, 32); c.body.quat.identity();
    let deepest = 0, frontAt = null, noseAtFront = 0, rearDelay = null;
    for (let i = 0; i < 5 / FIXED_DT; i++) {
      const t = i * FIXED_DT;
      c.tick({ steerTarget: 0, throttle: 1, handbrake: false, yaw: 0, pitch: 0 });
      _fwd.set(0, 0, 1).applyQuaternion(c.body.quat);
      const nose = Math.asin(THREE.MathUtils.clamp(_fwd.y, -1, 1)) * R2D;
      if (c.groundedCount === 0) deepest = Math.min(deepest, nose);
      const front = c.tires[0].grounded || c.tires[1].grounded;
      const rear = c.tires[2].grounded || c.tires[3].grounded;
      if (frontAt === null && front) { frontAt = t; noseAtFront = nose; }
      if (frontAt !== null && rearDelay === null && rear) rearDelay = t - frontAt;
    }
    return { deepest, noseAtFront, rearDelay: (rearDelay ?? 0) * 1000 };
  };
  const r = attitude();
  check(
    "the nose is still pointing DOWN when the front wheels arrive",
    r.noseAtFront < -7,
    `${r.noseAtFront.toFixed(1)}° at contact, deepest ${r.deepest.toFixed(1)}° (was −5.7° at contact)`,
  );
  check(
    "it does not flatten out over the last metres",
    r.noseAtFront <= r.deepest + 1.5,
    `held ${(r.deepest - r.noseAtFront).toFixed(1)}° of the ${Math.abs(r.deepest).toFixed(1)}° it built`,
  );
  check(
    "front lands first and the rear follows straight after",
    r.rearDelay > 20 && r.rearDelay < 200,
    `rear arrives ${r.rearDelay.toFixed(0)} ms later (was 42 ms — near-simultaneous)`,
  );
}

console.log(fail ? `\n${fail} FAILURE(S)` : "\nall green");
process.exit(fail ? 1 : 0);
