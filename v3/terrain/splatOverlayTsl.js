/**
 * V3 splat overlay — 7-layer blend for TSL terrain material.
 *
 * Adapted from V2's splatOverlayTsl.js.  Key differences:
 *  - Uses positionWorld (not positionLocal) for UV — no chunks in V3.
 *  - The splatmap is a single global 512×512×2 DataArrayTexture passed in directly.
 *  - No per-chunk onBeforeRender swapping needed.
 *  - holeMask() removed (V3 has no terrain holes yet).
 *
 * Sampler budget (within WebGPU 16-limit):
 *   splatArrayNode  = 1 binding (2 depth slices, shared)
 *   albedoArrayNode = 1 binding (7 depth slices)
 *   ormArrayNode    = 1 binding (7 depth slices)
 *   → 3 additional bindings for the full 7-layer paint system
 */
import * as THREE from "three";
import { stochasticSampleArray } from "../../v2/core/legacy/stochasticTex.js";
import {
  Fn, float, int, vec2, vec3,
  texture, mix, max, clamp, sqrt, uniform, step, normalize,
  positionWorld,
} from "three/tsl";
import { WORLD_SIZE } from "./heightmapTexture.js";

const NUM_LAYERS = 7;
const LUM        = vec3(0.299, 0.587, 0.114);

/**
 * @param {object[]} layerSlots  — 7 objects, each with TSL uniforms:
 *   { uUVScale, uNormalStr, uAOStr, uRoughStr }
 * @param {THREE.DataArrayTexture} albedoArrayTex — 7-layer albedo array
 * @param {THREE.DataArrayTexture} ormArrayTex    — 7-layer ORM array
 *   ORM packing: R=roughness, G=AO, B=normalX_encoded, A=normalY_encoded
 * @param {THREE.DataArrayTexture} splatTex       — SplatMap.tex (2-slice weight map)
 */
export function createSplatOverlay(layerSlots, albedoArrayTex, ormArrayTex, splatTex) {
  if (layerSlots.length !== NUM_LAYERS) {
    throw new Error(`createSplatOverlay: need ${NUM_LAYERS} layer slots, got ${layerSlots.length}`);
  }

  const invWS = float(1.0 / WORLD_SIZE);

  // ── Splatmap (weight map) ────────────────────────────────────────────────────
  // World UV: world[-1024..1024] → [0..1]
  const splatUV        = positionWorld.xz.add(float(WORLD_SIZE * 0.5)).div(float(WORLD_SIZE));
  const splatArrayNode = texture(splatTex, splatUV);
  const splatSlice0    = splatArrayNode.depth(int(0)); // L1..L4
  const splatSlice1    = splatArrayNode.depth(int(1)); // L5..L7 + meadow

  // Zero out splat weights outside terrain bounds — prevents ClampToEdgeWrapping
  // from bleeding edge-pixel paint onto out-of-bounds geometry on outer LOD rings.
  const inBounds = step(float(0), splatUV.x).mul(step(splatUV.x, float(1)))
                   .mul(step(float(0), splatUV.y)).mul(step(splatUV.y, float(1)));

  // ── Per-layer blend controls ──────────────────────────────────────────────────
  const uSoloLayer      = uniform(-1.0);
  const uHeightBlend    = uniform(0.0);
  const uHeightContrast = uniform(0.5);

  // ── Layer texture samples — 2 DataArrayTexture bindings for 7 layers ─────────
  const albedoArrNode = texture(albedoArrayTex);
  const ormArrNode    = texture(ormArrayTex);

  const layerAlbedos = [];
  const layerOrms    = [];
  for (let i = 0; i < NUM_LAYERS; i++) {
    const uv = positionWorld.xz.mul(invWS).mul(layerSlots[i].uUVScale);
    layerAlbedos.push(stochasticSampleArray(albedoArrNode, uv, int(i)));
    layerOrms.push(ormArrNode.sample(uv).depth(int(i)));
  }

  // ── Weight extraction ─────────────────────────────────────────────────────────
  const rw1 = splatSlice0.r.mul(inBounds), rw2 = splatSlice0.g.mul(inBounds);
  const rw3 = splatSlice0.b.mul(inBounds), rw4 = splatSlice0.a.mul(inBounds);
  const rw5 = splatSlice1.r.mul(inBounds), rw6 = splatSlice1.g.mul(inBounds), rw7 = splatSlice1.b.mul(inBounds);
  const meadowW = splatSlice1.a.mul(inBounds);

  const sum7   = rw1.add(rw2).add(rw3).add(rw4).add(rw5).add(rw6).add(rw7);
  const w0raw  = max(float(0), float(1).sub(sum7));
  const totalW = max(float(1e-5), w0raw.add(sum7));

  const nw = [
    w0raw.div(totalW),
    rw1.div(totalW), rw2.div(totalW), rw3.div(totalW), rw4.div(totalW),
    rw5.div(totalW), rw6.div(totalW), rw7.div(totalW),
  ];

  // ── Layer colors (albedo × AO) ────────────────────────────────────────────────
  const layerColors = [];
  for (let i = 0; i < NUM_LAYERS; i++) {
    layerColors.push(
      layerAlbedos[i].rgb.mul(mix(float(1), layerOrms[i].g, layerSlots[i].uAOStr)),
    );
  }

  // ── Blend functions (called from terrainLOD material) ────────────────────────

  function blendColor(baseColor) {
    // Linear weight blend
    let blended = baseColor.mul(nw[0]);
    for (let i = 0; i < NUM_LAYERS; i++) blended = blended.add(layerColors[i].mul(nw[i+1]));

    // Height-based blend (UE-style: luminance as height proxy)
    const baseH  = baseColor.dot(LUM);
    const layerH = layerColors.map(c => c.dot(LUM));
    let maxWH = nw[0].mul(baseH);
    for (let i = 0; i < NUM_LAYERS; i++) maxWH = max(maxWH, nw[i+1].mul(layerH[i]));
    const thresh = maxWH.sub(uHeightContrast);

    const aw = [max(float(0), nw[0].mul(baseH).sub(thresh))];
    for (let i = 0; i < NUM_LAYERS; i++) aw.push(max(float(0), nw[i+1].mul(layerH[i]).sub(thresh)));
    let totalAW = aw[0];
    for (let i = 1; i <= NUM_LAYERS; i++) totalAW = totalAW.add(aw[i]);
    totalAW = max(float(1e-5), totalAW);

    let hBlended = baseColor.mul(aw[0].div(totalAW));
    for (let i = 0; i < NUM_LAYERS; i++) hBlended = hBlended.add(layerColors[i].mul(aw[i+1].div(totalAW)));

    const finalColor = mix(blended, hBlended, uHeightBlend);

    // Solo mode (grayscale single-layer visualisation)
    const isSolo = step(float(0), uSoloLayer);
    let soloW = nw[NUM_LAYERS];
    for (let i = NUM_LAYERS - 1; i >= 0; i--) {
      soloW = mix(nw[i], soloW, step(float(i + 0.5), uSoloLayer));
    }
    return mix(finalColor, vec3(soloW, soloW, soloW), isSolo);
  }

  function blendRoughness(baseRough) {
    let result = baseRough.mul(nw[0]);
    for (let i = 0; i < NUM_LAYERS; i++) {
      const lr = mix(float(0.88), layerOrms[i].r, layerSlots[i].uRoughStr);
      result = result.add(lr.mul(nw[i+1]));
    }
    return clamp(result, float(0.04), float(1));
  }

  /**
   * Decode per-layer tangent-space normals from ORM.ba and blend with splatmap weights.
   * Returns a world-space normalized direction — caller transforms to view space.
   * Terrain TBN: T=(1,0,0)  B=(0,0,1)  N=geomWorldNormal  (XZ-plane world UV mapping).
   */
  function blendNormal(geomWorldNormal) {
    let accumN = geomWorldNormal.mul(nw[0]);
    for (let i = 0; i < NUM_LAYERS; i++) {
      const orm = layerOrms[i];
      const nx  = orm.b.mul(float(2.0)).sub(float(1.0));
      const ny  = orm.a.mul(float(2.0)).sub(float(1.0));
      const nz  = sqrt(max(float(0.0), float(1.0).sub(nx.mul(nx)).sub(ny.mul(ny))));
      // TBN transform: T*nx + B*ny + N*nz  →  (nx, 0, ny) + geomN*nz
      const worldN = normalize(vec3(nx, float(0), ny).add(geomWorldNormal.mul(nz)));
      // Lerp between pure geometric normal and normal-mapped based on per-layer strength
      const layerN = mix(geomWorldNormal, worldN, layerSlots[i].uNormalStr);
      accumN = accumN.add(layerN.mul(nw[i + 1]));
    }
    return normalize(accumN);
  }

  function blendMeadow(col, meadowFn) {
    return mix(col, meadowFn(), meadowW);
  }

  return {
    uSoloLayer,
    uHeightBlend,
    uHeightContrast,
    blendColor,
    blendRoughness,
    blendNormal,
    blendMeadow,
  };
}
