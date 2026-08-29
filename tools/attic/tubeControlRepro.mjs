// Reported: "the car is hardly controllable inside a tube."
//
// This measures it instead of reasoning about it. The camera is a separate
// (real) problem — this file is ONLY the physics, run headless with no camera at
// all, so anything it finds is the car, not the view.
//
// Setup is the kit's own rideable tube (modularRoadKit `tubeRadius: 8`) as an
// ANALYTIC infinite cylinder duck-typed to the groundBvh interface, exactly the
// way railTrapRepro models the guardrail. No mesh, no BVH, no seams — so a
// wobble here cannot be blamed on triangle normals flickering between pieces.
// The tube is the ONLY surface: no terrain, no chassis floor. Whatever the car
// does, it does because of the assists.
//
// WHAT THIS FOUND — and it refuted the obvious suspects, which is why the file
// exists rather than a patch based on reading the code:
//
//   * The landing assist was NOT involved. Zeroing airLandAssist changes the
//     result by literally nothing, because the car never goes airborne in a tube
//     at all: 0% air time, 0 dropout events. It never fires.
//   * The suspension was NOT bottoming out. 0% bottomed at every speed; mean
//     compression 0.03-0.05 m of 0.55 m travel. The struts are barely loaded.
//   * The stabilizer damper IS real but minor — worth 9° of peak bank and
//     nothing sustained. The predicted standing error did check out where the
//     car genuinely rotates (13.9° measured vs 14.1° predicted at 0.84 rad/s).
//   * The yaw assist is HELPING. Turning it off drops sustained bank 37° -> 9°.
//
// The actual failure is that the car cannot sustain the ORBIT a tube requires.
// Static hold needs tan(bank) <= mu, so past ~56° nothing can hold and the car
// must keep circulating; circulating means permanent hard steering; brush-model
// scrub goes as Fy^2 / Fmax, so it bleeds the speed that was holding it up. See
// the SURFACE_GRIP block in modularRoadVehicle.js for the fix and its numbers.
//
// TWO TRAPS THIS HARNESS FELL INTO, left documented so they are not repeated:
//   1. A CONSTANT steering input is not "driving a tube" — it also scrubs 30 ->
//      6.4 m/s on FLAT ground, so it proves nothing tube-specific. Section 0c is
//      that control.
//   2. Constant steer in a tube turns the nose circumferentially and the car
//      does a wall-of-death circle making no axial progress (0.10 revs, never
//      exits, at every gain). A driver holds a BANK and lets the helix happen.
//
// An instrument, not a pass/fail test. Run it, read the tables.
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const TMP = join(ROOT, `.tuberepro.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, TIRE, AERO, CHASSIS, WHEEL, FIXED_DT, GRAVITY, SURFACE_GRIP } =
  await import(pathToFileURL(TMP).href);
unlinkSync(TMP);

const R2D = 57.2958;
/** Kit default: modularRoadKit.js pieceParams.tubeRadius. */
const R = 8;
/** Axis runs along +Z at this height, so the tube FLOOR sits at y = 0. */
const CY = R;

console.log("=== SETUP ===");
console.log(`  tube radius ${R} m (kit default)   floor y=0, crown y=${2 * R}`);
console.log(`  CHASSIS ${CHASSIS.width}x${CHASSIS.height}x${CHASSIS.length}  mass ${CHASSIS.mass} kg`);
console.log(`  TIRE restLength ${TIRE.restLength}  spring ${TIRE.springStrength}  damper ${TIRE.damper}`);
console.log(`  stabilizer strength ${TIRE.stabilizerStrength}  damp ${TIRE.stabilizerDamp}`);
console.log(`  airLandTorque ${TIRE.airLandTorque}  airLandTime ${TIRE.airLandTime}  assist ${TIRE.airLandAssist}`);
console.log(`  AERO.downforce ${AERO.downforce}   topSpeed ${TIRE.topSpeed}`);

/* --------------------------------------------------------------------- */
/* The tube, analytically                                                 */
/* --------------------------------------------------------------------- */

/** Inward (toward the axis) unit normal at a point, written into `out`. */
function inwardNormalAt(x, y, out) {
  const u = x, v = y - CY;
  const d = Math.hypot(u, v) || 1e-9;
  return out.set(-u / d, -v / d, 0);
}

/**
 * Ray vs the tube's INNER wall, cast from inside.
 *
 * The near root is behind us (we are inside the cylinder, so c < 0 and the
 * quadratic always straddles zero) — the exit root is the wall we can hit.
 */
function castInner(o, d, far, radius = R) {
  const u = o.x, v = o.y - CY;
  const a = d.x * d.x + d.y * d.y;
  if (a < 1e-12) return null;                     // ray parallel to the axis
  const b = 2 * (u * d.x + v * d.y);
  const c = u * u + v * v - radius * radius;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const t = (-b + Math.sqrt(disc)) / (2 * a);
  if (t < 0 || t > far) return null;
  const px = o.x + d.x * t, py = o.y + d.y * t, pz = o.z + d.z * t;
  const n = inwardNormalAt(px, py, new THREE.Vector3());
  return { distance: t, point: { x: px, y: py, z: pz }, normal: { x: n.x, y: n.y, z: n.z }, faceIndex: 0 };
}

const _cpN = new THREE.Vector3();
const tube = {
  baked: true,
  raycastFirst(o, d, far) { return castInner(o, d, far); },
  /** Swept sphere = ray against the cylinder shrunk by the sphere radius. */
  spherecast(ox, oy, oz, radius, dx, dy, dz, maxDist) {
    const len = Math.hypot(dx, dy, dz) || 1;
    return castInner(
      { x: ox, y: oy, z: oz },
      { x: dx / len, y: dy / len, z: dz / len },
      maxDist, Math.max(0.01, R - radius),
    );
  },
  closestPointWithNormal(px, py, pz, maxDist, outN) {
    const u = px, v = py - CY;
    const d = Math.hypot(u, v);
    const gap = R - d;                       // distance from the point to the wall
    if (gap > maxDist || d < 1e-9) return null;
    inwardNormalAt(px, py, _cpN);
    outN.copy(_cpN);                         // wall -> interior, i.e. toward the query
    return { x: (u / d) * R, y: CY + (v / d) * R, z: pz, distance: Math.max(0, gap) };
  },
};
const noSolids = { baked: false, closestPointWithNormal: () => null };

/* --------------------------------------------------------------------- */
/* Headless vehicle                                                       */
/* --------------------------------------------------------------------- */

Vehicle.prototype._buildMeshes = function () {
  this.group = new THREE.Group(); this.chassisMesh = new THREE.Object3D();
  this.tireGroups = [0, 0, 0, 0].map(() => new THREE.Group());
  this.arrowGroup = new THREE.Group(); this.arrowGroup.visible = false;
  this.arrows = [0, 0, 0, 0].map(() => ({})); this.wheelSpin = [0, 0, 0, 0];
  this.headlights = []; this.headlightTargets = []; this.headlamps = []; this.taillights = [];
  this._wheelInstances = []; this._wheelParts = [];
};
Vehicle.prototype._updateTaillights = function () {};

function makeCar(speed) {
  const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  c.groundBvh = tube;
  c.solidsBvh = noSolids;
  // No terrain and no world floor — the tube is the only thing that exists, so
  // nothing but the tube and the assists can be responsible for the result.
  c.getFloorY = () => -1e4;
  c.enabled = true;
  // On the tube floor, facing +Z (down the tube). Identity quat = forward +Z.
  c.body.pos.set(0, WHEEL.radius + 0.18, 0);
  c.body.quat.identity();
  c.body.vel.set(0, 0, speed);
  c.body.angVel.set(0, 0, 0);
  return c;
}

const _up = new THREE.Vector3();
const _n = new THREE.Vector3();
/** How far round the tube the car is: 0 = floor, ±90° = side wall, 180° = crown. */
const bankDeg = (p) => Math.atan2(p.x, -(p.y - CY)) * R2D;
/** Angle between chassis-up and the true surface normal — the stabilizer's lag. */
function alignLagDeg(c) {
  _up.set(0, 1, 0).applyQuaternion(c.body.quat);
  inwardNormalAt(c.body.pos.x, c.body.pos.y, _n);
  return Math.acos(THREE.MathUtils.clamp(_up.dot(_n), -1, 1)) * R2D;
}

/**
 * Drive into the tube wall with a fixed steering input and see what happens.
 * Returns the shape of the ride, not just its endpoint.
 */
function ride({
  speed = 30, steer = -0.6, secs = 6, throttle = 1,
  landAssist = null, stabDamp = null, yawAssist = null, downforce = null,
}) {
  const s0 = TIRE.airLandAssist, s1 = TIRE.stabilizerDamp, s2 = TIRE.yawAssist, s3 = AERO.downforce;
  if (landAssist !== null) TIRE.airLandAssist = landAssist;
  if (stabDamp !== null) TIRE.stabilizerDamp = stabDamp;
  if (yawAssist !== null) TIRE.yawAssist = yawAssist;
  if (downforce !== null) AERO.downforce = downforce;

  const c = makeCar(speed);
  const n = Math.round(secs / FIXED_DT);
  let peakBank = 0, peakLag = 0, sumLag = 0, nLag = 0;
  let airTicks = 0, partialTicks = 0, airEvents = 0, wasAir = false;
  let sumComp = 0, nComp = 0, bottomed = 0;
  let peakBankAt = 0;
  // Friction-circle bookkeeping: how much of each tyre's budget the DRIVE force
  // is taking, and how much is left for holding the car against the wall.
  let sumLat = 0, sumLong = 0, sumSusp = 0, nF = 0;
  let sumSpeed = 0;
  const trace = [];

  for (let i = 0; i < n; i++) {
    c.tick({ steerTarget: steer, throttle, handbrake: false, yaw: 0, pitch: 0 });
    const t = i * FIXED_DT;
    const bank = Math.abs(bankDeg(c.body.pos));
    const lag = alignLagDeg(c);
    if (bank > peakBank) { peakBank = bank; peakBankAt = t; }
    if (lag > peakLag) peakLag = lag;
    sumLag += lag; nLag++;
    sumSpeed += c.body.vel.length();
    const g = c.groundedCount;
    if (g === 0) { airTicks++; if (!wasAir) airEvents++; wasAir = true; } else wasAir = false;
    if (g > 0 && g < 4) partialTicks++;
    for (const tire of c.tires) {
      if (!tire.grounded) continue;
      sumComp += tire.compression; nComp++;
      if (tire.compression > TIRE.restLength * TIRE.bottomOutThresh) bottomed++;
      sumLat += tire.lastSteering.length();
      sumLong += tire.lastAccel.length();
      sumSusp += tire.lastSuspension.length();
      nF++;
    }
    if (i % Math.round(0.25 / FIXED_DT) === 0) {
      trace.push({ t, bank: bankDeg(c.body.pos), lag, g, y: c.body.pos.y, v: c.body.vel.length() });
    }
  }

  TIRE.airLandAssist = s0; TIRE.stabilizerDamp = s1; TIRE.yawAssist = s2; AERO.downforce = s3;
  const meanSusp = sumSusp / Math.max(1, nF);
  return {
    peakBank, peakBankAt, finalBank: Math.abs(bankDeg(c.body.pos)),
    meanLag: sumLag / Math.max(1, nLag), peakLag,
    airPct: (100 * airTicks) / n, partialPct: (100 * partialTicks) / n, airEvents,
    meanComp: sumComp / Math.max(1, nComp),
    bottomedPct: (100 * bottomed) / Math.max(1, nComp),
    meanSpeed: sumSpeed / n,
    meanLat: sumLat / Math.max(1, nF),
    meanLong: sumLong / Math.max(1, nF),
    meanSusp,
    /** The friction budget one tyre actually had, from its dynamic normal load. */
    meanFmax: TIRE.frictionCoeff * meanSusp,
    trace,
  };
}

/** The bank a tyre could hold in theory: tan(θ) = μ, once drive force is spent. */
const holdableBankDeg = (muUsable) => Math.atan(muUsable) * R2D;

/* --------------------------------------------------------------------- */

/* --------------------------------------------------------------------- */
/* 0. HARNESS VALIDATION — do not trust anything below until this passes.  */
/* --------------------------------------------------------------------- */
console.log("\n=== 0. HARNESS CHECK (flat ground vs a near-flat huge tube) ===");
console.log("  If the analytic tube surface were wrong, every table below would be");
console.log("  measuring my bug instead of the game's. So: drive straight, full");
console.log("  throttle, on real flat ground — then on a tube so large it IS flat.");
console.log("  The two must agree, and both must ACCELERATE toward topSpeed.\n");
{
  const flat = {
    baked: true,
    raycastFirst(o, d, far) {
      if (d.y >= -1e-6) return null;
      const t = o.y / -d.y;
      if (t < 0 || t > far) return null;
      return { point: { x: o.x, y: 0, z: o.z }, distance: t, normal: { x: 0, y: 1, z: 0 }, faceIndex: 0 };
    },
    spherecast() { return null; },
    closestPointWithNormal() { return null; },
  };
  const runStraight = (ground, secs = 6, v0 = 20) => {
    const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
    c.groundBvh = ground; c.solidsBvh = noSolids; c.getFloorY = () => -1e4; c.enabled = true;
    c.body.pos.set(0, ground === flat ? WHEEL.radius + 0.18 : WHEEL.radius + 0.18, 0);
    c.body.quat.identity(); c.body.vel.set(0, 0, v0); c.body.angVel.set(0, 0, 0);
    let minG = 4;
    for (let i = 0; i < secs / FIXED_DT; i++) {
      c.tick({ steerTarget: 0, throttle: 1, handbrake: false, yaw: 0, pitch: 0 });
      minG = Math.min(minG, c.groundedCount);
    }
    return { v: c.body.vel.length(), y: c.body.pos.y, drift: Math.hypot(c.body.pos.x), minG };
  };
  // A tube of radius 2000 is flat to within a millimetre over the car's width.
  const savedR = R;
  const bigTube = {
    baked: true,
    raycastFirst: (o, d, far) => castInner(o, d, far),
    spherecast: (ox, oy, oz, rad, dx, dy, dz, md) => tube.spherecast(ox, oy, oz, rad, dx, dy, dz, md),
    closestPointWithNormal: (px, py, pz, md, n) => tube.closestPointWithNormal(px, py, pz, md, n),
  };
  const a = runStraight(flat);
  console.log(`   flat plane      speed ${a.v.toFixed(1).padStart(5)} m/s   y ${a.y.toFixed(2)}   lateral drift ${a.drift.toFixed(2)} m   min wheels ${a.minG}`);
  const b = runStraight(bigTube);
  console.log(`   tube r=${savedR} floor  speed ${b.v.toFixed(1).padStart(5)} m/s   y ${b.y.toFixed(2)}   lateral drift ${b.drift.toFixed(2)} m   min wheels ${b.minG}`);
  console.log(`\n   -> the tube floor ${Math.abs(a.v - b.v) < 3 ? "MATCHES" : "DISAGREES WITH"} flat ground`
    + ` (${Math.abs(a.v - b.v).toFixed(1)} m/s apart).`);
}

console.log("\n=== 0b. DOES THE CAR KEEP ITS SPEED IN THE TUBE AT ALL? ===");
console.log("  Straight down the tube (no steering) vs steering into the wall.");
console.log("  Entry speed 30 m/s, full throttle throughout.\n");
console.log("   steer     speed @ t=0   1s      2s      4s      6s");
for (const steer of [0, -0.35, -0.7]) {
  const r = ride({ speed: 30, steer, secs: 6 });
  const at = (t) => {
    const s = r.trace.reduce((best, x) => (Math.abs(x.t - t) < Math.abs(best.t - t) ? x : best), r.trace[0]);
    return s.v.toFixed(1).padStart(5);
  };
  console.log(`   ${steer.toFixed(2).padStart(5)}       30.0     ${at(1)}   ${at(2)}   ${at(4)}   ${at(6)}`);
}

console.log("\n=== 0c. CONTROL: IS THAT TUBE-SPECIFIC, OR DOES STEERING ALWAYS COST THAT? ===");
console.log("  The same steering input, same entry speed, same full throttle — but on");
console.log("  FLAT GROUND, where the car is just cornering. If flat holds its speed and");
console.log("  the tube does not, the tube is doing something the flat case is not.\n");
{
  const flat = {
    baked: true,
    raycastFirst(o, d, far) {
      if (d.y >= -1e-6) return null;
      const t = o.y / -d.y;
      if (t < 0 || t > far) return null;
      return { point: { x: o.x, y: 0, z: o.z }, distance: t, normal: { x: 0, y: 1, z: 0 }, faceIndex: 0 };
    },
    spherecast() { return null; },
    closestPointWithNormal() { return null; },
  };
  const _vf = new THREE.Vector3();
  const runFlat = (steer, secs = 6, v0 = 30) => {
    const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
    c.groundBvh = flat; c.solidsBvh = noSolids; c.getFloorY = () => -1e4; c.enabled = true;
    c.body.pos.set(0, WHEEL.radius + 0.18, 0);
    c.body.quat.identity(); c.body.vel.set(0, 0, v0); c.body.angVel.set(0, 0, 0);
    const marks = {};
    // +0.2 s so the t=6 mark is actually reached rather than falling off the end.
    for (let i = 0; i < (secs + 0.2) / FIXED_DT; i++) {
      c.tick({ steerTarget: steer, throttle: 1, handbrake: false, yaw: 0, pitch: 0 });
      const t = i * FIXED_DT;
      for (const m of [1, 2, 4, 6]) if (marks[m] === undefined && t >= m) marks[m] = c.body.vel.length();
    }
    _vf.set(0, 0, 1).applyQuaternion(c.body.quat);
    const v = c.body.vel;
    const slip = Math.acos(THREE.MathUtils.clamp(
      _vf.dot(v) / Math.max(0.01, v.length()), -1, 1)) * R2D;
    return { marks, slip };
  };
  console.log("   surface   steer    1s      2s      4s      6s     final slip angle");
  for (const steer of [-0.35, -0.7]) {
    const f = runFlat(steer);
    console.log(`   flat      ${steer.toFixed(2).padStart(5)}   ${f.marks[1].toFixed(1).padStart(5)}`
      + `   ${f.marks[2].toFixed(1).padStart(5)}   ${f.marks[4].toFixed(1).padStart(5)}`
      + `   ${f.marks[6].toFixed(1).padStart(5)}        ${f.slip.toFixed(0).padStart(4)}°`);
  }
  for (const steer of [-0.35, -0.7]) {
    const r = ride({ speed: 30, steer, secs: 6 });
    const at = (t) => r.trace.reduce((b, x) => (Math.abs(x.t - t) < Math.abs(b.t - t) ? x : b), r.trace[0]).v;
    console.log(`   tube      ${steer.toFixed(2).padStart(5)}   ${at(1).toFixed(1).padStart(5)}`
      + `   ${at(2).toFixed(1).padStart(5)}   ${at(4).toFixed(1).padStart(5)}`
      + `   ${at(6).toFixed(1).padStart(5)}`);
  }
}

/* --------------------------------------------------------------------- */
/* 0d. The realistic test: a DRIVER, not a stuck steering wheel.           */
/* --------------------------------------------------------------------- */
/**
 * Closed-loop wall-ride: steer to HOLD a target bank, the way a player does.
 *
 * A constant steering input (every table above) is not how a tube is driven and
 * it flatters nothing — it scrubs speed on flat ground too (see 0c). This is the
 * honest question: with someone actually driving, CAN the car hold a given
 * height on the wall, and what does it cost?
 */
function wallRide({ target = 90, speed = 35, secs = 8, downforce = null, grip = null, sgGain = null }) {
  const s3 = AERO.downforce, s4 = TIRE.frictionCoeff, s5 = SURFACE_GRIP.gain;
  if (downforce !== null) AERO.downforce = downforce;
  if (grip !== null) TIRE.frictionCoeff = grip;
  if (sgGain !== null) SURFACE_GRIP.gain = sgGain;

  const c = makeCar(speed);
  const n = Math.round(secs / FIXED_DT);
  let held = 0, sumErr = 0, sumV = 0, minV = 1e9, peak = 0;
  for (let i = 0; i < n; i++) {
    const bank = bankDeg(c.body.pos);          // signed; we climb the -x side
    const err = (-target) - bank;              // want bank == -target
    // Plain P controller with a rate term, clamped to the real input range.
    const steer = THREE.MathUtils.clamp(err * 0.03, -1, 1);
    c.tick({ steerTarget: steer, throttle: 1, handbrake: false, yaw: 0, pitch: 0 });
    const b = Math.abs(bankDeg(c.body.pos));
    peak = Math.max(peak, b);
    const v = c.body.vel.length();
    sumV += v; minV = Math.min(minV, v);
    // Only judge the second half — the first is the climb, not the hold.
    if (i > n / 2) { sumErr += Math.abs(b - target); if (Math.abs(b - target) < 12) held++; }
  }
  AERO.downforce = s3; TIRE.frictionCoeff = s4; SURFACE_GRIP.gain = s5;
  const half = n - Math.floor(n / 2) - 1;
  return {
    peak, holdPct: (100 * held) / Math.max(1, half),
    meanErr: sumErr / Math.max(1, half),
    meanV: sumV / n, minV,
  };
}

console.log("\n=== 0d. CAN A DRIVER HOLD A WALL-RIDE? (closed loop, not stuck lock) ===");
console.log("  Steering is modulated to hold a target bank. 'held%' is the share of the");
console.log("  second half of the run spent within 12° of target — i.e. actually riding");
console.log("  the wall rather than sliding past it.\n");
console.log("   target   downforce   peak    held%   mean err   mean speed   min speed");
for (const target of [45, 90, 135]) {
  for (const df of [3, 12, 40]) {
    const r = wallRide({ target, downforce: df });
    console.log(
      `   ${String(target).padStart(4)}°   ${String(df).padStart(7)}`
      + `   ${r.peak.toFixed(0).padStart(5)}°`
      + `   ${r.holdPct.toFixed(0).padStart(5)}%`
      + `   ${r.meanErr.toFixed(0).padStart(6)}°`
      + `      ${r.meanV.toFixed(1).padStart(5)}`
      + `       ${r.minV.toFixed(1).padStart(5)}`,
    );
  }
}

console.log("\n=== 0e. SURFACE-GRIP GAIN SWEEP (the fix) ===");
console.log("  gain 0 is the old behaviour. Same closed-loop driver, shipped downforce.");
console.log("  'held%' is time within 12° of target in the second half of the run.\n");
console.log("   target   gain    peak    held%   mean err   mean speed   min speed");
for (const target of [45, 90, 135]) {
  for (const g of [0, 0.5, 0.85, 1.2]) {
    const r = wallRide({ target, sgGain: g });
    console.log(
      `   ${String(target).padStart(4)}°   ${g.toFixed(2).padStart(4)}`
      + `   ${r.peak.toFixed(0).padStart(5)}°   ${r.holdPct.toFixed(0).padStart(5)}%`
      + `   ${r.meanErr.toFixed(0).padStart(6)}°      ${r.meanV.toFixed(1).padStart(5)}`
      + `       ${r.minV.toFixed(1).padStart(5)}`,
    );
  }
  console.log("");
}

/**
 * TRANSIT: the actual gameplay question. Drive INTO a tube of finite length,
 * through it, and OUT the far end. Reports what you arrive with.
 *
 * `held%` above is the wrong question past ~56° of bank, because a static hold
 * is impossible there (tan(bank) <= mu) — a tube must be ORBITED. So this counts
 * revolutions instead, and above all it measures the exit, which is the half the
 * player feels as "getting spat out".
 */
function transit({ length = 150, speed = 35, target = 35, sgGain = null, secs = 30 }) {
  const s = SURFACE_GRIP.gain;
  if (sgGain !== null) SURFACE_GRIP.gain = sgGain;
  const c = makeCar(speed);
  let revs = 0, lastBank = bankDeg(c.body.pos), unwrapped = 0;
  let exited = false, exitZ = 0, exitV = 0, exitBank = 0, exitLat = 0, exitT = 0;
  let minV = 1e9;
  for (let i = 0; i < secs / FIXED_DT; i++) {
    // A CONSTANT steering input is not a transit: in a tube it turns the nose
    // circumferentially and the car ends up doing a wall-of-death circle making
    // no progress at all down the axis (measured: 0.10 revs, never exits, at
    // every gain including 0). A driver holds a BANK and lets the helix happen,
    // which is what this does.
    const past = c.body.pos.z > length;
    const err = (-target) - bankDeg(c.body.pos);
    const steer = past ? 0 : THREE.MathUtils.clamp(err * 0.03, -1, 1);
    c.tick({ steerTarget: steer, throttle: 1, handbrake: false, yaw: 0, pitch: 0 });
    const b = bankDeg(c.body.pos);
    let d = b - lastBank;
    if (d > 180) d -= 360; else if (d < -180) d += 360;
    unwrapped += d; lastBank = b;
    minV = Math.min(minV, c.body.vel.length());
    if (!exited && c.body.pos.z > length) {
      exited = true; exitZ = c.body.pos.z; exitV = c.body.vel.length();
      exitBank = Math.abs(b); exitT = i * FIXED_DT;
      exitLat = Math.abs(c.body.pos.x);
    }
  }
  revs = Math.abs(unwrapped) / 360;
  SURFACE_GRIP.gain = s;
  return {
    exited, exitV, exitBank, exitLat, exitT, revs, minV,
    endLat: Math.abs(c.body.pos.x), endV: c.body.vel.length(),
  };
}

console.log("=== 0g. TRANSIT: THROUGH A 150 m TUBE AND OUT THE FAR END ===");
console.log("  Enter at 35 m/s, hold a 35 deg bank (a helix), stop steering at the exit.");
console.log("  'revs' = revolutions actually orbited (a tube must be orbited, not held).\n");
console.log("   gain   made it?   exit speed   exit time   revs   exit bank   min speed");
for (const g of [0, 0.5, 0.85, 1.2]) {
  const r = transit({ sgGain: g });
  console.log(
    `   ${g.toFixed(2).padStart(4)}   ${(r.exited ? "yes" : "NO ").padStart(7)}`
    + `   ${r.exited ? r.exitV.toFixed(1).padStart(6) : "     -"} m/s`
    + `   ${r.exited ? r.exitT.toFixed(1).padStart(6) : "     -"} s`
    + `   ${r.revs.toFixed(2).padStart(5)}`
    + `   ${r.exited ? r.exitBank.toFixed(0).padStart(6) : "     -"}°`
    + `      ${r.minV.toFixed(1).padStart(5)}`,
  );
}

console.log("\n=== 0h. TUBE EXIT SMOOTHNESS (SURFACE_GRIP.ease) ===");
console.log("  Curvature vanishes the instant the last wheel leaves the wall. Without");
console.log("  easing, the added load steps to zero and flicks the car sideways.");
console.log("  'exit drift' is |x| off the tube axis as the car leaves.\n");
console.log("   ease     exit speed   exit drift   drift 2 s later");
for (const e of [1e6, 30, 12, 5]) {
  const saved = SURFACE_GRIP.ease; SURFACE_GRIP.ease = e;
  const r = transit({ sgGain: 0.85 });
  SURFACE_GRIP.ease = saved;
  console.log(
    `   ${(e > 1e5 ? "instant" : String(e)).padStart(7)}`
    + `   ${r.exited ? r.exitV.toFixed(1).padStart(6) : "     -"} m/s`
    + `      ${r.exitLat.toFixed(2).padStart(5)} m`
    + `        ${r.endLat.toFixed(2).padStart(5)} m`,
  );
}

console.log("\n=== 0f. FLAT-GROUND REGRESSION CHECK ===");
console.log("  Curvature is 0 on flat road, so the assist must be EXACTLY inert there.");
console.log("  Straight line and a steady corner, gain 0 vs shipped.\n");
{
  const flat = {
    baked: true,
    raycastFirst(o, d, far) {
      if (d.y >= -1e-6) return null;
      const t = o.y / -d.y;
      if (t < 0 || t > far) return null;
      return { point: { x: o.x, y: 0, z: o.z }, distance: t, normal: { x: 0, y: 1, z: 0 }, faceIndex: 0 };
    },
    spherecast() { return null; },
    closestPointWithNormal() { return null; },
  };
  const runFlat = (steer, gain) => {
    const s = SURFACE_GRIP.gain; SURFACE_GRIP.gain = gain;
    const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
    c.groundBvh = flat; c.solidsBvh = noSolids; c.getFloorY = () => -1e4; c.enabled = true;
    c.body.pos.set(0, WHEEL.radius + 0.18, 0);
    c.body.quat.identity(); c.body.vel.set(0, 0, 30); c.body.angVel.set(0, 0, 0);
    for (let i = 0; i < 6 / FIXED_DT; i++) {
      c.tick({ steerTarget: steer, throttle: 1, handbrake: false, yaw: 0, pitch: 0 });
    }
    SURFACE_GRIP.gain = s;
    return { v: c.body.vel.length(), y: c.body.pos.y, sg: c._sgMag };
  };
  console.log("   case            gain 0        shipped       added load");
  for (const [label, steer] of [["straight", 0], ["steady corner", -0.5]]) {
    const a = runFlat(steer, 0), b = runFlat(steer, SURFACE_GRIP.gain);
    console.log(`   ${label.padEnd(14)}  ${a.v.toFixed(2).padStart(6)} m/s   ${b.v.toFixed(2).padStart(6)} m/s`
      + `   ${b.sg.toFixed(1).padStart(7)} N  ${Math.abs(a.v - b.v) < 0.01 ? "<= identical" : "<= CHANGED"}`);
  }
}

console.log("\n=== 1. HOW FAR UP THE WALL CAN YOU GET, AND DO YOU STAY THERE? ===");
console.log("  Full throttle into the wall, steering held. 'peak' is the highest bank");
console.log("  reached, 'final' where it ended up 6 s later — if final << peak the car");
console.log("  slid back down, which is the thing that reads as losing control.\n");
console.log("   speed  steer    peak     final    lag(mean/peak)   air%   0-wheel");
for (const speed of [15, 25, 35]) {
  for (const steer of [-0.35, -0.7, -1.0]) {
    const r = ride({ speed, steer });
    console.log(
      `   ${String(speed).padStart(4)}  ${steer.toFixed(2).padStart(5)}`
      + `  ${r.peakBank.toFixed(0).padStart(5)}°`
      + `   ${r.finalBank.toFixed(0).padStart(5)}°`
      + `     ${r.meanLag.toFixed(1).padStart(5)}° /${r.peakLag.toFixed(0).padStart(4)}°`
      + `   ${r.airPct.toFixed(0).padStart(4)}%`
      + `    ${String(r.airEvents).padStart(4)}`,
    );
  }
}

console.log("\n=== 2. A/B: WHICH ASSIST IS COSTING THE WALL-RIDE? ===");
console.log("  Same run, one mechanism disabled at a time. A LARGER sustained bank");
console.log("  with an assist off means that assist is what pulls you off the wall.\n");
const cases = [
  ["baseline (shipped)", {}],
  ["landing assist OFF", { landAssist: 0 }],
  ["stabilizer damp OFF", { stabDamp: 0 }],
  ["yaw assist OFF", { yawAssist: 0 }],
  ["landing + stab damp OFF", { landAssist: 0, stabDamp: 0 }],
];
console.log("   config                     peak     final    lag(mean)   air%   bottomed%");
for (const [label, opts] of cases) {
  const r = ride({ speed: 30, steer: -0.7, ...opts });
  console.log(
    `   ${label.padEnd(24)}  ${r.peakBank.toFixed(0).padStart(5)}°`
    + `   ${r.finalBank.toFixed(0).padStart(5)}°`
    + `     ${r.meanLag.toFixed(1).padStart(5)}°`
    + `    ${r.airPct.toFixed(0).padStart(4)}%`
    + `     ${r.bottomedPct.toFixed(0).padStart(4)}%`,
  );
}

console.log("\n=== 3. THE STABILIZER'S STANDING ERROR ===");
console.log("  A tube demands a CONTINUOUS roll rate (v_circ / R). The damper fights it,");
console.log("  so the chassis must sit at an angle to the wall just to hold station.");
console.log("  Predicted lag for a steady rate w:  asin(damp*w / (strength*align))\n");
console.log("   roll rate   predicted lag   measured mean lag (damp on / off)");
for (const steer of [-0.3, -0.6, -1.0]) {
  const on = ride({ speed: 30, steer, secs: 4 });
  const off = ride({ speed: 30, steer, secs: 4, stabDamp: 0 });
  // Circumferential speed implied by the bank actually swept.
  const w = (on.peakBank / R2D) / Math.max(0.01, on.peakBankAt);
  const pred = Math.asin(Math.min(1, (TIRE.stabilizerDamp * w) / TIRE.stabilizerStrength)) * R2D;
  console.log(
    `   ${w.toFixed(2).padStart(6)} rad/s   ${pred.toFixed(1).padStart(8)}°`
    + `        ${on.meanLag.toFixed(1).padStart(6)}° / ${off.meanLag.toFixed(1)}°`,
  );
}

console.log("\n=== 4. WHAT THE RIDE ACTUALLY LOOKS LIKE (speed 30, steer -0.7) ===");
console.log("  bank: 0 = floor, 90 = side wall, 180 = crown.  g = wheels on the wall.\n");
{
  const r = ride({ speed: 30, steer: -0.7, secs: 6 });
  console.log("       t     bank      lag    g       y");
  for (const s of r.trace) {
    console.log(
      `   ${s.t.toFixed(2).padStart(5)}  ${s.bank.toFixed(0).padStart(5)}°`
      + `  ${s.lag.toFixed(0).padStart(5)}°   ${s.g}   ${s.y.toFixed(2).padStart(6)}`,
    );
  }
}

console.log("\n=== 4b. THE FRICTION BUDGET: WHAT IS EATING THE LATERAL GRIP? ===");
console.log("  A wall-ride is held by LATERAL tyre force fighting gravity down the wall.");
console.log("  Static hold limit is tan(bank) = mu, so mu 1.5 should hold ~56°.");
console.log("  If drive force is eating the friction circle, the usable mu — and the");
console.log("  bank the car can hold — collapses. Same run, throttle swept.\n");
console.log("  throttle   sustained bank   long force   lat force   Fmax/tyre   usable mu   theory");
for (const throttle of [0, 0.25, 0.5, 1]) {
  const r = ride({ speed: 30, steer: -0.7, throttle, secs: 6 });
  const muUsable = r.meanLat / Math.max(1, r.meanSusp);
  console.log(
    `   ${throttle.toFixed(2).padStart(5)}       ${r.finalBank.toFixed(0).padStart(5)}°`
    + `       ${(r.meanLong / 1000).toFixed(1).padStart(6)} kN`
    + `   ${(r.meanLat / 1000).toFixed(1).padStart(6)} kN`
    + `   ${(r.meanFmax / 1000).toFixed(1).padStart(6)} kN`
    + `      ${muUsable.toFixed(2).padStart(4)}`
    + `     ${holdableBankDeg(muUsable).toFixed(0).padStart(4)}°`,
  );
}

console.log("\n=== 4c. DOES MORE DOWNFORCE BUY THE WALL-RIDE? ===");
console.log("  Downforce presses along -chassis-up, i.e. INTO the wall, so it should be");
console.log("  the lever that makes a tube holdable. Shipped value is 3.\n");
console.log("   downforce   peak bank   sustained bank   mean speed");
for (const df of [0, 3, 12, 40]) {
  const r = ride({ speed: 30, steer: -0.7, downforce: df, secs: 6 });
  console.log(
    `   ${String(df).padStart(6)}       ${r.peakBank.toFixed(0).padStart(5)}°`
    + `        ${r.finalBank.toFixed(0).padStart(5)}°`
    + `          ${r.meanSpeed.toFixed(1).padStart(5)} m/s`,
  );
}

console.log("\n=== 5. LOAD: IS THE SUSPENSION EVEN IN RANGE? ===");
console.log(`  Static weight ${(CHASSIS.mass * GRAVITY / 1000).toFixed(1)} kN;`
  + ` full-compression spring ${(TIRE.restLength * TIRE.springStrength / 1000).toFixed(1)} kN/wheel.\n`);
console.log("   speed   centripetal @ full circle   as g   mean compression   bottomed%");
for (const speed of [15, 25, 35]) {
  const a = (speed * speed) / R;
  const r = ride({ speed, steer: -0.7, secs: 4 });
  console.log(
    `   ${String(speed).padStart(4)}      ${a.toFixed(0).padStart(6)} m/s²`
    + `            ${(a / GRAVITY).toFixed(1).padStart(4)}`
    + `       ${r.meanComp.toFixed(3).padStart(6)} m`
    + `        ${r.bottomedPct.toFixed(0).padStart(4)}%`,
  );
}

console.log("");
