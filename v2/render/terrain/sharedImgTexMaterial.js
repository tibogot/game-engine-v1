/**
 * Shared image-texture ground material (tiled albedo + ORM/normal across the world).
 *
 * Reads one TextureLibrary slot — albedoTex + ormTex packed R=Rough, G=AO, B=NX, A=NY
 * — and tiles it by slot uvScale. Auto-cliff mixes in on slopes.
 *
 * Optional splat overlay: when provided, 3 painted texture layers blend on top of the
 * base image wherever the per-chunk splat R/G/B channels have paint data. A channel
 * stores meadow density (blended when meadow bundle provided). Where splat = 0,
 * the base image shows through at full weight (v1 parity).
 */
import * as THREE from "three";
import {
  Fn,
  float,
  vec2,
  vec3,
  texture,
  positionWorld,
  mix,
  clamp,
  max,
  sqrt,
} from "three/tsl";
import { normalMap } from "three/tsl";
import { createCliffShadingContext } from "../../core/legacy/chunkTerrainAutoCliff.js";
import { createMeadowTslBundle } from "../../core/legacy/chunkMeadowTsl.js";

/**
 * @param {object} groundSlot — TextureLibrary slot used as the tiled ground material
 * @param {number} worldSize
 * @param {null | object} [cliffDeps]
 * @param {null | ReturnType<import("./splatOverlayTsl.js").createSplatOverlay>} [splatOverlay]
 * @param {null | object} [meadowParams] — if provided, enables meadow painting via splat A channel
 */
export function createV2ImageTexGroundMaterial(
  groundSlot,
  worldSize,
  cliffDeps = null,
  splatOverlay = null,
  meadowParams = null,
) {
  const meadowBundle =
    splatOverlay && meadowParams ? createMeadowTslBundle(meadowParams) : null;
  const mat = new THREE.MeshStandardNodeMaterial({
    roughness: 0.88,
    metalness: 0.0,
  });
  mat.envMapIntensity = 0;

  const invWorldSize = float(1.0 / worldSize);
  const tileUV = positionWorld.xz.mul(invWorldSize).mul(groundSlot.uUVScale);

  const albedoTexNode = texture(groundSlot.albedoTex, tileUV);
  const ormTexNode = texture(groundSlot.ormTex, tileUV);

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

  mat.colorNode = Fn(() => {
    const col = albedoTexNode.rgb;
    const ao = ormTexNode.g;
    let shaded = col.mul(mix(float(1), ao, groundSlot.uAOStr));
    if (splatOverlay) {
      shaded = splatOverlay.blendColor(shaded);
      if (meadowBundle)
        shaded = splatOverlay.blendMeadow(shaded, meadowBundle.meadowProc);
    }
    return cliff ? cliff.augmentColor(shaded) : shaded;
  })();

  mat.roughnessNode = Fn(() => {
    const ormRough = ormTexNode.r;
    let imgRough = clamp(
      mix(float(0.88), ormRough, groundSlot.uRoughStr),
      float(0.04),
      float(1),
    );
    if (splatOverlay) imgRough = splatOverlay.blendRoughness(imgRough);
    if (!cliff) return imgRough;
    const slope = cliff.getSlopeMask().pow(cliffDeps.cliffU.uRockBlendSharp);
    return mix(cliff.evaluateRockRoughnessRawInFn(), imgRough, slope);
  })();

  mat.normalNode = Fn(() => {
    const nmX = ormTexNode.b.mul(2.0).sub(1.0);
    const nmY = ormTexNode.a.mul(2.0).sub(1.0);
    const nmZ = sqrt(
      max(float(0.0), float(1.0).sub(nmX.mul(nmX)).sub(nmY.mul(nmY))),
    );
    let imgRaw = vec3(
      nmX.mul(0.5).add(0.5),
      nmY.mul(0.5).add(0.5),
      nmZ.mul(0.5).add(0.5),
    );
    let nstr = groundSlot.uNormalStr;
    if (splatOverlay) {
      imgRaw = splatOverlay.blendNormalRaw(imgRaw);
      nstr = splatOverlay.blendNormalStrength(groundSlot.uNormalStr);
    }
    if (!cliff) return normalMap(imgRaw, vec2(nstr, nstr));
    const rockRaw = cliff.evaluateRockNormalRawInFn();
    const slope = cliff.getSlopeMask().pow(cliffDeps.cliffU.uRockBlendSharp);
    const combined = mix(rockRaw, imgRaw, slope);
    return normalMap(combined, vec2(nstr, nstr));
  })();

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
    syncMeadow: meadowBundle ? (p) => meadowBundle.syncFromParams(p) : () => {},
  };
}
