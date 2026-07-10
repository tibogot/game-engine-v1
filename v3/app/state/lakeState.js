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
  };
}
