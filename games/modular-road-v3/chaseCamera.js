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

  const _upD = new THREE.Vector3();
  const _view = new THREE.Vector3();
  const _camUp = new THREE.Vector3();
  const _look = new THREE.Vector3();
  let _air = 0;
  let _init = false;
  let _snap = false;

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

  function applyFov(target, dt, snap) {
    if (!camera.isPerspectiveCamera) return;
    const k = snap ? 1 : 1 - Math.exp(-CAM.fovLerp * dt);
    const next = camera.fov + (target - camera.fov) * k;
    if (Math.abs(next - camera.fov) < 1e-3) return;
    camera.fov = next;
    camera.updateProjectionMatrix();
  }

  /** Snap the rig onto the car — call on respawn so it doesn't sweep the map. */
  function reset() {
    _init = false;
    _air = 0;
    _snap = true;
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

    // Total speed, not horizontal, so a near-vertical drop reads as fast too.
    applyFov(
      CAM.fovBase + CAM.fovAtSpeed * Math.min(1, speed / Math.max(1, CAM.fovSpeedRef)),
      dt, snap,
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
    const onWall = grounded && !!vehicle._holdContact && _carFwd.y > 0.5;
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
      // ONE PIVOT, DRIVEN BY THE NOSE, FINISHED BY THE TOP.
      //
      // Both ends of it are fixed by what the shot has to show:
      //   t=0, nose 30°  — the boom is the CAR'S OWN frame, so on a wall that
      //                    is out from the face looking down at the ROOF.
      //   t=1, nose 110° — level, on the far side, behind the RETURN direction,
      //                    so an inverted car reads as horizontal and upside
      //                    down (its underside toward the camera).
      // Between them the camera sweeps the side view. That is 180° of relative
      // rotation, which is why locking the boom to the car's frame could never
      // produce it: that keeps the same face of the car pointed at you forever.
      // And it is spent on the CLIMB, so by the time the wheels leave the shot
      // is composed and the flight holds it — the camera must not still be
      // hunting on the way down to the deck.
      const noseDeg = Math.atan2(_carFwd.y, _carFwd.dot(_wallFwd)) / D2R;
      _wallT = THREE.MathUtils.clamp((noseDeg - 20) / 45, 0, 1);
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

    easeDir(_boomF, _dirTgt, snap ? 1 : 1 - Math.exp(-CAM.headingLerp * dt));
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
      _az = smoothDamp(_az, _az + dAz, _vel, 0, CAM.boomSmoothTime, dt, cap);
      _el = smoothDamp(_el, elTgt, _vel, 1, CAM.boomSmoothTime, dt, cap);
    }

    const ce = Math.cos(_el);
    _boomDir.set(Math.sin(_az) * ce, Math.sin(_el), Math.cos(_az) * ce);
    camera.position.copy(_anchor).addScaledVector(_boomDir, Math.hypot(CAM.dist, CAM.height));

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
  };

  return { update, reset, params: CAM, state };
}
