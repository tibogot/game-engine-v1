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
  HEADLIGHTS,
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
      case "keyn": seedChainAtSpawn(); break;      // new chain (game-owned, not editor spawn)
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

  // ── SPAWN ──────────────────────────────────────────────────────────────────
  // Where the car drops on entering drive mode / after a fall. Priority:
  //   1. gameSpawn — set by the user in the dev panel, saved WITH THE TRACK.
  //   2. the .v3proj player start (app.getSpawnPoint).
  //   3. world origin.
  // For an air track the spawn has a REAL Y (up on the track), so the full pose
  // is stored, not just XZ + terrain height.
  let gameSpawn = null; // {x, y, z, yaw} | null

  function resolveSpawn() {
    if (gameSpawn) return gameSpawn;
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

  /**
   * Seat a fresh chain on the ground at the spawn point.
   *
   * The builder's default anchor is initialConnector() — world origin at y=0.
   * The lab could rely on that because its floor WAS y=0; on real v3 terrain the
   * origin is usually underground or floating, so the first piece has to be
   * seeded against the heightfield or the track starts buried.
   */
  function seedChainAtSpawn({ showGizmo = true } = {}) {
    const s = resolveSpawn();
    const y = s.y + ROAD_SEED_CLEARANCE;
    builder.beginNewChain(new THREE.Vector3(s.x, y, s.z), s.yaw);
    // beginNewChain always pops the placement gizmo up. That's right when the
    // user asked for a new chain, but not on boot: it's ~13 draw calls of grab
    // handles floating in an empty world before anyone has touched anything.
    // deselectPlacement only hides it — freePlaceMode and the anchor survive, so
    // pressing N (or selecting a chain) brings it straight back.
    if (!showGizmo) builder.deselectPlacement();
    builder.refreshGhost?.();
  }

  /** Drop the car at the resolved spawn (user spawn → .v3proj start → origin). */
  function respawn() {
    const s = resolveSpawn();
    // An explicit spawn is already a valid on-track pose; only the terrain-based
    // fallback needs a lift so the wheels clear the ground.
    const y = s.y + (gameSpawn ? 0 : 1.0);
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), s.yaw + Math.PI);
    vehicle.setSpawn(new THREE.Vector3(s.x, y, s.z), q);
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
    spawnMarker.visible = !driving; // a build-time guide; hidden while racing
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
    params: { TIRE, AERO, DRIVETRAIN, DECK, HEADLIGHTS, glowPropParams },
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
      vehicleAudioSettings,
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
