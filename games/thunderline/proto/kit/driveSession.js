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
import { createDebugCamera } from "../../../modular-road-v3/debugCamera.js";
import { createGamepadInput } from "../../../modular-road-v3/gamepadInput.js";
import { loadChassisModel, CHASSIS_GLB_URL, chassisGlbMounts } from "../../../modular-road-v3/chassisModel.js";
import { loadWheelModel } from "../../../modular-road-v3/wheelModel.js";
import { TILES, integrate, ensureTile, SECTIONS, socketMatrix, leanOut } from "./kit.js";
import { gatesFor, createRace, medalTimes, medalFor } from "./race.js";
import { makeGateMesh } from "./gateMesh.js";
import { library, campaign, contentKey, settings } from "../../app/library.js";
import { ghosts } from "../../app/ghostStore.js";
import { createAutopilot } from "./autopilot.js";
import { applyCarTune, CAR_TUNE } from "./carTune.js";
import { createCarRules, magnetZones, wallCutZones } from "./carRules.js";
import { createGhostRecorder, createGhostPlayer } from "./ghost.js";
import { createEngineModel } from "./engineModel.js";
import { createEngineSound } from "./engineSound.js";
import { createEngineLoops, isLoopEngine } from "./engineLoops.js";
import { createSfx } from "./sfx.js";
import { createSfxSamples, GAME_PICK } from "./sfxSamples.js";
import { buildOldLook, createOldLookMaterials, edgesOf, lookKey } from "./oldLook.js";
import { layoutTestTrack, layoutFromPlacements, buildTrackMeshes } from "./testTrack.js";
import { createSunShadows, STATIC_LAYER, DYNAMIC_LAYER } from "./sunShadows.js";
import { loadThunderCar, THUNDER_CAR_URL, THUNDER_CAR_LOD1_URL } from "./thunderCar.js";
import { buildObstacleSet, avoidObstacles, boostZones } from "./obstacles.js";
import { createSparks } from "./sparks.js";
import { createPhysProps } from "./physProps.js";
import { createTyreMarks } from "./tyreMarks.js";
import { createLandingFx } from "./landingFx.js";
import { createTyreSmoke } from "./tyreSmoke.js";

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
  #drive-hud #snd { right: 18px; top: 16px; padding: 7px 9px; cursor: pointer; border-left-color: #23304d; line-height: 0; }
  #drive-hud #snd svg { width: 22px; height: 22px; color: #8796b5; }
  #drive-hud #snd.on { border-left-color: #3fd2ff; } #drive-hud #snd.on svg { color: #3fd2ff; }
  #drive-hud #snd:hover svg { color: #e8f0ff; }
  #drive-hud #back { right: 66px; top: 16px; padding: 9px 12px; cursor: pointer; border-left-color: #23304d; color: #8796b5; font: 700 14px/18px "Barlow Condensed"; letter-spacing: 0.08em; text-transform: uppercase; }
  #drive-hud #back:hover { color: #e8f0ff; border-left-color: #3fd2ff; }
  #drive-hud #back kbd { margin-left: 6px; }
  #drive-hud #freecam { left: 50%; top: 70px; transform: translateX(-50%); text-align: center; display: none; color: #8796b5; font-size: 12px; }
  #drive-hud #freecam.show { display: block; }
  #drive-hud #freecam b { color: #3fd2ff; font: 800 14px "Barlow Condensed"; letter-spacing: 0.08em; margin-right: 8px; }
`;
const HUD_HTML = `
  <div id="time" class="panel">0.00</div>
  <div id="land" class="panel"></div>
  <div id="cps" class="panel"></div>
  <div id="split" class="panel"></div>
  <div id="finish" class="panel"></div>
  <div id="speed" class="panel"><div class="v" id="kmh">0</div><div class="u">KM/H</div></div>
  <div id="stats" class="panel"></div>
  <div id="help" class="panel"></div>
  <div id="back" class="panel"></div>
  <div id="snd" class="panel" title="Sound on / off (M)"></div>
  <div id="freecam" class="panel"></div>`;
// the sound button's icon: a speaker, with waves (on) or a cross (off)
const SND_ICON = (on) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h4l5 4V5L8 9z" fill="currentColor"/>${on ? '<path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/>' : '<path d="M17 9l5 6M22 9l-5 6"/>'}</svg>`;

/**
 * The rig: one car (+ ghost car), input, sound, HUD, the frame hook. Made once per page.
 * @param app  the started engine app (startV3App)
 * @param opts.sunShadows  the static-atlas sun shadows (drive page: one track, baked once). Off in the
 *   builder: the track changes between drives, the engine's cascades follow it for free.
 */
export function createDriveRig(app, { prefs = {}, top = 63, substeps = 3, sunShadows: useSunShadows = false, ghost = true, car = "thunder", fx = true } = {}) {
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
  // a placement's look by its edges (both rails, none, one side — the one-sided ones built on first use)
  const lookFor = (p) => {
    const e = edgesOf(p), k = lookKey(e), B = ensureBuilt(p.id);
    return (B[k] ??= buildOldLook(TILES[p.id], e));
  };

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
  /**
   * THE GHOST'S BODY IN ONE DRAW (performance pass, 2026-10-22: the Lotus ghost was the full model, interior
   * and all — 18 draws, 77k triangles — under ONE shared hologram material). Every visible body mesh is
   * baked into a single float mesh (positions + normals: all the hologram reads), the originals hidden:
   * - the INTERIOR is left out (cab, seats, wheel, door cards: through an additive hologram, only clutter);
   * - the ShadowProxy hull is left out (it only casts shadows; the ghost casts none);
   * - built from three's accessors, not mergeGeometries: the Lotus GLB is QUANTISED (int16 positions) and a
   *   merged int16 buffer has a 6-byte stride WebGPU refuses (memory: merge-geometries gotchas).
   * The wheels stay separate (they spin).
   */
  const GHOST_SKIP = /(_int|interior|steering|cab_|glass|lens)/i;
  /** The visible body meshes under `root` baked into ONE float geometry in the frame `inv` maps world into
   * (interior, glass and the ShadowProxy left out); `hide` hides the originals. */
  // (instanced: `instances` also takes an InstancedMesh's copies — the WHEELS are instanced, one mesh per
  // wheel part with four copies: the test car's hologram had none, 2026-10-23)
  function bakeCar(root, inv, hide, near = null, instances = false) {
    const parts = []; // { o, world }
    const _w = new THREE.Vector3(), _im = new THREE.Matrix4();
    root.traverse((o) => {
      if (!o.isMesh || !o.visible || o.name === "GhostBody") return;
      if (o.isInstancedMesh) {
        if (!instances) return;
        for (let i = 0; i < o.count; i++) {
          o.getMatrixAt(i, _im);
          const world = o.matrixWorld.clone().multiply(_im);
          if (near && _w.setFromMatrixPosition(world).distanceTo(near) > 6) continue;
          parts.push({ o, world });
        }
        return;
      }
      if (near && o.getWorldPosition(_w).distanceTo(near) > 6) return; // (helpers drawn in world space)
      const names = [o.name, o.parent?.name, ...[].concat(o.material).map((m) => m?.name)].join(" ");
      if (/ShadowProxy/i.test(names) || GHOST_SKIP.test(names)) { if (hide) o.visible = false; return; }
      parts.push({ o, world: o.matrixWorld });
    });
    let nv = 0, ni = 0;
    for (const { o } of parts) { nv += o.geometry.attributes.position.count; ni += o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count; }
    const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), idx = new Uint32Array(ni);
    const p = new THREE.Vector3(), n = new THREE.Vector3(), M = new THREE.Matrix4(), N = new THREE.Matrix3();
    let vo = 0, io = 0;
    for (const { o, world } of parts) {
      const g = o.geometry, P = g.attributes.position, Nn = g.attributes.normal;
      M.multiplyMatrices(inv, world);
      N.getNormalMatrix(M);
      for (let i = 0; i < P.count; i++) {
        p.fromBufferAttribute(P, i).applyMatrix4(M);
        pos.set([p.x, p.y, p.z], (vo + i) * 3);
        if (Nn) { n.fromBufferAttribute(Nn, i).applyMatrix3(N).normalize(); nor.set([n.x, n.y, n.z], (vo + i) * 3); }
      }
      if (g.index) for (let i = 0; i < g.index.count; i++) idx[io++] = g.index.getX(i) + vo;
      else for (let i = 0; i < P.count; i++) idx[io++] = i + vo;
      vo += P.count;
      if (hide && !o.isInstancedMesh) o.visible = false;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeBoundingSphere();
    return geo;
  }
  function mergeGhostBody(v) {
    const root = v._chassisGlb;
    if (!root) return 0;
    root.updateMatrixWorld(true);
    const body = new THREE.Mesh(bakeCar(root, root.matrixWorld.clone().invert(), true), ghostMat);
    body.name = "GhostBody";
    root.add(body);
    return 1;
  }
  /**
   * THE CAR AS A HOLOGRAM for the builder's TEST CAR (user, 2026-10-22: "spawn the car anywhere … use a ghost
   * car for that"): the parked car (body + wheels) baked into one geometry in the PIECE frame — −Z forward
   * (the car's nose), the tyres' bottom at y 0 — so it stands on a road frame as it is. Null while driving
   * or before the model is in. One shared hologram material (the ghost's).
   */
  function carHologram() {
    if (S || !vehicle._chassisGlb) return null;
    vehicle.setEnabled(true);
    vehicle.respawnAt(PARK.clone(), parkQuat.clone());
    vehicle.body.vel.set(0, 0, 0);
    vehicle.syncVisuals(0, 0);
    vehicle.setEnabled(false);
    vehicle.group.updateMatrixWorld(true);
    const frame = new THREE.Matrix4().compose(vehicle.body.pos, vehicle.body.quat, new V(1, 1, 1)); // (renderPos is stale while parked)
    const geo = bakeCar(vehicle.group, frame.invert(), false, vehicle.body.pos, true);
    // only the car itself (the group also holds helpers drawn in world space far away)
    geo.computeBoundingBox();
    if (geo.boundingBox.max.length() > 8) return null;
    geo.rotateY(Math.PI); // the car's +Z nose → the piece frame's −Z
    geo.translate(0, -geo.boundingBox.min.y, 0);
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    return { geometry: geo, material: ghostMat };
  }
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
      if (await dress(ghostCar, false)) { mergeGhostBody(ghostCar); ghostify(ghostCar.group); ghostStyled = true; if (S?.ghostPlayer && showGhost) ghostCar.group.visible = true; return; }
      const gm = await loadChassisModel(renderer, CHASSIS_GLB_URL);
      ghostCar.setChassisModel(gm.object, { brakeLights: gm.brakeLights, headlampLenses: gm.headlampLenses });
      ghostCar.setChassisStyle("glb");
      const gw = await loadWheelModel(renderer);
      ghostCar.setWheelModel(gw.object, CAR_TUNE.wheel);
      ghostCar.setWheelStyle("glb");
      mergeGhostBody(ghostCar);
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
  let padRespawn = false, padRestart = false;
  function readControls() {
    const kbSteer = (keys.keya || keys.arrowleft ? 1 : 0) - (keys.keyd || keys.arrowright ? 1 : 0);
    const kbThrottle = (keys.keyw || keys.arrowup ? 1 : 0) - (keys.keys || keys.arrowdown ? 1 : 0);
    const kbYaw = (keys.keye ? 1 : 0) - (keys.keyq ? 1 : 0);
    const kbRoll = (keys.keyz ? 1 : 0) - (keys.keyx ? 1 : 0);
    // nose DOWN on C, not Ctrl (2026-10-23: Ctrl+W with the throttle held closed the browser tab, Ctrl+S
    // opened Save, Ctrl+D bookmarked — a page cannot block Ctrl+W)
    const kbPitch = (keys.shiftleft || keys.shiftright ? 1 : 0) - (keys.keyc ? 1 : 0);
    const gp = gamepad.read();
    padRespawn = !!gp?.respawnPressed;
    if (gp?.restartPressed) padRestart = true; // Back: restart (the drive frame runs it)
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

  // ---------- ENGINE SOUND (engineModel.js + engineLoops.js — the loops the user picked, 2026-10-20 — or
  // the synth, engineSound.js) + sfx ----------
  // Starts on the first key press / click (browsers allow audio only after a gesture). M mutes; the
  // tab hidden = paused. Sound is OFF unless the settings turned it on (user, 2026-10-19).
  const engine = createEngineModel();
  const engineType = prefs.engine ?? "gen6";
  const engineSound = (isLoopEngine(engineType) ? createEngineLoops : createEngineSound)({ type: engineType, volume: prefs.volume ?? 0.7 });
  // EVERY PAGE OPENS SILENT (user, 2026-10-22: "disable the sound by default"; 2026-10-21: "when we open a
  // page the sound should be disabled, any time we click the icon it should work"): the icon turns it on
  // for this page only — remembered, it came back on in every later page (and every test run)
  let engineMuted = true;
  engineSound.setMuted(engineMuted);
  const sfx = createSfx(() => (engineSound.ready ? engineSound.context : null), { volume: prefs.volume ?? 0.7 });
  // THE CAR'S EFFECTS in the game (the FX lab tunes them, fx: false there): the rail sparks, tyre marks
  const sparks = fx ? createSparks(scene) : null;
  const tyreMarks = fx ? createTyreMarks(scene) : null;
  const tyreSmoke = fx ? createTyreSmoke(app) : null; // tyreSmoke.js: drifts, handbrake, wheelspin, locked brakes
  // touchdown dust + the perfect ring (landingFx.js): PARKED, OFF (user, 2026-10-22: "forget the landing dust
  // for now, we will do it later") — the dust still read as flat sheets, the ring hazed the lens as it passed
  const landingFx = fx && false ? createLandingFx(scene) : null;
  sfx.setMuted(engineMuted);
  // RECORDED sounds over the synthesised ones, one part at a time (the user's picks in the sound lab,
  // 2026-10-20: the drift squeal is a recording, the long screech)
  const sfxRec = createSfxSamples(() => (engineSound.ready ? engineSound.context : null), { volume: prefs.volume ?? 0.7, pick: GAME_PICK });
  sfxRec.setMuted(engineMuted);
  for (const part of Object.keys(GAME_PICK)) sfx.setPart(part, false);
  // OFF for now (user, 2026-10-20: the wind "really annoying too"; the tyre roll off with it, for a test
  // of the engine and the drift squeal alone)
  sfx.setPart("wind", false);
  sfx.setPart("roll", false);
  const unlockAudio = () => { if (S && !engineMuted) engineSound.unlock(); };
  // SOUND ON / OFF (user, 2026-10-20: "an icon top right for quick access"): the button, M, and the menu's
  // Settings are one switch, remembered
  function setSound(on) {
    engineMuted = !on;
    engineSound.setMuted(engineMuted);
    sfx.setMuted(engineMuted);
    sfxRec.setMuted(engineMuted);
    if (on) { engineSound.unlock(); if (S) engineSound.resume(); }
    $("snd").innerHTML = SND_ICON(on);
    $("snd").classList.toggle("on", on);
  }
  $("snd").innerHTML = SND_ICON(!engineMuted);
  $("snd").classList.toggle("on", !engineMuted);
  $("snd").onclick = () => setSound(engineMuted);
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
    engineSound.update(engine.update(dt, kmh, throttle, !free, !race.holding && vehicle.groundedCount === 0));
    // tyres slide when the car moves SIDEWAYS (car-local x); braking = the brake held at speed
    _side.set(1, 0, 0).applyQuaternion(vehicle.body.quat);
    const boosting = rules.boostLeft > 0;
    if (boosting && !wasBoosting) sfx.boost();
    wasBoosting = boosting;
    // scrape: how fast the car slides along a rail, 3 → 30 m/s as 0 → 1 (the sparks' own scale, sparks.js)
    const scrape = vehicle.enabled && vehicle.scraping ? Math.max(0, Math.min(1, (vehicle.scrapeSpeed - 3) / 27)) : 0;
    const car = { kmh, slip: vehicle.body.vel.dot(_side), grounded: vehicle.groundedCount > 0, braking: (input.throttle ?? 0) < 0 || !!input.handbrake, boosting, scrape };
    sfx.update(dt, car);
    sfxRec.update(dt, car);
    // the countdown: a beep on 3, 2, 1
    const n = race.s.state === "countdown" ? Math.ceil(race.s.hold * 2) : 0;
    if (n && n !== lastCount && n <= 3) sfx.beep("count");
    lastCount = n;
    // the start gantry's lights (gateMesh.js): red one by one on 3-2-1, green at GO
    S.startGate?.userData.setLights?.(n ? 4 - Math.min(3, n) : "go");
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
    S.landings.push({ grade: ev.grade, err: Math.round(ev.err), air: +ev.air.toFixed(1), t: +S.runTime.toFixed(2), ...(ev.partial ? { partial: true } : {}) });
    const el = $("land");
    const label = { perfect: "Perfect landing", ok: "Landed", rough: "Rough landing" }[ev.grade];
    const tail = ev.grade === "perfect" ? "boost" : ev.grade === "rough" ? "−15% speed" : ev.partial ? "not on all four wheels: no boost" : "land flat for a boost";
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
   * @param o.onEscape  Esc while driving (also the BACK button top right)
   * @param o.backLabel  that button's word ("Menu", "Builder"…; default "Back")
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
    const lastP = lay.placements.filter((p) => !p.side).at(-1); // the road's end, not a piece beside it
    // (not after a FINISH piece: its own 72 m stub is the run-out, and its nose ends it)
    // (nor without an automatic finish — the builder: the road ends where you ended it)
    if (track && lastP && !o.from && o.autoFinish !== false && !TILES[lastP.id]?.finish) {
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
    const gates = gatesFor(lay.ride, flagged, hwOf, o.from ? [] : ringGates, finishAt, o.autoFinish !== false);
    const r0 = lay.ride[0];
    let startGate = null;
    for (const g of [{ kind: "start", P: r0.P.clone().addScaledVector(r0.T, startT ? startT.line : 6), T: r0.T.clone(), U: r0.U ?? new V(0, 1, 0), hw: hwOf(0), slot: startT ? startT.line - startT.spawn : 0 }, ...gates]) {
      const m = makeGateMesh(g);
      if (g.kind === "start") startGate = m;
      group.add(m);
    }
    scene.add(group);
    // o.noTimer (the builder's Timer switch, off by default — user, 2026-10-22: "we shouldn't need the timer
    // and the countdown all the time when creating and debugging"): no countdown, no clock on screen, a
    // finish records nothing (as practice from a piece)
    const race = createRace({ gates, countdown: o.noTimer ? 0 : o.from ? 0.3 : 1.5 });
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
      const look = lookFor(p);
      const t = TILES[p.id];
      // the left-hand mirrors ("…_L") are the same pieces: they need the same tags
      decks.push(asCollider(look.deck, p.M, { roadHold: ROAD_HOLD.has(p.id.replace(/_L$/, "")) || !!t?.roadHold, freeCarve: !!t?.freeCarve }));
      if (look.railCollision) solids.push(asCollider(look.railCollision, p.M));
    }
    // OBSTACLES (obstacles.js): fixed ones join the trees; movers are posed from the race clock each tick
    const obstacles = buildObstacleSet(track?.props ?? [], { physics: true });
    // the KNOCKABLE props (cones, tyres, barrels, swing gates): the old game's physics, one-way (physProps.js)
    const physProps = createPhysProps(scene, obstacles.bodies, () => vehicle.groundBvh, DYNAMIC_LAYER);
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
    const lineSpawn = { pos: spawnPos.clone(), quat: startQuat.clone() }; // Delete: always back to the start line
    let spawnVel = null;
    if (o.from) {
      // PRACTICE FROM A PIECE (Trackmania's "test from here"): standing on that piece's start, its slope
      // and bank included (piece frame: −Z along the road; the car's nose is +Z)
      const fwd = new V(0, 0, -1).transformDirection(o.from), up = new V(0, 1, 0).transformDirection(o.from);
      startQuat = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().extractRotation(o.from)).multiply(new THREE.Quaternion().setFromAxisAngle(new V(0, 1, 0), Math.PI));
      // (the builder's TEST CAR: exactly where it stands — fromExact — at its speed, fromKmh)
      spawnPos = new V().setFromMatrixPosition(o.from).addScaledVector(fwd, o.fromExact ? 0 : 4).addScaledVector(up, SPAWN_LIFT);
      if (o.fromKmh > 0) spawnVel = fwd.clone().multiplyScalar(o.fromKmh / 3.6);
    }

    // ---------- THE CAR'S RULES (carRules.js): wall cut, landing judge + boost, boost pads, magnets ----------
    const boostPads = [...lay.placements.filter((p) => p.id.startsWith("boost")).map((p) => p.M.clone().invert()), ...boostZones(track?.props)];
    const magnets = magnetZones(lay.placements, TILES, integrate);
    const cutZones = wallCutZones(lay.placements, built); // the wall cut: bowls and quarter pipes only
    const rules = createCarRules(vehicle, { boostPads, magnets, cutZones });
    const ghostRules = createCarRules(ghostCar, { boostPads, magnets, cutZones });
    const pilot = createAutopilot(avoidObstacles(lay.ride, track?.props)); // autopilot.js (shared with the builder's prediction and the tests), its line round the obstacles
    // (the ghost lives in IndexedDB — app/ghostStore.js: in localStorage the ghosts filled the 5 MB and every save failed)
    const ghostData = await ghosts.get(trackKey);

    S = {
      o, lay, group, race, gates, trackKey, medals, BEST_KEY, best, bakeMs, rules, ghostRules, pilot, ghostData,
      ghostPlayer: null, recorder: createGhostRecorder(), landings: [], startQuat, spawnPos, lineSpawn, spawnVel,
      KILL_Y: o.killY ?? lowestY - 50, safe: { pos: spawnPos.clone(), quat: startQuat.clone(), ok: false }, // killY: the FX lab drives on the floor
      simAccum: 0, runTime: 0, topKmh: 0, recoveries: 0, lastBackspace: -1e9, frame: 0, adoptCount: 0, physMs: [],
      obstacles, moverT: 0, meshes, // the movers' RACE clock: 0 at the green light, held through the countdown
      startGate, physProps,
    };
    // BACK, on screen (user, 2026-10-21: "why don't we have a back button to go back to the menu?") — the
    // same as Esc
    $("back").innerHTML = `← ${o.backLabel ?? "Back"}<kbd>Esc</kbd>`;
    $("back").style.display = o.onEscape ? "" : "none";
    $("back").onclick = () => { $("back").blur(); o.onEscape?.(); };
    $("help").innerHTML = o.help ?? `<kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> / arrows drive · <kbd>Space</kbd> handbrake · in the air: <kbd>Shift</kbd>/<kbd>C</kbd> pitch, <kbd>Q</kbd>/<kbd>E</kbd> spin, <kbd>Z</kbd>/<kbd>X</kbd> roll · <kbd>Backspace</kbd> last checkpoint · <kbd>R</kbd> restart · <kbd>F</kbd> free camera`;
    hud.classList.add("on");
    $("time").style.display = $("cps").style.display = o.noTimer ? "none" : "";

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
      const look = lookFor(p);
      for (const g of [look.deck, look.rail]) {
        if (!g) continue;
        const a = g.getAttribute("position");
        for (let i = 0; i < a.count; i += 6) pts.push(tmp.fromBufferAttribute(a, i).applyMatrix4(p.M).clone());
      }
    }
    scene.updateMatrixWorld(true);
    const old = sunShadows;
    S?.meshes?.fullDetail(true); // the bake sees every post, whatever the camera picked
    // trackLine: the road's centre, so each atlas cell is turned to the road's direction (no saw-tooth)
    sunShadows = createSunShadows({ renderer, scene, sunDir: app.light.getDirection().clone(), casterPoints: pts, trackLine: lay.ride.map((r) => r.P) });
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
    if (freeCam) toggleFreeCam(); // back to the chase (and full speed) for the next drive
    scene.remove(S.group); // its geometries are the shared tile cache: kept for the next drive
    S.physProps.dispose();
    vehicle.setDynamicMovers([]);
    ghostCar.setDynamicMovers([]);
    clearTimeout(splitTimer);
    clearTimeout(landTimer);
    // (their timers are gone: hide them now, or a banner from the last second came back on the next drive)
    $("split").classList.remove("show");
    $("land").classList.remove("show");
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
    sparks?.reset();
    tyreMarks?.reset();
    tyreSmoke?.reset();
    landingFx?.reset();
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
  /** Back to the spawn — the test car, at its speed (R) — or, fromLine, the start line standing (Delete). */
  function restart(fromLine = false) {
    engine.reset();
    sparks?.reset();
    tyreMarks?.reset();
    tyreSmoke?.reset();
    landingFx?.reset();
    S.race.reset();
    S.physProps.reset(); // the knocked props stand back where they were placed
    $("finish").classList.remove("show");
    vehicle.setEnabled(true); // parked after a finish
    S.rules.reset();
    S.recorder.start();
    S.landings.length = 0;
    S.pilot.reset();
    const sp = fromLine === true ? S.lineSpawn : { pos: S.spawnPos, quat: S.startQuat };
    vehicle.setSpawn(sp.pos, sp.quat);
    vehicle.respawn();
    if (fromLine !== true && S.spawnVel) vehicle.body.vel.copy(S.spawnVel); // the test car's speed
    startGhost();
    chase.reset();
    S.simAccum = 0;
    S.runTime = 0;
    S.moverT = 0;
    S.obstacles.setTime(0);
    S.topKmh = 0;
    S.safe.pos.copy(sp.pos);
    S.safe.quat.copy(sp.quat);
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
    // o.fallReset false (the builder — user, 2026-10-22: "I should be able to fall on the ground, it shouldn't
    // restart the race"): the car lands on the terrain and drives on; only through the world (or off its
    // edge, nothing under it) does it come back
    if (S.o.fallReset === false) {
      const ground = app.getWorldHeight?.(p.x, p.z);
      if (p.y < (Number.isFinite(ground) ? ground - 30 : S.KILL_Y - 500) || p.y < -5000) return S.race.s.state === "running" ? respawnCheckpoint() : restart();
    } else if (p.y < S.KILL_Y) {
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
    } else if (e.type === "finish" && (S.o.from || S.o.noTimer)) {
      showFinish(e.time, false, true); // practice: nothing is recorded
    } else if (e.type === "finish") {
      const improved = !S.best || e.time < S.best.time;
      if (improved) {
        S.best = { time: e.time, splits: S.race.s.splits.slice() };
        try { localStorage.setItem(S.BEST_KEY, JSON.stringify(S.best)); } catch {}
        // the new best becomes the ghost (from the next restart)
        S.ghostData = S.recorder.finish(e.time);
        ghosts.set(S.trackKey, S.ghostData);
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
    // R: again from where this drive started (the builder's test car, at its speed); Delete: the START LINE
    if (e.code === "KeyR") restart();
    if (e.code === "Delete") restart(true);
    if (e.code === "KeyP") { autopilot = !autopilot; S.pilot.reset(); }
    if (e.code === "KeyG") { showGhost = !showGhost; ghostCar.group.visible = !!S.ghostPlayer && showGhost && ghostStyled; }
    if (e.code === "KeyM") setSound(engineMuted);
    if (e.code === "KeyF") toggleFreeCam(); // F (back from C, 2026-10-23: C is nose-down now)
    if (e.code === "KeyT" && freeCam) { freeCam.slow = (freeCam.slow + 1) % FREE_SLOW.length; timeScale = FREE_SLOW[freeCam.slow]; showFreeCam(); }
    if (freeCam) freeCamKey(e.code);
    if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Tab"].includes(e.code)) e.preventDefault();
    // these may end the session (back to the builder, the menu, the next track): last
    const o = S.o;
    if (e.code === "Escape") return o.onEscape?.();
    // o.tabBack (the builder — user, 2026-10-23: "why not Tab for both?"): Tab toggles, back to building too
    if (e.code === "Tab" && S.o.tabBack && !e.repeat) return o.onEscape?.();
    if ($("finish").classList.contains("show")) for (const b of o.buttons ?? []) if (e.code === (b.code ?? `Key${b.key}`)) return b.run();
  });
  addEventListener("keyup", (e) => { keys[e.code.toLowerCase()] = false; });

  // ---------- FREE CAMERA = THE OLD GAME'S DEBUG ORBIT CAMERA (modular-road-v3/debugCamera.js) ----------
  // (user, 2026-10-21: "look at the free camera I use in my old car game: it lets me drive the car and orbit
  // around to see everything while driving"). Mine orbited too, but read the mouse after the engine's
  // editor camera had taken the wheel / drags; that rig binds them on window at capture (see its notes),
  // smooths only the input, pans, and has the presets. C on / off; while on: left-drag orbit, right-drag
  // pan, wheel or + / − zoom, V world ↔ car frame, 1-4 behind / front / left / right, 0 recentre; T 1× /
  // ¼× / paused (Thunderline's). The car keeps driving (keys, autopilot).
  const FREE_SLOW = [1, 0.25, 0];
  let freeCam = null; // { slow } while on
  const debugCam = createDebugCamera({ camera, vehicle, domElement: renderer.domElement, isActive: () => !!freeCam && !!S });
  const _dQ = new THREE.Quaternion(), _dF = new V(), _dR = new V(), _dU = new V();
  let airT = 0;
  function showFreeCam(dt = 0) {
    $("freecam").classList.toggle("show", !!freeCam);
    if (!freeCam) return;
    // the old rig's readout: the car's attitude, wheels down, time in the air
    _dQ.copy(vehicle.renderQuat ?? vehicle.body.quat);
    _dF.set(0, 0, 1).applyQuaternion(_dQ); _dR.set(1, 0, 0).applyQuaternion(_dQ); _dU.set(0, 1, 0).applyQuaternion(_dQ);
    const D = 180 / Math.PI, g = vehicle.groundedCount;
    airT = g === 0 ? airT + dt : 0;
    $("freecam").innerHTML =
      `<b>FREE CAMERA</b>${debugCam.frame} frame · ${debugCam.distance.toFixed(1)} m · pitch ${(Math.asin(THREE.MathUtils.clamp(_dF.y, -1, 1)) * D).toFixed(1)}° · roll ${(Math.atan2(_dR.y, _dU.y) * D).toFixed(1)}° · wheels ${g}/4${g === 0 ? ` · air ${airT.toFixed(2)} s` : ""}<br>` +
      `drag orbit · right-drag pan · wheel / <kbd>+</kbd><kbd>−</kbd> zoom · <kbd>V</kbd> frame · <kbd>1</kbd>-<kbd>4</kbd> views · <kbd>0</kbd> recentre · <kbd>T</kbd> ${["1×", "¼×", "paused"][freeCam.slow]} · <kbd>F</kbd> back`;
  }
  function toggleFreeCam() {
    if (freeCam) {
      if (freeCam.slow) timeScale = 1;
      freeCam = null;
      chase.reset();
    } else {
      freeCam = { slow: 0 };
      debugCam.enter(); // from wherever the chase camera is: no cut
    }
    showFreeCam();
  }
  function freeCamKey(code) {
    if (code === "KeyV") debugCam.toggleFrame();
    else if (code === "Digit0") debugCam.recenter();
    else if (code === "Digit1") debugCam.preset("behind");
    else if (code === "Digit2") debugCam.preset("front");
    else if (code === "Digit3") debugCam.preset("left");
    else if (code === "Digit4") debugCam.preset("right");
    else if (code === "Equal" || code === "NumpadAdd") debugCam.zoomBy(-1);
    else if (code === "Minus" || code === "NumpadSubtract") debugCam.zoomBy(1);
  }

  // ---------- the sim loop (roadGame.js:9904), in the engine's frame: before it reads the camera ----------
  let last = performance.now();
  function renderStats() {
    const { lay } = S;
    $("stats").innerHTML =
      `track <b>${(lay.length / 1000).toFixed(2)} km</b> · <b>${lay.placements.length}</b> pieces<br>` +
      `collision bake <b>${S.bakeMs.toFixed(0)} ms</b> · wheels down <b>${vehicle.groundedCount}/4</b><br>` +
      `top speed this run <b>${Math.round(S.topKmh)} km/h</b>` +
      // WHICH SHADOWS drew this frame (user, 2026-10-21: screenshots from pages that weren't running what I
      // had changed) — the baked + live maps (with the live box's size now) or the engine's cascades
      `<br>shadows <b>${sunShadows ? `baked + live ${sunShadows.liveSize ?? "?"} m · soft v3` : "engine cascades (builder)"}</b> · dpr <b>${devicePixelRatio}</b>` +
      (lay.warnings.length ? `<br><span style="color:#ff4d5e">${lay.warnings.join("<br>")}</span>` : "");
  }
  const HUD = { kmh: $("kmh"), time: $("time"), cps: $("cps"), boost: null };
  const hudText = (el, t) => { if (el && el._t !== t) { el._t = t; el.textContent = t; } };
  app.addPreUpdateHook(function driveFrame() {
    const now = performance.now();
    const dt = Math.min((now - last) / 1000, 0.05) * timeScale;
    last = now;
    if (!S) return;
    const { race, rules, recorder } = S;
    const input = (lastInput = inputSource ? inputSource(vehicle, S) : autopilot ? S.pilot.input(vehicle) : readControls());
    if (padRespawn) respawnCheckpoint();
    if (padRestart) { padRestart = false; restart(); }
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
      // a FIRM stop (v / 3.5 m: 16 m from 200 km/h, 24 m from 300) — the Finish's run-out is 28 m (was a
      // 1.1 coast over 72 m: user, 2026-10-22, "why is the finish piece so long?")
      if (race.s.state === "finished" && vehicle.groundedCount > 0) vehicle.body.vel.multiplyScalar(Math.exp(-3.5 * FIXED_DT));
      const landed = rules.step(used, FIXED_DT);
      S.physProps.tick(FIXED_DT, vehicle); // the knockable props, after the car (it shoves them; they never push back)
      if (race.s.state !== "finished") recorder.tick(used, vehicle);
      if (landed) { showLanding(landed); sfx.landing(landed, fallSpeed); landingFx?.grade(landed, vehicle); }
      if (vehicle.groundedCount === 0) fallSpeed = Math.max(0, -vehicle.body.vel.y); // how hard the next landing hits
      for (const e of race.tick(vehicle, FIXED_DT)) { onRace(e); if (!S) return; }
      if (S.ghostPlayer) S.ghostPlayer.tick(FIXED_DT);
      S.runTime += FIXED_DT;
      if (vehicle.groundedCount >= 3) { S.safe.pos.copy(vehicle.body.pos); S.safe.quat.copy(vehicle.body.quat); S.safe.ok = true; }
    }
    if (ticks) S.physMs.push((performance.now() - tPhys) / ticks);
    if (S.physMs.length > 480) S.physMs.splice(0, 240); // trimmed in batches, not shifted every frame (the debug readout's last 240+)
    vehicle.syncVisuals(dt, S.simAccum / FIXED_DT);
    S.physProps.sync();
    if (dt > 0) tyreMarks?.update(vehicle, dt);
    tyreSmoke?.update(vehicle, dt);
    engineTick(dt, input);
    if (S.ghostPlayer) {
      if (S.ghostPlayer.done) ghostCar.group.visible = false;
      else if (showGhost) ghostCar.syncVisuals(dt, S.simAccum / FIXED_DT);
    }
    if (sunShadows) {
      // the car's model arrives late: re-adopt its group a few times so late children cast too
      if (S.adoptCount++ % 60 === 0 && S.adoptCount < 1200) adoptCar(vehicle.group);
      sunShadows.follow(vehicle.renderPos, camera.position.distanceTo(vehicle.renderPos)); // the box shrinks when the camera is close (free camera)
    }
    checkFall();
    chase.update(dt);
    sparks?.updateFromVehicle(vehicle, camera, dt); // after the camera: the streaks face it
    landingFx?.update(vehicle, camera, dt);
    // the camera runs on REAL time (the mouse must still work in slow motion and when paused)
    if (freeCam) { const rdt = timeScale > 0 ? dt / timeScale : 1 / 60; debugCam.update(rdt); if (S.frame % 6 === 0) showFreeCam(rdt * 6); }
    S.meshes.updateLod(camera); // the posts' detail, from the game camera (testTrack.js)
    app.controls.target.copy(vehicle.renderPos);
    const kmh = Math.abs(vehicle.speedKmh ?? vehicle.body.vel.length() * 3.6);
    S.topKmh = Math.max(S.topKmh, kmh);
    // the HUD written only when its text changes (performance pass, 2026-10-22: 4 lookups and 3 writes a
    // frame, the clock and the CP counter even while hidden — Timer off)
    hudText(HUD.kmh, String(Math.round(kmh)));
    const rs = race.s;
    if (!S.o.noTimer) {
      hudText(HUD.time, rs.state === "countdown" ? String(Math.ceil(rs.hold * 2)) : fmt(rs.state === "finished" ? rs.finishTime : rs.time));
      hudText(HUD.cps, race.cps.length ? `CP ${rs.taken.size}/${race.cps.length}` : "no checkpoints");
      const boost = rules.boostLeft > 0;
      if (boost !== HUD.boost) { HUD.boost = boost; HUD.cps.classList.toggle("boost", boost); }
    }
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
    vehicle, ghostCar, chase, keys, engine, engineSound, sfx, sfxRec, camera, sparks, tyreMarks, tyreSmoke, landingFx, carHologram,
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
