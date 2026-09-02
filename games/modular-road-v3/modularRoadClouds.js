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
  saturate, interleavedGradientNoise,
} from "three/tsl";
import {
  BASE_TILE_M, DETAIL_TILE_M, NEAR_TILE_M, WEATHER_TILE_M,
  BASE_SIZE, DETAIL_SIZE, NEAR_SIZE, WEATHER_SIZE,
  densityAtCPU,
} from "./modularRoadCloudNoise.js";

/** Layer the cloud dome lives on, so the main scene pass skips it and we march it alone. */
export const CLOUD_LAYER = 19;

/** Loop bounds. TSL `Loop` compiles to a fixed trip count, so these are compile-time
 *  ceilings; the runtime uniforms (`steps`, `lightSteps`) cut the loop short via Break. */
const MAX_STEPS = 192;
const MAX_LIGHT_STEPS = 6;

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
   */
  maxStep: 28,
  /** Hard step-count budget (<= MAX_STEPS). */
  steps: 160,
  /** Empty-space steps are this multiple of the local step. */
  emptyStepMul: 3.0,
  /**
   * Cap on the start-of-march dither, in METRES.
   *
   * The entry point is jittered so a fixed step start does not band the slab into shells.
   * Jittering by a FULL step ties the dither amplitude to `maxStep`, which is 60 m far
   * away — so at a thin cloud edge, neighbouring pixels start up to 60 m apart and can
   * disagree about whether they hit cloud at all. That is the visible crosshatch, and it
   * is far too much for a ~10-frame temporal average to hide while the camera is moving.
   * Capping it keeps the anti-banding benefit at a fraction of the noise.
   */
  jitterMaxM: 7.0,
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
  const weatherTexture = new THREE.DataTexture(
    new Uint8Array(WEATHER_SIZE * WEATHER_SIZE * 4), WEATHER_SIZE, WEATHER_SIZE, THREE.RGBAFormat,
  );
  weatherTexture.minFilter = weatherTexture.magFilter = THREE.LinearFilter;
  weatherTexture.wrapS = weatherTexture.wrapT = THREE.RepeatWrapping;
  weatherTexture.needsUpdate = true;

  const baseTex = texture3D(baseTexture, null, 0);
  const detailTex = texture3D(detailTexture, null, 0);
  const nearTex = texture3D(nearTexture, null, 0);
  const weatherTex = texture(weatherTexture);

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
    bakeInWorker(seed, (w) => { _worker = w; })
      .then((res) => {
        // Copy INTO the existing buffers — never reassign `.image`. See makeVolume().
        refill(baseTexture, res.base);
        refill(detailTexture, res.detail);
        refill(nearTexture, res.near);
        refill(weatherTexture, res.weather);
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
    // How much of the slab this cell's cloud fills. Floored, or a cell would have no
    // cloud at all rather than a shallow one.
    const top = mix(uCloudTopMin, float(1.0), saturate(w.a.add(uCloudTopBias)));
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
  const sampleDensityCheap = Fn(([p]) => {
    const h = p.y.sub(uBase).div(uThickness);
    const result = float(0.0).toVar();
    If(h.greaterThan(0.0).and(h.lessThan(1.0)), () => {
      const wm = sampleWeather(p);
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
  const lightMarch = Fn(([p]) => {
    const tau = float(0.0).toVar();
    const unit = uLightConeLength.div(32.0);
    Loop(MAX_LIGHT_STEPS, ({ i }) => {
      If(float(i).greaterThanEqual(uLightSteps), () => Break());
      const fi = float(i);
      const dist = unit.mul(pow(float(2.0), fi));
      const off = vec3(
        sin(fi.mul(12.9898)), cos(fi.mul(7.3313)), sin(fi.mul(4.1234).add(1.7)),
      ).mul(0.32).mul(dist);
      tau.addAssign(sampleDensityCheap(p.add(uSunDir.mul(dist)).add(off)).mul(dist));
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
      // Dither the entry by up to one step so the slab edge does not band. Interleaved
      // gradient noise beats a hash(sin(dot)) at the same cost, and offsetting it per
      // frame lets the residual average out instead of sitting as a fixed pattern.
      const jit = interleavedGradientNoise(screenCoordinate.xy.add(uFrameJitter.mul(5.588238)));
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
            const tauL = lightMarch(p);
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

  const material = new THREE.MeshBasicNodeMaterial();
  material.colorNode = cloudColorNode();
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
        const raw = histTex.sample(puv);
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
    const sceneCol = sceneTex.sample(fuv).rgb;
    return vec4(sceneCol.mul(cloud.a.oneMinus()).add(cloud.rgb), 1.0); // premultiplied over
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
    return upsampleCloud(vec2(uv().x, uv().y.oneMinus()));
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
    uCloudTopBias.value = P.cloudTopBias;
    uClearRadius.value = P.clearRadius;
    uClearFloor.value = P.clearFloor;

    uMinStep.value = P.minStep;
    uStepGrowth.value = P.stepGrowth;
    uMaxStep.value = P.maxStep;
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
    uSunIntensity.value = P.sunIntensity;
    uAmbientIntensity.value = P.ambientIntensity;

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

    // 4) Composite the resolved buffer to the canvas.
    cloudTex.value = historyRT[write].texture;
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

    // 3) Blend the resolved cloud over the pipeline's linear HDR buffer.
    cloudTex.value = historyRT[write].texture;
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
    resolveMat.dispose();
    baseTexture.dispose();
    detailTexture.dispose();
    nearTexture.dispose();
    weatherTexture.dispose();
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
    /** Internal buffers — exposed for the lab's pixel probes, not for game code. */
    _debug: { sceneRT, cloudRT, material, compositeMat },
  };
}

/** Spawn the bake worker and resolve with the four buffers. */
function bakeInWorker(seed, onSpawn) {
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
    worker.postMessage({ seed });
  });
}
