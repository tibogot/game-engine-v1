import * as THREE from "three";
import { MeshStandardNodeMaterial } from "three";
import {
  Fn,
  float,
  vec2,
  vec3,
  texture,
  uv,
  attribute,
  mix,
  clamp,
  dot,
  max,
  sqrt,
  sub,
  add,
} from "three/tsl";
import { uniform } from "three/tsl";
import { normalMap } from "three/tsl";

/**
 * WebGPU-oriented kerb strip material: tiled texture UVs (independent of stripe vertex colors),
 * tone (brightness / contrast / saturation), glTF-style ARM (R=AO, G=roughness, B=metallic).
 */
export function createKerbStripNodeMaterial({ diffuseTex, armTex, normalTex, kerb }) {
  const su = Math.max(0.05, kerb.texUvScaleU ?? 1);
  const sv = Math.max(0.05, kerb.texUvScaleV ?? 1);
  const uTexScale = uniform(new THREE.Vector2(su, sv));
  const uTexOffset = uniform(new THREE.Vector2(kerb.texUvOffsetU ?? 0, kerb.texUvOffsetV ?? 0));
  const uBrightness = uniform(kerb.texBrightness ?? 0);
  const uContrast = uniform(Math.max(0.05, kerb.texContrast ?? 1));
  const uSaturation = uniform(THREE.MathUtils.clamp(kerb.texSaturation ?? 1, 0, 3));
  const uRoughnessMul = uniform(Math.max(0.2, kerb.roughnessMul ?? 1));
  const uMetalness = uniform(THREE.MathUtils.clamp(kerb.metalness ?? 0.02, 0, 1));
  const uNormalStr = uniform(Math.max(0, kerb.normalStrength ?? 0.45));

  const mat = new MeshStandardNodeMaterial({
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    metalness: 0,
    roughness: 1,
  });
  mat.vertexColors = true;

  const texUV = uv().mul(uTexScale).add(uTexOffset);
  const diffS = texture(diffuseTex, texUV);
  const armS = texture(armTex, texUV);
  const normS = texture(normalTex, texUV);

  mat.colorNode = Fn(() => {
    let rgb = diffS.xyz;
    const half = vec3(0.5, 0.5, 0.5);
    rgb = sub(rgb, half).mul(uContrast).add(half);
    rgb = rgb.add(vec3(uBrightness, uBrightness, uBrightness));
    const lum = dot(rgb, vec3(0.299, 0.587, 0.114));
    const lumv = vec3(lum, lum, lum);
    rgb = mix(lumv, rgb, uSaturation);
    rgb = clamp(rgb, vec3(0, 0, 0), vec3(1, 1, 1));
    const vc = attribute("color", "vec3");
    return rgb.mul(vc);
  })();

  mat.roughnessNode = clamp(
    armS.g.mul(float(0.92)).mul(uRoughnessMul),
    float(0.02),
    float(1),
  );

  mat.metalnessNode = clamp(armS.b.mul(uMetalness), float(0), float(1));

  mat.normalNode = Fn(() => {
    const nx = normS.r.mul(2).sub(1);
    const ny = normS.g.mul(2).sub(1);
    const len2 = nx.mul(nx).add(ny.mul(ny));
    const nz = sqrt(max(float(1e-6), float(1).sub(len2)));
    const packed = vec3(
      nx.mul(0.5).add(0.5),
      ny.mul(0.5).add(0.5),
      nz.mul(0.5).add(0.5),
    );
    return normalMap(packed, vec2(uNormalStr, uNormalStr));
  })();

  return { material: mat, uniforms: { uTexScale, uTexOffset, uBrightness, uContrast, uSaturation, uRoughnessMul, uMetalness, uNormalStr } };
}
