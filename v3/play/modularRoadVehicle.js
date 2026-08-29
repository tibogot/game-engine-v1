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

/**
 * THE CORE BOX — mass distribution, deck contact, wall probes.
 *
 * NOT the car's silhouette, and deliberately so on both counts:
 *
 *  • INERTIA. `_setInertia` derives Ixx/Iyy/Izz from these. A solid box of the
 *    full 4.85 × 2.10 × 1.26 body is the wrong inertia for a car anyway — real
 *    mass sits low and central, not out at the wing and roofline — so this
 *    smaller box is the better tensor as well as the tuned one.
 *
 *  • DECK CONTACT. `CHASSIS_CORNERS` are what stop the body sinking through the
 *    road, and `height: 0.6` is not a round number: the box bottom sits at
 *    −0.30, the tyre contact patch at −0.46, and SOLID.skin (0.08) plus the 7.8
 *    cm of dynamic suspension closure measured by tools/archClearanceRepro.mjs
 *    eats all but 2 mm of the gap. Lower the box AT ALL and the car starts being
 *    shoved off every ramp it drives over.
 *
 * What the car HITS is a separate, bigger shape — see CHASSIS_HULL.
 */
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
 * THE SOLID HULL — the silhouette the car is collided as against walls, rails,
 * guardrails, gate posts and props.
 *
 * Split from CHASSIS because the two shapes answer different questions and the
 * single shared box could only ever satisfy one of them. The core box is pinned
 * by ride height and by a tuned inertia tensor; the hull wants to be the actual
 * car, because "the collider is nowhere near the bodywork" is a thing players
 * see. Measured off the GLB in games/modular-road-v3/chassisModel.js, in
 * chassis-local metres (the model sits at CHASSIS_GLB.offsetY −0.50):
 *
 *     body half-width  1.05      -> width  2.10   (excludes the aero, which is
 *                                                  fragile trim, not structure)
 *     model height     1.26      -> spans −0.50 .. +0.76
 *     model length     4.85      -> spans −2.34 .. +2.51 (offsetZ −0.15)
 *
 * The one number that is NOT the model's: the hull BOTTOM stays at −0.30, the
 * core box's floor, for exactly the ride-height reason above. So the hull is the
 * car from the sills up, which is the half that hits things anyway.
 */
export const CHASSIS_HULL = {
  width: 2.10,
  height: 1.06,
  length: 4.85,
  /** Hull centre in chassis-local metres. Y puts the floor on −0.30 and the roof
   *  on +0.76; Z re-centres the body's own asymmetric bounds. */
  offsetY: 0.23,
  offsetZ: 0.085,
  /**
   * Target spacing of the surface sample points (m).
   *
   * THE HULL IS SAMPLED, AND SAMPLE SPACING IS A COLLIDER SIZE LIMIT. Each
   * sample is a sphere of `SOLID.skin`, so an obstacle thinner than the gap
   * between samples falls straight between them and the car drives through it.
   * The old fixed 26-point layout (corners + edge mids + face centres) put the
   * front-face samples 0.90 m apart, and tools/postColliderRepro.mjs measured
   * the consequence: 11 of 14 head-on approaches to a solid 0.22 m gate post
   * passed clean through it. It was invisible until now only because everything
   * else solid on a track — rails, tube shells, walls — is long enough that
   * SOME sample always lands on it.
   *
   * 0.45 m is chosen against the thinnest thing a track actually has: a
   * guardrail post at 0.32 m across reaches 0.16 + skin = 0.24 m, and catching
   * it needs spacing < 2 × 0.24. Round primitives (posts, bollards, pylons) do
   * not rely on this at all — they register as exact capsules instead, see
   * Vehicle.setSolidCapsules.
   */
  sampleSpacing: 0.45,
};

/**
 * THE DECK CONTACT SHAPE — what the car is collided as against ROAD SURFACES
 * (the deck BVH) and the terrain heightmap.
 *
 * The third shape, and the reason it exists: `CHASSIS` and `CHASSIS_HULL`
 * disagree about where the roof is, and until now the deck resolver used the
 * WRONG one.
 *
 *     CHASSIS      roof at +0.30   (half of a box sized for inertia + ride height)
 *     CHASSIS_HULL roof at +0.76   (the actual roofline, measured off the GLB)
 *
 * So a car landing inverted, or pressed against a loop's ceiling, or driving
 * under an overpass, sank 46 cm of bodywork into the slab before anything
 * resisted — the deck saw a roof that is nearly half a metre inside the car.
 *
 * The floor is UNCHANGED and must stay that way: −0.30 is pinned by ride height
 * (see CHASSIS), and the four bottom corners are the ones every landing, ramp
 * and kerb already behaves against. This shape only raises the LID.
 *
 * The footprint also stays at the core box's 1.8 × 3.6 rather than growing to
 * the hull's 2.10 × 4.85. Widening it is not free — the corners are what catch
 * on ramp crests and kerb lips — and 15 cm of overhang either side of the roof
 * changes nothing about whether you clip a ceiling.
 */
export const DECK_CONTACT = {
  /** Roof height in chassis-local metres. Tracks the hull, so re-measuring the
   *  body in chassisModel.js moves both together. */
  get roofY() { return CHASSIS_HULL.offsetY + CHASSIS_HULL.height / 2; },
  /**
   * Spacing of the EXTRA roof samples between the four top corners (m); 0 falls
   * back to corners only.
   *
   * WHY THE ROOF NEEDS MORE THAN CORNERS. A deck contact only registers when the
   * surface is within `DECK.skin` (5 cm) of a sample. The top corners are 1.8 m
   * and 3.6 m apart, so anything narrow crossing the MIDDLE of the roof — a beam,
   * a catwalk, the edge of an overpass — passes between them and is not there at
   * all. Wide slabs were fine (the whole roof plane arrives at once), which is
   * why this stayed invisible.
   *
   * 0.9 m catches anything ≳ 0.85 m across and costs 15 samples on the roof
   * instead of 4. That is deliberately COARSER than the hull's 0.45: the solids
   * BVH is where thin obstacles belong, and every sample here is a BVH query per
   * substep. See tools/roofContactTest.mjs for the measured cost.
   */
  roofSampleSpacing: 0.9,
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
  /**
   * Rays around the bottom semicircle of the tire (longitudinal × vertical
   * plane). Costs rayRingCount × 4 tyres × SUBSTEPS raycasts per tick — 80 at
   * this setting.
   *
   * DROPPING THIS TO 6 WAS TRIED AND REVERTED. It is safe but it is not
   * faster, and the measurements are recorded here so the idea is not retried
   * from scratch:
   *
   *  • SPEED: none. Timed over an IDENTICAL pose set (60 poses, 12 reps, 5
   *    alternating passes, medians) 10 vs 6 came out at +0.2% inside the tube
   *    and -0.9% on open road. Noise.
   *
   *  • The "-33% on open road / -19% in the tube" first measured for this was
   *    WRONG, in two compounding ways worth remembering. A different ring
   *    count sends the car down a DIFFERENT TRAJECTORY (measured: 245 m of
   *    divergence over 30 s), so per-region tick averages were sampling
   *    different geometry rather than the same work done cheaper. And wrapping
   *    each BVH call in performance.now() to attribute cost inflated the tube
   *    tick from ~1.2 ms to 3.2 ms — most of the "1.25 ms of raycasts" that
   *    made the ring look like the biggest line item was the instrumentation.
   *
   *  • SAFETY (this part held up): replaying 800 poses from a full lap gave a
   *    max contact error of 12 mm with zero grounded-flag mismatches, and
   *    tools/tireRingEdgeTest.mjs finds no grounded flip away from an edge on
   *    a `gap` or `jump` lip swept at 5 cm.
   *
   * The reason coarsening is harmless is also the reason it is pointless: THE
   * RING IS NOT WHAT RESOLVES AN EDGE, `useSphereSweep` is. The sweep is a
   * 0.33 m ball that bridges anything narrower than the contact patch — the
   * physically right answer, since a 0.37 m wheel should not drop into a 0.2 m
   * slot. Turn the sweep off and the ring count matters immediately (the edge
   * test's control shows 228 differing samples). So if the sweep is ever
   * disabled, this number becomes load-bearing again.
   */
  rayRingCount: 10,
  rayRingScale: 0.92, // × wheel radius
  /** Swept-sphere cast along the probe (catches ramp lips between discrete rays). */
  useSphereSweep: true,
  sphereSweepScale: 0.88, // × wheel radius
  suspVisSmooth: 12,
  /**
   * VISUAL cap on how far a wheel may hang below its hub (m). Physics is
   * untouched — this only clamps the offset syncVisuals applies to the tyre
   * group.
   *
   * It exists because `rayLength` was doing double duty. Airborne there is no
   * hit, so the visual falls back to the full PROBE length (1.0 m) as if the
   * suspension had extended that far — 0.64 m of droop once the wheel radius is
   * taken off, which left the wheels dangling 0.44 m below the body. The probe
   * has to stay long (it is what catches ground early enough not to tunnel);
   * the suspension does NOT travel that far. Two different numbers that had
   * been one.
   *
   * Static ride uses 0.137 m of this, so 0.22 leaves ~0.08 m of visible
   * extension on a jump — about right for a race car (a road car runs
   * 0.08–0.12 m of total travel, a GT4 nearer 0.05–0.08).
   */
  maxDroop: 0.22,
  /**
   * VISUAL cap on how far a wheel may travel UP toward its hub (m) — a bump
   * stop. The mirror of `maxDroop`, and it was missing: the renderer clamped
   * the wheel's droop but let compression run all the way to `Math.max(0, …)`,
   * i.e. to the hub itself.
   *
   * That is why wheels vanish into the body over obstacles. The GLB body is
   * fitted around the SETTLED pose (chassisModel.js: "the wheels land exactly in
   * the arches with no scaling"), which sits at 0.137 m of extension — so every
   * millimetre below that drives the tyre up into an arch that was modelled
   * around it. MEASURED, front wheel, how far it rises above the fitted spot:
   *     drop 1 m onto flat     0.026 m    fine
   *     drive onto a 0.10 m step   0.098 m    tyre well into the arch
   *     drive onto a 0.20 m step   0.140 m    wheel centre AT the hub
   * 0.10 leaves ~0.037 m of visible bump travel — in the band a GT4 actually
   * runs (0.05–0.08 m TOTAL, bump plus droop) and inside the arch gap the body
   * fit provides. It was 0.08 first, which fitted the arch only if the body lean
   * never saturated; the two budgets are checked together now, see
   * BODYLEAN.archCompensate and tools/chassisModelTest.mjs.
   *
   * PHYSICS IS UNTOUCHED — `compression` still runs its full range, so the
   * spring, the bottom-out and the handling are exactly as before. This clamps
   * the mesh offset only.
   *
   * NOTE this is no longer a hard floor on the drawn wheel — see `archLiftBody`,
   * which pays for the clearance by raising the BODY instead. It is now the
   * arch-gap TARGET rather than a clamp.
   */
  minSuspExt: 0.10,

  // ── ARCH CLEARANCE: WHO MOVES, THE WHEEL OR THE BODY? ───────────────────
  // `minSuspExt` used to be a floor on the drawn wheel, and a floor can only
  // push one way: DOWN, into the road. MEASURED sink of the drawn tyre below the
  // surface (tools/wheelSinkRepro.mjs) before this existed:
  //     0.10 m step  6.9 cm     0.20 m step  14.7 cm     2 m drop  12.5 cm
  // while steady state — flat, and 15°/25° slopes — was already a clean 0.0 cm.
  // So all of it is transient, and there are two separate causes:
  //   • `suspVisSmooth` eases the DRAWN extension, so on rising ground the mesh
  //     lags the contact the tyre has already found. Fixed by never drawing the
  //     wheel below `hitDistance` (see _updateWheelExtensions).
  //   • deep compression genuinely runs out of visual travel. On a 0.20 m step
  //     the hub sits 0.297 m above the new surface with a 0.36 m tyre — the
  //     contact patch is ABOVE the hub, and NO wheel placement avoids clipping.
  //
  // That second one cannot be won by moving the wheel, because the travel budget
  // is fixed by where the body sits. The body has to move, which is also what a
  // real car does over a bump. BODYLEAN.archCompensate already does exactly this
  // trick for body roll; this is the same idea with a different cause.
  /**
   * Fraction of an arch shortfall paid for by LIFTING THE BODY rather than by
   * pushing the wheel down into the ground, 0..1.
   *
   * 1 = the wheel always sits on the surface and the body rides up over bumps.
   * 0 = bit-for-bit the old `suspExt < minSuspExt → minSuspExt` clamp.
   *
   * The cost of 1 is that a shortfall at ONE corner lifts the whole mesh, so the
   * other three wheels look further extended for as long as it lasts. That is
   * roughly what a real body does (it rises AND rolls; only the rise is modelled
   * here), and it only happens on compressions past ~3.7 cm from static, i.e.
   * real hits rather than ordinary driving.
   */
  archLiftBody: 1,
  /** Cap on that lift (m). Also caps how far a wheel may be drawn ABOVE its hub,
   *  so a bad probe can never fling the body into the air. */
  /**
   * 0.25 SATURATED, and a saturated lift does not read as suspension — it reads
   * as the body coming off the wheels. Measured driving a Jump lab lane: the
   * scoop loads the car hard enough to bottom the suspension for the WHOLE
   * climb, so this pinned at its ceiling for ~0.6 s with all four wheels drawn
   * 0.25 m above their hubs. The intent is a brief rise over a hit, not a
   * sustained ride-height change.
   *
   * 0.12 still covers ordinary kerbs and landings (the shortfall this exists for
   * starts around 3.7 cm) while keeping the worst case to something that looks
   * like travel. Set archLiftBody to 0 to switch the whole behaviour off and get
   * the old hard clamp back.
   */
  archLiftMax: 0.12,
  /**
   * Ease rate (1/s) for the lift coming back DOWN. Going up is instant and
   * deliberately unsmoothed: every frame of delay is a frame of tyre inside the
   * bodywork, which is the whole thing being fixed. Coming down is eased so a
   * kerb strike does not drop the body out from under itself.
   */
  archLiftSettle: 6,
  /**
   * Keep the DRAWN wheel out of SOLID geometry too — guardrails, tunnel shells,
   * gates, cliffs, tree trunks. 0 disables. VISUAL ONLY.
   *
   * The wheels have never known solids exist: `Tire.apply` probes `castGround`,
   * which v3 wires to terrain + road decks + movers, while rails and shells live
   * in a SEPARATE `solids` BVH used only for chassis collision (see
   * createVehicleGround in modularRoadGround.js). So a tyre resting on a
   * guardrail passed straight through it, and no amount of suspension tuning
   * touched that — it is a missing query, not a bad number.
   *
   * Deliberately NOT made a driving surface. Feeding solids into the tyre probe
   * would let the car drive UP guardrails and would change handling everywhere;
   * this only raises the mesh, so the physics is bit-for-bit unchanged.
   */
  wheelSolidClear: 1,
  /**
   * Minimum surface-normal·chassis-up for the solid clearance to act.
   *
   * A wheel beside a VERTICAL wall is not sinking into anything, and raising it
   * would not help if it were — the correction goes as 1/(n·up), so without this
   * gate a glancing rail contact divides by ~0 and throws the wheel at the sky.
   * 0.35 ≈ only surfaces within ~70° of horizontal, i.e. things you can end up
   * ON TOP of: a rail cap, a gate panel, a ramp lip.
   */
  wheelSolidMinFacing: 0.35,
  restLength: 0.55,
  springStrength: 65000,
  damper: 6500,
  /**
   * How square to the surface a contact must be (chassis-up · contact-normal)
   * before the damper measures travel along the NORMAL instead of the chassis
   * up-axis. See the long note in Tire.apply.
   *
   * 0.85 (≈32°) is chosen to cover every contact the car RESTS on while
   * excluding the ones it CRASHES into. A car square to the road reads 0.998
   * even when pitched hard on a landing, and a bank or the inside of a loop is
   * the same — the chassis follows the surface. Only a wheel against something
   * it is not driving on (rail flank, edge, wall) falls below, and those want
   * the old closing-speed damping so an impact is still absorbed.
   */
  damperNormalMinFacing: 0.85,
  // ── THE BUMP STOP ───────────────────────────────────────────────────────
  // Where the spring stops being linear (as a fraction of restLength) and how
  // hard it fights past that. Force is c·springStrength + (c − knee)²·
  // springStrength·bottomOutMult.
  //
  // IT USED TO BE 0.7 / 8, AND THAT IS TOO LATE AND TOO SOFT TO BE A STOP. The
  // knee sat at 0.385 m, but the DRAWN wheel runs out of room at 0.31 m of
  // compression — past that the hub is nearer the road than the tyre is wide
  // (WHEEL.radius − TIRE.archLiftMax = 0.24 m of clearance left), and the mesh
  // has nowhere legal to go but inside the deck. So the stop engaged 7 cm after
  // the point it needed to defend, and then rose so gently that it never really
  // defended it: a sustained 8 g load settles at 0.463 m on those numbers, and
  // MEASURED across the Slopes presets at 48 m/s (tools/roadHoldSinkDiag.mjs)
  // the car rode past the knee for 19–42% of every piece with the wheels drawn
  // 34–41 cm inside the road for 21–47% of it. Peak compression reached 0.72 m
  // on a strut whose rest length is 0.55 — i.e. the hub 17 cm BELOW the surface,
  // the whole car sunk into the deck.
  //
  // That is not a slope bug. It is what this car does under ANY sustained high-g
  // load, and it was invisible until ROAD_HOLD started keeping the wheels on the
  // road long enough to see it (before, the car was airborne over the same
  // geometry). Turning both assists off entirely still measures 29.6 cm.
  //
  // 0.45 / 120 puts the knee at 0.2475 m — just INSIDE the visual budget, which
  // is the whole point — and makes it a real stop rather than a soft second
  // spring. MEASURED over the Slopes presets at 48 m/s, penetration of the drawn
  // wheel and the share of the piece spent with a wheel in the deck:
  //
  //     knee/mult    Up Steep       Dip        Up Medium        Hill
  //      0.7 /  8    34.5cm 47%   39.1cm 56%   33.5cm 45%   37.5cm 47%
  //      0.5 /200     3.1cm 27%    5.3cm 35%    2.9cm 28%    4.6cm 30%
  //      0.45/120     2.2cm  5%    3.7cm 28%    2.0cm  5%    3.3cm 16%  <- shipped
  //      0.45/200     1.0cm  1%    2.7cm  2%    0.6cm  1%    2.5cm  3%
  //
  // and the ride got SMOOTHER doing it, not harsher: RMS vertical jerk over the
  // same runs fell from 4769 / 18207 / 3740 / 10634 to 2169 / 2057 / 2003 / 2430.
  // A strut that stops where it is supposed to stop does not have to be caught
  // later by something else.
  //
  // WHY NOT 200, WHICH MEASURES BETTER. A stop that firm makes the car BOUNCE off
  // a low ramp — brief hops a few centimetres up — and tools/jumpPitchTest.mjs
  // catches it: its guard against the landing assist arming while the car is
  // still climbing goes from 0.00 to 0.62, because each micro-hop reads as an
  // imminent landing. 120 keeps that at 0.00. The extra 1-2 cm of tyre in the
  // road is not worth re-arming a levelling assist during a deliberate roll.
  //
  // NOTHING ELSE REACHES THIS FAR, which is what makes it safe to change:
  //   • static ride            0.053 m
  //   • jump landings          0.176 / 0.198 / 0.256 m — TIRE.landingAbsorb
  //     already caps arrivals (see the LANDINGS block above), and even the
  //     worst of the three only grazes the knee, picking up under 1 kN.
  //   • flat road at 173 km/h  measured 0 change in vertical jerk.
  // Only a SUSTAINED several-g load gets here, which is the case that was
  // broken and nothing else.
  bottomOutThresh: 0.45,
  bottomOutMult: 120,
  // Per-axle friction multipliers (× frictionCoeff). Lower the rear for
  // oversteer, lower the front for understeer. Handbrake swaps the rear out.
  gripFront: 1.0,
  // NEUTRAL, and it has to stay neutral. Rear-grippier-than-front is terminal
  // understeer with nothing to catch it, and this was 1.5 for two days: the
  // cornering radius went 6 m -> 74 m, peak sideslip 44° -> 6°, and the car
  // stopped being able to pivot at all. That silently broke four things —
  // donuts went wide (7.3 m against a 4.5 m target), the short park pipe threw
  // the car out at 6 of 9 speeds, the R=40 bowl overshot, and the chase camera
  // swung ahead of the car on a corkscrew.
  //
  // There is NO middle setting to compromise on. 1.1 and 1.2 never settle into
  // a steady corner at all, so the car is either the rotating one at <=1.05 or
  // the planted one at >=1.3. Measured with tools/turnLadderTest.mjs; the
  // ladder's radii in modularRoadBuilder.js are quoted against this value.
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
  /**
   * AIR ROLL ramp (1/s) — Z/X (or the pad stick) while airborne. Independent
   * of the tyre rack, which is why this is not `steerAttack`.
   *
   * The air axis used to read `input.steer` directly, i.e. the value shaped for
   * the TYRES: `steerAttack` 7/s, cut a further 30% by `steerRateSpeedDrop` at
   * speed. That ramp is the steering RACK'S weight, and there is no rack in the
   * air — so the rate model's own feel knob (`airResponse` 9/s) was never what
   * the player actually felt on roll; it ran in SERIES with a slower filter.
   * MEASURED at 45 m/s (tools/airRollLagRepro.mjs), full key held:
   *     input.steer reaches 90% in 0.48 s  →  90° of roll took 0.73 s
   *     airSteer at 18/s reaches 90% in 0.13 s  →  90° of roll takes 0.60 s
   * Short inputs suffered worst, because the rack ramp never got near full
   * deflection at all. A 0.25 s tap, roll at release and peak roll rate:
   *     rack ≈4.9/s   11.6°   1.93 rad/s
   *     18/s          23.1°   2.94 rad/s
   *     raw           —       3.24 rad/s
   *
   * NOT RAW, THOUGH. Removing the filter does not "restore" anything — the roll
   * axis has never once run at its nominal settings, so raw would expose
   * `airResponse` 9 × `airRollRate` 3.6 for the first time. The sweep also
   * saturates: raw buys only 50 ms more on the held roll, while putting a 0.15 s
   * tap at 2.69 rad/s of the 3.6 ceiling — a flick of the key most of the way to
   * maximum roll rate. 18/s keeps ~90% of raw's authority on a realistic tap and
   * matches `steerCounter`, the existing "every millisecond counts" rate, which
   * is the same category of input.
   *
   * MEASURE THIS AXIS AT RELEASE OR BY PEAK RATE, NOT BY TOTAL ROTATION. The
   * obvious metric — how far the car ends up rolled long after the key is up —
   * is blind to this constant by construction: a unity-DC-gain filter passes the
   * same total impulse whatever its time constant, so every rate integrates to
   * the same angle and the change looks like a no-op.
   */
  airSteerRate: 18.0,

  // ── THE STEERING RACK MUST NOT WIND UP FROM A ROLL INPUT ───────────────
  // Keyboard roll is on Z/X, so A/D is free to keep aiming the tyres through a
  // jump (including landing already turned into a corner). The pad stick is
  // still BOTH steer and roll, and callers that omit `rollTarget` still feed
  // the same axis to both — `_smoothSteer` only centres the rack in those
  // dual-use cases. MEASURED off a 35 m/s jump with the (then shared) key
  // RELEASED at touchdown (tools/landingSteerRepro.mjs):
  //     rack at land 1.00   front wheels 19.6°   heading swing 27.9°
  // and with the rack frozen, the same jump swings 0.1°. It is not that the car
  // turns abruptly after a jump — it LANDS with the wheels already turned.
  /**
   * Seconds airborne before the rack starts returning to centre.
   *
   * A DELAY, not just a slower rate, and that distinction is the whole design.
   * A single exponential cannot be both "ignore a crest hop" and "centred by the
   * time a real jump lands": at the release rate (12/s) a 0.15 s hop already
   * unwinds 83% of your lock, which would gut the steering every time you
   * crested a rise mid-corner.
   *
   * So short air does not count as airborne for steering at all — under 0.25 s
   * the rack is untouched and you keep cornering through the bump — and past it
   * the wheels centre well before a real jump touches down.
   *
   * Measured from `_airTime`, which is time since the last CONTACT, so tyre
   * flicker over rough ground can never start it.
   */
  airSteerCenterDelay: 0.25,
  /**
   * Rate (1/s) the rack returns to centre once that delay has passed. 6/s puts
   * it under 5% of full lock in ~0.5 s, so anything that reads as a jump lands
   * with the wheels straight.
   *
   * Only used while roll still shares the steer axis (analog stick, or a
   * caller that omitted `rollTarget`). Dedicated Z/X roll leaves the rack
   * tracking A/D in the air, so you can land already turned into a corner.
   */
  airSteerCenterRate: 6.0,
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

  // ── ACKERMANN — THE TWO FRONT WHEELS DO NOT WANT THE SAME ANGLE ──────────
  // Both front tyres were steered to one identical angle. That is only correct
  // for a car turning about a point infinitely far away; in a real turn the
  // inside wheel traces a TIGHTER circle than the outside one and must be
  // turned further, or the two fight each other and scrub.
  //
  // The error is proportional to lock, so it is invisible in ordinary cornering
  // and enormous at the standstill lock this car runs for donuts. Geometry for
  // this chassis (wheelbase 2.8 m, track 1.84 m), against the single angle both
  // wheels currently receive:
  //     commanded   ideal inner   ideal outer   spread
  //        5.7°         5.9°          5.5°       0.4°
  //       11.5°        12.3°         10.8°       1.5°
  //       31.5°        37.5°         27.0°      10.5°
  //       54.4°        68.9°         43.8°      25.1°   <- full donut lock
  // So at full lock the inner tyre is 14.5° short and the outer 10.6° over, and
  // both spend their grip budget scrubbing sideways instead of turning the car.
  //
  // NOT A FREE WIN TO CRANK UP: correcting the geometry makes the front axle
  // bite harder at low speed, which changes the donut the low-speed lock boost
  // was tuned against. Hence a 0..1 blend rather than a hard switch — 0 is
  // bit-for-bit the old parallel steering, 1 is true Ackermann.
  //
  // The yaw assist's reference yaw rate deliberately keeps using the CENTRE
  // angle (`_steerAngle()`): that is a bicycle-model quantity and the bicycle's
  // single front wheel sits on the centreline, so per-wheel angles would be the
  // wrong input for it.
  /** 0 = parallel steering (old behaviour), 1 = true Ackermann geometry. */
  ackermann: 1.0,
  // ── LATERAL GRIP FADES AS THE CAR TIPS OVER ─────────────────────────────
  // A tyre only makes cornering force through a contact PATCH that is flat on
  // the road. Tip the car onto its shoulder and there is no patch — but the
  // model does not know that: `vLat` is measured along the chassis' right axis
  // whatever attitude it is in, and the force it answers with is the full
  // friction circle.
  //
  // That is what makes a rolled landing violent. A lateral force at a wheel acts
  // `WHEEL_LOCAL.z` = 1.4 m fore/aft of the CoM, so it is a YAW LEVER, and on
  // touchdown the suspension load — and therefore the friction budget — is
  // enormous. MEASURED landing part-way through a barrel roll: 81.7 kN·m of yaw
  // torque against a 1890 kg·m² yaw inertia, i.e. 43 rad/s², snapping the
  // heading 11.7° almost instantly. That is the "the car turns by itself VERY
  // abruptly" — and it only happens after a roll because only a roll puts the
  // car on its side at the moment the tyres take load.
  //
  // Fading the LATERAL force by how square the wheel is to the surface fixes it
  // at the source and is what a real tyre does. It costs nothing anywhere else:
  // the stabilizer aligns the chassis to the surface normal whenever the car is
  // driving, so on flat ground, on banks, through loops and inside tubes this
  // factor sits at 1.0 and the handling is bit-for-bit unchanged. It only ever
  // bites when the car is NOT on its wheels — which is exactly when the tyre
  // model has no business generating a cornering force.
  //
  // LONGITUDINAL force is deliberately untouched: braking and drive act through
  // the wheel's rolling direction, they are not a yaw lever, and cutting them
  // would change acceleration everywhere for no reason.
  /**
   * chassis-up · contact-normal at/above which lateral grip is full. 0.45 ≈ 63°.
   *
   * Deliberately LATE. An earlier fade (0.85, ~32°) killed the yaw snap just as
   * well but also bled grip off a car merely leaning on a guardrail, which then
   * slid off the track — it broke chassisCollisionTest's "land on the rail" case.
   * Past 63° the car is genuinely on its side and has no contact patch worth
   * modelling; before that it is still driving and keeps everything it had.
   */
  lateralAlignFull: 0.45,
  /** …and at/below which it is gone entirely. 0.15 ≈ 81°, i.e. flat on its side. */
  lateralAlignZero: 0.15,
  // ── WHERE THE TYRE FORCES ARE APPLIED ───────────────────────────────────
  // A tyre makes its lateral and longitudinal force at the CONTACT PATCH, on
  // the road. This model applied both at the wheel HUB, 0.46 m higher, and that
  // one choice is most of why the car reads weightless.
  //
  // The vertical arm from the CoM is what turns a cornering force into a roll
  // moment and therefore into load transfer:
  //     hub    0.10 m below CoM ->   746 N of transfer per side at 1 g
  //     patch  0.46 m below CoM ->  3434 N          "
  // i.e. the roll moment is understated 4.6x. Load transfer feeds straight back
  // into grip here (`Fmax` is derived from the dynamic `suspMag`), so this is
  // not only a cosmetic flatness — the outer tyres never gain the bite, and the
  // inner ones never lose it, that a real car's do.
  //
  // BLENDED, NOT SWITCHED, because the entire handling tune was measured with
  // hub application: 0 is bit-for-bit the old car, 1 is the correct geometry.
  // Raising it makes the car roll and transfer weight for real, which also means
  // BODYLEAN is then double-counting — turn its `rollPerG` down as this goes up.
  //
  // SUSPENSION FORCE IS DELIBERATELY LEFT AT THE HUB: the spring genuinely does
  // push the body from the strut mount, so that one is already right.
  //
  // The application point is taken along the suspension axis at the measured
  // contact distance rather than from `hitPoint`. `hitPoint` is whichever ring
  // ray won this tick, so it jitters fore/aft between rays — and fore/aft offset
  // is the YAW lever, which would inject steering noise on every seam.
  /** 0 = force at the hub (old), 1 = at the contact patch (correct). */
  contactPatchForces: 0,
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
   *  — drifting should not be able to become a full spin.
   *
   *  RAISED 0.25 → 0.70 (measured). At 0.25 this scaled the YAW-RATE DAMPING down
   *  to a quarter, which is the term that gives a slide a stable state to sit in —
   *  and without it the car is directionally UNSTABLE the whole time Space is
   *  held. Not "unstable if provoked": holding the handbrake dead straight with no
   *  input at all, the yaw rate grew from 2.3e-17 (floating-point round-off) by
   *  ~25× PER SECOND, steadily, through thirteen orders of magnitude, until at
   *  ~12 s it became a visible spin. Reported as "the car starts turning on its
   *  own after some time" — and the delay is not a timer, it is how long noise
   *  takes to grow. On a real track, with seams and kerbs to disturb it, it bites
   *  far sooner and unpredictably.
   *
   *  This directly fought the drift SCORING: `driftScore.js` loses the chain past
   *  110° of slip and wants ~17.5 s of unbroken slide for the full multiplier, so
   *  the physics was destroying the mechanic the game rewards.
   *
   *  `gripHandbrake` is the WRONG knob for it and stays at 0.35. That one decides
   *  how easily the rear breaks away — drift INITIATION, which should stay loose.
   *  This one decides whether the resulting slide is HOLDABLE. Measured with grip
   *  unchanged, straight-line drift over 15 s vs the steered slide:
   *      0.25  61° drift   peak slip 180°   scoring slide 4.9 s
   *      0.55  20°         peak slip 180°                 5.0 s
   *      0.70   3°         peak slip 180°                 5.6 s
   *  i.e. the spin goes away and the slide is untouched — the rear still comes
   *  right round when you ask it to, and there is slightly MORE scoring time.
   *  Do not "split the difference" at 0.40: it measured WORSE than 0.25 (108°),
   *  the curve is not monotonic. */
  driftYawAssistMul: 0.7,
  // Anti-roll / orientation. When grounded the chassis aligns its up-axis to the
  // averaged ground normal (so it leans into banks and follows loops instead of
  // fighting toward world-up); `stabilizerDamp` damps the roll/pitch rate.
  stabilizerStrength: 9000,
  stabilizerDamp: 2600,
  // ── AIRBORNE CONTROL — RATE-BASED (Shift/Ctrl pitch, Z/X roll, Q/E yaw) ──
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
  /**
   * Full-input rotation rates (rad/s).
   *
   * PITCH IS SOFTER THAN ROLL ON PURPOSE. At 3.6 with the shared `airResponse`
   * the flip was reported as "too brutal", and the measurements agree — a mere
   * 0.3 s tap of Shift/Ctrl rotated 91°, a 0.5 s press 158°. On a ~1.5 s jump
   * that means you are inverted before you intended to commit to anything.
   *   3.6 / resp 9 → 90% rate in 300ms, 0.3s tap = 91°, 0.5s press = 158°
   *   3.0 / resp 5 → 90% rate in 508ms, 0.3s tap = 74°, 0.5s press =  89°
   * Roll stays at 3.6: it is on dedicated Z/X keys, it self-corrects visually,
   * and nobody complained about it.
   *
   * FLOOR: this must stay ABOVE `airAlignMaxSpin` (2.5) or the nose-follows-arc
   * assist would start fighting a deliberate flip instead of standing down.
   */
  airPitchRate: 3.0,
  airRollRate: 3.6,
  /** Yaw sits higher so a flat spin still reads as a deliberate trick. */
  airYawRate: 4.5,
  /** Q/E release rate (1/s). A flat spin must stop promptly without the heading
   *  hold pulling the car backward to the key-release angle. */
  airYawSettle: 14.0,
  /** Where the Q/E spin axis crosses over from world up to the car's own up,
   *  measured as |forward.y| — how near the nose is to vertical. World up is a
   *  perfectly good yaw axis until it lines up with the nose, at which point it
   *  becomes the ROLL axis and a spin input can only barrel-roll (which is what
   *  a park bowl does to you). Start 0.5 = 30° of nose-up, full 0.9 = 64°.
   *  See the long note at the use site: both endpoints are wrong on their own. */
  airYawUprightStart: 0.5,
  airYawUprightFull: 0.9,
  // ── AIRBORNE HEADING HOLD ───────────────────────────────────────────────
  // A 360° roll must leave you pointing where you took off. It did not: roll
  // with A and the car landed a few degrees left, roll with D and it landed the
  // same few degrees RIGHT — MEASURED −2.31° and +2.31° on the reported track
  // (straight road → 20° ramp → gap → landing road). Equal and opposite is the
  // signature of a systematic cause, not the chaotic landing behaviour that
  // several earlier attempts went chasing.
  //
  // WHERE IT COMES FROM. Roll is commanded as a rate about the CHASSIS FORWARD
  // axis. That is correct for pure roll — rotating about a vector cannot move
  // that vector, so heading is untouched — and it is what the note on the roll
  // axis says. But a ramp does not launch the car cleanly: the rear wheels leave
  // the lip last, so it takes off already pitching (measured 0.33 rad/s off a
  // 20° ramp). With a pitch rate present the forward axis is itself rotating, so
  // the commanded roll axis SWEEPS during the roll, and rotations about a moving
  // axis do not compose back to identity. They leave a residue, and its sign
  // follows the roll direction. Hence A-left / D-right, every time.
  //
  // It is real rigid-body behaviour, not a numerical artefact: the drift
  // CONVERGES (4.73° → 5.61°) as the substep is refined 16×, so no smaller step
  // or better integrator removes it.
  //
  // A previous attempt at a "world-Y heading lock" was removed, for a good
  // reason: it damped `body.angVel.y`, and for a rolled or pitched car part of
  // the roll itself has a vertical component, so it fought the trick. This is
  // not that. It is a hold on the HEADING ANGLE — it does nothing at all while
  // the heading is where you left it, and only pushes back on actual drift. A
  // pure roll therefore feels identical; only the residue is removed.
  /** Rate (rad/s) commanded per radian of heading error. 0 disables the hold. */
  airHeadingHold: 10.0,
  /** How fast that commanded rate is converged onto (1/s). */
  airHeadingGain: 6.0,
  /** Cap on the correcting yaw rate (rad/s) — this is a trim, never a turn. */
  airHeadingMaxRate: 2.0,
  /**
   * Minimum horizontal length of the chassis forward axis for the hold to act.
   * Nose-up or nose-down through a FLIP, "heading" is undefined (forward is
   * vertical), so it stands down rather than acting on a meaningless angle. The
   * target is kept, so it resumes once the nose comes back down.
   */
  airHeadingMinLevel: 0.35,
  /** How fast the actual rate converges on the target (1/s). Higher = snappier
   *  and more digital; lower = floatier. This is the "air feel" knob. */
  airResponse: 9.0,
  /**
   * Pitch-only convergence (1/s). Separate from `airResponse` because the
   * complaint was specifically about flips: softening the shared knob would
   * have made ROLL and YAW mushy too, and neither needed it. This is what turns
   * the flip from a switch into a press — 90% of full rate in ~500 ms instead
   * of 300 ms, so a light tap reads as a nudge rather than a quarter-flip.
   */
  airPitchResponse: 5.0,
  /**
   * Convergence toward ZERO on an axis with no input (1/s) — the tumble damping.
   * Softer than `airResponse` so a knock still tumbles naturally instead of
   * freezing the instant you let go.
   *
   * RAISED 2.0 → 2.5 because of what it does to a ROLL OFF A RAMP. A ramp does
   * not launch the car cleanly: the rear wheels leave the lip last, so it takes
   * off already rotating nose-up — MEASURED 0.33 rad/s off a 20° ramp. Pure roll
   * cannot change the heading (rotating about a vector cannot move that vector),
   * which is what the note on the roll axis says — but pitch-rate PLUS roll is
   * not pure roll, and the combination genuinely walks the heading round.
   *
   * This is the damping that removes the pitch rate, so it decides how much of
   * that coupling survives. MEASURED on the reported track (straight → 20° ramp
   * → gap → landing road, 360° roll held), heading drift accumulated IN THE AIR
   * before touching anything:
   *     airSettle  0 → 11.2° / 14.8°   (40 / 46 m/s)
   *                2 →  3.2° /  4.7°   (was shipped)
   *              2.5 →  2.4° /  3.6°   <- shipped now
   *                4 →  1.0° /  1.6°
   *                8 →  0.6° /  4.4°
   *               20 →  0.5° /  7.2°
   * It is NOT monotonic — past 4 the damping starts fighting the roll itself and
   * the drift comes back — so more is not better.
   *
   * 2.5 RATHER THAN 4 IS A CEILING, NOT AN OPTIMUM. 4 is over twice as good on
   * this bug, but it changes how a car settles after being knocked, and at 3.0
   * and above it breaks chassisCollisionTest's "land on the rail, fast" case
   * (the car ends below the 2 m/s the recovery check needs). 2.5 is the largest
   * value that keeps that green. If landing straight matters more to you than
   * that guardrail case, raising this is a one-line change.
   *
   * VERIFY WITH tools/rampGapRollRepro.mjs, which is the only instrument that
   * reproduces this: every earlier one launched the car by setting a velocity on
   * flat ground, i.e. with ZERO angular velocity, so the ramp's pitch rate — the
   * whole ingredient — was missing and the bug could not appear.
   */
  airSettle: 2.5,
  /**
   * Rate (1/s) the NON-roll rotation is killed at while the player is rolling.
   *
   * A roll about a FIXED axis is exactly reversible — hold A for a full turn and
   * the car comes back to where it started. Torque-free rotation is about a
   * fixed world axis, so a roll would be clean if nothing touched it. What
   * breaks it is the damping: every substep it changes the axis a little, and a
   * rotation whose axis moved does not return to identity. A ramp guarantees
   * there is something to damp (0.74 rad/s of pitch off the user's 24° jump
   * piece), which is why this only ever goes wrong after a ramp.
   *
   * SO LESS DAMPING IS BETTER HERE, NOT MORE — and that is the opposite of what
   * I first assumed, so the sweep is worth keeping. Heading error at touchdown
   * after a held 360° on the user's own track (tools/jumpDebugTrack.mjs):
   *      0   →  0.1°   but pitch runs away to 144° and it lands 4.3 m off line
   *      0.5 →  0.2°   pitch 67°, lands 0.6 m off line  <- best, see below
   *      1.2 →  1.0°   pitch 40°, lands 1.5 m off line  <- shipped
   *      1   →  2.0°
   *      2.5 →  2.7°   (this was `airSettle`, i.e. the old behaviour)
   *     14   →  4.6°
   *     30   →  5.4°
   * Monotonic the whole way. Zero is tempting and is wrong for a different
   * reason: nothing then removes the ramp's pitch rate at all, so the car
   * cartwheels and lands badly anyway.
   *
   * 0.5 IS THE BETTER NUMBER FOR THIS BUG and is not what ships, because it
   * trips two assertions in jumpPitchTest. Those measure a jump launched in
   * mid-air with ZERO angular velocity — the same unrepresentative launch that
   * hid this bug for two days, since no real jump leaves the ground without a
   * pitch rate. 1.2 is the smallest value that keeps that suite green. If the
   * landing line matters more to you than that test, 0.5 is a one-line change.
   *
   * Applies ONLY while a roll is actually held; everything else keeps `airSettle`.
   */
  airRollPurity: 1.2,
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

  // ── NOSE FOLLOWS THE ARC ────────────────────────────────────────────────
  // Left alone the chassis holds whatever attitude it launched with, because
  // nothing in free flight applies torque — which is CORRECT rigid-body physics
  // and looks wrong. Measured over a 35 m/s, 9 m/s-up launch: the trajectory
  // swings from +14° to −7° while the nose sits at exactly 0.0° the whole way,
  // so the car sails out flat and lands flat, and a jump reads as a hop.
  //
  // Real cars pitch through a jump because the rear wheels leave the ramp last
  // and aero pushes the nose down on the way in. Simulating either is far more
  // trouble than it is worth, so this does what arcade racers do: rotate the
  // nose toward the direction of travel. It is a rate target like every other
  // air axis, so it composes with the existing model rather than fighting it.
  //
  // Deliberately yields, in three ways, because "follow the arc" is exactly the
  // wrong instruction during a trick:
  //   • ANY pitch input (Shift/Ctrl) turns it off outright — the player wins.
  //   • It stops above `airAlignMaxSpin`, so a flip is never dragged back.
  //   • It requires roughly upright (`airAlignMinUp`), so it does not try to
  //     "correct" inverted flight to point at the ground.
  /** Rate per radian of error (1/s). 0 disables. err 14° ⇒ ~0.5 rad/s. */
  airTrajectoryAlign: 2.0,
  /**
   * Fraction of the trajectory angle the nose actually tracks.
   *
   * 1.0 (matching the arc exactly) is what "nose follows the arc" literally
   * means and it lands badly — 16° nose-down at touchdown, front wheels 150 ms
   * before the rear. Real cars pitch a little in a jump and land near-flat; they
   * do not rotate to match their flight path.
   */
  airAlignFraction: 0.5,
  /** Cap on the aligning rate (rad/s) — a gentle settle, never a snap. */
  airAlignMaxRate: 1.2,
  /** Convergence onto that rate (1/s). Well under `airResponse`: this is an
   *  ambient drift the player should never feel as a control input. */
  airAlignGain: 3.0,
  /** Below this speed (m/s) the velocity vector is noise, not a heading. */
  airAlignMinSpeed: 8,
  /**
   * Minimum chassis up·worldUp for the arc assist to act. 0.90 ≈ stands down
   * past 26° of tilt.
   *
   * RAISED from 0.35 (70°) because a pitch torque on a ROLLED car does not stay
   * on the pitch axis. The inertia tensor is very asymmetric (pitch 1554, yaw
   * 1890, roll 420 kg·m²) and `integrate()` runs torque through the full world
   * inverse inertia, so the correction acquires a yaw component — real physics,
   * which no choice of torque axis avoids. Two axis rewrites were tried and
   * neither helped; standing the assist down is what does.
   *
   * The player is flying the car during a roll anyway; the assist is there for
   * ordinary jumps, and a straight jump is unaffected (measured 0.0° either way).
   */
  airAlignMinUp: 0.90,
  /** Existing pitch rate (rad/s) above which this stays out of the way. */
  airAlignMaxSpin: 2.5,
  /**
   * ROLL rate (rad/s) above which the arc assist stands down. This is the gate
   * that was missing, and it is what made a barrel roll land crooked.
   *
   * `airAlignMinUp` already stands the assist down past 26° of tilt — but tilt
   * is an ATTITUDE test, and a rolling car sweeps back through upright twice per
   * rotation. So during a 360 the gate FLICKERS OPEN for a few ticks each time
   * the car passes level, and each time it fires a pitch torque into a body that
   * is spinning at up to 3.6 rad/s. Through the asymmetric inertia tensor
   * (pitch 1554, yaw 1890, roll 420 kg·m²) that comes back out partly as YAW —
   * which is the same mechanism airAlignMinUp was raised to 0.90 to stop, just
   * reached from the other side.
   *
   * MEASURED (tools/rollLandingSlide.mjs), heading error at touchdown with the
   * input released as soon as the roll completes:
   *     360° roll →   2.6° off      720° roll →  −16.1° off
   * and disabling the assist entirely takes the resulting off-line drift from
   * 4.24 m to 0.11 m. That is the "the car is not completely straight" half of
   * the report; landing part-way through the roll is the "shoves me sideways"
   * half, and both come from here.
   *
   * 0.8 sits far above the noise of an ordinary jump (~0) and far below a
   * deliberate roll (3.6), so a straight jump keeps the assist and a trick does
   * not. The assist is for ordinary jumps; during a roll the player is flying.
   */
  airAlignMaxRoll: 0.8,

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
  /**
   * Seconds of PROBE contact to wait for real wheel load before conceding that
   * the wheels are never going to take any, and firing the touchdown response
   * anyway. THIS IS WHAT MAKES "ARRIVAL" AN HONEST EDGE.
   *
   * Both halves below used to fire on first PROBE contact, and a tyre reports
   * `grounded` the moment its ray finds a surface — long before the wheel
   * touches. MEASURED (tools/landingAbsorbTiming.mjs), the upward velocity step
   * absorption took while NO wheel carried any load at all:
   *     14 m @ 30 m/s   8.47 m/s deleted, 92 ms and 2.75 m before support
   *     14 m @ 45 m/s   8.49 m/s deleted, 92 ms and 4.12 m before support
   *     30 m @ 30 m/s  12.95 m/s deleted, 58 ms and 1.75 m before support
   * i.e. on every real jump the car lost most of its fall speed about a metre
   * up and then GLIDED down the rest at half rate. That is the reported "magnet
   * that repositions the car", and it fired on every landing regardless of what
   * the player was doing — nothing to do with the barrel-roll assist.
   *
   * FIRING IT LATE ALSO MAKES IT WORK BETTER, which is not obvious: the impulse
   * now takes its cut of a full-speed arrival instead of one it already spent
   * half its budget on up in the air. Peak suspension compression FELL despite
   * the springs seeing nearly double the closing speed:
   *     gentle   v@load  −7.9 → −14.4    compression 0.204 → 0.176 m
   *     fast     v@load  −8.1 → −14.0    compression 0.251 → 0.198 m
   *     high     v@load −11.0 → −21.7    compression 0.272 → 0.256 m
   * against a bottom-out knee at 0.385 m (bottomOutThresh × restLength), so
   * there is MORE headroom on a hard landing than before, not less.
   *
   * The wait cannot simply be dropped, because one arrival never produces wheel
   * load at all: land across a GUARDRAIL and the tyres find nothing to compress,
   * since rails live in the SOLIDS bvh and the wheels only probe the DECK. That
   * landing is violent and still needs absorbing, so the grace concedes to it.
   *
   * 0.15 s is chosen from the measured probe lead: the longest real landing
   * takes 92 ms to load, so this never pre-empts one, and it is short enough
   * that the rail case is caught essentially on arrival.
   */
  landingSupportGrace: 0.15,
  //
  // (b) PREDICTIVE ALIGNMENT. While falling, look ahead down the flight path and
  //     ease the chassis' up-axis toward the surface it's about to hit. This is
  //     what stops a good jump ending in a random tumble because the car happened
  //     to be 20° off when it arrived. It only touches PITCH/ROLL — yaw spin is
  //     about the up-axis and is orthogonal, so deliberate flat spins survive.
  /** Master scale, 0..1. 0 = no landing help at all. */
  airLandAssist: 1.0,
  /**
   * Alignment torque (N·m) at full engagement.
   *
   * RAISED from 6000, which was an order of magnitude too weak to right a ROLLED
   * car. That is what caused the reported "car drifts by itself on landing": it
   * is not a rotation at all — the car arrives still rolled ~30°, the tyres bite
   * at an angle and shove it SIDEWAYS. Measured over a 45 m/s jump with 0.6 s of
   * roll input:
   *     torque  window   tilt@land   lateral slide
   *       6000   0.55s        30°        4.2 m
   *      20000   0.55s        19°        0.4 m
   *      45000   0.90s         2°        0.2 m
   * Every earlier attempt measured HEADING and found almost nothing, because the
   * car was barely turning — it was translating.
   */
  airLandTorque: 32000,
  /** Probe length (m). Only the reach of the look-ahead now — the RAMP is timed,
   *  see airLandTime. Long enough to see the landing coming at speed. */
  airLandRange: 40,
  /**
   * Seconds before impact over which the assist ramps 0→1, and over which the
   * nose-follows-arc pitch hands over to it.
   *
   * Timed rather than distance-based because the probe runs along the flight
   * path: on a fast shallow jump that is mostly horizontal, so slant range wildly
   * overstates how much time is left. Measured with the old distance ramp, engage
   * peaked at 0.53 all the way to touchdown — half strength precisely when the
   * car needed levelling, which is why jumps landed 17° nose-down and see-sawed
   * onto the front wheels 158 ms before the rear arrived.
   *
   * 0.55 s is about a car length of air at speed: enough to rotate level, short
   * enough that the player has long since committed to their trick.
   *
   * RAISED 0.85 → 1.4 because it was too short to level a car that is being
   * ROLLED, which is the case that actually needs it. A ramp gives about a
   * second of air and a 360 at `airRollRate` takes ~1.75 s, so the roll does not
   * finish: the player is still holding A/D at touchdown and the car arrives on
   * its side. MEASURED on that jump, tilt at touchdown and the heading the car
   * then snapped through on its own:
   *     0.85 s  →  88°   −27.7°
   *     1.40 s  →  69°    −3.0°
   *     1.80 s  →  68°    −2.9°
   * It saturates by 1.4, and a big jump still completes a full roll, so this
   * buys the landing without costing the trick.
   */
  airLandTime: 0.85,
  /**
   * Damping on the tilt rate while engaged, or the alignment overshoots and the
   * car wobbles through the last metres of the fall.
   *
   * MUST SCALE WITH airLandTorque. Raising the torque 6000 → 32000 while leaving
   * this at 1200 turned a long barrel roll into a 113° spin on touchdown: the
   * assist had five times the authority to swing the car and the same authority
   * to stop it, so it drove straight past level.
   */
  airLandDamp: 6400,
  /**
   * How much of the alignment is allowed to act on PITCH, 0..1. Roll is always
   * corrected in full; this scales only the nose-up/nose-down half.
   *
   * 0 BY DESIGN. The two halves of "align to the landing surface" are not equally
   * wanted:
   *   • ROLL levelling is the half that matters. A car that arrives 30° on its
   *     side digs a wheel and gets shoved sideways — that is the whole reason
   *     this assist exists (see airLandTorque).
   *   • PITCH levelling is the half that looks WRONG. It cancels the nose-down
   *     attitude the arc assist spent the whole descent building, so the car
   *     visibly flattens in the last few metres and slaps down on all four
   *     wheels at once. Reported as "the car gets flat and stabilised, that
   *     doesn't make sense". It is also not what a real car does: the nose leads
   *     and the rear follows a fraction of a second later.
   * MEASURED over a 6 m/s-up, 32 m/s jump — nose angle at front-wheel contact
   * and how long the rear took to arrive:
   *     pitchLevel 1.0 (old)   −5.7°    42 ms
   *     pitchLevel 0.0         −10.9°   83 ms
   * The second is the landing that was asked for.
   */
  airLandPitchLevel: 0,
  /**
   * Fraction of the assist surrendered while the player is actively rolling,
   * 0..1, scaled by |steer|.
   *
   * THE ASSIST MUST NOT SILENTLY CANCEL AN INPUT. Every other automatic help in
   * this file yields to the player (the arc assist stands down on any pitch
   * input, and above airAlignMaxSpin), but this one did not, and it is by far
   * the strongest torque in the air: 32000 N·m against the 13600 N·m ceiling the
   * rate model can ever ask for on the roll axis (3.6 rad/s × airResponse 9 ×
   * 420 kg·m²). Holding full roll therefore did almost nothing — reported as
   * "the car couldn't roll, something was resisting".
   *
   * "THEY CHOSE TO LAND ROLLED" WAS THE WRONG READ, and 1.0 is what made this
   * the most-reported bug in the game. Nobody choosing to roll is choosing to be
   * spat sideways on touchdown — they are trying to complete a 360 on a jump
   * that is shorter than the 360 takes. At 1.0 the assist was multiplied by
   * exactly ZERO for the entire descent (measured: peak engage 0.00 on every
   * ramp jump), so the one mechanism that levels the car never ran on the only
   * manoeuvre that needs it.
   *
   * 0.5, together with the time-scaled shaping at the use site, still stands the
   * assist well down while there is flight left — so a deliberate roll is not
   * fought — and lets it come back for the landing:
   *     yield 1.0 → tilt 88°, heading snap −27.7°
   *     yield 0.5 → tilt 69°, heading snap  −3.0°
   *     yield 0.0 → tilt 53°, heading snap  −1.1°
   */
  airLandInputYield: 1.0,

  // ── THE ASSIST ONLY ACTS WHEN THE LANDING WOULD ACTUALLY GO WRONG ────────
  // It used to engage on time-to-impact ALONE: within airLandTime of the ground
  // it ran at full authority whatever the car's attitude, so a plain jump —
  // no roll input, arriving a few degrees off — was clamped flat by the same
  // 32 kN·m that exists to save a blown barrel roll. Reported as "feels like a
  // magnet that repositions the car". MEASURED (tools/landingMagnetRepro.mjs),
  // roll attitude the car changed BY ITSELF in flight, zero input:
  //     6° residual tilt   → rolled itself 5.7° flat
  //     12° residual tilt  → rolled itself 11.4° flat
  //     0.4 rad/s ramp-edge roll rate → corrected 8.7° in-air
  // None of those landings needed saving: the stabilizer and the touchdown
  // damping already own errors that small the instant the tyres load.
  //
  // So engagement is scaled by NEED — the worse of two signals:
  //   • ROLL ERROR vs the surface about to be hit. A normal jump sits under
  //     the deadband and gets NOTHING; a car arriving 30°+ rolled gets full
  //     authority, exactly as before.
  //   • ROLL RATE. The error test alone would flicker OFF mid-barrel-roll —
  //     a rolling car sweeps through level twice per rotation — precisely when
  //     the car is rotating at 3.6 rad/s toward a bad landing. Rate keeps the
  //     assist solid through the whole roll, so the trick cases are untouched.
  // Input is deliberately NOT a signal here (airLandInputYield already handles
  // the held-roll case): need-based also catches a car knocked crooked by a
  // rail clip mid-air, which has no input to key on.
  /** Roll error (rad) vs the landing surface below which the assist is silent.
   *  0.10 ≈ 5.7° — above anything a clean jump arrives with, below anything
   *  that would dig a wheel and shove the car sideways. */
  airLandErrDead: 0.10,
  /** …and at which it reaches full authority. 0.30 ≈ 17°. */
  airLandErrFull: 0.30,
  /** Roll rate (rad/s) below which the rate signal is silent. Ramp edges leave
   *  ~0.3–0.4 rad/s (measured, 20° ramp) and airSettle removes that on its own;
   *  a deliberate roll runs at 3.6. 0.5 sits between. */
  airLandRateDead: 0.5,
  /** …and full authority. Well under airRollRate so a roll released early in
   *  the flight still keeps the assist while the rate bleeds off. */
  airLandRateFull: 1.5,

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

/**
 * Concave-surface grip — what makes tubes, loops and half-pipes drivable.
 *
 * THE PROBLEM THIS SOLVES, measured by tools/tubeControlRepro.mjs on the kit's
 * own r=8 tube. With a closed-loop driver actively steering to hold a wall-ride,
 * the car held its target bank 0% of the time at EVERY downforce tried,
 * including 13x the shipped value:
 *
 *     target  downforce   peak   held%   mean speed   min speed
 *       90°       3       44°      0%      10.3         1.6
 *       90°      12       76°      0%       8.6         0.0
 *       90°      40      180°      0%      13.4         5.8
 *
 * It enters at 35 m/s and settles around 10 m/s in every configuration. And it
 * is NOT an attitude failure: alignment lag to the wall stays at 2-5°, all four
 * wheels are down 100% of the time, the suspension never bottoms out (0%), and
 * the airborne landing assist never fires at all (0% air time). The car stays
 * perfectly glued and correctly oriented while decelerating out of the ride.
 *
 * WHY IT DIES. A tube is not a bank you hold, it is an orbit you sustain: static
 * hold needs tan(bank) <= mu, so past ~56° nothing can hold at all and the car
 * must keep circulating. Circulating means permanent hard steering, and steering
 * scrubs — brush-model scrub power is Fy * vLat, and vLat is proportional to
 * Fy / Fmax, so the loss goes as Fy^2 / Fmax. Bleed the speed and you lose the
 * circulation that was holding you up, which costs more speed. That spiral is
 * what "hardly controllable in a tube" actually is.
 *
 * THE FIX. Following a surface of curvature k at tangential speed v REQUIRES a
 * centripetal force m*v^2*k. On flat road k is 0 and this whole block is a no-op
 * — which is the point: it cannot regress ordinary driving, because it does not
 * exist there. On a concave surface it hands the tyres that force directly
 * instead of making them buy it out of the friction circle, so Fmax stays
 * available for driving and steering, and the Fy^2/Fmax scrub collapses.
 *
 * ONLY CONCAVE. Curvature is SIGNED here (see _applySurfaceGrip): a crest is
 * convex and gets nothing, because gluing the car to a crest with a
 * centre-of-mass force would kill every jump on the track.
 *
 * Holding the car over a crest it is MEANT to follow is a different mechanism in
 * a different place — see ROAD_HOLD, which acts per wheel and only on decks the
 * author tagged. It was tried here first, as a convex branch of this function,
 * and the shape of this force is wrong for the job: the curvature estimate
 * under-reads a slope's brow by about half (it is measured across a 2.6 m
 * wheelbase from smoothed normals), the `ease` costs most of its authority over
 * the ~0.2 s a fast car spends on a short convex section, and a force at the
 * centre of mass cannot stop the FRONT wheels leaving first — which is what
 * pitches the nose up and produces the "it jumps off flat" look.
 */
export const SURFACE_GRIP = {
  enabled: true,
  /**
   * Fraction of the centripetal requirement to supply. 1.0 would hand over the
   * whole thing; the suspension springs are already contributing some of it, so
   * the default deliberately supplies most-but-not-all and leaves the tyres
   * doing real work. Swept in tubeControlRepro before picking this.
   */
  gain: 0.85,
  /** Below this (1/m) the surface is flat and we do nothing. r=100 curve = 0.01. */
  minCurvature: 0.012,
  /** Hard ceiling on the added load, in car weights. Stops a degenerate normal
   *  spread (a seam, a wheel on an edge) from firing the car off the surface. */
  maxG: 6,
  /** Rate (1/s) the applied magnitude eases toward its target. THIS IS WHAT
   *  MAKES THE TUBE EXIT BEHAVE: curvature vanishes the instant the last wheel
   *  leaves the wall, and stepping the load to zero flicks the car sideways.
   *  Easing it out over ~a tenth of a second lets the exit read as driving off
   *  the end rather than being spat out of it. */
  ease: 12,
};

/**
 * ROAD HOLD — what makes a slope a slope instead of a launch ramp.
 *
 * THE BUG. Following a convex vertical curve of radius R at speed v needs v²/R
 * of downward acceleration. Gravity brings g and downforce a little more, so
 * unaided the car follows a hill only up to about √(g·R) — which on the kit's
 * compact Slopes presets (R 26 to 75 m) is 60 to 120 km/h, against a car that
 * reaches 180. Above that the wheels leave, and because TIRE.airTrajectoryAlign
 * then pitches the nose onto the ballistic arc, it does not even look like a
 * takeoff: it looks like the car ignored the slope and flew off level. That is
 * the whole of the player's report that none of the slopes were usable.
 *
 * IT IS NOT FIXABLE BY SHAPING. A piece 30 m long that gains 10 m HAS a ~35 m
 * crest radius; at 50 m/s that curve demands over 7 g. Reprofiling moved the
 * limits from 32-54 km/h to 61-119 and changed nothing anybody could feel,
 * because the speeds people drive were above both. Geometry CAN fix it — a 10 m
 * rise needs ~70 m of run to be followable flat out, which is what the Grade in
 * / Climb / Grade out family builds — but that answers "give me a climb", not
 * "I placed a hill and the car flew off it".
 *
 * SO THE CAR SUPPLIES THE MISSING CENTRIPETAL FORCE ITSELF, per wheel, on decks
 * the author tagged. The force is sized as exactly that — the curve's demand
 * minus what gravity and downforce already pay — and nothing else.
 *
 * ── THE VERSION BEFORE THIS ONE, AND WHY IT HAD TO GO ───────────────────────
 *
 * The first attempt measured how far the wheel had ALREADY fallen behind the
 * road (suspension droop) and pulled on that, as a critically-damped servo. It
 * passed every test in tools/roadHoldTest.mjs and was wrong anyway. Three
 * reports came back: the car "sticks like a magnet", the ride "doesn't feel
 * smooth at all", and — the diagnostic one — the sliders did nothing "no matter
 * the settings except 0". All three are the same defect.
 *
 * DROOP IS NOT THE QUANTITY. What decides whether a car follows a crest is
 * v²/R; how far a strut has extended is a different measurement in different
 * units, and the two are related only by the accident of both growing when
 * things go wrong. A force sized by the wrong quantity cannot be right, so it
 * gets tuned until it is merely big enough to WIN — and the size that always
 * wins is the size that reads as a magnet.
 *
 * AND IT WAS BIGGER THAN THE SUSPENSION. The tuned ceiling landed at
 * maxG 16 ⇒ 54,936 N at one corner, against a strut that produces 49,907 N
 * squashed absolutely flat (0.55 m of travel, bottom-out knee included). So
 * whenever the servo saturated — which was ALWAYS, every preset, the whole way
 * across — it out-pushed the spring and drove the hub through the deck.
 * MEASURED at 48 m/s over the shipped Slopes tab (tools/roadHoldSinkDiag.mjs):
 *
 *     hub 0.03–0.52 m BELOW the deck surface on all 9 presets
 *     compression to 0.88 m against 0.55 m of travel
 *     the arch-lift hack pinned at its 0.12 m cap on all 9
 *     peak pull 219 kN, on a car that weighs 13.7 kN
 *
 * which is the "wheels enter inside the road a lot" report, exactly. It is
 * structural, not a tuning error: no value of rate, damping or band moves a
 * ceiling that outranks the spring. Only maxG did, which is why 0 was the only
 * setting that changed anything.
 *
 * ── WHAT IT DOES NOW ────────────────────────────────────────────────────────
 *
 * Measure the curvature the tyre is actually on, and pay for it. As the wheel
 * crosses a vertical curve its contact normal ROTATES, and the rate it rotates
 * at is the curvature times the speed:
 *
 *     ω = (dn/dt)·t̂ = v·κ        so       v²·κ = v·ω
 *
 * (t̂ = travel direction along the surface; ω > 0 is convex, see the derivation
 * in Tire.apply). So the demand comes out as v·ω with no radius to estimate and
 * no division to guard, and the assist is
 *
 *     a = v·ω − (1 − loadFloor)·(what gravity and downforce already supply)
 *
 * floored at zero. Everything the old version got wrong falls out of this:
 *
 *  • IT CANNOT BOTTOM THE SUSPENSION. The force is spent turning the car along
 *    the curve, so it is balanced by the curve's own demand rather than by the
 *    spring. What the spring carries is the LEFTOVER tyre load, and `loadFloor`
 *    names that directly: at 0.3 the tyres keep 30% of static load over the
 *    brow, so the strut sits slightly EXTENDED — 1.6 cm of squash against 5.3
 *    static — instead of being crushed. The ceiling is now checked against the
 *    strut's own capacity (tools/roadHoldTest.mjs asserts maxG/4 < strut max),
 *    which the old one failed by 5 kN.
 *  • IT IS SMOOTH BY CONSTRUCTION. Curvature is continuous along a road, so the
 *    force is too — it fades in as the brow arrives and out as it leaves, with
 *    no trigger to sit on. The old one switched on at a threshold that was also
 *    its own target, which is a relay, which is why it buzzed.
 *  • THE SLIDERS DO SOMETHING. The car asks only for what the curve demands, so
 *    it spends its time BELOW the ceiling and changing the ceiling is felt.
 *  • IT STILL COSTS NOTHING WHERE IT IS NOT NEEDED. Flat road, flat turns and
 *    banked turns all measure ω ≈ 0 — a bank rotates the normal about the
 *    TRAVEL axis, and projecting onto t̂ ignores exactly that. A crest gentle
 *    enough for gravity alone leaves the max() at zero.
 *
 * WHY PER WHEEL rather than at the centre of mass: on a brow the front wheels
 * reach the curvature first, and each wheel paying for the curve under ITSELF
 * carries the pitch torque that keeps the nose down. A single force at the CoM
 * cannot express that, and the nose-up pitch is what made the old car look like
 * it flew off the slope level.
 *
 * WHY IT DOES NOT KILL JUMPS. It fires only where the deck under the tyre
 * carries the hold tag — stamped by the builder from FOLLOW_ROAD, which lists
 * slopes, crests, the grade family and banks, and deliberately excludes every
 * launcher (jump, dive, gap, landing, brow, quarterpipes, tube cannons). That is
 * an authoring decision expressed as data, because it has to be: a hill and a
 * ramp are the same shape, and no measurement of the surface can tell you which
 * one the author meant. tools/roadHoldTest.mjs drives the ramps to prove they
 * still throw the car as far as they ever did.
 */
export const ROAD_HOLD = {
  enabled: true,
  /**
   * HOW MUCH OF THE CREST FLOAT THE CAR KEEPS — the fraction of normal static
   * tyre load left on the tyres at the top of a brow, 0..1. This is the "does it
   * feel like a magnet" knob, and the only one most people should touch.
   *
   * Going light over a crest is REAL and worth keeping: it is most of what a
   * hill feels like from the driver's seat. So the assist does not supply the
   * whole v²/R (which would hold the tyres at full load and glue the car to the
   * road — the complaint about the previous version); it supplies enough to
   * leave this much load underneath.
   *
   *   0    the tyres go exactly weightless at the crest — the car follows the
   *        road but has no grip while it does, and the strut hangs at full
   *        droop. Steering and braking vanish over every brow.
   *   0.3  shipped. Noticeably light, still steerable, strut near rest.
   *   1    full static load over a crest, i.e. the road pulls as hard as the
   *        ground pushes. This is the magnet.
   *
   * It also sets when the assist starts: below a·(1−loadFloor) of demand the
   * max() is zero and nothing happens at all, so a gentle crest the car could
   * always follow is untouched, and the fade-in begins slightly BEFORE the
   * unaided car would have started to fly rather than at the failure itself.
   */
  loadFloor: 0.3,
  /**
   * Ceiling on the assist, in car weights, divided evenly per wheel — a corner
   * may ask at most maxG/4.
   *
   * TWO THINGS BOUND THIS, and they bound it from opposite sides.
   *
   * FROM BELOW: THE FRONT CORNERS NEED MORE THAN A QUARTER EACH. The demand is
   * shared per wheel, but on a brow the front axle reaches the curvature first
   * and carries it alone for a moment — traced on Hill, the fronts sat pinned at
   * the cap while the rears were still asking for half as much. Sized on the
   * whole car (Hill's 28 m brow asks 8.4 g at top speed) a ceiling of 12 looks
   * ample and is not: it capped the fronts and let half a metre of droop open
   * before the rears caught up, and 0.22 m is where droop starts to show,
   * because that is TIRE.maxDroop — the point past which the DRAWN wheel stops
   * following the contact and hangs in the air above the road.
   *
   * FROM ABOVE: a saturated assist must not by itself push the strut past the
   * compression where the wheel enters the deck (0.31 m — see
   * TIRE.bottomOutThresh). The strut answers 50.6 kN there, which caps this at
   * 14.7, and tools/roadHoldTest.mjs asserts it. The version before this one sat
   * on the WRONG side of that line by 5 kN, which is what put the wheels inside
   * the road in the first place.
   *
   * So the window is roughly 13 to 14.7, and 14 sits in it. Worst droop across
   * the Slopes tab at top speed, with the corrector at its shipped 20:
   *
   *     maxG 12   0.17 m        maxG 14   0.15 m
   *
   * It also keeps "Hill Jump" a jump: a 10 m brow asks 29 g, still twice this,
   * and it still throws the car 0.44 s into the air at top speed.
   */
  maxG: 14,
  /**
   * Low-pass rate (1/s) on the measured curvature.
   *
   * The deck is faceted, so the raw contact normal STEPS from one triangle to
   * the next and its difference — which is what the curvature is read from — is
   * a train of spikes whose MEAN is the real curvature. This averages them.
   *
   * Deliberately reading the RAW normal rather than the smoothed `hitNormal`:
   * TIRE.normalSmooth is already an 18/s (55 ms) filter, and differencing its
   * output then filtering again here would stack to ~88 ms of lag on a car that
   * crosses a whole crest in ~200 ms. One filter, 33 ms, applied to the quantity
   * that actually needs it.
   */
  curvSmooth: 30,
  /**
   * Clamp (rad/s) on the curvature rate a single substep may contribute, as a
   * guard against one bad facet — a seam, a kerb triangle, a wheel clipping the
   * edge of a piece — spiking through the filter. v·ω is an acceleration, so a
   * spike here is a shove.
   *
   * 8 rad/s is far outside anything real: the tightest road brow in the kit at
   * top speed is v/R = 50/10 = 5, and that is the piece named "Hill Jump".
   */
  maxOmega: 8,
  /**
   * Speed (m/s) below which no hold is applied. The demand is v·ω, which already
   * vanishes as the car stops, so this is not a divide guard — it is there so a
   * car crawling or parked on a crest is left entirely alone and reads as
   * ordinary suspension.
   */
  minSpeed: 3,

  // ── THE CORRECTOR ────────────────────────────────────────────────────────
  // Feed-forward pays for the curve; these clean up the error it cannot see.
  // See the FEEDBACK note in Tire.apply for why a term the first version of
  // this feature used as its whole mechanism is safe as a corrector.
  /**
   * Natural frequency (rad/s) of the droop corrector.
   *
   * 20 rad/s is a ~0.15 s settling time. MEASURED, worst droop across the Slopes
   * tab at top speed with the ceiling at 14: 16 rad/s left 0.21 m, 20 left
   * 0.15 m, 24 left 0.10 m. Past 20 it stops buying anything that shows — 0.22 m
   * is where the drawn wheel stops tracking the contact, so anything under that
   * looks the same — and it starts costing smoothness (RMS vertical jerk 2496 at
   * 20, 3063 at 24).
   *
   * The droop servo this descends from ran at 30 with no feed-forward at all,
   * so it had to produce the entire 8 g from a gap it first had to let open.
   * That is what made it saturate, crush the suspension and read as a magnet.
   * Here the feed-forward is already carrying the curve and this is correcting
   * centimetres, so a comparable settling speed costs a fraction of the force.
   */
  correctRate: 20,
  /**
   * Damping ratio is fixed at 1 (critical) in the code — it is not a knob,
   * because the whole point of the corrector is that it settles without
   * overshoot. What IS a knob is the clamp on the rate term (m/s): a wheel
   * crossing a tessellation facet can show a large closing speed for a single
   * substep, and 2·w is worth ~5.6 kN per m/s at a corner.
   */
  maxRate: 3.0,
  /**
   * Droop (m) past which the corrector stops asking for more. Beyond this the
   * wheel has genuinely LEFT — the end of a piece, a seam onto lower road — and
   * reeling it in from a distance is the magnet behaviour this design exists to
   * avoid. Feed-forward keeps paying for the curve regardless.
   */
  maxGap: 0.35,
};

/** Chassis shell vs the deck BVH — stops the body clipping into elevated track
 *  (ramps, loops, hard landings). Contact points (DECK_CONTACT) get pushed out
 *  along the deck normal once they sink within `skin` of the surface. */
export const DECK = {
  enabled: true,
  skin: 0.05,
  searchRadius: 0.8,
  stiffness: 220000,
  damper: 9000,
};

/**
 * ROOF-DOWN deck contact — the car on its lid, against a road surface.
 *
 * Split out because a roof contact is not a floor contact rotated. Two things
 * were missing and both are gameplay, not realism:
 *
 *  • NO TANGENTIAL LOSS. Deck contact is a pure normal spring (the wheels own
 *    friction), so an inverted car slid along the road forever at landing speed.
 *    A roof is not a wheel; sliding on it has to cost you.
 *
 *  • NO SIGNAL. Roof contact was indistinguishable from a rail scrape, so the
 *    game could not react to it. `roofTouch` / `roofImpactSpeed` are the hooks —
 *    roadGame breaks the drift chain on them, and STUCK still owns the eventual
 *    respawn.
 *
 * A contact counts as "roof" purely by geometry: the surface normal opposing
 * chassis-up. That is orientation-based, not corner-based, so it is also true
 * of the car pressed sideways into a ceiling, which is the same situation.
 */
export const ROOF = {
  enabled: true,
  /** Contact is roof-down when (deck normal · chassis up) is below this. −0.5 is
   *  60° off vertical — well past anything a wheel could still be holding. */
  dot: -0.5,
  /** Coulomb-ish drag along the surface, as a fraction of the normal force. Low
   *  next to a tyre (TIRE grip is ~1.7) — bodywork slides, it does not grip. */
  friction: 0.55,
  /** Ramps friction in below this sliding speed (m/s), so a car nudging its way
   *  out from under something is not glued in place. */
  frictionFullSpeed: 4.0,
  /** Hard ceiling on the roof drag, in car weights. The normal force it scales
   *  off is a 220 kN/m penetration spring, which spikes enormously for a substep
   *  on any hard contact — see the note at the application site. */
  maxFrictionG: 1.5,
  /** Closing speed (m/s) above which a roof touch reports as a real HIT rather
   *  than a rest. Below it the car is just lying there and the game should not
   *  keep firing impact events. */
  impactSpeed: 2.5,
  /**
   * OFF. While the roof is pinned against a road surface, stop the SUSPENSION
   * pushing the car further into it (see the ceiling-guard block in Tire.apply).
   *
   * IT WORKS, AND IT COSTS LOOPS. Turn it on and an inverted car comes to rest
   * exactly on its roofline and stays there — measured y 0.81 against a 0.76 m
   * roof, never sinking a millimetre, for a drop, a 15 m/s landing and a 40 m/s
   * slam alike (tools/roofContactTest.mjs). Off, all three sink through the deck
   * and fall to the respawn floor.
   *
   * But it also arms at the TOP OF A LOOP — measured at y 48–49.7, car inverted
   * (chassis-up.y −0.97), against a surface whose normal points UP (n.y 1.00)
   * within 5 cm of a roof sample. Every loop in tools/loopSpeedReadoutTest.mjs
   * then fails to crest. Which surface that is has not been identified: it is
   * not the slab the wheels are on (that faces down at the car), and the loop's
   * outer face is ~1.7 m away, well outside DECK.searchRadius.
   *
   * Two narrower discriminators were tried and measured:
   *   • roof contact alone           armed at every loop ENTRY, which runs under
   *                                  the loop's own descending slab — 4/7 loops
   *                                  lost. Fixed by the guardUpMin test below.
   *   • "wheel contact is behind the
   *      plane the roof rests on"    never fires: the probe starts 0.6 m along
   *                                  chassis-up, which inverted is INSIDE the
   *                                  slab, so it reports a hit at hub −0.28 with
   *                                  a contact point ABOVE the plane.
   *
   * So the trade today is: loops (constant, core gameplay) against inverted
   * landings (rare, and already handled — the car falls through, FALL_Y catches
   * it, STUCK respawns it). Loops win, exactly as the note in Tire.apply
   * concluded for the same reason.
   *
   * What is NOT in question: everything else in this block ships on. The roof
   * reaches the real roofline, ceilings no longer tunnel, roof contact is
   * reported to the game, and a lid-slide costs speed.
   *
   * Inverted landings on TERRAIN are a separate path (Tire.apply skips the
   * heightfield probe when chassis-up.y < `dot`; chassis corners hold the lid).
   * That does not use this flag, so loops stay safe.
   *
   * The heightfield is a vertical spring, not a mesh, so a lid slam pogos
   * unless we absorb the closing speed and keep the airborne landing assist
   * off for a beat after contact. Those knobs live here because they are the
   * terrain-lid half of the same roof-down problem — not a third system.
   */
  suspensionGuard: false,
  /** Fraction of downward speed removed the instant roof corners first hit
   *  dirt. The corner springs are 180 kN/m and underdamped (they exist to
   *  catch a chassis that has already sunk past the wheels); without this,
   *  an inverted drop launches the car and the landing assist then un-flips
   *  it in the air. Wheels-down landings never set `_terrainLid`. */
  terrainAbsorb: 0.8,
  /** Extra corner damper while the lid is the support, as a multiple of
   *  CORNER_DAMPER. Four corners at 1× are ~2.6× under critical. */
  terrainDamperMult: 3,
  /** Seconds the landing assist stays off after the last lid contact. A
   *  one-substep bounce must not re-arm the un-flip. */
  terrainLidHold: 0.35,
  /**
   * The guard only arms when the surface under the roof faces UP by at least
   * this much (world +Y) — i.e. the car is LYING on it, not driving under it.
   * See the measurement at the arming site: without this, every loop entry armed
   * the guard, because a loop passes under its own descending slab.
   */
  guardUpMin: 0.2,
  /**
   * Seconds a roof contact keeps the guard armed (s).
   *
   * MUST outlive one tick. Deck contact runs AFTER the tyres inside a substep,
   * so a flag cleared per tick is false for the first substep of every tick —
   * the wheels then push into the road half the time, which is most of the way
   * to not fixing it at all. A short hold makes the state continuous while a car
   * is lying on its lid, and it still clears within a couple of frames of being
   * flipped back over.
   */
  guardHold: 0.1,
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
  // Visual lean only. Kept small so the GLB silhouette doesn't read as a
  // collapsed suspension — a GT4 rolls ~1.5–2.5°/g; we sit a bit below that.
  /** Radians of roll per g of lateral load. 0.0192 ≈ 1.1°/g. */
  rollPerG: 0.0192,
  /** Radians of pitch per g of longitudinal load (squat / dive). ≈0.6°/g. */
  pitchPerG: 0.0105,
  maxRoll: 0.08, // ~4.6°
  maxPitch: 0.05, // ~2.9°
  /** Ease rate (1/s) toward the target angles. */
  smooth: 9,
  /**
   * Fraction of the lean's own vertical drop that is lifted back out, 0..1.
   *
   * THIS IS WHY WHEELS GO INSIDE THE BODY, and it is not the suspension. The
   * lean rotates the CHASSIS MESH about its origin while the wheels stay where
   * `_renderQuat` put them, so the outer arch sweeps DOWN onto a wheel that has
   * not moved — halfTrack·sin(roll) at the side, frontZ·sin(pitch) at the nose.
   * Neither is checked against the arch gap, and neither happens on flat ground
   * at constant speed, which is exactly the reported pattern: fine cruising,
   * clipping on bumps, jumps and in turns. MEASURED closure at the front-outer
   * arch (tools/archClearanceRepro.mjs), suspension vs lean:
   *     flat, cruising           −0.3 cm  +  3.7 cm  =   3.4 cm
   *     turn 35 m/s               2.0 cm  +  8.5 cm  =  10.5 cm
   *     brake + turn              3.7 cm  + 10.1 cm  =  13.9 cm
   *     landing INTO a turn       5.7 cm  +  8.4 cm  =  14.2 cm
   * The suspension column is the whole of what TIRE.minSuspExt controls; the
   * lean column is bigger and was uncorrected.
   *
   * DOUBLE-COUNTING, NOT PHYSICS. A real car's arch-to-tyre gap is governed by
   * SUSPENSION travel, which this rig already models separately. Rolling the
   * body about its own centre on top of that closes the gap a second time for
   * the same corner. Lifting it back out is the more correct model, not a fudge
   * — the body still visibly rolls, it just stops sinking onto its tyres.
   *
   * Raising CHASSIS_GLB.offsetY fixes the clipping for the same reason and was
   * the right diagnosis; it just buys the clearance at rest too, where none is
   * needed, so the car then stands too tall parked.
   *
   * Not 1.0: full cancellation holds the OUTER gap perfectly constant but opens
   * the INNER one by twice the roll drop, and the lifted inner wheel starts to
   * look detached. 0.85 leaves a little visible squat on the loaded corner while
   * still fitting inside the arch gap the fit provides — the budget is checked
   * every run by tools/chassisModelTest.mjs against maxRoll and maxPitch BOTH
   * saturated, which trail-braking into a corner can genuinely do.
   */
  archCompensate: 0.85,
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
  /**
   * Fraction of the slip angle PAST the deadband that the front wheels visually
   * take up. 0 = off.
   *
   * RAISED 0.7 → 1.0 together with the deadband below. The two move together:
   * the deadband decides WHEN the counter-steer look appears and the gain
   * decides how strong it is, so pushing the deadband out to a real drift buys
   * the room to make the drift itself read harder than it used to.
   */
  counterSteerVisual: 1.0,
  /**
   * Slip (rad) below which nothing is added.
   *
   * RAISED 0.06 (3.4°) → 0.35 (20°), because 3.4° is not a drift — it is an
   * ordinary corner, and the overlay was firing through all of them. The
   * counter term grows as gain × (slip − deadband) while the physical lock is
   * simultaneously being cut by `steerSpeedReduce`, so past ~13 m/s the overlay
   * simply outgrew the steering. MEASURED in a corner the car is still gripping
   * its way around (30 m/s, 0.2 input, slip −20°):
   *     deadband 0.06   physical +4.1°   drawn −5.9°   <- pointing the WRONG WAY
   *     deadband 0.35   physical +4.1°   drawn +4.0°   <- steers into the corner
   * Reported as "if I go fast and turn I don't see the front wheels turning,
   * but I see them counter-turning for the drift".
   *
   * The drift look does not pay for this — it gets BETTER, because the gain
   * went up at the same time. Peak counter-steer in a handbrake drift:
   *     0.06 / 0.7  →  −60°        0.35 / 1.0  →  −63°
   * Below ~20° of slip the car is cornering; above it, it is sliding, and only
   * then do the wheels start pointing down the road.
   */
  counterDeadband: 0.35,
  /** Cap on total visual steer (rad). ~43°, deliberately past the 31.5° the
   *  rack gives at speed — a drift-spec car runs extended lock and this is the
   *  only place that shows. Nothing reads it but the renderer. */
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

/**
 * Forward-facing headlights (cheap, no shadows). Two SpotLights parented to the
 * chassis mesh so they follow position + orientation for free. Mount/aim offsets
 * are chassis-local meters: +Z front, +Y up, +X right.
 *
 * THEY ARE SWITCHED WITH `intensity`, NEVER WITH `visible` — and that is not a
 * style choice, it is the difference between an instant toggle and a stall of
 * several hundred milliseconds.
 *
 * three's WebGPU renderer skips invisible objects when it builds the render list
 * (`Renderer._projectObject`: `if (object.visible === false) return`), so hiding
 * a light REMOVES IT FROM THE SCENE'S LIGHT SET. That set is hashed into
 * `LightsNode.customCacheKey()` (one entry per light id), which is folded into
 * `NodeManager.getCacheKey()`, which is folded into EVERY RenderObject's dynamic
 * cache key. Change it and every visible material in the world — terrain, grass,
 * trees, road, props, clouds, the car — is rebuilt on that one frame: new node
 * graph, new WGSL, new GPUShaderModule, new GPURenderPipeline, created through
 * the SYNCHRONOUS `device.createRenderPipeline` (the async path only runs inside
 * `compileAsync`). And it is not a one-off: switching back off drops the
 * pipelines' `usedTimes` to zero and releases them, so the next switch-on pays
 * again. These are the only punctual lights in the game, so the delta is the
 * worst possible one — zero spot lights to two.
 *
 * `intensity` is pure uniform data (`AnalyticLightNode.update` folds it into the
 * light-colour uniform each frame), so it is in no cache key at all. The price
 * is that two spot-light terms are compiled into every lit shader permanently,
 * including at noon — no shadows, no map, no colour node, so it is a couple of
 * ALU ops per fragment against a guaranteed multi-frame freeze.
 */
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
  /**
   * Seconds a solid contact is held for the RENDER layer (see
   * Vehicle._updateScrapeLatch). Physics ticks at 120 Hz and projection response
   * clears the penetration immediately, so a continuous rail scrape is really an
   * on/off flicker at tick rate — a 60 Hz frame samples it and mostly sees
   * nothing. 0.12 s bridges the flicker (~7 frames) without the shower lingering
   * after the car has left the rail.
   */
  scrapeHold: 0.12,
  enabled: true,
  /** Contact skin (m). This IS the collider inflation — keep it small. */
  skin: 0.08,
  /**
   * How far inside a solid a hull sample may sit and still be recovered (m).
   *
   * The skin is 8 cm; at 50 m/s a substep is 21 cm, so a sample can skip the
   * band and land in a cavity (the U of a rail, the 0.95 m arch wall). Distance
   * to the nearest face is then > skin, the overlap test misses, and the car
   * stays in the wall.
   *
   * A sample in that band is treated as inside ONLY if a ray along the away
   * normal (or a horizontal perpendicular, for an end-cap punch down a long
   * solid) hits another face — the car is walled in. A sample in open air
   * next to a wall does not get pulled in. 1 m covers a 0.95 m arch wall from
   * just inside the end cap. `behind` is not used: the solids bake is
   * double-sided, so that flag is a coin flip.
   */
  insideReach: 1.0,
  /**
   * Skip a solid contact whose normal's |Y| exceeds this. Solids are walls;
   * a mostly-up hit is a lid the hull can park on while the wheels still see
   * the road (rail ridge, hole-wall rim, jersey trough). 0.45 ≈ 63° from
   * horizontal.
   */
  sitNormalMaxY: 0.45,
  /**
   * ...BUT ONLY WHILE THE WHEELS ARE ACTUALLY CARRYING THE CAR.
   *
   * Read the rule above again: the lid is skipped so the hull cannot park on it
   * "while the wheels still see the road". That qualifier is the whole
   * justification, and it was never tested — every mostly-up contact was thrown
   * away, including the ones that were the car's ONLY support. A car coming down
   * on a guardrail has no wheel contact at all (rails live in this BVH and the
   * tyres only probe the DECK), so discarding its lid contact discarded
   * everything, and it carried on into the barrier. Measured in
   * tools/railTunnelTest.mjs before the fix: 28 of 72 descents onto the beam
   * ended up on the FAR side of it, crossing at road level.
   *
   * `_isSupported()` is the honest test rather than `groundedCount` — a tyre
   * reports grounded up to a metre before it touches, which on a descent is
   * exactly when this decision is made. So:
   *
   *   supported     → skip, unchanged. The hole-wall rim, the jersey trough and
   *                   the kerb seam all still let the car settle onto the road,
   *                   and a car merely driving past a rail is untouched.
   *   not supported → resolve it. Nothing else is holding the car up, so this
   *                   contact is the difference between landing ON a barrier and
   *                   passing THROUGH one.
   *
   * A car left balanced on a rail is then the stuck detector's problem, which is
   * what STUCK is for and already handles — a far better failure than a barrier
   * that does not barrier.
   *
   * KNOWN COST, measured rather than guessed. "Not supported" is also true for a
   * moment at a ramp's side edge, where the wheels hang off. Parkour ramps now
   * use shortened collision cheeks (see attachWedgeCheekSolids) so the hull is
   * not arguing with a full-height flank there; rails and other lids still need
   * this gate, which is why it stands.
   */
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
   *
   * Used by the deck resolver AND the solids BVH. A rounded start/finish nose
   * is a thin wall hit head-on; without the band the leftover speed after the
   * first scrape carried the hull through and the back face spat it out.
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
  /**
   * BEACHED — the guardrail case, and the reason the old rule never fired.
   *
   * With ZERO wheels on a drivable surface while resting on a solid, no input
   * can free the car: the wheels only probe the deck BVH and the rail lives in
   * the solids BVH, so there is no traction up there at all. That is a fact
   * about the contact model, not a heuristic — so it needs neither the throttle
   * (a player who lands on a rail lets OFF the gas, which armed nothing) nor
   * the tight 1.5 m/s gate (measured: a car settling on a rail creeps at
   * ~2.1 m/s and so never qualified either). Both of those are why the
   * documented give-up path in roadGame never actually triggered.
   *
   * Uses 3-D speed, not horizontal: a car FALLING past a rail is not beached,
   * and its vertical velocity is what says so.
   *
   * Kept under a wall-ride's speed — sliding a wall at 4 m/s is gameplay, and
   * must never be mistaken for being stuck on one.
   *
   * Also excluded: roof-down on open ground. Inverted wheels skip the
   * heightfield on purpose, so groundedCount is 0 by design and the <3 rule
   * would recover-to-ramp after `respawnAfter`. That is a crash rest, not a
   * trap — R still teleports if the player wants out. Wedged inverted against
   * a solid still qualifies.
   */
  beachedSpeed: 2.5,
  /**
   * Hull sitting on an undriveable lid while 3–4 wheels still see the road.
   * The old rule required groundedCount < 3, so a car perched on a rail or
   * hole-wall rim with tyres raycasting the deck never qualified.
   */
  sitUpMin: 0.45,
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
  /**
   * Seconds after a nudge during which the car's own hop does NOT count as being
   * free (unless it genuinely lands on something drivable).
   *
   * The decay above was meant to stop the nudge looping and does not quite: a
   * 3.5 m/s hop keeps the car over `beachedSpeed` for longer than the decay
   * takes to drain 0.8 s of timer, so the timer reached 0, `_stuckNudged`
   * re-armed, and the car bounced on the same rail forever without ever
   * escalating to the respawn. Measured on the flat-rail case in
   * tools/guardrailStuckTest.mjs: peak stuckTime 0.81 s against a respawnAfter
   * of 2.5, i.e. it never got a third of the way there.
   *
   * SIZED BY THE ESCALATION, not by the hop: ONE failed nudge must reach the
   * respawn rather than buy itself another nudge, so `nudgeAfter + nudgeHold`
   * has to clear `respawnAfter` (0.8 + 1.8 > 2.5). That is also comfortably
   * longer than a 3.5 m/s hop's 0.71 s flight, so a nudge that DOES work still
   * gets judged on where the car lands.
   */
  nudgeHold: 1.8,
  /**
   * Seconds after a teleport during which beaching is ignored.
   *
   * respawn() used to leave `_stuckTime` untouched. Pressing R with the timer
   * already past `respawnAfter` made roadGame recover on the SAME FRAME, then
   * again every frame after, each time lifting last-safe by 0.5 m — which is
   * how a restart parked the car on the lap ghost's roof. Clearing the timer
   * is the real fix; this window covers the few ticks of settling (vel ≈ 0,
   * < 3 wheels down) that would otherwise immediately start a new count.
   */
  ignoreAfterTeleport: 0.4,
};

/**
 * Crash yield — after a REAL crash, the landing assists go quiet so the car
 * can tumble. They stay on for ordinary jumps.
 *
 * Wall hits are dead on purpose (`SOLID.restitution` 0.05 / `spin` 0.15).
 * Raising those globally would bounce every scrape. While this hold is
 * active — and on a swinging/sliding mover that is already a wrecking-ball
 * — response uses the values below instead. Static barriers you clip while
 * driving stay dead.
 *
 * Armed by a hard solid close-speed, a moving solid at `moverSpeed`, or an
 * inverted roof slam. Cleared as soon as the car is back on enough wheels
 * and upright, unless a mover armed it (those keep the hold).
 */
export const CRASH = {
  enabled: true,
  /**
   * Closing speed into a solid (m/s) that counts as a crash. Tangential scrapes
   * and wall-rides are well under this; a head-on clip is well over.
   *
   * 18, NOT 14, and the difference is one piece. Driving the kit at 40 m/s
   * (tools/corkscrewCrashProbe.mjs) every piece reports a peak closing speed of
   * exactly 0.0 — the car never touches a rail on a straight, a quarterpipe, a
   * jump or a loop — except the CORKSCREW, which presses against the rail as the
   * road rolls under it and peaks at 14.2. At 14 that made driving a corkscrew
   * properly into a crash, which cut the assists mid-roll and put the chase
   * camera through the road for 52 frames. Nothing else on the track lands
   * between the two numbers, so the gap is real rather than fitted, and 18 m/s
   * (65 km/h of closing speed into a barrier) is still unambiguously a crash.
   */
  wallSpeed: 18,
  /** Relative close-speed (m/s) against a MOVING solid that counts as a crash.
   *  A pendulum's tip is ~6 m/s — under `wallSpeed`, but it should still wreck
   *  you. Push-gate peak is ~3.6 and stays a shove. */
  moverSpeed: 5,
  /** Roof closing speed (m/s) while inverted that counts as a slam, not a rest.
   *  Above ROOF.impactSpeed so lying on the lid does not re-arm every tick. */
  roofSpeed: 6,
  /** Seconds assists stay quiet after the event, unless recovered earlier. */
  hold: 1.8,
  /**
   * Seconds a crash is guaranteed to run before the wheels are allowed to end it.
   *
   * WITHOUT THIS THERE ARE NO CRASHES AT ALL, and that was the shipped
   * behaviour. `recovered` below is evaluated in the same call that arms the
   * yield, so a crash was armed and cleared on the same substep whenever the car
   * still had three wheels down — which is every crash you have while DRIVING.
   * Measured in tools/crashResponseRepro.mjs before the fix: a 60 m/s head-on
   * into a barrier engaged the crash state for 0.00 s and rolled the car 1°. It
   * simply stopped dead, which is exactly the "this car doesn't have collision
   * physics" the player reported.
   *
   * A guaranteed window is what lets the tumble develop: the response only
   * imparts angular velocity, and the stabilizer re-plants the car the instant
   * the yield ends. At CRASH.maxSpin a half roll takes ~0.5 s, so 0.7 s is
   * enough for a real barrel roll to commit while staying short enough that a
   * hard clip you drive out of does not cost you the corner.
   */
  minHold: 0.7,
  /** Chassis-up.y above this, with enough wheels down, is a recovery. */
  recoverUp: 0.5,
  recoverWheels: 3,
  /** Bounciness while yielded / wrecking-ball. SOLID.restitution stays 0.05. */
  restitution: 0.4,
  /** Off-centre torque fraction while yielded. SOLID.spin stays 0.15. */
  spin: 0.55,
  /** rad/s cap while yielded. SOLID.maxSpin stays 2.5 so scrapes cannot wind up. */
  maxSpin: 6,
  /**
   * What is left of the stabilizer's roll/pitch damping during a crash.
   *
   * Not 0. The damping is the only thing keeping a tumble legible — with none
   * of it the car spins up to the `TIRE.maxAngVel` ceiling and reads as a
   * blur — but at full strength it bleeds the roll off before it can commit.
   * See the damping block in _applyStabilizer.
   */
  dampScale: 0.25,

  // ── TRIP-OVER ROLLOVER — the barrel roll ─────────────────────────────────
  //
  // A side impact CANNOT roll this car, and that is structural rather than a
  // tuning problem. The spin impulse is `r × n` about the CENTRE OF MASS, and
  // for a hit on a flat barrier the contact averages out at roughly CoM height,
  // so `r` has almost no vertical lever: measured, once the crash state was made
  // to engage at all, 6–7 rad/s of YAW against 0.1–0.3 of roll at every angle
  // and speed (tools/crashResponseRepro.mjs).
  //
  // Nor can the tyres supply it. TIRE.contactPatchForces is 0, so a tyre's
  // lateral force is applied AT THE HUB — there is no lever below the CoM, and
  // therefore no rollover moment anywhere in the model. Setting that to 1 is the
  // physical fix and changes handling everywhere, so the trip lives here, inside
  // the crash window, where the assists are already standing down.
  //
  // WHAT IT MODELS. With the tyres planted, a car shoved sideways does not
  // rotate about its CoM — it pivots about the tyre contact line, because that
  // is what the ground is holding. The barrier pushes at bumper height, the
  // ground holds the bottom, and the couple rolls the car AWAY from the wall.
  // Taking the lever from the ground plane instead of the CoM is the whole
  // difference between a car that spins flat and one that goes over.
  //
  // Keyed to the impact, NOT to a sustained sideways slide: a wall reverses the
  // lateral velocity within one tick (measured: −19.7 → +4.5 m/s), so there is
  // never a slide left to trip over by the time the response has run.
  /**
   * Roll rate (rad/s) gained per m/s of impact closing speed, when planted.
   *
   * Stands in for impulse × lever ÷ roll inertia, all three of which are fixed
   * for this car, so one number is the honest amount of tuning available.
   * 0.16 puts a 25 m/s clip at 4 rad/s — a committed roll — while an 8 m/s
   * nudge gets 1.3, which leans the car and drops back onto its wheels.
   */
  tripRoll: 0.5,
  /** Roll-rate ceiling for a trip (rad/s). Above CRASH.maxSpin on purpose —
   *  see the cap in step 5 of _applySolidContact. */
  tripMaxRate: 8.5,
  /** Height of the centre of mass above the tyre contact line (m) — the lever
   *  the car pivots over. Roughly wheel radius plus ride height. */
  tripPivotDrop: 0.5,
  /**
   * How much of the pivot's linear velocity is actually applied, 0..1.
   *
   * 1.0 is the honest rigid-body answer (v = ω × r about the contact line) and
   * it is deliberately not the default: at full value a hard clip throws the car
   * clear of the road, because the real thing sheds that energy through tyres
   * and bodywork that this model does not have. This is the dial between "leans
   * and recovers" and "goes over" — see tools/crashResponseRepro.mjs.
   */
  tripLift: 0.55,
  /**
   * What is left of the airborne idle-settle while a crash runs, 0..1.
   *
   * TIRE.airSettle drives every un-commanded rotation rate back to zero so a
   * knock does not leave the car spinning forever. A tumble is exactly that,
   * which made it the last assist quietly cancelling the crash: the trip would
   * lift the car onto its side and the air control flattened it before it came
   * down. 0.1 keeps enough to stop a slow eternal rotation without deleting the
   * roll the player just earned.
   */
  airSettleScale: 0.1,
};

/** Cached each rebuild — offset from box center to CoM in chassis-local space. */
const _COM_OFFSET = new THREE.Vector3();
/** Scratch for _worldToGeom. */
const _invQuat = new THREE.Quaternion();
/** Shared constants for composing instanced wheel matrices. */
const _UNIT_SCALE = new THREE.Vector3(1, 1, 1);
const _MIRROR_Y = new THREE.Matrix4().makeRotationY(Math.PI);

function _syncComOffset() {
  _COM_OFFSET.set(CHASSIS.comX, CHASSIS.comY, CHASSIS.comZ);
}

/* ----------------------------------------------------------------------- */
/* Rigid body — 6-DOF, force/torque accumulators                            */
/* ----------------------------------------------------------------------- */

/**
 * Minimal rigid body: mass, a real (box) inertia tensor, and semi-implicit Euler.
 *
 * EXPORTED because it is fully general — nothing in here knows about cars. Track
 * props (cones, barrels) reuse it rather than pulling in a second physics engine
 * alongside the one already integrating the vehicle. `addForceAtPoint` is what
 * makes a knocked cone tumble instead of slide: it turns an off-centre impulse
 * into torque, which is most of what sells the effect.
 */
export class RigidBody {
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
    /** 0..1: how far the longitudinal demand exceeded this tyre's grip. Set in
     *  apply(); read by the tyre marks and drift smoke. Applies no force. */
    this.overDemand = 0;
    this.hitDistance = TIRE.rayLength;
    this.hitPoint = new THREE.Vector3();
    this.hitNormal = new THREE.Vector3(0, 1, 0);
    /** Is the surface under this tyre road the car is meant to stick to? Comes
     *  from the deck BVH's per-vertex tag; read by _applySurfaceGrip to decide
     *  whether a CONVEX curve gets help. See FOLLOW_ROAD in modularRoadKit.js. */
    this.hitRoadHold = false;
    /** Newtons of road hold applied last substep — diagnostics only. See ROAD_HOLD. */
    this.roadHoldForce = 0;
    /** Low-passed contact normal. The rate the surface rotates is read by
     *  differencing THIS rather than the raw normal, because the raw one is a
     *  per-facet staircase — see the note in apply(). Invalid across a break in
     *  contact: a landing puts two unrelated normals either side of the
     *  difference. */
    this._holdNS = new THREE.Vector3(0, 1, 0);
    this._holdNValid = false;
    /** (dn/dt)·t̂, i.e. v·curvature. Positive = convex. Diagnostics only. */
    this._holdOmega = 0;
    /** Previous substep's compression, for the corrector's rate term. Invalid
     *  across a break in contact — a landing would difference two unrelated
     *  states. See the FEEDBACK note in apply(). */
    this._prevComp = 0;
    this._prevCompValid = false;
    /** Scratch for the travel direction along the surface. */
    this._holdVt = new THREE.Vector3();
    this.worldPos = new THREE.Vector3();
    this.lastSuspension = new THREE.Vector3();
    this.lastSteering = new THREE.Vector3();
    this.lastAccel = new THREE.Vector3();
    this._smoothDist = undefined;
    /** Ground-hugging extension this wheel wants (m); may be negative on a deep
     *  hit. Set by Vehicle._updateWheelExtensions. */
    this._visExt = 0;
    /** Extension the wheel is actually DRAWN at (m) — `_visExt` plus whatever
     *  arch shortfall the body did not absorb. Visual only. */
    this.visualExt = 0;
    /** Unfiltered contact normal, before the low-pass in apply(). */
    this._rawNormal = new THREE.Vector3(0, 1, 0);
    /** Low-passed contact normal — this is what `hitNormal` exposes. */
    this._smoothNormal = new THREE.Vector3(0, 1, 0);
    /** Was this tire on a surface last tick? Drives snap-vs-filter. */
    this._hadGround = false;
    /** Set by the Vehicle each substep: is the car LYING on its roof? The one
     *  bit that tells an inverted car from a loaded strut in a tube — see the
     *  ceiling-guard block in apply(). */
    this.roofPinned = false;

    this._tireVel = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._wheelFwd = new THREE.Vector3();
    this._wheelRight = new THREE.Vector3();
    /** Wheel velocity and the RIGHT axis projected into the CONTACT PLANE — see
     *  the slip block in apply(). Identity while the car is square to the
     *  surface. Longitudinal deliberately stays on the raw axis. */
    this._planeVel = new THREE.Vector3();
    this._planeRight = new THREE.Vector3();
    this._steerQuat = new THREE.Quaternion();
    this._F = new THREE.Vector3();
    this._down = new THREE.Vector3();
    this._rayO = new THREE.Vector3();
    this._rayOff = new THREE.Vector3();
    this._bestP = new THREE.Vector3();
    this._bestN = new THREE.Vector3(0, 1, 0);
    /** Where tyre force is applied — hub..contact patch, see TIRE.contactPatchForces. */
    this._patch = new THREE.Vector3();
  }

  /** Cast rays + optional sphere sweep; keep the closest ground hit. */
  _probeGround(castGround, castSphereSweep, pad, far) {
    const fwdBias = TIRE.rayForwardBias * WHEEL.radius;
    const latBias = TIRE.rayLateralBias * WHEEL.thickness * 0.5;
    const ringN = Math.round(TIRE.rayRingCount);
    const ringR = WHEEL.radius * TIRE.rayRingScale;

    let bestDist = Infinity;
    let bestPoint = null;
    let bestSource = null;
    let bestHold = false;

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
      bestSource = hit.source || null;
      bestHold = hit.roadHold === true;
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
        consider(
          { distance: sh.distance, point: sh.point, normal: sh.normal, roadHold: sh.roadHold },
          sh.distance + sr,
        );
      }
    }

    return bestDist === Infinity
      ? null
      : { dist: bestDist, point: bestPoint, source: bestSource, roadHold: bestHold };
  }

  /** Drop to the airborne state. Shared by "no probe hit" and the roof guard —
   *  `overDemand` in particular MUST be cleared here, or a tyre keeps the last
   *  value it had on the ground and starts smoking again the instant it lands. */
  _clearContact() {
    this.grounded = false;
    this.compression = 0;
    this.overDemand = 0;
    this.hitRoadHold = false;
    this.roadHoldForce = 0;
    this._holdNValid = false;
    this._holdOmega = 0;
    this._prevCompValid = false;
    this.hitDistance = TIRE.rayLength;
    this._hadGround = false; // next contact snaps instead of easing in
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

    if (!probe) { this._clearContact(); return; }

    // Inverted wheels vs the TERRAIN heightfield.
    //
    // That probe is a vertical projection regardless of ray direction, so an
    // inverted origin (0.6 m along chassis-up = into the dirt) still "hits"
    // the ground and the strut pushes along chassis-up — into the world. That
    // is the jitter / under-terrain bug. Loops and tubes are ROAD meshes, so
    // they do not carry `source: "terrain"` and are untouched. Do NOT reuse
    // ROOF.suspensionGuard for this: that flag also armed at the top of a loop.
    if (probe.source === "terrain" && this._up.y < ROOF.dot) {
      this._clearContact();
      return;
    }

    const bestDist = probe.dist;
    this.grounded = true;
    this.hitRoadHold = probe.roadHold === true;
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

    // ── CEILING GUARD, WITH THE DISCRIMINATOR THE NOTE BELOW WAS MISSING ─────
    //
    // A contact BEHIND the hub (negative distance) is ambiguous from inside the
    // chassis frame — see the note. It is either an inverted car finding the
    // road through its own roof, or a strut bottomed out against a tube wall.
    //
    // The deck resolver supplies what the chassis frame cannot: whether the car
    // is LYING ON ITS ROOF right now. With that, a negative hub distance stops
    // being ambiguous and becomes exactly what it looks like.
    //
    // MEASURED, car on its lid on a flat deck: the probe starts 0.6 m along
    // chassis-up, which inverted is 0.6 m BELOW the car — inside the slab it is
    // lying on. The sweep therefore reports contact immediately, at hub −0.28,
    // and the suspension extends "down" toward it, which is up through the road.
    // Four wheels' worth of that beats the roof spring and the car sinks.
    //
    // `roofPinned` is what keeps this from being the guard the note below says
    // was removed. It is armed only by a surface the roof is RESTING on (see
    // _applyDeckContact), so every case that killed the previous attempt is
    // excluded before the hub distance is even looked at:
    //   • tube / loop   strut bottomed out, contact just above the hub — but
    //                   nothing is against the roof, so this never fires
    //   • loop ENTRY    runs under the loop's own descending slab, so the roof
    //                   IS touching — but that is a CEILING, and a ceiling
    //                   deliberately arms nothing
    if (ROOF.enabled && ROOF.suspensionGuard && this.roofPinned && distFromHub < 0) {
      this._clearContact();
      return;
    }

    this.hitDistance = distFromHub;
    this.compression = TIRE.restLength - distFromHub;

    // NOTE — a 'ceiling guard' was tried here and REMOVED. Do not re-add one
    // without reading this. (The guard above is NOT that guard: it fires only
    // while the roof is pinned, which is the discriminator this note says was
    // missing. Everything below still applies to the unguarded case.)
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
    //
    // THE DAMPER MEASURES TRAVEL ALONG THE SURFACE NORMAL, NOT THE CHASSIS UP
    // AXIS. This used to be `_tireVel.dot(this._up)`, which is only the same
    // thing while the car is square to the road. Tilt the chassis relative to
    // its own velocity — which is exactly what a landing leaves behind — and the
    // car's FORWARD SPEED projects onto the chassis up-axis and is read as
    // suspension travel that is not happening.
    //
    // MEASURED on jump-debug.json, cruising the landing road at 44 m/s pitched
    // 3.5° nose-down, per front wheel:
    //     _tireVel · chassisUp   1.718 m/s   ← phantom, it is just forward speed
    //     _tireVel · hitNormal   0.090 m/s   ← the real travel rate
    //     spring 24186 N − 6500 × 1.718 = 13019 N   (the force actually applied)
    // i.e. the damper was cancelling 11.2 kN — most of the car's weight — out of
    // the front springs, and 9.5 kN out of the rears. The car settled 23 cm low
    // and nose-down with a 2:1 front/rear load split, which is a hard oversteer
    // balance, and from there ANY yaw seed grew exponentially (doubling every
    // ~150 ms) until the car spun. That is the "it turns by itself long after a
    // clean landing" bug: the trick only planted the seed, this held the car in
    // a permanently broken attitude that made the seed grow.
    //
    // ONLY WHERE THE WHEEL IS SQUARE TO THE SURFACE, which is the only place the
    // phantom exists: at 3.5° of pitch on flat road (up · n) is 0.998, so the
    // fix has full effect exactly where the bug lives, on banks and inside loops
    // too. An OBLIQUE contact is a different situation — a wheel against the
    // side of a guardrail, an edge, a wall — and there the normal carries almost
    // none of a vertical drop, so switching axes removes the impact absorption
    // rather than a phantom. Measured: ungated, chassisCollisionTest.run's
    // "land on the rail, fast" stopped recovering and fell to y −46 (and −26
    // without the 1/cos), because a 30 m/s drop onto a near-vertical face damped
    // as though nothing were closing. Those contacts keep the old axis.
    // AND only while the spring is actually carrying load. At compression <= 0
    // the strut is extended past rest, the spring contributes nothing, and the
    // whole force is damper — that is an IMPACT being absorbed, not a car riding
    // on its springs, and it is what the rail landing is: measured, every
    // contact through that drop sits at compression −0.12 to −0.67. Reading the
    // closing speed off the normal there is stronger than off the chassis axis
    // (v·n −3.42 vs v·up −0.50 on the same tick), so it punts the car off the
    // rail and over the edge. Load-bearing contacts are the only ones the
    // phantom distorts, so they are the only ones that change.
    const upDotN = this._up.dot(this.hitNormal);
    const upVel = (this.compression > 0 && upDotN > TIRE.damperNormalMinFacing)
      ? this._tireVel.dot(this.hitNormal) / upDotN
      : this._tireVel.dot(this._up);
    let springMag = this.compression * TIRE.springStrength;
    const ovr = this.compression - TIRE.restLength * TIRE.bottomOutThresh;
    if (ovr > 0) springMag += ovr * ovr * TIRE.springStrength * TIRE.bottomOutMult;
    const dampMag = upVel * TIRE.damper;
    const suspMag = Math.max(0, springMag - dampMag);
    this._F.copy(this._up).multiplyScalar(suspMag);
    body.addForceAtPoint(this._F, this.worldPos);
    this.lastSuspension.copy(this._F);

    // ── ROAD HOLD — pay for the curvature the tyre is actually on ────────────
    //
    // See the ROAD_HOLD block for what this is and what the droop-servo version
    // before it got wrong. The whole mechanism is: work out what the curve under
    // this wheel demands, subtract what gravity and downforce already supply,
    // and add the difference. Nothing here is tuned to "win" — it asks for the
    // shortfall and no more, which is why it neither glues the car down nor
    // crushes the suspension.
    //
    // MEASURING THE CURVATURE. As a wheel crosses a vertical curve its contact
    // normal rotates. For a convex arc of radius R, taking θ as the arc angle
    // along travel and t̂ as the travel direction tangent to the surface,
    //
    //     n(θ) = cos θ · up + sin θ · t̂        dn/dθ = −sin θ · up + cos θ · t̂
    //
    // so at the contact (θ = 0) dn/dθ = t̂, and with dθ/dt = v/R,
    //
    //     ω ≔ (dn/dt)·t̂ = v/R = v·κ     ⇒     v²/R = v·ω
    //
    // The demand is therefore v·ω with no radius to estimate, no baseline to
    // measure it over, and no division by anything that can be zero. ω is SIGNED
    // exactly the way it needs to be: positive over a crest (the normal tips
    // forward as the road falls away) and negative in a bowl, which is
    // SURFACE_GRIP's job and is skipped here.
    //
    // Projecting onto t̂ is also what makes a BANK free: banking rotates the
    // normal about the travel axis, which has no component along t̂, so a banked
    // turn measures ω ≈ 0 and asks for nothing.
    let holdTarget = 0;
    if (ROAD_HOLD.enabled && this.hitRoadHold) {
      // Travel direction along the surface. The normal component is closing
      // speed — a bump, not orbital motion — and counting it would read every
      // landing as curvature.
      this._holdVt.copy(this._tireVel);
      this._holdVt.addScaledVector(this.hitNormal, -this._holdVt.dot(this.hitNormal));
      const vt = this._holdVt.length();
      if (vt > ROAD_HOLD.minSpeed) {
        this._holdVt.multiplyScalar(1 / vt);
        // SMOOTH THE NORMAL, THEN DIFFERENCE IT — in that order, and the order is
        // the whole trick.
        //
        // The deck is faceted, so the raw normal is a STAIRCASE: constant across
        // a triangle, then a step. Differencing that gives zero on most substeps
        // and one enormous spike per facet — on Hill's brow, 14 substeps of
        // nothing and then 22 rad/s, whose mean is the true 1.7. Filtering
        // afterwards recovers the mean only if nothing eats the spike, and
        // something did: the outlier clamp. Measured, the assist came out about
        // three times too small and Hill still launched.
        //
        // Filtering FIRST removes the staircase instead of trying to survive it.
        // A low-pass passes a steady rotation through unchanged, so the mean is
        // still exactly right, but the signal it is differencing is now
        // continuous — the per-facet peak lands near 2.6 rad/s rather than 22,
        // and the clamp goes back to being what it was meant to be: a guard for
        // genuinely bad geometry that never fires in normal driving.
        const k = 1 - Math.exp(-ROAD_HOLD.curvSmooth * dt);
        const before = this._holdNS.dot(this._holdVt);
        this._holdNS.lerp(this._rawNormal, k);
        if (this._holdNS.lengthSq() > 1e-8) this._holdNS.normalize();
        // No previous normal on the first substep of a contact, and a landing
        // would otherwise read as one huge rotation.
        let omega = this._holdNValid
          ? (this._holdNS.dot(this._holdVt) - before) / Math.max(1e-5, dt)
          : 0;
        if (omega > ROAD_HOLD.maxOmega) omega = ROAD_HOLD.maxOmega;
        else if (omega < -ROAD_HOLD.maxOmega) omega = -ROAD_HOLD.maxOmega;
        this._holdOmega = omega;

        // ── (1) FEED-FORWARD: what the curve costs ─────────────────────────
        let accel = 0;
        if (this._holdOmega > 0) {
          // What the curve demands of this corner, along −n.
          const demand = vt * this._holdOmega;
          // What is already being supplied along −n. Gravity contributes by how
          // far the surface is tilted; downforce acts along −chassis-up, and the
          // vehicle scales the total by grounded count, which distributes as a
          // fixed quarter-share per grounded corner — so this corner's share is
          // AERO.downforce·v²·0.25, i.e. this acceleration on a quarter mass.
          const supplied = GRAVITY * this.hitNormal.y
            + (AERO.downforce > 0
              ? (AERO.downforce * vt * vt / CHASSIS.mass) * Math.max(0, upDotN)
              : 0);
          // Leave `loadFloor` of the supply carrying the tyre rather than
          // turning the car, so the contact keeps load — and so the assist has
          // faded in before the unaided car would have gone weightless.
          accel = demand - (1 - ROAD_HOLD.loadFloor) * supplied;
          if (accel < 0) accel = 0;
        }

        // ── (2) FEEDBACK: what the car got wrong anyway ─────────────────────
        //
        // FEED-FORWARD ALONE IS NOT ENOUGH, and the reason is worth keeping.
        // It computes the force that would hold a car ALREADY tracking the
        // surface, and over a crest the car is not: it arrives at the brow with
        // the strut COMPRESSED by the concave shoulder before it (0.30 m on
        // Hill) and with the body moving upward from the climb. The spring then
        // unloads into exactly the moment the road turns away, and throws the
        // car off. Traced on Hill at 48 m/s, feed-forward only: the assist did
        // supply what the curve asked (7.5 g of an 8.4 g demand, the rest being
        // gravity) and the wheels still left, because nothing in it can correct
        // an error that already existed. Hill kept 0.46 s of air.
        //
        // So this term corrects the error rather than paying for the curve — a
        // critically damped servo on droop, which is precisely the mechanism
        // the FIRST version of road hold used as its ONLY term. It works here
        // and did not there because the feed-forward has already done the heavy
        // lifting: this is left with centimetres to correct instead of the whole
        // 8 g, so it runs at 8 rad/s instead of 30, never saturates, and the
        // force stays proportional to a real error instead of pinned at a cap.
        // That is the difference between a corrector and a magnet.
        //
        // Gated on droop because a strut past its rest length is the only state
        // where the wheel is measurably behind the road; on the way back in the
        // spring is doing the job itself and does not want help.
        const droop = -this.compression;
        if (droop > 0) {
          const rate = this._prevCompValid
            ? Math.max(-ROAD_HOLD.maxRate, Math.min(ROAD_HOLD.maxRate,
              -(this.compression - this._prevComp) / Math.max(1e-5, dt)))
            : 0;
          const w = ROAD_HOLD.correctRate;
          accel += w * w * Math.min(droop, ROAD_HOLD.maxGap) + 2 * w * rate;
        }

        if (accel > 0) {
          holdTarget = CHASSIS.mass * 0.25 * accel;
          const cap = ROAD_HOLD.maxG * CHASSIS.mass * GRAVITY * 0.25;
          if (holdTarget > cap) holdTarget = cap;
        }
      }
    } else {
      this._holdOmega = 0;
    }
    this._prevComp = this.compression;
    this._prevCompValid = this.grounded;
    // The curvature is already filtered, and the force is a continuous function
    // of it, so there is deliberately NO second easing on the result here — the
    // old version needed one because its trigger was a step.
    this.roadHoldForce = holdTarget;
    if (this.grounded) {
      // Seed the filter on the first substep of a contact so it starts ON the
      // surface rather than easing toward it from whatever it last saw.
      if (!this._holdNValid) this._holdNS.copy(this._rawNormal);
      this._holdNValid = true;
    }
    if (this.roadHoldForce > 1) {
      // Along the surface normal, not chassis-down: on a steep slope or a bank
      // those differ, and it is the surface the car is being held against.
      this._F.copy(this.hitNormal).multiplyScalar(-this.roadHoldForce);
      body.addForceAtPoint(this._F, this.worldPos);
    }

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
    //
    // THE LATERAL SLIP IS MEASURED IN THE CONTACT PLANE, NOT ALONG THE RAW
    // CHASSIS RIGHT AXIS. This is the same error the damper above had, on the
    // lateral axis: dotting the full 3-D wheel velocity into `_wheelRight` is
    // only the honest slip while the car is square to the road. Tilt it and the
    // INTO-SURFACE closing velocity — which on a landing is the dominant
    // component — leaks straight into the cornering demand.
    //
    // MEASURED at touchdown out of a barrel roll (tools/landingSlideTrace.mjs),
    // worst grounded wheel, raw vs the honest in-plane slip:
    //     tilt 31°   raw −1.50   in-plane −4.46   phantom +2.97
    //     tilt 38°   raw +1.82   in-plane −5.80   phantom +7.62
    // At 38° the phantom term does not merely distort the number, it OVERWHELMS
    // it and flips the sign — so the tyre was commanded to push the car INTO its
    // slide rather than arrest it. Over a dense sweep of roll-landing release
    // angles (tools/landingSlideSweep.mjs) fixing it halves the tail:
    //     worst 14.04 → 6.61 m,  90th pct 4.98 → 4.00 m,  mean 1.79 → 1.49 m
    //
    // LONGITUDINAL IS DELIBERATELY LEFT ON THE RAW AXIS, for the same reason the
    // lateral-align fade leaves it alone. Projecting it too broke parkPipeTest:
    // riding a pipe wall the chassis is never square to the surface, and the
    // into-surface component of the drive force was helping press the car onto
    // the wall. Removing it costs enough exit speed that the vert pops short.
    // Drive and braking are not a yaw lever and were not the bug — vLat was.
    this._planeVel.copy(this._tireVel)
      .addScaledVector(this.hitNormal, -this._tireVel.dot(this.hitNormal));
    this._planeRight.copy(this._wheelRight)
      .addScaledVector(this.hitNormal, -this._wheelRight.dot(this.hitNormal));
    // A projected axis collapses to nothing when that axis is parallel to the
    // normal — a car lying exactly on its side has no lateral direction in the
    // contact plane at all. There is no force to make there, and `latGrip` below
    // is already ~0, so fall back to the raw axis rather than normalizing noise
    // up to unit length.
    const rightLen = this._planeRight.length();
    if (rightLen > 1e-4) this._planeRight.multiplyScalar(1 / rightLen);
    else this._planeRight.copy(this._wheelRight);
    const vLat = this._planeVel.dot(this._planeRight);
    const vLong = this._tireVel.dot(this._wheelFwd);
    const vRef = Math.max(Math.abs(vLong), TIRE.lowSpeedRef);
    let latNorm = -(vLat / vRef) * TIRE.tireStiffness;
    if (latNorm > 1) latNorm = 1;
    else if (latNorm < -1) latNorm = -1;
    // No flat contact patch, no cornering force — see the LATERAL GRIP block on
    // TIRE. `_up` is the chassis up-axis and `hitNormal` the (filtered) surface
    // normal, so this is 1.0 for any wheel that is square to the road, which is
    // every wheel in normal driving, on banks, and inside loops.
    const align = this._up.dot(this.hitNormal);
    const span = TIRE.lateralAlignFull - TIRE.lateralAlignZero;
    const latGrip = span > 1e-6
      ? Math.min(1, Math.max(0, (align - TIRE.lateralAlignZero) / span))
      : 1;
    let Fy = latNorm * Fmax * latGrip;

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
    // HOW FAR PAST THE TYRE THE BRAKE ASKED — read-only, applies no force.
    //
    // There is no wheel angular velocity in this model, so there is no true slip
    // ratio and a wheel can never lock: an over-demand is simply clamped to Fmax,
    // which is ideal (ABS-like) braking. The information is still there in the
    // clamp though, and it is the honest measure of a tyre at its longitudinal
    // limit — so record it for the tyre marks and smoke, which until now could
    // only see LATERAL slip and therefore drew nothing at all under a 1.7 g stop.
    //
    // Derived rather than "is the brake pressed" on purpose: it falls out of the
    // real load, so weight transfer, downforce and a light rear all move it, and
    // it keeps tracking if brakeForce or grip is ever retuned.
    this.overDemand = Fmax > 1e-6
      ? THREE.MathUtils.clamp(Math.abs(Fx) / Fmax - 1, 0, 1)
      : 0;

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

    // TYRE forces act at the contact patch, not the hub — see the block on TIRE.
    // Down the suspension axis by the measured contact distance, so the point is
    // steady even while the winning ring ray flickers between samples.
    const patchK = TIRE.contactPatchForces;
    this._patch.copy(this.worldPos);
    if (patchK > 0) this._patch.addScaledVector(this._up, -distFromHub * patchK);

    // The LATERAL force acts along the in-plane axis its slip was measured on.
    // Applying it along the raw chassis axis instead would push a slice of every
    // cornering force straight into the surface — an artificial load the
    // suspension never asked for. Identity whenever the car is square to the
    // road. Longitudinal keeps the raw axis, see the slip block above.
    this._F.copy(this._planeRight).multiplyScalar(Fy);
    body.addForceAtPoint(this._F, this._patch);
    this.lastSteering.copy(this._F);

    this._F.copy(this._wheelFwd).multiplyScalar(Fx);
    body.addForceAtPoint(this._F, this._patch);
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
    /** @type {import("../../games/modular-road-v3/modularRoadParkour.js").ParkourMover[]} */
    this.dynamicMovers = [];
    /** @type {import("../../games/modular-road-v3/modularRoadParkour.js").ParkourMover[]} */
    this.deckCarryMovers = [];
    this.enabled = false;
    this.spawnPos = new THREE.Vector3(0, 0.7, -4);
    this.spawnQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);

    this.body = new RigidBody({ mass: CHASSIS.mass, size: CHASSIS });
    this.tires = WHEEL_LOCAL.map((w) => new Tire({ name: w.name, localPos: w.pos, steer: w.steer, drive: w.drive }));
    // `steer` is shaped for the TYRES (A/D / stick). `airSteer` is the ROLL
    // axis (Z/X, or the same stick when the caller omitted `rollTarget`). See
    // TIRE.airSteerRate.
    this.input = { steer: 0, airSteer: 0, throttle: 0, handbrake: false, yaw: 0, pitch: 0 };

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
    this._headlampMounts = null;

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
      // Permanently in the render list — see HEADLIGHTS. `visible` is what the
      // renderer reads to decide whether this light is part of the scene's light
      // set, and changing that set recompiles every shader in the world. Off is
      // intensity 0, and only intensity 0.
      light.visible = true;
      light.intensity = H.enabled ? H.intensity : 0;
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

  /**
   * Switch the beams. This is a UNIFORM WRITE and nothing else — no scene-graph
   * change, no material touched, so it costs the same whether it happens while
   * parked on an empty plate or at 200 km/h with the whole world on screen. See
   * HEADLIGHTS for what the `visible`-based version used to cost.
   */
  setHeadlights(on) {
    HEADLIGHTS.enabled = !!on;
    // Unconditional, with no early-out on "already in that state": HEADLIGHTS is
    // module-level and shared, so a fresh Vehicle can inherit `enabled` from a
    // previous one. The caller's setHeadlights(false) at boot has to actually
    // reach the rig, or the game and the beams disagree about what is lit.
    this._syncHeadlightSwitch();
  }

  /**
   * Push HEADLIGHTS.enabled onto the rig — beam intensity and lamp-face
   * visibility, deliberately nothing else. No colour parsing, no re-mounting:
   * those only change when a slider moves, and that goes through
   * applyHeadlightParams().
   */
  _syncHeadlightSwitch() {
    const H = HEADLIGHTS;
    const beam = H.enabled ? H.intensity : 0;
    for (const l of this.headlights) l.intensity = beam;
    // The GLB body carries its own lamp lenses (lit from _updateTaillights), so
    // the procedural faces stay hidden in that style — showing both puts two
    // sets of lamps inside one bonnet. This is the ONE place that decides it;
    // _applyChassisStyle used to set it and then have this overwrite the answer.
    const showLamps = H.enabled && this._chassisStyle !== "glb";
    for (const m of this.headlamps) m.visible = showLamps;
  }

  /**
   * Lamp mount points in CHASSIS-ANCHOR space, taken from the GLB's own
   * HEADLIGHT_LENS nodes. Ordered −X first, to match headlights[0].
   *
   * HEADLIGHTS.side/height/forward were measured against the PROCEDURAL BOX and
   * are wrong for the car by 23 cm inboard and 17 cm back — the beams appear to
   * come out of the bonnet rather than the lamps. Rather than hand-tuning three
   * more constants that would go stale the moment the model changes, the model
   * says where its own lamps are.
   *
   * Pass null to fall back to the constants (which is right for the box).
   */
  setHeadlampMounts(mounts) {
    this._headlampMounts = Array.isArray(mounts) && mounts.length >= 2
      ? [...mounts].sort((a, b) => a.x - b.x)
      : null;
    this.applyHeadlightParams();
  }

  /**
   * Re-sync the headlight rig after editing HEADLIGHTS params live (the Lights
   * panel sliders, or a chassis-style / mount change). This is the SLOW path —
   * it re-parses colours and re-places every mount. The on/off switch does NOT
   * come through here; see setHeadlights.
   */
  applyHeadlightParams() {
    const H = HEADLIGHTS;
    // Only the GLB has real lamps to sit in; the box gets the tuned constants.
    const mounts = this._chassisStyle === "glb" ? this._headlampMounts : null;
    for (let i = 0; i < this.headlights.length; i++) {
      const s = i === 0 ? -1 : 1;
      const l = this.headlights[i];
      l.color.set(H.color);
      l.distance = H.distance;
      l.angle = H.angle;
      l.penumbra = H.penumbra;
      l.decay = H.decay;
      const mx = mounts ? mounts[i].x : s * H.side;
      const my = mounts ? mounts[i].y : H.height;
      const mz = mounts ? mounts[i].z : H.forward;
      l.position.set(mx, my, mz);
      this.headlightTargets[i].position.set(mx, my - H.aimDrop, mz + H.aimForward);
    }
    for (let i = 0; i < this.headlamps.length; i++) {
      const s = i === 0 ? -1 : 1;
      const m = this.headlamps[i];
      m.material.color.set(H.color);
      m.material.emissive.set(H.color);
      m.material.emissiveIntensity = H.lampEmissive;
      m.position.set(s * H.side, H.height, H.forward + 0.02);
    }
    // Intensity and lamp visibility are owned by the switch, so that moving the
    // beam slider with the lights OFF stores the new value without lighting them.
    this._syncHeadlightSwitch();
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
    // The mounts only apply in glb style, so the beams have to be re-placed —
    // and this also re-runs the lamp-face visibility rule for the new style.
    this.applyHeadlightParams();
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
    /**
     * Deck/terrain contact points: the 8 CHASSIS_CORNERS plus the roof in-fill.
     * Rebuilt (and resized) by _refreshDeckContactPoints. The corners come FIRST
     * and share their Vector3 instances with CHASSIS_CORNERS, so there is one
     * copy of each point and nothing can drift out of sync.
     */
    this.DECK_CONTACT_POINTS = [];
    /** Surface samples on CHASSIS_HULL for the solids BVH. Rebuilt (and resized)
     *  by _refreshLocalFrames — the count follows the hull and its spacing. */
    this.SOLID_BOX_SAMPLES = [];
    /** Bounding sphere of those samples, in chassis-local space — the
     *  broad-phase for _resolveSolidBvh. Written by _refreshHullSamples. */
    this._hullCentreLocal = new THREE.Vector3();
    this._hullRadius = 0;
    this._hullCentreW = new THREE.Vector3();
    this._bpN = new THREE.Vector3();
    this._deepestN = new THREE.Vector3();
    this._cavityFrom = new THREE.Vector3();
    this._cavitySide = new THREE.Vector3();
    /** Contact point → body centre, for choosing which way out of a solid. */
    this._escapeRef = new THREE.Vector3();
    /** Chassis axes + lever for the crash trip-over — see the TRIP-OVER block
     *  on CRASH and step 5 of _applySolidContact. */
    this._tripUp = new THREE.Vector3();
    this._tripRight = new THREE.Vector3();
    this._tripFwd = new THREE.Vector3();
    this._tripLever = new THREE.Vector3();
    this._tripVel = new THREE.Vector3();
    /** Exact analytic colliders — see setSolidCapsules. */
    this.solidCapsules = [];
    this._sphC = new THREE.Vector3();
    this._sphN = new THREE.Vector3();
    // Capsule solver scratch — see _closestHullToSegment.
    this._capA = new THREE.Vector3();
    this._capB = new THREE.Vector3();
    this._capD = new THREE.Vector3();
    this._capP = new THREE.Vector3();
    this._capQ = new THREE.Vector3();
    this._capT = new THREE.Vector3();
    this._capN = new THREE.Vector3();
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
    /** Heading (rad) to hold through a jump — see the AIRBORNE HEADING HOLD
     *  block on TIRE. Null until the car has been on the ground once. */
    this._holdHeading = null;
    this._stabFwdH = new THREE.Vector3();
    this._holdQ = new THREE.Quaternion();
    this._airRight = new THREE.Vector3();
    /** Rotation the player is NOT commanding, damped as one vector so it can
     *  never leak onto another axis — see the settle block in _applyStabilizer. */
    this._freeOmega = new THREE.Vector3();
    this._freeTorque = new THREE.Vector3();
    this._airFwd = new THREE.Vector3();
    this._airHeading = new THREE.Vector3(); // horizontal projection of _airFwd
    this._airPitchAxis = new THREE.Vector3(); // horizontal pitch axis for the arc assist
    /** Player-commanded world-up spin rate. Q/E is a flat spin, so keeping this
     *  separate from rigid-body yaw prevents pitched launches from turning the
     *  input into roll and leaves no spin momentum at touchdown. */
    this._airYawRateState = 0;
    this._yawAxisHeld = false;
    this._yawN = new THREE.Vector3();
    this._yawFwd = new THREE.Vector3();
    this._yawLat = new THREE.Vector3();
    this._yawVel = new THREE.Vector3();
    this._solidN = new THREE.Vector3();
    this._solidT = new THREE.Vector3();
    this._solidPoint = new THREE.Vector3();
    this._solidApproachN = new THREE.Vector3();
    // Roof-down deck contact — see the ROOF block.
    this._roofTouch = false;
    this._roofImpactSpeed = 0;
    /** Countdown that keeps the suspension guard armed across substeps. */
    this._roofGuard = 0;
    /** Roof corners are resting on the TERRAIN heightfield this substep. */
    this._terrainLid = false;
    this._wasTerrainLid = false;
    this._terrainLidHold = 0;
    /** Seconds of crash yield remaining — see CRASH. */
    this._crashYield = 0;
    /** Yield was armed by a moving solid (pendulum, gate). Do not clear on
     *  "wheels down" — a wrecking ball hits you while you are still driving. */
    this._crashMover = false;
    this._solidFromMover = false;
    this._deckUp = new THREE.Vector3();
    this._deckRoofApproachN = new THREE.Vector3();
    this._roofT = new THREE.Vector3();
    this._stuckUp = new THREE.Vector3();
    this._stuckFwd = new THREE.Vector3();
    /** Seconds trapped against geometry while asking to move — see _updateStuck. */
    this._stuckTime = 0;
    this._stuckNudged = false;
    /** Countdown that stops our own nudge reading as an escape — see STUCK.nudgeHold. */
    this._stuckNudgeHold = 0;
    /** Countdown after a teleport — see STUCK.ignoreAfterTeleport. */
    this._stuckIgnore = 0;
    this._solidTouch = false;
    // Render-layer contact latch — see _updateScrapeLatch.
    this._scrapeHold = 0;
    this._scrapeSpeed = 0;
    this._scrapePoint = new THREE.Vector3();
    this._scrapeNormal = new THREE.Vector3(0, 1, 0);
    this._scrapeVel = new THREE.Vector3();
    this._solidR = new THREE.Vector3();
    this._solidTorque = new THREE.Vector3();
    this._solidSpinAxis = new THREE.Vector3();
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
    this._landRight = new THREE.Vector3(); // chassis right — the PITCH axis of the assist
    this._landFwd = new THREE.Vector3();   // chassis forward — the ROLL axis of the need gate
    this._landDir = new THREE.Vector3();
    /** Grounded wheel count last substep — drives the touchdown edge. */
    this._prevGrounded = 0;
    /** Was the car SUPPORTED last substep? This is what drives the touchdown
     *  edge — see _isSupported() for why probe contact is not good enough. */
    this._wasSupported = false;
    /** Has the tilt damping already fired for THIS landing? */
    this._landDamped = false;
    /** Seconds of probe contact WITHOUT wheel load. Resets the instant a wheel
     *  compresses, so it can only run up on a contact that never loads — see
     *  TIRE.landingSupportGrace. */
    this._contactAge = 0;
    /** Has the arrival edge already been consumed for THIS landing? Only the
     *  never-loads path needs the latch (support gives a natural edge). */
    this._landArrived = false;
    this._leanRight = new THREE.Vector3();
    this._leanFwd = new THREE.Vector3();
    this._leanQRoll = new THREE.Quaternion();
    this._leanQPitch = new THREE.Quaternion();
    /** Smoothed visual lean angles (rad). Cosmetic only. */
    this._leanRoll = 0;
    /** Body lift (m) currently paying for wheel-arch clearance — see
     *  TIRE.archLiftBody. Cosmetic only. */
    this._archLift = 0;
    // Scratch for the visual wheel-vs-solids clearance (_clearSolids).
    this._wsHub = new THREE.Vector3();
    this._wsCentre = new THREE.Vector3();
    this._wsUp = new THREE.Vector3();
    this._wsN = new THREE.Vector3();
    this._leanPitch = 0;
    this._deckN = new THREE.Vector3();
    this.BOTTOM_CORNERS = [0, 1, 4, 5];
    this._aeroF = new THREE.Vector3();
    this._aeroUp = new THREE.Vector3();
    this._sgN = new THREE.Vector3();
    this._sgDp = new THREE.Vector3();
    this._sgDn = new THREE.Vector3();
    this._sgVt = new THREE.Vector3();
    this._sgF = new THREE.Vector3();
    /** Eased magnitude of the concave-surface load (N). See SURFACE_GRIP.ease. */
    this._sgMag = 0;
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
    this._yawAxis = new THREE.Vector3(0, 1, 0); // Q/E spin axis, blended per attitude
    this._yawAxisHeld = false;                 // latched for the duration of a spin
    this._xAxis = new THREE.Vector3(1, 0, 0);
    this._zAxis = new THREE.Vector3(0, 0, 1);
    this._arrowDir = new THREE.Vector3();
    this._geomCenter = new THREE.Vector3();
    this._steerFwd = new THREE.Vector3();
    /** Seconds since the last wheel contact — gates air control (airGroundLockout). */
    this._airTime = 0;
    /**
     * Seconds since the car was last SUPPORTED by its tyres — gates the steering
     * rack's return to centre (airSteerCenterDelay).
     *
     * Separate from `_airTime` on purpose. `_airTime` resets on any probe
     * contact, which is correct for air CONTROL (a landing should stop taking
     * trick input) and wrong here, because the probe leads touchdown by ~0.12 s
     * and that was long enough for the rack to wind back up to half lock right
     * before the wheels arrived. See _isSupported().
     */
    this._rackAirTime = 0;
    /** When true, airborne steering centres the rack — roll still shares A/D / the stick. */
    this._centerSteerInAir = true;
    _syncComOffset();
  }

  /** Map a chassis-box-local point to world space (body.pos = CoM). */
  _geomToWorld(geomLocal, out) {
    const body = this.body;
    return out.copy(geomLocal).sub(_COM_OFFSET).applyQuaternion(body.quat).add(body.pos);
  }

  /** Inverse of _geomToWorld — world point into chassis-box-local space. */
  _worldToGeom(world, out) {
    const body = this.body;
    _invQuat.copy(body.quat).invert();
    return out.copy(world).sub(body.pos).applyQuaternion(_invQuat).add(_COM_OFFSET);
  }

  _refreshLocalFrames() {
    const hw = (this._hw = CHASSIS.width / 2);
    const hh = (this._hh = CHASSIS.height / 2);
    const hl = (this._hl = CHASSIS.length / 2);
    // FLOOR at −hh (the core box, untouched); ROOF at the real roofline. See
    // DECK_CONTACT for why these two are not the same box any more.
    const roofY = DECK_CONTACT.roofY;
    const c = this.CHASSIS_CORNERS;
    c[0].set(-hw, -hh, -hl); c[1].set(hw, -hh, -hl);
    c[2].set(-hw, roofY, -hl); c[3].set(hw, roofY, -hl);
    c[4].set(-hw, -hh, hl); c[5].set(hw, -hh, hl);
    c[6].set(-hw, roofY, hl); c[7].set(hw, roofY, hl);
    this.PROBE_LOCALS[0].pos.set(0, 0, hl);
    this.PROBE_LOCALS[1].pos.set(0, 0, -hl);
    this.PROBE_LOCALS[2].pos.set(hw, 0, 0);
    this.PROBE_LOCALS[3].pos.set(-hw, 0, 0);
    this._refreshDeckContactPoints(hw, hl, roofY);
    this._refreshHullSamples();
  }

  /**
   * Corners + roof in-fill, as one array for the deck resolver to walk.
   *
   * Only the ROOF gets extra points. The underside is already covered by four
   * wheels probing the surface directly, and adding mid-floor samples would put
   * new contact points over ramp crests and kerb lips — the exact geometry the
   * core box's size was tuned around. The roof has no wheels and no tuning
   * history, so it is the half that needs the density.
   */
  _refreshDeckContactPoints(hw, hl, roofY) {
    const pts = this.DECK_CONTACT_POINTS;
    pts.length = 0;
    // Shared instances, not copies — _refreshLocalFrames writes the corners
    // above and the deck resolver reads them here.
    for (const c of this.CHASSIS_CORNERS) pts.push(c);

    const s = DECK_CONTACT.roofSampleSpacing;
    if (!(s > 0)) return;
    const nx = Math.max(2, Math.ceil((hw * 2) / s) + 1);
    const nz = Math.max(2, Math.ceil((hl * 2) / s) + 1);
    for (let i = 0; i < nx; i++) {
      for (let k = 0; k < nz; k++) {
        // Skip the four corners — they are already in the list.
        const cornerX = i === 0 || i === nx - 1;
        const cornerZ = k === 0 || k === nz - 1;
        if (cornerX && cornerZ) continue;
        pts.push(new THREE.Vector3(
          -hw + (hw * 2 * i) / (nx - 1),
          roofY,
          -hl + (hl * 2 * k) / (nz - 1),
        ));
      }
    }
  }

  /**
   * Lay out the solid-hull surface samples on a REGULAR GRID at the hull's own
   * spacing, rather than the fixed 26 landmark points this used to be.
   *
   * The landmark layout tied sample density to the box's SIZE — a wider car got
   * a coarser collider — which is the wrong dependency and is what let a gate
   * post fit between the front-face samples. A grid decouples them: the hull can
   * grow to the real silhouette and the collider gets FINER, not coarser.
   *
   * Surface only. Interior points can never be the closest point on the hull to
   * anything outside it, so they cost queries and change nothing.
   */
  _refreshHullSamples() {
    const H = CHASSIS_HULL;
    const s = Math.max(0.05, H.sampleSpacing);
    const nx = Math.max(2, Math.ceil(H.width / s) + 1);
    const ny = Math.max(2, Math.ceil(H.height / s) + 1);
    const nz = Math.max(2, Math.ceil(H.length / s) + 1);
    const sb = this.SOLID_BOX_SAMPLES;
    let n = 0;
    const put = (x, y, z) => {
      if (!sb[n]) sb[n] = new THREE.Vector3();
      sb[n++].set(x, y + H.offsetY, z + H.offsetZ);
    };
    for (let i = 0; i < nx; i++) {
      const x = -H.width / 2 + (H.width * i) / (nx - 1);
      for (let j = 0; j < ny; j++) {
        const y = -H.height / 2 + (H.height * j) / (ny - 1);
        for (let k = 0; k < nz; k++) {
          const onSurface = i === 0 || i === nx - 1 || j === 0 || j === ny - 1
            || k === 0 || k === nz - 1;
          if (!onSurface) continue;
          put(x, y, -H.length / 2 + (H.length * k) / (nz - 1));
        }
      }
    }
    sb.length = n;
    // BROAD-PHASE BOUND for _resolveSolidBvh — the sphere that contains every
    // sample just laid out, about the hull's own centre. Derived here so it can
    // never disagree with the samples it bounds.
    this._hullCentreLocal.set(0, H.offsetY, H.offsetZ);
    this._hullRadius = 0.5 * Math.hypot(H.width, H.height, H.length);
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

  /**
   * Exact round colliders, resolved analytically instead of by sampling.
   *
   * WHY THIS EXISTS RATHER THAN "MORE SAMPLES". Sampling a triangle soup is a
   * general answer with a size floor: whatever the spacing, something thinner
   * slips through, and driving the spacing down is paid on every substep by
   * every sample. A gate post is not an unknown shape — it is a cylinder whose
   * radius and endpoints we already have — so it can be solved exactly, for a
   * constant handful of operations and with NO thinness limit at all. A 2 cm
   * bollard would register as reliably as a 2 m pillar.
   *
   * Capsules (round caps) rather than flat-capped cylinders: closest-point to a
   * segment is exact for a capsule, and on a vertical post the difference is a
   * rounded top nobody drives into.
   *
   * @param {Array<{a: THREE.Vector3, b: THREE.Vector3, radius: number}>} list
   *        World-space axis endpoints. Static — re-set them on a collision bake.
   */
  setSolidCapsules(list) {
    this.solidCapsules = list ? list.slice() : [];
  }

  /** Moving parkour solids — each mover rebakes its own BVH and pushes via surface velocity. */
  setDynamicMovers(movers) {
    this.dynamicMovers = movers ? movers.slice() : [];
  }

  /** Spinning deck movers that impart barrel-roll carry (see ParkourMover.deckCarry). */
  setDeckCarryMovers(movers) {
    this.deckCarryMovers = movers ? movers.slice() : [];
  }

  setSpawn(pos, quat) {
    this.spawnPos.copy(pos);
    if (quat) this.spawnQuat.copy(quat);
  }

  /**
   * Snap to a pose and drop all motion / contact / stuck state. Does NOT change
   * `spawnPos` — recover-from-stuck uses this so a later R still goes to the
   * race start rather than the last-safe pose.
   */
  respawnAt(pos, quat) {
    this.body.pos.copy(pos);
    this.body.vel.set(0, 0, 0);
    if (quat) this.body.quat.copy(quat);
    this.body.angVel.set(0, 0, 0);
    this._airTime = 0;
    this._airYawRateState = 0;
    this._yawAxisHeld = false;
    this._rackAirTime = 0;
    // Drop the contact-normal history — the first probe after a teleport must
    // snap to the new surface, not ease over from wherever the car just was.
    // Compression too: leftover spring load from a rail crush would fire on
    // the first tick at the new pose.
    for (const t of this.tires) t._clearContact();
    // Likewise the landing edge and the visual lean: a respawn is not a landing,
    // and the body should appear settled the instant it arrives.
    this._prevGrounded = 0;
    this._wasSupported = false;
    this._landDamped = false;
    this._contactAge = 0;
    this._landArrived = false;
    this._leanRoll = 0;
    this._leanPitch = 0;
    this._archLift = 0;
    this._scrapeHold = 0;
    this._scrapeSpeed = 0;
    this._clearStuck();
    this._crashYield = 0;
    this._crashMover = false;
    this._resetInterpolation();
    // Keep the render pose in step with the teleport (syncVisuals hasn't run yet).
    this._renderPos.copy(this.body.pos);
    this._renderQuat.copy(this.body.quat);
  }

  respawn() {
    this.respawnAt(this.spawnPos, this.spawnQuat);
  }

  _clearStuck() {
    this._stuckTime = 0;
    this._stuckNudged = false;
    this._stuckNudgeHold = 0;
    this._stuckIgnore = STUCK.ignoreAfterTeleport;
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
    this._crashYield = 0;
    this._crashMover = false;
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
   * @param {{steerTarget:number, rollTarget?:number, throttle:number, handbrake:boolean, yaw:number, analog?:boolean}} controls
   */
  tick(controls) {
    if (!this.enabled) return;
    this._prevPos.copy(this.body.pos);
    this._prevQuat.copy(this.body.quat);
    // Time since the car was actually SUPPORTED — see _rackAirTime. Computed
    // from last tick's tyre state, before _smoothSteer reads it.
    this._rackAirTime = this._isSupported() ? 0 : this._rackAirTime + FIXED_DT;
    const analog = !!controls.analog;
    const steerTarget = controls.steerTarget ?? 0;
    // Dedicated roll (Z/X) is passed as `rollTarget`, including 0. Callers that
    // omit it — the repro tools — still mean "steer keys are also the roll".
    const dedicatedRoll = "rollTarget" in controls;
    const rollTarget = dedicatedRoll ? (controls.rollTarget ?? 0) : steerTarget;
    // Centre the rack in the air only when roll still shares the steer axis:
    // analog stick (pad), or a legacy caller with no `rollTarget`. Keyboard
    // Z/X is independent, so A/D keeps aiming the tyres through a jump.
    this._centerSteerInAir = dedicatedRoll ? analog : true;
    this.input.steer = this._smoothSteer(steerTarget, analog);
    this.input.airSteer = this._smoothAirSteer(rollTarget, analog);
    this.input.throttle = controls.throttle ?? 0;
    this.input.handbrake = !!controls.handbrake;
    this.input.yaw = controls.yaw ?? 0;
    this.input.pitch = controls.pitch ?? 0; // air pitch — its own key, not throttle

    this._solidTouch = false; // set by _resolveSolidBvh during the step
    this._solidImpactSpeed = 0;
    this._solidFromMover = false;
    this._roofTouch = false;  // set by _applyDeckContact / terrain lid during the step
    this._roofImpactSpeed = 0;
    this._physicsStep(FIXED_DT);
    this._depenetrateFromWalls();
    this._updateStuck();
    this._updateScrapeLatch();
  }

  /**
   * Latch solid contact for the RENDER layer.
   *
   * `_solidTouch` is a per-TICK flag, and two things conspire to hide it from
   * anything sampling at frame rate:
   *
   *   • Physics runs at 120 Hz and rendering at 60, so a frame sees only the
   *     LAST of two ticks — contact on the first is invisible.
   *   • Solid response is PROJECTION-based: it pushes the car out, so the very
   *     next tick usually is NOT penetrating. A continuous scrape along a rail
   *     is therefore an on/off flicker at tick rate, not a steady signal.
   *
   * Together those made guardrail sparks fire on a small fraction of the ticks
   * where the car was actually rubbing. The latch holds the contact for
   * `SOLID.scrapeHold` so a flickering contact reads as the continuous scrape it
   * physically is — while still ending promptly once the car leaves the rail.
   *
   * Point and normal are snapshotted in `_applySolidContact`, not copied from
   * `_solidPoint` here. `_resolveSolidBvh` clears those scratch vectors at the
   * start of every pass, including a later substep or mover query that finds
   * nothing — so a scrape that pushes the hull out of the 8 cm skin in substep 1
   * used to latch (0,0,0) and the sparks spawned at the world origin. A thick
   * rail slab makes that clean separation the common case; the thin sheet often
   * stayed overlapping for both substeps and hid the bug.
   *
   * `_solidTouch` itself is deliberately left raw: the stuck detector wants the
   * instantaneous truth, not a smoothed one.
   */
  _updateScrapeLatch() {
    if (this._solidTouch) {
      this._scrapeHold = SOLID.scrapeHold;
      // TANGENTIAL speed — sliding ALONG the rail is what throws sparks, and a
      // head-on nudge (all velocity along the normal) should throw almost none.
      this._scrapeVel.copy(this.body.vel);
      this._scrapeVel.addScaledVector(this._scrapeNormal, -this._scrapeVel.dot(this._scrapeNormal));
      this._scrapeSpeed = Math.max(this._scrapeVel.length(), this._solidImpactSpeed);
    } else if (this._scrapeHold > 0) {
      this._scrapeHold -= FIXED_DT;
      if (this._scrapeHold <= 0) { this._scrapeHold = 0; this._scrapeSpeed = 0; }
    }
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
    if (!STUCK.enabled) {
      this._stuckTime = 0;
      this._stuckNudged = false;
      this._stuckNudgeHold = 0;
      return;
    }
    if (this._stuckIgnore > 0) {
      this._stuckIgnore -= FIXED_DT;
      this._stuckTime = 0;
      this._stuckNudged = false;
      this._stuckNudgeHold = 0;
      return;
    }
    // Fewer than 3 wheels down means the car is NOT properly on the road — it is
    // balanced on an edge or a rail. Measured: a car resting on a guardrail has
    // 2/4 (some wheels reach the kerb) and 0.5 m/s, so requiring exactly 0 missed
    // it entirely. Requiring <3 also correctly EXCLUDES a car sitting squarely on
    // the road pushing into a wall — that has 4/4, is not trapped, and just needs
    // to reverse.
    // CAN'T DRIVE: too few wheels on anything drivable, and not moving.
    //
    // THIS IS THE THIRD ATTEMPT, and the first two failed because they described
    // a trap that does not actually happen. MEASURED against the real rail
    // (tools/railTrapRepro.mjs) across seven landings:
    //
    //   scenario                grounded   0-wheel%   old condition fired
    //   crown, rolling in          2          2%            never
    //   straddling road+rail       2          2%            never
    //   dead on the crown          1          2%            never
    //
    // The car does NOT end up balanced on top of the rail with nothing under it.
    // It ends up HANGING OFF THE TRACK EDGE with one or two wheels still
    // catching the road while the chassis leans on the rail. So requiring
    // `groundedCount === 0` fired 2% of the time, and the older rule covered
    // 1–2 wheels but still demanded throttle — which nobody holds once they
    // realise they are stuck.
    //
    // Neither the throttle nor the solid contact is required now:
    //   • `< 3 wheels` already excludes a car parked squarely on the road
    //     pushing into a wall (that has 4/4 and can simply reverse out), which
    //     is the only thing the throttle check was protecting.
    //   • Contact is irrelevant — "dead on the crown" ends up touching NOTHING,
    //     dangling off the edge on one wheel, and is every bit as stuck.
    //
    // 3-D speed, so a car falling past the rail is never mistaken for a stopped
    // one, and a fast wall-ride (0 wheels, touching a solid) stays well clear.
    const trapped = this.isBeached;

    if (!trapped) {
      // OUR OWN NUDGE IS NOT AN ESCAPE. It throws the car upward on purpose, so
      // for the length of that hop it looks fast and airborne — i.e. exactly like
      // a car that got free. Draining the timer on it is what let a car bounce on
      // the same rail indefinitely: hop, timer decays to 0, `_stuckNudged`
      // re-arms, hop again, and the respawn escalation is never reached.
      // Landing on something drivable is the only thing that counts as free.
      if (this._stuckNudgeHold > 0 && this.groundedCount < 3) {
        this._stuckNudgeHold -= FIXED_DT;
        this._stuckTime += FIXED_DT;
        return;
      }
      this._stuckTime = Math.max(0, this._stuckTime - STUCK.releaseRate * FIXED_DT);
      if (this._stuckTime === 0) { this._stuckNudged = false; this._stuckNudgeHold = 0; }
      return;
    }
    this._stuckTime += FIXED_DT;
    if (!this._stuckNudged && this._stuckTime >= STUCK.nudgeAfter) {
      this._stuckNudged = true;
      this._stuckNudgeHold = STUCK.nudgeHold;
      // Up and along the car's own forward: lifts it off whatever it is balanced
      // on and gives it somewhere to go.
      this._stuckUp.set(0, 1, 0).applyQuaternion(this.body.quat);
      // NUDGE "UP" MEANS AGAINST GRAVITY, NOT ALONG THE CAR'S OWN UP AXIS.
      //
      // Chassis-up is right for the case this was written for — a car beached on
      // a guardrail is roughly level, and lifting along its own up tips it off.
      // Inverted, chassis-up points STRAIGHT DOWN, so the nudge fired the car
      // through the road it was lying on. Nothing saw it before because an
      // inverted car fell through the deck anyway; now that it rests there, this
      // is what a car on its lid actually hits. Identical for every upright case.
      if (this._stuckUp.y < 0) this._stuckUp.set(0, 1, 0);
      this._stuckFwd.set(0, 0, 1).applyQuaternion(this.body.quat);
      this.body.vel
        .addScaledVector(this._stuckUp, STUCK.nudgeUp)
        .addScaledVector(this._stuckFwd, Math.sign(this.input.throttle) * STUCK.nudgeForward);
    }
  }

  /** Seconds the car has been trapped against geometry while asking to move; 0
   *  whenever it is free. The game escalates past STUCK.respawnAfter. */
  get stuckTime() { return this._stuckTime; }

  /** Currently beached: too few driveable wheels and barely moving.
   *  Independent of the timer — roadGame must require BOTH this and
   *  stuckTime >= respawnAfter, or a stale timer after R recovers forever. */
  get isBeached() {
    if (this.body.vel.length() >= STUCK.beachedSpeed) return false;
    this._stuckUp.set(0, 1, 0).applyQuaternion(this.body.quat);
    // Roof-down on open ground is a rest, not a rail trap — see STUCK.
    if (this._stuckUp.y < ROOF.dot && !this._solidTouch) return false;
    if (this.groundedCount < 3) return true;
    // Perched on a solid lid while the tyres still see the road.
    return this._solidTouch && this._scrapeNormal.y > STUCK.sitUpMin;
  }

  /** Seconds of crash yield remaining. >0 means landing assists are quiet. */
  get crashYield() { return this._crashYield; }

  /** Did the chassis touch a solid (guardrail / wall) during the last tick?
   *  Drift scoring breaks a chain on contact — that risk is what makes holding
   *  a long chain worth anything. */
  get hitSolid() { return this._solidTouch; }
  /** World-space contact point of the last solid hit (guardrail, tunnel wall).
   *  Only meaningful while  is true. */
  get solidPoint() { return this._solidPoint; }

  /**
   * Is a ROAD SURFACE pressing on the car's roof this tick? Per-tick pulse, same
   * shape as `hitSolid` — so read it every tick and OR it across the frame, do
   * not sample it once at render rate (see the LATCHED block below for why).
   *
   * True for landing on the lid, sliding along inverted, and scraping a ceiling.
   * NOT true for a guardrail or a wall, however you hit them — those are solids
   * and `hitSolid` already covers them.
   */
  get roofTouch() { return this._roofTouch; }
  /** Speed the roof was closing on the surface at, m/s. ~0 while merely resting
   *  upside down; compare against ROOF.impactSpeed to tell a slam from a rest. */
  get roofImpactSpeed() { return this._roofImpactSpeed; }
  /** Landed on the lid HARD this tick, as opposed to lying on it. */
  get roofImpact() { return this._roofTouch && this._roofImpactSpeed >= ROOF.impactSpeed; }

  // ── LATCHED contact, for anything sampling at RENDER rate ───────────────────
  // Use THESE from visuals/audio, not the raw solid* above. The raw flag is a
  // per-tick pulse: physics runs at 120 Hz, rendering at 60, and projection
  // response clears the penetration immediately — so a continuous rail scrape is
  // an on/off flicker that a frame-rate sample mostly misses entirely.
  // See _updateScrapeLatch for the measurements.
  /** True while the car is rubbing a solid, held across the tick flicker. */
  get scraping() { return this._scrapeHold > 0; }
  get scrapePoint() { return this._scrapePoint; }
  get scrapeNormal() { return this._scrapeNormal; }
  /** Speed ALONG the surface — what actually throws sparks. */
  get scrapeSpeed() { return this._scrapeSpeed; }
  /** Outward surface normal at that contact. */
  get solidNormal() { return this._solidN; }
  /** Speed the chassis was closing on the surface at, m/s. Drives spark volume —
   *  a scrape and a slam must not look the same. */
  get solidImpactSpeed() { return this._solidImpactSpeed; }

  /**
   * Advance the steering input toward `target`, at a rate chosen by what the
   * player is actually doing — see the steerAttack/Release/Counter notes on TIRE.
   * `analog` bypasses the keyboard ramp entirely (a stick is already a position).
   */
  /**
   * Is the car actually being HELD UP by its tyres?
   *
   * NOT the same as `groundedCount > 0`. A tyre reports `grounded` as soon as
   * its probe finds a surface, and the probe is `rayLength` (1.0 m) plus a
   * 0.6 m pad — so on a descent it goes true while the wheel is still most of a
   * metre in the air, with `compression` NEGATIVE and the suspension carrying
   * nothing. MEASURED on a 35 m/s jump: two wheels read grounded 0.12 s before
   * touchdown, at 1.6 m altitude.
   *
   * That distinction is invisible almost everywhere, and it matters here: it is
   * what let the steering rack start winding up again on the way IN, undoing the
   * centring the whole flight had just done (rack 0.00 → 0.47 in that 0.12 s).
   * Positive compression is the honest test — the spring is pushing back.
   */
  _isSupported() {
    for (const t of this.tires) if (t.grounded && t.compression > 0) return true;
    return false;
  }

  _smoothSteer(target, analog) {
    const cur = this.input.steer;
    // AIRBORNE, PAST THE GRACE, AND ROLL STILL SHARES THIS AXIS: there is no
    // ground-steering intent for the rack to follow — anything it does here is
    // an input the player did not make. Return it to centre instead of tracking
    // `target`. Dedicated Z/X roll leaves `_centerSteerInAir` false, so A/D
    // keeps the tyres aimed for landing. See TIRE.airSteerCenterDelay.
    if (this._centerSteerInAir && this._rackAirTime > TIRE.airSteerCenterDelay) {
      return cur + (0 - cur) * (1 - Math.exp(-TIRE.airSteerCenterRate * FIXED_DT));
    }
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
   * The steering input shaped for the AIR ROLL axis — see TIRE.airSteerRate for
   * why this is not just `input.steer`.
   *
   * Deliberately ONE symmetric rate, unlike `_smoothSteer`'s three. That split
   * exists because winding a rack on, unwinding it, and catching a slide are
   * three different manoeuvres with three different urgencies. Rolling has no
   * such structure: there is no self-centring to unwind and nothing to catch, so
   * a roll left and a roll back right are the same input and want the same rate.
   *
   * Runs unconditionally (not only while airborne) so the value is already
   * settled the instant the wheels leave the ground — gating it would put a
   * fresh ramp at the start of every jump, which is precisely the lag being
   * removed.
   */
  _smoothAirSteer(target, analog) {
    // A stick is already a deflection, so it only wants the jitter filter — the
    // same reasoning as the analog branch of _smoothSteer.
    const rate = analog ? TIRE.steerAnalogRate : TIRE.airSteerRate;
    const cur = this.input.airSteer;
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
    // FORWARD ONLY. `slipAngle` is atan2(vel·left, vel·forward), so REVERSING
    // straight makes it ±π — a "slip angle" of 180°, which slammed the front
    // wheels to full visual lock and then flipped them side to side as the tiny
    // lateral component changed sign. That is the weird wheel judder when
    // backing up, and it is meaningless: a countersteer is a response to the
    // tail stepping out under power, which cannot happen in reverse.
    //
    // Faded rather than switched, so rolling to a stop and reversing does not
    // snap the wheels.
    this._steerFwd.set(0, 0, 1).applyQuaternion(this.body.quat);
    const fwdSpeed = this.body.vel.dot(this._steerFwd);
    const goingForward = THREE.MathUtils.clamp(fwdSpeed / 2, 0, 1);

    const contact = this.groundedCount * 0.25 * goingForward;
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

  /**
   * Per-wheel steer angle — see the ACKERMANN block on TIRE.
   *
   * `centre` is the bicycle-model angle from `_steerAngle()`; the turn radius it
   * implies is R = wheelbase / tan(centre), measured to the centreline. The
   * inside wheel runs at R − track/2 and the outside at R + track/2, so each
   * gets its own atan.
   *
   * WHICH WHEEL IS INSIDE is decided by sign, and the sign convention here is
   * the one already documented on the yaw assist: a POSITIVE rotation about the
   * chassis up-axis turns the nose toward +X, so a positive steer angle puts the
   * inside wheel on +X. (WHEEL_LOCAL's "R" labels are the opposite way round —
   * see the note on the air-roll axis — which is exactly why this keys off the
   * sign of `localX` rather than off the wheel's name.)
   *
   * @param {number} centre steer angle at the centreline (rad)
   * @param {number} localX wheel hub x in chassis-local metres
   */
  _wheelSteerAngle(centre, localX) {
    const k = TIRE.ackermann;
    if (k <= 0 || centre === 0 || localX === 0) return centre;
    const mag = Math.abs(centre);
    const R = WHEELBASE / Math.tan(mag);
    const halfTrack = Math.abs(localX);
    const inside = (centre > 0) === (localX > 0);
    // Clamped so a lock past the geometric limit (R <= track/2, i.e. the inside
    // wheel's circle collapsing onto the axle) cannot divide toward zero and
    // snap the wheel to 90°.
    const arm = inside ? Math.max(0.15, R - halfTrack) : R + halfTrack;
    const ideal = Math.atan(WHEELBASE / arm);
    return Math.sign(centre) * (mag + (ideal - mag) * k);
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
      // Armed by _applyDeckContact, which runs LATER in this same substep — so
      // the tyres always read the previous substep's answer (1/240 s stale).
      // That lag is why the flag is a hold rather than a per-substep boolean.
      const roofPinned = this._roofGuard > 0;
      if (this._roofGuard > 0) this._roofGuard = Math.max(0, this._roofGuard - subDt);
      for (const tire of this.tires) {
        tire.roofPinned = roofPinned;
        const driveScale = tire.isFront ? fScale : rScale;
        // Ackermann: the inside wheel turns further than the outside one. Only
        // the steered axle differs; Tire.apply ignores the angle on a wheel that
        // cannot steer, so passing the centre angle there is harmless.
        tire.apply(
          body,
          subDt,
          tire.canSteer ? this._wheelSteerAngle(steerAngle, tire.localPos.x) : steerAngle,
          this.input.throttle,
          this.input.handbrake,
          this._castGround,
          this._castSphereSweep,
          driveScale,
        );
      }
      if (this.deckCarryMovers.length) this._applyDeckCarry(subDt);
      if (this.walls.length) this._applyWallProbes();
      // Gated on SOLID.enabled only — _resolveSolids picks its own channels. It
      // used to require a baked solidsBvh here, which silently disabled the
      // capsule colliders and the movers on any track with no static solids.
      if (SOLID.enabled) this._resolveSolids(subDt);
      if (DECK.enabled && this.groundBvh && this.groundBvh.baked) this._applyDeckContact(subDt);
      this._applyChassisGroundContact(subDt);
      this._armCrashYield(subDt);
      // After the tires (their contact normals are what both of these read) and
      // before integrate(), so the torques land in this substep.
      //
      // Surface grip reads the same contact normals — it measures the curvature
      // they fan out over — so it belongs here too, not up with _applyAero: run
      // before the tyres and it would be working off last substep's contacts.
      this._applySurfaceGrip(subDt);
      this._applyYawAssist();
      this._applyLandingAssist(subDt);
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
    // A crash is the one time the car is MEANT to be pointing the wrong way.
    // This drives the nose back onto the velocity vector, which is precisely
    // the spin a wall just gave you, so it has to stand down or the car snaps
    // straight mid-crash and the hit reads as a bump.
    if (this._crashYield > 0) return;

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
   * Arm / decay crash yield. Must run AFTER solids + roof contacts (they write
   * the impact speeds) and BEFORE landing assist / stabilizer (they read it).
   */
  _armCrashYield(dt = FIXED_DT / this.SUBSTEPS) {
    if (!CRASH.enabled) {
      this._crashYield = 0;
      this._crashMover = false;
      return;
    }
    this._stuckUp.set(0, 1, 0).applyQuaternion(this.body.quat);
    const inverted = this._stuckUp.y < ROOF.dot;
    const recovered = this.groundedCount >= CRASH.recoverWheels
      && this._stuckUp.y > CRASH.recoverUp;
    if (this._solidFromMover && this._solidImpactSpeed >= CRASH.moverSpeed) {
      this._crashYield = CRASH.hold;
      this._crashMover = true;
    } else if (
      this._solidImpactSpeed >= CRASH.wallSpeed
      || (inverted && this._roofImpactSpeed >= CRASH.roofSpeed)
    ) {
      this._crashYield = CRASH.hold;
    }
    // A wrecking-ball can hit you with all four wheels still on the road.
    // Do not treat that as "recovered". Static-wall yield still clears the
    // moment you are driving again so a barrier clip does not mute assists —
    // but NOT before `minHold`, or it clears on the substep that armed it and
    // there is no crash at all. See CRASH.minHold.
    if (
      this._crashYield > 0 && recovered && !this._crashMover
      && this._crashYield <= CRASH.hold - CRASH.minHold
    ) {
      this._crashYield = 0;
      return;
    }
    if (this._crashYield > 0) {
      this._crashYield = Math.max(0, this._crashYield - dt);
    }
    if (this._crashYield <= 0) this._crashMover = false;
  }

  /**
   * Landing help — touchdown absorption, and predictive alignment while falling.
   * See the LANDINGS block on TIRE for what each half is for.
   */
  _applyLandingAssist(dt = FIXED_DT / this.SUBSTEPS) {
    const body = this.body;
    // On the lid on dirt: the tyres are deliberately not contacting, so this
    // would look "airborne" and try to roll the car wheels-down. Leave it.
    // The hold covers a one-substep bounce off the corner springs. Upright
    // jumps still get the assist — they never set `_terrainLid`.
    if (this._terrainLid || this._terrainLidHold > 0) return;
    // A real crash: do not un-flip or magnet-absorb. Crooked jumps never arm
    // this — see _armCrashYield.
    if (this._crashYield > 0) return;
    let grounded = 0;
    this._landN.set(0, 0, 0);
    for (const t of this.tires) {
      if (!t.grounded) continue;
      grounded++;
      this._landN.add(t.hitNormal);
    }

    if (grounded > 0) {
      // ── Touchdown: fires on ARRIVAL, which means WHEEL LOAD ──
      //
      // NOT on `grounded > 0`. A tyre reports grounded the moment its probe RAY
      // finds a surface, which on a descent is 58–92 ms and 1–4 m before the
      // wheel actually touches (see _isSupported). Both halves below used to
      // fire on that early edge and then latch, so by the time the car really
      // arrived they had already been spent, up in free flight:
      //   • ABSORPTION deleted 8.5–13 m/s of fall speed about a metre up, and
      //     the car glided down the remainder at half rate. That is the
      //     "magnet" — measured in tools/landingAbsorbTiming.mjs.
      //   • TILT DAMPING was documented as fixed by moving to the support edge,
      //     and was not: its `hardArrival` escape hatch tested closing speed at
      //     FIRST CONTACT, which every hard landing passes, so the early edge
      //     won on exactly the landings that mattered.
      //
      // So both now wait for `_isSupported()` — a wheel actually carrying load.
      //
      // THE ONE ARRIVAL THAT NEVER LOADS A WHEEL is a guardrail landing: rails
      // live in the SOLIDS bvh and the wheels only probe the DECK, so the tyres
      // find nothing to compress and support never comes. Gating naively on
      // support cost exactly that case (measured: the rail landing arrived at
      // full speed, bounced, and fell to y = −39). Rather than reintroduce the
      // early edge for everyone, that case is detected for what it IS — probe
      // contact that has persisted without ever producing load — and conceded to
      // after `landingSupportGrace`. A real landing loads inside 92 ms and never
      // reaches it.
      this._prevGrounded = grounded;
      const supported = this._isSupported();
      const justSupported = supported && !this._wasSupported;
      this._wasSupported = supported;
      // Age the contact only while it is NOT producing load; a normal landing
      // resets to 0 the instant a wheel compresses, so the grace can only ever
      // expire on a contact that is going nowhere.
      this._contactAge = supported ? 0 : this._contactAge + dt;
      // NORMALIZE BEFORE THE CLOSING TEST BELOW READS IT. `_landN` is the SUM of
      // up to four unit normals, so an un-normalized dot would report up to four
      // times the real closing speed and blow straight through landingMinSpeed.
      if (this._landN.lengthSq() < 1e-8) return;
      this._landN.normalize();
      // The wheels are never going to take load here.
      //
      // CLOSING SPEED IS PART OF THE TEST, not just a gate on the absorption
      // below. Persistent probe contact without load is not unique to a rail
      // landing: crest a rise and the wheels can hang light for longer than the
      // grace while the deck is still inside their probe range. That is not an
      // arrival and must not fire the tilt damping — the car would visibly
      // stiffen mid-crest. A rail landing is distinguished by being an IMPACT,
      // so it is asked to look like one. Gentle arrivals on the deck are
      // unaffected: they produce load, so they take the justSupported path,
      // which deliberately has no speed gate at all.
      const neverLoads = !supported
        && this._contactAge >= TIRE.landingSupportGrace
        && !this._landArrived
        && body.vel.dot(this._landN) < -TIRE.landingMinSpeed;
      const arrived = justSupported || neverLoads;
      if (!arrived) return;
      this._landArrived = true;

      // (a) KILL THE TILT RATE. Unconditional, and that is the fix: this used to
      // sit BEHIND the closing-speed gate below, so a car that arrived gently
      // got no roll damping at all. Every long jump arrives gently — the arc and
      // landing assists spend the descent bleeding the closing speed down, and
      // it measured −1.95 m/s against a −6.00 m/s gate. So the one mechanism
      // meant to stop a car landing mid-roll was switched off in exactly the
      // case it exists for: a 360° roll that touches down still rotating at
      // 8 rad/s, whose contact patches then sweep sideways and shove the car
      // across the road. That is the "sometimes it throws me sideways" bug —
      // sometimes, because it depends on where in the roll you happen to land.
      //
      // Tilt rate only. Stripping yaw out keeps a landing mid-flat-spin spinning.
      // ONCE PER LANDING, on the arrival edge resolved above — which is wheel
      // load for a normal landing and the expired grace for a rail one.
      if (!this._landDamped && TIRE.landingAngDamp > 0) {
        this._landDamped = true;
        this._landUp.set(0, 1, 0).applyQuaternion(body.quat);
        const wYaw = body.angVel.dot(this._landUp);
        this._landTilt.copy(body.angVel).addScaledVector(this._landUp, -wYaw);
        body.angVel.addScaledVector(this._landTilt, -TIRE.landingAngDamp);
      }

      // (b) ABSORB THE IMPACT. This half IS about how hard you hit, so it keeps
      // the speed gate: ordinary driving over kerbs must not be touched.
      if (TIRE.landingAbsorb > 0) {
        const vN = body.vel.dot(this._landN); // negative = still closing
        if (vN < -TIRE.landingMinSpeed) {
          body.vel.addScaledVector(this._landN, -vN * TIRE.landingAbsorb);
        }
      }
      return;
    }

    this._prevGrounded = 0;
    this._wasSupported = false;
    this._landDamped = false;
    this._contactAge = 0;
    this._landArrived = false;
    // Published for the air control: how strongly this assist owns the attitude
    // right now. The arc-follow fades out against it, so the nose tracks the
    // flight path in mid-air and then LEVELS to the surface for touchdown.
    this._landEngage = 0;
    if (TIRE.airLandAssist <= 0 || TIRE.airLandTorque <= 0) return;

    // ── Airborne: align to whatever we're about to land on ──
    // Probe along the flight path when genuinely descending, else straight down.
    // A mostly-horizontal probe would find a wall rather than the landing.
    this._landDir.copy(body.vel);
    if (this._landDir.y > -1 || this._landDir.lengthSq() < 1e-6) this._landDir.set(0, -1, 0);
    else this._landDir.normalize();

    const hit = this._castGround(body.pos, this._landDir, TIRE.airLandRange);
    if (!hit) return;
    // ENGAGE ON TIME-TO-IMPACT, NOT DISTANCE.
    //
    // The probe runs along the FLIGHT PATH, so on a fast shallow jump it is
    // mostly horizontal and its length is far greater than the height — a car
    // 0.6 m off the deck at 30 m/s still reads several metres of slant range.
    // MEASURED: engage peaked at 0.53 right up to touchdown, so the assist was
    // running at half strength exactly when it was needed most, and never took
    // over the attitude at all.
    //
    // Seconds-to-impact is speed-invariant and is what actually decides whether
    // there is time to level the car.
    // TIME-TO-IMPACT MUST BE BALLISTIC, NOT dist/speed.
    //
    // The old form divided the PROBE's slant range by the full 3-D speed, and
    // when the car is climbing the probe points straight DOWN (see above) — so
    // it divided the current HEIGHT by the current SPEED, which is not a time to
    // anything. Off a ramp lying on the ground that reads a fraction of a second
    // while the car is still travelling UPWARD at 8 m/s:
    //     t=0.15  y=1.56  vy=+6.2  engage 0.94   <- full assist on the way up
    //     t=0.85  y=3.45  vy=−0.7  engage 0.86
    // i.e. the assist ran at ~90% for the entire jump, and 32000 N·m of
    // levelling against a 13600 N·m roll ceiling meant the roll simply never
    // happened: 39° reached against 180° with the assist disabled.
    //
    // The car is a projectile, so the honest answer is closed form. Solving
    // drop = −vy·t + ½g·t² for the positive root is speed-invariant, correctly
    // counts the time still to be spent CLIMBING, and needs no probe geometry.
    const hitY = hit.point ? hit.point.y : body.pos.y - (hit.distance ?? 0);
    const drop = body.pos.y - hitY;
    if (drop <= 0) return; // probe found something at or above us — not a landing
    const vy = body.vel.y;
    const tti = (vy + Math.sqrt(Math.max(0, vy * vy + 2 * GRAVITY * drop))) / GRAVITY;
    let engage = 1 - Math.min(1, tti / Math.max(0.05, TIRE.airLandTime));
    if (engage <= 0) return;
    // YIELD TO A HELD ROLL — see airLandInputYield.
    // YIELD DURING THE FLIGHT, RE-ASSERT AT THE GROUND.
    //
    // This used to be a flat `engage *= 1 - yield·|input|`, so holding A/D — which
    // is what a 360° roll IS — multiplied the assist by ZERO for the whole
    // descent. MEASURED off a ramp with the roll held (tools/rollLandingYaw.mjs
    // and the ramp repro): peak engage 0.00 on every jump. The one mechanism that
    // levels the car before touchdown never ran, on exactly the manoeuvre that
    // needs it most, which is why "it only happens when I do a 360".
    //
    // What that costs: the car arrives at whatever attitude the roll left it, and
    // a tilted arrival is violent. The tyres take load unevenly, and a lateral
    // force at a wheel acts 1.4 m fore/aft of the CoM, so it is a YAW LEVER —
    // measured 81.7 kN·m against a 1890 kg·m² yaw inertia, i.e. 43 rad/s², which
    // snapped the heading 11.7° in a fraction of a second. That is the "it turns
    // by itself, very abruptly".
    //
    // The yield is still right EARLY: the assist is 32000 N·m against the roll
    // model's 13600 N·m ceiling, so without it a deliberate roll would simply be
    // overpowered. So scale the yield by the time left instead of applying it
    // flat — full suppression while there is still flight to enjoy, handing back
    // as the ground arrives. With the input held this works out to engage², i.e.
    // the same ramp deferred, still reaching full authority at touchdown.
    const rollInput = Math.min(1, Math.abs(this.input.airSteer));
    const landingReassert = body.vel.y < 0 ? engage : 0;
    engage *= 1 - TIRE.airLandInputYield * rollInput * (1 - landingReassert);
    if (engage <= 1e-3) return;

    if (hit.normal) this._landN.set(hit.normal.x, hit.normal.y, hit.normal.z);
    else if (hit.face?.normal) this._landN.copy(hit.face.normal);
    else this._landN.set(0, 1, 0);
    if (this._landN.lengthSq() < 1e-8) return;
    this._landN.normalize();
    // Triangles can be wound either way — face the normal back toward us.
    if (this._landN.dot(this._landDir) > 0) this._landN.negate();

    this._landUp.set(0, 1, 0).applyQuaternion(body.quat);
    // UNSCALED tilt axis first: cross(up, N) has magnitude sin(tilt) and lies in
    // the chassis' right/forward plane, so its components ARE the pitch and roll
    // errors the need gate reads. The torque scale goes on after the gate.
    this._landTorque.crossVectors(this._landUp, this._landN);

    // ── NEED GATE — see the airLandErrDead block on TIRE. Silent on a landing
    // that was already going to be fine; full authority on one that was not.
    // `_landFwd` is the chassis forward axis, i.e. the ROLL axis. Its own scratch
    // rather than reusing `_landDir`: that one still holds the probe direction
    // the normal was oriented against three lines up, and a later edit moving
    // either use would break the other silently.
    this._landFwd.set(0, 0, 1).applyQuaternion(body.quat);
    this._landRight.set(1, 0, 0).applyQuaternion(body.quat);
    const keepPitch = THREE.MathUtils.clamp(TIRE.airLandPitchLevel, 0, 1);
    // MEASURE THE ERROR WITH atan2, NOT asin. |cross(up, N)| is sin(tilt), which
    // FOLDS BACK past 90° — an inverted car reads sin(180°) = 0, i.e. "perfectly
    // aligned", and the assist would switch off exactly where it is needed most.
    // MEASURED with the asin form (tools/landingSlideRepro.mjs), lateral slide on
    // a 160° roll landing: 7.54 m against 6.12 m before the gate existed. Pairing
    // the sine component with cos(tilt) = up·N makes the angle monotonic all the
    // way to 180°, so deep rolls read as the emergency they are.
    //
    // Pitch counts only for the fraction the assist would act on — at the default
    // airLandPitchLevel 0 this is roll-only, so the arc assist's deliberate
    // nose-down approach must never arm it.
    const cosTilt = this._landUp.dot(this._landN);
    const errRoll = Math.abs(Math.atan2(this._landTorque.dot(this._landFwd), cosTilt));
    const errPitch = Math.abs(Math.atan2(this._landTorque.dot(this._landRight), cosTilt));
    const errAngle = Math.max(errRoll, errPitch * keepPitch);
    const rollRate = Math.abs(body.angVel.dot(this._landFwd));
    const need = Math.max(
      THREE.MathUtils.smoothstep(errAngle, TIRE.airLandErrDead, TIRE.airLandErrFull),
      THREE.MathUtils.smoothstep(rollRate, TIRE.airLandRateDead, TIRE.airLandRateFull),
    );
    if (need <= 1e-3) return;
    engage *= need;
    this._landEngage = engage;

    this._landTorque.multiplyScalar(TIRE.airLandTorque * engage * TIRE.airLandAssist);
    const wYaw = body.angVel.dot(this._landUp);
    this._landTilt.copy(body.angVel).addScaledVector(this._landUp, -wYaw);

    // SPLIT ROLL FROM PITCH — see airLandPitchLevel. cross(up, N) is by
    // construction perpendicular to the chassis up-axis, so it lies exactly in
    // the chassis' right/forward plane: its RIGHT component pitches the car and
    // its FORWARD component rolls it, with no yaw term to worry about. Scaling
    // the right component down therefore levels the car side-to-side (which is
    // what saves the landing) while leaving the nose wherever the arc assist put
    // it (which is what makes the landing look right).
    if (keepPitch < 1) {
      const pitchTq = this._landTorque.dot(this._landRight);
      this._landTorque.addScaledVector(this._landRight, -pitchTq * (1 - keepPitch));
      // The damping is split the same way, or it would bleed off the arc
      // assist's pitch RATE and flatten the nose by the back door.
      const pitchRate = this._landTilt.dot(this._landRight);
      this._landTilt.addScaledVector(this._landRight, -pitchRate * (1 - keepPitch));
    }
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
      // Q/E is a rate control, not a flywheel. Its kinematic rate stops when a
      // wheel finds the landing, so the tyres never inherit stale spin momentum.
      this._airYawRateState = 0;
      this._yawAxisHeld = false;
    this._yawAxisHeld = false;
      // The heading to keep through the next jump. Recorded continuously while
      // grounded, so it is whatever you were pointing at when you left the ramp.
      this._stabFwdH.set(0, 0, 1).applyQuaternion(body.quat);
      if (
        this._isSupported()
        && Math.hypot(this._stabFwdH.x, this._stabFwdH.z) >= TIRE.airHeadingMinLevel
      ) {
        this._holdHeading = Math.atan2(this._stabFwdH.x, this._stabFwdH.z);
      }
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
      if (align > 0 && this._crashYield <= 0) {
        this._stabCross.crossVectors(this._stabUp, this._stabN);
        this._stabTorque.addScaledVector(this._stabCross, TIRE.stabilizerStrength * align);
      }
      // Roll/pitch damping stays on at ANY contact count — it only removes
      // energy, and it's what stops a one-wheel touch starting a tumble.
      //
      // WHICH IS EXACTLY WHY A CRASH HAS TO TURN IT DOWN. During a crash the
      // tumble is the point, and 2600 of damping bleeds it off before it can
      // commit — the alignment torque above is already gone by then, so this
      // was the remaining assist quietly keeping the car flat. Scaled rather
      // than switched off: a little damping keeps the roll readable instead of
      // letting it spin up into noise.
      const damp = this._crashYield > 0
        ? TIRE.stabilizerDamp * CRASH.dampScale
        : TIRE.stabilizerDamp;
      const wYaw = body.angVel.dot(this._stabUp);
      this._stabWTilt.copy(body.angVel).addScaledVector(this._stabUp, -wYaw);
      this._stabTorque.addScaledVector(this._stabWTilt, -damp);
      body.torqueAccum.add(this._stabTorque);
    } else {
      // On the dirt-lid: no tyre contact, so this branch would treat a rest as
      // a trick and the arc assist would pitch the car off its roof.
      if (this._terrainLid || this._terrainLidHold > 0) return;
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
      // Roll used to share A/D with the tyres, which stole landing steer on
      // every small jump. It is on Z/X now. `input.airSteer` is that channel,
      // not `steer`.
      //
      // `input.pitch` is +1 for NOSE UP. A positive rotation about the chassis'
      // +X axis pitches the nose DOWN (+X is the chassis' left; rotating +Z
      // about it takes the nose toward −Y), hence the negation.
      const inP = armed ? -this.input.pitch : 0;
      // ROLL IS NEGATED — press RIGHT, roll RIGHT (right side down, which is
      // CLOCKWISE seen from the chase camera). Un-negated it did the opposite,
      // which is what every flight sim and stunt racer trained the player NOT to
      // expect. Verified against a real chase camera rather than by reasoning
      // about handedness, because the sign here is genuinely easy to get wrong:
      // WHEEL_LOCAL labels the +X wheels "R", but +X is SCREEN-LEFT for a camera
      // sitting behind a car that faces +Z. Ground steering was already correct;
      // only this axis was inverted.
      // `airSteer`, NOT `steer` — the latter is shaped for the steering rack and
      // was silently costing this axis ~180 ms of lag. See TIRE.airSteerRate.
      const inR = armed ? -this.input.airSteer : 0;
      const inY = this.input.yaw; // Q/E is deliberate stunt input — never gated

      // Diagonal inertia in body-local axes (x pitch, y yaw, z roll).
      const li = body.localInvInertia.elements;
      const Ip = 1 / (li[0] || 1e-6);
      const Iy = 1 / (li[4] || 1e-6);
      const Ir = 1 / (li[8] || 1e-6);

      // Idle-axis convergence. `airSettle` is what stops a car spinning forever
      // after a knock — and during a CRASH it is the thing erasing the crash. A
      // tumble that leaves the ground is the whole point of a rollover, and this
      // drives every rate it did not ask for back to zero, so a car tripped into
      // the air came down flat. See CRASH.airSettleScale.
      const settle = this._crashYield > 0
        ? TIRE.airSettle * CRASH.airSettleScale
        : TIRE.airSettle;
      const axis = (unit, input, rate, inertia) => {
        const cur = body.angVel.dot(unit);
        const target = input * rate;
        // Softer convergence when the axis is idle, so a knock still tumbles
        // naturally rather than freezing the moment you release.
        const gain = input !== 0 ? TIRE.airResponse : settle;
        this._stabTorque.addScaledVector(unit, (target - cur) * gain * inertia);
      };

      this._stabTorque.set(0, 0, 0);

      // PITCH is written out rather than going through axis(), because when the
      // player is NOT pitching it does not settle toward zero — it settles
      // toward the trajectory (see the "NOSE FOLLOWS THE ARC" block in TIRE).
      let aligning = false; // true when the arc assist is driving pitch, not the player
      let pitchTarget = inP * TIRE.airPitchRate;
      // Pitch uses its OWN response — see airPitchResponse.
      let pitchGain = inP !== 0 ? TIRE.airPitchResponse : settle;
      if (inP === 0 && TIRE.airTrajectoryAlign > 0) {
        const v = body.vel;
        const horiz = Math.hypot(v.x, v.z);
        const curPitch = body.angVel.dot(this._airRight);
        if (
          Math.hypot(horiz, v.y) >= TIRE.airAlignMinSpeed
          && this._stabUp.y > TIRE.airAlignMinUp          // upright-ish only
          && Math.abs(curPitch) < TIRE.airAlignMaxSpin    // never fight a flip
          // …and never fight a ROLL. `airAlignMinUp` is an attitude test, and a
          // rolling car passes back through upright twice a rotation, so without
          // this the gate flickers open mid-barrel-roll. See airAlignMaxRoll.
          && Math.abs(body.angVel.dot(this._airFwd)) < TIRE.airAlignMaxRoll
        ) {
          // FOLLOW A FRACTION OF THE ARC, NOT ALL OF IT.
          //
          // Matching the trajectory exactly is geometrically "correct" and lands
          // badly: measured, the car arrived 16° nose-down and see-sawed onto its
          // front wheels 150 ms before the rear. Trying to level that back out
          // with the landing assist is a losing fight — even at 10× torque and a
          // longer window it only reached −6.3°, and flattened the in-flight look
          // to −9.8° in the process, i.e. it damaged the thing the assist exists
          // for.
          //
          // Real cars do not rotate to match their flight path either; they pitch
          // a little and land near-flat. Half the arc reads clearly nose-down
          // without turning touchdown into a slam.
          const traj = Math.atan2(v.y, horiz) * TIRE.airAlignFraction;
          const nose = Math.atan2(
            this._airFwd.y, Math.hypot(this._airFwd.x, this._airFwd.z),
          );
          // FEED THE ARC'S OWN ROTATION FORWARD. The target is not a fixed angle
          // — it sweeps downward the whole flight — so a proportional term alone
          // trails it by (target rate / gain) forever. Measured: the nose peaked
          // at 5.7° when the trajectory was already at 1.2°, and the error grew
          // to 8.7° by touchdown, i.e. WORSE than the flat car it replaced.
          //
          // For ballistic motion that rate is closed-form: differentiating
          // atan2(vy, vh) with vy' = −g and vh' = 0 gives −g·vh / |v|². Adding it
          // means the proportional term only has to correct the residual.
          const v2 = horiz * horiz + v.y * v.y;
          const trajRate = (v2 > 1e-6 ? -GRAVITY * horiz / v2 : 0) * TIRE.airAlignFraction;
          // err > 0 means the nose is BELOW the arc and must come up; a positive
          // rotation about _airRight pitches DOWN, hence the negation.
          let rate = -(trajRate + (traj - nose) * TIRE.airTrajectoryAlign);
          const cap = TIRE.airAlignMaxRate;
          if (rate > cap) rate = cap; else if (rate < -cap) rate = -cap;
          // HAND OVER TO THE LANDING ASSIST. Following the arc means pitching the
          // nose DOWN for the whole descent, and holding that to touchdown is why
          // the car see-sawed onto its front wheels: MEASURED at −17.5° nose-down
          // at front-wheel contact with the rear arriving 158 ms later, against
          // 0.0° and 0 ms with the assist off. Fading out over the landing
          // assist's own engage ramp keeps the arc look in mid-flight and lets
          // the car LEVEL for the landing, which is the half that has to feel
          // good rather than look good.
          // HAND OVER ONLY AS FAR AS THE LANDING ASSIST ACTUALLY TAKES OVER.
          // This used to fade to zero over the assist's engage ramp, back when
          // the assist levelled pitch as well as roll — handing the axis to
          // something else and then also switching yourself off is correct. It
          // no longer levels pitch by default (airLandPitchLevel 0), so fading
          // out would leave NOBODY driving the nose for the last half-second and
          // the car would coast in flat: the arc look would be built over the
          // whole descent and then abandoned exactly where the player is looking
          // at it. Scaling by the same fraction keeps the two consistent at any
          // setting, and at the default means the nose tracks the arc all the
          // way to touchdown.
          const handover = 1 - (this._landEngage ?? 0) * THREE.MathUtils.clamp(TIRE.airLandPitchLevel, 0, 1);
          if (handover > 0.02) {
            pitchTarget = rate * handover;
            pitchGain = TIRE.airAlignGain;
            aligning = true;
          }
        }
      }
      // WHICH AXIS THE PITCH TORQUE ACTS ABOUT MATTERS ONCE THE CAR IS ROLLED.
      //
      // Player pitch stays on the chassis RIGHT axis: rolled, that gives a
      // corkscrew, which is a legitimate stunt and what the input should do.
      //
      // The nose-follows-arc ALIGNMENT must not. It is an automatic assist, and
      // about a rolled chassis-right axis its correction carries a world-vertical
      // component — so it silently YAWS the car for the whole descent. Measured:
      // 0.6 s of roll input yawed the heading 8° on a short jump and 33° on a
      // full-height one, entirely from this term. The player never sees it (they
      // are watching a rolling car), then lands 33° across their direction of
      // travel and the tyres snap it straight. That is the reported "car turns
      // abruptly by itself on landing" — it was never a landing bug.
      //
      // So the assist uses a HORIZONTAL pitch axis: perpendicular to world up and
      // to the heading, i.e. the axis about which pitching cannot yaw.
      let pitchAxis = this._airRight;
      if (aligning) {
        // Horizontal, perpendicular to the HEADING. Rotation about it changes the
        // nose's ELEVATION and nothing else — which is all the assist wants. The
        // chassis-right axis would do the same job only while the car is level;
        // rolled, it is tilted, and then the assist's correction sweeps the nose
        // SIDEWAYS. That is the whole 33° of unrequested yaw.
        this._airHeading.copy(this._airFwd);
        this._airHeading.y = 0;
        if (this._airHeading.lengthSq() > 1e-6) {
          this._airHeading.normalize();
          this._airPitchAxis.crossVectors(this._yAxis, this._airHeading).normalize();
          pitchAxis = this._airPitchAxis;
        }
      }
      this._stabTorque.addScaledVector(
        pitchAxis, (pitchTarget - body.angVel.dot(pitchAxis)) * pitchGain * Ip,
      );

      // ROLL STAYS ON THE CHASSIS FORWARD AXIS. Rotating about a body's own
      // forward vector cannot change that vector, so pure roll can never alter
      // the heading — which is exactly the property wanted. An earlier attempt
      // rolled about the HORIZONTAL PROJECTION of forward instead; with a pitched
      // nose that is a different axis, so it started swinging the nose sideways
      // and the car visibly stopped facing its direction of travel. Do not
      // "improve" this axis.
      axis(this._airFwd, inR, TIRE.airRollRate, Ir);

      // THE Q/E SPIN AXIS IS WORLD UP UNTIL THE NOSE GOES VERTICAL, THEN THE
      // CAR'S OWN UP. Neither works everywhere — this is a measured trade, not a
      // preference, and both endpoints have a failure you can see.
      //
      // WORLD UP alone breaks on a wall. Off a park bowl the car leaves the lip
      // nose STRAIGHT UP, so world up IS its roll axis and a "flat spin" about it
      // can only barrel-roll. MEASURED at the lip: fwd·fwd0 +0.99 (the nose does
      // not move at all), up·up0 −0.86 — a pure roll, reported exactly that way.
      //
      // CHASSIS UP alone breaks on a jump. On a pitched ramp the axis tilts with
      // the attitude and the spin leaks into roll: MEASURED on jump-debug.json,
      // E gave roll −15° / yaw 2° against world up's roll −1° / yaw 18°. That is
      // the same ±17° this file already warned about — and note it is the AXIS
      // that does it, not the torque model, since this path is kinematic.
      //
      // So key it on the one thing that actually decides it: how close world up
      // is to being useless, i.e. how near the nose is to vertical. Level nose ⇒
      // world up, unchanged flat spin. Nose up a wall ⇒ the car's own up, which
      // is the skater's 180 — back down the face nose-first, same way up.
      //
      // Kinematic, not a torque, and that stays load-bearing: an earlier
      // chassis-up TORQUE cross-coupled through the inertia tensor on top of all
      // this. Rotating the body directly has no inertia to route through.
      // THE AXIS IS LATCHED WHEN THE SPIN STARTS, and that is not a detail — a
      // re-evaluated axis cannot complete the manoeuvre it started. The blend
      // reads the nose attitude, and the spin ITSELF changes the nose attitude:
      // 90° into a bowl 180 the nose has come down to horizontal, the blend falls
      // back toward world up, and the axis moves out from under the rotation.
      // MEASURED live-blended at the lip: fwd·fwd0 0.53, up·up0 −0.21 — a spin
      // that starts as a 180 and finishes as neither. Latched: −0.87 / 1.00.
      //
      // Held through the release settle too, so letting go mid-spin does not
      // change axis while the rate bleeds off.
      if (inY !== 0 && !this._yawAxisHeld) {
        const noseVert = Math.abs(this._airFwd.y);
        const upBlend = THREE.MathUtils.smoothstep(
          noseVert, TIRE.airYawUprightStart, TIRE.airYawUprightFull);
        this._yawAxis.copy(this._yAxis).lerp(this._stabUp, upBlend);
        // Only ever near-degenerate if the two are opposed, which needs a level
        // nose — and a level nose means blend 0, i.e. plain world up.
        if (this._yawAxis.lengthSq() < 1e-6) this._yawAxis.copy(this._stabUp);
        this._yawAxis.normalize();
        this._yawAxisHeld = true;
      } else if (inY === 0 && Math.abs(this._airYawRateState) < 1e-4) {
        this._yawAxisHeld = false;
      }

      const yawTarget = inY * TIRE.airYawRate;
      const yawGain = inY !== 0 ? TIRE.airResponse : TIRE.airYawSettle;
      this._airYawRateState +=
        (yawTarget - this._airYawRateState) * (1 - Math.exp(-yawGain * dt));
      if (inY !== 0 || Math.abs(this._airYawRateState) > 1e-5) {
        const yawStep = this._airYawRateState * dt;
        this._holdQ.setFromAxisAngle(this._yawAxis, yawStep);
        body.quat.premultiply(this._holdQ).normalize();
        body.angVel.applyAxisAngle(this._yawAxis, yawStep);
      }

      // ── SETTLE THE UNWANTED ROTATION AS A VECTOR ──────────────────────────
      //
      // THIS IS THE FIX FOR "A ROLL MAKES THE CAR LAND CROOKED", and it is a
      // change of METHOD, not of tuning — every constant above is untouched.
      //
      // `axis()` settles each idle axis separately, along the chassis' own
      // right and up vectors. Those are exactly the axes a ROLL sweeps through
      // vertical. So damping a leftover pitch rate — which every ramp gives you,
      // measured 0.74 rad/s off the user's 24° jump piece — is delivered partly
      // as YAW for as long as the roll keeps turning the axis it is applied
      // about. Pitch never suffered because pitch is the axis you command; roll
      // and yaw did, which is exactly the reported pattern (flips fine, rolls
      // and spins not).
      //
      // MEASURED on the user's own track (tools/jumpDebugTrack.mjs), a held
      // 360° roll with no other input:
      //     airSettle on   →  yaw −2.4°   (and the car drives off its line)
      //     airSettle off  →  yaw  0.1°   (but pitch runs away to 144°)
      // i.e. the damping is both necessary AND the thing leaking into yaw.
      //
      // Damping the perpendicular rotation as ONE VECTOR cannot leak: the torque
      // is by construction anti-parallel to the rotation it removes, so there is
      // no third axis for it to appear on. It removes the same rotation the
      // per-axis version was aiming at — just without choosing a frame to
      // express it in.
      //
      // Only the FREE part is treated this way. Anything the player is actively
      // commanding keeps its own axis and its own gain above; this subtracts
      // that out first so it is never fought.
      if (TIRE.airSettle > 0) {
        this._freeOmega.copy(body.angVel);
        // Take out every axis the player is driving — those are handled already.
        if (inR !== 0) {
          this._freeOmega.addScaledVector(this._airFwd, -this._freeOmega.dot(this._airFwd));
        }
        if (inP !== 0 || aligning) {
          this._freeOmega.addScaledVector(pitchAxis, -this._freeOmega.dot(pitchAxis));
        }
        // Cancel what the per-axis settling above already asked for on those same
        // free axes, so the two do not stack into double damping.
        for (const [unit, inertia, driven] of [
          [this._airFwd, Ir, inR !== 0],
          [pitchAxis, Ip, inP !== 0 || aligning],
        ]) {
          if (driven) continue;
          const c0 = body.angVel.dot(unit);
          this._stabTorque.addScaledVector(unit, c0 * TIRE.airSettle * inertia);
        }
        // …and damp it as a single vector instead. Inertia is diagonal in the
        // chassis axes, so scale each component by its own to get a torque whose
        // resulting ACCELERATION is exactly −airSettle · freeOmega.
        this._freeTorque.set(0, 0, 0);
        this._freeTorque.addScaledVector(this._airFwd, this._freeOmega.dot(this._airFwd) * Ir);
        this._freeTorque.addScaledVector(this._airRight, this._freeOmega.dot(this._airRight) * Ip);
        this._freeTorque.addScaledVector(this._stabUp, this._freeOmega.dot(this._stabUp) * Iy);
        // WHILE ROLLING, KILL IT FAST. A roll about a FIXED axis returns the
        // car exactly where it started — that is why with damping off the yaw is
        // 0.1°. What leaks is the axis MOVING mid-roll, and it moves for as long
        // as there is a perpendicular rate left to damp. So the cure is to be
        // done with it quickly rather than to bleed it away across the whole
        // rotation. See TIRE.airRollPurity.
        const settle = inR !== 0 ? TIRE.airRollPurity : TIRE.airSettle;
        this._stabTorque.addScaledVector(this._freeTorque, -settle);
      }

      // ── HEADING HOLD ──────────────────────────────────────────────────────
      // Put back the heading the roll quietly stole. See the AIRBORNE HEADING
      // HOLD block on TIRE for why a roll steals any at all.
      //
      // Q/E is a DELIBERATE spin, so while it is held the target simply follows
      // the car — the hold re-baselines rather than fighting the player, and
      // whatever heading the spin ends on becomes the new one to keep.
      // RUNS THROUGHOUT THE ROLL, not just once the car is back on its wheels.
      //
      // An "only when upright" gate was tried and is WRONG, and it took the
      // user's own track to show it. On a synthetic ramp the gate looked better;
      // on the real one (jump-debug.json: 24° jump piece, 110 m gap) it was what
      // held the fix back, because a barrel roll spends almost none of its
      // flight upright — so the trim hardly ever ran. MEASURED at 360°:
      //     gated    heading in air −5.18°, at landing −2.33°, slide 3.42 m
      //     ungated  heading in air −1.18°, at landing  1.15°, slide 1.78 m
      // The drift is made continuously while the car rolls, so the correction
      // has to be there continuously too.
      // STANDS DOWN FOR EVERY DELIBERATE AIR INPUT EXCEPT ROLL.
      //
      // It exists to clean up drift that ROLL causes, and it must not touch
      // anything else. Gating it on the yaw key alone was not enough and broke
      // two things outright:
      //   • FLIPS. Pitch the car over the top and the heading legitimately
      //     reverses — nose over tail is a 180° heading change. With the hold
      //     still armed it fought to drag the car back to the pre-flip heading,
      //     so Shift/Ctrl stopped working at all.
      //   • Q/E SPINS. Releasing the key handed the car to a hold still aimed at
      //     the heading from before the spin, which yanked it round on landing.
      // Both are the same mistake: a heading hold has no business acting while
      // the player is deliberately changing their heading.
      //
      // When blocked it ADOPTS the current heading rather than freezing the old
      // one, so whatever a flip or a spin leaves you pointing at simply becomes
      // the new thing to hold. Nose vertical, "heading" is meaningless, so the
      // target is dropped entirely and re-acquired when the nose comes back down.
      const horizLen = Math.hypot(this._airFwd.x, this._airFwd.z);
      const blocked =
        inY !== 0
        || Math.abs(this._airYawRateState) > 1e-3
        || inP !== 0
        || horizLen < TIRE.airHeadingMinLevel;
      if (blocked) {
        this._holdHeading = horizLen >= TIRE.airHeadingMinLevel
          ? Math.atan2(this._airFwd.x, this._airFwd.z)
          : null;
      } else if (TIRE.airHeadingHold > 0 && this._holdHeading !== null) {
        let err = this._holdHeading - Math.atan2(this._airFwd.x, this._airFwd.z);
        // Shortest way round, or a wrap past ±180° would send the car the long way.
        while (err > Math.PI) err -= Math.PI * 2;
        while (err < -Math.PI) err += Math.PI * 2;
        let rate = err * TIRE.airHeadingHold;
        const cap = TIRE.airHeadingMaxRate;
        if (rate > cap) rate = cap; else if (rate < -cap) rate = -cap;

        // KINEMATIC, NOT A TORQUE, and that distinction is the whole fix.
        //
        // A torque about world-up looks like the obvious way to steer the
        // heading back, and it makes things WORSE — measured, it flipped the
        // drift's sign and grew it (−2.3° → +6.2°) even at a gain low enough to
        // be nearly off. The reason is the inertia tensor: rolled 90°, world-up
        // lines up with the chassis' PITCH axis (1554 kg·m²), so a "yaw" torque
        // is delivered as pitch — and more pitch rate is precisely what was
        // generating the drift, so it is a feedback loop rather than a
        // correction.
        //
        // Rotating the body directly has no inertia to route through. The
        // angular velocity is carried round with it so the rotation state stays
        // consistent, and the roll the player asked for is untouched: this only
        // ever removes rotation ABOUT WORLD UP that nobody commanded.
        const step = rate * dt;
        if (step !== 0) {
          this._holdQ.setFromAxisAngle(this._yAxis, step);
          body.quat.premultiply(this._holdQ).normalize();
          body.angVel.applyAxisAngle(this._yAxis, step);
        }
      }

      body.torqueAccum.add(this._stabTorque);
    }
  }

  _applyChassisGroundContact(dt = FIXED_DT / this.SUBSTEPS) {
    const body = this.body;
    this._terrainLid = false;
    this._deckUp.set(0, 1, 0).applyQuaternion(body.quat);
    const inverted = this._deckUp.y < ROOF.dot;
    for (const corner of this.CHASSIS_CORNERS) {
      this._geomToWorld(corner, this._cWorld);
      const floorY = this.getFloorY ? this.getFloorY(this._cWorld.x, this._cWorld.z) : 0;
      // Written as "not below" rather than ">=" so a NaN floor SKIPS the corner
      // instead of driving it. `getFloorY` is a host-supplied terrain sampler
      // (v3 hands over its CPU heightmap read), and every comparison against
      // NaN is false — so the ">=" form treated an unsampleable floor as a hit,
      // computed a NaN penetration, and pushed a NaN force into the body. One
      // such corner is enough to make pos/vel NaN permanently, which is a black
      // screen and a NaN speedometer. No floor is not the same as a floor here.
      if (!(this._cWorld.y < floorY)) continue;
      const pen = floorY - this._cWorld.y;
      body.getVelocityAtPoint(this._cWorld, this._cVel);
      const lidCorner = inverted && corner.y > 0;
      const damper = this.CORNER_DAMPER * (lidCorner ? ROOF.terrainDamperMult : 1);
      const dampMag = Math.max(0, -this._cVel.y) * damper;
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
      // Roof corners on the dirt: the lid is the support, not the wheels.
      // Landing assist would otherwise treat this as still airborne (no tyre
      // load) and try to roll the car wheels-down against the corner springs.
      if (lidCorner) {
        this._terrainLid = true;
        this._roofTouch = true;
        this._roofImpactSpeed = Math.max(this._roofImpactSpeed, Math.max(0, -this._cVel.y));
      }
    }
    if (this._terrainLid) {
      // Edge-triggered: only the arrival, not every substep of a rest.
      if (!this._wasTerrainLid && body.vel.y < 0) {
        body.vel.y *= (1 - ROOF.terrainAbsorb);
      }
      this._terrainLidHold = ROOF.terrainLidHold;
    } else if (this._terrainLidHold > 0) {
      this._terrainLidHold = Math.max(0, this._terrainLidHold - dt);
    }
    this._wasTerrainLid = this._terrainLid;
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
   * Concave-surface grip — see the SURFACE_GRIP block for what this is for and
   * what it measured before it existed.
   *
   * Curvature comes free from data the tyres already produced: across any two
   * contact points the normals fan out, and how fast they fan IS the curvature.
   * For a surface of radius R, n = (C - p)/R on a concave surface, so
   *
   *     (p2 - p1) . (n2 - n1) = -|p2 - p1|^2 / R
   *
   * giving a SIGNED estimate k = -(dp . dn) / |dp|^2 that is positive inside a
   * tube or loop and NEGATIVE over a crest.
   *
   * For a CONCAVE surface that is the whole story: no BVH query, no geometry
   * lookup, no knowledge of what piece the car is on — a tube, a loop, a
   * half-pipe and a banked bowl all present the same way, and pressing the car
   * into any of them is always right.
   *
   * Convex curvature is not handled here at all — see ROAD_HOLD, and the note
   * on SURFACE_GRIP for why it is a per-wheel mechanism instead of a branch of
   * this one.
   */
  _applySurfaceGrip(dt = FIXED_DT / this.SUBSTEPS) {
    if (!SURFACE_GRIP.enabled || SURFACE_GRIP.gain <= 0) {
      this._sgMag = 0;
      return;
    }
    const body = this.body;

    // Averaged contact normal — the direction the extra load pushes along.
    let grounded = 0;
    this._sgN.set(0, 0, 0);
    for (const t of this.tires) {
      if (!t.grounded) continue;
      grounded++;
      this._sgN.add(t.hitNormal);
    }

    let target = 0;
    // Two contacts minimum: one normal cannot describe a curve.
    if (grounded >= 2 && this._sgN.lengthSq() > 1e-8) {
      this._sgN.normalize();

      let kSum = 0, kN = 0;
      for (let i = 0; i < this.tires.length; i++) {
        const a = this.tires[i];
        if (!a.grounded) continue;
        for (let j = i + 1; j < this.tires.length; j++) {
          const b = this.tires[j];
          if (!b.grounded) continue;
          this._sgDp.subVectors(b.hitPoint, a.hitPoint);
          const d2 = this._sgDp.lengthSq();
          // Contacts closer than ~0.5 m apart give a baseline too short to
          // measure curvature over — the estimate is dominated by normal noise.
          if (d2 < 0.25) continue;
          this._sgDn.subVectors(b.hitNormal, a.hitNormal);
          kSum += -this._sgDp.dot(this._sgDn) / d2; // signed: + concave, - convex
          kN++;
        }
      }

      if (kN > 0) {
        const k = kSum / kN;
        if (k > SURFACE_GRIP.minCurvature) {
          // Speed ALONG the surface — the component that actually has to be
          // turned by the curve. The normal component is closing speed, not
          // orbital speed, and counting it would spike the load on every bump.
          this._sgVt.copy(body.vel);
          this._sgVt.addScaledVector(this._sgN, -this._sgVt.dot(this._sgN));
          const v2 = this._sgVt.lengthSq();
          // Ramp with contact count for the same reason the stabilizer does:
          // two wheels over an edge should not command a full-strength shove.
          const contact = grounded * 0.25;
          target = SURFACE_GRIP.gain * body.mass * v2 * k * contact;
          const cap = SURFACE_GRIP.maxG * body.mass * GRAVITY;
          if (target > cap) target = cap;
        }
      }
    }

    // Ease in AND out — the exit is the half that matters (see SURFACE_GRIP.ease).
    this._sgMag += (target - this._sgMag) * (1 - Math.exp(-SURFACE_GRIP.ease * dt));
    if (this._sgMag <= 1) return;
    // Along -N: N points out of the surface toward the car, so this presses the
    // car INTO whatever it is riding, at the centre of mass (no torque).
    this._sgF.copy(this._sgN).multiplyScalar(-this._sgMag);
    body.addForce(this._sgF);
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
    let approachRoof = 0;
    this._solidApproachN.set(0, 0, 0);
    this._deckRoofApproachN.set(0, 0, 0);
    // Chassis-up, once. Every contact below is classified against it: a deck
    // whose outward normal opposes this is a surface pressing down on the car.
    this._deckUp.set(0, 1, 0).applyQuaternion(body.quat);

    for (const corner of this.DECK_CONTACT_POINTS) {
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
          // ROOF APPROACHES ARE KEPT SEPARATE, because the gate below is wrong
          // for them — see the note there.
          if (this._deckN.dot(this._deckUp) < ROOF.dot) {
            this._deckRoofApproachN.addScaledVector(this._deckN, closing);
            approachRoof = Math.max(approachRoof, closing);
            // ARM THE GUARD ON THE APPROACH, NOT ONLY ON CONTACT.
            //
            // The suspension gets to act BEFORE the deck resolver each substep,
            // and an inverted car's wheels are pushing DOWN at up to 20 m/s. If
            // the guard waits for the roof to be inside `skin`, the wheels drive
            // the car through those 5 cm in a single substep and out the far
            // side — where there is no roof contact to be had any more, so the
            // guard never arms at all and the car keeps accelerating downward.
            // MEASURED: caught at the right height for 4 ticks, then driven
            // clean through the deck at −21 m/s.
            //
            // The same "resting on it, not pressed by it" test as below, so a
            // ceiling approach still arms nothing.
            if (ROOF.enabled && this._deckN.y > ROOF.guardUpMin) {
              this._roofGuard = ROOF.guardHold;
              // THE SLAM SPEED IS MEASURED HERE, not at the contact below.
              // The clamp on the next line kills the closing velocity BEFORE
              // anything penetrates — which is the point — so by the time the
              // roof is inside `skin` it is closing at ~0 and an impact sampled
              // there reads 0.1 m/s for a 40 m/s slam.
              this._roofImpactSpeed = Math.max(this._roofImpactSpeed, closing);
            }
          } else {
            this._solidApproachN.addScaledVector(this._deckN, closing);
            approach = Math.max(approach, closing);
          }
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

      // ── ROOF-DOWN ─────────────────────────────────────────────────────────
      if (!ROOF.enabled || this._deckN.dot(this._deckUp) >= ROOF.dot) continue;
      this._roofTouch = true;
      this._roofImpactSpeed = Math.max(this._roofImpactSpeed, Math.max(0, inward));

      // RESTING ON IT vs PRESSED BY IT — the distinction the rest of this block
      // turns on, and it is not the same question as "is the roof touching".
      //
      //   RESTING ON IT   the car is on its lid; the face under the roof is a
      //                   road's TOP surface, so its outward normal points UP.
      //   PRESSED BY IT   a ceiling is overhead; that face is an UNDERSIDE, its
      //                   normal points DOWN, and the wheels have the road
      //                   perfectly well.
      //
      // MEASURED: a loop's entry runs directly under its own descending slab, so
      // the second case happens on EVERY loop approach (normal.y −0.98, 4/4
      // wheels down). Treating it as the first cost 4 of 7 loops.
      //
      // A ceiling still reports `roofTouch` — the game should know you are
      // scraping one — it just gets neither of the two responses below.
      if (this._deckN.y <= ROOF.guardUpMin) continue;

      // 1) The wheels may be lying. See the ceiling-guard block in Tire.apply.
      this._roofGuard = ROOF.guardHold;

      // 2) Sliding on the lid costs speed. Coulomb-shaped, the same as the
      //    terrain corners in _applyChassisGroundContact.
      //
      //    CAPPED, because `forceMag` is a 220 kN/m penetration spring: one deep
      //    substep (a hard landing, a seam) spikes it to tens of car-weights, and
      //    an uncapped fraction of that is a brick wall rather than a scrape. The
      //    cap is what keeps this a friction model instead of a speed deleter.
      if (ROOF.friction <= 0) continue;
      this._roofT.copy(this._cVel).addScaledVector(this._deckN, -this._cVel.dot(this._deckN));
      const slide = this._roofT.length();
      if (slide <= 0.01) continue;
      const ramp = Math.min(1, slide / Math.max(0.01, ROOF.frictionFullSpeed));
      const drag = Math.min(
        ROOF.friction * forceMag * ramp,
        ROOF.maxFrictionG * CHASSIS.mass * GRAVITY,
      );
      this._roofT.multiplyScalar(-drag / slide);
      body.addForceAtPoint(this._roofT, this._cWorld);
    }

    // Velocity-only, so it cannot lift the car or change ride height — it just
    // stops a contact point crossing the surface between substeps.
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

    // ROOF APPROACHES ARE NOT GATED ON THE WHEELS.
    //
    // `groundedCount < 3` was protecting one thing: a kerb or piece seam under
    // the car reading as an imminent crossing and braking a normal lap. Those
    // are surfaces the car is DRIVING ON, and their normals point up — so the
    // classification above already excludes them, and the gate was doing no work
    // for the roof while blocking the one case it was supposedly there for.
    //
    // What it blocked: 4 wheels on the road, full speed, into a low overpass.
    // At 30 m/s a point advances 0.25 m per substep against a 0.05 m skin, so
    // the roof went straight through the slab and only the far side stopped it
    // (if anything did). That is the one deck contact with no sweep protection
    // at all, and it is the exact geometry a stunt track is made of.
    if (approachRoof > 0 && this._deckRoofApproachN.lengthSq() > 1e-10) {
      this._deckRoofApproachN.normalize();
      const vIn = body.vel.dot(this._deckRoofApproachN);
      if (vIn < 0) body.vel.addScaledVector(this._deckRoofApproachN, -vIn);
    }
  }

  _resolveSolids(dt) {
    if (!SOLID.enabled) return;
    if (this.solidsBvh?.baked) this._resolveSolidBvh(this.solidsBvh, null, dt);
    if (this.solidCapsules.length) this._resolveSolidCapsules(dt);
    for (const mover of this.dynamicMovers) {
      if (mover.bvh?.baked) {
        this._resolveSolidBvh(mover.bvh, (p, out) => mover.velocityAt(p, out), dt);
      }
    }
  }

  /** Barrel-roll carry from spinning deck movers (Spin barrel, etc.). */
  _applyDeckCarry(dt) {
    if (this.groundedCount < 1) return;
    const body = this.body;
    const { throttle, steer } = this.input;
    for (const mover of this.deckCarryMovers) {
      mover.applyDeckCarry(body, body.pos, throttle, steer, this.groundedCount, dt);
    }
  }

  /**
   * Resolve the hull against the exact capsule colliders — same aggregate-contact
   * shape as the BVH path, so response, friction, spin and sparks are identical;
   * only the DETECTION is analytic instead of sampled.
   *
   * Its own aggregate rather than sharing the BVH's, for the same reason each
   * mover gets one: two independent surfaces can disagree about "out", and
   * averaging a rail normal with a post normal produces a direction that is
   * neither.
   */
  _resolveSolidCapsules(dt = FIXED_DT / this.SUBSTEPS) {
    const skin = SOLID.skin;
    let deepest = 0;
    let hits = 0;
    this._solidN.set(0, 0, 0);
    this._solidPoint.set(0, 0, 0);

    for (const cap of this.solidCapsules) {
      const d = this._closestHullToSegment(cap.a, cap.b, this._capQ, this._capN);
      const pen = cap.radius + skin - d;
      if (pen <= 0) continue;
      hits++;
      // _capN already points out of the capsule, in world space.
      this._solidN.addScaledVector(this._capN, pen);
      this._geomToWorld(this._capQ, this._sphC);
      this._solidPoint.add(this._sphC);
      if (pen > deepest) deepest = pen;
    }
    if (!hits) return;
    this._solidPoint.multiplyScalar(1 / hits);
    if (this._solidN.lengthSq() < 1e-10) return;
    this._solidN.normalize();
    this._applySolidContact(deepest, null, dt);
  }

  /**
   * Closest point on CHASSIS_HULL to a world-space segment.
   *
   * Solved by ALTERNATING PROJECTION in hull-local space: clamp the current
   * segment point into the box, project that back onto the segment, repeat. Both
   * sets are convex so this converges monotonically, and for a vertical post
   * against a roughly-upright car it is exact within a couple of iterations —
   * the segment parameter barely moves after the first.
   *
   * @param {THREE.Vector3} aW segment start (world)
   * @param {THREE.Vector3} bW segment end (world)
   * @param {THREE.Vector3} outQ receives the hull point, in hull-local space
   * @param {THREE.Vector3} outN receives the outward normal, in WORLD space
   * @returns {number} distance from the hull surface point to the segment
   */
  _closestHullToSegment(aW, bW, outQ, outN) {
    const H = CHASSIS_HULL;
    this._worldToGeom(aW, this._capA);
    this._worldToGeom(bW, this._capB);
    const dir = this._capD.subVectors(this._capB, this._capA);
    const dd = dir.lengthSq();
    const hw = H.width / 2, hh = H.height / 2, hl = H.length / 2;
    const loY = H.offsetY - hh, hiY = H.offsetY + hh;
    const loZ = H.offsetZ - hl, hiZ = H.offsetZ + hl;
    const cl = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

    let t = 0.5;
    for (let i = 0; i < 6; i++) {
      this._capP.copy(this._capA).addScaledVector(dir, t);
      outQ.set(cl(this._capP.x, -hw, hw), cl(this._capP.y, loY, hiY), cl(this._capP.z, loZ, hiZ));
      if (dd < 1e-9) break;
      const next = cl(this._capT.subVectors(outQ, this._capA).dot(dir) / dd, 0, 1);
      if (Math.abs(next - t) < 1e-5) { t = next; break; }
      t = next;
    }
    this._capP.copy(this._capA).addScaledVector(dir, t);
    outQ.set(cl(this._capP.x, -hw, hw), cl(this._capP.y, loY, hiY), cl(this._capP.z, loZ, hiZ));

    const dist = outQ.distanceTo(this._capP);
    if (dist > 1e-6) {
      outN.subVectors(outQ, this._capP).multiplyScalar(1 / dist);
    } else {
      // The axis is INSIDE the hull — the car has swallowed the post, so there is
      // no "away from it" to read off the geometry. Escape through the nearest
      // face instead, which is the shallowest way out and the only choice that
      // cannot fling the car across the track.
      const dx = hw - Math.abs(this._capP.x);
      const dy = Math.min(this._capP.y - loY, hiY - this._capP.y);
      const dz = Math.min(this._capP.z - loZ, hiZ - this._capP.z);
      if (dx <= dy && dx <= dz) outN.set(this._capP.x >= 0 ? 1 : -1, 0, 0);
      else if (dy <= dz) outN.set(0, this._capP.y >= H.offsetY ? 1 : -1, 0);
      else outN.set(0, 0, this._capP.z >= H.offsetZ ? 1 : -1);
    }
    outN.applyQuaternion(this.body.quat);
    return dist;
  }

  /**
   * Resolve CHASSIS_HULL against one BVH by PROJECTION — see the SOLID block
   * for why this replaced penetration springs.
   *
   * Two passes. First gather every overlapping (or trapped-inside) sample into
   * one aggregate contact: a penetration-weighted mean normal, the deepest
   * overlap, and the mean contact point (for the torque). Then apply the
   * correction ONCE. Resolving per-sample is what let the samples stack into a
   * launcher; one aggregate correction cannot exceed the actual overlap no
   * matter how many agree — which matters more now than it did, since the hull
   * carries ~200 samples rather than the 26 this was written against.
   */
  _resolveSolidBvh(bvh, surfaceVelFn, dt = FIXED_DT / this.SUBSTEPS) {
    const skin = SOLID.skin;
    const reach = Math.max(skin, SOLID.insideReach);
    const sitY = SOLID.sitNormalMaxY;
    const band = Math.max(skin, this.body.vel.length() * dt * SOLID.sweepMargin);
    const queryR = Math.max(reach, band);
    // QUERY RADIUS is at least `insideReach`. A sample that skipped the
    // 8 cm band and landed in a cavity is still found; the loop then IGNORES
    // any outside contact beyond the skin unless a ray along the away normal
    // hits another face (walled in), OR the sample would cross the skin this
    // substep (sweep — see SOLID.sweepMargin). See SOLID.insideReach.
    this._solidN.set(0, 0, 0);
    this._solidPoint.set(0, 0, 0);
    this._deepestN.set(0, 0, 0);

    // ── BROAD PHASE ─────────────────────────────────────────────────────────
    // ONE query for the whole hull before the ~208 per-sample ones. Every sample
    // lies inside the hull's bounding sphere, so if the nearest surface is
    // further than that sphere plus the recovery reach, not one of them can be
    // inside a wall and the loop is guaranteed to find nothing.
    if (this._hullRadius > 0) {
      this._geomToWorld(this._hullCentreLocal, this._hullCentreW);
      const near = bvh.closestPointWithNormal(
        this._hullCentreW.x, this._hullCentreW.y, this._hullCentreW.z,
        this._hullRadius + queryR, this._bpN,
      );
      if (!near) return;
    }

    let deepest = 0;
    let hits = 0;
    const wheelsCarry = this._isSupported();

    for (const sp of this.SOLID_BOX_SAMPLES) {
      this._geomToWorld(sp, this._sphC);
      const res = bvh.closestPointWithNormal(
        this._sphC.x, this._sphC.y, this._sphC.z, queryR, this._sphN,
      );
      if (!res) continue;
      // `_sphN` is flipped toward the query (away from the closest face).
      let nx = this._sphN.x;
      let ny = this._sphN.y;
      let nz = this._sphN.z;
      let pen;
      if (res.distance < skin) {
        pen = skin - res.distance;
      } else {
        let recovered = false;
        if (bvh.raycastFirst) {
          // Close but not overlapping. A ray along the away normal that hits
          // another face means the sample is walled in (rail U, hollow wall).
          // End-cap punch: away runs down the middle of a long solid and misses,
          // so a horizontal perpendicular is tried too (arch pillar).
          this._cavityFrom.copy(this._sphC).addScaledVector(this._sphN, 0.002);
          let blocked = bvh.raycastFirst(this._cavityFrom, this._sphN, reach);
          if (!blocked) {
            const px = -nz, pz = nx;
            const plen = Math.hypot(px, pz);
            if (plen > 0.1) {
              this._cavitySide.set(px / plen, 0, pz / plen);
              blocked = bvh.raycastFirst(this._cavityFrom, this._cavitySide, reach)
                || bvh.raycastFirst(this._cavityFrom, this._cavitySide.negate(), reach);
            }
          }
          if (blocked) {
            // WHICH WAY OUT? The shortest exit is toward the closest face, and
            // that is wrong exactly when the closest face is the FAR wall of a
            // thin solid the hull has driven into: pushing that way carries the
            // car THROUGH it, which is how a sprint into a start/finish nose
            // went out the back.
            //
            // Decided by where the CAR is, not by which wall this one sample is
            // nearer to — exit toward the side the body's centre sits on, i.e.
            // back the way the car came. That needs no velocity, and needing
            // none is the point: the old rule flipped the exit when it "continued
            // the motion", which reads ~0 on a car at rest, so a parked car with
            // one hull sample inside a rail was walked straight through it,
            // 0.27 m per tick, gaining nothing in speed. Measured against the
            // real rail in tools/railTunnelTest.mjs.
            //
            // Velocity stays as the tiebreak for the case the body direction
            // cannot answer: a hull sitting square on top of a slab, where
            // centre-to-contact is vertical and both exits are horizontal.
            let ox = -nx, oy = -ny, oz = -nz;
            this._escapeRef.set(
              this.body.pos.x - res.x,
              this.body.pos.y - res.y,
              this.body.pos.z - res.z,
            );
            const towardBody = this._escapeRef.x * ox + this._escapeRef.y * oy + this._escapeRef.z * oz;
            if (towardBody < -1e-3) {
              ox = nx; oy = ny; oz = nz;
            } else if (towardBody <= 1e-3) {
              this.body.getVelocityAtPoint(this._sphC, this._sphV);
              if (surfaceVelFn) {
                surfaceVelFn(this._sphC, this._surfV);
                this._sphV.sub(this._surfV);
              }
              if (this._sphV.x * ox + this._sphV.y * oy + this._sphV.z * oz > 0) {
                ox = nx; oy = ny; oz = nz;
              }
            }
            nx = ox; ny = oy; nz = oz;
            pen = res.distance + skin;
            recovered = true;
          }
        }
        if (!recovered) {
          // Would this sample CROSS the skin before the next substep?
          // Without this, a 0.38 m nose slab is entered in one tick at sprint
          // speed and the back face spits the car into the field.
          this.body.getVelocityAtPoint(this._sphC, this._sphV);
          if (surfaceVelFn) {
            surfaceVelFn(this._sphC, this._surfV);
            this._sphV.sub(this._surfV);
          }
          const closing = -(this._sphV.x * nx + this._sphV.y * ny + this._sphV.z * nz);
          if (!(closing > 0 && closing * dt > res.distance - skin)) continue;
          pen = 0;
        }
      }
      // Solids are walls. A mostly-up (or down) normal is a lid the hull can
      // park on while the wheels still see the road. Skip it: either a wall
      // sample will spat the car out, or it falls through onto the deck.
      //
      // UNLESS THE CAR IS ARRIVING ON IT AND NOTHING ELSE IS HOLDING IT UP — see
      // the second half of the SOLID.sitNormalMaxY block. `wheelsCarry` is
      // hoisted out of the loop; it cannot change between samples of one pass.
      if (Math.abs(ny) > sitY && wheelsCarry) continue;

      hits++;
      this._sphN.set(nx, ny, nz);
      // Sweep hits have pen 0 (velocity clamp only). They still have to vote
      // on the aggregate normal or a lone approach would call apply with a
      // zero vector and do nothing.
      this._solidN.addScaledVector(this._sphN, Math.max(pen, 0.05));
      this._solidPoint.add(this._sphC);
      if (pen > deepest) {
        deepest = pen;
        this._deepestN.set(nx, ny, nz);
      }
    }
    if (!hits) return;
    this._solidPoint.multiplyScalar(1 / hits);

    // Opposing walls in a cavity cancel the mean. Pushing along rounding noise
    // is worse than picking the deepest sample's out — that is the shortest
    // exit, and it is what gets the car out of the centre of a guardrail.
    if (this._solidN.lengthSq() < 1e-10) {
      if (this._deepestN.lengthSq() < 1e-10) return;
      this._solidN.copy(this._deepestN);
    }
    this._solidN.normalize();
    this._applySolidContact(deepest, surfaceVelFn, dt);
  }

  /**
   * Apply ONE aggregate solid contact: push out, kill inward speed, scrape, spin.
   *
   * Split out so the sampled (BVH) and analytic (capsule) detectors share it
   * verbatim. They must: a post that responded even slightly differently from a
   * wall would feel like a different material, and the sparks/scrape/stuck
   * signals all hang off this one path.
   *
   * Expects `this._solidN` normalised and `this._solidPoint` averaged.
   */
  _applySolidContact(deepest, surfaceVelFn, dt) {
    const body = this.body;
    this._solidTouch = true; // feeds the stuck detector in tick()
    // Snapshot for sparks BEFORE a later substep / mover / capsule pass clears
    // `_solidPoint`. See _updateScrapeLatch.
    this._scrapePoint.copy(this._solidPoint);
    this._scrapeNormal.copy(this._solidN);
    if (surfaceVelFn) this._solidFromMover = true;

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
    // Relative close-speed — movers must count the surface, not world vel.
    // A parked car hit by a pendulum reads ~0 in world and would never yield.
    const closing = vN < 0 ? -vN : 0;
    this._solidImpactSpeed = Math.max(this._solidImpactSpeed, closing);

    // A HARD HIT IS VIOLENT WHETHER OR NOT THE WHEELS ARE DOWN. This required
    // `!recovered`, and since you hit things while driving — four wheels on the
    // road — the boosted restitution and spin were never once applied to a
    // static barrier. The car took a 60 m/s impact with SOLID's deliberately
    // dead 0.05 restitution and 0.15 spin and simply stopped. See CRASH.minHold.
    const moverSlam = !!surfaceVelFn && closing >= CRASH.moverSpeed;
    const violent = CRASH.enabled && (
      moverSlam
      || this._crashYield > 0
      || closing >= CRASH.wallSpeed
    );
    if (violent && moverSlam) {
      this._crashYield = CRASH.hold;
      this._crashMover = true;
    } else if (violent && closing >= CRASH.wallSpeed) {
      this._crashYield = CRASH.hold;
    }
    const rest = violent ? CRASH.restitution : SOLID.restitution;
    const spinK = violent ? CRASH.spin : SOLID.spin;
    const spinMax = violent ? CRASH.maxSpin : SOLID.maxSpin;

    if (vN < 0) {
      body.vel.addScaledVector(this._solidN, -vN * (1 + rest));
    }
    if (surfaceVelFn) {
      const relN = body.vel.dot(this._solidN) - this._surfV.dot(this._solidN);
      if (relN < 0) body.vel.addScaledVector(this._solidN, -relN);
    }

    // 3) TANGENTIAL — scraping costs speed, ramped in so a car crawling out of
    //    somewhere it is trapped is not drained of the little it has.
    // 3) TANGENTIAL — scraping costs speed, ramped in so a car crawling out of
    //    somewhere it is trapped is not drained of the little it has.
    //    Sweep-only contacts (deepest 0) are "would cross next tick", not a
    //    scrape yet — friction here glued the car to a start/finish nose after
    //    the anti-tunnel clamp, same feel as parking on a hole-wall rim.
    if (deepest > 0 && SOLID.friction > 0 && dt > 0 && this._solidN.y < SOLID.sitNormalMaxY) {
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
    if (spinK > 0 && vN < 0) {
      this._solidR.subVectors(this._solidPoint, body.pos);
      this._solidTorque.crossVectors(this._solidR, this._solidN)
        .multiplyScalar(-vN * spinK);
      const mag = this._solidTorque.length();
      if (mag > 1e-6) {
        // CAP THE RESULT, NOT THE INCREMENT.
        //
        // This clamped the per-contact impulse to `maxSpin` and then ADDED it —
        // but a scrape is not one contact, it is a contact every substep, and
        // each one added up to the cap again. So the cap bounded nothing over a
        // sustained rub and the car could be wound to any yaw rate at all.
        // MEASURED on the user's own track (tools/jumpDebugTrack.mjs): a car
        // that lands sliding after a barrel roll walks out to the guardrail and
        // leaves it spinning at 2.65–3.39 rad/s, against a maxSpin of 2.5. That
        // is the "it turns by itself, very abruptly" — a rail hit, not a
        // landing, which is why it kept surviving every landing fix.
        //
        // Clamping the RESULTING rate about the spin axis is what the constant
        // always meant: "nothing can wind up a tumble". A first touch still gets
        // its full deflection; a long scrape simply stops adding once it is
        // already spinning that fast.
        this._solidSpinAxis.copy(this._solidTorque).multiplyScalar(1 / mag);
        const cur = body.angVel.dot(this._solidSpinAxis);
        const room = spinMax - cur;
        const add = Math.min(mag, Math.max(0, room));
        if (add > 0) body.angVel.addScaledVector(this._solidSpinAxis, add);
      }
    }

    // 5) TRIP-OVER — the barrel roll. See the TRIP-OVER block on CRASH for why
    //    the spin above can never produce one, and what this stands in for.
    //
    //    Only with the tyres actually carrying the car: that is the whole
    //    premise, since the ground holding the bottom of the car is what turns a
    //    sideways shove into a rotation instead of a slide. Airborne, a side hit
    //    keeps tumbling on `r × n` alone, which is correct — there is nothing to
    //    pivot against up there.
    if (violent && CRASH.tripRoll > 0 && vN < 0 && this._isSupported()) {
      this._tripFwd.set(0, 0, 1).applyQuaternion(body.quat);
      this._tripRight.set(1, 0, 0).applyQuaternion(body.quat);
      // The car goes over AWAY from the wall, i.e. the way it is being shoved.
      // `_solidN` points out of the surface, so it already IS the push. A
      // positive rotation about chassis-forward carries +X up and so tips the
      // car toward −X, which is why this is negated.
      const push = -this._solidN.dot(this._tripRight);
      let dw = push * closing * CRASH.tripRoll;
      // Same reason the spin above caps the RESULT, not the increment: a scrape
      // is a contact every substep, and capping each one would let a long rub
      // wind the car to any roll rate at all.
      // Capped on its OWN ceiling, not CRASH.maxSpin: getting a car over needs
      // more roll rate than a spin-out wants to allow. The energy to lift this
      // car's centre of mass past its tipping point works out at ~5.8 rad/s, so
      // a cap at maxSpin (6) left every trip marginal — measured, it leaned to
      // 39° and the springs returned it every time.
      const curRoll = body.angVel.dot(this._tripFwd);
      if (dw > 0) dw = Math.min(dw, Math.max(0, CRASH.tripMaxRate - curRoll));
      else dw = Math.max(dw, Math.min(0, -CRASH.tripMaxRate - curRoll));
      if (dw !== 0) {
        body.angVel.addScaledVector(this._tripFwd, dw);
        // ABOUT THE CONTACT LINE, NOT THE CENTRE OF MASS. Spin a car about its
        // own centre and the springs simply absorb it — measured, the roll rate
        // hit the 6 rad/s cap and the car still only leaned 35° before dropping
        // back. Rotating about the tyres instead is what lifts the CoM over
        // them, and for a rigid body that means the matching linear velocity
        // v += ω × r, r running from the contact line up to the centre. That is
        // where the height to tip over comes from; without it the roll is a
        // gesture the suspension undoes.
        this._tripUp.set(0, 1, 0).applyQuaternion(body.quat);
        // The car pivots on the side it is going over — dw > 0 tips it toward
        // chassis −X, so the −X tyres are the ones on the ground.
        this._tripLever
          .copy(this._tripRight).multiplyScalar(Math.sign(dw) * WHEEL_LAYOUT.halfTrack)
          .addScaledVector(this._tripUp, CRASH.tripPivotDrop);
        this._tripVel.copy(this._tripFwd).multiplyScalar(dw).cross(this._tripLever);
        body.vel.addScaledVector(this._tripVel, CRASH.tripLift);
      }
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
    // WHEELS FIRST. Where each wheel has to sit decides how much arch clearance
    // is left, and that feeds the body lift below — so this cannot wait for the
    // placement loop further down. See TIRE.archLiftBody.
    this._updateWheelExtensions(dt);
    this._geomCenter.copy(_COM_OFFSET).applyQuaternion(this._renderQuat).add(this._renderPos);
    this.chassisMesh.position.copy(this._geomCenter);
    // Body lean goes on the CHASSIS ONLY. The wheels below are placed from
    // _renderQuat, so they stay planted while the body rolls over them — which
    // is the whole effect. Post-multiplying applies the lean in the chassis'
    // own frame, and the lights parented to this mesh come along for free.
    //
    // MUST BE COMPUTED BEFORE THE LIFT — the lift depends on the lean angles.
    this._updateBodyLean(dt);
    // ARCH CLEARANCE. Rotating the body about its own origin sweeps the OUTER
    // wheel arch DOWN onto a wheel that has not moved, by halfTrack·sin(roll)
    // at the side and frontZ·sin(pitch) at the nose. See BODYLEAN.archCompensate
    // for why that is a modelling artefact rather than something to look at.
    let lift = CHASSIS.visualLift;
    if (BODYLEAN.archCompensate > 0 && (this._leanRoll !== 0 || this._leanPitch !== 0)) {
      this._leanLift = BODYLEAN.archCompensate * (
        WHEEL_LAYOUT.halfTrack * Math.abs(Math.sin(this._leanRoll))
        + Math.abs(WHEEL_LOCAL[0].pos.z) * Math.abs(Math.sin(this._leanPitch))
      );
      lift += this._leanLift;
    } else this._leanLift = 0;
    // …and the same idea for SUSPENSION: when a wheel needs to come up further
    // than the arch gap allows, raise the body rather than shove the tyre into
    // the road. _updateWheelExtensions worked out how much.
    lift += this._archLift;
    if (lift !== 0) {
      this._wheelUp.set(0, 1, 0).applyQuaternion(this._renderQuat);
      this.chassisMesh.position.addScaledVector(this._wheelUp, lift);
    }
    this.chassisMesh.quaternion.copy(this._renderQuat);
    if (this._leanRoll !== 0 || this._leanPitch !== 0) {
      this._leanQRoll.setFromAxisAngle(this._zAxis, this._leanRoll);
      this._leanQPitch.setFromAxisAngle(this._xAxis, this._leanPitch);
      this.chassisMesh.quaternion.multiply(this._leanQRoll).multiply(this._leanQPitch);
    }

    // Visual steer INCLUDES the drift countersteer overlay. The TYRES used the
    // plain _steerAngle() back in _physicsStep — this only turns meshes.
    const steerCentre = this._visualSteerAngle(dt);
    for (let i = 0; i < this.tires.length; i++) {
      const t = this.tires[i];
      const cfg = WHEEL_LOCAL[i];
      // Ackermann on the DRAWN wheels too, or the physics and the picture
      // disagree by up to 25° at full lock — which is very visible parked on
      // full lock, the one place you can study the front wheels at leisure.
      const steerAngle = cfg.steer
        ? this._wheelSteerAngle(steerCentre, t.localPos.x)
        : steerCentre;
      this._wheelUp.copy(this._yAxis).applyQuaternion(this._renderQuat);
      // Decided up front by _updateWheelExtensions, because the body lift above
      // depends on it. May be NEGATIVE (wheel above its hub) on a deep hit —
      // that is a real requirement, and the lift is what keeps the arch clear.
      const suspExt = t.visualExt;
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
   * Raise a wheel out of any SOLID it is intersecting. Returns the corrected
   * extension; only ever smaller (higher) than what went in.
   *
   * Treats the tyre as a sphere at its centre, which is what the wheel already
   * uses for its anti-tunnel sweep (TIRE.sphereSweepScale) and is close enough
   * for a rail cap or a gate panel. The correction is along the SUSPENSION axis,
   * so it has to be divided by how much of the surface normal lies along that
   * axis — hence the facing gate, see TIRE.wheelSolidMinFacing.
   */
  _clearSolids(t, ext) {
    this._wsHub.copy(t.localPos).sub(_COM_OFFSET)
      .applyQuaternion(this._renderQuat).add(this._renderPos);
    this._wsCentre.copy(this._wsHub).addScaledVector(this._wsUp, -ext);
    const hit = this.solidsBvh.closestPointWithNormal(
      this._wsCentre.x, this._wsCentre.y, this._wsCentre.z, WHEEL.radius, this._wsN,
    );
    if (!hit) return ext;
    const pen = WHEEL.radius - hit.distance;
    if (pen <= 0) return ext;
    const facing = this._wsN.dot(this._wsUp);
    if (facing < TIRE.wheelSolidMinFacing) return ext;
    const raise = Math.min(pen / facing, WHEEL.radius);
    return ext - raise;
  }

  /**
   * PASS 1 of syncVisuals: decide where every wheel must be DRAWN, and how much
   * body lift that costs. Sets `t.visualExt` (the offset the placement loop
   * uses) and `this._archLift`. Physics reads neither.
   *
   * See the ARCH CLEARANCE block on TIRE for the measurements behind this.
   */
  _updateWheelExtensions(dt) {
    const k = 1 - Math.exp(-TIRE.suspVisSmooth * dt);
    const solids = TIRE.wheelSolidClear > 0 && this.solidsBvh?.baked ? this.solidsBvh : null;
    if (solids) this._wsUp.set(0, 1, 0).applyQuaternion(this._renderQuat);
    let shortfall = 0;
    for (const t of this.tires) {
      const targetDist = t.grounded ? t.hitDistance : TIRE.rayLength;
      if (t._smoothDist === undefined) t._smoothDist = targetDist;
      t._smoothDist += (targetDist - t._smoothDist) * k;

      // Airborne there is no hit, so _smoothDist eases out to the full PROBE
      // length and the wheel would hang far below the body — hence the droop cap.
      let ext = t._smoothDist - WHEEL.radius;
      if (ext > TIRE.maxDroop) ext = TIRE.maxDroop;
      // NEVER BELOW THE MEASURED CONTACT. `hitDistance` is where the tyre found
      // the surface on THIS tick; `_smoothDist` deliberately lags it, and on
      // rising ground that lag is drawn as tyre inside road. A ceiling only, so
      // the easing still owns the wheel whenever it is not about to sink —
      // the suspension visibly works exactly as before.
      if (t.grounded) {
        const contactExt = t.hitDistance - WHEEL.radius;
        if (ext > contactExt) ext = contactExt;
      }
      // Deep compression puts the contact patch ABOVE the hub (a 0.20 m step
      // leaves the hub 0.297 m up against a 0.36 m tyre), so a negative
      // extension is a real requirement rather than an error. Bounded so a bad
      // probe cannot fling the body upward.
      // SOLIDS the tyre probe cannot see — rails, gates, shells. See
      // TIRE.wheelSolidClear. Applied after the ground clamp and only ever
      // RAISES the wheel, so it can never reintroduce sink.
      if (solids) ext = this._clearSolids(t, ext);
      if (ext < -TIRE.archLiftMax) ext = -TIRE.archLiftMax;
      t._visExt = ext;
      if (TIRE.minSuspExt - ext > shortfall) shortfall = TIRE.minSuspExt - ext;
    }

    const share = THREE.MathUtils.clamp(TIRE.archLiftBody, 0, 1);
    const wantLift = Math.min(TIRE.archLiftMax, Math.max(0, shortfall) * share);
    // UP INSTANTLY, DOWN EASED. Any smoothing on the way up is a frame of tyre
    // inside the bodywork, which is the defect being fixed; on the way down a
    // hard drop would yank the body out from under the car after a kerb.
    if (wantLift >= this._archLift) this._archLift = wantLift;
    else this._archLift += (wantLift - this._archLift) * (1 - Math.exp(-TIRE.archLiftSettle * dt));

    // Whatever the body did NOT take, the wheel still absorbs. At archLiftBody 0
    // this is bit-for-bit the old `ext < minSuspExt → minSuspExt` clamp.
    for (const t of this.tires) {
      const over = TIRE.minSuspExt - t._visExt;
      t.visualExt = over > 0 ? t._visExt + over * (1 - share) : t._visExt;
    }
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

  /**
   * Signed km/h FORWARD speed for a HUD — negative in reverse.
   *
   * The body was `vel.length() * 3.6`, which is neither signed nor forward: it
   * is the full 3-D speed, so reversing read positive and a car in free fall
   * showed a speed it was not travelling over the ground. Nothing consumed it
   * (roadGame's HUD computes its own), so this is a dormant accessor being made
   * to match the contract its own doc-comment states, rather than a behaviour
   * change — but a future caller would have been misled by it.
   */
  get speedKmh() {
    this._steerFwd.set(0, 0, 1).applyQuaternion(this.body.quat);
    return this.body.vel.dot(this._steerFwd) * 3.6;
  }

  get groundedCount() {
    return this.tires.reduce((n, t) => n + (t.grounded ? 1 : 0), 0);
  }
}
