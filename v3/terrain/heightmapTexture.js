import * as THREE from "three";

export const HEIGHTMAP_SIZE = 1024;
export const WORLD_SIZE     = 2048;
// Scale factor: stored_value × MAX_HEIGHT = world metres.
// No upper clamp on stored values — mountains can exceed 1.0 × MAX_HEIGHT.
export const MAX_HEIGHT = 500;

export function createHeightmapTexture() {
  // Start flat; sculpt everything from scratch.
  const data = new Float32Array(HEIGHTMAP_SIZE * HEIGHTMAP_SIZE);
  const tex = new THREE.DataTexture(data, HEIGHTMAP_SIZE, HEIGHTMAP_SIZE, THREE.RedFormat, THREE.FloatType);
  tex.needsUpdate = true;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}
