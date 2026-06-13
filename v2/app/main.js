import * as THREE from "three";
import {
  uniform,
  Fn,
  float,
  vec2,
  step,
  texture,
  positionLocal,
  positionWorld,
  cameraPosition,
  normalize,
  dot,
  pow,
  mix,
  clamp,
  fog,
  length,
  select,
  densityFogFactor,
  attribute,
} from "three/tsl";
import { CSMShadowNode } from "three/addons/csm/CSMShadowNode.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { SkyMesh } from "three/addons/objects/SkyMesh.js";
import { HDRLoader } from "three/addons/loaders/HDRLoader.js";
import Stats from "stats-gl";
import { V2_CONFIG } from "./config.js";
import {
  createPerfState,
  createToolState,
  tickPerf,
} from "./state/toolState.js";
import { TerrainStore } from "../core/terrain/terrainStore.js";
import { TerrainMesher } from "../render/terrain/terrainMesher.js";
import { createSharedTileMaterial } from "../render/terrain/sharedTileMaterial.js";
import { createV2ProceduralGroundMaterial } from "../render/terrain/proceduralGroundMaterial.js";
import { ChunkStreamManager } from "../core/streaming/chunkStreamManager.js";
import { frameProbe } from "./frameProbe.js";
import { SculptSystem } from "../tools/sculpt/sculptSystem.js";
import { createHud } from "../ui/hud.js";
import { createLensFlareSystem } from "../effects/lensFlare.js";
import { createAutoCliffUniforms } from "../core/legacy/chunkTerrainAutoCliff.js";
import { createTextureLibrary } from "../core/textures/textureLibrary.js";
import { createPropTextureLibrary } from "../core/textures/propTextureLibrary.js";
import { createMaterialForLibrary } from "../render/props/propMaterialFactory.js";
import { createV2ImageTexGroundMaterial } from "../render/terrain/sharedImgTexMaterial.js";
import { createSplatOverlay } from "../render/terrain/splatOverlayTsl.js";
import { SplatStore } from "../core/paint/splatStore.js";
import { PaintSystem } from "../tools/paint/paintSystem.js";
import { BrushMask } from "../core/paint/brushMask.js";
import { buildLayerArrayTextures } from "../core/paint/layerArrayBuilder.js";
import {
  serializeProject,
  deserializeProject,
  downloadBlob,
  downloadWorldHeightmapPng,
  openFilePicker,
  applySettings,
} from "../core/io/terrainSerializer.js";
import { TreeStore } from "../core/foliage/treeStore.js";
import { TreeLodRenderer } from "../render/foliage/treeLodRenderer.js";
import { TreeSystem } from "../tools/foliage/treeSystem.js";
import {
  loadTreeGlbFromFile,
  loadTreeGlbFromUrl,
  openGlbPicker,
  initGlbLoaderRenderer,
} from "../core/foliage/glbLoader.js";
import { FoliageLodRenderer } from "../render/foliage/foliageLodRenderer.js";
import { FoliageStore } from "../core/foliage/foliageStore.js";
import {
  FOLIAGE_TEXTURE_DIR,
  normalizeFoliageTextureRef,
  probeFoliageTextureFile,
  applyFoliageSlotTextures,
  loadFoliageTextureFromFile,
} from "../core/foliage/foliageTexturePaths.js";
import {
  BILLBOARD_GRASS_TEXTURE_DIR,
  normalizeBillboardGrassTextureRef,
  probeBillboardGrassTextureFile,
  applyBillboardGrassSlotTextures,
  loadBillboardGrassTextureFromFile,
} from "../core/billboardGrass/billboardGrassTexturePaths.js";
import { FoliagePaintSystem } from "../tools/foliage/foliagePaintSystem.js";
import { BillboardRenderer } from "../render/foliage/billboardRenderer.js";
import { BillboardGrassStore } from "../core/billboardGrass/billboardGrassStore.js";
import { BillboardGrassPaintSystem } from "../tools/billboardGrass/billboardGrassPaintSystem.js";
import { BillboardGrassRenderer } from "../render/billboardGrass/billboardGrassRenderer.js";
import {
  loadFullPresetFromFile,
  loadFullPresetFromUrl,
} from "../core/foliage/presetLoader.js";
import { GrassManager } from "../render/foliage/grassManager.js";
import {
  HybridGrassSystem,
  syncHybridGrassLod,
  rebuildHybridGrassGeometries,
} from "../render/hybridGrass/hybridGrassSystem.js";
import { WindGustManager } from "../core/wind/windGust.js";
import { RevoGrassSystem } from "../render/revoGrass/revoGrassSystem.js";
import { SnowSystem } from "../render/snow/snowSystem.js";
import { GrassPaintSystem } from "../tools/foliage/grassPaintSystem.js";
import { RevoGrassMaskPaintSystem } from "../tools/revoGrass/revoGrassMaskPaintSystem.js";
import { SnowMaskPaintSystem } from "../tools/snow/snowMaskPaintSystem.js";
import { CliffGrassPaintSystem } from "../tools/foliage/cliffGrassPaintSystem.js";
import { PlayMode } from "../play/playMode.js";
import { createV2AudioSystem } from "../audio/createV2AudioSystem.js";
import { createGroundTslBundle } from "../core/legacy/chunkGroundTsl.js";
import { RoadSystem } from "../tools/road/roadSystem.js";
import { FullRoadSystem } from "../tools/fullRoad/fullRoadSystem.js";
import { SmartRoadLabSystem } from "../tools/smartRoad/smartRoadLabSystem.js";
import { RoadPlanarReflection } from "../core/road/roadReflection.js";
import { RiverSystem } from "../tools/river/riverSystem.js";
import { SplineSystem } from "../tools/spline/splineSystem.js";
import { SplineRoadSystem } from "../tools/splineRoad/splineRoadSystem.js";
import { CliffStore } from "../core/cliffs/cliffStore.js";
import { CliffInstancer } from "../core/cliffs/cliffInstancer.js";
import { CliffSystem } from "../tools/cliffs/cliffSystem.js";
import { CliffBvh } from "../core/cliffs/cliffBvh.js";
import { createCliffInstancerBlendMaterial } from "../core/legacy/cliffInstancerBlendMaterial.js";
import { CliffPaintMask } from "../core/cliffs/cliffPaintMask.js";
import { CliffPaintSystem } from "../tools/cliffs/cliffPaintSystem.js";
import { getTileGridTexture } from "../core/legacy/tileMaterial.js";
import { createJumpRampGeometry } from "../core/props/jumpRampGeometry.js";
import { PropStore } from "../core/props/propStore.js";
import { PropInstancer } from "../core/props/propInstancer.js";
import { PropSystem } from "../tools/props/propSystem.js";
import { LivePropManager } from "../core/props/livePropManager.js";
import {
  createFlagProp,
  flagBoundingBox,
  FLAG_DEFAULTS,
} from "../core/props/flagFactory.js";
import {
  createCoinProp,
  coinBoundingBox,
  COIN_DEFAULTS,
  createHeartProp,
  heartBoundingBox,
  HEART_DEFAULTS,
  createKeyProp,
  keyBoundingBox,
  KEY_DEFAULTS,
  registerGlbCollectibleKind,
} from "../core/props/collectibleFactory.js";
import { createCollectibleBurst } from "../effects/collectibleBurst.js";
import { createCollectibleGizmo } from "../effects/collectibleGizmo.js";
import { COLLECTIBLE_KINDS } from "../core/props/collectibleFactory.js";
import { createCollectibleRuntime } from "../play/collectibleRuntime.js";
import { createCollectibleSfx } from "../play/collectibleSfx.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { WaterStore } from "../core/water/waterStore.js";
import { createWaterMaterials } from "../render/water/waterMaterial.js";
import { createWorldOcean } from "../render/water/worldOcean.js";
import { WaterSystem } from "../tools/water/waterSystem.js";
import { DecalSystem } from "../tools/decals/decalSystem.js";
import { WaterfallSystem } from "../tools/waterfall/waterfallSystem.js";
import { ActorSystem } from "../tools/actors/actorSystem.js";
import { DialogueRunner } from "../play/dialogue/dialogueRunner.js";
import { listDialogueGraphIds } from "../play/dialogue/dialogueGraphs.js";
import { BarrierStore } from "../core/barrier/barrierStore.js";
import { BarrierSystem } from "../tools/barrier/barrierSystem.js";
import { BarrierOverlay } from "../render/barrier/barrierOverlay.js";
import { HoleStore } from "../core/hole/holeStore.js";
import { HoleSystem } from "../tools/hole/holeSystem.js";
import { HoleOverlay } from "../render/hole/holeOverlay.js";
import { CaveStore } from "../core/cave/caveStore.js";
import { InteriorVolumeRegistry } from "../render/lighting/interiorVolumeRegistry.js";
import { createInteriorLightingNodes } from "../render/lighting/interiorLightingTsl.js";
import { CaveSystem } from "../tools/cave/caveSystem.js";
import { TunnelSystem } from "../tools/tunnel/tunnelSystem.js";
import {
  createFleurSystem,
  FLEUR_PRESETS,
  FLEUR_ALPHA_URLS,
} from "../core/legacy/fleur-painter.js";
import { createAmbientFxStore } from "../core/ambientfx/ambientFxStore.js";
import { createLeafFxStore } from "../core/ambientfx/leafFxStore.js";
import { BorderMountains } from "../render/terrain/borderMountains.js";
import { createVolumetricCloudSystem } from "../render/clouds/volumetricCloudSystem.js";
import { createVolumetricCloudSystemOptimized } from "../render/clouds/volumetricCloudSystemv2.js";
import { createVolumetricCloudSystemV3 } from "../render/clouds/volumetricCloudSystemv3.js";
import { createDayNightSky } from "../render/sky/dayNightSky.js";
import { createDayNightCloudLayer } from "../render/clouds/dayNightCloudLayer.js";
import { PostFxPipeline } from "../render/post/postFxPipeline.js";

// Returned by `getTerrainHeight` whenever the sampled XZ is over a painted
// hole pixel. Finite (no NaN/Infinity edge cases) but far enough below any
// real terrain that the playMode "drop > 0.4" / "y <= groundY" tests always
// classify the player as airborne when standing on a hole.
const HOLE_GROUND_SENTINEL = -1e7;

// GLBs imported via file picker are auto-linked to /models/<file.name> when present,
// so a project save records only the filename and the load round-trip can re-fetch it.
const MODELS_SEARCH_PATHS = ["../models/", "models/"];
async function probeModelsForFile(filename) {
  if (!filename) return null;
  for (const base of MODELS_SEARCH_PATHS) {
    const url = base + filename;
    try {
      const resp = await fetch(url, { method: "HEAD" });
      if (resp.ok) return url;
    } catch (_) {
      /* try next */
    }
  }
  return null;
}

/**
 * Pack playMode contact-point state into the SnowSystem's "wheelData" shape.
 *
 * Supported modes:
 *   - car / lotus / vvv → 4 vehicle wheels + chassis (full car treatment).
 *   - capsule / char    → 1 foot stamp at the player XZ; other 3 slots are
 *                          tagged `touching = 0` so they don't carve.
 *   - fly / rts         → returns `null` (no ground contact).
 *
 * Reuses module-scope scratch buffers — zero allocations per frame.
 */
const _snowWheelXZs = new Float32Array(8);
const _snowWheelTouching = new Float32Array(4);
const _snowChassisXZ = new THREE.Vector2();
function _snowWheelData(playMode) {
  const mode = playMode.moveMode;

  if (mode === "car" || mode === "lotus" || mode === "vvv") {
    const src = playMode._wheelWorldXZs;
    if (!src) return null;
    _snowWheelXZs[0] = src[0];
    _snowWheelXZs[1] = src[1];
    _snowWheelXZs[2] = src[2];
    _snowWheelXZs[3] = src[3];
    _snowWheelXZs[4] = src[4];
    _snowWheelXZs[5] = src[5];
    _snowWheelXZs[6] = src[6];
    _snowWheelXZs[7] = src[7];
    /**
     * Per-wheel touching isn't tracked yet — use the chassis-level `carInAir`
     * as a proxy. Refinement (carPhysics.lastSusp.contacts) is a later step.
     */
    const allTouching = playMode.carInAir ? 0 : 1;
    _snowWheelTouching[0] = allTouching;
    _snowWheelTouching[1] = allTouching;
    _snowWheelTouching[2] = allTouching;
    _snowWheelTouching[3] = allTouching;
    _snowChassisXZ.set(playMode.playerPos.x, playMode.playerPos.z);
    return {
      wheelXZs: _snowWheelXZs,
      wheelTouching: _snowWheelTouching,
      chassisXZ: _snowChassisXZ,
      chassisTouching: allTouching,
    };
  }

  if (mode === "capsule" || mode === "char") {
    /** Single foot stamp in slot 0; other slots inactive. */
    const grounded = playMode.inAir ? 0 : 1;
    _snowWheelXZs[0] = playMode.playerPos.x;
    _snowWheelXZs[1] = playMode.playerPos.z;
    _snowWheelXZs[2] = 0;
    _snowWheelXZs[3] = 0;
    _snowWheelXZs[4] = 0;
    _snowWheelXZs[5] = 0;
    _snowWheelXZs[6] = 0;
    _snowWheelXZs[7] = 0;
    _snowWheelTouching[0] = grounded;
    _snowWheelTouching[1] = 0;
    _snowWheelTouching[2] = 0;
    _snowWheelTouching[3] = 0;
    _snowChassisXZ.set(0, 0);
    return {
      wheelXZs: _snowWheelXZs,
      wheelTouching: _snowWheelTouching,
      chassisXZ: _snowChassisXZ,
      chassisTouching: 0,
    };
  }

  return null;
}

export async function startV2App(opts = {}) {
  const config = structuredClone(V2_CONFIG);
  if (opts.worldSize) config.world.size = opts.worldSize;
  const toolState = createToolState();
  const perf = createPerfState();
  const _uiContainer = opts.container || null;
  const _initW = _uiContainer ? _uiContainer.clientWidth : window.innerWidth;
  const _initH = _uiContainer ? _uiContainer.clientHeight : window.innerHeight;

  const scene = new THREE.Scene();
  // splatmap-chunks.html: physical sky + PMREM — background stays null so SkyMesh fills the view.
  scene.background = null;

  const camera = new THREE.PerspectiveCamera(
    65,
    _initW / Math.max(_initH, 1),
    0.1,
    5000,
  );
  camera.position.set(160, 140, 180);

  const renderer = new THREE.WebGPURenderer({ antialias: true });
  renderer.setPixelRatio(
    Math.min(window.devicePixelRatio, config.render.maxPixelRatio),
  );
  renderer.setSize(_initW, _initH);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.transmitted = true;
  (_uiContainer || document.body).appendChild(renderer.domElement);

  // FPS / CPU / GPU stats overlay (stats-gl reads real WebGPU timestamps).
  const stats = new Stats({ trackGPU: true, trackCPT: true });
  await stats.init(renderer);
  // Move the overlay to the bottom-left (stats-gl defaults to top-left).
  // The panel canvases are absolutely positioned at top:0 inside a 0-height
  // container, so anchoring at bottom:0 alone pushes them off-screen — give
  // the container an explicit height (one horizontal row ≈ 48px) so they sit
  // just above the bottom edge.
  stats.dom.style.top = "auto";
  stats.dom.style.bottom = "8px";
  stats.dom.style.left = "8px";
  stats.dom.style.height = "48px";
  (_uiContainer || document.body).appendChild(stats.dom);

  // Custom counter panels (scene complexity, read from renderer.info each
  // frame). DRAW = draw calls, KTRI = triangles in thousands. These complement
  // the timing panels: timing says "how slow", counters say "why".
  const drawPanel = stats.addPanel(new Stats.Panel("DRAW", "#f0f", "#202"));
  const triPanel = stats.addPanel(new Stats.Panel("KTRI", "#f90", "#210"));
  let _statMaxDraw = 1;
  let _statMaxTri = 1;
  // We render many passes per frame (post-FX RenderPipeline + cloud RTs) and
  // three resets `renderer.info` at the start of each one — so leave auto-reset
  // off and reset once per frame ourselves (top of the loop) to get the true
  // whole-frame totals instead of just the last pass.
  renderer.info.autoReset = false;

  await renderer.init();
  initGlbLoaderRenderer(renderer);

  /** Same convention as `splatmap-chunks.html` `sunDirectionFromAngles`. */
  const sunDir = new THREE.Vector3();
  // The direction the scene KEY LIGHT comes from: the sun by day, the moon
  // (sun antipode) at night in procedural mode. Distinct from `sunDir`, which the
  // sky dome always needs as the true sun (for the sun disc). Used by the
  // directional light + grass/foliage/ocean lighting.
  const _effectiveLightDir = new THREE.Vector3();
  function sunDirectionFromAngles(azDeg, elDeg, target = new THREE.Vector3()) {
    const az = THREE.MathUtils.degToRad(azDeg);
    const el = THREE.MathUtils.degToRad(elDeg);
    return target
      .set(
        Math.cos(el) * Math.cos(az),
        Math.sin(el),
        Math.cos(el) * Math.sin(az),
      )
      .normalize();
  }

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 10, 0);
  controls.enableDamping = true;
  // Allow looking UP at the sky / cloud deck. The old 0.49π clamp locked the
  // camera to horizontal-or-below (terrain-editing default); 0.92π lets you tilt
  // well up into the sky while still stopping just short of flipping fully under
  // the world. Set to Math.PI for fully unconstrained.
  controls.maxPolarAngle = Math.PI * 0.92;
  controls.minDistance = 15;
  controls.maxDistance = 1500;
  // Match splatmap-chunks.html interaction: LMB sculpt, MMB orbit, RMB pan.
  controls.mouseButtons = {
    MIDDLE: THREE.MOUSE.ROTATE,
    RIGHT: THREE.MOUSE.PAN,
  };

  const L = toolState.light;
  const hemi = new THREE.HemisphereLight(
    L.hemiSkyColor,
    L.hemiGroundColor,
    L.hemiIntensity,
  );
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(L.dirColor, L.dirIntensity);
  sun.castShadow = true;
  const shadowTarget = new THREE.Object3D();
  scene.add(shadowTarget);
  sun.target = shadowTarget;
  sun.shadow.mapSize.set(toolState.csm.mapSize, toolState.csm.mapSize);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 300;
  sun.shadow.camera.left = sun.shadow.camera.bottom = -300;
  sun.shadow.camera.right = sun.shadow.camera.top = 300;
  sun.shadow.bias = L.shadowBias;
  sun.shadow.normalBias = L.shadowNormalBias;
  scene.add(sun);

  /** splatmap-chunks.html: `CSMShadowNode` (WebGPU); falls back to plain shadow if init fails. */
  let csm = null;
  let _lastCsmCascades = toolState.csm.cascades;
  let _lastCsmMaxFar = toolState.csm.maxFar;
  let _lastCsmMargin = toolState.csm.lightMargin;
  let _lastCsmMapSize = toolState.csm.mapSize;

  function setCsmEnabled(on) {
    if (!sun.shadow) return;
    sun.shadow.shadowNode = on && csm ? csm : null;
  }

  try {
    if (renderer.shadowMap) {
      csm = new CSMShadowNode(sun, {
        cascades: toolState.csm.cascades,
        maxFar: toolState.csm.maxFar,
        mode: "practical",
        lightMargin: toolState.csm.lightMargin,
      });
      if (csm.lights.length > 2) {
        csm.lights[2].shadow.mapSize.set(1024, 1024);
      }
      if (toolState.csm.enabled) {
        sun.shadow.shadowNode = csm;
      }
    }
  } catch (err) {
    console.warn(
      "[V2] CSMShadowNode init failed; using non-CSM directional shadow.",
      err,
    );
    csm = null;
  }

  const sky = new SkyMesh();
  sky.scale.setScalar(toolState.physicalSky.meshScale);
  if (sky.material) sky.material.fog = false;
  scene.add(sky);

  // Procedural day/night sky dome (skyMode === "procedural"). Self-contained
  // module ported from the daynight-sky lab; hidden until that mode is picked.
  // Follows the camera + reads sun/moon from the same single sun driver below.
  const dayNightSky = createDayNightSky();
  dayNightSky.mesh.visible = false;
  scene.add(dayNightSky.mesh);
  const _moonDir = new THREE.Vector3();
  const _procSkyFogColor = new THREE.Color();
  const _todSunDir = new THREE.Vector3();
  // Scratch for the volumetric cloud deck's per-frame lighting frame.
  const _cloudLightColor = new THREE.Color();
  const _cloudAmbColor = new THREE.Color();
  const _cloudAmbNight = new THREE.Color();
  // Scratch for the sun-tinted distance fog (lab aerial perspective).
  const _fogAwayColor = new THREE.Color();
  const _fogAwayNight = new THREE.Color();
  // Procedural-sky IBL: AMORTIZED cube bake (matches daynight-sky.html) — render
  // ONE cube face per frame, convolve to PMREM only when all 6 are ready, then
  // idle. Never a full 6-face bake in a single frame → no per-second stutter
  // during auto-advance. The dome clone shares the live material/uniforms.
  let _procEnvScene = null;
  let _procCubeRT = null;
  let _procCubeCam = null;
  let _procEnvRT = null; // persistent PMREM RT (= scene.environment), reused each bake
  let _procEnvFace = -1; // -1 = idle, 0..5 = rendering that face
  let _procEnvIdle = 0; // seconds remaining before the next bake cycle
  let _procEnvNeeds = false; // a param/sun change requested a fresh bake
  // v2 has many scene.environment consumers (ocean reflection, every PBR
  // material), so bakes are heavier than the lab. The PMREM RT is now REUSED
  // across bakes (see convolveProcEnv) so there's no per-bake allocation churn or
  // use-after-dispose device-loss ("external Instance reference no longer
  // exists"); we still idle between bakes to keep the cost down.
  const PROC_ENV_IDLE = 3.0; // seconds between re-bake cycles

  const F = toolState.fog;
  const uHFogEnabled = uniform(F.height.enabled ? 1 : 0);
  const uHFogColor = uniform(
    new THREE.Color(F.height.color).convertSRGBToLinear(),
  );
  const uHFogDensity = uniform(F.height.density);
  const uHFogFalloff = uniform(F.height.falloff ?? 0.05);
  const uHFogHeight = uniform(F.height.height);
  const uDFogEnabled = uniform(F.distance.enabled ? 1 : 0);
  // Distance-fog "away" color (the color seen perpendicular to / away from the
  // sun). Driven from the procedural sky's horizon each frame when matchSky is on.
  const uDFogColor = uniform(
    new THREE.Color(F.distance.color).convertSRGBToLinear(),
  );
  // Daynight aerial perspective — warm haze toward the sun (lab fog model).
  const uDFogSunTint = uniform(
    new THREE.Color(F.distance.sunTint).convertSRGBToLinear(),
  );
  const uDFogSunDir = uniform(new THREE.Vector3(0, 1, 0));
  const uDFogTintPow = uniform(F.distance.tintPow ?? 2.0);
  const uDFogSunStrength = uniform(0); // fades the warm tint out at night
  const uDFogDensity = uniform(F.distance.density);
  // Analytic half-space height fog (Crytek/Wenzel) — replaces three's
  // exponentialHeightFogFactor, whose (density·depth·viewZ)² exponent made the
  // sliders hyper-sensitive and ignored the camera height / ray path. Here the
  // exponential density profile a·exp(−b·(y − base)) is integrated along the
  // camera→fragment ray: τ = a·exp(−b·(camY−base))·dist·g(k), k = b·dist·rayY,
  // g(k) = (1−e⁻ᵏ)/k. Correct inside, above, and through the layer; soft top.
  const _hfVec = positionWorld.sub(cameraPosition);
  const _hfDist = length(_hfVec);
  const _hfRayY = _hfVec.y.div(_hfDist.max(1e-4));
  const _hfK = uHFogFalloff.mul(_hfDist).mul(_hfRayY);
  // g(k) → 1 as k → 0 (horizontal rays); the inner select keeps the divisor
  // non-zero so neither branch can NaN (WGSL select evaluates both sides).
  const _hfFlat = _hfK.abs().lessThan(1e-4);
  const _hfG = select(
    _hfFlat,
    float(1),
    _hfK
      .negate()
      .exp()
      .oneMinus()
      .div(select(_hfFlat, float(1), _hfK)),
  );
  // Camera-height term, exponent clamped so a camera far below the base
  // height can't overflow f32 exp() to inf (factor just saturates to 1).
  const _hfCamTerm = uHFogFalloff
    .mul(cameraPosition.y.sub(uHFogHeight))
    .negate()
    .min(50)
    .exp();
  const _hfTau = uHFogDensity.mul(_hfCamTerm).mul(_hfDist).mul(_hfG);
  const _hFactor = _hfTau.negate().exp().oneMinus().mul(uHFogEnabled);
  const _dFactor = densityFogFactor(uDFogDensity).mul(uDFogEnabled);
  const interiorRegistry = new InteriorVolumeRegistry();
  const interiorNodes = createInteriorLightingNodes(interiorRegistry);
  const _iFactor = interiorNodes.interiorFogFactorNode;
  const _weatherFactor = clamp(_hFactor.add(_dFactor), 0, 1);
  const _combinedFactor = clamp(_weatherFactor.add(_iFactor), 0, 1);
  const _weatherW = _hFactor.add(_dFactor).add(0.0001);
  // Sun-tinted distance fog color (lab aerial perspective): warm toward the sun,
  // the matched "away" color elsewhere. View-dependent, so it goes in the node
  // graph (uniforms drive it per frame — never reassign scene.fogNode).
  const _fogView = normalize(positionWorld.sub(cameraPosition));
  const _fogSunAmt = clamp(dot(_fogView, uDFogSunDir), 0, 1);
  const _distFogColor = mix(
    uDFogColor,
    uDFogSunTint,
    pow(_fogSunAmt, uDFogTintPow).mul(uDFogSunStrength),
  );
  const _weatherFogColor = mix(
    uHFogColor,
    _distFogColor,
    _dFactor.div(_weatherW),
  );
  const _blendedFogColor = mix(
    _weatherFogColor,
    interiorNodes.uColor,
    clamp(_iFactor.div(_combinedFactor.add(0.0001)), 0, 1),
  );
  const _combinedFogNode = fog(_blendedFogColor, _combinedFactor);

  // Same as splatmap-chunks.html: assign fogNode ONCE — toggling scene.fogNode at runtime
  // forces every material to recompile (WebGPU watchdog / device lost). Uniforms zero the effect when off.
  scene.fogNode = _combinedFogNode;
  function syncFog() {
    uHFogEnabled.value = F.height.enabled ? 1 : 0;
    uHFogColor.value.set(F.height.color).convertSRGBToLinear();
    uHFogDensity.value = F.height.density;
    uHFogFalloff.value = F.height.falloff ?? 0.05;
    uHFogHeight.value = F.height.height;
    uDFogEnabled.value = F.distance.enabled ? 1 : 0;
    uDFogColor.value.set(F.distance.color).convertSRGBToLinear();
    uDFogDensity.value = F.distance.density;
  }
  // Per-frame aerial-perspective fog drive (lab fog model): warm tint toward the
  // sun (fades at night) + an "away" color that tracks the procedural sky horizon
  // when matchSky is on, so distant geometry dissolves into the horizon.
  function driveFogSun() {
    const D = toolState.fog.distance;
    const sunUp = sunDir.y;
    uDFogSunDir.value.copy(sunDir);
    uDFogSunTint.value.set(D.sunTint).convertSRGBToLinear();
    uDFogTintPow.value = D.tintPow ?? 2.0;
    // Warm sun tint fades out at night (lab smoothstep(-0.1, 0.05, sunUp)).
    uDFogSunStrength.value = THREE.MathUtils.clamp((sunUp + 0.1) / 0.15, 0, 1);
    if (D.matchSky && toolState.skyMode === "procedural") {
      const ps = toolState.proceduralSky;
      const dayF = THREE.MathUtils.clamp((sunUp + 0.15) / 0.4, 0, 1);
      _fogAwayColor.set(ps.horizonDay);
      _fogAwayNight.set(ps.horizonNight);
      _fogAwayColor.lerp(_fogAwayNight, 1 - dayF);
      uDFogColor.value.copy(_fogAwayColor).convertSRGBToLinear();
    } else {
      uDFogColor.value.set(D.color).convertSRGBToLinear();
    }
  }
  function syncInteriorUniforms() {
    interiorNodes.syncFromRegistry(interiorRegistry, toolState.interior);
  }
  syncFog();
  driveFogSun();
  syncInteriorUniforms();

  let pmremGenerator = null;
  let disposeSkyEnv = null;
  let disposeHdrEnv = null;
  function applyPhysicalSkyMeshUniforms() {
    const S = toolState.physicalSky;
    sky.turbidity.value = S.turbidity;
    sky.rayleigh.value = S.rayleigh;
    sky.mieCoefficient.value = S.mie;
    sky.mieDirectionalG.value = S.mieG;
    sky.cloudCoverage.value = S.cloudCoverage;
    sky.cloudDensity.value = S.cloudDensity;
    sky.cloudElevation.value = S.cloudElevation;
  }

  function rebuildSkyEnv() {
    try {
      applyPhysicalSkyMeshUniforms();
      updateSunSky();
      if (disposeSkyEnv) {
        disposeSkyEnv();
        disposeSkyEnv = null;
      }
      pmremGenerator = pmremGenerator ?? new THREE.PMREMGenerator(renderer);
      const envScene = new THREE.Scene();
      envScene.add(sky.clone());
      const pmremRT = pmremGenerator.fromScene(envScene, 0.04);
      scene.environment = pmremRT.texture;
      disposeSkyEnv = () => pmremRT.dispose();
    } catch (err) {
      console.warn("[V2] PMREM from SkyMesh failed; IBL disabled.", err);
    }
  }

  let hdrTexture = null;
  let hdrFileName = null;

  function rebuildHdrEnv() {
    if (!hdrTexture) return;
    try {
      if (disposeHdrEnv) {
        disposeHdrEnv();
        disposeHdrEnv = null;
      }
      pmremGenerator = pmremGenerator ?? new THREE.PMREMGenerator(renderer);
      const pmremRT = pmremGenerator.fromEquirectangular(hdrTexture);
      scene.environment = pmremRT.texture;
      scene.background = hdrTexture;
      disposeHdrEnv = () => pmremRT.dispose();
    } catch (err) {
      console.warn("[V2] PMREM from HDR failed; IBL disabled.", err);
      scene.environment = null;
      scene.background = hdrTexture;
    }
  }

  // Convenience: set the scene sun from a 0–24 "time of day" (the daynight-sky
  // lab's single control). It writes the existing Azimuth/Elevation — the ONE
  // sun source the whole scene (light, shadows, fog, ocean) reads — so there's
  // no second sun. Same arc as the lab (sin / -cos / tilt); the az/el sliders
  // auto-sync via the UI poll, and the render loop's lightSnap drives the rest.
  function setTimeOfDay(t) {
    const SKY_TILT = 0.28; // matches daynight-sky.html
    const ang = (t / 24) * Math.PI * 2;
    _todSunDir.set(Math.sin(ang), -Math.cos(ang), SKY_TILT).normalize();
    toolState.light.sunElevation = THREE.MathUtils.radToDeg(
      Math.asin(THREE.MathUtils.clamp(_todSunDir.y, -1, 1)),
    );
    toolState.light.sunAzimuth =
      (THREE.MathUtils.radToDeg(Math.atan2(_todSunDir.z, _todSunDir.x)) + 360) %
      360;
    toolState.proceduralSky.timeOfDay = t;
  }

  // Feed the procedural dome each frame: it follows the camera and reads the
  // SAME sun the rest of the scene uses (updateSunSky writes `sunDir`); the moon
  // is the antipode. Cheap (uniform writes only) — safe to call every frame.
  function driveProceduralSky() {
    _moonDir.copy(sunDir).negate();
    const F = toolState.fog.distance;
    dayNightSky.update(toolState.proceduralSky, {
      time: _appTimeSec,
      sunDir,
      moonDir: _moonDir,
      camera,
      fog: {
        enabled: F.enabled,
        color: _procSkyFogColor.set(F.color),
        density: F.density,
        hazeHeight: toolState.proceduralSky.hazeHeight,
      },
    });
  }

  // Drive the volumetric cloud deck each frame (procedural sky only). The deck
  // relights by the SAME sun by day / moon by night that the dome uses; ambient
  // crossfades the dome's horizon palette. Mirrors the lab's computeFrameLighting.
  function driveDayNightClouds(dtSec) {
    if (!dayNightCloudLayer) return;
    const P = toolState.volumetricCloudDayNight;
    const ps = toolState.proceduralSky;
    const sunUp = sunDir.y;
    const dayF = THREE.MathUtils.clamp((sunUp + 0.15) / 0.4, 0, 1);
    let lightDir;
    if (sunUp >= 0) {
      lightDir = sunDir;
      _cloudLightColor.set(ps.sunColor);
    } else {
      lightDir = _moonDir; // = -sunDir, refreshed in driveProceduralSky()
      _cloudLightColor.set(ps.moonColor);
    }
    _cloudAmbColor.set(ps.horizonDay);
    _cloudAmbNight.set(ps.horizonNight);
    _cloudAmbColor.lerp(_cloudAmbNight, 1 - dayF);
    dayNightCloudLayer.update(P, {
      dt: Math.min(dtSec, 0.05),
      camera,
      lightDir,
      lightColor: _cloudLightColor,
      lightIntensity: THREE.MathUtils.lerp(0.35, 3.0, dayF),
      ambientColor: _cloudAmbColor,
      ambientIntensity: THREE.MathUtils.lerp(0.2, 0.5, dayF),
      // Aerial fade dissolves distant clouds into the SKY horizon color (like the
      // lab's matchSky fog) — NOT the generic distance-fog color — so the deck
      // recedes seamlessly into the scattering horizon. Reuse the same horizon
      // crossfade we feed ambient.
      fog: { color: _cloudAmbColor },
    });

    // Cloud shadows on terrain + ocean (composite pass). Always from the SUN;
    // strength fades with day so they vanish at night (matches the lab).
    const cs = toolState.cloudShadows;
    dayNightCloudLayer.setCloudShadow({
      enabled: cs.enabled && P.enabled,
      strength: cs.strength * dayF,
      sunDir,
    });
    // Cloud bloom (owns-the-frame path only; ignored when v2 post-FX is ON).
    dayNightCloudLayer.setBloom(toolState.cloudBloom);
  }

  // Persistent cube rig for the procedural IBL (built lazily). The dome clone
  // sits at the origin (cube cameras render from there) and SHARES the live
  // material/uniforms, so it auto-tracks the sky every frame — no per-bake
  // rebuild. Matches daynight-sky.html's envScene + CubeCamera setup.
  function ensureProcEnvRig() {
    if (_procCubeRT) return;
    _procEnvScene = new THREE.Scene();
    const domeClone = dayNightSky.mesh.clone();
    domeClone.position.set(0, 0, 0);
    _procEnvScene.add(domeClone);
    // 64 (not 128): IBL is blurred by PMREM anyway, and a smaller cube quarters
    // the per-face scattering-raymarch cost — the dominant per-bake GPU expense.
    _procCubeRT = new THREE.CubeRenderTarget(64, { type: THREE.HalfFloatType });
    _procCubeCam = new THREE.CubeCamera(0.1, 20000, _procCubeRT);
    _procCubeCam.updateMatrixWorld(true);
    pmremGenerator = pmremGenerator ?? new THREE.PMREMGenerator(renderer);
  }
  function renderProcEnvFace(face) {
    ensureProcEnvRig();
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(_procCubeRT, face);
    renderer.render(_procEnvScene, _procCubeCam.children[face]);
    renderer.setRenderTarget(prev);
  }
  function convolveProcEnv() {
    // REUSE the same PMREM RT every bake by passing it back into fromCubemap
    // (Three's own EnvironmentNode caches this exact way). The previous code
    // allocated a brand-new RT each convolve and disposed an old one — that
    // continuous allocate/destroy churn, while scene.environment is swapped and
    // still referenced by many materials + in-flight GPU work, eventually freed a
    // target the GPU was still using → "external Instance reference no longer
    // exists" device loss when dragging the time-of-day slider. One stable RT =
    // no churn, and its texture object never changes, so no consumer ever holds a
    // disposed handle.
    _procEnvRT = pmremGenerator.fromCubemap(_procCubeRT.texture, _procEnvRT);
    scene.environment = _procEnvRT.texture;
  }
  function disposeProcEnvRT() {
    if (_procEnvRT) {
      _procEnvRT.dispose();
      _procEnvRT = null;
    }
  }
  // Amortized scheduler — one face per frame, convolve on completion, then idle.
  // Runs while a change is pending OR auto-advance is on; otherwise sits idle.
  function updateProcEnvBake(dt) {
    if (_procEnvFace < 0) {
      if (!_procEnvNeeds && !toolState.proceduralSky.autoAdvance) return;
      _procEnvIdle -= dt;
      if (_procEnvIdle > 0) return;
      _procEnvNeeds = false;
      _procEnvFace = 0;
    }
    renderProcEnvFace(_procEnvFace);
    _procEnvFace++;
    if (_procEnvFace >= 6) {
      convolveProcEnv();
      _procEnvFace = -1;
      _procEnvIdle = PROC_ENV_IDLE;
    }
  }
  // Full synchronous bake — only for one-off events (mode switch, Rebake button)
  // where a single-frame cost is fine. Animation uses the amortized path above.
  function rebuildProceduralSkyEnv() {
    try {
      updateSunSky();
      driveProceduralSky(); // make sure dome uniforms are current before baking
      ensureProcEnvRig();
      for (let f = 0; f < 6; f++) renderProcEnvFace(f);
      convolveProcEnv();
      _procEnvFace = -1;
      _procEnvIdle = PROC_ENV_IDLE;
      _procEnvNeeds = false;
    } catch (err) {
      console.warn("[V2] PMREM from procedural sky failed; IBL disabled.", err);
    }
  }

  function applySkyMode(mode, prevMode) {
    // UI dropdowns set `skyMode` before onChange — pass `prevMode` from the caller.
    const prev = prevMode !== undefined ? prevMode : toolState.skyMode;
    let exposureChanged = false;
    if (prev !== mode) {
      toolState.skyExposureByMode[prev] = toolState.light.exposure;
      const nextExposure =
        toolState.skyExposureByMode[mode] ??
        (mode === "procedural" ? 0.7 : 0.5);
      if (toolState.light.exposure !== nextExposure) {
        toolState.light.exposure = nextExposure;
        exposureChanged = true;
      }
    }
    toolState.skyMode = mode;
    dayNightSky.mesh.visible = mode === "procedural";
    if (mode === "physical") {
      if (disposeHdrEnv) {
        disposeHdrEnv();
        disposeHdrEnv = null;
      }
      disposeProcEnvRT();
      sky.visible = true;
      scene.background = null;
      scene.backgroundIntensity = 1;
      rebuildSkyEnv();
    } else if (mode === "hdr") {
      sky.visible = false;
      disposeProcEnvRT();
      if (hdrTexture) {
        if (disposeSkyEnv) {
          disposeSkyEnv();
          disposeSkyEnv = null;
        }
        rebuildHdrEnv();
      } else {
        if (disposeHdrEnv) {
          disposeHdrEnv();
          disposeHdrEnv = null;
        }
        scene.background = null;
        scene.backgroundIntensity = 1;
        scene.environment = null;
      }
    } else if (mode === "procedural") {
      // The dome fills the view (renderOrder -2); SkyMesh + HDR off.
      sky.visible = false;
      if (disposeSkyEnv) {
        disposeSkyEnv();
        disposeSkyEnv = null;
      }
      if (disposeHdrEnv) {
        disposeHdrEnv();
        disposeHdrEnv = null;
      }
      scene.background = null;
      scene.backgroundIntensity = 1;
      rebuildProceduralSkyEnv();
    }
    updateSunSky();
    if (exposureChanged) {
      ui?.refreshLiveSliders?.();
      ui?.pane?.refresh?.();
    }
  }

  function importHdr() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".hdr";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      const url = URL.createObjectURL(file);
      const loader = new HDRLoader();
      loader.load(url, (tex) => {
        URL.revokeObjectURL(url);
        tex.mapping = THREE.EquirectangularReflectionMapping;
        if (hdrTexture) hdrTexture.dispose();
        hdrTexture = tex;
        hdrFileName = file.name;
        applySkyMode("hdr");
        ui?.pane.refresh();
      });
    };
    input.click();
  }

  const terrainStore = new TerrainStore(config);
  terrainStore.preloadChunksInRadius(0, 0, 4);

  const HTEX_RES = 512;
  const globalHeightTexData = new Float32Array(HTEX_RES * HTEX_RES * 4);
  const globalHeightTex = new THREE.DataTexture(
    globalHeightTexData,
    HTEX_RES,
    HTEX_RES,
    THREE.RGBAFormat,
    THREE.FloatType,
  );
  globalHeightTex.wrapS = globalHeightTex.wrapT = THREE.ClampToEdgeWrapping;
  globalHeightTex.minFilter = THREE.LinearFilter;
  globalHeightTex.magFilter = THREE.LinearFilter;
  globalHeightTex.needsUpdate = true;

  function rebuildGlobalHeightTexture() {
    const ws = config.world.size;
    for (let iz = 0; iz < HTEX_RES; iz++) {
      for (let ix = 0; ix < HTEX_RES; ix++) {
        const wx = ws * ((ix + 0.5) / HTEX_RES - 0.5);
        const wz = ws * ((iz + 0.5) / HTEX_RES - 0.5);
        const h = terrainStore.getWorldHeight(wx, wz);
        const i = (iz * HTEX_RES + ix) * 4;
        globalHeightTexData[i] = h;
        globalHeightTexData[i + 1] = 0;
        globalHeightTexData[i + 2] = 0;
        globalHeightTexData[i + 3] = 1;
      }
    }
    globalHeightTex.needsUpdate = true;
  }

  rebuildGlobalHeightTexture();
  let heightTexDirty = false;
  let lastHeightTexSyncMs = 0;

  const cliffU = createAutoCliffUniforms();

  /** Declared before async texture load so early callbacks do not hit TDZ. */
  let cliffBlendPack = null;

  const textureLibrary = createTextureLibrary();
  const propTextureLibrary = createPropTextureLibrary();
  let textureLibraryReady = false;
  textureLibrary
    .loadDefaultsAsync()
    .then(() => {
      textureLibraryReady = true;
      invalidateSurfaceMaterials();
      rebuildCliffBlendMaterial();
    })
    .catch((err) => console.warn("TextureLibrary defaults failed:", err));
  textureLibrary.addOnChange(({ kind }) => {
    if (typeof kind === "string" && kind.startsWith("map:")) {
      invalidateSurfaceMaterials();
    }
  });

  function syncCliffUniformsFromParams() {
    const ac = toolState.autoCliff;
    cliffU.uSlopeStart.value = ac.slopeStart;
    cliffU.uSlopeEnd.value = ac.slopeEnd;
    cliffU.uRockScale.value = ac.rockScale;
    cliffU.uRockBrightness.value = ac.rockBrightness;
    cliffU.uRockContrast.value = ac.rockContrast;
    cliffU.uRockTint.value.set(ac.rockTint).convertSRGBToLinear();
    cliffU.uRockNormalStr.value = ac.rockNormalStr;
    cliffU.uRockBlendSharp.value = ac.rockBlendSharp;
    cliffU.uRockRoughMul.value = ac.rockRoughMul;
    cliffU.uTriplanarSharp.value = ac.triplanarSharp;
  }

  function buildCliffDeps() {
    if (!toolState.autoCliffEnabled || !textureLibraryReady) return null;
    const slot = textureLibrary.getSlot(toolState.textureSlots.cliffSlotId);
    if (!slot) return null;
    return {
      heightTex: globalHeightTex,
      rockColorTex: slot.albedoTex,
      rockDataTex: slot.ormTex,
      cliffU,
      worldSize: config.world.size,
      worldHalf: config.world.size * 0.5,
      htexRes: HTEX_RES,
    };
  }

  const tileTerrainMaterial = createSharedTileMaterial();
  applyGroundTileFromToolState();
  const sharedGroundBundle = createGroundTslBundle(toolState.groundTsl);
  let proceduralTerrainBundle = null;
  let imageTexTerrainBundle = null;

  const splatStore = new SplatStore(config);
  const placeholderSplatTex = (() => {
    const d = new Uint8Array(1 * 1 * 2 * 4);
    const t = new THREE.DataArrayTexture(d, 1, 1, 2);
    t.format = THREE.RGBAFormat;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.minFilter = THREE.LinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.needsUpdate = true;
    return t;
  })();
  const placeholderHoleTex = (() => {
    const d = new Uint8Array([0, 0, 0, 0]);
    const t = new THREE.DataTexture(d, 1, 1, THREE.RGBAFormat);
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.minFilter = THREE.LinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.needsUpdate = true;
    return t;
  })();
  let tileHoleTexNode = null;
  let tileChunkHasHoleUniform = null;

  let _layerArrayAlbedo = null;
  let _layerArrayOrm = null;

  function buildSplatOverlay() {
    if (!textureLibraryReady) return null;
    const slots = toolState.paint.layerSlotIds.map((id) =>
      textureLibrary.getSlot(id),
    );
    if (slots.some((s) => !s)) return null;
    // Dispose previous array textures
    _layerArrayAlbedo?.dispose();
    _layerArrayOrm?.dispose();
    const { albedoArrayTex, ormArrayTex } = buildLayerArrayTextures(
      textureLibrary,
      toolState.paint.layerSlotIds,
    );
    _layerArrayAlbedo = albedoArrayTex;
    _layerArrayOrm = ormArrayTex;
    return createSplatOverlay(
      slots,
      config.world.chunkSize,
      config.world.size,
      albedoArrayTex,
      ormArrayTex,
    );
  }

  /** Returns both splatmap texture nodes from whichever surface material is active. */
  function getActiveSplatNodes() {
    let bundle = null;
    if (toolState.terrainSurface === "tsl" && proceduralTerrainBundle) {
      bundle = proceduralTerrainBundle;
    } else if (toolState.terrainSurface === "image" && imageTexTerrainBundle) {
      bundle = imageTexTerrainBundle;
    }
    if (!bundle) return null;
    return {
      node0: bundle.splatTexNode,
      node1: bundle.splat1TexNode,
      holeNode: bundle.holeTexNode,
      chunkHasHoleUniform: bundle.uChunkHasHole,
    };
  }

  function syncSoloLayer() {
    const v = toolState.paint.soloLayer;
    if (proceduralTerrainBundle?.uSoloLayer)
      proceduralTerrainBundle.uSoloLayer.value = v;
    if (imageTexTerrainBundle?.uSoloLayer)
      imageTexTerrainBundle.uSoloLayer.value = v;
  }

  function syncHeightBlend() {
    const hb = toolState.paint.heightBlend;
    const hc = toolState.paint.heightContrast;
    if (proceduralTerrainBundle?.uHeightBlend) {
      proceduralTerrainBundle.uHeightBlend.value = hb;
      proceduralTerrainBundle.uHeightContrast.value = hc;
    }
    if (imageTexTerrainBundle?.uHeightBlend) {
      imageTexTerrainBundle.uHeightBlend.value = hb;
      imageTexTerrainBundle.uHeightContrast.value = hc;
    }
  }

  function setupSplatSwapFromStore(mesh) {
    const prev = mesh.onBeforeRender;
    mesh.onBeforeRender = (
      renderer,
      scene,
      camera,
      geometry,
      material,
      group,
    ) => {
      if (prev) prev(renderer, scene, camera, geometry, material, group);
      const nodes = getActiveSplatNodes();
      const key = mesh.userData.chunkKey;
      const entry = splatStore.getChunkSplatByKey(key);
      const tex = entry?.combinedTex ?? placeholderSplatTex;
      const holeEntry = holeStore.getChunkByKey(key);
      const holeTex = holeEntry?.tex ?? placeholderHoleTex;
      const chunkHasHole = holeEntry?.hasAnyHole ? 1.0 : 0.0;
      if (nodes) {
        if (nodes.node0) nodes.node0.value = tex;
        if (nodes.node1) nodes.node1.value = tex;
        if (nodes.holeNode) nodes.holeNode.value = holeTex;
        if (nodes.chunkHasHoleUniform)
          nodes.chunkHasHoleUniform.value = chunkHasHole;
      }
      if (tileHoleTexNode) tileHoleTexNode.value = holeTex;
      if (tileChunkHasHoleUniform) tileChunkHasHoleUniform.value = chunkHasHole;
    };
  }

  const terrainMesher = new TerrainMesher(config);
  const chunkStream = new ChunkStreamManager({
    config,
    scene,
    terrainStore,
    mesher: terrainMesher,
    material: tileTerrainMaterial,
    perf,
    onChunkCreated: (mesh) => {
      setupSplatSwapFromStore(mesh);
    },
  });

  const borderMountains = new BorderMountains(config);
  borderMountains.setMaterial(tileTerrainMaterial);
  scene.add(borderMountains.group);

  function rebuildBorderMountains() {
    borderMountains.rebuild(terrainStore, toolState.borderMountains, (mesh) => {
      setupSplatSwapFromStore(mesh);
    });
  }

  function disposeProceduralBundle() {
    if (proceduralTerrainBundle) {
      proceduralTerrainBundle.material.dispose();
      proceduralTerrainBundle = null;
    }
  }
  function disposeImageTexBundle() {
    if (imageTexTerrainBundle) {
      imageTexTerrainBundle.material.dispose();
      imageTexTerrainBundle = null;
    }
  }
  function invalidateSurfaceMaterials() {
    disposeProceduralBundle();
    disposeImageTexBundle();
    applyTerrainSurfaceFromToolState();
  }

  function getProceduralTerrainBundle() {
    if (!proceduralTerrainBundle) {
      syncCliffUniformsFromParams();
      proceduralTerrainBundle = createV2ProceduralGroundMaterial(
        toolState.groundTsl,
        toolState.meadowTsl,
        buildCliffDeps(),
        buildSplatOverlay(),
        sharedGroundBundle,
      );
    }
    return proceduralTerrainBundle;
  }

  function getImageTexTerrainBundle() {
    if (!imageTexTerrainBundle) {
      syncCliffUniformsFromParams();
      const groundSlot = textureLibrary.getSlot(
        toolState.textureSlots.groundSlotId,
      );
      imageTexTerrainBundle = createV2ImageTexGroundMaterial(
        groundSlot,
        config.world.size,
        buildCliffDeps(),
        buildSplatOverlay(),
        toolState.meadowTsl,
      );
    }
    return imageTexTerrainBundle;
  }

  function syncProceduralTerrainTsl() {
    sharedGroundBundle.syncFromParams(toolState.groundTsl);
    const b = getProceduralTerrainBundle();
    b.syncMeadow(toolState.meadowTsl);
  }

  function applyTerrainSurfaceFromToolState() {
    let mat;
    if (toolState.terrainSurface === "tsl") {
      syncProceduralTerrainTsl();
      mat = getProceduralTerrainBundle().material;
    } else if (toolState.terrainSurface === "image") {
      mat = getImageTexTerrainBundle().material;
    } else {
      mat = tileTerrainMaterial;
    }
    chunkStream.setSharedMaterial(mat);
    borderMountains.setMaterial(mat);
    syncSoloLayer();
    syncHeightBlend();
  }

  /** Push toolState.groundTile into the default tile-grid material's live
   *  uniforms (scale, gradient, colors). Colors are stored sRGB and converted
   *  to linear in place. No-op visually until the editor sliders change them. */
  function applyGroundTileFromToolState() {
    const u = tileTerrainMaterial._tileUniforms;
    if (!u) return;
    const g = toolState.groundTile;
    u.textureScale.value = g.textureScale;
    u.gradientIntensity.value = g.gradientIntensity;
    u.gradientBias.value = g.gradientBias;
    u.tileColor.value.set(g.tileColor).convertSRGBToLinear();
    u.gridColor.value.set(g.gridColor).convertSRGBToLinear();
    u.gridLineColor.value.set(g.gridLineColor).convertSRGBToLinear();
  }

  function markHeightTexDirty() {
    heightTexDirty = true;
  }
  const billboardGrassStore = new BillboardGrassStore(config);
  const sculptBrushMask = new BrushMask();
  const sculptSystem = new SculptSystem({
    toolState,
    terrainStore,
    chunkStream,
    brushMask: sculptBrushMask,
    onHeightsChanged: () => {
      markHeightTexDirty();
      treeStore.syncAllHeights(terrainStore);
      foliageStore.syncAllHeights(terrainStore);
      billboardGrassStore.syncAllHeights(terrainStore);
      fleurSystem.syncHeights();
      ambientFxStore.syncHeights();
      leafFxStore.syncHeights();
      splineSystem?.syncGuardrailsToGround?.();
      splineSystem?.syncKerbsToGround?.();
      splineSystem?.syncLinearFeaturesToGround?.();
    },
  });
  const brushMask = new BrushMask();
  const paintSystem = new PaintSystem({
    toolState,
    splatStore,
    config,
    brushMask,
  });
  const holeStore = new HoleStore(config);
  const holeSystem = new HoleSystem({ toolState, holeStore, chunkStream });
  const holeOverlay = new HoleOverlay(scene, config);
  const caveStore = new CaveStore(scene);
  // Assigned once cliffBvh + grassManager + every store that contributes
  // triangles to the player BVH have been created (further down). The cave
  // system only ever invokes this in response to a user action (place /
  // remove / clear), so the reference is always populated by then.
  let rebakePlayerBvh = () => {};
  const caveSystem = new CaveSystem({
    toolState,
    caveStore,
    onRebakeBvh: () => rebakePlayerBvh(),
  });
  {
    const cs = float(config.world.chunkSize);
    tileHoleTexNode = texture(
      placeholderHoleTex,
      positionLocal.xz.div(cs).add(vec2(0.5, 0.5)),
    );
    tileChunkHasHoleUniform = uniform(0.0);
    tileTerrainMaterial.opacityNode = Fn(() => {
      const surfaceMask = float(1.0).sub(step(float(0.25), tileHoleTexNode.r));
      // Kill skirts inside hole-painted chunks (matches splatOverlay.holeMask).
      const aSkirt = attribute("aSkirt", "float");
      const skirtKill = float(1.0).sub(aSkirt.mul(tileChunkHasHoleUniform));
      return surfaceMask.mul(skirtKill);
    })();
    tileTerrainMaterial.alphaTest = 0.5;
    tileTerrainMaterial.transparent = false;
  }

  const treeStore = new TreeStore(config);
  const treeLodRenderer = new TreeLodRenderer(scene, config);
  const treeSystem = new TreeSystem({
    toolState,
    treeStore,
    terrainStore,
    config,
  });
  const foliageLodRenderer = new FoliageLodRenderer(scene, config);

  const foliageStore = new FoliageStore(config);
  const billboardRenderer = new BillboardRenderer(scene, config);
  const foliagePaintSystem = new FoliagePaintSystem({
    toolState,
    foliageStore,
    terrainStore,
    config,
  });

  for (let i = 0; i < toolState.foliageSlots.length; i++) {
    billboardRenderer.rebuildSlot(i, toolState.foliageSlots[i]);
  }

  const billboardGrassRenderer = new BillboardGrassRenderer(scene, config);
  const billboardGrassPaintSystem = new BillboardGrassPaintSystem({
    toolState,
    grassStore: billboardGrassStore,
    terrainStore,
    config,
  });
  for (let i = 0; i < toolState.billboardGrassSlots.length; i++) {
    const slot = toolState.billboardGrassSlots[i];
    if (slot.textureUrl) {
      slot.textureUrl = normalizeBillboardGrassTextureRef(slot.textureUrl);
    }
    billboardGrassRenderer.rebuildSlot(i, slot);
  }
  applyBillboardGrassSlotTextures(
    billboardGrassRenderer,
    toolState.billboardGrassSlots,
  ).catch(() => {});

  const grassManager = new GrassManager({ scene, camera, config });

  /** Hybrid GPU grass (toolState.grass.renderMode === "hybrid") — lazy:
   *  ~600k instances + SSBOs allocate only on first switch to hybrid.
   *  Same module as grass-lab.html; ring params proven there. Reads the
   *  SAME densityTex / terrainNormalTex / heightTex as Gemini, so paint
   *  tools, fill/clear and serialization work unchanged. */
  let hybridGrassRings = null;
  let _hybridGrassBuilding = false;
  async function ensureHybridGrassBuilt() {
    if (hybridGrassRings || _hybridGrassBuilding) return;
    _hybridGrassBuilding = true;
    try {
      const shared = {
        scene,
        renderer,
        heightTex: globalHeightTex,
        terrainNormalTex: grassManager.terrainNormalTex,
        densityTex: grassManager.densityTex,
        windTex: grassManager.windTex,
        specNoiseTex: grassManager.specNoiseTex,
        worldSize: config.world.size,
        gp: toolState.grass,
        groundColorAtWorldXZ: sharedGroundBundle.groundColorAtWorldXZ,
      };
      const rings = [
        new HybridGrassSystem({
          ...shared,
          name: "HybridNear",
          tileSize: 130,
          bladesPerSide: 512,
          outerR0: 36,
          outerR1: 62,
        }),
        new HybridGrassSystem({
          ...shared,
          // Gemini MID tier equivalent: thin crossed blades, full material,
          // 40–88m — without it the thin-grass look ends too close.
          name: "HybridMidThin",
          tileSize: 180,
          bladesPerSide: 384, // 147k ≈ 4.6/m² (Gemini MID density)
          segments: 3,
          innerR0: 36,
          innerR1: 56,
          outerR0: 70,
          outerR1: 88,
          crossFadeR0: 70,
          crossFadeR1: 88,
        }),
        new HybridGrassSystem({
          ...shared,
          name: "HybridMid",
          normalMode: "flat",
          crossed: false,
          tileSize: 440,
          bladesPerSide: 576, // 332k ≈ Gemini FAR tier density (1.7/m²)
          bladeWidth: 0.45,
          segments: 2,
          bladeHeightMul: 1.1,
          innerR0: 64,
          innerR1: 88,
          outerR0: 180,
          outerR1: 218,
        }),
        new HybridGrassSystem({
          ...shared,
          name: "HybridFar",
          normalMode: "flat",
          crossed: false,
          tileSize: 800,
          bladesPerSide: 384,
          bladeWidth: 0.7,
          segments: 1,
          bladeHeightMul: 1.2,
          innerR0: 175,
          innerR1: 215,
          outerR0: 360,
          outerR1: 398,
        }),
        // Cliff grass rings — sample the cliff surface textures instead of
        // terrain; enable-gated on grassManager._hasCliffData in the loop.
        new HybridGrassSystem({
          ...shared,
          name: "HybridCliffNear",
          tileSize: 130,
          bladesPerSide: 384,
          outerR0: 36,
          outerR1: 62,
          cliffMode: true,
          cliffHeightTex: grassManager.cliffHeightTex,
          cliffDensityTex: grassManager.cliffDensityTex,
        }),
        new HybridGrassSystem({
          ...shared,
          name: "HybridCliffMid",
          normalMode: "flat",
          crossed: false,
          tileSize: 440,
          bladesPerSide: 320,
          bladeWidth: 0.45,
          segments: 2,
          bladeHeightMul: 1.1,
          innerR0: 36,
          innerR1: 62,
          outerR0: 180,
          outerR1: 218,
          cliffMode: true,
          cliffHeightTex: grassManager.cliffHeightTex,
          cliffDensityTex: grassManager.cliffDensityTex,
        }),
      ];
      for (const ring of rings) {
        if (ring.group.name.startsWith("HybridCliff")) ring.isCliff = true;
      }
      for (const ring of rings) await ring.init(camera);
      hybridGrassRings = rings;
    } catch (err) {
      console.error("[HybridGrass] build failed:", err);
    } finally {
      _hybridGrassBuilding = false;
    }
  }

  const revoGrassSystem = new RevoGrassSystem({ scene, config });
  /** Shared gust cycle (revo-realms WindManager port) — one weather rhythm
   *  drives Gemini, Hybrid and Revo grass so the whole world breathes
   *  together: ambient calm → gust ramps → holds → decays. */
  const windGust = new WindGustManager();
  const snowSystem = new SnowSystem({ scene, config });
  const grassPaintSystem = new GrassPaintSystem({
    toolState,
    grassManager,
    config,
  });
  const revoGrassMaskPaintSystem = new RevoGrassMaskPaintSystem({
    toolState,
    mask: revoGrassSystem.mask,
    config,
  });
  const snowMaskPaintSystem = new SnowMaskPaintSystem({
    toolState,
    mask: snowSystem.mask,
    config,
  });
  const cliffGrassPaintSystem = new CliffGrassPaintSystem({
    toolState,
    grassManager,
    config,
  });
  const roadReflection = new RoadPlanarReflection({
    renderer,
    scene,
    camera,
    resScale: 0.75,
  });
  const roadSystem = new RoadSystem({
    scene,
    camera,
    toolState,
    getWorldHeight: (x, z) => terrainStore.getWorldHeight(x, z),
    reflectTex: roadReflection.texture,
    terrainStore,
    chunkStream,
  });
  const fullRoadSystem = new FullRoadSystem({
    scene,
    toolState,
    getWorldHeight: (x, z) => terrainStore.getWorldHeight(x, z),
    reflectTex: roadReflection.texture,
    terrainStore,
    chunkStream,
    graphMode: "fullRoad",
  });
  const smartRoadToolStateView = {};
  Object.defineProperty(smartRoadToolStateView, "fullRoad", {
    get: () => toolState.smartRoad,
  });
  Object.defineProperty(smartRoadToolStateView, "mode", {
    get: () => toolState.mode,
  });
  const smartRoadSystem = new FullRoadSystem({
    scene,
    toolState: smartRoadToolStateView,
    getWorldHeight: (x, z) => terrainStore.getWorldHeight(x, z),
    reflectTex: roadReflection.texture,
    terrainStore,
    chunkStream,
    useLabNetworkGeometry: true,
    graphMode: "smartRoad",
  });
  // Smart Road 2 — the lab's proven system as a parallel editor mode. Drapes on
  // raw terrain for now (vertical-easing/flatten conform is the next port stage).
  // Built alongside the old `smartRoad`; that one gets retired once this reaches parity.
  const smartRoad2System = new SmartRoadLabSystem({
    scene,
    getHeight: (x, z) => terrainStore.getWorldHeight(x, z),
    params: toolState.smartRoad2,
  });
  smartRoad2System.setEditActive(false); // roads visible everywhere; handles only in mode
  const sr2 = { dragNodeId: null, dragEdge: null };

  const riverSystem = new RiverSystem({
    scene,
    toolState,
    getWorldHeight: (x, z) => terrainStore.getWorldHeight(x, z),
  });
  const cliffStore = new CliffStore();
  const cliffInstancer = new CliffInstancer(scene, cliffStore);
  const cliffBvh = new CliffBvh(cliffStore);
  const cliffSystem = new CliffSystem({
    toolState,
    cliffStore,
    cliffInstancer,
    cliffBvh,
    terrainStore,
  });
  const cliffSlotToType = {};

  const propStore = new PropStore();
  const propInstancer = new PropInstancer(scene, propStore);
  const propSystem = new PropSystem({
    toolState,
    propStore,
    propInstancer,
    cliffBvh,
    terrainStore,
    config,
  });

  /**
   * Rebuild the material on a primitive slot from its current `materialId` + `triplanar` fields.
   * Used by `setPrimitiveMaterial`, `setPrimitiveTriplanar`, and the project load path.
   */
  function _rebuildPrimitiveMaterial(slotIdx) {
    const slot = toolState.propSlots[slotIdx];
    if (!slot || !slot.builtin) return false;
    const propMat = propTextureLibrary.getById(slot.materialId);
    if (!propMat) return false;
    const newMat = createMaterialForLibrary(propMat, {
      triplanar: !!slot.triplanar,
    });
    propInstancer.setTypeMaterial(slot.typeIdx, newMat);
    const type = propStore.types[slot.typeIdx];
    if (type) for (const e of type.entries) e.material = newMat;
    return true;
  }

  const livePropManager = new LivePropManager(scene, propStore);
  livePropManager.registerFactory("flag", (params) => createFlagProp(params));
  livePropManager.registerFactory("coin", (params) => createCoinProp(params));
  livePropManager.registerFactory("heart", (params) => createHeartProp(params));
  livePropManager.registerFactory("key", (params) => createKeyProp(params));

  const collectibleBurst = createCollectibleBurst(scene);
  const collectibleGizmo = createCollectibleGizmo(scene);
  const splineSystem = new SplineSystem({
    scene,
    toolState,
    config,
    terrainStore,
    chunkStream,
    treeStore,
    propStore,
    getWorldHeight: (x, z) => terrainStore.getWorldHeight(x, z),
    getRoadSegments: () => roadSystem.getSegmentsSnapshot(),
    onVolumesChange: () => rebuildInteriorVolumes(),
  });
  // Spline Road — dedicated, isolated solid-road mode (separate from spline).
  const splineRoadSystem = new SplineRoadSystem({
    scene,
    toolState,
    getWorldHeight: (x, z) => terrainStore.getWorldHeight(x, z),
  });
  function rebuildInteriorVolumes() {
    interiorRegistry.rebuild(splineSystem, caveStore, toolState.interior);
    syncInteriorUniforms();
  }
  caveStore.onChange(() => rebuildInteriorVolumes());
  rebuildInteriorVolumes();

  // Tunnel mode — composite macro over splineSystem (tube) + terrainStore
  // (mouth trenches) + holeStore (terrain membrane punch-out). One click-flow
  // creates a tunnel that is open, walkable and drivable through a mountain.
  const tunnelSystem = new TunnelSystem({
    scene,
    toolState,
    config,
    terrainStore,
    holeStore,
    chunkStream,
    splineSystem,
    // Reuse the sculpt pipeline's height-change fanout (heightTex, trees,
    // foliage, grass, actor snap — including the actorSystem wrapper added
    // later) by deferring to whatever sculptSystem.onHeightsChanged is at
    // call time.
    onHeightsChanged: () => sculptSystem.onHeightsChanged(),
    onRebakeBvh: () => rebakePlayerBvh(),
  });
  let propUiCallbacks = {};

  const cliffPaintMask = new CliffPaintMask(512);
  const cliffPaintSystem = new CliffPaintSystem({
    toolState,
    mask: cliffPaintMask,
    config,
  });

  function buildCliffBlendGroundDeps() {
    const worldSize = config.world.size;
    const surface = toolState.terrainSurface;
    if (surface === "image" && textureLibraryReady) {
      const groundSlot = textureLibrary.getSlot(
        toolState.textureSlots.groundSlotId,
      );
      if (groundSlot) {
        return { type: "image", groundSlot, worldSize };
      }
    }
    if (surface === "tsl") {
      return {
        type: "tsl",
        groundColorAtWorldXZ: sharedGroundBundle.groundColorAtWorldXZ,
      };
    }
    const tileUniforms = tileTerrainMaterial._tileUniforms;
    return {
      type: "tile",
      gridTex: getTileGridTexture(),
      tileUniforms,
    };
  }

  function syncCliffBlendPackUniforms() {
    if (!cliffBlendPack) return;
    const c = toolState.cliffs;
    cliffBlendPack.uCBSlopeLow.value = c.blendSlopeLow;
    cliffBlendPack.uCBSlopeHigh.value = c.blendSlopeHigh;
    cliffBlendPack.uCBNoiseScale.value = c.blendNoiseScale;
    cliffBlendPack.uCBNoiseStr.value = c.blendNoiseStr;
    cliffBlendPack.uCBGroundScale.value = c.blendGroundScale;
    cliffBlendPack.uCBGroundOffsetX.value = c.blendGroundOffsetX ?? 0;
    cliffBlendPack.uCBGroundOffsetZ.value = c.blendGroundOffsetZ ?? 0;
    cliffU.uRockScale.value = c.blendRockScale;
    cliffU.uRockBrightness.value = c.blendRockBrightness;
    cliffU.uRockContrast.value = c.blendRockContrast;
    cliffU.uTriplanarSharp.value = c.blendTriplanarSharp;
  }

  function disposeCliffBlendPack() {
    if (!cliffBlendPack) return;
    cliffBlendPack.material.dispose();
    cliffBlendPack = null;
  }

  function rebuildCliffBlendMaterial() {
    if (!textureLibraryReady) return;
    const slot = textureLibrary.getSlot(toolState.textureSlots.cliffSlotId);
    if (!slot) return;
    syncCliffUniformsFromParams();
    const c = toolState.cliffs;
    cliffU.uRockScale.value = c.blendRockScale;
    cliffU.uRockBrightness.value = c.blendRockBrightness;
    cliffU.uRockContrast.value = c.blendRockContrast;
    cliffU.uTriplanarSharp.value = c.blendTriplanarSharp;
    disposeCliffBlendPack();
    cliffBlendPack = createCliffInstancerBlendMaterial({
      worldSize: config.world.size,
      worldHalf: config.world.size * 0.5,
      rockColorTex: slot.albedoTex,
      rockDataTex: slot.ormTex,
      cliffU,
      cliffPaintTex: cliffPaintMask.texture,
      groundDeps: buildCliffBlendGroundDeps(),
    });
    syncCliffBlendPackUniforms();
    cliffInstancer.setMaterial(cliffBlendPack.material);
  }

  function getWorldHeight(x, z) {
    if (cliffBvh.baked) {
      const h = cliffBvh.sampleHeight(x, z);
      if (h != null) return h;
    }
    return terrainStore.getWorldHeight(x, z);
  }

  const transformControls = new TransformControls(camera, renderer.domElement);
  transformControls.setMode("translate");
  transformControls.enabled = false;
  transformControls.visible = false;
  scene.add(transformControls.getHelper());

  // Modes that share the single TransformControls instance. Used to gate
  // gizmo-only hotkeys (Q toggle, Shift snap) so they don't fire elsewhere.
  const GIZMO_MODES = new Set([
    "cliffs",
    "props",
    "actors",
    "water",
    "waterfall",
    "decals",
    "fullRoad",
    "smartRoad",
    "splineRoad",
  ]);

  // Single point of truth for shared gizmo settings (space + rotation snap).
  // Call after any gizmo state change so a fresh attach/setMode keeps the
  // user's preferences. `space` persists on the controls in three.js, but we
  // re-apply defensively because some flows toggle modes rapidly.
  let _gizmoShiftHeld = false;
  function applyGizmoSettings() {
    const g = toolState.gizmo;
    transformControls.setSpace(g.space === "local" ? "local" : "world");
    const snapDeg = _gizmoShiftHeld ? g.rotationSnapDeg : 0;
    transformControls.setRotationSnap(
      snapDeg > 0 ? (snapDeg * Math.PI) / 180 : null,
    );
  }
  applyGizmoSettings();
  fullRoadSystem.setTransformControls(transformControls);
  smartRoadSystem.setTransformControls(transformControls);
  splineRoadSystem.setGizmo(transformControls);
  const activeGraphRoadSystem = () =>
    toolState.mode === "smartRoad" ? smartRoadSystem : fullRoadSystem;
  const activeGraphRoadParams = () =>
    toolState.mode === "smartRoad" ? toolState.smartRoad : toolState.fullRoad;
  transformControls.addEventListener("change", () => {
    if (toolState.mode === "cliffs" && cliffInstancer.hasSelection) {
      cliffSystem.handleTransformChange();
    }
    if (toolState.mode === "props" && propInstancer.hasSelection) {
      propSystem.handleTransformChange();
    }
    if (toolState.mode === "decals" && decalSystem.selectedIndex >= 0) {
      const dd = decalSystem.decals[decalSystem.selectedIndex];
      if (dd && !dd.soloMesh) decalSystem.handleTransformChange();
    }
    if (toolState.mode === "splineRoad" && splineRoadSystem.selectedIdx >= 0) {
      splineRoadSystem.syncFromGizmo();
    }
    if (
      toolState.mode === "fullRoad" &&
      fullRoadSystem.selectedDecalId != null
    ) {
      fullRoadSystem.handleDecalTransformChange();
    }
    if (
      toolState.mode === "smartRoad" &&
      smartRoadSystem.selectedDecalId != null
    ) {
      smartRoadSystem.handleDecalTransformChange();
    }
  });
  transformControls.addEventListener("mouseDown", () => {
    controls.enabled = false;
  });
  transformControls.addEventListener("mouseUp", () => {
    controls.enabled = toolState.mode !== "play";
    if (toolState.mode === "cliffs") cliffSystem.handleTransformEnd();
    if (toolState.mode === "props") propSystem.handleTransformEnd();
    if (toolState.mode === "decals") decalSystem.handleTransformEnd();
    if (toolState.mode === "fullRoad") fullRoadSystem.handleDecalTransformEnd();
    if (toolState.mode === "smartRoad")
      smartRoadSystem.handleDecalTransformEnd();
    if (toolState.mode === "actors") actorSystem.handleTransformEnd();
    if (toolState.mode === "splineRoad") {
      splineRoadSystem.onGizmoDragEnd();
      ui?.pane.refresh();
    }
  });

  // ── Water system ──────────────────────────────────────────────────────────
  const waterStore = new WaterStore(scene);
  const waterMaterials = createWaterMaterials({
    heightTex: globalHeightTex,
    terrainSize: config.world.size,
  });
  const waterSystem = new WaterSystem({
    waterStore,
    waterMaterials,
    toolState,
    transformControls,
  });
  // Global map-covering LOD ocean (additive; independent of the placed bodies).
  const worldOcean = createWorldOcean({
    renderer,
    scene,
    heightTex: globalHeightTex,
    terrainSize: config.world.size,
  });
  let _oceanEnvRef = null; // track scene.environment changes to refresh ocean reflections
  const waterfallSystem = new WaterfallSystem({
    scene,
    toolState,
    transformControls,
  });
  const actorSystem = new ActorSystem({
    scene,
    toolState,
    getWorldHeight: (x, z) => terrainStore.getWorldHeight(x, z),
    transformControls,
    worldHalf: config.world.size * 0.5,
  });

  {
    const sculptHeightsChanged = sculptSystem.onHeightsChanged;
    sculptSystem.onHeightsChanged = () => {
      sculptHeightsChanged();
      actorSystem.snapAllToTerrain();
    };
  }

  // Single source of truth for the player BVH bake. Used by both the manual
  // rebake button (cliffs/props panel) and the cave system (auto-rebake on
  // every place/remove/clear/load). Adding a new store that contributes
  // collidable geometry? Append it to the array.
  rebakePlayerBvh = () => {
    cliffBvh.bake(terrainStore, config, [
      propStore,
      splineSystem,
      fullRoadSystem,
      smartRoadSystem,
      waterfallSystem,
      caveStore,
    ]);
    grassManager.rebuildCliffHeightTex(
      cliffBvh,
      terrainStore,
      config.world.size,
    );
    ui?.refreshCaveCount?.(caveStore.count());
  };
  const decalSystem = new DecalSystem({
    scene,
    toolState,
    transformControls,
    getWorldHeight,
    roadSystem,
    chunkStream,
  });
  let _appTimeSec = 0;

  const barrierStore = new BarrierStore(config);
  const barrierSystem = new BarrierSystem({ toolState, barrierStore, config });
  const barrierOverlay = new BarrierOverlay(scene, config);

  for (let i = 0; i < FLEUR_ALPHA_URLS.length; i++) {
    if (!FLEUR_ALPHA_URLS[i].startsWith("../")) {
      FLEUR_ALPHA_URLS[i] = "../" + FLEUR_ALPHA_URLS[i];
    }
  }
  const fleurSystem = createFleurSystem(scene, (x, z) =>
    terrainStore.getWorldHeight(x, z),
  );

  function syncFleurInteraction() {
    const fp = toolState.fleur;
    fleurSystem.setInteractionRadius(fp.interactRadius);
    fleurSystem.setInteractionStrength(fp.interactStrength);
    fleurSystem.setRepulseGain(fp.interactGain);
    fleurSystem.setWindAmp(fp.windAmp);
    fleurSystem.setWindSpeed(fp.windSpeed);
  }

  // ── Ambient FX system ──
  const ambientFxStore = createAmbientFxStore(
    scene,
    (x, z) => terrainStore.getWorldHeight(x, z),
    "../textures/",
  );
  ambientFxStore.setFlapSpeed(toolState.ambientFx.flapSpeed);
  ambientFxStore.setFlapAngle(toolState.ambientFx.flapAngle);
  ambientFxStore.setGlideRatio(toolState.ambientFx.glideRatio);
  ambientFxStore.setRingsVisible(false);

  // ── Leaf FX system ──
  const leafFxStore = createLeafFxStore(
    scene,
    (x, z) => terrainStore.getWorldHeight(x, z),
    "../textures/",
  );
  leafFxStore.setRingsVisible(false);
  syncLeafFxParams();

  function syncAmbientFxUniforms() {
    const afx = toolState.ambientFx;
    ambientFxStore.setFlapSpeed(afx.flapSpeed);
    ambientFxStore.setFlapAngle(afx.flapAngle);
    ambientFxStore.setGlideRatio(afx.glideRatio);
  }

  function syncLeafFxParams() {
    const afx = toolState.ambientFx;
    const p = leafFxStore.params;
    p.spawnHeight = afx.leafSpawnHeight;
    p.leafSize = afx.leafSize;
    p.gravity = afx.leafGravity;
    p.terminalVelocity = afx.leafTerminalVelocity;
    p.rotationSpeed = afx.leafRotationSpeed;
    p.airResistance = afx.leafAirResistance;
    p.windInfluence = afx.leafWindInfluence;
    p.globalScale = afx.leafScale;
    p.terrainFloorOffset = afx.leafFloorOffset;
    leafFxStore.setOpacity(afx.leafOpacity);
    leafFxStore.setLeafTint(0, afx.leafTint0);
    leafFxStore.setLeafTint(1, afx.leafTint1);
    leafFxStore.setLeafTint(2, afx.leafTint2);
  }

  function paintAmbientFxAt(wx, wz, erase) {
    const afx = toolState.ambientFx;
    if (afx.effectType === "leaves") {
      if (erase) {
        leafFxStore.removeInBrush(wx, wz, afx.emitterRadius);
      } else {
        leafFxStore.addInBrush(
          wx,
          wz,
          afx.emitterRadius,
          afx.density,
          afx.leafActiveType,
        );
      }
    } else {
      if (erase) {
        ambientFxStore.removeInBrush(wx, wz, afx.emitterRadius);
      } else {
        ambientFxStore.addInBrush(
          wx,
          wz,
          afx.emitterRadius,
          afx.effectType,
          afx.density,
        );
      }
    }
  }

  function paintFleurAt(wx, wz, erase) {
    const fp = toolState.fleur;
    const radius = toolState.brush.radius;
    if (erase) {
      fleurSystem.removeInBrush(wx, wz, radius);
    } else {
      fleurSystem.addInBrush(
        wx,
        wz,
        radius,
        fp.perStroke,
        fp.minSpacing,
        fp.scaleMin,
        fp.scaleMax,
        fp.hoverBase,
        fp.hoverVariance,
        fp.activeSlot,
        fp.subMode === "stem" ? "stem" : "ground",
        fp.bloomShape,
      );
    }
  }

  const audioSystem = createV2AudioSystem({ toolState });
  const collectibleSfx = createCollectibleSfx(audioSystem);
  const collectibleRuntime = createCollectibleRuntime({
    livePropManager,
    burst: collectibleBurst,
    playSfx: (kind) => collectibleSfx.play(kind),
  });
  const playMode = new PlayMode({
    scene,
    camera,
    renderer,
    controls,
    getWorldHeight,
    // `getTerrainHeight` drives the play-mode ground-collision test each frame
    // (player + car). Returning a sentinel far below the world when the (x,z)
    // is over a painted hole pixel makes the existing "is the player below
    // ground?" / "did they drop more than 0.4?" checks naturally fire, so the
    // character falls through holes without touching the playMode movement
    // code. `getWorldHeight` (used for spawn snaps, camera floor, plane AGL)
    // is left alone so we don't dump the player into the void on respawn /
    // mode switch / fly-over.
    getTerrainHeight: (x, z) =>
      holeStore.isHoleAt(x, z)
        ? HOLE_GROUND_SENTINEL
        : terrainStore.getWorldHeight(x, z),
    worldHalf: config.world.size * 0.5,
    cliffBvh,
    isBarrierBlocked: (wx, wz) => barrierStore.isBlocked(wx, wz),
    smokeSettings: toolState.playSmoke,
    carSettings: toolState.playCar,
    carAudioSettings: toolState.playCarAudio,
    spawnSettings: toolState.playSpawn,
    cameraCollisionSettings: toolState.playCamera,
    audioSystem,
    excludeFromReflection: (obj) => roadReflection.excludeFromReflection(obj),
    onSpawnChanged: () => _playSpawnChanged?.(),
    // Spline Road + Smart Road 2 decks baked into the stunt car's drive-surface BVH.
    getStuntRoadMeshes: () => [
      ...splineRoadSystem.getColliderMeshes(),
      ...smartRoad2System.getColliderMeshes(),
    ],
    // Side barriers baked into the stunt car's chassis-collision solids BVH.
    getStuntRoadSolidMeshes: () => splineRoadSystem.getSolidMeshes(),
  });

  const dialogueRunner = new DialogueRunner({
    toolState,
    actorSystem,
    playMode,
    camera,
    domElement: renderer.domElement,
  });
  dialogueRunner.attach();

  const gestureAudioUnlock = () => {
    audioSystem.unlock();
  };
  window.addEventListener("pointerdown", gestureAudioUnlock, {
    once: true,
    capture: true,
  });
  window.addEventListener("keydown", gestureAudioUnlock, {
    once: true,
    capture: true,
  });

  let _pendingPlayImmersive = false;

  /** Editor shell: fullscreen viewport vs keep chrome for tweaking. */
  function syncPlayEditorChrome(immersive) {
    const appEl = document.getElementById("app");
    if (immersive) {
      appEl?.classList.add("play-fullscreen");
    } else {
      appEl?.classList.remove("play-fullscreen");
    }
  }

  function applyModeChangedEffects() {
    if (toolState.mode !== "sculpt") {
      sculptSystem.clearRampPoint();
    }
    if (toolState.mode !== "paint" && toolState.paint.soloLayer >= 0) {
      toolState.paint.soloLayer = -1;
      syncSoloLayer();
    }
    // Paint mode no longer auto-switches `tile` → `tsl`. The TSL/image splat
    // shader is fragment-heavy (7 layer blends + height/normal blend + cliff)
    // and tanks FPS on weaker GPUs. Users that want to see paint results
    // visually can switch the Surface dropdown themselves; the painting still
    // writes splat data either way.
    if (toolState.mode === "grass" && !toolState.grass.enabled) {
      toolState.grass.enabled = true;
      grassManager.syncUniforms(toolState.grass, sunDir);
      ui?.pane.refresh();
    }
    if (toolState.mode === "revoGrass" && toolState.revoGrass.enabled) {
      revoGrassSystem.syncFromState(toolState.revoGrass, sunDir);
    }
    if (toolState.mode === "snow" && toolState.snow.enabled) {
      snowSystem.syncFromState(toolState.snow);
    }
    if (toolState.mode !== "splineRoad") {
      splineRoadSystem.detachGizmo(transformControls);
    }
    if (toolState.mode !== "cliffs") {
      deactivateCliffSelection();
    }
    if (toolState.mode !== "props") {
      deactivatePropSelection();
    }
    if (toolState.mode !== "water") {
      waterSystem.deselect();
    }
    if (toolState.mode !== "waterfall") {
      waterfallSystem.deselect();
    } else {
      transformControls.setMode(
        toolState.waterfall.transformMode || "translate",
      );
    }
    if (toolState.mode !== "actors") {
      actorSystem.deselect();
    } else {
      transformControls.setMode(toolState.actors.transformMode || "translate");
    }
    if (toolState.mode !== "decals") {
      decalSystem.deselect();
    } else {
      transformControls.setMode(toolState.decal.transformMode || "translate");
      if (decalSystem.selectedIndex >= 0) {
        decalSystem.selectByIndex(decalSystem.selectedIndex);
      }
    }
    if (toolState.mode !== "fullRoad" && toolState.mode !== "smartRoad") {
      fullRoadSystem.deselectDecal();
      fullRoadSystem._clearDecalPreview();
      smartRoadSystem.deselectDecal();
      smartRoadSystem._clearDecalPreview();
    } else if (
      activeGraphRoadParams().decalMode &&
      activeGraphRoadSystem().selectedDecalId != null
    ) {
      transformControls.setMode(
        activeGraphRoadParams().decalTransformMode || "translate",
      );
    }
    if (toolState.mode !== "spline") {
      splineSystem.dragging = false;
    }
    roadSystem.handleGroup.visible =
      toolState.mode === "road" && toolState.road.showHandles;
    fullRoadSystem.handleGroup.visible =
      toolState.mode === "fullRoad" && toolState.fullRoad.showHandles;
    smartRoadSystem.handleGroup.visible =
      toolState.mode === "smartRoad" && toolState.smartRoad.showHandles;
    riverSystem.handleGroup.visible =
      toolState.mode === "river" && toolState.river.showHandles;
    splineSystem.handleGroup.visible =
      toolState.mode === "spline" && toolState.spline.showHandles;
    if (toolState.mode !== "spline") splineSystem.clearPreview();
    if (toolState.mode !== "tunnel") tunnelSystem.cancelDraft();
    if (toolState.mode !== "splineRoad") splineRoadSystem.dragging = false;
    splineRoadSystem.syncVisibility();
    if (toolState.mode === "ambientfx") {
      ambientFxStore.setRingsVisible(toolState.ambientFx.showRings);
      leafFxStore.setRingsVisible(toolState.ambientFx.showRings);
    } else {
      ambientFxStore.setRingsVisible(false);
      leafFxStore.setRingsVisible(false);
    }
    if (toolState.mode === "play") {
      const immersive = _pendingPlayImmersive === true;
      _pendingPlayImmersive = false;
      actorSystem.deselect();
      actorSystem.enterPlayMode();
      playMode.enter({ editorRelaxedPointer: !immersive });
      dialogueRunner.end();
      collectibleRuntime.start();
      syncPlayEditorChrome(immersive);
      document.getElementById("play-stop-bar")?.classList.add("visible");
    } else if (playMode.active) {
      dialogueRunner.end();
      actorSystem.exitPlayMode();
      playMode.exit();
      collectibleRuntime.stop();
      syncPlayEditorChrome(false);
      document.getElementById("play-stop-bar")?.classList.remove("visible");
    }
    updateBrushPreviewFromPick(null);
    syncPlaySpawnMarker();
  }

  const hud = createHud();
  /**
   * Tweakpane has been fully replaced by the custom UI in `v2/editor.html`.
   * This stub preserves the `(_xxx = () => {...})` callback-assignment side
   * effects inside the big options literal below (so all module-level
   * `_callback` vars still get populated) while returning `null` so every
   * `ui?.pane.refresh()` and `ui?.refreshXxx?.()` call site short-circuits.
   */
  function createTweakpaneUi(_options) {
    return null;
  }
  let ui = null;
  let _saveProject, _loadProject;
  let _importTreeGlb,
    _loadTreePreset,
    _removeTreeSlot,
    _clearAllTrees,
    _treeCastShadowChanged,
    _foliageParamChanged;
  let _importPropGlb,
    _addPrimitive,
    _addLiveProp,
    _importGlbCollectible,
    _removePropSlot,
    _importPropLod,
    _propCastShadowChanged,
    _deleteSelectedProp,
    _duplicateSelectedProp,
    _clearAllProps,
    _propTransformModeChanged,
    _rebakeBvh;
  let _loadFoliageTexture,
    _foliageSlotStructureChanged,
    _foliageSlotMaterialChanged,
    _clearAllFoliage,
    _foliageLodChanged;
  let _loadBillboardGrassMask,
    _billboardGrassSlotStructureChanged,
    _billboardGrassSlotMaterialChanged,
    _clearAllBillboardGrass;
  let _playSpawnChanged,
    _barrierOverlayChanged,
    _barrierClear,
    _barrierFill,
    _holeOverlayChanged,
    _holeClear,
    _caveUndo,
    _caveRedo,
    _caveClear;
  let _ambientFxFlapChanged,
    _ambientFxRingsChanged,
    _ambientFxClear,
    _ambientFxLeafChanged,
    _ambientFxClearLeaves,
    _ambientFxLeafRespawn;
  let _fleurChanged,
    _fleurColorChanged,
    _fleurStemChanged,
    _fleurStemCurveChanged,
    _fleurInteractionChanged,
    _fleurClear;
  let _cliffGrassFill,
    _cliffGrassClear,
    _cliffPaintFill,
    _cliffPaintClear,
    _importCliffGlb,
    _removeCliffSlot,
    _deleteSelectedCliff,
    _clearAllCliffs,
    _cliffTransformModeChanged,
    _cliffBlendChanged;
  let _waterChanged,
    _saveWater,
    _loadWater,
    _deleteSelectedWater,
    _clearAllWater;
  let _waterfallChanged, _deleteSelectedWaterfall, _clearAllWaterfalls;
  let _actorsChanged,
    _deleteSelectedActor,
    _clearAllActors,
    _clearNpcs,
    _clearEnemies,
    _snapSelectedToTerrain,
    _actorsTransformModeChanged,
    _refreshActorsPanel;
  let _decalLoadImage,
    _decalOpacityChanged,
    _decalAlignChanged,
    _decalRefit,
    _decalDeleteSelected,
    _decalClearAll,
    _decalSaveJson,
    _decalLoadJson,
    _decalTransformModeChanged;
  let _riverChanged,
    _riverNewRiver,
    _riverDeleteActive,
    _riverDeleteSelected,
    _riverSelectedYChanged,
    _riverActiveIndexChanged;
  let _splineChanged,
    _splineDeleteSelected,
    _splineClearAll,
    _splineSelectedYChanged,
    _splineClosedChanged,
    _splinePreview,
    _splineBake,
    _splineClearPreview,
    _splineApplyPlateau,
    _splineClearTunnels,
    _splineClearLinearFeatures,
    _splineKerbSelect,
    _splineKerbApply,
    _splineKerbDelete,
    _splineKerbDuplicate,
    _splineKerbSuggestFromCurvature,
    _splineKerbLiveChanged;
  let _grassChanged,
    _grassRebuildGeos,
    _grassFill,
    _grassClear,
    _grassSaveDensity,
    _grassLoadDensity;
  let _revoGrassChanged, _revoGrassRebuild;
  let _snowChanged, _snowRebuild;
  let _terrainSurfaceChanged,
    _tslTerrainSync,
    _autoCliffEditorChanged,
    _cliffTextureSlotChanged,
    _groundTextureSlotChanged;
  ui = createTweakpaneUi({
    toolState,
    config,
    sculptSystem,
    perf,
    textureLibrary,
    brushMask,
    onConfigChanged: () => {
      chunkStream.update(camera.position);
    },
    onRebuildSkyEnv: rebuildSkyEnv,
    onSkyModeChanged: applySkyMode,
    onImportHdr: importHdr,
    onCsmEnabledChange: setCsmEnabled,
    onFogChange: syncFog,
    onInteriorChange: () => {
      syncInteriorUniforms();
      rebuildInteriorVolumes();
    },
    onGenerateProceduralTerrain: () => {
      sculptSystem.applyProceduralTerrainAllChunks();
      if (toolState.borderMountains.enabled) rebuildBorderMountains();
    },
    onRunGlobalErosion: () => sculptSystem.applyGlobalErosion(),
    onBorderMountainsRebuild: rebuildBorderMountains,
    onRampCleared: () => syncRampMarker(),
    onTerrainSurfaceChanged: (_terrainSurfaceChanged = () => {
      applyTerrainSurfaceFromToolState();
      rebuildCliffBlendMaterial();
      ui?.pane.refresh();
    }),
    onTslTerrainSync: (_tslTerrainSync = () => {
      syncProceduralTerrainTsl();
    }),
    onAutoCliffChanged: (_autoCliffEditorChanged = (kind) => {
      syncCliffUniformsFromParams();
      /**
       * Keep snow's slope rejection glued to auto-cliff when the link
       * toggle is on — one slider drives both, no drift.
       */
      const ac = toolState.autoCliff;
      snowSystem.applyCliffSlope(
        ac.slopeStart,
        ac.slopeEnd,
        !!toolState.snow.slopeLinkToCliff,
      );
      if (kind === "toggle") invalidateSurfaceMaterials();
    }),
    onCliffSlotChanged: (_cliffTextureSlotChanged = () => {
      invalidateSurfaceMaterials();
      rebuildCliffBlendMaterial();
    }),
    onGroundSlotChanged: (_groundTextureSlotChanged = () => {
      disposeImageTexBundle();
      if (toolState.terrainSurface === "image")
        applyTerrainSurfaceFromToolState();
      rebuildCliffBlendMaterial();
    }),
    onPlaySpawnChanged: (_playSpawnChanged = () => {
      syncPlaySpawnMarker();
    }),
    onRebuildCarAudio: () => {
      playMode.rebuildCarAudio();
    },
    onModeChanged: applyModeChangedEffects,
    onPaintLayersChanged: () => {
      invalidateSurfaceMaterials();
    },
    onPaintFill: () => paintSystem.fillWithActiveLayer(),
    onPaintClear: () => paintSystem.clearAll(),
    onSoloLayerChanged: () => syncSoloLayer(),
    onHeightBlendChanged: () => syncHeightBlend(),
    onImportTreeGlb: (_importTreeGlb = async (
      slotIdx,
      lod,
      preselectedFile = null,
    ) => {
      const file = preselectedFile ?? (await openGlbPicker());
      if (!file) return;
      try {
        const { submeshes, name } = await loadTreeGlbFromFile(file);
        treeLodRenderer.setSlotModel(
          slotIdx,
          lod,
          submeshes,
          toolState.treeLod.castShadow,
        );
        if (lod === 0) toolState.treeSlots[slotIdx].name = name;
        const matchedUrl = await probeModelsForFile(file.name);
        if (matchedUrl) {
          const slot = toolState.treeSlots[slotIdx];
          if (!slot.glbFile) slot.glbFile = {};
          slot.glbFile[lod === 0 ? "lod0" : "lod1"] = file.name;
          console.log(
            `[V2] Tree slot ${slotIdx} LOD${lod}: loaded ${submeshes.length} submesh(es) from ${file.name} — linked to ${matchedUrl}, will auto-restore on load`,
          );
        } else {
          console.warn(
            `[V2] Tree slot ${slotIdx} LOD${lod}: loaded ${submeshes.length} submesh(es) from ${file.name} — won't auto-restore on load. Put ${file.name} in /models to enable.`,
          );
        }
        ui?.pane.refresh();
      } catch (err) {
        console.error(
          `[V2] Failed to load GLB for slot ${slotIdx} LOD${lod}:`,
          err,
        );
      }
    }),
    onLoadTreePreset: (_loadTreePreset = async (
      slotIdx,
      preselectedFile = null,
    ) => {
      const handleFile = async (file) => {
        if (!file) return;
        try {
          const { foliagePreset, trunkSubmeshes, trunkLod1Submeshes, json } =
            await loadFullPresetFromFile(file);

          if (trunkSubmeshes) {
            treeLodRenderer.setSlotModel(
              slotIdx,
              0,
              trunkSubmeshes,
              toolState.treeLod.castShadow,
            );
            console.log(
              `[V2] Trunk LOD0 loaded: ${json.trunkFile} (${trunkSubmeshes.length} submesh)`,
            );
          }
          if (trunkLod1Submeshes) {
            treeLodRenderer.setSlotModel(
              slotIdx,
              1,
              trunkLod1Submeshes,
              toolState.treeLod.castShadow,
            );
            console.log(`[V2] Trunk LOD1 loaded: ${json.trunkLod1File}`);
          }

          foliageLodRenderer.setSlotPreset(slotIdx, foliagePreset);

          toolState.treeSlots[slotIdx].presetFile = file.name;
          toolState.treeSlots[slotIdx].name =
            json.presetName || file.name.replace(/\.json$/, "");
          if (json.trunkScale != null) {
            toolState.treeSlots[slotIdx].baseScale = json.trunkScale;
          }

          const f = toolState.treeSlots[slotIdx].foliage;
          const m = json.material || {};
          const w = json.wind || {};
          if (m.bottomColor) f.bottomColor = m.bottomColor;
          if (m.topColor) f.topColor = m.topColor;
          if (m.colorVar != null) f.colorVar = m.colorVar;
          if (m.treeColorVar != null) f.treeColorVar = m.treeColorVar;
          if (m.alphaCutoff != null) f.alphaCutoff = m.alphaCutoff;
          if (m.normalBias != null) f.normalBias = m.normalBias;
          if (m.leafWarp != null) f.leafWarp = m.leafWarp;
          if (m.aoStr != null) f.aoStr = m.aoStr;
          if (m.sssStr != null) f.sssStr = m.sssStr;
          if (m.sssPow != null) f.sssPow = m.sssPow;
          if (m.sssColor) f.sssColor = m.sssColor;
          if (m.rimStr != null) f.rimStr = m.rimStr;
          if (m.rimPow != null) f.rimPow = m.rimPow;
          if (m.rimColor) f.rimColor = m.rimColor;
          if (w.windSpeed != null) f.windSpeed = w.windSpeed;
          if (w.windStr != null) f.windStr = w.windStr;
          if (w.windMicro != null) f.windMicro = w.windMicro;

          ui?.pane.refresh();
          console.log(
            `[V2] Tree preset "${json.presetName}" loaded into slot ${slotIdx} (baseScale=${json.trunkScale ?? 1}, ${foliagePreset.lods[0]?.count ?? 0} leaves LOD0)`,
          );
        } catch (err) {
          console.error(
            `[V2] Failed to load tree preset for slot ${slotIdx}:`,
            err,
          );
        }
      };
      if (preselectedFile) {
        await handleFile(preselectedFile);
        return;
      }
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".json";
      input.onchange = async () => {
        const file = input.files?.[0];
        await handleFile(file);
      };
      input.click();
    }),
    onFoliageParamChanged: (_foliageParamChanged = (slotIdx) => {
      const preset = foliageLodRenderer.slotPresets[slotIdx];
      if (!preset) return;
      const f = toolState.treeSlots[slotIdx].foliage;
      const u = preset.uniforms;
      u.bottomColor.value.set(f.bottomColor);
      u.topColor.value.set(f.topColor);
      u.colorVar.value = f.colorVar;
      u.treeColorVar.value = f.treeColorVar;
      u.alphaCutoff.value = f.alphaCutoff;
      u.normalBias.value = f.normalBias;
      u.leafWarp.value = f.leafWarp;
      u.aoStr.value = f.aoStr;
      u.sssStr.value = f.sssStr;
      u.sssPow.value = f.sssPow;
      u.sssColor.value.set(f.sssColor);
      u.rimStr.value = f.rimStr;
      u.rimPow.value = f.rimPow;
      u.rimColor.value.set(f.rimColor);
      u.windSpeed.value = f.windSpeed;
      u.windStr.value = f.windStr;
      u.windMicro.value = f.windMicro;
    }),
    onRemoveTreeSlot: (_removeTreeSlot = (slotIdx) => {
      treeLodRenderer.disposeSlot(slotIdx);
      foliageLodRenderer.clearSlot(slotIdx);
      console.log(`[V2] Tree slot ${slotIdx} models removed`);
    }),
    onMassPlaceTrees: () => {
      const count = toolState.treePaint.massPlaceCount;
      treeSystem.massPlace(count);
    },
    onMassPlaceFoliage: () => {
      foliagePaintSystem.massPlace(toolState.foliagePaint.massPlaceCount);
    },
    onMassPlaceBillboardGrass: () => {
      billboardGrassPaintSystem.massPlace(
        toolState.billboardGrassPaint.massPlaceCount,
      );
    },
    onClearAllTrees: (_clearAllTrees = () => {
      treeSystem.clearAll();
    }),
    onTreeLodChanged: () => {},
    onFoliageLodChanged: (_foliageLodChanged = () => {}),
    onLoadFoliageTexture: (_loadFoliageTexture = async (
      slotIdx,
      preselectedFile = null,
    ) => {
      const handleFile = async (file) => {
        if (!file) return;
        const filename = file.name.split(/[/\\]/).pop();
        const slot = toolState.foliageSlots[slotIdx];
        const projectUrl = await probeFoliageTextureFile(filename);

        const applyTex = (tex, persist) => {
          if (persist) {
            delete slot.texturePreviewName;
            slot.textureUrl = normalizeFoliageTextureRef(filename);
            console.log(`[V2] Foliage slot ${slotIdx} ← ${slot.textureUrl}`);
          } else {
            slot.texturePreviewName = filename;
            console.log(
              `[V2] Foliage slot ${slotIdx} preview: ${filename} (copy to ${FOLIAGE_TEXTURE_DIR} to keep after save)`,
            );
          }
          billboardRenderer.setSlotTexture(slotIdx, tex, slot);
          document
            .getElementById("foliage-panel")
            ?._updateFoliageTextureLabel?.(slotIdx);
        };

        if (projectUrl) {
          new THREE.TextureLoader().load(projectUrl, (tex) => {
            tex.colorSpace = THREE.SRGBColorSpace;
            applyTex(tex, true);
          });
          return;
        }

        try {
          const tex = await loadFoliageTextureFromFile(file);
          applyTex(tex, false);
        } catch (err) {
          console.warn(
            `[V2] Foliage slot ${slotIdx}: could not load ${filename}`,
            err,
          );
        }
      };

      if (preselectedFile) {
        await handleFile(preselectedFile);
        return;
      }
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/*";
      input.onchange = async () => {
        const file = input.files?.[0];
        await handleFile(file);
      };
      input.click();
    }),
    onFoliageSlotStructureChanged: (_foliageSlotStructureChanged = (
      slotIdx,
    ) => {
      billboardRenderer.rebuildSlot(slotIdx, toolState.foliageSlots[slotIdx]);
    }),
    onFoliageSlotMaterialChanged: (_foliageSlotMaterialChanged = (slotIdx) => {
      const slot = toolState.foliageSlots[slotIdx];
      const sr = billboardRenderer.slotRender[slotIdx];
      if (sr?.textureObj) {
        billboardRenderer.setSlotTexture(slotIdx, sr.textureObj, slot);
      } else {
        billboardRenderer.updateSlotUniforms(slotIdx, slot);
      }
    }),
    onClearAllFoliage: (_clearAllFoliage = () => {
      foliagePaintSystem.clearAll();
    }),
    onLoadBillboardGrassMask: (_loadBillboardGrassMask = async (
      slotIdx,
      preselectedFile = null,
    ) => {
      const handleFile = async (file) => {
        if (!file) return;
        const filename = file.name.split(/[/\\]/).pop();
        const slot = toolState.billboardGrassSlots[slotIdx];
        const projectUrl = await probeBillboardGrassTextureFile(filename);

        const applyTex = (tex, persist) => {
          if (persist) {
            delete slot.texturePreviewName;
            slot.textureUrl = normalizeBillboardGrassTextureRef(filename);
            console.log(
              `[V2] Billboard grass slot ${slotIdx} ← ${slot.textureUrl}`,
            );
          } else {
            slot.texturePreviewName = filename;
            console.log(
              `[V2] Billboard grass slot ${slotIdx} preview: ${filename} (copy to ${BILLBOARD_GRASS_TEXTURE_DIR} or textures/foliage/ to keep after save)`,
            );
          }
          billboardGrassRenderer.setSlotTexture(slotIdx, tex, slot);
          document
            .getElementById("billboard-grass-panel")
            ?._updateBillboardGrassMaskLabel?.(slotIdx);
        };

        if (projectUrl) {
          new THREE.TextureLoader().load(projectUrl, (tex) => {
            tex.colorSpace = THREE.SRGBColorSpace;
            applyTex(tex, true);
          });
          return;
        }

        try {
          const tex = await loadBillboardGrassTextureFromFile(file);
          applyTex(tex, false);
        } catch (err) {
          console.warn(
            `[V2] Billboard grass slot ${slotIdx}: could not load ${filename}`,
            err,
          );
        }
      };

      if (preselectedFile) {
        await handleFile(preselectedFile);
        return;
      }
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/*";
      input.onchange = async () => {
        const file = input.files?.[0];
        await handleFile(file);
      };
      input.click();
    }),
    onBillboardGrassSlotStructureChanged: (_billboardGrassSlotStructureChanged =
      (slotIdx) => {
        billboardGrassRenderer.rebuildSlot(
          slotIdx,
          toolState.billboardGrassSlots[slotIdx],
        );
      }),
    onBillboardGrassSlotMaterialChanged: (_billboardGrassSlotMaterialChanged = (
      slotIdx,
    ) => {
      const slot = toolState.billboardGrassSlots[slotIdx];
      const sr = billboardGrassRenderer.slotRender[slotIdx];
      if (sr?.textureObj) {
        billboardGrassRenderer.setSlotTexture(slotIdx, sr.textureObj, slot);
      } else {
        billboardGrassRenderer.updateSlotUniforms(slotIdx, slot);
      }
    }),
    onClearAllBillboardGrass: (_clearAllBillboardGrass = () => {
      billboardGrassPaintSystem.clearAll();
    }),
    onGrassChanged: (_grassChanged = () => {
      grassManager.syncUniforms(toolState.grass, sunDir);
    }),
    onGrassRebuildGeos: (_grassRebuildGeos = () => {
      grassManager.syncUniforms(toolState.grass, sunDir);
      grassManager.rebuildGeometries(toolState.grass);
      if (hybridGrassRings) {
        rebuildHybridGrassGeometries(hybridGrassRings, toolState.grass);
      }
    }),
    onGrassFill: (_grassFill = () => {
      toolState.grass.enabled = true;
      grassManager.fillDensity();
      grassManager.syncUniforms(toolState.grass, sunDir);
      ui?.pane.refresh();
    }),
    onGrassClear: (_grassClear = () => {
      grassManager.clearDensity();
    }),
    onCliffGrassFill: (_cliffGrassFill = () => {
      toolState.grass.enabled = true;
      grassManager.fillCliffDensity();
      grassManager.syncUniforms(toolState.grass, sunDir);
      ui?.pane.refresh();
    }),
    onCliffGrassClear: (_cliffGrassClear = () => {
      grassManager.clearCliffDensity();
    }),
    onCliffPaintFill: (_cliffPaintFill = () => {
      cliffPaintMask.fillAll();
    }),
    onCliffPaintClear: (_cliffPaintClear = () => {
      cliffPaintMask.clearAll();
    }),
    onGrassSaveDensity: (_grassSaveDensity = () => {
      const data = grassManager.densityTex.image.data;
      const blob = new Blob([data.buffer], {
        type: "application/octet-stream",
      });
      downloadBlob(blob, "gemini-grass-density.bin");
    }),
    onGrassLoadDensity: (_grassLoadDensity = async () => {
      const file = await openFilePicker(".bin,image/png");
      if (!file) return;
      const buf = await file.arrayBuffer();
      const loaded = new Uint8Array(buf);
      const texData = grassManager.densityTex.image.data;
      texData.set(loaded.subarray(0, texData.length));
      grassManager.densityTex.needsUpdate = true;
      if (!toolState.grass.enabled) {
        toolState.grass.enabled = true;
        grassManager.syncUniforms(toolState.grass, sunDir);
        ui?.pane.refresh();
      }
    }),
    onRevoGrassChanged: (_revoGrassChanged = async () => {
      const rp = toolState.revoGrass;
      if (rp.enabled) {
        await revoGrassSystem.ensureBuilt(rp, sunDir);
        revoGrassSystem.syncFromState(rp, sunDir);
        await revoGrassSystem.precompile(renderer, camera);
      } else {
        revoGrassSystem.setEnabled(false);
      }
    }),
    onRevoGrassRebuild: (_revoGrassRebuild = async () => {
      const rp = toolState.revoGrass;
      if (!rp.enabled) return;
      await revoGrassSystem.rebuild(rp, sunDir);
      revoGrassSystem.syncFromState(rp, sunDir);
      await revoGrassSystem.precompile(renderer, camera);
    }),
    onSnowChanged: (_snowChanged = async () => {
      const sp = toolState.snow;
      if (sp.enabled) {
        await snowSystem.ensureBuilt(sp);
        snowSystem.syncFromState(sp);
        /**
         * `syncFromState` leaves slopeMin/Max alone when the link is on, so
         * push cliff values here to cover the link-toggle-on transition.
         */
        const ac = toolState.autoCliff;
        snowSystem.applyCliffSlope(
          ac.slopeStart,
          ac.slopeEnd,
          !!sp.slopeLinkToCliff,
        );
        await snowSystem.precompile(renderer, camera);
      } else {
        snowSystem.setEnabled(false);
      }
    }),
    onSnowRebuild: (_snowRebuild = async () => {
      const sp = toolState.snow;
      if (!sp.enabled) return;
      await snowSystem.rebuild(sp);
      snowSystem.syncFromState(sp);
      await snowSystem.precompile(renderer, camera);
    }),
    onTreeCastShadowChanged: (_treeCastShadowChanged = () => {
      for (let i = 0; i < toolState.treeSlots.length; i++) {
        treeLodRenderer.setCastShadow(i, toolState.treeLod.castShadow);
      }
    }),
    onImportCliffGlb: (_importCliffGlb = async (
      slotIdx,
      preselectedFile = null,
    ) => {
      rebuildCliffBlendMaterial();
      const file = preselectedFile ?? (await openGlbPicker());
      if (!file) return;
      try {
        const { submeshes, name } = await loadTreeGlbFromFile(file);
        const gltfScene = new THREE.Group();
        for (const sm of submeshes) {
          const mesh = new THREE.Mesh(sm.geometry, sm.material);
          mesh.applyMatrix4(sm.localMatrix);
          gltfScene.add(mesh);
        }
        const typeIdx = cliffStore.registerType(gltfScene, name);
        if (typeIdx >= 0) {
          cliffInstancer.onTypeRegistered(typeIdx);
          if (cliffBlendPack)
            cliffInstancer.setMaterial(cliffBlendPack.material);
          cliffSlotToType[slotIdx] = typeIdx;
          toolState.cliffSlots[slotIdx].name = name;
          toolState.cliffSlots[slotIdx].loaded = true;
          toolState.cliffs.activeSlot = slotIdx;
          console.log(
            `[V2] Cliff slot ${slotIdx} "${name}" loaded (${submeshes.length} submeshes)`,
          );
        }
        ui?.pane.refresh();
      } catch (err) {
        console.error("[V2] Failed to load cliff GLB:", err);
      }
    }),
    onRemoveCliffSlot: (_removeCliffSlot = (slotIdx) => {
      delete cliffSlotToType[slotIdx];
      toolState.cliffSlots[slotIdx].loaded = false;
      toolState.cliffSlots[slotIdx].name = `Cliff ${slotIdx + 1}`;
      ui?.pane.refresh();
      console.log(`[V2] Cliff slot ${slotIdx} cleared`);
    }),
    onDeleteSelectedCliff: (_deleteSelectedCliff = () =>
      cliffSystem.handleDelete()),
    onClearAllCliffs: (_clearAllCliffs = () => cliffSystem.clearAll()),
    onRebakeBvh: (_rebakeBvh = () => rebakePlayerBvh()),
    onCliffTransformModeChanged: (_cliffTransformModeChanged = () => {
      transformControls.setMode(toolState.cliffs.transformMode);
    }),
    onRoadChanged: () => {
      roadSystem.saveActiveStyle();
      roadSystem.syncMaterial();
      roadSystem.rebuildAllMeshes();
      ui?.pane.refresh();
    },
    onRoadNewRoad: () => roadSystem.startNewRoad(),
    onRoadDeleteActive: () => {
      roadSystem.deleteActiveRoad();
      ui?.pane.refresh();
    },
    onRoadDeleteSelected: () => {
      roadSystem.deleteSelected();
      ui?.pane.refresh();
    },
    onRoadSnapY: () => {
      roadSystem.snapSelectedYToTerrain();
      ui?.pane.refresh();
    },
    onRoadFlattenTerrain: () => {
      roadSystem.flattenTerrainUnderRoads();
      roadSystem.rebuildAllMeshes();
      markHeightTexDirty();
      treeStore.syncAllHeights(terrainStore);
      foliageStore.syncAllHeights(terrainStore);
      billboardGrassStore.syncAllHeights(terrainStore);
      splineSystem.syncGuardrailsToGround();
      splineSystem.syncKerbsToGround();
      splineSystem.syncLinearFeaturesToGround();
      ui?.pane.refresh();
    },
    onRoadApplyStabilityPreset: () => {
      const rp = toolState.road;
      rp.heightOffset = 0.15;
      rp.adaptiveLift = true;
      rp.slopeLift = 0.35;
      rp.liftMax = 0.6;
      roadSystem.syncMaterial();
      roadSystem.rebuildAllMeshes();
      ui?.pane.refresh();
    },
    onFullRoadChanged: () => {
      const sys = activeGraphRoadSystem();
      sys.syncMaterial();
      sys.rebuildAllMeshes();
      sys._rebuildHandles();
      ui?.pane.refresh();
    },
    onFullRoadStartBranch: () => {
      activeGraphRoadSystem().startBranch();
      ui?.pane.refresh();
    },
    onFullRoadDeleteSelected: () => {
      activeGraphRoadSystem().deleteSelected();
      ui?.pane.refresh();
    },
    onFullRoadClearAll: () => {
      activeGraphRoadSystem().clearAll();
      ui?.pane.refresh();
    },
    onFullRoadSnapY: () => {
      activeGraphRoadSystem().snapSelectedYToTerrain();
      ui?.pane.refresh();
    },
    onFullRoadSelectedYChanged: () => {
      activeGraphRoadSystem().setSelectedPointY(
        activeGraphRoadParams().selectedPointY,
      );
      ui?.pane.refresh();
    },
    onFullRoadToggleJunction: () => {
      activeGraphRoadSystem().toggleSelectedJunction();
      ui?.pane.refresh();
    },
    onFullRoadFlattenTerrain: () => {
      const sys = activeGraphRoadSystem();
      sys.flattenTerrainUnderRoads();
      sys.rebuildAllMeshes();
      markHeightTexDirty();
      treeStore.syncAllHeights(terrainStore);
      foliageStore.syncAllHeights(terrainStore);
      billboardGrassStore.syncAllHeights(terrainStore);
      splineSystem.syncGuardrailsToGround();
      splineSystem.syncKerbsToGround();
      splineSystem.syncLinearFeaturesToGround();
      ui?.pane.refresh();
    },
    onFullRoadApplyCityPreset: () => {
      const rp = activeGraphRoadParams();
      rp.width = 12;
      rp.heightOffset = 0.08;
      rp.junctionRadius = 10;
      rp.centerLine = true;
      rp.centerLineDashed = true;
      rp.doubleCenterLine = false;
      rp.laneLines = false;
      rp.lineWidth = 0.025;
      rp.colorBrightness = 0.65;
      rp.texScale = 3.0;
      const sys = activeGraphRoadSystem();
      sys.syncMaterial();
      sys.rebuildAllMeshes();
      sys._rebuildHandles();
      ui?.pane.refresh();
    },
    onSmartRoadEdgeStylePatch: (patch) => {
      smartRoadSystem.mergeSelectedEdgeStyle(patch);
      ui?.pane.refresh();
    },
    onSmartRoadEdgeStyleClear: () => {
      smartRoadSystem.clearSelectedEdgeStyle();
      ui?.pane.refresh();
    },
    onAccessoryTypeChanged: () => {
      activeGraphRoadSystem().cancelAccessoryPaint();
      ui?.pane.refresh();
    },
    onAccessoryParamsChanged: () => {
      activeGraphRoadSystem().rebuildAllAccessories();
      ui?.pane.refresh();
    },
    onAccessoryClearAll: () => {
      activeGraphRoadSystem().clearAllAccessories();
      ui?.pane.refresh();
    },
    onDecalModeToggle: () => {
      if (!activeGraphRoadParams().decalMode) {
        const sys = activeGraphRoadSystem();
        sys._clearDecalPreview();
        sys.deselectDecal();
      }
      ui?.pane.refresh();
    },
    onDecalTransformModeChanged: () => {
      if (activeGraphRoadSystem().selectedDecalId != null) {
        transformControls.setMode(activeGraphRoadParams().decalTransformMode);
      }
    },
    onDecalDeleteSelected: () => {
      activeGraphRoadSystem().deleteSelectedDecal();
      ui?.pane.refresh();
    },
    onDecalTypeChanged: () => {
      ui?.pane.refresh();
    },
    onDecalParamsChanged: () => {
      activeGraphRoadSystem().rebuildAllDecals();
      ui?.pane.refresh();
    },
    onDecalClearAll: () => {
      activeGraphRoadSystem().clearAllDecals();
      ui?.pane.refresh();
    },
    onRiverChanged: (_riverChanged = () => {
      riverSystem.syncMaterial();
      riverSystem.rebuildAllMeshes();
      ui?.pane.refresh();
    }),
    onRiverNewRiver: (_riverNewRiver = () => riverSystem.startNewRiver()),
    onRiverDeleteActive: (_riverDeleteActive = () => {
      riverSystem.deleteActiveRiver();
      ui?.pane.refresh();
    }),
    onRiverDeleteSelected: (_riverDeleteSelected = () => {
      riverSystem.deleteSelected();
      ui?.pane.refresh();
    }),
    onRiverSelectedYChanged: (_riverSelectedYChanged = () =>
      riverSystem.setSelectedPointY(toolState.river.selectedPointY)),
    onRiverActiveIndexChanged: (_riverActiveIndexChanged = () => {
      riverSystem._clampActive();
      riverSystem.selectedIdx = -1;
      riverSystem._rebuildVisual();
      ui?.pane.refresh();
    }),
    onRoadSelectedYChanged: () =>
      roadSystem.setSelectedPointY(toolState.road.selectedPointY),
    onRoadStyleSectionChanged: () => {
      roadSystem._clampActiveStyleSection();
      roadSystem.loadActiveStyle();
      ui?.pane.refresh();
    },
    onRoadNewStyleSection: () => {
      roadSystem.createStyleSectionAtSelected();
      ui?.pane.refresh();
    },
    onRoadDeleteStyleSection: () => {
      roadSystem.deleteActiveStyleSection();
      ui?.pane.refresh();
    },
    onRoadFlattenTerrain: () => {
      roadSystem.flattenTerrainUnderRoads();
      roadSystem.rebuildAllMeshes();
      markHeightTexDirty();
      treeStore.syncAllHeights(terrainStore);
      foliageStore.syncAllHeights(terrainStore);
      billboardGrassStore.syncAllHeights(terrainStore);
      splineSystem.syncGuardrailsToGround();
      splineSystem.syncKerbsToGround();
      splineSystem.syncLinearFeaturesToGround();
      ui?.pane.refresh();
    },
    onRoadActiveIndexChanged: () => {
      roadSystem._clampActive();
      toolState.road.activeStyleSectionIndex = 0;
      roadSystem.selectedIdx = -1;
      roadSystem.loadActiveStyle();
      roadSystem._rebuildVisual();
      ui?.pane.refresh();
    },
    onSplineChanged: (_splineChanged = () => {
      splineSystem._rebuildVisual();
      ui?.pane.refresh();
    }),
    onSplineDeleteSelected: (_splineDeleteSelected = () => {
      splineSystem.deleteSelected();
      ui?.pane.refresh();
    }),
    onSplineClearAll: (_splineClearAll = () => {
      splineSystem.clearAll();
      ui?.pane.refresh();
    }),
    onSplineSelectedYChanged: (_splineSelectedYChanged = () => {
      splineSystem.setSelectedPointY(toolState.spline.selectedPointY);
      ui?.pane.refresh();
    }),
    onSplineClosedChanged: (_splineClosedChanged = () => {
      splineSystem.setClosed(toolState.spline.closed);
      ui?.pane.refresh();
    }),
    onSplinePreview: (_splinePreview = () => splineSystem.preview()),
    onSplineBake: (_splineBake = () => {
      splineSystem.bakePlacement();
      ui?.pane.refresh();
    }),
    onSplineClearPreview: (_splineClearPreview = () =>
      splineSystem.clearPreview()),
    onSplineApplyPlateau: (_splineApplyPlateau = () => {
      const changed = splineSystem.applyPlateau();
      if (!changed) return;
      markHeightTexDirty();
      treeStore.syncAllHeights(terrainStore);
      foliageStore.syncAllHeights(terrainStore);
      billboardGrassStore.syncAllHeights(terrainStore);
      splineSystem.syncGuardrailsToGround();
      splineSystem.syncKerbsToGround();
      splineSystem.syncLinearFeaturesToGround();
      ui?.pane.refresh();
    }),
    onSplineClearTunnels: (_splineClearTunnels = () => {
      splineSystem.clearTunnels();
      ui?.pane.refresh();
    }),
    onSplineClearLinearFeatures: (_splineClearLinearFeatures = () => {
      splineSystem.clearLinearFeatures();
      ui?.pane.refresh();
    }),
    onSplineKerbSelect: (_splineKerbSelect = () => {
      splineSystem.selectActiveKerb();
      ui?.pane.refresh();
    }),
    onSplineKerbApply: (_splineKerbApply = () => {
      splineSystem.syncActiveKerbFromToolState();
      ui?.pane.refresh();
    }),
    onSplineKerbDelete: (_splineKerbDelete = () => {
      splineSystem.deleteActiveKerb();
      ui?.pane.refresh();
    }),
    onSplineKerbDuplicate: (_splineKerbDuplicate = () => {
      splineSystem.duplicateActiveKerb();
      ui?.pane.refresh();
    }),
    onSplineKerbSuggestFromCurvature: (_splineKerbSuggestFromCurvature = () => {
      splineSystem.suggestKerbFromRoadCurvature();
      ui?.pane.refresh();
    }),
    onSplineKerbLiveChanged: (_splineKerbLiveChanged = (changedKey) => {
      if (changedKey === "activeKerbIndex") {
        splineSystem.selectActiveKerb();
        ui?.pane.refresh();
        return;
      }
      if (!toolState.spline.kerbAutoApplyActive) return;
      splineSystem.syncActiveKerbFromToolState();
    }),
    onCliffBlendChanged: (_cliffBlendChanged = () => {
      syncCliffBlendPackUniforms();
    }),
    onImportPropGlb: (_importPropGlb = async (preselectedFile = null) => {
      const file = preselectedFile ?? (await openGlbPicker());
      if (!file) return;
      try {
        const { submeshes, name } = await loadTreeGlbFromFile(file);
        const gltfScene = new THREE.Group();
        for (const sm of submeshes) {
          const mesh = new THREE.Mesh(sm.geometry, sm.material);
          mesh.applyMatrix4(sm.localMatrix);
          gltfScene.add(mesh);
        }
        const typeIdx = propStore.registerType(gltfScene, name);
        if (typeIdx >= 0) {
          propInstancer.onTypeRegistered(typeIdx);
          const matchedUrl = await probeModelsForFile(file.name);
          const slotIdx = toolState.propSlots.length;
          toolState.propSlots.push({
            name,
            loaded: true,
            typeIdx,
            ...(matchedUrl ? { glbFile: file.name } : {}),
          });
          toolState.props.activeSlot = slotIdx;
          propUiCallbacks._rebuildPropUi?.();
          if (matchedUrl) {
            console.log(
              `[V2] Prop "${name}" imported (type ${typeIdx}, ${submeshes.length} submeshes) — linked to ${matchedUrl}, will auto-restore on load`,
            );
          } else {
            console.warn(
              `[V2] Prop "${name}" imported (type ${typeIdx}, ${submeshes.length} submeshes) — won't auto-restore on load. Put ${file.name} in /models to enable.`,
            );
          }
        }
        ui?.pane.refresh();
      } catch (err) {
        console.error("[V2] Failed to load prop GLB:", err);
      }
    }),
    onAddPrimitive: (_addPrimitive = (primitiveName) => {
      const existing = toolState.propSlots.find(
        (s) => s.name === primitiveName && s.builtin,
      );
      if (existing) {
        toolState.props.activeSlot = toolState.propSlots.indexOf(existing);
        ui?.pane.refresh();
        return;
      }
      const defs = {
        Cube: () => new THREE.BoxGeometry(1, 1, 1),
        Sphere: () => new THREE.SphereGeometry(0.5, 32, 16),
        Cylinder: () => new THREE.CylinderGeometry(0.5, 0.5, 1, 32),
        Plane: () => new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
        Cone: () => new THREE.ConeGeometry(0.5, 1, 32),
        Torus: () => new THREE.TorusGeometry(0.4, 0.15, 16, 32),
        "Jump ramp": () => createJumpRampGeometry(),
      };
      const factory = defs[primitiveName];
      if (!factory) return;
      const geometry = factory();
      const defaultPropMat =
        propTextureLibrary.getById("__none__") ??
        propTextureLibrary.getByIndex(0);
      const material = createMaterialForLibrary(defaultPropMat, {
        triplanar: false,
      });
      const typeIdx = propStore.registerPrimitive(
        primitiveName,
        geometry,
        material,
      );
      if (typeIdx >= 0) {
        propInstancer.onTypeRegistered(typeIdx);
        const slotIdx = toolState.propSlots.length;
        toolState.propSlots.push({
          name: primitiveName,
          loaded: true,
          typeIdx,
          builtin: true,
          materialId: defaultPropMat?.id ?? "__none__",
          triplanar: false,
        });
        toolState.props.activeSlot = slotIdx;
        propUiCallbacks._rebuildPropUi?.();
        console.log(
          `[V2] Primitive "${primitiveName}" added (type ${typeIdx})`,
        );
      }
      ui?.pane.refresh();
    }),
    onAddLiveProp: (_addLiveProp = (livePropName) => {
      const defs = {
        Flag: {
          factoryId: "flag",
          defaults: FLAG_DEFAULTS,
          bbox: flagBoundingBox,
        },
        Coin: {
          factoryId: "coin",
          defaults: COIN_DEFAULTS,
          bbox: coinBoundingBox,
        },
        Heart: {
          factoryId: "heart",
          defaults: HEART_DEFAULTS,
          bbox: heartBoundingBox,
        },
        Key: { factoryId: "key", defaults: KEY_DEFAULTS, bbox: keyBoundingBox },
      };
      const def = defs[livePropName];
      if (!def) return;

      const existing = toolState.propSlots.find(
        (s) => s.name === livePropName && s.live,
      );
      if (existing) {
        toolState.props.activeSlot = toolState.propSlots.indexOf(existing);
        ui?.pane.refresh();
        return;
      }

      const bbox = def.bbox(def.defaults);
      const typeIdx = propStore.registerLiveType(
        livePropName,
        def.factoryId,
        def.defaults,
        bbox,
      );
      propInstancer.onTypeRegistered(typeIdx);
      const slotIdx = toolState.propSlots.length;
      toolState.propSlots.push({
        name: livePropName,
        loaded: true,
        typeIdx,
        live: true,
        factoryId: def.factoryId,
      });
      toolState.props.activeSlot = slotIdx;
      propUiCallbacks._rebuildPropUi?.();
      console.log(`[V2] Live prop "${livePropName}" added (type ${typeIdx})`);
      ui?.pane.refresh();
    }),
    onImportGlbCollectible: (_importGlbCollectible = async (
      preselectedFile = null,
    ) => {
      const file = preselectedFile ?? (await openGlbPicker());
      if (!file) return;
      try {
        const { submeshes, name } = await loadTreeGlbFromFile(file);
        const gltfScene = new THREE.Group();
        for (const sm of submeshes) {
          const mesh = new THREE.Mesh(sm.geometry, sm.material);
          mesh.applyMatrix4(sm.localMatrix);
          gltfScene.add(mesh);
        }
        const kindDef = registerGlbCollectibleKind(name, gltfScene, {
          pickupRadius: 1.5,
          burstColor: "#ffd56a",
          spinSpeed: 1.2,
          bobAmp: 0.15,
          bobSpeed: 1.4,
        });
        livePropManager.registerFactory(kindDef.factoryId, kindDef.create);

        const bbox = kindDef.boundingBox();
        const typeIdx = propStore.registerLiveType(
          kindDef.name,
          kindDef.factoryId,
          kindDef.defaults,
          bbox,
        );
        propInstancer.onTypeRegistered(typeIdx);
        const slotIdx = toolState.propSlots.length;
        toolState.propSlots.push({
          name: kindDef.name,
          loaded: true,
          typeIdx,
          live: true,
          factoryId: kindDef.factoryId,
          collectible: true,
        });
        toolState.props.activeSlot = slotIdx;
        propUiCallbacks._rebuildPropUi?.();
        console.log(
          `[V2] GLB collectible "${kindDef.name}" imported (type ${typeIdx}, kind "${kindDef.kind}", ${submeshes.length} submeshes)`,
        );
        ui?.pane.refresh();
      } catch (err) {
        console.error("[V2] Failed to load GLB collectible:", err);
      }
    }),
    onRemovePropSlot: (_removePropSlot = (slotIdx) => {
      toolState.propSlots.splice(slotIdx, 1);
      if (toolState.props.activeSlot >= toolState.propSlots.length) {
        toolState.props.activeSlot = Math.max(
          0,
          toolState.propSlots.length - 1,
        );
      }
      ui?.pane.refresh();
      console.log(`[V2] Prop slot ${slotIdx} removed`);
    }),
    onImportPropLod: (_importPropLod = async (
      slotIdx,
      lod,
      preselectedFile = null,
    ) => {
      const file = preselectedFile ?? (await openGlbPicker());
      if (!file) return;
      try {
        const { submeshes, name } = await loadTreeGlbFromFile(file);
        const gltfScene = new THREE.Group();
        for (const sm of submeshes) {
          const mesh = new THREE.Mesh(sm.geometry, sm.material);
          mesh.applyMatrix4(sm.localMatrix);
          gltfScene.add(mesh);
        }
        const slot = toolState.propSlots[slotIdx];
        if (!slot) return;
        propStore.registerTypeLod(slot.typeIdx, lod, gltfScene);
        propInstancer.onTypeLodRegistered(slot.typeIdx, lod);
        console.log(
          `[V2] Prop "${slot.name}" LOD${lod} imported (${submeshes.length} submeshes)`,
        );
      } catch (err) {
        console.error(`[V2] Failed to load prop LOD${lod} GLB:`, err);
      }
    }),
    onPropLodChanged: () => {},
    onPropCastShadowChanged: (_propCastShadowChanged = () => {
      propInstancer.setCastShadow(toolState.propLod.castShadow);
    }),
    onDeleteSelectedProp: (_deleteSelectedProp = () => {
      propSystem.handleDelete();
      deactivatePropSelection();
    }),
    onDuplicateSelectedProp: (_duplicateSelectedProp = () => {
      const newIdx = propSystem.handleDuplicate();
      if (newIdx != null) {
        activatePropSelection(newIdx);
        ui?.pane.refresh();
      }
    }),
    onClearAllProps: (_clearAllProps = () => propSystem.clearAll()),
    onPropTransformModeChanged: (_propTransformModeChanged = () => {
      transformControls.setMode(toolState.props.transformMode);
    }),
    onWaterChanged: (_waterChanged = () => {
      waterMaterials.syncUniforms(toolState.water);
    }),
    onSaveWater: (_saveWater = () => waterSystem.saveJSON()),
    onLoadWater: (_loadWater = async () => {
      const file = await openFilePicker(".json");
      if (!file) return;
      try {
        await waterSystem.loadJSON(file);
        ui?.pane.refresh();
      } catch (err) {
        console.error("[V2] Failed to load water-bodies.json", err);
      }
    }),
    onDeleteSelectedWater: (_deleteSelectedWater = () => {
      waterSystem.deleteSelected();
      ui?.pane.refresh();
    }),
    onClearAllWater: (_clearAllWater = () => {
      waterSystem.clearAll();
      ui?.pane.refresh();
    }),
    onWaterfallChanged: (_waterfallChanged = () => {
      waterfallSystem.syncMaterial();
      waterfallSystem.refreshMeshesFromParams();
      ui?.pane.refresh();
    }),
    onDeleteSelectedWaterfall: (_deleteSelectedWaterfall = () => {
      waterfallSystem.deleteSelected();
      ui?.pane.refresh();
    }),
    onClearAllWaterfalls: (_clearAllWaterfalls = () => {
      waterfallSystem.clearAll();
      ui?.pane.refresh();
    }),
    actorSystem,
    onActorsChanged: (_actorsChanged = () => {
      actorSystem.syncMaterials();
      actorSystem.refreshCapsuleGeometry();
      ui?.refreshActorCounts?.();
      _refreshActorsPanel?.();
      ui?.pane.refresh();
    }),
    onDeleteSelectedActor: (_deleteSelectedActor = () => {
      actorSystem.deleteSelected();
      ui?.refreshActorCounts?.();
      _refreshActorsPanel?.();
      ui?.pane.refresh();
    }),
    onClearAllActors: (_clearAllActors = () => {
      actorSystem.clearAll();
      ui?.refreshActorCounts?.();
      _refreshActorsPanel?.();
      ui?.pane.refresh();
    }),
    onClearNpcs: (_clearNpcs = () => {
      actorSystem.clearByRole("npc");
      ui?.refreshActorCounts?.();
      _refreshActorsPanel?.();
      ui?.pane.refresh();
    }),
    onClearEnemies: (_clearEnemies = () => {
      actorSystem.clearByRole("enemy");
      ui?.refreshActorCounts?.();
      _refreshActorsPanel?.();
      ui?.pane.refresh();
    }),
    onSnapSelectedToTerrain: (_snapSelectedToTerrain = () => {
      if (actorSystem.selected?.mesh) {
        actorSystem.snapMeshToTerrain(actorSystem.selected.mesh);
      }
      _refreshActorsPanel?.();
    }),
    onActorsTransformModeChanged: (_actorsTransformModeChanged = () => {
      if (toolState.mode === "actors") {
        transformControls.setMode(
          toolState.actors.transformMode || "translate",
        );
      }
      ui?.pane.refresh();
    }),
    onDecalLoadImage: (_decalLoadImage = (preselectedFile = null) => {
      if (preselectedFile) {
        decalSystem
          .loadImageFromFile(preselectedFile)
          .catch((e) => console.warn("[Decals] load image", e));
        return;
      }
      decalSystem.openImagePicker();
    }),
    onDecalOpacityChanged: (_decalOpacityChanged = () => {
      decalSystem.applyOpacityToSelected();
      ui?.pane.refresh();
    }),
    onDecalAlignChanged: (_decalAlignChanged = () => {}),
    onDecalRefit: (_decalRefit = () => {
      decalSystem.refitSelectedToTerrain();
      ui?.pane.refresh();
    }),
    onDecalDeleteSelected: (_decalDeleteSelected = () => {
      decalSystem.deleteSelected();
      ui?.pane.refresh();
    }),
    onDecalClearAll: (_decalClearAll = () => {
      decalSystem.clearAll();
      ui?.pane.refresh();
    }),
    onDecalSaveJson: (_decalSaveJson = () => {
      const data = decalSystem.exportData();
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json",
      });
      downloadBlob(blob, "decals.json");
    }),
    onDecalLoadJson: (_decalLoadJson = async (preselectedFile = null) => {
      const file = preselectedFile ?? (await openFilePicker(".json"));
      if (!file) return;
      try {
        const text = await file.text();
        await decalSystem.importData(JSON.parse(text));
        ui?.pane.refresh();
      } catch (err) {
        console.error("[V2] Failed to load decals.json", err);
      }
    }),
    onDecalTransformModeChanged: (_decalTransformModeChanged = () => {
      transformControls.setMode(toolState.decal.transformMode);
    }),
    onBarrierOverlayChanged: (_barrierOverlayChanged = () => {
      syncBarrierOverlay();
    }),
    onBarrierClear: (_barrierClear = () => {
      barrierSystem.clearAll();
      syncBarrierOverlay();
    }),
    onBarrierFill: (_barrierFill = () => {
      barrierSystem.fillAll();
      syncBarrierOverlay();
    }),
    onHoleOverlayChanged: (_holeOverlayChanged = () => {
      syncHoleOverlay();
    }),
    onHoleClear: (_holeClear = () => {
      holeSystem.clearAll();
      syncHoleOverlay();
    }),
    onCaveUndo: (_caveUndo = () => {
      caveSystem.undo();
      ui?.refreshCaveCount?.(caveStore.count());
    }),
    onCaveRedo: (_caveRedo = () => {
      caveSystem.redo();
      ui?.refreshCaveCount?.(caveStore.count());
    }),
    onCaveClear: (_caveClear = () => {
      caveSystem.clearAll();
      ui?.refreshCaveCount?.(caveStore.count());
    }),
    onFleurChanged: (_fleurChanged = () => {}),
    onFleurColorChanged: (_fleurColorChanged = (slot) => {
      const fp = toolState.fleur;
      if (slot === "A") {
        fleurSystem.setColorA(fp.colorA.inner, fp.colorA.outer, fp.colorA.glow);
      } else {
        fleurSystem.setColorB(fp.colorB.inner, fp.colorB.outer, fp.colorB.glow);
      }
    }),
    onFleurStemChanged: (_fleurStemChanged = () => {
      fleurSystem.setStemColors(
        toolState.fleur.stemBase,
        toolState.fleur.stemTop,
      );
    }),
    onFleurStemCurveChanged: (_fleurStemCurveChanged = () => {
      fleurSystem.setStemStaticCurve(toolState.fleur.stemStaticCurve);
    }),
    onFleurInteractionChanged: (_fleurInteractionChanged = () => {
      syncFleurInteraction();
    }),
    onFleurClear: (_fleurClear = () => {
      fleurSystem.clear();
    }),
    onAmbientFxFlapChanged: (_ambientFxFlapChanged = () => {
      syncAmbientFxUniforms();
    }),
    onAmbientFxLeafChanged: (_ambientFxLeafChanged = () => {
      syncLeafFxParams();
    }),
    onAmbientFxRingsChanged: (_ambientFxRingsChanged = () => {
      const vis =
        toolState.ambientFx.showRings && toolState.mode === "ambientfx";
      ambientFxStore.setRingsVisible(vis);
      leafFxStore.setRingsVisible(vis);
    }),
    onAmbientFxClear: (_ambientFxClear = () => {
      ambientFxStore.clear();
      leafFxStore.clear();
    }),
    onAmbientFxClearLeaves: (_ambientFxClearLeaves = () => {
      leafFxStore.clear();
    }),
    onAmbientFxLeafRespawn: (_ambientFxLeafRespawn = () => {
      leafFxStore.respawnAll();
    }),
    onSaveProject: (_saveProject = () => {
      toolState._cliffExportData = () => cliffStore.exportData();
      toolState._propExportData = () => propStore.exportData();
      toolState._waterExportData = () => waterStore.exportData();
      toolState._waterfallExportData = () => waterfallSystem.exportData();
      toolState._actorExportData = () => actorSystem.exportData();
      toolState._barrierExportData = () => barrierStore.exportData();
      toolState._holeExportData = () => holeStore.exportData();
      toolState._caveExportData = () => caveStore.serialize();
      toolState._fleurExportData = () => fleurSystem.getPositions();
      toolState._ambientFxExportData = () => ambientFxStore.getEmitters();
      toolState._leafFxExportData = () => leafFxStore.getEmitters();
      toolState._roadExportData = () => roadSystem.exportData();
      toolState._fullRoadExportData = () => fullRoadSystem.exportData();
      toolState._smartRoadExportData = () => smartRoadSystem.exportData();
      toolState._smartRoad2ExportData = () => smartRoad2System.exportData();
      toolState._riverExportData = () => riverSystem.exportData();
      toolState._splineExportData = () => splineSystem.exportData();
      toolState._decalExportData = () => decalSystem.exportData();
      toolState._billboardGrassExportData = () => billboardGrassStore.toJSON();
      toolState._grassDensityExportData = () => grassManager.exportDensity();
      toolState._revoGrassMaskExportData = () =>
        revoGrassSystem.mask.exportData();
      toolState._snowMaskExportData = () => snowSystem.mask.exportData();
      toolState._cliffPaintMaskExportData = () => cliffPaintMask.exportData();
      toolState.propMaterialOverrides = propTextureLibrary.snapshotOverrides();
      const buf = serializeProject({
        terrainStore,
        splatStore,
        treeStore,
        foliageStore,
        config,
        toolState,
      });
      delete toolState._cliffExportData;
      delete toolState._propExportData;
      delete toolState._waterExportData;
      delete toolState._waterfallExportData;
      delete toolState._actorExportData;
      delete toolState._barrierExportData;
      delete toolState._holeExportData;
      delete toolState._caveExportData;
      delete toolState._fleurExportData;
      delete toolState._ambientFxExportData;
      delete toolState._leafFxExportData;
      delete toolState._roadExportData;
      delete toolState._fullRoadExportData;
      delete toolState._smartRoadExportData;
      delete toolState._smartRoad2ExportData;
      delete toolState._riverExportData;
      delete toolState._splineExportData;
      delete toolState._decalExportData;
      delete toolState._billboardGrassExportData;
      delete toolState._grassDensityExportData;
      delete toolState._revoGrassMaskExportData;
      delete toolState._snowMaskExportData;
      delete toolState._cliffPaintMaskExportData;
      const blob = new Blob([buf], { type: "application/octet-stream" });
      const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      downloadBlob(blob, `terrain-${ts}.v2terrain`);
    }),
    onLoadProject: (_loadProject = async (preloadedBuf = null) => {
      let buf;
      if (preloadedBuf) {
        // Headless / player path: caller already fetched the .v2terrain bytes
        // (e.g. play.html loading from /public). Skip the file picker.
        buf = preloadedBuf;
      } else {
        const file = await openFilePicker(".v2terrain");
        if (!file) return;
        buf = await file.arrayBuffer();
      }
      try {
        const project = deserializeProject(buf);
        // Restore terrain heights
        for (const [key, heights] of project.terrainChunks) {
          terrainStore.chunkDataMap.set(key, heights);
        }
        // Restore splat paint
        splatStore.restoreFromSnapshot(project.splatChunks);
        // Restore trees
        if (project.treeChunks) {
          treeStore.clear();
          treeStore.restoreFromSnapshot(project.treeChunks);
          treeStore.syncAllHeights(terrainStore);
        }
        foliageStore.clear();
        if (project.foliageChunks?.size > 0) {
          foliageStore.restoreFromSnapshot(project.foliageChunks);
          foliageStore.syncAllHeights(terrainStore);
        }
        billboardGrassStore.clear();
        if (
          Array.isArray(project.settings?.billboardGrassChunks) &&
          project.settings.billboardGrassChunks.length > 0
        ) {
          billboardGrassStore.fromJSON(project.settings.billboardGrassChunks);
          billboardGrassStore.syncAllHeights(terrainStore);
        }
        // Restore settings
        applySettings(toolState, project.settings);
        // Gemini/hybrid grass: restore the painted density map, then rebuild
        // blade geometry + visibility from the restored params. (applySettings
        // already put the params back into toolState.grass.)
        if (project.settings?.grassDensity) {
          grassManager.importDensity(project.settings.grassDensity);
        }
        if (toolState.grass?.enabled) {
          grassManager.syncUniforms(toolState.grass, sunDir);
          grassManager.rebuildGeometries(toolState.grass);
          if (hybridGrassRings) {
            rebuildHybridGrassGeometries(hybridGrassRings, toolState.grass);
          }
        }
        if (project.settings?.revoGrassMask) {
          revoGrassSystem.mask.importData(project.settings.revoGrassMask);
        }
        if (project.settings?.revoGrass && toolState.revoGrass.enabled) {
          await revoGrassSystem.rebuild(toolState.revoGrass, sunDir);
          revoGrassSystem.syncFromState(toolState.revoGrass, sunDir);
          await revoGrassSystem.precompile(renderer, camera);
        } else {
          revoGrassSystem.setEnabled(false);
        }
        if (project.settings?.snowMask) {
          snowSystem.mask.importData(project.settings.snowMask);
        }
        if (project.settings?.cliffPaintMask) {
          cliffPaintMask.importData(project.settings.cliffPaintMask);
        }
        if (project.settings?.snow && toolState.snow.enabled) {
          await snowSystem.rebuild(toolState.snow);
          snowSystem.syncFromState(toolState.snow);
          await snowSystem.precompile(renderer, camera);
        } else {
          snowSystem.setEnabled(false);
        }
        propTextureLibrary.applyOverrides(toolState.propMaterialOverrides);
        riverSystem.syncMaterial();
        fullRoadSystem.syncMaterial();
        smartRoadSystem.syncMaterial();
        if (project.settings?.roads)
          roadSystem.importData(project.settings.roads);
        if (project.settings?.fullRoadNetwork)
          fullRoadSystem.importData(project.settings.fullRoadNetwork);
        else fullRoadSystem.importData(null);
        if (project.settings?.smartRoadNetwork)
          smartRoadSystem.importData(project.settings.smartRoadNetwork);
        else smartRoadSystem.importData(null);
        if (project.settings?.smartRoad2Network)
          smartRoad2System.importData(project.settings.smartRoad2Network);
        else smartRoad2System.importData(null);
        // applySettings already restored toolState.smartRoad2; sync into the system.
        Object.assign(smartRoad2System.params, toolState.smartRoad2);
        smartRoad2System.queueRebuild();
        if (project.settings?.rivers)
          riverSystem.importData(project.settings.rivers);
        else riverSystem.importData([]);
        if (project.settings?.splinePath)
          splineSystem.importData(project.settings.splinePath);
        else splineSystem.importData({ points: [] });
        // Spline Road: points/params were restored into toolState by applySettings;
        // rebuild the road mesh from them.
        splineRoadSystem.loadFromToolState();
        rebuildInteriorVolumes();
        // Restore cliff instances (types must be re-imported by user)
        if (project.settings?.cliffInstances) {
          const typeNameToIdx = {};
          for (let i = 0; i < cliffStore.types.length; i++) {
            typeNameToIdx[cliffStore.types[i].name] = i;
          }
          cliffStore.clear();
          cliffStore.importData(project.settings.cliffInstances, typeNameToIdx);
        }
        // Auto-restore primitive + live prop types from saved slots.
        // For GLB types: if the original filename was found in /models when imported,
        // it was recorded as slot.glbFile and we fetch it back from /models now.
        const propGlbLoads = [];
        if (project.settings?.propSlots) {
          for (const slot of project.settings.propSlots) {
            if (slot.builtin) {
              propUiCallbacks.onAddPrimitive?.(slot.name);
              const slotIdx = toolState.props.activeSlot;
              const live = toolState.propSlots[slotIdx];
              if (live && (slot.materialId || slot.triplanar)) {
                if (slot.materialId) live.materialId = slot.materialId;
                if (slot.triplanar) live.triplanar = true;
                _rebuildPrimitiveMaterial(slotIdx);
              }
            } else if (slot.live) {
              _addLiveProp?.(slot.name);
            } else if (slot.glbFile) {
              // dedupe: skip if a slot with this name already exists (e.g. loading on top of an active session)
              const already = toolState.propSlots.find(
                (s) => s.name === slot.name && !s.builtin && !s.live,
              );
              if (already) continue;
              propGlbLoads.push(
                (async (filename, slotName) => {
                  const url = await probeModelsForFile(filename);
                  if (!url) {
                    console.warn(
                      `[V2] Could not restore prop "${slotName}": ${filename} not found in /models`,
                    );
                    return;
                  }
                  try {
                    const { submeshes } = await loadTreeGlbFromUrl(url);
                    const gltfScene = new THREE.Group();
                    for (const sm of submeshes) {
                      const mesh = new THREE.Mesh(sm.geometry, sm.material);
                      mesh.applyMatrix4(sm.localMatrix);
                      gltfScene.add(mesh);
                    }
                    const typeIdx = propStore.registerType(gltfScene, slotName);
                    if (typeIdx < 0) return;
                    propInstancer.onTypeRegistered(typeIdx);
                    toolState.propSlots.push({
                      name: slotName,
                      loaded: true,
                      typeIdx,
                      glbFile: filename,
                    });
                    console.log(`[V2] Restored prop "${slotName}" from ${url}`);
                  } catch (err) {
                    console.error(
                      `[V2] Failed to restore prop "${slotName}":`,
                      err,
                    );
                  }
                })(slot.glbFile, slot.name),
              );
            }
          }
        }
        // Wait for GLB types to register before importing instances (importData filters by name)
        if (propGlbLoads.length > 0) await Promise.all(propGlbLoads);
        propUiCallbacks._rebuildPropUi?.();
        // Restore prop instances (GLB types without a /models match still need re-import by user)
        if (project.settings?.propInstances) {
          const typeNameToIdx = {};
          for (let i = 0; i < propStore.types.length; i++) {
            typeNameToIdx[propStore.types[i].name] = i;
          }
          propStore.clear();
          propStore.importData(project.settings.propInstances, typeNameToIdx);
        }
        // Restore water bodies
        if (project.settings?.waterBodies) {
          waterSystem.applyBodies(project.settings.waterBodies);
          waterMaterials.syncUniforms(toolState.water);
        }
        // Re-apply the loaded world-ocean state (enable / sea level / look / LOD).
        worldOcean.syncParams(toolState.worldOcean);
        waterfallSystem.syncMaterial();
        if (project.settings?.waterfallItems) {
          waterfallSystem.importData(project.settings.waterfallItems);
        } else {
          waterfallSystem.clearAll();
        }
        actorSystem.syncMaterials();
        if (project.settings?.actorSpawns) {
          actorSystem.importData(project.settings.actorSpawns);
        } else {
          actorSystem.clearAll();
        }
        ui?.refreshActorCounts?.();
        _refreshActorsPanel?.();
        if (
          project.settings?.decals &&
          Array.isArray(project.settings.decals)
        ) {
          await decalSystem.importData(project.settings.decals);
        } else {
          decalSystem.clearAll();
        }
        // Restore barriers
        barrierOverlay.clear();
        barrierStore.dispose();
        if (project.settings?.barrierChunks) {
          barrierStore.importData(project.settings.barrierChunks);
        }
        holeOverlay.clear();
        holeStore.dispose();
        if (project.settings?.holeChunks) {
          holeStore.importData(project.settings.holeChunks);
        }
        // Restore caves — `deserialize` clears existing anchors first, then
        // adds the saved ones. `caveStore.onChange` fires inside both, so the
        // BVH rebake is automatic.
        if (project.settings?.caves) {
          caveStore.deserialize(project.settings.caves);
        } else {
          caveStore.clearAll();
        }
        // Restore flowers
        if (
          project.settings?.fleurPositions &&
          Array.isArray(project.settings.fleurPositions)
        ) {
          fleurSystem.setPositions(project.settings.fleurPositions);
        } else {
          fleurSystem.clear();
        }
        if (project.settings?.fleurInteraction) {
          const fi = project.settings.fleurInteraction;
          const fp = toolState.fleur;
          if (fi.interactRadius != null) fp.interactRadius = fi.interactRadius;
          if (fi.interactStrength != null)
            fp.interactStrength = fi.interactStrength;
          if (fi.interactGain != null) fp.interactGain = fi.interactGain;
          if (fi.windAmp != null) fp.windAmp = fi.windAmp;
          if (fi.windSpeed != null) fp.windSpeed = fi.windSpeed;
          syncFleurInteraction();
        }
        // Restore ambient FX emitters
        if (
          project.settings?.ambientFxEmitters &&
          Array.isArray(project.settings.ambientFxEmitters)
        ) {
          ambientFxStore.setEmitters(project.settings.ambientFxEmitters);
        } else {
          ambientFxStore.clear();
        }
        syncAmbientFxUniforms();
        // Restore leaf FX emitters
        if (
          project.settings?.leafFxEmitters &&
          Array.isArray(project.settings.leafFxEmitters)
        ) {
          leafFxStore.setEmitters(project.settings.leafFxEmitters);
        } else {
          leafFxStore.clear();
        }
        syncLeafFxParams();

        // Billboard foliage slots: rebuild meshes, reload textures/foliage/*.png paths.
        for (let si = 0; si < toolState.foliageSlots.length; si++) {
          const slot = toolState.foliageSlots[si];
          if (slot.textureUrl) {
            slot.textureUrl = normalizeFoliageTextureRef(slot.textureUrl);
          }
          billboardRenderer.rebuildSlot(si, slot);
        }
        await applyFoliageSlotTextures(
          billboardRenderer,
          toolState.foliageSlots,
        );

        for (let gi = 0; gi < toolState.billboardGrassSlots.length; gi++) {
          const slot = toolState.billboardGrassSlots[gi];
          if (slot.textureUrl) {
            slot.textureUrl = normalizeBillboardGrassTextureRef(
              slot.textureUrl,
            );
          }
          billboardGrassRenderer.rebuildSlot(gi, slot);
        }
        await applyBillboardGrassSlotTextures(
          billboardGrassRenderer,
          toolState.billboardGrassSlots,
        );

        // Auto-reload tree presets (trunk GLBs + foliage) for slots that had them.
        // Also handles slots imported as raw GLBs from /models (slot.glbFile.lod0/lod1).
        const presetLoads = [];
        for (let si = 0; si < toolState.treeSlots.length; si++) {
          const slot = toolState.treeSlots[si];
          if (slot.presetFile) {
            presetLoads.push(
              (async (slotIdx, filename) => {
                try {
                  const {
                    foliagePreset,
                    trunkSubmeshes,
                    trunkLod1Submeshes,
                    json,
                  } = await loadFullPresetFromUrl(filename);
                  if (trunkSubmeshes) {
                    treeLodRenderer.setSlotModel(
                      slotIdx,
                      0,
                      trunkSubmeshes,
                      toolState.treeLod.castShadow,
                    );
                  }
                  if (trunkLod1Submeshes) {
                    treeLodRenderer.setSlotModel(
                      slotIdx,
                      1,
                      trunkLod1Submeshes,
                      toolState.treeLod.castShadow,
                    );
                  }
                  foliageLodRenderer.setSlotPreset(slotIdx, foliagePreset);
                  console.log(
                    `[V2] Auto-loaded preset "${filename}" into slot ${slotIdx}`,
                  );
                } catch (err) {
                  console.warn(
                    `[V2] Could not auto-load preset "${filename}" for slot ${slotIdx}:`,
                    err.message,
                  );
                }
              })(si, slot.presetFile),
            );
          } else if (slot.glbFile) {
            const lods = [];
            if (slot.glbFile.lod0) lods.push([0, slot.glbFile.lod0]);
            if (slot.glbFile.lod1) lods.push([1, slot.glbFile.lod1]);
            for (const [lod, filename] of lods) {
              presetLoads.push(
                (async (slotIdx, l, fname) => {
                  const url = await probeModelsForFile(fname);
                  if (!url) {
                    console.warn(
                      `[V2] Could not restore tree slot ${slotIdx} LOD${l}: ${fname} not found in /models`,
                    );
                    return;
                  }
                  try {
                    const { submeshes } = await loadTreeGlbFromUrl(url);
                    treeLodRenderer.setSlotModel(
                      slotIdx,
                      l,
                      submeshes,
                      toolState.treeLod.castShadow,
                    );
                    console.log(
                      `[V2] Restored tree slot ${slotIdx} LOD${l} from ${url}`,
                    );
                  } catch (err) {
                    console.error(
                      `[V2] Failed to restore tree slot ${slotIdx} LOD${l}:`,
                      err,
                    );
                  }
                })(si, lod, filename),
              );
            }
          }
        }
        if (presetLoads.length > 0) {
          Promise.all(presetLoads).then(() => {
            console.log(
              `[V2] All tree presets restored (${presetLoads.length} slot(s))`,
            );
          });
        }

        sharedGroundBundle.syncFromParams(toolState.groundTsl);
        // Rebuild the player BVH from the restored cliffs / props / splines /
        // fullRoad / caves. Without this the user has to click "Rebake BVH"
        // manually after every project load to get collision back. We do it
        // here (and not inside any of the individual importData calls) so the
        // bake happens once, after every collidable store has been populated.
        rebakePlayerBvh();
        // Rebuild everything
        invalidateSurfaceMaterials();
        rebuildGlobalHeightTexture();
        grassManager.rebuildTerrainNormalTex(config.world.size);
        syncFog();
        if (toolState.skyMode === "hdr" && !hdrTexture)
          toolState.skyMode = "physical";
        applySkyMode(toolState.skyMode);
        applyPostFxState();
        chunkStream.markAllDirty();
        chunkStream.update(camera.position);
        if (toolState.borderMountains.enabled) rebuildBorderMountains();
        grassManager.syncUniforms(toolState.grass, sunDir);
        grassManager.rebuildGeometries(toolState.grass);
        syncPlaySpawnMarker();
        ui?.pane.refresh();
        const treeCount = treeStore.totalCount;
        const foliageCount = foliageStore.getTotalCount();
        const bbGrassCount = billboardGrassStore.getTotalCount();
        console.log(
          `[V2] Loaded project: ${project.terrainChunks.size} terrain chunks, ${project.splatChunks.size} splat chunks, ${treeCount} trees, ${foliageCount} billboard foliage, ${bbGrassCount} billboard grass`,
        );
      } catch (err) {
        console.error("[V2] Failed to load project:", err);
      }
    }),
  });

  function syncBarrierOverlay() {
    if (playMode.active) {
      barrierOverlay.sync(barrierStore, false, 0);
      return;
    }
    const showInMode = toolState.mode === "barrier";
    const visible = showInMode || toolState.barrier.showOverlay;
    barrierOverlay.sync(
      barrierStore,
      visible,
      toolState.barrier.overlayOpacity,
    );
  }
  syncBarrierOverlay();

  function syncHoleOverlay() {
    if (playMode.active) {
      holeOverlay.sync(holeStore, false, 0);
      return;
    }
    const showInMode = toolState.mode === "hole";
    const visible = showInMode || toolState.hole.showOverlay;
    holeOverlay.sync(holeStore, visible, toolState.hole.overlayOpacity);
  }
  syncHoleOverlay();

  // Wire the prop-add primitive callback (formerly set by Tweakpane's prop folder)
  // so project load can re-create built-in primitive slots via `propUiCallbacks.onAddPrimitive`.
  propUiCallbacks.onAddPrimitive = _addPrimitive;

  playMode.onExit = () => {
    toolState.mode = "view";
    dialogueRunner.end();
    actorSystem.exitPlayMode();
    playMode.exit();
    collectibleRuntime.stop();
    syncPlayEditorChrome(false);
    document.getElementById("play-stop-bar")?.classList.remove("visible");
    syncPlaySpawnMarker();
    ui?.pane.refresh();
  };

  /** Engine-style brush preview: translucent hemisphere + edge lines, aligned to surface normal. */
  const brushDomeGeom = new THREE.SphereGeometry(
    1,
    48,
    24,
    0,
    Math.PI * 2,
    0,
    Math.PI * 0.5,
  );
  const brushDomeFillMat = new THREE.MeshBasicMaterial({
    color: 0xf5cc52,
    transparent: true,
    opacity: 0.16,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  brushDomeFillMat.fog = false;
  const brushDomeFill = new THREE.Mesh(brushDomeGeom, brushDomeFillMat);
  const brushDomeEdgesGeom = new THREE.EdgesGeometry(brushDomeGeom, 22);
  const brushDomeLineMat = new THREE.LineBasicMaterial({
    color: 0xffeebb,
    transparent: true,
    opacity: 0.72,
    depthWrite: false,
  });
  brushDomeLineMat.fog = false;
  const brushDomeLines = new THREE.LineSegments(
    brushDomeEdgesGeom,
    brushDomeLineMat,
  );
  const brushPreview = new THREE.Group();
  brushPreview.add(brushDomeFill);
  brushPreview.add(brushDomeLines);
  brushPreview.visible = false;
  brushPreview.renderOrder = 5;
  scene.add(brushPreview);

  const brushRing = new THREE.Mesh(
    new THREE.TorusGeometry(1, 0.045, 8, 64),
    new THREE.MeshBasicMaterial({ color: 0xf5cc52 }),
  );
  brushRing.visible = false;
  brushRing.material.fog = false;
  brushRing.renderOrder = 5;
  scene.add(brushRing);

  const spawnMarker = new THREE.Group();
  const spawnRing = new THREE.Mesh(
    new THREE.TorusGeometry(1.4, 0.055, 8, 72),
    new THREE.MeshBasicMaterial({ color: 0x4de3ff }),
  );
  spawnRing.rotation.x = Math.PI * 0.5;
  spawnRing.material.fog = false;
  spawnRing.renderOrder = 6;
  const spawnArrow = new THREE.Mesh(
    new THREE.ConeGeometry(0.28, 1.1, 4),
    new THREE.MeshBasicMaterial({ color: 0x4de3ff }),
  );
  spawnArrow.position.set(0, 1.15, -1.15);
  spawnArrow.rotation.x = -Math.PI * 0.5;
  spawnArrow.material.fog = false;
  spawnArrow.renderOrder = 6;
  spawnMarker.add(spawnRing, spawnArrow);
  spawnMarker.visible = false;
  scene.add(spawnMarker);

  roadReflection.excludeFromReflection(brushPreview);
  roadReflection.excludeFromReflection(brushRing);
  roadReflection.excludeFromReflection(spawnMarker);
  roadReflection.excludeFromReflection(roadSystem.handleGroup);
  roadReflection.excludeFromReflection(fullRoadSystem.handleGroup);
  roadReflection.excludeFromReflection(smartRoadSystem.handleGroup);
  roadReflection.excludeFromReflection(riverSystem.handleGroup);
  roadReflection.excludeFromReflection(splineSystem.handleGroup);
  roadReflection.excludeFromReflection(splineSystem.previewGroup);
  roadReflection.excludeFromReflection(splineSystem.trainMesh);
  roadReflection.excludeFromReflection(barrierOverlay.group);
  roadReflection.excludeFromReflection(holeOverlay.group);

  const rampMarkerA = new THREE.Mesh(
    new THREE.TorusGeometry(1, 0.045, 8, 64),
    new THREE.MeshBasicMaterial({ color: 0xcc66ff }),
  );
  rampMarkerA.rotation.x = Math.PI * 0.5;
  rampMarkerA.visible = false;
  rampMarkerA.material.fog = false;
  rampMarkerA.renderOrder = 5;
  scene.add(rampMarkerA);

  /** Hemisphere: pole +Y; torus (`TorusGeometry`): ring in XY, symmetry axis +Z. */
  const _brushY = new THREE.Vector3(0, 1, 0);
  const _brushZ = new THREE.Vector3(0, 0, 1);
  const brushPick = { point: new THREE.Vector3(), normal: new THREE.Vector3() };

  const raycaster = new THREE.Raycaster();
  const pointerNdc = new THREE.Vector2();
  let pointerDown = false;
  let hudLastMs = 0;

  function updateSunSky() {
    const Li = toolState.light;
    sunDirectionFromAngles(Li.sunAzimuth, Li.sunElevation, sunDir);
    // Directional key light. In PROCEDURAL mode, relight by the MOON (antipode of
    // the sun) once the sun drops below the horizon, and fade the sun out across
    // twilight — so night terrain is moonlit + casts moon shadows (matches the
    // lab). Other sky modes keep the user's sun unchanged.
    const sunUp = sunDir.y;
    if (toolState.skyMode === "procedural" && sunUp < 0) {
      _effectiveLightDir.copy(sunDir).negate(); // moon direction
      sun.position.copy(_effectiveLightDir).multiplyScalar(Li.sunDistance);
      sun.color.set(toolState.proceduralSky.moonColor);
      sun.intensity =
        (Li.moonIntensity ?? 0.3) *
        THREE.MathUtils.smoothstep(-sunUp, 0.0, 0.15);
    } else {
      _effectiveLightDir.copy(sunDir);
      sun.position.copy(sunDir).multiplyScalar(Li.sunDistance);
      sun.color.set(Li.dirColor);
      const sunFade =
        toolState.skyMode === "procedural"
          ? THREE.MathUtils.smoothstep(sunUp, -0.05, 0.1)
          : 1;
      sun.intensity = Li.dirIntensity * sunFade;
    }
    hemi.color.set(Li.hemiSkyColor);
    hemi.groundColor.set(Li.hemiGroundColor);
    hemi.intensity = Li.hemiIntensity;
    sun.shadow.bias = Li.shadowBias;
    sun.shadow.normalBias = Li.shadowNormalBias;
    renderer.toneMappingExposure = Li.exposure;
    if (toolState.skyMode === "hdr") {
      scene.environmentIntensity = Li.hdrEnvIntensity ?? 1;
      scene.backgroundIntensity = Li.hdrBackgroundIntensity ?? 0.7;
    } else {
      scene.environmentIntensity = Li.envIntensity;
      scene.backgroundIntensity = 1;
    }
    applyPhysicalSkyMeshUniforms();
    sky.scale.setScalar(toolState.physicalSky.meshScale);
    if (sky.sunPosition?.value?.copy) {
      sky.sunPosition.value.copy(sunDir);
    } else if (sky.sunPosition?.copy) {
      sky.sunPosition.copy(sunDir);
    }
  }

  updateSunSky();
  // Apply the actual default sky mode at boot (was hardcoded to the physical
  // rebuildSkyEnv()). applySkyMode dispatches per mode — for "procedural" it
  // shows the dome and bakes its IBL; for "physical" it still calls
  // rebuildSkyEnv() internally — so this is correct whatever the default is.
  applySkyMode(toolState.skyMode);

  grassManager.init(globalHeightTex, sunDir, toolState.grass, {
    groundColorAtWorldXZ: sharedGroundBundle.groundColorAtWorldXZ,
  });
  grassManager.rebuildTerrainNormalTex(config.world.size);
  grassManager.precompile(renderer, camera);

  /**
   * Snow tile init — uses the engine's existing `globalHeightTex` (terrain Y)
   * and `grassManager.windTex` (RepeatWrapping Float32 RGBA FBM noise) for the
   * surface drift + glitter perlin/hash sampling. One texture, four channels.
   */
  await snowSystem.init(
    renderer,
    globalHeightTex,
    grassManager.windTex,
    toolState,
    { htexRes: HTEX_RES },
  );
  /** Push initial cliff slope into snow if the link is on. */
  snowSystem.applyCliffSlope(
    toolState.autoCliff.slopeStart,
    toolState.autoCliff.slopeEnd,
    !!toolState.snow.slopeLinkToCliff,
  );
  if (toolState.snow?.enabled) {
    await snowSystem.precompile(renderer, camera);
  }

  await revoGrassSystem.init(renderer, globalHeightTex, sunDir, toolState, {
    geminiDensityTex: grassManager.densityTex,
    terrainNormalTex: grassManager.terrainNormalTex,
  });
  if (toolState.revoGrass.enabled) {
    await revoGrassSystem.precompile(renderer, camera);
  }

  // Pre-compile terrain pipelines for all LOD segment counts to avoid hitches
  {
    const tmpMeshes = [];
    for (const level of config.lod.levels) {
      const geo = terrainMesher.pool.acquire(level.segments);
      const m = new THREE.Mesh(geo, tileTerrainMaterial);
      m.frustumCulled = false;
      m.receiveShadow = true;
      m.position.set(0, -9999, 0);
      scene.add(m);
      tmpMeshes.push({ mesh: m, geo, segs: level.segments });
    }
    await renderer.compileAsync(scene, camera);
    for (const { mesh, geo, segs } of tmpMeshes) {
      scene.remove(mesh);
      terrainMesher.pool.release(segs, geo);
    }
  }

  const lensFlare = createLensFlareSystem({
    scene,
    camera,
    getSunDir: () => sunDir,
    getParams: () => toolState.lensFlare,
  });

  /**
   * Post-FX pipeline (WebGPU PostProcessing + bloom). Lazy-built on first
   * enable; while disabled the loop calls `renderer.render(scene, camera)`
   * exactly like before, so cost is zero.
   */
  const postFxPipeline = new PostFxPipeline({ renderer, scene, camera });
  function applyPostFxState() {
    const p = toolState.postFx;
    postFxPipeline.setBloomParams(p.bloom);
    postFxPipeline.setBloomEnabled(p.bloom.enabled);
    postFxPipeline.setFxaaEnabled(p.fxaa.enabled);
    postFxPipeline.setSsaoParams(p.ssao);
    postFxPipeline.setSsaoEnabled(p.ssao.enabled);
    postFxPipeline.setPolishParams(p.polish);
    postFxPipeline.setPolishEnabled(p.polish.enabled);
    postFxPipeline.setSharpenParams(p.sharpen);
    postFxPipeline.setSharpenEnabled(p.sharpen.enabled);
    postFxPipeline.setChromaticAberrationParams(p.chromaticAberration);
    postFxPipeline.setChromaticAberrationEnabled(p.chromaticAberration.enabled);
    postFxPipeline.setDofParams(p.dof);
    postFxPipeline.setDofEnabled(p.dof.enabled);
    postFxPipeline.setEnabled(p.enabled);
  }
  applyPostFxState();

  // Both cloud systems bake heavy 3D textures (~96³ / 128³ voxels) on the CPU at
  // construction time. Defer creation until the user actually enables one — the
  // render loop / API methods below already null-check with `?.`.
  let volumetricCloudSystem = null;
  let volumetricCloudSystemOptimized = null;
  let volumetricCloudSystemV3 = null;
  let _vcInitPromise = null;
  let _vcOptInitPromise = null;
  let _vcV3InitPromise = null;
  // Daynight-sky volumetric cloud deck (procedural sky only). Synchronous bake,
  // so no init promise — created lazily on first enable.
  let dayNightCloudLayer = null;
  function ensureDayNightCloudLayer() {
    if (dayNightCloudLayer) return dayNightCloudLayer;
    try {
      dayNightCloudLayer = createDayNightCloudLayer({
        scene,
        camera,
        renderer,
      });
      scene.add(dayNightCloudLayer.mesh);
      // God-rays sun disc — hidden except during the occlusion pass.
      scene.add(dayNightCloudLayer.sunMesh);
    } catch (err) {
      console.warn("[V2] Daynight cloud layer failed to init:", err);
    }
    return dayNightCloudLayer;
  }
  function ensureVolumetricCloudSystem() {
    if (volumetricCloudSystem || _vcInitPromise) return _vcInitPromise;
    _vcInitPromise = createVolumetricCloudSystem({
      renderer,
      scene,
      camera,
      toolState,
      getSunDir: () => sunDir,
      sun,
      hemi,
      getOccluderMeshes: () => chunkStream.raycastMeshes(),
    })
      .then((sys) => {
        volumetricCloudSystem = sys;
      })
      .catch((err) => {
        console.warn("[V2] Volumetric cloud volume failed to init:", err);
      });
    return _vcInitPromise;
  }
  function ensureVolumetricCloudSystemOptimized() {
    if (volumetricCloudSystemOptimized || _vcOptInitPromise)
      return _vcOptInitPromise;
    _vcOptInitPromise = createVolumetricCloudSystemOptimized({
      renderer,
      scene,
      camera,
      toolState,
      getSunDir: () => sunDir,
      sun,
      hemi,
      getOccluderMeshes: () => chunkStream.raycastMeshes(),
    })
      .then((sys) => {
        volumetricCloudSystemOptimized = sys;
      })
      .catch((err) => {
        console.warn("[V2] Volumetric cloud (optimized) failed to init:", err);
      });
    return _vcOptInitPromise;
  }
  function ensureVolumetricCloudSystemV3() {
    if (volumetricCloudSystemV3 || _vcV3InitPromise) return _vcV3InitPromise;
    _vcV3InitPromise = createVolumetricCloudSystemV3({
      renderer,
      scene,
      camera,
      toolState,
      getSunDir: () => sunDir,
      sun,
      hemi,
      getOccluderMeshes: () => chunkStream.raycastMeshes(),
    })
      .then((sys) => {
        volumetricCloudSystemV3 = sys;
      })
      .catch((err) => {
        console.warn("[V2] Volumetric cloud V3 failed to init:", err);
      });
    return _vcV3InitPromise;
  }

  function updatePointer(event) {
    const rect = renderer.domElement.getBoundingClientRect();
    pointerNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointerNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  }

  function pickTerrain(event) {
    updatePointer(event);
    const targets = chunkStream.raycastMeshes();
    if (targets.length === 0) return null;
    raycaster.setFromCamera(pointerNdc, camera);
    const hits = raycaster.intersectObjects(targets, false);
    if (hits.length === 0) return null;
    const h = hits[0];
    brushPick.point.copy(h.point);
    if (h.face) {
      brushPick.normal
        .copy(h.face.normal)
        .transformDirection(h.object.matrixWorld)
        .normalize();
      if (brushPick.normal.lengthSq() < 1e-6) brushPick.normal.set(0, 1, 0);
    } else {
      brushPick.normal.set(0, 1, 0);
    }
    return brushPick;
  }

  function syncRampMarker() {
    if (
      toolState.mode !== "sculpt" ||
      toolState.sculptMode !== "ramp" ||
      !sculptSystem.hasRampPointA()
    ) {
      rampMarkerA.visible = false;
      return;
    }
    const a = sculptSystem.rampPointA;
    rampMarkerA.visible = true;
    rampMarkerA.position.set(a.x, a.y + 0.04, a.z);
    rampMarkerA.scale.setScalar(toolState.brush.radius);
  }

  function syncPlaySpawnMarker() {
    const spawn = toolState.playSpawn;
    if (!spawn?.enabled || playMode.active) {
      spawnMarker.visible = false;
      return;
    }
    const y = terrainStore.getWorldHeight(spawn.x, spawn.z);
    spawn.y = y;
    spawnMarker.visible = true;
    spawnMarker.position.set(spawn.x, y + 0.08, spawn.z);
    spawnMarker.rotation.y = THREE.MathUtils.degToRad(spawn.yawDeg || 0);
  }

  function isBrushMode() {
    return (
      toolState.mode === "sculpt" ||
      toolState.mode === "paint" ||
      toolState.mode === "treePaint" ||
      toolState.mode === "foliagePaint" ||
      toolState.mode === "billboardGrassPaint" ||
      toolState.mode === "grass" ||
      toolState.mode === "revoGrass" ||
      toolState.mode === "snow" ||
      toolState.mode === "cliffGrass" ||
      toolState.mode === "cliffPaint" ||
      toolState.mode === "barrier" ||
      toolState.mode === "hole" ||
      toolState.mode === "cave" ||
      toolState.mode === "fleurs" ||
      toolState.mode === "ambientfx" ||
      (toolState.mode === "props" && toolState.props.placementMode === "paint")
    );
  }

  function updateBrushPreviewFromPick(hit) {
    if (!hit || !isBrushMode()) {
      brushPreview.visible = false;
      brushRing.visible = false;
      syncRampMarker();
      return;
    }
    const r =
      toolState.mode === "ambientfx"
        ? toolState.ambientFx.emitterRadius
        : toolState.brush.radius;
    const nudge = 0.012 + Math.min(0.08, r * 0.0004);
    const useCircle = toolState.brush.previewShape === "circle";
    if (useCircle) {
      brushPreview.visible = false;
      brushRing.visible = true;
      brushRing.scale.setScalar(r);
      brushRing.position.copy(hit.point).addScaledVector(hit.normal, nudge);
      brushRing.quaternion.setFromUnitVectors(_brushZ, hit.normal);
      syncRampMarker();
      return;
    }
    brushRing.visible = false;
    brushPreview.visible = true;
    brushPreview.scale.setScalar(r);
    brushPreview.position.copy(hit.point).addScaledVector(hit.normal, nudge);
    brushPreview.quaternion.setFromUnitVectors(_brushY, hit.normal);
    syncRampMarker();
  }

  function updateBrushPreview(event) {
    updateBrushPreviewFromPick(pickTerrain(event));
  }

  function activateCliffSelection(instIdx) {
    cliffInstancer.select(instIdx);
    transformControls.attach(cliffInstancer.proxyObject);
    transformControls.setMode(toolState.cliffs.transformMode);
    transformControls.enabled = true;
    transformControls.visible = true;
  }

  function deactivateCliffSelection() {
    cliffInstancer.clearSelection();
    transformControls.detach();
    transformControls.enabled = false;
    transformControls.visible = false;
  }

  let _onPropSelectionChanged = null;

  function activatePropSelection(instIdx) {
    propInstancer.select(instIdx);
    transformControls.attach(propInstancer.proxyObject);
    transformControls.setMode(toolState.props.transformMode);
    transformControls.enabled = true;
    transformControls.visible = true;
    _onPropSelectionChanged?.(instIdx);
  }

  function deactivatePropSelection() {
    propInstancer.clearSelection();
    transformControls.detach();
    transformControls.enabled = false;
    transformControls.visible = false;
    ui?.propFolder?.hideLiveParams();
    _onPropSelectionChanged?.(null);
  }

  renderer.domElement.addEventListener("pointerdown", (event) => {
    if (toolState.mode === "playSpawn" && event.button === 0) {
      const hit = pickTerrain(event);
      if (hit) {
        event.preventDefault();
        const spawn = toolState.playSpawn;
        spawn.enabled = true;
        spawn.x = hit.point.x;
        spawn.y = hit.point.y;
        spawn.z = hit.point.z;
        syncPlaySpawnMarker();
        ui?.pane.refresh();
      }
      return;
    }
    if (toolState.mode === "water" && event.button === 0) {
      if (transformControls.dragging) return;
      event.preventDefault();
      updatePointer(event);
      const hit = pickTerrain(event);
      const consumed = waterSystem.handlePointerDown(
        pointerNdc,
        camera,
        hit?.point,
      );
      if (consumed) ui?.pane.refresh();
      return;
    }
    if (toolState.mode === "waterfall" && event.button === 0) {
      if (transformControls.dragging) return;
      event.preventDefault();
      updatePointer(event);
      const hit = pickTerrain(event);
      const consumed = waterfallSystem.handlePointerDown(
        pointerNdc,
        camera,
        hit?.point,
      );
      if (consumed) ui?.pane.refresh();
      return;
    }
    if (toolState.mode === "actors" && event.button === 0) {
      if (transformControls.dragging) return;
      event.preventDefault();
      updatePointer(event);
      const hit = pickTerrain(event);
      const consumed = actorSystem.handlePointerDown(
        pointerNdc,
        camera,
        hit ? { point: hit.point } : null,
      );
      if (consumed) {
        ui?.refreshActorCounts?.();
        _refreshActorsPanel?.();
        ui?.pane.refresh();
      }
      return;
    }
    if (toolState.mode === "decals" && event.button === 0) {
      if (transformControls.dragging) return;
      event.preventDefault();
      if (
        decalSystem.handlePointerDown(
          camera,
          event.clientX,
          event.clientY,
          renderer.domElement,
        )
      ) {
        ui?.pane.refresh();
      }
      return;
    }
    if (
      toolState.mode === "cliffs" &&
      event.button === 0 &&
      !transformControls.dragging
    ) {
      const hit = pickTerrain(event);
      if (hit) {
        const typeIdx = cliffSlotToType[toolState.cliffs.activeSlot];
        if (typeIdx == null) return;
        event.preventDefault();
        const instIdx = cliffSystem.handlePlace(hit.point, typeIdx);
        if (instIdx != null) activateCliffSelection(instIdx);
      }
      return;
    }
    if (
      toolState.mode === "props" &&
      toolState.props.placementMode === "place" &&
      event.button === 0 &&
      !transformControls.dragging
    ) {
      const hit = pickTerrain(event);
      if (hit) {
        const slot = toolState.propSlots[toolState.props.activeSlot];
        if (!slot || slot.typeIdx == null) return;
        event.preventDefault();
        const instIdx = propSystem.handlePlace(hit.point, slot.typeIdx);
        if (instIdx != null) activatePropSelection(instIdx);
      }
      return;
    }
    if (toolState.mode === "road" && event.button === 0) {
      event.preventDefault();
      updatePointer(event);
      raycaster.setFromCamera(pointerNdc, camera);
      const picked = roadSystem.pickPoint(raycaster);
      if (picked >= 0) {
        roadSystem.selectedIdx = picked;
        roadSystem.dragging = true;
        controls.enabled = false;
        roadSystem._rebuildHandles();
        roadSystem._updateSelectedY();
        ui?.pane.refresh();
      } else {
        const hit = pickTerrain(event);
        if (hit) {
          roadSystem.addPoint(hit.point);
          ui?.pane.refresh();
        }
      }
      return;
    }
    if (toolState.mode === "smartRoad2" && event.button === 0) {
      updatePointer(event);
      raycaster.setFromCamera(pointerNdc, camera);
      const hit = smartRoad2System.pickHandle(raycaster);
      const connectKey = event.ctrlKey || event.metaKey || event.shiftKey;
      if (hit?.nodeId !== undefined) {
        event.preventDefault();
        const sel = smartRoad2System.selectedNodeId;
        if (connectKey && sel !== null && sel !== hit.nodeId) {
          smartRoad2System.toggleEdge(sel, hit.nodeId);
          smartRoad2System.selectNode(hit.nodeId); // chain A→B→C
        } else {
          smartRoad2System.selectNode(hit.nodeId);
          sr2.dragNodeId = hit.nodeId;
          controls.enabled = false;
        }
        return;
      }
      if (hit?.edge) {
        event.preventDefault();
        sr2.dragEdge = hit.edge;
        controls.enabled = false;
        return;
      }
      if (event.shiftKey) {
        const th = pickTerrain(event);
        if (th) {
          event.preventDefault();
          smartRoad2System.addNode(th.point.x, th.point.z, true);
        }
      }
      // Plain ground click falls through → camera orbit; selection persists.
      return;
    }
    if (
      (toolState.mode === "fullRoad" || toolState.mode === "smartRoad") &&
      event.button === 0
    ) {
      event.preventDefault();
      updatePointer(event);
      raycaster.setFromCamera(pointerNdc, camera);
      const graphRoadSystem = activeGraphRoadSystem();

      // Decal placement/selection mode
      if (activeGraphRoadParams().decalMode) {
        // Don't interfere with gizmo dragging
        if (transformControls.dragging) return;

        // First try to pick an existing decal
        const pickedDecal = graphRoadSystem.pickDecal(raycaster);
        if (pickedDecal) {
          graphRoadSystem.selectDecal(pickedDecal.id);
          ui?.pane.refresh();
          return;
        }

        // No decal clicked - place a new one
        const hit = pickTerrain(event);
        if (hit) {
          graphRoadSystem.deselectDecal(); // Deselect any selected decal
          graphRoadSystem.placeDecal(hit.point);
          ui?.pane.refresh();
        }
        return;
      }

      // Accessory painting mode (guardrails, kerbs, barriers, fences, tunnels)
      const activeRoadParams = activeGraphRoadParams();
      const accType = activeRoadParams.accessoryType;
      const isPaintMode =
        accType &&
        ((accType === "guardrail" && activeRoadParams.guardrailMode) ||
          (accType === "kerb" && activeRoadParams.kerbMode) ||
          (accType === "barrier" && activeRoadParams.barrierMode) ||
          (accType === "fence" && activeRoadParams.fenceMode) ||
          (accType === "tunnel" && activeRoadParams.tunnelMode));
      // Also check if shift key is held as quick paint mode
      if (isPaintMode || event.shiftKey) {
        const hit = pickTerrain(event);
        if (hit) {
          const started = graphRoadSystem.startAccessoryPaint(
            hit.point,
            accType,
          );
          if (started) {
            graphRoadSystem._paintingAccessoryActive = true;
            controls.enabled = false;
          }
        }
        return;
      }

      if (toolState.mode === "smartRoad" && event.altKey) {
        const hit = pickTerrain(event);
        if (hit) {
          const rp = toolState.smartRoad;
          const r = Math.max(1, rp.branchSnapRadius ?? 12);
          if (smartRoadSystem.trySelectEdgeAt(hit.point, r)) {
            ui?.pane.refresh();
            return;
          }
          smartRoadSystem.clearSelectedEdge();
          ui?.pane.refresh();
          return;
        }
        return;
      }

      const picked = graphRoadSystem.pickNode(raycaster);
      if (picked != null) {
        graphRoadSystem.selectedNodeId = picked;
        if (toolState.mode === "smartRoad") smartRoadSystem.clearSelectedEdge();
        graphRoadSystem.dragging = true;
        controls.enabled = false;
        graphRoadSystem._rebuildHandles();
        graphRoadSystem._updateSelectedY();
        ui?.pane.refresh();
      } else {
        const hit = pickTerrain(event);
        if (hit) {
          if (toolState.mode === "smartRoad")
            smartRoadSystem.clearSelectedEdge();
          graphRoadSystem.addOrConnect(hit.point);
          ui?.pane.refresh();
        }
      }
      return;
    }
    if (toolState.mode === "river" && event.button === 0) {
      event.preventDefault();
      updatePointer(event);
      raycaster.setFromCamera(pointerNdc, camera);
      const picked = riverSystem.pickPoint(raycaster);
      if (picked >= 0) {
        riverSystem.selectedIdx = picked;
        riverSystem.dragging = true;
        controls.enabled = false;
        riverSystem._rebuildHandles();
        riverSystem._updateSelectedY();
        ui?.pane.refresh();
      } else {
        const hit = pickTerrain(event);
        if (hit) {
          riverSystem.addPoint(hit.point);
          ui?.pane.refresh();
        }
      }
      return;
    }
    if (toolState.mode === "spline" && event.button === 0) {
      event.preventDefault();
      updatePointer(event);
      raycaster.setFromCamera(pointerNdc, camera);
      const picked = splineSystem.pickPoint(raycaster);
      if (picked >= 0) {
        splineSystem.selectedIdx = picked;
        splineSystem.dragging = true;
        controls.enabled = false;
        splineSystem._rebuildVisual();
        splineSystem._updateSelectedY();
        ui?.pane.refresh();
      } else {
        const hit = pickTerrain(event);
        if (hit) {
          splineSystem.addPoint(hit.point);
          ui?.pane.refresh();
        }
      }
      return;
    }
    if (toolState.mode === "splineRoad" && event.button === 0) {
      // LEFT-click = ADD a point (clicking a gizmo handle is the gizmo's job).
      if (transformControls.axis) return;
      event.preventDefault();
      const hit = pickTerrain(event);
      if (hit) {
        splineRoadSystem.addPoint(hit.point);
        splineRoadSystem.attachGizmo(transformControls);
        ui?.pane.refresh();
      }
      return;
    }
    if (toolState.mode === "tunnel" && event.button === 0) {
      // LEFT-click = add a tunnel centerline point (entrance face → exit face).
      event.preventDefault();
      const hit = pickTerrain(event);
      if (hit) {
        tunnelSystem.addDraftPoint(hit.point);
        ui?.pane.refresh();
      }
      return;
    }
    if (event.button !== 0 || !isBrushMode()) return;
    const hit = pickTerrain(event);
    if (toolState.mode === "sculpt" && toolState.sculptMode === "ramp") {
      if (!hit) return;
      event.preventDefault();
      if (!sculptSystem.hasRampPointA()) {
        sculptSystem.setRampPointA(hit.point);
      } else {
        sculptSystem.commitRampSecondClick(hit.point);
      }
      syncRampMarker();
      return;
    }
    if (!hit) return;
    event.preventDefault();
    pointerDown = true;
    controls.enabled = false;
    if (toolState.mode === "sculpt") {
      sculptSystem.beginStroke(hit.point, event);
    } else if (toolState.mode === "paint") {
      paintSystem.beginStroke(hit.point, event);
    } else if (toolState.mode === "treePaint") {
      treeSystem.beginStroke(hit.point, event);
    } else if (toolState.mode === "foliagePaint") {
      foliagePaintSystem.beginStroke(hit.point, event);
    } else if (toolState.mode === "billboardGrassPaint") {
      billboardGrassPaintSystem.beginStroke(hit.point, event);
    } else if (toolState.mode === "grass") {
      grassPaintSystem.beginStroke(hit.point, event);
    } else if (toolState.mode === "revoGrass") {
      revoGrassMaskPaintSystem.beginStroke(hit.point, event);
    } else if (toolState.mode === "snow") {
      snowMaskPaintSystem.beginStroke(hit.point, event);
    } else if (toolState.mode === "cliffGrass") {
      cliffGrassPaintSystem.beginStroke(hit.point, event);
    } else if (toolState.mode === "cliffPaint") {
      cliffPaintSystem.beginStroke(hit.point, event);
    } else if (toolState.mode === "props") {
      propSystem.beginStroke(hit.point, event);
    } else if (toolState.mode === "barrier") {
      barrierSystem.beginStroke(hit.point, event);
    } else if (toolState.mode === "hole") {
      holeSystem.beginStroke(hit.point, event);
    } else if (toolState.mode === "cave") {
      // One-shot placement — no brush stroke; one click = one cave.
      caveSystem.placeAt(hit.point);
    } else if (toolState.mode === "fleurs") {
      paintFleurAt(
        hit.point.x,
        hit.point.z,
        toolState.fleur.erase || event.shiftKey,
      );
    } else if (toolState.mode === "ambientfx") {
      paintAmbientFxAt(
        hit.point.x,
        hit.point.z,
        toolState.ambientFx.erase || event.shiftKey,
      );
    }
  });

  renderer.domElement.addEventListener("pointermove", (event) => {
    if (toolState.mode === "play") return;
    if (toolState.mode === "smartRoad2" && (sr2.dragNodeId !== null || sr2.dragEdge)) {
      const hit = pickTerrain(event);
      if (!hit) return;
      if (sr2.dragNodeId !== null) {
        smartRoad2System.moveNode(sr2.dragNodeId, hit.point.x, hit.point.z);
      } else if (sr2.dragEdge) {
        const f = smartRoad2System.edgeMidFrame(sr2.dragEdge);
        if (f) {
          let bend = (hit.point.x - f.mx) * f.px + (hit.point.z - f.mz) * f.pz;
          const cap = f.chord * 0.45;
          bend = Math.max(-cap, Math.min(cap, bend));
          if (Math.abs(bend) < 1.5) bend = 0;
          smartRoad2System.setEdgeBend(sr2.dragEdge, bend);
        }
      }
      return;
    }
    if (
      toolState.mode === "road" &&
      roadSystem.dragging &&
      roadSystem.selectedIdx >= 0
    ) {
      const hit = pickTerrain(event);
      if (hit) roadSystem.moveSelected(hit.point);
      return;
    }
    if (
      (toolState.mode === "fullRoad" || toolState.mode === "smartRoad") &&
      activeGraphRoadSystem().dragging &&
      activeGraphRoadSystem().selectedNodeId != null
    ) {
      const hit = pickTerrain(event);
      if (hit) activeGraphRoadSystem().moveSelected(hit.point);
      return;
    }
    if (
      (toolState.mode === "fullRoad" || toolState.mode === "smartRoad") &&
      activeGraphRoadSystem()._paintingAccessoryActive
    ) {
      const hit = pickTerrain(event);
      if (hit) activeGraphRoadSystem().continueAccessoryPaint(hit.point);
      return;
    }
    // Decal preview on hover
    if (
      (toolState.mode === "fullRoad" || toolState.mode === "smartRoad") &&
      activeGraphRoadParams().decalMode
    ) {
      const hit = pickTerrain(event);
      if (hit) {
        activeGraphRoadSystem().updateDecalPreview(hit.point);
      }
    }
    if (
      toolState.mode === "river" &&
      riverSystem.dragging &&
      riverSystem.selectedIdx >= 0
    ) {
      const hit = pickTerrain(event);
      if (hit) riverSystem.moveSelected(hit.point);
      return;
    }
    if (
      toolState.mode === "spline" &&
      splineSystem.dragging &&
      splineSystem.selectedIdx >= 0
    ) {
      const hit = pickTerrain(event);
      if (hit) splineSystem.moveSelected(hit.point);
      return;
    }
    if (
      toolState.mode === "splineRoad" &&
      splineRoadSystem.dragging &&
      splineRoadSystem.selectedIdx >= 0
    ) {
      const hit = pickTerrain(event);
      if (hit) splineRoadSystem.moveSelected(hit.point);
      return;
    }
    const hit = pickTerrain(event);
    updateBrushPreviewFromPick(hit);
    if (!pointerDown || !isBrushMode() || !hit) return;
    if (toolState.mode === "sculpt") {
      sculptSystem.applyAt(hit.point, event);
    } else if (toolState.mode === "paint") {
      paintSystem.applyAt(hit.point, event);
    } else if (toolState.mode === "treePaint") {
      treeSystem.applyAt(hit.point, event);
    } else if (toolState.mode === "foliagePaint") {
      foliagePaintSystem.applyAt(hit.point, event);
    } else if (toolState.mode === "billboardGrassPaint") {
      billboardGrassPaintSystem.applyAt(hit.point, event);
    } else if (toolState.mode === "grass") {
      grassPaintSystem.applyAt(hit.point, event);
    } else if (toolState.mode === "revoGrass") {
      revoGrassMaskPaintSystem.applyAt(hit.point, event);
    } else if (toolState.mode === "snow") {
      snowMaskPaintSystem.applyAt(hit.point, event);
    } else if (toolState.mode === "cliffGrass") {
      cliffGrassPaintSystem.applyAt(hit.point, event);
    } else if (toolState.mode === "cliffPaint") {
      cliffPaintSystem.applyAt(hit.point, event);
    } else if (toolState.mode === "props") {
      propSystem.applyAt(hit.point, event);
    } else if (toolState.mode === "barrier") {
      barrierSystem.applyAt(hit.point, event);
    } else if (toolState.mode === "hole") {
      holeSystem.applyAt(hit.point, event);
    } else if (toolState.mode === "fleurs") {
      paintFleurAt(
        hit.point.x,
        hit.point.z,
        toolState.fleur.erase || event.shiftKey,
      );
    } else if (toolState.mode === "ambientfx") {
      paintAmbientFxAt(
        hit.point.x,
        hit.point.z,
        toolState.ambientFx.erase || event.shiftKey,
      );
    }
  });

  // splatmap-chunks-main.js: Shift+wheel → brush size, Alt+wheel → strength (Shift wins if both).
  function onCanvasWheelBrush(e) {
    if (!e.shiftKey && !e.altKey) return;
    e.preventDefault();
    e.stopPropagation();
    const dir = e.deltaY < 0 ? 1 : -1;
    if (e.shiftKey) {
      toolState.brush.radius = THREE.MathUtils.clamp(
        toolState.brush.radius + dir * 2,
        config.sculpt.brushMin,
        config.sculpt.brushMax,
      );
    } else {
      toolState.brush.strength = THREE.MathUtils.clamp(
        toolState.brush.strength + dir * 0.05,
        config.sculpt.strengthMin,
        config.sculpt.strengthMax,
      );
    }
    ui?.refreshBrush?.();
  }
  renderer.domElement.addEventListener("wheel", onCanvasWheelBrush, {
    passive: false,
    capture: true,
  });

  renderer.domElement.addEventListener("contextmenu", (event) => {
    if (toolState.mode === "cliffs") {
      event.preventDefault();
      updatePointer(event);
      raycaster.setFromCamera(pointerNdc, camera);
      const hit = cliffInstancer.raycast(raycaster);
      if (hit) {
        activateCliffSelection(hit.instIdx);
      } else {
        deactivateCliffSelection();
      }
    } else if (toolState.mode === "props") {
      event.preventDefault();
      updatePointer(event);
      raycaster.setFromCamera(pointerNdc, camera);
      const hitStatic = propInstancer.raycast(raycaster);
      const hitLive = livePropManager.raycast(raycaster);
      const hit =
        !hitStatic && !hitLive
          ? null
          : !hitStatic
            ? hitLive
            : !hitLive
              ? hitStatic
              : hitLive.distance < hitStatic.distance
                ? hitLive
                : hitStatic;
      if (hit) {
        activatePropSelection(hit.instIdx);
      } else {
        deactivatePropSelection();
      }
    } else if (toolState.mode === "splineRoad") {
      // RIGHT-click selects a road point (makes its road active). A click doesn't
      // pan, so this never adds a point by accident; right-DRAG still pans.
      event.preventDefault();
      updatePointer(event);
      raycaster.setFromCamera(pointerNdc, camera);
      if (splineRoadSystem.selectFromRaycaster(raycaster)) {
        splineRoadSystem.attachGizmo(transformControls);
        ui?.pane.refresh();
      }
    }
  });

  window.addEventListener("pointerup", () => {
    if (sr2.dragNodeId !== null || sr2.dragEdge) {
      sr2.dragNodeId = null;
      sr2.dragEdge = null;
      controls.enabled = true;
    }
    if (roadSystem.dragging) {
      roadSystem.dragging = false;
      controls.enabled = true;
    }
    if (fullRoadSystem.dragging) {
      fullRoadSystem.dragging = false;
      controls.enabled = true;
    }
    if (smartRoadSystem.dragging) {
      smartRoadSystem.dragging = false;
      controls.enabled = true;
    }
    if (fullRoadSystem._paintingAccessoryActive) {
      fullRoadSystem._paintingAccessoryActive = false;
      fullRoadSystem.endAccessoryPaint();
      controls.enabled = true;
      ui?.pane.refresh();
    }
    if (smartRoadSystem._paintingAccessoryActive) {
      smartRoadSystem._paintingAccessoryActive = false;
      smartRoadSystem.endAccessoryPaint();
      controls.enabled = true;
      ui?.pane.refresh();
    }
    if (riverSystem.dragging) {
      riverSystem.dragging = false;
      controls.enabled = true;
    }
    if (splineSystem.dragging) {
      splineSystem.dragging = false;
      controls.enabled = true;
    }
    if (splineRoadSystem.dragging) {
      splineRoadSystem.dragging = false;
      controls.enabled = true;
    }
    if (!pointerDown) return;
    pointerDown = false;
    controls.enabled = true;
    if (toolState.mode === "sculpt") {
      sculptSystem.endStroke();
    } else if (toolState.mode === "paint") {
      paintSystem.endStroke();
    } else if (toolState.mode === "treePaint") {
      treeSystem.endStroke();
    } else if (toolState.mode === "foliagePaint") {
      foliagePaintSystem.endStroke();
    } else if (toolState.mode === "billboardGrassPaint") {
      billboardGrassPaintSystem.endStroke();
    } else if (toolState.mode === "grass") {
      grassPaintSystem.endStroke();
    } else if (toolState.mode === "revoGrass") {
      revoGrassMaskPaintSystem.endStroke();
    } else if (toolState.mode === "snow") {
      snowMaskPaintSystem.endStroke();
    } else if (toolState.mode === "cliffGrass") {
      cliffGrassPaintSystem.endStroke();
    } else if (toolState.mode === "cliffPaint") {
      cliffPaintSystem.endStroke();
    } else if (toolState.mode === "props") {
      propSystem.endStroke();
    } else if (toolState.mode === "barrier") {
      barrierSystem.endStroke();
    } else if (toolState.mode === "hole") {
      holeSystem.endStroke();
    }
  });

  function activeEditSystem() {
    if (toolState.mode === "paint") return paintSystem;
    if (toolState.mode === "treePaint") return treeSystem;
    if (toolState.mode === "foliagePaint") return foliagePaintSystem;
    if (toolState.mode === "billboardGrassPaint")
      return billboardGrassPaintSystem;
    if (toolState.mode === "grass") return grassPaintSystem;
    if (toolState.mode === "revoGrass") return revoGrassMaskPaintSystem;
    if (toolState.mode === "snow") return snowMaskPaintSystem;
    if (toolState.mode === "cliffGrass") return cliffGrassPaintSystem;
    if (toolState.mode === "cliffPaint") return cliffPaintSystem;
    if (toolState.mode === "road") return roadSystem;
    if (toolState.mode === "fullRoad") return fullRoadSystem;
    if (toolState.mode === "smartRoad") return smartRoadSystem;
    if (toolState.mode === "river") return riverSystem;
    if (toolState.mode === "spline") return splineSystem;
    if (toolState.mode === "splineRoad") return splineRoadSystem;
    if (toolState.mode === "cliffs") return cliffSystem;
    if (toolState.mode === "props") return propSystem;
    if (toolState.mode === "water") return waterSystem;
    if (toolState.mode === "waterfall") return waterfallSystem;
    if (toolState.mode === "actors") return actorSystem;
    if (toolState.mode === "decals") return decalSystem;
    if (toolState.mode === "barrier") return barrierSystem;
    if (toolState.mode === "hole") return holeSystem;
    if (toolState.mode === "cave") return caveSystem;
    if (toolState.mode === "tunnel") return tunnelSystem;
    return sculptSystem;
  }

  window.addEventListener("keydown", (event) => {
    if (event.defaultPrevented) return;
    const ctrl = event.ctrlKey || event.metaKey;
    // Shift held → enable rotation snap on the gizmo (industry-standard
    // muscle memory). We only react when in a gizmo mode to avoid surprising
    // users elsewhere. Repeat fires while held; bail on repeat to avoid
    // re-applying every frame.
    if (event.code === "ShiftLeft" || event.code === "ShiftRight") {
      if (!event.repeat && GIZMO_MODES.has(toolState.mode)) {
        _gizmoShiftHeld = true;
        applyGizmoSettings();
      }
    }
    if (
      !ctrl &&
      event.code === "KeyQ" &&
      GIZMO_MODES.has(toolState.mode) &&
      !playMode.active
    ) {
      event.preventDefault();
      toolState.gizmo.space =
        toolState.gizmo.space === "local" ? "world" : "local";
      applyGizmoSettings();
      ui?.pane.refresh();
      return;
    }
    if (ctrl && event.code === "KeyZ") {
      event.preventDefault();
      const sys = activeEditSystem();
      if (event.shiftKey) sys.redo();
      else sys.undo();
    } else if (ctrl && event.code === "KeyY") {
      event.preventDefault();
      activeEditSystem().redo();
    } else if (event.code === "Delete" && toolState.mode === "road") {
      event.preventDefault();
      roadSystem.deleteSelected();
      ui?.pane.refresh();
    } else if (
      event.code === "Delete" &&
      (toolState.mode === "fullRoad" || toolState.mode === "smartRoad")
    ) {
      event.preventDefault();
      activeGraphRoadSystem().deleteSelected();
      ui?.pane.refresh();
    } else if (
      (event.code === "Delete" || event.code === "KeyX") &&
      toolState.mode === "smartRoad2"
    ) {
      event.preventDefault();
      if (smartRoad2System.selectedNodeId !== null) {
        smartRoad2System.deleteNode(smartRoad2System.selectedNodeId);
      }
    } else if (event.code === "KeyJ" && toolState.mode === "smartRoad2" && !ctrl) {
      event.preventDefault();
      if (smartRoad2System.selectedNodeId !== null) {
        smartRoad2System.cycleNodeType(smartRoad2System.selectedNodeId);
      }
    } else if (event.code === "Delete" && toolState.mode === "river") {
      event.preventDefault();
      riverSystem.deleteSelected();
      ui?.pane.refresh();
    } else if (event.code === "Delete" && toolState.mode === "splineRoad") {
      event.preventDefault();
      splineRoadSystem.deleteSelected();
      ui?.pane.refresh();
    } else if (event.code === "Delete" && toolState.mode === "spline") {
      event.preventDefault();
      splineSystem.deleteSelected();
      ui?.pane.refresh();
    } else if (
      (event.code === "Enter" || event.code === "NumpadEnter") &&
      toolState.mode === "tunnel" &&
      event.target?.tagName !== "INPUT" &&
      event.target?.tagName !== "TEXTAREA"
    ) {
      event.preventDefault();
      if (tunnelSystem.createFromDraft()) ui?.pane.refresh();
    } else if (
      event.code === "Backspace" &&
      toolState.mode === "tunnel" &&
      event.target?.tagName !== "INPUT" &&
      event.target?.tagName !== "TEXTAREA"
    ) {
      event.preventDefault();
      tunnelSystem.removeLastDraftPoint();
      ui?.pane.refresh();
    } else if (event.code === "Escape" && toolState.mode === "tunnel") {
      event.preventDefault();
      tunnelSystem.cancelDraft();
      ui?.pane.refresh();
    } else if (
      event.code === "KeyR" &&
      toolState.mode === "sculpt" &&
      toolState.sculptMode === "ramp" &&
      sculptSystem.hasRampPointA()
    ) {
      event.preventDefault();
      sculptSystem.clearRampPoint();
      syncRampMarker();
    } else if (event.code === "Delete" && toolState.mode === "cliffs") {
      event.preventDefault();
      cliffSystem.handleDelete();
      deactivateCliffSelection();
    } else if (event.code === "Delete" && toolState.mode === "props") {
      event.preventDefault();
      propSystem.handleDelete();
      deactivatePropSelection();
    } else if (ctrl && event.code === "KeyD" && toolState.mode === "props") {
      event.preventDefault();
      const newIdx = propSystem.handleDuplicate();
      if (newIdx != null) {
        activatePropSelection(newIdx);
        ui?.pane.refresh();
      }
    } else if (
      event.code === "KeyW" &&
      !ctrl &&
      toolState.mode !== "cliffs" &&
      toolState.mode !== "props" &&
      toolState.mode !== "water" &&
      toolState.mode !== "waterfall" &&
      toolState.mode !== "actors" &&
      toolState.mode !== "decals" &&
      toolState.mode !== "splineRoad" &&
      toolState.mode !== "play"
    ) {
      event.preventDefault();
      toolState.mode = "water";
      applyModeChangedEffects();
    } else if (event.code === "KeyW" && !ctrl && toolState.mode === "water") {
      event.preventDefault();
      toolState.mode = "view";
      applyModeChangedEffects();
    } else if (event.code === "Delete" && toolState.mode === "water") {
      event.preventDefault();
      waterSystem.deleteSelected();
      ui?.pane.refresh();
    } else if (event.code === "Delete" && toolState.mode === "waterfall") {
      event.preventDefault();
      waterfallSystem.deleteSelected();
      ui?.pane.refresh();
    } else if (event.code === "Delete" && toolState.mode === "actors") {
      event.preventDefault();
      actorSystem.deleteSelected();
      ui?.refreshActorCounts?.();
      _refreshActorsPanel?.();
      ui?.pane.refresh();
    } else if (event.code === "Delete" && toolState.mode === "decals") {
      event.preventDefault();
      decalSystem.deleteSelected();
      ui?.pane.refresh();
    } else if (
      event.code === "KeyD" &&
      !ctrl &&
      toolState.mode !== "play" &&
      toolState.mode !== "decals"
    ) {
      event.preventDefault();
      toolState.mode = "decals";
      applyModeChangedEffects();
    } else if (event.code === "KeyD" && !ctrl && toolState.mode === "decals") {
      event.preventDefault();
      toolState.mode = "view";
      applyModeChangedEffects();
    } else if (toolState.mode === "water" && !ctrl) {
      if (event.code === "KeyE") {
        event.preventDefault();
        waterSystem.setTransformMode("translate");
      } else if (event.code === "KeyR") {
        event.preventDefault();
        waterSystem.setTransformMode("rotate");
      } else if (event.code === "KeyT") {
        event.preventDefault();
        waterSystem.setTransformMode("scale");
      }
    } else if (event.code === "KeyH" && !ctrl && !playMode.active) {
      event.preventDefault();
      toolState.mode = toolState.mode === "waterfall" ? "view" : "waterfall";
      applyModeChangedEffects();
    } else if (event.code === "KeyN" && !ctrl && !playMode.active) {
      event.preventDefault();
      toolState.mode = toolState.mode === "actors" ? "view" : "actors";
      applyModeChangedEffects();
      ui?.pane.refresh();
    } else if (toolState.mode === "decals" && !ctrl) {
      if (event.code === "KeyW") {
        event.preventDefault();
        decalSystem.setTransformMode("translate");
        ui?.pane.refresh();
      } else if (event.code === "KeyE") {
        event.preventDefault();
        decalSystem.setTransformMode("rotate");
        ui?.pane.refresh();
      } else if (event.code === "KeyR") {
        event.preventDefault();
        decalSystem.setTransformMode("scale");
        ui?.pane.refresh();
      }
    } else if (toolState.mode === "waterfall" && !ctrl) {
      if (event.code === "KeyW") {
        event.preventDefault();
        toolState.waterfall.transformMode = "translate";
        transformControls.setMode("translate");
        ui?.pane.refresh();
      } else if (event.code === "KeyE") {
        event.preventDefault();
        toolState.waterfall.transformMode = "rotate";
        transformControls.setMode("rotate");
        ui?.pane.refresh();
      } else if (event.code === "KeyR") {
        event.preventDefault();
        toolState.waterfall.transformMode = "scale";
        transformControls.setMode("scale");
        ui?.pane.refresh();
      }
    } else if (toolState.mode === "actors" && !ctrl) {
      if (event.code === "KeyW") {
        event.preventDefault();
        toolState.actors.transformMode = "translate";
        transformControls.setMode("translate");
        ui?.pane.refresh();
      } else if (event.code === "KeyE") {
        event.preventDefault();
        toolState.actors.transformMode = "rotate";
        transformControls.setMode("rotate");
        ui?.pane.refresh();
      } else if (event.code === "KeyR") {
        event.preventDefault();
        toolState.actors.transformMode = "scale";
        transformControls.setMode("scale");
        ui?.pane.refresh();
      }
    } else if (toolState.mode === "splineRoad" && !ctrl) {
      // W = Move the point, E = Tilt (bank) the deck — same gizmo shortcuts as
      // the other gizmo modes. setGizmoMode re-attaches with the right setup.
      if (event.code === "KeyW") {
        event.preventDefault();
        splineRoadSystem.setGizmoMode("translate");
      } else if (event.code === "KeyE") {
        event.preventDefault();
        splineRoadSystem.setGizmoMode("rotate");
      }
    } else if (toolState.mode === "cliffs" && !ctrl) {
      if (event.code === "KeyW") {
        toolState.cliffs.transformMode = "translate";
        transformControls.setMode("translate");
        ui?.pane.refresh();
      } else if (event.code === "KeyE") {
        toolState.cliffs.transformMode = "rotate";
        transformControls.setMode("rotate");
        ui?.pane.refresh();
      } else if (event.code === "KeyR") {
        toolState.cliffs.transformMode = "scale";
        transformControls.setMode("scale");
        ui?.pane.refresh();
      } else if (event.code >= "Digit1" && event.code <= "Digit5") {
        const slot = parseInt(event.code.charAt(5)) - 1;
        if (slot < toolState.cliffSlots.length) {
          toolState.cliffs.activeSlot = slot;
          ui?.pane.refresh();
        }
      }
    } else if (toolState.mode === "props" && !ctrl) {
      if (event.code === "KeyW") {
        toolState.props.transformMode = "translate";
        transformControls.setMode("translate");
        ui?.pane.refresh();
      } else if (event.code === "KeyE") {
        toolState.props.transformMode = "rotate";
        transformControls.setMode("rotate");
        ui?.pane.refresh();
      } else if (event.code === "KeyR") {
        toolState.props.transformMode = "scale";
        transformControls.setMode("scale");
        ui?.pane.refresh();
      }
    } else if (event.code === "KeyK" && !ctrl && !playMode.active) {
      event.preventDefault();
      toolState.mode = toolState.mode === "spline" ? "view" : "spline";
      applyModeChangedEffects();
    } else if (event.code === "KeyV" && !ctrl && !playMode.active) {
      event.preventDefault();
      toolState.mode = toolState.mode === "river" ? "view" : "river";
      applyModeChangedEffects();
    } else if (event.code === "KeyM" && !ctrl && !playMode.active) {
      event.preventDefault();
      toolState.mode = toolState.mode === "fleurs" ? "view" : "fleurs";
      applyModeChangedEffects();
    } else if (event.code === "KeyX" && !ctrl && !playMode.active) {
      event.preventDefault();
      toolState.mode = toolState.mode === "ambientfx" ? "view" : "ambientfx";
      applyModeChangedEffects();
    } else if (
      event.code === "KeyF" &&
      !ctrl &&
      !playMode.active &&
      toolState.mode !== "play"
    ) {
      event.preventDefault();
      _pendingPlayImmersive = event.shiftKey === true;
      toolState.mode = "play";
      applyModeChangedEffects();
    } else if (event.code === "KeyP" && !ctrl && !playMode.active) {
      event.preventDefault();
      toolState.mode = toolState.mode === "paint" ? "view" : "paint";
      applyModeChangedEffects();
    } else if (event.code === "KeyT" && !ctrl && !playMode.active) {
      event.preventDefault();
      toolState.mode = toolState.mode === "treePaint" ? "view" : "treePaint";
      applyModeChangedEffects();
    } else if (event.code === "KeyS" && !ctrl && !playMode.active) {
      event.preventDefault();
      toolState.mode = toolState.mode === "sculpt" ? "view" : "sculpt";
      applyModeChangedEffects();
    } else if (event.code === "KeyG" && !ctrl && !playMode.active) {
      event.preventDefault();
      toolState.mode = toolState.mode === "grass" ? "view" : "grass";
      applyModeChangedEffects();
    } else if (event.code === "KeyI" && !ctrl && !playMode.active) {
      event.preventDefault();
      toolState.mode = toolState.mode === "props" ? "view" : "props";
      applyModeChangedEffects();
    } else if (event.code === "KeyO" && !ctrl && !playMode.active) {
      event.preventDefault();
      toolState.mode = toolState.mode === "cliffs" ? "view" : "cliffs";
      applyModeChangedEffects();
    } else if (event.code === "KeyL" && !ctrl && !playMode.active) {
      event.preventDefault();
      toolState.mode =
        toolState.mode === "foliagePaint" ? "view" : "foliagePaint";
      applyModeChangedEffects();
    } else if (event.code === "KeyU" && !ctrl && !playMode.active) {
      event.preventDefault();
      toolState.mode =
        toolState.mode === "billboardGrassPaint"
          ? "view"
          : "billboardGrassPaint";
      applyModeChangedEffects();
    } else if (event.code === "KeyY" && !ctrl && !playMode.active) {
      event.preventDefault();
      toolState.mode = toolState.mode === "revoGrass" ? "view" : "revoGrass";
      applyModeChangedEffects();
    } else if (event.code === "KeyB" && !ctrl && !playMode.active) {
      event.preventDefault();
      toolState.mode = toolState.mode === "barrier" ? "view" : "barrier";
      applyModeChangedEffects();
    } else if (event.code === "KeyZ" && !ctrl && !playMode.active) {
      event.preventDefault();
      toolState.mode = toolState.mode === "playSpawn" ? "view" : "playSpawn";
      applyModeChangedEffects();
    }
  });

  // Release the Shift-snap modifier. We don't gate on mode here so the
  // gizmo's snap is always cleared on key release, even if the user switched
  // modes while holding Shift.
  window.addEventListener("keyup", (event) => {
    if (event.code === "ShiftLeft" || event.code === "ShiftRight") {
      if (_gizmoShiftHeld) {
        _gizmoShiftHeld = false;
        applyGizmoSettings();
      }
    }
  });
  // Clearing on blur prevents a "stuck snap" if the user Alt-Tabs while
  // holding Shift mid-drag and never sees the keyup.
  window.addEventListener("blur", () => {
    if (_gizmoShiftHeld) {
      _gizmoShiftHeld = false;
      applyGizmoSettings();
    }
  });

  function _onViewportResize() {
    const rw = _uiContainer ? _uiContainer.clientWidth : window.innerWidth;
    const rh = _uiContainer ? _uiContainer.clientHeight : window.innerHeight;
    camera.aspect = rw / Math.max(rh, 1);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    renderer.setSize(rw, rh);
    volumetricCloudSystem?.setDepthTargetSize?.();
    volumetricCloudSystemOptimized?.setDepthTargetSize?.();
    volumetricCloudSystemV3?.setDepthTargetSize?.();
    postFxPipeline.setSize(rw, rh);
    if (csm?.mainFrustum && toolState.csm.enabled) csm.updateFrustums();
  }
  if (_uiContainer) {
    new ResizeObserver(_onViewportResize).observe(_uiContainer);
  } else {
    window.addEventListener("resize", _onViewportResize);
  }

  let last = performance.now();
  let _lastLightSnap = "";
  let _lastProcSkySnap = "";
  let _lastInteriorSnap = "";
  const _interiorFocusPos = new THREE.Vector3();
  // World ocean: initial sun/env + params (sky & sun are set up by now).
  worldOcean.setSunDir(sunDir);
  worldOcean.setEnvMap(scene.environment);
  _oceanEnvRef = scene.environment;
  worldOcean.syncParams(toolState.worldOcean);

  // --- Pipeline pre-warm for the lazily-built systems --------------------------
  // Foliage (per-chunk, disposed on prune) and billboards are built/torn down at
  // runtime, so their pipelines compile on FIRST DRAW during play — the orbit
  // stutter. Trees/props/terrain create their meshes once and persist, so the
  // load-time compileAsync already covers them. Here we instantiate ONE
  // representative mesh per foliage/billboard slot (real geometry + shared
  // material → the exact pipeline), park it far below the world, compile, then
  // dispose. compileAsync also re-covers everything persistent in the scene.
  // Runs once per play-mode entry (re-armed on exit) so edits are picked up.
  const _pwMat = new THREE.Matrix4();
  let _prewarmRunning = false;
  let _prewarmedForPlay = false;
  async function prewarmLazyPipelines() {
    if (_prewarmRunning) return;
    _prewarmRunning = true;
    const temp = []; // { mesh, disposeGeo }
    try {
      // Foliage: real build path → correct instanced attributes (aRand/aLeafCenter/…).
      const fakeTree = {
        x: 0,
        y: -100000,
        z: 0,
        rotY: 0,
        scale: 1,
        slotIdx: 0,
      };
      for (let s = 0; s < foliageLodRenderer.slotPresets.length; s++) {
        if (!foliageLodRenderer.slotPresets[s]) continue;
        fakeTree.slotIdx = s;
        for (let lod = 0; lod < 3; lod++) {
          const im = foliageLodRenderer._buildChunkSlotLod([fakeTree], s, lod);
          if (im) {
            im.visible = true; // off-screen at y=-100000, frustumCulled stays false
            scene.add(im);
            temp.push({ mesh: im, disposeGeo: true }); // geometry is a clone — safe to dispose
          }
        }
      }
      // Billboards: shared geometry + material, instanceMatrix only.
      _pwMat.makeTranslation(0, -100000, 0);
      for (let s = 0; s < billboardRenderer.slotRender.length; s++) {
        const sr = billboardRenderer.slotRender[s];
        if (!sr || !sr.material) continue;
        for (const k of ["lod0", "lod1", "lod2"]) {
          const geo = sr.geometries?.[k];
          if (!geo) continue;
          const im = new THREE.InstancedMesh(geo, sr.material, 1);
          im.castShadow = false;
          im.receiveShadow = true;
          im.frustumCulled = false;
          im.setMatrixAt(0, _pwMat);
          im.count = 1;
          im.instanceMatrix.needsUpdate = true;
          scene.add(im);
          temp.push({ mesh: im, disposeGeo: false }); // shared geo — do NOT dispose
        }
      }
      camera.updateMatrixWorld();
      await renderer.compileAsync(scene, camera);
    } catch (e) {
      console.warn("[prewarm] skipped:", e);
    } finally {
      for (const { mesh, disposeGeo } of temp) {
        scene.remove(mesh);
        // InstancedMesh.dispose() frees the instance buffers only (not the shared
        // material). Dispose the geometry separately, and only the foliage clones.
        mesh.dispose?.();
        if (disposeGeo) mesh.geometry?.dispose?.();
      }
      _prewarmRunning = false;
    }
  }

  // --- frameProbe wiring (TEMPORARY perf attribution; remove with the import) ---
  // Wrap each system's lazy (re)build method so the probe can count how many
  // InstancedMeshes are (re)built per frame and how long that CPU work took.
  {
    const wrapBuild = (
      obj,
      method,
      counter,
      msCounter,
      countWhenTruthy = false,
    ) => {
      if (!obj || typeof obj[method] !== "function") return;
      const orig = obj[method].bind(obj);
      obj[method] = (...args) => {
        const t = performance.now();
        const r = orig(...args);
        if (!countWhenTruthy || r) frameProbe.c[counter]++;
        frameProbe.c[msCounter] += performance.now() - t;
        return r;
      };
    };
    wrapBuild(
      foliageLodRenderer,
      "_buildChunkSlotLod",
      "foliage",
      "foliageMs",
      true,
    );
    wrapBuild(
      billboardRenderer,
      "_rebuildChunkMeshes",
      "billboard",
      "billboardMs",
    );
    wrapBuild(treeLodRenderer, "_rebuildChunkCache", "tree", "treeMs");
    wrapBuild(propInstancer, "_rebuildCache", "prop", "propMs");
    wrapBuild(chunkStream, "createChunk", "chunk", "chunkMs");
  }

  renderer.setAnimationLoop(() => {
    // Reset info once per frame (auto-reset is off) so draw/tri counters
    // accumulate across all passes. stats-gl patches this call to also mark
    // the start of its CPU profiling window — placing it first means the CPU
    // panel now measures the whole frame's JS, not just render submission.
    renderer.info.reset();

    const now = performance.now();
    const dtMs = now - last;
    last = now;
    tickPerf(perf, now, dtMs);
    frameProbe.beginFrame();

    if (!playMode.active) controls.update();
    const dtSec = dtMs * 0.001;
    playMode.update(dtSec);
    smartRoad2System.setEditActive(toolState.mode === "smartRoad2");
    smartRoad2System.update();
    // Pre-warm foliage/billboard pipelines once when entering play (re-arm on exit
    // so world edits are recompiled). Fire-and-forget: compiles behind the scene
    // so first-draw shader stalls don't hit during flight.
    if (playMode.active) {
      if (!_prewarmedForPlay) {
        _prewarmedForPlay = true;
        prewarmLazyPipelines();
      }
    } else if (_prewarmedForPlay) {
      _prewarmedForPlay = false;
    }
    if (playMode.active) {
      actorSystem.updatePlay(dtSec, playMode.playerPos);
      dialogueRunner.update(playMode.playerPos);
    }
    audioSystem.update(dtSec);
    camera.updateMatrixWorld();
    const focusPos = playMode.active ? playMode.playerPos : camera.position;
    /** Cloud volume follow anchor — same idea as superjet `playerPos`, not the orbit camera. */
    const cloudFollowAnchor = playMode.active
      ? playMode.playerPos
      : controls.target;

    const Li = toolState.light;
    const S = toolState.physicalSky;
    const lightSnap = `${Li.sunAzimuth},${Li.sunElevation},${Li.dirColor},${Li.dirIntensity},${Li.moonIntensity},${toolState.proceduralSky.moonColor},${Li.hemiSkyColor},${Li.hemiGroundColor},${Li.hemiIntensity},${Li.shadowBias},${Li.shadowNormalBias},${Li.exposure},${Li.envIntensity},${Li.hdrEnvIntensity},${Li.hdrBackgroundIntensity},${Li.sunDistance},${S.turbidity},${S.rayleigh},${S.mie},${S.mieG},${S.cloudCoverage},${S.cloudDensity},${S.cloudElevation},${S.meshScale}`;
    if (lightSnap !== _lastLightSnap) {
      _lastLightSnap = lightSnap;
      updateSunSky(); // sets `_effectiveLightDir` (sun by day / moon at night)
      // Foliage / grass / ocean relight from the same key-light direction as the
      // terrain — so they're moon-lit at night, not lit from the buried sun.
      if (grassManager.uniforms)
        grassManager.uniforms.uSunDir.value.copy(_effectiveLightDir);
      if (toolState.revoGrass.enabled) {
        revoGrassSystem.syncFromState(toolState.revoGrass, _effectiveLightDir);
      }
      foliageLodRenderer.updateSunDirection(_effectiveLightDir);
      billboardRenderer.updateSunDirection(_effectiveLightDir);
      billboardGrassRenderer.updateSunDirection(_effectiveLightDir);
      worldOcean.setSunDir(_effectiveLightDir);
    }
    lensFlare.update();

    // Aerial-perspective fog: warm tint toward the sun + sky-matched away color
    // (only matters when distance fog is on; cheap uniform writes otherwise).
    if (toolState.fog.distance.enabled) driveFogSun();

    // Procedural dome: drive every frame (camera follow + star/cloud animation),
    // and re-bake its IBL only when the IBL-relevant params or the sun change.
    if (toolState.skyMode === "procedural") {
      const ps = toolState.proceduralSky;
      // CLAMP the time step (matches lab `Math.min(getDelta(), 0.05)`) so a frame
      // hitch can't lurch the sun forward — even progression regardless of FPS.
      const procDt = Math.min(dtSec, 0.05);
      // Auto day/night cycle: advance timeOfDay → sun az/el (the single source).
      if (ps.autoAdvance) {
        setTimeOfDay((ps.timeOfDay + ps.daySpeed * procDt) % 24);
      }
      driveProceduralSky();
      // A param/sun change requests a fresh IBL bake (promptly, but amortized).
      const procSnap = `${Li.sunAzimuth},${Li.sunElevation},${ps.scatter},${ps.rayleigh},${ps.mie},${ps.mieG},${ps.sunIntensity},${ps.msAmount},${ps.msExtinct},${ps.zenithDay},${ps.horizonDay},${ps.zenithNight},${ps.horizonNight},${ps.sunsetColor},${ps.groundColor},${ps.sunColor},${ps.moonColor},${ps.cloudEnabled},${ps.cloudCoverage},${ps.cloudColor}`;
      if (procSnap !== _lastProcSkySnap) {
        _lastProcSkySnap = procSnap;
        _procEnvNeeds = true;
        // Manual tweaks: debounce — keep resetting the idle so we only bake ~0.3 s
        // AFTER you stop dragging (no baking mid-drag). Auto-advance changes every
        // frame, so leave its idle alone → it bakes on the steady PROC_ENV_IDLE.
        if (!ps.autoAdvance) _procEnvIdle = 0.3;
      }
      // Amortized IBL bake: one cube face per frame, convolve on completion, then
      // idle — never a single-frame full bake, so no per-frame stutter.
      updateProcEnvBake(procDt);
    }

    const Int = toolState.interior;
    const interiorSnap = `${Int.enabled},${Int.strength},${Int.color},${Int.ambientScale},${Int.tunnelRadiusScale},${Int.segmentStep},${Int.edgeSoftness},${Int.openingLength},${Int.boxEdgeSoftness},${Int.caveShrink},${splineSystem.tunnels.length}`;
    if (interiorSnap !== _lastInteriorSnap) {
      _lastInteriorSnap = interiorSnap;
      syncInteriorUniforms();
    }
    let fillScale = 1;
    if (Int.enabled) {
      _interiorFocusPos.copy(focusPos);
      const interiorAmb = interiorRegistry.sampleFactorAt(
        _interiorFocusPos,
        Int,
      );
      fillScale = THREE.MathUtils.lerp(
        1,
        Int.ambientScale ?? 0.22,
        interiorAmb,
      );
    }
    hemi.intensity = Li.hemiIntensity * fillScale;
    if (
      toolState.skyMode === "physical" ||
      toolState.skyMode === "procedural"
    ) {
      scene.environmentIntensity = Li.envIntensity * fillScale;
    } else if (toolState.skyMode === "hdr") {
      scene.environmentIntensity = Li.hdrEnvIntensity * fillScale;
    }

    shadowTarget.position.set(focusPos.x, 0, focusPos.z);
    const csmCfg = toolState.csm;
    const csmChanged =
      csm &&
      csmCfg.enabled &&
      (csmCfg.cascades !== _lastCsmCascades ||
        csmCfg.maxFar !== _lastCsmMaxFar ||
        csmCfg.lightMargin !== _lastCsmMargin ||
        csmCfg.mapSize !== _lastCsmMapSize);
    if (csm?.mainFrustum && csmChanged) {
      _lastCsmCascades = csmCfg.cascades;
      _lastCsmMaxFar = csmCfg.maxFar;
      _lastCsmMargin = csmCfg.lightMargin;
      _lastCsmMapSize = csmCfg.mapSize;
      csm.cascades = csmCfg.cascades;
      csm.maxFar = csmCfg.maxFar;
      csm.lightMargin = csmCfg.lightMargin;
      sun.shadow.mapSize.set(csmCfg.mapSize, csmCfg.mapSize);
      if (csm.lights.length > 2) {
        csm.lights[2].shadow.mapSize.set(1024, 1024);
      }
      csm.updateFrustums();
    }
    if (csm?.mainFrustum && csmCfg.enabled && csmCfg.updateEveryFrame) {
      csm.updateFrustums();
    }

    if (heightTexDirty && now - lastHeightTexSyncMs > 500) {
      rebuildGlobalHeightTexture();
      grassManager.rebuildTerrainNormalTex(config.world.size);
      heightTexDirty = false;
      lastHeightTexSyncMs = now;
    }

    const _pPreStream = performance.now();
    frameProbe.t.misc += _pPreStream - now; // frame head (sky/light/csm/interior)
    chunkStream.update(focusPos);
    const _pStream = performance.now();
    frameProbe.t.stream += _pStream - _pPreStream;
    cliffInstancer.update();
    propInstancer.update(camera, toolState.propLod);
    livePropManager.update(dtSec);
    collectibleBurst.update(dtSec);
    if (playMode.active) {
      collectibleRuntime.update(dtSec, playMode.playerPos, playMode.moveMode);
      if (collectibleGizmo.isVisible()) collectibleGizmo.hide();
    } else {
      // Sync gizmo to current prop selection (only when selection is a collectible live prop).
      const selIdx = propInstancer.selectedIdx;
      let shown = false;
      if (selIdx >= 0) {
        const entry = livePropManager.getLiveEntry(selIdx);
        const kind = entry?.obj?.kind;
        if (kind && COLLECTIBLE_KINDS.has(kind)) {
          collectibleGizmo.show(
            entry.obj.group.position,
            entry.obj.pickupRadius ?? 1.0,
          );
          shown = true;
        }
      }
      if (!shown && collectibleGizmo.isVisible()) collectibleGizmo.hide();
    }
    const _pProps = performance.now();
    frameProbe.t.props += _pProps - _pStream;
    treeLodRenderer.update(treeStore, camera, toolState.treeLod);
    foliageLodRenderer.update(treeStore, camera, toolState.foliageLod);
    foliageLodRenderer.updateTime(now * 0.001);
    billboardRenderer.update(
      foliageStore,
      camera,
      toolState.billboardFoliageLod,
      toolState.foliageSlots,
    );
    billboardRenderer.updateTime(now * 0.001);
    billboardGrassRenderer.update(
      billboardGrassStore,
      camera,
      toolState.billboardGrassLod,
      toolState.billboardGrassSlots,
      { aerialStrict: playMode.active },
    );
    billboardGrassRenderer.updateTime(now * 0.001);
    const _pFoliage = performance.now();
    frameProbe.t.foliage += _pFoliage - _pProps;
    // Shared gust cycle: intensity in [0.1..1]. Revo consumes it directly
    // (its shader has the mix(strength, 1.5, intensity) ramp); Gemini/Hybrid
    // get it as a wind-strength multiplier with a calm floor so ambient
    // grass still sways gently between gusts.
    const _gustI = windGust.update();
    const _gustStrengthMul = 0.45 + 0.55 * _gustI;
    /** Auto-cliff link: convert the cliff shader's flatness thresholds
     *  (flatness = 1/(1+|∇h|)) into the grass systems' normal.y metric
     *  (n.y = 1/√(1+|∇h|²)) so "rock fades in" === "grass fades out".
     *  bias > 0 → grass tolerates steeper ground (clings onto rock). */
    const _flatToNy = (f) => {
      const st = 1 / Math.max(f, 1e-3) - 1;
      return 1 / Math.sqrt(1 + st * st);
    };
    const _linkedSlope = (bias = 0) => ({
      min: _flatToNy(toolState.autoCliff.slopeStart) - bias,
      max: _flatToNy(toolState.autoCliff.slopeEnd) - bias,
    });
    if (grassManager.uniforms) {
      grassManager.uniforms.uPlayerPos.value.copy(focusPos);
      grassManager.uniforms.uWindStrength.value =
        (toolState.grass.windStrength ?? 1.4) * _gustStrengthMul;
      if (toolState.grass.slopeLinkToCliff) {
        const w = _linkedSlope(toolState.grass.slopeBias ?? 0);
        grassManager.uniforms.uSlopeMin.value = w.min;
        grassManager.uniforms.uSlopeMax.value = w.max;
      }
    }
    const _gpGrass = toolState.grass;
    const _hybridGrassOn = _gpGrass.renderMode === "hybrid" && _gpGrass.enabled;
    if (_hybridGrassOn) {
      // Hybrid renderer active: hide Gemini's patch meshes without touching
      // the persisted enabled flag (mutate-restore, zero alloc).
      const _prevGrassEnabled = _gpGrass.enabled;
      _gpGrass.enabled = false;
      grassManager.update(
        _gpGrass,
        playMode.active ? playMode.playerPos : null,
      );
      _gpGrass.enabled = _prevGrassEnabled;
      if (!hybridGrassRings) ensureHybridGrassBuilt(); // async, self-guarded
    } else {
      grassManager.update(
        _gpGrass,
        playMode.active ? playMode.playerPos : null,
      );
    }
    if (hybridGrassRings) {
      const _hybridSun = grassManager.uniforms?.uSunDir?.value ?? sunDir;
      if (_hybridGrassOn) syncHybridGrassLod(hybridGrassRings, _gpGrass);
      for (const ring of hybridGrassRings) {
        const _ringOn =
          _hybridGrassOn && (!ring.isCliff || grassManager._hasCliffData);
        ring.setEnabled(_ringOn);
        if (_ringOn) {
          ring.syncFromState(_gpGrass, _hybridSun);
          ring.u.uWindStrength.value *= _gustStrengthMul; // gust cycle
          if (_gpGrass.slopeLinkToCliff) {
            const w = _linkedSlope(_gpGrass.slopeBias ?? 0);
            ring.u.uSlopeMin.value = w.min;
            ring.u.uSlopeMax.value = w.max;
          }
          ring.update(focusPos, camera);
        }
      }
    }
    if (toolState.revoGrass.enabled) {
      const afxWind = toolState.ambientFx;
      revoGrassSystem.setPlayWind({
        intensityMul: afxWind.windStrength ?? 1,
        angleDeg:
          (Math.atan2(afxWind.windZ ?? 0, afxWind.windX ?? 1) * 180) / Math.PI,
      });
      revoGrassSystem.update(toolState.revoGrass, focusPos, camera, {
        playMode: playMode.active,
        gustMul: _gustI,
        slopeWindow: toolState.revoGrass.slopeLinkToCliff
          ? _linkedSlope(toolState.revoGrass.slopeBias ?? 0)
          : null,
      });
    }
    const _pGrass = performance.now();
    frameProbe.t.grass += _pGrass - _pFoliage;

    /**
     * Snow tile per-frame update. The anchor follows the same `focusPos` used by
     * RevoGrass. Contact-point carving is fed by `_snowWheelData()`, which
     * handles car/lotus/vvv (4 wheels + chassis) and capsule/char (1 foot
     * stamp) modes. Editor mode and airborne modes pass null → no carving.
     */
    if (toolState.snow.enabled) {
      const _wd = playMode.active ? _snowWheelData(playMode) : null;
      snowSystem.update(toolState.snow, focusPos, _wd);
    }

    fleurSystem.update(
      playMode.active ? playMode.playerPos : focusPos,
      _appTimeSec,
    );

    const afx = toolState.ambientFx;
    ambientFxStore.update(
      focusPos,
      _appTimeSec,
      afx.windX,
      afx.windZ,
      afx.windStrength,
    );
    leafFxStore.update(
      focusPos,
      _appTimeSec,
      afx.windX,
      afx.windZ,
      afx.windStrength,
    );

    syncBarrierOverlay();
    syncHoleOverlay();

    // Water: advance time + lake reflections
    _appTimeSec += Math.min(0.05, dtSec);
    waterMaterials.updateTime(_appTimeSec);
    if (waterStore.lakeBodies.length > 0) {
      waterMaterials.lakeShader.update(
        dtSec,
        _appTimeSec,
        waterStore.lakeBodies,
      );
      if (toolState.water.reflectionEnabled) {
        waterMaterials.setReflectionParams(
          toolState.water.reflectionScale,
          toolState.water.reflectionEveryN,
        );
        const reflExclude = [grassManager.group];
        if (
          toolState.revoGrass.enabled &&
          revoGrassSystem.group.children.length > 0
        ) {
          reflExclude.push(revoGrassSystem.group);
        }
        waterMaterials.renderLakeReflection(
          camera,
          renderer,
          scene,
          waterStore.bodies,
          waterStore.lakeBodies,
          reflExclude,
        );
      } else {
        waterMaterials.lakeShader.uniforms.reflectEnabled.value = 0;
      }
    }
    waterfallSystem.update(dtSec);

    // Global world ocean — FFT compute + recenter run here, before renderer.render.
    if (scene.environment !== _oceanEnvRef) {
      _oceanEnvRef = scene.environment;
      worldOcean.setEnvMap(scene.environment);
    }
    worldOcean.update(dtSec, _appTimeSec, camera);

    if (now - hudLastMs > 180) {
      let tris = 0;
      for (const ch of chunkStream.activeChunks.values()) {
        tris += ch.segments * ch.segments * 2;
      }
      perf.trisApprox = tris;
      hud.update({ perf, toolState, sculptSystem });
      ui?.refreshPerf?.();
      hudLastMs = now;
    }
    // Road reflection disabled for now (re-enable later)
    // if (roadSystem.hasReflectiveRoads() || fullRoadSystem.hasReflectiveRoads() || smartRoadSystem.hasReflectiveRoads()) {
    //   roadReflection.render(...);
    // }
    riverSystem.update(dtMs * 0.001);
    splineSystem.update(dtMs * 0.001);

    // Daynight cloud deck — procedural sky only. Highest priority; owns the
    // frame (post-FX off path), like the lab. Gated so it can't fight the other
    // 3 systems. Hide its layer-18 dome whenever it isn't the active renderer so
    // a V3 `enableAll()` pass can't pick it up.
    const _pRenderStart = performance.now();
    frameProbe.t.misc += _pRenderStart - _pGrass; // misc tail (snow/water/ocean/etc.)
    const dncOn =
      toolState.skyMode === "procedural" &&
      toolState.volumetricCloudDayNight.enabled;
    if (dncOn) ensureDayNightCloudLayer();
    if (!dncOn && dayNightCloudLayer) dayNightCloudLayer.mesh.visible = false;

    const vcOn = toolState.volumetricCloud.enabled;
    const vcOptOn = toolState.volumetricCloudOptimized.enabled;
    const vcV3On = toolState.volumetricCloudV3.enabled;
    if (vcOn && !volumetricCloudSystem) ensureVolumetricCloudSystem();
    if (vcOptOn && !volumetricCloudSystemOptimized)
      ensureVolumetricCloudSystemOptimized();
    if (vcV3On && !volumetricCloudSystemV3) ensureVolumetricCloudSystemV3();
    const oOpt = volumetricCloudSystemOptimized;
    const oV3 = volumetricCloudSystemV3;
    if (!vcOptOn) {
      if (oOpt?.cloudMesh) oOpt.cloudMesh.visible = false;
      if (oOpt?.sunSphere) oOpt.sunSphere.visible = false;
    }
    if (!vcV3On) {
      if (oV3?.cloudMesh) oV3.cloudMesh.visible = false;
      if (oV3?.sunSphere) oV3.sunSphere.visible = false;
    }
    // v1 doesn't expose `sunSphere`; its hide path lives inside its own
    // tryRenderFrame. Pre-emptively call it when another cloud system is the
    // active renderer so its meshes don't leak into that system's final pass.
    if (!vcOn && volumetricCloudSystem && (vcOptOn || vcV3On)) {
      volumetricCloudSystem.tryRenderFrame(cloudFollowAnchor, dtSec);
    }
    let didCloudRt = false;
    // Priority: Daynight deck > V3 > Optimized > Classic. UI toggle exclusivity
    // normally ensures only one is enabled; the priority chain is the safety net.
    if (dncOn && dayNightCloudLayer) {
      driveDayNightClouds(dtSec);
      if (postFxPipeline.isActive()) {
        // Post-FX ON: clouds flow through v2's pipeline so bloom/SSAO/DOF apply
        // over them (composited into the linear HDR buffer, single tonemap).
        // NOTE: god-rays + cloud-shadows are owns-the-frame-only for now.
        postFxPipeline.renderWithClouds(
          dayNightCloudLayer,
          cloudFollowAnchor,
          dtSec,
        );
        didCloudRt = true;
      } else {
        // Post-FX OFF (default): the deck owns the frame (god-rays come from the
        // SUN, occluded by terrain + the cloud silhouette; dome hidden in the
        // occlusion pass; cloud-shadows applied in the composite).
        didCloudRt = dayNightCloudLayer.tryRenderFrame({
          godRays: toolState.cloudGodRays,
          frame: { camera, sunDir, lightColor: _cloudLightColor },
          occluders: chunkStream.raycastMeshes(),
          skyMesh: dayNightSky.mesh,
        });
      }
    } else if (vcV3On && postFxPipeline.isActive()) {
      postFxPipeline.renderWithClouds(oV3, cloudFollowAnchor, dtSec);
      didCloudRt = true;
    } else if (vcV3On) {
      didCloudRt = !!oV3?.tryRenderFrame?.(cloudFollowAnchor, dtSec);
    } else if (vcOptOn) {
      didCloudRt = !!oOpt?.tryRenderFrame?.(cloudFollowAnchor, dtSec);
    } else if (vcOn) {
      didCloudRt = !!volumetricCloudSystem?.tryRenderFrame?.(
        cloudFollowAnchor,
        dtSec,
      );
    } else {
      volumetricCloudSystem?.tryRenderFrame?.(cloudFollowAnchor, dtSec);
    }
    if (!didCloudRt) {
      if (postFxPipeline.isActive()) {
        postFxPipeline.render();
      } else {
        renderer.render(scene, camera);
      }
    }
    frameProbe.t.render += performance.now() - _pRenderStart;
    // Drain the GPU timestamp pool each frame so stats-gl's GPU panel gets a
    // real value. Our frame issues many render passes (RenderPipeline post-FX
    // + cloud RTs); without this `renderer.info.render.timestamp` — which is
    // what stats-gl reads — stays 0. Matches template-unreal-objects.html and
    // daynight-sky.html. Fire-and-forget.
    renderer.resolveTimestampsAsync(THREE.TimestampQuery.RENDER);
    // COMPUTE pool: the RevoGrass system runs a GPU compute dispatch each
    // frame; the RENDER timestamp can't see it. Drain it so stats-gl's CPT
    // panel reports real grass-sim GPU time. Fire-and-forget.
    renderer.resolveTimestampsAsync(THREE.TimestampQuery.COMPUTE);

    // Feed the custom counter panels from this frame's accumulated info.
    const ri = renderer.info.render;
    const draws = ri.drawCalls ?? ri.calls ?? 0;
    const ktris = (ri.triangles ?? 0) / 1000;
    _statMaxDraw = Math.max(_statMaxDraw, draws);
    _statMaxTri = Math.max(_statMaxTri, ktris);
    drawPanel.update(draws, _statMaxDraw, 0);
    drawPanel.updateGraph(draws, _statMaxDraw);
    triPanel.update(ktris, _statMaxTri, 0);
    triPanel.updateGraph(ktris, _statMaxTri);

    frameProbe.endFrame(dtMs, draws, ri.triangles ?? 0);

    stats.update();
  });

  return {
    scene,
    camera,
    renderer,
    audioSystem,
    toolState,
    ui,
    perf,
    playMode,
    waterStore,
    roadSystem,
    fullRoadSystem,
    smartRoadSystem,
    riverSystem,
    splineSystem,
    splineRoadSystem,
    propStore,
    decalSystem,
    waterfallSystem,
    actorSystem,
    dialogueRunner,
    listDialogueGraphIds,
    caveStore,
    tunnelSystem,
    propUiCallbacks,
    setMode(mode, opts = {}) {
      if (mode === "play") {
        _pendingPlayImmersive = opts.immersive === true;
      } else {
        _pendingPlayImmersive = false;
      }
      toolState.mode = mode;
      applyModeChangedEffects();
      ui?.pane.refresh();
    },
    setPlayImmersive(on) {
      if (!playMode.active) return;
      syncPlayEditorChrome(!!on);
      playMode.setEditorPointerMode(!on);
    },
    getPlayImmersive() {
      return (
        document.getElementById("app")?.classList.contains("play-fullscreen") ??
        false
      );
    },
    undo() {
      sculptSystem.undo();
    },
    redo() {
      sculptSystem.redo();
    },
    saveProject() {
      _saveProject();
    },
    async saveHeightmapPng() {
      try {
        await downloadWorldHeightmapPng(terrainStore, config);
      } catch (e) {
        console.error("Heightmap export failed", e);
      }
    },
    loadProject() {
      _loadProject();
    },
    /**
     * Headless / player load path. Fetches a saved .v2terrain by URL (e.g. a
     * file placed in /public) and restores the full world through the same
     * code the editor's "Load" button uses — terrain, paint, trees, foliage,
     * props, water, sky, lighting, post-FX, the lot. Used by play.html.
     */
    async loadProjectFromUrl(url) {
      const res = await fetch(url);
      if (!res.ok)
        throw new Error(`Failed to fetch project "${url}" (${res.status})`);
      const buf = await res.arrayBuffer();
      await _loadProject(buf);
    },
    /**
     * Load a world directly from raw .v2terrain bytes (an ArrayBuffer) — e.g.
     * a file the player drag-dropped or picked from disk in the player. Same
     * full-world restore as loadProjectFromUrl, no network fetch.
     */
    async loadProjectBuffer(arrayBuffer) {
      await _loadProject(arrayBuffer);
    },
    config,
    syncFog,
    syncInteriorUniforms,
    rebuildInteriorVolumes,
    setCsmEnabled,
    rebuildSkyEnv,
    rebuildProceduralSkyEnv,
    setTimeOfDay,
    applySkyMode,
    importHdr,
    postFxPipeline,
    applyPostFxState,
    clearRampPoint() {
      sculptSystem.clearRampPoint();
      syncRampMarker();
    },
    runGlobalErosion() {
      sculptSystem.applyGlobalErosion();
    },
    generateTerrain() {
      sculptSystem.applyProceduralTerrainAllChunks();
      if (toolState.borderMountains.enabled) rebuildBorderMountains();
    },
    rebuildBorderMountains,
    textureLibrary,
    brushMask,
    sculptBrushMask,
    paintFill() {
      paintSystem.fillWithActiveLayer();
    },
    paintClear() {
      paintSystem.clearAll();
    },
    syncSoloLayer,
    syncHeightBlend,
    invalidateSurfaceMaterials,
    importTreeGlb(slotIdx, lod, file = null) {
      _importTreeGlb(slotIdx, lod, file);
    },
    loadTreePreset(slotIdx, file = null) {
      _loadTreePreset(slotIdx, file);
    },
    removeTreeSlot(slotIdx) {
      _removeTreeSlot(slotIdx);
    },
    clearAllTrees() {
      _clearAllTrees();
    },
    massPlaceTrees() {
      treeSystem.massPlace(toolState.treePaint.massPlaceCount);
    },
    massPlaceFoliage() {
      foliagePaintSystem.massPlace(toolState.foliagePaint.massPlaceCount);
    },
    massPlaceBillboardGrass() {
      billboardGrassPaintSystem.massPlace(
        toolState.billboardGrassPaint.massPlaceCount,
      );
    },
    billboardGrassSlotStructureChanged(slotIdx) {
      _billboardGrassSlotStructureChanged(slotIdx);
    },
    billboardGrassSlotMaterialChanged(slotIdx) {
      _billboardGrassSlotMaterialChanged(slotIdx);
    },
    clearAllBillboardGrass() {
      _clearAllBillboardGrass();
    },
    loadBillboardGrassMask(slotIdx, file = null) {
      _loadBillboardGrassMask(slotIdx, file);
    },
    treeCastShadowChanged() {
      _treeCastShadowChanged();
    },
    foliageParamChanged(slotIdx) {
      _foliageParamChanged(slotIdx);
    },
    importPropGlb(file = null) {
      _importPropGlb(file);
    },
    addPrimitive(name) {
      _addPrimitive(name);
    },
    addLiveProp(name) {
      _addLiveProp(name);
    },
    importGlbCollectible(file = null) {
      _importGlbCollectible(file);
    },
    /**
     * Collectibles gameplay API.
     *   app.collectibles.onPickup((kind, instIdx, position, kindCount) => { ... })
     *   app.collectibles.getCounts()  // { coin: 3, heart: 1, ... }
     */
    collectibles: {
      onPickup: (cb) => collectibleRuntime.onPickup(cb),
      offPickup: (cb) => collectibleRuntime.offPickup(cb),
      getCounts: () => collectibleRuntime.getCountsByKind(),
      getTotal: () => collectibleRuntime.getCollectedCount(),
    },
    propTextureLibrary,
    /** Swap the material on a primitive slot. All instances of that slot use the new material. */
    setPrimitiveMaterial(slotIdx, materialId) {
      const slot = toolState.propSlots[slotIdx];
      if (!slot || !slot.builtin) return;
      slot.materialId = materialId;
      _rebuildPrimitiveMaterial(slotIdx);
      const propMat = propTextureLibrary.getById(materialId);
      console.log(
        `[V2] Slot "${slot.name}" material → "${propMat?.name ?? materialId}"`,
      );
    },
    /** Toggle triplanar (world-axis) projection on a primitive slot. Rebuilds its material. */
    setPrimitiveTriplanar(slotIdx, enabled) {
      const slot = toolState.propSlots[slotIdx];
      if (!slot || !slot.builtin || !slot.materialId) return;
      slot.triplanar = !!enabled;
      _rebuildPrimitiveMaterial(slotIdx);
      console.log(`[V2] Slot "${slot.name}" triplanar → ${slot.triplanar}`);
    },
    livePropManager,
    set onPropSelectionChanged(fn) {
      _onPropSelectionChanged = fn;
    },
    removePropSlot(idx) {
      _removePropSlot(idx);
    },
    importPropLod(slotIdx, lod, file = null) {
      _importPropLod(slotIdx, lod, file);
    },
    propCastShadowChanged() {
      _propCastShadowChanged();
    },
    deleteSelectedProp() {
      _deleteSelectedProp();
    },
    duplicateSelectedProp() {
      _duplicateSelectedProp();
    },
    /** After editing `propStore.instances[instIdx]` fields in place (e.g. custom inspector sliders). */
    syncPropInstanceFromInspector(instIdx) {
      const inst = propStore.instances[instIdx];
      if (!inst) return;
      propStore._bump();
      if (propInstancer.selectedIdx === instIdx) propInstancer.select(instIdx);
      if (cliffBvh) cliffBvh.invalidate();
    },
    clearAllProps() {
      _clearAllProps();
    },
    propTransformModeChanged() {
      _propTransformModeChanged();
    },
    rebakeBvh() {
      _rebakeBvh();
    },
    loadFoliageTexture(slotIdx, file = null) {
      _loadFoliageTexture(slotIdx, file);
    },
    foliageSlotStructureChanged(slotIdx) {
      _foliageSlotStructureChanged(slotIdx);
    },
    foliageSlotMaterialChanged(slotIdx) {
      _foliageSlotMaterialChanged(slotIdx);
    },
    clearAllFoliage() {
      _clearAllFoliage();
    },
    foliageLodChanged() {
      _foliageLodChanged();
    },
    billboardFoliageLodChanged() {},
    playSpawnChanged() {
      _playSpawnChanged();
    },
    barrierOverlayChanged() {
      _barrierOverlayChanged();
    },
    barrierClear() {
      _barrierClear();
    },
    barrierFill() {
      _barrierFill();
    },
    holeOverlayChanged() {
      _holeOverlayChanged();
    },
    holeClear() {
      _holeClear();
    },
    caveUndo() {
      _caveUndo();
    },
    caveRedo() {
      _caveRedo();
    },
    caveClear() {
      _caveClear();
    },
    ambientFxFlapChanged() {
      _ambientFxFlapChanged();
    },
    ambientFxLeafChanged() {
      _ambientFxLeafChanged();
    },
    ambientFxRingsChanged() {
      _ambientFxRingsChanged();
    },
    ambientFxClear() {
      _ambientFxClear();
    },
    ambientFxClearLeaves() {
      _ambientFxClearLeaves();
    },
    ambientFxLeafRespawn() {
      _ambientFxLeafRespawn();
    },
    ambientFxSetLeafTexture(idx, url) {
      leafFxStore.setLeafTexture(idx, url);
    },
    fleurChanged() {
      _fleurChanged();
    },
    fleurColorChanged(slot) {
      _fleurColorChanged(slot);
    },
    fleurStemChanged() {
      _fleurStemChanged();
    },
    fleurStemCurveChanged() {
      _fleurStemCurveChanged();
    },
    fleurInteractionChanged() {
      _fleurInteractionChanged();
    },
    fleurClear() {
      _fleurClear();
    },
    cliffGrassFill() {
      _cliffGrassFill();
    },
    cliffGrassClear() {
      _cliffGrassClear();
    },
    importCliffGlb(slotIdx, file = null) {
      _importCliffGlb(slotIdx, file);
    },
    removeCliffSlot(slotIdx) {
      _removeCliffSlot(slotIdx);
    },
    deleteSelectedCliff() {
      _deleteSelectedCliff();
    },
    clearAllCliffs() {
      _clearAllCliffs();
    },
    cliffTransformModeChanged() {
      _cliffTransformModeChanged();
    },
    cliffBlendChanged() {
      _cliffBlendChanged();
    },
    cliffPaintFill() {
      _cliffPaintFill();
    },
    cliffPaintClear() {
      _cliffPaintClear();
    },
    waterChanged() {
      _waterChanged();
    },
    saveWater() {
      _saveWater();
    },
    loadWater() {
      _loadWater();
    },
    deleteSelectedWater() {
      _deleteSelectedWater();
    },
    clearAllWater() {
      _clearAllWater();
    },
    worldOcean,
    worldOceanChanged() {
      worldOcean.syncParams(toolState.worldOcean);
    },
    waterfallChanged() {
      _waterfallChanged();
    },
    deleteSelectedWaterfall() {
      _deleteSelectedWaterfall();
    },
    clearAllWaterfalls() {
      _clearAllWaterfalls();
    },
    actorsChanged() {
      _actorsChanged();
    },
    deleteSelectedActor() {
      _deleteSelectedActor();
    },
    clearAllActors() {
      _clearAllActors();
    },
    clearNpcs() {
      _clearNpcs();
    },
    clearEnemies() {
      _clearEnemies();
    },
    snapSelectedActorToTerrain() {
      _snapSelectedToTerrain();
    },
    actorsTransformModeChanged() {
      _actorsTransformModeChanged();
    },
    setActorsPanelRefresh(fn) {
      _refreshActorsPanel = typeof fn === "function" ? fn : null;
    },
    decalLoadImage(file = null) {
      _decalLoadImage(file);
    },
    decalOpacityChanged() {
      _decalOpacityChanged();
    },
    decalAlignChanged() {
      _decalAlignChanged();
    },
    decalRefit() {
      _decalRefit();
    },
    decalDeleteSelected() {
      _decalDeleteSelected();
    },
    decalClearAll() {
      _decalClearAll();
    },
    decalSaveJson() {
      _decalSaveJson();
    },
    decalLoadJson(file = null) {
      _decalLoadJson(file);
    },
    decalTransformModeChanged() {
      _decalTransformModeChanged();
    },
    riverChanged() {
      _riverChanged();
    },
    riverNewRiver() {
      _riverNewRiver();
    },
    riverDeleteActive() {
      _riverDeleteActive();
    },
    riverDeleteSelected() {
      _riverDeleteSelected();
    },
    riverSelectedYChanged() {
      _riverSelectedYChanged();
    },
    riverActiveIndexChanged() {
      _riverActiveIndexChanged();
    },
    roadChanged() {
      roadSystem.saveActiveStyle();
      roadSystem.syncMaterial();
      roadSystem.rebuildAllMeshes();
      ui?.pane.refresh();
    },
    roadNewRoad() {
      roadSystem.startNewRoad();
      ui?.pane.refresh();
    },
    roadDeleteActive() {
      roadSystem.deleteActiveRoad();
      ui?.pane.refresh();
    },
    roadDeleteSelected() {
      roadSystem.deleteSelected();
      ui?.pane.refresh();
    },
    roadSnapY() {
      roadSystem.snapSelectedYToTerrain();
      ui?.pane.refresh();
    },
    roadSelectedYChanged() {
      roadSystem.setSelectedPointY(toolState.road.selectedPointY);
    },
    roadActiveIndexChanged() {
      roadSystem._clampActive();
      toolState.road.activeStyleSectionIndex = 0;
      roadSystem.selectedIdx = -1;
      roadSystem.loadActiveStyle();
      roadSystem._rebuildVisual();
      ui?.pane.refresh();
    },
    roadStyleSectionChanged() {
      roadSystem._clampActiveStyleSection();
      roadSystem.loadActiveStyle();
      ui?.pane.refresh();
    },
    roadNewStyleSection() {
      roadSystem.createStyleSectionAtSelected();
      ui?.pane.refresh();
    },
    roadDeleteStyleSection() {
      roadSystem.deleteActiveStyleSection();
      ui?.pane.refresh();
    },
    roadFlattenTerrain() {
      roadSystem.flattenTerrainUnderRoads();
      roadSystem.rebuildAllMeshes();
      markHeightTexDirty();
      treeStore.syncAllHeights(terrainStore);
      foliageStore.syncAllHeights(terrainStore);
      billboardGrassStore.syncAllHeights(terrainStore);
      splineSystem.syncGuardrailsToGround();
      splineSystem.syncKerbsToGround();
      splineSystem.syncLinearFeaturesToGround();
      ui?.pane.refresh();
    },
    roadApplyStabilityPreset() {
      const rp = toolState.road;
      rp.heightOffset = 0.15;
      rp.adaptiveLift = true;
      rp.slopeLift = 0.35;
      rp.liftMax = 0.6;
      roadSystem.syncMaterial();
      roadSystem.rebuildAllMeshes();
      ui?.pane.refresh();
    },
    fullRoadChanged() {
      fullRoadSystem.syncMaterial();
      fullRoadSystem.rebuildAllMeshes();
      fullRoadSystem._rebuildHandles();
      ui?.pane.refresh();
    },
    fullRoadStartBranch() {
      fullRoadSystem.startBranch();
      ui?.pane.refresh();
    },
    fullRoadDeleteSelected() {
      fullRoadSystem.deleteSelected();
      ui?.pane.refresh();
    },
    fullRoadClearAll() {
      fullRoadSystem.clearAll();
      ui?.pane.refresh();
    },
    fullRoadSnapY() {
      fullRoadSystem.snapSelectedYToTerrain();
      ui?.pane.refresh();
    },
    fullRoadSelectedYChanged() {
      fullRoadSystem.setSelectedPointY(toolState.fullRoad.selectedPointY);
      ui?.pane.refresh();
    },
    fullRoadToggleJunction() {
      fullRoadSystem.toggleSelectedJunction();
      ui?.pane.refresh();
    },
    fullRoadFlattenTerrain() {
      fullRoadSystem.flattenTerrainUnderRoads();
      fullRoadSystem.rebuildAllMeshes();
      markHeightTexDirty();
      treeStore.syncAllHeights(terrainStore);
      foliageStore.syncAllHeights(terrainStore);
      billboardGrassStore.syncAllHeights(terrainStore);
      splineSystem.syncGuardrailsToGround();
      splineSystem.syncKerbsToGround();
      splineSystem.syncLinearFeaturesToGround();
      ui?.pane.refresh();
    },
    fullRoadApplyCityPreset() {
      const rp = toolState.fullRoad;
      rp.width = 12;
      rp.heightOffset = 0.08;
      rp.junctionRadius = 10;
      rp.centerLine = true;
      rp.centerLineDashed = true;
      rp.doubleCenterLine = false;
      rp.laneLines = false;
      rp.lineWidth = 0.025;
      rp.colorBrightness = 0.65;
      rp.texScale = 3.0;
      fullRoadSystem.syncMaterial();
      fullRoadSystem.rebuildAllMeshes();
      fullRoadSystem._rebuildHandles();
      ui?.pane.refresh();
    },
    fullRoadAccessoryTypeChanged() {
      fullRoadSystem.cancelAccessoryPaint();
      ui?.pane.refresh();
    },
    fullRoadAccessoryParamsChanged() {
      fullRoadSystem.rebuildAllAccessories();
      ui?.pane.refresh();
    },
    fullRoadAccessoryClearAll() {
      fullRoadSystem.clearAllAccessories();
      ui?.pane.refresh();
    },
    fullRoadDecalModeToggled() {
      if (!toolState.fullRoad.decalMode) {
        fullRoadSystem._clearDecalPreview();
        fullRoadSystem.deselectDecal();
      }
      ui?.pane.refresh();
    },
    fullRoadDecalTransformModeChanged() {
      if (fullRoadSystem.selectedDecalId != null) {
        transformControls.setMode(
          toolState.fullRoad.decalTransformMode || "translate",
        );
      }
    },
    fullRoadDecalDeleteSelected() {
      fullRoadSystem.deleteSelectedDecal();
      ui?.pane.refresh();
    },
    fullRoadDecalTypeChanged() {
      ui?.pane.refresh();
    },
    fullRoadDecalParamsChanged() {
      fullRoadSystem.rebuildAllDecals();
      ui?.pane.refresh();
    },
    fullRoadDecalClearAll() {
      fullRoadSystem.clearAllDecals();
      ui?.pane.refresh();
    },
    rebuildCarAudio() {
      playMode.rebuildCarAudio();
    },
    smartRoadChanged() {
      smartRoadSystem.syncMaterial();
      smartRoadSystem.rebuildAllMeshes();
      smartRoadSystem._rebuildHandles();
      ui?.pane.refresh();
    },
    smartRoad2Changed() {
      // Push the panel's params into the lab system (keeps merged defaults like
      // handleLift) and rebuild.
      Object.assign(smartRoad2System.params, toolState.smartRoad2);
      smartRoad2System.queueRebuild();
    },
    smartRoad2ClearAll() {
      smartRoad2System.setNetwork([], []);
    },
    smartRoad2FlattenTerrain() {
      // Persistent bake: conform the chunked heightmap to the road SURFACE at each
      // terrain vertex (deck minus a constant embed depth) — vertex-height, not
      // spine-height, so no clip on slopes and no float. Then remesh dirty chunks.
      if (!terrainStore || !chunkStream) return;
      const depth = toolState.smartRoad2.flattenDepth ?? 0.35;
      const shoulder = toolState.smartRoad2.shoulder ?? 6;
      const halfW = smartRoad2System.params.width * 0.5;
      const footprints = smartRoad2System.getFootprints();
      if (!footprints.length) return;
      const dirtyChunks = new Map();
      terrainStore.conformToRoadSurface(
        footprints,
        (x, z) => smartRoad2System.roadSurfaceH(x, z),
        halfW,
        depth,
        shoulder,
        dirtyChunks,
      );
      if (dirtyChunks.size > 0) chunkStream.markDirtyRects(dirtyChunks);
    },
    smartRoadStartBranch() {
      smartRoadSystem.startBranch();
      ui?.pane.refresh();
    },
    smartRoadDeleteSelected() {
      smartRoadSystem.deleteSelected();
      ui?.pane.refresh();
    },
    smartRoadClearAll() {
      smartRoadSystem.clearAll();
      ui?.pane.refresh();
    },
    smartRoadSnapY() {
      smartRoadSystem.snapSelectedYToTerrain();
      ui?.pane.refresh();
    },
    smartRoadSelectedYChanged() {
      smartRoadSystem.setSelectedPointY(toolState.smartRoad.selectedPointY);
      ui?.pane.refresh();
    },
    smartRoadToggleJunction() {
      smartRoadSystem.toggleSelectedJunction();
      ui?.pane.refresh();
    },
    smartRoadFlattenTerrain() {
      smartRoadSystem.flattenTerrainUnderRoads();
      smartRoadSystem.rebuildAllMeshes();
      markHeightTexDirty();
      treeStore.syncAllHeights(terrainStore);
      foliageStore.syncAllHeights(terrainStore);
      billboardGrassStore.syncAllHeights(terrainStore);
      splineSystem.syncGuardrailsToGround();
      splineSystem.syncKerbsToGround();
      splineSystem.syncLinearFeaturesToGround();
      ui?.pane.refresh();
    },
    smartRoadPatchSelectedEdgeStyle(patch) {
      smartRoadSystem.mergeSelectedEdgeStyle(patch);
      ui?.pane.refresh();
    },
    smartRoadClearSelectedEdgeStyle() {
      smartRoadSystem.clearSelectedEdgeStyle();
      ui?.pane.refresh();
    },
    smartRoadGraphAccessoryTypeChanged() {
      smartRoadSystem.cancelAccessoryPaint();
      ui?.pane.refresh();
    },
    smartRoadGraphAccessoryParamsChanged() {
      smartRoadSystem.rebuildAllAccessories();
      ui?.pane.refresh();
    },
    smartRoadGraphAccessoryClearAll() {
      smartRoadSystem.clearAllAccessories();
      ui?.pane.refresh();
    },
    smartRoadGraphDecalModeToggled() {
      if (!toolState.smartRoad.decalMode) {
        smartRoadSystem._clearDecalPreview();
        smartRoadSystem.deselectDecal();
      }
      ui?.pane.refresh();
    },
    smartRoadGraphDecalTransformModeChanged() {
      if (smartRoadSystem.selectedDecalId != null) {
        transformControls.setMode(
          toolState.smartRoad.decalTransformMode || "translate",
        );
      }
    },
    smartRoadGraphDecalDeleteSelected() {
      smartRoadSystem.deleteSelectedDecal();
      ui?.pane.refresh();
    },
    smartRoadGraphDecalTypeChanged() {
      ui?.pane.refresh();
    },
    smartRoadGraphDecalParamsChanged() {
      smartRoadSystem.rebuildAllDecals();
      ui?.pane.refresh();
    },
    smartRoadGraphDecalClearAll() {
      smartRoadSystem.clearAllDecals();
      ui?.pane.refresh();
    },
    splineChanged() {
      _splineChanged();
    },
    splineDeleteSelected() {
      _splineDeleteSelected();
    },
    splineClearAll() {
      _splineClearAll();
    },
    splineSelectedYChanged() {
      _splineSelectedYChanged();
    },
    splineClosedChanged() {
      _splineClosedChanged();
    },
    splinePreview() {
      _splinePreview();
    },
    splineBake() {
      _splineBake();
    },
    splineClearPreview() {
      _splineClearPreview();
    },
    splineApplyPlateau() {
      _splineApplyPlateau();
    },
    splineClearTunnels() {
      _splineClearTunnels();
    },
    splineClearLinearFeatures() {
      _splineClearLinearFeatures();
    },
    splineKerbSelect() {
      _splineKerbSelect();
    },
    splineKerbApply() {
      _splineKerbApply();
    },
    splineKerbDelete() {
      _splineKerbDelete();
    },
    splineKerbDuplicate() {
      _splineKerbDuplicate();
    },
    splineKerbSuggestFromCurvature() {
      _splineKerbSuggestFromCurvature();
    },
    splineKerbLiveChanged(key) {
      _splineKerbLiveChanged(key);
    },
    grassChanged() {
      _grassChanged();
    },
    grassRebuildGeos() {
      _grassRebuildGeos();
    },
    grassFill() {
      _grassFill();
    },
    grassClear() {
      _grassClear();
    },
    grassSaveDensity() {
      _grassSaveDensity();
    },
    grassLoadDensity() {
      _grassLoadDensity();
    },
    revoGrassChanged() {
      _revoGrassChanged?.();
    },
    revoGrassRebuild() {
      return _revoGrassRebuild?.();
    },
    revoGrassMaskFill() {
      revoGrassSystem.mask.fillAllow();
    },
    revoGrassMaskClear() {
      revoGrassSystem.mask.clearAllow();
    },
    revoGrassMaskSave() {
      const blob = new Blob([revoGrassSystem.mask.getSnapshot()], {
        type: "application/octet-stream",
      });
      downloadBlob(blob, "revo-grass-mask.bin");
    },
    async revoGrassMaskLoad() {
      const file = await openFilePicker(".bin");
      if (!file) return;
      const buf = await file.arrayBuffer();
      revoGrassSystem.mask.restoreSnapshot(new Uint8Array(buf));
    },
    snowChanged() {
      _snowChanged?.();
    },
    snowRebuild() {
      return _snowRebuild?.();
    },
    snowMaskFill() {
      snowSystem.mask.fillAccum();
    },
    snowMaskClear() {
      snowSystem.mask.clearAccum();
    },
    snowMaskSave() {
      const blob = new Blob([snowSystem.mask.getSnapshot()], {
        type: "application/octet-stream",
      });
      downloadBlob(blob, "snow-mask.bin");
    },
    async snowMaskLoad() {
      const file = await openFilePicker(".bin");
      if (!file) return;
      const buf = await file.arrayBuffer();
      snowSystem.mask.restoreSnapshot(new Uint8Array(buf));
    },
    terrainSurfaceChanged() {
      _terrainSurfaceChanged();
    },
    applyGroundTile() {
      applyGroundTileFromToolState();
    },
    tslTerrainSync() {
      _tslTerrainSync();
    },
    autoCliffEditorChanged(kind) {
      _autoCliffEditorChanged(kind);
    },
    cliffTextureSlotChanged() {
      _cliffTextureSlotChanged();
    },
    groundTextureSlotChanged() {
      _groundTextureSlotChanged();
    },
    onConfigChanged() {
      chunkStream.update(camera.position);
    },
    rebuildVolumetricCloudVolume() {
      volumetricCloudSystem?.rebuildVolume?.();
    },
    rebuildVolumetricCloudMasks() {
      volumetricCloudSystem?.rebuildMaskTextures?.();
    },
    rebuildVolumetricCloudVolumeOptimized() {
      volumetricCloudSystemOptimized?.rebuildVolume?.();
    },
    rebuildVolumetricCloudMasksOptimized() {
      volumetricCloudSystemOptimized?.rebuildMaskTextures?.();
    },
    rebuildVolumetricCloudVolumeV3() {
      volumetricCloudSystemV3?.rebuildVolume?.();
    },
    rebuildVolumetricCloudMasksV3() {
      volumetricCloudSystemV3?.rebuildMaskTextures?.();
    },
    rebuildVolumetricCloudMaskVolumeV3() {
      volumetricCloudSystemV3?.rebuildMaskVolume?.();
    },
    scheduleVolumetricCloudMaskBakeV3() {
      volumetricCloudSystemV3?.scheduleMaskBake?.();
    },
    resizeVolumetricCloudTargets() {
      volumetricCloudSystem?.setDepthTargetSize?.();
      volumetricCloudSystemOptimized?.setDepthTargetSize?.();
      volumetricCloudSystemV3?.setDepthTargetSize?.();
      postFxPipeline.setSize();
    },
    resetTemporalCloudHistory() {
      volumetricCloudSystemOptimized?.resetTemporalHistory?.();
    },
    dispose() {
      renderer.domElement.removeEventListener("wheel", onCanvasWheelBrush, {
        capture: true,
      });
      if (csm) {
        sun.shadow.shadowNode = null;
        csm.dispose();
        csm = null;
      }
      scene.environment = null;
      scene.background = null;
      if (disposeHdrEnv) disposeHdrEnv();
      if (hdrTexture) hdrTexture.dispose();
      if (disposeSkyEnv) disposeSkyEnv();
      if (pmremGenerator) pmremGenerator.dispose();
      sky.dispose?.();
      lensFlare.dispose();
      volumetricCloudSystem?.dispose?.();
      volumetricCloudSystem = null;
      volumetricCloudSystemOptimized?.dispose?.();
      volumetricCloudSystemOptimized = null;
      volumetricCloudSystemV3?.dispose?.();
      volumetricCloudSystemV3 = null;
      if (dayNightCloudLayer) {
        scene.remove(dayNightCloudLayer.mesh);
        scene.remove(dayNightCloudLayer.sunMesh);
        dayNightCloudLayer.dispose?.();
        dayNightCloudLayer = null;
      }
      ui?.dispose?.();
      chunkStream.dispose();
      treeLodRenderer.dispose();
      cliffInstancer.dispose();
      propInstancer.dispose();
      livePropManager.dispose();
      collectibleBurst.dispose();
      collectibleGizmo.dispose();
      transformControls.dispose();
      grassManager.dispose();
      snowSystem.dispose();
      ambientFxStore.clear();
      roadSystem.dispose();
      fullRoadSystem.dispose();
      smartRoadSystem.dispose();
      riverSystem.dispose();
      splineSystem.dispose();
      roadReflection.dispose();
      waterMaterials.dispose();
      waterfallSystem.dispose();
      dialogueRunner.dispose();
      actorSystem.dispose();
      playMode.dispose();
      audioSystem.dispose();
      tileTerrainMaterial.dispose();
      disposeProceduralBundle();
      disposeImageTexBundle();
      _layerArrayAlbedo?.dispose();
      _layerArrayOrm?.dispose();
      splatStore.dispose();
      barrierStore.dispose();
      barrierOverlay.dispose();
      holeStore.dispose();
      holeOverlay.dispose();
      caveSystem.dispose();
      caveStore.dispose();
      tunnelSystem.dispose();
      brushDomeGeom.dispose();
      brushDomeFillMat.dispose();
      brushDomeEdgesGeom.dispose();
      brushDomeLineMat.dispose();
      brushRing.geometry.dispose();
      brushRing.material.dispose();
      rampMarkerA.geometry.dispose();
      rampMarkerA.material.dispose();
      controls.dispose();
      renderer.dispose();
    },
  };
}
