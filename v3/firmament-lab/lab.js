// FIRMAMENT LAB — the engine's global sky (v3/render/firmament/) next to Sky Pro (v3/render/skypro/,
// frozen: the reference). Both are built through their TOP-LEVEL API (createXSky: dome + clouds +
// cirrus + haze + environment + eye adaptation), the way a game drives them, over a small lab world.
// They share ONE settings object, so an A/B is always the same settings in both.
//
// Keys: B = switch sky. Debug: window.__firmamentLab (compare() = mean pixel difference of the two).
// Units are Tidewater's (sun illuminance 11), so the base exposure is 0.55.

import * as THREE from "three/webgpu";
import { texture, uniform, toneMapping } from "three/tsl";
import { smaa } from "three/addons/tsl/display/SMAANode.js";
import { createFirmamentSky, FIRMAMENT_DEFAULTS, FIRMAMENT_NIGHT_STYLES, FIRMAMENT_AIR_PRESETS, FIRMAMENT_CLOUD_PRESETS, FIRMAMENT_LOOKS, applyFirmamentLook } from "../render/firmament/firmamentSky.js";
import { sunDirection, moonDirection, moonPhaseName } from "../render/firmament/firmamentCelestial.js";
import { createSkyProSky } from "../render/skypro/skyproSky.js";
import { createLabScene } from "./labScene.js";

const status = document.getElementById("status");
const badge = document.getElementById("badge");
const say = (t) => { status.textContent = t; };

// lab-only settings; the sky settings live in `params` (FIRMAMENT_DEFAULTS' shape, shared by both skies)
const lab = {
  sky: "firmament",
  sunAzimuth: 0,
  timeSpeed: 0,
  exposureEV: 0,
  renderScale: 1,
  skyLight: true,
  /** SMAA on the output (the engine runs its own AA in its post chain) */
  antialias: true,
};
const params = { ...FIRMAMENT_DEFAULTS, savedLight: null };
// URL overrides for any number setting, e.g. ?windSpeed=0&coverage=0.8&timeOfDay=18 (windSpeed=0 from boot
// = no cloud drift in either sky, the fair A/B: each sky's wind offset only advances while it is shown)
for (const [k, v] of new URLSearchParams(location.search)) {
  const target = k in lab ? lab : k in params ? params : null;
  if (target && typeof target[k] === "number" && Number.isFinite(Number(v))) target[k] = Number(v);
}

// ------------------------------------------------------------------ GPU timer (every pass on the device)
class GpuTimer {
  constructor(device) {
    this.device = device;
    this.enabled = device.features.has("timestamp-query");
    this.ms = 0; this.passes = []; this._samples = []; this._labels = [];
    if (!this.enabled) return;
    const MAX = this.MAX = 256;
    this.querySet = device.createQuerySet({ type: "timestamp", count: MAX * 2 });
    this.resolve = device.createBuffer({ size: MAX * 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
    this.ring = Array.from({ length: 4 }, () => ({ buffer: device.createBuffer({ size: MAX * 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }), busy: false }));
    const self = this, proto = GPUCommandEncoder.prototype;
    const rp = proto.beginRenderPass, cp = proto.beginComputePass;
    const tag = (desc, kind) => {
      if (self._labels.length >= MAX || (desc && desc.timestampWrites)) return desc;
      const i = self._labels.length;
      self._labels.push((desc && desc.label) || kind);
      return { ...(desc || {}), timestampWrites: { querySet: self.querySet, beginningOfPassWriteIndex: i * 2, endOfPassWriteIndex: i * 2 + 1 } };
    };
    proto.beginRenderPass = function (desc) { return rp.call(this, tag(desc, "render")); };
    proto.beginComputePass = function (desc) { return cp.call(this, tag(desc, "compute")); };
  }
  endFrame() {
    if (!this.enabled) return;
    const n = this._labels.length, labels = this._labels;
    this._labels = [];
    if (!n) return;
    const slot = this.ring.find((s) => !s.busy);
    if (!slot) return;
    slot.busy = true;
    const enc = this.device.createCommandEncoder();
    enc.resolveQuerySet(this.querySet, 0, n * 2, this.resolve, 0);
    enc.copyBufferToBuffer(this.resolve, 0, slot.buffer, 0, n * 16);
    this.device.queue.submit([enc.finish()]);
    slot.buffer.mapAsync(GPUMapMode.READ).then(() => {
      const t = new BigInt64Array(slot.buffer.getMappedRange().slice(0, n * 16));
      slot.buffer.unmap();
      slot.busy = false;
      this._result(labels, t);
    }).catch(() => { slot.busy = false; });
  }
  _result(labels, t) {
    const per = new Map();
    let any = false;
    for (let i = 0; i < labels.length; i++) {
      const a = t[i * 2], b = t[i * 2 + 1];
      if (b <= 0n || b < a) continue;
      any = true;
      per.set(labels[i], (per.get(labels[i]) || 0) + Number(b - a) / 1e6);
    }
    if (!any) return;
    // the SUM of the passes (three submits computes separately; the gaps between are not GPU work)
    let busy = 0;
    for (const v of per.values()) busy += v;
    this._samples.push({ total: busy, per });
    if (this._samples.length > 60) this._samples.shift();
    const tot = this._samples.map((s) => s.total).sort((x, y) => x - y);
    this.ms = tot[tot.length >> 1];
    const acc = new Map();
    for (const s of this._samples) for (const [k, v] of s.per) acc.set(k, (acc.get(k) || 0) + v / this._samples.length);
    this.passes = [...acc].sort((x, y) => y[1] - x[1]);
  }
  reset() { this._samples = []; this.passes = []; this.ms = 0; }
}

// ------------------------------------------------------------------ free camera
class FlyCamera {
  constructor(camera, dom) {
    this.camera = camera;
    camera.rotation.order = "YXZ";
    this.yaw = 0; this.pitch = 0.12;
    this.keys = new Set();
    this.speed = 60;
    dom.addEventListener("pointerdown", (e) => { if (e.button === 0) dom.requestPointerLock?.(); });
    document.addEventListener("mousemove", (e) => {
      if (document.pointerLockElement !== dom) return;
      this.yaw -= e.movementX * 0.0022;
      this.pitch = THREE.MathUtils.clamp(this.pitch - e.movementY * 0.0022, -1.55, 1.55);
    });
    window.addEventListener("keydown", (e) => { if (!(e.target instanceof HTMLInputElement)) this.keys.add(e.code); });
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));
    window.addEventListener("blur", () => this.keys.clear());
  }
  update(dt) {
    const k = this.keys, c = this.camera;
    c.rotation.set(this.pitch, this.yaw, 0, "YXZ");
    const fwd = new THREE.Vector3(-Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch));
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const boost = k.has("ShiftLeft") || k.has("ShiftRight") ? 12 : 1;
    const v = this.speed * boost * dt;
    // e.code = the physical key, so WASD on QWERTY is ZQSD on AZERTY
    if (k.has("KeyW")) c.position.addScaledVector(fwd, v);
    if (k.has("KeyS")) c.position.addScaledVector(fwd, -v);
    if (k.has("KeyD")) c.position.addScaledVector(right, v);
    if (k.has("KeyA")) c.position.addScaledVector(right, -v);
    if (k.has("KeyE") || k.has("Space")) c.position.y += v;
    if (k.has("KeyQ") || k.has("KeyC")) c.position.y -= v;
    c.position.y = Math.max(c.position.y, 1.0);
  }
  look(yawDeg, pitchDeg) {
    this.yaw = THREE.MathUtils.degToRad(yawDeg);
    this.pitch = THREE.MathUtils.degToRad(pitchDeg);
  }
}

// ------------------------------------------------------------------ one sky under test + its lab world
async function buildSky(name, create, { renderer, camera }) {
  const sky = create({ renderer, camera, params });
  await sky.ready;
  const world = createLabScene({ clouds: sky.clouds, atmosphere: sky.atmosphere });
  world.scene.add(sky.mesh);
  return { name, sky, world };
}

async function main() {
  if (!navigator.gpu) { say("WebGPU is not available in this browser."); return; }
  say("Starting WebGPU…");
  const adapter = await navigator.gpu.requestAdapter();
  const want = ["timestamp-query", "float32-filterable"].filter((x) => adapter.features.has(x));
  const device = await adapter.requestDevice({ requiredFeatures: want });
  const timer = new GpuTimer(device);

  const renderer = new THREE.WebGPURenderer({ antialias: false, device });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  document.getElementById("app").appendChild(renderer.domElement);
  await renderer.init();

  const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.06, 60000);
  camera.position.set(0, 2, 0);
  const fly = new FlyCamera(camera, renderer.domElement);

  say("Building Firmament…");
  const skies = { firmament: await buildSky("Firmament", createFirmamentSky, { renderer, camera }) };
  say("Building Sky Pro (reference)…");
  skies.skypro = await buildSky("Sky Pro", createSkyProSky, { renderer, camera });

  // the linear HDR frame (sky + world), then the sky's haze, the meter, and the canvas (ACES)
  const hdrRT = new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: true, depthTexture: new THREE.DepthTexture(1, 1) });
  // exposure + ACES into an LDR target, then SMAA to the canvas (the lab had NO anti-aliasing: hard
  // edges stair-stepped; the engine's own post chain runs FXAA/MSAA, this lab bypasses it)
  const uExposure = uniform(1);
  const toneRT = new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
  const toneMat = new THREE.MeshBasicNodeMaterial();
  toneMat.colorNode = toneMapping(THREE.ACESFilmicToneMapping, uExposure, texture(hdrRT.texture));   // (returns a vec4)
  toneMat.toneMapped = false;
  const toneQuad = new THREE.QuadMesh(toneMat);
  const outMat = new THREE.MeshBasicNodeMaterial();
  outMat.colorNode = smaa(texture(toneRT.texture));
  outMat.toneMapped = false;
  const outQuad = new THREE.QuadMesh(outMat);
  const rawMat = new THREE.MeshBasicNodeMaterial();
  rawMat.colorNode = texture(toneRT.texture);
  rawMat.toneMapped = false;
  const rawQuad = new THREE.QuadMesh(rawMat);

  const resize = () => {
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2) * lab.renderScale);
    renderer.setSize(innerWidth, innerHeight);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  };
  window.addEventListener("resize", resize);

  const active = () => skies[lab.sky];
  const setSky = (key) => {
    if (!skies[key]) return;
    lab.sky = key;
    active().sky.clouds.resetHistory();
    timer.reset();
    badge.textContent = active().name + (key === "skypro" ? "  (reference)" : "");
    badge.style.color = key === "skypro" ? "#f0c674" : "#8fd3ff";
    ui.refreshSky?.();
  };
  window.addEventListener("keydown", (e) => {
    if (e.target instanceof HTMLInputElement) return;
    if (e.code === "KeyB") setSky(lab.sky === "firmament" ? "skypro" : "firmament");
  });

  const ui = buildPanel({ lab, params, fly, camera, resize, timer, setSky, skies, active });
  setSky("firmament");

  const bufferSize = new THREE.Vector2();
  const up = new THREE.Vector3(0, 1, 0);
  const sunDir = new THREE.Vector3(), moonDir = new THREE.Vector3();
  const keyColor = new THREE.Vector3();
  let last = performance.now();
  let first = true;
  let frames = 0;

  const frame = () => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    frames++;
    if (lab.timeSpeed !== 0) params.timeOfDay = (params.timeOfDay + dt * lab.timeSpeed + 24) % 24;
    fly.update(dt);
    camera.updateMatrixWorld();

    const { sky, world } = active();
    // the sun (and the real moon) from Firmament's clock and place, turned by the lab's azimuth, handed
    // to BOTH skies: an A/B always has the same sun and moon (Sky Pro takes a given moonDir as is)
    const place = { hours: params.timeOfDay, dayOfYear: params.dayOfYear, latitude: params.latitude, moonAge: params.moonAge };
    const turn = THREE.MathUtils.degToRad(lab.sunAzimuth);
    sunDirection(place, sunDir).applyAxisAngle(up, turn);
    const moon = params.realMoon ? moonDirection(place, moonDir).applyAxisAngle(up, turn) : undefined;
    renderer.getDrawingBufferSize(bufferSize);
    if (hdrRT.width !== bufferSize.x || hdrRT.height !== bufferSize.y) hdrRT.setSize(bufferSize.x, bufferSize.y);

    sky.update(dt, { sunDir, moonDir: moon, hours: params.timeOfDay, drawingBufferSize: bufferSize });
    const L = sky.light();
    if (L.keyIsMoon) keyColor.copy(L.moonColor);
    else keyColor.set(L.sunColor[0], L.sunColor[1], L.sunColor[2]).multiplyScalar(params.sunScale ?? 1);
    world.update(camera, L.keyDir, keyColor);
    world.setEnvironment(lab.skyLight ? sky.environment : null);

    renderer.setRenderTarget(hdrRT);
    renderer.clear();
    renderer.render(world.scene, camera);
    sky.postProcess(hdrRT, { depthTex: hdrRT.depthTexture, light: world.sun, shadowDepth: world.shadowDepth, size: bufferSize });
    sky.meter(hdrRT);
    renderer.setRenderTarget(null);
    uExposure.value = params.exposure * sky.exposureFactor(dt) * Math.pow(2, lab.exposureEV);
    if (toneRT.width !== bufferSize.x || toneRT.height !== bufferSize.y) toneRT.setSize(bufferSize.x, bufferSize.y);
    renderer.setRenderTarget(toneRT);
    toneQuad.render(renderer);
    renderer.setRenderTarget(null);
    (lab.antialias ? outQuad : rawQuad).render(renderer);
    timer.endFrame();
    if (first) { first = false; say(""); }
  };

  // ---- debug: read the linear HDR frame back; compare the two skies at the same settings
  async function readHDR() {
    const w = hdrRT.width, h = hdrRT.height;
    const px = await renderer.readRenderTargetPixelsAsync(hdrRT, 0, 0, w, h);
    const out = new Float32Array(w * h * 3);
    const half = px instanceof Uint16Array;
    for (let i = 0, j = 0; i < w * h; i++) {
      for (let c = 0; c < 3; c++) out[j++] = half ? THREE.DataUtils.fromHalfFloat(px[i * 4 + c]) : px[i * 4 + c];
    }
    return { w, h, data: out };
  }
  const waitFrames = (n) => new Promise((res) => {
    const start = frames;
    const tick = () => (frames - start >= n ? res() : requestAnimationFrame(tick));
    tick();
  });
  /** Mean |A - B| / mean(A) over the frame, both skies settled for `settle` frames (wind and clock frozen). */
  async function compare({ settle = 120 } = {}) {
    const keep = { wind: params.windSpeed, speed: lab.timeSpeed, sky: lab.sky };
    params.windSpeed = 0; lab.timeSpeed = 0;
    setSky("skypro"); await waitFrames(settle); const a = await readHDR();
    setSky("firmament"); await waitFrames(settle); const b = await readHDR();
    params.windSpeed = keep.wind; lab.timeSpeed = keep.speed; setSky(keep.sky);
    let sumA = 0, sumD = 0, maxD = 0;
    for (let i = 0; i < a.data.length; i++) {
      const d = Math.abs(a.data[i] - b.data[i]);
      sumA += Math.abs(a.data[i]); sumD += d; if (d > maxD) maxD = d;
    }
    return { pixels: a.w * a.h, meanSkyPro: sumA / a.data.length, meanAbsDiff: sumD / a.data.length, relDiff: sumD / Math.max(sumA, 1e-9), maxAbsDiff: maxD };
  }

  window.__firmamentLab = { renderer, camera, skies, params, lab, timer, fly, setSky, readHDR, compare, THREE };
  renderer.setAnimationLoop(frame);
}

// ------------------------------------------------------------------ panel
function buildPanel({ lab, params, fly, camera, resize, timer, setSky, skies, active }) {
  const panel = document.getElementById("panel");
  const widgets = [];
  const row = (label, input, out) => {
    const r = document.createElement("label");
    r.className = "row";
    const s = document.createElement("span");
    s.textContent = label;
    r.append(s, input);
    if (out) r.append(out);
    panel.append(r);
  };
  const slider = (obj, label, key, min, max, step, fmt = (v) => v.toFixed(2), onInput = null) => {
    const i = document.createElement("input");
    i.type = "range"; i.min = min; i.max = max; i.step = step; i.value = obj[key];
    const o = document.createElement("output");
    const show = () => { o.textContent = fmt(Number(obj[key])); };
    i.addEventListener("input", () => { obj[key] = Number(i.value); show(); if (onInput) onInput(); });
    show();
    row(label, i, o);
    const w = { input: i, show, sync: () => { i.value = obj[key]; show(); } };
    widgets.push(w);
    return w;
  };
  const check = (obj, label, key) => {
    const i = document.createElement("input");
    i.type = "checkbox"; i.checked = !!obj[key];
    i.addEventListener("change", () => { obj[key] = i.checked; });
    row(label, i);
    widgets.push({ sync: () => { i.checked = !!obj[key]; } });
  };
  const h = (t) => { const e = document.createElement("h3"); e.textContent = t; panel.append(e); };
  const buttons = (list) => {
    const d = document.createElement("div");
    d.className = "buttons";
    const made = list.map(([label, fn]) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.addEventListener("click", fn);
      d.append(b);
      return b;
    });
    panel.append(d);
    return made;
  };
  const hhmm = (v) => `${String(Math.floor(v)).padStart(2, "0")}:${String(Math.floor((v % 1) * 60)).padStart(2, "0")}`;
  const syncAll = () => widgets.forEach((w) => w.sync());

  h("Sky (B switches)");
  const skyButtons = buttons([
    ["Firmament", () => setSky("firmament")],
    ["Sky Pro (reference)", () => setSky("skypro")],
  ]);

  h("Looks (matched by eye to the original Sky Pro demo)");
  const LOOK_LABELS = { partlyCloudy: "Partly cloudy", fluffy: "Fluffy", hazy: "Hazy", moonlitNight: "Moonlit night", stylized: "Stylized", stormyEvening: "Stormy evening", sunset: "Sunset", thunderstorm: "Thunderstorm" };
  buttons(Object.keys(FIRMAMENT_LOOKS).map((k) => [LOOK_LABELS[k] || k, () => {
    applyFirmamentLook(params, k);
    lab.exposureEV = 0;
    active().sky.clouds.resetHistory();
    syncAll();
  }]));
  buttons([["Demo framing", () => {
    // the original demo's fixed camera: ~60 m up, facing where the sun stands at 14:59, horizon a little low
    const s = sunDirection({ hours: 14.98, dayOfYear: params.dayOfYear, latitude: params.latitude }, new THREE.Vector3());
    camera.position.set(0, 60, 0);
    camera.fov = 60; camera.updateProjectionMatrix();
    fly.look(Math.atan2(-s.x, -s.z) * 180 / Math.PI, 8);
    active().sky.clouds.resetHistory();
  }]]);

  h("Sun");
  const tod = slider(params, "Time of day", "timeOfDay", 0, 24, 0.01, hhmm);
  slider(lab, "Sun azimuth", "sunAzimuth", -180, 180, 1, (v) => `${v.toFixed(0)}°`);
  slider(lab, "Time speed", "timeSpeed", 0, 2, 0.01, (v) => `${v.toFixed(2)} h/s`);
  slider(params, "Sun strength", "sunScale", 0, 2, 0.01);
  slider(params, "Sun size", "sunSizeDeg", 0.2, 4, 0.01, (v) => `${v.toFixed(2)}°`);
  buttons([["Dawn", () => { params.timeOfDay = 6.4; syncAll(); }], ["Noon", () => { params.timeOfDay = 12; syncAll(); }],
    ["Golden", () => { params.timeOfDay = 17.6; syncAll(); }], ["Dusk", () => { params.timeOfDay = 18.4; syncAll(); }], ["Night", () => { params.timeOfDay = 23; syncAll(); }]]);

  h("Date and place");
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const dateOf = (n) => { const d = new Date(Date.UTC(2026, 0, Math.round(n))); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; };
  slider(params, "Day of year", "dayOfYear", 1, 365, 1, dateOf);
  slider(params, "Latitude", "latitude", -70, 70, 0.5, (v) => `${Math.abs(v).toFixed(1)}° ${v >= 0 ? "N" : "S"}`);
  buttons([["Tidewater 24°N", () => { params.latitude = 24; params.dayOfYear = 96; syncAll(); }],
    ["Algeria 35°N", () => { params.latitude = 35.3; syncAll(); }], ["Vietnam 16°N", () => { params.latitude = 16; syncAll(); }],
    ["Paris 49°N", () => { params.latitude = 48.9; syncAll(); }], ["Summer", () => { params.dayOfYear = 172; syncAll(); }], ["Winter", () => { params.dayOfYear = 355; syncAll(); }]]);

  h("Moon");
  check(params, "Real moon (date + phase)", "realMoon");
  slider(params, "Moon age", "moonAge", 0, 29.5, 0.1, (v) => `${v.toFixed(1)} d ${moonPhaseName(v)}`);
  buttons([["New", () => { params.moonAge = 0; params.realMoon = true; syncAll(); }], ["1st quarter", () => { params.moonAge = 7.4; params.realMoon = true; syncAll(); }],
    ["Full", () => { params.moonAge = 14.8; params.realMoon = true; syncAll(); }], ["Last quarter", () => { params.moonAge = 22.1; params.realMoon = true; syncAll(); }]]);
  slider(params, "Moon size", "moonSizeDeg", 0.2, 4, 0.01, (v) => `${v.toFixed(2)}°`);
  slider(params, "Phase (art)", "moonPhase", -1, 1, 0.01, (v) => (v < 0 ? "from the sun" : `${Math.round(v * 100)} % lit`));

  h("Clouds");
  const LABELS = { fair: "Fair (Sky Pro)", lowCumulus: "Low cumulus", mixed: "Mixed", overcast: "Overcast", storm: "Storm", front: "Front" };
  buttons(Object.keys(FIRMAMENT_CLOUD_PRESETS).map((k) => [LABELS[k] || k, () => { Object.assign(params, FIRMAMENT_CLOUD_PRESETS[k]); syncAll(); }]));
  slider(params, "Coverage", "coverage", 0, 1, 0.01);
  slider(params, "Cloud type", "cloudType", 0, 1, 0.01, (v) => `${v.toFixed(2)} ${v < 0.25 ? "stratus" : v < 0.7 ? "cumulus" : "storm"}`);
  slider(params, "Type variation", "typeVariation", 0, 1, 0.01);
  slider(params, "Tower top", "towerTop", 0.2, 1.2, 0.01, (v) => `${(v * params.cloudThickness / 1000 + params.cloudBase / 1000).toFixed(1)} km`);
  slider(params, "Anvil", "anvil", 0, 0.8, 0.01);
  slider(params, "Sheet thickness", "stratusThickness", 0.01, 0.4, 0.005);
  slider(params, "Wetness", "wetness", 0, 1, 0.01);
  slider(params, "Cloud base", "cloudBase", 200, 6000, 50, (v) => `${(v / 1000).toFixed(2)} km`);
  slider(params, "Deck thickness", "cloudThickness", 500, 12000, 100, (v) => `${(v / 1000).toFixed(1)} km`);

  h("Cloud look (Sky Pro's model)");
  slider(params, "Density", "cloudDensity", 0.002, 0.1, 0.001, (v) => v.toFixed(3));
  slider(params, "Albedo", "cloudAlbedo", 0.2, 1.2, 0.01);
  slider(params, "Ambient", "cloudAmbient", 0, 2, 0.01);
  slider(params, "Multi-scatter", "multiScatter", 0, 2, 0.01);
  slider(params, "Powder", "powder", 0, 1.5, 0.01);
  slider(params, "Base shadow", "baseShadow", 0, 1, 0.01);
  slider(params, "Ground bounce", "bounce", 0, 5, 0.05);
  slider(params, "Edge softness", "edgeSoftness", 0.01, 0.4, 0.005, (v) => v.toFixed(3));
  slider(params, "Shape size", "cloudScale", 1500, 25000, 100, (v) => `${(v / 1000).toFixed(1)} km`);
  slider(params, "Dilation", "cloudDilation", 0, 1.5, 0.01);
  slider(params, "Erosion size", "erosionScale", 0.03, 0.5, 0.005, (v) => v.toFixed(3));
  slider(params, "Erosion base", "erosionBase", 0, 2, 0.01);
  slider(params, "Erosion top", "erosionTop", 0, 5, 0.05);
  slider(params, "Wispy / billowy", "erosionShape", 0, 1, 0.01);
  slider(params, "Base needs", "baseRequired", 0, 1, 0.01);
  slider(params, "Field size", "weatherScale", 5000, 80000, 500, (v) => `${(v / 1000).toFixed(1)} km`);
  slider(params, "Weather bias", "weatherBias", -0.5, 1, 0.01);
  slider(params, "Mass contrast", "weatherContrast", 0.2, 4, 0.02);
  slider(params, "Fine detail", "weatherDetail", 0, 1, 0.01);
  slider(params, "Horizon cover", "horizonCoverage", -0.5, 0.6, 0.01);
  slider(params, "Melt start", "meltStart", 5000, 150000, 1000, (v) => `${(v / 1000).toFixed(0)} km`);
  slider(params, "Melt end", "meltEnd", 10000, 250000, 1000, (v) => `${(v / 1000).toFixed(0)} km`);
  slider(params, "Cloud haze dist", "cloudAP", 3000, 200000, 1000, (v) => `${(v / 1000).toFixed(0)} km`);
  buttons([["Copy settings (JSON)", () => {
    const { savedLight, ...rest } = params; void savedLight;
    const json = JSON.stringify(rest, null, 1);
    navigator.clipboard?.writeText(json).catch(() => {});
    console.log(json);
  }]]);

  h("Weather front");
  slider(params, "Coverage behind", "frontCoverage", 0, 1, 0.01);
  slider(params, "Storm line", "frontStorm", 0, 1, 0.01);
  slider(params, "Facing", "frontDeg", -180, 180, 1, (v) => `${v.toFixed(0)}°`);
  const frontPos = slider(params, "Position", "frontPos", -60000, 60000, 500, (v) => `${(v / 1000).toFixed(1)} km`);
  slider(params, "Width", "frontWidth", 1000, 30000, 500, (v) => `${(v / 1000).toFixed(1)} km`);
  slider(params, "Advance", "frontSpeed", 0, 200, 1, (v) => `${v.toFixed(0)} m/s`);
  setInterval(() => { if (params.frontSpeed) frontPos.sync(); }, 250);

  h("Wind and high cloud");
  slider(params, "Wind direction", "windDeg", -180, 180, 1, (v) => `${v.toFixed(0)}°`);
  slider(params, "Wind speed", "windSpeed", 0, 100, 1, (v) => `${v.toFixed(0)} m/s`);
  slider(params, "Cirrus", "cirrus", 0, 3, 0.01);
  slider(params, "Cirrus altitude", "cirrusAlt", 6000, 13000, 100, (v) => `${(v / 1000).toFixed(1)} km`);
  check(params, "Horizon mask", "horizonMask");

  h("Air");
  buttons(Object.keys(FIRMAMENT_AIR_PRESETS).map((k) => [k[0].toUpperCase() + k.slice(1), () => { Object.assign(params, FIRMAMENT_AIR_PRESETS[k]); syncAll(); }]));
  slider(params, "Air (blue)", "airDensity", 0, 3, 0.01);
  slider(params, "Aerosols", "aerosols", 0, 100, 0.5, (v) => `${v.toFixed(1)}`);
  slider(params, "Aerosol height", "aerosolHeight", 0.3, 6, 0.1, (v) => `${v.toFixed(1)} km`);
  slider(params, "Sun glow", "sunGlow", 0, 0.95, 0.01);
  slider(params, "Ozone", "ozone", 0, 3, 0.01);
  slider(params, "Dust", "dust", 0, 2, 0.01);
  slider(params, "Ground haze", "haze", 0, 4, 0.05);
  slider(params, "Sun shafts", "shafts", 0, 3, 0.05);
  check(params, "God rays", "godRays");
  check(lab, "Sky light (env)", "skyLight");

  h("Night look");
  check(params, "Night look", "nightLook");
  buttons(Object.keys(FIRMAMENT_NIGHT_STYLES).map((k) => [k[0].toUpperCase() + k.slice(1), () => { Object.assign(params, FIRMAMENT_NIGHT_STYLES[k]); params.nightLook = true; syncAll(); }]));
  slider(params, "Moon height", "moonElev", 0, 80, 1, (v) => (v > 0 ? `${v.toFixed(0)}°` : "Tidewater"));
  slider(params, "Moon azimuth", "moonAzim", -180, 180, 1, (v) => `${v.toFixed(0)}°`);
  slider(params, "Stars", "nightStars", 0, 4, 0.05);
  slider(params, "Milky Way", "nightMilkyWay", 0, 6, 0.1);

  h("Output");
  slider(lab, "Exposure", "exposureEV", -3, 3, 0.1, (v) => `${v.toFixed(1)} EV`);
  check(params, "Auto exposure", "autoExposure");
  check(lab, "Anti-aliasing (SMAA)", "antialias");
  slider(lab, "Render scale", "renderScale", 0.5, 1, 0.05, (v) => v.toFixed(2), resize);

  h("Camera");
  const view = (label, y, yaw, pitch) => [label, () => {
    camera.position.set(0, y, 0);
    fly.look(yaw, pitch);
    active().sky.clouds.resetHistory();
  }];
  buttons([
    view("Ground 2 m", 2, 0, 12),
    view("Toward sun", 2, 90, 8),
    view("East (front)", 2, -90, 8),
    view("RTS 130 m", 130, 0, -35),
    view("High 2 km", 2000, 0, 5),
    view("In the deck 6 km", 6000, 0, 0),
    view("Above 11 km", 11000, 0, -20),
  ]);

  const stats = document.createElement("pre");
  stats.id = "stats";
  panel.append(stats);
  const help = document.createElement("p");
  help.className = "help";
  help.textContent = "Click the view to look (Esc releases). WASD / ZQSD move, E/Space up, Q/C down, Shift x12. B = Firmament / Sky Pro.";
  panel.append(help);

  let acc = 0, n = 0, last = performance.now();
  const tick = () => {
    const now = performance.now();
    acc += now - last; n++; last = now;
    if (acc > 500) {
      const ms = acc / n;
      acc = 0; n = 0;
      const p = camera.position;
      let s = `frame  ${ms.toFixed(2)} ms (wall, vsync-bound)\n`;
      s += timer.enabled ? `GPU    ${timer.ms.toFixed(2)} ms (sum of passes, median of 60)\n` : "GPU    n/a (no timestamp-query)\n";
      // three labels compute passes computeGroup_<node id>: name them after the active sky's nodes
      const names = {};
      const { sky } = active();
      const P = sky.clouds.passes || {};
      for (const node of [P.weatherPass, P.boundsPass, P.panoPass, P.shadowPass, P.tracePass, ...(P.resolvePasses || []), ...Object.values(sky.atmosphere.passes || {})]) if (node) names[node.id] = node.name;
      const nameOf = (k) => k.replace(/^computeGroup_(\d+)$/, (m, id) => names[id] || m).replace(/^render$/, "render pass");
      for (const [k, v] of timer.passes.slice(0, 10)) s += `  ${nameOf(k).padEnd(24).slice(0, 24)} ${v.toFixed(3)}\n`;
      s += `cam    ${p.x.toFixed(0)}, ${p.y.toFixed(0)}, ${p.z.toFixed(0)} m`;
      stats.textContent = s;
      if (lab.timeSpeed !== 0) tod.sync();
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  return {
    refreshSky: () => {
      skyButtons[0].classList.toggle("on", lab.sky === "firmament");
      skyButtons[1].classList.toggle("on", lab.sky === "skypro");
    },
  };
  void skies;
}

main().catch((e) => {
  console.error(e);
  say("Failed: " + e.message);
});
