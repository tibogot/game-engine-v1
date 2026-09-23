/**
 * THE ENGINE, AS A GAME SEES IT.
 *
 *   import { startV3App, createLevelLoader } from "../../v3/engine.js";
 *
 *   const app = await startV3App({ container: document.getElementById("game") });
 *   const levels = createLevelLoader(app, { defaultUrl: "/games/my-game/level.v3proj" });
 *   await levels.loadBoot();
 *   // gameplay on top: app.scene, app.camera, app.getWorldHeight, app.addPreRenderHook…
 *
 * `app` is documented where it is built — the "App handle" block at the end of
 * v3/app/main.js: scene/camera/controls/renderer, terrain queries
 * (getWorldHeight, getWorldNormal, getWaterLevelAt, getRiverChannels, pickWorldAtClient,
 * heightTexNode + maxHeight + worldSize), the environment (environment, light,
 * sky, fog, shadows, postFx, clouds, envSky, lensFlare), level data (propStore,
 * treeEnv, lakeSystem, getSpawnPoint, collectibles), flattenArea, terrain
 * visibility and pre-render hooks. games/empty-game/ is the starter.
 *
 * Boot options (startV3App): container, environment (false = bring your own),
 * csm, light, terrainFeatures, splatFeatures, preloadPaintTextures,
 * projectWorldLook. (`editor: true` is the editor page's alone.)
 *
 * WHAT A GAME MAY IMPORT FROM THE ENGINE. This file, plus the building blocks
 * listed in PUBLIC_ENGINE_MODULES below — shading and rendering helpers,
 * vehicle physics, prop builders. Everything else under v3/ is engine
 * internals that may change without notice; tools/gameImportBoundaryTest.mjs
 * fails when a game reaches past this list. Adding a module to the list is
 * fine — it is a decision to keep that module's exports stable, made on
 * purpose instead of by accident.
 *
 * Those building blocks are imported by their own path, not re-exported here:
 * lab pages use them without booting the engine, and a re-export would make
 * every lab load the whole engine in the dev server.
 */
export { startV3App } from "./app/main.js";
export { createLevelLoader, terrainSizeDiffers } from "./io/levelLoader.js";
export { WORLD_SIZE, HEIGHTMAP_SIZE, MAX_HEIGHT } from "./terrain/heightmapTexture.js";

/** Repo-relative paths games may import directly (see above). */
export const PUBLIC_ENGINE_MODULES = [
  // The editor stylesheet — game dev panels reuse its look
  "v3/styles/editor.css",
  // Rendering helpers
  "v3/render/layers.js",
  "v3/render/bloomMRT.js",
  "v3/render/instancePipeline.js",
  "v3/render/gpuStatsPanel.js",
  "v3/render/clouds/dayNightCloudLayer.js",
  // Sky — the atmosphere dome and its Hillaire model (moved out of modular-road
  // 2026-09-18; the game still drives its own instance, the editor has a mode for it)
  "v3/render/sky/atmosphereSkyDome.js",
  "v3/render/sky/skyAtmosphere.js",
  "v3/render/sky/skyEnvProbe.js",
  "v3/render/sky/cloudSkyLight.js",
  "v3/render/sky/skyWorldLight.js",
  "v3/render/sky/skyLensFlareLook.js",
  "v3/render/noise/periodicPerlin.js",
  // Cloud decks — the game's two tiers, moved into the engine 2026-09-18 so the
  // editor's Atmosphere sky mode draws the same clouds the game does
  "v3/render/clouds/volumetricCloudDeck.js",
  "v3/render/clouds/paintedCloudDeck.js",
  "v3/render/clouds/cloudShadowMap.js",
  "v3/render/clouds/cloudNoise.js",
  "v3/render/water/lakeMaterial.js",
  "v3/render/water/worldOceanV2.js",
  "v3/render/roads/wetRoad.js",
  "v3/props/liveProps.js",
  // RTS object kit: structures built from the shared parts (a game places them)
  "v3/render/objects/rtsQuonset.js",
  "v3/render/objects/rtsFirebaseProps.js",
  "v3/render/objects/rtsBuildables.js",
  "v3/render/objects/rtsVehicles.js",
  "v3/render/objects/rtsColonial.js",
  "v3/render/objects/rtsEnemyKit.js",
  "v3/render/objects/rtsVillage.js",
  "v3/render/objects/rtsTemple.js",
  "v3/render/objects/rtsVillageHut.js",
  "v3/render/objects/rtsHut.js",
  "v3/render/objects/rtsSigns.js",
  "v3/render/objects/rtsObjectProps.js",
  "v3/render/objects/rtsParts.js",
  "v3/render/objects/rtsStencils.js",
  "v3/render/objects/rtsTextures.js",
  // Vehicle physics (also drives the editor's play-mode cars)
  "v3/play/modularRoadVehicle.js",
  "v3/play/modularRoadBvh.js",
  "v3/play/modularRoadRigidBvh.js",
  "v3/play/modularRoadGround.js",
  // Still in v2 — to move into v3 (AUDIT #104)
  "v2/core/foliage/glbLoader.js",
  "v2/objects/shared/ledMatrix.js",
  "v2/objects/ledMatrix.js",
  "v2/objects/billboard.js",
  "v2/objects/streetLamp.js",
  "v2/objects/roadLamp.js",
  "v2/objects/floodlight.js",
  "v2/objects/chainLinkFence.js",
  "v2/objects/barbWire.js",
  "v2/objects/powerLine.js",
  "v2/objects/stringLights.js",
  "v2/objects/windmill.js",
];
