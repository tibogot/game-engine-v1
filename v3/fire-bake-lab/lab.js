// FIRE BAKE LAB — can Dan Greenheck's Fire Pro make the game's fire and smoke books?
//
// Left of the box: the live Fire Pro volume (far too heavy for a game: a fluid solver
// and a ray-march every frame). Right: ONE card playing the book baked from it
// (bake.js), shaded as the game's lit smoke — the same sun, the same ambient. The card
// replays in step with the sim, so a frame of the book sits next to the frame it came
// from. Save writes public/textures/fx/firepro/fp_<preset>_{a,b,mv}.webp + .json.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { FireSimulation } from "../vendor/fire-pro/src/index.ts";
import { PRESETS } from "./presets.js";
import { bakeBook } from "./bake.js";
import { bookTextures, createBookCard, loadBookTextures } from "./bookCard.js";

const app = document.getElementById("app");
const panel = document.getElementById("panel");

if (!navigator.gpu) {
  panel.insertAdjacentHTML("beforeend", "<p>WebGPU is not available: Fire Pro needs it.</p>");
  throw new Error("no WebGPU");
}

const renderer = new THREE.WebGPURenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
app.append(renderer.domElement);
await renderer.init();
if (!renderer.backend.isWebGPUBackend) {
  panel.insertAdjacentHTML("beforeend", "<p>The renderer fell back to WebGL: Fire Pro needs the WebGPU backend.</p>");
  throw new Error("WebGL fallback");
}

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x8fa6bd);
const sun = new THREE.DirectionalLight(0xfff1dc, 3);
const ambient = new THREE.AmbientLight(0x9db2cc, 0.55);
scene.add(sun, sun.target, ambient);
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(400, 400).rotateX(-Math.PI / 2),
  new THREE.MeshStandardNodeMaterial({ color: 0xa48a68, roughness: 1 }),
);
scene.add(ground);

const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.05, 500);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

const card = createBookCard();
scene.add(card.mesh);
const boxHelper = new THREE.Box3Helper(new THREE.Box3(), 0x6fd3ff);
scene.add(boxHelper);

addEventListener("resize", () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});

// ── state ──────────────────────────────────────────────────────────────────────
const ui = {
  preset: "blast", cell: 192, ss: 2, flipRows: false,
  sunAz: 35, sunEl: 38, fireK: 1, motion: true, showBox: true, live: true,
};
const work = structuredClone(PRESETS);   // the sliders edit these, not PRESETS
let live = null;        // { sim, blasts }
let simTime = 0;
let baking = false, cancel = false;
let lastBake = null;    // bake result (bytes + meta)
let book = null;        // meta of the book on the card

async function buildSim(preset, parent, { bake = false } = {}) {
  const sim = new FireSimulation({
    ...preset.sim,
    lighting: { illuminateScene: false, intensity: 1 },
    rendering: bake
      ? { lightingDivisor: 4, filter: "cubic", raySteps: 512, halfResolution: false }
      : { lightingDivisor: 4, filter: "quadratic", raySteps: 128, halfResolution: true },
  });
  parent.add(sim);
  // `until` (s): an emitter that only runs at the start (a shell's jet of earth).
  const timed = [];
  for (const f of preset.fires) {
    const e = sim.addEmitter({ shape: { type: "sphere", radius: f.radius }, emission: f.emission, velocity: f.velocity });
    e.object.position.set(...f.at);
    if (f.until != null) timed.push({ e, until: f.until });
  }
  for (const force of preset.forces) sim.addForce(force);
  // `delay` (s): a blast that goes off later — napalm splashes landing one after another.
  const blasts = preset.blasts.map((b) => {
    const { at, delay = 0, ...opts } = b;
    const ex = sim.addExplosion(opts);
    ex.object.position.set(...at);
    return { ex, delay, fired: false };
  });
  /** Before each step at sim time `t`: start or stop the timed emitters, fire the blasts due. */
  const timeEmitters = (t) => {
    for (const { e, until } of timed) (t < until ? e.start() : e.stop());
    for (const b of blasts) if (!b.fired && t + 1e-6 >= b.delay) { b.ex.trigger(); b.fired = true; }
  };
  /** From the top: every blast fires again (at the next step from t = 0). */
  const rearm = () => { for (const b of blasts) b.fired = false; };
  console.info("[fire-bake] initializing Fire Pro…");
  await sim.initialize(renderer);
  console.info("[fire-bake] Fire Pro ready");
  return { sim, blasts, timeEmitters, rearm };
}

async function startLive() {
  live?.sim.dispose();
  live = null;
  const p = work[ui.preset];
  // Fire Pro validates every option (rates ≤ 100, speeds ≤ 50…): say so, not a silent blank.
  try { live = await buildSim(p, scene); } catch (e) { status(`Fire Pro refused the preset: ${e.message}`); throw e; }
  simTime = 0;
  live.rearm();
  frameView();
}

function replay() {
  if (!live) return;
  live.sim.reset();
  simTime = 0;
  live.timeEmitters(0);
  live.rearm();
}

function frameView() {
  const b = work[ui.preset].bake;
  const c = new THREE.Vector3(...b.center).add(new THREE.Vector3(b.size * 0.55, 0, 0));
  const pitch = THREE.MathUtils.degToRad(b.pitch);
  const dist = b.size * 2.9;
  controls.target.copy(c);
  camera.position.copy(c).add(new THREE.Vector3(0, Math.sin(pitch), Math.cos(pitch)).multiplyScalar(dist));
  controls.update();
}

// ── loop ───────────────────────────────────────────────────────────────────────
const clock = new THREE.Clock();
const _sunDir = new THREE.Vector3(), _sunCol = new THREE.Color(), _amb = new THREE.Color();
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1);
  if (baking) return;
  controls.update();
  const p = work[ui.preset], b = p.bake;

  const az = THREE.MathUtils.degToRad(ui.sunAz), el = THREE.MathUtils.degToRad(ui.sunEl);
  _sunDir.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));
  sun.target.position.set(...b.center);
  sun.position.copy(sun.target.position).addScaledVector(_sunDir, 30);

  if (live && ui.live) {
    live.timeEmitters(live.sim.stats.simulationTime);
    live.sim.update(dt);
    simTime = live.sim.stats.simulationTime;
    // A one-shot replays a little after its book ends, so the two stay in step.
    if (!b.loop && simTime > b.start + b.duration + 1.2) replay();
  }
  if (live) live.sim.visible = true;

  const size = b.size;
  const center = new THREE.Vector3(...b.center);
  boxHelper.box.setFromCenterAndSize(center, new THREE.Vector3(size, size, size));
  boxHelper.visible = ui.showBox;
  if (book) {
    const age = book.loop ? (simTime - b.start) / book.duration : (simTime - b.start) / book.duration;
    card.u.uFireK.value = ui.fireK;
    card.u.uMotion.value = ui.motion ? 1 : 0;
    card.u.uTint.value.set(p.sim.smoke?.color ?? "#808080");
    card.update({
      age, camera, size,
      center: center.clone().add(new THREE.Vector3(size * 1.1, 0, 0)),
      sunDir: _sunDir, sunColor: _sunCol.copy(sun.color).multiplyScalar(sun.intensity),
      ambient: _amb.copy(ambient.color).multiplyScalar(ambient.intensity),
    });
  }
  renderer.render(scene, camera);
  if (live) status(`sim ${simTime.toFixed(2)} s   ${(live.sim.stats.activeVoxels / 1e6).toFixed(2)} M voxels${book ? `\nbook: ${book.frames} frames, ${book.cell}px, mvScale ${book.mvScale}, Emax ${book.emissionMax}, fill ${book.fill}` : "\nno book yet: Bake"}`, true);
});

// ── panel ──────────────────────────────────────────────────────────────────────
const statusEl = document.createElement("div");
statusEl.id = "status";
let pinned = "";
function status(text, live = false) {
  if (!live) pinned = text;
  statusEl.textContent = (pinned ? pinned + "\n" : "") + (live ? text : "");
}

function h3(text) { const e = document.createElement("h3"); e.textContent = text; panel.append(e); }
function buttons(list) {
  const row = document.createElement("div");
  row.className = "views";
  for (const [label, fn, on] of list) {
    const b = document.createElement("button");
    b.textContent = label;
    if (on) b.classList.add("on");
    b.addEventListener("click", () => { b.blur(); fn(b); });
    row.append(b);
  }
  panel.append(row);
  return row;
}
const sliders = [];
function slider(label, get, set, min, max, step, onChange) {
  const row = document.createElement("label");
  row.className = "row";
  const name = document.createElement("span"); name.textContent = label;
  const input = document.createElement("input");
  Object.assign(input, { type: "range", min, max, step, value: get() });
  const out = document.createElement("output");
  const show = () => { out.textContent = (+get()).toFixed(step < 1 ? 2 : 0); };
  input.addEventListener("input", () => { set(+input.value); show(); onChange?.(); });
  row.append(name, input, out);
  panel.append(row);
  show();
  sliders.push(() => { input.value = get(); show(); });
}
function check(label, get, set) {
  const row = document.createElement("label");
  row.className = "row";
  const name = document.createElement("span"); name.textContent = label;
  const input = document.createElement("input");
  Object.assign(input, { type: "checkbox", checked: get() });
  input.addEventListener("change", () => set(input.checked));
  row.append(name, input);
  panel.append(row);
}

h3("Preset");
const presetRow = buttons(Object.entries(PRESETS).map(([key, p]) => [p.label, (b) => {
  ui.preset = key;
  for (const x of presetRow.children) x.classList.toggle("on", x === b);
  book = null; card.mesh.visible = false;
  noteEl.textContent = p.note;
  sliders.forEach((s) => s.call());
  startLive();
}, key === ui.preset]));
const noteEl = document.createElement("p");
noteEl.className = "help";
noteEl.textContent = PRESETS[ui.preset].note;
panel.append(noteEl);
buttons([["Replay", () => replay()], ["Restart sim", () => startLive()], ["Pause", (b) => { ui.live = !ui.live; b.classList.toggle("on", !ui.live); }]]);

const B = () => work[ui.preset].bake;
h3("Bake box");
slider("pitch °", () => B().pitch, (v) => { B().pitch = v; }, 0, 70, 1, frameView);
slider("box size m", () => B().size, (v) => { B().size = v; }, 1, 20, 0.1);
slider("centre y m", () => B().center[1], (v) => { B().center[1] = v; }, 0, 12, 0.05);
slider("start s", () => B().start, (v) => { B().start = v; }, 0, 15, 0.05);
slider("duration s", () => B().duration, (v) => { B().duration = v; }, 0.5, 10, 0.05);
slider("cell px", () => ui.cell, (v) => { ui.cell = v; }, 128, 256, 64);
slider("supersample", () => ui.ss, (v) => { ui.ss = v; }, 1, 3, 1);
check("flip rows", () => ui.flipRows, (v) => { ui.flipRows = v; });
check("show box", () => ui.showBox, (v) => { ui.showBox = v; });

h3("Bake");
const bakeRow = buttons([
  ["Bake", () => doBake()],
  ["Cancel", () => { cancel = true; }],
  ["Save", () => doSave()],
  ["Load saved", () => doLoad()],
]);
panel.append(statusEl);

h3("Light (both sides)");
slider("sun azimuth", () => ui.sunAz, (v) => { ui.sunAz = v; }, -180, 180, 1);
slider("sun elevation", () => ui.sunEl, (v) => { ui.sunEl = v; }, 2, 89, 1);
slider("sun", () => sun.intensity, (v) => { sun.intensity = v; }, 0, 8, 0.05);
slider("ambient", () => ambient.intensity, (v) => { ambient.intensity = v; }, 0, 2, 0.01);
slider("card fire ×", () => ui.fireK, (v) => { ui.fireK = v; }, 0, 4, 0.05);
check("card motion", () => ui.motion, (v) => { ui.motion = v; });

h3("Atlases");
const atlasEl = document.createElement("div");
atlasEl.id = "atlases";
panel.append(atlasEl);
const help = document.createElement("p");
help.className = "help";
help.textContent = "A: lit +X +Y +Z · opacity · B.a: flame light · MV: motion (rg) + flame warmth (b).";
panel.append(help);

function showAtlases(r) {
  atlasEl.textContent = "";
  const views = [
    ["A rgb (lit +X +Y +Z)", (s, d, i) => { d[i] = s.A[i]; d[i + 1] = s.A[i + 1]; d[i + 2] = s.A[i + 2]; d[i + 3] = s.A[i + 3] ? 255 : 0; }],
    ["A.a opacity", (s, d, i) => { d[i] = d[i + 1] = d[i + 2] = s.A[i + 3]; d[i + 3] = 255; }],
    ["B.a flame light", (s, d, i) => { d[i] = s.B[i + 3]; d[i + 1] = s.B[i + 3] * 0.55; d[i + 2] = s.B[i + 3] * 0.15; d[i + 3] = 255; }],
    ["MV rg + warmth", (s, d, i) => { d[i] = s.M[i]; d[i + 1] = s.M[i + 1]; d[i + 2] = s.M[i + 2]; d[i + 3] = 255; }],
  ];
  for (const [label, px] of views) {
    const fig = document.createElement("figure");
    const c = document.createElement("canvas");
    c.width = r.W; c.height = r.H;
    const ctx = c.getContext("2d");
    const img = ctx.createImageData(r.W, r.H);
    for (let i = 0; i < img.data.length; i += 4) px(r, img.data, i);
    ctx.putImageData(img, 0, 0);
    const cap = document.createElement("figcaption"); cap.textContent = label;
    fig.append(c, cap);
    atlasEl.append(fig);
  }
}

async function doBake() {
  if (baking) return;
  baking = true; cancel = false;
  for (const b of bakeRow.children) b.disabled = b.textContent !== "Cancel";
  const preset = work[ui.preset];
  const bakeScene = new THREE.Scene();
  let bs = null;
  try {
    status("building a fresh simulation for the bake…");
    bs = await buildSim(preset, bakeScene, { bake: true });
    bs.rearm();
    const r = await bakeBook({
      renderer, scene: bakeScene, sim: bs.sim, preset, beforeStep: bs.timeEmitters,
      opts: { cell: ui.cell, ss: ui.ss, cols: 8, rows: 8, flipRows: ui.flipRows },
      onProgress: (i, n, s) => status(`baking frame ${i}/${n}   ${s.toFixed(1)} s`),
      cancelled: () => cancel,
    });
    lastBake = r;
    book = r.meta;
    card.setBook(bookTextures(r), r.meta);
    showAtlases(r);
    status(`baked ${r.meta.frames} frames (${r.W}×${r.H}) in ${r.meta.seconds} s — Save writes it`);
  } catch (e) {
    status(`bake failed: ${e.message}`);
    console.error(e);
  } finally {
    bs?.sim.dispose();
    for (const b of bakeRow.children) b.disabled = false;
    baking = false;
    clock.getDelta();
    replay();
  }
}

async function post(url, body) {
  const r = await fetch(url, { method: "POST", body });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
async function doSave() {
  if (!lastBake) { status("nothing baked yet"); return; }
  const name = `fp_${ui.preset}`, { W, H } = lastBake;
  try {
    status("saving…");
    const out = [];
    for (const [suffix, bytes, q] of [["a", lastBake.A, 92], ["b", lastBake.B, 92], ["mv", lastBake.M, -1]])
      out.push(await post(`/__fire-bake/save?name=${name}_${suffix}&w=${W}&h=${H}&q=${q}`, bytes));
    out.push(await post(`/__fire-bake/save?name=${name}&json=1`, JSON.stringify({ ...lastBake.meta, preset: ui.preset, bake: work[ui.preset].bake })));
    status(out.map((o) => `${o.file}  ${(o.bytes / 1024).toFixed(0)} KB`).join("\n"));
  } catch (e) { status(`save failed: ${e.message}`); }
}
async function doLoad() {
  try {
    const { meta, tex } = await loadBookTextures(`/textures/fx/firepro/fp_${ui.preset}`);
    book = meta;
    card.setBook(tex, meta);
    status(`loaded fp_${ui.preset} (the saved webp files, as the game would read them)`);
  } catch (e) { status(`nothing saved for ${ui.preset} (${e.message})`); }
}

window.__fireLab = { renderer, scene, camera, controls, card, ui, work, get live() { return live; }, get book() { return book; }, get lastBake() { return lastBake; }, doBake, doSave, doLoad, replay };
frameView();
await startLive().catch((e) => { status(`Fire Pro failed to start: ${e.message}`); console.error(e); });
