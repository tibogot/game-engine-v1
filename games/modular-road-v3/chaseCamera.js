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
  // Loop-follow blend ramps by how far the car's up-axis tilts from world up.
  loopStart: 0.85,    // carUp.y where loop-follow begins (~32° tilt)
  loopFull: 0.2,      // carUp.y where loop-follow is fully on (~78° tilt)
  loopLerp: 3.5,      // how fast the camera rolls into/out of loop-follow
  upLerp: 4.0,        // how fast camera.up eases (smooths the loop roll)
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
  const _wDesired = new THREE.Vector3();          // world-frame camera position
  const _cDesired = new THREE.Vector3();          // car-frame camera position
  const _wLook = new THREE.Vector3();             // world-frame look target
  const _cLook = new THREE.Vector3();             // car-frame look target
  let _camLoop = 0;                               // smoothed 0..1 loop-follow blend
  let _camInit = false;

  /** Snap the rig to the car — call on respawn so it doesn't sweep across the map. */
  function reset() {
    _camInit = false;
    _camLoop = 0;
    _camUp.set(0, 1, 0);
    camera.up.set(0, 1, 0);
  }

  function update(dt) {
    if (isOrbit()) {
      if (_camUp.x !== 0 || _camUp.z !== 0) {
        _camUp.set(0, 1, 0); // un-roll so OrbitControls behaves
        camera.up.set(0, 1, 0);
        _camLoop = 0;
      }
      if (orbit) {
        orbit.target.copy(vehicle.body.pos);
        orbit.update();
      }
      return;
    }

    const pos = vehicle.body.pos;
    const v = vehicle.body.vel;
    const speed = v.length();
    const grounded = vehicle.groundedCount > 0;
    _camFwd.set(0, 0, 1).applyQuaternion(vehicle.body.quat); // car facing (fallback)
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

    const kh = 1 - Math.exp(-CAM.headingLerp * dt);
    _camHeading.lerp(_camTgtH, kh);
    if (_camHeading.lengthSq() < 1e-6) _camHeading.copy(_camTgtH);
    _camHeading.normalize();

    const kl = 1 - Math.exp(-CAM.lookLerp * dt);
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
    _carUp.set(0, 1, 0).applyQuaternion(vehicle.body.quat);
    _cDesired.copy(pos)
      .addScaledVector(_camFwd, -CAM.dist)
      .addScaledVector(_carUp, CAM.height);
    _cLook.copy(pos)
      .addScaledVector(_camFwd, CAM.lookAhead)
      .addScaledVector(_carUp, CAM.lookUp);

    // Blend target: how far the car's up tilts from world up, gated on grip.
    let loopTgt = 0;
    if (grounded) {
      loopTgt = THREE.MathUtils.clamp(
        (CAM.loopStart - _carUp.y) / (CAM.loopStart - CAM.loopFull), 0, 1,
      );
    }
    _camLoop += (loopTgt - _camLoop) * (1 - Math.exp(-CAM.loopLerp * dt));

    _camDesired.lerpVectors(_wDesired, _cDesired, _camLoop);
    const kp = 1 - Math.exp(-CAM.posLerp * dt);
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
    const ku = 1 - Math.exp(-CAM.upLerp * dt);
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
