// ============================================================================
// RTS GAME (v3) — a game project built ON TOP of the v3 world engine.
//
// The model (same as games/rts/ but on the newer v3 engine):
//   • The v3 EDITOR (v3/editor.html) authors the world and saves a .v3proj.
//   • This GAME imports the engine's boot (startV3App), LOADS that .v3proj, and
//     adds RTS-specific gameplay on top (camera, units, selection, AI, UI).
//
// Nothing here edits the engine's source — it only imports it. To reshape the
// terrain or move objects: open v3/editor.html, build/tweak, Save Project, and
// drop the resulting file here as `world.v3proj`. This game reloads it on boot.
// ============================================================================

import { startV3App } from "../../v3/app/main.js";
import { createRtsCamera } from "./rtsCamera.js";
import { createGameUi } from "./gameUi.js";
import { createUnits } from "./units.js";
import { createSelection } from "./selection.js";
import { createNavGrid } from "./navGrid.js";

// Where this game's world file lives. Fetched at runtime (not a static import)
// so a missing file gives a friendly message instead of breaking the build.
const WORLD_URL = "/games/rts-v3/world.v3proj";

export async function startRtsGame({ onStatus = () => {} } = {}) {
  // 1) Boot the v3 engine — renderer, terrain clipmap, sky, grass, water… the
  //    whole runtime. Same entry the editor uses; the page hides editor chrome.
  onStatus("Starting engine…");
  const app = await startV3App();
  window.__rts = app; // handy for console debugging

  // 2) Load THIS game's world (terrain + splat + snow + trees + props + roads +
  //    lakes). If none has been saved yet, boot on the default terrain so you
  //    can still see the engine run, and log how to add one.
  try {
    onStatus("Loading world…");
    const res = await fetch(WORLD_URL, { method: "HEAD" });
    if (res.ok) {
      await app.loadProjectFromUrl(WORLD_URL);
    } else {
      console.warn(
        `[RTS-v3] No world file at ${WORLD_URL}. ` +
        "Save a project from v3/editor.html and drop it here as world.v3proj.",
      );
    }
  } catch (err) {
    console.warn("[RTS-v3] World load skipped:", err);
  }

  // 3) Camera — two modes the project needs: "orbit" (engine's editor controls,
  //    for inspecting the world) and "rts" (WASD/edge-scroll pan, wheel zoom,
  //    Q/E rotate, terrain-follow). Toggle with the HUD button or the C key.
  onStatus("Setting up camera…");
  const rtsCamera = createRtsCamera({ app });
  rtsCamera.setMode("rts"); // start in RTS view
  app.rtsCamera = rtsCamera;

  // Nav grid — built once the world is loaded from terrain slope + lakes +
  // props + trees, so ground units path around steep terrain, water, and
  // obstacles. Toggle the debug overlay (N) to see blocked cells.
  onStatus("Building navigation…");
  const navGrid = createNavGrid({ app });
  app.navGrid = navGrid;

  // Custom game UI (HUD). Owned by the game, not the engine.
  const gameUi = createGameUi({ rtsCamera, navGrid });
  app.gameUi = gameUi;

  // 4) ── RTS GAMEPLAY ───────────────────────────────────────────────────────
  //    A helicopter (air) and a jeep (ground). Left-click to select (Shift to
  //    multi-select, drag a box to select several), right-click to move the
  //    selection. Ground units pathfind; air flies straight.
  onStatus("Spawning units…");
  const units = await createUnits({ app, navGrid });
  app.units = units;

  const selection = createSelection({ app, units });
  app.selection = selection;

  // Frame the camera on the first unit so it's on-screen at boot.
  const first = units.list[0];
  if (first) rtsCamera.focusOn(first.position.x, first.position.z);

  onStatus("ready");
  return app;
}
