import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import Stats from "stats-gl";
import { texture, uniform, float, mix, positionWorld, vec2, vec3, length, smoothstep, mx_noise_float } from "three/tsl";
import { createHeightmapTexture, saveTerrainConfig, legacySplatSize, TERRAIN_SIZE_LIMITS, HEIGHTMAP_SIZE, WORLD_SIZE, MAX_HEIGHT } from "../terrain/heightmapTexture.js";
import { stashPendingHeightmap, takePendingHeightmap } from "../io/pendingLoad.js";
import { createTerrainLOD, LOD_LEVELS, BASE_STEP, GRID_N, GRID_OFFSET } from "../terrain/terrainLOD.js";
import { GRID_DEFAULTS, applyGridConfig, createGridMaterial } from "../render/materials/gridMaterial.js";
import { createSculptBrush } from "../terrain/sculptBrush.js";
import {
  encodeHeightmapFile,
  decodeHeightmapFile,
  downloadBuffer,
  pickHeightmapFile,
} from "../io/heightmapIO.js";
import {
  isPng, decodePngHeights, encodeGray16Png, decodeRawHeights, encodeRaw16,
  flipRows, resampleHeights, heightsToUint16,
} from "../io/heightmapFormats.js";
import { DEFAULT_GEN } from "../terrain/proceduralGen.js";
import { createProceduralGenPass } from "../terrain/proceduralGenGpu.js";
import { erodeDroplets, buildErosionKernel, smoothHeights } from "../terrain/globalErosion.js";
import { streamPowerErode, createStreamPowerScratch } from "../terrain/streamPowerErosion.js";
import { initEditorShell } from "../ui/editorShell.js";
import { initPanelSplitters, createStatusBar } from "../ui/editorLayout.js";
import { refreshWidgets } from "../ui/widgets.js";
import { mergeKnownKeys } from "./state/mergeKnownKeys.js";
import { createEditorCameraController } from "../../v2/app/editorCameraController.js";
import { BRUSH_MASKS, loadMaskPNG } from "../terrain/brushMasks.js";
import { STAMP_GROUPS, loadStamp } from "../terrain/brushStamps.js";
import { createPlayMode, LOD_SNAP } from "../play/playMode.js";
import { createSpawnPointSystem } from "../play/spawnPoint.js";
import { buildSpawnPanel } from "../ui/buildSpawnPanel.js";
import { V2_CONFIG } from "../../v2/app/config.js";
import { createPerfState, tickPerf } from "../../v2/app/state/toolState.js";
import { createWorldToolState } from "./state/worldState.js";
import { createWorldEnvironment } from "./worldEnvironment.js";
import { buildWorldPanel } from "../ui/buildWorldPanel.js";
import { createHumanCharacter } from "../play/humanCharacter.js";
import { HuskyOnFoot } from "../../v2/play/huskyOnFoot.js";
import { FoxOnFoot } from "../play/foxOnFoot.js";
import { SplatMap } from "../terrain/splatMap.js";
import { createSplatOverlay } from "../terrain/splatOverlayTsl.js";
import { createTerrainNormalMap } from "../terrain/terrainNormalMap.js";
import { TextureLibrary } from "../terrain/textureLibrary.js";
import { ProceduralLayerBaker, procParamsFromPreset } from "../terrain/proceduralLayer.js";
import { createProceduralLayerPanel } from "../ui/proceduralLayerPanel.js";
import { PaintSystem } from "../tools/paintSystem.js";
import { BrushMask } from "../../v2/core/paint/brushMask.js";
import {
  encodeSplatmapFile,
  decodeSplatmapFile,
  pickSplatmapFile,
} from "../io/splatmapIO.js";
import { SPLAT_RES } from "../terrain/splatMap.js";
import { createSnowSystem } from "../terrain/snowSystem.js";
import { SnowMap, SNOW_MAP_RES } from "../terrain/snowMap.js";
import { encodeProjectFile, decodeProjectFile, isProjectFile, pickProjectFile } from "../io/projectIO.js";
import { projectAssets } from "../io/projectAssets.js";
import { getSharedGltfLoader, initGlbLoaderRenderer, fixFoliageTransparency } from "../../v2/core/foliage/glbLoader.js";
import { PropStore } from "../tools/propStore.js";
import { PropInstancer } from "../tools/propInstancer.js";
import { PropSystem } from "../tools/propSystem.js";
import { PLACED_PLANT_DEFAULTS, SpacingGrid, planPlacedPlants, removePlantsInRadius } from "../tools/placedPlants.js";
import { createSwayUniforms, applySway, toPlantNodeMaterial } from "../render/instancing/plantSway.js";
import { buildPlacedPlantPanel } from "../ui/buildPlacedPlantPanel.js";
import { planRockStamp, ROCK_SET_DEFAULTS } from "../tools/rockSetBrush.js";
import { PropPlacementPreview } from "../tools/propPlacementPreview.js";
import { LivePropManager } from "../tools/livePropManager.js";
import { createFlag } from "../props/liveProps.js";
import { FLAG_DEFAULTS } from "../../v2/core/props/flagFactory.js";
import {
  COIN_DEFAULTS, HEART_DEFAULTS, KEY_DEFAULTS,
  registerGlbCollectibleKind, isCollectibleFactoryId, buildCollectibleGhostGroup,
  collectibleUniforms,
} from "../props/collectibles.js";
import { createCollectibleRuntime } from "../play/collectibleRuntime.js";
import { createCollectibleBurst } from "../../v2/effects/collectibleBurst.js";
import { createCollectibleSfx } from "../../v2/play/collectibleSfx.js";
import {
  PROCEDURAL_PROP_DEFS,
  PROCEDURAL_PROP_LABELS,
  proceduralSchemaFor,
  buildProceduralPreviewGroup,
  registerProceduralObjectFactories,
} from "../../v2/core/props/proceduralObjectProps.js";
import { buildPropsPanel, defaultBakeProceduralThumbnails } from "../ui/buildPropsPanel.js";
import { registerRtsObjectFactories, RTS_PROP_DEFS, RTS_PROP_LABELS } from "../render/objects/rtsObjectProps.js";
import { bakeObjectThumbnails } from "../../v2/tools/objectThumbnails.js";
import { thumbKey, getThumb, putThumb } from "../props/rockThumbnailCache.js";
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
import { buildVegetationHeader, drawFlowerThumb } from "../ui/buildVegetationHeader.js";
import { FlowerSystem } from "../render/grass/flowerSystem.js";
import { FlowerDensity } from "../render/grass/flowerDensity.js";
import { FoliageScatterSystem, bakeFoliageThumbnail } from "../render/foliage/foliageSystem.js";
import { ScatterDensity } from "../render/scatter/scatterDensity.js";
import { AmbientFxSystem } from "../render/ambient/ambientFxSystem.js";
import { createAmbientFxState, AMBIENT_EFFECT_COUNT } from "./state/ambientFxState.js";
import { createFoliageScatterState, createSusukiPlantState, FOLIAGE_FIELD, SUSUKI_FIELD, TALL_PLANT_COUNT } from "./state/foliageScatterState.js";
import { createFlowerState } from "./state/flowerState.js";
import { buildFlowerPanel } from "../ui/buildFlowerPanel.js";
import { createFlowerTintShading } from "../render/grass/flowerTintTsl.js";
import { createGrassFarShading } from "../render/grass/grassFarTsl.js";
import { createGrassPushField } from "../render/grass/grassPushField.js";
import { GRASS_PRESETS } from "./state/grassPresets.js";
import { RevoGrassSystem } from "../render/grass/revoGrassSystem.js";
import { createRevoGrassState, REVO_GRASS_GEOMETRY_KEYS } from "./state/revoGrassState.js";
import { buildRevoGrassPanel } from "../ui/buildRevoGrassPanel.js";
import { DecalSystem } from "../render/decals/decalSystem.js";
import { createDecalEditor } from "../tools/decalEditor.js";
import { buildDecalPanel } from "../ui/buildDecalPanel.js";
import { WaterfallSystem } from "../render/waterfall/waterfallSystem.js";
import { createWaterfallEditor } from "../tools/waterfallEditor.js";
import { buildWaterfallPanel } from "../ui/buildWaterfallPanel.js";
import { CliffStore } from "../../v2/core/cliffs/cliffStore.js";
import { CliffBvh } from "../../v2/core/cliffs/cliffBvh.js";
import { SolidCollider } from "../physics/solidCollider.js";
import { createColliderGroup } from "../physics/colliderGroup.js";
import { createSplineFeatureColliderStore } from "../physics/splineFeatureCollider.js";
import { getRockGeometry, createRockKitGeometry, rockKitParams, ROCK_CLASSES, ROCK_KIT, ROCK_CLIFF_PRESETS } from "../props/proceduralRock.js";
// Cliffs are the rock generator with a flat top (the strata kit is gone).
const CLIFF_PRESETS = [...ROCK_CLIFF_PRESETS];
import { simplifierReady } from "../render/instancing/autoLod.js";
import { GREYBOX_KIT, buildGreyboxGeometry } from "../props/greyboxKit.js";
import { applyCliffTerrainBlend, createCliffGlbBlendMaterial } from "../props/cliffTerrainBlend.js";
import { applyRockShading, rockShadeUniforms, ROCK_BASE_COLOR } from "../props/rockShading.js";
import { CliffPaintMask } from "../../v2/core/cliffs/cliffPaintMask.js";
import { CliffPaintSystem } from "../../v2/tools/cliffs/cliffPaintSystem.js";
import { TreeBvh } from "../../v2/core/foliage/treeBvh.js";
import { createOnFootCollider } from "../../v2/play/onFootCollider.js";
import { createBvhDebugVisualizer } from "../tools/bvhDebugVisualizer.js";
import {
  createV3TerrainStoreAdapter,
  createV3SplineTerrainConfig,
} from "../terrain/v3TerrainStoreAdapter.js";
import { createTreeToolState } from "./state/treeState.js";
import { createTreeEnvironment } from "./treeEnvironment.js";
import { buildTreePanel } from "../ui/buildTreePanel.js";
import { buildBrushFilterSection, createBrushFilterState } from "../ui/brushFilterSection.js";
import { buildFoliagePanel } from "../ui/buildFoliagePanel.js";
import { buildAmbientFxPanel } from "../ui/buildAmbientFxPanel.js";
import { buildRiverV2Panel } from "../ui/buildRiverV2Panel.js";
import { RiverV2System } from "../tools/riverV2System.js";
import { TunnelSystem, createTunnelToolState } from "../tools/tunnelSystem.js";
import { createSnapshotHistory } from "../tools/snapshotHistory.js";
import { TUNNEL_DEFAULTS, CAVE_DEFAULTS } from "../tools/tunnelPath.js";
import { buildTunnelPanel } from "../ui/buildTunnelPanel.js";
import { createClickDetector, pickNearest, raycastMeshes, nearestXZ } from "./viewportPick.js";
import { createSceneOutliner, outlinerMatches } from "../ui/sceneOutliner.js";
import { createInspector } from "../ui/inspectorPanel.js";
import { createLakeToolState } from "./state/lakeState.js";
import { buildLakePanel } from "../ui/buildLakePanel.js";
import { LakeSystem } from "../tools/lakeSystem.js";
import { createRiverV2ToolState } from "./state/riverV2State.js";
import { setWaterSsrEnabled } from "../render/water/lakeMaterial.js";
import { createWaterSurfaceMap } from "../render/water/waterSurfaceMap.js";
import { createLakebedShading } from "../render/water/lakebedTsl.js";
import { createRiverSandShading } from "../render/water/riverSandTsl.js";
import { SmartRoadLabSystem } from "../../v2/tools/smartRoad/smartRoadLabSystem.js";
import { RoadConformSystem } from "../tools/roadConformSystem.js";
import { mergeRoadDrawCalls } from "../tools/roadDrawCallMerge.js";
import { DEFAULT_ROAD_STATE } from "./state/roadState.js";
import { buildRoadPanel } from "../ui/buildRoadPanel.js";
import { LaneRoadSystem, createLaneRoadToolState } from "../tools/laneRoadSystem.js";
import { buildLaneRoadPanel } from "../ui/buildLaneRoadPanel.js";
import { buildPlayPhysicsPanel } from "../ui/buildPlayPhysicsPanel.js";
import { buildPlayFlightPanel } from "../ui/buildPlayFlightPanel.js";
import { createFlyHud } from "../ui/flyHud.js";
import { uiById, uiQuery, uiQueryAll, setUiRoot, createHiddenEditorMarkup } from "../ui/uiRoot.js";
import { createShadowTestScene } from "../debug/shadowTestScene.js";
import { createTerrainShadowMap, terrainShade, terrainSunVisibilityHere, setActiveTerrainShadowMap } from "../render/lighting/terrainSunShadow.js";
// OFF by default — the custom GPU stats panel. Uncomment this line AND its
// block further down (search "GPU STATS PANEL — OFF") to bring it back.
// import { createGpuStatsPanel } from "../render/gpuStatsPanel.js";

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

  // GPU compute paths (crowd skinning) allocate storage buffers far bigger than
  // WebGPU's 128 MB default binding limit. Going over it does NOT throw: the bind
  // group is invalidated and the compute AND render passes are silently DROPPED —
  // you get a frozen crowd at a convincing 60 fps. Adapters allow much more (2 GB
  // here), but only if you ask.
  // A skinning kernel binds a fair few storage buffers at once (bone table, source
  // verts, skin indices/weights, per-instance data, output), and the default cap is
  // only 8 PER STAGE. Same silent failure as above: over the cap, the pipeline is
  // invalid and the pass is dropped.
  for (const key of [
    "maxStorageBufferBindingSize",
    "maxBufferSize",
    "maxStorageBuffersPerShaderStage",
  ]) {
    if (adapter.limits[key] !== undefined) requiredLimits[key] = adapter.limits[key];
  }

  const requiredFeatures = [...adapter.features];

  try {
    return await adapter.requestDevice({ requiredFeatures, requiredLimits });
  } catch (err) {
    console.warn("[V3] WebGPU device with raised limits failed; using defaults.", err);
    return adapter.requestDevice({ requiredFeatures });
  }
}

export async function startV3App(opts = {}) {
  /*
   * EDITOR or GAME. The editor page passes { editor: true }; a game boots
   * without it and gets the world with none of the editor's input: no editor
   * shortcuts (in the RTS, N switched the editor to Player-start mode and P
   * started the editor's play mode), no editor camera (wheel zoom, double-click
   * focus, fly mode), no orbit re-enabling every frame, no click-to-select, no
   * gizmo helper, no Scene list / Inspector / panel refresh, no status bar or
   * splitters. The game owns the camera controls and the keyboard. "The
   * element exists" is never the test — this flag is.
   */
  const isEditor = opts.editor === true;

  /*
   * WHERE THE CANVAS GOES, AND WHERE THE EDITOR MARKUP LIVES. A game passes
   * `container` (any element it sized — the canvas fills it) and its page needs
   * nothing from editor.html: the editor code that still runs during a game's
   * boot works on a hidden copy of that markup, never attached (ui/uiRoot.js).
   * The editor page — and an older game page that still injects editor.html
   * itself and passes no container — use the page's own #viewport and markup.
   */
  const container = !isEditor ? opts.container ?? null : null;
  setUiRoot(container ? await createHiddenEditorMarkup() : document);
  if (isEditor) initEditorShell();

  // Before the renderer's first size, so the viewport starts at the remembered panel widths.
  if (isEditor && uiById("app")) initPanelSplitters(uiById("app"));
  const statusBar = isEditor && uiById("status-bar") ? createStatusBar(uiById("status-bar")) : null;
  // A game page that injected editor.html itself (no container) must not show it.
  if (!isEditor && !container) uiById("status-bar")?.remove();

  const viewport = container ?? uiById("viewport");
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
  // ACES filmic, matching v2 + the daynight-sky lab. Without it the renderer
  // defaults to NoToneMapping, so the HDR sky renders uncompressed → too bright
  // and too cyan. renderOutput()/material toneMapped both honor this operator.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  // The foliage material uses castShadowNode (alpha-tested leaf shadows);
  // r184 requires this flag for that path (silences the boot warning too).
  renderer.shadowMap.transmitted = true;
  // editor.css sizes the canvas inside #viewport; in a game's container it
  // simply fills whatever box the game gave it.
  if (container) renderer.domElement.style.cssText = "display:block;width:100%;height:100%;outline:none";
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

  // ── GPU STATS PANEL — OFF ──────────────────────────────────────────────────
  // Commented out, not deleted: it is a diagnostic you turn on when you are
  // chasing a frame-time question, and it costs screen space the rest of the
  // time. To bring it back, uncomment the two lines at the end of this block
  // AND the `createGpuStatsPanel` import at the top of the file.
  //
  // SECOND GPU READOUT, RUNNING ALONGSIDE stats-gl ON PURPOSE.
  //
  // stats-gl shows `renderer.info.render.timestamp`, which is not a per-frame
  // number: three publishes the last frame in a resolve batch even when that
  // frame is still mid-flight and has only recorded some of its passes. This
  // project renders 18 passes per frame with ONE of them ~92% of the cost, so a
  // snapshot that misses it reports the frame as nearly free. Measured on a
  // completely static scene: the stats-gl value swung 4.46–17.76 ms, and while
  // driving it read 0.33 ms for a frame this panel measures at 4.65 ms.
  //
  // The two are deliberately kept side by side (the new panel prints stats-gl's
  // own value as `raw`) so the difference is visible rather than asserted —
  // retire stats-gl only once you have watched them disagree.
  //
  // NOTE while it is off: the numbers in the stats-gl GPU panel are the ones
  // this panel exists to distrust. Turn it back on before believing them.
  // const gpuStats = hasTimestamps ? createGpuStatsPanel(renderer) : null;
  // window.__v3GpuStats = gpuStats; // console probe: __v3GpuStats.sample()
  /** Created on demand by __V3_DEBUG.gpu(); nothing runs while it is null. */
  let _gpuStatsPanel = null;
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
  initGlbLoaderRenderer(renderer);

  // ── Scene ──────────────────────────────────────────────────────────────────
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87ceeb);

  // ── Camera ─────────────────────────────────────────────────────────────────
  const camera = new THREE.PerspectiveCamera(
    60,
    viewport.clientWidth / Math.max(viewport.clientHeight, 1),
    0.5,
    WORLD_SIZE * 4, // > maxCameraDistance(4000) + terrain LOD radius(4096) ≈ 8096
  );
  camera.position.set(0, 300, 600);

  let worldEnv = null;

  // ── Render scale ───────────────────────────────────────────────────────────
  // The terrain frame is fragment-bound (one render pass is ~93% of it), so
  // resolution is the single most direct quality/perf trade available — halving
  // the pixel count halves the dominant cost. Kept as a multiplier on top of the
  // device pixel ratio so 1.0 always means "native", whatever the display is.
  // Persisted per browser, not per project: it describes the MACHINE.
  const RENDER_SCALE_KEY = "v3.renderScale";
  const _basePixelRatio  = Math.min(devicePixelRatio, 2);
  const renderQuality = {
    scale: (() => {
      const v = parseFloat(localStorage.getItem(RENDER_SCALE_KEY));
      return Number.isFinite(v) ? Math.max(0.5, Math.min(2, v)) : 1;
    })(),
  };

  function resizeRenderer() {
    const w = viewport.clientWidth;
    const h = viewport.clientHeight;
    camera.aspect = w / Math.max(h, 1);
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(_basePixelRatio * renderQuality.scale);
    renderer.setSize(w, h);
    worldEnv?.setSize(w, h);
    layoutStatsOverlay();
  }

  function applyRenderScale() {
    localStorage.setItem(RENDER_SCALE_KEY, String(renderQuality.scale));
    resizeRenderer();
  }

  resizeRenderer();

  // ── Controls ───────────────────────────────────────────────────────────────
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 10, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.1;
  // Allow looking up at the sky / cloud deck (same as v2). 0.92π tilts well up
  // while stopping just short of flipping under the world.
  controls.maxPolarAngle = Math.PI * 0.92;
  controls.maxDistance = 4000;
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
  // A game never uses the editor's gizmo; its helper still costs a matrix
  // update per frame in the scene (the racing game measured ~0.35 ms for five).
  if (isEditor) scene.add(tc.getHelper());

  /** Matches v2 toolState.gizmo — Q toggles space; Shift enables snapping while dragging
   *  (rotation 15°, translation 1 m grid, scale 0.25 steps — greybox-friendly). */
  const gizmoState = { space: "world", rotationSnapDeg: 15, translateSnap: 1, scaleSnap: 0.25 };
  let _gizmoShiftHeld = false;

  function applyGizmoSettings() {
    tc.setSpace(gizmoState.space === "local" ? "local" : "world");
    const snapDeg = _gizmoShiftHeld ? gizmoState.rotationSnapDeg : 0;
    tc.setRotationSnap(snapDeg > 0 ? (snapDeg * Math.PI) / 180 : null);
    tc.setTranslationSnap(_gizmoShiftHeld && gizmoState.translateSnap > 0 ? gizmoState.translateSnap : null);
    tc.setScaleSnap(_gizmoShiftHeld && gizmoState.scaleSnap > 0 ? gizmoState.scaleSnap : null);
  }
  applyGizmoSettings();

  function refreshGizmoHud() {
    const el = isEditor ? uiById("gizmo-space-hint") : null;
    if (!el) return;
    const show = editorMode === "props" && !playMode.active;
    el.style.display = show ? "" : "none";
    if (!show) return;
    const snap = gizmoState.rotationSnapDeg > 0
      ? `Shift = snap ${gizmoState.translateSnap}m · ${gizmoState.rotationSnapDeg}°`
      : "snap off";
    const count = propInstancer?.selectionCount ?? 0;
    el.textContent =
      `Gizmo: ${gizmoState.space === "local" ? "LOCAL" : "WORLD"} · ${snap} · Q toggles space`
      + ` · Shift+RMB multi${count > 1 ? ` (${count})` : ""}`;
  }

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

  // Baked terrain normals — the heightmap's finite difference, computed once per
  // EDIT instead of four taps per pixel per frame. Must exist before any terrain
  // material is built (it supplies the node they sample) and it self-bakes on
  // construction, so the first frame never reads an empty target.
  const terrainNormals = createTerrainNormalMap({ heightTexNode, renderer });
  // Where the terrain's own shadow reaches, baked only when the sun turns or the
  // terrain changes (render/lighting/terrainSunShadow.js).
  const terrainShadowMap = createTerrainShadowMap({
    renderer, heightTexNode,
    worldSize: WORLD_SIZE, maxHeight: MAX_HEIGHT, heightmapSize: HEIGHTMAP_SIZE,
  });
  let _lastNormalBakeVersion = -1;

  // GPU procedural terrain generator — full-map pass through sculpt.runGeneratorPass.
  const genPass = createProceduralGenPass();

  // ── Snow system ────────────────────────────────────────────────────────────
  // heightTexNode.value is now the live GPU RT set by sculptBrush above.
  // Pass the shared height NODE, not just the texture: a second node over the
  // same texture would burn a second sampler binding in the terrain material.
  const snowSystem = createSnowSystem(renderer, scene, heightTexNode.value, heightTexNode, terrainNormals);
  const snowMap    = new SnowMap();
  snowSystem.setSnowMaskTex(snowMap.tex);

  // ── Paint system (splatmap + texture library + overlay) ───────────────────
  const splatMap   = new SplatMap();
  const textureLib = new TextureLibrary();
  // Procedural paint layers bake on the GPU. A factory, so the bake targets are
  // only allocated the first time a slot actually goes procedural.
  textureLib.setProceduralBakerFactory(() => new ProceduralLayerBaker(renderer));
  // ── Boot-time terrain shader features ─────────────────────────────────────
  // startV3App({ terrainFeatures: { cursor: false }, splatFeatures: { solo: false } }).
  //
  // These are COMPILE-TIME: a disabled feature's nodes are never built, so the
  // instructions and any texture bindings they need are absent from the shader
  // entirely. That makes this a boot decision, and it has to be read HERE rather
  // than with the csm/light overrides further down — the terrain materials are
  // built a few lines below, long before that point.
  //
  // Defaults are all-on, so the editor and any caller that passes nothing keep
  // the full shader. A GAME turns off what it cannot reach: `cursor` draws the
  // sculpt brush ring (and costs a sampler for the brush mask — the terrain
  // fragment stage is at WebGPU's 16 limit), `solo` is the paint panel's
  // single-layer greyscale view. Do NOT blanket-disable snow/lakebed/groundProc/
  // autoPaint/heightBlend/normalMap here: those are project-dependent, and a
  // saved world that uses one would silently render wrong.
  /*
   * ── BARE GROUND (the greybox surface) ──────────────────────────────────────
   *
   * Loaded HERE, ~70 lines before createTerrainLOD, because `style` is a
   * compile-time terrain feature: it has to be known before the first material
   * is built. worldToolState does not exist yet, so the values land in a plain
   * object now and are copied onto its `groundBase` slice once it does.
   *
   * localStorage is read ONLY in the editor. Games are pages on the same origin,
   * so a shared key would let an editor session set the racing game's ground
   * style behind the user's back; a game says what it wants through
   * `startV3App({ terrainFeatures: { baseStyle } })` and nothing else.
   */
  const GROUND_BASE_KEY = "v3.groundBase";
  /*
   * Bump whenever GRID_DEFAULTS changes what the grid LOOKS like. A saved blob
   * from an older version keeps its `style` (which is a working choice — an A/B
   * the user set) and drops its colours and cell sizes (which are a default the
   * user probably never touched). Without this, anyone who had the editor open
   * once is pinned to the old look forever and new defaults appear to do nothing.
   */
  const GROUND_BASE_VERSION = 12;
  const GROUND_BASE_MODES = ["grid", "tile", "flat"];
  /*
   * `moveSnap` and `followSnap` are editor BEHAVIOUR, not grid uniforms, so they
   * sit beside `style` rather than in GRID_DEFAULTS — but they are persisted in
   * the same blob because they are the same idea: the grid is a picture of
   * where a dragged object will land. With `followSnap` on, ours is that by
   * construction rather than by coincidence — the FINE cell IS the snap, and
   * the heavy line is `majorRatio` of them. At the defaults (1 m snap, 5) that
   * is the 1 m / 5 m grid every Unreal template shows.
   */
  const groundBase = {
    style: "grid",
    moveSnap: 1,
    // OFF by default. It was on, and because it derives the cell from the snap it
    // silently overrode GRID_DEFAULTS at every boot — the grid looked 5x too
    // coarse no matter what the defaults said. A convenience must never be able
    // to quietly win an argument with the thing it is a convenience for.
    followSnap: false,
    ...structuredClone(GRID_DEFAULTS),
  };

  /**
   * Derive the cell sizes from the move snap. Returns whether anything moved, so
   * callers can skip a pointless uniform write and widget refresh.
   */
  function syncGroundCellsToSnap(gb) {
    if (!gb.followSnap) return false;
    const next = gb.moveSnap / Math.max(2, gb.majorRatio);
    if (Math.abs(next - gb.minorCell) < 1e-9) return false;
    gb.minorCell = next;
    return true;
  }
  if (isEditor) {
    try {
      const saved = JSON.parse(localStorage.getItem(GROUND_BASE_KEY) || "null");
      if (saved && typeof saved === "object") {
        if (saved.v === GROUND_BASE_VERSION) {
          for (const k of Object.keys(groundBase)) {
            if (saved[k] !== undefined) groundBase[k] = saved[k];
          }
        } else if (GROUND_BASE_MODES.includes(saved.style)) {
          groundBase.style = saved.style;
        }
      }
    } catch {
      // A corrupt entry must not stop the editor booting — keep the defaults.
    }
  }
  syncGroundCellsToSnap(groundBase);
  applyGridConfig(groundBase);
  // The gizmo is the other half of the same setting; it was built above with the
  // default, so hand it whatever was restored.
  gizmoState.translateSnap = groundBase.moveSnap;
  applyGizmoSettings();

  // A game's explicit terrainFeatures wins over the editor's saved style.
  const terrainFeatureOverrides = { baseStyle: groundBase.style, ...(opts.terrainFeatures ?? {}) };
  const splatFeatureOverrides   = opts.splatFeatures   ?? {};

  const splatOverlay = createSplatOverlay(
    textureLib.getLayerUniforms(),
    textureLib.albedoArrayTex,
    textureLib.ormArrayTex,
    splatMap.tex,
    heightTexNode, // fallback height source when no baked surface is supplied
    splatFeatureOverrides,
    // Live slope+height for auto-paint, from the baked surface texture: one tap
    // instead of five, and it keeps the heightmap out of the fragment stage.
    terrainNormals,
  );

  // ── Procedural Ground / Meadow: retired 2026-09-13 ────────────────────────
  // MEASURED at 4.76 Mpx they cost +3.1 ms and +2.8 ms (Meadow on every terrain
  // pixel as soon as anything was painted), and no saved project used either.
  // The same looks are now procedural PAINT LAYERS (proceduralLayer.js), baked
  // once and costing what an image layer costs. v2's chunkGroundTsl.js and
  // chunkMeadowTsl.js stay: the v2 editor still uses them.

  // Cliff paint mask (v2 parity) — world-XZ brush mask whose R channel forces
  // the terrain look onto cliff surfaces. Shared deps for every cliff blend
  // material (procedural presets, imported GLBs, their LODs).
  const cliffPaintMask = new CliffPaintMask(512);
  const cliffBlendDeps = { heightTexNode, splatOverlay, cliffPaintTex: cliffPaintMask.texture, terrainNormals };

  // ── Water-surface map + lakebed shading ────────────────────────────────────
  // A top-down bake of every water surface's world Y (lakes + River v2 ribbons).
  // The terrain samples it to shade submerged ground — sand, depth tint, animated
  // caustics (revo-realms' Terrain.ts water block). Sources are registered after
  // the water systems exist below; until then the bake is a no-op.
  const waterSurfaceMap = createWaterSurfaceMap({ worldSize: WORLD_SIZE, maxHeight: MAX_HEIGHT });
  // Starts on defaults — identical to the lake slice's `lakebed` defaults created
  // later; lakebedChanged/import push any edited values into these uniforms.
  const lakebedShading = createLakebedShading({
    waterMapTex: waterSurfaceMap.texture,
    worldSize: WORLD_SIZE,
  });

  // LOD meshes share the same heightTexNode, cursor uniforms, brush mask, rotation,
  // and the snow surface definition (snowSystem.shared): painted snow displaces
  // the terrain itself with real volume; the deform tile only refines the same
  // surface with trail compression near the player.
  // Sand on the river banks. Reads River v2's nearest-segment field, which does
  // not exist yet — the sources are attached once that system is built.
  const riverSandShading = createRiverSandShading({ worldSize: WORLD_SIZE });
  // Built before the flowers exist; pointed at their density once it does.
  const flowerTintShading = createFlowerTintShading({ worldSize: WORLD_SIZE, splatTex: splatMap.tex });
  // Past the last grass blade ring the terrain carries the grass colour.
  const grassFarShading = createGrassFarShading({ worldSize: WORLD_SIZE });

  /**
   * Triplanar is compiled into the terrain shader only while at least one paint
   * layer has it on — with every switch off its branches still cost ~4 ms at
   * 4.76 Mpx (see splatOverlayTsl sampleLayer). Call after anything that changes
   * a layer's triplanar switch.
   */
  function syncTriplanarCompile() {
    splatOverlay.setTriplanarCompiled(
      textureLib.slotUniforms.map((u) => u.uTriplanar.value > 0.5),
    );
  }

  /** Same story for the layers shaded like the rock props (cliffRockTsl). */
  function syncRockShadeCompile() {
    splatOverlay.setRockShadeCompiled(
      textureLib.slotUniforms.map((u) => u.uRockShade.value > 0.001),
    );
  }

  // The cursor's fill shows the ACTIVE brush's falloff (see terrainLOD), kept
  // in step by syncCursorFalloff() in the frame loop.
  const uCursorFalloff = uniform(2);
  const lod = createTerrainLOD(heightTexNode, uCursorUV, sculpt.uRadius, sculpt.maskNode, sculpt.uMaskRotation, splatOverlay, snowSystem.shared, lakebedShading, null, terrainFeatureOverrides, terrainNormals, riverSandShading, flowerTintShading, terrainShadowMap, grassFarShading, uCursorFalloff);
  scene.add(lod.group);
  /**
   * Terrain visibility — see the `terrain` block on the returned handle.
   *
   * Declared HERE (not down with the handle) because the animate loop's grass
   * gates read it, and those run long before anything can call setVisible.
   */
  let _terrainVisible = true;
  // Console handle for terrain shader A/Bs — `buildVariant()` compiles a second
  // feature set and `setVariant()` swaps it onto the clipmap, so two shaders can
  // be compared within the same second and therefore at the same GPU clock. See
  // the note on buildVariant for why a reload-based comparison is not
  // trustworthy here. The clipmap is ONE merged mesh with one material now, so
  // both take/return a single material rather than one per LOD ring.
  window.__v3TerrainLOD = lod;
  // Terrain starts flat (createHeightmapTexture initializes all-zeros).
  // User can generate terrain manually via the Procedural panel.

  /*
   * ── HUMAN CHARACTER + QUADRUPED PAWNS, NOT LOADED YET ─────────────────────
   *
   * These are built here because play mode wants them by reference, but NOTHING
   * IS FETCHED until play mode is actually entered. Every game on this engine
   * constructs them, and most have no play mode: MEASURED on the racing game,
   * a boot pulled UA1+UA2 (5.07 MB), the husky (1.47 MB), the fox (0.82 MB), a
   * katana and a hat — 8.2 MB of characters it can never show, on every load,
   * over the network on a deployment.
   *
   * Safe to defer because all three loads were ALWAYS asynchronous. Everything
   * downstream already had to cope with a pawn whose model had not arrived
   * yet; this only widens a window the code was written to tolerate.
   */
  const character = createHumanCharacter(scene, renderer);
  const husky = new HuskyOnFoot({
    scene,
    loader: getSharedGltfLoader(),
    modelUrl: "/models/Husky_compressed.glb",
  });
  const fox = new FoxOnFoot({ scene, loader: getSharedGltfLoader() });
  /** Pull the play-mode cast in. Idempotent — each one guards itself. */
  function loadPlayCast() {
    character.load?.();
    husky.load();
    fox.load();
  }

  // Player BVH — merged CliffBvh bake (prop box proxies / live props) plus the
  // instanced SolidCollider (cliffs, real triangles, no rebake on edits),
  // combined behind one CliffBvh-shaped API for all play-mode consumers.
  const cliffStore = new CliffStore();
  const cliffBvh = new CliffBvh(cliffStore);
  const colliderSources = [cliffBvh]; // solidCollider pushed once propStore exists
  const worldCollider = createColliderGroup(colliderSources);
  let treeBvh = null;
  const onFootCollider = createOnFootCollider({
    cliffBvh: () => worldCollider,
    treeBvh: () => treeBvh,
  });
  let rebakePlayerBvh = () => {};
  let bvhDebug = null;
  const bvhDebugUi = { enabled: false };
  const syncBvhDebugToggles = () => {
    for (const el of uiQueryAll("[data-bvh-debug-toggle]")) {
      el.classList.toggle("checked", bvhDebugUi.enabled);
    }
    for (const el of uiQueryAll("[data-bvh-debug-cb]")) {
      el.checked = bvhDebugUi.enabled;
    }
  };
  const setBvhDebugEnabled = (on) => {
    bvhDebugUi.enabled = !!on;
    bvhDebug?.setEnabled(bvhDebugUi.enabled);
    syncBvhDebugToggles();
  };

  const terrainStoreAdapter = {
    getWorldHeight(wx, wz) {
      const u = (wx + WORLD_SIZE / 2) / WORLD_SIZE;
      const v = (wz + WORLD_SIZE / 2) / WORLD_SIZE;
      if (u < 0 || u > 1 || v < 0 || v > 1) return 0;
      return sampleTerrainHeight(u, v);
    },
  };

  // ── Play mode ──────────────────────────────────────────────────────────────
  const playPanel      = uiById("play-panel");
  const playStopBar    = uiById("play-stop-bar");
  const playStopHint   = uiById("play-stop-hint");
  const playImmersiveBtn = uiById("play-immersive-btn");
  const sculptPanel    = uiById("sculpt-panel");
  const paintPanel     = uiById("paint-panel");
  const propsPanel     = uiById("props-panel");
  const splinePanel    = uiById("spline-panel");
  const riverV2Panel   = uiById("riverv2-panel");
  const tunnelPanel    = uiById("tunnel-panel");
  const lakePanel      = uiById("lake-panel");
  const roadPanel      = uiById("road-panel");
  const laneRoadPanel  = uiById("lane-road-panel");
  const spawnPanel    = uiById("spawn-panel");
  const playStatPos    = uiById("play-stat-pos");
  const playStatSpeed  = uiById("play-stat-speed");
  const playStatGround = uiById("play-stat-ground");

  const playStatMode   = uiById("play-stat-mode");

  function refreshPlayStats() {
    if (!playMode?.active) return;
    const s = playMode.getStats();
    playStatPos.textContent = `${s.x}, ${s.y}, ${s.z}`;
    playStatSpeed.textContent = `${s.speed} m/s`;
    playStatGround.textContent = s.grounded === "fly" ? "—" : (s.grounded ? "Yes" : "No");
    if (playStatMode) playStatMode.textContent = s.mode ?? "—";
  }

  function syncPlayPanels() {
    playPhysicsUi?.setVisible(!!playMode?.onFootActive);
    playFlightUi?.setVisible(!!playMode?.flyActive);
    flyHud?.setVisible(!!playMode?.flyActive);
    playPhysicsUi?.syncFromPlayMode();
    playFlightUi?.syncFromPlayMode();
    syncColliderDebugUi();
  }

  // Painted snow raises the play-mode ground
  // *in* the snow rather than floating on bare terrain under it. SNOW_SINK is
  // the fraction of the depth that stays under the feet (the rest is what the
  // deform tile visually compresses away around them).
  const SNOW_SINK = 0.4;
  function snowGroundOffset(u, v) {
    const cov = snowMap.coverageAtUV(u, v);
    if (cov < 0.02) return 0;
    const wx = u * WORLD_SIZE - WORLD_SIZE / 2;
    const wz = v * WORLD_SIZE - WORLD_SIZE / 2;
    // Same slope rejection as the shader, so no phantom step on cliffs
    const ny = sampleTerrainNormal(wx, wz).y;
    const slope = THREE.MathUtils.smoothstep(ny, 0.55, 0.78);
    return cov * slope * snowSystem.params.baseDepth * SNOW_SINK;
  }

  /** Player start (spawn) — where play mode drops the character in. */
  const spawnSystem = createSpawnPointSystem({
    scene,
    getGroundY: (wx, wz) => {
      const u = (wx + WORLD_SIZE / 2) / WORLD_SIZE;
      const v = (wz + WORLD_SIZE / 2) / WORLD_SIZE;
      if (u < 0 || u > 1 || v < 0 || v > 1) return 0;
      return sampleTerrainHeight(u, v);
    },
  });
  let spawnUi = null;

  const playMode = createPlayMode({
    scene,
    renderer,
    camera,
    controls,
    getSpawnPoint: () => spawnSystem.getSpawn(),
    sampleTerrainHeight: (u, v) => sampleTerrainHeight(u, v) + snowGroundOffset(u, v),
    sampleTerrainNormal: (wx, wz) => sampleTerrainNormal(wx, wz),
    isTerrainHole: (wx, wz) => splatMap.holeAt(wx, wz) >= 0.5,
    uCursorUV,
    character,
    husky,
    fox,
    // Called by playMode.enter(), which is the ONE gate every route
    // into play mode passes through.
    loadPlayCast,
    getCollider: () => onFootCollider,
    getCliffBvh: () => worldCollider,
    getTreeBvh: () => treeBvh,
    // Road decks and walls: Smart Road decks + the lane road's { deck, solids }.
    getStuntRoadMeshes: () => [...(roadSystem?.getColliderMeshes() ?? []), ...(laneRoadSystem?.collisionMeshes().deck ?? [])],
    getStuntRoadSolidMeshes: () => laneRoadSystem?.collisionMeshes().solids ?? [],
    onStartWalking: () => { playHint.classList.add("visible"); },
    onEnterMenu:    () => { playHint.classList.remove("visible"); },
    onModeChange:   () => { refreshPlayStats(); syncPlayPanels(); },
    onRequestImmersive: () => setPlayImmersive(true),
    onExit: () => {
      syncPlayEditorChrome(false);
      tbPlay.classList.remove("active");
      playStopBar.classList.remove("visible");
      playHint.classList.remove("visible");
      playPanel.style.display = "none";
      syncSculptPanelVisibility();
      syncPaintPanelVisibility();
      syncGrassPanelVisibility();
      syncTreePanelVisibility();
      syncPropsPanelVisibility();
      syncSplinePanelVisibility();
      syncLakePanelVisibility();
      syncRoadPanelVisibility();
      syncLaneRoadPanelVisibility();
      syncCliffPaintPanelVisibility();
      syncSpawnPanelVisibility();
      applyRiverModeEffects();
      applyLakeModeEffects();
      applySpawnModeEffects();
      syncEditorOrbitEnabled();
      syncPlayImmersiveButtonLabel();
    },
  });

  const playPhysicsMount = isEditor ? uiById("play-physics-mount") : null;
  const playPhysicsUi = playPhysicsMount
    ? buildPlayPhysicsPanel({
        mount: playPhysicsMount,
        getCapsuleParams: () => playMode.getCapsuleParams(),
        setCapsuleParams: (patch) => playMode.setCapsuleParams(patch),
        resetCapsuleParams: () => playMode.resetCapsuleParams(),
      })
    : null;

  const playFlightMount = isEditor ? uiById("play-flight-mount") : null;
  const playFlightUi = playFlightMount
    ? buildPlayFlightPanel({
        mount: playFlightMount,
        getFlightParams: () => playMode.getFlightParams(),
        setFlightParams: (patch) => playMode.setFlightParams(patch),
        resetFlightParams: () => playMode.resetFlightParams(),
      })
    : null;

  const flyHud = isEditor ? createFlyHud() : null;

  function syncPlayEditorChrome(immersive) {
    if (!isEditor) return;
    const appEl = uiById("app");
    if (immersive) appEl?.classList.add("play-fullscreen");
    else appEl?.classList.remove("play-fullscreen");
  }

  function getPlayImmersive() {
    return uiById("app")?.classList.contains("play-fullscreen") ?? false;
  }

  function syncPlayStopHint() {
    if (!playStopHint) return;
    if (getPlayImmersive()) {
      playStopHint.innerHTML = "Immersive &nbsp;·&nbsp; click viewport to lock cursor &nbsp;·&nbsp; <kbd>Esc</kbd> releases";
    } else {
      playStopHint.innerHTML = "Windowed &nbsp;·&nbsp; <kbd>RMB</kbd> drag to look &nbsp;·&nbsp; Flight auto-switches immersive";
    }
  }

  function syncPlayImmersiveButtonLabel() {
    if (!playImmersiveBtn) return;
    const on = getPlayImmersive();
    playImmersiveBtn.textContent = on ? "Windowed" : "Immersive";
    playImmersiveBtn.title = on
      ? "Show editor panels again"
      : "Fullscreen viewport — hide side panels (or Shift+P when starting play)";
    syncPlayStopHint();
  }

  function setPlayImmersive(on) {
    if (!playMode.active) return;
    syncPlayEditorChrome(!!on);
    playMode.setEditorPointerMode(!on);
    syncPlayImmersiveButtonLabel();
  }

  // `editor` picks the default SKY MODE only — the editor opens in the atmosphere sky,
  // a game keeps the old default unless it asks. See worldState.js.
  const worldToolState = createWorldToolState({ editor: isEditor, skyMode: opts.skyMode });
  // The ground-base values were resolved before the terrain compiled (see the
  // block above createTerrainLOD); the panel edits this slice, so it has to hold
  // the same numbers the uniforms already carry.
  Object.assign(worldToolState.groundBase, groundBase);
  // Boot-time CSM override — startV3App({ csm: { cascades: 2 } }). MUST land
  // before createWorldEnvironment builds the CSMShadowNode: on three r184 a
  // LIVE cascade-count change is broken at the renderer level — the old node's
  // compiled pipeline keeps running updateBefore (re-adding its cascade lights
  // to the scene every frame) while the replacement node never gets compiled.
  // Cascade count is therefore a boot decision; see app.shadows for what CAN
  // change at runtime.
  if (opts.csm) Object.assign(worldToolState.csm, opts.csm);
  // Boot-time LIGHT override — startV3App({ light: { shadowNormalBias: 0.12 } }).
  // Same reason it lives here as the CSM block: createWorldEnvironment reads these
  // when it builds the sun and its cascades. Games with lots of flat-topped hard-
  // surface geometry (the RTS's structures) need a larger normalBias than the
  // editor default — terrain and foliage are curved enough not to show acne at
  // 0.02, but a flat armour deck self-shadows into stripes.
  if (opts.light) Object.assign(worldToolState.light, opts.light);
  // Whether loading a project also takes its saved sky, sun, clouds, fog and
  // post FX. The editor turns it on; games default to OFF because they set up
  // their own look (boot light overrides above, game-owned skies).
  const projectWorldLook = opts.projectWorldLook === true;
  const treeToolState = createTreeToolState();
  const editorConfig = {
    world: { size: WORLD_SIZE, chunkSize: V2_CONFIG.world.chunkSize },
    lod: { ...V2_CONFIG.lod },
    sculpt: { ...V2_CONFIG.sculpt },
    // Tree leaf render cells = chunkGroup × chunkSize (300 m): fewer, bigger
    // leaf meshes → fewer draw calls, at the cost of coarser per-cell LOD.
  };
  // Paint layers flagged "Blocks trees" (a path, a shore) keep tree and
  // foliage painting off them. Placement only: trees already standing there
  // are never deleted. Lazy — textureLib/splatMap are read at call time.
  //
  // Water blocks them too, and for a plainer reason: a brush swept across a
  // valley does not know the river is there, so it plants trunks on the
  // riverbed with the water drawn straight through them. waterLevelAt covers
  // the ocean, lakes and River v2 alike, and is -Infinity on dry ground.
  // 0.25 m of slack leaves the very edge of the bank plantable.
  const isVegetationBlocked = (wx, wz) => {
    if (splatMap.holeAt(wx, wz) >= 0.35) return true;
    const wl = waterLevelAt(wx, wz);
    if (wl > -Infinity && wl > terrainStoreAdapter.getWorldHeight(wx, wz) - 0.25) return true;
    const flags = textureLib.blocksTreesFlags();
    if (!flags.some(Boolean)) return false;
    return splatMap.flaggedWeightAt(wx, wz, flags) > 0.45;
  };
  const treeEnv = createTreeEnvironment({
    scene,
    renderer,
    config: editorConfig,
    getWorldHeight: (wx, wz) => terrainStoreAdapter.getWorldHeight(wx, wz),
    isPlacementBlocked: isVegetationBlocked,
    toolState: treeToolState,
    // Lazy: withRendererSideWork is declared further down (hoisted) and only
    // runs after a preset loads, long after the loop's state exists.
    runRendererSideWork: (fn) => withRendererSideWork(fn),
  });
  treeBvh = new TreeBvh(treeEnv.treeStore, (slotIdx) => {
    const s = treeToolState.treeSlots[slotIdx];
    return s ? { radius: s.colliderRadius, height: s.colliderHeight } : null;
  });
  const perf = createPerfState();
  let splineSys = null;
  let splineFeatureStore = null;
  let tunnelColliderStore = null;
  let _tunnelHolesHv = -1, _tunnelHolesDue = 0;
  let _legacyMeadowPainted = false;

  function getTerrainMeshesForWorld() {
    const out = [];
    lod.group.traverse((o) => { if (o.isMesh) out.push(o); });
    return out;
  }

  /*
   * THE ENVIRONMENT IS OPTIONAL. `startV3App({ environment: false })` builds
   * none of it — no sky, sun/ambient lights, shadows, fog, ocean, clouds, post
   * FX or lens flare — for a game that brings its own. The engine then renders
   * the scene plainly, and everything that needs a light direction (grass,
   * susuki, trees, foliage, snow, lakes, rivers) takes the game's
   * (`app.environment.setLightDirection`), or a fixed default until it does.
   */
  const useEnvironment = opts.environment !== false;
  const _defaultLightDir = new THREE.Vector3(0.5, 0.8, 0.3).normalize();
  let _gameLightDir = null;
  /** The direction the scene is lit from: the game's, the environment's, or the default. */
  function getLightDir() {
    return _gameLightDir ?? worldEnv?.getEffectiveLightDir?.() ?? _defaultLightDir;
  }

  if (useEnvironment) worldEnv = await createWorldEnvironment({
    scene,
    renderer,
    camera,
    controls,
    playMode,
    toolState: worldToolState,
    heightTexNode: heightTexNode,
    terrainSize: WORLD_SIZE,
    getSplineSystem: () => splineSys,
    getTerrainMeshes: getTerrainMeshesForWorld,
  });

  /*
   * ── BARE GROUND, the live half ─────────────────────────────────────────────
   *
   * Every knob except `style` is a uniform shared by the terrain and by every
   * prop that took the default material, so a slider drag is one uniform write
   * and no recompile. `style` is a compile-time terrain feature and goes through
   * buildVariant/setVariant instead — the same swap the shader A/Bs use, which
   * is what makes "grid" and "tile" comparable inside the same second and
   * therefore at the same GPU clock (a reload cannot be: measured, this laptop
   * runs the identical scene at 4 ms or 64 ms depending on where the GPU clock
   * happens to sit — see user_msi_thin15_gpu_throttle).
   *
   * Props are NOT re-materialised on a style change. They are built at
   * registration and a swap would have to walk every type and every LOD entry;
   * the comparison that matters is the terrain's, and prop materials rebuild on
   * the next reload anyway.
   */
  /**
   * One material per style, built on first use and kept. Toggling the dropdown
   * back and forth would otherwise compile a new pipeline every time — and the
   * second half of an A/B has to be instant, or the comparison is measuring the
   * compile. The boot style's material is the live one, so it is seeded rather
   * than built.
   */
  const _groundVariants = new Map();

  function groundVariant(style) {
    let m = _groundVariants.get(style);
    if (!m) {
      terrainFeatureOverrides.baseStyle = style;
      m = lod.buildVariant(terrainFeatureOverrides);
      _groundVariants.set(style, m);
    }
    return m;
  }

  function applyGroundBase(styleChanged = false) {
    const gb = worldToolState.groundBase;
    syncGroundCellsToSnap(gb);
    gizmoState.translateSnap = gb.moveSnap;
    applyGizmoSettings();
    applyGridConfig(gb);
    if (styleChanged && lod) {
      if (!_groundVariants.has(groundBase.style)) {
        _groundVariants.set(groundBase.style, lod.mesh.material);
      }
      lod.setVariant(groundVariant(gb.style));
    }
    try {
      localStorage.setItem(GROUND_BASE_KEY, JSON.stringify({ v: GROUND_BASE_VERSION, ...gb }));
    } catch {
      // Private mode / quota: the look is still applied, it just will not persist.
    }
  }

  function resetGroundBase() {
    const gb = worldToolState.groundBase;
    const styleChanged = gb.style !== "grid";
    Object.assign(gb, {
      style: "grid",
      moveSnap: 1,
      followSnap: false,
      ...structuredClone(GRID_DEFAULTS),
    });
    applyGroundBase(styleChanged);
  }

  /**
   * Material for a prop slot.
   *
   * The library's `__none__` entry used to mean "flat grey 0xcccccc", which gave
   * a blockout no sense of scale — a 4 m kit wall and a 1 m cube were the same
   * featureless surface. For BLOCKOUT props it now means the shared metric grid,
   * in WORLD space, so a prop's cells line up with the terrain's underneath it
   * and with the next prop along. World and not object space because props are
   * InstancedMesh: one world matrix for every instance, so an object-origin grid
   * would put every copy's origin in the same place (see createGridMaterial).
   *
   * `plain: true` is for props that HAVE A LOOK OF THEIR OWN. On a rock or a
   * cliff, `__none__` does not mean "nothing" — it means "use the kit's own
   * procedural shading", and that shading is a LAYER: both applyRockShading and
   * applyCliffTerrainBlend do `mat.colorNode ?? materialColor` and multiply over
   * it. Hand them a grid and the grid gets baked into the stone instead of
   * replaced by it. Those callers ask for the flat base the layers expect.
   *
   * Anything with a real material in the library is untouched either way — a PBR
   * rock texture is exactly what the shading layers want underneath them.
   */
  function propMaterialFor(libMat, opts = {}) {
    if (libMat && libMat.type !== "none") return createMaterialForLibrary(libMat, opts);
    if (opts.plain) return createMaterialForLibrary(null, opts);
    return createGridMaterial({ mode: "world", triplanar: !!opts.triplanar });
  }

  // Declared up here because the World panel is built long before the scene
  // systems are; it stays null until then and every hook below tolerates that.
  let shadowTest = null;
  let _shadowTestTick = 0;

  function buildWorldPanelUi() {
    if (!isEditor) return;
    buildWorldPanel({
      toolState: worldToolState,
      config: editorConfig,
      perf,
      syncCsm: () => worldEnv?.syncCsm(),
      setCsmEnabled: (on) => worldEnv?.setCsmEnabled(on),
      describeCsm: () => worldEnv?.describeCsm?.() ?? null,
      shadowTest: {
        get visible() { return !!shadowTest?.visible; },
        toggle() {
          if (!shadowTest) return false;
          const on = !shadowTest.visible;
          shadowTest.setVisible(on);
          if (on) {
            shadowTest.layOutFrom(camera, controls);
            shadowTest.syncFromCsm(worldEnv?.describeCsm?.() ?? null);
          }
          return on;
        },
        stand() {
          if (!shadowTest?.visible) return;
          shadowTest.focus(camera, controls);
        },
      },
      applyPostFxState: () => worldEnv?.applyPostFxState(),
      syncFog: () => {
        worldEnv?.syncFog();
        worldEnv?.driveFogSun();
      },
      applySkyMode: (mode, prev) => worldEnv?.applySkyMode(mode, prev),
      setAtmosphereCloudTier: (tier) => worldEnv?.setAtmosphereCloudTier(tier),
      importHdr: () => worldEnv?.importHdr(),
      setTimeOfDay: (t) => worldEnv?.setTimeOfDay(t),
      rebuildProceduralSkyEnv: () => worldEnv?.rebuildProceduralSkyEnv(),
      rebuildSkyEnv: () => worldEnv?.rebuildSkyEnv(),
      syncInteriorUniforms: () => worldEnv?.syncInteriorUniforms(),
      rebuildInteriorVolumes: () => worldEnv?.rebuildInteriorVolumes(),
      worldOceanChanged: () => worldEnv?.worldOceanChanged(),
      getOceanV2Stats: () => worldEnv?.getOceanV2?.()?.stats ?? null,
      onConfigChanged: () => {},
      renderQuality,
      onRenderScaleChanged: () => applyRenderScale(),
      groundBase: {
        modes: GROUND_BASE_MODES,
        onChanged: (styleChanged) => applyGroundBase(styleChanged),
        reset: () => resetGroundBase(),
      },
      ui: { refreshLiveSliders: () => {} },
    });
    if (typeof lucide !== "undefined") lucide.createIcons();
  }
  buildWorldPanelUi();

  // ── Grass system ───────────────────────────────────────────────────────────
  const grassTerrainData = new GrassTerrainData();
  // Grass/susuki read the terrain surface straight off the GPU bake — see the
  // note in grassTerrainData.js for the 17.3 ms/readback this replaced.
  grassTerrainData.initSurfaceBake({
    renderer,
    heightTexNode,
    heightmapSize: HEIGHTMAP_SIZE,
    worldSize: WORLD_SIZE,
    maxHeight: MAX_HEIGHT,
  });
  // Grass and susuki sample painted density with "Blocks grass" layers masked
  // out — a GPU bake that only re-runs when the density, the ground paint or
  // a layer's flag changes. See grassTerrainData.initDensityMask.
  grassTerrainData.initDensityMask({ renderer, splatTex: splatMap.tex });
  grassFarShading.setSource(grassTerrainData.grassDensityMaskedTex);
  // Anything can bend grass: player, wheels, a game's own objects (stamp()).
  const grassPush = createGrassPushField({ renderer });
  // Flowers: their own painted layer (one type per channel), masked the same way.
  const flowerDensity = new FlowerDensity();
  flowerDensity.initMask({ renderer, splatTex: splatMap.tex });
  flowerTintShading.setSource(flowerDensity.maskedTex);
  // Painted foliage (ferns and friends): its own layer on the same scatter core.
  const foliageDensity = new ScatterDensity({ res: 1024, channels: 8 });
  foliageDensity.initMask({ renderer, splatTex: splatMap.tex });
  const grassWindTex      = createWindTexture();
  const grassSpecNoiseTex = createSpecNoiseTexture();

  const grassState = {
    // The grass system this world runs — "hybrid" (LOD rings of separate lit
    // blades) or "revo" (one dense camera-following tile). Not a look preset,
    // two engines. See state/revoGrassState.js. Its control is the System
    // dropdown, kept in step by syncGrassSystemUi, not by the slider table.
    system: "hybrid",
    bladeHeight: 1, bladeWidth: 0.15, bladeYSegments: 7, tipTaperStart: 0.5,
    crossed: true,
    bendFocus: 0.5, stiffness: 0, maxAngle: 1.4, naturalLean: 0.9,
    windSpeed: 0.2, windStrength: 1.4, windGust: 0.3, windWaveScale: 0.12, windAngle: 0,
    clumpScale: 1.5, clumpStrength: 0.7, clumpPull: 0, foldBelow: 1.1,
    grassDensity: 1,
    bladeColor: "#0e300e", tipColor: "#00b30c",
    aoBase: 0.25, aoPower: 2, farAoMul: 1, shadeVariation: 1,
    colorVariation: false,
    cvHueSpread: 0.08, cvSatSpread: 0.3, cvDryAmount: 0.15, cvDryColor: "#8a7a3a",
    skyBlend: 0.8, cylindrical: 0.3, viewThicken: 0.45,
    bssColor: "#2d7a2d", bssIntensity: 1.2, bssPower: 2,
    frontScatter: 0.3, rimSSS: 0.25,
    slopeEnabled: false, slopeMin: 0.65, slopeMax: 0.85,
    // v3 tint always uses "img" mode (2): the splat/snow terrain color is baked
    // top-down into grassTintRT and sampled by the blades at their world XZ.
    terrainTintEnabled: false, terrainTintAutoSource: false,
    terrainTintManualMode: 2, terrainTintStrength: 0.5, terrainTintRootBias: 0.35,
    specV1Enabled: false, specV1Intensity: 1.5, specV1Color: "#ffffff",
    specV1DirX: -1, specV1DirY: 1, specV1DirZ: 0.5, specV1Power: 25.6,
    specV2Enabled: false, specV2Intensity: 1, specV2Color: "#ffffff",
    specV2DirX: -1, specV2DirY: 0.45, specV2DirZ: 1,
    specV2NoiseScale: 3, specV2NoiseStr: 0.6, specV2Power: 12, specV2TipBias: 0.5,
    interactionRadius: 1.5, interactionStrength: 0.7, interactionMode: 0,
    trailStrength: 1, trailRecovery: 2.5,
    receiveShadow: true, lodDebug: false,
    lodMidDistance: 40, lodFarDistance: 80, lodMaxDistance: 200, lodMegaMaxDistance: 400,
    lodMidSegments: 3, lodFarSegments: 2, lodMegaSegments: 2,
    lodFarBladeWidth: 0.45, lodMegaBladeWidth: 0.5,
    // Without the Far ring (default) the ground takes over where the Mid ring
    // ends (~200 m), like Ghost of Tsushima; with it blades reach ~400 m.
    farBlades: false,
  };

  // target: "terrain" | "cliff" density, or "height" (painted blade height,
  // eased toward heightTarget x Blade height).
  const grassBrush = { radius: 60, strength: 0.7, falloff: 2.0, erase: false, target: "terrain", heightTarget: 0.5 };

  // ── Vegetation mode: foliage, flowers and susuki painted from one mode ──────
  // Three scatter systems with their own paint layers and saves, one brush.
  // Each system's brush object keeps its own `type` and reads the shared size,
  // strength, falloff and erase settings through accessors, so the stroke code
  // of each system is unchanged. The editor modes stay separate internally
  // ("foliage", "flowers", "susuki" — the input handlers and panels key on
  // them); the toolbar, the mode list and F show them as one.
  const VEG_MODES = ["foliage", "flowers", "susuki", "vegPlaced"];
  const vegBrush = { radius: 14, strength: 0.6, falloff: 1.5, erase: false, eraseOnlyType: false };
  const _shareVegBrush = (b) => {
    for (const k of Object.keys(vegBrush)) {
      Object.defineProperty(b, k, { get: () => vegBrush[k], set: (v) => { vegBrush[k] = v; }, enumerable: true });
    }
    return b;
  };
  let _lastVegMode = "foliage";
  let vegUi = null;
  // Placed plants (imported GLBs painted as prop instances, placedPlants.js).
  // Up here: a project load during boot restores plant slots before the
  // Vegetation code further down has run.
  let placedUi = null;
  let _vegPlacedSlot = -1;          // prop slot index of the selected placed plant
  const _placedThumbs = new WeakMap(); // prop slot -> picture
  const _plantSway = new Map();        // prop slot -> its wind uniforms
  // ONE undo history for all three, so Ctrl+Z walks strokes in the order they
  // happened whichever plant they painted, and an erase that cleared every
  // kind of plant is one step. An entry holds a density snapshot per system it
  // touched ({ foliage?, flowers?, susuki? }); a paint stroke touches one.
  // A 4-8 MB snapshot per system per step, so the history is kept short.
  // Declared up here because a project load (which can run during boot) resets it.
  const VEG_UNDO_LIMIT = 16;
  const _vegUndoStack = [];
  const _vegRedoStack = [];

  // ── Susuki (GoT miscanthus plumes — own paint layer, own scatter field) ────
  // The FOLIAGE system with one plant (pampas with a fan of plumes on stiff
  // stalks) on a far-reaching field: see createSusukiPlantState. Same shape
  // code, material, panel and shadows as every other plant.
  const susukiState = createSusukiPlantState();
  // `type` is per-brush (radius/strength/erase are shared through vegBrush).
  // This one had none while the field held a single plant.
  const susukiBrush = _shareVegBrush({ type: 0 });
  let susukiSystem = null;
  let _susukiBuilding = false;
  let susukiUi = null;
  const _susukiThumbs = new Map();
  let _susukiThumbChain = Promise.resolve();
  /** Bake one tall plant's picker card, or all of them when `which` is null. */
  function queueSusukiThumb(which = null) {
    if (!isEditor) return;
    const list = which == null ? susukiState.types.map((_, i) => i) : [which];
    for (const i of list) {
      _susukiThumbChain = _susukiThumbChain
        .then(async () => {
          const url = await bakeFoliageThumbnail(susukiState.types[i], {
            renderer,
            runRendererSideWork: (fn) => withRendererSideWork(fn),
          });
          if (url) { _susukiThumbs.set(i, url); vegUi?.refreshCards(); }
        })
        .catch((e) => console.warn("[V3 Tall plants] thumbnail failed:", e));
    }
  }

  // ── Flowers (painted meadow flowers — own paint layer + instanced system) ──
  const flowerState = createFlowerState();
  flowerTintShading.syncFromState(flowerState);
  const flowerBrush = _shareVegBrush({ type: 0 });
  let flowerSystem = null;
  let _flowerBuilding = false;
  let flowerUi = null;

  // ── Painted foliage (ferns — the same painted layer + GPU scatter as flowers) ──
  const foliageScatterState = createFoliageScatterState();
  const foliageScatterBrush = _shareVegBrush({ type: 0 });
  let foliageScatter = null;
  let _foliageScatterBuilding = false;
  let foliageUi = null;
  let ambientFxUi = null;
  /** Plant pictures for the panel's picker, baked once each and after an edit. */
  const _foliageThumbs = new Map();
  let _foliageThumbChain = Promise.resolve();
  function queueFoliageThumb(i) {
    if (!isEditor) return;   // a picker picture; a game has no picker
    _foliageThumbChain = _foliageThumbChain
      .then(async () => {
        // Needs only the renderer: the pictures come before the field is built.
        const url = await bakeFoliageThumbnail(foliageScatterState.types[i], {
          renderer,
          runRendererSideWork: (fn) => withRendererSideWork(fn),
        });
        if (url) { _foliageThumbs.set(i, url); vegUi?.refreshCards(); }
      })
      .catch((e) => console.warn(`[V3 Foliage] thumbnail ${i} failed:`, e));
  }
  let _foliageThumbsQueued = false;
  function queueAllFoliageThumbs() {
    _foliageThumbsQueued = true;
    queueSusukiThumb();
    for (let i = 0; i < foliageScatterState.types.length; i++) queueFoliageThumb(i);
  }
  // Which plants are painted (so unused ones are not drawn); rechecked after a
  // stroke, a fill or a load, never per frame.
  let _foliageUsedDirty = true;

  let grassRings = null;
  let _grassBuilding = false;
  let _grassRingsEnabled = false;
  let cliffGrassRings = null;   // second ring set, cliffMode — grass on cliff tops
  let _cliffGrassBuilding = false;
  let _cliffRingsEnabled = false;
  // The OTHER grass system (revoGrassSystem.js) — one camera-following tile of
  // small camera-facing blades. `grassState.system` picks which one runs; only
  // the chosen one is ever built, so a world that never asks for it pays
  // nothing at all.
  let revoGrass = null;
  let _revoBuilding = false;
  let revoUi = null;          // its panel, rebuilt when a load changes the values

  // ── Terrain tint bake ──────────────────────────────────────────────────────
  // v2 fed the grass a procedural ground-color TSL fn; v3's terrain color is
  // the splat overlay, so it gets baked top-down into a small RT the blades
  // sample in "img" tint mode. Re-baked every ~0.5 s while tint is enabled, so
  // splat repaints / auto-paint / snow / late texture loads can never go stale.
  const GRASS_TINT_RES = 512;
  const grassTintRT = new THREE.RenderTarget(GRASS_TINT_RES, GRASS_TINT_RES, {
    type: THREE.HalfFloatType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: false,
    depthBuffer: false,
    colorSpace: THREE.NoColorSpace,
  });
  grassTintRT.texture.flipY = false;
  grassTintRT.texture.name = "GrassTerrainTint";
  const grassTintScene = new THREE.Scene();
  // BOTH axes are swapped on purpose (left/right AND top/bottom): a
  // straight-down lookAt with up=(0,0,1) mirrors world X in camera space, and
  // the render target's row order mirrors world Z, so the bake has to flip
  // both to match the grass shader's tintUv = worldXZ / WORLD_SIZE + 0.5.
  //
  // The Z half was missing and nobody could see it while the ground was one
  // colour: MEASURED 2026-09-18 by painting rock at world z = +300 and reading
  // the bake the way the blades read it — green at +300, GREY at -300. With
  // the Genshin preset (tint at full takeover) that showed up as grey-blue
  // blades nowhere near any rock, mirrored across the map.
  const grassTintCam = new THREE.OrthographicCamera(
    WORLD_SIZE / 2, -WORLD_SIZE / 2, -WORLD_SIZE / 2, WORLD_SIZE / 2, 0.1, 50,
  );
  // Layers grass cannot grow on are LEFT OUT of the tint. A blade must never
  // take the colour of rock, a cliff or a path — that was showing up as grey
  // blades wherever a grass edge met stone. Their share goes to the layers
  // still painted there, so a blade beside a rock keeps the meadow colour.
  // Declared out here because syncGrassTintLayers() below writes it.
  const tintLayerKeep = Array.from({ length: 7 }, () => uniform(1));
  grassTintCam.position.set(0, 10, 0);
  grassTintCam.up.set(0, 0, 1);
  grassTintCam.lookAt(0, 0, 0);
  {
    // DoubleSide is REQUIRED: the swapped-axis ortho projection above flips
    // triangle winding, so a FrontSide plane is backface-culled and the bake
    // silently stays black (= the "tint only darkens" bug).
    const tintMat = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
    // Same stack terrainLOD renders: splat layers over the plain tile base,
    // snow albedo on top where covered — grass under snow tints white.
    // (Procedural Ground and Meadow used to feed in here too; both retired.
    // With them off — every saved project — they multiplied to exactly this.)
    const tintBase = uniform(new THREE.Color(0xe6e3e3));
    let tintCol = splatOverlay.blend({ baseColor: tintBase, layerKeep: tintLayerKeep }).color;
    const snowShared = snowSystem?.shared;
    if (snowShared) {
      tintCol = mix(
        tintCol,
        snowShared.snowAlbedo(float(0)),
        snowShared.covBlend(positionWorld.xz),
      );
    }
    tintMat.colorNode = tintCol;
    const tintPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE),
      tintMat,
    );
    tintPlane.rotation.x = -Math.PI / 2;
    tintPlane.frustumCulled = false;
    grassTintScene.add(tintPlane);
  }
  /** "Blocks grass" flags → the tint bake's held-out layers. */
  function syncGrassTintLayers(flags) {
    let changed = false;
    for (let i = 0; i < tintLayerKeep.length; i++) {
      const keep = flags[i] ? 0 : 1;
      if (tintLayerKeep[i].value !== keep) { tintLayerKeep[i].value = keep; changed = true; }
    }
    if (changed) grassTintDirty = true;
  }

  let grassTintDirty = true;
  let _grassTintFrame = 0;
  function bakeGrassTintIfNeeded() {
    if (!grassRings || !grassState.terrainTintEnabled) return;
    _grassTintFrame++;
    if (!grassTintDirty && _grassTintFrame % 30 !== 0) return;
    grassTintDirty = false;
    const prevRT = renderer.getRenderTarget();
    renderer.setRenderTarget(grassTintRT);
    renderer.render(grassTintScene, grassTintCam);
    renderer.setRenderTarget(prevRT);
  }

  // The LOD ring windows are shared by both the terrain and the cliff-top grass
  // layers so their coverage is identical — the overlapping inner/outer ramps
  // are what make the field seamless (a trimmed set leaves gap rings between
  // LODs). Each entry is a per-ring override on top of `shared`; the `name` is
  // suffixed per layer.
  const GRASS_RING_DEFS = [
    { key: "Near",    tileSize: 130, bladesPerSide: 512,
      outerR0: 36, outerR1: 62 },
    { key: "MidThin", tileSize: 180, bladesPerSide: 384, segments: 3,
      innerR0: 36, innerR1: 56, outerR0: 70, outerR1: 88,
      crossFadeR0: 70, crossFadeR1: 88 },
    { key: "Mid",     normalMode: "flat", crossed: false,
      tileSize: 440, bladesPerSide: 576,
      bladeWidth: 0.45, segments: 2, bladeHeightMul: 1.1,
      innerR0: 64, innerR1: 88, outerR0: 180, outerR1: 218 },
    // Blade spacing steps ~4x in area per ring, like GoT dropping 3 of 4
    // blades per LOD: 0.25 / 0.47 / 0.76 / 1.56 m. Far was 2.08 m (7.5x from
    // Mid) with 0.7 m single-segment blades, which read as blocks.
    { key: "Far",     normalMode: "flat", crossed: false,
      tileSize: 800, bladesPerSide: 512,
      bladeWidth: 0.5, segments: 2, bladeHeightMul: 1.2,
      innerR0: 175, innerR1: 215, outerR0: 360, outerR1: 398 },
  ];

  /*
   * The clipmap surface everything scattered stands on.
   *
   * ONE definition: the heightmap and the drawn mesh are different surfaces,
   * and anything that disagrees about which one is "the ground" floats or
   * sinks. Grass, foliage and the tall plants all read this, so they cannot
   * drift apart. `centerXZ` is the live Vector2 the clipmap updates, so the
   * caller tracks lod.update() with no per-frame work.
   */
  const terrainSurfaceDesc = () => ({
    centerXZ: lod.uCenter.value, baseStep: BASE_STEP, levels: LOD_LEVELS,
    halfCells: GRID_N / 2, gridOffset: GRID_OFFSET,
  });

  async function _buildGrassRingSet(namePrefix, extraShared) {
    const shared = {
      scene,
      renderer,
      heightTex:        grassTerrainData.grassHeightTex,
      terrainNormalTex: grassTerrainData.terrainNormalTex,
      densityTex:       grassTerrainData.grassDensityMaskedTex,
      windTex:          grassWindTex,
      specNoiseTex:     grassSpecNoiseTex,
      tintTex:          grassTintRT.texture,
      worldSize:        WORLD_SIZE,
      gp:               grassState,
      terrainShadow:    { shade: terrainShade, visibilityHere: terrainSunVisibilityHere },
      // Blades stand on the clipmap's triangles, not the exact heightmap, so
      // they never float over a crest the coarse mesh cuts under.
      terrainSurface:   terrainSurfaceDesc(),
      bladeHeightTex:   grassTerrainData.bladeHeightTex,
      waterMapTex:      waterSurfaceMap.texture,   // nothing grows under water
      pushField:        grassPush.field,
      ...extraShared,
    };
    const rings = GRASS_RING_DEFS.map(({ key, ...def }) =>
      new HybridGrassSystem({ ...shared, name: namePrefix + key, ...def }));
    for (const r of rings) await r.init(camera);
    for (const r of rings) {
      // Widen horizontal cull pad so fast camera rotation (play-mode mouse-look)
      // doesn't pop blades in at screen edges. The VS clips properly regardless;
      // off-screen blades in the compact buffer cost only VS invocations, no pixels.
      r.u.uCullPadNdcX.value    = 0.45;
      r.u.uCullPadNdcYFar.value = 0.45;
    }
    return rings;
  }

  async function ensureGrassBuilt() {
    if (grassRings || _grassBuilding) return;
    _grassBuilding = true;
    try {
      // Built DISABLED, same as the cliff set: the render loop enables them on
      // the next frame if any density is painted. Entering grass mode to start
      // painting therefore costs nothing until the first stroke lands.
      const rings = await _buildGrassRingSet("Hybrid", {});
      for (const r of rings) r.setEnabled(false);
      grassRings = rings;
      _grassRingsEnabled = false;
      // Blade shape and uniforms from grassState, which a project load may
      // have changed while the rings were building.
      rebuildHybridGrassGeometries(rings, grassState);
      syncGrassUniforms();
    } catch (err) {
      console.error("[V3 Grass] build failed:", err);
    } finally {
      _grassBuilding = false;
    }
  }

  // Cliff-top grass: a second independent ring set running in cliffMode. It
  // samples grassTerrainData.cliffHeightTex (baked cliff-top Y + normal) and
  // cliffDensityTex (its own paint) instead of the terrain heightmap, so it
  // never fights the terrain layer for a world-XZ texel. Built lazily — the
  // first time a cliff surface is baked or cliff grass is painted.
  async function ensureCliffGrassBuilt() {
    if (cliffGrassRings || _cliffGrassBuilding) return;
    _cliffGrassBuilding = true;
    try {
      // Same LOD ring set as terrain so coverage is seamless — only the sampled
      // surface (cliff height/density) differs. Rings start disabled; the render
      // loop enables them once a cliff surface is baked and cliff grass painted.
      const rings = await _buildGrassRingSet("HybridCliff", {
        cliffMode:       true,
        cliffHeightTex:  grassTerrainData.cliffHeightTex,
        cliffDensityTex: grassTerrainData.cliffDensityTex,
      });
      cliffGrassRings = rings;
      rebuildHybridGrassGeometries(rings, grassState);
      syncGrassUniforms();
    } catch (err) {
      console.error("[V3 Cliff Grass] build failed:", err);
    } finally {
      _cliffGrassBuilding = false;
    }
  }

  // ── The other grass system ────────────────────────────────────────────────
  // Same painted density, same painted blade height, same slope rule, same
  // push field — only the blades are different. Built the first time a world
  // asks for it and kept afterwards, so flipping the dropdown to compare the
  // two costs one build, not one per switch.
  const revoGrassState = createRevoGrassState();
  let _revoGeomKey = null;
  const _revoGeometryKey = () => REVO_GRASS_GEOMETRY_KEYS.map((k) => revoGrassState[k]).join("|");

  async function ensureRevoGrassBuilt() {
    if (revoGrass || _revoBuilding) return;
    _revoBuilding = true;
    try {
      const sys = new RevoGrassSystem({
        scene,
        renderer,
        worldSize:        WORLD_SIZE,
        heightTex:        grassTerrainData.grassHeightTex,
        terrainNormalTex: grassTerrainData.terrainNormalTex,
        densityTex:       grassTerrainData.grassDensityMaskedTex,
        bladeHeightTex:   grassTerrainData.bladeHeightTex,
        waterMapTex:      waterSurfaceMap.texture,   // nothing grows under water
        pushField:        grassPush.field,
        terrainSurface:   terrainSurfaceDesc(),
        terrainShadow:    { shade: terrainShade, visibilityHere: terrainSunVisibilityHere },
        rp:               revoGrassState,
        gp:               grassState,
      });
      await sys.init(camera);
      revoGrass = sys;
      _revoGeomKey = _revoGeometryKey();
      revoGrass.syncFromState(revoGrassState, grassState, getLightDir());
    } catch (err) {
      console.error("[V3 Revo Grass] build failed:", err);
    } finally {
      _revoBuilding = false;
    }
  }

  /** Panel edit: uniforms, or a full rebuild when the blade or the tile changed. */
  function syncRevoGrass() {
    if (!revoGrass) return;
    const key = _revoGeometryKey();
    if (key !== _revoGeomKey) {
      _revoGeomKey = key;
      void revoGrass.rebuild().then(() => {
        revoGrass?.syncFromState(revoGrassState, grassState, getLightDir());
      });
      return;
    }
    revoGrass.syncFromState(revoGrassState, grassState, getLightDir());
  }

  function syncGrassUniforms() {
    // No `if (!worldEnv) return` any more: that skipped the whole grass look
    // (colours, wind, LOD), not just the light, whenever there was no environment.
    const sunDir = getLightDir();
    if (grassRings) for (const r of grassRings) r.syncFromState(grassState, sunDir);
    if (cliffGrassRings) for (const r of cliffGrassRings) r.syncFromState(grassState, sunDir);
    syncGrassLod();
    // The ground takes the grass's colour where the blades thin out. In revo
    // mode that colour is revo's, not the hybrid blades' — same field, other
    // paint pot.
    grassFarShading.syncFromState(grassState.system === "revo"
      ? { ...grassState, bladeColor: revoGrassState.baseColor, tipColor: revoGrassState.tipColor }
      : grassState);
    grassPush.params.recovery = grassState.trailRecovery;
    syncRevoGrass();
    // Susuki shares the grass wind params — keep it in step with every sync.
    syncSusukiUniforms();
    syncFlowerUniforms();
  }

  /** Ring windows + the blade-to-ground hand-off band the terrain fades in over. */
  function syncGrassLod() {
    if (grassState.system === "revo") {
      // Revo has no rings: the blades thin out stochastically, so the ground
      // converges over exactly that band.
      grassFarShading.setBand({ convStart: revoGrassState.fadeStart, convEnd: revoGrassState.fadeEnd });
    } else if (grassRings) {
      grassFarShading.setBand(syncHybridGrassLod(grassRings, grassState));
    }
    if (cliffGrassRings) syncHybridGrassLod(cliffGrassRings, grassState);
  }

  /**
   * The play-mode pawn pushes grass: its body, plus each wheel of a car.
   * Stamps are spaced along the path since last frame so a fast car leaves a
   * continuous trail, not a dotted one (capped, so a teleport cannot flood).
   */
  const _grassPushPrev = new Float32Array(10).fill(NaN); // body + 4 contact slots
  function _stampAlong(slot, x, z, radius, strength) {
    const px = _grassPushPrev[slot * 2], pz = _grassPushPrev[slot * 2 + 1];
    _grassPushPrev[slot * 2] = x; _grassPushPrev[slot * 2 + 1] = z;
    const dist = Number.isNaN(px) ? 0 : Math.hypot(x - px, z - pz);
    // Moving (more than ~1 cm this frame) = push along the way it goes.
    const dx = dist > 0.01 ? x - px : 0, dz = dist > 0.01 ? z - pz : 0;
    const n = Math.min(6, Math.floor(dist / Math.max(0.1, radius * 0.5)));
    for (let i = 1; i <= n; i++) {
      const t = i / (n + 1);
      grassPush.stamp(px + (x - px) * t, pz + (z - pz) * t, radius, strength, dx, dz);
    }
    grassPush.stamp(x, z, radius, strength, dx, dz);
  }
  function _stampPlayerGrass() {
    const stats = playMode.getStats();
    if (!stats.grounded || stats.grounded === "fly") { _grassPushPrev.fill(NaN); return; }
    const pp = playMode.playerPosition;
    const mm = playMode.moveMode;
    const vehicle = mm === "car" || mm === "stunt" || mm === "game";
    _stampAlong(0, pp.x, pp.z, vehicle ? 1.8 : grassState.interactionRadius * 0.7, 1);
    const c = vehicle ? playMode.getSnowContacts?.() : null;
    if (c?.xzs && c.touching) {
      for (let i = 0; i < 4; i++) {
        if (c.touching[i]) _stampAlong(1 + i, c.xzs[i * 2], c.xzs[i * 2 + 1], 0.6, 1);
        else { _grassPushPrev[(1 + i) * 2] = NaN; }
      }
    }
  }

  /**
   * The brush cursor's falloff, per mode — the fill under the ring is the
   * stroke's own curve, so what you see is where the brush is strong.
   */
  function syncCursorFalloff() {
    const f =
      editorMode === "sculpt"     ? sculpt.uFalloff.value :
      editorMode === "paint"      ? paintState.brush.falloff :
      editorMode === "grass"      ? grassBrush.falloff :
      editorMode === "susuki" || editorMode === "flowers"
        || editorMode === "foliage" || editorMode === "vegPlaced" ? vegBrush.falloff :
      editorMode === "ambientFx"  ? ambientBrush.falloff :
      editorMode === "treePaint"  ? (treeToolState.brush.falloff ?? 2) :
      editorMode === "snow"       ? snowBrushState.falloff :
      editorMode === "cliffPaint" ? cliffPaintBrush.falloff : 2;
    uCursorFalloff.value = Math.max(0.05, f);
  }

  /** A ring runs only while grass shows; the Far ring also needs "Far blades". */
  const _ringWanted = (r, want) => want && (grassState.farBlades !== false || !r.group.name.endsWith("Far"));

  /*
   * WHERE THE GRASS TILE SITS.
   *
   * Both grass systems are a fixed instance budget spread over a tile that
   * follows you, so where that tile is centred decides how much of it you can
   * actually see. Centring it on the CAMERA is right only for a camera standing
   * in the field. MEASURED on nam-rts at its default zoom: the camera is 34 m
   * up and 40 m behind the point it looks at, and the ground on screen runs
   * 17-69 m away — so with a 90 m tile the back half held grass behind the
   * camera and the front edge stopped 24 m short of the top of the screen.
   *
   * So the tile slides toward what the camera is LOOKING at. One rule, no "is
   * this an RTS camera" switch: a camera close to its target barely moves,
   * one high above it moves the most, which is exactly when it should. The
   * shift is capped at a fraction of the tile so the tile can never leave the
   * camera behind — including when something parks the orbit target far away.
   *
   * It must stay a fraction well under 1/2: the tile WRAPS at its half-width,
   * and a blade that wraps on screen is a pop. At 0.35 of a 90 m tile the
   * wrap edge sits ~17 m beyond the farthest ground the default zoom can see.
   */
  /*
   * WHAT THE CAMERA CAN SEE, in metres of ground.
   *
   * Grass tile size, blade fade, foliage LOD steps and fade windows are every
   * one of them an answer to the same question — "how far away is the ground I
   * can see" — and every one of them was a constant stored per MAP. Hand-fitted
   * to one zoom, they go stale the moment the camera changes, and they did:
   * ground foliage once had LOD steps at 18 m and 45 m on a camera whose
   * nearest visible ground was 53 m, so no plant ever drew at full detail.
   *
   * Derived here rather than handed in by the game, because the ENGINE owns
   * the camera and the editor's orbit camera deserves the same answer as a
   * game's. The pitch comes from where the camera is actually looking, so this
   * works for an orbit camera, an RTS camera and a walking one alike, with no
   * mode to keep in sync.
   *
   * Flat ground at the focus height is a deliberate approximation: real
   * terrain rises and falls, but a raycast against a moving hillside gives a
   * number that jitters frame to frame, and an LOD distance wants stability
   * far more than it wants the exact metre.
   */
  const _viewFwd = new THREE.Vector3();
  const _viewBand = { near: 0, far: 0 };
  function viewGroundBand() {
    const target = controls?.target;
    const h = Math.max(camera.position.y - (target ? target.y : 0), 0.01);
    _viewFwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
    // Angle below the horizon of the view centre, and half the vertical FOV.
    const pitch = Math.asin(THREE.MathUtils.clamp(-_viewFwd.y, -1, 1));
    const halfFov = THREE.MathUtils.degToRad(camera.fov ?? 60) * 0.5;
    const reach = (a) => (a > 1e-3 ? h / Math.tan(a) : Infinity);
    _viewBand.near = Math.min(reach(pitch + halfFov), camera.far);
    _viewBand.far = Math.min(reach(pitch - halfFov), camera.far);
    // Looking level or up, the top of the frustum never meets the ground and
    // `far` is the far plane — useless as an LOD distance. Fall back to a
    // multiple of the near edge, which is the only real scale we have.
    if (!(_viewBand.far > _viewBand.near)) _viewBand.far = _viewBand.near * 4;
    return _viewBand;
  }

  const _grassAnchorV = new THREE.Vector3();
  const GRASS_ANCHOR_LEAD = 0.35;   // of tileSize, toward the look-at point
  function grassViewAnchor(tileSize) {
    if (playMode.active) return playMode.playerPosition;
    const t = controls?.target;
    if (!t) return camera.position;
    let dx = t.x - camera.position.x;
    let dz = t.z - camera.position.z;
    const d = Math.hypot(dx, dz);
    _grassAnchorV.copy(camera.position);
    if (d > 1e-3) {
      const lead = Math.min(d, GRASS_ANCHOR_LEAD * (tileSize || 90));
      _grassAnchorV.x += (dx / d) * lead;
      _grassAnchorV.z += (dz / d) * lead;
      _grassAnchorV.y = t.y;
    }
    return _grassAnchorV;
  }

  // ── Susuki build/sync (lazy, like the grass rings) ─────────────────────────
  async function ensureSusukiBuilt() {
    if (susukiSystem || _susukiBuilding) return;
    _susukiBuilding = true;
    try {
      const sys = new FoliageScatterSystem({
        scene,
        renderer,
        name:             "Tall plants",
        typeCount:        TALL_PLANT_COUNT,
        // A cane is tall and thin: you can stand closer before it fills the view.
        nearFade:         0.7,
        tileSize:         SUSUKI_FIELD.tileSize,
        plantsPerSide:    SUSUKI_FIELD.plantsPerSide,
        heightTex:        grassTerrainData.grassHeightTex,
        terrainNormalTex: grassTerrainData.terrainNormalTex,
        densityTex:       grassTerrainData.susukiDensityMaskedTex,
        grassDensityTex:  grassTerrainData.grassDensityMaskedTex,
        splatTex:         splatMap.tex,
        riverNearTex:     riverV2System?.nearTexture ?? null,
        waterMapTex:      waterSurfaceMap.texture,   // nothing grows under water
        windTex:          grassWindTex,
        worldSize:        WORLD_SIZE,
        terrainSurface:   terrainSurfaceDesc(),
        fs:               susukiState,
        gp:               grassState,
      });
      await sys.init(camera);
      sys.setEnabled(true);
      susukiSystem = sys;
      syncSusukiUniforms();
    } catch (err) {
      console.error("[V3 Susuki] build failed:", err);
    } finally {
      _susukiBuilding = false;
    }
  }

  function syncSusukiUniforms() {
    if (!susukiSystem) return;
    susukiSystem.syncFromState(susukiState, grassState, getLightDir(), {
      hasRivers: (riverV2System?.rivers.length ?? 0) > 0,
    });
  }

  // ── Flower build/sync (lazy, like susuki) ──────────────────────────────────
  async function ensureFlowersBuilt() {
    if (flowerSystem || _flowerBuilding) return;
    _flowerBuilding = true;
    try {
      const sys = new FlowerSystem({
        scene,
        renderer,
        heightTex:        grassTerrainData.grassHeightTex,
        terrainNormalTex: grassTerrainData.terrainNormalTex,
        densityTex:       flowerDensity.maskedTex,
        grassDensityTex:  grassTerrainData.grassDensityMaskedTex,
        splatTex:         splatMap.tex,
        riverNearTex:     riverV2System?.nearTexture ?? null,
        waterMapTex:      waterSurfaceMap.texture,   // nothing grows under water
        windTex:          grassWindTex,
        worldSize:        WORLD_SIZE,
        fp:               flowerState,
        gp:               grassState,
      });
      await sys.init(camera);
      sys.setEnabled(true);
      flowerSystem = sys;
      syncFlowerUniforms();
    } catch (err) {
      console.error("[V3 Flowers] build failed:", err);
    } finally {
      _flowerBuilding = false;
    }
  }

  function syncFlowerUniforms() {
    const opts = { hasRivers: (riverV2System?.rivers.length ?? 0) > 0 };
    flowerTintShading.syncFromState(flowerState, opts);
    flowerSystem?.syncFromState(flowerState, grassState, getLightDir(), opts);
  }

  /**
   * The cascade cameras a painted plant within `distance` m can land in: every
   * cascade whose near edge is closer than that. Empty with CSM off — the
   * shadow lists are a CSM feature, like the per-cascade prop lists.
   */
  const _scatterShadowCams = [];
  function scatterShadowCameras(distance) {
    _scatterShadowCams.length = 0;
    if (!(distance > 0)) return _scatterShadowCams;
    const csm = worldToolState.csm.enabled ? worldEnv?.getCsm?.() : null;
    const lights = csm?.lights;
    // Cascades OFF: one fitted shadow camera renders everything, so the
    // scatter fields' shadow lists go to it. Without this they went to NO
    // camera at all and every painted plant stopped casting — invisible as a
    // bug, because it just looks like the lighting got flatter.
    if (!lights?.length) {
      const sunCam = worldEnv?.getSunShadowCamera?.();
      if (sunCam) _scatterShadowCams.push(sunCam);
      return _scatterShadowCams;
    }
    const far = Math.min(camera.far, csm.maxFar);
    for (let i = 0; i < lights.length; i++) {
      const nearEdge = (i === 0 ? 0 : csm.breaks[i - 1] ?? 1) * far;
      const cam = lights[i].shadow?.camera;
      if (cam && nearEdge < distance) _scatterShadowCams.push(cam);
    }
    return _scatterShadowCams;
  }

  // ── Painted foliage build/sync (lazy, on the same scatter core) ────────────
  async function ensureFoliageScatterBuilt() {
    if (foliageScatter || _foliageScatterBuilding) return;
    _foliageScatterBuilding = true;
    try {
      const sys = new FoliageScatterSystem({
        scene,
        renderer,
        heightTex:        grassTerrainData.grassHeightTex,
        terrainNormalTex: grassTerrainData.terrainNormalTex,
        densityTex:       foliageDensity.maskedTexes,
        grassDensityTex:  grassTerrainData.grassDensityMaskedTex,
        splatTex:         splatMap.tex,
        riverNearTex:     riverV2System?.nearTexture ?? null,
        waterMapTex:      waterSurfaceMap.texture,   // nothing grows under water
        windTex:          grassWindTex,
        worldSize:        WORLD_SIZE,
        terrainSurface:   terrainSurfaceDesc(),
        tileSize:         FOLIAGE_FIELD.tileSize,
        plantsPerSide:    FOLIAGE_FIELD.plantsPerSide,
        fs:               foliageScatterState,
        gp:               grassState,
      });
      await sys.init(camera);
      sys.setEnabled(true);
      foliageScatter = sys;
      syncFoliageScatterUniforms();
    } catch (err) {
      console.error("[V3 Foliage] build failed:", err);
    } finally {
      _foliageScatterBuilding = false;
    }
  }

  function syncFoliageScatterUniforms() {
    foliageScatter?.syncFromState(foliageScatterState, grassState, getLightDir(), {
      hasRivers: (riverV2System?.rivers.length ?? 0) > 0,
    });
  }

  // ── Ambient FX (butterflies, falling leaves) — one compute, one draw ──────
  const ambientFxState = createAmbientFxState();
  let ambientFx = null;
  let _ambientFxBuilding = false;
  let _ambientFxSelected = 0;

  /**
   * Where each effect is painted — one RGBA page, one effect per channel.
   *
   * The RAW texture, not a masked copy. Grass and foliage read a copy with
   * every "Blocks grass" layer and every terrain hole cut out of it, because
   * a plant cannot grow on a path. A butterfly flies over the path. Skipping
   * the mask also skips its bake.
   */
  const ambientDensity = new ScatterDensity({ res: 1024, channels: AMBIENT_EFFECT_COUNT });
  /** Its own brush, deliberately NOT the shared vegetation one: an Alt-erase
   *  that clears every kind of plant must not also wipe the butterflies. */
  const ambientBrush = { radius: 22, strength: 0.7, falloff: 1.5, erase: false, eraseOnlyType: true };
  let _ambientPainting = false;
  const AMBIENT_UNDO_LIMIT = 12;
  const _ambientUndoStack = [];
  const _ambientRedoStack = [];

  async function ensureAmbientFxBuilt() {
    if (ambientFx || _ambientFxBuilding) return;
    _ambientFxBuilding = true;
    try {
      const sys = new AmbientFxSystem({
        scene,
        renderer,
        heightTex:        grassTerrainData.grassHeightTex,
        terrainNormalTex: grassTerrainData.terrainNormalTex,
        windTex:          grassWindTex,
        densityTex:       ambientDensity.tex,
        worldSize:        WORLD_SIZE,
        fx:               ambientFxState,
      });
      await sys.init(camera);
      sys.setEnabled(true);
      ambientFx = sys;
      syncAmbientFxUniforms();
    } catch (err) {
      console.error("[V3 Ambient FX] build failed:", err);
    } finally {
      _ambientFxBuilding = false;
    }
  }

  function syncAmbientFxUniforms() {
    ambientFx?.syncFromState(ambientFxState, grassState, getLightDir());
  }

  // ── UI wiring ──────────────────────────────────────────────────────────────
  const btnRaise  = uiById("btn-raise");
  const btnLower  = uiById("btn-lower");
  const btnSmooth  = uiById("btn-smooth");
  const btnFlatten = uiById("btn-flatten");
  const btnNoise   = uiById("btn-noise");
  const btnTerrace = uiById("btn-terrace");
  const slSpacing       = uiById("sl-spacing");
  const lblSpacing      = uiById("lbl-spacing");
  const slClampMin  = uiById("sl-clamp-min");
  const lblClampMin = uiById("lbl-clamp-min");
  const slClampMax  = uiById("sl-clamp-max");
  const lblClampMax = uiById("lbl-clamp-max");
  const subRaiseLower   = uiById("sub-raiselower");
  const subTerrace      = uiById("sub-terrace");
  const subFlatten      = uiById("sub-flatten");
  const subNoise        = uiById("sub-noise");
  const subErode        = uiById("sub-erode");
  const subHydro        = uiById("sub-hydro");
  const subRamp         = uiById("sub-ramp");
  const subMirror       = uiById("sub-mirror");
  const subRegion       = uiById("sub-region");
  const subClone        = uiById("sub-clone");
  const btnErode        = uiById("btn-erode");
  const btnHydro        = uiById("btn-hydro");
  const btnRamp         = uiById("btn-ramp");
  const btnMirror       = uiById("btn-mirror");
  const btnRegion       = uiById("btn-region");
  const btnClone        = uiById("btn-clone");
  const btnSmudge       = uiById("btn-smudge");
  const btnContrast     = uiById("btn-contrast");
  const slNoiseOct      = uiById("sl-noise-oct");
  const lblNoiseOct     = uiById("lbl-noise-oct");
  const slThermalSlope  = uiById("sl-thermal-slope");
  const lblThermalSlope = uiById("lbl-thermal-slope");
  const slThermalIter   = uiById("sl-thermal-iter");
  const lblThermalIter  = uiById("lbl-thermal-iter");
  const slHydroStrength = uiById("sl-hydro-strength");
  const lblHydroStrength = uiById("lbl-hydro-strength");
  const slHydroWater    = uiById("sl-hydro-water");
  const lblHydroWater   = uiById("lbl-hydro-water");
  const slHydroIter     = uiById("sl-hydro-iter");
  const lblHydroIter    = uiById("lbl-hydro-iter");
  const slRampWidth     = uiById("sl-ramp-width");
  const lblRampWidth    = uiById("lbl-ramp-width");
  const rampHint        = uiById("ramp-hint");
  const btnStampSmooth  = uiById("btn-stamp-smooth");
  const btnStampPlateau = uiById("btn-stamp-plateau");
  const btnStampCrater  = uiById("btn-stamp-crater");
  const slTerraceStep   = uiById("sl-terrace-step");
  const lblTerraceStep  = uiById("lbl-terrace-step");
  const slTerraceSharp  = uiById("sl-terrace-sharp");
  const lblTerraceSharp = uiById("lbl-terrace-sharp");
  const slNoiseScale    = uiById("sl-noise-scale");
  const lblNoiseScale   = uiById("lbl-noise-scale");
  const tbHelp          = uiById("tb-help");
  const tbModeButtons   = uiQueryAll("#tb-modes .toolbar-btn");
  const tbPlay          = uiById("tb-play");
  const toolsModeSelect = uiById("tools-mode-select");
  const viewNavHint     = uiById("view-nav-hint");
  const tbSave    = uiById("tb-save");
  const tbLoad    = uiById("tb-load");
  const tbUndo    = uiById("tb-undo");
  const tbRedo    = uiById("tb-redo");
  const playHint  = uiById("play-hint");
  const helpOverlay = uiById("help-overlay");
  const slSize    = uiById("sl-size");
  const lblSize   = uiById("lbl-size");
  const slStr     = uiById("sl-str");
  const lblStr    = uiById("lbl-str");
  const slFalloff  = uiById("sl-falloff");
  const lblFalloff = uiById("lbl-falloff");

  const genMode       = uiById("gen-mode");
  const genSeed       = uiById("gen-seed");
  const genScale      = uiById("gen-scale");
  const lblGenScale   = uiById("lbl-gen-scale");
  const genHeight     = uiById("gen-height");
  const lblGenHeight  = uiById("lbl-gen-height");
  const genOctaves    = uiById("gen-octaves");
  const lblGenOctaves = uiById("lbl-gen-octaves");
  const genWarp       = uiById("gen-warp");
  const lblGenWarp    = uiById("lbl-gen-warp");
  const genShape      = uiById("gen-shape");
  const genDropoff    = uiById("gen-dropoff");
  const lblGenDropoff = uiById("lbl-gen-dropoff");
  const genPlains     = uiById("gen-plains");
  const lblGenPlains  = uiById("lbl-gen-plains");
  const genOffsetX    = uiById("gen-offsetX");
  const lblGenOffsetX = uiById("lbl-gen-offsetX");
  const genOffsetZ    = uiById("gen-offsetZ");
  const lblGenOffsetZ = uiById("lbl-gen-offsetZ");
  const btnGenerate   = uiById("btn-generate");
  const btnRandomSeed = uiById("btn-random-seed");

  // ── Paint panel DOM refs ───────────────────────────────────────────────────
  const layerCardGrid  = uiById("layer-card-grid");
  const pslRadius      = uiById("psl-radius");
  const plblRadius     = uiById("plbl-radius");
  const pslStrength    = uiById("psl-strength");
  const plblStrength   = uiById("plbl-strength");
  const pslFalloff     = uiById("psl-falloff");
  const plblFalloff    = uiById("plbl-falloff");
  const pslSpacing     = uiById("psl-spacing");
  const plblSpacing    = uiById("plbl-spacing");
  const pslOpacity     = uiById("psl-opacity");
  const plblOpacity    = uiById("plbl-opacity");
  const pslTarget      = uiById("psl-target");
  const plblTarget     = uiById("plbl-target");
  const pslSolo        = uiById("psl-solo");
  const pslHBlend      = uiById("psl-hblend");
  const plblHBlend     = uiById("plbl-hblend");
  const pslHContrast   = uiById("psl-hcontrast");
  const plblHContrast  = uiById("plbl-hcontrast");
  const pslMacroStr    = uiById("psl-macro-str");
  const plblMacroStr   = uiById("plbl-macro-str");
  const pslMacroWarm   = uiById("psl-macro-warm");
  const plblMacroWarm  = uiById("plbl-macro-warm");
  const pslMacroScale  = uiById("psl-macro-scale");
  const plblMacroScale = uiById("plbl-macro-scale");
  const pslNoise       = uiById("psl-noise");
  const plblNoise      = uiById("plbl-noise");
  const pslNScale      = uiById("psl-nscale");
  const plblNScale     = uiById("plbl-nscale");
  const pslNOct        = uiById("psl-noct");
  const plblNOct       = uiById("plbl-noct");
  const pckNEdge       = uiById("pck-nedge");
  const pmaskPreview   = uiById("pmask-preview");
  const pmaskChips     = uiById("pmask-chips");
  const pbtnMaskPng    = uiById("pbtn-mask-png");
  const pslMaskRot     = uiById("psl-maskrot");
  const plblMaskRot    = uiById("plbl-maskrot");
  const pckMaskRand    = uiById("pck-maskrand");
  const pckMaskFollow  = uiById("pck-maskfollow");
  const texlibTabsEl   = uiById("texlib-tabs");
  const texlibNameEl   = uiById("texlib-name");
  const pbtnFill          = uiById("pbtn-fill");
  const pbtnClear         = uiById("pbtn-clear");
  const pbtnSaveSplat     = uiById("pbtn-save-splat");
  const pbtnLoadSplat     = uiById("pbtn-load-splat");
  const aptEnabled      = uiById("apt-enabled");
  const aptFlat         = uiById("apt-flat");
  const aptCliff        = uiById("apt-cliff");
  const aptHigh         = uiById("apt-high");
  const aptSlopeStart   = uiById("apt-slope-start");
  const aptSlopeEnd     = uiById("apt-slope-end");
  const aptHighStart    = uiById("apt-high-start");
  const aptHighEnd      = uiById("apt-high-end");
  const aptNoise        = uiById("apt-noise");
  const aptPreview      = uiById("apt-preview");
  const aptBake         = uiById("apt-bake");

  // ── Paint state + system ───────────────────────────────────────────────────
  const paintState = {
    activeLayer: 1,
    brushOpacity: 1.0,
    /** Ceiling on the weight a stroke can give its layer (0..1). See splatMap.js. */
    targetStrength: 1.0,
    brush: { radius: 80, strength: 0.50, falloff: 2.0, spacingFactor: 0.10 },
    noiseMask: 0.0, noiseScale: 3.0, noiseOctaves: 3, noiseEdgeOnly: false,
    maskRotation: 0, maskRandomRotation: false, maskFollowStroke: false,
    // Height / slope band for the paint brush. Separate from sculpt's on
    // purpose — see brushFilterSection.js.
    filter: createBrushFilterState(MAX_HEIGHT),
  };
  const paintBrushMask = new BrushMask();
  paintBrushMask.generateBuiltin("soft");
  const paintSys = new PaintSystem({
    paintState,
    splatMap,
    brushMask: paintBrushMask,
    // Getter, not a value: cpuHeightmap is declared further down this function,
    // and reading it here would hit the temporal dead zone. It is only read at
    // stamp time, long after it exists.
    heightSource: {
      get data() { return cpuHeightmap; },
      size: HEIGHTMAP_SIZE,
      worldSize: WORLD_SIZE,
      maxHeight: MAX_HEIGHT,
    },
  });

  // ── Brush filters (height / slope band), one per mode ─────────────────────
  // Mounted right after each panel's Brush section; the section header shows
  // the active band even while collapsed.
  const sculptFilterState = createBrushFilterState(MAX_HEIGHT);
  {
    // Anchor BEFORE the Sculpt tools section. The Brush section used to have an
    // unclosed <div> that nested every later section inside it, which made
    // "after Brush" land at the bottom of the panel; that markup is fixed now,
    // but anchoring on the tools section is correct either way.
    const sculptToolsSec = uiById("btn-raise")?.closest(".inspector-section");
    const sculptBrushSec = uiQuery("#sculpt-panel > .inspector-section");
    if (sculptToolsSec || sculptBrushSec) {
      buildBrushFilterSection({
        anchorEl: sculptToolsSec ?? sculptBrushSec,
        where: sculptToolsSec ? "beforebegin" : "afterend",
        state: sculptFilterState,
        maxHeight: MAX_HEIGHT,
        onChange: () => sculpt.setFilter(sculptFilterState),
      });
    }
    sculpt.setFilter(sculptFilterState);
    const paintBrushSec = uiQuery("#paint-panel > .inspector-section");
    if (paintBrushSec) {
      buildBrushFilterSection({
        anchorEl: paintBrushSec,
        state: paintState.filter,
        maxHeight: MAX_HEIGHT,
      });
    }
  }
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
    btnHydro  .classList.toggle("active", m === "hydro");
    btnRamp   .classList.toggle("active", m === "ramp");
    btnSmudge .classList.toggle("active", m === "smudge");
    btnContrast.classList.toggle("active", m === "contrast");
    btnMirror?.classList.toggle("active", m === "mirror");
    btnRegion?.classList.toggle("active", m === "region");
    btnClone?.classList.toggle("active", m === "clone");
    // Tool options always track stickyMode so modifier-key overrides don't hide the zone.
    subRaiseLower.style.display = (stickyMode === "raise" || stickyMode === "lower") ? "" : "none";
    subTerrace   .style.display = stickyMode === "terrace" ? "" : "none";
    if (subFlatten) subFlatten.style.display = stickyMode === "flatten" ? "" : "none";
    if (stickyMode !== "flatten" && _pickingHeight) setPickingHeight(false);
    subNoise     .style.display = stickyMode === "noise"   ? "" : "none";
    subErode     .style.display = stickyMode === "erode"   ? "" : "none";
    subHydro     .style.display = stickyMode === "hydro"   ? "" : "none";
    subRamp      .style.display = stickyMode === "ramp"    ? "" : "none";
    if (subMirror) subMirror.style.display = stickyMode === "mirror" ? "" : "none";
    if (subRegion) subRegion.style.display = stickyMode === "region" ? "" : "none";
    if (stickyMode !== "region") _regionHideSafe();
    if (subClone) subClone.style.display = stickyMode === "clone" ? "" : "none";
    if (stickyMode !== "clone") _cloneHideSafe();
  }

  btnRaise  .addEventListener("click", () => { stickyMode = "raise";   refreshModeIndicator(); });
  btnLower  .addEventListener("click", () => { stickyMode = "lower";   refreshModeIndicator(); });
  btnSmooth .addEventListener("click", () => { stickyMode = "smooth";  refreshModeIndicator(); });
  btnFlatten.addEventListener("click", () => { stickyMode = "flatten"; refreshModeIndicator(); });
  btnNoise  .addEventListener("click", () => { stickyMode = "noise";   refreshModeIndicator(); });
  btnTerrace.addEventListener("click", () => { stickyMode = "terrace"; refreshModeIndicator(); });
  btnErode   .addEventListener("click", () => { stickyMode = "erode";    refreshModeIndicator(); });
  btnHydro   .addEventListener("click", () => { stickyMode = "hydro";    refreshModeIndicator(); });
  btnSmudge  .addEventListener("click", () => { stickyMode = "smudge";   refreshModeIndicator(); });
  btnContrast.addEventListener("click", () => { stickyMode = "contrast"; refreshModeIndicator(); });
  // -- Mirror (whole-map symmetry, AUDIT 13) ---------------------------------
  // Not a brush: it has no stroke. Pick a symmetry and a half, press Apply.
  // Heights (GPU, sculptBrush.mirror) and ground paint (CPU, splatMap
  // .mirrorPaint) follow the same conventions and undo as ONE step.
  const mirrorState = { mode: "x", keep: "low", blendM: 0, paint: true };
  const slMirrorBlend  = uiById("sl-mirror-blend");
  const lblMirrorBlend = uiById("lbl-mirror-blend");
  const ckMirrorPaint  = uiById("ck-mirror-paint");
  const mirrorKeepLow  = uiById("mirror-keep-low");
  const mirrorKeepHigh = uiById("mirror-keep-high");
  function syncMirrorUi() {
    for (const b of document.querySelectorAll("[data-mirror-mode]")) b.classList.toggle("active", b.dataset.mirrorMode === mirrorState.mode);
    for (const b of document.querySelectorAll("[data-mirror-keep]")) b.classList.toggle("active", b.dataset.mirrorKeep === mirrorState.keep);
    const axis = mirrorState.mode === "z" ? "Z" : "X";
    if (mirrorKeepLow) mirrorKeepLow.textContent = `-${axis} half`;
    if (mirrorKeepHigh) mirrorKeepHigh.textContent = `+${axis} half`;
    ckMirrorPaint?.classList.toggle("checked", mirrorState.paint);
    if (slMirrorBlend) slMirrorBlend.value = String(mirrorState.blendM);
    if (lblMirrorBlend) lblMirrorBlend.textContent = `${mirrorState.blendM}m`;
  }
  uiById("mirror-mode-chips")?.addEventListener("click", (e) => {
    const b = e.target.closest("[data-mirror-mode]");
    if (!b) return;
    mirrorState.mode = b.dataset.mirrorMode;
    // A half-turn never meets itself at the centre line; start it with a seam.
    if (mirrorState.mode === "rotate" && mirrorState.blendM === 0) mirrorState.blendM = 30;
    syncMirrorUi();
  });
  uiById("mirror-keep-chips")?.addEventListener("click", (e) => {
    const b = e.target.closest("[data-mirror-keep]");
    if (!b) return;
    mirrorState.keep = b.dataset.mirrorKeep;
    syncMirrorUi();
  });
  slMirrorBlend?.addEventListener("input", () => {
    mirrorState.blendM = Number(slMirrorBlend.value);
    syncMirrorUi();
  });
  ckMirrorPaint?.addEventListener("click", () => { mirrorState.paint = !mirrorState.paint; syncMirrorUi(); });
  function applyTerrainMirror(opts = mirrorState) {
    const o = { mode: opts.mode, keep: opts.keep, blendM: opts.blendM };
    sculpt.mirror(o);
    if (opts.paint) {
      const { before } = splatMap.mirrorPaint(o);
      sculpt.attachToStroke({
        undo: () => splatMap.pasteRect(before),
        redo: () => { splatMap.mirrorPaint(o); },
      });
    }
    sculpt.endStroke();
    onHistoryChange();
  }
  uiById("btn-mirror-apply")?.addEventListener("click", () => applyTerrainMirror());

  // setMode() and setEditorMode() run during boot, long before the outline
  // below exists; a `const` touched that early throws (temporal dead zone).
  // `var` is hoisted as undefined, so this guard is safe from anywhere.
  var _regionOutlineReady;
  function _regionHideSafe() {
    if (_regionOutlineReady) regionOutline.visible = false;
  }

  // -- Region copy-paste (AUDIT 13, slice 2) -------------------------------
  // Drag a rectangle to copy it (heights into a clipboard RT, paint into a CPU
  // patch); then every click pastes it under the cursor, turned, flipped,
  // lifted and feathered. The clipboard survives a project load, so a piece of
  // one world can be pasted into another.
  const regionState = {
    clip: null,              // { heights: {rt, rect}, paint: patch|null, worldW, worldH, borderMean }
    dragStart: null,         // world {x, z} while dragging a selection
    angleDeg: 0, flipX: false, flipZ: false,
    heightMode: "match", offsetM: 0, featherM: 12, paint: true,
  };
  const regionStatus    = uiById("region-status");
  const slRegionRot     = uiById("sl-region-rot");
  const lblRegionRot    = uiById("lbl-region-rot");
  const slRegionOffset  = uiById("sl-region-offset");
  const lblRegionOffset = uiById("lbl-region-offset");
  const slRegionFeather = uiById("sl-region-feather");
  const lblRegionFeather= uiById("lbl-region-feather");
  function syncRegionUi() {
    const rs = regionState;
    if (slRegionRot) slRegionRot.value = String(rs.angleDeg);
    if (lblRegionRot) lblRegionRot.textContent = `${rs.angleDeg}`;
    uiById("ck-region-flipx")?.classList.toggle("checked", rs.flipX);
    uiById("ck-region-flipz")?.classList.toggle("checked", rs.flipZ);
    uiById("ck-region-paint")?.classList.toggle("checked", rs.paint);
    for (const b of document.querySelectorAll("[data-region-height]")) b.classList.toggle("active", b.dataset.regionHeight === rs.heightMode);
    if (slRegionOffset) slRegionOffset.value = String(rs.offsetM);
    if (lblRegionOffset) lblRegionOffset.textContent = `${rs.offsetM}m`;
    if (slRegionFeather) slRegionFeather.value = String(rs.featherM);
    if (lblRegionFeather) lblRegionFeather.textContent = `${rs.featherM}m`;
    if (regionStatus) {
      regionStatus.textContent = rs.clip
        ? `Copied ${Math.round(rs.clip.worldW)} x ${Math.round(rs.clip.worldH)} m. Click to paste.`
        : "Drag a rectangle on the terrain to copy it.";
    }
  }
  slRegionRot?.addEventListener("input", () => { regionState.angleDeg = Number(slRegionRot.value); syncRegionUi(); regionRefreshOutline(); });
  uiById("btn-region-rot-l")?.addEventListener("click", () => { regionState.angleDeg = (regionState.angleDeg + 270) % 360; syncRegionUi(); regionRefreshOutline(); });
  uiById("btn-region-rot-r")?.addEventListener("click", () => { regionState.angleDeg = (regionState.angleDeg + 90) % 360; syncRegionUi(); regionRefreshOutline(); });
  uiById("ck-region-flipx")?.addEventListener("click", () => { regionState.flipX = !regionState.flipX; syncRegionUi(); });
  uiById("ck-region-flipz")?.addEventListener("click", () => { regionState.flipZ = !regionState.flipZ; syncRegionUi(); });
  uiById("ck-region-paint")?.addEventListener("click", () => { regionState.paint = !regionState.paint; syncRegionUi(); });
  uiById("region-height-chips")?.addEventListener("click", (e) => {
    const b = e.target.closest("[data-region-height]");
    if (!b) return;
    regionState.heightMode = b.dataset.regionHeight;
    syncRegionUi();
  });
  slRegionOffset?.addEventListener("input", () => { regionState.offsetM = Number(slRegionOffset.value); syncRegionUi(); });
  slRegionFeather?.addEventListener("input", () => { regionState.featherM = Number(slRegionFeather.value); syncRegionUi(); });
  function regionClearClip() {
    regionState.clip?.heights?.rt?.dispose();
    regionState.clip = null;
    regionState.dragStart = null;
    regionHideOutline();
    syncRegionUi();
  }
  uiById("btn-region-new")?.addEventListener("click", regionClearClip);

  // -- Clone brush (AUDIT 13, slice 3) --------------------------------------
  // Alt+click picks a source; painting copies from brush + offset. Heights come
  // from the pre-stroke map on the GPU (sculptBrush.clone), paint from the
  // pre-stroke paint on the CPU (splatMap.cloneStamp), so overlapping source
  // and destination never smear. Aligned keeps the offset between strokes.
  var _cloneRingReady;
  function _cloneHideSafe() {
    if (_cloneRingReady) cloneRing.visible = false;
  }
  const cloneState = {
    source: null,            // world {x, z}
    offset: null,            // world {x, z} from brush to source, fixed once aligned
    aligned: true, heightMode: "match", opacity: 0.6, paint: true,
    strokeOffset: null, strokeHeightNorm: 0, paintOpen: false,
  };
  const cloneStatus      = uiById("clone-status");
  const slCloneOpacity   = uiById("sl-clone-opacity");
  const lblCloneOpacity  = uiById("lbl-clone-opacity");
  function syncCloneUi() {
    const cs = cloneState;
    uiById("ck-clone-aligned")?.classList.toggle("checked", cs.aligned);
    uiById("ck-clone-paint")?.classList.toggle("checked", cs.paint);
    for (const b of document.querySelectorAll("[data-clone-height]")) b.classList.toggle("active", b.dataset.cloneHeight === cs.heightMode);
    if (slCloneOpacity) slCloneOpacity.value = String(Math.round(cs.opacity * 100));
    if (lblCloneOpacity) lblCloneOpacity.textContent = `${Math.round(cs.opacity * 100)}%`;
    if (cloneStatus) {
      cloneStatus.textContent = cs.source
        ? `Source at ${Math.round(cs.source.x)}, ${Math.round(cs.source.z)}. Paint to clone; Alt+click to move it.`
        : "Alt+click the terrain to pick a source.";
    }
  }
  uiById("ck-clone-aligned")?.addEventListener("click", () => { cloneState.aligned = !cloneState.aligned; cloneState.offset = null; syncCloneUi(); });
  uiById("ck-clone-paint")?.addEventListener("click", () => { cloneState.paint = !cloneState.paint; syncCloneUi(); });
  uiById("clone-height-chips")?.addEventListener("click", (e) => {
    const b = e.target.closest("[data-clone-height]");
    if (!b) return;
    cloneState.heightMode = b.dataset.cloneHeight;
    syncCloneUi();
  });
  slCloneOpacity?.addEventListener("input", () => { cloneState.opacity = Number(slCloneOpacity.value) / 100; syncCloneUi(); });
  btnClone?.addEventListener("click", () => { stickyMode = "clone"; syncCloneUi(); refreshModeIndicator(); });

  /** Alt+click: the new source. A new source restarts the alignment. */
  function cloneSetSource(hit) {
    cloneState.source = { x: (hit.u - 0.5) * WORLD_SIZE, z: (hit.v - 0.5) * WORLD_SIZE };
    cloneState.offset = null;
    syncCloneUi();
    cloneRefreshRing(hit);
  }
  /** Mouse down: fix this stroke's offset and height lift, open the paint half. */
  function cloneBeginStroke(hit) {
    const cs = cloneState;
    if (!cs.source) return false;
    const x = (hit.u - 0.5) * WORLD_SIZE, z = (hit.v - 0.5) * WORLD_SIZE;
    const offset = cs.aligned && cs.offset ? cs.offset : { x: cs.source.x - x, z: cs.source.z - z };
    if (cs.aligned) cs.offset = offset;
    cs.strokeOffset = offset;
    cs.strokeHeightNorm = cs.heightMode === "match"
      ? (_groundAt(x, z) - _groundAt(x + offset.x, z + offset.z)) / MAX_HEIGHT
      : 0;
    if (cs.paint) { splatMap.beginClone(); cs.paintOpen = true; }
    return true;
  }
  function cloneStampAt(u, v) {
    const cs = cloneState;
    if (!cs.strokeOffset) return;
    sculpt.clone(u, v, {
      offsetUV: { u: cs.strokeOffset.x / WORLD_SIZE, v: cs.strokeOffset.z / WORLD_SIZE },
      opacity: cs.opacity,
      heightOffsetNorm: cs.strokeHeightNorm,
    });
    if (cs.paintOpen) {
      splatMap.cloneStamp({
        cx: (u - 0.5) * WORLD_SIZE, cz: (v - 0.5) * WORLD_SIZE,
        radius: sculpt.uRadius.value * WORLD_SIZE, falloff: sculpt.uFalloff.value,
        opacity: cs.opacity, offsetX: cs.strokeOffset.x, offsetZ: cs.strokeOffset.z,
      });
    }
  }
  /** Before the sculpt stroke closes: tie the paint change to its undo step. */
  function cloneClosePaint() {
    const cs = cloneState;
    cs.strokeOffset = null;
    if (!cs.paintOpen) return;
    cs.paintOpen = false;
    const res = splatMap.endClone();
    if (res) {
      sculpt.attachToStroke({
        undo: () => splatMap.pasteRect(res.before),
        redo: () => splatMap.pasteRect(res.after),
      });
    }
  }
  btnRegion?.addEventListener("click", () => { stickyMode = "region"; syncRegionUi(); refreshModeIndicator(); });
  btnMirror?.addEventListener("click", () => { stickyMode = "mirror"; syncMirrorUi(); refreshModeIndicator(); });

  btnRamp   .addEventListener("click", () => {
    stickyMode = "ramp";
    rampState = "idle";
    rampHint.textContent = "Click start point...";
    refreshModeIndicator();
  });

  // ── Set Height: fixed target + eyedropper ─────────────────────────────────
  // Flatten used to have exactly one behaviour: capture the height under the
  // cursor when the stroke starts. That is still the default. "Fixed height"
  // flattens to a typed value instead, and Pick copies a value off the terrain
  // with one click, without sculpting — Unity's Set Height / Unreal's flatten
  // target. Applies to Alt+drag flatten too, since that shares the same stamp.
  const flattenState = { fixed: false, heightM: 0 };
  const ckFlattenFixed    = uiById("ck-flatten-fixed");
  const numFlattenHeight  = uiById("num-flatten-height");
  const btnFlattenPick    = uiById("btn-flatten-pick");
  // Declared with var-like hoisting in mind: setMode() (defined above) reads it,
  // but only runs from events, long after this line.
  var _pickingHeight = false;
  function setPickingHeight(on) {
    _pickingHeight = !!on;
    btnFlattenPick?.classList.toggle("primary", _pickingHeight);
    if (btnFlattenPick) btnFlattenPick.textContent = _pickingHeight ? "Click ground…" : "Pick";
    renderer.domElement.style.cursor = _pickingHeight ? "crosshair" : "";
  }
  const setFlattenFixed = (on) => {
    flattenState.fixed = !!on;
    ckFlattenFixed?.classList.toggle("checked", flattenState.fixed);
  };
  ckFlattenFixed?.addEventListener("click", () => setFlattenFixed(!flattenState.fixed));
  numFlattenHeight?.addEventListener("change", () => {
    const v = parseFloat(numFlattenHeight.value);
    if (!Number.isFinite(v)) { numFlattenHeight.value = flattenState.heightM; return; }
    flattenState.heightM = v;
    // Typing a target and having it silently ignored would be the surprise.
    setFlattenFixed(true);
  });
  btnFlattenPick?.addEventListener("click", () => setPickingHeight(!_pickingHeight));
  window.addEventListener("keydown", (e) => {
    if (isEditor && _pickingHeight && e.key === "Escape") setPickingHeight(false);
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

  // Height-related slider ranges scale with the configured MAX_HEIGHT.
  slClampMin.min = -MAX_HEIGHT;
  slClampMin.max =  MAX_HEIGHT - 10;
  slClampMin.value = -MAX_HEIGHT;
  slClampMax.min = 10;
  slClampMax.max = MAX_HEIGHT;
  slClampMax.value = MAX_HEIGHT;
  genHeight.max = MAX_HEIGHT;

  function syncClampUI() {
    // Slider at either extreme = clamp off (dig below 0 / raise past MAX_HEIGHT).
    lblClampMin.textContent =
      Number(slClampMin.value) <= Number(slClampMin.min) ? "Off" : slClampMin.value + "m";
    lblClampMax.textContent =
      Number(slClampMax.value) >= Number(slClampMax.max) ? "Off" : slClampMax.value + "m";
  }
  slClampMin.addEventListener("input", () => {
    // Keep min below max with at least 10m gap
    if (Number(slClampMin.value) >= Number(slClampMax.value) - 10)
      slClampMin.value = Number(slClampMax.value) - 10;
    const v = Number(slClampMin.value);
    sculpt.uClampMin.value = v <= Number(slClampMin.min) ? -2.0 : v / MAX_HEIGHT;
    syncClampUI();
  });
  slClampMax.addEventListener("input", () => {
    if (Number(slClampMax.value) <= Number(slClampMin.value) + 10)
      slClampMax.value = Number(slClampMin.value) + 10;
    const v = Number(slClampMax.value);
    sculpt.uClampMax.value = v >= Number(slClampMax.max) ? 2.0 : v / MAX_HEIGHT;
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
    // Alt+click picks the clone source, so the clone brush ignores modifiers.
    if (stickyMode === "clone") return "clone";
    if (pointerMods.alt) return "flatten";
    if (pointerMods.ctrl) return "smooth";
    if (pointerMods.shift) return "lower";
    return stickyMode;
  }

  function refreshModeIndicator() {
    setMode(getStrokeMode());
  }

  window.addEventListener("keydown", e => {
    if (!isEditor) return;
    syncPointerMods(e);
    refreshModeIndicator();
  });
  window.addEventListener("keyup", e => {
    if (!isEditor) return;
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

  // Live GPU regeneration: a burst of slider changes shares one undo entry
  // (runGeneratorPass opens a stroke; the timer closes it once tweaking stops).
  let _genBurstTimer = 0;
  function applyProceduralTerrain() {
    readGenFromUI();
    genPass.sync(genParams);
    sculpt.runGeneratorPass(genPass.quad);
    clearTimeout(_genBurstTimer);
    _genBurstTimer = setTimeout(() => { if (!isPainting) sculpt.endStroke(); }, 800);
    markHeightmapDirty();
    scheduleHeightmapReadback();
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

  for (const btn of uiQueryAll(".preset-btn")) {
    btn.addEventListener("click", () => {
      const p = TERRAIN_PRESETS[btn.dataset.preset];
      if (!p) return;
      uiQueryAll(".preset-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      pushPresetToUI(p);
      applyProceduralTerrain();
    });
  }

  // Sliders regenerate live (GPU pass — sub-millisecond per update).
  for (const sl of [genScale, genHeight, genOctaves, genWarp, genDropoff, genPlains, genOffsetX, genOffsetZ]) {
    sl.addEventListener("input", () => { syncGenUI(); applyProceduralTerrain(); });
  }
  genMode.addEventListener("change", () => applyProceduralTerrain());
  genShape.addEventListener("change", () => applyProceduralTerrain());
  genSeed.addEventListener("input", () => applyProceduralTerrain());
  btnGenerate.addEventListener("click", () => applyProceduralTerrain());
  btnRandomSeed.addEventListener("click", () => {
    genSeed.value = Math.floor(Math.random() * 100000);
    uiQueryAll(".preset-btn").forEach(b => b.classList.remove("active"));
    applyProceduralTerrain();
  });
  syncGenUI();

  // ── Global hydraulic erosion ─────────────────────────────────────────────
  // CPU droplet sim (v2 port) on the heightmap mirror: readback → erode in
  // metres → pushHeightmapEditsToGpu (undoable via replaceHeightData's stroke).
  const eroIters    = uiById("sl-ero-iters");
  const eroRate     = uiById("sl-ero-rate");
  const eroDeposit  = uiById("sl-ero-deposit");
  const eroEvap     = uiById("sl-ero-evap");
  const eroInertia  = uiById("sl-ero-inertia");
  const eroCapacity = uiById("sl-ero-capacity");
  const eroRadius   = uiById("sl-ero-radius");
  const eroSmooth   = uiById("sl-ero-smooth");
  const btnRunErosion = uiById("btn-run-erosion");

  function readErosionFromUI() {
    return {
      iterations:     Number(eroIters.value),
      erosionRate:    Number(eroRate.value)     / 100,
      depositionRate: Number(eroDeposit.value)  / 100,
      evaporation:    Number(eroEvap.value)     / 1000,
      inertia:        Number(eroInertia.value)  / 100,
      capacity:       Number(eroCapacity.value) / 2,
      radius:         Number(eroRadius.value),
      smoothing:      Number(eroSmooth.value),
    };
  }

  function syncErosionUI() {
    const p = readErosionFromUI();
    uiById("lbl-ero-iters").textContent    =
      p.iterations >= 1e6 ? (p.iterations / 1e6).toFixed(1) + "M" : Math.round(p.iterations / 1000) + "k";
    uiById("lbl-ero-rate").textContent     = p.erosionRate.toFixed(2);
    uiById("lbl-ero-deposit").textContent  = p.depositionRate.toFixed(2);
    uiById("lbl-ero-evap").textContent     = p.evaporation.toFixed(3);
    uiById("lbl-ero-inertia").textContent  = p.inertia.toFixed(2);
    uiById("lbl-ero-capacity").textContent = p.capacity.toFixed(1);
    uiById("lbl-ero-radius").textContent   = String(p.radius);
    uiById("lbl-ero-smooth").textContent   = String(p.smoothing);
  }

  for (const sl of [eroIters, eroRate, eroDeposit, eroEvap, eroInertia, eroCapacity, eroRadius, eroSmooth]) {
    sl.addEventListener("input", syncErosionUI);
  }
  syncErosionUI();

  let erosionRunning = false;
  btnRunErosion.addEventListener("click", async () => {
    if (erosionRunning) return;
    erosionRunning = true;
    btnRunErosion.disabled = true;
    try {
      const params = readErosionFromUI();
      await ensureCpuHeightmapFromGpu();

      // Sim runs in metres — v2's tuned constants are metre-scale.
      const metres = new Float32Array(cpuHeightmap.length);
      for (let i = 0; i < metres.length; i++) metres[i] = cpuHeightmap[i] * MAX_HEIGHT;

      const kernel = buildErosionKernel(params.radius);
      const total  = params.iterations;
      const BATCH  = 2500; // droplets are independent — yield to the UI between batches (~100ms each)
      for (let done = 0; done < total; done += BATCH) {
        erodeDroplets(metres, HEIGHTMAP_SIZE, Math.min(BATCH, total - done), params, kernel);
        btnRunErosion.textContent = `Eroding… ${Math.min(100, Math.round(((done + BATCH) / total) * 100))}%`;
        await new Promise((r) => setTimeout(r, 0));
      }

      if (params.smoothing > 0) {
        btnRunErosion.textContent = "Smoothing…";
        await new Promise((r) => setTimeout(r, 0));
        smoothHeights(metres, HEIGHTMAP_SIZE, params.smoothing);
      }

      for (let i = 0; i < metres.length; i++) cpuHeightmap[i] = metres[i] / MAX_HEIGHT;
      pushHeightmapEditsToGpu();
    } finally {
      erosionRunning = false;
      btnRunErosion.disabled = false;
      btnRunErosion.textContent = "Run Erosion";
    }
  });

  // ── Global fluvial erosion (stream power) ────────────────────────────────
  // CPU Fastscape-style sim (streamPowerErosion.js): carves the dendritic
  // valley network the droplet sim can't. Same readback → metres → push flow.
  const speIters    = uiById("sl-spe-iters");
  const speStrength = uiById("sl-spe-strength");
  const speUplift   = uiById("sl-spe-uplift");
  const speSmooth   = uiById("sl-spe-smooth");
  const btnRunStreamPower = uiById("btn-run-stream-power");

  function readStreamPowerFromUI() {
    return {
      iterations: Number(speIters.value),
      strength:   Number(speStrength.value) / 2000,
      uplift:     Number(speUplift.value)   / 100,
      smoothing:  Number(speSmooth.value)   / 100,
    };
  }

  function syncStreamPowerUI() {
    const p = readStreamPowerFromUI();
    uiById("lbl-spe-iters").textContent    = String(p.iterations);
    uiById("lbl-spe-strength").textContent = p.strength.toFixed(3);
    uiById("lbl-spe-uplift").textContent   = p.uplift.toFixed(2) + "m";
    uiById("lbl-spe-smooth").textContent   = p.smoothing.toFixed(2);
  }

  for (const sl of [speIters, speStrength, speUplift, speSmooth]) {
    sl.addEventListener("input", syncStreamPowerUI);
  }
  syncStreamPowerUI();

  let streamPowerRunning = false;
  btnRunStreamPower.addEventListener("click", async () => {
    if (streamPowerRunning) return;
    streamPowerRunning = true;
    btnRunStreamPower.disabled = true;
    try {
      const params = readStreamPowerFromUI();
      await ensureCpuHeightmapFromGpu();

      const metres = new Float32Array(cpuHeightmap.length);
      for (let i = 0; i < metres.length; i++) metres[i] = cpuHeightmap[i] * MAX_HEIGHT;

      const scratch = createStreamPowerScratch(HEIGHTMAP_SIZE);
      const total = params.iterations;
      const BATCH = 10; // iterations carry state only via `metres` — safe to split
      for (let done = 0; done < total; done += BATCH) {
        streamPowerErode(metres, HEIGHTMAP_SIZE, Math.min(BATCH, total - done), params, scratch);
        btnRunStreamPower.textContent = `Carving… ${Math.min(100, Math.round(((done + BATCH) / total) * 100))}%`;
        await new Promise((r) => setTimeout(r, 0));
      }

      for (let i = 0; i < metres.length; i++) cpuHeightmap[i] = metres[i] / MAX_HEIGHT;
      pushHeightmapEditsToGpu();
    } finally {
      streamPowerRunning = false;
      btnRunStreamPower.disabled = false;
      btnRunStreamPower.textContent = "Run Stream Power";
    }
  });

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

  /** Apply a .v3height buffer — reconfigures + reloads on size mismatch. */
  async function loadHeightmapBuffer(buf) {
    const decoded = decodeHeightmapFile(buf);
    if (decoded.width !== decoded.height) {
      window.alert(`Non-square heightmaps (${decoded.width}×${decoded.height}) are not supported.`);
      return;
    }
    // Files are self-describing: a mismatched size/scale reconfigures the
    // editor and reloads, with the file stashed to import after boot.
    const mismatch = decoded.width !== HEIGHTMAP_SIZE
      || Math.round(decoded.worldSize) !== WORLD_SIZE
      || Math.round(decoded.maxHeight) !== MAX_HEIGHT;
    if (mismatch) {
      const ok = window.confirm(
        `This heightmap is ${decoded.width}×${decoded.height} for a `
        + `${Math.round(decoded.worldSize)} m world (max height ${Math.round(decoded.maxHeight)} m).\n`
        + `Reload the editor at that terrain size to open it?`,
      );
      if (!ok) return;
      saveTerrainConfig({
        worldSize:     decoded.worldSize,
        heightmapSize: decoded.width,
        splatSize:     SPLAT_RES, // heightmap files carry no paint — keep the current setting
        maxHeight:     decoded.maxHeight,
      });
      await stashPendingHeightmap(buf);
      location.reload();
      return;
    }
    sculpt.replaceHeightData(decoded.heights);
    onHistoryChange();
  }

  // ── Heightmap file: 16-bit PNG / RAW (v3/io/heightmapFormats.js) ─────────
  // The formats Gaea, World Machine, Unity and Unreal use. Neither carries a
  // world size or a height range, so the TOP HEIGHT field says what white
  // (65535) means, and a file of another resolution is resampled to this
  // terrain's. Row 0 = the terrain's −Z edge, for import and export alike, so
  // a round trip is exact.
  const hmfTop    = uiById("hmf-top");
  const hmfFlip   = uiById("hmf-flip");
  const hmfEndian = uiById("hmf-endian");
  const hmfStatus = uiById("hmf-status");
  hmfTop.value = String(MAX_HEIGHT);
  hmfTop.max = String(MAX_HEIGHT);
  const hmfTopMetres = () => {
    const v = parseFloat(hmfTop.value);
    const t = Number.isFinite(v) ? Math.min(MAX_HEIGHT, Math.max(1, v)) : MAX_HEIGHT;
    hmfTop.value = String(t);
    return t;
  };

  /** Encode the current terrain; returns { buffer, name, message } without downloading. */
  async function buildHeightmapExport(kind) {
    await syncHeightmapToCPU();
    const N = HEIGHTMAP_SIZE;
    const top = hmfTopMetres();
    const { samples, clippedLow, clippedHigh } = heightsToUint16(cpuHeightmap, MAX_HEIGHT, top);
    if (hmfFlip.checked) flipRows(samples, N, N);
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const buffer = kind === "png"
      ? await encodeGray16Png(samples, N, N)
      : encodeRaw16(samples, { littleEndian: hmfEndian.value !== "big" });
    let message = `Exported ${N}×${N} 16-bit ${kind.toUpperCase()}, white = ${top} m.`;
    if (clippedLow || clippedHigh) {
      message += ` ${clippedLow} texel(s) below 0 m and ${clippedHigh} above ${top} m were clipped.`;
    }
    return { buffer, name: `terrain-${ts}-${N}.${kind}`, message };
  }

  async function exportHeightmapFormat(kind) {
    const { buffer, name, message } = await buildHeightmapExport(kind);
    downloadBuffer(buffer, name);
    hmfStatus.textContent = message;
  }

  /** Import a 16-bit/8-bit PNG or a RAW heightmap onto the current terrain. */
  async function importHeightmapFormat(file) {
    const buf = await file.arrayBuffer();
    const dec = isPng(buf)
      ? await decodePngHeights(buf)
      : decodeRawHeights(buf, { littleEndian: hmfEndian.value !== "big" });
    if (dec.width !== dec.height) {
      window.alert(`Non-square heightmaps (${dec.width}×${dec.height}) are not supported.`);
      return;
    }
    let data = dec.data;
    if (hmfFlip.checked) flipRows(data, dec.width, dec.height);
    const N = HEIGHTMAP_SIZE;
    let note = "";
    if (dec.width !== N) {
      const ok = window.confirm(
        `This heightmap is ${dec.width}×${dec.height}; the terrain is ${N}×${N}.\n`
        + `Resample it to fit? (Undoable.)`,
      );
      if (!ok) return;
      data = resampleHeights(data, dec.width, dec.height, N, N);
      note = `, resampled to ${N}×${N}`;
    }
    const top = hmfTopMetres();
    const k = top / MAX_HEIGHT;
    if (k !== 1) for (let i = 0; i < data.length; i++) data[i] *= k;
    sculpt.replaceHeightData(data);
    onHistoryChange();
    hmfStatus.textContent = `Imported ${dec.width}×${dec.height} ${dec.bitDepth}-bit ${isPng(buf) ? "PNG" : "RAW"}${note}, white = ${top} m.`
      + (dec.bitDepth === 8 ? " 8-bit has only 256 levels, so slopes will step; use 16-bit if you can." : "");
  }

  function pickExternalHeightmap() {
    return new Promise((resolve) => {
      const input = Object.assign(document.createElement("input"), { type: "file", accept: ".png,.raw,.r16" });
      input.style.display = "none";
      const done = (f) => { resolve(f); input.remove(); };
      input.addEventListener("change", () => done(input.files?.[0] ?? null));
      input.addEventListener("cancel", () => done(null));
      document.body.appendChild(input);
      input.click();
    });
  }

  const runHeightmapTask = async (fn) => {
    try { await fn(); } catch (err) {
      console.error(err);
      window.alert(err instanceof Error ? err.message : "Heightmap file operation failed.");
    }
  };
  uiById("hmf-import").addEventListener("click", () => runHeightmapTask(async () => {
    const file = await pickExternalHeightmap();
    if (file) await importHeightmapFormat(file);
  }));
  uiById("hmf-export-png").addEventListener("click", () => runHeightmapTask(() => exportHeightmapFormat("png")));
  uiById("hmf-export-raw").addEventListener("click", () => runHeightmapTask(() => exportHeightmapFormat("raw")));

  async function loadHeightmap() {
    const file = await pickHeightmapFile();
    if (!file) return;
    try {
      await loadHeightmapBuffer(await file.arrayBuffer());
    } catch (err) {
      console.error(err);
      window.alert(err instanceof Error ? err.message : "Failed to load heightmap.");
    }
  }

  // ── Brush mask ─────────────────────────────────────────────────────────────
  const maskChipsEl   = uiById("mask-chips");
  const btnMaskPNG    = uiById("btn-mask-png");
  const maskPreviewEl = uiById("mask-preview");

  const maskStampSelect = uiById("mask-stamp-select");

  function updateMaskPreview(tex) {
    const ctx = maskPreviewEl.getContext("2d");
    ctx.clearRect(0, 0, 48, 48);
    // Stamps are DataTextures (not drawable) and carry an 8-bit preview canvas.
    const src = tex?.userData?.preview ?? tex?.image;
    if (src) ctx.drawImage(src, 0, 0, 48, 48);
  }

  const slMaskRot  = uiById("sl-mask-rot");
  const lblMaskRot = uiById("lbl-mask-rot");

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
    // A preset chip or a loaded PNG replaces the stamp; the dropdown says so.
    maskStampSelect.value = name.startsWith("stamp:") ? name.slice(6) : "";
  }

  for (const group of STAMP_GROUPS) {
    const og = document.createElement("optgroup");
    og.label = group.label;
    for (const s of group.stamps) og.append(new Option(s, s));
    maskStampSelect.append(og);
  }

  // Latest pick wins: a slow first fetch must not overwrite a later choice.
  let _stampPick = 0;
  maskStampSelect.addEventListener("change", async () => {
    const name = maskStampSelect.value;
    const pick = ++_stampPick;
    if (!name) {
      setMask("soft", maskCache.soft);
      return;
    }
    try {
      const tex = await loadStamp(name);
      if (pick === _stampPick) setMask("stamp:" + name, tex);
    } catch (err) {
      console.error(err);
      if (pick === _stampPick) maskStampSelect.value = "";
    }
  });

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
  // River v2 — the spline is the master and the terrain conforms to it. The
  // only river tool (the old River and River+ were removed 2026-09-15).
  const riverV2Slice = createRiverV2ToolState();
  let riverV2System = null;
  let riverV2Ui = null;
  // Tunnels (O): walkable tubes that open the terrain where they pass through it.
  const tunnelToolSlice = createTunnelToolState();
  let tunnelSystem = null;
  let tunnelUi = null;
  // Scene list (left panel); its per-frame hook is set once every system exists.
  let sceneOutliner = null;
  let _sceneListFrame = null;
  let inspector = null;
  const lakeToolSlice = createLakeToolState();
  let lakeSystem = null;
  let lakeUi = null;
  // One source of truth for the SSR master, edited from both the lake and River v2
  // panels. It is stored on the lake slice (which lakeSystem persists) and mirrored
  // into the module-level uniform that gates every water surface.
  const waterGlobals = {
    get ssrMaster() { return lakeToolSlice.lake.ssrMaster !== false; },
    set ssrMaster(v) {
      lakeToolSlice.lake.ssrMaster = !!v;
      setWaterSsrEnabled(!!v);
    },
  };
  let roadSystem = null;
  let roadConform = null;
  const roadState = { ...DEFAULT_ROAD_STATE };
  const _roadDrag = { nodeId: null, edge: null };
  // Lane road: 3D preview of the lane-based road engine (v3/roads/). Separate
  // from Smart Road 2 above; built on first entry, never saved in the project.
  const laneRoadToolSlice = createLaneRoadToolState();
  let laneRoadSystem = null;
  let laneRoadUi = null;
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
  let _onLeaveRoadMode = () => {};
  let _onGizmoDragEnd = () => {};
  let _gizmoTarget = null;
  /** Decal mode's editing half (editor only); built after the decal system. */
  let decalEditor = null;
  let decalUi = null;
  /** Waterfalls (G): the runtime system (games too) and its editing half. Built after River v2. */
  let waterfallSystem = null;
  let waterfallEditor = null;
  let waterfallUi = null;

  const grassPanel = uiById("grass-panel");
  const decalPanel = uiById("decal-panel");
  const waterfallPanel = uiById("waterfall-panel");
  const susukiPanel = uiById("susuki-panel");
  const flowerPanel = uiById("flower-panel");
  const treePanel  = uiById("tree-panel");
  const foliagePanel = uiById("foliage-panel");
  const ambientFxPanel = uiById("ambientfx-panel");
  const vegHeaderEl = uiById("vegetation-header");
  const vegPlacedEl = uiById("veg-placed-panel");
  const snowPanel  = uiById("snow-panel");
  const cliffPaintPanel = uiById("cliffpaint-panel");

  function syncSculptPanelVisibility() {
    sculptPanel.style.display = (editorMode === "sculpt" && !playMode.active) ? "" : "none";
  }

  function syncPaintPanelVisibility() {
    paintPanel.style.display = (editorMode === "paint" && !playMode.active) ? "" : "none";
  }

  function syncGrassPanelVisibility() {
    grassPanel.style.display = (editorMode === "grass" && !playMode.active) ? "" : "none";
  }

  function syncSusukiPanelVisibility() {
    susukiPanel.style.display = (editorMode === "susuki" && !playMode.active) ? "" : "none";
  }

  function syncFlowerPanelVisibility() {
    if (flowerPanel) flowerPanel.style.display = (editorMode === "flowers" && !playMode.active) ? "" : "none";
  }

  function syncDecalPanelVisibility() {
    if (decalPanel) decalPanel.style.display = (editorMode === "decals" && !playMode.active) ? "" : "none";
    decalEditor?.setActive(editorMode === "decals" && !playMode.active);
  }

  function syncWaterfallPanelVisibility() {
    if (waterfallPanel) waterfallPanel.style.display = (editorMode === "waterfall" && !playMode.active) ? "" : "none";
    waterfallEditor?.setActive(editorMode === "waterfall" && !playMode.active);
  }

  function syncTreePanelVisibility() {
    treePanel.style.display = (editorMode === "treePaint" && !playMode.active) ? "" : "none";
  }

  function syncFoliagePanelVisibility() {
    foliagePanel.style.display = (editorMode === "foliage" && !playMode.active) ? "" : "none";
    if (vegHeaderEl) vegHeaderEl.style.display = (VEG_MODES.includes(editorMode) && !playMode.active) ? "" : "none";
    if (vegPlacedEl) vegPlacedEl.style.display = (editorMode === "vegPlaced" && !playMode.active) ? "" : "none";
  }

  function syncAmbientFxPanelVisibility() {
    if (ambientFxPanel) {
      ambientFxPanel.style.display = (editorMode === "ambientFx" && !playMode.active) ? "" : "none";
    }
  }

  function syncPropsPanelVisibility() {
    propsPanel.style.display = (editorMode === "props" && !playMode.active) ? "" : "none";
  }

  function syncSplinePanelVisibility() {
    splinePanel.style.display = (editorMode === "spline" && !playMode.active) ? "" : "none";
  }

  function syncRiverV2PanelVisibility() {
    riverV2Panel.style.display = (editorMode === "riverv2" && !playMode.active) ? "" : "none";
  }

  function syncTunnelPanelVisibility() {
    if (tunnelPanel) tunnelPanel.style.display = (editorMode === "tunnel" && !playMode.active) ? "" : "none";
  }

  function syncLakePanelVisibility() {
    lakePanel.style.display = (editorMode === "lake" && !playMode.active) ? "" : "none";
  }

  function applyLakeModeEffects() {
    lakeSystem?.setEditActive(editorMode === "lake" && !playMode.active);
  }

  function syncRoadPanelVisibility() {
    roadPanel.style.display = (editorMode === "road" && !playMode.active) ? "" : "none";
  }

  function syncLaneRoadPanelVisibility() {
    if (laneRoadPanel) laneRoadPanel.style.display = (editorMode === "laneRoad" && !playMode.active) ? "" : "none";
  }

  function syncSpawnPanelVisibility() {
    spawnPanel.style.display = (editorMode === "spawn" && !playMode.active) ? "" : "none";
  }

  function applySpawnModeEffects() {
    // The marker stays visible in every editor mode (like a Unity Player Start),
    // but only lights up — and only takes clicks — while spawn mode is active.
    spawnSystem.setEditActive(editorMode === "spawn" && !playMode.active);
    spawnSystem.setVisible(!playMode.active);
  }

  function syncSnowPanelVisibility() {
    snowPanel.style.display = (editorMode === "snow" && !playMode.active) ? "" : "none";
  }

  function syncCliffPaintPanelVisibility() {
    cliffPaintPanel.style.display = (editorMode === "cliffPaint" && !playMode.active) ? "" : "none";
  }

  function applyRiverModeEffects() {
    riverV2System?.setEditActive(editorMode === "riverv2" && !playMode.active);
    tunnelSystem?.setEditActive(editorMode === "tunnel" && !playMode.active);
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
      toolsModeSelect.value = VEG_MODES.includes(m) ? "foliage" : m;
      syncEditorOrbitEnabled();
      return;
    }
    if (editorMode === "spline" && m !== "spline") _onLeaveSplineMode();
    if (m !== "sculpt") { _regionHideSafe(); _cloneHideSafe(); }   // Sculpt-only overlays
    if (editorMode === "riverv2" && m !== "riverv2") riverV2System?.cancelDrag();
    if (editorMode === "lake" && m !== "lake") lakeSystem?.cancelDrag();
    if (editorMode === "road" && m !== "road") _onLeaveRoadMode();
    // Finish a pending lane-road grade before another tool edits the terrain.
    if (editorMode === "laneRoad" && m !== "laneRoad") laneRoadSystem?.flushGrade();
    if (editorMode === "props" && m !== "props") _onLeavePropsMode();
    editorMode = m;
    const isVeg = VEG_MODES.includes(m);
    if (isVeg) _lastVegMode = m;
    roadSystem?.setEditActive(m === "road" && !playMode.active);
    if (splineToolState) splineToolState.mode = m;
    for (const btn of tbModeButtons) {
      // The one Vegetation button stands for all three plant modes.
      btn.classList.toggle("active", btn.dataset.mode === m || (isVeg && btn.dataset.mode === "foliage"));
    }
    toolsModeSelect.value = isVeg ? "foliage" : m;
    if (isVeg) {
      // The plant pictures are baked the first time Vegetation opens.
      if (!_foliageThumbsQueued) { _foliageThumbsQueued = true; queueAllFoliageThumbs(); }
      vegUi?.rebuild();
    }
    paintSys.endStroke(); // leaving paint mid-drag must close the stroke
    if (rampState === "waiting_end") cancelRampPlacement();
    if (m === "view") {
      uCursorUV.value.set(-2, -2);
      cancelStroke();
      tc.detach();
      tc.enabled = false;
      tc.visible = false;
      _gizmoTarget = null;
    } else if (m === "sculpt") {
      sculpt.uRadius.value = slSize.value / WORLD_SIZE;
    } else if (m === "paint") {
      sculpt.uRadius.value = paintState.brush.radius / WORLD_SIZE;
    } else if (m === "grass") {
      uCursorUV.value.set(-2, -2);
      ensureGrassBuilt();
    } else if (m === "susuki") {
      uCursorUV.value.set(-2, -2);
      sculpt.uRadius.value = vegBrush.radius / WORLD_SIZE;
      ensureSusukiBuilt();
    } else if (m === "flowers") {
      uCursorUV.value.set(-2, -2);
      sculpt.uRadius.value = vegBrush.radius / WORLD_SIZE;
      ensureFlowersBuilt();
    } else if (m === "treePaint") {
      sculpt.uRadius.value = treeToolState.brush.radius / WORLD_SIZE;
    } else if (m === "foliage") {
      uCursorUV.value.set(-2, -2);
      sculpt.uRadius.value = vegBrush.radius / WORLD_SIZE;
      void ensureFoliageScatterBuilt();
    } else if (m === "ambientFx") {
      uCursorUV.value.set(-2, -2);
      sculpt.uRadius.value = ambientBrush.radius / WORLD_SIZE;
      // Opening the mode IS the request to see it. A world nobody opened it in
      // keeps the flag off, so no existing project grows butterflies by itself.
      ambientFxState.enabled = true;
      void ensureAmbientFxBuilt();
      ambientFxUi?.rebuild();
    } else if (m === "vegPlaced") {
      uCursorUV.value.set(-2, -2);
      sculpt.uRadius.value = vegBrush.radius / WORLD_SIZE;
      if (!propSlots[_vegPlacedSlot]?.plant) _vegPlacedSlot = propSlots.findIndex((s) => s?.plant);
      placedUi?.rebuild();
    } else if (m === "snow") {
      sculpt.uRadius.value = snowBrushState.radius / WORLD_SIZE;
    } else if (m === "cliffPaint") {
      sculpt.uRadius.value = cliffPaintBrush.radius / WORLD_SIZE;
    } else if (m === "spawn") {
      uCursorUV.value.set(-2, -2);
      spawnUi?.refresh();
    } else if (m === "decals") {
      uCursorUV.value.set(-2, -2);
    } else if (m === "waterfall") {
      uCursorUV.value.set(-2, -2);
      // Falls are solved against the CPU height mirror: freshen it, then re-solve.
      void ensureCpuHeightmapFromGpu().then(() => { waterfallSystem?.markDirty(); waterfallUi?.rebuild(); });
    } else if (m === "props" || m === "spline"
      || m === "riverv2" || m === "road" || m === "lake" || m === "tunnel" || m === "laneRoad") {
      uCursorUV.value.set(-2, -2);
      // River v2 snapshots the unconformed terrain from the CPU mirror, so the
      // mirror has to be fresh before the first conform of the session.
      if (m === "riverv2") void ensureCpuHeightmapFromGpu().then(() => riverV2Ui?.refresh());
      // A tunnel's floor height comes from the ground under the click.
      if (m === "tunnel") void ensureCpuHeightmapFromGpu().then(() => tunnelUi?.refresh());
      // Lake creation reads terrain height at the click to pick a water level.
      if (m === "lake") void ensureCpuHeightmapFromGpu().then(() => lakeUi?.refresh());
      if (m === "road") {
        // Fresh CPU mirror → rebase the grade baseline → re-drape the network.
        void ensureCpuHeightmapFromGpu().then(() => {
          roadConform?.rebase();
          roadSystem?.queueRebuild();
        });
      }
      // Fresh CPU mirror → rebase the grade baseline (as road mode does) → re-drape.
      // First visit loads the test scene at the view centre, on the ground there.
      if (m === "laneRoad" && laneRoadSystem) {
        void ensureCpuHeightmapFromGpu().then(() => {
          if (laneRoadSystem.loaded) laneRoadSystem.rebaseTerrain();
          else { laneRoadSystem.conform?.rebase(); laneRoadSystem.load(); }
          laneRoadUi?.refresh();
        });
      }
    }
    syncSculptPanelVisibility();
    syncPaintPanelVisibility();
    syncSnowPanelVisibility();
    syncCliffPaintPanelVisibility();
    syncGrassPanelVisibility();
    syncSusukiPanelVisibility();
    syncFlowerPanelVisibility();
    syncDecalPanelVisibility();
    syncWaterfallPanelVisibility();
    syncTreePanelVisibility();
    syncFoliagePanelVisibility();
    syncAmbientFxPanelVisibility();
    syncPropsPanelVisibility();
    syncSplinePanelVisibility();
    syncRiverV2PanelVisibility();
    syncTunnelPanelVisibility();
    syncLakePanelVisibility();
    syncRoadPanelVisibility();
    syncLaneRoadPanelVisibility();
    syncSpawnPanelVisibility();
    applySplineModeEffects();
    applyRiverModeEffects();
    applyLakeModeEffects();
    applySpawnModeEffects();
    refreshGizmoHud();
    if (viewNavHint) viewNavHint.style.display = (m === "view" && !playMode.active) ? "" : "none";
    syncEditorOrbitEnabled();
  }

  function enterPlay(opts = {}) {
    if (playMode.active) return;
    const immersive = opts.immersive === true;
    treeBvh?.ensureBaked();
    if (!cliffBvh.baked) rebakePlayerBvh();
    editorCamera?.onPlayEnter?.();
    snowSystem.setHeightTex(heightTexNode.value);
    snowSystem.setPlayMode(true);
    snowSystem.setDeformActive(false);
    playMode.enter({ editorRelaxedPointer: !immersive });
    collectibleRuntime?.start();
    try { renderer.domElement.focus({ preventScroll: true }); } catch (_) { renderer.domElement.focus(); }
    syncPlayEditorChrome(immersive);
    if (immersive) playMode.startWalking();
    tbPlay.classList.add("active");
    playStopBar.classList.add("visible");
    playPanel.style.display = "";
    syncColliderDebugUi();
    syncPlayPanels();
    sculptPanel.style.display = "none";
    paintPanel.style.display = "none";
    snowPanel.style.display  = "none";
    grassPanel.style.display = "none";
    susukiPanel.style.display = "none";
    if (flowerPanel) flowerPanel.style.display = "none";
    syncDecalPanelVisibility();
    syncWaterfallPanelVisibility();
    treePanel.style.display = "none";
    foliagePanel.style.display = "none";
    propsPanel.style.display = "none";
    splinePanel.style.display = "none";
    riverV2Panel.style.display = "none";
    if (tunnelPanel) tunnelPanel.style.display = "none";
    lakePanel.style.display = "none";
    roadPanel.style.display = "none";
    if (laneRoadPanel) laneRoadPanel.style.display = "none";
    spawnPanel.style.display = "none";
    roadSystem?.setEditActive(false);
    lakeSystem?.setEditActive(false);
    riverV2System?.setEditActive(false);
    tunnelSystem?.setEditActive(false);
    spawnSystem.setVisible(false);
    helpOverlay.classList.remove("visible");
    tbHelp.classList.remove("active");
    syncPlayImmersiveButtonLabel();
  }

  function exitPlay() {
    if (!playMode.active) return;
    snowSystem.setPlayMode(false);
    snowSystem.resetTrail();
    grassPush.reset();
    _grassPushPrev.fill(NaN);
    playPhysicsUi?.setVisible(false);
    playFlightUi?.setVisible(false);
    flyHud?.setVisible(false);
    collectibleRuntime?.stop();
    playMode.exit();
    setEditorMode(editorMode, { force: true });  // restore whatever panel was active
  }

  // Picking a tool shows its panel, even if the Inspector tab was open.
  for (const btn of tbModeButtons) {
    btn.addEventListener("click", () => {
      // Vegetation reopens the plant kind that was last painted.
      setEditorMode(btn.dataset.mode === "foliage" ? _lastVegMode : btn.dataset.mode);
      openRightTab("tools");
    });
  }
  toolsModeSelect.addEventListener("change", () =>
    setEditorMode(toolsModeSelect.value === "foliage" ? _lastVegMode : toolsModeSelect.value));

  /** Switch the right panel to "tools", "inspector" or "world". */
  function openRightTab(name) {
    const btn = uiQuery(`#right-panel .tab-btn[data-tab="${name}"]`);
    if (btn && !btn.classList.contains("active")) btn.click();
  }


  tbPlay.addEventListener("click", (e) => {
    if (playMode.active) exitPlay();
    else enterPlay({ immersive: e.shiftKey });
  });

  // Immersive: click viewport to (re)acquire pointer lock
  renderer.domElement.addEventListener("click", () => {
    if (playMode.active && !playMode.walking && !playMode.relaxedPointer) {
      playMode.startWalking();
    }
  });

  uiById("play-stop-btn").addEventListener("click", () => exitPlay());
  playImmersiveBtn?.addEventListener("click", () => {
    setPlayImmersive(!getPlayImmersive());
  });

  const playBvhDebugToggle = uiById("play-bvh-debug-toggle");
  playBvhDebugToggle?.addEventListener("click", () => {
    setBvhDebugEnabled(!bvhDebugUi.enabled);
  });

  const playCapsuleDebugToggle = uiById("play-capsule-debug-toggle");
  const playColliderDebugLabel = uiById("play-collider-debug-label");
  const playColliderDebugHint = uiById("play-collider-debug-hint");
  function syncColliderDebugUi() {
    if (playCapsuleDebugToggle) {
      playCapsuleDebugToggle.classList.toggle("checked", !!playMode?.showCollider);
    }
    if (!playMode?.active) return;
    const fly = playMode.flyActive;
    if (playColliderDebugLabel) {
      playColliderDebugLabel.textContent = fly ? "Flight sphere" : "On-foot capsule";
    }
    if (playColliderDebugHint) {
      playColliderDebugHint.innerHTML = fly
        ? '<span style="color:#66ccff">Cyan</span> swept-sphere hit volume'
        : '<span style="color:#44ff88">Green</span> capsule hit volume';
    }
  }
  playCapsuleDebugToggle?.addEventListener("click", () => {
    if (!playMode?.active) return;
    playMode.setShowCollider(!playMode.showCollider);
    syncColliderDebugUi();
  });

  tbHelp.addEventListener("click", () => {
    helpOverlay.classList.toggle("visible");
    tbHelp.classList.toggle("active");
  });
  // Close overlay when clicking anywhere on the viewport
  renderer.domElement.addEventListener("mousedown", () => {
    helpOverlay.classList.remove("visible");
    tbHelp.classList.remove("active");
  }, { capture: true });

  // Save = whole project (.v3proj); Shift+click = bare heightmap export.
  tbSave.title = "Save project (Ctrl+S) · Shift+click: heightmap only";
  tbSave.addEventListener("click", (e) => { e.shiftKey ? saveHeightmap() : saveProject(); });
  tbLoad.title = "Load project / heightmap";
  tbLoad.addEventListener("click", () => { loadAnyFile(); });
  // Same routing as Ctrl+Z / Ctrl+Y: the current mode's history.
  tbUndo.addEventListener("click", () => undoInMode());
  tbRedo.addEventListener("click", () => redoInMode());

  // ── Terrain size: toolbar label, inspector values, New Terrain dialog ──────
  const tbTerrainSize = uiById("tb-terrain-size");
  tbTerrainSize.textContent = `${WORLD_SIZE} m · ${HEIGHTMAP_SIZE}²`;

  const ntOverlay = uiById("terrain-size-overlay");
  const ntWorld   = uiById("nt-world");
  const ntDetail  = uiById("nt-detail");
  const ntSplat   = uiById("nt-splat");
  const ntHeight  = uiById("nt-height");
  const ntSummary = uiById("nt-summary");

  // Set a dropdown to `value`, falling back to the numerically closest option so
  // a config saved outside the preset list still shows something sensible.
  function ntSetSelect(sel, value) {
    sel.value = String(value);
    if (sel.selectedIndex >= 0) return;
    let best = 0, bestD = Infinity;
    for (let i = 0; i < sel.options.length; i++) {
      const d = Math.abs(Number(sel.options[i].value) - value);
      if (d < bestD) { bestD = d; best = i; }
    }
    sel.selectedIndex = best;
  }

  function ntComputedRes() {
    return Math.min(4096, Math.max(256, Number(ntWorld.value) / Number(ntDetail.value)));
  }
  function ntComputedSplat() {
    const { min, max } = TERRAIN_SIZE_LIMITS.splatSize;
    return Math.min(max, Math.max(min, Math.round(Number(ntWorld.value) / Number(ntSplat.value))));
  }
  function syncNtSummary() {
    const res = ntComputedRes();
    const mb  = Math.round((res * res * 8 * 3) / 1e6); // 3 × RGBA16F height RTs
    const eff = Number(ntWorld.value) / res;
    const sRes = ntComputedSplat();
    const sEff = +(Number(ntWorld.value) / sRes).toFixed(3);
    const sMb  = Math.round((sRes * sRes * 4 * 2) / 1e6); // RGBA8 × 2 slices
    ntSummary.textContent =
      `Heightmap ${res} × ${res} (${eff} m/texel) · ~${mb} MB GPU height data`
      + (res >= 4096 ? " — heavy: desktop GPU recommended" : "")
      + `\nSplatmap ${sRes} × ${sRes} (${sEff} m/texel) · ~${sMb} MB`
      + (sEff > Number(ntSplat.value) ? ` — capped at ${sRes}, painting slows down past it` : "");
  }
  ntSummary.style.whiteSpace = "pre-line";
  ntWorld .addEventListener("change", syncNtSummary);
  ntDetail.addEventListener("change", syncNtSummary);
  ntSplat .addEventListener("change", syncNtSummary);
  tbTerrainSize.addEventListener("click", () => {
    ntSetSelect(ntWorld,  WORLD_SIZE);
    ntSetSelect(ntDetail, WORLD_SIZE / HEIGHTMAP_SIZE);
    ntSetSelect(ntSplat,  WORLD_SIZE / SPLAT_RES);
    ntSetSelect(ntHeight, MAX_HEIGHT);
    syncNtSummary();
    ntOverlay.style.display = "flex";
  });
  uiById("nt-cancel").addEventListener("click", () => {
    ntOverlay.style.display = "none";
  });
  ntOverlay.addEventListener("click", (e) => {
    if (e.target === ntOverlay) ntOverlay.style.display = "none";
  });
  uiById("nt-create").addEventListener("click", () => {
    saveTerrainConfig({
      worldSize:     Number(ntWorld.value),
      heightmapSize: ntComputedRes(),
      splatSize:     ntComputedSplat(),
      maxHeight:     Number(ntHeight.value),
    });
    location.reload();
  });

  // Brush size is expressed in METRES (like the paint/tree/snow brushes) so it
  // stays intuitive at any terrain size; the slider range scales with the world.
  const BRUSH_MIN_M = 2;
  const BRUSH_MAX_M = Math.round(WORLD_SIZE / 4);
  slSize.min   = BRUSH_MIN_M;
  slSize.max   = BRUSH_MAX_M;
  slSize.step  = 1;
  slSize.value = Math.round(WORLD_SIZE * 0.05); // same default footprint as the old 5%

  function syncSizeUI()    { lblSize   .textContent = Math.round(sculpt.uRadius.value * WORLD_SIZE) + "m"; }
  function syncStrUI()     { lblStr    .textContent = Math.round(sculpt.uStrength.value * 1000); }
  function syncFalloffUI() { lblFalloff.textContent = (slFalloff.value / 10).toFixed(1); }

  slSize.addEventListener("input", () => {
    sculpt.uRadius.value = slSize.value / WORLD_SIZE;
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

  function syncHydroUI() {
    lblHydroStrength.textContent = slHydroStrength.value;
    lblHydroWater   .textContent = slHydroWater.value;
    lblHydroIter    .textContent = slHydroIter.value;
  }
  slHydroStrength.addEventListener("input", () => {
    sculpt.uHydroStrength.value = Number(slHydroStrength.value) * 0.5;
    syncHydroUI();
  });
  slHydroWater.addEventListener("input", () => {
    sculpt.uHydroRain.value = Number(slHydroWater.value) / 1000;
    syncHydroUI();
  });
  slHydroIter.addEventListener("input", () => {
    sculpt.hydroConfig.iterations = Number(slHydroIter.value);
    syncHydroUI();
  });
  syncHydroUI();

  function syncRampWidthUI() { lblRampWidth.textContent = slRampWidth.value + "m"; }
  slRampWidth.addEventListener("input", () => {
    sculpt.uRampWidth.value = Number(slRampWidth.value) / WORLD_SIZE;
    syncRampWidthUI();
  });
  syncRampWidthUI();

  // Fire every sculpt slider's input handler once so the GPU uniforms start in
  // sync with the HTML defaults. The sync*UI helpers only refresh labels — the
  // erode talus uniform used to sit at ~77° while the slider showed 30°.
  for (const sl of [slSize, slStr, slFalloff, slTerraceStep, slTerraceSharp,
                    slNoiseScale, slNoiseOct, slThermalSlope, slThermalIter,
                    slRampWidth, slClampMin, slClampMax, slMaskRot]) {
    sl.dispatchEvent(new Event("input"));
  }

  // Initialize tool-options zone visibility for the default sticky mode.
  setMode(stickyMode);

  // ── Input ──────────────────────────────────────────────────────────────────
  const mouse        = new THREE.Vector2();
  const raycaster    = new THREE.Raycaster();
  const gndPlane     = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const hitPoint     = new THREE.Vector3();
  const _rayMarchPt  = new THREE.Vector3();

  // ── CPU heightmap mirror for accurate raycasting on tall terrain ────────────
  const cpuHeightmap    = new Float32Array(HEIGHTMAP_SIZE * HEIGHTMAP_SIZE);
  // Lowest terrain height in world metres (≤ 0). The cursor ray-march ends at
  // this plane instead of y=0 so the brush still works inside dug-out pits.
  let cpuHeightmapMinY  = 0;
  let readbackInFlight  = false;
  let readbackPending   = false;

  /**
   * Widen a texel rect to a 32-texel grid.
   *
   * WebGPU pads every readback row to a 256-byte boundary. At RGBA that is 16
   * texels for float32 and 32 for half-float, so a 32-aligned x/width is always
   * tightly packed and the rows copy straight across with no padding to unpick.
   * The old full-map read never hit this because 1024 is already aligned.
   */
  function alignReadRect(rect) {
    const S = HEIGHTMAP_SIZE;
    const x0 = Math.max(0, Math.floor(rect.x / 32) * 32);
    const y0 = Math.max(0, Math.floor(rect.y / 32) * 32);
    const x1 = Math.min(S, Math.ceil((rect.x + rect.w) / 32) * 32);
    const y1 = Math.min(S, Math.ceil((rect.y + rect.h) / 32) * 32);
    return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
  }

  /**
   * Texel rect → world centre + radius, for chunk-limited height resyncs.
   * getChunkKeysInRadius takes a square box around the centre, so a radius of
   * half the rect's diagonal is guaranteed to cover its corners.
   */
  function rectToWorldRegion(rect) {
    const x0 = (rect.x / HEIGHTMAP_SIZE - 0.5) * WORLD_SIZE;
    const x1 = ((rect.x + rect.w) / HEIGHTMAP_SIZE - 0.5) * WORLD_SIZE;
    const z0 = (rect.y / HEIGHTMAP_SIZE - 0.5) * WORLD_SIZE;
    const z1 = ((rect.y + rect.h) / HEIGHTMAP_SIZE - 0.5) * WORLD_SIZE;
    return {
      x: (x0 + x1) * 0.5,
      z: (z0 + z1) * 0.5,
      radius: 0.5 * Math.hypot(x1 - x0, z1 - z0),
    };
  }

  /**
   * Refresh the CPU heightmap mirror from the GPU.
   *
   * Reads only the rect the brush actually wrote. MEASURED before this: eight
   * full-map readbacks a second while dragging, 16 MB each, 22 ms for the read
   * plus 6 ms to convert — and that was on top of a 17 ms grass texture rebuild
   * that is now a GPU bake (see grassTerrainData.initSurfaceBake).
   */
  async function syncHeightmapToCPU() {
    if (readbackInFlight) {
      readbackPending = true;
      return;
    }
    readbackInFlight = true;
    readbackPending  = false;
    try {
      const rt = sculpt.getCurrentRT();
      const dirty = sculpt.getDirtyRect();
      // Claim the rect BEFORE awaiting: anything written during the read lands
      // in a fresh rect and is picked up by the next pass instead of being lost.
      sculpt.clearDirtyRect();
      let rect = alignReadRect(
        dirty ?? { x: 0, y: 0, w: HEIGHTMAP_SIZE, h: HEIGHTMAP_SIZE },
      );
      let raw = await renderer.readRenderTargetPixelsAsync(rt, rect.x, rect.y, rect.w, rect.h);
      // Defensive: if the driver padded anyway, fall back to the whole map so a
      // misaligned config can never silently corrupt the mirror.
      if (raw.length !== rect.w * rect.h * 4) {
        rect = { x: 0, y: 0, w: HEIGHTMAP_SIZE, h: HEIGHTMAP_SIZE };
        raw = await renderer.readRenderTargetPixelsAsync(rt, 0, 0, HEIGHTMAP_SIZE, HEIGHTMAP_SIZE);
      }
      const isHalf = raw instanceof Uint16Array;
      const isFull = rect.w === HEIGHTMAP_SIZE && rect.h === HEIGHTMAP_SIZE;
      let minH = 0;
      for (let row = 0; row < rect.h; row++) {
        const src = row * rect.w * 4;
        const dst = (rect.y + row) * HEIGHTMAP_SIZE + rect.x;
        for (let i = 0; i < rect.w; i++) {
          const rv = raw[src + i * 4];
          const v = isHalf ? THREE.DataUtils.fromHalfFloat(rv) : rv;
          cpuHeightmap[dst + i] = v;
          if (v < minH) minH = v;
        }
      }
      // A partial read cannot see the whole map, so the lowest point is only
      // ever revised DOWNWARD. Being stale-low is harmless: this feeds the
      // cursor ray-march's floor plane, which just starts marching lower.
      // A full read (generator, load, undo of a whole-map edit) resets it.
      cpuHeightmapMinY = isFull
        ? minH * MAX_HEIGHT
        : Math.min(cpuHeightmapMinY, minH * MAX_HEIGHT);
      // Only the chunks under the edited rect need re-draping — see the note on
      // syncTreeHeights for why the full scan is expensive out of proportion to
      // its arithmetic.
      const region = isFull ? null : rectToWorldRegion(rect);
      treeEnv.syncTreeHeights(region);
      /*
       * The v2 ocean's shoreline distance field is derived from the terrain, so
       * a sculpt invalidates it — a coast that moved leaves the foam behind.
       * This is the right place because the readback is ALREADY debounced to a
       * settled edit (see markHeightmapDirty / scheduleHeightmapReadback); the
       * bake is ~100 ms at 1024² and must never ride a drag.
       *
       * Costs nothing unless the v2 ocean exists — setOceanHeights only bakes
       * when it has been built and is the active mode.
       */
      worldEnv?.setOceanHeights(cpuHeightmap);
    } finally {
      readbackInFlight = false;
      if (readbackPending) syncHeightmapToCPU();
    }
  }

  /** Push CPU height edits (plateau, carve, procedural) to GPU + dependent systems. */
  function pushHeightmapEditsToGpu() {
    sculpt.replaceHeightData(cpuHeightmap);
    let minH = 0;
    for (let i = 0; i < cpuHeightmap.length; i++) {
      if (cpuHeightmap[i] < minH) minH = cpuHeightmap[i];
    }
    cpuHeightmapMinY = minH * MAX_HEIGHT;
    treeEnv.syncTreeHeights();
  }

  async function ensureCpuHeightmapFromGpu() {
    // syncHeightmapToCPU returns at once while another readback is in flight,
    // and that one may have started before the latest height write — so a
    // caller asking for FRESH heights (tunnel re-cut, mode entry) got the old
    // mirror. Wait for it to land, then read again.
    for (let i = 0; readbackInFlight && i < 300; i++) await new Promise((r) => setTimeout(r, 10));
    await syncHeightmapToCPU();
  }

  /**
   * Bilinear CPU height read, CLAMP-TO-EDGE outside the map.
   *
   * The clamping is not tidiness — off-map used to return NaN, and a NaN ground
   * height is fatal to the whole session. It reaches the car through
   * Vehicle.getFloorY, where `if (cornerY >= floorY) continue` is FALSE against
   * NaN, so the corner-contact spring runs on a NaN penetration and poisons the
   * body's force accumulator. From there NaN is in body.pos, so the chase camera
   * matrix is NaN (black screen), the HUD reads NaN (speedometer), and
   * `y < FALL_Y` — also false against NaN — never fires the auto-respawn.
   *
   * MEASURED on the shipping 2048 m / 1024-texel terrain, i.e. a map spanning
   * ±1024 m, over a terrain sloping in both axes:
   *
   *     (   0, 1024)   101.2 m      last texel, fine
   *     (   0, 1025)   NaN          y0 = 1024 indexes PAST the Float32Array;
   *     (   0, 1100)   NaN          a typed array reads `undefined`, not 0
   *     (1023, 1023)   126.7 m
   *     (1025,    0)    62.8 m      x0 = 1024 WRAPS onto the next texel ROW —
   *     (1100,    0)    89.3 m      64 m of ground vanishing in one metre
   *     (  -1100, 0)    60.9 m      tx = −88: linear EXTRAPOLATION off the edge
   *     (-2000,-2000)   12.5 m      unbounded — far enough out it is a ravine
   *
   * Only x0/y0 were clamped low and x1/y1 high, so every failure above is a case
   * neither clamp covered. Clamping the ORIGIN texel and the weights makes the
   * terrain read flat past its border, which is also what the GPU heightmap
   * sampler does, so the CPU and shader now agree out there instead of diverging.
   */
  function sampleHeightNormalized(u, v) {
    const fu = u * HEIGHTMAP_SIZE - 0.5;
    const fv = v * HEIGHTMAP_SIZE - 0.5;
    const x0 = Math.min(HEIGHTMAP_SIZE - 1, Math.max(0, Math.floor(fu)));
    const y0 = Math.min(HEIGHTMAP_SIZE - 1, Math.max(0, Math.floor(fv)));
    const x1 = Math.min(x0 + 1, HEIGHTMAP_SIZE - 1);
    const y1 = Math.min(y0 + 1, HEIGHTMAP_SIZE - 1);
    // Clamped so the OUTSIDE of the map is the edge value rather than a linear
    // extrapolation of the last two texels — see the −1100 / −2000 rows above.
    const tx = Math.min(1, Math.max(0, fu - x0));
    const ty = Math.min(1, Math.max(0, fv - y0));
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

  // ── Cliff paint state ──────────────────────────────────────────────────────
  // Reuses v2's CliffPaintSystem (stroke spacing + snapshot undo) against the
  // world-XZ mask; Alt while painting = erase.
  const cliffPaintBrush = { radius: 30, strength: 0.5, falloff: 2, spacingFactor: 0.1 };
  const cliffPaintSystem = new CliffPaintSystem({
    toolState: { brush: cliffPaintBrush, cliffPaint: { erase: false } },
    mask: cliffPaintMask,
    config: { world: { size: WORLD_SIZE } },
  });
  let _isCliffPainting = false;

  // ── Snow paint state ───────────────────────────────────────────────────────
  const snowBrushState = { radius: 80, strength: 0.5, falloff: 2 };
  let _isSnowPainting  = false;
  const _snowUndoStack = [];   // each entry is a Uint8Array snapshot
  const _snowRedoStack = [];

  // Flatten target locks on the first flatten stamp of a stroke (Unreal-style)
  // instead of chasing the terrain under the cursor while dragging.
  let _flattenLocked = false;

  function stampAt(u, v) {
    const mode = getStrokeMode();
    if (mode === "flatten" && !_flattenLocked) {
      sculpt.uFlattenTarget.value = flattenState.fixed
        ? flattenState.heightM / MAX_HEIGHT
        : sampleHeightNormalized(u, v);
      _flattenLocked = true;
    }
    if      (mode === "smooth")  sculpt.smooth(u, v);
    else if (mode === "flatten") sculpt.flatten(u, v);
    else if (mode === "noise")   sculpt.noise(u, v);
    else if (mode === "terrace") sculpt.terrace(u, v);
    else if (mode === "erode")    sculpt.thermal(u, v);
    else if (mode === "hydro")    sculpt.hydro(u, v);
    else if (mode === "smudge")   sculpt.smudge(u, v);
    else if (mode === "contrast") sculpt.contrast(u, v);
    else if (mode === "clone")    cloneStampAt(u, v);
    else sculpt.paint(u, v, mode === "lower" ? -1 : 1, stickyStamp);
  }

  /** Interpolate stamps along the UV segment so fast drags don't leave gaps. */
  function applySculptStroke(u, v) {
    const spacingUV = Math.max(0.6 / WORLD_SIZE, sculpt.uRadius.value * strokeSpacingFactor);

    if (!lastPaintUV) {
      stampAt(u, v);
      lastPaintUV = { u, v };
      markHeightmapDirty();
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
    markHeightmapDirty();
    requestHeightmapReadback();
  }

  // Dirty-flag gate: the hover handler polls this every 150 ms, but the full
  // readback + grass rebuild + tree resync only runs when the terrain changed.
  let heightmapDirty    = true; // seed the CPU mirror on boot
  let _readbackDebounce = 0;
  function markHeightmapDirty() { heightmapDirty = true; }
  function requestHeightmapReadback() {
    if (!heightmapDirty) return;
    heightmapDirty = false;
    syncHeightmapToCPU();
  }
  /** Debounced variant for bursty edits (live procedural sliders). */
  function scheduleHeightmapReadback(delayMs = 120) {
    clearTimeout(_readbackDebounce);
    _readbackDebounce = setTimeout(() => requestHeightmapReadback(), delayMs);
  }

  // Ray-march terrain intersection: march from camera to ground plane, find
  // the first ray-terrain crossing, then bisect for sub-step precision.
  // The old iterative lift-plane approach diverged on steep slopes (the fixed-point
  // derivative exceeded 1), causing the cursor to jitter or vanish.
  function getUV() {
    raycaster.setFromCamera(mouse, camera);
    // March down to the lowest sculpted level, not just y=0, so the cursor
    // still lands on terrain inside pits dug below the base plane.
    gndPlane.constant = Math.max(0, -cpuHeightmapMinY);
    if (!raycaster.ray.intersectPlane(gndPlane, hitPoint)) return null;

    const tMax  = raycaster.ray.origin.distanceTo(hitPoint);
    const STEPS = Math.min(64, Math.ceil(tMax / (WORLD_SIZE / HEIGHTMAP_SIZE)));
    const dt    = tMax / Math.max(STEPS, 1);

    let prevT    = 0;
    let prevAbove = true;

    for (let i = 1; i <= STEPS; i++) {
      const t = i * dt;
      raycaster.ray.at(t, _rayMarchPt);
      const u = (_rayMarchPt.x + WORLD_SIZE / 2) / WORLD_SIZE;
      const v = (_rayMarchPt.z + WORLD_SIZE / 2) / WORLD_SIZE;
      const terrainH = (u >= 0 && u <= 1 && v >= 0 && v <= 1)
        ? sampleTerrainHeight(u, v) : 0;
      const above = _rayMarchPt.y >= terrainH;

      if (!above && prevAbove) {
        // Bisect between prevT and t to refine the crossing point.
        let lo = prevT, hi = t;
        for (let j = 0; j < 6; j++) {
          const mid = (lo + hi) * 0.5;
          raycaster.ray.at(mid, _rayMarchPt);
          const mu = (_rayMarchPt.x + WORLD_SIZE / 2) / WORLD_SIZE;
          const mv = (_rayMarchPt.z + WORLD_SIZE / 2) / WORLD_SIZE;
          if (_rayMarchPt.y >= sampleTerrainHeight(mu, mv)) lo = mid; else hi = mid;
        }
        raycaster.ray.at(lo, hitPoint);
        break;
      }
      prevT    = t;
      prevAbove = above;
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

  // In a game it is never active: no wheel capture, double-click focus, fly
  // mode or focus key. The controller turns OrbitControls' own zoom off (it
  // zooms itself), so a game gets it back and decides for itself.
  editorCamera = createEditorCameraController({
    camera,
    controls,
    domElement: renderer.domElement,
    isActive: () => isEditor && !playMode.active,
    pickWorldAtClient,
    getSelectionFocus: () => tc.object?.position ?? null,
  });
  if (!isEditor) controls.enableZoom = true;

  /** Match v2 mouse map in tool modes; view mode also allows LMB drag (navigation). */
  function syncOrbitMouseBindings() {
    if (!isEditor || !editorCamera || playMode.active || editorCamera.flyMode) return;
    const viewNav = editorMode === "view";
    controls.mouseButtons.LEFT   = viewNav ? THREE.MOUSE.ROTATE : null;
    controls.mouseButtons.MIDDLE = THREE.MOUSE.ROTATE;
    controls.mouseButtons.RIGHT  = THREE.MOUSE.PAN;
  }

  syncEditorOrbitEnabled = () => {
    if (!isEditor) return;   // a game sets controls.enabled itself
    controls.enabled = !playMode.active && !editorCamera.flyMode;
    syncOrbitMouseBindings();
  };

  // Same as v2: disable orbit only while actively dragging the gizmo.
  tc.addEventListener("mouseDown", () => {
    if (tc.enabled) controls.enabled = false;
    // A prop drag is one undo step (propSys.endEdit runs in _onGizmoDragEnd).
    if (_gizmoTarget === "prop") propSys.beginEdit();
  });
  tc.addEventListener("mouseUp", () => {
    syncEditorOrbitEnabled();
    if (_gizmoTarget === "decal") decalEditor?.gizmoEnd();
    if (_gizmoTarget === "waterfall") waterfallEditor?.gizmoEnd();
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

  // A ruler of identical casters for judging the cascades by eye (World panel →
  // Shadows). Built lazily on first show; nothing exists until you ask for it.
  if (isEditor) {
    shadowTest = createShadowTestScene({
      scene,
      getWorldHeight: (wx, wz) => terrainStoreAdapter.getWorldHeight(wx, wz),
    });
  }

  // Projected decals: one instanced draw, painted onto whatever is inside each box.
  const decalSystem = new DecalSystem({ scene, resolveUrl: (ref) => projectAssets.resolveUrl(ref) });
  if (isEditor) {
    decalEditor = createDecalEditor({
      system: decalSystem,
      scene,
      attachGizmo: (_decal, proxy) => {
        applyGizmoSettings();
        tc.attach(proxy);
        tc.enabled = true;
        tc.visible = true;
        _gizmoTarget = "decal";
      },
      detachGizmo: () => { if (_gizmoTarget === "decal") _detachGizmo(); },
      onChanged: () => decalUi?.rebuild(),
    });
    if (decalPanel) decalUi = buildDecalPanel(decalPanel, {
      system: decalSystem,
      editor: decalEditor,
      onImportTexture: async (file) => {
        const ref = await projectAssets.addRef(file);
        await decalSystem.addSlot({ name: file.name.replace(/\.[^.]+$/, ""), albedoUrl: ref, normalUrl: null });
        decalEditor.place.slot = decalSystem.textures.slots.length - 1;
        decalUi?.rebuild();
      },
      onNormalMap: async (slot, file) => {
        await decalSystem.updateSlot(slot, { normalUrl: file ? await projectAssets.addRef(file) : null });
        decalUi?.rebuild();
      },
      onRemoveSlot: async (slot) => {
        const name = decalSystem.textures.slots[slot]?.name ?? "this texture";
        const users = decalSystem.decals.filter((d) => d.slot === slot).length;
        if (users && !window.confirm(`${users} decal${users === 1 ? " uses" : "s use"} “${name}”. They will switch to the first texture. Remove it?`)) return;
        await decalSystem.removeSlot(slot);
        decalEditor.place.slot = Math.min(decalEditor.place.slot, decalSystem.textures.slots.length - 1);
        // Undo steps from before hold the old texture numbering.
        decalEditor.history.reset();
        decalUi?.rebuild();
      },
      onSlotRenamed: () => sceneOutliner?.update(true),
    });
  }

  // Late-init systems — loop starts before these exist; noop until wired below.
  const _noopUpdate = { update() {} };
  let propInstancer = _noopUpdate;
  let livePropManager = _noopUpdate;
  let collectibleRuntime = null;
  let collectibleBurst = null;
  // splineSys assigned below (SplineSystem); starts as noop until wired.
  if (!splineSys) splineSys = _noopUpdate;
  let propLod = { lod0Distance: 60, lod1Distance: 150, fadeOutDistance: 500, castShadow: true };
  let _lastCsmShadowFar = -1;

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
    // Same scene-depth rule as the frame loop (see there): the precompile frame
    // must not draw water or decals straight onto the multisampled canvas.
    worldEnv?.postFxPipeline?.setSceneDepthRequired(
      decalSystem.decals.length > 0 || (lakeSystem?.lakes.length ?? 0) > 0 || (riverV2System?.rivers.length ?? 0) > 0
        || (waterfallSystem?.falls.length ?? 0) > 0,
    );
    await renderer.compileAsync(scene, camera);
    if (worldEnv) worldEnv.renderFrame(0);
    else renderer.render(scene, camera);
  } catch (err) {
    console.warn("[V3] Pipeline precompile failed:", err);
  }

  bootstrapEditorInput();

  const _lodSnapVec = new THREE.Vector3();
  let _lastFrameMs = performance.now();
  let _loopErrors = 0;
  let _lastWidgetRefresh = 0;
  let _noEnvTimeSec = 0;
  const _preRenderHooks = [];
  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const dt  = Math.min((now - _lastFrameMs) / 1000, 0.05);
    _lastFrameMs = now;

    renderer.info.reset();

    try {
      if (playMode.active) {
        treeBvh?.ensureBaked();
        playMode.update(dt);
        refreshPlayStats();
        flyHud?.update(playMode.getFlightHudState?.(), dt);

        const pp = playMode.playerPosition;
        _lodSnapVec.set(
          Math.round(pp.x / LOD_SNAP) * LOD_SNAP,
          0,
          Math.round(pp.z / LOD_SNAP) * LOD_SNAP,
        );
        lod.update(_lodSnapVec);

        // Snow deformation — update trail RT and anchor before the main render
        snowSystem.updateAnchor(pp.x, pp.z);
        const _hasLocalSnow = snowMap.hasSnowNear(
          pp.x,
          pp.z,
          snowSystem.params.trailWorldSize * 0.5 + Math.max(2, snowSystem.params.stampRadius),
        );
        snowSystem.setDeformActive(_hasLocalSnow);
        const _snowStats    = playMode.getStats();
        const _snowGrounded = !!_snowStats.grounded && _snowStats.grounded !== "fly";
        const _snowContacts = playMode.getSnowContacts?.() ?? null;
        const _mm = playMode.moveMode;
        if (!_snowContacts) {
          snowSystem.params.stampRadius =
            (_mm === "car" || _mm === "stunt" || _mm === "game") ? 1.2 :
            _mm === "ball" ? 0.5 : 0.3;
        }
        if (_hasLocalSnow) snowSystem.tick(pp.x, pp.z, _snowGrounded, _snowContacts);
        // The light that actually lights the scene (the moon at night).
        snowSystem.updateSunDir(getLightDir());

        collectibleRuntime?.update(dt, pp, _mm);
      } else {
        if (isPainting && editorMode === "sculpt") {
          const hit = getUV();
          if (hit) applySculptStroke(hit.u, hit.v);
        }
        editorCamera.update(dt);
        // The camera, not the orbit pivot: looking at something far from the
        // pivot used to put 8-16 m quads right under the viewer, which is
        // where the metre-sized float on sculpted ground came from.
        lod.update(camera.position);
        if (!editorCamera.flyMode) controls.update();
        if (isEditor && !editorCamera.flyMode && !controls.enabled) syncEditorOrbitEnabled();
        // Sculpting under the marker must not bury it — re-drape every frame.
        spawnSystem.refreshHeight();
      }

      // Branch gates: the terrain shader skips the splat and snow blocks
      // entirely while their maps are empty. The checks are cached CPU flags —
      // a scan only runs on the first frame after an edit invalidates one.
      syncCursorFalloff();
      splatOverlay.uHasPaint.value = splatMap.hasAnyPaint() ? 1 : 0;
      // Terrain holes: attaches/detaches the discard mask (one recompile per flip).
      lod.setHolesEnabled(splatMap.hasAnyHoles());
      snowSystem.shared.u.uHasSnow.value = snowMap.hasAnySnow() ? 1 : 0;

      // Re-bake the terrain normal map only when the heightmap actually
      // changed. getHeightVersion() counts every write to the canonical height
      // RT, so sculpting, erosion, undo/redo and project loads all invalidate
      // it without any of them having to know this exists.
      const _hv = sculpt.getHeightVersion();
      if (tunnelSystem?.tunnels.length) {
        if (_hv !== _tunnelHolesHv) { _tunnelHolesHv = _hv; _tunnelHolesDue = now + 400; }
        if (_tunnelHolesDue && now >= _tunnelHolesDue && !_rendererSideWork && !tunnelSystem.dragging) {
          _tunnelHolesDue = 0;
          void ensureCpuHeightmapFromGpu().then(() => tunnelSystem.onTerrainChanged());
        }
      }
      if (_hv !== _lastNormalBakeVersion && !_rendererSideWork) {
        _lastNormalBakeVersion = _hv;
        terrainNormals.bake();
        // Grass surface rides the same gate — one bake per edit, on the GPU.
        grassTerrainData.bakeSurface();
      }
      if (!_rendererSideWork) {
        const blocksGrass = textureLib.blocksGrassFlags();
        syncGrassTintLayers(blocksGrass);
        grassTerrainData.updateDensityMask(blocksGrass);
        flowerDensity.updateMask(blocksGrass);
        foliageDensity.updateMask(blocksGrass);
      }

      bakeGrassTintIfNeeded();
      waterSurfaceMap.bakeIfNeeded(renderer);
      // Which grass system the world runs. Only the chosen one is built, and
      // the other one's rings/tile are disabled rather than disposed, so
      // comparing the two is a dropdown, not a reload.
      const _revoMode = grassState.system === "revo";
      if (_revoMode && !revoGrass && !_revoBuilding
          && grassTerrainData.hasGrassData && !_rendererSideWork) {
        void ensureRevoGrassBuilt();
      }
      if (_revoMode && (!revoGrass || !grassTerrainData.hasGrassData)) {
        // Nothing to hand off to yet: the ground must not tint itself green
        // while the tile is still building or the world is unpainted.
        grassFarShading.setActive(false);
      }
      if (revoGrass) {
        const wantRevo = _revoMode && grassTerrainData.hasGrassData && _terrainVisible;
        if (wantRevo !== revoGrass.enabled) revoGrass.setEnabled(wantRevo);
        if (wantRevo) {
          const _revoAnchor = grassViewAnchor(revoGrassState.tileSize);
          grassFarShading.setActive(true);
          grassFarShading.setAnchor(_revoAnchor);
          grassPush.setAnchor(_revoAnchor.x, _revoAnchor.z);
          if (playMode.active) _stampPlayerGrass();
          grassPush.update(dt);
          revoGrass.update(_revoAnchor, camera);
        }
      }
      if (grassRings && _revoMode) {
        // The rings stop dispatching the moment the other system takes over.
        if (_grassRingsEnabled !== "revo") {
          _grassRingsEnabled = "revo";
          for (const r of grassRings) r.setEnabled(false);
        }
      } else if (grassRings) {
        // Only spend compute + draws when there is grass to show. update() is
        // what dispatches the per-ring compute, and it early-returns while the
        // ring is disabled — measured 4 compute dispatches/frame -> 0, and the
        // 4 indirect draws go with them. Edge-triggered so setEnabled is only
        // touched when the answer actually changes.
        // `_terrainVisible` is in here rather than only on the mesh's .visible
        // because grass costs COMPUTE, not just draws — a hidden ring that still
        // ran update() would keep dispatching for blades nobody can see, and
        // grass with no ground under it is the one thing that looks broken
        // rather than absent.
        const wantGrass = grassTerrainData.hasGrassData && _terrainVisible;
        const _grassKey = `${wantGrass}|${grassState.farBlades !== false}`;
        if (_grassKey !== _grassRingsEnabled) {
          _grassRingsEnabled = _grassKey;
          for (const r of grassRings) r.setEnabled(_ringWanted(r, wantGrass));
        }
        grassFarShading.setActive(wantGrass);
        if (wantGrass) {
          // The rings are NOT led like the revo tile: they are concentric and
          // the innermost is only tens of metres across, so sliding the centre
          // forward would empty the ground under the camera. They already reach
          // 200 m, which is the problem the lead exists to solve.
          const _grassAnchor = playMode.active ? playMode.playerPosition : camera.position;
          grassFarShading.setAnchor(_grassAnchor);
          grassPush.setAnchor(_grassAnchor.x, _grassAnchor.z);
          if (playMode.active) _stampPlayerGrass();
          grassPush.update(dt);
          for (const r of grassRings) r.update(_grassAnchor, camera);
        }
      }
      if (cliffGrassRings) {
        // Only spend compute when there's both a baked cliff surface and paint.
        const wantCliff = grassTerrainData.hasCliffData && grassTerrainData.hasCliffSurface && _terrainVisible;
        const _cliffKey = `${wantCliff}|${grassState.farBlades !== false}`;
        if (_cliffKey !== _cliffRingsEnabled) {
          _cliffRingsEnabled = _cliffKey;
          for (const r of cliffGrassRings) r.setEnabled(_ringWanted(r, wantCliff));
        }
        if (wantCliff) {
          const _cliffAnchor = playMode.active ? playMode.playerPosition : camera.position;
          for (const r of cliffGrassRings) r.update(_cliffAnchor, camera);
        }
      }
      if (susukiSystem) {
        // Only spend compute while any susuki is painted.
        const wantSusuki = grassTerrainData.hasSusukiData;
        susukiSystem.setEnabled(wantSusuki);
        if (wantSusuki) {
          const _susukiAnchor = playMode.active ? playMode.playerPosition : camera.position;
          if (susukiState.autoDistances !== false) {
            const band = viewGroundBand();
            // A tall plant is visible further than a ground one of the same
            // screen size, so its steps sit further out for the same view.
            susukiSystem.field.setViewDistances(band.near * 1.2, band.far * 1.25);
          }
          susukiSystem.setShadowCameras(scatterShadowCameras(susukiState.shadowDistance ?? 35));
          susukiSystem.update(_susukiAnchor, camera);
        }
      }
      // The far-field tint follows the paint, whether or not the 3D flowers are built yet.
      flowerTintShading.setActive(flowerDensity.hasData);
      if (flowerSystem) {
        // Only spend compute while any flower is painted.
        const wantFlowers = flowerDensity.hasData && _terrainVisible;
        flowerSystem.setEnabled(wantFlowers);
        if (wantFlowers) flowerSystem.update(playMode.active ? playMode.playerPosition : camera.position, camera);
      }
      // Placed plants breathe with the world's wind; a handful of uniforms.
      if (_plantSway.size) syncAllPlantSway();
      if (foliageScatter) {
        // Only spend compute while any foliage is painted.
        const wantFoliage = foliageDensity.hasData && _terrainVisible;
        foliageScatter.setEnabled(wantFoliage);
        if (wantFoliage && _foliageUsedDirty) {
          _foliageUsedDirty = false;
          foliageScatter.field.setUsedTypes(foliageDensity.usedChannels());
        }
        if (wantFoliage) {
          // The camera decides the LOD steps and the fade window; the map keeps
          // the BUDGET (tile size and plant count), which is a cost decision
          // rather than a view one. `autoDistances: false` hands them back to
          // the panel sliders.
          if (foliageScatterState.autoDistances !== false) {
            const band = viewGroundBand();
            foliageScatter.field.setViewDistances(band.near, band.far);
          }
          foliageScatter.setShadowCameras(scatterShadowCameras(foliageScatterState.shadowDistance));
          foliageScatter.update(playMode.active ? playMode.playerPosition : camera.position, camera);
        }
      }
      // Ambient FX: one compute and one draw, and only while something is
      // budgeted. The sun moves, so its direction is refreshed every frame
      // rather than only on a panel edit — it is two uniform writes.
      if (ambientFx) {
        const wantAmbient = ambientFxState.enabled && ambientFx.anyLive && _terrainVisible;
        ambientFx.setEnabled(wantAmbient);
        if (wantAmbient) {
          ambientFx.u.uSunDir.value.copy(getLightDir()).normalize();
          ambientFx.setHour(worldToolState.proceduralSky?.timeOfDay ?? 12);
          ambientFx.setViewportHeight(renderer.domElement.height);
          ambientFx.update(
            playMode.active ? playMode.playerPosition : camera.position,
            camera, dt, ambientFxState.forwardOffset,
          );
        }
      }

      // The shadow map only reaches CSM maxFar; props past it need not cast.
      if (worldToolState.csm.maxFar !== _lastCsmShadowFar) {
        _lastCsmShadowFar = worldToolState.csm.maxFar;
        propInstancer.setShadowDistance?.(_lastCsmShadowFar);
      }
      // Per-cascade prop shadow lists. Read live: the node is REBUILT whenever
      // the cascade count changes, and it is null while CSM is off, which is
      // the instancer's cue to fall back to the whole-tier gate above.
      propInstancer.setShadowCsm?.(
        worldToolState.csm.enabled ? (worldEnv?.getCsm?.() ?? null) : null,
      );
      propInstancer.update(camera, propLod);
      // Cheap, and only while the ruler is on screen: it recolours its stations
      // from the live cascade bands, so dragging Near split moves the colours.
      if (shadowTest?.visible && (++_shadowTestTick & 15) === 0) {
        shadowTest.syncFromCsm(worldEnv?.describeCsm?.() ?? null);
      }
      decalSystem.update(camera);
      livePropManager.update(dt);
      splineSys.update(dt);
      // Cheap poll: rebuilds the spline-object BVHs only when a feature is
      // added, edited, moved or deleted (string-compare on a signature).
      splineFeatureStore?.refresh();
      riverV2System?.update(dt);
      if (waterfallSystem) {
        // Sun colour and strength follow the day/night cycle (the direction comes
        // through worldEnv's water-surface hook, or below without an environment).
        if (worldEnv?.sun) waterfallSystem.setSunLight(worldEnv.sun.color, worldEnv.sun.intensity);
        else waterfallSystem.setSunDir(getLightDir());
        if (worldEnv?.hemi) waterfallSystem.setAmbient(worldEnv.hemi.color, worldEnv.hemi.intensity);
        waterfallSystem.update(dt, camera);
        waterfallEditor?.frame();
      }
      tunnelSystem?.update();
      if (isEditor) _sceneListFrame?.();
      // Tunnel collision: cheap poll, rebuilds a BVH only when a tunnel mesh changed.
      tunnelColliderStore?.refresh();
      roadSystem?.update();

      tickPerf(perf, now, dt * 1000);
      // The clipmap rings are merged into one mesh, so children.length is always
      // 1 now; report the ring count, which is what this readout meant.
      perf.activeChunks = LOD_LEVELS;
      if (worldEnv) {
        worldEnv.updateFrame(dt);
        // Sea-floor caustics follow the V2 ocean (on/off, sea level, reach).
        // Only V2 has them — the classic ocean is left exactly as it was.
        const oceanV2 = worldEnv.getOceanV2?.();
        lakebedShading.setOcean(
          oceanV2 && worldToolState.worldOcean.mode === "v2" ? oceanV2.getCausticsState() : null,
        );
      } else {
        // The environment normally drives the depth-buffer water surfaces: the
        // light direction for all three, and the lakes' clock. Without it, here.
        _noEnvTimeSec += dt;
        const ld = getLightDir();
        lakeSystem?.setSunDir(ld);
        riverV2System?.setSunDir(ld);
        lakeSystem?.updateWater(dt, _noEnvTimeSec);
      }
      // worldEnv has no getSunDir: these were always handed `undefined`, so
      // tree impostors, leaf cards and foliage kept a fixed default light
      // direction whatever the sun did. The light that lights the scene now.
      const _lightDir = getLightDir();
      treeEnv.updateFrame(camera, _lightDir, now * 0.001);
      // After updateFrame moved the sun, before anything renders with it.
      if (!_rendererSideWork) terrainShadowMap.bakeIfNeeded(sculpt.getHeightVersion());
      bvhDebug?.update();
    } catch (err) {
      if (++_loopErrors === 1) console.error("[V3] Frame update error:", err);
    }

    try {
      renderer.setRenderTarget(null);
      for (const hook of _preRenderHooks) hook(dt);
      // Water and decals read a copy of the scene depth, which cannot come out
      // of the multisampled canvas: while any is in the scene, the frame goes
      // through a non-multisampled scene pass even with post FX off.
      worldEnv?.postFxPipeline?.setSceneDepthRequired(
        decalSystem.visibleCount > 0 || (lakeSystem?.lakes.length ?? 0) > 0 || (riverV2System?.rivers.length ?? 0) > 0
          || (waterfallSystem?.visibleCount ?? 0) > 0,
      );
      if (!_rendererSideWork && worldEnv) {
        worldEnv.renderFrame(dt);
      } else if (!_rendererSideWork) {
        renderer.render(scene, camera);
      }
    } catch (err) {
      if (++_loopErrors === 1) {
        console.error("[V3] Render error:", err);
        const vp = viewport;
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
      // Dropout detector: a draw that silently skips a frame shows up as a
      // one-frame triangle-count dip. window.__triWatch.dips collects them.
      {
        const w = (window.__triWatch ??= { prev: 0, dips: [] });
        if (w.prev > 50 && ktris < w.prev * 0.85 && w.dips.length < 80) {
          w.dips.push({ t: Math.round(now), prevK: Math.round(w.prev), curK: Math.round(ktris) });
        }
        w.prev = ktris;
        w.draws = draws;
      }
      _maxDraw = Math.max(_maxDraw, draws);
      _maxTri  = Math.max(_maxTri,  ktris);
      drawPanel.update(draws, _maxDraw, 0);
      drawPanel.updateGraph(draws, _maxDraw);
      triPanel.update(ktris, _maxTri, 0);
      triPanel.updateGraph(ktris, _maxTri);
      stats.update();
      statusBar?.update({
        now,
        frameMs: perf.fps > 0 ? 1000 / perf.fps : perf.frameMs,
        draws,
        triangles: ri.triangles ?? 0,
        camera: camera.position,
        fly: !!editorCamera?.flyMode,
        // The dropdown's label without its "(key)" hint.
        modeLabel: playMode.active ? "Playing" : (toolsModeSelect.selectedOptions[0]?.textContent ?? editorMode).replace(/\s*\([^)]*\)\s*$/, ""),
      });
    } catch (_) { /* stats overlay must never block the viewport */ }

    // Panel controls follow values changed elsewhere (undo, load, presets,
    // the Inspector, time of day advancing). A few times a second is plenty.
    if (isEditor && now - _lastWidgetRefresh >= 250 && !playMode.active) {
      _lastWidgetRefresh = now;
      try { refreshWidgets(); } catch (err) { if (++_loopErrors === 1) console.error("[V3] Panel refresh error:", err); }
    }
  });

  // ── Ramp preview: line from the placed start point to the cursor ───────────
  const rampPreviewLine = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
    new THREE.LineBasicMaterial({ color: 0xffe066, depthTest: false, transparent: true, opacity: 0.9 }),
  );
  rampPreviewLine.renderOrder = 999;
  rampPreviewLine.frustumCulled = false;
  rampPreviewLine.visible = false;
  scene.add(rampPreviewLine);

  const _rampPtA = new THREE.Vector3();
  const _rampPtB = new THREE.Vector3();
  function updateRampPreview(endUV) {
    if (rampState !== "waiting_end" || stickyMode !== "ramp" || !rampStartUV || !endUV) {
      rampPreviewLine.visible = false;
      return;
    }
    _rampPtA.set(
      (rampStartUV.u - 0.5) * WORLD_SIZE,
      sampleTerrainHeight(rampStartUV.u, rampStartUV.v) + 1.5,
      (rampStartUV.v - 0.5) * WORLD_SIZE,
    );
    _rampPtB.set(
      (endUV.u - 0.5) * WORLD_SIZE,
      sampleTerrainHeight(endUV.u, endUV.v) + 1.5,
      (endUV.v - 0.5) * WORLD_SIZE,
    );
    rampPreviewLine.geometry.setFromPoints([_rampPtA, _rampPtB]);
    rampPreviewLine.visible = true;
  }

  // -- Region copy-paste: outline + copy + paste ----------------------------
  const REGION_EDGE_PTS = 24;
  // A plain Line closed by repeating its first point: three's WebGPU renderer
  // does not draw LineLoop at all (it logs an error every frame instead).
  const regionOutline = new THREE.Line(
    new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(new Float32Array((REGION_EDGE_PTS * 4 + 1) * 3), 3)),
    new THREE.LineBasicMaterial({ color: 0xffe066, depthTest: false, transparent: true, opacity: 0.95 }),
  );
  regionOutline.renderOrder = 999;
  regionOutline.frustumCulled = false;
  regionOutline.visible = false;
  scene.add(regionOutline);
  _regionOutlineReady = true;
  let _regionCursor = null;   // last cursor hit {u, v}

  const _wToU = (x) => (x + WORLD_SIZE / 2) / WORLD_SIZE;
  const _groundAt = (x, z) => {
    const u = _wToU(x), v = _wToU(z);
    return (u >= 0 && u <= 1 && v >= 0 && v <= 1) ? sampleTerrainHeight(u, v) : 0;
  };
  /** Points around a rectangle (centre, half sizes, angle), `per` per edge, on the ground. */
  function _rectRing(cx, cz, hw, hh, angle, per, lift = 1.5) {
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const corners = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
    const pts = [];
    for (let e = 0; e < 4; e++) {
      const [ax, az] = corners[e], [bx, bz] = corners[(e + 1) % 4];
      for (let i = 0; i < per; i++) {
        const t = i / per;
        const lx = ax + (bx - ax) * t, lz = az + (bz - az) * t;
        const x = cx + lx * cos - lz * sin, z = cz + lx * sin + lz * cos;
        pts.push(x, _groundAt(x, z) + lift, z);
      }
    }
    return pts;
  }
  function _setOutline(pts, color) {
    const attr = regionOutline.geometry.getAttribute("position");
    attr.array.set(pts);
    attr.array.set(pts.slice(0, 3), pts.length);    // close the ring
    attr.needsUpdate = true;
    regionOutline.material.color.setHex(color);
    regionOutline.visible = true;
  }
  function regionHideOutline() { _regionHideSafe(); }
  function regionRefreshOutline(hit = _regionCursor) {
    if (stickyMode !== "region" || editorMode !== "sculpt" || !hit) { regionHideOutline(); return; }
    const rs = regionState;
    const x = (hit.u - 0.5) * WORLD_SIZE, z = (hit.v - 0.5) * WORLD_SIZE;
    if (rs.dragStart) {
      const x0 = Math.min(rs.dragStart.x, x), x1 = Math.max(rs.dragStart.x, x);
      const z0 = Math.min(rs.dragStart.z, z), z1 = Math.max(rs.dragStart.z, z);
      _setOutline(_rectRing((x0 + x1) / 2, (z0 + z1) / 2, (x1 - x0) / 2, (z1 - z0) / 2, 0, REGION_EDGE_PTS), 0xffe066);
    } else if (rs.clip) {
      _setOutline(_rectRing(x, z, rs.clip.worldW / 2, rs.clip.worldH / 2, rs.angleDeg * Math.PI / 180, REGION_EDGE_PTS), 0x66ddff);
    } else {
      regionHideOutline();
    }
  }
  /** Mean ground height along a rectangle's edge — what "Match ground" lines up. */
  function _borderMean(cx, cz, hw, hh, angle) {
    const pts = _rectRing(cx, cz, hw, hh, angle, 16, 0);
    let sum = 0;
    for (let i = 1; i < pts.length; i += 3) sum += pts[i];
    return sum / (pts.length / 3);
  }
  function regionFinishCopy(hit) {
    const rs = regionState;
    const start = rs.dragStart;
    rs.dragStart = null;
    if (!start || !hit) { regionRefreshOutline(); return; }
    const x = (hit.u - 0.5) * WORLD_SIZE, z = (hit.v - 0.5) * WORLD_SIZE;
    const x0 = Math.min(start.x, x), x1 = Math.max(start.x, x);
    const z0 = Math.min(start.z, z), z1 = Math.max(start.z, z);
    if (x1 - x0 < 4 || z1 - z0 < 4) { regionRefreshOutline(); return; }   // a click, not a selection
    const S = HEIGHTMAP_SIZE;
    const rect = {
      x: Math.floor(_wToU(x0) * S), y: Math.floor(_wToU(z0) * S),
      w: Math.ceil(_wToU(x1) * S) - Math.floor(_wToU(x0) * S),
      h: Math.ceil(_wToU(z1) * S) - Math.floor(_wToU(z0) * S),
    };
    const heights = sculpt.copyRegion(rect);
    if (!heights) { regionRefreshOutline(); return; }
    const hx0 = heights.rect.x / S * WORLD_SIZE - WORLD_SIZE / 2, hz0 = heights.rect.y / S * WORLD_SIZE - WORLD_SIZE / 2;
    const worldW = heights.rect.w / S * WORLD_SIZE, worldH = heights.rect.h / S * WORLD_SIZE;
    rs.clip?.heights?.rt?.dispose();
    rs.clip = {
      heights,
      paint: splatMap.copyRegionWorld(hx0, hz0, hx0 + worldW, hz0 + worldH),
      worldW, worldH,
      borderMean: _borderMean(hx0 + worldW / 2, hz0 + worldH / 2, worldW / 2, worldH / 2, 0),
    };
    syncRegionUi();
    regionRefreshOutline(hit);
  }
  function regionPasteAt(hit) {
    const rs = regionState;
    if (!rs.clip || !hit) return;
    const angle = rs.angleDeg * Math.PI / 180;
    const cx = (hit.u - 0.5) * WORLD_SIZE, cz = (hit.v - 0.5) * WORLD_SIZE;
    let offsetM = rs.offsetM;
    if (rs.heightMode === "match") {
      offsetM += _borderMean(cx, cz, rs.clip.worldW / 2, rs.clip.worldH / 2, angle) - rs.clip.borderMean;
    }
    const written = sculpt.pasteRegion(rs.clip.heights, {
      centerUV: hit, angle, flipX: rs.flipX, flipZ: rs.flipZ,
      offsetNorm: offsetM / MAX_HEIGHT,
      featherUV: rs.featherM / WORLD_SIZE,
    });
    if (!written) return;
    if (rs.paint && rs.clip.paint) {
      const o = { centerX: cx, centerZ: cz, angle, flipX: rs.flipX, flipZ: rs.flipZ, featherM: rs.featherM };
      const clipPaint = rs.clip.paint;
      const res = splatMap.pasteRegion(clipPaint, o);
      if (res) {
        sculpt.attachToStroke({
          undo: () => splatMap.pasteRect(res.before),
          redo: () => { splatMap.pasteRegion(clipPaint, o); },
        });
      }
    }
    sculpt.endStroke();
    onHistoryChange();
  }
  // Clone source ring: where the brush is copying FROM, brush-sized, on the ground.
  const CLONE_RING_PTS = 48;
  const cloneRing = new THREE.Line(
    new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(new Float32Array((CLONE_RING_PTS + 1) * 3), 3)),
    new THREE.LineBasicMaterial({ color: 0xff55dd, depthTest: false, transparent: true, opacity: 0.95 }),
  );
  cloneRing.renderOrder = 999;
  cloneRing.frustumCulled = false;
  cloneRing.visible = false;
  scene.add(cloneRing);
  _cloneRingReady = true;
  function cloneRefreshRing(hit) {
    const cs = cloneState;
    if (stickyMode !== "clone" || editorMode !== "sculpt" || !cs.source) { _cloneHideSafe(); return; }
    let cx = cs.source.x, cz = cs.source.z;
    const off = cs.strokeOffset ?? (cs.aligned ? cs.offset : null);
    if (off && hit) { cx = (hit.u - 0.5) * WORLD_SIZE + off.x; cz = (hit.v - 0.5) * WORLD_SIZE + off.z; }
    const r = sculpt.uRadius.value * WORLD_SIZE;
    const arr = cloneRing.geometry.getAttribute("position");
    for (let i = 0; i <= CLONE_RING_PTS; i++) {
      const t = (i / CLONE_RING_PTS) * Math.PI * 2;
      const x = cx + Math.cos(t) * r, z = cz + Math.sin(t) * r;
      arr.setXYZ(i, x, _groundAt(x, z) + 1.5, z);
    }
    arr.needsUpdate = true;
    cloneRing.visible = true;
  }

  // A drag released outside the canvas still finishes the selection.
  window.addEventListener("mouseup", (e) => {
    if (e.button !== 0 || !regionState.dragStart) return;
    refreshMouse(e);
    regionFinishCopy(getUV() ?? _regionCursor);
  });

  function cancelRampPlacement() {
    rampState = "idle";
    rampStartUV = null;
    rampPreviewLine.visible = false;
    rampHint.textContent = "Click start point...";
  }

  let lastReadbackMs = 0;
  renderer.domElement.addEventListener("mousemove", e => {
    if (playMode.active || editorMode !== "sculpt") return;
    syncPointerMods(e);
    refreshModeIndicator();
    refreshMouse(e);
    const hit = getUV();
    const noRing = stickyMode === "mirror" || stickyMode === "region";
    uCursorUV.value.set(hit && !noRing ? hit.u : -2, hit && !noRing ? hit.v : -2);
    updateRampPreview(hit);
    if (stickyMode === "region") { if (hit) _regionCursor = hit; regionRefreshOutline(hit); }
    if (stickyMode === "clone") cloneRefreshRing(hit);
    // Throttled readback so the cursor ring stays accurate while hovering.
    const now = performance.now();
    if (now - lastReadbackMs > 150) { lastReadbackMs = now; requestHeightmapReadback(); }
  });

  renderer.domElement.addEventListener("mouseleave", () => {
    uCursorUV.value.set(-2, -2);
    if (isPainting) { cloneClosePaint(); sculpt.endStroke(); }
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

    // Set Height eyedropper: copy the ground height, never sculpt on this click.
    if (_pickingHeight) {
      const uvHit = getUV();
      if (uvHit) {
        const hM = Math.round(sampleHeightNormalized(uvHit.u, uvHit.v) * MAX_HEIGHT * 100) / 100;
        flattenState.heightM = hM;
        if (numFlattenHeight) numFlattenHeight.value = hM;
        setFlattenFixed(true);
      }
      setPickingHeight(false);
      return;
    }

    // Mirror has no stroke: clicking the ground does nothing, Apply does the work.
    if (stickyMode === "mirror") return;

    // Clone: Alt+click picks the source; a plain drag clones from it.
    if (stickyMode === "clone") {
      const uvHit = getUV();
      if (!uvHit) return;
      if (e.altKey) { cloneSetSource(uvHit); return; }
      if (!cloneBeginStroke(uvHit)) return;
      sculpt.beginStroke();
      isPainting = true;
      lastPaintUV = null;
      return;
    }

    // Region: with nothing copied a drag selects; with a copy every click pastes.
    if (stickyMode === "region") {
      const uvHit = getUV();
      if (!uvHit) return;
      _regionCursor = uvHit;
      if (regionState.clip) {
        regionPasteAt(uvHit);
      } else {
        regionState.dragStart = { x: (uvHit.u - 0.5) * WORLD_SIZE, z: (uvHit.v - 0.5) * WORLD_SIZE };
        regionRefreshOutline(uvHit);
      }
      return;
    }

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
        sculpt.endStroke();
        onHistoryChange();
        cancelRampPlacement();
      }
      return;
    }

    sculpt.beginStroke();
    isPainting = true;
    lastPaintUV = null;
    _flattenLocked = false; // next flatten stamp re-captures its target height
  });

  renderer.domElement.addEventListener("mouseup", e => {
    if (e.button !== 0) return;
    isPainting = false;
    lastPaintUV = null;
    cloneClosePaint();  // the clone's paint joins this stroke's undo step
    sculpt.endStroke(); // close the stroke → push its dirty-rect undo entry
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
      sculpt.uRadius.value = Math.max(BRUSH_MIN_M / WORLD_SIZE, Math.min(0.4, sculpt.uRadius.value * factor));
      slSize.value = Math.round(sculpt.uRadius.value * WORLD_SIZE);
      syncSizeUI();
    } else {
      sculpt.uStrength.value = Math.max(0.001, Math.min(0.05, sculpt.uStrength.value * factor));
      slStr.value = Math.round(sculpt.uStrength.value * 1000);
      syncStrUI();
    }
  }, { passive: false, capture: true });

  // Seed CPU heightmap mirror after boot — not during first user interaction.
  setTimeout(() => requestHeightmapReadback(), 0);

  // (Pending cross-size imports are applied at the end of boot, once every
  // system that a project file touches — trees, props, roads, splines — exists.)

  function cancelStroke() {
    if (isPainting) { cloneClosePaint(); sculpt.endStroke(); }
    isPainting = false;
    lastPaintUV = null;
  }

  function onHistoryChange() {
    cancelStroke();
    treeEnv.syncTreeHeights();
    markHeightmapDirty();
    requestHeightmapReadback();
  }

  /*
   * Undo/redo follow the current mode: each tool keeps its own history. A mode
   * with no history of its own (view, sculpt, spawn...) undoes the terrain, and
   * so do snow, grass, susuki, rivers, tunnel, spline, road and lake once their
   * own history is empty. Paint, props, cliff paint, trees and foliage never
   * fall through. Ctrl+Z/Y and the toolbar buttons both come here.
   */
  function undoInMode() { return _stepInMode("undo"); }
  function redoInMode() { return _stepInMode("redo"); }

  function _stepInMode(dir) {
    const undo = dir === "undo";
    // Snapshot stacks kept here in main.js: [from, to, take snapshot, restore].
    const stackStep = (from, to, snap, restore) => {
      if (!from.length) return false;
      to.push(snap());
      restore(from.pop());
      return true;
    };
    switch (editorMode) {
      case "paint":      return undo ? paintSys.undo() : paintSys.redo();
      case "props":      return undo ? propSys.undo() : propSys.redo();
      case "cliffPaint": return undo ? cliffPaintSystem.undo() : cliffPaintSystem.redo();
      case "treePaint":  return undo ? treeEnv.treeSystem.undo() : treeEnv.treeSystem.redo();
    }
    let done = false;
    switch (editorMode) {
      case "snow":
        done = stackStep(undo ? _snowUndoStack : _snowRedoStack, undo ? _snowRedoStack : _snowUndoStack,
          () => snowMap.snapshot(), (s) => snowMap.restoreSnapshot(s));
        break;
      case "grass": {
        // Entries are tagged with the layer they snapshot (terrain or cliff).
        const from = undo ? _grassUndoStack : _grassRedoStack;
        const to = undo ? _grassRedoStack : _grassUndoStack;
        const entry = from.at(-1);
        done = !!entry && stackStep(from, to,
          () => ({ layer: entry.layer, data: _snapGrass(entry.layer) }),
          (e) => _restoreGrass(e.layer, e.data));
        break;
      }
      case "susuki":
      case "flowers":
      case "foliage":
      case "vegPlaced": {
        const from = undo ? _vegUndoStack : _vegRedoStack;
        const to = undo ? _vegRedoStack : _vegUndoStack;
        const entry = from.at(-1);
        // The opposite step snapshots the same systems the entry restores.
        done = !!entry && stackStep(from, to, () => _vegSnapshot(Object.keys(entry)), _vegRestore);
        break;
      }
      case "ambientFx":
        done = stackStep(undo ? _ambientUndoStack : _ambientRedoStack, undo ? _ambientRedoStack : _ambientUndoStack,
          () => ambientDensity.getSnapshot(), (snap) => ambientDensity.restoreSnapshot(snap));
        break;
      case "riverv2": done = !!(undo ? riverV2System?.undo() : riverV2System?.redo()); if (done) riverV2Ui?.refresh(); break;
      case "tunnel":  done = !!(undo ? tunnelSystem?.undo() : tunnelSystem?.redo()); if (done) tunnelUi?.refresh(); break;
      case "spline":  done = !!(undo ? splineSys?.undo() : splineSys?.redo()); break;
      case "road":    done = undo ? roadHistory.undo() : roadHistory.redo(); break;
      case "lake":    done = undo ? lakeHistory.undo() : lakeHistory.redo(); break;
      case "decals":  done = !!decalEditor && (undo ? decalEditor.history.undo() : decalEditor.history.redo()); break;
      case "waterfall": done = !!waterfallEditor && (undo ? waterfallEditor.history.undo() : waterfallEditor.history.redo()); break;
    }
    if (done) return true;
    if (undo ? sculpt.undo() : sculpt.redo()) { onHistoryChange(); return true; }
    return false;
  }

  // The editor's shortcuts. A game owns its keyboard, so none of these run there.
  window.addEventListener("keydown", e => {
    if (!isEditor) return;
    if (playMode.active) {
      if (e.code === "Escape") {
        if (playMode.wheelOpen || playMode.walking) return;
        exitPlay();
      }
      return;
    }
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;
    // Escape forgets the clone source.
    if (e.code === "Escape" && editorMode === "sculpt" && stickyMode === "clone" && cloneState.source && !isPainting) {
      e.preventDefault();
      cloneState.source = null;
      cloneState.offset = null;
      syncCloneUi();
      _cloneHideSafe();
      return;
    }
    // Escape cancels a region drag, or clears the copied region.
    if (e.code === "Escape" && editorMode === "sculpt" && stickyMode === "region" && (regionState.dragStart || regionState.clip)) {
      e.preventDefault();
      if (regionState.dragStart) { regionState.dragStart = null; regionRefreshOutline(); } else regionClearClip();
      return;
    }
    // Escape cancels a pending ramp start point (before mode-specific handlers).
    if (e.code === "Escape" && editorMode === "sculpt" && rampState === "waiting_end") {
      e.preventDefault();
      cancelRampPlacement();
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
    if (e.code === "KeyL" && !e.ctrlKey && !e.metaKey && !e.altKey && !playMode.active) {
      e.preventDefault();
      setEditorMode(editorMode === "lake" ? "view" : "lake");
      return;
    }
    // Matched on e.key (the printed letter) rather than e.code (the QWERTY
    // position), so the shortcut lands on H for this AZERTY keyboard too.
    if (e.key?.toLowerCase() === "h" && !e.ctrlKey && !e.metaKey && !e.altKey && !playMode.active) {
      e.preventDefault();
      setEditorMode(editorMode === "riverv2" ? "view" : "riverv2");
      return;
    }
    // Tunnel mode — e.key so it is the printed O on AZERTY too.
    if (e.key?.toLowerCase() === "o" && !e.ctrlKey && !e.metaKey && !e.altKey && !playMode.active) {
      e.preventDefault();
      setEditorMode(editorMode === "tunnel" ? "view" : "tunnel");
      return;
    }
    if (e.code === "KeyP" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      if (playMode.active) exitPlay();
      else enterPlay({ immersive: e.shiftKey });
      return;
    }
    if (e.code === "KeyK" && !e.ctrlKey && !e.metaKey && !e.altKey && !playMode.active) {
      e.preventDefault();
      setEditorMode(editorMode === "spline" ? "view" : "spline");
      return;
    }
    if (e.code === "KeyT" && !e.ctrlKey && !e.metaKey && !e.altKey && !playMode.active) {
      e.preventDefault();
      setEditorMode(editorMode === "treePaint" ? "view" : "treePaint");
      return;
    }
    // Shift+F: frame the current selection (plain F stays Foliage).
    if (e.code === "KeyF" && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && !playMode.active) {
      e.preventDefault();
      frameSelection();
      return;
    }
    if (e.code === "KeyF" && !e.ctrlKey && !e.metaKey && !e.altKey && !playMode.active) {
      e.preventDefault();
      setEditorMode(VEG_MODES.includes(editorMode) ? "view" : _lastVegMode);
      return;
    }
    if (e.code === "KeyU" && !e.ctrlKey && !e.metaKey && !e.altKey && !playMode.active) {
      e.preventDefault();
      setEditorMode(editorMode === "susuki" ? "view" : "susuki");
      return;
    }
    // Matched on the printed key, not e.code: on AZERTY the M key is not KeyM.
    if (e.key?.toLowerCase() === "m" && !e.ctrlKey && !e.metaKey && !e.altKey && !playMode.active) {
      e.preventDefault();
      setEditorMode(editorMode === "flowers" ? "view" : "flowers");
      return;
    }
    if (e.code === "KeyN" && !e.ctrlKey && !e.metaKey && !e.altKey && !playMode.active) {
      e.preventDefault();
      setEditorMode(editorMode === "spawn" ? "view" : "spawn");
      return;
    }
    // Decals — the printed C, whatever the layout.
    if (e.key?.toLowerCase() === "c" && !e.ctrlKey && !e.metaKey && !e.altKey && !playMode.active) {
      e.preventDefault();
      setEditorMode(editorMode === "decals" ? "view" : "decals");
      return;
    }
    if (editorMode === "decals" && decalEditor && !playMode.active) {
      const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
      if (e.code === "Delete" || e.code === "Backspace") { e.preventDefault(); decalEditor.deleteSelected(); return; }
      if (e.code === "Escape") { e.preventDefault(); decalEditor.deselect(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d") { e.preventDefault(); decalEditor.duplicateSelected(); return; }
      if (plain && e.code === "KeyQ") {
        e.preventDefault();
        gizmoState.space = gizmoState.space === "local" ? "world" : "local";
        applyGizmoSettings();
        return;
      }
      if (plain && _gizmoTarget === "decal") {
        const mode = { KeyW: "translate", KeyE: "rotate", KeyR: "scale" }[e.code];
        if (mode) { e.preventDefault(); tc.setMode(mode); return; }
      }
    }
    // Waterfalls — the printed G, whatever the layout.
    if (e.key?.toLowerCase() === "g" && !e.ctrlKey && !e.metaKey && !e.altKey && !playMode.active) {
      e.preventDefault();
      setEditorMode(editorMode === "waterfall" ? "view" : "waterfall");
      return;
    }
    if (editorMode === "waterfall" && waterfallEditor && !playMode.active) {
      const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
      if (e.code === "Delete" || e.code === "Backspace") { e.preventDefault(); waterfallEditor.deleteSelected(); return; }
      if (e.code === "Escape") { e.preventDefault(); waterfallEditor.deselect(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d") { e.preventDefault(); waterfallEditor.duplicateSelected(); return; }
      if (plain && _gizmoTarget === "waterfall") {
        // Move and turn only: a fall's shape comes from its panel values.
        const mode = { KeyW: "translate", KeyE: "rotate" }[e.code];
        if (mode) { e.preventDefault(); tc.setMode(mode); applyWaterfallGizmoAxes(); return; }
      }
    }
    // Delete clears the player start while spawn mode is active.
    if (editorMode === "spawn" && !playMode.active
        && (e.code === "Delete" || e.code === "Backspace")) {
      e.preventDefault();
      spawnSystem.clear();
      spawnUi?.refresh();
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
    if (editorMode === "tunnel" && !playMode.active && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d") {
      e.preventDefault();
      if (tunnelSystem?.duplicateActive()) tunnelUi?.refresh();
      return;
    }
    if (editorMode === "tunnel" && !playMode.active
        && (e.code === "Delete" || e.code === "Backspace")) {
      e.preventDefault();
      tunnelSystem?.deleteSelected();
      tunnelUi?.refresh();
      return;
    }
    if (editorMode === "riverv2" && !playMode.active
        && (e.code === "Delete" || e.code === "Backspace")) {
      e.preventDefault();
      riverV2System.deleteSelected();
      riverV2Ui?.refresh();
      return;
    }
    // Smart Road shortcuts (v2 Smart Road 2)
    if (editorMode === "road" && !playMode.active && roadSystem) {
      if (e.code === "Delete" || e.code === "Backspace") {
        e.preventDefault();
        if (roadSystem.selectedNodeId !== null) roadHistory.record(() => roadSystem.deleteNode(roadSystem.selectedNodeId));
        return;
      }
      if (e.code === "KeyJ" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        if (roadSystem.selectedNodeId !== null) roadHistory.record(() => roadSystem.cycleNodeType(roadSystem.selectedNodeId));
        return;
      }
      if (e.code === "KeyB" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        roadHistory.record(() => roadSystem.toggleBridge()); // bridge on the last-grabbed edge
        return;
      }
      // Holding +/- is one undo step, not one per key repeat.
      if (e.code === "Equal" || e.code === "NumpadAdd") {
        e.preventDefault();
        roadHistory.record(() => roadSystem.adjustNodeLift(e.shiftKey ? 0.1 : 0.5), { coalesce: "lift" });
        return;
      }
      if (e.code === "Minus" || e.code === "NumpadSubtract") {
        e.preventDefault();
        roadHistory.record(() => roadSystem.adjustNodeLift(e.shiftKey ? -0.1 : -0.5), { coalesce: "lift" });
        return;
      }
    }
    // Props mode shortcuts
    if (editorMode === "props" && !playMode.active) {
      if ((e.code === "ShiftLeft" || e.code === "ShiftRight") && !e.repeat) {
        _gizmoShiftHeld = true;
        applyGizmoSettings();
      }
      if (!e.ctrlKey && !e.metaKey && !e.altKey && e.code === "KeyQ") {
        e.preventDefault();
        gizmoState.space = gizmoState.space === "local" ? "world" : "local";
        applyGizmoSettings();
        refreshGizmoHud();
        return;
      }
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
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") {
        const clip = propSys.copySelection();
        if (clip) { e.preventDefault(); _propClipboard = clip; }
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") {
        if (!_propClipboard) return;
        e.preventDefault();
        const at = _lastMouseEvent ? getTerrainHitWorld(_lastMouseEvent) : null;
        const idx = propSys.paste(_propClipboard, at ? { x: at.x, z: at.z } : null);
        if (idx != null) activatePropSelection(idx);
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
        saveProject();
        return;
      }
      if (key === "z" && !e.shiftKey) {
        e.preventDefault();
        undoInMode();
        return;
      }
      if (key === "y" || (key === "z" && e.shiftKey)) {
        e.preventDefault();
        redoInMode();
        return;
      }
    }
  });

  window.addEventListener("keyup", (e) => {
    if (!isEditor) return;
    if (e.code === "ShiftLeft" || e.code === "ShiftRight") {
      if (_gizmoShiftHeld) {
        _gizmoShiftHeld = false;
        applyGizmoSettings();
      }
    }
  });
  window.addEventListener("blur", () => {
    if (_gizmoShiftHeld) {
      _gizmoShiftHeld = false;
      applyGizmoSettings();
    }
  });

  // Section collapse is handled by editorShell.initEditorShell() via classList.toggle("hidden").

  // ── Paint panel wiring ────────────────────────────────────────────────────

  function drawPaintMaskPreview() {
    paintBrushMask.renderPreview(pmaskPreview);
  }
  drawPaintMaskPreview();

  function refreshLayerThumb(slotIdx) {
    // The card label used to stay "L1".."L7" forever: only typing in the name
    // field updated it, so the defaults (Grass, Rock...) and names restored from
    // a project never reached the cards. Every path that changes a slot already
    // funnels through here, so the label is refreshed alongside the thumbnail.
    const label = uiById(`llabel-${slotIdx + 1}`);
    if (label) label.textContent = textureLib.slots[slotIdx].name || `L${slotIdx + 1}`;
    const thumb = uiById(`lthumb-${slotIdx + 1}`);
    if (!thumb) return;
    const slot = textureLib.slots[slotIdx];
    const url = slot.procedural ? slot.procThumbUrl : slot.albedoUrl;
    // The tint shows on the swatch too, so two layers sharing a texture can be
    // told apart: the colour multiplies the image underneath it.
    const tint = textureLib.getTintHex(slotIdx);
    if (url) {
      thumb.style.backgroundImage = `url(${url})`;
      thumb.style.backgroundColor = tint === '#ffffff' ? '' : tint;
      thumb.style.backgroundBlendMode = tint === '#ffffff' ? '' : 'multiply';
    } else {
      const [r, g, b] = textureLib.getPreviewColor(slotIdx);
      const t = parseInt(tint.slice(1), 16);
      const m = (c, sh) => Math.round(c * ((t >> sh) & 255) / 255);
      thumb.style.backgroundImage = '';
      thumb.style.backgroundBlendMode = '';
      thumb.style.backgroundColor = `rgb(${m(r, 16)},${m(g, 8)},${m(b, 0)})`;
    }
  }

  /*
   * ── THE DEFAULT PAINT LIBRARY, AND WHY A GAME MUST NOT PRELOAD IT ─────────
   *
   * Seven PBR sets, four maps each, `Promise.all`, on every boot. MEASURED on
   * the racing game: 104 MB across 44 files — 88% of everything that game
   * downloads — and it does not have a paint panel to show them in. On a
   * deployment that is most of a minute before anything appears.
   *
   * It is also largely redundant for a game: a .v3proj carries its OWN
   * paintLayers, which is what the terrain actually renders with. These are
   * the EDITOR's starting palette, and the editor is where they belong.
   *
   * `loadPaintDefaults` stays available so a game that later switches terrain
   * on can pull them in THEN, where the cost belongs to the thing that needs
   * it and a loading screen is expected.
   */
  let _paintDefaults = null;
  function loadPaintDefaults() {
    if (_paintDefaults) return _paintDefaults;
    _paintDefaults = textureLib.preloadDefaults().then(() => {
      for (let i = 0; i < 7; i++) refreshLayerThumb(i);
      syncTexlibEditor();
    }).catch(err => console.warn("Default texture preload failed:", err));
    return _paintDefaults;
  }
  if (opts.preloadPaintTextures !== false) loadPaintDefaults();

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
  pslTarget?.addEventListener("input", () => {
    paintState.targetStrength = Number(pslTarget.value) / 100;
    plblTarget.textContent = Math.round(paintState.targetStrength * 100) + "%";
  });

  // Solo & height blend
  pslSolo.addEventListener("change", () => {
    splatOverlay.uSoloLayer.value = Number(pslSolo.value);
  });
  pslHBlend.addEventListener("input", () => {
    splatOverlay.uHeightBlend.value = Number(pslHBlend.value) / 100;
    plblHBlend.textContent = splatOverlay.uHeightBlend.value.toFixed(2);
  });
  function syncMacroUi() {
    pslMacroStr.value = String(Math.round(splatOverlay.uMacroStrength.value * 100));
    plblMacroStr.textContent = splatOverlay.uMacroStrength.value.toFixed(2);
    pslMacroWarm.value = String(Math.round(splatOverlay.uMacroWarmth.value * 100));
    plblMacroWarm.textContent = splatOverlay.uMacroWarmth.value.toFixed(2);
    pslMacroScale.value = String(Math.round(splatOverlay.uMacroScale.value));
    plblMacroScale.textContent = String(Math.round(splatOverlay.uMacroScale.value));
  }
  pslMacroStr.addEventListener("input", () => {
    splatOverlay.uMacroStrength.value = Number(pslMacroStr.value) / 100;
    syncMacroUi();
    grassTintDirty = true; // the grass takes its colour from the painted ground
  });
  pslMacroWarm.addEventListener("input", () => {
    splatOverlay.uMacroWarmth.value = Number(pslMacroWarm.value) / 100;
    syncMacroUi();
    grassTintDirty = true;
  });
  pslMacroScale.addEventListener("input", () => {
    splatOverlay.uMacroScale.value = Number(pslMacroScale.value);
    syncMacroUi();
    grassTintDirty = true;
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
      const texlibSection = uiById("texlib-body");
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
    textureLib.loadFileAutoDetect(slotIdx, file).then(() => {
      refreshLayerThumb(slotIdx);
      // A drop turns a procedural slot back into an image slot.
      if (slotIdx === texlibActiveSlot) syncTexlibEditor();
    }).catch((err) => {
      // A packed ARM map is refused rather than taken as colour — say so.
      statusBar?.setMessage(`${file.name}: ${err.message}`);
      console.warn("[V3] texture drop:", file.name, err.message);
    });
  });

  // Texture library slot tabs
  texlibTabsEl.addEventListener("click", e => {
    const tab = e.target.closest(".texlib-tab[data-slot]");
    if (!tab) return;
    texlibActiveSlot = Number(tab.dataset.slot);
    texlibTabsEl.querySelectorAll(".texlib-tab").forEach(t => t.classList.toggle("active", t === tab));
    texlibNameEl.value = textureLib.slots[texlibActiveSlot].name;
    syncTexlibEditor();
    texlibUrlSay([]);            // last slot's result does not belong to this one
  });
  texlibNameEl.addEventListener("input", () => {
    textureLib.setSlotName(texlibActiveSlot, texlibNameEl.value);
    const lbl = uiById(`llabel-${texlibActiveSlot + 1}`);
    if (lbl) lbl.textContent = texlibNameEl.value || `L${texlibActiveSlot + 1}`;
  });

  // ── Load slot maps from a link ──────────────────────────────────────────────
  /*
   * Auditioning a ground texture used to mean downloading four files before you
   * could see one of them on the terrain. This takes the links instead, and goes
   * through textureLib.loadFromUrlEmbedded so the BYTES land in the project —
   * a .v3proj that stored the URL would re-fetch someone else's CDN on every
   * load, including the deployed game.
   */
  const texlibUrlEl   = uiById("texlib-url");
  const texlibUrlAuto = uiById("texlib-url-auto");
  const texlibUrlBtn  = uiById("texlib-url-load");
  const texlibUrlStat = uiById("texlib-url-status");

  /*
   * Polyhaven names every map `<asset>_<map>_<res>.<ext>` inside a folder that
   * is already per-format and per-resolution, so the other three maps of a set
   * are one substitution away. `nor_gl` comes before `nor` in the alternation
   * because the regex is greedy-first, not longest-match.
   */
  // `diffuse` before `diff`: a few assets spell the colour map out in full, and
  // the alternation is first-match, not longest-match.
  const PH_MAP_RE = /_(diffuse|diff|nor_gl|nor_dx|nor|rough|ao|arm|disp)_(\d+k)(\.[a-z0-9]+)$/i;

  function siblingMapUrls(url) {
    const base = url.split("?")[0];
    const m = base.match(PH_MAP_RE);
    if (!m) return [];
    const from = m[1].toLowerCase();
    const fromIsNormal = from.startsWith("nor");
    return ["diff", "nor_gl", "rough", "ao"]
      // Never re-fetch what was pasted, and never answer a `nor_dx` with the
      // `nor_gl` of the same map — that would import two rival normals.
      .filter((k) => k !== from && !(fromIsNormal && k.startsWith("nor")))
      .map((k) => base.replace(PH_MAP_RE, `_${k}_${m[2]}${m[3]}`));
  }

  function texlibUrlSay(rows) {
    texlibUrlStat.textContent = "";
    texlibUrlStat.hidden = rows.length === 0;
    for (const r of rows) {
      const line = document.createElement("div");
      if (r.cls) line.className = r.cls;
      line.textContent = r.text;              // pasted text, never innerHTML
      texlibUrlStat.appendChild(line);
    }
  }

  let texlibUrlBusy = false;
  async function texlibLoadUrls() {
    if (texlibUrlBusy) return;
    const pasted = texlibUrlEl.value.split(/\s+/).filter((s) => /^https?:\/\//i.test(s));
    if (!pasted.length) {
      texlibUrlSay([{ cls: "err", text: "Paste an image URL first." }]);
      return;
    }

    // One link, option on: try the rest of its set. Those are GUESSES, so a
    // miss is skipped in silence — only what was actually pasted can fail.
    const solo = pasted.length === 1 && texlibUrlAuto.checked;
    // An ARM link on its own is the one case where we know what was MEANT: it
    // names a real Polyhaven set, and the maps we can use sit beside it. Fetch
    // those and skip the ARM itself, rather than refusing and then loading the
    // set anyway — which is what reporting it as a failure would look like.
    const armSolo = solo && /_arm_\d+k\.[a-z0-9]+$/i.test(pasted[0].split("?")[0]);
    const queue = armSolo ? [] : pasted.slice();
    const guessed = new Set();
    if (solo) {
      for (const s of siblingMapUrls(pasted[0])) { queue.push(s); guessed.add(s); }
    }

    const slotIdx = texlibActiveSlot;
    texlibUrlBusy = true;
    texlibUrlBtn.disabled = true;
    const rows = armSolo
      ? [{ cls: "", text: "ARM is packed (AO+Rough+Metal) — loading the separate maps beside it" }]
      : [];
    let failed = false;
    for (let i = 0; i < queue.length; i++) {
      texlibUrlBtn.textContent = `${i + 1}/${queue.length}`;
      try {
        const { kind, name, bytes } = await textureLib.loadFromUrlEmbedded(slotIdx, queue[i]);
        rows.push({ cls: "ok", text: `✓ ${kind} — ${name} · ${Math.round(bytes / 1024)} KB` });
        refreshLayerThumb(slotIdx);
        if (slotIdx === texlibActiveSlot) syncTexlibEditor();
      } catch (err) {
        if (guessed.has(queue[i])) continue;
        failed = true;
        rows.push({ cls: "err", text: `✗ ${queue[i].split("/").pop()} — ${err.message}` });
      }
      texlibUrlSay(rows);                     // report as it goes, not at the end
    }
    texlibUrlBtn.textContent = "Load";
    texlibUrlBtn.disabled = false;
    texlibUrlBusy = false;
    if (!failed) texlibUrlEl.value = "";      // ready for the next paste
    texlibUrlSay(rows.length ? rows : [{ cls: "err", text: "Nothing loaded." }]);
  }

  texlibUrlBtn.addEventListener("click", texlibLoadUrls);
  texlibUrlEl.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.shiftKey) return;
    // Enter sends a single pasted link. Once there are several lines it has to
    // stay a newline, so Ctrl/Cmd+Enter sends those.
    if (texlibUrlEl.value.trim().includes("\n") && !(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    texlibLoadUrls();
  });

  // Texture library UV/strength sliders — scoped to active slot
  const tslUVScale = uiById("tsl-uvscale");
  const tlblUV     = uiById("tlbl-uvscale");
  const tslNStr    = uiById("tsl-nstr");
  const tlblNStr   = uiById("tlbl-nstr");
  const tslAOStr   = uiById("tsl-aostr");
  const tlblAO     = uiById("tlbl-aostr");
  const tslRStr    = uiById("tsl-rstr");
  const tlblRStr   = uiById("tlbl-rstr");
  const tslTriplanar = uiById("tsl-triplanar");
  const tslTint      = uiById("tsl-tint");
  const tslTintReset = uiById("tsl-tint-reset");
  const tslUVRot     = uiById("tsl-uvrot");
  const tlblUVRot    = uiById("tlbl-uvrot");
  tslTint.addEventListener("input", () => {
    textureLib.setTint(texlibActiveSlot, tslTint.value);
    refreshLayerThumb(texlibActiveSlot);
    grassTintDirty = true; // the grass tint samples the painted ground colour
  });
  tslTintReset.addEventListener("click", () => {
    textureLib.setTint(texlibActiveSlot, "#ffffff");
    tslTint.value = "#ffffff";
    refreshLayerThumb(texlibActiveSlot);
    grassTintDirty = true;
  });
  tslUVRot.addEventListener("input", () => {
    textureLib.setUVRotation(texlibActiveSlot, Number(tslUVRot.value));
    tlblUVRot.textContent = `${tslUVRot.value}°`;
    grassTintDirty = true;
  });

  tslTriplanar.addEventListener("change", () => {
    textureLib.setTriplanar(texlibActiveSlot, tslTriplanar.checked);
    syncTriplanarCompile();
  });
  const tslRockShade = uiById("tsl-rockshade");
  tslRockShade.addEventListener("change", () => {
    textureLib.setRockShade(texlibActiveSlot, tslRockShade.checked ? 1 : 0);
    syncRockShadeCompile();
  });
  const tslBlockGrass = uiById("tsl-block-grass");
  const tslBlockTrees = uiById("tsl-block-trees");
  tslBlockGrass.addEventListener("change", () => {
    textureLib.slots[texlibActiveSlot].blocksGrass = tslBlockGrass.checked;
  });
  tslBlockTrees.addEventListener("change", () => {
    textureLib.slots[texlibActiveSlot].blocksTrees = tslBlockTrees.checked;
  });

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
    const thumb = uiById(`tmt-${mapType}`);
    const cell  = uiById(`tmc-${mapType}`);
    if (thumb) thumb.style.backgroundImage = url ? `url(${url})` : "";
    if (cell) cell.classList.toggle("has-texture", Boolean(url));
    if (mapType === "albedo") refreshLayerThumb(texlibActiveSlot);
  }

  MAP_TYPES.forEach(mapType => {
    const cell  = uiById(`tmc-${mapType}`);
    const clear = uiById(`tmc-clear-${mapType}`);
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
        const thumb = uiById(`tmt-${mapType}`);
        if (thumb) thumb.style.backgroundImage = "";
        cell.classList.remove("has-texture");
        if (mapType === "albedo") refreshLayerThumb(texlibActiveSlot);
      });
    }
  });

  // ── Texture Library: procedural source ─────────────────────────────────────
  // A slot is either Image (its four map files) or Procedural (a texture baked
  // from colours + a pattern into the same array layers). The terrain shader
  // cannot tell the difference, so neither can its frame cost.
  const texlibSourceEl = uiById("texlib-source");
  const texlibImageSrc = uiById("texlib-image-src");
  const texlibProcSrc  = uiById("texlib-proc-src");

  /** First preset for a slot switched to Procedural: a guess from its name. */
  function guessProcPreset(name = "") {
    const n = name.toLowerCase();
    if (/snow|ice/.test(n)) return "softSnow";
    if (/sand|beach|shore|desert/.test(n)) return "genshinShore";
    if (/moss/.test(n)) return "mossyRock";
    if (/rock|cliff|stone|cobble/.test(n)) return "paintedRock";
    if (/dirt|ground|soil|path|mud|earth/.test(n)) return "genshinPath";
    if (/flower|meadow/.test(n)) return "flowerMeadow";
    return "genshinGrass";
  }

  /**
   * Presets store their tile size in metres; the UV tile is world-relative
   * (uv = world / WORLD_SIZE × uvScale), and world size is per project. Clamped
   * to the UV tile slider's 1–200 range.
   */
  const procUvScale = (p) => Math.min(200, Math.max(1, Math.round(WORLD_SIZE / p.tileM)));

  /** A path or shore is walked on: its presets keep grass and trees off it. */
  function applyPresetBlocking(i, p) {
    // A path is walked on and a rock face is stone: neither grows grass or
    // trees. Rock used to allow both, so a cliff came out furry and — once a
    // preset raised the terrain tint — the blades on it went stone grey.
    if (p.pattern !== "path" && p.pattern !== "rock") return;
    textureLib.slots[i].blocksGrass = true;
    textureLib.slots[i].blocksTrees = true;
  }

  function requestSlotProcedural(i, params) {
    if (i === texlibActiveSlot) procPanel.setBusy(true);
    textureLib.requestProcedural(i, params)
      .catch((err) => console.warn(`[V3] Procedural layer ${i + 1} bake failed:`, err))
      .finally(() => { if (i === texlibActiveSlot) procPanel.setBusy(false); });
  }

  /*
   * UNDO FOR PROCEDURAL LAYER EDITS (AUDIT 9). They go into the PAINT history,
   * next to the brush strokes, so Ctrl+Z in Paint mode walks back through both
   * in the order they happened. A step holds everything an edit can change on
   * the slot: its settings, the tile size and the path "blocks grass/trees"
   * flags a preset brings. Restoring re-bakes the layer.
   */
  function procSlotState(i) {
    const s = textureLib.slots[i];
    return {
      procedural: s.procedural ? { ...s.procedural } : null,
      uvScale: textureLib.slotUniforms[i].uUVScale.value,
      blocksGrass: !!s.blocksGrass,
      blocksTrees: !!s.blocksTrees,
    };
  }
  function applyProcSlotState(i, st) {
    textureLib.setUVScale(i, st.uvScale);
    textureLib.slots[i].blocksGrass = st.blocksGrass;
    textureLib.slots[i].blocksTrees = st.blocksTrees;
    if (st.procedural) requestSlotProcedural(i, st.procedural);
    if (i === texlibActiveSlot) syncTexlibEditor();
  }
  function recordProcEdit(key, i, edit) {
    const before = procSlotState(i);
    edit();
    paintSys.recordAction({
      key: `${key}:${i}`,
      before,
      after: procSlotState(i),
      apply: (st) => applyProcSlotState(i, st),
    });
  }

  const procPanel = createProceduralLayerPanel(texlibProcSrc, {
    // Slider drags coalesce into one undo step (same key, < 800 ms apart).
    onChange: (p) => recordProcEdit("proc", texlibActiveSlot, () => requestSlotProcedural(texlibActiveSlot, p)),
    onPreset: (p) => recordProcEdit("procPreset", texlibActiveSlot, () => {
      // A preset's look is designed at a tile size, so it brings its UV tile.
      textureLib.setUVScale(texlibActiveSlot, procUvScale(p));
      applyPresetBlocking(texlibActiveSlot, p);
      requestSlotProcedural(texlibActiveSlot, p);
      syncTexlibEditor();
    }),
  });

  textureLib.onProceduralBaked = (i) => {
    refreshLayerThumb(i);
    if (i === texlibActiveSlot) procPanel.setThumb(textureLib.slots[i].procThumbUrl);
    grassTintDirty = true; // the grass tint samples the painted ground colour
  };

  texlibSourceEl.addEventListener("click", (e) => {
    const chip = e.target.closest(".option-chip[data-src]");
    if (!chip) return;
    const i = texlibActiveSlot;
    const s = textureLib.slots[i];
    if (chip.dataset.src === "procedural") {
      if (s.procedural) return;
      const p = procParamsFromPreset(guessProcPreset(s.name));
      textureLib.setUVScale(i, procUvScale(p));
      applyPresetBlocking(i, p);
      requestSlotProcedural(i, p);
      syncTexlibEditor();
    } else {
      if (!s.procedural) return;
      textureLib.clearProcedural(i).then(() => {
        refreshLayerThumb(i);
        if (i === texlibActiveSlot) syncTexlibEditor();
        grassTintDirty = true;
      });
      syncTexlibEditor();
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
    tslTriplanar.checked = u.uTriplanar.value > 0.5;
    tslRockShade.checked = u.uRockShade.value > 0.001;
    tslTint.value = textureLib.getTintHex(texlibActiveSlot);
    tslUVRot.value = Math.round(s.uvRotation);
    tlblUVRot.textContent = `${Math.round(s.uvRotation)}°`;
    tslBlockGrass.checked = s.blocksGrass;
    tslBlockTrees.checked = s.blocksTrees;
    texlibNameEl.value = s.name;
    const isProc = s.procedural !== null;
    texlibSourceEl.querySelectorAll(".option-chip").forEach((c) =>
      c.classList.toggle("active", c.dataset.src === (isProc ? "procedural" : "image")));
    texlibImageSrc.hidden = isProc;
    texlibProcSrc.hidden = !isProc;
    if (isProc) {
      procPanel.setParams(s.procedural);
      procPanel.setThumb(s.procThumbUrl);
    }
    // Sync map cell thumbnails for the active slot
    for (const [mapType, urlProp] of [
      ["albedo", "albedoUrl"], ["normal", "normalUrl"], ["rough", "roughUrl"], ["ao", "aoUrl"],
    ]) {
      const url = s[urlProp];
      const thumb = uiById(`tmt-${mapType}`);
      const cell  = uiById(`tmc-${mapType}`);
      if (thumb) thumb.style.backgroundImage = url ? `url(${url})` : "";
      if (cell) cell.classList.toggle("has-texture", Boolean(url));
    }
  }
  syncTexlibEditor();

  // Fill / Clear buttons
  pbtnFill.addEventListener("click", () => { paintSys.fillWithActiveLayer(); });
  pbtnClear.addEventListener("click", () => { paintSys.clearAll(); });

  /**
   * Show loaded state in a hand-written panel: set each control and fire the
   * event its own listener handles, so labels, uniforms and geometry follow
   * exactly as if the user had moved it. A range input snaps to its step and
   * clamps to its range, so the loaded values are put back afterwards — the
   * caller re-syncs whatever reads them.
   * @param {Array<[string, string, number?]>} controls [element id, state key, slider units per state unit]
   */
  function syncPanelControls(controls, state) {
    const loaded = { ...state };
    for (const [id, key, scale = 1] of controls) {
      const el = uiById(id);
      const v = state[key];
      if (!el || v === undefined) continue;
      if (el.type === "checkbox") {
        el.checked = Boolean(v);
        el.dispatchEvent(new Event("change"));
      } else if (el.tagName === "SELECT") {
        el.value = String(v);
        el.dispatchEvent(new Event("change"));
      } else if (el.type === "color") {
        el.value = v;
        el.dispatchEvent(new Event("input"));
      } else {
        el.value = String(v * scale);
        el.dispatchEvent(new Event("input"));
      }
    }
    Object.assign(state, loaded);
  }

  // Snow look sliders saved in the project: [slider id, snowSystem.params key,
  // slider units per param unit]. Brush size/strength are tool settings.
  const SNOW_LOOK_SLIDERS = [
    ["snow-sl-base", "baseDepth", 100], ["snow-sl-noise", "noiseAmp", 100],
    ["snow-sl-groove", "grooveScale", 100], ["snow-sl-soft", "trailSoftness", 100],
    ["snow-sl-rim", "rimScale", 100], ["snow-sl-regrow", "regrowRate", 10000],
    ["snow-sl-glitter", "glitterIntensity", 10], ["snow-sl-freq", "glitterFreq", 1],
  ];
  const SNOW_LOOK_KEYS = SNOW_LOOK_SLIDERS.map(([, key]) => key);

  function applySnowParams(saved) {
    const p = snowSystem.params;
    for (const key of SNOW_LOOK_KEYS) {
      if (Number.isFinite(saved[key])) p[key] = saved[key];
    }
    syncPanelControls(SNOW_LOOK_SLIDERS, p);
    const u = snowSystem.u;
    u.uBaseDepth.value = p.baseDepth;
    u.uNoiseAmp.value = p.noiseAmp;
    u.uGrooveScale.value = p.grooveScale;
    u.uTrailSoft.value = p.trailSoftness;
    u.uRimScale.value = p.rimScale;
    u.uGlitterIntensity.value = p.glitterIntensity;
    u.uGlitterFreq.value = p.glitterFreq;
  }

  // ── Snow panel controls ────────────────────────────────────────────────────
  {
    const slR = uiById("snow-sl-radius");
    const lbR = uiById("snow-lbl-radius");
    const slS = uiById("snow-sl-strength");
    const lbS = uiById("snow-lbl-strength");
    const slF = uiById("snow-sl-falloff");
    const lbF = uiById("snow-lbl-falloff");
    const slB = uiById("snow-sl-base");
    const lbB = uiById("snow-lbl-base");
    const slN = uiById("snow-sl-noise");
    const lbN = uiById("snow-lbl-noise");
    const slG = uiById("snow-sl-groove");
    const lbG = uiById("snow-lbl-groove");
    const slSo = uiById("snow-sl-soft");
    const lbSo = uiById("snow-lbl-soft");
    const slRm = uiById("snow-sl-rim");
    const lbRm = uiById("snow-lbl-rim");
    const slRw = uiById("snow-sl-regrow");
    const lbRw = uiById("snow-lbl-regrow");
    const slGl = uiById("snow-sl-glitter");
    const lbGl = uiById("snow-lbl-glitter");
    const slFq = uiById("snow-sl-freq");
    const lbFq = uiById("snow-lbl-freq");
    const btnFill  = uiById("snow-btn-fill");
    const btnClear = uiById("snow-btn-clear");

    slR.addEventListener("input", () => {
      snowBrushState.radius = Number(slR.value);
      lbR.textContent = slR.value + "m";
      if (editorMode === "snow") sculpt.uRadius.value = snowBrushState.radius / WORLD_SIZE;
    });
    slS.addEventListener("input", () => {
      snowBrushState.strength = Number(slS.value) / 100;
      lbS.textContent = snowBrushState.strength.toFixed(2);
    });
    slF.addEventListener("input", () => {
      snowBrushState.falloff = Number(slF.value) / 10;
      lbF.textContent = snowBrushState.falloff.toFixed(1);
    });
    slB.addEventListener("input", () => {
      snowSystem.params.baseDepth = Number(slB.value) / 100;
      snowSystem.u.uBaseDepth.value = snowSystem.params.baseDepth;
      lbB.textContent = snowSystem.params.baseDepth.toFixed(2) + "m";
    });
    slN.addEventListener("input", () => {
      snowSystem.params.noiseAmp = Number(slN.value) / 100;
      snowSystem.u.uNoiseAmp.value = snowSystem.params.noiseAmp;
      lbN.textContent = snowSystem.params.noiseAmp.toFixed(2) + "m";
    });
    slG.addEventListener("input", () => {
      snowSystem.params.grooveScale = Number(slG.value) / 100;
      snowSystem.u.uGrooveScale.value = snowSystem.params.grooveScale;
      lbG.textContent = snowSystem.params.grooveScale.toFixed(2);
    });
    slSo.addEventListener("input", () => {
      snowSystem.params.trailSoftness = Number(slSo.value) / 100;
      snowSystem.u.uTrailSoft.value = snowSystem.params.trailSoftness;
      lbSo.textContent = snowSystem.params.trailSoftness.toFixed(2) + "m";
    });
    slRm.addEventListener("input", () => {
      snowSystem.params.rimScale = Number(slRm.value) / 100;
      snowSystem.u.uRimScale.value = snowSystem.params.rimScale;
      lbRm.textContent = snowSystem.params.rimScale.toFixed(2);
    });
    slRw.addEventListener("input", () => {
      snowSystem.params.regrowRate = Number(slRw.value) / 10000;
      lbRw.textContent = snowSystem.params.regrowRate.toFixed(4);
    });
    slGl.addEventListener("input", () => {
      snowSystem.params.glitterIntensity = Number(slGl.value) / 10;
      snowSystem.u.uGlitterIntensity.value = snowSystem.params.glitterIntensity;
      lbGl.textContent = snowSystem.params.glitterIntensity.toFixed(1);
    });
    slFq.addEventListener("input", () => {
      snowSystem.params.glitterFreq = Number(slFq.value);
      snowSystem.u.uGlitterFreq.value = snowSystem.params.glitterFreq;
      lbFq.textContent = slFq.value;
    });
    btnFill.addEventListener("click", () => {
      _snowUndoStack.push(snowMap.snapshot());
      if (_snowUndoStack.length > 32) _snowUndoStack.shift();
      _snowRedoStack.length = 0;
      snowMap.fillAll();
    });
    btnClear.addEventListener("click", () => {
      _snowUndoStack.push(snowMap.snapshot());
      if (_snowUndoStack.length > 32) _snowUndoStack.shift();
      _snowRedoStack.length = 0;
      snowMap.clearAll();
    });
  }

  // ── Cliff paint panel controls ─────────────────────────────────────────────
  {
    const slR = uiById("cliffpaint-sl-radius");
    const lbR = uiById("cliffpaint-lbl-radius");
    const slS = uiById("cliffpaint-sl-strength");
    const lbS = uiById("cliffpaint-lbl-strength");
    const slF = uiById("cliffpaint-sl-falloff");
    const lbF = uiById("cliffpaint-lbl-falloff");
    const btnFill  = uiById("cliffpaint-btn-fill");
    const btnClear = uiById("cliffpaint-btn-clear");

    slR.addEventListener("input", () => {
      cliffPaintBrush.radius = Number(slR.value);
      lbR.textContent = slR.value + "m";
      if (editorMode === "cliffPaint") sculpt.uRadius.value = cliffPaintBrush.radius / WORLD_SIZE;
    });
    slS.addEventListener("input", () => {
      cliffPaintBrush.strength = Number(slS.value) / 100;
      lbS.textContent = cliffPaintBrush.strength.toFixed(2);
    });
    slF.addEventListener("input", () => {
      cliffPaintBrush.falloff = Number(slF.value) / 10;
      lbF.textContent = cliffPaintBrush.falloff.toFixed(1);
    });
    // Fill/Clear go through the paint system's snapshot undo stack.
    const _cliffMaskBulk = (op) => {
      const before = cliffPaintMask.getSnapshot();
      op();
      cliffPaintSystem.undoStack.push({ before, after: cliffPaintMask.getSnapshot() });
      if (cliffPaintSystem.undoStack.length > 32) cliffPaintSystem.undoStack.shift();
      cliffPaintSystem.redoStack.length = 0;
    };
    btnFill.addEventListener("click", () => _cliffMaskBulk(() => cliffPaintMask.fillAll()));
    btnClear.addEventListener("click", () => _cliffMaskBulk(() => cliffPaintMask.clearAll()));
  }

  // ── Auto paint (live auto-material) ────────────────────────────────────────
  // Slope/height rules texture the unpainted ground live in the shader; the
  // Bake button freezes the same rules into the splatmap for hand-editing.
  const AUTO = splatOverlay.auto;

  // Height sliders scale with the configured terrain height.
  aptHighStart.max = MAX_HEIGHT;
  aptHighEnd.max   = MAX_HEIGHT;

  function autoPaintParams() {
    return {
      flat:          Number(aptFlat.value),
      cliff:         Number(aptCliff.value),
      high:          Number(aptHigh.value),
      slopeStartDeg: Number(aptSlopeStart.value),
      slopeEndDeg:   Number(aptSlopeEnd.value),
      highStart:     Number(aptHighStart.value),
      highEnd:       Number(aptHighEnd.value),
      noise:         Number(aptNoise.value) / 100,
    };
  }

  function syncAutoPaint() {
    // Keep the blend bands valid (start < end).
    if (Number(aptSlopeEnd.value) <= Number(aptSlopeStart.value) + 1) {
      aptSlopeEnd.value = Number(aptSlopeStart.value) + 2;
    }
    if (Number(aptHighEnd.value) <= Number(aptHighStart.value)) {
      aptHighEnd.value = Number(aptHighStart.value) + 5;
    }
    const p = autoPaintParams();
    AUTO.uAutoEnabled.value   = aptEnabled.checked ? 1 : 0;
    AUTO.uAutoFull.value      = aptPreview.checked ? 1 : 0;
    AUTO.uAutoFlat.value      = p.flat;
    AUTO.uAutoCliff.value     = p.cliff;
    AUTO.uAutoHigh.value      = p.high;
    AUTO.uAutoSlopeHiY.value  = Math.cos(p.slopeStartDeg * Math.PI / 180);
    AUTO.uAutoSlopeLoY.value  = Math.cos(p.slopeEndDeg   * Math.PI / 180);
    AUTO.uAutoHighStart.value = p.highStart;
    AUTO.uAutoHighEnd.value   = p.highEnd;
    AUTO.uAutoNoise.value     = p.noise;
    uiById("apt-lbl-slope-start").textContent = p.slopeStartDeg + "°";
    uiById("apt-lbl-slope-end").textContent   = p.slopeEndDeg + "°";
    uiById("apt-lbl-high-start").textContent  = p.highStart + "m";
    uiById("apt-lbl-high-end").textContent    = p.highEnd + "m";
    uiById("apt-lbl-noise").textContent       = Math.round(p.noise * 100) + "%";
  }
  for (const el of [aptEnabled, aptPreview, aptFlat, aptCliff, aptHigh, aptSlopeStart, aptSlopeEnd, aptHighStart, aptHighEnd, aptNoise]) {
    el.addEventListener("input", syncAutoPaint);
    el.addEventListener("change", syncAutoPaint);
  }
  syncAutoPaint();

  aptBake.addEventListener("click", async () => {
    await ensureCpuHeightmapFromGpu(); // bake from fresh heights, not a stale mirror
    paintSys.applyAutoRules({
      cpuHeightmap,
      heightmapSize: HEIGHTMAP_SIZE,
      worldSize:     WORLD_SIZE,
      maxHeight:     MAX_HEIGHT,
      params:        autoPaintParams(),
    });
    // The splatmap now holds what the preview was showing — drop back to the
    // real paint so hand-edits on top of the bake are visible immediately.
    if (aptPreview.checked) { aptPreview.checked = false; syncAutoPaint(); }
  });

  // Splat save / load
  function saveSplatmap() {
    const buf = encodeSplatmapFile(splatMap.exportCombined(), { resolution: SPLAT_RES });
    const ts  = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    downloadBuffer(buf, `splat-${ts}.v3splat`);
  }

  async function loadSplatmap() {
    const file = await pickSplatmapFile();
    if (!file) return;
    try {
      const decoded = decodeSplatmapFile(await file.arrayBuffer());
      // A splatmap file is PAINT. Holes are terrain, so the current ones stay —
      // and an older file's slice-1 alpha (Meadow) must not cut new ones.
      const keepHoles = splatMap.holeUser.slice();
      // A splatmap is weights over the whole world, so a resolution difference
      // is a rescale, not an error — importing older/finer maps just works.
      if (decoded.resolution !== SPLAT_RES) {
        console.info(`[V3] Splatmap ${decoded.resolution}² → resampled to ${SPLAT_RES}².`);
        splatMap.setCombinedResampled(decoded.data, decoded.resolution);
      } else {
        splatMap.setCombined(decoded.data);
      }
      splatMap.setUserHoles(keepHoles);
    } catch (err) {
      console.error(err);
      window.alert(err instanceof Error ? err.message : "Failed to load splatmap.");
    }
  }

  pbtnSaveSplat.addEventListener("click", () => saveSplatmap());
  pbtnLoadSplat.addEventListener("click", () => loadSplatmap());

  // ── Grass panel wiring ─────────────────────────────────────────────────────

  // Density brush
  const gslRadius   = uiById("gsl-radius");
  const glblRadius  = uiById("glbl-radius");
  const gslStr      = uiById("gsl-strength");
  const glblStr     = uiById("glbl-strength");
  const gslFalloff  = uiById("gsl-falloff");
  const glblFalloff = uiById("glbl-falloff");
  const gckErase    = uiById("gck-erase");
  const gbtnFill    = uiById("gbtn-fill");
  const gbtnClear   = uiById("gbtn-clear");

  gslRadius.addEventListener("input", () => { grassBrush.radius = Number(gslRadius.value); glblRadius.textContent = gslRadius.value + "m"; });
  gslStr.addEventListener("input", () => { grassBrush.strength = Number(gslStr.value) / 100; glblStr.textContent = grassBrush.strength.toFixed(2); });
  gslFalloff.addEventListener("input", () => { grassBrush.falloff = Number(gslFalloff.value) / 10; glblFalloff.textContent = grassBrush.falloff.toFixed(1); });
  gckErase.addEventListener("change", () => { grassBrush.erase = gckErase.checked; });
  // Fill/Clear are one undo step each. With the Height target they set the
  // whole field to the target height / reset it to 1x; otherwise they act on
  // the terrain density whatever the brush target.
  gbtnFill.addEventListener("click", () => {
    if (grassBrush.target === "height") {
      _pushGrassUndo("height");
      grassTerrainData.fillBladeHeight(grassBrush.heightTarget);
      return;
    }
    _pushGrassUndo("terrain");
    grassTerrainData.fillDensity();
  });
  gbtnClear.addEventListener("click", () => {
    if (grassBrush.target === "height") {
      if (!confirm("Reset all painted grass height to 1x?")) return;
      _pushGrassUndo("height");
      grassTerrainData.resetBladeHeight();
      return;
    }
    if (!confirm("Clear all grass density?")) return;
    _pushGrassUndo("terrain");
    grassTerrainData.clearDensity();
  });
  const gslHeightTarget  = uiById("gsl-height-target");
  const glblHeightTarget = uiById("glbl-height-target");
  gslHeightTarget.addEventListener("input", () => { grassBrush.heightTarget = Number(gslHeightTarget.value) / 100; glblHeightTarget.textContent = grassBrush.heightTarget.toFixed(2) + "×"; });

  // ── Cliff grass: paint-target toggle + surface bake + fill/clear ───────────
  const gbtnTargetTerrain = uiById("gbtn-target-terrain");
  const gbtnTargetCliff   = uiById("gbtn-target-cliff");
  const cliffgrassBake    = uiById("cliffgrass-bake");
  const cliffgrassFill    = uiById("cliffgrass-fill");
  const cliffgrassClear   = uiById("cliffgrass-clear");
  const cliffgrassStatus  = uiById("cliffgrass-status");

  function updateCliffGrassStatus() {
    if (!cliffgrassStatus) return;
    if (!grassTerrainData.hasCliffSurface) {
      cliffgrassStatus.textContent = "No cliff surface baked yet.";
    } else {
      const stale = grassTerrainData.cliffSurfaceGen !== propStore.gen;
      cliffgrassStatus.textContent = grassTerrainData.hasCliffData
        ? (stale ? "Cliff surface baked (cliffs changed — re-bake to refresh)." : "Cliff grass active.")
        : "Cliff surface baked — paint with Cliff top selected.";
    }
  }

  const gbtnTargetHeight = uiById("gbtn-target-height");
  const grassHeightRow   = uiById("grass-height-target-row");
  function setGrassTarget(target) {
    grassBrush.target = target;
    const cliff = target === "cliff";
    gbtnTargetTerrain?.classList.toggle("primary", target === "terrain");
    gbtnTargetCliff?.classList.toggle("primary", cliff);
    gbtnTargetHeight?.classList.toggle("primary", target === "height");
    if (grassHeightRow) grassHeightRow.style.display = target === "height" ? "" : "none";
    if (cliff) { ensureFreshCliffSurface(); updateCliffGrassStatus(); }
  }
  gbtnTargetTerrain?.addEventListener("click", () => setGrassTarget("terrain"));
  gbtnTargetCliff?.addEventListener("click", () => setGrassTarget("cliff"));
  gbtnTargetHeight?.addEventListener("click", () => setGrassTarget("height"));

  cliffgrassBake?.addEventListener("click", () => { bakeCliffGrassSurface(); updateCliffGrassStatus(); });
  cliffgrassFill?.addEventListener("click", () => {
    bakeCliffGrassSurface();
    _pushGrassUndo("cliff");
    grassTerrainData.fillCliffDensity();
    updateCliffGrassStatus();
  });
  cliffgrassClear?.addEventListener("click", () => {
    if (confirm("Clear all cliff grass?")) {
      _pushGrassUndo("cliff");
      grassTerrainData.clearCliffDensity();
    }
    updateCliffGrassStatus();
  });

  // Appearance
  const gcolBlade   = uiById("gcol-blade");
  const gcolTip     = uiById("gcol-tip");
  const gslAoBase   = uiById("gsl-ao-base");
  const glblAoBase  = uiById("glbl-ao-base");
  const gslAoPow    = uiById("gsl-ao-power");
  const glblAoPow   = uiById("glbl-ao-power");
  const gckColorVar = uiById("gck-color-var");
  const gslHue      = uiById("gsl-hue");
  const glblHue     = uiById("glbl-hue");
  const gslSat      = uiById("gsl-sat");
  const glblSat     = uiById("glbl-sat");
  const gslDry      = uiById("gsl-dry");
  const glblDry     = uiById("glbl-dry");
  const gcolDry     = uiById("gcol-dry");
  const gslBladeH   = uiById("gsl-blade-height");
  const glblBladeH  = uiById("glbl-blade-height");

  gslBladeH.addEventListener("input", () => {
    grassState.bladeHeight = Number(gslBladeH.value) / 10;
    glblBladeH.textContent = grassState.bladeHeight.toFixed(1) + "m";
    syncGrassUniforms();
  });
  gcolBlade.addEventListener("input", () => { grassState.bladeColor = gcolBlade.value; syncGrassUniforms(); });
  gcolTip.addEventListener("input",   () => { grassState.tipColor   = gcolTip.value;   syncGrassUniforms(); });
  gslAoBase.addEventListener("input", () => { grassState.aoBase = Number(gslAoBase.value) / 100; glblAoBase.textContent = grassState.aoBase.toFixed(2); syncGrassUniforms(); });
  gslAoPow.addEventListener("input",  () => { grassState.aoPower = Number(gslAoPow.value) / 10; glblAoPow.textContent = grassState.aoPower.toFixed(1); syncGrassUniforms(); });
  const gselGrassPreset = uiById("gsel-grass-preset");
  gselGrassPreset?.addEventListener("change", () => {
    if (!gselGrassPreset.value) return;
    applyGrassPreset(gselGrassPreset.value);
  });

  // ── Which grass system the world runs ─────────────────────────────────────
  // The shared parts of the panel (Paint Density, Terrain, Interaction) stay
  // put; the sections that only describe hybrid blades swap out for revo's.
  const gselGrassSystem = uiById("gsel-grass-system");
  const revoPanelRoot = uiById("revo-grass-panel");
  if (revoPanelRoot) {
    revoUi = buildRevoGrassPanel(revoPanelRoot, {
      revoGrassState,
      onStateChanged: () => syncGrassUniforms(),
      onGeometryChanged: () => syncRevoGrass(),
    });
  }
  const GRASS_SYSTEM_HINTS = {
    hybrid: "Separate lit blades in LOD rings, out to 200 m.",
    revo: "One dense tile of small camera-facing blades around you — cheaper per blade, and many more of them.",
  };
  // Elements are looked up per call rather than captured: a project can load
  // during boot, before this part of the panel has been wired, and a captured
  // const would be in its temporal dead zone.
  function syncGrassSystemUi() {
    const revo = grassState.system === "revo";
    const sel = uiById("gsel-grass-system");
    if (sel && sel.value !== grassState.system) sel.value = grassState.system;
    const revoRoot = uiById("revo-grass-panel");
    for (const el of uiQueryAll('#grass-panel [data-grass-system="hybrid"]')) {
      el.style.display = revo ? "none" : "";
    }
    if (revoRoot) revoRoot.style.display = revo ? "" : "none";
    const h = uiById("grass-system-hint");
    if (h) h.textContent = GRASS_SYSTEM_HINTS[grassState.system] ?? "";
  }
  gselGrassSystem?.addEventListener("change", () => {
    grassState.system = gselGrassSystem.value === "revo" ? "revo" : "hybrid";
    syncGrassSystemUi();
    // Both systems read the same paint, so the one taking over needs building
    // only the first time it is asked for.
    if (grassState.system === "revo") void ensureRevoGrassBuilt();
    else void ensureGrassBuilt();
    syncGrassUniforms();
  });
  syncGrassSystemUi();
  const gslShadeVar  = uiById("gsl-shade-var");
  const glblShadeVar = uiById("glbl-shade-var");
  gslShadeVar.addEventListener("input", () => { grassState.shadeVariation = Number(gslShadeVar.value) / 100; glblShadeVar.textContent = grassState.shadeVariation.toFixed(2); syncGrassUniforms(); });
  const gslFarAo  = uiById("gsl-far-ao");
  const glblFarAo = uiById("glbl-far-ao");
  gslFarAo.addEventListener("input", () => { grassState.farAoMul = Number(gslFarAo.value) / 100; glblFarAo.textContent = grassState.farAoMul.toFixed(2); syncGrassUniforms(); });
  gckColorVar.addEventListener("change", () => { grassState.colorVariation = gckColorVar.checked; syncGrassUniforms(); });
  gslHue.addEventListener("input", () => { grassState.cvHueSpread = Number(gslHue.value) / 100; glblHue.textContent = grassState.cvHueSpread.toFixed(2); syncGrassUniforms(); });
  gslSat.addEventListener("input", () => { grassState.cvSatSpread = Number(gslSat.value) / 100; glblSat.textContent = grassState.cvSatSpread.toFixed(2); syncGrassUniforms(); });
  gslDry.addEventListener("input", () => { grassState.cvDryAmount = Number(gslDry.value) / 100; glblDry.textContent = grassState.cvDryAmount.toFixed(2); syncGrassUniforms(); });
  gcolDry.addEventListener("input", () => { grassState.cvDryColor = gcolDry.value; syncGrassUniforms(); });

  // Shape & Dynamics
  const gslBladeW  = uiById("gsl-blade-width");
  const glblBladeW = uiById("glbl-blade-width");
  const gckCrossed = uiById("gck-crossed");
  const gslBend    = uiById("gsl-bend");
  const glblBend   = uiById("glbl-bend");
  const gslStiff   = uiById("gsl-stiffness");
  const glblStiff  = uiById("glbl-stiffness");
  const gslMaxAng  = uiById("gsl-max-angle");
  const glblMaxAng = uiById("glbl-max-angle");
  const gslLean    = uiById("gsl-lean");
  const glblLean   = uiById("glbl-lean");
  const gslSky     = uiById("gsl-sky");
  const glblSky    = uiById("glbl-sky");
  const gslCyl     = uiById("gsl-cyl");
  const glblCyl    = uiById("glbl-cyl");
  const gslThick   = uiById("gsl-thick");
  const glblThick  = uiById("glbl-thick");
  const gslDens    = uiById("gsl-density");
  const glblDens   = uiById("glbl-density");
  const gckShadow  = uiById("gck-shadow");

  gslBladeW.addEventListener("input", () => {
    grassState.bladeWidth = Number(gslBladeW.value) / 100;
    glblBladeW.textContent = grassState.bladeWidth.toFixed(2) + "m";
    if (grassRings) rebuildHybridGrassGeometries(grassRings, grassState);
    if (cliffGrassRings) rebuildHybridGrassGeometries(cliffGrassRings, grassState);
  });
  gckCrossed.addEventListener("change", () => {
    grassState.crossed = gckCrossed.checked;
    if (grassRings) rebuildHybridGrassGeometries(grassRings, grassState);
    if (cliffGrassRings) rebuildHybridGrassGeometries(cliffGrassRings, grassState);
  });
  const gslSegments  = uiById("gsl-segments");
  const glblSegments = uiById("glbl-segments");
  const gslTaper     = uiById("gsl-taper");
  const glblTaper    = uiById("glbl-taper");
  const gslClumpSc   = uiById("gsl-clump-scale");
  const glblClumpSc  = uiById("glbl-clump-scale");
  const gslClumpStr  = uiById("gsl-clump-str");
  const glblClumpStr = uiById("glbl-clump-str");

  gslSegments.addEventListener("input", () => {
    grassState.bladeYSegments = Number(gslSegments.value);
    glblSegments.textContent = gslSegments.value;
    if (grassRings) rebuildHybridGrassGeometries(grassRings, grassState);
    if (cliffGrassRings) rebuildHybridGrassGeometries(cliffGrassRings, grassState);
  });
  gslTaper.addEventListener("input", () => {
    grassState.tipTaperStart = Number(gslTaper.value) / 100;
    glblTaper.textContent = grassState.tipTaperStart.toFixed(2);
    if (grassRings) rebuildHybridGrassGeometries(grassRings, grassState);
    if (cliffGrassRings) rebuildHybridGrassGeometries(cliffGrassRings, grassState);
  });
  gslClumpSc.addEventListener("input",  () => { grassState.clumpScale = Number(gslClumpSc.value) / 10; glblClumpSc.textContent = grassState.clumpScale.toFixed(1); syncGrassUniforms(); });
  gslClumpStr.addEventListener("input", () => { grassState.clumpStrength = Number(gslClumpStr.value) / 100; glblClumpStr.textContent = grassState.clumpStrength.toFixed(2); syncGrassUniforms(); });
  const gslClumpPull  = uiById("gsl-clump-pull");
  const glblClumpPull = uiById("glbl-clump-pull");
  gslClumpPull.addEventListener("input", () => { grassState.clumpPull = Number(gslClumpPull.value) / 100; glblClumpPull.textContent = grassState.clumpPull.toFixed(2); syncGrassUniforms(); });
  const gslFold  = uiById("gsl-fold");
  const glblFold = uiById("glbl-fold");
  gslFold.addEventListener("input", () => { grassState.foldBelow = Number(gslFold.value) / 100; glblFold.textContent = grassState.foldBelow > 0 ? grassState.foldBelow.toFixed(2) + "×" : "off"; syncGrassUniforms(); });
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
  const gslWindSpeed = uiById("gsl-wind-speed");
  const glblWindSpeed= uiById("glbl-wind-speed");
  const gslWindStr   = uiById("gsl-wind-str");
  const glblWindStr  = uiById("glbl-wind-str");
  const gslWindAngle = uiById("gsl-wind-angle");
  const glblWindAngle= uiById("glbl-wind-angle");
  const gslWindGust  = uiById("gsl-wind-gust");
  const glblWindGust = uiById("glbl-wind-gust");
  const gslWindWave  = uiById("gsl-wind-wave");
  const glblWindWave = uiById("glbl-wind-wave");

  gslWindSpeed.addEventListener("input", () => { grassState.windSpeed = Number(gslWindSpeed.value) / 100; glblWindSpeed.textContent = grassState.windSpeed.toFixed(2); syncGrassUniforms(); });
  gslWindStr.addEventListener("input",   () => { grassState.windStrength = Number(gslWindStr.value) / 100; glblWindStr.textContent = grassState.windStrength.toFixed(2); syncGrassUniforms(); });
  gslWindAngle.addEventListener("input", () => { grassState.windAngle = Number(gslWindAngle.value); glblWindAngle.textContent = grassState.windAngle + "°"; syncGrassUniforms(); });
  gslWindGust.addEventListener("input",  () => { grassState.windGust = Number(gslWindGust.value) / 100; glblWindGust.textContent = grassState.windGust.toFixed(2); syncGrassUniforms(); });
  gslWindWave.addEventListener("input",  () => { grassState.windWaveScale = Number(gslWindWave.value) / 100; glblWindWave.textContent = grassState.windWaveScale.toFixed(2); syncGrassUniforms(); });

  // SSS
  const gcolBss    = uiById("gcol-bss");
  const gslBssInt  = uiById("gsl-bss-int");
  const glblBssInt = uiById("glbl-bss-int");
  const gslBssPow  = uiById("gsl-bss-pow");
  const glblBssPow = uiById("glbl-bss-pow");
  const gslFront   = uiById("gsl-front-scat");
  const glblFront  = uiById("glbl-front-scat");
  const gslRim     = uiById("gsl-rim");
  const glblRim    = uiById("glbl-rim");

  gcolBss.addEventListener("input",   () => { grassState.bssColor = gcolBss.value; syncGrassUniforms(); });
  gslBssInt.addEventListener("input", () => { grassState.bssIntensity = Number(gslBssInt.value) / 100; glblBssInt.textContent = grassState.bssIntensity.toFixed(2); syncGrassUniforms(); });
  gslBssPow.addEventListener("input", () => { grassState.bssPower = Number(gslBssPow.value) / 10; glblBssPow.textContent = grassState.bssPower.toFixed(1); syncGrassUniforms(); });
  gslFront.addEventListener("input",  () => { grassState.frontScatter = Number(gslFront.value) / 100; glblFront.textContent = grassState.frontScatter.toFixed(2); syncGrassUniforms(); });
  gslRim.addEventListener("input",    () => { grassState.rimSSS = Number(gslRim.value) / 100; glblRim.textContent = grassState.rimSSS.toFixed(2); syncGrassUniforms(); });

  // Specular
  const gckSpec1   = uiById("gck-spec1");
  const gslS1Int   = uiById("gsl-s1-int");
  const glblS1Int  = uiById("glbl-s1-int");
  const gcolS1     = uiById("gcol-s1");
  const gslS1Pow   = uiById("gsl-s1-pow");
  const glblS1Pow  = uiById("glbl-s1-pow");
  const gckSpec2   = uiById("gck-spec2");
  const gslS2Int   = uiById("gsl-s2-int");
  const glblS2Int  = uiById("glbl-s2-int");
  const gcolS2     = uiById("gcol-s2");
  const gslS2Nscale= uiById("gsl-s2-nscale");
  const glblS2Nscale=uiById("glbl-s2-nscale");
  const gslS2Nstr  = uiById("gsl-s2-nstr");
  const glblS2Nstr = uiById("glbl-s2-nstr");
  const gslS2Pow   = uiById("gsl-s2-pow");
  const glblS2Pow  = uiById("glbl-s2-pow");

  gckSpec1.addEventListener("change",   () => { grassState.specV1Enabled = gckSpec1.checked; syncGrassUniforms(); });
  gslS1Int.addEventListener("input",    () => { grassState.specV1Intensity = Number(gslS1Int.value) / 100; glblS1Int.textContent = grassState.specV1Intensity.toFixed(2); syncGrassUniforms(); });
  gcolS1.addEventListener("input",      () => { grassState.specV1Color = gcolS1.value; syncGrassUniforms(); });
  gslS1Pow.addEventListener("input",    () => { grassState.specV1Power = Number(gslS1Pow.value) / 10; glblS1Pow.textContent = grassState.specV1Power.toFixed(1); syncGrassUniforms(); });
  gckSpec2.addEventListener("change",   () => { grassState.specV2Enabled = gckSpec2.checked; syncGrassUniforms(); });
  gslS2Int.addEventListener("input",    () => { grassState.specV2Intensity = Number(gslS2Int.value) / 100; glblS2Int.textContent = grassState.specV2Intensity.toFixed(2); syncGrassUniforms(); });
  gcolS2.addEventListener("input",      () => { grassState.specV2Color = gcolS2.value; syncGrassUniforms(); });
  gslS2Nscale.addEventListener("input", () => { grassState.specV2NoiseScale = Number(gslS2Nscale.value) / 10; glblS2Nscale.textContent = grassState.specV2NoiseScale.toFixed(1); syncGrassUniforms(); });
  gslS2Nstr.addEventListener("input",   () => { grassState.specV2NoiseStr = Number(gslS2Nstr.value) / 100; glblS2Nstr.textContent = grassState.specV2NoiseStr.toFixed(2); syncGrassUniforms(); });
  gslS2Pow.addEventListener("input",    () => { grassState.specV2Power = Number(gslS2Pow.value) / 10; glblS2Pow.textContent = grassState.specV2Power.toFixed(1); syncGrassUniforms(); });

  const gslS2TipBias  = uiById("gsl-s2-tipbias");
  const glblS2TipBias = uiById("glbl-s2-tipbias");
  gslS2TipBias.addEventListener("input", () => { grassState.specV2TipBias = Number(gslS2TipBias.value) / 100; glblS2TipBias.textContent = grassState.specV2TipBias.toFixed(2); syncGrassUniforms(); });

  // Spec light directions (V1 sharp / V2 noisy) — X/Y/Z sliders, -1..1
  for (const [sl, key] of [
    ["gsl-s1-dirx", "specV1DirX"], ["gsl-s1-diry", "specV1DirY"], ["gsl-s1-dirz", "specV1DirZ"],
    ["gsl-s2-dirx", "specV2DirX"], ["gsl-s2-diry", "specV2DirY"], ["gsl-s2-dirz", "specV2DirZ"],
  ]) {
    const el  = uiById(sl);
    const lbl = uiById(sl.replace("gsl-", "glbl-"));
    el.addEventListener("input", () => {
      grassState[key] = Number(el.value) / 100;
      lbl.textContent = grassState[key].toFixed(2);
      syncGrassUniforms();
    });
  }

  // Terrain / slope
  const gckSlope    = uiById("gck-slope");
  const gslSlopeMin = uiById("gsl-slope-min");
  const glblSlopeMin= uiById("glbl-slope-min");
  const gslSlopeMax = uiById("gsl-slope-max");
  const glblSlopeMax= uiById("glbl-slope-max");

  gckSlope.addEventListener("change",    () => { grassState.slopeEnabled = gckSlope.checked; syncGrassUniforms(); });
  gslSlopeMin.addEventListener("input",  () => { grassState.slopeMin = Number(gslSlopeMin.value) / 100; glblSlopeMin.textContent = grassState.slopeMin.toFixed(2); syncGrassUniforms(); });
  gslSlopeMax.addEventListener("input",  () => { grassState.slopeMax = Number(gslSlopeMax.value) / 100; glblSlopeMax.textContent = grassState.slopeMax.toFixed(2); syncGrassUniforms(); });

  // Terrain tint (baked splat color, img mode)
  const gckTint      = uiById("gck-tint");
  const gslTintStr   = uiById("gsl-tint-str");
  const glblTintStr  = uiById("glbl-tint-str");
  const gslTintRoot  = uiById("gsl-tint-root");
  const glblTintRoot = uiById("glbl-tint-root");

  gckTint.addEventListener("change", () => {
    grassState.terrainTintEnabled = gckTint.checked;
    grassTintDirty = true; // bake on next frame so the toggle is instant
    syncGrassUniforms();
  });
  gslTintStr.addEventListener("input",  () => { grassState.terrainTintStrength = Number(gslTintStr.value) / 100; glblTintStr.textContent = grassState.terrainTintStrength.toFixed(2); syncGrassUniforms(); });
  gslTintRoot.addEventListener("input", () => { grassState.terrainTintRootBias = Number(gslTintRoot.value) / 100; glblTintRoot.textContent = grassState.terrainTintRootBias.toFixed(2); syncGrassUniforms(); });

  // LOD
  const gslLodMid  = uiById("gsl-lod-mid");
  const glblLodMid = uiById("glbl-lod-mid");
  const gslLodFar  = uiById("gsl-lod-far");
  const glblLodFar = uiById("glbl-lod-far");
  const gslLodMax  = uiById("gsl-lod-max");
  const glblLodMax = uiById("glbl-lod-max");
  const gslLodMega = uiById("gsl-lod-mega");
  const glblLodMega= uiById("glbl-lod-mega");
  const gckLodDebug= uiById("gck-lod-debug");
  const gckFarBlades = uiById("gck-far-blades");
  gckFarBlades.addEventListener("change", () => { grassState.farBlades = gckFarBlades.checked; syncGrassLod(); });

  gslLodMid.addEventListener("input",  () => { grassState.lodMidDistance = Number(gslLodMid.value); glblLodMid.textContent = gslLodMid.value + "m"; syncGrassLod(); });
  gslLodFar.addEventListener("input",  () => { grassState.lodFarDistance = Number(gslLodFar.value); glblLodFar.textContent = gslLodFar.value + "m"; syncGrassLod(); });
  gslLodMax.addEventListener("input",  () => { grassState.lodMaxDistance = Number(gslLodMax.value); glblLodMax.textContent = gslLodMax.value + "m"; syncGrassLod(); });
  gslLodMega.addEventListener("input", () => { grassState.lodMegaMaxDistance = Number(gslLodMega.value); glblLodMega.textContent = gslLodMega.value + "m"; syncGrassLod(); });
  gckLodDebug.addEventListener("change", () => { grassState.lodDebug = gckLodDebug.checked; syncGrassUniforms(); });

  // Per-tier blade geometry (segments / widths) — geometry-baked, needs rebuild
  const _lodGeoSliders = [
    ["gsl-lod-mid-seg",  "lodMidSegments",   (v) => v,       (v) => String(v)],
    ["gsl-lod-far-seg",  "lodFarSegments",   (v) => v,       (v) => String(v)],
    ["gsl-lod-far-w",    "lodFarBladeWidth", (v) => v / 100, (v) => v.toFixed(2) + "m"],
    ["gsl-lod-mega-seg", "lodMegaSegments",  (v) => v,       (v) => String(v)],
    ["gsl-lod-mega-w",   "lodMegaBladeWidth",(v) => v / 100, (v) => v.toFixed(2) + "m"],
  ];
  for (const [sl, key, toVal, toLabel] of _lodGeoSliders) {
    const el  = uiById(sl);
    const lbl = uiById(sl.replace("gsl-", "glbl-"));
    el.addEventListener("input", () => {
      grassState[key] = toVal(Number(el.value));
      lbl.textContent = toLabel(grassState[key]);
      if (grassRings) rebuildHybridGrassGeometries(grassRings, grassState);
    if (cliffGrassRings) rebuildHybridGrassGeometries(cliffGrassRings, grassState);
    });
  }

  // Interaction
  const gslIntRad  = uiById("gsl-int-rad");
  const glblIntRad = uiById("glbl-int-rad");
  const gslIntStr  = uiById("gsl-int-str");
  const glblIntStr = uiById("glbl-int-str");
  const gselIntMode= uiById("gsel-int-mode");

  gslIntRad.addEventListener("input",  () => { grassState.interactionRadius = Number(gslIntRad.value) / 10; glblIntRad.textContent = grassState.interactionRadius.toFixed(1) + "m"; syncGrassUniforms(); });
  gslIntStr.addEventListener("input",  () => { grassState.interactionStrength = Number(gslIntStr.value) / 100; glblIntStr.textContent = grassState.interactionStrength.toFixed(2); syncGrassUniforms(); });
  gselIntMode.addEventListener("change", () => { grassState.interactionMode = Number(gselIntMode.value); syncGrassUniforms(); });
  const gslTrailStr  = uiById("gsl-trail-str");
  const glblTrailStr = uiById("glbl-trail-str");
  const gslTrailRec  = uiById("gsl-trail-rec");
  const glblTrailRec = uiById("glbl-trail-rec");
  gslTrailStr.addEventListener("input", () => { grassState.trailStrength = Number(gslTrailStr.value) / 100; glblTrailStr.textContent = grassState.trailStrength.toFixed(2); syncGrassUniforms(); });
  gslTrailRec.addEventListener("input", () => { grassState.trailRecovery = Number(gslTrailRec.value) / 10; glblTrailRec.textContent = grassState.trailRecovery.toFixed(1) + "s"; syncGrassUniforms(); });

  // Every grass control that holds a saved setting: [element id, grassState
  // key, slider units per state unit]. Used to show a loaded project's grass.
  const GRASS_PANEL_CONTROLS = [
    ["gsl-blade-height", "bladeHeight", 10], ["gcol-blade", "bladeColor"], ["gcol-tip", "tipColor"],
    ["gsl-ao-base", "aoBase", 100], ["gsl-ao-power", "aoPower", 10], ["gsl-far-ao", "farAoMul", 100], ["gsl-shade-var", "shadeVariation", 100],
    ["gck-color-var", "colorVariation"], ["gsl-hue", "cvHueSpread", 100], ["gsl-sat", "cvSatSpread", 100],
    ["gsl-dry", "cvDryAmount", 100], ["gcol-dry", "cvDryColor"],
    ["gsl-blade-width", "bladeWidth", 100], ["gck-crossed", "crossed"], ["gsl-segments", "bladeYSegments", 1],
    ["gsl-taper", "tipTaperStart", 100], ["gsl-clump-scale", "clumpScale", 10], ["gsl-clump-str", "clumpStrength", 100], ["gsl-clump-pull", "clumpPull", 100], ["gsl-fold", "foldBelow", 100],
    ["gsl-bend", "bendFocus", 10], ["gsl-stiffness", "stiffness", 100], ["gsl-max-angle", "maxAngle", 100],
    ["gsl-lean", "naturalLean", 100], ["gsl-sky", "skyBlend", 100], ["gsl-cyl", "cylindrical", 100],
    ["gsl-thick", "viewThicken", 100], ["gsl-density", "grassDensity", 100], ["gck-shadow", "receiveShadow"],
    ["gsl-wind-speed", "windSpeed", 100], ["gsl-wind-str", "windStrength", 100], ["gsl-wind-angle", "windAngle", 1],
    ["gsl-wind-gust", "windGust", 100], ["gsl-wind-wave", "windWaveScale", 100],
    ["gcol-bss", "bssColor"], ["gsl-bss-int", "bssIntensity", 100], ["gsl-bss-pow", "bssPower", 10],
    ["gsl-front-scat", "frontScatter", 100], ["gsl-rim", "rimSSS", 100],
    ["gck-spec1", "specV1Enabled"], ["gsl-s1-int", "specV1Intensity", 100], ["gcol-s1", "specV1Color"],
    ["gsl-s1-pow", "specV1Power", 10], ["gsl-s1-dirx", "specV1DirX", 100], ["gsl-s1-diry", "specV1DirY", 100],
    ["gsl-s1-dirz", "specV1DirZ", 100],
    ["gck-spec2", "specV2Enabled"], ["gsl-s2-int", "specV2Intensity", 100], ["gcol-s2", "specV2Color"],
    ["gsl-s2-nscale", "specV2NoiseScale", 10], ["gsl-s2-nstr", "specV2NoiseStr", 100], ["gsl-s2-pow", "specV2Power", 10],
    ["gsl-s2-tipbias", "specV2TipBias", 100], ["gsl-s2-dirx", "specV2DirX", 100], ["gsl-s2-diry", "specV2DirY", 100],
    ["gsl-s2-dirz", "specV2DirZ", 100],
    ["gck-slope", "slopeEnabled"], ["gsl-slope-min", "slopeMin", 100], ["gsl-slope-max", "slopeMax", 100],
    ["gck-tint", "terrainTintEnabled"], ["gsl-tint-str", "terrainTintStrength", 100], ["gsl-tint-root", "terrainTintRootBias", 100],
    ["gsl-lod-mid", "lodMidDistance", 1], ["gsl-lod-far", "lodFarDistance", 1], ["gsl-lod-max", "lodMaxDistance", 1],
    ["gsl-lod-mega", "lodMegaMaxDistance", 1], ["gck-far-blades", "farBlades"], ["gsl-lod-mid-seg", "lodMidSegments", 1], ["gsl-lod-far-seg", "lodFarSegments", 1],
    ["gsl-lod-far-w", "lodFarBladeWidth", 100], ["gsl-lod-mega-seg", "lodMegaSegments", 1], ["gsl-lod-mega-w", "lodMegaBladeWidth", 100],
    ["gsl-int-rad", "interactionRadius", 10], ["gsl-int-str", "interactionStrength", 100], ["gsel-int-mode", "interactionMode"],
    ["gsl-trail-str", "trailStrength", 100], ["gsl-trail-rec", "trailRecovery", 10],
  ];

  /** Grass look from a loaded project: state, panel, uniforms and blade geometry. */
  /**
   * One grass system, two art directions (state/grassPresets.js). A preset is
   * only a set of Grass panel values — everything stays tweakable after.
   */
  function applyGrassPreset(id) {
    const preset = GRASS_PRESETS[id];
    if (!preset) return;
    applyGrassState(preset.values);
    const hint = uiById("grass-preset-hint");
    if (hint) hint.textContent = preset.hint;
  }

  function applyGrassState(saved) {
    mergeKnownKeys(grassState, saved);
    syncPanelControls(GRASS_PANEL_CONTROLS, grassState);
    // A loaded world may run the other grass system, with its own values; the
    // panel and the dropdown both follow it.
    syncGrassSystemUi();
    revoUi?.rebuild();
    if (grassRings) rebuildHybridGrassGeometries(grassRings, grassState);
    if (cliffGrassRings) rebuildHybridGrassGeometries(cliffGrassRings, grassState);
    grassTintDirty = true;
    syncGrassUniforms();
  }

  // ── Props system ───────────────────────────────────────────────────────────
  const propStore = new PropStore();
  const propTextureLibrary = createPropTextureLibrary();
  propInstancer = new PropInstancer(scene, propStore);
  const gltfLoader = getSharedGltfLoader();

  // Instanced cliff collision — one shared BVH per solid type, auto-syncs with
  // propStore edits (place/move/delete never rebakes anything).
  const solidCollider = new SolidCollider(propStore);
  colliderSources.push(solidCollider);

  // Bake the cliff-top height surface for cliff grass by raycasting down onto
  // the solid props (cliffs). Cheap enough to run on demand — the collider
  // early-outs on texels that miss every cliff bounding box.
  function bakeCliffGrassSurface() {
    const terrainHeightAt = (wx, wz) =>
      sampleTerrainHeight((wx + WORLD_SIZE / 2) / WORLD_SIZE, (wz + WORLD_SIZE / 2) / WORLD_SIZE);
    // Skip the raycast entirely outside the cliffs' combined footprint — most
    // texels in a big world sit over open terrain and can't hit any cliff.
    const bounds = solidCollider.worldBounds();
    const bMinX = bounds ? bounds.min.x : Infinity, bMaxX = bounds ? bounds.max.x : -Infinity;
    const bMinZ = bounds ? bounds.min.z : Infinity, bMaxZ = bounds ? bounds.max.z : -Infinity;
    const raycastDown = (wx, wz) => {
      if (wx < bMinX || wx > bMaxX || wz < bMinZ || wz > bMaxZ) return null;
      return solidCollider.raycastDown(wx, 1e5, wz, Infinity);
    };
    grassTerrainData.rebuildCliffHeightTex(raycastDown, terrainHeightAt, WORLD_SIZE);
    grassTerrainData.cliffSurfaceGen = propStore.gen;
    ensureCliffGrassBuilt();
  }
  // Re-bake before cliff painting if cliffs changed since the last bake.
  function ensureFreshCliffSurface() {
    if (grassTerrainData.cliffSurfaceGen !== propStore.gen) bakeCliffGrassSurface();
  }

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

  registerProceduralObjectFactories(livePropManager);
  // The RTS kit (sandbag emplacements, huts, drums…). Separate from v2's road
  // objects because it is drawn for a camera 34 m up — see rtsObjectProps.
  registerRtsObjectFactories(livePropManager);

  // Collectibles: the field renders them (GPU-instanced), the runtime owns pickups.
  collectibleBurst = createCollectibleBurst(scene);
  collectibleRuntime = createCollectibleRuntime({
    field: livePropManager.collectibles,
    burst: collectibleBurst,
    playSfx: createCollectibleSfx(null).play,
  });

  rebakePlayerBvh = () => {
    livePropManager.update(0);
    cliffBvh.bake(terrainStoreAdapter, editorConfig, [propStore, livePropManager]);
    console.log("[V3] Player BVH rebaked:", cliffBvh.baked, "instances:", propStore.totalCount);
    bvhDebug?.rebuild();
  };

  bvhDebug = createBvhDebugVisualizer(scene, {
    getCliffBvh: () => worldCollider,
    getTreeBvh: () => treeBvh,
    rebakeCliff: () => rebakePlayerBvh(),
  });
  if (bvhDebugUi.enabled) bvhDebug.setEnabled(true);

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
    getWorldHeight: (wx, wz) => terrainStoreAdapter.getWorldHeight(wx, wz),
    worldSize: WORLD_SIZE,
    cliffBvh,
  });

  function _rebuildSlotMaterial(slotIdx) {
    const slot = propSlots[slotIdx];
    if (!slot || slot.live || slot.typeIdx == null) return false;
    const type = propStore.types[slot.typeIdx];
    if (!type) return false;

    const useEmbedded = slot.materialId == null || slot.materialId === "__embedded__";
    if (useEmbedded) {
      if (!type.embeddedMaterials?.length) return false;
      type.entries.forEach((e, i) => {
        e.material = type.embeddedMaterials[i] ?? type.embeddedMaterials[0];
      });
      propInstancer.refreshTypeMaterials(slot.typeIdx);
      return true;
    }

    const propMat = propTextureLibrary.getById(slot.materialId);
    if (!propMat) return false;
    // `slot.kit` (rock/cliff kits) and bare `slot.solid` (imported cliff GLBs)
    // both run a shading layer below, and both multiply over the base colour.
    const layered = Boolean(slot.kit) || Boolean(slot.solid);
    const newMat = propMaterialFor(propMat, { triplanar: !!slot.triplanar, plain: layered });
    // Procedural rocks/cliffs keep their baked shading through a material
    // change or a project load. Solid ROCKS never took the cliff grass blend:
    // before this, a reload gave boulders grass tops they did not have when added.
    if (slot.kit) _finishKitMaterial(newMat, slot.kit, propMat.id === "__none__");
    else if (slot.solid) applyCliffTerrainBlend(newMat, cliffBlendDeps);
    for (const e of type.entries) e.material = newMat;
    propInstancer.setTypeMaterial(slot.typeIdx, newMat);
    return true;
  }

  function setPropSlotMaterial(slotIdx, materialId) {
    const slot = propSlots[slotIdx];
    if (!slot || slot.live) return;
    slot.materialId = materialId;
    _rebuildSlotMaterial(slotIdx);
  }

  function setPropSlotTriplanar(slotIdx, enabled) {
    const slot = propSlots[slotIdx];
    if (!slot || slot.live) return;
    if (!slot.materialId || slot.materialId === "__embedded__") return;
    slot.triplanar = !!enabled;
    _rebuildSlotMaterial(slotIdx);
  }

  // Back-compat aliases used by the props panel for primitives.
  function setPrimitiveMaterial(slotIdx, materialId) {
    setPropSlotMaterial(slotIdx, materialId);
  }

  function setPrimitiveTriplanar(slotIdx, enabled) {
    setPropSlotTriplanar(slotIdx, enabled);
  }

  // Ghost for Place mode: collectibles build theirs from the kind registry, everything else
  // falls back to the procedural-object preview builder.
  const propPlacementPreview = new PropPlacementPreview(
    scene,
    propStore,
    (factoryId) => (isCollectibleFactoryId(factoryId)
      ? buildCollectibleGhostGroup(factoryId)
      : buildProceduralPreviewGroup(factoryId)),
  );

  let _lastMouseEvent = null;
  /** Props copied with Ctrl+C (session only). */
  let _propClipboard = null;
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

  const splineTerrainConfig = createV3SplineTerrainConfig(WORLD_SIZE, HEIGHTMAP_SIZE, MAX_HEIGHT);
  const v3TerrainStore = createV3TerrainStoreAdapter({
    cpuHeightmap,
    heightmapSize: HEIGHTMAP_SIZE,
    worldSize: WORLD_SIZE,
    maxHeight: MAX_HEIGHT,
    config: splineTerrainConfig,
  });
  // Shared by lakes and River v2's realistic surface.
  const waterNormalMap = new THREE.TextureLoader().load("/textures/waterNormal.webp");
  waterNormalMap.wrapS = waterNormalMap.wrapT = THREE.RepeatWrapping;
  waterNormalMap.colorSpace = THREE.NoColorSpace;   // it's a normal map, not colour

  // ── Lakes ──────────────────────────────────────────────────────────────────
  // No terrain hookup: the shoreline comes from the depth buffer every frame, so
  // sculpting under a lake needs no invalidation, rebase or rebuild.
  lakeSystem = new LakeSystem({
    scene,
    toolState: lakeToolSlice,
    normalMap: waterNormalMap,
    sampleTerrainHeight,
    worldSize: WORLD_SIZE,
    // A fall landing in a lake re-solves when the lake moves.
    onChanged: () => { waterSurfaceMap.markDirty(); waterfallSystem?.markDirty(); },
  });
  worldEnv?.addWaterSurface(lakeSystem);
  // Undo for lake placement: the rectangles and their water level. The water
  // look (panel material settings) is not part of it, like other panels.
  const lakeHistory = createSnapshotHistory({
    capture: () => JSON.stringify(lakeSystem.exportData().lakes),
    restore: (snap) => {
      const active = lakeToolSlice.lake.activeIndex;
      lakeSystem.importData({ lakes: JSON.parse(snap) });
      lakeSystem.setActiveIndex(active);
      lakeUi?.refresh();
    },
  });

  // ── River v2 ───────────────────────────────────────────────────────────────
  riverV2System = new RiverV2System({
    scene,
    toolState: { riverV2: riverV2Slice.riverV2 },
    renderer,
    getRT: () => sculpt.getCurrentRT(),
    cpuHeightmap,
    waterNormalMap,
    getCamera: () => camera,
    onConformCommitted: () => {
      markHeightmapDirty();
      requestHeightmapReadback();
      bvhDebug?.update();
    },
    onWaterMeshesChanged: () => { waterSurfaceMap.markDirty(); waterfallSystem?.markDirty(); },
    onRiverFieldChanged: (hasRivers) => {
      riverSandShading.setActive(hasRivers);
      // "Grows near water" is ignored while the world has no river, so the
      // first river (or the last one deleted) changes where plants may grow.
      syncFlowerUniforms();
      syncFoliageScatterUniforms();
      foliageUi?.rebuild();
    },
  });
  worldEnv?.addWaterSurface(riverV2System);
  // The distance field and path texture are stable render targets, so this is a
  // one-time hookup; their CONTENTS change on every conform.
  riverSandShading.setSources(riverV2System.nearTexture, riverV2System.pathTexture);
  flowerTintShading.setRiverSource(riverV2System.nearTexture);
  riverSandShading.syncParams(riverV2Slice.riverV2.sand);

  // Lakes and rivers exist — the lakebed shading's water-surface map can now
  // see their meshes. Terrain edits change where water meets ground, but the
  // MAP only stores the water surfaces' own Y, so only water edits rebake it.
  waterSurfaceMap.setSourceProvider(() => [
    lakeSystem.group,
    ...riverV2System.meshes,
  ]);

  // ── Waterfalls ─────────────────────────────────────────────────────────────
  // Water surface Y at a point: ocean, lakes, River v2 — what a fall lands in.
  function waterLevelAt(wx, wz) {
    let level = -Infinity;
    const o = worldToolState.worldOcean;
    if (o?.enabled) level = o.seaLevel ?? 0;
    for (const L of lakeSystem.lakes) {
      if (Math.abs(wx - L.cx) <= L.sizeX * 0.5 && Math.abs(wz - L.cz) <= L.sizeZ * 0.5 && L.level > level) {
        level = L.level;
      }
    }
    const f = riverV2System?.sampleFlow(wx, wz);
    if (f?.inChannel && f.surfaceY > level) level = f.surfaceY;
    return level;
  }
  waterfallSystem = new WaterfallSystem({
    scene,
    renderer,
    // The same tiling normal map the lakes and River v2 use: the fall runs
    // River v2's shader, so it needs the same input.
    normalMap: waterNormalMap,
    // The highest surface at or below yFrom: terrain, or a solid (cliff prop,
    // spline feature, tunnel) standing on it. The fall clings to whichever.
    sampleGround: (x, yFrom, z) => {
      const n = sampleTerrainNormal(x, z);
      let best = { y: getWorldHeight(x, z), nx: n.x, ny: n.y, nz: n.z };
      if (worldCollider.baked && yFrom > best.y) {
        const h = worldCollider.raycastDown(x, yFrom, z, yFrom - best.y + 0.5);
        if (h && h.y > best.y) best = h;
      }
      return best;
    },
    sampleWater: waterLevelAt,
    getRiverWater: () => riverV2Slice.riverV2.water,
    getRiverMouth: (id) => riverV2System.mouthOf(id),
    // The ground before any river carved it — see the brink march.
    sampleBaseGround: (x, z) => riverV2System.sampleBase(x, z),
    getRiverMouths: () => riverV2System.mouths(),
    setRiverMouthOpen: (id, open) => riverV2System.setMouthOpen(id, open),
  });
  worldEnv?.addWaterSurface(waterfallSystem);
  /** A fall only turns about Y: the rotate gizmo shows just that ring. */
  function applyWaterfallGizmoAxes() {
    const turnOnly = tc.mode === "rotate";
    tc.showX = !turnOnly;
    tc.showZ = !turnOnly;
    tc.showY = true;
  }
  if (isEditor) {
    waterfallEditor = createWaterfallEditor({
      system: waterfallSystem,
      scene,
      attachGizmo: (_fall, proxy) => {
        applyGizmoSettings();
        if (tc.mode === "scale") tc.setMode("translate");
        tc.attach(proxy);
        tc.enabled = true;
        tc.visible = true;
        _gizmoTarget = "waterfall";
        applyWaterfallGizmoAxes();
      },
      detachGizmo: () => {
        if (_gizmoTarget !== "waterfall") return;
        tc.showX = tc.showY = tc.showZ = true;
        _detachGizmo();
      },
      onChanged: () => { waterfallUi?.rebuild(); sceneOutliner?.update(true); },
    });
    if (waterfallPanel) waterfallUi = buildWaterfallPanel(waterfallPanel, {
      system: waterfallSystem,
      editor: waterfallEditor,
      onLookChanged: () => waterfallSystem.syncLook(),
      onOpenRiver: () => setEditorMode("riverv2"),
    });
  }

  // Keep the river system's uncarved-base RT in sync with every non-river
  // terrain edit (sculpt strokes, sculpt undo/redo, procedural gen, spline
  // plateau, heightmap load — the last three all route through
  // replaceHeightData). Internal sculptBrush calls bypass these wrappers, so
  // only user-facing edit boundaries trigger a rebase.
  {
    const _endStroke = sculpt.endStroke;
    const _undo = sculpt.undo;
    const _redo = sculpt.redo;
    const _replace = sculpt.replaceHeightData;
    const terrainEdited = () => {
      riverV2System.notifyTerrainEdited();
      waterfallSystem?.markDirty();
    };
    sculpt.endStroke = (...a) => { const r = _endStroke(...a); terrainEdited(); return r; };
    sculpt.undo = (...a) => { const r = _undo(...a); if (r) terrainEdited(); return r; };
    sculpt.redo = (...a) => { const r = _redo(...a); if (r) terrainEdited(); return r; };
    sculpt.replaceHeightData = (...a) => { const r = _replace(...a); terrainEdited(); return r; };
  }

  // ── Smart Road (v2 Smart Road 2 lab system + heightmap terrain conform) ─────
  roadConform = new RoadConformSystem({
    cpuHeightmap,
    heightmapSize: HEIGHTMAP_SIZE,
    worldSize: WORLD_SIZE,
    maxHeight: MAX_HEIGHT,
    terrainStore: v3TerrainStore,
  });
  roadSystem = new SmartRoadLabSystem({
    scene,
    // With live grading the road drapes on the pre-grade BASE terrain (the
    // lab's terrainBase trick) so the flatten never feeds back into the drape.
    getHeight: (x, z) =>
      roadState.liveGrade && roadConform.hasBase
        ? roadConform.sampleGround(x, z)
        : v3TerrainStore.getWorldHeight(x, z),
    params: roadState,
  });
  roadSystem.setEditActive(false); // roads are world geometry; handles gated to road mode
  // Undo for the road network (nodes, edges, bends, bridges, lifts). Selection
  // is left out so a click that only selects adds no step; the road panel's
  // width/profile settings are not part of it, like other panels. A restore
  // rebuilds the road, and the rebuild re-applies live grading.
  const roadHistory = createSnapshotHistory({
    capture: () => {
      const { nodes, edges, nextNodeId } = roadSystem.exportData();
      return JSON.stringify({ nodes, edges, nextNodeId });
    },
    restore: (snap) => roadSystem.importData(JSON.parse(snap)),
  });

  let _roadGradeTimer = 0;
  function applyRoadGradeNow() {
    clearTimeout(_roadGradeTimer);
    _roadGradeTimer = 0;
    if (!roadState.liveGrade || !roadConform.hasBase) return;
    if (roadConform.applyLive(roadSystem, roadState)) pushHeightmapEditsToGpu();
  }
  /** Debounced live grade — one undoable heightmap stroke per edit action, not
   *  per throttled rebuild while a slider is moving. */
  function scheduleRoadGrade() {
    if (!roadState.liveGrade || editorMode !== "road" || !roadConform.hasBase) return;
    clearTimeout(_roadGradeTimer);
    _roadGradeTimer = setTimeout(applyRoadGradeNow, 250);
  }
  {
    const _roadRebuild = roadSystem.rebuild.bind(roadSystem);
    roadSystem.rebuild = () => {
      _roadRebuild();
      if (roadSystem._dragging) return; // draft rebuild — footprints are stale
      mergeRoadDrawCalls(roadSystem.roadGroup); // ~140 piece meshes → 1 per material
      scheduleRoadGrade();
    };
  }
  _onLeaveRoadMode = () => {
    if (_roadDrag.nodeId !== null || _roadDrag.edge) {
      _roadDrag.nodeId = null;
      _roadDrag.edge = null;
      roadSystem.setDragging(false);
      roadHistory.commit();
    }
    // Flush a pending grade before another tool edits the terrain under us.
    if (_roadGradeTimer) applyRoadGradeNow();
    syncEditorOrbitEnabled();
  };
  // Roads no longer autosave to localStorage — they live in the project file
  // (.v3proj) like every other system, so refresh behaviour is consistent.
  try { localStorage.removeItem("v3.smartRoad.network"); } catch (_) {}

  const splineChunkStreamStub = { markDirtyRects() {} };
  const splineTreeStoreStub = {
    addTree: (...args) => treeEnv.treeStore.addTree(...args),
    hasTreeNearby: (...args) => treeEnv.treeStore.hasTreeNearby(...args),
    syncAllHeights: () => { treeEnv.syncTreeHeights(); },
  };

  splineSys = new SplineSystem({
    scene,
    toolState: splineToolState,
    config: splineTerrainConfig,
    terrainStore: v3TerrainStore,
    chunkStream: splineChunkStreamStub,
    treeStore: splineTreeStoreStub,
    propStore,
    getWorldHeight,
    getRoadSegments: () => [],
    onVolumesChange: () => worldEnv?.rebuildInteriorVolumes(),
  });
  worldEnv?.rebuildInteriorVolumes();

  // Spline-mode objects (bridges, fences, docks, wire…) collide too. Their
  // meshes live in splineSys.linearFeatures, not the PropStore, so they get
  // their own SolidCollider fed by a PropStore-shaped view of that list.
  splineFeatureStore = createSplineFeatureColliderStore(
    () => splineSys?.linearFeatures ?? [],
  );
  const splineFeatureCollider = new SolidCollider(splineFeatureStore);
  colliderSources.push(splineFeatureCollider);

  // ── Tunnels ────────────────────────────────────────────────────────────────
  tunnelSystem = new TunnelSystem({
    scene,
    toolState: tunnelToolSlice,
    splatMap,
    heightAt: (wx, wz) => {
      const u = (wx + WORLD_SIZE / 2) / WORLD_SIZE, v = (wz + WORLD_SIZE / 2) / WORLD_SIZE;
      return (u < 0 || u > 1 || v < 0 || v > 1) ? 0 : sampleTerrainHeight(u, v);
    },
    worldSize: WORLD_SIZE,
    splatRes: SPLAT_RES,
    getCamera: () => camera,
    onChanged: () => bvhDebug?.update?.(),
  });
  // Same PropStore-shaped view the spline objects use: the tube is real
  // triangles for the capsule (floor, walls, arch), cars and the plane.
  tunnelColliderStore = createSplineFeatureColliderStore(() => tunnelSystem?.colliderFeatures ?? []);
  colliderSources.push(new SolidCollider(tunnelColliderStore));

  // ── Lane road (3D preview) ─────────────────────────────────────────────────
  // Built on the terrain and grades it (its OWN RoadConformSystem, separate
  // from Smart Road's, same undoable heightmap push); collides in play mode.
  // No project data yet. Nothing is built until the mode is first entered.
  laneRoadSystem = new LaneRoadSystem({
    scene,
    toolState: laneRoadToolSlice,
    groundAt: (x, z) => getWorldHeight(x, z),
    viewTarget: () => controls.target,
    conform: new RoadConformSystem({
      cpuHeightmap,
      heightmapSize: HEIGHTMAP_SIZE,
      worldSize: WORLD_SIZE,
      maxHeight: MAX_HEIGHT,
      terrainStore: v3TerrainStore,
    }),
    onTerrainEdited: () => pushHeightmapEditsToGpu(),
  });

  _onLeaveSplineMode = () => {
    splineSys.dragging = false;
    splineSys.clearPreview();
    syncEditorOrbitEnabled();
  };

  const _propPickRay = new THREE.Raycaster();
  const _propPickNdc = new THREE.Vector2();
  let _onPropSelectionChanged = null;

  function getPropStats() {
    let staticCount = 0;
    let liveGroupCount = 0;
    let liveInstancedCount = 0;

    for (const inst of propStore.instances) {
      const type = propStore.types[inst.typeIdx];
      if (!type) continue;
      if (type.live) {
        if (livePropManager.isInstancedCollectible?.(type.factoryId)) liveInstancedCount++;
        else liveGroupCount++;
      } else {
        staticCount++;
      }
    }

    return {
      total: propStore.totalCount,
      staticCount,
      liveGroupCount,
      liveInstancedCount,
      // Prop meshes grow as needed, so there is no per-type cap to report.
      maxPerType: null,
      nearCapTypes: [],
    };
  }

  function refreshPropCount() {
    uiById("props-panel")?._refreshPropStats?.();
  }

  function activatePropSelection(instIdx) {
    // Keep an existing multi-selection intact when the primary is part of it
    // (e.g. after a group duplicate) — otherwise collapse to single-select.
    const groupHasIt = propInstancer.selectionCount > 1
      && propInstancer.selectedIndices.includes(instIdx);
    if (!groupHasIt) propInstancer.select(instIdx);
    applyGizmoSettings();
    tc.attach(propInstancer.proxyObject);
    tc.setMode(propState.transformMode);
    tc.enabled = true;
    tc.visible = true;
    _gizmoTarget = "prop";
    propSys.recordStampFromInstance(instIdx);
    _onPropSelectionChanged?.(instIdx);
    propPlacementPreview.hide();
    refreshGizmoHud();
  }

  // The selected prop was erased, cleared or undone away: drop the gizmo too.
  propInstancer.onSelectionLost = () => deactivatePropSelection();

  function deactivatePropSelection() {
    propInstancer.clearSelection();
    if (_gizmoTarget === "prop") _detachGizmo();
    _onPropSelectionChanged?.(null);
    refreshPropPlacementPreview();
    syncEditorOrbitEnabled();
    refreshGizmoHud();
  }

  _onLeavePropsMode = () => {
    deactivatePropSelection();
    propPlacementPreview.hide();
    syncEditorOrbitEnabled();
  };

  _onGizmoDragEnd = () => {
    if (_gizmoTarget === "prop") {
      propSys.handleTransformEnd();
      propSys.endEdit();
    }
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

  /**
   * @param {File} file
   * @param {{ keep?: boolean }} [opts] keep: store the file inside the project
   *   (default). false for a file fetched back from /models, which reloads by name.
   */
  async function loadGltfAsType(file, { keep = true } = {}) {
    const url = URL.createObjectURL(file);
    const name = file.name.replace(/\.[^.]+$/, "");
    const glbRef = keep ? await projectAssets.addRef(file) : null;
    return new Promise((resolve, reject) => {
      gltfLoader.load(url, (gltf) => {
        URL.revokeObjectURL(url);
        const typeIdx = propStore.registerType(gltf.scene, name);
        if (typeIdx < 0) { reject(new Error("No meshes in GLTF")); return; }
        propInstancer.onTypeRegistered(typeIdx);
        const slotIdx = propSlots.length;
        propSlots.push({
          name,
          loaded: true,
          typeIdx,
          builtin: false,
          live: false,
          glbFile: file.name,
          glbRef,
          materialId: "__embedded__",
        });
        propState.activeSlot = slotIdx;
        uiById("props-panel")?._rebuildPropUi?.();
        resolve(typeIdx);
      }, undefined, (err) => { URL.revokeObjectURL(url); reject(err); });
    });
  }

  /**
   * Make a GLB prop slot a PLACED PLANT (Vegetation → Placed plants): brush
   * rules on the slot, leaf materials cut out instead of blended (a GLB's
   * BLEND leaves sort badly and write no depth), and no collision unless the
   * plant asks for it. Runs in games too — a loaded level's plants need the
   * same materials and collision.
   */
  function makePlantSlot(slotIdx, settings) {
    const slot = propSlots[slotIdx];
    const type = slot && propStore.types[slot.typeIdx];
    if (!type) return;
    slot.plant = { ...PLACED_PLANT_DEFAULTS, ...settings };
    // Leaves cut out, then the material becomes a NODE material so the plant
    // can sway (plantSway.js). Generated LOD1/2 share LOD0's material; an
    // imported LOD carries its own and stands still.
    const sway = _plantSway.get(slot) ?? createSwayUniforms();
    _plantSway.set(slot, sway);
    for (const e of type.entries) {
      for (const mat of Array.isArray(e.material) ? e.material : [e.material]) {
        if (mat) fixFoliageTransparency(mat);
      }
      if (!Array.isArray(e.material)) e.material = applySway(toPlantNodeMaterial(e.material), sway);
    }
    type.embeddedMaterials = type.entries.map((e) => e.material);
    type.noCollide = !slot.plant.collide;
    syncPlantSway(slot);
    propInstancer.refreshTypeMaterials(slot.typeIdx);
    propStore._bump();
    propSys.bvh?.invalidate();
  }

  /**
   * Feed one plant's sway from its own Wind × and the world's wind, so placed
   * plants breathe with the grass and the painted plants.
   */
  function syncPlantSway(slot) {
    const u = _plantSway.get(slot);
    const type = slot && propStore.types[slot.typeIdx];
    if (!u || !type) return;
    const h = Math.max(0.05, type.mergedBox.max.y - Math.min(0, type.mergedBox.min.y));
    const wind = (slot.plant?.wind ?? 1) * ((grassState.windStrength ?? 1.4) / 1.4);
    u.uPlantHeight.value = h;
    u.uSwayAmp.value = h * 0.05 * wind;
    u.uLeafAmp.value = h * 0.02 * wind;
    u.uSwaySpeed.value = 0.9 * ((grassState.windSpeed ?? 0.2) / 0.2);
  }
  function syncAllPlantSway() {
    for (const slot of propSlots) if (slot?.plant) syncPlantSway(slot);
  }

  /** The picker picture of a placed plant: its own meshes, baked once. */
  async function queuePlacedThumb(slotIdx) {
    if (!isEditor) return;
    const slot = propSlots[slotIdx];
    const type = slot && propStore.types[slot.typeIdx];
    if (!type) return;
    try {
      const tiles = await withRendererSideWork(() => bakeObjectThumbnails({
        renderer,
        size: 128,
        items: [{
          key: "p",
          make: () => {
            const g = new THREE.Group();
            for (const e of type.entries) {
              const m = new THREE.Mesh(e.geometry, e.material);
              m.matrixAutoUpdate = false;
              m.matrix.copy(e.localMatrix);
              g.add(m);
            }
            return g;
          },
        }],
      }));
      const url = tiles.get("p");
      if (url) { _placedThumbs.set(slot, url); vegUi?.refreshCards(); }
    } catch (err) {
      console.warn(`[V3] plant thumbnail "${slot.name}" failed:`, err);
    }
  }

  /**
   * Import a GLB as a collectible kind. Its submeshes join the GPU collectible field, so every
   * placed copy is drawn by the same handful of instanced calls and picked up by the same runtime
   * as the built-in coin/heart/key.
   */
  async function importGlbCollectible(preselectedFile = null) {
    const handle = async (file) => {
      const glbRef = await projectAssets.addRef(file);
      return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const name = file.name.replace(/\.[^.]+$/, "");
      gltfLoader.load(url, (gltf) => {
        URL.revokeObjectURL(url);
        try {
          // Flatten the GLB hierarchy: each mesh, with its place in the tree baked to a matrix.
          const submeshes = [];
          gltf.scene.updateMatrixWorld(true);
          const rootInv = new THREE.Matrix4().copy(gltf.scene.matrixWorld).invert();
          gltf.scene.traverse((child) => {
            if (!child.isMesh || !child.geometry) return;
            submeshes.push({
              geometry: child.geometry,
              material: child.material,
              localMatrix: new THREE.Matrix4().multiplyMatrices(rootInv, child.matrixWorld),
            });
          });
          if (submeshes.length === 0) throw new Error("No meshes in GLTF");

          const spec = registerGlbCollectibleKind(name, submeshes);
          const typeIdx = propStore.registerLiveType(spec.name, spec.kind, spec.defaults);
          propInstancer.onTypeRegistered(typeIdx);
          const slotIdx = propSlots.length;
          propSlots.push({
            name: spec.name,
            loaded: true,
            typeIdx,
            live: true,
            factoryId: spec.kind,
            collectible: true,
            glbFile: file.name,
            glbRef,
          });
          propState.activeSlot = slotIdx;
          uiById("props-panel")?._rebuildPropUi?.();
          console.log(
            `[V3] GLB collectible "${spec.name}" imported — kind "${spec.kind}", `
            + `${spec.parts.length} draw call(s)`,
          );
          resolve(typeIdx);
        } catch (err) { reject(err); }
      }, undefined, (err) => { URL.revokeObjectURL(url); reject(err); });
      });
    };

    if (preselectedFile) return handle(preselectedFile);
    return new Promise((resolve) => {
      const inp = document.createElement("input");
      inp.type = "file";
      inp.accept = ".glb,.gltf";
      inp.addEventListener("change", async () => {
        if (!inp.files?.length) { resolve(null); return; }
        resolve(await handle(inp.files[0]).catch((err) => {
          console.error("[V3] GLB collectible import failed:", err);
          return null;
        }));
      });
      inp.click();
    });
  }

  function addPrimitive(primitiveName) {
    const existing = propSlots.find((s) => s.name === primitiveName && s.builtin);
    if (existing) {
      propState.activeSlot = propSlots.indexOf(existing);
      uiById("props-panel")?._rebuildPropUi?.();
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
    const material = propMaterialFor(defaultPropMat, { triplanar: false });
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
    uiById("props-panel")?._rebuildPropUi?.();
  }

  // Procedural chipped cliff — placed/edited like any prop, but the type is
  // flagged `solid` so SolidCollider gives it real-triangle collision and the
  // box-proxy player bake skips it.
  function addCliff(presetName) {
    const preset = CLIFF_PRESETS.find((c) => c.name === presetName);
    if (!preset) return;
    const existing = propSlots.find((s) => s.name === presetName && s.builtin);
    if (existing) {
      propState.activeSlot = propSlots.indexOf(existing);
      uiById("props-panel")?._rebuildPropUi?.();
      return;
    }
    const geometry = getRockGeometry(preset.params);
    const defaultPropMat =
      propTextureLibrary.getById("__none__") ?? propTextureLibrary.getByIndex(0);
    const material = propMaterialFor(defaultPropMat, { triplanar: true, plain: true });
    _finishKitMaterial(material, "cliff", defaultPropMat?.id === "__none__");
    const typeIdx = propStore.registerPrimitive(presetName, geometry, material);
    if (typeIdx < 0) return;
    propStore.types[typeIdx].solid = true;
    propInstancer.onTypeRegistered(typeIdx);
    const slotIdx = propSlots.length;
    propSlots.push({
      name: presetName,
      loaded: true,
      typeIdx,
      builtin: true,
      solid: true,
      kit: "cliff",
      materialId: defaultPropMat?.id ?? "__none__",
      triplanar: true,
    });
    propState.activeSlot = slotIdx;
    uiById("props-panel")?._rebuildPropUi?.();
  }

  /**
   * Material for a procedural rock ("rock") or cliff ("cliff"): baked rock
   * shading, then for cliffs the terrain blend (grass tops, contact band) on
   * top of it. `plain` = the grey "none" material, which gets the rock base
   * colour instead of its neutral grey.
   */
  function _finishKitMaterial(mat, kind, plain) {
    if (plain) {
      // Clear any base the factory supplied before the shading layers read it.
      // They multiply over `mat.colorNode`, so a greybox grid left here would be
      // baked into the rock rather than replaced by it — and with a colorNode
      // set, `mat.color` is ignored entirely, so ROCK_BASE_COLOR would be lost
      // too. Belt and braces: propMaterialFor already avoids making one.
      mat.colorNode = null;
      if (mat.color) mat.color.setHex(ROCK_BASE_COLOR);
    }
    applyRockShading(mat);
    // Genshin-style terrain integration: painted terrain color on up-facing
    // tops + per-pixel contact band from the GPU heightmap hides the base seam.
    if (kind === "cliff") applyCliffTerrainBlend(mat, cliffBlendDeps);
    return mat;
  }

  // Procedural rock kit (props/proceduralRock.js) — chipped boulders down to
  // pebbles. Meant for thousands of instances, so each size class carries its
  // own LOD distance scale, last shadow cascade and collision (boulders solid,
  // stones a box, pebbles nothing).
  function addRock(rockName) {
    const kit = ROCK_KIT.find((k) => k.name === rockName);
    if (!kit) return;
    const existing = propSlots.find((s) => s.name === rockName && s.builtin);
    if (existing) {
      propState.activeSlot = propSlots.indexOf(existing);
      uiById("props-panel")?._rebuildPropUi?.();
      return;
    }
    const geometry = createRockKitGeometry(rockName);
    const defaultPropMat =
      propTextureLibrary.getById("__none__") ?? propTextureLibrary.getByIndex(0);
    const material = propMaterialFor(defaultPropMat, { triplanar: false, plain: true });
    _finishKitMaterial(material, "rock", defaultPropMat?.id === "__none__");
    const typeIdx = propStore.registerPrimitive(rockName, geometry, material);
    if (typeIdx < 0) return;
    const cls = ROCK_CLASSES[kit.cls];
    const type = propStore.types[typeIdx];
    type.lodScale = cls.lodScale;
    type.maxShadowCascade = cls.maxShadowCascade;
    type.solid = cls.collide === "solid";
    type.noCollide = cls.collide === "none";
    propInstancer.onTypeRegistered(typeIdx);
    const slotIdx = propSlots.length;
    propSlots.push({
      name: rockName,
      loaded: true,
      typeIdx,
      builtin: true,
      solid: type.solid,
      kit: "rock",
      materialId: defaultPropMat?.id ?? "__none__",
      triplanar: false,
    });
    propState.activeSlot = slotIdx;
    uiById("props-panel")?._rebuildPropUi?.();
  }

  // Rock-set brush (tools/rockSetBrush.js): in Paint mode, one stroke lays a
  // natural mix of the whole kit instead of the active slot's single shape.
  const rockSetState = { ...ROCK_SET_DEFAULTS };

  function setRockSetEnabled(on) {
    rockSetState.enabled = !!on;
    if (!rockSetState.enabled) { propSys.scatterPlanner = null; return; }
    // every kit shape must be a registered type; registering must not steal
    // the slot the user had active
    const keepSlot = propState.activeSlot;
    const missing = ROCK_KIT.filter((k) => !propSlots.some((s) => s.name === k.name && s.builtin));
    for (const k of missing) addRock(k.name);
    propState.activeSlot = keepSlot;
    if (missing.length) uiById("props-panel")?._rebuildPropUi?.();
    propSys.scatterPlanner = (wx, wz, radius) => {
      const typesByClass = {};
      for (const k of ROCK_KIT) {
        const slot = propSlots.find((s) => s.name === k.name && s.builtin);
        if (slot && !propInstancer.hiddenTypes.has(slot.typeIdx)) (typesByClass[k.cls] ??= []).push(slot.typeIdx);
      }
      return planRockStamp({
        wx, wz, radius,
        density: propState.density,
        scaleMin: propState.scaleMin,
        scaleMax: propState.scaleMax,
        settings: rockSetState,
        typesByClass,
        store: propStore,
        getWorldHeight: (x, z) => terrainStoreAdapter.getWorldHeight(x, z),
        halfWorld: WORLD_SIZE * 0.5,
      });
    };
  }

  // Panel thumbnails for the rock kit and the chipped cliffs. Baked in the
  // background one tile at a time (yielding between, a cliff generation is
  // ~0.7 s), cached in IndexedDB by generator params, replayed from memory to
  // any later listener. The generated geometry is memoised, so clicking a card
  // after its thumbnail baked reuses the mesh instead of generating it again.
  const _kitThumbs = new Map();          // preset name → data URL
  const _kitThumbListeners = new Set();
  let _kitThumbBake = null;

  function bakeKitThumbnails(onTile, size = 128) {
    for (const [name, url] of _kitThumbs) onTile(name, url);
    _kitThumbListeners.add(onTile);
    _kitThumbBake ??= _runKitThumbBake(size).catch((err) => {
      console.warn("[V3] rock/cliff thumbnail bake failed:", err);
      _kitThumbBake = null;
    });
    return _kitThumbBake;
  }

  async function _runKitThumbBake(size) {
    await simplifierReady;
    const entries = [
      ...ROCK_KIT.map((k) => ({ name: k.name, params: rockKitParams(k.name) })),
      ...ROCK_CLIFF_PRESETS.map((c) => ({ name: c.name, params: c.params })),
    ];
    let material = null;
    for (const e of entries) {
      if (_kitThumbs.has(e.name)) continue;
      const key = thumbKey(e.params, size);
      let url = await getThumb(key);
      if (!url) {
        // let the editor draw a frame between generations
        await new Promise((r) => setTimeout(r, 60));
        material ??= applyRockShading(new THREE.MeshStandardNodeMaterial({ color: ROCK_BASE_COLOR, roughness: 0.6 }));
        const geometry = getRockGeometry(e.params);
        // normalise to a 2 m sphere: the baker clamps tiny objects to a 0.5 m
        // radius, which framed pebbles as specks
        if (!geometry.boundingSphere) geometry.computeBoundingSphere();
        const unit = 1 / Math.max(1e-3, geometry.boundingSphere.radius);
        const tiles = await withRendererSideWork(() => bakeObjectThumbnails({
          renderer,
          size,
          fill: 1.25,
          items: [{ key: e.name, make: () => { const m = new THREE.Mesh(geometry, material); m.scale.setScalar(unit); return m; } }],
        }));
        url = tiles.get(e.name) ?? null;
        if (url) putThumb(key, url);
      }
      if (!url) continue;
      _kitThumbs.set(e.name, url);
      for (const fn of _kitThumbListeners) fn(e.name, url);
    }
  }

  // Grey-box structure kit (props/greyboxKit.js) — parametric building blocks.
  // Each preset is one primitive type = one InstancedMesh = one draw call for any
  // count. Pieces with holes/slopes (`solid`) go through SolidCollider so the
  // opening is genuinely walkable; box-shaped pieces keep the cheap AABB proxy.
  function addKitPiece(pieceName) {
    const piece = GREYBOX_KIT.find((p) => p.name === pieceName);
    if (!piece) return;
    const existing = propSlots.find((s) => s.name === pieceName && s.builtin);
    if (existing) {
      propState.activeSlot = propSlots.indexOf(existing);
      uiById("props-panel")?._rebuildPropUi?.();
      return;
    }
    const geometry = buildGreyboxGeometry(pieceName);
    if (!geometry) return;
    const defaultPropMat =
      propTextureLibrary.getById("__none__") ?? propTextureLibrary.getByIndex(0);
    const material = propMaterialFor(defaultPropMat, { triplanar: false });
    const typeIdx = propStore.registerPrimitive(pieceName, geometry, material);
    if (typeIdx < 0) return;
    if (piece.solid) propStore.types[typeIdx].solid = true;
    propInstancer.onTypeRegistered(typeIdx);
    const slotIdx = propSlots.length;
    propSlots.push({
      name: pieceName,
      loaded: true,
      typeIdx,
      builtin: true,
      solid: !!piece.solid,
      materialId: defaultPropMat?.id ?? "__none__",
      triplanar: false,
    });
    propState.activeSlot = slotIdx;
    uiById("props-panel")?._rebuildPropUi?.();
  }

  // Import a GLB as a solid cliff type — real-triangle collision, same
  // placement/gizmo/undo pipeline as props.
  async function importCliffGlb(preselectedFile = null) {
    const handle = async (file) => {
      const typeIdx = await loadGltfAsType(file);
      const type = propStore.types[typeIdx];
      type.solid = true;
      // v2-parity cliff look on imported GLBs: terrain color on tops + contact
      // band, but keeping each submesh's own GLB textures as the rock look.
      // GLB submeshes can share a material — wrap each source only once.
      const wrapped = new Map();
      for (const entry of type.entries) {
        if (!wrapped.has(entry.material)) {
          wrapped.set(entry.material, createCliffGlbBlendMaterial(entry.material, cliffBlendDeps));
        }
        entry.material = wrapped.get(entry.material);
      }
      type.embeddedMaterials = type.entries.map((e) => e.material);
      propInstancer.refreshTypeMaterials(typeIdx);
      const slot = propSlots.find((s) => s.typeIdx === typeIdx);
      if (slot) slot.solid = true;
      uiById("props-panel")?._rebuildPropUi?.();
      return typeIdx;
    };
    if (preselectedFile) return handle(preselectedFile);
    return new Promise((resolve) => {
      const inp = document.createElement("input");
      inp.type = "file";
      inp.accept = ".glb,.gltf";
      inp.addEventListener("change", async () => {
        if (!inp.files || inp.files.length === 0) { resolve(null); return; }
        resolve(await handle(inp.files[0]));
      });
      inp.click();
    });
  }

  function addLiveProp(livePropName) {
    const defs = {
      Flag:  { factoryId: "flag",  defaults: FLAG_DEFAULTS },
      Coin:  { factoryId: "coin",  defaults: COIN_DEFAULTS },
      Heart: { factoryId: "heart", defaults: HEART_DEFAULTS },
      Key:   { factoryId: "key",   defaults: KEY_DEFAULTS },
      ...PROCEDURAL_PROP_DEFS,
      ...RTS_PROP_DEFS,
    };
    const def = defs[livePropName];
    if (!def) return;
    const existing = propSlots.find((s) => s.name === livePropName && s.live);
    if (existing) {
      propState.activeSlot = propSlots.indexOf(existing);
      uiById("props-panel")?._rebuildPropUi?.();
      return;
    }
    const typeIdx = propStore.registerLiveType(livePropName, def.factoryId, def.defaults);
    propInstancer.onTypeRegistered(typeIdx);
    const slotIdx = propSlots.length;
    propSlots.push({ name: livePropName, loaded: true, typeIdx, live: true, factoryId: def.factoryId });
    propState.activeSlot = slotIdx;
    uiById("props-panel")?._rebuildPropUi?.();
  }

  function setPropSlotSolid(slotIdx, solid) {
    const slot = propSlots[slotIdx];
    if (!slot || slot.live) return;
    if (!propStore.setTypeSolid(slot.typeIdx, solid)) return;
    slot.solid = !!solid;
    rebakePlayerBvh();
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
    uiById("props-panel")?._rebuildPropUi?.();
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
    const loadFile = async (file) => {
      slot.lodRefs = { ...slot.lodRefs, [lod]: await projectAssets.addRef(file) };
      return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      gltfLoader.load(url, (gltf) => {
        URL.revokeObjectURL(url);
        propStore.registerTypeLod(slot.typeIdx, lod, gltf.scene);
        // Cliff LODs get the same terrain blend as LOD0, wrapped before the
        // instancer builds the LOD meshes so they pick it up directly.
        if (slot.solid) {
          const lodEntries = propStore.types[slot.typeIdx]?.[lod === 1 ? "lod1Entries" : "lod2Entries"];
          const wrapped = new Map();
          for (const entry of lodEntries ?? []) {
            if (!wrapped.has(entry.material)) {
              wrapped.set(entry.material, createCliffGlbBlendMaterial(entry.material, cliffBlendDeps));
            }
            entry.material = wrapped.get(entry.material);
          }
        }
        propInstancer.onTypeLodRegistered(slot.typeIdx, lod);
        resolve();
      }, undefined, (err) => { URL.revokeObjectURL(url); reject(err); });
      });
    };
    if (preselectedFile) return loadFile(preselectedFile);
    const inp = Object.assign(document.createElement("input"), { type: "file", accept: ".glb,.gltf" });
    inp.onchange = () => { if (inp.files?.[0]) loadFile(inp.files[0]).catch(console.error); };
    inp.click();
  }

  if (isEditor) buildTreePanel({
    toolState: treeToolState,
    config: editorConfig,
    importTreeGlb: (slotIdx, lod, file) => treeEnv.importTreeGlb(slotIdx, lod, file),
    loadTreePreset: (slotIdx, file) => treeEnv.loadTreePreset(slotIdx, file),
    foliageParamChanged: (slotIdx) => treeEnv.foliageParamChanged(slotIdx),
    treeColliderChanged: () => {
      treeBvh?.invalidate();
      bvhDebug?.rebuild();
    },
    removeTreeSlot: (slotIdx) => treeEnv.removeTreeSlot(slotIdx),
    isTreeSlotLoaded: (slotIdx) => treeEnv.isSlotLoaded(slotIdx),
    getTreeThumbnail: (slotIdx) => treeEnv.getSlotThumbnail(slotIdx),
    massPlaceTrees: () => treeEnv.treeSystem.massPlace(treeToolState.treePaint.massPlaceCount),
    clearAllTrees: () => treeEnv.treeSystem.clearAll(),
    setBvhDebugEnabled,
    getBvhDebugEnabled: () => bvhDebugUi.enabled,
    syncBvhDebugToggles,
    treeCastShadowChanged: () => treeEnv.setCastShadow(treeToolState.treeLod.castShadow),
  });

  if (isEditor && ambientFxPanel) {
    ambientFxUi = buildAmbientFxPanel(ambientFxPanel, {
      fxState: ambientFxState,
      brush: ambientBrush,
      getSelected: () => _ambientFxSelected,
      setSelected: (i) => { _ambientFxSelected = i; },
      getPainted: (i) => ambientDensity.usedChannels()[i],
      onStateChanged: () => { void ensureAmbientFxBuilt(); syncAmbientFxUniforms(); },
      onFill: (i) => {
        _pushAmbientUndo();
        ambientDensity.fill(i);
        ambientFxState.effects[i].area = "painted";
        void ensureAmbientFxBuilt();
        syncAmbientFxUniforms();
      },
      onClear: (i) => {
        _pushAmbientUndo();
        // Clear THIS effect's channel only — the others keep their paint.
        ambientDensity.stamp({
          cx: 0, cz: 0, radius: WORLD_SIZE, strength: 1, falloff: 0,
          worldSize: WORLD_SIZE, channel: i, erase: true, onlyChannel: true,
        });
      },
    });
  }
  if (isEditor && foliagePanel) foliageUi = buildFoliagePanel(foliagePanel, {
    foliageBrush: foliageScatterBrush,
    foliageState: foliageScatterState,
    getLayerNames: () => textureLib.slots.map((s) => s.name),
    getHasRivers: () => (riverV2System?.rivers.length ?? 0) > 0,
    onStateChanged: () => { syncFoliageScatterUniforms(); queueFoliageThumb(foliageScatterBrush.type); },
    onGeometryChanged: (i) => { foliageScatter?.rebuildType(i, foliageScatterState.types[i]); queueFoliageThumb(i); },
    onRenamed: () => vegUi?.refreshCards(),
  });

  if (isEditor) buildPropsPanel({
    toolState: { props: propState, propSlots, propLod },
    propTextureLibrary,
    propStore,
    livePropManager,
    importPropGlb,
    addPrimitive,
    addCliff,
    addRock,
    getRockKitNames: () => ROCK_KIT.map((k) => k.name),
    rockSetState,
    setRockSetEnabled,
    bakeKitThumbnails,
    addKitPiece,
    getKitPieceNames: () => GREYBOX_KIT.map((p) => p.name),
    importCliffGlb,
    getCliffPresetNames: () => CLIFF_PRESETS.map((c) => c.name),
    addLiveProp,
    removePropSlot,
    setPropSlotSolid,
    importPropLod,
    importGlbCollectible,
    setPropSlotMaterial,
    setPropSlotTriplanar,
    setPrimitiveMaterial,
    setPrimitiveTriplanar,
    rebakeBvh: () => rebakePlayerBvh(),
    setBvhDebugEnabled,
    getBvhDebugEnabled: () => bvhDebugUi.enabled,
    syncBvhDebugToggles,
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
    propTransformModeChanged: () => {
      if (_gizmoTarget === "prop") {
        applyGizmoSettings();
        tc.setMode(propState.transformMode);
      }
    },
    refreshGizmoHud,
    propCastShadowChanged: () => propInstancer.setCastShadow(propLod.castShadow),
    getPropStats,
    getProceduralPropLabels: () => PROCEDURAL_PROP_LABELS,
    getProceduralSchema: (factoryId) => proceduralSchemaFor(factoryId),
    bakeProceduralThumbnails: (size) => withRendererSideWork(() => defaultBakeProceduralThumbnails(renderer, size)),
    set onPropSelectionChanged(fn) { _onPropSelectionChanged = fn; },
    get onPropSelectionChanged() { return _onPropSelectionChanged; },
  });
  refreshPropCount();

  // ── Project save / load (.v3proj) ──────────────────────────────────────────
  // One file for everything: terrain config + heightmap + splat + snow + trees
  // + props + roads + splines. This replaces the old road-only localStorage
  // autosave, so refresh behaviour is consistent across all systems.

  function _clearAllPropTypes() {
    deactivatePropSelection();
    for (let i = propStore.types.length - 1; i >= 0; i--) {
      propInstancer.onTypeRemoved(i);
    }
    propStore.types.length = 0;
    propStore.instances.length = 0;
    propSlots.length = 0;
    propStore._bump();
  }

  function _applyGlbSolidCliff(typeIdx) {
    const type = propStore.types[typeIdx];
    if (!type) return;
    type.solid = true;
    const wrapped = new Map();
    for (const entry of type.entries) {
      if (!wrapped.has(entry.material)) {
        wrapped.set(entry.material, createCliffGlbBlendMaterial(entry.material, cliffBlendDeps));
      }
      entry.material = wrapped.get(entry.material);
    }
    type.embeddedMaterials = type.entries.map((e) => e.material);
    propInstancer.refreshTypeMaterials(typeIdx);
    const slot = propSlots.find((s) => s.typeIdx === typeIdx);
    if (slot) slot.solid = true;
  }

  function _applySavedSlotMaterial(slotIdx, meta) {
    const slot = propSlots[slotIdx];
    if (!slot || slot.live) return;
    if (meta.materialId != null) slot.materialId = meta.materialId;
    if (meta.triplanar != null) slot.triplanar = meta.triplanar;
    _rebuildSlotMaterial(slotIdx);
  }

  async function _fetchPropModel(name) {
    for (const base of ["models/", "../models/"]) {
      try {
        const resp = await fetch(base + name);
        // Dev servers answer missing files with index.html + 200 (SPA fallback)
        if (!resp.ok || resp.headers.get("content-type")?.includes("text/html")) continue;
        return new File([await resp.blob()], name);
      } catch (_) { /* try next */ }
    }
    console.warn(`[V3] Prop asset "${name}" not found in /models — re-import it in the props panel.`);
    return null;
  }

  /**
   * Material folders imported in the props panel. Their maps are kept inside
   * the project, under the same material id the slots refer to.
   */
  async function exportCustomPropMaterials() {
    const out = [];
    for (const m of propTextureLibrary.materials) {
      if (!m.sourceFiles?.albedo) continue;
      const maps = {};
      for (const [key, file] of Object.entries(m.sourceFiles)) {
        if (file) maps[key] = await projectAssets.addRef(file);
      }
      out.push({
        id: m.id, name: m.name, maps,
        uvScale: m.uvScale, normalStrength: m.normalStrength,
        aoStrength: m.aoStrength, roughStrength: m.roughStrength,
      });
    }
    return out;
  }

  function importCustomPropMaterials(list) {
    for (const saved of list ?? []) {
      const maps = {};
      for (const [key, ref] of Object.entries(saved.maps ?? {})) maps[key] = projectAssets.fileFor(ref);
      if (!maps.albedo) {
        console.warn(`[V3] Prop material "${saved.name}" is missing its textures; slots using it fall back.`);
        continue;
      }
      const mat = propTextureLibrary.addMaterialFromFiles([], { id: saved.id, name: saved.name, maps });
      if (!mat) continue;
      propTextureLibrary.applyOverrides({ [mat.id]: saved });
    }
  }

  /** Re-register prop types from saved slot metadata before instance import. */
  async function restorePropSlots(savedSlots, savedTypes) {
    _clearAllPropTypes();

    let slots = savedSlots;
    if (!slots?.length && savedTypes?.length) {
      // Legacy projects saved types/instances but not slot metadata.
      slots = savedTypes.map((t) => ({
        name: t.name,
        builtin: t.isPrimitive ?? false,
        live: t.live ?? false,
        solid: t.solid ?? false,
        factoryId: t.factoryId,
      }));
    }

    const cliffNames = new Set(CLIFF_PRESETS.map((c) => c.name));
    const kitNames   = new Set(GREYBOX_KIT.map((p) => p.name));

    for (const meta of slots) {
      try {
        if (meta.live && meta.collectible && meta.glbFile) {
          const file = (meta.glbRef && projectAssets.fileFor(meta.glbRef)) ?? await _fetchPropModel(meta.glbFile);
          if (file) await importGlbCollectible(file);
        } else if (meta.live) {
          addLiveProp(meta.name);
        } else if (meta.glbFile) {
          // Kept inside the project first; older projects look in /models.
          const kept = meta.glbRef ? projectAssets.fileFor(meta.glbRef) : null;
          const file = kept ?? await _fetchPropModel(meta.glbFile);
          if (file) {
            const typeIdx = await loadGltfAsType(file, { keep: !!kept });
            if (meta.solid) _applyGlbSolidCliff(typeIdx);
            const slotIdx = propSlots.findIndex((s) => s.typeIdx === typeIdx);
            if (slotIdx >= 0) {
              _applySavedSlotMaterial(slotIdx, meta);
              if (meta.plant) { makePlantSlot(slotIdx, meta.plant); void queuePlacedThumb(slotIdx); }
              for (const [lod, ref] of Object.entries(meta.lodRefs ?? {})) {
                const lodFile = projectAssets.fileFor(ref);
                if (lodFile) await importPropLod(slotIdx, Number(lod), lodFile);
              }
            }
          }
        } else if (meta.builtin && cliffNames.has(meta.name)) {
          addCliff(meta.name);
          _applySavedSlotMaterial(propSlots.length - 1, meta);
        } else if (meta.builtin && kitNames.has(meta.name)) {
          addKitPiece(meta.name);
          _applySavedSlotMaterial(propSlots.length - 1, meta);
        } else if (meta.builtin && ROCK_KIT.some((k) => k.name === meta.name)) {
          // rocks are simplified at generation; without the WASM they come out dense
          await simplifierReady;
          addRock(meta.name);
          _applySavedSlotMaterial(propSlots.length - 1, meta);
        } else if (meta.builtin) {
          addPrimitive(meta.name);
          _applySavedSlotMaterial(propSlots.length - 1, meta);
        } else {
          console.warn(`[V3] Cannot restore prop slot "${meta.name}" — re-import the GLB.`);
        }
      } catch (err) {
        console.warn(`[V3] Prop slot "${meta.name}" restore failed:`, err);
      }
    }

    uiById("props-panel")?._rebuildPropUi?.();
  }

  async function saveProject() {
    await syncHeightmapToCPU();
    // River v2 reshapes the terrain from the UNCONFORMED base ground, so the
    // project stores that base plus the rivers, and the load re-conforms.
    // Saving the conformed result instead would cut every channel twice.
    const riversV2 = riverV2System.exportData();
    const baseHeightmap = riversV2 ? riverV2System.exportBaseHeightmap() : null;
    const treeInstances = [];
    for (const arr of treeEnv.treeStore.chunks.values()) {
      for (const t of arr) treeInstances.push([t.x, t.z, t.y, t.rotY, t.scale, t.slotIdx]);
    }
    // Files imported from disk travel inside the project: gather the sections
    // that can refer to them, then write just the assets they name.
    const trees = { slots: treeToolState.treeSlots, instances: treeInstances };
    const props = propStore.exportData(propSlots);
    props.customMaterials = await exportCustomPropMaterials();
    const paintLayers = textureLib.exportData();
    const environment = {
      worldOcean: structuredClone(worldToolState.worldOcean),
      // Sky mode, sun, clouds, fog, post FX (worldEnvironment.exportLook).
      look: worldEnv?.exportLook() ?? null,
    };
    const decals = decalSystem.decals.length ? decalSystem.exportData() : null;
    const waterfalls = waterfallSystem?.falls.length ? waterfallSystem.exportData() : null;
    const buf = encodeProjectFile({
      assets:    projectAssets.collectFor({ trees: trees.slots, props: { ...props, instances: props.instances.map((i) => i.liveParams).filter(Boolean) }, paintLayers, environment, decalSlots: decals?.slots }),
      terrain:   { worldSize: WORLD_SIZE, heightmapSize: HEIGHTMAP_SIZE, splatSize: SPLAT_RES, maxHeight: MAX_HEIGHT },
      heightmap: baseHeightmap ?? cpuHeightmap,
      splat:     splatMap.exportCombined(), // painted holes only; tunnels rebuild theirs
      splatRes:  SPLAT_RES,
      splatHoles: true,
      snow:      snowMap.snapshot(),
      snowRes:   SNOW_MAP_RES,
      trees,
      props,
      roads:     roadSystem.exportData(),
      splines:   splineSys.exportData(),
      lakes:     lakeSystem.exportData(),
      decals,
      waterfalls,
      riversV2,
      tunnels:   tunnelSystem?.exportData() ?? null,
      paintLayers,
      paintBlend: {
        heightBlend: splatOverlay.uHeightBlend.value,
        contrast:    splatOverlay.uHeightContrast.value,
        macroStrength: splatOverlay.uMacroStrength.value,
        macroWarmth:   splatOverlay.uMacroWarmth.value,
        macroScale:    splatOverlay.uMacroScale.value,
      },
      /*
       * The world's LOOK, which this format has never carried. Only the ocean so
       * far — light, sky, fog and post are the same gap and the same one-key
       * change, and belong here when someone needs them.
       *
       * Written WHOLE rather than sparsely, matching susuki below. The load merges per key and ignores what it no longer knows, so a
       * param added later keeps its default on an older file instead of arriving
       * `undefined` — the contract lakeSystem.importData already uses.
       */
      environment,
      spawn:     spawnSystem.exportData(),
      grassDensity:  grassTerrainData.getDensitySnapshot(),
      grassHeight:   grassTerrainData.getBladeHeightSnapshot(),
      susukiDensity: grassTerrainData.getSusukiDensitySnapshot(),
      // version 2 = susuki is a foliage plant (createSusukiPlantState). Older
      // files carried the retired renderer's params; they load as defaults.
      // version 3 = the field carries THREE tall plants, one per RGB channel
      // of susukiDensity (`plants`, not `plant`); v2 wrote one plant and the
      // same coverage into all three channels, so it migrates on load.
      susuki:    {
        version: 3,
        plants: structuredClone(susukiState.types),
        plant: structuredClone(susukiState.types[0]),   // v2 readers
        field: (({ types, ...rest }) => rest)(susukiState),
      },
      flowerDensity: flowerDensity.hasData ? flowerDensity.getSnapshot() : null,
      foliagePaint:  foliageDensity.hasData ? foliageDensity.getSnapshot() : null,
      foliagePlants: structuredClone(foliageScatterState.types),
      foliageField:  (({ types, ...rest }) => rest)(foliageScatterState),
      // Ambient FX. Written whole, like the foliage above, and the paint only
      // when there is any: a world nobody opened the mode in saves three
      // nulls rather than 4 MB of zeros.
      ambientPaint:   ambientDensity.hasData ? ambientDensity.getSnapshot() : null,
      ambientEffects: structuredClone(ambientFxState.effects),
      ambientField:   (({ effects, ...rest }) => rest)(ambientFxState),
      flowers:   structuredClone(flowerState),
      cliffGrassDensity: grassTerrainData.getCliffDensitySnapshot(),
      cliffPaint: cliffPaintMask.getSnapshot(),
      // lodDebug is a view toggle, not the grass's look.
      grass:     { ...grassState, lodDebug: undefined },
      // The other grass system's look, saved whether or not it is the one
      // running: switching back should find the field you left.
      revoGrass: { ...revoGrassState },
      snowParams: Object.fromEntries(SNOW_LOOK_KEYS.map((k) => [k, snowSystem.params[k]])),
    });
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    downloadBuffer(buf, `project-${ts}.v3proj`);
    statusBar?.setMessage(`Project saved — project-${ts}.v3proj (${(buf.byteLength / 1048576).toFixed(1)} MB)`);
  }

  /** Best-effort reload of tree slot assets (presets/GLBs) from /models. */
  async function restoreTreeSlotAssets(slots) {
    const fetchAsset = async (name, bases) => {
      for (const base of bases) {
        try {
          const resp = await fetch(base + name);
          // Dev servers answer missing files with index.html + 200 (SPA fallback)
          if (!resp.ok || resp.headers.get("content-type")?.includes("text/html")) continue;
          return new File([await resp.blob()], name);
        } catch (_) { /* try next */ }
      }
      console.warn(`[V3] Tree asset "${name}" not found in ${bases.join(", ")} — reload it manually in the tree panel.`);
      return null;
    };
    const fetchPreset = (name) => fetchAsset(name, ["tree-presets/", "../tree-presets/", "models/", "../models/"]);
    const fetchModel = (name) => fetchAsset(name, ["models/", "../models/"]);
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      if (!s) continue;
      try {
        // Files kept inside the project first, then the server folders.
        const kept = (ref) => (ref ? projectAssets.fileFor(ref) : null);
        if (s.presetFile) {
          const f = kept(s.presetRef) ?? await fetchPreset(s.presetFile);
          if (f) await treeEnv.loadTreePreset(i, f);
        } else if (s.glbFile?.lod0) {
          const f0 = kept(s.glbRef?.lod0) ?? await fetchModel(s.glbFile.lod0);
          if (f0) await treeEnv.importTreeGlb(i, 0, f0);
          if (s.glbFile.lod1) {
            const f1 = kept(s.glbRef?.lod1) ?? await fetchModel(s.glbFile.lod1);
            if (f1) await treeEnv.importTreeGlb(i, 1, f1);
          }
        }
      } catch (err) {
        console.warn(`[V3] Tree slot ${i} asset restore failed:`, err);
      }
    }
  }

  /**
   * @param {object} d decoded project
   * @param {{ worldLook?: boolean }} [opts] worldLook: apply the saved sky, sun,
   *   clouds, fog and post FX. Defaults to startV3App's `projectWorldLook`
   *   (the editor: on; games: off, they set up their own look).
   */
  async function applyProjectData(d, { worldLook = projectWorldLook } = {}) {
    // Files the project carries (imported textures, GLBs...) before anything
    // that refers to them.
    projectAssets.load(d.assets);
    // Drop River v2's captured base BEFORE the heightmap swap: the wrapped
    // replaceHeightData would otherwise schedule a rebase that folds the
    // freshly loaded terrain into the previous scene's base.
    riverV2System.resetForLoad();
    if (d.heightmap?.length === HEIGHTMAP_SIZE * HEIGHTMAP_SIZE) {
      sculpt.replaceHeightData(d.heightmap);
      markHeightmapDirty();
    }
    await ensureCpuHeightmapFromGpu(); // fresh mirror before draping trees/roads

    // Splat resolution is independent of the heightmap, so a project may carry a
    // different one — rescale rather than discard the paint. Pre-splatSize
    // projects have no splatRes recorded; they used the legacy half-heightmap rule.
    if (d.splat) {
      const srcRes = d.splatRes ?? legacySplatSize(d.terrain?.heightmapSize ?? HEIGHTMAP_SIZE);
      if (srcRes === SPLAT_RES) {
        splatMap.setCombined(d.splat);
      } else {
        console.info(`[V3] Project splatmap ${srcRes}² → resampled to ${SPLAT_RES}².`);
        splatMap.setCombinedResampled(d.splat, srcRes);
      }
      // Older files used this alpha for Meadow paint, not holes.
      if (!d.splatHoles) {
        _legacyMeadowPainted = splatMap.hasAnyHoles();
        splatMap.clearHoleChannel();
      }
    }

    if (d.snow && d.snowRes === SNOW_MAP_RES) snowMap.restoreSnapshot(d.snow);
    // Older projects have no snow look: keep the current values.
    if (d.snowParams) applySnowParams(d.snowParams);

    // Grass look before any ring is built, so a fresh build starts from it.
    // The revo settings go first: applyGrassState is what pushes the chosen
    // system's look out to the panel and the uniforms.
    if (d.revoGrass) mergeKnownKeys(revoGrassState, d.revoGrass);
    if (d.grass) applyGrassState(d.grass);

    // Painted grass / susuki density layers (older projects simply lack them)
    if (d.grassDensity?.length === grassTerrainData.densityTex.image.data.length) {
      grassTerrainData.restoreDensitySnapshot(d.grassDensity);
      if (d.grassDensity.some((v) => v > 0)) void ensureGrassBuilt();
    }
    // Painted blade height: absent in a file (older projects) means 1x everywhere.
    if (d.grassHeight?.length === grassTerrainData.bladeHeightTex.image.data.length) {
      grassTerrainData.restoreBladeHeightSnapshot(d.grassHeight);
    } else {
      grassTerrainData.resetBladeHeight();
    }
    // Cliff paint and cliff-top grass: absent in a file means none, so a
    // project without them clears what the previous scene painted.
    if (d.cliffPaint?.length === cliffPaintMask.texture.image.data.length) {
      cliffPaintMask.restoreSnapshot(d.cliffPaint);
    } else {
      cliffPaintMask.clearAll();
    }
    cliffPaintSystem.undoStack.length = 0;
    cliffPaintSystem.redoStack.length = 0;
    if (d.cliffGrassDensity?.length === grassTerrainData.cliffDensityTex.image.data.length) {
      grassTerrainData.restoreCliffDensitySnapshot(d.cliffGrassDensity);
    } else {
      grassTerrainData.clearCliffDensity();
    }
    /*
     * The world's look. Merged PER KEY, and only for keys this build still has —
     * so a project written before a param existed keeps today's default for it
     * rather than setting it `undefined`, and a param since retired is ignored
     * rather than resurrected. Same contract as lakeSystem.importData.
     */
    if (d.environment?.worldOcean) {
      const src = d.environment.worldOcean;
      const dst = worldToolState.worldOcean;
      for (const k of Object.keys(dst)) {
        if (k === "v2") continue;
        if (src[k] !== undefined) dst[k] = src[k];
      }
      if (src.v2 && dst.v2) {
        for (const k of Object.keys(dst.v2)) {
          if (src.v2[k] !== undefined) dst.v2[k] = src.v2[k];
        }
      }
      /*
       * V2 used to take these from the SHARED World Ocean sliders, so in a
       * project saved before it got its own controls the V2 bag holds untouched
       * defaults and the real values sit at the top level. Carry them over once;
       * a bag written since carries `ownControls` and is left alone.
       */
      if (dst.v2 && !src.v2?.ownControls) {
        for (const k of [
          "windSpeed", "windAngleDeg", "fftSwellAmp", "fftRippleAmp", "fftChoppiness",
          "fftUpdateHz", "levels", "gridM", "baseCell", "horizonScale",
        ]) {
          if (src[k] !== undefined) dst.v2[k] = src[k];
        }
      }
      worldEnv?.worldOceanChanged();
      // The panel binds to the state object directly, so rebuilding it is how
      // its controls pick up values a load moved underneath them.
      buildWorldPanelUi();
    }
    if (worldLook && d.environment?.look && worldEnv) {
      await worldEnv.importLook(d.environment.look);
      buildWorldPanelUi();
    }
    if (d.susuki?.version >= 2) {
      if (d.susuki.field) Object.assign(susukiState, d.susuki.field);
      // v3 saves every tall plant; v2 saved the one the field used to hold.
      if (Array.isArray(d.susuki.plants)) {
        d.susuki.plants.forEach((p, i) => { if (susukiState.types[i]) Object.assign(susukiState.types[i], p); });
      } else if (d.susuki.plant) {
        Object.assign(susukiState.types[0], d.susuki.plant);
      }
    }
    if (d.susukiDensity?.length === grassTerrainData.susukiDensityTex.image.data.length) {
      grassTerrainData.restoreSusukiDensitySnapshot(d.susukiDensity);
      // A v2 file wrote its one plant into R, G AND B. Read as three plants
      // that is bamboo and palms erupting over the whole map; keep channel 0.
      if (!(d.susuki?.version >= 3)) grassTerrainData.collapseSusukiToChannel0();
    }
    if (d.susuki || d.susukiDensity) {
      if (susukiSystem) {
        syncSusukiUniforms();
        for (let i = 0; i < susukiState.types.length; i++) susukiSystem.rebuildType(i, susukiState.types[i]);
      } else if (grassTerrainData.hasSusukiData) {
        void ensureSusukiBuilt();
      }
      queueSusukiThumb();
      susukiUi?.rebuild();
    }

    // Flowers: absent in a file means none, so a flowerless project clears the
    // previous scene's meadow. Look settings merge per key (types by index).
    if (d.flowers) {
      const { types, ...rest } = d.flowers;
      Object.assign(flowerState, rest);
      if (Array.isArray(types)) types.forEach((t, i) => { if (flowerState.types[i] && t) Object.assign(flowerState.types[i], t); });
    }
    if (d.flowerDensity?.length === flowerDensity.tex.image.data.length) {
      flowerDensity.restoreSnapshot(d.flowerDensity);
      if (flowerDensity.hasData) void ensureFlowersBuilt();
    } else if (flowerDensity.hasData) {
      flowerDensity.clear();
    }
    _vegUndoStack.length = 0;
    _vegRedoStack.length = 0;
    syncFlowerUniforms();

    // Decals: absent means none (and the default textures).
    await decalSystem.importData(d.decals ?? null);
    decalEditor?.reset();
    if (flowerSystem && d.flowers) flowerState.types.forEach((t, i) => flowerSystem.rebuildType(i, t));
    flowerUi?.rebuild();

    // Ground-paint slots: which material each layer uses, its tiling and its
    // auto-paint rules. Awaits the boot-time default preload internally, so a
    // project opened during startup is not overwritten by it.
    // Absent in older files: leave the current values alone, as before.
    if (d.paintBlend) {
      const hb = d.paintBlend.heightBlend, hc = d.paintBlend.contrast;
      if (Number.isFinite(hb)) splatOverlay.uHeightBlend.value = Math.min(1, Math.max(0, hb));
      if (Number.isFinite(hc)) splatOverlay.uHeightContrast.value = Math.min(1, Math.max(0.01, hc));
      pslHBlend.value = String(Math.round(splatOverlay.uHeightBlend.value * 100));
      plblHBlend.textContent = splatOverlay.uHeightBlend.value.toFixed(2);
      pslHContrast.value = String(Math.round(splatOverlay.uHeightContrast.value * 100));
      plblHContrast.textContent = splatOverlay.uHeightContrast.value.toFixed(2);
      const ms = d.paintBlend.macroStrength, mw = d.paintBlend.macroWarmth, mc = d.paintBlend.macroScale;
      splatOverlay.uMacroStrength.value = Number.isFinite(ms) ? Math.min(0.5, Math.max(0, ms)) : 0;
      splatOverlay.uMacroWarmth.value   = Number.isFinite(mw) ? Math.min(1, Math.max(0, mw)) : 0;
      if (Number.isFinite(mc)) splatOverlay.uMacroScale.value = Math.min(400, Math.max(10, mc));
      syncMacroUi();
      grassTintDirty = true;
    }
    if (d.paintLayers) {
      await textureLib.importData(d.paintLayers);
      syncTriplanarCompile();
      syncRockShadeCompile();
      for (let i = 0; i < 7; i++) refreshLayerThumb(i);
      syncTexlibEditor();
    }

    // Retired features: an older file that actually USED them still loads,
    // just without that effect — say so instead of changing the look silently.
    {
      const usedGround = d.groundTsl?.enabled === true
        || d.groundTsl?.slopeTint?.enabled === true
        || d.groundTsl?.heightTint?.enabled === true;
      const meadowTexels = _legacyMeadowPainted ? 1 : 0;
      _legacyMeadowPainted = false;
      if (usedGround || meadowTexels) {
        console.warn(
          "[V3] This project used " +
          [usedGround && "Procedural Ground", meadowTexels && "painted Meadow"].filter(Boolean).join(" and ") +
          ", which were retired (2026-09-13). It loads without that effect; rebuild the look with a " +
          "procedural paint layer (Texture Library → Source: Procedural).",
        );
      }
    }

    if (d.trees) {
      treeEnv.treeStore.clear();
      if (Array.isArray(d.trees.slots)) {
        d.trees.slots.forEach((meta, i) => {
          if (meta && treeToolState.treeSlots[i]) Object.assign(treeToolState.treeSlots[i], meta);
        });
        void restoreTreeSlotAssets(d.trees.slots);
      }
      for (const t of d.trees.instances ?? []) {
        treeEnv.treeStore.addTree(t[0], t[1], t[2], t[3], t[4], t[5]);
      }
      treeEnv.syncTreeHeights();
      uiById("tree-panel")?._rebuildTreeUi?.();
    }

    // Painted foliage: absent in a file means none.
    // instances left over from the previous scene.
    if (Array.isArray(d.foliagePlants)) {
      d.foliagePlants.forEach((t, i) => { if (foliageScatterState.types[i] && t) Object.assign(foliageScatterState.types[i], t); });
    }
    if (d.foliageField) Object.assign(foliageScatterState, d.foliageField);
    // Ambient FX: absent in a file means the mode was never opened there.
    if (Array.isArray(d.ambientEffects)) {
      d.ambientEffects.forEach((e, i) => { if (ambientFxState.effects[i] && e) Object.assign(ambientFxState.effects[i], e); });
    }
    if (d.ambientField) Object.assign(ambientFxState, d.ambientField);
    // Length checked arithmetically, not against a fresh getSnapshot(): that
    // would allocate and fill 4 MB on every project load just to read .length.
    const _ambientPaintBytes = ambientDensity.res * ambientDensity.res * 4 * ambientDensity.pages;
    if (d.ambientPaint?.length === _ambientPaintBytes) {
      ambientDensity.restoreSnapshot(d.ambientPaint);
    } else {
      ambientDensity.clear();
    }
    _ambientUndoStack.length = 0;
    _ambientRedoStack.length = 0;
    if (ambientFx) syncAmbientFxUniforms();
    else if (ambientFxState.enabled) void ensureAmbientFxBuilt();
    ambientFxUi?.rebuild();

    // Against the WHOLE snapshot, not page 0 — see ScatterDensity.snapshotLength.
    if (d.foliagePaint?.length === foliageDensity.snapshotLength) {
      foliageDensity.restoreSnapshot(d.foliagePaint);
      if (foliageDensity.hasData) void ensureFoliageScatterBuilt();
    } else if (foliageDensity.hasData) {
      foliageDensity.clear();
    }
    _foliageUsedDirty = true;
    syncFoliageScatterUniforms();
    if (foliageScatter) foliageScatterState.types.forEach((t, i) => foliageScatter.rebuildType(i, t));
    queueAllFoliageThumbs();
    foliageUi?.rebuild();

    if (d.props) {
      importCustomPropMaterials(d.props.customMaterials);
      await restorePropSlots(d.props.slots, d.props.types);
      const nameToIdx = Object.fromEntries(propStore.types.map((t, i) => [t.name, i]));
      propStore.importData(d.props, nameToIdx);
      livePropManager.update(0);
      rebakePlayerBvh();
      refreshPropCount();
    }
    // The cliff-top surface cliff grass grows on is baked from the cliffs, so
    // it is rebuilt here, once they are loaded, rather than stored.
    if (grassTerrainData.hasCliffData) bakeCliffGrassSurface();
    updateCliffGrassStatus();

    if (d.roads) roadSystem.importData(d.roads);
    roadHistory.reset();
    // Paint strokes and procedural layer edits belong to the previous scene.
    paintSys.clearHistory();
    if (d.splines) splineSys.importData(d.splines);
    // Always import, even when absent: a project with no lakes must clear any
    // lakes left over from the previous scene.
    lakeSystem.importData(d.lakes ?? null);
    // importData merged the saved lakebed values into the slice; push them to the
    // terrain uniforms (the panel callback only fires on user edits).
    lakebedShading.syncParams(lakeToolSlice.lake.lakebed);
    lakeUi?.refresh();
    lakeHistory.reset();

    // Rivers restore like lakes — always import so a river-less project clears
    // leftovers. River v2 re-conforms the saved (unconformed) base heightmap.
    riverV2System.importData(d.riversV2 ?? null);
    riverSandShading.syncParams(riverV2Slice.riverV2.sand);
    riverV2Ui?.refresh();

    // Waterfalls: after the terrain, lakes and rivers they are solved against.
    // Absent means none, so a project without falls clears the previous ones.
    waterfallSystem?.importData(d.waterfalls ?? null);
    waterfallEditor?.reset();

    // Always import (a tunnel-less project clears the old ones). Runs after the
    // heightmap and splat, because the openings are cut from the loaded ground.
    tunnelSystem.importData(d.tunnels ?? null);
    tunnelUi?.refresh();

    // Also always import: a project with no player start must clear the old marker.
    spawnSystem.importData(d.spawn ?? null);
    spawnSystem.setVisible(!playMode.active);
    spawnUi?.refresh();

    onHistoryChange();
    console.log("[V3] Project loaded.");
    statusBar?.setMessage("Project loaded");
    // Its key named an object of the previous scene (indices are reused).
    inspector?.inspect(null);
  }

  /**
   * Headless / game load path. Fetches a saved .v3proj by URL (e.g. a file that
   * lives with a game project) and restores the full world through the same
   * applyProjectData the editor's Load button uses — terrain, splat, snow,
   * trees, props, roads, splines, lakes. No file picker, no size-mismatch
   * reload dance (the caller is expected to boot at the project's terrain size).
   */
  async function loadProjectFromUrl(url, { worldLook = projectWorldLook } = {}) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch project "${url}" (${res.status})`);
    const buf = await res.arrayBuffer();
    if (!isProjectFile(buf)) throw new Error(`"${url}" is not a V3 project file.`);
    await applyProjectData(decodeProjectFile(buf), { worldLook });
  }

  /**
   * Same full-world restore as loadProjectFromUrl, from raw .v3proj bytes.
   * Pass `{ worldLook: true }` to also take the project's sky and light.
   */
  async function loadProjectFromBuffer(buf, { worldLook = projectWorldLook } = {}) {
    if (!isProjectFile(buf)) throw new Error("Not a V3 project file.");
    await applyProjectData(decodeProjectFile(buf), { worldLook });
  }

  /** Toolbar Load — sniffs the file: whole project or bare heightmap. */
  async function loadAnyFile() {
    const file = await pickProjectFile();
    if (!file) return;
    try {
      const buf = await file.arrayBuffer();
      // PNG / RAW heightmaps from other tools (the Heightmap File section's path).
      if (isPng(buf) || /\.(raw|r16)$/i.test(file.name)) {
        await importHeightmapFormat(file);
        return;
      }
      if (!isProjectFile(buf)) {
        // Bare heightmap path (handles its own size-mismatch reload+stash).
        await loadHeightmapBuffer(buf);
        return;
      }
      const d = decodeProjectFile(buf);
      const t = d.terrain ?? {};
      const mismatch = t.heightmapSize !== HEIGHTMAP_SIZE
        || Math.round(t.worldSize) !== WORLD_SIZE
        || Math.round(t.maxHeight) !== MAX_HEIGHT;
      if (mismatch) {
        const ok = window.confirm(
          `This project is a ${Math.round(t.worldSize)} m world (${t.heightmapSize}², max ${Math.round(t.maxHeight)} m).\n`
          + `Reload the editor at that terrain size to open it?`,
        );
        if (!ok) return;
        // Splat resolution is NOT part of the mismatch test (it resamples on
        // load), so a project that predates splatSize must not drag the editor
        // back down to the legacy value — keep the current setting in that case.
        saveTerrainConfig({ ...t, splatSize: t.splatSize ?? SPLAT_RES });
        await stashPendingHeightmap(buf); // stash is format-agnostic — sniffed on boot
        location.reload();
        return;
      }
      await applyProjectData(d);
    } catch (err) {
      console.error(err);
      const message = err instanceof Error ? err.message : "Failed to load file.";
      statusBar?.setMessage(`Load failed: ${message}`, { kind: "error", holdMs: 0 });
      window.alert(message);
    }
  }

  // Import a file stashed across a terrain-size reload (project or heightmap).
  // The promise is exposed on the app handle (pendingWorldImport) so a game can
  // AWAIT the import before placing anything on the terrain — a fixed sleep
  // races it and seats gameplay objects on the pre-import ground.
  const pendingWorldImport = takePendingHeightmap().then(async (buf) => {
    if (!buf) return;
    try {
      if (isProjectFile(buf)) {
        await applyProjectData(decodeProjectFile(buf));
      } else {
        const decoded = decodeHeightmapFile(buf);
        if (decoded.width === HEIGHTMAP_SIZE && decoded.height === HEIGHTMAP_SIZE) {
          sculpt.replaceHeightData(decoded.heights);
          onHistoryChange();
        }
      }
    } catch (err) {
      console.warn("[V3] Pending import failed:", err);
    }
  });

  if (isEditor) buildSplinePanel({
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
      void ensureCpuHeightmapFromGpu().then(() => {
        v3TerrainStore.beginWrite();
        const changed = splineSys.applyPlateau();
        if (!changed) {
          v3TerrainStore.cancelWrite();
          return;
        }
        v3TerrainStore.commit();
        pushHeightmapEditsToGpu();
        splineSys.syncGuardrailsToGround();
        splineSys.syncKerbsToGround();
        splineSys.syncLinearFeaturesToGround();
      });
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

  // ── Spawn panel ────────────────────────────────────────────────────────────
  if (isEditor) spawnUi = buildSpawnPanel({
    mount: spawnPanel,
    spawnSystem,
    onPlaceAtCamera: () => {
      const t = controls.target;
      // Face the way the camera looks, so "place at camera" also aims the character.
      const yaw = Math.atan2(camera.position.x - t.x, camera.position.z - t.z);
      spawnSystem.setPosition(t.x, t.z, yaw);
    },
    onFaceCamera: () => {
      if (!spawnSystem.placed) return;
      const s = spawnSystem.state;
      spawnSystem.setYaw(Math.atan2(camera.position.x - s.x, camera.position.z - s.z));
    },
  });

  // ── Lake panel + drag-to-place ─────────────────────────────────────────────
  if (isEditor) lakeUi = buildLakePanel({
    toolState: lakeToolSlice,
    lakeSystem,
    waterGlobals,
    worldSize: WORLD_SIZE,
    maxHeight: MAX_HEIGHT,
    materialChanged:  () => lakeSystem.syncMaterial(),
    lakebedChanged:   () => lakebedShading.syncParams(lakeToolSlice.lake.lakebed),
    // syncActiveTransform already ran inside the panel. A slider drag fires on
    // every input; the coalesce key makes the whole drag one undo step.
    transformChanged: () => lakeHistory.commit({ coalesce: `transform:${lakeToolSlice.lake.activeIndex}` }),
    // Fires after Delete and after picking another lake; picking changes no
    // lake, so only a delete becomes a step.
    selectionChanged: () => lakeHistory.commit(),
  });

  {
    let dragging = false;
    const worldAt = () => {
      const hit = getUV();
      if (!hit) return null;
      return { wx: hit.u * WORLD_SIZE - WORLD_SIZE / 2, wz: hit.v * WORLD_SIZE - WORLD_SIZE / 2 };
    };

    renderer.domElement.addEventListener("mousedown", e => {
      if (playMode.active || editorMode !== "lake" || e.button !== 0) return;
      refreshMouse(e);
      const p = worldAt();
      if (!p) return;
      dragging = true;
      lakeSystem.beginDrag(p.wx, p.wz);
    }, { capture: true });

    renderer.domElement.addEventListener("mousemove", e => {
      if (!dragging || editorMode !== "lake") return;
      refreshMouse(e);
      const p = worldAt();
      if (p) lakeSystem.updateDrag(p.wx, p.wz);
    });

    // A release anywhere ends the drag; releasing outside the canvas must not
    // strand a half-finished rectangle.
    const finish = () => {
      if (!dragging) return;
      dragging = false;
      if (lakeSystem.endDrag()) {
        lakeHistory.commit();
        lakeUi?.refresh();
      }
    };
    renderer.domElement.addEventListener("mouseup", finish);
    window.addEventListener("mouseup", finish);
    renderer.domElement.addEventListener("mouseleave", () => {
      if (dragging) { dragging = false; lakeSystem.cancelDrag(); }
    });
  }

  if (isEditor) tunnelUi = buildTunnelPanel({ tunnelSystem, maxHeight: MAX_HEIGHT, defaults: { TUNNEL_DEFAULTS, CAVE_DEFAULTS } });

  if (isEditor) laneRoadUi = buildLaneRoadPanel({
    laneRoadSystem,
    onFrame: () => frameBounds(new THREE.Box3().setFromObject(laneRoadSystem.group)),
  });

  if (isEditor) riverV2Ui = buildRiverV2Panel({
    toolState: { riverV2: riverV2Slice.riverV2 },
    riverV2System,
    maxHeight: MAX_HEIGHT,
    waterGlobals,
    materialChanged: () => riverV2System.syncMaterial(),
    sandChanged: () => riverSandShading.syncParams(riverV2Slice.riverV2.sand),
    conformChanged: () => riverV2System.refreshConform(),
    visibilityChanged: () => riverV2System.refreshVisibility(),
  });

  applyRiverModeEffects();

  if (isEditor) buildRoadPanel({
    toolState: { road: roadState },
    roadChanged: () => {
      Object.assign(roadSystem.params, roadState);
      roadSystem.queueRebuild();
    },
    roadHandlesChanged: () => {
      Object.assign(roadSystem.params, roadState);
      roadSystem.setEditActive(editorMode === "road" && !playMode.active);
      roadSystem.queueRebuild();
    },
    roadClearAll: () => roadHistory.record(() => roadSystem.setNetwork([], [])),
    roadGradeParamsChanged: () => scheduleRoadGrade(),
    roadLiveGradeChanged: () => {
      if (roadState.liveGrade) {
        void ensureCpuHeightmapFromGpu().then(() => {
          roadConform.rebase();
          roadSystem.queueRebuild(); // re-drape on base + apply the grade
        });
      } else if (roadConform.removeGrade()) {
        pushHeightmapEditsToGpu();
        roadSystem.queueRebuild(); // re-drape on the restored terrain
      }
    },
    roadBakeGrade: () => {
      void ensureCpuHeightmapFromGpu().then(() => {
        if (roadConform.bake(roadSystem, roadState)) pushHeightmapEditsToGpu();
      });
    },
    roadRemoveGrade: () => {
      if (roadConform.removeGrade()) pushHeightmapEditsToGpu();
    },
    roadExport: () => {
      const json = JSON.stringify({ version: 1, ...roadSystem.exportData() }, null, 2);
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "roads.v3roads.json";
      a.click();
      URL.revokeObjectURL(url);
    },
    roadImport: () => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".json,.v3roads";
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return;
        try {
          const data = JSON.parse(await file.text());
          roadHistory.record(() => roadSystem.importData(data));
        } catch (err) {
          console.warn("[V3] Road import failed:", err);
        }
      };
      input.click();
    },
  });

  // Sync prop instance while gizmo is dragging.
  tc.addEventListener("change", () => {
    if (_gizmoTarget === "prop" && propInstancer.hasSelection) {
      propSys.handleTransformChange();
    }
    if (_gizmoTarget === "decal" && tc.dragging) decalEditor?.gizmoChanged();
    if (_gizmoTarget === "waterfall" && tc.dragging) waterfallEditor?.gizmoChanged();
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
    if (!hit) { deactivatePropSelection(); return; }

    // Shift+RMB on a static prop: add/remove it from the multi-selection.
    // (Live props keep single-select — their transforms go through their own managers.)
    if (e.shiftKey && hit === hitStatic && propInstancer.hasSelection) {
      propInstancer.toggleSelect(hit.instIdx);
      if (!propInstancer.hasSelection) { deactivatePropSelection(); return; }
      applyGizmoSettings();
      tc.attach(propInstancer.proxyObject);
      tc.setMode(propState.transformMode);
      tc.enabled = true;
      tc.visible = true;
      _gizmoTarget = "prop";
      _onPropSelectionChanged?.(propInstancer.selectedIdx);
      propPlacementPreview.hide();
      refreshGizmoHud();
      return;
    }
    activatePropSelection(hit.instIdx);
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

  // ── River v2 mode mouse events ────────────────────────────────────────────
  // Click places a node, alt-click inserts one into the span it landed on, and
  // the handles are the tool: node spheres move the course, green diamonds set
  // the width at that node, the gold cone lifts the water level (which pins it).
  renderer.domElement.addEventListener("mousemove", e => {
    if (playMode.active || editorMode !== "riverv2") return;
    if (!riverV2System.dragging) return;
    refreshMouse(e);
    raycaster.setFromCamera(mouse, camera);
    // Only a node drag needs the terrain; width and level drags resolve against
    // analytic planes, so the raycast is skipped for them.
    const terrainHit = riverV2System.dragKind === "node" ? getTerrainHitWorld(e) : null;
    riverV2System.dragTo({ raycaster, terrainHit, camera });
  });

  renderer.domElement.addEventListener("mousedown", e => {
    if (playMode.active || editorMode !== "riverv2" || e.button !== 0) return;
    e.preventDefault();
    refreshMouse(e);
    raycaster.setFromCamera(mouse, camera);
    const picked = riverV2System.pick(raycaster);
    if (picked) {
      riverV2System.beginDrag(picked);
      controls.enabled = false;
      riverV2Ui?.refresh();
    } else if (e.altKey) {
      const hit = getTerrainHitWorld(e);
      if (hit && riverV2System.insertNodeNear(hit)) riverV2Ui?.refresh();
    } else {
      const hit = getTerrainHitWorld(e);
      if (hit) { riverV2System.addNode(hit); riverV2Ui?.refresh(); }
    }
  }, { capture: true });

  renderer.domElement.addEventListener("mouseup", () => {
    if (editorMode !== "riverv2") return;
    if (riverV2System.endDrag()) {
      syncEditorOrbitEnabled();
      riverV2Ui?.refresh();
    }
  });

  // ── View mode: click to select (Unity / Unreal style) ─────────────────────
  // A click (not an orbit drag) picks whatever is under the cursor across every
  // tool, and hands it to its own mode with that object selected. Painted
  // trees, foliage and grass stay brush-edited.
  const _viewClick = createClickDetector();
  const _viewPickRay = new THREE.Raycaster();
  const viewPickSources = [
    {
      kind: "prop",
      pick: (rc) => {
        const a = propInstancer.raycast(rc), b = livePropManager.raycast(rc);
        return !a ? b : !b ? a : (b.distance < a.distance ? b : a);
      },
      select: (hit) => { setEditorMode("props"); activatePropSelection(hit.instIdx); },
    },
    {
      kind: "tunnel",
      pick: (rc) => raycastMeshes(rc, tunnelSystem?.tunnels.map((t) => t.mesh) ?? []),
      select: (hit) => {
        setEditorMode("tunnel");
        const t = tunnelSystem.tunnels[hit.index];
        tunnelSystem.setActiveIndex(hit.index);
        tunnelSystem.selected = { tunnelIdx: hit.index, nodeIdx: Math.max(0, nearestXZ(t.nodes, hit.point)) };
        tunnelSystem._rebuildHandles();
        tunnelUi?.refresh();
      },
    },
    {
      kind: "river",
      pick: (rc) => raycastMeshes(rc, riverV2System?.rivers.map((r) => r.mesh) ?? []),
      select: (hit) => {
        setEditorMode("riverv2");
        const r = riverV2System.rivers[hit.index];
        riverV2System.select({ riverIdx: hit.index, nodeIdx: Math.max(0, nearestXZ(r.nodes, hit.point)) });
        riverV2Ui?.refresh();
      },
    },
    {
      kind: "lake",
      pick: (rc) => raycastMeshes(rc, lakeSystem?.lakes.map((l) => l.mesh) ?? []),
      select: (hit) => { setEditorMode("lake"); lakeSystem.setActiveIndex(hit.index); lakeUi?.refresh(); },
    },
    {
      kind: "road",
      pick: (rc) => raycastMeshes(rc, roadSystem ? roadSystem.roadGroup.children.filter((m) => m.isMesh) : []),
      select: (hit) => {
        setEditorMode("road");
        const i = nearestXZ(roadSystem.nodes, hit.point);
        if (i >= 0) roadSystem.selectNode(roadSystem.nodes[i].id);
      },
    },
    {
      kind: "spawn",
      pick: (rc) => (spawnSystem.group.visible ? raycastMeshes(rc, [spawnSystem.group]) : null),
      select: () => { setEditorMode("spawn"); },
    },
    {
      // A decal is picked where it is painted: the ground under the cursor lies
      // in its box. At the ground's distance, so a prop standing on it wins.
      kind: "decal",
      pick: () => {
        const th = _viewTerrainHit;
        const d = th ? decalSystem.pick(th) : null;
        return d ? { decal: d, distance: camera.position.distanceTo(th) } : null;
      },
      select: (hit) => { setEditorMode("decals"); decalEditor?.select(hit.decal.id); },
    },
  ];
  let _viewTerrainHit = null;

  /** What a View-mode click at this event would select (null for nothing). */
  function pickInView(e) {
    refreshMouse(e);
    _viewPickRay.setFromCamera(mouse, camera);
    const th = getTerrainHitWorld(e);
    // The ground in front of an object hides it — except where the terrain has
    // a hole (a tunnel mouth), which the CPU height march cannot see.
    const terrainDist = th && splatMap.holeAt(th.x, th.z) < 0.5 ? camera.position.distanceTo(th) : Infinity;
    _viewTerrainHit = Number.isFinite(terrainDist) ? th : null;
    return pickNearest(_viewPickRay, viewPickSources, terrainDist);
  }

  // ── Decal mode mouse events ───────────────────────────────────────────────
  // Surfaces a decal can go on: the terrain, props, roads and tunnels. Hover
  // (every mouse move) skips the road/tunnel meshes, which have no BVH.
  const _decalRay = new THREE.Raycaster();
  function getDecalSurfaceHit(e, { meshes = true } = {}) {
    refreshMouse(e);
    _decalRay.setFromCamera(mouse, camera);
    let best = null;
    const consider = (point, normal, distance) => {
      if (point && (!best || distance < best.distance)) best = { point: point.clone(), normal: normal ? normal.clone() : null, distance };
    };
    const th = getTerrainHitWorld(e);
    if (th && splatMap.holeAt(th.x, th.z) < 0.5) consider(th, sampleTerrainNormal(th.x, th.z), camera.position.distanceTo(th));
    const ph = propInstancer.raycast?.(_decalRay);
    if (ph) consider(ph.point, ph.normal, ph.distance);
    if (meshes) {
      const list = [
        ...(roadSystem ? roadSystem.roadGroup.children.filter((m) => m.isMesh && m.visible) : []),
        ...(tunnelSystem?.tunnels.map((t) => t.mesh).filter(Boolean) ?? []),
      ];
      for (const m of list) {
        const h = _decalRay.intersectObject(m, true)[0];
        if (h) consider(h.point, h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld) : null, h.distance);
      }
    }
    // Double-sided hits can report the back face: turn the normal to the camera.
    if (best?.normal && best.normal.dot(_decalRay.ray.direction) > 0) best.normal.negate();
    return best;
  }

  renderer.domElement.addEventListener("mousemove", (e) => {
    if (!decalEditor || playMode.active || editorMode !== "decals") return;
    decalEditor.hover(tc.dragging ? null : getDecalSurfaceHit(e, { meshes: false }), camera, { shift: e.shiftKey });
  });
  renderer.domElement.addEventListener("mousedown", (e) => {
    if (!decalEditor || playMode.active || editorMode !== "decals" || e.button !== 0) return;
    // A press on a gizmo handle belongs to the gizmo.
    if (tc.dragging || (_gizmoTarget === "decal" && tc.axis)) return;
    const did = decalEditor.click(getDecalSurfaceHit(e), camera, { shift: e.shiftKey });
    if (did) {
      e.preventDefault();
      decalEditor.hover(null, camera);
    }
  });

  // ── Waterfall mode mouse events ───────────────────────────────────────────
  // The lip goes on the terrain or a solid prop (the same surfaces as decals).
  function getWaterfallHit(e) {
    const hit = getDecalSurfaceHit(e, { meshes: false });
    return hit;
  }
  renderer.domElement.addEventListener("mousemove", (e) => {
    if (!waterfallEditor || playMode.active || editorMode !== "waterfall") return;
    if (tc.dragging) { waterfallEditor.hover(null, camera); return; }
    const hit = getWaterfallHit(e);
    const over = waterfallSystem.raycast(_decalRay);
    waterfallEditor.hover(hit, camera, { overFall: !!over && (!hit || over.distance <= hit.distance + 0.5) });
  });
  renderer.domElement.addEventListener("mousedown", (e) => {
    if (!waterfallEditor || playMode.active || editorMode !== "waterfall" || e.button !== 0) return;
    // A press on a gizmo handle belongs to the gizmo.
    if (tc.dragging || (_gizmoTarget === "waterfall" && tc.axis)) return;
    const hit = getWaterfallHit(e);
    const did = waterfallEditor.click(hit, _decalRay, camera);
    if (did) {
      e.preventDefault();
      waterfallEditor.hover(null, camera);
    }
  });

  renderer.domElement.addEventListener("mousedown", e => {
    if (e.button === 0 && editorMode === "view" && !playMode.active) _viewClick.down(e);
  });
  renderer.domElement.addEventListener("mouseup", e => {
    if (!isEditor || e.button !== 0 || editorMode !== "view" || playMode.active || !_viewClick.up(e)) return;
    const best = pickInView(e);
    if (best) {
      best.source.select(best.hit);
      if (inspector.inspect(currentSelectionKey())) openRightTab("inspector");
    }
  });

  // ── Scene list (outliner) ─────────────────────────────────────────────────
  // Every object in the scene, grouped by tool. Click selects (same as clicking
  // it in the viewport), double-click or F frames it, the eye hides it in the
  // editor only (not saved; everything shows again in play mode).
  const _hiddenMeshes = new WeakSet();   // lakes, rivers hidden from the list
  let _roadsHidden = false;

  // Only objects hidden from the list (or hidden until a moment ago) are
  // touched, so each tool keeps control of its own visibility toggles.
  const _forcedHidden = new WeakSet();
  function _setListHidden(obj, mesh, hidden, reveal) {
    if (!mesh) return;
    const hide = hidden && !reveal;
    if (hide) { mesh.visible = false; _forcedHidden.add(obj); }
    else if (_forcedHidden.has(obj)) { mesh.visible = true; _forcedHidden.delete(obj); }
  }
  let _roadsForced = false;
  function _applyEditorHidden() {
    const reveal = playMode.active;
    for (const l of lakeSystem?.lakes ?? []) _setListHidden(l, l.mesh, _hiddenMeshes.has(l), reveal);
    for (const r of riverV2System?.rivers ?? []) _setListHidden(r, r.mesh, _hiddenMeshes.has(r), reveal);
    for (const t of tunnelSystem?.tunnels ?? []) _setListHidden(t, t.mesh, !!t.hidden, reveal);
    if (roadSystem) {
      if (_roadsHidden && !reveal) { roadSystem.roadGroup.visible = false; _roadsForced = true; }
      else if (_roadsForced) { roadSystem.roadGroup.visible = true; _roadsForced = false; }
    }
    if (propInstancer.revealHidden !== reveal) { propInstancer.revealHidden = reveal; propInstancer.visibilityChanged(); }
  }

  const _propTypeSlot = (typeIdx) => propSlots.findIndex((sl) => sl.typeIdx === typeIdx);

  function sceneModel() {
    const groups = [];
    const inspected = inspector?.key ?? null;
    // World settings, not objects: selectable for the Inspector, not counted.
    groups.push({
      key: "environment", label: "Environment", icon: "sun-moon", count: null, inTotal: false,
      items: [
        { key: "sun", label: "Sun & light", icon: "sun", selected: inspected === "sun" },
        { key: "sky", label: "Sky", icon: "cloud-sun", selected: inspected === "sky" },
        { key: "fog", label: "Fog", icon: "cloud-fog", selected: inspected === "fog" },
      ],
    });
    groups.push({ key: "terrain", label: "Terrain", icon: "mountain", count: null, inTotal: false, items: [] });

    const byType = new Map();
    for (const p of propStore.instances) {
      if (!byType.has(p.typeIdx)) byType.set(p.typeIdx, 0);
      byType.set(p.typeIdx, byType.get(p.typeIdx) + 1);
    }
    const selIds = new Set(editorMode === "props" ? propInstancer.selectedIds : []);
    groups.push({
      key: "props", label: "Props", icon: "box", count: propStore.instances.length,
      items: [...byType.entries()].sort((a, b) => a[0] - b[0]).map(([typeIdx, n]) => {
        const type = propStore.types[typeIdx];
        const live = !!type?.live;
        return {
          key: `propType:${typeIdx}`, label: type?.name ?? `Type ${typeIdx}`, sub: String(n),
          canHide: !live, hidden: propInstancer.hiddenTypes.has(typeIdx),
          children: {
            total: n,
            // With a search, every match (the list caps what it draws and
            // counts the rest); without one, the first rows only.
            items: (query = "") => {
              const out = [];
              const name = type?.name ?? "Prop";
              for (const p of propStore.instances) {
                if (p.typeIdx !== typeIdx) continue;
                const label = `${name} #${p.id}`;
                if (query && !outlinerMatches(label, query)) continue;
                out.push({
                  key: `prop:${p.id}`, label,
                  sub: `${p.px.toFixed(0)}, ${p.pz.toFixed(0)}`, selected: selIds.has(p.id),
                  canHide: !live, hidden: propInstancer.hiddenIds.has(p.id),
                });
                if (!query && out.length >= 200) break;
              }
              return out;
            },
          },
        };
      }),
    });

    const tunnels = tunnelSystem?.tunnels ?? [];
    groups.push({
      key: "tunnels", label: "Tunnels & caves", icon: "rainbow", count: tunnels.length,
      items: tunnels.map((t, i) => ({
        key: `tunnel:${i}`, label: `${t.style === "cave" ? "Cave" : "Tunnel"} ${i + 1}`,
        sub: t._sampled ? `${t._sampled.length.toFixed(0)} m` : `${t.nodes.length} node`,
        selected: editorMode === "tunnel" && tunnelSystem.activeIndex === i,
        canHide: true, hidden: !!t.hidden,
      })),
    });

    const rivers = riverV2System?.rivers ?? [];
    groups.push({
      key: "rivers", label: "Rivers", icon: "waypoints", count: rivers.length,
      items: rivers.map((r, i) => ({
        key: `river:${i}`, label: `River ${i + 1}`, sub: `${r.nodes.length} nodes`,
        selected: editorMode === "riverv2" && (riverV2Slice.riverV2.activeRiverIndex | 0) === i,
        canHide: true, hidden: _hiddenMeshes.has(r),
      })),
    });

    const lakes = lakeSystem?.lakes ?? [];
    groups.push({
      key: "lakes", label: "Lakes", icon: "waves", count: lakes.length,
      items: lakes.map((l, i) => ({
        key: `lake:${i}`, label: `Lake ${i + 1}`, sub: `${l.sizeX.toFixed(0)}×${l.sizeZ.toFixed(0)} m`,
        selected: editorMode === "lake" && (lakeToolSlice.lake.activeIndex | 0) === i,
        canHide: true, hidden: _hiddenMeshes.has(l),
      })),
    });

    const decals = decalSystem.decals;
    groups.push({
      key: "decals", label: "Decals", icon: "stamp", count: decals.length,
      items: decals.slice(0, 300).map((d) => ({
        key: `decal:${d.id}`, label: `${decalSystem.textures.slots[d.slot]?.name ?? "Decal"} #${d.id}`,
        sub: `${d.px.toFixed(0)}, ${d.pz.toFixed(0)}`,
        selected: editorMode === "decals" && decalEditor?.selectedId === d.id,
      })),
    });

    const roadNodes = roadSystem?.nodes?.length ?? 0;
    groups.push({
      key: "roads", label: "Roads", icon: "route", count: roadNodes ? 1 : 0,
      items: roadNodes ? [{
        key: "road", label: "Road network", sub: `${roadNodes} nodes`,
        selected: editorMode === "road", canHide: true, hidden: _roadsHidden,
      }] : [],
    });

    groups.push({
      key: "spawn", label: "Player start", icon: "flag", count: spawnSystem.placed ? 1 : 0,
      items: spawnSystem.placed ? [{ key: "spawnPoint", label: "Player start", selected: editorMode === "spawn" }] : [],
    });
    // Object groups appear once they hold something; Environment and Terrain
    // (count null) are world settings and always stay.
    return groups.filter((g) => g.count == null || g.count > 0);
  }

  function sceneSignature() {
    return [
      inspector?.key, editorMode, propStore.gen, propInstancer.selectedIds.join(","),
      propInstancer.hiddenTypes.size, propInstancer.hiddenIds.size,
      (tunnelSystem?.tunnels ?? []).map((t) => `${t.style}${t.nodes.length}${t.hidden ? "h" : ""}${(t._sampled?.length ?? 0) | 0}`).join(";"), tunnelSystem?.activeIndex,
      (riverV2System?.rivers ?? []).map((r) => `${r.nodes.length}${_hiddenMeshes.has(r) ? "h" : ""}`).join(";"), riverV2Slice.riverV2.activeRiverIndex,
      (lakeSystem?.lakes ?? []).map((l) => `${l.sizeX | 0}${l.sizeZ | 0}${_hiddenMeshes.has(l) ? "h" : ""}`).join(";"), lakeToolSlice.lake.activeIndex,
      roadSystem?.nodes?.length ?? 0, _roadsHidden, spawnSystem.placed,
      decalSystem.decals.map((d) => `${d.id}${d.slot}${d.px | 0}${d.pz | 0}`).join(";"), decalEditor?.selectedId,
    ].join("|");
  }

  function selectSceneObject(key) {
    const [kind, arg] = key.split(":");
    const i = Number(arg);
    switch (kind) {
      case "terrain": setEditorMode("sculpt"); break;
      case "props": setEditorMode("props"); break;
      case "propType": {
        setEditorMode("props");
        const slot = _propTypeSlot(i);
        if (slot >= 0) { propState.activeSlot = slot; uiById("props-panel")?._rebuildPropUi?.(); }
        break;
      }
      case "prop": {
        const idx = propStore.indexOfId(i);
        if (idx >= 0) { setEditorMode("props"); activatePropSelection(idx); }
        break;
      }
      case "tunnels": setEditorMode("tunnel"); break;
      case "tunnel":
        setEditorMode("tunnel");
        tunnelSystem.setActiveIndex(i);
        tunnelSystem.selected = { tunnelIdx: i, nodeIdx: 0 };
        tunnelSystem._rebuildHandles();
        tunnelUi?.refresh();
        break;
      case "rivers": setEditorMode("riverv2"); break;
      case "river":
        setEditorMode("riverv2");
        riverV2System.select({ riverIdx: i, nodeIdx: 0 });
        riverV2Ui?.refresh();
        break;
      case "lakes": setEditorMode("lake"); break;
      case "lake": setEditorMode("lake"); lakeSystem.setActiveIndex(i); lakeUi?.refresh(); break;
      case "roads": case "road": setEditorMode("road"); break;
      case "spawn": case "spawnPoint": setEditorMode("spawn"); break;
      case "decals": setEditorMode("decals"); break;
      case "decal": setEditorMode("decals"); decalEditor?.select(i); break;
      // Environment entries change no tool; they only open in the Inspector.
    }
  }

  /** Scene list click: select it, and show it in the Inspector. */
  function selectAndInspect(key) {
    selectSceneObject(key);
    // Selecting a prop that is part of a group keeps the group.
    const k = key.startsWith("prop:") && propInstancer.selectionCount > 1 ? "propSelection" : key;
    inspector.inspect(k);
    openRightTab("inspector");
  }

  /** The Scene-list key of what the current tool has selected, or null. */
  function currentSelectionKey() {
    switch (editorMode) {
      case "props":
        if (propInstancer.selectionCount > 1) return "propSelection";
        return propInstancer.hasSelection ? `prop:${propInstancer.selectedId}` : null;
      case "tunnel": return tunnelSystem?.activeTunnel ? `tunnel:${tunnelSystem.activeIndex}` : null;
      case "riverv2": return riverV2System?.rivers.length ? `river:${riverV2Slice.riverV2.activeRiverIndex | 0}` : null;
      case "lake": return lakeSystem?.lakes.length ? `lake:${lakeToolSlice.lake.activeIndex | 0}` : null;
      case "road": return roadSystem?.nodes.length ? "road" : null;
      case "spawn": return spawnSystem.placed ? "spawnPoint" : null;
      case "decals": return decalEditor?.selectedId != null ? `decal:${decalEditor.selectedId}` : null;
      default: return null;
    }
  }

  const _frameBox = new THREE.Box3();
  const _frameTmp = new THREE.Box3();
  /** World bounds of a scene-list key, or null. */
  function sceneObjectBounds(key) {
    const [kind, arg] = key.split(":");
    const i = Number(arg);
    const box = _frameBox.makeEmpty();
    const propBox = (p) => {
      const type = propStore.types[p.typeIdx];
      if (!type?.mergedBox) return;
      _frameTmp.copy(type.mergedBox).applyMatrix4(propStore.computeInstanceMatrix(p));
      box.union(_frameTmp);
    };
    switch (kind) {
      case "prop": { const idx = propStore.indexOfId(i); if (idx >= 0) propBox(propStore.instances[idx]); break; }
      case "propType": for (const p of propStore.instances) if (p.typeIdx === i) propBox(p); break;
      case "props": for (const p of propStore.instances) propBox(p); break;
      case "tunnel": { const m = tunnelSystem.tunnels[i]?.mesh; if (m) box.setFromObject(m); break; }
      case "river": { const m = riverV2System.rivers[i]?.mesh; if (m) box.setFromObject(m); break; }
      case "lake": { const m = lakeSystem.lakes[i]?.mesh; if (m) box.setFromObject(m); break; }
      case "road": case "roads": if (roadSystem) box.setFromObject(roadSystem.roadGroup); break;
      case "spawn": case "spawnPoint": if (spawnSystem.placed) box.setFromObject(spawnSystem.group); break;
      case "decal": case "decals":
        for (const d of decalSystem.decals) {
          if (kind === "decal" && d.id !== i) continue;
          box.union(_frameTmp.set(new THREE.Vector3(-0.5, -0.5, -0.5), new THREE.Vector3(0.5, 0.5, 0.5)).applyMatrix4(decalSystem.matrixOf(d)));
        }
        break;
      case "terrain": box.set(new THREE.Vector3(-WORLD_SIZE / 2, 0, -WORLD_SIZE / 2), new THREE.Vector3(WORLD_SIZE / 2, MAX_HEIGHT * 0.3, WORLD_SIZE / 2)); break;
    }
    return box.isEmpty() ? null : box;
  }

  /** Move the orbit camera to look at a box from the current viewing direction. */
  function frameBounds(box) {
    if (!box || playMode.active) return false;
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(2, box.getSize(new THREE.Vector3()).length() * 0.5);
    const dir = new THREE.Vector3().subVectors(camera.position, controls.target);
    if (dir.lengthSq() < 1e-6) dir.set(0, 0.6, 1);
    dir.normalize();
    const dist = radius / Math.sin(THREE.MathUtils.degToRad(camera.fov) * 0.5) * 1.15;
    controls.target.copy(center);
    camera.position.copy(center).addScaledVector(dir, dist);
    controls.update();
    return true;
  }

  /** Shift+F: frame whatever the current mode has selected. */
  function frameSelection() {
    let key = null;
    if (editorMode === "props" && propInstancer.hasSelection) {
      const box = new THREE.Box3();
      for (const id of propInstancer.selectedIds) {
        const b = sceneObjectBounds(`prop:${id}`);
        if (b) box.union(b);
      }
      return frameBounds(box.isEmpty() ? null : box);
    }
    if (editorMode === "tunnel" && tunnelSystem?.activeTunnel) key = `tunnel:${tunnelSystem.activeIndex}`;
    else if (editorMode === "riverv2" && riverV2System?.rivers.length) key = `river:${riverV2Slice.riverV2.activeRiverIndex | 0}`;
    else if (editorMode === "lake" && lakeSystem?.lakes.length) key = `lake:${lakeToolSlice.lake.activeIndex | 0}`;
    else if (editorMode === "road") key = "road";
    else if (editorMode === "spawn") key = "spawnPoint";
    else if (editorMode === "decals" && decalEditor?.selectedId != null) key = `decal:${decalEditor.selectedId}`;
    return key ? frameBounds(sceneObjectBounds(key)) : false;
  }

  function toggleSceneHidden(key) {
    const [kind, arg] = key.split(":");
    const i = Number(arg);
    switch (kind) {
      case "propType":
        if (propInstancer.hiddenTypes.has(i)) propInstancer.hiddenTypes.delete(i); else propInstancer.hiddenTypes.add(i);
        propInstancer.visibilityChanged();
        break;
      case "prop":
        if (propInstancer.hiddenIds.has(i)) propInstancer.hiddenIds.delete(i); else propInstancer.hiddenIds.add(i);
        propInstancer.visibilityChanged();
        break;
      case "tunnel": { const t = tunnelSystem.tunnels[i]; if (t) t.hidden = !t.hidden; break; }
      case "river": { const r = riverV2System.rivers[i]; if (r) (_hiddenMeshes.has(r) ? _hiddenMeshes.delete(r) : _hiddenMeshes.add(r)); break; }
      case "lake": { const l = lakeSystem.lakes[i]; if (l) (_hiddenMeshes.has(l) ? _hiddenMeshes.delete(l) : _hiddenMeshes.add(l)); break; }
      case "road": _roadsHidden = !_roadsHidden; break;
    }
    _applyEditorHidden();
  }

  if (isEditor) sceneOutliner = createSceneOutliner({
    container: uiById("hierarchy"),
    getModel: sceneModel,
    signature: sceneSignature,
    onSelect: selectAndInspect,
    onFrame: (key) => { selectAndInspect(key); frameBounds(sceneObjectBounds(key)); },
    onToggleHidden: toggleSceneHidden,
    getMenu: sceneRowMenu,
  });

  /**
   * Right-click menu of a Scene-list row. Deletes go through the same calls as
   * the tools (and their undo); a delete that would be large asks first.
   */
  function sceneRowMenu(key) {
    const [kind, arg] = key.split(":");
    const i = Number(arg);
    const inspect = { label: "Inspect", onClick: () => selectAndInspect(key) };
    const focus = sceneObjectBounds(key) ? { label: "Focus", onClick: () => { selectAndInspect(key); frameBounds(sceneObjectBounds(key)); } } : null;
    const hideable = ["propType", "prop", "tunnel", "river", "lake", "road"].includes(kind);
    const isHidden = () => {
      switch (kind) {
        case "propType": return propInstancer.hiddenTypes.has(i);
        case "prop": return propInstancer.hiddenIds.has(i);
        case "tunnel": return !!tunnelSystem.tunnels[i]?.hidden;
        case "river": return _hiddenMeshes.has(riverV2System.rivers[i]);
        case "lake": return _hiddenMeshes.has(lakeSystem.lakes[i]);
        case "road": return _roadsHidden;
        default: return false;
      }
    };
    const hide = hideable ? { label: isHidden() ? "Show in editor" : "Hide in editor", onClick: () => toggleSceneHidden(key) } : null;
    const sep = { separator: true };
    const del = (label, fn) => ({ label, danger: true, onClick: fn });
    const afterDelete = () => { if (inspector.key === key) inspector.inspect(null); };

    switch (kind) {
      case "prop":
        return [inspect, focus, hide, sep, del("Delete", () => {
          const idx = propStore.indexOfId(i);
          if (idx < 0) return;
          setEditorMode("props");
          activatePropSelection(idx);
          propSys.handleDelete();
          deactivatePropSelection();
          refreshPropCount();
          afterDelete();
        })];
      case "propType": {
        const n = propStore.instances.reduce((c, p) => c + (p.typeIdx === i ? 1 : 0), 0);
        return [inspect, focus, hide, sep, del(`Delete all ${n}`, () => {
          if (n > 1 && !window.confirm(`Delete all ${n} “${propStore.types[i]?.name ?? "props"}”? (Undo brings them back.)`)) return;
          setEditorMode("props");
          propInstancer.setSelection(propStore.instances.map((p, idx) => (p.typeIdx === i ? idx : -1)).filter((idx) => idx >= 0));
          propSys.handleDelete();
          deactivatePropSelection();
          refreshPropCount();
          afterDelete();
        })];
      }
      case "lake":
        return [inspect, focus, hide, sep, del("Delete", () => {
          setEditorMode("lake");
          lakeSystem.setActiveIndex(i);
          lakeSystem.deleteActive();
          lakeHistory.commit();
          lakeUi?.refresh();
          afterDelete();
        })];
      case "tunnel":
        return [inspect, focus, hide, sep, del("Delete", () => {
          setEditorMode("tunnel");
          tunnelSystem.setActiveIndex(i);
          tunnelSystem.deleteActiveTunnel();
          tunnelUi?.refresh();
          afterDelete();
        })];
      case "river":
        return [inspect, focus, hide, sep, del("Delete", () => {
          setEditorMode("riverv2");
          riverV2System.select({ riverIdx: i, nodeIdx: 0 });
          riverV2System.deleteActiveRiver();
          riverV2Ui?.refresh();
          afterDelete();
        })];
      case "road":
        return [inspect, focus, hide, { label: "Edit in Road tool", onClick: () => { setEditorMode("road"); openRightTab("tools"); } }];
      case "spawnPoint":
        return [inspect, focus, sep, del("Clear", () => { spawnSystem.clear(); spawnUi?.refresh(); afterDelete(); })];
      case "decal":
        return [inspect, focus, sep, del("Delete", () => { decalEditor?.deleteId(i); afterDelete(); })];
      case "sun": case "sky": case "fog": case "terrain":
        return [inspect, { label: "Open World tab", onClick: () => openRightTab("world") }].slice(0, kind === "terrain" ? 1 : 2);
      default:
        return [inspect, focus];
    }
  }
  // The Inspector follows selections made inside a tool too (right-click a
  // prop, Shift+right-click a group, a new tunnel becoming active): when what
  // the tool has selected changes, it shows the new selection. A selection
  // going away clears it only if that was what it showed, so a Sun opened from
  // the Scene list stays put.
  // Switching tools is not a selection, so a mode change only re-baselines.
  let _toolSelectionKey = null;
  let _toolSelectionMode = null;
  function _followToolSelection() {
    const k = currentSelectionKey();
    if (editorMode !== _toolSelectionMode) {
      _toolSelectionMode = editorMode;
      _toolSelectionKey = k;
      return;
    }
    if (k === _toolSelectionKey) return;
    const shown = inspector.key;
    if (k) inspector.inspect(k);
    else if (shown && shown === _toolSelectionKey) inspector.inspect(null);
    _toolSelectionKey = k;
  }
  _sceneListFrame = () => {
    _applyEditorHidden();
    if (!playMode.active) _followToolSelection();
    sceneOutliner.update();
    inspector.refresh(performance.now());
  };

  // ── Inspector (right panel tab) ─────────────────────────────────────────────
  if (isEditor) inspector = createInspector({
    container: uiById("tab-inspector"),
    deps: {
      world: { worldSize: WORLD_SIZE, heightmapSize: HEIGHTMAP_SIZE, splatSize: SPLAT_RES, maxHeight: MAX_HEIGHT, lodLevels: LOD_LEVELS },
      env: {
        light: worldToolState.light,
        proceduralSky: worldToolState.proceduralSky,
        fog: worldToolState.fog,
        skyMode: () => worldToolState.skyMode,
        setTimeOfDay: (t) => worldEnv?.setTimeOfDay(t),
        syncFog: () => { worldEnv?.syncFog(); worldEnv?.driveFogSun(); },
      },
      props: {
        store: propStore,
        instancer: propInstancer,
        propSys,
        select: (idx) => { setEditorMode("props"); activatePropSelection(idx); },
        duplicate: () => {
          const idx = propSys.handleDuplicate();
          if (idx != null) activatePropSelection(idx);
          refreshPropCount();
        },
        remove: () => { propSys.handleDelete(); deactivatePropSelection(); refreshPropCount(); },
        changed: () => {},
      },
      lakes: { system: lakeSystem, history: lakeHistory, slice: lakeToolSlice.lake, get ui() { return lakeUi; } },
      decals: { system: decalSystem, editor: decalEditor },
      tunnels: { system: tunnelSystem, get ui() { return tunnelUi; } },
      rivers: { system: riverV2System },
      road: { get system() { return roadSystem; } },
      spawn: {
        system: spawnSystem,
        get ui() { return spawnUi; },
        placeAtCamera: () => {
          const t = controls.target;
          spawnSystem.setPosition(t.x, t.z, Math.atan2(camera.position.x - t.x, camera.position.z - t.z));
        },
      },
      groups: {
        props: { label: "Props", mode: "props", count: () => propStore.instances.length },
        tunnels: { label: "Tunnels & caves", mode: "tunnel", count: () => tunnelSystem?.tunnels.length ?? 0 },
        rivers: { label: "Rivers", mode: "riverv2", count: () => riverV2System?.rivers.length ?? 0 },
        lakes: { label: "Lakes", mode: "lake", count: () => lakeSystem?.lakes.length ?? 0 },
        decals: { label: "Decals", mode: "decals", count: () => decalSystem.decals.length },
        roads: { label: "Roads", mode: "road", count: () => (roadSystem?.nodes.length ? 1 : 0) },
        spawn: { label: "Player start", mode: "spawn", count: () => (spawnSystem.placed ? 1 : 0) },
        environment: { label: "Environment", mode: null, count: () => 3 },
      },
      frame: (key) => frameBounds(sceneObjectBounds(key)),
      frameSelection: () => frameSelection(),
      openTool: (mode) => { setEditorMode(mode); openRightTab("tools"); },
      openTab: (name) => openRightTab(name),
      onChange: () => sceneOutliner?.update(true),
    },
  });

  // ── Tunnel mode mouse events ──────────────────────────────────────────────
  // Click drops a node, Alt+click inserts one into the nearest span, dragging a
  // node moves it over the ground.
  renderer.domElement.addEventListener("mousemove", e => {
    if (playMode.active || editorMode !== "tunnel" || !tunnelSystem?.dragging) return;
    const terrainHit = getTerrainHitWorld(e);
    tunnelSystem.dragTo({ terrainHit });
  });

  renderer.domElement.addEventListener("mousedown", e => {
    if (playMode.active || editorMode !== "tunnel" || e.button !== 0 || !tunnelSystem) return;
    e.preventDefault();
    refreshMouse(e);
    raycaster.setFromCamera(mouse, camera);
    const picked = tunnelSystem.pick(raycaster);
    if (picked) {
      tunnelSystem.beginDrag(picked);
      controls.enabled = false;
      tunnelUi?.refresh();
    } else if (e.altKey) {
      const hit = getTerrainHitWorld(e);
      if (hit && tunnelSystem.insertNodeNear(hit)) tunnelUi?.refresh();
    } else {
      const hit = getTerrainHitWorld(e);
      if (hit) { tunnelSystem.addNode(hit); tunnelUi?.refresh(); }
    }
  }, { capture: true });

  renderer.domElement.addEventListener("mouseup", () => {
    if (editorMode !== "tunnel" || !tunnelSystem) return;
    if (tunnelSystem.endDrag()) {
      syncEditorOrbitEnabled();
      tunnelUi?.refresh();
    }
  });

  // ── Spawn (player start) mode mouse events ────────────────────────────────
  // Click places the spawn; holding and dragging away aims its facing.
  let _spawnDragging = false;

  renderer.domElement.addEventListener("mousedown", e => {
    if (playMode.active || editorMode !== "spawn" || e.button !== 0) return;
    const hit = getTerrainHitWorld(e);
    if (!hit) return;
    e.preventDefault();
    spawnSystem.setPosition(hit.x, hit.z);
    _spawnDragging = true;
    controls.enabled = false;
    spawnUi?.refresh();
  }, { capture: true });

  renderer.domElement.addEventListener("mousemove", e => {
    if (playMode.active || editorMode !== "spawn" || !_spawnDragging) return;
    const hit = getTerrainHitWorld(e);
    if (!hit) return;
    spawnSystem.aimAt(hit.x, hit.z);
    spawnUi?.refresh();
  });

  const _endSpawnDrag = () => {
    if (!_spawnDragging) return;
    _spawnDragging = false;
    syncEditorOrbitEnabled();
    spawnUi?.refresh();
  };
  renderer.domElement.addEventListener("mouseup", _endSpawnDrag);
  window.addEventListener("mouseup", _endSpawnDrag);

  // ── Smart Road mode mouse events (v2 Smart Road 2 wiring) ──────────────────
  renderer.domElement.addEventListener("mousemove", e => {
    if (playMode.active || editorMode !== "road") return;
    if (_roadDrag.nodeId === null && !_roadDrag.edge) return;
    const hit = getTerrainHitWorld(e);
    if (!hit) return;
    if (_roadDrag.nodeId !== null) {
      roadSystem.moveNode(_roadDrag.nodeId, hit.x, hit.z);
    } else if (_roadDrag.edge) {
      // Signed lateral offset from the chord midpoint = the edge's bend.
      const f = roadSystem.edgeMidFrame(_roadDrag.edge);
      if (f) {
        let bend = (hit.x - f.mx) * f.px + (hit.z - f.mz) * f.pz;
        const cap = f.chord * 0.45;
        bend = Math.max(-cap, Math.min(cap, bend));
        if (Math.abs(bend) < 1.5) bend = 0; // snap straight near the chord
        roadSystem.setEdgeBend(_roadDrag.edge, bend);
      }
    }
  });

  renderer.domElement.addEventListener("mousedown", e => {
    if (playMode.active || editorMode !== "road" || e.button !== 0) return;
    refreshMouse(e);
    raycaster.setFromCamera(mouse, camera);
    const hit = roadSystem.pickHandle(raycaster);
    const connectKey = e.ctrlKey || e.metaKey || e.shiftKey;
    if (hit?.nodeId !== undefined) {
      e.preventDefault();
      const sel = roadSystem.selectedNodeId;
      if (connectKey && sel !== null && sel !== hit.nodeId) {
        roadHistory.record(() => roadSystem.toggleEdge(sel, hit.nodeId));
        roadSystem.selectNode(hit.nodeId); // chain A→B→C
      } else {
        roadSystem.selectNode(hit.nodeId);
        _roadDrag.nodeId = hit.nodeId;
        roadSystem.setDragging(true);
        controls.enabled = false;
      }
      return;
    }
    if (hit?.edge) {
      e.preventDefault();
      _roadDrag.edge = hit.edge;
      roadSystem.selectEdge(hit.edge); // B toggles bridge on it
      roadSystem.setDragging(true);
      controls.enabled = false;
      return;
    }
    if (e.shiftKey) {
      const th = getTerrainHitWorld(e);
      if (th) {
        e.preventDefault();
        roadHistory.record(() => roadSystem.addNode(th.x, th.z, true));
      }
      return;
    }
    // Plain ground click falls through → camera orbit; selection persists.
  }, { capture: true });

  window.addEventListener("mouseup", () => {
    if (_roadDrag.nodeId === null && !_roadDrag.edge) return;
    _roadDrag.nodeId = null;
    _roadDrag.edge = null;
    roadSystem.setDragging(false); // commit full geometry → live grade fires
    roadHistory.commit(); // the whole drag is one undo step (none if nothing moved)
    syncEditorOrbitEnabled();
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
  }, { capture: true });

  renderer.domElement.addEventListener("mouseup", e => {
    if (e.button !== 0 || editorMode !== "paint") return;
    isPainting = false;
    paintSys.endStroke();
  });

  // Safety nets: a release outside the canvas or leaving the viewport must
  // still close the stroke, or its undo entry merges into the next one.
  window.addEventListener("mouseup", () => { paintSys.endStroke(); });
  renderer.domElement.addEventListener("mouseleave", () => {
    if (editorMode === "paint") { isPainting = false; paintSys.endStroke(); }
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

  // ── Snow mode mouse events ─────────────────────────────────────────────────
  renderer.domElement.addEventListener("mousemove", e => {
    if (playMode.active || editorMode !== "snow") return;
    refreshMouse(e);
    const hit = getUV();
    uCursorUV.value.set(hit ? hit.u : -2, hit ? hit.v : -2);
    if (hit && _isSnowPainting) {
      const wx = hit.u * WORLD_SIZE - WORLD_SIZE / 2;
      const wz = hit.v * WORLD_SIZE - WORLD_SIZE / 2;
      snowMap.paintAt({ cx: wx, cz: wz, radius: snowBrushState.radius,
        strength: snowBrushState.strength, falloff: snowBrushState.falloff,
        erase: e.altKey });
    }
  });

  renderer.domElement.addEventListener("mousedown", e => {
    if (playMode.active || editorMode !== "snow") return;
    if (e.button !== 0) return;
    refreshMouse(e);
    const hit = getUV();
    if (!hit) return;
    // Snapshot for undo before first mark
    _snowUndoStack.push(snowMap.snapshot());
    if (_snowUndoStack.length > 32) _snowUndoStack.shift();
    _snowRedoStack.length = 0;
    _isSnowPainting = true;
    const wx = hit.u * WORLD_SIZE - WORLD_SIZE / 2;
    const wz = hit.v * WORLD_SIZE - WORLD_SIZE / 2;
    snowMap.paintAt({ cx: wx, cz: wz, radius: snowBrushState.radius,
      strength: snowBrushState.strength, falloff: snowBrushState.falloff,
      erase: e.altKey });
  }, { capture: true });

  renderer.domElement.addEventListener("mouseup", e => {
    if (e.button !== 0) return;
    _isSnowPainting = false;
  });

  // Scroll wheel in snow mode: Shift = radius, Alt = strength
  renderer.domElement.addEventListener("wheel", e => {
    if (playMode.active || editorMode !== "snow") return;
    if (!e.shiftKey && !e.altKey) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const factor = e.deltaY > 0 ? 0.9 : 1.11;
    if (e.shiftKey) {
      snowBrushState.radius = Math.max(5, Math.min(400, snowBrushState.radius * factor));
      const slR = uiById("snow-sl-radius");
      const lbR = uiById("snow-lbl-radius");
      if (slR) slR.value = Math.round(snowBrushState.radius);
      if (lbR) lbR.textContent = Math.round(snowBrushState.radius) + "m";
      sculpt.uRadius.value = snowBrushState.radius / WORLD_SIZE;
    } else {
      snowBrushState.strength = Math.max(0.01, Math.min(1.0, snowBrushState.strength * factor));
      const slS = uiById("snow-sl-strength");
      const lbS = uiById("snow-lbl-strength");
      if (slS) slS.value = Math.round(snowBrushState.strength * 100);
      if (lbS) lbS.textContent = snowBrushState.strength.toFixed(2);
    }
  }, { passive: false, capture: true });

  // ── Cliff paint mode mouse events ─────────────────────────────────────────
  // World-XZ projected mask (terrain hit under the cursor), Alt = erase.
  const _cliffPaintHit = new THREE.Vector3();

  renderer.domElement.addEventListener("mousemove", e => {
    if (playMode.active || editorMode !== "cliffPaint") return;
    refreshMouse(e);
    const hit = getUV();
    uCursorUV.value.set(hit ? hit.u : -2, hit ? hit.v : -2);
    if (hit && _isCliffPainting) {
      _cliffPaintHit.set(hit.u * WORLD_SIZE - WORLD_SIZE / 2, 0, hit.v * WORLD_SIZE - WORLD_SIZE / 2);
      cliffPaintSystem.applyAt(_cliffPaintHit, e);
    }
  });

  renderer.domElement.addEventListener("mousedown", e => {
    if (playMode.active || editorMode !== "cliffPaint") return;
    if (e.button !== 0) return;
    refreshMouse(e);
    const hit = getUV();
    if (!hit) return;
    _isCliffPainting = true;
    _cliffPaintHit.set(hit.u * WORLD_SIZE - WORLD_SIZE / 2, 0, hit.v * WORLD_SIZE - WORLD_SIZE / 2);
    cliffPaintSystem.beginStroke(_cliffPaintHit, e);
  }, { capture: true });

  renderer.domElement.addEventListener("mouseup", e => {
    if (e.button !== 0) return;
    if (_isCliffPainting) {
      _isCliffPainting = false;
      cliffPaintSystem.endStroke();
    }
  });

  // Scroll wheel in cliff paint mode: Shift = radius, Alt = strength
  renderer.domElement.addEventListener("wheel", e => {
    if (playMode.active || editorMode !== "cliffPaint") return;
    if (!e.shiftKey && !e.altKey) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const factor = e.deltaY > 0 ? 0.9 : 1.11;
    if (e.shiftKey) {
      cliffPaintBrush.radius = Math.max(2, Math.min(200, cliffPaintBrush.radius * factor));
      const slR = uiById("cliffpaint-sl-radius");
      const lbR = uiById("cliffpaint-lbl-radius");
      if (slR) slR.value = Math.round(cliffPaintBrush.radius);
      if (lbR) lbR.textContent = Math.round(cliffPaintBrush.radius) + "m";
      sculpt.uRadius.value = cliffPaintBrush.radius / WORLD_SIZE;
    } else {
      cliffPaintBrush.strength = Math.max(0.01, Math.min(1.0, cliffPaintBrush.strength * factor));
      const slS = uiById("cliffpaint-sl-strength");
      const lbS = uiById("cliffpaint-lbl-strength");
      if (slS) slS.value = Math.round(cliffPaintBrush.strength * 100);
      if (lbS) lbS.textContent = cliffPaintBrush.strength.toFixed(2);
    }
  }, { passive: false, capture: true });

  // ── Grass mode mouse events ────────────────────────────────────────────────
  let _grassUndoStack = [];
  let _grassRedoStack = [];
  let _grassPainting  = false;

  // Undo entries are tagged with the layer they snapshot ("terrain", "cliff",
  // "height") so all grass paint shares one stack without corrupting each other.
  function _pushGrassUndo(layer = grassBrush.target) {
    _grassUndoStack.push({ layer, data: _snapGrass(layer) });
    if (_grassUndoStack.length > 32) _grassUndoStack.shift();
    _grassRedoStack = [];
  }

  // Resolve the paint position. Terrain paint hits the heightmap surface; cliff
  // paint raycasts the actual cliff mesh so clicking a cliff top paints the top
  // (not the terrain hidden behind it). Returns { wx, wz } or null.
  function _grassPaintXZ(e) {
    if (grassBrush.target === "cliff") {
      refreshMouse(e);
      raycaster.setFromCamera(mouse, camera);
      const o = raycaster.ray.origin, d = raycaster.ray.direction;
      const hit = solidCollider.raycast3D(o.x, o.y, o.z, d.x, d.y, d.z, Infinity);
      if (!hit) { uCursorUV.value.set(-2, -2); return null; }
      uCursorUV.value.set(
        (hit.point.x + WORLD_SIZE / 2) / WORLD_SIZE,
        (hit.point.z + WORLD_SIZE / 2) / WORLD_SIZE,
      );
      return { wx: hit.point.x, wz: hit.point.z };
    }
    refreshMouse(e);
    const hit = getUV();
    uCursorUV.value.set(hit ? hit.u : -2, hit ? hit.v : -2);
    if (!hit) return null;
    return { wx: hit.u * WORLD_SIZE - WORLD_SIZE / 2, wz: hit.v * WORLD_SIZE - WORLD_SIZE / 2 };
  }

  function _stampGrass(wx, wz) {
    const opts = {
      cx: wx, cz: wz,
      radius:   grassBrush.radius,
      strength: grassBrush.strength,
      falloff:  grassBrush.falloff,
      worldSize: WORLD_SIZE,
      erase:    grassBrush.erase,
    };
    if (grassBrush.target === "cliff")       grassTerrainData.stampCliffDensity(opts);
    else if (grassBrush.target === "height") grassTerrainData.stampBladeHeight({ ...opts, target: grassBrush.heightTarget });
    else                                     grassTerrainData.stampDensity(opts);
  }

  renderer.domElement.addEventListener("mousemove", e => {
    if (playMode.active || editorMode !== "grass") return;
    const pt = _grassPaintXZ(e);
    if (pt && _grassPainting) _stampGrass(pt.wx, pt.wz);
  });

  renderer.domElement.addEventListener("mousedown", e => {
    if (playMode.active || editorMode !== "grass") return;
    if (e.button !== 0) return;
    // Cliff paint needs a current cliff-top surface to sit the blades on.
    if (grassBrush.target === "cliff") ensureFreshCliffSurface();
    const pt = _grassPaintXZ(e);
    if (!pt) return;
    _pushGrassUndo();
    _grassPainting = true;
    _stampGrass(pt.wx, pt.wz);
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

  // ── Susuki mode: panel + paint events ──────────────────────────────────────
  if (isEditor) susukiUi = buildFoliagePanel(susukiPanel, {
    foliageBrush: susukiBrush,
    foliageState: susukiState,
    getLayerNames: () => textureLib.slots.map((s) => s.name),
    getHasRivers: () => (riverV2System?.rivers.length ?? 0) > 0,
    onStateChanged: () => { syncSusukiUniforms(); queueSusukiThumb(susukiBrush.type); },
    onGeometryChanged: (i) => { susukiSystem?.rebuildType(i, susukiState.types[i]); queueSusukiThumb(i); },
    onRenamed: () => vegUi?.refreshCards(),
    fieldTitle: "Tall Plant Field",
    tileReach: SUSUKI_FIELD.tileSize / 2,
    showSpecies: true,   // three slots now: pick the species per slot
  });

  let _susukiPainting  = false;

  // ── Vegetation: one undo history, erase-everything, the header ─────────────
  function _vegSnapshot(kinds) {
    const e = {};
    for (const k of kinds) {
      if (k === "susuki") e.susuki = grassTerrainData.getSusukiDensitySnapshot();
      else if (k === "flowers") e.flowers = flowerDensity.getSnapshot();
      else if (k === "foliage") e.foliage = foliageDensity.getSnapshot();
      else if (k === "vegPlaced") e.vegPlaced = _plantInstancesSnapshot();
    }
    return e;
  }
  function _vegRestore(e) {
    if (e.susuki) grassTerrainData.restoreSusukiDensitySnapshot(e.susuki);
    if (e.flowers) flowerDensity.restoreSnapshot(e.flowers);
    if (e.foliage) { foliageDensity.restoreSnapshot(e.foliage); _foliageUsedDirty = true; }
    if (e.vegPlaced) _restorePlantInstances(e.vegPlaced);
  }
  function _pushVegUndo(kinds) {
    _vegUndoStack.push(_vegSnapshot(kinds));
    if (_vegUndoStack.length > VEG_UNDO_LIMIT) _vegUndoStack.shift();
    _vegRedoStack.length = 0;
  }
  const _vegHasData = (k) =>
    k === "susuki" ? grassTerrainData.hasSusukiData
      : k === "flowers" ? flowerDensity.hasData
        : k === "vegPlaced" ? _plantInstanceCount() > 0
          : foliageDensity.hasData;
  /** Is this stamp an erase of EVERY plant under the brush (not just the selected one)? */
  const _vegEraseAll = (altErase) => (vegBrush.erase || altErase) && !vegBrush.eraseOnlyType;
  /** Systems a stroke about to start in `kind` can change — what its undo step must hold. */
  const _vegStrokeKinds = (kind, altErase) =>
    _vegEraseAll(altErase) ? VEG_MODES.filter((k) => k === kind || _vegHasData(k)) : [kind];
  function _eraseAllVeg(wx, wz) {
    const o = {
      cx: wx, cz: wz, radius: vegBrush.radius, strength: vegBrush.strength, falloff: vegBrush.falloff,
      worldSize: WORLD_SIZE, erase: true,
    };
    if (foliageDensity.hasData) foliageDensity.stamp({ ...o, channel: 0, onlyChannel: false });
    if (flowerDensity.hasData) flowerDensity.stamp({ ...o, channel: 0, onlyChannel: false });
    if (grassTerrainData.hasSusukiData) grassTerrainData.stampSusukiDensity(o);
    _removePlants(wx, wz, vegBrush.radius, _plantTypeTest());
  }

  // ── Placed plants: imported GLBs painted as prop instances ─────────────────
  /** Which prop types are placed plants (read fresh: slots come and go). */
  function _plantTypeTest() {
    const set = new Set();
    for (const s of propSlots) if (s?.plant && s.typeIdx != null) set.add(s.typeIdx);
    return (t) => set.has(t);
  }
  function _plantInstanceCount(typeIdx = null) {
    const isPlant = _plantTypeTest();
    let n = 0;
    for (const p of propStore.instances) if (typeIdx == null ? isPlant(p.typeIdx) : p.typeIdx === typeIdx) n++;
    return n;
  }
  /** Undo holds only the placed PLANTS, so undoing a stroke never touches rocks or buildings. */
  function _plantInstancesSnapshot() {
    const isPlant = _plantTypeTest();
    return propStore.instances.filter((p) => isPlant(p.typeIdx)).map((p) => ({ ...p }));
  }
  function _restorePlantInstances(list) {
    const isPlant = _plantTypeTest();
    propStore.instances = propStore.instances.filter((p) => !isPlant(p.typeIdx)).concat(list.map((p) => ({ ...p })));
    propStore._bump();
    propSys.bvh?.invalidate();
    refreshPropCount();
    placedUi?.rebuild();
  }
  function _removePlants(wx, wz, radius, matches) {
    const n = removePlantsInRadius(propStore.instances, wx, wz, radius, matches);
    if (n) propStore._bump();
    return n;
  }

  let _placedPainting = false;
  let _placedLast = null;
  let _placedGrid = null;
  function _placedStamp(hit, altErase) {
    const r = vegBrush.radius;
    if (_placedLast && Math.hypot(hit.x - _placedLast.x, hit.z - _placedLast.z) < r * 0.25) return;
    _placedLast = { x: hit.x, z: hit.z };
    if (_vegEraseAll(altErase)) { _eraseAllVeg(hit.x, hit.z); return; }
    const slot = propSlots[_vegPlacedSlot];
    if (!slot?.plant) return;
    if (vegBrush.erase || altErase) { _removePlants(hit.x, hit.z, r, (t) => t === slot.typeIdx); return; }
    const type = propStore.types[slot.typeIdx];
    if (!type) return;
    const recs = planPlacedPlants({
      wx: hit.x, wz: hit.z, radius: r, strength: vegBrush.strength,
      settings: slot.plant, typeIdx: slot.typeIdx,
      typeHeight: Math.max(0.01, type.mergedBox.max.y - type.mergedBox.min.y),
      getHeight: (x, z) => propSys.getWorldHeight(x, z),
      grid: _placedGrid, worldSize: WORLD_SIZE,
    });
    if (recs.length) { propStore.instances.push(...recs); propStore._bump(); }
  }

  renderer.domElement.addEventListener("mousemove", e => {
    if (playMode.active || editorMode !== "vegPlaced") return;
    _foliagePaintXZ(e);   // the brush ring
    sculpt.uRadius.value = vegBrush.radius / WORLD_SIZE;
    if (!_placedPainting) return;
    const hit = getTerrainHitWorld(e);
    if (hit) _placedStamp(hit, e.altKey);
  });
  renderer.domElement.addEventListener("mousedown", e => {
    if (playMode.active || editorMode !== "vegPlaced" || e.button !== 0) return;
    const hit = getTerrainHitWorld(e);
    if (!hit) return;
    e.preventDefault();
    _pushVegUndo(_vegStrokeKinds("vegPlaced", e.altKey));
    // Everything already standing counts for spacing — rocks and buildings too.
    const slot = propSlots[_vegPlacedSlot];
    _placedGrid = new SpacingGrid(Math.max(1, slot?.plant?.minSpacing ?? 2));
    for (const p of propStore.instances) _placedGrid.add(p.px, p.pz);
    _placedPainting = true;
    _placedLast = null;
    _placedStamp(hit, e.altKey);
  }, { capture: true });
  renderer.domElement.addEventListener("mouseup", e => {
    if (e.button !== 0 || !_placedPainting) return;
    _placedPainting = false;
    _placedGrid = null;
    _foliageUsedDirty = true;   // an erase-all may have cleared foliage
    propSys.bvh?.invalidate();
    refreshPropCount();
    placedUi?.rebuild();
  });
  renderer.domElement.addEventListener("wheel", e => {
    if (playMode.active || editorMode !== "vegPlaced") return;
    if (!e.shiftKey && !e.altKey) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const factor = e.deltaY > 0 ? 0.9 : 1.11;
    if (e.shiftKey) {
      vegBrush.radius = Math.max(1, Math.min(300, vegBrush.radius * factor));
      sculpt.uRadius.value = vegBrush.radius / WORLD_SIZE;
    } else {
      vegBrush.strength = Math.max(0.05, Math.min(1.0, vegBrush.strength * factor));
    }
    vegUi?.refresh();
  }, { passive: false, capture: true });

  async function importPlantGlb(file = null) {
    const run = async (f) => {
      const typeIdx = await loadGltfAsType(f);
      const slotIdx = propSlots.findIndex((s) => s.typeIdx === typeIdx);
      if (slotIdx < 0) return;
      makePlantSlot(slotIdx, {});
      _vegPlacedSlot = slotIdx;
      void queuePlacedThumb(slotIdx);
      if (editorMode !== "vegPlaced") setEditorMode("vegPlaced");
      else { placedUi?.rebuild(); vegUi?.rebuild(); }
    };
    if (file) {
      try { await run(file); } catch (err) { console.error("[V3] Plant GLB load failed:", err); }
      return;
    }
    const inp = Object.assign(document.createElement("input"), { type: "file", accept: ".glb,.gltf", multiple: true });
    inp.onchange = async () => {
      for (const f of inp.files ?? []) {
        try { await run(f); } catch (err) { console.error("[V3] Plant GLB load failed:", err); }
      }
    };
    inp.click();
  }

  if (isEditor && vegPlacedEl) placedUi = buildPlacedPlantPanel(vegPlacedEl, {
    getSlot: () => propSlots[_vegPlacedSlot] ?? null,
    getCount: () => {
      const s = propSlots[_vegPlacedSlot];
      return s ? _plantInstanceCount(s.typeIdx) : 0;
    },
    onCollideChanged: () => {
      const s = propSlots[_vegPlacedSlot];
      const t = s && propStore.types[s.typeIdx];
      if (!t) return;
      t.noCollide = !s.plant.collide;
      propStore._bump();
      propSys.bvh?.invalidate();
    },
    onWindChanged: () => syncPlantSway(propSlots[_vegPlacedSlot]),
    onImport: () => importPlantGlb(),
    onRemove: () => {
      const s = propSlots[_vegPlacedSlot];
      if (!s || !_plantInstanceCount(s.typeIdx)) return;
      _pushVegUndo(["vegPlaced"]);
      _restorePlantInstances(_plantInstancesSnapshot().filter((p) => p.typeIdx !== s.typeIdx));
    },
  });
  const _vegBrushOf = (mode) => (mode === "flowers" ? flowerBrush : mode === "susuki" ? susukiBrush : foliageScatterBrush);
  const _vegPanelOf = (mode) =>
    (mode === "flowers" ? flowerUi : mode === "susuki" ? susukiUi : mode === "vegPlaced" ? placedUi : foliageUi);
  // Card pictures for flowers and susuki are 2D sketches, redrawn only when
  // what they show changed.
  const _vegThumbCache = new Map();
  function _vegThumb(key, sig, draw) {
    const hit = _vegThumbCache.get(key);
    if (hit && hit.sig === sig) return hit.url;
    const url = draw();
    _vegThumbCache.set(key, { sig, url });
    return url;
  }
  const _flowerThumb = (i) => {
    const t = flowerState.types[i];
    const sig = JSON.stringify([t.petals, t.petalLength, t.petalWidth, t.doubleLayer, t.petalBase, t.petalTip, t.centre, t.centreSize]);
    return _vegThumb(`flower:${i}`, sig, () => drawFlowerThumb(t));
  };

  const vegFill = (mode, type) => {
    _pushVegUndo([mode]);
    if (mode === "flowers") { flowerDensity.fill(type); void ensureFlowersBuilt(); }
    else if (mode === "susuki") { grassTerrainData.fillSusukiDensity(type); void ensureSusukiBuilt(); }
    else { foliageDensity.fill(type); _foliageUsedDirty = true; void ensureFoliageScatterBuilt(); }
  };

  if (isEditor && vegHeaderEl) vegUi = buildVegetationHeader(vegHeaderEl, {
    brush: vegBrush,
    groups: () => [
      {
        title: "Plants",
        cards: [
          ...foliageScatterState.types.map((t, i) => ({
            mode: "foliage", key: i, get name() { return t.name; }, thumb: () => _foliageThumbs.get(i) ?? null,
          })),
          // The tall plants: their own far-reaching field (visible to ~195 m
          // where the foliage field stops at 95), but plants like the rest.
          ...susukiState.types.map((t, i) => ({
            mode: "susuki", key: i, get name() { return t.name; }, thumb: () => _susukiThumbs.get(i) ?? null,
          })),
        ],
      },
      {
        title: "Flowers",
        cards: flowerState.types.map((t, i) => ({
          mode: "flowers", key: i, get name() { return t.name; }, thumb: () => _flowerThumb(i),
        })),
      },
      {
        title: "Placed plants (GLB)",
        onDropFile: (key, file) => importPlantGlb(file),
        cards: [
          ...propSlots.map((s, i) => [s, i]).filter(([s]) => s?.plant).map(([s, i]) => ({
            mode: "vegPlaced", key: i, canFill: false, get name() { return s.name; }, thumb: () => _placedThumbs.get(s) ?? null,
          })),
          { mode: "vegPlaced", key: "import", name: "Import GLB", kind: "empty", canFill: false, title: "Import a plant GLB — or drop one on this card" },
        ],
      },
    ],
    active: () => {
      const mode = VEG_MODES.includes(editorMode) ? editorMode : _lastVegMode;
      return { mode, type: mode === "vegPlaced" ? _vegPlacedSlot : _vegBrushOf(mode).type };
    },
    onSelect: (mode, type) => {
      if (mode === "vegPlaced") {
        if (type === "import") { void importPlantGlb(); return; }
        _vegPlacedSlot = type;
      } else {
        _vegBrushOf(mode).type = type;
      }
      // The settings panel shows the picked plant, whichever kind it is.
      _vegPanelOf(mode)?.rebuild?.();
      if (editorMode !== mode) setEditorMode(mode);
      else vegUi.rebuild();
    },
    onBrushChanged: () => { sculpt.uRadius.value = vegBrush.radius / WORLD_SIZE; },
    onFill: vegFill,
    onClearAll: () => {
      const kinds = VEG_MODES.filter(_vegHasData);
      if (!kinds.length) return;
      _pushVegUndo(kinds);
      foliageDensity.clear();
      flowerDensity.clear();
      grassTerrainData.clearSusukiDensity();
      if (kinds.includes("vegPlaced")) _restorePlantInstances([]);
      _foliageUsedDirty = true;
    },
  });

  function _susukiPaintXZ(e) {
    refreshMouse(e);
    const hit = getUV();
    uCursorUV.value.set(hit ? hit.u : -2, hit ? hit.v : -2);
    if (!hit) return null;
    return { wx: hit.u * WORLD_SIZE - WORLD_SIZE / 2, wz: hit.v * WORLD_SIZE - WORLD_SIZE / 2 };
  }

  function _stampSusuki(wx, wz, altErase) {
    if (_vegEraseAll(altErase)) { _eraseAllVeg(wx, wz); return; }
    grassTerrainData.stampSusukiDensity({
      cx: wx, cz: wz,
      radius:    susukiBrush.radius,
      strength:  susukiBrush.strength,
      falloff:   susukiBrush.falloff,
      worldSize: WORLD_SIZE,
      erase:     susukiBrush.erase || altErase,
      channel:   susukiBrush.type ?? 0,
    });
  }

  renderer.domElement.addEventListener("mousemove", e => {
    if (playMode.active || editorMode !== "susuki") return;
    const pt = _susukiPaintXZ(e);
    if (pt) sculpt.uRadius.value = susukiBrush.radius / WORLD_SIZE;
    if (pt && _susukiPainting) _stampSusuki(pt.wx, pt.wz, e.altKey);
  });

  renderer.domElement.addEventListener("mousedown", e => {
    if (playMode.active || editorMode !== "susuki") return;
    if (e.button !== 0) return;
    const pt = _susukiPaintXZ(e);
    if (!pt) return;
    _pushVegUndo(_vegStrokeKinds("susuki", e.altKey));
    _susukiPainting = true;
    void ensureSusukiBuilt();
    _stampSusuki(pt.wx, pt.wz, e.altKey);
  }, { capture: true });

  renderer.domElement.addEventListener("mouseup", e => {
    if (e.button !== 0) return;
    if (_susukiPainting) _foliageUsedDirty = true;   // an erase-all may have cleared foliage
    _susukiPainting = false;
  });

  // Scroll wheel in susuki mode: Shift = radius, Alt = strength
  renderer.domElement.addEventListener("wheel", e => {
    if (playMode.active || editorMode !== "susuki") return;
    if (!e.shiftKey && !e.altKey) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const factor = e.deltaY > 0 ? 0.9 : 1.11;
    if (e.shiftKey) {
      vegBrush.radius = Math.max(1, Math.min(300, vegBrush.radius * factor));
      sculpt.uRadius.value = vegBrush.radius / WORLD_SIZE;
    } else {
      vegBrush.strength = Math.max(0.05, Math.min(1.0, vegBrush.strength * factor));
    }
    vegUi?.refresh();
  }, { passive: false, capture: true });

  // ── Flower mode: panel + paint events ──────────────────────────────────────
  let _flowerPainting = false;

  if (isEditor && flowerPanel) flowerUi = buildFlowerPanel(flowerPanel, {
    flowerBrush,
    flowerState,
    getLayerNames: () => textureLib.slots.map((s) => s.name),
    onStateChanged: () => { syncFlowerUniforms(); vegUi?.refreshCards(); },
    onGeometryChanged: (i) => { flowerSystem?.rebuildType(i, flowerState.types[i]); vegUi?.refreshCards(); },
  });

  function _flowerPaintXZ(e) {
    refreshMouse(e);
    const hit = getUV();
    uCursorUV.value.set(hit ? hit.u : -2, hit ? hit.v : -2);
    if (!hit) return null;
    return { wx: hit.u * WORLD_SIZE - WORLD_SIZE / 2, wz: hit.v * WORLD_SIZE - WORLD_SIZE / 2 };
  }

  function _stampFlowers(wx, wz, altErase) {
    if (_vegEraseAll(altErase)) { _eraseAllVeg(wx, wz); return; }
    flowerDensity.stamp({
      cx: wx, cz: wz,
      radius:    flowerBrush.radius,
      strength:  flowerBrush.strength,
      falloff:   flowerBrush.falloff,
      worldSize: WORLD_SIZE,
      channel:   flowerBrush.type,
      erase:     flowerBrush.erase || altErase,
      onlyChannel: flowerBrush.eraseOnlyType,
    });
  }

  renderer.domElement.addEventListener("mousemove", e => {
    if (playMode.active || editorMode !== "flowers") return;
    const pt = _flowerPaintXZ(e);
    if (pt) sculpt.uRadius.value = flowerBrush.radius / WORLD_SIZE;
    if (pt && _flowerPainting) _stampFlowers(pt.wx, pt.wz, e.altKey);
  });

  renderer.domElement.addEventListener("mousedown", e => {
    if (playMode.active || editorMode !== "flowers" || e.button !== 0) return;
    const pt = _flowerPaintXZ(e);
    if (!pt) return;
    _pushVegUndo(_vegStrokeKinds("flowers", e.altKey));
    _flowerPainting = true;
    void ensureFlowersBuilt();
    _stampFlowers(pt.wx, pt.wz, e.altKey);
  }, { capture: true });

  renderer.domElement.addEventListener("mouseup", e => {
    if (e.button !== 0) return;
    if (_flowerPainting) _foliageUsedDirty = true;   // an erase-all may have cleared foliage
    _flowerPainting = false;
  });

  // Scroll wheel in flower mode: Shift = radius, Alt = strength
  renderer.domElement.addEventListener("wheel", e => {
    if (playMode.active || editorMode !== "flowers") return;
    if (!e.shiftKey && !e.altKey) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const factor = e.deltaY > 0 ? 0.9 : 1.11;
    if (e.shiftKey) {
      vegBrush.radius = Math.max(1, Math.min(300, vegBrush.radius * factor));
      sculpt.uRadius.value = vegBrush.radius / WORLD_SIZE;
    } else {
      vegBrush.strength = Math.max(0.05, Math.min(1.0, vegBrush.strength * factor));
    }
    vegUi?.refresh();
  }, { passive: false, capture: true });

  // ── Tree mode mouse events (v2 treePaint) ─────────────────────────────────
  let _treePainting = false;
  const _treeHit = new THREE.Vector3();

  function _treeHitFromEvent(e) {
    refreshMouse(e);
    const uv = getUV();
    if (!uv) return null;
    return _treeHit.set(
      uv.u * WORLD_SIZE - WORLD_SIZE / 2,
      sampleTerrainHeight(uv.u, uv.v),
      uv.v * WORLD_SIZE - WORLD_SIZE / 2,
    );
  }

  renderer.domElement.addEventListener("mousemove", e => {
    if (playMode.active || editorMode !== "treePaint") return;
    refreshMouse(e);
    const uv = getUV();
    uCursorUV.value.set(uv ? uv.u : -2, uv ? uv.v : -2);
    if (uv) sculpt.uRadius.value = treeToolState.brush.radius / WORLD_SIZE;
    const pt = _treeHitFromEvent(e);
    if (pt && _treePainting) treeEnv.treeSystem.applyAt(pt, e);
  });

  renderer.domElement.addEventListener("mousedown", e => {
    if (playMode.active || editorMode !== "treePaint") return;
    if (e.button !== 0) return;
    const pt = _treeHitFromEvent(e);
    if (!pt) return;
    e.preventDefault();
    _treePainting = true;
    controls.enabled = false;
    treeEnv.treeSystem.beginStroke(pt, e);
  }, { capture: true });

  renderer.domElement.addEventListener("mouseup", e => {
    if (e.button !== 0 || editorMode !== "treePaint") return;
    if (!_treePainting) return;
    _treePainting = false;
    treeEnv.treeSystem.endStroke();
    syncEditorOrbitEnabled();
  });

  renderer.domElement.addEventListener("wheel", e => {
    if (playMode.active || editorMode !== "treePaint") return;
    if (!e.shiftKey && !e.altKey) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const factor = e.deltaY > 0 ? 0.9 : 1.11;
    if (e.shiftKey) {
      treeToolState.brush.radius = Math.max(
        editorConfig.sculpt.brushMin,
        Math.min(editorConfig.sculpt.brushMax, treeToolState.brush.radius * factor),
      );
      sculpt.uRadius.value = treeToolState.brush.radius / WORLD_SIZE;
    } else {
      treeToolState.brush.strength = Math.max(
        editorConfig.sculpt.strengthMin,
        Math.min(editorConfig.sculpt.strengthMax, treeToolState.brush.strength * factor),
      );
    }
  }, { passive: false, capture: true });

  // ── Foliage mode: paint events (the same density brush as the flowers) ────
  let _foliagePainting = false;

  function _foliagePaintXZ(e) {
    refreshMouse(e);
    const uv = getUV();
    uCursorUV.value.set(uv ? uv.u : -2, uv ? uv.v : -2);
    if (!uv) return null;
    return { wx: uv.u * WORLD_SIZE - WORLD_SIZE / 2, wz: uv.v * WORLD_SIZE - WORLD_SIZE / 2 };
  }

  function _stampFoliage(wx, wz, altErase) {
    if (_vegEraseAll(altErase)) { _eraseAllVeg(wx, wz); return; }
    foliageDensity.stamp({
      cx: wx, cz: wz,
      radius:    foliageScatterBrush.radius,
      strength:  foliageScatterBrush.strength,
      falloff:   foliageScatterBrush.falloff,
      worldSize: WORLD_SIZE,
      channel:   foliageScatterBrush.type,
      erase:     foliageScatterBrush.erase || altErase,
      onlyChannel: foliageScatterBrush.eraseOnlyType,
    });
  }

  renderer.domElement.addEventListener("mousemove", e => {
    if (playMode.active || editorMode !== "foliage") return;
    const pt = _foliagePaintXZ(e);
    if (pt) sculpt.uRadius.value = foliageScatterBrush.radius / WORLD_SIZE;
    if (pt && _foliagePainting) _stampFoliage(pt.wx, pt.wz, e.altKey);
  });

  renderer.domElement.addEventListener("mousedown", e => {
    if (playMode.active || editorMode !== "foliage" || e.button !== 0) return;
    const pt = _foliagePaintXZ(e);
    if (!pt) return;
    e.preventDefault();
    _pushVegUndo(_vegStrokeKinds("foliage", e.altKey));
    _foliagePainting = true;
    void ensureFoliageScatterBuilt();
    _stampFoliage(pt.wx, pt.wz, e.altKey);
  }, { capture: true });

  renderer.domElement.addEventListener("mouseup", e => {
    if (e.button === 0 && _foliagePainting) { _foliagePainting = false; _foliageUsedDirty = true; }
  });

  /* ── Ambient FX painting ───────────────────────────────────────────────── */

  function _ambientStamp(wx, wz, altErase) {
    const e = ambientFxState.effects[_ambientFxSelected];
    ambientDensity.stamp({
      cx: wx, cz: wz,
      radius:    ambientBrush.radius,
      strength:  ambientBrush.strength,
      falloff:   ambientBrush.falloff,
      worldSize: WORLD_SIZE,
      channel:   _ambientFxSelected,
      erase:     ambientBrush.erase || altErase,
      onlyChannel: true,   // this mode's erase is always "just this effect"
    });
    // Painting an effect that ignores paint is the one genuinely confusing
    // state this could be in, so the first stroke switches it over.
    if (!(ambientBrush.erase || altErase) && e && e.area !== "painted") {
      e.area = "painted";
      syncAmbientFxUniforms();
      ambientFxUi?.rebuild();
    }
  }

  function _pushAmbientUndo() {
    _ambientUndoStack.push(ambientDensity.getSnapshot());
    if (_ambientUndoStack.length > AMBIENT_UNDO_LIMIT) _ambientUndoStack.shift();
    _ambientRedoStack.length = 0;
  }

  renderer.domElement.addEventListener("mousemove", e => {
    if (playMode.active || editorMode !== "ambientFx") return;
    const pt = _foliagePaintXZ(e);
    if (pt) sculpt.uRadius.value = ambientBrush.radius / WORLD_SIZE;
    if (pt && _ambientPainting) _ambientStamp(pt.wx, pt.wz, e.altKey);
  });

  renderer.domElement.addEventListener("mousedown", e => {
    if (playMode.active || editorMode !== "ambientFx" || e.button !== 0) return;
    const pt = _foliagePaintXZ(e);
    if (!pt) return;
    e.preventDefault();
    _pushAmbientUndo();
    _ambientPainting = true;
    void ensureAmbientFxBuilt();
    _ambientStamp(pt.wx, pt.wz, e.altKey);
  }, { capture: true });

  renderer.domElement.addEventListener("mouseup", e => {
    if (e.button === 0 && _ambientPainting) _ambientPainting = false;
  });

  // Shift = radius, Alt = strength, as in every other paint mode.
  renderer.domElement.addEventListener("wheel", e => {
    if (playMode.active || editorMode !== "ambientFx") return;
    if (!e.shiftKey && !e.altKey) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const factor = e.deltaY > 0 ? 0.9 : 1.11;
    if (e.shiftKey) {
      ambientBrush.radius = Math.max(1, Math.min(300, ambientBrush.radius * factor));
      sculpt.uRadius.value = ambientBrush.radius / WORLD_SIZE;
    } else {
      ambientBrush.strength = Math.max(0.05, Math.min(1, ambientBrush.strength * factor));
    }
    ambientFxUi?.rebuild();
  }, { passive: false, capture: true });

  // Scroll wheel in foliage mode: Shift = radius, Alt = strength
  renderer.domElement.addEventListener("wheel", e => {
    if (playMode.active || editorMode !== "foliage") return;
    if (!e.shiftKey && !e.altKey) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const factor = e.deltaY > 0 ? 0.9 : 1.11;
    if (e.shiftKey) {
      vegBrush.radius = Math.max(1, Math.min(300, vegBrush.radius * factor));
      sculpt.uRadius.value = vegBrush.radius / WORLD_SIZE;
    } else {
      vegBrush.strength = Math.max(0.05, Math.min(1.0, vegBrush.strength * factor));
    }
    vegUi?.refresh();
  }, { passive: false, capture: true });

  // Grass undo/redo (routed by undoInMode). Each entry carries whether it
  // snapshots the terrain or the cliff density layer.
  function _snapGrass(layer) {
    if (layer === "cliff")  return grassTerrainData.getCliffDensitySnapshot();
    if (layer === "height") return grassTerrainData.getBladeHeightSnapshot();
    return grassTerrainData.getDensitySnapshot();
  }
  function _restoreGrass(layer, data) {
    if (layer === "cliff")       grassTerrainData.restoreCliffDensitySnapshot(data);
    else if (layer === "height") grassTerrainData.restoreBladeHeightSnapshot(data);
    else                         grassTerrainData.restoreDensitySnapshot(data);
  }

  // Re-sync orbit after props/spline wiring (do not reset mode — that felt like a freeze).
  syncEditorOrbitEnabled();

  // editor.html?laneRoad=junction boots straight into the lane road preview
  // (scenes: straight, junction, roundabout, all, or an engine demo scene).
  {
    const q = new URLSearchParams(location.search).get("laneRoad");
    if (q != null) {
      if (q) laneRoadToolSlice.laneRoad.scene = q;
      setEditorMode("laneRoad");
    }
  }

  if (import.meta.env?.DEV) {
    window.__V3_DEBUG = {
      /**
       * What the ambient field is actually doing this frame — the honest
       * numbers, read off the live objects rather than off the state.
       *   __V3_DEBUG.ambientFx()
       */
      ambientFx() {
        if (!ambientFx) return { built: false };
        const f = ambientFx.field;
        return {
          built: true,
          enabled: ambientFxState.enabled,
          visible: f.group.visible,
          draws: f.meshes.filter((m) => m.visible).length,
          trianglesPerCard: f.triangles[0],
          poolSlots: f.count,
          sliceStart: f._sliceStart.slice(),
          sliceLen: f._sliceLen.slice(),
          tier: f.u.uTier.value,
          volumeXZ: f.u.uVolumeXZ.value,
          volumeY: f.u.uVolumeY.value,
          center: f.u.uCenter.value.toArray().map((v) => +v.toFixed(1)),
          dt: +f.u.uDt.value.toFixed(4),
          viewportH: f.u.uViewportH.value,
          fy: +f.u.uFy.value.toFixed(4),
          // Per effect: authored size, pixel floor, and the world size that
          // floor implies at 20 m - the number to check when something is
          // still a speck.
          sizes: f.effectRows.length ? Array.from({ length: f.effectCount }, (_, i) => {
            const rows = f.effectRows, R = rows.length / f.effectCount;
            const size = rows[i * R].w, floorPx = rows[i * R + 9].x;
            const at20 = floorPx * 20 / (f.u.uFy.value * f.u.uViewportH.value);
            return { size: +size.toFixed(4), floorPx, worldAt20m: +at20.toFixed(4) };
          }) : null,
          // What the frame actually cost. The instance count lives in an
          // indirect buffer the GPU writes, and reading a storage buffer back
          // hands you the stale CPU copy — so the only honest measure of "are
          // any alive" is the triangles that reached the rasteriser.
          drawCalls: renderer.info.render.drawCalls,
          triangles: renderer.info.render.triangles,
        };
      },
      /**
       * Drive the ambient field's settings from the console, for A/Bs.
       * `effects` is applied to every effect (or just `only`), the rest to
       * the field.
       *   __V3_DEBUG.ambientSet({ effects: { budget: 4000 } })
       *   __V3_DEBUG.ambientSet({ only: 0, effects: { dayStart: 20, dayEnd: 22 } })
       *   __V3_DEBUG.ambientSet({ enabled: false })
       */
      ambientSet(patch = {}) {
        const { effects, only, ...field } = patch;
        Object.assign(ambientFxState, field);
        if (effects) {
          const targets = only === undefined ? ambientFxState.effects : [ambientFxState.effects[only]];
          for (const e of targets) if (e) Object.assign(e, effects);
        }
        syncAmbientFxUniforms();
        ambientFxUi?.rebuild();
        return window.__V3_DEBUG.ambientFx();
      },
      /**
       * The per-pass GPU timing panel, created on demand.
       *
       * It is off by default (see the note where it is imported) because the
       * numbers it exists to distrust are the ones stats-gl shows. Any A/B in
       * this editor should come through here rather than through
       * `renderer.info.render.timestamp`, which under-reports partial frames
       * by an order of magnitude.
       *   const g = await __V3_DEBUG.gpu(); g.sample().frameTotals
       */
      async gpu() {
        if (!hasTimestamps) return null;
        if (!_gpuStatsPanel) {
          const { createGpuStatsPanel } = await import("../render/gpuStatsPanel.js");
          _gpuStatsPanel = createGpuStatsPanel(renderer);
        }
        return _gpuStatsPanel;
      },
      /**
       * A GPU A/B whose numbers survive being checked — interleaved rounds,
       * the MEAN of raw per-frame totals (the median collapses on a quantised
       * timestamp), and a settle after every state change. Read its header
       * before trusting any perf claim made without it.
       *   const g = await __V3_DEBUG.gpu();
       *   await __V3_DEBUG.gpuAB({ sample: g.sample, cases: { a, b }, reset });
       */
      async gpuAB(opts) {
        const { gpuAB } = await import("../render/gpuAbHarness.js");
        if (!opts?.sample) {
          const g = await this.gpu();
          if (!g) throw new Error("gpuAB: no timestamp support on this device");
          opts = { ...opts, sample: g.sample };
        }
        return gpuAB(opts);
      },
      /**
       * Stand on the ground at (x, z) looking level. Ambient FX is a
       * head-height effect — from the default camera 300 m up, every particle
       * is past its own fade distance and correctly draws nothing.
       *   __V3_DEBUG.ambientStand()
       */
      ambientStand(x = 0, z = 0) {
        const y = terrainStoreAdapter.getWorldHeight(x, z);
        camera.position.set(x, y + 1.7, z);
        controls.target.set(x + 12, y + 1.4, z);
        controls.update();
        return { at: [x, +(y + 1.7).toFixed(2), z] };
      },
      /*
       * A repeatable prop stress scene, for measuring the instancing and shadow
       * work. It goes through the SAME path the Props tool uses (addPrimitive →
       * registerPrimitive → onTypeRegistered → auto-LOD), because props added
       * straight to the store never render: the instancer is told about a type
       * by the app, not by the store.
       *
       *   __V3_DEBUG.propStress()            // 12k spheres over 520 m, camera in the middle
       *   __V3_DEBUG.propStress({ count: 20000, shape: "Torus", radius: 400 })
       *   __V3_DEBUG.propStressClear()
       *
       * Golden-angle spiral so density is even and the layout is identical
       * every run — two measurements a week apart are comparable.
       */
      propStress({ count = 12000, shape = "Sphere", radius = 260, stand = true } = {}) {
        addPrimitive(shape);
        const slot = propSlots.find((s) => s.name === shape && s.builtin);
        if (!slot) return { error: `unknown primitive "${shape}"` };
        const typeIdx = slot.typeIdx;
        for (let i = 0; i < count; i++) {
          const ang = i * 2.399963;                       // golden angle
          const rad = radius * Math.sqrt((i + 0.5) / count);
          const x = Math.cos(ang) * rad, z = Math.sin(ang) * rad;
          propStore.addInstance(typeIdx, x, terrainStoreAdapter.getWorldHeight(x, z), z, {
            ry: (i * 0.37) % (Math.PI * 2), sx: 1.2, sy: 1.6, sz: 1.2,
          });
        }
        if (stand) {
          const y = terrainStoreAdapter.getWorldHeight(0, 0);
          camera.position.set(0, y + 1.7, 0);
          controls.target.set(60, terrainStoreAdapter.getWorldHeight(60, 0) + 1, 0);
          controls.update();
        }
        return { typeIdx, instances: propStore.instances.length };
      },
      /*
       * Procedural rock kit (props/proceduralRock.js), through the real
       * addRock path.
       *
       *   __V3_DEBUG.rockPreview()        // one of each kit shape in a row
       *   __V3_DEBUG.rockStress()         // 5000 mixed rocks over 150 m, seeded
       *   __V3_DEBUG.rockStress({ count: 20000, radius: 300 })
       */
      rockPreview({ scale = 2 } = {}) {
        const cx = controls.target.x, cz = controls.target.z;
        // Megaliths get their own row and a scale of ONE: a 13 m karst tower
        // multiplied by the preview's default 2 is a 26 m building, and the
        // point of looking at it is to judge it at the size it will be placed.
        const rowZ = { boulder: 0, lump: 10, rock: 18, pebble: 24, megalith: -26 };
        const col = {};
        const stats = {};
        for (const kit of ROCK_KIT) {
          addRock(kit.name);
          const slot = propSlots.find((s) => s.name === kit.name && s.builtin);
          if (!slot) continue;
          const i = col[kit.cls] = (col[kit.cls] ?? -1) + 1;
          const big = kit.cls === "megalith";
          const sc = big ? 1 : scale;
          const spacing = { boulder: 4.5, lump: 4.5, rock: 2.6, pebble: 1.2, megalith: 16 }[kit.cls] * sc;
          const x = cx + (i - 1.5) * spacing, z = cz + (rowZ[kit.cls] ?? 0);
          propStore.addInstance(slot.typeIdx, x, terrainStoreAdapter.getWorldHeight(x, z) - 0.05 * sc, z, {
            ry: kit.seed * 47, sx: sc, sy: sc, sz: sc,
          });
          stats[kit.name] = propStore.types[slot.typeIdx].entries[0].geometry.userData.rock;
        }
        return stats;
      },
      /*
       * Chipped cliff test: the rock generator with a top cut (see
       * ROCK_CLIFF_PRESETS). Each entry = one cliff type, in a row at the
       * orbit target, through addCliff (solid + terrain blend). Entries are
       * overrides on the "Cliff: Chip Pillar" preset. Session-only.
       *
       *   __V3_DEBUG.cliffPreview([{ seed: 1 }, { seed: 2, topCut: 0.4 }])
       */
      cliffPreview(list = [{ seed: 1 }, { seed: 2 }, { seed: 3 }, { seed: 4 }], { spacing = 40, scale = 1 } = {}) {
        const cx = controls.target.x, cz = controls.target.z;
        const out = [];
        const base = ROCK_CLIFF_PRESETS[0].params;
        list.forEach((over, i) => {
          const params = { ...base, ...over };
          const name = `Cliff: Chip test ${JSON.stringify(over)}`;
          if (!CLIFF_PRESETS.some((c) => c.name === name)) CLIFF_PRESETS.push({ name, generator: "rock", params });
          addCliff(name);
          const slot = propSlots.find((s) => s.name === name && s.builtin);
          if (!slot) return;
          const x = cx + (i - (list.length - 1) / 2) * spacing * scale, z = cz;
          propStore.addInstance(slot.typeIdx, x, terrainStoreAdapter.getWorldHeight(x, z) - 1 * scale, z, {
            ry: i * 73, sx: scale, sy: scale, sz: scale,
          });
          out.push(propStore.types[slot.typeIdx].entries[0].geometry.userData.rock);
        });
        return out;
      },
      rockStress({ count = 5000, radius = 150, stand = true } = {}) {
        let seed = 0x2545f491;
        const rnd = () => {                                // mulberry32
          seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
          let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
          t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
        for (const kit of ROCK_KIT) addRock(kit.name);
        const byCls = {};
        for (const kit of ROCK_KIT) {
          const slot = propSlots.find((s) => s.name === kit.name && s.builtin);
          if (slot) (byCls[kit.cls] ??= []).push(slot.typeIdx);
        }
        // a natural mix: few big, many small
        const mix = [["boulder", 0.08, 1.5, 3.5], ["lump", 0.1, 1.2, 3], ["rock", 0.32, 0.8, 2], ["pebble", 0.5, 0.8, 2.5]];
        for (let i = 0; i < count; i++) {
          let r = rnd(), m = mix[mix.length - 1];
          for (const e of mix) { if (r < e[1]) { m = e; break; } r -= e[1]; }
          const types = byCls[m[0]];
          if (!types) continue;
          const ang = rnd() * Math.PI * 2, rad = radius * Math.sqrt(rnd());
          const x = Math.cos(ang) * rad, z = Math.sin(ang) * rad;
          const s = m[2] + (m[3] - m[2]) * rnd();
          propStore.addInstance(types[(rnd() * types.length) | 0], x, terrainStoreAdapter.getWorldHeight(x, z) - 0.05 * s, z, {
            rx: (rnd() - 0.5) * 16, ry: rnd() * 360, rz: (rnd() - 0.5) * 16,
            sx: s * (0.85 + rnd() * 0.3), sy: s * (0.8 + rnd() * 0.4), sz: s * (0.85 + rnd() * 0.3),
          });
        }
        if (stand) {
          const y = terrainStoreAdapter.getWorldHeight(0, 0);
          camera.position.set(0, y + 1.7, 0);
          controls.target.set(40, terrainStoreAdapter.getWorldHeight(40, 0) + 1, 0);
          controls.update();
        }
        return { instances: propStore.instances.length, types: propStore.types.length };
      },
      /*
       * A MIXED world, closer to a real level than 12k identical spheres:
       * five primitive shapes as scatter, heavy procedural cliffs, and a
       * forest from the tree tool's own synthetic preset. Deterministic (seeded)
       * so runs compare.
       *
       *   await __V3_DEBUG.worldStress()                    // 20k props + 3k trees
       *   await __V3_DEBUG.worldStress({ props: 40000, trees: 6000, radius: 480 })
       *   __V3_DEBUG.propStressClear()                      // props only
       */
      async worldStress({ props = 20000, trees = 3000, radius = 450, cliffShare = 0.03, stand = true } = {}) {
        let seed = 0x9e3779b9;
        const rnd = () => {                                // mulberry32
          seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
          let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
          t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
        const slotOf = (name) => propSlots.find((s) => s.name === name && s.builtin)?.typeIdx;
        const scatter = ["Cube", "Sphere", "Cylinder", "Cone", "Torus"];
        const cliffs = ROCK_CLIFF_PRESETS.map((c) => c.name);
        for (const s of scatter) addPrimitive(s);
        for (const c of cliffs) addCliff(c);
        const scatterTypes = scatter.map(slotOf).filter((t) => t != null);
        const cliffTypes = cliffs.map(slotOf).filter((t) => t != null);

        for (let i = 0; i < props; i++) {
          const ang = rnd() * Math.PI * 2;
          const rad = radius * Math.sqrt(rnd());
          const x = Math.cos(ang) * rad, z = Math.sin(ang) * rad;
          const y = terrainStoreAdapter.getWorldHeight(x, z);
          const cliff = cliffTypes.length && rnd() < cliffShare;
          if (cliff) {
            const s = 0.6 + rnd() * 0.9;
            propStore.addInstance(cliffTypes[(rnd() * cliffTypes.length) | 0], x, y - 1, z, {
              ry: rnd() * Math.PI * 2, sx: s, sy: s * (0.7 + rnd() * 0.6), sz: s,
            });
          } else {
            const s = 0.4 + rnd() * 2.2;
            propStore.addInstance(scatterTypes[(rnd() * scatterTypes.length) | 0], x, y, z, {
              rx: (rnd() - 0.5) * 0.4, ry: rnd() * Math.PI * 2, rz: (rnd() - 0.5) * 0.4,
              sx: s, sy: s * (0.6 + rnd() * 0.9), sz: s,
            });
          }
        }
        let planted = 0;
        if (trees > 0 && window.__treeDebug?.spawnTestForest) {
          await window.__treeDebug.spawnTestForest(trees, radius);
          planted = trees;
        }
        if (stand) {
          const y = terrainStoreAdapter.getWorldHeight(0, 0);
          camera.position.set(0, y + 1.7, 0);
          controls.target.set(60, terrainStoreAdapter.getWorldHeight(60, 0) + 1, 0);
          controls.update();
        }
        return { props: propStore.instances.length, types: propSlots.length, trees: planted };
      },
      /*
       * The instancer itself, so an A/B can switch between the per-cascade
       * shadow lists and the old whole-tier gate INSIDE one measurement:
       *
       *   __V3_DEBUG.propInstancer.setShadowCsm(null)                  // old
       *   __V3_DEBUG.propInstancer.setShadowCsm(__v3app.shadows.csm)   // new
       *
       * This laptop's GPU clock drifts over a minute, so two runs taken apart
       * are not comparable — interleave them instead.
       */
      get propInstancer() { return propInstancer; },
      /** The ground-paint system — drive strokes from the console for painting A/Bs. */
      get paintSys() { return paintSys; },
      terrainShadowMap,
      /** Detach (null) / re-attach the map for materials built AFTER the call — for A/Bs. */
      setActiveTerrainShadowMap,
      propStressClear() {
        propStore.clear();
        propSlots.length = 0;
        propState.activeSlot = -1;
        uiById("props-panel")?._rebuildPropUi?.();
        return { instances: propStore.instances.length };
      },
      /**
       * Foliage diagnosis hooks (2026-09-20, the "black leaf undersides").
       *   await __V3_DEBUG.foliageFill(0)        // paint type 0 everywhere, build the field
       *   __V3_DEBUG.foliageShadows(false)       // stop the foliage CASTING (its shadow lists)
       *   __V3_DEBUG.foliage                     // the live FoliageScatterSystem
       * Black patches that vanish when the foliage stops casting are shadow
       * ACNE (self-shadowing of thin leaves); undersides that merely go evenly
       * dark are real shade with too little fill light.
       */
      async foliageFill(channel = 0) {
        foliageDensity.fill(channel);
        await ensureFoliageScatterBuilt();
        return { types: foliageDensity.usedChannels() };
      },
      foliageShadows(on = true) {
        const f = foliageScatter?.field;
        if (!f) return false;
        // castShadow, not visible: the field re-asserts visibility every update.
        for (const m of f.shadowMeshes ?? []) if (m) m.castShadow = !!on;
        return !!on;
      },
      get foliage() { return foliageScatter; },
      get editorMode() { return editorMode; },
      get playActive() { return playMode.active; },
      getFlightDebug: () => playMode.getFlightDebug?.(),
      controls,
      tc,
      editorCamera,
      syncEditorOrbitEnabled,
      setEditorMode,
      recoverEditorInput,
      get rendererSideWork() { return _rendererSideWork; },
      get lakeSystem() { return lakeSystem; },
      lakebedShading,
      waterSurfaceMap,
      waterSurfaceMap,
      get riverV2System() { return riverV2System; },
      riverSandShading,
      /**
       * River flow at a world position, for physics, gameplay and audio:
       * `{ surfaceY, bedY, depth, speed, dirX, dirZ, inChannel, ... }` or null.
       * `flowForceAt` adds the immersion ramp most callers would write anyway.
       */
      sampleRiverFlow: (x, z) => riverV2System?.sampleFlow(x, z) ?? null,
      sampleRiverFlowAt: (x, y, z) => riverV2System?.sampleFlowAt(x, y, z) ?? null,
      riverFlowForceAt: (x, y, z, drag) => riverV2System?.flowForceAt(x, y, z, drag) ?? null,
      get grassState() { return grassState; },
      // Push edits to grassState / revoGrassState into the live systems, the
      // way the editor panel does — so a game page can A/B the field without
      // an editor open. Rebuilds the tile if the blade or the tile changed.
      syncGrass: () => syncGrassUniforms(),
      get grassRings() { return grassRings; },
      get grassTintRT() { return grassTintRT; },
      get cliffGrassRings() { return cliffGrassRings; },
      cliffPaintMask,
      snowSystem,
      get susukiSystem() { return susukiSystem; },
      get flowerSystem() { return flowerSystem; },
      decalSystem,
      decalEditor,
      get foliageScatter() { return foliageScatter; },
      foliageDensity,
      foliageScatterState,
      foliageScatterBrush,
      ensureFoliageScatterBuilt,
      syncFoliageScatterUniforms,
      // The tall-plant field's state and its sync, beside the ground foliage's.
      // Every sibling state is already here; leaving this one out just meant
      // bamboo and palms could not be tuned from the console like the rest.
      susukiState,
      syncSusukiUniforms,
      get waterfallSystem() { return waterfallSystem; },
      get waterfallEditor() { return waterfallEditor; },
      flowerDensity,
      flowerState,
      renderer,
      terrainNormals,
      grassTerrainData,
      splatMap,
      textureLib,
      treeEnv,
      splatOverlay,
      lod,
      playMode,
      tunnelSystem,
      pickInView,
      getSceneOutliner: () => sceneOutliner,
      frameSelection: () => frameSelection(),
      spawnSystem,
      getRoadSystem: () => roadSystem,
      roadHistory,
      lakeHistory,
      refreshWidgets,
      laneRoad: laneRoadSystem,
      props: { propStore, propInstancer, propSys, solidCollider, cliffBvh, addPrimitive, addCliff, addRock, getRockKitNames: () => ROCK_KIT.map((k) => k.name), activatePropSelection, deactivatePropSelection, rebakePlayerBvh, tc, getLivePropManager: () => livePropManager, propSlots, propTextureLibrary, addLiveProp, importPropGlb, importPropLod, importGlbCollectible },
      // Project save/load, and the imported files a project carries.
      saveProject,
      loadProjectFromBuffer,
      projectAssets,
      get worldEnv() { return worldEnv; },
      worldToolState,
      sculpt,
      ensureCpuHeightmapFromGpu,
      markHeightmapDirty,
      camera,
      paintSys,
      heightmapFiles: { buildExport: buildHeightmapExport, importFile: importHeightmapFormat },
      sculptFilterState,
      paintFilterState: paintState.filter,
      grassTintScene,
      grassFarShading,
      grassPush,
      grassTintCam,
      forceGrassTintBake() {
        const prevRT = renderer.getRenderTarget();
        renderer.setRenderTarget(grassTintRT);
        renderer.render(grassTintScene, grassTintCam);
        renderer.setRenderTarget(prevRT);
      },
      get grassRings() { return grassRings; },
      get cliffGrassRings() { return cliffGrassRings; },
      get grassState() { return grassState; },
      get revoGrassState() { return revoGrassState; },
      /**
       * Which grass system is actually drawing, and what the revo tile holds.
       *   __V3_DEBUG.grassSystem()
       * The live instance count is NOT readable: it lives in an indirect
       * buffer the GPU writes, and reading a storage buffer back hands you the
       * stale CPU copy. Triangles from renderer.info are the honest measure.
       */
      grassSystem() {
        return {
          system: grassState.system,
          hybrid: { built: !!grassRings, rings: grassRings?.length ?? 0,
            enabled: grassRings?.filter((r) => r.group.visible).length ?? 0 },
          revo: revoGrass ? {
            built: true,
            enabled: revoGrass.enabled,
            visible: revoGrass.group.visible,
            blades: revoGrass.config.count,
            tileSize: revoGrass.config.tileSize,
            segments: revoGrass.config.segments,
            trianglesPerBlade: revoGrass.mesh ? revoGrass.mesh.geometry.index.count / 3 : 0,
          } : { built: false },
          painted: grassTerrainData.hasGrassData,
        };
      },
      /** Switch grass systems from the console: "hybrid" | "revo". */
      grassSystemSet(which) {
        grassState.system = which === "revo" ? "revo" : "hybrid";
        syncGrassSystemUi();
        if (grassState.system === "revo") void ensureRevoGrassBuilt();
        else void ensureGrassBuilt();
        syncGrassUniforms();
        return grassState.system;
      },
      renderer,
    };
  }

  // ── App handle ─────────────────────────────────────────────────────────────
  // What a game project holds after startV3App(). The editor is just the first
  // caller; a game (games/rts-v3/…) imports this same boot, gets this handle,
  // loads its own .v3proj through loadProjectFromUrl, and builds gameplay on top.
  return {
    /**
     * Bend grass away from a world point this frame (a car, an NPC, a horse).
     * Call every frame the object should push; it leaves a trail that springs
     * back over the grass panel's Trail recovery. The play-mode pawn is
     * stamped automatically. radius in metres, strength 0..1; dirX/dirZ =
     * the way the object is moving (grass leans along it), 0,0 when still.
     */
    stampGrassPush: (x, z, radius, strength = 1, dirX = 0, dirZ = 0) => grassPush.stamp(x, z, radius, strength, dirX, dirZ),
    /** Pull in the editor's default PBR palette. A game that boots with
     *  `preloadPaintTextures: false` calls this when terrain first turns on,
     *  so the 104 MB belongs to the mode that wants it. */
    loadPaintDefaults,
    scene,
    camera,
    controls,
    renderer,
    playMode,
    propStore,
    roadSystem,
    splineSystem: splineSys,
    lakeSystem,
    treeEnv,
    // Full-world restore (terrain + splat + snow + trees + props + roads + lakes).
    loadProjectFromUrl,
    loadProjectFromBuffer,
    setEditorMode,

    // Player start saved with the project — { x, y, z, yaw } or null. A game can
    // read it to drop its own camera/units in where the level designer intended.
    getSpawnPoint: () => spawnSystem.getSpawn(),

    /**
     * Collectibles gameplay hook.
     *   app.collectibles.onPickup((kind, instIdx, position, kindCount) => { ... })
     *   app.collectibles.getCounts()  → { coin: 3, heart: 1 }
     */
    collectibles: {
      onPickup: (cb) => collectibleRuntime?.onPickup(cb),
      offPickup: (cb) => collectibleRuntime?.offPickup(cb),
      getCounts: () => collectibleRuntime?.getCountsByKind() ?? {},
      getTotal: () => collectibleRuntime?.getCollectedCount() ?? 0,
      /** How hard collectibles blaze into the selective-bloom buffer (needs Post FX on). */
      getBloom: () => collectibleUniforms.bloom.value,
      setBloom: (v) => { collectibleUniforms.bloom.value = v; },
    },

    // ── Terrain visibility ────────────────────────────────────────────────────
    /**
     * Hide the ground entirely — for a game whose level is in the sky, and as
     * the cleanest perf baseline there is.
     *
     * WHAT THIS COSTS AND WHY IT IS WORTH A SWITCH. The clipmap is ONE draw with
     * `frustumCulled = false`, so it is submitted every frame wherever the camera
     * looks, and the terrain frame is fragment-bound (see the render-scale note
     * at the top of this file — one render pass is ~93% of it). Hiding the mesh
     * therefore removes almost the whole cost, and it removes the part that does
     * not scale with the game's own content: a game measuring its own systems is
     * otherwise reading them through a constant terrain-shaped offset.
     *
     * Toggling a MESH is safe to do live. Toggling a LIGHT is not — three hashes
     * the scene's light set into every material's shader cache key, so hiding one
     * rebuilds every material in the world. Nothing like that happens here; this
     * is a visibility flag and a grass gate, and it recompiles nothing.
     *
     * NOT COVERED: trees and water. Their renderers have no single visibility
     * switch to flip, and a game flying above a flat, empty world has neither.
     * Load a treed world with the terrain hidden and the trees will hang in the
     * air — hide them at the source (empty tree store) rather than expecting
     * this to do it.
     *
     * COLLISION IS THE CALLER'S JOB. getWorldHeight keeps answering — the CPU
     * heightmap is still there and this is a render switch. A game that wants
     * the ground to stop being solid has to stop feeding that sampler to its
     * physics; both of modularRoadGround's terrain hooks already treat a
     * non-finite height as "no terrain here", so returning NaN is the way.
     */
    terrain: {
      get visible() { return _terrainVisible; },
      setVisible(on) {
        _terrainVisible = !!on;
        lod.group.visible = _terrainVisible;
      },
    },

    // ── Terrain modification ──────────────────────────────────────────────────
    /**
     * Flatten a circular area to `targetY` (world metres) — the engine-side
     * capability a game needs to seat buildings on uneven ground. Drives the
     * editor's own GPU flatten brush, then re-syncs the CPU heightmap mirror so
     * getWorldHeight / getWorldNormal (and therefore the game's nav grid) see
     * the new terrain immediately.
     *
     * Async: it awaits the GPU→CPU readback. Rebuild any nav grid AFTER this.
     */
    async flattenArea(wx, wz, radius, targetY, { strength = 1, falloff = 3, passes = 8 } = {}) {
      const u = (wx + WORLD_SIZE / 2) / WORLD_SIZE;
      const v = (wz + WORLD_SIZE / 2) / WORLD_SIZE;

      const prev = {
        r: sculpt.uRadius.value,
        s: sculpt.uStrength.value,
        f: sculpt.uFalloff.value,
        t: sculpt.uFlattenTarget.value,
      };
      sculpt.uRadius.value        = radius / WORLD_SIZE;
      sculpt.uStrength.value      = strength;
      sculpt.uFalloff.value       = falloff;
      sculpt.uFlattenTarget.value = THREE.MathUtils.clamp(targetY / MAX_HEIGHT, 0, 1);

      // The brush BLENDS toward the target, so one stamp only partially levels
      // the ground — repeat stamps converge on a true plateau.
      sculpt.beginStroke();
      for (let i = 0; i < passes; i++) sculpt.flatten(u, v);
      sculpt.endStroke();

      sculpt.uRadius.value        = prev.r;
      sculpt.uStrength.value      = prev.s;
      sculpt.uFalloff.value       = prev.f;
      sculpt.uFlattenTarget.value = prev.t;

      markHeightmapDirty();
      await ensureCpuHeightmapFromGpu();
    },

    // Resolves once the world stashed across a terrain-size reload has been
    // imported (immediately when there is none). Await before reading heights.
    pendingWorldImport,

    /**
     * Re-sync the CPU heightmap mirror from the GPU. Rivers/lakes carve the
     * terrain AFTER a project's own height sync, so a game should await this
     * before re-seating objects on freshly loaded ground.
     */
    refreshWorldHeights: ensureCpuHeightmapFromGpu,

    // ── Post-FX override ──────────────────────────────────────────────────────
    // A game owns its own look, so it must be able to turn post-FX on and tune
    // it regardless of what the editor happened to have set. Note `.v3proj` does
    // NOT store post-FX state, and postFx.enabled defaults to FALSE — so without
    // this a game gets no bloom no matter what its materials do.
    //
    // v3 bloom is SELECTIVE: only the emissive MRT buffer blooms, so a material
    // must write `mrtNode` to glow (see games/rts-v3/bloom.js).
    postFx: {
      get state() { return worldToolState.postFx; },
      setEnabled(on) {
        worldToolState.postFx.enabled = !!on;
        worldEnv?.applyPostFxState();
      },
      setBloom(params = {}) {
        Object.assign(worldToolState.postFx.bloom, params);
        worldEnv?.applyPostFxState();
      },
      /** Only emissive-MRT materials bloom when true (the v3 default). */
      /**
       * Night-vision response (Purkinje shift). `{ enabled }` rebuilds the display chain,
       * so set it once; drive `{ amount }` per frame.
       */
      setPurkinje(o) { worldEnv?.setPurkinje?.(o); },
      setBloomSelective(on) {
        worldEnv?.postFxPipeline?.setBloomSelective(!!on);
      },
      /** `(colorNode) => colorNode` — applied to scene beauty before bloom (FoW). */
      setSceneColorModifier(fn) {
        worldEnv?.postFxPipeline?.setSceneColorModifier(fn);
      },
      /** Re-apply `state` after editing its fields directly (e.g. a dev panel). */
      apply() { worldEnv?.applyPostFxState(); },
    },

    // ── ENVIRONMENT ───────────────────────────────────────────────────────────
    // The environment is optional and replaceable, piece by piece:
    //   - none at all: startV3App({ environment: false }) — no sky, lights,
    //     shadows, fog, ocean, clouds, post FX or lens flare are built; the game
    //     adds its own lights and calls setLightDirection so vegetation and
    //     water are lit from the right side;
    //   - the default, as is (the editor's look, or the level's with worldLook);
    //   - the default with pieces swapped: sky.setVisible(false) + envSky.set()
    //     for a game sky, clouds.setSystem() for game clouds, ocean.set({
    //     enabled: false }) for a game ocean, fog/postFx/lensFlare/light/shadows
    //     to tune or turn off the rest.
    environment: {
      /** False when booted with `environment: false`. */
      get enabled() { return !!worldEnv; },
      /**
       * The direction the scene is lit FROM (towards the light), used by grass,
       * susuki, trees, foliage, snow and water. Pass null to hand it back to the
       * environment. Needed with `environment: false`; with the default
       * environment it overrides its sun for those systems.
       */
      setLightDirection(dir) {
        _gameLightDir = dir ? new THREE.Vector3().copy(dir).normalize() : null;
        syncGrassUniforms();
      },
      getLightDirection: () => getLightDir(),
      sky: {
        /** Hide the engine's sky dome (a game draws its own). Lighting and IBL keep running. */
        setVisible(on) { worldEnv?.setSkyVisible(!!on); },
        get visible() { return worldEnv?.skyVisible ?? false; },
      },
      ocean: {
        get state() { return worldToolState.worldOcean; },
        /** The live V2 ocean (createWorldOceanV2 handle), or null until V2 is selected. */
        get v2() { return worldEnv?.getOceanV2?.() ?? null; },
        /** e.g. { enabled: false } for a game with its own water, or { seaLevel: 12 }. */
        set(params = {}) {
          Object.assign(worldToolState.worldOcean, params);
          worldEnv?.worldOceanChanged();
        },
      },
    },
    // ── Game-owned cloud system ───────────────────────────────────────────────
    // A game can render its own volumetric clouds instead of the editor's deck. The
    // editor's `dayNightCloudLayer` is untouched and still runs when nothing is
    // registered here. See worldEnvironment.setCustomCloudSystem for the contract.
    clouds: {
      setSystem(system) { worldEnv?.setCustomCloudSystem(system); },
    },
    // A game can also own the SKY, in which case the IBL must be baked from that sky
    // and not the engine's dome — otherwise the world reflects one sky while standing
    // under another, which shows up first on wet and metallic surfaces. Contract:
    // `{ mesh, setSunDiscScale? }`, or null to hand the environment back.
    envSky: {
      set(sky) { worldEnv?.setCustomEnvSky(sky); },
      /** The engine invalidates on ITS sky's params; a custom sky says when its own
       *  look moved (time of day, weather). */
      invalidate() { worldEnv?.invalidateProcEnv(); },
    },
    // A game can own the LENS FLARE too. Its look is one thing; the important half is
    // OCCLUSION — the flare system has none of its own, and the code that draws the
    // occluders (clouds, terrain, a race track) is the only code that can answer cheaply.
    lensFlare: {
      /** Live params object — same shape as the editor World panel exposes. */
      params() { return worldEnv?.lensFlareParams?.() ?? null; },
      /** 0 = sun fully blocked, 1 = clear line of sight. Drive this per frame. */
      setOcclusion(v) { worldEnv?.setLensFlareOcclusion?.(v); },
      /** Source diameter relative to the flare's authoring reference (1 = default). */
      setSourceScale(v) { worldEnv?.setLensFlareSourceScale?.(v); },
      /**
       * The source's LINEAR colour — the sun seen through the current air mass. A game with
       * its own sky already computes this; handing it over is what makes the flare follow
       * the atmosphere into sunset instead of staying the one colour it was authored with.
       * Understood by lensFlare2 only; a no-op on the original system.
       */
      setSourceColor(c) { worldEnv?.setLensFlareSourceColor?.(c); },
    },
    // ── Shadow override ───────────────────────────────────────────────────────
    // CSM lives in worldToolState.csm and is NOT stored in .v3proj, so a game
    // can own it. Every shadow caster is re-drawn once per cascade per frame —
    // a game with a constrained camera (RTS top-down) cuts draw calls by
    // lowering the cascade count, but that is a BOOT option:
    // startV3App({ csm: { cascades: 2 } }). Changing `cascades`/`fade` live is
    // broken on three r184 (the old CSMShadowNode's compiled pipeline keeps
    // re-adding its cascade lights every frame while the new node never
    // compiles), so set() refuses them. mapSize/maxFar/lightMargin/shadowRadius
    // go through live-safe paths (syncCascadeShadowSettings/updateFrustums).
    shadows: {
      get state() { return worldToolState.csm; },
      set(params = {}) {
        const { cascades, fade, ...rest } = params;
        if (cascades !== undefined || fade !== undefined) {
          console.warn(
            "[V3] shadows.set: `cascades`/`fade` cannot change at runtime — " +
            "pass startV3App({ csm: { ... } }) at boot instead.",
          );
        }
        Object.assign(worldToolState.csm, rest);
        worldEnv?.syncCsm();
      },
      setEnabled(on) { worldEnv?.setCsmEnabled(!!on); },
      /** The cascaded shadow node (null without an environment). Rebuilt when cascades change — read it live, don't keep it. */
      get csm() { return worldEnv?.getCsm?.() ?? null; },
    },
    // ── WORLD LIGHTING ────────────────────────────────────────────────────────
    // NOT stored in the .v3proj. Check encodeProjectFile's manifest: it carries
    // terrain, heightmap, splat, snow, trees, props, roads, lakes, rivers and
    // spawn — and no lighting whatsoever. So whatever a level author sets up in
    // the editor's World tab dies with the tab, and every game boots on engine
    // defaults until it says otherwise. This is how a game says otherwise.
    //
    // Mutating these objects is ENOUGH for almost everything: worldEnvironment
    // re-reads them each frame through a snapshot dirty-check (`lightSnap` /
    // `procSnap` in updateFrame), so there is no sync call to forget. Exposure
    // included — `renderer.toneMappingExposure` is written from `light.exposure`
    // inside updateSunSky.
    light: {
      get state() { return worldToolState.light; },
      /** e.g. { exposure: 1.2, dirIntensity: 2.6, hemiIntensity: 0.5 } */
      set(params = {}) { Object.assign(worldToolState.light, params); },
      /** The sun (a DirectionalLight that is the moon at night), or null without an environment. */
      get sun() { return worldEnv?.sun ?? null; },
      /** The ambient HemisphereLight, or null without an environment. */
      get hemi() { return worldEnv?.hemi ?? null; },
      /** Direction TOWARDS the light that lights the scene now (the moon at night). */
      getDirection: () => getLightDir(),
    },
    // ── SKY ───────────────────────────────────────────────────────────────────
    // Sun and sky are ONE system, not two: setTimeOfDay computes the sun's
    // astronomical position (latitude + day-of-year + hour angle) and WRITES
    // light.sunAzimuth/sunElevation from it. Setting a sun angle by hand works,
    // but the next setTimeOfDay call overwrites it — so time of day is the
    // master control and the angles are its output.
    sky: {
      get state() { return worldToolState.proceduralSky; },
      set(params = {}) { Object.assign(worldToolState.proceduralSky, params); },
      /** Hours, 0–24. Drives the sun angles AND the scattering. */
      setTimeOfDay(t) { worldEnv?.setTimeOfDay(t); },
    },
    // ── Fog override ──────────────────────────────────────────────────────────
    // Height + distance fog live in worldToolState.fog and sync to scene.fogNode.
    // Valley mode matches three.js webgpu_custom_fog (world-Y band + distance haze).
    fog: {
      get state() { return worldToolState.fog; },
      sync() {
        worldEnv?.syncFog();
        worldEnv?.driveFogSun();
      },
      setHeight(params = {}) {
        Object.assign(worldToolState.fog.height, params);
        worldEnv?.syncFog();
      },
      setDistance(params = {}) {
        Object.assign(worldToolState.fog.distance, params);
        worldEnv?.syncFog();
        worldEnv?.driveFogSun();
      },
    },
    // ── Terrain queries a game builds on ──────────────────────────────────────
    // Ground height at a world X/Z (RTS unit clamping, building placement).
    getWorldHeight,
    /**
     * Retune the STONE — rock props and the terrain's cliff layer together.
     *
     * They share one recipe (rockShading.js) on purpose, so a boulder standing
     * against a terrain cliff reads as the same rock. That also means there is
     * exactly one place to change it, and this is it.
     *
     * Every value defaults to "leave it alone", so a project that never calls
     * this looks exactly as it always did — which matters because the editor's
     * kit was authored against the painted cool grey and other games use it.
     * A game that wants different stone asks for it at boot; nothing is saved.
     *
     * @param o.tint       multiplies the whole stone (hex or THREE.Color)
     * @param o.moss       0 = bare rock, ~0.5 = jungle
     * @param o.mossColor  what the moss is
     * @param o.mossScale  size of a moss patch, 1/m
     * @param o.bottomTint what the base of a rock fades toward
     */
    setRockPalette({ tint, moss, mossColor, mossScale, bottomTint } = {}) {
      const u = rockShadeUniforms;
      if (tint != null) u.uTint.value.set(tint);
      if (Number.isFinite(moss)) u.uMoss.value = moss;
      if (mossColor != null) u.uMossColor.value.set(mossColor);
      if (Number.isFinite(mossScale)) u.uMossScale.value = mossScale;
      if (bottomTint != null) u.uBottomTint.value.set(bottomTint);
      return true;
    },
    /**
     * Texture everything steeper than `startDeg` with a paint layer — the
     * "ground too steep to walk on should LOOK too steep to walk on" rule.
     *
     * A game that blocks movement past some slope has a legibility problem the
     * terrain art cannot solve on its own: a player sees a green hillside,
     * orders men up it, and they refuse, with nothing on screen to say why.
     * Handing the game the same number its pathfinder uses closes that, and
     * closes it permanently — the two cannot drift apart if there is only one
     * of them.
     *
     * IT OVERRIDES THE PAINT, and it has to. The editor's auto-paint
     * redistributes only the UNPAINTED remainder, so on a map somebody has
     * finished painting it changes nothing — measured on nam-valley, whose
     * steep river banks are hand-painted sand and stayed sand. A legibility
     * rule a player can only half-trust is worse than none, so past `endDeg`
     * the cliff layer takes the pixel outright.
     *
     * The band below `endDeg` is a WARNING, not a boundary: rock fading in
     * over a few degrees reads as "the worse this gets the less you want to be
     * here", where a hard edge would read as a contour line drawn on the hill.
     * `noise` meanders the threshold so it never traces one.
     *
     * @param o.layer     paint layer index (0..6) to use as the cliff
     * @param o.startDeg  where rock begins to show
     * @param o.endDeg    where it is solid rock — put the pathfinder's limit HERE
     * @param o.strength  0..1, how completely rock wins past the band
     * @param o.noise     0..1 threshold breakup, so the band is not a contour line
     */
    setSlopeCliffRule({
      enabled = true, layer = 5, startDeg = 30, endDeg = 34,
      strength = 1, noise = 0.25,
    } = {}) {
      const A = splatOverlay?.auto;
      if (!A) return false;
      A.uAutoCliff.value = layer;
      A.uAutoSlopeHiY.value = Math.cos(startDeg * Math.PI / 180);
      A.uAutoSlopeLoY.value = Math.cos(endDeg * Math.PI / 180);
      A.uAutoNoise.value = noise;
      A.uSlopeLock.value = enabled ? Math.max(0, Math.min(1, strength)) : 0;
      return true;
    },
    /**
     * How dense the painted GROUND FOLIAGE is at a world X/Z, 0..1.
     *
     * The companion to getWorldHeight for anything that needs to know what the
     * ground is COVERED IN rather than how high it is: a stealth or cover rule
     * that asks "is this unit in the jungle", a spawner that will not drop a
     * crate inside a thicket, an ambient system that wants insect noise only
     * under canopy. All of those otherwise end up re-deriving the answer from
     * whatever proxy they can reach, and drifting apart from the paint.
     *
     * Synchronous, because the paint lives on the CPU (see sampleAt) — a
     * fixed-step simulation cannot wait on a GPU readback.
     */
    sampleFoliageDensity: (x, z) => foliageDensity.sampleAt(x, z, WORLD_SIZE),
    /**
     * The same, for the TALL-PLANT field (susuki, elephant grass) — the other
     * thing on this terrain a standing man can disappear into. Its three types
     * live in R/G/B of one 512 map, so the strongest channel is the answer for
     * the same reason it is above.
     */
    sampleTallPlantDensity: (x, z) => {
      const tex = grassTerrainData?.susukiDensityTex;
      if (!tex) return 0;
      const res = grassTerrainData.densityRes;
      const half = WORLD_SIZE * 0.5;
      const px = Math.floor(((x + half) / WORLD_SIZE) * res);
      const pz = Math.floor(((z + half) / WORLD_SIZE) * res);
      if (px < 0 || pz < 0 || px >= res || pz >= res) return 0;
      const i = (pz * res + px) * 4;
      const d = tex.image.data;
      return Math.max(d[i], d[i + 1], d[i + 2]) / 255;
    },
    // GPU-side counterpart of getWorldHeight: the live heightmap as a TSL texture
    // node, for shaders that must drape geometry over the terrain in the vertex
    // stage instead of paying a CPU sample per vertex (RTS selection rings).
    // sculptBrush swaps its .value to the active ping-pong RT, so anything that
    // captured the NODE keeps reading live heights while the terrain is edited.
    heightTexNode,
    // ...and the decode that goes with it: world height = texel.r * maxHeight,
    // at uv = worldXZ / worldSize + 0.5. A shader handed the node without these
    // has to guess the scale, which is how two views of one terrain drift apart.
    maxHeight: MAX_HEIGHT,
    // Surface normal at a world X/Z — slope for nav walkability, unit tilt.
    // (Returns a shared vector; read its components immediately, don't retain.)
    getWorldNormal: (wx, wz) => sampleTerrainNormal(wx, wz),
    // Water surface height (world Y) at an X/Z from the global ocean, any lake
    // covering that point, and River v2 channels (their solved surface at that
    // point), or -Infinity if dry. Used to block ground units from entering
    // water and to keep air units above the surface.
    getWaterLevelAt: (wx, wz) => waterLevelAt(wx, wz),
    /**
     * River v2 centrelines, for gameplay that needs the whole channel rather
     * than a point query (nav grids, minimaps): one entry per river,
     * `{ count, x, z, width, level }` — per-station arrays, metres, read-only.
     */
    getRiverChannels: () => (riverV2System?.rivers ?? [])
      .map((r) => r.solved)
      .filter((s) => s && s.count >= 2)
      .map((s) => ({ count: s.count, x: s.x, z: s.z, width: s.width, level: s.level })),
    /**
     * A LIVE prop's own bounds, before its instance transform — the footprint
     * of a procedural object (a bridge deck, a fence run). Static prop types
     * carry `mergedBox`; live ones are built per instance, so this is where
     * theirs lives. Null when the instance has no group (a collectible, or one
     * not built yet). Read-only.
     * @param {number} instIdx index into propStore.instances
     */
    getLivePropLocalBox: (instIdx) => livePropManager?.localBoxFor?.(instIdx) ?? null,
    // Screen pixel → { point: Vector3 } on the terrain (mouse move-orders,
    // box-select, building ghost). Returns null when the ray misses the ground.
    pickWorldAtClient,
    worldSize: WORLD_SIZE,
    /** All terrain LOD meshes — games use this to bind world-space shaders (FoW, etc.). */
    getTerrainMeshes: getTerrainMeshesForWorld,
    /** Run a callback immediately before the main render pass (same dt as the engine loop). */
    addPreRenderHook(fn) {
      if (typeof fn === "function" && !_preRenderHooks.includes(fn)) _preRenderHooks.push(fn);
    },
    removePreRenderHook(fn) {
      const i = _preRenderHooks.indexOf(fn);
      if (i >= 0) _preRenderHooks.splice(i, 1);
    },
  };
}
