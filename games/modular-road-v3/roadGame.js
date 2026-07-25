// ============================================================================
// MODULAR ROAD (v3) — a game project built ON TOP of the v3 world engine.
//
// The model (same as games/rts-v3/, different game):
//   • The v3 EDITOR (v3/editor.html) authors the world and saves a .v3proj.
//   • This GAME imports the engine's boot (startV3App), LOADS that .v3proj, and
//     adds the road-stunt gameplay on top (track builder, car, camera, UI).
//
// Nothing here edits the engine's source — it only imports it. To reshape the
// terrain or move objects: open v3/editor.html, build/tweak, Save Project, and
// drop the result here as `world.v3proj`. This game reloads it on boot.
//
// TWO SAVE FORMATS, deliberately separate:
//   • world.v3proj — the terrain/sky/foliage, authored in the v3 editor.
//   • track JSON   — the road pieces, authored in-game (modularRoadTrackIO.js).
// One world hosts many tracks; a track can be shared without a terrain.
//
// HOW THE CAR DRIVES ON BOTH TERRAIN AND ROAD:
//   The modular-road Vehicle only knows how to query BVHs. The lab gave it a
//   flat `floor` MESH baked into the deck BVH. v3 has no floor mesh — terrain is
//   an analytic streamed heightfield — so createVehicleGround() duck-types the
//   BVH surface the Vehicle calls (raycastFirst / spherecast /
//   closestPointWithNormal), answering from the terrain sampler analytically and
//   from a real mesh BVH for the road. The Vehicle is unchanged.
// ============================================================================
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
// Vite bundles this and injects it — see the note in road.html for why it isn't
// a <link> tag.
import "./palette.css";
import { startV3App } from "../../v3/app/main.js";
import {
  Vehicle,
  FIXED_DT,
  TIRE,
  AERO,
  DRIVETRAIN,
  DECK,
  SOLID,
  STUCK,
  BODYLEAN,
  HEADLIGHTS,
  CHASSIS,
  GRAVITY,
} from "../../v3/play/modularRoadVehicle.js";
import { RoadBvh } from "../../v3/play/modularRoadBvh.js";
import { createVehicleGround } from "../../v3/play/modularRoadGround.js";
import {
  createRoadMaterial,
  createGuardrailMaterial,
  createTunnelMaterial,
  createDecorMaterial,
} from "./modularRoadMaterial.js";
import { ModularRoadBuilder, buildRoadPaletteUI, CATEGORY_PRESETS } from "./modularRoadBuilder.js";
import {
  PIECE_CATALOG,
  roadParams,
  pieceParams,
  guardrailParams,
} from "./modularRoadKit.js";
import { bakeRoadThumbnails } from "./modularRoadThumbnails.js";
import { PropManager, PROP_CATALOG, glowPropParams } from "./modularRoadProps.js";
import { MoverPropManager, MOVER_CATALOG } from "./modularRoadMoverProps.js";
import { PortalManager, DEFAULT_PORTAL_PARAMS, buildPortalMesh } from "./modularRoadPortals.js";
import { GapPreview } from "./gapPreview.js";
import { LapTracker, formatLapTime } from "./modularRoadLap.js";
import { GhostTrack, createGhostMesh } from "./modularRoadGhost.js";
import { ModularRoadTireMarks } from "./modularRoadTireMarks.js";
import { ModularRoadDriftSmoke, DEFAULT_DRIFT_SMOKE_SETTINGS } from "./modularRoadDriftSmoke.js";
import {
  createModularRoadAudioSystem,
  setupModularRoadVehicleAudio,
  DEFAULT_MIXER,
  DEFAULT_VEHICLE_AUDIO_SETTINGS,
} from "./modularRoadVehicleAudio.js";
import {
  exportTrack,
  importTrack,
  downloadTrackJson,
  createTrackFileInput,
} from "./modularRoadTrackIO.js";
import { createChaseCamera } from "./chaseCamera.js";
import { createGamepadInput } from "./gamepadInput.js";
import { createGearbox, GEARBOX } from "./gearbox.js";
import { loadWheelModel } from "./wheelModel.js";
import { loadBootWorld, loadWorldFromFile } from "./worldLoader.js";
import { createRoadDevPanel } from "./devPanel.js";

/** Cap on physics ticks per frame — a long stall must not queue a huge backlog. */
const MAX_SIM_TICKS = 8;
/** Absolute-Y backstop: below this the car is always respawned. */
const FALL_Y = -60;
/** Air-stunt: dropping this far BELOW the last grounded height counts as a fall
 *  (relative to the track, so it works at any track altitude). */
const FALL_DROP = 12;
/** How far above the terrain a freshly seeded chain's first piece sits. */
const ROAD_SEED_CLEARANCE = 0.5;
/** Lift applied to a resolved spawn so the wheels settle onto the deck. */
const SPAWN_LIFT = 0.6;
/** Default build altitude (m above terrain) — this is the SKY-stunt mode. */
const DEFAULT_BUILD_HEIGHT = 40;
/** Seconds between auto-headlight sun checks (cheap, but not per-frame work). */
const AUTO_LIGHT_INTERVAL = 0.5;

export async function startRoadGame({ onStatus = () => {} } = {}) {
  // 1) ── BOOT THE ENGINE ────────────────────────────────────────────────────
  // Same entry the editor uses; the page hides the editor chrome. Unlike the
  // RTS (fixed top-down view, 2 cascades are plenty) this is a ground-level
  // chase camera looking down a long track, so the shadow config stays near the
  // editor default.
  onStatus("Starting engine…");
  const app = await startV3App();
  window.__road = app; // handy for console debugging

  const { scene, camera, controls, renderer } = app;

  // 2) ── LOAD THE WORLD ─────────────────────────────────────────────────────
  const boot = await loadBootWorld(app, { onStatus });
  // Rivers/lakes carve the heightmap AFTER the project's own height sync, so
  // pull a fresh CPU mirror before anything below reads ground heights.
  await app.refreshWorldHeights?.();

  // Post-FX: the GAME owns its look. postFx.enabled defaults to FALSE in the
  // engine and is NOT stored in the .v3proj, so without this the game gets no
  // bloom no matter what its materials do.
  //
  // v3 bloom is SELECTIVE — only the emissive MRT buffer blooms, so a material
  // must write `mrtNode` to glow (see applyBloomMRT in modularRoadProps.js).
  // That differs from the lab, which bloomed the whole scene's bright pixels, so
  // a high `emissiveIntensity` alone was enough there and is NOT enough here.
  app.postFx?.setEnabled(true);
  app.postFx?.setBloomSelective(true);
  app.postFx?.setBloom({ enabled: true, strength: 0.9, threshold: 0.0, radius: 0.5 });

  // 3) ── THE TRACK ──────────────────────────────────────────────────────────
  onStatus("Building track…");
  const roadMaterial = createRoadMaterial();
  const railMaterial = createGuardrailMaterial();
  const shellMaterial = createTunnelMaterial();
  const decorMaterial = createDecorMaterial();

  let mode = "build"; // "build" | "drive"
  // Declared up here (not with the input handlers below) because the audio setup
  // captures it via getKeys and may read it during construction.
  const keys = Object.create(null);
  // Assigned near the end of setup, but bakeCollision() runs before that and
  // pokes it — `let … = null` so the early call sees null instead of a TDZ throw.
  let devPanel = null;

  const builder = new ModularRoadBuilder({
    scene,
    material: roadMaterial,
    railMaterial,
    shellMaterial,
    decorMaterial,
    camera,
    domElement: renderer.domElement,
    orbit: controls,
    isBuildMode: () => mode === "build",
    onChange: () => { bakeCollision(); paletteUi?.refreshStatus?.(); },
  });

  // ── PROPS / MOVERS / PORTALS ───────────────────────────────────────────────
  // Track content beyond the road surface: obstacles and boost pads (props),
  // moving platforms (movers), and teleport door pairs (portals). All three edit
  // via their own TransformControls gizmo, so they must deselect each other —
  // two live gizmos fight over the mouse.
  const props = new PropManager({
    scene,
    camera,
    domElement: renderer.domElement,
    orbit: controls,
    onChange: () => { bakeCollision(); paletteUi?.refreshStatus?.(); },
    onSelect: () => { movers.deselect(); portals.deselect?.(); builder.deselectPlacement?.(); },
  });
  const movers = new MoverPropManager({
    scene,
    camera,
    domElement: renderer.domElement,
    orbit: controls,
    onChange: () => { bakeCollision(); paletteUi?.refreshStatus?.(); },
    onSelect: () => { props.deselect(); portals.deselect?.(); builder.deselectPlacement?.(); },
  });
  const portals = new PortalManager({
    scene,
    camera,
    domElement: renderer.domElement,
    orbit: controls,
    params: { ...DEFAULT_PORTAL_PARAMS },
    onChange: () => paletteUi?.refreshStatus?.(),
    onActivate: () => { props.deselect(); movers.deselect(); builder.deselectPlacement?.(); },
  });

  // Live-bake real 3/4 thumbnails for every piece + preset so palette tiles show
  // the actual built geometry instead of the hand-drawn SVG fallbacks.
  onStatus("Baking piece thumbnails…");
  const thumbItems = [];
  for (const p of PIECE_CATALOG) thumbItems.push({ key: p.id, pieceId: p.id, params: {} });
  for (const presets of Object.values(CATEGORY_PRESETS)) {
    for (const pr of presets) thumbItems.push({ key: pr.id, pieceId: pr.base, params: pr.params });
  }
  for (const p of PROP_CATALOG) thumbItems.push({ key: p.id, make: p.make });
  for (const m of MOVER_CATALOG) thumbItems.push({ key: m.id, make: m.make });
  // The portals palette tile is synthetic (id "portal_door" in buildRoadPaletteUI),
  // not a catalog entry — bake it a real door thumbnail under that key.
  thumbItems.push({
    key: "portal_door",
    make: () => buildPortalMesh(DEFAULT_PORTAL_PARAMS, DEFAULT_PORTAL_PARAMS.colorA, "a").root,
  });
  let roadThumbnails = new Map();
  try {
    roadThumbnails = await bakeRoadThumbnails({
      renderer,
      materials: { road: roadMaterial, rail: railMaterial, shell: shellMaterial, decor: decorMaterial },
      items: thumbItems,
      environment: scene.environment,
      size: 192,
    });
  } catch (e) {
    console.warn("[ModularRoad-v3] thumbnail bake skipped", e);
  }

  // The palette owns the piece catalog, categories AND the build-mode keyboard
  // shortcuts (they live inside buildRoadPaletteUI).
  const paletteUi = buildRoadPaletteUI(builder, {
    propCatalog: PROP_CATALOG,
    moverCatalog: MOVER_CATALOG,
    thumbnails: roadThumbnails,
    onAddProp: (id) => props.add(id),
    onAddMover: (id) => movers.add(id),
    onAddPortal: () => { portals.addDoor(); paletteUi?.refreshStatus?.(); },
    onEdgesChange: () => bakeCollision(),
  });

  // 4) ── THE CAR ────────────────────────────────────────────────────────────
  const vehicle = new Vehicle({ scene, showArrows: false });
  // Chassis-corner safety floor follows the terrain instead of pinning to y=0.
  vehicle.getFloorY = (x, z) => app.getWorldHeight(x, z);

  // GLB wheels, loaded in the BACKGROUND: the car boots on its procedural wheels
  // and upgrades when the model arrives, so a slow or missing file can never
  // leave the game wheel-less or block startup. The dev panel's Wheels button
  // switches back to procedural, which also restores WHEEL_PROCEDURAL's exact
  // radius/thickness — the dimensions the handling was tuned against.
  loadWheelModel(renderer)
    .then(({ object, radius, width }) => {
      vehicle.setWheelModel(object, { radius, thickness: width });
      vehicle.setWheelStyle("glb");
      console.info(
        `[ModularRoad-v3] GLB wheels: radius ${radius.toFixed(3)}m, width ${width.toFixed(3)}m`,
      );
      devPanel?.refresh();
    })
    .catch((e) => {
      console.warn("[ModularRoad-v3] wheel model failed to load — staying procedural", e);
    });

  // STATIC collision — track pieces + props. Baked only when the track changes.
  const deckBvh = new RoadBvh();   // road decks → wheel probes
  const solidsBvh = new RoadBvh(); // guardrails + tunnel shells → chassis collision
  // DYNAMIC collision — moving platforms / walls only. Rebaked every physics
  // tick, which is affordable precisely BECAUSE the static track isn't in here.
  const moverDeckBvh = new RoadBvh();
  const moverSolidsBvh = new RoadBvh();

  const ground = createVehicleGround({
    getTerrainHeight: (x, z) => app.getWorldHeight(x, z),
  });
  vehicle.setBvh(ground.ground, ground.solids);

  /**
   * Rebuild the collision BVHs from the current track.
   *
   * NOTE vs the lab: the lab pushed its flat `floor` mesh into `decks`. Here the
   * terrain is analytic inside createVehicleGround, so decks contains ONLY road
   * geometry — pushing a ground mesh would double up the surface.
   */
  function bakeCollision() {
    scene.updateMatrixWorld(true);
    const decks = builder.pieces
      .map((p) => p.mesh)
      .filter((m) => m && !m.userData.noCollision);
    const solids = [];
    for (const p of builder.pieces) {
      if (p.railMesh) solids.push(p.railMesh);
      if (p.shellMesh) solids.push(p.shellMesh);
    }

    // Props are static during a run (they only move via the build-mode gizmo, and
    // that fires onChange → a full rebake), so they belong in the static BVH.
    // Movers do NOT — they go in the dynamic one, rebaked per tick below.
    const propCol = props.collisionMeshes();
    decks.push(...propCol.deck);
    solids.push(...propCol.solids);

    rebakeMovers();

    if (decks.length) {
      deckBvh.bakeFromMeshes(decks);
      ground.setRoadBvh(deckBvh.baked ? deckBvh : null);
    } else {
      ground.setRoadBvh(null);
    }
    if (solids.length) {
      solidsBvh.bakeFromMeshes(solids);
      ground.setRoadSolidsBvh(solidsBvh.baked ? solidsBvh : null);
    } else {
      ground.setRoadSolidsBvh(null);
    }
    refreshCollisionDebug();
    // The default spawn tracks the Start/first piece, so keep the marker on it as
    // the track changes (no-op cost when a custom spawn is set).
    updateSpawnMarker();
    devPanel?.refresh();
  }

  /**
   * Rebake ONLY the moving geometry, at its current pose.
   *
   * A moving platform's mesh travels, so a BVH baked once goes stale the moment
   * it moves and the wheels probe empty space. The lab solved this by rebuilding
   * the ENTIRE deck BVH (whole track included) every tick — O(track size) work,
   * up to 8× per frame here, which dominates the frame on any real track.
   *
   * Instead the movers live in their own BVH that the ground adapter queries
   * alongside the static one, so this rebuild is proportional to the number of
   * moving platforms (usually 1–3 meshes) and independent of track size.
   */
  function rebakeMovers() {
    const moverCol = movers.collisionMeshes();
    const decks = [...moverCol.deck];
    for (const dm of movers.getDeckMovers()) {
      if (dm.mesh && !decks.includes(dm.mesh)) decks.push(dm.mesh);
    }
    if (decks.length) {
      moverDeckBvh.bakeFromMeshes(decks);
      ground.setMoverBvh(moverDeckBvh.baked ? moverDeckBvh : null);
    } else {
      ground.setMoverBvh(null);
    }
    if (moverCol.solids.length) {
      moverSolidsBvh.bakeFromMeshes(moverCol.solids);
      ground.setMoverSolidsBvh(moverSolidsBvh.baked ? moverSolidsBvh : null);
    } else {
      ground.setMoverSolidsBvh(null);
    }
  }

  // ── COLLISION DEBUG ────────────────────────────────────────────────────────
  // Wireframes of what the car ACTUALLY collides against, which is not always
  // what you see — this is the first thing to switch on when the car falls
  // through a piece or catches on nothing.
  const debugGroup = new THREE.Group();
  debugGroup.name = "RoadCollisionDebug";
  debugGroup.visible = false;
  scene.add(debugGroup);
  let debugOn = false;

  function refreshCollisionDebug() {
    for (const c of debugGroup.children) c.geometry?.dispose();
    debugGroup.clear();
    if (!debugOn) return;
    const add = (bvh, color) => {
      if (!bvh?.geometry) return;
      debugGroup.add(new THREE.Mesh(
        bvh.geometry.clone(),
        new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity: 0.5 }),
      ));
    };
    add(deckBvh, 0xff5060);   // static decks = red
    add(solidsBvh, 0x5080ff); // static solids = blue
    // Mover BVHs are intentionally NOT drawn here: they rebake every tick, so a
    // wireframe snapshot would lag the platform. The movers' own visible meshes
    // already show where they are.
  }

  function setCollisionDebug(on) {
    debugOn = !!on;
    debugGroup.visible = debugOn;
    refreshCollisionDebug();
  }

  // ── MERGED TRACK (draw-call optimization for driving) ──────────────────────
  // The builder instances pieces by geometry hash, so IDENTICAL pieces share a
  // draw — but a diverse stunt track (every curve/bank/jump a unique shape) gets
  // ~1 draw per piece, i.e. 80+ for a 2-min circuit. For DRIVING we don't need
  // per-piece editing, so we MERGE every piece's geometry per material into one
  // static mesh: the whole track becomes ~4 draws (road + rail + shell + decor)
  // no matter how many or how varied the pieces are. Build mode keeps the
  // editable instanced/proxy meshes; drive mode swaps to the merged ones.
  const mergedGroup = new THREE.Group();
  mergedGroup.name = "ModularRoadMerged";
  mergedGroup.visible = false;
  scene.add(mergedGroup);

  const MERGE_ROLES = [
    { pick: (p) => p.mesh, mat: () => roadMaterial, cast: true },
    { pick: (p) => p.railMesh, mat: () => railMaterial, cast: true },
    { pick: (p) => p.shellMesh, mat: () => shellMaterial, cast: true },
    { pick: (p) => p.decorMesh, mat: () => decorMaterial, cast: false },
  ];

  function disposeMergedTrack() {
    for (const m of mergedGroup.children) m.geometry?.dispose();
    mergedGroup.clear();
  }

  function buildMergedTrack() {
    disposeMergedTrack();
    scene.updateMatrixWorld(true);
    for (const role of MERGE_ROLES) {
      const geos = [];
      for (const p of builder.pieces) {
        const m = role.pick(p);
        if (!m || m.userData.noRender || !m.geometry) continue;
        const g = m.geometry.clone();
        g.applyMatrix4(m.matrixWorld); // bake to world space
        geos.push(g);
      }
      if (!geos.length) continue;
      const merged = mergeGeometries(geos, false);
      for (const g of geos) g.dispose();
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, role.mat());
      mesh.castShadow = role.cast;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false; // one big mesh spanning the track
      mergedGroup.add(mesh);
    }
  }

  /** Swap between editable (build) and merged (drive) track rendering. */
  function setMergedTrack(on) {
    if (on) {
      buildMergedTrack();
      builder.root.visible = false; // hide instanced/proxy pieces
      mergedGroup.visible = true;
    } else {
      mergedGroup.visible = false;
      builder.root.visible = true;
      disposeMergedTrack();
    }
  }

  // 4b) ── DRIVING FX + AUDIO ────────────────────────────────────────────────
  const tireMarks = new ModularRoadTireMarks(scene);
  const driftSmoke = new ModularRoadDriftSmoke(scene, { ...DEFAULT_DRIFT_SMOKE_SETTINGS });

  // DEFAULT_MIXER starts muted (muteAll: true) — the lab exposes a mixer panel to
  // unmute. There's no such panel here yet, so start audible; browsers still
  // require a gesture before anything plays, hence unlock() on first input.
  // Deep-copy `buses`: a shallow spread would share that object with the
  // exported DEFAULT_MIXER, so the dev panel's volume slider would write back
  // into the module-level default. Starts MUTED (the mixer's own default) — the
  // dev panel's Mute-all toggle turns it on.
  const audioState = {
    ...DEFAULT_MIXER,
    muteAll: true,
    buses: Object.fromEntries(
      Object.entries(DEFAULT_MIXER.buses).map(([k, v]) => [k, { ...v }]),
    ),
  };
  const vehicleAudioSettings = { ...DEFAULT_VEHICLE_AUDIO_SETTINGS };
  const audioSystem = createModularRoadAudioSystem({ mixerState: audioState });
  setupModularRoadVehicleAudio(audioSystem, {
    vehicle,
    settings: vehicleAudioSettings,
    getKeys: () => keys,
  });
  const unlockAudio = () => audioSystem.unlock();
  addEventListener("pointerdown", unlockAudio, { passive: true });
  addEventListener("keydown", unlockAudio, { passive: true });

  // 4c) ── HEADLIGHTS ────────────────────────────────────────────────────────
  // The lab drove headlights from a day/night preset that also moved the sun.
  // v3 owns time-of-day itself, so instead we READ the sun and switch the lights
  // to match. `worldToolState.light.sunElevation` isn't on the app's public API,
  // so the sun's DirectionalLight is located in the scene and its direction used
  // — no engine source touched.
  let sunLight = null;
  scene.traverse((o) => { if (!sunLight && o.isDirectionalLight) sunLight = o; });

  let autoHeadlights = true;
  let headlightsOn = false;
  const _sunDir = new THREE.Vector3();

  function setHeadlights(on) {
    headlightsOn = !!on;
    vehicle.setHeadlights(headlightsOn);
  }

  /**
   * Sun height → lights. Hysteresis (on below 0.10, off above 0.16) so the lamps
   * don't strobe when the sun sits right on the threshold.
   */
  function updateAutoHeadlights() {
    if (!autoHeadlights || !sunLight) return;
    _sunDir.copy(sunLight.position);
    if (sunLight.target) _sunDir.sub(sunLight.target.position);
    if (_sunDir.lengthSq() < 1e-8) return;
    const sinElev = _sunDir.normalize().y;
    if (!headlightsOn && sinElev < 0.10) setHeadlights(true);
    else if (headlightsOn && sinElev > 0.16) setHeadlights(false);
  }

  setHeadlights(false);
  updateAutoHeadlights(); // match the world we just loaded, before first frame

  // 4d) ── RACE (timing · checkpoints · ghost · fall→respawn) ────────────────
  // Wires the already-built LapTracker + GhostTrack. Air-stunt rule: falling off
  // the track respawns at the LAST SAFE GROUNDED POSE (not a checkpoint), so a
  // missed jump just puts you back on the takeoff ramp. Timing checkpoints
  // (start/checkpoint/finish pieces) drive splits + the lap clock only.
  const RACE_KEY = "modular-road-v3.rec.";
  const lap = new LapTracker({ roadWidth: 16, fallY: FALL_Y, targetLaps: 3 });
  const ghost = new GhostTrack({ sampleHz: 20 });
  const ghostMesh = createGhostMesh(CHASSIS.width, CHASSIS.height, CHASSIS.length);
  scene.add(ghostMesh);
  const _ghostPos = new THREE.Vector3();
  const _ghostQuat = new THREE.Quaternion();

  // Air-stunt fall→respawn rule. OFF for now: free-drive lets the car fall off
  // the track onto the terrain and keep driving. Game mode flips this on later.
  let raceRespawn = false;

  // Last pose the car was safely grounded on the track — the air-stunt respawn.
  const lastSafePos = new THREE.Vector3();
  const lastSafeQuat = new THREE.Quaternion();
  let lastSafeY = 0;
  let hasSafe = false;
  const _respawnPos = new THREE.Vector3();

  const recKey = () => RACE_KEY + lap.courseSignature();

  function loadRecord() {
    if (!lap.hasCourse) return;
    try {
      const raw = localStorage.getItem(recKey());
      if (!raw) return;
      const rec = JSON.parse(raw);
      if (Number.isFinite(rec.best)) lap.applyStoredBest(rec.best);
      if (Array.isArray(rec.splits)) lap.applyStoredSplits(rec.splits);
      if (rec.ghost) ghost.load(rec.ghost);
    } catch { /* corrupt / disabled — ignore */ }
  }

  function saveRecord() {
    if (!lap.hasCourse) return;
    try {
      localStorage.setItem(recKey(), JSON.stringify({
        best: lap.bestLap,
        splits: lap.bestLapSplits,
        ghost: ghost.serialize(),
      }));
    } catch { /* quota / disabled */ }
  }

  function clearRecord() {
    try { if (lap.hasCourse) localStorage.removeItem(recKey()); } catch {}
    ghost.clear();
    ghostMesh.visible = false;
    lap.bestLap = NaN;
    lap.bestLapSplits = null;
  }

  /** Set up timing for a fresh run — call on entering drive mode. */
  function beginRace() {
    // buildGates() resets timing internally, so load the stored record AFTER it
    // (reset() clears bestLap/bestLapSplits — loading before it would be wiped).
    lap.buildGates(builder.pieces);
    ghost.clear();
    loadRecord();
    ghostMesh.visible = false;
    hasSafe = false;
  }

  function handleLapEvent(ev) {
    if (ev.kind === "start") {
      ghost.beginLap();
    } else if (ev.kind === "checkpoint") {
      showSplit(ev.splitDelta);
    } else if (ev.kind === "lap") {
      if (ev.isRecord) {
        ghost.commit();
        ghostMesh.visible = true;
        saveRecord();
      } else {
        ghost.discard();
      }
      if (!ev.finished) ghost.beginLap();
    }
  }

  /** Per-tick: record the safe pose while grounded (deterministic). */
  function trackSafePose() {
    if (vehicle.groundedCount > 0) {
      const b = vehicle.body;
      lastSafePos.copy(b.pos);
      lastSafeQuat.copy(b.quat);
      lastSafeY = b.pos.y;
      hasSafe = true;
    }
  }

  /**
   * Fall handling (per frame).
   *
   * Two separate things:
   *  • Absolute void backstop — ALWAYS on. A car below FALL_Y is truly lost (fell
   *    through the world), so send it back to the start.
   *  • Air-stunt rule — GAME MODE ONLY (`raceRespawn`). Dropping FALL_DROP below
   *    the last track contact snaps you back to that safe pose.
   *
   * In free-drive (`raceRespawn` off, the default for now) the car simply FALLS
   * off the track and lands on the terrain, which is drivable — no respawn. The
   * old always-on version looped: respawn at the edge → fall → repeat.
   */
  /** Put the car back on the last pose where it was properly on the track. */
  function recoverToSafePose() {
    if (!hasSafe) { respawn(); return; }
    _respawnPos.copy(lastSafePos); _respawnPos.y += 0.5; // small lift so wheels clear
    vehicle.setSpawn(_respawnPos, lastSafeQuat);
    vehicle.respawn();
    chase.reset(); tireMarks.reset(); driftSmoke.reset();
    simAccum = 0;
  }

  function checkFall() {
    const y = vehicle.body.pos.y;

    if (y < FALL_Y) { respawn(); return; } // lost below the world

    // STUCK — always on, unlike the air-stunt rule below. Some traps have no
    // solution in the contact model at all (landing balanced on a guardrail: the
    // rail is in the solids BVH, the wheels only probe the deck BVH, so there is
    // no traction up there to drive out with). The Vehicle already tried a nudge;
    // this is the give-up path. Independent of `raceRespawn` because being
    // trapped is never a playable state, in free-drive or a race.
    if (STUCK.enabled && vehicle.stuckTime >= STUCK.respawnAfter) {
      recoverToSafePose();
      return;
    }

    if (!raceRespawn) return; // free-drive: fall to terrain and keep driving

    if (hasSafe && y < lastSafeY - FALL_DROP) recoverToSafePose();
  }

  // 5) ── CAMERA ─────────────────────────────────────────────────────────────
  // The lab's chase rig (loop-follow included). In build mode we hand the camera
  // back to the engine's OrbitControls so you can fly around and place pieces.
  // freeLook hands the camera back to orbit WHILE driving — a dev affordance for
  // inspecting the car mid-run without leaving drive mode.
  let freeLook = false;
  const chase = createChaseCamera({
    camera,
    vehicle,
    orbit: controls,
    isOrbit: () => mode === "build" || freeLook,
  });

  /**
   * The engine's editor loop re-enables `controls.enabled` every frame, so
   * disabling that alone does nothing — the individual interactions have to go
   * too, or a mouse drag orbits the camera while the chase rig fights it back.
   * (Same lesson as games/rts-v3/rtsCamera.js.)
   *
   * MOUSE MAP — matches the v3 editor exactly (v3/app/main.js:286):
   *   MIDDLE = orbit, RIGHT = pan, LEFT = free.
   * LEFT must stay null so the placement gizmo and click-to-place get it. The
   * engine's own syncOrbitMouseBindings() sets LEFT back to ROTATE whenever its
   * editorMode is "view", so this is re-asserted every frame below rather than
   * set once. (Going through app.setEditorMode() to suppress that would drag in
   * a pile of engine tooling — "road" mode would switch on the Smart Road
   * system — so re-asserting the three buttons is the narrower fix.)
   */
  // The engine calls controls.update() every frame, and OrbitControls.update()
  // ALWAYS ends with camera.lookAt(controls.target) + a polar-angle clamp —
  // ignoring `enabled`. That overrode the chase rig's look-ahead + loop-roll every
  // frame, and since the two run in separate rAFs the winner alternated → violent
  // shake (worst in loops, where the up-vectors fought). While the chase owns the
  // camera (drive, not free-look) we neuter that call to a no-op and restore it
  // for orbit modes. Saved bound so restore is exact.
  const _origControlsUpdate = controls.update.bind(controls);
  const _noopUpdate = () => {};

  function applyControlMode() {
    const orbitting = mode === "build" || freeLook;
    controls.enableRotate = orbitting;
    controls.enablePan = orbitting;
    controls.enableZoom = orbitting;
    // Chase owns the camera in normal drive → stop the engine's OrbitControls from
    // stomping it; orbit modes get the real update back.
    controls.update = orbitting ? _origControlsUpdate : _noopUpdate;
    syncMouseButtons();
    if (orbitting) controls.update();
  }

  function syncMouseButtons() {
    const mb = controls.mouseButtons;
    if (!mb) return;
    mb.LEFT = null; // always free — gizmo / placement own the left button
    mb.MIDDLE = mode === "build" ? THREE.MOUSE.ROTATE : null;
    mb.RIGHT = mode === "build" ? THREE.MOUSE.PAN : null;
  }

  // 6) ── INPUT (the game OWNS the keyboard) ─────────────────────────────────
  // The v3 editor binds its shortcuts on window in the BUBBLE phase, gated only
  // on `!playMode.active` — and this game isn't play mode, so every editor
  // letter-shortcut (N=spawn, mode keys…) is live under us. Our palette also
  // listens in bubble, and the editor registered first, so a bubble listener
  // can't preempt it. The only interception that beats the editor is CAPTURE.
  //
  // So the game takes the keyboard outright: one capture-phase handler that
  // SWALLOWS every non-form key (nothing reaches the editor) and implements the
  // whole keymap itself — drive controls AND the build shortcuts the palette
  // used to own. The palette's own key listener simply stops receiving events
  // (its mouse/tile UI is unaffected); future editor shortcuts can't leak.
  const DRIVE_KEYS = new Set([
    "keyw", "keya", "keys", "keyd", "keyq", "keye", "space",
    "arrowup", "arrowdown", "arrowleft", "arrowright",
  ]);
  const DEG15 = Math.PI / 12;

  const isFormField = (t) =>
    t instanceof HTMLInputElement ||
    t instanceof HTMLSelectElement ||
    t instanceof HTMLTextAreaElement;

  function handleBuildKey(e, code) {
    // Piece editing takes precedence while a placed piece is selected (right-click).
    const sel = builder.selectedPiece;
    if (sel) {
      switch (code) {
        case "escape": builder.deselectPiece(); paletteUi?.refreshStatus?.(); devPanel?.refresh(); return;
        case "keyw": builder.setPlacementGizmoMode("translate"); return; // move the whole chain
        case "keye": builder.setPlacementGizmoMode("rotate"); return;    // tilt this piece + downstream
        case "keyl": builder.levelPiece(sel); devPanel?.refresh(); return; // reset tilt
        case "delete": case "backspace":
          builder.deletePiece(sel); paletteUi?.refreshStatus?.(); devPanel?.refresh(); return;
        case "enter": // replace the selected piece with the active palette piece
          builder.replacePiece(sel, builder.activePieceId);
          paletteUi?.refreshStatus?.(); devPanel?.refresh(); return;
        case "keyi": // insert the active piece just before the selection
          builder.insertPieceBefore(sel, builder.activePieceId);
          paletteUi?.refreshStatus?.(); devPanel?.refresh(); return;
      }
      // Any other key (piece hotkeys, etc.) falls through to normal handling.
    }

    // Piece hotkeys (1–9, 0, letters) select the active piece.
    const byKey = PIECE_CATALOG.find((p) => p.key && p.key === e.key);
    if (byKey) {
      builder.setActivePiece(byKey.id);
      paletteUi?.renderPieces?.();
      paletteUi?.refreshStatus?.();
      return;
    }
    switch (code) {
      case "keyr": builder.flip(); break;
      case "keyq": if (builder.freePlaceMode) builder.rotateFreeYaw(DEG15); break;
      case "keye":
        if (builder.freePlaceMode) {
          if (e.shiftKey) builder.setPlacementGizmoMode("rotate");
          else builder.rotateFreeYaw(-DEG15);
        }
        break;
      case "keyw": if (builder.freePlaceMode) builder.setPlacementGizmoMode("translate"); break;
      case "enter": case "space": builder.place(); break;
      case "backspace": builder.undo(); break;
      case "keyn": seedChainAtSpawn({ atCursor: true }); break; // new chain at the sky cursor
      case "bracketleft": builder.cycleChain(-1); break;
      case "bracketright": builder.cycleChain(1); break;
      default: return;
    }
    paletteUi?.refreshStatus?.();
  }

  // Keys whose browser default we suppress (page scroll / history-back). Letters
  // and digits have no default worth blocking, and we deliberately DON'T
  // preventDefault F-keys / Tab / refresh — only stopPropagation, which blocks
  // the editor's JS listeners without touching browser/OS shortcuts.
  const PREVENT_DEFAULT = new Set([
    "space", "arrowup", "arrowdown", "arrowleft", "arrowright", "backspace",
  ]);

  addEventListener("keydown", (e) => {
    if (isFormField(e.target)) return; // let the dev panel / any text field type
    // Let Ctrl/Meta/Alt combos through (browser + OS shortcuts). The editor's own
    // shortcuts are all unmodified, so this still blocks every one of them.
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    const code = e.code.toLowerCase();
    keys[code] = true;

    // Block the editor (and our now-redundant palette listener) from seeing this
    // key. stopImmediatePropagation is harmless to browser shortcuts — those
    // aren't cancelable via propagation, only via preventDefault (scoped below).
    e.stopImmediatePropagation();
    if (PREVENT_DEFAULT.has(code)) e.preventDefault();

    if (code === "keyb") { toggleMode(); return; }

    if (mode === "drive") {
      if (code === "keyr") respawn();
      return;
    }
    handleBuildKey(e, code); // build mode
  }, true); // ← capture phase

  addEventListener("keyup", (e) => {
    // Always clear the key regardless of modifiers — if a modifier were held at
    // release the state would otherwise stick and jam the throttle/steer.
    keys[e.code.toLowerCase()] = false;
    if (isFormField(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    e.stopImmediatePropagation();
  }, true);

  // LMB click-to-place (the lab had this; v3 only had Enter/Space). Suppressed
  // while ANY editing gizmo is being dragged, or a gizmo drag would also drop a
  // piece under the cursor.
  renderer.domElement.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || mode !== "build") return;
    if (
      props.isUsingGizmo?.() ||
      movers.isUsingGizmo?.() ||
      portals.isUsingGizmo?.() ||
      builder.isUsingPlacementGizmo?.()
    ) return;
    builder.place();
    paletteUi.refreshStatus();
  });

  // RIGHT-CLICK selects a placed piece to edit (tilt / delete / replace /
  // insert). Right is also the camera PAN button, so a stationary click selects
  // while a drag still pans — decided on pointerUP by how far the pointer moved.
  let rmbDown = null;
  renderer.domElement.addEventListener("pointerdown", (e) => {
    if (e.button === 2 && mode === "build") rmbDown = { x: e.clientX, y: e.clientY };
  });
  renderer.domElement.addEventListener("pointerup", (e) => {
    if (e.button !== 2 || mode !== "build" || !rmbDown) return;
    const moved = Math.hypot(e.clientX - rmbDown.x, e.clientY - rmbDown.y);
    rmbDown = null;
    if (moved > 6) return; // that was a pan drag, not a click
    const picked = builder.pickPiece(e.clientX, e.clientY);
    if (picked) builder.selectPiece(picked);
    else builder.deselectPiece();
    paletteUi.refreshStatus();
    devPanel?.refresh();
  });
  // Suppress the browser context menu in build mode so right-click is ours.
  renderer.domElement.addEventListener("contextmenu", (e) => {
    if (mode === "build") e.preventDefault();
  });

  // Toolbar buttons the palette does NOT wire (the lab's page owned these).
  const onClick = (id, fn) => document.getElementById(id)?.addEventListener("click", fn);
  onClick("road-drive", () => toggleMode());
  onClick("build-mode-toggle", () => toggleMode());
  onClick("road-new-chain", () => { seedChainAtSpawn({ atCursor: true }); paletteUi.refreshStatus(); });
  onClick("road-prev-chain", () => { builder.cycleChain(-1); paletteUi.refreshStatus(); });
  onClick("road-next-chain", () => { builder.cycleChain(1); paletteUi.refreshStatus(); });
  onClick("road-rebake", () => bakeCollision());

  // ── TRACK SAVE / LOAD (JSON — deliberately separate from world.v3proj) ──
  const trackCtx = () => ({
    builder,
    props,
    movers,
    portals,
    roadParams,
    guardrailParams,
    pieceParams,
    portalParams: portals.params,
  });

  onClick("road-save", () => {
    // `spawn` is wrapped around the lab's track format rather than folded into
    // modularRoadTrackIO — keeps that ported module untouched, and old tracks
    // without a spawn just resolve to the .v3proj start.
    const track = { ...exportTrack(trackCtx()), spawn: gameSpawn };
    downloadTrackJson(track, "modular-road-track.json");
  });

  const trackFileInput = createTrackFileInput((data) => {
    const res = importTrack(data, trackCtx());
    if (!res.ok) {
      console.warn("[ModularRoad-v3] track load failed:", res.error);
      alert(`Could not load track: ${res.error}`);
      return;
    }
    gameSpawn = data.spawn ?? null;
    updateSpawnMarker();
    bakeCollision();
    paletteUi.refreshStatus();
  });
  document.body.appendChild(trackFileInput);
  onClick("road-load", () => trackFileInput.click());

  const gamepad = createGamepadInput();
  /** Set by readControls() when the pad's respawn button goes down this frame. */
  let padRespawnPressed = false;

  /**
   * Merge keyboard + gamepad into one control frame.
   *
   * Merged PER AXIS rather than picking one device: a pad resting at centre must
   * never block the keys, and a hand on the keyboard must never be overridden by
   * stick drift. Whichever device is actually deflected wins its own axis.
   *
   * `analog` tells the Vehicle to skip the keyboard steering ramp — it's only
   * true when the STICK is supplying the steering, so d-pad and keyboard both
   * still get the ramp they need.
   *
   * Called exactly once per frame: the pad's respawn button is edge-detected
   * inside read(), so a second call would swallow the press.
   */
  function readControls() {
    const left = keys.keya || keys.arrowleft;
    const right = keys.keyd || keys.arrowright;
    const fwd = keys.keyw || keys.arrowup;
    const back = keys.keys || keys.arrowdown;
    const kbSteer = (left ? 1 : 0) - (right ? 1 : 0);
    const kbThrottle = (fwd ? 1 : 0) - (back ? 1 : 0);
    const kbYaw = (keys.keye ? 1 : 0) - (keys.keyq ? 1 : 0);

    const gp = gamepad.read();
    padRespawnPressed = !!gp?.respawnPressed;
    if (!gp) {
      return {
        steerTarget: kbSteer,
        throttle: kbThrottle,
        handbrake: !!keys.space,
        yaw: kbYaw,
        analog: false,
      };
    }
    return {
      steerTarget: kbSteer !== 0 ? kbSteer : gp.steerTarget,
      throttle: kbThrottle !== 0 ? kbThrottle : gp.throttle,
      handbrake: !!keys.space || gp.handbrake,
      yaw: kbYaw !== 0 ? kbYaw : gp.yaw,
      analog: kbSteer === 0 && gp.analog,
    };
  }

  // ── SPAWN ──────────────────────────────────────────────────────────────────
  // Where the car drops on entering drive mode / after a fall. Priority:
  //   1. gameSpawn — set by the user in the dev panel, saved WITH THE TRACK.
  //   2. the track's Start piece (so a sky track just works — hit drive, you're
  //      on it, facing down-track).
  //   3. the first placed piece.
  //   4. the .v3proj player start.
  //   5. world origin.
  // An air track's spawn has a REAL Y (up on the track), so the full pose is
  // stored, not just XZ + terrain height.
  let gameSpawn = null; // {x, y, z, yaw} | null

  const _inPos = new THREE.Vector3();
  const _outPos = new THREE.Vector3();
  const _fwd = new THREE.Vector3();

  /**
   * On-deck, down-track pose from a placed piece — the car sits on the piece's
   * surface a little past its entry edge, facing the way the track runs.
   */
  function poseFromPiece(p) {
    _inPos.setFromMatrixPosition(p.connectorIn);
    _outPos.setFromMatrixPosition(p.connectorOut);
    _fwd.copy(_outPos).sub(_inPos);
    if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, -1);
    _fwd.normalize();
    // respawn() faces the car by axisAngle(Y, yaw + PI) on the car's +Z forward,
    // so this yaw makes +Z point along the track. (Same convention setSpawnToCar
    // stores: yaw = eulerY − PI.)
    const yaw = Math.atan2(_fwd.x, _fwd.z) - Math.PI;
    return {
      x: _inPos.x + _fwd.x * 2, // a touch into the piece, off the entry seam
      y: _inPos.y,
      z: _inPos.z + _fwd.z * 2,
      yaw,
    };
  }

  function resolveSpawn() {
    if (gameSpawn) return gameSpawn;
    const start = builder.pieces.find((p) => p.id === "start");
    if (start) return poseFromPiece(start);
    if (builder.pieces.length) return poseFromPiece(builder.pieces[0]);
    const sp = app.getSpawnPoint?.() ?? null;
    if (sp) return { x: sp.x, y: sp.y, z: sp.z, yaw: sp.yaw ?? 0 };
    return { x: 0, y: app.getWorldHeight(0, 0), z: 0, yaw: 0 };
  }

  // Marker so the spawn is visible while building — a green arrow pointing the
  // way the car will face. One draw, build-mode only.
  const spawnMarker = new THREE.Group();
  spawnMarker.name = "RoadSpawnMarker";
  {
    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(0.6, 2.2, 12),
      new THREE.MeshStandardMaterial({ color: 0x35e07a, emissive: 0x0c5028, roughness: 0.5 }),
    );
    cone.rotation.x = Math.PI / 2; // point +Z (the car's forward)
    cone.position.z = 0.4;
    spawnMarker.add(cone);
  }
  scene.add(spawnMarker);

  function updateSpawnMarker() {
    const s = resolveSpawn();
    spawnMarker.position.set(s.x, s.y + 0.6, s.z);
    spawnMarker.rotation.set(0, s.yaw, 0);
  }

  /** Capture the car's current pose as the spawn (drive to a good start, click). */
  function setSpawnToCar() {
    const b = vehicle.body;
    const e = new THREE.Euler().setFromQuaternion(b.quat, "YXZ");
    gameSpawn = { x: b.pos.x, y: b.pos.y, z: b.pos.z, yaw: e.y - Math.PI };
    updateSpawnMarker();
  }

  /** Capture the current build cursor (open chain end) as the spawn. */
  function setSpawnToCursor() {
    const p = new THREE.Vector3().setFromMatrixPosition(builder.currentConnector);
    gameSpawn = { x: p.x, y: p.y, z: p.z, yaw: builder.freeYaw ?? 0 };
    updateSpawnMarker();
  }

  function clearSpawn() { gameSpawn = null; updateSpawnMarker(); }

  // Build altitude (m above terrain). This IS the sky-stunt mode, so a fresh
  // chain floats up here by default; pieces auto-chain from the anchor, so the
  // whole track floats without dragging each piece up.
  let buildHeight = DEFAULT_BUILD_HEIGHT;

  // ── BUILD GRID ──────────────────────────────────────────────────────────────
  // A visual reference plane at the active chain's height. In an empty sky there
  // is nothing to judge position against, so the grid is what makes snapped
  // building legible — and it shows the cells anchors actually land on.
  const GRID_SPAN = 400;
  let buildGrid = null;
  let gridVisible = true;

  function rebuildGrid() {
    if (buildGrid) { buildGrid.geometry.dispose(); buildGrid.material.dispose(); scene.remove(buildGrid); }
    const divisions = Math.max(4, Math.round(GRID_SPAN / builder.snapStep));
    buildGrid = new THREE.GridHelper(GRID_SPAN, divisions, 0x5fd4ff, 0x39424e);
    buildGrid.material.transparent = true;
    buildGrid.material.opacity = 0.35;
    buildGrid.material.depthWrite = false;
    buildGrid.frustumCulled = false;
    buildGrid.visible = false;
    scene.add(buildGrid);
  }
  rebuildGrid();

  const _gridPos = new THREE.Vector3();
  function updateBuildGrid() {
    if (!buildGrid) return;
    const show = gridVisible && mode === "build";
    buildGrid.visible = show;
    if (!show) return;
    // Follow the open connector, but quantised to the grid so it doesn't crawl.
    _gridPos.setFromMatrixPosition(builder.currentConnector);
    const s = builder.snapStep;
    buildGrid.position.set(
      Math.round(_gridPos.x / s) * s,
      _gridPos.y,
      Math.round(_gridPos.z / s) * s,
    );
  }

  // ── GAP PREVIEW (jump authoring) ────────────────────────────────────────────
  // Ballistic arc from the open connector at a reference speed → shows where a
  // jump lands so you can place the landing. Gravity matches the vehicle's.
  const gapPreview = new GapPreview({ scene, gravity: GRAVITY });
  let gapPreviewOn = true;
  let refSpeed = 25;       // m/s launch speed the arc assumes
  let landingDrop = 0;     // m below launch height to mark the landing
  let lastLanding = null;  // last computed landing (for Snap landing)

  /** Start a new chain on the previewed landing point, heading down-arc. */
  function snapLanding() {
    if (!lastLanding) return;
    const v = lastLanding.vel;
    // beginNewChain's freeYaw maps to travel = (0,0,-1) rotated by yaw, so this
    // yaw makes the new chain head along the landing's horizontal velocity.
    const yaw = Math.atan2(-v.x, -v.z);
    builder.beginNewChain(lastLanding.pos.clone(), yaw);
    if (controls.target) { controls.target.copy(lastLanding.pos); controls.update?.(); }
    builder.refreshGhost?.();
    paletteUi?.refreshStatus?.();
  }

  /**
   * Seat a fresh chain floating at `buildHeight` above terrain.
   *
   * `atCursor` seeds where the orbit camera is looking (build where you're
   * looking); otherwise at the spawn XZ. Height is always terrain + buildHeight,
   * so the anchor is in the sky and the whole chain floats from it.
   */
  function seedChainAtSpawn({ showGizmo = true, atCursor = false } = {}) {
    let x, z, yaw;
    if (atCursor && controls.target) {
      x = controls.target.x; z = controls.target.z; yaw = builder.freeYaw ?? 0;
    } else {
      const s = resolveSpawn();
      x = s.x; z = s.z; yaw = s.yaw;
    }
    const y = app.getWorldHeight(x, z) + buildHeight;
    builder.beginNewChain(new THREE.Vector3(x, y, z), yaw);
    // Frame the anchor so building in the sky doesn't leave you staring at bare
    // ground far below it.
    if (controls.target) { controls.target.set(x, y, z); controls.update?.(); }
    // beginNewChain always pops the placement gizmo up. Right when the user asked
    // for a new chain, but not on boot: it's ~13 draw calls of grab handles
    // floating before anyone has touched anything. deselectPlacement only hides
    // it — freePlaceMode + the anchor survive, so N brings it straight back.
    if (!showGizmo) builder.deselectPlacement();
    builder.refreshGhost?.();
  }

  /** Drop the car at the resolved spawn (user → Start piece → first piece → …). */
  function respawn() {
    const s = resolveSpawn();
    // Every source resolves to a surface/deck-level pose, so a small constant
    // lift lets the wheels settle onto it (a custom car-pose is already ~COM
    // height, so it just drops a touch — harmless).
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), s.yaw + Math.PI);
    vehicle.setSpawn(new THREE.Vector3(s.x, s.y + SPAWN_LIFT, s.z), q);
    vehicle.respawn();
    chase.reset();
    // Without these the old skid ribbon and smoke puffs stay stretched across
    // the map from wherever the car was to where it just teleported.
    tireMarks.reset();
    driftSmoke.reset();
    simAccum = 0;
  }

  const paletteEl = document.getElementById("palette");
  const hintEl = document.getElementById("hint");

  // ── RACE HUD ────────────────────────────────────────────────────────────────
  const hud = document.getElementById("race-hud");
  const hudTime = document.getElementById("race-time");
  const hudLap = document.getElementById("race-lap");
  const hudNext = document.getElementById("race-next");
  const hudBest = document.getElementById("race-best");
  const hudFlash = document.getElementById("race-flash");
  const hudSplit = document.getElementById("race-split");
  const hudSpeed = document.querySelector("#race-speed .v");
  const hudGaugeVal = document.getElementById("gauge-val");
  const hudGear = document.getElementById("race-gear");
  // Auto gearbox is DISPLAY-ONLY — the car has no transmission (see gearbox.js).
  const gearbox = createGearbox();
  const _hudFwd = new THREE.Vector3();
  let _hudStroke = "";
  let _hudGearLabel = "";
  let _hudGearCls = "";
  let shiftFlash = 0;
  let splitTimer = 0;

  function showSplit(delta) {
    if (!Number.isFinite(delta) || !hudSplit) return;
    const ahead = delta < 0;
    hudSplit.textContent = (ahead ? "−" : "+") + Math.abs(delta).toFixed(2);
    hudSplit.className = `show ${ahead ? "ahead" : "behind"}`;
    splitTimer = 2.0;
  }

  function updateRaceHud(dt) {
    if (!hud) return;
    hudTime.textContent = formatLapTime(lap.running ? lap.currentTime : 0);
    hudLap.textContent = `Lap ${lap.currentLapNumber}/${lap.targetLaps}`;
    hudNext.textContent = lap.hasCourse
      ? lap.nextLabel
      : "No timing — place a Start piece";
    hudBest.textContent = `Best ${formatLapTime(lap.bestLap)}`;

    // Centre flash mirrors the LapTracker's own message (GO! / RECORD / FINISH).
    if (lap.messageTimer > 0 && lap.message) {
      hudFlash.textContent = lap.message;
      const good = /RECORD|GO|FINISH/.test(lap.message);
      hudFlash.className = `show ${good ? "good" : ""}`;
    } else {
      hudFlash.className = "";
    }

    if (splitTimer > 0) {
      splitTimer -= dt;
      if (splitTimer <= 0) hudSplit.className = "";
    }

    const speedMs = Math.hypot(vehicle.body.vel.x, vehicle.body.vel.z);
    if (hudSpeed) hudSpeed.textContent = String(Math.round(speedMs * 3.6));

    // Tach + gear. Forward speed is SIGNED (dot with the car's own forward) so
    // the box can tell reversing from sliding backwards — a magnitude can't.
    _hudFwd.set(0, 0, 1).applyQuaternion(vehicle.body.quat);
    const g = gearbox.update(speedMs, TIRE.topSpeed, vehicle.body.vel.dot(_hudFwd));

    if (hudGaugeVal) {
      // pathLength=100 on the arc ⇒ dashoffset is just "100 − percent".
      const shown = Math.min(1, g.rpm);
      hudGaugeVal.setAttribute("stroke-dashoffset", String(100 - shown * 100));
      const hot = g.rpm >= GEARBOX.redline;
      const stroke = g.reverse ? "#ffd24a" : hot ? "#ff6b45" : "#4a9eff";
      // Only touch the attribute on change — this runs every frame.
      if (stroke !== _hudStroke) { hudGaugeVal.setAttribute("stroke", stroke); _hudStroke = stroke; }
    }
    if (hudGear) {
      if (g.label !== _hudGearLabel) { hudGear.textContent = g.label; _hudGearLabel = g.label; }
      if (g.shifted) shiftFlash = 0.18; // brief upshift blink
      if (shiftFlash > 0) shiftFlash -= dt;
      const cls = g.reverse ? "reverse"
        : shiftFlash > 0 ? "shift"
        : g.rpm >= GEARBOX.redline ? "redline" : "";
      if (cls !== _hudGearCls) { hudGear.className = cls; _hudGearCls = cls; }
    }
  }

  function toggleMode() {
    mode = mode === "build" ? "drive" : "build";
    const driving = mode === "drive";
    // Editing systems own the mouse in build mode only — leaving them live while
    // driving would keep their gizmos grabbing clicks behind the car.
    props.setEnabled(!driving);
    movers.setEnabled(!driving);
    portals.setBuildEnabled(!driving);

    if (driving) {
      bakeCollision(); // drive the track as it stands right now
      setMergedTrack(true); // ~4 draws for the whole track instead of ~1/piece
      builder.setGhostVisible(false);
      builder.deselectPlacement?.();
      builder.deselectPiece?.(); // clear any edit selection before racing
      props.deselect();
      movers.deselect();
      vehicle.enabled = true;
      if (vehicle.group) vehicle.group.visible = true;
      respawn();
      beginRace(); // gates from the current track + load its record
    } else {
      setMergedTrack(false); // back to editable pieces
      builder.setGhostVisible(true);
      vehicle.enabled = false;
      ghostMesh.visible = false;
    }
    if (driving) { gapPreview.setVisible(false); if (buildGrid) buildGrid.visible = false; } // build-only aids
    spawnMarker.visible = !driving; // a build-time guide; hidden while racing
    if (hud) hud.classList.toggle("on", driving);
    if (paletteEl) paletteEl.style.display = driving ? "none" : "";
    if (hintEl) hintEl.dataset.mode = mode;
    applyControlMode();
    devPanel?.renderMode(); // B key and the panel button share this path
  }

  // Start in build mode: no track exists yet on a fresh world.
  vehicle.enabled = false;
  if (vehicle.group) vehicle.group.visible = false;
  builder.setGhostVisible(true);
  props.setEnabled(true);
  movers.setEnabled(true);
  portals.setBuildEnabled(true);
  applyControlMode();
  // Put the build anchor on the ground rather than at origin/y=0, but leave the
  // gizmo hidden until the user actually starts placing (see seedChainAtSpawn).
  seedChainAtSpawn({ showGizmo: false });
  bakeCollision();
  updateSpawnMarker();
  if (paletteEl) paletteEl.style.display = ""; // boots in build mode
  paletteUi.refreshStatus();

  // 6b) ── DEV PANEL ─────────────────────────────────────────────────────────
  // Right-hand developer UI, styled like the v3 editor's right panel. This page
  // is the DEV page for the game (same relationship rts.html has to rts-v3) —
  // player-facing UI is the palette and the hint bar.
  let worldName = boot.name;
  devPanel = createRoadDevPanel({
    app,
    params: { TIRE, AERO, DRIVETRAIN, DECK, SOLID, BODYLEAN, HEADLIGHTS, glowPropParams },
    game: {
      setSpawnToCar,
      setSpawnToCursor,
      clearSpawn,
      hasSpawn: () => gameSpawn != null,
      setHeadlights,
      getHeadlights: () => headlightsOn,
      setAutoHeadlights: (on) => { autoHeadlights = !!on; updateAutoHeadlights(); },
      // Re-push HEADLIGHTS params onto the rig after a slider moves.
      refreshLights: () => vehicle.applyHeadlightParams(),
      // glowPropParams is shared by every placed glow prop; this pushes the new
      // values onto them (emissive is a live node, so bloom follows for free).
      refreshGlowProps: () => props.applyGlowParams(),
      getMode: () => mode,
      toggleMode,
      respawn,
      bakeCollision,
      setCollisionDebug,
      setFreeLook: (on) => {
        freeLook = !!on;
        applyControlMode(); // flips the controls.update patch + interactions FIRST
        // Then center the orbit on the car so it starts framed on it (the real
        // OrbitControls, just restored, takes over from here).
        if (freeLook) { controls.target.copy(vehicle.body.pos); controls.update(); }
        else chase.reset(); // don't sweep back from wherever orbit left it
      },
      getWheelStyle: () => vehicle.wheelStyle,
      setWheelStyle: (s) => vehicle.setWheelStyle(s),
      hasWheelModel: () => vehicle.hasWheelModel,
      setInstancing: (on) => builder.setInstancing(on),
      // Piece editing (also on right-click select + W/E/L/Del/Enter/I).
      getSelectedPieceId: () => builder.selectedPiece?.id ?? null,
      deselectPiece: () => { builder.deselectPiece(); paletteUi.refreshStatus(); },
      deleteSelected: () => {
        if (builder.selectedPiece) builder.deletePiece(builder.selectedPiece);
        paletteUi.refreshStatus();
      },
      replaceSelected: () => {
        if (builder.selectedPiece) builder.replacePiece(builder.selectedPiece, builder.activePieceId);
        paletteUi.refreshStatus();
      },
      insertBeforeSelected: () => {
        if (builder.selectedPiece) builder.insertPieceBefore(builder.selectedPiece, builder.activePieceId);
        paletteUi.refreshStatus();
      },
      getSelectedTilt: () =>
        builder.selectedPiece ? builder.pieceTiltDeg(builder.selectedPiece) : { pitch: 0, roll: 0 },
      levelSelected: () => { if (builder.selectedPiece) builder.levelPiece(builder.selectedPiece); },
      isSelectedGap: () => builder.selectedPiece?.id === "gap",
      makeSelectedGap: () => {
        // FLAT empty-space spacer sized to the piece (level hole, downstream
        // unmoved). Reversible: gaps stay selectable, so replace to fill it in.
        if (builder.selectedPiece) builder.makeGap(builder.selectedPiece);
        paletteUi.refreshStatus();
      },
      roadUniforms: roadMaterial._roadUniforms,
      railMaterial,
      getLinesOn: () => roadMaterial._roadUniforms.linesOn.value > 0.5,
      setLinesOn: (on) => { roadMaterial._roadUniforms.linesOn.value = on ? 1 : 0; },
      setTireMarksEnabled: (on) => {
        tireMarks.mesh.visible = !!on;
        if (!on) tireMarks.reset();
      },
      setDriftSmokeEnabled: (on) => {
        driftSmoke.settings.enabled = !!on;
        driftSmoke.mesh.visible = !!on;
        if (!on) driftSmoke.reset();
      },
      cameraParams: chase.params,
      audioState,
      vehicleAudioSettings,
      // Build
      getBuildHeight: () => buildHeight,
      setBuildHeight: (m) => { buildHeight = m; },
      reseedChain: () => { seedChainAtSpawn({ atCursor: true }); paletteUi.refreshStatus(); },
      // Anchor tilt (banked landing strips). The gizmo does the tilting —
      // Shift+E for the rotate gizmo, which is full 3-axis on a chain anchor —
      // this is just a readout + a one-click reset.
      getAnchorTilt: () => builder.anchorTiltDeg?.() ?? { pitch: 0, roll: 0 },
      levelAnchor: () => { builder.levelAnchor(); paletteUi.refreshStatus(); },
      // Grid snapping
      getSnapOn: () => builder.snapEnabled,
      setSnapOn: (on) => builder.setSnap({ enabled: on }),
      getSnapStep: () => builder.snapStep,
      setSnapStep: (m) => { builder.setSnap({ step: m }); rebuildGrid(); },
      getSnapYaw: () => builder.snapYawDeg,
      setSnapYaw: (d) => builder.setSnap({ yawDeg: d }),
      getGridVisible: () => gridVisible,
      setGridVisible: (on) => { gridVisible = !!on; },
      // Gap authoring
      getGapPreview: () => gapPreviewOn,
      setGapPreview: (on) => { gapPreviewOn = !!on; if (!on) gapPreview.setVisible(false); },
      getRefSpeed: () => refSpeed,
      setRefSpeed: (v) => { refSpeed = v; },
      getLandingDrop: () => landingDrop,
      setLandingDrop: (v) => { landingDrop = v; },
      snapLanding,
      // Race
      setRaceRespawn: (on) => { raceRespawn = !!on; },
      getRaceRespawn: () => raceRespawn,
      setTargetLaps: (n) => lap.setTargetLaps(n),
      getTargetLaps: () => lap.targetLaps,
      clearRecord,
      getBestLap: () => lap.bestLap,
      getPieceCount: () => builder.pieces.length,
      getCollisionTriCount: () =>
        deckBvh.triCount + solidsBvh.triCount +
        moverDeckBvh.triCount + moverSolidsBvh.triCount,
      getWorldName: () => worldName,
      async loadWorldFile(file) {
        const res = await loadWorldFromFile(app, file, { onStatus: () => {} });
        if (res?.loaded) {
          worldName = res.name;
          await app.refreshWorldHeights?.();
          // The new terrain is a different shape — re-seat the build anchor and
          // re-bake, or the track anchor is left hanging over the old heightfield.
          seedChainAtSpawn();
          bakeCollision();
        }
        return res;
      },
    },
  });

  // 7) ── THE GAME LOOP ──────────────────────────────────────────────────────
  // One rAF drives game state; the ENGINE renders the scene on its own loop.
  // Physics advances only in whole FIXED_DT ticks so handling, lap times and
  // ghosts stay framerate-independent; visuals interpolate the leftover.
  let last = performance.now();
  let simAccum = 0;
  let autoLightAccum = 0;
  const tick = () => {
    const now = performance.now();
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;

    // Re-assert every frame: the engine's syncOrbitMouseBindings() keeps handing
    // the LEFT button back to orbit, which would steal it from the gizmo.
    syncMouseButtons();

    if (mode === "drive") {
      const input = readControls();
      // Pad Y mirrors the keyboard's R. Without it a gamepad player has to reach
      // back to the keyboard after every fall.
      if (padRespawnPressed) respawn();
      simAccum += dt;
      let ticks = Math.floor(simAccum / FIXED_DT);
      if (ticks > MAX_SIM_TICKS) {
        ticks = MAX_SIM_TICKS;
        simAccum = ticks * FIXED_DT; // drop the backlog
      }
      simAccum -= ticks * FIXED_DT;

      // Everything that affects the OUTCOME advances in whole fixed ticks —
      // movers, the car, boost fields, portals — so the result is identical at
      // any framerate. Visuals interpolate the leftover fraction afterwards.
      const hasMovers = movers.getMovers().length > 0;
      for (let i = 0; i < ticks; i++) {
        movers.update(FIXED_DT);
        if (hasMovers) {
          // Only the movers' own (small) BVH — the static track BVH is untouched.
          // And only the movers' subtree is re-transformed: scene.updateMatrixWorld
          // would walk the whole world (terrain, foliage, props) every tick to
          // pick up a couple of platforms.
          movers.group.updateMatrixWorld(true);
          rebakeMovers();
        }
        vehicle.tick(input);
        props.applyFields(vehicle, FIXED_DT);      // boost pads etc.
        portals.updateDrive(FIXED_DT, vehicle);

        // Timing runs INSIDE the fixed tick so splits/lap times are quantised to
        // the deterministic clock (framerate-independent records).
        const ev = lap.update(FIXED_DT, vehicle.body.pos, vehicle.body.vel);
        if (ev) handleLapEvent(ev);
        if (lap.running) ghost.record(lap.currentTime, vehicle.body.pos, vehicle.body.quat);
        trackSafePose(); // remember where we were last grounded on the track
      }
      vehicle.syncVisuals(dt, simAccum / FIXED_DT);

      // FX are cosmetic, so they run once per FRAME on real dt (not per tick) —
      // they must not affect the deterministic outcome.
      tireMarks.update(vehicle);
      driftSmoke.updateFromVehicle(vehicle, camera, dt, keys);

      checkFall(); // air-stunt: dropped off the track → last safe grounded pose

      // Ghost replay: park it at the live lap time. Hidden until a lap is running.
      if (lap.running && ghost.hasGhost && ghost.sampleAt(lap.currentTime, _ghostPos, _ghostQuat)) {
        ghostMesh.position.copy(_ghostPos);
        ghostMesh.quaternion.copy(_ghostQuat);
        ghostMesh.visible = true;
      } else if (ghostMesh.visible && !lap.running) {
        ghostMesh.visible = false;
      }

      updateRaceHud(dt);

      // Keep the engine's terrain clipmap streaming around the car. The chase
      // rig owns camera.position/up, but `controls.target` is what the engine
      // centres terrain on, so it has to track the car too. Use the render pose
      // (matches the camera) so nothing stair-steps.
      controls.target.copy(vehicle.renderPos);
    } else {
      // BUILD mode — refresh the jump arc from the current open connector. Cheap
      // (a few hundred vec ops); build mode isn't perf-critical.
      if (gapPreviewOn) {
        gapPreview.setVisible(true);
        lastLanding = gapPreview.update(builder.currentConnector, refSpeed, landingDrop);
      } else {
        gapPreview.setVisible(false);
      }
      updateBuildGrid();
    }

    // Portal doors animate (shimmer / ring spin) in BOTH modes — this was missing,
    // so doors sat frozen.
    portals.updateVisuals(dt);

    chase.update(dt);

    // Per-frame audio pump — drives every layer's gain/pitch from the car's
    // state. WITHOUT THIS CALL NOTHING PLAYS AT ALL. Runs unconditionally (not
    // just in drive mode) so layers fade out cleanly when the car is parked or
    // you switch back to build.
    audioSystem.update(dt);

    // The sun can be moved live from the v3 world panel, so re-check rather than
    // only sampling at boot. Throttled — this is a scene lookup, not per-frame work.
    autoLightAccum += dt;
    if (autoLightAccum >= AUTO_LIGHT_INTERVAL) {
      autoLightAccum = 0;
      const wasOn = headlightsOn;
      updateAutoHeadlights();
      if (wasOn !== headlightsOn) devPanel?.refresh();
    }

    app._roadRaf = requestAnimationFrame(tick);
  };
  app._roadRaf = requestAnimationFrame(tick);

  onStatus("ready");

  const handle = {
    app,
    builder,
    vehicle,
    bakeCollision,
    respawn,
    toggleMode,
    get mode() { return mode; },
    world: boot,
  };
  window.__roadGame = handle; // console debugging (window.__road is just the engine app)
  return handle;
}
