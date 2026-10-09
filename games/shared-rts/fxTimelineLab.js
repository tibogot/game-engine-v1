// FX TIMELINE LAB — build an effect out of layers on a timeline, see it play on the ground under
// the RTS camera, save it for the games (you, 2026-10-09: "the best UI and UX — everything as
// easy to understand and tweak as possible").
//
//   the TIMELINE   a coloured bar per layer: drag it to move it in time, drag an edge to trim
//                  it, click it to edit it; drag in the ruler to scrub to any moment
//   the INSPECTOR  the selected layer's settings in words, with units and a hint each;
//                  double-click a setting's name to put it back to its default
//   the TOP BAR    start from a ready-made effect, open / save yours, undo / redo
//
// Everything plays through games/shared-rts/fxTimeline.js — the same player a game uses — so
// what you see here is what a game shows. Saved: public/textures/fx/firepro/fx_<name>.json
// (+ fx_index.json, the list), through the fire-bake lab's dev save (vite.config.js).
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { KINDS, SOUND_SLOTS, createFxPlayer, effectDuration, newTrack } from "./fxTimeline.js";

const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const SAVE_DIR = "/textures/fx/firepro/";
const DRAFT_KEY = "fxTimelineLab.draft.v1";

// ── THE READY-MADE EFFECTS (Start from…) ─────────────────────────────────────────
const T = (kind, start, length, over = {}) => ({ ...newTrack(kind, start), length, ...over });
const PRESETS = {
  rocket: {
    label: "Rocket hit", hint: "Dust spikes, a flash, clods of earth, a scorch, a jolt.",
    make: () => [
      T("sound", 0, 2, { label: "Bang", slot: "explosion" }),
      T("light", 0, 0.45, { label: "Flash", color: "#ffb46a", intensity: 220, range: 30 }),
      T("book", 0, 3, { label: "Dust spikes", book: "rocket", size: 15 }),
      T("debris", 0, 2.6, { label: "Clods", count: 45, speed: 15, spread: 40, size: 0.22 }),
      T("scorch", 0.05, 10, { label: "Scorch", radius: 3.5 }),
      T("shake", 0, 0.6, { label: "Jolt", strength: 0.35 }),
    ],
  },
  mortar: {
    label: "Mortar in sand", hint: "The whistle, then the hit: a timeline's whole point.",
    make: () => [
      T("sound", 0, 1.2, { label: "Whistle", slot: "incoming" }),
      T("sound", 1.2, 2, { label: "Bang", slot: "explosion", volume: 0.7 }),
      T("light", 1.2, 0.3, { label: "Flash", intensity: 140, range: 22 }),
      T("book", 1.2, 3, { label: "Dust", book: "shell", size: 10 }),
      T("debris", 1.2, 2, { label: "Clods", count: 25, speed: 10, spread: 35, size: 0.18 }),
      T("scorch", 1.25, 9, { label: "Scorch", radius: 2.5 }),
      T("shake", 1.2, 0.4, { label: "Jolt", strength: 0.2 }),
    ],
  },
  wp: {
    label: "White phosphorus", hint: "Burning streamers arcing out, a white flash.",
    make: () => [
      T("sound", 0, 2, { label: "Bang", slot: "explosion", volume: 0.7, pitch: 1.1 }),
      T("light", 0, 0.6, { label: "White flash", color: "#fff2d8", intensity: 320, range: 35 }),
      T("book", 0, 3.6, { label: "WP streamers", book: "wp", size: 16 }),
      T("scorch", 0.1, 12, { label: "Burn", radius: 4, color: "#2a2622", darkness: 0.6 }),
      T("shake", 0, 0.4, { label: "Jolt", strength: 0.2 }),
    ],
  },
  fireball: {
    label: "Fuel fireball", hint: "A vehicle or a fuel dump going up, the ground burning after.",
    make: () => [
      T("sound", 0, 2, { label: "Bang", slot: "explosion", pitch: 0.85 }),
      T("light", 0, 2.5, { label: "Fire light", curve: "flicker", color: "#ff9a40", intensity: 260, range: 40, height: 4 }),
      T("book", 0, 4, { label: "Fireball", book: "blast", size: 12 }),
      T("book", 1.5, 9, { label: "Burning ground", book: "napalmFire", size: 8, brightness: 1 }),
      T("scorch", 0.1, 12, { label: "Scorch", radius: 5 }),
      T("shake", 0, 0.8, { label: "Jolt", strength: 0.5 }),
    ],
  },
  signal: {
    label: "Signal smoke", hint: "A yellow grenade marking a landing zone.",
    make: () => [T("book", 0, 20, { label: "Yellow smoke", book: "signal", size: 8, tint: "#e8c21e", fadeOut: 0.1 })],
  },
  wreck: {
    label: "Burning wreck", hint: "A long fire with its light flickering on the ground.",
    make: () => [
      T("book", 0, 20, { label: "Fire", book: "wreck", size: 7 }),
      T("light", 0, 20, { label: "Fire light", curve: "flicker", color: "#ff8a3a", intensity: 60, range: 15, height: 2 }),
    ],
  },
};
const fromPreset = (key) => ({ name: PRESETS[key].label, tracks: PRESETS[key].make() });

// ── THE SCENE: the game's day light, the RTS camera ──────────────────────────────
const view = $("view");
const renderer = new THREE.WebGPURenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.55;
renderer.shadowMap.enabled = true;
view.prepend(renderer.domElement);
await renderer.init();

const scene = new THREE.Scene();
{
  const W = 64, H = 32, d = new Float32Array(W * H * 4);
  const zen = [0.18, 0.36, 0.75], hor = [0.95, 0.98, 1.0], gnd = [0.32, 0.24, 0.16];
  for (let y = 0; y < H; y++) {
    const el_ = (1 - (y + 0.5) / H) * 2 - 1;
    const c = el_ > 0 ? hor.map((h, i) => h + (zen[i] - h) * Math.pow(el_, 0.55)) : gnd;
    for (let x = 0; x < W; x++) d.set([...c.map((q) => q * 1.6), 1], (y * W + x) * 4);
  }
  const sky = new THREE.DataTexture(d, W, H, THREE.RGBAFormat, THREE.FloatType);
  sky.mapping = THREE.EquirectangularReflectionMapping;
  sky.magFilter = sky.minFilter = THREE.LinearFilter;
  sky.needsUpdate = true;
  scene.environment = scene.background = sky;
}
const sun = new THREE.DirectionalLight(0xfff2dd, 10);
sun.position.set(-0.739, 0.65, 0.175).multiplyScalar(80);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -30, right: 30, top: 30, bottom: -30, near: 1, far: 200 });
sun.shadow.bias = -0.0005;
scene.add(sun, sun.target);
{
  const tex = (f, srgb) => {
    const t = new THREE.TextureLoader().load(`/textures/ground/dry_mud_field_001/dry_mud_field_001_${f}_1k.jpg`);
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(60, 60); t.anisotropy = 8;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(240, 240).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ map: tex("diff", true), normalMap: tex("nor_gl"), roughness: 1, color: 0xd8c6a8 }));
  ground.receiveShadow = true;
  scene.add(ground);
  // A man for scale, 2 m left of the effect's centre.
  const olive = new THREE.MeshStandardMaterial({ color: 0x4b4a33, roughness: 0.9 });
  const man = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.25, 1.1, 4, 10), olive); body.position.y = 0.8;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.15, 12, 8), olive); head.position.y = 1.6;
  man.add(body, head);
  man.position.set(-6, 0, 3);
  man.traverse((o) => { o.castShadow = true; });
  scene.add(man);
}
const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 2000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.495;
const CAMS = {
  // CoH play distance (~34 m, pitched ~45°): close enough to judge an effect, as you play.
  rts: () => { controls.target.set(0, 2.5, 0); camera.position.set(0, 2.5 + Math.sin(0.78) * 34, Math.cos(0.78) * 34); },
  close: () => { controls.target.set(0, 3, 0); camera.position.set(0, 8, 20); },
  side: () => { controls.target.set(0, 4, 0); camera.position.set(26, 2.5, 4); },
};
function setCam(k) { CAMS[k](); controls.update(); for (const b of $("cam").children) b.classList.toggle("on", b.dataset.cam === k); }
for (const b of $("cam").children) b.addEventListener("click", () => { b.blur(); setCam(b.dataset.cam); });
setCam("rts");
new ResizeObserver(() => {
  const r = view.getBoundingClientRect();
  renderer.setSize(r.width, r.height, false);
  camera.aspect = r.width / Math.max(1, r.height);
  camera.updateProjectionMatrix();
  layoutTimeline();
}).observe(view);

// ── SOUND (the alg-rts recordings) ───────────────────────────────────────────────
let audioCtx = null, soundOn = true;
const buffers = new Map();
let manifest = null;
fetch("/sounds/alg/manifest.json").then((r) => r.json()).then((m) => {
  manifest = m;
  SOUND_SLOTS.length = 0;
  SOUND_SLOTS.push(...Object.keys(m.slots).sort());
}).catch(() => {});
async function bufferOf(slot) {
  const S = manifest?.slots?.[slot];
  const f = S?.files?.[S.use?.[0] ?? 0];
  if (!f || !audioCtx) return null;
  if (!buffers.has(f.f)) buffers.set(f.f, fetch(`/sounds/alg/${f.f}`).then((r) => r.arrayBuffer()).then((b) => audioCtx.decodeAudioData(b)).catch(() => null));
  return { buf: await buffers.get(f.f), file: f };
}
async function playSound(slot, at, { volume = 1, pitch = 1, length = 2 } = {}) {
  if (!soundOn || !audioCtx) return;
  const s = await bufferOf(slot);
  if (!s?.buf) return;
  const src = audioCtx.createBufferSource(), g = audioCtx.createGain();
  src.buffer = s.buf;
  src.playbackRate.value = pitch * speed;
  g.gain.value = volume * (s.file.gain ?? 1);
  src.connect(g).connect(audioCtx.destination);
  const start = s.file.start ?? 0;
  src.start(0, start);
  // A loop recording (fire) is cut at the bar's end.
  if (manifest.slots[slot]?.loop) src.stop(audioCtx.currentTime + length / speed);
}
const wakeAudio = () => { if (!audioCtx) audioCtx = new AudioContext(); audioCtx.resume(); };
addEventListener("pointerdown", wakeAudio, { capture: true });
addEventListener("keydown", wakeAudio, { capture: true });

// ── THE PLAYER (the game's own) ──────────────────────────────────────────────────
const player = createFxPlayer({ scene, onSound: (slot, at, o) => playSound(slot, at, o) });
let fx = fromPreset("rocket");
const inst = player.instance(fx, new THREE.Vector3(0, 0, 0));

// ── STATE ────────────────────────────────────────────────────────────────────────
let t = 0, playing = true, loop = true, speed = 1, selId = null;
let savedJson = null;   // as last saved (or opened): the ● when it differs
const history = [], redo = [];
const json = () => JSON.stringify(fx);
const sel = () => fx.tracks.find((q) => q.id === selId) ?? null;
const dur = () => effectDuration(fx);

function setFx(next, { keepSel = true, fresh = false } = {}) {
  fx = next;
  inst.fx = fx;
  if (!keepSel || !sel()) selId = null;
  if (fresh) { history.length = 0; redo.length = 0; history.push(json()); }
  $("fxName").value = fx.name ?? "";
  renderTimeline();
  renderInspector();
  markDirty();
  inst.ready();
}
/** A finished change: undo point, the draft kept. */
function commit() {
  const j = json();
  if (history[history.length - 1] === j) return;
  history.push(j);
  if (history.length > 150) history.shift();
  redo.length = 0;
  try { localStorage.setItem(DRAFT_KEY, j); } catch {}
  markDirty();
  updateUndo();
}
function undo() {
  if (history.length < 2) return;
  redo.push(history.pop());
  setFx(JSON.parse(history[history.length - 1]));
  updateUndo();
  toast("Undone");
}
function redoIt() {
  if (!redo.length) return;
  const j = redo.pop();
  history.push(j);
  setFx(JSON.parse(j));
  updateUndo();
  toast("Redone");
}
function updateUndo() { $("btnUndo").disabled = history.length < 2; $("btnRedo").disabled = !redo.length; }
function markDirty() { $("dirty").classList.toggle("show", json() !== savedJson); }
let toastT = 0;
function toast(msg) { const e = $("toast"); e.textContent = msg; e.classList.add("show"); clearTimeout(toastT); toastT = setTimeout(() => e.classList.remove("show"), 1800); }

// ── TIMELINE ─────────────────────────────────────────────────────────────────────
const PAD = 10;                 // px before 0 s in a lane
let pps = 120;                  // pixels a second
const laneW = () => $("rulerLane").clientWidth;
const tToX = (s) => PAD + s * pps;
const xToT = (x) => (x - PAD) / pps;
const snapT = (s, free) => ($("snap").checked && !free ? Math.round(s / 0.05) * 0.05 : Math.round(s * 1000) / 1000);
const fmt = (s) => `${s.toFixed(2)} s`;

function fitZoom() {
  const w = laneW();
  if (w > 50) { pps = Math.max(40, Math.min(400, (w - PAD * 2) / (dur() + 0.6))); $("zoom").value = pps; }
  layoutTimeline();
}
$("zoom").addEventListener("input", () => { pps = +$("zoom").value; layoutTimeline(); });
$("zoom").addEventListener("dblclick", fitZoom);
{
  const b = el("button", "icon", "Fit");
  b.title = "Zoom so the whole effect fits";
  b.addEventListener("click", () => { b.blur(); fitZoom(); });
  $("zoom").parentElement.after(b);
}

function renderRuler() {
  const lane = $("rulerLane");
  lane.textContent = "";
  const span = (laneW() - PAD) / pps;
  const step = pps > 200 ? 0.25 : pps > 90 ? 0.5 : pps > 50 ? 1 : 2;
  for (let s = 0; s <= span + step; s += step / 2) {
    const major = Math.abs(s / step - Math.round(s / step)) < 1e-6;
    const k = el("div", `tick${major ? "" : " minor"}`, major ? `${+s.toFixed(2)}s` : "");
    k.style.left = `${tToX(s)}px`;
    lane.append(k);
  }
}

function renderTimeline() {
  const rows = $("rows");
  rows.textContent = "";
  if (!fx.tracks.length) {
    rows.append(el("div", "", ""));
    const e = el("div", "", "No layers yet. <b>+ Add layer</b> (bottom right) puts one at the playhead, or <b>Start from…</b> picks a ready-made effect.");
    e.id = "tlEmpty";
    rows.append(e);
  }
  for (const tr of fx.tracks) {
    const K = KINDS[tr.kind];
    const row = el("div", `trk${tr.id === selId ? " sel" : ""}${tr.on ? "" : " off"}`);
    row.dataset.id = tr.id;
    const name = el("div", "name");
    name.innerHTML = `<span class="ic" style="color:${K.color}">${K.icon}</span><span class="nm" title="${esc(K.label)} — double-click to rename">${esc(tr.label)}</span>`;
    const eye = el("button", "", tr.on ? "👁" : "◌");
    eye.title = tr.on ? "Mute this layer" : "Turn this layer back on";
    eye.addEventListener("click", (e) => { e.stopPropagation(); tr.on = !tr.on; commit(); renderTimeline(); });
    const del = el("button", "", "✕");
    del.title = "Delete this layer (Del)";
    del.addEventListener("click", (e) => { e.stopPropagation(); removeTrack(tr.id); });
    name.append(eye, del);
    name.addEventListener("click", () => select(tr.id));
    name.querySelector(".nm").addEventListener("dblclick", (e) => { e.stopPropagation(); rename(tr, e.target); });
    const lane = el("div", "lane");
    lane.addEventListener("pointerdown", (e) => { if (e.target === lane) select(tr.id); });
    const bar = el("div", "bar");
    bar.style.background = K.color;
    bar.innerHTML = `<span class="edge l" title="Drag: start later / earlier"></span><span class="lbl">${esc(tr.label)}</span><span class="edge r" title="Drag: longer / shorter"></span>`;
    bar.title = `${K.label}: ${fmt(tr.start)} → ${fmt(tr.start + tr.length)}. Drag to move, drag an edge to trim.`;
    bar.addEventListener("pointerdown", (e) => startDrag(e, tr, e.target.classList.contains("l") ? "l" : e.target.classList.contains("r") ? "r" : "move"));
    lane.append(bar);
    row.append(name, lane);
    rows.append(row);
  }
  fitTimelineHeight();
  layoutTimeline();
}
// The timeline's height fits its layers (up to half the window) until you drag its edge.
let userSizedTl = false;
function fitTimelineHeight() {
  if (userSizedTl) return;
  const h = 40 + 22 + Math.max(1, fx.tracks.length) * 34 + 14;
  $("app").style.setProperty("--tl-h", `${Math.max(170, Math.min(innerHeight * 0.5, h))}px`);
}
function layoutTimeline() {
  renderRuler();
  for (const row of $("rows").querySelectorAll(".trk")) {
    const tr = fx.tracks.find((q) => q.id === row.dataset.id);
    if (!tr) continue;
    const bar = row.querySelector(".bar");
    bar.style.left = `${tToX(tr.start)}px`;
    bar.style.width = `${Math.max(10, tr.length * pps)}px`;
  }
  placePlayhead();
}
let playheadEl = null;
function placePlayhead() {
  if (!playheadEl) { playheadEl = el("div"); playheadEl.id = "playhead"; $("tl").append(playheadEl); }
  const lane = $("rulerLane"), r = lane.getBoundingClientRect(), tl = $("tl").getBoundingClientRect();
  const x = r.left - tl.left + tToX(t);
  playheadEl.style.left = `${x - 1}px`;
  playheadEl.style.top = `${r.top - tl.top}px`;
  playheadEl.style.display = x < r.left - tl.left || x > r.right - tl.left ? "none" : "";
}

// Dragging a bar: move / trim, snapped, with a live readout.
let drag = null;
function startDrag(e, tr, mode) {
  e.preventDefault(); e.stopPropagation();
  select(tr.id);
  drag = { tr, mode, x0: e.clientX, start: tr.start, length: tr.length };
  try { e.target.setPointerCapture(e.pointerId); } catch {}
}
addEventListener("pointermove", (e) => {
  if (!drag) return;
  const d = (e.clientX - drag.x0) / pps, free = e.shiftKey, tr = drag.tr;
  if (drag.mode === "move") tr.start = Math.max(0, snapT(drag.start + d, free));
  else if (drag.mode === "r") tr.length = Math.max(0.05, snapT(drag.length + d, free));
  else {
    const end = drag.start + drag.length;
    tr.start = Math.min(end - 0.05, Math.max(0, snapT(drag.start + d, free)));
    tr.length = end - tr.start;
  }
  layoutTimeline();
  syncWhen();
  markDirty();
  const tip = $("dragTip");
  tip.style.display = "block";
  tip.style.left = `${e.clientX + 14}px`;
  tip.style.top = `${e.clientY - 26}px`;
  tip.textContent = `${fmt(tr.start)} → ${fmt(tr.start + tr.length)}  (${fmt(tr.length)})`;
});
addEventListener("pointerup", () => {
  if (!drag) return;
  drag = null;
  $("dragTip").style.display = "none";
  commit();
  renderTimeline();
});

// Scrubbing: drag in the ruler.
let scrubbing = false;
function scrubTo(e) {
  const r = $("rulerLane").getBoundingClientRect();
  t = Math.max(0, Math.min(dur() + 0.5, xToT(e.clientX - r.left)));
  render(false);
}
$("rulerLane").addEventListener("pointerdown", (e) => { scrubbing = true; setPlaying(false); scrubTo(e); try { e.target.setPointerCapture(e.pointerId); } catch {} });
$("rulerLane").addEventListener("pointermove", (e) => { if (scrubbing) scrubTo(e); });
$("rulerLane").addEventListener("pointerup", () => { scrubbing = false; });

// The timeline's height: drag its top edge.
{
  let y0 = 0, h0 = 0, on = false;
  $("tlResize").addEventListener("pointerdown", (e) => { on = true; userSizedTl = true; y0 = e.clientY; h0 = $("tl").getBoundingClientRect().height; try { e.target.setPointerCapture(e.pointerId); } catch {} });
  $("tlResize").addEventListener("pointermove", (e) => { if (on) $("app").style.setProperty("--tl-h", `${Math.max(140, Math.min(innerHeight - 200, h0 - (e.clientY - y0)))}px`); });
  $("tlResize").addEventListener("pointerup", () => { on = false; layoutTimeline(); });
}

function select(id) {
  selId = id;
  for (const row of $("rows").querySelectorAll(".trk")) row.classList.toggle("sel", row.dataset.id === id);
  renderInspector();
}
function rename(tr, span) {
  const input = el("input");
  input.type = "text";
  input.value = tr.label;
  input.style.width = "100%";
  span.replaceWith(input);
  input.focus(); input.select();
  const done = (ok) => { if (ok && input.value.trim()) tr.label = input.value.trim(); commit(); renderTimeline(); renderInspector(); };
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") done(true); if (e.key === "Escape") done(false); e.stopPropagation(); });
  input.addEventListener("blur", () => done(true));
}
function addTrack(kind) {
  const tr = newTrack(kind, Math.max(0, snapT(t, false)));
  fx.tracks.push(tr);
  commit();
  renderTimeline();
  select(tr.id);
  toast(`${KINDS[kind].label} added at ${fmt(tr.start)}`);
}
function removeTrack(id) {
  const tr = fx.tracks.find((q) => q.id === id);
  if (!tr) return;
  fx.tracks = fx.tracks.filter((q) => q.id !== id);
  if (selId === id) selId = null;
  commit();
  renderTimeline();
  renderInspector();
  toast(`"${tr.label}" deleted — Ctrl+Z brings it back`);
}
function duplicate(id) {
  const tr = fx.tracks.find((q) => q.id === id);
  if (!tr) return;
  const copy = { ...structuredClone(tr), id: newTrack(tr.kind).id, label: `${tr.label} (copy)`, start: tr.start + 0.1 };
  fx.tracks.splice(fx.tracks.indexOf(tr) + 1, 0, copy);
  commit();
  renderTimeline();
  select(copy.id);
}

// ── INSPECTOR ────────────────────────────────────────────────────────────────────
let whenFields = null;
function syncWhen() {
  const tr = sel();
  if (!tr || !whenFields) return;
  whenFields.start(tr.start);
  whenFields.length(tr.length);
}
function fieldRange(parent, { label, unit = "", min, max, step, hint, get, set, def }) {
  const f = el("div", "field");
  const lab = el("div", "lab");
  const name = el("span", "", esc(label));
  name.title = `${hint ? hint + "\n" : ""}Double-click to reset${def != null ? ` (${def}${unit ? " " + unit : ""})` : ""}`;
  lab.append(name);
  const ctl = el("div", "ctl");
  const r = el("input"); Object.assign(r, { type: "range", min, max, step });
  const n = el("input"); Object.assign(n, { type: "number", min, max, step });
  const u = el("span", "unit", esc(unit));
  const show = (v) => { r.value = v; n.value = +(+v).toFixed(step < 0.01 ? 3 : step < 1 ? 2 : 0); name.classList.toggle("mod", def != null && Math.abs(v - def) > 1e-9); };
  show(get());
  r.addEventListener("input", () => { set(+r.value); show(+r.value); after(); });
  r.addEventListener("change", commit);
  n.addEventListener("change", () => { const v = Math.min(max, Math.max(min, +n.value || 0)); set(v); show(v); after(); commit(); });
  name.addEventListener("dblclick", () => { if (def == null) return; set(def); show(def); after(); commit(); });
  ctl.append(r, n, u);
  f.append(lab, ctl);
  if (hint) f.append(el("div", "hint", esc(hint)));
  parent.append(f);
  return show;
}
function after() { markDirty(); if (!playing) render(false); layoutTimeline(); }

function renderInspector() {
  const box = $("insp");
  box.textContent = "";
  whenFields = null;
  const tr = sel();
  if (!tr) return renderOverview(box);
  const K = KINDS[tr.kind];
  const h = el("h2");
  h.innerHTML = `<span class="ic" style="background:${K.color}">${K.icon}</span>`;
  const nameIn = el("input");
  Object.assign(nameIn, { type: "text", value: tr.label, title: "The layer's name (only for you)" });
  nameIn.style.flex = "1";
  nameIn.addEventListener("input", () => { tr.label = nameIn.value; renderTimelineLabels(); markDirty(); });
  nameIn.addEventListener("change", commit);
  h.append(nameIn);
  box.append(h, el("p", "kindHint", `<b>${esc(K.label)}.</b> ${esc(K.hint)}`));

  box.append(el("h3", "", "When"));
  whenFields = {
    start: fieldRange(box, { label: "Starts at", unit: "s", min: 0, max: 30, step: 0.01, def: null, hint: "Or drag the bar.", get: () => tr.start, set: (v) => { tr.start = v; } }),
    length: fieldRange(box, { label: "Lasts", unit: "s", min: 0.05, max: 60, step: 0.01, def: K.length, hint: K.lengthHint, get: () => tr.length, set: (v) => { tr.length = v; } }),
  };

  box.append(el("h3", "", "Settings"));
  for (const [k, p] of Object.entries(K.params)) {
    if (p.type === "range") {
      fieldRange(box, { label: p.label, unit: p.unit, min: p.min, max: p.max, step: p.step, hint: p.hint, def: p.def, get: () => tr[k], set: (v) => { tr[k] = v; } });
    } else if (p.type === "select") {
      const f = el("div", "field");
      f.append(el("div", "lab", `<span title="${esc(p.hint ?? "")}">${esc(p.label)}</span>`));
      const s = el("select");
      for (const [v, l] of p.options()) s.append(new Option(l, v, false, v === tr[k]));
      s.addEventListener("change", () => {
        tr[k] = s.value;
        // A new book: its own colour back, and the bar as long as a one-shot needs.
        if (k === "book") { tr.tint = null; renderInspector(); }
        after(); commit();
      });
      f.append(s);
      if (p.hint) f.append(el("div", "hint", esc(p.hint)));
      box.append(f);
    } else if (p.type === "color") {
      const f = el("div", "field");
      const lab = el("div", "lab", `<span title="${esc(p.hint ?? "")}">${esc(p.label)}</span>`);
      const ctl = el("div", "ctl");
      const c = el("input"); c.type = "color";
      // Unset (null) = the book's own: show THAT colour (its baked tint, linear → sRGB hex).
      const ownHex = () => { const m = tr.kind === "book" ? inst.bookMetaSync?.(tr.book) : null; return m?.tint ? `#${new THREE.Color().fromArray(m.tint).getHexString()}` : "#888888"; };
      c.value = tr[k] ?? ownHex();
      const own = el("span", "own", tr[k] == null ? "the book's own" : "");
      c.addEventListener("input", () => { tr[k] = c.value; own.textContent = ""; after(); });
      c.addEventListener("change", commit);
      ctl.append(c, own);
      if (p.def === null) {
        const reset = el("button", "", "Book's own");
        reset.title = "Back to the colour baked into the book";
        reset.addEventListener("click", () => { tr[k] = null; c.value = ownHex(); own.textContent = "the book's own"; after(); commit(); });
        ctl.append(reset);
      } else lab.querySelector("span").addEventListener("dblclick", () => { tr[k] = p.def; c.value = p.def; after(); commit(); });
      f.append(lab, ctl);
      if (p.hint) f.append(el("div", "hint", esc(p.hint)));
      box.append(f);
    }
  }
  const row = el("div", "row");
  const go = el("button", "", "▶ Play from here");
  go.title = "Jump to this layer's start and play";
  go.addEventListener("click", () => { t = tr.start; inst.resetSounds(); setPlaying(true); });
  const dup = el("button", "", "Duplicate");
  dup.title = "Ctrl+D";
  dup.addEventListener("click", () => duplicate(tr.id));
  const del = el("button", "", "Delete");
  del.style.color = "var(--danger)";
  del.title = "Del";
  del.addEventListener("click", () => removeTrack(tr.id));
  row.append(go, dup, del);
  box.append(row);
}
function renderTimelineLabels() {
  for (const row of $("rows").querySelectorAll(".trk")) {
    const tr = fx.tracks.find((q) => q.id === row.dataset.id);
    if (!tr) continue;
    row.querySelector(".nm").textContent = tr.label;
    row.querySelector(".lbl").textContent = tr.label;
  }
}
function renderOverview(box) {
  const d = dur();
  box.append(el("h2", "", `<span class="ic" style="background:var(--accent)">✦</span>${esc(fx.name || "Untitled effect")}`));
  const e = el("div", "empty");
  e.innerHTML = `
    <p>${fx.tracks.length} layer${fx.tracks.length === 1 ? "" : "s"}, ${d.toFixed(2)} s long.</p>
    <h3>How it works</h3>
    <p><b>Click a bar</b> in the timeline to edit that layer here. <b>Drag a bar</b> to move it in time, <b>drag its edges</b> to make it start later or last longer. <b>Drag in the ruler</b> to look at any moment.</p>
    <p><b>+ Add layer</b> puts a new layer at the playhead. A setting's name with a <span style="color:var(--accent)">•</span> has been changed: double-click it to put it back.</p>
    <p>The effect plays where the camera looks at, on the ground; the little man is 2 m tall, for scale.</p>
    <h3>Keys</h3>
    <div class="keys">
      <kbd>Space</kbd><span>play / pause</span>
      <kbd>Home</kbd><span>back to the start</span>
      <kbd>← →</kbd><span>step a frame (with Shift: ½ s)</span>
      <kbd>Del</kbd><span>delete the selected layer</span>
      <kbd>Ctrl D</kbd><span>duplicate it</span>
      <kbd>Ctrl Z / Y</kbd><span>undo / redo</span>
      <kbd>Ctrl S</kbd><span>save</span>
      <kbd>Esc</kbd><span>deselect</span>
      <kbd>Shift</kbd><span>while dragging: no snapping</span>
    </div>`;
  box.append(e);
}

// ── MENUS ────────────────────────────────────────────────────────────────────────
function openMenu(id, anchor, fill) {
  for (const m of document.querySelectorAll(".menu")) m.style.display = "none";
  const m = $(id);
  m.textContent = "";
  fill(m);
  m.style.display = "block";
  const r = anchor.getBoundingClientRect(), mr = m.getBoundingClientRect();
  m.style.left = `${Math.min(innerWidth - mr.width - 8, r.left)}px`;
  m.style.top = r.top > innerHeight / 2 ? `${r.top - mr.height - 6}px` : `${r.bottom + 6}px`;
}
addEventListener("pointerdown", (e) => { if (!e.target.closest(".menu") && !e.target.closest("button")) for (const m of document.querySelectorAll(".menu")) m.style.display = "none"; });
const closeMenus = () => { for (const m of document.querySelectorAll(".menu")) m.style.display = "none"; };
function menuItem(m, { icon, color, title, sub, onPick }) {
  const it = el("div", "it", `<span class="ic" style="background:${color}">${icon}</span><b>${esc(title)}</b><small>${esc(sub ?? "")}</small>`);
  it.addEventListener("click", () => { closeMenus(); onPick(); });
  m.append(it);
}
$("btnAdd").addEventListener("click", (e) => {
  e.currentTarget.blur();
  openMenu("menuAdd", e.currentTarget, (m) => {
    m.append(el("div", "head", `Add at the playhead (${fmt(t)})`));
    for (const [k, K] of Object.entries(KINDS)) menuItem(m, { icon: K.icon, color: K.color, title: K.label, sub: K.hint, onPick: () => addTrack(k) });
  });
});
$("btnStart").addEventListener("click", (e) => {
  e.currentTarget.blur();
  openMenu("menuStart", e.currentTarget, (m) => {
    m.append(el("div", "head", "Start from a ready-made effect"));
    for (const [k, P] of Object.entries(PRESETS)) menuItem(m, { icon: "✦", color: "var(--accent)", title: P.label, sub: P.hint, onPick: () => {
      if (json() !== savedJson && fx.tracks.length && !confirm("Replace the effect you are editing? (Its unsaved changes are lost; Ctrl+Z can't bring them back.)")) return;
      setFx(fromPreset(k), { keepSel: false, fresh: true });
      savedJson = json(); markDirty();   // the dot means: changed since you picked / opened / saved it
      t = 0; inst.resetSounds(); setPlaying(true); fitZoom();
      try { localStorage.setItem(DRAFT_KEY, json()); } catch {}
    } });
    menuItem(m, { icon: "∅", color: "#777", title: "Empty", sub: "Nothing yet: build it layer by layer.", onPick: () => { setFx({ name: "New effect", tracks: [] }, { keepSel: false, fresh: true }); fitZoom(); } });
  });
});

// ── SAVE / OPEN ──────────────────────────────────────────────────────────────────
const slug = (s) => (s || "effect").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "effect";
async function getIndex() {
  try { const r = await fetch(`${SAVE_DIR}fx_index.json`, { cache: "no-store" }); return r.ok ? await r.json() : []; } catch { return []; }
}
async function post(name, body) {
  const r = await fetch(`/__fire-bake/save?name=${name}&json=1`, { method: "POST", body: JSON.stringify(body) });
  if (!r.ok) throw new Error(await r.text());
}
async function save() {
  fx.name = $("fxName").value.trim() || "Untitled effect";
  const key = `fx_${slug(fx.name)}`;
  try {
    await post(key, fx);
    const index = (await getIndex()).filter((e) => e.key !== key);
    index.unshift({ key, name: fx.name, layers: fx.tracks.length, saved: new Date().toISOString().slice(0, 16).replace("T", " ") });
    await post("fx_index", index);
    savedJson = json();
    commit();
    markDirty();
    toast(`Saved "${fx.name}" → public/textures/fx/firepro/${key}.json`);
  } catch (e) { toast(`Could not save: ${e.message}`); }
}
$("btnSave").addEventListener("click", (e) => { e.currentTarget.blur(); save(); });
$("btnLoad").addEventListener("click", async (e) => {
  const anchor = e.currentTarget;
  anchor.blur();
  const index = await getIndex();
  openMenu("menuLoad", anchor, (m) => {
    m.append(el("div", "head", "Your saved effects"));
    if (!index.length) m.append(el("div", "it", `<span></span><small>Nothing saved yet — <b>Save</b> keeps the effect you are editing.</small>`));
    for (const e2 of index) menuItem(m, { icon: "▤", color: "var(--accent2)", title: e2.name, sub: `${e2.layers} layers · ${e2.saved}`, onPick: async () => {
      if (json() !== savedJson && fx.tracks.length && !confirm("Open it instead of the effect you are editing? (Unsaved changes are lost.)")) return;
      const r = await fetch(`${SAVE_DIR}${e2.key}.json`, { cache: "no-store" });
      if (!r.ok) return toast("That file is gone");
      const next = await r.json();
      setFx(next, { keepSel: false, fresh: true });
      savedJson = json();
      markDirty();
      t = 0; inst.resetSounds(); setPlaying(true); fitZoom();
      toast(`Opened "${next.name}"`);
    } });
  });
});
$("fxName").addEventListener("input", () => { fx.name = $("fxName").value; markDirty(); renderInspectorIfOverview(); });
$("fxName").addEventListener("change", commit);
const renderInspectorIfOverview = () => { if (!sel()) renderInspector(); };
$("btnCopy").addEventListener("click", async (e) => {
  e.currentTarget.blur();
  try { await navigator.clipboard.writeText(JSON.stringify(fx, null, 1)); toast("Copied the effect as JSON"); } catch { toast("The browser refused the clipboard"); }
});
$("btnUndo").addEventListener("click", (e) => { e.currentTarget.blur(); undo(); });
$("btnRedo").addEventListener("click", (e) => { e.currentTarget.blur(); redoIt(); });
$("btnSound").addEventListener("click", (e) => {
  soundOn = !soundOn;
  e.currentTarget.textContent = soundOn ? "🔊 Sound on" : "🔇 Sound off";
  e.currentTarget.classList.toggle("on", !soundOn);
  e.currentTarget.blur();
});

// ── PLAY ─────────────────────────────────────────────────────────────────────────
function setPlaying(on) {
  playing = on;
  $("btnPlay").textContent = on ? "❚❚" : "▶";
  if (on && t >= dur() + 0.3) { t = 0; inst.resetSounds(); }
}
$("btnPlay").addEventListener("click", (e) => { e.currentTarget.blur(); setPlaying(!playing); });
$("btnRestart").addEventListener("click", (e) => { e.currentTarget.blur(); t = 0; inst.resetSounds(); render(false); setPlaying(true); });
$("btnLoop").addEventListener("click", (e) => { loop = !loop; e.currentTarget.classList.toggle("on", loop); e.currentTarget.blur(); });
$("speed").addEventListener("change", (e) => { speed = +e.target.value; e.target.blur(); });

addEventListener("keydown", (e) => {
  const typing = e.target.matches?.("input[type=text], input[type=number], select, textarea");
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.key.toLowerCase() === "s") { e.preventDefault(); save(); return; }
  if (typing) return;
  if (ctrl && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redoIt() : undo(); return; }
  if (ctrl && e.key.toLowerCase() === "y") { e.preventDefault(); redoIt(); return; }
  if (ctrl && e.key.toLowerCase() === "d") { e.preventDefault(); if (selId) duplicate(selId); return; }
  if (e.key === " ") { e.preventDefault(); setPlaying(!playing); }
  else if (e.key === "Home") { t = 0; inst.resetSounds(); render(false); }
  else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
    e.preventDefault();
    setPlaying(false);
    t = Math.max(0, t + (e.key === "ArrowRight" ? 1 : -1) * (e.shiftKey ? 0.5 : 1 / 30));
    render(false);
  } else if ((e.key === "Delete" || e.key === "Backspace") && selId) removeTrack(selId);
  else if (e.key === "Escape") { select(null); closeMenus(); }
});

const _dir = new THREE.Vector3(), _sunCol = new THREE.Color(), _sky = new THREE.Color();
function render(withSounds) {
  _dir.copy(sun.position).sub(sun.target.position).normalize();
  _sunCol.copy(sun.color).multiplyScalar(sun.intensity * (0.4 / 0.65));
  _sky.setRGB(0.55, 0.62, 0.75).multiplyScalar(sun.intensity * 0.1 * 0.75);
  const { shake } = inst.setTime(t, { camera, sunDir: _dir, sunColor: _sunCol, sky: _sky }, { sounds: withSounds });
  $("time").textContent = `${t.toFixed(2)} / ${dur().toFixed(2)} s`;
  placePlayhead();
  return shake;
}
const timer = new THREE.Timer();
renderer.setAnimationLoop((now) => {
  timer.update(now);
  const dt = Math.min(timer.getDelta(), 0.1);
  controls.update();
  if (playing) {
    t += dt * speed;
    if (t > dur() + 0.4) {
      if (loop) { t = 0; inst.resetSounds(); }
      else { t = dur(); setPlaying(false); }
    }
  }
  const shake = render(playing);
  camera.position.add(shake);
  renderer.render(scene, camera);
  camera.position.sub(shake);
});

// ── START: your last edit if there is one, else the rocket hit ──────────────────
let draft = null;
try { draft = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? "null"); } catch {}
if (draft?.tracks) { setFx(draft, { keepSel: false, fresh: true }); toast("Your last edit is back (Start from… for a fresh one)"); }
else { setFx(fromPreset("rocket"), { keepSel: false, fresh: true }); savedJson = json(); markDirty(); }
updateUndo();
await inst.ready();
fitZoom();

window.__fxTimeline = { get fx() { return fx; }, setFx, inst, player, select, addTrack, save, get t() { return t; }, set t(v) { t = v; }, setPlaying, PRESETS, fromPreset, render };
