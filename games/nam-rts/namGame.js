// ============================================================================
// VIETNAM RTS — the new game. Built ON TOP of the v3 world engine.
//
// The model:
//   • The v3 EDITOR (v3/editor.html) authors the world and saves a .v3proj.
//   • This GAME imports the engine's boot (startV3App), LOADS that .v3proj, and
//     adds RTS-specific gameplay on top (camera, units, selection, AI, UI).
//
// Nothing here edits the engine's source — it only imports it. To reshape the
// terrain: open v3/editor.html, build, Save Project, and drop the file in
// public/levels/ (public/, so a build ships it). This game reloads it on boot.
//
// ── WHY THIS IS A COPY OF games/rts-v3, NOT A REWRITE ────────────────────────
//
// It started as one, deliberately. The old game's RENDERING is good and was
// expensive to get right — one draw for every health bar, one instanced field
// per FX kind, compute-skinned soldiers at 0.57 ms for a thousand, craters and
// selection rings draped in a vertex shader. None of that is what makes this a
// different game, and rewriting it from an empty folder would have burned
// weeks re-typing selection boxes to arrive back where we started.
//
// What makes it a different game is the DESIGN, and those files are the ones
// being replaced, with the lights on:
//   units.js      → spatial grid, steering, squads (not O(n²) neighbour scans)
//   combat.js     → LOS, cover, concealment, suppression (not "nearest enemy
//                   within radius", which is a symmetric-skirmish rule)
//   unitTypes.js  → data-driven FACTIONS: US firepower and air mobility vs an
//                   infantry that hides. The old file is one shared list.
//   navGrid.js    → flow fields + cost fields (jungle slows, trails speed,
//                   water is boats only), not an A* per unit per order
//   waves.js      → missions and objectives, not wave spam
//   the loop      → FIXED TIMESTEP with an interpolated render. Day one or
//                   never: replays, saves and determinism all hang off it.
// ============================================================================

// The dev panel is built out of the v3 editor'''s own classes and :root
// variables (see devPanel.js), so this sheet is required. Imported here rather
// than <link>ed in rts.html: <base> is /v3/ so a relative href resolves against
// /v3/ in the browser but against THIS FILE'''S DIRECTORY when Vite scans the
// HTML at build time, and Vite therefore bundles nothing and the deployed site
// 404s on /v3/styles/editor.css.
import "../../v3/styles/editor.css";
import { startV3App, createLevelLoader } from "../../v3/engine.js";
import { createRtsCamera } from "./namCamera.js";
import { createUnits } from "./units.js";
import { createUnitRenderer } from "./unitRenderer.js";
import { xrayParams } from "./xraySilhouette.js";
import { createSelection } from "./selection.js";
import { createNavGrid, NAV_MAX_SLOPE_DEG } from "./navGrid.js";

/**
 * What stone looks like in this valley.
 *
 * Judged in the game against BOTH places rock appears — a boulder field in the
 * jungle and the stones lining the river — because the two pull opposite ways:
 * dark enough to sit down into the canopy, light enough to still read against
 * sand.
 *
 * `mossColor` was the one that had to be measured rather than reasoned. The
 * first two attempts used a near-black green, which is what moss actually is
 * in shadow and which is invisible against dark grey stone: probing the mask
 * with magenta showed it had been working all along and simply had nothing to
 * show. A mid olive reads; a realistic one does not.
 */
const NAM_ROCK_PALETTE = {
  tint: 0x9b978c,
  bottomTint: 0x4d5543,
  moss: 0.9,
  mossColor: 0x63803a,
  mossScale: 0.42,
};
import { createMinimap } from "./minimap.js";
import { createUnitBar } from "./unitBar.js";
import { createCommandCard } from "./commandCard.js";
import { createDevPanel } from "./devPanel.js";
import { createStructures } from "./structures.js";
import { createStructuresRenderer } from "./structuresRenderer.js";
import { createHealthBarField } from "./healthBar.js";
import { createSelectionRingField } from "./selectionRingField.js";
import { createSelectionFrameField } from "./selectionFrameField.js";
import { createResources, UNIT_COST, BUILDING_COST } from "./resources.js";
import { createResourceRenderer } from "./resourceRenderer.js";
import { createResourceHud } from "./resourceHud.js";
import { createHudBar } from "./hudBar.js";
import { createControlGroups } from "./controlGroups.js";
import { createHarvesting } from "./harvesting.js";
import { createRequisition } from "./requisition.js";
import { createTraps } from "./traps.js";
import { createRequisitionRenderer } from "./requisitionRenderer.js";
import { hamletSitesFor, pointSitesFor, templeSitesFor, tunnelSitesFor } from "./pointSites.js";
import { placeHamlet } from "./village.js";
import { placeTemple } from "./temple.js";
import { placeEnemyCamp, createEnemyCampFlag } from "./enemyCamp.js";
import { siteEnemyLine } from "./enemyLine.js";
import { paintCanopy, paintPalmFringe, paintUndergrowth, travellerPalmSpots, canopyClearings } from "./jungleCanopy.js";
import { plant, updatePlantedPlants } from "./placedPlants.js";
import { plantSpecimens } from "./specimenPlants.js";
import { sitePaddies, buildRicePaddies } from "./ricePaddies.js";
import { placeBuffalo } from "./buffalo.js";
import { createWildHerd, loadAnimal } from "./wildAnimals.js";
import { applyNamRocks, clearKarstGround } from "./namRocks.js";
import { dressEnemyCamp } from "./enemyCampDressing.js";
import { createChickenFlock } from "./chickenFlock.js";
import { createFogBanks, siteFogBanks } from "./fogBanks.js";
import { buildFogBanksPanel } from "./fogBanksPanel.js";
import { snapshotEngineScene, warmGamePipelines } from "./pipelineWarmup.js";
import { createEnemyAI } from "./enemyAI.js";
import { buildRequisitionMast } from "../../v3/render/objects/rtsBuildables.js";
import { createWaves } from "./waves.js";
import { createMatch } from "./match.js";
import { createWaveHud } from "./waveHud.js";
import { createBuildings } from "./buildings.js";
import { createBuildingRenderer } from "./buildingRenderer.js";
import { bakeStructureThumbnails } from "./structureThumbnails.js";
import { createBuildPlacement } from "./buildPlacement.js";
import { createBaseFlag } from "./baseFlag.js";
import { createCombatFx } from "./combatFx.js";
import { createCombat } from "./combat.js";
import { createProjectiles } from "./projectiles.js";
import { createFireSystem } from "./fireSystem.js";
import { createSmokeField } from "./smokeField.js";
import { createNapalmStrike } from "./napalmStrike.js";
import { createFireballField } from "./fireballField.js";
import { createFlameField } from "./flameField.js";
import { createRtsBirds } from "./rtsBirds.js";
import { createGrassTrails } from "./grassTrails.js";
import { createCover } from "./cover.js";
import { createPlacedObjects } from "./placedObjects.js";
import { placeCampPerimeter } from "./campPerimeter.js";
import { installBuildingAprons } from "./buildingAprons.js";
import { placeCampLayout } from "./campLayout.js";
import { gradeBridgeLandings } from "./bridgeLandings.js";
import { measureBridgeDecks } from "./bridgeDecks.js";
import { createAbilities } from "./abilities.js";
import { createAbilityTargeting } from "./abilityTargeting.js";
import { createCoverOverlay } from "./coverOverlay.js";
import { createCraterSystem } from "./craterSystem.js";
import { createNamSounds } from "./namSounds.js";
import { createFogOfWar } from "./fogOfWar.js";
import { createSimClock } from "./simClock.js";
import { createStressTest } from "./stressTest.js";

export async function startNamGame({ container, onStatus = () => {}, onProgress = null, fov } = {}) {
  // 1) Boot the v3 engine — renderer, terrain clipmap, sky, grass, water… the
  //    whole runtime — drawing into the page's `container`.
  onStatus("Starting engine…");
  // csm.cascades is a BOOT-ONLY option (live changes are broken on three r184 —
  // see app.shadows in v3/app/main.js). The RTS camera is a fixed-pitch
  // top-down view with maxFar 80, so 2 cascades cover it; each cascade re-draws
  // every shadow caster per frame, so this is ~12 draw calls per cascade saved.
  // A/B against the old look with ?csm=3 (or ?csm=1 to see why 1 isn't enough).
  // maxFar 300: the editor default (80) is tuned for a ground-level camera — the
  // RTS camera orbits 50-280 m up, so at 80 every shadow faded out before the
  // player could see it. 300 covers the whole zoom range (DIST_MAX 280).
  // DEFAULT: cascades OFF, one shadow frustum fitted to the ground the camera
  // can actually see (worldEnvironment fitDirectionalShadowToView). MEASURED on
  // this map with 2 cascades at 2048:
  //
  //     cascade 0  +/-15.1 m  0.015 m/texel  covers the first 10 m of view
  //     cascade 1  +/-415  m  0.405 m/texel  covers 10-300 m
  //     visible ground at the default zoom and beyond: 23 - 141 m
  //
  // The sharp cascade is aimed entirely at ground this camera cannot see — it
  // never gets nearer than 8 m to the ground, and 23 m at the zoom you play at
  // — so EVERY pixel on screen was shaded by the 40 cm/texel one. A fitted
  // frustum gives 0.061-0.195 m/texel across the zoom range, in one pass
  // instead of two: 114 -> 94 draws.
  //
  // `?csm=2` (or 1/3/4) brings the cascades back to A/B against this.
  // `?fat=1` compiles the terrain features this map does not use, for A/B.
  const leanTerrain = new URLSearchParams(location.search).get("fat") !== "1";

  const csmParam = Number(new URLSearchParams(location.search).get("csm"));
  const cascades = csmParam >= 1 && csmParam <= 4 ? Math.round(csmParam) : 2;
  const fittedShadows = !(csmParam >= 1 && csmParam <= 4);
  // shadowNormalBias 0.12 (editor default 0.02): this game is all hard-surface
  // structures with big FLAT decks, and a flat up-facing face self-shadows into
  // diagonal stripes at the editor's bias. Terrain and foliage are curved enough
  // that 0.02 never showed it — verified the stripes appear/vanish by toggling
  // castShadow on the turrets alone. Boot-only, like csm (both are read when
  // createWorldEnvironment builds the sun).
  const app = await startV3App({
    container,
    // The EDITOR's default paint palette (7 PBR sets, 28 images) was decoded
    // on every boot and then overwritten slot by slot by the level's own
    // paintLayers — nam-valley fills all seven. The engine says a game must
    // not preload it (main.js, loadPaintDefaults); this game never did say so.
    preloadPaintTextures: false,
    // `enabled` MUST be decided here, at boot, not by app.shadows.setEnabled
    // afterwards. The environment builds the CSM node into every lit material
    // the moment it is enabled, and switching it off later only nulls the
    // sun's reference: the compiled graphs keep the CSM node, its two cascade
    // casters stay in the scene, and BOTH cascade shadow maps keep rendering
    // every frame while the fitted frustum this game asked for never renders
    // at all. MEASURED: two orthographic passes of 18 and 24 objects at
    // 2048², the sun's own camera absent, on a build that believed it was
    // running one fitted shadow.
    csm: { cascades, maxFar: 300, enabled: !fittedShadows },
    light: { shadowNormalBias: 0.12 },
    /*
     * THE TERRAIN SHADER IS 40% OF THE FRAME, so what it compiles matters more
     * here than anywhere else. MEASURED at 4x pixel ratio (which lifts the
     * frame clear of vsync, the only way a fragment saving is visible at all):
     * hiding the terrain saves 26.4 ms of a 43 ms frame — 6.6 ms at native,
     * out of 16.7.
     *
     * Almost none of that is in the features that can be switched with a
     * uniform: slope lock 0.24 ms, height contrast 0.12, macro variation 0.11,
     * height blend 0.08, auto-paint 0.03, triplanar 0.00. It is the
     * unconditional per-pixel blend itself, so the only lever that moves is
     * compiling less of it.
     *
     * These three are dead on THIS map, counted from its own splatmap rather
     * than assumed:
     *
     *   cursor     a game has no sculpt brush; also costs a sampler binding in
     *              a fragment stage already at WebGPU's 16-sampler ceiling
     *   snow       the snow layer covers 0.0% of nam-valley
     *   baseStyle  the base under the painted layers has weight exactly 0 on
     *              100.00% of the map — every pixel is fully painted, so the
     *              analytic grid is computed and then completely covered
     *
     * They are COMPILE-TIME, so switching them off removes the instructions
     * instead of multiplying them by zero. Anything the .v3proj actually uses
     * (lakebed, riverSand, flowerTint, grassFar, autoPaint) stays on.
     *
     * `?fat=1` restores the full set, so the saving can be A/B'd at any time
     * rather than taken on trust.
     */
    terrainFeatures: leanTerrain
      ? { cursor: false, snow: false, baseStyle: "flat" }
      : { cursor: false },
    /**
     * SIX PAINT LAYERS, NOT SEVEN. nam-valley's slot 6 is "Snow", and the
     * splatmap says it is painted on 0.00% of the map — counted over all
     * 2048² texels, not assumed. It was still sampled on every pixel, because
     * the layer block costs what is DECLARED, not what is painted.
     *
     * This is the only kind of terrain saving this backend gives up: a runtime
     * branch around the same taps is already known not to work (splatOverlayTsl
     * measured seven uniform branches costing 4.3 ms while switched off), and
     * neither smaller textures nor lower anisotropy moved the frame much. Only
     * the static tap count does.
     *
     * The slot still exists everywhere else — save format, texture library,
     * editor panel — so the map keeps its seventh layer and opens unchanged in
     * the editor. `?fat=1` compiles all seven back for the A/B.
     */
    //
    // TOP-3 + NEAR/FAR (splatOverlayTsl SPLAT_FEATURES.topK / farBlend): only
    // the three strongest layers are sampled per pixel, each at its fine tile
    // up close and a 5x tile faded in from 35 to 90 m. MEASURED at 3840x1778:
    // classic 35.5 ms, top-3 + far 35.0 — the same cost, and the road reads
    // clods and pebbles at play zoom where classic is flat red. `?topk=0`
    // brings the classic path back for an A/B.
    splatFeatures: leanTerrain
      ? { solo: false, layerBudget: 6, topK: 3, farBlend: true }
      : { solo: false, topK: 3, farBlend: true },
  });
  window.__rts = app; // handy for console debugging

  // Behind the loading screen the scene only needs to keep compiling what the
  // boot adds to it, not to render at 60 Hz: ~12 s of main thread went on
  // frames nobody saw. ONE a second until "ready" (reset just before it).
  // Even at four a second the trace put ~2.8 s of per-frame render work
  // (bindings, cache keys, draws — not material building) into the boot, and
  // nothing in the boot waits on an engine frame (checked), so a slower loop
  // cannot hold a stage up. The loading bar animates on its own rAF.
  app.setFrameThrottle?.(1000);

  if (fov != null) {
    app.camera.fov = fov;
    app.camera.updateProjectionMatrix();
  }

  // 2) Load world — default rts.v3proj, or ?world=/path/to/other.v3proj.
  // A level of another terrain size reloads the page at that size first; the
  // loader also refreshes the CPU height mirror after rivers/lakes carve.
  const levels = createLevelLoader(app, { defaultUrl: "/levels/nam-valley.v3proj", onStatus, onProgress });
  const worldState = { name: "procedural default" };
  const boot = await levels.loadBoot();
  // What the ENGINE put in the scene: the warm-up at the end leaves it alone.
  const engineObjects = snapshotEngineScene(app.scene);
  worldState.name = boot.name;

  // Swept yards under the village huts: from here on, a pad levelled through
  // app.flattenRect that asks for `ground: "swept"` gets one (everything else,
  // camp and temple, keeps its jungle). AFTER the level load, which replaces
  // the decal list wholesale.
  installBuildingAprons(app);
  // The x-ray silhouettes test the ground between a unit and the camera.
  xrayParams.heightTexNode = app.heightTexNode ?? null;

  // THE TERRAIN DRAWS LAST among the opaque things (renderOrder 8: after
  // everything at 0, before the sky, decals and river at 9+). It is the
  // dearest shader on screen and it was drawn FIRST, so every terrain pixel
  // was fully shaded and then painted over by the canopy, trees, grass,
  // buildings and units. Last, the depth test throws the hidden ones away
  // before the shader runs. MEASURED at x1.55 res: the "hilltop GPU spot"
  // (120, -40) 27.3 -> 18.8 ms, the base 20.8 -> 17.4, Point B 22.5 -> 20.6;
  // screenshot diff: same image. Safe while nothing opaque with depthWrite
  // off draws below 8 (checked: only decals 9, sky 9, river 10.5).
  for (const m of app.getTerrainMeshes?.() ?? []) m.renderOrder = 8;

  // Post-FX: the GAME owns its look. postFx.enabled defaults to false in the
  // engine and is NOT stored in the .v3proj, so without this the game gets no
  // bloom no matter what its materials do. Bloom is SELECTIVE (emissive MRT),
  // so only our combat FX / beacons glow — the terrain and sky don't.
  app.postFx?.setEnabled(true);
  app.postFx?.setBloomSelective(true);
  app.postFx?.setBloom({ enabled: true, strength: 0.85, threshold: 0.0, radius: 0.5 });

  // Valley height fog: low ground mist + distance haze, so hills peek through
  // and the map edge dissolves into the sky.
  //
  // ONLY when the level did not bring its own. A height fog is banded in
  // METRES, so it belongs to the MAP, not the game: numbers that suit a level
  // whose valleys sit at sea level will drown one whose playable floor is at
  // 40 m — the whole map turns white and reads as a failed load. A level that
  // carries a look (worldEnvironment.exportLook, saved in the .v3proj) has its
  // fog authored against its own heights, so leave it alone.
  // Cascades are a GAME decision, not a map one — worldEnvironment.exportLook
  // deliberately leaves shadow quality out of the .v3proj, so it has to be said
  // here rather than saved with the level.
  if (fittedShadows) app.shadows?.setEnabled?.(false);

  if (!boot.hasLook) {
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
  }

  // 3) Camera — two modes the project needs: "orbit" (engine's editor controls,
  //    for inspecting the world) and "rts" (WASD pan, wheel zoom,
  //    Q/E rotate, terrain-follow). Toggle with the HUD button or the C key.
  onStatus("Setting up camera…");
  const rtsCamera = createRtsCamera({ app });
  rtsCamera.setMode("rts"); // start in RTS view
  app.rtsCamera = rtsCamera;

  /**
   * FEWER PLANTS THE FURTHER OUT YOU ZOOM. Foliage is the biggest single cost
   * in the zoomed-out frame and it is a PIXEL cost: MEASURED at max zoom-out,
   * 1919x888, hiding the field saved ~4.3 ms of 21.1, its shadows ~0, and its
   * cost fell with plant count (density x0.5 → ~49% of it). Zooming out puts
   * thousands more plants on screen at a size where losing some of them is the
   * hardest thing to see, so the keep fraction follows zoomT: every plant up
   * to `from`, easing down to `far` at full zoom-out. The plants that go are
   * fixed per plant, so the field only changes while the camera zooms.
   * The dev panel edits `far` (Performance section).
   */
  const foliageZoom = { from: 0.35, far: 0.5 };
  const foliageKeepAt = (zoomT) => {
    const t = Math.min(1, Math.max(0, (zoomT - foliageZoom.from) / Math.max(1e-3, 1 - foliageZoom.from)));
    const s = t * t * (3 - 2 * t);
    return 1 + (foliageZoom.far - 1) * s;
  };

  // Nav grid — built once the world is loaded from terrain slope + lakes +
  // props + trees, so ground units path around steep terrain, water, and
  // obstacles. Toggle the debug overlay (N) to see blocked cells.
  onStatus("Building navigation…");
  const navGrid = createNavGrid({ app });
  app.navGrid = navGrid;

  // GROUND THE UNITS REFUSE MUST LOOK LIKE IT.
  //
  // The band ENDS at the pathfinder's own limit, so solid rock means "no" and
  // nothing else does. Below it the rock fades in over four degrees, which
  // reads as a warning — the rockier it gets the worse it is — rather than as
  // a contour line drawn across the hill. It only paints ground the map left
  // unpainted, so nam-valley's hand-painted cliffs are untouched; what it
  // fills in is precisely the steep ground nobody got to, which is the ground
  // players find inexplicable.
  // JUNGLE STONE. The editor kit's painted cool grey was authored for a
  // different world and reads as marble against this one; these numbers are
  // this GAME's, set at boot and saved nowhere, so the editor default and
  // every other game keep the look they were built around.
  app.setRockPalette?.(NAM_ROCK_PALETTE);

  // READABLE DAYLIGHT. MEASURED on nam-valley at play zoom (sRGB luma, game area):
  //
  //                                           mean   near-black (<40)
  //   16:48, zenith-only fill (as saved)        42         63%
  //   12:30, zenith-only fill                   65         14%
  //   12:30, whole-sky fill, hemi 1.25, 1.08    78          9%
  //
  // The sun time is the map's (saved in nam-valley.v3proj). This is the game's
  // noon: the Atmosphere sky takes its fill colour from the ZENITH alone, a deep
  // navy (#0c266f) that lit every shadow under the canopy almost black, while
  // skylight really comes from the whole dome, the pale haze included. skyFill
  // blends toward it. Set at boot and saved nowhere, like the rock palette, so
  // the editor and the other games keep their light.
  app.sky?.setWorldLight?.({ skyFill: 0.6, hemi: 1.25, exposure: 1.08 });

  // HOT AFTERNOON SUN (your ask, 2026-09-26: "a lack of contrast… something
  // that shows real hot sun"). The noon light above was lit mostly by the
  // SKY: shade and sun nearly the same brightness, the brightest pixels at
  // 128/255, the sunlit fifth of the frame green, not warm. Now the sun does
  // the work: lower (15:24, ~44° instead of 68° — longer shadows, depth), a
  // stronger key, less sky fill, exposure to keep the frame's mean where it
  // was; a light contrast grade. Measured (fog off): mean 82 -> 85, top 1%
  // 127 -> 154, the sunlit fifth warm (138,132,75). ?light=old = before.
  if (new URLSearchParams(location.search).get("light") !== "old") {
    app.sky?.setTimeOfDay?.(15.4);
    app.sky?.setWorldLight?.({ dir: 4.4, skyFill: 0.4, hemi: 1.0, exposure: 1.5 });
    app.postFx?.setPolish?.({ enabled: true, contrast: 1.1, saturation: 0.92, temperature: 0.12 });
  }

  app.setSlopeCliffRule?.({
    layer: 5,                            // "Cliff Rock" in nam-valley
    startDeg: NAV_MAX_SLOPE_DEG - 4,
    endDeg: NAV_MAX_SLOPE_DEG,
  });
  // THE CLIFFS (your pick, 2026-09-26): Rock058 — the editor library's
  // "Rock Alt", your L3 — on the cliff layer for this game: its big fractured
  // blocks survive the RTS distance, where cliff_rocks_07 mipped to a smooth
  // wall. And water streaks + bedding down the steep faces (engine
  // cliffStreaks.js), the look of wet tropical limestone. ?cliffs=old = before.
  if (new URLSearchParams(location.search).get("cliffs") !== "old") {
    const R = "/textures/pbr_materials/Rock058/Rock058_2K-JPG_";
    app.setTerrainLayerTextures?.(5, { albedo: `${R}Color.jpg`, normal: `${R}NormalGL.jpg`, rough: `${R}Roughness.jpg`, ao: `${R}AmbientOcclusion.jpg` })
      .catch((e) => console.warn("[cliffs] texture swap failed:", e));
    app.setCliffStreaks?.({ strength: 0.6 });
  }

  // The grass stops where the rock starts: none on ground units cannot walk,
  // thinning over the same band the cliff paint fades in. nam-valley saved the
  // grass slope rule OFF, and blades stood up the terrace walls.
  app.setGrassSlopeRule?.({
    startDeg: NAV_MAX_SLOPE_DEG - 4,
    endDeg: NAV_MAX_SLOPE_DEG,
  });

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
  const healthBars = createHealthBarField({ scene: app.scene, groundAt: (x, z) => app.getWorldHeight(x, z) });
  app.healthBars = healthBars;

  // Every selection ring in the game is likewise ONE instanced draw, and it
  // drapes itself over the terrain in the vertex shader — so selecting 200 units
  // costs 1 draw call and no CPU height sampling at all.
  const selectionRings = createSelectionRingField({ app });
  app.selectionRings = selectionRings;
  // Square buildings get corner brackets instead (selectionFrameField.js).
  const selectionFrames = createSelectionFrameField({ app });
  app.selectionFrames = selectionFrames;

  // The economy. Created BEFORE structures so the base can charge for production,
  // but its nodes are placed after — node siting flattens terrain too, and doing
  // it in one pass with the structures keeps the nav rebuild to a single pass.
  const resources = await createResources({ app });
  // The economy is REQUISITION POINTS: ground you hold pays supplies
  // (requisition.js). The harvester economy survives as ?econ=harvest.
  const HARVEST = new URLSearchParams(location.search).get("econ") === "harvest";
  const requisition = createRequisition({
    app, resources,
    // The HQ's own trickle, while it stands (read late: structures come next).
    hqStanding: () => app.structures?.base?.alive !== false && !!app.structures?.base,
    // The enemy commander is paid by the same rules, into its own purse
    // (enemyAI.js, built once the units exist — read late).
    enemyResources: { earn: (n) => app.enemyAI?.purse.earn(n) },
    enemyHqStanding: () => !!app.structures?.enemyBase?.alive,
    // Taking a point pops M18 VIOLET — the Apocalypse Now marker.
    onCapture: (p, team) => { if (team === "player") app.smoke?.spawn({ x: p.position.x, z: p.position.z, kind: "violet" }); },
  });
  app.requisition = requisition;
  const MAST_FP = buildRequisitionMast().userData.footprint;
  app.resources = resources;

  onStatus("Placing structures…");
  const OLD_LINE = new URLSearchParams(location.search).get("line") === "old";
  const structures = await createStructures({
    app, navGrid, resources,
    // The camp's firing range — targets to test craters and combat on.
    dummies: new URLSearchParams(location.search).get("dummies") !== "0",
    // The Front's line is SITED by the ground now (enemyLine.js, below, once
    // the nav grid exists). ?line=old brings the five formula nests back.
    turretCount: OLD_LINE ? 5 : 0,
  });
  app.structures = structures;

  // THE ENEMY PLAYS (enemyAI.js): its HQ stands from the start — it recruits
  // there — and the match is on: destroy it to win, lose yours and you lose.
  // ?ai=0 boots the old sandbox (no enemy HQ, no commander).
  const AI_ON = new URLSearchParams(location.search).get("ai") !== "0";
  if (AI_ON) {
    await structures.spawnEnemyBase();
    // And its tunnel entrances, where its men come up (pointSites.js).
    await structures.placeTunnels(tunnelSitesFor(boot.name));
    // A ZPU-4 in front of the résidence from the start: your Hueys do not
    // get to shoot up its HQ for free.
    const eb = structures.enemyBase;
    if (eb) await structures.placeEnemy("zpu", eb.position.x + 16, eb.position.z - 22);
  }

  // A FIREBASE IS BULLDOZED BARE. nam-valley's jungle paint runs straight over
  // the HQ site, and with a hangar box it did not show — the palms were inside
  // it. The Quonset is a barrel you can see over, and palms came up through it.
  // Cleared around the BUILDING's own centre, which is 2 m behind the base
  // point: the door is on the -Z face and the barrel runs 20 m back from it.
  // Grass too, over a tighter disc — it grew up through the Quonset's floor and
  // showed in the open doorway; the yard around an HQ is bare, trampled earth.
  // Runtime only (see app.clearVegetation), so it runs again after every load.
  //
  // And PROPS whose footprint overlaps the building: nam-valley has a
  // megalith on the terrace edge behind the HQ, and it read as a rock on the
  // Quonset's roof. Removed from the loaded scene only — the map keeps it.
  // Footprint in world space (the HQ is rotated PI, door toward -Z): 11 m
  // either side (blast walls included), from the blast walls' front 13 m before
  // the base point to the gable 12 m behind it, plus a metre of air.
  const clearHqGround = () => {
    // The enemy's MG nests too: every one stands in jungle, and palms grew up
    // through the pit. A dug position has its own ground — the jungle stays
    // round it, which is what hides it.
    for (const t of structures.turrets) app.clearVegetation?.(t.position.x, t.position.z, 8, { grass: 6 });
    for (const z of structures.zpus) app.clearVegetation?.(z.position.x, z.position.z, 7, { grass: 5 });
    for (const t of structures.list) if (t.alive && t.typeKey === "tower") app.clearVegetation?.(t.position.x, t.position.z, 12, { grass: 5 });
    for (const m of structures.mortars) app.clearVegetation?.(m.position.x, m.position.z, 5, { grass: 4 });
    // A tunnel mouth: the shaft and its spoil ring, trodden bare — the jungle
    // round it is the point. At 3.5 m the ferns (metres across) still closed
    // over it and it could not be found even by looking straight at it.
    for (const t of structures.tunnels) app.clearVegetation?.(t.position.x, t.position.z, 6, { grass: 4.5 });
    // And the requisition masts: the jungle off the tower and its hut, the
    // grass kept — the zone round it is ground to fight over, not a lawn.
    for (const p of requisition.points) {
      app.clearVegetation?.(p.position.x - 1.3, p.position.z, 9, { grass: 5 });
      // Rocks inside the mast's footprint go (the props arrive with the level,
      // after the points are sited — this runs again once they are in).
      const ps = app.propStore;
      const x = p.position.x + MAST_FP.cx, z = p.position.z + MAST_FP.cz;
      for (let i = (ps?.instances?.length ?? 0) - 1; i >= 0; i--) {
        const inst = ps.instances[i];
        if (Math.abs(inst.px - x) < MAST_FP.hx + 2 && Math.abs(inst.pz - z) < MAST_FP.hz + 2) ps.removeInstance(i);
      }
    }
    // The enemy HQ's own clearing, and a forecourt in front of it (-Z, toward
    // the camera): an 11 m palm leaning in from 23 m out laid its crown right
    // across the façade.
    const eb = structures.enemyBase;
    if (eb?.alive) {
      app.clearVegetation?.(eb.position.x, eb.position.z, 24, { grass: 18 });
      app.clearVegetation?.(eb.position.x, eb.position.z - 18, 22);
    }
    const b = structures.base;
    if (b?.alive === false) return;
    app.clearVegetation?.(b.position.x, b.position.z + 2, 27, { grass: 23 });
    const ps = app.propStore;
    if (!ps?.instances) return;
    const x0 = b.position.x - 12, x1 = b.position.x + 12;
    const z0 = b.position.z - 14, z1 = b.position.z + 13;
    for (let i = ps.instances.length - 1; i >= 0; i--) {
      const inst = ps.instances[i];
      const box = ps.types[inst.typeIdx]?.mergedBox;
      if (!box) continue;
      const r = Math.max(Math.abs(box.min.x), Math.abs(box.max.x), Math.abs(box.min.z), Math.abs(box.max.z))
        * Math.max(Math.abs(inst.sx ?? 1), Math.abs(inst.sz ?? 1));
      const cx = Math.max(x0, Math.min(inst.px, x1)), cz = Math.max(z0, Math.min(inst.pz, z1));
      if (Math.hypot(inst.px - cx, inst.pz - cz) < r) ps.removeInstance(i);
    }
  };
  clearHqGround();

  /**
   * The requisition points: sited like the old nodes, each mast on a levelled
   * pad, its footprint blocked in nav (the legs, the hut, the bags), the rocks
   * inside it removed.
   */
  async function placeRequisitionPoints() {
    const fp = MAST_FP;
    // The map's authored sites (pointSites.js), or the old fan.
    for (const p of requisition.placePoints(structures.base.position, pointSitesFor(boot.name))) {
      const x = p.position.x + fp.cx, z = p.position.z + fp.cz;
      await app.flattenRect?.(x, z, fp.hx + 0.5, fp.hz + 0.5, p.position.y, { rim: 3 });
      p.position.y = app.getWorldHeight(p.position.x, p.position.z);
      navGrid.addFootprint(x, z, fp.hx, fp.hz, 0);
    }
    clearHqGround();
  }

  onStatus("Seeding resource nodes…");
  if (HARVEST) await resources.placeNodes(structures.base.position);
  else await placeRequisitionPoints();

  onStatus("Re-baking navigation…");
  navGrid.rebuild(); // the ground under every building AND node changed
  for (const s of structures.list) {
    navGrid.addStructureObstacle(s);
  }

  // THE FRONT'S LINE (enemyLine.js): nests, towers, a ZPU and spider holes
  // sited where they cover the ways in — nav paths from our HQ to theirs and
  // to the capture points — instead of five nests on a formula.
  if (AI_ON && !OLD_LINE && structures.enemyBase?.alive) {
    onStatus("Digging in the Front's line…");
    const t0 = performance.now();
    const line = siteEnemyLine(app, {
      navGrid,
      playerHQ: structures.base.position,
      enemyHQ: structures.enemyBase.position,
      points: (requisition?.points ?? []).map((p) => p.position),
    });
    const tSite = performance.now() - t0;
    let n = 0;
    // A picked spot the builder cannot level falls back to the planner's next
    // best, quietly (it used to warn and drop the position).
    const placeFirst = async (key, p) => {
      for (const q of [p, ...(p.alts ?? [])]) {
        const s = await structures.placeEnemy(key, q.x, q.z, { quiet: true });
        if (s) return s;
      }
      console.warn(`[enemy line] no buildable ground for a ${key} near (${p.x | 0}, ${p.z | 0}) or its alternatives`);
      return null;
    };
    for (const p of line.nests) if (await placeFirst("turret", p)) n++;
    for (const [i, p] of line.towers.entries()) {
      const s = await placeFirst("tower", p);
      if (s) { s.facing = (i * 2.3 + 0.4) % (Math.PI * 2); n++; }
    }
    for (const p of line.zpus) if (await placeFirst("zpu", p)) n++;
    // Spider holes are dug in as the ground stands: a levelled disc in the
    // jungle is exactly the tell a hidden thing must not have.
    for (const p of line.spiderHoles) { const s = structures.addNow("spiderHole", p.x, p.z); s.deploy = 1; n++; }
    for (const s of structures.list) if (s.alive) navGrid.addStructureObstacle(s);
    console.log(`[enemy line] ${n} positions over ${line.paths} ways in: sited in ${Math.round(tSite)} ms, levelled and placed in ${Math.round(performance.now() - t0 - tSite)} ms`, line);
  }
  // Resource nodes are deliberately NOT nav obstacles: a harvester has to be able
  // to park on one, and blocking the footprint just makes it stall at the edge.

  // Resource renderer + flag first — no unit dependency.
  const resourceRenderer = createResourceRenderer({ app, resources });
  app.resourceRenderer = resourceRenderer;

  const baseFlag = createBaseFlag({ app, structures });
  app.baseFlag = baseFlag;

  onStatus("Spawning units…");
  // No harvesters without the harvest economy: the opening army takes points.
  const units = createUnits({
    app, navGrid, origin: structures.base.position,
    ...(HARVEST ? {} : { spawn: { jeep: 8, helicopter: 4, soldier: 6 } }),
  });
  app.units = units;

  const buildings = createBuildings({
    app, structures, units, navGrid,
    // A relay coming online pops M18 VIOLET — the Apocalypse Now marker. Read
    // through app because the smoke field is built further down; by the time a
    // building can finish, the loop is running and it exists.
    onComplete: (b) => {
      // A finished building gives cover at once (a gun pit's bags stop bullets).
      // MEASURED: a bake is ~4 ms — a one-off, once per building.
      app.cover?.bake?.();
      if (b.team !== "enemy") app.sounds?.done(b);
      if (b.typeKey !== "captureNode") return;
      app.smoke?.spawn({ x: b.position.x, z: b.position.z, kind: "violet" });
    },
  });
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

  const requisitionRenderer = createRequisitionRenderer({ app, requisition, fogOfWar });
  app.requisitionRenderer = requisitionRenderer;

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

  // ONE bottom HUD bar: status strip (supplies), minimap · selection · command
  // card. The modules below render into its slots; see hudBar.js.
  const hud = createHudBar();
  app.hud = hud;

  const resourceHud = createResourceHud({ mount: hud.strip });
  app.resourceHud = resourceHud;

  // Combat: units fire VISIBLE rockets with exhaust trails; damage lands on
  // impact. Wrecks catch fire. All of it glows via the engine's emissive MRT.
  const fx = createCombatFx({ app });
  app.fx = fx;
  app.combatFx = fx;

  // Fire: the flipbook flames (flameField.js — a real fire sim, coloured by
  // heat in the shader) unless the URL asks for the old procedural blobs,
  // kept for the A/B: ?fire=procedural. Same interface either way.
  const fire = new URLSearchParams(location.search).get("fire") === "procedural"
    ? createFireSystem({ app })
    : createFlameField({ app });
  // The rolling fireball at the moment napalm lands (fireballField.js — a
  // flipbook of a real fire sim, one instanced draw).
  const fireballs = createFireballField({ app });
  app.fireballs = fireballs;
  app.fire = fire;

  // Smoke is the one effect that is also a RULE: a screening cloud really does
  // break a firing line. Its columns are sim state, aged on the fixed clock,
  // and combat asks them whether it can see. See smokeField.js.
  const smoke = createSmokeField({ app });
  app.smoke = smoke;

  onStatus("Loading crater decals…");
  const craters = await createCraterSystem({ app });
  app.craters = craters;

  // Birds: flocks crossing the view, and flocks FLUSHED out of the jungle by
  // any blast — every explosion and every crater (shells, napalm bombs) asks;
  // the birds decide (jungle there? this spot flushed recently?). A sign of
  // fighting you can read from across the map. See rtsBirds.js.
  // `units`: a stand of egrets on the river goes up when men, a vehicle or a
  // helicopter come near it.
  const birds = createRtsBirds({ app, units });
  app.birds = birds;

  // The grass remembers where your men walked (grassTrails.js). The engine's
  // push field is built round the camera's focus, so that is what it is asked
  // for; everything outside it is skipped before any work is done.
  const grassTrails = createGrassTrails({
    app, units,
    focus: () => app.controls?.target ?? rtsCamera.getView?.()?.focus ?? null,
  });
  app.grassTrails = grassTrails;
  {
    const explosion = fx.explosion;
    // The blast's size decides how many birds the canopy loses (rtsBirds.flush);
    // a man going down (the dust puff) flushes nothing.
    fx.explosion = (x, y, z, opts) => { explosion(x, y, z, opts); if (!opts?.dust) birds.flush(x, z, { size: opts?.size ?? 10 }); };
    const addCrater = craters.addCrater?.bind(craters);
    if (addCrater) craters.addCrater = (x, z, ...rest) => { const r = addCrater(x, z, ...rest); birds.flush(x, z, { size: (rest[0] ?? 4) * 2.2 }); return r; };
  }

  // SOUND (namSounds.js → namAudio.js): wraps the effects above so each is
  // heard, and hands projectiles its `sfx`. Recordings: public/sounds/nam.
  const sounds = createNamSounds({ app, rtsCamera, units, buildings, fx, fire, fireballs, smoke, birds });
  app.sounds = sounds;

  // Late-bound: projectiles need combat.onImpact, combat needs projectiles.
  let combatRef = null;
  const projectiles = createProjectiles({
    app, fx,
    // Every shot is heard (namSounds) and puts up any egrets standing near it.
    sfx: { ...sounds.sfx, shot: (owner, w, at) => { sounds.sfx.shot(owner, w, at); birds.disturb(at.x, at.z); } },
    onImpact: (target, dmg, at, owner, opts) => combatRef?.onImpact(target, dmg, at, owner, opts),
    // A mortar shell lands on GROUND, not on a unit (projectiles.spawnArc).
    onArcImpact: (at, dmg, splash, owner) => combatRef?.splashAt(at, dmg, splash, owner),
  });
  app.projectiles = projectiles;

  // COVER AND CONCEALMENT, before combat because combat asks it on every
  // acquire. Concealment reads the engine's painted vegetation live; cover is
  // baked from the props, which on nam-valley are placed AFTER the level
  // loads — so bake() is called once the world is up, not here.
  const cover = createCover({ app, worldSize: app.worldSize ?? 2048 });
  app.cover = cover;

  const combat = createCombat({
    units, structures, fx, structuresRenderer, projectiles, fire, craters, smoke, cover,
    onDeath: (entity) => { app.selection?.remove?.(entity); app.controlGroups?.render(); },
  });
  combatRef = combat;
  app.combat = combat;

  // The Front's cheap war (traps.js): what is hidden out there, who has found
  // it, and what it does to the man who did not. It needs combat for the
  // damage, the nav grid to make a FOUND trap walkable-around, and both purses
  // — a cache pays them while it stands and pays you when it burns.
  const traps = createTraps({
    structures, units, combat, navGrid, resources,
    enemyEarn: (n) => app.enemyAI?.purse.earn(n),
    // Found: the jungle comes off it. A cache is a big thing under a mat and
    // needs a yard; a tripwire only needs the leaves round its stakes gone.
    onReveal: (s) => {
      const r = s.typeKey === "cache" ? 5 : s.typeKey === "boobyTrap" ? 2.4 : 3.6;
      app.clearVegetation?.(s.position.x, s.position.z, r, { grass: r * 0.8 });
    },
    onLog: (line) => console.log(`[traps] ${line}`),
  });
  app.traps = traps;

  // Napalm is assembled from fire + smoke + craters + combat; it owns only the
  // SHAPE of a run and what it does to whoever is standing in it.
  const napalm = createNapalmStrike({
    app, fire, fireballs, smoke, craters, combat, units, structures,
  });
  app.napalm = napalm;

  // The player's verbs. The rule lives here and in the sim; the cursor is a
  // separate file that never casts anything itself.
  const abilities = createAbilities({ game: { smoke, napalm }, resources });
  app.abilities = abilities;

  // Dev: the stress benchmark prices each ingredient of a battle — spawned
  // directly, never through combat or waves, which will change. Idle unless
  // the dev panel's Stress section is used.
  const stress = createStressTest({ app, units, smoke, fire, fx, projectiles, napalm, rtsCamera });
  app.stress = stress;

  // Hold V to see the ground. Armed only when something is selected: the
  // question it answers is "where do I send THESE men", and with nothing
  // selected there is nobody to send.
  const coverOverlay = createCoverOverlay({
    app, cover,
    isArmed: () => (app.selection?.selected?.length ?? 0) > 0,
  });
  app.coverOverlay = coverOverlay;

  // The opponent. Enemy waves muster off-map, march on the base, and fight — all
  // of it through the EXISTING combat system, which is team-based and never knew
  // the difference. They also cost no draw calls: enemy units join the same
  // instanced fields / compute-skinned crowd as ours, tinted per instance.
  const waves = createWaves({ app, units, structures, navGrid });
  app.waves = waves;

  // The enemy commander: squads that take, hold and attack points, fall back,
  // and fight from cover. Orders only — combat.js still does the fighting.
  const enemyAI = createEnemyAI({
    units, structures, requisition, navGrid, cover,
    // Digging in, in play: the structure as the ground stands (no flatten —
    // a GPU round trip mid-battle), its footprint into nav, its pit cleared
    // of jungle, cover re-baked (~4 ms, once).
    emplace: (typeKey, x, z) => {
      const s = structures.addNow(typeKey, x, z);
      // The cheap nasty kit is HIDDEN: no nav stamp (your pathfinder walking
      // round an invisible pit would give it away), no clearing (the jungle
      // over it is what hides it), no cover. traps.js stamps it when it is
      // found, and that is the reward for finding it.
      if (s.concealed) return s;
      navGrid.addStructureObstacle(s);
      app.clearVegetation?.(x, z, 6, { grass: 4.5 });
      cover.bake();
      return s;
    },
    // A tube fires: the shell leaves its muzzle and arcs onto the ground at
    // (x, z) — the warning ring is drawn while it is up (projectiles.js).
    fireMortar: (m, x, z, { damage, splash }) => {
      const from = structuresRenderer.muzzleOf(m);
      const y = app.getWorldHeight?.(x, z) ?? 0;
      projectiles.spawnArc(from, { x, y, z }, { damage, splash, owner: m });
      fx.muzzle(from.x, from.y, from.z);
    },
  });
  enemyAI.setEnabled(AI_ON);
  app.enemyAI = enemyAI;

  const waveHud = createWaveHud();
  app.waveHud = waveHud;

  // Portraits for the HQ, every building and the enemy's nests, into the same
  // map as the units' (structureThumbnails.js, keyed by thumbKeyOf).
  if (unitRenderer.thumbnails) {
    await bakeStructureThumbnails(app.renderer, unitRenderer.thumbnails).catch((e) => console.warn("[thumbs] structures:", e));
  }

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
    mount: hud.centre,
  });
  app.unitBar = unitBar;

  // Player-facing HUD: command card (bottom-right). Shows unit commands, or the
  // base's PRODUCTION queue when the base is selected.
  // The ability cursor. getSelection is a thunk because selection is built
  // AFTER the command card (the card is one of its listeners), so the reference
  // has to be resolved at click time rather than captured here.
  const abilityTargeting = createAbilityTargeting({
    app, abilities,
    getSelection: () => app.selection?.selected ?? [],
    onCast: (a, at) => {
      abilities.cast(a, app.selection?.selected ?? [], at);
      commandCard.render(app.selection?.selected ?? []);   // repaint the cooldown
    },
  });
  app.abilityTargeting = abilityTargeting;

  const commandCard = createCommandCard({
    thumbnails: unitRenderer.thumbnails,
    // What a selected structure can produce: the base makes ground units +
    // builders; a helipad makes helicopters. Helicopters come ONLY from a helipad.
    productionFor: (s) => (
      s.typeKey === "base"
        ? [
            ...(HARVEST ? [{ key: "harvester", label: "Harvester", cost: UNIT_COST.harvester }] : []),
            { key: "soldier", label: "Soldier", cost: UNIT_COST.soldier },
            { key: "jeep", label: "M151 Jeep", cost: UNIT_COST.jeep },
            { key: "builder", label: "M35 Engineers", cost: UNIT_COST.builder },
            { key: "bigtank", label: "M113 ACAV", cost: UNIT_COST.bigtank },
            { key: "lightTank", label: "M551 Sheridan", cost: UNIT_COST.lightTank },
            { key: "tank", label: "M48 Patton", cost: UNIT_COST.tank },
          ]
        // Helipad units are free in this pass — only base production is costed.
        : s.typeKey === "helipad"
          ? [{ key: "helicopter", label: "UH-1 Huey" }]
          : []
    ),
    canAfford: (cost) => resources.canAfford(cost),
    onBuild: (structure, key) => structure.enqueue(key),
    structureBuilds: [
      // Short labels (four across in the card); the tooltip says what it does.
      { key: "helipad", label: "Helipad", tip: "Helipad — builds helicopters" },
      { key: "turret", label: "M60 Pit", tip: "M60 gun pit — defends itself, hits air" },
      { key: "radio", label: "Radio", tip: "Radio Station — the tactical map and wider vision" },
      ...(HARVEST ? [{ key: "captureNode", label: "Relay", tip: "Supply Relay — income" }] : []),
      { key: "watchTower", label: "Tower", tip: "Guard Tower — sees 110 m, over the canopy" },
      { key: "medicTent", label: "Aid Stn", tip: "Aid Station — heals infantry within 18 m" },
      { key: "sandbagWall", label: "Bags", tip: "Sandbag Wall — cover you build, faces away from the HQ" },
      { key: "bunker", label: "Bunker", tip: "Bunker — HARD cover (80%, against 55% for rocks and bags)" },
    ],
    buildingCosts: BUILDING_COST,
    onBuildStructure: (key, selected) => buildPlacement.begin(key, selected),
    // Abilities the current selection can cast, with their live cooldowns. The
    // card asks every frame rather than being pushed at, for the same reason it
    // re-checks affordability: a cooldown that only refreshed on re-selection
    // would show "ready" on a button that is not.
    abilitiesFor: (selected) => abilities.forSelection(selected).map((a) => {
      const c = abilities.check(a, selected);
      return {
        key: a.key, label: a.label, hint: a.hint, cost: a.cost,
        ready: c.ok, cooldown: Math.ceil(abilities.cooldownLeft(a, c.caster ?? abilities.pickCaster(a, selected))),
      };
    }),
    // What the selection's LEAD unit is standing in. The lead rather than an
    // average: a group strung across a treeline is partly concealed and partly
    // not, and averaging that into "40% hidden" tells the player nothing they
    // can act on.
    stanceFor: (selected) => {
      const u = selected?.find((e) => !e.isStructure) ?? selected?.[0];
      if (!u?.position) return null;
      return {
        concealment: cover.concealmentAt(u.position.x, u.position.z),
        cover: cover.coverAt(u.position.x, u.position.z),
        revealed: (u.revealed ?? 0) > 0,
      };
    },
    onAbility: (key, selected) => {
      const a = abilities.ABILITIES[key];
      if (!a || !abilities.check(a, selected).ok) return;
      buildPlacement.cancel();
      abilityTargeting.begin(a);
    },
    onStop: () => { for (const u of app.selection?.selected ?? []) u.stop?.(); },
    onFocus: () => {
      const sel = app.selection?.selected ?? [];
      if (!sel.length) return;
      const cx = sel.reduce((s, u) => s + u.position.x, 0) / sel.length;
      const cz = sel.reduce((s, u) => s + u.position.z, 0) / sel.length;
      rtsCamera.focusOn(cx, cz);
    },
    mount: hud.right,
  });
  app.commandCard = commandCard;

  const selection = createSelection({
    app, units, unitRenderer, structuresRenderer, buildingRenderer,
    resourceRenderer, harvesting, // right-click a node → send harvesters to it
    onOrder: (kind, list) => sounds.order(kind, list),
    // The unit bar shows units only; buildings live in the command card.
    onChange: (sel) => {
      // Units if any; otherwise the selected building, so the centre is never
      // blank while something is selected.
      const mobile = sel.filter((e) => !e.isStructure);
      unitBar.render(mobile.length ? mobile : sel.slice(0, 1));
      commandCard.render(sel);
      app.controlGroups?.render();
    },
  });
  app.selection = selection;

  // CONTROL GROUPS (controlGroups.js): Ctrl+1..9 make, 1..9 recall (twice:
  // centre the camera), Shift+1..9 add; chips above the command panel.
  const controlGroups = createControlGroups({
    app, selection, mount: hud.root.querySelector(".block-right"),
  });
  app.controlGroups = controlGroups;

  // Player-facing HUD: minimap (bottom-left). Baked terrain + unit blips +
  // camera viewport; click/drag to move the camera.
  const minimap = createMinimap({ app, units, buildings, structures, fogOfWar, requisition, mount: hud.left });
  app.minimap = minimap;

  const syncNavObstacles = () => {
    navGrid.rebuild();
    for (const s of structures.list) {
      if (s.alive) navGrid.addStructureObstacle(s);
    }
    // Cover reads the SAME props nav does, so it is rebaked in the same breath.
    // Letting them drift would give the player a rock that blocks movement but
    // stops no bullets, and they would be right to call it a bug.
    cover.bake();
  };

  const match = createMatch({
    structures,
    onTerrainChanged: async () => {
      syncNavObstacles();
      minimap.rebuildTerrain();
    },
  });
  app.match = match;
  if (AI_ON) match.setEnabled(true);   // the HQ is already standing: no terrain change

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
    await gradeBridgeLandings(app).catch((e) => console.warn("[bridges] landings failed:", e));
    clearHqGround();              // the load restored the saved paint over it
    app.setGrassSlopeRule?.({ startDeg: NAV_MAX_SLOPE_DEG - 4, endDeg: NAV_MAX_SLOPE_DEG }); // and the grass state
    for (const b of buildings.list) {
      b.position.y = app.getWorldHeight?.(b.position.x, b.position.z) ?? b.position.y;
    }
    // Resource nodes sit on the ground like everything else — re-seat them too, or
    // they float/sink after a world swap.
    for (const n of resources.nodes) {
      n.position.y = app.getWorldHeight?.(n.position.x, n.position.z) ?? n.position.y;
    }
    for (const p of requisition.points) p.position.y = app.getWorldHeight?.(p.position.x, p.position.z) ?? p.position.y;
    requisitionRenderer.placeMasts();
    baseFlag?.reanchor();
    const navOn = devPanel?.getNavDebug?.() ?? false;
    navGrid.rebuild();
    for (const s of structures.list) {
      navGrid.addStructureObstacle(s);
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
    birds.worldReady();                  // a new river: new banks
    devPanel.setWorldName(worldState.name);
  };

  const devPanel = createDevPanel({
    app, navGrid, rtsCamera, units, minimap, foliageZoom, stress, sounds,
    worldName: worldState.name,
    onLoadWorldFile: async (file) => afterWorldLoad(await levels.loadFile(file)),
    onLoadDefaultWorld: async () => afterWorldLoad(await levels.loadDefault()),
    onReseat: reseatWorld,
  });
  app.devPanel = devPanel;

  app.loadWorldFile = async (file) => afterWorldLoad(await levels.loadFile(file));
  app.loadDefaultWorld = async () => afterWorldLoad(await levels.loadDefault());
  app.worldName = () => worldState.name;

  // Frame the camera on the base at boot.
  rtsCamera.focusOn(structures.base.position.x, structures.base.position.z);

  // 5) ── THE GAME LOOP ──────────────────────────────────────────────────────
  //
  //    Two clocks, and the split is the point.
  //
  //    THE SIM runs in fixed 60 Hz steps (simClock.js). Everything that decides
  //    an OUTCOME lives here — how fast a unit walks, when a weapon comes off
  //    cooldown, when a building finishes, when a wave spawns, when a rocket
  //    lands. These used to advance by however long the last frame happened to
  //    take, which means the game behaved differently on a 144 Hz monitor than
  //    a 60 Hz one, and differently again across a hitch.
  //
  //    THE FRAME runs once per render with the real dt: the camera, everything
  //    that pushes state into meshes, the HUD and the minimap. None of it
  //    decides anything; it only draws what the sim already decided.
  //
  //    Order still matters inside each: input/camera → sim → push into meshes →
  //    HUD. Both run in ONE pre-render hook on the engine loop (not a separate
  //    rAF), which is what keeps fog-of-war in sync with the render pass.
  //
  //    projectiles and fire are MIXED — rocket homing and wreck timers next to
  //    billboard puffs — and sit on the sim side, because when damage lands is
  //    an outcome and a puff is not. At 60 Hz they draw identically anyway.
  const sim = createSimClock({ hz: 60 });
  app.simClock = sim;

  const simStep = (dt) => {
    waves.update(dt);                     // spawn the next wave, keep them marching
    enemyAI.step(dt);                     // the enemy commander: recruit, choose, order
    structures.updateProduction(dt, (key, x, z, opts) => units.spawn(key, x, z, opts));
    buildings.update(dt);                 // construction ramp + helipad production
    resources.tickCaptureIncome(dt, buildings);
    requisition.step(dt, units.list);      // who stands on which point; income
    harvesting.update(dt);                // node → fill → base → unload → repeat
    units.update(dt);
    combat.update(dt);                    // acquire → chase → launch rockets
    traps.step(dt);                       // who found what; who stepped on what
    match.update(dt);                     // win/lose when enemy HQ match is on
    projectiles.update(dt, app.camera);   // rockets fly, trail, and land damage
    fire.update(dt, sim.simTime);         // burning wrecks
    smoke.step(dt);                       // columns age here; the puffs do not
    napalm.step(dt);                      // the run lands, burns, kills, scars
    abilities.step(dt, units.list);       // cooldowns
    cover.step(dt, units.list);           // "I just fired" reveal timers
  };

  // Dev: run the SIM ahead without drawing — to watch the enemy commander
  // play out minutes of a battle in seconds (and in a background tab, whose
  // frames the browser throttles to almost nothing). __NAM.fastForward(120)
  app.fastForward = (seconds) => {
    const n = Math.round(seconds / sim.stepSeconds);
    for (let i = 0; i < n; i++) simStep(sim.stepSeconds);
  };

  // The RENDER clock the smoke puffs ride. Deliberately not sim.simTime: the
  // sim can take several steps in one frame or none, and a puff that jumped
  // would read as a stutter in something that should drift.
  let renderTime = 0;

  // The game's own CPU per frame — everything in tick — for the stress
  // benchmark's price list. Two performance.now() calls; nothing else reads it.
  const frameStats = { tickMs: 0 };
  app.frameStats = frameStats;

  // Every system in its own guard: one that throws (a "Cannot read
  // properties of null (reading 'x')" killed the WHOLE frame's work, with no
  // name) is logged once with its name and stack, and the rest still runs.
  const _tickErred = new Set();
  const guard = (name, fn) => {
    try { fn(); } catch (err) {
      if (!_tickErred.has(name)) { _tickErred.add(name); console.error(`[nam] ${name} threw:`, err, "\n", err?.stack ?? ""); }
    }
  };
  const tick = (dt) => {
    const tickStart = performance.now();
    renderTime += dt;
    guard("rtsCamera", () => { rtsCamera.update(dt); });                 // input, at the real frame rate
    guard("setFoliageThin", () => { app.setFoliageThin?.(foliageKeepAt(rtsCamera.getView().zoomT)); });
    guard("sim", () => { sim.advance(dt, simStep); });
    guard("fogOfWar", () => { fogOfWar.update(dt); });                  // vision grid → GPU shroud texture
    guard("resourceRenderer", () => { resourceRenderer.sync(); });              // only rewrites when a node visibly drains
    guard("healthBars", () => { healthBars.begin(); });                   // both renderers push their bars into it
    guard("selectionRings", () => { selectionRings.begin(); });               // unitRenderer pushes a ring per selected unit
    guard("projectiles", () => { projectiles.drawWarnings(selectionRings); }); // where a shell in the air is going to land
    guard("selectionFrames", () => { selectionFrames.begin(); });              // square buildings push corner brackets
    guard("unitRenderer", () => { unitRenderer.sync(dt, app.camera); });
    guard("structuresRenderer", () => { structuresRenderer.sync(dt, app.camera); });
    guard("buildingRenderer", () => { buildingRenderer.sync(dt, app.camera); });
    guard("requisitionRenderer", () => { requisitionRenderer.sync(dt); });
    guard("healthBars", () => { healthBars.commit(); });
    guard("selectionRings", () => { selectionRings.commit(); });
    guard("selectionFrames", () => { selectionFrames.commit(); });
    guard("fx", () => { fx.update(dt, app.camera); });            // muzzle / impact / explosion
    guard("smoke", () => { smoke.render(renderTime, app.environment?.getLightDirection?.()); });
    guard("fireballs", () => { fireballs.render(renderTime); });         // napalm fireballs: the flipbook clock
    guard("updatePlantedPlants", () => { updatePlantedPlants(app, app.camera, app.environment?.getLightDirection?.()); });
    guard("ricePaddies", () => { app.ricePaddies?.crop?.update(app.camera); });   // the rice plants round the camera
    guard("ricePaddies", () => { app.ricePaddies?.reflections?.update(); });       // their water's reflections (post)
    guard("buffalo", () => { app.buffalo?.update(dt); });                      // the water buffalo's clips
    guard("wildHerds", () => { for (const h of app.wildHerds ?? []) h.update(dt); });   // sambar, muntjac
    guard("chickens", () => { app.chickens?.update(dt); });                     // the hamlet's hens
    // Point the overlay at the selection until the pointer has moved, so
    // holding V before touching the mouse reveals the ground under the men
    // rather than a patch of the map's centre.
    guard("cover fallback", () => {
      const sel = app.selection?.selected ?? [];
      const u = sel.find((e) => !e.isStructure) ?? sel[0];
      if (u?.position) coverOverlay.setFallback(u.position.x, u.position.z);
    });
    guard("coverOverlay", () => { coverOverlay.update(dt); });              // hold V — decides nothing, only draws
    guard("baseFlag", () => { baseFlag?.update(dt); });                 // HQ flag cloth sim
    guard("enemyCampFlag", () => { app.enemyCampFlag?.update(dt, app.camera); }); // the NLF flag (skipped off screen)
    guard("commandCard", () => { commandCard.tick(); });                   // live production bar + affordability
    guard("unitBar", () => { unitBar.tick(); });                       // a single selected unit's health
    guard("resourceHud", () => { resourceHud.update(resources, units, HARVEST ? null : requisition); }); // supplies · points / harvesters
    guard("waveHud", () => { waveHud.update(dt, waves, match); });     // wave counter, match objective, win/lose
    guard("minimap", () => { minimap.draw(); });
    guard("grassTrails", () => { grassTrails.step(); });                   // men and tracks bend the grass they cross
    guard("stress", () => { stress.update(dt); });                    // dev: continuous effect spawners, if running
    guard("birds", () => { birds.update(dt); });                     // transit flocks, flushes
    guard("sounds", () => { sounds.update(); });                      // loops re-aimed at the camera
    guard("fogBanks", () => { app.fogBanks?.update(); });               // the mist's warm side follows the sun
    frameStats.tickMs = performance.now() - tickStart;
  };
  app.addPreRenderHook(tick);

  // Bake cover once the world is fully up. It cannot go next to createCover:
  // on nam-valley the 1,312 rocks arrive with the level, which loads after the
  // systems are constructed, so baking early would silently produce an empty
  // grid — cover that is simply absent, with nothing to notice.
  // The camp: perimeter (berm, wire, gate, towers) and its dressing, every
  // piece through placedObjects.js (pad, nav footprint, cover, merged draws).
  // Before the nav rebuild and cover bake below, which then include it.
  // ?camp=0 boots the bare map.
  const placed = createPlacedObjects(app);
  app.placed = placed;
  // Plants a place puts down by hand (a hamlet's traveller's palms) — see
  // placedPlants.js. Plans call this rather than importing the renderer, so
  // they stay plain data that a Node test can load.
  app.plant = (kind, x, z, o) => plant(app, kind, x, z, o);
  if (new URLSearchParams(location.search).get("camp") !== "0") {
    onStatus("Building the camp…");
    try {
      app.perimeter = await placeCampPerimeter(app, placed);
      await placeCampLayout(app, placed);
    } catch (e) {
      console.warn("[camp] failed to place:", e);
    }
  }

  // Where the hens live: the hamlets, and the Front's camp (it kept chickens
  // like any farm). Collected as the places go up; ONE flock is made after.
  const henSites = [];

  // The hamlets (village.js): houses, granaries, fences and the clutter of
  // people living there, laid out round a lane. Through the same placedObjects
  // path as the camp — pads, nav on the real footprints, cover, merged draws —
  // and before the nav rebuild below, which then includes them. ?village=0
  // boots without them.
  if (new URLSearchParams(location.search).get("village") !== "0") {
    onStatus("Raising the village…");
    for (const site of hamletSitesFor(boot.name)) {
      try {
        const first = placed.pieces.length;
        const n = await placeHamlet(app, placed, site);
        console.log(`[village] ${site.name}: ${n} pieces at (${site.x}, ${site.z})`);
        // Its hens are homed round its houses (the flock is made once, below).
        henSites.push({ pieces: placed.pieces.slice(first), count: 26 });
      } catch (e) {
        console.warn(`[village] ${site.name} failed:`, e);
      }
    }
  }

  // THE FRONT'S BASE CAMP round the résidence (enemyCamp.js): bamboo towers,
  // long houses, the cook house and its smoke trench, the bicycles, the tiger
  // cages, trenches and foxholes, and the NLF flag as real cloth. ?enemycamp=0
  // boots without it.
  let enemyCampFlag = null;
  if (new URLSearchParams(location.search).get("enemycamp") !== "0") {
    onStatus("Digging in the Front…");
    try {
      const first = placed.pieces.length;
      const n = await placeEnemyCamp(app, placed);
      henSites.push({ pieces: placed.pieces.slice(first), count: 10 });
      app.enemyCampSlice = { first, last: placed.pieces.length };
      enemyCampFlag = createEnemyCampFlag({ app, structures });
      console.log(`[enemy camp] ${n} pieces`);
    } catch (e) {
      console.warn("[enemy camp] failed to place:", e);
    }
  }
  app.enemyCampFlag = enemyCampFlag;

  // THE ROCKS in the nam look (namRocks.js): photo stone, buried and tilted,
  // fewer lone stones — the kit's own look stays for the editor and other
  // games. After every site has taken its ground. ?rocks=kit = the kit look.
  try {
    const r = applyNamRocks(app);
    if (r) console.log(`[rocks] ${r.changed} buried, ${r.removed} lone stones removed, ${r.added} karst pillars`);
  } catch (e) { console.warn("[rocks] failed:", e); }

  // THE HENS (chickenFlock.js): every one of them — hamlet and camp — in ONE
  // GPU crowd draw, each homed a couple of metres off a piece of her place,
  // kept out of its buildings, the water and the steep. ?chickens=0 = without.
  if (henSites.length && new URLSearchParams(location.search).get("chickens") !== "0") {
    try {
      const all = henSites.flatMap((h) => h.pieces);
      const inPiece = (x, z) => all.some(({ fp }) => {
        const dx = x - fp.px, dz = z - fp.pz;
        if (Math.abs(dx) > fp.hx + fp.hz + 1 || Math.abs(dz) > fp.hx + fp.hz + 1) return false;
        const lx = dx * fp.c - dz * fp.s, lz = dx * fp.s + dz * fp.c;
        return Math.abs(lx) < fp.hx + 0.3 && Math.abs(lz) < fp.hz + 0.3;
      });
      const blocked = (x, z) => inPiece(x, z)
        || (app.getWaterLevelAt?.(x, z) ?? -Infinity) > app.getWorldHeight(x, z) - 0.2
        || app.getWorldNormal(x, z).y < 0.85;
      let seed = 31337;
      const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      const homes = [];
      for (const { pieces, count } of henSites) {
        let got = 0;
        for (let k = 0; k < 600 && got < count && pieces.length; k++) {
          const { fp } = pieces[Math.floor(rnd() * pieces.length)];
          const a = rnd() * Math.PI * 2, r = Math.max(fp.hx, fp.hz) + 1.5 + rnd() * 3;
          const x = fp.px + Math.cos(a) * r, z = fp.pz + Math.sin(a) * r;
          if (!blocked(x, z)) { homes.push({ x, z }); got++; }
        }
      }
      app.chickens = await createChickenFlock(app, homes, { blocked });
      console.log(`[chickens] ${homes.length} (${henSites.map((h) => h.count).join(" + ")} wanted)`);
    } catch (e) { console.warn("[chickens] failed:", e); }
  }

  // The Khmer ruins (temple.js): the tower and its galleries round a courtyard,
  // the gate, the causeway with its nāga rail, and the fig pulling the lot
  // down. Far out east, away from the fighting. ?temple=0 boots without it.
  if (new URLSearchParams(location.search).get("temple") !== "0") {
    onStatus("Finding the temple…");
    for (const site of templeSitesFor(boot.name)) {
      try {
        const n = await placeTemple(app, placed, site);
        console.log(`[temple] ${site.name}: ${n} pieces at (${site.x}, ${site.z})`);
      } catch (e) {
        console.warn(`[temple] ${site.name} failed:`, e);
      }
    }
  }

  // THE CANOPY (jungleCanopy.js): rainforest on the slopes nobody can climb,
  // round the map's edge and in a few groves, cleared round every site —
  // "frame the fight". Runtime paint, so it runs after every load.
  // ?canopy=0 boots without it (the A/B).
  if (new URLSearchParams(location.search).get("canopy") !== "0") {
    onStatus("Growing the jungle…");
    const t0 = performance.now();
    const { field, texels } = paintCanopy(app, canopyClearings({
      structures, requisition, hamlets: hamletSitesFor(boot.name), temples: templeSitesFor(boot.name),
    }));
    // The palms along its sunlit margin, on top of the map's own palm paint,
    // and traveller's palms out in the wild, not only in the village.
    let palms = 0, travellers = 0, floor = 0;
    // Where the forest and the palm fringe are, for whoever needs to stay out
    // from under them (the egrets pick open banks — rtsBirds.js).
    app.jungleField = field;
    if (field) {
      palms = paintPalmFringe(app, field);
      floor = paintUndergrowth(app, field);
      for (const t of travellerPalmSpots(app, field)) {
        plant(app, "travellersPalm", t.x, t.z, { rotY: t.rotY, scale: t.scale });
        travellers++;
      }
    }
    clearKarstGround(app);             // the karst pillars stand out of the forest
    console.log(`[canopy] ${texels} texels of forest, ${palms} of palm fringe, ${floor} of undergrowth, ${travellers} traveller's palms in ${Math.round(performance.now() - t0)} ms`);
  }

  // The post chain BEFORE the fog banks and the fog of war: the paddies'
  // water reflections (paddyReflections.js), which read the scene before any
  // mist lies over it. Identity until the paddies exist.
  const preFog = (color, ctx) => (app.ricePaddies?.reflections ? app.ricePaddies.reflections.node(color, ctx) : color);

  // The Front's camp LIVED IN (enemyCampDressing.js): trampled compound and
  // paths, the trees thinned, concertina wire, a stripped captured truck,
  // ammunition. After the canopy and palms are painted. ?campdress=0 = without.
  if (app.enemyCampSlice && new URLSearchParams(location.search).get("campdress") !== "0") {
    try {
      const d = await dressEnemyCamp(app, placed, app.enemyCampSlice);
      console.log(`[enemy camp] dressed: ${d?.yards} ground patches, ${d?.wire} wire runs`);
    } catch (e) { console.warn("[enemy camp] dressing failed:", e); }
  }

  // RICE PADDIES (ricePaddies.js): terraces cut into the best open hillside
  // near the hamlet, a patchwork of flooded / young / ripe / ploughed paddies.
  // Before the specimen plants (they keep off the fields) and before the nav
  // grid is rebuilt (the terraces change the ground). ?paddies=0 = without.
  if (new URLSearchParams(location.search).get("paddies") !== "0") {
    onStatus("Cutting the rice terraces…");
    const t0 = performance.now();
    try {
      const hamlet = hamletSitesFor(boot.name)[0];
      // Near the player's base (the first thing seen), on a hill rising along
      // the camera's view so the banks face the player; off the dirt track
      // (nam-valley's paint layer 5).
      const base = (structures?.list ?? []).find((s) => s.alive && s.team === "player" && /command/i.test(s.type?.name ?? ""));
      const view = app.camera.getWorldDirection(app.camera.position.clone());
      const site = sitePaddies(app, {
        near: base?.position ?? hamlet, facing: { x: view.x, z: view.z },
        keepOff: (x, z) => (app.samplePaintWeights?.(x, z)?.[4] ?? 0) > 0.3,
        structures, pieces: placed.pieces, field: app.jungleField ?? null,
      });
      const paddies = site ? await buildRicePaddies(app, site) : null;
      app.ricePaddies = paddies;
      if (paddies?.reflections) fogOfWar.setPreModifier((color, ctx) => preFog(color, ctx));
      console.log(paddies
        ? `[paddies] at (${Math.round(site.x)}, ${Math.round(site.z)}), ${Math.round(site.share * 100)}% usable: ${Math.round(site.up * 100)}% facing hillside, ${paddies.triangles} tris, ${paddies.crop.count} rice hills in ${Math.round(performance.now() - t0)} ms`
        : "[paddies] no site near the hamlet");
    } catch (e) { console.warn("[paddies] failed:", e); }
  }

  // WATER BUFFALO (buffalo.js), one GPU crowd draw for the herd: three wading
  // in flooded paddies, two grazing the grassed rim, groups at the hamlet and
  // at Kurtz's temple, pairs on open meadows. ?buffalo=0 = without.
  if (app.ricePaddies && new URLSearchParams(location.search).get("buffalo") !== "0") {
    try {
      const pd = app.ricePaddies, s0 = pd.site, spots = [];
      let seed = 9001;
      const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      for (let i = 0; i < 6000 && spots.length < 5; i++) {
        const x = s0.x + (rnd() - 0.5) * 150, z = s0.z + (rnd() - 0.5) * 120;
        if (spots.some((q) => Math.hypot(q.x - x, q.z - z) < 14)) continue;
        const wading = spots.length < 3;
        const y = wading ? pd.waterAt(x, z, 2.5) : pd.grassAt(x, z);
        if (y == null) continue;
        // Where it may go: its own flooded paddy (wading, legs in the water),
        // or the grassed rim — heightAt is null anywhere else.
        const heightAt = wading
          ? (qx, qz) => { const w = pd.waterAt(qx, qz, 1.2); return w == null || Math.abs(w - y) > 0.05 ? null : w - 0.32; }
          : (qx, qz) => pd.grassAt(qx, qz);
        spots.push({ x, z, heightAt });
      }
      // GRAZING GROUPS elsewhere (your ask, 2026-09-26: "more buffalo — at
      // Kurtz's place, in the village"): open, dry, gentle ground clear of
      // every placed piece and structure; each buffalo keeps within 12 m of
      // where it started; the group's patch is grazed (bushes and tall plants
      // gone, the grass stays).
      const blockers = [
        ...placed.pieces.map(({ fp }) => ({ x: fp.px, z: fp.pz, r: Math.hypot(fp.hx, fp.hz) + 3 })),
        ...(structures?.list ?? []).filter((q) => q.alive).map((q) => ({ x: q.position.x, z: q.position.z, r: 14 })),
      ];
      const pasture = (x, z) => {
        if (Math.abs(x) > 495 || Math.abs(z) > 495) return false;
        if ((app.getWaterLevelAt?.(x, z) ?? -Infinity) > app.getWorldHeight(x, z) - 0.3) return false;
        if (app.getWorldNormal(x, z).y < 0.95) return false;
        const f = app.jungleField;
        if (f && f.open(x, z) * f.forest(x, z) > 0.25) return false;
        if (app.navGrid?.isBlockedAtWorld?.(x, z)) return false;
        if (pd.inBlock?.(x, z)) return false;
        return !blockers.some((q) => (q.x - x) ** 2 + (q.z - z) ** 2 < q.r * q.r);
      };
      const group = (cx0, cz0, rMin, rMax, n) => {
        let lead = null, got = 0;
        for (let i = 0; i < 3000 && got < n; i++) {
          const a = rnd() * Math.PI * 2, r = lead ? 3 + rnd() * 14 : rMin + rnd() * (rMax - rMin);
          const c = lead ?? { x: cx0, z: cz0 };
          const x = c.x + Math.cos(a) * r, z = c.z + Math.sin(a) * r;
          if (!pasture(x, z) || spots.some((q) => Math.hypot(q.x - x, q.z - z) < 6)) continue;
          if (!lead) lead = { x, z };
          const hx = x, hz = z;
          spots.push({ x, z, heightAt: (qx, qz) => (Math.hypot(qx - hx, qz - hz) < 12 && pasture(qx, qz) ? app.getWorldHeight(qx, qz) : null) });
          app.clearVegetation?.(x, z, 9, { edge: 4 });
          got++;
        }
        return got;
      };
      const hamlet = hamletSitesFor(boot.name)[0];
      const temple = templeSitesFor(boot.name)[0];
      if (hamlet) { group(hamlet.x, hamlet.z, 20, 55, 4); group(hamlet.x, hamlet.z, 30, 80, 3); }
      if (temple) { group(temple.x, temple.z, 30, 80, 4); group(temple.x, temple.z, 40, 100, 2); }
      // And pairs out on open meadows across the map, a lone herder's beasts.
      for (let k = 0; k < 6; k++) group((rnd() - 0.5) * 800, (rnd() - 0.5) * 800, 0, 60, 2);
      app.buffalo = await placeBuffalo(app, spots);
      console.log(`[buffalo] ${spots.length} at ${spots.map((q) => `(${q.x | 0}, ${q.z | 0})`).join(" ")}`);
    } catch (e) { console.warn("[buffalo] failed:", e); }
  }

  // WILD DEER (wildAnimals.js), your models: SAMBAR (a stag with his hinds)
  // and MUNTJAC, in small groups on the sunny fringe of the jungle, well away
  // from every camp; they graze, and BOLT from any soldier within 35 m.
  // One GPU crowd draw per kind. ?deer=0 = without.
  if (app.jungleField && new URLSearchParams(location.search).get("deer") !== "0") {
    try {
      const f = app.jungleField;
      const built = (structures?.list ?? []).map((q) => q.position);
      const hamlets = hamletSitesFor(boot.name);
      const canStand = (x, z) => {
        if (Math.abs(x) > 500 || Math.abs(z) > 500) return null;
        const y = app.getWorldHeight(x, z);
        if ((app.getWaterLevelAt?.(x, z) ?? -Infinity) > y - 0.3) return null;
        if (app.getWorldNormal(x, z).y < 0.88) return null;
        if (app.navGrid?.isBlockedAtWorld?.(x, z)) return null;
        if (app.ricePaddies?.inBlock?.(x, z)) return null;
        return y;
      };
      // A quiet edge: jungle fringe, open enough to see them, 60 m from any
      // structure and 70 m from a hamlet (110 / 90 left only 5 places on the
      // whole map — you never met one).
      const quiet = (x, z) => canStand(x, z) != null && f.fringe(x, z) > 0.1 && f.open(x, z) > 0.5
        && (app.sampleTallPlantDensity?.(x, z) ?? 0) < 0.2
        && !built.some((q) => (q.x - x) ** 2 + (q.z - z) ** 2 < 60 * 60)
        && !hamlets.some((q) => (q.x - x) ** 2 + (q.z - z) ** 2 < 70 * 70);
      let seed = 2718;
      const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      const centres = [];
      for (let i = 0; i < 20000 && centres.length < 14; i++) {
        const x = (rnd() - 0.5) * 920, z = (rnd() - 0.5) * 920;
        if (!quiet(x, z) || centres.some((c) => Math.hypot(c.x - x, c.z - z) < 90)) continue;
        centres.push({ x, z });
        // A glade: grazed, the ferns and bananas thinned round them.
        app.clearVegetation?.(x, z, 10, { edge: 4 });
      }
      const around = (c, n, r) => {
        const out = [];
        for (let k = 0; k < 60 && out.length < n; k++) {
          const a = rnd() * Math.PI * 2, d = 2 + rnd() * r;
          const x = c.x + Math.cos(a) * d, z = c.z + Math.sin(a) * d;
          if (canStand(x, z) != null) out.push({ x, z });
        }
        return out;
      };
      // Sambar groups (a stag, three or four hinds) at every other place,
      // muntjac pairs and threes at the rest.
      const stagSpots = [], hindSpots = [], muntjacSpots = [];
      centres.forEach((c, i) => {
        if (i % 2 === 0) {
          stagSpots.push(...around(c, 1, 4).map((q) => ({ ...q, height: 2.3 + rnd() * 0.2 })));
          hindSpots.push(...around(c, 3 + (i % 2), 9).map((q) => ({ ...q, height: 1.55 + rnd() * 0.15 })));
        } else {
          muntjacSpots.push(...around(c, 2 + (i % 3 === 0 ? 1 : 0), 5).map((q) => ({ ...q, height: 0.8 + rnd() * 0.08 })));
        }
      });
      const threats = () => units.list.filter((u) => u.alive && !u.isAir).map((u) => u.position);
      // Sambar: dark grey-brown, a paler belly and rump. Muntjac: red-brown.
      const SAMBAR = { Main: "#4a3b2e", Main_Light: "#8a7a64", Main_Dark: "#2c2219", Eye_Lighter: "#4a3b2e" };
      const STAG = { Material: "#463628", "Material.003": "#86765f", "Material.010": "#2a2018", "Material.001": "#2c241c" };
      const MUNTJAC = { Main: "#8a4b26", Main_Light: "#b89370", Main_Dark: "#4d2a16", Eye_Lighter: "#8a4b26" };
      const herds = [];
      const add = async (url, colors, spots, name, speeds) => {
        if (!spots.length) return;
        const tpl = await loadAnimal(url, colors);
        herds.push(createWildHerd(app, tpl, spots, { canStand, threats, name, ...speeds }));
      };
      await add("/models/Stag_compressed.glb", STAG, stagSpots, "SambarStags", {});
      await add("/models/Deer_compressed.glb", SAMBAR, hindSpots, "SambarHinds", {});
      await add("/models/Deer_compressed.glb", MUNTJAC, muntjacSpots, "Muntjac", { walkSpeed: 0.6, runSpeed: 5.5 });
      app.wildHerds = herds.filter(Boolean);
      console.log(`[deer] ${stagSpots.length} stags, ${hindSpots.length} hinds, ${muntjacSpots.length} muntjac in ${centres.length} groups`);
    } catch (e) { console.warn("[deer] failed:", e); }
  }

  // The plants that make it Vietnam and Cambodia: pandanus on the river's
  // edge, sugar palms round the village and the temple and out in the open,
  // flame trees in the village (specimenPlants.js). ?specimens=0 = without.
  if (new URLSearchParams(location.search).get("specimens") !== "0") {
    const t0 = performance.now();
    try {
      const n = plantSpecimens(app, {
        field: app.jungleField ?? null, structures,
        hamlets: hamletSitesFor(boot.name), temples: templeSitesFor(boot.name),
      });
      console.log(`[specimens] ${n.pandanus} pandanus, ${n.sugarPalm} sugar palms, ${n.flameTree} flame trees in ${Math.round(performance.now() - t0)} ms`);
    } catch (e) { console.warn("[specimens] failed:", e); }
  }

  // FOG BANKS (fogBanks.js): mist at PLACES — along the river, the temple's
  // valley floor, a hollow in the jungle — over the map's own fog, which is
  // not touched. ?fogbanks=0 = without.
  if (new URLSearchParams(location.search).get("fogbanks") !== "0" && app.heightTexNode) {
    try {
      const fogBanks = createFogBanks({ app });
      const placedBanks = siteFogBanks(app, fogBanks, { temples: templeSitesFor(boot.name), field: app.jungleField ?? null });
      app.fogBanks = fogBanks;
      fogBanks.restoreBanks();          // your per-bank densities from Dev → Fog banks
      // Drawn in the post chain with the scene's depth, BEFORE the fog of war
      // (unexplored ground darkens its mist with it). Mode / steps changes
      // rebuild the same hook.
      const hookFog = () => fogOfWar.setPreModifier((color, ctx) => fogBanks.node(preFog(color, ctx), ctx));
      fogBanks.onRebuild = hookFog;
      hookFog();
      buildFogBanksPanel(document.getElementById("dv-fogbanks"), fogBanks, { rtsCamera });
      console.log(`[fog banks] ${placedBanks.map((b) => b.name).join(", ")}`);
    } catch (e) { console.warn("[fog banks] failed:", e); }
  }

  // Every bridge gets ground at both ends that meets its deck — without it
  // the river cut the map in two (bridgeLandings.js). The props are in now.
  onStatus("Grading bridge landings…");
  try { await gradeBridgeLandings(app); } catch (e) { console.warn("[bridges] landings failed:", e); }
  // Every building back on its level pad, after all the ground work above.
  try { await placed.reassertPads(); } catch (e) { console.warn("[placed] pad re-level failed:", e); }
  // …and the decks themselves get a height, so units cross ON the bridge
  // instead of walking the riverbed under it (bridgeDecks.js).
  try {
    const bridgeDecks = measureBridgeDecks(app);
    app.bridgeDecks = bridgeDecks;
    app.getStandHeight = (x, z) => {
      const g = app.getWorldHeight(x, z);
      const d = bridgeDecks.heightAt(x, z);
      return d != null && d > g ? d : g;
    };
    console.log(`[bridges] ${bridgeDecks.decks.length} decks measured`);
  } catch (e) { console.warn("[bridges] deck measure failed:", e); }

  // THE SKY LAST, DEPTH-TESTED (measured 2026-09-24). The engine draws its
  // atmosphere dome FIRST with the depth test off (renderOrder -2), so every
  // pixel of the screen pays the sky shader and the world then paints over it.
  // The RTS camera looks steeply down and almost never sees sky, so that was
  // ~1.2 ms of a 29 ms frame (x1.55 res) spent on pixels nobody sees. The dome
  // (4000 m, following the camera, far plane 4096) is behind all terrain, so
  // drawn after the opaque world (9: before the water's screen grab at 10)
  // with the depth test ON it only shades the sky you can see — 0.86 ms back,
  // identical picture at the horizon.
  {
    const skyDome = app.scene.getObjectByName("AtmosphereSkyDome");
    if (skyDome) {
      skyDome.renderOrder = 9;
      skyDome.material.depthTest = true;
      skyDome.material.needsUpdate = true;
    }
  }

  // GRAB-FREE RIVER (measured 2026-09-24): drawing any water made the frame
  // pay two full-screen framebuffer copies — 2.7 ms at x1.55 res with one
  // river vertex on screen. From the RTS camera the refraction and SSR those
  // copies feed are invisible, so the river reads its depth from the
  // heightmap instead. ?water=grab brings the old water back (the A/B).
  // The decals too: they read the depth grab, and with the river grab-free
  // one decal on screen still paid its full-screen copy (1.1 ms).
  if (new URLSearchParams(location.search).get("water") !== "grab") {
    app.setRiverGrabFree?.(true);
    app.setDecalsGrabFree?.(true);
  }

  onStatus("Baking cover…");
  // The props are in by now, so the HQ can take its footprint back from them
  // (clearHqGround ran once before they arrived, for the vegetation) — and the
  // nav grid is rebuilt after, or a removed rock would still block the path.
  clearHqGround();
  navGrid.rebuild();
  for (const s of structures.list) if (s.alive) navGrid.addStructureObstacle(s);
  console.log(`[cover] ${cover.bake()} obstacles`);
  // Label the nav regions now (~6 ms), not on the first question in the fight.
  navGrid.sameRegion(0, 0, 0, 0);

  // ── The Front's opening kit (traps.js) ─────────────────────────────────────
  // Two pits and a wire on the open approach to the résidence (-Z, the side you
  // come from), a spider hole watching them, and a rice cache in the back yard.
  // `addNow`, not `placeEnemy`: none of it levels ground — a flattened disc in
  // the jungle is exactly the tell a hidden thing must not have. Laid after the
  // last nav rebuild so a pit never lands inside a cliff, and the commander
  // adds to it as the match goes on (enemyAI.layCheapKit).
  if (AI_ON && structures.enemyBase?.alive) {
    const eb = structures.enemyBase.position;
    let laid = 0;
    for (const [key, dx, dz] of [
      ["punji", -20, -44], ["punji", 17, -50], ["boobyTrap", -2, -57],
      ["spiderHole", 24, -36], ["cache", -28, 16],
    ]) {
      const x = eb.x + dx, z = eb.z + dz;
      if (navGrid.isBlockedAtWorld(x, z)) continue;
      structures.addNow(key, x, z);
      laid++;
    }
    console.log(`[traps] ${laid} hidden at the résidence`);
  }

  // The console handle. Every subsystem already hangs off `app`, so one global
  // covers all of them: __NAM.smoke.spawn({x, z, kind: "screen"}).
  window.__NAM = app;

  // The world is built (river, canopy, props): the egrets may look for their
  // banks now. The loop has been running at 1 Hz under the loading screen,
  // and a scan then found banks under a canopy that was not painted yet.
  birds.worldReady();
  app.setFrameThrottle?.(0);     // the loading screen is going: full rate
  // Build every pipeline the game will need NOW, under the loading screen,
  // not on the frame the first fire, rocket or tank appears mid-fight
  // (pipelineWarmup.js). Only what the game added after the level loaded.
  onStatus("Preparing effects…");
  try {
    const w = await warmGamePipelines(app, engineObjects);
    console.log(`[warmup] ${w.warmed} hidden/empty drawables warmed in ${w.ms} ms`);
  } catch (e) { console.warn("[warmup] failed:", e); }
  // THE PADS AGAIN, at the very end: something late in the boot (the river's
  // re-conform settling, measured 2026-09-26) still rewrote a few after the
  // pass above; a pass here, and one more once the game has run a moment,
  // leave every building on level ground. 54 small rects each — nothing.
  try { await placed.reassertPads(); } catch (e) { console.warn("[placed] pad re-level failed:", e); }
  setTimeout(() => placed.reassertPads().catch(() => {}), 3000);
  onStatus("ready");
  return app;
}
