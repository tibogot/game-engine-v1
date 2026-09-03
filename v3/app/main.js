import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import Stats from "stats-gl";
import { texture, uniform, float, mix, positionWorld, vec2, vec3, length, smoothstep, mx_noise_float } from "three/tsl";
import { createHeightmapTexture, saveTerrainConfig, legacySplatSize, HEIGHTMAP_SIZE, WORLD_SIZE, MAX_HEIGHT } from "../terrain/heightmapTexture.js";
import { stashPendingHeightmap, takePendingHeightmap } from "../io/pendingLoad.js";
import { STOCHASTIC_ENABLED, toggleStochastic } from "../../v2/core/legacy/stochasticTex.js";
import { createTerrainLOD, LOD_LEVELS } from "../terrain/terrainLOD.js";
import { createSculptBrush } from "../terrain/sculptBrush.js";
import {
  encodeHeightmapFile,
  decodeHeightmapFile,
  downloadBuffer,
  pickHeightmapFile,
} from "../io/heightmapIO.js";
import { DEFAULT_GEN } from "../terrain/proceduralGen.js";
import { createProceduralGenPass } from "../terrain/proceduralGenGpu.js";
import { erodeDroplets, buildErosionKernel, smoothHeights } from "../terrain/globalErosion.js";
import { streamPowerErode, createStreamPowerScratch } from "../terrain/streamPowerErosion.js";
import { initEditorShell } from "../ui/editorShell.js";
import { createEditorCameraController } from "../../v2/app/editorCameraController.js";
import { BRUSH_MASKS, loadMaskPNG } from "../terrain/brushMasks.js";
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
import { getSharedGltfLoader, initGlbLoaderRenderer } from "../../v2/core/foliage/glbLoader.js";
import { PropStore } from "../tools/propStore.js";
import { PropInstancer, MAX_PROP_INSTANCES_PER_MESH } from "../tools/propInstancer.js";
import { PropSystem } from "../tools/propSystem.js";
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
import { SusukiSystem, SUSUKI_DEFAULTS } from "../render/grass/susukiSystem.js";
import { buildSusukiPanel } from "../ui/buildSusukiPanel.js";
import { buildGroundTslPanel, buildMeadowTslSection } from "../ui/buildGroundTslPanel.js";
import {
  createGroundTslBundle,
  GROUND_DEFAULT_PARAMS,
  GROUND_PRESETS,
  applyGroundPresetToParams,
} from "../../v2/core/legacy/chunkGroundTsl.js";
import {
  createMeadowTslBundle,
  MEADOW_DEFAULT_PARAMS,
  MEADOW_PRESETS,
  applyMeadowPresetToParams,
} from "../../v2/core/legacy/chunkMeadowTsl.js";
import { CliffStore } from "../../v2/core/cliffs/cliffStore.js";
import { CliffBvh } from "../../v2/core/cliffs/cliffBvh.js";
import { SolidCollider } from "../physics/solidCollider.js";
import { createColliderGroup } from "../physics/colliderGroup.js";
import { createSplineFeatureColliderStore } from "../physics/splineFeatureCollider.js";
import { createProceduralCliffGeometry, CLIFF_PRESETS } from "../props/proceduralCliff.js";
import { GREYBOX_KIT, buildGreyboxGeometry } from "../props/greyboxKit.js";
import { applyCliffTerrainBlend, createCliffGlbBlendMaterial } from "../props/cliffTerrainBlend.js";
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
import { createFoliageToolState } from "./state/foliageState.js";
import { createFoliageEnvironment } from "./foliageEnvironment.js";
import { buildFoliagePanel } from "../ui/buildFoliagePanel.js";
import { createRiverToolState } from "./state/riverState.js";
import { buildRiverPanels } from "../ui/buildRiverPanel.js";
import { RiverSystem } from "../../v2/tools/river/riverSystem.js";
import { RiverSystemGPU } from "../tools/riverSystemGpu.js";
import { createLakeToolState } from "./state/lakeState.js";
import { buildLakePanel } from "../ui/buildLakePanel.js";
import { LakeSystem } from "../tools/lakeSystem.js";
import { setWaterSsrEnabled } from "../render/water/lakeMaterial.js";
import { createWaterSurfaceMap } from "../render/water/waterSurfaceMap.js";
import { createLakebedShading } from "../render/water/lakebedTsl.js";
import { SmartRoadLabSystem } from "../../v2/tools/smartRoad/smartRoadLabSystem.js";
import { RoadConformSystem } from "../tools/roadConformSystem.js";
import { mergeRoadDrawCalls } from "../tools/roadDrawCallMerge.js";
import { DEFAULT_ROAD_STATE } from "./state/roadState.js";
import { buildRoadPanel } from "../ui/buildRoadPanel.js";
import { buildPlayPhysicsPanel } from "../ui/buildPlayPhysicsPanel.js";
import { buildPlayFlightPanel } from "../ui/buildPlayFlightPanel.js";
import { createFlyHud } from "../ui/flyHud.js";
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
  // ACES filmic, matching v2 + the daynight-sky lab. Without it the renderer
  // defaults to NoToneMapping, so the HDR sky renders uncompressed → too bright
  // and too cyan. renderOutput()/material toneMapped both honor this operator.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  // The foliage material uses castShadowNode (alpha-tested leaf shadows);
  // r184 requires this flag for that path (silences the boot warning too).
  renderer.shadowMap.transmitted = true;
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
  scene.add(tc.getHelper());

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
    const el = document.getElementById("gizmo-space-hint");
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
  const terrainFeatureOverrides = opts.terrainFeatures ?? {};
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

  // ── Procedural ground (v2 groundTsl port) ──────────────────────────────────
  // v2's TSL base-terrain texture: base color + 2 masked noise layers, all
  // uniform-driven. When enabled it replaces the grey tile base UNDER the splat
  // layers, and feeds the same color into the grass tint bake — so blades and
  // ground share one palette (the "full field without more blades" trick).
  const groundTslState = {
    enabled: false,
    ...structuredClone(GROUND_DEFAULT_PARAMS),
    // v3-only extension rules on top of the v2 bundle: slope-band and
    // height-band recolors with noise breakup (Genshin-style cliff/summit
    // color changes without image textures).
    slopeTint:  { enabled: false, color: "#6b6257", startDeg: 32, endDeg: 50 },
    heightTint: { enabled: false, color: "#e8e4da", start: 180, end: 240 },
    bandNoise: 0.25,
  };
  const groundBundle = createGroundTslBundle(groundTslState);
  const uGroundTslOn = uniform(0);
  const gExt = {
    uSlopeOn:    uniform(0),
    uSlopeCol:   uniform(new THREE.Color(groundTslState.slopeTint.color)),
    uSlopeHiY:   uniform(Math.cos((groundTslState.slopeTint.startDeg * Math.PI) / 180)),
    uSlopeLoY:   uniform(Math.cos((groundTslState.slopeTint.endDeg * Math.PI) / 180)),
    uHeightOn:   uniform(0),
    uHeightCol:  uniform(new THREE.Color(groundTslState.heightTint.color)),
    uHeightStart: uniform(groundTslState.heightTint.start),
    uHeightEnd:  uniform(groundTslState.heightTint.end),
    uBandNoise:  uniform(groundTslState.bandNoise),
  };
  const groundProc = {
    /**
     * Procedural ground color at world XZ. When the caller can supply the
     * terrain normal.y and height (metres), the slope/height band rules
     * apply on top — same world-anchored FBM breakup as the auto-paint
     * rules so the bands meander instead of tracing contour lines.
     */
    colorAt: (xz, ny = null, hMet = null) => {
      let col = groundBundle.groundColorAtWorldXZ(xz);
      if (ny && hMet) {
        const bp = xz.mul(float(0.02));
        const breakup = mx_noise_float(vec3(bp.x, bp.y, float(7.7))).mul(gExt.uBandNoise);
        const slopeW = float(1)
          .sub(smoothstep(gExt.uSlopeLoY, gExt.uSlopeHiY, ny.add(breakup.mul(float(0.15)))))
          .mul(gExt.uSlopeOn);
        col = mix(col, gExt.uSlopeCol, slopeW);
        const heightW = smoothstep(gExt.uHeightStart, gExt.uHeightEnd, hMet.add(breakup.mul(float(40))))
          .mul(float(1).sub(slopeW))
          .mul(gExt.uHeightOn);
        col = mix(col, gExt.uHeightCol, heightW);
      }
      return col;
    },
    uOn: uGroundTslOn,
    // Paintable meadow color (mask-gated via splatOverlay.blend meadowColor)
    meadowAt: () => meadowBundle.meadowProc(),
  };
  // ── Meadow (paintable TSL) — v2 chunkMeadowTsl, gated by the splatmap's
  // meadow mask (layer card 8). Painting the mask IS the enable: wherever it's
  // painted, this procedural color blends over the image layers.
  const meadowTslState = structuredClone(MEADOW_DEFAULT_PARAMS);
  const meadowBundle = createMeadowTslBundle(meadowTslState);
  function syncMeadowTsl() {
    meadowBundle.syncFromParams(meadowTslState);
    grassTintDirty = true;
  }

  function syncGroundTsl() {
    groundBundle.syncFromParams(groundTslState);
    uGroundTslOn.value = groundTslState.enabled ? 1 : 0;
    const st = groundTslState.slopeTint, ht = groundTslState.heightTint;
    gExt.uSlopeOn.value  = st.enabled ? 1 : 0;
    gExt.uSlopeCol.value.set(st.color);
    gExt.uSlopeHiY.value = Math.cos((st.startDeg * Math.PI) / 180);
    gExt.uSlopeLoY.value = Math.cos((Math.max(st.endDeg, st.startDeg + 1) * Math.PI) / 180);
    gExt.uHeightOn.value = ht.enabled ? 1 : 0;
    gExt.uHeightCol.value.set(ht.color);
    gExt.uHeightStart.value = ht.start;
    gExt.uHeightEnd.value   = Math.max(ht.end, ht.start + 1);
    gExt.uBandNoise.value   = groundTslState.bandNoise;
    grassTintDirty = true; // re-bake the grass tint from the new ground color
  }

  // Cliff paint mask (v2 parity) — world-XZ brush mask whose R channel forces
  // the terrain look onto cliff surfaces. Shared deps for every cliff blend
  // material (procedural presets, imported GLBs, their LODs).
  const cliffPaintMask = new CliffPaintMask(512);
  const cliffBlendDeps = { heightTexNode, splatOverlay, cliffPaintTex: cliffPaintMask.texture, terrainNormals };

  // ── Water-surface map + lakebed shading ────────────────────────────────────
  // A top-down bake of every water surface's world Y (lakes + River+ ribbons).
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
  const lod = createTerrainLOD(heightTexNode, uCursorUV, sculpt.uRadius, sculpt.maskNode, sculpt.uMaskRotation, splatOverlay, snowSystem.shared, lakebedShading, groundProc, terrainFeatureOverrides, terrainNormals);
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

  // ── Human character + quadruped pawns ─────────────────────────────────────
  const character = createHumanCharacter(scene, renderer);
  const husky = new HuskyOnFoot({
    scene,
    loader: getSharedGltfLoader(),
    modelUrl: "/models/Husky_compressed.glb",
  });
  husky.load();
  const fox = new FoxOnFoot({ scene, loader: getSharedGltfLoader() });
  fox.load();

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
    for (const el of document.querySelectorAll("[data-bvh-debug-toggle]")) {
      el.classList.toggle("checked", bvhDebugUi.enabled);
    }
    for (const el of document.querySelectorAll("[data-bvh-debug-cb]")) {
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
  const playPanel      = document.getElementById("play-panel");
  const playStopBar    = document.getElementById("play-stop-bar");
  const playStopHint   = document.getElementById("play-stop-hint");
  const playImmersiveBtn = document.getElementById("play-immersive-btn");
  const sculptPanel    = document.getElementById("sculpt-panel");
  const paintPanel     = document.getElementById("paint-panel");
  const propsPanel     = document.getElementById("props-panel");
  const splinePanel    = document.getElementById("spline-panel");
  const riverPanel     = document.getElementById("river-panel");
  const river2Panel    = document.getElementById("river2-panel");
  const lakePanel      = document.getElementById("lake-panel");
  const roadPanel      = document.getElementById("road-panel");
  const spawnPanel     = document.getElementById("spawn-panel");
  const playStatPos    = document.getElementById("play-stat-pos");
  const playStatSpeed  = document.getElementById("play-stat-speed");
  const playStatGround = document.getElementById("play-stat-ground");

  const playStatMode   = document.getElementById("play-stat-mode");

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
    uCursorUV,
    character,
    husky,
    fox,
    getCollider: () => onFootCollider,
    getCliffBvh: () => worldCollider,
    getTreeBvh: () => treeBvh,
    getStuntRoadMeshes: () => roadSystem?.getColliderMeshes() ?? [],
    getStuntRoadSolidMeshes: () => [],
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
      syncRiverPanelVisibility();
      syncRiver2PanelVisibility();
      syncLakePanelVisibility();
      syncRoadPanelVisibility();
      syncCliffPaintPanelVisibility();
      syncSpawnPanelVisibility();
      applyRiverModeEffects();
      applyLakeModeEffects();
      applySpawnModeEffects();
      syncEditorOrbitEnabled();
      syncPlayImmersiveButtonLabel();
    },
  });

  const playPhysicsMount = document.getElementById("play-physics-mount");
  const playPhysicsUi = playPhysicsMount
    ? buildPlayPhysicsPanel({
        mount: playPhysicsMount,
        getCapsuleParams: () => playMode.getCapsuleParams(),
        setCapsuleParams: (patch) => playMode.setCapsuleParams(patch),
        resetCapsuleParams: () => playMode.resetCapsuleParams(),
      })
    : null;

  const playFlightMount = document.getElementById("play-flight-mount");
  const playFlightUi = playFlightMount
    ? buildPlayFlightPanel({
        mount: playFlightMount,
        getFlightParams: () => playMode.getFlightParams(),
        setFlightParams: (patch) => playMode.setFlightParams(patch),
        resetFlightParams: () => playMode.resetFlightParams(),
      })
    : null;

  const flyHud = createFlyHud();

  function syncPlayEditorChrome(immersive) {
    const appEl = document.getElementById("app");
    if (immersive) appEl?.classList.add("play-fullscreen");
    else appEl?.classList.remove("play-fullscreen");
  }

  function getPlayImmersive() {
    return document.getElementById("app")?.classList.contains("play-fullscreen") ?? false;
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

  const worldToolState = createWorldToolState();
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
  const treeToolState = createTreeToolState();
  const editorConfig = {
    world: { size: WORLD_SIZE, chunkSize: V2_CONFIG.world.chunkSize },
    lod: { ...V2_CONFIG.lod },
    sculpt: { ...V2_CONFIG.sculpt },
    // Tree leaf render cells = chunkGroup × chunkSize (300 m): fewer, bigger
    // leaf meshes → fewer draw calls, at the cost of coarser per-cell LOD.
    foliageLod: { chunkGroup: 3 },
  };
  const treeEnv = createTreeEnvironment({
    scene,
    renderer,
    config: editorConfig,
    getWorldHeight: (wx, wz) => terrainStoreAdapter.getWorldHeight(wx, wz),
    toolState: treeToolState,
  });
  treeBvh = new TreeBvh(treeEnv.treeStore, (slotIdx) => {
    const s = treeToolState.treeSlots[slotIdx];
    return s ? { radius: s.colliderRadius, height: s.colliderHeight } : null;
  });
  const foliageToolState = createFoliageToolState();
  const foliageEnv = createFoliageEnvironment({
    scene,
    config: editorConfig,
    getWorldHeight: (wx, wz) => terrainStoreAdapter.getWorldHeight(wx, wz),
    toolState: foliageToolState,
  });
  const perf = createPerfState();
  let splineSys = null;
  let splineFeatureStore = null;

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
    heightTexNode: heightTexNode,
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
      renderQuality,
      onRenderScaleChanged: () => applyRenderScale(),
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
    bladeColor: "#0e300e", tipColor: "#00b30c",
    aoBase: 0.25, aoPower: 2,
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
    receiveShadow: true, lodDebug: false,
    lodMidDistance: 40, lodFarDistance: 80, lodMaxDistance: 200, lodMegaMaxDistance: 400,
    lodMidSegments: 3, lodFarSegments: 2, lodMegaSegments: 1,
    lodFarBladeWidth: 0.45, lodMegaBladeWidth: 0.7,
  };

  const grassBrush = { radius: 60, strength: 0.7, falloff: 2.0, erase: false, target: "terrain" };

  // ── Susuki (GoT miscanthus plumes — own paint layer + instanced system) ────
  const susukiState = structuredClone(SUSUKI_DEFAULTS);
  const susukiBrush = { radius: 60, strength: 0.7, falloff: 2.0, erase: false };
  let susukiSystem = null;
  let _susukiBuilding = false;
  let susukiUi = null;
  let groundTslUi = null;
  let meadowTslUi = null;

  let grassRings = null;
  let _grassBuilding = false;
  let _grassRingsEnabled = false;
  let cliffGrassRings = null;   // second ring set, cliffMode — grass on cliff tops
  let _cliffGrassBuilding = false;
  let _cliffRingsEnabled = false;

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
  // left/right swapped on purpose: a straight-down lookAt with up=(0,0,1)
  // mirrors world X in camera space; the swap flips it back so RT u/v match
  // the grass shader's tintUv = worldXZ / WORLD_SIZE + 0.5.
  const grassTintCam = new THREE.OrthographicCamera(
    WORLD_SIZE / 2, -WORLD_SIZE / 2, WORLD_SIZE / 2, -WORLD_SIZE / 2, 0.1, 50,
  );
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
    // Base under the splat: the same procedural ground the terrain shows when
    // groundTsl is enabled, else the plain grey tile — grass tint always
    // matches what the ground actually looks like. The slope/height band
    // rules need normal.y + height, recomputed here from the heightmap (the
    // tint plane is flat — it has no real geometry to read them from).
    const tintUV = positionWorld.xz.div(float(WORLD_SIZE)).add(float(0.5));
    const tintTexel = float(1.0 / HEIGHTMAP_SIZE);
    const thC = texture(heightTexNode, tintUV).r;
    const thL = texture(heightTexNode, vec2(tintUV.x.sub(tintTexel), tintUV.y)).r;
    const thR = texture(heightTexNode, vec2(tintUV.x.add(tintTexel), tintUV.y)).r;
    const thD = texture(heightTexNode, vec2(tintUV.x, tintUV.y.sub(tintTexel))).r;
    const thU = texture(heightTexNode, vec2(tintUV.x, tintUV.y.add(tintTexel))).r;
    const tintFlat = float(2.0 * WORLD_SIZE / (HEIGHTMAP_SIZE * MAX_HEIGHT));
    const tintNy = tintFlat.div(length(vec3(thL.sub(thR), tintFlat, thD.sub(thU))));
    const tintBase = mix(
      uniform(new THREE.Color(0xe6e3e3)),
      groundProc.colorAt(positionWorld.xz, tintNy, thC.mul(float(MAX_HEIGHT))),
      uGroundTslOn,
    );
    // Painted meadow TSL tints the grass exactly like it tints the terrain
    let tintCol = splatOverlay.blend({
      baseColor: tintBase,
      meadowColor: groundProc.meadowAt(),
    }).color;
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
    { key: "Far",     normalMode: "flat", crossed: false,
      tileSize: 800, bladesPerSide: 384,
      bladeWidth: 0.7, segments: 1, bladeHeightMul: 1.2,
      innerR0: 175, innerR1: 215, outerR0: 360, outerR1: 398 },
  ];

  async function _buildGrassRingSet(namePrefix, extraShared) {
    const shared = {
      scene,
      renderer,
      heightTex:        grassTerrainData.grassHeightTex,
      terrainNormalTex: grassTerrainData.terrainNormalTex,
      densityTex:       grassTerrainData.densityTex,
      windTex:          grassWindTex,
      specNoiseTex:     grassSpecNoiseTex,
      tintTex:          grassTintRT.texture,
      worldSize:        WORLD_SIZE,
      gp:               grassState,
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
      syncGrassUniforms();
    } catch (err) {
      console.error("[V3 Cliff Grass] build failed:", err);
    } finally {
      _cliffGrassBuilding = false;
    }
  }

  function syncGrassUniforms() {
    if (!worldEnv) return;
    const sunDir = worldEnv.getEffectiveLightDir();
    if (grassRings) {
      for (const r of grassRings) r.syncFromState(grassState, sunDir);
      syncHybridGrassLod(grassRings, grassState);
    }
    if (cliffGrassRings) {
      for (const r of cliffGrassRings) r.syncFromState(grassState, sunDir);
      syncHybridGrassLod(cliffGrassRings, grassState);
    }
    // Susuki shares the grass wind params — keep it in step with every sync.
    syncSusukiUniforms();
  }

  // ── Susuki build/sync (lazy, like the grass rings) ─────────────────────────
  async function ensureSusukiBuilt() {
    if (susukiSystem || _susukiBuilding) return;
    _susukiBuilding = true;
    try {
      const sys = new SusukiSystem({
        scene,
        renderer,
        heightTex:        grassTerrainData.grassHeightTex,
        terrainNormalTex: grassTerrainData.terrainNormalTex,
        densityTex:       grassTerrainData.susukiDensityTex,
        windTex:          grassWindTex,
        worldSize:        WORLD_SIZE,
        sp:               susukiState,
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
    if (!susukiSystem || !worldEnv) return;
    susukiSystem.syncFromState(susukiState, grassState, worldEnv.getEffectiveLightDir());
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
  const subHydro        = document.getElementById("sub-hydro");
  const subRamp         = document.getElementById("sub-ramp");
  const btnErode        = document.getElementById("btn-erode");
  const btnHydro        = document.getElementById("btn-hydro");
  const btnRamp         = document.getElementById("btn-ramp");
  const btnSmudge       = document.getElementById("btn-smudge");
  const btnContrast     = document.getElementById("btn-contrast");
  const slNoiseOct      = document.getElementById("sl-noise-oct");
  const lblNoiseOct     = document.getElementById("lbl-noise-oct");
  const slThermalSlope  = document.getElementById("sl-thermal-slope");
  const lblThermalSlope = document.getElementById("lbl-thermal-slope");
  const slThermalIter   = document.getElementById("sl-thermal-iter");
  const lblThermalIter  = document.getElementById("lbl-thermal-iter");
  const slHydroStrength = document.getElementById("sl-hydro-strength");
  const lblHydroStrength = document.getElementById("lbl-hydro-strength");
  const slHydroWater    = document.getElementById("sl-hydro-water");
  const lblHydroWater   = document.getElementById("lbl-hydro-water");
  const slHydroIter     = document.getElementById("sl-hydro-iter");
  const lblHydroIter    = document.getElementById("lbl-hydro-iter");
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
  const tbModeButtons   = document.querySelectorAll("#tb-modes .toolbar-btn");
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
  const aptEnabled      = document.getElementById("apt-enabled");
  const aptFlat         = document.getElementById("apt-flat");
  const aptCliff        = document.getElementById("apt-cliff");
  const aptHigh         = document.getElementById("apt-high");
  const aptSlopeStart   = document.getElementById("apt-slope-start");
  const aptSlopeEnd     = document.getElementById("apt-slope-end");
  const aptHighStart    = document.getElementById("apt-high-start");
  const aptHighEnd      = document.getElementById("apt-high-end");
  const aptNoise        = document.getElementById("apt-noise");
  const aptPreview      = document.getElementById("apt-preview");
  const aptBake         = document.getElementById("apt-bake");

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
    btnHydro  .classList.toggle("active", m === "hydro");
    btnRamp   .classList.toggle("active", m === "ramp");
    btnSmudge .classList.toggle("active", m === "smudge");
    btnContrast.classList.toggle("active", m === "contrast");
    // Tool options always track stickyMode so modifier-key overrides don't hide the zone.
    subRaiseLower.style.display = (stickyMode === "raise" || stickyMode === "lower") ? "" : "none";
    subTerrace   .style.display = stickyMode === "terrace" ? "" : "none";
    subNoise     .style.display = stickyMode === "noise"   ? "" : "none";
    subErode     .style.display = stickyMode === "erode"   ? "" : "none";
    subHydro     .style.display = stickyMode === "hydro"   ? "" : "none";
    subRamp      .style.display = stickyMode === "ramp"    ? "" : "none";
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
    document.querySelectorAll(".preset-btn").forEach(b => b.classList.remove("active"));
    applyProceduralTerrain();
  });
  syncGenUI();

  // ── Global hydraulic erosion ─────────────────────────────────────────────
  // CPU droplet sim (v2 port) on the heightmap mirror: readback → erode in
  // metres → pushHeightmapEditsToGpu (undoable via replaceHeightData's stroke).
  const eroIters    = document.getElementById("sl-ero-iters");
  const eroRate     = document.getElementById("sl-ero-rate");
  const eroDeposit  = document.getElementById("sl-ero-deposit");
  const eroEvap     = document.getElementById("sl-ero-evap");
  const eroInertia  = document.getElementById("sl-ero-inertia");
  const eroCapacity = document.getElementById("sl-ero-capacity");
  const eroRadius   = document.getElementById("sl-ero-radius");
  const eroSmooth   = document.getElementById("sl-ero-smooth");
  const btnRunErosion = document.getElementById("btn-run-erosion");

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
    document.getElementById("lbl-ero-iters").textContent    =
      p.iterations >= 1e6 ? (p.iterations / 1e6).toFixed(1) + "M" : Math.round(p.iterations / 1000) + "k";
    document.getElementById("lbl-ero-rate").textContent     = p.erosionRate.toFixed(2);
    document.getElementById("lbl-ero-deposit").textContent  = p.depositionRate.toFixed(2);
    document.getElementById("lbl-ero-evap").textContent     = p.evaporation.toFixed(3);
    document.getElementById("lbl-ero-inertia").textContent  = p.inertia.toFixed(2);
    document.getElementById("lbl-ero-capacity").textContent = p.capacity.toFixed(1);
    document.getElementById("lbl-ero-radius").textContent   = String(p.radius);
    document.getElementById("lbl-ero-smooth").textContent   = String(p.smoothing);
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
  const speIters    = document.getElementById("sl-spe-iters");
  const speStrength = document.getElementById("sl-spe-strength");
  const speUplift   = document.getElementById("sl-spe-uplift");
  const speSmooth   = document.getElementById("sl-spe-smooth");
  const btnRunStreamPower = document.getElementById("btn-run-stream-power");

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
    document.getElementById("lbl-spe-iters").textContent    = String(p.iterations);
    document.getElementById("lbl-spe-strength").textContent = p.strength.toFixed(3);
    document.getElementById("lbl-spe-uplift").textContent   = p.uplift.toFixed(2) + "m";
    document.getElementById("lbl-spe-smooth").textContent   = p.smoothing.toFixed(2);
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
  const riverToolSlice = createRiverToolState();
  const riverEditorToolState = {
    get mode() { return editorMode; },
    river: riverToolSlice.river,
    river2: riverToolSlice.river2,
  };
  let riverSystem = null;
  let river2System = null;
  const lakeToolSlice = createLakeToolState();
  let lakeSystem = null;
  let lakeUi = null;
  // One source of truth for the SSR master, edited from both the lake and River+
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
  let _onLeaveRiverMode = () => {};
  let _onLeaveRiver2Mode = () => {};
  let _onLeaveRoadMode = () => {};
  let _onGizmoDragEnd = () => {};
  let _gizmoTarget = null;

  const grassPanel = document.getElementById("grass-panel");
  const susukiPanel = document.getElementById("susuki-panel");
  const treePanel  = document.getElementById("tree-panel");
  const foliagePanel = document.getElementById("foliage-panel");
  const snowPanel  = document.getElementById("snow-panel");
  const cliffPaintPanel = document.getElementById("cliffpaint-panel");

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

  function syncTreePanelVisibility() {
    treePanel.style.display = (editorMode === "treePaint" && !playMode.active) ? "" : "none";
  }

  function syncFoliagePanelVisibility() {
    foliagePanel.style.display = (editorMode === "foliage" && !playMode.active) ? "" : "none";
  }

  function syncPropsPanelVisibility() {
    propsPanel.style.display = (editorMode === "props" && !playMode.active) ? "" : "none";
  }

  function syncSplinePanelVisibility() {
    splinePanel.style.display = (editorMode === "spline" && !playMode.active) ? "" : "none";
  }

  function syncRiverPanelVisibility() {
    riverPanel.style.display = (editorMode === "river" && !playMode.active) ? "" : "none";
  }

  function syncRiver2PanelVisibility() {
    river2Panel.style.display = (editorMode === "river2" && !playMode.active) ? "" : "none";
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
    if (editorMode !== "river" && !playMode.active) {
      riverSystem?.dragging && (riverSystem.dragging = false);
    }
    if (editorMode !== "river2" && !playMode.active) {
      river2System?.dragging && (river2System.dragging = false);
    }
    if (riverSystem?.handleGroup) {
      riverSystem.handleGroup.visible =
        editorMode === "river" && riverToolSlice.river.showHandles && !playMode.active;
    }
    if (river2System?.handleGroup) {
      river2System.handleGroup.visible =
        editorMode === "river2" && riverToolSlice.river2.showHandles && !playMode.active;
    }
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
    if (editorMode === "river" && m !== "river") _onLeaveRiverMode();
    if (editorMode === "river2" && m !== "river2") _onLeaveRiver2Mode();
    if (editorMode === "lake" && m !== "lake") lakeSystem?.cancelDrag();
    if (editorMode === "road" && m !== "road") _onLeaveRoadMode();
    if (editorMode === "props" && m !== "props") _onLeavePropsMode();
    editorMode = m;
    roadSystem?.setEditActive(m === "road" && !playMode.active);
    if (splineToolState) splineToolState.mode = m;
    for (const btn of tbModeButtons) {
      btn.classList.toggle("active", btn.dataset.mode === m);
    }
    toolsModeSelect.value = m;
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
      sculpt.uRadius.value = susukiBrush.radius / WORLD_SIZE;
      ensureSusukiBuilt();
    } else if (m === "treePaint") {
      sculpt.uRadius.value = treeToolState.brush.radius / WORLD_SIZE;
    } else if (m === "foliage") {
      sculpt.uRadius.value = foliageToolState.brush.radius / WORLD_SIZE;
    } else if (m === "snow") {
      sculpt.uRadius.value = snowBrushState.radius / WORLD_SIZE;
    } else if (m === "cliffPaint") {
      sculpt.uRadius.value = cliffPaintBrush.radius / WORLD_SIZE;
    } else if (m === "spawn") {
      uCursorUV.value.set(-2, -2);
      spawnUi?.refresh();
    } else if (m === "props" || m === "spline" || m === "river" || m === "river2" || m === "road" || m === "lake") {
      uCursorUV.value.set(-2, -2);
      if (m === "river" || m === "river2") void ensureCpuHeightmapFromGpu();
      // Lake creation reads terrain height at the click to pick a water level.
      if (m === "lake") void ensureCpuHeightmapFromGpu().then(() => lakeUi?.refresh());
      if (m === "road") {
        // Fresh CPU mirror → rebase the grade baseline → re-drape the network.
        void ensureCpuHeightmapFromGpu().then(() => {
          roadConform?.rebase();
          roadSystem?.queueRebuild();
        });
      }
    }
    syncSculptPanelVisibility();
    syncPaintPanelVisibility();
    syncSnowPanelVisibility();
    syncCliffPaintPanelVisibility();
    syncGrassPanelVisibility();
    syncSusukiPanelVisibility();
    syncTreePanelVisibility();
    syncFoliagePanelVisibility();
    syncPropsPanelVisibility();
    syncSplinePanelVisibility();
    syncRiverPanelVisibility();
    syncRiver2PanelVisibility();
    syncLakePanelVisibility();
    syncRoadPanelVisibility();
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
    treePanel.style.display = "none";
    foliagePanel.style.display = "none";
    propsPanel.style.display = "none";
    splinePanel.style.display = "none";
    riverPanel.style.display = "none";
    river2Panel.style.display = "none";
    lakePanel.style.display = "none";
    roadPanel.style.display = "none";
    spawnPanel.style.display = "none";
    roadSystem?.setEditActive(false);
    lakeSystem?.setEditActive(false);
    spawnSystem.setVisible(false);
    helpOverlay.classList.remove("visible");
    tbHelp.classList.remove("active");
    syncPlayImmersiveButtonLabel();
  }

  function exitPlay() {
    if (!playMode.active) return;
    snowSystem.setPlayMode(false);
    snowSystem.resetTrail();
    playPhysicsUi?.setVisible(false);
    playFlightUi?.setVisible(false);
    flyHud?.setVisible(false);
    collectibleRuntime?.stop();
    playMode.exit();
    setEditorMode(editorMode, { force: true });  // restore whatever panel was active
  }

  for (const btn of tbModeButtons) {
    btn.addEventListener("click", () => setEditorMode(btn.dataset.mode));
  }
  toolsModeSelect.addEventListener("change", () => setEditorMode(toolsModeSelect.value));

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

  document.getElementById("play-stop-btn").addEventListener("click", () => exitPlay());
  playImmersiveBtn?.addEventListener("click", () => {
    setPlayImmersive(!getPlayImmersive());
  });

  const playBvhDebugToggle = document.getElementById("play-bvh-debug-toggle");
  playBvhDebugToggle?.addEventListener("click", () => {
    setBvhDebugEnabled(!bvhDebugUi.enabled);
  });

  const playCapsuleDebugToggle = document.getElementById("play-capsule-debug-toggle");
  const playColliderDebugLabel = document.getElementById("play-collider-debug-label");
  const playColliderDebugHint = document.getElementById("play-collider-debug-hint");
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
  tbUndo.addEventListener("click", () => { if (sculpt.undo()) onHistoryChange(); });
  tbRedo.addEventListener("click", () => { if (sculpt.redo()) onHistoryChange(); });

  // ── Terrain size: toolbar label, inspector values, New Terrain dialog ──────
  const tbTerrainSize = document.getElementById("tb-terrain-size");
  tbTerrainSize.textContent = `${WORLD_SIZE} m · ${HEIGHTMAP_SIZE}²`;
  document.getElementById("insp-world").textContent = `${WORLD_SIZE} × ${WORLD_SIZE} m`;
  document.getElementById("insp-hmap").textContent  = `${HEIGHTMAP_SIZE} × ${HEIGHTMAP_SIZE}`;
  document.getElementById("insp-splat").textContent =
    `${SPLAT_RES} × ${SPLAT_RES} (${+(WORLD_SIZE / SPLAT_RES).toFixed(3)} m/texel)`;
  document.getElementById("insp-maxh").textContent  = `${MAX_HEIGHT} m`;
  document.getElementById("insp-lod").textContent   = String(LOD_LEVELS);

  const ntOverlay = document.getElementById("terrain-size-overlay");
  const ntWorld   = document.getElementById("nt-world");
  const ntDetail  = document.getElementById("nt-detail");
  const ntSplat   = document.getElementById("nt-splat");
  const ntHeight  = document.getElementById("nt-height");
  const ntSummary = document.getElementById("nt-summary");

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
    return Math.min(4096, Math.max(256, Math.round(Number(ntWorld.value) / Number(ntSplat.value))));
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
      + (sMb >= 100 ? " — large; 0.5 m/texel is usually enough" : "");
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
  document.getElementById("nt-cancel").addEventListener("click", () => {
    ntOverlay.style.display = "none";
  });
  ntOverlay.addEventListener("click", (e) => {
    if (e.target === ntOverlay) ntOverlay.style.display = "none";
  });
  document.getElementById("nt-create").addEventListener("click", () => {
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
      let minH = 0;
      for (let i = 0; i < HEIGHTMAP_SIZE * HEIGHTMAP_SIZE; i++) {
        const r = raw[i * 4];
        const v = isHalf ? THREE.DataUtils.fromHalfFloat(r) : r;
        cpuHeightmap[i] = v;
        if (v < minH) minH = v;
      }
      cpuHeightmapMinY = minH * MAX_HEIGHT;
      grassTerrainData.rebuildFromHeightmap(cpuHeightmap, HEIGHTMAP_SIZE, MAX_HEIGHT, WORLD_SIZE);
      treeEnv.syncTreeHeights();
      foliageEnv.syncFoliageHeights();
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
    grassTerrainData.rebuildFromHeightmap(cpuHeightmap, HEIGHTMAP_SIZE, MAX_HEIGHT, WORLD_SIZE);
    treeEnv.syncTreeHeights();
    foliageEnv.syncFoliageHeights();
  }

  async function ensureCpuHeightmapFromGpu() {
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
      sculpt.uFlattenTarget.value = sampleHeightNormalized(u, v);
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
  let collectibleRuntime = null;
  let collectibleBurst = null;
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
        flyHud.update(playMode.getFlightHudState?.(), dt);

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
            (_mm === "car" || _mm === "stunt") ? 1.2 :
            _mm === "ball" ? 0.5 : 0.3;
        }
        if (_hasLocalSnow) snowSystem.tick(pp.x, pp.z, _snowGrounded, _snowContacts);
        snowSystem.updateSunDir(worldEnv?.getSunDir?.());

        collectibleRuntime?.update(dt, pp, _mm);
      } else {
        if (isPainting && editorMode === "sculpt") {
          const hit = getUV();
          if (hit) applySculptStroke(hit.u, hit.v);
        }
        editorCamera.update(dt);
        lod.update(controls.target);
        if (!editorCamera.flyMode) controls.update();
        if (!editorCamera.flyMode && !controls.enabled) syncEditorOrbitEnabled();
        // Sculpting under the marker must not bury it — re-drape every frame.
        spawnSystem.refreshHeight();
      }

      // Branch gates: the terrain shader skips the splat and snow blocks
      // entirely while their maps are empty. The checks are cached CPU flags —
      // a scan only runs on the first frame after an edit invalidates one.
      splatOverlay.uHasPaint.value = splatMap.hasAnyPaint() ? 1 : 0;
      snowSystem.shared.u.uHasSnow.value = snowMap.hasAnySnow() ? 1 : 0;

      // Re-bake the terrain normal map only when the heightmap actually
      // changed. getHeightVersion() counts every write to the canonical height
      // RT, so sculpting, erosion, undo/redo and project loads all invalidate
      // it without any of them having to know this exists.
      const _hv = sculpt.getHeightVersion();
      if (_hv !== _lastNormalBakeVersion && !_rendererSideWork) {
        _lastNormalBakeVersion = _hv;
        terrainNormals.bake();
      }

      bakeGrassTintIfNeeded();
      waterSurfaceMap.bakeIfNeeded(renderer);
      if (grassRings) {
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
        if (wantGrass !== _grassRingsEnabled) {
          _grassRingsEnabled = wantGrass;
          for (const r of grassRings) r.setEnabled(wantGrass);
        }
        if (wantGrass) {
          const _grassAnchor = playMode.active ? playMode.playerPosition : camera.position;
          for (const r of grassRings) r.update(_grassAnchor, camera);
        }
      }
      if (cliffGrassRings) {
        // Only spend compute when there's both a baked cliff surface and paint.
        const wantCliff = grassTerrainData.hasCliffData && grassTerrainData.hasCliffSurface && _terrainVisible;
        if (wantCliff !== _cliffRingsEnabled) {
          _cliffRingsEnabled = wantCliff;
          for (const r of cliffGrassRings) r.setEnabled(wantCliff);
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
          susukiSystem.update(_susukiAnchor, camera);
        }
      }

      propInstancer.update(camera, propLod);
      livePropManager.update(dt);
      splineSys.update(dt);
      // Cheap poll: rebuilds the spline-object BVHs only when a feature is
      // added, edited, moved or deleted (string-compare on a signature).
      splineFeatureStore?.refresh();
      riverSystem?.update(dt);
      river2System?.update(dt);
      roadSystem?.update();

      tickPerf(perf, now, dt * 1000);
      // The clipmap rings are merged into one mesh, so children.length is always
      // 1 now; report the ring count, which is what this readout meant.
      perf.activeChunks = LOD_LEVELS;
      worldEnv?.updateFrame(dt);
      treeEnv.updateFrame(camera, worldEnv?.getSunDir?.(), now * 0.001);
      foliageEnv.updateFrame(camera, worldEnv?.getSunDir?.(), now * 0.001);
      bvhDebug?.update();
    } catch (err) {
      if (++_loopErrors === 1) console.error("[V3] Frame update error:", err);
    }

    try {
      renderer.setRenderTarget(null);
      for (const hook of _preRenderHooks) hook(dt);
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
    } catch (_) { /* stats overlay must never block the viewport */ }
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
    uCursorUV.value.set(hit ? hit.u : -2, hit ? hit.v : -2);
    updateRampPreview(hit);
    // Throttled readback so the cursor ring stays accurate while hovering.
    const now = performance.now();
    if (now - lastReadbackMs > 150) { lastReadbackMs = now; requestHeightmapReadback(); }
  });

  renderer.domElement.addEventListener("mouseleave", () => {
    uCursorUV.value.set(-2, -2);
    if (isPainting) sculpt.endStroke();
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
    if (isPainting) sculpt.endStroke();
    isPainting = false;
    lastPaintUV = null;
  }

  function onHistoryChange() {
    cancelStroke();
    treeEnv.syncTreeHeights();
    foliageEnv.syncFoliageHeights();
    markHeightmapDirty();
    requestHeightmapReadback();
  }

  window.addEventListener("keydown", e => {
    if (playMode.active) {
      if (e.code === "Escape") {
        if (playMode.wheelOpen || playMode.walking) return;
        exitPlay();
      }
      return;
    }
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;
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
    if (e.code === "KeyF" && !e.ctrlKey && !e.metaKey && !e.altKey && !playMode.active) {
      e.preventDefault();
      setEditorMode(editorMode === "foliage" ? "view" : "foliage");
      return;
    }
    if (e.code === "KeyU" && !e.ctrlKey && !e.metaKey && !e.altKey && !playMode.active) {
      e.preventDefault();
      setEditorMode(editorMode === "susuki" ? "view" : "susuki");
      return;
    }
    if (e.code === "KeyN" && !e.ctrlKey && !e.metaKey && !e.altKey && !playMode.active) {
      e.preventDefault();
      setEditorMode(editorMode === "spawn" ? "view" : "spawn");
      return;
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
    if ((editorMode === "river" || editorMode === "river2") && !playMode.active) {
      if (e.code === "Delete" || e.code === "Backspace") {
        e.preventDefault();
        if (editorMode === "river") riverSystem.deleteSelected();
        else river2System.deleteSelected();
        return;
      }
    }
    // Smart Road shortcuts (v2 Smart Road 2)
    if (editorMode === "road" && !playMode.active && roadSystem) {
      if (e.code === "Delete" || e.code === "Backspace") {
        e.preventDefault();
        if (roadSystem.selectedNodeId !== null) roadSystem.deleteNode(roadSystem.selectedNodeId);
        return;
      }
      if (e.code === "KeyJ" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        if (roadSystem.selectedNodeId !== null) roadSystem.cycleNodeType(roadSystem.selectedNodeId);
        return;
      }
      if (e.code === "KeyB" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        roadSystem.toggleBridge(); // bridge on the last-grabbed edge
        return;
      }
      if (e.code === "Equal" || e.code === "NumpadAdd") {
        e.preventDefault();
        roadSystem.adjustNodeLift(e.shiftKey ? 0.1 : 0.5);
        return;
      }
      if (e.code === "Minus" || e.code === "NumpadSubtract") {
        e.preventDefault();
        roadSystem.adjustNodeLift(e.shiftKey ? -0.1 : -0.5);
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
        if (editorMode === "paint") paintSys.undo();
        else if (editorMode === "snow" && _snowUndoStack.length) {
          _snowRedoStack.push(snowMap.snapshot());
          snowMap.restoreSnapshot(_snowUndoStack.pop());
        }
        else if (editorMode === "props") propSys.undo();
        else if (editorMode === "cliffPaint") cliffPaintSystem.undo();
        else if (editorMode === "treePaint") treeEnv.treeSystem.undo();
        else if (editorMode === "foliage") foliageEnv.paintSystem.undo();
        else if (editorMode === "river" && riverSystem?.undo()) { /* ok */ }
        else if (editorMode === "river2" && river2System?.undo()) { /* ok */ }
        else if (editorMode === "spline" && splineSys?.undo()) { /* ok */ }
        else if (sculpt.undo()) onHistoryChange();
        return;
      }
      if (key === "y" || (key === "z" && e.shiftKey)) {
        e.preventDefault();
        if (editorMode === "paint") paintSys.redo();
        else if (editorMode === "snow" && _snowRedoStack.length) {
          _snowUndoStack.push(snowMap.snapshot());
          snowMap.restoreSnapshot(_snowRedoStack.pop());
        }
        else if (editorMode === "props") propSys.redo();
        else if (editorMode === "cliffPaint") cliffPaintSystem.redo();
        else if (editorMode === "treePaint") treeEnv.treeSystem.redo();
        else if (editorMode === "foliage") foliageEnv.paintSystem.redo();
        else if (editorMode === "river" && riverSystem?.redo()) { /* ok */ }
        else if (editorMode === "river2" && river2System?.redo()) { /* ok */ }
        else if (editorMode === "spline" && splineSys?.redo()) { /* ok */ }
        else if (sculpt.redo()) onHistoryChange();
        return;
      }
    }
  });

  window.addEventListener("keyup", (e) => {
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
  }
  syncTexlibEditor();

  // Fill / Clear buttons
  pbtnFill.addEventListener("click", () => { paintSys.fillWithActiveLayer(); });
  pbtnClear.addEventListener("click", () => { paintSys.clearAll(); });

  // Stochastic (no-tile) sampling toggle — lives in the Paint panel now; the
  // shared module's floating button is suppressed via <body data-stochastic-ui>.
  const ckStochastic = document.getElementById("ck-stochastic");
  ckStochastic.checked = STOCHASTIC_ENABLED;
  ckStochastic.addEventListener("change", () => toggleStochastic());

  // ── Snow panel controls ────────────────────────────────────────────────────
  {
    const slR = document.getElementById("snow-sl-radius");
    const lbR = document.getElementById("snow-lbl-radius");
    const slS = document.getElementById("snow-sl-strength");
    const lbS = document.getElementById("snow-lbl-strength");
    const slF = document.getElementById("snow-sl-falloff");
    const lbF = document.getElementById("snow-lbl-falloff");
    const slB = document.getElementById("snow-sl-base");
    const lbB = document.getElementById("snow-lbl-base");
    const slN = document.getElementById("snow-sl-noise");
    const lbN = document.getElementById("snow-lbl-noise");
    const slG = document.getElementById("snow-sl-groove");
    const lbG = document.getElementById("snow-lbl-groove");
    const slSo = document.getElementById("snow-sl-soft");
    const lbSo = document.getElementById("snow-lbl-soft");
    const slRm = document.getElementById("snow-sl-rim");
    const lbRm = document.getElementById("snow-lbl-rim");
    const slRw = document.getElementById("snow-sl-regrow");
    const lbRw = document.getElementById("snow-lbl-regrow");
    const slGl = document.getElementById("snow-sl-glitter");
    const lbGl = document.getElementById("snow-lbl-glitter");
    const slFq = document.getElementById("snow-sl-freq");
    const lbFq = document.getElementById("snow-lbl-freq");
    const btnFill  = document.getElementById("snow-btn-fill");
    const btnClear = document.getElementById("snow-btn-clear");

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
    const slR = document.getElementById("cliffpaint-sl-radius");
    const lbR = document.getElementById("cliffpaint-lbl-radius");
    const slS = document.getElementById("cliffpaint-sl-strength");
    const lbS = document.getElementById("cliffpaint-lbl-strength");
    const slF = document.getElementById("cliffpaint-sl-falloff");
    const lbF = document.getElementById("cliffpaint-lbl-falloff");
    const btnFill  = document.getElementById("cliffpaint-btn-fill");
    const btnClear = document.getElementById("cliffpaint-btn-clear");

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
    document.getElementById("apt-lbl-slope-start").textContent = p.slopeStartDeg + "°";
    document.getElementById("apt-lbl-slope-end").textContent   = p.slopeEndDeg + "°";
    document.getElementById("apt-lbl-high-start").textContent  = p.highStart + "m";
    document.getElementById("apt-lbl-high-end").textContent    = p.highEnd + "m";
    document.getElementById("apt-lbl-noise").textContent       = Math.round(p.noise * 100) + "%";
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
    const buf = encodeSplatmapFile(splatMap._combined, { resolution: SPLAT_RES });
    const ts  = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    downloadBuffer(buf, `splat-${ts}.v3splat`);
  }

  async function loadSplatmap() {
    const file = await pickSplatmapFile();
    if (!file) return;
    try {
      const decoded = decodeSplatmapFile(await file.arrayBuffer());
      // A splatmap is weights over the whole world, so a resolution difference
      // is a rescale, not an error — importing older/finer maps just works.
      if (decoded.resolution !== SPLAT_RES) {
        console.info(`[V3] Splatmap ${decoded.resolution}² → resampled to ${SPLAT_RES}².`);
        splatMap.setCombinedResampled(decoded.data, decoded.resolution);
      } else {
        splatMap.setCombined(decoded.data);
      }
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

  // ── Cliff grass: paint-target toggle + surface bake + fill/clear ───────────
  const gbtnTargetTerrain = document.getElementById("gbtn-target-terrain");
  const gbtnTargetCliff   = document.getElementById("gbtn-target-cliff");
  const cliffgrassBake    = document.getElementById("cliffgrass-bake");
  const cliffgrassFill    = document.getElementById("cliffgrass-fill");
  const cliffgrassClear   = document.getElementById("cliffgrass-clear");
  const cliffgrassStatus  = document.getElementById("cliffgrass-status");

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

  function setGrassTarget(target) {
    grassBrush.target = target;
    const cliff = target === "cliff";
    gbtnTargetTerrain?.classList.toggle("primary", !cliff);
    gbtnTargetCliff?.classList.toggle("primary", cliff);
    if (cliff) { ensureFreshCliffSurface(); updateCliffGrassStatus(); }
  }
  gbtnTargetTerrain?.addEventListener("click", () => setGrassTarget("terrain"));
  gbtnTargetCliff?.addEventListener("click", () => setGrassTarget("cliff"));

  cliffgrassBake?.addEventListener("click", () => { bakeCliffGrassSurface(); updateCliffGrassStatus(); });
  cliffgrassFill?.addEventListener("click", () => {
    bakeCliffGrassSurface();
    grassTerrainData.fillCliffDensity();
    updateCliffGrassStatus();
  });
  cliffgrassClear?.addEventListener("click", () => {
    if (confirm("Clear all cliff grass?")) grassTerrainData.clearCliffDensity();
    updateCliffGrassStatus();
  });

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
    if (cliffGrassRings) rebuildHybridGrassGeometries(cliffGrassRings, grassState);
  });
  gckCrossed.addEventListener("change", () => {
    grassState.crossed = gckCrossed.checked;
    if (grassRings) rebuildHybridGrassGeometries(grassRings, grassState);
    if (cliffGrassRings) rebuildHybridGrassGeometries(cliffGrassRings, grassState);
  });
  const gslSegments  = document.getElementById("gsl-segments");
  const glblSegments = document.getElementById("glbl-segments");
  const gslTaper     = document.getElementById("gsl-taper");
  const glblTaper    = document.getElementById("glbl-taper");
  const gslClumpSc   = document.getElementById("gsl-clump-scale");
  const glblClumpSc  = document.getElementById("glbl-clump-scale");
  const gslClumpStr  = document.getElementById("gsl-clump-str");
  const glblClumpStr = document.getElementById("glbl-clump-str");

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

  const gslS2TipBias  = document.getElementById("gsl-s2-tipbias");
  const glblS2TipBias = document.getElementById("glbl-s2-tipbias");
  gslS2TipBias.addEventListener("input", () => { grassState.specV2TipBias = Number(gslS2TipBias.value) / 100; glblS2TipBias.textContent = grassState.specV2TipBias.toFixed(2); syncGrassUniforms(); });

  // Spec light directions (V1 sharp / V2 noisy) — X/Y/Z sliders, -1..1
  for (const [sl, key] of [
    ["gsl-s1-dirx", "specV1DirX"], ["gsl-s1-diry", "specV1DirY"], ["gsl-s1-dirz", "specV1DirZ"],
    ["gsl-s2-dirx", "specV2DirX"], ["gsl-s2-diry", "specV2DirY"], ["gsl-s2-dirz", "specV2DirZ"],
  ]) {
    const el  = document.getElementById(sl);
    const lbl = document.getElementById(sl.replace("gsl-", "glbl-"));
    el.addEventListener("input", () => {
      grassState[key] = Number(el.value) / 100;
      lbl.textContent = grassState[key].toFixed(2);
      syncGrassUniforms();
    });
  }

  // Terrain / slope
  const gckSlope    = document.getElementById("gck-slope");
  const gslSlopeMin = document.getElementById("gsl-slope-min");
  const glblSlopeMin= document.getElementById("glbl-slope-min");
  const gslSlopeMax = document.getElementById("gsl-slope-max");
  const glblSlopeMax= document.getElementById("glbl-slope-max");

  gckSlope.addEventListener("change",    () => { grassState.slopeEnabled = gckSlope.checked; syncGrassUniforms(); });
  gslSlopeMin.addEventListener("input",  () => { grassState.slopeMin = Number(gslSlopeMin.value) / 100; glblSlopeMin.textContent = grassState.slopeMin.toFixed(2); syncGrassUniforms(); });
  gslSlopeMax.addEventListener("input",  () => { grassState.slopeMax = Number(gslSlopeMax.value) / 100; glblSlopeMax.textContent = grassState.slopeMax.toFixed(2); syncGrassUniforms(); });

  // Terrain tint (baked splat color, img mode)
  const gckTint      = document.getElementById("gck-tint");
  const gslTintStr   = document.getElementById("gsl-tint-str");
  const glblTintStr  = document.getElementById("glbl-tint-str");
  const gslTintRoot  = document.getElementById("gsl-tint-root");
  const glblTintRoot = document.getElementById("glbl-tint-root");

  gckTint.addEventListener("change", () => {
    grassState.terrainTintEnabled = gckTint.checked;
    grassTintDirty = true; // bake on next frame so the toggle is instant
    syncGrassUniforms();
  });
  gslTintStr.addEventListener("input",  () => { grassState.terrainTintStrength = Number(gslTintStr.value) / 100; glblTintStr.textContent = grassState.terrainTintStrength.toFixed(2); syncGrassUniforms(); });
  gslTintRoot.addEventListener("input", () => { grassState.terrainTintRootBias = Number(gslTintRoot.value) / 100; glblTintRoot.textContent = grassState.terrainTintRootBias.toFixed(2); syncGrassUniforms(); });

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

  gslLodMid.addEventListener("input",  () => { grassState.lodMidDistance = Number(gslLodMid.value); glblLodMid.textContent = gslLodMid.value + "m"; if (grassRings) syncHybridGrassLod(grassRings, grassState); if (cliffGrassRings) syncHybridGrassLod(cliffGrassRings, grassState); });
  gslLodFar.addEventListener("input",  () => { grassState.lodFarDistance = Number(gslLodFar.value); glblLodFar.textContent = gslLodFar.value + "m"; if (grassRings) syncHybridGrassLod(grassRings, grassState); if (cliffGrassRings) syncHybridGrassLod(cliffGrassRings, grassState); });
  gslLodMax.addEventListener("input",  () => { grassState.lodMaxDistance = Number(gslLodMax.value); glblLodMax.textContent = gslLodMax.value + "m"; if (grassRings) syncHybridGrassLod(grassRings, grassState); if (cliffGrassRings) syncHybridGrassLod(cliffGrassRings, grassState); });
  gslLodMega.addEventListener("input", () => { grassState.lodMegaMaxDistance = Number(gslLodMega.value); glblLodMega.textContent = gslLodMega.value + "m"; if (grassRings) syncHybridGrassLod(grassRings, grassState); if (cliffGrassRings) syncHybridGrassLod(cliffGrassRings, grassState); });
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
    const el  = document.getElementById(sl);
    const lbl = document.getElementById(sl.replace("gsl-", "glbl-"));
    el.addEventListener("input", () => {
      grassState[key] = toVal(Number(el.value));
      lbl.textContent = toLabel(grassState[key]);
      if (grassRings) rebuildHybridGrassGeometries(grassRings, grassState);
    if (cliffGrassRings) rebuildHybridGrassGeometries(cliffGrassRings, grassState);
    });
  }

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
    const newMat = createMaterialForLibrary(propMat, { triplanar: !!slot.triplanar });
    if (slot.solid) applyCliffTerrainBlend(newMat, cliffBlendDeps);
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
  // Shared by lakes and by River+'s Depth style — one texture, both surfaces.
  const waterNormalMap = new THREE.TextureLoader().load("/textures/waterNormal.webp");
  waterNormalMap.wrapS = waterNormalMap.wrapT = THREE.RepeatWrapping;
  waterNormalMap.colorSpace = THREE.NoColorSpace;   // it's a normal map, not colour

  riverSystem = new RiverSystem({
    scene,
    toolState: riverEditorToolState,
    getWorldHeight,
  });
  river2System = new RiverSystemGPU({
    scene,
    toolState: riverEditorToolState,
    renderer,
    getRT: () => sculpt.getCurrentRT(),
    heightTexNode,
    cpuHeightmap,
    ensureCpuHeightmap: ensureCpuHeightmapFromGpu,
    waterNormalMap,
    onCarveCommitted: () => {
      markHeightmapDirty();
      requestHeightmapReadback();
      bvhDebug?.update();
    },
    onWaterMeshesChanged: () => waterSurfaceMap.markDirty(),
  });
  worldEnv?.addWaterSurface(river2System);

  // ── Lakes ──────────────────────────────────────────────────────────────────
  // No terrain hookup: the shoreline comes from the depth buffer every frame, so
  // sculpting under a lake needs no invalidation, rebase or rebuild.
  lakeSystem = new LakeSystem({
    scene,
    toolState: lakeToolSlice,
    normalMap: waterNormalMap,
    sampleTerrainHeight,
    worldSize: WORLD_SIZE,
    onChanged: () => waterSurfaceMap.markDirty(),
  });
  worldEnv?.addWaterSurface(lakeSystem);

  // Both water systems exist — the lakebed shading's water-surface map can now
  // see their meshes. Terrain edits change where water meets ground, but the
  // MAP only stores the water surfaces' own Y, so only water edits rebake it.
  waterSurfaceMap.setSourceProvider(() => [
    lakeSystem.group,
    ...river2System.segments.map((s) => s.mesh).filter(Boolean),
  ]);

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
    sculpt.endStroke = (...a) => { const r = _endStroke(...a); river2System.notifyTerrainEdited(); return r; };
    sculpt.undo = (...a) => { const r = _undo(...a); if (r) river2System.notifyTerrainEdited(); return r; };
    sculpt.redo = (...a) => { const r = _redo(...a); if (r) river2System.notifyTerrainEdited(); return r; };
    sculpt.replaceHeightData = (...a) => { const r = _replace(...a); river2System.notifyTerrainEdited(); return r; };
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
    }
    // Flush a pending grade before another tool edits the terrain under us.
    if (_roadGradeTimer) applyRoadGradeNow();
    syncEditorOrbitEnabled();
  };
  // Roads no longer autosave to localStorage — they live in the project file
  // (.v3proj) like every other system, so refresh behaviour is consistent.
  try { localStorage.removeItem("v3.smartRoad.network"); } catch (_) {}

  _onLeaveRiverMode = () => {
    if (riverSystem?.dragging) riverSystem.dragging = false;
    syncEditorOrbitEnabled();
  };
  _onLeaveRiver2Mode = () => {
    if (river2System?.dragging) river2System.dragging = false;
    syncEditorOrbitEnabled();
  };

  const splineChunkStreamStub = { markDirtyRects() {} };
  const splineTreeStoreStub = {
    addTree: (...args) => treeEnv.treeStore.addTree(...args),
    hasTreeNearby: (...args) => treeEnv.treeStore.hasTreeNearby(...args),
    syncAllHeights: () => { treeEnv.syncTreeHeights(); foliageEnv.syncFoliageHeights(); },
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
    const perType = [];
    const typeTotals = new Map();

    for (const inst of propStore.instances) {
      const type = propStore.types[inst.typeIdx];
      if (!type) continue;
      typeTotals.set(inst.typeIdx, (typeTotals.get(inst.typeIdx) ?? 0) + 1);
      if (type.live) {
        if (livePropManager.isInstancedCollectible?.(type.factoryId)) liveInstancedCount++;
        else liveGroupCount++;
      } else {
        staticCount++;
      }
    }

    for (const [typeIdx, count] of typeTotals) {
      const type = propStore.types[typeIdx];
      if (!type || type.live) continue;
      if (count > MAX_PROP_INSTANCES_PER_MESH * 0.85) {
        perType.push({
          name: type.name,
          count,
          atCap: count >= MAX_PROP_INSTANCES_PER_MESH,
        });
      }
    }

    perType.sort((a, b) => b.count - a.count);

    return {
      total: propStore.totalCount,
      staticCount,
      liveGroupCount,
      liveInstancedCount,
      maxPerType: MAX_PROP_INSTANCES_PER_MESH,
      nearCapTypes: perType,
    };
  }

  function refreshPropCount() {
    document.getElementById("props-panel")?._refreshPropStats?.();
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
        propSlots.push({
          name,
          loaded: true,
          typeIdx,
          builtin: false,
          live: false,
          glbFile: file.name,
          materialId: "__embedded__",
        });
        propState.activeSlot = slotIdx;
        document.getElementById("props-panel")?._rebuildPropUi?.();
        resolve(typeIdx);
      }, undefined, (err) => { URL.revokeObjectURL(url); reject(err); });
    });
  }

  /**
   * Import a GLB as a collectible kind. Its submeshes join the GPU collectible field, so every
   * placed copy is drawn by the same handful of instanced calls and picked up by the same runtime
   * as the built-in coin/heart/key.
   */
  async function importGlbCollectible(preselectedFile = null) {
    const handle = (file) => new Promise((resolve, reject) => {
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
          });
          propState.activeSlot = slotIdx;
          document.getElementById("props-panel")?._rebuildPropUi?.();
          console.log(
            `[V3] GLB collectible "${spec.name}" imported — kind "${spec.kind}", `
            + `${spec.parts.length} draw call(s)`,
          );
          resolve(typeIdx);
        } catch (err) { reject(err); }
      }, undefined, (err) => { URL.revokeObjectURL(url); reject(err); });
    });

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

  // Procedural strata cliff — placed/edited like any prop, but the type is
  // flagged `solid` so SolidCollider gives it real-triangle collision and the
  // box-proxy player bake skips it.
  function addCliff(presetName) {
    const preset = CLIFF_PRESETS.find((c) => c.name === presetName);
    if (!preset) return;
    const existing = propSlots.find((s) => s.name === presetName && s.builtin);
    if (existing) {
      propState.activeSlot = propSlots.indexOf(existing);
      document.getElementById("props-panel")?._rebuildPropUi?.();
      return;
    }
    const geometry = createProceduralCliffGeometry(preset.params);
    const defaultPropMat =
      propTextureLibrary.getById("__none__") ?? propTextureLibrary.getByIndex(0);
    const material = createMaterialForLibrary(defaultPropMat, { triplanar: true });
    // Genshin-style terrain integration: painted terrain color on up-facing
    // tops + per-pixel contact band from the GPU heightmap hides the base seam.
    applyCliffTerrainBlend(material, cliffBlendDeps);
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
      materialId: defaultPropMat?.id ?? "__none__",
      triplanar: true,
    });
    propState.activeSlot = slotIdx;
    document.getElementById("props-panel")?._rebuildPropUi?.();
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
      document.getElementById("props-panel")?._rebuildPropUi?.();
      return;
    }
    const geometry = buildGreyboxGeometry(pieceName);
    if (!geometry) return;
    const defaultPropMat =
      propTextureLibrary.getById("__none__") ?? propTextureLibrary.getByIndex(0);
    const material = createMaterialForLibrary(defaultPropMat, { triplanar: false });
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
    document.getElementById("props-panel")?._rebuildPropUi?.();
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
      document.getElementById("props-panel")?._rebuildPropUi?.();
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
    if (preselectedFile) return loadFile(preselectedFile);
    const inp = Object.assign(document.createElement("input"), { type: "file", accept: ".glb,.gltf" });
    inp.onchange = () => { if (inp.files?.[0]) loadFile(inp.files[0]).catch(console.error); };
    inp.click();
  }

  buildTreePanel({
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
    massPlaceTrees: () => treeEnv.treeSystem.massPlace(treeToolState.treePaint.massPlaceCount),
    clearAllTrees: () => treeEnv.treeSystem.clearAll(),
    setBvhDebugEnabled,
    getBvhDebugEnabled: () => bvhDebugUi.enabled,
    syncBvhDebugToggles,
    treeCastShadowChanged: () => treeEnv.setCastShadow(treeToolState.treeLod.castShadow),
  });

  buildFoliagePanel({
    toolState: foliageToolState,
    config: editorConfig,
    loadFoliageTexture: (slotIdx, file) => foliageEnv.loadFoliageTexture(slotIdx, file),
    foliageSlotStructureChanged: (slotIdx) => foliageEnv.slotStructureChanged(slotIdx),
    foliageSlotMaterialChanged: (slotIdx) => foliageEnv.slotMaterialChanged(slotIdx),
    massPlaceFoliage: () => foliageEnv.paintSystem.massPlace(foliageToolState.foliagePaint.massPlaceCount),
    clearAllFoliage: () => foliageEnv.paintSystem.clearAll(),
  });

  buildPropsPanel({
    toolState: { props: propState, propSlots, propLod },
    propTextureLibrary,
    propStore,
    livePropManager,
    importPropGlb,
    addPrimitive,
    addCliff,
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
        if (meta.live) {
          addLiveProp(meta.name);
        } else if (meta.glbFile) {
          const file = await _fetchPropModel(meta.glbFile);
          if (file) {
            const typeIdx = await loadGltfAsType(file);
            if (meta.solid) _applyGlbSolidCliff(typeIdx);
            const slotIdx = propSlots.findIndex((s) => s.typeIdx === typeIdx);
            if (slotIdx >= 0) _applySavedSlotMaterial(slotIdx, meta);
          }
        } else if (meta.builtin && cliffNames.has(meta.name)) {
          addCliff(meta.name);
          _applySavedSlotMaterial(propSlots.length - 1, meta);
        } else if (meta.builtin && kitNames.has(meta.name)) {
          addKitPiece(meta.name);
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

    document.getElementById("props-panel")?._rebuildPropUi?.();
  }

  async function saveProject() {
    await syncHeightmapToCPU();
    // River+ carves the terrain, and its carve profile is derived from the
    // UNCARVED base ground — so the project stores the base heightmap plus the
    // river splines, and the load re-carves. Saving the carved result instead
    // would dig every gorge twice as deep on reload.
    const rivers2 = river2System.exportData();
    const baseHeightmap = rivers2.length ? await river2System.exportBaseHeightmap() : null;
    const treeInstances = [];
    for (const arr of treeEnv.treeStore.chunks.values()) {
      for (const t of arr) treeInstances.push([t.x, t.z, t.y, t.rotY, t.scale, t.slotIdx]);
    }
    const buf = encodeProjectFile({
      terrain:   { worldSize: WORLD_SIZE, heightmapSize: HEIGHTMAP_SIZE, splatSize: SPLAT_RES, maxHeight: MAX_HEIGHT },
      heightmap: baseHeightmap ?? cpuHeightmap,
      splat:     splatMap.combined,
      splatRes:  SPLAT_RES,
      snow:      snowMap.snapshot(),
      snowRes:   SNOW_MAP_RES,
      trees:     { slots: treeToolState.treeSlots, instances: treeInstances },
      foliage:   foliageEnv.exportData(),
      props:     propStore.exportData(propSlots),
      roads:     roadSystem.exportData(),
      splines:   splineSys.exportData(),
      lakes:     lakeSystem.exportData(),
      rivers:    riverSystem.exportData(),
      rivers2,
      spawn:     spawnSystem.exportData(),
      grassDensity:  grassTerrainData.getDensitySnapshot(),
      susukiDensity: grassTerrainData.getSusukiDensitySnapshot(),
      susuki:    { ...susukiState },
      groundTsl: structuredClone(groundTslState),
      meadowTsl: structuredClone(meadowTslState),
    });
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    downloadBuffer(buf, `project-${ts}.v3proj`);
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
        if (s.presetFile) {
          const f = await fetchPreset(s.presetFile);
          if (f) await treeEnv.loadTreePreset(i, f);
        } else if (s.glbFile?.lod0) {
          const f0 = await fetchModel(s.glbFile.lod0);
          if (f0) await treeEnv.importTreeGlb(i, 0, f0);
          if (s.glbFile.lod1) {
            const f1 = await fetchModel(s.glbFile.lod1);
            if (f1) await treeEnv.importTreeGlb(i, 1, f1);
          }
        }
      } catch (err) {
        console.warn(`[V3] Tree slot ${i} asset restore failed:`, err);
      }
    }
  }

  async function applyProjectData(d) {
    // Drop River+'s captured base BEFORE the heightmap swap: the wrapped
    // replaceHeightData would otherwise schedule a rebase that folds the
    // freshly loaded terrain into the previous scene's base.
    river2System.resetForLoad();
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
    }

    if (d.snow && d.snowRes === SNOW_MAP_RES) snowMap.restoreSnapshot(d.snow);

    // Painted grass / susuki density layers (older projects simply lack them)
    if (d.grassDensity?.length === grassTerrainData.densityTex.image.data.length) {
      grassTerrainData.restoreDensitySnapshot(d.grassDensity);
      if (d.grassDensity.some((v) => v > 0)) void ensureGrassBuilt();
    }
    if (d.susuki) Object.assign(susukiState, d.susuki);
    if (d.susukiDensity?.length === grassTerrainData.susukiDensityTex.image.data.length) {
      grassTerrainData.restoreSusukiDensitySnapshot(d.susukiDensity);
    }
    if (d.susuki || d.susukiDensity) {
      if (susukiSystem) {
        syncSusukiUniforms();
        susukiSystem.rebuildPlumeGeometry(susukiState);
        susukiSystem.rebuildStemGeometry(susukiState);
        susukiSystem.redrawPlumeTexture(susukiState);
      } else if (grassTerrainData.hasSusukiData) {
        void ensureSusukiBuilt();
      }
      susukiUi?.refresh();
    }

    if (d.groundTsl) {
      groundTslState.enabled = !!d.groundTsl.enabled;
      if (d.groundTsl.baseColor)  groundTslState.baseColor = d.groundTsl.baseColor;
      if (Number.isFinite(d.groundTsl.brightness)) groundTslState.brightness = d.groundTsl.brightness;
      if (Number.isFinite(d.groundTsl.contrast))   groundTslState.contrast = d.groundTsl.contrast;
      if (d.groundTsl.layer1) Object.assign(groundTslState.layer1, d.groundTsl.layer1);
      if (d.groundTsl.layer2) Object.assign(groundTslState.layer2, d.groundTsl.layer2);
      if (d.groundTsl.slopeTint)  Object.assign(groundTslState.slopeTint,  d.groundTsl.slopeTint);
      if (d.groundTsl.heightTint) Object.assign(groundTslState.heightTint, d.groundTsl.heightTint);
      if (Number.isFinite(d.groundTsl.bandNoise)) groundTslState.bandNoise = d.groundTsl.bandNoise;
      syncGroundTsl();
      groundTslUi?.refresh();
    }

    if (d.meadowTsl) {
      if (d.meadowTsl.baseColor) meadowTslState.baseColor = d.meadowTsl.baseColor;
      if (Number.isFinite(d.meadowTsl.brightness)) meadowTslState.brightness = d.meadowTsl.brightness;
      if (Number.isFinite(d.meadowTsl.contrast))   meadowTslState.contrast = d.meadowTsl.contrast;
      if (d.meadowTsl.layer1) Object.assign(meadowTslState.layer1, d.meadowTsl.layer1);
      if (d.meadowTsl.layer2) Object.assign(meadowTslState.layer2, d.meadowTsl.layer2);
      syncMeadowTsl();
      meadowTslUi?.refresh();
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
      document.getElementById("tree-panel")?._rebuildTreeUi?.();
    }

    // Always import, even when absent: a project with no foliage must clear
    // instances left over from the previous scene.
    foliageEnv.importData(d.foliage ?? null);

    if (d.props) {
      await restorePropSlots(d.props.slots, d.props.types);
      const nameToIdx = Object.fromEntries(propStore.types.map((t, i) => [t.name, i]));
      propStore.importData(d.props, nameToIdx);
      livePropManager.update(0);
      rebakePlayerBvh();
      refreshPropCount();
    }

    if (d.roads) roadSystem.importData(d.roads);
    if (d.splines) splineSys.importData(d.splines);
    // Always import, even when absent: a project with no lakes must clear any
    // lakes left over from the previous scene.
    lakeSystem.importData(d.lakes ?? null);
    // importData merged the saved lakebed values into the slice; push them to the
    // terrain uniforms (the panel callback only fires on user edits).
    lakebedShading.syncParams(lakeToolSlice.lake.lakebed);
    lakeUi?.refresh();

    // Rivers restore like lakes — always import so a river-less project clears
    // leftovers. River+ re-carves the saved (uncarved) base heightmap.
    riverSystem.importData(d.rivers ?? null);
    river2System.importData(d.rivers2 ?? null);

    // Also always import: a project with no player start must clear the old marker.
    spawnSystem.importData(d.spawn ?? null);
    spawnSystem.setVisible(!playMode.active);
    spawnUi?.refresh();

    onHistoryChange();
    console.log("[V3] Project loaded.");
  }

  /**
   * Headless / game load path. Fetches a saved .v3proj by URL (e.g. a file that
   * lives with a game project) and restores the full world through the same
   * applyProjectData the editor's Load button uses — terrain, splat, snow,
   * trees, props, roads, splines, lakes. No file picker, no size-mismatch
   * reload dance (the caller is expected to boot at the project's terrain size).
   */
  async function loadProjectFromUrl(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch project "${url}" (${res.status})`);
    const buf = await res.arrayBuffer();
    if (!isProjectFile(buf)) throw new Error(`"${url}" is not a V3 project file.`);
    await applyProjectData(decodeProjectFile(buf));
  }

  /** Same full-world restore as loadProjectFromUrl, from raw .v3proj bytes. */
  async function loadProjectFromBuffer(buf) {
    if (!isProjectFile(buf)) throw new Error("Not a V3 project file.");
    await applyProjectData(decodeProjectFile(buf));
  }

  /** Toolbar Load — sniffs the file: whole project or bare heightmap. */
  async function loadAnyFile() {
    const file = await pickProjectFile();
    if (!file) return;
    try {
      const buf = await file.arrayBuffer();
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
      window.alert(err instanceof Error ? err.message : "Failed to load file.");
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
  spawnUi = buildSpawnPanel({
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
  lakeUi = buildLakePanel({
    toolState: lakeToolSlice,
    lakeSystem,
    waterGlobals,
    worldSize: WORLD_SIZE,
    maxHeight: MAX_HEIGHT,
    materialChanged:  () => lakeSystem.syncMaterial(),
    lakebedChanged:   () => lakebedShading.syncParams(lakeToolSlice.lake.lakebed),
    transformChanged: () => {},   // syncActiveTransform already ran inside the panel
    selectionChanged: () => {},
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
      if (lakeSystem.endDrag()) lakeUi.refresh();
    };
    renderer.domElement.addEventListener("mouseup", finish);
    window.addEventListener("mouseup", finish);
    renderer.domElement.addEventListener("mouseleave", () => {
      if (dragging) { dragging = false; lakeSystem.cancelDrag(); }
    });
  }

  buildRiverPanels({
    toolState: riverToolSlice,
    waterGlobals,
    riverChanged: () => {
      riverSystem.syncMaterial();
      riverSystem.rebuildAllMeshes();
      applyRiverModeEffects();
    },
    riverNewRiver: () => riverSystem.startNewRiver(),
    riverDeleteActive: () => riverSystem.deleteActiveRiver(),
    riverDeleteSelected: () => riverSystem.deleteSelected(),
    riverSelectedYChanged: () => riverSystem.setSelectedPointY(riverToolSlice.river.selectedPointY),
    riverActiveIndexChanged: () => {
      riverSystem._clampActive();
      riverSystem.selectedIdx = -1;
      riverSystem._rebuildVisual();
    },
    river2Changed: () => {
      river2System.syncMaterial();
      river2System.rebuildAllMeshes();
      applyRiverModeEffects();
    },
    river2MaterialChanged: () => river2System.syncMaterial(),
    river2CarveChanged: () => {
      river2System.syncMaterial();
      river2System.refreshCarving();
    },
    river2NewRiver: () => river2System.startNewRiver(),
    river2DeleteActive: () => river2System.deleteActiveRiver(),
    river2DeleteSelected: () => river2System.deleteSelected(),
    river2SelectedYChanged: () => river2System.setSelectedPointY(riverToolSlice.river2.selectedPointY),
    river2ActiveIndexChanged: () => {
      river2System._clampActive();
      river2System.selectedIdx = -1;
      river2System._rebuildVisual();
    },
  });

  applyRiverModeEffects();

  buildRoadPanel({
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
    roadClearAll: () => roadSystem.setNetwork([], []),
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
          roadSystem.importData(JSON.parse(await file.text()));
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

  // ── River mode mouse events ─────────────────────────────────────────────────
  renderer.domElement.addEventListener("mousemove", e => {
    if (playMode.active || editorMode !== "river") return;
    if (riverSystem.dragging && riverSystem.selectedIdx >= 0) {
      const hit = getTerrainHitWorld(e);
      if (hit) riverSystem.moveSelected(hit);
    }
  });

  renderer.domElement.addEventListener("mousedown", e => {
    if (playMode.active || editorMode !== "river" || e.button !== 0) return;
    e.preventDefault();
    refreshMouse(e);
    raycaster.setFromCamera(mouse, camera);
    const picked = riverSystem.pickPoint(raycaster);
    if (picked >= 0) {
      riverSystem.selectedIdx = picked;
      riverSystem.dragging = true;
      controls.enabled = false;
      riverSystem._rebuildHandles();
      riverSystem._updateSelectedY();
    } else {
      const hit = getTerrainHitWorld(e);
      if (hit) riverSystem.addPoint(hit);
    }
  }, { capture: true });

  renderer.domElement.addEventListener("mouseup", e => {
    if (editorMode !== "river") return;
    if (riverSystem.dragging) {
      riverSystem.dragging = false;
      syncEditorOrbitEnabled();
    }
  });

  // ── River+ mode mouse events ──────────────────────────────────────────────
  renderer.domElement.addEventListener("mousemove", e => {
    if (playMode.active || editorMode !== "river2") return;
    if (river2System.dragging && river2System.selectedIdx >= 0) {
      const hit = getTerrainHitWorld(e);
      if (hit) river2System.moveSelected(hit);
    }
  });

  renderer.domElement.addEventListener("mousedown", e => {
    if (playMode.active || editorMode !== "river2" || e.button !== 0) return;
    e.preventDefault();
    refreshMouse(e);
    raycaster.setFromCamera(mouse, camera);
    const picked = river2System.pickPoint(raycaster);
    if (picked) {
      // Any river's handle — selecting switches the active river too.
      river2System.selectPoint(picked);
      river2System.dragging = true;
      controls.enabled = false;
    } else if (e.altKey) {
      // Alt-click near the active centerline inserts a control point there.
      const hit = getTerrainHitWorld(e);
      if (hit) river2System.insertPointNear(hit);
    } else {
      const hit = getTerrainHitWorld(e);
      if (hit) river2System.addPoint(hit);
    }
  }, { capture: true });

  renderer.domElement.addEventListener("mouseup", e => {
    if (editorMode !== "river2") return;
    if (river2System.dragging) {
      river2System.finalizeMove();
      syncEditorOrbitEnabled();
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
        roadSystem.toggleEdge(sel, hit.nodeId);
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
        roadSystem.addNode(th.x, th.z, true);
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
      const slR = document.getElementById("snow-sl-radius");
      const lbR = document.getElementById("snow-lbl-radius");
      if (slR) slR.value = Math.round(snowBrushState.radius);
      if (lbR) lbR.textContent = Math.round(snowBrushState.radius) + "m";
      sculpt.uRadius.value = snowBrushState.radius / WORLD_SIZE;
    } else {
      snowBrushState.strength = Math.max(0.01, Math.min(1.0, snowBrushState.strength * factor));
      const slS = document.getElementById("snow-sl-strength");
      const lbS = document.getElementById("snow-lbl-strength");
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
      const slR = document.getElementById("cliffpaint-sl-radius");
      const lbR = document.getElementById("cliffpaint-lbl-radius");
      if (slR) slR.value = Math.round(cliffPaintBrush.radius);
      if (lbR) lbR.textContent = Math.round(cliffPaintBrush.radius) + "m";
      sculpt.uRadius.value = cliffPaintBrush.radius / WORLD_SIZE;
    } else {
      cliffPaintBrush.strength = Math.max(0.01, Math.min(1.0, cliffPaintBrush.strength * factor));
      const slS = document.getElementById("cliffpaint-sl-strength");
      const lbS = document.getElementById("cliffpaint-lbl-strength");
      if (slS) slS.value = Math.round(cliffPaintBrush.strength * 100);
      if (lbS) lbS.textContent = cliffPaintBrush.strength.toFixed(2);
    }
  }, { passive: false, capture: true });

  // ── Grass mode mouse events ────────────────────────────────────────────────
  let _grassUndoStack = [];
  let _grassRedoStack = [];
  let _grassPainting  = false;

  // Undo entries are tagged with the layer they snapshot so terrain and cliff
  // paint share one stack without corrupting each other.
  function _pushGrassUndo() {
    const cliff = grassBrush.target === "cliff";
    _grassUndoStack.push({
      cliff,
      data: cliff ? grassTerrainData.getCliffDensitySnapshot()
                  : grassTerrainData.getDensitySnapshot(),
    });
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
    if (grassBrush.target === "cliff") grassTerrainData.stampCliffDensity(opts);
    else                               grassTerrainData.stampDensity(opts);
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
  susukiUi = buildSusukiPanel(susukiPanel, {
    susukiBrush,
    susukiState,
    onBrushChanged:    () => { sculpt.uRadius.value = susukiBrush.radius / WORLD_SIZE; },
    onStateChanged:    () => syncSusukiUniforms(),
    onPlumeGeoChanged: () => susukiSystem?.rebuildPlumeGeometry(susukiState),
    onStemGeoChanged:  () => susukiSystem?.rebuildStemGeometry(susukiState),
    onTextureChanged:  () => susukiSystem?.redrawPlumeTexture(susukiState),
    onFill:  () => { _pushSusukiUndo(); grassTerrainData.fillSusukiDensity(); void ensureSusukiBuilt(); },
    onClear: () => { _pushSusukiUndo(); grassTerrainData.clearSusukiDensity(); },
  });

  groundTslUi = buildGroundTslPanel(paintPanel, {
    groundTslState,
    presets: GROUND_PRESETS,
    applyPreset: (id) => applyGroundPresetToParams(id, groundTslState),
    onChanged: syncGroundTsl,
  });

  meadowTslUi = buildMeadowTslSection(paintPanel, {
    meadowTslState,
    presets: MEADOW_PRESETS,
    applyPreset: (id) => applyMeadowPresetToParams(id, meadowTslState),
    onChanged: syncMeadowTsl,
  });

  let _susukiUndoStack = [];
  let _susukiRedoStack = [];
  let _susukiPainting  = false;

  function _pushSusukiUndo() {
    _susukiUndoStack.push(grassTerrainData.getSusukiDensitySnapshot());
    if (_susukiUndoStack.length > 32) _susukiUndoStack.shift();
    _susukiRedoStack = [];
  }

  function _susukiPaintXZ(e) {
    refreshMouse(e);
    const hit = getUV();
    uCursorUV.value.set(hit ? hit.u : -2, hit ? hit.v : -2);
    if (!hit) return null;
    return { wx: hit.u * WORLD_SIZE - WORLD_SIZE / 2, wz: hit.v * WORLD_SIZE - WORLD_SIZE / 2 };
  }

  function _stampSusuki(wx, wz, altErase) {
    grassTerrainData.stampSusukiDensity({
      cx: wx, cz: wz,
      radius:    susukiBrush.radius,
      strength:  susukiBrush.strength,
      falloff:   susukiBrush.falloff,
      worldSize: WORLD_SIZE,
      erase:     susukiBrush.erase || altErase,
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
    _pushSusukiUndo();
    _susukiPainting = true;
    void ensureSusukiBuilt();
    _stampSusuki(pt.wx, pt.wz, e.altKey);
  }, { capture: true });

  renderer.domElement.addEventListener("mouseup", e => {
    if (e.button !== 0) return;
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
      susukiBrush.radius = Math.max(5, Math.min(300, susukiBrush.radius * factor));
      sculpt.uRadius.value = susukiBrush.radius / WORLD_SIZE;
    } else {
      susukiBrush.strength = Math.max(0.05, Math.min(1.0, susukiBrush.strength * factor));
    }
    susukiUi.refresh();
  }, { passive: false, capture: true });

  window.addEventListener("keydown", e => {
    if (editorMode !== "susuki") return;
    if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "z") {
      const entry = _susukiUndoStack.pop();
      if (!entry) return;
      _susukiRedoStack.push(grassTerrainData.getSusukiDensitySnapshot());
      grassTerrainData.restoreSusukiDensitySnapshot(entry);
      e.stopImmediatePropagation();
    }
    if (e.ctrlKey && (e.shiftKey && e.key.toLowerCase() === "z" || e.key.toLowerCase() === "y")) {
      const entry = _susukiRedoStack.pop();
      if (!entry) return;
      _susukiUndoStack.push(grassTerrainData.getSusukiDensitySnapshot());
      grassTerrainData.restoreSusukiDensitySnapshot(entry);
      e.stopImmediatePropagation();
    }
  }, { capture: true });

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

  // ── Foliage mode mouse events (v2 billboard foliage paint) ────────────────
  let _foliagePainting = false;
  const _foliageHit = new THREE.Vector3();

  function _foliageHitFromEvent(e) {
    refreshMouse(e);
    const uv = getUV();
    if (!uv) return null;
    return _foliageHit.set(
      uv.u * WORLD_SIZE - WORLD_SIZE / 2,
      sampleTerrainHeight(uv.u, uv.v),
      uv.v * WORLD_SIZE - WORLD_SIZE / 2,
    );
  }

  renderer.domElement.addEventListener("mousemove", e => {
    if (playMode.active || editorMode !== "foliage") return;
    refreshMouse(e);
    const uv = getUV();
    uCursorUV.value.set(uv ? uv.u : -2, uv ? uv.v : -2);
    if (uv) sculpt.uRadius.value = foliageToolState.brush.radius / WORLD_SIZE;
    const pt = _foliageHitFromEvent(e);
    if (pt && _foliagePainting) foliageEnv.paintSystem.applyAt(pt, e);
  });

  renderer.domElement.addEventListener("mousedown", e => {
    if (playMode.active || editorMode !== "foliage") return;
    if (e.button !== 0) return;
    const pt = _foliageHitFromEvent(e);
    if (!pt) return;
    e.preventDefault();
    _foliagePainting = true;
    controls.enabled = false;
    foliageEnv.paintSystem.beginStroke(pt, e);
  }, { capture: true });

  renderer.domElement.addEventListener("mouseup", e => {
    if (e.button !== 0 || editorMode !== "foliage") return;
    if (!_foliagePainting) return;
    _foliagePainting = false;
    foliageEnv.paintSystem.endStroke();
    syncEditorOrbitEnabled();
  });

  renderer.domElement.addEventListener("wheel", e => {
    if (playMode.active || editorMode !== "foliage") return;
    if (!e.shiftKey && !e.altKey) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const factor = e.deltaY > 0 ? 0.9 : 1.11;
    if (e.shiftKey) {
      foliageToolState.brush.radius = Math.max(
        editorConfig.sculpt.brushMin,
        Math.min(editorConfig.sculpt.brushMax, foliageToolState.brush.radius * factor),
      );
      sculpt.uRadius.value = foliageToolState.brush.radius / WORLD_SIZE;
    } else {
      foliageToolState.brush.strength = Math.max(
        editorConfig.sculpt.strengthMin,
        Math.min(editorConfig.sculpt.strengthMax, foliageToolState.brush.strength * factor),
      );
    }
  }, { passive: false, capture: true });

  // Grass undo/redo — patch into existing Ctrl+Z/Y handler. Each entry carries
  // whether it snapshots the terrain or the cliff density layer.
  const _snapGrass  = (cliff) => cliff ? grassTerrainData.getCliffDensitySnapshot()
                                       : grassTerrainData.getDensitySnapshot();
  const _restoreGrass = (cliff, data) => cliff
    ? grassTerrainData.restoreCliffDensitySnapshot(data)
    : grassTerrainData.restoreDensitySnapshot(data);
  window.addEventListener("keydown", e => {
    if (editorMode !== "grass") return;
    if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "z") {
      const entry = _grassUndoStack.pop();
      if (!entry) return;
      _grassRedoStack.push({ cliff: entry.cliff, data: _snapGrass(entry.cliff) });
      _restoreGrass(entry.cliff, entry.data);
      e.stopImmediatePropagation();
    }
    if (e.ctrlKey && (e.shiftKey && e.key.toLowerCase() === "z" || e.key.toLowerCase() === "y")) {
      const entry = _grassRedoStack.pop();
      if (!entry) return;
      _grassUndoStack.push({ cliff: entry.cliff, data: _snapGrass(entry.cliff) });
      _restoreGrass(entry.cliff, entry.data);
      e.stopImmediatePropagation();
    }
  }, { capture: true });

  // Re-sync orbit after props/spline wiring (do not reset mode — that felt like a freeze).
  syncEditorOrbitEnabled();

  if (import.meta.env?.DEV) {
    window.__V3_DEBUG = {
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
      get river2System() { return river2System; },
      get grassState() { return grassState; },
      get grassRings() { return grassRings; },
      get grassTintRT() { return grassTintRT; },
      get susukiSystem() { return susukiSystem; },
      renderer,
      terrainNormals,
      grassTintScene,
      grassTintCam,
      forceGrassTintBake() {
        const prevRT = renderer.getRenderTarget();
        renderer.setRenderTarget(grassTintRT);
        renderer.render(grassTintScene, grassTintCam);
        renderer.setRenderTarget(prevRT);
      },
      get riverToolSlice() { return riverToolSlice; },
      get grassRings() { return grassRings; },
      get cliffGrassRings() { return cliffGrassRings; },
      get grassState() { return grassState; },
      renderer,
    };
  }

  // ── App handle ─────────────────────────────────────────────────────────────
  // What a game project holds after startV3App(). The editor is just the first
  // caller; a game (games/rts-v3/…) imports this same boot, gets this handle,
  // loads its own .v3proj through loadProjectFromUrl, and builds gameplay on top.
  return {
    scene,
    camera,
    controls,
    renderer,
    playMode,
    propStore,
    roadSystem,
    splineSystem: splineSys,
    lakeSystem,
    river2System,
    treeEnv,
    foliageEnv,
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
      setBloomSelective(on) {
        worldEnv?.postFxPipeline?.setBloomSelective(!!on);
      },
      /** `(colorNode) => colorNode` — applied to scene beauty before bloom (FoW). */
      setSceneColorModifier(fn) {
        worldEnv?.postFxPipeline?.setSceneColorModifier(fn);
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
    // GPU-side counterpart of getWorldHeight: the live heightmap as a TSL texture
    // node, for shaders that must drape geometry over the terrain in the vertex
    // stage instead of paying a CPU sample per vertex (RTS selection rings).
    // sculptBrush swaps its .value to the active ping-pong RT, so anything that
    // captured the NODE keeps reading live heights while the terrain is edited.
    heightTexNode,
    // Surface normal at a world X/Z — slope for nav walkability, unit tilt.
    // (Returns a shared vector; read its components immediately, don't retain.)
    getWorldNormal: (wx, wz) => sampleTerrainNormal(wx, wz),
    // Water surface height (world Y) at an X/Z from the global ocean + any lake
    // covering that point, or -Infinity if dry. Used to block ground units from
    // entering water and to keep air units above the surface. (Rivers vary along
    // their length and aren't included here — nav blocks them separately.)
    getWaterLevelAt: (wx, wz) => {
      let level = -Infinity;
      const o = worldToolState.worldOcean;
      if (o?.enabled) level = o.seaLevel ?? 0;
      for (const L of lakeSystem.lakes) {
        if (Math.abs(wx - L.cx) <= L.sizeX * 0.5 && Math.abs(wz - L.cz) <= L.sizeZ * 0.5 && L.level > level) {
          level = L.level;
        }
      }
      return level;
    },
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
