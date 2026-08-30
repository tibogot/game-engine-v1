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
// Vite bundles these and injects them — see the note in road.html for why they
// are not <link> tags.
//
// editor.css FIRST: the dev panel is built out of the v3 editor's own classes
// (.inspector-section / .prop-row / .action-btn — see devPanel.js) and its
// :root variables, so without this sheet the panel renders as raw unstyled
// markup. It used to be a <link href="./styles/editor.css"> in road.html,
// which worked in dev only because <base href="/v3/"> pointed the browser at
// the source file; Vite resolves HTML hrefs relative to the HTML FILE, found
// no games/modular-road-v3/styles/, and left the tag alone — so the built site
// asked for /v3/styles/editor.css and got a 404.
import "../../v3/styles/editor.css";
import "./palette.css";
import { startV3App } from "../../v3/app/main.js";
import { createModularRoadClouds } from "./modularRoadClouds.js";
import {
  Vehicle,
  FIXED_DT,
  TIRE,
  AERO,
  ROAD_HOLD,
  DRIVETRAIN,
  DECK,
  SOLID,
  STUCK,
  BODYLEAN,
  WHEEL_LAYOUT,
  HEADLIGHTS,
  CHASSIS_GLB_LIGHTS,
  CHASSIS,
  CHASSIS_HULL,
  WHEEL,
  WHEEL_LOCAL,
  DRIFT,
  GRAVITY,
} from "../../v3/play/modularRoadVehicle.js";
import { RoadBvh } from "../../v3/play/modularRoadBvh.js";
import { BvhSet } from "../../v3/play/modularRoadRigidBvh.js";
import { createVehicleGround } from "../../v3/play/modularRoadGround.js";
import { SCENERY_MAP } from "./modularRoadScenery.js";
import { isSharedGeometry } from "./modularRoadBatching.js";
import {
  createCarReflection,
  lightReflection,
  REFLECT_LAYER,
  PREMIRROR_LAYER,
} from "./modularRoadReflection.js";
import {
  createGuardrailMaterial,
  createTunnelMaterial,
  createVaultTunnelMaterial,
  createTunnelGlowMaterial,
  createTunnelGlowMaterialForThumb,
  createDecorMaterial,
  createStartGateBodyMaterial,
  createStartGateGlowMaterial,
  createFinishGateGlowMaterial,
  createCheckpointGlowMaterial,
  createStartGateBodyMaterialForThumb,
  createStartGateGlowMaterialForThumb,
  createFinishGateGlowMaterialForThumb,
  createCheckpointGlowMaterialForThumb,
  createRoadGlassMaterial,
  createTubeMaterial,
  createCheapAsphaltMaterial,
  readRoadLook,
  roadLookDefaults,
  syncRoadUniforms,
  syncTubeUniforms,
  ROAD_LOOK_FORMAT,
} from "./modularRoadMaterial.js";
import {
  createRoadSurfaceV2,
  SURFACE_V2_DEFAULTS,
  SURFACE_V2_GAME,
  surfaceV2NeedsRebuild,
  syncSurfaceV2Uniforms,
} from "./modularRoadSurfaceV2.js";
import { ModularRoadBuilder, buildRoadPaletteUI, CATEGORY_PRESETS } from "./modularRoadBuilder.js";
import {
  PIECE_CATALOG,
  roadParams,
  pieceParams,
  guardrailParams,
  startNewLineDist,
  ROAD_PARAM_DEFAULTS,
  GUARDRAIL_PARAM_DEFAULTS,
  PIECE_PARAM_DEFAULTS,
} from "./modularRoadKit.js";
import { bakeRoadThumbnails, createThumbnailSprites } from "./modularRoadThumbnails.js";
import {
  thumbnailSignature,
  loadThumbnailCache,
  saveThumbnailCache,
  clearThumbnailCache,
} from "./modularRoadThumbnailCache.js";
import {
  PropManager, PROP_CATALOG, PROP_BY_ID, glowPropParams, SURFACE_SNAP, SURFACE_SNAP_MODES, DECAL_URL,
} from "./modularRoadProps.js";
import {
  MoverPropManager, MOVER_CATALOG, MOVER_BY_ID, preloadWindmillModel,
  createMoverInspector,
} from "./modularRoadMoverProps.js";
import { PortalManager, DEFAULT_PORTAL_PARAMS, buildPortalMesh } from "./modularRoadPortals.js";
import { GapPreview } from "./gapPreview.js";
import { RunTracker, formatRunTime } from "./modularRoadRun.js";
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
  bakeGhostCarGeometry,
} from "./chassisModel.js";
import { ModularRoadSparks, DEFAULT_SPARK_SETTINGS } from "./modularRoadSparks.js";
import { PropPhysics, PROP_PHYSICS, PHYSICS_PROP_TYPES } from "./modularRoadPropPhysics.js";
import { PropInstancer } from "./modularRoadPropInstancer.js";
import { preloadContainer } from "./modularRoadContainer.js";
import { preloadTireWall } from "./modularRoadTireWall.js";
import { preloadCrane } from "./modularRoadCrane.js";
import { preloadPalm } from "./modularRoadPalm.js";
import { preloadBarrel } from "./modularRoadBarrel.js";
import { preloadDecal, settleDecals } from "./modularRoadDecals.js";
import { ModularRoadFlags, FLAG } from "./modularRoadFlags.js";
import { loadBootWorld, loadWorldFromFile } from "./worldLoader.js";
import { createRoadDevPanel } from "./devPanel.js";
// Vite `?url` copies these into dist (dev AND Vercel). A raw fetch of
// /games/modular-road-v3/*.json 404s on deploy: Vite only emits public/ and
// imported assets — the source folder itself is not published.
import auditTrackUrl from "./audittest.json?url";

/** Cap on physics ticks per frame — a long stall must not queue a huge backlog. */
const MAX_SIM_TICKS = 8;
/** Absolute-Y backstop: below this the car is always respawned. */
const FALL_Y = -60;
/** Air-stunt: dropping this far BELOW the last grounded height is a *candidate*
 *  miss. checkFall then probes the deck along the fall; if there is still road
   *  to land on, the car keeps falling. Empty sky next to the road you were
   *  on snaps back to last-safe; a miss after a jump goes to spawn.
   *  Relative to the track, so it works at any altitude. */
const FALL_DROP = 12;
/** How far ahead (m) the landing-piece test looks. A 30° jump off a 160 m
 *  drop lands hundreds of metres out — a short ray from the lip never sees it. */
const FALL_LAND_AHEAD = 600;
/** Half-width of that corridor (16 m road + aiming slop). */
const FALL_LAND_HALF = 32;
/** Radius counted as "the road is under me". */
const FALL_LAND_NEAR = 40;
/** Last-safe recover is only for slipping off the road you were just on.
 *  Past this XZ distance (m) from that pose you have left the lip — a fall
 *  is a fail and goes to spawn, not back onto the jump. */
const FALL_SAFE_RANGE = 40;
/** Same idea vertically: a kerb/side fall is ~FALL_DROP; a missed jump is
 *  tens of metres under the takeoff. */
const FALL_SAFE_DROP = 28;
/** Seconds of visible falling after a jump miss, before spawn. Instant
 *  teleport reads as a glitch; this is the "you lost" beat. Void floor
 *  still catches earlier if they get there first. */
const FAIL_FALL_TIME = 1.6;
/** Sky mode: how far below the LOWEST track piece the void backstop sits. Far
 *  enough that a deliberate drop off a high loop is not cut short, near enough
 *  that a missed jump is a snappy retry rather than a long fall to nowhere. */
const SKY_FALL_MARGIN = 50;
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
      // Editor default is 0.02 — fine on terrain, lethal on a flat deck.
      // The road casts onto itself, and at a chase-camera grazing angle that
      // self-shadows into repeating stripes / stair-step diagonals (the same
      // acne rts-v3 hit on armour plates). 0.12 is that game's value.
      shadowNormalBias: 0.12,
    },
    // Editor-only terrain shader features. A game has no sculpt brush to move
    // and no paint panel, so both are dead code here — and `cursor` also costs a
    // sampler binding for the brush mask, in a fragment stage that sits at
    // WebGPU's 16-sampler ceiling. Project-dependent features (snow, lakebed,
    // groundProc, autoPaint...) stay ON: the .v3proj decides those.
    terrainFeatures: { cursor: false },
    splatFeatures:   { solo: false },
    /**
     * TWO SHADOW CASCADES, NOT THREE.
     *
     * A BOOT decision and it has to be: changing `cascades` live is broken on
     * three r184 (the old CSMShadowNode's compiled pipeline keeps re-adding its
     * cascade lights every frame while the replacement never compiles), which is
     * why v3's `app.shadows.set()` refuses it. See the opts.csm block in
     * v3/app/main.js. Scoped here rather than in the engine, so the v3 editor and
     * rts-v3 keep their three.
     *
     * WHY IT IS AFFORDABLE. Every shadow caster is drawn once per cascade ON TOP
     * of once for the view, so a cascade is a flat multiplier on the most
     * expensive half of the frame. Instrumented on bench-current.json
     * (onBeforeRender over 120 frames), shadow passes were roughly half the draw
     * calls and a third of the triangles.
     *
     * WHY THE QUALITY HOLDS. `maxFar` is 80 m, so two cascades cover ~40 m each
     * at 2048² — about 50 texels per metre, on a chase camera that never
     * inspects a distant shadow edge. Three cascades was never a quality
     * decision anyway: the config comment in v2/app/config.js says it is a
     * SAMPLER BUDGET ceiling ("3 cascades (not 4): Windows WebGPU caps
     * samplers/stage at 16"), and each cascade spends one. Dropping to two hands
     * a binding back to the scarcest resource in the engine — the same ceiling
     * that made `terrainFeatures.cursor` worth switching off above.
     */
    csm: { cascades: 2 },
  });
  window.__road = app; // handy for console debugging

  const { scene, camera, controls, renderer } = app;

  /* ── SKY MODE (terrain off) ────────────────────────────────────────────────
   *
   * Some races run on the ground; some are a ribbon of track in open sky with no
   * world under them at all. For the second kind the terrain is not a cost to
   * optimise, it is a thing that should not exist — so this turns it off for
   * real: hidden, not solid, and not paid for.
   *
   * It doubles as the measurement baseline. The clipmap is one always-submitted,
   * fragment-bound draw whose cost is fixed no matter how big the track gets, so
   * every frame-time reading the game takes otherwise carries a constant terrain
   * offset that can mask a regression in the game's own systems.
   *
   * WHAT SKY MODE IS NOT: it is not a speed-up for the track or the physics.
   * Terrain is fragment cost; pieces and physics are CPU and geometry cost. This
   * does not make them faster, it stops them being hidden.
   *
   * Nothing is unloaded — the heightmap, its render targets and the compiled
   * terrain pipelines all stay resident, and boot still pays for them. This is a
   * frame-time switch, not a memory or load-time one.
   *
   * TWO SAMPLERS, DELIBERATELY, because "no terrain" has two different right
   * answers and picking the wrong one per call site is how this breaks:
   *
   *   terrainH()    → NaN. For PHYSICS. Both terrain hooks in modularRoadGround
   *                   already treat a non-finite height as "no ground here" (one
   *                   by an isFinite guard, one by a deliberately inverted
   *                   comparison), so NaN removes terrain from collision without
   *                   a single new branch in the vehicle.
   *   groundBaseY() → 0. For AUTHORING. Build anchors and spawns need a real
   *                   number to sit above; NaN there is a NaN track.
   */
  let terrainOn = true;

  /** Terrain height for PHYSICS — NaN in sky mode means "no ground here". */
  function terrainH(x, z) {
    return terrainOn ? app.getWorldHeight(x, z) : NaN;
  }

  /** Terrain height for AUTHORING — sky mode measures from y=0, never NaN. */
  function groundBaseY(x, z) {
    return terrainOn ? app.getWorldHeight(x, z) : 0;
  }

  /* ── WET ROAD + CAR REFLECTION ───────────────────────────────────────────
   *
   * Built here because createRoadMaterial only compiles the projection if it is
   * handed a texture at construction — the same reason `wet` is a constructor
   * flag rather than a uniform (three compiles the clearcoat lobe only when
   * clearcoatNode is set, so a dry track would otherwise pay for a lobe
   * multiplied by zero).
   *
   * `wetAmount` still defaults to 0, so nothing about an existing track changes
   * until something turns the weather up — see setWet() on the returned handle
   * and the dev panel's Wet road slider. It rides ROAD_LOOK, so a track saves
   * its own conditions.
   */
  const carReflection = createCarReflection({
    renderer,
    scene,
    width: Math.max(64, Math.round(innerWidth * 0.5)),
    height: Math.max(64, Math.round(innerHeight * 0.5)),
  });
  /** Runtime switch. The material always carries the projection; this is what
   *  decides whether a mirror is rendered and sampled. */
  let reflectionEnabled = true;

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

  /* ── VOLUMETRIC CLOUDS ─────────────────────────────────────────────────────
   *
   * The game's OWN cloud system, not the v3 editor's deck. This one sits at ~260 m so a
   * sky track can actually reach it, and is built to be flown through; the editor's is a
   * 1900 m ceiling meant to be looked at from the ground. Registering it here makes
   * worldEnvironment render this instead of its own deck — the editor's is untouched and
   * still runs everywhere else.
   *
   * STARTS OFF. Nothing is baked, no buffers are allocated and no shader is compiled until
   * something calls setClouds(true), so a player who never turns them on pays nothing.
   */
  const clouds = createModularRoadClouds({
    renderer, scene, camera,
    params: { enabled: false },
  });
  scene.add(clouds.mesh);
  app.clouds?.setSystem(clouds);

  /** Drive the deck from the engine's live sun/sky so clouds match time of day. */
  const _cloudSun = new THREE.Vector3();
  const _cloudFrame = {
    sunDir: _cloudSun,
    sunColor: 0xfff2dc,
    skyZenith: 0x3f78c8,
    skyHorizon: 0xc9dcef,
    hazeColor: 0xc9dcef,
  };
  function updateClouds(dt) {
    if (!clouds.enabled) return;
    const s = app.sky?.state;
    const li = app.light?.state;
    if (li) {
      // worldEnvironment keeps the sun as azimuth/elevation degrees; rebuild the vector.
      const el = THREE.MathUtils.degToRad(li.sunElevation ?? 40);
      const az = THREE.MathUtils.degToRad(li.sunAzimuth ?? 60);
      _cloudSun.set(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az));
    }
    if (s) {
      _cloudFrame.sunColor = s.sunColor ?? 0xfff2dc;
      _cloudFrame.skyZenith = s.zenithDay ?? 0x3f78c8;
      _cloudFrame.skyHorizon = s.horizonDay ?? 0xc9dcef;
      _cloudFrame.hazeColor = s.horizonDay ?? 0xc9dcef;
    }
    clouds.update(dt, _cloudFrame);
  }
  app.addPreRenderHook?.(updateClouds);

  // 3) ── THE TRACK ──────────────────────────────────────────────────────────
  onStatus("Building track…");
  /**
   * THE ROAD MATERIAL, and it is a `let` because its CLASS is not fixed.
   *
   * three compiles the clearcoat lobe only when `clearcoatNode` is set, so a
   * material built wet pays for that lobe on every deck pixel forever —
   * `wetAmount` at 0 makes it invisible, not free. A dry track therefore gets a
   * plain MeshStandardNodeMaterial, byte-identical to what shipped before any
   * of this existed, and crossing 0 on the weather slider REBUILDS it.
   * `applyRoadMaterial` below is what makes that swap safe.
   *
   * Built dry at boot: a track that wants weather turns it on when its look
   * loads, and the overwhelmingly common case is a dry track that should pay
   * nothing at all.
   *
   * The wet rebuild is handed the scene's shadow-casting DirectionalLight so
   * the coat IBL and emissive reflections can sit in the umbra instead of
   * painting over it. Scene-root on purpose: CSM's cascade placeholders are
   * Object3Ds, not extra DirectionalLights.
   */
  function sceneShadowLight() {
    return scene.children.find((o) => o.isDirectionalLight && o.castShadow) ?? null;
  }
  /**
   * Surface extras the lab A/B's (bump, streak sharpness, paver joints).
   * SURFACE_V2_DEFAULTS is all-zero so the lab's "B at rest is A" stays true;
   * this is the look the game actually ships.
   */
  const surfaceLook = { ...SURFACE_V2_DEFAULTS, ...SURFACE_V2_GAME };

  /**
   * FrontSide vs DoubleSide on the asphalt. The slab is a closed prism, so
   * FrontSide is the cheap correct call; DoubleSide is the old default and
   * the thing to flip back to if an open piece-end looks hollow.
   *
   * Live poke — `side` is not compiled into the TSL graph. Weather rebuilds
   * re-apply it via makeRoadMaterial. Remembered across reloads.
   */
  const ROAD_FRONT_KEY = "modularRoad.roadFrontSide";
  function readRoadFrontSide() {
    try {
      const v = localStorage.getItem(ROAD_FRONT_KEY);
      if (v === "0" || v === "false") return false;
      if (v === "1" || v === "true") return true;
    } catch { /* private mode */ }
    return true;
  }
  let roadFrontSide = readRoadFrontSide();
  function roadSide() {
    return roadFrontSide ? THREE.FrontSide : THREE.DoubleSide;
  }
  function applyRoadSide(mat) {
    if (!mat) return;
    mat.side = roadSide();
    // PCF already flips FrontSide → BackSide in the shadow pass. DoubleSide
    // does not (both faces write) and the deck then self-shadows.
    mat.shadowSide = roadFrontSide ? null : THREE.BackSide;
    mat.needsUpdate = true;
  }
  function setRoadFrontSide(on) {
    roadFrontSide = !!on;
    try { localStorage.setItem(ROAD_FRONT_KEY, roadFrontSide ? "1" : "0"); } catch { /* ignore */ }
    applyRoadSide(roadMaterial);
  }

  /**
   * CHEAP DECK — the A/B switch, for deciding what the full surface is worth.
   *
   * createCheapAsphaltMaterial has existed since asphalt-lab and was never
   * wired in: zone colours, optional paint lines, a wheel-path darken, standard
   * lighting. No procedural noise at all, so no aggregate, no chip octave, no
   * bump normal, no tar snakes, no rubber, no wet. That is the point — it is
   * the floor to measure the real deck against, in the game, on a real track,
   * rather than in a lab that renders a different scene.
   *
   * Remembered across reloads like the FrontSide toggle, because the thing you
   * want to compare is usually a whole session apart.
   */
  const ROAD_CHEAP_KEY = "modularRoad.cheapDeck";
  let cheapRoad = (() => {
    try { return localStorage.getItem(ROAD_CHEAP_KEY) === "1"; } catch { return false; }
  })();

  function makeRoadMaterial(extra = {}) {
    // NO `roadLook` HERE. This runs at boot, from `let roadMaterial =
    // makeRoadMaterial()`, which is ABOVE the `roadLook` declaration — reading
    // it is a temporal-dead-zone throw that bricks the game before the first
    // frame. It only fired once the cheap branch was actually taken (the switch
    // persists in localStorage), so it hid behind the default until someone
    // reloaded with it on.
    //
    // The look is applied AFTER construction by syncRoadUniforms, which every
    // caller already does — and whose per-key guard is what lets the cheap
    // deck take the subset of the look it actually has.
    const mat = cheapRoad
      ? createCheapAsphaltMaterial({ side: roadSide() })
      : createRoadSurfaceV2({ ...surfaceLook, ...extra, side: roadSide() });
    applyRoadSide(mat);
    return mat;
  }

  /** Swap the deck for the cheap one (or back). Full material rebuild. */
  function setCheapRoad(on) {
    const want = !!on;
    if (want === cheapRoad) return;
    cheapRoad = want;
    try { localStorage.setItem(ROAD_CHEAP_KEY, want ? "1" : "0"); } catch { /* private mode */ }
    applyRoadMaterial(makeRoadMaterial({
      wet: !want && (roadLook.wetAmount ?? 0) > 0,
      shadowLight: sceneShadowLight(),
    }));
    // The mirrored-rail pass is only worth running for a deck that can sample
    // it, and the cheap one cannot.
    syncPreMirrored();
  }

  let roadMaterial = makeRoadMaterial();
  const railMaterial = createGuardrailMaterial();
  const shellMaterial = createTunnelMaterial();
  const vaultShellMaterial = createVaultTunnelMaterial();
  const tunnelGlowMaterial = createTunnelGlowMaterial();
  const decorMaterial = createDecorMaterial();
  const startGateBodyMaterial = createStartGateBodyMaterial();
  const startGateGlowMaterial = createStartGateGlowMaterial();
  const finishGateGlowMaterial = createFinishGateGlowMaterial();
  const checkpointGlowMaterial = createCheckpointGlowMaterial();
  // Pre-mirror copies flip local Y (det −1), which reverses winding. Sharing
  // the FrontSide originals would render those copies inside-out; these are
  // the same shaders with both faces on, matching the guardrail's own fix.
  const startGateBodyMaterialMirror = createStartGateBodyMaterial();
  startGateBodyMaterialMirror.side = THREE.DoubleSide;
  const startGateGlowMaterialMirror = createStartGateGlowMaterial();
  startGateGlowMaterialMirror.side = THREE.DoubleSide;
  const finishGateGlowMaterialMirror = createFinishGateGlowMaterial();
  finishGateGlowMaterialMirror.side = THREE.DoubleSide;
  // Cheap dedicated tube shader — tubes used to ride createRoadMaterial, so
  // every pixel of a bore evaluated the asphalt graph. Same look (inner/outer
  // + neon), FrontSide. Weather rebuilds the ROAD material; this one stays.
  const tubeMaterial = createTubeMaterial();
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
  /** Sky-mode kill floor cache — see fallFloorY(). Up here for the SAME reason
   *  as devPanel: bakeCollision() clears it, and the builder's own callbacks
   *  bake during construction, long before the fall-handling code below. */
  let trackBottomY = null;
  /** Exact round colliders (gate posts) — see PropManager.collisionCapsules(). */
  let solidCapsules = [];
  /** Same `let … = null` reason as devPanel: bakeCollision hands these to the
   *  vehicle, and `const vehicle` below would be in TDZ on an early bake. */
  let vehicleRef = null;
  /**
   * Same late-bind as `_propInstancerRef` / `_mergedGroupRef`, and needed for
   * the same reason: the builder fires `onChange` from inside its own
   * constructor, so anything that handler reaches must survive being called
   * before `const builder` — and before the post batches further down — exist.
   * Guarding on this ref is what lets `rebuildRailPosts` bail out cleanly
   * instead of throwing on a temporal dead zone.
   */
  let builderRef = null;

  const builder = new ModularRoadBuilder({
    scene,
    material: roadMaterial,
    railMaterial,
    shellMaterial,
    vaultShellMaterial,
    tunnelGlowMaterial,
    decorMaterial,
    decorGateMaterial: startGateBodyMaterial,
    decorGlowMaterial: startGateGlowMaterial,
    finishGlowMaterial: finishGateGlowMaterial,
    checkpointGlowMaterial,
    glassMaterial,
    tubeMaterial,
    camera,
    domElement: renderer.domElement,
    orbit: controls,
    isBuildMode: () => mode === "build",
    onChange: (info = {}) => {
      // `collision: false` is the builder saying "this notify is mid-drag or
      // cursor-only — the track has not settled". BOTH of the expensive settle
      // jobs hang off it, not just the BVH.
      //
      // The mirror used to be outside this gate, and it is the more expensive
      // half: applyRailReflectionMembers ends in rebuildMirrorRails, which does
      // a full scene.updateMatrixWorld(true) and then clones, world-bakes and
      // merges every piece's mirror rail — 280,330 vertices on rushline
      // (tools/perfAudit.mjs). The placement gizmo's `change` event fires every
      // frame of a drag, so dragging one piece re-merged the whole track sixty
      // times a second.
      //
      // Nothing is lost by waiting. Layer membership only has to be true by the
      // time the frame is drawn, and the drag's own end-of-drag notify (see
      // `_collisionDeferred` in the builder) is what re-runs both.
      if (info.collision !== false) {
        bakeCollision();
        // The builder rebuilds its instanced layer on every change, so the
        // mirror would quietly lose the rails without this.
        applyRailReflectionMembers();
      }
      // OUTSIDE the settle gate, unlike the two above. Posts are VISIBLE, so
      // holding them until pointer-up would leave every one of them standing
      // where the rail used to be for the whole length of a drag. One matrix
      // multiply per post is affordable per frame; a 280k-vertex merge is not.
      rebuildRailPosts();
      paletteUi?.refreshStatus?.();
    },
  });
  builderRef = builder; // see the note on the declaration — TDZ guard for onChange

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
    // Only simulated props could show it (`PHYSICS_PROP_TYPES`: cones, tyres, gates),
    // which is why every other object moved fine. Re-syncing costs nothing here —
    // the gizmo is disabled while driving (`props.setEnabled(!driving)`), so this
    // cannot re-seat a gate mid-swing.
    onChange: () => {
      bakeCollision(); flags?.sync(); propPhysics?.sync(); paletteUi?.refreshStatus?.();
      // Props are a history layer now (see registerHistoryLayer below), so this
      // is also the commit point — same "end of a user-visible edit" contract
      // the road builder's own commits keep. No-ops while an undo is being
      // applied, which is what stops it committing its own restore.
      builder.commitLayerEdit("props");
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
      ensureCollision(); // reads the deck tree — see the note on bakeCollision
      if (mode !== "ground" && deckBvh?.baked) {
        _snapOrigin.set(x, y + 2, z);
        const hit = deckBvh.raycastFirst(_snapOrigin, _snapDown, 400);
        if (hit) return hit.point.y;
      }
      // Road-only and there is no road here: refuse rather than silently
      // dropping the prop to the terrain, which would look like a bug.
      if (mode === "road") return null;
      // Same refusal in sky mode: there is no ground to drop to, and answering
      // 0 would rain props onto an invisible plane far below the track.
      if (!terrainOn) return null;
      return app.getWorldHeight(x, z);
    },
  });
  // Built BEFORE the manager: the manager takes `show` as its selection
  // callback, so a const still in its temporal dead zone would throw the first
  // time anything was picked.
  const moverInspector = createMoverInspector(() => movers, {
    getSnapStep: () => builder.snapStep,
  });
  const movers = new MoverPropManager({
    scene,
    camera,
    domElement: renderer.domElement,
    orbit: controls,
    onChange: () => {
      bakeCollision(); paletteUi?.refreshStatus?.();
      builder.commitLayerEdit("movers");
    },
    onSelect: () => { props.deselect(); portals.deselect?.(); builder.deselectPlacement?.(); },
    onSelectionChange: (inst) => moverInspector.show(inst),
  });
  const portals = new PortalManager({
    scene,
    camera,
    domElement: renderer.domElement,
    orbit: controls,
    params: { ...DEFAULT_PORTAL_PARAMS },
    onChange: () => { paletteUi?.refreshStatus?.(); builder.commitLayerEdit("portals"); },
    onActivate: () => { props.deselect(); movers.deselect(); builder.deselectPlacement?.(); },
  });

  // ── ONE HISTORY FOR THE WHOLE TRACK ────────────────────────────────────────
  // Undo used to be the road builder's alone, so Ctrl+Z after deleting an
  // obstacle undid a ROAD PIECE somewhere else, and "Clear track" left the props
  // hanging in the air. Registering the three object managers as history layers
  // is what makes Ctrl+Z / Ctrl+Y / Clear mean the same thing everywhere.
  //
  // capture/restore are the SAVE FILE's own serializers, deliberately: the
  // format is already the canonical description of each layer, and a second,
  // history-only encoding is how the two would drift apart.
  builder.registerHistoryLayer("props", {
    capture: () => props.exportInstances(),
    restore: (v) => props.importInstances(v),
    clear: () => props.clear(),
    count: () => props.instances.length,
  });
  builder.registerHistoryLayer("movers", {
    capture: () => movers.exportInstances(),
    restore: (v) => movers.importInstances(v),
    clear: () => movers.clear(),
    count: () => movers.instances.length,
  });
  builder.registerHistoryLayer("portals", {
    capture: () => portals.exportLayout(),
    restore: (v) => portals.importLayout(v),
    clear: () => portals.clear(),
    // A pair is two doors, and the count exists to tell the user what Clear is
    // about to delete — so count what they can see and click.
    count: () => portals.pairs.length * 2,
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
    preloadCrane(),
    preloadPalm(),
    preloadBarrel(),
    preloadDecal(DECAL_URL).then(() => settleDecals()),
    // The wind turbine's GLB. Here rather than lazily on first placement so the
    // mover catalog's `make()` can stay synchronous — and so the palette bakes a
    // real thumbnail for it instead of an empty tile it would then CACHE.
    preloadWindmillModel().catch(() => {}),
  ]);

  const thumbItems = [];
  for (const p of PIECE_CATALOG) thumbItems.push({ key: p.id, pieceId: p.id, params: {} });
  for (const presets of Object.values(CATEGORY_PRESETS)) {
    for (const pr of presets) thumbItems.push({ key: pr.id, pieceId: pr.base, params: pr.params });
  }
  for (const p of PROP_CATALOG) thumbItems.push({ key: p.id, make: p.make });
  for (const m of MOVER_CATALOG) thumbItems.push({ key: m.id, make: m.make });
  // Portal door thumbnail — tile lives in Obstacles, still uses PortalManager.
  thumbItems.push({
    key: "portal_door",
    make: () => buildPortalMesh(DEFAULT_PORTAL_PARAMS, DEFAULT_PORTAL_PARAMS.colorA, "a").root,
  });
  // ── THUMBNAILS: CACHED, AND NEVER ON THE CRITICAL PATH ─────────────────────
  // Baking all ~175 tiles is over a second of GPU and canvas work, which used
  // to be spent on every single load for output that changes only when the
  // catalog, the look or the geometry code does. So:
  //   • hit  → read the Blobs back out of IndexedDB (~15 ms) and the palette is
  //            correct on its first paint;
  //   • miss → the palette opens on its SVG fallbacks and the bake runs AFTER
  //            the first frame, swapping tiles in as it finishes. A cold cache
  //            (or a rebake) therefore costs no startup time at all, it just
  //            leaves the tiles hand-drawn for a second or two.
  // `?rebake=1` and the dev panel's Rebake button force the miss path.
  const THUMB_SIZE = 192;
  const forceRebake = new URLSearchParams(location.search).has("rebake");
  // The look is in the signature because these are the REAL road materials —
  // recolour the asphalt and every cached tile is wrong.
  const thumbSig = thumbnailSignature(thumbItems, {
    size: THUMB_SIZE,
    look: readRoadLook(roadMaterial),
  });
  const thumbMaterials = {
    road: roadMaterial, rail: railMaterial, shell: shellMaterial,
    vaultShell: vaultShellMaterial,
    tunnelGlow: createTunnelGlowMaterialForThumb(),
    decor: decorMaterial,
    decorGate: createStartGateBodyMaterialForThumb(),
    decorGlow: createStartGateGlowMaterialForThumb(),
    finishGlow: createFinishGateGlowMaterialForThumb(),
    checkpointGlow: createCheckpointGlowMaterialForThumb(),
    tube: tubeMaterial,
    // NOT the live pane material. Transmission composites against a copy of
    // the backdrop, and a thumbnail is rendered into a bare RT with no
    // backdrop to copy — the pane comes out black, so the tile advertises a
    // hole rather than a window. The cheap Fresnel-alpha build of the same
    // material needs nothing behind it and reads as glass at tile size.
    glass: createRoadGlassMaterial({ transmission: 0, opacity: 0.32 }),
  };

  /** Sprite index over the baked sheet, handed to the palette. Null until a
   *  cache hit or a bake produces one. */
  let roadThumbnails = null;
  if (forceRebake) await clearThumbnailCache();
  else {
    try {
      const cached = await loadThumbnailCache(thumbSig);
      if (cached) roadThumbnails = createThumbnailSprites(cached);
    } catch (e) {
      console.warn("[ModularRoad-v3] thumbnail cache read failed", e);
    }
  }
  const thumbsWereCached = !!roadThumbnails;

  let thumbBakeRunning = false;
  /** Bake every tile and hand the result to the palette + the cache. Safe to
   *  call at any time; the palette adopts the new set in place. */
  async function bakeAndCacheThumbnails() {
    if (thumbBakeRunning) return;
    thumbBakeRunning = true;
    try {
      const baked = await bakeRoadThumbnails({
        renderer,
        materials: thumbMaterials,
        items: thumbItems,
        environment: scene.environment,
        size: THUMB_SIZE,
      });
      if (!baked) return;
      roadThumbnails = createThumbnailSprites(baked, roadThumbnails);
      paletteUi?.setThumbnails?.(roadThumbnails);
      await saveThumbnailCache(thumbSig, baked);
    } catch (e) {
      console.warn("[ModularRoad-v3] thumbnail bake skipped", e);
    } finally {
      thumbBakeRunning = false;
    }
  }
  // Dev-panel button and console escape hatch — the signature can see the
  // catalog and the look, but not edits to buildPiece() or a prop's make().
  async function rebakeThumbnails() {
    await clearThumbnailCache();
    await bakeAndCacheThumbnails();
  }
  window.rebakeRoadThumbnails = rebakeThumbnails;

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
  /** @type {{kind:"prop"|"mover"|"portal"|"spawn", id:string, root:THREE.Object3D, restY:number, restQuat?:THREE.Quaternion, point:THREE.Vector3|null}|null} */
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
   *
   * Flat paint props (boost/launch decals) are near-invisible as ghosts — their
   * real mesh is a few triangles on the deck. If the def has a trigger field,
   * stamp a footprint plane sized to that zone so the brush still reads.
   */
  function buildBrushGhost(def) {
    const root = def.make();
    root.traverse((o) => {
      if (!o.isMesh) return;
      o.material = GHOST_OK;
      o.castShadow = false;
      o.receiveShadow = false;
    });
    const half = def.field?.half;
    if (half) {
      const box = new THREE.Box3().setFromObject(root);
      const h = box.max.y - box.min.y;
      // Only for paint-thin visuals — a real box/ramp already ghosts fine.
      if (h < 0.25) {
        const pad = new THREE.Mesh(
          new THREE.PlaneGeometry(half[0] * 2, half[2] * 2),
          GHOST_OK,
        );
        pad.rotation.x = -Math.PI / 2;
        pad.position.y = 0.05;
        pad.castShadow = false;
        pad.receiveShadow = false;
        root.add(pad);
      }
    }
    root.frustumCulled = false;
    return root;
  }

  /**
   * Car-shaped ghost for the SPAWN tool.
   *
   * Prefers the baked silhouette (one mesh: outer body + rest-pose wheels) so
   * the marker is the car you drive without paying the live GLB's draw list.
   * Falls back to primitives sized from CHASSIS/WHEEL_LOCAL while the model is
   * still loading, so the tool is usable from the first frame.
   *
   * Both variants are built in CAR-LOCAL space — body centred on the origin, hubs
   * at WHEEL_LOCAL — which is the frame `respawn()` places the body in. The
   * caller lifts the whole thing by SPAWN_LIFT, so the ghost sits exactly where
   * the car will, floating gap included: that gap is real and worth seeing.
   */
  function buildSpawnGhost(material = GHOST_OK, name = "SpawnBrushGhost") {
    const root = new THREE.Group();
    root.name = name;

    if (spawnGhostGeo) {
      const car = new THREE.Mesh(spawnGhostGeo, material);
      car.castShadow = false;
      car.receiveShadow = false;
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

    return root;
  }

  /**
   * A PLACEMENT BRUSH OWNS THE POINTER — so every editing gizmo puts its handles
   * down for as long as one is armed.
   *
   * The LMB handler refuses to place while any gizmo reports `isUsingGizmo()`,
   * and those report true on HOVER, not just on drag. TransformControls' pickers
   * are invisible meshes much fatter than the drawn arrows and scale to a
   * constant screen size, so a selected object came with a ~230-300 px
   * plus-shaped hole you could not drop anything into. Worse, placing a prop
   * SELECTS it (PropManager.add), so laying down a run re-armed the trap under
   * the cursor on every single click.
   *
   * Suspending rather than deselecting: the selection, and its highlight box,
   * survive the brush — you get the tool you asked for without losing your place.
   */
  function setGizmosSuspended(on) {
    props.suspendGizmo?.(on);
    movers.suspendGizmo?.(on);
    portals.suspendGizmo?.(on);
    builder.suspendGizmo?.(on);
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
      // The baked silhouette is shared with the spawn marker. Disposing it
      // in clearBrush would delete the marker's body too.
      disposeGeo: !spawnGhostGeo,
    };
    setGizmosSuspended(true);
    devPanel?.refresh();
    return true;
  }

  function clearBrush({ silent = false } = {}) {
    if (!brush) return;
    scene.remove(brush.root);
    if (brush.disposeGeo !== false) {
      // Skip anything a shared template owns. Scenery hands out clones that
      // reference one cached geometry per type (makeSceneryProp), so freeing a
      // floodlight ghost's buffers here also killed every floodlight already on
      // the track — and the next ghost, since it clones the same dead geometry.
      brush.root.traverse((o) => {
        if (o.isMesh && !isSharedGeometry(o.geometry)) o.geometry?.dispose();
      });
    }
    const wasSpawn = brush.kind === "spawn";
    brush = null;
    setGizmosSuspended(false);
    if (!silent) paletteUi?.clearBrushHighlight?.();
    if (wasSpawn) devPanel?.refresh();
  }

  function armBrush(kind, id) {
    clearBrush({ silent: true });
    const def = kind === "portal"
      ? { make: () => buildPortalMesh(DEFAULT_PORTAL_PARAMS, DEFAULT_PORTAL_PARAMS.colorA, "a").root }
      : kind === "prop" ? PROP_BY_ID.get(id) : MOVER_BY_ID.get(id);
    if (!def) return;
    const root = buildBrushGhost(def);
    // make() authors the rest offset on the ROOT (a cone sits a collision radius
    // up so its base is flush), so the ghost has to keep it when it rides a
    // surface — otherwise the preview sits a radius lower than what you place.
    // Same for the rest ROTATION: the open cylinder lies down with rotation.x
    // on the group. Identity-ing the ghost (to drop a leftover stack tilt)
    // stood that pipe up while add() kept the quat and placed it horizontal.
    const restY = root.position.y;
    const restQuat = root.quaternion.clone();
    root.visible = false; // until the mouse says where
    scene.add(root);
    brush = { kind, id, root, restY, restQuat, point: null };
    setGizmosSuspended(true);
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
    ensureCollision(); // reads the deck tree — see the note on bakeCollision
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
    if (hit) {
      const stack = brush.kind === "prop" ? props.stackSnap(brush.id, hit.point, _brushRay) : null;
      if (stack) {
        brush.root.position.copy(stack.position);
        brush.root.quaternion.copy(stack.quaternion);
      } else {
        brush.root.position.set(hit.point.x, hit.point.y + brush.restY, hit.point.z);
        // Rest pose, not identity: identity dropped make()'s rest rotation
        // (the open cylinder's lie-down) while still clearing a leftover
        // stack-snap tilt, which is the job restQuat does now.
        if (brush.kind === "prop" || brush.kind === "portal") brush.root.quaternion.copy(brush.restQuat);
      }
    }
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
      const stack = props.stackSnap(brush.id, brush.point, _brushRay);
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
      // sync() can rebuild the batches, which drops their layer membership.
      applyRailReflectionMembers();
      flags.sync();
    } else if (brush.kind === "portal") {
      portals.addDoor(brush.point);
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
    onAddPortal: () => armBrush("portal", "portal_door"),
    onPickPiece: () => clearBrush({ silent: true }),
    onEdgesChange: () => bakeCollision(),
    // onLoadDemo / onLoadCircuit are gone with their buttons — see the note in
    // modularRoadBuilder.js. builder.loadDemo() and loadBigCircuit() still
    // exist and are still used by three tests; only the UI seats them.
  });

  // 4) ── THE CAR ────────────────────────────────────────────────────────────
  const vehicle = new Vehicle({ scene, showArrows: false });
  // Chassis-corner safety floor follows the terrain instead of pinning to y=0.
  // terrainH, not getWorldHeight: in sky mode this must return NaN so
  // _applyChassisGroundContact skips the corner. Its `!(y < floorY)` test is
  // written that way on purpose — a NaN floor is no floor, not a floor at zero.
  vehicle.getFloorY = (x, z) => terrainH(x, z);
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
      applyCarReflectionMembers();
      devPanel?.refresh();
    })
    .catch((e) => {
      console.warn("[ModularRoad-v3] wheel model failed to load — staying procedural", e);
    });


  /* ── THE MIRROR ──────────────────────────────────────────────────────────── */

  /**
   * What the reflection pass is allowed to draw.
   *
   * Meshes ENABLE the layer rather than moving to it, so the car keeps rendering
   * normally in the main view with no clone and nothing to keep in sync. The
   * ROAD is never a member: it would reflect itself, and it is the largest thing
   * on screen.
   *
   * Re-applied after each background model load, because setChassisModel and
   * setWheelStyle replace the meshes this walked.
   */
  const REFLECT_DROP = ["misc", "badges", "rotor", "caliper"];
  function applyCarReflectionMembers() {
    if (!vehicleRef?.group) return;
    vehicleRef.group.traverse((o) => {
      if (o.isLight) { lightReflection(o); return; }
      if (!o.isMesh) return;
      // The interior, the badges and the brake internals are 40% of the body's
      // triangles and none of it survives a roughness-0.16 reflection — measured
      // in wet-road-lab, where dropping them cost nothing visible.
      const name = (o.name || "").toLowerCase();
      if (REFLECT_DROP.some((k) => name.includes(k))) o.layers.disable(REFLECT_LAYER);
      else o.layers.enable(REFLECT_LAYER);
    });
  }

  /** Scene lights have to see the reflect layer or the mirrored car is a
   *  silhouette — three tests light.layers against the object's. */
  function lightReflectionAll() {
    scene.traverse((o) => { if (o.isLight) lightReflection(o); });
  }

  /**
   * GUARDRAILS IN THE MIRROR, and they matter more than the car does.
   *
   * The car's own reflection lands directly UNDERNEATH the car, where the car
   * hides it — and at the chase camera's 3.8 m the little that escapes is
   * compressed into a sliver at the tyres and falls off the bottom of the
   * frame. wet-road-lab flatters it by sitting at 1.55 m, where the same
   * reflection stretches back toward the viewer across open deck.
   *
   * The rail does not have that problem: it runs alongside the car, so it
   * mirrors onto the middle of the road, which is the part of the screen the
   * player is looking at. Measured in the lab it was also the cheapest thing in
   * the pass by a distance — one merged sweep, +1 draw.
   *
   * Membership goes on whatever actually renders. The builder swaps between
   * per-piece proxies and one InstancedMesh per (role, geometry) depending on
   * `instancingEnabled`, so this keys off MATERIAL IDENTITY rather than trying
   * to track which of the two is live.
   */
  /**
   * Guardrails in the reflection — OFF by default, and NOT through the planar
   * mirror when it is on.
   *
   * OFF is a taste call, not a technical one: the car, the lamps and the rest
   * of the scenery reflect regardless, and they are the reflections that read
   * as wet tarmac. The rail is a long, bright, continuous object running the
   * whole length of the road, so its reflection is a stripe down both edges of
   * every wet frame — correct, but a lot. The dev panel's "Rails in mirror"
   * turns it on, and off costs nothing at all: no pass, no geometry, and the
   * sample is not even compiled into the road shader (syncRoadMaterialFeatures).
   *
   * The rail is the one object a single mirror plane can never get right. It
   * runs the whole length of the road, so on any piece that bends it is metres
   * off the plane and its flipped image runs the wrong way: measured on Apex
   * Parkour's dip, rails 20-40 m out sit up to 12 m off-plane, and the
   * reflection descends while the rail climbs. Clipping, fading and an analytic
   * band were all tried against that and all failed, the first three because
   * they measured the RECEIVING fragment when the error was in the mirror's
   * CONTENT, the last because a flat colour band reads as paint.
   *
   * So the rail is not put in the mirror at all. A mirrored COPY of it is built
   * (buildMirroredRailGeometry — each vertex flipped about the deck at its own
   * station) and drawn with the ordinary camera into the same target, which is
   * what a reflection is before anyone thought of mirroring cameras. No plane,
   * so nothing to be off it by.
   *
   * Tall props (neon arm / neon gate) and the start/finish/checkpoint gantries
   * are the same failure in miniature: they stand ~8 m off the deck, so the
   * 3 m slab clips them, and a fraction of a degree of per-frame plane tilt
   * swims their image. They go through the same pre-mirror path — see
   * rebuildMirrorProps. Do not put them on REFLECT_LAYER.
   */
  let railsInMirror = false;
  /** The whole track's mirrored rail, merged, on PREMIRROR_LAYER. One mesh —
   *  it is only ever drawn by the reflection pass, which does not cull. */
  const mirrorRailGroup = new THREE.Group();
  mirrorRailGroup.name = "MirroredRails";
  mirrorRailGroup.layers.set(PREMIRROR_LAYER);
  mirrorRailGroup.matrixAutoUpdate = false;
  scene.add(mirrorRailGroup);

  // ── GUARDRAIL POSTS ────────────────────────────────────────────────────────
  //
  // One InstancedMesh per post SHAPE, holding every post on the track.
  //
  // A post is a single ~324-vertex object repeated about 600 times, and it used
  // to be baked into each piece's merged rail geometry. That is what made the
  // guardrail 89% of the track's vertices — measured on rushline
  // (tools/perfAudit.mjs): 280,330 rail vertices against a 35,600-vertex deck,
  // and `posts: false` on a single 32 m straight takes its rail from 6,148
  // vertices to 308.
  //
  // BE CLEAR ABOUT WHAT THIS BUYS, because it is not what "195k fewer vertices"
  // sounds like. The same posts still rasterise and still run the vertex shader
  // once per instance vertex — instancing removes the DUPLICATION, not the
  // drawing. What it actually saves is memory (one template instead of ~600
  // baked copies), the mergeGeometries pass over those copies on every remesh,
  // and the size of the drive-mode merged track. tools/railBudget.mjs made the
  // same point before any of this was written; it is worth re-reading before
  // anyone expects a frame-rate number from it.
  //
  // In the SCENE, not under builder.root: drive mode hides that root and draws
  // the merged track instead, and the posts have to survive both modes.
  const postGroup = new THREE.Group();
  postGroup.name = "GuardrailPosts";
  scene.add(postGroup);
  /** key -> InstancedMesh, reused across rebuilds like the builder's batches. */
  const postBatches = new Map();
  /** Scratch, so a rebuild allocates nothing per post. */
  const _postWorld = new THREE.Matrix4();
  /** Spare instance slots, so placing one more piece rewrites rather than
   *  reallocates — same reasoning as INSTANCE_SLACK in the builder. */
  const POST_SLACK = 64;
  /**
   * Edge of the world cell posts are batched into, in metres.
   *
   * The knob trades draw calls against culling granularity, the same trade
   * MERGE_CHUNK_EXTENT makes for the track, and it wants to be the same order of
   * magnitude: small enough that looking down a straight culls most of the
   * track's posts, large enough that a lap is not a hundred batches.
   */

  /**
   * Re-pose every guardrail post from the current pieces.
   *
   * Cheap enough to run on EVERY builder notify, mid-drag included, and it has
   * to be: the posts are visible, so deferring them to pointer-up the way the
   * BVH and the mirror are deferred would leave them standing where the rail
   * used to be for the whole length of a drag. It is one matrix multiply per
   * post — ~600 of them — against a 16 ms frame.
   */
  function rebuildRailPosts() {
    // MUST be the first statement: the builder's constructor fires onChange, so
    // this runs once before `builder` — and before `postBatches` below it — has
    // been initialised. Touching either would be a TDZ throw. The rebuild that
    // follows construction covers the pieces this call skips.
    if (!builderRef) return;
    // Group by post SHAPE. Two pieces share a draw only if they share a template
    // key; a platform is wider than the road and can seat its post differently,
    // so this is not always one group (see postTemplate).
    //
    // NOT ALSO BY REGION, and that is a measured decision rather than an
    // omission. Instrumenting real frames (onBeforeRender over 120 frames of
    // driving rushline) found this batch was 359k triangles a frame — 44% of
    // everything drawn, more than the merged track and the whole terrain
    // clipmap combined. Splitting it into world cells so it could frustum-cull
    // was the obvious fix and it does not work: sweeping the cell size showed
    // the triangles barely move, because a chase camera looking down a track
    // sees nearly all of it.
    //
    //   cell size   batches   draws/frame   KTris/frame
    //     one           4          4            89.8
    //     240           7          6            78.1
    //     120          13         12            78.1
    //      80          19         18            78.1
    //
    // Only ~13% ever culls, so the split buys ~12k triangles for 11 extra draws
    // — the wrong direction on a frame that is CPU-bound at 99% main-thread
    // utilisation. The whole win was `castShadow` below. Left as one batch.
    const wanted = new Map(); // key -> { template, mats: Matrix4[] }
    for (const p of builderRef.pieces) {
      const rm = p.railMesh;
      const rp = rm?.userData?.railPosts;
      if (!rp?.template || !rp.matrices?.length) continue;
      // Hidden pieces (gap spacers) draw no rail, so they get no posts either.
      if (rm.userData.noRender) continue;
      let g = wanted.get(rp.key);
      if (!g) { g = { template: rp.template, mats: [] }; wanted.set(rp.key, g); }
      // Post poses are PIECE-LOCAL; the piece's own matrix puts them in the world.
      for (const m of rp.matrices) g.mats.push(_postWorld.multiplyMatrices(rm.matrix, m).clone());
    }

    for (const [key, g] of wanted) {
      const n = g.mats.length;
      let im = postBatches.get(key);
      if (!im || im.geometry !== g.template || (im.instanceMatrix?.count ?? 0) < n) {
        if (im) { postGroup.remove(im); im.dispose(); }
        im = new THREE.InstancedMesh(g.template, railMaterial, n + POST_SLACK);
        // NO SHADOWS, and this is the other half of the 359k. A caster is drawn
        // once per cascade as well as once for the view, so with three cascades
        // the posts were paying 4× — and what they buy is the shadow of a 0.15 m
        // post standing on a kerb, under a rail beam that already casts one.
        // Measured share of the frame's triangles: 44% with this on, 11% with it
        // off — 359k a frame down to 90k, and it is the entire win here.
        // Flip it back if the look turns out to want them.
        im.castShadow = false;
        im.receiveShadow = true;
        // One batch spans the track, so a bounding sphere round it is in frustum
        // essentially always — the cull would cost a sphere recomputed over 863
        // instances on every rebuild (which is every frame of a gizmo drag) to
        // answer "yes". See the sweep above.
        im.frustumCulled = false;
        postGroup.add(im);
        postBatches.set(key, im);
      }
      for (let i = 0; i < n; i++) im.setMatrixAt(i, g.mats[i]);
      im.count = n;
      im.instanceMatrix.needsUpdate = true;
    }
    for (const [key, im] of postBatches) {
      if (wanted.has(key)) continue;
      postGroup.remove(im);
      im.dispose();
      postBatches.delete(key);
    }
  }

  function disposeMirrorRails() {
    for (const m of mirrorRailGroup.children) {
      if (m.isInstancedMesh) {
        // POSTS. Their geometry is the SHARED template from
        // modularRoadRail.js's cache — the same object the VISIBLE posts are
        // drawing with. Freeing it here would pull the buffer out from under
        // them, and the failure would not show until the next draw handed
        // WebGPU a null buffer. `InstancedMesh.dispose()` releases the instance
        // buffer and leaves the geometry alone, which is exactly right.
        m.dispose();
        continue;
      }
      m.geometry?.dispose(); // the merged beam — built for this pass, ours to free
    }
    mirrorRailGroup.clear();
  }

  /**
   * Rebuild the mirrored rail, building the geometry for it as we go.
   *
   * Asks the builder for a mirrored rail per piece, bakes each into world space,
   * merges the lot into one mesh, and FREES THE PARTS. Merged for the same
   * reason buildMergedTrack merges: the reflection pass would otherwise redraw
   * every piece of the track separately.
   *
   * NOTHING IS RETAINED between passes. The per-piece mirrored rails used to be
   * built by every `buildPiece` call and kept on the pieces for the life of the
   * track — 280,330 vertices, ~8.5 MB — even though this function's own output
   * is the only thing ever drawn from them.
   *
   * DRIVE MODE ONLY, which is new and is where most of the saving comes from.
   * `updateCarReflection` runs the pre-mirror pass under `mode === "drive"` and
   * pins the road's rail-mirror uniform to 0 otherwise, so a mirrored rail built
   * while editing could never be sampled. Building it anyway meant every piece
   * you placed on a wet track paid a full-track re-merge — measured at 240 ms —
   * for something invisible.
   */
  /**
   * Whether the mirrored rail was BUILT last time we looked.
   *
   * The geometry depends on the track and on nothing else — `wetAmount` decides
   * only whether it is drawn at all, not what it looks like. So a weather slider
   * needs a rebuild exactly twice across its whole range, at the two ends. See
   * `syncMirrorRails`.
   */
  let mirrorRailsBuilt = false;

  /**
   * Is a mirrored rail worth having right now?
   *
   * One predicate, so `rebuildMirrorRails` and `syncMirrorRails` cannot drift —
   * the whole point of `mirrorRailsBuilt` is that the two agree about what the
   * answer was last time.
   *
   * `mode === "drive"` is the load-bearing term. See the note on
   * rebuildMirrorRails: the pre-mirror pass does not run in build mode, so
   * geometry built there is never sampled.
   */
  function mirrorRailsWanted(wet) {
    return mode === "drive" && railsInMirror && reflectionEnabled && wet > 0;
  }

  function rebuildMirrorRails() {
    disposeMirrorRails();
    // Dry road, reflections off, or rails off: nothing to draw and, more to the
    // point, no pass to pay for — `preMirrorActive` false skips it entirely.
    // Read the wetness off the MATERIAL, not off `roadLook`: this runs from the
    // builder's onChange during construction, and `roadLook` is not declared
    // until much further down — naming it here is a temporal-dead-zone throw,
    // the same trap `_mergedGroupRef` exists to dodge.
    const wet = roadMaterial?._roadUniforms?.wetAmount?.value ?? 0;
    const on = mirrorRailsWanted(wet);
    mirrorRailsBuilt = false;
    if (!on || !builder?.pieces?.length) {
      syncPreMirrorActive();
      return;
    }
    scene.updateMatrixWorld(true);
    // Built to order, and OURS — so the transform goes in place. The old path
    // cloned first because the geometry belonged to the piece and had to survive.
    const geos = [];
    /** key -> { template, mats } — the mirrored POSTS, instanced like the real
     *  ones rather than merged into the beam. See the note below. */
    const postGroups = new Map();
    for (const { geometry, matrix, posts } of builder.buildMirrorRails()) {
      geometry.applyMatrix4(matrix);
      geos.push(geometry);
      if (!posts?.template || !posts.matrices.length) continue;
      let grp = postGroups.get(posts.key);
      if (!grp) { grp = { template: posts.template, mats: [] }; postGroups.set(posts.key, grp); }
      // Piece-local → world, same as the visible posts.
      for (const m of posts.matrices) grp.mats.push(_postWorld.multiplyMatrices(matrix, m).clone());
    }
    if (!geos.length) {
      syncPreMirrorActive();
      return;
    }
    const merged = mergeGeometries(geos, false);
    for (const g of geos) g.dispose();
    if (!merged) {
      syncPreMirrorActive();
      return;
    }
    merged.computeBoundingSphere();
    const mesh = new THREE.Mesh(merged, railMaterial);
    // No shadows either way: this mesh exists below the road, is never lit by
    // the main pass, and casting from it would put rail shadows underground.
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    mesh.layers.set(PREMIRROR_LAYER);
    mirrorRailGroup.add(mesh);

    // ── MIRRORED POSTS ───────────────────────────────────────────────────────
    //
    // Same move as the visible rail's, and the same reason: a post is one shape
    // repeated hundreds of times, and merging every copy into the beam is what
    // made this the largest geometry in the game. It shares the visible rail's
    // TEMPLATE — `postTemplate` keys on the rail and road params, and mirroring
    // changes neither — but needs its own mesh, because this one lives on the
    // pre-mirror layer and the other does not.
    //
    // These instance matrices have a NEGATIVE DETERMINANT: they come from frames
    // with `up` negated, which is a reflection. That is fine here and is not a
    // new compromise — the merged path baked exactly the same reflection into
    // the vertices. The guardrail material is DoubleSide so the flipped winding
    // costs nothing, and the flipped normals are the error
    // buildMirroredRailGeometry already documents and accepts.
    for (const [, grp] of postGroups) {
      const im = new THREE.InstancedMesh(grp.template, railMaterial, grp.mats.length);
      for (let i = 0; i < grp.mats.length; i++) im.setMatrixAt(i, grp.mats[i]);
      im.instanceMatrix.needsUpdate = true;
      im.castShadow = false;
      im.receiveShadow = false;
      im.frustumCulled = false;
      im.layers.set(PREMIRROR_LAYER);
      mirrorRailGroup.add(im);
    }

    mirrorRailsBuilt = true;
    syncPreMirrorActive();
  }

  /**
   * The mirrored rail, for callers that changed WHETHER it is shown rather than
   * WHAT it is.
   *
   * `rebuildMirrorRails` clones, world-bakes and merges every piece's mirror
   * geometry — 280,330 vertices on rushline (tools/perfAudit.mjs) — and it was
   * wired straight to `setRoadWet`, which the weather slider calls on every
   * `input` event. Dragging that slider re-merged the whole track per pointer
   * move, for a result that is identical at every value: the geometry does not
   * depend on wetness, only its visibility does.
   *
   * So this rebuilds only when the on/off answer actually flips. Anything that
   * changes the TRACK still calls `rebuildMirrorRails` directly — this is not a
   * general-purpose "refresh if needed", it cannot see geometry changes.
   */
  function syncMirrorRails() {
    const wet = roadMaterial?._roadUniforms?.wetAmount?.value ?? 0;
    const want = mirrorRailsWanted(wet) && !!builder?.pieces?.length;
    if (want === mirrorRailsBuilt) return;
    rebuildMirrorRails();
  }

  /**
   * TALL STATIC PROPS IN THE PRE-MIRROR, same path as the rail.
   *
   * A planar mirror is only true ON its plane. The neon arm stands ~8 m off
   * the deck, so three things fail at once if it is put on REFLECT_LAYER:
   * the 3 m slab clips the top bar (and the clip crawls as the tyre-contact
   * plane is refit); a fraction of a degree of plane tilt displaces the
   * image of something 30 m away by tens of centimetres; and 0.14 m of neon
   * in a half-res target shimmers. Close up, dist → 0 and the plane is
   * locally correct — which is why it looked stable only next to the arm.
   *
   * The fix is the rail's: build a copy flipped about the LOCAL deck at the
   * prop's own anchor (position stays, up negated) and draw it with the real
   * camera on PREMIRROR_LAYER. No plane, no slab, no per-frame jitter. Props
   * are static in drive mode, so this is once per edit, not per frame.
   *
   * The Y-flip has determinant −1, so winding reverses. The copy is built
   * DoubleSide (and the piece-gantry copies use the *Mirror materials above)
   * rather than sharing the FrontSide original.
   */
  const PREMIRROR_PROP_IDS = new Set(["neonarm", "neongate"]);
  /** Stroke width vs the real neon. A wet-asphalt reflection is a blur, so
   *  a fatter stroke in the half-res target reads more like wet neon than a
   *  one-texel sparkle. */
  const MIRROR_NEON_SCALE = 2.5;
  /**
   * Depth-gate metres when a tall pre-mirrored prop is in the pass.
   *
   * The rail's 4 m gate is right for a 0.8 m rail: a correct image sits a
   * metre or two from the fragment, a see-through over a crest is tens of
   * metres. An 8 m arm's virtual top is 8 m below the deck, and at a chase
   * camera's grazing angle the along-ray gap to that image is ~25–35 m at
   * driving distance. 4 m would reject the top bar (the part you want) and
   * leave only the feet. 36 m lets the arm through from typical approach
   * distances. When rails are also on this is looser than their crest test;
   * rails default off, and a neon arm is discrete so the leftover see-through
   * is a rare alignment rather than a stripe down every hill.
   */
  const PROP_MIRROR_DEPTH_TOL = 36;
  const _mirrorFlipY = new THREE.Matrix4().makeScale(1, -1, 1);
  const mirrorPropGroup = new THREE.Group();
  mirrorPropGroup.name = "MirroredProps";
  mirrorPropGroup.layers.set(PREMIRROR_LAYER);
  mirrorPropGroup.matrixAutoUpdate = false;
  scene.add(mirrorPropGroup);
  let mirrorPropsBuilt = false;
  /** Late-bound: builder onChange can fire during construction, before `props`. */
  let _propsRef = null;
  /** Same TDZ trap as `roadLook` itself — see rebuildMirrorRails. */
  let _roadLookRef = null;

  function hasPremirrorSources() {
    if (_propsRef?.instances?.some((i) => PREMIRROR_PROP_IDS.has(i.id))) return true;
    for (const p of builderRef?.pieces ?? []) {
      if (p.decorGateMesh) return true;
      const glow = p.decorGlowMesh;
      if (glow && glow.userData.glowKind !== "tunnel") return true;
    }
    return false;
  }

  function mirrorPropsWanted(wet) {
    return mode === "drive" && reflectionEnabled && wet > 0 && hasPremirrorSources();
  }

  function syncPreMirrorActive() {
    carReflection.preMirrorActive = mirrorRailsBuilt || mirrorPropsBuilt;
  }

  function syncPreMirrorDepthTol() {
    const u = roadMaterial?._roadUniforms?.railDepthTol;
    if (!u) return;
    const base = _roadLookRef?.railDepthTol ?? 4;
    u.value = mirrorPropsBuilt ? Math.max(base, PROP_MIRROR_DEPTH_TOL) : base;
  }

  function disposeMirrorProps() {
    for (const root of [...mirrorPropGroup.children]) {
      root.traverse((m) => {
        if (!m.isMesh) return;
        if (m.userData.mirrorOwnsGeometry) m.geometry?.dispose();
        if (m.userData.mirrorOwnsMaterial) {
          const mats = Array.isArray(m.material) ? m.material : [m.material];
          for (const mat of mats) mat?.dispose?.();
        }
      });
    }
    mirrorPropGroup.clear();
  }

  function stampMirroredMesh(src, material) {
    src.updateMatrixWorld(true);
    const mesh = new THREE.Mesh(src.geometry, material);
    mesh.matrix.copy(src.matrixWorld).multiply(_mirrorFlipY);
    mesh.matrixAutoUpdate = false;
    mesh.matrixWorldNeedsUpdate = true;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    mesh.layers.set(PREMIRROR_LAYER);
    mirrorPropGroup.add(mesh);
  }

  function addMirroredProp(inst) {
    const make = inst.def?.make;
    if (typeof make !== "function") return;
    inst.root.updateMatrixWorld(true);
    const root = make({ neonScale: MIRROR_NEON_SCALE, side: THREE.DoubleSide });
    root.matrixAutoUpdate = false;
    root.matrix.copy(inst.root.matrixWorld).multiply(_mirrorFlipY);
    root.matrixWorldNeedsUpdate = true;
    root.traverse((o) => {
      o.layers.set(PREMIRROR_LAYER);
      if (!o.isMesh) return;
      o.castShadow = false;
      o.receiveShadow = false;
      o.frustumCulled = false;
      o.userData.mirrorOwnsGeometry = true;
      o.userData.mirrorOwnsMaterial = true;
    });
    mirrorPropGroup.add(root);
  }

  function rebuildMirrorProps() {
    disposeMirrorProps();
    const wet = roadMaterial?._roadUniforms?.wetAmount?.value ?? 0;
    const on = mirrorPropsWanted(wet);
    mirrorPropsBuilt = false;
    if (!on) {
      syncPreMirrorActive();
      syncPreMirrorDepthTol();
      return;
    }
    scene.updateMatrixWorld(true);
    for (const inst of _propsRef?.instances ?? []) {
      if (PREMIRROR_PROP_IDS.has(inst.id)) addMirroredProp(inst);
    }
    for (const p of builderRef?.pieces ?? []) {
      if (p.decorGateMesh) stampMirroredMesh(p.decorGateMesh, startGateBodyMaterialMirror);
      const glow = p.decorGlowMesh;
      if (!glow || glow.userData.glowKind === "tunnel") continue;
      const glowMat = glow.userData.glowKind === "finish" ? finishGateGlowMaterialMirror
        : glow.userData.glowKind === "checkpoint" ? checkpointGlowMaterial
          : startGateGlowMaterialMirror;
      stampMirroredMesh(glow, glowMat);
    }
    mirrorPropsBuilt = mirrorPropGroup.children.length > 0;
    syncPreMirrorActive();
    syncPreMirrorDepthTol();
  }

  function syncMirrorProps() {
    const wet = roadMaterial?._roadUniforms?.wetAmount?.value ?? 0;
    const want = mirrorPropsWanted(wet);
    if (want === mirrorPropsBuilt) return;
    rebuildMirrorProps();
  }

  /** Rails + tall props share the pre-mirror pass; one call so a weather
   *  slider, a reflection toggle and a build→drive switch cannot rebuild one
   *  and leave the other stale. */
  function syncPreMirrored() {
    syncMirrorRails();
    syncMirrorProps();
  }

  /** Roadside scenery (lamps, boards) in the mirror — see the note below. */
  let sceneryInMirror = true;
  /** Late-bound for the same reason as `_mergedGroupRef`: the builder's
   *  onChange calls the membership pass during construction, before the
   *  instancer exists, and naming a later `const` there is a TDZ throw. */
  let _propInstancerRef = null;
  /** Set once buildMergedTrack's group exists — see the note in `apply`. */
  let _mergedGroupRef = null;
  function applyRailReflectionMembers() {
    // Nothing of the TRACK goes in the planar mirror any more. The rail's
    // reflection comes from mirrored geometry instead (rebuildMirrorRails), so
    // this pass only has to make sure no stale membership survives a reload.
    const apply = (root) => {
      root?.traverse((o) => {
        if (!o.isMesh && !o.isInstancedMesh) return;
        o.layers.disable(REFLECT_LAYER);
      });
    };
    apply(builder?.instGroup);
    apply(builder?.root);

    // SCENERY IN THE MIRROR — lamps, boards, floodlights. Their emissive heads
    // are the brightest small things beside a night track, and a bright small
    // thing smeared down wet tarmac is most of what sells it.
    //
    // Cheap for the same reason the props themselves are: the instancer has
    // already collapsed every copy of a type into one InstancedMesh, so a
    // straight lined with a dozen lamps adds a couple of draws to the mirror
    // pass, not a dozen. That also fixes the granularity — membership is
    // per-BATCH, so individual lamps cannot be distance-culled out of the
    // mirror. Given the cost, they do not need to be.
    //
    // Scenery only. Cones, tyre walls and containers are dull, low and legion;
    // they would add triangles to the mirror for nothing.
    _propInstancerRef?.group?.traverse((o) => {
      if (!o.isMesh && !o.isInstancedMesh) return;
      const isScenery = SCENERY_MAP.has(o.userData.propId);
      if (isScenery && sceneryInMirror) o.layers.enable(REFLECT_LAYER);
      else o.layers.disable(REFLECT_LAYER);
    });
    // Drive mode's merged track — see buildMergedTrack. Tagging only the
    // editable proxies tags the copies that are hidden the moment you drive.
    //
    // Late-bound on purpose: this function is hoisted and the builder's
    // onChange calls it during construction, before `mergedGroup` exists.
    // Naming the const directly there is a temporal-dead-zone throw.
    apply(_mergedGroupRef);

    rebuildMirrorRails();
    rebuildMirrorProps();
  }

  const _mirrorPoint = new THREE.Vector3();
  const _mirrorNormal = new THREE.Vector3();

  /**
   * Drive the mirror, once per frame, BEFORE the scene is drawn.
   *
   * The plane is the average of the GROUNDED tyre contacts — their hitPoint and
   * hitNormal — not the chassis transform. The body rolls and pitches on its
   * suspension; the reflection has to follow the ROAD or it swims under braking.
   * It is also what makes this work on a stunt track: a banked hold and the
   * inside of a loop both have a perfectly good local plane, it just is not
   * horizontal.
   *
   * Airborne (no contacts) the plane is undefined, so the reflection fades out —
   * which is also when nobody is looking at the road surface anyway.
   */
  /**
   * Swap in a differently-built road material and re-point everything at it.
   *
   * Every holder has to move together or the track renders in two materials at
   * once: the builder's per-piece meshes, the merged drive-mode track (its
   * MERGE_ROLES entry reads `roadMaterial` through a getter, so it only needs a
   * rebuild), and the authored look, which lives in uniforms the new material
   * does not have yet.
   */
  function applyRoadMaterial(next) {
    if (!next || next === roadMaterial) return;
    const prev = roadMaterial;
    roadMaterial = next;
    syncRoadUniforms(roadMaterial, roadLook);
    syncSurfaceV2Uniforms(roadMaterial, surfaceLook);
    syncTubeUniforms(tubeMaterial, roadLook);
    syncPreMirrorDepthTol();
    builder.setRoadMaterial(roadMaterial);
    if (mergedGroup.visible) { disposeMergedTrack(); buildMergedTrack(); }
    // Only after nothing references it any more.
    prev?.dispose?.();
  }

  /**
   * Rebuild the road material if the FEATURES it was compiled with no longer
   * match what is switched on.
   *
   * Two things change the shader rather than a uniform. Wetness crossing 0
   * swaps Standard for Physical (the clearcoat lobe only compiles if there is a
   * clearcoatNode). The pre-mirror sample (rails and/or tall props) is compiled
   * in only when something is actually on that layer — and that is the
   * difference between a term multiplied by zero and a term that is not there.
   *
   * Multiplying by zero is what the runtime gate does, and it is right for the
   * cases that change per FRAME (build mode, no contact patch): the fragment
   * still pays for the texture fetch, which is the price of being able to come
   * back next frame. A toggle is not per frame, so it can afford a rebuild and
   * buy a genuinely free "off" — no sample, no node, nothing left in the
   * compiled shader to cost anything.
   *
   * The rebuild is the same one wetness already does, hitch included (it
   * re-merges the drive-mode track), which is why this only ever runs from a
   * toggle and never from the render loop.
   */
  function syncRoadMaterialFeatures() {
    // The cheap deck has no wet lobe, no pre-mirror sample and no V2 surface,
    // so every feature comparison below would mismatch forever and rebuild the
    // material — and re-merge the whole track — on every call.
    if (cheapRoad) return;
    const wantWet = (roadLook.wetAmount ?? 0) > 0;
    const wantPreMirror = wantWet && (railsInMirror || hasPremirrorSources());
    // ASK THE MATERIAL WHAT IT IS, do not infer it from its class. Physical used
    // to mean wet; now anisotropy picks that class too (three declares
    // anisotropyNode on Physical only), so the old
    // `isMeshPhysicalNodeMaterial` sniff would call a dry anisotropic road wet,
    // never agree with the intent, and rebuild — re-merging the whole track —
    // on every single call.
    const isWet = roadMaterial._roadWet === true;
    const hasPreMirror = !!roadMaterial._mirrorTextureNode;
    const v2Rebuild = surfaceV2NeedsRebuild(roadMaterial, surfaceLook);
    // Anisotropy is the third build-time feature, for the same reason as the
    // other two: three swaps in the anisotropic BRDF the moment the node exists,
    // so "off" has to mean absent, not zero.
    const wantAniso = (roadLook.anisotropy ?? 0) > 0;
    const hasAniso = roadMaterial._roadAniso === true;
    if (wantWet === isWet && wantPreMirror === hasPreMirror && !v2Rebuild
      && wantAniso === hasAniso) return;
    applyRoadMaterial(makeRoadMaterial({
      ...roadLook,
      wet: wantWet,
      shadowLight: sceneShadowLight(),
      reflectionTexture: wantWet ? carReflection.texture : null,
      mirrorTexture: wantPreMirror ? carReflection.mirrorTexture : null,
      // Feeds the pre-mirror occlusion gate — without it the mirrored rail of a
      // section hidden behind a crest draws through the crest. Tall props share
      // the same sample; rebuildMirrorProps loosens the metre gate for them.
      mirrorDepthTexture: wantPreMirror ? carReflection.mirrorDepthTexture : null,
    }));
  }

  /**
   * Master weather. Crossing 0 changes which material the road is built from —
   * see syncRoadMaterialFeatures — so this is a rebuild at one end of its range
   * and a uniform poke everywhere else.
   */
  function setRoadWet(v) {
    const wet = Math.max(0, Math.min(1, v || 0));
    roadLook.wetAmount = wet;
    syncRoadMaterialFeatures();
    // Optional: the cheap deck's uniform bag is a subset and has no weather.
    const wetU = roadMaterial._roadUniforms?.wetAmount;
    if (wetU) wetU.value = wet;
    // A tyre SQUEEGEES standing water, so a wet skid is a light clearing rather
    // than a dark rubber ribbon — see MARK_LOOK in modularRoadTireMarks. The
    // marks are their own mesh and material, so they have to be told.
    tireMarks.setWetness(wet);
    // ...and it throws the water it displaces. On a wet road the drift puffs
    // become spray: white, thin, short-lived, and emitted by SPEED rather than
    // by slip. See DEFAULT_WET_SPRAY_SETTINGS for why that is a swap and not a
    // second particle system.
    driftSmoke.setWetness(wet);
    // Crossing 0 in either direction changes whether the pre-mirror content is
    // worth building at all — and ONLY that. The mirrored geometry is a function
    // of the track and the props, and it draws with its own materials, which this
    // never touches (the material `syncRoadMaterialFeatures` may have just swapped
    // is the ROAD's). So this is a rebuild at the two ends of the slider's range
    // and nothing at all in between — which matters, because the panel calls this
    // on every `input` event and a rail rebuild merges the whole track.
    syncPreMirrored();
  }

  /**
   * Surface extras (bump / streak / joints). Crossing bumpAmount or streakSharp
   * through 0 is a rebuild — those are compiled into the graph, not multiplied
   * by a uniform — and a poke everywhere else. Same shape as setRoadWet.
   */
  function setSurfaceParam(key, v) {
    surfaceLook[key] = v;
    syncRoadMaterialFeatures();
    syncSurfaceV2Uniforms(roadMaterial, surfaceLook);
  }

  /**
   * Sane ranges for the surface knobs the panel drives generically.
   *
   * A table rather than a clamp per accessor, because the alternative is a
   * matched pair of named setters per knob in BOTH handles below — which is how
   * `setBump` / `setStreakSharp` / `setJointSpacing` came to be duplicated four
   * times between them. Anything absent here passes through unclamped.
   */
  const SURFACE_BOUNDS = {
    bumpChip: [0, 4],
    bumpChipScale: [1, 80],
    bumpChipStretch: [0.25, 20],
    bumpChipFade: [0.1, 12],
    bumpFilter: [0, 1],
    lineBump: [0, 2],
    lineFill: [0, 1],
    bumpGrit: [0, 2],
    bumpMacro: [0, 4],
  };

  /**
   * Generic surface knob access, for anything that does not need its own named
   * accessor. Goes through setSurfaceParam, so a knob that DOES cross a build
   * gate still rebuilds correctly, and it lands in `surfaceLook` — which is what
   * makes it ride the saved look rather than resetting on load.
   */
  function setSurface(key, v) {
    if (!(key in surfaceLook)) return;
    const n = Number(v);
    if (!Number.isFinite(n)) return;
    const b = SURFACE_BOUNDS[key];
    setSurfaceParam(key, b ? Math.max(b[0], Math.min(b[1], n)) : n);
  }
  const getSurface = (key) => surfaceLook[key];

  /** Ranges for the ROAD_LOOK knobs the panel drives generically. */
  const LOOK_BOUNDS = {
    anisotropy: [0, 1],
    anisotropyAngle: [-90, 90],
    anisoWheel: [0, 3],
    anisoWet: [0, 1],
  };

  /**
   * Generic ROAD_LOOK knob access — the `setSurface` of the base material.
   *
   * Routed through syncRoadMaterialFeatures because one of these (`anisotropy`)
   * is build-time gated: crossing 0 has to swap the material, not poke a uniform
   * that the compiled shader does not read. The call early-returns for every
   * other key, so a slider drag costs a couple of comparisons. The uniform is
   * written afterwards on purpose — a rebuild replaces `roadMaterial`, and the
   * write has to land on whichever material is current.
   */
  function setLook(key, v) {
    if (!(key in roadLook) && !roadMaterial._roadUniforms?.[key]) return;
    const n = Number(v);
    if (!Number.isFinite(n)) return;
    const b = LOOK_BOUNDS[key];
    roadLook[key] = b ? Math.max(b[0], Math.min(b[1], n)) : n;
    syncRoadMaterialFeatures();
    const un = roadMaterial._roadUniforms?.[key];
    if (un) un.value = roadLook[key];
  }
  const getLook = (key) => roadLook[key] ?? roadMaterial._roadUniforms?.[key]?.value;

  /** The guardrail reflection, off to on. Rebuilds the material so that "off"
   *  costs nothing at all rather than costing a sample multiplied by zero. */
  function setRailsInMirrorFlag(on) {
    railsInMirror = !!on;
    syncRoadMaterialFeatures();
    applyRailReflectionMembers();
  }

  function updateCarReflection() {
    // OFF FIRST, ON ONLY ON SUCCESS. The mirrored-rail target is ping-ponged,
    // so a pass that does not run leaves a perfectly good image of last frame's
    // rails sitting in it — and a road that keeps sampling that shows a FROZEN
    // reflection, which is indistinguishable from the toggle doing nothing.
    const railOn = roadMaterial._railMirrorOn;
    if (railOn) railOn.value = 0;

    const ru = roadMaterial._reflectUniforms;
    if (!ru) return;

    // THE PRE-MIRRORED GEOMETRY, first and INDEPENDENTLY. It has no plane, no
    // contact patch and no need of the car, so it survives everything that
    // makes the planar mirror bail out — including being airborne, which is
    // exactly when you are looking down at the road from a height and the
    // rails / neon arms are the only thing in frame worth reflecting.
    // The mode gate lives HERE and nowhere else. `preMirrorActive` means "there
    // is mirrored geometry worth a pass" and is owned by rebuildMirrorRails;
    // clearing it from this side left it false after a build→drive switch, so
    // the reflection only came back if something happened to rebuild the track.
    if (mode === "drive" && reflectionEnabled && carReflection.updatePreMirrored(camera)) {
      const mirrorNode = roadMaterial._mirrorTextureNode;
      if (mirrorNode) mirrorNode.value = carReflection.mirrorTexture;
      // Follow the same ping-pong as the colour, or the gate judges last
      // frame's depth against this frame's image.
      const mirrorDepthNode = roadMaterial._mirrorDepthTextureNode;
      if (mirrorDepthNode) mirrorDepthNode.value = carReflection.mirrorDepthTexture;
      if (railOn) railOn.value = 1;
    }

    if (mode !== "drive" || !reflectionEnabled || !vehicleRef) {
      ru.reflectOn.value = 0;
      return;
    }
    let n = 0;
    _mirrorPoint.set(0, 0, 0);
    _mirrorNormal.set(0, 0, 0);
    for (const t of vehicleRef.tires ?? []) {
      if (!t.grounded) continue;
      _mirrorPoint.add(t.hitPoint);
      _mirrorNormal.add(t.hitNormal);
      n++;
    }
    if (!n || _mirrorNormal.lengthSq() < 1e-8) {
      ru.reflectOn.value = 0;
      return;
    }
    _mirrorPoint.multiplyScalar(1 / n);
    _mirrorNormal.normalize();

    const ok = carReflection.update(camera, _mirrorPoint, _mirrorNormal);
    ru.reflectOn.value = ok ? 1 : 0;
    if (!ok) return;
    // Follow the ping-pong: `carReflection.texture` is whichever buffer was
    // just written, and the material must sample THAT one — never the buffer
    // the mirror pass is still writing (see modularRoadReflection.js).
    const texNode = roadMaterial._reflectTextureNode;
    if (texNode) texNode.value = carReflection.texture;
    ru.reflectMatrix.value.copy(carReflection.textureMatrix);
    ru.reflectCenter.value.copy(_mirrorPoint);
    ru.reflectNormal.value.copy(_mirrorNormal);
  }

  // GLB body, same deal. This one changes NO physics — the collision box stays
  // CHASSIS.width/height/length either way — so it is a pure visual swap and the
  // handling is identical in both styles.
  // Kept so the dev-panel fit sliders have something to re-transform.
  let chassisGlbObject = null;
  let chassisLampsLocal = null;
  /** Shared car glyph (spawn marker, spawn brush, lap ghost). Not the live car. */
  let spawnGhostGeo = null;
  loadChassisModel(renderer)
    .then((m) => {
      const { object, brakeLights, headlampLenses } = m;
      chassisGlbObject = object;
      chassisLampsLocal = m.headlampMountsLocal;
      vehicle.setHeadlampMounts(chassisGlbMounts(chassisLampsLocal));
      vehicle.setChassisModel(object, { brakeLights, headlampLenses });
      vehicle.setChassisStyle("glb");
      // The spawn marker was a primitive stand-in at boot (this load is
      // deliberately in the background). Bake the cheap silhouette now — do NOT
      // clone the driving GLB; that was 8 translucent draws for a glyph.
      applyGhostCarTemplate();
      applyCarReflectionMembers();
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
  // One tree per mover, not one merged tree for all of them — see BvhSet.
  const moverDeckBvh = new BvhSet();
  const moverSolidsBvh = new BvhSet();

  const ground = createVehicleGround({
    // In sky mode this returns NaN and raycastFirst's `isFinite(terrainY)` guard
    // drops terrain out of the wheel probes — the car falls through open air
    // instead of landing on an invisible surface.
    getTerrainHeight: (x, z) => terrainH(x, z),
  });
  vehicle.setBvh(ground.ground, ground.solids);

  /**
   * Rebuild the collision BVHs from the current track.
   *
   * NOTE vs the lab: the lab pushed its flat `floor` mesh into `decks`. Here the
   * terrain is analytic inside createVehicleGround, so decks contains ONLY road
   * geometry — pushing a ground mesh would double up the surface.
   */
  /**
   * DEFERRED: an edit marks the tree stale, the next QUERY builds it.
   *
   * Rebuilding is 60 ms on a 24-piece track and 72% of that is `new MeshBVH()`,
   * which no build option makes cheaper (measured across strategy and leaf-size
   * in tools/bvhBakeProfile.mjs). So the lever is not doing it, and the reason
   * that works is what the deck tree is actually FOR:
   *
   *   - the prop brush raycast          (build mode, pointer-driven)
   *   - prop snap-to-surface            (build mode, on placement)
   *   - the gap-preview landing arc     (build mode, only while it is on)
   *   - the car                         (drive mode)
   *
   * PLACING ROAD PIECES — the commonest thing anyone does in here — queries it
   * not at all. So laying down a run of ten pieces used to pay ten full rebuilds
   * for a tree nothing read, and now pays none: the first brush move, gap-arc
   * frame or press of B builds it once.
   *
   * Marking is deliberately cheap and idempotent, so every existing caller can
   * keep calling `bakeCollision()` wherever it does today.
   */
  let collisionStale = true;

  function bakeCollision() {
    collisionStale = true;
    trackBottomY = null; // the track moved — the sky-mode kill floor moves with it
    // The UI half is NOT deferred. The spawn marker follows the Start piece and
    // the dev panel shows live counts; both must track an edit immediately, and
    // neither touches a BVH.
    updateSpawnMarker();
    devPanel?.refresh();
  }

  /**
   * Build the collision trees if an edit has invalidated them.
   *
   * Call before ANY read of `deckBvh` / `solidsBvh`, or of the ground adapter
   * the vehicle holds. Free when nothing changed — one boolean.
   */
  function ensureCollision() {
    if (!collisionStale) return;
    collisionStale = false;
    rebuildCollisionNow();
  }

  /**
   * Rebuild NOW, whatever the flag says.
   *
   * Deferring is an optimisation for EDITS — the caller did not ask for a tree,
   * it just changed something. An explicit rebake did ask: the dev panel's
   * button, and the `bakeCollision` on the public handle, both mean "do it", and
   * a button that silently sets a flag reads as a broken button.
   */
  function bakeCollisionNow() {
    bakeCollision();
    ensureCollision();
  }

  function rebuildCollisionNow() {
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
        // `userData` rides along because the bake reads `roadHold` off it — a
        // piece that swaps in a deck proxy must not lose its road-hold tag and
        // silently become a launch ramp.
        ? {
          geometry: proxy,
          matrixWorld: m.matrixWorld,
          userData: m.userData,
          updateMatrixWorld() {},
        }
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
      if (p.shellMesh) {
        const proxy = p.shellMesh.userData.collisionGeometry;
        solids.push(proxy
          ? { geometry: proxy, matrixWorld: p.shellMesh.matrixWorld, updateMatrixWorld() {} }
          : p.shellMesh);
      }
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

    syncMoverBvhs();

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
  }

  /**
   * Point the ground adapter at the movers' collision trees.
   *
   * A moving platform's mesh travels, so a WORLD-SPACE tree baked once goes
   * stale the moment it moves and the wheels probe empty space. The lab solved
   * that by rebuilding the entire deck BVH (whole track included) every tick;
   * this file then narrowed it to a merged mover-only tree, rebuilt per tick.
   *
   * Narrower, but still O(mover triangles) of tree CONSTRUCTION per tick, up to
   * 8 ticks a frame — measured at 11.76 ms a tick with six movers placed, of
   * which 9.81 ms was the rotating tube alone. And all of it rebuilding, from
   * scratch, a tree that in the body's own frame had not changed at all.
   *
   * So each mover now owns a RigidBvh baked ONCE in its local space, and the
   * query is transformed instead of the geometry (v3/play/modularRoadRigidBvh.js).
   * Nothing here runs per tick any more: this only re-collects the LIST, which
   * changes when a mover is added, deleted or rebuilt.
   */
  function syncMoverBvhs() {
    const { deck, solids } = movers.collisionBvhs();
    moverDeckBvh.set(deck);
    moverSolidsBvh.set(solids);
    ground.setMoverBvh(deck.length ? moverDeckBvh : null);
    ground.setMoverSolidsBvh(solids.length ? moverSolidsBvh : null);
    vehicleRef?.setDeckCarryMovers(movers.getMovers().filter((m) => m.deckCarry));
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
        // Draw the PROXY the sim uses, not the mesh — that is the whole point.
        const g = p.proxy === "cylinder"
          ? new THREE.CylinderGeometry(p.size.length * 0.5, p.size.length * 0.5, p.size.height, 16)
          : new THREE.SphereGeometry(p.radius, 10, 6);
        dbgProps.push({ line: line(g, DBG_LINE.prop), sim });
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
    // The wireframe IS the collision tree, so switching it on is a read — and
    // with the bake deferred (see bakeCollision) the tree may be a few edits
    // behind. Showing a stale outline of the collision would be worse than
    // showing none.
    if (debugOn) ensureCollision();
    refreshCollisionDebug();
    buildDynamicDebug();
    updateDynamicDebug();
  }

  // ── MERGED TRACK (draw-call optimization for driving) ──────────────────────
  // The builder instances pieces by geometry hash, so IDENTICAL pieces share a
  // draw — but a diverse stunt track (every curve/bank/jump a unique shape) gets
  // ~1 draw per piece, i.e. 80+ for a 2-min circuit. For DRIVING we don't need
  // per-piece editing, so we MERGE every piece's geometry per material into one
  // static mesh: a handful of draws per chunk (road + tube + rail + shell +
  // decor — tube only when the chunk has a rideable tube) no matter how many
  // or how varied the pieces are. Build mode keeps the
  // editable instanced/proxy meshes; drive mode swaps to the merged ones.
  const mergedGroup = new THREE.Group();
  mergedGroup.name = "ModularRoadMerged";
  mergedGroup.visible = false;
  scene.add(mergedGroup);
  _mergedGroupRef = mergedGroup;

  const MERGE_ROLES = [
    { pick: (p) => (p.mesh?.material === tubeMaterial ? null : p.mesh), mat: () => roadMaterial, cast: true },
    { pick: (p) => (p.mesh?.material === tubeMaterial ? p.mesh : null), mat: () => tubeMaterial, cast: true },
    { pick: (p) => p.railMesh, mat: () => railMaterial, cast: true },
    { pick: (p) => (p.shellMesh?.userData.vault ? null : p.shellMesh), mat: () => shellMaterial, cast: true },
    { pick: (p) => (p.shellMesh?.userData.vault ? p.shellMesh : null), mat: () => vaultShellMaterial, cast: true },
    { pick: (p) => p.decorMesh, mat: () => decorMaterial, cast: false },
    { pick: (p) => p.decorGateMesh, mat: () => startGateBodyMaterial, cast: true },
    { pick: (p) => (!p.decorGlowMesh || p.decorGlowMesh.userData.glowKind ? null : p.decorGlowMesh), mat: () => startGateGlowMaterial, cast: false },
    { pick: (p) => (p.decorGlowMesh?.userData.glowKind === "finish" ? p.decorGlowMesh : null), mat: () => finishGateGlowMaterial, cast: false },
    { pick: (p) => (p.decorGlowMesh?.userData.glowKind === "checkpoint" ? p.decorGlowMesh : null), mat: () => checkpointGlowMaterial, cast: false },
    { pick: (p) => (p.decorGlowMesh?.userData.glowKind === "tunnel" ? p.decorGlowMesh : null), mat: () => tunnelGlowMaterial, cast: false },
    // GLAZING. Its absence here was not a missed optimisation, it was a hole in
    // the road: drive mode hides the per-piece meshes and draws this list
    // instead, so a glass road's pane simply stopped existing the moment you
    // pressed B — you drove over an open frame and saw the terrain through it.
    // Build mode was fine, which is why it survived.
    //
    // `cast: false` for the same reason the per-piece mesh sets it: an opaque
    // shadow from a transparent pane puts a black rectangle on whatever is under
    // the road, which is the opposite of what a window does.
    //
    // Merging transparent geometry means a chunk cannot sort against itself.
    // That is tolerable here and nowhere near a general rule: panes sit flat in
    // the deck, a chunk is a short run of consecutive pieces, and two of them
    // are almost never overlapping in view. If glass ever becomes something you
    // can stack, this is the line that breaks.
    { pick: (p) => p.glassMesh, mat: () => glassMaterial, cast: false },
  ];

  function disposeMergedTrack() {
    for (const m of mergedGroup.children) m.geometry?.dispose();
    mergedGroup.clear();
  }

  /**
   * How big a merged chunk is allowed to get, in METRES.
   *
   * ONE mesh per material was the obvious win and it is half a win: 4 draws, but
   * a single mesh spanning the whole circuit has to be `frustumCulled = false`,
   * so every triangle on the track is submitted every frame no matter where you
   * are looking — and again for each shadow cascade. You can typically see a
   * fifth of a lap, so most of that work is thrown away.
   *
   * ── WHY EXTENT AND NOT A PIECE COUNT ─────────────────────────────────────
   *
   * This used to be `MERGE_CHUNK_PIECES = 4`, tuned on the Apex preset. A piece
   * count is a poor proxy for the thing that actually decides culling, which is
   * how much WORLD a chunk covers — and this kit's pieces are nowhere near the
   * same size. A 22 m straight and a 100 m loop both count as one.
   *
   * The piece count also cannot be tuned reliably. A first sweep put 12 pieces
   * per chunk BEHIND 16 on both axes — more draws and more triangles — which is
   * not something a track can do. The boundaries had simply landed differently
   * (41/12 splits 12·12·12·5, 41/16 splits 16·16·9), and that non-monotonicity
   * is the proxy admitting it measures the wrong quantity.
   *
   * ── WHAT IT ACTUALLY BUYS, MEASURED ──────────────────────────────────────
   *
   * Averaged over fixed stations along each track — parked, not driving, because
   * sampling while accelerating made the same config swing 37% between passes
   * and swamped the effect. Repeats of the numbers below agree to ~0.3%.
   *
   *   rushline (41 pieces, mixed sizes — has a loop and wide platforms)
   *     count 4      96.4 draws   875 KTris
   *     extent 180   84.1 draws   832 KTris     ← better on BOTH
   *
   *   apex-parkour (55 pieces, more uniform)
   *     count 4      79.8 draws   857 KTris
   *     extent 180   80.1 draws   874 KTris     ← a wash, marginally worse
   *
   * So: a real win where piece sizes vary, and nothing where they do not —
   * which is exactly what the theory predicts, since a uniform track makes the
   * piece count an accurate proxy for extent already. It is kept for the case it
   * helps and for two properties the count never had: the knob means something
   * (how far you must look away before a chunk can be culled), and it degrades
   * sensibly on a long circuit instead of silently growing the chunk list.
   *
   * Do not expect a frame-rate change from this. At ~11 ms CPU and ~3 ms GPU the
   * frame has room for both sides of the trade; this is headroom, not FPS.
   */
  const MERGE_CHUNK_EXTENT = 180;

  /**
   * Group consecutive pieces into runs no bigger than MERGE_CHUNK_EXTENT.
   *
   * CONSECUTIVE, not a spatial grid: pieces chain end to end, so a run of them
   * is already spatially tight and this costs one bounding box per piece. A grid
   * would split a single piece across cells, which merging cannot express.
   *
   * The bound is on the running box's LONGEST AXIS rather than its diagonal, so
   * a chunk that climbs is judged the same as one that runs flat — a loop is
   * tall, not sprawling, and should not be broken up for it.
   *
   * A piece bigger than the limit on its own becomes its own chunk instead of an
   * empty one: `cur.length` is what guarantees forward progress.
   */
  function chunkPiecesByExtent(pieces) {
    const chunks = [];
    let cur = [];
    const box = new THREE.Box3();
    const pieceBox = new THREE.Box3();
    const test = new THREE.Box3();
    const size = new THREE.Vector3();
    for (const p of pieces) {
      const m = p.mesh;
      if (!m?.geometry) continue;
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      pieceBox.copy(m.geometry.boundingBox).applyMatrix4(m.matrixWorld);
      if (!cur.length) {
        cur.push(p);
        box.copy(pieceBox);
        continue;
      }
      test.copy(box).union(pieceBox);
      test.getSize(size);
      if (Math.max(size.x, size.y, size.z) > MERGE_CHUNK_EXTENT) {
        chunks.push(cur);
        cur = [p];
        box.copy(pieceBox);
      } else {
        cur.push(p);
        box.copy(test);
      }
    }
    if (cur.length) chunks.push(cur);
    return chunks;
  }

  function buildMergedTrack() {
    disposeMergedTrack();
    scene.updateMatrixWorld(true);
    for (const chunk of chunkPiecesByExtent(builder.pieces)) {
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
    // THE MERGED MESHES ARE THE ONES THAT ACTUALLY DRAW IN DRIVE MODE, so they
    // are the ones the mirror needs. Without this the guardrail was never
    // reflected in the game while reflecting perfectly in wet-road-lab, which
    // does not batch: membership had been applied to the per-piece proxies,
    // and drive mode then hides those and draws these instead. Measured on a
    // live track — 32 rail meshes on the reflect layer, all hidden; 8 visible,
    // none on the layer.
    applyRailReflectionMembers();
  }

  // ── INSTANCED PROPS ────────────────────────────────────────────────────────
  // EVERY prop, in BOTH modes — see modularRoadPropInstancer.js. This replaced a
  // drive-mode-only merge, which collapsed further but could not cover the
  // editor: merged geometry cannot move (so cones and gates were excluded) and
  // every edit invalidates the whole bake (so dragging one prop of a hundred
  // re-merged all hundred). Measured before: 100 poles cost 648 draws while
  // building against 58 driving. Now both are flat.
  // Ad boards keep a unique poster map per placement — instancing would pin
  // every copy to one image (and hide the live mesh that actually wears it).
  const propInstancer = new PropInstancer(scene, props, PROP_CATALOG, (id) => id !== "adboard" && id !== "adtotem" && id !== "adprism");
  _propInstancerRef = propInstancer;
  _propsRef = props;
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
  // Cones, tyres, gates. Physics props carry collision:"none" so they stay OUT of the
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
  //
  // The car's two SpotLights are the ONLY punctual lights in the game — the rest
  // of the world is the sun plus ambient — so they are also the only thing that
  // can change the scene's light SET, and changing that set costs a full-scene
  // shader rebuild. They no longer do; see HEADLIGHTS in modularRoadVehicle.js.
  let sunLight = null;
  scene.traverse((o) => { if (!sunLight && o.isDirectionalLight) sunLight = o; });

  let autoHeadlights = false;
  let headlightsOn = false;
  const _sunDir = new THREE.Vector3();

  function setHeadlights(on) {
    headlightsOn = !!on;
    vehicle.setHeadlights(headlightsOn);
  }

  /**
   * Sun height → lights. Hysteresis (on below 0.10, off above 0.16) so the lamps
   * don't strobe when the sun sits right on the threshold.
   *
   * Flipping the beams is a uniform write now (see HEADLIGHTS in
   * v3/play/modularRoadVehicle.js), so this is free to fire whenever it likes.
   * It used to toggle `SpotLight.visible`, which rebuilt every shader in the
   * world — which is why dragging the world panel's sun through dusk froze the
   * game harder than pressing H did: the stall arrived unasked, mid-drive, on the
   * same frame as the sun move that caused it.
   */
  function updateAutoHeadlights() {
    if (!sunLight) return;
    _sunDir.copy(sunLight.position);
    if (sunLight.target) _sunDir.sub(sunLight.target.position);
    // Written as `!(len > eps)`, NOT `len < eps`: a NaN sun — which this scene
    // has been seen to produce mid-play — fails every comparison, so the old
    // guard passed it straight through and the elevation test below then
    // answered "false" to BOTH branches. Auto headlights would quietly stop
    // tracking time of day for the rest of the session with nothing to show why.
    if (!(_sunDir.lengthSq() > 1e-8)) return;
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
  // Sprint course: rounded start_new + finish_new (optional checkpoint_new),
  // on ANY chains — a jump / new chain / snap-landing is a normal sprint.
  // Open start/finish pieces are ignored until circuit/lap mode. Air-stunt rule:
  // falling into empty sky respawns at the LAST SAFE GROUNDED POSE (not a
  // checkpoint), so a missed jump puts you back on the takeoff. A drop that
  // still has track under it is allowed to land. Timing gates drive the clock
  // + splits only.
  const RACE_KEY = "modular-road-v3.sprint.";
  const run = new RunTracker({ roadWidth: 16 });
  // Slow-mo contract. 1 = realtime. Do not change FIXED_DT to slow the world.
  let timeScale = 1;
  const ghost = new GhostTrack({ sampleHz: 60 });
  const ghostMesh = createGhostMesh(CHASSIS.width, CHASSIS.height, CHASSIS.length);
  scene.add(ghostMesh);
  const _ghostPos = new THREE.Vector3();
  const _ghostQuat = new THREE.Quaternion();

  // Air-stunt fall→respawn rule. OFF for now: free-drive lets the car fall off
  // the track onto the terrain and keep driving. Game mode flips this on later.
  let raceRespawn = false;
  // Visual only — recording / commit / localStorage still run when this is off.
  let showRaceGhost = true;

  // Last pose the car was safely grounded on the track — the air-stunt respawn.
  const lastSafePos = new THREE.Vector3();
  const lastSafeQuat = new THREE.Quaternion();
  let lastSafeY = 0;
  let hasSafe = false;
  let failFallTime = 0;
  const _respawnPos = new THREE.Vector3();
  const _fallProbe = new THREE.Vector3(); // sky-mode kill floor — see fallFloorY
  const _fallDir = new THREE.Vector3();
  const _fallRight = new THREE.Vector3();
  const _fallDown = new THREE.Vector3(0, -1, 0);
  const _fallBox = new THREE.Box3();

  const recKey = () => RACE_KEY + run.courseSignature();

  function loadRecord() {
    if (!run.hasCourse) return;
    try {
      const raw = localStorage.getItem(recKey());
      if (!raw) return;
      const rec = JSON.parse(raw);
      if (Number.isFinite(rec.best)) run.applyStoredBest(rec.best);
      if (Array.isArray(rec.splits)) run.applyStoredSplits(rec.splits);
      if (rec.ghost) ghost.load(rec.ghost);
    } catch { /* corrupt / disabled — ignore */ }
  }

  function saveRecord() {
    if (!run.hasCourse) return;
    try {
      localStorage.setItem(recKey(), JSON.stringify({
        best: run.bestTime,
        splits: run.bestSplits,
        ghost: ghost.serialize(),
      }));
    } catch { /* quota / disabled */ }
  }

  function clearRecord() {
    try { if (run.hasCourse) localStorage.removeItem(recKey()); } catch {}
    ghost.clear();
    ghostMesh.visible = false;
    run.clearBest();
  }

  /** Set up timing for a fresh run — call on entering drive mode. */
  function beginRace() {
    // buildGates() resets timing internally, so load the stored record AFTER it
    // (reset() clears bestTime — loading before it would be wiped).
    run.buildGates(builder.pieces);
    drift.reset(); // fresh drift total per run
    ghost.clear();
    loadRecord();
    ghostMesh.visible = false;
    hasSafe = false;
  }

  function handleRunEvent(ev) {
    if (ev.kind === "start") {
      ghost.discard();
      ghost.beginLap();
      audioSystem.playCue("start");
    } else if (ev.kind === "checkpoint") {
      if (Number.isFinite(ev.splitDelta)) {
        showSplit(ev.splitDelta);
        audioSystem.playCue(ev.splitDelta < 0 ? "cpAhead" : "cpBehind");
      } else if (hudSplit && Number.isFinite(ev.time)) {
        hudSplit.textContent = formatRunTime(ev.time);
        hudSplit.className = "show";
        splitTimer = 2.0;
        audioSystem.playCue("cp");
      }
    } else if (ev.kind === "finish") {
      if (ev.isRecord) {
        ghost.commit();
        saveRecord();
        devPanel?.refresh();
      } else {
        ghost.discard();
      }
      audioSystem.playCue(ev.isRecord ? "record" : "finish");
    }
  }

  /** Per-tick: record the safe pose while the car can actually drive.
   *
   *  `groundedCount > 0` is not enough. A car hanging off a rail still has 1–2
   *  wheels on the deck, so the old test saved the raised/tilted trap as "safe"
   *  and recover-from-stuck teleported right back onto it. Same bar as the
   *  stuck detector: 3+ wheels on a drive surface. */
  function trackSafePose() {
    if (vehicle.groundedCount < 3) return;
    const b = vehicle.body;
    lastSafePos.copy(b.pos);
    lastSafeQuat.copy(b.quat);
    lastSafeY = b.pos.y;
    hasSafe = true;
    failFallTime = 0;
  }

  /**
   * Fall handling (per frame).
   *
   * Two separate things:
   *  • Absolute void backstop — ALWAYS on. A car below FALL_Y is truly lost (fell
   *    through the world), so send it back to the start.
   *  • Air-stunt rule — GAME MODE. Dropping FALL_DROP below the last track
   *    contact is a candidate miss. If a deck is still on the fall path, keep
   *    falling (a jump onto a much lower road is a real landing). Empty sky
   *    next to the road you were on snaps to last-safe; a miss after a jump
   *    (air or rail) goes to spawn. On whenever a sprint course exists
   *    (start+finish), or when the dev toggle is forced on.
   *
   * In free-drive (no course, toggle off) the car simply FALLS off the track
   * and lands on the terrain, which is drivable — no respawn. The old always-on
   * version looped: respawn at the edge → fall → repeat.
   */
  /**
   * The absolute backstop height, which is not a constant in sky mode.
   *
   * FALL_Y is -60: written when the track sat on terrain near y=0, where "below
   * minus sixty" means "gone". A sky track floats at DEFAULT_BUILD_HEIGHT (40 m)
   * and can be built hundreds of metres up, so the same fixed floor makes the car
   * fall the whole way past zero before the game notices — four or five seconds
   * of watching nothing after every missed jump. So in sky mode the floor
   * follows the TRACK instead of the world.
   *
   * It REPLACES FALL_Y rather than combining with it. The first version took
   * `Math.min` of the two, meaning to keep the world floor as a backstop — but
   * min picks the DEEPER floor, so a track at 200 m got min(-60, 150) = -60 and
   * the feature did nothing at exactly the altitude it was written for. There is
   * no world in sky mode, so there is no second floor to defer to.
   */
  function fallFloorY() {
    if (terrainOn) return FALL_Y;
    if (trackBottomY === null) {
      // Cheap and rare (once per track edit), but O(pieces) — hence the cache
      // rather than doing it in checkFall, which runs every frame.
      let lo = Infinity;
      for (const p of builder.pieces) {
        if (!p.connectorIn) continue;
        _fallProbe.setFromMatrixPosition(p.connectorIn);
        if (_fallProbe.y < lo) lo = _fallProbe.y;
      }
      trackBottomY = Number.isFinite(lo) ? lo : 0;
    }
    return trackBottomY - SKY_FALL_MARGIN;
  }

  /**
   * Sky mode on/off. One switch for all three halves of it — the terrain stops
   * drawing, stops being solid, and stops being what heights are measured from.
   *
   * Nothing here needs a rebuild or a rebake: the samplers are read live through
   * terrainH/groundBaseY, and hiding a mesh recompiles nothing. So this is safe
   * to flip mid-drive, which is the whole point of it being a switch and not a
   * boot flag — A/B the same session, at the same GPU clock.
   */
  function setTerrain(on) {
    const next = !!on;
    if (next === terrainOn) return;
    terrainOn = next;
    app.terrain?.setVisible(terrainOn);
    // The kill-floor RULE changed (world-absolute vs track-relative), so the
    // cached value is stale even though the track itself never moved.
    trackBottomY = null;
    devPanel?.refresh();
  }

  /** First drive-surface hit along a ray. Terrain is ignored on purpose: landing
   *  on dirt is a miss when the air-stunt rule is on. Movers are included so an
   *  elevator under the fall still counts. */
  function deckAlong(origin, dir, far) {
    let best = null;
    if (deckBvh?.baked) {
      const h = deckBvh.raycastFirst(origin, dir, far);
      if (h) best = h;
    }
    if (moverDeckBvh?.baked) {
      const h = moverDeckBvh.raycastFirst(origin, dir, far);
      if (h && (!best || h.distance < best.distance)) best = h;
    }
    return best;
  }

  /**
   * Is there still a deck this fall can hit, before the kill floor?
   *
   * A vertical / ballistic ray is the wrong tool. FALL_DROP fires 12 m under
   * the lip; a real drop-jump (airjump's first gap is ~160 m down and ~270 m
   * out) is still over empty sky at that moment, so a ray from the car never
   * touches the island and the old probe snapped back to the takeoff.
   *
   * Instead: look at piece world AABBs. Anything already below the car, either
   * near it or ahead in a heading corridor, is a landing. O(pieces), and only
   * after FALL_DROP — not per tick, not while driving. Terrain is not a landing.
   */
  function hasLandingBelow() {
    const p = vehicle.body.pos;
    const v = vehicle.body.vel;
    const floor = fallFloorY();
    const downFar = Math.max(4, p.y - floor + 2);
    if (deckAlong(p, _fallDown, downFar)) return true;

    // Heading: where the car is actually going, else where it was facing on
    // the lip (a slow roll-off has almost no XZ speed).
    _fallDir.set(v.x, 0, v.z);
    if (_fallDir.lengthSq() < 16) {
      _fallDir.set(0, 0, 1).applyQuaternion(hasSafe ? lastSafeQuat : vehicle.body.quat);
      _fallDir.y = 0;
    }
    if (_fallDir.lengthSq() < 1e-8) return false;
    _fallDir.normalize();
    _fallRight.set(-_fallDir.z, 0, _fallDir.x);

    const nearR2 = FALL_LAND_NEAR * FALL_LAND_NEAR;
    for (const piece of builder.pieces) {
      const m = piece.mesh;
      if (!m || m.userData.noCollision || !m.geometry) continue;
      m.updateWorldMatrix(true, false);
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      _fallBox.copy(m.geometry.boundingBox).applyMatrix4(m.matrixWorld);
      if (!(_fallBox.max.y < p.y - 0.5)) continue;
      if (_fallBox.max.y < floor - 1) continue;

      const qx = p.x < _fallBox.min.x ? _fallBox.min.x : (p.x > _fallBox.max.x ? _fallBox.max.x : p.x);
      const qz = p.z < _fallBox.min.z ? _fallBox.min.z : (p.z > _fallBox.max.z ? _fallBox.max.z : p.z);
      const dx = qx - p.x, dz = qz - p.z;
      if (dx * dx + dz * dz <= nearR2) return true;

      const cx = (_fallBox.min.x + _fallBox.max.x) * 0.5 - p.x;
      const cz = (_fallBox.min.z + _fallBox.max.z) * 0.5 - p.z;
      const ahead = cx * _fallDir.x + cz * _fallDir.z;
      const side = Math.abs(cx * _fallRight.x + cz * _fallRight.z);
      const pieceHalf = 0.5 * Math.hypot(
        _fallBox.max.x - _fallBox.min.x,
        _fallBox.max.z - _fallBox.min.z,
      );
      if (ahead > -20 && ahead < FALL_LAND_AHEAD && side < FALL_LAND_HALF + pieceHalf) return true;
    }
    return false;
  }

  function isJumpMiss() {
    if (!hasSafe) return false;
    const p = vehicle.body.pos;
    const dx = p.x - lastSafePos.x;
    const dz = p.z - lastSafePos.z;
    return dx * dx + dz * dz > FALL_SAFE_RANGE * FALL_SAFE_RANGE
      || lastSafeY - p.y > FALL_SAFE_DROP;
  }

  /** Put the car back on the last pose where it was properly on the track.
   *
   *  That pose is the right retry when you slipped off the road you were on.
   *  It is the wrong retry after a jump: last-safe is the lip, and sending
   *  you back there after a miss (rail, air, whatever) just relaunches the
   *  same jump. Far or deep from that pose → full spawn, like a loss. */
  function recoverToSafePose() {
    if (!hasSafe) { respawn(); return; }
    if (isJumpMiss()) { respawn(); return; }
    _respawnPos.copy(lastSafePos); _respawnPos.y += 0.5; // small lift so wheels clear
    // respawnAt, not setSpawn+respawn: overwriting spawn made the next R (or a
    // recover loop) reuse this lifted pose, stacking +0.5 m until the car sat
    // on the lap ghost. Race start stays whatever resolveSpawn says.
    vehicle.respawnAt(_respawnPos, lastSafeQuat);
    chase.reset(); tireMarks.reset(); driftSmoke.reset(); sparks.reset();
    propPhysics.reset();  // knocked cones stand back up on a lap reset
    simAccum = 0;
  }

  function checkFall(dt) {
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

    if (y < fallFloorY()) { respawn(); return; } // lost below the world

    // STUCK — always on, unlike the air-stunt rule below. Some traps have no
    // solution in the contact model at all (landing balanced on a guardrail: the
    // rail is in the solids BVH, the wheels only probe the deck BVH, so there is
    // no traction up there to drive out with). The Vehicle already tried a nudge;
    // this is the give-up path. Independent of `raceRespawn` because being
    // trapped is never a playable state, in free-drive or a race.
    //
    // BOTH the timer AND isBeached: a stale stuckTime after R used to recover
    // every frame (lifting last-safe each time) even once the car was at the
    // start. respawnAt clears the timer; this is the belt.
    if (STUCK.enabled && vehicle.isBeached && vehicle.stuckTime >= STUCK.respawnAfter) {
      recoverToSafePose();
      return;
    }

    if (!(raceRespawn || run.hasCourse)) return; // free-drive: fall to terrain

    if (hasSafe && y < lastSafeY - FALL_DROP && !hasLandingBelow()) {
      // Jump miss: let them fall so the loss reads, then spawn. Local slip
      // off the road you were on still snaps back to last-safe.
      if (isJumpMiss()) {
        failFallTime += dt;
        if (failFallTime >= FAIL_FALL_TIME) respawn();
        return;
      }
      recoverToSafePose();
    } else {
      failFallTime = 0;
    }
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

  // ── ORBIT ORIGIN (`.` / numpad `.`) ────────────────────────────────────────
  // OrbitControls turns around `controls.target`, which is otherwise only moved
  // by RMB pan — easy to leave behind on a long elevated track. Blender's
  // Frame Selected is the same idea; we MOVE THE PIVOT and keep the current
  // distance/angle (framing a single 8 m straight would slam the camera in).
  // Double-click is the editor's terrain-focus, and LMB places, so this is
  // the road-game path: right-click to select, then `.`.
  const _focusPt = new THREE.Vector3();
  const _focusOff = new THREE.Vector3();
  const _focusTmp = new THREE.Vector3();
  const _focusBox = new THREE.Box3();

  function _expandMeshBox(mesh) {
    if (!mesh?.geometry) return;
    mesh.updateWorldMatrix(true, false);
    _focusBox.expandByObject(mesh);
  }

  /** World point to orbit, or null if nothing is selected. */
  function selectionOrbitPoint() {
    const pieces = builder.selectedPieces.filter((p) => builder.pieces.includes(p));
    if (pieces.length) {
      _focusBox.makeEmpty();
      for (const p of pieces) _expandMeshBox(p.mesh);
      if (!_focusBox.isEmpty()) return _focusBox.getCenter(_focusPt);
      // Gap spacers have no deck mesh worth boxing — chord of the connectors.
      _focusPt.set(0, 0, 0);
      let n = 0;
      for (const p of pieces) {
        if (p.connectorIn) {
          _focusPt.add(_focusTmp.setFromMatrixPosition(p.connectorIn));
          n++;
        }
        if (p.connectorOut) {
          _focusPt.add(_focusTmp.setFromMatrixPosition(p.connectorOut));
          n++;
        }
      }
      return n ? _focusPt.multiplyScalar(1 / n) : null;
    }
    const inst = props.selected ?? movers.selected ?? portals.selected;
    const root = inst?.root;
    if (!root) return null;
    root.updateWorldMatrix(true, false);
    _focusBox.setFromObject(root);
    if (!_focusBox.isEmpty()) return _focusBox.getCenter(_focusPt);
    return _focusPt.copy(root.position);
  }

  /** Put the orbit pivot on the selection. No-op with nothing selected. */
  function focusOrbitOnSelection() {
    if (mode !== "build" && !freeLook) return false;
    const point = selectionOrbitPoint();
    if (!point || !controls.target) return false;
    _focusOff.subVectors(camera.position, controls.target);
    if (_focusOff.lengthSq() < 1e-8) _focusOff.set(0.65, 0.35, 0.65).setLength(24);
    controls.target.copy(point);
    camera.position.copy(point).add(_focusOff);
    controls.update?.();
    return true;
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
  // Only the SPAWN brush still uses a fixed step: it aims a car, not a piece, so
  // it has nothing to line up with the build grid's angle setting. Everything
  // that turns geometry goes through builder.angleStep.
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
    // `.` / numpad `.` — orbit around the current selection (road, prop, mover
    // or portal). Lives here, not in the editor camera: the game swallows keys
    // in capture, and the editor's own Period focuses TERRAIN at screen centre.
    // Match `e.key === "."` as well as the codes: AZERTY types `.` via Shift+;
    // (`e.code` is Semicolon), and numpad `.` is NumpadDecimal on every layout.
    if ((code === "period" || code === "numpaddecimal" || e.key === ".") && !e.repeat) {
      focusOrbitOnSelection();
      return;
    }
    // Piece editing takes precedence while a placed piece is selected (right-click).
    const sel = builder.selectedPiece;
    if (sel) {
      switch (code) {
        case "escape": builder.deselectPiece(); paletteUi?.refreshStatus?.(); devPanel?.refresh(); return;
        case "keyw": builder.setPlacementGizmoMode("translate"); return; // move the whole chain
        case "keye": builder.setPlacementGizmoMode("rotate"); return;    // tilt this piece + downstream
        // These all act on THE WHOLE SELECTION. Single-select is a selection of
        // one, so there is one code path and no behaviour change when you have
        // just right-clicked a single piece.
        case "keyl": builder.levelSelected(); devPanel?.refresh(); return; // reset tilt
        // U, not G: `g` is the gap piece's hotkey, and this switch runs BEFORE
        // the piece-hotkey lookup, so a case here would shadow it whenever
        // something was selected. Free letters left: a y z.
        case "keyu": { // guardrails/kerbs off, then on — per piece
          const anyOn = builder.selectedPieces.some((p) => p.edges !== false);
          const n = builder.setSelectedEdges(!anyOn);
          setSelectionStatus(`Edges ${anyOn ? "off" : "on"} for ${n} piece${n > 1 ? "s" : ""}`);
          devPanel?.refresh(); return;
        }
        case "delete": case "backspace": {
          const n = builder.deleteSelected();
          setSelectionStatus(`Deleted ${n} piece${n > 1 ? "s" : ""}`);
          devPanel?.refresh(); return;
        }
        case "enter": { // replace the selection with the active palette piece
          const n = builder.replaceSelected(builder.activePieceId);
          setSelectionStatus(`Replaced ${n} piece${n > 1 ? "s" : ""}`);
          devPanel?.refresh(); return;
        }
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
      // Q/E use the ANGLE STEP, not a hardcoded 15°. They used to disagree with
      // the rotate gizmo the moment you touched the Angle step slider.
      case "keyq": if (builder.freePlaceMode) builder.rotateFreeYaw(builder.angleStep); break;
      case "keye":
        if (builder.freePlaceMode) {
          if (e.shiftKey) builder.setPlacementGizmoMode("rotate");
          else builder.rotateFreeYaw(-builder.angleStep);
        }
        break;
      // ARROWS TURN THINGS BY EXACT STEPS — the precision half of rotating, which
      // only a gizmo drag could do before. Free in build mode: arrows are read
      // only by the DRIVE branch. Shift swaps yaw for roll so all three axes fit
      // on four keys.
      case "arrowleft": case "arrowright": case "arrowup": case "arrowdown": {
        const up = code === "arrowup" || code === "arrowdown";
        const axis = up ? "pitch" : (e.shiftKey ? "roll" : "yaw");
        const dir = (code === "arrowright" || code === "arrowup") ? 1 : -1;
        nudgeAngle(axis, dir);
        return;
      }
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
      case "keyn": seedChainAtSpawn({ atCursor: true }); break; // new chain near selection / tip
      case "keyk": goToBranch(); return;                        // hop to a junction branch
      // O = the OTHER END of this chain (tail <-> head).
      //
      // CHECK PIECE_CATALOG BEFORE ADDING A KEY HERE. The piece-hotkey lookup at
      // the top of this function runs FIRST and returns, so any letter a piece
      // already claims is dead on arrival down here — this shortcut shipped as H
      // and did nothing at all, because H selects the spiral/helix piece.
      // Free letters at time of writing: a i j m o u x y z.
      //
      // O is also positionally identical on AZERTY and QWERTY, so matching it on
      // `e.code` gives the key with the same LABEL on both — unlike its
      // neighbours in this switch (see the note on the undo shortcut).
      case "keyo": toggleBuildEnd(); return;
      // J = JOIN: close the gap from this end to the nearest other open end.
      // Free letter, and same physical key on AZERTY and QWERTY.
      case "keyj": linkToNearest(); return;
      // X = the gizmo's AXES: world (grid-aligned) or local (along travel).
      // Free letter — no piece claims it, and drive mode's air-roll is a
      // different handler entirely.
      case "keyx": toggleGizmoSpace(); return;
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

  // ── MANUAL OVERLAY ─────────────────────────────────────────────────────────
  // The ~700 words that used to sit under the toolbar, moved behind "?".
  // `hidden` is the single source of truth — no class to fall out of sync with.
  //
  // LOOKED UP LAZILY, not captured once: the keydown handler below is registered
  // here, while the buttons that also drive it are wired much further down, and
  // a `const` element captured at this point would be a temporal-dead-zone
  // reference from inside the handler. A getElementById per keypress is free.
  const helpEl = () => document.getElementById("build-help");
  const isHelpOpen = () => { const el = helpEl(); return !!el && !el.hidden; };
  const setHelp = (on) => { const el = helpEl(); if (el) el.hidden = !on; };

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

    // MANUAL: "?" opens it, Esc closes it — handled up here, above everything
    // else, for two reasons. "?" is Shift+/ on QWERTY but Shift+, on AZERTY, so
    // it has to match `e.key` (the printed label) like the undo shortcut does,
    // not `e.code`. And while the manual is open Esc belongs to it, ahead of the
    // brush and the piece selection further down.
    if ((e.key === "?" || (e.key === "/" && e.shiftKey)) && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      setHelp(!isHelpOpen());
      return;
    }
    if (code === "escape" && isHelpOpen()) {
      e.preventDefault();
      setHelp(false);
      return;
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
    if (mode !== "build") return;
    if (brush) { updateBrush(e.clientX, e.clientY); return; }
    // NO BRUSH ⇒ the ROAD PIECE tracks the cursor, the same way a prop ghost
    // does. Point near any open end and the next piece jumps there; point at
    // nothing and it stays put, so a deliberately free-placed piece is not
    // dragged off by an idle mouse move. Returns true only when the aim actually
    // changed, which is what keeps the status refresh off the hot path.
    if (builder.aimAtCursor(e.clientX, e.clientY)) paletteUi?.refreshStatus?.();
  });
  // Leaving the canvas hides the ghost rather than freezing it at the last edge
  // position, which otherwise looks like a stuck object.
  renderer.domElement.addEventListener("pointerleave", () => {
    if (brush) { brush.root.visible = false; brush.point = null; }
  });

  function placeAtPointer(e) {
    // A live brush owns the left button: click places the PROP under the cursor,
    // not a road piece at the chain's open end.
    if (brush) {
      updateBrush(e.clientX, e.clientY); // the pointer may have moved since
      placeBrush();
      return;
    }
    builder.aimAtCursor(e.clientX, e.clientY); // same reason: it may have moved
    builder.place();
    paletteUi.refreshStatus();
  }

  const anyGizmoUnderPointer = () =>
    props.isUsingGizmo?.() ||
    movers.isUsingGizmo?.() ||
    portals.isUsingGizmo?.() ||
    builder.isUsingPlacementGizmo?.();

  /**
   * Every TransformControls root in the scene. FILLED further down, once every
   * system that owns a gizmo has been built — declared up here so a pointer
   * event during setup reads an empty list rather than a temporal-dead-zone
   * ReferenceError. Shared by gizmoPoseKey and syncGizmoAttachment.
   * @type {THREE.Object3D[]}
   */
  const gizmoRoots = [];

  /**
   * Where every live gizmo's object is RIGHT NOW, as a comparable string.
   *
   * Read off the TransformControls roots rather than from the four systems: the
   * rule is a property of the gizmo, not of any one tool, and this way it also
   * covers the engine's own. (`gizmoRoots` is collected further down — only ever
   * read here from inside an event, long after setup.)
   */
  function gizmoPoseKey() {
    let key = "";
    for (const root of gizmoRoots) {
      const o = root.controls?.object;
      if (!o) continue;
      const p = o.position, q = o.quaternion;
      key += `${p.x},${p.y},${p.z},${q.x},${q.y},${q.z},${q.w};`;
    }
    return key;
  }

  /**
   * A PRESS THAT LANDS ON A GIZMO IS NOT NECESSARILY A GRAB.
   *
   * The build cursor's gizmo is parked on the chain's open end — which is
   * exactly where the next piece goes — and its pickers are invisible meshes far
   * fatter than the drawn arrows, scaled to a constant screen size (~150 px of
   * reach, ~50 px thick). So the one spot you most want to click was a hole, and
   * the workaround was to zoom in until the handles were small enough to aim
   * around. Refusing the click outright (which is what this handler used to do)
   * is only correct if touching a handle always means "drag me".
   *
   * Decided on pointerUP by whether anything actually happened, the same way the
   * right button already tells a pan from a select: the press goes to the gizmo,
   * and if the pointer then sits still AND nothing moved, it was a click after
   * all and it places. A real drag moves the pose and is left alone.
   *
   * Both tests are needed. Pixels alone are not enough — 6 px on a far-out
   * camera is metres of chain — and pose alone is not either, since a snapped
   * drag can end exactly where it started.
   */
  let lmbHeldByGizmo = null;
  const CLICK_SLOP_PX = 6; // same as the RMB pan/select test below

  renderer.domElement.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || mode !== "build") return;
    if (anyGizmoUnderPointer()) {
      // TransformControls' own listener runs first (registered at construction)
      // so the drag, if this is one, has already started.
      lmbHeldByGizmo = { x: e.clientX, y: e.clientY, pose: gizmoPoseKey() };
      return;
    }
    placeAtPointer(e);
  });

  renderer.domElement.addEventListener("pointerup", (e) => {
    if (e.button !== 0) return;
    const held = lmbHeldByGizmo;
    lmbHeldByGizmo = null;
    if (!held || mode !== "build") return;
    if (Math.hypot(e.clientX - held.x, e.clientY - held.y) > CLICK_SLOP_PX) return;
    if (gizmoPoseKey() !== held.pose) return;
    // TransformControls clears `dragging`/`axis` in its own pointerup, which ran
    // before this one — so aimAtCursor is free to move the ghost again.
    placeAtPointer(e);
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
    selectUnderCursor(e);
  });

  /**
   * ONE RIGHT-CLICK, ARBITRATED — whatever is nearest the camera wins.
   *
   * There used to be FOUR right-click selectors on this canvas: props, movers
   * and portals each listened on pointerDOWN and raycast their own group, while
   * the road builder listened on pointerUP. Right-click a boost pad sitting on a
   * road and both fired — the pad got selected, then the road's ray went straight
   * through it, hit the deck underneath and selected that too, taking the gizmo
   * the pad had just claimed. Nothing was wrong with any one of them; there was
   * simply nobody deciding between them.
   *
   * Front-most wins, which is what every editor does and what a pointer means.
   * Running it on pointerUP behind the pan test also gets the props something
   * they never had: right-dragging the camera past an obstacle no longer selects
   * it, because that is a drag, not a click.
   */
  function selectUnderCursor(e) {
    const x = e.clientX, y = e.clientY;
    const cands = [
      { who: "prop", sys: props, hit: props.hitTest?.(x, y) },
      { who: "mover", sys: movers, hit: movers.hitTest?.(x, y) },
      { who: "portal", sys: portals, hit: portals.hitTest?.(x, y) },
      { who: "road", sys: null, hit: builder.pickPieceHit?.(x, y) },
    ].filter((c) => c.hit);
    cands.sort((a, b) => a.hit.dist - b.hit.dist);
    const win = cands[0] ?? null;

    // Everything that did not win loses its selection, so there is never more
    // than one gizmo live.
    for (const sys of [props, movers, portals]) {
      if (!win || win.sys !== sys) sys.selectHit?.(null);
    }
    if (!win || win.who !== "road") {
      builder.deselectPiece();
      if (win) win.sys.selectHit(win.hit.hit);
      paletteUi.refreshStatus();
      devPanel?.refresh();
      return;
    }
    // ROAD. Shift takes the SECTION between here and the anchor — a chain is a
    // linear array, so a range is one gesture instead of one click per piece.
    // Ctrl adds or removes a single piece, for the exception.
    const picked = win.hit.hit;
    if (e.shiftKey) builder.selectRangeTo(picked);
    else if (e.ctrlKey || e.metaKey) builder.toggleSelected(picked);
    else builder.selectPiece(picked);
    paletteUi.refreshStatus();
    devPanel?.refresh();
  }
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
  onClick("road-other-end", () => { toggleBuildEnd(); });
  onClick("road-link", () => { linkToNearest(); });
  onClick("road-gizmo-space", () => toggleGizmoSpace());
  onClick("road-rebake", () => bakeCollisionNow());

  /** Say what a bulk edit just did, then let the normal status line take over on
   *  the next builder change. Without this a five-piece delete is silent. */
  function setSelectionStatus(text) {
    const el = document.getElementById("road-status");
    if (el) el.textContent = text;
  }

  /**
   * Turn the selected piece / chain / next piece by one angle step (arrow keys).
   *
   * The readout is the point as much as the rotation is: an exact step is only
   * useful if you can see what you have got, and the numbers were previously
   * buried in the dev panel. Says WHAT it turned too, because a tilt on an
   * attached piece banks everything after it in the chain — that is the
   * banked-landing-strip tool working as designed, but it should not be a
   * surprise.
   */
  function nudgeAngle(axis, dir) {
    // AN OBSTACLE FIRST, IF ONE IS SELECTED. Exact angle steps used to exist only
    // for road pieces, so a boost pad you wanted at exactly 45° meant dragging
    // the gizmo and squinting at it. Routed here rather than inside each system
    // because this is the one place that knows about all of them AND owns the
    // angle step — a pad and a road piece now turn by the same amount, from the
    // same setting.
    for (const sys of [props, movers, portals]) {
      if (!sys.selected) continue;
      if (sys.rotateSelectedBy?.(axis, builder.angleStep * (dir < 0 ? -1 : 1))) {
        const el = document.getElementById("road-status");
        if (el) {
          const q = (sys.selected.root ?? sys.selected).quaternion;
          const e = new THREE.Euler().setFromQuaternion(q, "YXZ");
          const d = (v) => `${v >= 0 ? "+" : ""}${THREE.MathUtils.radToDeg(v).toFixed(1)}°`;
          el.textContent = `Rotated — yaw ${d(e.y)} pitch ${d(e.x)} roll ${d(e.z)}`;
        }
        devPanel?.refresh();
        return;
      }
    }
    const r = builder.nudgeAngle(axis, dir);
    const el = document.getElementById("road-status");
    if (!r.ok) { if (el) el.textContent = `Can't turn: ${r.reason}`; return; }
    bakeCollision();
    devPanel?.refresh();
    if (!el) return;
    const deg = (v) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}°`;
    if (r.target === "section") {
      el.textContent = `Banked a ${r.count}-piece section — pitch ${deg(r.pitch)} ` +
        `roll ${deg(r.roll)} in` +
        (r.levelledAfter ? ", back to level after it" : " (nothing after it to level)");
    } else if (r.target === "piece") {
      el.textContent = `Piece tilt — pitch ${deg(r.pitch)} roll ${deg(r.roll)}` +
        `  (banks the rest of the chain too; L to level)`;
    } else if (r.target === "chain") {
      el.textContent = `Chain anchor — pitch ${deg(r.pitch)} roll ${deg(r.roll)}`;
    } else {
      el.textContent = `Next piece heading ${r.yaw.toFixed(1)}°`;
    }
  }

  /**
   * Flip the placement gizmo between world and local axes (button + X).
   *
   * Local is what you want after a jump: the takeoff heading is whatever the
   * last corner left you with, so in world axes "slide the landing pad further
   * along the flight line" is a mix of two drags with no way to hold the line.
   */
  function toggleGizmoSpace() {
    const space = builder.togglePlacementGizmoSpace();
    syncGizmoSpaceBtn();
    const el = document.getElementById("road-status");
    if (el) {
      el.textContent = space === "local"
        ? "Gizmo axes: LOCAL — blue = along travel, red = sideways, green = up"
        : "Gizmo axes: WORLD — aligned with the build grid";
    }
  }
  function syncGizmoSpaceBtn() {
    const btn = document.getElementById("road-gizmo-space");
    if (btn) btn.textContent = `Axes: ${builder.gizmoSpace === "local" ? "Local" : "World"} (X)`;
  }
  syncGizmoSpaceBtn();

  // Two ways in — the header's "?" and the link under the key legend.
  onClick("road-help", () => setHelp(!isHelpOpen()));
  onClick("road-help-link", () => setHelp(true));
  onClick("build-help-close", () => setHelp(false));
  // Backdrop only: a click that started inside the panel must not close it.
  helpEl()?.addEventListener("pointerdown", (e) => {
    if (e.target === helpEl()) setHelp(false);
  });

  /**
   * Close the gap from the end you are building on to the nearest other open
   * end (button + J). This is how an alternate route rejoins a merge: a chain is
   * a rigid sequence, so nothing you place by hand will land on both ends at
   * once — the link solves for whatever is left over.
   */
  function linkToNearest() {
    const res = builder.linkToNearestEnd();
    const el = document.getElementById("road-status");
    if (res.ok) {
      paletteUi?.refreshStatus?.();
      // Say what it did, including the radius — a legal join can still be too
      // tight to enjoy, and that is the number that tells you.
      if (el) {
        el.textContent = `Joined — closed a ${res.gap.toFixed(0)} m gap` +
          (res.radius < 200 ? `, tightest radius ${res.radius.toFixed(0)} m` : ", straight");
      }
      return;
    }
    if (el) el.textContent = `Can't join: ${res.reason}`;
  }

  /** Flip which END of the active chain the next piece goes on (button + H). */
  function toggleBuildEnd() {
    if (builder.toggleBuildEnd()) {
      paletteUi?.refreshStatus?.();
      return;
    }
    // Same pattern as goToBranch: say WHY nothing happened rather than looking
    // like a dead key. A head that is welded to a junction branch or to another
    // chain's tail is not an open end, so there is nothing to build backwards
    // from — see _openConnectors.
    const el = document.getElementById("road-status");
    if (el) {
      el.textContent = builder.count
        ? "This chain's start is joined to something — nothing to build backwards from"
        : "Nothing placed yet — the first piece has only one end";
    }
  }

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
  _roadLookRef = roadLook;
  /**
   * The pristine baselines a save is diffed against and a load resolves onto.
   *
   * Assembled per call rather than once, because `roadLookDefaults()` is null
   * until the first road material exists — the deck is built during boot, so by
   * the time anything can press Save it is populated, but a ctx captured at
   * module scope would have frozen the null.
   *
   * A null block is not a failure: modularRoadTrackIO falls back to writing
   * that block in full, which is exactly what v1 did.
   */
  const trackDefaults = () => ({
    roadParams: ROAD_PARAM_DEFAULTS,
    guardrailParams: GUARDRAIL_PARAM_DEFAULTS,
    pieceParams: PIECE_PARAM_DEFAULTS,
    portalParams: DEFAULT_PORTAL_PARAMS,
    roadLook: roadLookDefaults(),
  });

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
      defaults: trackDefaults(),
    };
  };

  /**
   * Say out loud what a load did to the track beyond placing its pieces.
   *
   * This exists because the old format's failures were all SILENT: a track came
   * back with a param pinned at a value the build had moved on from, or with a
   * key quietly ignored, and the only symptom was that it drove differently
   * from how you remembered. A load that changes the numbers has to be able to
   * name them.
   */
  function reportTrackLoad(res, label) {
    if (!res?.notes?.length) return;
    for (const n of res.notes) console.info(`[ModularRoad-v3] ${label}: ${n}`);
    if (res.legacyPins?.length && !res.rebased) {
      console.info(
        `[ModularRoad-v3] ${label}: hold Shift while loading to rebase these onto the current build.`,
      );
      console.table(res.legacyPins);
    }
  }

  /**
   * Push the mirror at the material — after any import that touched it.
   *
   * WETNESS GOES THROUGH setRoadWet, not straight at the uniform, because it
   * decides the material CLASS (see the note on `roadMaterial`). The game boots
   * dry on a MeshStandardNodeMaterial, so loading a track or a look file with
   * `wetAmount > 0` used to set a uniform that nothing in that material reads —
   * the track simply rendered dry, with no error and nothing to notice.
   * Rebuild first, then push the rest of the look onto whatever material we
   * ended up with.
   */
  function applyRoadLook() {
    setRoadWet(roadLook.wetAmount ?? 0);
    syncRoadUniforms(roadMaterial, roadLook);
    syncSurfaceV2Uniforms(roadMaterial, surfaceLook);
    syncTubeUniforms(tubeMaterial, roadLook);
    syncPreMirrorDepthTol();
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

  // REBASE opt-in, latched on the button rather than read at load time: the file
  // input's `change` fires whenever the OS dialog closes, by which point no
  // modifier is held any more. Shift+Load means "this old track may take the
  // current build's tuning"; a plain Load never changes a track's shape.
  let loadRebase = false;

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
    // CONSUMED, not just read. The flag is latched on the button and would
    // otherwise stay true for every later load — including one started some
    // other way — so a single Shift+Load would quietly become a mode.
    const rebaseLegacy = loadRebase;
    loadRebase = false;
    const res = importTrack(data, trackCtx(), { rebaseLegacy });
    if (!res.ok) {
      console.warn("[ModularRoad-v3] track load failed:", res.error);
      alert(`Could not load track: ${res.error}`);
      return;
    }
    reportTrackLoad(res, "track");
    applyRoadLook();
    gameSpawn = data.spawn ?? null;
    updateSpawnMarker();
    bakeCollision();
    propPhysics.sync();
    propInstancer.sync();
    // sync() can rebuild the batches, which drops their layer membership.
    applyRailReflectionMembers();
    flags.sync();
    paletteUi.refreshStatus();
  });
  document.body.appendChild(trackFileInput);
  onClick("road-load", (e) => {
    loadRebase = !!e?.shiftKey;
    trackFileInput.click();
  });

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
        reportTrackLoad(out, idleLabel ?? btnId);
        applyRoadLook();
        gameSpawn = data.spawn ?? null;
        updateSpawnMarker();
        bakeCollision();
        propPhysics.sync();
        propInstancer.sync();
        // sync() can rebuild the batches, which drops their layer membership.
        applyRailReflectionMembers();
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
  // ONE preset, deliberately — see the note beside the button in road.html.
  // The five that used to be here (Apex, Rushline, Apex Parkour, Demo, Big
  // circuit) were authored against OLDER roadParams, so pieces loaded from them
  // are built to a cross-section the kit no longer ships. That makes them worse
  // than useless for debugging: you end up measuring a problem the current kit
  // does not have. audittest.json is the current reference track and the one to
  // EDIT when a repro needs new geometry.
  loadPresetTrack("road-preset-audit", auditTrackUrl, "Load audit track");

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

  /**
   * start_new has its entry at the rounded nose tip — poseFromPiece's +2 m lands
   * on the curve against the guardrail. Spawn on the flat stub just before the
   * start line instead.
   */
  function poseFromStartNewPiece(p) {
    _inPos.setFromMatrixPosition(p.connectorIn);
    _outPos.setFromMatrixPosition(p.connectorOut);
    _fwd.copy(_outPos).sub(_inPos);
    if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, -1);
    _fwd.normalize();
    const hw = p.hw ?? roadParams.width / 2;
    const lineDist = startNewLineDist(p.pp ?? {}, hw);
    const backset = p.pp?.gameStartSpawnBackset ?? pieceParams.gameStartSpawnBackset ?? 4;
    const spawnDist = Math.max(hw + 1.5, lineDist - backset);
    return {
      x: _inPos.x + _fwd.x * spawnDist,
      y: _inPos.y,
      z: _inPos.z + _fwd.z * spawnDist,
      yaw: Math.atan2(_fwd.x, _fwd.z) - Math.PI,
    };
  }

  function resolveSpawn() {
    if (gameSpawn) return gameSpawn;
    const startNew = builder.pieces.find((p) => p.id === "start_new");
    if (startNew) return poseFromStartNewPiece(startNew);
    const start = builder.pieces.find((p) => p.id === "start");
    if (start) return poseFromPiece(start);
    if (builder.pieces.length) return poseFromPiece(builder.pieces[0]);
    const sp = app.getSpawnPoint?.() ?? null;
    if (sp) return { x: sp.x, y: sp.y, z: sp.z, yaw: sp.yaw ?? 0 };
    return { x: 0, y: groundBaseY(0, 0), z: 0, yaw: 0 };
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
   * Bake (or rebake) the shared car glyph: spawn marker, spawn brush, lap ghost.
   *
   * Called when the GLB arrives and again when the fit sliders move — those
   * offsets are baked into the vertices, so a stale bake would sit at the old
   * ride height. The previous geometry is disposed only after every user has
   * been swapped off it.
   */
  function applyGhostCarTemplate() {
    const prev = spawnGhostGeo;
    spawnGhostGeo = chassisGlbObject
      ? bakeGhostCarGeometry(chassisGlbObject, {
        hubs: WHEEL_LOCAL,
        radius: WHEEL.radius,
        thickness: WHEEL.thickness,
      })
      : null;
    if (spawnGhostGeo) spawnGhostGeo.userData.sharedTemplate = true;
    rebuildSpawnMarkerCar();
    if (brush?.kind === "spawn") {
      const old = brush.root;
      const next = buildSpawnGhost();
      next.visible = old.visible;
      next.position.copy(old.position);
      next.rotation.copy(old.rotation);
      scene.remove(old);
      if (brush.disposeGeo !== false) {
        old.traverse((o) => {
          if (o.isMesh && !isSharedGeometry(o.geometry)) o.geometry?.dispose();
        });
      }
      scene.add(next);
      brush.root = next;
      brush.disposeGeo = !spawnGhostGeo;
    }
    // Lap ghost is a Mesh, not a clone tree — swap the buffer in place so the
    // pose/visibility already on it stay put. The box fallback is disposed here
    // once the silhouette exists.
    if (spawnGhostGeo && ghostMesh.geometry !== spawnGhostGeo) {
      const oldGeo = ghostMesh.geometry;
      ghostMesh.geometry = spawnGhostGeo;
      if (oldGeo && oldGeo !== prev && !isSharedGeometry(oldGeo)) oldGeo.dispose();
    }
    if (prev && prev !== spawnGhostGeo && ghostMesh.geometry !== prev) prev.dispose();
  }

  /**
   * (Re)build the marker's car silhouette.
   *
   * Called once at boot and AGAIN when the baked glyph is ready or rebaked —
   * the marker is created long before the model arrives, so without the second
   * call it would keep the primitive stand-in for the whole session.
   */
  function rebuildSpawnMarkerCar() {
    if (spawnMarkerCar) {
      spawnMarker.remove(spawnMarkerCar);
      // Only the primitive fallback owns its geometry; the baked glyph is shared
      // with the spawn brush and the lap ghost, and carries the mark that says so
      // (applyGhostCarTemplate) — the same rule every other clone-a-template prop
      // follows, rather than a second per-object flag saying the same thing.
      spawnMarkerCar.traverse((o) => {
        if (o.isMesh && !isSharedGeometry(o.geometry)) o.geometry?.dispose();
      });
    }
    spawnMarkerCar = buildSpawnGhost(SPAWN_MARKER_MAT, "RoadSpawnMarkerCar");
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
    ensureCollision(); // reads the deck tree — see the note on bakeCollision
    if (deckBvh?.baked) {
      const hit = deckBvh.raycastFirst(from, _gapDir, len);
      if (hit) return hit.point;
    }
    // 2) TERRAIN — a heightfield, so a segment test is just the sign change of
    //    (arc y − ground y) at the two ends. No raycast needed, and at ~1.3 m of
    //    arc per segment the linear crossing is well inside the marker's radius.
    //
    //    Sky mode returns null rather than going through terrainH: every test
    //    below is a `<` or `>` against the sampled height, all of which are false
    //    for NaN, so a NaN height would slip past them into the final lerp and
    //    put the landing marker at NaN — an invisible marker, not a missing one.
    if (!terrainOn) return null;
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

  /**
   * The ballistic landing off the chain's open end — solved ON DEMAND.
   *
   * `lastLanding` is a by-product of the render loop, and only when the arc is
   * being drawn. So with "Arc preview" unticked every button that needs a
   * landing did nothing at all and said nothing about why. `update()` is
   * independent of visibility, so ask it directly rather than depending on a
   * checkbox — and turn the preview on, because the answer is worth seeing.
   */
  function solveLanding() {
    // ALWAYS RE-SOLVE. `lastLanding` is a by-product of the render loop and it
    // only updates while the arc is being drawn — so with the preview off it is
    // whatever the open end used to be, which is a plausible-looking number for
    // a completely different jump. Re-solving is a few hundred vec ops.
    if (!gapPreviewOn) {
      gapPreviewOn = true;
      gapPreview.setVisible(true);
      devPanel?.refresh();
    }
    gapPreview.dragK = AERO.drag / CHASSIS.mass;
    lastLanding = gapPreview.update(builder.currentConnector, refSpeed, landingDrop);
    return lastLanding;
  }

  /** Start a new chain on the previewed landing point, heading down-arc. */
  function snapLanding() {
    const landing = solveLanding();
    if (!landing) {
      const el = document.getElementById("road-status");
      if (el) el.textContent = "No landing to snap to — the arc never comes down (check Launch speed)";
      return;
    }
    lastLanding = landing;
    const v = lastLanding.vel;
    // beginNewChain's freeYaw maps to travel = (0,0,-1) rotated by yaw, so this
    // yaw makes the new chain head along the landing's horizontal velocity.
    const yaw = Math.atan2(-v.x, -v.z);
    // EXACT — do not put a computed landing point on the build grid. This is the
    // one place in the editor where the position is physics, not authoring: the
    // grid was rounding it to the nearest 8 m cell and 15°, which put the pad
    // measurably away from where the car comes down (2.95 m and 4.44 m on two
    // ordinary jumps; 5.66 m horizontal and 7.5° worst case). The demo-track
    // builder had always switched snapping off around the same call — this
    // button never did.
    builder.beginNewChain(lastLanding.pos.clone(), yaw, { exact: true });
    if (controls.target) { controls.target.copy(lastLanding.pos); controls.update?.(); }
    builder.refreshGhost?.();
    paletteUi?.refreshStatus?.();
  }

  /**
   * Size the GAP piece from the same solve, and select it.
   *
   * The Gap is the one piece whose size should never be picked off a menu: a
   * ramp's angle is a choice, but a gap's length is a consequence — how far the
   * car actually flies from this lip at this speed. Its kit default is a flat
   * 44 m × 6 m drop, which suits a jump only by luck.
   *
   * ONLY FOR A JUMP THAT FLIES STRAIGHT ON. A gap keeps the chain going in a
   * straight line, so it can only express a landing that is dead ahead. Come off
   * a curve and the car lands off to one side, which no gap length can describe
   * — that is what "Snap landing → new chain" is for, and this says so rather
   * than quietly building a gap to the wrong place.
   */
  function gapToLanding() {
    const el = document.getElementById("road-status");
    const landing = solveLanding();
    if (!landing) {
      if (el) el.textContent = "No landing to measure — the arc never comes down";
      return;
    }
    // IN THE LIP'S OWN FRAME, not the horizontal one. `gapPoints` lays its
    // centreline out as (0, −drop·t², −L·t) in piece-local space, so L runs along
    // the connector's TRAVEL direction — and a ramp's lip is pitched up. Measured
    // horizontally instead, a 137 m gap off a 30° lip climbed 68 m into the sky
    // (measured: the track topped out at 148 m). Local coordinates give L and the
    // drop directly, and the gap's endpoint is then exactly the landing point.
    const local = landing.pos.clone()
      .applyMatrix4(new THREE.Matrix4().copy(builder.currentConnector).invert());
    const along = -local.z;          // down the lip's travel
    const drop = -local.y;           // below it
    const across = Math.abs(local.x); // sideways, which a gap cannot express
    if (along < 1) {
      if (el) el.textContent = "That jump does not clear anything — check Launch speed";
      return;
    }
    if (across > Math.max(2, along * 0.08)) {
      if (el) {
        el.textContent = `That jump lands ${across.toFixed(0)} m off to the side — ` +
          `a gap only goes straight on. Use "Snap landing → new chain".`;
      }
      return;
    }
    // THROUGH THE PALETTE, AND IN THIS ORDER. selectPieceById is the one entry
    // point that also clears the active preset and switches the visible category
    // — `renderPieces` does not clear `activePresetId`, so the status line went
    // on calling this a "Ramp 40" while the piece under the cursor was a gap,
    // which is the exact lie selectPieceById was written to stop.
    // It also resets the params to the kit defaults, so it has to come BEFORE
    // the size is written or the measurement is thrown away.
    if (!paletteUi?.selectPieceById?.("gap")) builder.setActivePiece("gap");
    builder.setGapSize(along, drop);
    if (el) {
      el.textContent = `Gap sized to the jump — ${along.toFixed(0)} m across, ` +
        `${drop.toFixed(0)} m down. Place it, then put a landing after it.`;
    }
  }

  /**
   * Where N / "New chain" should seat the anchor when the user is already
   * building: the exit of the right-clicked selection, else the active chain's
   * open tip. Returns null when neither exists (empty track / no focus) so the
   * caller can fall back to camera look-at or spawn.
   *
   * Offset one snap step along travel so the new chain is next to the seam,
   * not on top of it — still free to yaw / tilt as its own chain.
   */
  function resolveNewChainFocus() {
    const sel = builder.selectedPiece;
    let mat = null;
    if (sel && builder.pieces.includes(sel)) {
      mat = sel.connectorOut;
    } else {
      const tip = [...builder.pieces].reverse().find((p) => p.chainId === builder.activeChainId);
      if (tip) mat = tip.connectorOut;
    }
    if (!mat) return null;

    const e = mat.elements;
    // Travel = −Z column of the connector (same basis beginNewChain / snapLanding use).
    let dx = -e[8], dy = -e[9], dz = -e[10];
    const len = Math.hypot(dx, dy, dz) || 1;
    dx /= len; dy /= len; dz /= len;

    const step = builder.snapStep || 8;
    const pos = new THREE.Vector3().setFromMatrixPosition(mat);
    pos.x += dx * step;
    pos.y += dy * step;
    pos.z += dz * step;
    // Horizontal heading only — new chains start level; yaw matches travel.
    const yaw = Math.atan2(-dx, -dz);
    return { pos, yaw };
  }

  /**
   * Seat a fresh chain for authoring.
   *
   * With `atCursor` (N / New chain button): prefer the selected piece's exit,
   * else the active chain tip, else where the orbit camera is looking.
   * Without it (boot / world load): spawn XZ at terrain + buildHeight.
   *
   * Focus seeds keep the connector's height so a mid-air tip does not drop the
   * new chain back to buildHeight; camera/spawn seeds still float at buildHeight.
   */
  function seedChainAtSpawn({ showGizmo = true, atCursor = false } = {}) {
    let x, y, z, yaw;
    let fromFocus = false;
    if (atCursor) {
      const focus = resolveNewChainFocus();
      if (focus) {
        x = focus.pos.x; y = focus.pos.y; z = focus.pos.z; yaw = focus.yaw;
        fromFocus = true;
      } else if (controls.target) {
        x = controls.target.x; z = controls.target.z; yaw = builder.freeYaw ?? 0;
      } else {
        const s = resolveSpawn();
        x = s.x; z = s.z; yaw = s.yaw;
      }
    } else {
      const s = resolveSpawn();
      x = s.x; z = s.z; yaw = s.yaw;
    }
    if (!fromFocus) y = groundBaseY(x, z) + buildHeight;
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
    failFallTime = 0;
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
    // Same board every run — see ParkourMover.resetPhase.
    movers.resetPhases();
    simAccum = 0;
    // R / void-backstop: full retry. Last-safe recoveries do NOT come through
    // here, so a missed jump still costs time on the live clock.
    if (mode === "drive") {
      run.restart();
      ghost.discard();
      drift.reset();
    }
  }

  const paletteEl = document.getElementById("palette");
  // Hint / shortcuts live in the Mode section of the right-hand panel (temporary
  // until a dedicated menu exists). Looked up AFTER the panel is built below.

  // ── RACE HUD ────────────────────────────────────────────────────────────────
  const hud = document.getElementById("race-hud");
  const hudClock = document.getElementById("race-clock");
  const hudTime = document.getElementById("race-time");
  const hudSub = document.getElementById("race-sub");
  const hudFlash = document.getElementById("race-flash");
  const hudSplit = document.getElementById("race-split");
  const hudResult = document.getElementById("race-result");
  const hudResultTag = document.getElementById("race-result-tag");
  const hudResultTime = document.getElementById("race-result-time");
  const hudResultDelta = document.getElementById("race-result-delta");
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

  /**
   * WRITE A DOM STRING ONLY WHEN IT CHANGES.
   *
   * `updateRaceHud` runs every frame. The live time changes every tick while a
   * run is going; the subline and clock visibility change only on gate events.
   * Assigning the same string still costs, so writes are skipped when unchanged.
   *
   * The last value is cached ON the element rather than in a Map so there is
   * nothing to keep in sync when the HUD is rebuilt — a fresh node simply has no
   * cached value and takes the first write.
   *
   * `segmentDash.js` has done this since it was written, which is why the dash
   * never showed up in the profile while the race HUD beside it did.
   */
  const setText = (el, v) => {
    if (!el || el._lastText === v) return;
    el._lastText = v;
    el.textContent = v;
  };
  const setClass = (el, v) => {
    if (!el || el._lastClass === v) return;
    el._lastClass = v;
    el.className = v;
  };
  const setAttr = (el, name, v) => {
    if (!el) return;
    const k = `_last_${name}`;
    if (el[k] === v) return;
    el[k] = v;
    el.setAttribute(name, v);
  };

  function updateRaceHud(dt) {
    if (!hud) return;
    if (run.hasCourse) {
      // Frozen after finish, 0.000 while armed, live while running.
      const shown = run.running || run.finished ? run.currentTime : 0;
      setText(hudTime, formatRunTime(shown));
      setText(hudSub, run.subLabel);
      let clockCls = "on";
      if (run.finished) {
        clockCls += run.finishIsRecord || (Number.isFinite(run.finishDelta) && run.finishDelta < 0)
          ? " done"
          : " done behind";
      }
      setClass(hudClock, clockCls);
    } else {
      setClass(hudClock, "");
    }

    // Result card stays up until the next start / R. GO! still uses the flash.
    if (run.finished) {
      setClass(hudFlash, "");
      const rec = run.finishIsRecord;
      const d = run.finishDelta;
      let resCls = rec ? "on record" : "on";
      if (Number.isFinite(d)) resCls += d < 0 ? " ahead" : " behind";
      setClass(hudResult, resCls);
      setText(hudResultTag, rec ? "NEW BEST" : "FINISHED");
      setText(hudResultTime, formatRunTime(run.currentTime));
      setText(hudResultDelta, Number.isFinite(d)
        ? `${d < 0 ? "−" : "+"}${Math.abs(d).toFixed(3)}`
        : "");
    } else {
      setClass(hudResult, "");
      if (run.messageTimer > 0 && run.message) {
        setText(hudFlash, run.message);
        setClass(hudFlash, /GO/.test(run.message) ? "show good" : "show");
      } else {
        setClass(hudFlash, "");
      }
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
    setText(hudSpeed, String(Math.round(speedMs * 3.6)));

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
      //
      // Quantised to a tenth before the compare. The raw value is a float that
      // changes every frame the throttle is open, so an exact compare would
      // never skip; a tenth of one percent of a ~100 px arc is a tenth of a
      // pixel, and it makes the attribute hold still whenever the revs do.
      const shown = Math.min(1, g.rpm);
      setAttr(hudGaugeVal, "stroke-dashoffset", (100 - shown * 100).toFixed(1));
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
        setText(hudDriftPts, drift.pending.toLocaleString());
        setText(hudDriftMul, `x${drift.multiplier}`);
        setClass(hudDriftBank, driftBankFlash > 0 ? "show" : "");
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

  /**
   * DRAW THE WHOLE TRACK ONCE, BEHIND A COVER, BEFORE THE FLAG DROPS.
   *
   * ── THE BUG ──────────────────────────────────────────────────────────────
   * WebGPU builds a render pipeline the FIRST TIME an object is actually drawn
   * and caches it for the life of the page. The engine warms up at boot
   * (v3/app/main.js calls renderer.compileAsync) — but the track does not exist
   * yet at that point, and `buildMergedTrack()` has just created brand-new
   * meshes it has never seen. So every merged chunk, rail, prop and car
   * material paid its compile on the first frame it became VISIBLE, mid-race.
   *
   * On audittest that landed at the tube. Inside the bore almost nothing else
   * is on screen (measured: 23 draws inside against 42+ in the open); coming
   * round the last curve toward `tube_out` reveals a straight corridor, a slope,
   * a loop 184 m away and an emissive boost decal all at once. MEASURED: 20
   * pipelines compiled on that single frame, which took 1052 ms.
   *
   * It matched the report exactly — always the same spot (that is where the
   * reveal happens), only on the first run after a refresh (pipelines are
   * cached afterwards), and gone after R (restarting the race does not toggle
   * the mode, so the merged meshes and their pipelines survive).
   *
   * ── TWO THINGS THAT DO NOT WORK, BOTH MEASURED ───────────────────────────
   *  1. `renderer.compileAsync(scene, camera)`. Tried first; it compiled 45
   *     pipelines at the transition and the tube frame STILL compiled its 20.
   *     A pipeline is per material PER RENDER-PASS STATE, and compileAsync only
   *     prepares the default pass — the labels showed the same material
   *     (PropPlainVertex, brakeLight, mm_windows) compiling more than once,
   *     which is the emissive/MRT variants it never reaches.
   *  2. Warming into an offscreen RenderTarget, to dodge the flicker. It
   *     compiled 38 pipelines into the target and the canvas route then
   *     compiled its 16 + 20 anyway: pipelines are keyed to the target's
   *     format, so a warm-up only counts if it renders to the REAL canvas.
   *
   * So this draws to the canvas and hides it behind an opaque cover. Measured
   * after: ZERO pipelines compiled anywhere on the route, worst frame 7.2 ms
   * against 1052 ms.
   *
   * Only the first entry into drive mode is slow (~2.5 s); later ones re-render
   * the same poses in a few ms because the pipelines are already cached, so
   * this deliberately does not try to detect "already warm".
   */
  let warmingUp = false;
  async function warmUpTrackPipelines() {
    if (warmingUp) return;
    const pieces = builder.pieces ?? [];
    if (!pieces.length) return;
    warmingUp = true;
    // A CLONE, so the live chase camera is never touched — the engine's own
    // frame loop keeps rendering the real view underneath the cover.
    const warmCam = camera.clone();
    const cover = document.createElement("div");
    cover.className = "road-warmup-cover";
    cover.textContent = "Preparing track…";
    document.body.appendChild(cover);
    const _p = new THREE.Vector3();
    const _f = new THREE.Vector3();
    try {
      // Yield once so the cover actually paints before the canvas starts
      // flashing through the track behind it.
      await new Promise((res) => requestAnimationFrame(() => res()));
      // EVERY piece gets a pose, not a strided sample. Striding to 14 was tried
      // and measured: 6 pipelines still compiled mid-route, because a material
      // that appears on only one piece is invisible from every pose that skips
      // it. Poses are cheap once the pipelines exist (a few ms), so the cost of
      // being exhaustive is paid only on the first entry. Capped so a
      // pathological 500-piece track cannot stall for a minute.
      const MAX_POSES = 60;
      const stride = Math.max(1, Math.ceil(pieces.length / MAX_POSES));
      for (let i = 0; i < pieces.length; i += stride) {
        const m = pieces[i].connectorIn;
        _p.setFromMatrixPosition(m);
        // -Z is travel, matching socketMatrix; stand back and look along it so
        // the frame contains the piece AND whatever it leads to.
        _f.set(0, 0, -1).transformDirection(m);
        warmCam.position.copy(_p).addScaledVector(_f, -12).setY(_p.y + 5);
        warmCam.lookAt(_p.x + _f.x * 40, _p.y + _f.y * 40, _p.z + _f.z * 40);
        warmCam.updateMatrixWorld(true);
        renderer.render(scene, warmCam);
        // YIELD BETWEEN POSES, but with a TASK and not requestAnimationFrame.
        // Without a yield at all this is one ~2.5 s blocking turn and the cover
        // never even paints. With rAF it becomes hostage to frame pacing: in a
        // backgrounded or occluded tab rAF drops to ~1 Hz, and the same warm-up
        // measured 13.7 s instead of 2.5 s. Pipelines are built by render()
        // itself, so there is nothing here that needs to wait for a frame.
        await new Promise((res) => setTimeout(res, 0));
      }
      // One overhead pass for anything the ground-level poses cannot see —
      // undersides, scenery, and props parked off the racing line.
      const bounds = new THREE.Box3().setFromObject(mergedGroup.visible ? mergedGroup : builder.root);
      if (!bounds.isEmpty()) {
        const c = bounds.getCenter(new THREE.Vector3());
        const size = bounds.getSize(new THREE.Vector3());
        warmCam.position.set(c.x, c.y + Math.max(size.x, size.z) * 0.9 + 40, c.z + 0.01);
        warmCam.lookAt(c.x, c.y, c.z);
        warmCam.updateMatrixWorld(true);
        renderer.render(scene, warmCam);
        await new Promise((res) => setTimeout(res, 0));
      }
    } catch (e) {
      // A warm-up is an optimisation. If it fails the game still runs, it just
      // stutters once on first reveal — never let it take the race down.
      console.warn("[road] pipeline warm-up skipped:", e);
    } finally {
      cover.remove();
      warmingUp = false;
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
      // THE CAR IS ABOUT TO READ THE TREE, so this is where a deferred edit is
      // finally paid for — see the note on bakeCollision. Deliberately here and
      // not in `frame()`: the vehicle holds the ground adapter directly, so a
      // stale tree would be a car falling through the road rather than an
      // obvious error.
      ensureCollision();
      // Shader first, so a first neon-arm / wet combo compiles the pre-mirror
      // sample before the merge bakes the track in that material. The merge
      // itself rebuilds the mirrored copies (applyRailReflectionMembers).
      syncRoadMaterialFeatures();
      setMergedTrack(true); // ~4 draws for the whole track instead of ~1/piece
      // Clear the piece selection BEFORE hiding the helper. deselectPiece is
      // a build-mode act ("hand the gizmo back to the open end"), so doing it
      // after setGhostVisible(false) used to attach() the arrows back onto the
      // chain for the whole race. Hide last, so even that restore cannot stick.
      builder.deselectPiece?.();
      builder.setGhostVisible(false);
      builder.deselectPlacement?.();
      // THE PRE-MIRROR CONTENT IS BUILT HERE, not while editing — the pass
      // is drive-only, so this is the first moment it can be seen. Sits beside
      // the merged-track build because it is the same kind of cost, paid at the
      // same transition, and neither is paid per edit any more.
      syncPreMirrored();
      warmUpTrackPipelines();
      props.deselect();
      movers.deselect();
      vehicle.enabled = true;
      if (vehicle.group) vehicle.group.visible = true;
      respawn();
      beginRace(); // gates from the current track + load its record
    } else {
      setMergedTrack(false); // back to editable pieces
      // ...and freed here, for the same reason. Nothing in build mode samples it.
      syncPreMirrored();
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
  // BOOTING IS NOT AN EDIT. Seeding the anchor commits, so without this a fresh
  // editor opened with a step already on the undo stack and the very first
  // Ctrl+Z — before the user had done anything at all — yanked the build anchor
  // back to the origin. Same rule as loading a track (see resetHistory).
  builder.resetHistory();
  bakeCollision();
  // The notify that fired during the builder's own construction was skipped by
  // the TDZ guard, so this is the first chance the posts get. Everything after
  // boot comes through onChange.
  rebuildRailPosts();
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
    params: {
      TIRE, AERO, ROAD_HOLD, DRIVETRAIN, DECK, SOLID, BODYLEAN, HEADLIGHTS, CHASSIS_GLB_LIGHTS,
      WHEEL_LAYOUT, DRIFT, glowPropParams,
    },
    game: {
      /** Volumetric clouds. Off releases every buffer and runs no pass. */
      setClouds: (on) => clouds.setEnabled(!!on),
      getClouds: () => clouds.enabled,
      /** Sky mode: terrain hidden, not solid, heights measured from y=0. */
      setTerrain,
      getTerrain: () => terrainOn,
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
          hasAdvert: !!s.def?.advert,
          advertFaces: s.def?.advertFaces || (s.def?.advert ? 1 : 0),
          hasAdvertImage: Array.isArray(s.advert) ? s.advert.some(Boolean) : !!s.advert,
          advertSlots: Array.isArray(s.advert)
            ? [0, 1, 2].map((i) => !!s.advert[i])
            : [!!s.advert, false, false],
        };
      },
      setPropVariant: (i) => props.setSelectedVariant(i),
      setPropDecal: (on) => props.setSelectedDecal(on),
      setPropAdvertFile: (file, face) => props.setSelectedAdvertFile(file, face),
      clearPropAdvert: (face) => props.setSelectedAdvert(null, face ?? 0),
      randomisePropVariants: () => props.randomiseVariants(props.selected?.id ?? null),
      getMode: () => mode,
      toggleMode,
      respawn,
      bakeCollision: bakeCollisionNow,
      rebakeThumbnails,
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
      applyWheelLayout: () => {
        vehicle.applyWheelLayout();
        applyGhostCarTemplate();
      },
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
        applyGhostCarTemplate();
      },
      resetChassisFit: () => {
        const r = resetChassisGlbFit(chassisGlbObject);
        vehicle.setHeadlampMounts(chassisGlbMounts(chassisLampsLocal));
        applyGhostCarTemplate();
        return r;
      },
      hasWheelModel: () => vehicle.hasWheelModel,
      setInstancing: (on) => builder.setInstancing(on),
      // Piece editing (also on right-click select + W/E/L/Del/Enter/I).
      getSelectedPieceId: () => builder.selectedPiece?.id ?? null,
      deselectPiece: () => { builder.deselectPiece(); paletteUi.refreshStatus(); },
      deleteSelected: () => {
        builder.deleteSelected();
        paletteUi.refreshStatus();
      },
      replaceSelected: () => {
        builder.replaceSelected(builder.activePieceId);
        paletteUi.refreshStatus();
      },
      insertBeforeSelected: () => {
        if (builder.selectedPiece) builder.insertPieceBefore(builder.selectedPiece, builder.activePieceId);
        paletteUi.refreshStatus();
      },
      getSelectedTilt: () =>
        builder.selectedPiece ? builder.pieceTiltDeg(builder.selectedPiece) : { pitch: 0, roll: 0 },
      // The whole selection, not just the anchor — the dev panel's buttons
      // should mean the same thing the keys do.
      levelSelected: () => { builder.levelSelected(); },
      getSelectedEdges: () => builder.selectedPiece?.edges ?? true,
      toggleSelectedEdges: () => {
        const any = builder.selectedPieces.some((p) => p.edges !== false);
        builder.setSelectedEdges(!any);
      },
      isSelectedDetached: () => !!builder.selectedPiece?.detached,
      toggleSelectedDetached: () => {
        const sp = builder.selectedPiece;
        if (!sp) return;
        if (sp.detached) builder.attachPiece(sp);
        else { builder.detachPiece(sp); builder.rebuildAll({ reuse: true }); }
      },
      isSelectedGap: () => builder.selectedPiece?.id === "gap",
      makeSelectedGap: () => {
        // FLAT empty-space spacer sized to the piece (level hole, downstream
        // unmoved). Reversible: gaps stay selectable, so replace to fill it in.
        if (builder.selectedPiece) builder.makeGap(builder.selectedPiece);
        paletteUi.refreshStatus();
      },
      // A GETTER, not a snapshot: the weather slider can replace the whole
      // material (see applyRoadMaterial), and a captured uniform bag would go on
      // pointing at the discarded one — every road control in the panel would
      // silently stop working the first time you crossed 0.
      get roadUniforms() { return roadMaterial._roadUniforms; },
      railMaterial,
      // ── Weather ──────────────────────────────────────────────────────────
      setWet: setRoadWet,
      getWet: () => roadMaterial._roadUniforms.wetAmount.value,
      setPuddles: (v) => {
        roadLook.puddleAmount = v;
        roadMaterial._roadUniforms.puddleAmount.value = v;
      },
      getPuddles: () => roadMaterial._roadUniforms.puddleAmount.value,
      setBump: (v) => setSurfaceParam("bumpAmount", Math.max(0, v || 0)),
      getBump: () => surfaceLook.bumpAmount,
      setStreakSharp: (v) => setSurfaceParam("streakSharp", Math.max(0, Math.min(1, v ?? 0))),
      getStreakSharp: () => surfaceLook.streakSharp,
      setJointSpacing: (v) => setSurfaceParam("jointSpacing", Math.max(0, v || 0)),
      getJointSpacing: () => surfaceLook.jointSpacing,
      setSurface,
      getSurface,
      setLook,
      getLook,
      setRoadFrontSide,
      getRoadFrontSide: () => roadFrontSide,
      setCheapRoad,
      getCheapRoad: () => cheapRoad,
      setWheelClear: (v) => {
        roadLook.wetWheelClear = v;
        roadMaterial._roadUniforms.wetWheelClear.value = v;
      },
      getWheelClear: () => roadMaterial._roadUniforms.wetWheelClear.value,
      setReflectStrength: (v) => {
        roadLook.reflectStrength = v;
        roadMaterial._roadUniforms.reflectStrength.value = v;
      },
      getReflectStrength: () => roadMaterial._roadUniforms.reflectStrength.value,
      setReflectFlat: (v) => {
        roadLook.reflectErrTol = v;
        roadMaterial._roadUniforms.reflectErrTol.value = v;
      },
      getReflectFlat: () => roadMaterial._roadUniforms.reflectErrTol.value,
      setReflectPlane: (v) => {
        roadLook.reflectPlaneTol = v;
        roadMaterial._roadUniforms.reflectPlaneTol.value = v;
      },
      getReflectPlane: () => roadMaterial._roadUniforms.reflectPlaneTol.value,
      setReflectSlab: (v) => { carReflection.slab = v; },
      getReflectSlab: () => carReflection.slab,
      setRailReflect: (v) => {
        roadLook.railReflect = v;
        roadMaterial._roadUniforms.railReflect.value = v;
      },
      getRailReflect: () => roadMaterial._roadUniforms.railReflect.value,
      setReflection: (on) => {
        reflectionEnabled = !!on;
        if (!on && roadMaterial._reflectUniforms) {
          roadMaterial._reflectUniforms.reflectOn.value = 0;
        }
        syncPreMirrored();
      },
      setRailsInMirror: (on) => setRailsInMirrorFlag(on),
      // The panel seeds its checkbox from this. Without it the seed falls back
      // to a literal and the box can disagree with the flag — which is exactly
      // the bug that made the toggle look inert.
      getRailsInMirror: () => railsInMirror,
      getLinesOn: () => roadMaterial._roadUniforms.linesOn.value > 0.5,
      setLinesOn: (on) => {
        const v = on ? 1 : 0;
        roadMaterial._roadUniforms.linesOn.value = v;
        roadLook.linesOn = v;
      },
      getCenterLinesOn: () => roadMaterial._roadUniforms.centerOn.value > 0.5,
      setCenterLinesOn: (on) => {
        const v = on ? 1 : 0;
        roadMaterial._roadUniforms.centerOn.value = v;
        roadLook.centerOn = v;
      },
      getEdgeLinesOn: () => roadMaterial._roadUniforms.edgeOn.value > 0.5,
      setEdgeLinesOn: (on) => {
        const v = on ? 1 : 0;
        roadMaterial._roadUniforms.edgeOn.value = v;
        roadLook.edgeOn = v;
      },
      getLinesBloom: () => roadMaterial._roadUniforms.linesBloom.value > 0.5,
      setLinesBloom: (on) => {
        const v = on ? 1 : 0;
        roadMaterial._roadUniforms.linesBloom.value = v;
        roadLook.linesBloom = v;
      },
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
      gapToLanding,
      // Race
      setRaceRespawn: (on) => { raceRespawn = !!on; },
      getRaceRespawn: () => raceRespawn,
      getShowRaceGhost: () => showRaceGhost,
      setShowRaceGhost: (on) => {
        showRaceGhost = !!on;
        if (!showRaceGhost) ghostMesh.visible = false;
      },
      clearRecord,
      getBestTime: () => run.bestTime,
      getBestLap: () => run.bestTime,
      getTimeScale: () => timeScale,
      setTimeScale: (s) => { timeScale = Math.max(0, +s || 0); },
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
  // Physics advances only in whole FIXED_DT ticks so handling, race times and
  // ghosts stay framerate-independent; visuals interpolate the leftover.
  // timeScale is the slow-mo contract: 1 = realtime. Later, hold-to-slow-mo
  // sets this to ~0.3; race time is += FIXED_DT per tick so the HUD clock
  // slows with the world. Do not change FIXED_DT itself.
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
      simAccum += dt * timeScale;
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
        // The car's pose is what CALLS an elevator — see ParkourMover._updateLift.
        movers.update(FIXED_DT, vehicle.body.pos);
        if (hasMovers) {
          // The ONLY per-tick collision work the movers need. Their BVHs read
          // `matrixWorld` live, so refreshing the poses IS the update — there is
          // no bake left to do. Only the movers' subtree is re-transformed:
          // scene.updateMatrixWorld would walk the whole world (terrain,
          // foliage, props) every tick to pick up a couple of platforms.
          movers.group.updateMatrixWorld(true);
        }
        vehicle.tick(input);
        if (vehicle.hitSolid) hitSolidThisFrame = true;
        // Same per-tick pulse, same reason it has to be OR-ed across the frame.
        if (vehicle.roofImpact) roofHitThisFrame = true;
        props.applyFields(vehicle, FIXED_DT);      // boost pads etc.
        propPhysics.tick(FIXED_DT, vehicle);       // cones, gates
        portals.updateDrive(FIXED_DT, vehicle);

        // Timing runs INSIDE the fixed tick so splits/race times are quantised to
        // the deterministic clock (framerate-independent records).
        const ev = run.update(FIXED_DT, vehicle.body.pos, vehicle.body.vel);
        if (ev) handleRunEvent(ev);
        if (run.running) ghost.record(run.currentTime, vehicle.body.pos, vehicle.body.quat);
        trackSafePose(); // remember where we were last grounded on the track
      }
      const renderAlpha = simAccum / FIXED_DT;
      vehicle.syncVisuals(dt, renderAlpha);

      // FX are cosmetic, so they run once per FRAME on real dt (not per tick) —
      // they must not affect the deterministic outcome.
      tireMarks.update(vehicle);
      driftSmoke.updateFromVehicle(vehicle, camera, dt, keys);
      sparks.updateFromVehicle(vehicle, camera, dt);
      // Render-rate, not the fixed step: the wave is purely visual and this only
      // advances a uniform — the flags themselves cost no CPU per frame.
      flags.update(dt);
      updateDynamicDebug(); // live collider wireframes, when they are switched on

      checkFall(dt); // air-stunt: dropped off the track → last safe / spawn

      // Ghost replay: same RENDER clock as the live car (last tick + leftover),
      // not discrete `run.currentTime`. Posing on the tick clock hitch-steps
      // whenever a frame runs 0 or 2 physics ticks.
      if (showRaceGhost && run.running && ghost.hasGhost) {
        const ghostT = Math.max(0, run.currentTime + (renderAlpha - 1) * FIXED_DT);
        if (ghost.sampleAt(ghostT, _ghostPos, _ghostQuat)) {
          ghostMesh.position.copy(_ghostPos);
          ghostMesh.quaternion.copy(_ghostQuat);
          ghostMesh.visible = true;
        }
      } else if (ghostMesh.visible) {
        ghostMesh.visible = false;
      }

      updateRaceHud(dt);

      // Keep the engine's terrain clipmap streaming around the car. The chase
      // rig owns camera.position/up, but `controls.target` is what the engine
      // centres terrain on, so it has to track the car too. Use the render pose
      // (matches the camera) so nothing stair-steps.
      controls.target.copy(vehicle.renderPos);
    } else {
      // MOVERS RUN IN BUILD MODE TOO. They used to sit frozen at their start
      // pose, which makes an elevator's travel and a pendulum's swing — the two
      // things you are actually placing — invisible until you hit drive. Purely
      // visual here: no collision work, because there is no car. `respawn()`
      // puts every phase back so a run still starts from the authored board.
      // (Portals had the same omission; the fix is the line below theirs.)
      movers.update(dt);

      // Refresh the jump arc from the current open connector. Cheap
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

  // The mirror has to be rendered BEFORE the scene that samples it, and roadGame
  // runs its own rAF for the sim rather than owning the draw — so it hangs off
  // v3's pre-render hook, which fires immediately before worldEnv renders the
  // frame. Registering it in `tick` instead would project the PREVIOUS frame's
  // mirror onto a camera that has already moved.
  /**
   * A TRANSFORM GIZMO IS IN THE SCENE ONLY WHILE IT IS IN USE.
   *
   * There are five TransformControls on this canvas — the road builder's
   * placement gizmo, plus one each for props, movers and portals, plus the v3
   * editor's own — and every one of them adds its helper to the scene at
   * construction and never takes it out again. Each helper is ~78 objects, so
   * they are 390 of the scene's 1015 nodes: 38% of the graph, permanently.
   *
   * `visible = false` does NOT make them free, and the reason is worth stating
   * because it is the whole point of this. `Object3D.updateMatrixWorld` recurses
   * into children regardless of visibility, and BOTH of TransformControls'
   * overrides — `TransformControlsRoot.updateMatrixWorld` and
   * `TransformControlsGizmo.updateMatrixWorld` — run their full per-frame work
   * with no visibility guard at all: matrix decomposes, a camera update, an eye
   * vector, and then a loop over every handle of the current mode setting its
   * position, quaternion and scale. Five hidden gizmos did all of that on every
   * frame of every lap.
   *
   * Measured (profiling a 48 s drive on rushline): `scene.updateMatrixWorld()`
   * costs 0.592 ms with them attached and 0.246 ms without — about 0.35 ms a
   * frame, or ~2.3% of the ~15.4 ms of JS this game spends per frame, for
   * objects nobody can see. It showed up in the trace as `updateMatrixWorld`
   * being the single largest self-time entry in the whole profile (5.5%), with
   * TransformControls' own override a further 2.2%.
   *
   * `_root.visible` is the exact signal, and it is not the same thing as the
   * `gizmo.visible = …` those four systems write: TransformControls has no
   * `visible` property, so those assignments land on the Controls object and are
   * read by nothing. `attach()` sets `_root.visible = true` and `detach()` sets
   * it false, so the root's own flag is what actually tracks "in use" — which is
   * why this reads that rather than trusting the callers.
   *
   * Done generically, from the scene, instead of in each of the four systems:
   * the rule is a property of TransformControls, not of any one tool, and this
   * way it also covers the engine's gizmo without reaching into v3.
   *
   * Detaching cannot break interaction. Both pointer handlers return early on
   * `this.object === undefined`, which is precisely the state in which the root
   * is out of the scene.
   */
  scene.traverse((o) => { if (o.isTransformControlsRoot) gizmoRoots.push(o); });
  function syncGizmoAttachment() {
    for (const root of gizmoRoots) {
      if (root.visible) { if (!root.parent) scene.add(root); }
      else if (root.parent) root.parent.remove(root);
    }
  }
  // Registered BEFORE the mirror pass so the graph is settled before anything
  // renders from it, and on the pre-render hook rather than in `frame()`
  // because roadGame's sim runs on its own rAF — only this hook is guaranteed
  // to fire after the edit that attached a gizmo and before the draw that
  // would need it.
  syncGizmoAttachment();
  app.addPreRenderHook?.(syncGizmoAttachment);

  lightReflectionAll();
  applyCarReflectionMembers();
  applyRailReflectionMembers();
  app.addPreRenderHook?.(updateCarReflection);

  onStatus("ready");

  // Cold cache (or ?rebake=1): bake now that the editor is up and drawing. Two
  // frames of slack first so the bake's GPU readbacks queue behind a frame that
  // has actually been presented — starting it here rather than above is the
  // difference between "the palette fills in while you look at it" and "the
  // loading screen sits there for a few seconds".
  if (!thumbsWereCached) {
    requestAnimationFrame(() => requestAnimationFrame(() => { bakeAndCacheThumbnails(); }));
  }

  const handle = {
    app,
    builder,
    vehicle,
    props,
    movers,
    portals,
    bakeCollision: bakeCollisionNow,
    respawn,
    toggleMode,
    get mode() { return mode; },
    world: boot,
    /** Volumetric clouds on/off. OFF is free: every render target is released, no pass
     *  runs, and the noise bake never starts until the first enable. */
    setClouds: (on) => clouds.setEnabled(!!on),
    getClouds: () => clouds.enabled,
    /** Sky mode — terrain hidden, not solid, and not paid for. A track saved in
     *  sky mode is just a track; this is a runtime mode, not track data. */
    setTerrain,
    getTerrain: () => terrainOn,
    /** Cloud density at a world point (0 until the bake lands) — for HUD/audio rules. */
    cloudDensityAt: (x, y, z) => clouds.densityAt(x, y, z),
    cloudParams: clouds.params,
    /** Surface look as plain JSON — the same object a track save carries and
     *  road-piece-lab.html exports. */
    /** What the mirror is allowed to see, and whether it runs at all. */
    setReflection: (on) => {
      reflectionEnabled = !!on;
      if (!on && roadMaterial._reflectUniforms) {
        roadMaterial._reflectUniforms.reflectOn.value = 0;
      }
      syncPreMirrored();
    },
    getReflection: () => reflectionEnabled,
    setRailsInMirror: (on) => setRailsInMirrorFlag(on),
    getRailsInMirror: () => railsInMirror,
    /** Half-height of the mirror's clipping slab, metres — see
     *  modularRoadReflection.js. The knob for inverted reflections on slopes. */
    setReflectSlab: (v) => { carReflection.slab = v; },
    getReflectSlab: () => carReflection.slab,
    /** The mirror itself — exposed for the same reason the lab exposes it: when
     *  a reflection is missing, "the target is empty", "the projection lands off
     *  the edge" and "it is there but multiplied to nothing" look identical on
     *  screen and have completely different fixes. */
    carReflection,
    get roadMaterial() { return roadMaterial; },
    /** Master weather, 0..1. Rides ROAD_LOOK, so a track saves its own. */
    setWet: setRoadWet,
    getWet: () => roadMaterial._roadUniforms.wetAmount.value,
    setBump: (v) => setSurfaceParam("bumpAmount", Math.max(0, v || 0)),
    getBump: () => surfaceLook.bumpAmount,
    setStreakSharp: (v) => setSurfaceParam("streakSharp", Math.max(0, Math.min(1, v ?? 0))),
    getStreakSharp: () => surfaceLook.streakSharp,
    setJointSpacing: (v) => setSurfaceParam("jointSpacing", Math.max(0, v || 0)),
    getJointSpacing: () => surfaceLook.jointSpacing,
    setSurface,
    getSurface,
    setLook,
    getLook,
    setRoadFrontSide,
    getRoadFrontSide: () => roadFrontSide,
    setCheapRoad,
    getCheapRoad: () => cheapRoad,
    getRoadLook: () => readRoadLook(roadMaterial),
    setRoadLook: (l) => {
      Object.assign(roadLook, l ?? {});
      applyRoadLook();
    },
  };
  window.__roadGame = handle; // console debugging (window.__road is just the engine app)
  return handle;
}
