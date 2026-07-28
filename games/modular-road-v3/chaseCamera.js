import * as THREE from "three";

/**
 * Chase camera — ported verbatim from modular-road.html's updateChaseCamera.
 *
 * The camera trails the car's *travel direction* (from velocity), NOT the car's
 * orientation, so mid-air spins/rolls don't whip the view around; the look tilts
 * up when climbing / down when falling so you can see the landing.
 *
 * The part v3's stuntCarMode camera does NOT have, and the reason this one is
 * ported instead: LOOP-FOLLOW. On a banked or looping surface the rig blends
 * into the car's own frame so the view rolls with the car through a vertical
 * loop. A stunt track is mostly loops, so that behaviour is the point.
 */
export const CHASE_CAM = {
  dist: 7.5,          // trail distance behind the heading
  height: 3.2,        // height above the car
  lookAhead: 5.5,     // how far ahead (along travel) to aim
  lookUp: 1.2,        // raise the look target a touch
  minSpeed: 3.0,      // below this, fall back to the car's facing
  maxLookPitch: 0.85, // clamp so we never look fully straight up/down
  headingLerp: 4.0,   // how fast the trailing heading reorients
  lookLerp: 5.0,      // how fast the look direction tracks velocity
  posLerp: 7.0,       // camera position smoothing
  /** Cancels the follow lag that otherwise grows the chase distance with speed.
   *  1 = hold CAM.dist at every speed, 0 = the old behaviour (drifts to ~14 m
   *  at top speed). See the derivation at the use site. */
  lagCompensate: 1.0,
  // Loop-follow blend, ramped by how far the car's up-axis tilts from world up.
  //
  // ONLY ONCE THE CAR IS ACTUALLY PAST VERTICAL. Tilt alone cannot tell a loop
  // from a steep ramp — both lay the car over by the same angle — so an early,
  // wide ramp (the previous 0.98 → 0.0, engaging from ~11° of tilt) committed to
  // loop behaviour on any steep climb. MEASURED driving a near-vertical quarter
  // pipe on the old values:
  //     car tilt 30°  blend 12%    70°  blend 65%    85°  blend 91%
  // and at 73° the camera had rolled into the ramp's plane — camera.up.y 0.988
  // → 0.643, and the view elevation swung −24° (above the car, looking down) to
  // +17° (below it, looking up). A near-vertical wall then renders as flat grey
  // ground: the steeper the ramp, the harder the rig worked to make it look
  // level, which is exactly backwards.
  //
  // A LOOP inverts and a ramp never does, so that — not tilt — is the thing
  // worth keying on. The blend now sits at 0 for every upright attitude, however
  // steep, and ramps in across the inverted half where the camera genuinely has
  // to follow the car round. Loop entry is less rolled than it used to be; that
  // is the deliberate trade for ramps reading as steep.
  loopStart: 0.0,     // carUp.y where loop-follow begins — the car is VERTICAL
  loopFull: -1.0,     // fully committed only when fully INVERTED (180°)
  /**
   * How fast the blend eases toward its tilt-based target.
   *
   * RAISED WITH THE NARROWER ENGAGE RANGE. The blend used to have the whole
   * climb (11°→90°) to ease in; it now has only the inverted half, which a car
   * clears in well under a second, so at the old 5/s it lagged so far behind
   * that the camera never rolled — measured camera.up.y bottoming at −0.09 at
   * the apex where the old rig reached −0.99, i.e. the loop barely read as a
   * loop any more. Tracking the target closely is what restores it.
   *
   * Safe to be this quick only because the position blend now swings on an ARC
   * (see the use site); on a chord a blend this fast threw the camera at the car.
   */
  loopLerp: 12.0,
  /** Grace period (s) after the wheels leave before the blend starts unwinding.
   *  Without it the blend collapsed the instant `grounded` went false, so
   *  launching off a lip unwound the whole rig mid-flight — measured as ~65% of
   *  blend released over about a second, right at the moment of the jump. A
   *  crest hop or the lip of a loop is shorter than this and now changes
   *  nothing. */
  loopAirHold: 0.35,
  /** Rate the blend eases to 0 once airborne past `loopAirHold`. Deliberately
   *  far slower than `loopLerp`: the car's tilt in the air is trick input, not
   *  surface following, so the rig should let go gently rather than track it. */
  loopAirLerp: 1.2,
  upLerp: 5.0,        // how fast camera.up eases (the roll)
  // ── SPEED FOV ──────────────────────────────────────────────────────────────
  // The engine's camera FOV (60° vertical ≈ 91° horizontal at 16:9) is a fine
  // value, but it was inherited from the v3 editor and it is STATIC — and a
  // static FOV is why a racing game stops feeling fast. Widening with speed is
  // the cheapest possible speed cue.
  //
  // `fovBase` is overwritten at construction from the camera's actual FOV, so it
  // can't silently drift out of sync with v3/app/main.js.
  fovBase: 60,
  fovAtSpeed: 12,     // extra degrees at fovSpeedRef and above
  fovSpeedRef: 50,    // m/s for the full kick — keep matching TIRE.topSpeed
  fovLerp: 3.0,       // how fast FOV eases (slow: a twitchy FOV reads as nausea)
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
  // Anchor the FOV kick to whatever the engine actually authored (unless a
  // caller pinned it explicitly), so this can never drift from main.js.
  if (camera.isPerspectiveCamera && params.fovBase == null) CAM.fovBase = camera.fov;

  const _camHeading = new THREE.Vector3(0, 0, 1); // horizontal trail heading
  const _camLookDir = new THREE.Vector3(0, 0, 1); // 3D look direction
  const _camDesired = new THREE.Vector3();
  const _camLook = new THREE.Vector3();
  const _camV = new THREE.Vector3();
  const _camFwd = new THREE.Vector3();
  const _camTgtH = new THREE.Vector3();
  const _worldUp = new THREE.Vector3(0, 1, 0);
  const _carUp = new THREE.Vector3();             // car's own up-axis (loop-follow)
  const _camUp = new THREE.Vector3(0, 1, 0);      // smoothed (persistent) camera up
  const _upTgt = new THREE.Vector3(0, 1, 0);      // this frame's desired up
  const _camDir = new THREE.Vector3();            // current view direction
  const _camOff = new THREE.Vector3();            // car → camera offset, for the arc
  const _wDesired = new THREE.Vector3();          // world-frame camera position
  const _cDesired = new THREE.Vector3();          // car-frame camera position
  const _wLook = new THREE.Vector3();             // world-frame look target
  const _cLook = new THREE.Vector3();             // car-frame look target
  let _camLoop = 0;                               // smoothed 0..1 loop-follow blend
  let _loopAir = 0;                               // seconds airborne, for the blend hold
  let _camInit = false;
  let _snap = false;                              // force a full snap next update

  /**
   * Ease camera.fov toward `target`. Guarded so we only touch the projection
   * matrix when it actually moves — updateProjectionMatrix() every frame for a
   * sub-millidegree change is pure waste.
   */
  function applyFov(target, dt, snap) {
    if (!camera.isPerspectiveCamera) return;
    const k = snap ? 1 : 1 - Math.exp(-CAM.fovLerp * dt);
    const next = camera.fov + (target - camera.fov) * k;
    if (Math.abs(next - camera.fov) < 1e-3) return;
    camera.fov = next;
    camera.updateProjectionMatrix();
  }

  /** Snap the rig to the car — call on respawn so it doesn't sweep across the map. */
  function reset() {
    _camInit = false;
    _camLoop = 0;
    _loopAir = 0;
    _camUp.set(0, 1, 0);
    camera.up.set(0, 1, 0);
    // Reset alone only re-seeds heading/look; the POSITION + up still eased in
    // from wherever the camera was, so a respawn teleport swung the camera across
    // the world (which looked like the shake). Snap everything for one frame so
    // the camera just appears behind the car.
    _snap = true;
  }

  function update(dt) {
    if (isOrbit()) {
      // Orbit modes (build / free-look) are owned by the ENGINE's OrbitControls,
      // which runs its own controls.update() every frame. The chase must NOT also
      // drive the camera or force orbit.target here — doing both makes the two
      // fight (and in build mode it yanked the orbit target onto the car). Just
      // un-roll the persistent up so a following drive frame starts clean.
      if (_camUp.x !== 0 || _camUp.z !== 0) {
        _camUp.set(0, 1, 0);
        camera.up.set(0, 1, 0);
        _camLoop = 0;
        _loopAir = 0;
      }
      // Hand the FOV back too, or build mode inherits whatever kick the last
      // drive frame left behind and the editor view sits subtly zoomed out.
      applyFov(CAM.fovBase, dt, false);
      return;
    }

    const snap = _snap; // full snap this frame (respawn) — see reset()
    _snap = false;
    // Follow the INTERPOLATED render pose (what the mesh is drawn at), not
    // body.pos — the body steps at FIXED_DT while the mesh interpolates per
    // frame, so following body.pos makes the car jitter in frame.
    const pos = vehicle.renderPos ?? vehicle.body.pos;
    const rquat = vehicle.renderQuat ?? vehicle.body.quat;
    const v = vehicle.body.vel;
    const speed = v.length();
    const grounded = vehicle.groundedCount > 0;

    // Widen with speed. Driven by TOTAL speed rather than horizontal, so a
    // near-vertical drop off a jump reads as fast too.
    applyFov(
      CAM.fovBase + CAM.fovAtSpeed * Math.min(1, speed / Math.max(1, CAM.fovSpeedRef)),
      dt,
      snap,
    );

    _camFwd.set(0, 0, 1).applyQuaternion(rquat); // car facing (fallback)
    const reversing = grounded && v.dot(_camFwd) < -0.5;

    // 3D look direction: travel dir when moving, else the car's facing.
    if (speed > CAM.minSpeed && !reversing) _camV.copy(v).multiplyScalar(1 / speed);
    else _camV.copy(_camFwd);

    // Horizontal trail heading: from velocity when moving forward; the car's
    // facing on the ground; held steady in the air at low horizontal speed (so a
    // flat spin or a near-vertical climb doesn't spin the camera).
    const hSpeed = Math.hypot(v.x, v.z);
    if (hSpeed > CAM.minSpeed && !reversing) {
      _camTgtH.set(v.x, 0, v.z).multiplyScalar(1 / hSpeed);
    } else if (grounded) {
      _camTgtH.set(_camFwd.x, 0, _camFwd.z);
      if (_camTgtH.lengthSq() > 1e-6) _camTgtH.normalize();
      else _camTgtH.copy(_camHeading);
    } else {
      _camTgtH.copy(_camHeading);
    }

    if (!_camInit) {
      _camHeading.copy(_camTgtH);
      _camLookDir.copy(_camV);
      _camInit = true;
    }

    const kh = snap ? 1 : 1 - Math.exp(-CAM.headingLerp * dt);
    _camHeading.lerp(_camTgtH, kh);
    if (_camHeading.lengthSq() < 1e-6) _camHeading.copy(_camTgtH);
    _camHeading.normalize();

    const kl = snap ? 1 : 1 - Math.exp(-CAM.lookLerp * dt);
    _camLookDir.lerp(_camV, kl);
    if (_camLookDir.y > CAM.maxLookPitch) _camLookDir.y = CAM.maxLookPitch;
    else if (_camLookDir.y < -CAM.maxLookPitch) _camLookDir.y = -CAM.maxLookPitch;
    if (_camLookDir.lengthSq() < 1e-6) _camLookDir.copy(_camV);
    _camLookDir.normalize();

    // ── World-frame rig (normal driving / airborne): stable, world-up. ──
    _wDesired.copy(pos)
      .addScaledVector(_camHeading, -CAM.dist)
      .addScaledVector(_worldUp, CAM.height);
    _wLook.copy(pos).addScaledVector(_camLookDir, CAM.lookAhead);
    _wLook.y += CAM.lookUp;

    // ── Car-frame rig (loops / wall-rides): trails along the car's OWN forward
    // & up so the view rolls with the car through a vertical loop. Only blended
    // in while grounded — airborne spins keep the world rig.
    _carUp.set(0, 1, 0).applyQuaternion(rquat);
    _cDesired.copy(pos)
      .addScaledVector(_camFwd, -CAM.dist)
      .addScaledVector(_carUp, CAM.height);
    _cLook.copy(pos)
      .addScaledVector(_camFwd, CAM.lookAhead)
      .addScaledVector(_carUp, CAM.lookUp);

    // Blend target: how far the car's up tilts from world up, gated on grip.
    // Airborne the tilt is trick input rather than a surface to follow, so the
    // blend is not recomputed — it is HELD briefly and then released slowly, so
    // a lip or a crest hop cannot unwind the rig in the middle of a jump.
    let loopTgt = 0;
    if (grounded) {
      _loopAir = 0;
      loopTgt = THREE.MathUtils.clamp(
        (CAM.loopStart - _carUp.y) / (CAM.loopStart - CAM.loopFull), 0, 1,
      );
    } else {
      _loopAir += dt;
    }
    const loopRate = grounded
      ? CAM.loopLerp
      : (_loopAir < CAM.loopAirHold ? 0 : CAM.loopAirLerp);
    if (snap) _camLoop = loopTgt;
    else if (loopRate > 0) {
      _camLoop += (loopTgt - _camLoop) * (1 - Math.exp(-loopRate * dt));
    }

    _camDesired.lerpVectors(_wDesired, _cDesired, _camLoop);
    // SWING THE CAMERA ROUND THE CAR, DON'T CUT ACROSS. Both rigs place the
    // camera at the same radius — hypot(dist, height) — just in different
    // frames, so a straight lerp between them follows the CHORD and dives at the
    // car exactly mid-blend. MEASURED through a loop: 8.15 m collapsing to 2.8 m
    // at the apex, which is inside the car's own length. This was always present
    // (5.9 m on the old wide blend) and only became obvious once the blend had
    // less angular room to happen in. Re-projecting onto the sphere makes it an
    // arc; it is a no-op at blend 0 and 1, where the lerp is already an endpoint.
    if (_camLoop > 0 && _camLoop < 1) {
      _camOff.copy(_camDesired).sub(pos);
      const len = _camOff.length();
      if (len > 1e-4) {
        _camDesired.copy(pos).addScaledVector(_camOff, Math.hypot(CAM.dist, CAM.height) / len);
      }
    }

    // LAG COMPENSATION. An exponential follow lags a target moving at constant
    // v by exactly v / posLerp. At posLerp 7 and 48 m/s that is 6.9 m ON TOP of
    // CAM.dist — so the 7.5 m chase silently becomes ~14.4 m flat out, and the
    // car shrinks into the distance exactly when you most need to see it. It
    // reads as "the camera pulls away at speed" but nothing in the rig asks for
    // that; it is pure filter lag.
    //
    // Feeding the velocity forward cancels the STEADY-STATE error while leaving
    // the smoothing untouched for bumps, landings and direction changes — which
    // is why this is preferable to just raising posLerp (that would stiffen the
    // camera everywhere to fix a problem that only exists at speed).
    if (!snap && CAM.lagCompensate > 0) {
      _camDesired.addScaledVector(v, CAM.lagCompensate / CAM.posLerp);
    }

    const kp = snap ? 1 : 1 - Math.exp(-CAM.posLerp * dt);
    camera.position.lerp(_camDesired, kp);

    _camLook.lerpVectors(_wLook, _cLook, _camLoop);

    // Keep the camera WORLD-upright through the loop so the car visibly turns
    // upside down on screen. A world-up camera must roll 180° somewhere as the
    // view sweeps past vertical — unavoidable — so we EASE camera.up toward its
    // target every frame, turning that roll into smooth motion instead of a snap.
    _upTgt.copy(_worldUp);
    _camDir.copy(_camLook).sub(camera.position);
    const dlen = _camDir.length();
    if (dlen > 1e-5) {
      _camDir.multiplyScalar(1 / dlen);
      // Near-vertical view: bias the target toward the car's up so the roll has a
      // well-defined direction (no ambiguous spin) and lookAt can't gimbal-lock.
      // carUp ⊥ travel, so it's a safe perpendicular.
      const vert = Math.abs(_camDir.y); // 1 = looking straight up/down
      const g = THREE.MathUtils.smoothstep(vert, 0.85, 0.999) * _camLoop;
      if (g > 0) _upTgt.lerp(_carUp, g);
    }
    const ku = snap ? 1 : 1 - Math.exp(-CAM.upLerp * dt);
    _camUp.lerp(_upTgt, ku);
    // Keep it valid: strip any component along the view dir; fall back to the
    // car's up if that leaves nothing (up nearly parallel to view).
    if (dlen > 1e-5) _camUp.addScaledVector(_camDir, -_camUp.dot(_camDir));
    if (_camUp.lengthSq() < 1e-4) _camUp.copy(_carUp);
    camera.up.copy(_camUp.normalize());
    camera.lookAt(_camLook);
  }

  return { update, reset, params: CAM };
}
