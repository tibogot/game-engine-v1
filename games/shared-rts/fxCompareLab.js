// FX COMPARE LAB — the game's fire and smoke next to the Fire Pro books, before
// anything in a game changes (you, 2026-10-07: "we should have a lab to compare first").
//
// LEFT is what alg-rts plays, run through its OWN code: combatFx (the CoH style, lit
// smoke on — as algCombat creates it) for a shell blast, flameField for a burning
// wreck (algWrecks' addFire: radius 3.2 on the hull). RIGHT is one card per effect
// playing the books baked in v3/fire-bake-lab (public/textures/fx/firepro/fp_*).
// Same sun and sky as the vehicle lab (the game's day light, exposure 0.55), the RTS
// camera's lens and its zoom → pitch curve (rtsCamera: 30° near … 58° far).
//
// Not here: the game's bloom (the flames' MRT glow) and the wreck's smoulder puffs
// (algAmbience) — both sides go without, so the comparison stays like for like.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { createCombatFx } from "./combatFx.js";
import { createFlameField } from "./flameField.js";
import { createBookCard, loadBookTextures } from "../../v3/fire-bake-lab/bookCard.js";
// THE OLD NAPALM, run through its own code (nam-rts): the strike, its fireball flipbooks, its
// smoke palls — flames are the flameField above, as in nam.
import { createNapalmStrike, NAPALM } from "../nam-rts/napalmStrike.js";
import { createFireballField } from "../nam-rts/fireballField.js";
import { createSmokeField } from "../nam-rts/smokeField.js";

const SUN = { intensity: 10, color: 0xfff2dd };
/** RTS camera (rtsCamera.js defaults): distance range and the pitch it derives from it. */
const RTS = { distMin: 18, distMax: 130, pitchNear: 30, pitchFar: 58, fov: 40 };

function gradientSky() {   // vehicleLab.js's day sky
  const W = 64, H = 32, d = new Float32Array(W * H * 4);
  const zen = [0.18, 0.36, 0.75], hor = [0.95, 0.98, 1.0], gnd = [0.32, 0.24, 0.16];
  for (let y = 0; y < H; y++) {
    const v = 1 - (y + 0.5) / H, el = v * 2 - 1;
    const c = el > 0 ? hor.map((h, i) => h + (zen[i] - h) * Math.pow(el, 0.55)) : gnd;
    for (let x = 0; x < W; x++) d.set([...c.map((q) => q * 1.6), 1], (y * W + x) * 4);
  }
  const t = new THREE.DataTexture(d, W, H, THREE.RGBAFormat, THREE.FloatType);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.magFilter = t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

const app = document.getElementById("app");
const panel = document.getElementById("panel");
// trackTimestamp: GPU ms per frame (Measure GPU), the repo's pattern (cloudBenchmark.js).
const renderer = new THREE.WebGPURenderer({ antialias: true, trackTimestamp: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.55;
app.append(renderer.domElement);
await renderer.init();

const scene = new THREE.Scene();
scene.environment = scene.background = gradientSky();
const sun = new THREE.DirectionalLight(SUN.color, SUN.intensity);
scene.add(sun, sun.target);
const tex = (f, srgb) => {
  const t = new THREE.TextureLoader().load(`/textures/ground/dry_mud_field_001/dry_mud_field_001_${f}_1k.jpg`);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(60, 60);
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
};
scene.add(new THREE.Mesh(
  new THREE.PlaneGeometry(240, 240).rotateX(-Math.PI / 2),
  new THREE.MeshStandardNodeMaterial({ map: tex("diff", true), normalMap: tex("nor_gl"), roughness: 1, color: 0xd8c6a8 }),
));

const camera = new THREE.PerspectiveCamera(RTS.fov, innerWidth / innerHeight, 0.1, 2000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.49;
addEventListener("resize", () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});

// ── the two sides ──────────────────────────────────────────────────────────────
const ui = {
  gap: 10, dist: 52, sunAz: -77, sunEl: 40,
  blastSize: 10, fpBlastCard: 14, fpLife: 1.6, fpFire: 2,
  wreckOn: true, fpWreckCard: 6.5, auto: true, every: 7,
  fpBook: "shell",                 // which Fire Pro book the blast row plays
  showGame: true, showFP: true,    // a side off = nothing of it drawn (Measure GPU)
  scene: "blast", paused: false,                  // "blast" (shell + wreck) | "napalm"
  napEvery: 22,
  fpImpactCard: 22, fpGroundCard: 13, fpColumnCard: 24,
};
const fakeApp = {
  scene, renderer, camera, getWorldHeight: () => 0,
  light: { getDirection: () => sun.position.clone().sub(sun.target.position).normalize(), sun, hemi: null },
};
const fx = createCombatFx({ app: fakeApp, style: "coh", litSmoke: true });
const fire = createFlameField({ app: fakeApp });

const BLAST_Z = -9, WRECK_Z = 7;
const hullMat = new THREE.MeshStandardNodeMaterial({ color: 0x1d1b18, roughness: 0.95 });
const hulls = [-1, 1].map((side) => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(2.6, 1.3, 5), hullMat);
  scene.add(m);
  return m;
});

const blastCard = createBookCard(), wreckCard = createBookCard();
scene.add(blastCard.mesh, wreckCard.mesh);
let blastMeta = null, wreckMeta = null;
const status = document.createElement("div");
status.id = "status";
/** The one-shot books the blast row can play: a shell in earth, or a fuel fireball. */
const FP_BOOKS = { shell: "Shell in sand", blast: "Fuel fireball" };
const fpBooks = {};
for (const key of Object.keys(FP_BOOKS)) {
  try { fpBooks[key] = await loadBookTextures(`/textures/fx/firepro/fp_${key}`); }
  catch { status.textContent += `fp_${key} not baked yet (v3/fire-bake-lab)\n`; }
}
function setBlastBook(key) {
  const b = fpBooks[key];
  if (!b) return;
  ui.fpBook = key;
  blastCard.setBook(b.tex, b.meta);
  blastMeta = b.meta;
}
setBlastBook(fpBooks[ui.fpBook] ? ui.fpBook : Object.keys(fpBooks)[0]);
try {
  const w = await loadBookTextures("/textures/fx/firepro/fp_wreck");
  wreckCard.setBook(w.tex, w.meta); wreckMeta = w.meta;
} catch { status.textContent += "fp_wreck not baked yet (v3/fire-bake-lab)\n"; }
blastCard.mesh.visible = false;

let gameFire = null;
function placeWrecks() {
  hulls[0].position.set(-ui.gap, 0.65, WRECK_Z);
  hulls[1].position.set(ui.gap, 0.65, WRECK_Z);
  const wrecks = ui.wreckOn && ui.scene === "blast";
  hulls[0].visible = wrecks && ui.showGame;
  hulls[1].visible = wrecks && ui.showFP;
  fire.clear();
  gameFire = wrecks && ui.showGame ? fire.addFire(-ui.gap, 1.2, WRECK_Z, 3.2, 3600) : null;   // algWrecks: ground y + 1.2, radius 3.2
}

let clock = 0, blastAt = -1e9, nextAuto = 1;
function blast() {
  if (ui.scene !== "blast") return;
  if (ui.showGame) fx.explosion(-ui.gap, 0, BLAST_Z, { size: ui.blastSize });
  blastAt = clock;
}

function rtsView() {
  const t = (ui.dist - RTS.distMin) / (RTS.distMax - RTS.distMin);
  const pitch = THREE.MathUtils.degToRad(RTS.pitchNear + (RTS.pitchFar - RTS.pitchNear) * t);
  controls.target.set(0, 1.5, ui.scene === "napalm" ? 0 : (BLAST_Z + WRECK_Z) / 2);
  camera.position.copy(controls.target).add(new THREE.Vector3(0, Math.sin(pitch), Math.cos(pitch)).multiplyScalar(ui.dist));
  controls.update();
}

// ── NAPALM ─────────────────────────────────────────────────────────────────────
// Both runs are nam's: 70 m along +X, NAPALM.spreadTime (2.2 s) end to end, the splash count
// napalmStrike derives (length / (width·0.85) → 4), each splash burning NAPALM.burnTime (14 s).
// GAME: napalmStrike itself. FIRE PRO, per splash: the splash book (one-shot), two
// burning-ground loops across the run, one smoke column — each a single card.
// Two rows when both sides show (game behind); a side alone burns in the middle.
const NAP_ROW = 16;
let namNapalm = null;
function gameNapalm() {
  if (!namNapalm) {
    const fireballs = createFireballField({ app: fakeApp });
    const smoke = createSmokeField({ app: fakeApp });
    const flames = createFlameField({ app: fakeApp });   // its own: placeWrecks() clears the wreck's
    const strike = createNapalmStrike({
      app: fakeApp, fire: flames, fireballs, smoke, craters: null,
      combat: { onImpact() {} }, units: { list: [] }, structures: { list: [] },
    });
    namNapalm = { fireballs, smoke, strike, flames };
  }
  return namNapalm;
}
const napZ = (side) => (ui.showGame && ui.showFP ? (side === "game" ? -NAP_ROW : NAP_ROW) : 0);
const NAP_SPLASHES = Math.min(5, Math.max(2, Math.round(NAPALM.length / (NAPALM.width * 0.85))));
const fpNap = { at: -1e9, z: 0, splashes: [] };
let napBooks = null, nextNapalm = 1;
try {
  const [splash, ground, column] = await Promise.all(["napalm", "napalmFire", "column"].map((k) => loadBookTextures(`/textures/fx/firepro/fp_${k}`)));
  napBooks = { splash, ground, column };
  const card = (b) => { const c = createBookCard(); c.setBook(b.tex, b.meta); c.mesh.visible = false; scene.add(c.mesh); return c; };
  for (let i = 0; i < NAP_SPLASHES; i++)
    fpNap.splashes.push({ imp: card(splash), ground: [card(ground), card(ground)], col: card(column), phase: Math.random() * 10 });
} catch { status.textContent += "napalm books not baked yet (v3/fire-bake-lab: Napalm splash / ground / Smoke column)\n"; }

function napalmRun() {
  if (ui.scene !== "napalm") return;
  if (ui.showGame) gameNapalm().strike.strike({ x: -NAPALM.length / 2, z: napZ("game"), dirX: 1, dirZ: 0 });
  fpNap.at = clock;
  fpNap.z = napZ("fp");
}
/** One book card: its bake box stands on the ground (the sim's y = 0 is the world's). */
function drawCard(c, meta, { age, size, x, z, fade, sunCol, sky }) {
  const k = size / meta.size;
  c.u.uFireK.value = ui.fpFire;
  c.u.uFade.value = fade;
  c.u.uTint.value.fromArray(meta.tint ?? [0.1, 0.1, 0.11]);
  c.update({ age, camera, size, sunDir: _dir, sunColor: sunCol, ambient: sky,
    center: _p.set(x + (meta.bake?.center?.[0] ?? 0) * k, (meta.bake?.center?.[1] ?? meta.size / 2) * k, z) });
}
const ease = THREE.MathUtils.smoothstep;
function fpNapalmFrame(sunCol, sky) {
  if (!napBooks) return;
  const show = ui.scene === "napalm" && ui.showFP;
  const { splash, ground, column } = napBooks;
  fpNap.splashes.forEach((sp, i) => {
    const f = NAP_SPLASHES > 1 ? i / (NAP_SPLASHES - 1) : 0;
    const t = clock - (fpNap.at + f * NAPALM.spreadTime);   // this splash's own clock
    const x = -NAPALM.length / 2 + f * NAPALM.length, burn = NAPALM.burnTime;
    const life = splash.meta.duration * ui.fpLife, a = t / life;
    sp.imp.mesh.visible = show && a >= 0 && a < 1;
    if (sp.imp.mesh.visible) drawCard(sp.imp, splash.meta, { age: a, size: ui.fpImpactCard, x, z: fpNap.z, fade: 1 - ease(a, 0.75, 1), sunCol, sky });
    // The ground catches as the splash rolls on; burns; dies down.
    const g = ease(t, 0.6, 1.8) * (1 - ease(t, burn, burn + 2.5));
    sp.ground.forEach((c, j) => {
      c.mesh.visible = show && g > 0.002;
      if (c.mesh.visible) drawCard(c, ground.meta, { age: (clock + sp.phase + j * 1.7) / ground.meta.duration, size: ui.fpGroundCard, x: x + (j ? 3 : -3), z: fpNap.z + (j ? 4 : -4), fade: g, sunCol, sky });
    });
    const cf = ease(t, 1.2, 4) * (1 - ease(t, burn + 1, burn + 6));
    sp.col.mesh.visible = show && cf > 0.002;
    if (sp.col.mesh.visible) drawCard(sp.col, column.meta, { age: (clock + sp.phase) / column.meta.duration, size: ui.fpColumnCard, x, z: fpNap.z, fade: cf * 0.9, sunCol, sky });
  });
}
function clearNapalm() {
  if (namNapalm) { namNapalm.strike.clear(); namNapalm.smoke.clear(); namNapalm.fireballs.clear(); namNapalm.flames.clear(); }
  fpNap.at = -1e9;
}
function setScene(name) {
  ui.scene = name;
  fire.clear();
  fx.lit?.clear();   // the game's lingering blast dust: it hung over the napalm rows
  clearNapalm();
  fpNap.at = -1e9;
  placeWrecks();
  if (name === "napalm") { ui.dist = 85; nextNapalm = clock + 0.5; }
  else { ui.dist = 52; nextAuto = clock + 0.5; }
  rtsView();
  refreshPanel();
}

// ── GPU cost ───────────────────────────────────────────────────────────────────
// Three runs over one blast cycle at the current view, wrecks burning: NOTHING (the
// ground and sky), GAME only, FIRE PRO only. Each effect's cost = its run − nothing.
// Average and peak (the peak is the blast filling the screen: overdraw).
let gpuSamples = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function runOnce(game, fp, seconds) {
  ui.showGame = game; ui.showFP = fp;
  placeWrecks();
  await sleep(1500);                       // warm: programs built, the fires up
  gpuSamples = [];
  if (ui.scene === "napalm") napalmRun(); else blast();
  await sleep(seconds * 1000);
  const s = gpuSamples; gpuSamples = null;
  s.sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / Math.max(1, s.length);
  return { mean, p95: s[Math.floor(s.length * 0.95)] ?? 0, n: s.length };
}
async function measureGpu() {
  const auto = ui.auto, gap = ui.gap, nap = ui.scene === "napalm";
  ui.auto = false;
  ui.gap = 0;                              // the measured side in the middle of the view, not at its edge
  status.textContent = `measuring… keep this window in front (≈ ${nap ? 90 : 40} s)`;
  await sleep((nap ? 20 : ui.every) * 1000);            // let the last blast clear
  const secs = nap ? 12 : 7;               // a napalm run: impact + the burn that follows
  const none = await runOnce(false, false, secs);
  const game = await runOnce(true, false, secs);
  await sleep(nap ? 20000 : 9000);                       // the game's dust lingers: clear it before Fire Pro
  const fp = await runOnce(false, true, secs);
  ui.gap = gap; ui.showGame = ui.showFP = true; placeWrecks(); ui.auto = auto; refreshPanel();
  const f = (r) => `+${(r.mean - none.mean).toFixed(2)} ms avg, +${(r.p95 - none.p95).toFixed(2)} ms p95`;
  status.textContent = `GPU (view ${ui.dist} m, ${secs} s from the ${nap ? "napalm run" : "blast, wrecks burning"})\n`
    + `nothing   ${none.mean.toFixed(2)} ms avg (${none.n} frames)\n`
    + `GAME      ${f(game)}\nFIRE PRO  ${f(fp)}${nap ? "" : `  [${FP_BOOKS[ui.fpBook]}]`}`;
  return { none, game, fp };
}

// ── loop ───────────────────────────────────────────────────────────────────────
const tags = ["GAME", "FIRE PRO"].map((text) => {
  const e = document.createElement("div");
  e.className = "tag"; e.textContent = text;
  document.body.append(e);
  return e;
});
const _dir = new THREE.Vector3(), _col = new THREE.Color(), _amb = new THREE.Color(), _p = new THREE.Vector3();
const timer = new THREE.Timer();
renderer.setAnimationLoop((now) => {
  timer.update(now);
  const dt = ui.paused ? 0 : Math.min(timer.getDelta(), 0.1);   // Pause freezes every effect's clock
  clock += dt;
  controls.update();

  const az = THREE.MathUtils.degToRad(ui.sunAz), el = THREE.MathUtils.degToRad(ui.sunEl);
  _dir.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));
  sun.position.copy(_dir).multiplyScalar(300);

  if (ui.scene === "blast" && ui.auto && clock >= nextAuto) { blast(); nextAuto = clock + ui.every; }
  fx.update(dt, camera);
  fire.update(dt, clock);
  if (ui.scene === "napalm" && ui.auto && clock >= nextNapalm) { napalmRun(); nextNapalm = clock + ui.napEvery; }
  if (namNapalm) {
    namNapalm.smoke.step(dt);
    namNapalm.strike.step(dt);
    namNapalm.smoke.render(clock, _dir);
    namNapalm.fireballs.render(clock);
    namNapalm.flames.update(dt, clock);
  }

  // The book cards answer the same light as lit smoke does: its sun gain (0.4, against
  // the card's built-in 0.65) and its sky when there is no hemisphere light (a pale
  // blue a tenth of the sun, × its sky gain 0.75).
  const sunCol = _col.copy(sun.color).multiplyScalar(sun.intensity * (0.4 / 0.65));
  const sky = _amb.setRGB(0.55, 0.62, 0.75).multiplyScalar(sun.intensity * 0.1 * 0.75);
  if (blastMeta) {
    const life = blastMeta.duration * ui.fpLife, age = (clock - blastAt) / life;
    blastCard.mesh.visible = ui.scene === "blast" && ui.showFP && age >= 0 && age < 1;
    const k = ui.fpBlastCard / blastMeta.size;
    blastCard.u.uFireK.value = ui.fpFire;
    blastCard.u.uFade.value = 1 - THREE.MathUtils.smoothstep(age, 0.8, 1);
    blastCard.u.uTint.value.fromArray(blastMeta.tint ?? [0.19, 0.19, 0.2]);
    blastCard.update({
      age, camera, size: ui.fpBlastCard, sunDir: _dir, sunColor: sunCol, ambient: sky,
      center: _p.set(ui.gap, blastMeta.bake?.center?.[1] != null ? blastMeta.bake.center[1] * k : ui.fpBlastCard / 2, BLAST_Z),
    });
  }
  if (wreckMeta) {
    wreckCard.mesh.visible = ui.scene === "blast" && ui.wreckOn && ui.showFP;
    const k = ui.fpWreckCard / wreckMeta.size;
    const cy = (wreckMeta.bake?.center?.[1] ?? wreckMeta.size / 2) - 0.3;   // the bake's emitter sat at y 0.3
    wreckCard.u.uFireK.value = ui.fpFire;
    wreckCard.u.uTint.value.fromArray(wreckMeta.tint ?? [0.1, 0.1, 0.11]);
    wreckCard.update({
      age: clock / wreckMeta.duration, camera, size: ui.fpWreckCard, sunDir: _dir, sunColor: sunCol, ambient: sky,
      center: _p.set(ui.gap, 1.3 + cy * k, WRECK_Z),
    });
  }

  fpNapalmFrame(sunCol, sky);
  renderer.render(scene, camera);
  renderer.resolveTimestampsAsync(THREE.TimestampQuery.RENDER);
  const gpu = renderer.info.render.timestamp;
  if (gpu > 0 && gpuSamples) gpuSamples.push(gpu);
  const nap = ui.scene === "napalm";
  [[nap ? -NAPALM.length / 2 - 6 : -ui.gap, nap ? napZ("game") : WRECK_Z + 4, tags[0], ui.showGame],
   [nap ? -NAPALM.length / 2 - 6 : ui.gap, nap ? napZ("fp") : WRECK_Z + 4, tags[1], ui.showFP]].forEach(([x, z, tag, on]) => {
    tag.style.display = on ? "" : "none";
    _p.set(x, 0, z).project(camera);
    tag.style.left = `${(_p.x * 0.5 + 0.5) * innerWidth}px`;
    tag.style.top = `${(-_p.y * 0.5 + 0.5) * innerHeight}px`;
  });
});

// ── panel ──────────────────────────────────────────────────────────────────────
// Only what applies to the scene on screen is shown (rows tagged with their scene); every
// choice button shows which one is on; one PLAY section drives either scene.
const ui_ = { sections: [], groups: [], checks: [] };
function section(title, sceneOnly = null) {
  const box = document.createElement("div");
  if (sceneOnly) box.dataset.scene = sceneOnly;
  const h = document.createElement("h3"); h.textContent = title;
  box.append(h);
  panel.append(box);
  ui_.sections.push(box);
  return box;
}
/** Buttons; `isOn(key)` marks the active one (a choice group), else plain actions. */
function buttons(box, list, isOn = null) {
  const row = document.createElement("div");
  row.className = "views";
  for (const [label, fn, key] of list) {
    const b = document.createElement("button");
    b.textContent = label;
    b.addEventListener("click", () => { b.blur(); fn(b); refreshPanel(); });
    if (isOn) ui_.groups.push(() => b.classList.toggle("on", isOn(key)));
    row.append(b);
  }
  box.append(row);
  return row;
}
function slider(box, label, key, min, max, step, onChange) {
  const row = document.createElement("label");
  row.className = "row";
  const name = document.createElement("span"); name.textContent = label;
  const input = Object.assign(document.createElement("input"), { type: "range", min, max, step, value: ui[key] });
  const out = document.createElement("output");
  const show = () => { out.textContent = (+ui[key]).toFixed(step < 1 ? 1 : 0); };
  input.addEventListener("input", () => { ui[key] = +input.value; show(); onChange?.(); });
  row.append(name, input, out);
  box.append(row);
  show();
  ui_.checks.push(() => { input.value = ui[key]; show(); });
}
function check(box, label, key, onChange) {
  const row = document.createElement("label");
  row.className = "row";
  const name = document.createElement("span"); name.textContent = label;
  const input = Object.assign(document.createElement("input"), { type: "checkbox", checked: ui[key] });
  input.addEventListener("change", () => { ui[key] = input.checked; onChange?.(); });
  row.append(name, input);
  box.append(row);
  ui_.checks.push(() => { input.checked = ui[key]; });
}
function note(box, text) { const e = document.createElement("p"); e.className = "src"; e.textContent = text; box.append(e); return e; }

const howEl = panel.querySelector(".src");
function setShow(game, fp) {
  ui.showGame = game; ui.showFP = fp;
  placeWrecks();
  // Napalm: the rows move (one side alone burns in the middle) — start a fresh run there.
  if (ui.scene === "napalm") { clearNapalm(); napalmRun(); nextNapalm = clock + ui.napEvery; }
}
function fireNow() {
  if (ui.scene === "blast") { blast(); nextAuto = clock + ui.every; }
  else { napalmRun(); nextNapalm = clock + ui.napEvery; }
}

let s_ = section("Scene");
buttons(s_, [["Shell & wreck", () => setScene("blast"), "blast"], ["Napalm", () => setScene("napalm"), "napalm"]], (k) => ui.scene === k);
s_ = section("Show");
buttons(s_, [["Both", () => setShow(true, true), "both"], ["Game only", () => setShow(true, false), "game"], ["Fire Pro only", () => setShow(false, true), "fp"]],
  (k) => (k === "both" ? ui.showGame && ui.showFP : k === "game" ? ui.showGame && !ui.showFP : !ui.showGame && ui.showFP));

s_ = section("Play");
const fireBtn = buttons(s_, [["Fire now", () => fireNow()], ["Pause", () => { ui.paused = !ui.paused; }, "pause"]], (k) => k === "pause" && ui.paused);
check(s_, "repeat", "auto");
s_ = section("Play", "blast"); s_.querySelector("h3").remove();
slider(s_, "every (s)", "every", 3, 15, 0.5);
s_ = section("Play", "napalm"); s_.querySelector("h3").remove();
slider(s_, "every (s)", "napEvery", 8, 40, 1);

s_ = section("Camera (RTS)");
buttons(s_, [["Near 18 m", () => { ui.dist = 18; rtsView(); }, 18], ["Play 52 m", () => { ui.dist = 52; rtsView(); }, 52], ["Far 85 m", () => { ui.dist = 85; rtsView(); }, 85]], (k) => ui.dist === k);
note(s_, "Drag to orbit, wheel to zoom; a button puts the RTS camera back.");

s_ = section("Shell blast — back row", "blast");
note(s_, "Fire Pro book:");
buttons(s_, Object.entries(FP_BOOKS).map(([key, label]) => [label, () => setBlastBook(key), key]), (k) => ui.fpBook === k);
slider(s_, "game blast (m)", "blastSize", 4, 16, 0.5);
slider(s_, "FP card (m)", "fpBlastCard", 4, 30, 0.5);
slider(s_, "FP play time ×", "fpLife", 0.5, 4, 0.1);
s_ = section("Burning wreck — front row", "blast");
check(s_, "burning", "wreckOn", placeWrecks);
slider(s_, "FP card (m)", "fpWreckCard", 2, 16, 0.25);
slider(s_, "gap between (m)", "gap", 4, 30, 0.5, placeWrecks);

s_ = section("Napalm run — Fire Pro cards", "napalm");
note(s_, "70 m, 4 splashes over 2.2 s, 14 s of burning (nam's numbers). Sizes take effect at once.");
slider(s_, "splash (m)", "fpImpactCard", 6, 40, 0.5);
slider(s_, "burning ground (m)", "fpGroundCard", 4, 30, 0.5);
slider(s_, "smoke column (m)", "fpColumnCard", 6, 50, 0.5);
slider(s_, "splash play time ×", "fpLife", 0.5, 4, 0.1);

s_ = section("Fire Pro flames");
slider(s_, "brightness ×", "fpFire", 0, 8, 0.1);
note(s_, "The game side keeps its own brightness. No bloom in this lab, on either side.");
s_ = section("Sun");
slider(s_, "azimuth (°)", "sunAz", -180, 180, 1);
slider(s_, "elevation (°)", "sunEl", 3, 89, 1);

s_ = section("GPU cost");
buttons(s_, [["Measure GPU", () => measureGpu()]]);
note(s_, "Each side alone, in the middle of the view, over one blast / one napalm run: its cost above an empty scene.");
s_.append(status);

function refreshPanel() {
  for (const box of ui_.sections) box.style.display = !box.dataset.scene || box.dataset.scene === ui.scene ? "" : "none";
  for (const f of ui_.groups) f();
  for (const f of ui_.checks) f();
  fireBtn.firstChild.textContent = ui.scene === "blast" ? "Blast now" : "Napalm run now";
  howEl.textContent = ui.scene === "blast"
    ? "LEFT: the game's own effects (shared-rts combatFx + lit smoke, flameField — what alg-rts plays). RIGHT: the Fire Pro books (v3/fire-bake-lab). Back row: a shell blast. Front row: a burning wreck."
    : "BACK ROW: nam's real napalm (napalmStrike: fireball flipbooks, flame cards, smoke palls). FRONT ROW: the same run drawn with the Fire Pro books. One side alone burns in the middle.";
}
refreshPanel();

window.__fxCompare = { ui, fx, fire, refreshPanel, fireNow, setShow, blastCard, wreckCard, blast, rtsView, renderer, camera, controls, measureGpu, setBlastBook, setScene, napalmRun, fpNap, get clock() { return clock; } };
placeWrecks();
rtsView();
