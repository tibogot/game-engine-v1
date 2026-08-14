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
  WHEEL_LAYOUT,
  HEADLIGHTS,
  CHASSIS,
  CHASSIS_HULL,
  WHEEL,
  WHEEL_LOCAL,
  DRIFT,
  GRAVITY,
} from "../../v3/play/modularRoadVehicle.js";
import { RoadBvh } from "../../v3/play/modularRoadBvh.js";
import { createVehicleGround } from "../../v3/play/modularRoadGround.js";
import {
  createRoadMaterial,
  createGuardrailMaterial,
  createTunnelMaterial,
  createDecorMaterial,
  createRoadGlassMaterial,
  readRoadLook,
  syncRoadUniforms,
  ROAD_LOOK_FORMAT,
} from "./modularRoadMaterial.js";
import { ModularRoadBuilder, buildRoadPaletteUI, CATEGORY_PRESETS } from "./modularRoadBuilder.js";
import {
  PIECE_CATALOG,
  roadParams,
  pieceParams,
  guardrailParams,
} from "./modularRoadKit.js";
import { bakeRoadThumbnails } from "./modularRoadThumbnails.js";
import {
  PropManager, PROP_CATALOG, PROP_BY_ID, glowPropParams, SURFACE_SNAP, SURFACE_SNAP_MODES, DECAL_URL,
} from "./modularRoadProps.js";
import { MoverPropManager, MOVER_CATALOG, MOVER_BY_ID } from "./modularRoadMoverProps.js";
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
import { createDebugCamera } from "./debugCamera.js";
import { createGamepadInput } from "./gamepadInput.js";
import { createGearbox, GEARBOX } from "./gearbox.js";
import { createSegmentDash } from "./segmentDash.js";
import { createDriftScore, DRIFT_SCORE } from "./driftScore.js";
import { loadWheelModel } from "./wheelModel.js";
import {
  loadChassisModel, CHASSIS_GLB, applyChassisGlbTransform, resetChassisGlbFit, chassisGlbMounts,
} from "./chassisModel.js";
import { ModularRoadSparks, DEFAULT_SPARK_SETTINGS } from "./modularRoadSparks.js";
import { PropPhysics, PROP_PHYSICS, PHYSICS_PROP_TYPES } from "./modularRoadPropPhysics.js";
import { PropInstancer } from "./modularRoadPropInstancer.js";
import { preloadContainer } from "./modularRoadContainer.js";
import { preloadTireWall } from "./modularRoadTireWall.js";
import { preloadDecal, settleDecals } from "./modularRoadDecals.js";
import { ModularRoadFlags, FLAG } from "./modularRoadFlags.js";
import { loadBootWorld, loadWorldFromFile } from "./worldLoader.js";
import { createRoadDevPanel } from "./devPanel.js";
// Vite `?url` copies these into dist (dev AND Vercel). A raw fetch of
// /games/modular-road-v3/*.json 404s on deploy: Vite only emits public/ and
// imported assets — the source folder itself is not published.
import apexTrackUrl from "./modular-road-track (1).json?url";
import rushlineTrackUrl from "./rushline.json?url";

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
  // ── THE GAME OWNS ITS LIGHT ────────────────────────────────────────────────
  // Lighting is NOT saved in the .v3proj (encodeProjectFile's manifest has no
  // light section at all), so a loaded world contributes terrain and props but
  // no look. Without this the game inherits raw engine defaults — which are the
  // EDITOR's defaults, tuned for authoring terrain, not for a stunt track.
  //
  // Boot-time rather than post-boot because createWorldEnvironment reads these
  // when it builds the sun and its cascades (see the opts.light block in
  // v3/app/main.js). Everything here is re-tunable live from the dev panel.
  const app = await startV3App({
    light: {
      // The editor default is 0.2 envIntensity / 0.4 hemi, which is why the
      // scene reads dark: almost nothing fills the shadows. A racer wants a
      // readable road surface in shadow more than it wants contrast.
      envIntensity: 0.45,
      hemiIntensity: 0.6,
      dirIntensity: 2.6,
      exposure: 1.0,
    },
  });
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
  // Mid-morning: a high-ish sun keeps the track readable and the shadows short
  // enough not to swallow a piece of road. `autoAdvance` is false by default, so
  // this is FROZEN — a lap at minute 20 lights the same as a lap at minute 1,
  // which also stops the auto-headlights flicking on mid-race.
  app.sky?.setTimeOfDay(10.5);

  app.postFx?.setEnabled(true);
  app.postFx?.setBloomSelective(true);
  app.postFx?.setBloom({ enabled: true, strength: 0.9, threshold: 0.0, radius: 0.5 });

  // 3) ── THE TRACK ──────────────────────────────────────────────────────────
  onStatus("Building track…");
  const roadMaterial = createRoadMaterial();
  const railMaterial = createGuardrailMaterial();
  const shellMaterial = createTunnelMaterial();
  const decorMaterial = createDecorMaterial();
  // One pane material for every glass road on the track — it reflects
  // `scene.environment` (the live sky PMREM), so all of them stay in step with
  // the time of day for free.
  const glassMaterial = createRoadGlassMaterial();

  let mode = "build"; // "build" | "drive"
  // Declared up here (not with the input handlers below) because the audio setup
  // captures it via getKeys and may read it during construction.
  const keys = Object.create(null);
  // Assigned near the end of setup, but bakeCollision() runs before that and
  // pokes it — `let … = null` so the early call sees null instead of a TDZ throw.
  let devPanel = null;
  /** Exact round colliders (gate posts) — see PropManager.collisionCapsules(). */
  let solidCapsules = [];
  /** Same `let … = null` reason as devPanel: bakeCollision hands these to the
   *  vehicle, and `const vehicle` below would be in TDZ on an early bake. */
  let vehicleRef = null;

  const builder = new ModularRoadBuilder({
    scene,
    material: roadMaterial,
    railMaterial,
    shellMaterial,
    decorMaterial,
    glassMaterial,
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
  // Scratch for the prop surface query — allocated once, not per placement.
  const _snapOrigin = new THREE.Vector3();
  const _snapDown = new THREE.Vector3(0, -1, 0);

  const props = new PropManager({
    scene,
    camera,
    domElement: renderer.domElement,
    orbit: controls,
    // Fires on add / delete / gizmo release. `flags.sync()` belongs here rather
    // than only on add: its self-heal watches the prop COUNT, so dragging an
    // existing flag would otherwise leave its cloth behind at the old spot.
    //
    // `propPhysics.sync()` is here for the SAME reason, and its absence was a bug:
    // the sim captures the authored transform once (its `home`) and then writes
    // `home × swing` onto the prop's root every frame. Move or rotate a simulated
    // prop with the gizmo and only the root changes — `home` stays at the pose it
    // was placed in — so the moment physics starts running it puts the prop back
    // where it was FIRST dropped. Reported as a swing gate that ignores its
    // rotation the instant you enter play mode.
    //
    // Only simulated props could show it (`PHYSICS_PROP_TYPES`: cones and gates),
    // which is why every other object moved fine. Re-syncing costs nothing here —
    // the gizmo is disabled while driving (`props.setEnabled(!driving)`), so this
    // cannot re-seat a gate mid-swing.
    onChange: () => {
      bakeCollision(); flags?.sync(); propPhysics?.sync(); paletteUi?.refreshStatus?.();
    },
    onSelect: () => { movers.deselect(); portals.deselect?.(); builder.deselectPlacement?.(); },
    // The panel's livery swatches ARE the current selection's palette, so they
    // have to follow it — and this fires AFTER the selection settles, which
    // onSelect deliberately does not.
    onSelectionChange: () => devPanel?.refresh(),
    /**
     * Surface under a prop, for placement snapping (see SURFACE_SNAP).
     *
     * Searches DOWNWARD from the prop's own height, which is what makes "auto"
     * behave around elevated track: a prop on the terrain beneath a raised road
     * finds the terrain, not the deck above it. The +2 m margin lets a prop that
     * is already sitting flush still find the surface it is resting on.
     */
    getSurfaceY: (x, y, z, mode) => {
      if (mode !== "ground" && deckBvh?.baked) {
        _snapOrigin.set(x, y + 2, z);
        const hit = deckBvh.raycastFirst(_snapOrigin, _snapDown, 400);
        if (hit) return hit.point.y;
      }
      // Road-only and there is no road here: refuse rather than silently
      // dropping the prop to the terrain, which would look like a bug.
      if (mode === "road") return null;
      return app.getWorldHeight(x, z);
    },
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
  // BEFORE the thumbnails, and that is the whole reason it is awaited here.
  // Every other prop's make() is synchronous; the container's needs a GLB, and
  // the bake calls make() once per catalog entry and skips anything that comes
  // back empty — so loading it later left the container as the one palette tile
  // with a hand-drawn fallback icon. 18 KB, so the wait is not measurable.
  onStatus("Loading models…");
  // Decals settle alongside the model for the same reason: decalMaterial() is
  // synchronous (the instancer calls it while building a batch), so the texture
  // has to be in hand before the first container can be drawn — or the batch is
  // built with no material and quietly skipped.
  await Promise.all([
    preloadContainer(),
    preloadTireWall(renderer),
    preloadDecal(DECAL_URL).then(() => settleDecals()),
  ]);

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
      materials: {
        road: roadMaterial, rail: railMaterial, shell: shellMaterial,
        decor: decorMaterial,
        // NOT the live pane material. Transmission composites against a copy of
        // the backdrop, and a thumbnail is rendered into a bare RT with no
        // backdrop to copy — the pane comes out black, so the tile advertises a
        // hole rather than a window. The cheap Fresnel-alpha build of the same
        // material needs nothing behind it and reads as glass at tile size.
        glass: createRoadGlassMaterial({ transmission: 0, opacity: 0.32 }),
      },
      items: thumbItems,
      environment: scene.environment,
      size: 192,
    });
  } catch (e) {
    console.warn("[ModularRoad-v3] thumbnail bake skipped", e);
  }

  // ── PLACEMENT BRUSH (props / movers) ───────────────────────────────────────
  // Picking a prop in the palette ARMS a brush: a translucent ghost follows the
  // mouse across whatever surface the snap mode selects, and left-click places
  // it there. The brush stays armed so you can lay down a run of cones; Escape,
  // right-click or picking a road piece puts it down.
  //
  // This replaces "the object appears at the camera's orbit target and you drag
  // it into place with a gizmo", which was a second, worse mental model living
  // beside the road pieces' own ghost-and-click flow in the same palette. The
  // gizmo is still there for ADJUSTING something already placed — it just isn't
  // the only way to position it any more.
  const GHOST_OK = new THREE.MeshBasicMaterial({
    color: 0x7cffb4, transparent: true, opacity: 0.5, depthWrite: false,
  });
  const GHOST_BAD = new THREE.MeshBasicMaterial({
    color: 0xff6b6b, transparent: true, opacity: 0.35, depthWrite: false,
  });
  /** @type {{kind:"prop"|"mover", id:string, root:THREE.Object3D, restY:number, point:THREE.Vector3|null}|null} */
  let brush = null;
  /** Last cursor position over the canvas, so the ghost can be re-picked without
   *  waiting for a mouse move (e.g. right after the snap mode changes). */
  let lastPointer = null;
  const _brushRay = new THREE.Raycaster();
  const _brushNdc = new THREE.Vector2();
  const _brushPoint = new THREE.Vector3();

  /**
   * A flat translucent stand-in for the real object.
   *
   * Deliberately NOT the real materials with opacity turned down: these are TSL
   * node materials, several are emissive, and a ghost has to read as "not placed
   * yet" at a glance. One shared basic material also means the ghost costs
   * nothing and can be recoloured to show whether the spot is valid.
   */
  function buildBrushGhost(def) {
    const root = def.make();
    root.traverse((o) => {
      if (!o.isMesh) return;
      o.material = GHOST_OK;
      o.castShadow = false;
      o.receiveShadow = false;
    });
    root.frustumCulled = false;
    return root;
  }

  /**
   * Car-shaped ghost for the SPAWN tool.
   *
   * Prefers a clone of the real GLB body, so what you line up is literally the
   * car you are about to drive — including whatever the dev panel's fit sliders
   * did to it, since those author the GLB's own transform and `clone(true)`
   * carries it. Falls back to primitives sized from CHASSIS/WHEEL_LOCAL while the
   * model is still loading in the background (see loadChassisModel below), so the
   * tool is usable from the first frame instead of silently doing nothing.
   *
   * Both variants are built in CAR-LOCAL space — body centred on the origin, hubs
   * at WHEEL_LOCAL — which is the frame `respawn()` places the body in. The
   * caller lifts the whole thing by SPAWN_LIFT, so the ghost sits exactly where
   * the car will, floating gap included: that gap is real and worth seeing.
   */
  function buildSpawnGhost(material = GHOST_OK, name = "SpawnBrushGhost") {
    const root = new THREE.Group();
    root.name = name;

    if (chassisGlbObject) {
      const car = chassisGlbObject.clone(true);
      car.traverse((o) => {
        if (!o.isMesh) return;
        o.material = material;
        o.castShadow = false;
        o.receiveShadow = false;
      });
      root.add(car);
    } else {
      const body = new THREE.Mesh(
        new THREE.BoxGeometry(CHASSIS.width, CHASSIS.height, CHASSIS.length), material,
      );
      root.add(body);
      // A cabin and a nose wedge: a bare box has no readable front, and the whole
      // point of this ghost is that you can see which way the car will face.
      const cabin = new THREE.Mesh(
        new THREE.BoxGeometry(CHASSIS.width * 0.8, CHASSIS.height * 0.7, CHASSIS.length * 0.4),
        material,
      );
      cabin.position.set(0, CHASSIS.height * 0.75, -CHASSIS.length * 0.1);
      root.add(cabin);
      const nose = new THREE.Mesh(new THREE.ConeGeometry(0.28, 0.9, 4), material);
      nose.rotation.x = Math.PI / 2; // point +Z — the chassis' forward axis
      nose.position.set(0, CHASSIS.height * 0.2, CHASSIS.length * 0.5 + 0.45);
      root.add(nose);
      const wheelGeo = new THREE.CylinderGeometry(
        WHEEL.radius, WHEEL.radius, WHEEL.thickness, 14,
      );
      for (const w of WHEEL_LOCAL) {
        const wheel = new THREE.Mesh(wheelGeo, material);
        wheel.rotation.z = Math.PI / 2; // cylinder axis +Y → +X, the hub axis
        wheel.position.copy(w.pos);
        root.add(wheel);
      }
    }

    root.traverse((o) => { o.frustumCulled = false; });
    return root;
  }

  /**
   * Arm the spawn ghost. `snapMode` is 'road' or 'ground' — the two surfaces a
   * car can start on, and the only thing this tool needs to know.
   *
   * Deliberately a BRUSH rather than its own bespoke picker: the brush path
   * already owns the pointer in build mode (move → ghost follows, LMB → place,
   * Esc/RMB → put down), so the spawn tool inherits all of it and behaves like
   * every other placement tool on the page instead of being the odd one out.
   */
  function armSpawnBrush(snapMode = "road") {
    // Brushes only exist in build mode — the pointer handlers bail on anything
    // else, so arming from the panel while driving would light the button up and
    // then do nothing at all. Asking for the tool is asking to be in the mode
    // that has it.
    if (mode !== "build") toggleMode();
    clearBrush({ silent: true });
    const root = buildSpawnGhost();
    root.visible = false; // until the mouse says where
    scene.add(root);
    brush = {
      kind: "spawn",
      id: null,
      root,
      restY: SPAWN_LIFT,
      point: null,
      snapMode,
      // FACING angle (what root.rotation.y is set to), not the stored spawn yaw —
      // those differ by π. Converted once, at the point of placement.
      facing: resolveSpawn().yaw + Math.PI,
      // Until you touch Q/E the ghost keeps snapping to the down-track direction
      // of whatever piece is under it; after that your angle is yours to keep.
      facingLocked: false,
      // The GLB clone SHARES its geometry with the car you drive. Disposing it
      // in clearBrush would delete the player's own body mesh.
      disposeGeo: !chassisGlbObject,
    };
    devPanel?.refresh();
    return true;
  }

  function clearBrush({ silent = false } = {}) {
    if (!brush) return;
    scene.remove(brush.root);
    if (brush.disposeGeo !== false) {
      brush.root.traverse((o) => { if (o.isMesh) o.geometry?.dispose(); });
    }
    const wasSpawn = brush.kind === "spawn";
    brush = null;
    if (!silent) paletteUi?.clearBrushHighlight?.();
    if (wasSpawn) devPanel?.refresh();
  }

  function armBrush(kind, id) {
    clearBrush({ silent: true });
    const def = kind === "prop" ? PROP_BY_ID.get(id) : MOVER_BY_ID.get(id);
    if (!def) return;
    const root = buildBrushGhost(def);
    // make() authors the rest offset on the ROOT (a cone sits a collision radius
    // up so its base is flush), so the ghost has to keep it when it rides a
    // surface — otherwise the preview sits a radius lower than what you place.
    const restY = root.position.y;
    root.visible = false; // until the mouse says where
    scene.add(root);
    brush = { kind, id, root, restY, point: null };
  }

  /**
   * Surface under the cursor for the active snap mode.
   *
   * `road` uses the deck BVH only and returns null off it — that is the mode's
   * whole contract, and here it gives real feedback: the ghost turns red and the
   * click is refused, rather than the prop quietly going somewhere else.
   * `ground` is terrain only (the parkour case, under an elevated road).
   * `auto`/`free` take whichever of the two the ray reaches FIRST, so aiming at
   * a bridge gets the bridge and aiming past its edge gets the valley floor.
   */
  function pickPlacementSurface(clientX, clientY, mode = SURFACE_SNAP.mode) {
    const rect = renderer.domElement.getBoundingClientRect();
    _brushNdc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    _brushRay.setFromCamera(_brushNdc, camera);

    let deck = null;
    if (mode !== "ground" && deckBvh?.baked) {
      const hit = deckBvh.raycastFirst(_brushRay.ray.origin, _brushRay.ray.direction, 5000);
      if (hit?.point) deck = _brushPoint.set(hit.point.x, hit.point.y, hit.point.z).clone();
    }
    const terr = app.pickWorldAtClient?.(clientX, clientY)?.point?.clone() ?? null;

    // ROAD mode still reports the TERRAIN point when it misses the deck, marked
    // invalid. The ghost has to stay under the cursor to be useful feedback — a
    // red ghost frozen at the last legal spot says "the tool is stuck", while a
    // red ghost tracking the mouse says "not HERE". Returning null would hide it
    // entirely, which reads as broken.
    if (mode === "road") {
      if (deck) return { point: deck, valid: true };
      return terr ? { point: terr, valid: false } : null;
    }
    if (mode === "ground") return terr ? { point: terr, valid: true } : null;
    if (!deck) return terr ? { point: terr, valid: true } : null;
    if (!terr) return { point: deck, valid: true };
    // Nearest along the view ray wins — that is what "the thing you are pointing
    // at" means, and it is the only rule that behaves under a bridge.
    return _brushRay.ray.origin.distanceToSquared(deck)
      <= _brushRay.ray.origin.distanceToSquared(terr)
      ? { point: deck, valid: true }
      : { point: terr, valid: true };
  }

  /** Move the ghost to the cursor. Returns true when the spot is placeable. */
  function updateBrush(clientX, clientY) {
    if (!brush) return false;
    const hit = pickPlacementSurface(clientX, clientY, brush.snapMode);
    // `point` is what PLACES, so it is only set when the spot is legal; the
    // ghost is positioned from the hit either way so it keeps tracking the mouse.
    brush.point = hit?.valid ? hit.point : null;
    brush.root.visible = !!hit;
    if (hit) brush.root.position.set(hit.point.x, hit.point.y + brush.restY, hit.point.z);
    // The spawn ghost also carries a FACING. Left to itself it points down-track
    // off whatever piece is under the cursor — which is the answer you want
    // ~every time on a road — and holds still once Q/E have had their say.
    if (brush.kind === "spawn") {
      if (!brush.facingLocked) {
        const piece = builder.pickPiece(clientX, clientY);
        if (piece) brush.facing = yawFromPiece(piece) + Math.PI;
      }
      brush.root.rotation.y = brush.facing;
    }
    const mat = hit?.valid ? GHOST_OK : GHOST_BAD;
    brush.root.traverse((o) => { if (o.isMesh) o.material = mat; });
    return !!hit?.valid;
  }

  /** Turn the armed spawn ghost. No-op for any other brush. */
  function rotateSpawnBrush(delta) {
    if (brush?.kind !== "spawn") return false;
    brush.facing += delta;
    brush.facingLocked = true; // your angle now — stop re-aiming it down-track
    brush.root.rotation.y = brush.facing;
    return true;
  }

  /** Place the armed brush at the ghost. Keeps the brush for the next click. */
  function placeBrush() {
    if (!brush?.point) return false;
    if (brush.kind === "spawn") {
      // `facing` is the direction the car points; the stored yaw is that minus π
      // (see the SPAWN block). One conversion, in one place.
      gameSpawn = {
        x: brush.point.x, y: brush.point.y, z: brush.point.z,
        yaw: brush.facing - Math.PI,
      };
      updateSpawnMarker();
      // Unlike a prop — where you lay a whole run and the brush stays armed —
      // there is exactly ONE spawn, so placing it IS finishing. Leaving the tool
      // armed would make it ambiguous whether the click had taken.
      clearBrush();
      return true;
    }
    if (brush.kind === "prop") {
      // Landing on another one of these? Line up with it exactly. See
      // PropManager.stackSnap — the ray already found the roof, this is the
      // horizontal half.
      const stack = props.stackSnap(brush.id, brush.point);
      const placed = props.add(brush.id, stack?.position ?? brush.point);
      if (stack && placed) {
        placed.root.quaternion.copy(stack.quaternion);
        placed.root.position.copy(stack.position);
        // add() already recorded an authored pose, but that was the pre-stack
        // one — this alignment is the placement the user actually made, so it
        // has to replace it or the prop saves at the spot it never sat in.
        props.captureAuthored(placed);
      }
      propPhysics.sync();
      propInstancer.sync();
      flags.sync();
    } else {
      movers.add(brush.id, brush.point);
    }
    paletteUi?.refreshStatus?.();
    return true;
  }

  // The palette owns the piece catalog, categories AND the build-mode keyboard
  // shortcuts (they live inside buildRoadPaletteUI).
  const paletteUi = buildRoadPaletteUI(builder, {
    propCatalog: PROP_CATALOG,
    moverCatalog: MOVER_CATALOG,
    thumbnails: roadThumbnails,
    onAddProp: (id) => armBrush("prop", id),
    onAddMover: (id) => armBrush("mover", id),
    onAddPortal: () => { portals.addDoor(); paletteUi?.refreshStatus?.(); },
    onPickPiece: () => clearBrush({ silent: true }),
    onEdgesChange: () => bakeCollision(),
    onLoadDemo: () => {
      // Seat the showcase in the sky at the current build height — same rule as
      // New chain (N), so the demo never drops onto the terrain.
      const s = resolveSpawn();
      const x = s.x;
      const z = s.z;
      const y = app.getWorldHeight(x, z) + buildHeight;
      builder.loadDemo({
        startPos: new THREE.Vector3(x, y, z), yaw: s.yaw,
        dragK: AERO.drag / CHASSIS.mass, // same arc the red preview draws
      });
      if (controls.target) {
        controls.target.set(x, y, z);
        controls.update?.();
      }
    },
    onLoadCircuit: () => {
      const s = resolveSpawn();
      const x = s.x;
      const z = s.z;
      const y = app.getWorldHeight(x, z) + buildHeight;
      builder.loadBigCircuit({ startPos: new THREE.Vector3(x, y, z), yaw: s.yaw });
      if (controls.target) {
        controls.target.set(x, y, z);
        controls.update?.();
      }
    },
  });

  // 4) ── THE CAR ────────────────────────────────────────────────────────────
  const vehicle = new Vehicle({ scene, showArrows: false });
  // Chassis-corner safety floor follows the terrain instead of pinning to y=0.
  vehicle.getFloorY = (x, z) => app.getWorldHeight(x, z);
  // Adopt whatever a bake that ran before this point already worked out.
  vehicleRef = vehicle;
  vehicle.setSolidCapsules(solidCapsules);

  // GLB wheels, loaded in the BACKGROUND: the car boots on its procedural wheels
  // and upgrades when the model arrives, so a slow or missing file can never
  // leave the game wheel-less or block startup. The dev panel's Wheels button
  // switches back to procedural, which also restores WHEEL_PROCEDURAL's exact
  // radius/thickness — the dimensions the handling was tuned against.
  loadWheelModel(renderer)
    .then(({ object, radius, width }) => {
      vehicle.setWheelModel(object, { radius, thickness: width });
      vehicle.setWheelStyle("glb");
      devPanel?.refresh();
    })
    .catch((e) => {
      console.warn("[ModularRoad-v3] wheel model failed to load — staying procedural", e);
    });

  // GLB body, same deal. This one changes NO physics — the collision box stays
  // CHASSIS.width/height/length either way — so it is a pure visual swap and the
  // handling is identical in both styles.
  // Kept so the dev-panel fit sliders have something to re-transform.
  let chassisGlbObject = null;
  let chassisLampsLocal = null;
  loadChassisModel(renderer)
    .then((m) => {
      const { object, brakeLights, headlampLenses } = m;
      chassisGlbObject = object;
      chassisLampsLocal = m.headlampMountsLocal;
      vehicle.setHeadlampMounts(chassisGlbMounts(chassisLampsLocal));
      vehicle.setChassisModel(object, { brakeLights, headlampLenses });
      vehicle.setChassisStyle("glb");
      // The spawn marker was built from the primitive stand-in at boot (this load
      // is deliberately in the background). Now that the real body exists, swap
      // the silhouette for it — otherwise the marker stays a box for the session.
      rebuildSpawnMarkerCar();
      devPanel?.refresh();
    })
    .catch((e) => {
      console.warn("[ModularRoad-v3] chassis model failed to load — staying procedural", e);
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
    const decks = [];
    for (const p of builder.pieces) {
      const m = p.mesh;
      if (!m || m.userData.noCollision) continue;
      // A deck can hand the BVH a stand-in the same way a rail does. The half
      // tubes use it to keep their rim caps OUT of the drive surface — a 0.6 m
      // horizontal shelf at exactly lip height, which is what stopped the car
      // ever getting air off a half pipe. See buildOpenLipCollision.
      const proxy = m.userData.collisionGeometry;
      decks.push(proxy
        ? { geometry: proxy, matrixWorld: m.matrixWorld, updateMatrixWorld() {} }
        : m);
    }
    const solids = [];
    for (const p of builder.pieces) {
      if (p.railMesh) {
        // Bake the cheap proxy, not the rail you can see. bakeFromMeshes only
        // reads .geometry and .matrixWorld, so a stand-in with the same world
        // transform substitutes cleanly — 696 triangles a piece instead of
        // 3,688, on a bake that reruns every time you place or drag a piece.
        const proxy = p.railMesh.userData.collisionGeometry;
        solids.push(proxy
          ? { geometry: proxy, matrixWorld: p.railMesh.matrixWorld, updateMatrixWorld() {} }
          : p.railMesh);
      }
      if (p.shellMesh) solids.push(p.shellMesh);
    }

    // Props are static during a run (they only move via the build-mode gizmo, and
    // that fires onChange → a full rebake), so they belong in the static BVH.
    // Movers do NOT — they go in the dynamic one, rebaked per tick below.
    const propCol = props.collisionMeshes();
    decks.push(...propCol.deck);
    solids.push(...propCol.solids);
    // Round primitives bypass the BVH entirely — the chassis hull is SAMPLED
    // against triangles, and anything thinner than the sample spacing (a gate
    // post, say) falls between the samples. See PropManager.collisionCapsules().
    solidCapsules = props.collisionCapsules();
    vehicleRef?.setSolidCapsules(solidCapsules);

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
    // Movers and physics props can have been added/removed by the same edit.
    buildDynamicDebug();
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
  // STATIC wireframes (baked track) vs DYNAMIC ones (the car, movers, physics
  // props). Separate subgroups because the static half is rebuilt only when the
  // track changes while the dynamic half is re-posed every frame — and the
  // static rebuild used to clear the whole group, which would take the car's
  // collider down with it.
  const debugStatic = new THREE.Group();
  const debugDyn = new THREE.Group();
  debugGroup.add(debugStatic, debugDyn);
  let debugOn = false;
  const _capUp = new THREE.Vector3(0, 1, 0);
  const _capAxis = new THREE.Vector3();

  function refreshCollisionDebug() {
    for (const c of debugStatic.children) c.geometry?.dispose();
    debugStatic.clear();
    if (!debugOn) return;
    const add = (bvh, color) => {
      if (!bvh?.geometry) return;
      debugStatic.add(new THREE.Mesh(
        bvh.geometry.clone(),
        new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity: 0.5 }),
      ));
    };
    add(deckBvh, 0xff5060);   // static decks = red
    add(solidsBvh, 0x5080ff); // static solids = blue
    // Capsule colliders are solids too, but they are never in the BVH, so
    // without this the gate post looked uncollided in the very overlay you would
    // check it in. Same blue — it is the same channel to the player.
    for (const cap of solidCapsules) {
      const h = cap.a.distanceTo(cap.b);
      const g = new THREE.CapsuleGeometry(cap.radius, h, 4, 10);
      const m = new THREE.Mesh(
        g,
        new THREE.MeshBasicMaterial({ color: 0x5080ff, wireframe: true, transparent: true, opacity: 0.5 }),
      );
      m.position.copy(cap.a).add(cap.b).multiplyScalar(0.5);
      // CapsuleGeometry stands along +Y; lay it on the capsule's own axis.
      if (h > 1e-6) {
        m.quaternion.setFromUnitVectors(
          _capUp, _capAxis.subVectors(cap.b, cap.a).normalize(),
        );
      }
      debugStatic.add(m);
    }
    // Mover BVHs are intentionally NOT drawn here: they rebake every tick, so a
    // wireframe snapshot would lag the platform. They get live wireframes in the
    // DYNAMIC half instead, posed from their real meshes every frame.
  }

  // ── LIVE COLLIDER WIREFRAMES ───────────────────────────────────────────────
  // What the car is ACTUALLY collided as, drawn where it actually is:
  //   yellow  CHASSIS_HULL — the silhouette the car HITS things with, and what
  //           the solids resolver samples. Roughly the bodywork.
  //   dim yellow  CHASSIS — the smaller core box: deck contact and the inertia
  //           tensor. Deliberately not the silhouette; see the comment on
  //           CHASSIS in modularRoadVehicle.js for why it cannot grow.
  //   cyan    the four tyres at WHEEL.radius, where the ground probes start.
  //   orange  moving platforms and walls (the per-tick mover BVHs).
  //   green   simulated props — the cone's SPHERE proxy and the gate's panel,
  //           which are what the sim uses rather than the meshes you see.
  // Everything here is lines, so it reads through the geometry it is inside.
  const DBG_LINE = {
    car: new THREE.LineBasicMaterial({ color: 0xffe14a }),
    core: new THREE.LineBasicMaterial({ color: 0x8a7420 }),
    wheel: new THREE.LineBasicMaterial({ color: 0x4ad2ff }),
    mover: new THREE.LineBasicMaterial({ color: 0xff8a3d }),
    prop: new THREE.LineBasicMaterial({ color: 0x9dff5a }),
  };
  let dbgCar = null;
  let dbgCore = null;
  let dbgWheels = [];
  /** [{ line, mesh }] — wireframe clones tracking a live mesh's world matrix. */
  let dbgMovers = [];
  /** [{ line, sim }] — proxies tracking a PropPhysics sim. */
  let dbgProps = [];
  const _dbgCentre = new THREE.Vector3();
  const _dbgHullOff = new THREE.Vector3();

  function clearDynamicDebug() {
    for (const c of debugDyn.children) c.geometry?.dispose();
    debugDyn.clear();
    dbgCar = null; dbgCore = null; dbgWheels = []; dbgMovers = []; dbgProps = [];
  }

  /** Rebuild the dynamic wireframes for whatever exists right now. */
  function buildDynamicDebug() {
    clearDynamicDebug();
    if (!debugOn) return;
    const line = (geo, mat) => {
      const l = new THREE.LineSegments(new THREE.EdgesGeometry(geo), mat);
      geo.dispose();
      l.frustumCulled = false;
      debugDyn.add(l);
      return l;
    };

    // The SOLID HULL — what the car actually hits things with. The smaller
    // CHASSIS box is drawn too, in a dimmer yellow, because it is a different
    // real thing (deck contact + inertia) and seeing only one of them is how
    // "the collider is nowhere near the car" reads as a bug either way.
    dbgCar = line(new THREE.BoxGeometry(
      CHASSIS_HULL.width, CHASSIS_HULL.height, CHASSIS_HULL.length,
    ), DBG_LINE.car);
    dbgCore = line(new THREE.BoxGeometry(CHASSIS.width, CHASSIS.height, CHASSIS.length), DBG_LINE.core);
    for (let i = 0; i < 4; i++) {
      // A cylinder's EdgesGeometry is its two rims — the tyre silhouette, which
      // is what you want to see against the road, and only ~32 segments.
      const g = new THREE.CylinderGeometry(WHEEL.radius, WHEEL.radius, WHEEL.thickness, 16);
      g.rotateZ(Math.PI / 2); // axle along X, matching the wheel meshes
      dbgWheels.push(line(g, DBG_LINE.wheel));
    }

    for (const inst of movers.instances ?? []) {
      const mesh = inst.root?.userData?.moverBind?.mesh;
      if (!mesh?.geometry) continue;
      dbgMovers.push({ line: line(mesh.geometry.clone(), DBG_LINE.mover), mesh });
    }

    for (const sim of propPhysics.sims ?? []) {
      const p = sim.profile;
      if (p.kind === "body") {
        // The sphere PROXY, not the cone mesh — the whole point is to show that
        // the sim collides a sphere at the centre of mass.
        dbgProps.push({ line: line(new THREE.SphereGeometry(p.radius, 10, 6), DBG_LINE.prop), sim });
      } else if (p.kind === "hinge") {
        const g = new THREE.BoxGeometry(p.width, p.height, 0.1);
        // Panel extends +X from the hinge and its BOTTOM sits `baseY` above the
        // root — matching the mesh. Without the y term the wireframe drew half a
        // metre underground, which is half of why it did not sit on the gate.
        g.translate(p.width / 2, p.baseY + p.height / 2, 0);
        dbgProps.push({ line: line(g, DBG_LINE.prop), sim });
      }
    }
  }

  /** Re-pose the dynamic wireframes. Cheap: a handful of matrix writes. */
  function updateDynamicDebug() {
    if (!debugOn) return;
    if (dbgCar) {
      // Both boxes are placed in the GEOMETRIC-CENTRE frame — the CoM offset away
      // from body.pos, the same mapping _geomToWorld uses — and follow the RENDER
      // pose so they sit on the car rather than one tick behind it. The hull then
      // adds its own centre offset on top, in chassis-local axes.
      _dbgCentre.set(CHASSIS.comX, CHASSIS.comY, CHASSIS.comZ)
        .applyQuaternion(vehicle.renderQuat).add(vehicle.renderPos);
      dbgCore?.position.copy(_dbgCentre);
      dbgCore?.quaternion.copy(vehicle.renderQuat);
      _dbgHullOff.set(0, CHASSIS_HULL.offsetY, CHASSIS_HULL.offsetZ)
        .applyQuaternion(vehicle.renderQuat);
      dbgCar.position.copy(_dbgCentre).add(_dbgHullOff);
      dbgCar.quaternion.copy(vehicle.renderQuat);
    }
    for (let i = 0; i < dbgWheels.length; i++) {
      const g = vehicle.tireGroups[i];
      if (!g) continue;
      dbgWheels[i].position.copy(g.position);
      dbgWheels[i].quaternion.copy(g.quaternion);
    }
    for (const { line, mesh } of dbgMovers) {
      mesh.updateWorldMatrix(true, false);
      line.matrix.copy(mesh.matrixWorld);
      line.matrixAutoUpdate = false;
      line.matrixWorldNeedsUpdate = true;
    }
    for (const { line, sim } of dbgProps) {
      if (sim.body) {
        line.position.copy(sim.body.pos);
        line.quaternion.copy(sim.body.quat);
      } else {
        // Hinge: the prop ROOT already carries the swing — _tickHinge writes
        // `root.quaternion = home * R(angle)` every tick. Applying R(angle) a
        // SECOND time here is what made the wireframe lead the panel, by exactly
        // the swing (at the 1.5 rad limit it sat 86° past the gate). Copy the
        // root and nothing else.
        line.position.copy(sim.inst.root.position);
        line.quaternion.copy(sim.inst.root.quaternion);
      }
    }
  }

  function setCollisionDebug(on) {
    debugOn = !!on;
    debugGroup.visible = debugOn;
    refreshCollisionDebug();
    buildDynamicDebug();
    updateDynamicDebug();
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

  // Pieces per merged chunk.
  //
  // ONE mesh per material was the obvious win and it is half a win: 4 draws, but
  // a single mesh spanning the whole circuit has to be `frustumCulled = false`,
  // so every triangle on the track is submitted every frame no matter where you
  // are looking — and again for the shadow pass. You can typically see a fifth
  // of a lap, so most of that work is thrown away.
  //
  // Chunking by CONSECUTIVE pieces rather than by a spatial grid: pieces chain
  // end to end, so a run of them is already spatially tight, and it costs no
  // bookkeeping.
  //
  // Measured on the 37-piece Apex preset in drive mode, triangles submitted per
  // frame across BOTH passes (the merged track casts shadows, so every triangle
  // it keeps is paid twice):
  //
  //   never culled (one mesh)   764,736     86 draws
  //   chunk = 10                624,416     72 draws    −18%
  //   chunk = 4                 535,568     82 draws    −30%
  //
  // The merged track is only 109k triangles, so −229k means it is now almost
  // fully culled when off screen — near the theoretical ceiling, and 4 is past
  // the knee. Ten extra draws is nothing in WebGPU next to 89k triangles.
  // Worth revisiting for much longer circuits, where this many chunks starts to
  // add up: 80 pieces would be 20 chunks × the roles present.
  const MERGE_CHUNK_PIECES = 4;

  function buildMergedTrack() {
    disposeMergedTrack();
    scene.updateMatrixWorld(true);
    const pieces = builder.pieces;
    for (let start = 0; start < pieces.length; start += MERGE_CHUNK_PIECES) {
      const chunk = pieces.slice(start, start + MERGE_CHUNK_PIECES);
      for (const role of MERGE_ROLES) {
        const geos = [];
        for (const p of chunk) {
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
        // mergeGeometries does not carry bounds across, and without them three
        // culls against a stale or missing sphere — chunks would pop or never
        // cull at all.
        merged.computeBoundingSphere();
        const mesh = new THREE.Mesh(merged, role.mat());
        mesh.castShadow = role.cast;
        mesh.receiveShadow = true;
        mergedGroup.add(mesh);
      }
    }
  }

  // ── INSTANCED PROPS ────────────────────────────────────────────────────────
  // EVERY prop, in BOTH modes — see modularRoadPropInstancer.js. This replaced a
  // drive-mode-only merge, which collapsed further but could not cover the
  // editor: merged geometry cannot move (so cones and gates were excluded) and
  // every edit invalidates the whole bake (so dragging one prop of a hundred
  // re-merged all hundred). Measured before: 100 poles cost 648 draws while
  // building against 58 driving. Now both are flat.
  const propInstancer = new PropInstancer(scene, props, PROP_CATALOG, () => true);
  // Live glow tuning writes to the loose roots; the templates hold their own
  // copies of those materials, so they have to be rebuilt to be seen.
  props.onGlowChange = (ids) => propInstancer.refreshTemplates(ids);
  // A livery lives on the prop INSTANCE, not its material, so the instancer has
  // to be told to re-upload the colour buffer — it only does so when dirty,
  // since a colour is picked once and then sits there.
  props.onVariantChange = () => { propInstancer.markColorsDirty(); devPanel?.refresh(); };
  propInstancer.setEnabled(true);


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
  const sparks = new ModularRoadSparks(scene, { ...DEFAULT_SPARK_SETTINGS });
  // Cones and gates. Physics props carry collision:"none" so they stay OUT of the
  // static bake — see the note on PROP_CATALOG — and are simulated instead.
  const propPhysics = new PropPhysics({
    props,
    getGroundBvh: () => vehicle.groundBvh,
  });
  // Banner cloths — every flag on the track in ONE instanced draw, waved in the
  // vertex shader. The poles are ordinary "flag" props; this only owns the cloth.
  const flags = new ModularRoadFlags(scene, props);

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
    if (!sunLight) return;
    _sunDir.copy(sunLight.position);
    if (sunLight.target) _sunDir.sub(sunLight.target.position);
    if (_sunDir.lengthSq() < 1e-8) return;
    const sinElev = _sunDir.normalize().y;
    // The same normalised vector drives the smoke's per-billboard shading, and
    // the sun moves with time of day — so this is computed BEFORE the
    // autoHeadlights gate. Behind it, turning auto headlights off would also
    // freeze the smoke's lighting at whatever the sun was doing at the time.
    driftSmoke.setSunDirection(_sunDir);
    driftSmoke.setSunColor(sunLight.color, sunLight.intensity);
    if (!autoHeadlights) return;
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
    drift.reset(); // fresh drift total per run
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
    chase.reset(); tireMarks.reset(); driftSmoke.reset(); sparks.reset();
    propPhysics.reset();  // knocked cones stand back up on a lap reset
    simAccum = 0;
  }

  function checkFall() {
    const p = vehicle.body.pos;
    const y = p.y;

    // NaN BACKSTOP, and it has to be FIRST because every other test here is a
    // `<` — and every `<` against NaN is false, so a NaN car falls through all
    // of them and is never recovered. That is the difference between a bad frame
    // and a dead session: once body.pos is NaN the chase camera matrix is NaN
    // (black screen) and the HUD reads NaN, and the only thing that was ever
    // going to put the car back was this function.
    //
    // The known producer was an off-map terrain height (fixed at source in
    // sampleHeightNormalized), but a NaN pose is never recoverable in place
    // whatever made it, so it is worth catching here permanently rather than
    // trusting that no future sampler ever divides by zero.
    if (!Number.isFinite(y) || !Number.isFinite(p.x) || !Number.isFinite(p.z)) {
      console.warn("[roadGame] vehicle pose went non-finite — respawning");
      respawn();
      return;
    }

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
  // Debug orbit cam (C) — drive AND look at the car from any angle at once.
  // It owns camera.position/up directly, exactly like the chase rig, so it must
  // be mutually exclusive with BOTH the chase rig and OrbitControls. That falls
  // out for free: it only runs in drive mode, where applyControlMode() has
  // already neutered controls.update, and the chase call site below picks one.
  let debugCamOn = false;
  const chase = createChaseCamera({
    camera,
    vehicle,
    orbit: controls,
    isOrbit: () => mode === "build" || freeLook,
  });
  const debugCam = createDebugCamera({
    camera,
    vehicle,
    domElement: renderer.domElement,
    isActive: () => debugCamOn && mode === "drive" && !freeLook,
  });

  /** Which rig owns the camera this frame. Drive mode only — build is orbit. */
  const debugCamActive = () => debugCamOn && mode === "drive" && !freeLook;

  function setDebugCam(on) {
    const next = !!on;
    if (next === debugCamOn) return debugCamOn;
    debugCamOn = next;
    // Seed from wherever the other rig left the camera so the switch is a
    // continuous move rather than a cut, in BOTH directions.
    if (debugCamOn) debugCam.enter();
    else chase.reset();
    dbgEl.root?.classList.toggle("on", debugCamOn);
    return debugCamOn;
  }

  // ── Debug cam readout ──────────────────────────────────────────────────────
  // Cached element lookups: this updates every frame while the cam is on, and
  // getElementById ×8 per frame for a debug overlay is pure waste.
  const dbgEl = {
    root: document.getElementById("debug-cam"),
    frame: document.getElementById("dbg-frame"),
    pitch: document.getElementById("dbg-pitch"),
    roll: document.getElementById("dbg-roll"),
    yaw: document.getElementById("dbg-yaw"),
    grounded: document.getElementById("dbg-grounded"),
    speed: document.getElementById("dbg-speed"),
    air: document.getElementById("dbg-air"),
    dist: document.getElementById("dbg-dist"),
  };
  const _dbgFwd = new THREE.Vector3();
  const _dbgUp = new THREE.Vector3();
  const _dbgRight = new THREE.Vector3();
  const R2D = 180 / Math.PI;
  let _dbgAir = 0;

  function updateDebugReadout(dt) {
    if (!dbgEl.root || !debugCamActive()) return;
    const q = vehicle.body.quat;
    _dbgFwd.set(0, 0, 1).applyQuaternion(q);
    _dbgUp.set(0, 1, 0).applyQuaternion(q);
    _dbgRight.crossVectors(_dbgUp, _dbgFwd);
    // Pitch from the nose's elevation, roll from how far the up-axis has tipped
    // toward the car's own right — the same decomposition the landing assist
    // uses, so the numbers here match what the physics is acting on.
    const pitch = Math.asin(THREE.MathUtils.clamp(_dbgFwd.y, -1, 1)) * R2D;
    const roll = Math.atan2(_dbgRight.y, _dbgUp.y) * R2D;
    const yaw = Math.atan2(_dbgFwd.x, _dbgFwd.z) * R2D;
    const g = vehicle.groundedCount;
    _dbgAir = g === 0 ? _dbgAir + dt : 0;

    dbgEl.frame.textContent = debugCam.frame;
    dbgEl.pitch.textContent = `${pitch >= 0 ? "+" : ""}${pitch.toFixed(1)}°`;
    dbgEl.roll.textContent = `${roll >= 0 ? "+" : ""}${roll.toFixed(1)}°`;
    dbgEl.yaw.textContent = `${yaw.toFixed(0)}°`;
    dbgEl.grounded.textContent = `${g}/4`;
    dbgEl.speed.textContent = vehicle.body.vel.length().toFixed(1);
    dbgEl.air.textContent = g === 0 ? `AIRBORNE ${_dbgAir.toFixed(2)}s` : "";
    // Live distance readout — the zoom is otherwise invisible feedback, and it
    // is what told us the wheel was doing nothing at all.
    if (dbgEl.dist) dbgEl.dist.textContent = debugCam.distance.toFixed(1);
  }

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
    // A live placement brush owns Escape first — putting the brush down is the
    // most likely thing you want, and it is the only way to cancel it from the
    // keyboard.
    if (code === "escape" && brush) { clearBrush(); return; }
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
    //
    // Goes through the PALETTE rather than poking builder.setActivePiece here:
    // selecting a piece also has to clear any active prop/preset and switch the
    // visible category, and that state is private to buildRoadPaletteUI. Doing
    // half of it from out here is exactly how the palette ended up naming a
    // different piece from the one being placed — see selectPieceById.
    const byKey = PIECE_CATALOG.find((p) => p.key && p.key === e.key);
    if (byKey) {
      paletteUi?.selectPieceById?.(byKey.id);
      return;
    }
    // A live SPAWN ghost owns Q/E before the chain anchor does: while you are
    // aiming the car, "rotate" can only sensibly mean the car.
    if (brush?.kind === "spawn") {
      if (code === "keyq") { rotateSpawnBrush(DEG15); return; }
      if (code === "keye") { rotateSpawnBrush(-DEG15); return; }
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
      // Enter/Space follow the left button: with a brush armed they place the
      // PROP at the cursor, not a road piece at the chain's open end.
      case "enter": case "space":
        if (brush) { if (lastPointer) updateBrush(lastPointer.x, lastPointer.y); placeBrush(); }
        else builder.place();
        break;
      // Backspace / Shift+Backspace are the LAYOUT-PROOF pair: Backspace has no
      // letter on it, so it is in the same place and means the same thing on
      // QWERTY, AZERTY, QWERTZ and Dvorak alike. Ctrl+Z is the shortcut people
      // reach for, this is the one that cannot be moved out from under them.
      case "backspace":
        if (e.shiftKey ? builder.redo() : builder.undo()) bakeCollision();
        break;
      case "keyn": seedChainAtSpawn({ atCursor: true }); break; // new chain at the sky cursor
      case "keyk": goToBranch(); return;                        // hop to a junction branch
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
    const code = e.code.toLowerCase();
    // CTRL IS AN AIR-CONTROL KEY (pitch down), so the modifier guard below has to
    // let the Control key ITSELF through. Real Ctrl+<letter> combos are unaffected:
    // the LETTER's own event carries ctrlKey and still returns early, so
    // Ctrl+S / Ctrl+R etc. reach the browser exactly as before.
    const isCtrlKey = code === "controlleft" || code === "controlright";

    // RECORD THE KEY BEFORE THE MODIFIER GUARD, ALWAYS.
    //
    // This used to sit BELOW the early-return, and CTRL IS A DRIVING KEY (front
    // flip) — so every key pressed *while Ctrl was held* was dropped on the
    // floor. That made the flip look broken in a way that depended on the order
    // you pressed things: arrow-up then Ctrl worked, Ctrl then arrow-up gave you
    // a flip with no throttle, and Ctrl+A/D never registered the roll at all.
    // The physics was fine the whole time; the input never arrived.
    //
    // Recording here is safe: the guard below still declines to SWALLOW the
    // event, so Ctrl+S / Ctrl+R and the rest reach the browser exactly as before.
    keys[code] = true;

    // UNDO / REDO — the one modifier combo this editor claims, so it has to be
    // handled ABOVE the pass-through guard below. Ctrl+Y and Ctrl+Shift+Z are
    // both redo because both conventions are in the wild and neither is worth
    // being wrong about. Build mode only: Ctrl+Z while driving should do nothing.
    //
    // MATCHED ON `e.key`, NOT `e.code`, AND THAT IS NOT A STYLE CHOICE.
    // `e.code` names the PHYSICAL key by its US-QWERTY position, so on an AZERTY
    // keyboard the key labelled Z reports `KeyW` — and the key that does report
    // `KeyZ` is the one labelled W, i.e. Ctrl+W, i.e. CLOSE THE TAB. Browsers do
    // not let preventDefault() stop that, so a code-based match does not merely
    // fail to undo, it loses the user's work. `e.key` follows the printed label,
    // which is what "press Ctrl+Z" means to anyone on any layout.
    //
    // Driving stays on `e.code` on purpose — there WASD is a hand SHAPE, and
    // physical positions are what put it under the same fingers as ZQSD.
    if ((e.ctrlKey || e.metaKey) && !e.altKey && mode === "build") {
      const k = (e.key || "").toLowerCase();
      const redo = k === "y" || (k === "z" && e.shiftKey);
      if (redo || k === "z") {
        e.preventDefault();
        if (redo ? builder.redo() : builder.undo()) {
          bakeCollision();
          paletteUi?.refreshStatus?.();
        }
        return;
      }
    }

    // Let Ctrl/Meta/Alt combos through (browser + OS shortcuts). The editor's own
    // shortcuts are all unmodified, so this still blocks every one of them.
    if (!isCtrlKey && (e.ctrlKey || e.metaKey || e.altKey)) return;

    // Block the editor (and our now-redundant palette listener) from seeing this
    // key. stopImmediatePropagation is harmless to browser shortcuts — those
    // aren't cancelable via propagation, only via preventDefault (scoped below).
    e.stopImmediatePropagation();
    if (PREVENT_DEFAULT.has(code)) e.preventDefault();

    if (code === "keyb") { toggleMode(); return; }

    if (mode === "drive") {
      if (code === "keyr") respawn();
      // DEBUG ORBIT CAM. Recentre used to be X — that is air-roll now, so
      // recentre moved to 0 with the other view presets. Remaining debug keys
      // still miss the drive keymap (WASD / arrows / QE / ZX / space / shift / ctrl).
      else if (code === "keyc") setDebugCam(!debugCamOn);
      else if (code === "keyh") {
        // Manual headlight toggle — same as the Lights panel: takes over from auto.
        autoHeadlights = false;
        setHeadlights(!headlightsOn);
        devPanel?.refresh();
      }
      else if (debugCamActive()) {
        if (code === "keyv") debugCam.toggleFrame();
        else if (code === "digit0") debugCam.recenter();
        // Canned angles. Side-on at eye level is the one that reads a jump's
        // pitch profile, which is why they're on the number row where a thumb
        // can reach them mid-flight.
        else if (code === "digit1") debugCam.preset("behind");
        else if (code === "digit2") debugCam.preset("front");
        else if (code === "digit3") debugCam.preset("left");
        else if (code === "digit4") debugCam.preset("right");
        // Keyboard zoom as well as the wheel. Not redundant: the wheel is a
        // contested event on this canvas (the editor camera controller
        // stopPropagation()s it — see debugCamera.js), and a key cannot be
        // stolen the same way now that the game owns the keyboard outright.
        // It is also the only zoom that works one-handed mid-jump.
        else if (code === "equal" || code === "numpadadd") debugCam.zoomBy(-1);
        else if (code === "minus" || code === "numpadsubtract") debugCam.zoomBy(1);
      }
      return;
    }
    handleBuildKey(e, code); // build mode
  }, true); // ← capture phase

  // A key held when the window loses focus never gets its keyup, so it stays
  // "down" forever — come back to the tab and the car is driving itself, or
  // flipping, with nothing on the keyboard. Alt-Tab is the usual way in.
  const releaseAllKeys = () => { for (const k in keys) keys[k] = false; };
  addEventListener("blur", releaseAllKeys);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) releaseAllKeys();
  });

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
  // The brush ghost tracks the cursor. Cheap: one BVH ray plus one terrain pick.
  renderer.domElement.addEventListener("pointermove", (e) => {
    lastPointer = { x: e.clientX, y: e.clientY };
    if (!brush || mode !== "build") return;
    updateBrush(e.clientX, e.clientY);
  });
  // Leaving the canvas hides the ghost rather than freezing it at the last edge
  // position, which otherwise looks like a stuck object.
  renderer.domElement.addEventListener("pointerleave", () => {
    if (brush) { brush.root.visible = false; brush.point = null; }
  });

  renderer.domElement.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || mode !== "build") return;
    if (
      props.isUsingGizmo?.() ||
      movers.isUsingGizmo?.() ||
      portals.isUsingGizmo?.() ||
      builder.isUsingPlacementGizmo?.()
    ) return;
    // A live brush owns the left button: click places the PROP under the cursor,
    // not a road piece at the chain's open end.
    if (brush) {
      updateBrush(e.clientX, e.clientY); // the pointer may have moved since
      placeBrush();
      return;
    }
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
    // Right-click is the usual "put the tool down" gesture in an editor, so a
    // live brush consumes it rather than also selecting whatever is behind it.
    if (brush) { clearBrush(); return; }
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
  onClick("road-branch", () => { goToBranch(); });
  onClick("road-rebake", () => bakeCollision());

  /** Jump the ghost to the nearest free junction branch (button + K key). */
  function goToBranch() {
    if (builder.snapGhostToNearestBranch()) {
      paletteUi?.refreshStatus?.();
      return;
    }
    // Says why nothing happened, in the one place that is already describing
    // what the builder is doing. The next builder change refreshes it.
    const el = document.getElementById("road-status");
    if (el) el.textContent = "No open junction branches — place a fork, T, crossroads or roundabout first";
  }

  // ── TRACK SAVE / LOAD (JSON — deliberately separate from world.v3proj) ──
  //
  // `roadLook` is a MIRROR of the material's uniforms, not the source of truth:
  // the dev panel's colour pickers write straight through to the uniforms, so
  // tracking edits would mean intercepting every one of them. Re-reading on
  // every ctx() instead means a save always captures whatever is on screen,
  // however it got there.
  const roadLook = readRoadLook(roadMaterial);
  const trackCtx = () => {
    Object.assign(roadLook, readRoadLook(roadMaterial));
    return {
      builder,
      props,
      movers,
      portals,
      roadParams,
      guardrailParams,
      pieceParams,
      portalParams: portals.params,
      roadLook,
    };
  };

  /** Push the mirror at the material — after any import that touched it. */
  function applyRoadLook() {
    syncRoadUniforms(roadMaterial, roadLook);
  }

  onClick("road-save", () => {
    // `spawn` is wrapped around the lab's track format rather than folded into
    // modularRoadTrackIO — keeps that ported module untouched, and old tracks
    // without a spawn just resolve to the .v3proj start.
    const track = { ...exportTrack(trackCtx()), spawn: gameSpawn };
    downloadTrackJson(track, "modular-road-track.json");
  });

  // ── PROP SURFACE SNAP ───────────────────────────────────────────────────────
  // Cycles auto → ground → road → free. Lives in the PALETTE, not the dev panel:
  // it changes what the next click does, so it belongs beside the thing you are
  // about to place.
  const SNAP_LABEL = { auto: "Auto", ground: "Ground", road: "Road", free: "Free" };
  const snapBtn = document.getElementById("road-snap");
  const syncSnapBtn = () => {
    if (!snapBtn) return;
    snapBtn.textContent = `Snap: ${SNAP_LABEL[SURFACE_SNAP.mode] ?? SURFACE_SNAP.mode}`;
    snapBtn.classList.toggle("palette-btn-primary", SURFACE_SNAP.mode !== "free");
    snapBtn.title = {
      auto: "Ghost rides whichever you point at — road if there is any, else terrain",
      ground: "Ghost rides the terrain only — use for props UNDER an elevated road",
      road: "Ghost rides road decks only; it turns red off the road and will not place",
      free: "Ghost rides the nearest surface but the prop is left exactly where you click",
    }[SURFACE_SNAP.mode];
  };
  onClick("road-snap", () => {
    const i = SURFACE_SNAP_MODES.indexOf(SURFACE_SNAP.mode);
    SURFACE_SNAP.mode = SURFACE_SNAP_MODES[(i + 1) % SURFACE_SNAP_MODES.length];
    syncSnapBtn();
    // A live brush is riding the OLD surface — re-pick so the ghost jumps to the
    // new one immediately instead of on the next mouse move.
    if (brush && lastPointer) updateBrush(lastPointer.x, lastPointer.y);
    // Re-snap the SELECTED prop only. Re-snapping everything would silently
    // relocate props placed under an earlier mode, which is not what switching
    // a placement setting should mean.
    if (props.selected) { props.snapToSurface(props.selected); bakeCollision(); }
  });
  syncSnapBtn();

  const trackFileInput = createTrackFileInput((data) => {
    // The same button also takes a LOOK file exported from road-piece-lab.html.
    // It is not a track — it repaints the one already loaded and leaves the
    // layout alone — so it has to be caught before importTrack, which would
    // reject it as an unknown format.
    if (data?.format === ROAD_LOOK_FORMAT) {
      Object.assign(roadLook, data.roadLook ?? {});
      applyRoadLook();
      devPanel?.refresh?.();
      paletteUi.refreshStatus();
      console.info("[ModularRoad-v3] road look applied from file");
      return;
    }
    const res = importTrack(data, trackCtx());
    if (!res.ok) {
      console.warn("[ModularRoad-v3] track load failed:", res.error);
      alert(`Could not load track: ${res.error}`);
      return;
    }
    applyRoadLook();
    gameSpawn = data.spawn ?? null;
    updateSpawnMarker();
    bakeCollision();
    propPhysics.sync();
    propInstancer.sync();
    flags.sync();
    paletteUi.refreshStatus();
  });
  document.body.appendChild(trackFileInput);
  onClick("road-load", () => trackFileInput.click());

  // ── SHIPPED PRESET TRACKS ───────────────────────────────────────────────────
  // Same importTrack path as the file picker above, just fetched instead of
  // read from disk — so a preset can never diverge from a hand-loaded save.
  //
  // road.html sets <base href="/v3/">, so a relative Vite asset URL would
  // resolve under /v3/ and 404. Absolute /assets/... URLs are left alone.
  const presetFetchUrl = (imported) => {
    if (/^(?:https?:)?\/\//.test(imported) || imported.startsWith("/")) return imported;
    return new URL(imported, `${window.location.origin}/`).href;
  };
  const loadPresetTrack = (btnId, importedUrl, idleLabel) => {
    const url = presetFetchUrl(importedUrl);
    onClick(btnId, async () => {
      const btn = document.getElementById(btnId);
      if (btn) { btn.disabled = true; btn.textContent = "Loading…"; }
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const data = await res.json();
        const out = importTrack(data, trackCtx());
        if (!out.ok) throw new Error(out.error);
        applyRoadLook();
        gameSpawn = data.spawn ?? null;
        updateSpawnMarker();
        bakeCollision();
        propPhysics.sync();
        propInstancer.sync();
        flags.sync();
        paletteUi.refreshStatus();
        devPanel?.refresh();
        console.info(`[ModularRoad-v3] preset track loaded: ${data.pieces?.length ?? 0} pieces`);
      } catch (e) {
        console.warn("[ModularRoad-v3] preset track failed:", url, e);
        alert(`Could not load the preset track:
${e.message}`);
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = idleLabel; }
      }
    });
  };
  loadPresetTrack("road-preset", apexTrackUrl, "Load Apex track");
  loadPresetTrack("road-preset-rushline", rushlineTrackUrl, "Load Rushline track");

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
    // AIR ROLL ON ITS OWN KEYS — Z = roll left, X = roll right. Left/right
    // (A/D / arrows) stays the steering rack, including in the air, so a small
    // jump can still aim the tyres for the landing. Same sign as steerTarget
    // (+1 left); the vehicle negates it so press-right rolls right.
    const kbRoll = (keys.keyz ? 1 : 0) - (keys.keyx ? 1 : 0);
    // AIR PITCH ON ITS OWN KEYS — Shift = nose up (backflip), Ctrl = nose down
    // (frontflip). Deliberately NOT the throttle: the gas is held almost all the
    // time, so sharing it made every jump a forced flip (see the note in
    // _applyStabilizer). Shift/Ctrl sit under the left hand while WASD is busy.
    const up = keys.shiftleft || keys.shiftright;
    const down = keys.controlleft || keys.controlright;
    const kbPitch = (up ? 1 : 0) - (down ? 1 : 0);

    const gp = gamepad.read();
    padRespawnPressed = !!gp?.respawnPressed;
    if (!gp) {
      return {
        steerTarget: kbSteer,
        rollTarget: kbRoll,
        throttle: kbThrottle,
        handbrake: !!keys.space,
        yaw: kbYaw,
        pitch: kbPitch,
        analog: false,
      };
    }
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

  /** Down-track yaw from a placed piece (same convention as setSpawnToCar). */
  function yawFromPiece(p) {
    _inPos.setFromMatrixPosition(p.connectorIn);
    _outPos.setFromMatrixPosition(p.connectorOut);
    _fwd.copy(_outPos).sub(_inPos);
    if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, -1);
    _fwd.normalize();
    return Math.atan2(_fwd.x, _fwd.z) - Math.PI;
  }

  /**
   * On-deck, down-track pose from a placed piece — the car sits on the piece's
   * surface a little past its entry edge, facing the way the track runs.
   */
  function poseFromPiece(p) {
    _inPos.setFromMatrixPosition(p.connectorIn);
    _fwd.copy(_outPos.setFromMatrixPosition(p.connectorOut)).sub(_inPos);
    if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, -1);
    _fwd.normalize();
    return {
      x: _inPos.x + _fwd.x * 2, // a touch into the piece, off the entry seam
      y: _inPos.y,
      z: _inPos.z + _fwd.z * 2,
      yaw: Math.atan2(_fwd.x, _fwd.z) - Math.PI,
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

  // Marker so the spawn is visible while building. Build-mode only.
  //
  // This WAS a big green cone, which had to be read as "an arrow, and the car
  // will be somewhere around its base, facing along it" — a legend you had to
  // know. It is now the same car silhouette the placement tool uses, so the
  // marker simply shows the car standing where it will stand. Nothing to decode.
  //
  // Deliberately a DIFFERENT, dimmer material from GHOST_OK: while the tool is
  // armed both are on screen at once, and they mean different things ("the spawn
  // is here" vs "the next click puts it here"). Same shape, different weight.
  const SPAWN_MARKER_MAT = new THREE.MeshBasicMaterial({
    color: 0x2fbf8f, transparent: true, opacity: 0.28, depthWrite: false,
  });
  const spawnMarker = new THREE.Group();
  spawnMarker.name = "RoadSpawnMarker";
  /** The car silhouette inside the marker — swapped out when the GLB lands. */
  let spawnMarkerCar = null;
  {
    // A ground ring, because a car-sized marker is hard to FIND on a big track
    // (the cone was at least tall). Sits on the surface, under the car.
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(2.6, 3.1, 40),
      new THREE.MeshBasicMaterial({
        color: 0x35e07a, transparent: true, opacity: 0.5,
        depthWrite: false, side: THREE.DoubleSide,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.03;
    ring.frustumCulled = false;
    spawnMarker.add(ring);
  }
  scene.add(spawnMarker);

  /**
   * (Re)build the marker's car silhouette.
   *
   * Called once at boot and AGAIN when the chassis GLB finishes loading — the
   * marker is created long before the model arrives, so without the second call
   * it would keep the primitive stand-in for the whole session.
   */
  function rebuildSpawnMarkerCar() {
    if (spawnMarkerCar) {
      spawnMarker.remove(spawnMarkerCar);
      // Only the primitive fallback owns its geometry; a GLB clone shares the
      // player car's buffers. Same rule as the placement brush.
      if (!spawnMarkerCar.userData.sharedGeo) {
        spawnMarkerCar.traverse((o) => { if (o.isMesh) o.geometry?.dispose(); });
      }
    }
    spawnMarkerCar = buildSpawnGhost(SPAWN_MARKER_MAT, "RoadSpawnMarkerCar");
    spawnMarkerCar.userData.sharedGeo = !!chassisGlbObject;
    // Lift by the same SPAWN_LIFT respawn() uses, so the silhouette stands
    // exactly where the body will.
    spawnMarkerCar.position.y = SPAWN_LIFT;
    spawnMarker.add(spawnMarkerCar);
  }
  rebuildSpawnMarkerCar();

  function updateSpawnMarker() {
    const s = resolveSpawn();
    // The GROUP now sits on the surface (the ring is a ground decal); the car
    // child carries SPAWN_LIFT itself.
    spawnMarker.position.set(s.x, s.y, s.z);
    // `+ Math.PI` IS THE POINT — do not "simplify" it away.
    //
    // The silhouette faces along the marker's local +Z, and the chassis' forward
    // axis is also local +Z, but the STORED yaw is the car's yaw minus π (the
    // convention setSpawnToCar and yawFromPiece both write in, and that respawn()
    // undoes with the same `+ Math.PI` two functions down). Without it the marker
    // rendered the exact opposite of the direction the car spawns facing: you
    // would line it up down-track, hit drive, and set off backwards.
    spawnMarker.rotation.set(0, s.yaw + Math.PI, 0);
  }

  /** Capture the car's current pose as the spawn (drive to a good start, click). */
  function setSpawnToCar() {
    const b = vehicle.body;
    const e = new THREE.Euler().setFromQuaternion(b.quat, "YXZ");
    gameSpawn = { x: b.pos.x, y: b.pos.y, z: b.pos.z, yaw: e.y - Math.PI };
    updateSpawnMarker();
  }

  // NOTE — "Set under crosshair" USED TO LIVE HERE, and it is gone on purpose.
  //
  // It read the last canvas pointer position and claimed to fall back to canvas
  // centre "if your pointer is on the panel". It never did: the canvas is
  // full-screen (road.html pins #viewport to inset:0) and the dev panel is an
  // overlay sibling, so the last-known pointer was ALWAYS inside the canvas rect
  // and the centre branch was dead code. What you actually got was the road under
  // wherever the mouse happened to cross the viewport on its way to the button —
  // i.e. a spot near the panel edge, unrelated to anything you aimed at. It also
  // only ever queried the deck BVH, so terrain spawns were impossible, and a miss
  // returned null and did nothing at all with no feedback.
  //
  // armSpawnBrush() replaces it: the ghost is under the cursor the whole time, so
  // there is no "where did it think I was pointing" left to get wrong.

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
  // jump lands so you can place the landing. Gravity AND drag match the
  // vehicle's — a vacuum parabola over-shoots the real car by 2–5% of range
  // (tools/gapPreviewAccuracyTest.mjs), which is 10 m on a big jump. Both AERO
  // and CHASSIS are dev-panel-tunable, so `dragK` is refreshed per update rather
  // than captured here.
  //
  // `gapSurfaceHit` is what stops the arc being a line into the void. The plane
  // at (launch height − landingDrop) can only ever fire if the launch CLIMBS, so
  // off a level open end — the commonest thing to be looking at in build mode —
  // the old preview drew 459 m of red line through the terrain and marked
  // nothing. Now the arc lands on whatever is actually there.
  const _gapFrom = new THREE.Vector3();
  const _gapDir = new THREE.Vector3();
  const _gapHit = new THREE.Vector3();
  function gapSurfaceHit(from, to) {
    // 1) ROAD DECKS FIRST — a platform you might land on sits above the terrain,
    //    so testing terrain first would mark the ground underneath it.
    _gapDir.copy(to).sub(from);
    const len = _gapDir.length();
    if (len < 1e-6) return null;
    _gapDir.divideScalar(len);
    if (deckBvh?.baked) {
      const hit = deckBvh.raycastFirst(from, _gapDir, len);
      if (hit) return hit.point;
    }
    // 2) TERRAIN — a heightfield, so a segment test is just the sign change of
    //    (arc y − ground y) at the two ends. No raycast needed, and at ~1.3 m of
    //    arc per segment the linear crossing is well inside the marker's radius.
    const gTo = app.getWorldHeight(to.x, to.z);
    if (to.y > gTo) return null;
    const gFrom = app.getWorldHeight(from.x, from.z);
    const d0 = from.y - gFrom;
    if (d0 <= 0) return _gapHit.copy(to); // already underground — land here
    const d1 = to.y - gTo;
    return _gapHit.copy(from).lerp(to, d0 / (d0 - d1));
  }

  const gapPreview = new GapPreview({ scene, gravity: GRAVITY, surfaceHit: gapSurfaceHit });
  let gapPreviewOn = true;
  // ~80% of TIRE.topSpeed — the speed you realistically hit a ramp at. Scale it
  // with top speed or the previewed arc will under-shoot every jump you build.
  let refSpeed = 40;       // m/s launch speed the arc assumes
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
    sparks.reset();
    simAccum = 0;
  }

  const paletteEl = document.getElementById("palette");
  // Hint / shortcuts live in the Mode section of the right-hand panel (temporary
  // until a dedicated menu exists). Looked up AFTER the panel is built below.

  // ── RACE HUD ────────────────────────────────────────────────────────────────
  const hud = document.getElementById("race-hud");
  const hudTime = document.getElementById("race-time");
  const hudLap = document.getElementById("race-lap");
  const hudNext = document.getElementById("race-next");
  const hudBest = document.getElementById("race-best");
  const hudFlash = document.getElementById("race-flash");
  const hudSplit = document.getElementById("race-split");
  // The arc speedo's three elements. Its markup is commented out in road.html
  // (the segment dash replaced it), so these are null and every use below is
  // guarded — uncomment the markup and the arc drives itself again.
  const hudSpeed = document.querySelector("#race-speed .v");
  const hudGaugeVal = document.getElementById("gauge-val");
  const hudGear = document.getElementById("race-gear");
  // Segment dash (speed bar + 7-seg speed/gear + tach ladder). Full scale is
  // rounded UP from top speed to the next tick step so a downhill overspeed
  // still has bar left to light instead of pinning.
  const dash = createSegmentDash(document.getElementById("race-dash"), {
    speedMaxKmh: Math.ceil((TIRE.topSpeed * 3.6 * 1.1) / 20) * 20,
  });
  // Auto gearbox is DISPLAY-ONLY — the car has no transmission (see gearbox.js).
  const gearbox = createGearbox();
  // Drift scoring — always on, no mode. See driftScore.js.
  const drift = createDriftScore();
  /**
   * Did the chassis touch a solid at ANY point during this frame's physics?
   *
   * `vehicle.hitSolid` is a per-TICK pulse: `tick()` clears it at the top and
   * `_resolveSolidBvh` re-raises it, so reading it once per frame only ever sees
   * the LAST of the (usually 2) ticks a 60 Hz frame runs. On top of that, solid
   * response is projection-based — it pushes the car out, so the next tick
   * usually is NOT penetrating and a continuous rail scrape is an on/off flicker
   * at tick rate. Together those made "hitting a wall breaks your drift chain"
   * fire only about half the time, at random.
   *
   * The vehicle already solved the same problem for SPARKS with a 0.12 s latch
   * (`vehicle.scraping`), but that is the wrong tool here: its hold time is a
   * VFX look knob, and scoring should not change when someone retunes sparks.
   * OR-ing the raw flag across the frame's ticks is exact — every contact is
   * caught, with no window to tune and nothing held past the frame it happened
   * in.
   */
  let hitSolidThisFrame = false;
  /**
   * Did the car land on its ROOF hard this frame? Same per-tick-pulse problem as
   * `hitSolidThisFrame`, so it is OR-ed the same way.
   *
   * Separate from `hitSolid` because it is a different event: a rail is
   * something you clip, a roof landing is a crash. It breaks the drift chain for
   * the same reason a rail does — the risk is what makes a long chain worth
   * holding — and the vehicle's own STUCK detector still owns the respawn.
   */
  let roofHitThisFrame = false;
  const hudDrift = document.getElementById("race-drift");
  const hudDriftPts = document.getElementById("race-drift-pts");
  const hudDriftMul = document.getElementById("race-drift-mul");
  const hudDriftBank = document.getElementById("race-drift-bank");
  let driftBankFlash = 0;
  let _driftShown = false;
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

    // FULL 3D speed — do not drop the Y component. Horizontal-only speed is
    // only the real speed while the road is level: on the vertical flanks of a
    // loop the car is moving almost straight up, so a car doing 146 km/h read
    // 4 km/h on the HUD and the tach fell to idle right before the top. It
    // looked exactly like the car was bogging down and stalling out of the
    // loop, but the car was never actually slowing — the measured minimum on a
    // clean loop is 108 km/h (tools/loopSpeedReadoutTest.mjs).
    // Same applies to quarter-pipes, wall-rides and tubes.
    const speedMs = vehicle.body.vel.length();
    if (hudSpeed) hudSpeed.textContent = String(Math.round(speedMs * 3.6));

    // Tach + gear. Forward speed is SIGNED (dot with the car's own forward) so
    // the box can tell reversing from sliding backwards — a magnitude can't.
    _hudFwd.set(0, 0, 1).applyQuaternion(vehicle.body.quat);
    const g = gearbox.update(speedMs, TIRE.topSpeed, vehicle.body.vel.dot(_hudFwd));

    // Segment dash. Same numbers as the arc speedo drove — only the drawing
    // changed — so the two can run side by side if the old markup comes back.
    dash.update(dt, {
      speedKmh: speedMs * 3.6,
      gearLabel: g.label,
      rpm: g.rpm,
      reverse: g.reverse,
      redline: GEARBOX.redline,
    });

    if (hudGaugeVal) {
      // pathLength=100 on the arc ⇒ dashoffset is just "100 − percent".
      const shown = Math.min(1, g.rpm);
      hudGaugeVal.setAttribute("stroke-dashoffset", String(100 - shown * 100));
      const hot = g.rpm >= GEARBOX.redline;
      const stroke = g.reverse ? "#ffd24a" : hot ? "#ff6b45" : "#4a9eff";
      // Only touch the attribute on change — this runs every frame.
      if (stroke !== _hudStroke) { hudGaugeVal.setAttribute("stroke", stroke); _hudStroke = stroke; }
    }
    // ── DRIFT ────────────────────────────────────────────────────────────
    // Fed from the vehicle's own slip angle (measured in the chassis' ground
    // plane, so it stays right on banks and inside loops).
    drift.update(dt, {
      slip: vehicle.slipAngle,
      speed: speedMs,
      grounded: vehicle.groundedCount > 0,
      // Landing on the lid ends a chain exactly as hitting a rail does.
      hitSolid: hitSolidThisFrame || roofHitThisFrame,
    });
    const banked = drift.consumeBanked();
    if (banked > 0) {
      driftBankFlash = 1.1;
      if (hudDriftBank) hudDriftBank.textContent = `+${banked.toLocaleString()}`;
    }
    if (drift.consumeFailed()) {
      driftBankFlash = 0.9;
      if (hudDriftBank) hudDriftBank.textContent = "LOST";
    }
    if (driftBankFlash > 0) driftBankFlash -= dt;
    if (hudDrift) {
      // Visible while chaining or while a bank/lost flash is running.
      const show = drift.drifting || drift.pending > 0 || driftBankFlash > 0;
      if (show !== _driftShown) { hudDrift.classList.toggle("on", show); _driftShown = show; }
      if (show) {
        if (hudDriftPts) hudDriftPts.textContent = drift.pending.toLocaleString();
        if (hudDriftMul) hudDriftMul.textContent = `x${drift.multiplier}`;
        if (hudDriftBank) hudDriftBank.className = driftBankFlash > 0 ? "show" : "";
      }
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
    if (driving) clearBrush(); // no cursor brush while racing
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
      // THE EDITOR SHOWS THE AUTHORED STATE. Nothing else put props back on the
      // way IN to build mode — only respawn/lap-reset did, which are drive-mode
      // events — so a gate you had just driven through stayed hanging open and a
      // punted cone stayed on its side while you edited around them. Saving is a
      // build-mode act, so what you were looking at was also what you were about
      // to save (the save itself is now immune — see PropManager.exportInstances
      // — but showing a pose the file does not contain is its own bug).
      propPhysics.reset();
    }
    // The debug cam only exists in drive mode. Its ON state SURVIVES a trip to
    // build mode (you go there to move a ramp and come straight back), so
    // re-seed the rig on the way in or it would resume from the angle it held
    // before the editor moved the camera somewhere else entirely.
    if (driving && debugCamOn) debugCam.enter();
    dbgEl.root?.classList.toggle("on", driving && debugCamOn);
    if (driving) { gapPreview.setVisible(false); if (buildGrid) buildGrid.visible = false; } // build-only aids
    spawnMarker.visible = !driving; // a build-time guide; hidden while racing
    if (hud) hud.classList.toggle("on", driving);
    if (paletteEl) paletteEl.style.display = driving ? "none" : "";
    document.getElementById("hint")?.setAttribute("data-mode", mode);
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
  // player-facing UI is the palette; shortcuts sit in the panel Mode section
  // for now.
  let worldName = boot.name;
  devPanel = createRoadDevPanel({
    app,
    params: { TIRE, AERO, DRIVETRAIN, DECK, SOLID, BODYLEAN, HEADLIGHTS, WHEEL_LAYOUT, DRIFT, glowPropParams },
    game: {
      setSpawnToCar,
      clearSpawn,
      hasSpawn: () => gameSpawn != null,
      /** Arm the car ghost. `mode` is 'road' or 'ground'. */
      placeSpawn: (mode) => armSpawnBrush(mode),
      cancelSpawnPlacement: () => { if (brush?.kind === "spawn") clearBrush(); },
      /** 'road' | 'ground' while the ghost is armed, else null — drives the
       *  panel's active-button state. */
      spawnPlacingMode: () => (brush?.kind === "spawn" ? brush.snapMode : null),
      setHeadlights,
      getHeadlights: () => headlightsOn,
      setAutoHeadlights: (on) => { autoHeadlights = !!on; updateAutoHeadlights(); },
      getAutoHeadlights: () => autoHeadlights,
      // Re-push HEADLIGHTS params onto the rig after a slider moves.
      refreshLights: () => vehicle.applyHeadlightParams(),
      // glowPropParams is shared by every placed glow prop; this pushes the new
      // values onto them (emissive is a live node, so bloom follows for free).
      refreshGlowProps: () => props.applyGlowParams(),
      // Prop liveries — the panel needs the SELECTION, since the swatches it
      // draws are whatever palette the selected prop declares.
      getSelectedProp: () => {
        const s = props.selected;
        if (!s) return null;
        return {
          id: s.id,
          label: s.def?.label ?? s.id,
          variant: s.variant ?? 0,
          variants: s.def?.variants ?? [],
          hasDecal: !!s.def?.decal,
          decal: !!s.decal,
        };
      },
      setPropVariant: (i) => props.setSelectedVariant(i),
      setPropDecal: (on) => props.setSelectedDecal(on),
      randomisePropVariants: () => props.randomiseVariants(props.selected?.id ?? null),
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
      hasChassisModel: () => vehicle.hasChassisModel,
      getChassisStyle: () => vehicle.chassisStyle,
      setChassisStyle: (s) => vehicle.setChassisStyle(s),
      // Live fit. The panel mutates CHASSIS_GLB in place (that's what slider()
      // does) and then asks for a re-transform.
      applyWheelLayout: () => vehicle.applyWheelLayout(),
      getDriftSmokeSettings: () => driftSmoke.settings,
      getSparkSettings: () => sparks.settings,
      // Banner flags. One image for ALL of them — that is the cost of a single
      // instanced draw; per-flag pictures would need a draw each or an atlas.
      getFlagParams: () => FLAG,
      applyFlagParams: () => flags.applyParams(),
      setFlagTextureFile: (file) => flags.setTextureFile(file),
      clearFlagTexture: () => flags.clearTexture(),
      flagHasTexture: () => flags.hasTexture,
      flagCount: () => flags.count,
      getPropPhysics: () => PROP_PHYSICS,
      syncPropPhysics: () => propPhysics.sync(),
      awakeProps: () => propPhysics.awakeCount,
      // World lighting. The engine re-reads these every frame via its own
      // dirty-check, so mutating them is enough — except time of day, which has
      // to recompute the sun's astronomical position.
      getLightState: () => app.light?.state ?? null,
      getSkyState: () => app.sky?.state ?? null,
      setTimeOfDay: (t) => app.sky?.setTimeOfDay(t),
      getChassisFit: () => CHASSIS_GLB,
      applyChassisFit: () => {
        applyChassisGlbTransform(chassisGlbObject);
        // Beams live on the anchor, not the model, so they need re-deriving.
        vehicle.setHeadlampMounts(chassisGlbMounts(chassisLampsLocal));
      },
      resetChassisFit: () => {
        const r = resetChassisGlbFit(chassisGlbObject);
        vehicle.setHeadlampMounts(chassisGlbMounts(chassisLampsLocal));
        return r;
      },
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
      getSelectedEdges: () => builder.selectedPiece?.edges ?? true,
      toggleSelectedEdges: () => {
        const sp = builder.selectedPiece;
        if (sp) builder.setPieceEdges(sp, !(sp.edges ?? true));
      },
      isSelectedDetached: () => !!builder.selectedPiece?.detached,
      toggleSelectedDetached: () => {
        const sp = builder.selectedPiece;
        if (!sp) return;
        if (sp.detached) builder.attachPiece(sp);
        else { builder.detachPiece(sp); builder.rebuildAll(); }
      },
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
      // Skid-mark look. Geometry is shared, so this is a live material swap —
      // the flat ribbon stays available if the texture doesn't convince.
      getSkidStyle: () => tireMarks.style,
      toggleSkidStyle: () =>
        tireMarks.setStyle(tireMarks.style === "textured" ? "solid" : "textured"),
      setDriftSmokeEnabled: (on) => {
        driftSmoke.settings.enabled = !!on;
        driftSmoke.setVisible(!!on);
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
      /** Dial the arc/marker glow live, e.g. setGapGlow({ arc: 14 }). */
      setGapGlow: (g) => gapPreview.setGlow(g),
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
  const frame = () => {
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
      // Latch solid contact across every tick this frame — see the declaration.
      // Reset here rather than after reading it, so a frame that runs ZERO ticks
      // (framerate above the 120 Hz sim rate) reports no contact, which is
      // correct: no physics happened, so nothing new was hit.
      hitSolidThisFrame = false;
      roofHitThisFrame = false;
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
        if (vehicle.hitSolid) hitSolidThisFrame = true;
        // Same per-tick pulse, same reason it has to be OR-ed across the frame.
        if (vehicle.roofImpact) roofHitThisFrame = true;
        props.applyFields(vehicle, FIXED_DT);      // boost pads etc.
        propPhysics.tick(FIXED_DT, vehicle);       // cones, gates
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
      sparks.updateFromVehicle(vehicle, camera, dt);
      // Render-rate, not the fixed step: the wave is purely visual and this only
      // advances a uniform — the flags themselves cost no CPU per frame.
      flags.update(dt);
      updateDynamicDebug(); // live collider wireframes, when they are switched on

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
        gapPreview.dragK = AERO.drag / CHASSIS.mass;
        lastLanding = gapPreview.update(builder.currentConnector, refSpeed, landingDrop);
      } else {
        gapPreview.setVisible(false);
      }
      updateBuildGrid();
    }

    // Portal doors animate (shimmer / ring spin) in BOTH modes — this was missing,
    // so doors sat frozen.
    portals.updateVisuals(dt);

    // BOTH MODES, and once per FRAME. Drive mode moves props through the sim;
    // build mode moves them through the gizmo, and there is no single hook for
    // "the gizmo dragged something" — so this just copies the current root poses
    // into the instance buffers, which is a matrix write per prop and nothing
    // else. Per SUBSTEP would repeat the same GPU upload two or three times.
    propInstancer.update();

    // ONE rig owns camera.position/up per frame. Both write it directly, so
    // running both would make them alternate and the view would shake (the same
    // failure the chase rig's controls.update patch exists to prevent).
    if (debugCamActive()) debugCam.update(dt);
    else chase.update(dt);
    updateDebugReadout(dt);

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

  };

  /**
   * THE NEXT FRAME IS BOOKED BEFORE THIS ONE RUNS, and that ordering is the
   * whole point of this wrapper.
   *
   * It used to be the last statement inside the frame body, so ONE throw
   * anywhere in it — sim, HUD, camera, a bad geometry — never reached the
   * re-schedule and the loop stopped for good. Nothing on screen said so. The
   * keyboard handler is registered separately and kept firing, so R and B still
   * ran `respawn()` and `toggleMode()` perfectly; they just had no frame left to
   * draw the result in. The bug reads as "the game ignores every key", which
   * sends you looking at input handling, which is fine.
   *
   * Scheduling first means a throwing frame costs a frame instead of the
   * session. The error is deliberately NOT swallowed — it goes to the console
   * uncaught, where it is the actual diagnostic — but a frame that throws every
   * time would spam without end, so a run of them gives up loudly rather than
   * silently.
   */
  const MAX_CONSECUTIVE_FRAME_ERRORS = 120; // ~2 s at 60 Hz
  let frameErrors = 0;
  const tick = () => {
    app._roadRaf = requestAnimationFrame(tick);
    try {
      frame();
      frameErrors = 0;
    } catch (err) {
      console.error("[roadGame] frame failed", err);
      if (++frameErrors >= MAX_CONSECUTIVE_FRAME_ERRORS) {
        cancelAnimationFrame(app._roadRaf);
        app._roadRaf = null;
        console.error(
          `[roadGame] ${frameErrors} consecutive failed frames — stopping the loop. Reload the page.`,
        );
        onStatus("crashed — see console");
      }
    }
  };
  app._roadRaf = requestAnimationFrame(tick);

  onStatus("ready");

  const handle = {
    app,
    builder,
    vehicle,
    props,
    movers,
    portals,
    bakeCollision,
    respawn,
    toggleMode,
    get mode() { return mode; },
    world: boot,
    /** Surface look as plain JSON — the same object a track save carries and
     *  road-piece-lab.html exports. */
    getRoadLook: () => readRoadLook(roadMaterial),
    setRoadLook: (l) => {
      Object.assign(roadLook, l ?? {});
      applyRoadLook();
    },
  };
  window.__roadGame = handle; // console debugging (window.__road is just the engine app)
  return handle;
}
