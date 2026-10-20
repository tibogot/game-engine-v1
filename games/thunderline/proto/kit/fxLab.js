// Thunderline FX LAB (fx-lab.html): every car effect on our car, in the drive page's world and light,
// through kit/carFx.js — the module the drive page uses too. Scenes replay the same moments (the test
// track's lap with its jumps, drift circles and launches on the floor, a rail scrape); a switch per
// effect; slow motion; camera views from outside the car; the time of day.
//   ?scene=lap|drift|launch|scrape|free · ?cam=chase|side|low|trackside · ?tod=<h>
import * as THREE from "three";
import { startV3App } from "../../../../v3/engine.js";
import { createDriveRig } from "./driveSession.js";
import { applyWorld, TIMES } from "./worlds.js";
import { createCarFx } from "./carFx.js";

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

// ---------- the engine: the drive page's own setup (drive.js) ----------
const app = await startV3App({
  container: $("game"),
  skyMode: "skypro",
  cloudShadows: true,
  light: { envIntensity: 0.45, hemiIntensity: 0.6, dirIntensity: 2.6, exposure: 1.0, shadowNormalBias: 0.12 },
  terrainFeatures: { cursor: false },
  splatFeatures: { solo: false, layerBudget: 3 }, // the ground uses paint slots 0-2 only (worlds.js): the shader loops over 3 layers, not 7
  preloadPaintTextures: false,
  csm: { cascades: 2 },
});
app.sky?.setMode?.("skypro");
let tod = Number(params.get("tod")) || 15.5;
app.sky?.setTimeOfDay?.(tod);
app.fog?.setHeight?.({ enabled: false });
app.postFx?.setEnabled?.(true);
app.postFx?.setBloomSelective?.(true);
app.postFx?.setBloom?.({ enabled: true, strength: 0.9, threshold: 0.0, radius: 0.5 });
const { camera, controls } = app;
controls.update = () => {};
controls.enableRotate = controls.enablePan = controls.enableZoom = false;
camera.far = Math.max(camera.far, 9000);
camera.updateProjectionMatrix();
applyWorld(app, "flat");

const rig = createDriveRig(app, { ghost: false, sunShadows: true });
const vehicle = rig.vehicle;
const fx = createCarFx(app, rig);

// ---------- scenes ----------
const V = THREE.Vector3;
const clamp = THREE.MathUtils.clamp;
let floorFrom = null; // a matrix on the open floor beside the test track (drift circles, launches)
let sceneT = 0, scene = null, finishedAt = null;
const SCENES = {
  lap: { label: "Lap", note: "The autopilot drives the test track: jumps, landings, turns. It loops." },
  drift: { label: "Drift circles", note: "Full throttle, half lock, the handbrake pulled every 2 s, on the floor." },
  launch: { label: "Launch + brake", note: "Standing start flat out for 3 s, then the brakes for 2 s: the exhaust's bark and the tyres." },
  scrape: { label: "Rail scrape", note: "The autopilot, steered into the right-hand rail: sparks." },
  free: { label: "Drive yourself", note: "W A S D / arrows, Space handbrake (the panel keeps the keys while the mouse is over it)." },
};
const DRIVERS = {
  drift: () => ({ steerTarget: 0.55, rollTarget: 0, throttle: 1, handbrake: sceneT % 2 < 0.45, yaw: 0, pitch: 0, analog: false }),
  launch: () => { const k = sceneT % 5; return { steerTarget: 0, rollTarget: 0, throttle: k < 3 ? 1 : -1, handbrake: false, yaw: 0, pitch: 0, analog: false }; },
  scrape: (v, S) => { const i = S.pilot.input(v); return { ...i, steerTarget: clamp((i.steerTarget ?? 0) - 0.9, -1, 1) }; },
};
async function setScene(name) {
  scene = name;
  sceneT = 0;
  finishedAt = null;
  const onFloor = name === "drift" || name === "launch";
  await rig.start({ from: onFloor ? floorFrom : null, killY: onFloor ? -100 : undefined, help: "FX lab · the panel on the right" });
  rig.setAuto(name === "lap" || name === "scrape");
  rig.setInputSource(DRIVERS[name] ?? null); // lap / scrape: the autopilot; free: the keys
  fx.reset();
  trackside = null;
  renderButtons();
}

// ---------- cameras (the chase camera, or views from outside the car) ----------
let cam = params.get("cam") ?? "chase";
let trackside = null;
const CAMS = { chase: "Chase", side: "Side", low: "Low rear", trackside: "Trackside" };
const _p = new V(), _f = new V(), _r = new V(), _u = new V(0, 1, 0);
function placeCamera() {
  if (cam === "chase") return; // the rig's chase camera already placed it
  const pos = vehicle.renderPos ?? vehicle.body.pos;
  _f.set(0, 0, 1).applyQuaternion(vehicle.body.quat).setY(0).normalize();
  _r.crossVectors(_f, _u).normalize(); // car's right
  if (cam === "side") _p.copy(pos).addScaledVector(_r, 9).addScaledVector(_f, 1.5).add(new V(0, 1.6, 0));
  else if (cam === "low") _p.copy(pos).addScaledVector(_f, -7.5).add(new V(0, 0.7, 0));
  else {
    // a fixed spot beside the road ahead; a new one when the car is far past it
    if (!trackside || trackside.distanceTo(pos) > 110) trackside = pos.clone().addScaledVector(_f, 30).addScaledVector(_r, 14).add(new V(0, 2.5, 0));
    _p.copy(trackside);
  }
  camera.position.copy(_p);
  camera.lookAt(pos.x, pos.y + 0.5, pos.z);
}

// ---------- the panel ----------
const SPEEDS = [["1", "1×"], ["0.5", "½×"], ["0.25", "¼×"], ["0", "Pause"]]; // arrays: numeric keys would sort first
const TODS = TIMES.map(([h, n]) => [String(h), n]); // the tracks' own times (worlds.js)
const EFFECTS = { smoke: "Tyre smoke", exhaust: "Exhaust", sparks: "Sparks", marks: "Tyre marks" };
function buttons(el, items, isOn, onPick) {
  el.innerHTML = "";
  for (const [k, label] of Array.isArray(items) ? items : Object.entries(items)) {
    const b = document.createElement("button");
    b.textContent = label;
    b.classList.toggle("on", isOn(k));
    b.onclick = () => { b.blur(); onPick(k); renderButtons(); };
    el.appendChild(b);
  }
}
function renderButtons() {
  buttons($("scenes"), Object.fromEntries(Object.entries(SCENES).map(([k, s]) => [k, s.label])), (k) => k === scene, (k) => setScene(k));
  $("note").textContent = SCENES[scene]?.note ?? "";
  buttons($("cams"), CAMS, (k) => k === cam, (k) => { cam = k; trackside = null; });
  buttons($("speeds"), SPEEDS, (k) => Number(k) === rig.timeScale, (k) => rig.setTimeScale(Number(k)));
  buttons($("looks"), { flipbook: "Wispy flipbook", procedural: "Procedural" }, (k) => k === fx.look, (k) => fx.setLook(k));
  buttons($("tods"), TODS, (k) => Number(k) === tod, (k) => { tod = Number(k); app.sky?.setTimeOfDay?.(tod); rig.rebakeSunShadows(); }); // the baked shadows follow the sun
  const box = $("fxs");
  box.innerHTML = "";
  for (const [k, label] of Object.entries(EFFECTS)) {
    const row = document.createElement("div");
    row.className = "fx";
    row.innerHTML = `<label><input type="checkbox" ${fx.on[k] ? "checked" : ""}> ${label}</label>`;
    row.querySelector("input").onchange = (e) => { fx.set(k, e.target.checked); e.target.blur(); };
    box.appendChild(row);
  }
}

// ---------- start ----------
await rig.start({ help: "FX lab · the panel on the right" });
{
  // the floor spot: 120 m beside the test track's widest point, at the floor's height, facing −Z
  let minX = Infinity, sz = 0;
  for (const r of rig.session.lay.ride) { minX = Math.min(minX, r.P.x); sz += r.P.z; }
  const x = minX - 120, z = sz / rig.session.lay.ride.length;
  floorFrom = new THREE.Matrix4().makeTranslation(x, app.getWorldHeight(x, z), z);
}
await rig.modelsReady;
// THE EXHAUST ON OUR CAR: the pipes just behind the tail, measured from the car's own model (the
// defaults are the Lotus's)
{
  // in the BODY's frame (the pipes are placed from body.pos / body.quat; the vehicle's group stays at the origin)
  vehicle.group.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().compose(vehicle.renderPos ?? vehicle.body.pos, vehicle.body.quat, new V(1, 1, 1)).invert();
  const box = new THREE.Box3(), b = new THREE.Box3();
  (vehicle._chassisGlb ?? vehicle.group).traverse((o) => {
    if (!o.isMesh || o.isInstancedMesh || !o.visible || !o.geometry || o.material?.name === "ShadowProxy") return;
    o.geometry.computeBoundingBox();
    b.copy(o.geometry.boundingBox).applyMatrix4(inv.clone().multiply(o.matrixWorld));
    // only the car's own parts (the group also holds helpers drawn in world space)
    if (b.min.length() < 6 && b.max.length() < 6) box.union(b);
  });
  const ex = fx.smokeSettings.exhaust;
  if (ex && Number.isFinite(box.min.z)) {
    ex.pipeBack = +(-box.min.z + 0.12).toFixed(2);
    ex.pipeUp = +(box.min.y + 0.22).toFixed(2);
    ex.pipeSide = +(0.1 * (box.max.x - box.min.x)).toFixed(2); // our car: twin tips near the middle
  }
  window.__carBox = { min: box.min.toArray().map((v) => +v.toFixed(2)), max: box.max.toArray().map((v) => +v.toFixed(2)), exhaust: ex && { pipeBack: ex.pipeBack, pipeUp: ex.pipeUp, pipeSide: ex.pipeSide } };
}
await setScene(SCENES[params.get("scene")] ? params.get("scene") : "lap");
const startCam = params.get("cam");
if (CAMS[startCam]) cam = startCam;
renderButtons();
$("boot").classList.add("gone");
setTimeout(() => $("boot").remove(), 600);

// ---------- the frame: after the rig's (the car and the chase camera are where this frame draws them) ----------
let last = performance.now(), frame = 0;
app.addPreUpdateHook(function fxLabFrame() {
  const now = performance.now();
  const dt = Math.min((now - last) / 1000, 0.05) * rig.timeScale;
  last = now;
  if (!rig.active) return;
  sceneT += dt;
  // the lap loops: a moment after the finish, again from the start
  if (scene === "lap" || scene === "scrape") {
    const st = rig.session.race.s.state;
    if (st === "finished" && finishedAt == null) finishedAt = sceneT;
    if (finishedAt != null && sceneT - finishedAt > 2) { finishedAt = null; rig.restart(); fx.reset(); }
  }
  placeCamera();
  fx.update(dt);
  if (++frame % 10 === 0) {
    const s = fx.stats();
    const kmh = Math.round(vehicle.body.vel.length() * 3.6);
    $("read").textContent = `speed    ${kmh} km/h\nwheels   ${vehicle.groundedCount}/4 down\npuffs    ${s.puffs}\nsparks   ${s.sparks}\nscraping ${vehicle.scraping ? "yes" : "no"}`;
  }
});

window.__fx = { app, rig, fx, setScene, setCam: (k) => { cam = k; trackside = null; renderButtons(); }, get scene() { return scene; } };
