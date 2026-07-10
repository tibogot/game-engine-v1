/**
 * v3/render/water/lakeMaterial.js — V3 lake water (TSL / WebGPU)
 *
 * Depth-buffer water, in the spirit of alezen9/revo-realms' LakeSurface. Water
 * thickness comes from the scene depth buffer rather than the terrain heightmap,
 * so the shoreline is pixel-exact against *everything* (terrain, rocks, props,
 * the player) and re-derives itself for free whenever the terrain is sculpted.
 * Colour then falls out of per-channel Beer-Lambert absorption instead of a
 * hand-authored shore/mid/deep ramp.
 *
 * Differences from the revo-realms original, all deliberate:
 *
 *  1. Thickness is in METRES, via perspectiveDepthToViewZ(). The original
 *     hand-rolls the linearisation out of two cameraProjectionMatrix elements
 *     and carries a uIsWebGPU uniform to flip NDC conventions. r184's helper
 *     does both, and also honours renderer.reversedDepthBuffer.
 *
 *  2. Metres let uAbsorption/uDepthDistance be authored in world units, so a
 *     preset survives a change of camera near/far.
 *
 *  3. No tangent-frame uniforms. The original transforms the tangent-space
 *     normal by three uTworld/uBworld/uNworld uniforms baked from matrixWorld.
 *     Lakes are always horizontal and we tile normals in world XZ, so the frame
 *     is the identity: T=(1,0,0) B=(0,0,1) N=(0,1,0), i.e. (x,y,z) -> (x,z,y).
 *
 *  4. Normals tile in world space (repeats per metre), not mesh UV, so the wave
 *     scale does not change when a lake is resized.
 *
 *  5. Discard() where thickness <= 0, and depthWrite = false. The original's
 *     mesh is authored to fit its lake so it never overhangs land; our quad is a
 *     bounds rectangle and *does*. Over land the original would composite back
 *     to the background colour (invisible) but still write depth, corrupting
 *     anything drawn afterwards. Discarding makes the waterline a correctness
 *     guarantee rather than a happy accident.
 *
 *  6. One framebuffer copy, not two. The original calls viewportDepthTexture()
 *     twice (once at screenUV, once at the refracted UV); each call builds its
 *     own node and each node copies the depth buffer. We build one node and
 *     .sample() it at both UVs.
 *
 *  7. Reflections are the analytical zenith->horizon sky gradient that
 *     oceanShader.js already uses, fed by worldEnvironment's setSkyColors().
 *     scene.environment is a PMREM render target (not a CubeTexture) and is
 *     null in some sky modes, so cubeTexture() cannot be dropped in directly.
 *     The sun disc, which is what a cubemap would buy us here, is drawn by the
 *     separate glint term below.
 */

import * as THREE from "three";
import { MeshBasicNodeMaterial } from "three";
import {
  Fn, If, uniform, float, vec2, vec3,
  mix, smoothstep, step, dot, exp, pow, max, min, abs, saturate,
  floor, fract, sin, length, Loop,
  normalize, reflect, texture, positionWorld, positionView, cameraPosition,
  cameraNear, cameraFar, screenUV, Discard,
  viewportDepthTexture, viewportSharedTexture, perspectiveDepthToViewZ,
} from "three/tsl";

// ─── Noise helpers (lifted from v2/core/legacy/lake-shader.js) ────────────────

const _hash22 = /*#__PURE__*/ Fn(([p]) => {
  const px = dot(p, vec2(127.1, 311.7));
  const py = dot(p, vec2(269.5, 183.3));
  return fract(sin(vec2(px, py)).mul(43758.5453));
});

const _nHash = /*#__PURE__*/ Fn(([p]) => {
  const pp = fract(p.mul(vec2(127.1, 311.7)));
  const d = dot(pp, pp.add(45.32));
  return fract(pp.x.add(d).mul(pp.y.add(d)));
});

const _vnoise2 = /*#__PURE__*/ Fn(([p]) => {
  const i = floor(p);
  const f = fract(p);
  const uu = f.mul(f).mul(float(3).sub(f.mul(2)));
  const n00 = _nHash(i);
  const n10 = _nHash(i.add(vec2(1, 0)));
  const n01 = _nHash(i.add(vec2(0, 1)));
  const n11 = _nHash(i.add(vec2(1, 1)));
  return mix(mix(n00, n10, uu.x), mix(n01, n11, uu.x), uu.y);
});

/** 3-octave value FBM, used only to domain-warp the foam. */
const _valueFbm3 = /*#__PURE__*/ Fn(([p_immutable]) => {
  const p = p_immutable.toVar();
  const value = float(0).toVar();
  const amp = float(1).toVar();
  const total = float(0).toVar();
  Loop(3, () => {
    value.addAssign(amp.mul(_vnoise2(p)));
    total.addAssign(amp);
    p.assign(p.mul(2.3));
    amp.assign(amp.mul(0.4));
  });
  return value.div(max(total, float(1e-4)));
});

const _NEIGHBORS = [
  [-1, -1], [0, -1], [1, -1],
  [-1,  0], [0,  0], [1,  0],
  [-1,  1], [0,  1], [1,  1],
];

/** Worley F1, cell points jittered toward hash. jitter=0 -> regular grid. */
const _worleyF1 = /*#__PURE__*/ Fn(([p, jitter]) => {
  const ip = floor(p);
  const fp = fract(p);
  const md = float(10).toVar();
  for (const [nx, ny] of _NEIGHBORS) {
    const cell = vec2(float(nx), float(ny));
    const pt = mix(vec2(0.5, 0.5), _hash22(ip.add(cell)), jitter);
    md.assign(min(md, length(cell.add(pt).sub(fp))));
  }
  return md;
});

/**
 * 3-octave Worley FBM. v2 runs 5 octaves; 3 is visually indistinguishable at the
 * shoreline and this runs on every water fragment, not just foamy ones — TSL has
 * no cheap way to branch the band mask around it.
 */
const _worleyFbm3 = /*#__PURE__*/ Fn(([p_immutable, jitter]) => {
  const p = p_immutable.toVar();
  const value = float(0).toVar();
  const amp = float(0.5).toVar();
  const total = float(0).toVar();
  Loop(3, () => {
    value.addAssign(amp.mul(_worleyF1(p, jitter)));
    total.addAssign(amp);
    p.assign(p.mul(2.0));
    amp.assign(amp.mul(0.5));
  });
  return value.div(max(total, float(1e-4)));
});

export const LAKE_DEFAULTS = {
  // Surface normals
  /** Normal-map repeats per metre. 0.05 => one tile every 20 m. */
  normalTiling:    0.05,
  /** Flattens the tangent normal's XY. Small values = calm water. */
  normalStrength:  0.05,
  /** Metres/second the two normal layers scroll past each other. */
  flowSpeed:       0.1,
  /** Direction of the surface drift, XZ. */
  flowDir:         [1, 0],

  // Refraction
  /** Screen-space UV offset scale. Beyond ~0.25 the wobble reads as jelly. */
  refractionStrength: 0.1,

  // Reflection
  fresnelScale:       0.5,
  skyZenithColor:     "#3a6ea5",
  skyHorizonColor:    "#bcd4e6",
  skyReflectIntensity: 1.0,

  // Beer-Lambert absorption. Red absorbs fastest, which is what pushes deep
  // water toward teal; this is the single knob that makes it read as water.
  absorption:        [0.35, 0.1, 0.08],
  absorptionScale:   15,
  /** Colour of light scattered back out of the water body. */
  inscatterTint:     "#001717",
  inscatterStrength: 0.85,

  // Sun glint
  sunColor:          "#fff4e0",
  shininess:         500,
  glintStrength:     4,
  glintFresnel:      0.35,
  /** Flattens the normal used for glint only — widens the highlight streak. */
  glintSpread:       0.35,
  /** Glints fade out over this many metres of water, so they don't crawl ashore. */
  glintShoreFade:    0.05,

  // Opacity / shoreline
  /** Metres of water over which absorption reaches full strength. */
  depthDistance:     20,
  /** Metres of water over which the surface fades in at the shoreline. */
  shoreFade:         0.1,
  /** Global surface opacity. 1 = fully shaded water, 0 = invisible. */
  surfaceOpacity:    1.0,

  // ── Shore foam ─────────────────────────────────────────────────────────────
  // All widths below are in metres of VERTICAL water depth, not view-ray depth,
  // so the band keeps its size as the camera tilts.
  foamEnabled:     true,
  foamColor:       "#ffffff",
  /** Vertical depth at which the foam band has faded out entirely. */
  foamWidth:       0.6,
  /** Pushes foam toward the waterline. >1 = tighter against the shore. */
  foamSharpness:   1.35,
  foamIntensity:   1.15,
  /** Worley cells per metre. */
  foamNoiseScale:  0.9,
  foamNoiseSpeed:  0.05,
  foamJitter:      0.9,
  /** Domain warp — this is what makes the edge ragged instead of cellular. */
  foamWarpScale:    0.4,
  foamWarpStrength: 0.6,
  /** Below this the foam is cut away entirely; the transition sets its softness. */
  foamCutoff:     0.42,
  foamTransition: 0.14,

  // ── Inward pulse rings ─────────────────────────────────────────────────────
  pulseEnabled:   true,
  pulseColor:     "#c9ebff",
  /** Rings/second leaving the shoreline. */
  pulseSpeed:     0.38,
  /** Vertical depth the ring reaches before dying. */
  pulseMaxDepth:  3.2,
  pulseRingWidth: 0.11,
  pulseIntensity: 0.72,
  /** How fast a ring fades over its life. Higher = dies sooner. */
  pulseFade:      1.65,
  /** Phase offset of the second ring, in ring periods. */
  pulseStagger:   0.5,
  pulse2Intensity: 0.45,
  pulseSharpness: 1.15,
  /** How much the Worley field chews holes in the rings. */
  pulseNoiseAmt:  0.35,
};

/** Reoriented Normal Mapping. Both inputs are unpacked, normalised tangent normals. */
const blendRNM = /*#__PURE__*/ Fn(([n1, n2]) =>
  vec3(
    n1.z.mul(n2.x).add(n1.x.mul(n2.z)),
    n1.z.mul(n2.y).add(n1.y.mul(n2.z)),
    n1.z.mul(n2.z).sub(n1.x.mul(n2.x).add(n1.y.mul(n2.y))),
  ).normalize(),
);

/**
 * @param {object}         deps
 * @param {THREE.Texture}  deps.normalMap — tiling water normal map (NoColorSpace, RepeatWrapping)
 * @param {object}         [deps.params]  — partial LAKE_DEFAULTS override
 */
export function createLakeMaterial({ normalMap, params = {} }) {
  const p = { ...LAKE_DEFAULTS, ...params };

  const u = {
    time:            uniform(0),

    normalTiling:    uniform(p.normalTiling),
    normalStrength:  uniform(p.normalStrength),
    flowSpeed:       uniform(p.flowSpeed),
    flowDir:         uniform(new THREE.Vector2(...p.flowDir)),

    refractionStrength: uniform(p.refractionStrength),

    fresnelScale:        uniform(p.fresnelScale),
    skyZenithColor:      uniform(new THREE.Color(p.skyZenithColor)),
    skyHorizonColor:     uniform(new THREE.Color(p.skyHorizonColor)),
    skyReflectIntensity: uniform(p.skyReflectIntensity),

    absorption:        uniform(new THREE.Vector3(...p.absorption)),
    absorptionScale:   uniform(p.absorptionScale),
    inscatterTint:     uniform(new THREE.Color(p.inscatterTint)),
    inscatterStrength: uniform(p.inscatterStrength),

    sunDir:         uniform(new THREE.Vector3(0.4, 0.55, 0.3).normalize()),
    sunColor:       uniform(new THREE.Color(p.sunColor)),
    shininess:      uniform(p.shininess),
    glintStrength:  uniform(p.glintStrength),
    glintFresnel:   uniform(p.glintFresnel),
    glintSpread:    uniform(p.glintSpread),
    glintShoreFade: uniform(p.glintShoreFade),

    depthDistance:  uniform(p.depthDistance),
    shoreFade:      uniform(p.shoreFade),
    surfaceOpacity: uniform(p.surfaceOpacity),

    foamEnabled:      uniform(p.foamEnabled ? 1 : 0),
    foamColor:        uniform(new THREE.Color(p.foamColor)),
    foamWidth:        uniform(p.foamWidth),
    foamSharpness:    uniform(p.foamSharpness),
    foamIntensity:    uniform(p.foamIntensity),
    foamNoiseScale:   uniform(p.foamNoiseScale),
    foamNoiseSpeed:   uniform(p.foamNoiseSpeed),
    foamJitter:       uniform(p.foamJitter),
    foamWarpScale:    uniform(p.foamWarpScale),
    foamWarpStrength: uniform(p.foamWarpStrength),
    foamCutoff:       uniform(p.foamCutoff),
    foamTransition:   uniform(p.foamTransition),

    pulseEnabled:    uniform(p.pulseEnabled ? 1 : 0),
    pulseColor:      uniform(new THREE.Color(p.pulseColor)),
    pulseSpeed:      uniform(p.pulseSpeed),
    pulseMaxDepth:   uniform(p.pulseMaxDepth),
    pulseRingWidth:  uniform(p.pulseRingWidth),
    pulseIntensity:  uniform(p.pulseIntensity),
    pulseFade:       uniform(p.pulseFade),
    pulseStagger:    uniform(p.pulseStagger),
    pulse2Intensity: uniform(p.pulse2Intensity),
    pulseSharpness:  uniform(p.pulseSharpness),
    pulseNoiseAmt:   uniform(p.pulseNoiseAmt),
  };

  const material = new MeshBasicNodeMaterial();
  material.fog         = false;
  material.transparent = false;   // we composite against the grabbed backbuffer ourselves
  material.depthWrite  = false;   // see note 5 — the quad overhangs land
  material.depthTest   = true;

  // ── One copy of each backbuffer, sampled at several UVs (note 6) ───────────
  const sceneColorTex = viewportSharedTexture();
  const sceneDepthTex = viewportDepthTexture();

  /** Scene distance from camera, in metres, at a given screen UV. */
  const sceneDistAt = Fn(([suv = vec2(0)]) =>
    perspectiveDepthToViewZ(sceneDepthTex.sample(suv).r, cameraNear, cameraFar).negate(),
  );

  /** Tangent -> world for a horizontal plane with world-XZ tiling (note 3). */
  const toWorld = (n) => vec3(n.x, n.z, n.y).normalize();

  material.colorNode = Fn(() => {
    // ── 1. Surface normal: two scrolling layers, RNM-blended ────────────────
    const drift  = u.flowDir.mul(u.time.mul(u.flowSpeed));
    const baseUv = positionWorld.xz.mul(u.normalTiling);

    const tsn1 = texture(normalMap, baseUv.mul(1.37).add(drift)).rgb.mul(2).sub(1).normalize();
    const tsn2 = texture(normalMap, baseUv.mul(0.73).sub(drift)).rgb.mul(2).sub(1).normalize();
    const tsnFull = blendRNM(tsn1, tsn2).toVar();

    const tsn    = vec3(tsnFull.xy.mul(u.normalStrength), tsnFull.z).normalize().toVar();
    const normal = toWorld(tsn).toVar();

    // ── 2. Water thickness, in metres ──────────────────────────────────────
    const fragDist  = positionView.z.negate().toVar();
    const thickness = sceneDistAt(screenUV).sub(fragDist).toVar();

    // Everything at or in front of the water plane is dry land (note 5).
    Discard(thickness.lessThanEqual(0));

    // ── 3. Refraction, with a validity check ───────────────────────────────
    // Deeper water bends more. The offset is the tangent tilt, not an outward
    // push, which is what gives the wobble rather than a smear.
    const distortion = tsn.xy.mul(
      mix(u.refractionStrength, u.refractionStrength.mul(1.5),
          thickness.div(u.depthDistance).clamp()),
    );
    const refractedUv = screenUV.add(distortion);

    // Reject the offset if it lands on something IN FRONT of the water — else
    // objects standing in the lake bleed their silhouette into the surface.
    const refractedDist = sceneDistAt(refractedUv).toVar();
    const isSafe        = step(fragDist, refractedDist).toVar();
    const safeUv        = mix(screenUV, refractedUv, isSafe).clamp();

    const screenColor    = sceneColorTex.sample(safeUv).rgb.toVar();
    const refractedThick = refractedDist.sub(fragDist).max(0);
    // Use the refracted thickness only where we actually took the refracted
    // sample, so absorption and the shoreline agree with the colour we read.
    const waterThickness = mix(thickness, refractedThick, isSafe).toVar();

    // waterThickness runs ALONG THE VIEW RAY, so it stretches at grazing angles.
    // Foam bands must key off vertical depth or they'd breathe as the camera
    // tilts. For surface point S and terrain point P on the same ray with
    // direction r, S.y - P.y == thickness * -r.y. Exact, one dot product.
    const rayDir       = normalize(positionWorld.sub(cameraPosition));
    const verticalDepth = waterThickness.mul(rayDir.y.abs()).toVar();

    // ── 4. Reflection: analytical sky gradient (note 7) ────────────────────
    const viewDir        = normalize(cameraPosition.sub(positionWorld)).toVar();
    const reflectVec     = reflect(viewDir.negate(), normal);
    const skyT           = saturate(reflectVec.y.abs());
    const reflectedColor = mix(u.skyHorizonColor, u.skyZenithColor, skyT)
      .mul(u.skyReflectIntensity);

    // ── 5. Fresnel (Schlick, F0 = 0.02 for water) ─────────────────────────
    const cosTheta = saturate(dot(normal, viewDir));
    const F0       = float(0.02);
    const g        = float(1).sub(cosTheta).toVar();
    const g2       = g.mul(g);
    const fresnel  = F0.add(float(1).sub(F0).mul(g2.mul(g2).mul(g))).toVar(); // cheaper than pow(g,5)
    const fresnelWeight = fresnel.mul(u.fresnelScale).clamp();

    // ── 6. Beer-Lambert transmittance ─────────────────────────────────────
    const sigma         = u.absorption.mul(u.absorptionScale);
    const depth01       = waterThickness.div(u.depthDistance).clamp();
    const transmittance = exp(sigma.negate().mul(depth01));
    const inscatter     = u.inscatterTint.mul(u.inscatterStrength);
    const throughWater  = mix(inscatter, screenColor, transmittance);

    // ── 7. Sun glint, off a flatter normal so the streak spreads ──────────
    const glintNormal  = toWorld(vec3(tsnFull.xy.mul(u.glintSpread), tsnFull.z).normalize());
    const reflectedSun = reflect(u.sunDir.negate(), glintNormal);
    const align        = max(dot(reflectedSun, viewDir), 0);
    const spec         = pow(align, u.shininess);
    const glintFresnel = mix(float(1), fresnel, u.glintFresnel);
    const glintShore   = smoothstep(0, u.glintShoreFade, waterThickness);
    const sunGlint     = u.sunColor.mul(spec.mul(u.glintStrength).mul(glintFresnel)).mul(glintShore);

    // ── 8/9. Shore foam + inward pulse rings ──────────────────────────────
    // Both are driven by one domain-warped Worley field, and both only exist
    // near the shore. A real branch, not a multiply-by-zero: the Worley FBM is
    // ~30 hashes and most of a lake is deep water that needs none of it. The
    // condition is uniform across the whole surface at a given depth, so it
    // stays coherent within a warp.
    const foamMask  = float(0).toVar();
    const pulseMask = float(0).toVar();

    const fxWanted   = u.foamEnabled.max(u.pulseEnabled);
    const fxRange    = u.foamWidth.max(u.pulseMaxDepth);
    const nearShore  = step(verticalDepth, fxRange);

    If(fxWanted.mul(nearShore).greaterThan(0), () => {
      // Domain-warped Worley. The warp is what turns a cellular pattern into a
      // ragged waterline; without it the foam reads as bubbles.
      const foamUv = positionWorld.xz.mul(u.foamNoiseScale).toVar();
      const scroll = u.time.mul(u.foamNoiseSpeed);
      foamUv.addAssign(vec2(scroll, scroll.mul(0.71)));

      const warpP = foamUv.mul(u.foamWarpScale);
      const warp  = vec2(_valueFbm3(warpP).sub(0.5), _valueFbm3(warpP.add(vec2(4, 4))).sub(0.5));
      const foamNoise = _worleyFbm3(foamUv.add(warp.mul(u.foamWarpStrength)), u.foamJitter).toVar();

      const foamBand = float(1).sub(smoothstep(0, u.foamWidth, verticalDepth));
      const foamRaw  = pow(max(foamBand, float(1e-4)), u.foamSharpness).mul(foamNoise);
      const cutLo    = max(u.foamCutoff.sub(u.foamTransition), float(0));
      const cutHi    = min(u.foamCutoff.add(u.foamTransition), float(1));
      foamMask.assign(
        smoothstep(cutLo, cutHi, foamRaw).mul(u.foamIntensity).mul(u.foamEnabled).clamp(),
      );

      // Two staggered bands travelling from the waterline into deeper water.
      // The Worley field doubles as their breakup, for free.
      const ringMod = mix(float(1), foamNoise, u.pulseNoiseAmt);
      const ring = Fn(([phase, strength]) => {
        const t     = fract(u.time.mul(u.pulseSpeed).add(phase)).toVar();
        const front = t.mul(u.pulseMaxDepth);
        const raw   = float(1).sub(smoothstep(0, u.pulseRingWidth, verticalDepth.sub(front).abs()));
        const shaped = pow(max(raw.mul(ringMod), float(1e-4)), u.pulseSharpness);
        // Rings fade out over their life, and never bleed onto dry land.
        return shaped.mul(pow(float(1).sub(t), u.pulseFade)).mul(strength)
          .mul(step(0.02, verticalDepth));
      });
      pulseMask.assign(
        ring(float(0), u.pulseIntensity)
          .add(ring(u.pulseStagger, u.pulse2Intensity))
          .mul(u.pulseEnabled).clamp(),
      );
    });

    // ── 10. Composite ─────────────────────────────────────────────────────
    // Fading toward screenColor at the waterline is what softens the shore; the
    // hard Discard above only removes the fragments that are truly over land.
    const opacity     = smoothstep(0, u.shoreFade, waterThickness).mul(u.surfaceOpacity).clamp();
    const shadedWater = mix(throughWater, reflectedColor, fresnelWeight);

    // Foam sits on top of the water but under the glint: wet foam doesn't glint.
    const withWater = mix(screenColor, shadedWater, opacity);
    const withRings = mix(withWater, u.pulseColor, pulseMask);
    const withFoam  = mix(withRings, u.foamColor, foamMask);

    return withFoam.add(sunGlint.mul(float(1).sub(foamMask)));
  })();

  const _c = (hex, target) => target.set(hex);

  function syncParams(sp) {
    if (!sp) return;
    if (sp.normalTiling      != null) u.normalTiling.value      = sp.normalTiling;
    if (sp.normalStrength    != null) u.normalStrength.value    = sp.normalStrength;
    if (sp.flowSpeed         != null) u.flowSpeed.value         = sp.flowSpeed;
    if (sp.flowDir           != null) u.flowDir.value.set(sp.flowDir[0], sp.flowDir[1]);
    if (sp.refractionStrength!= null) u.refractionStrength.value= sp.refractionStrength;
    if (sp.fresnelScale      != null) u.fresnelScale.value      = sp.fresnelScale;
    if (sp.skyReflectIntensity != null) u.skyReflectIntensity.value = sp.skyReflectIntensity;
    if (sp.skyZenithColor    != null) _c(sp.skyZenithColor,  u.skyZenithColor.value);
    if (sp.skyHorizonColor   != null) _c(sp.skyHorizonColor, u.skyHorizonColor.value);
    if (sp.absorption        != null) u.absorption.value.set(...sp.absorption);
    if (sp.absorptionScale   != null) u.absorptionScale.value   = sp.absorptionScale;
    if (sp.inscatterTint     != null) _c(sp.inscatterTint, u.inscatterTint.value);
    if (sp.inscatterStrength != null) u.inscatterStrength.value = sp.inscatterStrength;
    if (sp.sunColor          != null) _c(sp.sunColor, u.sunColor.value);
    if (sp.shininess         != null) u.shininess.value         = sp.shininess;
    if (sp.glintStrength     != null) u.glintStrength.value     = sp.glintStrength;
    if (sp.glintFresnel      != null) u.glintFresnel.value      = sp.glintFresnel;
    if (sp.glintSpread       != null) u.glintSpread.value       = sp.glintSpread;
    if (sp.glintShoreFade    != null) u.glintShoreFade.value    = sp.glintShoreFade;
    if (sp.depthDistance     != null) u.depthDistance.value     = sp.depthDistance;
    if (sp.shoreFade         != null) u.shoreFade.value         = sp.shoreFade;
    if (sp.surfaceOpacity    != null) u.surfaceOpacity.value    = sp.surfaceOpacity;

    if (sp.foamEnabled      != null) u.foamEnabled.value      = sp.foamEnabled ? 1 : 0;
    if (sp.foamColor        != null) _c(sp.foamColor, u.foamColor.value);
    if (sp.foamWidth        != null) u.foamWidth.value        = sp.foamWidth;
    if (sp.foamSharpness    != null) u.foamSharpness.value    = sp.foamSharpness;
    if (sp.foamIntensity    != null) u.foamIntensity.value    = sp.foamIntensity;
    if (sp.foamNoiseScale   != null) u.foamNoiseScale.value   = sp.foamNoiseScale;
    if (sp.foamNoiseSpeed   != null) u.foamNoiseSpeed.value   = sp.foamNoiseSpeed;
    if (sp.foamJitter       != null) u.foamJitter.value       = sp.foamJitter;
    if (sp.foamWarpScale    != null) u.foamWarpScale.value    = sp.foamWarpScale;
    if (sp.foamWarpStrength != null) u.foamWarpStrength.value = sp.foamWarpStrength;
    if (sp.foamCutoff       != null) u.foamCutoff.value       = sp.foamCutoff;
    if (sp.foamTransition   != null) u.foamTransition.value   = sp.foamTransition;

    if (sp.pulseEnabled    != null) u.pulseEnabled.value    = sp.pulseEnabled ? 1 : 0;
    if (sp.pulseColor      != null) _c(sp.pulseColor, u.pulseColor.value);
    if (sp.pulseSpeed      != null) u.pulseSpeed.value      = sp.pulseSpeed;
    if (sp.pulseMaxDepth   != null) u.pulseMaxDepth.value   = sp.pulseMaxDepth;
    if (sp.pulseRingWidth  != null) u.pulseRingWidth.value  = sp.pulseRingWidth;
    if (sp.pulseIntensity  != null) u.pulseIntensity.value  = sp.pulseIntensity;
    if (sp.pulseFade       != null) u.pulseFade.value       = sp.pulseFade;
    if (sp.pulseStagger    != null) u.pulseStagger.value    = sp.pulseStagger;
    if (sp.pulse2Intensity != null) u.pulse2Intensity.value = sp.pulse2Intensity;
    if (sp.pulseSharpness  != null) u.pulseSharpness.value  = sp.pulseSharpness;
    if (sp.pulseNoiseAmt   != null) u.pulseNoiseAmt.value   = sp.pulseNoiseAmt;
  }

  function update(dt, elapsed) {
    u.time.value = elapsed;
  }

  /** @param {THREE.Vector3} v — unit vector pointing TOWARD the sun (matches worldOcean.setSunDir) */
  function setSunDir(v) {
    if (v) u.sunDir.value.copy(v).normalize();
  }

  function setSkyColors(zenith, horizon) {
    if (zenith)  u.skyZenithColor.value.copy(zenith);
    if (horizon) u.skyHorizonColor.value.copy(horizon);
  }

  return { material, uniforms: u, syncParams, update, setSunDir, setSkyColors };
}
