/**
 * Procedural bark material for trunks (port of arborist's trunkMat). A cheap
 * vertical 2-colour gradient up the trunk + roughness, metalness 0. Applied to
 * a slot's trunk submeshes when the preset's `trunkMaterial.useGlb` is false, so
 * trunks get the bark colour authored in arborist without needing a texture.
 *
 * Gradient runs over the trunk's LOCAL Y bounds (positionLocal space) so it's
 * 0 at the base / 1 at the top regardless of where the tree sits on the terrain
 * or how the GLB was scaled — unlike a world-Y gradient, which would break on
 * hills. yMin/yMax are the raw geometry bounds (which is what positionLocal is).
 */
import * as THREE from "three";
import { uniform, mix, smoothstep, positionLocal } from "three/tsl";
import { MeshStandardNodeMaterial } from "three";

export function createTrunkMaterial(opts = {}) {
  const u = {
    botColor:  uniform(new THREE.Color(opts.botColor ?? "#4a2f17")),
    topColor:  uniform(new THREE.Color(opts.topColor ?? "#6b4a2b")),
    yMin:      uniform(opts.yMin ?? 0),
    yMax:      uniform(opts.yMax ?? 6),
    roughness: uniform(opts.roughness ?? 0.9),
  };
  const mat = new MeshStandardNodeMaterial({ metalness: 0 });
  const grad = smoothstep(u.yMin, u.yMax, positionLocal.y);
  mat.colorNode = mix(u.botColor, u.topColor, grad);
  mat.roughnessNode = u.roughness;
  return { material: mat, uniforms: u };
}
