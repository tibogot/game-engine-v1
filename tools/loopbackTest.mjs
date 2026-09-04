// The FLIP RAMP: a steep face that curls over the top, sending the car BACK the
// way it came, upside down, onto a deck above the road it arrived on.
//
// THREE CLAIMS, checked apart because they fail apart:
//
//   1. THE SHAPE is a ramp, not a loop — a gentle transition off the flat, a
//      STRAIGHT face, and the curve only at the END, taken past vertical. Past
//      vertical is what reverses the car; the straight middle is what stops it
//      reading as a great sweeping loop of road.
//   2. THE TURN IS CONTINUOUS. Going over the top the chassis is already
//      rotating at the surface rate; the lip then throws that away and briefly
//      reverses it (traced at −1.03 rad/s against the +1.07 the ramp had), so
//      the car hangs vertical and only starts turning later. The vehicle SETS
//      the rate at the launch to the one the ramp had — no easing onto it, or
//      the reversal is visible — and the flight simply continues it.
//   3. IT STOPS AT INVERTED. The target is an attitude, not an amount: the car
//      arrives flat upside down and settles there, for the player to roll out
//      of with W/X. A rate that ran for the whole flight turns one flip into
//      three, which is what an earlier version did.
//
// Run: node tools/loopbackTest.mjs   (--sweep to re-characterise)
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = join(ROOT, `.loopback.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, WHEEL, TIRE, FIXED_DT } = await import(pathToFileURL(TMP).href);
unlinkSync(TMP);

const { PIECE_BY_ID, PIECE_PARAM_DEFAULTS, FOLLOW_ROAD } =
  await import(new URL("../games/modular-road-v3/modularRoadKit.js", import.meta.url).href);
const { RoadBvh } = await import(new URL("../v3/play/modularRoadBvh.js", import.meta.url).href);
const { createVehicleGround } = await import(new URL("../v3/play/modularRoadGround.js", import.meta.url).href);

Vehicle.prototype._buildMeshes = function () {
  this.group = new THREE.Group(); this.chassisMesh = new THREE.Object3D();
  this.tireGroups = [0, 0, 0, 0].map(() => new THREE.Group());
  this.arrowGroup = new THREE.Group(); this.arrowGroup.visible = false;
  this.arrows = [0, 0, 0, 0].map(() => ({})); this.wheelSpin = [0, 0, 0, 0];
  this.headlights = []; this.headlightTargets = []; this.headlamps = []; this.taillights = [];
  this._wheelInstances = []; this._wheelParts = [];
};
Vehicle.prototype._updateTaillights = function () {};

const R2D = 57.2958, WIDTH = 16, RUNUP = 120;
const SWEEP = process.argv.includes("--sweep");
let fails = 0;
const ok = (cond, msg, extra = "") => {
  if (!cond) fails++;
  console.log(`   ${cond ? "PASS" : "FAIL"}  ${msg}${extra ? `  — ${extra}` : ""}`);
};

const ramp = (over = {}) => PIECE_BY_ID.get("loopback")
  .points({ ...PIECE_PARAM_DEFAULTS, ...over })
  .map((p) => ({ y: p.y, z: p.z }));

function ribbon(pts, roadHold) {
  const pos = [], w = WIDTH / 2;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    pos.push(-w, a.y, a.z, w, a.y, a.z, w, b.y, b.z);
    pos.push(-w, a.y, a.z, w, b.y, b.z, -w, b.y, b.z);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  const m = new THREE.Mesh(geo);
  // Tagged separately: only the ramp is FOLLOW_ROAD in the kit, and that tag is
  // both what keeps the car planted on the face and the flip's gate. Tagging the
  // run-up too would test a permission the game does not grant.
  m.userData.roadHold = roadHold;
  m.updateMatrixWorld(true);
  return m;
}

const _u = new THREE.Vector3(), _r = new THREE.Vector3();

/**
 * Drive at the ramp and report the whole flight.
 *
 * @param {object} [opts.assists] TIRE overrides for this run, used to show which
 *   half of the behaviour belongs to the vehicle and which to the shape.
 */
function run({ speed = 30, over = {}, assists = null } = {}) {
  const saved = assists ? Object.fromEntries(Object.keys(assists).map((k) => [k, TIRE[k]])) : null;
  if (assists) Object.assign(TIRE, assists);
  try {
    const arc = ramp(over);
    const lip = arc[arc.length - 1];
    // DECK ONLY. roadGame's bake puts the drive surface in the deck channel and
    // only rails/shells in solids; baking it into both lets the solid resolver
    // fight the car on a steep face, which the game never does.
    const d = new RoadBvh();
    d.bakeFromMeshes([ribbon([{ y: 0, z: RUNUP }, { y: 0, z: 0 }], false), ribbon(arc, true)]);
    const g = createVehicleGround({ getTerrainHeight: () => -1e4 });
    g.setRoadBvh(d);

    const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
    c.groundBvh = g.ground; c.solidsBvh = g.solids;
    c.getFloorY = () => -1e4; c.enabled = true;
    c.body.pos.set(0, WHEEL.radius + 0.18, 40);
    c.body.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
    c.body.vel.set(0, 0, -speed);

    let air = false, spin = 0, minUp = 1, t = 0, peak = 0, back = -1e9;
    let exitVz = 0, firstRate = 0, worstBack = 0, invertedAt = null, hungVertical = 0, lateRate = 0;
    for (let i = 0; i < Math.round(16 / FIXED_DT); i++) {
      c.tick({ steerTarget: 0, throttle: 1, handbrake: false, yaw: 0, pitch: 0, airSteer: 0 });
      const p = c.body.pos;
      _r.set(1, 0, 0).applyQuaternion(c.body.quat);
      _u.set(0, 1, 0).applyQuaternion(c.body.quat);
      const rate = -c.body.angVel.dot(_r); // + = turning over backwards
      if (p.z < 2) peak = Math.max(peak, p.y);
      if (!air && c.groundedCount === 0 && p.z < 2 && p.y > lip.y - 3) {
        air = true; exitVz = c.body.vel.z; firstRate = rate;
      } else if (air) {
        spin += rate * FIXED_DT;
        minUp = Math.min(minUp, _u.y);
        peak = Math.max(peak, p.y);
        t += FIXED_DT;
        // A turn that REVERSES on the way is the un-smooth launch this exists
        // to prevent; and a car sitting on its nose is the "vertical state".
        if (t < 1) worstBack = Math.min(worstBack, rate);
        if (Math.abs(_u.y) < 0.35) hungVertical += FIXED_DT;
        if (invertedAt === null && _u.y < -0.9) invertedAt = t;
        // Only while genuinely FLYING: the car comes back out over the run-up
        // road and lands on it, and a touchdown spins the chassis hard — that
        // is not "still flipping", and counting it read 9 rad/s.
        if (t > 2.5 && c.groundedCount === 0 && p.y > 5) {
          lateRate = Math.max(lateRate, Math.abs(rate));
        }
        if (p.y > 2) back = Math.max(back, p.z);
        if (p.y < 0) break;
      }
    }
    return {
      top: lip.y, exitVz, firstRate, worstBack, spin: spin * R2D, minUp,
      t, peak, back, invertedAt, hungVertical, lateRate,
    };
  } finally {
    if (saved) Object.assign(TIRE, saved);
  }
}

const row = (label, r) => console.log(
  `   ${label.padEnd(18)} vz ${r.exitVz > 0 ? "+" : ""}${r.exitVz.toFixed(1).padStart(5)}` +
  ` ${r.exitVz > 1 ? "BACK ↩" : "onward"}  air ${r.t.toFixed(1)}s  peak ${r.peak.toFixed(0).padStart(3)}m` +
  `  turn ${r.spin.toFixed(0).padStart(4)}°  minUp ${r.minUp.toFixed(2)}` +
  `  inverted @${r.invertedAt === null ? " never" : r.invertedAt.toFixed(2) + "s"}` +
  `  vertical ${r.hungVertical.toFixed(2)}s  back z ${r.back.toFixed(0)}`);

if (SWEEP) {
  console.log("=== SWEEP ===");
  // The exit angle is the pacing knob: it decides how much of the car's speed
  // goes UP rather than BACK, and therefore the hang time — without touching
  // the run-up. See the note on loopbackExit in the kit.
  for (const exit of [118, 128, 135, 142]) {
    for (const v of [26, 32, 38]) {
      row(`exit ${exit}° @${v}`, run({ speed: v, over: { loopbackExit: exit } }));
    }
  }
  process.exit(0);
}

/* ── 1. The shape ────────────────────────────────────────────────────────── */
console.log("=== 1. A RAMP WITH THE CURVE AT THE END, TAKEN PAST VERTICAL ===");
{
  const pts = ramp();
  const seg = (i) => Math.atan2(pts[i + 1].y - pts[i].y, -(pts[i + 1].z - pts[i].z)) * R2D;
  const exit = seg(pts.length - 2);
  ok(exit > 95, "it finishes past vertical — that is what sends the car back", `${exit.toFixed(0)}°`);
  ok(pts[pts.length - 1].y > 15, "it is a tall ramp", `${pts[pts.length - 1].y.toFixed(1)} m`);

  // There must be a genuinely STRAIGHT run in the middle: that is the whole
  // difference between this and the constant-radius curl it replaced, which
  // kept turning from the first metre to the last and read as a loop.
  let longestFlat = 0, cur = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    if (Math.abs(seg(i) - seg(i - 1)) < 0.15) cur++; else cur = 0;
    longestFlat = Math.max(longestFlat, cur);
  }
  ok(longestFlat > 6, "…with a straight face in the middle, not a curve all the way",
    `${longestFlat} steps of constant angle`);

  // …and the curve is at the END: the last quarter turns more per step than the
  // middle does.
  const rate = (a, b) => Math.abs(seg(b) - seg(a)) / (b - a);
  const mid = rate(Math.floor(pts.length * 0.45), Math.floor(pts.length * 0.6));
  const end = rate(Math.floor(pts.length * 0.8), pts.length - 2);
  ok(end > mid, "…and the curve is at the END, not spread through it",
    `${end.toFixed(2)}°/step at the top vs ${mid.toFixed(2)} in the middle`);

  ok(FOLLOW_ROAD.has("loopback"),
    "it is FOLLOW_ROAD — road hold plants the car on the face, and it gates the flip");
}

/* ── 2. Back the way it came, turning over smoothly ──────────────────────── */
console.log("\n=== 2. IT REVERSES, AND THE TURN IS ONE CONTINUOUS MOVEMENT ===");
{
  const runs = [26, 32, 38].map((v) => ({ v, r: run({ speed: v }) }));
  for (const { v, r } of runs) {
    row(`in @${v} m/s`, r);
    ok(r.exitVz > 1, `@${v}: leaves travelling BACK the way it came`, `vz ${r.exitVz.toFixed(1)} m/s`);
    ok(r.minUp < -0.9, `@${v}: turns fully upside down`, `minUp ${r.minUp.toFixed(2)}`);
    // The launch must not reverse through zero — that is the visible kick.
    ok(r.firstRate > 0.3 && r.worstBack > -0.2,
      `@${v}: already turning the right way at the lip, and never backwards`,
      `first ${r.firstRate.toFixed(2)}, worst ${r.worstBack.toFixed(2)} rad/s`);
    ok(r.invertedAt !== null && r.invertedAt < 1.2,
      `@${v}: over within a second — no vertical hang`,
      r.invertedAt === null ? "never inverted" : `${r.invertedAt.toFixed(2)} s`);
    ok(r.hungVertical < 0.35, `@${v}: barely any time on its nose`,
      `${r.hungVertical.toFixed(2)} s`);
    ok(r.back > 0, `@${v}: flies back out over the road it arrived on`, `z ${r.back.toFixed(0)}`);
  }
}

/* ── 3. It stops at inverted, and stays there ───────────────────────────── */
console.log("\n=== 3. ONE HALF-TURN, THEN IT HOLDS ===");
{
  const r = run({});
  ok(r.lateRate < 0.35,
    "the rotation is over by mid-flight — it does not keep flipping",
    `${r.lateRate.toFixed(2)} rad/s after 2.5 s`);
  ok(Math.abs(r.spin) < 260,
    "…and the whole flight is about one half-turn, not a tumble", `${r.spin.toFixed(0)}°`);
}

/* ── 4. Which half is the ramp and which is the vehicle ─────────────────── */
console.log("\n=== 4. THE SHAPE REVERSES IT; THE VEHICLE TURNS IT OVER ===");
{
  const base = run({});
  const noFlip = run({ assists: { rampFlipMaxRate: 0 } });
  row("as shipped", base);
  row("flip disabled", noFlip);
  ok(noFlip.exitVz > 1,
    "with the flip off it STILL comes back — the reversal is pure geometry",
    `vz ${noFlip.exitVz.toFixed(1)} m/s`);
  ok(Math.abs(noFlip.peak - base.peak) < 4,
    "…and reaches the same height", `${noFlip.peak.toFixed(0)} m vs ${base.peak.toFixed(0)} m`);
  ok(noFlip.invertedAt === null || noFlip.invertedAt > base.invertedAt + 0.5,
    "but it does not turn over on its own — that half is the vehicle's",
    `${noFlip.invertedAt === null ? "never" : noFlip.invertedAt.toFixed(2) + "s"} vs ${base.invertedAt.toFixed(2)}s`);
}

/* ── 5. Nothing else in the kit can reach the flip ──────────────────────── */
console.log("\n=== 5. THE FLIP CANNOT TOUCH ANY OTHER PIECE ===");
{
  for (const id of ["jump", "dive", "loop", "loop_half", "quarterpipe", "half_pipe", "twist", "gap"]) {
    if (!PIECE_BY_ID.has(id)) continue;
    ok(!FOLLOW_ROAD.has(id), `${id} is not FOLLOW_ROAD, so its launches are never considered`);
  }
  const arc = ramp();
  const d = new RoadBvh();
  d.bakeFromMeshes([ribbon([{ y: 0, z: RUNUP }, { y: 0, z: 0 }], false), ribbon(arc, false)]);
  const g = createVehicleGround({ getTerrainHeight: () => -1e4 });
  g.setRoadBvh(d);
  const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  c.groundBvh = g.ground; c.solidsBvh = g.solids;
  c.getFloorY = () => -1e4; c.enabled = true;
  c.body.pos.set(0, WHEEL.radius + 0.18, 40);
  c.body.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
  c.body.vel.set(0, 0, -30);
  let hold = null;
  for (let i = 0; i < Math.round(12 / FIXED_DT); i++) {
    c.tick({ steerTarget: 0, throttle: 1, handbrake: false, yaw: 0, pitch: 0, airSteer: 0 });
    if (c.groundedCount === 0 && c.body.pos.y > arc[arc.length - 1].y - 3) { hold = c._flipHold; break; }
  }
  ok(hold === 0, "the same ramp WITHOUT the road-hold tag flips nothing", `flipHold ${hold}`);
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
