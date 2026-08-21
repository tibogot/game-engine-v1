/**
 * Cliff ⇄ terrain visual blend — Genshin/Zelda-style cliffs that read as part
 * of the terrain instead of props sitting on it.
 *
 * Wraps an existing prop node material (triplanar rock PBR or the grey
 * default) with two per-pixel masks:
 *
 *  1. Top grass — up-facing surfaces (normalWorld.y) take the terrain's
 *     painted color, so walkable cliff tops match the ground around them.
 *  2. Contact band — fragments within a short band above the terrain surface
 *     (sampled per-pixel from the live GPU heightmap) fade to terrain
 *     color/roughness and ease the lighting normal toward the terrain's
 *     gradient normal, so the base seam disappears. The band edge is dithered
 *     by the rock albedo's luminance so it never reads as a straight line.
 *
 * Terrain color comes from the shared splat overlay (positionWorld-keyed, so
 * the same node graph works on any mesh) — painted layers show up on cliff
 * tops/skirts automatically, and repaints update live.
 */
import * as THREE from "three";
import {
  float,
  vec2,
  vec3,
  vec4,
  mul,
  mix,
  max,
  clamp,
  step,
  smoothstep,
  texture,
  uniform,
  normalize,
  positionWorld,
  normalWorld,
  cameraViewMatrix,
  materialColor,
  materialRoughness,
  materialNormal,
  mx_noise_float,
} from "three/tsl";
import { HEIGHTMAP_SIZE, WORLD_SIZE, MAX_HEIGHT } from "../terrain/heightmapTexture.js";

const LUM = vec3(0.299, 0.587, 0.114);

/**
 * Mutates `mat` in place (colorNode / roughnessNode / normalNode) and returns it.
 * Tweakable uniforms land in `mat.userData.cliffBlend` for a future UI panel.
 *
 * @param {THREE.MeshStandardNodeMaterial} mat — from createMaterialForLibrary
 * @param {{ heightTexNode: object, splatOverlay: object, cliffPaintTex?: THREE.Texture }} deps
 *   heightTexNode — the shared TSL texture node whose .value sculptBrush swaps
 *   splatOverlay  — return of createSplatOverlay (blend())
 *   cliffPaintTex — optional CliffPaintMask texture (R = strength); painted
 *                   areas force the terrain look regardless of slope/height
 */
export function applyCliffTerrainBlend(mat, { heightTexNode, splatOverlay, cliffPaintTex = null, terrainNormals = null }) {
  const uTopStart     = uniform(0.6);  // normalWorld.y where grass starts
  const uTopFull      = uniform(0.85); // normalWorld.y where grass is full
  const uTopNoiseScale = uniform(0.06); // world-XZ noise frequency on the top edge (v2 parity)
  const uTopNoiseStr   = uniform(0.15); // slope offset amplitude of that noise
  const uContactBand  = uniform(1.6);  // metres above terrain the skirt fades over
  const uBandNoise    = uniform(0.9);  // metres of albedo-luminance dither on the band edge
  const uTerrainBase  = uniform(new THREE.Color(0xe6e3e3)); // unpainted terrain base

  // Base rock look — fall back to the material's plain properties: the grey
  // "none" material and converted GLB materials set no nodes, and the
  // material* accessors pick up their map/roughnessMap/normalMap if present.
  const rockColor  = mat.colorNode ?? materialColor;
  const rockRough  = mat.roughnessNode ?? materialRoughness;
  const rockNormal = mat.normalNode ?? materialNormal;

  // ── Terrain height + gradient normal at the fragment's world XZ ────────────
  // Same sampling scheme as terrainLOD so the two surfaces can never disagree.
  const texel = float(1.0 / HEIGHTMAP_SIZE);
  const hmU   = positionWorld.x.add(float(WORLD_SIZE * 0.5)).div(float(WORLD_SIZE));
  const hmV   = positionWorld.z.add(float(WORLD_SIZE * 0.5)).div(float(WORLD_SIZE));
  const hmUV  = vec2(hmU, hmV);
  const inBounds = step(float(0), hmU).mul(step(hmU, float(1)))
                  .mul(step(float(0), hmV)).mul(step(hmV, float(1)));

  const terrainY = texture(heightTexNode, hmUV).r.mul(float(MAX_HEIGHT));

  // Same baked normal the terrain itself reads (one tap instead of four), so
  // the contact band cannot disagree with the ground it is blending into.
  const terrainWorldN = terrainNormals
    ? terrainNormals.normalAt(hmUV)
    : normalize(vec3(
        texture(heightTexNode, vec2(hmU.sub(texel), hmV)).r
          .sub(texture(heightTexNode, vec2(hmU.add(texel), hmV)).r),
        float(2.0 * WORLD_SIZE / (HEIGHTMAP_SIZE * MAX_HEIGHT)),
        texture(heightTexNode, vec2(hmU, hmV.sub(texel))).r
          .sub(texture(heightTexNode, vec2(hmU, hmV.add(texel))).r),
      ));
  const terrainViewN  = normalize(mul(cameraViewMatrix, vec4(terrainWorldN, 0)).xyz);

  // ── Terrain look at this XZ (painted splat over the plain base) ────────────
  // One blend() call per material — color and roughness come back as members of
  // one gated struct (see splatOverlayTsl.js), never as separate blend calls.
  const terrainBlend = splatOverlay.blend({
    baseColor: uTerrainBase,
    baseRough: float(0.95),
  });
  const terrainColor = terrainBlend.color;
  const terrainRough = terrainBlend.rough;

  // ── Masks ──────────────────────────────────────────────────────────────────
  // World-XZ noise wobbles the slope threshold so the grass edge on tops is
  // irregular instead of a clean contour line (same trick as v2's blend mat).
  const slopeNoise = mx_noise_float(positionWorld.xz.mul(uTopNoiseScale)).mul(uTopNoiseStr);
  const topMask = smoothstep(uTopStart, uTopFull, normalWorld.y.add(slopeNoise));

  const bandJitter  = rockColor.dot(LUM).sub(float(0.5)).mul(uBandNoise);
  const heightAbove = positionWorld.y.sub(terrainY).add(bandJitter);
  const contact     = float(1).sub(smoothstep(float(0), uContactBand, heightAbove))
                        .mul(inBounds);

  // Manual paint override (v2 CliffPaintMask parity) — world-XZ projected,
  // R channel forces the terrain look wherever the user painted.
  let blend = clamp(max(topMask, contact), float(0), float(1)).mul(inBounds);
  if (cliffPaintTex) {
    blend = max(blend, texture(cliffPaintTex, hmUV).r.mul(inBounds));
  }

  mat.colorNode     = mix(rockColor, terrainColor, blend);
  mat.roughnessNode = mix(rockRough, terrainRough, blend);
  // Only the contact band borrows the terrain's lighting normal — cliff tops
  // keep their own shape, they just wear the terrain's color.
  mat.normalNode    = normalize(mix(rockNormal, terrainViewN, contact));

  mat.userData.cliffBlend = {
    uTopStart, uTopFull, uTopNoiseScale, uTopNoiseStr,
    uContactBand, uBandNoise, uTerrainBase,
  };
  return mat;
}

/**
 * Cliff blend for an imported GLB submesh material — keeps the GLB's own
 * textures as the rock look (unlike v2, which swapped in one shared triplanar
 * rock material) and layers the same terrain top/contact blend on top.
 *
 * GLTFLoader hands back plain MeshStandardMaterials, which can't take TSL
 * nodes, so the material is first converted to a MeshStandardNodeMaterial.
 * Node-material .copy() only transfers node slots — the standard PBR props
 * (color/map/normalMap/roughness/…) must be pulled across via the standard
 * prototype. The material* fallback nodes in applyCliffTerrainBlend then read
 * those maps automatically.
 *
 * @param {THREE.Material} srcMat — the GLB submesh material
 * @param {{ heightTexNode: object, splatOverlay: object }} deps
 * @returns {THREE.MeshStandardNodeMaterial} a new blended material (srcMat untouched)
 */
export function createCliffGlbBlendMaterial(srcMat, deps) {
  if (srcMat.isNodeMaterial) return applyCliffTerrainBlend(srcMat, deps);
  const nodeMat = new THREE.MeshStandardNodeMaterial();
  THREE.MeshStandardMaterial.prototype.copy.call(nodeMat, srcMat);
  return applyCliffTerrainBlend(nodeMat, deps);
}
