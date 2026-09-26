// ALGERIA DEV PANEL — developer controls for this game, in the shared shell
// (games/shared-rts/devPanelShell.js). DEVELOPER UI, not player-facing.
//
// Its own sections, not nam's: this game has no units, fog of war or match
// yet, and its light is a desert sun, not a jungle's mist. Sections join as
// the systems do.
import { createDevPanelShell } from "../shared-rts/devPanelShell.js";

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

  // ── Haze + bloom ────────────────────────────────────────────────────────
  const fx = panel.section("Haze & bloom");
  const dist = () => app.fog?.state?.distance ?? {};
  fx.toggle("Haze", { get: () => dist().enabled, set: (v) => app.fog?.setDistance?.({ enabled: v }) });
  fx.slider("Density", { min: 0, max: 20, step: 0.1, get: () => (dist().density ?? 0) * 1e4, set: (v) => app.fog?.setDistance?.({ density: v * 1e-4 }), fmt: (v) => `${v.toFixed(1)}e-4` });
  fx.color("Colour", { get: () => dist().color ?? L.haze.color, set: (v) => app.fog?.setDistance?.({ color: v }) });
  let bloom = { enabled: true, strength: 0.85 };
  fx.toggle("Bloom", { get: () => bloom.enabled, set: (v) => { bloom.enabled = v; app.postFx?.setBloom?.(bloom); } });
  fx.slider("Bloom strength", { min: 0, max: 2, step: 0.05, get: () => bloom.strength, set: (v) => { bloom.strength = v; app.postFx?.setBloom?.(bloom); } });
  fx.hint("Dust haze: it eats the plain and the far ground. Bloom is selective (emissive only).");

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
  perf.slider("Render scale", { min: 0.5, max: 1, step: 0.05, get: () => app.renderScale ?? 1, set: (v) => app.setRenderScale?.(v, { persist: false }) });
  perf.button("GPU pass timings", async (b) => {
    const g = await window.__V3_DEBUG?.gpu?.();
    b.textContent = g ? "GPU pass timings — on" : "No timestamp support here";
  });
  perf.hint("Judge cost in <b>GPU ms</b>, not FPS (vsync holds 60). The stats-gl GPU number under-reports; the pass timings don't. A/B with <code>__V3_DEBUG.gpuAB</code>. Keep this tab <b>focused</b> while measuring.");

  return panel;
}
