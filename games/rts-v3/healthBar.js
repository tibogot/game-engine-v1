// Camera-facing health bar — shared by unitRenderer and structuresRenderer.
import * as THREE from "three";

// Bars are HUD drawn over the world (depthTest off), so scene fog has no business
// tinting them. It also keeps a bar on a STATIC entity (the base, a turret) from
// freezing the fog uniforms it first rendered with — see structuresRenderer.js.
/** Dark backing + colored fill anchored on its LEFT edge (scale.x = fraction). */
export function makeHealthBar(width, height = 0.55) {
  const group = new THREE.Group();

  const bg = new THREE.Mesh(
    new THREE.PlaneGeometry(width + 0.18, height + 0.18),
    new THREE.MeshBasicMaterial({ color: 0x0b0e13, transparent: true, opacity: 0.85, depthTest: false, depthWrite: false, fog: false }),
  );
  bg.renderOrder = 1001;
  group.add(bg);

  const fill = new THREE.Mesh(
    new THREE.PlaneGeometry(width, height).translate(width / 2, 0, 0), // left-anchored
    new THREE.MeshBasicMaterial({ color: 0x3ddc60, depthTest: false, depthWrite: false, fog: false }),
  );
  fill.position.set(-width / 2, 0, 0.001);
  fill.renderOrder = 1002;
  group.add(fill);

  return {
    group,
    fill,
    /** frac 0..1; `hostile` tints the full bar red instead of green. */
    set(frac, camera, x, y, z, hostile = false) {
      group.position.set(x, y, z);
      if (camera) group.quaternion.copy(camera.quaternion);
      fill.scale.x = Math.max(1e-4, frac);
      fill.material.color.setHex(
        hostile ? 0xe4483a : frac > 0.6 ? 0x3ddc60 : frac > 0.3 ? 0xf5c542 : 0xe4483a,
      );
    },
  };
}
