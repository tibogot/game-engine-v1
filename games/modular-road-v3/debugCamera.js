import * as THREE from "three";

/**
 * Debug orbit camera — drive the car and look at it from ANY angle at the same
 * time.
 *
 * WHY THIS EXISTS AND `freeLook` DOES NOT DO IT. The game already had a
 * free-look toggle that handed the camera to the engine's OrbitControls while
 * driving, but OrbitControls orbits a FIXED world point: it copies
 * `controls.target` from the car ONCE on activation and then the car drives out
 * of frame. Useful for looking at scenery, useless for watching the car. This
 * rig keeps the target pinned to the car and gives the mouse the orbit instead.
 *
 * DELIBERATELY RIGID. There is no position smoothing at all — the camera is
 * placed exactly on the sphere around the car's render pose every frame. A
 * smoothed follow lags a target moving at constant v by v/lerp (the chase rig
 * has a whole block about compensating for it), and lag shows up as the car
 * sliding around in frame and the horizon swimming — which is precisely the
 * signal you are trying to read when you are judging pitch and roll. Only the
 * user's OWN orbit input is smoothed.
 *
 * `camera.up` stays WORLD up for the same reason: the horizon is the reference
 * you read the car's attitude against, so it must not roll with the car the way
 * the chase rig's loop-follow deliberately does.
 *
 * ── TWO FRAMES, AND THE DIFFERENCE MATTERS ──
 *   WORLD  the azimuth is a world angle. Park it side-on and the car pitches
 *          and rolls THROUGH the view — this is the one for reading a jump
 *          profile or a landing, and it is the default.
 *   CAR    the azimuth is relative to the car's heading, so the camera trails
 *          it like a chase cam you can point anywhere. Better for watching the
 *          line through a corner, useless for attitude (the car is always
 *          pointing the same way on screen).
 */
export const DEBUG_CAM = {
  dist: 9,
  minDist: 1.2,
  maxDist: 150,
  /** Starting elevation above the horizon (rad). Slightly above eye level. */
  elevation: 0.24,
  /** Clamped just short of the poles — straight down has no defined azimuth. */
  minElevation: -1.5,
  maxElevation: 1.5,
  /** Starting azimuth (rad), measured like the chase rig: 0 = behind the car. */
  azimuth: 0,
  /** Radians per pixel of drag. */
  orbitSpeed: 0.007,
  /** Multiplier per wheel notch. */
  zoomStep: 1.12,
  /** Pan metres per pixel, per metre of distance (so it feels the same zoomed). */
  panSpeed: 0.0016,
  /** Convergence on the mouse's requested angle (1/s). High = direct. */
  inputLerp: 22,
  /** Pinned FOV while active — the chase rig's speed-kick would change the
   *  apparent geometry mid-jump, which is not what you want to measure against. */
  fov: 60,
  /** Heading source below this speed falls back to the car's facing (CAR mode). */
  minSpeed: 3.0,
};

/**
 * @param {object} o
 * @param {THREE.Camera} o.camera
 * @param {{renderPos?:THREE.Vector3, renderQuat?:THREE.Quaternion,
 *          body:{pos:THREE.Vector3, vel:THREE.Vector3, quat:THREE.Quaternion}}} o.vehicle
 * @param {HTMLElement} o.domElement
 * @param {() => boolean} [o.isActive] only reads the mouse while this is true
 * @param {(s:object) => void} [o.onChange] fired when a mode/toggle changes, for HUD
 */
export function createDebugCamera({
  camera, vehicle, domElement, isActive = () => false, onChange = null, params = {},
  eventRoot = typeof window !== "undefined" ? window : null,
}) {
  const CAM = { ...DEBUG_CAM, ...params };

  let frame = "world";           // "world" | "car"
  let azimuth = CAM.azimuth;     // requested (mouse) angle
  let elevation = CAM.elevation;
  let dist = CAM.dist;
  let smAz = azimuth;            // smoothed — what the camera actually uses
  let smEl = elevation;
  let smDist = dist;
  let _seeded = false;

  const _pan = new THREE.Vector3();      // user offset from the car, world axes
  const _target = new THREE.Vector3();
  const _offset = new THREE.Vector3();
  const _fwd = new THREE.Vector3();
  const _right = new THREE.Vector3();
  const _up = new THREE.Vector3();
  const _dir = new THREE.Vector3();
  const _worldUp = new THREE.Vector3(0, 1, 0);

  /**
   * Dolly by `notches` of wheel (positive = away). Split out from the DOM
   * handler so the zoom curve is testable without synthesising events.
   */
  function zoomBy(notches) {
    if (!notches) return dist;
    dist = THREE.MathUtils.clamp(
      dist * Math.pow(CAM.zoomStep, notches), CAM.minDist, CAM.maxDist,
    );
    return dist;
  }

  // ── MOUSE ──────────────────────────────────────────────────────────────────
  // BOUND ON WINDOW AT CAPTURE, NOT ON THE CANVAS. This is not a style choice —
  // the canvas is already spoken for. v2/app/editorCameraController.js (which v3
  // uses) registers
  //     domElement.addEventListener("wheel", onWheel, { passive:false, capture:true })
  // at engine boot, and its zoom() calls stopPropagation() on EVERY plain scroll.
  // At-target listeners run in registration order, so anything this file adds to
  // the canvas afterwards is simply never called — the first version of this rig
  // did exactly that and the wheel did nothing at all. (The keyboard has the
  // identical problem; roadGame.js solves it the same way, and games/rts-v3/
  // rtsCamera.js already binds its wheel this way for the same reason.)
  //
  // Capturing on window means WE run first, so we stopImmediatePropagation() the
  // events we consume — otherwise the editor camera would dolly its own orbit
  // radius underneath us on every scroll.
  //
  // TARGET-GATED. Only events whose target is the render canvas are ours, or
  // scrolling the dev panel would zoom the camera instead of scrolling the
  // panel. A drag in progress is exempt: once you are dragging, the pointer is
  // allowed to leave the canvas without the gesture breaking.
  let drag = null;
  const overCanvas = (e) => e.target === domElement;

  const onPointerDown = (e) => {
    if (!isActive() || !overCanvas(e)) return;
    if (e.button !== 0 && e.button !== 2) return;
    drag = { x: e.clientX, y: e.clientY, pan: e.button === 2 };
    domElement.setPointerCapture?.(e.pointerId);
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  const onPointerMove = (e) => {
    if (!drag || !isActive()) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    drag.x = e.clientX; drag.y = e.clientY;
    if (drag.pan) {
      // Pan in the camera's own screen plane, scaled by distance so the world
      // moves under the cursor at roughly the same rate at any zoom.
      const s = CAM.panSpeed * smDist;
      camera.getWorldDirection(_dir);
      _right.crossVectors(_dir, _worldUp).normalize();
      _up.crossVectors(_right, _dir).normalize();
      _pan.addScaledVector(_right, -dx * s).addScaledVector(_up, dy * s);
    } else {
      azimuth -= dx * CAM.orbitSpeed;
      elevation = THREE.MathUtils.clamp(
        elevation + dy * CAM.orbitSpeed, CAM.minElevation, CAM.maxElevation,
      );
    }
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  const onPointerUp = (e) => {
    if (!drag) return;
    drag = null;
    domElement.releasePointerCapture?.(e.pointerId);
    e.stopImmediatePropagation();
  };
  const onWheel = (e) => {
    if (!isActive() || !overCanvas(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    // Normalise the three deltaMode variants to pixels, the way the editor
    // controller does — a line-mode trackpad otherwise reads as one notch per
    // pixel and the zoom snaps straight to a limit.
    const px = e.deltaMode === 1 ? e.deltaY * 32 : e.deltaMode === 2 ? e.deltaY * 500 : e.deltaY;
    if (Math.abs(px) < 1) return; // trackpad gesture-boundary ghost events
    zoomBy(px / 100); // ~one mouse click of scroll = one notch
  };
  // Right-drag is the pan, so the context menu has to go while we own the mouse.
  const onContextMenu = (e) => {
    if (!isActive() || !overCanvas(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  };

  const CAP = { capture: true };
  const listeners = [
    ["pointerdown", onPointerDown, { capture: true }],
    ["pointermove", onPointerMove, { capture: true }],
    ["pointerup", onPointerUp, CAP],
    ["pointercancel", onPointerUp, CAP],
    ["wheel", onWheel, { capture: true, passive: false }],
    ["contextmenu", onContextMenu, CAP],
  ];
  for (const [type, fn, opts] of listeners) eventRoot?.addEventListener(type, fn, opts);

  /** Car heading in the XZ plane — velocity when moving, facing when parked. */
  function carHeading(rquat) {
    const v = vehicle.body.vel;
    const h = Math.hypot(v.x, v.z);
    if (h > CAM.minSpeed) return Math.atan2(v.x, v.z);
    _fwd.set(0, 0, 1).applyQuaternion(rquat);
    return Math.atan2(_fwd.x, _fwd.z);
  }

  function update(dt) {
    const pos = vehicle.renderPos ?? vehicle.body.pos;
    const rquat = vehicle.renderQuat ?? vehicle.body.quat;

    if (camera.isPerspectiveCamera && Math.abs(camera.fov - CAM.fov) > 1e-3) {
      camera.fov = CAM.fov;
      camera.updateProjectionMatrix();
    }

    // Smooth only the INPUT. Snap on the first frame so switching in doesn't
    // sweep the camera across the map.
    const k = _seeded ? 1 - Math.exp(-CAM.inputLerp * Math.max(1e-4, dt)) : 1;
    _seeded = true;
    smAz += (azimuth - smAz) * k;
    smEl += (elevation - smEl) * k;
    smDist += (dist - smDist) * k;

    // In CAR frame the base angle rides the car's heading; in WORLD it doesn't.
    const base = frame === "car" ? carHeading(rquat) : 0;
    const a = base + smAz;
    const ce = Math.cos(smEl);
    // a = 0 puts the camera BEHIND the car (−Z of the heading), matching the
    // chase rig, so toggling frames doesn't jump you to the other side.
    _offset.set(
      -Math.sin(a) * ce * smDist,
      Math.sin(smEl) * smDist,
      -Math.cos(a) * ce * smDist,
    );

    _target.copy(pos).add(_pan);
    camera.position.copy(_target).add(_offset);

    // World up, except within a few degrees of the poles where it degenerates —
    // there, bias toward the view's own horizontal so lookAt stays stable.
    _dir.copy(_target).sub(camera.position);
    const len = _dir.length();
    if (len > 1e-5) {
      _dir.multiplyScalar(1 / len);
      if (Math.abs(_dir.y) > 0.999) {
        _up.set(-Math.sin(a), 0, -Math.cos(a));
        camera.up.copy(_up.lengthSq() > 1e-6 ? _up.normalize() : _worldUp);
      } else camera.up.copy(_worldUp);
    } else camera.up.copy(_worldUp);
    camera.lookAt(_target);
  }

  /** Re-seed from wherever the chase rig left the camera, so switching in is
   *  continuous rather than a cut to a canned angle. */
  function enter() {
    _offset.copy(camera.position).sub(vehicle.renderPos ?? vehicle.body.pos);
    const r = _offset.length();
    if (r > 0.2) {
      dist = THREE.MathUtils.clamp(r, CAM.minDist, CAM.maxDist);
      elevation = THREE.MathUtils.clamp(
        Math.asin(THREE.MathUtils.clamp(_offset.y / r, -1, 1)),
        CAM.minElevation, CAM.maxElevation,
      );
      const base = frame === "car"
        ? carHeading(vehicle.renderQuat ?? vehicle.body.quat) : 0;
      azimuth = Math.atan2(-_offset.x, -_offset.z) - base;
    }
    _pan.set(0, 0, 0);
    smAz = azimuth; smEl = elevation; smDist = dist;
    _seeded = true;
    drag = null;
  }

  return {
    update,
    enter,
    /** Recentre on the car and drop any pan offset. */
    recenter() { _pan.set(0, 0, 0); },
    get frame() { return frame; },
    /** Swap WORLD ↔ CAR, preserving the on-screen angle so nothing jumps. */
    toggleFrame() {
      const h = carHeading(vehicle.renderQuat ?? vehicle.body.quat);
      azimuth += frame === "car" ? h : -h;
      smAz += frame === "car" ? h : -h;
      frame = frame === "car" ? "world" : "car";
      onChange?.({ frame });
      return frame;
    },
    /** Jump to a canned angle — the ones you actually want when reading attitude. */
    preset(name) {
      const a = { behind: 0, front: Math.PI, left: Math.PI / 2, right: -Math.PI / 2 }[name];
      if (a === undefined) return;
      azimuth = a;
      elevation = 0.06; // near eye level: a side-on silhouette reads pitch best
      _pan.set(0, 0, 0);
    },
    /** Dolly in/out. Positive = away. Also on the keyboard (see roadGame). */
    zoomBy,
    get distance() { return dist; },
    params: CAM,
    dispose() {
      for (const [type, fn, opts] of listeners) eventRoot?.removeEventListener(type, fn, opts);
    },
  };
}
