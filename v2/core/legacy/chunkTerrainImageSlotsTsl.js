/**
 * TSL: splatmap-painter-style image slot blend (3 slots × albedo + packed ORM).
 * Use only inside Fn(() => { ... }) so positionWorld / positionLocal resolve per fragment.
 */
import {
  float,
  vec2,
  vec3,
  texture,
  mix,
  positionWorld,
  positionLocal,
  max,
  min,
  sqrt,
  div,
  clamp,
  Fn,
} from "three/tsl";
import { normalMap } from "three/tsl";

export function applyImageSlotAlbedoAndAO(col, cs, worldSize, imgWeightTex, slots, imgWSample) {
  const ws = float(1.0).div(float(worldSize));
  const imgW = imgWSample ?? texture(imgWeightTex, positionLocal.xz.div(cs).add(vec2(0.5, 0.5)));
  const s0 = slots[0],
    s1 = slots[1],
    s2 = slots[2];
  const iuv0 = positionWorld.xz.mul(ws).mul(s0.uUVScale);
  const iuv1 = positionWorld.xz.mul(ws).mul(s1.uUVScale);
  const iuv2 = positionWorld.xz.mul(ws).mul(s2.uUVScale);
  let out = col;
  out = mix(out, texture(s0.albedoTex, iuv0).rgb, imgW.r.mul(s0.uHasAlbedo));
  out = out.mul(mix(float(1), texture(s0.ormTex, iuv0).r, imgW.r.mul(s0.uHasAO).mul(s0.uAOStr)));
  out = mix(out, texture(s1.albedoTex, iuv1).rgb, imgW.g.mul(s1.uHasAlbedo));
  out = out.mul(mix(float(1), texture(s1.ormTex, iuv1).r, imgW.g.mul(s1.uHasAO).mul(s1.uAOStr)));
  out = mix(out, texture(s2.albedoTex, iuv2).rgb, imgW.b.mul(s2.uHasAlbedo));
  out = out.mul(mix(float(1), texture(s2.ormTex, iuv2).r, imgW.b.mul(s2.uHasAO).mul(s2.uAOStr)));
  return out;
}

/** `baseRough` is a float node (e.g. cliff roughness output). */
export function applyImageSlotRoughness(baseRough, cs, worldSize, imgWeightTex, slots, imgWSample) {
  const ws = float(1.0).div(float(worldSize));
  const imgW = imgWSample ?? texture(imgWeightTex, positionLocal.xz.div(cs).add(vec2(0.5, 0.5)));
  const s0 = slots[0],
    s1 = slots[1],
    s2 = slots[2];
  const iuv0 = positionWorld.xz.mul(ws).mul(s0.uUVScale);
  const iuv1 = positionWorld.xz.mul(ws).mul(s1.uUVScale);
  const iuv2 = positionWorld.xz.mul(ws).mul(s2.uUVScale);
  let r = baseRough;
  r = mix(r, texture(s0.ormTex, iuv0).g, imgW.r.mul(s0.uHasRough).mul(s0.uRoughStr));
  r = mix(r, texture(s1.ormTex, iuv1).g, imgW.g.mul(s1.uHasRough).mul(s1.uRoughStr));
  r = mix(r, texture(s2.ormTex, iuv2).g, imgW.b.mul(s2.uHasRough).mul(s2.uRoughStr));
  return clamp(r, float(0.04), float(1));
}

/**
 * Evaluate image slot raw normal in 0-1 space (before normalMap) + total blend weight.
 * Use inside Fn(() => { ... }). Returns { raw: vec3, weight: float }.
 */
export function evaluateImageSlotNormalRaw(worldSize, slots, imgWSample) {
  const ws = float(1.0).div(float(worldSize));
  const imgW = imgWSample;
  const decode = (ormS) => {
    const nmX = ormS.b.mul(2.0).sub(1.0);
    const nmY = ormS.a.mul(2.0).sub(1.0);
    const nmZ = sqrt(max(float(0.0), float(1.0).sub(nmX.mul(nmX)).sub(nmY.mul(nmY))));
    return vec3(nmX.mul(0.5).add(0.5), nmY.mul(0.5).add(0.5), nmZ.mul(0.5).add(0.5));
  };
  const s0 = slots[0],
    s1 = slots[1],
    s2 = slots[2];
  const iuv0 = positionWorld.xz.mul(ws).mul(s0.uUVScale);
  const iuv1 = positionWorld.xz.mul(ws).mul(s1.uUVScale);
  const iuv2 = positionWorld.xz.mul(ws).mul(s2.uUVScale);
  const n0 = decode(texture(s0.ormTex, iuv0));
  const n1 = decode(texture(s1.ormTex, iuv1));
  const n2 = decode(texture(s2.ormTex, iuv2));
  const flatNm = vec3(0.5, 0.5, 1.0);
  const n0e = mix(flatNm, n0, clamp(s0.uNormalStr, float(0), float(1)));
  const n1e = mix(flatNm, n1, clamp(s1.uNormalStr, float(0), float(1)));
  const n2e = mix(flatNm, n2, clamp(s2.uNormalStr, float(0), float(1)));
  const w0 = imgW.r.mul(s0.uHasNormal);
  const w1 = imgW.g.mul(s1.uHasNormal);
  const w2 = imgW.b.mul(s2.uHasNormal);
  const wSum = max(w0.add(w1).add(w2), float(0.001));
  const blended = div(n0e.mul(w0).add(n1e.mul(w1)).add(n2e.mul(w2)), wSum);
  const raw = mix(flatNm, blended, min(wSum, float(1)));
  return { raw, weight: min(wSum, float(1)) };
}

/** Normal detail from painted slots (world XZ UV); blends decoded tangent normals by weight. */
export function createImageSlotNormalNode(cs, worldSize, imgWeightTex, slots, imgWSample) {
  return Fn(() => {
    const imgW = imgWSample ?? texture(imgWeightTex, positionLocal.xz.div(cs).add(vec2(0.5, 0.5)));
    const { raw } = evaluateImageSlotNormalRaw(cs, worldSize, slots, imgW);
    return normalMap(raw, vec2(1.0, 1.0));
  })();
}
