// ALGERIA DEV PANEL — developer controls for this game, in the shared shell
// (games/shared-rts/devPanelShell.js). DEVELOPER UI, not player-facing.
//
// Its own sections, not nam's: this game has no units, fog of war or match
// yet, and its light is a desert sun, not a jungle's mist. Sections join as
// the systems do.
import { createDevPanelShell } from "../shared-rts/devPanelShell.js";
import { buildFogBanksPanel } from "../shared-rts/fogBanksPanel.js";
import { WEATHER } from "./algFog.js";

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
  cam.slider("Pitch in", { min: 18, max: 70, step: 1, get: () => p.pitchNear / DEG, set: (v) => (p.pitchNear = v * DEG), fmt: (v) => `${v}°` });
  cam.slider("Pitch out", { min: 25, max: 85, step: 1, get: () => p.pitchFar / DEG, set: (v) => (p.pitchFar = v * DEG), fmt: (v) => `${v}°` });
  cam.slider("Max zoom", { min: 40, max: 200, step: 5, get: () => p.distMax, set: (v) => (p.distMax = v), fmt: (v) => `${v} m` });
  cam.slider("Zoom ease", { min: 0, max: 30, step: 1, get: () => p.zoomSmooth, set: (v) => (p.zoomSmooth = v) });
  cam.slider("Height ease", { min: 0, max: 12, step: 0.5, get: () => p.heightSmooth, set: (v) => (p.heightSmooth = v) });
  cam.toggle("Edge scroll", { get: () => p.edgeScroll, set: (v) => (p.edgeScroll = v) });
  cam.hint("Pitch runs from <b>in</b> to <b>out</b> across the zoom (CoH). Q/E rotate, C toggles orbit.");

  // ── Light (the Aurès sun, algGame.js AURES_LIGHT) ───────────────────────
  // A working copy: the sliders edit it and re-apply; Copy gives the values
  // to paste back into AURES_LIGHT for good.
  const L = structuredClone(AURES_LIGHT);
  const light = panel.section("Light");
  light.slider("Time of day", { min: 5, max: 20, step: 0.1, get: () => L.timeOfDay, set: (v) => { L.timeOfDay = v; app.sky?.setTimeOfDay?.(v); }, fmt: (v) => `${Math.floor(v)}:${String(Math.round((v % 1) * 60)).padStart(2, "0")}` });
  const world = (k, label, max) => light.slider(label, { min: 0, max, step: 0.05, get: () => L.world[k], set: (v) => { L.world[k] = v; app.sky?.setWorldLight?.(L.world); } });
  world("dir", "Sun", 8);
  world("skyFill", "Sky fill", 2);
  world("hemi", "Hemi", 2);
  world("exposure", "Exposure", 3);
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
