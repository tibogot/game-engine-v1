// TURNIN' TURBO DASHBOARD (Tomy, 1983) — a tabletop driving toy, rebuilt in three.js / WebGPU.
//
// Step 1 (PLAN.md): the whole toy PLAYS, on a grey-box body. Turn the key, put it in gear,
// keep the red car on the road; the TRIP counter is the score, it stops for 3 s when you
// leave the road (the screen flashes), the fuel runs out. Units: metres (the toy is ~42 cm wide).
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { createCarSprite, createScreen, curve, depthAt, roadAtCar, rowAt, scaleAt, screenX, ROAD } from "./road.js";
import { oakMaterial, plastic, roomEnvironment } from "./looks.js";
import { createCluster, createHubBadge, createShifterPlate, createStripPrint, createTopSticker, SHIFTER_ROWS } from "./instruments.js";

// --- tuning (guesses: the real values are unknown, PLAN.md) --------------------------------
const GEAR_SPEED = [0, 1.2, 2.0, 2.8, 3.8];   // film scroll, road units / s
const GEAR_MPH = [0, 40, 80, 120, 180];
const SPIN_UP = 0.7;                          // motor time constant, s
const SCORE_PER_UNIT = 0.28;                  // TRIP points per road unit
const FUEL_IDLE = 0.25, FUEL_PER_UNIT = 0.28; // % per s, % per road unit (100 % = full)
const PENALTY = 3, FLASH = 0.35;              // off road: counter stop, screen flash (s)
const STEER_MAX = 2.0;                        // wheel lock, rad (± 115°)
const STEER_KEY_RATE = 3.2;                   // rad / s with the keys

const app = document.getElementById("app");
const msg = document.getElementById("msg");
if (!navigator.gpu) { msg.textContent = "WebGPU is not available."; msg.style.display = "block"; }

const renderer = new THREE.WebGPURenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
app.append(renderer.domElement);
await renderer.init();

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xcfc8bd);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(roomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.55;

const camera = new THREE.PerspectiveCamera(32, innerWidth / innerHeight, 0.02, 20);
const VIEWS = [
  // the front photo's own camera (fitted to it: assets-src/refs/turnin-turbo/front.png, ?ref to compare)
  { name: "photo", pos: [0.0119, 0.99, 1.0853], target: [0.012, 0.2149, 0.1692], fov: 14.06 },
  { name: "driver", pos: [-0.09, 0.27, 0.42], target: [0.02, 0.14, 0.0] },
  { name: "three-quarter", pos: [0.55, 0.42, 0.5], target: [0.0, 0.1, -0.06] },
  { name: "back", pos: [-0.35, 0.35, -0.75], target: [0.0, 0.1, -0.12] },
];
let viewIndex = 0;
const controls = new OrbitControls(camera, renderer.domElement);
controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
controls.enableDamping = true;
controls.minDistance = 0.25;
controls.maxDistance = 3;
controls.maxPolarAngle = Math.PI * 0.48;
function setView(i) {
  const v = VIEWS[i];
  camera.position.set(...v.pos);
  camera.fov = v.fov ?? 32;
  camera.updateProjectionMatrix();
  controls.target.set(...v.target);
  controls.update();
}
setView(0);

const sun = new THREE.DirectionalLight(0xfff3e2, 2.2);
sun.position.set(-0.6, 1.4, 0.9);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -0.5, right: 0.5, top: 0.5, bottom: -0.5, near: 0.5, far: 3 });
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.002;
scene.add(sun, new THREE.HemisphereLight(0xfffaf0, 0x8a6a48, 0.6));

// --- the table ---------------------------------------------------------------------------------
const table = new THREE.Mesh(new THREE.PlaneGeometry(3, 3).rotateX(-Math.PI / 2), oakMaterial());
table.receiveShadow = true;
scene.add(table);

// --- the toy: the Blender shell (tools/blender/turninTurbo.py), materials given here by part name -----
const toy = (await new GLTFLoader().loadAsync("/models/turnin-turbo/turbo.glb")).scene;
scene.add(toy);
const MATS = {
  Red: plastic(0xd8261c, 0.26, { clearcoat: 0.3, breakup: 0.1 }),
  Slate: plastic(0x26303b, 0.74, { breakup: 0.08, scale: 30 }),
  Black: plastic(0x0a0a0b, 0.38, { breakup: 0.14 }),
  Grey: plastic(0xb4b6b8, 0.45, { breakup: 0.08 }),
  Chrome: new THREE.MeshPhysicalMaterial({ color: 0xb9bcbf, metalness: 1, roughness: 0.22 }),
};
const LEVER_GREY = plastic(0x8e9194, 0.42, { breakup: 0.08 });
const WHEEL_BLACK = plastic(0x070708, 0.16, { clearcoat: 0.8, breakup: 0.06 });   // the wheel: glossy
// the clear covers: a faint sheen only (a full room reflection greyed the panel out)
const glass = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.12, transparent: true, opacity: 0.02, depthWrite: false, envMapIntensity: 0.12, specularIntensity: 0.3 });
const cluster = await createCluster();
const screen = createScreen();
const FACES = {
  ClusterFace: new THREE.MeshStandardMaterial({ map: cluster.texture, roughness: 0.95 }),
  ClusterGlass: glass,
  ScreenGlass: glass,
  ScreenFilm: screen.material,
  ShifterLabel: new THREE.MeshStandardMaterial({ map: createShifterPlate(), roughness: 0.5 }),
  HubBadge: new THREE.MeshPhysicalMaterial({ map: createHubBadge(), roughness: 0.2, clearcoat: 0.8, transparent: true, alphaTest: 0.5 }),
  TopSticker: new THREE.MeshStandardMaterial({ map: createTopSticker(), roughness: 0.4 }),
  StripPrint: new THREE.MeshStandardMaterial({ map: createStripPrint(), roughness: 0.6, transparent: true, depthWrite: false }),
};
// the glTF's UVs run top-down (glTF flips V on export): the canvases must not be flipped again
for (const m of Object.values(FACES)) if (m.map) { m.map.flipY = false; m.map.needsUpdate = true; }
const PICK = { Wheel: "wheel", HubBadge: "wheel", Lever: "lever", KeyHead: "key", KeyLock: "key", ResetButton: "reset" };
toy.traverse((o) => {
  if (!o.isMesh) return;
  const face = FACES[o.name];
  o.material = face ?? (o.name === "Wheel" ? WHEEL_BLACK : o.name === "Lever" ? LEVER_GREY : MATS[o.material.name]) ?? o.material;
  o.castShadow = !face;
  o.receiveShadow = !face || o.name === "ClusterFace";
  if (face === glass) o.renderOrder = 2;
  if (o.name === "ClusterGlass") o.visible = false;
  for (let p = o; p; p = p.parent) if (PICK[p.name]) { o.userData.pick = PICK[p.name]; break; }
});
const node = (name) => toy.getObjectByName(name);
const wheel = node("Wheel"), lever = node("Lever"), keyHead = node("KeyHead"), resetButton = node("ResetButton");
const base = (o) => ({ q: o.quaternion.clone(), p: o.position.clone() });
const wheelBase = base(wheel), keyBase = base(keyHead), leverBase = base(lever), resetBase = base(resetButton);
// the gate: the lever stops level with the label's rows (the label plane sits 2 mm towards the front of the slot's origin)
const labelSize = new THREE.Box3().setFromBufferAttribute(node("ShifterLabel").geometry.attributes.position).getSize(new THREE.Vector3());
const labelLen = Math.max(labelSize.x, labelSize.y, labelSize.z);
const LEVER_Y = [0, 1, 2, 3, 4].map((g) => (0.5 - SHIFTER_ROWS[g] / 1024) * labelLen - 0.009);   // the grip sits ahead of its gate row (photo)   // N (nearest the player) .. 4
const leverAxis = new THREE.Vector3(0, 1, 0).applyQuaternion(leverBase.q);
const resetAxis = new THREE.Vector3(0, 0, 1).applyQuaternion(resetBase.q);
const zAxis = new THREE.Vector3(0, 0, 1), xAxis = new THREE.Vector3(1, 0, 0), spin = new THREE.Quaternion();
const LEVER_PIVOT_Y = -0.019, LEVER_TILT = 0.45;   // turninTurbo.py: the drum's place along the slot; +-26 deg

// the player's car: a sticker on clear plastic, just in front of the film
const film = node("ScreenFilm");
const filmSize = new THREE.Box3().setFromBufferAttribute(film.geometry.attributes.position).getSize(new THREE.Vector3());
const SCREEN = { w: filmSize.x, h: Math.max(filmSize.y, filmSize.z), z: 0.0042 };
// the same painting as the film's yellow car, in red, soft and a little see-through (photo)
const CAR_W = ROAD.CAR_W * SCREEN.w;
const carSticker = new THREE.Mesh(new THREE.PlaneGeometry(CAR_W, CAR_W), new THREE.MeshBasicMaterial({
  map: createCarSprite("#f07868", "#d4594c", "#ffa494", 8), transparent: true, opacity: 0.92, depthWrite: false, toneMapped: false }));
carSticker.position.z = SCREEN.z;
film.add(carSticker);

// --- game state ------------------------------------------------------------------------------
const st = {
  on: false, gear: 0, steer: 0,
  speed: 0, scroll: 0,
  trip: 0, fuel: 100,
  penalty: 0, flash: 0, check: 0,
  offRoad: false, offRoads: 0,
  turboT: 0,
  rival: { at: 8, lane: 0 },
};

function setKey(on) {
  st.on = on;
  if (on) { st.fuel = 100; st.check = 1.5; }
  keyHead.quaternion.copy(keyBase.q).multiply(spin.setFromAxisAngle(zAxis, on ? -0.8 : 0));
}
function setGear(g) {
  st.gear = THREE.MathUtils.clamp(g, 0, 4);
  // the lever turns on its drum (origin = the drum axis): tilt so the grip sits over the gear's row
  const a = ((st.gear - 2) / 2) * LEVER_TILT;   // N leans to the player, 4 to the back
  lever.quaternion.copy(leverBase.q).multiply(spin.setFromAxisAngle(xAxis, -a));
}
function resetCounter() {
  st.trip = 0;
  resetButton.position.copy(resetBase.p).addScaledVector(resetAxis, -0.004);
  setTimeout(() => resetButton.position.copy(resetBase.p), 150);
}

function carScreenX() {
  return 0.5 + (st.steer / STEER_MAX) * 0.36;
}

function update(dt) {
  const running = st.on && st.fuel > 0;
  const target = running ? GEAR_SPEED[st.gear] : 0;
  st.speed += (target - st.speed) * (1 - Math.exp(-dt / SPIN_UP));
  if (st.speed < 0.002 && target === 0) st.speed = 0;
  const ds = st.speed * dt;
  st.scroll += ds;

  if (st.on) st.fuel = Math.max(0, st.fuel - (running ? FUEL_IDLE * dt + FUEL_PER_UNIT * ds : 0));

  // the car against the road at its row
  const road = roadAtCar(st.scroll);
  const off = Math.abs(carScreenX() - road.x) > road.half * 0.92;
  if (off && !st.offRoad && st.speed > 0.1) {
    st.penalty = PENALTY; st.flash = FLASH; st.offRoads++;
  }
  st.offRoad = off;
  st.penalty = Math.max(0, st.penalty - dt);
  st.flash = Math.max(0, st.flash - dt);
  st.check = Math.max(0, st.check - dt);
  if (st.penalty === 0) st.trip = (st.trip + ds * SCORE_PER_UNIT) % 100;

  // the yellow car: drives on slower than you, comes down the screen, reappears ahead
  st.rival.at += ds * 0.5;
  if (st.rival.at - st.scroll < -1.2) {
    st.rival.at = st.scroll + 14 + Math.random() * 6;
    st.rival.lane = [-1, 0, 1][Math.floor(Math.random() * 3)] * (2 / 3) * ROAD.W;
  }
  const rd = st.rival.at - st.scroll;
  const rv = rowAt(rd);
  screen.uRival.value.set(screenX(curve(st.rival.at) + st.rival.lane, rv, st.scroll), rv, ROAD.CAR_W * 1.3 * scaleAt(rv), rv < 1.05 ? 1 : 0);   // (photo: the car ahead is drawn big)

  st.turboT = st.gear === 4 && running ? Math.min(st.turboT + dt, 2.5) : Math.max(st.turboT - dt * 3, 0);
}

function present() {
  // screen
  screen.uS.value = st.scroll;
  screen.uOn.value += ((st.on ? (st.fuel > 0 ? 1 : 0.35) : 0) - screen.uOn.value) * 0.2;
  screen.uFlash.value = st.flash > 0 ? Math.sin((st.flash / FLASH) * Math.PI) : 0;   // the bulb dips once (was a white strobe)
  const cx = carScreenX();
  carSticker.position.x = (cx - 0.5) * SCREEN.w;
  carSticker.position.y = -SCREEN.h / 2 + ROAD.CAR_V * SCREEN.h + CAR_W * 0.35;
  carSticker.visible = screen.uOn.value > 0.05;

  // controls
  wheel.quaternion.copy(wheelBase.q).multiply(spin.setFromAxisAngle(zAxis, -st.steer));

  // the cluster's flaps
  const running = st.on && st.fuel > 0;
  const rev = st.speed / GEAR_SPEED[4];
  cluster.update({
    tacho: st.on ? (running ? Math.min(8, 1 + Math.round(rev * 7)) : 0) : 0,   // flaps: they move with the revs, never flicker
    fuelBars: st.on ? Math.ceil(st.fuel / 20) : 0,
    turbo: Math.min(5, Math.floor(st.turboT * 2)),
    speed: st.on ? Math.round((st.speed / GEAR_SPEED[4]) * GEAR_MPH[4] / 10) * 10 : 0,
    trip: Math.floor(st.trip),
    on: st.on,
  });
}

// --- input: drag the wheel and the lever, click the key and the button ------------------------
const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let drag = null;
function pick(e) {
  const r = renderer.domElement.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const hit = ray.intersectObject(toy, true).find((h) => h.object.userData.pick);
  return hit?.object.userData.pick;
}
function projectToScreen(obj, local = new THREE.Vector3()) {
  const p = obj.localToWorld(local.clone()).project(camera);
  const r = renderer.domElement.getBoundingClientRect();
  return { x: r.left + (p.x * 0.5 + 0.5) * r.width, y: r.top + (-p.y * 0.5 + 0.5) * r.height };
}
renderer.domElement.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  const what = pick(e);
  if (what === "key") setKey(!st.on);
  else if (what === "reset") resetCounter();
  else if (what === "wheel") {
    const c = projectToScreen(wheel);
    drag = { what, c, a: Math.atan2(e.clientY - c.y, e.clientX - c.x) };
  } else if (what === "lever") {
    // the slot's ends on screen: drag along that line, snap to the nearest gear
    const up = new THREE.Vector3(0, 0, 1).applyQuaternion(leverBase.q);
    const at = (y) => projectToScreen(toy, leverBase.p.clone().addScaledVector(leverAxis, y - LEVER_PIVOT_Y).addScaledVector(up, 0.04));
    const n = at(LEVER_Y[0]), f = at(LEVER_Y[4]);
    drag = { what, n, f };
  }
  if (drag) renderer.domElement.setPointerCapture(e.pointerId);
});
renderer.domElement.addEventListener("pointermove", (e) => {
  if (!drag) {
    renderer.domElement.style.cursor = pick(e) ? "pointer" : "";
    return;
  }
  if (drag.what === "wheel") {
    const a = Math.atan2(e.clientY - drag.c.y, e.clientX - drag.c.x);
    let da = a - drag.a;
    if (da > Math.PI) da -= Math.PI * 2;
    if (da < -Math.PI) da += Math.PI * 2;
    drag.a = a;
    st.steer = THREE.MathUtils.clamp(st.steer + da, -STEER_MAX, STEER_MAX);
  } else if (drag.what === "lever") {
    const vx = drag.f.x - drag.n.x, vy = drag.f.y - drag.n.y;
    const t = ((e.clientX - drag.n.x) * vx + (e.clientY - drag.n.y) * vy) / (vx * vx + vy * vy);
    setGear(Math.round(THREE.MathUtils.clamp(t, 0, 1) * 4));
  }
});
const endDrag = () => { drag = null; };
renderer.domElement.addEventListener("pointerup", endDrag);
renderer.domElement.addEventListener("pointercancel", endDrag);

const held = new Set();
addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  held.add(k);
  if (e.repeat) return;
  if (k === " ") { setKey(!st.on); e.preventDefault(); }
  else if (k === "r") resetCounter();
  else if (k === "c") { viewIndex = (viewIndex + 1) % VIEWS.length; setView(viewIndex); }
  else if (["arrowup", "z", "w"].includes(k)) { setGear(st.gear + 1); e.preventDefault(); }
  else if (["arrowdown", "s"].includes(k)) { setGear(st.gear - 1); e.preventDefault(); }
  else if (/^[0-4]$/.test(k)) setGear(Number(k));
});
addEventListener("keyup", (e) => held.delete(e.key.toLowerCase()));
addEventListener("blur", () => held.clear());
function keySteer(dt) {
  const left = held.has("arrowleft") || held.has("q") || held.has("a");
  const right = held.has("arrowright") || held.has("d");
  if (left !== right) st.steer = THREE.MathUtils.clamp(st.steer + (right ? 1 : -1) * STEER_KEY_RATE * dt, -STEER_MAX, STEER_MAX);
}

// ?ref: the front photo over the view, the canvas at the photo's aspect (O cycles the photo's opacity) — to
// match the model to the real toy. __turbo.fitCamera() fits the camera to points measured on the photo.
const REF = new URLSearchParams(location.search).has("ref");
const REF_W = 1600, REF_H = 1192;
let refImg = null, refOpacity = 0.5;
if (REF) {
  refImg = Object.assign(document.createElement("img"), { src: "/assets-src/refs/turnin-turbo/front.png" });
  Object.assign(refImg.style, { position: "absolute", pointerEvents: "none", opacity: refOpacity });
  document.body.append(refImg);
  document.getElementById("help").style.display = "none";
}
function layout() {
  let w = innerWidth, h = innerHeight;
  if (REF) {
    const k = Math.min(w / REF_W, h / REF_H);
    w = Math.round(REF_W * k); h = Math.round(REF_H * k);
    const left = (innerWidth - w) / 2, top = (innerHeight - h) / 2;
    Object.assign(renderer.domElement.style, { left: left + "px", top: top + "px", width: w + "px", height: h + "px" });
    Object.assign(refImg.style, { left: left + "px", top: top + "px", width: w + "px", height: h + "px" });
  }
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}
addEventListener("resize", layout);
layout();
addEventListener("keydown", (e) => {
  if (!REF || e.key.toLowerCase() !== "o") return;
  refOpacity = refOpacity >= 1 ? 0 : refOpacity + 0.25;
  refImg.style.opacity = refOpacity;
});

// --- loop ---------------------------------------------------------------------------------------
let lastT = performance.now();
renderer.setAnimationLoop(() => {
  const now = performance.now();
  const dt = Math.min((now - lastT) / 1000, 0.05);
  lastT = now;
  keySteer(dt);
  update(dt);
  present();
  controls.update();
  renderer.render(scene, camera);
});

setGear(0);

// for tests and tuning from the console
window.__turbo = { THREE, controls, st, setKey, setGear, resetCounter, setView, camera, renderer, scene, roadAtCar, carScreenX, depthAt };
