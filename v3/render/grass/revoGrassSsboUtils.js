/**
 * TSL helpers ported from Revo Realms VegetationSsboUtils (stochastic keep).
 * Its frustum test is gone: the grass uses gpuCull.js like every other field
 * (the Revo one pulled the screen top IN by the blade radius).
 */
import {
  Fn,
  float,
  hash,
  instanceIndex,
  max,
  mix,
  smoothstep,
  step,
} from "three/tsl";

const EPSILON = float(1e-6);

/** Radial density falloff from anchor (Revo uses dist², not linear dist). */
export const computeStochasticKeep = Fn(
  ([worldPos, anchorPos, r0, r1, pMin]) => {
    const dx = worldPos.x.sub(anchorPos.x);
    const dz = worldPos.z.sub(anchorPos.z);
    const distSq = dx.mul(dx).add(dz.mul(dz));
    const r0Sq = r0.mul(r0);
    const r1Sq = r1.mul(r1);
    const t = distSq.sub(r0Sq).div(max(r1Sq.sub(r0Sq), EPSILON)).clamp();
    const p = mix(float(1), pMin, t);
    const rnd = hash(float(instanceIndex).mul(0.73));
    return step(rnd, p);
  },
);

/**
 * Shadow factor for material (Revo: mix(base*0.5, base, factor)).
 * bakedWeight: 1 when no lightmap; lower when in baked shadow (future).
 */
export const computeGrassShadowFactor = Fn(
  ([grassWorldPos, anchorPos, playerRadius, bakedWeight]) => {
    const diff = grassWorldPos.xz.sub(anchorPos.xz);
    const distSq = diff.dot(diff);
    const inner = playerRadius.mul(playerRadius).mul(0.35);
    const outer = playerRadius.mul(playerRadius);
    const inCap = float(1).sub(smoothstep(inner, outer, distSq));
    const playerBottomY = anchorPos.y.sub(playerRadius);
    const heightAboveGrass = playerBottomY.sub(grassWorldPos.y);
    const shadowStrength = smoothstep(float(0), float(2), heightAboveGrass);
    const playerShadow = mix(float(1), float(0.55), inCap.mul(shadowStrength));
    return bakedWeight.mul(playerShadow);
  },
);
