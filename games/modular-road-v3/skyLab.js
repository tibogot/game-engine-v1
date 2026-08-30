/**
 * Sky lab — time-of-day + altitude harness for `modularRoadSky.js`.
 *
 * Standalone: no v3 engine, no game. Adds the game's volumetric clouds and a
 * wet/chrome strip that samples a PMREM of this sky, so the four views that
 * decide the look include "through the deck" and "does the road reflect it".
 */
import * as THREE from "three/webgpu";
import { Fn as TSL_Fn, positionWorld as positionWorldTSL } from "three/tsl";
import {
  createModularRoadSky,
  SKY_DEFAULTS,
  TIME_PRESETS,
  applyTimePreset,
  skyBandName,
  sunDirFromTime,
  moonDirFromTime,
} from "./modularRoadSky.js";
import { createModularRoadClouds, CLOUD_LAYER } from "./modularRoadClouds.js";
import { createSkyAtmosphere } from "./modularRoadSkyAtmosphere.js";

const TRACK_Y = 40;

const VIEWPOINTS = {
  track:  { pos: [0, TRACK_Y + 2.4, -38], yaw: 0, pitch: 0.18 },
  down:   { pos: [0, TRACK_Y + 28, 0],    yaw: 0, pitch: -1.28 },
  inside: { pos: [0, 370, 40],            yaw: Math.PI, pitch: 0.02 },
  // Offset like the cloud lab — origin sits in a weather-map gap, so nadir
  // from (0,720) reads as empty peach. Look across the tops instead.
  above:  { pos: [0, 720, 260],           yaw: Math.PI, pitch: -0.42 },
};

function makeTrackStub(scene) {
  const asphalt = new THREE.MeshStandardNodeMaterial({
    color: 0x3a3a40, roughness: 0.82, metalness: 0.04,
  });
  const kerb = new THREE.MeshStandardNodeMaterial({
    color: 0xf2eadc, roughness: 0.45, metalness: 0.08,
    emissive: 0x1a1208, emissiveIntensity: 0.22,
  });
  const belly = new THREE.MeshStandardNodeMaterial({
    color: 0x1c1c22, roughness: 0.9, metalness: 0,
  });
  const wet = new THREE.MeshPhysicalNodeMaterial({
    color: 0x2e3238, roughness: 0.18, metalness: 0.02,
    clearcoat: 1, clearcoatRoughness: 0.06,
    envMapIntensity: 1.45,
  });
  const chrome = new THREE.MeshStandardNodeMaterial({
    color: 0xc8cdd4, roughness: 0.14, metalness: 1.0,
    envMapIntensity: 1.7,
  });

  const group = new THREE.Group();
  group.name = "TrackStub";

  function ribbon(z, len, y = TRACK_Y) {
    const deck = new THREE.Mesh(new THREE.BoxGeometry(12, 0.42, len), asphalt);
    deck.position.set(0, y, z);
    const under = new THREE.Mesh(new THREE.BoxGeometry(11.2, 0.18, len - 0.4), belly);
    under.position.set(0, y - 0.28, z);
    const kL = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.22, len), kerb);
    kL.position.set(-6.15, y + 0.26, z);
    const kR = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.22, len), kerb);
    kR.position.set(6.15, y + 0.26, z);
    const film = new THREE.Mesh(new THREE.BoxGeometry(10.2, 0.02, len - 2), wet);
    film.position.set(0, y + 0.23, z);
    const railL = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.42, len), chrome);
    railL.position.set(-5.55, y + 0.48, z);
    const railR = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.42, len), chrome);
    railR.position.set(5.55, y + 0.48, z);
    group.add(deck, under, kL, kR, film, railL, railR);
  }

  ribbon(0, 90);
  ribbon(92, 32, TRACK_Y - 4);
  scene.add(group);
  return group;
}

function fmtClock(h) {
  const wrapped = ((h % 24) + 24) % 24;
  const hh = Math.floor(wrapped);
  const mm = Math.round((wrapped - hh) * 60) % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function nearestPreset(tod) {
  let best = "hero", d = 99;
  for (const [name, t] of Object.entries(TIME_PRESETS)) {
    const dist = Math.min(Math.abs(tod - t), 24 - Math.abs(tod - t));
    if (dist < d) { d = dist; best = name; }
  }
  return d < 0.35 ? best : "";
}

export async function startSkyLab() {
  const boot = document.getElementById("boot");

  if (!navigator.gpu) throw new Error("WebGPU not available in this browser.");
  const adapter = await navigator.gpu.requestAdapter({ featureLevel: "compatibility" });
  if (!adapter) throw new Error("No WebGPU adapter.");
  const device = await adapter.requestDevice({ requiredFeatures: [...adapter.features] });
  const hasTimestamps = device.features.has("timestamp-query");

  const renderer = new THREE.WebGPURenderer({
    antialias: true, device, trackTimestamp: hasTimestamps,
  });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.92;
  document.body.appendChild(renderer.domElement);
  await renderer.init();

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.5, 8192);

  const sky = createModularRoadSky();
  scene.add(sky.mesh);

  // ── PHYSICAL ATMOSPHERE (A/B against the authored sky above) ───────────────────────
  // Its own dome on the same geometry, drawn instead of the authored one when enabled.
  // Kept as a straight swap so the two can be compared on identical frames — the whole
  // question is whether the physical model actually looks better, and the only honest way
  // to answer that is to flip between them without anything else changing.
  const atmo = createSkyAtmosphere({ renderer });
  const atmoMat = new THREE.MeshBasicNodeMaterial();
  atmoMat.side = THREE.BackSide;
  atmoMat.depthWrite = false;
  atmoMat.fog = false;
  atmoMat.colorNode = TSL_Fn(() => atmo.skyWithSun(positionWorldTSL))();
  const atmoDome = new THREE.Mesh(sky.mesh.geometry, atmoMat);
  atmoDome.frustumCulled = false;
  atmoDome.visible = false;
  scene.add(atmoDome);

  let usePhysicalSky = false;
  function setPhysicalSky(on) {
    usePhysicalSky = !!on;
    atmoDome.visible = usePhysicalSky;
    sky.mesh.visible = !usePhysicalSky;
    const b = document.getElementById("b-atmo");
    if (b) {
      b.textContent = usePhysicalSky ? "Sky: physical" : "Sky: authored";
      b.classList.toggle("on", usePhysicalSky);
    }
  }
  const P = sky.params;

  const hemi = new THREE.HemisphereLight(0x8eb0d0, 0x7ea8c4, 0.45);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff1d6, 1.8);
  sun.position.set(200, 400, 180);
  scene.add(sun);
  scene.add(sun.target);

  const track = makeTrackStub(scene);

  const grid = new THREE.GridHelper(80, 16, 0x4a5a6a, 0x2a343d);
  grid.position.y = TRACK_Y;
  grid.material.transparent = true;
  grid.material.opacity = 0.28;
  scene.add(grid);

  const car = new THREE.Mesh(
    new THREE.BoxGeometry(4.2, 1.3, 2.0),
    new THREE.MeshStandardNodeMaterial({
      color: 0xff5a2a, roughness: 0.32, metalness: 0.45, envMapIntensity: 1.2,
    }),
  );
  scene.add(car);

  // Real clouds own the sea — the analytic nadir sea would double-draw from above.
  P.cloudSea = 0;
  const clouds = createModularRoadClouds({
    renderer, scene, camera, seed: 137,
    params: { enabled: true, base: P.cloudBase, thickness: P.cloudThickness },
  });
  scene.add(clouds.mesh);

  const sBake = document.getElementById("s-bake");
  clouds.ready.then((r) => {
    if (!sBake) return;
    sBake.textContent = r.error ? "FAILED" : `${Math.round(r.ms)} ms`;
    sBake.className = r.error ? "warn" : "good";
  });

  const _cloudZenith = new THREE.Color();
  const _cloudHorizon = new THREE.Color();
  const _cloudSun = new THREE.Color();
  const _cloudFrame = {
    sunDir: new THREE.Vector3(),
    sunColor: _cloudSun,
    skyZenith: _cloudZenith,
    skyHorizon: _cloudHorizon,
    hazeColor: _cloudHorizon,
  };

  const pmrem = new THREE.PMREMGenerator(renderer);
  let cubeRT = null;
  let cubeCam = null;
  let envRT = null;
  let envFace = -1;
  let envNeeds = true;
  let lastEnvSnap = "";
  const _skyHome = new THREE.Vector3();

  function ensureEnvRig() {
    if (cubeRT) return;
    cubeRT = new THREE.CubeRenderTarget(128, { type: THREE.HalfFloatType });
    cubeCam = new THREE.CubeCamera(0.1, 20000, cubeRT);
    cubeCam.updateMatrixWorld(true);
  }

  function bakeEnvFace(face) {
    ensureEnvRig();
    _skyHome.copy(sky.mesh.position);
    sky.mesh.position.set(0, 0, 0);
    sky.setSunDiscScale(0);
    const hide = [track, car, grid, clouds.mesh];
    const vis = hide.map((o) => o.visible);
    for (const o of hide) o.visible = false;

    const prev = renderer.getRenderTarget();
    const prevMask = camera.layers.mask;
    camera.layers.enable(0);
    renderer.setRenderTarget(cubeRT, face);
    renderer.render(scene, cubeCam.children[face]);
    renderer.setRenderTarget(prev);
    camera.layers.mask = prevMask;

    sky.setSunDiscScale(1);
    sky.mesh.position.copy(_skyHome);
    hide.forEach((o, i) => { o.visible = vis[i]; });
  }

  function convolveEnv() {
    try {
      envRT = pmrem.fromCubemap(cubeRT.texture, envRT);
      scene.environment = envRT.texture;
      scene.environmentIntensity = 1.15;
    } catch (err) {
      console.warn("[SkyLab] PMREM bake failed; IBL disabled.", err);
    }
  }

  function tickEnvBake(look) {
    const snap = `${P.timeOfDay.toFixed(2)}|${look.lookName}|${P.latitude}|${P.dayOfYear}`;
    if (snap !== lastEnvSnap) {
      lastEnvSnap = snap;
      envNeeds = true;
    }
    if (envFace >= 0) {
      bakeEnvFace(envFace);
      envFace++;
      if (envFace >= 6) {
        convolveEnv();
        envFace = -1;
        envNeeds = false;
      }
      return;
    }
    if (envNeeds) envFace = 0;
  }

  const _sunAim = new THREE.Vector3();
  function faceSun() {
    const night = P.timeOfDay >= 21 || P.timeOfDay < 5.5;
    if (night) {
      moonDirFromTime(P, _sunAim);
      cam.yaw = Math.atan2(_sunAim.x, _sunAim.z);
      cam.pitch = _sunAim.y < 0.12 ? 0.42 : Math.max(0.12, _sunAim.y * 0.5);
      return;
    }
    sunDirFromTime(P, _sunAim);
    cam.yaw = Math.atan2(_sunAim.x, _sunAim.z);
    // Staring into a 60° sun + ACES blows the frame white. Side-key it.
    if (_sunAim.y > 0.6) cam.yaw += Math.PI * 0.42;
    cam.pitch = 0.14;
  }

  const cam = { yaw: 0, pitch: 0.14, speed: 60 };
  function applyView(name) {
    const v = VIEWPOINTS[name];
    if (!v) return;
    camera.position.set(...v.pos);
    cam.yaw = v.yaw;
    cam.pitch = v.pitch;
    if (name === "track") {
      faceSun();
      if (P.timeOfDay < 21 && P.timeOfDay >= 5.5) cam.pitch = 0.14;
    }
  }
  applyView("track");

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

  const held = new Set();
  addEventListener("keydown", (e) => {
    held.add(e.code);
    const k = e.key.toLowerCase();
    if (k === "1") applyView("track");
    if (k === "2") applyView("down");
    if (k === "3") applyView("inside");
    if (k === "4") applyView("above");
    if (k === "5") setPreset("dawn");
    if (k === "6") setPreset("day");
    if (k === "7") setPreset("hero");
    if (k === "8") setPreset("dusk");
    if (k === "9") setPreset("night");
    if (k === "t") {
      P.autoAdvance = !P.autoAdvance;
      syncPlay();
    }
    if (k === "c") setClouds(!clouds.enabled);
    if (k === "p") setPhysicalSky(!usePhysicalSky);   // A/B the physical atmosphere
    if (k === "g") {
      grid.visible = !grid.visible;
      track.visible = !track.visible;
    }
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
    car.position.copy(camera.position).addScaledVector(_fwd, 22).addScaledVector(_right, -4);
    car.position.y = Math.max(car.position.y, TRACK_Y + 0.7);
  }

  const SPECS = {
    "g-time": [
      ["timeOfDay", 0, 24, 0.05],
      ["latitude", 0, 70, 0.5],
      ["dayOfYear", 1, 365, 1],
      ["daySpeed", 0.05, 2, 0.05],
    ],
    "g-look": [
      ["sunDiscBright", 0, 24, 0.5],
      ["sunGlowPow", 4, 48, 0.5],
      ["sunGlowStrength", 0, 1.2, 0.01],
      ["horizonPow", 0.15, 1.2, 0.01],
      ["horizonGlow", 0, 0.6, 0.01],
      ["nadirPow", 0.4, 3, 0.05],
      ["zenithDepth", 0.4, 1.6, 0.02],
      ["cloudSea", 0, 1, 0.01],
      ["starBrightness", 0, 2.5, 0.05],
    ],
  };

  const readouts = [];
  function fmt(v, key) {
    if (key === "timeOfDay") return fmtClock(v);
    if (Math.abs(v) >= 100) return v.toFixed(0);
    if (Math.abs(v) >= 1) return v.toFixed(2).replace(/\.?0+$/, "");
    return v.toPrecision(2);
  }

  for (const [groupId, list] of Object.entries(SPECS)) {
    const host = document.getElementById(groupId);
    for (const [key, lo, hi, step] of list) {
      const row = document.createElement("div");
      row.className = "row";
      const label = key.replace(/([A-Z])/g, " $1").toLowerCase();
      row.innerHTML = `<label>${label}</label><input type="range" min="${lo}" max="${hi}" step="${step}"><span class="val"></span>`;
      const input = row.querySelector("input");
      const val = row.querySelector(".val");
      input.value = P[key];
      val.textContent = fmt(P[key], key);
      input.addEventListener("input", () => {
        P[key] = parseFloat(input.value);
        if (key === "timeOfDay") P.autoAdvance = false;
        val.textContent = fmt(P[key], key);
        syncPlay();
        syncPresetButtons();
      });
      readouts.push(() => {
        input.value = P[key];
        val.textContent = fmt(P[key], key);
      });
      host.appendChild(row);
    }
  }

  for (const b of document.querySelectorAll("[data-view]")) {
    b.addEventListener("click", () => applyView(b.dataset.view));
  }

  function syncPresetButtons() {
    const near = nearestPreset(P.timeOfDay);
    for (const b of document.querySelectorAll("[data-time]")) {
      b.classList.toggle("on", b.dataset.time === near && !P.autoAdvance);
    }
  }
  function setPreset(name) {
    applyTimePreset(P, name);
    faceSun();
    for (const r of readouts) r();
    syncPlay();
    syncPresetButtons();
  }
  for (const b of document.querySelectorAll("[data-time]")) {
    b.addEventListener("click", () => setPreset(b.dataset.time));
  }

  function setClouds(on) {
    clouds.setEnabled(on);
    P.cloudSea = on ? 0 : 0.45;
    const b = document.getElementById("b-clouds");
    if (b) {
      b.textContent = on ? "Clouds on" : "Clouds off";
      b.classList.toggle("on", on);
    }
  }
  document.getElementById("b-atmo")?.addEventListener("click", () => setPhysicalSky(!usePhysicalSky));
  document.getElementById("b-clouds")?.addEventListener("click", () => {
    setClouds(!clouds.enabled);
  });
  setClouds(true);

  function syncPlay() {
    const b = document.getElementById("b-play");
    if (!b) return;
    b.textContent = P.autoAdvance ? "Playing" : "Play day";
    b.classList.toggle("on", P.autoAdvance);
  }
  document.getElementById("b-play").addEventListener("click", () => {
    P.autoAdvance = !P.autoAdvance;
    syncPlay();
    syncPresetButtons();
  });
  syncPlay();
  syncPresetButtons();

  document.getElementById("b-reset").addEventListener("click", () => {
    Object.assign(P, SKY_DEFAULTS);
    P.cloudSea = clouds.enabled ? 0 : SKY_DEFAULTS.cloudSea;
    for (const r of readouts) r();
    syncPlay();
    syncPresetButtons();
  });
  document.getElementById("b-copy").addEventListener("click", async () => {
    const out = {};
    for (const k of Object.keys(SKY_DEFAULTS)) {
      if (P[k] !== SKY_DEFAULTS[k]) out[k] = P[k];
    }
    const text = JSON.stringify(out, null, 2);
    try { await navigator.clipboard.writeText(text); } catch {}
    console.log("[SkyLab] changed params:\n" + text);
    const btn = document.getElementById("b-copy");
    btn.textContent = "copied ✓";
    setTimeout(() => { btn.textContent = "Copy params"; }, 1200);
  });

  addEventListener("resize", () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  const sGpu = document.getElementById("s-gpu");
  const sFps = document.getElementById("s-fps");
  const sAlt = document.getElementById("s-alt");
  const sBand = document.getElementById("s-band");
  const sLook = document.getElementById("s-look");
  const sClock = document.getElementById("s-clock");
  const sSun = document.getElementById("s-sun");
  const sMood = document.getElementById("s-mood");
  const sCloud = document.getElementById("s-cloud");
  boot.textContent = "";

  let last = performance.now();
  let fpsAcc = 0, fpsN = 0, gpuAcc = 0, gpuN = 0, hudT = 0;

  const _lightAnchor = new THREE.Vector3();
  function syncLights(look) {
    const sunUp = look.sunDir.y > 0.02;
    _lightAnchor.copy(sunUp ? look.sunDir : look.moonDir);
    sun.position.copy(camera.position).addScaledVector(_lightAnchor, 500);
    sun.target.position.copy(camera.position);
    sun.target.updateMatrixWorld();
    sun.color.copy(sunUp ? look.sunColor : look.moonColor).convertLinearToSRGB();
    sun.intensity = look.dirIntensity;
    hemi.color.copy(look.zenithBelow).convertLinearToSRGB();
    hemi.groundColor.copy(look.nadirBelow).convertLinearToSRGB();
    hemi.intensity = look.hemiIntensity;
    renderer.toneMappingExposure = look.exposure;
  }

  function syncClouds(dt, look) {
    clouds.params.base = P.cloudBase;
    clouds.params.thickness = P.cloudThickness;
    _cloudFrame.sunDir.copy(look.sunDir);
    _cloudSun.copy(look.sunColor).convertLinearToSRGB();
    _cloudZenith.copy(look.zenithBelow).convertLinearToSRGB();
    _cloudHorizon.copy(look.horizonBelow).convertLinearToSRGB();
    clouds.update(dt, _cloudFrame);
  }

  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;

    flyStep(dt);
    const look = sky.update({ camera, dt });
    // The atmosphere needs the sun and the camera ALTITUDE — the altitude is half the
    // point, since the sky genuinely changes as you climb toward and above the deck.
    atmoDome.position.copy(sky.mesh.position);
    atmo.update(look.sunDir, Math.max(0, camera.position.y));
    syncLights(look);
    syncClouds(dt, look);
    tickEnvBake(look);

    if (!clouds.renderFrame()) {
      camera.layers.disable(CLOUD_LAYER);
      renderer.render(scene, camera);
    }

    if (hasTimestamps) renderer.resolveTimestampsAsync(THREE.TimestampQuery.RENDER);

    fpsAcc += 1 / Math.max(dt, 1e-4); fpsN++;
    const g = renderer.info.render.timestamp;
    if (g > 0) { gpuAcc += g; gpuN++; }

    hudT += dt;
    if (hudT > 0.2) {
      hudT = 0;
      const fps = fpsAcc / Math.max(fpsN, 1);
      const gpu = gpuAcc / Math.max(gpuN, 1);
      fpsAcc = fpsN = gpuAcc = gpuN = 0;
      sFps.textContent = fps.toFixed(0);
      sGpu.textContent = hasTimestamps ? `${gpu.toFixed(2)} ms` : "n/a";
      sGpu.className = gpu > 8 ? "warn" : gpu > 0 ? "good" : "";
      sAlt.textContent = `${camera.position.y.toFixed(0)} m`;
      sBand.textContent = skyBandName(camera.position.y, P);
      const py = Math.sin(cam.pitch);
      sLook.textContent = py < -0.35 ? "down" : py > 0.35 ? "up" : "horizon";
      sClock.textContent = fmtClock(P.timeOfDay);
      sSun.textContent = `${look.sunElevation.toFixed(0)}°`;
      sMood.textContent = look.lookName;
      if (sCloud) {
        const inDeck = clouds.enabled
          && camera.position.y > clouds.params.base
          && camera.position.y < clouds.params.base + clouds.params.thickness;
        sCloud.textContent = !clouds.enabled ? "off" : inDeck ? "inside" : "on";
        sCloud.className = inDeck ? "good" : "";
      }
      if (P.autoAdvance) {
        for (const r of readouts) r();
        syncPresetButtons();
      }
    }
  });

  window.__skyLab = {
    atmo, setPhysicalSky, get physical() { return usePhysicalSky; },
    sky, clouds, camera, renderer, scene, applyView, setPreset, params: P, VIEWPOINTS, THREE,
  };
  return window.__skyLab;
}
