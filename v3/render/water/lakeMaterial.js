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
  Fn, uniform, float, vec2, vec3,
  mix, smoothstep, step, dot, exp, pow, max, saturate,
  normalize, reflect, texture, positionWorld, positionView, cameraPosition,
  cameraNear, cameraFar, screenUV, Discard,
  viewportDepthTexture, viewportSharedTexture, perspectiveDepthToViewZ,
} from "three/tsl";

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

    // ── 8. Composite ──────────────────────────────────────────────────────
    // Fading toward screenColor at the waterline is what softens the shore; the
    // hard Discard above only removes the fragments that are truly over land.
    const opacity     = smoothstep(0, u.shoreFade, waterThickness).mul(u.surfaceOpacity).clamp();
    const shadedWater = mix(throughWater, reflectedColor, fresnelWeight);

    return mix(screenColor, shadedWater, opacity).add(sunGlint);
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
