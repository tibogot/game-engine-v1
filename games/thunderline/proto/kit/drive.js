// Thunderline P3 — drive the REAL car (the old physics, copied by import, untouched) on the NEW
// pieces (kit.js paths drawn with the old look), under Sky Pro, with the old chase camera.
// The wiring follows roadGame.js (boot :291, collision bake :4876-5030, readControls :7663, sim loop
// :9904-10040), minus everything a sky track doesn't need. Throwaway: it answers DESIGN.md §9 P3.
import * as THREE from "three";
import { startV3App } from "../../../../v3/engine.js";
import { Vehicle, FIXED_DT, STUCK, TIRE, AERO, CHASSIS } from "../../../../v3/play/modularRoadVehicle.js";
import { RoadBvh } from "../../../../v3/play/modularRoadBvh.js";
import { createVehicleGround } from "../../../../v3/play/modularRoadGround.js";
import { createChaseCamera, CHASE_CAM } from "../../../modular-road-v3/chaseCamera.js";
import { createGamepadInput } from "../../../modular-road-v3/gamepadInput.js";
import { loadChassisModel, CHASSIS_GLB_URL, chassisGlbMounts } from "../../../modular-road-v3/chassisModel.js";
import { loadWheelModel } from "../../../modular-road-v3/wheelModel.js";
import { TILES, integrate } from "./kit.js";
import { buildOldLook, createOldLookMaterials } from "./oldLook.js";
import { layoutTestTrack, layoutFromPlacements, buildTrackMeshes } from "./testTrack.js";
import { createSunShadows, STATIC_LAYER, DYNAMIC_LAYER } from "./sunShadows.js";

const $ = (id) => document.getElementById(id);
const V = THREE.Vector3;
const params = new URLSearchParams(location.search);
const boot = $("boot");

// Road hold (the old car's crest/bank follower) goes on pieces the car should FOLLOW, never on
// launchers or landings (old rule, FOLLOW_ROAD in modularRoadKit.js:5911).
const ROAD_HOLD = new Set(["bank_in_22", "bank_out_22", "fast_turn_128"]);
const SPAWN_LIFT = 0.6;
const MAX_SIM_TICKS = 8;

// ---------- engine: Sky Pro, no terrain ----------
boot.textContent = "Thunderline · starting the engine…";
const app = await startV3App({
  container: $("game"),
  skyMode: "skypro",
  cloudShadows: true,
  // The old game's light block (roadGame.js:296-306). shadowNormalBias 0.12 is the one that matters:
  // at the editor's 0.02 the road shadows ITSELF at a chase-camera grazing angle — the dark band
  // across the deck the user saw (2026-10-18).
  light: { envIntensity: 0.45, hemiIntensity: 0.6, dirIntensity: 2.6, exposure: 1.0, shadowNormalBias: 0.12 },
  terrainFeatures: { cursor: false },
  splatFeatures: { solo: false },
  preloadPaintTextures: false,
  csm: { cascades: 2 },
});
// No level: the engine's DEFAULT floor stays as the backdrop (user, 2026-10-18 — terrain comes later,
// as decoration). The track floats above it; the car never drives on it (getTerrainHeight → NaN) and
// a fall resets long before the ground.
app.sky?.setMode?.("skypro");
const tod = Number(params.get("tod"));
app.sky?.setTimeOfDay?.(params.has("tod") && Number.isFinite(tod) ? tod : 15.5);
app.fog?.setHeight?.({ enabled: false });
app.fog?.setDistance?.({ enabled: false });
app.postFx?.setEnabled?.(true);
app.postFx?.setBloomSelective?.(true);
app.postFx?.setBloom?.({ enabled: true, strength: 0.9, threshold: 0.0, radius: 0.5 });
const { scene, camera, controls, renderer } = app;
// the chase camera owns the camera: neuter the engine's orbit (roadGame.js:6428)
controls.update = () => {};
controls.enableRotate = controls.enablePan = controls.enableZoom = false;
camera.far = Math.max(camera.far, 9000);
camera.updateProjectionMatrix();

// ---------- the track: new paths, old look ----------
boot.textContent = "Thunderline · building the track…";
const mats = createOldLookMaterials();
const built = {};
for (const [id, t] of Object.entries(TILES)) built[id] = { b: integrate(t), guarded: buildOldLook(t, true), open: buildOldLook(t, false) };
// ---------- SPEED (P3 step 2): one design speed drives every number that used to copy it ----------
// Set here, at load, on this page only — the old car's code is untouched (TIRE is a module object,
// SUBSTEPS a per-car field). ?top=<m/s> (terminal ≈ 0.96 × top), ?substeps=<n>.
const TOP = Number(params.get("top")) || 63;
const SUBSTEPS = Number(params.get("substeps")) || 3;
TIRE.topSpeed = TOP;
TIRE.steerSpeedRef = TOP * 0.9; // "full reduction should land AT top speed" (old: 45 for 50)
CHASE_CAM.fovSpeedRef = TOP; // "keep matching TIRE.topSpeed"
// Flights are placed for the speed the car REALLY has at the kicker lip: 0.91 × top measured on this
// run-up at top 50 (164 km/h). ?jump=<m/s> overrides.
const JUMP_SPEED = Number(params.get("jump")) || TOP * 0.91;
// ?jumps=a,b,c = measured take-off speed (m/s) of each flight; defaults measured with the autopilot at
// top 63 / 3 substeps (jump 1: 201 km/h, jump 2: 175 km/h after the brake turn, jump 3: 182 km/h)
const JUMPS = (params.get("jumps") ?? "55.8,48.6,50.6").split(",").map(Number).filter((v) => v > 0);
// ?track=local → the track saved by the builder (builder3.html), otherwise the test track
let builtTrack = null;
if (params.get("track") === "local") {
  try { builtTrack = JSON.parse(localStorage.getItem("thunderline.track.v1")); } catch {}
}
const lay = builtTrack?.pieces?.length
  ? layoutFromPlacements({ built, pieces: builtTrack.pieces })
  : layoutTestTrack({ built, speed: JUMP_SPEED, jumpSpeeds: JUMPS, airDrag: AERO.drag / CHASSIS.mass });
const meshes = buildTrackMeshes(lay.placements, built, mats);
meshes.group.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.layers.enable(STATIC_LAYER); } });
scene.add(meshes.group);

// ---------- collision: deck BVH (wheels) + solids BVH (chassis vs rails) ----------
const asCollider = (geometry, M, userData = {}) => ({ geometry, matrixWorld: M, userData, updateMatrixWorld() {} });
const decks = [];
const solids = [];
for (const p of lay.placements) {
  const look = p.open ? built[p.id].open : built[p.id].guarded;
  // the left-hand mirrors ("…_L") are the same pieces: they need the same tags
  decks.push(asCollider(look.deck, p.M, { roadHold: ROAD_HOLD.has(p.id.replace(/_L$/, "")) }));
  if (look.railCollision) solids.push(asCollider(look.railCollision, p.M));
}
const deckBvh = new RoadBvh();
const solidsBvh = new RoadBvh();
const ground = createVehicleGround({ getTerrainHeight: () => NaN });
const t0 = performance.now();
deckBvh.bakeFromMeshes(decks);
ground.setRoadBvh(deckBvh.baked ? deckBvh : null);
solidsBvh.bakeFromMeshes(solids);
ground.setRoadSolidsBvh(solidsBvh.baked ? solidsBvh : null);
const bakeMs = performance.now() - t0;
let lowestY = Infinity;
for (const r of lay.ride) lowestY = Math.min(lowestY, r.P.y);
const KILL_Y = lowestY - 50;

// ---------- the car ----------
const vehicle = new Vehicle({ scene, showArrows: false });
vehicle.SUBSTEPS = SUBSTEPS; // per-car: 3 → 1/360 s, keeps travel per substep ≤ the verified 0.25 m up to 90 m/s
vehicle.getFloorY = () => NaN; // sky mode: no chassis floor at y = 0
vehicle.setSolidCapsules([]);
vehicle.setBvh(ground.ground, ground.solids);
const startPos = new V().setFromMatrixPosition(lay.start);
const startFwd = new V(0, 0, -1).transformDirection(lay.start);
const startQuat = new THREE.Quaternion().setFromAxisAngle(new V(0, 1, 0), Math.atan2(startFwd.x, startFwd.z)); // car forward = +Z
const spawnPos = startPos.clone().addScaledVector(startFwd, 12).add(new V(0, SPAWN_LIFT, 0));
vehicle.setSpawn(spawnPos, startQuat);
vehicle.setEnabled(true);
const chase = createChaseCamera({ camera, vehicle });
chase.reset();
// ---------- sun shadows: static atlas (track, baked once) + live map around the car ----------
// ?shadows=csm keeps the engine's 2 cascades instead, for an A/B.
const useNewShadows = params.get("shadows") !== "csm";
let sunShadows = null;
/** Car meshes cast into the live map (DYNAMIC layer). They receive through the sun's shadow term. */
function adoptCar(root) {
  root.traverse((o) => { if (o.isMesh) o.layers.enable(DYNAMIC_LAYER); });
}
if (useNewShadows) {
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); // let the sun settle for the time of day
  const sunDir = app.light.getDirection().clone();
  // every static caster, sampled in world space (deck + rail vertices of each placement)
  const pts = [];
  const tmp = new V();
  for (const p of lay.placements) {
    const look = p.open ? built[p.id].open : built[p.id].guarded;
    for (const g of [look.deck, look.rail]) {
      if (!g) continue;
      const a = g.getAttribute("position");
      for (let i = 0; i < a.count; i += 6) pts.push(tmp.fromBufferAttribute(a, i).applyMatrix4(p.M).clone());
    }
  }
  scene.updateMatrixWorld(true);
  sunShadows = createSunShadows({ renderer, scene, sunDir, casterPoints: pts });
  const bakeShadowMs = sunShadows.bake();
  sunShadows.stats.bakeMs = Math.round(bakeShadowMs);
  // the engine's opt-in hook: our node IS the sun's shadow term; the cascades leave the scene
  app.shadows.setSunShadowNode(sunShadows.visibility);
  console.info("[P3] sun shadows", sunShadows.stats);
}

// the Lotus is a DEV model only (trademark); it loads in the background, the car drives meanwhile
(async () => {
  try {
    const m = await loadChassisModel(renderer, CHASSIS_GLB_URL);
    adoptCar(m.object);
    vehicle.setHeadlampMounts(chassisGlbMounts(m.headlampMountsLocal));
    vehicle.setChassisModel(m.object, { brakeLights: m.brakeLights, headlampLenses: m.headlampLenses });
    vehicle.setChassisStyle("glb");
    const w = await loadWheelModel(renderer);
    adoptCar(w.object);
    vehicle.setWheelModel(w.object, { radius: w.radius, thickness: w.width });
    vehicle.setWheelStyle("glb");
  } catch (e) {
    console.warn("[P3] car model not loaded, driving the box", e);
  }
})();

// ---------- input (roadGame.js readControls, same keys and merge) ----------
const keys = {};
addEventListener("keydown", (e) => {
  keys[e.code.toLowerCase()] = true;
  if (e.code === "Backspace") { recoverToSafe(); e.preventDefault(); }
  if (e.code === "KeyR") restart();
  if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code)) e.preventDefault();
});
addEventListener("keyup", (e) => { keys[e.code.toLowerCase()] = false; });
const clearKeys = () => { for (const k of Object.keys(keys)) keys[k] = false; };
addEventListener("blur", clearKeys);
document.addEventListener("visibilitychange", clearKeys);
const gamepad = createGamepadInput();
let padRespawn = false;
function readControls() {
  const kbSteer = (keys.keya || keys.arrowleft ? 1 : 0) - (keys.keyd || keys.arrowright ? 1 : 0);
  const kbThrottle = (keys.keyw || keys.arrowup ? 1 : 0) - (keys.keys || keys.arrowdown ? 1 : 0);
  const kbYaw = (keys.keye ? 1 : 0) - (keys.keyq ? 1 : 0);
  const kbRoll = (keys.keyz ? 1 : 0) - (keys.keyx ? 1 : 0);
  const kbPitch = (keys.shiftleft || keys.shiftright ? 1 : 0) - (keys.controlleft || keys.controlright ? 1 : 0);
  const gp = gamepad.read();
  padRespawn = !!gp?.respawnPressed;
  if (!gp) return { steerTarget: kbSteer, rollTarget: kbRoll, throttle: kbThrottle, handbrake: !!keys.space, yaw: kbYaw, pitch: kbPitch, analog: false };
  return {
    steerTarget: kbSteer !== 0 ? kbSteer : gp.steerTarget,
    rollTarget: kbRoll !== 0 ? kbRoll : gp.steerTarget,
    throttle: kbThrottle !== 0 ? kbThrottle : gp.throttle,
    handbrake: !!keys.space || gp.handbrake,
    yaw: kbYaw !== 0 ? kbYaw : gp.yaw,
    pitch: kbPitch !== 0 ? kbPitch : gp.pitch,
    analog: kbSteer === 0 && gp.analog,
  };
}

// ---------- test autopilot (debug, P toggles): steer at the centreline 25 m ahead ----------
// Not gameplay — an objective check that the old car can drive every new piece.
let autopilot = params.has("auto");
let rideIdx = 0; // furthest ride point reached
const _inv = new THREE.Quaternion();
function autopilotInput() {
  const p = vehicle.body.pos;
  // nearest ride point, searched forward from the last one (the track crosses itself)
  let best = rideIdx, bd = Infinity;
  for (let i = Math.max(0, rideIdx - 20); i < Math.min(lay.ride.length, rideIdx + 400); i++) {
    const d = lay.ride[i].P.distanceToSquared(p);
    if (d < bd) { bd = d; best = i; }
  }
  rideIdx = best;
  const aim = (dist) => {
    let i = best, acc = 0;
    while (i + 1 < lay.ride.length && acc < dist) { acc += lay.ride[i].P.distanceTo(lay.ride[i + 1].P); i++; }
    return lay.ride[i];
  };
  _inv.copy(vehicle.body.quat).invert();
  const local = aim(25).P.clone().sub(p).applyQuaternion(_inv); // car local: +Z forward, +X left
  const steer = THREE.MathUtils.clamp((local.x / Math.max(local.z, 4)) * 2.5, -1, 1);
  const far = aim(90).T;
  const fwd = new V(0, 0, 1).applyQuaternion(vehicle.body.quat);
  const bend = Math.acos(THREE.MathUtils.clamp(far.dot(fwd), -1, 1));
  const v = vehicle.body.vel.length();
  // brake for flat brake turns only: not banked sweepers, not loops (their far point is above/behind)
  const throttle = bend > 1.1 && Math.abs(far.y) < 0.4 && Math.abs(fwd.y) < 0.4 && v > 26 && !lay.ride[best].air ? -1 : 1;
  return { steerTarget: steer, rollTarget: 0, throttle, handbrake: false, yaw: 0, pitch: 0, analog: true };
}
addEventListener("keydown", (e) => { if (e.code === "KeyP") { autopilot = !autopilot; rideIdx = 0; } });

// ---------- BOOST PADS: past the top speed, for a while (user: boosts make it "even faster") ----------
// Touching a boost pad's deck arms a push along the car's nose for BOOST.time; the push is added on
// top of the engine, so the car goes beyond its normal top speed and the drag/engine curve brings it
// back afterwards.
const BOOST = { accel: 14, time: 2.0 };
const boostPads = lay.placements.filter((p) => p.id.startsWith("boost")).map((p) => p.M.clone().invert());
let boostLeft = 0;
const _lp = new V();
const _fwd = new V();
function boostTick(dt) {
  const p = vehicle.body.pos;
  for (const inv of boostPads) {
    _lp.copy(p).applyMatrix4(inv); // piece frame: x right, y up, -z along the road
    if (Math.abs(_lp.x) < 8 && _lp.y > -1 && _lp.y < 3 && _lp.z < -4 && _lp.z > -28) boostLeft = BOOST.time;
  }
  if (boostLeft > 0 && vehicle.groundedCount > 0) {
    _fwd.set(0, 0, 1).applyQuaternion(vehicle.body.quat); // the car's nose is +Z
    vehicle.body.vel.addScaledVector(_fwd, BOOST.accel * dt);
  }
  boostLeft = Math.max(0, boostLeft - dt);
}

// ---------- respawn: restart, last safe spot, falls ----------
let simAccum = 0;
let runTime = 0;
let topKmh = 0;
const safe = { pos: spawnPos.clone(), quat: startQuat.clone(), ok: false };
function restart() {
  rideIdx = 0;
  vehicle.setSpawn(spawnPos, startQuat);
  vehicle.respawn();
  chase.reset();
  simAccum = 0;
  runTime = 0;
  topKmh = 0;
  safe.pos.copy(spawnPos);
  safe.quat.copy(startQuat);
}
let recoveries = 0;
function recoverToSafe() {
  recoveries++;
  vehicle.respawnAt(safe.pos.clone().add(new V(0, 0.5, 0)), safe.quat.clone());
  chase.reset();
  simAccum = 0;
}
function checkFall() {
  const p = vehicle.body.pos;
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return restart();
  // a fall restarts the run (the last safe spot can be a kicker lip: respawning there at 0 km/h just
  // falls again). Checkpoint respawn that keeps your speed is the real game's rule (DESIGN.md §8).
  if (p.y < KILL_Y) { recoveries++; return restart(); }
  if (STUCK?.enabled && vehicle.isBeached && vehicle.stuckTime >= STUCK.respawnAfter) return recoverToSafe();
}

// ---------- HUD ----------
function renderStats() {
  $("stats").innerHTML =
    `track <b>${(lay.length / 1000).toFixed(2)} km</b> · <b>${lay.placements.length}</b> pieces<br>` +
    `collision bake <b>${bakeMs.toFixed(0)} ms</b> · wheels down <b>${vehicle.groundedCount}/4</b><br>` +
    `top speed this run <b>${Math.round(topKmh)} km/h</b>` +
    (lay.warnings.length ? `<br><span style="color:#ff4d5e">${lay.warnings.join("<br>")}</span>` : "");
}

// ---------- the sim loop (roadGame.js:9904) ----------
boot.classList.add("gone");
setTimeout(() => boot.remove(), 600);
let last = performance.now();
let frame = 0;
// the car's model and wheels are attached after load (setChassisModel / setWheelModel re-parent them);
// re-adopt the car group a few times so late children land on the DYNAMIC layer too
let adoptCount = 0;
const physMs = []; // physics ms per 1/120 s tick, last ~4 s
function adoptCarLayersOnce() { if (adoptCount++ % 60 === 0 && adoptCount < 1200) adoptCar(vehicle.group); }
function tick() {
  requestAnimationFrame(tick);
  const now = performance.now();
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  const input = autopilot ? autopilotInput() : readControls();
  if (padRespawn) recoverToSafe();
  simAccum += dt;
  let ticks = Math.floor(simAccum / FIXED_DT);
  if (ticks > MAX_SIM_TICKS) { ticks = MAX_SIM_TICKS; simAccum = ticks * FIXED_DT; }
  simAccum -= ticks * FIXED_DT;
  const tPhys = performance.now();
  for (let i = 0; i < ticks; i++) {
    vehicle.tick(input);
    boostTick(FIXED_DT);
    runTime += FIXED_DT;
    if (vehicle.groundedCount >= 3) { safe.pos.copy(vehicle.body.pos); safe.quat.copy(vehicle.body.quat); safe.ok = true; }
  }
  if (ticks) physMs.push((performance.now() - tPhys) / ticks);
  if (physMs.length > 240) physMs.shift();
  vehicle.syncVisuals(dt, simAccum / FIXED_DT);
  if (sunShadows) { adoptCarLayersOnce(); sunShadows.follow(vehicle.renderPos); }
  checkFall();
  chase.update(dt);
  controls.target.copy(vehicle.renderPos);
  const kmh = Math.abs(vehicle.speedKmh ?? vehicle.body.vel.length() * 3.6);
  topKmh = Math.max(topKmh, kmh);
  $("kmh").textContent = Math.round(kmh);
  $("time").textContent = runTime.toFixed(2) + (boostLeft > 0 ? "  ·  BOOST" : "");
  if (++frame % 15 === 0) renderStats();
}
requestAnimationFrame(tick);

window.__drive = {
  app, vehicle, lay, restart, recoverToSafe, keys, chase, get sunShadows() { return sunShadows; },
  get topKmh() { return topKmh; }, get rideIdx() { return rideIdx; }, get recoveries() { return recoveries; },
  get boosting() { return boostLeft > 0; }, physMs: () => { const s = [...physMs].sort((a, b) => a - b); return s.length ? { median: s[s.length >> 1], p95: s[Math.floor(s.length * 0.95)] } : null; },
  config: { TOP, SUBSTEPS, JUMP_SPEED },
  setAuto(on) { autopilot = on; rideIdx = 0; recoveries = 0; },
};
