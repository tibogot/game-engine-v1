/**
 * TSL helpers ported from Revo Realms VegetationSsboUtils (stochastic + frustum cull).
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
  vec4,
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

/** NDC frustum test with blade-radius padding (Revo visibility). */
export const computeFrustumVisibility = Fn(
  ([worldPos, cameraMatrix, fx, fy, radius, padNdcX, padNdcYNear, padNdcYFar]) => {
    const one = float(1);
    const clip = cameraMatrix.mul(vec4(worldPos, 1));
    const invW = one.div(clip.w);
    const ndc = clip.xyz.mul(invW);
    const eyeDepthAbs = clip.w.abs().max(EPSILON);
    const rNdcX = fx.mul(radius).div(eyeDepthAbs).add(padNdcX);
    const rNdcY = fy.mul(radius).div(eyeDepthAbs);
    const rNdcYNear = rNdcY.add(padNdcYNear);
    const rNdcYFar = rNdcY.sub(padNdcYFar);
    const visLeft = step(one.negate().sub(rNdcX), ndc.x);
    const visRight = step(ndc.x, one.add(rNdcX));
    const visX = visLeft.mul(visRight);
    const visNear = step(one.negate().sub(rNdcYNear), ndc.y);
    const visFar = step(ndc.y.add(rNdcYFar), one);
    const visY = visNear.mul(visFar);
    const visZ = step(float(-1), ndc.z).mul(step(ndc.z, one));
    return visX.mul(visY).mul(visZ);
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
