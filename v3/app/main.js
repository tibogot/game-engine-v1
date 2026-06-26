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
  scene.add(sun);

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

  // LOD meshes share the same heightTexNode, cursor uniforms, brush mask, and rotation.
  const lod = createTerrainLOD(heightTexNode, uCursorUV, sculpt.uRadius, sculpt.maskNode, sculpt.uMaskRotation);
  scene.add(lod.group);

  sculpt.replaceHeightData(buildProceduralHeightmap(genParams));

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
  const tbHelp    = document.getElementById("tb-help");
  const tbSave    = document.getElementById("tb-save");
  const tbLoad    = document.getElementById("tb-load");
  const tbUndo    = document.getElementById("tb-undo");
  const tbRedo    = document.getElementById("tb-redo");
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

  const helpOverlay = document.getElementById("help-overlay");
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

  // Use capture phase so our handler fires before OrbitControls' bubble listener.
  // Shift+Scroll = brush size  |  Alt+Scroll = strength  |  plain scroll = zoom (OrbitControls)
  renderer.domElement.addEventListener("wheel", e => {
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
    if (e.ctrlKey || e.metaKey) {
      const key = e.key.toLowerCase();
      if (key === "s") {
        e.preventDefault();
        saveHeightmap();
        return;
      }
      if (key === "z" && !e.shiftKey) {
        e.preventDefault();
        if (sculpt.undo()) onHistoryChange();
        return;
      }
      if (key === "y" || (key === "z" && e.shiftKey)) {
        e.preventDefault();
        if (sculpt.redo()) onHistoryChange();
        return;
      }
    }
  });

  // ── Resize ─────────────────────────────────────────────────────────────────
  const ro = new ResizeObserver(() => resizeRenderer());
  ro.observe(viewport);
  window.addEventListener("resize", () => resizeRenderer());

  // ── Loop ───────────────────────────────────────────────────────────────────
  renderer.setAnimationLoop(() => {
    // Reset first — stats-gl patches this to mark the CPU profiling window start.
    renderer.info.reset();

    if (isPainting) {
      const hit = getUV();
      if (hit) applySculptStroke(hit.u, hit.v);
    }

    // Center LOD on the orbit target, not the camera — terrain stays fixed
    // while orbiting. Switch to camera.position for first-person play mode.
    lod.update(controls.target);
    controls.update();
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
