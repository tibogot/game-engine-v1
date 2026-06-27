import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
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
import { BRUSH_MASKS, loadMaskPNG } from "../terrain/brushMasks.js";
import { createPlayMode, LOD_SNAP } from "../play/playMode.js";
import { CSMShadowNode } from "three/addons/csm/CSMShadowNode.js";
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
  await stats.init(renderer);
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

  function resizeRenderer() {
    const w = viewport.clientWidth;
    const h = viewport.clientHeight;
    camera.aspect = w / Math.max(h, 1);
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    layoutStatsOverlay();
  }

  resizeRenderer();

  // ── Controls ───────────────────────────────────────────────────────────────
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0, 0);
  controls.maxPolarAngle = Math.PI / 2 - 0.02;
  controls.minDistance = 20;
  controls.maxDistance = WORLD_SIZE;
  controls.enableDamping = true;
  controls.dampingFactor = 0.1;
  // LMB → sculpt   MMB → orbit   RMB → pan  (matches v2 editor)
  controls.mouseButtons = { MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.PAN };
  controls.update();

  // ── Lights ─────────────────────────────────────────────────────────────────
  scene.add(new THREE.AmbientLight(0xffffff, 0.5));
  const sun = new THREE.DirectionalLight(0xfff4e0, 2.0);
  sun.position.set(600, 800, 400);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.normalBias = 0.01;
  sun.shadow.bias = -0.001;
  sun.shadow.radius = 4;
  scene.add(sun);

  // ── CSM shadows ────────────────────────────────────────────────────────────
  // 3 cascades, 80m reach, "practical" split — same config as v2.
  // lightMargin=200 keeps the shadow bbox from clipping the tall terrain.
  let csm = null;
  try {
    csm = new CSMShadowNode(sun, { cascades: 3, maxFar: 80, mode: "practical", lightMargin: 200 });
    csm.fade = true;
    for (let i = 0; i < csm.lights.length; i++) {
      const sh = csm.lights[i].shadow;
      sh.mapSize.set(2048, 2048);
      sh.radius = 4;
      sh.normalBias = 0.01 * Math.sqrt(i + 1);
      sh.bias = -0.001 * (i + 1);
      scene.add(csm.lights[i].target);
      scene.add(csm.lights[i]);
    }
    sun.shadow.shadowNode = csm;
  } catch (err) {
    console.warn("[V3] CSMShadowNode init failed; using plain directional shadow.", err);
    csm = null;
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

  sculpt.replaceHeightData(buildProceduralHeightmap(genParams));

  // ── Human character ────────────────────────────────────────────────────────
  const character = createHumanCharacter(scene, renderer);

  // ── Play mode ──────────────────────────────────────────────────────────────
  const playPanel      = document.getElementById("play-panel");
  const playStopBar    = document.getElementById("play-stop-bar");
  const sculptPanel    = document.getElementById("sculpt-panel");
  const paintPanel     = document.getElementById("paint-panel");
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
    },
  });

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

  function syncSculptPanelVisibility() {
    sculptPanel.style.display = (editorMode === "sculpt" && !playMode.active) ? "" : "none";
  }

  function syncPaintPanelVisibility() {
    paintPanel.style.display = (editorMode === "paint" && !playMode.active) ? "" : "none";
  }

  function setEditorMode(m) {
    editorMode = m;
    tbSculpt.classList.toggle("active", m === "sculpt");
    toolsModeSelect.value = m;
    if (m === "view") {
      uCursorUV.value.set(-2, -2);
      cancelStroke();
      controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.PAN };
    } else if (m === "paint") {
      controls.mouseButtons = { MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.PAN };
      // Sync cursor radius to paint brush size
      sculpt.uRadius.value = paintState.brush.radius / WORLD_SIZE;
    } else {
      controls.mouseButtons = { MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.PAN };
    }
    syncSculptPanelVisibility();
    syncPaintPanelVisibility();
  }

  function enterPlay() {
    if (playMode.active) return;
    playMode.enter();
    playMode.startWalking(); // request pointer lock immediately (still in click handler)
    tbPlay.classList.add("active");
    playStopBar.classList.add("visible");
    playPanel.style.display = "";
    sculptPanel.style.display = "none";
    paintPanel.style.display = "none";
    helpOverlay.classList.remove("visible");
    tbHelp.classList.remove("active");
  }

  // View-mode mouse buttons set directly at startup (TDZ guard — cancelStroke
  // references isPainting declared later; setEditorMode is safe only after that).
  controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.PAN };

  tbSculpt.addEventListener("click", () => setEditorMode("sculpt"));
  toolsModeSelect.addEventListener("change", () => setEditorMode(toolsModeSelect.value));

  tbPlay.addEventListener("click", () => {
    if (playMode.active) playMode.exit();
    else enterPlay();
  });

  // Click viewport while in play but pointer not locked → re-lock
  renderer.domElement.addEventListener("click", () => {
    if (playMode.active && !playMode.walking) playMode.startWalking();
  });

  document.getElementById("play-stop-btn").addEventListener("click", () => playMode.exit());

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
    const rect = viewport.getBoundingClientRect();
    mouse.x =  ((e.clientX - rect.left) / rect.width)  * 2 - 1;
    mouse.y = -((e.clientY - rect.top)  / rect.height) * 2 + 1;
  }

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

  renderer.domElement.addEventListener("contextmenu", e => e.preventDefault());

  // Clicking the viewport while in play menu state starts walking.
  renderer.domElement.addEventListener("click", () => {
    if (playMode.active && !playMode.walking) playMode.startWalking();
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

  // Seed the CPU mirror so picking works before the first mouse move.
  requestHeightmapReadback();

  function cancelStroke() {
    isPainting = false;
    lastPaintUV = null;
  }

  function onHistoryChange() {
    cancelStroke();
    requestHeightmapReadback();
  }

  window.addEventListener("keydown", e => {
    if (e.code === "KeyV" && !e.ctrlKey && !e.metaKey && !e.altKey && !playMode.active
        && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement)) {
      setEditorMode("view"); return;
    }
    if (e.code === "KeyP" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      if (playMode.active) playMode.exit();
      else playMode.enter();
      return;
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
        else if (sculpt.undo()) onHistoryChange();
        return;
      }
      if (key === "y" || (key === "z" && e.shiftKey)) {
        e.preventDefault();
        if (editorMode === "paint") paintSys.redo();
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

  // ── Resize ─────────────────────────────────────────────────────────────────
  const ro = new ResizeObserver(() => resizeRenderer());
  ro.observe(viewport);
  window.addEventListener("resize", () => resizeRenderer());

  // ── Loop ───────────────────────────────────────────────────────────────────
  const _lodSnapVec = new THREE.Vector3();
  let _lastFrameMs = performance.now();
  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const dt  = Math.min((now - _lastFrameMs) / 1000, 0.05);
    _lastFrameMs = now;

    // Reset first — stats-gl patches this to mark the CPU profiling window start.
    renderer.info.reset();

    if (playMode.active) {
      playMode.update(dt);

      // Live stats in the play panel (throttled — DOM writes are cheap but no need every ms)
      if (playMode.walking) {
        const s = playMode.getStats();
        playStatPos  .textContent = `${s.x}, ${s.y}, ${s.z}`;
        playStatSpeed.textContent = `${s.speed} m/s`;
        playStatGround.textContent = s.grounded ? "Yes" : "No";
      }

      // Center LOD on the player's feet, snapped to the heightmap texel grid
      // (16 m/texel = 2048 m / 128). Snapping prevents distant LOD rings from
      // continuously resampling at sub-texel offsets, which causes visible morphing.
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
      lod.update(controls.target);
      controls.update();
    }

    if (csm?.mainFrustum) csm.updateFrustums();
    renderer.render(scene, camera);

    // Drain GPU timestamp pools so stats-gl's GPU/CPT panels get real values.
    if (hasTimestamps) {
      renderer.resolveTimestampsAsync(THREE.TimestampQuery.RENDER);
      renderer.resolveTimestampsAsync(THREE.TimestampQuery.COMPUTE);
    }

    // Feed custom counter panels.
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
  });
}

main();
