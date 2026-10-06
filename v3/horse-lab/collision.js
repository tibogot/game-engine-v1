// ── Horse lab: collision proxies ─────────────────────────────────────────────
// What the horse's rays test is not what is drawn. A drawn fence is hundreds
// of rail instances, a drawn stone wall thousands of jittered triangles; the
// rays only need plain boxes. These are invisible meshes, never added to the
// scene (no draw, no shadow): just raycast targets with a fixed world matrix.
//
// (Measured: a gallop on the farm cost 16 ms of CPU a frame with the drawn
// geometry as the ray targets.)
import * as THREE from "three";

const BOX = new THREE.BoxGeometry(1, 1, 1);
BOX.computeBoundingSphere();
const MAT = new THREE.MeshBasicMaterial();          // a raycast skips a mesh with no material

/** An axis-aligned box (rotated `ry` about y), centre (x, y, z). */
export function boxProxy(sx, sy, sz, x, y, z, ry = 0) {
  const m = new THREE.Mesh(BOX, MAT);
  m.scale.set(sx, sy, sz);
  m.position.set(x, y, z);
  m.rotation.y = ry;
  m.updateMatrixWorld(true);
  m.matrixAutoUpdate = false;
  m.userData.proxy = true;
  return m;
}

/** A fence line from (ax, az) to (bx, bz): `top` m high, `thick` m deep, from `y0`. */
export function lineProxy(ax, az, bx, bz, top, thick = 0.16, y0 = 0) {
  const len = Math.hypot(bx - ax, bz - az);
  return boxProxy(thick, top - y0, len, (ax + bx) / 2, (y0 + top) / 2, (az + bz) / 2, Math.atan2(bx - ax, bz - az));
}
