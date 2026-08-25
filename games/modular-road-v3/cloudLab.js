/**
 * Cloud lab — tuning + measurement harness for `modularRoadClouds.js`.
 *
 * Exists because the thing that has to be judged is a fly-through, and the game is a slow
 * way to get a camera inside a cloud. Here the camera is free, the four viewpoints that
 * actually matter are one keypress away, and the GPU cost of the cloud pass is on screen
 * while you drag a slider.
 *
 * Intentionally standalone: no v3 engine, no terrain, no post-FX. Just a horizon plane, a
 * few scale references and the deck, so the numbers on screen are the cloud pass and not
 * somebody else's frame.
 */
import * as THREE from "three/webgpu";
import { Fn, vec3, vec4, positionWorld, uniform, mix, smoothstep, normalize, dot, max, pow } from "three/tsl";
import { createModularRoadClouds, CLOUD_LAYER, CLOUD_DEFAULTS } from "./modularRoadClouds.js";

/** Camera presets — the four cases that actually decide whether this works. */
const VIEWPOINTS = {
  // Ground level looking up at the deck: the classic "is it a nice sky" test.
  below:   { pos: [0, 18, 220],  yaw: Math.PI, pitch: 0.30 },
  // Inside the deck. This is the case the editor's fixed step count cannot serve.
  inside:  { pos: [0, 360, 40],  yaw: Math.PI, pitch: 0.02 },
  // Looking down on the tops from above.
  above:   { pos: [0, 700, 260], yaw: Math.PI, pitch: -0.42 },
  // Just under the base, looking along it — the longest in-slab rays, worst case for
  // step count and the one that exposes a bad empty-space skip.
  grazing: { pos: [0, 250, 400], yaw: Math.PI, pitch: 0.06 },
};

export async function startCloudLab() {
  const boot = document.getElementById("boot");

  // ── Device ─────────────────────────────────────────────────────────────────────────
  if (!navigator.gpu) throw new Error("WebGPU not available in this browser.");
  const adapter = await navigator.gpu.requestAdapter({ featureLevel: "compatibility" });
  if (!adapter) throw new Error("No WebGPU adapter.");
  const device = await adapter.requestDevice({ requiredFeatures: [...adapter.features] });
  const hasTimestamps = device.features.has("timestamp-query");

  // `trackTimestamp` is a BACKEND construction option — setting it on the renderer after
  // the fact does nothing except make resolveTimestampsAsync warn and return undefined.
  const renderer = new THREE.WebGPURenderer({
    antialias: true, device, trackTimestamp: hasTimestamps,
  });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  document.body.appendChild(renderer.domElement);
  await renderer.init();

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.5, 8192);

  // ── Sky dome ───────────────────────────────────────────────────────────────────────
  // A plain analytic gradient with a sun disc. The clouds need something behind them and
  // an ambient colour that matches, but nothing here should compete for GPU time.
  const uSunDir = uniform(new THREE.Vector3(0.42, 0.55, 0.72).normalize());
  const SKY_ZENITH = new THREE.Color(0x3f78c8);
  const SKY_HORIZON = new THREE.Color(0xc9dcef);
  const uZenith = uniform(SKY_ZENITH.clone());
  const uHorizon = uniform(SKY_HORIZON.clone());

  const skyMat = new THREE.MeshBasicNodeMaterial();
  skyMat.side = THREE.BackSide;
  skyMat.depthWrite = false;
  skyMat.fog = false;
  skyMat.colorNode = Fn(() => {
    const dir = normalize(positionWorld);
    const t = smoothstep(-0.06, 0.5, dir.y);
    const col = mix(uHorizon, uZenith, t).toVar();
    // Sun disc + a broad glow, so the phase function has something to point at.
    const mu = max(dot(dir, uSunDir), 0.0);
    col.addAssign(vec3(1.0, 0.93, 0.78).mul(pow(mu, 900.0).mul(14.0)));
    col.addAssign(vec3(1.0, 0.88, 0.7).mul(pow(mu, 12.0).mul(0.28)));
    return vec4(col, 1.0);
  })();
  const sky = new THREE.Mesh(new THREE.SphereGeometry(5000, 32, 16), skyMat);
  sky.frustumCulled = false;
  scene.add(sky);

  // ── Ground + scale references ──────────────────────────────────────────────────────
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(6000, 6000),
    new THREE.MeshBasicNodeMaterial({ color: 0x4a5a4c }),
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  // A grid so altitude reads, and a "car" box at the deck altitude so the half-res halo
  // (or its absence) is visible against cloud rather than against sky.
  const grid = new THREE.GridHelper(4000, 80, 0x33414d, 0x2a343d);
  grid.material.transparent = true;
  grid.material.opacity = 0.5;
  scene.add(grid);

  const carMat = new THREE.MeshBasicNodeMaterial({ color: 0xff5a2a });
  const car = new THREE.Mesh(new THREE.BoxGeometry(4.2, 1.3, 2.0), carMat);
  scene.add(car);
  const carShadowless = new THREE.Mesh(
    new THREE.BoxGeometry(4.2, 1.3, 2.0),
    new THREE.MeshBasicNodeMaterial({ color: 0x2ad4ff }),
  );
  scene.add(carShadowless);

  // ── Clouds ─────────────────────────────────────────────────────────────────────────
  const clouds = createModularRoadClouds({ renderer, scene, camera, seed: 137 });
  scene.add(clouds.mesh);

  const sBake = document.getElementById("s-bake");
  clouds.ready.then((r) => {
    sBake.textContent = r.error ? "FAILED (see console)" : `${Math.round(r.ms)} ms (worker)`;
    sBake.className = r.error ? "warn" : "good";
  });

  // ── Free-fly camera ────────────────────────────────────────────────────────────────
  const cam = { yaw: Math.PI, pitch: 0.3, speed: 60 };
  function applyView(name) {
    const v = VIEWPOINTS[name];
    if (!v) return;
    camera.position.set(...v.pos);
    cam.yaw = v.yaw; cam.pitch = v.pitch;
  }
  applyView("below");

  let dragging = false, lastX = 0, lastY = 0;
  renderer.domElement.addEventListener("pointerdown", (e) => {
    dragging = true; lastX = e.clientX; lastY = e.clientY;
    renderer.domElement.setPointerCapture(e.pointerId);
  });
  renderer.domElement.addEventListener("pointerup", (e) => {
    dragging = false;
    try { renderer.domElement.releasePointerCapture(e.pointerId); } catch {}
  });
  renderer.domElement.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    cam.yaw -= (e.clientX - lastX) * 0.0035;
    cam.pitch = THREE.MathUtils.clamp(cam.pitch - (e.clientY - lastY) * 0.0035, -1.5, 1.5);
    lastX = e.clientX; lastY = e.clientY;
  });

  // Movement on e.code (physical key) so WASD works on AZERTY too; the viewpoint digits
  // and the panel toggle read e.key, which is the printed label.
  const held = new Set();
  addEventListener("keydown", (e) => {
    held.add(e.code);
    const k = e.key.toLowerCase();
    if (k === "1") applyView("below");
    if (k === "2") applyView("inside");
    if (k === "3") applyView("above");
    if (k === "4") applyView("grazing");
    if (k === "c") clouds.setEnabled(!clouds.enabled);   // zero-cost disable test
    if (k === "h") {
      const h = document.getElementById("hud");
      h.style.display = h.style.display === "none" ? "" : "none";
    }
  });
  addEventListener("keyup", (e) => held.delete(e.code));
  addEventListener("blur", () => held.clear());

  const _fwd = new THREE.Vector3(), _right = new THREE.Vector3();
  const _up = new THREE.Vector3(0, 1, 0);
  function flyStep(dt) {
    _fwd.set(
      Math.sin(cam.yaw) * Math.cos(cam.pitch),
      Math.sin(cam.pitch),
      Math.cos(cam.yaw) * Math.cos(cam.pitch),
    ).normalize();
    _right.crossVectors(_fwd, _up).normalize();
    const boost = held.has("ShiftLeft") || held.has("ShiftRight") ? 5 : 1;
    const v = cam.speed * boost * dt;
    if (held.has("KeyW")) camera.position.addScaledVector(_fwd, v);
    if (held.has("KeyS")) camera.position.addScaledVector(_fwd, -v);
    if (held.has("KeyD")) camera.position.addScaledVector(_right, v);
    if (held.has("KeyA")) camera.position.addScaledVector(_right, -v);
    if (held.has("KeyE")) camera.position.y += v;
    if (held.has("KeyQ")) camera.position.y -= v;
    camera.lookAt(
      camera.position.x + _fwd.x, camera.position.y + _fwd.y, camera.position.z + _fwd.z,
    );
    // Park the scale references just ahead of the camera so they are always in frame.
    car.position.copy(camera.position).addScaledVector(_fwd, 26).addScaledVector(_right, -5);
    carShadowless.position.copy(camera.position).addScaledVector(_fwd, 70).addScaledVector(_right, 9);
  }

  // ── Controls ───────────────────────────────────────────────────────────────────────
  const P = clouds.params;
  const SPECS = {
    "g-shape": [
      ["base", 0, 900, 5], ["thickness", 40, 700, 5],
      ["coverage", 0, 1.4, 0.01], ["coverageBias", -0.4, 0.4, 0.01],
      ["densityMul", 0.01, 0.4, 0.005], ["erode", 0, 0.9, 0.01],
      ["typeBias", 0, 1, 0.01],
      ["clearRadius", 0, 200, 5], ["clearFloor", 0, 1, 0.01],
    ],
    "g-march": [
      ["minStep", 0.4, 12, 0.1], ["stepGrowth", 0, 0.2, 0.002],
      ["maxStep", 8, 160, 1], ["steps", 24, 192, 1],
      ["emptyStepMul", 1, 8, 0.1], ["maxDist", 800, 8000, 100],
      ["nearErode", 0, 0.9, 0.01], ["nearRange", 0, 900, 10],
    ],
    "g-light": [
      ["lightSteps", 1, 6, 1], ["lightConeLength", 10, 400, 5],
      ["lightAbsorb", 0.1, 4, 0.05], ["phaseG", 0, 0.95, 0.01],
      ["phaseW", 0, 1, 0.01], ["powder", 0, 1, 0.01],
      ["msAmount", 0, 1.5, 0.01], ["msExtinction", 0.1, 1, 0.01],
      ["msContribution", 0.1, 1, 0.01], ["msEccentricity", 0.1, 1, 0.01],
      ["sunIntensity", 0, 8, 0.05], ["ambientIntensity", 0, 3, 0.02],
      ["msFloor", 0, 0.8, 0.01], ["msFloorDepth", 0.05, 2, 0.05],
    ],
    "g-sky": [
      ["windDeg", 0, 360, 1], ["windSpeed", 0, 40, 0.5],
      ["aerialDensity", 0, 0.002, 0.00002], ["aerialAmount", 0, 1, 0.01],
      ["__sunElev", 2, 88, 1], ["__sunAzim", 0, 360, 1],
    ],
    "g-qual": [
      ["bufferScale", 0.25, 1, 0.05], ["upsampleDepthReject", 0, 40, 0.5],
      ["historyBlend", 0, 0.97, 0.01],
    ],
  };

  const extra = { __sunElev: 34, __sunAzim: 60 };
  const readouts = [];

  function fmt(v) {
    if (Math.abs(v) >= 100) return v.toFixed(0);
    if (Math.abs(v) >= 1) return v.toFixed(2).replace(/\.?0+$/, "");
    return v.toPrecision(2);
  }

  for (const [groupId, list] of Object.entries(SPECS)) {
    const host = document.getElementById(groupId);
    for (const [key, lo, hi, step] of list) {
      const isExtra = key.startsWith("__");
      const row = document.createElement("div");
      row.className = "row";
      const label = key.replace("__", "").replace(/([A-Z])/g, " $1").toLowerCase();
      row.innerHTML = `<label>${label}</label><input type="range" min="${lo}" max="${hi}" step="${step}"><span class="val"></span>`;
      const input = row.querySelector("input");
      const val = row.querySelector(".val");
      const get = () => (isExtra ? extra[key] : P[key]);
      const set = (v) => { if (isExtra) extra[key] = v; else P[key] = v; };
      input.value = get();
      val.textContent = fmt(get());
      input.addEventListener("input", () => {
        set(parseFloat(input.value));
        val.textContent = fmt(get());
        if (isExtra) syncSun();
      });
      readouts.push(() => { input.value = get(); val.textContent = fmt(get()); });
      host.appendChild(row);
    }
  }

  // Aerial checkbox (not a slider).
  {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `<label>aerial</label><input type="checkbox"><span class="val"></span>`;
    const cb = row.querySelector("input");
    cb.checked = P.aerialEnabled;
    cb.addEventListener("change", () => { P.aerialEnabled = cb.checked; });
    document.getElementById("g-sky").appendChild(row);
  }

  const _sunDir = new THREE.Vector3();
  function syncSun() {
    const el = THREE.MathUtils.degToRad(extra.__sunElev);
    const az = THREE.MathUtils.degToRad(extra.__sunAzim);
    _sunDir.set(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)).normalize();
    uSunDir.value.copy(_sunDir);
  }
  syncSun();

  for (const b of document.querySelectorAll("[data-view]")) {
    b.addEventListener("click", () => applyView(b.dataset.view));
  }
  document.getElementById("b-reset").addEventListener("click", () => {
    Object.assign(P, CLOUD_DEFAULTS);
    for (const r of readouts) r();
  });
  document.getElementById("b-copy").addEventListener("click", async () => {
    const out = {};
    for (const k of Object.keys(CLOUD_DEFAULTS)) if (P[k] !== CLOUD_DEFAULTS[k]) out[k] = P[k];
    const text = JSON.stringify(out, null, 2);
    try { await navigator.clipboard.writeText(text); } catch {}
    console.log("[CloudLab] changed params:\n" + text);
    const btn = document.getElementById("b-copy");
    btn.textContent = "copied ✓";
    setTimeout(() => { btn.textContent = "Copy params"; }, 1200);
  });

  // ── Resize ─────────────────────────────────────────────────────────────────────────
  addEventListener("resize", () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  // ── Loop ───────────────────────────────────────────────────────────────────────────
  const sGpu = document.getElementById("s-gpu");
  const sFps = document.getElementById("s-fps");
  const sAlt = document.getElementById("s-alt");
  const sIn = document.getElementById("s-in");
  boot.textContent = "";

  let last = performance.now();
  let fpsAcc = 0, fpsN = 0, gpuAcc = 0, gpuN = 0, hudT = 0;
  // The benchmark drives its own render calls; the idle loop must stand down or every
  // measured frame gets a second, untimed render mixed into it.
  let paused = false;

  renderer.setAnimationLoop(() => {
    if (paused) return;
    const now = performance.now();
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;

    flyStep(dt);
    clouds.update(dt, {
      sunDir: _sunDir,
      sunColor: 0xfff2dc,
      skyZenith: SKY_ZENITH,
      skyHorizon: SKY_HORIZON,
      hazeColor: SKY_HORIZON,
    });

    if (!clouds.renderFrame()) {
      camera.layers.disable(CLOUD_LAYER);
      renderer.render(scene, camera);
    }

    if (hasTimestamps) renderer.resolveTimestampsAsync(THREE.TimestampQuery.RENDER);

    fpsAcc += 1 / Math.max(dt, 1e-4); fpsN++;
    const g = renderer.info.render.timestamp;
    if (g > 0) { gpuAcc += g; gpuN++; }

    hudT += dt;
    if (hudT > 0.25) {
      hudT = 0;
      const fps = fpsAcc / Math.max(fpsN, 1);
      const gpu = gpuAcc / Math.max(gpuN, 1);
      fpsAcc = fpsN = gpuAcc = gpuN = 0;
      sFps.textContent = fps.toFixed(0);
      sGpu.textContent = hasTimestamps ? `${gpu.toFixed(2)} ms` : "n/a";
      sGpu.className = gpu > 8 ? "warn" : gpu > 0 ? "good" : "";
      sAlt.textContent = `${camera.position.y.toFixed(0)} m`;
      const inDeck = camera.position.y > P.base && camera.position.y < P.base + P.thickness;
      sIn.textContent = inDeck ? "yes" : "no";
      sIn.className = inDeck ? "good" : "";
    }
  });

  // Expose for automated inspection / screenshots.
  // ── A/B benchmark (lazy) ───────────────────────────────────────────────────────────
  // The editor deck's constructor bakes its volumes synchronously (~3.3 s), so the harness
  // is only imported and built when a benchmark is actually requested.
  let bench = null;
  async function getBenchmark() {
    if (bench) return bench;
    const { createCloudBenchmark } = await import("./cloudBenchmark.js");
    bench = createCloudBenchmark({
      renderer, scene, camera, clouds,
      sunDir: _sunDir,
      skyColors: { zenith: SKY_ZENITH, horizon: SKY_HORIZON },
    });
    return bench;
  }

  /** Position the camera from a viewpoint descriptor (name or explicit pose). */
  function applyPose(v) {
    if (typeof v === "string") applyView(v);
    else { camera.position.set(...v.pos); cam.yaw = v.yaw; cam.pitch = v.pitch; }
    // The idle loop is paused during a benchmark, so drive the camera matrix and the
    // scale-reference boxes here or they keep the pose from before the pause.
    flyStep(0);
  }

  /** Point the free-fly camera at a world position (used by scripted captures). */
  function lookAtPoint(x, y, z) {
    const dx = x - camera.position.x, dy = y - camera.position.y, dz = z - camera.position.z;
    cam.yaw = Math.atan2(dx, dz);
    cam.pitch = Math.atan2(dy, Math.hypot(dx, dz));
  }

  window.__cloudLab = {
    clouds, camera, renderer, scene, applyView, params: P, extra, syncSun, THREE,
    cam, lookAtPoint, getBenchmark, applyPose, VIEWPOINTS,
    setPaused: (v) => { paused = !!v; },
  };
  return window.__cloudLab;
}
