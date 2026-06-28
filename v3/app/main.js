import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import Stats from "stats-gl";
import { texture, uniform } from "three/tsl";
import { createHeightmapTexture, HEIGHTMAP_SIZE, WORLD_SIZE, MAX_HEIGHT } from "../terrain/heightmapTexture.js";
import { createTerrainLOD } from "../terrain/terrainLOD.js";
import { createSculptBrush } from "../terrain/sculptBrush.js";
import {
  encodeHeightmapFile,
  decodeHeightmapFile,
  downloadBuffer,
  pickHeightmapFile,
} from "../io/heightmapIO.js";
import { buildProceduralHeightmap, DEFAULT_GEN } from "../terrain/proceduralGen.js";
import { initEditorShell } from "../ui/editorShell.js";
import { createEditorCameraController } from "../../v2/app/editorCameraController.js";
import { BRUSH_MASKS, loadMaskPNG } from "../terrain/brushMasks.js";
import { createPlayMode, LOD_SNAP } from "../play/playMode.js";
import { V2_CONFIG } from "../../v2/app/config.js";
import { createPerfState, tickPerf } from "../../v2/app/state/toolState.js";
import { createWorldToolState } from "./state/worldState.js";
import { createWorldEnvironment } from "./worldEnvironment.js";
import { buildWorldPanel } from "../ui/buildWorldPanel.js";
import { createHumanCharacter } from "../play/humanCharacter.js";
import { SplatMap } from "../terrain/splatMap.js";
import { createSplatOverlay } from "../terrain/splatOverlayTsl.js";
import { TextureLibrary } from "../terrain/textureLibrary.js";
import { PaintSystem } from "../tools/paintSystem.js";
import { BrushMask } from "../../v2/core/paint/brushMask.js";
import {
  encodeSplatmapFile,
  decodeSplatmapFile,
  pickSplatmapFile,
} from "../io/splatmapIO.js";
import { SPLAT_RES } from "../terrain/splatMap.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { PropStore } from "../tools/propStore.js";
import { PropInstancer } from "../tools/propInstancer.js";
import { PropSystem } from "../tools/propSystem.js";
import { PropPlacementPreview } from "../tools/propPlacementPreview.js";
import { LivePropManager } from "../tools/livePropManager.js";
import { createFlag, createCoin, createHeart, createKey } from "../props/liveProps.js";
import { FLAG_DEFAULTS } from "../../v2/core/props/flagFactory.js";
import { COIN_DEFAULTS, HEART_DEFAULTS, KEY_DEFAULTS } from "../../v2/core/props/collectibleFactory.js";
import {
  PROCEDURAL_PROP_DEFS,
  PROCEDURAL_PROP_LABELS,
  proceduralSchemaFor,
  buildProceduralPreviewGroup,
  registerProceduralObjectFactories,
} from "../../v2/core/props/proceduralObjectProps.js";
import { buildPropsPanel, defaultBakeProceduralThumbnails } from "../ui/buildPropsPanel.js";
import { buildSplinePanel } from "../ui/buildSplinePanel.js";
import { DEFAULT_SPLINE_STATE } from "./state/splineState.js";
import { SplineSystem } from "../../v2/tools/spline/splineSystem.js";
import { PROCEDURAL_OBJECT_OPTIONS } from "../../v2/core/props/proceduralObjectProps.js";
import { createPropTextureLibrary } from "../../v2/core/textures/propTextureLibrary.js";
import { createMaterialForLibrary } from "../../v2/render/props/propMaterialFactory.js";
import { createJumpRampGeometry } from "../../v2/core/props/jumpRampGeometry.js";
import { downloadProps, importPropsFromFile } from "../io/propsIO.js";
import { HybridGrassSystem, syncHybridGrassLod, rebuildHybridGrassGeometries } from "../../v2/render/hybridGrass/hybridGrassSystem.js";
import { createWindTexture, createSpecNoiseTexture } from "../../v2/core/foliage/windTexture.js";
import { GrassTerrainData } from "../render/grass/grassTerrainData.js";

/** Request adapter features (incl. timestamp-query) and raised limits — matches v2. */
async function createWebGpuDevice() {
  if (!navigator.gpu) return null;
  const adapter = await navigator.gpu.requestAdapter({ featureLevel: "compatibility" });
  if (!adapter) return null;

  const requiredLimits = {};
  for (const key of [
    "maxSampledTexturesPerShaderStage",
    "maxSamplersPerShaderStage",
  ]) {
    if (adapter.limits[key] > 16) requiredLimits[key] = adapter.limits[key];
  }

  const requiredFeatures = [...adapter.features];

  try {
    return await adapter.requestDevice({ requiredFeatures, requiredLimits });
  } catch (err) {
    console.warn("[V3] WebGPU device with raised limits failed; using defaults.", err);
    return adapter.requestDevice({ requiredFeatures });
  }
}

async function main() {
  initEditorShell();

  const viewport = document.getElementById("viewport");
  const genParams = { ...DEFAULT_GEN };

  // ── WebGPU device ─────────────────────────────────────────────────────────
  const gpuDevice    = await createWebGpuDevice();
  const hasTimestamps = Boolean(gpuDevice?.features?.has('timestamp-query'));

  // ── Renderer ───────────────────────────────────────────────────────────────
  const renderer = new THREE.WebGPURenderer({
    antialias: true,
    ...(gpuDevice ? { device: gpuDevice } : {}),
  });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  viewport.appendChild(renderer.domElement);

  const stats = new Stats({ trackGPU: hasTimestamps, trackCPT: true });
  try {
    await Promise.race([
      stats.init(renderer),
      new Promise((_, reject) => setTimeout(() => reject(new Error("stats init timeout")), 8000)),
    ]);
  } catch (err) {
    console.warn("[V3] stats-gl init skipped:", err);
  }
  stats.dom.id = "perf-stats";

  const drawPanel   = stats.addPanel(new Stats.Panel("DRAW", "#f0f", "#202"));
  const triPanel    = stats.addPanel(new Stats.Panel("KTRI", "#f90", "#210"));
  let _maxDraw = 1;
  let _maxTri  = 1;
  renderer.info.autoReset = false;

  /** Pin stats-gl to the viewport corner (fixed top:0 would hide under toolbar / left panel). */
  function layoutStatsOverlay() {
    const r = viewport.getBoundingClientRect();
    const panelCount = stats.dom.children.length;
    stats.dom.style.cssText = `
      position: fixed;
      z-index: 10000;
      opacity: 0.9;
      pointer-events: none;
      left: ${r.left + 8}px;
      bottom: ${window.innerHeight - r.bottom + 8}px;
      top: auto;
      height: 48px;
      width: ${Math.max(80, panelCount * 40)}px;
    `;
  }

  document.body.appendChild(stats.dom);
  layoutStatsOverlay();

  await renderer.init();

  // ── Scene ──────────────────────────────────────────────────────────────────
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87ceeb);

  // ── Camera ─────────────────────────────────────────────────────────────────
  const camera = new THREE.PerspectiveCamera(
    60,
    viewport.clientWidth / Math.max(viewport.clientHeight, 1),
    0.5,
    WORLD_SIZE * 2,
  );
  camera.position.set(0, 300, 600);

  let worldEnv = null;

  function resizeRenderer() {
    const w = viewport.clientWidth;
    const h = viewport.clientHeight;
    camera.aspect = w / Math.max(h, 1);
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    worldEnv?.setSize(w, h);
    layoutStatsOverlay();
  }

  resizeRenderer();

  // ── Controls ───────────────────────────────────────────────────────────────
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 10, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.1;
  controls.maxPolarAngle = Math.PI * 0.92;
  controls.maxDistance = 1500;
  // minDistance + scroll zoom handled by editorCameraController (same as v2).
  controls.mouseButtons = { MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.PAN };
  controls.update();

  // Orbit re-enable — wired fully after editorCameraController is created.
  let syncEditorOrbitEnabled = () => { controls.enabled = true; };
  let editorCamera = null;

  // ── Transform gizmo (shared for prop instances + scene objects) ────────────
  const tc = new TransformControls(camera, renderer.domElement);
  tc.setMode("translate");
  tc.enabled = false;
  tc.visible = false;
  scene.add(tc.getHelper());

  // ── Terrain + Sculpt ───────────────────────────────────────────────────────
  // heightTexNode is shared: sculptBrush swaps .value to the active ping-pong
  // RT, and all LOD level materials sample from it automatically.
  const initialTex    = createHeightmapTexture();
  const heightTexNode = texture(initialTex);

  // uCursorUV starts at (-2,-2) so it's off the [0,1] heightmap and invisible.
  const uCursorUV = uniform(new THREE.Vector2(-2, -2));

  // Create the default brush mask (soft circle = same as old radial falloff).
  const defaultMaskTex = BRUSH_MASKS.soft();

  // sculptBrush uploads the CPU heightmap to its RT and sets heightTexNode.value.
  const sculpt = createSculptBrush(renderer, initialTex, heightTexNode, defaultMaskTex);

  // ── Paint system (splatmap + texture library + overlay) ───────────────────
  const splatMap   = new SplatMap();
  const textureLib = new TextureLibrary();
  const splatOverlay = createSplatOverlay(
    textureLib.getLayerUniforms(),
    textureLib.albedoArrayTex,
    textureLib.ormArrayTex,
    splatMap.tex,
  );

  // LOD meshes share the same heightTexNode, cursor uniforms, brush mask, and rotation.
  const lod = createTerrainLOD(heightTexNode, uCursorUV, sculpt.uRadius, sculpt.maskNode, sculpt.uMaskRotation, splatOverlay);
  scene.add(lod.group);
  // Terrain starts flat (createHeightmapTexture initializes all-zeros).
  // User can generate terrain manually via the Procedural panel.

  // ── Human character ────────────────────────────────────────────────────────
  const character = createHumanCharacter(scene, renderer);

  // ── Play mode ──────────────────────────────────────────────────────────────
  const playPanel      = document.getElementById("play-panel");
  const playStopBar    = document.getElementById("play-stop-bar");
  const sculptPanel    = document.getElementById("sculpt-panel");
  const paintPanel     = document.getElementById("paint-panel");
  const propsPanel     = document.getElementById("props-panel");
  const splinePanel    = document.getElementById("spline-panel");
  const playStatPos    = document.getElementById("play-stat-pos");
  const playStatSpeed  = document.getElementById("play-stat-speed");
  const playStatGround = document.getElementById("play-stat-ground");

  const playMode = createPlayMode({
    renderer,
    camera,
    controls,
    sampleTerrainHeight: (u, v) => sampleTerrainHeight(u, v),
    uCursorUV,
    character,
    onStartWalking: () => { playHint.classList.add("visible"); },
    onEnterMenu:    () => { playHint.classList.remove("visible"); },
    onExit: () => {
      tbPlay.classList.remove("active");
      playStopBar.classList.remove("visible");
      playHint.classList.remove("visible");
      playPanel.style.display = "none";
      syncSculptPanelVisibility();
      syncPaintPanelVisibility();
      syncGrassPanelVisibility();
      syncPropsPanelVisibility();
      syncSplinePanelVisibility();
      syncEditorOrbitEnabled();
    },
  });

  const worldToolState = createWorldToolState();
  const editorConfig = {
    world: { size: WORLD_SIZE },
    lod: { ...V2_CONFIG.lod },
  };
  const perf = createPerfState();
  let splineSys = null;

  function getTerrainMeshesForWorld() {
    const out = [];
    lod.group.traverse((o) => { if (o.isMesh) out.push(o); });
    return out;
  }

  worldEnv = await createWorldEnvironment({
    scene,
    renderer,
    camera,
    controls,
    playMode,
    toolState: worldToolState,
    heightTex: initialTex,
    terrainSize: WORLD_SIZE,
    getSplineSystem: () => splineSys,
    getTerrainMeshes: getTerrainMeshesForWorld,
  });

  function buildWorldPanelUi() {
    buildWorldPanel({
      toolState: worldToolState,
      config: editorConfig,
      perf,
      syncCsm: () => worldEnv?.syncCsm(),
      setCsmEnabled: (on) => worldEnv?.setCsmEnabled(on),
      applyPostFxState: () => worldEnv?.applyPostFxState(),
      syncFog: () => {
        worldEnv?.syncFog();
        worldEnv?.driveFogSun();
      },
      applySkyMode: (mode, prev) => worldEnv?.applySkyMode(mode, prev),
      importHdr: () => worldEnv?.importHdr(),
      setTimeOfDay: (t) => worldEnv?.setTimeOfDay(t),
      rebuildProceduralSkyEnv: () => worldEnv?.rebuildProceduralSkyEnv(),
      rebuildSkyEnv: () => worldEnv?.rebuildSkyEnv(),
      syncInteriorUniforms: () => worldEnv?.syncInteriorUniforms(),
      rebuildInteriorVolumes: () => worldEnv?.rebuildInteriorVolumes(),
      worldOceanChanged: () => worldEnv?.worldOceanChanged(),
      onConfigChanged: () => {},
      ui: { refreshLiveSliders: () => {} },
    });
    if (typeof lucide !== "undefined") lucide.createIcons();
  }
  buildWorldPanelUi();

  // ── Grass system ───────────────────────────────────────────────────────────
  const grassTerrainData = new GrassTerrainData();
  const grassWindTex      = createWindTexture();
  const grassSpecNoiseTex = createSpecNoiseTexture();

  const grassState = {
    bladeHeight: 1, bladeWidth: 0.15, bladeYSegments: 7, tipTaperStart: 0.5,
    crossed: true,
    bendFocus: 0.5, stiffness: 0, maxAngle: 1.4, naturalLean: 0.9,
    windSpeed: 0.2, windStrength: 1.4, windGust: 0.3, windWaveScale: 0.12, windAngle: 0,
    clumpScale: 1.5, clumpStrength: 0.7,
    grassDensity: 1,
    bladeColor: "#0e300e", tipColor: "#004d05",
    aoBase: 0.25, aoPower: 2,
    colorVariation: true,
    cvHueSpread: 0.08, cvSatSpread: 0.3, cvDryAmount: 0.15, cvDryColor: "#8a7a3a",
    skyBlend: 0.8, cylindrical: 0.3, viewThicken: 0.45,
    bssColor: "#2d7a2d", bssIntensity: 1.2, bssPower: 2,
    frontScatter: 0.3, rimSSS: 0.25,
    slopeEnabled: false, slopeMin: 0.65, slopeMax: 0.85,
    terrainTintEnabled: false, terrainTintAutoSource: false,
    terrainTintManualMode: 0, terrainTintStrength: 0.5, terrainTintRootBias: 0.35,
    specV1Enabled: false, specV1Intensity: 1.5, specV1Color: "#ffffff",
    specV1DirX: -1, specV1DirY: 1, specV1DirZ: 0.5, specV1Power: 25.6,
    specV2Enabled: false, specV2Intensity: 1, specV2Color: "#ffffff",
    specV2DirX: -1, specV2DirY: 0.45, specV2DirZ: 1,
    specV2NoiseScale: 3, specV2NoiseStr: 0.6, specV2Power: 12, specV2TipBias: 0.5,
    interactionRadius: 1.5, interactionStrength: 0.7, interactionMode: 0,
    receiveShadow: true, lodDebug: false,
    lodMidDistance: 40, lodFarDistance: 80, lodMaxDistance: 200, lodMegaMaxDistance: 400,
    lodMidSegments: 3, lodFarSegments: 2, lodMegaSegments: 1,
    lodFarBladeWidth: 0.45, lodMegaBladeWidth: 0.7,
  };

  const grassBrush = { radius: 60, strength: 0.7, falloff: 2.0, erase: false };

  let grassRings = null;
  let _grassBuilding = false;

  async function ensureGrassBuilt() {
    if (grassRings || _grassBuilding) return;
    _grassBuilding = true;
    try {
      const shared = {
        scene,
        renderer,
        heightTex:        grassTerrainData.grassHeightTex,
        terrainNormalTex: grassTerrainData.terrainNormalTex,
        densityTex:       grassTerrainData.densityTex,
        windTex:          grassWindTex,
        specNoiseTex:     grassSpecNoiseTex,
        worldSize:        WORLD_SIZE,
        gp:               grassState,
      };
      const rings = [
        new HybridGrassSystem({ ...shared, name: "HybridNear",
          tileSize: 130, bladesPerSide: 512,
          outerR0: 36, outerR1: 62 }),
        new HybridGrassSystem({ ...shared, name: "HybridMidThin",
          tileSize: 180, bladesPerSide: 384, segments: 3,
          innerR0: 36, innerR1: 56, outerR0: 70, outerR1: 88,
          crossFadeR0: 70, crossFadeR1: 88 }),
        new HybridGrassSystem({ ...shared, name: "HybridMid",
          normalMode: "flat", crossed: false,
          tileSize: 440, bladesPerSide: 576,
          bladeWidth: 0.45, segments: 2, bladeHeightMul: 1.1,
          innerR0: 64, innerR1: 88, outerR0: 180, outerR1: 218 }),
        new HybridGrassSystem({ ...shared, name: "HybridFar",
          normalMode: "flat", crossed: false,
          tileSize: 800, bladesPerSide: 384,
          bladeWidth: 0.7, segments: 1, bladeHeightMul: 1.2,
          innerR0: 175, innerR1: 215, outerR0: 360, outerR1: 398 }),
      ];
      for (const r of rings) await r.init(camera);
      for (const r of rings) {
        r.setEnabled(true);
        // Widen horizontal cull pad so fast camera rotation (play-mode mouse-look)
        // doesn't pop blades in at screen edges. The VS clips properly regardless;
        // off-screen blades in the compact buffer cost only VS invocations, no pixels.
        r.u.uCullPadNdcX.value    = 0.45;
        r.u.uCullPadNdcYFar.value = 0.45;
      }
      grassRings = rings;
    } catch (err) {
      console.error("[V3 Grass] build failed:", err);
    } finally {
      _grassBuilding = false;
    }
  }

  function syncGrassUniforms() {
    if (!grassRings || !worldEnv) return;
    const sunDir = worldEnv.getEffectiveLightDir();
    for (const r of grassRings) r.syncFromState(grassState, sunDir);
    syncHybridGrassLod(grassRings, grassState);
  }

  // ── UI wiring ──────────────────────────────────────────────────────────────
  const btnRaise  = document.getElementById("btn-raise");
  const btnLower  = document.getElementById("btn-lower");
  const btnSmooth  = document.getElementById("btn-smooth");
  const btnFlatten = document.getElementById("btn-flatten");
  const btnNoise   = document.getElementById("btn-noise");
  const btnTerrace = document.getElementById("btn-terrace");
  const slSpacing       = document.getElementById("sl-spacing");
  const lblSpacing      = document.getElementById("lbl-spacing");
  const slClampMin  = document.getElementById("sl-clamp-min");
  const lblClampMin = document.getElementById("lbl-clamp-min");
  const slClampMax  = document.getElementById("sl-clamp-max");
  const lblClampMax = document.getElementById("lbl-clamp-max");
  const subRaiseLower   = document.getElementById("sub-raiselower");
  const subTerrace      = document.getElementById("sub-terrace");
  const subNoise        = document.getElementById("sub-noise");
  const subErode        = document.getElementById("sub-erode");
  const subRamp         = document.getElementById("sub-ramp");
  const btnErode        = document.getElementById("btn-erode");
  const btnRamp         = document.getElementById("btn-ramp");
  const btnSmudge       = document.getElementById("btn-smudge");
  const btnContrast     = document.getElementById("btn-contrast");
  const slNoiseOct      = document.getElementById("sl-noise-oct");
  const lblNoiseOct     = document.getElementById("lbl-noise-oct");
  const slThermalSlope  = document.getElementById("sl-thermal-slope");
  const lblThermalSlope = document.getElementById("lbl-thermal-slope");
  const slThermalIter   = document.getElementById("sl-thermal-iter");
  const lblThermalIter  = document.getElementById("lbl-thermal-iter");
  const slRampWidth     = document.getElementById("sl-ramp-width");
  const lblRampWidth    = document.getElementById("lbl-ramp-width");
  const rampHint        = document.getElementById("ramp-hint");
  const btnStampSmooth  = document.getElementById("btn-stamp-smooth");
  const btnStampPlateau = document.getElementById("btn-stamp-plateau");
  const btnStampCrater  = document.getElementById("btn-stamp-crater");
  const slTerraceStep   = document.getElementById("sl-terrace-step");
  const lblTerraceStep  = document.getElementById("lbl-terrace-step");
  const slTerraceSharp  = document.getElementById("sl-terrace-sharp");
  const lblTerraceSharp = document.getElementById("lbl-terrace-sharp");
  const slNoiseScale    = document.getElementById("sl-noise-scale");
  const lblNoiseScale   = document.getElementById("lbl-noise-scale");
  const tbHelp          = document.getElementById("tb-help");
  const tbSculpt        = document.getElementById("tb-sculpt");
  const tbPlay          = document.getElementById("tb-play");
  const toolsModeSelect = document.getElementById("tools-mode-select");
  const viewNavHint     = document.getElementById("view-nav-hint");
  const tbSave    = document.getElementById("tb-save");
  const tbLoad    = document.getElementById("tb-load");
  const tbUndo    = document.getElementById("tb-undo");
  const tbRedo    = document.getElementById("tb-redo");
  const playHint  = document.getElementById("play-hint");
  const helpOverlay = document.getElementById("help-overlay");
  const slSize    = document.getElementById("sl-size");
  const lblSize   = document.getElementById("lbl-size");
  const slStr     = document.getElementById("sl-str");
  const lblStr    = document.getElementById("lbl-str");
  const slFalloff  = document.getElementById("sl-falloff");
  const lblFalloff = document.getElementById("lbl-falloff");

  const genMode       = document.getElementById("gen-mode");
  const genSeed       = document.getElementById("gen-seed");
  const genScale      = document.getElementById("gen-scale");
  const lblGenScale   = document.getElementById("lbl-gen-scale");
  const genHeight     = document.getElementById("gen-height");
  const lblGenHeight  = document.getElementById("lbl-gen-height");
  const genOctaves    = document.getElementById("gen-octaves");
  const lblGenOctaves = document.getElementById("lbl-gen-octaves");
  const genWarp       = document.getElementById("gen-warp");
  const lblGenWarp    = document.getElementById("lbl-gen-warp");
  const genShape      = document.getElementById("gen-shape");
  const genDropoff    = document.getElementById("gen-dropoff");
  const lblGenDropoff = document.getElementById("lbl-gen-dropoff");
  const genPlains     = document.getElementById("gen-plains");
  const lblGenPlains  = document.getElementById("lbl-gen-plains");
  const genOffsetX    = document.getElementById("gen-offsetX");
  const lblGenOffsetX = document.getElementById("lbl-gen-offsetX");
  const genOffsetZ    = document.getElementById("gen-offsetZ");
  const lblGenOffsetZ = document.getElementById("lbl-gen-offsetZ");
  const btnGenerate   = document.getElementById("btn-generate");
  const btnRandomSeed = document.getElementById("btn-random-seed");

  // ── Paint panel DOM refs ───────────────────────────────────────────────────
  const layerCardGrid  = document.getElementById("layer-card-grid");
  const pslRadius      = document.getElementById("psl-radius");
  const plblRadius     = document.getElementById("plbl-radius");
  const pslStrength    = document.getElementById("psl-strength");
  const plblStrength   = document.getElementById("plbl-strength");
  const pslFalloff     = document.getElementById("psl-falloff");
  const plblFalloff    = document.getElementById("plbl-falloff");
  const pslSpacing     = document.getElementById("psl-spacing");
  const plblSpacing    = document.getElementById("plbl-spacing");
  const pslOpacity     = document.getElementById("psl-opacity");
  const plblOpacity    = document.getElementById("plbl-opacity");
  const pslSolo        = document.getElementById("psl-solo");
  const pslHBlend      = document.getElementById("psl-hblend");
  const plblHBlend     = document.getElementById("plbl-hblend");
  const pslHContrast   = document.getElementById("psl-hcontrast");
  const plblHContrast  = document.getElementById("plbl-hcontrast");
  const pslNoise       = document.getElementById("psl-noise");
  const plblNoise      = document.getElementById("plbl-noise");
  const pslNScale      = document.getElementById("psl-nscale");
  const plblNScale     = document.getElementById("plbl-nscale");
  const pslNOct        = document.getElementById("psl-noct");
  const plblNOct       = document.getElementById("plbl-noct");
  const pckNEdge       = document.getElementById("pck-nedge");
  const pmaskPreview   = document.getElementById("pmask-preview");
  const pmaskChips     = document.getElementById("pmask-chips");
  const pbtnMaskPng    = document.getElementById("pbtn-mask-png");
  const pslMaskRot     = document.getElementById("psl-maskrot");
  const plblMaskRot    = document.getElementById("plbl-maskrot");
  const pckMaskRand    = document.getElementById("pck-maskrand");
  const pckMaskFollow  = document.getElementById("pck-maskfollow");
  const texlibTabsEl   = document.getElementById("texlib-tabs");
  const texlibNameEl   = document.getElementById("texlib-name");
  const pbtnFill          = document.getElementById("pbtn-fill");
  const pbtnClear         = document.getElementById("pbtn-clear");
  const pbtnSaveSplat     = document.getElementById("pbtn-save-splat");
  const pbtnLoadSplat     = document.getElementById("pbtn-load-splat");
  const pbtnAutoGenerate  = document.getElementById("pbtn-auto-generate");
  const tautoEnabled      = document.getElementById("tauto-enabled");
  const tautoHmin         = document.getElementById("tauto-hmin");
  const tautoHmax         = document.getElementById("tauto-hmax");
  const tautoSmin         = document.getElementById("tauto-smin");
  const tautoSmax         = document.getElementById("tauto-smax");
  const tautoBlend        = document.getElementById("tauto-blend");
  const tautoStrength     = document.getElementById("tauto-strength");
  const tautoLblHmin      = document.getElementById("tauto-lbl-hmin");
  const tautoLblHmax      = document.getElementById("tauto-lbl-hmax");
  const tautoLblSmin      = document.getElementById("tauto-lbl-smin");
  const tautoLblSmax      = document.getElementById("tauto-lbl-smax");
  const tautoLblBlend     = document.getElementById("tauto-lbl-blend");
  const tautoLblStrength  = document.getElementById("tauto-lbl-strength");

  // ── Paint state + system ───────────────────────────────────────────────────
  const paintState = {
    activeLayer: 1,
    brushOpacity: 1.0,
    brush: { radius: 80, strength: 0.50, falloff: 2.0, spacingFactor: 0.10 },
    noiseMask: 0.0, noiseScale: 3.0, noiseOctaves: 3, noiseEdgeOnly: false,
    maskRotation: 0, maskRandomRotation: false, maskFollowStroke: false,
  };
  const paintBrushMask = new BrushMask();
  paintBrushMask.generateBuiltin("soft");
  const paintSys = new PaintSystem({ paintState, splatMap, brushMask: paintBrushMask });
  let   texlibActiveSlot = 0;

  let stickyMode  = "raise";
  let stickyStamp = "smooth";
  let strokeSpacingFactor = 0.22;
  let rampState   = "idle";  // "idle" | "waiting_end"
  let rampStartUV = null;

  function setMode(m) {
    btnRaise  .classList.toggle("active", m === "raise");
    btnLower  .classList.toggle("active", m === "lower");
    btnSmooth .classList.toggle("active", m === "smooth");
    btnFlatten.classList.toggle("active", m === "flatten");
    btnNoise  .classList.toggle("active", m === "noise");
    btnTerrace.classList.toggle("active", m === "terrace");
    btnErode  .classList.toggle("active", m === "erode");
    btnRamp   .classList.toggle("active", m === "ramp");
    btnSmudge .classList.toggle("active", m === "smudge");
    btnContrast.classList.toggle("active", m === "contrast");
    // Tool options always track stickyMode so modifier-key overrides don't hide the zone.
    subRaiseLower.style.display = (stickyMode === "raise" || stickyMode === "lower") ? "" : "none";
    subTerrace   .style.display = stickyMode === "terrace" ? "" : "none";
    subNoise     .style.display = stickyMode === "noise"   ? "" : "none";
    subErode     .style.display = stickyMode === "erode"   ? "" : "none";
    subRamp      .style.display = stickyMode === "ramp"    ? "" : "none";
  }

  btnRaise  .addEventListener("click", () => { stickyMode = "raise";   refreshModeIndicator(); });
  btnLower  .addEventListener("click", () => { stickyMode = "lower";   refreshModeIndicator(); });
  btnSmooth .addEventListener("click", () => { stickyMode = "smooth";  refreshModeIndicator(); });
  btnFlatten.addEventListener("click", () => { stickyMode = "flatten"; refreshModeIndicator(); });
  btnNoise  .addEventListener("click", () => { stickyMode = "noise";   refreshModeIndicator(); });
  btnTerrace.addEventListener("click", () => { stickyMode = "terrace"; refreshModeIndicator(); });
  btnErode   .addEventListener("click", () => { stickyMode = "erode";    refreshModeIndicator(); });
  btnSmudge  .addEventListener("click", () => { stickyMode = "smudge";   refreshModeIndicator(); });
  btnContrast.addEventListener("click", () => { stickyMode = "contrast"; refreshModeIndicator(); });
  btnRamp   .addEventListener("click", () => {
    stickyMode = "ramp";
    rampState = "idle";
    rampHint.textContent = "Click start point...";
    refreshModeIndicator();
  });

  function setStickyStamp(s) {
    stickyStamp = s;
    btnStampSmooth .classList.toggle("active", s === "smooth");
    btnStampPlateau.classList.toggle("active", s === "plateau");
    btnStampCrater .classList.toggle("active", s === "crater");
  }
  btnStampSmooth .addEventListener("click", () => setStickyStamp("smooth"));
  btnStampPlateau.addEventListener("click", () => setStickyStamp("plateau"));
  btnStampCrater .addEventListener("click", () => setStickyStamp("crater"));

  function syncClampUI() {
    lblClampMin.textContent = slClampMin.value + "m";
    lblClampMax.textContent = slClampMax.value + "m";
  }
  slClampMin.addEventListener("input", () => {
    // Keep min below max with at least 10m gap
    if (Number(slClampMin.value) >= Number(slClampMax.value) - 10)
      slClampMin.value = Number(slClampMax.value) - 10;
    sculpt.uClampMin.value = Number(slClampMin.value) / MAX_HEIGHT;
    syncClampUI();
  });
  slClampMax.addEventListener("input", () => {
    if (Number(slClampMax.value) <= Number(slClampMin.value) + 10)
      slClampMax.value = Number(slClampMin.value) + 10;
    sculpt.uClampMax.value = Number(slClampMax.value) / MAX_HEIGHT;
    syncClampUI();
  });
  syncClampUI();

  const pointerMods = { shift: false, ctrl: false, alt: false };

  function syncPointerMods(e) {
    pointerMods.shift = e.shiftKey;
    pointerMods.ctrl  = e.ctrlKey || e.metaKey;
    pointerMods.alt   = e.altKey;
  }

  /** Modifier keys temporarily override the sticky chip selection. */
  function getStrokeMode() {
    if (pointerMods.alt) return "flatten";
    if (pointerMods.ctrl) return "smooth";
    if (pointerMods.shift) return "lower";
    return stickyMode;
  }

  function refreshModeIndicator() {
    setMode(getStrokeMode());
  }

  window.addEventListener("keydown", e => {
    syncPointerMods(e);
    refreshModeIndicator();
  });
  window.addEventListener("keyup", e => {
    syncPointerMods(e);
    refreshModeIndicator();
  });

  // ── Terrain presets ────────────────────────────────────────────────────────
  const TERRAIN_PRESETS = {
    alpine:   { mode:"ridge", scale:5, octaves:7, height:220, seed:42,  domainWarp:1.2, dropoffShape:"circle",  dropoff:1.0, plains:0,    offsetX:0,   offsetZ:0   },
    badlands: { mode:"ridge", scale:7, octaves:8, height:130, seed:77,  domainWarp:2.5, dropoffShape:"noise",   dropoff:0.6, plains:0,    offsetX:0,   offsetZ:0   },
    volcanic: { mode:"ridge", scale:6, octaves:5, height:350, seed:7,   domainWarp:0.4, dropoffShape:"circle",  dropoff:3.0, plains:0,    offsetX:0,   offsetZ:0   },
    highland: { mode:"fbm",   scale:3, octaves:5, height:80,  seed:123, domainWarp:1.8, dropoffShape:"noise",   dropoff:0.9, plains:0.15, offsetX:0,   offsetZ:0   },
    crater:   { mode:"ridge", scale:5, octaves:7, height:200, seed:99,  domainWarp:0.8, dropoffShape:"caldera", dropoff:1.5, plains:0.05, offsetX:0,   offsetZ:0   },
  };

  function readGenFromUI() {
    genParams.mode         = genMode.value;
    genParams.seed         = Number(genSeed.value) || 0;
    genParams.scale        = Number(genScale.value);
    genParams.height       = Number(genHeight.value);
    genParams.octaves      = Number(genOctaves.value);
    genParams.domainWarp   = Number(genWarp.value)    / 10;
    genParams.dropoffShape = genShape.value;
    genParams.dropoff      = Number(genDropoff.value) / 10;
    genParams.plains       = Number(genPlains.value)  / 100;
    genParams.offsetX      = Number(genOffsetX.value) / 10;
    genParams.offsetZ      = Number(genOffsetZ.value) / 10;
  }

  function syncGenUI() {
    lblGenScale.textContent   = genScale.value;
    lblGenHeight.textContent  = genHeight.value;
    lblGenOctaves.textContent = genOctaves.value;
    lblGenWarp.textContent    = (Number(genWarp.value)    / 10).toFixed(1);
    lblGenDropoff.textContent = (Number(genDropoff.value) / 10).toFixed(1);
    lblGenPlains.textContent  = genPlains.value + "%";
    lblGenOffsetX.textContent = (Number(genOffsetX.value) / 10).toFixed(1);
    lblGenOffsetZ.textContent = (Number(genOffsetZ.value) / 10).toFixed(1);
  }

  function applyProceduralTerrain() {
    readGenFromUI();
    sculpt.replaceHeightData(buildProceduralHeightmap(genParams));
    onHistoryChange();
  }

  function pushPresetToUI(p) {
    genMode.value     = p.mode;
    genSeed.value     = p.seed;
    genScale.value    = p.scale;
    genHeight.value   = p.height;
    genOctaves.value  = p.octaves;
    genWarp.value     = Math.round(p.domainWarp * 10);
    genShape.value    = p.dropoffShape;
    genDropoff.value  = Math.round(p.dropoff    * 10);
    genPlains.value   = Math.round(p.plains     * 100);
    genOffsetX.value  = Math.round(p.offsetX    * 10);
    genOffsetZ.value  = Math.round(p.offsetZ    * 10);
    syncGenUI();
  }

  for (const btn of document.querySelectorAll(".preset-btn")) {
    btn.addEventListener("click", () => {
      const p = TERRAIN_PRESETS[btn.dataset.preset];
      if (!p) return;
      document.querySelectorAll(".preset-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      pushPresetToUI(p);
      applyProceduralTerrain();
    });
  }

  for (const sl of [genScale, genHeight, genOctaves, genWarp, genDropoff, genPlains, genOffsetX, genOffsetZ]) {
    sl.addEventListener("input", syncGenUI);
  }
  btnGenerate.addEventListener("click", () => applyProceduralTerrain());
  btnRandomSeed.addEventListener("click", () => {
    genSeed.value = Math.floor(Math.random() * 100000);
    document.querySelectorAll(".preset-btn").forEach(b => b.classList.remove("active"));
    applyProceduralTerrain();
  });
  syncGenUI();

  async function saveHeightmap() {
    await syncHeightmapToCPU();
    const buf = encodeHeightmapFile(cpuHeightmap, {
      width:      HEIGHTMAP_SIZE,
      height:     HEIGHTMAP_SIZE,
      worldSize:  WORLD_SIZE,
      maxHeight:  MAX_HEIGHT,
    });
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    downloadBuffer(buf, `terrain-${ts}.v3height`);
  }

  async function loadHeightmap() {
    const file = await pickHeightmapFile();
    if (!file) return;
    try {
      const decoded = decodeHeightmapFile(await file.arrayBuffer());
      if (decoded.width !== HEIGHTMAP_SIZE || decoded.height !== HEIGHTMAP_SIZE) {
        window.alert(
          `This heightmap is ${decoded.width}×${decoded.height}; `
          + `this editor expects ${HEIGHTMAP_SIZE}×${HEIGHTMAP_SIZE}.`,
        );
        return;
      }
      sculpt.replaceHeightData(decoded.heights);
      onHistoryChange();
    } catch (err) {
      console.error(err);
      window.alert(err instanceof Error ? err.message : "Failed to load heightmap.");
    }
  }

  // ── Brush mask ─────────────────────────────────────────────────────────────
  const maskChipsEl   = document.getElementById("mask-chips");
  const btnMaskPNG    = document.getElementById("btn-mask-png");
  const maskPreviewEl = document.getElementById("mask-preview");

  function updateMaskPreview(tex) {
    const ctx = maskPreviewEl.getContext("2d");
    ctx.clearRect(0, 0, 48, 48);
    if (tex?.image) ctx.drawImage(tex.image, 0, 0, 48, 48);
  }

  const slMaskRot  = document.getElementById("sl-mask-rot");
  const lblMaskRot = document.getElementById("lbl-mask-rot");

  function syncMaskRotUI() {
    lblMaskRot.textContent = slMaskRot.value + "°";
    maskPreviewEl.style.transform = `rotate(${slMaskRot.value}deg)`;
  }

  slMaskRot.addEventListener("input", () => {
    sculpt.uMaskRotation.value = Number(slMaskRot.value) * Math.PI / 180;
    syncMaskRotUI();
  });

  function setMask(name, tex) {
    sculpt.maskNode.value = tex;
    updateMaskPreview(tex);
    for (const chip of maskChipsEl.querySelectorAll(".option-chip")) {
      chip.classList.toggle("active", chip.dataset.mask === name);
    }
  }

  // Pre-generate all preset textures lazily (only on first click to save startup time).
  const maskCache = { soft: defaultMaskTex };

  maskChipsEl.addEventListener("click", e => {
    const chip = e.target.closest(".option-chip[data-mask]");
    if (!chip) return;
    const name = chip.dataset.mask;
    if (!maskCache[name]) maskCache[name] = BRUSH_MASKS[name]();
    setMask(name, maskCache[name]);
  });

  btnMaskPNG.addEventListener("click", async () => {
    const tex = await loadMaskPNG();
    if (tex) setMask("__custom", tex);
  });

  // Show soft circle preview immediately on startup.
  updateMaskPreview(defaultMaskTex);

  // ── Editor mode (view / sculpt) ────────────────────────────────────────────
  let editorMode = "view";
  const splineState = { ...DEFAULT_SPLINE_STATE };
  let splineToolState = {
    mode: "view",
    spline: splineState,
    props: null,
    propSlots: null,
    treePaint: { activeSlot: 0, minSpacing: 3 },
  };
  let _onLeavePropsMode = () => {};
  let _onLeaveSplineMode = () => {};
  let _onGizmoDragEnd = () => {};
  let _gizmoTarget = null;

  const grassPanel = document.getElementById("grass-panel");

  function syncSculptPanelVisibility() {
    sculptPanel.style.display = (editorMode === "sculpt" && !playMode.active) ? "" : "none";
  }

  function syncPaintPanelVisibility() {
    paintPanel.style.display = (editorMode === "paint" && !playMode.active) ? "" : "none";
  }

  function syncGrassPanelVisibility() {
    grassPanel.style.display = (editorMode === "grass" && !playMode.active) ? "" : "none";
  }

  function syncPropsPanelVisibility() {
    propsPanel.style.display = (editorMode === "props" && !playMode.active) ? "" : "none";
  }

  function syncSplinePanelVisibility() {
    splinePanel.style.display = (editorMode === "spline" && !playMode.active) ? "" : "none";
  }

  function applySplineModeEffects() {
    if (!splineSys?.handleGroup) return;
    if (editorMode !== "spline" && !playMode.active) {
      splineSys.dragging = false;
      splineSys.clearPreview?.();
    }
  }

  function setEditorMode(m, { force = false } = {}) {
    if (!force && m === editorMode) {
      toolsModeSelect.value = m;
      syncEditorOrbitEnabled();
      return;
    }
    if (editorMode === "spline" && m !== "spline") _onLeaveSplineMode();
    if (editorMode === "props" && m !== "props") _onLeavePropsMode();
    editorMode = m;
    if (splineToolState) splineToolState.mode = m;
    tbSculpt.classList.toggle("active", m === "sculpt");
    toolsModeSelect.value = m;
    if (m === "view") {
      uCursorUV.value.set(-2, -2);
      cancelStroke();
      tc.detach();
      tc.enabled = false;
      tc.visible = false;
      _gizmoTarget = null;
    } else if (m === "paint") {
      sculpt.uRadius.value = paintState.brush.radius / WORLD_SIZE;
    } else if (m === "grass") {
      uCursorUV.value.set(-2, -2);
      ensureGrassBuilt();
    } else if (m === "props" || m === "spline") {
      uCursorUV.value.set(-2, -2);
    }
    syncSculptPanelVisibility();
    syncPaintPanelVisibility();
    syncGrassPanelVisibility();
    syncPropsPanelVisibility();
    syncSplinePanelVisibility();
    applySplineModeEffects();
    if (viewNavHint) viewNavHint.style.display = (m === "view" && !playMode.active) ? "" : "none";
    syncEditorOrbitEnabled();
  }

  function enterPlay() {
    if (playMode.active) return;
    editorCamera?.onPlayEnter?.();
    playMode.enter();
    playMode.startWalking(); // request pointer lock immediately (still in click handler)
    tbPlay.classList.add("active");
    playStopBar.classList.add("visible");
    playPanel.style.display = "";
    sculptPanel.style.display = "none";
    paintPanel.style.display = "none";
    grassPanel.style.display = "none";
    propsPanel.style.display = "none";
    splinePanel.style.display = "none";
    helpOverlay.classList.remove("visible");
    tbHelp.classList.remove("active");
  }

  function exitPlay() {
    if (!playMode.active) return;
    playMode.exit();
  }

  tbSculpt.addEventListener("click", () => setEditorMode("sculpt"));
  toolsModeSelect.addEventListener("change", () => setEditorMode(toolsModeSelect.value));

  tbPlay.addEventListener("click", () => {
    if (playMode.active) exitPlay();
    else enterPlay();
  });

  // Click viewport while in play but pointer not locked → re-lock
  renderer.domElement.addEventListener("click", () => {
    if (playMode.active && !playMode.walking) playMode.startWalking();
  });

  document.getElementById("play-stop-btn").addEventListener("click", () => exitPlay());

  tbHelp.addEventListener("click", () => {
    helpOverlay.classList.toggle("visible");
    tbHelp.classList.toggle("active");
  });
  // Close overlay when clicking anywhere on the viewport
  renderer.domElement.addEventListener("mousedown", () => {
    helpOverlay.classList.remove("visible");
    tbHelp.classList.remove("active");
  }, { capture: true });

  tbSave.addEventListener("click", () => { saveHeightmap(); });
  tbLoad.addEventListener("click", () => { loadHeightmap(); });
  tbUndo.addEventListener("click", () => { if (sculpt.undo()) onHistoryChange(); });
  tbRedo.addEventListener("click", () => { if (sculpt.redo()) onHistoryChange(); });

  function syncSizeUI()    { lblSize   .textContent = Math.round(sculpt.uRadius.value   * 100) + "%"; }
  function syncStrUI()     { lblStr    .textContent = Math.round(sculpt.uStrength.value * 1000); }
  function syncFalloffUI() { lblFalloff.textContent = (slFalloff.value / 10).toFixed(1); }

  slSize.addEventListener("input", () => {
    sculpt.uRadius.value = slSize.value / 100;
    syncSizeUI();
  });
  slStr.addEventListener("input", () => {
    sculpt.uStrength.value = slStr.value / 1000;
    syncStrUI();
  });
  slFalloff.addEventListener("input", () => {
    sculpt.uFalloff.value = slFalloff.value / 10;
    syncFalloffUI();
  });

  function syncSpacingUI() { lblSpacing.textContent = slSpacing.value + "%"; }
  slSpacing.addEventListener("input", () => {
    strokeSpacingFactor = Number(slSpacing.value) / 100;
    syncSpacingUI();
  });
  syncSpacingUI();

  function syncTerraceUI() {
    lblTerraceStep .textContent = slTerraceStep.value + "m";
    lblTerraceSharp.textContent = slTerraceSharp.value + "%";
  }
  slTerraceStep.addEventListener("input", () => {
    sculpt.uTerraceStep.value = Number(slTerraceStep.value) / MAX_HEIGHT;
    syncTerraceUI();
  });
  slTerraceSharp.addEventListener("input", () => {
    sculpt.uTerraceSharpness.value = Number(slTerraceSharp.value) / 100;
    syncTerraceUI();
  });
  syncTerraceUI();

  function syncNoiseScaleUI() {
    lblNoiseScale.textContent = (Number(slNoiseScale.value) / 10).toFixed(1);
  }
  slNoiseScale.addEventListener("input", () => {
    sculpt.uNoiseScale.value = Number(slNoiseScale.value) / 10;
    syncNoiseScaleUI();
  });
  syncNoiseScaleUI();

  function syncNoiseOctUI() { lblNoiseOct.textContent = slNoiseOct.value; }
  slNoiseOct.addEventListener("input", () => {
    sculpt.uNoiseOctaves.value = Number(slNoiseOct.value);
    syncNoiseOctUI();
  });
  syncNoiseOctUI();

  function syncThermalUI() {
    lblThermalSlope.textContent = slThermalSlope.value + "°";
    lblThermalIter .textContent = slThermalIter.value;
  }
  slThermalSlope.addEventListener("input", () => {
    const deg = Number(slThermalSlope.value);
    sculpt.uThermalSlope.value = Math.tan(deg * Math.PI / 180) * WORLD_SIZE / HEIGHTMAP_SIZE / MAX_HEIGHT;
    syncThermalUI();
  });
  slThermalIter.addEventListener("input", () => {
    sculpt.thermalConfig.iterations = Number(slThermalIter.value);
    syncThermalUI();
  });
  syncThermalUI();

  function syncRampWidthUI() { lblRampWidth.textContent = slRampWidth.value + "m"; }
  slRampWidth.addEventListener("input", () => {
    sculpt.uRampWidth.value = Number(slRampWidth.value) / WORLD_SIZE;
    syncRampWidthUI();
  });
  syncRampWidthUI();

  // Initialize tool-options zone visibility for the default sticky mode.
  setMode(stickyMode);

  // ── Input ──────────────────────────────────────────────────────────────────
  const mouse     = new THREE.Vector2();
  const raycaster = new THREE.Raycaster();
  const gndPlane  = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const liftPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const hitPoint  = new THREE.Vector3();

  // ── CPU heightmap mirror for accurate raycasting on tall terrain ────────────
  const cpuHeightmap    = new Float32Array(HEIGHTMAP_SIZE * HEIGHTMAP_SIZE);
  let readbackInFlight  = false;
  let readbackPending   = false;

  async function syncHeightmapToCPU() {
    if (readbackInFlight) {
      readbackPending = true;
      return;
    }
    readbackInFlight = true;
    readbackPending  = false;
    try {
      const rt  = sculpt.getCurrentRT();
      const raw = await renderer.readRenderTargetPixelsAsync(
        rt, 0, 0, HEIGHTMAP_SIZE, HEIGHTMAP_SIZE,
      );
      const isHalf = raw instanceof Uint16Array;
      for (let i = 0; i < HEIGHTMAP_SIZE * HEIGHTMAP_SIZE; i++) {
        const r = raw[i * 4];
        cpuHeightmap[i] = isHalf ? THREE.DataUtils.fromHalfFloat(r) : r;
      }
      grassTerrainData.rebuildFromHeightmap(cpuHeightmap, HEIGHTMAP_SIZE, MAX_HEIGHT, WORLD_SIZE);
    } finally {
      readbackInFlight = false;
      if (readbackPending) syncHeightmapToCPU();
    }
  }

  function sampleHeightNormalized(u, v) {
    const fu = u * HEIGHTMAP_SIZE - 0.5;
    const fv = v * HEIGHTMAP_SIZE - 0.5;
    const x0 = Math.max(0, Math.floor(fu));
    const y0 = Math.max(0, Math.floor(fv));
    const x1 = Math.min(x0 + 1, HEIGHTMAP_SIZE - 1);
    const y1 = Math.min(y0 + 1, HEIGHTMAP_SIZE - 1);
    const tx = fu - x0;
    const ty = fv - y0;
    const i00 = y0 * HEIGHTMAP_SIZE + x0;
    const i10 = y0 * HEIGHTMAP_SIZE + x1;
    const i01 = y1 * HEIGHTMAP_SIZE + x0;
    const i11 = y1 * HEIGHTMAP_SIZE + x1;
    const h0 = cpuHeightmap[i00] * (1 - tx) + cpuHeightmap[i10] * tx;
    const h1 = cpuHeightmap[i01] * (1 - tx) + cpuHeightmap[i11] * tx;
    return h0 * (1 - ty) + h1 * ty;
  }

  function sampleTerrainHeight(u, v) {
    return sampleHeightNormalized(u, v) * MAX_HEIGHT;
  }

  const _normalVec = new THREE.Vector3();
  function sampleTerrainNormal(wx, wz) {
    const eps = WORLD_SIZE / HEIGHTMAP_SIZE;
    const u   = (wx + WORLD_SIZE / 2) / WORLD_SIZE;
    const v   = (wz + WORLD_SIZE / 2) / WORLD_SIZE;
    const hR  = sampleHeightNormalized(u + eps / WORLD_SIZE, v) * MAX_HEIGHT;
    const hL  = sampleHeightNormalized(u - eps / WORLD_SIZE, v) * MAX_HEIGHT;
    const hF  = sampleHeightNormalized(u, v + eps / WORLD_SIZE) * MAX_HEIGHT;
    const hB  = sampleHeightNormalized(u, v - eps / WORLD_SIZE) * MAX_HEIGHT;
    _normalVec.set(hL - hR, 2 * eps, hB - hF).normalize();
    return _normalVec;
  }

  let isPainting = false;
  let lastPaintUV = null;
  const MAX_STAMPS_PER_FRAME  = 12;

  function stampAt(u, v) {
    const mode = getStrokeMode();
    if      (mode === "smooth")  sculpt.smooth(u, v);
    else if (mode === "flatten") sculpt.flatten(u, v);
    else if (mode === "noise")   sculpt.noise(u, v);
    else if (mode === "terrace") sculpt.terrace(u, v);
    else if (mode === "erode")    sculpt.thermal(u, v);
    else if (mode === "smudge")   sculpt.smudge(u, v);
    else if (mode === "contrast") sculpt.contrast(u, v);
    else sculpt.paint(u, v, mode === "lower" ? -1 : 1, stickyStamp);
  }

  /** Interpolate stamps along the UV segment so fast drags don't leave gaps. */
  function applySculptStroke(u, v) {
    const spacingUV = Math.max(0.6 / WORLD_SIZE, sculpt.uRadius.value * strokeSpacingFactor);

    if (!lastPaintUV) {
      stampAt(u, v);
      lastPaintUV = { u, v };
      requestHeightmapReadback();
      return;
    }

    const du = u - lastPaintUV.u;
    const dv = v - lastPaintUV.v;
    const dist = Math.hypot(du, dv);
    if (dist < spacingUV) return;

    // Keep smudge direction current so the brush always pulls in the stroke direction.
    if (dist > 0) sculpt.uSmudgeDir.value.set(du / dist, dv / dist);

    const steps = Math.min(Math.ceil(dist / spacingUV), MAX_STAMPS_PER_FRAME);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      stampAt(lastPaintUV.u + du * t, lastPaintUV.v + dv * t);
    }
    lastPaintUV = { u, v };
    requestHeightmapReadback();
  }

  function requestHeightmapReadback() {
    syncHeightmapToCPU();
  }

  // Iterative ray-terrain intersection (bilinear height sampling).
  function getUV() {
    raycaster.setFromCamera(mouse, camera);
    if (!raycaster.ray.intersectPlane(gndPlane, hitPoint)) return null;

    for (let i = 0; i < 5; i++) {
      const u = (hitPoint.x + WORLD_SIZE / 2) / WORLD_SIZE;
      const v = (hitPoint.z + WORLD_SIZE / 2) / WORLD_SIZE;
      if (u < 0 || u > 1 || v < 0 || v > 1) return null;
      const h = sampleTerrainHeight(u, v);
      if (h < 0.01) break;          // flat terrain — no further refinement needed
      liftPlane.constant = -h;       // plane equation: Y + (-h) = 0  →  Y = h
      if (!raycaster.ray.intersectPlane(liftPlane, hitPoint)) return null;
    }

    const u = (hitPoint.x + WORLD_SIZE / 2) / WORLD_SIZE;
    const v = (hitPoint.z + WORLD_SIZE / 2) / WORLD_SIZE;
    return (u >= 0 && u <= 1 && v >= 0 && v <= 1) ? { u, v } : null;
  }

  function refreshMouse(e) {
    if (!e) return;
    const rect = viewport.getBoundingClientRect();
    mouse.x =  ((e.clientX - rect.left) / rect.width)  * 2 - 1;
    mouse.y = -((e.clientY - rect.top)  / rect.height) * 2 + 1;
  }

  function pickWorldAtClient(clientX, clientY) {
    const rect = renderer.domElement.getBoundingClientRect();
    mouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    const uv = getUV();
    if (!uv) return null;
    const wx = uv.u * WORLD_SIZE - WORLD_SIZE / 2;
    const wz = uv.v * WORLD_SIZE - WORLD_SIZE / 2;
    return { point: new THREE.Vector3(wx, sampleTerrainHeight(uv.u, uv.v), wz) };
  }

  editorCamera = createEditorCameraController({
    camera,
    controls,
    domElement: renderer.domElement,
    isActive: () => !playMode.active,
    pickWorldAtClient,
    getSelectionFocus: () => tc.object?.position ?? null,
  });

  /** Match v2 mouse map in tool modes; view mode also allows LMB drag (navigation). */
  function syncOrbitMouseBindings() {
    if (!editorCamera || playMode.active || editorCamera.flyMode) return;
    const viewNav = editorMode === "view";
    controls.mouseButtons.LEFT   = viewNav ? THREE.MOUSE.ROTATE : null;
    controls.mouseButtons.MIDDLE = THREE.MOUSE.ROTATE;
    controls.mouseButtons.RIGHT  = THREE.MOUSE.PAN;
  }

  syncEditorOrbitEnabled = () => {
    controls.enabled = !playMode.active && !editorCamera.flyMode;
    syncOrbitMouseBindings();
  };

  // Same as v2: disable orbit only while actively dragging the gizmo.
  tc.addEventListener("mouseDown", () => {
    if (tc.enabled) controls.enabled = false;
  });
  tc.addEventListener("mouseUp", () => {
    syncEditorOrbitEnabled();
    _onGizmoDragEnd();
    if (editorMode === "props") refreshPropPlacementPreview();
  });

  /** Reset camera/input/mode — call after editorCamera exists and again when late systems finish init. */
  function bootstrapEditorInput() {
    if (document.pointerLockElement) document.exitPointerLock();
    tc.detach();
    tc.enabled = false;
    tc.visible = false;
    _gizmoTarget = null;
    exitPlay();
    editorCamera.onPlayEnter();
    setEditorMode("view", { force: true });
  }

  // Late-init systems — loop starts before these exist; noop until wired below.
  const _noopUpdate = { update() {} };
  let propInstancer = _noopUpdate;
  let livePropManager = _noopUpdate;
  // splineSys assigned below (SplineSystem); starts as noop until wired.
  if (!splineSys) splineSys = _noopUpdate;
  let propLod = { lod0Distance: 60, lod1Distance: 150, fadeOutDistance: 500, castShadow: true };

  // True while thumbnail bake / readback owns the shared WebGPU renderer.
  let _rendererSideWork = false;
  async function withRendererSideWork(fn) {
    _rendererSideWork = true;
    try {
      return await fn();
    } finally {
      _rendererSideWork = false;
      renderer.setRenderTarget(null);
    }
  }

  function recoverEditorInput() {
    if (splineSys?.dragging) splineSys.dragging = false;
    syncEditorOrbitEnabled();
    if (controls.state !== -1) controls.state = -1;
  }

  // Recover orbit if a gizmo drag ends outside the canvas (v2 pattern).
  window.addEventListener("pointerup", recoverEditorInput);
  window.addEventListener("pointercancel", recoverEditorInput);

  // Keep viewport sized before first draw (v2 ResizeObserver pattern).
  const ro = new ResizeObserver(() => resizeRenderer());
  ro.observe(viewport);
  window.addEventListener("resize", () => resizeRenderer());
  resizeRenderer();

  // v2 precompiles terrain TSL pipelines before the loop — without this WebGPU
  // can show a black viewport until async compile finishes (or fail silently).
  try {
    await renderer.compileAsync(scene, camera);
    worldEnv.renderFrame(0);
  } catch (err) {
    console.warn("[V3] Pipeline precompile failed:", err);
  }

  bootstrapEditorInput();

  const _lodSnapVec = new THREE.Vector3();
  let _lastFrameMs = performance.now();
  let _loopErrors = 0;
  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const dt  = Math.min((now - _lastFrameMs) / 1000, 0.05);
    _lastFrameMs = now;

    renderer.info.reset();

    try {
      if (playMode.active) {
        playMode.update(dt);

        if (playMode.walking) {
          const s = playMode.getStats();
          playStatPos  .textContent = `${s.x}, ${s.y}, ${s.z}`;
          playStatSpeed.textContent = `${s.speed} m/s`;
          playStatGround.textContent = s.grounded ? "Yes" : "No";
        }

        const pp = playMode.playerPosition;
        _lodSnapVec.set(
          Math.round(pp.x / LOD_SNAP) * LOD_SNAP,
          0,
          Math.round(pp.z / LOD_SNAP) * LOD_SNAP,
        );
        lod.update(_lodSnapVec);
      } else {
        if (isPainting && editorMode === "sculpt") {
          const hit = getUV();
          if (hit) applySculptStroke(hit.u, hit.v);
        }
        editorCamera.update(dt);
        lod.update(controls.target);
        if (!editorCamera.flyMode) controls.update();
        if (!editorCamera.flyMode && !controls.enabled) syncEditorOrbitEnabled();
      }

      if (grassRings) {
        const _grassAnchor = playMode.active ? playMode.playerPosition : camera.position;
        for (const r of grassRings) r.update(_grassAnchor, camera);
      }

      propInstancer.update(camera, propLod);
      livePropManager.update(dt);
      splineSys.update(dt);

      tickPerf(perf, now, dt * 1000);
      perf.activeChunks = lod.group.children.length;
      worldEnv?.updateFrame(dt);
    } catch (err) {
      if (++_loopErrors === 1) console.error("[V3] Frame update error:", err);
    }

    try {
      renderer.setRenderTarget(null);
      if (!_rendererSideWork && worldEnv) {
        worldEnv.renderFrame(dt);
      } else if (!_rendererSideWork) {
        renderer.render(scene, camera);
      }
    } catch (err) {
      if (++_loopErrors === 1) {
        console.error("[V3] Render error:", err);
        const vp = document.getElementById("viewport");
        if (vp && !vp.querySelector("[data-v3-loop-error]")) {
          const msg = document.createElement("div");
          msg.dataset.v3LoopError = "1";
          msg.style.cssText = "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;color:#f66;font:14px/1.4 sans-serif;text-align:center;background:rgba(26,10,10,0.92);z-index:9999;pointer-events:none";
          msg.textContent = `Render error: ${err?.message ?? err}`;
          vp.appendChild(msg);
        }
      }
    }

    try {
      if (hasTimestamps) {
        renderer.resolveTimestampsAsync(THREE.TimestampQuery.RENDER);
        renderer.resolveTimestampsAsync(THREE.TimestampQuery.COMPUTE);
      }

      const ri    = renderer.info.render;
      const draws = ri.drawCalls ?? ri.calls ?? 0;
      const ktris = (ri.triangles ?? 0) / 1000;
      _maxDraw = Math.max(_maxDraw, draws);
      _maxTri  = Math.max(_maxTri,  ktris);
      drawPanel.update(draws, _maxDraw, 0);
      drawPanel.updateGraph(draws, _maxDraw);
      triPanel.update(ktris, _maxTri, 0);
      triPanel.updateGraph(ktris, _maxTri);
      stats.update();
    } catch (_) { /* stats overlay must never block the viewport */ }
  });

  let lastReadbackMs = 0;
  renderer.domElement.addEventListener("mousemove", e => {
    if (playMode.active || editorMode !== "sculpt") return;
    syncPointerMods(e);
    refreshModeIndicator();
    refreshMouse(e);
    const hit = getUV();
    uCursorUV.value.set(hit ? hit.u : -2, hit ? hit.v : -2);
    // Throttled readback so the cursor ring stays accurate while hovering.
    const now = performance.now();
    if (now - lastReadbackMs > 150) { lastReadbackMs = now; requestHeightmapReadback(); }
  });

  renderer.domElement.addEventListener("mouseleave", () => {
    uCursorUV.value.set(-2, -2);
    isPainting = false;
    lastPaintUV = null;
  });

  // LMB = sculpt. MMB/RMB handled by OrbitControls (orbit / pan).
  renderer.domElement.addEventListener("mousedown", e => {
    if (playMode.active || editorMode !== "sculpt") return;
    if (e.button !== 0) return;
    syncPointerMods(e);
    refreshModeIndicator();
    refreshMouse(e);

    // Ramp: two-click workflow — first click sets A, second click bakes the ramp.
    if (stickyMode === "ramp") {
      const uvHit = getUV();
      if (!uvHit) return;
      if (rampState === "idle") {
        rampStartUV = uvHit;
        rampState = "waiting_end";
        rampHint.textContent = "Click end point...";
      } else {
        sculpt.beginStroke();
        sculpt.ramp(rampStartUV, uvHit);
        onHistoryChange();
        rampState = "idle";
        rampHint.textContent = "Click start point...";
      }
      return;
    }

    sculpt.beginStroke();
    isPainting = true;
    lastPaintUV = null;
  });

  renderer.domElement.addEventListener("mouseup", e => {
    if (e.button !== 0) return;
    isPainting = false;
    lastPaintUV = null;
  });

  // Use capture phase so our handler fires before OrbitControls' bubble listener.
  // Shift+Scroll = brush size  |  Alt+Scroll = strength  |  plain scroll = zoom (OrbitControls)
  renderer.domElement.addEventListener("wheel", e => {
    if (playMode.active || editorMode !== "sculpt") return;
    if (!e.shiftKey && !e.altKey) return; // let OrbitControls handle plain scroll
    e.preventDefault();
    e.stopImmediatePropagation();
    const factor = e.deltaY > 0 ? 0.9 : 1.11;
    if (e.shiftKey) {
      sculpt.uRadius.value = Math.max(0.01, Math.min(0.4, sculpt.uRadius.value * factor));
      slSize.value = Math.round(sculpt.uRadius.value * 100);
      syncSizeUI();
    } else {
      sculpt.uStrength.value = Math.max(0.001, Math.min(0.05, sculpt.uStrength.value * factor));
      slStr.value = Math.round(sculpt.uStrength.value * 1000);
      syncStrUI();
    }
  }, { passive: false, capture: true });

  // Seed CPU heightmap mirror after boot — not during first user interaction.
  setTimeout(() => requestHeightmapReadback(), 0);

  function cancelStroke() {
    isPainting = false;
    lastPaintUV = null;
  }

  function onHistoryChange() {
    cancelStroke();
    requestHeightmapReadback();
  }

  window.addEventListener("keydown", e => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.code === "Escape" && playMode.active) {
      exitPlay();
      return;
    }
    if (e.code === "KeyV" && !e.ctrlKey && !e.metaKey && !e.altKey && !playMode.active) {
      setEditorMode("view"); return;
    }
    if (e.code === "KeyI" && !e.ctrlKey && !e.metaKey && !e.altKey && !playMode.active) {
      e.preventDefault();
      setEditorMode(editorMode === "props" ? "view" : "props");
      return;
    }
    if (e.code === "KeyP" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      if (playMode.active) exitPlay();
      else enterPlay();
      return;
    }
    if (e.code === "KeyK" && !e.ctrlKey && !e.metaKey && !e.altKey && !playMode.active) {
      e.preventDefault();
      setEditorMode(editorMode === "spline" ? "view" : "spline");
      return;
    }
    // Spline mode shortcuts (v2)
    if (editorMode === "spline" && !playMode.active) {
      if (e.code === "Delete" || e.code === "Backspace") {
        e.preventDefault();
        if (splineSys.selectedFeature) splineSys.deleteSelectedFeature();
        else splineSys.deleteSelected();
        return;
      }
    }
    // Props mode shortcuts
    if (editorMode === "props" && !playMode.active) {
      if (e.code === "Escape") {
        e.preventDefault();
        deactivatePropSelection();
        return;
      }
      if (_gizmoTarget && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.code === "KeyW") { e.preventDefault(); propState.transformMode = "translate"; tc.setMode("translate"); return; }
        if (e.code === "KeyE") { e.preventDefault(); propState.transformMode = "rotate"; tc.setMode("rotate"); return; }
        if (e.code === "KeyR") { e.preventDefault(); propState.transformMode = "scale"; tc.setMode("scale"); return; }
      }
      if (e.code === "Delete" || e.code === "Backspace") {
        e.preventDefault();
        propSys.handleDelete();
        deactivatePropSelection();
        refreshPropCount();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d") {
        e.preventDefault();
        const idx = propSys.handleDuplicate();
        if (idx != null) activatePropSelection(idx);
        refreshPropCount();
        return;
      }
    }
    if (e.ctrlKey || e.metaKey) {
      const key = e.key.toLowerCase();
      if (key === "s") {
        e.preventDefault();
        saveHeightmap();
        return;
      }
      if (key === "z" && !e.shiftKey) {
        e.preventDefault();
        if (editorMode === "paint") paintSys.undo();
        else if (editorMode === "props") propSys.undo();
        else if (sculpt.undo()) onHistoryChange();
        return;
      }
      if (key === "y" || (key === "z" && e.shiftKey)) {
        e.preventDefault();
        if (editorMode === "paint") paintSys.redo();
        else if (editorMode === "props") propSys.redo();
        else if (sculpt.redo()) onHistoryChange();
        return;
      }
    }
  });

  // Section collapse is handled by editorShell.initEditorShell() via classList.toggle("hidden").

  // ── Paint panel wiring ────────────────────────────────────────────────────

  function drawPaintMaskPreview() {
    paintBrushMask.renderPreview(pmaskPreview);
  }
  drawPaintMaskPreview();

  function refreshLayerThumb(slotIdx) {
    const thumb = document.getElementById(`lthumb-${slotIdx + 1}`);
    if (!thumb) return;
    const url = textureLib.slots[slotIdx].albedoUrl;
    if (url) {
      thumb.style.backgroundImage = `url(${url})`;
      thumb.style.backgroundColor = '';
    } else {
      const [r, g, b] = textureLib.getPreviewColor(slotIdx);
      thumb.style.backgroundImage = '';
      thumb.style.backgroundColor = `rgb(${r},${g},${b})`;
    }
  }

  // Preload default PBR texture sets from /textures/pbr_materials/
  textureLib.preloadDefaults().then(() => {
    for (let i = 0; i < 7; i++) refreshLayerThumb(i);
    syncTexlibEditor();
  }).catch(err => console.warn("Default texture preload failed:", err));

  // Brush sliders
  pslRadius.addEventListener("input", () => {
    paintState.brush.radius = Number(pslRadius.value);
    plblRadius.textContent = pslRadius.value + "m";
    if (editorMode === "paint") sculpt.uRadius.value = paintState.brush.radius / WORLD_SIZE;
  });
  pslStrength.addEventListener("input", () => {
    paintState.brush.strength = Number(pslStrength.value) / 100;
    plblStrength.textContent = paintState.brush.strength.toFixed(2);
  });
  pslFalloff.addEventListener("input", () => {
    paintState.brush.falloff = Number(pslFalloff.value) / 10;
    plblFalloff.textContent = paintState.brush.falloff.toFixed(1);
  });
  pslSpacing.addEventListener("input", () => {
    paintState.brush.spacingFactor = Number(pslSpacing.value) / 100;
    plblSpacing.textContent = pslSpacing.value + "%";
  });
  pslOpacity.addEventListener("input", () => {
    paintState.brushOpacity = Number(pslOpacity.value) / 100;
    plblOpacity.textContent = paintState.brushOpacity.toFixed(2);
  });

  // Solo & height blend
  pslSolo.addEventListener("change", () => {
    splatOverlay.uSoloLayer.value = Number(pslSolo.value);
  });
  pslHBlend.addEventListener("input", () => {
    splatOverlay.uHeightBlend.value = Number(pslHBlend.value) / 100;
    plblHBlend.textContent = splatOverlay.uHeightBlend.value.toFixed(2);
  });
  pslHContrast.addEventListener("input", () => {
    splatOverlay.uHeightContrast.value = Number(pslHContrast.value) / 100;
    plblHContrast.textContent = splatOverlay.uHeightContrast.value.toFixed(2);
  });

  // Noise mask
  pslNoise.addEventListener("input", () => {
    paintState.noiseMask = Number(pslNoise.value) / 100;
    plblNoise.textContent = paintState.noiseMask.toFixed(2);
  });
  pslNScale.addEventListener("input", () => {
    paintState.noiseScale = Number(pslNScale.value) / 10;
    plblNScale.textContent = paintState.noiseScale.toFixed(1);
  });
  pslNOct.addEventListener("input", () => {
    paintState.noiseOctaves = Number(pslNOct.value);
    plblNOct.textContent = pslNOct.value;
  });
  pckNEdge.addEventListener("change", () => { paintState.noiseEdgeOnly = pckNEdge.checked; });

  // Brush mask chips + PNG load
  pmaskChips.addEventListener("click", e => {
    const chip = e.target.closest(".option-chip[data-pmask]");
    if (!chip) return;
    const name = chip.dataset.pmask;
    if (name === "none") paintBrushMask.clear();
    else paintBrushMask.generateBuiltin(name);
    pmaskChips.querySelectorAll(".option-chip").forEach(c => c.classList.toggle("active", c === chip));
    drawPaintMaskPreview();
  });
  pbtnMaskPng.addEventListener("click", () => {
    const inp = Object.assign(document.createElement("input"), { type: "file", accept: "image/*" });
    inp.onchange = async () => {
      if (!inp.files[0]) return;
      await paintBrushMask.loadFromFile(inp.files[0]);
      pmaskChips.querySelectorAll(".option-chip").forEach(c => c.classList.remove("active"));
      drawPaintMaskPreview();
    };
    inp.click();
  });
  pslMaskRot.addEventListener("input", () => {
    paintState.maskRotation = Number(pslMaskRot.value);
    plblMaskRot.textContent = pslMaskRot.value + "°";
    sculpt.uMaskRotation.value = paintState.maskRotation * Math.PI / 180;
  });
  pckMaskRand.addEventListener("change",   () => { paintState.maskRandomRotation = pckMaskRand.checked; });
  pckMaskFollow.addEventListener("change", () => { paintState.maskFollowStroke   = pckMaskFollow.checked; });

  // Layer cards
  layerCardGrid.addEventListener("click", e => {
    const card = e.target.closest(".layer-card");
    if (!card) return;
    const layer = Number(card.dataset.layer);
    paintState.activeLayer = layer;
    layerCardGrid.querySelectorAll(".layer-card").forEach(c => c.classList.toggle("active", c === card));

    // If it's a real texture layer (1-7), jump to that slot in the Texture Library
    if (layer >= 1 && layer <= 7) {
      const slotIdx = layer - 1;
      texlibActiveSlot = slotIdx;
      texlibTabsEl.querySelectorAll(".texlib-tab").forEach((t, i) => t.classList.toggle("active", i === slotIdx));
      texlibNameEl.value = textureLib.slots[slotIdx].name;
      syncTexlibEditor();
      // Expand Texture Library section if it's collapsed
      const texlibSection = document.getElementById("texlib-body");
      if (texlibSection && texlibSection.classList.contains("hidden")) {
        texlibSection.classList.remove("hidden");
        const hdr = texlibSection.previousElementSibling;
        if (hdr) hdr.classList.remove("collapsed");
      }
      texlibSection?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  });
  layerCardGrid.addEventListener("dragover", e => { e.preventDefault(); });
  layerCardGrid.addEventListener("drop", e => {
    e.preventDefault();
    const card = e.target.closest(".layer-card[data-layer]");
    if (!card) return;
    const layer = Number(card.dataset.layer);
    if (layer < 1 || layer > 7) return;
    const file = e.dataTransfer.files[0];
    if (!file) return;
    const slotIdx = layer - 1;
    textureLib.loadFileAutoDetect(slotIdx, file).then(() => refreshLayerThumb(slotIdx));
  });

  // Texture library slot tabs
  texlibTabsEl.addEventListener("click", e => {
    const tab = e.target.closest(".texlib-tab[data-slot]");
    if (!tab) return;
    texlibActiveSlot = Number(tab.dataset.slot);
    texlibTabsEl.querySelectorAll(".texlib-tab").forEach(t => t.classList.toggle("active", t === tab));
    texlibNameEl.value = textureLib.slots[texlibActiveSlot].name;
    syncTexlibEditor();
  });
  texlibNameEl.addEventListener("input", () => {
    textureLib.setSlotName(texlibActiveSlot, texlibNameEl.value);
    const lbl = document.getElementById(`llabel-${texlibActiveSlot + 1}`);
    if (lbl) lbl.textContent = texlibNameEl.value || `L${texlibActiveSlot + 1}`;
  });

  // Texture library UV/strength sliders — scoped to active slot
  const tslUVScale = document.getElementById("tsl-uvscale");
  const tlblUV     = document.getElementById("tlbl-uvscale");
  const tslNStr    = document.getElementById("tsl-nstr");
  const tlblNStr   = document.getElementById("tlbl-nstr");
  const tslAOStr   = document.getElementById("tsl-aostr");
  const tlblAO     = document.getElementById("tlbl-aostr");
  const tslRStr    = document.getElementById("tsl-rstr");
  const tlblRStr   = document.getElementById("tlbl-rstr");

  tslUVScale.addEventListener("input", () => {
    textureLib.setUVScale(texlibActiveSlot, Number(tslUVScale.value));
    tlblUV.textContent = tslUVScale.value;
  });
  tslNStr.addEventListener("input", () => {
    textureLib.setNormalStr(texlibActiveSlot, Number(tslNStr.value) / 10);
    tlblNStr.textContent = (tslNStr.value / 10).toFixed(1);
  });
  tslAOStr.addEventListener("input", () => {
    textureLib.setAOStr(texlibActiveSlot, Number(tslAOStr.value) / 10);
    tlblAO.textContent = (tslAOStr.value / 10).toFixed(1);
  });
  tslRStr.addEventListener("input", () => {
    textureLib.setRoughStr(texlibActiveSlot, Number(tslRStr.value) / 10);
    tlblRStr.textContent = (tslRStr.value / 10).toFixed(1);
  });

  // 4-map grid cells — click or drop to load texture
  const MAP_TYPES = ["albedo", "normal", "rough", "ao"];
  const MAP_LOADERS = {
    albedo: (i, f) => textureLib.loadAlbedo(i, f),
    normal: (i, f) => textureLib.loadNormalMap(i, f),
    rough:  (i, f) => textureLib.loadRoughness(i, f),
    ao:     (i, f) => textureLib.loadAO(i, f),
  };

  async function loadMapFile(mapType, file) {
    await MAP_LOADERS[mapType](texlibActiveSlot, file);
    const urlProp = { albedo: "albedoUrl", normal: "normalUrl", rough: "roughUrl", ao: "aoUrl" }[mapType];
    const url = textureLib.slots[texlibActiveSlot][urlProp];
    const thumb = document.getElementById(`tmt-${mapType}`);
    const cell  = document.getElementById(`tmc-${mapType}`);
    if (thumb) thumb.style.backgroundImage = url ? `url(${url})` : "";
    if (cell) cell.classList.toggle("has-texture", Boolean(url));
    if (mapType === "albedo") refreshLayerThumb(texlibActiveSlot);
  }

  MAP_TYPES.forEach(mapType => {
    const cell  = document.getElementById(`tmc-${mapType}`);
    const clear = document.getElementById(`tmc-clear-${mapType}`);
    if (!cell) return;
    cell.addEventListener("click", e => {
      if (e.target === clear) return;
      const inp = Object.assign(document.createElement("input"), { type: "file", accept: "image/*" });
      inp.onchange = () => { if (inp.files[0]) loadMapFile(mapType, inp.files[0]); };
      inp.click();
    });
    cell.addEventListener("dragover", e => { e.preventDefault(); });
    cell.addEventListener("drop", e => {
      e.preventDefault();
      const file = e.dataTransfer.files[0];
      if (file) loadMapFile(mapType, file);
    });
    if (clear) {
      clear.addEventListener("click", e => {
        e.stopPropagation();
        // Reset GPU texture data back to neutral defaults
        if (mapType === "albedo")  textureLib.clearAlbedo(texlibActiveSlot);
        else if (mapType === "normal") textureLib.clearNormal(texlibActiveSlot);
        else if (mapType === "rough")  textureLib.clearRoughness(texlibActiveSlot);
        else if (mapType === "ao")     textureLib.clearAO(texlibActiveSlot);
        // Update UI
        const thumb = document.getElementById(`tmt-${mapType}`);
        if (thumb) thumb.style.backgroundImage = "";
        cell.classList.remove("has-texture");
        if (mapType === "albedo") refreshLayerThumb(texlibActiveSlot);
      });
    }
  });

  function syncTexlibEditor() {
    const s = textureLib.slots[texlibActiveSlot];
    const u = textureLib.slotUniforms[texlibActiveSlot];
    tslUVScale.value = Math.round(u.uUVScale.value);
    tlblUV.textContent = tslUVScale.value;
    tslNStr.value = Math.round(u.uNormalStr.value * 10);
    tlblNStr.textContent = u.uNormalStr.value.toFixed(1);
    tslAOStr.value = Math.round(u.uAOStr.value * 10);
    tlblAO.textContent = u.uAOStr.value.toFixed(1);
    tslRStr.value = Math.round(u.uRoughStr.value * 10);
    tlblRStr.textContent = u.uRoughStr.value.toFixed(1);
    texlibNameEl.value = s.name;
    // Sync map cell thumbnails for the active slot
    for (const [mapType, urlProp] of [
      ["albedo", "albedoUrl"], ["normal", "normalUrl"], ["rough", "roughUrl"], ["ao", "aoUrl"],
    ]) {
      const url = s[urlProp];
      const thumb = document.getElementById(`tmt-${mapType}`);
      const cell  = document.getElementById(`tmc-${mapType}`);
      if (thumb) thumb.style.backgroundImage = url ? `url(${url})` : "";
      if (cell) cell.classList.toggle("has-texture", Boolean(url));
    }
    // Sync auto-paint controls
    tautoEnabled.checked         = s.autoEnabled;
    tautoHmin.value              = s.autoHeightMin;
    tautoHmax.value              = s.autoHeightMax;
    tautoSmin.value              = s.autoSlopeMin;
    tautoSmax.value              = s.autoSlopeMax;
    tautoBlend.value             = s.autoBlend;
    tautoStrength.value          = Math.round(s.autoStrength * 100);
    tautoLblHmin.textContent     = s.autoHeightMin + "m";
    tautoLblHmax.textContent     = s.autoHeightMax + "m";
    tautoLblSmin.textContent     = s.autoSlopeMin  + "°";
    tautoLblSmax.textContent     = s.autoSlopeMax  + "°";
    tautoLblBlend.textContent    = s.autoBlend      + "%";
    tautoLblStrength.textContent = s.autoStrength.toFixed(2);
  }
  syncTexlibEditor();

  // Fill / Clear buttons
  pbtnFill.addEventListener("click", () => { paintSys.fillWithActiveLayer(); splatMap.tex.needsUpdate = true; });
  pbtnClear.addEventListener("click", () => { paintSys.clearAll(); splatMap.tex.needsUpdate = true; });

  // Auto-paint slot controls — read/write textureLib.slots[texlibActiveSlot].auto*
  function _autoSlot() { return textureLib.slots[texlibActiveSlot]; }

  tautoEnabled.addEventListener("change", () => {
    _autoSlot().autoEnabled = tautoEnabled.checked;
  });
  tautoHmin.addEventListener("input", () => {
    const v = Number(tautoHmin.value);
    if (v >= Number(tautoHmax.value)) { tautoHmin.value = Number(tautoHmax.value) - 5; return; }
    _autoSlot().autoHeightMin = v;
    tautoLblHmin.textContent = v + "m";
  });
  tautoHmax.addEventListener("input", () => {
    const v = Number(tautoHmax.value);
    if (v <= Number(tautoHmin.value)) { tautoHmax.value = Number(tautoHmin.value) + 5; return; }
    _autoSlot().autoHeightMax = v;
    tautoLblHmax.textContent = v + "m";
  });
  tautoSmin.addEventListener("input", () => {
    const v = Number(tautoSmin.value);
    if (v >= Number(tautoSmax.value)) { tautoSmin.value = Number(tautoSmax.value) - 1; return; }
    _autoSlot().autoSlopeMin = v;
    tautoLblSmin.textContent = v + "°";
  });
  tautoSmax.addEventListener("input", () => {
    const v = Number(tautoSmax.value);
    if (v <= Number(tautoSmin.value)) { tautoSmax.value = Number(tautoSmin.value) + 1; return; }
    _autoSlot().autoSlopeMax = v;
    tautoLblSmax.textContent = v + "°";
  });
  tautoBlend.addEventListener("input", () => {
    const v = Number(tautoBlend.value);
    _autoSlot().autoBlend = v;
    tautoLblBlend.textContent = v + "%";
  });
  tautoStrength.addEventListener("input", () => {
    const v = Number(tautoStrength.value) / 100;
    _autoSlot().autoStrength = v;
    tautoLblStrength.textContent = v.toFixed(2);
  });

  // Generate auto paint
  pbtnAutoGenerate.addEventListener("click", () => {
    const rules = textureLib.slots.map(s => ({
      enabled:   s.autoEnabled,
      heightMin: s.autoHeightMin,
      heightMax: s.autoHeightMax,
      slopeMin:  s.autoSlopeMin,
      slopeMax:  s.autoSlopeMax,
      blend:     s.autoBlend,
      strength:  s.autoStrength,
    }));
    paintSys.applyAutoRules({
      cpuHeightmap,
      heightmapSize: HEIGHTMAP_SIZE,
      worldSize:     WORLD_SIZE,
      maxHeight:     MAX_HEIGHT,
      rules,
    });
    splatMap.tex.needsUpdate = true;
  });

  // Splat save / load
  function saveSplatmap() {
    const buf = encodeSplatmapFile(splatMap._combined, { resolution: SPLAT_RES });
    const ts  = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    downloadBuffer(buf, `splat-${ts}.v3splat`);
  }

  async function loadSplatmap() {
    const file = await pickSplatmapFile();
    if (!file) return;
    try {
      const decoded = decodeSplatmapFile(await file.arrayBuffer());
      if (decoded.resolution !== SPLAT_RES) {
        window.alert(
          `This splatmap is ${decoded.resolution}²; expected ${SPLAT_RES}².`,
        );
        return;
      }
      splatMap._combined.set(decoded.data);
      splatMap.tex.needsUpdate = true;
    } catch (err) {
      console.error(err);
      window.alert(err instanceof Error ? err.message : "Failed to load splatmap.");
    }
  }

  pbtnSaveSplat.addEventListener("click", () => saveSplatmap());
  pbtnLoadSplat.addEventListener("click", () => loadSplatmap());

  // ── Grass panel wiring ─────────────────────────────────────────────────────

  // Density brush
  const gslRadius   = document.getElementById("gsl-radius");
  const glblRadius  = document.getElementById("glbl-radius");
  const gslStr      = document.getElementById("gsl-strength");
  const glblStr     = document.getElementById("glbl-strength");
  const gslFalloff  = document.getElementById("gsl-falloff");
  const glblFalloff = document.getElementById("glbl-falloff");
  const gckErase    = document.getElementById("gck-erase");
  const gbtnFill    = document.getElementById("gbtn-fill");
  const gbtnClear   = document.getElementById("gbtn-clear");

  gslRadius.addEventListener("input", () => { grassBrush.radius = Number(gslRadius.value); glblRadius.textContent = gslRadius.value + "m"; });
  gslStr.addEventListener("input", () => { grassBrush.strength = Number(gslStr.value) / 100; glblStr.textContent = grassBrush.strength.toFixed(2); });
  gslFalloff.addEventListener("input", () => { grassBrush.falloff = Number(gslFalloff.value) / 10; glblFalloff.textContent = grassBrush.falloff.toFixed(1); });
  gckErase.addEventListener("change", () => { grassBrush.erase = gckErase.checked; });
  gbtnFill.addEventListener("click", () => grassTerrainData.fillDensity());
  gbtnClear.addEventListener("click", () => { if (confirm("Clear all grass density?")) grassTerrainData.clearDensity(); });

  // Appearance
  const gcolBlade   = document.getElementById("gcol-blade");
  const gcolTip     = document.getElementById("gcol-tip");
  const gslAoBase   = document.getElementById("gsl-ao-base");
  const glblAoBase  = document.getElementById("glbl-ao-base");
  const gslAoPow    = document.getElementById("gsl-ao-power");
  const glblAoPow   = document.getElementById("glbl-ao-power");
  const gckColorVar = document.getElementById("gck-color-var");
  const gslHue      = document.getElementById("gsl-hue");
  const glblHue     = document.getElementById("glbl-hue");
  const gslSat      = document.getElementById("gsl-sat");
  const glblSat     = document.getElementById("glbl-sat");
  const gslDry      = document.getElementById("gsl-dry");
  const glblDry     = document.getElementById("glbl-dry");
  const gcolDry     = document.getElementById("gcol-dry");
  const gslBladeH   = document.getElementById("gsl-blade-height");
  const glblBladeH  = document.getElementById("glbl-blade-height");

  gslBladeH.addEventListener("input", () => {
    grassState.bladeHeight = Number(gslBladeH.value) / 10;
    glblBladeH.textContent = grassState.bladeHeight.toFixed(1) + "m";
    syncGrassUniforms();
  });
  gcolBlade.addEventListener("input", () => { grassState.bladeColor = gcolBlade.value; syncGrassUniforms(); });
  gcolTip.addEventListener("input",   () => { grassState.tipColor   = gcolTip.value;   syncGrassUniforms(); });
  gslAoBase.addEventListener("input", () => { grassState.aoBase = Number(gslAoBase.value) / 100; glblAoBase.textContent = grassState.aoBase.toFixed(2); syncGrassUniforms(); });
  gslAoPow.addEventListener("input",  () => { grassState.aoPower = Number(gslAoPow.value) / 10; glblAoPow.textContent = grassState.aoPower.toFixed(1); syncGrassUniforms(); });
  gckColorVar.addEventListener("change", () => { grassState.colorVariation = gckColorVar.checked; syncGrassUniforms(); });
  gslHue.addEventListener("input", () => { grassState.cvHueSpread = Number(gslHue.value) / 100; glblHue.textContent = grassState.cvHueSpread.toFixed(2); syncGrassUniforms(); });
  gslSat.addEventListener("input", () => { grassState.cvSatSpread = Number(gslSat.value) / 100; glblSat.textContent = grassState.cvSatSpread.toFixed(2); syncGrassUniforms(); });
  gslDry.addEventListener("input", () => { grassState.cvDryAmount = Number(gslDry.value) / 100; glblDry.textContent = grassState.cvDryAmount.toFixed(2); syncGrassUniforms(); });
  gcolDry.addEventListener("input", () => { grassState.cvDryColor = gcolDry.value; syncGrassUniforms(); });

  // Shape & Dynamics
  const gslBladeW  = document.getElementById("gsl-blade-width");
  const glblBladeW = document.getElementById("glbl-blade-width");
  const gckCrossed = document.getElementById("gck-crossed");
  const gslBend    = document.getElementById("gsl-bend");
  const glblBend   = document.getElementById("glbl-bend");
  const gslStiff   = document.getElementById("gsl-stiffness");
  const glblStiff  = document.getElementById("glbl-stiffness");
  const gslMaxAng  = document.getElementById("gsl-max-angle");
  const glblMaxAng = document.getElementById("glbl-max-angle");
  const gslLean    = document.getElementById("gsl-lean");
  const glblLean   = document.getElementById("glbl-lean");
  const gslSky     = document.getElementById("gsl-sky");
  const glblSky    = document.getElementById("glbl-sky");
  const gslCyl     = document.getElementById("gsl-cyl");
  const glblCyl    = document.getElementById("glbl-cyl");
  const gslThick   = document.getElementById("gsl-thick");
  const glblThick  = document.getElementById("glbl-thick");
  const gslDens    = document.getElementById("gsl-density");
  const glblDens   = document.getElementById("glbl-density");
  const gckShadow  = document.getElementById("gck-shadow");

  gslBladeW.addEventListener("input", () => {
    grassState.bladeWidth = Number(gslBladeW.value) / 100;
    glblBladeW.textContent = grassState.bladeWidth.toFixed(2) + "m";
    if (grassRings) rebuildHybridGrassGeometries(grassRings, grassState);
  });
  gckCrossed.addEventListener("change", () => {
    grassState.crossed = gckCrossed.checked;
    if (grassRings) rebuildHybridGrassGeometries(grassRings, grassState);
  });
  gslBend.addEventListener("input",   () => { grassState.bendFocus = Number(gslBend.value) / 10; glblBend.textContent = grassState.bendFocus.toFixed(1); syncGrassUniforms(); });
  gslStiff.addEventListener("input",  () => { grassState.stiffness = Number(gslStiff.value) / 100; glblStiff.textContent = grassState.stiffness.toFixed(2); syncGrassUniforms(); });
  gslMaxAng.addEventListener("input", () => { grassState.maxAngle = Number(gslMaxAng.value) / 100; glblMaxAng.textContent = grassState.maxAngle.toFixed(2); syncGrassUniforms(); });
  gslLean.addEventListener("input",   () => { grassState.naturalLean = Number(gslLean.value) / 100; glblLean.textContent = grassState.naturalLean.toFixed(2); syncGrassUniforms(); });
  gslSky.addEventListener("input",    () => { grassState.skyBlend = Number(gslSky.value) / 100; glblSky.textContent = grassState.skyBlend.toFixed(2); syncGrassUniforms(); });
  gslCyl.addEventListener("input",    () => { grassState.cylindrical = Number(gslCyl.value) / 100; glblCyl.textContent = grassState.cylindrical.toFixed(2); syncGrassUniforms(); });
  gslThick.addEventListener("input",  () => { grassState.viewThicken = Number(gslThick.value) / 100; glblThick.textContent = grassState.viewThicken.toFixed(2); syncGrassUniforms(); });
  gslDens.addEventListener("input",   () => { grassState.grassDensity = Number(gslDens.value) / 100; glblDens.textContent = grassState.grassDensity.toFixed(2); syncGrassUniforms(); });
  gckShadow.addEventListener("change", () => { grassState.receiveShadow = gckShadow.checked; syncGrassUniforms(); });

  // Wind
  const gslWindSpeed = document.getElementById("gsl-wind-speed");
  const glblWindSpeed= document.getElementById("glbl-wind-speed");
  const gslWindStr   = document.getElementById("gsl-wind-str");
  const glblWindStr  = document.getElementById("glbl-wind-str");
  const gslWindAngle = document.getElementById("gsl-wind-angle");
  const glblWindAngle= document.getElementById("glbl-wind-angle");
  const gslWindGust  = document.getElementById("gsl-wind-gust");
  const glblWindGust = document.getElementById("glbl-wind-gust");
  const gslWindWave  = document.getElementById("gsl-wind-wave");
  const glblWindWave = document.getElementById("glbl-wind-wave");

  gslWindSpeed.addEventListener("input", () => { grassState.windSpeed = Number(gslWindSpeed.value) / 100; glblWindSpeed.textContent = grassState.windSpeed.toFixed(2); syncGrassUniforms(); });
  gslWindStr.addEventListener("input",   () => { grassState.windStrength = Number(gslWindStr.value) / 100; glblWindStr.textContent = grassState.windStrength.toFixed(2); syncGrassUniforms(); });
  gslWindAngle.addEventListener("input", () => { grassState.windAngle = Number(gslWindAngle.value); glblWindAngle.textContent = grassState.windAngle + "°"; syncGrassUniforms(); });
  gslWindGust.addEventListener("input",  () => { grassState.windGust = Number(gslWindGust.value) / 100; glblWindGust.textContent = grassState.windGust.toFixed(2); syncGrassUniforms(); });
  gslWindWave.addEventListener("input",  () => { grassState.windWaveScale = Number(gslWindWave.value) / 100; glblWindWave.textContent = grassState.windWaveScale.toFixed(2); syncGrassUniforms(); });

  // SSS
  const gcolBss    = document.getElementById("gcol-bss");
  const gslBssInt  = document.getElementById("gsl-bss-int");
  const glblBssInt = document.getElementById("glbl-bss-int");
  const gslBssPow  = document.getElementById("gsl-bss-pow");
  const glblBssPow = document.getElementById("glbl-bss-pow");
  const gslFront   = document.getElementById("gsl-front-scat");
  const glblFront  = document.getElementById("glbl-front-scat");
  const gslRim     = document.getElementById("gsl-rim");
  const glblRim    = document.getElementById("glbl-rim");

  gcolBss.addEventListener("input",   () => { grassState.bssColor = gcolBss.value; syncGrassUniforms(); });
  gslBssInt.addEventListener("input", () => { grassState.bssIntensity = Number(gslBssInt.value) / 100; glblBssInt.textContent = grassState.bssIntensity.toFixed(2); syncGrassUniforms(); });
  gslBssPow.addEventListener("input", () => { grassState.bssPower = Number(gslBssPow.value) / 10; glblBssPow.textContent = grassState.bssPower.toFixed(1); syncGrassUniforms(); });
  gslFront.addEventListener("input",  () => { grassState.frontScatter = Number(gslFront.value) / 100; glblFront.textContent = grassState.frontScatter.toFixed(2); syncGrassUniforms(); });
  gslRim.addEventListener("input",    () => { grassState.rimSSS = Number(gslRim.value) / 100; glblRim.textContent = grassState.rimSSS.toFixed(2); syncGrassUniforms(); });

  // Specular
  const gckSpec1   = document.getElementById("gck-spec1");
  const gslS1Int   = document.getElementById("gsl-s1-int");
  const glblS1Int  = document.getElementById("glbl-s1-int");
  const gcolS1     = document.getElementById("gcol-s1");
  const gslS1Pow   = document.getElementById("gsl-s1-pow");
  const glblS1Pow  = document.getElementById("glbl-s1-pow");
  const gckSpec2   = document.getElementById("gck-spec2");
  const gslS2Int   = document.getElementById("gsl-s2-int");
  const glblS2Int  = document.getElementById("glbl-s2-int");
  const gcolS2     = document.getElementById("gcol-s2");
  const gslS2Nscale= document.getElementById("gsl-s2-nscale");
  const glblS2Nscale=document.getElementById("glbl-s2-nscale");
  const gslS2Nstr  = document.getElementById("gsl-s2-nstr");
  const glblS2Nstr = document.getElementById("glbl-s2-nstr");
  const gslS2Pow   = document.getElementById("gsl-s2-pow");
  const glblS2Pow  = document.getElementById("glbl-s2-pow");

  gckSpec1.addEventListener("change",   () => { grassState.specV1Enabled = gckSpec1.checked; syncGrassUniforms(); });
  gslS1Int.addEventListener("input",    () => { grassState.specV1Intensity = Number(gslS1Int.value) / 100; glblS1Int.textContent = grassState.specV1Intensity.toFixed(2); syncGrassUniforms(); });
  gcolS1.addEventListener("input",      () => { grassState.specV1Color = gcolS1.value; syncGrassUniforms(); });
  gslS1Pow.addEventListener("input",    () => { grassState.specV1Power = Number(gslS1Pow.value) / 10; glblS1Pow.textContent = grassState.specV1Power.toFixed(1); syncGrassUniforms(); });
  gckSpec2.addEventListener("change",   () => { grassState.specV2Enabled = gckSpec2.checked; syncGrassUniforms(); });
  gslS2Int.addEventListener("input",    () => { grassState.specV2Intensity = Number(gslS2Int.value) / 100; glblS2Int.textContent = grassState.specV2Intensity.toFixed(2); syncGrassUniforms(); });
  gcolS2.addEventListener("input",      () => { grassState.specV2Color = gcolS2.value; syncGrassUniforms(); });
  gslS2Nscale.addEventListener("input", () => { grassState.specV2NoiseScale = Number(gslS2Nscale.value) / 10; glblS2Nscale.textContent = grassState.specV2NoiseScale.toFixed(1); syncGrassUniforms(); });
  gslS2Nstr.addEventListener("input",   () => { grassState.specV2NoiseStr = Number(gslS2Nstr.value) / 100; glblS2Nstr.textContent = grassState.specV2NoiseStr.toFixed(2); syncGrassUniforms(); });
  gslS2Pow.addEventListener("input",    () => { grassState.specV2Power = Number(gslS2Pow.value); glblS2Pow.textContent = gslS2Pow.value; syncGrassUniforms(); });

  // Terrain / slope
  const gckSlope    = document.getElementById("gck-slope");
  const gslSlopeMin = document.getElementById("gsl-slope-min");
  const glblSlopeMin= document.getElementById("glbl-slope-min");
  const gslSlopeMax = document.getElementById("gsl-slope-max");
  const glblSlopeMax= document.getElementById("glbl-slope-max");

  gckSlope.addEventListener("change",    () => { grassState.slopeEnabled = gckSlope.checked; syncGrassUniforms(); });
  gslSlopeMin.addEventListener("input",  () => { grassState.slopeMin = Number(gslSlopeMin.value) / 100; glblSlopeMin.textContent = grassState.slopeMin.toFixed(2); syncGrassUniforms(); });
  gslSlopeMax.addEventListener("input",  () => { grassState.slopeMax = Number(gslSlopeMax.value) / 100; glblSlopeMax.textContent = grassState.slopeMax.toFixed(2); syncGrassUniforms(); });

  // LOD
  const gslLodMid  = document.getElementById("gsl-lod-mid");
  const glblLodMid = document.getElementById("glbl-lod-mid");
  const gslLodFar  = document.getElementById("gsl-lod-far");
  const glblLodFar = document.getElementById("glbl-lod-far");
  const gslLodMax  = document.getElementById("gsl-lod-max");
  const glblLodMax = document.getElementById("glbl-lod-max");
  const gslLodMega = document.getElementById("gsl-lod-mega");
  const glblLodMega= document.getElementById("glbl-lod-mega");
  const gckLodDebug= document.getElementById("gck-lod-debug");

  gslLodMid.addEventListener("input",  () => { grassState.lodMidDistance = Number(gslLodMid.value); glblLodMid.textContent = gslLodMid.value + "m"; if (grassRings) syncHybridGrassLod(grassRings, grassState); });
  gslLodFar.addEventListener("input",  () => { grassState.lodFarDistance = Number(gslLodFar.value); glblLodFar.textContent = gslLodFar.value + "m"; if (grassRings) syncHybridGrassLod(grassRings, grassState); });
  gslLodMax.addEventListener("input",  () => { grassState.lodMaxDistance = Number(gslLodMax.value); glblLodMax.textContent = gslLodMax.value + "m"; if (grassRings) syncHybridGrassLod(grassRings, grassState); });
  gslLodMega.addEventListener("input", () => { grassState.lodMegaMaxDistance = Number(gslLodMega.value); glblLodMega.textContent = gslLodMega.value + "m"; if (grassRings) syncHybridGrassLod(grassRings, grassState); });
  gckLodDebug.addEventListener("change", () => { grassState.lodDebug = gckLodDebug.checked; syncGrassUniforms(); });

  // Interaction
  const gslIntRad  = document.getElementById("gsl-int-rad");
  const glblIntRad = document.getElementById("glbl-int-rad");
  const gslIntStr  = document.getElementById("gsl-int-str");
  const glblIntStr = document.getElementById("glbl-int-str");
  const gselIntMode= document.getElementById("gsel-int-mode");

  gslIntRad.addEventListener("input",  () => { grassState.interactionRadius = Number(gslIntRad.value) / 10; glblIntRad.textContent = grassState.interactionRadius.toFixed(1) + "m"; syncGrassUniforms(); });
  gslIntStr.addEventListener("input",  () => { grassState.interactionStrength = Number(gslIntStr.value) / 100; glblIntStr.textContent = grassState.interactionStrength.toFixed(2); syncGrassUniforms(); });
  gselIntMode.addEventListener("change", () => { grassState.interactionMode = Number(gselIntMode.value); syncGrassUniforms(); });

  // ── Props system ───────────────────────────────────────────────────────────
  const propStore = new PropStore();
  const propTextureLibrary = createPropTextureLibrary();
  propInstancer = new PropInstancer(scene, propStore);
  const gltfLoader = new GLTFLoader();

  // World-space hit on terrain surface for prop placement
  const _propHitVec = new THREE.Vector3();
  function getTerrainHitWorld(event) {
    if (!event) return null;
    refreshMouse(event);
    const uv = getUV();
    if (!uv) return null;
    const wx = uv.u * WORLD_SIZE - WORLD_SIZE / 2;
    const wz = uv.v * WORLD_SIZE - WORLD_SIZE / 2;
    return _propHitVec.set(wx, sampleTerrainHeight(uv.u, uv.v), wz);
  }

  // Live prop manager — handles animated THREE.Group props
  livePropManager = new LivePropManager(scene, propStore);
  livePropManager.registerFactory("flag",  createFlag);
  livePropManager.registerFactory("coin",  createCoin);
  livePropManager.registerFactory("heart", createHeart);
  livePropManager.registerFactory("key",   createKey);

  registerProceduralObjectFactories(livePropManager);

  const propState = {
    activeSlot: 0,
    sinkOffset: 0,
    transformMode: "translate",
    placementMode: "place",
    density: 0.5,
    minSpacing: 3,
    scaleMin: 0.8,
    scaleMax: 1.2,
    randomRotation: true,
  };
  const propSlots = [];
  splineToolState.props = propState;
  splineToolState.propSlots = propSlots;
  const propBrush = { radius: 12, spacingFactor: 0.22 };
  propLod = { lod0Distance: 60, lod1Distance: 150, fadeOutDistance: 500, castShadow: true };

  const propSys = new PropSystem({
    propState,
    propSlots,
    propBrush,
    propStore,
    propInstancer,
    getWorldHeight: (wx, wz) => {
      const u = (wx + WORLD_SIZE / 2) / WORLD_SIZE;
      const v = (wz + WORLD_SIZE / 2) / WORLD_SIZE;
      return sampleTerrainHeight(u, v);
    },
    worldSize: WORLD_SIZE,
  });

  function _rebuildPrimitiveMaterial(slotIdx) {
    const slot = propSlots[slotIdx];
    if (!slot?.builtin) return false;
    const propMat = propTextureLibrary.getById(slot.materialId);
    if (!propMat) return false;
    const newMat = createMaterialForLibrary(propMat, { triplanar: !!slot.triplanar });
    propInstancer.setTypeMaterial(slot.typeIdx, newMat);
    const type = propStore.types[slot.typeIdx];
    if (type) for (const e of type.entries) e.material = newMat;
    return true;
  }

  function setPrimitiveMaterial(slotIdx, materialId) {
    const slot = propSlots[slotIdx];
    if (!slot?.builtin) return;
    slot.materialId = materialId;
    _rebuildPrimitiveMaterial(slotIdx);
  }

  function setPrimitiveTriplanar(slotIdx, enabled) {
    const slot = propSlots[slotIdx];
    if (!slot?.builtin || !slot.materialId) return;
    slot.triplanar = !!enabled;
    _rebuildPrimitiveMaterial(slotIdx);
  }

  const propPlacementPreview = new PropPlacementPreview(scene, propStore, buildProceduralPreviewGroup);

  let _lastMouseEvent = null;
  let _propPainting = false;

  function _detachGizmo() {
    tc.detach();
    tc.enabled = false;
    tc.visible = false;
    _gizmoTarget = null;
    syncEditorOrbitEnabled();
  }

  function getWorldHeight(wx, wz) {
    const u = (wx + WORLD_SIZE / 2) / WORLD_SIZE;
    const v = (wz + WORLD_SIZE / 2) / WORLD_SIZE;
    return sampleTerrainHeight(u, v);
  }

  const splineTerrainStoreStub = {
    getWorldHeight,
    ensureChunkData() { return null; },
  };
  const splineChunkStreamStub = { markDirtyRects() {} };
  const splineTreeStoreStub = {
    addTree() {},
    hasTreeNearby: () => false,
    syncAllHeights: () => {},
  };

  splineSys = new SplineSystem({
    scene,
    toolState: splineToolState,
    config: { world: { size: WORLD_SIZE } },
    terrainStore: splineTerrainStoreStub,
    chunkStream: splineChunkStreamStub,
    treeStore: splineTreeStoreStub,
    propStore,
    getWorldHeight,
    getRoadSegments: () => [],
    onVolumesChange: () => worldEnv?.rebuildInteriorVolumes(),
  });
  worldEnv?.rebuildInteriorVolumes();

  _onLeaveSplineMode = () => {
    splineSys.dragging = false;
    splineSys.clearPreview();
    syncEditorOrbitEnabled();
  };

  const _propPickRay = new THREE.Raycaster();
  const _propPickNdc = new THREE.Vector2();
  let _onPropSelectionChanged = null;

  function refreshPropCount() {
    const el = document.getElementById("prop-total-count");
    if (el) el.textContent = propStore.totalCount;
  }

  function activatePropSelection(instIdx) {
    propInstancer.select(instIdx);
    tc.attach(propInstancer.proxyObject);
    tc.setMode(propState.transformMode);
    tc.enabled = true;
    tc.visible = true;
    _gizmoTarget = "prop";
    propSys.recordStampFromInstance(instIdx);
    _onPropSelectionChanged?.(instIdx);
    propPlacementPreview.hide();
  }

  function deactivatePropSelection() {
    propInstancer.clearSelection();
    if (_gizmoTarget === "prop") _detachGizmo();
    _onPropSelectionChanged?.(null);
    refreshPropPlacementPreview();
    syncEditorOrbitEnabled();
  }

  _onLeavePropsMode = () => {
    deactivatePropSelection();
    propPlacementPreview.hide();
    syncEditorOrbitEnabled();
  };

  _onGizmoDragEnd = () => {
    if (_gizmoTarget === "prop") propSys.handleTransformEnd();
  };

  let _propPreviewHitValid = false;
  const _propPreviewHit = { point: new THREE.Vector3() };

  function updatePropPlacementPreview(hit) {
    if (
      editorMode !== "props" ||
      propState.placementMode !== "place" ||
      playMode.active ||
      tc.dragging
    ) {
      _propPreviewHitValid = false;
      propPlacementPreview.hide();
      return;
    }
    // While a prop is selected (gizmo active), edit — don't show the next-placement ghost.
    // Hold Shift to preview/place another copy (rapid placement).
    const shiftPlace = !!_lastMouseEvent?.shiftKey;
    if (propInstancer.hasSelection && !shiftPlace) {
      _propPreviewHitValid = false;
      propPlacementPreview.hide();
      return;
    }
    if (!hit?.point) {
      _propPreviewHitValid = false;
      propPlacementPreview.hide();
      return;
    }
    _propPreviewHitValid = true;
    _propPreviewHit.point.copy(hit.point);

    const slot = propSlots[propState.activeSlot];
    if (!slot || slot.typeIdx == null) {
      propPlacementPreview.hide();
      return;
    }
    propPlacementPreview.showAt(
      hit,
      slot.typeIdx,
      propSys.stampForType(slot.typeIdx),
      propState.sinkOffset || 0,
    );
  }

  function refreshPropPlacementPreview() {
    if (_propPreviewHitValid) updatePropPlacementPreview(_propPreviewHit);
  }

  function syncPropBrushRing(event) {
    if (editorMode !== "props" || playMode.active || propState.placementMode !== "paint") {
      return;
    }
    refreshMouse(event);
    const uv = getUV();
    if (uv) {
      uCursorUV.value.set(uv.u, uv.v);
      sculpt.uRadius.value = propBrush.radius / WORLD_SIZE;
    } else {
      uCursorUV.value.set(-2, -2);
    }
  }

  async function loadGltfAsType(file) {
    const url = URL.createObjectURL(file);
    const name = file.name.replace(/\.[^.]+$/, "");
    return new Promise((resolve, reject) => {
      gltfLoader.load(url, (gltf) => {
        URL.revokeObjectURL(url);
        const typeIdx = propStore.registerType(gltf.scene, name);
        if (typeIdx < 0) { reject(new Error("No meshes in GLTF")); return; }
        propInstancer.onTypeRegistered(typeIdx);
        const slotIdx = propSlots.length;
        propSlots.push({ name, loaded: true, typeIdx, builtin: false, live: false });
        propState.activeSlot = slotIdx;
        document.getElementById("props-panel")?._rebuildPropUi?.();
        resolve(typeIdx);
      }, undefined, (err) => { URL.revokeObjectURL(url); reject(err); });
    });
  }

  function addPrimitive(primitiveName) {
    const existing = propSlots.find((s) => s.name === primitiveName && s.builtin);
    if (existing) {
      propState.activeSlot = propSlots.indexOf(existing);
      document.getElementById("props-panel")?._rebuildPropUi?.();
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
      propTextureLibrary.getById("__none__") ?? propTextureLibrary.getByIndex(0);
    const material = createMaterialForLibrary(defaultPropMat, { triplanar: false });
    const typeIdx = propStore.registerPrimitive(primitiveName, geometry, material);
    if (typeIdx < 0) return;
    propInstancer.onTypeRegistered(typeIdx);
    const slotIdx = propSlots.length;
    propSlots.push({
      name: primitiveName,
      loaded: true,
      typeIdx,
      builtin: true,
      materialId: defaultPropMat?.id ?? "__none__",
      triplanar: false,
    });
    propState.activeSlot = slotIdx;
    document.getElementById("props-panel")?._rebuildPropUi?.();
  }

  function addLiveProp(livePropName) {
    const defs = {
      Flag:  { factoryId: "flag",  defaults: FLAG_DEFAULTS },
      Coin:  { factoryId: "coin",  defaults: COIN_DEFAULTS },
      Heart: { factoryId: "heart", defaults: HEART_DEFAULTS },
      Key:   { factoryId: "key",   defaults: KEY_DEFAULTS },
      ...PROCEDURAL_PROP_DEFS,
    };
    const def = defs[livePropName];
    if (!def) return;
    const existing = propSlots.find((s) => s.name === livePropName && s.live);
    if (existing) {
      propState.activeSlot = propSlots.indexOf(existing);
      document.getElementById("props-panel")?._rebuildPropUi?.();
      return;
    }
    const typeIdx = propStore.registerLiveType(livePropName, def.factoryId, def.defaults);
    propInstancer.onTypeRegistered(typeIdx);
    const slotIdx = propSlots.length;
    propSlots.push({ name: livePropName, loaded: true, typeIdx, live: true, factoryId: def.factoryId });
    propState.activeSlot = slotIdx;
    document.getElementById("props-panel")?._rebuildPropUi?.();
  }

  function removePropSlot(slotIdx) {
    const slot = propSlots[slotIdx];
    if (!slot) return;
    propInstancer.onTypeRemoved(slot.typeIdx);
    propStore.removeType(slot.typeIdx);
    propSlots.splice(slotIdx, 1);
    for (const s of propSlots) {
      if (s.typeIdx > slot.typeIdx) s.typeIdx--;
    }
    if (propState.activeSlot >= propSlots.length) {
      propState.activeSlot = Math.max(0, propSlots.length - 1);
    }
    deactivatePropSelection();
    document.getElementById("props-panel")?._rebuildPropUi?.();
    refreshPropCount();
  }

  async function importPropGlb(preselectedFile = null) {
    const inp = Object.assign(document.createElement("input"), { type: "file", accept: ".glb,.gltf", multiple: true });
    if (preselectedFile) {
      try { await loadGltfAsType(preselectedFile); } catch (err) { console.error("[V3] GLB load failed:", err); }
      return;
    }
    inp.onchange = async () => {
      for (const file of inp.files ?? []) {
        try { await loadGltfAsType(file); } catch (err) { console.error("[V3] GLB load failed:", err); }
      }
    };
    inp.click();
  }

  async function importPropLod(slotIdx, lod, preselectedFile = null) {
    const slot = propSlots[slotIdx];
    if (!slot) return;
    const loadFile = (file) => new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      gltfLoader.load(url, (gltf) => {
        URL.revokeObjectURL(url);
        propStore.registerTypeLod(slot.typeIdx, lod, gltf.scene);
        propInstancer.onTypeLodRegistered(slot.typeIdx, lod);
        resolve();
      }, undefined, (err) => { URL.revokeObjectURL(url); reject(err); });
    });
    if (preselectedFile) return loadFile(preselectedFile);
    const inp = Object.assign(document.createElement("input"), { type: "file", accept: ".glb,.gltf" });
    inp.onchange = () => { if (inp.files?.[0]) loadFile(inp.files[0]).catch(console.error); };
    inp.click();
  }

  buildPropsPanel({
    toolState: { props: propState, propSlots, propLod },
    propTextureLibrary,
    propStore,
    livePropManager,
    importPropGlb,
    addPrimitive,
    addLiveProp,
    removePropSlot,
    importPropLod,
    importGlbCollectible: async () => {
      console.warn("[V3] GLB collectibles not ported yet — use Flag/Coin/Heart/Key live props.");
    },
    setPrimitiveMaterial,
    setPrimitiveTriplanar,
    rebakeBvh: () => {
      console.warn("[V3] Player BVH rebake not wired yet.");
    },
    deleteSelectedProp: () => {
      propSys.handleDelete();
      deactivatePropSelection();
    },
    duplicateSelectedProp: () => {
      const idx = propSys.handleDuplicate();
      if (idx != null) activatePropSelection(idx);
    },
    clearAllProps: () => {
      if (!confirm("Clear all props?")) return;
      propSys.clearAll();
      deactivatePropSelection();
    },
    propTransformModeChanged: () => { if (_gizmoTarget === "prop") tc.setMode(propState.transformMode); },
    propCastShadowChanged: () => propInstancer.setCastShadow(propLod.castShadow),
    getProceduralPropLabels: () => PROCEDURAL_PROP_LABELS,
    getProceduralSchema: (factoryId) => proceduralSchemaFor(factoryId),
    bakeProceduralThumbnails: (size) => withRendererSideWork(() => defaultBakeProceduralThumbnails(renderer, size)),
    set onPropSelectionChanged(fn) { _onPropSelectionChanged = fn; },
    get onPropSelectionChanged() { return _onPropSelectionChanged; },
  });

  buildSplinePanel({
    toolState: splineToolState,
    splineSystem: splineSys,
    getProceduralObjectOptions: () => PROCEDURAL_OBJECT_OPTIONS,
    rebuildInteriorVolumes: () => worldEnv?.rebuildInteriorVolumes(),
    splineChanged: () => {
      splineSys._rebuildVisual();
      if (editorMode === "spline") {
        splineSys.handleGroup.visible = !!splineState.showHandles;
      }
    },
    splineDeleteSelected: () => splineSys.deleteSelected(),
    splineClearAll: () => splineSys.clearAll(),
    splineSelectedYChanged: () => splineSys.setSelectedPointY(splineState.selectedPointY),
    splineClosedChanged: () => splineSys.setClosed(splineState.closed),
    splinePreview: () => splineSys.preview(),
    splineBake: () => {
      const { placed } = splineSys.bakePlacement();
      if (placed > 0) refreshPropCount();
    },
    splineClearPreview: () => splineSys.clearPreview(),
    splineApplyPlateau: () => {
      const changed = splineSys.applyPlateau();
      if (!changed) {
        console.warn("[V3] Plateau requires v2 terrainStore — not yet wired in v3.");
        return;
      }
      requestHeightmapReadback();
      splineSys.syncGuardrailsToGround();
      splineSys.syncKerbsToGround();
      splineSys.syncLinearFeaturesToGround();
    },
    splineClearTunnels: () => splineSys.clearTunnels(),
    splineClearLinearFeatures: () => splineSys.clearLinearFeatures(),
    splineKerbSelect: () => splineSys.selectActiveKerb(),
    splineKerbApply: () => splineSys.syncActiveKerbFromToolState(),
    splineKerbDelete: () => splineSys.deleteActiveKerb(),
    splineKerbDuplicate: () => splineSys.duplicateActiveKerb(),
    splineKerbSuggestFromCurvature: () => splineSys.suggestKerbFromRoadCurvature(),
    splineKerbLiveChanged: (changedKey) => {
      if (changedKey === "activeKerbIndex") {
        splineSys.selectActiveKerb();
        return;
      }
      if (!splineState.kerbAutoApplyActive) return;
      splineSys.syncActiveKerbFromToolState();
    },
  });

  applySplineModeEffects();

  // Sync prop instance while gizmo is dragging.
  tc.addEventListener("change", () => {
    if (_gizmoTarget === "prop" && propInstancer.hasSelection) {
      propSys.handleTransformChange();
    }
  });

  // ── Props mode mouse events (v2: place click / paint brush / right-click select) ──
  renderer.domElement.addEventListener("mousemove", e => {
    if (playMode.active || editorMode !== "props") return;
    _lastMouseEvent = e;
    const hit = getTerrainHitWorld(e);
    if (propState.placementMode === "place") {
      const worldHit = getTerrainHitWorld(e);
      updatePropPlacementPreview(worldHit ? { point: worldHit } : null);
    } else {
      propPlacementPreview.hide();
      syncPropBrushRing(e);
    }
    if (_propPainting && hit && propState.placementMode === "paint") {
      propSys.applyAt(hit, e);
      refreshPropCount();
    }
  });

  renderer.domElement.addEventListener("mousedown", e => {
    if (playMode.active || editorMode !== "props") return;
    if (e.button !== 0 || tc.dragging) return;

    if (propState.placementMode === "place") {
      const shiftPlace = e.shiftKey;
      // Selected → transform with gizmo (W/E/R). LMB on terrain does not place another.
      if (propInstancer.hasSelection && !shiftPlace) return;

      const hit = getTerrainHitWorld(e);
      if (!hit) return;
      const slot = propSlots[propState.activeSlot];
      if (!slot || slot.typeIdx == null) return;
      e.preventDefault();
      const instIdx = propSys.handlePlace(hit, slot.typeIdx);
      if (instIdx != null) activatePropSelection(instIdx);
      refreshPropCount();
      return;
    }

    if (propState.placementMode === "paint") {
      const hit = getTerrainHitWorld(e);
      if (!hit) return;
      e.preventDefault();
      _propPainting = true;
      propSys.beginStroke(hit, e);
      refreshPropCount();
    }
  }, { capture: true });

  renderer.domElement.addEventListener("mouseup", e => {
    if (editorMode !== "props") return;
    if (_propPainting) {
      _propPainting = false;
      propSys.endStroke();
      refreshPropCount();
    }
  });

  renderer.domElement.addEventListener("contextmenu", e => {
    if (editorMode !== "props" || playMode.active) return;
    e.preventDefault();
    const rect = renderer.domElement.getBoundingClientRect();
    _propPickNdc.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    _propPickRay.setFromCamera(_propPickNdc, camera);
    const hitStatic = propInstancer.raycast(_propPickRay);
    const hitLive = livePropManager.raycast(_propPickRay);
    const hit = !hitStatic && !hitLive ? null
      : !hitStatic ? hitLive
      : !hitLive ? hitStatic
      : hitLive.distance < hitStatic.distance ? hitLive : hitStatic;
    if (hit) activatePropSelection(hit.instIdx);
    else deactivatePropSelection();
  });

  renderer.domElement.addEventListener("wheel", e => {
    if (editorMode !== "props" || playMode.active || propState.placementMode !== "paint") return;
    if (!e.shiftKey) return;
    e.preventDefault();
    e.stopPropagation();
    const dir = e.deltaY < 0 ? 1 : -1;
    propBrush.radius = THREE.MathUtils.clamp(propBrush.radius + dir * 2, 5, 400);
    syncPropBrushRing(e);
  }, { passive: false, capture: true });

  // ── Spline mode mouse events (v2 pattern) ───────────────────────────────────
  renderer.domElement.addEventListener("mousemove", e => {
    if (playMode.active || editorMode !== "spline") return;
    if (splineSys.dragging && splineSys.selectedIdx >= 0) {
      const hit = getTerrainHitWorld(e);
      if (hit) splineSys.moveSelected(hit);
    }
  });

  renderer.domElement.addEventListener("mousedown", e => {
    if (playMode.active || editorMode !== "spline" || e.button !== 0) return;
    if (tc.axis) return;
    e.preventDefault();
    refreshMouse(e);
    raycaster.setFromCamera(mouse, camera);
    const picked = splineSys.pickPoint(raycaster);
    if (picked >= 0) {
      splineSys.clearFeatureSelection();
      splineSys.selectedIdx = picked;
      if (picked === 0) splineSys.extendEnd = "start";
      else if (picked === splineSys.points.length - 1) splineSys.extendEnd = "end";
      splineSys.dragging = true;
      controls.enabled = false;
      splineSys._rebuildVisual();
      splineSys._updateSelectedY();
    } else if (splineSys.selectFeature(raycaster)) {
      // placed feature selected — Delete removes it
    } else {
      const hit = getTerrainHitWorld(e);
      if (hit) {
        splineSys.clearFeatureSelection();
        splineSys.addPoint(hit);
      }
    }
  }, { capture: true });

  renderer.domElement.addEventListener("mouseup", e => {
    if (editorMode !== "spline") return;
    if (splineSys.dragging) {
      splineSys.dragging = false;
      syncEditorOrbitEnabled();
    }
  });

  // ── Paint mode mouse events ────────────────────────────────────────────────
  renderer.domElement.addEventListener("mousemove", e => {
    if (playMode.active || editorMode !== "paint") return;
    refreshMouse(e);
    const hit = getUV();
    uCursorUV.value.set(hit ? hit.u : -2, hit ? hit.v : -2);
    if (hit && isPainting) {
      const wx = hit.u * WORLD_SIZE - WORLD_SIZE / 2;
      const wz = hit.v * WORLD_SIZE - WORLD_SIZE / 2;
      paintSys.continueStroke(wx, wz, e.altKey);
      splatMap.tex.needsUpdate = true;
    }
  });

  renderer.domElement.addEventListener("mousedown", e => {
    if (playMode.active || editorMode !== "paint") return;
    if (e.button !== 0) return;
    refreshMouse(e);
    const hit = getUV();
    if (!hit) return;
    isPainting = true;
    const wx = hit.u * WORLD_SIZE - WORLD_SIZE / 2;
    const wz = hit.v * WORLD_SIZE - WORLD_SIZE / 2;
    paintSys.beginStroke(wx, wz, e.altKey);
    splatMap.tex.needsUpdate = true;
  }, { capture: true });

  renderer.domElement.addEventListener("mouseup", e => {
    if (e.button !== 0 || editorMode !== "paint") return;
    isPainting = false;
    paintSys.endStroke();
  });

  // Scroll wheel in paint mode: Shift = radius, Alt = strength
  renderer.domElement.addEventListener("wheel", e => {
    if (playMode.active || editorMode !== "paint") return;
    if (!e.shiftKey && !e.altKey) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const factor = e.deltaY > 0 ? 0.9 : 1.11;
    if (e.shiftKey) {
      paintState.brush.radius = Math.max(5, Math.min(400, paintState.brush.radius * factor));
      pslRadius.value = Math.round(paintState.brush.radius);
      plblRadius.textContent = pslRadius.value + "m";
      sculpt.uRadius.value = paintState.brush.radius / WORLD_SIZE;
    } else {
      paintState.brush.strength = Math.max(0.01, Math.min(1.0, paintState.brush.strength * factor));
      pslStrength.value = Math.round(paintState.brush.strength * 100);
      plblStrength.textContent = paintState.brush.strength.toFixed(2);
    }
  }, { passive: false, capture: true });

  // ── Grass mode mouse events ────────────────────────────────────────────────
  let _grassUndoStack = [];
  let _grassRedoStack = [];
  let _grassPainting  = false;

  function _pushGrassUndo() {
    _grassUndoStack.push(grassTerrainData.getDensitySnapshot());
    if (_grassUndoStack.length > 32) _grassUndoStack.shift();
    _grassRedoStack = [];
  }

  renderer.domElement.addEventListener("mousemove", e => {
    if (playMode.active || editorMode !== "grass") return;
    refreshMouse(e);
    const hit = getUV();
    uCursorUV.value.set(hit ? hit.u : -2, hit ? hit.v : -2);
    if (hit && _grassPainting) {
      const wx = hit.u * WORLD_SIZE - WORLD_SIZE / 2;
      const wz = hit.v * WORLD_SIZE - WORLD_SIZE / 2;
      grassTerrainData.stampDensity({
        cx: wx, cz: wz,
        radius:   grassBrush.radius,
        strength: grassBrush.strength,
        falloff:  grassBrush.falloff,
        worldSize: WORLD_SIZE,
        erase:    grassBrush.erase,
      });
    }
  });

  renderer.domElement.addEventListener("mousedown", e => {
    if (playMode.active || editorMode !== "grass") return;
    if (e.button !== 0) return;
    refreshMouse(e);
    const hit = getUV();
    if (!hit) return;
    _pushGrassUndo();
    _grassPainting = true;
    const wx = hit.u * WORLD_SIZE - WORLD_SIZE / 2;
    const wz = hit.v * WORLD_SIZE - WORLD_SIZE / 2;
    grassTerrainData.stampDensity({
      cx: wx, cz: wz,
      radius:   grassBrush.radius,
      strength: grassBrush.strength,
      falloff:  grassBrush.falloff,
      worldSize: WORLD_SIZE,
      erase:    grassBrush.erase,
    });
  }, { capture: true });

  renderer.domElement.addEventListener("mouseup", e => {
    if (e.button !== 0) return;
    _grassPainting = false;
  });

  // Scroll wheel in grass mode: Shift = radius, Alt = strength
  renderer.domElement.addEventListener("wheel", e => {
    if (playMode.active || editorMode !== "grass") return;
    if (!e.shiftKey && !e.altKey) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const factor = e.deltaY > 0 ? 0.9 : 1.11;
    if (e.shiftKey) {
      grassBrush.radius = Math.max(5, Math.min(300, grassBrush.radius * factor));
      gslRadius.value = Math.round(grassBrush.radius);
      glblRadius.textContent = Math.round(grassBrush.radius) + "m";
      sculpt.uRadius.value = grassBrush.radius / WORLD_SIZE;
    } else {
      grassBrush.strength = Math.max(0.01, Math.min(1.0, grassBrush.strength * factor));
      gslStr.value = Math.round(grassBrush.strength * 100);
      glblStr.textContent = grassBrush.strength.toFixed(2);
    }
  }, { passive: false, capture: true });

  // Grass undo/redo — patch into existing Ctrl+Z/Y handler
  window.addEventListener("keydown", e => {
    if (editorMode !== "grass") return;
    if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "z") {
      if (_grassUndoStack.length === 0) return;
      _grassRedoStack.push(grassTerrainData.getDensitySnapshot());
      grassTerrainData.restoreDensitySnapshot(_grassUndoStack.pop());
      e.stopImmediatePropagation();
    }
    if (e.ctrlKey && (e.shiftKey && e.key.toLowerCase() === "z" || e.key.toLowerCase() === "y")) {
      if (_grassRedoStack.length === 0) return;
      _grassUndoStack.push(grassTerrainData.getDensitySnapshot());
      grassTerrainData.restoreDensitySnapshot(_grassRedoStack.pop());
      e.stopImmediatePropagation();
    }
  }, { capture: true });

  // Re-sync orbit after props/spline wiring (do not reset mode — that felt like a freeze).
  syncEditorOrbitEnabled();

  if (import.meta.env?.DEV) {
    window.__V3_DEBUG = {
      get editorMode() { return editorMode; },
      get playActive() { return playMode.active; },
      controls,
      tc,
      editorCamera,
      syncEditorOrbitEnabled,
      setEditorMode,
      recoverEditorInput,
      get rendererSideWork() { return _rendererSideWork; },
    };
  }
}

main().catch((err) => {
  console.error("[V3] Editor failed to start:", err);
  const vp = document.getElementById("viewport");
  if (vp) {
    const msg = document.createElement("div");
    msg.style.cssText = "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;color:#f66;font:14px/1.4 sans-serif;text-align:center;background:#1a0a0a;z-index:9999";
    msg.textContent = `Editor failed to start: ${err?.message ?? err}`;
    vp.appendChild(msg);
  }
});
