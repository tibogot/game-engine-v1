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
import { createHarvesting } from "./harvesting.js";
import { createRequisition } from "./requisition.js";
import { createRequisitionRenderer } from "./requisitionRenderer.js";
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
import { createRtsBirds } from "./rtsBirds.js";
import { createCover } from "./cover.js";
import { createPlacedObjects } from "./placedObjects.js";
import { placeCampPerimeter } from "./campPerimeter.js";
import { placeCampLayout } from "./campLayout.js";
import { createAbilities } from "./abilities.js";
import { createAbilityTargeting } from "./abilityTargeting.js";
import { createCoverOverlay } from "./coverOverlay.js";
import { createCraterSystem } from "./craterSystem.js";
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
    splatFeatures:   leanTerrain ? { solo: false, layerBudget: 6 } : { solo: false },
  });
  window.__rts = app; // handy for console debugging

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
  worldState.name = boot.name;

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

  app.setSlopeCliffRule?.({
    layer: 5,                            // "Cliff Rock" in nam-valley
    startDeg: NAV_MAX_SLOPE_DEG - 4,
    endDeg: NAV_MAX_SLOPE_DEG,
  });
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
  const healthBars = createHealthBarField({ scene: app.scene });
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
    // Taking a point pops M18 VIOLET — the Apocalypse Now marker.
    onCapture: (p, team) => { if (team === "player") app.smoke?.spawn({ x: p.position.x, z: p.position.z, kind: "violet" }); },
  });
  app.requisition = requisition;
  const MAST_FP = buildRequisitionMast().userData.footprint;
  app.resources = resources;

  onStatus("Placing structures…");
  const structures = await createStructures({ app, navGrid, resources });
  app.structures = structures;

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
    for (const p of requisition.placePoints(structures.base.position)) {
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
  app.combatFx = fx;

  const fire = createFireSystem({ app });
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
  const birds = createRtsBirds({ app });
  app.birds = birds;
  {
    const explosion = fx.explosion;
    fx.explosion = (x, y, z) => { explosion(x, y, z); birds.flush(x, z); };
    const addCrater = craters.addCrater?.bind(craters);
    if (addCrater) craters.addCrater = (x, z, ...rest) => { const r = addCrater(x, z, ...rest); birds.flush(x, z); return r; };
  }

  // Late-bound: projectiles need combat.onImpact, combat needs projectiles.
  let combatRef = null;
  const projectiles = createProjectiles({
    app,
    onImpact: (target, dmg, at, owner) => combatRef?.onImpact(target, dmg, at, owner),
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
    onDeath: (entity) => { app.selection?.remove?.(entity); },
  });
  combatRef = combat;
  app.combat = combat;

  // Napalm is assembled from fire + smoke + craters + combat; it owns only the
  // SHAPE of a run and what it does to whoever is standing in it.
  const napalm = createNapalmStrike({
    app, fire, smoke, craters, combat, units, structures,
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
            { key: "builder", label: "Builder", cost: UNIT_COST.builder },
            { key: "bigtank", label: "M113 ACAV", cost: UNIT_COST.bigtank },
            { key: "lightTank", label: "Light Tank", cost: UNIT_COST.lightTank },
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
    // The unit bar shows units only; buildings live in the command card.
    onChange: (sel) => {
      // Units if any; otherwise the selected building, so the centre is never
      // blank while something is selected.
      const mobile = sel.filter((e) => !e.isStructure);
      unitBar.render(mobile.length ? mobile : sel.slice(0, 1));
      commandCard.render(sel);
    },
  });
  app.selection = selection;

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
    devPanel.setWorldName(worldState.name);
  };

  const devPanel = createDevPanel({
    app, navGrid, rtsCamera, units, minimap, foliageZoom, stress,
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
    structures.updateProduction(dt, (key, x, z, opts) => units.spawn(key, x, z, opts));
    buildings.update(dt);                 // construction ramp + helipad production
    resources.tickCaptureIncome(dt, buildings);
    requisition.step(dt, units.list);      // who stands on which point; income
    harvesting.update(dt);                // node → fill → base → unload → repeat
    units.update(dt);
    combat.update(dt);                    // acquire → chase → launch rockets
    match.update(dt);                     // win/lose when enemy HQ match is on
    projectiles.update(dt, app.camera);   // rockets fly, trail, and land damage
    fire.update(dt, sim.simTime);         // burning wrecks
    smoke.step(dt);                       // columns age here; the puffs do not
    napalm.step(dt);                      // the run lands, burns, kills, scars
    abilities.step(dt, units.list);       // cooldowns
    cover.step(dt, units.list);           // "I just fired" reveal timers
  };

  // The RENDER clock the smoke puffs ride. Deliberately not sim.simTime: the
  // sim can take several steps in one frame or none, and a puff that jumped
  // would read as a stutter in something that should drift.
  let renderTime = 0;

  // The game's own CPU per frame — everything in tick — for the stress
  // benchmark's price list. Two performance.now() calls; nothing else reads it.
  const frameStats = { tickMs: 0 };
  app.frameStats = frameStats;

  const tick = (dt) => {
    const tickStart = performance.now();
    renderTime += dt;
    rtsCamera.update(dt);                 // input, at the real frame rate
    app.setFoliageThin?.(foliageKeepAt(rtsCamera.getView().zoomT));
    sim.advance(dt, simStep);
    fogOfWar.update(dt);                  // vision grid → GPU shroud texture
    resourceRenderer.sync();              // only rewrites when a node visibly drains
    healthBars.begin();                   // both renderers push their bars into it
    selectionRings.begin();               // unitRenderer pushes a ring per selected unit
    selectionFrames.begin();              // square buildings push corner brackets
    unitRenderer.sync(dt, app.camera);
    structuresRenderer.sync(dt, app.camera);
    buildingRenderer.sync(dt, app.camera);
    requisitionRenderer.sync(dt);
    healthBars.commit();
    selectionRings.commit();
    selectionFrames.commit();
    fx.update(dt, app.camera);            // muzzle / impact / explosion
    smoke.render(renderTime, app.environment?.getLightDirection?.());
    // Point the overlay at the selection until the pointer has moved, so
    // holding V before touching the mouse reveals the ground under the men
    // rather than a patch of the map's centre.
    {
      const sel = app.selection?.selected ?? [];
      const u = sel.find((e) => !e.isStructure) ?? sel[0];
      if (u?.position) coverOverlay.setFallback(u.position.x, u.position.z);
    }
    coverOverlay.update(dt);              // hold V — decides nothing, only draws
    baseFlag?.update(dt);                 // HQ flag cloth sim
    commandCard.tick();                   // live production bar + affordability
    unitBar.tick();                       // a single selected unit's health
    resourceHud.update(resources, units, HARVEST ? null : requisition); // supplies · points / harvesters
    waveHud.update(dt, waves, match);     // wave counter, match objective, win/lose
    minimap.draw();
    stress.update(dt);                    // dev: continuous effect spawners, if running
    birds.update(dt);                     // transit flocks, flushes
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
  if (new URLSearchParams(location.search).get("camp") !== "0") {
    onStatus("Building the camp…");
    try {
      app.perimeter = await placeCampPerimeter(app, placed);
      await placeCampLayout(app, placed);
    } catch (e) {
      console.warn("[camp] failed to place:", e);
    }
  }

  onStatus("Baking cover…");
  // The props are in by now, so the HQ can take its footprint back from them
  // (clearHqGround ran once before they arrived, for the vegetation) — and the
  // nav grid is rebuilt after, or a removed rock would still block the path.
  clearHqGround();
  navGrid.rebuild();
  for (const s of structures.list) if (s.alive) navGrid.addStructureObstacle(s);
  console.log(`[cover] ${cover.bake()} obstacles`);

  // The console handle. Every subsystem already hangs off `app`, so one global
  // covers all of them: __NAM.smoke.spawn({x, z, kind: "screen"}).
  window.__NAM = app;

  onStatus("ready");
  return app;
}
