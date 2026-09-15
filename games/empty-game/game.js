// Starter game — boots the v3 engine as a game, loads a level, and either uses
// the engine's environment or brings its own. Copy this folder to start one.
//
// Everything a game does with the world goes through the `app` handle that
// startV3App returns (see the end of v3/app/main.js).
import * as THREE from "three";
import { startV3App } from "../../v3/app/main.js";
import { decodeProjectFile, isProjectFile } from "../../v3/io/projectIO.js";
import { saveTerrainConfig, HEIGHTMAP_SIZE, WORLD_SIZE, MAX_HEIGHT } from "../../v3/terrain/heightmapTexture.js";
import { stashPendingHeightmap } from "../../v3/io/pendingLoad.js";

const DEFAULT_WORLD = "/games/rts-v3/rts.v3proj";

export async function startGame({ container, onStatus = () => {} } = {}) {
  const params = new URLSearchParams(location.search);
  const ownEnvironment = params.get("env") === "none";

  onStatus("Starting engine…");
  const app = await startV3App({
    // The engine draws into this element; the page needs nothing from the editor.
    container,
    // Not the editor: no editor shortcuts, camera, panels or selection.
    // environment: false → no engine sky, lights, shadows, fog, ocean, post FX.
    environment: !ownEnvironment,
    terrainFeatures: { cursor: false },
    splatFeatures: { solo: false },
    preloadPaintTextures: false,
  });

  if (ownEnvironment) addOwnEnvironment(app);

  onStatus("Loading level…");
  const world = params.get("world") ?? DEFAULT_WORLD;
  const loaded = await loadLevel(app, world);

  // A plain orbit camera: the game owns `controls` (the editor camera is off).
  app.controls.enableZoom = true;
  app.camera.position.set(0, 260, 520);
  app.controls.target.set(0, 20, 0);
  app.controls.update();

  const hud = document.getElementById("hud");
  if (hud) {
    hud.textContent = `${loaded ? world.split("/").pop() : "default terrain"} · environment: ${app.environment.enabled ? "engine" : "own"} · drag to orbit, wheel to zoom`;
  }
  return app;
}

/**
 * A game's own environment, at its simplest: a sky colour, two lights, and the
 * light direction handed to the engine so grass, trees and water shade from
 * the same side as the sun.
 */
function addOwnEnvironment(app) {
  const sunDir = new THREE.Vector3(-0.4, 0.75, 0.5).normalize();
  app.scene.background = new THREE.Color(0x9cc4e4);
  app.scene.add(new THREE.HemisphereLight(0xcfe4ff, 0x4a3f33, 1.1));
  const sun = new THREE.DirectionalLight(0xfff1dd, 2.4);
  sun.position.copy(sunDir).multiplyScalar(500);
  app.scene.add(sun);
  app.environment.setLightDirection(sunDir);
}

/**
 * Load a .v3proj. The terrain size is fixed when the engine boots, so a level
 * of another size stores its bytes, reloads the page at that size, and the
 * engine imports it on the next boot (`app.pendingWorldImport`).
 */
async function loadLevel(app, url) {
  const PENDING = "empty-game.pendingLevel";
  if (sessionStorage.getItem(PENDING)) {
    sessionStorage.removeItem(PENDING);
    await app.pendingWorldImport;   // the engine is importing the stashed level
    await app.refreshWorldHeights();
    return true;
  }
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    if (!isProjectFile(buf)) throw new Error("not a .v3proj");
    const t = decodeProjectFile(buf).terrain ?? {};
    if (t.heightmapSize !== HEIGHTMAP_SIZE || Math.round(t.worldSize) !== WORLD_SIZE || Math.round(t.maxHeight) !== MAX_HEIGHT) {
      saveTerrainConfig(t);
      sessionStorage.setItem(PENDING, url);
      await stashPendingHeightmap(buf);
      location.reload();
      await new Promise(() => {});   // the page is going away
    }
    await app.loadProjectFromBuffer(buf);
    await app.refreshWorldHeights();
    return true;
  } catch (err) {
    console.warn(`[empty-game] Level ${url} not loaded:`, err);
    return false;
  }
}
