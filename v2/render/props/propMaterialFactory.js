/**
 * Prop material factory — builds a Three material from a propTextureLibrary entry.
 *
 * Dispatches by `libMat.type`:
 *  - "none" → flat grey MeshStandardNodeMaterial (the default before user picks a material)
 *  - "pbr"  → `createPropPbrNodeMaterial(libMat, opts)` (PBR maps + optional triplanar)
 *  - "tile" → `createTileMaterial(libMat.config)` (procedural grid floor)
 *
 * Unknown / missing → grey fallback.
 */
import * as THREE from "three";
import { createPropPbrNodeMaterial } from "./propPbrNodeMaterial.js";
import { createTileMaterial } from "../../core/legacy/tileMaterial.js";

/**
 * @param {object} libMat — entry from `propTextureLibrary.materials`
 * @param {{ triplanar?: boolean }} [opts]
 */
export function createMaterialForLibrary(libMat, opts = {}) {
  if (!libMat) return _grey();
  switch (libMat.type) {
    case "pbr":
      return createPropPbrNodeMaterial(libMat, opts);
    case "tile":
      return createTileMaterial({ ...libMat.config });
    case "none":
    default:
      return _grey();
  }
}

function _grey() {
  return new THREE.MeshStandardNodeMaterial({
    color: 0xcccccc,
    roughness: 0.6,
    metalness: 0.0,
  });
}
