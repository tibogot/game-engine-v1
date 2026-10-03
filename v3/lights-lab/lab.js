// LOCAL LIGHTS LAB — fires, lanterns and muzzle flashes at night, three ways (2026-10-04).
//
// The question for the engine: what do N point lights cost per frame, and does a light that APPEARS
// (a muzzle flash, a fire lit) freeze the frame? three's default LightsNode hashes every light into
// every lit material's cache key, so a new light rebuilds the world's shaders (see the memory note
// ref-light-visible-recompiles-world). The two r184 add-ons avoid that:
//   - DynamicLighting: point/spot lights batched into uniform arrays and ONE loop; the cache key is the
//     set of light TYPES, so only the first light of a type rebuilds;
//   - TiledLighting: point lights in a texture, a compute pass bins them per 32-px screen tile, each
//     fragment loops over its tile's (<= ~8) lights.
//
// URL: ?mode=classic|dynamic|tiled  &n=32 (lights)  &pr=1.5 (pixel ratio)  &view=rts|ground
// Console: __lightsLab.bench(frames) -> ms/frame (the loop paused, frames through the GPU),
//          __lightsLab.newLightHitch() -> ms of the frame that first draws a brand-new PointLight,
//          __lightsLab.flashHitch() -> the same for a pooled light switched on by intensity.
// Units: Sky Pro's night (moon key (0.6, 0.7, 1) x 0.12, exposure ~2.2 with the night look).

import * as THREE from "three/webgpu";
import { Fn, vec3, float, positionWorld, mix, sin, fract, dot, floor } from "three/tsl";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { DynamicLighting } from "three/addons/lighting/DynamicLighting.js";
import { TiledLighting } from "three/addons/lighting/TiledLighting.js";

const q = new URLSearchParams(location.search);
const MODE = ["classic", "dynamic", "tiled"].includes(q.get("mode")) ? q.get("mode") : "dynamic";
const N = Math.max(0, Math.min(512, Number(q.get("n") ?? 32) | 0));
const PR = Number(q.get("pr") ?? 1.5) || 1.5;
const VIEW = q.get("view") === "ground" ? "ground" : "rts";

const settings = { flicker: true, flashes: false, lanternIntensity: 6, range: 14 };

// ---- renderer (as the engine: MSAA, ACES, the night look's exposure)
const renderer = new THREE.WebGPURenderer({ antialias: true });
renderer.setPixelRatio(PR);
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 2.2;
renderer.shadowMap.enabled = true;
if (MODE === "dynamic") renderer.lighting = new DynamicLighting({ maxPointLights: Math.max(1, N + 4) });
// r184 TRAP: TiledLightsNode.customCacheKey() reads its compute program before updateProgram() has
// built it (a render whose key is taken before setup, e.g. the shadow pass) -> "reading 'getCacheKey'
// of null" every frame. Build the program as the node is made.
class EagerTiledLighting extends TiledLighting {
  createNode(lights = []) { const n = super.createNode(lights); n.updateProgram(renderer); return n; }
}
if (MODE === "tiled") renderer.lighting = new EagerTiledLighting();
document.getElementById("app").appendChild(renderer.domElement);
await renderer.init();

const scene = new THREE.Scene();
scene.background = new THREE.Color().setRGB(0.004, 0.006, 0.012, THREE.LinearSRGBColorSpace);
const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.3, 2000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

// ---- the night (Sky Pro units): moon key with a shadow (stays on the per-light path in every mode), sky fill
const moon = new THREE.DirectionalLight(new THREE.Color().setRGB(0.6, 0.7, 1.0, THREE.LinearSRGBColorSpace), 0.12);
moon.position.set(-60, 90, 40);
moon.castShadow = true;
moon.shadow.mapSize.set(2048, 2048);
Object.assign(moon.shadow.camera, { left: -160, right: 160, top: 160, bottom: -160, near: 1, far: 400 });
scene.add(moon, moon.target);
const sky = new THREE.HemisphereLight(new THREE.Color().setRGB(0.012, 0.016, 0.03, THREE.LinearSRGBColorSpace), 0x000000, 1);
scene.add(sky);

// ---- ground: a cheap procedural sand/dirt (lit node material, like the engine's terrain)
const hash2 = Fn(([p]) => fract(sin(dot(p, vec3(127.1, 311.7, 74.7).xy)).mul(43758.5453)));
const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400, 1, 1).rotateX(-Math.PI / 2), new THREE.MeshStandardNodeMaterial({ roughness: 0.92 }));
ground.material.colorNode = Fn(() => {
  const c = floor(positionWorld.xz.mul(1.5));
  const n = hash2(c).mul(0.25).add(0.75);
  return mix(vec3(0.42, 0.36, 0.27), vec3(0.5, 0.44, 0.33), n).mul(n);
})();
ground.receiveShadow = true;
scene.add(ground);

// ---- a village: ~200 huts (one instanced mesh) and some props
const rnd = (() => { let s = 1234567; return () => ((s = (s * 16807) % 2147483647) / 2147483647); })();
const hutGeo = new THREE.BoxGeometry(4, 3, 5).translate(0, 1.5, 0);
const huts = new THREE.InstancedMesh(hutGeo, new THREE.MeshStandardNodeMaterial({ color: 0x8a7a64, roughness: 0.85 }), 200);
const m4 = new THREE.Matrix4(), qt = new THREE.Quaternion(), v3 = new THREE.Vector3(), sc = new THREE.Vector3(1, 1, 1);
const hutPos = [];
for (let i = 0; i < 200; i++) {
  const x = (rnd() - 0.5) * 300, z = (rnd() - 0.5) * 300;
  hutPos.push([x, z]);
  qt.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * Math.PI);
  sc.set(0.8 + rnd() * 0.6, 0.8 + rnd() * 0.5, 0.8 + rnd() * 0.6);
  huts.setMatrixAt(i, m4.compose(v3.set(x, 0, z), qt, sc));
}
huts.castShadow = huts.receiveShadow = true;
scene.add(huts);

// ---- the local lights: lanterns beside huts and camp fires (warm), flickering
const lights = [];
const lightGlow = new THREE.InstancedMesh(new THREE.SphereGeometry(0.18, 8, 6), new THREE.MeshBasicNodeMaterial({ color: 0xffd9a0 }), Math.max(1, N));
lightGlow.count = N;
scene.add(lightGlow);
const warm = [new THREE.Color().setRGB(1.0, 0.55, 0.22, THREE.LinearSRGBColorSpace), new THREE.Color().setRGB(1.0, 0.7, 0.4, THREE.LinearSRGBColorSpace)];
for (let i = 0; i < N; i++) {
  const [hx, hz] = hutPos[i % hutPos.length];
  const a = rnd() * Math.PI * 2, r = 4 + rnd() * 3;
  const l = new THREE.PointLight(warm[i % 2], settings.lanternIntensity, settings.range, 2);
  l.position.set(hx + Math.cos(a) * r, 1.6 + rnd() * 0.8, hz + Math.sin(a) * r);
  l.userData.phase = rnd() * 100;
  scene.add(l);
  lights.push(l);
  lightGlow.setMatrixAt(i, m4.compose(l.position, qt.identity(), sc.set(1, 1, 1)));
}

// ---- views
function setView(v) {
  if (v === "ground") { camera.position.set(hutPos[0][0] - 14, 1.7, hutPos[0][1] - 14); controls.target.set(hutPos[0][0] + 10, 1.5, hutPos[0][1] + 10); }
  else { camera.position.set(0, 120, -120); controls.target.set(0, 0, 0); }
  controls.update();
}
setView(VIEW);

// ---- per frame
let time = 0, last = performance.now();
function frame(now = performance.now()) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now; time += dt;
  for (let i = 0; i < lights.length; i++) {
    const l = lights[i];
    let k = 1;
    if (settings.flicker) k = 0.82 + 0.18 * Math.sin(time * 13 + l.userData.phase) * Math.sin(time * 7.3 + l.userData.phase * 1.7);
    // muzzle flashes: every light in turn fires a 2-frame burst (intensity only — no new light objects)
    if (settings.flashes) k = ((Math.floor(time * 60) + i * 7) % 23) < 2 ? 12 : 0;
    l.intensity = settings.lanternIntensity * k;
    l.distance = settings.range;
  }
  controls.update();
  renderer.render(scene, camera);
}
renderer.setAnimationLoop(frame);
addEventListener("resize", () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });

// ---- bench API
const dev = renderer.backend.device;
async function bench(frames = 60) {
  renderer.setAnimationLoop(null);
  await dev.queue.onSubmittedWorkDone();
  for (let i = 0; i < 6; i++) frame(); // settle
  await dev.queue.onSubmittedWorkDone();
  const t0 = performance.now();
  for (let i = 0; i < frames; i++) frame(t0 + i * 16.7);
  await dev.queue.onSubmittedWorkDone();
  const ms = (performance.now() - t0) / frames;
  renderer.setAnimationLoop(frame);
  return +ms.toFixed(3);
}
/** The frame that first draws a brand-new PointLight (a fire lit / a flash as a new object). */
async function newLightHitch() {
  renderer.setAnimationLoop(null);
  await dev.queue.onSubmittedWorkDone();
  const l = new THREE.PointLight(0xffaa66, 20, 10, 2);
  l.position.set(camera.position.x, 2, camera.position.z);
  scene.add(l); lights.push(l); l.userData.phase = 0;
  const t0 = performance.now();
  frame();
  await dev.queue.onSubmittedWorkDone();
  const ms = performance.now() - t0;
  renderer.setAnimationLoop(frame);
  return +ms.toFixed(1);
}
/** A pooled light switched on by intensity (how flashes should be done). */
async function flashHitch() {
  renderer.setAnimationLoop(null);
  await dev.queue.onSubmittedWorkDone();
  const l = lights[0];
  if (!l) { renderer.setAnimationLoop(frame); return null; }
  const saved = settings.lanternIntensity;
  settings.lanternIntensity = 0; frame(); await dev.queue.onSubmittedWorkDone();
  settings.lanternIntensity = saved;
  const t0 = performance.now();
  frame();
  await dev.queue.onSubmittedWorkDone();
  const ms = performance.now() - t0;
  renderer.setAnimationLoop(frame);
  return +ms.toFixed(1);
}
window.__lightsLab = { MODE, N, PR, renderer, scene, camera, lights, settings, setView, bench, newLightHitch, flashHitch };

// ---- panel
const panel = document.getElementById("panel");
const h = (t) => { const e = document.createElement("h3"); e.textContent = t; panel.appendChild(e); };
const buttons = (items) => { const d = document.createElement("div"); d.className = "views"; for (const [t, on, fn] of items) { const b = document.createElement("button"); b.textContent = t; if (on) b.className = "on"; b.onclick = fn; d.appendChild(b); } panel.appendChild(d); };
const go = (o) => { const p = new URLSearchParams(location.search); for (const [k, v] of Object.entries(o)) p.set(k, v); location.search = p.toString(); };
h("Mode (reloads)");
buttons(["classic", "dynamic", "tiled"].map((m) => [m, m === MODE, () => go({ mode: m })]));
h("Lights (reloads)");
buttons([0, 8, 32, 128, 256].map((n) => [String(n), n === N, () => go({ n })]));
h("View");
buttons([["RTS", VIEW === "rts", () => setView("rts")], ["Ground", VIEW === "ground", () => setView("ground")]]);
h("Lights");
const row = (label, key, min, max, step) => {
  const r = document.createElement("div"); r.className = "row";
  const l = document.createElement("label"); l.textContent = label;
  const i = document.createElement("input"); const o = document.createElement("output");
  if (typeof settings[key] === "boolean") { i.type = "checkbox"; i.checked = settings[key]; i.oninput = () => { settings[key] = i.checked; }; }
  else { Object.assign(i, { type: "range", min, max, step, value: settings[key] }); o.textContent = settings[key]; i.oninput = () => { settings[key] = +i.value; o.textContent = i.value; }; }
  r.append(l, i, o); panel.appendChild(r);
};
row("Flicker", "flicker");
row("Muzzle flashes", "flashes");
row("Intensity (cd)", "lanternIntensity", 0, 40, 0.5);
row("Range (m)", "range", 2, 40, 0.5);
const stats = document.createElement("div"); stats.id = "stats"; panel.appendChild(stats);
const help = document.createElement("p"); help.className = "help";
help.textContent = "Bench in the console: await __lightsLab.bench(120). Hitches: __lightsLab.newLightHitch() / flashHitch().";
panel.appendChild(help);
setInterval(() => { stats.textContent = `mode ${MODE}  lights ${N}  pixel ratio ${PR}\n${renderer.domElement.width} x ${renderer.domElement.height} px`; }, 500);
