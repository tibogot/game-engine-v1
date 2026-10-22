// Thunderline P3 — the DRIVE PAGE: one drive session (driveSession.js: the real car, old physics
// untouched, on the new pieces with the old look) under Sky Pro, with the old chase camera. The page
// only starts the engine, picks the track from the URL and leaves to the menu / builder / next track.
//   ?track=<library id> (menu, builder; "local" = the track the builder last worked on)
//   ?campaign=<white-1…> a campaign track (a read-only file in the repo; its bests are kept apart);
//     <lessons-1…> a STUNT LESSON: its card first, then its goal checked at the finish
//   ?from=builder (Esc / B go back there) · ?auto (the test autopilot) · ?tod=<h> · ?top=<m/s>
//   ?substeps=<n> · ?shadows=csm (the engine's cascades instead of the baked sun atlas) · ?ghost=off
import { startV3App } from "../../../../v3/engine.js";
import { library, campaign, lessons, settings, builderUrl, campaignUrl, PAGES } from "../../app/library.js";
import { createDriveRig } from "./driveSession.js";
import { applyWorld, DEFAULT_TOD, groundFeatures } from "./worlds.js";

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
  splatFeatures: groundFeatures(), // worlds.js: paint slots 0-2 only (3 layers, not 7) + the anti-tiling features
  terrainLayers: 3, // and the GPU paint arrays hold just those 3 (−42 MB of video memory)
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

// ---------- A STUNT LESSON (user, 2026-10-22): the card first (the game waits), the goal at the finish ----------
const lesson = campaignRec?.lesson ?? null;
if (lesson) {
  try { sessionStorage.setItem("thunderline.playTab", "lessons"); } catch {} // the menu comes back to the lessons
  const st = document.createElement("style");
  st.textContent = `
    #lesson { position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(460px, calc(100vw - 32px)); z-index: 70;
      background: rgba(8, 11, 18, 0.95); border: 1px solid #23304d; border-top: 3px solid #3fd2ff; color: #dbe4f5; padding: 18px 20px 16px;
      font: 500 15px/1.5 "Barlow", system-ui, sans-serif; box-shadow: 0 16px 40px rgba(0, 0, 0, 0.5); }
    #lesson .k { font: 700 12px "Barlow Condensed", sans-serif; letter-spacing: 0.12em; text-transform: uppercase; color: #3fd2ff; }
    #lesson h2 { margin: 4px 0 8px; font: 800 30px "Barlow Condensed", sans-serif; text-transform: uppercase; color: #fff; }
    #lesson .goal { margin: 10px 0 0; color: #8796b5; font-size: 14px; }
    #lesson kbd { font: 600 12px "Barlow Condensed", sans-serif; border: 1px solid #3a4a6b; padding: 0 5px; color: #fff; }
    #lesson button { margin-top: 14px; background: none; border: 1px solid #3fd2ff; color: #3fd2ff; padding: 7px 16px; cursor: pointer;
      font: 700 15px "Barlow Condensed", sans-serif; letter-spacing: 0.08em; text-transform: uppercase; }
    #lessonVerdict { position: fixed; left: 50%; top: 130px; transform: translateX(-50%); z-index: 65; padding: 10px 18px; background: rgba(8, 11, 18, 0.92);
      border-left: 3px solid #3fd2ff; color: #fff; font: 800 24px "Barlow Condensed", sans-serif; letter-spacing: 0.05em; text-transform: uppercase; }
    #lessonVerdict.no { border-left-color: #ff4d5e; }
    #lessonVerdict small { display: block; font: 600 14px "Barlow", sans-serif; letter-spacing: 0; text-transform: none; color: #8796b5; }`;
  document.head.appendChild(st);
  const need = lesson.goal?.perfect ?? 0;
  const goalText = need ? `Goal: reach the finish with ${need > 1 ? `${need} perfect landings` : "a perfect landing"}.` : "Goal: reach the finish.";
  const card = document.createElement("div");
  card.id = "lesson";
  card.innerHTML = `<div class="k">Stunt lesson · ${campaignRec.id.split("-")[1]}</div><h2>${campaignRec.name.replace(/^\d+\.\s*/, "")}</h2><div>${lesson.how}</div><div class="goal">${goalText} <kbd>R</kbd> restarts · <kbd>I</kbd> shows this card again.</div><button>Go ▶ <kbd>Enter</kbd></button>`;
  document.body.appendChild(card);
  const verdict = document.createElement("div");
  verdict.id = "lessonVerdict";
  verdict.style.display = "none";
  document.body.appendChild(verdict);
  const showCard = () => { card.style.display = ""; rig.setTimeScale(0); };
  const go = () => { card.style.display = "none"; verdict.style.display = "none"; rig.setTimeScale(1); rig.restart(); judged = false; };
  card.querySelector("button").onclick = go;
  addEventListener("keydown", (e) => {
    if (e.code === "Enter" && card.style.display !== "none") { e.preventDefault(); go(); }
    else if (e.code === "KeyI" && card.style.display === "none") showCard();
    else if (e.code === "KeyR") { verdict.style.display = "none"; judged = false; }
  });
  showCard();
  // the goal, judged once per run when the race finishes: the finish, and the perfect landings
  let judged = false;
  setInterval(() => {
    const S = rig.session;
    if (!S) return;
    if (S.race.s.state !== "finished") { if (S.race.s.state === "countdown") judged = false; return; }
    if (judged) return;
    judged = true;
    const perfect = S.landings.filter((l) => l.grade === "perfect").length;
    const ok = perfect >= need;
    if (ok) lessons.markPassed(campaignRec.id);
    verdict.className = ok ? "" : "no";
    verdict.innerHTML = ok
      ? `Lesson passed ✓<small>${nextCampaign ? `Next: ${nextCampaign.name} (N)` : "That was the last lesson — on to the campaign"}</small>`
      : `Not yet<small>${need ? `${perfect} perfect landing${perfect === 1 ? "" : "s"} of ${need} — land with the wheels flat. ` : ""}R to try again, I for the card</small>`;
    verdict.style.display = "";
  }, 200);
}
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
