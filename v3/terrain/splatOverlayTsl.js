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
 *
 * RUNTIME BRANCH GATE. The whole layer system — 7 albedo + 7 ORM array taps,
 * the splat weights, auto-paint's 5 heightmap taps + FBM — lives inside a real
 * WGSL `if` on `uHasPaint` (+ the auto-paint / solo uniforms). A branch on a
 * uniform value is uniform control flow, so texture sampling inside it is
 * legal and the GPU genuinely skips the work — unlike the old `mix()`-to-zero
 * gating, which evaluated everything and multiplied the answer away. An empty
 * splatmap now costs one uniform compare per pixel instead of ~16 taps.
 * main.js drives uHasPaint from SplatMap.hasAnyPaint() (cached CPU flag).
 *
 * Because every splat node generates inside that one branch, the blend is a
 * single `blend()` call returning a struct — callers must not spread it over
 * separate color/roughness/normal calls, or a node's first generation could
 * land inside one branch and be read (stale) from another.
 */
import * as THREE from "three";
import { stochasticSampleArray } from "../../v2/core/legacy/stochasticTex.js";
import {
  Fn, If, float, int, struct, vec2, vec3,
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
 * them; a game build turns off what it cannot reach. On top of these, the
 * runtime branch gate (see header) skips the compiled-in features per frame
 * whenever the splatmap is empty and auto-paint/solo are off.
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
  terrainNormals = null,
) {
  if (layerSlots.length !== NUM_LAYERS) {
    throw new Error(`createSplatOverlay: need ${NUM_LAYERS} layer slots, got ${layerSlots.length}`);
  }
  const F = { ...SPLAT_FEATURES, ...features };

  const invWS = float(1.0 / WORLD_SIZE);

  // ── Branch gate ──────────────────────────────────────────────────────────────
  // 1 while the splatmap holds ANY paint (weights or meadow). Driven per frame
  // from SplatMap.hasAnyPaint(); 0 skips the entire layer system per pixel.
  const uHasPaint = uniform(0.0);

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
  // Node objects are built eagerly but only REFERENCED inside blend()'s branch,
  // so their code generates inside the gated `if` and costs nothing when skipped.
  const albedoArrNode = texture(albedoArrayTex);
  const ormArrNode    = texture(ormArrayTex);

  const layerAlbedos = [];
  const layerOrms    = [];
  for (let i = 0; i < NUM_LAYERS; i++) {
    const uv = positionWorld.xz.mul(invWS).mul(layerSlots[i].uUVScale);
    layerAlbedos.push(stochasticSampleArray(albedoArrNode, uv, int(i)));
    layerOrms.push(ormArrNode.sample(uv).depth(int(i)));
  }

  // ── Weight extraction (pre-auto-paint) ────────────────────────────────────────
  const rw1 = splatSlice0.r.mul(inBounds), rw2 = splatSlice0.g.mul(inBounds);
  const rw3 = splatSlice0.b.mul(inBounds), rw4 = splatSlice0.a.mul(inBounds);
  const rw5 = splatSlice1.r.mul(inBounds), rw6 = splatSlice1.g.mul(inBounds), rw7 = splatSlice1.b.mul(inBounds);
  const meadowW = splatSlice1.a.mul(inBounds);

  const sum7   = rw1.add(rw2).add(rw3).add(rw4).add(rw5).add(rw6).add(rw7);
  const w0raw  = max(float(0), float(1).sub(sum7));
  const totalW = max(float(1e-5), w0raw.add(sum7));

  const nwExpr = [
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

  // Auto-rule ingredient nodes — referenced only inside blend()'s auto sub-branch.
  let autoIngredients = null;
  if ((terrainNormals || heightTexNode) && F.autoPaint) {
    // Slope and height for the rules. The baked surface texture carries BOTH
    // (normal in .xyz, height in .w) so this is one tap where it used to be
    // five — and, more importantly, it keeps the heightmap's sampler out of the
    // fragment stage, which sits at WebGPU's 16-sampler ceiling.
    let hC, ny;
    if (terrainNormals) {
      const surf = terrainNormals.surfaceAt(splatUV);
      hC = surf.w;
      ny = normalize(surf.xyz).y;
    } else {
      const texel = float(1.0 / HEIGHTMAP_SIZE);
      hC = texture(heightTexNode, splatUV).r;
      const hL = texture(heightTexNode, vec2(splatUV.x.sub(texel), splatUV.y)).r;
      const hR = texture(heightTexNode, vec2(splatUV.x.add(texel), splatUV.y)).r;
      const hD = texture(heightTexNode, vec2(splatUV.x, splatUV.y.sub(texel))).r;
      const hU = texture(heightTexNode, vec2(splatUV.x, splatUV.y.add(texel))).r;
      const flatScale = float(2.0 * WORLD_SIZE / (HEIGHTMAP_SIZE * MAX_HEIGHT));
      ny = flatScale.div(length(vec3(hL.sub(hR), flatScale, hD.sub(hU))));
    }

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

    const eq = (u, i) => step(abs(u.sub(float(i))), float(0.5));
    const hasFlat   = step(float(-0.5), uAutoFlat);
    const hasCliff  = step(float(-0.5), uAutoCliff);
    // highW is already gated by its own -1 check (highOn) where it's computed.
    const assignedW = cliffW.mul(hasCliff).add(flatW.mul(hasFlat)).add(highW);

    autoIngredients = { cliffW, highW, flatW, eq, assignedW };
  }

  // ── The blend (called once per material from terrainLOD / cliff / tint) ──────

  const SplatBlendStruct = struct(
    { color: "vec3", rough: "float", nrm: "vec3" },
    "SplatBlend",
  );

  /**
   * Blend the painted layers over the given base values, all inside one gated
   * branch. Returns { color, rough, nrm } nodes (struct members — computed
   * together, so the 7 ORM taps are shared between color's AO, roughness and
   * the normal decode instead of being duplicated).
   *
   * Call ONCE per material. Passing an input opts it in:
   *   baseColor   (required) vec3 — what unpainted ground looks like
   *   baseRough   (optional) float — pass to get the roughness blend
   *   geomNormal  (optional) vec3 world normal — pass to get ORM.ba normal
   *               mapping (needs F.normalMap)
   *   meadowColor (optional) vec3 — blended over the layers by the painted
   *               meadow mask (layer card 8)
   */
  function blend({ baseColor, baseRough = null, geomNormal = null, meadowColor = null }) {
    const wantRough = baseRough !== null;
    const wantNrm   = geomNormal !== null && F.normalMap;

    const res = Fn(() => {
      const colV   = vec3(baseColor).toVar();
      const roughV = float(wantRough ? baseRough : 0.95).toVar();
      const nrmV   = vec3(geomNormal !== null ? geomNormal : vec3(0, 1, 0)).toVar();

      // Skipping the branch must equal running it with zero weights: weights
      // all 0 ⇒ w0 = 1 ⇒ every output collapses to its base value. Verified
      // path by path below (linear, heightBlend, rough clamp, normal, meadow).
      let gateSum = uHasPaint.add(uAutoEnabled).add(uAutoFull);
      if (F.solo) gateSum = gateSum.add(step(float(0), uSoloLayer));

      If(gateSum.greaterThan(0.0), () => {
        const baseC = vec3(colV).toVar(); // pristine base for w0 + heightBlend
        const w = nwExpr.map((n) => float(n).toVar());

        // Auto-material redistributes w0 to the rule layers (uAutoEnabled), or
        // replaces ALL weights with the rules (uAutoFull preview). Both off is
        // the common case — skip the 5 heightmap taps + FBM entirely.
        if (autoIngredients) {
          If(uAutoEnabled.add(uAutoFull).greaterThan(0.0), () => {
            const { cliffW, highW, flatW, eq, assignedW } = autoIngredients;
            // baseShare snapshots w0 BEFORE any weight is reassigned.
            const baseShare = w[0].mul(uAutoEnabled).mul(inBounds).toVar();
            const fullPrev  = uAutoFull.mul(inBounds).toVar();
            for (let i = 0; i < NUM_LAYERS; i++) {
              const autoW = cliffW.mul(eq(uAutoCliff, i))
                .add(flatW.mul(eq(uAutoFlat, i)))
                .add(highW.mul(eq(uAutoHigh, i)));
              w[i + 1].assign(mix(w[i + 1].add(baseShare.mul(autoW)), autoW, fullPrev));
            }
            w[0].assign(mix(
              w[0].sub(baseShare.mul(assignedW)),
              float(1).sub(assignedW),
              fullPrev,
            ));
          });
        }

        // Layer colors (albedo × AO)
        const layerColors = [];
        for (let i = 0; i < NUM_LAYERS; i++) {
          layerColors.push(
            layerAlbedos[i].rgb.mul(mix(float(1), layerOrms[i].g, layerSlots[i].uAOStr)),
          );
        }

        // Linear weight blend — the one path that is always needed.
        let linSum = baseC.mul(w[0]);
        for (let i = 0; i < NUM_LAYERS; i++) linSum = linSum.add(layerColors[i].mul(w[i + 1]));
        const linear = linSum.toVar();
        colV.assign(linear);

        // Height-based blend (UE-style: luminance as height proxy) — ~40 ALU,
        // branch-skipped at the default uHeightBlend 0.
        if (F.heightBlend) {
          If(uHeightBlend.greaterThan(0.0), () => {
            const baseH  = baseC.dot(LUM);
            const layerH = layerColors.map(c => c.dot(LUM));
            let maxWH = w[0].mul(baseH);
            for (let i = 0; i < NUM_LAYERS; i++) maxWH = max(maxWH, w[i + 1].mul(layerH[i]));
            const thresh = maxWH.sub(uHeightContrast);

            const aw = [max(float(0), w[0].mul(baseH).sub(thresh))];
            for (let i = 0; i < NUM_LAYERS; i++) aw.push(max(float(0), w[i + 1].mul(layerH[i]).sub(thresh)));
            let totalAW = aw[0];
            for (let i = 1; i <= NUM_LAYERS; i++) totalAW = totalAW.add(aw[i]);
            totalAW = max(float(1e-5), totalAW);

            let hBlended = baseC.mul(aw[0].div(totalAW));
            for (let i = 0; i < NUM_LAYERS; i++) hBlended = hBlended.add(layerColors[i].mul(aw[i + 1].div(totalAW)));

            colV.assign(mix(linear, hBlended, uHeightBlend));
          });
        }

        // Solo mode (greyscale single-layer visualisation) — an EDITOR affordance.
        if (F.solo) {
          If(uSoloLayer.greaterThanEqual(float(0)), () => {
            let soloW = w[NUM_LAYERS];
            for (let i = NUM_LAYERS - 1; i >= 0; i--) {
              soloW = mix(w[i], soloW, step(float(i + 0.5), uSoloLayer));
            }
            colV.assign(vec3(soloW, soloW, soloW));
          });
        }

        // Paintable meadow TSL (layer card 8) — over the layers (and solo view),
        // exactly where its mask is painted. Applied after solo, like before.
        if (meadowColor !== null) {
          colV.assign(mix(colV, meadowColor, meadowW));
        }

        if (wantRough) {
          let rSum = roughV.mul(w[0]);
          for (let i = 0; i < NUM_LAYERS; i++) {
            const lr = mix(float(0.88), layerOrms[i].r, layerSlots[i].uRoughStr);
            rSum = rSum.add(lr.mul(w[i + 1]));
          }
          roughV.assign(clamp(rSum, float(0.04), float(1)));
        }

        // Decode per-layer tangent-space normals from ORM.ba and blend by weight.
        // Terrain TBN: T=(1,0,0)  B=(0,0,1)  N=geomWorldNormal (XZ world UV mapping).
        if (wantNrm) {
          let accumN = nrmV.mul(w[0]);
          for (let i = 0; i < NUM_LAYERS; i++) {
            const orm = layerOrms[i];
            const nx  = orm.b.mul(float(2.0)).sub(float(1.0));
            const ny  = orm.a.mul(float(2.0)).sub(float(1.0));
            const nz  = sqrt(max(float(0.0), float(1.0).sub(nx.mul(nx)).sub(ny.mul(ny))));
            // TBN transform: T*nx + B*ny + N*nz  →  (nx, 0, ny) + geomN*nz
            const worldN = normalize(vec3(nx, float(0), ny).add(nrmV.mul(nz)));
            // Lerp between pure geometric normal and normal-mapped based on per-layer strength
            const layerN = mix(nrmV, worldN, layerSlots[i].uNormalStr);
            accumN = accumN.add(layerN.mul(w[i + 1]));
          }
          nrmV.assign(normalize(accumN));
        }
      });

      return SplatBlendStruct(colV, roughV, nrmV);
    })();

    return {
      color: res.get("color"),
      rough: res.get("rough"),
      nrm:   res.get("nrm"),
    };
  }

  return {
    uHasPaint,
    uSoloLayer,
    uHeightBlend,
    uHeightContrast,
    blend,
    auto: {
      uAutoEnabled, uAutoFull, uAutoFlat, uAutoCliff, uAutoHigh,
      uAutoSlopeHiY, uAutoSlopeLoY, uAutoHighStart, uAutoHighEnd, uAutoNoise,
    },
  };
}
