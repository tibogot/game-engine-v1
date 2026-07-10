/**
 * Lake toolState slice.
 *
 * Bounds and water level are PER-LAKE (stored in LakeSystem). Everything else
 * here is shared by every lake in the scene, the same way all rivers share one
 * `river2` material slice. One params set means one shader program and one
 * material for the whole system.
 */
export function createLakeToolState() {
  return {
    lake: {
      activeIndex: 0,
      showBounds: true,

      // Surface
      /** Normal-map repeats per metre. 0.05 => one tile every 20 m. */
      normalTiling:   0.05,
      /** Flattens the tangent normal's XY. Small = calm water. */
      normalStrength: 0.05,
      flowSpeed:      0.1,
      /** Surface drift heading, degrees clockwise from +X. */
      flowAngle:      0,

      // Refraction / reflection
      refractionStrength:  0.1,
      fresnelScale:        0.5,
      skyReflectIntensity: 1.0,

      // Beer-Lambert. Red absorbs fastest — that is what turns deep water teal.
      absorptionR:       0.35,
      absorptionG:       0.1,
      absorptionB:       0.08,
      absorptionScale:   15,
      inscatterTint:     "#001717",
      inscatterStrength: 0.85,

      // Sun glint
      sunColor:       "#fff4e0",
      shininess:      500,
      glintStrength:  4,
      glintFresnel:   0.35,
      glintSpread:    0.35,
      glintShoreFade: 0.05,

      // Depth response
      /** Metres of water over which absorption reaches full strength. */
      depthDistance:  20,
      /** Metres of water over which the surface fades in at the shoreline. */
      shoreFade:      0.1,
      surfaceOpacity: 1.0,

      // Shore foam. Widths are in metres of VERTICAL water depth.
      // Off by default: the revo-realms look is a clean depth-faded waterline with
      // no foam. Turn on per-project in the Foam panel.
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
    },
  };
}

/** toolState.lake -> createLakeMaterial params. */
export function lakeParamsFromToolState(lp) {
  const a = (lp.flowAngle * Math.PI) / 180;
  return {
    normalTiling:   lp.normalTiling,
    normalStrength: lp.normalStrength,
    flowSpeed:      lp.flowSpeed,
    flowDir:        [Math.cos(a), Math.sin(a)],

    refractionStrength:  lp.refractionStrength,
    fresnelScale:        lp.fresnelScale,
    skyReflectIntensity: lp.skyReflectIntensity,

    absorption:        [lp.absorptionR, lp.absorptionG, lp.absorptionB],
    absorptionScale:   lp.absorptionScale,
    inscatterTint:     lp.inscatterTint,
    inscatterStrength: lp.inscatterStrength,

    sunColor:       lp.sunColor,
    shininess:      lp.shininess,
    glintStrength:  lp.glintStrength,
    glintFresnel:   lp.glintFresnel,
    glintSpread:    lp.glintSpread,
    glintShoreFade: lp.glintShoreFade,

    depthDistance:  lp.depthDistance,
    shoreFade:      lp.shoreFade,
    surfaceOpacity: lp.surfaceOpacity,

    foamEnabled:      lp.foamEnabled,
    foamColor:        lp.foamColor,
    foamWidth:        lp.foamWidth,
    foamSharpness:    lp.foamSharpness,
    foamIntensity:    lp.foamIntensity,
    foamNoiseScale:   lp.foamNoiseScale,
    foamNoiseSpeed:   lp.foamNoiseSpeed,
    foamJitter:       lp.foamJitter,
    foamWarpScale:    lp.foamWarpScale,
    foamWarpStrength: lp.foamWarpStrength,
    foamCutoff:       lp.foamCutoff,
    foamTransition:   lp.foamTransition,

    pulseEnabled:    lp.pulseEnabled,
    pulseColor:      lp.pulseColor,
    pulseSpeed:      lp.pulseSpeed,
    pulseMaxDepth:   lp.pulseMaxDepth,
    pulseRingWidth:  lp.pulseRingWidth,
    pulseIntensity:  lp.pulseIntensity,
    pulseFade:       lp.pulseFade,
    pulseStagger:    lp.pulseStagger,
    pulse2Intensity: lp.pulse2Intensity,
    pulseSharpness:  lp.pulseSharpness,
    pulseNoiseAmt:   lp.pulseNoiseAmt,
  };
}
