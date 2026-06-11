/**
 * Editor-only pickup-radius gizmo for the selected collectible.
 * Draws two sets of 3 great-circle rings (XY, XZ, YZ planes):
 *   - bright green  → pickup radius
 *   - dim green     → magnet radius (pickup × 2.4, matches collectibleRuntime)
 *
 * Hidden in play mode. Zero cost when nothing is selected — just two invisible groups.
 */
import * as THREE from "three";

const RING_SEGMENTS = 64;
const PICKUP_COLOR = 0x4ade80;
const MAGNET_COLOR = 0x86efac;
const MAGNET_MULT  = 2.4;  // mirror MAGNET_RADIUS_MULT in collectibleRuntime.js

function _makeRing(color, opacity) {
  const pts = [];
  for (let i = 0; i <= RING_SEGMENTS; i++) {
    const a = (i / RING_SEGMENTS) * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(a), Math.sin(a), 0));
  }
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  const mat = new THREE.LineBasicMaterial({
    color,
    transparent: opacity < 1,
    opacity,
    depthTest: true,
    depthWrite: false,
  });
  return new THREE.Line(geo, mat);
}

function _make3Rings(color, opacity) {
  const g = new THREE.Group();
  const xy = _makeRing(color, opacity);                     // facing +Z
  const xz = _makeRing(color, opacity); xz.rotation.x = Math.PI / 2;  // facing +Y
  const yz = _makeRing(color, opacity); yz.rotation.y = Math.PI / 2;  // facing +X
  g.add(xy, xz, yz);
  return g;
}

export function createCollectibleGizmo(scene) {
  const pickupRings = _make3Rings(PICKUP_COLOR, 0.9);
  const magnetRings = _make3Rings(MAGNET_COLOR, 0.25);
  const root = new THREE.Group();
  root.add(magnetRings, pickupRings);
  root.visible = false;
  root.renderOrder = 100;
  scene.add(root);

  /**
   * Position + scale gizmo for a selected collectible.
   * @param {THREE.Vector3} worldPos
   * @param {number} pickupRadius
   */
  function show(worldPos, pickupRadius) {
    root.position.copy(worldPos);
    pickupRings.scale.setScalar(pickupRadius);
    magnetRings.scale.setScalar(pickupRadius * MAGNET_MULT);
    root.visible = true;
  }
  function hide() { root.visible = false; }
  function dispose() {
    scene.remove(root);
    root.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
  }
  function isVisible() { return root.visible; }

  return { show, hide, dispose, isVisible };
}
