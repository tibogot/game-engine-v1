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

  check("the car does NOT stay flat through the jump", Math.abs(last.nose) > 4,
    `${last.nose.toFixed(1)}° at touchdown`);
  check("the nose ends up pointing DOWN, with the descent", last.nose < 0);
  check("it tracks the trajectory rather than trailing it",
    meanErr < 4, `${meanErr.toFixed(1)}° mean error`);
  // Without the rate feed-forward a proportional term lags by (target rate/gain)
  // forever — measured 8.7° and still growing at touchdown, i.e. worse than flat.
  check("error does not GROW across the flight (the feed-forward's whole job)",
    Math.abs(last.nose - last.traj) < 4,
    `${Math.abs(last.nose - last.traj).toFixed(1)}° at touchdown`);
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
  check("a half-second press stays well short of inverted (was 158°)",
    press < 110, `${press.toFixed(0)}°`);
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
    if (L.nose > -0.1) ok = false; // must always end nose-down
  }
  check("every jump ends nose-down, none stays flat", ok);
}

console.log(fail ? `\n${fail} FAILURE(S)` : "\nall green");
process.exit(fail ? 1 : 0);
