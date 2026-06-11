/**
 * Prop PBR node material — TSL MeshStandardNodeMaterial driven by a propTextureLibrary material.
 *
 * Reads albedo / normal / roughness / AO as 4 separate plain textures (not packed),
 * tiles them by the material's per-material `uUVScale`, and applies normal/AO/rough
 * strength via TSL uniforms shared with the library. Changing those uniforms updates
 * every prop using this material instantly.
 *
 * Two projection modes:
 *  - `triplanar=false` (default) — sample by mesh UVs (`uv()`). Cheap, classic.
 *  - `triplanar=true` — sample 3× projected from world axes XZ/XY/ZY and blend by
 *     |normalWorld|^4. No UV stretching on scaled meshes; tiles seamlessly across
 *     adjacent props. ~3× texture-sample cost. Normals are averaged in tangent
 *     space (approximation — visually fine for stylized use; not AAA-correct RNM).
 */
import * as THREE from "three";
import {
  Fn,
  float,
  vec2,
  vec3,
  uv,
  texture,
  mix,
  clamp,
  normalMap,
  positionWorld,
  normalWorld,
} from "three/tsl";

const TRIPLANAR_SHARPNESS = 4.0;

/**
 * @param {ReturnType<typeof import("../../core/textures/propTextureLibrary.js").createPropTextureLibrary>["materials"][number]} propMat
 * @param {{ triplanar?: boolean }} [opts]
 */
export function createPropPbrNodeMaterial(propMat, opts = {}) {
  const triplanar = !!opts.triplanar;
  const mat = new THREE.MeshStandardNodeMaterial({
    roughness: 0.6,
    metalness: 0.0,
  });

  let albedoNode, normalNodeTex, roughNode, aoNode;

  if (!triplanar) {
    const tileUv = uv().mul(propMat.uUVScale);
    albedoNode = texture(propMat.albedoTex, tileUv);
    normalNodeTex = texture(propMat.normalTex, tileUv);
    roughNode = texture(propMat.roughnessTex, tileUv);
    aoNode = texture(propMat.aoTex, tileUv);
  } else {
    const sharp = float(TRIPLANAR_SHARPNESS);
    const wRaw = normalWorld.abs().pow(sharp);
    const wN = wRaw.div(wRaw.x.add(wRaw.y).add(wRaw.z));
    const wX = wN.x;
    const wY = wN.y;
    const wZ = wN.z;

    const scale = propMat.uUVScale;
    const uvXZ = positionWorld.xz.mul(scale);
    const uvXY = positionWorld.xy.mul(scale);
    const uvZY = positionWorld.zy.mul(scale);

    const triSampleRGB = (tex) =>
      texture(tex, uvXZ).rgb.mul(wY)
        .add(texture(tex, uvXY).rgb.mul(wZ))
        .add(texture(tex, uvZY).rgb.mul(wX));

    albedoNode = { rgb: triSampleRGB(propMat.albedoTex) };
    normalNodeTex = { rgb: triSampleRGB(propMat.normalTex) };
    roughNode = { r: triSampleRGB(propMat.roughnessTex).r };
    aoNode = { r: triSampleRGB(propMat.aoTex).r };
  }

  mat.colorNode = Fn(() => {
    const col = albedoNode.rgb;
    const ao = aoNode.r;
    return col.mul(mix(float(1.0), ao, propMat.uAOStr));
  })();

  mat.roughnessNode = Fn(() => {
    return clamp(
      mix(float(0.6), roughNode.r, propMat.uRoughStr),
      float(0.04),
      float(1.0),
    );
  })();

  mat.normalNode = Fn(() => {
    return normalMap(normalNodeTex.rgb, vec2(propMat.uNormalStr, propMat.uNormalStr));
  })();

  mat.userData.propMaterialId = propMat.id;
  mat.userData.triplanar = triplanar;
  return mat;
}
