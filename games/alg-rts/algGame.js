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
import { createRtsCamera } from "../shared-rts/rtsCamera.js";
import { placeShowroom, SHOWROOM } from "./showroom.js";
import { createAlgLandmarks, landmarkEntries } from "./algLandmarks.js";
import { createAlgDevPanel } from "./devPanel.js";
import { createAlgFog } from "./algFog.js";
import { rtsAtlasReady } from "../../v3/render/objects/rtsTextures.js";
import { LAYOUT, PLAY, VIEW_YAW, siteYaw } from "./layout.js";
import { createAlgUnits } from "./algUnits.js";
import { createAlgBattle } from "./algBattle.js";
import { createAlgPoles } from "./algPoles.js";
import { createAlgDamage } from "./algDamage.js";
import { createAlgWire } from "./algWire.js";
import { createAlgFields } from "./algFields.js";
import { createAlgHens } from "./algHens.js";
import { createAlgBirds } from "./algBirds.js";
import { createAlgAmbience } from "./algAmbience.js";
import { createAlgStones } from "./algStones.js";
import { createAlgSplats } from "./algSplats.js";
import { createAlgSounds } from "./algSounds.js";
import { createAlgVoices } from "./algVoices.js";
import { createAlgHerds } from "./algHerds.js";
import { snapshotEngineScene, warmGamePipelines } from "../shared-rts/pipelineWarmup.js";
import { xrayParams } from "../shared-rts/xraySilhouette.js";
import { createPerfHud } from "./ui/perfHud.js";
import { openParallelPipelines } from "../../v3/render/parallelPipelines.js";
import { releaseGpuOnly } from "../../v3/render/gpuOnlyArrays.js";
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
  onStatus("Starting engine…");
  // The kit's surface atlas is painted in a worker; until it lands every
  // building and vehicle wears a flat olive-grey placeholder. Started first
  // so it paints while the engine and the level load, and awaited before the
  // loading screen lifts (you saw the post go grey → textured after a second).
  const atlasReady = rtsAtlasReady();
  const app = await startV3App({
    container,
    preloadPaintTextures: false,
    // Instance matrices uploaded only when they change, not on every draw
    // (main.js; audit 2026-10-03). ?instubo=1 = three's per-draw uniform copy.
    instanceAttributes: params.get("instubo") !== "1",
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
    // Every plant detail level RECEIVES shadows (the engine default is the
    // near one only): the RTS view shows all three at once, and past the
    // first step the crowns went flat and bright — a band that followed the
    // camera (you, 2026-10-01). ?recvlods=1 = the old way, to A/B.
    scatterReceiveLods: Number(params.get("recvlods") ?? 3),
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
  app.setFrameThrottle?.(1000);
  // PIPELINES IN PARALLEL for the whole boot (v3/render/parallelPipelines.js):
  // the game scene's pipelines compile side by side on the browser's threads
  // instead of one after another (the boot ended waiting on that queue,
  // measured 2026-10-03); its draws behind the loading screen wait for them.
  // Bakes keep the synchronous path. Closed (all awaited) after the warm-up.
  // ?parboot=0 = one at a time, as before.
  const bootPipelines = params.get("parboot") !== "0" ? openParallelPipelines(app.renderer, app.scene) : null;
  // The stats-gl overlay: OFF (you, 2026-10-03: "off the stats panel"; it
  // cost 0.4-0.8 ms a frame, measured). ?stats=1 or Dev → Performance.
  app.setStatsOverlay?.(params.get("stats") === "1");
  // Our own perf line in its place (ui/perfHud.js): frame / CPU / draws twice
  // a second off the engine's counters, the honest GPU number on click. ?perf=0 hides.
  app.perfHud = createPerfHud(app, { visible: params.get("perf") !== "0" });
  // Cloud shadows start OFF (you, 2026-09-30: sweeping shadows get in the way
  // while debugging). The shadow map stays attached — Dev → Sky → Cloud
  // shadows turns them on, or ?cloudshadows=1 at boot.
  app.setCloudShadows?.(SKY_PRO ? { mapOn: params.get("cloudshadows") === "1" } : { enabled: params.get("cloudshadows") === "1" });

  const levels = createLevelLoader(app, { defaultUrl: "/levels/alg-aures.v3proj", onStatus, onProgress });
  const boot = await levels.loadBoot();
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

  // The plain outside the heightmap is bare ground: soil, not the editor's white.
  app.setGroundBase?.({ baseColor: PLAIN_COLOR, lineColor: PLAIN_COLOR, ao: 0 });
  // The far mountains past the map's edge come with the MAP now (its far
  // terrain, drawn by the engine's terrain — tools/algMountains.mjs). ?farterrain=0
  // turns them off to compare.
  if (params.get("farterrain") === "0") app.setFarTerrain?.({ enabled: false });

  if (params.get("light") !== "flat") applyAuresLight(app);

  // The new assets, on the map, until gameplay places them (showroom.js).
  if (params.get("showroom") !== "0") {
    onStatus("Placing assets…");
    // + the farmsteads and ruins between the villages (algLandmarks.js). ?landmarks=0 = without.
    const extra = params.get("landmarks") !== "0" ? landmarkEntries(app, SHOWROOM) : [];
    app.showroom = await placeShowroom(app, [...SHOWROOM, ...extra]);
  }

  onStatus("Setting up camera…");
  // THE COMPANY OF HEROES LENS (you, 2026-09-30): a narrower field of view
  // (40°, was the app's 60 — on a 2:1 window that was ~103° across: small,
  // far units and stretched edges) from further back, so the same ground
  // fills the screen with bigger units; the start tilted ~43° (CoH's
  // editor default is 45). The zoom range grown by tan 30° / tan 20° ≈ 1.6
  // so the closest and furthest views cover what they did.
  const rtsCamera = createRtsCamera({ app, fov: 40, distMin: 28, distDefault: 80, distMax: 190, pitchNear: 35, pitchFar: 60 });
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
    onStatus("Mustering…");
    app.algUnits = await createAlgUnits(app, {
      showroom: app.showroom,
      muster: { x: b.x - Math.sin(yaw) * 42, z: b.z - Math.cos(yaw) * 42, yaw },
    });
  }
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
  // THE TELEGRAPH LINE (algPoles.js): poles and wires along the pistes, one
  // draw each. ?poles=0 = without.
  if (params.get("poles") !== "0") {
    try { app.algPoles = createAlgPoles(app, { navGrid: app.navGrid ?? null }); } catch (e) { console.warn("[alg poles] failed:", e); }
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
    onStatus("Weathering the ground…");
    try { app.algSplats = await createAlgSplats(app); } catch (e) { console.warn("[alg splats] failed:", e); }
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
    onStatus("Ploughing the fields…");
    try {
      const t0 = performance.now();
      app.algFields = createAlgFields(app, { economy: app.algEconomy, navGrid: app.navGrid ?? null, showroom: app.showroom ?? {}, plants: app.showroom?.plants ?? null });
      console.log(`[fields] ${JSON.stringify(app.algFields.stats)} in ${Math.round(performance.now() - t0)} ms`);
    } catch (e) { console.warn("[alg fields] failed:", e); }
  }
  // ROCK OUTCROPS + LONE TREES (algLandmarks.js), after the fields so they
  // keep off them. Then the cover map once, with the walls and rocks in it.
  if (params.get("landmarks") !== "0") {
    try {
      const t0 = performance.now();
      app.algLandmarks = createAlgLandmarks(app, { showroom: app.showroom ?? {}, fields: app.algFields ?? null, navGrid: app.navGrid ?? null, plants: app.showroom?.plants ?? null });
      console.log(`[landmarks] ${JSON.stringify(app.algLandmarks.stats)} in ${Math.round(performance.now() - t0)} ms`);
    } catch (e) { console.warn("[alg landmarks] failed:", e); }
  }
  if (app.algFields || app.algLandmarks) app.algCover?.bake();
  // The minimap was baked before the fields and farmsteads: again, with them.
  if (app.algFields || app.algLandmarks) app.algUnits?.minimap?.rebuildTerrain?.();
  // HERDS (algHerds.js): sheep and goats grazing together round the mechtas,
  // the dechra and the springs; they bolt from soldiers. ?herds=0 = without.
  if (params.get("herds") !== "0") {
    onStatus("Herding the flocks…");
    try {
      app.algHerds = await createAlgHerds(app, { units: app.algUnits?.units ?? null, showroom: app.showroom });
    } catch (e) { console.warn("[alg herds] failed:", e); }
  }
  // HENS (algHens.js, your bird-lab hens) round the houses and yards. ?hens=0 = without.
  if (params.get("hens") !== "0") {
    try {
      app.algHens = await createAlgHens(app, { units: app.algUnits?.units ?? null, showroom: app.showroom ?? {}, navGrid: app.navGrid ?? null });
    } catch (e) { console.warn("[alg hens] failed:", e); }
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
  // The ground cache around the starting view, all of it, before the screen
  // lifts (the loop only bakes a few tiles a frame).
  if (bootPipelines) {
    const t0 = performance.now(), p = await bootPipelines.end();
    console.log(`[pipelines] ${p.created} built in parallel during the boot, ${p.skipped} draws waited; the last ones took ${Math.round(performance.now() - t0)} ms`);
  }
  await app.groundCache?.bakeAll(app.camera);
  // Drop the CPU copies of buffers only the GPU writes (v3/render/gpuOnlyArrays.js):
  // grass, plant fields, crowd skinning — ~260 MB of zeros held for nothing
  // (heap snapshot, 2026-10-03). Again every 5 s: a crowd gets its buffers
  // with its first soldier. ?gpuonly=0 keeps them.
  if (params.get("gpuonly") !== "0") {
    const mb = releaseGpuOnly(app.renderer) / 1048576;
    console.log(`[memory] ${mb.toFixed(0)} MB of GPU-only arrays released from the JS heap`);
    setInterval(() => releaseGpuOnly(app.renderer), 5000);
  }
  for (let i = 0; i < 2; i++) await new Promise((r) => requestAnimationFrame(r));
  const hud = document.getElementById("hud");
  if (hud) hud.textContent = `${boot.loaded ? boot.name : "no level"} · WASD pan · wheel zoom · Q/E rotate · C orbit`;
  // The briefing (and the difficulty), once the loading screen has faded
  // (alg.html: 250 ms); ?brief=0 starts at the remembered difficulty.
  if (app.algBattle) { if (params.get("brief") !== "0") setTimeout(() => app.algBattle.brief(), 450); else app.algBattle.start(); }
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
