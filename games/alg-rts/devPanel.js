// ALGERIA DEV PANEL — developer controls for this game, in the shared shell
// (games/shared-rts/devPanelShell.js). DEVELOPER UI, not player-facing.
//
// Its own sections, not nam's: this game has no units, fog of war or match
// yet, and its light is a desert sun, not a jungle's mist. Sections join as
// the systems do.
import { createDevPanelShell } from "../shared-rts/devPanelShell.js";
import { buildFogBanksPanel } from "../shared-rts/fogBanksPanel.js";
import { WEATHER } from "./algFog.js";
import { buildAlgSoundPanel } from "./algSounds.js";

const DEG = Math.PI / 180;

/** `light` + `applyLight`: algGame.js AURES_LIGHT and applyAuresLight. */
export function createAlgDevPanel({ app, rtsCamera, light: AURES_LIGHT, applyLight }) {
  const panel = createDevPanelShell({ id: "alg-dev", storageKey: "alg-rts.devPanel", title: "Dev" });

  // ── Camera ──────────────────────────────────────────────────────────────
  const p = rtsCamera.params;
  const cam = panel.section("Camera", { open: true });
  cam.button(rtsCamera.getMode() === "rts" ? "RTS camera — C for orbit" : "Orbit — C for RTS", (b) => {
    rtsCamera.toggle();
    b.textContent = rtsCamera.getMode() === "rts" ? "RTS camera — C for orbit" : "Orbit — C for RTS";
  }, { primary: true });
  cam.slider("Pan speed", { min: 10, max: 160, step: 5, get: () => p.panSpeed, set: (v) => (p.panSpeed = v) });
  // The lens (vertical FOV) in RTS mode: narrower = further back, bigger units, CoH.
  cam.slider("FOV", {
    min: 20, max: 70, step: 1, get: () => p.fov ?? app.camera.fov, fmt: (v) => `${v}°`,
    set: (v) => { p.fov = v; if (rtsCamera.getMode() === "rts") { app.camera.fov = v; app.camera.updateProjectionMatrix(); } },
  });
  cam.slider("Pitch in", { min: 18, max: 70, step: 1, get: () => p.pitchNear / DEG, set: (v) => (p.pitchNear = v * DEG), fmt: (v) => `${v}°` });
  cam.slider("Pitch out", { min: 25, max: 85, step: 1, get: () => p.pitchFar / DEG, set: (v) => (p.pitchFar = v * DEG), fmt: (v) => `${v}°` });
  cam.slider("Max zoom", { min: 40, max: 200, step: 5, get: () => p.distMax, set: (v) => (p.distMax = v), fmt: (v) => `${v} m` });
  cam.slider("Zoom ease", { min: 0, max: 30, step: 1, get: () => p.zoomSmooth, set: (v) => (p.zoomSmooth = v) });
  cam.slider("Height ease", { min: 0, max: 12, step: 0.5, get: () => p.heightSmooth, set: (v) => (p.heightSmooth = v) });
  cam.toggle("Edge scroll", { get: () => p.edgeScroll, set: (v) => (p.edgeScroll = v) });
  cam.hint("<b>FOV</b>: the lens (40° = the CoH look: further back, bigger units). Pitch runs from <b>in</b> to <b>out</b> across the zoom (CoH). Q/E rotate, C toggles orbit.");

  // ── Sky (Sky Pro, the game's sky since 2026-09-29) ──────────────────────
  // Its settings are read every frame (skyproSky.js), so these write them
  // live. Presets set cover, cirrus and haze together; the clouds follow the
  // game's ONE wind (algWind.js: flags, plants) unless you let them drift.
  const L = structuredClone(AURES_LIGHT);
  const hhmm = (v) => `${Math.floor(v)}:${String(Math.round((v % 1) * 60)).padStart(2, "0")}`;
  const SP = app.sky?.mode === "skypro" ? app.sky.skyPro : null;
  if (SP) {
    const sky = panel.section("Sky", { open: true });
    const PRESETS = {
      clear:    { label: "Clear",         coverage: 0.08, cirrus: 0.15, haze: 1.2 },
      partly:   { label: "Partly cloudy", coverage: 0.49, cirrus: 0.5,  haze: 1.6 },
      broken:   { label: "Broken",        coverage: 0.68, cirrus: 0.6,  haze: 1.8 },
      overcast: { label: "Overcast",      coverage: 0.9,  cirrus: 0.8,  haze: 2.4 },
      dust:     { label: "Dust",          coverage: 0.18, cirrus: 0.1,  haze: 4.5 },
    };
    let preset = "partly";
    sky.select("Preset", {
      options: Object.entries(PRESETS).map(([k, p]) => [k, p.label]),
      get: () => preset,
      set: (k) => { preset = k; const { label, ...p } = PRESETS[k]; void label; Object.assign(SP, p); panel.refresh(); },
    });
    sky.slider("Time of day", { min: 5, max: 20, step: 0.1, get: () => L.timeOfDay, set: (v) => { L.timeOfDay = v; app.sky?.setTimeOfDay?.(v); }, fmt: hhmm });
    sky.slider("Cloud cover", { min: 0, max: 1, step: 0.01, get: () => SP.coverage, set: (v) => (SP.coverage = v) });
    sky.slider("Cirrus", { min: 0, max: 1.5, step: 0.05, get: () => SP.cirrus, set: (v) => (SP.cirrus = v) });
    sky.slider("Cirrus height", { min: 3000, max: 12000, step: 100, get: () => SP.cirrusAlt, set: (v) => (SP.cirrusAlt = v), fmt: (v) => `${(v / 1000).toFixed(1)} km` });
    // Sky Pro's shadows are its own map (cloudShadowsLite mapOn), not the baked field's `enabled`.
    const cs = app.cloudShadows;
    if (cs) sky.toggle("Cloud shadows", {
      get: () => (cs.hasMap ? cs.params.mapOn !== false : !!cs.params.enabled),
      set: (v) => app.setCloudShadows?.(cs.hasMap ? { mapOn: v } : { enabled: v }),
    });
    // THE WIND: the clouds drift with the game's wind (its direction; its
    // strength as a speed at the deck), or on their own.
    const gw = app.showroom?.wind;
    let follow = !!gw;
    const followWind = () => { if (follow && gw) { SP.windDeg = gw.dirDeg; SP.windSpeed = 4 + 24 * gw.strength; } };
    gw?.onChange?.(() => { followWind(); panel.refresh(); });
    followWind();
    if (gw) sky.toggle("Clouds follow the wind", { get: () => follow, set: (v) => { follow = v; followWind(); } });
    sky.slider("Cloud drift", { min: 0, max: 40, step: 0.5, get: () => SP.windSpeed, set: (v) => { follow = false; SP.windSpeed = v; panel.refresh(); }, fmt: (v) => `${v} m/s` });
    sky.slider("Drift toward", { min: 0, max: 360, step: 5, get: () => SP.windDeg, set: (v) => { follow = false; SP.windDeg = v; panel.refresh(); }, fmt: (v) => `${v}°` });
    sky.slider("Haze", { min: 0, max: 6, step: 0.05, get: () => SP.haze, set: (v) => (SP.haze = v) });
    sky.slider("Sun shafts", { min: 0, max: 1, step: 0.05, get: () => SP.shafts, set: (v) => (SP.shafts = v) });
    sky.toggle("God rays", { get: () => !!SP.godRays, set: (v) => (SP.godRays = v) });
    sky.slider("Exposure", { min: 0.2, max: 1.5, step: 0.01, get: () => SP.exposure, set: (v) => (SP.exposure = v) });
    sky.color("Ground light", { get: () => SP.groundAlbedo, set: (v) => (SP.groundAlbedo = v) });
    sky.button("Copy values", () => navigator.clipboard?.writeText(JSON.stringify({
      timeOfDay: L.timeOfDay, coverage: SP.coverage, cirrus: SP.cirrus, cirrusAlt: SP.cirrusAlt, haze: SP.haze,
      shafts: SP.shafts, godRays: SP.godRays, exposure: SP.exposure, groundAlbedo: SP.groundAlbedo,
    }, null, 2)));
    sky.hint("Live, not saved: <b>Copy</b> the values to bake a look into the game. The clouds drift with the game's wind (Dev → Wind) unless you move <b>Cloud drift</b>. <b>Ground light</b> is the colour the land throws back up into the shadows.");
  }

  // ── Light (the Aurès sun, algGame.js AURES_LIGHT) ───────────────────────
  // A working copy: the sliders edit it and re-apply; Copy gives the values
  // to paste back into AURES_LIGHT for good. Under Sky Pro the sun, fill and
  // exposure are the SKY's (above): only the grade is left here.
  const light = panel.section("Light");
  if (!SP) light.slider("Time of day", { min: 5, max: 20, step: 0.1, get: () => L.timeOfDay, set: (v) => { L.timeOfDay = v; app.sky?.setTimeOfDay?.(v); }, fmt: hhmm });
  const world = (k, label, max) => light.slider(label, { min: 0, max, step: 0.05, get: () => L.world[k], set: (v) => { L.world[k] = v; app.sky?.setWorldLight?.(L.world); } });
  if (!SP) {
    world("dir", "Sun", 8);
    world("skyFill", "Sky fill", 2);
    world("hemi", "Hemi", 2);
    world("exposure", "Exposure", 3);
  } else {
    light.hint("Sky Pro lights the world from its own sun: time of day and exposure are in <b>Sky</b>. The grade below still applies.");
  }
  const polish = (k, label, min, max) => light.slider(label, { min, max, step: 0.01, get: () => L.polish[k], set: (v) => { L.polish[k] = v; app.postFx?.setPolish?.(L.polish); } });
  polish("contrast", "Contrast", 0.8, 1.5);
  polish("saturation", "Saturation", 0.5, 1.5);
  polish("temperature", "Warmth", -0.5, 0.5);
  light.button("Reset to the game's light", () => {
    Object.assign(L, structuredClone(AURES_LIGHT));
    applyLight(app, L);
    panel.refresh();
  });
  light.button("Copy values", () => navigator.clipboard?.writeText(JSON.stringify(L, null, 2)));
  light.hint("Live, not saved. <b>Copy</b> gives the values for <code>AURES_LIGHT</code> in algGame.js.");

  // ── Fog — the SAME controls as nam-rts's Dev → Fog (your ask, 2026-09-27:
  // one panel for both games while they are tuned): the height fog's model
  // and its rows, then the distance fog. Only the live model's rows show.
  const fogS = panel.section("Fog");
  const hs = () => app.fog?.state?.height ?? {};
  const ds = () => app.fog?.state?.distance ?? {};
  const setH = (p) => app.fog?.setHeight?.(p);
  const rowsOf = { valley: [], monsoon: [] };
  const tag = (model) => rowsOf[model].push(fogS.el.lastElementChild);
  const showRows = () => {
    const m = hs().mode ?? "analytic";
    for (const [k, list] of Object.entries(rowsOf)) for (const el of list) el.style.display = m === k ? "" : "none";
  };
  fogS.select("Model", {
    options: [["analytic", "Analytic (Crytek)"], ["valley", "Valley band"], ["monsoon", "Monsoon (top-down)"]],
    get: () => hs().mode ?? "analytic",
    set: (v) => { setH({ mode: v }); showRows(); },
  });
  fogS.toggle("Height fog", { get: () => hs().enabled, set: (v) => setH({ enabled: v, mode: hs().mode }) });
  fogS.color("Color", { get: () => hs().color ?? "#c8d8e4", set: (v) => setH({ color: v }) });
  const mon = (label, key, min, max, step) => { fogS.slider(label, { min, max, step, get: () => hs()[key], set: (v) => setH({ [key]: v }) }); tag("monsoon"); };
  mon("Density", "monDensity", 0.002, 0.06, 0.001);
  mon("Falloff", "monFalloff", 0.01, 0.16, 0.005);
  mon("Layer (Y)", "monHeight", -20, 120, 1);
  mon("Sheets", "monStrata", 0, 1.2, 0.05);
  mon("Sun glow", "monSunStrength", 0, 1.5, 0.05);
  fogS.color("Sun tint", { get: () => hs().monSunTint ?? "#ffcf9a", set: (v) => setH({ monSunTint: v }) }); tag("monsoon");
  fogS.hint("Layer Y near the valley floors (the plain plays at y 5-25; the ALN's heights at 80). Falloff sets thickness ≈ 1/value metres. Keep density LOW — you have to read the battlefield through it. Sun glow only shows looking toward a LOW sun."); tag("monsoon");
  const val = (label, key, min, max, step) => { fogS.slider(label, { min, max, step, get: () => hs()[key], set: (v) => setH({ [key]: v }) }); tag("valley"); };
  val("Base (Y)", "base", -40, 80, 1);
  val("Top (Y)", "top", 10, 200, 1);
  val("Haze", "haze", 0, 0.005, 0.0001);
  val("Wobble", "noiseWobble", 0, 40, 1);
  fogS.toggle("Dist. fog", { get: () => ds().enabled !== false, set: (v) => app.fog?.setDistance?.({ enabled: v, matchSky: true }) });
  fogS.slider("Dist. density", { min: 0, max: 0.003, step: 0.0001, get: () => ds().density ?? 0.0004, set: (v) => app.fog?.setDistance?.({ density: v }) });
  fogS.hint("Valley band fog — mist below Top, clear above. Haze fades distant terrain into the sky.");
  showRows();

  // ── Post-FX (as nam's) ──────────────────────────────────────────────────
  const fx = panel.section("Post-FX");
  let bloom = { enabled: false, strength: 0.85 };   // off at boot (algGame.js)
  fx.toggle("Bloom", { get: () => bloom.enabled, set: (v) => { bloom.enabled = v; app.postFx?.setBloom?.(bloom); } });
  fx.slider("Bloom strength", { min: 0, max: 2, step: 0.05, get: () => bloom.strength, set: (v) => { bloom.strength = v; app.postFx?.setBloom?.(bloom); } });
  fx.hint("Selective bloom — only emissive materials (tracers, beacons) glow.");

  // ── Weather & fog (algFog.js; the banks are shared-rts/fogBanks.js) ────
  const af = app.algFog;
  if (af) {
    const wx = panel.section("Weather & fog", { open: true });
    wx.select("Weather", {
      options: Object.entries(WEATHER).map(([k, w]) => [k, w.label]),
      get: () => af.weather,
      set: (k) => { af.setWeather(k); panel.refresh(); buildFogBanksPanel(banksEl, af.fog, { rtsCamera }); },
    });
    wx.hint("One choice sets the time of day, the fog banks, the ground fog and the far haze together. <b>Dawn mist</b>: white in the oases and wadi beds. <b>Dust haze</b>: ochre, the far ground gone.");
    const banks = panel.section("Fog banks");
    const banksEl = banks.el;
    buildFogBanksPanel(banksEl, af.fog, { rtsCamera });
  }

  // ── The map's edge (fog of war post pass: the playable box) ─────────────
  const fowE = app.fogOfWar;
  if (fowE?.edge?.available) {
    const me = panel.section("Map edge");
    me.toggle("Mark outside", { get: () => fowE.edge.on, set: (v) => fowE.setEdge({ on: v }) });
    me.select("Style", { options: [["darken", "Darken (CoH)"], ["haze", "Haze (fog wall)"]], get: () => fowE.edge.mode, set: (v) => fowE.setEdge({ mode: v }) });
    me.slider("Strength", { min: 0, max: 1, step: 0.05, get: () => fowE.edge.strength, set: (v) => fowE.setEdge({ strength: v }) });
    me.color("Haze colour", { get: () => fowE.edge.color, set: (v) => fowE.setEdge({ color: v }) });
    me.hint("Outside the playable box: <b>Darken</b> as Company of Heroes, or <b>Haze</b> — the land fades into dust that thickens further out (reads from the free camera too). Live, not saved: tell me the one to keep.");
  }

  // ── Sound (algSounds.js) ─────────────────────────────────────────────────
  if (app.algSounds) buildAlgSoundPanel(panel.section("Sound").el, app.algSounds);

  // ── Wind (algWind.js: the flags and the windsock share it) ──────────────
  const wind = app.showroom?.wind;
  if (wind) {
    const ws = panel.section("Wind");
    ws.slider("Direction", { min: 0, max: 360, step: 5, get: () => wind.dirDeg, set: (v) => wind.set({ dirDeg: v }), fmt: (v) => `${v}°` });
    ws.slider("Strength", { min: 0, max: 1, step: 0.05, get: () => wind.strength, set: (v) => wind.set({ strength: v }) });
    ws.slider("Gusts", { min: 0, max: 1, step: 0.05, get: () => wind.gust, set: (v) => wind.set({ gust: v }) });
    ws.hint("One wind for the flags and the windsock (later smoke, dust, the sandstorm). 0 = still: the sock hangs limp.");
  }

  // ── Showroom (the new assets on the map, games/alg-rts/showroom.js) ─────
  const shown = app.showroom ?? {};
  const keys = Object.keys(shown).filter((k) => shown[k]?.isObject3D);
  if (keys.length) {
    const sr = panel.section("Showroom", { open: true });
    sr.select("Go to", {
      options: [["", "—"], ...keys],
      get: () => "",
      set: (k) => {
        const o = shown[k];
        if (!o) return;
        rtsCamera.focusOn(o.position.x, o.position.z);
        rtsCamera.setZoom?.(0.15);
      },
    });
    sr.toggle("Show assets", { get: () => shown[keys[0]].visible, set: (v) => { for (const k of keys) shown[k].visible = v; } });
    sr.hint("Where the new assets are judged: on the real map, in the game's own light. Temporary until gameplay places them.");
  }

  // ── The ALN (until its AI queues for itself) ────────────────────────────
  const cave = app.algProducers?.find((p) => p.structure.typeKey === "caveEntrance");
  if (cave) {
    const aln = panel.section("ALN");
    aln.button("Send out a band (5)", () => { for (let i = 0; i < 5; i++) cave.structure.enqueue("moudjahid"); });
    aln.button("Go to the cave", () => { rtsCamera.focusOn(cave.centre.x, cave.centre.z); rtsCamera.setZoom?.(0.12); });
    const ai = app.algAI;
    if (ai) {
      aln.toggle("AI on", { get: () => ai.enabled, set: (v) => ai.setEnabled(v) });
      aln.button("A band now (AI)", () => ai.bandNow());
      // The bands and what they are doing; the label is the readout.
      aln.button("Bands: (click to read)", (b) => { b.textContent = `Bands: ${ai.describe()}`; });
    }
    aln.hint("The katiba (algAI.js): a band gathers at the cave, finds French troops out in the open, hides 40-65 m from them in scrub or on high ground holding its fire, opens up when they come within 32 m, and runs back into the cave after 12-22 s — sooner if it loses 40% or armour comes near.");
  }

  // ── Navigation (the shared nav grid; N toggles it too, as in nam) ───────
  if (app.navGrid) {
    const nv = panel.section("Navigation");
    nv.toggle("Nav grid (N)", { get: () => !!app.navGrid.debugOn, set: (v) => app.navGrid.setDebug?.(v) });
    nv.hint("Where men and vehicles can go: blocked cells (buildings, cliffs, water) over the terrain. <b>N</b> toggles it anywhere.");
    if (app.fogOfWar) {
      nv.toggle("Fog of war", { get: () => app.fogOfWar.enabled, set: (v) => app.fogOfWar.setEnabled(v) });
      nv.hint("What the French see (vision per unit and building — the mirador 110 m, the post 90 m). Outside it the ALN is not drawn; their buildings appear once seen. Off by default while the map is being built (<code>?fow=1</code> on).");
    }
    if (app.algCoverOverlay) {
      nv.toggle("Cover overlay (pin)", { get: () => app.algCoverOverlay.pinned, set: (v) => app.algCoverOverlay.setPinned(v) });
      nv.hint("Players hold <b>V</b> with men selected: <b>green</b> = cover (stone, sandbags — takes damage off, from its side), <b>cyan</b> = concealment (scrub — you are seen closer). Firing gives a hidden man away for 4 s.");
    }
  }

  // ── Birds (algBirds.js on the shared engine) ────────────────────────────
  const birds = app.algBirds;
  if (birds) {
    const bs = panel.section("Birds");
    bs.button("Storks cross the view", () => birds.spawnTransit("stork"));
    bs.button("Crows cross the view", () => birds.spawnTransit("crow"));
    bs.button("Storks land nearby", () => birds.spawnLanding());
    const dechra = app.showroom?.dechra, nest = dechra?.geometry?.userData?.nest;
    if (nest) bs.button("Go to the minaret nest", () => {
      const p = dechra.localToWorld(dechra.position.clone().set(nest.x, nest.y, nest.z));
      rtsCamera.focusOn(p.x, p.z); rtsCamera.setZoom?.(0.3);
    });
    const soar = birds.flocks.find((f) => f.circle);
    if (soar) bs.button("Go to the vultures", () => { rtsCamera.focusOn(soar.circle.x, soar.circle.z); rtsCamera.setZoom?.(0.6); });
    bs.toggle("Birds on", { get: () => birds.params.enabled, set: (v) => birds.setEnabled(v) });
    bs.hint("Storks cross and land in the open, crows straggle, vultures circle the heights for good; a pair on the minaret's nest. Men, jeeps and helicopters put a stand up.");
  }

  // ── Performance ─────────────────────────────────────────────────────────
  const perf = panel.section("Performance");
  perf.toggle("Stats overlay", { get: () => app.statsOverlay, set: (v) => app.setStatsOverlay?.(v) });
  perf.slider("Render scale", { min: 0.5, max: 1, step: 0.05, get: () => app.renderScale ?? 1, set: (v) => app.setRenderScale?.(v, { persist: false }) });
  perf.button("GPU pass timings", async (b) => {
    const g = await window.__V3_DEBUG?.gpu?.();
    b.textContent = g ? "GPU pass timings — on" : "No timestamp support here";
  });
  perf.hint("Judge cost in <b>GPU ms</b>, not FPS (vsync holds 60). The stats-gl GPU number under-reports; the pass timings don't. A/B with <code>__V3_DEBUG.gpuAB</code>. Keep this tab <b>focused</b> while measuring.");

  return panel;
}
