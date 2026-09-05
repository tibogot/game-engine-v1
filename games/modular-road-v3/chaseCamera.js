import * as THREE from "three";

/**
 * Chase camera.
 *
 * ═══ THE ARCHITECTURE: TWO INDEPENDENT JOBS ═════════════════════════════════
 *
 * A chase camera has to answer two questions, and every version of this file
 * that went wrong went wrong by answering them with the SAME vector:
 *
 *   1. WHERE DOES THE CAMERA SIT?    → the BOOM. Must follow the road, or it
 *                                      ends up on the wrong side of the tarmac
 *                                      and you are looking at the underside of
 *                                      a loop instead of at the car.
 *   2. WHICH WAY IS UP ON SCREEN?    → the VIEW. Must stay world-level, or the
 *                                      horizon rolls and it is nauseating.
 *
 * Tie them together and you must sacrifice one. Follow the road with both and a
 * tube rolls the camera (headache). Level both and the boom swings under the car
 * mid-loop and the road blocks the shot. They are SEPARATE here:
 *
 *     P   = car − boomF·dist + boomU·height        (boom: follows the road)
 *     d   = normalise(car − P)                     (aim straight AT the car)
 *     r   = normalise(d × worldUp)                 (horizontal by construction)
 *     u_d = r × d
 *     view = d·cos φ + u_d·sin φ                   (tilt the AXIS up by φ)
 *     camera.up = r × view
 *
 * ═══ WHY THIS PINS THE CAR ══════════════════════════════════════════════════
 *
 * The view axis is the direction to the car rotated UP by exactly φ about a
 * horizontal axis. So the car is exactly φ below the view axis, and exactly on
 * the vertical centre line, at every attitude, always:
 *
 *     ndc.x = 0                    ndc.y = −tan φ / tan(fov/2)
 *
 * This is stronger than what the previous version achieved. It held the car at a
 * constant ANGLE off the axis by building the camera and the aim point in one
 * shared frame — but that only works while camera.up is also locked to that
 * frame, which is exactly what forced the frame to roll. Aiming AT the car
 * instead makes the framing independent of the boom entirely: the boom can do
 * whatever it likes, roll included, and the car does not move a pixel.
 *
 * That independence is the whole point. It means job 1 can be solved on its
 * merits — hug the road, stay out of the scenery — without ever being traded off
 * against job 2.
 *
 * ═══ THE THREE BUGS THIS FILE HAS HAD, SO THEY DON'T COME BACK ══════════════
 *
 * 1. TWO UNRELATED FRAMES (the original). Camera placed behind a world-horizontal
 *    heading at a world-up height, aimed along a separately-smoothed velocity
 *    vector. The car's screen position was whatever the two happened to disagree
 *    by. Measured: flat road ndc.y −0.41, steep ramp +0.12, vertical wall +0.38,
 *    −60° descent −1.22 (OFF SCREEN), inverted +0.41 with the camera 3.2 m BELOW
 *    the car — 53° of framing swing from attitude alone. "Sometimes the camera is
 *    up, sometimes down / on a ramp I see only the tip of the car."
 *
 * 2. ONE FRAME THAT FOLLOWED THE ROAD. Fixed the framing, but a tube or corkscrew
 *    rolls the road about the travel axis, so the frame rolled about the VIEW
 *    axis. "The camera rotates and it's really giving headache."
 *
 * 3. ONE FRAME THAT STAYED LEVEL (yaw+pitch only). No roll, but the boom was then
 *    forced level too: pitching with the travel direction it swung 5.2 m BELOW
 *    the car climbing a loop, into the loop's interior, and the road came between
 *    camera and car (measured: line of sight BLOCKED from the apex onward).
 *
 * The fix for all three is the same one: stop making one vector do both jobs.
 *
 * 4. SHOWING THE NOSE OVER THE TOP OF A LOOP. With the boom free to follow the
 *    road, the remaining problem was that a loop REVERSES the travel heading, so
 *    the boom's azimuth has to travel 180° — and traced analytically, its
 *    horizontal part vanishes halfway through that journey (φ = 113° round a loop
 *    entered heading −Z), i.e. the path runs over the pole. Holding the azimuth
 *    dodges the pole but parks the camera in FRONT of the car at the apex.
 *
 *    Both are fixed by going round the SIDE — see the swing at the use site. It
 *    is not a flourish; it is what makes the azimuth's 180° reachable without
 *    passing through vertical, and it costs nothing anywhere else because it
 *    computes to exactly zero unless the boom is actually near the pole.
 */
export const CHASE_CAM = {
  // ── FRAMING. `carBelowCentre` is now the ONLY thing that moves the car on
  // screen. dist/height change where you watch FROM, not where the car sits. ──
  /** Degrees the car sits below the centre of the screen. 0 = dead centre.
   *  Exact, at every attitude — see the derivation above. */
  carBelowCentre: 14.0,

  // ── THE BOOM: where the camera sits. Free to follow the road, because it can
  // no longer disturb the framing. ─────────────────────────────────────────────
  dist: 7.5,          // trail distance behind the car, along −boomF
  height: 3.2,        // offset along the ROAD's normal, +boomU
  /** Multiplier on `height` while riding the loop-back wall and through its
   *  flight. On a vertical wall the boom's up is OUT from the face, so more
   *  of it puts the camera looking at the car's roof rather than up its
   *  tail — the reference's first frame. */
  wallHeightMul: 1.8,
  /** Which way the camera swings round the car through a flip-ramp launch.
   *  +1 goes round one side, -1 the other. It has to be explicit: both ends of
   *  the pivot lie in the same vertical plane, so left to itself the azimuth
   *  picks a side on rounding and the shot is not repeatable. */
  flipPivotSide: -1,
  /** The pivot's window, in degrees of NOSE ANGLE up the ramp, and the angle
   *  that reads as the SIDE view sitting between them.
   *
   *  `pivotSideDeg` must match the flip ramp's straight-face angle
   *  (`loopbackAngle`, 70°). That is the whole trick: along the straight face
   *  the nose angle does not change AT ALL, so a pivot driven by the nose
   *  stops dead there on its own. Hinging the halfway point of the sweep on
   *  that angle parks the hold exactly on the side view, and the length of the
   *  face (`loopbackStraight`) becomes how long the camera holds it.
   *
   *  The window used to be 20°→65° — which ends BELOW the face angle, so the
   *  sweep finished before it ever reached the flat spot, and spent its whole
   *  180° inside the entry transition alone: ~0.6 s, about 300°/s, against
   *  ~90°/s for a loop and a `boomMaxRate` backstop of 300. It ran at the
   *  ceiling. Reaching past the face spreads the same rotation over roughly
   *  twice the climb with a dead hold in the middle. */
  pivotFromDeg: 20,
  pivotSideDeg: 70,
  pivotToDeg: 84,
  /** Ceiling on how fast the pivot may ADVANCE, in units of t per second.
   *  1/0.75 s, so the full 180° can never take less than 0.75 s.
   *
   *  It exists because the nose is a good clock for only half the climb.
   *  MEASURED, entering at 26 m/s: the nose takes 0.40 s to go 36°->70°, then
   *  sits at 70° for 0.24 s (the straight face — the dwell), and then whips
   *  70°->84° in 0.10 s as the curl takes hold. Mapping the pivot straight onto
   *  that would spend its first half at a decent 190°/s and its second at
   *  900°/s. The cap turns that whip into a steady advance that still lands
   *  well before the wheels leave.
   *
   *  Set deliberately just ABOVE what the first half asks for (peak ~1.36/s)
   *  rather than below it. A tighter cap does smooth the sweep, but it does it
   *  by running the pivot late into the straight face, and then the face is
   *  spent catching up instead of holding — the dwell is the first thing a low
   *  cap eats, and the dwell is the point. */
  pivotRate: 1.4,
  /** How much of the pivot is spent DECELERATING onto its final framing, in
   *  units of t. A rate cap that simply stops when it arrives is a velocity
   *  step: MEASURED 2376°/s² of view acceleration at 92% through the sweep,
   *  right before the launch, which is the worst place to put one.
   *
   *  Measured against the END of the sweep, not against the current target.
   *  Against the target it also decelerates onto the DWELL, and then creeps
   *  through the straight face at a fraction of the rate instead of resting on
   *  it — which cost the entire hold (0.20 s -> 0.00 s). Arriving at the hold
   *  needs no help, because `want` is a smoothstep and eases itself in; only
   *  the finish is cap-governed, so only the finish stops dead.
   *
   *  A critically damped follow on the whole pivot was tried instead of this
   *  and is worse HERE, which is worth recording because it is the obvious
   *  move: it decelerates onto the hold too, so the dwell fell to 0.03 s at
   *  speed, and it bought almost nothing (1827 vs 1836°/s²) because the
   *  roughness at that moment is not the camera's — see below. */
  pivotArrive: 0.15,
  /** `headingLerp` while the flip pivot is running.
   *
   *  4.0 is a 0.25 s time constant, which on a ~1 s sweep is not smoothing, it
   *  is a delay: MEASURED, the boom reached only t=0.39 while the pivot was
   *  asking for 0.63, and the freeze at launch then caught the shot 87% built
   *  instead of finished. The pivot is authored smooth and rate-capped, so
   *  there is nothing here for a slow follow to protect against.
   *
   *  It has to be this tight for the DWELL to exist at all, which is the part
   *  that is easy to get wrong. A follow lags a moving target by roughly
   *  rate x its time constant, so the boom arrives at the straight face already
   *  behind, and then spends the face catching up rather than holding still. At
   *  a combined ~0.2 s of lag that ate the hold entirely (0.06 s of 0.24 s
   *  survived). The dwell is only ever as long as the face MINUS the lag. */
  flipHeadingLerp: 25.0,
  /** `boomSmoothTime` while the flip pivot is running.
   *
   *  Tighter, because the pivot is AUTHORED smooth — eased in and out of the
   *  hold — so it does not need the spring to smooth it, and at 0.28 the spring
   *  lags a 200°/s sweep by ~60°: the camera would trail the composition badly
   *  enough to smear the very dwell this is for. The 0.28 case that comment
   *  defends is a rate-limited boom fed a large error, which this is not. */
  flipSmoothTime: 0.06,
  minSpeed: 3.0,      // below this the boom falls back to the car's facing
  headingLerp: 4.0,   // how fast the boom swings onto the travel direction
  /** How fast the boom's up tracks the road while GROUNDED. This is what keeps
   *  the camera on the drivable side of the tarmac through a loop or a wall
   *  ride, instead of outside it looking at the back of the road. */
  upLerp: 5.0,
  /** How fast the boom's up returns to world up while AIRBORNE. Slow on purpose:
   *  in the air the car's roll is trick input, not a surface, so a boom that
   *  chased it would swing the camera around the car during a roll. */
  airUpLerp: 1.6,
  /** Grace period (s) after the wheels leave before that starts, so a crest hop
   *  or the lip of a loop cannot unwind the boom mid-jump. */
  airHold: 0.35,
  // ── POLE GUARD ─────────────────────────────────────────────────────────────
  /** Hard limit on the boom's ELEVATION, in degrees. Not a nicety — it is what
   *  makes the level horizon below well-defined at all.
   *
   *  The boom is −f·dist + u·height, and on a DESCENT both terms tilt upward. Its
   *  horizontal part is −dist·cos θ + height·sin θ, exactly ZERO at
   *  θ = atan(dist/height) = 67°: the camera sits directly above the car, the view
   *  points straight down, and "level" has no answer. MEASURED as the horizon
   *  arriving 180° out — the car rendered upside down on a plain steep descent.
   *  A loop passes through the same configuration on its way round.
   *
   *  With the limit in place the view always keeps cos(68°) = 0.37 of horizontal
   *  content, so `camera.up` can be taken exactly level, every frame, with no
   *  easing and therefore no roll. Above the limit the camera simply stops
   *  chasing the road downhill and hangs back — which is what it should do
   *  anyway: you want to see the drop, not be pointed into it. */
  poleGuard: 68,
  /** Margin on the sideways swing, ×. 1.0 is the exact minimum that satisfies
   *  `poleGuard`; a little over keeps the camera clear of rails and tube walls. */
  sideScale: 1.15,
  /** Softening on the swing's onset, m². `side = √(need)` has an INFINITE
   *  derivative at need = 0, so the swing slams in the instant it engages —
   *  measured as part of 2041 m/s² of camera acceleration entering a quarterpipe.
   *  `√(need + ε) − √(ε)` is the same curve everywhere that matters but with a
   *  finite slope at the onset. */
  sideSoften: 0.5,
  /** Time constant of the boom's critically-damped smoothing, seconds.
   *
   *  SECOND ORDER, NOT A LERP, and that is the point. A first-order ease has a
   *  DISCONTINUOUS VELOCITY whenever its target kinks — and the boom's target
   *  kinks constantly: at a piece boundary where road curvature steps, where the
   *  pole guard starts clamping, where the sideways swing engages. A hard rate cap
   *  is worse still, adding a kink every time it saturates and desaturates.
   *  MEASURED with lerp + cap: 21655°/s² of view acceleration through a loop and
   *  2041 m/s² of camera acceleration on a quarterpipe — roughly 200 g. The rig
   *  read as "a bit too brutal", which is exactly what that is.
   *
   *  A critically damped spring is C1 by construction: it cannot step its own
   *  velocity, so no upstream kink can reach the screen as a snap. It also
   *  absorbs everything earlier in the chain, which is why the first-order eases
   *  on boomF/boomU are still fine.
   *
   *  Raise for a lazier, more cinematic camera; lower for a tighter one. Below
   *  ~0.1 s it stops filtering the piece-boundary kinks and the harshness returns. */
  //
  // WHY THIS IS ONE FIXED NUMBER AND NOT ERROR-ADAPTIVE. Stiffening the spring
  // when the error is large is the obvious way to buy smoothness on the straights
  // without lagging through a reversal, and it does work for the lag: it restored
  // the quarterpipe to astern at T = 0.45. But it stiffens precisely where the
  // camera was reported as brutal — the loop and the quarterpipe, which are all
  // large error — and MEASURED it doubled them, view acceleration 692 → 1547°/s²
  // through a loop and 3013 → 5618°/s² on a quarterpipe. Exactly the wrong trade.
  //
  // The ceiling on this number is instead set by keeping the camera ASTERN: at
  // 0.40 the boom lags far enough off a quarterpipe lip that the camera ends up in
  // front of the car (boom·forward +0.10). 0.28 leaves it behind (−0.03) with most
  // of the smoothing won.
  boomSmoothTime: 0.28,
  /** Ceiling on how fast the boom may swing around the car, in °/s. With the
   *  spring this is a true backstop and normally inactive — a loop sweeps about
   *  90°/s. Kept because a spring bounds acceleration, not speed. */
  boomMaxRate: 300,

  // ── LEVELLING ──────────────────────────────────────────────────────────────
  // SAFETY NET ONLY. `poleGuard` keeps the boom's elevation at or under 68°, so
  // the view direction always retains cos(68°) = 0.37 of horizontal content —
  // comfortably above `levelFull`, which means the horizon is taken level and
  // EXACTLY level, every frame, and none of this runs.
  //
  // It exists because the alternative to a guard is a singularity: without one
  // the boom sweeps through vertical inside a loop, where "level" not only
  // vanishes but REVERSES across the pole (looking up-and-back and up-and-forward
  // have opposite level horizons), and taking the answer directly there was a
  // ONE-FRAME 20694°/s snap. If anyone widens `poleGuard` past ~78° this brings
  // that back under control instead of letting it snap.
  levelLerp: 8.0,
  levelFloor: 0.02,
  levelFull: 0.20,

  // ── FOLLOW ─────────────────────────────────────────────────────────────────
  posLerp: 7.0,       // rate any residual anchor error decays at
  /** How much of the car's per-frame displacement the anchor carries across.
   *  1 = the boom is rigid on the smoothed frame: no lag at any speed or
   *  framerate. Below 1 the anchor falls behind under acceleration, which softens
   *  a landing at the cost of the chase distance stretching with speed. */
  follow: 1.0,

  // ── SPEED FOV ──────────────────────────────────────────────────────────────
  fovBase: 60,
  fovAtSpeed: 12,     // extra degrees at fovSpeedRef and above
  fovSpeedRef: 50,    // m/s for the full kick — keep matching TIRE.topSpeed
  fovLerp: 3.0,       // slow: a twitchy FOV reads as nausea

  // ── IMPACT ─────────────────────────────────────────────────────────────────
  // The car lands a 45 m inverted flip and, without this, the camera does not
  // acknowledge it at all. Both effects are PRESENTATION ONLY: they move the
  // view, never the boom, the anchor or anything the physics can see.
  /** Closing speed (m/s) at touchdown below which nothing happens, and the speed
   *  at which the shake is at full strength. The floor matters more than the
   *  ceiling: every kerb, seam and tessellation facet is a small impact, and a
   *  camera that twitches at all of them reads as a fault, not as feedback. */
  shakeFrom: 6,
  shakeFull: 26,
  /** Peak displacement of the CAMERA, in metres.
   *
   *  The camera moves; the shot does not. This is the whole design, and the
   *  first version got it backwards by rotating the VIEW instead — which broke
   *  both of the invariants the rig is built on, in exactly the way
   *  `chaseFramingTest` exists to catch: the car came off its fixed screen
   *  position (off-axis range 1.54°, against a 0.5° bound) and the horizon
   *  tilted 0.22° where every other piece in the kit reads 0.0000°.
   *
   *  Displacing the camera instead is free of both. The shake is applied BEFORE
   *  the view is composed, so `_d` — camera to car — is recomputed from where
   *  the camera actually ended up: the car stays pinned to the same pixel, the
   *  horizon is still taken exactly level off the new position, and what the
   *  player sees moving is the world. Which is what an impact looks like. */
  shakeMetres: 0.13,
  /** Angular frequencies of the shake, rad/s. Low — a heavy knock, not a
   *  rattle — and the angular acceleration this produces at the boom's distance
   *  goes as amplitude x frequency SQUARED, so this is the term that decides
   *  whether the shake stays inside the kit's smoothness bound. */
  shakeHz: [15, 25, 19, 29],
  /** Time constant of the shake's decay, seconds. Short — the impact is over,
   *  and a shake that outlives it stops reading as an impact. */
  shakeDecay: 0.16,
  /** …and its ATTACK, seconds. Not a stylistic choice — the shake's amplitude
   *  multiplies a sine that is at an arbitrary point in its cycle when a new
   *  impact lands, so stepping the amplitude steps the camera's POSITION, and a
   *  position step is an unbounded acceleration.
   *
   *  A landing is not one impact: the wheels touch, the car bounces, and each
   *  bounce past `airGroundLockout` tops the envelope up again. MEASURED, that
   *  turned a 15-29 rad/s shake into something the view read as 83 rad/s —
   *  6336°/s² of view acceleration on top of the jump ramp, against a 1200
   *  bound for the whole kit. It was never the frequencies; it was the steps
   *  between them. */
  shakeAttack: 0.045,
  /** Degrees of FOV thrown on at a launch, and how fast it bleeds off.
   *  It punches instantly and recovers slowly, which is the shape that reads as
   *  the world lurching away from you rather than as the FOV being animated. */
  launchFovKick: 7,
  launchFovDecay: 0.55,
  /** Upward speed (m/s) at the moment the wheels leave, below which it is a
   *  crest or a kerb hop rather than a launch. */
  launchMinRise: 4.5,
  /** …and how long the car must have been ON the ground first, in seconds.
   *
   *  A BOUNCE IS NOT A LAUNCH. Without this, coming down off a 40 m ramp fires
   *  the punch again on every hop out of the landing: MEASURED, the FOV was
   *  still +3.4° of its +6.9° punch three decay constants later, which should
   *  have left 0.3°. It was not a decay bug — it was the same launch firing over
   *  and over. The vehicle draws exactly this distinction for air control
   *  (TIRE.airGroundLockout, "a bounce is not a trick"); this is the same idea
   *  the other way round. */
  launchMinGrounded: 0.3,
};

/**
 * @param {object} o
 * @param {THREE.Camera} o.camera
 * @param {{body:{pos:THREE.Vector3, vel:THREE.Vector3, quat:THREE.Quaternion}, groundedCount:number}} o.vehicle
 * @param {object|null} [o.orbit] OrbitControls, used when `isOrbit()` is true
 * @param {() => boolean} [o.isOrbit] free-look override (build mode / debug)
 */
export function createChaseCamera({ camera, vehicle, orbit = null, isOrbit = () => false, params = {} }) {
  const CAM = { ...CHASE_CAM, ...params };
  if (camera.isPerspectiveCamera && params.fovBase == null) CAM.fovBase = camera.fov;

  const _boomF = new THREE.Vector3(0, 0, 1);  // boom forward (unit)
  /** Loop-back: the horizontal direction the car entered the curl on, latched
   *  for the climb, and how far through the camera's pivot we are (0 = the
   *  car's own frame, 1 = level behind the return). See the pivot at the use
   *  site. `_wallLatched` stays true into the flight, where the boom freezes. */
  const _wallFwd = new THREE.Vector3(0, 0, -1);
  const _wallSide = new THREE.Vector3(1, 0, 0);
  let _wallLatched = false;
  let _wallT = 0;

  const _boomU = new THREE.Vector3(0, 1, 0);  // boom up — the road's normal
  const _anchor = new THREE.Vector3();
  const _prevPos = new THREE.Vector3();
  const _delta = new THREE.Vector3();
  const _dirTgt = new THREE.Vector3();
  const _upTgt = new THREE.Vector3();
  const _carFwd = new THREE.Vector3();
  const _carUp = new THREE.Vector3();
  const _worldUp = new THREE.Vector3(0, 1, 0);
  const _axis = new THREE.Vector3();
  const _lat = new THREE.Vector3();            // loop axis — the side to swing to
  const _boom = new THREE.Vector3();           // raw road-frame boom
  const _boomDir = new THREE.Vector3(0, 0, 1); // actual boom direction (unit)
  let _az = 0, _el = 0, _azTgt = 0;            // the boom, as angles
  const _vel = [0, 0];                         // their spring velocities
  let _initBoom = false;
  const _d = new THREE.Vector3();             // camera → car
  const _right = new THREE.Vector3(1, 0, 0);  // persistent, eased toward level
  const _rightTgt = new THREE.Vector3();

  const _shkA = new THREE.Vector3();   // the two axes the shake swings across
  const _shkB = new THREE.Vector3();
  const _upD = new THREE.Vector3();
  const _view = new THREE.Vector3();
  const _camUp = new THREE.Vector3();
  const _look = new THREE.Vector3();
  let _air = 0;
  let _init = false;
  let _snap = false;
  /** Impact FX. `_shake` is 0-1 of energy, `_shakeT` its own clock so the
   *  waveform does not restart (and click) when a second impact lands on top of
   *  a decaying one. `_fovSmooth` is the speed FOV, kept separate so a kick can
   *  be added to it without being dragged through `fovLerp`. */
  let _shake = 0, _shakeTgt = 0, _shakeT = 0, _fovKick = 0, _fovSmooth = null;
  let _wasGrounded = true, _groundFor = 0;

  const D2R = Math.PI / 180;

  /**
   * Rotate unit `cur` toward unit `tgt` by fraction `k` of the angle between.
   *
   * A plain lerp is wrong and the failure is not subtle: easing an inverted boom
   * back toward world up lerps a vector toward its own negation, which passes
   * through zero and normalises to garbage.
   */
  function easeDir(cur, tgt, k) {
    const dot = THREE.MathUtils.clamp(cur.dot(tgt), -1, 1);
    if (dot > 0.999999) { cur.copy(tgt); return; }
    _axis.crossVectors(cur, tgt);
    if (_axis.lengthSq() < 1e-12) {
      _axis.set(1, 0, 0).cross(cur);
      if (_axis.lengthSq() < 1e-6) _axis.set(0, 0, 1).cross(cur);
    }
    _axis.normalize();
    cur.applyAxisAngle(_axis, Math.acos(dot) * k).normalize();
  }

  /**
   * Critically damped smoothing (the classic SmoothDamp). Returns the new value
   * and writes the new velocity back into `v[i]`.
   *
   * Critically damped means no overshoot and no ringing, and — the reason it is
   * here rather than a lerp — the output's VELOCITY is continuous. A lerp's is
   * not: step its target and the output's speed steps with it, which is a
   * discontinuity in acceleration and reads on screen as a snap.
   */
  function smoothDamp(cur, tgt, v, i, T, dt, maxSpeed) {
    const omega = 2 / Math.max(1e-4, T);
    const x = omega * dt;
    const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
    let change = cur - tgt;
    const maxChange = maxSpeed * Math.max(1e-4, T);
    change = THREE.MathUtils.clamp(change, -maxChange, maxChange);
    const temp = (v[i] + omega * change) * dt;
    v[i] = (v[i] - omega * temp) * exp;
    return (cur - change) + (change + temp) * exp;
  }

  function applyFov(target, dt, snap, kick = 0) {
    if (!camera.isPerspectiveCamera) return;
    // The SPEED fov is smoothed; the kick is not. Lerping `camera.fov` itself
    // toward `target + kick` would drag the punch through `fovLerp`, which is
    // deliberately slow (3.0) because a twitchy speed-FOV reads as nausea — and
    // a punch smeared over a third of a second is not a punch. So the smoothed
    // base is carried separately and the kick is simply added on top of it.
    if (_fovSmooth === null || snap) _fovSmooth = target;
    else _fovSmooth += (target - _fovSmooth) * (1 - Math.exp(-CAM.fovLerp * dt));
    const next = _fovSmooth + kick;
    if (Math.abs(next - camera.fov) < 1e-3) return;
    camera.fov = next;
    camera.updateProjectionMatrix();
  }

  /** Snap the rig onto the car — call on respawn so it doesn't sweep the map. */
  function reset() {
    _init = false;
    _air = 0;
    _snap = true;
    _shake = 0;
    _shakeTgt = 0;
    _fovKick = 0;
    _wasGrounded = true;
    _groundFor = 0;
    if (vehicle) vehicle.landImpact = 0;
  }

  function update(dt) {
    if (isOrbit()) {
      // Orbit modes (build / free-look) are owned by the ENGINE's OrbitControls.
      // The chase must not also drive the camera — doing both makes them fight.
      if (camera.up.x !== 0 || camera.up.z !== 0) camera.up.set(0, 1, 0);
      applyFov(CAM.fovBase, dt, false);
      _init = false;
      return;
    }

    const snap = _snap;
    _snap = false;

    // Follow the INTERPOLATED render pose (what the mesh is drawn at), not
    // body.pos — the body steps at FIXED_DT while the mesh interpolates per
    // frame, so following body.pos makes the car jitter in frame.
    const pos = vehicle.renderPos ?? vehicle.body.pos;
    const rquat = vehicle.renderQuat ?? vehicle.body.quat;
    const v = vehicle.body.vel;
    const speed = v.length();
    const grounded = vehicle.groundedCount > 0;
    _air = grounded ? 0 : _air + dt;

    // ── IMPACT FX ────────────────────────────────────────────────────────────
    // Read and CLEAR the vehicle's one-shot landing report. Taking the max
    // rather than overwriting means a second impact inside a decaying first one
    // tops the shake up instead of cutting it short.
    const hit = vehicle.landImpact ?? 0;
    if (hit > 0) {
      vehicle.landImpact = 0;
      _shakeTgt = Math.max(_shakeTgt,
        THREE.MathUtils.smoothstep(hit, CAM.shakeFrom, CAM.shakeFull));
    }
    // The launch: the edge where the wheels leave with real upward speed, having
    // actually been on the ground first. See CAM.launchMinGrounded.
    if (_wasGrounded && !grounded && v.y > CAM.launchMinRise
      && _groundFor > CAM.launchMinGrounded) _fovKick = 1;
    _groundFor = grounded ? _groundFor + dt : 0;
    _wasGrounded = grounded;
    if (snap) { _shake = 0; _shakeTgt = 0; _fovKick = 0; }
    // The envelope decays; the AMPLITUDE follows it through an attack, so no
    // impact — first or fifth — can step the camera. See CAM.shakeAttack.
    _shakeTgt *= Math.exp(-dt / CAM.shakeDecay);
    _shake += (_shakeTgt - _shake) * (1 - Math.exp(-dt / CAM.shakeAttack));
    _fovKick *= Math.exp(-dt / CAM.launchFovDecay);
    _shakeT += dt;

    // Total speed, not horizontal, so a near-vertical drop reads as fast too.
    applyFov(
      CAM.fovBase + CAM.fovAtSpeed * Math.min(1, speed / Math.max(1, CAM.fovSpeedRef)),
      dt, snap, CAM.launchFovKick * _fovKick,
    );

    _carFwd.set(0, 0, 1).applyQuaternion(rquat);
    _carUp.set(0, 1, 0).applyQuaternion(rquat);

    // ── 1. BOOM FORWARD — the travel direction, so a drift shows the car
    // sideways in frame rather than hiding it behind the camera. ──────────────
    const reversing = grounded && v.dot(_carFwd) < -0.5;
    if (speed > CAM.minSpeed && !reversing) _dirTgt.copy(v).multiplyScalar(1 / speed);
    else _dirTgt.copy(_carFwd);

    // ── THE LOOP-BACK: RIDE THE CAR'S OWN FRAME UP THE WALL, THEN FREEZE ────
    // Three reference frames from the game this copies, in order: on the wall
    // the camera is out from the wall face looking at the ROOF, nose up the
    // screen; at the top it is BELOW and behind the car, looking up at it
    // against the sky; in the air it holds that, so the car flies away inverted
    // with its underside and tail to the camera. All three are one rule: the
    // boom is aligned to the car's own forward and up — the surface normal —
    // the whole way up the curl (as the wall goes past vertical the car's "up"
    // swings to point down and back, which is what carries the camera round
    // underneath), and at the exit that orientation is simply held until the
    // wheels touch. No levelling, no orbit, nothing computed from velocity:
    // the earlier version of this did both and the camera was still moving
    // on the way down to the deck, which is the one moment it must not.
    //
    // `_holdContact` is a road-held contact and grades top out at 14°, so the
    // nose test picks out the loop-back and nothing else; `_flipHold` is the
    // vehicle's own "carrying a curl's rotation" flag, 1 for exactly this
    // flight. Ordinary jumps, loops and bowls frame as they always have.
    // 0.35 is a nose of 20.5°, not the 30° it used to be. The pivot cannot start
    // before this gate opens, and at 30° it had only ~0.4 s of climb left to
    // sweep its first 90° in — which is most of why the shot felt hurried. The
    // kit's ordinary grades top out at 14°, so there is still clear air between
    // this and any road the car merely drives up.
    const onWall = grounded && !!vehicle._holdContact && _carFwd.y > 0.35;
    const flipAir = !grounded && (vehicle._flipHold ?? 0) > 0;
    if (onWall) {
      if (!_wallLatched) {
        // The direction the car went IN, latched once: its horizontal part
        // flips sign as the nose passes vertical and cannot be re-read after.
        const h = Math.hypot(v.x, v.z);
        if (h > 1) _wallFwd.set(v.x / h, 0, v.z / h);
        else _wallFwd.copy(_boomF).setY(0).normalize();
        _wallLatched = true;
      }
      // ONE PIVOT, DRIVEN BY THE NOSE, HELD AT THE SIDE, FINISHED BY THE TOP.
      //
      // Three points fix it, all in degrees of nose angle, all of them things
      // the shot has to show:
      //   t=0,   nose 20°  — the boom is the CAR'S OWN frame, so on a wall that
      //                      is out from the face looking down at the ROOF.
      //   t=0.5, nose 70°  — square onto the SIDE of the car. This is the
      //                      ramp's straight-face angle, and that is the point:
      //                      see below.
      //   t=1,   nose 110° — level, on the far side, behind the RETURN
      //                      direction, so an inverted car reads as horizontal
      //                      and upside down (its underside toward the camera).
      // That is 180° of relative rotation, which is why locking the boom to the
      // car's frame could never produce it: that keeps the same face of the car
      // pointed at you forever. And it is spent on the CLIMB, so by the time the
      // wheels leave, the shot is composed and the flight holds it — the camera
      // must not still be hunting on the way down to the deck.
      //
      // THE HOLD IS THE RAMP'S, NOT THE CAMERA'S. Hinging the halfway point on
      // the face angle means the dwell costs nothing to compute and cannot drift
      // out of sync: along the straight face the nose angle is CONSTANT, so
      // `noseDeg` stops, so the pivot stops, for exactly as long as the car is
      // on the face. Lengthen `loopbackStraight` and the camera holds the side
      // view for longer, at any entry speed, with no timer anywhere.
      //
      // Each half is smoothstepped rather than linear, so the sweep eases INTO
      // the hold and back OUT of it instead of stopping and starting square.
      //
      // AND THE PIVOT ONLY EVER GOES FORWARD. The nose does not rise all the way
      // to the lip and stay there — MEASURED, it peaks around 85° and then falls
      // back through 75°, 65°, 56° as the car comes off the curl and the chassis
      // pitches down under it. Read as a plain function of the nose, the shot
      // would UNWIND over those last few tenths and then freeze half-built. So
      // the nose proposes and a ratchet disposes: once the camera has swept
      // somewhere, it stays there until the wheels are back on the ground.
      // `pivotToDeg` is set to that measured peak rather than to the ramp's lip
      // angle, since a target the car never reaches is a pivot that never ends.
      const noseDeg = Math.atan2(_carFwd.y, _carFwd.dot(_wallFwd)) / D2R;
      const want = noseDeg < CAM.pivotSideDeg
        ? 0.5 * THREE.MathUtils.smoothstep(noseDeg, CAM.pivotFromDeg, CAM.pivotSideDeg)
        : 0.5 + 0.5 * THREE.MathUtils.smoothstep(noseDeg, CAM.pivotSideDeg, CAM.pivotToDeg);
      // …and it comes to REST rather than stopping, see CAM.pivotArrive. The
      // floor keeps it from crawling the last hundredth forever.
      // Measured against the END of the sweep, not against the current target.
      // Against the target it also decelerates onto the DWELL — and then creeps
      // through the straight face at a tenth of the rate instead of resting on
      // it, which cost the whole hold (0.20 s -> 0.00 s). Arriving at 0.5 needs
      // no help: `want` is a smoothstep, so it eases itself in. Only the finish
      // is cap-governed, and only the finish stops dead.
      // …and it comes to REST rather than stopping — see CAM.pivotArrive. The
      // floor keeps it from crawling the last hundredth forever.
      const arrive = Math.max(0.12, THREE.MathUtils.smoothstep(1 - _wallT, 0, CAM.pivotArrive));
      _wallT = Math.max(_wallT, Math.min(want, _wallT + CAM.pivotRate * arrive * dt));
      // Swept round a chosen SIDE rather than blended straight through: both
      // ends of the pivot lie in the vertical plane through the entry
      // direction, so a plain blend has no side to prefer and the azimuth picks
      // one on rounding. See CAM.flipPivotSide.
      const th = _wallT * Math.PI;
      _wallSide.crossVectors(_worldUp, _wallFwd).normalize().multiplyScalar(CAM.flipPivotSide);
      _dirTgt.copy(_wallFwd).multiplyScalar(Math.cos(th)).addScaledVector(_wallSide, Math.sin(th));
      if (_dirTgt.lengthSq() < 1e-6) _dirTgt.copy(_carFwd);
      _dirTgt.normalize();
    } else if (flipAir && _wallLatched) {
      _dirTgt.copy(_boomF);    // FROZEN: the composed shot, held to touchdown
    } else {
      _wallLatched = false;
      _wallT = 0;
    }
    const flipFlat = onWall || (flipAir && _wallLatched);

    // ── 2. BOOM UP — the road's normal while grounded, world up in the air. ──
    // …except through the loop-back, where it pivots with the boom and is then
    // frozen — see above.
    if (onWall) {
      _upTgt.copy(_carUp).multiplyScalar(1 - _wallT).addScaledVector(_worldUp, _wallT);
      if (_upTgt.lengthSq() < 1e-6) _upTgt.copy(_worldUp);
      _upTgt.normalize();
    } else if (flipFlat) _upTgt.copy(_boomU);
    else _upTgt.copy(grounded ? _carUp : _worldUp);

    if (!_init) {
      _boomF.copy(_dirTgt);
      _boomU.copy(_upTgt);
      _anchor.copy(pos);
      _prevPos.copy(pos);
      _init = true;
    }

    // See CAM.flipHeadingLerp: through the pivot the target is already smooth
    // and rate-limited, so the follow is tightened to let it through intact.
    //
    // EASED IN, though, over the first fifth of the sweep. The pivot's frame is
    // the HORIZONTAL direction the car entered on, while the boom arrives
    // pointing up the slope the car is climbing, so the target steps by the
    // slope angle on the single frame the pivot engages. At the normal follow
    // rate that step was invisible; snapped at the tight one it was the whole
    // camera's worst moment — MEASURED 11271°/s² of view acceleration, all of it
    // on that first frame, against 1200 for the entire rest of the kit. Nothing
    // is lost by taking it slowly: at t≈0 the pivot has barely left the shot the
    // camera was already holding.
    const headRate = onWall
      ? THREE.MathUtils.lerp(CAM.headingLerp, CAM.flipHeadingLerp,
        THREE.MathUtils.smoothstep(_wallT, 0, 0.2))
      : CAM.headingLerp;
    easeDir(_boomF, _dirTgt, snap ? 1 : 1 - Math.exp(-headRate * dt));
    const upRate = flipFlat && !grounded ? 0
      : grounded ? CAM.upLerp : (_air < CAM.airHold ? 0 : CAM.airUpLerp);
    if (upRate > 0) easeDir(_boomU, _upTgt, snap ? 1 : 1 - Math.exp(-upRate * dt));

    // Keep the boom a frame: `up` must stay perpendicular to the forward.
    _boomU.addScaledVector(_boomF, -_boomU.dot(_boomF));
    if (_boomU.lengthSq() < 1e-6) {
      _boomU.copy(_worldUp).addScaledVector(_boomF, -_worldUp.dot(_boomF));
      if (_boomU.lengthSq() < 1e-6) _boomU.set(1, 0, 0).cross(_boomF);
    }
    _boomU.normalize();

    // ── 3. ANCHOR ─────────────────────────────────────────────────────────────
    // Carry the car's per-frame DISPLACEMENT across, then let any residual error
    // decay. A plain exponential follow lags a target moving at constant v by
    // v/posLerp — at 48 m/s that is ~7 m added straight onto `dist`.
    //
    // The obvious cure — feed the velocity forward — is a trap, and the original
    // rig fell into it: `vel/posLerp` is a POSITION offset proportional to
    // velocity, so any impulsive change in velocity teleports the camera.
    // MEASURED at the touchdown frame of a loop exit, with the car's own position
    // perfectly continuous: the camera jumped 2.06 m in ONE STEP (248 m/s).
    // A displacement cannot do that, and it cancels the lag at every speed AND
    // every framerate rather than only the one a constant was tuned for.
    _delta.copy(pos).sub(_prevPos);
    _prevPos.copy(pos);
    _anchor.addScaledVector(_delta, CAM.follow);
    const kp = snap ? 1 : 1 - Math.exp(-CAM.posLerp * dt);
    _anchor.lerp(pos, kp);

    // ── 4. THE BOOM, CARRIED AS AZIMUTH + ELEVATION ──────────────────────────
    //
    // The boom is assembled from the road frame, but it is STORED and
    // interpolated as two angles rather than as a vector, and that is what keeps
    // it off the pole.
    //
    // Interpolating the vector cannot: two booms at the same steep latitude on
    // opposite meridians — which is exactly what a loop produces, since it
    // reverses the travel heading — have a SHORTEST GREAT CIRCLE between them
    // that runs straight over the pole. So a rate limiter faithfully walks the
    // camera through vertical, the horizon loses its definition there, and the
    // view snaps. MEASURED 17971°/s in one step, with the boom's own elevation
    // sweeping smoothly through −88.7° on the way. Clamping the endpoints does
    // not help, because it is the PATH that crosses the pole, not the ends.
    //
    // In angle space the pole is simply unreachable: elevation is clamped, and
    // azimuth wraps the short way round a circle of constant latitude. The
    // horizon therefore always has at least cos(poleGuard) of horizontal content
    // to lock onto, which is why `camera.up` can be taken exactly level below.
    // More "up" than usual through the loop-back: on a vertical wall the up is
    // OUT from the wall face, and that is what turns "behind the car" into
    // "looking at its roof" (reference frame 1).
    const hMul = flipFlat ? 1 + (CAM.wallHeightMul - 1) * (1 - _wallT) : 1;
    _boom.set(0, 0, 0)
      .addScaledVector(_boomF, -CAM.dist)
      .addScaledVector(_boomU, CAM.height * hMul);

    // ── SWING ROUND THE SIDE. ────────────────────────────────────────────────
    //
    // A loop reverses the travel heading, so a camera that stays behind the car
    // must get its azimuth from 0° to 180°. Traced analytically on a loop entered
    // heading −Z, the boom is (0, −7.5 sin φ + 3.2 cos φ, 7.5 cos φ + 3.2 sin φ):
    // its horizontal part vanishes at φ = 113°, where it points STRAIGHT DOWN.
    // That is the pole, and it sits right in the middle of the path.
    //
    // Suppressing the flip — holding the azimuth at the entry heading — avoids it
    // but leaves the camera AHEAD of the car over the top, showing the nose
    // instead of the tail. Reported, and correct: a chase camera should show the
    // back of the car.
    //
    // So go round the SIDE instead. `_lat` is the loop's own axis (perpendicular
    // to the plane the boom swings in, so it is constant through the loop), and
    // pushing along it makes the boom's horizontal part unable to vanish. The
    // azimuth then travels 0° → 90° → 180° through the side, continuously, with
    // the camera behind the car the whole way.
    //
    // The amount is not a taste knob: `_lat ⊥ _boom`, so |boom + s·lat|² =
    // |boom|² + s², and requiring elevation ≤ poleGuard gives
    //     s = √( boom.y² / sin²(guard) − |boom|² )
    // which is ZERO whenever the boom is already shallow enough — flat road, and
    // the loop's apex — and peaks at 3.3 m exactly where it would otherwise go
    // vertical. The swing pays for itself only where it is needed.
    _lat.crossVectors(_boomU, _boomF);
    if (_lat.lengthSq() < 1e-8) _lat.set(1, 0, 0); else _lat.normalize();
    const bl2 = _boom.lengthSq();
    const sg = Math.sin(CAM.poleGuard * D2R);
    const need = (_boom.y * _boom.y) / (sg * sg) - bl2;
    if (need > 0) {
      // Softened onset — see `sideSoften`.
      const e = CAM.sideSoften;
      _boom.addScaledVector(_lat, (Math.sqrt(need + e) - Math.sqrt(e)) * CAM.sideScale);
    }

    const bLen = _boom.length() || 1;
    // The clamp is now only a backstop: the swing above already satisfies it,
    // exactly, whenever `_lat` is horizontal. It still earns its place for the
    // cases where `_lat` is not — a banked entry, a corkscrew — because there the
    // closed form above is an approximation rather than a guarantee.
    const lim = CAM.poleGuard * D2R;
    const elTgt = THREE.MathUtils.clamp(
      Math.asin(THREE.MathUtils.clamp(_boom.y / bLen, -1, 1)), -lim, lim);
    // Held only when there is genuinely nothing to read, which the swing makes
    // very nearly impossible: it keeps at least cos(68°) = 0.37 of the boom
    // horizontal.
    const bh = Math.hypot(_boom.x, _boom.z);
    if (bh > 0.08 * bLen) _azTgt = Math.atan2(_boom.x, _boom.z);

    if (!_initBoom || snap) {
      _az = _azTgt; _el = elTgt; _vel[0] = 0; _vel[1] = 0; _initBoom = true;
    } else {
      const cap = CAM.boomMaxRate * D2R;
      // Unwrap the target onto the branch nearest the current angle, so the
      // spring always takes the short way round.
      let dAz = _azTgt - _az;
      while (dAz > Math.PI) dAz -= 2 * Math.PI;
      while (dAz < -Math.PI) dAz += 2 * Math.PI;
      // See CAM.flipSmoothTime. Changing a smoothDamp's time constant is safe
      // mid-flight: position and velocity are carried in `_vel`/`_az` and stay
      // continuous, only the stiffness steps.
      const smoothT = flipFlat ? CAM.flipSmoothTime : CAM.boomSmoothTime;
      _az = smoothDamp(_az, _az + dAz, _vel, 0, smoothT, dt, cap);
      _el = smoothDamp(_el, elTgt, _vel, 1, smoothT, dt, cap);
    }

    const ce = Math.cos(_el);
    _boomDir.set(Math.sin(_az) * ce, Math.sin(_el), Math.cos(_az) * ce);
    camera.position.copy(_anchor).addScaledVector(_boomDir, Math.hypot(CAM.dist, CAM.height));

    // ── THE SHAKE ────────────────────────────────────────────────────────────
    // Here, and not below: everything downstream derives from `camera.position`,
    // so displacing it now means the aim, the horizon and the framing are all
    // recomputed from the shaken vantage point rather than being disturbed after
    // the fact. The car does not move on screen at all — see CAM.shakeMetres.
    //
    // Swung across the two axes perpendicular to the boom, with two
    // incommensurate frequencies each and different phases, so it reads as a
    // knock rather than as a sine wave and never degenerates into a diagonal.
    if (_shake > 1e-4) {
      const a = CAM.shakeMetres * _shake;
      const [f1, f2, f3, f4] = CAM.shakeHz;
      _shkA.set(0, 1, 0).cross(_boomDir);
      if (_shkA.lengthSq() < 1e-6) _shkA.set(1, 0, 0).cross(_boomDir);
      _shkA.normalize();
      _shkB.crossVectors(_boomDir, _shkA).normalize();
      camera.position
        .addScaledVector(_shkA,
          a * (Math.sin(_shakeT * f1) * 0.6 + Math.sin(_shakeT * f2 + 1.3) * 0.4))
        .addScaledVector(_shkB,
          a * (Math.sin(_shakeT * f3 + 1.7) * 0.6 + Math.sin(_shakeT * f4 + 0.4) * 0.4));
    }

    // ── 4. VIEW — aim AT the car, then tilt the axis up by φ. Independent of
    // the boom, which is what pins the car and frees the boom. ────────────────
    _d.copy(_anchor).sub(camera.position);
    const dLen = _d.length();
    if (dLen < 1e-5) return; // degenerate boom; leave the camera as it was
    _d.multiplyScalar(1 / dLen);

    // `d × worldUp` is horizontal for ANY d, so a right axis taken from it makes
    // the horizon exactly level — the camera cannot roll. Its LENGTH is how much
    // horizontal content the view has, i.e. how trustworthy "level" currently is:
    // it goes to zero looking straight up, which is the one case that has to be
    // eased through rather than obeyed. See `levelLerp`.
    _rightTgt.crossVectors(_d, _worldUp);
    const hMag = _rightTgt.length();
    if (hMag > 1e-5) {
      _rightTgt.multiplyScalar(1 / hMag);
      const conf = snap ? 1 : THREE.MathUtils.smoothstep(hMag, CAM.levelFloor, CAM.levelFull);
      // NORMAL PATH, and with the pole guard in place it is the only one that
      // ever runs: take the level answer outright. Easing toward it instead is
      // pure lag — it costs a constant roll wherever the view is turning, which
      // MEASURED 2.8° on an ordinary corner and 25° through a loop, for no
      // benefit at all now that the guard means the pole is never reached.
      if (conf >= 1) _right.copy(_rightTgt);
      else if (conf > 0) easeDir(_right, _rightTgt, 1 - Math.exp(-CAM.levelLerp * conf * dt));
    }
    // Carry it across the pole and keep it a valid axis.
    _right.addScaledVector(_d, -_right.dot(_d));
    if (_right.lengthSq() < 1e-6) {
      _right.set(1, 0, 0).cross(_d);
      if (_right.lengthSq() < 1e-6) _right.set(0, 0, 1).cross(_d);
    }
    _right.normalize();

    const phi = CAM.carBelowCentre * D2R;
    _upD.crossVectors(_right, _d);
    _view.copy(_d).multiplyScalar(Math.cos(phi)).addScaledVector(_upD, Math.sin(phi));
    _camUp.crossVectors(_right, _view).normalize();

    camera.up.copy(_camUp);
    _look.copy(camera.position).add(_view);
    camera.lookAt(_look);
  }

  /** Live state, for tests and debug overlays. */
  const state = {
    boomF: _boomF,
    boomU: _boomU,
    boomDir: _boomDir,
    lat: _lat,
    right: _right,
    get air() { return _air; },
    get az() { return _az; },
    get el() { return _el; },
    /** Where the car sits relative to the view axis, in degrees (negative =
     *  below centre). Exact — the rig places it there by construction. */
    get framingDeg() { return -CAM.carBelowCentre; },
    /** Impact FX, 0-1 each: the shake's live amplitude and the launch punch. */
    get shake() { return _shake; },
    get fovKick() { return _fovKick; },
  };

  return { update, reset, params: CAM, state };
}
