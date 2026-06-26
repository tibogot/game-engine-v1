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
  const gpuDevice = await createWebGpuDevice();

  // ── Renderer ───────────────────────────────────────────────────────────────
  const renderer = new THREE.WebGPURenderer({
    antialias: true,
    ...(gpuDevice ? { device: gpuDevice } : {}),
  });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  viewport.appendChild(renderer.domElement);

  const stats = new Stats({ trackGPU: true, trackCPT: true });
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

  // sculptBrush uploads the CPU heightmap to its RT and sets heightTexNode.value.
  const sculpt = createSculptBrush(renderer, initialTex, heightTexNode);

  // LOD meshes share the same heightTexNode and cursor uniforms.
  const lod = createTerrainLOD(heightTexNode, uCursorUV, sculpt.uRadius);
  scene.add(lod.group);

  sculpt.replaceHeightData(buildProceduralHeightmap(genParams));

  // ── UI wiring ──────────────────────────────────────────────────────────────
  const btnRaise  = document.getElementById("btn-raise");
  const btnLower  = document.getElementById("btn-lower");
  const btnSmooth = document.getElementById("btn-smooth");
  const btnFlatten = document.getElementById("btn-flatten");
  const tbSave    = document.getElementById("tb-save");
  const tbLoad    = document.getElementById("tb-load");
  const tbUndo    = document.getElementById("tb-undo");
  const tbRedo    = document.getElementById("tb-redo");
  const slSize    = document.getElementById("sl-size");
  const lblSize   = document.getElementById("lbl-size");
  const slStr     = document.getElementById("sl-str");
  const lblStr    = document.getElementById("lbl-str");

  const genMode    = document.getElementById("gen-mode");
  const genSeed    = document.getElementById("gen-seed");
  const genScale   = document.getElementById("gen-scale");
  const lblGenScale  = document.getElementById("lbl-gen-scale");
  const genHeight  = document.getElementById("gen-height");
  const lblGenHeight = document.getElementById("lbl-gen-height");
  const genOctaves = document.getElementById("gen-octaves");
  const lblGenOctaves = document.getElementById("lbl-gen-octaves");
  const genDropoff = document.getElementById("gen-dropoff");
  const lblGenDropoff = document.getElementById("lbl-gen-dropoff");
  const btnGenerate   = document.getElementById("btn-generate");
  const btnRandomSeed = document.getElementById("btn-random-seed");

  function setMode(m) {
    btnRaise  .classList.toggle("active", m === "raise");
    btnLower  .classList.toggle("active", m === "lower");
    btnSmooth .classList.toggle("active", m === "smooth");
    btnFlatten.classList.toggle("active", m === "flatten");
  }

  const pointerMods = { shift: false, ctrl: false, alt: false };

  function syncPointerMods(e) {
    pointerMods.shift = e.shiftKey;
    pointerMods.ctrl  = e.ctrlKey || e.metaKey;
    pointerMods.alt   = e.altKey;
  }

  /** Live each stamp — v2: Alt flatten · Ctrl smooth · Shift lower · else raise. */
  function getStrokeMode() {
    if (pointerMods.alt) return "flatten";
    if (pointerMods.ctrl) return "smooth";
    if (pointerMods.shift) return "lower";
    return "raise";
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

  function readGenFromUI() {
    genParams.mode = genMode.value === "fbm" ? "fbm" : "ridge";
    genParams.seed = Number(genSeed.value) || 0;
    genParams.scale = Number(genScale.value);
    genParams.height = Number(genHeight.value);
    genParams.octaves = Number(genOctaves.value);
    genParams.dropoff = Number(genDropoff.value) / 10;
  }

  function syncGenUI() {
    lblGenScale.textContent   = genScale.value;
    lblGenHeight.textContent  = genHeight.value;
    lblGenOctaves.textContent = genOctaves.value;
    lblGenDropoff.textContent = (Number(genDropoff.value) / 10).toFixed(1);
  }

  function applyProceduralTerrain() {
    readGenFromUI();
    sculpt.replaceHeightData(buildProceduralHeightmap(genParams));
    onHistoryChange();
  }

  genScale.addEventListener("input", syncGenUI);
  genHeight.addEventListener("input", syncGenUI);
  genOctaves.addEventListener("input", syncGenUI);
  genDropoff.addEventListener("input", syncGenUI);
  btnGenerate.addEventListener("click", () => applyProceduralTerrain());
  btnRandomSeed.addEventListener("click", () => {
    genSeed.value = Math.floor(Math.random() * 10000);
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

  tbSave.addEventListener("click", () => { saveHeightmap(); });
  tbLoad.addEventListener("click", () => { loadHeightmap(); });
  tbUndo.addEventListener("click", () => { if (sculpt.undo()) onHistoryChange(); });
  tbRedo.addEventListener("click", () => { if (sculpt.redo()) onHistoryChange(); });

  function syncSizeUI()  { lblSize.textContent = Math.round(sculpt.uRadius.value   * 100) + "%"; }
  function syncStrUI()   { lblStr .textContent = Math.round(sculpt.uStrength.value * 1000); }

  slSize.addEventListener("input", () => {
    sculpt.uRadius.value = slSize.value / 100;
    syncSizeUI();
  });
  slStr.addEventListener("input", () => {
    sculpt.uStrength.value = slStr.value / 1000;
    syncStrUI();
  });

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
  const STROKE_SPACING_FACTOR = 0.22;
  const MAX_STAMPS_PER_FRAME  = 12;

  function stampAt(u, v) {
    const mode = getStrokeMode();
    if (mode === "smooth") sculpt.smooth(u, v);
    else if (mode === "flatten") sculpt.flatten(u, v);
    else sculpt.paint(u, v, mode === "lower" ? -1 : 1);
  }

  /** Interpolate stamps along the UV segment so fast drags don't leave gaps. */
  function applySculptStroke(u, v) {
    const spacingUV = Math.max(0.6 / WORLD_SIZE, sculpt.uRadius.value * STROKE_SPACING_FACTOR);

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
    renderer.resolveTimestampsAsync(THREE.TimestampQuery.RENDER);
    renderer.resolveTimestampsAsync(THREE.TimestampQuery.COMPUTE);

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
