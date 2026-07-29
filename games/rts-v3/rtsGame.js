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
// drop the resulting file here as `rts.v3proj`. This game reloads it on boot.
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
import { createSelectionRingField } from "./selectionRingField.js";
import { createResources, UNIT_COST, BUILDING_COST } from "./resources.js";
import { createResourceRenderer } from "./resourceRenderer.js";
import { createResourceHud } from "./resourceHud.js";
import { createHarvesting } from "./harvesting.js";
import { createWaves } from "./waves.js";
import { createWaveHud } from "./waveHud.js";
import { createBuildings } from "./buildings.js";
import { createBuildingRenderer } from "./buildingRenderer.js";
import { createBuildPlacement } from "./buildPlacement.js";
import { createBaseFlag } from "./baseFlag.js";
import { createCombatFx } from "./combatFx.js";
import { createCombat } from "./combat.js";
import { createProjectiles } from "./projectiles.js";
import { createFireSystem } from "./fireSystem.js";
import { createCraterSystem } from "./craterSystem.js";
import { createFogOfWar } from "./fogOfWar.js";
import {
  loadBootWorld,
  loadDefaultWorld,
  loadWorldFromFile,
} from "./worldLoader.js";

export async function startRtsGame({ onStatus = () => {}, fov } = {}) {
  // 1) Boot the v3 engine — renderer, terrain clipmap, sky, grass, water… the
  //    whole runtime. Same entry the editor uses; the page hides editor chrome.
  onStatus("Starting engine…");
  // csm.cascades is a BOOT-ONLY option (live changes are broken on three r184 —
  // see app.shadows in v3/app/main.js). The RTS camera is a fixed-pitch
  // top-down view with maxFar 80, so 2 cascades cover it; each cascade re-draws
  // every shadow caster per frame, so this is ~12 draw calls per cascade saved.
  // A/B against the old look with ?csm=3 (or ?csm=1 to see why 1 isn't enough).
  // maxFar 300: the editor default (80) is tuned for a ground-level camera — the
  // RTS camera orbits 50-280 m up, so at 80 every shadow faded out before the
  // player could see it. 300 covers the whole zoom range (DIST_MAX 280).
  const csmParam = Number(new URLSearchParams(location.search).get("csm"));
  const cascades = csmParam >= 1 && csmParam <= 4 ? Math.round(csmParam) : 2;
  // shadowNormalBias 0.12 (editor default 0.02): this game is all hard-surface
  // structures with big FLAT decks, and a flat up-facing face self-shadows into
  // diagonal stripes at the editor's bias. Terrain and foliage are curved enough
  // that 0.02 never showed it — verified the stripes appear/vanish by toggling
  // castShadow on the turrets alone. Boot-only, like csm (both are read when
  // createWorldEnvironment builds the sun).
  const app = await startV3App({
    csm: { cascades, maxFar: 300 },
    light: { shadowNormalBias: 0.12 },
  });
  window.__rts = app; // handy for console debugging

  if (fov != null) {
    app.camera.fov = fov;
    app.camera.updateProjectionMatrix();
  }

  // 2) Load world — default rts.v3proj, or ?world=/path/to/other.v3proj.
  const worldState = { name: "procedural default" };
  const boot = await loadBootWorld(app, { onStatus });
  worldState.name = boot.name;
  // Rivers/lakes carve the heightmap AFTER the project's own height sync, so
  // pull a fresh CPU mirror before anything below reads ground heights.
  await app.refreshWorldHeights?.();

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

  // Every selection ring in the game is likewise ONE instanced draw, and it
  // drapes itself over the terrain in the vertex shader — so selecting 200 units
  // costs 1 draw call and no CPU height sampling at all.
  const selectionRings = createSelectionRingField({ app });
  app.selectionRings = selectionRings;

  // The economy. Created BEFORE structures so the base can charge for production,
  // but its nodes are placed after — node siting flattens terrain too, and doing
  // it in one pass with the structures keeps the nav rebuild to a single pass.
  const resources = await createResources({ app });
  app.resources = resources;

  onStatus("Placing structures…");
  const structures = await createStructures({ app, navGrid, resources });
  app.structures = structures;

  onStatus("Seeding resource nodes…");
  await resources.placeNodes(structures.base.position);

  onStatus("Re-baking navigation…");
  navGrid.rebuild(); // the ground under every building AND node changed
  for (const s of structures.list) {
    navGrid.addObstacle(s.position.x, s.position.z, s.radius);
  }
  // Resource nodes are deliberately NOT nav obstacles: a harvester has to be able
  // to park on one, and blocking the footprint just makes it stall at the edge.

  // Resource renderer + flag first — no unit dependency.
  const resourceRenderer = createResourceRenderer({ app, resources });
  app.resourceRenderer = resourceRenderer;

  const baseFlag = createBaseFlag({ app, structures });
  app.baseFlag = baseFlag;

  onStatus("Spawning units…");
  const units = createUnits({ app, navGrid, origin: structures.base.position });
  app.units = units;

  const buildings = createBuildings({ app, structures, units, navGrid });
  app.buildings = buildings;

  const fogOfWar = createFogOfWar({
    app, units, structures, buildings,
    getRadioIntel: () => buildings.list.some(
      (b) => b.alive && b.typeKey === "radio" && !b.constructing && b.built >= 1,
    ),
  });
  app.fogOfWar = fogOfWar;
  fogOfWar.installPostFx(app);

  onStatus("Building unit visuals…");
  const unitRenderer = await createUnitRenderer({
    app, units, healthBars, selectionRings, fogOfWar,
  });
  app.unitRenderer = unitRenderer;

  const structuresRenderer = createStructuresRenderer({
    app, structures, healthBars, fogOfWar,
  });
  app.structuresRenderer = structuresRenderer;

  const buildingRenderer = createBuildingRenderer({ app, buildings, healthBars });
  app.buildingRenderer = buildingRenderer;

  // Ghost placement: select a builder → Build Helipad → site it → the builder
  // drives there and raises it (buildings.updateBuilders).
  const buildPlacement = createBuildPlacement({
    app,
    canAfford: (cost) => resources.canAfford(cost),
    onCommit: (typeKey, x, z, chosenBuilders) => {
      const cost = BUILDING_COST[typeKey] ?? 0;
      if (cost && !resources.spend(cost)) return;
      for (const b of chosenBuilders) {
        b.buildOrder = { typeKey, x, z };
        b.moveOrder?.(x, z);
      }
    },
  });
  app.buildPlacement = buildPlacement;

  // Harvester loop: node → fill → base → unload → repeat. Its own driver, like
  // combat.js, so units.js stays about movement and knows nothing about economy.
  const harvesting = createHarvesting({ units, structures, resources });
  app.harvesting = harvesting;

  const resourceHud = createResourceHud();
  app.resourceHud = resourceHud;

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
      app.selection?.select(units.list.filter(
        (u) => u.alive && u.team === "player" && u.typeKey === key,
      )),
  });
  app.unitBar = unitBar;

  // Player-facing HUD: command card (bottom-right). Shows unit commands, or the
  // base's PRODUCTION queue when the base is selected.
  const commandCard = createCommandCard({
    thumbnails: unitRenderer.thumbnails,
    // What a selected structure can produce: the base makes ground units +
    // builders; a helipad makes helicopters. Helicopters come ONLY from a helipad.
    productionFor: (s) => (
      s.typeKey === "base"
        ? [
            { key: "harvester", label: "Harvester", cost: UNIT_COST.harvester },
            { key: "soldier", label: "Soldier", cost: UNIT_COST.soldier },
            { key: "jeep", label: "Jeep", cost: UNIT_COST.jeep },
            { key: "builder", label: "Builder", cost: UNIT_COST.builder },
            { key: "bigtank", label: "Heavy APC", cost: UNIT_COST.bigtank },
            { key: "tank", label: "Battle Tank", cost: UNIT_COST.tank },
          ]
        // Helipad units are free in this pass — only base production is costed.
        : s.typeKey === "helipad"
          ? [{ key: "helicopter", label: "Build Heli" }]
          : []
    ),
    canAfford: (cost) => resources.canAfford(cost),
    onBuild: (structure, key) => structure.enqueue(key),
    structureBuilds: [
      { key: "helipad", label: "Build Helipad" },
      { key: "turret", label: "Build Turret" },
      { key: "radio", label: "Radio Station" },
      { key: "captureNode", label: "Supply Relay" },
    ],
    buildingCosts: BUILDING_COST,
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
    app, units, unitRenderer, structuresRenderer, buildingRenderer,
    resourceRenderer, harvesting, // right-click a node → send harvesters to it
    // The unit bar shows units only; buildings live in the command card.
    onChange: (sel) => {
      unitBar.render(sel.filter((e) => !e.isStructure));
      commandCard.render(sel);
    },
  });
  app.selection = selection;

  // Player-facing HUD: minimap (bottom-left). Baked terrain + unit blips +
  // camera viewport; click/drag to move the camera.
  const minimap = createMinimap({ app, units, buildings, fogOfWar });
  app.minimap = minimap;

  // DEV UI (not player-facing): tune camera feel, unit speed, and the nav grid
  // while building the game. Collapsible, top-right.
  /**
   * Re-seat every terrain-anchored gameplay object on the CURRENT terrain and
   * rebuild what depends on it (nav grid, minimap). Runs automatically after a
   * world load; also wired to the dev panel's "Re-seat on terrain" button as a
   * manual fix-up for anything left floating.
   */
  const reseatWorld = async () => {
    onStatus("Re-seating structures…");
    // Rivers/lakes carve the heightmap AFTER a project's own height sync — pull
    // a fresh CPU mirror so re-seating reads the FINAL ground, not a stale one.
    await app.refreshWorldHeights?.();
    await structures.reanchorToTerrain(app);
    for (const b of buildings.list) {
      b.position.y = app.getWorldHeight?.(b.position.x, b.position.z) ?? b.position.y;
    }
    // Resource nodes sit on the ground like everything else — re-seat them too, or
    // they float/sink after a world swap.
    for (const n of resources.nodes) {
      n.position.y = app.getWorldHeight?.(n.position.x, n.position.z) ?? n.position.y;
    }
    baseFlag?.reanchor();
    const navOn = devPanel?.getNavDebug?.() ?? false;
    navGrid.rebuild();
    for (const s of structures.list) {
      navGrid.addObstacle(s.position.x, s.position.z, s.radius);
    }
    minimap.rebuildTerrain();
    navGrid.setDebug(navOn);
    rtsCamera.focusOn(structures.base.position.x, structures.base.position.z);
  };
  app.reseatWorld = reseatWorld;

  /** Rebuild gameplay systems that depend on terrain after a world swap. */
  const afterWorldLoad = async (result) => {
    if (!result?.loaded) return;
    worldState.name = result.name;
    await reseatWorld();
    devPanel.setWorldName(worldState.name);
  };

  const devPanel = createDevPanel({
    app, navGrid, rtsCamera, units, minimap,
    worldName: worldState.name,
    onLoadWorldFile: async (file) => afterWorldLoad(await loadWorldFromFile(app, file, { onStatus })),
    onLoadDefaultWorld: async () => afterWorldLoad(await loadDefaultWorld(app, { onStatus })),
    onReseat: reseatWorld,
  });
  app.devPanel = devPanel;

  app.loadWorldFile = async (file) => afterWorldLoad(await loadWorldFromFile(app, file, { onStatus }));
  app.loadDefaultWorld = async () => afterWorldLoad(await loadDefaultWorld(app, { onStatus }));
  app.worldName = () => worldState.name;

  // Frame the camera on the base at boot.
  rtsCamera.focusOn(structures.base.position.x, structures.base.position.z);

  // 5) ── THE GAME LOOP ──────────────────────────────────────────────────────
  //    One pre-render hook drives everything, in a deliberate order: input/camera
  //    → unit logic → push logic into meshes → HUD. Running on the engine loop
  //    (not a separate rAF) keeps fog-of-war in sync with the render pass.
  let elapsed = 0;
  const tick = (dt) => {
    elapsed += dt;

    rtsCamera.update(dt);
    waves.update(dt);                     // spawn the next wave, keep them marching
    structures.updateProduction(dt, (key, x, z, opts) => units.spawn(key, x, z, opts));
    buildings.update(dt);                 // construction ramp + helipad production
    resources.tickCaptureIncome(dt, buildings);
    harvesting.update(dt);                // node → fill → base → unload → repeat
    units.update(dt);
    fogOfWar.update(dt);                  // vision grid → GPU shroud texture
    combat.update(dt);                    // acquire → chase → launch rockets
    projectiles.update(dt, app.camera);   // rockets fly, trail, and land damage
    resourceRenderer.sync();              // only rewrites when a node visibly drains
    healthBars.begin();                   // both renderers push their bars into it
    selectionRings.begin();               // unitRenderer pushes a ring per selected unit
    unitRenderer.sync(dt, app.camera);
    structuresRenderer.sync(dt, app.camera);
    buildingRenderer.sync(dt, app.camera);
    healthBars.commit();
    selectionRings.commit();
    fx.update(dt, app.camera);            // muzzle / impact / explosion
    fire.update(dt, elapsed);             // burning wrecks
    baseFlag?.update(dt);                 // HQ flag cloth sim
    commandCard.tick();                   // live production bar + affordability
    resourceHud.update(resources, units); // supplies / harvesters / nodes left
    waveHud.update(dt, waves);            // wave counter, countdown, defeat
    minimap.draw();
  };
  app.addPreRenderHook(tick);

  onStatus("ready");
  return app;
}
