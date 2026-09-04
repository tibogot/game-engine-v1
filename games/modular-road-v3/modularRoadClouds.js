/**
 * Volumetric clouds for the modular-road game — built to be FLOWN THROUGH.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * THIS IS NOT THE EDITOR'S DECK, AND IT DELIBERATELY SHARES NO CODE WITH IT.
 * v3/render/clouds/dayNightCloudLayer.js is untouched by this file and stays the editor's
 * cloud system. The two look like the same problem and are not:
 *
 *   editor deck                          this
 *   ───────────────────────────────      ───────────────────────────────────────────────
 *   viewer 2 km below, never enters      car flies through it at 30 m/s
 *   base 1900 m, thickness 1400 m        base ~260 m — reachable from a sky track
 *   fixed 128 steps over the slab        adaptive step: metres near, tens of metres far
 *   ~52 m per base voxel                 ~9.4 m base + a ~2.8 m near-field octave
 *   uniform global coverage (a ceiling)  2D weather map — real masses with real gaps
 *   light march 148 m/step               cone march, short first steps
 *   flat 5-tap upsample blur             depth-aware upsample (no halo around the car)
 *   3.1 s synchronous bake on construct  worker bake, clouds fade in
 *
 * Serving both from one shader with uniforms would produce something mediocre at both, so
 * they are separate systems that happen to share a research lineage (Nubis / GPU Pro 7).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * THE STEP SCHEDULE IS THE WHOLE TRICK.
 *
 * A fixed step count divided across the ray's slab crossing is what breaks a fly-through.
 * From below, entry→exit is short and 128 steps is plenty. From INSIDE the deck looking
 * along it, entry→exit is the whole view distance, and those same 128 steps stretch to
 * ~190 m each — so the worst quality lands exactly where the camera is. Here the step
 * grows with distance from the camera instead:
 *
 *     step(t) = clamp(minStep + t * growth, minStep, maxStep)
 *
 * Near the camera that is ~1.6 m (finer than the near-detail octave, so the detail is
 * actually resolved); far away it caps at ~60 m, well under a base voxel in screen terms
 * at that range. Cost stays bounded because the step grows geometrically, and empty space
 * is skipped at a multiple of it — with a step-back when the skip lands inside cloud, so
 * thin edges are not eaten.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * RENDER PATH. `renderFrame()` owns the frame:
 *   1. scene (+depth) → sceneRT, cloud dome excluded by layer
 *   2. clouds → half-res cloudRT, reading sceneRT's depth for occlusion
 *   3. composite → canvas, depth-aware upsample
 *
 * Note what is NOT here: the editor's post-FX path renders the whole scene a second time
 * purely to obtain a depth buffer for the cloud march. This path renders the scene once.
 *
 * @see modularRoadCloudNoise.js — the volumes, and why their frequencies are what they are
 * @see cloud-lab.html           — tuning harness with a free-fly camera and GPU timing
 */
import * as THREE from "three/webgpu";
import {
  float, vec2, vec3, vec4, Fn, If, Loop, Break, uniform, uv, texture, texture3D,
  positionWorld, cameraPosition, screenUV, screenCoordinate,
  cameraViewMatrix, cameraProjectionMatrix,
  normalize, dot, max, min, mix, smoothstep, pow, exp, abs, sign, clamp, sin, cos, floor,
  length, saturate, fract, sqrt, cross, select,
} from "three/tsl";
import {
  BASE_TILE_M, DETAIL_TILE_M, NEAR_TILE_M, WEATHER_TILE_M,
  BASE_SIZE, DETAIL_SIZE, NEAR_SIZE, WEATHER_SIZE, BLUE_NOISE_SIZE, bakeBlueNoise,
  densityAtCPU, SOLID_BASE_SIZE, SOLID_WEATHER_SIZE, solidDensityAtCPU,
} from "./modularRoadCloudNoise.js";

/** Layer the cloud dome lives on, so the main scene pass skips it and we march it alone. */
export const CLOUD_LAYER = 19;

/** Loop bounds. TSL `Loop` compiles to a fixed trip count, so these are compile-time
 *  ceilings; the runtime uniforms (`steps`, `lightSteps`) cut the loop short via Break. */
const MAX_STEPS = 192;
const MAX_LIGHT_STEPS = 6;
const MAX_RAY_STEPS = 32;

const INV_4PI = 1.0 / (4.0 * Math.PI);
/** Per-channel extinction. Blue is scattered out of the beam least, so deep cores drift
 *  slightly warm-grey rather than neutral black. */
const EXTINCTION = new THREE.Vector3(1.0, 1.02, 1.06);

export const CLOUD_DEFAULTS = {
  enabled: true,

  // ── Shape ────────────────────────────────────────────────────────────────────────
  /** Cloud base altitude, world metres. Low on purpose: a sky track builds at 40 m by
   *  default, so the deck has to be somewhere a car can actually reach. */
  base: 260,
  /** Deck thickness, world metres. */
  thickness: 620,
  /**
   * Fraction of the sky that carries cloud, 0 = clear, 1 = overcast.
   *
   * A THRESHOLD on the weather field, not a multiplier. It used to scale the coverage
   * channel (`cov = w.r * coverage`), which reads as the same dial but is structurally
   * different: at 0.45 even the HEART of the biggest mass could never exceed 45% coverage,
   * so the Nubis bar (`remap(base, 1 - cov, 1)`) sat at 0.55 minimum everywhere and only
   * noise PEAKS survived — every cloud in the sky was a translucent grey wisp, and the
   * deck read as popcorn. Real partly-cloudy skies are bimodal: coverage ≈ 1 INSIDE a
   * mass, 0 between masses, and the dial should move the BOUNDARY. Thresholding the
   * (full-range, percentile-normalized) weather channel does exactly that: interiors go
   * solid white-cored, edges stay wispy over `coverageSoft`, and the gaps are honestly
   * blue. The dial keeps its meaning — the channel is range-normalized, so coverage 0.45
   * covers roughly 45% of the sky.
   */
  coverage: 0.9,
  /** Bias added to the weather channel before the threshold — the "more/less cloud" dial. */
  coverageBias: 0.0,
  /**
   * Half-width of the coverage threshold, in weather-channel units. The wispy skirt of a
   * mass: smaller = harder cloud edges against blue, larger = broader fading rims. The
   * spatial width this maps to depends on the weather field's local gradient (~hundreds of
   * metres at the default weather tile).
   */
  coverageSoft: 0.16,
  /** Overall density (extinction scale per metre). */
  densityMul: 0.16,
  /** Mid-frequency edge erosion strength. */
  erode: 0.32,
  /** Near-field (2.8 m) erosion strength — only applied within `nearRange`. */
  nearErode: 0.45,
  /** Metres over which the near-field octave fades out. Past this it costs nothing. */
  nearRange: 320,
  /**
   * Metres over which the MID-frequency erosion fades out. This is an anti-aliasing
   * control, not a look control.
   *
   * The march step grows with distance (60 m at the far cap), while the detail volume
   * carries ~14 m features. Past a few hundred metres we are sampling 14 m detail once
   * every 50 m — hopeless undersampling, and every pixel lands somewhere different, which
   * IS the crosshatch speckle at distant cloud edges. Jitter turns that into noise and no
   * jitter turns it into banding; neither is a fix, because the information was never
   * sampled. Fading the detail out with distance removes the frequencies the march cannot
   * resolve — prefiltering, the same reason mipmaps exist. Distant clouds go smoother,
   * which is also what the eye expects.
   */
  detailRange: 1700,
  /** Push the weather map toward cumulus (1) or stratus (0). 0.5 = as baked. */
  typeBias: 0.5,
  /** Shortest cloud, as a fraction of `thickness`. The spread between this and 1.0 IS the
   *  towering-vs-flat look: at 1.0 every cloud fills the slab and you get a sheet. */
  cloudTopMin: 0.18,
  /**
   * Height at a cloud's OUTLINE as a fraction of its height at the core — the taper that
   * follows the coverage THRESHOLD rather than the raw field (see sampleWeather). 1.0
   * restores the previous behaviour, where turning coverage down left small clouds
   * standing at mid-range heights. Less aggressive than the painted deck's 0.12 because
   * the weather bake already carries 60% of this correlation.
   */
  edgeTaper: 0.35,
  /** Shifts every cell's top up or down. -0.5 = all shallow, +0.5 = all full height. */
  cloudTopBias: 0.0,
  /** Metres over which density ramps up from the camera. Keeps a readable bubble around
   *  the car inside a dense core. 0 = physically honest (total whiteout). */
  clearRadius: 55,
  /** Density multiplier AT the camera. 0 = fully clear at zero distance. */
  clearFloor: 0.0,

  // ── March ────────────────────────────────────────────────────────────────────────
  /** Finest step, metres — the near-camera step size. */
  minStep: 1.6,
  /** How fast the step grows with distance (metres of step per metre of distance). */
  stepGrowth: 0.028,
  /**
   * Step ceiling, metres. Was 60, which put the far field at ~50 m steps against ~14 m
   * cloud detail — hopeless undersampling, and the source of the crosshatch speckle at
   * distant cloud edges. 28 m costs a measured +0.35 ms and is what makes the edges
   * actually clean; the jitter cap and the detail prefilter alone were not enough.
   *
   * (Since the entry jitter went back to a full step — see jitterMaxM — this is a pure
   * cost/sharpness dial again: pushing it to 60 no longer bands the clouds into shells,
   * it just resolves less far-field billow for ~-0.4 ms.)
   */
  maxStep: 28,
  /**
   * Fewest samples the march must take across the slab's own thickness.
   *
   * `maxStep` alone is a step ceiling in METRES, which silently means something different
   * for every deck. It was set to 28 against a 620 m deck — 22 samples through the slab,
   * which is fine. Raise the deck to a thin high layer (420 m at 1500 m, the shape real
   * fair-weather cumulus has) and the same 28 m ceiling now buys only 15 samples through
   * it, most of them wasted on the jittered entry and exit. That is what the speckle on a
   * high thin deck is: not noise to be filtered, but density that was never sampled.
   *
   * This caps the step at `thickness / slabSamples` as well, so the schedule adapts to the
   * deck instead of to a number that was true once. It can only ever LOWER the step, so it
   * cannot make anything coarser than it already was — and at the game's own 620 m deck
   * 620/22 = 28.2 m, i.e. it is a no-op there by construction. Set 0 to disable.
   *
   * (This is the same problem the reference renderer solves with a per-step optical-depth
   * cap. That is the better answer — it spends steps where the cloud actually is, not
   * uniformly across the slab — and is the next thing to try if this is not enough.)
   */
  slabSamples: 22,
  /** Hard step-count budget (<= MAX_STEPS). */
  steps: 160,
  /** Empty-space steps are this multiple of the local step. */
  emptyStepMul: 3.0,
  /**
   * Cap on the start-of-march dither, in METRES. At 60 it never binds — the entry jitter
   * is a FULL local step, which is what actually prevents shell banding.
   *
   * HISTORY, because this dial has been on both sides of a trade and the reasons matter:
   * full-step jitter once caused crosshatch speckle at distant cloud edges, so it was
   * capped at 7 m. But the speckle's ROOT CAUSE was detail frequencies the far march
   * could never resolve — and `detailRange` later removed exactly those. The cap outlived
   * its problem (same story as the upsample blur), and its only remaining effect was the
   * thing the jitter exists to prevent: with 28–60 m steps dithered by at most 7 m, the
   * density field gets sliced into coherent iso-surface shells — ugly topographic contour
   * banding across every front-lit face, worst at grazing dusk light on the threshold
   * model's steep-gradient cores. Full-step jitter erases the shells, the temporal
   * accumulation averages the dither away, and (verified in motion at 25 m/s) the
   * crosshatch does NOT come back. Lower this only if edge speckle is ever traced to the
   * entry dither again — and check `detailRange` first if it is.
   */
  jitterMaxM: 60.0,
  /** Furthest the march travels, metres. The world is 2 km across; past this the aerial
   *  term has faded the clouds into haze anyway. */
  maxDist: 6000,

  // ── Lighting ─────────────────────────────────────────────────────────────────────
  lightSteps: 6,
  /** Metres the cone march reaches at its widest tap. */
  lightConeLength: 90,
  /** Extinction along the light ray. */
  lightAbsorb: 1.7,
  /** Henyey-Greenstein asymmetry (forward scattering). */
  phaseG: 0.32,
  /** Weight of the forward lobe in the dual-lobe phase. */
  phaseW: 0.72,
  /** Powder / dark-edge term strength. */
  powder: 0.45,
  /** Multi-scatter octaves (Wrenninge): each dimmer, less extincted, broader. */
  msAmount: 0.75,
  msExtinction: 0.55,
  msContribution: 0.55,
  msEccentricity: 0.55,
  /** Sun energy into the clouds. */
  sunIntensity: 3.2,
  /** Sky ambient into the clouds. */
  ambientIntensity: 0.5,
  /** Multiple-scattering floor: fraction of sun energy that survives as diffuse in-scatter
   *  deep inside a mass. 0 = physically wrong dark-blue interiors; this is what makes
   *  flying INTO a cloud a bright whiteout instead of a dull fog. */
  msFloor: 0.22,
  /** How fast the floor ramps in with optical depth to the sun. Higher = brighter sooner. */
  msFloorDepth: 0.55,

  // ── God rays ─────────────────────────────────────────────────────────────────────
  /** Sun shafts through the cloud gaps — screen-space radial accumulation. */
  godRays: true,
  /** Overall shaft brightness. 0 skips the pass entirely. */
  rayStrength: 0.7,
  /** Per-tap decay along the march — lower = shorter, punchier shafts. */
  rayDecay: 0.97,
  /** Taps per pixel (≤ MAX_RAY_STEPS). Quarter-res pass, so this is cheap. */
  raySteps: 24,
  /** March length toward the sun, as a fraction of the screen. */
  rayLength: 0.7,
  /**
   * How tightly the shaft source hugs the sun (gaussian falloff in screen units).
   * Higher = a smaller bright core feeding the rays. TUNED IN ANGER: at 8 the halo is so
   * wide it washes the beam structure into a general glow; 18 keeps a compact core so the
   * light/dark spokes the clouds carve actually read as rays.
   */
  rayTightness: 18,

  // ── Ground shadows ───────────────────────────────────────────────────────────────
  /** Max darkening of geometry under dense cloud. 0 = off (skips all shadow work). */
  shadowStrength: 0.5,
  /** Cheap-density value that counts as a full shadow. Lower = harder, darker patches. */
  shadowSoftness: 0.09,

  // ── Wind ─────────────────────────────────────────────────────────────────────────
  windDeg: 35,
  /** Metres per second the deck drifts. */
  windSpeed: 6.0,

  // ── Atmosphere ───────────────────────────────────────────────────────────────────
  aerialEnabled: true,
  aerialDensity: 0.00035,
  aerialAmount: 1.0,

  // ── Quality ──────────────────────────────────────────────────────────────────────
  /** Cloud buffer scale vs. the drawing buffer. 0.5 = half res. */
  bufferScale: 0.5,
  /** How readily the upsample switches from bilinear to nearest-depth at a silhouette.
   *  It scales the RELATIVE depth difference across the 2x2 footprint, so it is
   *  resolution- and distance-independent. 0 = always bilinear (ragged object edges);
   *  higher = crisper edges but more 2x2 blockiness on steep smooth surfaces. Free —
   *  it is arithmetic inside a pass that already runs. */
  upsampleDepthReject: 8.0,
  /**
   * Neighbourhood clamp strength WHILE THE CAMERA IS MOVING. 1 = exact min/max box.
   *
   * The clamp exists to reject stale history across a disocclusion. But it also forces
   * history to track the current frame, and the current frame is a jittered raymarch —
   * so a permanently-on clamp caps how far the temporal accumulation can converge, and
   * the raymarch dither never fully averages out. Measured: with the clamp off, a static
   * camera converges to near-clean; with it on at 1.0, the same stipple survives in the
   * same places, merely attenuated. That is a spatial smooth, not a temporal average.
   */
  historyClampStrength: 1.0,
  /**
   * Clamp strength when the camera is STILL. A camera that is not moving cannot
   * disocclude anything, so there is nothing for the clamp to protect against and it is
   * pure convergence loss. Relaxing it here is what lets the dither actually average away
   * while keeping full ghost rejection the moment the camera moves.
   */
  historyClampIdle: 0.08,
  /** Temporal accumulation: fraction of the reprojected history kept per frame. 0 = off
   *  (raw march, visibly dithered), 0.9 = a ~10-frame running average. Neighbourhood
   *  clamping keeps this from ghosting. */
  historyBlend: 0.9,

  // ── THE "SOLID" MODEL — a second density model and march, chosen at construction ──
  /**
   * "nubis" (the default, everything above) or "solid". Not switchable at runtime: the
   * two models compile to different shaders and the volumes they need differ. See the
   * SOLID block in createModularRoadClouds for what the model is and where it comes from.
   * The game never sets this; the skypro lab does.
   */
  model: "nubis",
  /** Extinction per metre INSIDE the solid (occupancy is ~binary, so this is the whole
   *  density story: 0.048 makes a mass opaque within ~100 m). */
  solidDensity: 0.048,
  /** Shifts the whole top field: the cloud exists where `h < top + coverage - 1`, so 1 is
   *  everything the weather map draws and 0.5 is roughly half the sky. */
  solidCoverage: 0.5,
  /** Added to the baked weather-map height, for live tuning without a re-bake. */
  solidWeatherBias: 0.0,
  /** Metres one wrap of the weather (cloud-top) map covers. */
  solidWeatherScale: 40000,
  /** Metres one wrap of the base-shape volume covers. */
  solidBaseScale: 8000,
  /** Erosion reads the SAME volume at this multiple of baseScale. */
  solidErosionMul: 0.5,
  solidBaseStrength: 1.0,
  /** Erosion strength at the cloud base and at its top (blended by height inside the mass). */
  solidErodeBase: 1.0,
  solidErodePeak: 1.0,
  /** Half-width of the soft edge, in shell-height units; shrinks with altitude by `falloff^km`. */
  solidEdgeSoft: 0.05,
  solidEdgeFalloff: 1.0,
  /** Base march step, metres. The step inside cloud is set by solidMaxOD, not by this.
   *  (The reference's class default is 150; its shipped quality presets go down to 25.
   *  50 is what the skypro lab preset uses — see DECKS.skypro there for the tuning.) */
  solidStep: 50,
  /** Radians of step growth per metre of distance (a cone), so the far field stays bounded. */
  solidConeAngle: 0.003,
  /** Optical depth one step may integrate; inside a mass the step shrinks to honour it. */
  solidMaxOD: 0.5,
  /** First light-march segment, metres. The six taps grow 1.5x each, so the cone reaches
   *  ~17x this toward the sun. NOT 400 (the reference's class default): the origin's own
   *  segment is assumed full of cloud, so at 400 it is optical depth 19 by itself and no
   *  lit surface ever receives sun — the deck goes uniformly grey. Measured. */
  solidLightStep: 30,
  /** Off-axis spread of the light taps, as a fraction of their distance. */
  solidLightSpread: 0.05,
  /** Once a ray has accumulated this much alpha, the light march drops erosion (cheaper). */
  solidFullLightAlpha: 0.3,
  solidAlbedo: 0.9,
  /** Dual-lobe HG eccentricities (forward, back), scaled 1 / 0.5 / 0.25 per scatter octave. */
  solidPhaseFwd: 0.8,
  solidPhaseBack: 0.2,
  /** Ground bounce albedo lighting the undersides (scaled by sun elevation). */
  solidGroundBounce: 0.18,
};

/**
 * @param {object} opts
 * @param {THREE.WebGPURenderer} opts.renderer
 * @param {THREE.Scene}          opts.scene
 * @param {THREE.Camera}         opts.camera
 * @param {number}              [opts.seed]
 * @param {object}              [opts.params] — merged onto CLOUD_DEFAULTS
 */
export function createModularRoadClouds({ renderer, scene, camera, seed = 137, params = {} }) {
  const P = { ...CLOUD_DEFAULTS, ...params };

  // ── Volume textures ────────────────────────────────────────────────────────────────
  // Allocated at FULL size, zero-filled, and later refilled in place by the worker result.
  //
  // Deliberately not 1-voxel placeholders that get swapped for full-size images when the
  // bake lands: three keys the GPU texture off the texture object, and replacing `.image`
  // with different dimensions does not reallocate it. The volumes stay 1x1x1 on the GPU
  // forever, every sample returns the same single texel, and the sky is silently empty —
  // with no error anywhere, because nothing actually failed.
  //
  // Zero-filled means density resolves to 0, so the first seconds simply have no clouds.
  // Total is ~9.7 MB across the four, which is the same memory the bake produces anyway.
  function makeVolume(size) {
    const t = new THREE.Data3DTexture(new Uint8Array(size * size * size * 4), size, size, size);
    t.format = THREE.RGBAFormat;
    t.type = THREE.UnsignedByteType;
    t.minFilter = t.magFilter = THREE.LinearFilter;
    t.wrapS = t.wrapT = t.wrapR = THREE.RepeatWrapping;
    t.needsUpdate = true;
    return t;
  }
  const baseTexture = makeVolume(BASE_SIZE);
  const detailTexture = makeVolume(DETAIL_SIZE);
  const nearTexture = makeVolume(NEAR_SIZE);
  const blueNoiseTexture = new THREE.DataTexture(
    bakeBlueNoise(), BLUE_NOISE_SIZE, BLUE_NOISE_SIZE, THREE.RGBAFormat,
  );
  blueNoiseTexture.wrapS = blueNoiseTexture.wrapT = THREE.RepeatWrapping;
  // NEAREST: a per-pixel lookup table, not an image. Bilinear would average neighbours
  // and hand back exactly the low frequencies the bake removed.
  blueNoiseTexture.minFilter = blueNoiseTexture.magFilter = THREE.NearestFilter;
  blueNoiseTexture.generateMipmaps = false;
  blueNoiseTexture.needsUpdate = true;

  const weatherTexture = new THREE.DataTexture(
    new Uint8Array(WEATHER_SIZE * WEATHER_SIZE * 4), WEATHER_SIZE, WEATHER_SIZE, THREE.RGBAFormat,
  );
  weatherTexture.minFilter = weatherTexture.magFilter = THREE.LinearFilter;
  weatherTexture.wrapS = weatherTexture.wrapT = THREE.RepeatWrapping;
  weatherTexture.needsUpdate = true;

  // The solid model's two textures — only allocated (and only baked) in that model.
  const solidOn = P.model === "solid";
  const solidBaseTexture = solidOn ? makeVolume(SOLID_BASE_SIZE) : null;
  const solidWeatherTexture = solidOn
    ? new THREE.DataTexture(
      new Uint8Array(SOLID_WEATHER_SIZE * SOLID_WEATHER_SIZE * 4),
      SOLID_WEATHER_SIZE, SOLID_WEATHER_SIZE, THREE.RGBAFormat,
    )
    : null;
  if (solidWeatherTexture) {
    solidWeatherTexture.minFilter = solidWeatherTexture.magFilter = THREE.LinearFilter;
    solidWeatherTexture.wrapS = solidWeatherTexture.wrapT = THREE.RepeatWrapping;
    solidWeatherTexture.needsUpdate = true;
  }
  const solidBaseTex = solidOn ? texture3D(solidBaseTexture, null, 0) : null;
  const solidWeatherTex = solidOn ? texture(solidWeatherTexture) : null;

  const baseTex = texture3D(baseTexture, null, 0);
  const detailTex = texture3D(detailTexture, null, 0);
  const nearTex = texture3D(nearTexture, null, 0);
  const weatherTex = texture(weatherTexture);
  const blueTex = texture(blueNoiseTexture);

  let _ready = false;
  let _bakeMs = 0;
  let _fade = 0; // eases in once the bake lands so the deck does not pop
  let _bakeStarted = false;
  let _worker = null;

  // `ready` is handed out at construction but only settles once a bake actually runs, so a
  // caller can await it without forcing the system to be on.
  let _resolveReady;
  const readyPromise = new Promise((res) => { _resolveReady = res; });

  /**
   * Kick the noise bake. Deferred until the clouds are first ENABLED — this is the
   * expensive half of the system (a few seconds of worker CPU and ~10 MB of transferred
   * buffers), and a player who never turns clouds on should never pay for it.
   */
  function startBake() {
    if (_bakeStarted) return readyPromise;
    _bakeStarted = true;
    bakeInWorker(seed, (w) => { _worker = w; }, solidOn)
      .then((res) => {
        // Copy INTO the existing buffers — never reassign `.image`. See makeVolume().
        refill(baseTexture, res.base);
        refill(detailTexture, res.detail);
        refill(nearTexture, res.near);
        refill(weatherTexture, res.weather);
        if (solidOn && res.solidBase) {
          refill(solidBaseTexture, res.solidBase);
          refill(solidWeatherTexture, res.solidWeather);
        }
        _bakeMs = res.ms;
        _ready = true;
        _worker = null;
        _resolveReady({ ms: res.ms });
      })
      .catch((err) => {
        console.warn("[ModularRoadClouds] noise bake failed:", err);
        _worker = null;
        _resolveReady({ ms: 0, error: err });
      });
    return readyPromise;
  }

  function refill(tex, data) {
    const dst = tex.image.data;
    if (dst.length !== data.length) {
      console.warn(
        `[ModularRoadClouds] bake size mismatch: got ${data.length}, expected ${dst.length}`,
      );
      return;
    }
    dst.set(data);
    tex.needsUpdate = true;
  }

  // ── Uniforms ───────────────────────────────────────────────────────────────────────
  const uBase = uniform(P.base);
  const uThickness = uniform(P.thickness);
  const uCoverage = uniform(P.coverage);
  const uCoverageBias = uniform(P.coverageBias);
  const uCoverageSoft = uniform(P.coverageSoft);
  const uDensityMul = uniform(P.densityMul);
  const uErode = uniform(P.erode);
  const uNearErode = uniform(P.nearErode);
  const uNearRange = uniform(P.nearRange);
  const uDetailRange = uniform(P.detailRange);
  const uTypeBias = uniform(P.typeBias);
  const uCloudTopMin = uniform(P.cloudTopMin);
  const uEdgeTaper = uniform(P.edgeTaper);
  const uCloudTopBias = uniform(P.cloudTopBias);
  const uClearRadius = uniform(P.clearRadius);
  const uClearFloor = uniform(P.clearFloor);

  const uMinStep = uniform(P.minStep);
  const uStepGrowth = uniform(P.stepGrowth);
  const uMaxStep = uniform(P.maxStep);
  const uSteps = uniform(P.steps);
  const uEmptyStepMul = uniform(P.emptyStepMul);
  const uJitterMaxM = uniform(P.jitterMaxM);
  const uMaxDist = uniform(P.maxDist);

  const uLightSteps = uniform(P.lightSteps);
  const uLightConeLength = uniform(P.lightConeLength);
  const uLightAbsorb = uniform(P.lightAbsorb);
  const uPhaseG = uniform(P.phaseG);
  const uPhaseW = uniform(P.phaseW);
  const uPowder = uniform(P.powder);
  const uMsAmount = uniform(P.msAmount);
  const uMsExtinction = uniform(P.msExtinction);
  const uMsContribution = uniform(P.msContribution);
  const uMsEccentricity = uniform(P.msEccentricity);
  const uMsFloor = uniform(P.msFloor);
  const uMsFloorDepth = uniform(P.msFloorDepth);

  const uSunDir = uniform(new THREE.Vector3(0.4, 0.8, 0.3).normalize());
  const uSunColor = uniform(new THREE.Color(0xfff2dc));
  const uSunIntensity = uniform(P.sunIntensity);
  const uSkyZenith = uniform(new THREE.Color(0x6f9fd8));
  const uSkyHorizon = uniform(new THREE.Color(0xc3d6ea));
  const uAmbientIntensity = uniform(P.ambientIntensity);

  const uWind = uniform(new THREE.Vector3());
  const uFade = uniform(0);

  const uAerialEnabled = uniform(P.aerialEnabled ? 1 : 0);
  const uAerialColor = uniform(new THREE.Color(0xa8c0d4));
  /** Haze colour on the SUN side of the sky. The atmosphere between us and a far cloud is
   *  much brighter (and warmer) looking sunward than looking away — one direction-less
   *  haze colour makes every sunset cloud converge to the same milky cream regardless of
   *  where it stands. Defaults equal to uAerialColor so callers that never set it keep
   *  the old behaviour. */
  const uAerialColorSun = uniform(new THREE.Color(0xa8c0d4));
  const uAerialDensity = uniform(P.aerialDensity);
  const uAerialAmount = uniform(P.aerialAmount);

  // God rays. uSunUV lives in the same FLIPPED uv space every post pass samples in
  // (ndc*0.5+0.5 with no extra Y flip — the resolve pass proves that mapping). uRayActive
  // folds together "sun in front", "near enough to the frame" and "above the horizon".
  const uSunUV = uniform(new THREE.Vector2(0.5, 0.5));
  const uRayActive = uniform(0);
  const uRayStrength = uniform(P.rayStrength);
  const uRayDecay = uniform(P.rayDecay);
  const uRaySteps = uniform(P.raySteps);
  const uRayLen = uniform(P.rayLength);
  const uRayTight = uniform(P.rayTightness);
  const uAspect = uniform(1);

  /** EFFECTIVE shadow strength — P.shadowStrength times a sun-elevation ramp, so shadows
   *  die with the light instead of stamping moonlit ground at noon strength. */
  const uShadowStrength = uniform(0);
  const uShadowSoft = uniform(P.shadowSoftness);
  /** Camera forward, for reconstructing world positions from view-Z depth. */
  const uCamFwd = uniform(new THREE.Vector3(0, 0, -1));

  const uFrameJitter = uniform(0);
  /** 1 for a normal depth buffer, 0 for a reversed one. Both conventions appear in v3
   *  depending on renderer setup, and every depth comparison here has to agree with it. */
  const uReversed = uniform(0);
  const uUpsampleReject = uniform(P.upsampleDepthReject);

  // Scene colour + depth. ONE render feeds both the composite and the march's occlusion.
  const sceneRT = new THREE.RenderTarget(1, 1, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    type: THREE.HalfFloatType,
  });
  // MATCH THE RENDERER'S MSAA. `antialias: true` only anti-aliases the CANVAS — a render
  // target you create yourself defaults to samples = 0. Without this, turning clouds on
  // reroutes the scene through this target and every geometry edge in the frame silently
  // loses 4x MSAA, which reads as the clouds having "bad edges" when the clouds are not
  // involved at all. Only affects the owns-the-frame path; on the post-FX path the
  // pipeline's own scene pass already carries the renderer's sample count.
  sceneRT.samples = renderer.samples ?? 0;
  sceneRT.depthTexture = new THREE.DepthTexture(1, 1);
  const depthTex = texture(sceneRT.depthTexture);
  const sceneTex = texture(sceneRT.texture);

  const cloudRT = new THREE.RenderTarget(1, 1, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat,
    type: THREE.HalfFloatType,
    depthBuffer: false,
  });
  const cloudRawTex = texture(cloudRT.texture);

  // ── Temporal accumulation buffers ──────────────────────────────────────────────────
  // Two half-res history targets, ping-ponged: a frame reads one and writes the other.
  // Reading and writing one target in the same pass is undefined, so two is the minimum.
  function makeHistoryRT() {
    return new THREE.RenderTarget(1, 1, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.HalfFloatType,
      depthBuffer: false,
    });
  }
  const historyRT = [makeHistoryRT(), makeHistoryRT()];
  let histWrite = 0;
  /** Reads the PREVIOUS frame's accumulation; `.value` is swapped each frame. */
  const histTex = texture(historyRT[1].texture);
  /** What the composite samples — the freshly resolved history. Also swapped each frame. */
  const cloudTex = texture(historyRT[0].texture);

  /**
   * remap(v, lo..hi → 0..1) with a GUARDED denominator.
   *
   * Not `remapClamp` from TSL, deliberately. That divides by `hi - lo` with no floor, and
   * the Nubis coverage step is `remap(base, 1 - coverage, 1)` — so the denominator IS the
   * coverage, and in clear sky it is zero. 0/0 is NaN, NaN survives the clamp, and the
   * result is a black hemisphere wherever the weather map says "no cloud" — i.e. most of
   * the sky. Clamping the divisor is the whole difference.
   */
  const remapUnit = Fn(([v, lo, hi]) => saturate(v.sub(lo).div(hi.sub(lo).max(1e-4))));

  /**
   * Scene camera near/far as our OWN uniforms.
   *
   * NOT TSL's `cameraNear` / `cameraFar`: the composite is a fullscreen quad drawn with an
   * orthographic post camera, so those built-ins resolve to that camera's 0 and 1, not the
   * scene camera's. `perspectiveDepthToViewZ(d, 0, 1)` reduces to `0 / (d - 1)` — which is
   * 0/0 for every pixel at the cleared far-plane depth, i.e. the entire sky. The NaN then
   * poisons the bilateral weights and blacks out the sky while leaving geometry intact.
   */
  const uCamNear = uniform(0.5);
  const uCamFar = uniform(8192);

  /** Raw depth → a value the reversed/normal conventions agree on (0 near, 1 far). */
  const normDepth = Fn(([d]) => mix(d, d.oneMinus(), uReversed));
  /**
   * Depth → view-space distance, for the bilateral upsample weights.
   * The denominator is floored: at the far plane it is otherwise exactly zero.
   */
  const depthDist = Fn(([d]) => {
    const z = normDepth(d);
    return uCamNear.mul(uCamFar)
      .div(uCamFar.sub(uCamNear).mul(z).sub(uCamFar).min(-1e-6))
      .negate();
  });

  // ── Density field ──────────────────────────────────────────────────────────────────

  /**
   * Vertical profile. Two Nubis-style gradients blended by the weather map's type channel:
   * stratus is a low flat band, cumulus climbs most of the slab and erodes at the top.
   * This is what stops the deck reading as one uniform pancake.
   */
  const heightProfile = Fn(([h, type]) => {
    const stratus = smoothstep(0.0, 0.07, h).mul(smoothstep(0.38, 0.16, h));
    // Cumulus HOLDS full value to 0.8 of its own height before eroding. It used to start
    // falling at 0.62, and since the coverage step thresholds `pw * grad`, a gradient that
    // sags early puts the whole upper half of every cloud below the bar — the deck could
    // not build anything tall no matter what the cloud-top field said. Measured with
    // tools/cloudDensityTest.mjs: nothing cleared h = 0.45 before this.
    const cumulus = smoothstep(0.0, 0.18, h).mul(smoothstep(1.0, 0.80, h));
    return mix(stratus, cumulus, saturate(type));
  });

  /** Weather lookup → vec4(coverage, type, densityScale, cloudTopFraction). */
  const sampleWeather = Fn(([p]) => {
    const wuv = p.xz.add(uWind.xz.mul(0.35)).div(WEATHER_TILE_M);
    const w = weatherTex.sample(wuv);
    // Coverage is a THRESHOLD on the weather channel (see CLOUD_DEFAULTS.coverage): the
    // bar sweeps [1+soft .. -soft] as the dial goes 0 → 1, so 0 is honestly clear (even
    // the channel's peaks sit below the bar) and 1 is honestly overcast. Cells above the
    // bar ramp to full coverage over 2·soft — solid interiors, wispy skirts.
    const covRaw = saturate(w.r.add(uCoverageBias));
    const bar = uCoverageSoft.add(1.0).sub(uCoverage.mul(uCoverageSoft.mul(2.0).add(1.0)));
    const cov = smoothstep(bar.sub(uCoverageSoft), bar.add(uCoverageSoft), covRaw);
    const type = saturate(w.g.sub(0.5).add(uTypeBias));
    /*
     * HOW TALL THIS CELL'S CLOUD IS — and the taper the bake alone cannot do.
     *
     * The weather bake already correlates the top field with coverage (see
     * bakeWeatherMap: `0.4*topN + 0.6*covS`), for the right reason — cumulus tower where
     * the mass is fattest, and an independent top field extrudes chimneys off thin
     * mass. But it correlates against the RAW coverage field, and the cloud's actual
     * outline is cut by a THRESHOLD that moves with the coverage dial. So the bake's
     * taper cannot follow the dial: turn coverage down and the outline shrinks inward
     * while the top field stays where it was, leaving small clouds with mid-range
     * heights — mesas at low coverage, which is precisely the tell the painted deck had.
     *
     * The depth signal is `cov` ITSELF — the thresholded coverage, which is already 0 at
     * the outline the threshold cuts and 1 in the core, and already computed. Measured
     * against the alternative (distance past the bar, normalised to 1): that one tapers
     * CORES as hard as skirts, because the coverage channel rarely approaches 1, so it
     * read as a uniform 35% height cut rather than an edge taper. `cov` is the same
     * quantity painted uses for its planMass, and it is free.
     */
    // Floored, or a cell would have no cloud at all rather than a shallow one.
    const top = mix(uCloudTopMin, float(1.0), saturate(w.a.add(uCloudTopBias)))
      .mul(mix(uEdgeTaper, float(1.0), cov));
    return vec4(cov, type, mix(float(0.55), float(1.45), w.b), top);
  });

  /**
   * Full density at a world point. `t` is distance along the view ray and is used ONLY to
   * fade the near-field octave — passing it in avoids a per-sample length() and is exact
   * because the ray direction is normalised.
   *
   * Structure is Nubis: a base Perlin-Worley mass, shaped by coverage and the height
   * profile, then eroded by progressively higher frequencies. Erosion REMAPS rather than
   * multiplies, so the iso-surface itself moves — that is what carves real silhouettes
   * instead of just darkening the existing ones.
   */
  const sampleDensity = Fn(([p, t]) => {
    const h = p.y.sub(uBase).div(uThickness);
    const result = float(0.0).toVar();

    // Outside the slab there is nothing to sample — cheap guard before any texture fetch.
    If(h.greaterThan(0.0).and(h.lessThan(1.0)), () => {
      const wm = sampleWeather(p);
      // LOCAL height: 0 at the cloud base, 1 at THIS cell's own top. Rescaling here is what
      // gives neighbouring clouds different heights instead of one flat sheet — the profile
      // runs its whole shape inside a taller or shorter box per cell, and falls to zero
      // above that box on its own (both curves reach 0 past h = 1).
      const hL = h.div(wm.w.max(0.05));
      const grad = heightProfile(hL, wm.y);

      const b4 = baseTex.sample(p.add(uWind).div(BASE_TILE_M));
      const lowFbm = b4.g.mul(0.625).add(b4.b.mul(0.25)).add(b4.a.mul(0.125));
      const pw = remapUnit(b4.r, lowFbm.sub(1.0), float(1.0));

      // Coverage carves the mass: more coverage lowers the bar the base has to clear.
      const shaped = remapUnit(pw.mul(grad), wm.x.oneMinus(), float(1.0)).toVar();

      // Fade the erosion octaves out with distance — they carry frequencies the far-field
      // step cannot sample (see detailRange). Gate the fetch too: past the range this is
      // a no-op, so it should not cost a texture read either.
      const detailFade = smoothstep(uDetailRange.mul(2.2), uDetailRange.mul(0.45), t);
      If(shaped.greaterThan(0.001).and(detailFade.greaterThan(0.004)), () => {
        // Mid-frequency erosion, height-inverted: wispy at the base, billowy at the top.
        const d4 = detailTex.sample(p.add(uWind.mul(1.8)).div(DETAIL_TILE_M));
        const dF = d4.r.mul(0.625).add(d4.g.mul(0.25)).add(d4.b.mul(0.125));
        const dMod = mix(dF, dF.oneMinus(), saturate(hL.mul(4.0)));
        // Bite harder toward the cloud's OWN top: that rising erosion is what reads as
        // cauliflower billows instead of a slab fading out.
        const erodeH = uErode.mul(mix(float(0.65), float(1.35), saturate(hL))).mul(detailFade);
        shaped.assign(remapUnit(shaped, dMod.mul(erodeH), float(1.0)));

        // NEAR-FIELD OCTAVE — the reason a fly-through reads as cloud and not as fog.
        // Faded by ray distance, so it is a no-op for anything that is not close.
        const nearFade = smoothstep(uNearRange, uNearRange.mul(0.25), t);
        If(nearFade.greaterThan(0.002), () => {
          const n = nearTex.sample(p.add(uWind.mul(2.6)).div(NEAR_TILE_M)).a;
          shaped.assign(remapUnit(shaped, n.mul(uNearErode).mul(nearFade), float(1.0)));
        });
      });

      // CAMERA CLEAR BUBBLE — a deliberate, documented departure from physics.
      //
      // A real cumulus core at this density is optically thick within a few metres: fly
      // into one and you get a total whiteout, which is exactly what a pilot sees and
      // exactly what makes a driving game unplayable — the track, the car and the next
      // jump all disappear. This thins density over the first `clearRadius` metres of the
      // ray so the player keeps a small readable bubble while everything beyond it still
      // reads as solid cloud.
      //
      // Set clearRadius to 0 for the physically honest version.
      const clear = smoothstep(float(0.0), uClearRadius.max(0.001), t);
      result.assign(shaped.mul(uDensityMul).mul(wm.z).mul(mix(uClearFloor, float(1.0), clear)));
    });
    return result;
  });

  /**
   * Cheap density for the light march — base shape only, no erosion fetches. Halves the
   * texture reads in the hottest inner loop. The `1 - 0.5*erode` factor removes the MEAN
   * density full erosion would have taken out, so optical depth toward the sun stays
   * calibrated against the view march instead of reading systematically too dark.
   */
  const sampleDensityCheapW = Fn(([p, wm]) => {
    const h = p.y.sub(uBase).div(uThickness);
    const result = float(0.0).toVar();
    If(h.greaterThan(0.0).and(h.lessThan(1.0)), () => {
      // Must match sampleDensity's local height or self-shadowing fights the shape.
      const grad = heightProfile(h.div(wm.w.max(0.05)), wm.y);
      const b4 = baseTex.sample(p.add(uWind).div(BASE_TILE_M));
      const lowFbm = b4.g.mul(0.625).add(b4.b.mul(0.25)).add(b4.a.mul(0.125));
      const pw = remapUnit(b4.r, lowFbm.sub(1.0), float(1.0));
      const shaped = remapUnit(pw.mul(grad), wm.x.oneMinus(), float(1.0));
      result.assign(shaped.mul(uDensityMul).mul(wm.z).mul(uErode.mul(0.5).oneMinus()));
    });
    return result;
  });

  /** Same, fetching its own weather — for callers that have none in hand. */
  const sampleDensityCheap = Fn(([p]) => sampleDensityCheapW(p, sampleWeather(p)));

  // ── Scattering ─────────────────────────────────────────────────────────────────────

  const HG = Fn(([g, mu]) => {
    const g2 = g.mul(g);
    return float(1.0).sub(g2)
      .div(pow(float(1.0).add(g2).sub(g.mul(mu).mul(2.0)).max(1e-4), 1.5))
      .mul(INV_4PI);
  });
  /** Dual-lobe: a forward lobe for the silver lining plus a back lobe for ambient wrap. */
  const phaseAt = Fn(([mu, g]) =>
    HG(g.negate(), mu).mul(uPhaseW.oneMinus()).add(HG(g, mu).mul(uPhaseW)),
  );

  /**
   * Cone light march. Taps at geometrically growing distance (1,2,4,8,16,32 units of
   * coneLength/32), each pushed off-axis so the sampled region widens with depth — that
   * spread is what turns a hard banded terminator into soft self-shadowing.
   *
   * The first tap is metres from the sample point. That is the part the editor's uniform
   * 148 m step cannot do at all, and it is what makes a cloud you are INSIDE look lit
   * rather than uniformly grey.
   *
   * Offsets are generated from the loop index rather than read from a table: the values
   * only need to be fixed and non-collinear, and a trig pair is cheaper than a uniform
   * array binding.
   */
  const lightMarch = Fn(([p, wm]) => {
    /*
     * ONE WEATHER FETCH FOR THE WHOLE CONE, handed in by the caller.
     *
     * This loop is the hottest thing in the module — it runs on every DENSE step — and
     * each tap was re-reading the 2D weather map. It did not need to: the cone reaches
     * `lightConeLength` (90 m), while the weather map wraps over 6 km with its finest
     * octave around 375 m, so the field is essentially constant across the whole cone.
     * Six fetches were buying a difference too small to see. The 3D base fetch still
     * happens per tap — that IS the shape the shadow is made of, and it varies fast.
     */
    const tau = float(0.0).toVar();
    const unit = uLightConeLength.div(32.0);
    Loop(MAX_LIGHT_STEPS, ({ i }) => {
      If(float(i).greaterThanEqual(uLightSteps), () => Break());
      const fi = float(i);
      const dist = unit.mul(pow(float(2.0), fi));
      const off = vec3(
        sin(fi.mul(12.9898)), cos(fi.mul(7.3313)), sin(fi.mul(4.1234).add(1.7)),
      ).mul(0.32).mul(dist);
      tau.addAssign(sampleDensityCheapW(p.add(uSunDir.mul(dist)).add(off), wm).mul(dist));
    });
    return tau;
  });

  // ── The march ──────────────────────────────────────────────────────────────────────

  const cloudColorNode = Fn(() => {
    const rayDir = normalize(positionWorld.sub(cameraPosition)).toVar();
    const ro = cameraPosition;

    // ── Slab entry / exit ──────────────────────────────────────────────────────────
    // A flat slab, not the editor's concentric planet shell. At this world scale (2 km
    // across) and this cloud altitude the curvature term is invisible, and dropping it
    // removes a length() from every density sample and turns a three-sphere intersection
    // into two plane hits.
    //
    // The reciprocal is made safe without breaking the degenerate cases: a sign-preserving
    // floor on |rd.y| keeps 1/rd.y finite, and the huge (not infinite) values a horizontal
    // ray then produces still resolve correctly through the min/max — inside the slab the
    // two roots straddle zero and give [0, maxDist]; outside, both share a sign and the
    // `tFar > tNear` test rejects the ray.
    const sy = sign(rayDir.y).add(1e-6); // never exactly 0
    const ry = max(abs(rayDir.y), float(1e-5)).mul(sy);
    const invY = float(1.0).div(ry);
    const t1 = uBase.sub(ro.y).mul(invY);
    const t2 = uBase.add(uThickness).sub(ro.y).mul(invY);
    const tNear = min(t1, t2).max(0.0).toVar();
    const tFar = max(t1, t2).min(uMaxDist).toVar();

    // ── Scene-depth occlusion, hoisted out of the loop ─────────────────────────────
    // clip(t) is linear in t, so the t at which the ray's depth crosses the scene depth
    // has a closed form. Clamping tFar once here replaces a projection + compare at every
    // step. Sky pixels hold the cleared far-plane depth, so gate on real geometry or every
    // sky ray gets clipped at the far plane and the deck vanishes.
    // CONSERVATIVE DEPTH. This pixel is half-res, so it covers a 2x2 block of full-res
    // pixels. Sampling depth once at its centre means a texel straddling a silhouette can
    // pick up the FAR (sky) depth and march straight past the object — drawing cloud over
    // the car's edge. Taking the NEAREST depth in the block instead makes the march stop at
    // the closest geometry in its footprint, so the error can only ever be slightly too
    // little cloud just outside an object, which the nearest-depth upsample then recovers.
    // Nearest is min for a normal depth buffer and max for a reversed one.
    const ft = uFullTexel;
    const q0 = depthTex.sample(screenUV.add(vec2(ft.x.mul(-0.5), ft.y.mul(-0.5)))).r;
    const q1 = depthTex.sample(screenUV.add(vec2(ft.x.mul(0.5), ft.y.mul(-0.5)))).r;
    const q2 = depthTex.sample(screenUV.add(vec2(ft.x.mul(-0.5), ft.y.mul(0.5)))).r;
    const q3 = depthTex.sample(screenUV.add(vec2(ft.x.mul(0.5), ft.y.mul(0.5)))).r;
    const rawDepth = mix(
      min(min(q0, q1), min(q2, q3)),
      max(max(q0, q1), max(q2, q3)),
      uReversed,
    ).toVar();
    const skyDepth = uReversed.oneMinus(); // cleared value: 1 normal, 0 reversed
    const hasGeo = abs(rawDepth.sub(skyDepth)).greaterThan(0.0001);
    If(hasGeo, () => {
      const c0 = cameraProjectionMatrix.mul(cameraViewMatrix.mul(vec4(ro, 1.0)));
      const cd = cameraProjectionMatrix.mul(cameraViewMatrix.mul(vec4(rayDir, 0.0)));
      const tHit = rawDepth.mul(c0.w).sub(c0.z).div(cd.z.sub(rawDepth.mul(cd.w)));
      If(tHit.greaterThan(0.0), () => { tFar.assign(min(tFar, tHit)); });
    });

    const valid = tFar.greaterThan(tNear).and(tFar.greaterThan(0.0));

    const mu = dot(rayDir, uSunDir);
    const ecc1 = uPhaseG.mul(uMsEccentricity);
    const ph0 = phaseAt(mu, uPhaseG);
    const ph1 = phaseAt(mu, ecc1);
    const ph2 = phaseAt(mu, ecc1.mul(uMsEccentricity));

    const transmittance = vec3(1.0).toVar();
    const scattered = vec3(0.0).toVar();
    const distAcc = float(0.0).toVar();
    const wAcc = float(0.0).toVar();

    If(valid, () => {
      /*
       * Dither the entry by up to one step so the slab edge does not band. BLUE NOISE,
       * not interleaved gradient noise: IGN is a gradient folded by fract(), and its
       * residual is a lattice of diagonal lines a few pixels apart. That matters MORE
       * here, not less, despite the temporal accumulation — a neighbourhood clamp
       * preserves structured error, so a lattice survives the average as a fixed
       * pattern (which is exactly what the historyClamp notes above describe as
       * "the same stipple in the same places"), while structureless noise converges
       * away. Painted learned this the hard way; see bakeBlueNoise.
       *
       * Animated by the golden ratio rather than by shifting the tile: adding
       * frame·φ to the VALUE keeps each frame's spectrum blue while decorrelating
       * across frames, which is what lets the history actually average it out.
       */
      const bn = blueTex.sample(screenCoordinate.xy.div(float(BLUE_NOISE_SIZE))).level(0.0).r;
      const jit = fract(bn.add(uFrameJitter.mul(0.6180339887)));
      const travel = tNear.toVar();
      /** 1 while the previous sample was empty and advanced at the coarse rate. */
      const wasCoarse = float(0.0).toVar();
      /**
       * Fine steps still owed after a rewind.
       *
       * Without this the rewind is worse than useless: the rewound position is almost
       * always empty (that is why we skipped it), so the empty branch would set
       * `wasCoarse` again and jump forward a full coarse step — straight past the edge the
       * rewind existed to find. Holding the fine rate for the length of the rewound span
       * is what actually makes the edge get sampled.
       */
      const fineHold = float(0.0).toVar();
      // Dither the entry, but only by `jitterMaxM` at most — see jitterMaxM.
      travel.addAssign(jit.mul(
        clamp(uMinStep.add(tNear.mul(uStepGrowth)), uMinStep, uMaxStep).min(uJitterMaxM),
      ));

      Loop(MAX_STEPS, ({ i }) => {
        If(float(i).greaterThanEqual(uSteps), () => Break());
        If(travel.greaterThanEqual(tFar), () => Break());
        If(transmittance.r.lessThan(0.008), () => Break());

        // THE ADAPTIVE STEP: grows with distance from the camera, so the near field is
        // metre-scale and the far field stays bounded.
        const step = clamp(uMinStep.add(travel.mul(uStepGrowth)), uMinStep, uMaxStep).toVar();
        const p = ro.add(rayDir.mul(travel));
        const density = sampleDensity(p, travel).toVar();

        If(density.greaterThan(0.0005), () => {
          // STEP-BACK. We only got here at the coarse rate, so the cloud edge is somewhere
          // in the interval we just jumped. Rewind to the start of that jump and re-enter
          // at the fine rate instead of integrating a thin edge at 3x the step — which is
          // exactly where the silhouette lives, so integrating it coarsely eats it.
          If(wasCoarse.greaterThan(0.5), () => {
            travel.assign(travel.sub(step.mul(uEmptyStepMul.sub(1.0))).max(tNear));
            wasCoarse.assign(0.0);
            // Owe fine steps across the span we just rewound (+1 for margin).
            fineHold.assign(uEmptyStepMul);
          }).Else(() => {
            // One weather read here replaces the six the cone used to do.
            const tauL = lightMarch(p, sampleWeather(p));
            // Powder: thin cloud facing the sun is darker than a naive Beer integral says,
            // because light has not had room to scatter forward into the eye yet.
            // POWDER, gated on sun/view geometry. The dark-edge effect is real only when
          // the sun is BEHIND the viewer: front-lit cloud edges darken. Looking toward
          // the sun the same edges are the BRIGHTEST part of the sky — the silver
          // lining. Applying it unconditionally (as before) greyed out every wisp,
          // which is what made edges look dirty. mu = dot(view, sun), so mu < 0 is
          // front-lit and mu > 0 is backlit.
          const pwStrength = uPowder.mul(saturate(mu.negate()));
          const powder = exp(density.mul(-14.0)).oneMinus()
              .mul(pwStrength).add(pwStrength.oneMinus());
            const h = saturate(p.y.sub(uBase).div(uThickness));

            // Multi-scatter octaves (Wrenninge): each octave is dimmer, extincted less and
            // phase-broadened, standing in for light that took a longer path through the
            // medium. Octave 0 alone is plain single scattering.
            const e0 = exp(tauL.mul(uLightAbsorb).negate());
            const e1 = exp(tauL.mul(uLightAbsorb).mul(uMsExtinction).negate());
            const e2 = exp(tauL.mul(uLightAbsorb).mul(uMsExtinction).mul(uMsExtinction).negate());
            const w1 = uMsContribution.mul(uMsAmount);
            const w2 = uMsContribution.mul(uMsContribution).mul(uMsAmount);
            const sunMS = e0.mul(ph0).add(e1.mul(ph1).mul(w1)).add(e2.mul(ph2).mul(w2));
            const sun = uSunColor.mul(uSunIntensity).mul(sunMS).mul(powder);

            // Ambient is a sky GRADIENT, not a flat fill: tops see the zenith, bases see
            // the horizon and the ground bounce. Cheap, and it is most of what makes an
            // overcast base read as heavy rather than merely grey.
            const amb = mix(uSkyHorizon, uSkyZenith, h).mul(uAmbientIntensity)
              .mul(mix(float(0.35), float(1.0), h));

            // MULTIPLE-SCATTERING FLOOR — what makes the INSIDE of a cloud look like the
            // inside of a cloud.
            //
            // Every term above decays with optical depth to the sun, so deep inside a mass
            // they all vanish and the only light left is a weak blue sky ambient. The
            // result is a flat, dull blue-grey wash: measurably wrong, since a real cloud
            // interior is a bright near-white whiteout. Cloud droplet albedo is ~0.99, so
            // light does not get absorbed in there, it gets diffused — radiance tends to a
            // diffusion solution rather than to zero.
            //
            // `deep` rises from 0 at the sunlit edge to 1 well inside, so this adds a
            // white-ish, sun-coloured floor exactly where the directional terms have died
            // and contributes nothing at the edges, where they are still doing the work.
            const deep = exp(tauL.mul(uMsFloorDepth).negate()).oneMinus();
            const floorTerm = uSunColor.mul(uSunIntensity).mul(uMsFloor).mul(deep);

            const lum = sun.add(amb).add(floorTerm).mul(density).mul(step);
            const stepT = exp(density.mul(step).mul(EXTINCTION).negate());
            scattered.addAssign(transmittance.mul(lum));

            const vis = transmittance.r.mul(stepT.r.oneMinus());
            distAcc.addAssign(vis.mul(travel));
            wAcc.addAssign(vis);
            transmittance.mulAssign(stepT);
            travel.addAssign(step);
          });
        }).Else(() => {
          // Empty space. Only jump at the coarse rate once the post-rewind fine steps are
          // paid off, otherwise the jump would undo the rewind (see fineHold).
          If(fineHold.greaterThan(0.5), () => {
            fineHold.subAssign(1.0);
            travel.addAssign(step);
          }).Else(() => {
            wasCoarse.assign(1.0);
            travel.addAssign(step.mul(uEmptyStepMul));
          });
        });
      });
    });

    const alpha = transmittance.r.oneMinus().mul(uFade);
    scattered.mulAssign(uFade);

    // Aerial perspective: fade the premultiplied colour toward the horizon haze by the
    // transmittance-weighted mean distance, so distant cloud recedes into the same haze
    // the terrain fog uses. Alpha is untouched, so the deck still occludes correctly.
    If(uAerialEnabled.greaterThan(0.5), () => {
      const meanDist = distAcc.div(wAcc.max(1e-4));
      const fog = saturate(
        exp(meanDist.mul(uAerialDensity).negate()).oneMinus().mul(uAerialAmount),
      );
      // Directional haze: a broad forward lobe (not the sharp sun glow — in-scattered
      // haze light is diffuse) blends toward the sun-side colour, so a sunset's far
      // clouds go warm-bright toward the sun and stay cool-dark opposite it, the way a
      // real horizon does. mu = dot(view, sun) from the phase setup above.
      const sunward = pow(saturate(mu.mul(0.5).add(0.5)), 3.0);
      const hazeCol = mix(uAerialColor, uAerialColorSun, sunward);
      scattered.assign(mix(scattered, hazeCol.mul(alpha), fog));
    });

    return vec4(scattered, alpha);
  });

  /*
   * ══════════════════════════════════════════════════════════════════════════════════
   * THE "SOLID" MODEL (`params.model === "solid"`) — a cloud is a SOLID, not a density.
   *
   * Written 2026-09-05 for the skypro lab, after reading how the reference renderer
   * (threejsskypro.com) actually builds its clouds. The chunky, crisp cumulus it shows is
   * not a better noise or a longer march of the Nubis field above; it is a different
   * model of what a cloud IS, and every part of the look follows from that:
   *
   *   • OCCUPANCY, NOT DENSITY. A 2D weather map is the cloud-TOP HEIGHT in shell units
   *     (a wide-range Perlin FBM, not a coverage mask). A 3D Worley-FBM adds a per-point
   *     bump to that top. The cloud occupies every height below `top` and above the
   *     shell base, with a soft edge only `edgeSoft` wide — inside it is 1, outside 0.
   *     Extinction is then one constant (`solidDensity`), so a mass is opaque within
   *     ~100 m and edges are sharp by construction. No coverage threshold sweeping a
   *     soft field, which is where the Nubis model's "airbrushed" fringes come from.
   *   • EROSION CARVES BOTH SURFACES. The same volume read at half scale lowers the top
   *     AND lifts the base by the same amount — cauliflower on top, ragged undersides.
   *   • THE MARCH RESOLVES THE SURFACE. Coarse steps (4x base) test the UNERODED bound;
   *     on a hit the ray steps back one coarse stride and goes fine. Inside cloud the
   *     step is set by a per-step OPTICAL DEPTH cap: with σ = 0.048/m and a cap of 0.5
   *     that is ~10 m, floored at 15% of the base step (22 m), which is why the edge is
   *     crisp; once the ray has accumulated optical depth 1..3 the step opens to 3x base
   *     because nothing behind it is visible anyway. The step also grows with distance
   *     as a cone (`coneAngle` rad/m). Four empty fine steps return the ray to coarse.
   *   • THE LIGHT MARCH IS LONG. Six taps at 1.5x-growing distances reach ~17x the
   *     first segment (6.8 km at 400 m), fanned off-axis by `lightSpread` on a golden-
   *     angle spiral, so one mass shadows the next and the undersides of a whole deck
   *     go blue-grey. The Nubis path's cone stops at a few hundred metres.
   *   • MULTI-OCTAVE SCATTER, Wrenninge-style, with FIXED octave weights: e^-τ·ph0 +
   *     0.5·e^-τ/2·ph1 + 0.25·e^-τ/4·ph2, phases a 50/50 dual-lobe HG at (0.8, -0.2)
   *     with eccentricity halved per octave. Plus powder `1 - e^-2d` and a sky ambient
   *     that mixes zenith/horizon by √h with a ground bounce under the base.
   *   • ENERGY-CONSERVING INTEGRATION (Frostbite): S = (L - L·T_step)/σ per step.
   *
   * Everything downstream (half-res buffer, temporal history, depth-aware upsample, god
   * rays, ground shadows, the published `field`) is shared with the Nubis path. The
   * model is a construction-time switch because the two need different volumes and
   * compile to different shaders; the game never turns it on.
   *
   * This is our own implementation of that model from its description and its numbers.
   * No code was taken from the reference.
   * ══════════════════════════════════════════════════════════════════════════════════
   */
  const SOLID_LIGHT_TAPS = 6;
  const uSDensity = uniform(P.solidDensity);
  const uSCoverage = uniform(P.solidCoverage);
  const uSWeatherBias = uniform(P.solidWeatherBias);
  const uSWeatherScale = uniform(P.solidWeatherScale);
  const uSBaseScale = uniform(P.solidBaseScale);
  const uSErosionMul = uniform(P.solidErosionMul);
  const uSBaseStrength = uniform(P.solidBaseStrength);
  const uSErodeBase = uniform(P.solidErodeBase);
  const uSErodePeak = uniform(P.solidErodePeak);
  const uSEdgeSoft = uniform(P.solidEdgeSoft);
  const uSEdgeFalloff = uniform(P.solidEdgeFalloff);
  const uSStep = uniform(P.solidStep);
  const uSConeAngle = uniform(P.solidConeAngle);
  const uSMaxOD = uniform(P.solidMaxOD);
  const uSLightStep = uniform(P.solidLightStep);
  const uSLightSpread = uniform(P.solidLightSpread);
  const uSFullLightAlpha = uniform(P.solidFullLightAlpha);
  const uSAlbedo = uniform(P.solidAlbedo);
  const uSPhaseFwd = uniform(P.solidPhaseFwd);
  const uSPhaseBack = uniform(P.solidPhaseBack);
  const uSGroundBounce = uniform(P.solidGroundBounce);

  /** Shell height: 0 at the base, 1 at the top. Flat slab (curvature is <20 m at 14 km). */
  const solidH = Fn(([p]) => p.y.sub(uBase).div(uThickness));
  /** Cloud-top height from the weather map, in shell units. */
  const solidTop = Fn(([p]) =>
    solidWeatherTex.sample(p.xz.add(uWind.xz).div(uSWeatherScale)).r.add(uSWeatherBias));
  /** Base-shape bump: the three Worley-FBM channels at falling weights. */
  const solidBaseK = Fn(([p]) => {
    const q = solidBaseTex.sample(p.add(uWind).div(uSBaseScale));
    return q.r.mul(0.7).add(q.g.mul(0.41)).add(q.b.mul(0.23)).mul(uSBaseStrength);
  });
  /** Soft-edge half width at this height (in shell units), shrinking with altitude. */
  const solidSoft = Fn(([h]) => {
    const km = max(h, 0.0).mul(uThickness).mul(0.001);
    return uSEdgeSoft.div(pow(uSEdgeFalloff.max(0.001), km)).max(1e-4);
  });
  /** The top surface a weather height and a bump make, after the coverage shift. */
  const solidTopOf = Fn(([wr, k]) => wr.add(uSCoverage.sub(1.0)).add(k.mul(uSCoverage)));
  /** Occupancy: below `top`, above `lift`, both with the soft edge. */
  const solidOcc = Fn(([h, top, lift]) => {
    const ie = solidSoft(h);
    return smoothstep(ie.negate(), ie, top.sub(h)).mul(smoothstep(ie.negate(), ie, h.sub(lift)));
  });
  /** UNERODED occupancy — a conservative bound, used by the coarse search and the cheap
   *  light march. One 2D + one 3D fetch. */
  const solidConservative = Fn(([p]) => {
    const h = solidH(p);
    const out = float(0.0).toVar();
    If(h.greaterThan(-0.5).and(h.lessThan(1.5)), () => {
      out.assign(solidOcc(h, solidTopOf(solidTop(p), solidBaseK(p)), float(0.0)));
    });
    return out;
  });
  /** Eroded occupancy — what is drawn. One extra 3D fetch. */
  const solidFull = Fn(([p]) => {
    const h = solidH(p);
    const out = float(0.0).toVar();
    If(h.greaterThan(-0.5).and(h.lessThan(1.5)), () => {
      const wr = solidTop(p);
      const k = solidBaseK(p);
      const top0 = solidTopOf(wr, k);
      // Where inside the mass we are, for blending the base/peak erosion strengths.
      const z = saturate(h.div(top0.max(0.001)));
      const e = solidBaseTex.sample(p.add(uWind).div(uSBaseScale.mul(uSErosionMul))).oneMinus();
      const eMag = e.r.mul(0.113).add(e.g.mul(0.04)).add(e.b.mul(0.02))
        .mul(mix(uSErodeBase, uSErodePeak, z));
      out.assign(solidOcc(h, solidTopOf(wr, k.sub(eMag)), eMag.mul(uSCoverage)));
    });
    return out;
  });
  /** Published field for the shadow map / env probe: occupancy in extinction per metre. */
  const solidFieldDensity = Fn(([p]) => solidConservative(p).mul(uSDensity));
  const solidFieldDensityW = Fn(([p, wm]) => solidConservative(p).mul(uSDensity).add(wm.x.mul(0.0)));

  /** Optical depth toward the sun: the origin's own segment plus five spiral cone taps. */
  const solidLightTau = Fn(([p, d0, cheap]) => {
    const sd = uSunDir;
    const seed = select(abs(sd.y).greaterThan(0.99), vec3(1.0, 0.0, 0.0), vec3(0.0, 1.0, 0.0));
    const tan = normalize(cross(seed, sd));
    const bit = cross(sd, tan);
    const tau = d0.mul(uSLightStep).toVar();
    for (let r = 1; r < SOLID_LIGHT_TAPS; r++) {
      const o = Math.pow(1.5, r);
      const c = (o - 1) / 0.5 + o * 0.5; // start of this segment + half its length
      const ang = r * 2.399963;          // golden angle
      const rad = Math.sqrt((r + 0.5) / SOLID_LIGHT_TAPS);
      const dist = uSLightStep.mul(c);
      const off = sd.mul(dist).add(
        tan.mul(Math.cos(ang) * rad).add(bit.mul(Math.sin(ang) * rad)).mul(uSLightSpread).mul(dist),
      );
      const q = p.add(off);
      const dq = float(0.0).toVar();
      If(cheap.greaterThan(0.5), () => { dq.assign(solidConservative(q)); })
        .Else(() => { dq.assign(solidFull(q)); });
      tau.addAssign(dq.mul(uSLightStep.mul(o)));
    }
    return tau.mul(uSDensity);
  });
  /** 50/50 dual-lobe HG at (fwd, -back), eccentricities scaled by `k` per octave. */
  const solidPhase = Fn(([mu, k]) =>
    HG(uSPhaseFwd.mul(k), mu).mul(0.5).add(HG(uSPhaseBack.negate().mul(k), mu).mul(0.5)));
  /** Sky ambient by height plus a ground bounce under the base. */
  const solidAmbient = Fn(([h]) => {
    const r = mix(uSkyZenith, uSkyHorizon, 0.35);
    const o = mix(r, uSkyZenith, sqrt(saturate(h)));
    // Ground radiance = albedo x sun irradiance / pi (sunIntensity is an irradiance in this
    // model: it lands around 10 for the sun-to-sky ratio of a clear day).
    const ground = uSunColor.mul(uSunIntensity).mul(saturate(uSunDir.y)).mul(uSGroundBounce)
      .mul(1.0 / Math.PI).mul(saturate(h.oneMinus()));
    return o.add(ground).mul(uAmbientIntensity);
  });

  const solidColorNode = Fn(() => {
    const rayDir = normalize(positionWorld.sub(cameraPosition)).toVar();
    const ro = cameraPosition;

    // Slab entry / exit and the conservative scene-depth clamp: same as the Nubis path.
    const sy = sign(rayDir.y).add(1e-6);
    const ry = max(abs(rayDir.y), float(1e-5)).mul(sy);
    const invY = float(1.0).div(ry);
    const t1 = uBase.sub(ro.y).mul(invY);
    const t2 = uBase.add(uThickness).sub(ro.y).mul(invY);
    const tNear = min(t1, t2).max(0.0).toVar();
    const tFar = max(t1, t2).min(uMaxDist).toVar();
    const ft = uFullTexel;
    const q0 = depthTex.sample(screenUV.add(vec2(ft.x.mul(-0.5), ft.y.mul(-0.5)))).r;
    const q1 = depthTex.sample(screenUV.add(vec2(ft.x.mul(0.5), ft.y.mul(-0.5)))).r;
    const q2 = depthTex.sample(screenUV.add(vec2(ft.x.mul(-0.5), ft.y.mul(0.5)))).r;
    const q3 = depthTex.sample(screenUV.add(vec2(ft.x.mul(0.5), ft.y.mul(0.5)))).r;
    const rawDepth = mix(
      min(min(q0, q1), min(q2, q3)), max(max(q0, q1), max(q2, q3)), uReversed,
    ).toVar();
    const skyDepth = uReversed.oneMinus();
    const hasGeo = abs(rawDepth.sub(skyDepth)).greaterThan(0.0001);
    If(hasGeo, () => {
      const c0 = cameraProjectionMatrix.mul(cameraViewMatrix.mul(vec4(ro, 1.0)));
      const cd = cameraProjectionMatrix.mul(cameraViewMatrix.mul(vec4(rayDir, 0.0)));
      const tHit = rawDepth.mul(c0.w).sub(c0.z).div(cd.z.sub(rawDepth.mul(cd.w)));
      If(tHit.greaterThan(0.0), () => { tFar.assign(min(tFar, tHit)); });
    });
    const valid = tFar.greaterThan(tNear).and(tFar.greaterThan(0.0));

    const mu = dot(rayDir, uSunDir);
    const ph0 = solidPhase(mu, float(1.0));
    const ph1 = solidPhase(mu, float(0.5));
    const ph2 = solidPhase(mu, float(0.25));

    const transmittance = vec3(1.0).toVar();
    const scattered = vec3(0.0).toVar();
    const distAcc = float(0.0).toVar();
    const wAcc = float(0.0).toVar();

    If(valid, () => {
      const bn = blueTex.sample(screenCoordinate.xy.div(float(BLUE_NOISE_SIZE))).level(0.0).r;
      const jit = fract(bn.add(uFrameJitter.mul(0.6180339887)));
      const fineAt = (tt) => max(uSStep, uSConeAngle.mul(tt));
      const t = tNear.add(jit.mul(fineAt(tNear))).toVar();
      const stepSize = uSStep.mul(4.0).toVar();
      const coarse = float(1.0).toVar();
      const emptyRun = float(0.0).toVar();
      const odAcc = float(0.0).toVar();

      Loop(MAX_STEPS, ({ i }) => {
        If(float(i).greaterThanEqual(uSteps), () => Break());
        If(t.greaterThan(tFar), () => Break());
        If(transmittance.r.lessThan(0.001), () => {
          transmittance.assign(vec3(0.0));
          Break();
        });
        const eff = fineAt(t).toVar();
        const large = eff.mul(4.0);
        const p = ro.add(rayDir.mul(t)).toVar();

        If(coarse.greaterThan(0.5), () => {
          // Coarse: test the uneroded bound first, the eroded shape only if it passes.
          const hit = float(0.0).toVar();
          If(solidConservative(p).greaterThan(0.0), () => { hit.assign(solidFull(p)); });
          If(hit.greaterThan(0.0), () => {
            // Step back one coarse stride so the surface is entered at the fine rate.
            t.assign(t.sub(large).max(tNear));
            coarse.assign(0.0);
            emptyRun.assign(0.0);
            stepSize.assign(eff);
          }).Else(() => {
            stepSize.assign(large);
          });
        }).Else(() => {
          const d = solidFull(p).toVar();
          If(d.greaterThan(0.0), () => {
            emptyRun.assign(0.0);
            const sigma = d.mul(uSDensity);
            // Optical-depth-capped step, opening up once the ray is deep inside.
            const zStep = clamp(uSMaxOD.div(sigma.max(1e-6)), eff.mul(0.15), eff);
            const deep = smoothstep(1.0, 3.0, odAcc);
            const step = mix(zStep, eff.mul(3.0), deep).toVar();
            stepSize.assign(step);

            const scat = sigma.mul(uSAlbedo);
            const powder = mix(float(1.0), exp(d.mul(-2.0)).oneMinus(), uPowder);
            const cheap = select(
              transmittance.r.oneMinus().greaterThanEqual(uSFullLightAlpha), float(1.0), float(0.0),
            );
            const tau = solidLightTau(p, d, cheap);
            const e = exp(tau.mul(-0.25));
            const e2 = e.mul(e);
            const e4 = e2.mul(e2);
            const ms = e4.mul(ph0).add(e2.mul(0.5).mul(ph1)).add(e.mul(0.25).mul(ph2));
            const sun = uSunColor.mul(uSunIntensity).mul(ms).mul(powder);
            const lum = sun.add(solidAmbient(solidH(p))).mul(scat);

            const stepT = exp(sigma.mul(step).negate());
            const S = lum.sub(lum.mul(stepT)).div(sigma.max(1e-7));
            scattered.addAssign(transmittance.mul(S));
            const vis = transmittance.r.mul(stepT.oneMinus());
            distAcc.addAssign(vis.mul(t));
            wAcc.addAssign(vis);
            transmittance.mulAssign(stepT);
            odAcc.addAssign(sigma.mul(step));
          }).Else(() => {
            emptyRun.addAssign(1.0);
            stepSize.assign(eff);
            If(emptyRun.greaterThanEqual(4.0), () => {
              coarse.assign(1.0);
              stepSize.assign(large);
            });
          });
        });
        t.addAssign(stepSize);
      });
    });

    const alpha = transmittance.r.oneMinus().mul(uFade);
    scattered.mulAssign(uFade);
    If(uAerialEnabled.greaterThan(0.5), () => {
      const meanDist = distAcc.div(wAcc.max(1e-4));
      const fog = saturate(
        exp(meanDist.mul(uAerialDensity).negate()).oneMinus().mul(uAerialAmount),
      );
      const sunward = pow(saturate(mu.mul(0.5).add(0.5)), 3.0);
      const hazeCol = mix(uAerialColor, uAerialColorSun, sunward);
      scattered.assign(mix(scattered, hazeCol.mul(alpha), fog));
    });
    return vec4(scattered, alpha);
  });

  const material = new THREE.MeshBasicNodeMaterial();
  material.colorNode = solidOn ? solidColorNode() : cloudColorNode();
  material.side = THREE.BackSide;
  material.transparent = true;
  material.premultipliedAlpha = true; // `scattered` is already transmittance-weighted
  material.depthWrite = false;
  material.depthTest = false; // rendered alone into its own buffer
  material.fog = false;
  material.toneMapped = false; // composited in linear; the canvas pass tone-maps once

  // A dome that follows the camera. It is only a fragment trigger — the real cloud extent
  // is the analytic slab intersection, so the radius is cosmetic. It just has to sit
  // inside the camera far plane, or it is clipped and nothing rasterises at all.
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(3000, 24, 12), material);
  mesh.frustumCulled = false;
  mesh.name = "ModularRoadClouds";
  mesh.layers.set(CLOUD_LAYER);

  // ── Composite ──────────────────────────────────────────────────────────────────────

  const postScene = new THREE.Scene();
  const postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const postQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
  postScene.add(postQuad);
  const uCloudTexel = uniform(new THREE.Vector2());
  /** Cloud buffer resolution in pixels — for snapping to exact texel centres. */
  const uCloudRes = uniform(new THREE.Vector2(1, 1));
  /** Full-res texel size in UV, for the march's conservative 2x2 depth fetch. */
  const uFullTexel = uniform(new THREE.Vector2());

  // ── Temporal resolve ───────────────────────────────────────────────────────────────
  const uPrevViewProj = uniform(new THREE.Matrix4());
  const uInvViewProj = uniform(new THREE.Matrix4());
  const uCamPos = uniform(new THREE.Vector3());
  /** 0 on the first frame / after a resize, so history is not read from garbage. */
  const uHasHistory = uniform(0);
  const uHistoryBlend = uniform(P.historyBlend);
  const uHistoryClamp = uniform(P.historyClampStrength);
  const _prevCamPos = new THREE.Vector3();
  const _prevCamQuat = new THREE.Quaternion();
  const _camFwd = new THREE.Vector3();
  let _camMotionInit = false;

  /**
   * Reproject last frame's cloud buffer and blend it with this frame's march.
   *
   * This is what makes the half-res march look clean. Each frame jitters its sample
   * positions differently (see uFrameJitter), so a running average over several frames
   * converges on the answer a much more expensive march would give — the dither stops
   * being noise and becomes extra samples. It is also the headroom that pays for the
   * near-field octave.
   *
   * Reprojection anchor: clouds have no single depth per pixel, so there is no depth
   * buffer to reproject against. We intersect each ray with the slab's MID-PLANE and
   * reproject that world point. Most visible cloud mass sits near that plane, so the
   * approximation is good where it matters; when the ray misses the plane (inside or above
   * the deck looking away) we fall back to a far point along the ray, which is
   * direction-only reprojection and correct for rotation.
   *
   * Ghosting is handled by neighbourhood clamping — the standard TAA fix. History is
   * clamped into the min/max box of this frame's neighbouring samples, so anything that
   * changed sharply (a cloud edge sweeping past, wind advection, a fast camera) snaps to
   * the new value instead of smearing.
   */
  const resolveColor = Fn(() => {
    const suv = vec2(uv().x, uv().y.oneMinus());
    const o = uCloudTexel;
    const cur = cloudRawTex.sample(suv).toVar();

    // Neighbourhood box of the current frame, used to clamp history.
    const mn = cur.toVar();
    const mx = cur.toVar();
    for (const d of [vec2(o.x, 0), vec2(o.x.negate(), 0), vec2(0, o.y), vec2(0, o.y.negate())]) {
      const s = cloudRawTex.sample(suv.add(d));
      mn.assign(min(mn, s));
      mx.assign(max(mx, s));
    }

    const out = cur.toVar();
    If(uHasHistory.greaterThan(0.5), () => {
      // Rebuild this pixel's world ray from the current inverse view-projection.
      const ndc = vec4(suv.x.mul(2.0).sub(1.0), suv.y.mul(2.0).sub(1.0), 0.5, 1.0);
      const wp = uInvViewProj.mul(ndc);
      const dir = normalize(wp.xyz.div(wp.w).sub(uCamPos));

      const midY = uBase.add(uThickness.mul(0.5));
      const denom = dir.y;
      const tMid = midY.sub(uCamPos.y).div(
        abs(denom).max(1e-4).mul(sign(denom).add(1e-6)),
      );
      // Behind us or absurdly far => no usable anchor; use a fixed far point (rotation-only).
      const t = tMid.greaterThan(1.0).and(tMid.lessThan(uMaxDist))
        .select(tMid, float(2000.0));
      const world = uCamPos.add(dir.mul(t));

      const pc = uPrevViewProj.mul(vec4(world, 1.0));
      const puv = pc.xy.div(pc.w.abs().max(1e-5)).mul(0.5).add(0.5);
      const inBounds = pc.w.greaterThan(0.0)
        .and(puv.x.greaterThan(0.0)).and(puv.x.lessThan(1.0))
        .and(puv.y.greaterThan(0.0)).and(puv.y.lessThan(1.0));

      If(inBounds, () => {
        /*
         * CATMULL-ROM HISTORY FETCH — the anti-mush.
         *
         * The accumulation loop re-samples its own output every frame, and under motion
         * the reprojected uv almost never lands on a texel centre — so a BILINEAR fetch
         * convolves the history with a small tent filter every single frame. Ten frames
         * of that IS a Gaussian blur; it is why big nearby clouds read soft even though
         * the march resolves them fine. Catmull-Rom's negative lobes undo the tent
         * spreading instead of compounding it (the standard TAA fix — Karis, SIGGRAPH
         * 2014). 5 bilinear taps instead of 1, in a half-res pass that runs once — cost
         * is noise-level. The corner taps are dropped (weights ~1%) and the result is
         * renormalised; any ringing overshoot is caught by the neighbourhood clamp
         * right below, which this pass already had.
         */
        const samplePos = puv.mul(uCloudRes);
        const texPos1 = floor(samplePos.sub(0.5)).add(0.5);
        const f = samplePos.sub(texPos1);
        const w0 = f.mul(f.mul(f.mul(-0.5).add(1.0)).add(-0.5));
        const w1 = f.mul(f).mul(f.mul(1.5).sub(2.5)).add(1.0);
        const w2 = f.mul(f.mul(f.mul(-1.5).add(2.0)).add(0.5));
        const w3 = f.mul(f).mul(f.mul(0.5).sub(0.5));
        const w12 = w1.add(w2);
        const off12 = w2.div(w12);
        const uv0 = texPos1.sub(1.0).mul(uCloudTexel);
        const uv3 = texPos1.add(2.0).mul(uCloudTexel);
        const uv12 = texPos1.add(off12).mul(uCloudTexel);
        const raw = histTex.sample(vec2(uv12.x, uv0.y)).mul(w12.x.mul(w0.y))
          .add(histTex.sample(vec2(uv0.x, uv12.y)).mul(w0.x.mul(w12.y)))
          .add(histTex.sample(uv12).mul(w12.x.mul(w12.y)))
          .add(histTex.sample(vec2(uv3.x, uv12.y)).mul(w3.x.mul(w12.y)))
          .add(histTex.sample(vec2(uv12.x, uv3.y)).mul(w12.x.mul(w3.y)))
          .div(
            w12.x.mul(w0.y).add(w0.x.mul(w12.y)).add(w12.x.mul(w12.y))
              .add(w3.x.mul(w12.y)).add(w12.x.mul(w3.y)),
          )
          .max(0.0);
        // Widen the box by uHistoryClamp: at 1 it is the exact neighbourhood min/max, at
        // 0 the bounds run away and history passes untouched.
        const slack = mx.sub(mn).mul(uHistoryClamp.reciprocal().sub(1.0).max(0.0));
        const hist = raw.clamp(mn.sub(slack), mx.add(slack));
        out.assign(mix(cur, hist, uHistoryBlend));
      });
    });
    return out;
  });

  const resolveMat = new THREE.MeshBasicNodeMaterial();
  resolveMat.colorNode = resolveColor();
  resolveMat.depthTest = false;
  resolveMat.depthWrite = false;
  resolveMat.fog = false;
  resolveMat.toneMapped = false;
  resolveMat.transparent = false;
  resolveMat.blending = THREE.NoBlending; // write the resolved value verbatim

  /**
   * NEAREST-DEPTH UPSAMPLE of the half-res cloud buffer.
   *
   * Replaces a 5-tap bilateral blur that had a real flaw: the centre tap carried a FIXED
   * 0.5 weight with no depth test, so at a silhouette half the result always came from a
   * texel that might be on the wrong side of the edge — and no amount of
   * `upsampleDepthReject` could touch it, because the reject only weighted the other half.
   * That is what made every object meeting a cloud (the car, guardrails, kerbs) come out
   * with a ragged, notched outline.
   *
   * (The blur was added to soften raymarch grain BEFORE temporal accumulation existed. Once
   * temporal landed, the grain was gone and the blur was pure downside — a workaround that
   * outlived the problem it solved.)
   *
   * How this works: find the four half-res texels around this pixel, snap to their exact
   * centres, and compare the scene depth AT each centre with this pixel's depth. Where the
   * depths agree there is no silhouette, so plain bilinear is used and the result stays
   * smooth. Where they disagree, the single best-matching texel is taken whole — no
   * blending across the edge, so the silhouette stays crisp.
   *
   * Cost: 4 depth + 5 cloud fetches, versus the old 5 + 5. Slightly CHEAPER, and it is the
   * actual fix — raising `bufferScale` only hides the symptom at 4x the march cost.
   */
  const upsampleCloud = Fn(([fuv]) => {
    const dC = depthDist(depthTex.sample(fuv).r).toVar();

    // Texel-space position of this pixel, then the base corner of the surrounding 2x2.
    const base = floor(fuv.mul(uCloudRes).sub(0.5));
    const bestUv = fuv.toVar();
    const bestDiff = float(1e9).toVar();
    const spread = float(0.0).toVar();

    for (const o of [vec2(0, 0), vec2(1, 0), vec2(0, 1), vec2(1, 1)]) {
      // Exact texel centre: bilinear sampling here returns that texel verbatim.
      const cuv = base.add(o).add(0.5).div(uCloudRes);
      // Relative depth difference — scale-free, so one threshold works near and far.
      const diff = abs(depthDist(depthTex.sample(cuv).r).sub(dC)).div(dC.max(1.0));
      spread.assign(max(spread, diff));
      If(diff.lessThan(bestDiff), () => {
        bestDiff.assign(diff);
        bestUv.assign(cuv);
      });
    }

    // No depth discontinuity in the footprint -> keep bilinear (smooth, no 2x2 blockiness).
    // A discontinuity -> take the best-matching texel whole (crisp silhouette).
    return mix(
      cloudTex.sample(fuv),
      cloudTex.sample(bestUv),
      saturate(spread.mul(uUpsampleReject)),
    );
  });

  /**
   * CLOUD SHADOWS ON THE GROUND — the deck darkening the world under it, which is most
   * of what makes a broken deck read as physically present while driving.
   *
   * Same construction as the editor deck's composite shadows: reconstruct this pixel's
   * world position from scene depth, walk it up the sun ray to the slab's mid-plane, and
   * read the CHEAP density there (weather + base shape, no erosion octaves — soft-edged
   * dapples are what real cloud shadows look like anyway, and this runs at FULL res).
   * The wind offset is inside sampleDensityCheap, so the shadows drift with the deck.
   *
   * Applied by ADJUSTING THE CLOUD'S ALPHA rather than by touching the scene colour:
   * with the premultiplied-over blend, dst' = rgb + dst·(1−a), so writing
   * a' = 1 − (1−a)·s multiplies the geometry behind by s for free — which is what lets
   * the SAME code shade both the owns-the-frame path and the post-FX path, where the
   * composite never owns the scene colour at all.
   *
   * Gated to real geometry (sky pixels keep their depth-clear value), to points below
   * the slab top, and faded out with distance so far terrain does not sparkle.
   */
  const shadowFactor = Fn(([fuv]) => {
    const s = float(1.0).toVar();
    If(uShadowStrength.greaterThan(0.001), () => {
      const d = depthTex.sample(fuv).r;
      const skyDepth = uReversed.oneMinus();
      If(abs(d.sub(skyDepth)).greaterThan(0.0001), () => {
        // World position: view ray through this pixel scaled to the depth's view-Z.
        const ndc = vec4(fuv.x.mul(2.0).sub(1.0), fuv.y.mul(2.0).sub(1.0), 0.5, 1.0);
        const wpH = uInvViewProj.mul(ndc);
        const dir = normalize(wpH.xyz.div(wpH.w).sub(uCamPos));
        const dist = depthDist(d).div(dot(dir, uCamFwd).max(1e-3));
        const wp = uCamPos.add(dir.mul(dist));

        const midY = uBase.add(uThickness.mul(0.5));
        const sunY = max(uSunDir.y, float(0.05));
        const sp = wp.add(uSunDir.mul(midY.sub(wp.y).div(sunY)));
        const cov = smoothstep(float(0.0), uShadowSoft, sampleDensityCheap(sp));

        const belowMask = smoothstep(uBase.add(uThickness), uBase.add(uThickness.mul(0.6)), wp.y);
        const nearMask = smoothstep(uMaxDist, uMaxDist.mul(0.55), dist);
        s.assign(float(1.0).sub(cov.mul(uShadowStrength).mul(belowMask).mul(nearMask)));
      });
    });
    return s;
  });

  /**
   * Depth-aware upsample. A flat blur of a half-res cloud buffer is fine for a ceiling
   * 2 km away, and produces a visible bright fringe around every near object once the deck
   * sits at gameplay altitude — the classic half-res halo, which would frame the car and
   * every guardrail. Here each neighbour tap is weighted by how well the scene depth there
   * matches the centre pixel, so cloud from behind the car cannot bleed onto the car.
   *
   * Depth is compared in view-space metres (via `depthDist`) rather than as raw buffer
   * values, so one reject scale behaves the same across the whole depth range instead of
   * being swamped by the non-linearity near the far plane.
   */
  const compositeColor = Fn(() => {
    // Render-target sampling is Y-flipped versus the canvas under WebGPU.
    const fuv = vec2(uv().x, uv().y.oneMinus());
    const cloud = upsampleCloud(fuv);
    // Ground shadow first, cloud over the (darkened) scene second, shafts on top.
    const sceneCol = sceneTex.sample(fuv).rgb.mul(shadowFactor(fuv));
    const shafts = sampleShafts(fuv).mul(uRayActive);
    return vec4(sceneCol.mul(cloud.a.oneMinus()).add(cloud.rgb).add(shafts), 1.0); // premultiplied over
  });

  const compositeMat = new THREE.MeshBasicNodeMaterial();
  compositeMat.colorNode = compositeColor();
  compositeMat.depthTest = false;
  compositeMat.depthWrite = false;
  compositeMat.fog = false;
  postQuad.material = compositeMat;

  /**
   * Post-FX variant of the composite: emits the upsampled cloud PREMULTIPLIED and lets the
   * blender lay it over whatever the solids pass already wrote, instead of sampling a scene
   * colour we do not own. Same bilateral weights, so the anti-halo behaviour is identical.
   */
  const linearCompositeColor = Fn(() => {
    const fuv = vec2(uv().x, uv().y.oneMinus());
    const cloud = upsampleCloud(fuv);
    // Fold the ground shadow into alpha: dst' = rgb + dst·(1−a'), and
    // a' = 1 − (1−a)·s multiplies the scene behind by s — see shadowFactor.
    const s = shadowFactor(fuv);
    // Shafts ride src.rgb: with the premultiplied-over blend they ADD light without
    // occluding anything behind them, which is exactly what scattered light does.
    const shafts = sampleShafts(fuv).mul(uRayActive);
    return vec4(cloud.rgb.add(shafts), cloud.a.oneMinus().mul(s).oneMinus());
  });

  const linearCompositeMat = new THREE.MeshBasicNodeMaterial();
  linearCompositeMat.colorNode = linearCompositeColor();
  linearCompositeMat.depthTest = false;
  linearCompositeMat.depthWrite = false;
  linearCompositeMat.fog = false;
  linearCompositeMat.toneMapped = false; // stays linear; the display chain tone-maps
  linearCompositeMat.transparent = true;
  // Premultiplied over: dst = src.rgb + dst * (1 - src.a).
  linearCompositeMat.blending = THREE.CustomBlending;
  linearCompositeMat.blendSrc = THREE.OneFactor;
  linearCompositeMat.blendDst = THREE.OneMinusSrcAlphaFactor;
  linearCompositeMat.blendSrcAlpha = THREE.OneFactor;
  linearCompositeMat.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;

  // ── God rays ───────────────────────────────────────────────────────────────────────
  //
  // Screen-space radial shafts (GPU Gems 3 "light scattering" construction): each pixel
  // marches toward the sun's screen position accumulating a source term with per-tap
  // decay. The source is computed on the fly — no extra mask pass:
  //
  //     sky visible (scene depth = clear value)
  //   × cloud transmittance (1 − resolved cloud alpha — shafts stream through the GAPS
  //     the deck actually has, and the temporal accumulation keeps them stable)
  //   × a gaussian glow around the sun (the analytic stand-in for the sun's brightness,
  //     since the post-FX path never owns a scene colour buffer to read it from)
  //
  // Quarter res: shafts are inherently low-frequency, and the bilinear upscale at
  // composite time is exactly the blur they want anyway.
  const shaftRT = new THREE.RenderTarget(1, 1, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat,
    type: THREE.HalfFloatType,
    depthBuffer: false,
  });
  const shaftTex = texture(shaftRT.texture);
  const uShaftTexel = uniform(new THREE.Vector2(1, 1));

  /**
   * Shaft fetch for the composites: a 4-tap diagonal tent over the quarter-res buffer.
   *
   * The march start is dithered per pixel (see shaftColorNode) to stop the taps slicing
   * the glow into concentric rings — but with no temporal accumulation on this buffer the
   * dither itself prints as a stationary woven pattern on broad gradients (user-reported).
   * Rings and pattern are both spatial noise around the same mean, so a small blur is the
   * correct resolve for both: shafts are inherently low-frequency, the tent costs 3 extra
   * bilinear fetches, and after it the dither is exactly what it was meant to be — extra
   * samples, not texture.
   */
  const sampleShafts = Fn(([fuv]) => {
    const o = uShaftTexel;
    return shaftTex.sample(fuv.add(vec2(o.x, o.y)))
      .add(shaftTex.sample(fuv.add(vec2(o.x.negate(), o.y))))
      .add(shaftTex.sample(fuv.add(vec2(o.x, o.y.negate()))))
      .add(shaftTex.sample(fuv.add(vec2(o.x.negate(), o.y.negate()))))
      .mul(0.25).rgb;
  });

  const shaftColorNode = Fn(() => {
    const fuv = vec2(uv().x, uv().y.oneMinus());
    const acc = float(0.0).toVar();
    const decay = float(1.0).toVar();
    const delta = uSunUV.sub(fuv);
    const dist = length(delta).max(1e-4);
    // March at most rayLength of the screen, ending at the sun if it is closer.
    const stepUv = delta.mul(min(float(1.0), uRayLen.div(dist))).div(uRaySteps.max(1.0));
    // TWO SAMPLES PER TAP, HALF-TAP DITHER. Discrete taps slice the glow into concentric
    // rings around the sun — the view march's shell banding in polar coordinates. A
    // full-tap dither killed the rings but printed as a stationary weave (this buffer has
    // no temporal accumulation to average it, and the tent filter at composite time
    // could not fully hide a full tap of noise on mid-tone cloud faces — user caught it
    // twice). Sampling the source at two half-tap points per step doubles the effective
    // tap count, which halves both the ring pitch and the dither amplitude needed to
    // decohere it; the residual half-tap noise is what the composite tent CAN erase.
    const halfStep = stepUv.mul(0.5);
    // BLUE noise, and NOT animated. The weave this comment describes is IGN's own
    // diagonal lattice; a structureless residual is what the composite tent can actually
    // erase. Static because this buffer has no temporal accumulation to average an
    // animated pattern — offsetting it per frame would only turn the weave into shimmer.
    const jit = blueTex.sample(screenCoordinate.xy.div(float(BLUE_NOISE_SIZE))).level(0.0).r;
    const p = fuv.add(halfStep.mul(jit)).toVar();
    const skyDepth = uReversed.oneMinus();
    const shaftSrc = Fn(([q]) => {
      const s = float(0.0).toVar();
      const inb = q.x.greaterThan(0.0).and(q.x.lessThan(1.0))
        .and(q.y.greaterThan(0.0)).and(q.y.lessThan(1.0));
      If(inb, () => {
        const isSky = abs(depthTex.sample(q).r.sub(skyDepth)).lessThan(0.0001);
        If(isSky, () => {
          const off = q.sub(uSunUV).mul(vec2(uAspect, 1.0));
          const glow = exp(dot(off, off).mul(uRayTight.negate()));
          s.assign(glow.mul(cloudTex.sample(q).a.oneMinus()));
        });
      });
      return s;
    });
    Loop(MAX_RAY_STEPS, ({ i }) => {
      If(float(i).greaterThanEqual(uRaySteps), () => Break());
      p.addAssign(halfStep);
      const s0 = shaftSrc(p);
      p.addAssign(halfStep);
      const s1 = shaftSrc(p);
      acc.addAssign(s0.add(s1).mul(0.5).mul(decay));
      decay.mulAssign(uRayDecay);
    });
    const amount = acc.div(uRaySteps.max(1.0)).mul(uRayStrength).mul(uRayActive).mul(uFade);
    return vec4(uSunColor.mul(uSunIntensity).mul(amount), 1.0);
  });

  const shaftMat = new THREE.MeshBasicNodeMaterial();
  shaftMat.colorNode = shaftColorNode();
  shaftMat.depthTest = false;
  shaftMat.depthWrite = false;
  shaftMat.fog = false;
  shaftMat.toneMapped = false;
  shaftMat.transparent = false;
  shaftMat.blending = THREE.NoBlending;

  /**
   * Sun screen position + shaft activation, from the CURRENT frame's view-projection.
   * Called by both render paths right after they build _viewProj. The sun is a direction,
   * so it is projected as a point at infinity (w = 0 homogeneous input).
   */
  const _sunClip = new THREE.Vector4();
  function updateSunScreen() {
    const s = uSunDir.value;
    _sunClip.set(s.x, s.y, s.z, 0).applyMatrix4(_viewProj);
    if (!(P.godRays && P.rayStrength > 0) || _sunClip.w <= 1e-4) {
      uRayActive.value = 0;
      return;
    }
    const nx = _sunClip.x / _sunClip.w;
    const ny = _sunClip.y / _sunClip.w;
    uSunUV.value.set(nx * 0.5 + 0.5, ny * 0.5 + 0.5);
    // Fade as the sun leaves the frame (shafts can stream in from just off-screen), and
    // as it sinks — below the horizon the source is the sky's own dusk glow, not a disc.
    const edge = Math.max(Math.abs(nx), Math.abs(ny));
    // (three's smoothstep needs min < max, so invert rather than swap the edges.)
    const offFade = 1 - THREE.MathUtils.smoothstep(edge, 1.1, 2.2);
    const upFade = THREE.MathUtils.smoothstep(s.y, 0.01, 0.09);
    uRayActive.value = offFade * upFade;
  }

  // ── Frame ──────────────────────────────────────────────────────────────────────────

  const _bufSize = new THREE.Vector2();
  const _prevClear = new THREE.Color();
  const _viewProj = new THREE.Matrix4();
  let fullW = 0, fullH = 0, rtW = 0, rtH = 0;
  let _frame = 0;
  const _windAccum = new THREE.Vector3();
  /** Reused sample buffers so the per-frame density query allocates nothing. */
  const _cpuScratch = { b: [0, 0, 0, 0], w: [0, 0, 0, 0], d: [0, 0, 0, 0] };

  function ensureSize() {
    renderer.getDrawingBufferSize(_bufSize);
    const fw = Math.max(1, Math.floor(_bufSize.x));
    const fh = Math.max(1, Math.floor(_bufSize.y));
    if (fw !== fullW || fh !== fullH) {
      fullW = fw; fullH = fh;
      uFullTexel.value.set(1 / fw, 1 / fh);
      uAspect.value = fw / fh;
      shaftRT.setSize(Math.max(1, fw >> 2), Math.max(1, fh >> 2));
      uShaftTexel.value.set(1 / Math.max(1, fw >> 2), 1 / Math.max(1, fh >> 2));
      if (_ownsFrame) sceneRT.setSize(fw, fh);
    }
    const w = Math.max(1, Math.floor(fw * P.bufferScale));
    const h = Math.max(1, Math.floor(fh * P.bufferScale));
    if (w !== rtW || h !== rtH) {
      rtW = w; rtH = h;
      cloudRT.setSize(w, h);
      historyRT[0].setSize(w, h);
      historyRT[1].setSize(w, h);
      uCloudTexel.value.set(1 / w, 1 / h);
      uCloudRes.value.set(w, h);
      // The old accumulation is at the wrong resolution — start it over rather than
      // blending against a stretched copy of the previous size.
      uHasHistory.value = 0;
    }
  }

  /**
   * Give back every render target. Called on disable so a switched-off deck holds no VRAM.
   *
   * Shrinking to 1x1 rather than disposing: the TSL nodes are bound to these specific
   * RenderTarget objects, so disposing them would leave the material pointing at dead
   * textures and re-enabling would need the whole node graph rebuilt. 1x1 is ~nothing and
   * re-enabling just resizes back.
   */
  function releaseBuffers() {
    sceneRT.setSize(1, 1);
    cloudRT.setSize(1, 1);
    historyRT[0].setSize(1, 1);
    historyRT[1].setSize(1, 1);
    shaftRT.setSize(1, 1);
    fullW = fullH = rtW = rtH = 0; // force ensureSize() to rebuild on re-enable
    uHasHistory.value = 0;
  }

  /**
   * Turn the deck on or off.
   *
   * OFF IS MEANT TO BE FREE, not cheap:
   *   - `renderFrame()` returns false immediately, so the caller falls back to its own
   *     render — no scene RT, no march, no resolve, no composite. Zero GPU passes.
   *   - the render targets are released, so no VRAM is held.
   *   - the mesh is hidden, so it is not traversed or drawn.
   *   - the noise bake never starts unless the deck has been enabled at least once, so a
   *     player who leaves clouds off never pays the worker seconds or the ~10 MB.
   *   - the cloud shaders never compile, because nothing ever renders them.
   * The only residue is the zero-filled CPU-side volume arrays (~9.7 MB), which are not
   * uploaded to the GPU until something actually samples them.
   */
  function setEnabled(on) {
    const want = !!on;
    if (want === P.enabled) return;
    P.enabled = want;
    if (want) {
      startBake();
    } else {
      mesh.visible = false;
      _fade = 0;
      uFade.value = 0;
      releaseBuffers();
    }
  }

  /**
   * @param {number} dt    seconds
   * @param {object} frame { sunDir, sunColor, skyZenith, skyHorizon, hazeColor,
   *                         hazeSunColor } — hazeSunColor is the sun-side aerial target
   *                         (defaults to hazeColor; see uAerialColorSun).
   */
  function update(dt, frame = {}) {
    // Tolerate `params.enabled` being flipped directly (the lab's sliders do this) — the
    // bake still has to be kicked, and disabling still has to give the buffers back.
    if (P.enabled && !_bakeStarted) startBake();
    if (!P.enabled && rtW > 1) releaseBuffers();
    mesh.visible = P.enabled;
    if (!P.enabled) return;
    mesh.position.copy(camera.position);

    // Ease in once the bake lands — appearing in a single frame reads as a glitch.
    const target = _ready ? 1 : 0;
    const d = target - _fade;
    _fade += Math.sign(d) * Math.min(Math.abs(d), dt * 1.2);
    uFade.value = _fade;

    const rad = THREE.MathUtils.degToRad(P.windDeg);
    _windAccum.x += Math.cos(rad) * P.windSpeed * dt;
    _windAccum.z += Math.sin(rad) * P.windSpeed * dt;
    uWind.value.copy(_windAccum);

    uBase.value = P.base;
    uThickness.value = P.thickness;
    uCoverage.value = P.coverage;
    uCoverageBias.value = P.coverageBias;
    uCoverageSoft.value = P.coverageSoft;
    uDensityMul.value = P.densityMul;
    uErode.value = P.erode;
    uNearErode.value = P.nearErode;
    uNearRange.value = P.nearRange;
    uDetailRange.value = P.detailRange;
    uTypeBias.value = P.typeBias;
    uCloudTopMin.value = P.cloudTopMin;
    uEdgeTaper.value = P.edgeTaper;
    uCloudTopBias.value = P.cloudTopBias;
    uClearRadius.value = P.clearRadius;
    uClearFloor.value = P.clearFloor;

    uMinStep.value = P.minStep;
    uStepGrowth.value = P.stepGrowth;
    // The step ceiling is the TIGHTER of the metre cap and the slab-relative one, so a
    // thin deck automatically gets enough samples across it. Floored at `minStep` so a
    // pathologically thin slab cannot drive the step below the near-field rate (and cannot
    // invert the clamp bounds in the shader).
    uMaxStep.value = P.slabSamples > 0
      ? Math.min(P.maxStep, Math.max(P.minStep, P.thickness / P.slabSamples))
      : P.maxStep;
    uSteps.value = Math.min(P.steps, MAX_STEPS);
    uEmptyStepMul.value = P.emptyStepMul;
    uJitterMaxM.value = P.jitterMaxM;
    uMaxDist.value = P.maxDist;

    uLightSteps.value = Math.min(P.lightSteps, MAX_LIGHT_STEPS);
    uLightConeLength.value = P.lightConeLength;
    uLightAbsorb.value = P.lightAbsorb;
    uPhaseG.value = P.phaseG;
    uPhaseW.value = P.phaseW;
    uPowder.value = P.powder;
    uMsAmount.value = P.msAmount;
    uMsExtinction.value = P.msExtinction;
    uMsContribution.value = P.msContribution;
    uMsEccentricity.value = P.msEccentricity;
    // The multiple-scattering floor stands in for sunlight DIFFUSED through the mass, so
    // it must die with the sun: at low elevations the slant path through the atmosphere
    // has already eaten most of the light before it reaches the cloud, and a floor held
    // at full strength paints every shadowed face with flat sun colour — at sunset that
    // was a wall of glowing salmon where dark silhouettes belong. Ramped on sun height:
    // full above ~27°, ~30% at 10° (golden hour keeps dark cores under gold rims), gone
    // just below the horizon.
    const sunUp = uSunDir.value.y;
    uMsFloor.value = P.msFloor * THREE.MathUtils.smoothstep(sunUp, 0.02, 0.45);
    uMsFloorDepth.value = P.msFloorDepth;
    // Ground shadows die with the sun too — a moon-lit deck should not stamp
    // noon-strength shadow dapples on the track. Fades over the same low-sun window
    // where the light itself goes dim, and 0 skips the whole shadow branch.
    uShadowStrength.value = P.shadowStrength * THREE.MathUtils.smoothstep(sunUp, 0.04, 0.3);
    uShadowSoft.value = P.shadowSoftness;
    uRayStrength.value = P.rayStrength;
    uRayDecay.value = P.rayDecay;
    uRaySteps.value = Math.min(P.raySteps, MAX_RAY_STEPS);
    uRayLen.value = P.rayLength;
    uRayTight.value = P.rayTightness;
    camera.getWorldDirection(_camFwd);
    uCamFwd.value.copy(_camFwd);
    uSunIntensity.value = P.sunIntensity;
    uAmbientIntensity.value = P.ambientIntensity;

    if (solidOn) {
      uSDensity.value = P.solidDensity;
      uSCoverage.value = P.solidCoverage;
      uSWeatherBias.value = P.solidWeatherBias;
      uSWeatherScale.value = P.solidWeatherScale;
      uSBaseScale.value = P.solidBaseScale;
      uSErosionMul.value = P.solidErosionMul;
      uSBaseStrength.value = P.solidBaseStrength;
      uSErodeBase.value = P.solidErodeBase;
      uSErodePeak.value = P.solidErodePeak;
      uSEdgeSoft.value = P.solidEdgeSoft;
      uSEdgeFalloff.value = P.solidEdgeFalloff;
      uSStep.value = P.solidStep;
      uSConeAngle.value = P.solidConeAngle;
      uSMaxOD.value = P.solidMaxOD;
      uSLightStep.value = P.solidLightStep;
      uSLightSpread.value = P.solidLightSpread;
      uSFullLightAlpha.value = P.solidFullLightAlpha;
      uSAlbedo.value = P.solidAlbedo;
      uSPhaseFwd.value = P.solidPhaseFwd;
      uSPhaseBack.value = P.solidPhaseBack;
      uSGroundBounce.value = P.solidGroundBounce;
    }

    uAerialEnabled.value = P.aerialEnabled ? 1 : 0;
    uAerialDensity.value = P.aerialDensity;
    uAerialAmount.value = P.aerialAmount;
    uUpsampleReject.value = P.upsampleDepthReject;
    uHistoryBlend.value = P.historyBlend;
    // Motion-aware clamp: full strength while moving (disocclusion is possible), relaxed
    // when still (it is not, and the clamp would only be blocking convergence).
    {
      const dPos = _camMotionInit ? camera.position.distanceTo(_prevCamPos) : 1e9;
      const dot = _camMotionInit ? Math.abs(camera.quaternion.dot(_prevCamQuat)) : 0;
      const dRot = 1 - Math.min(1, dot);
      const motion = Math.min(1, dPos / 0.35 + dRot * 60);
      uHistoryClamp.value = THREE.MathUtils.lerp(
        P.historyClampIdle, P.historyClampStrength, motion,
      );
      _prevCamPos.copy(camera.position);
      _prevCamQuat.copy(camera.quaternion);
      _camMotionInit = true;
    }
    uCamNear.value = camera.near;
    uCamFar.value = camera.far;

    if (frame.sunDir) uSunDir.value.copy(frame.sunDir).normalize();
    if (frame.sunColor) uSunColor.value.set(frame.sunColor);
    if (frame.skyZenith) uSkyZenith.value.set(frame.skyZenith);
    if (frame.skyHorizon) uSkyHorizon.value.set(frame.skyHorizon);
    if (frame.hazeColor) uAerialColor.value.set(frame.hazeColor);
    // Sun-side haze follows the plain haze unless the caller supplies its own — that keeps
    // the lab (which passes one colour) exactly as it was.
    if (frame.hazeSunColor) uAerialColorSun.value.set(frame.hazeSunColor);
    else if (frame.hazeColor) uAerialColorSun.value.set(frame.hazeColor);

    _frame = (_frame + 1) % 64;
    uFrameJitter.value = _frame;
  }

  /**
   * Owns the frame: scene → sceneRT, clouds → cloudRT, composite → canvas.
   * Returns false when the deck is off so the caller falls back to a normal render.
   */
  function renderFrame() {
    if (!P.enabled) return false;
    ensureSize();
    uReversed.value = camera.reversedDepth ? 1 : 0;

    const prevMask = camera.layers.mask;
    const prevTarget = renderer.getRenderTarget();
    renderer.getClearColor(_prevClear);
    const prevClearA = renderer.getClearAlpha();

    // 1) Scene + depth, cloud dome excluded by layer.
    camera.layers.disable(CLOUD_LAYER);
    renderer.setRenderTarget(sceneRT);
    renderer.render(scene, camera);

    // 2) Clouds alone, half res, reading the depth we just wrote.
    camera.layers.set(CLOUD_LAYER);
    renderer.setRenderTarget(cloudRT);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(scene, camera);
    camera.layers.mask = prevMask;
    renderer.setClearColor(_prevClear, prevClearA);

    // 3) Temporal resolve: reproject the previous accumulation and blend in this march.
    //    Matrices must be captured AFTER the scene render, when the camera matrices for
    //    this frame are current.
    _viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    uInvViewProj.value.copy(_viewProj).invert();
    uCamPos.value.copy(camera.position);

    const write = histWrite;
    const read = 1 - write;
    histTex.value = historyRT[read].texture;

    postQuad.material = resolveMat;
    renderer.setRenderTarget(historyRT[write]);
    renderer.render(postScene, postCam);

    // 4) God rays from the resolved cloud gaps (skipped entirely when inactive —
    //    the composite gates its add on uRayActive, so a stale buffer cannot show).
    cloudTex.value = historyRT[write].texture;
    updateSunScreen();
    if (uRayActive.value > 0) {
      postQuad.material = shaftMat;
      renderer.setRenderTarget(shaftRT);
      renderer.render(postScene, postCam);
    }

    // 5) Composite the resolved buffer (+ shafts) to the canvas.
    postQuad.material = compositeMat;
    renderer.setRenderTarget(null);
    renderer.render(postScene, postCam);

    // Roll the ping-pong and remember this frame's transform for the next reprojection.
    histWrite = read;
    uPrevViewProj.value.copy(_viewProj);
    uHasHistory.value = 1;

    renderer.setRenderTarget(prevTarget);
    return true;
  }

  // ── Post-FX integration ────────────────────────────────────────────────────────────
  // Used when the engine's post-FX chain is active, so bloom/FXAA still apply and the game
  // does NOT lose its selective-bloom neon. Two phases, matching what PostFxPipeline's
  // `renderWithClouds()` already expects:
  //
  //   prepareFrame()            — deliberately does nothing but say "yes, go ahead".
  //   compositeOntoLinearHDR()  — runs AFTER the solids pass, which is the whole point:
  //                               the scene depth exists by then, so the march can read it
  //                               instead of re-rendering the scene to manufacture one.
  //
  // `setDepthSource()` points the shared depth sampler at the pipeline's scene-pass depth.
  // Same material either way — only the texture bound to the sampler changes — so this
  // does not fork the shader.
  let _ownsFrame = true;

  function setDepthSource(tex) {
    depthTex.value = tex ?? sceneRT.depthTexture;
    _ownsFrame = !tex;
    if (!_ownsFrame) sceneRT.setSize(1, 1); // the pipeline owns the scene buffer now
  }

  function prepareFrame() {
    return !!P.enabled;
  }

  function compositeOntoLinearHDR(rendererArg, targetRT) {
    if (!P.enabled) return;
    ensureSize();
    uReversed.value = camera.reversedDepth ? 1 : 0;

    const prevMask = camera.layers.mask;
    renderer.getClearColor(_prevClear);
    const prevClearA = renderer.getClearAlpha();

    // 1) March the deck alone into the half-res buffer, reading the pipeline's depth.
    camera.layers.set(CLOUD_LAYER);
    renderer.setRenderTarget(cloudRT);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(scene, camera);
    camera.layers.mask = prevMask;
    renderer.setClearColor(_prevClear, prevClearA);

    // 2) Temporal resolve.
    _viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    uInvViewProj.value.copy(_viewProj).invert();
    uCamPos.value.copy(camera.position);
    const write = histWrite, read = 1 - write;
    histTex.value = historyRT[read].texture;
    postQuad.material = resolveMat;
    renderer.setRenderTarget(historyRT[write]);
    renderer.render(postScene, postCam);

    // 3) God rays, then blend the resolved cloud (+ shafts) over the pipeline's HDR.
    cloudTex.value = historyRT[write].texture;
    updateSunScreen();
    if (uRayActive.value > 0) {
      postQuad.material = shaftMat;
      renderer.setRenderTarget(shaftRT);
      renderer.render(postScene, postCam);
    }
    postQuad.material = linearCompositeMat;
    const prevAuto = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(targetRT);
    renderer.render(postScene, postCam);
    renderer.autoClear = prevAuto;
    postQuad.material = compositeMat;

    histWrite = read;
    uPrevViewProj.value.copy(_viewProj);
    uHasHistory.value = 1;
  }

  function dispose() {
    // A bake in flight would otherwise keep a worker (and ~10 MB) alive past teardown.
    if (_worker) { _worker.terminate(); _worker = null; }
    mesh.geometry.dispose();
    material.dispose();
    compositeMat.dispose();
    linearCompositeMat.dispose();
    postQuad.geometry.dispose();
    sceneRT.dispose();
    cloudRT.dispose();
    historyRT[0].dispose();
    historyRT[1].dispose();
    shaftRT.dispose();
    shaftMat.dispose();
    resolveMat.dispose();
    baseTexture.dispose();
    detailTexture.dispose();
    nearTexture.dispose();
    weatherTexture.dispose();
    solidBaseTexture?.dispose();
    solidWeatherTexture?.dispose();
  }

  return {
    params: P,
    mesh,
    update,
    renderFrame,
    setEnabled,
    get enabled() { return P.enabled; },
    // Post-FX path (PostFxPipeline.renderWithClouds) — keeps bloom/FXAA working.
    setDepthSource,
    prepareFrame,
    compositeOntoLinearHDR,
    dispose,
    /**
     * Cloud density at a world point, on the CPU. Zero until the bake lands.
     *
     * This is the hook gameplay needs: "is the car in a cloud" drives HUD legibility,
     * engine/wind audio muffling and any in-cloud visibility rule. The GPU field is a 3D
     * texture the CPU cannot read back cheaply per frame, so this re-evaluates the same
     * recipe against the same baked arrays. Roughly 2 volume samples — fine per frame for
     * one or a handful of query points, not for thousands.
     */
    densityAt(x, y, z) {
      if (!_ready) return 0;
      if (solidOn) {
        return solidDensityAtCPU(
          { solidBase: solidBaseTexture.image.data, solidWeather: solidWeatherTexture.image.data },
          P, _windAccum, x, y, z, _cpuScratch,
        );
      }
      return densityAtCPU(
        { base: baseTexture.image.data, detail: detailTexture.image.data,
          weather: weatherTexture.image.data },
        P, _windAccum, x, y, z, _cpuScratch,
      );
    },
    /** Convenience: is this point inside meaningful cloud? */
    isInCloud(x, y, z, threshold = 0.02) {
      return this.densityAt(x, y, z) > threshold;
    },
    ready: readyPromise,
    get isReady() { return _ready; },
    get bakeMs() { return _bakeMs; },
    CLOUD_LAYER,
    /**
     * THE DENSITY FIELD AS TSL, for passes that are not the view march.
     *
     * A cloud shadow map and a sky-with-clouds environment probe both need to ask "how
     * much cloud is along this ray" from their own shaders. The alternative — each of them
     * re-deriving the recipe — is the failure mode that guarantees drift: the moment the
     * erosion or the coverage threshold changes here, the shadows stop matching the clouds
     * that cast them, and nothing errors. So the recipe is published rather than copied,
     * and there is exactly one place that decides what a cloud is.
     *
     * `sampleDensityCheap` (base shape, no erosion octaves) is the right sample for both
     * consumers: it is what the light march already uses, and neither a 512-texel shadow
     * map nor a 128-texel probe can resolve detail frequencies anyway.
     *
     * The uniforms come with it because a consumer that hard-codes the slab bounds is the
     * same drift bug wearing a different hat.
     */
    field: {
      // In the solid model every consumer gets the solid occupancy (in extinction/m), so
      // the shadow map and the environment probe follow the same clouds as the view.
      sampleDensity: solidOn ? solidFieldDensity : sampleDensity,
      sampleDensityCheap: solidOn ? solidFieldDensity : sampleDensityCheap,
      sampleDensityCheapW: solidOn ? solidFieldDensityW : sampleDensityCheapW,
      sampleWeather,
      uBase, uThickness, uDensityMul, uWind, uSunDir, uSunColor,
      uSkyZenith, uSkyHorizon, uLightAbsorb, uMaxDist, uFade,
    },
    /** Internal buffers — exposed for the lab's pixel probes, not for game code. */
    _debug: { sceneRT, cloudRT, material, compositeMat },
  };
}

/** Spawn the bake worker and resolve with the four buffers. */
function bakeInWorker(seed, onSpawn, solid = false) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(
        new URL("./modularRoadCloudNoiseWorker.js", import.meta.url),
        { type: "module" },
      );
    } catch (err) {
      reject(err);
      return;
    }
    onSpawn?.(worker);
    worker.onmessage = (e) => {
      const d = e.data;
      worker.terminate();
      if (d?.ok) resolve(d);
      else reject(new Error(d?.error ?? "unknown bake failure"));
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || "worker error"));
    };
    worker.postMessage({ seed, solid });
  });
}
