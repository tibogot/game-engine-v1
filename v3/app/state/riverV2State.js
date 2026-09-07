/**
 * v3/app/state/riverV2State.js — River v2 tool state.
 *
 * River v2 inverts the authoring model of every earlier river tool here: the
 * SPLINE is the master and the terrain conforms to it, rather than the river
 * reading the ground and digging into it. Everything below follows from that.
 *
 * Two levels of parameter:
 *
 *  - PER NODE (`RIVER_NODE_DEFAULTS`) — width, depth, bank and the water surface
 *    level itself. These interpolate along the spline, so a river narrows into a
 *    gorge and opens out into a pool by dragging handles, not by splitting it
 *    into separate rivers.
 *
 *  - PER TOOL (`createRiverV2ToolState`) — the cross-section shape, the solver,
 *    the flow model and the surface shader. One river looks like another unless
 *    a node says otherwise.
 *
 * A node's `y` is `null` for AUTO (the solver drops it onto the local valley
 * floor) or a number for PINNED (the author's word, never overridden). That one
 * field is what lets a river be lifted into the air with its channel and banks
 * following it, and it is why the conform must fill as well as cut.
 */

/** Channel shape carried by every node. New nodes copy the tool's `new*` values. */
export const RIVER_NODE_DEFAULTS = {
  /** Metres across the water surface. The waterline lands exactly here. */
  width: 10,
  /** Metres from the water surface down to the deepest point of the bed. */
  depth: 1.8,
  /** Metres of shoulder blending the bank lip back out to natural terrain. */
  bank: 8,
};

export function createRiverV2ToolState() {
  return {
    riverV2: {
      // ── Authoring ──────────────────────────────────────────────────────────
      showHandles: true,
      /** Flow-direction arrows along every centreline. Red = flows uphill. */
      showArrows: true,
      activeRiverIndex: 0,

      /** Channel shape given to newly placed nodes. */
      newWidth: RIVER_NODE_DEFAULTS.width,
      newDepth: RIVER_NODE_DEFAULTS.depth,
      newBank: RIVER_NODE_DEFAULTS.bank,

      /** Live values for the selected node, mirrored into the panel. */
      selWidth: RIVER_NODE_DEFAULTS.width,
      selDepth: RIVER_NODE_DEFAULTS.depth,
      selBank: RIVER_NODE_DEFAULTS.bank,
      selLevel: 0,

      // ── Solver ─────────────────────────────────────────────────────────────
      /** Metres between solved stations. Drives conform and mesh resolution. */
      stationSpacing: 2.5,
      /**
       * Clamp AUTO node levels so they never rise going downstream. Pinned nodes
       * are never touched — if the author lifts one, the river really does climb
       * and the arrows turn red to say so.
       */
      forceDownhill: true,
      /** Minimum fall per metre applied by forceDownhill, so water never pools. */
      minGradient: 0.0008,
      /** Profile smoothing passes over the solved station levels. */
      levelSmoothing: 2,

      // ── Cross-section ──────────────────────────────────────────────────────
      /**
       * 0 = flat-bottomed trapezoid (canal), 1 = parabolic U (natural channel).
       * The bed always returns to the water level exactly at ±width/2, which is
       * what makes the waterline land on the mesh edge with no gap.
       */
      bedCurve: 0.55,
      /** Metres the bank lip stands above the water. This is what holds it in. */
      freeboard: 0.6,
      /** Fraction of the bank width spent rising from waterline to lip. */
      lipFraction: 0.28,
      /**
       * Steepest embankment or gorge wall the conform will build, as rise/run.
       * Where the terrain is further from the lip than this allows, the bank
       * FLARES wider so the slope stays sane — this is what keeps a river lifted
       * high above a floodplain from growing a vertical wall.
       */
      maxBankSlope: 0.9,
      /** Hard cap on that flare, in multiples of the node's bank width. */
      bankFlareMax: 4,

      // ── Flow model ─────────────────────────────────────────────────────────
      /**
       * Manning roughness. Velocity is v = (1/n)·d^(2/3)·√S, so a steeper or
       * deeper reach runs faster and a narrow constriction white-caps on its own.
       */
      manningN: 0.04,
      /** Global multiplier on solved velocity, for art direction. */
      flowScale: 1,
      /** Slope floor, so a dead-flat reach still drifts instead of freezing. */
      minSlope: 0.0006,
      /** Solved speeds are clamped into this band, metres/second. */
      minSpeed: 0.08,
      maxSpeed: 9,
      /**
       * Whitewater threshold, as a Froude number (v / sqrt(g·d)) — how close the
       * flow is to going supercritical, which is physically when water breaks.
       * An ABSOLUTE measure on purpose: anything relative (turbulence against
       * the river's own worst reach) reports a uniform stream as 100% rapids.
       * Below `froudeStart` there is no turbulence at all; at `froudeFull` it is
       * saturated. Lower the start to get whitewater on a gentler river.
       */
      froudeStart: 0.8,
      /**
       * Saturating at 1.8 was too eager: an ordinary 8% reach reaches Fr ~2 and
       * came out fully white, which is what a lifted node looks like on a short
       * river. 2.5 keeps a real rapid unmistakably white while leaving water
       * visible through it.
       */
      froudeFull: 2.5,

      // ── Surface placement ──────────────────────────────────────────────────
      /**
       * Metres the drawn surface sits below the solved level. Small and positive
       * hides the mesh edge inside the bank lip; 0 puts it exactly on the rim.
       */
      surfaceDrop: 0.05,

      // ── Surface mesh density ───────────────────────────────────────────────
      // Separate from stationSpacing on purpose: that one also drives the
      // conform, and making it fine enough for waves would cost far more than
      // resampling the ribbon does. These only rebuild geometry.
      /** Metres between rows of the water surface, along the flow. */
      meshStep: 0.8,
      /** Columns across the ribbon. Waves need width to be seen bending. */
      meshAcross: 12,

      /**
       * Sand along the banks — see riverSandTsl.js. Terrain shading, not water
       * shading: it applies under AND around the channel whether or not that
       * stretch is submerged, and carries no caustics.
       */
      sand: {
        enabled: true,
        color: "#c9ab7c",
        strength: 0.9,
        /** Metres of sand beyond the channel's own half-width, each side. */
        width: 7,
        fade: 4.5,
        edgeNoise: 3,
        edgeNoiseScale: 0.05,
        detail: 0.5,
      },

      // ── Water shading (see riverV2Material.js) ─────────────────────────────
      water: createRiverWaterState(),
    },
  };
}

/**
 * River surface appearance. Deliberately NOT depthWaterState: the lake's set
 * carries shore foam and pulse rings a river has no use for, and this one
 * carries a flow model and whitewater a lake has no use for. Same shading
 * *ideas* (depth-buffer thickness, Beer-Lambert, SSR), different knobs.
 */
export function createRiverWaterState(overrides = {}) {
  return {
    // Beer-Lambert. A river is shallow and reads greener/browner than a lake.
    absorptionR: 0.42,
    absorptionG: 0.14,
    absorptionB: 0.1,
    absorptionScale: 14,
    inscatterTint: "#0d2a26",
    inscatterStrength: 0.7,
    /** Metres of water over which absorption reaches full strength. */
    depthDistance: 2.6,

    // Surface normals, in flow space.
    normalTiling: 0.09,
    normalStrength: 0.22,
    /** Second, larger normal layer — long swells under the ripples. */
    normalTiling2: 0.026,
    normalStrength2: 0.35,
    /**
     * Seconds per advection phase. The two phases are half a period apart and
     * cross-faded, so the texture never stretches more than one phase's worth
     * of travel no matter how fast the reach flows. Longer = smoother but more
     * stretched; shorter = crisper but the cross-fade pulse becomes visible.
     */
    advectPeriod: 1.6,
    /** Metres/second added on top of the solved velocity. */
    flowBias: 0,

    // Refraction / reflection.
    refractionStrength: 0.045,
    fresnelScale: 0.55,
    skyReflectIntensity: 1,
    ssrEnabled: false,
    ssrStrength: 1,
    ssrMaxDistance: 50,
    ssrThickness: 1.2,
    ssrEdgeFade: 0.15,

    // Sun glint.
    sunColor: "#fff4e0",
    shininess: 420,
    glintStrength: 3,
    glintFresnel: 0.35,
    glintSpread: 0.4,
    glintShoreFade: 0.06,

    // Waterline.
    shoreFade: 0.06,
    surfaceOpacity: 1,

    // ── Whitewater ─────────────────────────────────────────────────────────
    // Three independent sources, one shared advected noise field:
    //   turbulence — the reach itself is steep and fast (rapids)
    //   shallows   — the water is thin here (bank edges, gravel bars)
    //   wake       — something solid is standing upstream of this fragment
    foamEnabled: true,
    foamColor: "#eef6f7",
    /** Whitewater from the solved slope×speed of the reach. */
    turbulence: 0.9,
    /** Solved turbulence below this contributes nothing — keeps calm reaches calm. */
    turbulenceCutoff: 0.18,
    /** Metres of vertical depth over which the shallow-water foam fades out. */
    shallowDepth: 0.35,
    shallows: 0.85,
    /**
     * Foam trailing behind rocks, piers, the player — anything solid standing in
     * the river. Found by looking a short way UPSTREAM in screen space and
     * asking the depth buffer whether the water is still there.
     */
    wake: 1.1,
    /** Metres upstream the wake test reaches. */
    wakeDistance: 2.4,
    /** Noise cells per metre in flow space. Foam advects with the current. */
    foamScale: 0.55,
    /**
     * How hard the noise chews holes in the foam. 0 = flat white.
     * Applied multiplicatively, so it still breaks up a SATURATED source — a
     * real cascade reaches turbulence 1.0 by itself, and before this it went
     * flat white there.
     */
    foamBreakup: 0.9,
    /** Contrast stretch on the foam noise, so it swings the full 0..1 and can
     *  cross the cutoff from both sides instead of hovering near its mean. */
    foamContrast: 2.2,
    foamSharpness: 1.3,
    /** Below this the foam is cut away entirely. */
    foamCutoff: 0.4,
    foamTransition: 0.16,

    // ── Surface displacement ───────────────────────────────────────────────
    // Real vertical relief, not a normal-map illusion — see waveHeight in
    // riverV2Material.js for why the swell advects at one speed while the
    // standing waves do not advect at all.
    waveEnabled: true,
    /** Metres of swell, peak. Small: a river is not the sea. */
    swellAmplitude: 0.055,
    swellLength: 5.5,
    swellSpeed: 1.6,
    /** Metres of standing wave at full turbulence — the rapids relief. */
    standingAmplitude: 0.22,
    /** Standing-wave spacing, as a multiple of the local water depth. */
    standingLength: 6,

    // ── Flow streaks ───────────────────────────────────────────────────────
    /** Faint lengthwise banding, the thing that reads as "moving water" even
     *  when the surface is otherwise calm. */
    streakStrength: 0.12,
    streakScale: 0.35,

    ...overrides,
  };
}

/** State object -> riverV2Material syncParams(). */
export function riverWaterParams(s) {
  return {
    absorption: [s.absorptionR, s.absorptionG, s.absorptionB],
    absorptionScale: s.absorptionScale,
    inscatterTint: s.inscatterTint,
    inscatterStrength: s.inscatterStrength,
    depthDistance: s.depthDistance,

    normalTiling: s.normalTiling,
    normalStrength: s.normalStrength,
    normalTiling2: s.normalTiling2,
    normalStrength2: s.normalStrength2,
    advectPeriod: s.advectPeriod,
    flowBias: s.flowBias,

    refractionStrength: s.refractionStrength,
    fresnelScale: s.fresnelScale,
    skyReflectIntensity: s.skyReflectIntensity,
    ssrEnabled: s.ssrEnabled,
    ssrStrength: s.ssrStrength,
    ssrMaxDistance: s.ssrMaxDistance,
    ssrThickness: s.ssrThickness,
    ssrEdgeFade: s.ssrEdgeFade,

    sunColor: s.sunColor,
    shininess: s.shininess,
    glintStrength: s.glintStrength,
    glintFresnel: s.glintFresnel,
    glintSpread: s.glintSpread,
    glintShoreFade: s.glintShoreFade,

    shoreFade: s.shoreFade,
    surfaceOpacity: s.surfaceOpacity,

    foamEnabled: s.foamEnabled,
    foamColor: s.foamColor,
    turbulence: s.turbulence,
    turbulenceCutoff: s.turbulenceCutoff,
    shallowDepth: s.shallowDepth,
    shallows: s.shallows,
    wake: s.wake,
    wakeDistance: s.wakeDistance,
    foamScale: s.foamScale,
    foamBreakup: s.foamBreakup,
    foamContrast: s.foamContrast,
    foamSharpness: s.foamSharpness,
    foamCutoff: s.foamCutoff,
    foamTransition: s.foamTransition,

    streakStrength: s.streakStrength,
    streakScale: s.streakScale,

    waveEnabled: s.waveEnabled,
    swellAmplitude: s.swellAmplitude,
    swellLength: s.swellLength,
    swellSpeed: s.swellSpeed,
    standingAmplitude: s.standingAmplitude,
    standingLength: s.standingLength,
  };
}
