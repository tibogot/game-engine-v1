/**
 * Composable 7-layer splat overlay for TSL NodeMaterials.
 *
 * Uses DataArrayTexture (1 binding for 7 albedos, 1 for 7 ORMs) to stay within
 * the WebGPU 16 texture binding limit. A single 2-layer DataArrayTexture per
 * chunk encodes 7 overlay weights + meadow density.
 *
 * Splatmap encoding (per-chunk 128² RGBA, 2-layer DataArrayTexture — from SplatStore):
 *   layer 0: R=L1, G=L2, B=L3, A=L4
 *   layer 1: R=L5, G=L6, B=L7, A=meadow
 *   Layer 0 (base surface) is implicit: w0 = max(0, 1 - sum(L1..L7)).
 *   Shader normalizes so sum = 1.
 *
 * Height-based blending (UE-style):
 *   Uses albedo luminance as height proxy. When uHeightBlend > 0, taller textures
 *   dominate at weight transitions (e.g. rocks push through grass at edges).
 */
import * as THREE from "three";
import {
  Fn,
  float,
  int,
  vec2,
  vec3,
  texture,
  positionLocal,
  positionWorld,
  mix,
  max,
  clamp,
  sqrt,
  uniform,
  step,
  attribute,
} from "three/tsl";

function makePlaceholderSplatArray() {
  const d = new Uint8Array(1 * 1 * 2 * 4);
  const t = new THREE.DataArrayTexture(d, 1, 1, 2);
  t.format = THREE.RGBAFormat;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

function makePlaceholderHoleTex() {
  const d = new Uint8Array([0, 0, 0, 0]);
  const t = new THREE.DataTexture(d, 1, 1, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

const NUM_LAYERS = 7;
const LUM = vec3(0.299, 0.587, 0.114);

/**
 * @param {object[]} layerSlots — 7 TextureLibrary slots (for per-layer uniforms: uUVScale, uAOStr, etc.)
 * @param {number} chunkSize
 * @param {number} worldSize
 * @param {THREE.DataArrayTexture} albedoArrayTex
 * @param {THREE.DataArrayTexture} ormArrayTex
 */
export function createSplatOverlay(layerSlots, chunkSize, worldSize, albedoArrayTex, ormArrayTex) {
  if (layerSlots.length !== NUM_LAYERS) {
    throw new Error(`createSplatOverlay expects ${NUM_LAYERS} layer slots, got ${layerSlots.length}`);
  }

  const cs = float(chunkSize);
  const invWorldSize = float(1.0 / worldSize);

  // ── splatmap reads (swapped per-chunk in onBeforeRender) ────────────────
  // Both reads come from the same 2-layer DataArrayTexture but use different
  // .depth() indices, which prevents TSL from deduplicating them.
  const splatUV = positionLocal.xz.div(cs).add(vec2(0.5, 0.5));
  const splatTexNode = texture(makePlaceholderSplatArray(), splatUV).depth(int(0));
  const splat1TexNode = texture(makePlaceholderSplatArray(), splatUV).depth(int(1));
  const holeTexNode = texture(makePlaceholderHoleTex(), splatUV);

  // ── uniforms ───────────────────────────────────────────────────────────
  const uSoloLayer = uniform(-1.0);
  const uHeightBlend = uniform(0.0);
  const uHeightContrast = uniform(0.5);
  // 1.0 when the active chunk has any painted hole pixel — used to kill the
  // skirt curtain so it doesn't show up as a wall inside the hole opening.
  const uChunkHasHole = uniform(0.0);

  // ── layer texture samples (from DataArrayTexture) ──────────────────────
  const layerAlbedos = [];
  const layerOrms = [];
  for (let i = 0; i < NUM_LAYERS; i++) {
    const uv = positionWorld.xz.mul(invWorldSize).mul(layerSlots[i].uUVScale);
    layerAlbedos.push(texture(albedoArrayTex, uv).depth(int(i)));
    layerOrms.push(texture(ormArrayTex, uv).depth(int(i)));
  }

  // ── raw splat weights (8 total: base + 7 overlays) ────────────────────
  // These node references are shared across all blend functions.
  // TSL deduplicates the texture reads during compilation.
  const rw1 = splatTexNode.r;
  const rw2 = splatTexNode.g;
  const rw3 = splatTexNode.b;
  const rw4 = splatTexNode.a;
  const rw5 = splat1TexNode.r;
  const rw6 = splat1TexNode.g;
  const rw7 = splat1TexNode.b;
  const meadowW = splat1TexNode.a;

  const sum7 = rw1.add(rw2).add(rw3).add(rw4).add(rw5).add(rw6).add(rw7);
  const w0raw = max(float(0), float(1).sub(sum7));
  const totalW = max(float(1e-5), w0raw.add(sum7));

  // Normalized weights (base + 7 overlays)
  const nw = [
    w0raw.div(totalW),
    rw1.div(totalW), rw2.div(totalW), rw3.div(totalW), rw4.div(totalW),
    rw5.div(totalW), rw6.div(totalW), rw7.div(totalW),
  ];

  // ── layer colors (albedo × AO) ────────────────────────────────────────
  const layerColors = [];
  for (let i = 0; i < NUM_LAYERS; i++) {
    layerColors.push(
      layerAlbedos[i].rgb.mul(mix(float(1), layerOrms[i].g, layerSlots[i].uAOStr)),
    );
  }

  // ── blend functions ────────────────────────────────────────────────────

  function blendColor(baseColor) {
    // Pure weight-blended color
    let blended = baseColor.mul(nw[0]);
    for (let i = 0; i < NUM_LAYERS; i++) {
      blended = blended.add(layerColors[i].mul(nw[i + 1]));
    }

    // Height-based blending (UE-style max-threshold-renormalize)
    const baseH = baseColor.dot(LUM);
    const layerH = layerColors.map((c) => c.dot(LUM));

    let maxWH = nw[0].mul(baseH);
    for (let i = 0; i < NUM_LAYERS; i++) {
      maxWH = max(maxWH, nw[i + 1].mul(layerH[i]));
    }
    const thresh = maxWH.sub(uHeightContrast);

    const aw = [max(float(0), nw[0].mul(baseH).sub(thresh))];
    for (let i = 0; i < NUM_LAYERS; i++) {
      aw.push(max(float(0), nw[i + 1].mul(layerH[i]).sub(thresh)));
    }
    let totalAW = aw[0];
    for (let i = 1; i <= NUM_LAYERS; i++) totalAW = totalAW.add(aw[i]);
    totalAW = max(float(1e-5), totalAW);

    let hBlended = baseColor.mul(aw[0].div(totalAW));
    for (let i = 0; i < NUM_LAYERS; i++) {
      hBlended = hBlended.add(layerColors[i].mul(aw[i + 1].div(totalAW)));
    }

    const finalColor = mix(blended, hBlended, uHeightBlend);

    // Solo mode
    const isSolo = step(float(0), uSoloLayer);
    // Select the solo weight based on uSoloLayer (0=base, 1..7=overlays)
    let soloW = nw[NUM_LAYERS]; // start with last layer
    for (let i = NUM_LAYERS - 1; i >= 0; i--) {
      soloW = mix(nw[i], soloW, step(float(i + 0.5), uSoloLayer));
    }
    const soloColor = vec3(soloW, soloW, soloW);
    return mix(finalColor, soloColor, isSolo);
  }

  function blendRoughness(baseRough) {
    let result = baseRough.mul(nw[0]);
    for (let i = 0; i < NUM_LAYERS; i++) {
      const lr = mix(float(0.88), layerOrms[i].r, layerSlots[i].uRoughStr);
      result = result.add(lr.mul(nw[i + 1]));
    }
    return clamp(result, float(0.04), float(1));
  }

  function blendNormalRaw(baseNormalRaw) {
    const baseNx = baseNormalRaw.x.mul(2).sub(1);
    const baseNy = baseNormalRaw.y.mul(2).sub(1);

    let nx = baseNx.mul(nw[0]);
    let ny = baseNy.mul(nw[0]);
    for (let i = 0; i < NUM_LAYERS; i++) {
      const lnx = layerOrms[i].b.mul(2).sub(1);
      const lny = layerOrms[i].a.mul(2).sub(1);
      nx = nx.add(lnx.mul(nw[i + 1]));
      ny = ny.add(lny.mul(nw[i + 1]));
    }
    const nz = sqrt(max(float(0), float(1).sub(nx.mul(nx)).sub(ny.mul(ny))));
    return vec3(nx.mul(0.5).add(0.5), ny.mul(0.5).add(0.5), nz.mul(0.5).add(0.5));
  }

  function blendNormalStrength(baseNormalStr) {
    let result = baseNormalStr.mul(nw[0]);
    for (let i = 0; i < NUM_LAYERS; i++) {
      result = result.add(layerSlots[i].uNormalStr.mul(nw[i + 1]));
    }
    return result;
  }

  function blendMeadow(col, meadowProcFn) {
    return mix(col, meadowProcFn(), meadowW);
  }

  function holeMask() {
    const surfaceMask = float(1.0).sub(step(float(0.25), holeTexNode.r));
    // Skirt verts get aSkirt=1 from the geometry pool; surface verts get 0.
    // When the chunk has any hole AND this fragment came from a skirt vert,
    // force opacity to 0 so the alphaTest discards the curtain.
    const aSkirt = attribute("aSkirt", "float");
    const skirtKill = float(1.0).sub(aSkirt.mul(uChunkHasHole));
    return surfaceMask.mul(skirtKill);
  }

  return {
    splatTexNode,
    splat1TexNode,
    holeTexNode,
    uSoloLayer,
    uHeightBlend,
    uHeightContrast,
    uChunkHasHole,
    splatWeights: null,
    blendColor,
    blendRoughness,
    blendNormalRaw,
    blendNormalStrength,
    blendMeadow,
    holeMask,
  };
}
