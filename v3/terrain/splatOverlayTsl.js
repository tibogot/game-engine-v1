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
  positionWorld, smoothstep, abs, length, mx_noise_float,
} from "three/tsl";
import { WORLD_SIZE, HEIGHTMAP_SIZE, MAX_HEIGHT } from "./heightmapTexture.js";

const NUM_LAYERS = 7;
const LUM        = vec3(0.299, 0.587, 0.114);

/**
 * COMPILE-TIME feature set. Every one of these used to be present in the shader
 * unconditionally and switched off by a uniform through `mix()` — which does not
 * skip anything: both sides are evaluated and the unwanted one is multiplied by
 * zero. So an author using none of these still paid for all of them, on every
 * pixel, forever.
 *
 * Turning a flag off here removes the nodes from the graph entirely, so the
 * instructions are never generated. The uniforms are still created and still
 * exported either way, so callers, the dev panel and the save format do not
 * change shape — a disabled feature simply stops being wired into the output.
 *
 * Defaults are ALL ON, i.e. bit-for-bit the previous shader. The editor keeps
 * them; a game build turns off what it cannot reach.
 */
export const SPLAT_FEATURES = {
  /** Slope/height auto-material rules. Costs 5 heightmap taps + an FBM noise. */
  autoPaint: true,
  /** UE-style luminance height blending between layers (uHeightBlend). */
  heightBlend: true,
  /** Single-layer greyscale visualisation — EDITOR ONLY, never used in a game. */
  solo: true,
  /** Per-layer tangent-space normal mapping from ORM.ba. */
  normalMap: true,
};

/**
 * @param {object[]} layerSlots  — 7 objects, each with TSL uniforms:
 *   { uUVScale, uNormalStr, uAOStr, uRoughStr }
 * @param {THREE.DataArrayTexture} albedoArrayTex — 7-layer albedo array
 * @param {THREE.DataArrayTexture} ormArrayTex    — 7-layer ORM array
 *   ORM packing: R=roughness, G=AO, B=normalX_encoded, A=normalY_encoded
 * @param {THREE.DataArrayTexture} splatTex       — SplatMap.tex (2-slice weight map)
 * @param {?object} heightTexNode
 * @param {object} [features] — COMPILE-TIME switches; see SPLAT_FEATURES.
 */
export function createSplatOverlay(
  layerSlots, albedoArrayTex, ormArrayTex, splatTex, heightTexNode = null, features = {},
) {
  if (layerSlots.length !== NUM_LAYERS) {
    throw new Error(`createSplatOverlay: need ${NUM_LAYERS} layer slots, got ${layerSlots.length}`);
  }
  const F = { ...SPLAT_FEATURES, ...features };

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

  // ── Live auto-paint (Unreal-style auto-material) ─────────────────────────
  // Slope/height rules texture the UNPAINTED remainder (the implicit base
  // weight w0): flat layer on level ground, cliff layer past a slope band,
  // optional high-altitude layer above a height band. Updates live while
  // sculpting; hand-painted splat always wins because painting shrinks w0.
  const uAutoEnabled   = uniform(0.0);
  const uAutoFull      = uniform(0.0);   // 1 = preview bake result everywhere (ignores current paint)
  const uAutoFlat      = uniform(0.0);   // layer channel 0..6 (L1..L7)
  const uAutoCliff     = uniform(1.0);
  const uAutoHigh      = uniform(-1.0);  // -1 = high-altitude rule off
  const uAutoSlopeHiY  = uniform(Math.cos(30 * Math.PI / 180)); // normal.y where cliff starts
  const uAutoSlopeLoY  = uniform(Math.cos(45 * Math.PI / 180)); // normal.y at full cliff
  const uAutoHighStart = uniform(200.0); // metres
  const uAutoHighEnd   = uniform(280.0);
  const uAutoNoise     = uniform(0.25);  // threshold breakup 0..1

  if (heightTexNode && F.autoPaint) {
    // Terrain normal.y from the same heightmap gradient the terrain mesh uses.
    const texel = float(1.0 / HEIGHTMAP_SIZE);
    const hC = texture(heightTexNode, splatUV).r;
    const hL = texture(heightTexNode, vec2(splatUV.x.sub(texel), splatUV.y)).r;
    const hR = texture(heightTexNode, vec2(splatUV.x.add(texel), splatUV.y)).r;
    const hD = texture(heightTexNode, vec2(splatUV.x, splatUV.y.sub(texel))).r;
    const hU = texture(heightTexNode, vec2(splatUV.x, splatUV.y.add(texel))).r;
    const flatScale = float(2.0 * WORLD_SIZE / (HEIGHTMAP_SIZE * MAX_HEIGHT));
    const ny = flatScale.div(length(vec3(hL.sub(hR), flatScale, hD.sub(hU))));

    // World-anchored FBM breakup so the slope/height thresholds meander
    // organically instead of tracing clean contour lines.
    const bp = positionWorld.xz.mul(float(0.02));
    const breakup = mx_noise_float(vec3(bp.x, bp.y, float(7.7))).mul(uAutoNoise);

    const cliffW = float(1).sub(
      smoothstep(uAutoSlopeLoY, uAutoSlopeHiY, ny.add(breakup.mul(float(0.15)))),
    );
    const highOn = step(float(-0.5), uAutoHigh);
    const hMet   = hC.mul(float(MAX_HEIGHT)).add(breakup.mul(float(40)));
    const highW  = smoothstep(uAutoHighStart, uAutoHighEnd, hMet)
      .mul(float(1).sub(cliffW)).mul(highOn);
    const flatW  = float(1).sub(cliffW).sub(highW);

    // Redistribute w0 to the chosen layers (gated to heightmap bounds so the
    // far LOD ring keeps the base material instead of smearing edge texels).
    // Full-preview mode instead replaces ALL weights with the auto rules —
    // a live stand-in for what "Bake to splatmap" will write (bake replaces
    // every paint layer too), so tuning the rules needs no bake round-trips.
    // A rule set to -1 ("Base (TSL)") assigns NO layer: only the fraction that
    // actually went to a layer leaves w0, so those areas keep the base — this
    // is how "procedural TSL ground + image cliffs" composes.
    const eq = (u, i) => step(abs(u.sub(float(i))), float(0.5));
    const hasFlat   = step(float(-0.5), uAutoFlat);
    const hasCliff  = step(float(-0.5), uAutoCliff);
    // highW is already gated by its own -1 check (highOn) where it's computed.
    const assignedW = cliffW.mul(hasCliff).add(flatW.mul(hasFlat)).add(highW);
    const baseShare = nw[0].mul(uAutoEnabled).mul(inBounds);
    const fullPrev  = uAutoFull.mul(inBounds);
    for (let i = 0; i < NUM_LAYERS; i++) {
      const autoW = cliffW.mul(eq(uAutoCliff, i))
        .add(flatW.mul(eq(uAutoFlat, i)))
        .add(highW.mul(eq(uAutoHigh, i)));
      nw[i + 1] = mix(nw[i + 1].add(baseShare.mul(autoW)), autoW, fullPrev);
    }
    nw[0] = mix(
      nw[0].sub(baseShare.mul(assignedW)),
      float(1).sub(assignedW),
      fullPrev,
    );
  }

  // ── Layer colors (albedo × AO) ────────────────────────────────────────────────
  const layerColors = [];
  for (let i = 0; i < NUM_LAYERS; i++) {
    layerColors.push(
      layerAlbedos[i].rgb.mul(mix(float(1), layerOrms[i].g, layerSlots[i].uAOStr)),
    );
  }

  // ── Blend functions (called from terrainLOD material) ────────────────────────

  function blendColor(baseColor) {
    // Linear weight blend — the one path that is always needed.
    let blended = baseColor.mul(nw[0]);
    for (let i = 0; i < NUM_LAYERS; i++) blended = blended.add(layerColors[i].mul(nw[i+1]));

    let finalColor = blended;

    // Height-based blend (UE-style: luminance as height proxy). ~40 ALU ops that
    // were previously computed even at uHeightBlend 0 and then mixed out.
    if (F.heightBlend) {
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

      finalColor = mix(blended, hBlended, uHeightBlend);
    }

    // Solo mode (greyscale single-layer visualisation) — an EDITOR affordance.
    // A game can never set uSoloLayer, so it was 7 mixes of pure dead weight.
    if (!F.solo) return finalColor;
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
    // 7 × (normalize + sqrt) per pixel. With no layer normal maps in use the
    // whole chain collapses to the geometric normal it was blending toward.
    if (!F.normalMap) return geomWorldNormal;
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
    auto: {
      uAutoEnabled, uAutoFull, uAutoFlat, uAutoCliff, uAutoHigh,
      uAutoSlopeHiY, uAutoSlopeLoY, uAutoHighStart, uAutoHighEnd, uAutoNoise,
    },
  };
}
