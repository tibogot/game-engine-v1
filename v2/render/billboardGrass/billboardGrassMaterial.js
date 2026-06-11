/**
 * Procedural TSL material for billboard ground cover.
 * Single light shader: color ramp + alpha mask + wind tex shade + vertex sway.
 * Distance fade lives in colorNode (alpha multiplier) so positionWorld is safe.
 */
import * as THREE from "three";
import { MeshLambertNodeMaterial } from "three";
import {
  Fn,
  uv,
  vec2,
  vec3,
  vec4,
  sin,
  uniform,
  texture,
  positionLocal,
  positionWorld,
  color,
  cameraPosition,
  mix,
  float,
  length,
  smoothstep,
} from "three/tsl";
import { noise12 } from "../../core/foliage/tsl-utils.js";

/**
 * @param {object} slot — optional slot._maskNode (TSL texture node)
 * @param {THREE.Texture} windTex
 * @param {THREE.Vector3} [sunDirection] — accepted for API compatibility (no longer used)
 */
export function createBillboardGrassMaterial(slot, windTex, _sunDirection) {
  const u = {
    time: uniform(0),
    colorBottom: uniform(color(slot.colorBottom ?? "#1a4d12")),
    colorMid: uniform(color(slot.colorMid ?? "#3d8f2a")),
    colorTop: uniform(color(slot.colorTop ?? "#6bc44a")),
    noiseScale: uniform(slot.noiseScale ?? 4),
    noiseStrength: uniform(slot.noiseStrength ?? 0.35),
    windScrollSpeed: uniform(slot.windScrollSpeed ?? 0.08),
    windScrollScale: uniform(slot.windScrollScale ?? 2),
    windShadeStrength: uniform(slot.windShadeStrength ?? 0.4),
    swaySpeed: uniform(slot.swaySpeed ?? 1.5),
    swayStrength: uniform(slot.swayStrength ?? 0.08),
    groundOcclusion: uniform(slot.groundOcclusion ?? 0.75),
    maskInAlpha: uniform(slot.maskInAlpha ?? 0.0),
    fadeStart: uniform(slot.fadeStart ?? 220),
    fadeEnd: uniform(slot.fadeEnd ?? 280),
  };

  const material = new MeshLambertNodeMaterial({
    side: THREE.DoubleSide,
    alphaTest: slot.alphaTest ?? 0.35,
    transparent: false,
  });

  material.normalNode = vec3(0, 1, 0);

  const maskNode = slot._maskNode ?? null;
  const fallbackBlade = uv().y.pow(1.15);

  material.colorNode = Fn(() => {
    const h = uv().y;
    const lowMid = mix(u.colorBottom, u.colorMid, h.smoothstep(float(0), float(0.55)));
    let col = mix(lowMid, u.colorTop, h.smoothstep(float(0.3), float(1)));

    const nUv = positionWorld.xz.mul(u.noiseScale);
    const n = noise12(nUv).mul(2).sub(1);
    col = col.mul(float(1).add(n.mul(u.noiseStrength)));

    const scroll = vec2(u.time.mul(u.windScrollSpeed), u.time.mul(u.windScrollSpeed.mul(0.35)));
    const windUv = positionWorld.xz.mul(u.windScrollScale).add(scroll);
    const windS = texture(windTex, windUv).g;
    const windMod = windS.mul(u.windShadeStrength).add(float(1).sub(u.windShadeStrength.mul(0.5)));
    col = col.mul(windMod);

    const ao = h.smoothstep(float(0), u.groundOcclusion).add(0.18);
    col = col.mul(ao);

    let alpha = fallbackBlade;
    if (maskNode) {
      alpha = mix(maskNode.r, maskNode.a, u.maskInAlpha);
    }

    const dx = cameraPosition.x.sub(positionWorld.x);
    const dz = cameraPosition.z.sub(positionWorld.z);
    const distXZ = length(vec2(dx, dz));
    const fadeK = float(1).sub(smoothstep(u.fadeStart, u.fadeEnd, distXZ));
    alpha = alpha.mul(fadeK);

    return vec4(col, alpha);
  })();

  material.positionNode = Fn(() => {
    const sway = sin(u.time.mul(u.swaySpeed))
      .mul(u.swayStrength)
      .mul(uv().y.pow(1.4));
    return vec3(positionLocal.x.add(sway), positionLocal.y, positionLocal.z.add(sway));
  })();

  return { material, uniforms: u };
}

export function applyBillboardGrassUniforms(u, slot) {
  if (!u || !slot) return;
  if (slot.colorBottom != null && u.colorBottom) u.colorBottom.value.set(slot.colorBottom);
  if (slot.colorMid != null && u.colorMid) u.colorMid.value.set(slot.colorMid);
  if (slot.colorTop != null && u.colorTop) u.colorTop.value.set(slot.colorTop);
  if (slot.noiseScale != null && u.noiseScale) u.noiseScale.value = slot.noiseScale;
  if (slot.noiseStrength != null && u.noiseStrength) u.noiseStrength.value = slot.noiseStrength;
  if (slot.windScrollSpeed != null && u.windScrollSpeed) u.windScrollSpeed.value = slot.windScrollSpeed;
  if (slot.windScrollScale != null && u.windScrollScale) u.windScrollScale.value = slot.windScrollScale;
  if (slot.windShadeStrength != null && u.windShadeStrength) u.windShadeStrength.value = slot.windShadeStrength;
  if (slot.swaySpeed != null && u.swaySpeed) u.swaySpeed.value = slot.swaySpeed;
  if (slot.swayStrength != null && u.swayStrength) u.swayStrength.value = slot.swayStrength;
  if (slot.groundOcclusion != null && u.groundOcclusion) u.groundOcclusion.value = slot.groundOcclusion;
  if (slot.maskInAlpha != null && u.maskInAlpha) u.maskInAlpha.value = slot.maskInAlpha;
}
