// Diagnostic: after an AIR ROLL, does the car yaw by itself on landing?
//
// Reported symptom: land straight after rolling and something turns the car
// abruptly with no input. Earlier attempts at a related bug (post-flip spin)
// failed three times because they were reasoned about, so this measures instead:
// identical jump, once with roll input and once without, and reports the heading
// drift after touchdown with the steering held dead centre.
//
// An instrument, not a pass/fail test.
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const TMP = join(ROOT, `.rollrepro.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, TIRE, DRIVETRAIN, FIXED_DT } = await import(pathToFileURL(TMP).href);
unlinkSync(TMP);
const R2D = 57.2958;

const ground = {
  baked: true,
  raycastFirst(o, d, far) {
    if (d.y >= -1e-6) return null;
    const t = o.y / -d.y;
    if (t < 0 || t > far) return null;
    return { point: { x: o.x, y: 0, z: o.z }, distance: t, faceIndex: 0, normal: { x: 0, y: 1, z: 0 } };
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

const _f = new THREE.Vector3();
const _u = new THREE.Vector3();
const _r = new THREE.Vector3();
/** Heading in the world XZ plane, degrees. */
const heading = (q) => {
  _f.set(0, 0, 1).applyQuaternion(q);
  return Math.atan2(_f.x, _f.z) * R2D;
};

/**
 * Jump, optionally roll in the air, then land with the steering DEAD CENTRE and
 * no throttle. Anything that turns the car after touchdown is the car's own doing.
 */
function jump({ roll = 0, rollFor = 0.6, secs = 4 }) {
  const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  c.groundBvh = ground; c.enabled = true;
  c.body.pos.set(0, 6, 0);
  c.body.vel.set(0, 3, 28);
  c.body.quat.identity();

  let landedAt = null, hdgAtLand = 0, yawRateAtLand = 0;
  let rollAtLand = 0, worldRollRate = 0;
  const samples = [];
  const n = Math.round(secs / FIXED_DT);
  for (let i = 0; i < n; i++) {
    const t = i * FIXED_DT;
    // Roll input only while airborne and only for `rollFor` seconds.
    const steer = (landedAt === null && t < rollFor) ? roll : 0;
    c.tick({ steerTarget: steer, throttle: 0, handbrake: false, yaw: 0, pitch: 0 });

    if (landedAt === null && c.groundedCount >= 3) {
      landedAt = t;
      hdgAtLand = heading(c.body.quat);
      _u.set(0, 1, 0).applyQuaternion(c.body.quat);
      _f.set(0, 0, 1).applyQuaternion(c.body.quat);
      _r.set(1, 0, 0).applyQuaternion(c.body.quat);
      yawRateAtLand = c.body.angVel.dot(_u);      // about the car's OWN up
      worldRollRate = c.body.angVel.dot(_f);      // about its forward
      rollAtLand = Math.acos(THREE.MathUtils.clamp(_u.y, -1, 1)) * R2D;
    }
    if (landedAt !== null) {
      const dt = t - landedAt;
      if (dt <= 1.5) samples.push({ dt, hdg: heading(c.body.quat) - hdgAtLand, x: c.body.pos.x });
    }
  }
  const last = samples[samples.length - 1] ?? { hdg: 0, x: 0 };
  let worst = 0;
  for (const s of samples) if (Math.abs(s.hdg) > Math.abs(worst)) worst = s.hdg;
  return {
    landedAt, rollAtLand, yawRateAtLand, worldRollRate,
    hdgDrift: last.hdg, worstDrift: worst, driftX: last.x,
  };
}

console.log("AIR ROLL → LANDING, steering held DEAD CENTRE\n");
console.log("  air roll input   roll at touchdown   yawRate@land   heading drift 1.5s   lateral");
for (const [label, roll] of [
  ["none (baseline)", 0],
  ["right, 0.6s", -1],
  ["left,  0.6s", 1],
  ["right, 1.0s", -1],
]) {
  const r = jump({ roll, rollFor: label.includes("1.0") ? 1.0 : 0.6 });
  console.log(
    `  ${label.padEnd(16)} ${r.rollAtLand.toFixed(1).padStart(8)}°`
    + `        ${r.yawRateAtLand.toFixed(2).padStart(6)} rad/s`
    + `      ${r.hdgDrift.toFixed(1).padStart(7)}° (worst ${r.worstDrift.toFixed(1)}°)`
    + `    ${r.driftX.toFixed(1).padStart(6)} m`,
  );
}

console.log("\n=== WITH THE THROTTLE HELD (the reported case) ===");
// EVERY measurement above used throttle 0, which was the wrong scenario: the
// player holds forward through the whole jump. The car is RWD, so landing with
// ANY slip and drive on the rear is textbook power-oversteer — the drive force
// pushes the tail out, and the yaw assist then chases the deflected velocity.
{
  const withThrottle = ({ roll, throttle, drivetrain = null, secs = 4 }) => {
    const saveL = DRIVETRAIN.layout;
    if (drivetrain) DRIVETRAIN.layout = drivetrain;
    const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
    c.groundBvh = ground; c.enabled = true;
    c.body.pos.set(0, 6, 0); c.body.vel.set(0, 3, 28); c.body.quat.identity();
    let landed = null, hdgAtLand = 0, worst = 0, peakSlip = 0;
    for (let i = 0; i < secs / FIXED_DT; i++) {
      const t = i * FIXED_DT;
      c.tick({
        steerTarget: (landed === null && t < 0.6) ? roll : 0,
        throttle, handbrake: false, yaw: 0, pitch: 0,
      });
      if (landed === null && c.groundedCount >= 3) { landed = t; hdgAtLand = heading(c.body.quat); }
      if (landed !== null && t - landed <= 1.5) {
        const d = heading(c.body.quat) - hdgAtLand;
        if (Math.abs(d) > Math.abs(worst)) worst = d;
        if (Math.abs(c.slipAngle) > Math.abs(peakSlip)) peakSlip = c.slipAngle;
      }
    }
    DRIVETRAIN.layout = saveL;
    return { worst, peakSlip: peakSlip * R2D };
  };

  console.log("  roll   throttle   drivetrain   heading swing after landing   peak slip");
  for (const [roll, thr, dt] of [
    [0, 0, null], [0, 1, null],
    [-1, 0, null], [-1, 1, null],
    [-1, 1, "AWD"], [-1, 1, "FWD"],
  ]) {
    const r = withThrottle({ roll, throttle: thr, drivetrain: dt });
    console.log(`  ${roll === 0 ? "none " : "right"}   ${thr ? "HELD" : "off "}       ${(dt ?? DRIVETRAIN.layout).padEnd(4)}`
      + `         ${r.worst.toFixed(1).padStart(7)}°`
      + `                 ${r.peakSlip.toFixed(1).padStart(6)}°`);
  }
  console.log("\n  If 'roll + throttle' is far worse than 'roll alone', the drive force is");
  console.log("  amplifying the landing slip — and the drivetrain rows say how.");
}

console.log("\n=== REALISTIC SPEED AND A REAL ROLL (45 m/s, big air) ===");
// The gentle 28 m/s hop above is NOT the reported case: there the landing assist
// fully rights the car before touchdown, so it never lands rolled. Real driving
// is ~45 m/s into a big jump with the roll held long enough to actually go over.
// Sweep the roll duration to find where landing goes wrong, and measure LATERAL
// slide as well as heading — "drifts by itself" is a slide, not just a rotation.
{
  const bigJump = ({ rollFor, throttle }) => {
    const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
    c.groundBvh = ground; c.enabled = true;
    c.body.pos.set(0, 14, 0); c.body.vel.set(0, 9, 45); c.body.quat.identity();
    let landed = null, hdgAtLand = 0, xAtLand = 0, worst = 0, peakSlip = 0, tiltAtLand = 0;
    let lateral = 0;
    for (let i = 0; i < 6 / FIXED_DT; i++) {
      const t = i * FIXED_DT;
      c.tick({
        steerTarget: (landed === null && t < rollFor) ? -1 : 0,
        throttle, handbrake: false, yaw: 0, pitch: 0,
      });
      if (landed === null && c.groundedCount >= 3) {
        landed = t;
        hdgAtLand = heading(c.body.quat);
        xAtLand = c.body.pos.x;
        _u.set(0, 1, 0).applyQuaternion(c.body.quat);
        tiltAtLand = Math.acos(THREE.MathUtils.clamp(_u.y, -1, 1)) * R2D;
      }
      if (landed !== null && t - landed <= 2) {
        const d = heading(c.body.quat) - hdgAtLand;
        if (Math.abs(d) > Math.abs(worst)) worst = d;
        if (Math.abs(c.slipAngle) > Math.abs(peakSlip)) peakSlip = c.slipAngle;
        lateral = c.body.pos.x - xAtLand;
      }
    }
    return { worst, peakSlip: peakSlip * R2D, tiltAtLand, lateral, landed };
  };

  console.log("  roll held   throttle   tilt@land   heading swing   peak slip   lateral slide");
  for (const rollFor of [0, 0.3, 0.6, 1.0, 1.6]) {
    for (const thr of [0, 1]) {
      const r = bigJump({ rollFor, throttle: thr });
      console.log(`  ${rollFor.toFixed(1)}s        ${thr ? "HELD" : "off "}      ${r.tiltAtLand.toFixed(0).padStart(4)}°`
        + `      ${r.worst.toFixed(1).padStart(8)}°`
        + `      ${r.peakSlip.toFixed(1).padStart(6)}°`
        + `      ${r.lateral.toFixed(1).padStart(6)} m`);
    }
  }
  // The slide only appears when the car is still ROLLED at touchdown, so the
  // question is whether the landing assist can level it in time. It is the
  // mechanism designed to do exactly that — measure what it needs.
  console.log("\n  levelling the ROLL before touchdown (roll held 0.6s, throttle HELD):");
  console.log("    torque   window   tilt@land   lateral slide   heading swing");
  const saveT = TIRE.airLandTorque, saveW = TIRE.airLandTime;
  for (const [tq, win] of [
    [6000, 0.55], [20000, 0.55], [20000, 0.9], [45000, 0.9], [45000, 1.3], [90000, 1.3],
  ]) {
    TIRE.airLandTorque = tq; TIRE.airLandTime = win;
    const r = bigJump({ rollFor: 0.6, throttle: 1 });
    const flag = (tq === saveT && win === saveW) ? "  <= shipped" : "";
    console.log(`    ${String(tq).padStart(6)}   ${win.toFixed(2)}s   ${r.tiltAtLand.toFixed(0).padStart(6)}°`
      + `   ${r.lateral.toFixed(1).padStart(9)} m   ${r.worst.toFixed(1).padStart(9)}°${flag}`);
  }
  TIRE.airLandTorque = saveT; TIRE.airLandTime = saveW;

  console.log("\n  'tilt@land' is how rolled the car still is when the wheels arrive. If the");
  console.log("  swing only appears once that is large, the car is landing on its side and");
  console.log("  the tyres are dragging it straight — which is a contact problem, not yaw.");
}

console.log("\n=== IS IT THE YAW ASSIST? ===");
{
  const save = { at: TIRE.alignTorque, sc: TIRE.slipClampTorque, yd: TIRE.yawRateDamp };
  const run = () => jump({ roll: -1, rollFor: 0.6 });
  const base = run();
  TIRE.alignTorque = 0;
  const noAlign = run();
  TIRE.alignTorque = save.at;
  TIRE.slipClampTorque = 0;
  const noClamp = run();
  TIRE.slipClampTorque = save.sc;
  TIRE.yawRateDamp = 0;
  const noDamp = run();
  Object.assign(TIRE, { alignTorque: save.at, slipClampTorque: save.sc, yawRateDamp: save.yd });

  const row = (n, r) => console.log(`  ${n.padEnd(22)} drift ${r.hdgDrift.toFixed(1).padStart(7)}°  worst ${r.worstDrift.toFixed(1).padStart(7)}°`);
  row("as shipped", base);
  row("alignTorque = 0", noAlign);
  row("slipClampTorque = 0", noClamp);
  row("yawRateDamp = 0", noDamp);
  console.log("\n  Whichever line collapses the drift is the term responsible.");
}

console.log("\n=== TICK-BY-TICK ACROSS TOUCHDOWN ===");
// landingAngDamp made no difference at all, so the residual-roll-RATE theory is
// wrong too. Dump the actual numbers instead of theorising a third time.
//
// The suspect is slipAngle itself: it projects velocity into the plane
// perpendicular to the CHASSIS UP. Rolled, that plane is tilted — so a car still
// DESCENDING has its downward velocity read as sideways motion, and the yaw
// assist then turns the car to "align" with a velocity that is mostly down.
{
  const timeline = (roll) => {
    const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
    c.groundBvh = ground; c.enabled = true;
    c.body.pos.set(0, 6, 0); c.body.vel.set(0, 3, 28); c.body.quat.identity();
    const rows = [];
    let landed = false;
    for (let i = 0; i < 4 / FIXED_DT; i++) {
      const t = i * FIXED_DT;
      const steer = (!landed && t < 0.6) ? roll : 0;
      c.tick({ steerTarget: steer, throttle: 0, handbrake: false, yaw: 0, pitch: 0 });
      const g = c.groundedCount;
      if (!landed && g >= 3) landed = true;
      _u.set(0, 1, 0).applyQuaternion(c.body.quat);
      rows.push({
        t, g, y: c.body.pos.y, vy: c.body.vel.y,
        tilt: Math.acos(THREE.MathUtils.clamp(_u.y, -1, 1)) * R2D,
        slip: c.slipAngle * R2D,
        hdg: heading(c.body.quat),
      });
    }
    // Window around the first 3-wheel contact.
    const li = rows.findIndex((r) => r.g >= 3);
    return { rows, li };
  };
  for (const [label, roll] of [["NO ROLL", 0], ["ROLL RIGHT", -1]]) {
    const { rows, li } = timeline(roll);
    console.log(`\n  ${label}  (touchdown at tick ${li}, t=${(li * FIXED_DT).toFixed(2)}s)`);
    console.log("     t     y     vy   grnd   tilt    slipAngle   heading");
    for (let i = Math.max(0, li - 4); i < Math.min(rows.length, li + 26); i += 3) {
      const r = rows[i];
      const mark = i === li ? "  <= touchdown" : "";
      console.log(`   ${r.t.toFixed(2)} ${r.y.toFixed(2).padStart(5)} ${r.vy.toFixed(1).padStart(6)}`
        + `   ${r.g}   ${r.tilt.toFixed(1).padStart(5)}°   ${r.slip.toFixed(1).padStart(7)}°`
        + `  ${r.hdg.toFixed(1).padStart(7)}°${mark}`);
    }
  }
  console.log("\n  If slipAngle spikes at touchdown ONLY in the rolled case while the car");
  console.log("  is still descending, the assist is chasing a velocity that is mostly DOWN.");
}

console.log("\n=== WHERE DOES THE IN-AIR YAW COME FROM? ===");
// The heading is already ~33° off BEFORE the wheels touch, so nothing about
// landing creates it — landing merely CORRECTS it, and that correction is what
// reads as an abrupt turn.
//
// Rolling about the chassis' own forward axis cannot change heading while the car
// is LEVEL. But a PITCHED car's forward axis is tilted out of the horizontal, so
// rotation about it has a world-vertical component — i.e. yaw. And the nose is
// now pitched down by airTrajectoryAlign.
{
  const airYaw = (roll) => {
    const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
    c.groundBvh = ground; c.enabled = true;
    c.body.pos.set(0, 60, 0); c.body.vel.set(0, 3, 28); c.body.quat.identity();
    for (let i = 0; i < 1.2 / FIXED_DT; i++) {
      c.tick({ steerTarget: i * FIXED_DT < 0.6 ? roll : 0, throttle: 0, handbrake: false, yaw: 0, pitch: 0 });
    }
    _f.set(0, 0, 1).applyQuaternion(c.body.quat);
    return {
      hdg: heading(c.body.quat),
      pitch: Math.asin(THREE.MathUtils.clamp(_f.y, -1, 1)) * R2D,
    };
  };
  const save = TIRE.airTrajectoryAlign;
  const withAlign = airYaw(-1);
  TIRE.airTrajectoryAlign = 0;
  const noAlign = airYaw(-1);
  TIRE.airTrajectoryAlign = save;

  console.log(`  roll 0.6s, airTrajectoryAlign ${save}   nose pitch ${withAlign.pitch.toFixed(1).padStart(6)}°`
    + `   heading ${withAlign.hdg.toFixed(1).padStart(7)}°`);
  console.log(`  roll 0.6s, airTrajectoryAlign 0     nose pitch ${noAlign.pitch.toFixed(1).padStart(6)}°`
    + `   heading ${noAlign.hdg.toFixed(1).padStart(7)}°`);
  console.log("\n  If the heading swing collapses with alignment off, the nose-down pitch is");
  console.log("  what turns roll into yaw — a regression from the nose-follows-arc feature.");
}

console.log("\n=== STAND THE ASSIST DOWN WHILE ROLLED (airAlignMinUp) ===");
// No pitch axis avoids the yaw: the inertia tensor is very asymmetric (pitch
// 1554, yaw 1890, roll 420), so integrate() runs the torque through the full
// world inverse inertia and a pitch torque on a ROLLED body produces off-axis
// acceleration. That is real physics, not a bug — so the answer is for the
// assist not to act while the car is rolled. It is a help for ordinary jumps,
// and during a trick the player is in charge anyway.
//
// airAlignMinUp is the existing gate: minimum chassis-up · world-up.
{
  const save = TIRE.airAlignMinUp;
  for (const g of [0.35, 0.6, 0.8, 0.9, 0.96]) {
    TIRE.airAlignMinUp = g;
    const r = jump({ roll: -1, rollFor: 0.6 });
    const straight = jump({ roll: 0 });
    const deg = (Math.acos(Math.min(1, g)) * R2D).toFixed(0);
    const flag = g === save ? "  <= shipped" : "";
    console.log(`  minUp ${g.toFixed(2)} (stands down past ${deg}° tilt)`
      + `   rolled drift ${r.hdgDrift.toFixed(1).padStart(6)}°`
      + `   straight-jump drift ${straight.hdgDrift.toFixed(1).padStart(5)}°${flag}`);
  }
  TIRE.airAlignMinUp = save;
  console.log("\n  The straight-jump column must stay ~0 — that is the arc assist still");
  console.log("  doing its job on an ordinary jump, which is the whole point of it.");
}

console.log("\n=== LANDING ATTITUDE: does it land nose-first? ===");
// Second reported problem: after a jump the car lands FRONT first and the rear
// hangs, which feels wrong. The arc assist pitches the nose DOWN to follow the
// descent, so that is exactly what it asks for. The predictive landing assist
// (airLandAssist / airLandRange) is supposed to level the car to the surface —
// measure whether it actually wins near the ground.
{
  const attitude = (align) => {
    const save = TIRE.airTrajectoryAlign;
    TIRE.airTrajectoryAlign = align;
    const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
    c.groundBvh = ground; c.enabled = true;
    c.body.pos.set(0, 6, 0); c.body.vel.set(0, 4, 30); c.body.quat.identity();
    let atLand = null, rearDelay = null, frontAt = null, peakEngage = 0, minNose = 0;
    for (let i = 0; i < 4 / FIXED_DT; i++) {
      c.tick({ steerTarget: 0, throttle: 0, handbrake: false, yaw: 0, pitch: 0 });
      peakEngage = Math.max(peakEngage, c._landEngage ?? 0);
      _f.set(0, 0, 1).applyQuaternion(c.body.quat);
      minNose = Math.min(minNose, Math.asin(THREE.MathUtils.clamp(_f.y, -1, 1)) * R2D);
      const t = i * FIXED_DT;
      const front = c.tires[0].grounded || c.tires[1].grounded;
      const rear = c.tires[2].grounded || c.tires[3].grounded;
      if (frontAt === null && front) {
        frontAt = t;
        _f.set(0, 0, 1).applyQuaternion(c.body.quat);
        atLand = Math.asin(THREE.MathUtils.clamp(_f.y, -1, 1)) * R2D;
      }
      if (frontAt !== null && rearDelay === null && rear) rearDelay = t - frontAt;
    }
    TIRE.airTrajectoryAlign = save;
    return { atLand, rearDelay, peakEngage, minNose };
  };
  for (const a of [0, 1, 2, 3]) {
    const r = attitude(a);
    const flag = a === TIRE.airTrajectoryAlign ? "  <= shipped" : "";
    console.log(`  align ${a}   nose@contact ${(r.atLand ?? 0).toFixed(1).padStart(6)}°`
      + `   rear ${((r.rearDelay ?? 0) * 1000).toFixed(0).padStart(4)} ms later`
      + `   peak landEngage ${r.peakEngage.toFixed(2)}   worst nose ${r.minNose.toFixed(1)}°${flag}`);
  }
  console.log("\n  Negative nose = pointing DOWN. A big rear delay is the car see-sawing");
  console.log("  onto its front wheels, which is what feels bad.");
}

console.log("\n=== HOW MUCH LEVELLING TORQUE DOES IT ACTUALLY NEED? ===");
// The arc assist pitches the nose down to follow the descent; the landing assist
// is supposed to level it again before touchdown. It is currently far too weak
// to rotate a ~16° nose in the time available, so the car lands front-first.
{
  const saveT = TIRE.airLandTorque, saveW = TIRE.airLandTime;
  const probe = () => {
    const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
    c.groundBvh = ground; c.enabled = true;
    c.body.pos.set(0, 6, 0); c.body.vel.set(0, 4, 30); c.body.quat.identity();
    let frontAt = null, nose = 0, rear = null, minNose = 0;
    for (let i = 0; i < 4 / FIXED_DT; i++) {
      c.tick({ steerTarget: 0, throttle: 0, handbrake: false, yaw: 0, pitch: 0 });
      const t = i * FIXED_DT;
      _f.set(0, 0, 1).applyQuaternion(c.body.quat);
      minNose = Math.min(minNose, Math.asin(THREE.MathUtils.clamp(_f.y, -1, 1)) * R2D);
      const f = c.tires[0].grounded || c.tires[1].grounded;
      const r = c.tires[2].grounded || c.tires[3].grounded;
      if (frontAt === null && f) { frontAt = t; nose = Math.asin(THREE.MathUtils.clamp(_f.y, -1, 1)) * R2D; }
      if (frontAt !== null && rear === null && r) rear = t - frontAt;
    }
    return { nose, rear: (rear ?? 0) * 1000, minNose };
  };
  console.log("  torque   window   nose@contact   rear delay   deepest nose in flight");
  for (const [tq, win] of [[6000, 0.55], [15000, 0.55], [30000, 0.55], [30000, 0.9], [60000, 0.9]]) {
    TIRE.airLandTorque = tq; TIRE.airLandTime = win;
    const r = probe();
    const flag = (tq === saveT && win === saveW) ? "  <= shipped" : "";
    console.log(`  ${String(tq).padStart(6)}   ${win.toFixed(2)}s   ${r.nose.toFixed(1).padStart(9)}°`
      + `   ${r.rear.toFixed(0).padStart(6)} ms   ${r.minNose.toFixed(1).padStart(8)}°${flag}`);
  }
  TIRE.airLandTorque = saveT; TIRE.airLandTime = saveW;
  console.log("\n  Want nose@contact near 0 and rear delay near 0, while 'deepest nose'");
  console.log("  stays clearly negative — that is the arc look kept, the landing fixed.");
}

console.log("\n=== HEADING LOCK STRENGTH ===");
// The lock damps the accidental yaw RATE, so a little heading offset still
// accumulates during the roll itself. How much is left at each strength?
{
  const save = TIRE.airYawLock;
  for (const k of [0, 4, 8, 14, 25]) {
    TIRE.airYawLock = k;
    const r = jump({ roll: -1, rollFor: 0.6 });
    const flag = k === save ? "  <= shipped" : "";
    console.log(`  airYawLock ${String(k).padStart(2)}   landing drift ${r.hdgDrift.toFixed(1).padStart(6)}°`
      + `   lateral ${r.driftX.toFixed(2).padStart(5)} m${flag}`);
  }
  TIRE.airYawLock = save;
}

console.log("\n=== A DELIBERATE FLAT SPIN MUST STILL WORK ===");
// The lock is gated on the yaw input being zero, so Q/E spins must be untouched.
{
  const spin = (lock) => {
    const save = TIRE.airYawLock;
    TIRE.airYawLock = lock;
    const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
    c.groundBvh = ground; c.enabled = true;
    c.body.pos.set(0, 60, 0); c.body.vel.set(0, 3, 28); c.body.quat.identity();
    for (let i = 0; i < 1.2 / FIXED_DT; i++) {
      c.tick({ steerTarget: 0, throttle: 0, handbrake: false, yaw: 1, pitch: 0 });
    }
    TIRE.airYawLock = save;
    return heading(c.body.quat);
  };
  console.log(`  yaw input held, airYawLock 0    heading ${spin(0).toFixed(0).padStart(5)}°`);
  console.log(`  yaw input held, airYawLock ${TIRE.airYawLock}    heading ${spin(TIRE.airYawLock).toFixed(0).padStart(5)}°`);
  console.log("  Both should match — the lock only acts when yaw input is zero.");
}

console.log("\n=== THE EXISTING KNOB: TIRE.landingAngDamp ===");
// Purpose-built for this: "fraction of the pitch/roll RATE killed on touchdown.
// Yaw is deliberately untouched, so landing mid-spin still carries the spin."
// That last part is why raising it cannot break a deliberate flat spin.
{
  const save = TIRE.landingAngDamp;
  for (const d of [0, 0.4, 0.6, 0.8, 0.9, 1.0]) {
    TIRE.landingAngDamp = d;
    const r = jump({ roll: -1, rollFor: 0.6 });
    const flag = d === save ? "  <= shipped" : "";
    console.log(`  landingAngDamp ${d.toFixed(2)}   drift ${r.hdgDrift.toFixed(1).padStart(7)}°`
      + `   lateral ${r.driftX.toFixed(2).padStart(6)} m${flag}`);
  }
  TIRE.landingAngDamp = save;
}

console.log("\n=== A DELIBERATE FLAT SPIN MUST SURVIVE IT ===");
// Yaw is untouched by landingAngDamp, so a Q/E spin should be unaffected however
// high pitch/roll damping goes. Verifying rather than assuming.
{
  const spinTest = (damp) => {
    const save = TIRE.landingAngDamp;
    TIRE.landingAngDamp = damp;
    const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
    c.groundBvh = ground; c.enabled = true;
    c.body.pos.set(0, 6, 0); c.body.vel.set(0, 3, 28); c.body.quat.identity();
    let landed = false, hdgAtLand = 0, spun = 0;
    for (let i = 0; i < 4 / FIXED_DT; i++) {
      const airborne = c.groundedCount < 3;
      c.tick({ steerTarget: 0, throttle: 0, handbrake: false, yaw: airborne && !landed ? 1 : 0, pitch: 0 });
      if (!landed && c.groundedCount >= 3) { landed = true; hdgAtLand = heading(c.body.quat); }
      if (landed) spun = heading(c.body.quat) - hdgAtLand;
    }
    TIRE.landingAngDamp = save;
    return { hdgAtLand, spun };
  };
  for (const d of [0.4, 0.9]) {
    const r = spinTest(d);
    console.log(`  landingAngDamp ${d.toFixed(2)}   heading at touchdown ${r.hdgAtLand.toFixed(0).padStart(5)}°`
      + `   still spinning after: ${r.spun.toFixed(0).padStart(5)}°`);
  }
  console.log("  Both rows should look the same — yaw is not what this damps.");
}

console.log("\n=== IS IT LEFTOVER ROLL RATE AT TOUCHDOWN? ===");
{
  const save = TIRE.airSettle;
  const rows = [];
  for (const s of [TIRE.airSettle, 6, 20]) {
    TIRE.airSettle = s;
    const r = jump({ roll: -1, rollFor: 0.6 });
    rows.push([s, r]);
  }
  TIRE.airSettle = save;
  for (const [s, r] of rows) {
    console.log(`  airSettle ${String(s).padStart(4)}   roll@land ${r.rollAtLand.toFixed(1).padStart(5)}°`
      + `  rollRate ${r.worldRollRate.toFixed(2).padStart(6)}  drift ${r.hdgDrift.toFixed(1).padStart(7)}°`);
  }
  console.log("\n  airSettle is how fast rotation bleeds off once you RELEASE the input.");
  console.log("  If a higher value kills the drift, the car is landing still rolling.");
}
