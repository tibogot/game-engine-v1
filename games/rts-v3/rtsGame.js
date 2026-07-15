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
import { createUnits } from "./units.js";
import { createUnitRenderer } from "./unitRenderer.js";
import { createSelection } from "./selection.js";
import { createNavGrid } from "./navGrid.js";
import { createMinimap } from "./minimap.js";
import { createUnitBar } from "./unitBar.js";
import { createCommandCard } from "./commandCard.js";
import { createDevPanel } from "./devPanel.js";
import { createStructures } from "./structures.js";
import { createStructuresRenderer } from "./structuresRenderer.js";
import { createHealthBarField } from "./healthBar.js";
import { createWaves } from "./waves.js";
import { createWaveHud } from "./waveHud.js";
import { createBuildings } from "./buildings.js";
import { createBuildingRenderer } from "./buildingRenderer.js";
import { createBuildPlacement } from "./buildPlacement.js";
import { createCombatFx } from "./combatFx.js";
import { createCombat } from "./combat.js";
import { createProjectiles } from "./projectiles.js";
import { createFireSystem } from "./fireSystem.js";
import { createCraterSystem } from "./craterSystem.js";
import {
  loadBootWorld,
  loadDefaultWorld,
  loadWorldFromFile,
} from "./worldLoader.js";

export async function startRtsGame({ onStatus = () => {} } = {}) {
  // 1) Boot the v3 engine — renderer, terrain clipmap, sky, grass, water… the
  //    whole runtime. Same entry the editor uses; the page hides editor chrome.
  onStatus("Starting engine…");
  const app = await startV3App();
  window.__rts = app; // handy for console debugging

  // 2) Load world — default world.v3proj, or ?world=/path/to/other.v3proj.
  const worldState = { name: "procedural default" };
  const boot = await loadBootWorld(app, { onStatus });
  worldState.name = boot.name;

  // Post-FX: the GAME owns its look. postFx.enabled defaults to false in the
  // engine and is NOT stored in the .v3proj, so without this the game gets no
  // bloom no matter what its materials do. Bloom is SELECTIVE (emissive MRT),
  // so only our combat FX / beacons glow — the terrain and sky don't.
  app.postFx?.setEnabled(true);
  app.postFx?.setBloomSelective(true);
  app.postFx?.setBloom({ enabled: true, strength: 0.85, threshold: 0.0, radius: 0.5 });

  // Valley height fog (three.js webgpu_custom_fog style): low ground mist + distance
  // haze so hills peek through and the map edge dissolves into the sky.
  app.fog?.setHeight({
    enabled: true,
    mode: "valley",
    color: "#c8d8e4",
    base: 8,
    top: 42,
    haze: 0.0018,
    noiseWobble: 16,
  });
  app.fog?.setDistance({
    enabled: true,
    matchSky: true,
    density: 0.0004,
  });

  // 3) Camera — two modes the project needs: "orbit" (engine's editor controls,
  //    for inspecting the world) and "rts" (WASD pan, wheel zoom,
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

  // 4) ── RTS GAMEPLAY ───────────────────────────────────────────────────────
  //    Unit LOGIC is mesh-free (units.js); the RENDERER (unitRenderer.js) turns
  //    it into visuals. That split is what lets us swap in InstancedMesh for
  //    hundreds of units later without touching orders, combat or AI.
  //
  // Structures come FIRST because they MODIFY THE TERRAIN: each one picks a
  // buildable site and flattens the ground under it. So the nav grid built above
  // (used to pick sites) is now stale — we rebuild it from the new terrain, then
  // stamp the building footprints as obstacles.
  // Every health bar in the game — units AND structures — is one instance of a
  // single quad, so the whole HUD costs 1 draw call (it used to be 2 meshes per
  // entity). The renderers below push into it; the loop begins/commits it.
  const healthBars = createHealthBarField({ scene: app.scene });
  app.healthBars = healthBars;

  onStatus("Placing structures…");
  const structures = await createStructures({ app, navGrid });
  app.structures = structures;

  onStatus("Re-baking navigation…");
  navGrid.rebuild(); // the ground under every building changed
  for (const s of structures.list) {
    navGrid.addObstacle(s.position.x, s.position.z, s.radius);
  }

  const structuresRenderer = createStructuresRenderer({ app, structures, healthBars });
  app.structuresRenderer = structuresRenderer;

  // The starting army musters at the base (bottom of the map), not the origin.
  onStatus("Spawning units…");
  const units = createUnits({ app, navGrid, origin: structures.base.position });
  app.units = units;

  onStatus("Building unit visuals…");
  const unitRenderer = await createUnitRenderer({ app, units, healthBars });
  app.unitRenderer = unitRenderer;

  // Player-built buildings (helipad, …): runtime structures the builder raises.
  // They live in structures.list too, so combat/selection see them for free.
  const buildings = createBuildings({ app, structures, units, navGrid });
  app.buildings = buildings;
  const buildingRenderer = createBuildingRenderer({ app, buildings });
  app.buildingRenderer = buildingRenderer;

  // Ghost placement: select a builder → Build Helipad → site it → the builder
  // drives there and raises it (buildings.updateBuilders).
  const buildPlacement = createBuildPlacement({
    app,
    onCommit: (typeKey, x, z, chosenBuilders) => {
      for (const b of chosenBuilders) {
        b.buildOrder = { typeKey, x, z };
        b.moveOrder?.(x, z);
      }
    },
  });
  app.buildPlacement = buildPlacement;

  // Combat: units fire VISIBLE rockets with exhaust trails; damage lands on
  // impact. Wrecks catch fire. All of it glows via the engine's emissive MRT.
  const fx = createCombatFx({ app });
  app.combatFx = fx;

  const fire = createFireSystem({ app });
  app.fire = fire;

  onStatus("Loading crater decals…");
  const craters = await createCraterSystem({ app });
  app.craters = craters;

  // Late-bound: projectiles need combat.onImpact, combat needs projectiles.
  let combatRef = null;
  const projectiles = createProjectiles({
    app,
    onImpact: (target, dmg, at, owner) => combatRef?.onImpact(target, dmg, at, owner),
  });
  app.projectiles = projectiles;

  const combat = createCombat({
    units, structures, fx, structuresRenderer, projectiles, fire, craters,
    onDeath: (entity) => { app.selection?.remove?.(entity); },
  });
  combatRef = combat;
  app.combat = combat;

  // The opponent. Enemy waves muster off-map, march on the base, and fight — all
  // of it through the EXISTING combat system, which is team-based and never knew
  // the difference. They also cost no draw calls: enemy units join the same
  // instanced fields / compute-skinned crowd as ours, tinted per instance.
  const waves = createWaves({ app, units, structures, navGrid });
  app.waves = waves;

  const waveHud = createWaveHud();
  app.waveHud = waveHud;

  // Player-facing HUD: bottom-center bar shows the selected units as baked
  // 3D thumbnail tiles (grouped by type + count).
  //   click     → select only that type (from the current selection)
  //   dbl-click → select every unit of that type on the map
  const unitBar = createUnitBar({
    thumbnails: unitRenderer.thumbnails,
    onPickGroup: (arr) => app.selection?.select(arr),
    onSelectAllType: (key) =>
      app.selection?.select(units.list.filter((u) => u.typeKey === key)),
  });
  app.unitBar = unitBar;

  // Player-facing HUD: command card (bottom-right). Shows unit commands, or the
  // base's PRODUCTION queue when the base is selected.
  const commandCard = createCommandCard({
    thumbnails: unitRenderer.thumbnails,
    // The base makes ground units + builders. Helicopters come from a HELIPAD.
    buildable: [
      { key: "soldier", label: "Build Soldier" },
      { key: "jeep", label: "Build Jeep" },
      { key: "builder", label: "Build Builder" },
    ],
    onBuild: (key) => structures.base.enqueue(key),
    structureBuilds: [{ key: "helipad", label: "Build Helipad" }],
    onBuildStructure: (key, selected) => buildPlacement.begin(key, selected),
    onStop: () => { for (const u of app.selection?.selected ?? []) u.stop?.(); },
    onFocus: () => {
      const sel = app.selection?.selected ?? [];
      if (!sel.length) return;
      const cx = sel.reduce((s, u) => s + u.position.x, 0) / sel.length;
      const cz = sel.reduce((s, u) => s + u.position.z, 0) / sel.length;
      rtsCamera.focusOn(cx, cz);
    },
  });
  app.commandCard = commandCard;

  const selection = createSelection({
    app, units, unitRenderer, structuresRenderer,
    // The unit bar shows units only; buildings live in the command card.
    onChange: (sel) => {
      unitBar.render(sel.filter((e) => !e.isStructure));
      commandCard.render(sel);
    },
  });
  app.selection = selection;

  // Player-facing HUD: minimap (bottom-left). Baked terrain + unit blips +
  // camera viewport; click/drag to move the camera.
  const minimap = createMinimap({ app, units });
  app.minimap = minimap;

  // DEV UI (not player-facing): tune camera feel, unit speed, and the nav grid
  // while building the game. Collapsible, top-right.
  /** Rebuild gameplay systems that depend on terrain after a world swap. */
  const afterWorldLoad = async (result) => {
    if (!result?.loaded) return;
    worldState.name = result.name;
    onStatus("Re-seating structures…");
    await structures.reanchorToTerrain(app);
    const navOn = devPanel.getNavDebug?.() ?? false;
    navGrid.rebuild();
    for (const s of structures.list) {
      navGrid.addObstacle(s.position.x, s.position.z, s.radius);
    }
    minimap.rebuildTerrain();
    navGrid.setDebug(navOn);
    devPanel.setWorldName(worldState.name);
    rtsCamera.focusOn(structures.base.position.x, structures.base.position.z);
  };

  const devPanel = createDevPanel({
    app, navGrid, rtsCamera, units, minimap,
    worldName: worldState.name,
    onLoadWorldFile: async (file) => afterWorldLoad(await loadWorldFromFile(app, file, { onStatus })),
    onLoadDefaultWorld: async () => afterWorldLoad(await loadDefaultWorld(app, { onStatus })),
  });
  app.devPanel = devPanel;

  app.loadWorldFile = async (file) => afterWorldLoad(await loadWorldFromFile(app, file, { onStatus }));
  app.loadDefaultWorld = async () => afterWorldLoad(await loadDefaultWorld(app, { onStatus }));
  app.worldName = () => worldState.name;

  // Frame the camera on the base at boot.
  rtsCamera.focusOn(structures.base.position.x, structures.base.position.z);

  // 5) ── THE GAME LOOP ──────────────────────────────────────────────────────
  //    One rAF drives everything, in a deliberate order: input/camera → unit
  //    logic → push logic into meshes → HUD. (Each system used to run its own
  //    rAF, which made ordering between them undefined.) The ENGINE renders the
  //    scene on its own loop; this one only updates game state.
  let last = performance.now();
  let elapsed = 0;
  const tick = () => {
    const now = performance.now();
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    elapsed += dt;

    rtsCamera.update(dt);
    waves.update(dt);                     // spawn the next wave, keep them marching
    structures.updateProduction(dt, (key, x, z, opts) => units.spawn(key, x, z, opts));
    buildings.update(dt);                 // construction ramp + helipad production
    units.update(dt);
    combat.update(dt);                    // acquire → chase → launch rockets
    projectiles.update(dt, app.camera);   // rockets fly, trail, and land damage
    healthBars.begin();                   // both renderers push their bars into it
    unitRenderer.sync(dt, app.camera);
    structuresRenderer.sync(dt, app.camera);
    buildingRenderer.sync(dt);
    healthBars.commit();
    fx.update(dt, app.camera);            // muzzle / impact / explosion
    fire.update(dt, elapsed);             // burning wrecks
    commandCard.tick();                   // live production bar
    waveHud.update(dt, waves);            // wave counter, countdown, defeat
    minimap.draw();

    app._rtsRaf = requestAnimationFrame(tick);
  };
  app._rtsRaf = requestAnimationFrame(tick);

  onStatus("ready");
  return app;
}
