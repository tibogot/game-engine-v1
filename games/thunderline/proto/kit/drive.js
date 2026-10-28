// Thunderline P3 — the DRIVE PAGE: one drive session (driveSession.js: the real car, old physics
// untouched, on the new pieces with the old look) under Sky Pro, with the old chase camera. The page
// only starts the engine, picks the track from the URL and leaves to the menu / builder / next track.
//   ?track=<library id> (menu, builder; "local" = the track the builder last worked on)
//   ?campaign=<white-1…> a campaign track (a read-only file in the repo; its bests are kept apart);
//     <lessons-1…> a STUNT LESSON: its card first, then its goal checked at the finish
//   ?from=builder (Esc / B go back there) · ?auto (the test autopilot) · ?tod=<h> · ?top=<m/s>
//   ?substeps=<n> · ?shadows=csm (the engine's cascades instead of the baked sun atlas) · ?ghost=off
import { startV3App } from "../../../../v3/engine.js";
import { library, campaign, settings } from "../../app/library.js";
import { go } from "../../app/nav.js";
import { attachLesson } from "./lessonCard.js";
import { createDriveRig } from "./driveSession.js";
import { applyWorld, DEFAULT_TOD, groundFeatures } from "./worlds.js";
// (game-agnostic, from the RTS games: what the game adds is drawn once under the loading screen)
import { snapshotEngineScene, warmGamePipelines, awaitPipelinesQuiet } from "../../../shared-rts/pipelineWarmup.js";

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const boot = $("bootMsg"); // the loading screen's message line (the logo and the bar stay)

// ---------- engine: Sky Pro, no terrain ----------
boot.textContent = "Starting the engine…";
const app = await startV3App({
  container: $("game"),
  skyMode: "skypro",
  cloudShadows: true,
  // The old game's light block (roadGame.js:296-306). shadowNormalBias 0.12 is the one that matters:
  // at the editor's 0.02 the road shadows ITSELF at a chase-camera grazing angle — the dark band
  // across the deck the user saw (2026-10-18).
  light: { envIntensity: 0.45, hemiIntensity: 0.6, dirIntensity: 2.6, exposure: 1.0, shadowNormalBias: 0.12 },
  terrainFeatures: { cursor: false },
  splatFeatures: groundFeatures(), // worlds.js: paint slots 0-2 only (3 layers, not 7) + the anti-tiling features
  terrainLayers: 3, // and the GPU paint arrays hold just those 3 (−42 MB of video memory)
  preloadPaintTextures: false,
  csm: { cascades: 2 },
  precompile: false, // the scene compiles once, final, behind the loading screen (below)
});
// No level: the engine's DEFAULT floor stays as the backdrop (user, 2026-10-18 — terrain comes later,
// as decoration). THE FLOOR IS SOLID (user, 2026-10-18): the car reads the engine's own height.
// THE SCENE IS HIDDEN WHILE THE PAGE BOOTS (2026-10-27, load trace: ~23 s of the GPU driver compiling
// shaders, DXC). Each lit material was compiled three times: before the post chain had its MRT, before the
// car's headlights joined the lights, before the sun-shadow node replaced the cascades — every frame drawn
// on the way compiled a variant thrown away the next step. Hidden, the frames still run (the sun settles
// for the time of day) but draw no material; it shows once, final, behind the loading screen (below).
const engineObjects = snapshotEngineScene(app.scene); // (before hiding: what the engine shows is warmed too)
app.scene.visible = false;
app.sky?.setMode?.("skypro");
const tod = Number(params.get("tod"));
app.sky?.setTimeOfDay?.(params.has("tod") && Number.isFinite(tod) ? tod : 15.5);
app.fog?.setHeight?.({ enabled: false });
app.postFx?.setEnabled?.(true);
app.postFx?.setBloomSelective?.(true);
app.postFx?.setBloom?.({ enabled: true, strength: 0.9, threshold: 0.0, radius: 0.5 });
const { camera, controls } = app;
// the chase camera owns the camera: neuter the engine's orbit (roadGame.js:6428)
controls.update = () => {};
controls.enableRotate = controls.enablePan = controls.enableZoom = false;
camera.far = Math.max(camera.far, 9000);
camera.updateProjectionMatrix();

// ---------- the track ----------
boot.textContent = "Building the track…";
const trackParam = params.get("track");
const trackId = trackParam === "local" ? library.current : trackParam;
const campaignRec = params.get("campaign") ? await campaign.get(params.get("campaign")) : null;
const trackRec = campaignRec ?? (trackId ? library.get(trackId) : null);
const nextCampaign = campaignRec ? await campaign.get(campaignRec.id.replace(/\d+$/, (n) => +n + 1)) : null;
const cameFrom = params.get("from"); // "builder" → Back goes there
// the track's WORLD (worlds.js: flat to the horizon, or the mountain valley), before any material is built
applyWorld(app, params.get("world") ?? trackRec?.track?.world);
// the track's TIME OF DAY (?tod= wins), set before the drive starts: its sun-shadow bake uses this sun
if (!(params.has("tod") && Number.isFinite(tod))) app.sky?.setTimeOfDay?.(trackRec?.track?.tod ?? DEFAULT_TOD);

const rig = createDriveRig(app, {
  prefs: settings.get(),
  top: Number(params.get("top")) || 63,
  substeps: Number(params.get("substeps")) || 3,
  sunShadows: params.get("shadows") !== "csm",
  ghost: params.get("ghost") !== "off",
  car: params.get("car") ?? settings.get().car, // ?car=lotus: the dev Lotus
});

// ---------- leaving: back to the builder (a test drive), the next campaign track, or the menu ----------
const goBuilder = () => { if (trackId) go({ to: "build", id: trackId }); };
const goNext = () => { if (nextCampaign) go({ to: "campaign", id: nextCampaign.id }); };
const goMenu = () => go({ to: "menu", screen: cameFrom === "builder" ? "build" : "play" });
const buttons = [
  ...(cameFrom === "builder" ? [{ label: "Back to builder", key: "B", run: goBuilder }] : []),
  ...(nextCampaign ? [{ label: `Next: ${nextCampaign.name}`, key: "N", run: goNext }] : []),
  { label: "Menu", key: "Esc", code: "Escape", run: goMenu },
];
await rig.start({
  track: trackRec?.track ?? null,
  campaignRec,
  trackId: campaignRec ? null : trackId,
  buttons,
  onEscape: cameFrom === "builder" ? goBuilder : goMenu,
  backLabel: cameFrom === "builder" ? "Builder" : "Menu",
});
addEventListener("keydown", (e) => { if (e.code === "KeyB" && cameFrom === "builder") goBuilder(); });
if (params.has("auto")) rig.setAuto(true);

// ---------- A STUNT LESSON (lessonCard.js): the card first (the game waits), the goal at the finish ----------
attachLesson(rig, campaignRec, nextCampaign);
// the scene shows, final (car model in, sun shadows on), and its shaders compile behind the loading screen
boot.textContent = "Warming up…";
await rig.modelsReady;
// (hidden still for 3 frames: the engine swaps in the sun-shadow node over two, the first with the sun's
// shadow off — worldEnvironment.js setSunShadowNode — and that frame would compile a variant of its own)
for (let i = 0; i < 3; i++) await new Promise((r) => requestAnimationFrame(r));
app.scene.visible = true;
// EVERYTHING THE DRIVE CAN SHOW, drawn once here (2026-10-27, an autopilot lap compiled 16 pipelines after
// this screen: the rails' far LOD levels as the camera reached them, the tyre smoke and marks, the ghost):
// hidden effects, empty pools, every LOD level, off-screen pieces — then wait until nothing new compiles
await warmGamePipelines(app, engineObjects);
await awaitPipelinesQuiet(app);
$("boot").classList.add("gone");
setTimeout(() => $("boot").remove(), 600);

// test hooks (the Node and CDP checks read these)
window.__drive = {
  app, rig, restart: rig.restart, recoverToSafe: rig.recoverToSafe, respawnCheckpoint: rig.respawnCheckpoint,
  vehicle: rig.vehicle, ghostCar: rig.ghostCar, chase: rig.chase, keys: rig.keys, engine: rig.engine,
  engineSound: rig.engineSound, sfx: rig.sfx, sfxRec: rig.sfxRec, camera, config: rig.config, setAuto: rig.setAuto,
  get sunShadows() { return rig.sunShadows; },
  get lay() { return rig.session.lay; }, get race() { return rig.session.race; }, get gates() { return rig.session.gates; },
  get landings() { return rig.session.landings; }, get recorder() { return rig.session.recorder; },
  get topKmh() { return rig.session.topKmh; }, get rideIdx() { return rig.session.pilot.idx; },
  get recoveries() { return rig.session.recoveries; }, get boosting() { return rig.session.rules.boostLeft > 0; },
  get ghostPlayer() { return rig.session.ghostPlayer; }, get ghostData() { return rig.session.ghostData; },
  get best() { return rig.session.best; }, get medals() { return rig.session.medals; }, get trackKey() { return rig.session.trackKey; },
  physMs: () => { const s = [...rig.session.physMs].sort((a, b) => a - b); return s.length ? { median: s[s.length >> 1], p95: s[Math.floor(s.length * 0.95)] } : null; },
};
