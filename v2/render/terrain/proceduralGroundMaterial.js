import * as THREE from "three";
import { Fn, float, vec2, vec3 } from "three/tsl";
import { normalMap } from "three/tsl";
import { createGroundTslBundle } from "../../core/legacy/chunkGroundTsl.js";
import { createMeadowTslBundle } from "../../core/legacy/chunkMeadowTsl.js";
import { createCliffShadingContext } from "../../core/legacy/chunkTerrainAutoCliff.js";

/**
 * @param {object} groundParams
 * @param {object} meadowParams
 * @param {null | object} [cliffDeps]
 * @param {null | ReturnType<import("./splatOverlayTsl.js").createSplatOverlay>} [splatOverlay]
 * @param {ReturnType<import("../../core/legacy/chunkGroundTsl.js").createGroundTslBundle>} [groundBundle]
 */
export function createV2ProceduralGroundMaterial(
  groundParams,
  meadowParams,
  cliffDeps = null,
  splatOverlay = null,
  groundBundle = null,
) {
  if (!groundBundle) groundBundle = createGroundTslBundle(groundParams);
  const meadowBundle = createMeadowTslBundle(meadowParams);

  const cliff =
    cliffDeps &&
    createCliffShadingContext(
      cliffDeps.heightTex,
      cliffDeps.rockColorTex,
      cliffDeps.rockDataTex,
      cliffDeps.cliffU,
      cliffDeps.worldSize,
      cliffDeps.worldHalf,
      cliffDeps.htexRes,
    );

  const mat = new THREE.MeshStandardNodeMaterial({
    roughness: 0.9,
    metalness: 0,
  });
  mat.envMapIntensity = 0;

  mat.colorNode = Fn(() => {
    let col = groundBundle.groundProc();
    if (splatOverlay) {
      col = splatOverlay.blendColor(col);
      col = splatOverlay.blendMeadow(col, meadowBundle.meadowProc);
    }
    return cliff ? cliff.augmentColor(col) : col;
  })();

  if (cliff && splatOverlay) {
    mat.roughnessNode = Fn(() => {
      const baseRough = float(0.9);
      const overlaid = splatOverlay.blendRoughness(baseRough);
      const slope = cliff.getSlopeMask().pow(cliffDeps.cliffU.uRockBlendSharp);
      return Fn(() => cliff.evaluateRockRoughnessRawInFn())()
        .mul(float(1).sub(slope))
        .add(overlaid.mul(slope));
    })();
    mat.normalNode = Fn(() => {
      const baseRaw = vec3(0.5, 0.5, 1.0);
      const overlaid = splatOverlay.blendNormalRaw(baseRaw);
      const nstr = splatOverlay.blendNormalStrength(float(1.0));
      const rockRaw = cliff.evaluateRockNormalRawInFn();
      const slope = cliff.getSlopeMask().pow(cliffDeps.cliffU.uRockBlendSharp);
      const combined = Fn(() => {
        const mx = rockRaw.x
          .mul(float(1).sub(slope))
          .add(overlaid.x.mul(slope));
        const my = rockRaw.y
          .mul(float(1).sub(slope))
          .add(overlaid.y.mul(slope));
        const mz = rockRaw.z
          .mul(float(1).sub(slope))
          .add(overlaid.z.mul(slope));
        return vec3(mx, my, mz);
      })();
      return normalMap(combined, vec2(nstr, nstr));
    })();
  } else if (cliff) {
    mat.normalNode = cliff.buildNormalNode();
    mat.roughnessNode = cliff.buildRoughnessNode();
  } else if (splatOverlay) {
    mat.roughnessNode = Fn(() => {
      return splatOverlay.blendRoughness(float(0.9));
    })();
    mat.normalNode = Fn(() => {
      const baseRaw = vec3(0.5, 0.5, 1.0);
      const overlaid = splatOverlay.blendNormalRaw(baseRaw);
      const nstr = splatOverlay.blendNormalStrength(float(1.0));
      return normalMap(overlaid, vec2(nstr, nstr));
    })();
  }

  if (splatOverlay?.holeMask) {
    mat.opacityNode = Fn(() => splatOverlay.holeMask())();
    mat.alphaTest = 0.5;
    mat.transparent = false;
  }

  return {
    material: mat,
    splatTexNode: splatOverlay?.splatTexNode ?? null,
    splat1TexNode: splatOverlay?.splat1TexNode ?? null,
    holeTexNode: splatOverlay?.holeTexNode ?? null,
    uSoloLayer: splatOverlay?.uSoloLayer ?? null,
    uHeightBlend: splatOverlay?.uHeightBlend ?? null,
    uHeightContrast: splatOverlay?.uHeightContrast ?? null,
    uChunkHasHole: splatOverlay?.uChunkHasHole ?? null,
    groundColorAtWorldXZ: groundBundle.groundColorAtWorldXZ,
    groundUniforms: groundBundle.groundUniforms,
    syncGround: (p) => groundBundle.syncFromParams(p),
    syncMeadow: (p) => meadowBundle.syncFromParams(p),
  };
}
