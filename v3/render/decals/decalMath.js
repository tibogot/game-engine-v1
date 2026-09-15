/**
 * Decal placement maths — no rendering, so tools and tests can use it.
 *
 * A decal is { px,py,pz, qx,qy,qz,qw, sx,sy,sz, priority, slot, ... }: an
 * oriented box of size (sx, sy, sz) whose local −Y is the projection direction.
 */
import * as THREE from "three";

const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _inv = new THREE.Matrix4();
const _local = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _spin = new THREE.Quaternion();

/** Unit box → world. */
export function decalMatrix(d, target = new THREE.Matrix4()) {
  return target.compose(_p.set(d.px, d.py, d.pz), _q.set(d.qx, d.qy, d.qz, d.qw), _s.set(d.sx, d.sy, d.sz));
}

/** True when the world point lies inside the decal's box. */
export function decalContains(d, point) {
  _local.copy(point).applyMatrix4(_inv.copy(decalMatrix(d, _inv)).invert());
  return Math.abs(_local.x) <= 0.5 && Math.abs(_local.y) <= 0.5 && Math.abs(_local.z) <= 0.5;
}

/**
 * The decal painted on top at this surface point: highest priority, then the
 * newest (the same order the renderer draws them in). Null when none covers it.
 */
export function pickDecal(decals, point) {
  let best = null;
  for (const d of decals) {
    if (!decalContains(d, point)) continue;
    if (!best || d.priority > best.priority || (d.priority === best.priority && d.id > best.id)) best = d;
  }
  return best;
}

/**
 * Orientation that projects onto a surface with this normal: local +Y along the
 * normal (so the decal projects down into it), spun `yaw` radians about it.
 */
export function orientDecal(normal, yaw = 0, target = new THREE.Quaternion()) {
  const n = _local.copy(normal).normalize();
  target.setFromUnitVectors(_up, n);
  _spin.setFromAxisAngle(_up, yaw);
  return target.multiply(_spin);
}

/** Slot i was removed: decals on it fall back to slot 0, later slots shift down. */
export function remapSlotsAfterRemove(decals, i) {
  for (const d of decals) {
    if (d.slot === i) d.slot = 0;
    else if (d.slot > i) d.slot--;
  }
}
