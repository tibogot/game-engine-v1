// ALGERIA RTS ("Djebel") — boot: the v3 engine as a game, the Aurès map, the
// shared RTS camera and the Aurès light. No gameplay yet (games/alg-rts/TODO.md):
// this page is where the map and the new assets are judged, in the game's own
// light and camera rather than the editor's.
//
// Boot settings are nam-rts's, each measured there (games/nam-rts/namGame.js
// has the numbers): a fitted sun shadow instead of cascades, the lean terrain
// shader, top-3 layers + near/far tiling, the terrain drawn last.
//
// URL options (also ?grassfar=0, ?recvlods=1 — see the boot options): ?world=/levels/other.v3proj · ?light=flat (the engine's default
// light, to A/B) · ?fog=0 · ?warmup=0 (no pipeline warm-up, to A/B it) ·
// ?sky=atmosphere (the old Atmosphere sky and its tuned Aurès light, to A/B;
// the default is SKY PRO since 2026-09-29, see SKY_PRO below)
import { startV3App, createLevelLoader } from "../../v3/engine.js";
import { SIDES, setHumanSide } from "../shared-rts/teams.js";
import { createRtsCamera } from "../shared-rts/rtsCamera.js";
import { placeShowroom, SHOWROOM } from "./showroom.js";
import { prefetchCave } from "./algCave.js";
import { createAlgLandmarks, landmarkEntries } from "./algLandmarks.js";
import { createAlgDevPanel } from "./devPanel.js";
import { createAlgFog } from "./algFog.js";
import { rtsAtlasReady } from "../../v3/render/objects/rtsTextures.js";
import { LAYOUT, MAP, PLAY, VIEW_YAW, siteYaw } from "./layout.js";
import { systemsOff } from "./mapSystems.js";
import { buildFarmstead } from "../../v3/render/objects/rtsAlgVillage.js";
import { createAlgUnits } from "./algUnits.js";
import { createAlgNightLamps } from "./algNightLamps.js";
import { createAlgBattle } from "./algBattle.js";
import { createAlgPoles } from "./algPoles.js";
import { createAlgDamage } from "./algDamage.js";
import { createAlgWire } from "./algWire.js";
import { createAlgFields } from "./algFields.js";
import { createAlgVillageLife } from "./algVillageLife.js";
import { createAlgPointFlags } from "./algPointFlags.js";
import { createAlgPointRings } from "./algPointRings.js";
import { createAlgHens } from "./algHens.js";
import { createAlgBirds } from "./algBirds.js";
import { createAlgAmbience } from "./algAmbience.js";
import { createAlgStones, prefetchStonePhotos } from "./algStones.js";
import { createAlgSplats, prefetchAlgSplats } from "./algSplats.js";
import { applyMacroGround } from "./algMacroGround.js";
import { createAlgSea } from "./algSea.js";
import { installGameCursors } from "./ui/cursors.js";
import { batchStaticInstances } from "../../v3/render/staticInstanceBatch.js";
import { contactSplats } from "./algGroundContact.js";
import { buildSandstoneField, prefetchSandstone, sandstoneLook } from "./algSandstone.js";
import { createAlgTelegraph } from "./algTelegraph.js";
import { createAlgSounds } from "./algSounds.js";
import { createGameMenu, loadOptions } from "./ui/gameMenu.js";
import { createUiScale } from "./ui/uiScale.js";
import { createAlgVoices } from "./algVoices.js";
import { createAlgHerds } from "./algHerds.js";
import { createAlgCivilians } from "./algCivilians.js";
import { snapshotEngineScene, warmGamePipelines } from "../shared-rts/pipelineWarmup.js";
import { xrayParams } from "../shared-rts/xraySilhouette.js";
import { rtsEngineOptions, beginRtsPerfBoot } from "../shared-rts/rtsPerfBoot.js";
import "../../v3/styles/editor.css";
import { t } from "./i18n/i18n.js";

const params = new URLSearchParams(location.search);
// ?cam=old: the 40° camera of before CoH 3's was matched (2026-10-11) — the camera, its plant floors,
// its haze, its listener (below).
const OLD_CAM = params.get("cam") === "old";
// THE HUMAN'S SIDE (2026-10-10, "play the FLN", step 1): ?side=fln — you command the FLN (the team
// "enemy"), see through ITS eyes; the FLN's AI is off then (and no French AI yet: step 2). The team
// strings stay the factions; shared-rts/teams.js SIDES.human says which one is yours.
setHumanSide(params.get("side") === "fln" ? "enemy" : "player");
// WHAT THIS MAP SHOWS (mapSystems.js): each map lists its systems (maps/*.js `systems`); the
// others OFF unless the URL says otherwise. Written into the address so every module that reads
// its switch sees it. (The Aurès lists them all: nothing written. The training: the same eight
// as its old OFF list, in the same order.)
{
  let changed = false;
  for (const k of systemsOff(MAP)) if (!params.has(k)) { params.set(k, "0"); changed = true; }
  if (changed) history.replaceState(null, "", `${location.pathname}?${params}${location.hash}`);
}
// A map's OWN scenery (maps/training.js `scenery`): algLandmarks' rocks and lone trees at its counts,
// even with ?landmarks=0 (which keeps the Aurès' farmsteads and ruins out). ?scenery=0 = without.
const SCENERY = params.get("landmarks") !== "0" || (!!MAP.scenery && params.get("scenery") !== "0");

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
  // 16:00 (you picked "C" in the A/B/C, 2026-10-07; was 15.2): a lower sun, longer CoH shadows
  // that still leave the courtyards readable (16:36 sank them to black).
  timeOfDay: 16.0,
  // SKY PRO's base exposure (2026-10-04, you picked "B · darker" in the live light A/B):
  // the engine's 0.55 metered the sunny start x2.3 and the post's whites clipped, the sand
  // pale. Dev → Sky → Exposure / Time of day adjust it live.
  skyProExposure: 0.42,
  // THE SHADE (2026-10-07, CoH audit 2 item 1: shaded walls and ground read near black). Sky Pro's
  // sun at this × against the same sky (engine skyProSky.sunScale, day only): the auto exposure
  // brings the sunlit ground back and the shade rises with it — detail in the shadows, as in CoH.
  // MEASURED that the hemisphere light and the environment intensity do nothing visible here.
  skyProSunScale: 0.55,
  // The sun carries the frame (nam's lesson: a sky-lit frame is flat), the
  // fill stays warm and low, exposure brings the mean back up.
  world: { dir: 4.8, skyFill: 0.4, hemi: 0.9, exposure: 1.45 },
  // The grade (same "C"; was contrast 1.12, saturation 0.9, no vignette). The vignette runs in the
  // polish pass that already ran — no pass added.
  polish: { enabled: true, contrast: 1.18, saturation: 0.92, temperature: 0.16, vignetteStrength: 0.25, vignetteFalloff: 0.6, vignetteRoundness: 1 },
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
 * SKY PRO — THE DEFAULT (you, 2026-09-29; `?sky=atmosphere` for the old sky):
 * the engine's "skypro" sky mode. It brings its own light (the sun through its air, in
 * Tidewater's units, the sky as the ambient), its own haze and its clouds'
 * shadows, so the Aurès light above (tuned for the Atmosphere sky) steps aside:
 * no setWorldLight, no distance fog. The clock, latitude and grade stay.
 */
const SKY_PRO = params.get("sky") !== "atmosphere";

/** The live far-grass tint: only where the ground cache does not bake far grass (see FAR GRASS). */
const FAR_GRASS_TINT = params.get("grassfar") === "1" || params.get("gc") === "0" || params.get("fargrass") === "0";

export async function startAlgGame({ container, onStatus = () => {}, onProgress = null } = {}) {
  onStatus(t("Démarrage du moteur…"));
  // NO DEV PANEL YET (it comes late in the boot; ?dev=0: never): its width 0, or every HUD rule's
  // `var(--alg-dev-w, 340px)` laid the HUD out 340 px in from the right — and the interface scale
  // measured it there (2026-10-09, you: "the UI bottom right clips under the screen").
  const rootStyle = document.documentElement.style;
  if (!rootStyle.getPropertyValue("--alg-dev-w")) rootStyle.setProperty("--alg-dev-w", "0px");
  // The stones' ground photos: fetched and decoded now, behind the engine's start (algStones.js).
  prefetchStonePhotos();
  prefetchAlgSplats();   // and the ground splats' (algSplats.js)
  // The sandstone rocks' shapes, in worker threads (algSandstone.js; ~1-1.7 s each on one thread).
  if (SCENERY) prefetchSandstone();
  prefetchCave();   // the cave's rocks too (algCave.js): in workers from the top of the boot
  // The kit's surface atlas is painted in a worker; until it lands every
  // building and vehicle wears a flat olive-grey placeholder. Started first
  // so it paints while the engine and the level load, and awaited before the
  // loading screen lifts (you saw the post go grey → textured after a second).
  const atlasReady = rtsAtlasReady();
  const app = await startV3App({
    // The RTS performance defaults (shared-rts/rtsPerfBoot.js): instance
    // matrices as attributes, shared builds, plant cull + batching, the card
    // depth pre-pass… each with its ?flag. This game's own options below win.
    ...rtsEngineOptions(params),
    container,
    // ?msaa=0: no 4x MSAA (to measure its cost; the look keeps it).
    antialias: params.get("msaa") !== "0",
    // The Atmosphere sky (3-LUT scattering). A game gets the old procedural
    // sky unless it asks, and setWorldLight below only drives this one.
    // ?sky=pro: Sky Pro, with its clouds' shadows on the land (the sun's
    // cloud-shadow slot: one more texture per lit material, no sampler).
    skyMode: SKY_PRO ? "skypro" : "atmosphere",
    cloudShadows: SKY_PRO,
    // LOCAL LIGHTS (fires, lamps, muzzle flashes at night: v3/render/lighting/localLights.js,
    // app.localLights). No fixed cost — measured: installed with no light on screen = not
    // installed. ?locallights=0 = without.
    localLights: params.get("locallights") !== "0",
    // Three shapes of every tree (palm clumps, cedars, oaks): one shape
    // repeated across a grove read as a stamp.
    tallPlantVariants: Number(params.get("variants") ?? 3),
    // Every plant detail level RECEIVES shadows (the engine default is the
    // near one only): the RTS view shows all three at once, and past the
    // first step the crowns went flat and bright — a band that followed the
    // camera (you, 2026-10-01). ?recvlods=1 = the old way, to A/B.
    scatterReceiveLods: Number(params.get("recvlods") ?? 3),
    // Plant detail steps OFF the screen at every zoom (the farthest corner seen is ~125 m): a step
    // on screen was a band of plants changing as you panned. MEASURED: +0.45 ms GPU at max zoom.
    // (CoH 3's camera, 2026-10-11: the farthest ground seen at max zoom is 167-187 m (measured, 16:9;
    // was ~120) and a tall plant past the top edge still shows its crown: the first step at 215 m.
    // [190, 260] first: a tree at the top of the screen still popped — you. ?cam=old keeps the old ones.)
    scatterLodFloors: OLD_CAM ? [130, 180] : [215, 290],
    // shadowRadius 2 (engine default 4): the PCF disc is radius × texel, and at
    // 4 the palm fronds and soldiers smeared to grey smudges; 1 was crisp but
    // grainy. Chosen by eye in-game, 2026-09-29.
    csm: { cascades: 2, maxFar: 300, enabled: false, shadowRadius: 2 },
    // Compiled out: what this map never uses — no River v2 river (the wadis
    // are dry paint), no painted grass blades, no flower field — so their
    // terrain tints only multiplied zeros. MEASURED 2026-09-27 at 2x
    // zoom-out, A/B/A/B same clock: 82.3/79.2 → 77.7/77.8 ms. Lakebed STAYS
    // (the oases are lakes). Turn one back on the day the map uses it.
    // FAR GRASS (you, 2026-10-01): the oases have grass, and its blades fade
    // at 44-68 m from the camera — mid-screen in this view. Past them the
    // ground went bare (a line that followed the camera). The live tint
    // (grassFar) fixed the colour but read as tiled ground, so the ground
    // cache now BAKES real far grass (groundCache farGrass, below) and the
    // tint is only the fallback: on without the cache (?gc=0) or the bake
    // (?fargrass=0), or by hand (?grassfar=1) to compare.
    terrainFeatures: { cursor: false, snow: false, baseStyle: "flat", riverSand: false, grassFar: FAR_GRASS_TINT, flowerTint: false },
    // ?topk= ?farblend= ?layers= for A/B (perf investigation, 2026-09-27).
    // layerBudget 7: slot 6 is the Dirt track (tools/algTracks.mjs). At 6 it
    // was compiled OUT and the tracks drew the flat base colour, no texture
    // (you, 2026-09-29: "see how it looks so flat").
    splatFeatures: { solo: false, layerBudget: Number(params.get("layers") ?? 7), topK: Number(params.get("topk") ?? 3), farBlend: params.get("farblend") !== "0" },
    // THE GROUND CACHE (v3/terrain/groundCache.js, 2026-10-01): the paint and
    // the decals baked around the camera, read with four taps — the CoH way
    // (their terrain is a texture cache of tiles + splats). ?gc=0 = the live
    // paint blend, to A/B.
    // farGrass: a top-down grass photo baked where grass is painted, past the
    // blades (groundCache.js FAR GRASS). ?fargrass=0 = without.
    // detail: the paint layer's fine grain added back at draw time (groundCache
    // DETAIL; the cache alone kept 72-87% of it). OFF (you, 2026-10-02: "a
    // repeating pattern, unnatural"): it reads the photo at its PLAIN repeat
    // over a cache baked hex-tiled, so the two never line up and the ratio
    // printed a regular diagonal hatch over all the ground (A/B at the oasis
    // village: on = the hatch, off = gone). ?detail=1 = with, to compare.
    groundCache: { farGrass: params.get("fargrass") !== "0", hexBake: params.get("gchex") !== "0", detail: Number(params.get("detail") ?? 0) },
  });
  // Boot loop, parallel pipelines, stats-gl off, the perf line
  // (shared-rts/rtsPerfBoot.js). ONE engine frame a second behind the loading
  // screen here: nam-rts boots faster with none, this game was measured the
  // other way (2026-10-03: ready 29.0 / 30.3 s without frames vs 24.7 / 24.7
  // with). ?bootframes=0 = none, ?parboot=0 ?stats=1 ?perf=0 as before.
  const perfBoot = beginRtsPerfBoot(app, { params, bootFrames: true });
  // Cloud shadows start OFF (you, 2026-09-30: sweeping shadows get in the way
  // while debugging). The shadow map stays attached — Dev → Sky → Cloud
  // shadows turns them on, or ?cloudshadows=1 at boot.
  app.setCloudShadows?.(SKY_PRO ? { mapOn: params.get("cloudshadows") === "1" } : { enabled: params.get("cloudshadows") === "1" });

  const levels = createLevelLoader(app, { defaultUrl: MAP.level, onStatus, onProgress });
  const boot = await levels.loadBoot();
  // A map with the GAME'S SEA (maps/coast.js `sea`): its level carries NO ocean (nothing compiled,
  // nothing drawn — Ocean Pro, kept in a level, compiled at the first frames and logged an MSAA
  // depth-type WGSL error); the SEA LEVEL is the map's, answered here to every game system that asks
  // (the nav grid, the units, the minimap, the scenery: app.getWaterLevelAt) before any is built.
  // ?sea=pro = Ocean Pro switched on at this level instead, to compare.
  if (MAP.sea) {
    const L = MAP.sea.level;
    if (params.get("sea") === "pro") app.environment?.ocean?.set?.({ enabled: true, mode: "pro", seaLevel: L });
    else { const engineWater = app.getWaterLevelAt; app.getWaterLevelAt = (x, z) => Math.max(engineWater(x, z), L); }
  }
  // What the ENGINE put in the scene: the warm-up at the end leaves it alone.
  const engineObjects = snapshotEngineScene(app.scene);

  // Terrain last among the opaque things (nam-rts: the dearest shader, drawn
  // first, was shaded under everything and then covered).
  for (const m of app.getTerrainMeshes?.() ?? []) m.renderOrder = 8;   // render-order-ok: the OPAQUE terrain (engine band)
  // The x-ray silhouettes test the ground between a unit and the camera (a
  // hill hides a unit, no silhouette); set before any unit's material is made.
  xrayParams.heightTexNode = app.heightTexNode ?? null;

  app.postFx?.setEnabled(true);
  // CHEAP BLOOM (2026-10-02, you: "the cheap bloom first"): THRESHOLD mode, not
  // selective. Selective needs a 4th MSAA attachment (emissive) written per
  // sample on every pixel of the scene pass: MEASURED most of the old 6.6-8.9
  // ms (scale 2) — the blur was ~1 ms of it. Threshold reads the colour the
  // frame already has; only real light passes 1.6 (flashes, fireballs, sparks,
  // tracers are HDR) — not the white post in the sun, not the sky (fog of war
  // and haze sit under 1). And the blur chain starts at an EIGHTH of the frame
  // (postFxPipeline `resolution`; stock: a half). MEASURED interleaved at
  // scale 2: 0.42-0.47 ms; seen: fireball, muzzle flashes, the tank's flash,
  // sparks glow; walls and sand do not. ?bloom=0 = off.
  //
  // ROUND 2, same day (you: "the bloom makes everything white bloom — the flags,
  // the sheep, the hens"): threshold mode was wrong — in this sun a white sheep
  // is as bright as a muzzle flash. Back to SELECTIVE (only what a material
  // marks as emissive glows), but its attachment is a 1-byte MASK (pipeline
  // `mask`), not the RGBA16F colour that cost the 5 ms: the bloom reads the
  // scene colour times the mask.
  app.postFx?.setBloomSelective(true);
  app.postFx?.setBloom({ enabled: params.get("bloom") !== "0", strength: 1.2, threshold: 0, radius: 0.6, smoothWidth: 0.01, resolution: 0.125, mask: true });
  // FIREFLIES (2026-10-04, you: "I can still see the flashing coloured lights"): lone shading
  // blow-ups (3-500x their neighbours, ~8 a frame) pulled down before anything reads the
  // scene colour (v2/render/post/despeckleNode.js). ?despeckle=0 = without (A/B).
  app.postFx?.setDespeckle?.(params.get("despeckle") !== "0");
  // CRISP, NOT SOFT (you, 2026-10-01: "CoH looks really good resolution").
  // FXAA ran ON TOP of the 4x MSAA and blurred every pixel of the frame:
  // MEASURED same frame, the fine detail (Laplacian) went ×2.7 with it off —
  // stones defined instead of soft blobs. MSAA still smooths geometry edges;
  // FXAA only adds anti-aliasing to alpha-cut leaves and thin wires (judge
  // shimmer while panning). A light CAS sharpen on top (0.3). ?fxaa=1 brings
  // FXAA back; ?sharpen=0..1 sets the sharpen (0 = off).
  const postState = app.postFx?.state;
  if (postState) {
    postState.fxaa.enabled = params.get("fxaa") === "1";
    const sharp = Number(params.get("sharpen") ?? 0.3);
    Object.assign(postState.sharpen, { enabled: sharp > 0, sharpness: sharp });
    app.postFx.apply();
  }
  app.shadows?.setEnabled?.(false);   // the fitted frustum, not cascades (nam-rts measured)
  // THE SHADOW'S NORMAL BIAS FOLLOWS ITS TEXEL (2026-10-12, you: a lit band at a rock's foot, over
  // its shadow). 0.12 m (rtsPerfBoot) was set for one 2048 map over the whole ~340 m view — a 17 cm
  // texel, 0.7 of one. The frustum is FITTED now: 2.3-5.9 cm a texel by zoom, so 0.12 was 2-5
  // texels, and the ground that far from a caster's foot came out lit — a band under every
  // overhang. One texel, never under 2 cm. ?nbias=0.12 = the old fixed value.
  {
    const fixedNB = params.has("nbias") ? Number(params.get("nbias")) : null;
    let sunL = null;
    app.scene.traverse((o) => { if (!sunL && o.isDirectionalLight && o.castShadow) sunL = o; });
    if (sunL) app.addPreRenderHook?.(() => {
      const tx = app.shadows?.fitInfo?.()?.texel;
      sunL.shadow.normalBias = fixedNB ?? (tx > 0 ? Math.max(0.02, tx) : 0.12);
    });
  }

  // The plain outside the heightmap is bare ground: soil, not the editor's white.
  app.setGroundBase?.({ baseColor: PLAIN_COLOR, lineColor: PLAIN_COLOR, ao: 0 });
  // The far mountains past the map's edge come with the MAP now (its far
  // terrain, drawn by the engine's terrain — tools/algMountains.mjs). ?farterrain=0
  // turns them off to compare.
  if (params.get("farterrain") === "0") app.setFarTerrain?.({ enabled: false });

  if (params.get("light") !== "flat") applyAuresLight(app);
  // THE OASIS WATER (2026-10-07, CoH audit 2 item 5: the ponds read bright cyan beside the ochre —
  // another game's palette). The level's lake water let green through and scattered a green tint;
  // an Aurès oasis pond is olive and murky: more absorption in green, an olive-brown inscatter.
  // (Tried a mud brown first: read as a puddle.) The level file keeps its own values.
  {
    const L = app.lakeSystem, w = L?.toolState?.lake?.water;
    if (w) { Object.assign(w, { absorptionR: 0.42, absorptionG: 0.2, absorptionB: 0.45, inscatterTint: "#1f2a14", inscatterStrength: 0.8 }); L.syncMaterial?.(); }
  }
  // THE GRADE STEPS ASIDE AT NIGHT. The Aurès grade (contrast 1.18, warm 0.16, saturation 0.92)
  // is a summer afternoon's: at night its contrast crushed the moonlit walls to black and its
  // warmth fought the night look's blue (seen at the post, 23 h). It eases to neutral with the
  // sky's night amount. `app.algPolish` is the day grade (Dev → Light edits it).
  app.algPolish = AURES_LIGHT.polish;
  const NEUTRAL = { contrast: 1, saturation: 1, temperature: 0 };
  let lastNight = -1, lastDay = "";
  // PAUSE (ui/gameMenu.js): while app.paused the game's frame hooks get no time — the sim, the
  // score clock, the animals, the flags, the smoke all stop; the camera (a pre-UPDATE hook) and
  // the engine's own hooks keep real time.
  {
    const add = app.addPreRenderHook.bind(app), remove = app.removePreRenderHook?.bind(app);
    const wrapped = new Map();
    app.addPreRenderHook = (fn) => {
      const w = Object.defineProperty((dt) => fn(app.paused ? 0 : dt), "name", { value: fn.name || "algHook" });
      wrapped.set(fn, w);
      return add(w);
    };
    if (remove) app.removePreRenderHook = (fn) => remove(wrapped.get(fn) ?? fn);
  }
  app.addPreRenderHook(function algNightGrade() {
    const n = app.sky?.night ?? 0;
    const day = app.algPolish;
    const dayKey = `${day.contrast},${day.saturation},${day.temperature}`;
    if (Math.abs(n - lastNight) < 0.002 && dayKey === lastDay) return;
    lastNight = n; lastDay = dayKey;
    const out = { ...day };
    for (const k of Object.keys(NEUTRAL)) if (day[k] !== undefined) out[k] = day[k] + (NEUTRAL[k] - day[k]) * n;
    app.postFx?.setPolish?.(out);
  });

  // The new assets, on the map, until gameplay places them (showroom.js).
  if (params.get("showroom") !== "0") {
    onStatus(t("Mise en place du décor…"));
    // + the farmsteads and ruins between the villages (algLandmarks.js). ?landmarks=0 = without.
    const extra = params.get("landmarks") !== "0" ? landmarkEntries(app, SHOWROOM) : [];
    // A map's own farmsteads (maps/training.js: the shepherd's lesson), landmarks or not.
    (MAP.farmsteads ?? []).forEach((f, i) => extra.push({ key: `mechtaFarmMap${i + 1}`, build: (o) => buildFarmstead({ ...o, seed: 1975 + i * 7 }), x: f.x, z: f.z, yaw: VIEW_YAW + (f.turn ?? 0), ground: true }));
    // The sandstone cave's rocks (algCave.js), made in workers: waited for here, not built on the main thread.
    await prefetchCave();
    app.showroom = await placeShowroom(app, [...SHOWROOM, ...extra]);
  }

  onStatus(t("Réglage de la caméra…"));
  // THE COMPANY OF HEROES LENS (you, 2026-09-30): a narrower field of view
  // (40°, was the app's 60 — on a 2:1 window that was ~103° across: small,
  // far units and stretched edges) from further back, so the same ground
  // fills the screen with bigger units; the start tilted ~43° (CoH's
  // editor default is 45). The zoom range grown by tan 30° / tan 20° ≈ 1.6
  // so the closest and furthest views cover what they did.
  // THE CEILING (a player, 2026-10-07, zoomed right out: "CoH doesn't let you"): 190 m was a
  // satellite view, 165 m up, men 3 px — the drama, the cover, the ambush all gone. CoH holds the
  // camera at about a battle's width: 85 m now (~70 m up; 110 first, "still too high"), the last stretch of the wheel slowing
  // into it (softTop), and the tilt steep and nearly fixed (48-56°, was 35-60: zooming is closer /
  // further, not from the ground / from a plane). Seeing the whole map is the minimap's job.
  // COH 3'S CAMERA (you, 2026-10-11: "CoH tilts it a bit more"; measured from its default view,
  // assets-src/refs/coh3/README.md): a LONG lens from further back, flatter perspective, ~44° down
  // at the default — ours was 40° / 65 m / 53°. The SAME ground in view at every zoom (distances
  // × tan 20° / tan 13° ≈ 1.58: the men as big as before — the ceiling's complaint was their size),
  // the tilt 9° lower (CoH's ~44° at the default). ?cam=old = the 40° camera, to compare.
  const rtsCamera = createRtsCamera(OLD_CAM
    ? { app, fov: 40, distMin: 24, distDefault: 65, distMax: 85, pitchNear: 48, pitchFar: 56 }
    : { app, fov: 26, distMin: 38, distDefault: 102, distMax: 134, pitchNear: 39, pitchFar: 47 });
  // The sound's listener height (rtsAudio folds it into the distance): the camera now sits higher at
  // the same zoom, so it is scaled back to what the old one heard (52 m → 71 m at the default).
  rtsCamera.audioHeightK = OLD_CAM ? 1 : 0.73;
  rtsCamera.params.softTop = 0.3;
  // EDGE SCROLL the CoH way (a player, 2026-10-07: "not UX friendly" — the HUD along the edges
  // blocked it and the 14 px band reached full speed only at the last pixels): the window's edge,
  // whatever is under it; a 24 px band, the arrow cursor.
  rtsCamera.params.edgeMode = "screen";
  rtsCamera.params.edgeBand = 24;
  rtsCamera.setMode("rts");
  // The camera stays over the playable area (layout.js PLAY): the rest is scenery.
  rtsCamera.setBounds(PLAY);
  // Start over the playable side's base (layout.js).
  const base = LAYOUT.sites.find((s) => s.kind === (SIDES.human === "enemy" ? "aln" : "french"));
  if (base) {
    rtsCamera.focusOn(base.x, base.z);
    // Look toward the ALN, not at our own edge; the buildings face this view.
    rtsCamera.setYaw(VIEW_YAW);
  }
  app.rtsCamera = rtsCamera;
  // THE GAME'S CURSORS (ui/cursors.js): a brass arrow, the targeting reticle, the edge arrows.
  app.algCursors = installGameCursors({ app });
  // The ground cache centres on the camera's focus: turning or zooming the
  // camera then re-bakes nothing.
  app.groundCache?.setFocusFn(() => rtsCamera.getView().focus);
  // At the START of the frame: the terrain, the plant fields and the shadow fit
  // then see this frame's view, not the last one (things at the screen's edge
  // appeared a frame late while panning).
  (app.addPreUpdateHook ?? app.addPreRenderHook)((dt) => rtsCamera.update(dt));
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
    onStatus(t("Rassemblement des troupes…"));
    app.algUnits = await createAlgUnits(app, {
      showroom: app.showroom,
      muster: { x: b.x - Math.sin(yaw) * 42, z: b.z - Math.cos(yaw) * 42, yaw },
    });
  }
  // THE LAMPS OF THE NIGHT (algNightLamps.js): gate lamps, lit doorways, the camp's fire —
  // local lights x the sky's night, nothing by day. ?lamps=0 = without.
  if (params.get("lamps") !== "0" && app.showroom) {
    try { app.algNightLamps = createAlgNightLamps(app); } catch (e) { console.warn("[alg lamps] failed:", e); }
  }
  // THE INTERFACE SIZE (ui/uiScale.js), started BEFORE the battle builds its panels and the
  // briefing: started with the game menu below, the briefing came up at 100 % and jumped to the
  // option (115 % then) half a second later — "the briefing panel scales up" (you,
  // 2026-10-11). The game menu reuses this one.
  try { app.algUiScale = createUiScale(loadOptions().uiScale); } catch (e) { console.warn("[alg ui scale] failed:", e); }
  // THE BATTLE (algBattle.js): the villages as victory points (CoH), the cave
  // and the post as sudden death, alerts, village markers, the briefing and
  // the end screen. ?battle=0 = without; ?brief=0 skips the briefing.
  if (params.get("battle") !== "0" && app.algUnits) {
    try {
      app.algBattle = createAlgBattle(app, {
        units: app.algUnits.units, economy: app.algEconomy, structures: app.algStructures,
        mines: app.algMines ?? null, minimap: app.algUnits.minimap ?? null, rtsCamera,
      });
    } catch (e) { console.warn("[alg battle] failed:", e); }
  }
  // THE BRIEFING DURING THE BOOT (2026-10-08, the boot audit: the rest of the boot — the ground,
  // the fields, the herds, the shader warm-up — is ~13 s the player can spend reading): shown
  // now, over the loading screen; its "À vos postes" waits for the end of the boot (bootReady).
  // ?brief=0 starts at the remembered difficulty.
  // THE TRAINING (algTutorial.js): its own briefing, its lessons instead of the battle's rules.
  if (MAP.tutorial && app.algBattle) {
    try {
      const { createAlgTutorial } = await import("./algTutorial.js");
      app.algTutorial = createAlgTutorial(app);
    } catch (e) { console.warn("[alg tutorial] failed:", e); }
  }
  let bootReady = null;
  if (app.algBattle && params.get("brief") !== "0") {
    let release;
    bootReady = new Promise((r) => { release = r; });
    bootReady.release = release;
    try { (app.algTutorial ?? app.algBattle).brief({ ready: bootReady }); } catch (e) { console.warn("[alg brief] failed:", e); }
  }
  // THE TELEGRAPH LINE (algPoles.js): poles and wires along the pistes, one
  // draw each. ?poles=0 = without.
  if (params.get("poles") !== "0") {
    try { app.algPoles = createAlgPoles(app, { navGrid: app.navGrid ?? null }); } catch (e) { console.warn("[alg poles] failed:", e); }
    // THE LINE AS A STAKE (algTelegraph.js): the FLN fells poles, the post loses Algiers.
    if (app.algPoles && app.algUnits) {
      app.algTelegraph = createAlgTelegraph(app, { poles: app.algPoles, units: app.algUnits.units });
      app.addPreRenderHook(function algTelegraphStep() { app.algTelegraph.step(); });
    }
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
  // GROUND SPLATS (algSplats.js): the CoH layer — patches of cracked mud,
  // gravel, rubble, leaves, laid by rule into the ground cache. ?splats=0 =
  // without (and nothing to lay without the cache, ?gc=0).
  if (params.get("splats") !== "0" && app.groundCache) {
    onStatus(t("Usure du terrain…"));
    try { app.algSplats = await createAlgSplats(app); } catch (e) { console.warn("[alg splats] failed:", e); }
  }
  // THE GAME'S OWN SEA (algSea.js, a map with `sea`: the coast): drawn for the RTS camera, at the
  // map's sea level. ?sea=pro = Ocean Pro instead (switched on above), to compare.
  if (MAP.sea && params.get("sea") !== "pro") {
    try { app.algSea = createAlgSea(app, { level: MAP.sea.level }); } catch (e) { console.warn("[alg sea] failed:", e); }
  }
  // THE MACRO PHOTO (algMacroGround.js): the ground's large-scale variation. ?macro=0 = without.
  if (params.get("macro") !== "0") {
    try { await applyMacroGround(app); } catch (e) { console.warn("[alg macro] failed:", e); }
  }
  // STONES (algStones.js): loose stones textured with the ground they lie on,
  // placed from the map's paint. ?stones=0 = without.
  if (params.get("stones") !== "0") {
    try { app.algStones = await createAlgStones(app); } catch (e) { console.warn("[alg stones] failed:", e); }
  }
  // SOUND (algSounds.js on the shared mixer): the battle, the engines, the
  // land (wind, cicadas, dogs, flocks, the call to prayer). ?sound=0 = without.
  if (params.get("sound") !== "0") {
    try { app.algSounds = createAlgSounds({ app, rtsCamera, units: app.algUnits?.units ?? null }); } catch (e) { console.warn("[alg sound] failed:", e); }
    // VOICES (algVoices.js): barks in French and Algerian Arabic, the HQ on
    // the radio. Silent until tools/genVoices.mjs has made the files.
    if (app.algSounds && app.algUnits && params.get("voices") !== "0") {
      try {
        app.algVoices = createAlgVoices({ app, audio: app.algSounds.audio, units: app.algUnits.units, fogOfWar: app.fogOfWar ?? null });
        app.addPreRenderHook((dt) => app.algVoices.step(dt));
      } catch (e) { console.warn("[alg voices] failed:", e); }
    }
  }
  // THE GAME MENU (ui/gameMenu.js): Esc / F10 — pause, the player's options, the keys.
  app.algMenu = createGameMenu({ app, audio: app.algSounds?.audio ?? null, voices: app.algVoices ?? null, rtsCamera });
  // AMBIENCE (algAmbience.js): dust behind the vehicles, smoke from the
  // bread ovens. ?ambience=0 = without.
  if (params.get("ambience") !== "0") {
    try {
      app.algAmbience = createAlgAmbience(app, { units: app.algUnits?.units ?? null, showroom: app.showroom, wind: app.showroom?.wind ?? null });
    } catch (e) { console.warn("[alg ambience] failed:", e); }
  }
  // DAMAGE (algDamage.js): breached sandbags, burning and smoking houses with
  // rubble, smoking buildings. ?damage=0 = without.
  if (params.get("damage") !== "0") {
    try {
      app.algDamage = createAlgDamage(app, {
        showroom: app.showroom ?? {}, structures: app.algStructures ?? null, ambience: app.algAmbience ?? null,
        cover: app.algCover ?? null, fire: app.algCombat?.fire ?? null,
      });
    } catch (e) { console.warn("[alg damage] failed:", e); }
  }
  // BARBED WIRE (algWire.js): men go round it or cut it, vehicles crush it,
  // blasts cut it. Always on (the nav rule lives with the wire).
  if (app.algUnits) {
    try {
      app.algWire = createAlgWire(app, { units: app.algUnits.units, showroom: app.showroom ?? {}, navGrid: app.navGrid ?? null, ambience: app.algAmbience ?? null });
    } catch (e) { console.warn("[alg wire] failed:", e); }
  }
  // FIELDS (algFields.js): ploughed, stubble and barley plots round the
  // villages, low walls (cover), prickly-pear hedges (concealment) round
  // them and along the pistes near the villages. Then the cover map again,
  // with the walls in it. ?fields=0 = without.
  if (params.get("fields") !== "0" && app.algEconomy) {
    onStatus(t("Labour des champs…"));
    try {
      const t0 = performance.now();
      app.algFields = createAlgFields(app, { economy: app.algEconomy, navGrid: app.navGrid ?? null, showroom: app.showroom ?? {}, plants: app.showroom?.plants ?? null });
      console.log(`[fields] ${JSON.stringify(app.algFields.stats)} in ${Math.round(performance.now() - t0)} ms`);
    } catch (e) { console.warn("[alg fields] failed:", e); }
  }
  // ROCK OUTCROPS + LONE TREES (algLandmarks.js), after the fields so they
  // keep off them. Then the cover map once, with the walls and rocks in it.
  if (SCENERY) {
    try {
      const t0 = performance.now();
      app.algLandmarks = createAlgLandmarks(app, { showroom: app.showroom ?? {}, fields: app.algFields ?? null, navGrid: app.navGrid ?? null, plants: app.showroom?.plants ?? null,
        quantities: MAP.scenery?.quantities ?? null, keepClear: MAP.scenery?.keepClear ?? [] });
      console.log(`[landmarks] ${JSON.stringify(app.algLandmarks.stats)} in ${Math.round(performance.now() - t0)} ms`);
      // The SANDSTONE rocks: their shapes come from the workers started at the top of the boot.
      const t1 = performance.now();
      const field = await buildSandstoneField(app.algLandmarks.sandstone);
      if (field) { field.updateMatrix(); app.scene.add(field); app.algLandmarks.sandstoneMesh = field; app.algLandmarks.sandstoneLook = sandstoneLook; }
      // ?rocktop=0: the tops in the cracked photo (from the RTS camera the layered one shows as stripes).
      if (params.get("rocktop") === "0") sandstoneLook.topSame.value = 0;
      console.log(`[sandstone] ${app.algLandmarks.sandstone.length} rocks, ${field ? field.geometry.index.count / 3 : 0} tris, waited ${Math.round(performance.now() - t1)} ms`);
    } catch (e) { console.warn("[alg landmarks] failed:", e); }
  }
  // VILLAGE LIFE (algVillageLife.js): haystacks, firewood, bread ovens, beehives
  // just outside each village — after the fields and landmarks, off both. ?life=0 = without.
  if (params.get("life") !== "0") {
    try {
      const t0 = performance.now();
      app.algVillageLife = createAlgVillageLife(app, { navGrid: app.navGrid ?? null, showroom: app.showroom ?? {}, fields: app.algFields ?? null, plants: app.showroom?.plants ?? null });
      console.log(`[village life] ${JSON.stringify(app.algVillageLife.stats)} in ${Math.round(performance.now() - t0)} ms`);
    } catch (e) { console.warn("[alg village life] failed:", e); }
  }
  // THE POINTS' FLAGS (algPointFlags.js): a flagpole on every capture point, the flag rising
  // with the capture; a fuel or ammunition depot on the supply points. ?pointflags=0 = without.
  if (params.get("pointflags") !== "0" && app.algEconomy) {
    try {
      app.algPointFlags = createAlgPointFlags(app, { economy: app.algEconomy, navGrid: app.navGrid ?? null });
      app.addPreRenderHook((dt) => app.algPointFlags.frame(dt, app.camera));
      console.log(`[point flags] ${JSON.stringify(app.algPointFlags.stats)}`);
    } catch (e) { console.warn("[alg point flags] failed:", e); }
  }
  // THE SUPPLY POINTS' RINGS (algPointRings.js, 2026-10-12 — CoH 3's, from the building lab): always
  // shown, dash-dot white → the side's colour filling it → solid; the capture's flash, waves and
  // light when one changes hands. One instanced draw. ?pointrings=0 = without.
  if (params.get("pointrings") !== "0" && app.algEconomy) {
    try {
      app.algPointRings = createAlgPointRings(app, { economy: app.algEconomy });
      app.addPreRenderHook((dt) => app.algPointRings.frame(dt));
      console.log(`[point rings] ${JSON.stringify(app.algPointRings.stats)}`);
    } catch (e) { console.warn("[alg point rings] failed:", e); }
  }
  if (app.algFields || app.algLandmarks) app.algCover?.bake();
  // GROUND CONTACT SHADE (algGroundContact.js): the ground darkened round every building, wall
  // and rock, baked into the ground once — the image pass's AO at no cost a frame. ?contact=0 = off.
  if (app.algSplats && params.get("contact") !== "0") {
    const list = contactSplats(app, app.algSplats.matIndex("dust"), app.algSplats.matIndex("sandGrav"));
    app.algSplats.add(list);
    console.log(`[contact shade] ${list.length} splats`);
  }
  // The minimap was baked before the fields and farmsteads: again, with them.
  if (app.algFields || app.algLandmarks) { app.algUnits?.minimap?.rebuildTerrain?.(); app.algTacMap?.map?.rebuildTerrain?.(); }
  // HERDS (algHerds.js): sheep and goats grazing together round the mechtas,
  // the dechra and the springs; they bolt from soldiers. ?herds=0 = without.
  if (params.get("herds") !== "0") {
    onStatus(t("Rentrée des troupeaux…"));
    try {
      app.algHerds = await createAlgHerds(app, { units: app.algUnits?.units ?? null, showroom: app.showroom });
    } catch (e) { console.warn("[alg herds] failed:", e); }
  }
  // THE CAVE'S COOKING FIRE (algCave.js, 2026-10-11): the wrecks' flipbook flame (flameField.js — its
  // one instanced draw), small and low, for the whole match; the village ovens' light hearth smoke
  // over it (algAmbience ovens, always lit). Its night light: algNightLamps.js.
  // (and the FLN camp's, the same way: algAlnCamp.js)
  for (const cv of [app.showroom?.caveEntrance, app.showroom?.alnCamp]) {
    const cf = cv?.geometry?.userData?.campfire;
    if (cf) {
      cv.updateMatrixWorld(true);
      const w = cv.localToWorld(new cv.position.constructor(...cf)), y = app.getWorldHeight(w.x, w.z);
      app.algCombat?.fire?.addFire?.(w.x, y + 0.1, w.z, 0.9, 1e7, { heat: 0.8 });   // (0.55 sat in the cards' ground fade: no flame)
      app.algAmbience?.ovens?.push({ x: w.x, y: y + 0.9, z: w.z, next: 1e9, burn: true, t: 0 });
    }
  }
  // HENS (algHens.js, your bird-lab hens) round the houses and yards. ?hens=0 = without.
  if (params.get("hens") !== "0") {
    try {
      app.algHens = await createAlgHens(app, { units: app.algUnits?.units ?? null, showroom: app.showroom ?? {}, navGrid: app.navGrid ?? null });

  // ANIMALS DIE (2026-10-07; shared wildHerd `hurt`): blasts, stray rounds and fire hit the herds
  // and the hens (algCombat feeds it); a dead one bleeds and lies there, the rest bolt.
  {
    const all = () => [...(app.algHerds?.herds ?? []), ...(app.algHens?.herds ?? [])].filter(Boolean);
    // (a sheep's pool ~0.45 of a man's)
    for (const h of all()) h.onDeath = (a) => { app.algCombat?.blood.pool(a.x, a.z, a.yaw, Math.min(1, 0.3 + a.scale * 0.6)); app.algCombat?.blood.hit({ x: a.x, y: a.y + 0.6, z: a.z }); };
    app.algAnimals = {
      hurt(x, z, radius, damage) { let n = 0; for (const h of all()) n += h.hurt?.(x, z, radius, damage) ?? 0; return n; },
      get alive() { return all().reduce((n, h) => n + (h.alive ?? 0), 0); },
    };
    // FIRE burns them too: twice a second, every live fire hurts what stands in it.
    let fireT = 0;
    app.addPreRenderHook?.((dt) => {
      if ((fireT -= dt) > 0) return;
      fireT = 0.5;
      const F = app.algCombat?.fire, now = F?.now ?? 0;
      for (const f of F?.fires ?? []) if (f.end > now) app.algAnimals.hurt(f.x, f.z, f.radius, 6);
    });
  }    } catch (e) { console.warn("[alg hens] failed:", e); }
  }
  // CIVILIANS (algCivilians.js): the villages' people — their own list and crowd, never a target;
  // they go indoors when the shooting comes near. After the herds (a shepherd behind each flock).
  // ?civ=0 = without.
  if (params.get("civ") !== "0" && app.algEconomy && app.algGarrison) {
    try {
      const t0 = performance.now();
      app.algCivilians = await createAlgCivilians(app, {
        economy: app.algEconomy, garrison: app.algGarrison, herds: app.algHerds ?? null, navGrid: app.navGrid ?? null,
        showroom: app.showroom ?? {}, fogOfWar: app.fogOfWar ?? null, battleUnits: app.algUnits?.units ?? null,
      });
      app.addPreRenderHook((dt) => { const d = dt * (app.timeScale ?? 1); app.algCivilians.step(d); app.algCivilians.frame(d, app.camera); });
      console.log(`[civilians] ${JSON.stringify(app.algCivilians.stats)} in ${Math.round(performance.now() - t0)} ms`);
    } catch (e) { console.warn("[alg civilians] failed:", e); }
  }
  // Dev controls (?dev=0 hides them).
  if (params.get("dev") !== "0") {
    app.devPanel = createAlgDevPanel({ app, rtsCamera, light: AURES_LIGHT, applyLight: applyAuresLight });
  }

  onStatus(t("Peinture des surfaces…"));
  await atlasReady;
  // needsUpdate uploads on the NEXT render: let two frames draw it under the
  // loading screen before it lifts.
  app.setFrameThrottle?.(0);
  // STATIC PROPS BATCHED (v3/render/staticInstanceBatch.js, 2026-10-07 perf audit): the field
  // walls, outcrops, village props, poles and depots (one kit material) and the loose stones
  // (theirs) drew as ~26 instanced meshes in every pass; one indirect-drawing mesh per material
  // now. Only what never changes after the boot. ?staticbatch=0 = without.
  if (params.get("staticbatch") !== "0") {
    const STATIC = /^(FieldWalls|Outcrops|VillageLife:|TelegraphPoles|SupplyDepot:|Stones:)/;
    const list = [];
    app.scene.traverse((o) => { if (o.isInstancedMesh && STATIC.test(o.name)) list.push(o); });
    app.algStaticBatch = batchStaticInstances(app.renderer, app.scene, list, { name: "AlgStatic" });
    console.log(`[static batch] ${app.algStaticBatch.members} meshes → ${app.algStaticBatch.batches.length} batches`);
  }
  // Build every pipeline the game will need NOW, under the loading screen, not
  // on the frame a unit type, effect or place is first drawn — nam-rts measured
  // 26 pipelines built mid-fight and a 987 ms frame before it had this
  // (shared-rts/pipelineWarmup.js). ?warmup=0 to A/B.
  if (params.get("warmup") !== "0") {
    onStatus(t("Préparation des effets…"));
    try {
      const w = await warmGamePipelines(app, engineObjects);
      console.log(`[warmup] ${w.warmed} drawables warmed in ${w.ms} ms`);
    } catch (e) { console.warn("[warmup] failed:", e); }
  }
  // The ground cache around the starting view, all of it, before the screen
  // lifts (the loop only bakes a few tiles a frame).
  await perfBoot.endPipelines();
  await app.groundCache?.bakeAll(app.camera);
  // Drop the CPU copies of what only the GPU reads — grass, plant fields,
  // crowd skinning, the paint layers: ~260 MB held for nothing (heap
  // snapshot, 2026-10-03). After the bake above. ?gpuonly=0 keeps them.
  perfBoot.releaseMemory();
  for (let i = 0; i < 2; i++) await new Promise((r) => requestAnimationFrame(r));
  const hud = document.getElementById("hud");
  if (hud) hud.textContent = `${boot.loaded ? boot.name : "no level"} · WASD pan · wheel zoom · Q/E rotate · C orbit`;
  // The briefing is up already (above); its button is released now. ?brief=0: straight in.
  if (bootReady) bootReady.release();
  else if (app.algTutorial) app.algTutorial.start();
  else if (app.algBattle) app.algBattle.start();
  return app;
}

export function applyAuresLight(app, L = AURES_LIGHT) {
  // The level's saved look (Atmosphere) is applied by the loader, over the boot mode.
  if (SKY_PRO) app.sky?.setMode?.("skypro");
  app.sky?.set?.({ latitude: L.latitude, dayOfYear: L.dayOfYear });
  // ?tod=23 starts at that hour (the night: Sky Pro's moon, night look and local lights)
  const tod = Number(params.get("tod"));
  app.sky?.setTimeOfDay?.(Number.isFinite(tod) && params.has("tod") ? tod : L.timeOfDay);
  // THE NIGHT LOOK (Sky Pro, the "Realistic" style): exposure, the blue grade, the night sky.
  // Every term scales with the sky's night amount, so the day is untouched. ?nightlook=0 =
  // Tidewater's own night, darker.
  if (SKY_PRO && app.sky?.skyPro) {
    app.sky.skyPro.nightLook = params.get("nightlook") !== "0";
    // Tidewater's moon (high: 59° at 23 h), not the night look's low 18°: that one lays a glitter
    // path on a sea; this map has none, and a low moon left the land half as bright (MEASURED at
    // the post, 23 h: open ground 0.0016 at 18° vs 0.0034 at Tidewater's).
    app.sky.skyPro.moonElev = 0;
    if (L.skyProSunScale) app.sky.skyPro.sunScale = L.skyProSunScale;
    // The day darker (skyProExposure above), the NIGHT as it was tuned: the stops taken off
    // the base are given back on the night look's own EV, which scales with the night amount.
    const base = app.sky.skyPro.exposure;
    if (L.skyProExposure && base > 0) {
      app.sky.skyPro.exposure = L.skyProExposure;
      app.sky.skyPro.nightEV = (app.sky.skyPro.nightEV ?? 0) + Math.log2(base / L.skyProExposure);
    }
  }
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
  // (CoH 3's camera sits ~1.57x further: the haze thinned by as much, so the battle reads as before.)
  app.fog?.setDistance?.({ enabled: true, matchSky: true, color: L.haze.color, density: L.haze.density * (OLD_CAM ? 1 : 0.64) });
}
