import * as THREE from "three";
import {
  Fn, hash, instanceIndex, float, max, mix, positionLocal, pow, saturate, sin, time, uniform, vec3, PI2,
} from "three/tsl";

/**
 * WIND SWAY FOR PLACED PLANTS (imported GLB bushes and shrubs, placedPlants.js).
 *
 * The painted plants sway from the scatter compute, which knows each plant's
 * world position and can push the whole field one way. A PLACED plant is an
 * ordinary instanced prop, and a prop's vertex shader runs BEFORE the instance
 * transform (three applies instanceMatrix to positionLocal after the material's
 * positionNode, InstanceNode.js): inside the shader a plant does not know
 * where it stands or which way it faces. So this sway is LOCAL: every plant
 * sways on its own phase rather than the whole row leaning downwind together.
 * For bushes and shrubs that reads as wind; a field of tall thin plants would
 * want the painted system instead.
 *
 * The bend grows with height (h^1.6), so the roots stay put and the crown
 * moves — the same rule the painted plants use. A second, faster term wobbles
 * the leaves across the plant so it is not one rigid block.
 *
 * Shadows follow: the shadow pass reads the same positionNode.
 */

/** Wind numbers a plant material needs; one set per plant type. */
export function createSwayUniforms() {
  return {
    uSwayAmp: uniform(0),        // metres the crown travels
    uSwaySpeed: uniform(0.9),
    uLeafAmp: uniform(0),        // the smaller leaf wobble, metres
    uPlantHeight: uniform(1),    // the type's unscaled height
  };
}

/**
 * Sway a plant material in place.
 * @param {THREE.Material} material a node material (see toPlantNodeMaterial)
 * @param {ReturnType<createSwayUniforms>} u
 */
export function applySway(material, u) {
  material.positionNode = Fn(() => {
    const p = positionLocal;
    const h = saturate(p.y.div(max(u.uPlantHeight, float(0.01))));
    const bend = pow(h, float(1.6));
    const phase = hash(instanceIndex).mul(PI2);
    const t = time.mul(u.uSwaySpeed);
    // Two waves an octave apart: a gust that never repeats on the beat.
    const swayX = sin(t.add(phase)).mul(0.65).add(sin(t.mul(1.73).add(phase.mul(1.7))).mul(0.35));
    const swayZ = sin(t.mul(0.87).add(phase.mul(2.3))).mul(0.8);
    const amp = u.uSwayAmp.mul(bend);
    // Leaves shimmer faster and everywhere on the plant, not just up top.
    const leaf = sin(t.mul(3.7).add(p.x.mul(7.3)).add(p.z.mul(5.1)).add(phase))
      .mul(u.uLeafAmp).mul(mix(float(0.35), float(1), h));
    return vec3(
      p.x.add(swayX.mul(amp)).add(leaf),
      p.y,
      p.z.add(swayZ.mul(amp)).add(leaf.mul(0.6)),
    );
  })();
  material.needsUpdate = true;
  return material;
}

/** The standard-material properties a plant keeps when it becomes a node material. */
const COPY_KEYS = [
  "color", "roughness", "metalness", "emissive", "emissiveIntensity", "opacity",
  "map", "normalMap", "normalScale", "roughnessMap", "metalnessMap", "aoMap", "aoMapIntensity",
  "emissiveMap", "alphaMap", "bumpMap", "bumpScale", "displacementMap", "lightMap", "envMapIntensity",
  "side", "shadowSide", "transparent", "opacity", "alphaTest", "alphaToCoverage", "depthWrite",
  "depthTest", "vertexColors", "flatShading", "wireframe", "toneMapped", "fog", "name", "visible",
];

/**
 * A MeshStandardNodeMaterial carrying the same look as a GLB's material, so a
 * positionNode can be attached. The loader hands back plain MeshStandardMaterials,
 * which the WebGPU renderer maps internally — that mapped copy is not reachable,
 * so a sway needs a node material of our own.
 * @param {THREE.Material} src
 */
export function toPlantNodeMaterial(src) {
  if (src?.isNodeMaterial) return src;
  const out = new THREE.MeshStandardNodeMaterial();
  for (const k of COPY_KEYS) {
    if (src?.[k] === undefined) continue;
    const v = src[k];
    out[k] = v && v.isColor ? v.clone() : v && v.isVector2 ? v.clone() : v;
  }
  out.userData = { ...src.userData, swayFrom: src.uuid };
  return out;
}
