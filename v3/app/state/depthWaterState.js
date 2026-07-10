/**
 * Shared state shape for the depth-buffer water material (v3/render/water/lakeMaterial.js).
 *
 * Lakes and River+ "Depth" style run the SAME shader but hold SEPARATE values —
 * they each build their own material with their own uniforms. A river is two metres
 * deep and flows; a lake is twenty metres deep and doesn't. Forcing one shared set
 * would make tuning one fight the other.
 *
 * What this module guarantees is that the two never drift apart *structurally*: one
 * defaults factory, one state -> uniforms mapper, one list of knobs. Add a parameter
 * here and both panels can expose it.
 *
 * The only genuinely global setting is the SSR master, which lives as a module
 * uniform in lakeMaterial.js (setWaterSsrEnabled).
 */

/**
 * @param {object} [overrides] — e.g. rivers pass { depthDistance: 3 } because they're shallow.
 */
export function createDepthWaterState(overrides = {}) {
  return {
    // Surface
    /** Normal-map repeats per metre. 0.05 => one tile every 20 m. */
    normalTiling:   0.05,
    /** Flattens the tangent normal's XY. Small = calm water. */
    normalStrength: 0.05,

    // Refraction / reflection
    refractionStrength:  0.1,
    fresnelScale:        0.5,
    skyReflectIntensity: 1.0,

    // Screen-space reflections. The `ssrMaster` kill-switch is global and lives
    // elsewhere; this one only governs this surface.
    ssrEnabled:     true,
    ssrStrength:    1.0,
    ssrMaxDistance: 120,
    ssrThickness:   1.5,
    ssrEdgeFade:    0.15,

    // Beer-Lambert. Red absorbs fastest — that is what turns deep water teal.
    absorptionR:       0.35,
    absorptionG:       0.1,
    absorptionB:       0.08,
    absorptionScale:   15,
    inscatterTint:     "#001717",
    inscatterStrength: 0.85,
    /** Metres of water over which absorption reaches full strength. */
    depthDistance:  20,

    // Sun glint
    sunColor:       "#fff4e0",
    shininess:      500,
    glintStrength:  4,
    glintFresnel:   0.35,
    glintSpread:    0.35,
    glintShoreFade: 0.05,

    // Shoreline
    /** Metres of water over which the surface fades in at the waterline. */
    shoreFade:      0.1,
    surfaceOpacity: 1.0,

    // Shore foam. Widths are in metres of VERTICAL water depth.
    // Off by default: the reference look (revo-realms) is a clean depth-faded
    // waterline with no foam. The whole Worley march is branched out when off.
    foamEnabled:      false,
    foamColor:        "#ffffff",
    foamWidth:        0.6,
    foamSharpness:    1.35,
    foamIntensity:    1.15,
    foamNoiseScale:   0.9,
    foamNoiseSpeed:   0.05,
    foamJitter:       0.9,
    foamWarpScale:    0.4,
    foamWarpStrength: 0.6,
    foamCutoff:       0.42,
    foamTransition:   0.14,

    // Inward pulse rings — off by default, same reason as foam.
    pulseEnabled:    false,
    pulseColor:      "#c9ebff",
    pulseSpeed:      0.38,
    pulseMaxDepth:   3.2,
    pulseRingWidth:  0.11,
    pulseIntensity:  0.72,
    pulseFade:       1.65,
    pulseStagger:    0.5,
    pulse2Intensity: 0.45,
    pulseSharpness:  1.15,
    pulseNoiseAmt:   0.35,

    ...overrides,
  };
}

/**
 * Depth-water state -> createLakeMaterial params.
 *
 * `flowSpeed` and `flowDir` are deliberately absent: lakes drift with a wind angle,
 * rivers flow downstream along the ribbon. Each caller supplies its own.
 */
export function depthWaterParams(s) {
  return {
    normalTiling:   s.normalTiling,
    normalStrength: s.normalStrength,

    refractionStrength:  s.refractionStrength,
    fresnelScale:        s.fresnelScale,
    skyReflectIntensity: s.skyReflectIntensity,

    ssrEnabled:     s.ssrEnabled,
    ssrStrength:    s.ssrStrength,
    ssrMaxDistance: s.ssrMaxDistance,
    ssrThickness:   s.ssrThickness,
    ssrEdgeFade:    s.ssrEdgeFade,

    absorption:        [s.absorptionR, s.absorptionG, s.absorptionB],
    absorptionScale:   s.absorptionScale,
    inscatterTint:     s.inscatterTint,
    inscatterStrength: s.inscatterStrength,
    depthDistance:     s.depthDistance,

    sunColor:       s.sunColor,
    shininess:      s.shininess,
    glintStrength:  s.glintStrength,
    glintFresnel:   s.glintFresnel,
    glintSpread:    s.glintSpread,
    glintShoreFade: s.glintShoreFade,

    shoreFade:      s.shoreFade,
    surfaceOpacity: s.surfaceOpacity,

    foamEnabled:      s.foamEnabled,
    foamColor:        s.foamColor,
    foamWidth:        s.foamWidth,
    foamSharpness:    s.foamSharpness,
    foamIntensity:    s.foamIntensity,
    foamNoiseScale:   s.foamNoiseScale,
    foamNoiseSpeed:   s.foamNoiseSpeed,
    foamJitter:       s.foamJitter,
    foamWarpScale:    s.foamWarpScale,
    foamWarpStrength: s.foamWarpStrength,
    foamCutoff:       s.foamCutoff,
    foamTransition:   s.foamTransition,

    pulseEnabled:    s.pulseEnabled,
    pulseColor:      s.pulseColor,
    pulseSpeed:      s.pulseSpeed,
    pulseMaxDepth:   s.pulseMaxDepth,
    pulseRingWidth:  s.pulseRingWidth,
    pulseIntensity:  s.pulseIntensity,
    pulseFade:       s.pulseFade,
    pulseStagger:    s.pulseStagger,
    pulse2Intensity: s.pulse2Intensity,
    pulseSharpness:  s.pulseSharpness,
    pulseNoiseAmt:   s.pulseNoiseAmt,
  };
}
