// Thunderline P3 — drive the REAL car (the old physics, copied by import, untouched) on the NEW
// pieces (kit.js paths drawn with the old look), under Sky Pro, with the old chase camera.
// The wiring follows roadGame.js (boot :291, collision bake :4876-5030, readControls :7663, sim loop
// :9904-10040), minus everything a sky track doesn't need. Throwaway: it answers DESIGN.md §9 P3.
import * as THREE from "three";
import { float, abs, dot, vec3, normalView, positionViewDirection } from "three/tsl";
import { startV3App } from "../../../../v3/engine.js";
import { Vehicle, FIXED_DT, STUCK, TIRE, AERO, CHASSIS, WHEEL } from "../../../../v3/play/modularRoadVehicle.js";
import { RoadBvh } from "../../../../v3/play/modularRoadBvh.js";
import { createVehicleGround } from "../../../../v3/play/modularRoadGround.js";
import { createChaseCamera, CHASE_CAM } from "../../../modular-road-v3/chaseCamera.js";
import { createGamepadInput } from "../../../modular-road-v3/gamepadInput.js";
import { loadChassisModel, CHASSIS_GLB_URL, chassisGlbMounts } from "../../../modular-road-v3/chassisModel.js";
import { loadWheelModel } from "../../../modular-road-v3/wheelModel.js";
import { TILES, integrate, ensureTile, SECTIONS } from "./kit.js";
import { gatesFor, createRace, medalTimes, medalFor } from "./race.js";
import { makeGateMesh } from "./gateMesh.js";
import { library, contentKey, settings, builderUrl, PAGES } from "../../app/library.js";
import { createAutopilot, wallCut } from "./autopilot.js";
import { applyCarTune } from "./carTune.js";
import { createCarRules, magnetZones } from "./carRules.js";
import { createGhostRecorder, createGhostPlayer } from "./ghost.js";
import { createEngineModel } from "./engineModel.js";
import { createEngineSound } from "./engineSound.js";
import { createSfx } from "./sfx.js";
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
// as decoration). THE FLOOR IS SOLID (user, 2026-10-18: "when the floor terrain is enabled it should
// be a solid, car shouldn't go through it"): the wheels drive on it and the body can't pass it, read
// from the engine's own height (app.getWorldHeight, as the old game did) so real terrain works too.
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
applyCarTune({ TIRE, WHEEL }, TOP); // carTune.js: the builder's prediction drives this same car
CHASE_CAM.fovSpeedRef = TOP; // "keep matching TIRE.topSpeed"
// Flights are placed for the speed the car REALLY has at the kicker lip: 0.91 × top measured on this
// run-up at top 50 (164 km/h). ?jump=<m/s> overrides.
const JUMP_SPEED = Number(params.get("jump")) || TOP * 0.91;
// ?jumps=a,b,c = measured take-off speed (m/s) of each flight; defaults measured with the autopilot at
// top 63 / 3 substeps (jump 1: 201 km/h, jump 2: 175 km/h after the brake turn, jump 3: 182 km/h)
const JUMPS = (params.get("jumps") ?? "55.8,48.6,50.6").split(",").map(Number).filter((v) => v > 0);
let builtTrack = null;
let roadPieces = []; // the track's road; its AIR RINGS (builder: on a flight arc) are gates, not road
let ringGates = [];
// ?track=<library id> (menu, builder), ?track=local = the track the builder last worked on
const trackParam = params.get("track");
const trackId = trackParam === "local" ? library.current : trackParam;
const trackRec = trackId ? library.get(trackId) : null;
const cameFrom = params.get("from"); // "builder" → Back goes there
const prefs = settings.get();
if (trackRec) {
  builtTrack = trackRec.track;
  roadPieces = (builtTrack?.pieces ?? []).filter((p) => !p.ring);
  ringGates = (builtTrack?.pieces ?? []).filter((p) => p.ring).map((p) => {
    const M = new THREE.Matrix4().fromArray(p.M);
    return { P: new V().setFromMatrixPosition(M), T: new V(0, 0, -1).transformDirection(M), U: new V(0, 1, 0).transformDirection(M), r: 5.5 };
  });
  // generated pieces (fitted landings) are rebuilt from their id, exactly as the builder made them
  for (const p of builtTrack?.pieces ?? []) {
    const t = ensureTile(p.id);
    if (t && !built[p.id]) built[p.id] = { b: integrate(t), guarded: buildOldLook(t, true), open: buildOldLook(t, false) };
  }
}
const lay = builtTrack?.pieces?.length
  ? layoutFromPlacements({ built, pieces: roadPieces })
  : layoutTestTrack({ built, speed: JUMP_SPEED, jumpSpeeds: JUMPS, airDrag: AERO.drag / CHASSIS.mass });
const meshes = buildTrackMeshes(lay.placements, built, mats);
meshes.group.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.layers.enable(STATIC_LAYER); } });
scene.add(meshes.group);

// ---------- THE RACE (race.js, DESIGN.md §8): gates, checkpoints in any order, finish, medals ----------
// A checkpoint is a flag on a piece (builder: select it, C). The built-in test track has one at each landing.
const flagged = builtTrack?.pieces?.length
  ? roadPieces.map((p, k) => (p.cp ? k : -1)).filter((k) => k >= 0)
  : lay.placements.map((p, k) => (/landing|catch_pad/.test(p.id) ? k : -1)).filter((k) => k >= 0);
const hwOf = (k) => SECTIONS[TILES[lay.placements[k]?.id]?.section ?? "road"].hw;
const gates = gatesFor(lay.ride, flagged, hwOf, ringGates);
const r0 = lay.ride[0];
for (const g of [{ kind: "start", P: r0.P.clone().addScaledVector(r0.T, 6), T: r0.T.clone(), U: r0.U ?? new V(0, 1, 0), hw: hwOf(0) }, ...gates]) scene.add(makeGateMesh(g));
const race = createRace({ gates });
// the track's identity for records: its pieces, links and flags (DESIGN.md §8 keys records by content)
const trackKey = builtTrack?.pieces?.length ? contentKey(builtTrack) : "test";
const medals = medalTimes(builtTrack?.authorTime);
const BEST_KEY = `thunderline.best.${trackKey}`;
const loadBest = () => { try { return JSON.parse(localStorage.getItem(BEST_KEY)); } catch { return null; } };
let best = loadBest();

// ---------- collision: deck BVH (wheels) + solids BVH (chassis vs rails) ----------
const asCollider = (geometry, M, userData = {}) => ({ geometry, matrixWorld: M, userData, updateMatrixWorld() {} });
const decks = [];
const solids = [];
for (const p of lay.placements) {
  const look = p.open ? built[p.id].open : built[p.id].guarded;
  // the left-hand mirrors ("…_L") are the same pieces: they need the same tags
  const t = TILES[p.id];
  decks.push(asCollider(look.deck, p.M, { roadHold: ROAD_HOLD.has(p.id.replace(/_L$/, "")) || !!t?.roadHold, freeCarve: !!t?.freeCarve }));
  if (look.railCollision) solids.push(asCollider(look.railCollision, p.M));
}
const deckBvh = new RoadBvh();
const solidsBvh = new RoadBvh();
const floorH = (x, z) => app.getWorldHeight(x, z);
const ground = createVehicleGround({ getTerrainHeight: floorH });
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
vehicle.getFloorY = floorH; // the floor is solid for the body too
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
  try {
    // the ghost: its own copies of the same models (WHEEL.radius is the same value), THEN the hologram
    // look — styled before the models arrive, the car's own setup choked on the hologram material
    const gm = await loadChassisModel(renderer, CHASSIS_GLB_URL);
    ghostCar.setChassisModel(gm.object, { brakeLights: gm.brakeLights, headlampLenses: gm.headlampLenses });
    ghostCar.setChassisStyle("glb");
    const gw = await loadWheelModel(renderer);
    ghostCar.setWheelModel(gw.object, { radius: gw.radius, thickness: gw.width });
    ghostCar.setWheelStyle("glb");
    ghostify(ghostCar.group);
    ghostStyled = true;
    if (ghostPlayer && showGhost) ghostCar.group.visible = true;
  } catch (e) {
    console.warn("[ghost] model not loaded: no ghost shown", e);
  }
})();

// ---------- input (roadGame.js readControls, same keys and merge) ----------
const keys = {};
addEventListener("keydown", (e) => {
  keys[e.code.toLowerCase()] = true;
  if (e.code === "Backspace") { respawnCheckpoint(); e.preventDefault(); }
  if (e.code === "KeyR" || e.code === "Delete") restart();
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
const pilot = createAutopilot(lay.ride); // autopilot.js: shared with the builder's prediction and the tests
const autopilotInput = () => pilot.input(vehicle);
addEventListener("keydown", (e) => { if (e.code === "KeyP") { autopilot = !autopilot; pilot.reset(); } });

// ---------- THE CAR'S RULES (carRules.js): wall cut, landing judge + boost, BOOST PADS ----------
// Boost pads push past the top speed for a while (user: boosts make it "even faster"). The player and
// the ghost step through the same rules, so a replay is the same run.
const boostPads = lay.placements.filter((p) => p.id.startsWith("boost")).map((p) => p.M.clone().invert());
const magnets = magnetZones(lay.placements, TILES, integrate); // twist pieces hold the car (carRules MAGNET)
const rules = createCarRules(vehicle, { boostPads, magnets });

// ---------- GHOST (ghost.js, DESIGN.md §8): your best run, replayed by a second car ----------
const GHOST_KEY = `thunderline.ghost.${trackKey}`;
const recorder = createGhostRecorder();
let ghostData = null;
try { ghostData = JSON.parse(localStorage.getItem(GHOST_KEY)); } catch {}
const ghostCar = new Vehicle({ scene, showArrows: false });
ghostCar.SUBSTEPS = SUBSTEPS;
ghostCar.getFloorY = floorH;
ghostCar.setSolidCapsules([]);
ghostCar.setBvh(ground.ground, ground.solids);
// no headlights on the ghost: two more spot lights would change the light count and recompile every
// material (r184), and a ghost does not light the road
ghostCar.group.traverse((o) => { if (o.isLight) o.visible = false; });
for (const l of ghostCar.headlights ?? []) l.parent?.remove(l);
ghostCar.group.visible = false;
const ghostRules = createCarRules(ghostCar, { boostPads, magnets });
let ghostPlayer = null;
/**
 * THE GHOST'S LOOK: a bolt-blue HOLOGRAM, one shared material — glowing (additive), bright at its
 * outline (fresnel: surfaces turning away from you), faint in the middle, so it reads at once as
 * "not a real car" and never hides the road. The old way cloned the car's materials translucent and
 * came out flat grey (user: "the ghost looks bad, it looks grey"): a cloned NodeMaterial drops its map.
 */
const ghostFresnel = float(1).sub(abs(dot(normalView, positionViewDirection))).pow(2.2);
const ghostMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
ghostMat.colorNode = vec3(0.25, 0.82, 1.0).mul(ghostFresnel.mul(1.7).add(0.1));
ghostMat.opacityNode = ghostFresnel.mul(0.75).add(0.15);
function ghostify(root) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = false;
    o.receiveShadow = false;
    o.material = Array.isArray(o.material) ? o.material.map(() => ghostMat) : ghostMat;
  });
}
let ghostStyled = false; // the ghost is only shown once it wears its hologram (models loaded)
function startGhost() {
  ghostPlayer = ghostData?.inputs?.length ? createGhostPlayer(ghostCar, ghostRules, ghostData) : null;
  ghostCar.group.visible = !!ghostPlayer && showGhost && ghostStyled;
  if (ghostPlayer) ghostPlayer.start(spawnPos, startQuat);
  else ghostCar.setEnabled(false);
}
let showGhost = params.get("ghost") !== "off" && prefs.ghost;
addEventListener("keydown", (e) => { if (e.code === "KeyG") { showGhost = !showGhost; ghostCar.group.visible = !!ghostPlayer && showGhost && ghostStyled; } });

// ---------- landings: the grade flashes under the timer ----------
const landings = []; // every graded landing this run (tests read it)
let landTimer = null;
function showLanding(ev) {
  landings.push({ grade: ev.grade, err: Math.round(ev.err), air: +ev.air.toFixed(1), t: +runTime.toFixed(2) });
  const el = $("land");
  const label = { perfect: "Perfect landing", ok: "Landed", rough: "Rough landing" }[ev.grade];
  const tail = ev.grade === "perfect" ? "boost" : ev.grade === "rough" ? "−15% speed" : "land flat for a boost";
  el.innerHTML = `${label}<small>${Math.round(ev.err)}° · ${ev.air.toFixed(1)} s air · ${tail}</small>`;
  el.className = `panel show ${ev.grade}`;
  clearTimeout(landTimer);
  landTimer = setTimeout(() => el.classList.remove("show"), 1400);
}

// ---------- ENGINE SOUND (engineModel.js + engineSound.js, synthesised) ----------
// Starts on the first key press / click (browsers allow audio only after a gesture). The engine reads
// the car's speed along its nose, the throttle (the player's or the autopilot's) and the wheels: on
// the line during the countdown, and in the air, it revs freely. M mutes; the tab hidden = paused.
const engine = createEngineModel();
const engineSound = createEngineSound({ type: prefs.engine ?? "v8", volume: prefs.volume ?? 0.7 });
let engineMuted = !(prefs.sound ?? false);
engineSound.setMuted(engineMuted);
// the other sounds (sfx.js: tyres, wind, landings, boost, race beeps), on the engine's audio context
const sfx = createSfx(() => (engineSound.ready ? engineSound.context : null), { volume: prefs.volume ?? 0.7 });
sfx.setMuted(engineMuted);
const unlockAudio = () => { if (!engineMuted) engineSound.unlock(); };
addEventListener("keydown", (e) => {
  unlockAudio();
  if (e.code === "KeyM") { engineMuted = !engineMuted; engineSound.setMuted(engineMuted); sfx.setMuted(engineMuted); if (!engineMuted) engineSound.unlock(); }
});
addEventListener("pointerdown", unlockAudio);
document.addEventListener("visibilitychange", () => (document.hidden ? engineSound.suspend() : engineSound.resume()));
const _nose = new V();
function engineTick(dt, input) {
  _nose.set(0, 0, 1).applyQuaternion(vehicle.body.quat);
  const kmh = Math.max(0, vehicle.body.vel.dot(_nose)) * 3.6;
  const parked = race.s.state === "finished" && !vehicle.enabled;
  const throttle = parked ? 0 : Math.max(0, input.throttle ?? 0);
  // held on the line, the wheels don't turn: the engine revs freely, as in the air
  const free = race.holding || vehicle.groundedCount === 0;
  engineSound.update(engine.update(dt, kmh, throttle, !free));
  // tyres slide when the car moves SIDEWAYS (car-local x); braking = the brake held at speed
  _side.set(1, 0, 0).applyQuaternion(vehicle.body.quat);
  const boosting = rules.boostLeft > 0;
  if (boosting && !wasBoosting) sfx.boost();
  wasBoosting = boosting;
  sfx.update(dt, { kmh, slip: vehicle.body.vel.dot(_side), grounded: vehicle.groundedCount > 0, braking: (input.throttle ?? 0) < 0 || !!input.handbrake, boosting });
  // the countdown: a beep on 3, 2, 1
  const n = race.s.state === "countdown" ? Math.ceil(race.s.hold * 2) : 0;
  if (n && n !== lastCount && n <= 3) sfx.beep("count");
  lastCount = n;
}
const _side = new V();
let wasBoosting = false, lastCount = 0, fallSpeed = 0;

// ---------- race events + HUD ----------
const HOLD = { steerTarget: 0, rollTarget: 0, throttle: 0, handbrake: true, yaw: 0, pitch: 0, analog: false };
const fmt = (t) => {
  if (t == null) return "—";
  const m = Math.floor(t / 60), sec = (t % 60).toFixed(2);
  return m ? `${m}:${sec.padStart(5, "0")}` : sec;
};
let splitTimer = null;
function flashSplit(html, cls) {
  const el = $("split");
  el.innerHTML = html;
  el.className = `panel show ${cls}`;
  clearTimeout(splitTimer);
  splitTimer = setTimeout(() => el.classList.remove("show"), 1800);
}
function onRace(e) {
  if (e.type === "go") sfx.beep("go");
  if (e.type === "cp") sfx.beep("cp");
  if (e.type === "finish") sfx.beep("finish");
  if (e.type === "missing") sfx.beep("miss");
  if (e.type === "cp") {
    // split against the best run's time at the same checkpoint
    const b = best?.splits?.find((s) => s.gate === e.gate);
    const diff = b ? e.time - b.time : null;
    const tail = diff != null ? ` <small class="${diff <= 0 ? "ahead" : "behind"}">${diff <= 0 ? "−" : "+"}${Math.abs(diff).toFixed(2)}</small>` : "";
    flashSplit(`CP ${e.n}/${e.of} · ${fmt(e.time)}${tail}`, "cp");
  } else if (e.type === "missing") {
    flashSplit(`${e.n} checkpoint${e.n > 1 ? "s" : ""} missed — take them all`, "miss");
  } else if (e.type === "finish") {
    const improved = !best || e.time < best.time;
    if (improved) {
      best = { time: e.time, splits: race.s.splits.slice() };
      try { localStorage.setItem(BEST_KEY, JSON.stringify(best)); } catch {}
      // the new best becomes the ghost (from the next restart)
      ghostData = recorder.finish(e.time);
      try { localStorage.setItem(GHOST_KEY, JSON.stringify(ghostData)); } catch (err) { console.warn("[ghost] not saved", err); }
    }
    if (trackId) library.recordFinish(trackId, e.time, medalFor(e.time, medals));
    showFinish(e.time, improved);
  }
}
const MEDAL_NAMES = { author: "Author", gold: "Gold", silver: "Silver", bronze: "Bronze" };
function showFinish(time, improved) {
  const m = medalFor(time, medals);
  const rows = medals
    ? ["author", "gold", "silver", "bronze"].map((k) => `<div class="mrow ${k}${m === k ? " got" : ""}"><i></i>${MEDAL_NAMES[k]}<b>${fmt(medals[k])}</b></div>`).join("")
    : `<div class="mrow">No author time yet: open the track in the builder and let its prediction finish</div>`;
  const head = m ? `${MEDAL_NAMES[m]} medal` : medals ? "No medal" : "Finished";
  $("finish").innerHTML =
    `<div class="ft">${fmt(time)}</div>` +
    `<div class="fm">${head}${improved ? " · new best" : ` · best ${fmt(best?.time)}`}</div>` +
    rows +
    `<div class="fbtns"><button id="f-again">Again <kbd>R</kbd></button>` +
    (cameFrom === "builder" ? `<button id="f-build">Back to builder <kbd>B</kbd></button>` : "") +
    `<button id="f-menu">Menu <kbd>Esc</kbd></button></div>`;
  $("f-again").onclick = () => restart();
  if ($("f-build")) $("f-build").onclick = goBuilder;
  $("f-menu").onclick = goMenu;
  $("finish").classList.add("show");
}

// ---------- leaving: back to the builder (a test drive) or the menu ----------
function goBuilder() { if (trackId) location.href = builderUrl(trackId); }
function goMenu() { location.href = `${PAGES.menu}${cameFrom === "builder" ? "#build" : "#play"}`; }
addEventListener("keydown", (e) => {
  if (e.code === "Escape") (cameFrom === "builder" ? goBuilder : goMenu)();
  if (e.code === "KeyB" && cameFrom === "builder") goBuilder();
});

// ---------- respawn: restart, checkpoints, last safe spot, falls ----------
let simAccum = 0;
let runTime = 0;
let topKmh = 0;
const safe = { pos: spawnPos.clone(), quat: startQuat.clone(), ok: false };
function restart() {
  engine.reset();
  race.reset();
  $("finish").classList.remove("show");
  vehicle.setEnabled(true); // parked after a finish
  rules.reset();
  recorder.start();
  landings.length = 0;
  pilot.reset();
  vehicle.setSpawn(spawnPos, startQuat);
  vehicle.respawn();
  startGhost();
  chase.reset();
  simAccum = 0;
  runTime = 0;
  topKmh = 0;
  safe.pos.copy(spawnPos);
  safe.quat.copy(startQuat);
}
let recoveries = 0;
// CHECKPOINT RESPAWN (DESIGN.md §8): Backspace = back to the last checkpoint at the speed you had
// there; again within 1.5 s = the same spot standing (a carried speed can replay a bad line); no
// checkpoint yet = the start, standing. The clock keeps running.
let lastBackspace = -1e9;
function respawnCheckpoint() {
  const now = performance.now();
  const standing = now - lastBackspace < 1500;
  lastBackspace = now;
  const cp = race.s.last;
  const pos = cp ? cp.pos.clone() : spawnPos.clone();
  const quat = cp ? cp.quat.clone() : startQuat.clone();
  vehicle.respawnAt(pos, quat);
  if (cp && !standing) vehicle.body.vel.copy(cp.vel);
  race.teleported(vehicle.body.pos);
  rules.reset();
  recorder.respawn(vehicle);
  pilot.reset();
  chase.reset();
  simAccum = 0;
  recoveries++;
}
function recoverToSafe() {
  rules.reset();
  recoveries++;
  vehicle.respawnAt(safe.pos.clone().add(new V(0, 0.5, 0)), safe.quat.clone());
  race.teleported(vehicle.body.pos);
  recorder.respawn(vehicle);
  chase.reset();
  simAccum = 0;
}
function checkFall() {
  const p = vehicle.body.pos;
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return restart();
  // a fall restarts the run (the last safe spot can be a kicker lip: respawning there at 0 km/h just
  // falls again). Checkpoint respawn that keeps your speed is the real game's rule (DESIGN.md §8).
  if (p.y < KILL_Y) {
    // after the finish the road ends: park the car under the finish screen instead of restarting
    if (race.s.state === "finished") { vehicle.setEnabled(false); return; }
    return race.s.state === "running" ? respawnCheckpoint() : restart();
  }
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
restart(); // the first run: countdown, recording, the saved ghost
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
  if (padRespawn) respawnCheckpoint();
  simAccum += dt;
  let ticks = Math.floor(simAccum / FIXED_DT);
  if (ticks > MAX_SIM_TICKS) { ticks = MAX_SIM_TICKS; simAccum = ticks * FIXED_DT; }
  simAccum -= ticks * FIXED_DT;
  const tPhys = performance.now();
  for (let i = 0; i < ticks; i++) {
    // NO ENGINE UP A WALL applies to everyone (autopilot.js wallCut), every tick: a car rule.
    // The countdown holds the car on the line.
    // CLEAN-LANDING BOOST (landing.js): land flat → the boost pad's push; land crooked → lose speed.
    // All of it is carRules.step, which the ghost replays too.
    const used = race.holding ? HOLD : input;
    const landed = rules.step(used, FIXED_DT);
    if (race.s.state !== "finished") recorder.tick(used, vehicle);
    if (landed) { showLanding(landed); sfx.landing(landed, fallSpeed); }
    if (vehicle.groundedCount === 0) fallSpeed = Math.max(0, -vehicle.body.vel.y); // how hard the next landing hits
    for (const e of race.tick(vehicle, FIXED_DT)) onRace(e);
    if (ghostPlayer) ghostPlayer.tick(FIXED_DT);
    runTime += FIXED_DT;
    if (vehicle.groundedCount >= 3) { safe.pos.copy(vehicle.body.pos); safe.quat.copy(vehicle.body.quat); safe.ok = true; }
  }
  if (ticks) physMs.push((performance.now() - tPhys) / ticks);
  if (physMs.length > 240) physMs.shift();
  vehicle.syncVisuals(dt, simAccum / FIXED_DT);
  engineTick(dt, input);
  if (ghostPlayer) {
    if (ghostPlayer.done) ghostCar.group.visible = false;
    else if (showGhost) ghostCar.syncVisuals(dt, simAccum / FIXED_DT);
  }
  if (sunShadows) { adoptCarLayersOnce(); sunShadows.follow(vehicle.renderPos); }
  checkFall();
  chase.update(dt);
  controls.target.copy(vehicle.renderPos);
  const kmh = Math.abs(vehicle.speedKmh ?? vehicle.body.vel.length() * 3.6);
  topKmh = Math.max(topKmh, kmh);
  $("kmh").textContent = Math.round(kmh);
  const rs = race.s;
  // countdown: 3 · 2 · 1 over 1.5 s
  $("time").textContent = rs.state === "countdown" ? String(Math.ceil(rs.hold * 2)) : fmt(rs.state === "finished" ? rs.finishTime : rs.time);
  $("cps").textContent = race.cps.length ? `CP ${rs.taken.size}/${race.cps.length}` : "no checkpoints";
  $("cps").classList.toggle("boost", rules.boostLeft > 0);
  if (++frame % 15 === 0) renderStats();
}
requestAnimationFrame(tick);

window.__drive = {
  app, vehicle, lay, restart, recoverToSafe, keys, chase, get sunShadows() { return sunShadows; },
  get topKmh() { return topKmh; }, get rideIdx() { return pilot.idx; }, get recoveries() { return recoveries; },
  get boosting() { return rules.boostLeft > 0; }, engine, engineSound, sfx, camera, ghostCar, get ghostPlayer() { return ghostPlayer; }, get ghostData() { return ghostData; }, recorder, landings, race, gates, respawnCheckpoint, get best() { return best; }, medals, trackKey, physMs: () => { const s = [...physMs].sort((a, b) => a - b); return s.length ? { median: s[s.length >> 1], p95: s[Math.floor(s.length * 0.95)] } : null; },
  config: { TOP, SUBSTEPS, JUMP_SPEED },
  setAuto(on) { autopilot = on; pilot.reset(); recoveries = 0; },
};
