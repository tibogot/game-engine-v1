/**
 * Impostor bake + single billboard for v2 (Phase 1 of the LOD3 capstone).
 *
 * Bakes a slot's whole tree (trunk + leaf cards) into an octahedral color atlas
 * at LOAD time using octahedralCore (same pipeline arborist+sky uses), then
 * builds ONE camera-facing billboard from it. This proves bake-in-v2 + the
 * impostor material work in v2's WebGPU/lighting before we go instanced (Phase 2)
 * and wire it as the far LOD tier (Phase 3).
 *
 * Bake is VIEW-STABLE: flat ambient light only (no directional → no baked
 * lit/shadow side) and the foliage shader forced to world-up normals with no
 * AO/rim/SSS, so every octahedral view is lit identically and the billboard can
 * be relit live by the scene sun. Mirrors arborist's bakeTreeImpostor exactly.
 */
import * as THREE from "three";
import {
  bakeColorAtlasFromObject,
  makeFlatAuxTextures,
  createImpostorMaterials,
} from "./octahedralCore.js";

// Bake config (matches arborist's IMP). 2048 atlas for the game (per memory:
// ship 2048 not 4096 — ~16MB/type) even though the lab previews at 4096.
export const IMPOSTOR_BAKE = {
  grid: 8,
  atlasSize: 2048,
  cellPad: 6,
  fullOctahedral: false,
  bakeLight: 3.0,
};

/**
 * Assemble a temp renderable tree. The leaf mesh is built at final scale (its
 * one tree used t.scale = trunkScale), but the trunk submeshes are RAW geometry,
 * so we scale them by the same trunkScale (scale x localMatrix) — otherwise the
 * trunk and canopy bake at mismatched proportions.
 */
function assembleTreeForBake(trunkSubmeshes, leafMesh, trunkScale = 1) {
  const group = new THREE.Group();
  if (trunkSubmeshes) {
    const sMat = new THREE.Matrix4().makeScale(trunkScale, trunkScale, trunkScale);
    for (const sm of trunkSubmeshes) {
      const m = new THREE.Mesh(sm.geometry, sm.material);
      m.matrixAutoUpdate = false;
      m.matrix.copy(sMat);
      if (sm.localMatrix) m.matrix.multiply(sm.localMatrix);
      group.add(m);
    }
  }
  if (leafMesh) group.add(leafMesh);
  group.updateMatrixWorld(true);
  return group;
}

/**
 * Bake one slot's tree into an octahedral color atlas.
 * @returns impostorResult { colorTex, atlasSize, grid, cellPad, center, radius }
 */
export async function bakeSlotImpostor(renderer, { trunkSubmeshes, leafMesh, foliageUniforms, trunkScale = 1 }, opts = IMPOSTOR_BAKE) {
  const group = assembleTreeForBake(trunkSubmeshes, leafMesh, trunkScale);

  // Force the foliage shader into a view-stable look for the bake, then restore.
  const u = foliageUniforms;
  const saved = u && {
    nb: u.normalBias.value, ao: u.aoStr.value,
    rim: u.rimStr.value, sss: u.sssStr.value,
  };
  if (u) {
    u.normalBias.value = 1.0; // world-up leaves (no view-facing terminator)
    u.aoStr.value = 0.0;
    u.rimStr.value = 0.0;
    u.sssStr.value = 0.0;
  }

  const bakeLight = new THREE.AmbientLight(0xffffff, opts.bakeLight);
  let result;
  try {
    result = await bakeColorAtlasFromObject(renderer, [group], {
      grid: opts.grid,
      atlasSize: opts.atlasSize,
      cellPad: opts.cellPad,
      fullOctahedral: opts.fullOctahedral,
      maxAniso: 8,
      lights: [bakeLight],
    });
  } finally {
    if (u && saved) {
      u.normalBias.value = saved.nb;
      u.aoStr.value = saved.ao;
      u.rimStr.value = saved.rim;
      u.sssStr.value = saved.sss;
    }
  }
  return result;
}

/**
 * Build a single camera-facing billboard from a baked impostor result.
 * Color-only (flat aux textures); relit live by the scene sun (uUnlit=0).
 * @returns { mesh, uniforms }
 */
export function buildImpostorBillboard(impostorResult, opts = IMPOSTOR_BAKE) {
  const flats = makeFlatAuxTextures();
  const built = createImpostorMaterials(
    {
      colorTex: impostorResult.colorTex,
      normalTex: flats.normalTex,
      rmTex: flats.rmTex,
      depthTex: flats.depthTex,
    },
    {
      impostorScale: impostorResult.radius,
      gridVal: opts.grid,
      atlasSize: impostorResult.atlasSize,
      cellPad: impostorResult.cellPad,
      fullOctahedral: opts.fullOctahedral,
    },
  );
  const u = built.uniforms;
  u.uUnlit.value = 0;               // relight: albedo lit live by the scene
  built.mainMat.envMapIntensity = 0; // match leaves (sun+hemi, no double sky tint)

  const R = impostorResult.radius;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), built.mainMat);
  mesh.scale.setScalar(2 * R);
  mesh.frustumCulled = false;
  return { mesh, uniforms: u };
}
