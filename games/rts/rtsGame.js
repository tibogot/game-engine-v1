// ============================================================================
// RTS GAME — a game project built ON TOP of the world engine.
//
// This demonstrates the "two tools, one file" model:
//   • The ENGINE (v2) + its EDITOR author the world and save it to a file.
//   • This GAME imports the engine's runtime, LOADS that world file, and adds
//     RTS-specific gameplay on top (camera, units, selection, AI, UI).
//
// Nothing here touches the engine's source — it only imports it. To reshape the
// terrain or move objects, open the editor (v2/editor.html), load this game's
// world file (games/rts/world.v2terrain), edit, and save. This game reloads it.
// ============================================================================

import { startV2App } from "../../v2/app/main.js";
// The world file lives WITH this game. Vite's `?url` resolves it to a served
// URL in both dev and build, so the world travels with the game project.
import worldUrl from "./world.v2terrain?url";

export async function startRtsGame({ onStatus = () => {} } = {}) {
  // 1) Boot the engine headless — this builds the renderer, scene, terrain
  //    streaming, sky, lighting, foliage… everything the world needs. Same
  //    entry the player (play.html) uses; no editor UI.
  onStatus("Starting engine…");
  const app = await startV2App();
  window.__rts = app; // handy for console debugging

  // 2) Load THIS game's world (terrain + placed objects/trees + sky settings).
  onStatus("Loading world…");
  await app.loadProjectFromUrl(worldUrl);

  // 3) RTS camera — a high, angled top-down view. (Later this gets replaced by
  //    the extracted rtsCameraControl module: WASD pan + mouse edge-scroll +
  //    terrain-follow, driven through the world-interface.)
  onStatus("Setting up RTS view…");
  setupRtsCamera(app);

  // 4) ── RTS GAMEPLAY GOES HERE ─────────────────────────────────────────────
  //    This is the part that is unique to THIS game and lives in THIS project.
  //    Port in, one at a time, from the proven rts-lab modules, wiring each to
  //    the engine's world (terrain height, raycast-ground, etc.):
  //      • units + instancer        (rts-units.js, rts-unit-instancer.js)
  //      • selection + orders       (box-select, move/attack — rtsSelection…)
  //      • pathfinding              (rts-pathfind.js)
  //      • fog of war               (rts-fog-of-war.js)
  //      • combat                   (targeting, damage)
  //      • RTS HUD / minimap / UI
  //    None of this belongs in the engine — it's game code.
  // ───────────────────────────────────────────────────────────────────────────

  onStatus("ready");
  return app;
}

/** High angled top-down RTS framing. Placeholder until the real RTS camera. */
function setupRtsCamera(app) {
  const { camera, controls } = app;
  controls.target.set(0, 0, 0);
  camera.position.set(0, 140, 140);
  camera.fov = 45;
  camera.updateProjectionMatrix();
  // Keep the cursor visible (RTS needs it for selection) — no pointer lock.
  controls.enablePan = true;
  controls.update();
}
