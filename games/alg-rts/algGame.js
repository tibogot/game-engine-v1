// ALGERIA RTS ("Djebel") — boot: the v3 engine as a game, the Aurès map, the
// shared RTS camera and the Aurès light. No gameplay yet (games/alg-rts/TODO.md):
// this page is where the map and the new assets are judged, in the game's own
// light and camera rather than the editor's.
//
// Boot settings are nam-rts's, each measured there (games/nam-rts/namGame.js
// has the numbers): a fitted sun shadow instead of cascades, the lean terrain
// shader, top-3 layers + near/far tiling, the terrain drawn last.
//
// URL options: ?world=/levels/other.v3proj · ?light=flat (the engine's default
// light, to A/B) · ?fog=0 · ?warmup=0 (no pipeline warm-up, to A/B it) ·
// ?sky=pro (the Sky Pro sky: Tidewater's atmosphere, real cumulus and their
// shadows, its air haze and sun shafts — the test bed, see SKY_PRO below)
import { startV3App, createLevelLoader } from "../../v3/engine.js";
import { createRtsCamera } from "../shared-rts/rtsCamera.js";
import { placeShowroom } from "./showroom.js";
import { createAlgDevPanel } from "./devPanel.js";
import { createAlgFog } from "./algFog.js";
import { rtsAtlasReady } from "../../v3/render/objects/rtsTextures.js";
import { LAYOUT, PLAY, VIEW_YAW, siteYaw } from "./layout.js";
import { createAlgUnits } from "./algUnits.js";
import { createAlgBirds } from "./algBirds.js";
import { createAlgHerds } from "./algHerds.js";
import { snapshotEngineScene, warmGamePipelines } from "../shared-rts/pipelineWarmup.js";
import "../../v3/styles/editor.css";

const params = new URLSearchParams(location.search);

/**
 * THE AURÈS IN SUMMER. The war began here on 1 November 1954, but the look to
 * get right first is the one everybody pictures: a hard high sun on bare
 * ochre ground, shadows short and dark in the gullies, a sky bleached pale by
 * dust rather than blue. Latitude is the real one (35.2° N), so the sun's arc
 * is the Aurès's; mid-July, mid-afternoon.
 *
 * MEASURED (sRGB luma of the game area, play zoom, 2026-09-26):
 *                          mean   near-black   top 1%
 *   engine default light     57-76    9-21%     113-129   (a dark chocolate map)
 *   this light              118-140    0-3%     186-198
 * Bare ochre ground in a summer sun is the brightest frame of the two games
 * (nam's jungle sits at ~85): shade in the gullies stays dark, nothing else.
 * Needs skyMode "atmosphere" at boot — setWorldLight drives only that sky.
 */
export const AURES_LIGHT = {
  latitude: 35.2,
  dayOfYear: 196,
  timeOfDay: 15.2,
  // The sun carries the frame (nam's lesson: a sky-lit frame is flat), the
  // fill stays warm and low, exposure brings the mean back up.
  world: { dir: 4.8, skyFill: 0.4, hemi: 0.9, exposure: 1.45 },
  polish: { enabled: true, contrast: 1.12, saturation: 0.9, temperature: 0.16 },
  // Dust, not mist: a warm pale haze that eats the far ground and the plain.
  haze: { color: "#d9c6a4", density: 0.00055 },
};

/**
 * The plain outside the map, matched BY EYE to the textured soil beside it in
 * this light. Not the soil's mean albedo (#735a3e): a flat colour under this
 * warm sun goes orange, where the texture's stones and dust keep it a greyed
 * tan — so the match is greyer and lighter than the average. ao 0: the grid's
 * line darkening has no lines to explain on a flat plain.
 */
const PLAIN_COLOR = "#a39480";

/**
 * SKY PRO (?sky=pro): the engine's "skypro" sky mode on this map, to judge it
 * in the game's own camera. It brings its own light (the sun through its air, in
 * Tidewater's units, the sky as the ambient), its own haze and its clouds'
 * shadows, so the Aurès light above (tuned for the Atmosphere sky) steps aside:
 * no setWorldLight, no distance fog. The clock, latitude and grade stay.
 */
const SKY_PRO = params.get("sky") === "pro";

export async function startAlgGame({ container, onStatus = () => {}, onProgress = null } = {}) {
  onStatus("Starting engine…");
  // The kit's surface atlas is painted in a worker; until it lands every
  // building and vehicle wears a flat olive-grey placeholder. Started first
  // so it paints while the engine and the level load, and awaited before the
  // loading screen lifts (you saw the post go grey → textured after a second).
  const atlasReady = rtsAtlasReady();
  const app = await startV3App({
    container,
    preloadPaintTextures: false,
    // The Atmosphere sky (3-LUT scattering). A game gets the old procedural
    // sky unless it asks, and setWorldLight below only drives this one.
    // ?sky=pro: Sky Pro, with its clouds' shadows on the land (the sun's
    // cloud-shadow slot: one more texture per lit material, no sampler).
    skyMode: SKY_PRO ? "skypro" : "atmosphere",
    cloudShadows: SKY_PRO,
    // Three shapes of every tree (palm clumps, cedars, oaks): one shape
    // repeated across a grove read as a stamp.
    tallPlantVariants: Number(params.get("variants") ?? 3),
    // Cut-out leaf cards drawn depth-first (cedar massif: ~12 ms → near 0).
    // ?prepass=0 to A/B.
    foliageDepthPrepass: params.get("prepass") !== "0",
    // shadowRadius 2 (engine default 4): the PCF disc is radius × texel, and at
    // 4 the palm fronds and soldiers smeared to grey smudges; 1 was crisp but
    // grainy. Chosen by eye in-game, 2026-09-29.
    csm: { cascades: 2, maxFar: 300, enabled: false, shadowRadius: 2 },
    light: { shadowNormalBias: 0.12 },
    // Compiled out: what this map never uses — no River v2 river (the wadis
    // are dry paint), no painted grass blades, no flower field — so their
    // terrain tints only multiplied zeros. MEASURED 2026-09-27 at 2x
    // zoom-out, A/B/A/B same clock: 82.3/79.2 → 77.7/77.8 ms. Lakebed STAYS
    // (the oases are lakes). Turn one back on the day the map uses it.
    terrainFeatures: { cursor: false, snow: false, baseStyle: "flat", riverSand: false, grassFar: false, flowerTint: false },
    // ?topk= ?farblend= for A/B (perf investigation, 2026-09-27).
    splatFeatures: { solo: false, layerBudget: 6, topK: Number(params.get("topk") ?? 3), farBlend: params.get("farblend") !== "0" },
  });
  app.setFrameThrottle?.(1000);
  // The stats-gl overlay costs ~20% of the main thread (measured): off in the
  // game, on from Dev → Performance or with ?stats=1.
  app.setStatsOverlay?.(params.get("stats") === "1");

  const levels = createLevelLoader(app, { defaultUrl: "/levels/alg-aures.v3proj", onStatus, onProgress });
  const boot = await levels.loadBoot();
  // What the ENGINE put in the scene: the warm-up at the end leaves it alone.
  const engineObjects = snapshotEngineScene(app.scene);

  // Terrain last among the opaque things (nam-rts: the dearest shader, drawn
  // first, was shaded under everything and then covered).
  for (const m of app.getTerrainMeshes?.() ?? []) m.renderOrder = 8;

  app.postFx?.setEnabled(true);
  app.postFx?.setBloomSelective(true);
  // Bloom OFF until something emits light (tracers, muzzle flash, fires,
  // the searchlight at night). It is selective — only emissive materials
  // glow — and nothing in this game is emissive yet, so it drew nothing:
  // pixel diff on/off = motion only. It cost 5 full-resolution blur levels
  // every frame: MEASURED ~8 ms at 1.55x resolution (2026-09-27 perf pass).
  // Turn it on (Dev → Post-FX) the day the first emissive arrives.
  app.postFx?.setBloom({ enabled: false, strength: 0.85, threshold: 0.0, radius: 0.5 });
  app.shadows?.setEnabled?.(false);   // the fitted frustum, not cascades (nam-rts measured)

  // The plain outside the heightmap is bare ground: soil, not the editor's white.
  app.setGroundBase?.({ baseColor: PLAIN_COLOR, lineColor: PLAIN_COLOR, ao: 0 });

  if (params.get("light") !== "flat") applyAuresLight(app);

  // The new assets, on the map, until gameplay places them (showroom.js).
  if (params.get("showroom") !== "0") {
    onStatus("Placing assets…");
    app.showroom = await placeShowroom(app);
  }

  onStatus("Setting up camera…");
  const rtsCamera = createRtsCamera({ app });
  rtsCamera.setMode("rts");
  // The camera stays over the playable area (layout.js PLAY): the rest is scenery.
  rtsCamera.setBounds(PLAY);
  // Start over the playable side's base (layout.js).
  const base = LAYOUT.sites.find((s) => s.kind === "french");
  if (base) {
    rtsCamera.focusOn(base.x, base.z);
    // Look toward the ALN, not at our own edge; the buildings face this view.
    rtsCamera.setYaw(VIEW_YAW);
  }
  app.rtsCamera = rtsCamera;
  app.addPreRenderHook((dt) => rtsCamera.update(dt));
  // C: RTS camera ⇄ free orbit. Matched on the printed key (AZERTY keyboards).
  window.addEventListener("keydown", (e) => {
    if (e.repeat || e.target.matches?.("input, textarea, select")) return;
    if (e.key?.toLowerCase() === "c") rtsCamera.toggle();
    // N: the nav grid over the terrain (as nam) — where men and vehicles can go.
    else if (e.key?.toLowerCase() === "n") app.navGrid?.toggleDebug?.();
  });
  // Fog: the shared fog banks, sited in the oases and wadis, and weather
  // presets over every fog layer (algFog.js). ?fog=0 = without.
  if (params.get("fog") !== "0") {
    try { app.algFog = createAlgFog(app, { skyPro: SKY_PRO }); } catch (e) { console.warn("[alg fog] failed:", e); }
  }
  // UNITS (algUnits.js, the shared machinery): a section of appelés formed up
  // outside the post's gate, selectable, orderable. ?units=0 = without.
  if (params.get("units") !== "0" && app.showroom) {
    const b = LAYOUT.sites.find((s) => s.kind === "french"), yaw = siteYaw(b);
    onStatus("Mustering…");
    app.algUnits = await createAlgUnits(app, {
      showroom: app.showroom,
      muster: { x: b.x - Math.sin(yaw) * 42, z: b.z - Math.cos(yaw) * 42, yaw },
    });
  }
  // BIRDS (algBirds.js, the shared engine): storks crossing and landing in
  // the open, crows, a stork on the minaret's nest, griffon vultures on the
  // thermals over the djebel — over the katiba's heights and the Kef. ?birds=0 = without.
  if (params.get("birds") !== "0") {
    const at = (kind, name) => LAYOUT.sites.find((s) => s.kind === kind && (!name || s.name === name));
    const soar = [at("aln"), at("point", "Kef lookout"), at("point", "Cedar spring")].filter(Boolean)
      // 42-52 m up: the RTS camera sits 9-110 m above the ground (zoom 0-1);
      // at 80-100 they circled ABOVE it and were never seen. From a play
      // zoom (0.5+) they read as high, wheeling shapes.
      .map((s, i) => ({ x: s.x, z: s.z, n: 3 + (i % 2), r: 55 + i * 12, alt: 42 + i * 5 }));   // a flock needs 3 (rtsBirds)
    try {
      app.algBirds = createAlgBirds(app, { units: app.algUnits?.units ?? null, showroom: app.showroom, soarOver: soar });
    } catch (e) { console.warn("[alg birds] failed:", e); }
  }
  // HERDS (algHerds.js): sheep and goats grazing together round the mechtas,
  // the dechra and the springs; they bolt from soldiers. ?herds=0 = without.
  if (params.get("herds") !== "0") {
    onStatus("Herding the flocks…");
    try {
      app.algHerds = await createAlgHerds(app, { units: app.algUnits?.units ?? null, showroom: app.showroom });
    } catch (e) { console.warn("[alg herds] failed:", e); }
  }
  // Dev controls (?dev=0 hides them).
  if (params.get("dev") !== "0") {
    app.devPanel = createAlgDevPanel({ app, rtsCamera, light: AURES_LIGHT, applyLight: applyAuresLight });
  }

  onStatus("Painting surfaces…");
  await atlasReady;
  // needsUpdate uploads on the NEXT render: let two frames draw it under the
  // loading screen before it lifts.
  app.setFrameThrottle?.(0);
  // Build every pipeline the game will need NOW, under the loading screen, not
  // on the frame a unit type, effect or place is first drawn — nam-rts measured
  // 26 pipelines built mid-fight and a 987 ms frame before it had this
  // (shared-rts/pipelineWarmup.js). ?warmup=0 to A/B.
  if (params.get("warmup") !== "0") {
    onStatus("Preparing effects…");
    try {
      const w = await warmGamePipelines(app, engineObjects);
      console.log(`[warmup] ${w.warmed} drawables warmed in ${w.ms} ms`);
    } catch (e) { console.warn("[warmup] failed:", e); }
  }
  for (let i = 0; i < 2; i++) await new Promise((r) => requestAnimationFrame(r));
  const hud = document.getElementById("hud");
  if (hud) hud.textContent = `${boot.loaded ? boot.name : "no level"} · WASD pan · wheel zoom · Q/E rotate · C orbit`;
  return app;
}

export function applyAuresLight(app, L = AURES_LIGHT) {
  // The level's saved look (Atmosphere) is applied by the loader, over the boot mode.
  if (SKY_PRO) app.sky?.setMode?.("skypro");
  app.sky?.set?.({ latitude: L.latitude, dayOfYear: L.dayOfYear });
  app.sky?.setTimeOfDay?.(L.timeOfDay);
  app.postFx?.setPolish?.(L.polish);
  if (SKY_PRO) {
    // Its own light and air (see SKY_PRO): the engine's distance fog would haze twice.
    app.fog?.setHeight?.({ enabled: false });
    app.fog?.setDistance?.({ enabled: false });
    return;
  }
  app.sky?.setWorldLight?.(L.world);
  if (params.get("fog") === "0") return;
  app.fog?.setHeight?.({ enabled: false });
  // matchSky: the haze takes the horizon's colour, so the plain beyond the map
  // dissolves into the sky behind it instead of ending on a line.
  app.fog?.setDistance?.({ enabled: true, matchSky: true, color: L.haze.color, density: L.haze.density });
}
