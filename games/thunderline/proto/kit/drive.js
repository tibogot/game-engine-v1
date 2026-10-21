// Thunderline P3 — the DRIVE PAGE: one drive session (driveSession.js: the real car, old physics
// untouched, on the new pieces with the old look) under Sky Pro, with the old chase camera. The page
// only starts the engine, picks the track from the URL and leaves to the menu / builder / next track.
//   ?track=<library id> (menu, builder; "local" = the track the builder last worked on)
//   ?campaign=<white-1…> a campaign track (a read-only file in the repo; its bests are kept apart)
//   ?from=builder (Esc / B go back there) · ?auto (the test autopilot) · ?tod=<h> · ?top=<m/s>
//   ?substeps=<n> · ?shadows=csm (the engine's cascades instead of the baked sun atlas) · ?ghost=off
import { startV3App } from "../../../../v3/engine.js";
import { library, campaign, settings, builderUrl, campaignUrl, PAGES } from "../../app/library.js";
import { createDriveRig } from "./driveSession.js";
import { applyWorld, DEFAULT_TOD } from "./worlds.js";

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const boot = $("boot");

// ---------- engine: Sky Pro, no terrain ----------
boot.textContent = "Thunderline · starting the engine…";
const app = await startV3App({
  container: $("game"),
  skyMode: "skypro",
  cloudShadows: true,
  // The old game's light block (roadGame.js:296-306). shadowNormalBias 0.12 is the one that matters:
  // at the editor's 0.02 the road shadows ITSELF at a chase-camera grazing angle — the dark band
  // across the deck the user saw (2026-10-18).
  light: { envIntensity: 0.45, hemiIntensity: 0.6, dirIntensity: 2.6, exposure: 1.0, shadowNormalBias: 0.12 },
  terrainFeatures: { cursor: false },
  splatFeatures: { solo: false, layerBudget: 3 }, // the ground uses paint slots 0-2 only (worlds.js): the shader loops over 3 layers, not 7
  preloadPaintTextures: false,
  csm: { cascades: 2 },
});
// No level: the engine's DEFAULT floor stays as the backdrop (user, 2026-10-18 — terrain comes later,
// as decoration). THE FLOOR IS SOLID (user, 2026-10-18): the car reads the engine's own height.
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
boot.textContent = "Thunderline · building the track…";
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
const goBuilder = () => { if (trackId) location.href = builderUrl(trackId); };
const goNext = () => { if (nextCampaign) location.href = campaignUrl(nextCampaign.id); };
const goMenu = () => { location.href = `${PAGES.menu}${cameFrom === "builder" ? "#build" : "#play"}`; };
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
boot.classList.add("gone");
setTimeout(() => boot.remove(), 600);

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
