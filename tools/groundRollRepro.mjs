// Two reported symptoms, measured rather than reasoned about:
//
//   (1) Ramp obstacle sitting ON THE GROUND: hit it, hold roll, and "something is
//       resisting" — the car barely rotates.
//   (2) After a jump the nose points down in flight (correct) but the car goes
//       FLAT just before touchdown, so it lands on all four wheels at once
//       instead of nose-first with the rear following.
//
// Both suspects live in _applyLandingAssist's airborne branch. It probes for the
// landing surface, computes `engage` from TIME-TO-IMPACT, and then applies
//   • an ALIGNMENT torque  airLandTorque(32000) * engage  toward the surface normal
//   • a DAMPING torque     airLandDamp(6400) * engage     on the whole tilt rate
// The damping term is on pitch AND roll, so it fights the player's roll directly.
//
// Reference scale: roll inertia is 420 kg·m² and the air-control rate model can
// only ever ask for (airRollRate - cur) * airResponse * I = at most ~13600 N·m.
// So once `engage` is high, 32000 N·m of alignment simply outguns the player.
//
// An instrument, not a pass/fail test.
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = join(ROOT, `.groundroll.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, TIRE, FIXED_DT } = await import(pathToFileURL(TMP).href);
unlinkSync(TMP);
const R2D = 57.2958;

/** Infinite flat ground at y=0 — the "ramp obstacle on the ground" case. */
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

const make = (pos, vel) => {
  const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  c.groundBvh = ground; c.enabled = true;
  c.body.pos.copy(pos); c.body.vel.copy(vel); c.body.quat.identity();
  return c;
};
/** Signed tilt about the car's forward axis (roll), degrees. */
const rollDeg = (q) => {
  _u.set(0, 1, 0).applyQuaternion(q);
  _f.set(0, 0, 1).applyQuaternion(q);
  const right = new THREE.Vector3().crossVectors(_u, _f); // chassis right-ish
  return Math.atan2(right.y, _u.y) * R2D;
};
const noseDeg = (q) => {
  _f.set(0, 0, 1).applyQuaternion(q);
  return Math.asin(THREE.MathUtils.clamp(_f.y, -1, 1)) * R2D;
};

/**
 * A LOW launch, as off a ramp lying on the ground, with roll held the whole
 * flight. Reports how far it actually got over, and how hard the landing assist
 * was pushing back while it tried.
 */
function lowRamp({ up, fwd, y0 = 0.45, secs = 3, landAssist = TIRE.airLandAssist }) {
  const save = TIRE.airLandAssist;
  TIRE.airLandAssist = landAssist;
  const c = make(new THREE.Vector3(0, y0, 0), new THREE.Vector3(0, up, fwd));
  let peakRoll = 0, airTime = 0, peakEngage = 0, sumEngage = 0, nEngage = 0;
  let landed = null;
  for (let i = 0; i < secs / FIXED_DT; i++) {
    const t = i * FIXED_DT;
    c.tick({ steerTarget: -1, throttle: 1, handbrake: false, yaw: 0, pitch: 0 });
    const air = c.groundedCount === 0;
    if (air) {
      airTime += FIXED_DT;
      const e = c._landEngage ?? 0;
      peakEngage = Math.max(peakEngage, e);
      sumEngage += e; nEngage++;
    } else if (landed === null && airTime > 0.1) landed = t;
    const r = rollDeg(c.body.quat);
    if (Math.abs(r) > Math.abs(peakRoll)) peakRoll = r;
  }
  TIRE.airLandAssist = save;
  return { peakRoll, airTime, peakEngage, meanEngage: nEngage ? sumEngage / nEngage : 0 };
}

console.log("=== (1) ROLL OFF A LOW GROUND RAMP, steering held FULL for the whole flight ===\n");
console.log("  launch (up,fwd)   air time   peak roll ON   peak roll OFF   engage peak/mean");
for (const [up, fwd] of [[4, 25], [6, 30], [8, 30], [10, 35], [14, 40]]) {
  const on = lowRamp({ up, fwd });
  const off = lowRamp({ up, fwd, landAssist: 0 });
  console.log(
    `  (${String(up).padStart(2)}, ${fwd})           ${on.airTime.toFixed(2)}s`
    + `      ${on.peakRoll.toFixed(0).padStart(5)}°`
    + `           ${off.peakRoll.toFixed(0).padStart(5)}°`
    + `        ${on.peakEngage.toFixed(2)} / ${on.meanEngage.toFixed(2)}`,
  );
}
console.log("\n  'OFF' is the same jump with airLandAssist disabled. A large gap means the");
console.log("  landing assist is what is resisting the roll — and 'engage mean' says for");
console.log("  how much of the flight it was doing it.");

console.log("\n=== WHICH HALF OF THE ASSIST RESISTS: ALIGNMENT OR DAMPING? ===\n");
{
  const saveT = TIRE.airLandTorque, saveD = TIRE.airLandDamp;
  console.log("  airLandTorque   airLandDamp   peak roll (launch 8,30)");
  for (const [tq, dp] of [[32000, 6400], [32000, 0], [0, 6400], [0, 0]]) {
    TIRE.airLandTorque = tq; TIRE.airLandDamp = dp;
    // airLandTorque 0 disables the whole branch, so probe damping via a tiny torque.
    const r = lowRamp({ up: 8, fwd: 30 });
    const flag = (tq === saveT && dp === saveD) ? "  <= shipped" : "";
    console.log(`  ${String(tq).padStart(11)}   ${String(dp).padStart(9)}   ${r.peakRoll.toFixed(0).padStart(10)}°${flag}`);
  }
  TIRE.airLandTorque = saveT; TIRE.airLandDamp = saveD;
}

console.log("\n=== ENGAGE OVER A LOW FLIGHT (launch 8,30 — is it ever off?) ===\n");
{
  const c = make(new THREE.Vector3(0, 0.45, 0), new THREE.Vector3(0, 8, 30));
  console.log("     t      y     vy   grnd   engage   roll    (steer held full right)");
  for (let i = 0; i < 1.9 / FIXED_DT; i++) {
    const t = i * FIXED_DT;
    c.tick({ steerTarget: -1, throttle: 1, handbrake: false, yaw: 0, pitch: 0 });
    if (i % 6 === 0) {
      console.log(`   ${t.toFixed(2)} ${c.body.pos.y.toFixed(2).padStart(6)} ${c.body.vel.y.toFixed(1).padStart(6)}`
        + `    ${c.groundedCount}    ${(c._landEngage ?? 0).toFixed(2)}   ${rollDeg(c.body.quat).toFixed(0).padStart(5)}°`);
    }
  }
  console.log("\n  Note the probe fires STRAIGHT DOWN while the car is still climbing");
  console.log("  (velocity.y > -1), so a low launch reads a tiny distance and engages at");
  console.log("  full strength on the way UP — before the jump has even started.");
}

console.log("\n=== (2) LANDING ATTITUDE: does the nose stay down through touchdown? ===\n");
{
  const attitude = ({ landAssist = TIRE.airLandAssist, y0 = 8, up = 6, fwd = 32 } = {}) => {
    const save = TIRE.airLandAssist;
    TIRE.airLandAssist = landAssist;
    const c = make(new THREE.Vector3(0, y0, 0), new THREE.Vector3(0, up, fwd));
    let deepest = 0, frontAt = null, noseAtFront = 0, rearDelay = null, noseAtApexOfFall = 0;
    for (let i = 0; i < 5 / FIXED_DT; i++) {
      const t = i * FIXED_DT;
      c.tick({ steerTarget: 0, throttle: 1, handbrake: false, yaw: 0, pitch: 0 });
      const n = noseDeg(c.body.quat);
      if (c.groundedCount === 0) deepest = Math.min(deepest, n);
      const front = c.tires[0].grounded || c.tires[1].grounded;
      const rear = c.tires[2].grounded || c.tires[3].grounded;
      if (frontAt === null && front) { frontAt = t; noseAtFront = n; }
      if (frontAt !== null && rearDelay === null && rear) rearDelay = t - frontAt;
      if (frontAt === null && c.body.vel.y < -4) noseAtApexOfFall = n;
    }
    TIRE.airLandAssist = save;
    return { deepest, noseAtFront, rearDelay: (rearDelay ?? 0) * 1000, midFall: noseAtApexOfFall };
  };
  console.log("  landing assist   deepest nose in flight   nose at FRONT contact   rear arrives");
  for (const a of [1, 0.5, 0]) {
    const r = attitude({ landAssist: a });
    const flag = a === TIRE.airLandAssist ? "  <= shipped" : "";
    console.log(`  ${a.toFixed(2)}             ${r.deepest.toFixed(1).padStart(10)}°`
      + `              ${r.noseAtFront.toFixed(1).padStart(8)}°`
      + `          ${r.rearDelay.toFixed(0).padStart(4)} ms${flag}`);
  }
  console.log("\n  Reported: nose points down in flight, then the car FLATTENS near the");
  console.log("  ground. If 'deepest' is clearly negative but 'nose at front contact' is");
  console.log("  near 0 with the assist on and stays negative with it off, that IS the bug.");
}

console.log("\n=== REGRESSION GUARD: RELEASE MID-ROLL, DOES IT STILL LEVEL? ===\n");
// The assist exists to stop a car arriving on its side, digging a wheel and
// being shoved sideways (airLandTorque's own docs: 30° tilt => 4.2 m of slide).
// It now yields to held roll input and no longer touches pitch, so the question
// is whether the ROLL half still does its job in the window it has left once the
// player lets go. Big air at speed, roll held then RELEASED.
{
  const bigJump = ({ rollFor, window = TIRE.airLandTime, assist = TIRE.airLandAssist }) => {
    const saveW = TIRE.airLandTime, saveA = TIRE.airLandAssist;
    TIRE.airLandTime = window; TIRE.airLandAssist = assist;
    const c = make(new THREE.Vector3(0, 14, 0), new THREE.Vector3(0, 9, 45));
    let landed = null, tilt = 0, xAtLand = 0, lateral = 0, nose = 0;
    for (let i = 0; i < 6 / FIXED_DT; i++) {
      const t = i * FIXED_DT;
      c.tick({
        steerTarget: (landed === null && t < rollFor) ? -1 : 0,
        throttle: 1, handbrake: false, yaw: 0, pitch: 0,
      });
      if (landed === null && c.groundedCount >= 3) {
        landed = t; xAtLand = c.body.pos.x; nose = noseDeg(c.body.quat);
        _u.set(0, 1, 0).applyQuaternion(c.body.quat);
        tilt = Math.acos(THREE.MathUtils.clamp(_u.y, -1, 1)) * R2D;
      }
      if (landed !== null && t - landed <= 2) lateral = c.body.pos.x - xAtLand;
    }
    TIRE.airLandTime = saveW; TIRE.airLandAssist = saveA;
    return { tilt, lateral, nose };
  };
  console.log("  roll held   assist   tilt@land   lateral slide   nose@land");
  for (const rollFor of [0.3, 0.6, 1.0]) {
    for (const assist of [1, 0]) {
      const r = bigJump({ rollFor, assist });
      console.log(`  ${rollFor.toFixed(1)}s        ${assist ? "ON " : "OFF"}      ${r.tilt.toFixed(0).padStart(5)}°`
        + `       ${r.lateral.toFixed(1).padStart(7)} m      ${r.nose.toFixed(1).padStart(6)}°`);
    }
  }
  console.log("\n  ON must beat OFF on tilt and slide — that is the assist still working.");
  console.log("\n  window sweep (roll held 0.6s then released):");
  console.log("    airLandTime   tilt@land   lateral slide   nose@land");
  for (const w of [0.55, 0.85, 1.2, 1.6, 2.2]) {
    const r = bigJump({ rollFor: 0.6, window: w });
    const flag = w === TIRE.airLandTime ? "  <= shipped" : "";
    console.log(`    ${w.toFixed(2)}s        ${r.tilt.toFixed(0).padStart(5)}°       ${r.lateral.toFixed(1).padStart(7)} m`
      + `      ${r.nose.toFixed(1).padStart(6)}°${flag}`);
  }
  console.log("\n  A longer window is nearly free now: it only buys ROLL levelling time and");
  console.log("  yields to input, so it cannot flatten the nose or fight a trick.");
}

console.log("\n=== NOSE ANGLE THROUGH THE LAST HALF-SECOND ===\n");
{
  const trace = (landAssist) => {
    const save = TIRE.airLandAssist;
    TIRE.airLandAssist = landAssist;
    const c = make(new THREE.Vector3(0, 8, 0), new THREE.Vector3(0, 6, 32));
    const rows = [];
    for (let i = 0; i < 5 / FIXED_DT; i++) {
      c.tick({ steerTarget: 0, throttle: 1, handbrake: false, yaw: 0, pitch: 0 });
      rows.push({
        t: i * FIXED_DT, y: c.body.pos.y, nose: noseDeg(c.body.quat),
        eng: c._landEngage ?? 0, g: c.groundedCount,
      });
    }
    TIRE.airLandAssist = save;
    return rows;
  };
  for (const a of [1, 0]) {
    const rows = trace(a);
    const li = rows.findIndex((r) => r.g > 0);
    console.log(`  landing assist ${a}  (first contact t=${(li * FIXED_DT).toFixed(2)}s)`);
    console.log("      t      y    engage    nose");
    for (let i = Math.max(0, li - 40); i <= Math.min(rows.length - 1, li + 8); i += 4) {
      const r = rows[i];
      console.log(`   ${r.t.toFixed(2)} ${r.y.toFixed(2).padStart(6)}    ${r.eng.toFixed(2)}   ${r.nose.toFixed(1).padStart(6)}°`
        + (i === li ? "  <= contact" : ""));
    }
    console.log("");
  }
}
