// THE DRIVE, as a module: the car, its ghost, input, sound and HUD are made ONCE (the rig); each test
// drive is a SESSION on a track (collision, gates, race, ghost data, car rules) that can stop without a
// page reload. The drive page uses one session; the builder starts one in place when you press Drive
// and goes back to building on Esc (user, 2026-10-19: the builder ↔ drive reload cost ~30 s each way).
// The wiring follows roadGame.js (boot :291, collision bake :4876-5030, readControls :7663, sim loop
// :9904-10040), minus everything a sky track doesn't need.
import * as THREE from "three";
import { float, abs, dot, vec3, normalView, positionViewDirection } from "three/tsl";
import { Vehicle, FIXED_DT, STUCK, TIRE, AERO, CHASSIS, WHEEL, SOLID, CRASH } from "../../../../v3/play/modularRoadVehicle.js";
import { RoadBvh } from "../../../../v3/play/modularRoadBvh.js";
import { createVehicleGround } from "../../../../v3/play/modularRoadGround.js";
import { createChaseCamera, CHASE_CAM } from "../../../modular-road-v3/chaseCamera.js";
import { createGamepadInput } from "../../../modular-road-v3/gamepadInput.js";
import { loadChassisModel, CHASSIS_GLB_URL, chassisGlbMounts } from "../../../modular-road-v3/chassisModel.js";
import { loadWheelModel } from "../../../modular-road-v3/wheelModel.js";
import { TILES, integrate, ensureTile, SECTIONS, socketMatrix, leanOut } from "./kit.js";
import { gatesFor, createRace, medalTimes, medalFor } from "./race.js";
import { makeGateMesh } from "./gateMesh.js";
import { library, campaign, contentKey } from "../../app/library.js";
import { createAutopilot } from "./autopilot.js";
import { applyCarTune, CAR_TUNE } from "./carTune.js";
import { createCarRules, magnetZones } from "./carRules.js";
import { createGhostRecorder, createGhostPlayer } from "./ghost.js";
import { createEngineModel } from "./engineModel.js";
import { createEngineSound } from "./engineSound.js";
import { createSfx } from "./sfx.js";
import { buildOldLook, createOldLookMaterials } from "./oldLook.js";
import { layoutTestTrack, layoutFromPlacements, buildTrackMeshes } from "./testTrack.js";
import { createSunShadows, STATIC_LAYER, DYNAMIC_LAYER } from "./sunShadows.js";
import { loadThunderCar, THUNDER_CAR_URL, THUNDER_CAR_LOD1_URL } from "./thunderCar.js";
import { buildObstacleSet, avoidObstacles } from "./obstacles.js";

const V = THREE.Vector3;
// Road hold (the old car's crest/bank follower) goes on pieces the car should FOLLOW, never on
// launchers or landings (old rule, FOLLOW_ROAD in modularRoadKit.js:5911).
const ROAD_HOLD = new Set(["bank_in_22", "bank_out_22", "fast_turn_128"]);
const SPAWN_LIFT = 0.6;
const MAX_SIM_TICKS = 8;
// where the car waits while nobody drives (under the floor: its headlights light nothing, and it stays
// in the scene — hiding it would turn its lights off, and a light count change recompiles every material)
const PARK = new V(0, -400, 0);

const HUD_CSS = `
  #drive-hud { display: none; }
  #drive-hud.on { display: block; }
  #drive-hud .panel { position: fixed; z-index: 30; background: rgba(11, 17, 32, 0.9); border-left: 3px solid #3fd2ff; padding: 8px 14px; color: #e8f0ff; font: 13px/1.4 Inter, system-ui, sans-serif; }
  #drive-hud kbd { color: #e8f0ff; background: #121a2e; border: 1px solid #23304d; padding: 0 4px; font: 11px Consolas, monospace; }
  #drive-hud #speed { right: 18px; bottom: 18px; text-align: right; }
  #drive-hud #speed .v { font: 800 54px/1 "Barlow Condensed"; letter-spacing: 0.02em; }
  #drive-hud #speed .u { font: 700 14px "Barlow Condensed"; color: #8796b5; letter-spacing: 0.1em; }
  #drive-hud #time { left: 50%; top: 16px; transform: translateX(-50%); font: 800 26px "Barlow Condensed"; letter-spacing: 0.05em; }
  #drive-hud #help { left: 16px; bottom: 16px; color: #8796b5; font-size: 12px; max-width: 380px; }
  #drive-hud #stats { left: 16px; top: 16px; color: #8796b5; font-size: 12px; min-width: 210px; }
  #drive-hud #stats b { color: #e8f0ff; }
  #drive-hud #land { left: 50%; top: 76px; transform: translateX(-50%); font: 800 34px "Barlow Condensed"; letter-spacing: 0.08em; text-transform: uppercase; opacity: 0; transition: opacity 0.35s; pointer-events: none; }
  #drive-hud #land.show { opacity: 1; transition: none; }
  #drive-hud #land.perfect { color: #3fd2ff; }
  #drive-hud #land.rough { color: #ff4d5e; border-left-color: #ff4d5e; }
  #drive-hud #land.ok { color: #8796b5; border-left-color: #23304d; }
  #drive-hud #land small { font: 700 14px "Barlow Condensed"; color: #8796b5; margin-left: 8px; letter-spacing: 0.04em; }
  #drive-hud #cps { left: 50%; top: 16px; transform: translateX(calc(-50% - 120px)); font: 700 15px "Barlow Condensed"; letter-spacing: 0.08em; color: #8796b5; padding: 13px 12px; }
  #drive-hud #cps.boost { color: #3fd2ff; }
  #drive-hud #cps.boost::after { content: " · BOOST"; }
  #drive-hud #split { left: 50%; top: 130px; transform: translateX(-50%); font: 800 24px "Barlow Condensed"; letter-spacing: 0.06em; opacity: 0; transition: opacity 0.35s; pointer-events: none; }
  #drive-hud #split.show { opacity: 1; transition: none; }
  #drive-hud #split.miss { color: #ff4d5e; border-left-color: #ff4d5e; }
  #drive-hud #split small { font: 800 22px "Barlow Condensed"; margin-left: 10px; }
  #drive-hud #split .ahead { color: #45e08a; } #drive-hud #split .behind { color: #ff4d5e; }
  #drive-hud #finish { left: 50%; top: 50%; transform: translate(-50%, -50%) scale(0.96); min-width: 320px; padding: 18px 24px; opacity: 0; pointer-events: none; transition: opacity 0.25s, transform 0.25s; }
  #drive-hud #finish.show { opacity: 1; transform: translate(-50%, -50%); pointer-events: auto; }
  #drive-hud #finish .ft { font: 800 64px/1 "Barlow Condensed"; letter-spacing: 0.02em; }
  #drive-hud #finish .fm { font: 700 18px "Barlow Condensed"; color: #3fd2ff; letter-spacing: 0.08em; text-transform: uppercase; margin: 6px 0 12px; }
  #drive-hud #finish .mrow { display: flex; align-items: center; gap: 10px; font: 600 15px "Barlow Condensed"; color: #8796b5; padding: 3px 0; letter-spacing: 0.04em; }
  #drive-hud #finish .mrow b { margin-left: auto; color: #e8f0ff; }
  #drive-hud #finish .mrow i { width: 12px; height: 12px; border-radius: 50%; background: #5b6787; }
  #drive-hud #finish .mrow.author i { background: #3fd2ff; } #drive-hud #finish .mrow.gold i { background: #f2c14e; } #drive-hud #finish .mrow.silver i { background: #c9d1de; } #drive-hud #finish .mrow.bronze i { background: #c98a5b; }
  #drive-hud #finish .mrow.got { color: #e8f0ff; } #drive-hud #finish .mrow.got b { color: #3fd2ff; }
  #drive-hud #finish .fbtns { display: flex; gap: 6px; margin-top: 14px; }
  #drive-hud #finish .fbtns button { flex: 1; background: #121a2e; color: #e8f0ff; border: 1px solid #23304d; padding: 8px 10px; cursor: pointer; font: 700 14px "Barlow Condensed"; text-transform: uppercase; letter-spacing: 0.06em; }
  #drive-hud #finish .fbtns button:hover { border-color: #3fd2ff; color: #3fd2ff; }
  #drive-hud #finish .fbtns button:first-child { border-color: #3fd2ff; color: #3fd2ff; }
`;
const HUD_HTML = `
  <div id="time" class="panel">0.00</div>
  <div id="land" class="panel"></div>
  <div id="cps" class="panel"></div>
  <div id="split" class="panel"></div>
  <div id="finish" class="panel"></div>
  <div id="speed" class="panel"><div class="v" id="kmh">0</div><div class="u">KM/H</div></div>
  <div id="stats" class="panel"></div>
  <div id="help" class="panel"></div>`;

/**
 * The rig: one car (+ ghost car), input, sound, HUD, the frame hook. Made once per page.
 * @param app  the started engine app (startV3App)
 * @param opts.sunShadows  the static-atlas sun shadows (drive page: one track, baked once). Off in the
 *   builder: the track changes between drives, the engine's cascades follow it for free.
 */
export function createDriveRig(app, { prefs = {}, top = 63, substeps = 3, sunShadows: useSunShadows = false, ghost = true, car = "thunder" } = {}) {
  const { scene, camera, renderer } = app;
  const $ = (id) => document.getElementById(id);
  applyCarTune({ TIRE, WHEEL, SOLID, CRASH }, top); // carTune.js: the builder's prediction drives this same car
  CHASE_CAM.fovSpeedRef = top; // "keep matching TIRE.topSpeed"

  // ---------- HUD ----------
  const style = document.createElement("style");
  style.textContent = HUD_CSS;
  document.head.appendChild(style);
  const hud = document.createElement("div");
  hud.id = "drive-hud";
  hud.innerHTML = HUD_HTML;
  document.body.appendChild(hud);

  // ---------- geometry cache (every tile's look, built once) ----------
  const mats = createOldLookMaterials();
  const built = {};
  const ensureBuilt = (id) => {
    if (built[id]) return built[id];
    const t = TILES[id] ?? ensureTile(id);
    return (built[id] = t ? { b: integrate(t), guarded: buildOldLook(t, true), open: buildOldLook(t, false) } : null);
  };
  for (const id of Object.keys(TILES)) ensureBuilt(id);

  // ---------- the car (+ the ghost), loaded once ----------
  const floorH = (x, z) => app.getWorldHeight(x, z);
  const vehicle = new Vehicle({ scene, showArrows: false });
  vehicle.SUBSTEPS = substeps; // per-car: 3 → 1/360 s, keeps travel per substep ≤ the verified 0.25 m up to 90 m/s
  vehicle.getFloorY = floorH; // the floor is solid for the body too
  vehicle.setSolidCapsules([]);
  const parkQuat = new THREE.Quaternion();
  vehicle.setSpawn(PARK, parkQuat);
  vehicle.respawn();
  vehicle.setEnabled(false);
  const chase = createChaseCamera({ camera, vehicle });
  const ghostCar = new Vehicle({ scene, showArrows: false });
  ghostCar.SUBSTEPS = substeps;
  ghostCar.getFloorY = floorH;
  ghostCar.setSolidCapsules([]);
  // no headlights on the ghost: two more spot lights would change the light count and recompile every
  // material (r184), and a ghost does not light the road
  ghostCar.group.traverse((o) => { if (o.isLight) o.visible = false; });
  for (const l of ghostCar.headlights ?? []) l.parent?.remove(l);
  ghostCar.group.visible = false;
  ghostCar.setEnabled(false);
  /** Car meshes cast into the live sun-shadow map (DYNAMIC layer). */
  // ONLY THE CASTERS (performance pass, 2026-10-20): every car mesh was on this layer, so the live shadow map
  // drew the whole car (35 draws) — the Thunderline car casts with its ShadowProxy + tyres only
  // (thunderCar.js castShadow); the Lotus casts as it did
  const adoptCar = (root) => root.traverse((o) => { if (o.isMesh) { if (o.castShadow) o.layers.enable(DYNAMIC_LAYER); else o.layers.disable(DYNAMIC_LAYER); } });
  /**
   * THE GHOST'S LOOK: a bolt-blue HOLOGRAM, one shared material — glowing (additive), bright at its
   * outline (fresnel), faint in the middle, so it reads at once as "not a real car" and never hides
   * the road. Cloning the car's materials translucent came out flat grey (a cloned NodeMaterial drops
   * its map; user: "the ghost looks bad, it looks grey").
   */
  const ghostFresnel = float(1).sub(abs(dot(normalView, positionViewDirection))).pow(2.2);
  const ghostMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
  ghostMat.colorNode = vec3(0.25, 0.82, 1.0).mul(ghostFresnel.mul(1.7).add(0.1));
  ghostMat.opacityNode = ghostFresnel.mul(0.75).add(0.15);
  const ghostify = (root) => root.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = false;
    o.receiveShadow = false;
    o.material = Array.isArray(o.material) ? o.material.map(() => ghostMat) : ghostMat;
  });
  let ghostStyled = false; // the ghost is only shown once it wears its hologram (models loaded)
  // the Lotus is a DEV model only (trademark); it loads in the background, the car drives meanwhile
  // THE CAR: "thunder" = our car (thunderCar.js), "lotus" = the dev Lotus. Same slots, same physics.
  async function dress(v, adopt) {
    if (car === "thunder") {
      // the car file is not in git until it is optimised: without it, the Lotus
      let tc;
      // the ghost wears the light version (thunderCar.js LOD1)
      try { tc = await loadThunderCar(renderer, adopt ? THUNDER_CAR_URL : THUNDER_CAR_LOD1_URL); } catch (e) { console.warn("[drive] Thunderline car not found, using the Lotus", e); return false; }
      if (adopt) adoptCar(tc.chassis.object);
      if (tc.chassis.headlampMounts && adopt) v.setHeadlampMounts(tc.chassis.headlampMounts);
      v.setChassisModel(tc.chassis.object, { brakeLights: tc.chassis.brakeLights, headlampLenses: tc.chassis.headlampLenses });
      v.setChassisStyle("glb");
      if (adopt) adoptCar(tc.wheel.object);
      v.setWheelModel(tc.wheel.object, CAR_TUNE.wheel); // the PHYSICS wheel is the tuned one, whatever the model (thunderCar.js scales its wheel to it)
      v.setWheelStyle("glb");
      return true;
    }
    return false;
  }
  const modelsReady = (async () => {
    try {
      if (!(await dress(vehicle, true))) {
        const m = await loadChassisModel(renderer, CHASSIS_GLB_URL);
        adoptCar(m.object);
        vehicle.setHeadlampMounts(chassisGlbMounts(m.headlampMountsLocal));
        vehicle.setChassisModel(m.object, { brakeLights: m.brakeLights, headlampLenses: m.headlampLenses });
        vehicle.setChassisStyle("glb");
        const w = await loadWheelModel(renderer);
        adoptCar(w.object);
        vehicle.setWheelModel(w.object, CAR_TUNE.wheel);
        vehicle.setWheelStyle("glb");
      }
    } catch (e) {
      console.warn("[drive] car model not loaded, driving the box", e);
    }
    if (!ghost) return;
    try {
      // the ghost: its own copies of the same models, THEN the hologram look (styled before the models
      // arrive, the car's own setup choked on the hologram material)
      if (await dress(ghostCar, false)) { ghostify(ghostCar.group); ghostStyled = true; if (S?.ghostPlayer && showGhost) ghostCar.group.visible = true; return; }
      const gm = await loadChassisModel(renderer, CHASSIS_GLB_URL);
      ghostCar.setChassisModel(gm.object, { brakeLights: gm.brakeLights, headlampLenses: gm.headlampLenses });
      ghostCar.setChassisStyle("glb");
      const gw = await loadWheelModel(renderer);
      ghostCar.setWheelModel(gw.object, CAR_TUNE.wheel);
      ghostCar.setWheelStyle("glb");
      ghostify(ghostCar.group);
      ghostStyled = true;
      if (S?.ghostPlayer && showGhost) ghostCar.group.visible = true;
    } catch (e) {
      console.warn("[ghost] model not loaded: no ghost shown", e);
    }
  })();

  // ---------- input (roadGame.js readControls, same keys and merge) ----------
  const keys = {};
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
  const clearKeys = () => { for (const k of Object.keys(keys)) keys[k] = false; };
  addEventListener("blur", clearKeys);
  document.addEventListener("visibilitychange", clearKeys);
  let autopilot = false;
  // THE FX LAB's hooks: its own driver (drift circles, a wall scrape), slow motion, and the input used
  let inputSource = null, timeScale = 1, lastInput = null;
  let headlightsOn = null; // set from the sun's height (driveFrame)
  let showGhost = ghost && prefs.ghost !== false;

  // ---------- ENGINE SOUND (engineModel.js + engineSound.js, synthesised) + sfx ----------
  // Starts on the first key press / click (browsers allow audio only after a gesture). M mutes; the
  // tab hidden = paused. Sound is OFF unless the settings turned it on (user, 2026-10-19).
  const engine = createEngineModel();
  const engineSound = createEngineSound({ type: prefs.engine ?? "v8", volume: prefs.volume ?? 0.7 });
  let engineMuted = !(prefs.sound ?? false);
  engineSound.setMuted(engineMuted);
  const sfx = createSfx(() => (engineSound.ready ? engineSound.context : null), { volume: prefs.volume ?? 0.7 });
  sfx.setMuted(engineMuted);
  const unlockAudio = () => { if (S && !engineMuted) engineSound.unlock(); };
  addEventListener("pointerdown", unlockAudio);
  document.addEventListener("visibilitychange", () => (document.hidden || !S ? engineSound.suspend() : engineSound.resume()));
  const _nose = new V(), _side = new V();
  let wasBoosting = false, lastCount = 0, fallSpeed = 0;
  function engineTick(dt, input) {
    const { race, rules } = S;
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

  // ---------- HUD helpers ----------
  const HOLD = { steerTarget: 0, rollTarget: 0, throttle: 0, handbrake: true, yaw: 0, pitch: 0, analog: false };
  const COAST = { ...HOLD, handbrake: false };
  const fmt = (t) => {
    if (t == null) return "—";
    const m = Math.floor(t / 60), sec = (t % 60).toFixed(2);
    return m ? `${m}:${sec.padStart(5, "0")}` : sec;
  };
  let splitTimer = null, landTimer = null;
  function flashSplit(html, cls) {
    const el = $("split");
    el.innerHTML = html;
    el.className = `panel show ${cls}`;
    clearTimeout(splitTimer);
    splitTimer = setTimeout(() => el.classList.remove("show"), 1800);
  }
  function showLanding(ev) {
    S.landings.push({ grade: ev.grade, err: Math.round(ev.err), air: +ev.air.toFixed(1), t: +S.runTime.toFixed(2) });
    const el = $("land");
    const label = { perfect: "Perfect landing", ok: "Landed", rough: "Rough landing" }[ev.grade];
    const tail = ev.grade === "perfect" ? "boost" : ev.grade === "rough" ? "−15% speed" : "land flat for a boost";
    el.innerHTML = `${label}<small>${Math.round(ev.err)}° · ${ev.air.toFixed(1)} s air · ${tail}</small>`;
    el.className = `panel show ${ev.grade}`;
    clearTimeout(landTimer);
    landTimer = setTimeout(() => el.classList.remove("show"), 1400);
  }
  const MEDAL_NAMES = { author: "Author", gold: "Gold", silver: "Silver", bronze: "Bronze" };

  // ---------- the session (one per drive) ----------
  let S = null; // the running session, or null (building / menu)
  let sunShadows = null;

  /**
   * Start driving a track.
   * @param o.track  { pieces, authorTime } (a library / campaign record's track), or null = the built-in test track
   * @param o.campaignRec / o.trackId  where a finish is recorded
   * @param o.buttons  finish-screen buttons after "Again": [{ label, key (shown), code? (KeyboardEvent.code, default Key<key>), run }]
   * @param o.onEscape  Esc while driving
   * @param o.help  the help line (HTML)
   */
  async function start(o = {}) {
    if (S) stop();
    const track = o.track?.pieces?.length ? o.track : null;
    const roadPieces = (track?.pieces ?? []).filter((p) => !p.ring);
    const ringGates = (track?.pieces ?? []).filter((p) => p.ring).map((p) => {
      const M = new THREE.Matrix4().fromArray(p.M);
      return { P: new V().setFromMatrixPosition(M), T: new V(0, 0, -1).transformDirection(M), U: new V(0, 1, 0).transformDirection(M), r: 5.5 };
    });
    // generated pieces (fitted landings) are rebuilt from their id, exactly as the builder made them
    for (const p of track?.pieces ?? []) ensureBuilt(p.id);
    const jumpSpeed = o.jumpSpeed ?? top * 0.91;
    const lay = track
      ? layoutFromPlacements({ built, pieces: roadPieces })
      : layoutTestTrack({ built, speed: jumpSpeed, jumpSpeeds: o.jumpSpeeds ?? [55.8, 48.6, 50.6], airDrag: AERO.drag / CHASSIS.mass });
    const group = new THREE.Group();
    // THE RUN-OUT: past the finish the road goes on for 3 straights (drawn and solid, not part of the
    // race), and the car brakes by itself (driveFrame): it used to fly off the track's end after the line
    const runout = [];
    const lastP = lay.placements.at(-1);
    // (not after a FINISH piece: its own 72 m stub is the run-out, and its nose ends it)
    if (track && lastP && !o.from && !TILES[lastP.id]?.finish) {
      const t = TILES[lastP.id], b = built[lastP.id].b;
      const exit = lastP.M.clone().multiply(socketMatrix(b.exit));
      const dir = new V(0, 0, -1).transformDirection(exit);
      // only after a level, unbanked end (a lip flies on; a banked end would need a bank-out)
      if (Math.abs(dir.y) < 0.05 && Math.abs(leanOut(t)) < 0.01 && !t.drop) {
        const L = built.straight_64.b.L;
        for (let i = 0; i < 3; i++) runout.push({ id: "straight_64", open: lastP.open, M: exit.clone().multiply(new THREE.Matrix4().makeTranslation(0, 0, -L * i)) });
      }
    }
    const solidPlacements = [...lay.placements, ...runout];
    const meshes = buildTrackMeshes(solidPlacements, built, mats);
    meshes.group.traverse((m) => { if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; m.layers.enable(STATIC_LAYER); } });
    group.add(meshes.group);

    // ---------- THE RACE (race.js, DESIGN.md §8): gates, checkpoints in any order, finish, medals ----------
    // a practice run from a piece has only the finish: the checkpoints behind it can't be taken
    const flagged = o.from ? []
      : track ? roadPieces.map((p, k) => (p.cp ? k : -1)).filter((k) => k >= 0)
      : lay.placements.map((p, k) => (/landing|catch_pad/.test(p.id) ? k : -1)).filter((k) => k >= 0);
    const hwOf = (k) => SECTIONS[TILES[lay.placements[k]?.id]?.section ?? "road"].hw;
    // START / FINISH pieces (oldTiles.js): the start line past the Start's nose, the finish line at the
    // Finish's entry (its stub is where the car brakes); without them, as before
    const startT = TILES[lay.placements[0]?.id]?.start ?? null;
    const finK = lay.placements.length - 1, finT = TILES[lay.placements[finK]?.id]?.finish ?? null;
    const finR = finT ? lay.ride.find((r) => r.piece === finK && !r.air) : null;
    const finishAt = finR ? { P: finR.P.clone().addScaledVector(finR.T, finT.line), T: finR.T.clone(), U: finR.U ?? new V(0, 1, 0), piece: finK } : null;
    const gates = gatesFor(lay.ride, flagged, hwOf, o.from ? [] : ringGates, finishAt);
    const r0 = lay.ride[0];
    for (const g of [{ kind: "start", P: r0.P.clone().addScaledVector(r0.T, startT ? startT.line : 6), T: r0.T.clone(), U: r0.U ?? new V(0, 1, 0), hw: hwOf(0) }, ...gates]) group.add(makeGateMesh(g));
    scene.add(group);
    const race = createRace({ gates, countdown: o.from ? 0.3 : 1.5 });
    // the track's identity for records: its pieces, links and flags (DESIGN.md §8 keys records by content)
    const trackKey = track ? contentKey(track) : "test";
    const medals = medalTimes(track?.authorTime);
    const BEST_KEY = `thunderline.best.${trackKey}`;
    let best = null;
    try { best = JSON.parse(localStorage.getItem(BEST_KEY)); } catch {}

    // ---------- collision: deck BVH (wheels) + solids BVH (chassis vs rails) ----------
    const asCollider = (geometry, M, userData = {}) => ({ geometry, matrixWorld: M, userData, updateMatrixWorld() {} });
    const decks = [], solids = [];
    for (const p of solidPlacements) {
      const look = p.open ? built[p.id].open : built[p.id].guarded;
      const t = TILES[p.id];
      // the left-hand mirrors ("…_L") are the same pieces: they need the same tags
      decks.push(asCollider(look.deck, p.M, { roadHold: ROAD_HOLD.has(p.id.replace(/_L$/, "")) || !!t?.roadHold, freeCarve: !!t?.freeCarve }));
      if (look.railCollision) solids.push(asCollider(look.railCollision, p.M));
    }
    // OBSTACLES (obstacles.js): fixed ones join the trees; movers are posed from the race clock each tick
    const obstacles = buildObstacleSet(track?.props ?? []);
    group.add(obstacles.group);
    obstacles.group.traverse((m) => { if (m.isMesh) m.layers.enable(DYNAMIC_LAYER); });
    for (const d of obstacles.decks) decks.push(asCollider(d.geometry, d.M));
    for (const s of obstacles.solids) solids.push(asCollider(s.geometry, s.M));
    vehicle.setDynamicMovers(obstacles.movers);
    ghostCar.setDynamicMovers(obstacles.movers);
    const t0 = performance.now();
    const deckBvh = new RoadBvh(), solidsBvh = new RoadBvh();
    const ground = createVehicleGround({ getTerrainHeight: floorH });
    deckBvh.bakeFromMeshes(decks);
    ground.setRoadBvh(deckBvh.baked ? deckBvh : null);
    solidsBvh.bakeFromMeshes(solids);
    ground.setRoadSolidsBvh(solidsBvh.baked ? solidsBvh : null);
    const bakeMs = performance.now() - t0;
    vehicle.setBvh(ground.ground, ground.solids);
    ghostCar.setBvh(ground.ground, ground.solids);
    let lowestY = Infinity;
    for (const r of lay.ride) lowestY = Math.min(lowestY, r.P.y);
    const startPos = new V().setFromMatrixPosition(lay.start);
    const startFwd = new V(0, 0, -1).transformDirection(lay.start);
    let startQuat = new THREE.Quaternion().setFromAxisAngle(new V(0, 1, 0), Math.atan2(startFwd.x, startFwd.z)); // car forward = +Z
    let spawnPos = startPos.clone().addScaledVector(startFwd, startT ? startT.spawn : 12).add(new V(0, SPAWN_LIFT, 0));
    if (o.from) {
      // PRACTICE FROM A PIECE (Trackmania's "test from here"): standing on that piece's start, its slope
      // and bank included (piece frame: −Z along the road; the car's nose is +Z)
      const fwd = new V(0, 0, -1).transformDirection(o.from), up = new V(0, 1, 0).transformDirection(o.from);
      startQuat = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().extractRotation(o.from)).multiply(new THREE.Quaternion().setFromAxisAngle(new V(0, 1, 0), Math.PI));
      spawnPos = new V().setFromMatrixPosition(o.from).addScaledVector(fwd, 4).addScaledVector(up, SPAWN_LIFT);
    }

    // ---------- THE CAR'S RULES (carRules.js): wall cut, landing judge + boost, boost pads, magnets ----------
    const boostPads = lay.placements.filter((p) => p.id.startsWith("boost")).map((p) => p.M.clone().invert());
    const magnets = magnetZones(lay.placements, TILES, integrate);
    const rules = createCarRules(vehicle, { boostPads, magnets });
    const ghostRules = createCarRules(ghostCar, { boostPads, magnets });
    const pilot = createAutopilot(avoidObstacles(lay.ride, track?.props)); // autopilot.js (shared with the builder's prediction and the tests), its line round the obstacles
    const GHOST_KEY = `thunderline.ghost.${trackKey}`;
    let ghostData = null;
    try { ghostData = JSON.parse(localStorage.getItem(GHOST_KEY)); } catch {}

    S = {
      o, lay, group, race, gates, trackKey, medals, BEST_KEY, GHOST_KEY, best, bakeMs, rules, ghostRules, pilot, ghostData,
      ghostPlayer: null, recorder: createGhostRecorder(), landings: [], startQuat, spawnPos,
      KILL_Y: o.killY ?? lowestY - 50, safe: { pos: spawnPos.clone(), quat: startQuat.clone(), ok: false }, // killY: the FX lab drives on the floor
      simAccum: 0, runTime: 0, topKmh: 0, recoveries: 0, lastBackspace: -1e9, frame: 0, adoptCount: 0, physMs: [],
      obstacles, moverT: 0, meshes, // the movers' RACE clock: 0 at the green light, held through the countdown
    };
    $("help").innerHTML = o.help ?? `<kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> / arrows drive · <kbd>Space</kbd> handbrake · in the air: <kbd>Shift</kbd>/<kbd>Ctrl</kbd> pitch, <kbd>Q</kbd>/<kbd>E</kbd> spin, <kbd>Z</kbd>/<kbd>X</kbd> roll · <kbd>Backspace</kbd> last checkpoint · <kbd>R</kbd> restart`;
    hud.classList.add("on");

    // ---------- sun shadows (drive page only): static atlas of this track + live map around the car ----------
    if (useSunShadows && !sunShadows) await bakeSunShadows(lay);
    restart();
    return S;
  }

  /**
   * The track's SUN SHADOWS, baked for the sun as it is now (its direction lays the atlas out). Again
   * whenever the sun moves (the FX lab's light buttons): the old maps are freed once the new one is in.
   */
  async function bakeSunShadows(lay) {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); // let the sun settle for the time of day
    const pts = [], tmp = new V();
    for (const p of lay.placements) {
      const look = p.open ? built[p.id].open : built[p.id].guarded;
      for (const g of [look.deck, look.rail]) {
        if (!g) continue;
        const a = g.getAttribute("position");
        for (let i = 0; i < a.count; i += 6) pts.push(tmp.fromBufferAttribute(a, i).applyMatrix4(p.M).clone());
      }
    }
    scene.updateMatrixWorld(true);
    const old = sunShadows;
    S?.meshes?.fullDetail(true); // the bake sees every post, whatever the camera picked
    sunShadows = createSunShadows({ renderer, scene, sunDir: app.light.getDirection().clone(), casterPoints: pts });
    sunShadows.stats.bakeMs = Math.round(sunShadows.bake());
    S?.meshes?.fullDetail(false);
    // the engine's opt-in hook: our node IS the sun's shadow term; the cascades leave the scene
    app.shadows.setSunShadowNode(sunShadows.visibility);
    old?.atlasRT?.dispose?.();
    old?.liveRT?.dispose?.();
    console.info("[drive] sun shadows", sunShadows.stats);
  }

  /** Stop driving: the track's meshes leave, the car parks, the HUD hides. */
  function stop() {
    if (!S) return;
    scene.remove(S.group); // its geometries are the shared tile cache: kept for the next drive
    vehicle.setDynamicMovers([]);
    ghostCar.setDynamicMovers([]);
    clearTimeout(splitTimer);
    clearTimeout(landTimer);
    $("finish").classList.remove("show");
    hud.classList.remove("on");
    vehicle.setEnabled(true);
    vehicle.respawnAt(PARK.clone(), parkQuat.clone());
    vehicle.body.vel.set(0, 0, 0);
    vehicle.syncVisuals(0, 0);
    vehicle.setEnabled(false);
    ghostCar.setEnabled(false);
    ghostCar.group.visible = false;
    engineSound.suspend();
    clearKeys();
    autopilot = false;
    S = null;
  }

  function startGhost() {
    // (no ghost on a practice run from a piece: it starts somewhere else)
    S.ghostPlayer = S.ghostData?.inputs?.length && !S.o.from ? createGhostPlayer(ghostCar, S.ghostRules, S.ghostData) : null;
    ghostCar.group.visible = !!S.ghostPlayer && showGhost && ghostStyled;
    if (S.ghostPlayer) S.ghostPlayer.start(S.spawnPos, S.startQuat);
    else ghostCar.setEnabled(false);
  }
  function restart() {
    engine.reset();
    S.race.reset();
    $("finish").classList.remove("show");
    vehicle.setEnabled(true); // parked after a finish
    S.rules.reset();
    S.recorder.start();
    S.landings.length = 0;
    S.pilot.reset();
    vehicle.setSpawn(S.spawnPos, S.startQuat);
    vehicle.respawn();
    startGhost();
    chase.reset();
    S.simAccum = 0;
    S.runTime = 0;
    S.moverT = 0;
    S.obstacles.setTime(0);
    S.topKmh = 0;
    S.safe.pos.copy(S.spawnPos);
    S.safe.quat.copy(S.startQuat);
    if (!engineMuted) engineSound.resume();
  }
  // CHECKPOINT RESPAWN (DESIGN.md §8): Backspace = back to the last checkpoint at the speed you had
  // there; again within 1.5 s = the same spot standing; no checkpoint yet = the start, standing.
  function respawnCheckpoint() {
    const now = performance.now();
    const standing = now - S.lastBackspace < 1500;
    S.lastBackspace = now;
    const cp = S.race.s.last;
    const pos = cp ? cp.pos.clone() : S.spawnPos.clone();
    const quat = cp ? cp.quat.clone() : S.startQuat.clone();
    vehicle.respawnAt(pos, quat);
    if (cp && !standing) vehicle.body.vel.copy(cp.vel);
    S.race.teleported(vehicle.body.pos);
    S.rules.reset();
    S.recorder.respawn(vehicle);
    S.pilot.reset();
    chase.reset();
    S.simAccum = 0;
    S.recoveries++;
  }
  function recoverToSafe() {
    S.rules.reset();
    S.recoveries++;
    vehicle.respawnAt(S.safe.pos.clone().add(new V(0, 0.5, 0)), S.safe.quat.clone());
    S.race.teleported(vehicle.body.pos);
    S.recorder.respawn(vehicle);
    chase.reset();
    S.simAccum = 0;
  }
  function checkFall() {
    const p = vehicle.body.pos;
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return restart();
    // a fall goes back to the last checkpoint (keeping its speed: DESIGN.md §8), or restarts
    if (p.y < S.KILL_Y) {
      // after the finish the road ends: park the car under the finish screen instead of restarting
      if (S.race.s.state === "finished") { vehicle.setEnabled(false); return; }
      return S.race.s.state === "running" ? respawnCheckpoint() : restart();
    }
    if (STUCK?.enabled && vehicle.isBeached && vehicle.stuckTime >= STUCK.respawnAfter) return recoverToSafe();
  }

  function onRace(e) {
    if (e.type === "go") sfx.beep("go");
    if (e.type === "cp") sfx.beep("cp");
    if (e.type === "finish") sfx.beep("finish");
    if (e.type === "missing") sfx.beep("miss");
    if (e.type === "cp") {
      // split against the best run's time at the same checkpoint
      const b = S.best?.splits?.find((s) => s.gate === e.gate);
      const diff = b ? e.time - b.time : null;
      const tail = diff != null ? ` <small class="${diff <= 0 ? "ahead" : "behind"}">${diff <= 0 ? "−" : "+"}${Math.abs(diff).toFixed(2)}</small>` : "";
      flashSplit(`CP ${e.n}/${e.of} · ${fmt(e.time)}${tail}`, "cp");
    } else if (e.type === "missing") {
      flashSplit(`${e.n} checkpoint${e.n > 1 ? "s" : ""} missed — take them all`, "miss");
    } else if (e.type === "finish" && S.o.from) {
      showFinish(e.time, false, true); // practice: nothing is recorded
    } else if (e.type === "finish") {
      const improved = !S.best || e.time < S.best.time;
      if (improved) {
        S.best = { time: e.time, splits: S.race.s.splits.slice() };
        try { localStorage.setItem(S.BEST_KEY, JSON.stringify(S.best)); } catch {}
        // the new best becomes the ghost (from the next restart)
        S.ghostData = S.recorder.finish(e.time);
        try { localStorage.setItem(S.GHOST_KEY, JSON.stringify(S.ghostData)); } catch (err) { console.warn("[ghost] not saved", err); }
      }
      const medal = medalFor(e.time, S.medals);
      if (S.o.campaignRec) campaign.recordFinish(S.o.campaignRec, e.time, medal);
      else if (S.o.trackId) library.recordFinish(S.o.trackId, e.time, medal);
      showFinish(e.time, improved);
    }
  }
  function showFinish(time, improved, practice = false) {
    const m = practice ? null : medalFor(time, S.medals);
    const rows = practice
      ? `<div class="mrow">Practice from a piece: no medal, nothing recorded</div>`
      : S.medals
        ? ["author", "gold", "silver", "bronze"].map((k) => `<div class="mrow ${k}${m === k ? " got" : ""}"><i></i>${MEDAL_NAMES[k]}<b>${fmt(S.medals[k])}</b></div>`).join("")
        : `<div class="mrow">No author time yet: let the builder's test lap reach the finish</div>`;
    const head = practice ? "Practice" : m ? `${MEDAL_NAMES[m]} medal` : S.medals ? "No medal" : "Finished";
    const buttons = S.o.buttons ?? [];
    $("finish").innerHTML =
      `<div class="ft">${fmt(time)}</div>` +
      `<div class="fm">${head}${practice ? "" : improved ? " · new best" : ` · best ${fmt(S.best?.time)}`}</div>` +
      rows +
      `<div class="fbtns"><button data-b="again">Again <kbd>R</kbd></button>` +
      buttons.map((b, i) => `<button data-b="${i}">${b.label} <kbd>${b.key}</kbd></button>`).join("") + `</div>`;
    for (const el of $("finish").querySelectorAll("button")) el.onclick = () => (el.dataset.b === "again" ? restart() : buttons[+el.dataset.b].run());
    $("finish").classList.add("show");
  }

  // ---------- keys (only while a session runs) ----------
  addEventListener("keydown", (e) => {
    if (!S) return;
    keys[e.code.toLowerCase()] = true;
    unlockAudio();
    if (e.code === "Backspace") { respawnCheckpoint(); e.preventDefault(); }
    if (e.code === "KeyR" || e.code === "Delete") restart();
    if (e.code === "KeyP") { autopilot = !autopilot; S.pilot.reset(); }
    if (e.code === "KeyG") { showGhost = !showGhost; ghostCar.group.visible = !!S.ghostPlayer && showGhost && ghostStyled; }
    if (e.code === "KeyM") { engineMuted = !engineMuted; engineSound.setMuted(engineMuted); sfx.setMuted(engineMuted); if (!engineMuted) engineSound.unlock(); }
    if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Tab"].includes(e.code)) e.preventDefault();
    // these may end the session (back to the builder, the menu, the next track): last
    const o = S.o;
    if (e.code === "Escape") return o.onEscape?.();
    if ($("finish").classList.contains("show")) for (const b of o.buttons ?? []) if (e.code === (b.code ?? `Key${b.key}`)) return b.run();
  });
  addEventListener("keyup", (e) => { keys[e.code.toLowerCase()] = false; });

  // ---------- the sim loop (roadGame.js:9904), in the engine's frame: before it reads the camera ----------
  let last = performance.now();
  function renderStats() {
    const { lay } = S;
    $("stats").innerHTML =
      `track <b>${(lay.length / 1000).toFixed(2)} km</b> · <b>${lay.placements.length}</b> pieces<br>` +
      `collision bake <b>${S.bakeMs.toFixed(0)} ms</b> · wheels down <b>${vehicle.groundedCount}/4</b><br>` +
      `top speed this run <b>${Math.round(S.topKmh)} km/h</b>` +
      (lay.warnings.length ? `<br><span style="color:#ff4d5e">${lay.warnings.join("<br>")}</span>` : "");
  }
  app.addPreUpdateHook(function driveFrame() {
    const now = performance.now();
    const dt = Math.min((now - last) / 1000, 0.05) * timeScale;
    last = now;
    if (!S) return;
    const { race, rules, recorder } = S;
    const input = (lastInput = inputSource ? inputSource(vehicle, S) : autopilot ? S.pilot.input(vehicle) : readControls());
    if (padRespawn) respawnCheckpoint();
    S.simAccum += dt;
    let ticks = Math.floor(S.simAccum / FIXED_DT);
    if (ticks > MAX_SIM_TICKS) { ticks = MAX_SIM_TICKS; S.simAccum = ticks * FIXED_DT; }
    S.simAccum -= ticks * FIXED_DT;
    const tPhys = performance.now();
    for (let i = 0; i < ticks; i++) {
      // NO ENGINE UP A WALL, the clean-landing boost, boost pads, magnets: carRules.step, which the
      // ghost replays too. The countdown holds the car on the line.
      // after the finish the car brakes by itself on the run-out (no input: not part of the run)
      // the movers first: the car meets them where the race clock says they are (the ghost, the same)
      if (!race.holding) S.moverT += FIXED_DT;
      S.obstacles.setTime(S.moverT);
      const used = race.holding ? HOLD : race.s.state === "finished" ? COAST : input;
      if (race.s.state === "finished" && vehicle.groundedCount > 0) vehicle.body.vel.multiplyScalar(Math.exp(-1.1 * FIXED_DT));
      const landed = rules.step(used, FIXED_DT);
      if (race.s.state !== "finished") recorder.tick(used, vehicle);
      if (landed) { showLanding(landed); sfx.landing(landed, fallSpeed); }
      if (vehicle.groundedCount === 0) fallSpeed = Math.max(0, -vehicle.body.vel.y); // how hard the next landing hits
      for (const e of race.tick(vehicle, FIXED_DT)) { onRace(e); if (!S) return; }
      if (S.ghostPlayer) S.ghostPlayer.tick(FIXED_DT);
      S.runTime += FIXED_DT;
      if (vehicle.groundedCount >= 3) { S.safe.pos.copy(vehicle.body.pos); S.safe.quat.copy(vehicle.body.quat); S.safe.ok = true; }
    }
    if (ticks) S.physMs.push((performance.now() - tPhys) / ticks);
    if (S.physMs.length > 240) S.physMs.shift();
    vehicle.syncVisuals(dt, S.simAccum / FIXED_DT);
    engineTick(dt, input);
    if (S.ghostPlayer) {
      if (S.ghostPlayer.done) ghostCar.group.visible = false;
      else if (showGhost) ghostCar.syncVisuals(dt, S.simAccum / FIXED_DT);
    }
    if (sunShadows) {
      // the car's model arrives late: re-adopt its group a few times so late children cast too
      if (S.adoptCount++ % 60 === 0 && S.adoptCount < 1200) adoptCar(vehicle.group);
      sunShadows.follow(vehicle.renderPos);
    }
    checkFall();
    chase.update(dt);
    S.meshes.updateLod(camera); // the posts' detail, from the game camera (testTrack.js)
    app.controls.target.copy(vehicle.renderPos);
    const kmh = Math.abs(vehicle.speedKmh ?? vehicle.body.vel.length() * 3.6);
    S.topKmh = Math.max(S.topKmh, kmh);
    $("kmh").textContent = Math.round(kmh);
    const rs = race.s;
    $("time").textContent = rs.state === "countdown" ? String(Math.ceil(rs.hold * 2)) : fmt(rs.state === "finished" ? rs.finishTime : rs.time);
    $("cps").textContent = race.cps.length ? `CP ${rs.taken.size}/${race.cps.length}` : "no checkpoints";
    $("cps").classList.toggle("boost", rules.boostLeft > 0);
    if (++S.frame % 15 === 0) renderStats();
    // HEADLIGHTS ON when the sun is low (user, 2026-10-20: "we don't have the car lights" at dusk) — a
    // uniform write in the car (setHeadlights), so checking twice a second costs nothing
    if (S.frame % 30 === 1) {
      const on = app.light.getDirection().y < Math.sin(12 * Math.PI / 180);
      if (on !== headlightsOn) { headlightsOn = on; vehicle.setHeadlights(on); }
    }
  });

  return {
    start, stop, restart, respawnCheckpoint, recoverToSafe, modelsReady,
    get active() { return !!S; }, get session() { return S; },
    vehicle, ghostCar, chase, keys, engine, engineSound, sfx, camera,
    get sunShadows() { return sunShadows; },
    setAuto(on) { autopilot = on; S?.pilot.reset(); if (S) S.recoveries = 0; },
    /** fn(vehicle, session) → input, or null for the player / autopilot again */
    setInputSource(fn) { inputSource = fn; },
    setTimeScale(k) { timeScale = k; },
    /** Re-bake the sun shadows for the sun as it is now (after a time-of-day change). */
    async rebakeSunShadows() { if (useSunShadows && S) await bakeSunShadows(S.lay); },
    get timeScale() { return timeScale; },
    get lastInput() { return lastInput; },
    config: { TOP: top, SUBSTEPS: substeps },
  };
}
