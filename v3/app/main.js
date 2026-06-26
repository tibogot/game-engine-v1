import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import Stats from "stats-gl";
import { texture, uniform } from "three/tsl";
import { createHeightmapTexture, HEIGHTMAP_SIZE, WORLD_SIZE, MAX_HEIGHT } from "../terrain/heightmapTexture.js";
import { createTerrainLOD } from "../terrain/terrainLOD.js";
import { createSculptBrush } from "../terrain/sculptBrush.js";

async function main() {
  // ── WebGPU device ─────────────────────────────────────────────────────────
  let gpuDevice = null;
  if (navigator.gpu) {
    const adapter = await navigator.gpu.requestAdapter({ featureLevel: "compatibility" });
    if (adapter) gpuDevice = await adapter.requestDevice();
  }
  // Only call resolveTimestampsAsync when the GPU actually supports it.
  const hasTimestamps = Boolean(gpuDevice?.features?.has('timestamp-query'));

  // ── Renderer ───────────────────────────────────────────────────────────────
  const renderer = new THREE.WebGPURenderer({
    antialias: true,
    ...(gpuDevice ? { device: gpuDevice } : {}),
  });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  document.body.appendChild(renderer.domElement);

  const stats = new Stats({ trackGPU: hasTimestamps, trackCPT: true });
  await stats.init(renderer);
  stats.dom.style.top    = "auto";
  stats.dom.style.bottom = "8px";
  stats.dom.style.left   = "8px";
  stats.dom.style.height = "48px";
  document.body.appendChild(stats.dom);

  const drawPanel   = stats.addPanel(new Stats.Panel("DRAW", "#f0f", "#202"));
  const triPanel    = stats.addPanel(new Stats.Panel("KTRI", "#f90", "#210"));
  let _maxDraw = 1;
  let _maxTri  = 1;
  renderer.info.autoReset = false;

  await renderer.init();

  // ── Scene ──────────────────────────────────────────────────────────────────
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87ceeb);

  // ── Camera ─────────────────────────────────────────────────────────────────
  const camera = new THREE.PerspectiveCamera(
    60,
    window.innerWidth / window.innerHeight,
    0.5,
    WORLD_SIZE * 2,
  );
  camera.position.set(0, 300, 600);

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

  // ── UI wiring ──────────────────────────────────────────────────────────────
  let sculptMode = "raise"; // "raise" | "lower" | "smooth"

  const btnRaise  = document.getElementById("btn-raise");
  const btnLower  = document.getElementById("btn-lower");
  const btnSmooth = document.getElementById("btn-smooth");
  const slSize    = document.getElementById("sl-size");
  const lblSize   = document.getElementById("lbl-size");
  const slStr     = document.getElementById("sl-str");
  const lblStr    = document.getElementById("lbl-str");

  function setMode(m) {
    sculptMode = m;
    btnRaise .classList.toggle("active", m === "raise");
    btnLower .classList.toggle("active", m === "lower");
    btnSmooth.classList.toggle("active", m === "smooth");
  }
  btnRaise .addEventListener("click", () => setMode("raise"));
  btnLower .addEventListener("click", () => setMode("lower"));
  btnSmooth.addEventListener("click", () => setMode("smooth"));

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
  // The brush runs entirely on GPU, so we async-read the RT back to CPU whenever
  // height data changes.  One readback per sculpt burst (guarded by the flag) is
  // enough — the 1-2 frame lag is invisible to the user.
  const cpuHeightmap   = new Float32Array(HEIGHTMAP_SIZE * HEIGHTMAP_SIZE);
  let readbackInFlight = false;

  async function syncHeightmapToCPU() {
    if (readbackInFlight) return;
    readbackInFlight = true;
    try {
      const rt  = sculpt.getCurrentRT();
      const raw = await renderer.readRenderTargetPixelsAsync(
        rt, 0, 0, HEIGHTMAP_SIZE, HEIGHTMAP_SIZE,
      );
      // raw is Uint16Array (RGBA HalfFloat) — only the R channel holds height.
      const isHalf = raw instanceof Uint16Array;
      for (let i = 0; i < HEIGHTMAP_SIZE * HEIGHTMAP_SIZE; i++) {
        const r = raw[i * 4];
        cpuHeightmap[i] = isHalf ? THREE.DataUtils.fromHalfFloat(r) : r;
      }
    } finally {
      readbackInFlight = false;
    }
  }

  function sampleTerrainHeight(u, v) {
    const px = Math.max(0, Math.min(HEIGHTMAP_SIZE - 1, Math.floor(u * HEIGHTMAP_SIZE)));
    const py = Math.max(0, Math.min(HEIGHTMAP_SIZE - 1, Math.floor(v * HEIGHTMAP_SIZE)));
    return cpuHeightmap[py * HEIGHTMAP_SIZE + px] * MAX_HEIGHT;
  }

  let isPainting = false;

  // Iterative ray-terrain intersection.
  // Start with the flat Y=0 plane, then lift to the terrain height at the hit XZ,
  // repeat until the plane height and the sampled height agree (3 iterations
  // converges to sub-texel accuracy for any non-grazing camera angle).
  function getUV() {
    raycaster.setFromCamera(mouse, camera);
    if (!raycaster.ray.intersectPlane(gndPlane, hitPoint)) return null;

    for (let i = 0; i < 3; i++) {
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
    mouse.x =  (e.clientX / window.innerWidth)  * 2 - 1;
    mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
  }

  let lastReadbackMs = 0;
  renderer.domElement.addEventListener("mousemove", e => {
    refreshMouse(e);
    const hit = getUV();
    uCursorUV.value.set(hit ? hit.u : -2, hit ? hit.v : -2);
    // Throttled readback so the cursor ring stays accurate while hovering.
    const now = performance.now();
    if (now - lastReadbackMs > 150) { lastReadbackMs = now; syncHeightmapToCPU(); }
  });

  renderer.domElement.addEventListener("mouseleave", () => {
    uCursorUV.value.set(-2, -2);
    isPainting = false;
  });

  // LMB = sculpt. MMB/RMB handled by OrbitControls (orbit / pan).
  renderer.domElement.addEventListener("mousedown", e => {
    if (e.button !== 0) return;
    refreshMouse(e);
    isPainting = true;
  });

  renderer.domElement.addEventListener("mouseup", e => {
    if (e.button !== 0) return;
    isPainting = false;
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

  // ── Resize ─────────────────────────────────────────────────────────────────
  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // ── Loop ───────────────────────────────────────────────────────────────────
  renderer.setAnimationLoop(() => {
    // Reset first — stats-gl patches this to mark the CPU profiling window start.
    renderer.info.reset();

    if (isPainting) {
      const hit = getUV();
      if (hit) {
        if (sculptMode === "smooth") sculpt.smooth(hit.u, hit.v);
        else sculpt.paint(hit.u, hit.v, sculptMode === "lower" ? -1 : 1);
        syncHeightmapToCPU(); // async, guarded — keeps CPU mirror current while sculpting
      }
    }

    // Center LOD on the orbit target, not the camera — terrain stays fixed
    // while orbiting. Switch to camera.position for first-person play mode.
    lod.update(controls.target);
    controls.update();
    renderer.render(scene, camera);

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
