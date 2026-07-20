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
import { PropManager, PROP_CATALOG } from "./modularRoadProps.js";
import { MoverPropManager, MOVER_CATALOG } from "./modularRoadMoverProps.js";
import { PortalManager, DEFAULT_PORTAL_PARAMS } from "./modularRoadPortals.js";
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
import { loadBootWorld, loadWorldFromFile } from "./worldLoader.js";
import { createRoadDevPanel } from "./devPanel.js";

/** Cap on physics ticks per frame — a long stall must not queue a huge backlog. */
const MAX_SIM_TICKS = 8;
/** Below this world Y the car is considered fallen and is respawned. */
const FALL_Y = -60;
/** How far above the terrain a freshly seeded chain's first piece sits. */
const ROAD_SEED_CLEARANCE = 0.5;

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
    onEdgesChange: () => bakeCollision(),
  });

  // 4) ── THE CAR ────────────────────────────────────────────────────────────
  const vehicle = new Vehicle({ scene, showArrows: false });
  // Chassis-corner safety floor follows the terrain instead of pinning to y=0.
  vehicle.getFloorY = (x, z) => app.getWorldHeight(x, z);

  const deckBvh = new RoadBvh();   // road decks → wheel probes
  const solidsBvh = new RoadBvh(); // guardrails + tunnel shells → chassis collision

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

    const moverCol = movers.collisionMeshes();
    decks.push(...moverCol.deck);
    solids.push(...moverCol.solids);
    const propCol = props.collisionMeshes();
    decks.push(...propCol.deck);
    solids.push(...propCol.solids);

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
    devPanel?.refresh();
  }

  /**
   * Deck-only rebake including the moving platforms' CURRENT pose.
   *
   * A moving platform's mesh travels, so a BVH baked once goes stale the moment
   * it moves and the wheels probe empty space. The lab re-bakes the deck BVH
   * every tick while any deck-mover exists — expensive, so it's gated on there
   * actually being one (see the tick loop).
   */
  function rebakeDeckWithMovers() {
    scene.updateMatrixWorld(true);
    const decks = builder.pieces
      .map((p) => p.mesh)
      .filter((m) => m && !m.userData.noCollision);
    const moverCol = movers.collisionMeshes();
    decks.push(...moverCol.deck);
    for (const dm of movers.getDeckMovers()) decks.push(dm.mesh);
    decks.push(...props.collisionMeshes().deck);
    if (!decks.length) return;
    deckBvh.bakeFromMeshes(decks);
    ground.setRoadBvh(deckBvh.baked ? deckBvh : null);
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
    add(deckBvh, 0xff5060);   // decks = red
    add(solidsBvh, 0x5080ff); // solids = blue
  }

  function setCollisionDebug(on) {
    debugOn = !!on;
    debugGroup.visible = debugOn;
    refreshCollisionDebug();
  }

  // 4b) ── DRIVING FX + AUDIO ────────────────────────────────────────────────
  const tireMarks = new ModularRoadTireMarks(scene);
  const driftSmoke = new ModularRoadDriftSmoke(scene, { ...DEFAULT_DRIFT_SMOKE_SETTINGS });

  // DEFAULT_MIXER starts muted (muteAll: true) — the lab exposes a mixer panel to
  // unmute. There's no such panel here yet, so start audible; browsers still
  // require a gesture before anything plays, hence unlock() on first input.
  // Deep-copy `buses`: a shallow spread would share that object with the
  // exported DEFAULT_MIXER, so the dev panel's volume slider would write back
  // into the module-level default.
  const audioState = {
    ...DEFAULT_MIXER,
    muteAll: false,
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
  function applyControlMode() {
    const orbitting = mode === "build";
    controls.enableRotate = orbitting;
    controls.enablePan = orbitting;
    controls.enableZoom = orbitting;
    syncMouseButtons();
    if (orbitting) controls.update?.();
  }

  function syncMouseButtons() {
    const mb = controls.mouseButtons;
    if (!mb) return;
    mb.LEFT = null; // always free — gizmo / placement own the left button
    mb.MIDDLE = mode === "build" ? THREE.MOUSE.ROTATE : null;
    mb.RIGHT = mode === "build" ? THREE.MOUSE.PAN : null;
  }

  // 6) ── INPUT ──────────────────────────────────────────────────────────────
  // buildRoadPaletteUI() installs the BUILD-mode shortcuts itself (piece hotkeys,
  // R flip, Q/E yaw, Enter/Space place, Backspace undo) — so this handler only
  // owns the mode toggle and the DRIVE controls, and must not shadow those keys
  // while building.
  // Arrows mirror WASD. preventDefault on them matters more than on WASD —
  // otherwise arrow keys scroll the page while you're driving.
  const DRIVE_KEYS = new Set([
    "keyw", "keya", "keys", "keyd", "keyq", "keye", "space",
    "arrowup", "arrowdown", "arrowleft", "arrowright",
  ]);

  addEventListener("keydown", (e) => {
    if (e.target instanceof HTMLInputElement) return;
    const code = e.code.toLowerCase();
    keys[code] = true;

    if (code === "keyb") { toggleMode(); return; }
    if (mode !== "drive") return; // build mode belongs to the palette

    if (DRIVE_KEYS.has(code)) e.preventDefault();
    if (code === "keyr") respawn();
  });
  addEventListener("keyup", (e) => { keys[e.code.toLowerCase()] = false; });

  // Toolbar buttons the palette does NOT wire (the lab's page owned these).
  const onClick = (id, fn) => document.getElementById(id)?.addEventListener("click", fn);
  onClick("road-drive", () => toggleMode());
  onClick("build-mode-toggle", () => toggleMode());
  onClick("road-new-chain", () => { seedChainAtSpawn(); paletteUi.refreshStatus(); });
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
    downloadTrackJson(exportTrack(trackCtx()), "modular-road-track.json");
  });

  const trackFileInput = createTrackFileInput((data) => {
    const res = importTrack(data, trackCtx());
    if (!res.ok) {
      console.warn("[ModularRoad-v3] track load failed:", res.error);
      alert(`Could not load track: ${res.error}`);
      return;
    }
    bakeCollision();
    paletteUi.refreshStatus();
  });
  document.body.appendChild(trackFileInput);
  onClick("road-load", () => trackFileInput.click());

  function readControls() {
    const left = keys.keya || keys.arrowleft;
    const right = keys.keyd || keys.arrowright;
    const fwd = keys.keyw || keys.arrowup;
    const back = keys.keys || keys.arrowdown;
    return {
      steerTarget: (left ? 1 : 0) - (right ? 1 : 0),
      throttle: (fwd ? 1 : 0) - (back ? 1 : 0),
      handbrake: !!keys.space,
      yaw: (keys.keye ? 1 : 0) - (keys.keyq ? 1 : 0),
    };
  }

  /** Where the level designer put the player start, else the world origin. */
  function spawnXZ() {
    const sp = app.getSpawnPoint?.() ?? null;
    return { x: sp?.x ?? 0, z: sp?.z ?? 0, yaw: sp?.yaw ?? 0 };
  }

  /**
   * Seat a fresh chain on the ground at the spawn point.
   *
   * The builder's default anchor is initialConnector() — world origin at y=0.
   * The lab could rely on that because its floor WAS y=0; on real v3 terrain the
   * origin is usually underground or floating, so the first piece has to be
   * seeded against the heightfield or the track starts buried.
   */
  function seedChainAtSpawn() {
    const { x, z, yaw } = spawnXZ();
    const y = app.getWorldHeight(x, z) + ROAD_SEED_CLEARANCE;
    builder.beginNewChain(new THREE.Vector3(x, y, z), yaw);
    builder.refreshGhost?.();
  }

  /** Drop the car at the project's saved player start, or the world origin. */
  function respawn() {
    const { x, z, yaw } = spawnXZ();
    const y = app.getWorldHeight(x, z) + 1.0;
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw + Math.PI);
    vehicle.setSpawn(new THREE.Vector3(x, y, z), q);
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
      builder.setGhostVisible(false);
      builder.deselectPlacement?.();
      props.deselect();
      movers.deselect();
      vehicle.enabled = true;
      if (vehicle.group) vehicle.group.visible = true;
      respawn();
    } else {
      builder.setGhostVisible(true);
      vehicle.enabled = false;
    }
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
  seedChainAtSpawn(); // put the build anchor on the ground, not at origin/y=0
  bakeCollision();
  if (paletteEl) paletteEl.style.display = ""; // boots in build mode
  paletteUi.refreshStatus();

  // 6b) ── DEV PANEL ─────────────────────────────────────────────────────────
  // Right-hand developer UI, styled like the v3 editor's right panel. This page
  // is the DEV page for the game (same relationship rts.html has to rts-v3) —
  // player-facing UI is the palette and the hint bar.
  let worldName = boot.name;
  devPanel = createRoadDevPanel({
    app,
    params: { TIRE, AERO, DRIVETRAIN, DECK },
    game: {
      getMode: () => mode,
      toggleMode,
      respawn,
      bakeCollision,
      setCollisionDebug,
      setFreeLook: (on) => {
        freeLook = !!on;
        applyControlMode(); // orbit interactions must follow the flag
        if (!freeLook) chase.reset(); // don't sweep back from wherever orbit left it
      },
      setInstancing: (on) => builder.setInstancing(on),
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
      getPieceCount: () => builder.pieces.length,
      getCollisionTriCount: () => deckBvh.triCount + solidsBvh.triCount,
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
  const tick = () => {
    const now = performance.now();
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;

    // Re-assert every frame: the engine's syncOrbitMouseBindings() keeps handing
    // the LEFT button back to orbit, which would steal it from the gizmo.
    syncMouseButtons();

    if (mode === "drive") {
      const input = readControls();
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
      const hasDeckMovers = movers.getDeckMovers().length > 0;
      for (let i = 0; i < ticks; i++) {
        movers.update(FIXED_DT);
        if (hasDeckMovers) rebakeDeckWithMovers(); // platforms moved → BVH is stale
        vehicle.tick(input);
        props.applyFields(vehicle, FIXED_DT);      // boost pads etc.
        portals.updateDrive(FIXED_DT, vehicle);
      }
      vehicle.syncVisuals(dt, simAccum / FIXED_DT);

      // FX are cosmetic, so they run once per FRAME on real dt (not per tick) —
      // they must not affect the deterministic outcome.
      tireMarks.update(vehicle);
      driftSmoke.updateFromVehicle(vehicle, camera, dt, keys);

      if (vehicle.body.pos.y < FALL_Y) respawn();

      // Keep the engine's terrain clipmap streaming around the car. The chase
      // rig owns camera.position/up, but `controls.target` is what the engine
      // centres terrain on, so it has to track the car too.
      controls.target.copy(vehicle.body.pos);
    }

    chase.update(dt);

    app._roadRaf = requestAnimationFrame(tick);
  };
  app._roadRaf = requestAnimationFrame(tick);

  onStatus("ready");

  return {
    app,
    builder,
    vehicle,
    bakeCollision,
    respawn,
    toggleMode,
    get mode() { return mode; },
    world: boot,
  };
}
