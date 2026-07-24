import * as THREE from "three";
import { materialEmissive } from "three/tsl";
import { applyBloomMRT } from "../render/bloomMRT.js";

/**
 * VVV-pattern raycast vehicle — recreated (not imported) from the Lotus VVV
 * physics lab so it can be tuned independently. A 6-DOF rigid body with four
 * multi-ray wheel probes (tire ring + optional sphere sweep), oriented-box
 * chassis collision vs the solids BVH, deck contact for elevated track, and
 * surface-aligned stabilizer.
 *
 * All tuning lives in the exported mutable objects below; build a UI against
 * them and the changes take effect live. Dimension/mass edits need
 * `vehicle.rebuildBody()`.
 */

export const GRAVITY = 9.81;

/** Fixed physics tick (s). The sim only ever advances in whole ticks of this,
 *  so car behavior, lap times, and ghosts are framerate-independent. */
export const FIXED_DT = 1 / 120;

export const CHASSIS = {
  width: 1.8,
  height: 0.6,
  length: 3.6,
  mass: 1400,
  /** CoM offset from the collision-box center (+X right, +Y up, +Z front). */
  comX: 0,
  comY: 0,
  comZ: 0,
  /** Visual-only mesh lift along chassis-up (physics unchanged). */
  visualLift: 0,
};

/** Wheel hubs in chassis-local space. z>0 = front. */
export const WHEEL_LOCAL = [
  { name: "FL", pos: new THREE.Vector3(-1.05, -0.1, 1.4), steer: true, drive: true },
  { name: "FR", pos: new THREE.Vector3(1.05, -0.1, 1.4), steer: true, drive: true },
  { name: "RL", pos: new THREE.Vector3(-1.05, -0.1, -1.4), steer: false, drive: true },
  { name: "RR", pos: new THREE.Vector3(1.05, -0.1, -1.4), steer: false, drive: true },
];

/** Front↔rear hub separation (m). Derived from WHEEL_LOCAL so it follows any
 *  edit to the hub layout. Used by the yaw assist's bicycle-model reference
 *  yaw rate (ω = v·tan δ / L). */
const WHEELBASE = Math.abs(WHEEL_LOCAL[0].pos.z - WHEEL_LOCAL[2].pos.z);

export const TIRE = {
  rayLength: 1.0,
  rayPadAbove: 0.6,
  /** Legacy forward/lateral offsets — used only when rayRingCount < 3. */
  rayForwardBias: 0.6,
  rayLateralBias: 1.0,
  /** Rays around the bottom semicircle of the tire (longitudinal × vertical plane). */
  rayRingCount: 10,
  rayRingScale: 0.92, // × wheel radius
  /** Swept-sphere cast along the probe (catches ramp lips between discrete rays). */
  useSphereSweep: true,
  sphereSweepScale: 0.88, // × wheel radius
  suspVisSmooth: 12,
  restLength: 0.55,
  springStrength: 65000,
  damper: 6500,
  bottomOutThresh: 0.7,
  bottomOutMult: 8,
  // Per-axle friction multipliers (× frictionCoeff). Lower the rear for
  // oversteer, lower the front for understeer. Handbrake swaps the rear out.
  // Neutral front/rear balance. The rear used to run 1.1 because at topSpeed 80
  // the driven rear axle saturated its friction circle under power and the tail
  // walked — but that pressure went away with topSpeed 30, and rear-grippier-
  // than-front is precisely what produces terminal understeer with nothing to
  // catch it. The yaw assist now handles what the grip split used to paper over.
  gripFront: 1.0,
  gripRear: 1.0,
  gripHandbrake: 0.35,
  // Lateral slip model: force builds linearly with slip then saturates at the
  // friction circle. `tireStiffness` is the slope (≈ 1/peak-slip-angle); higher
  // = sharper, more grip before sliding. `lowSpeedRef` keeps slip well-defined
  // near standstill so the car doesn't jitter when parked.
  tireStiffness: 7.0,
  lowSpeedRef: 2.5,
  accelForce: 4000,
  // Sized to the TRACK KIT, not to the slider max. modularRoadKit's standard
  // curve is `curveRadius: 26` m, and peak lateral grip here is ~1.5 g
  // (frictionCoeff 1.5 × ~3.4 kN static wheel load × 4), so the fastest a curve
  // piece can physically be taken is √(26 × 14.7) ≈ 19.5 m/s. Loops need
  // ≥ √(g × loopRadius 25) ≈ 15.7 m/s to stay stuck at the top. That leaves a
  // usable window of roughly 20–35 m/s and 30 sits in it.
  //
  // The old default was 80 (the #dv-top slider max), which needed ~25 g to hold
  // a 26 m corner — unreachable by ANY slider, so every curve was a plow into
  // the guardrail. If you raise this, raise curveRadius to match: the minimum
  // radius the car can hold is v² / 14.7.
  topSpeed: 30,
  powerCurveExp: 2.0,
  brakeForce: 8000,
  reverseAccel: 2000,
  brakeReverseThreshold: 0.5,
  engineBrake: 800,
  maxSteerAngle: 0.55,

  // ── STEERING INPUT SHAPING ──────────────────────────────────────────────
  // A keyboard key is a binary switch, so the shape of the ramp between 0 and
  // full lock IS the steering feel. The old single symmetric rate
  // (`steerSmooth: 8`, ~125 ms in BOTH directions) is the classic mushy-keyboard
  // -car recipe: too slow to catch a slide, and equally slow to straighten out
  // of one. Splitting it three ways costs nothing and fixes both.
  /** Winding lock ON (1/s). The slowest of the three — this is the car's weight. */
  steerAttack: 7.0,
  /** Unwinding back toward centre (1/s). Straightening should feel immediate. */
  steerRelease: 12.0,
  /** Input flipped sign — a countersteer (1/s). Fastest: this is the input you
   *  make when the car is ALREADY sideways, where every millisecond counts. */
  steerCounter: 18.0,
  /** Analog-stick rate (1/s). A stick already IS the wheel position, so this is
   *  only a jitter filter — running analog input through the keyboard ramp adds
   *  lag the player can feel directly. */
  steerAnalogRate: 30.0,
  /** Fraction the ATTACK rate is cut by at `steerSpeedRef` and above, so the
   *  wheel gets heavier with speed. Returning to centre and the countersteer
   *  CROSSING are never slowed — they're the recovery inputs. (Once a
   *  countersteer has crossed centre it's winding lock on in the new direction,
   *  which is ordinary turn-in and does get the speed weighting.) */
  steerRateSpeedDrop: 0.3,
  // Speed-sensitive steering: the usable steer angle shrinks as speed rises so
  // the car isn't twitchy / spin-happy at the top end. At/above `steerSpeedRef`
  // (m/s) the angle is reduced by `steerSpeedReduce` (fraction).
  //
  // Back in scale with topSpeed 30: full reduction lands AT top speed, leaving
  // 0.55 × (1 − 0.5) ≈ 16° of lock there. A 26 m curve at 20 m/s only asks for
  // atan(2.8 / 26) ≈ 6°, so there's ample margin. The previous 50/0.45 pair was
  // stretched to cover an 80 m/s top end that no longer exists.
  steerSpeedRef: 26,
  steerSpeedReduce: 0.5,
  frictionCoeff: 1.5,
  maxAngVel: 9.0,
  // Contact-normal low-pass rate (1/s). ~55 ms time constant: at 30 m/s that
  // spans ~1.6 m of travel, which is one curve-piece segment — fast enough to
  // follow a real bank transition, slow enough to reject seam flicker between
  // adjacent pieces. 0 disables the filter. See the note in Tire.apply().
  normalSmooth: 18,

  // ── YAW ASSIST (arcade slip management) ─────────────────────────────────
  // The tire model alone has NO yaw damping on the ground — _applyStabilizer
  // deliberately strips the yaw component out, so the only thing resisting a
  // spin is lateral tire force. That makes the car understeer to the limit and
  // then snap, with nothing to catch it. This is the layer every arcade racer
  // has and a pure raycast sim doesn't: it keeps the slip angle inside a range
  // the player can actually drive, without making the car feel on-rails.
  //
  // Three terms, all torque about the SURFACE normal (so it works on banks and
  // inside loops, not just flat ground) — see _applyYawAssist().
  /** Master scale, 0..1. 0 = pure tire sim, no assist at all. */
  yawAssist: 1.0,
  /** Slip (rad) that gets NO assist — ordinary cornering must still feel like
   *  tires rather than magnets. ~4.6°. */
  alignDeadband: 0.08,
  /** N·m per rad of slip past the deadband: pulls the nose toward travel. */
  alignTorque: 12000,
  /** Slip (rad) past which the clamp ramps hard — you can drift up to here,
   *  but not rotate past what's recoverable. ~40°. */
  slipMax: 0.7,
  /** N·m per rad of slip past `slipMax`. */
  slipClampTorque: 30000,
  /** N·m per rad/s of yaw-rate ERROR vs what the steering is asking for. Damping
   *  the RAW yaw rate would fight the driver; damping only the error kills the
   *  pendulum overshoot and leaves the intended rotation alone. */
  yawRateDamp: 4000,
  /** Below this speed (m/s) slip angle is numerical noise — a parked car would
   *  get spun by it. */
  yawAssistMinSpeed: 2.0,
  /** Assist multiplier while the handbrake is down, so a deliberate drift still
   *  goes where you point it. The slip CLAMP is deliberately not scaled by this
   *  — drifting should not be able to become a full spin. */
  driftYawAssistMul: 0.25,
  // Anti-roll / orientation. When grounded the chassis aligns its up-axis to the
  // averaged ground normal (so it leans into banks and follows loops instead of
  // fighting toward world-up); `stabilizerDamp` damps the roll/pitch rate.
  stabilizerStrength: 9000,
  stabilizerDamp: 2600,
  // ── AIRBORNE CONTROL — RATE-BASED (W/S pitch, A/D roll, Q/E yaw) ────────
  //
  // Hold a direction and the car rotates AT `…Rate`; release and it stops. This
  // is what arcade stunt racers do, and it replaced a TORQUE model that was the
  // cause of the "uncontrollable spin after a flip" bug.
  //
  // Why torque was wrong. It applied a flat 5000 N·m to whichever axis you
  // pushed — but torque only becomes rotation after dividing by that axis's
  // inertia, and this chassis is wildly asymmetric: pitch 1554, yaw 1890,
  // ROLL 420 kg·m². So the same input gave 11.9 rad/s² of roll against 3.2 of
  // pitch — nearly 4× more authority on the weakest axis, purely by accident.
  // Worse, torque INTEGRATES: it never stopped adding, so a landing bounce with
  // steering held wound the car to 7 rad/s of roll and flipped it inverted.
  // (Measured: peak roll 7.00 rad/s, tilt 180°; with airControl forced to 0,
  // 0.09 rad/s and 1°.)
  //
  // A rate model is immune to both. You specify the RATE, so inertia cancels out
  // and every axis behaves the same; and it converges on a target instead of
  // accumulating, so holding an input longer can never wind up more rotation.
  /** Full-input rotation rates (rad/s). ~3.6 ⇒ a full flip in about 1.7 s. */
  airPitchRate: 3.6,
  airRollRate: 3.6,
  /** Yaw sits higher so a flat spin still reads as a deliberate trick. */
  airYawRate: 4.5,
  /** How fast the actual rate converges on the target (1/s). Higher = snappier
   *  and more digital; lower = floatier. This is the "air feel" knob. */
  airResponse: 9.0,
  /** Convergence toward ZERO on an axis with no input (1/s) — this is the tumble
   *  damping. Softer than `airResponse` so a knock still tumbles naturally
   *  instead of freezing the instant you let go. */
  airSettle: 2.0,
  /**
   * Lockout (s) after ANY wheel contact before air control may engage again.
   *
   * The old `airControlDelay` counted CONTINUOUS airborne time from zero, so a
   * landing bounce longer than it simply re-armed air control mid-bounce — which
   * is exactly the reported bug: land, hold steer, and the bounce rolls you
   * over. Timing from the last CONTACT instead means a bounce can never re-arm
   * it, however long it lasts, while a clean launch is airborne for well over
   * this and keeps full trick control.
   */
  airGroundLockout: 0.45,
  // ── LANDINGS ────────────────────────────────────────────────────────────
  // A jump-heavy track lives or dies on whether landings feel FAIR. Two separate
  // mechanisms — see _applyLandingAssist().
  //
  // (a) TOUCHDOWN ABSORPTION. Without it a hard landing dumps all its closing
  //     speed into the springs, hits the quadratic bottom-out (bottomOutMult)
  //     and pogos the car back into the air. Fires once on the airborne→grounded
  //     transition, so it's framerate-independent by construction: it's an event,
  //     not a per-second rate.
  /** Fraction of the into-surface closing speed removed on touchdown. */
  landingAbsorb: 0.55,
  /** Closing speed (m/s) below which touchdown is left completely alone —
   *  ordinary driving over bumps and kerbs must not be touched. */
  landingMinSpeed: 6.0,
  /** Fraction of the pitch/roll RATE killed on touchdown. Yaw is deliberately
   *  untouched, so landing mid-spin still carries the spin. */
  landingAngDamp: 0.4,
  //
  // (b) PREDICTIVE ALIGNMENT. While falling, look ahead down the flight path and
  //     ease the chassis' up-axis toward the surface it's about to hit. This is
  //     what stops a good jump ending in a random tumble because the car happened
  //     to be 20° off when it arrived. It only touches PITCH/ROLL — yaw spin is
  //     about the up-axis and is orthogonal, so deliberate flat spins survive.
  /** Master scale, 0..1. 0 = no landing help at all. */
  airLandAssist: 1.0,
  /** Alignment torque (N·m) at full engagement. */
  airLandTorque: 6000,
  /** Metres before contact over which the assist ramps 0→1. Also the probe
   *  length — beyond it the assist is zero anyway. Kept short so the player has
   *  already committed to their trick before it engages. */
  airLandRange: 12,
  /** Damping on the tilt rate while engaged, or the alignment overshoots and the
   *  car wobbles through the last metres of the fall. */
  airLandDamp: 1200,

};

/** Drivetrain. `layout` picks which axle(s) get engine torque; for AWD,
 *  `powerBias` is the rear power fraction (0 = all front … 1 = all rear, 0.5 =
 *  even). Braking always acts on all four wheels regardless of layout. Total
 *  drive force is preserved across layouts, so RWD just concentrates it on the
 *  rear (more power-oversteer) rather than halving acceleration. */
export const DRIVETRAIN = {
  layout: "AWD", // 'FWD' | 'RWD' | 'AWD'
  // Front-leaning split: the rear axle's drive share is what eats its lateral
  // grip under power, so 0.4 keeps AWD stable at speed without FWD's plow.
  powerBias: 0.4,
};

/** Aerodynamics. `drag` bounds top speed and tames downhill runaway (quadratic,
 *  opposing velocity). `downforce` presses the car onto whatever surface it's on
 *  (along -chassis-up) and scales with speed² — light by default, but it adds
 *  load-sensitive grip in fast corners and margin through loops. */
export const AERO = {
  drag: 0.45,
  downforce: 3.0,
};

/** Chassis shell vs the deck BVH — stops the body clipping into elevated track
 *  (ramps, loops, hard landings). Bottom corners get pushed out along the deck
 *  normal once they sink within `skin` of the surface. */
export const DECK = {
  enabled: true,
  skin: 0.05,
  searchRadius: 0.8,
  stiffness: 220000,
  damper: 9000,
};

/**
 * Visual body lean — purely cosmetic, zero effect on handling.
 *
 * The car reads as weightless: static suspension sag is ~5 cm of 55 cm travel
 * (2.2 Hz ride frequency), and the stabilizer holds the chassis flat to the
 * ground normal anyway, so nothing visibly moves. This leans the chassis MESH
 * (and its children — headlights, taillights) against the tire forces the
 * physics already produced, while the wheels stay planted where the sim put
 * them. Angles are normalised by vehicle weight, so they read in g and don't
 * change if CHASSIS.mass is edited.
 */
export const BODYLEAN = {
  enabled: true,
  /** Radians of roll per g of lateral load. */
  rollPerG: 0.10,
  /** Radians of pitch per g of longitudinal load (squat / dive). */
  pitchPerG: 0.06,
  maxRoll: 0.13, // ~7.5°
  maxPitch: 0.09, // ~5°
  /** Ease rate (1/s) toward the target angles. */
  smooth: 9,
};

/**
 * LIVE wheel dimensions. `radius` is a PHYSICS parameter, not just a visual one
 * — it scales the tire probe's ray ring (`rayRingScale`) and sphere sweep
 * (`sphereSweepScale`), sets the visual suspension extension, and divides into
 * the wheel spin rate. Switching wheel style therefore rewrites these; see
 * Vehicle.setWheelStyle().
 *
 * `thickness` is currently VISUAL ONLY: its physics consumer is
 * `rayLateralBias`, which lives in the `else` branch of Tire._probeGround and is
 * only reached when `rayRingCount < 3`. It is 10.
 */
export const WHEEL = {
  radius: 0.36,
  thickness: 0.24,
  rimRadius: 0.22,
  rimWidth: 0.26,
};

/** The procedural wheel's dimensions — the baseline the handling was tuned on.
 *  Selecting "procedural" restores exactly these, so it stays a true A/B against
 *  any model-derived size. */
export const WHEEL_PROCEDURAL = { radius: 0.36, thickness: 0.24 };

/** Forward-facing headlights (cheap, no shadows). Two SpotLights parented to the
 *  chassis mesh so they follow position + orientation for free. Mount/aim offsets
 *  are chassis-local meters: +Z front, +Y up, +X right. */
export const HEADLIGHTS = {
  enabled: false,
  color: "#fff2d6",
  intensity: 1200, // candela-ish (decay 2) — tune against night exposure
  distance: 90,
  angle: 0.6, // cone half-angle (rad)
  penumbra: 0.5,
  decay: 2,
  lampEmissive: 3.0, // emissive lamp face brightness (>1 so it blooms)
  // mount on the chassis (local m)
  side: 0.6,
  height: 0.05,
  forward: 1.75,
  // aim point relative to the mount (local m)
  aimForward: 16,
  aimDrop: 3.2,
};

/** Rear taillights — emissive meshes only (no real lights, bloom-friendly). They
 *  glow dimly while the headlights are on (night) and flare bright under braking
 *  or handbrake. Mount offsets are chassis-local meters (rear face is -Z). */
export const TAILLIGHTS = {
  enabled: true,
  color: "#ff2020",
  runningIntensity: 0.6, // dim glow when headlights are on
  brakeIntensity: 4.0, // bright flare on brake / handbrake
  width: 0.35,
  height: 0.16,
  side: 0.62, // ±X
  up: 0.12, // +Y
  back: 1.78, // distance behind centre (placed at -Z)
};

export const WALL = {
  probeRange: 0.9,
  stiffness: 300000,
  damper: 14000,
  clampPenFrac: 0.4,
};

/** Chassis-vs-solids (guardrails, ramp walls) via the solids BVH. Samples the
 *  oriented chassis box (8 corners + 12 edge midpoints + 6 face centres) and
 *  pushes each point out of the nearest surface within `radius`. */
export const SOLID = {
  enabled: true,
  radius: 0.4, // search distance per box sample (m)
  stiffness: 260000,
  damper: 12000,
  clampPenFrac: 0.5,
  /** Hard cap (m/s) on how fast a solid may throw the car back out along the
   *  aggregate contact normal. 26 penetration springs at 260 kN/m STACK when
   *  several samples bury at once, so a fast graze along a guardrail turned into
   *  a launcher — the car played pinball down the rail. The springs still do the
   *  depenetrating; this just refuses to let them return more than they should.
   *  Only limits OUTWARD velocity, so it can't push the car into a wall. */
  maxExitSpeed: 4.0,
  /** Tangential speed scrubbed per second (1/s) while in contact, so scraping a
   *  rail costs a little speed instead of conserving it perfectly. */
  tangentScrub: 1.5,
};

/** Cached each rebuild — offset from box center to CoM in chassis-local space. */
const _COM_OFFSET = new THREE.Vector3();
/** Shared constants for composing instanced wheel matrices. */
const _UNIT_SCALE = new THREE.Vector3(1, 1, 1);
const _MIRROR_Y = new THREE.Matrix4().makeRotationY(Math.PI);

function _syncComOffset() {
  _COM_OFFSET.set(CHASSIS.comX, CHASSIS.comY, CHASSIS.comZ);
}

/* ----------------------------------------------------------------------- */
/* Rigid body — 6-DOF, force/torque accumulators                            */
/* ----------------------------------------------------------------------- */

class RigidBody {
  constructor({ mass, size }) {
    this.mass = mass;
    this.invMass = 1 / mass;
    this.localInvInertia = new THREE.Matrix3();
    this._setInertia(mass, size);

    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.quat = new THREE.Quaternion();
    this.angVel = new THREE.Vector3();
    this.forceAccum = new THREE.Vector3();
    this.torqueAccum = new THREE.Vector3();

    this._r = new THREE.Vector3();
    this._tau = new THREE.Vector3();
    this._rotVel = new THREE.Vector3();
    this._R3 = new THREE.Matrix3();
    this._R3t = new THREE.Matrix3();
    this._mat = new THREE.Matrix4();
    this._worldInvI = new THREE.Matrix3();
  }

  _setInertia(mass, { width: w, height: h, length: l, comX = 0, comY = 0, comZ = 0 }) {
    const Ixx = (mass / 12) * (h * h + l * l) + mass * (comY * comY + comZ * comZ);
    const Iyy = (mass / 12) * (w * w + l * l) + mass * (comX * comX + comZ * comZ);
    const Izz = (mass / 12) * (w * w + h * h) + mass * (comX * comX + comY * comY);
    this.localInvInertia.set(1 / Ixx, 0, 0, 0, 1 / Iyy, 0, 0, 0, 1 / Izz);
  }

  addForce(F) {
    this.forceAccum.add(F);
  }

  addForceAtPoint(F, worldPoint) {
    this.forceAccum.add(F);
    this._r.subVectors(worldPoint, this.pos);
    this._tau.crossVectors(this._r, F);
    this.torqueAccum.add(this._tau);
  }

  getVelocityAtPoint(worldPoint, out) {
    this._r.subVectors(worldPoint, this.pos);
    this._rotVel.crossVectors(this.angVel, this._r);
    return out.addVectors(this.vel, this._rotVel);
  }

  integrate(dt) {
    this.vel.x += this.forceAccum.x * this.invMass * dt;
    this.vel.y += this.forceAccum.y * this.invMass * dt;
    this.vel.z += this.forceAccum.z * this.invMass * dt;
    this.pos.x += this.vel.x * dt;
    this.pos.y += this.vel.y * dt;
    this.pos.z += this.vel.z * dt;

    this._mat.makeRotationFromQuaternion(this.quat);
    this._R3.setFromMatrix4(this._mat);
    this._R3t.copy(this._R3).transpose();
    this._worldInvI.copy(this._R3).multiply(this.localInvInertia).multiply(this._R3t);

    this._tau.copy(this.torqueAccum).applyMatrix3(this._worldInvI);
    this.angVel.x += this._tau.x * dt;
    this.angVel.y += this._tau.y * dt;
    this.angVel.z += this._tau.z * dt;

    const wx = this.angVel.x, wy = this.angVel.y, wz = this.angVel.z;
    const qx = this.quat.x, qy = this.quat.y, qz = this.quat.z, qw = this.quat.w;
    const dqx = 0.5 * (wx * qw + wy * qz - wz * qy);
    const dqy = 0.5 * (-wx * qz + wy * qw + wz * qx);
    const dqz = 0.5 * (wx * qy - wy * qx + wz * qw);
    const dqw = 0.5 * (-wx * qx - wy * qy - wz * qz);
    this.quat.set(qx + dqx * dt, qy + dqy * dt, qz + dqz * dt, qw + dqw * dt);
    this.quat.normalize();

    this.forceAccum.set(0, 0, 0);
    this.torqueAccum.set(0, 0, 0);
  }
}

/* ----------------------------------------------------------------------- */
/* Tire — raycast probe + suspension/steering/longitudinal forces           */
/* ----------------------------------------------------------------------- */

class Tire {
  constructor({ name, localPos, steer, drive }) {
    this.name = name;
    this.localPos = localPos.clone();
    this.canSteer = steer;
    this.canDrive = drive;
    this.isFront = localPos.z > 0;

    this.grounded = false;
    this.compression = 0;
    this.hitDistance = TIRE.rayLength;
    this.hitPoint = new THREE.Vector3();
    this.hitNormal = new THREE.Vector3(0, 1, 0);
    this.worldPos = new THREE.Vector3();
    this.lastSuspension = new THREE.Vector3();
    this.lastSteering = new THREE.Vector3();
    this.lastAccel = new THREE.Vector3();
    this._smoothDist = undefined;
    /** Unfiltered contact normal, before the low-pass in apply(). */
    this._rawNormal = new THREE.Vector3(0, 1, 0);
    /** Low-passed contact normal — this is what `hitNormal` exposes. */
    this._smoothNormal = new THREE.Vector3(0, 1, 0);
    /** Was this tire on a surface last tick? Drives snap-vs-filter. */
    this._hadGround = false;

    this._tireVel = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._wheelFwd = new THREE.Vector3();
    this._wheelRight = new THREE.Vector3();
    this._steerQuat = new THREE.Quaternion();
    this._F = new THREE.Vector3();
    this._down = new THREE.Vector3();
    this._rayO = new THREE.Vector3();
    this._rayOff = new THREE.Vector3();
    this._bestP = new THREE.Vector3();
    this._bestN = new THREE.Vector3(0, 1, 0);
  }

  /** Cast rays + optional sphere sweep; keep the closest ground hit. */
  _probeGround(castGround, castSphereSweep, pad, far) {
    const fwdBias = TIRE.rayForwardBias * WHEEL.radius;
    const latBias = TIRE.rayLateralBias * WHEEL.thickness * 0.5;
    const ringN = Math.round(TIRE.rayRingCount);
    const ringR = WHEEL.radius * TIRE.rayRingScale;

    let bestDist = Infinity;
    let bestPoint = null;

    // `dist` lets a caller pass a distance already normalized back to the hub
    // (ring rays / sphere sweep start BELOW the hub, so their raw hit distance
    // under-reports the true hub-to-ground gap). Falls back to hit.distance.
    const consider = (hit, dist) => {
      if (!hit) return;
      const d = dist !== undefined ? dist : hit.distance;
      if (d >= bestDist) return;
      bestDist = d;
      if (hit.point?.isVector3) this._bestP.copy(hit.point);
      else if (hit.point) this._bestP.set(hit.point.x, hit.point.y, hit.point.z);
      bestPoint = this._bestP;
      if (hit.normal?.isVector3) this._bestN.copy(hit.normal);
      else if (hit.normal) this._bestN.set(hit.normal.x, hit.normal.y, hit.normal.z);
      else if (hit.face?.normal) this._bestN.copy(hit.face.normal);
      else this._bestN.set(0, 1, 0);
    };

    const sample = (dirVec, off) => {
      this._rayO.copy(this.worldPos).addScaledVector(this._up, pad);
      if (dirVec) this._rayO.addScaledVector(dirVec, off);
      consider(castGround(this._rayO, this._down, far));
    };

    if (ringN >= 3) {
      // Bottom semicircle: rear → underside → front (in the wheel fwd/down plane).
      for (let i = 0; i < ringN; i++) {
        const a = Math.PI * (i / (ringN - 1));
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        this._rayO.copy(this.worldPos).addScaledVector(this._up, pad);
        this._rayO.addScaledVector(this._wheelFwd, ca * ringR);
        this._rayO.addScaledVector(this._down, sa * ringR);
        // This ray starts sa*ringR below the hub plane; add it back so the
        // distance is measured from the hub, not the lowered ring origin.
        const hit = castGround(this._rayO, this._down, far);
        if (hit) consider(hit, hit.distance + sa * ringR);
      }
    } else {
      sample(null, 0);
      if (fwdBias > 1e-4) {
        sample(this._wheelFwd, fwdBias);
        sample(this._wheelFwd, -fwdBias);
      }
      if (latBias > 1e-4) {
        sample(this._wheelRight, latBias);
        sample(this._wheelRight, -latBias);
      }
    }

    if (TIRE.useSphereSweep && castSphereSweep) {
      this._rayO.copy(this.worldPos).addScaledVector(this._up, pad);
      const sr = WHEEL.radius * TIRE.sphereSweepScale;
      const sh = castSphereSweep(
        this._rayO.x,
        this._rayO.y,
        this._rayO.z,
        sr,
        this._down.x,
        this._down.y,
        this._down.z,
        far,
      );
      if (sh) {
        // The sphere (radius sr) contacts ground sr below its center, so the
        // true hub-to-ground gap is sh.distance + sr (sh.distance is how far
        // the center travelled from the hub-raised origin).
        consider({ distance: sh.distance, point: sh.point, normal: sh.normal }, sh.distance + sr);
      }
    }

    return bestDist === Infinity ? null : { dist: bestDist, point: bestPoint };
  }

  apply(body, dt, steerAngle, throttle, handbrake, castGround, castSphereSweep, driveScale = 1) {
    this.worldPos
      .copy(this.localPos)
      .sub(_COM_OFFSET)
      .applyQuaternion(body.quat)
      .add(body.pos);
    this._up.set(0, 1, 0).applyQuaternion(body.quat);
    this._fwd.set(0, 0, 1).applyQuaternion(body.quat);
    this._right.set(1, 0, 0).applyQuaternion(body.quat);

    this._wheelFwd.copy(this._fwd);
    this._wheelRight.copy(this._right);
    if (this.canSteer && steerAngle !== 0) {
      this._steerQuat.setFromAxisAngle(this._up, steerAngle);
      this._wheelFwd.applyQuaternion(this._steerQuat);
      this._wheelRight.applyQuaternion(this._steerQuat);
    }

    const pad = TIRE.rayPadAbove;
    const far = TIRE.rayLength + pad;
    this._down.copy(this._up).multiplyScalar(-1);

    const probe = this._probeGround(castGround, castSphereSweep, pad, far);

    this.lastSuspension.set(0, 0, 0);
    this.lastSteering.set(0, 0, 0);
    this.lastAccel.set(0, 0, 0);

    if (!probe) {
      this.grounded = false;
      this.compression = 0;
      this.hitDistance = TIRE.rayLength;
      this._hadGround = false; // next contact snaps instead of easing in
      return;
    }

    const bestDist = probe.dist;
    this.grounded = true;
    this.hitPoint.copy(probe.point);
    this._rawNormal.copy(this._bestN);
    if (this._rawNormal.dot(this._up) < 0) this._rawNormal.negate();
    if (this._rawNormal.lengthSq() < 1e-8) this._rawNormal.copy(this._up);
    this._rawNormal.normalize();

    // Low-pass the contact normal. _probeGround keeps the CLOSEST of the ring
    // rays, and reports THAT ray's raw triangle normal — so where two modular
    // pieces meet, the winning ray flips between the two pieces' normals from
    // tick to tick. This normal is what feeds the stabilizer's alignment torque,
    // so the flicker showed up as a twitch on every seam. Filtering here fixes it
    // for every consumer at once (stabilizer, yaw assist, tire marks).
    //
    // Snap on the FIRST tick of contact — a landing must not ease in from a
    // stale airborne normal — and filter only while contact is continuous.
    if (!this._hadGround || TIRE.normalSmooth <= 0) {
      this._smoothNormal.copy(this._rawNormal);
    } else {
      this._smoothNormal.lerp(this._rawNormal, 1 - Math.exp(-TIRE.normalSmooth * dt));
      if (this._smoothNormal.lengthSq() < 1e-8) this._smoothNormal.copy(this._rawNormal);
      this._smoothNormal.normalize();
    }
    this._hadGround = true;
    this.hitNormal.copy(this._smoothNormal);

    const distFromHub = bestDist - pad;
    this.hitDistance = distFromHub;
    this.compression = TIRE.restLength - distFromHub;

    body.getVelocityAtPoint(this.worldPos, this._tireVel);

    // 1) Suspension (vertical) with quadratic bottom-out.
    const upVel = this._tireVel.dot(this._up);
    let springMag = this.compression * TIRE.springStrength;
    const ovr = this.compression - TIRE.restLength * TIRE.bottomOutThresh;
    if (ovr > 0) springMag += ovr * ovr * TIRE.springStrength * TIRE.bottomOutMult;
    const dampMag = upVel * TIRE.damper;
    const suspMag = Math.max(0, springMag - dampMag);
    this._F.copy(this._up).multiplyScalar(suspMag);
    body.addForceAtPoint(this._F, this.worldPos);
    this.lastSuspension.copy(this._F);

    // Friction circle radius — load-sensitive: `suspMag` is the dynamic normal
    // load, so weight transfer (outer wheels compress more) feeds straight into
    // available grip. Per-axle μ multiplier sets the handling balance.
    const axleGrip = this.canSteer
      ? TIRE.gripFront
      : handbrake
      ? TIRE.gripHandbrake
      : TIRE.gripRear;
    const Fmax = TIRE.frictionCoeff * axleGrip * suspMag;

    // 2) Lateral grip — slip-based brush model. Force rises linearly with the
    // lateral slip ratio (≈ tan slip angle) up to the friction limit, then the
    // tire SLIDES (force saturates) instead of perfectly cancelling velocity.
    const vLat = this._tireVel.dot(this._wheelRight);
    const vLong = this._tireVel.dot(this._wheelFwd);
    const vRef = Math.max(Math.abs(vLong), TIRE.lowSpeedRef);
    let latNorm = -(vLat / vRef) * TIRE.tireStiffness;
    if (latNorm > 1) latNorm = 1;
    else if (latNorm < -1) latNorm = -1;
    let Fy = latNorm * Fmax;

    // 3) Longitudinal. Braking acts on every wheel; engine torque (accel /
    // reverse / engine-brake) is scaled by this wheel's drivetrain share, so
    // FWD/RWD/AWD just changes *where* the drive force is applied.
    let Fx = 0;
    const carSpeed = body.vel.dot(this._fwd);
    const thr = TIRE.brakeReverseThreshold;
    if (throttle > 0) {
      if (carSpeed < -thr) {
        Fx = TIRE.brakeForce;
      } else {
        const normSpeed = Math.min(1, Math.abs(carSpeed) / TIRE.topSpeed);
        Fx = driveScale * TIRE.accelForce * Math.max(0, 1 - Math.pow(normSpeed, TIRE.powerCurveExp));
      }
    } else if (throttle < 0) {
      if (carSpeed > thr) {
        Fx = -TIRE.brakeForce;
      } else {
        const normSpeed = Math.min(1, Math.abs(carSpeed) / TIRE.topSpeed);
        Fx = -driveScale * TIRE.reverseAccel * Math.max(0, 1 - Math.pow(normSpeed, TIRE.powerCurveExp));
      }
    } else if (driveScale > 0) {
      const fwdVel = this._tireVel.dot(this._wheelFwd);
      Fx = -Math.sign(fwdVel) * Math.min(Math.abs(fwdVel) * 200, TIRE.engineBrake);
    }
    if (Fx > Fmax) Fx = Fmax;
    else if (Fx < -Fmax) Fx = -Fmax;

    // 4) Combined-slip friction circle — lateral and longitudinal share one
    // budget. Hard braking eats cornering grip (trail-braking / lockup feel);
    // power-on at a low-grip rear axle eats lateral grip (power oversteer).
    const demand = Math.hypot(Fx, Fy);
    if (demand > Fmax && demand > 1e-6) {
      const s = Fmax / demand;
      Fx *= s;
      Fy *= s;
    }

    this._F.copy(this._wheelRight).multiplyScalar(Fy);
    body.addForceAtPoint(this._F, this.worldPos);
    this.lastSteering.copy(this._F);

    this._F.copy(this._wheelFwd).multiplyScalar(Fx);
    body.addForceAtPoint(this._F, this.worldPos);
    this.lastAccel.copy(this._F);
  }
}

/* ----------------------------------------------------------------------- */
/* Vehicle — meshes + physics step + visual sync                            */
/* ----------------------------------------------------------------------- */

export class Vehicle {
  constructor({ scene, showArrows = false }) {
    this.scene = scene;
    this.collidables = [];
    this.walls = [];
    this.wallBoxes = [];
    this.groundBvh = null;
    this.solidsBvh = null;
    /** Reference height for the chassis-corner safety floor. modular-road's world
     *  floor is at y=0 (the default); v3 sets this to a terrain sampler so the
     *  floor follows the heightfield instead of pinning the car to world y=0.
     *  @type {((x:number,z:number)=>number) | null} */
    this.getFloorY = null;
    /** @type {import("./modularRoadParkour.js").ParkourMover[]} */
    this.dynamicMovers = [];
    this.enabled = false;
    this.spawnPos = new THREE.Vector3(0, 0.7, -4);
    this.spawnQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);

    this.body = new RigidBody({ mass: CHASSIS.mass, size: CHASSIS });
    this.tires = WHEEL_LOCAL.map((w) => new Tire({ name: w.name, localPos: w.pos, steer: w.steer, drive: w.drive }));
    this.input = { steer: 0, throttle: 0, handbrake: false, yaw: 0 };

    this.group = new THREE.Group();
    this.group.name = "Vehicle";
    this.group.visible = false;
    scene.add(this.group);

    this._buildMeshes(showArrows);
    this._initScratch();

    this.raycaster = new THREE.Raycaster();
    this._bvhRay = new THREE.Ray();
    this._castGround = (origin, dir, far) => {
      if (this.groundBvh && this.groundBvh.baked) {
        return this.groundBvh.raycastFirst(origin, dir, far);
      }
      this.raycaster.ray.origin.copy(origin);
      this.raycaster.ray.direction.copy(dir);
      this.raycaster.far = far;
      const hits = this.raycaster.intersectObjects(this.collidables, false);
      return hits.length ? hits[0] : null;
    };
    this._castSphereSweep = (ox, oy, oz, radius, dx, dy, dz, maxDist) => {
      if (this.groundBvh && this.groundBvh.baked) {
        return this.groundBvh.spherecast(ox, oy, oz, radius, dx, dy, dz, maxDist);
      }
      return null;
    };
    // 2 substeps × FIXED_DT (1/120) → a 1/240 s integration step, the same
    // substep the old variable-rate path produced at 60 fps (dt/4), so the
    // existing handling tune carries over unchanged.
    this.SUBSTEPS = 2;
    // Previous-tick pose, kept for render interpolation between fixed ticks.
    this._prevPos = new THREE.Vector3();
    this._prevQuat = new THREE.Quaternion();
    this._renderPos = new THREE.Vector3();
    this._renderQuat = new THREE.Quaternion();
    this._renderWheelPos = new THREE.Vector3();
    this.respawn();
  }

  _buildMeshes(showArrows) {
    this.chassisMesh = new THREE.Mesh(
      new THREE.BoxGeometry(CHASSIS.width, CHASSIS.height, CHASSIS.length),
      new THREE.MeshStandardMaterial({ color: 0x5b6cd6, roughness: 0.55, metalness: 0.3 }),
    );
    this.chassisMesh.castShadow = true;
    this.chassisMesh.receiveShadow = true;
    this.group.add(this.chassisMesh);
    this._buildHeadlights();
    this._buildTaillights();

    // Wheel visuals are swappable (procedural ⇄ GLB), so the tireGroups are
    // created empty and filled by _rebuildWheelMeshes(). syncVisuals only ever
    // drives the GROUP transform, so nothing downstream cares what's inside.
    this._wheelStyle = "procedural";
    this._wheelTemplate = null;
    this._wheelModelDims = null;
    this._procGeo = null;
    /** One InstancedMesh per wheel PART, 4 instances each — see _rebuildWheelMeshes. */
    this._wheelInstances = [];
    this._wheelParts = [];
    this._wheelMirror = false;
    this._wheelMat = new THREE.Matrix4();
    this._partMat = new THREE.Matrix4();
    // Materials don't depend on the dimensions, so they're built once and reused
    // across style switches (the geometry is not — see _buildProceduralWheelGeo).
    this._procMat = {
      tire: new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.85 }),
      rim: new THREE.MeshStandardMaterial({ color: 0xb0b8c0, roughness: 0.35, metalness: 0.85 }),
      spoke: new THREE.MeshStandardMaterial({
        color: 0x2a3038, roughness: 0.5, metalness: 0.6, side: THREE.DoubleSide,
      }),
    };
    this.tireGroups = this.tires.map(() => {
      const g = new THREE.Group();
      this.group.add(g);
      return g;
    });
    this._rebuildWheelMeshes();

    this.arrowGroup = new THREE.Group();
    this.arrowGroup.visible = showArrows;
    this.group.add(this.arrowGroup);
    this.arrows = this.tires.map(() => {
      const up = new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(), 0.1, 0x60ff80, 0.18, 0.1);
      const side = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 0.1, 0x4090ff, 0.18, 0.1);
      const fwd = new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(), 0.1, 0xff5060, 0.18, 0.1);
      this.arrowGroup.add(up, side, fwd);
      return { up, side, fwd };
    });
    this.wheelSpin = [0, 0, 0, 0];
  }

  /** True once a GLB wheel template has been handed over. */
  get hasWheelModel() { return !!this._wheelTemplate; }
  get wheelStyle() { return this._wheelStyle; }

  /**
   * Hand over a loaded GLB wheel (see games/modular-road-v3/wheelModel.js).
   * `dims` are the model's MEASURED radius/thickness in metres.
   */
  setWheelModel(template, dims = null) {
    this._wheelTemplate = template || null;
    this._wheelModelDims = dims;
    if (this._wheelStyle === "glb") this.setWheelStyle("glb"); // re-apply with the new model
  }

  /**
   * Swap wheel style — and with it WHEEL.radius/thickness, because the radius
   * drives the tire probe geometry and must match what you can see. Selecting
   * "procedural" restores WHEEL_PROCEDURAL exactly, so it is a true A/B.
   *
   * @param {"procedural"|"glb"} style
   * @returns {string} the style actually applied (falls back if no model loaded)
   */
  setWheelStyle(style) {
    const useGlb = style === "glb" && !!this._wheelTemplate;
    this._wheelStyle = useGlb ? "glb" : "procedural";
    const dims = useGlb && this._wheelModelDims ? this._wheelModelDims : WHEEL_PROCEDURAL;
    WHEEL.radius = dims.radius;
    WHEEL.thickness = dims.thickness;
    this._rebuildWheelMeshes();
    // The suspension visual easing caches a distance measured against the OLD
    // radius; leaving it would pop the wheels on the first frame after a swap.
    for (const t of this.tires) t._smoothDist = undefined;
    return this._wheelStyle;
  }

  /** (Re)create the shared procedural wheel geometry at the CURRENT WHEEL dims. */
  _buildProceduralWheelGeo() {
    this._disposeProceduralWheelGeo();
    const tireGeo = new THREE.CylinderGeometry(WHEEL.radius, WHEEL.radius, WHEEL.thickness, 28);
    tireGeo.rotateZ(Math.PI / 2);
    const rimGeo = new THREE.CylinderGeometry(WHEEL.rimRadius, WHEEL.rimRadius, WHEEL.rimWidth, 18);
    rimGeo.rotateZ(Math.PI / 2);
    const spokeGeo = new THREE.CircleGeometry(WHEEL.rimRadius * 0.92, 6);
    this._procGeo = { tireGeo, rimGeo, spokeGeo };
  }

  _disposeProceduralWheelGeo() {
    if (!this._procGeo) return;
    this._procGeo.tireGeo.dispose();
    this._procGeo.rimGeo.dispose();
    this._procGeo.spokeGeo.dispose();
    this._procGeo = null;
  }

  /**
   * The procedural wheel as a flat part list (geometry + material + transform
   * within the wheel), matching what _glbWheelParts() returns.
   *
   * Only the tyre and rim cast: the spokes sit inside the rim, and a caster
   * costs one draw per shadow cascade.
   */
  _proceduralWheelParts() {
    this._buildProceduralWheelGeo();
    const hw = WHEEL.rimWidth / 2;
    // makeRotationY() then setPosition() composes to p' = R·p + t, which is what
    // Object3D's position+rotation.y pair produced before.
    const spoke = (x, ry) => new THREE.Matrix4().makeRotationY(ry).setPosition(x, 0, 0);
    return [
      { geometry: this._procGeo.tireGeo, material: this._procMat.tire, matrix: new THREE.Matrix4(), castShadow: true },
      { geometry: this._procGeo.rimGeo, material: this._procMat.rim, matrix: new THREE.Matrix4(), castShadow: true },
      { geometry: this._procGeo.spokeGeo, material: this._procMat.spoke, matrix: spoke(-hw - 0.001, Math.PI / 2), castShadow: false },
      { geometry: this._procGeo.spokeGeo, material: this._procMat.spoke, matrix: spoke(hw + 0.001, -Math.PI / 2), castShadow: false },
    ];
  }

  /** The loaded GLB flattened to the same shape, each part's transform baked
   *  relative to the template root (which sits on the axle). */
  _glbWheelParts() {
    const parts = [];
    this._wheelTemplate.updateMatrixWorld(true);
    this._wheelTemplate.traverse((o) => {
      if (!o.isMesh) return;
      parts.push({
        geometry: o.geometry,
        material: o.material,
        matrix: o.matrixWorld.clone(),
        castShadow: o.castShadow, // wheelModel.js already picked tyre + rim
      });
    });
    return parts;
  }

  /**
   * Rebuild the wheels as ONE InstancedMesh PER PART, four instances each.
   *
   * All four wheels are the same object at different poses, which is the exact
   * case instancing exists for. Per-wheel meshes cost 4 parts × 4 wheels = 16
   * main draws plus 3 shadow draws for every caster among them; instanced, the
   * whole set is 4 main draws and 3 per casting part — 10 draws total for either
   * style, against 40 (procedural) and 64 (the GLB as first shipped).
   */
  _rebuildWheelMeshes() {
    const useGlb = this._wheelStyle === "glb" && !!this._wheelTemplate;

    for (const inst of this._wheelInstances) {
      this.group.remove(inst);
      inst.dispose(); // frees instanceMatrix only — geometry/materials are shared
    }
    this._wheelInstances.length = 0;
    // Only safe to dispose AFTER the meshes referencing it are gone.
    if (useGlb) this._disposeProceduralWheelGeo();

    this._wheelParts = useGlb ? this._glbWheelParts() : this._proceduralWheelParts();
    // The GLB is a FRONT-LEFT assembly, so one side has to be mirrored.
    //
    // WHICH side: the model's brake caliper spans x ∈ [-0.240, -0.073] and the
    // rotor x ∈ [-0.162, -0.098] — both entirely negative, and brake hardware is
    // always INBOARD. So the assembly's exterior (the rim face you're meant to
    // see) points toward +X, and it's the -X wheels that need turning. Getting
    // this backwards shows every wheel from the inside.
    //
    // A half-turn about the vertical, never a negative scale: mirroring by scale
    // inverts the triangle winding and darkens the lighting. The wheel's spin is
    // about X and is composed on top, so this does not change which way the
    // wheel appears to rotate. The procedural wheel is symmetric and needs none.
    this._wheelMirror = useGlb;

    const count = this.tireGroups.length;
    for (const part of this._wheelParts) {
      const inst = new THREE.InstancedMesh(part.geometry, part.material, count);
      inst.castShadow = part.castShadow;
      inst.receiveShadow = false;
      inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage); // rewritten every frame
      this.group.add(inst);
      this._wheelInstances.push(inst);
    }
    this._syncWheelInstances();
  }

  /**
   * Push the tireGroups' poses into the instanced meshes. The groups are still
   * driven by syncVisuals exactly as before — they're now empty transform
   * holders rather than mesh parents, which keeps the visual code unchanged.
   */
  _syncWheelInstances() {
    if (!this._wheelInstances.length) return;
    for (let i = 0; i < this.tireGroups.length; i++) {
      const g = this.tireGroups[i];
      this._wheelMat.compose(g.position, g.quaternion, _UNIT_SCALE);
      if (this._wheelMirror && WHEEL_LOCAL[i].pos.x < 0) this._wheelMat.multiply(_MIRROR_Y);
      for (let p = 0; p < this._wheelParts.length; p++) {
        this._partMat.multiplyMatrices(this._wheelMat, this._wheelParts[p].matrix);
        this._wheelInstances[p].setMatrixAt(i, this._partMat);
      }
    }
    for (const inst of this._wheelInstances) {
      inst.instanceMatrix.needsUpdate = true;
      // An InstancedMesh culls against ITS OWN transform, which here is identity
      // at the world origin, while the instances sit wherever the car is. Without
      // recomputing this the wheels get culled the moment the car drives away
      // from the origin. computeBoundingSphere() does account for the instance
      // matrices, and it's four of them.
      inst.computeBoundingSphere();
    }
  }

  _buildHeadlights() {
    this.headlights = [];
    this.headlightTargets = [];
    this.headlamps = []; // emissive lamp faces (bloom source)
    const H = HEADLIGHTS;
    this._lampGeo = this._lampGeo ?? new THREE.BoxGeometry(1, 1, 1);
    for (const s of [-1, 1]) {
      const light = new THREE.SpotLight(H.color, H.intensity, H.distance, H.angle, H.penumbra, H.decay);
      light.castShadow = false;
      light.position.set(s * H.side, H.height, H.forward);
      const target = new THREE.Object3D();
      target.position.set(s * H.side, H.height - H.aimDrop, H.forward + H.aimForward);
      this.chassisMesh.add(light);
      this.chassisMesh.add(target);
      light.target = target;
      light.visible = H.enabled;
      this.headlights.push(light);
      this.headlightTargets.push(target);

      // Node material + bloom MRT so the lamp glows under v3's SELECTIVE bloom
      // (only the emissive buffer blooms; a plain `emissive` value does nothing).
      const lampMat = new THREE.MeshStandardNodeMaterial({
        color: H.color,
        emissive: H.color,
        emissiveIntensity: H.lampEmissive,
        roughness: 0.4,
        metalness: 0,
      });
      applyBloomMRT(lampMat, materialEmissive);
      const lamp = new THREE.Mesh(this._lampGeo, lampMat);
      lamp.castShadow = false;
      lamp.receiveShadow = false;
      lamp.position.set(s * H.side, H.height, H.forward + 0.02);
      lamp.scale.set(0.22, 0.12, 0.05);
      lamp.visible = H.enabled;
      this.chassisMesh.add(lamp);
      this.headlamps.push(lamp);
    }
  }

  setHeadlights(on) {
    HEADLIGHTS.enabled = !!on;
    this.applyHeadlightParams();
  }

  /** Re-sync the headlight rig after editing HEADLIGHTS params live. */
  applyHeadlightParams() {
    const H = HEADLIGHTS;
    for (let i = 0; i < this.headlights.length; i++) {
      const s = i === 0 ? -1 : 1;
      const l = this.headlights[i];
      l.color.set(H.color);
      l.intensity = H.intensity;
      l.distance = H.distance;
      l.angle = H.angle;
      l.penumbra = H.penumbra;
      l.decay = H.decay;
      l.visible = H.enabled;
      l.position.set(s * H.side, H.height, H.forward);
      this.headlightTargets[i].position.set(s * H.side, H.height - H.aimDrop, H.forward + H.aimForward);
    }
    for (let i = 0; i < this.headlamps.length; i++) {
      const s = i === 0 ? -1 : 1;
      const m = this.headlamps[i];
      m.material.color.set(H.color);
      m.material.emissive.set(H.color);
      m.material.emissiveIntensity = H.lampEmissive;
      m.position.set(s * H.side, H.height, H.forward + 0.02);
      m.visible = H.enabled;
    }
  }

  _buildTaillights() {
    this.taillights = [];
    const T = TAILLIGHTS;
    const geo = new THREE.BoxGeometry(1, 1, 1); // unit box, scaled per params
    for (const s of [-1, 1]) {
      const mat = new THREE.MeshStandardNodeMaterial({
        color: T.color,
        emissive: T.color,
        emissiveIntensity: T.runningIntensity,
        roughness: 0.4,
        metalness: 0,
      });
      // Brake lights are the clearest read of what the car is doing — they need
      // to bloom, which under v3's selective bloom means writing the MRT buffer.
      applyBloomMRT(mat, materialEmissive);
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = false;
      m.receiveShadow = false;
      m.position.set(s * T.side, T.up, -T.back);
      m.scale.set(T.width, T.height, 0.06);
      m.visible = false;
      this.chassisMesh.add(m);
      this.taillights.push(m);
    }
  }

  /** Re-sync taillight color / size / mount after editing TAILLIGHTS params. */
  applyTaillightParams() {
    const T = TAILLIGHTS;
    for (let i = 0; i < this.taillights.length; i++) {
      const s = i === 0 ? -1 : 1;
      const m = this.taillights[i];
      m.material.color.set(T.color);
      m.material.emissive.set(T.color);
      m.position.set(s * T.side, T.up, -T.back);
      m.scale.set(T.width, T.height, 0.06);
    }
  }

  /** Per-frame: dim running glow when headlights are on, bright on brake. */
  _updateTaillights() {
    if (!this.taillights.length) return;
    const T = TAILLIGHTS;
    this._tlFwd.set(0, 0, 1).applyQuaternion(this.body.quat);
    const vFwd = this.body.vel.dot(this._tlFwd);
    const braking = this.input.handbrake || (this.input.throttle < 0 && vFwd > 0.5);
    let intensity = 0;
    if (braking) intensity = T.brakeIntensity;
    else if (HEADLIGHTS.enabled) intensity = T.runningIntensity;
    const on = T.enabled && intensity > 0;
    for (const m of this.taillights) {
      m.visible = on;
      m.material.emissiveIntensity = intensity;
    }
  }

  _initScratch() {
    this._tlFwd = new THREE.Vector3();
    this._gravityF = new THREE.Vector3();
    this._hw = CHASSIS.width / 2;
    this._hh = CHASSIS.height / 2;
    this._hl = CHASSIS.length / 2;
    this.CHASSIS_CORNERS = [];
    this.PROBE_LOCALS = [
      { pos: new THREE.Vector3(), dir: new THREE.Vector3(0, 0, 1) },
      { pos: new THREE.Vector3(), dir: new THREE.Vector3(0, 0, -1) },
      { pos: new THREE.Vector3(), dir: new THREE.Vector3(1, 0, 0) },
      { pos: new THREE.Vector3(), dir: new THREE.Vector3(-1, 0, 0) },
    ];
    for (let i = 0; i < 8; i++) this.CHASSIS_CORNERS.push(new THREE.Vector3());
    /** Oriented box samples for solids BVH — corners + edge mids + face centres. */
    this.SOLID_BOX_SAMPLES = [];
    for (let i = 0; i < 26; i++) this.SOLID_BOX_SAMPLES.push(new THREE.Vector3());
    this._sphC = new THREE.Vector3();
    this._sphN = new THREE.Vector3();
    this._sphV = new THREE.Vector3();
    this._sphF = new THREE.Vector3();
    this._refreshLocalFrames();

    this.CORNER_SPRING = 180000;
    this.CORNER_DAMPER = 6000;
    this.CORNER_FRICTION = 0.6;

    this._cWorld = new THREE.Vector3();
    this._cVel = new THREE.Vector3();
    this._cF = new THREE.Vector3();
    this._cVelHoriz = new THREE.Vector3();
    this._stabUp = new THREE.Vector3();
    this._stabTorque = new THREE.Vector3();
    this._stabN = new THREE.Vector3();
    this._stabCross = new THREE.Vector3();
    this._stabWTilt = new THREE.Vector3();
    this._airRight = new THREE.Vector3();
    this._airFwd = new THREE.Vector3();
    this._yawN = new THREE.Vector3();
    this._yawFwd = new THREE.Vector3();
    this._yawLat = new THREE.Vector3();
    this._yawVel = new THREE.Vector3();
    this._solidN = new THREE.Vector3();
    this._solidT = new THREE.Vector3();
    this._steerRateFwd = new THREE.Vector3();
    this._landN = new THREE.Vector3();
    this._landUp = new THREE.Vector3();
    this._landTilt = new THREE.Vector3();
    this._landTorque = new THREE.Vector3();
    this._landDir = new THREE.Vector3();
    /** Grounded wheel count last substep — drives the touchdown edge. */
    this._prevGrounded = 0;
    this._leanRight = new THREE.Vector3();
    this._leanFwd = new THREE.Vector3();
    this._leanQRoll = new THREE.Quaternion();
    this._leanQPitch = new THREE.Quaternion();
    /** Smoothed visual lean angles (rad). Cosmetic only. */
    this._leanRoll = 0;
    this._leanPitch = 0;
    this._deckN = new THREE.Vector3();
    this.BOTTOM_CORNERS = [0, 1, 4, 5];
    this._aeroF = new THREE.Vector3();
    this._aeroUp = new THREE.Vector3();
    this._surfV = new THREE.Vector3();
    this._probeOrigin = new THREE.Vector3();
    this._probeDirW = new THREE.Vector3();
    this._probeVel = new THREE.Vector3();
    this._probeF = new THREE.Vector3();
    this._depenDir = new THREE.Vector3();

    this._wheelUp = new THREE.Vector3();
    this._wheelOffset = new THREE.Vector3();
    this._steerLocalQ = new THREE.Quaternion();
    this._spinLocalQ = new THREE.Quaternion();
    this._wheelFwdWorld = new THREE.Vector3();
    this._wheelTireVel = new THREE.Vector3();
    this._yAxis = new THREE.Vector3(0, 1, 0);
    this._xAxis = new THREE.Vector3(1, 0, 0);
    this._zAxis = new THREE.Vector3(0, 0, 1);
    this._arrowDir = new THREE.Vector3();
    this._geomCenter = new THREE.Vector3();
    this._steerFwd = new THREE.Vector3();
    /** Seconds since the last wheel contact — gates air control (airGroundLockout). */
    this._airTime = 0;
    _syncComOffset();
  }

  /** Map a chassis-box-local point to world space (body.pos = CoM). */
  _geomToWorld(geomLocal, out) {
    const body = this.body;
    return out.copy(geomLocal).sub(_COM_OFFSET).applyQuaternion(body.quat).add(body.pos);
  }

  _refreshLocalFrames() {
    const hw = (this._hw = CHASSIS.width / 2);
    const hh = (this._hh = CHASSIS.height / 2);
    const hl = (this._hl = CHASSIS.length / 2);
    const c = this.CHASSIS_CORNERS;
    c[0].set(-hw, -hh, -hl); c[1].set(hw, -hh, -hl);
    c[2].set(-hw, hh, -hl); c[3].set(hw, hh, -hl);
    c[4].set(-hw, -hh, hl); c[5].set(hw, -hh, hl);
    c[6].set(-hw, hh, hl); c[7].set(hw, hh, hl);
    this.PROBE_LOCALS[0].pos.set(0, 0, hl);
    this.PROBE_LOCALS[1].pos.set(0, 0, -hl);
    this.PROBE_LOCALS[2].pos.set(hw, 0, 0);
    this.PROBE_LOCALS[3].pos.set(-hw, 0, 0);
    // Oriented chassis box — 8 corners, 12 edge midpoints, 6 face centres.
    const sb = this.SOLID_BOX_SAMPLES;
    for (let i = 0; i < 8; i++) sb[i].copy(c[i]);
    const edgePairs = [
      [0, 1], [2, 3], [4, 5], [6, 7],
      [0, 2], [1, 3], [4, 6], [5, 7],
      [0, 4], [1, 5], [2, 6], [3, 7],
    ];
    for (let i = 0; i < 12; i++) {
      sb[8 + i].copy(c[edgePairs[i][0]]).add(c[edgePairs[i][1]]).multiplyScalar(0.5);
    }
    sb[20].set(0, 0, hl); // front
    sb[21].set(0, 0, -hl); // rear
    sb[22].set(-hw, 0, 0); // left
    sb[23].set(hw, 0, 0); // right
    sb[24].set(0, hh, 0); // top
    sb[25].set(0, -hh, 0); // bottom
  }

  /** Re-derive inertia + local frames + visual box after mass/size/CoM edits. */
  rebuildBody() {
    _syncComOffset();
    this.body.mass = CHASSIS.mass;
    this.body.invMass = 1 / CHASSIS.mass;
    this.body._setInertia(CHASSIS.mass, CHASSIS);
    this._refreshLocalFrames();
    this.chassisMesh.geometry.dispose();
    this.chassisMesh.geometry = new THREE.BoxGeometry(CHASSIS.width, CHASSIS.height, CHASSIS.length);
  }

  setColliders(collidables, walls = []) {
    this.collidables = collidables.slice();
    for (const c of this.collidables) c.updateMatrixWorld(true);
    this.walls = walls.slice();
    for (const w of this.walls) w.updateMatrixWorld(true);
    this.wallBoxes = this.walls.map((w) => new THREE.Box3().setFromObject(w));
  }

  /** Attach baked BVHs. `ground` drives wheel probes; `solids` blocks the chassis. */
  setBvh(ground, solids) {
    this.groundBvh = ground || null;
    this.solidsBvh = solids || null;
  }

  /** Moving parkour solids — each mover rebakes its own BVH and pushes via surface velocity. */
  setDynamicMovers(movers) {
    this.dynamicMovers = movers ? movers.slice() : [];
  }

  setSpawn(pos, quat) {
    this.spawnPos.copy(pos);
    if (quat) this.spawnQuat.copy(quat);
  }

  respawn() {
    this.body.pos.copy(this.spawnPos);
    this.body.vel.set(0, 0, 0);
    this.body.quat.copy(this.spawnQuat);
    this.body.angVel.set(0, 0, 0);
    this._airTime = 0;
    // Drop the contact-normal history — the first probe after a teleport must
    // snap to the new surface, not ease over from wherever the car just was.
    for (const t of this.tires) t._hadGround = false;
    // Likewise the landing edge and the visual lean: a respawn is not a landing,
    // and the body should appear settled the instant it arrives.
    this._prevGrounded = 0;
    this._leanRoll = 0;
    this._leanPitch = 0;
    this._resetInterpolation();
    // Keep the render pose in step with the teleport (syncVisuals hasn't run yet).
    this._renderPos.copy(this.body.pos);
    this._renderQuat.copy(this.body.quat);
  }

  /** Interpolated render pose — the pose the MESH is drawn at (syncVisuals lerps
   *  _prev→body by alpha). A chase camera MUST follow this, not body.pos: the
   *  body advances in discrete FIXED_DT ticks while the mesh interpolates every
   *  frame, so following body.pos makes the car jitter in frame (classic
   *  camera-follows-physics shake). */
  get renderPos() { return this._renderPos; }
  get renderQuat() { return this._renderQuat; }

  /** Snap the interpolation history to the current pose so teleports and
   *  respawns don't smear the mesh across the map for one frame. */
  _resetInterpolation() {
    this._prevPos.copy(this.body.pos);
    this._prevQuat.copy(this.body.quat);
  }

  /** Recover in place: keep position + heading, zero the roll/pitch and spin,
   *  drop vertical speed, and lift slightly so the wheels clear the surface. */
  flipUpright() {
    const q = this.body.quat;
    const yaw = Math.atan2(2 * (q.w * q.y + q.z * q.x), 1 - 2 * (q.y * q.y + q.x * q.x));
    this.body.quat.setFromAxisAngle(this._yAxis, yaw);
    this.body.angVel.set(0, 0, 0);
    this.body.vel.y = 0;
    this.body.pos.y += 0.6;
    this._resetInterpolation();
  }

  /**
   * Teleport chassis — optional speed preservation along new forward.
   * @param {THREE.Vector3} worldPos
   * @param {THREE.Quaternion} worldQuat
   * @param {{ preserveSpeed?: boolean, dampVertical?: boolean }} [opts]
   */
  teleportTo(worldPos, worldQuat, opts = {}) {
    const body = this.body;
    let speed = 0;
    if (opts.preserveSpeed) {
      this._wheelFwdWorld.set(body.vel.x, 0, body.vel.z);
      speed = this._wheelFwdWorld.length();
    }
    body.pos.copy(worldPos);
    body.quat.copy(worldQuat);
    body.angVel.set(0, 0, 0);
    if (opts.preserveSpeed && speed > 0.05) {
      this._wheelFwdWorld.set(0, 0, 1).applyQuaternion(worldQuat);
      this._wheelFwdWorld.y = 0;
      if (this._wheelFwdWorld.lengthSq() > 1e-8) {
        this._wheelFwdWorld.normalize().multiplyScalar(speed);
        body.vel.copy(this._wheelFwdWorld);
      }
    }
    if (opts.dampVertical) body.vel.y *= 0.25;
    this._resetInterpolation();
  }

  setEnabled(on) {
    this.enabled = on;
    this.group.visible = on;
    if (on) this.respawn();
  }

  setArrowsVisible(v) {
    this.arrowGroup.visible = v;
  }

  /**
   * Advance exactly one fixed physics tick (FIXED_DT). Drive this from an
   * accumulator loop, then call syncVisuals(renderDt, alpha) once per frame.
   * @param {{steerTarget:number, throttle:number, handbrake:boolean, yaw:number}} controls
   */
  tick(controls) {
    if (!this.enabled) return;
    this._prevPos.copy(this.body.pos);
    this._prevQuat.copy(this.body.quat);
    this.input.steer = this._smoothSteer(controls.steerTarget ?? 0, !!controls.analog);
    this.input.throttle = controls.throttle ?? 0;
    this.input.handbrake = !!controls.handbrake;
    this.input.yaw = controls.yaw ?? 0;

    this._physicsStep(FIXED_DT);
    this._depenetrateFromWalls();
  }

  /**
   * Advance the steering input toward `target`, at a rate chosen by what the
   * player is actually doing — see the steerAttack/Release/Counter notes on TIRE.
   * `analog` bypasses the keyboard ramp entirely (a stick is already a position).
   */
  _smoothSteer(target, analog) {
    const cur = this.input.steer;
    let rate;
    let slowWithSpeed = false;
    if (analog) {
      rate = TIRE.steerAnalogRate;
    } else if (Math.abs(target) < 1e-3) {
      rate = TIRE.steerRelease; // let go → straighten
    } else if (cur !== 0 && Math.sign(target) !== Math.sign(cur)) {
      // Crossing over centre. This IS the countersteer, and it has to use the
      // fast rate for the WHOLE traverse — treating the unwind half as a plain
      // release is what made catching a slide feel impossible.
      rate = TIRE.steerCounter;
    } else if (Math.abs(target) > Math.abs(cur)) {
      rate = TIRE.steerAttack; // winding lock on
      slowWithSpeed = true;
    } else {
      rate = TIRE.steerRelease; // easing off toward a smaller angle
    }

    // Heavier wheel at speed. The usable ANGLE already shrinks (steerSpeedRef);
    // this shrinks how fast you get to it. Attack only — slowing the recovery
    // inputs at speed would be exactly backwards.
    if (slowWithSpeed && TIRE.steerRateSpeedDrop > 0) {
      this._steerRateFwd.set(0, 0, 1).applyQuaternion(this.body.quat);
      const sp = Math.abs(this.body.vel.dot(this._steerRateFwd));
      const t = Math.min(1, sp / Math.max(0.1, TIRE.steerSpeedRef));
      rate *= 1 - TIRE.steerRateSpeedDrop * t;
    }

    return cur + (target - cur) * (1 - Math.exp(-rate * FIXED_DT));
  }

  /** Steer angle after speed-sensitive reduction (shared by physics + visuals). */
  _steerAngle() {
    // Speed ALONG THE CHASSIS FORWARD axis, not |vel|: total speed includes the
    // vertical component, which numbed the steering exactly when it's needed
    // most — falling toward a landing after a jump or drop.
    this._steerFwd.set(0, 0, 1).applyQuaternion(this.body.quat);
    const speed = Math.abs(this.body.vel.dot(this._steerFwd));
    let t = speed / Math.max(0.1, TIRE.steerSpeedRef);
    if (t > 1) t = 1;
    const factor = 1 - TIRE.steerSpeedReduce * t;
    return this.input.steer * TIRE.maxSteerAngle * factor;
  }

  /** Rear power fraction from the drivetrain layout (FWD=0, RWD=1, AWD=bias). */
  _driveBias() {
    if (DRIVETRAIN.layout === "FWD") return 0;
    if (DRIVETRAIN.layout === "RWD") return 1;
    return Math.min(1, Math.max(0, DRIVETRAIN.powerBias));
  }

  _physicsStep(dt) {
    const subDt = dt / this.SUBSTEPS;
    const steerAngle = this._steerAngle();
    const body = this.body;
    // Per-axle drive scale: total drive is preserved (front+rear share = 2 wheels
    // × 2 axles' worth), so each axle's two wheels carry their power fraction.
    const bias = this._driveBias();
    const fScale = 2 * (1 - bias);
    const rScale = 2 * bias;
    for (let s = 0; s < this.SUBSTEPS; s++) {
      this._gravityF.set(0, -GRAVITY * body.mass, 0);
      body.addForce(this._gravityF);
      this._applyAero();
      for (const tire of this.tires) {
        const driveScale = tire.isFront ? fScale : rScale;
        tire.apply(
          body,
          subDt,
          steerAngle,
          this.input.throttle,
          this.input.handbrake,
          this._castGround,
          this._castSphereSweep,
          driveScale,
        );
      }
      if (this.walls.length) this._applyWallProbes();
      if (SOLID.enabled && this.solidsBvh && this.solidsBvh.baked) this._resolveSolids(subDt);
      if (DECK.enabled && this.groundBvh && this.groundBvh.baked) this._applyDeckContact();
      this._applyChassisGroundContact();
      // After the tires (their contact normals are what both of these read) and
      // before integrate(), so the torques land in this substep.
      this._applyYawAssist();
      this._applyLandingAssist();
      this._applyStabilizer(subDt);
      body.integrate(subDt);
      const wMax = TIRE.maxAngVel;
      if (body.angVel.lengthSq() > wMax * wMax) body.angVel.setLength(wMax);
    }
  }

  /**
   * Yaw assist — keep the slip angle inside a drivable range.
   *
   * Everything here is a torque about the averaged SURFACE normal rather than
   * world up, so it behaves the same on a bank, in a corkscrew, or upside down
   * inside a loop.
   *
   * Sign convention (matches Tire's `_wheelRight`): with the chassis facing +Z
   * and up +Y, `N × fwd` is +X, and a POSITIVE rotation about up turns the nose
   * toward +X. So a positive slip angle — travel is toward +X of the nose —
   * needs a positive torque to bring the nose back onto the velocity vector.
   */
  _applyYawAssist() {
    const body = this.body;
    if (TIRE.yawAssist <= 0) return;

    // Surface frame from the (already filtered) contact normals.
    let grounded = 0;
    this._yawN.set(0, 0, 0);
    for (const t of this.tires) {
      if (!t.grounded) continue;
      grounded++;
      this._yawN.add(t.hitNormal);
    }
    // Two wheels minimum: with one contact the "surface" is a single triangle
    // and the frame is too arbitrary to steer the whole car by.
    if (grounded < 2 || this._yawN.lengthSq() < 1e-8) return;
    this._yawN.normalize();

    // Chassis forward and velocity, both flattened INTO the surface plane.
    this._yawFwd.set(0, 0, 1).applyQuaternion(body.quat);
    this._yawFwd.addScaledVector(this._yawN, -this._yawFwd.dot(this._yawN));
    if (this._yawFwd.lengthSq() < 1e-8) return; // nose along the normal — no yaw frame
    this._yawFwd.normalize();

    this._yawVel.copy(body.vel);
    this._yawVel.addScaledVector(this._yawN, -this._yawVel.dot(this._yawN));
    const speed = this._yawVel.length();
    if (speed < TIRE.yawAssistMinSpeed) return;
    this._yawVel.multiplyScalar(1 / speed);

    this._yawLat.crossVectors(this._yawN, this._yawFwd);
    const alongFwd = this._yawVel.dot(this._yawFwd);
    // Travelling backwards (reverse gear, or already spun past 90°). Slip angle
    // is meaningless here — aligning the nose to travel would violently spin the
    // car around — so the assist stands down and the tires have it.
    if (alongFwd <= 0) return;

    const slip = Math.atan2(this._yawVel.dot(this._yawLat), alongFwd);
    const absSlip = Math.abs(slip);
    const sign = slip >= 0 ? 1 : -1;
    // Ramp with how much of the car is actually on the surface.
    const contact = grounded * 0.25;
    const drifting = this.input.handbrake;
    const driftMul = drifting ? TIRE.driftYawAssistMul : 1;

    // 1) Alignment — pull the nose toward travel, but only past the deadband so
    //    ordinary cornering is still decided by the tires.
    let mag = 0;
    const over = absSlip - TIRE.alignDeadband;
    if (over > 0) mag += over * TIRE.alignTorque * driftMul;

    // 2) Slip clamp — past slipMax the assist ramps hard. NOT scaled by
    //    driftMul: a drift should be holdable, not become a spin.
    const past = absSlip - TIRE.slipMax;
    if (past > 0) mag += past * TIRE.slipClampTorque;

    let torque = sign * mag;

    // 3) Yaw-rate damping against the rate the STEERING is asking for (bicycle
    //    model). Damping the raw rate would fight the driver's own cornering;
    //    damping the error only removes the overshoot that starts the pendulum.
    const yawRate = body.angVel.dot(this._yawN);
    const refRate = (speed * Math.tan(this._steerAngle())) / WHEELBASE;
    torque -= (yawRate - refRate) * TIRE.yawRateDamp * driftMul;

    body.torqueAccum.addScaledVector(this._yawN, torque * TIRE.yawAssist * contact);
  }

  /**
   * Landing help — touchdown absorption, and predictive alignment while falling.
   * See the LANDINGS block on TIRE for what each half is for.
   */
  _applyLandingAssist() {
    const body = this.body;
    let grounded = 0;
    this._landN.set(0, 0, 0);
    for (const t of this.tires) {
      if (!t.grounded) continue;
      grounded++;
      this._landN.add(t.hitNormal);
    }

    if (grounded > 0) {
      // ── Touchdown: fires on the airborne→grounded edge only ──
      const justLanded = this._prevGrounded === 0;
      this._prevGrounded = grounded;
      if (!justLanded || this._landN.lengthSq() < 1e-8) return;
      if (TIRE.landingAbsorb <= 0) return;
      this._landN.normalize();
      const vN = body.vel.dot(this._landN); // negative = still closing on the surface
      if (vN >= -TIRE.landingMinSpeed) return; // gentle contact — leave it alone
      body.vel.addScaledVector(this._landN, -vN * TIRE.landingAbsorb);
      if (TIRE.landingAngDamp > 0) {
        // Tilt rate only. Stripping yaw out keeps a landing mid-flat-spin spinning.
        this._landUp.set(0, 1, 0).applyQuaternion(body.quat);
        const wYaw = body.angVel.dot(this._landUp);
        this._landTilt.copy(body.angVel).addScaledVector(this._landUp, -wYaw);
        body.angVel.addScaledVector(this._landTilt, -TIRE.landingAngDamp);
      }
      return;
    }

    this._prevGrounded = 0;
    if (TIRE.airLandAssist <= 0 || TIRE.airLandTorque <= 0) return;

    // ── Airborne: align to whatever we're about to land on ──
    // Probe along the flight path when genuinely descending, else straight down.
    // A mostly-horizontal probe would find a wall rather than the landing.
    this._landDir.copy(body.vel);
    if (this._landDir.y > -1 || this._landDir.lengthSq() < 1e-6) this._landDir.set(0, -1, 0);
    else this._landDir.normalize();

    const hit = this._castGround(body.pos, this._landDir, TIRE.airLandRange);
    if (!hit) return;
    const engage = 1 - Math.min(1, (hit.distance ?? 0) / Math.max(0.1, TIRE.airLandRange));
    if (engage <= 0) return;

    if (hit.normal) this._landN.set(hit.normal.x, hit.normal.y, hit.normal.z);
    else if (hit.face?.normal) this._landN.copy(hit.face.normal);
    else this._landN.set(0, 1, 0);
    if (this._landN.lengthSq() < 1e-8) return;
    this._landN.normalize();
    // Triangles can be wound either way — face the normal back toward us.
    if (this._landN.dot(this._landDir) > 0) this._landN.negate();

    this._landUp.set(0, 1, 0).applyQuaternion(body.quat);
    this._landTorque
      .crossVectors(this._landUp, this._landN)
      .multiplyScalar(TIRE.airLandTorque * engage * TIRE.airLandAssist);
    const wYaw = body.angVel.dot(this._landUp);
    this._landTilt.copy(body.angVel).addScaledVector(this._landUp, -wYaw);
    this._landTorque.addScaledVector(this._landTilt, -TIRE.airLandDamp * engage);
    body.torqueAccum.add(this._landTorque);
  }

  _applyStabilizer(dt = FIXED_DT / this.SUBSTEPS) {
    const body = this.body;
    let grounded = 0;
    this._stabN.set(0, 0, 0);
    for (const t of this.tires) {
      if (t.grounded) {
        grounded++;
        this._stabN.add(t.hitNormal);
      }
    }
    this._stabUp.set(0, 1, 0).applyQuaternion(body.quat);

    if (grounded > 0) {
      this._airTime = 0;
      if (TIRE.stabilizerStrength <= 0 || this._stabN.lengthSq() < 1e-8) return;
      // Align chassis-up to the averaged ground normal (banks/loops follow the
      // surface), with damping on the roll/pitch rate but not on yaw (steering).
      this._stabN.normalize();
      // Alignment ramps with contact count, and is OFF at a single wheel: one
      // wheel clipping a guardrail or hanging over an edge would otherwise yank
      // the whole chassis toward that one triangle's normal at full strength.
      // Unchanged at four wheels, so the existing on-track tune carries over.
      const align = grounded >= 2 ? grounded * 0.25 : 0;
      this._stabTorque.set(0, 0, 0);
      if (align > 0) {
        this._stabCross.crossVectors(this._stabUp, this._stabN);
        this._stabTorque.addScaledVector(this._stabCross, TIRE.stabilizerStrength * align);
      }
      // Roll/pitch damping stays on at ANY contact count — it only removes
      // energy, and it's what stops a one-wheel touch starting a tumble.
      const wYaw = body.angVel.dot(this._stabUp);
      this._stabWTilt.copy(body.angVel).addScaledVector(this._stabUp, -wYaw);
      this._stabTorque.addScaledVector(this._stabWTilt, -TIRE.stabilizerDamp);
      body.torqueAccum.add(this._stabTorque);
    } else {
      // ── Airborne: RATE-BASED control (see the AIRBORNE CONTROL block on TIRE) ──
      // Per axis: pick a target rotation RATE from the input, then push the
      // actual rate toward it. Torque is scaled by that axis's inertia so the
      // resulting angular ACCELERATION is identical on all three — which is the
      // whole point, since roll's inertia is 3.7× smaller than pitch's and the
      // old flat-torque model therefore gave roll 4× the authority.
      this._airTime += dt;
      this._airRight.set(1, 0, 0).applyQuaternion(body.quat); // pitch axis
      this._airFwd.set(0, 0, 1).applyQuaternion(body.quat);   // roll axis
      // _stabUp is the yaw axis, already computed above.

      // A bounce is not a trick: time from the last CONTACT, not from zero
      // airborne time, so no bounce can ever re-arm control mid-landing.
      const armed = this._airTime >= TIRE.airGroundLockout;
      const inP = armed ? -this.input.throttle : 0;
      const inR = armed ? this.input.steer : 0;
      const inY = this.input.yaw; // Q/E is deliberate stunt input — never gated

      // Diagonal inertia in body-local axes (x pitch, y yaw, z roll).
      const li = body.localInvInertia.elements;
      const Ip = 1 / (li[0] || 1e-6);
      const Iy = 1 / (li[4] || 1e-6);
      const Ir = 1 / (li[8] || 1e-6);

      const axis = (unit, input, rate, inertia) => {
        const cur = body.angVel.dot(unit);
        const target = input * rate;
        // Softer convergence when the axis is idle, so a knock still tumbles
        // naturally rather than freezing the moment you release.
        const gain = input !== 0 ? TIRE.airResponse : TIRE.airSettle;
        this._stabTorque.addScaledVector(unit, (target - cur) * gain * inertia);
      };

      this._stabTorque.set(0, 0, 0);
      axis(this._airRight, inP, TIRE.airPitchRate, Ip);
      axis(this._airFwd, inR, TIRE.airRollRate, Ir);
      axis(this._stabUp, inY, TIRE.airYawRate, Iy);
      body.torqueAccum.add(this._stabTorque);
    }
  }

  _applyChassisGroundContact() {
    const body = this.body;
    for (const corner of this.CHASSIS_CORNERS) {
      this._geomToWorld(corner, this._cWorld);
      const floorY = this.getFloorY ? this.getFloorY(this._cWorld.x, this._cWorld.z) : 0;
      if (this._cWorld.y >= floorY) continue;
      const pen = floorY - this._cWorld.y;
      body.getVelocityAtPoint(this._cWorld, this._cVel);
      const dampMag = Math.max(0, -this._cVel.y) * this.CORNER_DAMPER;
      const upMag = pen * this.CORNER_SPRING + dampMag;
      this._cF.set(0, upMag, 0);
      body.addForceAtPoint(this._cF, this._cWorld);
      this._cVelHoriz.set(this._cVel.x, 0, this._cVel.z);
      const horizSpeed = this._cVelHoriz.length();
      if (horizSpeed > 0.01) {
        this._cVelHoriz.multiplyScalar(1 / horizSpeed);
        const fricMag = -this.CORNER_FRICTION * upMag;
        this._cF.set(this._cVelHoriz.x * fricMag, 0, this._cVelHoriz.z * fricMag);
        body.addForceAtPoint(this._cF, this._cWorld);
      }
    }
  }

  _applyWallProbes() {
    const body = this.body;
    for (const p of this.PROBE_LOCALS) {
      this._geomToWorld(p.pos, this._probeOrigin);
      this._probeDirW.copy(p.dir).applyQuaternion(body.quat);
      this.raycaster.ray.origin.copy(this._probeOrigin);
      this.raycaster.ray.direction.copy(this._probeDirW);
      this.raycaster.far = WALL.probeRange;
      const hits = this.raycaster.intersectObjects(this.walls, false);
      if (hits.length === 0) continue;
      const hit = hits[0];
      const pen = WALL.probeRange - hit.distance;
      if (pen <= 0) continue;
      body.getVelocityAtPoint(hit.point, this._probeVel);
      const inwardVel = this._probeVel.dot(this._probeDirW);
      const dampMag = Math.max(0, inwardVel) * WALL.damper;
      const forceMag = pen * WALL.stiffness + dampMag;
      this._probeF.copy(this._probeDirW).multiplyScalar(-forceMag);
      body.addForceAtPoint(this._probeF, hit.point);
      if (pen > WALL.probeRange * WALL.clampPenFrac) {
        const vInto = body.vel.dot(this._probeDirW);
        if (vInto > 0) body.vel.addScaledVector(this._probeDirW, -vInto);
      }
    }
  }

  _applyAero() {
    const v = this.body.vel;
    const sp = v.length();
    if (sp < 1e-3) return;
    if (AERO.drag > 0) {
      this._aeroF.copy(v).multiplyScalar(-AERO.drag * sp); // -drag·sp·v  (∝ sp²)
      this.body.addForce(this._aeroF);
    }
    // Downforce presses along -chassis-up, so it is only meaningful while there
    // is a surface to be pressed ONTO. Airborne it becomes thrust along whatever
    // way the car happens to be pointing — inverted over a loop exit it shoved
    // the car UP — which is why air behaviour read as unpredictable. Scale it by
    // how many wheels are actually in contact: full grip = full downforce, all
    // four wheels off = none, and the ramp between keeps a crest from stepping
    // the force discontinuously.
    if (AERO.downforce > 0) {
      const contact = this.groundedCount * 0.25;
      if (contact > 0) {
        this._aeroUp.set(0, 1, 0).applyQuaternion(this.body.quat);
        this._aeroF.copy(this._aeroUp).multiplyScalar(-AERO.downforce * sp * sp * contact);
        this.body.addForce(this._aeroF);
      }
    }
  }

  _applyDeckContact() {
    const body = this.body;
    const skin = DECK.skin;
    for (const ci of this.BOTTOM_CORNERS) {
      this._geomToWorld(this.CHASSIS_CORNERS[ci], this._cWorld);
      const res = this.groundBvh.closestPointWithNormal(
        this._cWorld.x, this._cWorld.y, this._cWorld.z, DECK.searchRadius, this._deckN,
      );
      if (!res) continue;
      // Signed distance from surface to corner along the (outward) normal.
      const sd =
        (this._cWorld.x - res.x) * this._deckN.x +
        (this._cWorld.y - res.y) * this._deckN.y +
        (this._cWorld.z - res.z) * this._deckN.z;
      if (sd >= skin) continue; // corner safely above the deck → wheels handle it
      const pen = skin - sd;
      body.getVelocityAtPoint(this._cWorld, this._cVel);
      const inward = -this._cVel.dot(this._deckN);
      const dampMag = Math.max(0, inward) * DECK.damper;
      const forceMag = pen * DECK.stiffness + dampMag;
      this._cF.copy(this._deckN).multiplyScalar(forceMag);
      body.addForceAtPoint(this._cF, this._cWorld);
    }
  }

  _resolveSolids(dt) {
    if (SOLID.enabled && this.solidsBvh?.baked) this._resolveSolidBvh(this.solidsBvh, null, dt);
    for (const mover of this.dynamicMovers) {
      if (mover.bvh?.baked) {
        this._resolveSolidBvh(mover.bvh, (p, out) => mover.velocityAt(p, out), dt);
      }
    }
  }

  _resolveSolidBvh(bvh, surfaceVelFn, dt = FIXED_DT / this.SUBSTEPS) {
    const body = this.body;
    const r = SOLID.radius;
    // Penetration-weighted mean contact normal + deepest penetration, for the
    // aggregate response after the sample loop.
    let maxPen = 0;
    this._solidN.set(0, 0, 0);
    for (const sp of this.SOLID_BOX_SAMPLES) {
      this._geomToWorld(sp, this._sphC);
      const res = bvh.closestPointWithNormal(
        this._sphC.x, this._sphC.y, this._sphC.z, r, this._sphN,
      );
      if (!res) continue;
      const pen = r - res.distance;
      if (pen <= 0) continue;
      this._solidN.addScaledVector(this._sphN, pen);
      if (pen > maxPen) maxPen = pen;
      body.getVelocityAtPoint(this._sphC, this._sphV);
      if (surfaceVelFn) {
        surfaceVelFn(this._sphC, this._surfV);
        this._sphV.sub(this._surfV);
      }
      const inward = -this._sphV.dot(this._sphN);
      const dampMag = Math.max(0, inward) * SOLID.damper;
      const forceMag = pen * SOLID.stiffness + dampMag;
      this._sphF.copy(this._sphN).multiplyScalar(forceMag);
      body.addForceAtPoint(this._sphF, this._sphC);
      if (surfaceVelFn && pen > 0.02) {
        surfaceVelFn(this._sphC, this._surfV);
        body.vel.addScaledVector(this._surfV, Math.min(0.4, pen * 1.8));
      }
      if (pen > r * SOLID.clampPenFrac) {
        const vInto = body.vel.dot(this._sphN);
        if (vInto < 0) body.vel.addScaledVector(this._sphN, -vInto);
        if (surfaceVelFn) {
          surfaceVelFn(this._sphC, this._surfV);
          body.vel.addScaledVector(this._surfV, 0.12);
        }
      }
    }

    // ── Aggregate contact response ────────────────────────────────────────
    // STATIC solids only. A moving wall is *supposed* to impart its velocity,
    // so capping its exit speed would fight the mover push above.
    if (surfaceVelFn || maxPen <= 0 || this._solidN.lengthSq() < 1e-12) return;
    this._solidN.normalize();

    // Cap the rebound. Outward only — a negative vN means the car is still
    // heading INTO the wall, which the springs are there to deal with.
    const vN = body.vel.dot(this._solidN);
    if (vN > SOLID.maxExitSpeed) {
      body.vel.addScaledVector(this._solidN, SOLID.maxExitSpeed - vN);
    }

    // Scrub speed along the wall so a graze costs something.
    if (SOLID.tangentScrub > 0 && dt > 0) {
      const vn2 = body.vel.dot(this._solidN);
      this._solidT.copy(body.vel).addScaledVector(this._solidN, -vn2);
      this._solidT.multiplyScalar(Math.exp(-SOLID.tangentScrub * dt));
      body.vel.copy(this._solidT).addScaledVector(this._solidN, vn2);
    }
  }

  _depenetrateFromWalls() {
    const c = this.body.pos;
    for (const box of this.wallBoxes) {
      if (c.x < box.min.x || c.x > box.max.x) continue;
      if (c.y < box.min.y || c.y > box.max.y) continue;
      if (c.z < box.min.z || c.z > box.max.z) continue;
      const dxMin = c.x - box.min.x, dxMax = box.max.x - c.x;
      const dzMin = c.z - box.min.z, dzMax = box.max.z - c.z;
      let minD = dxMin;
      this._depenDir.set(-1, 0, 0);
      if (dxMax < minD) { minD = dxMax; this._depenDir.set(1, 0, 0); }
      if (dzMin < minD) { minD = dzMin; this._depenDir.set(0, 0, -1); }
      if (dzMax < minD) { minD = dzMax; this._depenDir.set(0, 0, 1); }
      c.addScaledVector(this._depenDir, minD + 0.05);
      const vDot = this.body.vel.dot(this._depenDir);
      if (vDot < 0) this.body.vel.addScaledVector(this._depenDir, -vDot);
    }
  }

  /**
   * Sync meshes to the body pose, interpolated `alpha` (0..1) of the way from
   * the previous fixed tick to the current one. `dt` is the RENDER dt — it
   * only drives visual smoothing (suspension ease, wheel spin), not physics.
   */
  syncVisuals(dt, alpha = 1) {
    const body = this.body;
    this._updateTaillights();
    this._renderPos.lerpVectors(this._prevPos, body.pos, alpha);
    this._renderQuat.slerpQuaternions(this._prevQuat, body.quat, alpha);
    this._geomCenter.copy(_COM_OFFSET).applyQuaternion(this._renderQuat).add(this._renderPos);
    this.chassisMesh.position.copy(this._geomCenter);
    if (CHASSIS.visualLift !== 0) {
      this._wheelUp.set(0, 1, 0).applyQuaternion(this._renderQuat);
      this.chassisMesh.position.addScaledVector(this._wheelUp, CHASSIS.visualLift);
    }
    // Body lean goes on the CHASSIS ONLY. The wheels below are placed from
    // _renderQuat, so they stay planted while the body rolls over them — which
    // is the whole effect. Post-multiplying applies the lean in the chassis'
    // own frame, and the lights parented to this mesh come along for free.
    this._updateBodyLean(dt);
    this.chassisMesh.quaternion.copy(this._renderQuat);
    if (this._leanRoll !== 0 || this._leanPitch !== 0) {
      this._leanQRoll.setFromAxisAngle(this._zAxis, this._leanRoll);
      this._leanQPitch.setFromAxisAngle(this._xAxis, this._leanPitch);
      this.chassisMesh.quaternion.multiply(this._leanQRoll).multiply(this._leanQPitch);
    }

    const steerAngle = this._steerAngle();
    for (let i = 0; i < this.tires.length; i++) {
      const t = this.tires[i];
      const cfg = WHEEL_LOCAL[i];
      this._wheelUp.copy(this._yAxis).applyQuaternion(this._renderQuat);
      const targetDist = t.grounded ? t.hitDistance : TIRE.rayLength;
      if (t._smoothDist === undefined) t._smoothDist = targetDist;
      const k = 1 - Math.exp(-TIRE.suspVisSmooth * dt);
      t._smoothDist += (targetDist - t._smoothDist) * k;
      const suspExt = Math.max(0, t._smoothDist - WHEEL.radius);
      this._wheelOffset.copy(this._wheelUp).multiplyScalar(-suspExt);
      // Hub position recomputed from the INTERPOLATED pose (t.worldPos is the
      // tick-time position and would lag the interpolated chassis).
      this._renderWheelPos
        .copy(t.localPos)
        .sub(_COM_OFFSET)
        .applyQuaternion(this._renderQuat)
        .add(this._renderPos);
      this.tireGroups[i].position.copy(this._renderWheelPos).add(this._wheelOffset);

      this._wheelFwdWorld.copy(this._zAxis).applyQuaternion(this._renderQuat);
      if (cfg.steer && steerAngle !== 0) {
        this._steerLocalQ.setFromAxisAngle(this._wheelUp, steerAngle);
        this._wheelFwdWorld.applyQuaternion(this._steerLocalQ);
      }
      body.getVelocityAtPoint(t.worldPos, this._wheelTireVel);
      const omega = this._wheelTireVel.dot(this._wheelFwdWorld) / WHEEL.radius;
      this.wheelSpin[i] += omega * dt;
      if (this.wheelSpin[i] > Math.PI * 2) this.wheelSpin[i] -= Math.PI * 2;
      else if (this.wheelSpin[i] < -Math.PI * 2) this.wheelSpin[i] += Math.PI * 2;

      this._spinLocalQ.setFromAxisAngle(this._xAxis, this.wheelSpin[i]);
      if (cfg.steer) {
        this._steerLocalQ.setFromAxisAngle(this._yAxis, steerAngle);
        this.tireGroups[i].quaternion.multiplyQuaternions(this._renderQuat, this._steerLocalQ).multiply(this._spinLocalQ);
      } else {
        this.tireGroups[i].quaternion.multiplyQuaternions(this._renderQuat, this._spinLocalQ);
      }

      if (this.arrowGroup.visible) {
        const a = this.arrows[i];
        this._placeArrow(a.up, t.worldPos, t.lastSuspension);
        this._placeArrow(a.side, t.worldPos, t.lastSteering);
        this._placeArrow(a.fwd, t.worldPos, t.lastAccel);
      }
    }

    // The loop above posed the tireGroups; push those poses into the instanced
    // meshes that actually draw the wheels.
    this._syncWheelInstances();
  }

  /**
   * Ease the cosmetic lean angles toward the load the tires are ALREADY
   * reporting — `lastSteering` / `lastAccel` are the real per-wheel forces from
   * this tick, so the lean tracks weight transfer for free instead of guessing
   * at it from acceleration.
   *
   * Signs: +X is the chassis' left (forward is +Z), and a positive rotation
   * about +Z lifts +X. Cornering left loads the tires toward +X and the body
   * should roll onto its right, lifting the left — so roll follows lateral load
   * directly. Pitch is inverted: accelerating (+Z load) lifts the nose, and a
   * positive rotation about +X drops +Z.
   */
  _updateBodyLean(dt) {
    if (!BODYLEAN.enabled) {
      this._leanRoll = 0;
      this._leanPitch = 0;
      return;
    }
    this._leanRight.copy(this._xAxis).applyQuaternion(this._renderQuat);
    this._leanFwd.copy(this._zAxis).applyQuaternion(this._renderQuat);
    let lat = 0;
    let lon = 0;
    for (const t of this.tires) {
      if (!t.grounded) continue;
      lat += t.lastSteering.dot(this._leanRight);
      lon += t.lastAccel.dot(this._leanFwd);
    }
    // Normalise by weight so the angles read in g and survive a mass edit.
    const w = CHASSIS.mass * GRAVITY;
    const rollTgt = THREE.MathUtils.clamp(
      (lat / w) * BODYLEAN.rollPerG, -BODYLEAN.maxRoll, BODYLEAN.maxRoll,
    );
    const pitchTgt = THREE.MathUtils.clamp(
      (-lon / w) * BODYLEAN.pitchPerG, -BODYLEAN.maxPitch, BODYLEAN.maxPitch,
    );
    const k = 1 - Math.exp(-BODYLEAN.smooth * dt);
    this._leanRoll += (rollTgt - this._leanRoll) * k;
    this._leanPitch += (pitchTgt - this._leanPitch) * k;
  }

  _placeArrow(arrow, origin, force) {
    const mag = force.length();
    if (mag < 1e-3) {
      arrow.setLength(0.001, 0.001, 0.001);
      return;
    }
    this._arrowDir.copy(force).normalize();
    arrow.position.copy(origin);
    arrow.setDirection(this._arrowDir);
    const visLen = Math.min(3.5, mag * 0.0008);
    arrow.setLength(visLen, Math.min(0.25, visLen * 0.18), Math.min(0.16, visLen * 0.12));
  }

  /** Signed km/h forward speed for a HUD. */
  get speedKmh() {
    return this.body.vel.length() * 3.6;
  }

  get groundedCount() {
    return this.tires.reduce((n, t) => n + (t.grounded ? 1 : 0), 0);
  }
}
