/**
 * Ground colour for placed-cliff blend material flat tops — mirrors active terrain surface.
 */
import { float, vec3, texture } from "three/tsl";
import { tileColorAtWorldXZ } from "../../core/legacy/tileMaterial.js";

/**
 * @param {import("three/tsl").Node} scaledWorldXZ — world XZ scaled by blend ground UV scale
 * @param {{
 *   type: "tsl",
 *   groundColorAtWorldXZ: (xz: import("three/tsl").Node) => import("three/tsl").Node,
 * } | {
 *   type: "image",
 *   groundSlot: object,
 *   worldSize: number,
 * } | {
 *   type: "tile",
 *   gridTex: THREE.Texture,
 *   tileUniforms: object,
 * }} groundDeps
 */
export function cliffBlendGroundColor(scaledWorldXZ, groundDeps) {
  if (groundDeps.type === "tsl") {
    return groundDeps.groundColorAtWorldXZ(scaledWorldXZ);
  }
  if (groundDeps.type === "image") {
    const slot = groundDeps.groundSlot;
    const inv = float(1.0 / groundDeps.worldSize);
    const tileUV = scaledWorldXZ.mul(inv).mul(slot.uUVScale);
    return texture(slot.albedoTex, tileUV).rgb;
  }
  if (groundDeps.type === "tile") {
    return tileColorAtWorldXZ(
      groundDeps.gridTex,
      groundDeps.tileUniforms,
      scaledWorldXZ,
    );
  }
  return vec3(0.35, 0.35, 0.35);
}
