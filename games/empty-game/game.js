// Starter game — boots the v3 engine as a game, loads a level, and either uses
// the engine's environment or brings its own. Copy this folder to start one.
//
// A game imports the engine through v3/engine.js (what may be imported, and
// the `app` handle startV3App returns, are documented there).
import * as THREE from "three";
import { startV3App, createLevelLoader } from "../../v3/engine.js";

const DEFAULT_LEVEL = "/games/rts-v3/rts.v3proj";

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

  // The shipped level, or ?world=<url>. A level of another terrain size reloads
  // the page at that size and is imported on the next boot.
  const levels = createLevelLoader(app, { defaultUrl: DEFAULT_LEVEL, onStatus });
  const level = await levels.loadBoot();

  // A plain orbit camera: the game owns `controls` (the editor camera is off).
  app.controls.enableZoom = true;
  app.camera.position.set(0, 260, 520);
  app.controls.target.set(0, 20, 0);
  app.controls.update();

  const hud = document.getElementById("hud");
  if (hud) {
    hud.textContent = `${level.loaded ? level.name : "default terrain"} · environment: ${app.environment.enabled ? "engine" : "own"} · drag to orbit, wheel to zoom`;
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

