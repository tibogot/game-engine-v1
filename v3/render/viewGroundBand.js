/**
 * WHAT THE CAMERA CAN SEE, in metres of ground.
 *
 * One place, because three different systems kept answering this question for
 * themselves and drifting apart: the grass tile, the foliage LOD steps, and the
 * sun's shadow frustum. Each had its own guess, each was fitted to one camera,
 * and each went stale the moment that camera changed.
 *
 * `groundBand` gives the near and far edges of the visible ground along the
 * view direction. `groundPatch` gives a circle on the ground that contains the
 * whole visible trapezoid — what a shadow frustum has to cover.
 *
 * FLAT GROUND AT THE TARGET HEIGHT is a deliberate approximation. Real terrain
 * rises and falls, but a raycast against a moving hillside returns a number
 * that jitters frame to frame, and every consumer of this wants STABILITY more
 * than it wants the exact metre — a shadow frustum that changes size every
 * frame makes every shadow edge crawl.
 */
import * as THREE from "three";

const _fwd = new THREE.Vector3();

/**
 * @param {THREE.PerspectiveCamera} camera
 * @param {number} targetY world height of the ground being looked at
 * @returns {{ near: number, far: number, height: number, pitch: number, tanHalfH: number }}
 *   near/far are HORIZONTAL distances from the camera's XZ.
 */
export function groundBand(camera, targetY = 0) {
  const height = Math.max(camera.position.y - targetY, 0.01);
  _fwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
  const pitch = Math.asin(THREE.MathUtils.clamp(-_fwd.y, -1, 1));
  const halfV = THREE.MathUtils.degToRad(camera.fov ?? 60) * 0.5;
  const tanHalfH = Math.tan(halfV) * (camera.aspect || 1);
  const camFar = camera.far ?? 4000;
  const reach = (a) => (a > 1e-3 ? height / Math.tan(a) : Infinity);
  const near = Math.min(reach(pitch + halfV), camFar);
  // The TOP of the frustum is what sets the far edge, and at a shallow pitch it
  // points at or above the horizon and never meets the ground at all. Testing
  // the resulting distance cannot catch that — it comes back as camera.far,
  // which is larger than `near` and so looks perfectly reasonable. Test the
  // ANGLE, which is the thing that is actually degenerate.
  const topAngle = pitch - halfV;
  const far = topAngle > 1e-3
    ? Math.min(height / Math.tan(topAngle), camFar)
    : near * 4;   // no horizon distance exists; the near edge is the only scale
  return { near, far, height, pitch, tanHalfH };
}

const _c = new THREE.Vector2();
const _n = new THREE.Vector2();
const _f = new THREE.Vector2();

/**
 * A circle on the ground containing everything the camera can see.
 *
 * The visible ground is a trapezoid — narrow near, wide far — and a shadow
 * frustum has to contain all of it. The half-width at a ground point is its
 * SLANT distance from the camera times tan(halfFovH), not its horizontal
 * distance: at a steep pitch the camera is mostly above the ground it sees, and
 * using the horizontal distance under-covers exactly where the camera is
 * highest, which is when the patch is largest.
 *
 * @returns {{ cx: number, cz: number, radius: number, near: number, far: number }}
 */
export function groundPatch(camera, targetY = 0) {
  const b = groundBand(camera, targetY);
  _fwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
  const fx = _fwd.x, fz = _fwd.z;
  const len = Math.hypot(fx, fz) || 1;
  const ux = fx / len, uz = fz / len;

  _n.set(camera.position.x + ux * b.near, camera.position.z + uz * b.near);
  _f.set(camera.position.x + ux * b.far, camera.position.z + uz * b.far);
  _c.set((_n.x + _f.x) * 0.5, (_n.y + _f.y) * 0.5);

  const hwNear = Math.hypot(b.near, b.height) * b.tanHalfH;
  const hwFar = Math.hypot(b.far, b.height) * b.tanHalfH;
  const radius = Math.max(
    _c.distanceTo(_n) + hwNear,
    _c.distanceTo(_f) + hwFar,
  );
  return { cx: _c.x, cz: _c.y, radius, near: b.near, far: b.far };
}
