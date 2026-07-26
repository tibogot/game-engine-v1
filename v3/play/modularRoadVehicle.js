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

/**
 * Hub |x| — HALF the track width, and the one wheel-layout number that is
 * genuinely a look-vs-feel tradeoff, so it is live-tunable (dev panel → Track
 * width) rather than baked into WHEEL_LOCAL.
 *
 * 1.05 was the procedural box's value and it puts the wheel CENTRE exactly on
 * the GLB body's side (half-width 1.05), so half of each tyre hangs outside the
 * bodywork. 0.92 tucks the outer edge roughly flush, which is the GT4 look.
 * For reference the real Emira's track is 1.63 m (half 0.81) — narrower still,
 * but that far in starts to look like the wheels are sunk into the arches.
 *
 * It is NOT purely cosmetic: track width is the lever arm for weight transfer,
 * so narrowing it lowers roll resistance and the rollover threshold together.
 */
export const WHEEL_LAYOUT = { halfTrack: 0.92 };

/** Wheel hubs in chassis-local space. z>0 = front. `pos.x` is rewritten by
 *  Vehicle.applyWheelLayout() — read it, don't hardcode it. */
export const WHEEL_LOCAL = [
  { name: "FL", pos: new THREE.Vector3(-0.92, -0.1, 1.4), steer: true, drive: true },
  { name: "FR", pos: new THREE.Vector3(0.92, -0.1, 1.4), steer: true, drive: true },
  { name: "RL", pos: new THREE.Vector3(-0.92, -0.1, -1.4), steer: false, drive: true },
  { name: "RR", pos: new THREE.Vector3(0.92, -0.1, -1.4), steer: false, drive: true },
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
  /**
   * Target top speed (m/s). NOT the speed you actually reach: the power curve's
   * falling drive force meets quadratic drag a little below it, so 50 settles at
   * ~48.3 m/s ≈ 174 km/h. (The model is verified — it predicted 107 km/h at the
   * old value of 30, which is exactly what the HUD showed.) `AERO.drag` is the
   * knob if you want the readout to land on a rounder number.
   *
   * WHAT THIS IS AND ISN'T CONSTRAINED BY. A FLAT corner of the kit's standard
   * `curveRadius: 26` m caps at √(26 × 1.5g) ≈ 19.5 m/s ≈ 70 km/h regardless of
   * this number — that is a brake zone by design, and the speed differential
   * between a 174 km/h straight and a 70 km/h hairpin is drama, not a bug.
   *
   * High-speed cornering comes from BANKING, which converts the track's normal
   * force into cornering force. On that same 26 m radius:
   *     10° → 87 km/h, 20° → 116 km/h, 25° → 147 km/h
   * The kit already has banked pieces, so nothing needs rebuilding to go fast.
   * (v_max = √(r·g·(tanθ + μ) / (1 − μ·tanθ)); it runs away near μ·tanθ = 1.)
   *
   * HARD CEILING ~70 m/s: above that the chassis starts tunnelling through
   * geometry (0.29 m per substep against an 0.08 m contact skin — measured).
   * Guardrails and decks were verified to hold at 60 m/s, so 45–60 is the safe
   * envelope. Raising past that needs collision work first, not just this number.
   */
  topSpeed: 50,
  powerCurveExp: 2.0,
  brakeForce: 8000,
  reverseAccel: 2000,
  brakeReverseThreshold: 0.5,
  engineBrake: 800,
  /**
   * Steering lock at a standstill (rad). 0.95 ≈ 54°.
   *
   * DRIFT-CAR LOCK, NOT STOCK-CAR LOCK — this is what makes donuts possible.
   * The tightest circle a car can pivot is geometric: `wheelbase / tan(lock)`.
   * At the old 0.55 (31.5°) that floor was 4.6 m, and a donut needs ~1.5–3 m,
   * so no amount of power or drift tuning could produce one. Measured circle
   * radius, full lock + throttle held:
   *     31.5° → 6.7 m,  45° → 4.7 m,  55° → 3.8 m,  65° → 3.0 m
   *
   * Real drift cars fit steering-angle kits for exactly this reason (50–65°
   * versus ~35° stock), so this is the realistic value for the car this is.
   *
   * NOTE the yaw assist was NOT the blocker — measured, reducing it actually
   * WIDENS the circle (it keeps the nose aligned so the car corners properly
   * instead of ploughing). Don't "fix" donuts by weakening the assist.
   *
   * The extra lock donuts need is NOT applied here — see `lowSpeedExtraLock`.
   * Raising THIS value raises the whole curve, which is a driving-feel change
   * at every speed; the donut requirement is purely a standstill one.
   */
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
  // KEEP THIS TRACKING `topSpeed` — full reduction should land AT top speed, so
  // it scales with it (26 was the value for topSpeed 30; 45 for 50). Leaving it
  // low would fully numb the wheel across the entire upper half of the speed
  // range instead of easing into it.
  //
  // KEEP THIS TRACKING `topSpeed` — full reduction should land AT top speed, so
  // it scales with it (26 was the value for topSpeed 30; 45 for 50).
  steerSpeedRef: 45,
  steerSpeedReduce: 0.50,

  // ── LOW-SPEED LOCK BOOST (donuts) ───────────────────────────────────────────
  // Donuts need ~50° of lock; ordinary driving wants ~25°. Those two facts are
  // only compatible because they happen at DIFFERENT SPEEDS — a donut is a
  // 4–6 m/s manoeuvre and a corner is a 20–40 m/s one.
  //
  // THIS WAS ORIGINALLY DONE WRONG, and the way it failed is worth keeping:
  // the first attempt raised `maxSteerAngle` 0.55 → 0.95 and raised
  // `steerSpeedReduce` 0.50 → 0.70 to compensate. The compensation was verified
  // AT TOP SPEED ONLY (15.8° → 16.3°, fine) — but the reduction is a straight
  // line to `steerSpeedRef`, so it barely bites in between. The mid-range, where
  // the car is actually driven, gained 38–64% more lock and went twitchy:
  //     10 m/s  28.0° → 46.0°   20 m/s  24.5° → 37.5°   30 m/s  21.0° → 29.0°
  // Checking the endpoints of a curve does not check the curve.
  //
  // So the boost is ADDITIVE and dies off before normal driving speeds instead
  // of scaling the whole range. Above `lowSpeedLockRef` the angle is EXACTLY
  // what it was before donuts existed. The falloff is quadratic (1 − t²) rather
  // than linear so lock is held near full through the 4–6 m/s the manoeuvre
  // actually lives at, then drops away quickly:
  //     0 m/s 54.4°   4 m/s 49.4° (≈2.4 m circle)   10 m/s 28.0° = pre-donut
  /** Extra lock (rad) at a standstill, on top of the normal curve. */
  lowSpeedExtraLock: 0.40,
  /**
   * Speed (m/s) at which the boost has fully decayed. Above this the steering is
   * bit-for-bit the pre-donut curve.
   *
   * MEASURED, not guessed — a held donut SETTLES at ~5.4 m/s rather than
   * accelerating away, so the cutoff only has to clear that. Sweep of cutoff vs
   * donut radius vs how far the boost intrudes into ordinary driving:
   *     ref 10 → 5.3 m   ref 12 → 4.4 m   ref 14 → 4.1 m   ref 20 → 3.9 m
   * Tightness saturates around 14 — going higher buys ~0.2 m of circle and
   * starts leaking lock into real cornering (ref 16 already puts +2.8° at
   * 15 m/s, ref 20 puts +10°). 14 is therefore the largest cutoff that still
   * leaves every driving speed untouched: cornering happens at 17 m/s and up
   * (the user's own 60 km/h corner), so the boost is long gone by then.
   */
  lowSpeedLockRef: 14,
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
  // ── AIRBORNE CONTROL — RATE-BASED (Shift/Ctrl pitch, A/D roll, Q/E yaw) ──
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
   * DELIBERATELY TINY — it exists only to swallow single-frame ground flicker on
   * rough surfaces, not to gate tricks. It was 0.45 s when the rate model landed,
   * because the torque model needed a long lockout to stop a landing bounce from
   * winding roll up; measured afterwards, the rate model alone does that job:
   *
   *   lockout 0.45s → peak roll after landing+steer 1.01 rad/s
   *   lockout 0.00s → 1.21 rad/s        (the original bug was 7.00)
   *
   * So the lockout was buying almost nothing and costing half a second of dead
   * input — flips only started 0.48 s after leaving the ground. At 0.05 s a flip
   * starts in ~0.08 s, i.e. as soon as you press.
   */
  airGroundLockout: 0.05,
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
  /**
   * 'FWD' | 'RWD' | 'AWD'.
   *
   * RWD by default because this is a DRIFT game and the drivetrain is what
   * decides whether drifting is something the car does or something you have to
   * ask the handbrake for. The old AWD default made it the latter — worse, its
   * `powerBias: 0.4` was FRONT-leaning, so most of the drive went to the wheels
   * that are not supposed to break loose.
   *
   * The rear axle cannot hold the full drive force, and that is the point:
   *     rear static load   6867 N
   *     rear grip budget  10301 N   (μ 1.5)
   *     full drive force  16000 N   ← all of it on the rear in RWD
   * The friction circle clamps the excess, which is wheelspin and power-over —
   * drift as an emergent property of the tyre model rather than a special case.
   *
   * KNOWN TRADEOFF: standing starts are slower (drive is capped near 10.3 kN
   * instead of ~16 kN spread over four wheels) and corner exits need catching
   * on the throttle. `gripRear` is the trim knob if the tail is too loose.
   */
  layout: "RWD",
  /** Rear power fraction, AWD only (0 = all front … 1 = all rear). Ignored for
   *  FWD/RWD, which are hard 0 and 1. */
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
  // HALVED once the GLB body landed. These values were set against the plain
  // box, where a big lean was the only way to read weight transfer at all. On a
  // real car silhouette the same angles look like the suspension has failed —
  // a GT4 rolls ~1.5–2.5°/g, not the 5.7°/g the box was using.
  /** Radians of roll per g of lateral load. 0.045 ≈ 2.6°/g. */
  rollPerG: 0.045,
  /** Radians of pitch per g of longitudinal load (squat / dive). ≈1.7°/g. */
  pitchPerG: 0.03,
  maxRoll: 0.08, // ~4.6°
  maxPitch: 0.05, // ~2.9°
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
/**
 * DRIFT VISUALS — cosmetic only, zero effect on handling.
 *
 * In a real drift the driver countersteers, and the reason is mechanical: with
 * the body at a big slip angle, leaving the front wheels aligned with the body
 * would put THEM at that same slip angle too, saturate them, and the car would
 * just spin. Aiming them along the direction of travel keeps the front tyres
 * near zero slip — still gripping, still steering — while the rears slide.
 * "Front wheels pointing down the road while the body is sideways" is the
 * visual signature of that, and it's what makes a drift read as a drift.
 *
 * The physics here already lets the player do this with the steering keys. This
 * block only makes the WHEEL MESHES take up part of the slip angle on their
 * own, so the pose looks right even when the yaw assist means the player didn't
 * need much input. It rotates meshes and nothing else — `_steerAngle()`, which
 * is what the tyres actually use, is untouched.
 */
export const DRIFT = {
  /** Fraction of the slip angle the front wheels visually take up. 0 = off. */
  counterSteerVisual: 0.7,
  /** Slip (rad) below which nothing is added — ordinary cornering must not get
   *  a permanent cosmetic offset. ~3.5°. */
  counterDeadband: 0.06,
  /** Cap on total visual steer (rad). A little past physical lock is fine —
   *  nothing reads this but the renderer. ~43°. */
  maxVisualSteer: 0.75,
  /** Ease rate (1/s) so the wheels don't snap between poses. */
  visualSmooth: 12,
};

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

/**
 * Emissive drive for the GLB body's OWN lights (games/modular-road-v3/
 * chassisModel.js). Separate from TAILLIGHTS because the model's tail-light
 * material already carries an emissive texture at strength 3.64, so it reaches
 * the same on-screen brightness from a much lower multiplier than the flat
 * procedural quads need.
 */
export const CHASSIS_GLB_LIGHTS = {
  /** Tail lights: dim glow while the headlights are on. */
  runningIntensity: 1.0,
  /** Tail lights: flare under brake / handbrake. */
  brakeIntensity: 5.0,
  /** Headlight LENS emissive when lit — the lenses are glass in the file, not
   *  emissive, so this is what makes them read as switched on. 0 = plain glass. */
  headlampIntensity: 3.0,
  headlampColor: "#fff2d6",
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
/**
 * Chassis vs solids (guardrails, tunnel walls) AND vs the deck.
 *
 * PROJECTION-based, not spring-based. The old model put a `radius: 0.4` sphere
 * on each of 26 box samples and pushed with `pen × 260000` N. Three things were
 * wrong with that, all of them things you could feel:
 *
 *  • A 0.4 m force field. Force began at 0.4 m of CLEARANCE, in every direction,
 *    inflating the 1.8×0.6×3.6 chassis to an effective 2.6×1.4×4.4 — about 4×
 *    the volume. The car was shoved by geometry it wasn't touching, and it
 *    floated above rails instead of sitting on them. It also erased shape: the
 *    distance field 0.4 m outside a sharp ridge is a smooth rounded blob, so the
 *    guardrail's peaked cap could never do its job.
 *  • Springs store energy. A buried sample pushes ~78 kN (5.7× the car's weight)
 *    and 26 of them stack — measured launches to 22 m, 40 m, 161 m.
 *  • Opposing normals cancel exactly, so a wedged car sat in equilibrium under
 *    enormous forces with no escape direction.
 *
 * Projection has none of those failure modes: it moves the body out by the
 * overlap and removes the into-surface velocity. It cannot store energy, so it
 * cannot launch; and because the skin is thin, the collider matches the car.
 */
export const SOLID = {
  enabled: true,
  /** Contact skin (m). This IS the collider inflation — keep it small. */
  skin: 0.08,
  /**
   * Anti-tunnel margin, as a multiple of the distance travelled per substep.
   *
   * A skin alone cannot stop a fast car: at 30 m/s the body advances 0.125 m per
   * substep, which is bigger than the 0.08 m skin, so a sample sits outside the
   * band one substep and past the surface the next — it never registers at all.
   * That is how cars drove through tube walls and guardrails.
   *
   * So detection uses a WIDER band than the skin. Anything inside the band and
   * closing gets its inward velocity clamped so it cannot cross before the next
   * substep; only things inside the actual SKIN get pushed out positionally.
   * Splitting the two is what keeps the collider tight (shape still matters, no
   * floating) while making it impossible to step over.
   */
  sweepMargin: 1.6,
  /** Fraction of the overlap corrected per substep. <1 damps jitter when several
   *  samples disagree; 1 is instant but can buzz on concave corners. */
  push: 0.8,
  /** Bounciness of a chassis hit. 0 = dead stop into the surface (arcade-correct
   *  — a car hitting a wall should not rebound like a ball). */
  restitution: 0.05,
  /** Tangential speed kept per second while scraping (1/s decay). Scraping a
   *  rail should cost some speed; being stuck must not drain everything, so this
   *  ramps with speed via `frictionFullSpeed`. */
  friction: 1.2,
  frictionFullSpeed: 6.0,
  /** Torque from off-centre contacts, as a fraction of the "physically correct"
   *  amount. Full torque makes a rail clip spin the car wildly; 0 makes hits
   *  feel dead. This is deliberately light — the wheels and stabilizer own the
   *  car's attitude, a wall only deflects it. */
  spin: 0.15,
  /** Max rad/s a single contact may impart, so nothing can wind up a tumble. */
  maxSpin: 2.5,
};

/**
 * Stuck detection — the safety net every game in this genre has.
 *
 * Some traps are not solvable in the contact model. Landing balanced on a
 * guardrail is the clearest: the rail lives in the SOLIDS bvh and the wheels
 * only probe the DECK bvh, so there is no traction available up there at all,
 * and pushing the chassis harder just reintroduces the launch bug. Verified
 * permanent — 2000+ physics ticks with throttle held and the car never recovers.
 *
 * The detection signal is unusually clean here BECAUSE of that split: no wheel
 * on a drivable surface, chassis resting on something, barely moving, and the
 * player asking to move. A parked car has its wheels down, so it can never
 * false-positive.
 */
export const STUCK = {
  enabled: true,
  /** Horizontal speed (m/s) below which the car counts as not going anywhere. */
  speed: 1.5,
  /** Seconds of that before a nudge, and before giving up entirely. */
  nudgeAfter: 0.8,
  respawnAfter: 2.5,
  /** Nudge impulse (m/s) along chassis-up and chassis-forward — enough to tip
   *  the car off a rail it is balanced on. */
  nudgeUp: 3.5,
  nudgeForward: 2.0,
  /**
   * Rate (1/s) the timer bleeds off once free. A DECAY, not a reset: the nudge
   * itself pushes the car over `speed`, so a hard reset would restart the clock
   * on every nudge and a car that got freed for a moment and fell straight back
   * into the same trap could loop forever without ever escalating.
   */
  releaseRate: 0.5,
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

    // NOTE — a 'ceiling guard' was tried here and REMOVED. Do not re-add one
    // without reading this.
    //
    // The probe starts `pad` (0.6 m) along chassis-UP and casts along
    // chassis-DOWN, so a car that is inverted or under a slab can hit a road
    // from the wrong side and report a NEGATIVE hub distance. Suspension force
    // is applied along chassis-up regardless — i.e. INTO the surface — which is
    // what fires a car under a road into the sky (measured 87 g / 161 m).
    //
    // Rejecting negative hub distances does fix that. But the SAME geometry
    // occurs legitimately: rolling round a tube or loop, centrifugal load bottoms
    // the strut out and the contact sits slightly above the hub. Rejecting there
    // tears the car off the wall — measured r 97 against a tube wall at r 8, and
    // the loop falling from 49 m to 38 m. Every discriminator tried (a distance
    // tolerance, `_hadGround` continuity) either left the tube broken or stopped
    // firing at all: from inside the chassis frame the two cases are identical.
    //
    // So the tube/loop case wins — it is core gameplay and happens constantly,
    // while landing inverted is rare and already falls into the fall/stuck
    // respawn path. Both the inverted pass-through and the under-road launch are
    // PRE-EXISTING (verified against the pre-session code), not regressions of
    // this work. A real fix needs signed inside/outside queries against closed
    // geometry, not a heuristic on hub distance.

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
    this.input = { steer: 0, throttle: 0, handbrake: false, yaw: 0, pitch: 0 };

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
    // `chassisMesh` is the ANCHOR, not the body: it carries the body transform
    // (position, lean) and EVERY light is parented to it. The visible body is a
    // child, because swapping styles by toggling `visible` on the anchor itself
    // would take the whole subtree — headlights, tail lights — down with it.
    this.chassisMesh = new THREE.Object3D();
    this.group.add(this.chassisMesh);

    this._chassisProc = new THREE.Mesh(
      new THREE.BoxGeometry(CHASSIS.width, CHASSIS.height, CHASSIS.length),
      new THREE.MeshStandardMaterial({ color: 0x5b6cd6, roughness: 0.55, metalness: 0.3 }),
    );
    this._chassisProc.castShadow = true;
    this._chassisProc.receiveShadow = true;
    this.chassisMesh.add(this._chassisProc);
    this._chassisStyle = "procedural";
    this._chassisGlb = null;
    this._chassisGlbParts = null;

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
    const T = TAILLIGHTS;
    this._tlFwd.set(0, 0, 1).applyQuaternion(this.body.quat);
    const vFwd = this.body.vel.dot(this._tlFwd);
    const braking = this.input.handbrake || (this.input.throttle < 0 && vFwd > 0.5);

    // The GLB body brings its own lights, so it drives those instead of the
    // procedural quads — which are hidden in that style (see _applyChassisStyle),
    // otherwise two sets of tail lights overlap inside the model.
    const glb = this._chassisStyle === "glb" ? this._chassisGlbParts : null;
    if (glb) {
      const L = CHASSIS_GLB_LIGHTS;
      const lit = T.enabled
        ? (braking ? L.brakeIntensity : (HEADLIGHTS.enabled ? L.runningIntensity : 0))
        : 0;
      for (const m of glb.brakeLights) m.material.emissiveIntensity = lit;
      const lamp = HEADLIGHTS.enabled ? L.headlampIntensity : 0;
      for (const m of glb.headlampLenses) m.material.emissiveIntensity = lamp;
      return;
    }

    if (!this.taillights.length) return;
    let intensity = 0;
    if (braking) intensity = T.brakeIntensity;
    else if (HEADLIGHTS.enabled) intensity = T.runningIntensity;
    const on = T.enabled && intensity > 0;
    for (const m of this.taillights) {
      m.visible = on;
      m.material.emissiveIntensity = intensity;
    }
  }

  /**
   * Push WHEEL_LAYOUT.halfTrack into both the shared hub table and each Tire's
   * own copy. The Tire clones localPos at construction, so writing only
   * WHEEL_LOCAL would move the VISUALS (syncVisuals reads t.localPos... which is
   * the clone) and leave the physics probes where they were — or vice versa.
   * Both, or neither.
   */
  applyWheelLayout() {
    const hx = WHEEL_LAYOUT.halfTrack;
    for (let i = 0; i < WHEEL_LOCAL.length; i++) {
      const sx = WHEEL_LOCAL[i].pos.x < 0 ? -1 : 1;
      WHEEL_LOCAL[i].pos.x = sx * hx;
      if (this.tires[i]) this.tires[i].localPos.x = sx * hx;
    }
  }

  // ── CHASSIS VISUAL STYLE (procedural box ⇄ GLB body) ────────────────────────

  /** True once a GLB body has been handed over. */
  get hasChassisModel() { return !!this._chassisGlb; }
  get chassisStyle() { return this._chassisStyle; }

  /**
   * Hand over a loaded GLB body (see games/modular-road-v3/chassisModel.js).
   * `parts` carries the model's own light meshes so _updateTaillights can drive
   * them. Unlike the wheel this changes NO physics — the collision box stays
   * CHASSIS.width/height/length, so the body is purely cosmetic and the swap is
   * a true A/B on handling.
   */
  setChassisModel(object, parts = null) {
    if (this._chassisGlb && this._chassisGlb !== object) {
      this.chassisMesh.remove(this._chassisGlb);
    }
    this._chassisGlb = object || null;
    this._chassisGlbParts = parts;
    if (this._chassisGlb) {
      this._chassisGlb.visible = this._chassisStyle === "glb";
      this.chassisMesh.add(this._chassisGlb);
    }
    this._applyChassisStyle();
  }

  /**
   * @param {"procedural"|"glb"} style
   * @returns {string} the style actually applied (falls back if no model loaded)
   */
  setChassisStyle(style) {
    this._chassisStyle = style === "glb" && this._chassisGlb ? "glb" : "procedural";
    this._applyChassisStyle();
    return this._chassisStyle;
  }

  _applyChassisStyle() {
    const useGlb = this._chassisStyle === "glb" && !!this._chassisGlb;
    this._chassisProc.visible = !useGlb;
    if (this._chassisGlb) this._chassisGlb.visible = useGlb;
    // The procedural lamp faces and tail-light quads are sized and placed for the
    // BOX. Against the model they float inside the bodywork, so hand the job to
    // the model's own emissive parts. The SpotLights stay either way — they light
    // the road, which no amount of emissive geometry does.
    for (const m of this.taillights) if (useGlb) m.visible = false;
    for (const m of this.headlamps) m.visible = useGlb ? false : HEADLIGHTS.enabled;
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
    this._solidPoint = new THREE.Vector3();
    this._solidApproachN = new THREE.Vector3();
    this._stuckUp = new THREE.Vector3();
    this._stuckFwd = new THREE.Vector3();
    /** Seconds trapped against geometry while asking to move — see _updateStuck. */
    this._stuckTime = 0;
    this._stuckNudged = false;
    this._solidTouch = false;
    this._solidR = new THREE.Vector3();
    this._solidTorque = new THREE.Vector3();
    this._steerRateFwd = new THREE.Vector3();
    this._slipUp = new THREE.Vector3();
    this._slipFwd = new THREE.Vector3();
    this._slipLat = new THREE.Vector3();
    this._slipVel = new THREE.Vector3();
    /** Smoothed visual steer incl. drift countersteer (cosmetic). */
    this._visSteer = 0;
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
    // Only the procedural body tracks the collision-box dims; the GLB is a fixed
    // real-world shape and is placed by CHASSIS_GLB instead.
    this._chassisProc.geometry.dispose();
    this._chassisProc.geometry = new THREE.BoxGeometry(CHASSIS.width, CHASSIS.height, CHASSIS.length);
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
    this.input.pitch = controls.pitch ?? 0; // air pitch — its own key, not throttle

    this._solidTouch = false; // set by _resolveSolidBvh during the step
    this._physicsStep(FIXED_DT);
    this._depenetrateFromWalls();
    this._updateStuck();
  }

  /**
   * Stuck detection + the first stage of recovery. See the STUCK block.
   *
   * Requires ALL of: touching a solid, no wheel on a drivable surface, barely
   * moving, and throttle held. Requiring throttle means deliberately parking
   * against a wall is never treated as stuck; requiring zero grounded wheels
   * means a car that can drive is never treated as stuck either.
   *
   * Stage two is the game's job — it owns the last-safe-pose bookkeeping — so
   * this only exposes `stuckTime` for roadGame to escalate on.
   */
  _updateStuck() {
    if (!STUCK.enabled) { this._stuckTime = 0; this._stuckNudged = false; return; }
    const sp = Math.hypot(this.body.vel.x, this.body.vel.z);
    // Fewer than 3 wheels down means the car is NOT properly on the road — it is
    // balanced on an edge or a rail. Measured: a car resting on a guardrail has
    // 2/4 (some wheels reach the kerb) and 0.5 m/s, so requiring exactly 0 missed
    // it entirely. Requiring <3 also correctly EXCLUDES a car sitting squarely on
    // the road pushing into a wall — that has 4/4, is not trapped, and just needs
    // to reverse.
    const trapped =
      this._solidTouch &&
      this.groundedCount < 3 &&
      sp < STUCK.speed &&
      Math.abs(this.input.throttle) > 0.01;

    if (!trapped) {
      this._stuckTime = Math.max(0, this._stuckTime - STUCK.releaseRate * FIXED_DT);
      if (this._stuckTime === 0) this._stuckNudged = false;
      return;
    }
    this._stuckTime += FIXED_DT;
    if (!this._stuckNudged && this._stuckTime >= STUCK.nudgeAfter) {
      this._stuckNudged = true;
      // Up and along the car's own forward: lifts it off whatever it is balanced
      // on and gives it somewhere to go.
      this._stuckUp.set(0, 1, 0).applyQuaternion(this.body.quat);
      this._stuckFwd.set(0, 0, 1).applyQuaternion(this.body.quat);
      this.body.vel
        .addScaledVector(this._stuckUp, STUCK.nudgeUp)
        .addScaledVector(this._stuckFwd, Math.sign(this.input.throttle) * STUCK.nudgeForward);
    }
  }

  /** Seconds the car has been trapped against geometry while asking to move; 0
   *  whenever it is free. The game escalates past STUCK.respawnAfter. */
  get stuckTime() { return this._stuckTime; }

  /** Did the chassis touch a solid (guardrail / wall) during the last tick?
   *  Drift scoring breaks a chain on contact — that risk is what makes holding
   *  a long chain worth anything. */
  get hitSolid() { return this._solidTouch; }

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

  /**
   * Signed slip angle (rad): from the chassis' forward axis to its velocity,
   * measured in the chassis' OWN ground plane — so it stays meaningful on a
   * bank or inside a loop, where a world-horizontal measure would not.
   *
   * Positive = travelling to the LEFT of where the nose points. (+X is the
   * chassis' left here; `Tire._right` is misnamed but self-consistent.) 0 when
   * effectively stationary, where the angle is numerical noise.
   */
  get slipAngle() {
    const v = this.body.vel;
    this._slipUp.set(0, 1, 0).applyQuaternion(this.body.quat);
    this._slipFwd.set(0, 0, 1).applyQuaternion(this.body.quat);
    this._slipVel.copy(v).addScaledVector(this._slipUp, -v.dot(this._slipUp));
    if (this._slipVel.lengthSq() < 1) return 0; // < 1 m/s in-plane
    this._slipFwd.addScaledVector(this._slipUp, -this._slipFwd.dot(this._slipUp));
    if (this._slipFwd.lengthSq() < 1e-8) return 0;
    this._slipFwd.normalize();
    this._slipLat.crossVectors(this._slipUp, this._slipFwd); // = chassis left
    return Math.atan2(this._slipVel.dot(this._slipLat), this._slipVel.dot(this._slipFwd));
  }

  /**
   * Steer angle for the WHEEL MESHES — the physics angle plus a slice of the
   * slip angle, so the front wheels aim down the road during a slide. See the
   * DRIFT block. Never fed to the tyres.
   */
  _visualSteerAngle(dt) {
    const phys = this._steerAngle();
    if (DRIFT.counterSteerVisual <= 0) { this._visSteer = phys; return phys; }

    // GROUNDED ONLY. Countersteer is a response to the tyres sliding on a
    // surface — with the wheels in the air there is nothing to counter, and a
    // car pitched or yawed mid-jump has a big "slip angle" that means nothing.
    // Left ungated the front wheels visibly steered themselves during flight.
    // Airborne, the wheels simply follow the steering input, as a real car's do.
    const contact = this.groundedCount * 0.25;
    const slip = contact > 0 ? this.slipAngle : 0;
    const over = Math.abs(slip) - DRIFT.counterDeadband;
    // Steering toward the slip direction IS the countersteer: with the nose
    // left of the velocity, pointing the wheels left aims them along travel.
    const counter = over > 0 ? Math.sign(slip) * over * DRIFT.counterSteerVisual * contact : 0;
    let target = phys + counter;
    const cap = DRIFT.maxVisualSteer;
    if (target > cap) target = cap; else if (target < -cap) target = -cap;
    const k = 1 - Math.exp(-DRIFT.visualSmooth * Math.max(1e-4, dt));
    this._visSteer += (target - this._visSteer) * k;
    return this._visSteer;
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
    // Donut boost, ADDED to the normal curve rather than scaling it, so it can
    // only ever affect the crawl. `lowSpeedExtraLock` is gone by
    // `lowSpeedLockRef` and everything above that speed is untouched.
    let lt = speed / Math.max(0.1, TIRE.lowSpeedLockRef);
    if (lt > 1) lt = 1;
    const boost = TIRE.lowSpeedExtraLock * (1 - lt * lt);
    return this.input.steer * (TIRE.maxSteerAngle * factor + boost);
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
      if (DECK.enabled && this.groundBvh && this.groundBvh.baked) this._applyDeckContact(subDt);
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
      // PITCH IS ITS OWN INPUT, not the throttle.
      //
      // It used to be `-throttle`, and that was a design error: the throttle is
      // held almost continuously — approaching a ramp, in the air, on landing —
      // so pitch was permanently commanded. Holding the gas through a standard
      // 2.05 s jump produced 422° of pitch, i.e. it FORCED a flip you never
      // asked for, and a 0.3 s crest hop landed you 62° nose-up. Both of the
      // hacks this file used to carry (`airControlDelay`, and the long
      // `airGroundLockout`) existed only to paper over that.
      //
      // Steering does not have the problem — while airborne it does nothing for
      // driving, so there is no competing intent and roll can stay on it.
      //
      // `input.pitch` is +1 for NOSE UP. A positive rotation about the chassis'
      // +X axis pitches the nose DOWN (+X is the chassis' left; rotating +Z
      // about it takes the nose toward −Y), hence the negation.
      const inP = armed ? -this.input.pitch : 0;
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

  /**
   * Chassis vs the DECK — an anti-clip backstop only. FORCE-based, deliberately.
   *
   * The solids resolver next door uses positional projection, which is right for
   * a WALL you hit. It is WRONG for a surface the car RESTS on: a positional
   * correction teleports the body away from the deck every substep, which
   * unloads the suspension instead of sharing load with it.
   *
   * Measured in a loop when this briefly WAS projection-based: wheel compression
   * fell 0.45 → 0.24 and grounded wheels 4/4 → 2/4, so the car lost grip and
   * dropped out of a 51 m loop at 36 m. Forces superpose with the suspension;
   * positional corrections fight it. Loops and tubes are exactly the case where
   * the body is pressed hard toward a surface the wheels are already holding.
   *
   * The wheels hold the car up. If this is ever what stops the body sinking into
   * a road, something upstream already failed — hence "backstop".
   */
  _applyDeckContact(dt = FIXED_DT / this.SUBSTEPS) {
    const body = this.body;
    const skin = DECK.skin;
    // ALL EIGHT corners, not just the lower four.
    //
    // A stunt car lands on whatever face happens to be pointing down. With only
    // the bottom corners sampled, an INVERTED car had nothing between its roof
    // and the road and fell straight through it — reproducible in one line, and
    // pre-existing rather than new. The extra four queries are ~free next to the
    // wheel probes, and they cost nothing on a normal lap: upright, the top
    // corners sit ~0.6 m clear of the deck, far outside `skin` (0.05), so they
    // never register. Verified against the loop test — no change there.
    // Anti-tunnel band, same split as the solids resolver: FORCE only inside
    // `skin`, velocity clamp anywhere inside `band`. At 15 m/s a corner advances
    // 0.0625 m per substep — already past the 0.05 m skin — which is exactly how
    // an inverted car fell through the road.
    const band = Math.max(skin, body.vel.length() * dt * SOLID.sweepMargin);
    let approach = 0;
    this._solidApproachN.set(0, 0, 0);

    for (const corner of this.CHASSIS_CORNERS) {
      this._geomToWorld(corner, this._cWorld);
      const res = this.groundBvh.closestPointWithNormal(
        this._cWorld.x, this._cWorld.y, this._cWorld.z, DECK.searchRadius, this._deckN,
      );
      if (!res) continue;
      // Signed distance from surface to corner along the (outward) normal.
      const sd =
        (this._cWorld.x - res.x) * this._deckN.x +
        (this._cWorld.y - res.y) * this._deckN.y +
        (this._cWorld.z - res.z) * this._deckN.z;
      if (sd >= skin) {
        // Clamp ONLY if this corner would actually CROSS before the next
        // substep. Banding on distance alone is wrong here: in a loop the
        // chassis rides permanently close to the deck, so a proximity band
        // cancelled the car's centripetal motion every substep and it dropped
        // out of the loop at 38 m of 51 m.
        body.getVelocityAtPoint(this._cWorld, this._cVel);
        const closing = -this._cVel.dot(this._deckN);
        if (closing > 0 && closing * dt > sd - skin) {
          this._solidApproachN.addScaledVector(this._deckN, closing);
          approach = Math.max(approach, closing);
        }
        continue; // corner clear of the deck → the wheels have it
      }
      const pen = skin - sd;
      body.getVelocityAtPoint(this._cWorld, this._cVel);
      const inward = -this._cVel.dot(this._deckN);
      const dampMag = Math.max(0, inward) * DECK.damper;
      const forceMag = pen * DECK.stiffness + dampMag;
      this._cF.copy(this._deckN).multiplyScalar(forceMag);
      body.addForceAtPoint(this._cF, this._cWorld);
    }

    // Velocity-only, so it cannot lift the car or change ride height — it just
    // stops a corner crossing the surface between substeps.
    //
    // Gated on the wheels NOT already holding the car. This is a backstop for
    // orientations the suspension cannot handle — on its side, inverted, under a
    // slab. With three or more wheels down the car is supported properly, and
    // firing it there braked normal driving: a 30 m/s graze along a kerb dropped
    // to 0 because a corner near a piece seam read as an imminent crossing.
    if (this.groundedCount < 3 && approach > 0 && this._solidApproachN.lengthSq() > 1e-10) {
      this._solidApproachN.normalize();
      const vIn = body.vel.dot(this._solidApproachN);
      if (vIn < 0) body.vel.addScaledVector(this._solidApproachN, -vIn);
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

  /**
   * Resolve the chassis box against one BVH by PROJECTION — see the SOLID block
   * for why this replaced penetration springs.
   *
   * Two passes. First gather every overlapping sample into one aggregate
   * contact: a penetration-weighted mean normal, the deepest overlap, and the
   * mean contact point (for the torque). Then apply the correction ONCE.
   * Resolving per-sample is what let 26 springs stack into a launcher; one
   * aggregate correction cannot exceed the actual overlap no matter how many
   * samples agree.
   */
  _resolveSolidBvh(bvh, surfaceVelFn, dt = FIXED_DT / this.SUBSTEPS) {
    const body = this.body;
    const skin = SOLID.skin;
    // Detection band widens with speed so a fast sample can never step over the
    // skin between substeps — see SOLID.sweepMargin. Push-out still uses `skin`.
    const band = Math.max(skin, body.vel.length() * dt * SOLID.sweepMargin);
    let deepest = 0;
    let hits = 0;
    let approach = 0; // deepest imminent (band-only) contact
    this._solidN.set(0, 0, 0);
    this._solidPoint.set(0, 0, 0);
    this._solidApproachN.set(0, 0, 0);

    for (const sp of this.SOLID_BOX_SAMPLES) {
      this._geomToWorld(sp, this._sphC);
      const res = bvh.closestPointWithNormal(
        this._sphC.x, this._sphC.y, this._sphC.z, band, this._sphN,
      );
      if (!res) continue;
      // Close but not overlapping. NO anti-tunnel clamp here, deliberately:
      // rails are thin, fast grazes are constant, and clamping on them braked
      // the car on every pass (a 30 m/s graze fell to 0, because the posts and
      // piece seams present faces whose normals point along travel). The
      // tunnel-prone geometry a stunt track actually has — road decks and tube
      // walls — all lives in the DECK bvh, which does carry the clamp. Rails
      // rely on the skin plus projection.
      if (res.distance >= skin) continue;
      const pen = skin - res.distance;
      if (pen <= 0) continue;
      hits++;
      this._solidN.addScaledVector(this._sphN, pen);
      this._solidPoint.add(this._sphC);
      if (pen > deepest) deepest = pen;
    }
    if (!hits) {
      // No real overlap, but something is close and we are closing on it: kill
      // just the inward velocity so the next substep lands ON the surface
      // instead of beyond it. No positional change, so this cannot lift the car
      // off anything or affect ride height — it only removes the ability to
      // teleport through a wall.
      if (approach > 0 && this._solidApproachN.lengthSq() > 1e-10) {
        this._solidApproachN.normalize();
        const vIn = body.vel.dot(this._solidApproachN);
        if (vIn < 0) body.vel.addScaledVector(this._solidApproachN, -vIn);
      }
      return;
    }
    this._solidTouch = true; // feeds the stuck detector in tick()
    this._solidPoint.multiplyScalar(1 / hits);

    // Opposing normals cancel here, which is CORRECT: wedged between two
    // surfaces there is no meaningful "out", so pushing along the near-zero
    // mean would be pushing in a direction made of rounding noise. Bail and
    // leave the car free to drive itself out.
    if (this._solidN.lengthSq() < 1e-10) return;
    this._solidN.normalize();

    // 1) POSITIONAL — move out of the surface. No force, so no stored energy.
    body.pos.addScaledVector(this._solidN, deepest * SOLID.push);

    // 2) VELOCITY — kill the component heading into the surface. Only inward:
    //    outward motion is the car already leaving, and must not be touched.
    body.getVelocityAtPoint(this._solidPoint, this._sphV);
    if (surfaceVelFn) {
      // A moving wall carries the car with it, so resolve in ITS frame and add
      // its velocity back afterwards.
      surfaceVelFn(this._solidPoint, this._surfV);
      this._sphV.sub(this._surfV);
    }
    const vN = this._sphV.dot(this._solidN);
    if (vN < 0) {
      body.vel.addScaledVector(this._solidN, -vN * (1 + SOLID.restitution));
    }
    if (surfaceVelFn) {
      const relN = body.vel.dot(this._solidN) - this._surfV.dot(this._solidN);
      if (relN < 0) body.vel.addScaledVector(this._solidN, -relN);
    }

    // 3) TANGENTIAL — scraping costs speed, ramped in so a car crawling out of
    //    somewhere it is trapped is not drained of the little it has.
    if (SOLID.friction > 0 && dt > 0) {
      const vn2 = body.vel.dot(this._solidN);
      this._solidT.copy(body.vel).addScaledVector(this._solidN, -vn2);
      const vT = this._solidT.length();
      const ramp = Math.min(1, vT / Math.max(0.01, SOLID.frictionFullSpeed));
      if (ramp > 0) {
        this._solidT.multiplyScalar(Math.exp(-SOLID.friction * ramp * dt));
        body.vel.copy(this._solidT).addScaledVector(this._solidN, vn2);
      }
    }

    // 4) SPIN — an off-centre hit should turn the car a little. Deliberately a
    //    fraction of the physically correct impulse and hard-capped: the wheels
    //    and stabilizer own the car's attitude, a wall only nudges it.
    if (SOLID.spin > 0 && vN < 0) {
      this._solidR.subVectors(this._solidPoint, body.pos);
      this._solidTorque.crossVectors(this._solidR, this._solidN)
        .multiplyScalar(-vN * SOLID.spin);
      const mag = this._solidTorque.length();
      if (mag > SOLID.maxSpin) this._solidTorque.multiplyScalar(SOLID.maxSpin / mag);
      body.angVel.add(this._solidTorque);
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

    // Visual steer INCLUDES the drift countersteer overlay. The TYRES used the
    // plain _steerAngle() back in _physicsStep — this only turns meshes.
    const steerAngle = this._visualSteerAngle(dt);
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
