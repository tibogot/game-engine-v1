// Diagnostic: the AIR ROLL was being throttled by the GROUND steering filter.
//
// The airborne roll axis used to read `this.input.steer` (_applyStabilizer) —
// the value _smoothSteer had already ramped for the TYRES: attack 7/s, cut a
// further 30% by `steerRateSpeedDrop` at speed. That ramp is the steering RACK'S
// weight, and nothing in the air has a rack. So the rate model's own "air feel"
// knob (`airResponse` 9/s) was never what the player felt on roll; it ran in
// SERIES with a slower filter, and short inputs suffered worst because the
// filter never got near full deflection at all.
//
// FIXED by giving the axis its own ramp, `TIRE.airSteerRate` → `input.airSteer`.
// This file is what chose the value: fully raw input saturates (it buys ~50 ms
// over 18/s on a held roll) while putting a 0.15 s tap most of the way to the
// 3.6 rad/s roll ceiling, which is the twitchy end rather than the target.
//
// The OLD behaviour is reproducible here as airSteerRate ≈ 4.9, which is what
// steerAttack 7 decayed to at the 45 m/s these runs use (7 × (1 − 0.3)).
//
// An instrument, not a pass/fail test.
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const TMP = join(ROOT, `.airrolllag.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, TIRE, FIXED_DT } = await import(pathToFileURL(TMP).href);
unlinkSync(TMP);
const R2D = 57.2958;

// No ground at all — this is a pure free-flight measurement, so nothing can
// touch down and re-arm the ground path mid-run.
const ground = {
  baked: true,
  raycastFirst() { return null; },
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

/** Roll angle about the car's own forward axis, degrees, signed, unwrapped. */
function rollAngle(q, prev) {
  _u.set(0, 1, 0).applyQuaternion(q);
  _f.set(0, 0, 1).applyQuaternion(q);
  // Component of world-up in the chassis' right/up plane → roll about forward.
  const right = new THREE.Vector3().crossVectors(_u, _f); // chassis right-ish
  let a = Math.atan2(right.y, _u.y) * R2D;
  // Unwrap against the previous sample so a barrel roll reads 0→360, not ±180.
  if (prev !== undefined) {
    while (a - prev > 180) a -= 360;
    while (a - prev < -180) a += 360;
  }
  return a;
}

/**
 * Free-flight roll with a given input profile.
 * @param {number} holdFor seconds the roll key is held (0 = whole run)
 */
function fly({ holdFor = Infinity, secs = 2.0, speed = 45 }) {
  const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  c.groundBvh = ground; c.enabled = true;
  // High enough that nothing is near a surface; forward speed is what drives
  // `steerRateSpeedDrop`, so it has to be realistic.
  c.body.pos.set(0, 400, 0);
  c.body.vel.set(0, 0, speed);
  c.body.quat.identity();
  // Air control is gated on airGroundLockout since the last CONTACT; there has
  // never been one here, so wind _airTime past it to start armed.
  c._airTime = 10;

  const rows = [];
  let prev;
  const n = Math.round(secs / FIXED_DT);
  for (let i = 0; i < n; i++) {
    const t = i * FIXED_DT;
    const steer = t < holdFor ? 1 : 0;
    c.tick({ steerTarget: steer, throttle: 0, handbrake: false, yaw: 0, pitch: 0 });
    _f.set(0, 0, 1).applyQuaternion(c.body.quat);
    const a = rollAngle(c.body.quat, prev);
    prev = a;
    rows.push({
      t: t + FIXED_DT,
      cmd: steer,
      rack: c.input.steer,        // shaped for the TYRES
      air: c.input.airSteer,      // shaped for the ROLL axis
      rollRate: c.body.angVel.dot(_f),
      roll: a,
    });
  }
  return rows;
}

/** First time the |value| of `key` crosses `target`. */
function timeTo(rows, key, target) {
  for (const r of rows) if (Math.abs(r[key]) >= target) return r.t;
  return NaN;
}

const fmt = (v, w = 6, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : "  —").padStart(w);


/** Run `fn` with airSteerRate pinned, always restoring it. */
function atRate(rate, fn) {
  const save = TIRE.airSteerRate;
  TIRE.airSteerRate = rate;
  try { return fn(); } finally { TIRE.airSteerRate = save; }
}
/** airSteerRate that reproduces the pre-fix behaviour at this run's 45 m/s. */
const OLD = 4.9;

// ── The two ramps, side by side ──────────────────────────────────────────────
console.log("=== HOW LONG DOES THE ROLL INPUT TAKE TO ARRIVE? ===");
console.log("Full key held, 45 m/s forward (where steerRateSpeedDrop bites hardest).\n");
{
  const rows = fly({});
  const line = (name, key) =>
    console.log(`  ${name.padEnd(30)} ${fmt(timeTo(rows, key, 0.5))}s ${fmt(timeTo(rows, key, 0.9))}s ${fmt(timeTo(rows, key, 0.99))}s`);
  console.log("                                    50%      90%      99%");
  line("input.steer   (tyres, rack)", "rack");
  line(`input.airSteer (roll, ${TIRE.airSteerRate}/s)`, "air");
  console.log("\n  The rack ramp is the one the roll axis used to read. The rate loop's own");
  console.log(`  convergence (airResponse ${TIRE.airResponse}/s) reaches 90% in ${(Math.log(10) / TIRE.airResponse).toFixed(3)}s and runs in`);
  console.log("  SERIES with whichever of the two feeds it.");
}

console.log("\n=== EFFECT ON A BARREL ROLL (full key held) ===");
{
  console.log("                       t to 90°   t to 180°   t to 360°   peak rate");
  for (const [label, rate] of [["before (rack ≈4.9/s)", OLD], [`after  (${TIRE.airSteerRate}/s)`, TIRE.airSteerRate], ["raw input", 1e6]]) {
    const rows = atRate(rate, () => fly({}));
    const peak = rows.reduce((m, r) => Math.max(m, Math.abs(r.rollRate)), 0);
    console.log(`  ${label.padEnd(21)} ${fmt(timeTo(rows, "roll", 90))}s  ${fmt(timeTo(rows, "roll", 180))}s   ${fmt(timeTo(rows, "roll", 360))}s   ${fmt(peak)} rad/s`);
  }
  console.log("\n  Peak rate is identical in every row — this was pure lag, never authority.");
  console.log("  Note how little the last step (18/s → raw) buys: the sweep saturates.");
}

console.log("\n=== THE CASE THAT MATTERS: A SHORT TAP ===");
// A tap is how you make a small attitude correction mid-jump. The rack filter
// never got near full deflection, so a tap lost far more than a held roll did.
//
// MEASURED AT RELEASE, NOT AT REST, and the reason is worth keeping. The
// obvious metric — total roll long after the key is up — CANNOT distinguish
// these rates at all: a unity-DC-gain filter passes the same total impulse
// whatever its time constant, so ∫airSteer over a pulse is the pulse width for
// every rate (verified: 0.0999 vs 0.1000 for 4.9/s vs 18/s). Every row came out
// identical and it looked like the change did nothing.
{
  console.log("  tap length   roll at release      peak roll rate (rad/s)");
  console.log("               before   after        before   after   raw");
  for (const hold of [0.10, 0.15, 0.25, 0.40]) {
    const at = (rate) => atRate(rate, () => {
      const r = fly({ holdFor: hold });
      const upTo = r.filter((x) => x.t <= hold + 1e-9);
      return {
        roll: Math.abs(upTo[upTo.length - 1].roll),
        peak: r.reduce((m, x) => Math.max(m, Math.abs(x.rollRate)), 0),
      };
    });
    const a = at(OLD), b = at(TIRE.airSteerRate), c = at(1e6);
    console.log(`  ${hold.toFixed(2)}s      ${fmt(a.roll, 6, 1)}°  ${fmt(b.roll, 6, 1)}°       ${fmt(a.peak, 6)}  ${fmt(b.peak, 6)}  ${fmt(c.peak, 6)}`);
  }
  console.log("\n  Peak rate is what a short input actually buys you. For scale the PITCH");
  console.log("  axis was called 'too brutal' at a 0.3s tap and retuned; the roll rate");
  console.log(`  ceiling is airRollRate ${TIRE.airRollRate} rad/s, so 'raw' reaching it on a 0.15s`);
  console.log("  tap is the twitchy end, not the target.");
}

console.log("\n=== GOTCHA FOUND WHILE MEASURING: airSettle never engages for roll ===");
// axis() picks `gain = input !== 0 ? airResponse : airSettle`. An exponential
// filter asymptotes and never returns EXACTLY 0, so with any filtered input the
// airSettle branch is unreachable on this axis — releasing roll converges at
// airResponse (9/s) rather than the softer 2/s "tumble" decay the constant
// describes. That is PRE-EXISTING and unchanged by airSteer: `input.steer` was
// an exponential filter too. Only a genuinely raw input reaches the branch,
// which is most of why the raw column keeps rolling after release.
//
// Flagged, not fixed — "keeps tumbling after you let go" is a feel decision.
{
  const tail = (rate) => atRate(rate, () => {
    const r = fly({ holdFor: 0.25 });
    const rel = r.find((x) => x.t > 0.25);
    return { atRelease: Math.abs(rel.rollRate), atEnd: Math.abs(r[r.length - 1].rollRate) };
  });
  console.log("                    roll rate at release   still rolling at 2.0s");
  for (const [label, rate] of [["filtered (18/s)", TIRE.airSteerRate], ["raw", 1e6]]) {
    const t = tail(rate);
    console.log(`  ${label.padEnd(18)} ${fmt(t.atRelease)} rad/s          ${fmt(t.atEnd)} rad/s`);
  }
}

console.log("\n=== THE ROLL IS NOW SPEED-INDEPENDENT ===");
// steerRateSpeedDrop made the roll slowest exactly when you were fastest — i.e.
// on precisely the big jumps where you most want to roll. airSteer never sees it.
{
  console.log("  forward speed   input.steer to 90%   input.airSteer to 90%   t to 90° roll");
  for (const sp of [0, 15, 30, 45]) {
    const rows = fly({ speed: sp });
    console.log(`  ${String(sp).padStart(2)} m/s          ${fmt(timeTo(rows, "rack", 0.9))}s              ${fmt(timeTo(rows, "air", 0.9))}s             ${fmt(timeTo(rows, "roll", 90))}s`);
  }
  console.log("\n  The airSteer column must be FLAT — a jump launches at high speed, so any");
  console.log("  slope there is the roll going soft exactly when the trick starts.");
}
