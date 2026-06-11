const VOLUMETRIC_CLOUD_DEFAULTS = {
  enabled: false,
  /** Same default as superjet: fixed world volume; enable to lerp XZ toward pivot / car. */
  followCamera: false,
  /** Same as superjet `lodAuto` — reduce raymarch steps when camera is far from the volume. */
  lodAuto: true,
  /** Same as superjet `isAnimating` — scroll 3D noise offset. */
  isAnimating: true,
  cloudFollowSmoothing: 0.12,
  lodFrustumCull: true,
  containerScale: 420,
  /** Same default as `clouds_terrain_1600-superjet.html` `parameters.cloudHeightY`. */
  cloudHeightY: 268,
  textureSize: 96,
  cloudCoverage: 0.55,
  cloudSoftness: 0.05,
  noiseScale: 3.5,
  octaves: 5,
  persistence: 0.5,
  lacunarity: 3.0,
  noiseIntensity: 1.0,
  /** Overridden per session in `createToolState()` like superjet `Math.random() * 1000`. */
  seed: 0,
  textureTiling: 2.0,
  densityThreshold: 0.0,
  densityMultiplier: 50.0,
  opacity: 6.0,
  raymarchSteps: 44,
  lightSteps: 1,
  animationSpeedX: 0.02,
  animationSpeedY: 0.0,
  animationSpeedZ: 0.01,
  raio: 0.52,
  maskSoftness: 0.17,
  achatamentoCima: 0.7,
  achatamentoBaixo: 0.3,
  achatamentoXpos: 0.9,
  achatamentoXneg: 0.9,
  achatamentoZpos: 0.9,
  achatamentoZneg: 0.9,
  maskSeed: 1,
  forcaRuido: 0.05,
  frequenciaRuido: 2.7,
  seedDetalhe: 10,
  forcaRuidoDetalhe: 0.036,
  frequenciaRuidoDetalhe: 10.5,
  visualizeMask: false,
  /** Occlusion / god-rays buffer scale (same role as superjet `effectBufferScale`). */
  effectBufferScale: 0.35,
  godRaysExposureUI: 0.58,
  godRaysSamplesUI: 64,
  godRaysDensity: 0.98,
  godRaysDecay: 0.975,
  godRaysWeight: 0.55,
  sunMeshDistance: 8000,
  sunDiscRadius: 260,
  frustumDimGodRays: false,
  /**
   * Skip real PBR / foliage / plane shaders during the depth prepass —
   * swap only the heavy terrain-chunk materials with a basic depth-write
   * material. Foliage / grass / plane keep their `positionNode` vertex
   * displacement so their depth values stay correct.
   */
  useDepthPrepassOverride: true,
  /**
   * Render the cloud system's own bright `sunSphere` disc in the final
   * scene pass. Defaults off because the v2 editor already has a sky mesh
   * with its own sun — leaving this on duplicates the sun visually. The
   * sun mesh is still rendered during the occlusion pass either way, so
   * god-rays continue to work and converge on the same direction the sky
   * draws its sun.
   */
  showCloudSunDisc: false,
};

export const V2_CONFIG = {
  world: {
    size: 1600,
    chunkSize: 100,
    dataResolution: 64,
    minHeight: -60,
    maxHeight: 800,
    /** When true, new chunks are filled with `initialHeight` instead of `sampleInitialHeight` noise. */
    flatInitialTerrain: true,
    initialHeight: 0,
  },
  lod: {
    enabled: true,
    /** v1 used 0.2; 0.15 is slightly snappier but may thrash near threshold boundaries. */
    hysteresis: 0.2,
    /** v1 default: 16 (covers full 1600m world from any corner). Keeps L4 chunks streaming but they are cheap. */
    activeRadiusInChunks: 16,
    /** Thresholds match `splatmap-chunks.html` CONFIG.lodLevels: 200/420/800/1400/∞. */
    levels: [
      { maxDistance: 200, segments: 64, label: "L0" },
      { maxDistance: 420, segments: 32, label: "L1" },
      { maxDistance: 800, segments: 16, label: "L2" },
      { maxDistance: 1400, segments: 8, label: "L3" },
      { maxDistance: Infinity, segments: 4, label: "L4" },
    ],
  },
  budgets: {
    createPerFrame: 2,
    remeshPerFrame: 3,
    /** Incremental sculpt remeshes — far cheaper than full rebuilds, larger cap. */
    sculptRemeshPerFrame: 24,
    unloadPerFrame: 8,
    cheapSegmentThreshold: 8,
    cheapCreateBonusPerFrame: 24,
  },
  sculpt: {
    brushMin: 2,
    brushMax: 120,
    strengthMin: 0.02,
    strengthMax: 2.5,
    defaultRadius: 28,
    defaultStrength: 0.55,
    defaultFalloff: 1.8,
    /**
     * v1 `PARAMS.brushFalloff` enum — only affects raise/lower default "smooth" stamp.
     * "smooth" (cosine) | "linear" | "sphere" | "hard".
     */
    defaultBrushFalloff: "smooth",
    /**
     * v1 `PARAMS.sculptBrush` for raise/lower only: `smooth` uses brushFalloff enum;
     * `plateau` is the v1 mesa curve; `crater` is the v1 rim-minus-pit curve.
     */
    defaultRaiseLowerStamp: "smooth",
    /** v1 `PARAMS.terraceStep` / `PARAMS.terraceSharpness` — `terrace` sculpt mode. */
    terrace: {
      step: 4,
      sharpness: 0.6,
    },
    spacingFactor: 0.22,
    /** v1 `PARAMS.noiseScale` / `noiseOctaves` — sculpt noise brush FBM. */
    noiseScale: 2.5,
    noiseOctaves: 2,
    /** Viewport brush cursor: `"dome"` (hemisphere + edges) or `"circle"` (flat ring). */
    previewShape: "dome",
    /**
     * Two-point ramp shaping (v1 used fixed cross falloff ^2 and linear height).
     * - crossExponent: power on (1 - dist_perp/r); lower ≈ wider “flat” corridor, higher ≈ sharp sides.
     * - alongExponent: power on t along A→B for height only; >1 = gentler start / steeper finish, <1 opposite.
     */
    ramp: {
      crossExponent: 2,
      alongExponent: 1,
    },
    /** v1 `PARAMS.erosion` — hydraulic brush + future global pass (`iterations` unused by brush). */
    erosion: {
      iterations: 30000,
      erosionRate: 0.3,
      depositionRate: 0.3,
      evaporation: 0.015,
      inertia: 0.1,
      capacity: 6,
      radius: 3,
    },
    /** Same idea as `splatmap-chunks.html` PARAMS.sculptClamp* — not the initial noise range. */
    sculptClampMin: -200,
    sculptClampMax: 2000,
    /**
     * FBM peak stamp — v1 `fbm_peak` used fixed literals; v2 exposes them (defaults match v1).
     */
    fbmPeak: {
      /** Multiplies built-in frequency `3.5 / radius` (higher = finer detail in the stamp). */
      freqMul: 1,
      octaves: 6,
      spikePower: 2.5,
      base: 0.35,
      ridgeWeight: 1.8,
      gain: 2.0,
    },
    /** `splatmap-chunks.html` PARAMS.gen — procedural height (all chunks). */
    gen: {
      mode: "ridge",
      scale: 4.0,
      octaves: 6,
      height: 120,
      seed: 0,
      domainWarp: 0.5,
      dropoff: 1.2,
      dropoffShape: "circle",
      offsetX: 0,
      offsetZ: 0,
      plains: 0,
      additive: false,
      tiltX: 0,
      tiltZ: 0,
    },
  },
  borderMountains: {
    enabled: false,
    extent: 500,
    height: 280,
    steepness: 1.2,
    noiseScale: 2,
    noiseOctaves: 4,
    seed: 42,
  },
  render: {
    terrainSkirtDepth: 80,
    maxPixelRatio: 2,
    clearColor: 0xa3c7df,
  },
  /**
   * Paint mode — 4 layer splat (layer0 base + R/G/B weights → layers 1/2/3).
   * Shader normalizes per-pixel so R+G+B can freely exceed 1 (over-paint) and
   * the material still blends meaningfully.
   */
  paint: {
    /** Per-chunk splat texture resolution. 100m chunk / 128 ≈ 0.78 m/texel. */
    splatResolution: 128,
    /** Default active layer (0 = base, 1..3 = R/G/B). Unreal-style palette starts on layer 1. */
    defaultActiveLayer: 1,
    /** Brush opacity scale for paint strokes — strength maps 0..1 onto this. */
    brushOpacity: 0.6,
  },
  /** Defaults from `splatmap-chunks.html` PARAMS.light (sun + fill + tone exposure). */
  light: {
    sunAzimuth: 135,
    sunElevation: 43,
    dirColor: "#fff5e0",
    dirIntensity: 2.2,
    /** Directional key-light intensity at NIGHT (moon), procedural sky only. The
     * light switches to the moon (sun antipode, `proceduralSky.moonColor`) once
     * the sun drops below the horizon, so night terrain is moonlit. */
    moonIntensity: 0.3,
    hemiSkyColor: "#c8e0ff",
    hemiGroundColor: "#88aa55",
    hemiIntensity: 0.4,
    envIntensity: 0.2,
    /** Used only when sky mode is Import HDR (physical sky uses `envIntensity`). */
    hdrEnvIntensity: 1,
    /** Equirect `scene.background` strength in HDR mode (drei-style). */
    hdrBackgroundIntensity: 0.7,
    exposure: 0.5,
    sunDistance: 600,
    shadowBias: -0.0005,
    shadowNormalBias: 0.02,
  },
  /** `splatmap-chunks.html` PARAMS.lensFlare — sun-anchored screen-space flare. */
  lensFlare: {
    enabled: true,
    intensity: 3.0,
    halationSize: 3.0,
    halationColor: "#ffdca8",
    streakLength: 0.0,
    streakOpacity: 0.7,
    streakColor: "#8cc8ff",
    ghostOpacity: 2.0,
    ghostSpacing: 1.0,
    dirtOpacity: 0.0,
  },
  /** `splatmap-chunks.html` PARAMS.sky when mode === "physical" (SkyMesh uniforms). */
  physicalSky: {
    turbidity: 2,
    rayleigh: 1.5,
    mie: 0.005,
    mieG: 0.8,
    cloudCoverage: 0.4,
    cloudDensity: 0.4,
    cloudElevation: 0.5,
    meshScale: 10000,
  },
  /**
   * `skyMode === "procedural"` — the daynight-sky dome (gradient + Nishita
   * scattering + sun/moon/stars/Milky Way/meteors + 2D cirrus). Mirrors
   * `SKY_DEFAULTS` in `render/sky/dayNightSky.js`; keep the two in sync.
   * The volumetric cloud deck is a separate (later) system — NOT here.
   */
  proceduralSky: {
    // 0–24 convenience slider: writes the scene sun's Azimuth/Elevation (the
    // single sun source). Not authoritative on load — az/el are serialized.
    timeOfDay: 9.5,
    autoAdvance: false, // animate the day/night cycle over time
    daySpeed: 0.5, // hours of timeOfDay advanced per real second

    zenithDay: "#2a6bd8",
    horizonDay: "#bfe0ff",
    zenithNight: "#05080f",
    horizonNight: "#1a2740",
    sunsetColor: "#ff7a33",
    groundColor: "#4a4a52",

    // Atmospheric scattering (Nishita). scatter:true = physical sky.
    scatter: true,
    sunIntensity: 22,
    rayleigh: 1.0,
    mie: 1.0,
    mieG: 0.76,
    atmoAltitude: 1500,
    msAmount: 0.0, // multi-scatter fill OFF by default (was the twilight band source)
    msExtinct: 0.3,
    // Sky-dome horizon haze height (lab PARAMS.fog.hazeHeight). Lower = the
    // haze hugs the waterline so the scattering band reads clearly above it.
    hazeHeight: 0.12,

    sunColor: "#fff3d8",
    sunSizeDeg: 1.2,
    sunGlowPow: 280,
    sunGlowStrength: 0.55,
    sunDiscBright: 8.0,

    moonColor: "#cdd9ff",
    moonSizeDeg: 1.6,
    moonGlowStrength: 0.25,
    moonDiscBright: 3.0,
    moonPhase: 0.85,
    moonPhaseOrient: 30,
    moonSurface: 0.85,
    moonEarthshine: 0.12,
    moonTermSoft: 0.06,

    starDensity: 220,
    starThreshold: 0.92,
    starSize: 0.08,
    starBrightness: 1.0,
    starTwinkle: 3.0,

    milkyWayEnabled: true,
    milkyWayIntensity: 1.0,
    milkyWayWidth: 0.32,
    milkyWayScale: 4.0,
    milkyWayColor1: "#5566a0",
    milkyWayColor2: "#efe6cf",

    meteorEnabled: false,
    meteorIntensity: 1.0,
    meteorRate: 0.45,
    meteorSpeed: 1.0,
    meteorWidth: 0.006,
    meteorLength: 0.1,

    // High cirrus deck (2D analytic clouds on the dome — NOT the volumetric).
    cloudEnabled: true,
    cloudCoverage: 0.5,
    cloudDensity: 0.85,
    cloudOpacity: 1.0,
    cloudScale: 0.7,
    cloudStretch: 2.5,
    cloudSharpness: 0.22,
    cloudDetail: 0.8,
    cloudSunTint: 1.0,
    cloudSpeed: 0.01,
    cloudWindDeg: 20,
    cloudColor: "#ffffff",
    cloudAerial: 0.8,
  },
  /**
   * Volumetric cloud DECK for the procedural sky — faithful port of the
   * daynight-sky lab `cloud-layer.js` (mirrors its CLOUD_DEFAULTS). Separate from
   * the 3 existing volumetric systems; only used when skyMode === "procedural".
   * Disabled by default (baking the 96³ noise volume is a one-time CPU cost).
   */
  volumetricCloudDayNight: {
    enabled: false,
    // Lab defaults. Once the far-plane march cull was fixed (occlusion now gated
    // on real geometry), the deck reaches the ground horizon regardless of base,
    // so there's no need to lower it for v2's camera — restored to match the lab.
    base: 1900,
    thickness: 1400,
    scale: 0.00015,
    detailMul: 4.0,
    coverage: 0.4,
    softness: 0.12,
    erode: 0.15,
    densityMul: 12.0,
    steps: 128,
    lightSteps: 8,
    emptySkip: 1.0,
    bufferScale: 0.5,
    maxDist: 24000, // lab default
    planetRadius: 160000,
    opacity: 0.7,
    lightAbsorb: 1.1,
    phaseG: 0.3,
    powder: 0.5,
    msAmount: 0.7,
    msExtinction: 0.5,
    msContribution: 0.5,
    msEccentricity: 0.5,
    windDeg: 35,
    windSpeed: 0.02,
    aerialEnabled: true,
    aerialDensity: 0.00012,
    aerialAmount: 1.0,
  },
  /**
   * Cloud shadows for the daynight volumetric deck (lab PARAMS.cloudShadows).
   * Darkens terrain + ocean under the deck in the cloud composite pass; only
   * active when the deck is enabled + procedural sky. Strength fades with day.
   */
  cloudShadows: {
    enabled: true,
    strength: 0.6,
  },
  /**
   * God-rays / light shafts for the daynight deck (lab GOD_RAYS_DEFAULTS). Its
   * own cloud-aware pass (the occlusion silhouette uses the cloud deck, so shafts
   * stream through the gaps). Default OFF like the lab page. Only the deck +
   * procedural sky path runs it.
   */
  cloudGodRays: {
    enabled: false,
    effectScale: 0.35,
    exposure: 0.58,
    samples: 64,
    density: 0.98,
    decay: 0.975,
    weight: 0.55,
    skipOffscreen: true,
    occCloudSteps: 12,
    // Lab uses sunDistance 8000 / discRadius 260, but v2's camera far plane is
    // 5000 — a disc past it gets clipped (no rays). The disc's SCREEN position
    // only depends on the sun direction (all points along a ray project the
    // same), so we pull it inside the far plane and scale the radius to keep the
    // same angular size (260/8000 ≈ 130/4000). Keep sunDistance < ~4800.
    sunDistance: 4000,
    sunDiscRadius: 130,
    sunTint: "#ffddaa",
    matchLightColor: false,
  },
  /**
   * Cloud bloom for the daynight deck (lab PARAMS.bloom). Blooms the FINAL
   * scene+clouds composite (owns-the-frame path / post-FX OFF) so sunlit cloud
   * edges glow — v2's own post-FX bloom can't reach the clouds (solids-only).
   */
  cloudBloom: {
    enabled: false,
    strength: 0.4,
    radius: 0.6,
    threshold: 0.92,
  },
  /** `splatmap-chunks.html` PARAMS.csm — WebGPU `CSMShadowNode` on the sun. */
  csm: {
    enabled: true,
    cascades: 2,
    maxFar: 300,
    lightMargin: 100,
    mapSize: 2048,
    updateEveryFrame: false,
  },
  tree: {
    maxSlots: 8,
    maxInstancesPerMesh: 4096,
  },
  /** WebGPU TSL fog. */
  fog: {
    // Analytic half-space height fog (Crytek/Wenzel): density profile
    // a·exp(−falloff·(y − height)) integrated along the camera→fragment ray.
    // `density` = extinction/m at the base height; `falloff` = 1/m vertical
    // decay (≈ 1/falloff m layer thickness).
    height: {
      enabled: false,
      color: "#a8c4e0",
      density: 0.015,
      falloff: 0.05,
      height: 30.0,
    },
    distance: {
      enabled: false,
      color: "#d0e4f0",
      density: 0.006,
      // Daynight-lab aerial perspective: when `matchSky` is on (procedural sky),
      // the away-from-sun fog color tracks the sky's horizon each frame so distant
      // geometry dissolves into the horizon; `sunTint`/`tintPow` add a warm haze
      // glow toward the sun that fades out at night.
      matchSky: true,
      sunTint: "#ffd6a0",
      tintPow: 2.0,
    },
  },
  /**
   * World-stable enclosed-space lighting (spline tunnels, caves, manual boxes).
   * Uses scene.fogNode + scaled hemisphere/IBL — not shadow-map dependent.
   */
  interior: {
    enabled: false,
    strength: 0.88,
    color: "#0c0e14",
    /** Scale for hemisphere + env when deep inside (0 = black fill, 1 = no change). */
    ambientScale: 0.22,
    tunnelRadiusScale: 0.92,
    /** Target spacing along tunnel centerline (m); stretches if the path needs more than 192 segments. */
    segmentStep: 4,
    edgeSoftness: 0.35,
    openingLength: 10,
    boxEdgeSoftness: 0.28,
    caveShrink: 0.94,
    manualBoxes: [],
  },
  /**
   * Ray-marched volumetric cloud box (`v2/render/clouds/volumetricCloudSystem.js`).
   * Off by default; enable from editor World tab.
   */
  volumetricCloud: {
    ...VOLUMETRIC_CLOUD_DEFAULTS,
  },
  /**
   * Optimized fork (`v2/render/clouds/volumetricCloudSystemv2.js`): cheap occlusion march + fractional `cloudRT`.
   * Separate tool state; enable from World tab. Prefer disabling classic volumetric clouds when using this.
   */
  volumetricCloudOptimized: {
    ...VOLUMETRIC_CLOUD_DEFAULTS,
    /** Full-screen scale for the beauty cloud pass (0.25–1). */
    cloudBufferScale: 0.5,
    /** Occlusion-only raymarch steps (≤32, shader loop cap). */
    occlusionRaymarchSteps: 12,
    /** Temporal reprojection: reuse previous frame's cloud result where valid. */
    temporalEnabled: true,
    temporalBlendFactor: 0.92,
  },
  /**
   * V3 — flight-game tuned (`v2/render/clouds/volumetricCloudSystemv3.js`).
   * Full-resolution cloud (no half-res RT, no TAA) so mountain silhouettes
   * stay crisp and there is no ghosting at flight speeds. Optimizations:
   *   - Cheap occlusion-only cloud material for god-rays silhouette.
   *   - Empty-space skipping in the main raymarch.
   *   - Inside-cloud step boost when the camera is inside the AABB.
   *   - Sun-offscreen skip for the occlusion + god-rays pass.
   *   - Depth-prepass override material (skips real shaders).
   *   - Baked mask volume via uniform-branch (one sample vs two + math).
   */
  volumetricCloudV3: {
    ...VOLUMETRIC_CLOUD_DEFAULTS,
    /** Cheap silhouette material during god-rays occlusion pass. */
    cheapOcclusionCloud: true,
    /** Steps for the cheap occlusion material (≤32, shader loop cap). */
    occlusionRaymarchSteps: 12,
    /** Sky / terrain rays advance faster in low-density regions. */
    emptySpaceSkip: true,
    /** Multiplier for empty-space step size (1.0 = disabled, 2.0 = ~half steps in empty space). */
    emptySpaceStepMul: 2.0,
    /** Boost raymarch steps when camera is inside the cloud AABB. */
    insideCloudStepBoost: true,
    /** Multiplier for step count when inside the cloud (capped at MAX_RM_STEPS). */
    insideCloudStepMul: 1.6,
    /** Skip occlusion + god-rays render when the sun is outside the expanded viewport. */
    skipGodRaysOffscreen: true,
    /** Use a baked 3D-texture mask instead of analytical SDF math. */
    bakedMaskMode: true,
    /** Bake size for the mask volume (powers-of-two friendly; 64 ≈ 25ms bake). */
    maskBakeSize: 64,
  },
};

export function getChunkCountPerAxis(config = V2_CONFIG) {
  return Math.floor(config.world.size / config.world.chunkSize);
}

