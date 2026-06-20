/**
 * Octahedral Impostor Editor v3 — same pipeline as v2, custom inspector UI.
 * Entry: octahedral-v3.html
 */
import * as THREE from "three";
import {
  Fn, If, normalize, sub, mul, add, div, abs, vec2, vec3, vec4, sign, dot, cross,
  floor, fract, min, max, clamp, saturate, texture, cameraPosition,
  positionWorld, positionLocal, positionView, float, uniform, varying, select,
  length, negate, mix, smoothstep, fwidth, pow, sin, cos, normalWorld,
  tangentLocal, viewportCoordinate, uv,
} from "three/tsl";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { createUiHelpers } from "./custom-ui.js";
import {
  BAKE_SPHERE_MARGIN,
  bakeAtlases,
  createImpostorMaterials,
  hemiOctaEncodeCPU,
  countTris,
  STORAGE_KEY,
  LEGACY_STORAGE_KEY,
  QUALITY_PRESETS,
  loadV3State,
} from "./octahedral-core.js";

const MODEL_DIR = new URL("../models/", import.meta.url);
const modelUrl = (file) => new URL(file, MODEL_DIR).href;

function saveState(state) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
}

// ═══════════════════════════════════════════════════════════════════════════
//  Misc helpers
// ═══════════════════════════════════════════════════════════════════════════

function exportPNG(pixels, width, height, filename) {
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(width, height);
  for (let y = 0; y < height; y++) {
    const srcRow = (height - 1 - y) * width * 4;
    const dstRow = y * width * 4;
    img.data.set(pixels.subarray(srcRow, srcRow + width * 4), dstRow);
  }
  ctx.putImageData(img, 0, 0);
  canvas.toBlob((blob) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }, "image/png");
}

const CAM_PRESETS = {
  Front:  { az:   0, el: 15, dist: 11 },
  Side:   { az:  90, el: 15, dist: 11 },
  Top:    { az:   0, el: 75, dist: 11 },
  Hero:   { az:  35, el: 20, dist:  9 },
};

// ═══════════════════════════════════════════════════════════════════════════
//  Main
// ═══════════════════════════════════════════════════════════════════════════

export async function run() {
  // DOM refs
  const $ = (id) => document.getElementById(id);
  const tbStatus = $("tb-status");
  const tbModel  = $("tb-model");
  const tbMode   = $("tb-mode");
  const tbFreeze = $("tb-freeze");
  const tbOrbit  = $("tb-orbit");
  const tbQual   = $("tb-quality");
  const loading  = $("loading");
  const loadMsg  = $("loading-msg");
  const loadSub  = $("loading-sub");
  const dock     = $("dock");
  const zoomEl   = $("zoom");
  const zoomCv   = $("zoom-canvas");
  const zoomLbl  = $("zoom-label");
  const dropEl   = $("drop");
  const appEl    = $("app");
  const viewportEl = $("viewport");

  const setStatus = (msg, warn = false) => {
    tbStatus.textContent = msg;
    tbStatus.classList.toggle("warn", !!warn);
    tbStatus.classList.toggle("bad", !!warn);
    tbStatus.classList.toggle("on", !warn);
  };
  const showLoading = (visible, msg = "Working…", sub = "") => {
    loading.classList.toggle("show", visible);
    if (visible) { loadMsg.textContent = msg; loadSub.textContent = sub; }
  };

  setStatus("Initializing WebGPU…");

  // ── Renderer ───────────────────────────────────────────────────────────
  const renderer = new THREE.WebGPURenderer({ antialias: true });
  await renderer.init();
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // Required to enable per-mesh castShadowNode / castShadowPositionNode overrides.
  // Without this, the shadow pass uses the shared ShadowPassMaterial as-is and our
  // impostor casts a flat-quad shadow instead of the sun-view silhouette.
  renderer.shadowMap.transmitted = true;
  viewportEl.appendChild(renderer.domElement);
  renderer.domElement.style.touchAction = "none";

  function resizeRenderer() {
    const w = viewportEl.clientWidth;
    const h = viewportEl.clientHeight;
    if (w < 1 || h < 1) return;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  }

  const maxAniso = renderer.capabilities?.maxAnisotropy || 16;

  // ── Scene ──────────────────────────────────────────────────────────────
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87ceeb);
  // Fog is kept on the scene; the GUI toggle attaches/detaches it so changes
  // are free of recompile cost.
  const sceneFog = new THREE.Fog(0x87ceeb, 60, 220);
  scene.fog = sceneFog;

  const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 500);
  camera.position.set(0, 3, 10);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 1.2, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  resizeRenderer();

  // Lights — these drive the MeshStandardNodeMaterial for free
  const dirLight = new THREE.DirectionalLight(0xfff5e0, 3.0);
  dirLight.position.set(5, 10, 5);
  dirLight.castShadow = true;
  dirLight.shadow.mapSize.set(2048, 2048);
  dirLight.shadow.camera.near = 0.5;
  dirLight.shadow.camera.far = 80;
  const sh = 26;
  dirLight.shadow.camera.left = -sh; dirLight.shadow.camera.right = sh;
  dirLight.shadow.camera.top  =  sh; dirLight.shadow.camera.bottom = -sh;
  dirLight.shadow.bias = -0.0002;
  dirLight.shadow.normalBias = 0.025;
  dirLight.target.position.copy(controls.target);
  scene.add(dirLight); scene.add(dirLight.target);

  const hemiLight = new THREE.HemisphereLight(0x88bbee, 0x556633, 0.7);
  scene.add(hemiLight);
  const ambLight = new THREE.AmbientLight(0xc0d0e0, 0.35);
  scene.add(ambLight);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(80, 80),
    new THREE.MeshStandardMaterial({
      color: 0x5a7a4a, roughness: 0.9,
      polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
    }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // ── Loaders ────────────────────────────────────────────────────────────
  const gltfLoader = new GLTFLoader();
  const dracoLoader = new DRACOLoader();
  dracoLoader.setDecoderPath("https://www.gstatic.com/draco/versioned/decoders/1.5.7/");
  gltfLoader.setDRACOLoader(dracoLoader);

  function applyShadowToMeshes(root, cast, receive) {
    if (!root) return;
    root.traverse((c) => { if (c.isMesh) { c.castShadow = cast; c.receiveShadow = receive; } });
  }

  function extractBakeData(obj) {
    const data = [];
    obj.updateMatrixWorld(true);
    obj.traverse((child) => {
      if (!child.isMesh) return;
      const geo = child.geometry.clone();
      geo.applyMatrix4(child.matrixWorld);
      data.push({ geometry: geo, material: child.material });
    });
    return data;
  }
  function computeBounds(meshData) {
    const box = new THREE.Box3();
    for (const { geometry } of meshData) {
      geometry.computeBoundingBox();
      box.union(geometry.boundingBox);
    }
    const sphere = new THREE.Sphere();
    box.getBoundingSphere(sphere);
    return { sphere, box };
  }

  // ── State ──────────────────────────────────────────────────────────────
  let sourceGroup = null;
  let bakeMeshData = [];
  let sourceGroundY = 0;
  let impostor = null;
  let impUniforms = null;
  let atlasResult = null;
  let isBaking = false;
  let activeCells = null;
  let lastDockRedraw = 0;
  let currentModelName = "TorusKnot";
  let uiHidden = false;
  let uiRefresh = () => {};
  let frameCount = 0, lastFpsTime = performance.now(), fps = 0;

  function clearScene() {
    if (sourceGroup) { scene.remove(sourceGroup); sourceGroup = null; }
    if (impostor) {
      scene.remove(impostor);
      impostor.geometry.dispose();
      impostor = null;
    }
    if (atlasResult) {
      atlasResult.colorTex.dispose();
      atlasResult.normalTex.dispose();
      atlasResult.rmTex.dispose();
      atlasResult.depthTex.dispose();
      atlasResult = null;
    }
    impUniforms = null;
    activeCells = null;
    bakeMeshData = [];
    clearDockCanvases();
  }

  // ── Model loading ──────────────────────────────────────────────────────
  function loadPrimitive(type) {
    clearScene();
    let geo, mat;
    switch (type) {
      case "Sphere":
        geo = new THREE.SphereGeometry(1.2, 64, 64);
        mat = new THREE.MeshStandardMaterial({ color: 0x7fd0ff, roughness: 0.35, metalness: 0.15 });
        break;
      case "Torus":
        geo = new THREE.TorusGeometry(1, 0.4, 32, 64);
        mat = new THREE.MeshStandardMaterial({ color: 0xdd8844, roughness: 0.4, metalness: 0.05 });
        break;
      case "Cylinder":
        geo = new THREE.CylinderGeometry(0.6, 0.8, 2.4, 32);
        mat = new THREE.MeshStandardMaterial({ color: 0x88cc66, roughness: 0.6, metalness: 0.0 });
        break;
      default:
        geo = new THREE.TorusKnotGeometry(1, 0.35, 256, 64);
        mat = new THREE.MeshStandardMaterial({ color: 0x7fd0ff, roughness: 0.35, metalness: 0.15 });
    }
    currentModelName = type;
    const mesh = new THREE.Mesh(geo, mat);
    sourceGroup = new THREE.Group();
    sourceGroup.add(mesh);
    bakeMeshData = extractBakeData(sourceGroup);
    const bounds = computeBounds(bakeMeshData);
    sourceGroundY = -bounds.box.min.y;
    sourceGroup.position.set(-3, sourceGroundY, 0);
    scene.add(sourceGroup);
    applyShadowToMeshes(sourceGroup, true, true);
    P.roughness = mat.roughness; P.metalness = mat.metalness;
  }

  async function setupGLBScene(gltf, name) {
    clearScene();
    currentModelName = name;
    gltf.scene.updateMatrixWorld(true);
    bakeMeshData = extractBakeData(gltf.scene);
    if (bakeMeshData.length === 0) {
      setStatus("No meshes found in model.", true);
      return;
    }
    const bounds = computeBounds(bakeMeshData);
    sourceGroundY = -bounds.box.min.y;
    const firstMat = bakeMeshData[0].material;
    const displayGroup = new THREE.Group();
    gltf.scene.traverse((c) => {
      if (!c.isMesh) return;
      const clone = c.clone();
      // GLB foliage often ships with transparent:true which kills depth sorting
      // when seen from above (alpha-blended leaves can't z-test each other,
      // back leaves render in front of nearer ones). Force alpha cutout +
      // double-sided so the reference looks right from any angle.
      if (clone.material && (clone.material.map || clone.material.alphaMap)) {
        clone.material = clone.material.clone();
        clone.material.transparent = false;
        clone.material.alphaTest = 0.5;
        clone.material.depthWrite = true;
        clone.material.side = THREE.DoubleSide;
      }
      displayGroup.add(clone);
    });
    sourceGroup = displayGroup;
    sourceGroup.position.set(-3, sourceGroundY, 0);
    scene.add(sourceGroup);
    applyShadowToMeshes(sourceGroup, true, true);
    P.roughness = firstMat.roughness !== undefined ? firstMat.roughness : 0.5;
    P.metalness = firstMat.metalness !== undefined ? firstMat.metalness : 0.0;
  }

  async function loadGLBPath(path, name) {
    setStatus(`Loading ${name}…`);
    try {
      const gltf = await gltfLoader.loadAsync(path);
      await setupGLBScene(gltf, name);
      setStatus(`Loaded ${name}`);
    } catch (e) { setStatus("Load error: " + e.message, true); console.error(e); }
  }
  async function loadGLB(file) {
    setStatus(`Loading ${file.name}…`);
    const url = URL.createObjectURL(file);
    try {
      const gltf = await gltfLoader.loadAsync(url);
      URL.revokeObjectURL(url);
      await setupGLBScene(gltf, file.name.replace(/\.[^.]+$/, ""));
      setStatus(`Loaded ${file.name}`);
    } catch (e) {
      URL.revokeObjectURL(url);
      setStatus("Load error: " + e.message, true); console.error(e);
    }
  }

  // ── Rebake ─────────────────────────────────────────────────────────────
  async function rebake() {
    if (isBaking || bakeMeshData.length === 0) return;
    isBaking = true;
    showLoading(true, "Baking atlas…", "color · normal · roughness/metalness · depth");
    setStatus("Baking…");

    if (impostor) {
      scene.remove(impostor);
      impostor.geometry.dispose();
      impostor = null;
    }
    if (atlasResult) {
      atlasResult.colorTex.dispose();
      atlasResult.normalTex.dispose();
      atlasResult.rmTex.dispose();
      atlasResult.depthTex.dispose();
    }

    try {
      atlasResult = await bakeAtlases(renderer, bakeMeshData, {
        grid: P.grid,
        atlasSize: P.atlasSize,
        maxAniso,
        cellPad: P.cellPad,
        fullOctahedral: P.fullOctahedral,
      });

      loadSub.textContent = "Building impostor materials…";
      const built = createImpostorMaterials(
        {
          colorTex:  atlasResult.colorTex,
          normalTex: atlasResult.normalTex,
          rmTex:     atlasResult.rmTex,
          depthTex:  atlasResult.depthTex,
        },
        {
          impostorScale: atlasResult.radius,
          gridVal:       P.grid,
          atlasSize:     P.atlasSize,
          cellPad:       P.cellPad,
          fullOctahedral: P.fullOctahedral,
        },
      );
      impUniforms = built.uniforms;

      const geo = new THREE.PlaneGeometry(1, 1);
      impostor = new THREE.Mesh(geo, built.mainMat);

      const R = atlasResult.radius;
      // Lay out reference and impostor with ~2.5R clearance, scaled to model size
      const gap = Math.max(6, R * 2.5);
      sourceGroup.position.set(-gap / 2, sourceGroundY, 0);

      const srcWorldCenter = new THREE.Vector3()
        .copy(atlasResult.center)
        .add(sourceGroup.position);
      const impWorldCenter = srcWorldCenter.clone().add(new THREE.Vector3(gap, 0, 0));
      impWorldCenter.y += R * (1 - 1 / BAKE_SPHERE_MARGIN);

      impostor.position.copy(impWorldCenter);
      impostor.scale.setScalar(2 * R);

      // Re-aim camera at midpoint and back off based on model size
      const mid = new THREE.Vector3().addVectors(srcWorldCenter, impWorldCenter).multiplyScalar(0.5);
      controls.target.set(mid.x, Math.max(R * 0.45, 0.8), mid.z);
      dirLight.target.position.copy(controls.target);
      // Fit both meshes in the horizontal frame: total span = gap + 2R, leave 15% margin
      const aspect = viewportEl.clientWidth / Math.max(viewportEl.clientHeight, 1);
      const halfFovV = (camera.fov * 0.5 * Math.PI) / 180;
      const halfFovH = Math.atan(Math.tan(halfFovV) * aspect);
      const span = gap + R * 2;
      const fitDist = (span * 0.58) / Math.tan(halfFovH);
      const camDir = camera.position.clone().sub(controls.target).normalize();
      if (camDir.lengthSq() < 0.01) camDir.set(0, 0.3, 1).normalize();
      camera.position.copy(controls.target).addScaledVector(camDir, fitDist);
      controls.update();
      impostor.frustumCulled = false;
      impUniforms.uCenter.value.copy(impWorldCenter);
      impostor.castShadow = true;
      impostor.receiveShadow = true;
      scene.add(impostor);

      loadSub.textContent = "Compiling shaders…";
      await renderer.compileAsync(scene, camera);
      computeActiveCells();
      drawAtlasDock();
      syncParams();
      updateTopbar();
      setStatus(`Ready · ${currentModelName}`);
    } catch (e) {
      setStatus("Bake error: " + e.message, true);
      console.error(e);
      atlasResult = null;
      activeCells = null;
      clearDockCanvases();
    }
    showLoading(false);
    isBaking = false;
  }

  // ── Atlas dock ─────────────────────────────────────────────────────────
  function clearDockCanvases() {
    for (const id of ["dock-color", "dock-normal", "dock-rm", "dock-depth"]) {
      const c = $(id);
      if (!c) continue;
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#12121a";
      ctx.fillRect(0, 0, c.width, c.height);
    }
  }

  function computeActiveCells() {
    if (!atlasResult || !impUniforms || P.fullOctahedral) { activeCells = null; return; }
    const center = impUniforms.uCenter.value;
    const vd = new THREE.Vector3().subVectors(camera.position, center).normalize();
    const enc = hemiOctaEncodeCPU(vd);
    const S = P.grid, Nm1 = S - 1;
    const gx = enc.u * Nm1, gy = enc.v * Nm1;
    const fx = Math.min(Math.floor(gx), Nm1), fy = Math.min(Math.floor(gy), Nm1);
    const frx = gx - fx, fry = gy - fy;
    const wx = Math.min(1 - frx, 1 - fry);
    const wy = Math.abs(frx - fry);
    const wz = Math.min(frx, fry);
    const ww = frx > fry ? 1 : 0;
    activeCells = {
      s1: [fx, fy],
      s2: [Math.min(fx + (ww ? 1 : 0), Nm1), Math.min(fy + (ww ? 0 : 1), Nm1)],
      s3: [Math.min(fx + 1, Nm1), Math.min(fy + 1, Nm1)],
      weights: [wx, wy, wz],
    };
  }

  function drawAtlasDock() {
    if (!atlasResult) { clearDockCanvases(); return; }
    const w = atlasResult.atlasSize;
    const S = atlasResult.grid;
    const sz = 148;
    const showGrid = P.showGrid;
    const showActive = P.showActive && !P.fullOctahedral;

    const drawLayer = (pixels, canvasId, overlay) => {
      const c = $(canvasId);
      if (!c || !pixels) return;
      const ctx = c.getContext("2d");
      const tmp = document.createElement("canvas");
      tmp.width = w; tmp.height = w;
      const clamped = new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, w * w * 4);
      tmp.getContext("2d").putImageData(new ImageData(clamped, w, w), 0, 0);
      ctx.clearRect(0, 0, sz, sz);
      ctx.save();
      ctx.translate(0, sz); ctx.scale(1, -1);
      ctx.drawImage(tmp, 0, 0, sz, sz);
      ctx.restore();

      if (overlay && showGrid) {
        const step = sz / S;
        ctx.strokeStyle = "rgba(255,255,255,0.22)";
        ctx.lineWidth = 0.5;
        for (let i = 0; i <= S; i++) {
          const p = i * step;
          ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, sz); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(sz, p); ctx.stroke();
        }
      }
      if (overlay && showActive && activeCells) {
        const step = sz / S;
        const { s1, s2, s3, weights } = activeCells;
        [
          [s1, weights[0], "255,80,80"],
          [s2, weights[1], "80,255,80"],
          [s3, weights[2], "80,80,255"],
        ].forEach(([cell, wt, col]) => {
          if (wt < 0.01) return;
          const a = 0.14 + wt * 0.5;
          const x = cell[0] * step;
          const y = (S - 1 - cell[1]) * step;
          ctx.fillStyle = `rgba(${col},${a})`;
          ctx.fillRect(x, y, step, step);
          ctx.strokeStyle = `rgba(${col},0.95)`;
          ctx.lineWidth = 1;
          ctx.strokeRect(x + 0.5, y + 0.5, step - 1, step - 1);
          ctx.fillStyle = "rgba(255,255,255,0.92)";
          ctx.font = "bold 8px monospace";
          ctx.fillText(((wt * 100) | 0) + "%", x + 2, y + step - 2);
        });
      }
    };

    drawLayer(atlasResult.colorPixels,  "dock-color",  true);
    drawLayer(atlasResult.normalPixels, "dock-normal", true);
    drawLayer(atlasResult.rmPixels,     "dock-rm",     true);
    drawLayer(atlasResult.depthPixels,  "dock-depth",  true);
  }

  function openZoomFromEvent(e, pixels, label) {
    if (!atlasResult || !pixels) return;
    const w = atlasResult.atlasSize;
    const S = atlasResult.grid;
    const cs = w / S;
    const pd = atlasResult.cellPad;
    const r = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    const col = Math.min(Math.floor(x * S), S - 1);
    const row = S - 1 - Math.min(Math.floor(y * S), S - 1);
    const tmp = document.createElement("canvas");
    tmp.width = w; tmp.height = w;
    const clamped = new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, w * w * 4);
    tmp.getContext("2d").putImageData(new ImageData(clamped, w, w), 0, 0);
    const ctx = zoomCv.getContext("2d");
    ctx.clearRect(0, 0, 220, 220);
    ctx.imageSmoothingEnabled = false;
    ctx.save();
    ctx.translate(0, 220); ctx.scale(1, -1);
    ctx.drawImage(tmp, col * cs, row * cs, cs, cs, 0, 0, 220, 220);
    ctx.restore();
    const pp = (pd / cs) * 220;
    if (pp > 0 && pd > 0) {
      ctx.strokeStyle = "rgba(255,100,100,0.7)";
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.strokeRect(pp, pp, 220 - pp * 2, 220 - pp * 2);
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(255,100,100,0.55)";
      ctx.font = "9px monospace";
      ctx.fillText(`pad=${pd}px`, 2, 10);
    }
    zoomLbl.textContent = `${label} cell (${col},${row})`;
    zoomEl.style.display = "block";
    zoomEl.style.left = `${Math.min(e.clientX + 10, innerWidth - 240)}px`;
    zoomEl.style.top  = `${Math.min(e.clientY + 10, innerHeight - 260)}px`;
    clearTimeout(openZoomFromEvent._t);
    openZoomFromEvent._t = setTimeout(() => { zoomEl.style.display = "none"; }, 5000);
  }

  function attachDockHandlers() {
    const pairs = [
      ["dock-color",  () => atlasResult?.colorPixels,  "Color"],
      ["dock-normal", () => atlasResult?.normalPixels, "Normal"],
      ["dock-rm",     () => atlasResult?.rmPixels,     "R/M"],
      ["dock-depth",  () => atlasResult?.depthPixels,  "Depth"],
    ];
    for (const [id, getPx, label] of pairs) {
      const el = $(id);
      if (!el) continue;
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        const px = getPx();
        if (px) openZoomFromEvent(e, px, label);
      });
    }
    document.addEventListener("click", (e) => {
      if (!e.target.closest("#dock") && !e.target.closest("#zoom")) zoomEl.style.display = "none";
    });
  }

  // ── Stats / topbar ─────────────────────────────────────────────────────
  function updateStats() {
    const q = (id, t) => { const el = $(id); if (el) el.textContent = t; };
    q("s-fps", String(fps));
    if (atlasResult) {
      q("s-atlas", `${atlasResult.atlasSize}²`);
      q("s-grid",  `${atlasResult.grid}×${atlasResult.grid}`);
      q("s-cell",  `${Math.floor(atlasResult.atlasSize / atlasResult.grid)}px`);
    } else {
      q("s-atlas", "—"); q("s-grid", "—"); q("s-cell", "—");
    }
    q("s-tris", bakeMeshData.length ? countTris(bakeMeshData).toLocaleString() : "—");
    const t = controls.target;
    const dx = camera.position.x - t.x, dz = camera.position.z - t.z;
    q("s-yaw", `${(((Math.atan2(dx, dz) * 180) / Math.PI + 360) % 360).toFixed(0)}°`);
    if (activeCells && !P.fullOctahedral) {
      const { s1, s2, s3 } = activeCells;
      q("s-active", `(${s1[0]},${s1[1]})·(${s2[0]},${s2[1]})·(${s3[0]},${s3[1]})`);
    } else q("s-active", P.fullOctahedral ? "full" : "—");
  }
  function updateTopbar() {
    tbModel.textContent = currentModelName;
    tbQual.textContent  = P.quality;
    tbMode.textContent  = P.debugMode === 1 ? "Normals" : P.debugMode === 2 ? "Raw" : "PBR";
    tbMode.classList.toggle("on",   P.debugMode === 0);
    tbMode.classList.toggle("warn", P.debugMode !== 0);
    tbFreeze.textContent = P.freeze ? "Frozen" : "Live";
    tbFreeze.classList.toggle("warn", P.freeze);
    tbOrbit.textContent  = P.autoOrbit ? "Orbit" : "Manual";
    tbOrbit.classList.toggle("on", P.autoOrbit);
  }

  // ── Params + sync ──────────────────────────────────────────────────────
  const saved = loadV3State();
  const P = {
    model: "TorusKnot",
    grid: 12,
    atlasSize: 2048,
    cellPad: 4,
    fullOctahedral: false,
    quality: "High",
    showOriginal: true,
    showImpostor: true,
    showAtlas: true,
    showGrid: false,
    showActive: true,
    sunAzimuth: 225,
    sunElevation: 56,
    sunIntensity: 3.0,
    exposure: 1.0,
    fog: true,
    fogNear: 60,
    fogFar: 220,
    roughness: 0.35,
    metalness: 0.15,
    normalStr: 1.0,
    alphaCutoff: 0.5,
    edgeSmooth: 1.5,
    parallaxStr: 0.05,
    dither: false,
    normRmBary: false,
    alphaToCoverage: false,
    windAmp: 0.0,
    windFreq: 1.5,
    translucency: 0.0,
    translucencyPower: 3.0,
    translucencyTint: "#e6ffb3",
    debugMode: 0,
    freeze: false,
    autoOrbit: false,
    ...saved,
  };

  function syncParams() {
    const az = (P.sunAzimuth * Math.PI) / 180;
    const el = (P.sunElevation * Math.PI) / 180;
    const d = new THREE.Vector3(
      Math.cos(el) * Math.sin(az),
      Math.sin(el),
      Math.cos(el) * Math.cos(az),
    ).normalize();
    dirLight.position.copy(d).multiplyScalar(20);
    dirLight.target.position.copy(controls.target);
    dirLight.intensity = P.sunIntensity;
    renderer.toneMappingExposure = P.exposure;

    scene.fog = P.fog ? sceneFog : null;
    sceneFog.near = P.fogNear;
    sceneFog.far = P.fogFar;

    // Apply quality preset onto rendering uniforms
    const preset = QUALITY_PRESETS[P.quality] || QUALITY_PRESETS.High;

    if (impUniforms) {
      impUniforms.uNormStr.value     = P.normalStr;
      impUniforms.uAlphaCutoff.value = P.alphaCutoff;
      impUniforms.uEdgeSmooth.value  = preset.edgeSmooth;
      impUniforms.uParallaxStr.value = P.parallaxStr;
      impUniforms.uUseBary.value     = preset.useBary;
      impUniforms.uNormRmBary.value  = P.normRmBary ? 1 : 0;
      impUniforms.uUseParallax.value = preset.useParallax;
      impUniforms.uUseDither.value   = P.dither ? 1 : 0;
      impUniforms.uDebugMode.value   = P.debugMode;
      impUniforms.uFreeze.value      = P.freeze ? 1 : 0;
      impUniforms.uWindAmp.value     = P.windAmp;
      impUniforms.uWindFreq.value    = P.windFreq;
      impUniforms.uTransAmt.value    = P.translucency;
      impUniforms.uTransPow.value    = P.translucencyPower;
      const tc = new THREE.Color(P.translucencyTint);
      impUniforms.uTransTint.value.set(tc.r, tc.g, tc.b);

      impUniforms.uSunDir.value.copy(d);
      const lc = dirLight.color;
      impUniforms.uSunColor.value.set(
        lc.r * P.sunIntensity, lc.g * P.sunIntensity, lc.b * P.sunIntensity,
      );
    }

    if (sourceGroup) {
      sourceGroup.visible = P.showOriginal;
      sourceGroup.traverse((c) => {
        if (c.isMesh && c.material && c.material.isMeshStandardMaterial) {
          c.material.roughness = P.roughness;
          c.material.metalness = P.metalness;
        }
      });
    }
    if (impostor) {
      impostor.visible = P.showImpostor;
      // alphaToCoverage flips between the binary cutout pipeline and the
      // MSAA-stochastic-coverage pipeline. Toggling requires a recompile,
      // which three.js triggers via needsUpdate.
      if (impostor.material.alphaToCoverage !== P.alphaToCoverage) {
        impostor.material.alphaToCoverage = P.alphaToCoverage;
        impostor.material.needsUpdate = true;
      }
    }
    const atlasPanel = document.getElementById("atlas-panel");
    if (atlasPanel && !uiHidden) atlasPanel.style.display = P.showAtlas ? "" : "none";
    if (dock && !uiHidden) dock.style.display = P.showAtlas ? "flex" : "none";

    // Save and refresh topbar
    const persist = { ...P }; delete persist.freeze; delete persist.debugMode;
    saveState(persist);
    updateTopbar();
    uiRefresh();
  }

  function toggleFreeze() {
    P.freeze = !P.freeze;
    if (P.freeze && impUniforms) {
      const camLocal = new THREE.Vector3()
        .subVectors(camera.position, impUniforms.uCenter.value)
        .divideScalar(impUniforms.uScale.value);
      impUniforms.uFreezeDir.value.copy(camLocal.normalize());
    }
    syncParams();
    uiRefresh();
  }

  function applyCameraPreset(name) {
    const p = CAM_PRESETS[name]; if (!p) return;
    const az = (p.az * Math.PI) / 180, el = (p.el * Math.PI) / 180;
    const t = controls.target;
    const dir = new THREE.Vector3(
      Math.cos(el) * Math.sin(az),
      Math.sin(el),
      Math.cos(el) * Math.cos(az),
    );
    camera.position.copy(t).addScaledVector(dir, p.dist);
    controls.update();
  }

  function cycleQuality() {
    const order = ["Low", "Medium", "High"];
    const i = (order.indexOf(P.quality) + 1) % order.length;
    P.quality = order[i];
    syncParams();
    uiRefresh();
  }

  function toggleUiHidden() {
    uiHidden = !uiHidden;
    appEl.classList.toggle("ui-hidden", uiHidden);
    resizeRenderer();
  }

  // ── File input ─────────────────────────────────────────────────────────
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = ".glb,.gltf";
  fileInput.style.display = "none";
  document.body.appendChild(fileInput);
  fileInput.addEventListener("change", async () => {
    if (fileInput.files.length) {
      await loadGLB(fileInput.files[0]);
      updateTopbar();
      await rebake();
    }
    fileInput.value = "";
  });

  // ── Custom inspector UI ────────────────────────────────────────────────
  const inspector = document.getElementById("inspector-scroll");
  const ui = createUiHelpers();
  uiRefresh = () => ui.refreshAll();

  const GLB_MODELS = {
    "Pine 2":      modelUrl("pine2.glb"),
    "Pine 3":      modelUrl("pine3.glb"),
    "Cherry Tree": modelUrl("japanese_cherry_tree.glb"),
    "Cypress":     modelUrl("cypress_tree_compressed.glb"),
    "Palm Tree":   modelUrl("realistic_palm_tree_free.glb"),
    "Rock":        modelUrl("rock_boulder.glb"),
  };
  const ALL_MODELS = ["TorusKnot", "Sphere", "Torus", "Cylinder", ...Object.keys(GLB_MODELS)];
  const modelOpts = {};
  for (const m of ALL_MODELS) modelOpts[m] = m;

  const fModel = ui._section(inspector, "Model");
  ui._dropdown(fModel, P, "model", {
    label: "Model",
    options: modelOpts,
    onChange: async () => {
      if (GLB_MODELS[P.model]) await loadGLBPath(GLB_MODELS[P.model], P.model);
      else loadPrimitive(P.model);
      updateTopbar();
      await rebake();
    },
  });
  ui._button(fModel, { title: "Load GLB…", onClick: () => fileInput.click() });
  ui._button(fModel, { title: "Rebake atlas [B]", onClick: () => rebake() });
  ui._toggle(fModel, P, "showOriginal", { label: "Show original", onChange: syncParams });
  ui._toggle(fModel, P, "showImpostor", { label: "Show impostor", onChange: syncParams });

  const fAtlas = ui._section(inspector, "Atlas (auto-rebake)");
  ui._dropdown(fAtlas, P, "grid", {
    label: "Grid",
    options: { "4": 4, "6": 6, "8": 8, "10": 10, "12": 12, "14": 14, "16": 16 },
    onChange: () => rebake(),
  });
  ui._dropdown(fAtlas, P, "atlasSize", {
    label: "Resolution",
    options: { "512": 512, "1024": 1024, "2048": 2048, "4096": 4096 },
    onChange: () => rebake(),
  });
  ui._slider(fAtlas, P, "cellPad", { label: "Cell padding", min: 0, max: 8, step: 1, onChange: () => rebake() });
  ui._toggle(fAtlas, P, "fullOctahedral", { label: "Full octahedral", onChange: () => rebake() });

  const fQual = ui._section(inspector, "Quality");
  ui._dropdown(fQual, P, "quality", {
    label: "Preset [Q]",
    options: { Low: "Low", Medium: "Medium", High: "High" },
    onChange: syncParams,
  });
  ui._slider(fQual, P, "alphaCutoff", { label: "Alpha cutoff", min: 0.05, max: 0.95, step: 0.01, onChange: syncParams });
  ui._slider(fQual, P, "parallaxStr", { label: "Parallax depth", min: 0, max: 0.3, step: 0.005, onChange: syncParams });
  ui._slider(fQual, P, "normalStr", { label: "Normal strength", min: 0, max: 1, step: 0.02, onChange: syncParams });
  ui._toggle(fQual, P, "dither", { label: "Dither cross-fade", onChange: syncParams });
  ui._toggle(fQual, P, "normRmBary", {
    label: "Blend normals/R/M",
    hint: "Barycentric normals & roughness can ghost at cell seams — leave off for foliage",
    onChange: syncParams,
  });
  ui._toggle(fQual, P, "alphaToCoverage", { label: "Alpha-to-coverage", onChange: syncParams });

  const fTree = ui._section(inspector, "Trees & foliage", false);
  ui._slider(fTree, P, "translucency", { label: "Back-light SSS", min: 0, max: 1.5, step: 0.02, onChange: syncParams });
  ui._slider(fTree, P, "translucencyPower", { label: "SSS sharpness", min: 1, max: 12, step: 0.5, onChange: syncParams });
  ui._color(fTree, P, "translucencyTint", { label: "SSS tint", onChange: syncParams });
  ui._slider(fTree, P, "windAmp", { label: "Wind amplitude", min: 0, max: 0.08, step: 0.002, onChange: syncParams });
  ui._slider(fTree, P, "windFreq", { label: "Wind frequency", min: 0.2, max: 4, step: 0.05, onChange: syncParams });

  const fSun = ui._section(inspector, "Lighting");
  ui._slider(fSun, P, "sunAzimuth", { label: "Sun azimuth", min: 0, max: 360, step: 1, onChange: syncParams });
  ui._slider(fSun, P, "sunElevation", { label: "Sun elevation", min: 5, max: 90, step: 0.5, onChange: syncParams });
  ui._slider(fSun, P, "sunIntensity", { label: "Sun intensity", min: 0.2, max: 5, step: 0.1, onChange: syncParams });
  ui._slider(fSun, P, "exposure", { label: "Exposure", min: 0.2, max: 3, step: 0.05, onChange: syncParams });
  ui._toggle(fSun, P, "fog", { label: "Fog", onChange: syncParams });
  ui._slider(fSun, P, "fogNear", { label: "Fog near", min: 0, max: 200, step: 1, onChange: syncParams });
  ui._slider(fSun, P, "fogFar", { label: "Fog far", min: 50, max: 500, step: 1, onChange: syncParams });

  const fMat = ui._section(inspector, "Original material", false);
  ui._slider(fMat, P, "roughness", { label: "Roughness", min: 0.05, max: 1, step: 0.01, onChange: syncParams });
  ui._slider(fMat, P, "metalness", { label: "Metalness", min: 0, max: 1, step: 0.01, onChange: syncParams });

  const fDbg = ui._section(inspector, "Debug / view");
  ui._dropdown(fDbg, P, "debugMode", {
    label: "Display",
    options: { "Full PBR": 0, "Normals [N]": 1, "Raw atlas [R]": 2 },
    onChange: syncParams,
  });
  ui._toggle(fDbg, P, "freeze", {
    label: "Freeze angle [F]",
    onChange: () => {
      if (P.freeze && impUniforms) {
        const camLocal = new THREE.Vector3()
          .subVectors(camera.position, impUniforms.uCenter.value)
          .divideScalar(impUniforms.uScale.value);
        impUniforms.uFreezeDir.value.copy(camLocal.normalize());
      }
      syncParams();
    },
  });
  ui._toggle(fDbg, P, "autoOrbit", { label: "Auto-orbit [O]", onChange: syncParams });
  ui._toggle(fDbg, P, "showAtlas", { label: "Show atlas dock", onChange: syncParams });
  ui._toggle(fDbg, P, "showGrid", { label: "Dock: grid lines", onChange: () => drawAtlasDock() });
  ui._toggle(fDbg, P, "showActive", { label: "Dock: active cells", onChange: () => drawAtlasDock() });

  const fCam = ui._section(inspector, "Camera", false);
  for (const name of Object.keys(CAM_PRESETS)) {
    ui._button(fCam, { title: name, onClick: () => applyCameraPreset(name) });
  }

  const fExp = ui._section(inspector, "Export", false);
  const mkExport = (key, label) => ui._button(fExp, {
    title: `${label} → PNG`,
    onClick: () => {
      if (!atlasResult) return;
      exportPNG(atlasResult[key], P.atlasSize, P.atlasSize,
        `${currentModelName}_${label}_${P.grid}x${P.grid}.png`);
    },
  });
  mkExport("colorPixels", "color");
  mkExport("normalPixels", "normal");
  mkExport("rmPixels", "rm");
  mkExport("depthPixels", "depth");

  document.getElementById("btn-load")?.addEventListener("click", () => fileInput.click());
  document.getElementById("btn-rebake")?.addEventListener("click", () => rebake());
  document.getElementById("btn-hide-ui")?.addEventListener("click", toggleUiHidden);

  attachDockHandlers();

  // ── Hotkeys ────────────────────────────────────────────────────────────
  addEventListener("keydown", (e) => {
    const tag = e.target.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    switch (e.code) {
      case "KeyN": P.debugMode = P.debugMode === 1 ? 0 : 1; syncParams(); uiRefresh(); break;
      case "KeyR": P.debugMode = P.debugMode === 2 ? 0 : 2; syncParams(); uiRefresh(); break;
      case "KeyF": toggleFreeze(); break;
      case "KeyO": P.autoOrbit = !P.autoOrbit; syncParams(); uiRefresh(); break;
      case "KeyB": rebake(); break;
      case "KeyQ": cycleQuality(); break;
      case "KeyH": toggleUiHidden(); break;
      case "Digit1": applyCameraPreset("Front"); break;
      case "Digit2": applyCameraPreset("Side");  break;
      case "Digit3": applyCameraPreset("Top");   break;
      case "Digit4": applyCameraPreset("Hero");  break;
    }
  });

  // ── Drag-and-drop ──────────────────────────────────────────────────────
  let dragCounter = 0;
  addEventListener("dragenter", (e) => { e.preventDefault(); dragCounter++; dropEl.style.display = "flex"; });
  addEventListener("dragleave", (e) => { e.preventDefault(); dragCounter--; if (dragCounter <= 0) { dropEl.style.display = "none"; dragCounter = 0; } });
  addEventListener("dragover",  (e) => e.preventDefault());
  addEventListener("drop", async (e) => {
    e.preventDefault(); dragCounter = 0; dropEl.style.display = "none";
    const file = e.dataTransfer.files[0];
    if (file && /\.(glb|gltf)$/i.test(file.name)) {
      await loadGLB(file);
      updateTopbar();
      await rebake();
    }
  });

  // ── Resize ─────────────────────────────────────────────────────────────
  addEventListener("resize", () => resizeRenderer());

  // ── Init + render loop ─────────────────────────────────────────────────
  if (GLB_MODELS[P.model]) await loadGLBPath(GLB_MODELS[P.model], P.model);
  else loadPrimitive(P.model);
  syncParams();
  await rebake();

  const _orbitAxis = new THREE.Vector3(0, 1, 0);
  const startTime = performance.now();

  renderer.setAnimationLoop(() => {
    if (P.autoOrbit) {
      const offset = camera.position.clone().sub(controls.target);
      offset.applyAxisAngle(_orbitAxis, 0.005);
      camera.position.copy(controls.target).add(offset);
    }
    controls.update();

    // Wind/animation time
    if (impUniforms) {
      impUniforms.uTime.value = (performance.now() - startTime) / 1000;
    }

    updateStats();

    const now = performance.now();
    if (now - lastDockRedraw >= 100) {
      lastDockRedraw = now;
      if (atlasResult && impUniforms) computeActiveCells();
      if (P.showAtlas && atlasResult && (P.showGrid || P.showActive)) drawAtlasDock();
    }

    frameCount++;
    if (now - lastFpsTime >= 500) {
      fps = Math.round(frameCount / ((now - lastFpsTime) / 1000));
      frameCount = 0; lastFpsTime = now;
    }

    renderer.render(scene, camera);
  });
}
