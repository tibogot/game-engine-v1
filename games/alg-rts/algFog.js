// FOG FOR THE AURÈS — the shared fog banks (games/shared-rts/fogBanks.js,
// raymarched mist at PLACES) sited where this land holds its fog, plus
// WEATHER presets that set every fog layer at once, so the look is a
// choice ("dawn mist"), not five sliders that disagree.
//
// Where fog lies here (not nam's everywhere-jungle mist): cold air pools in
// the low ground at dawn, so white mist over the OASES and down the WADI
// beds, clear on the ridges; in the afternoon the same hollows hold DUST.
//
//   clear      the summer afternoon: only the dust haze on the far ground
//   dawnMist   07:30, low sun; white banks in the oases and wadis, a thin
//              ground fog below ~15 m — ambush weather
//   dustHaze   a hot wind: ochre banks in the hollows, the far ground gone
//              brown, a low dust layer over the plain
//
// Sandstorm later builds on dustHaze (TODO.md).
import { createFogBanks } from "../shared-rts/fogBanks.js";
import { LAYOUT } from "./layout.js";

export const WEATHER = {
  clear: {
    label: "Clear afternoon",
    time: 15.2,
    banks: { enabled: false },
    height: { enabled: false },
    distance: { color: "#d9c6a4", density: 0.00055 },
  },
  dawnMist: {
    label: "Dawn mist",
    time: 7.4,
    banks: { enabled: true, color: "#eef0ec", shade: "#a7aca6", sunTint: "#ffe2bc", density: 1.0, wisps: 0.75, drift: 0.4 },
    // A thin sheet on the valley floors (the plain is at 5-25 m, the ALN's
    // heights at 80): mist below ~15 m, clear above.
    height: { enabled: true, mode: "analytic", color: "#dfe3df", density: 0.012, falloff: 0.09, base: -10, top: 16, haze: 0.0006 },
    distance: { color: "#cfd3cf", density: 0.0008 },
  },
  dustHaze: {
    label: "Dust haze",
    time: 15.2,
    banks: { enabled: true, color: "#c9ae84", shade: "#8d7454", sunTint: "#ffd29a", density: 0.7, wisps: 0.9, drift: 1.4 },
    height: { enabled: true, mode: "analytic", color: "#c2a47a", density: 0.008, falloff: 0.05, base: -10, top: 30, haze: 0.0009 },
    distance: { color: "#c8ad85", density: 0.0014 },
  },
};

/**
 * Site the banks: one over each oasis, three along each wadi (8 = the
 * shared module's maximum). Heights from the map, so they follow it.
 */
function siteBanks(app, fog) {
  const ground = (x, z) => app.getWorldHeight(x, z);
  for (const s of LAYOUT.sites.filter((q) => q.kind === "oasis")) {
    const water = app.getWaterLevelAt?.(s.x, s.z);
    const floor = Number.isFinite(water) ? water : ground(s.x, s.z);
    fog.add({ name: "oasis", x: s.x, z: s.z, floor, along: s.r * 2.2, across: s.r * 1.8, height: 7, rotY: 0.4, density: 0.14 });
  }
  for (const w of LAYOUT.wadis ?? []) {
    // Three stretches of the bed, each a long bank lying along it.
    const P = w.points;
    const n = P.length - 1;
    for (const f of [0.2, 0.5, 0.8]) {
      const i = Math.min(n - 1, Math.floor(f * n)), a = P[i], b = P[i + 1];
      const x = (a[0] + b[0]) / 2, z = (a[1] + b[1]) / 2;
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      fog.add({
        name: `${w.name} ${Math.round(f * 100)}%`, x, z, floor: ground(x, z) + 0.5,
        along: Math.max(40, len * 0.75), across: (w.width ?? 12) * 2.5, height: 5,
        rotY: -Math.atan2(b[1] - a[1], b[0] - a[0]), density: 0.12,
      });
    }
  }
}

export function createAlgFog(app, { light, applyLight, skyPro = false } = {}) {
  if (!app.heightTexNode || !app.postFx?.setSceneColorModifier) return null;
  const fog = createFogBanks({ app, storeKey: "algrts.fogBanks" });
  siteBanks(app, fog);
  fog.restoreBanks();
  // With a fog of war (algUnits.js, app.fogOfWar) the banks go BEFORE it, as
  // in nam — unexplored ground darkens its mist too; without one they are the
  // whole scene-colour hook. `rehook` is called when the fog of war arrives.
  // Hooked ONLY while the banks are on: off, the volume pass still rendered
  // a half-res target every frame (3.6% of the frame, measured).
  const hook = () => {
    const node = fog.params.enabled ? (color, ctx) => fog.node(color, ctx) : null;
    if (app.fogOfWar) app.fogOfWar.setPreModifier(node);
    else app.postFx.setSceneColorModifier(node);
  };
  fog.onRebuild = hook;
  fog.onToggle = hook;
  hook();
  app.addPreRenderHook(() => fog.update());

  let current = "clear";
  function setWeather(key) {
    const W = WEATHER[key];
    if (!W) return;
    current = key;
    app.sky?.setTimeOfDay?.(W.time);
    for (const [k, v] of Object.entries(W.banks)) fog.set(k, v, { quiet: true });
    fog.sync();
    // Under Sky Pro its own air haze is the distance fog (algGame.js SKY_PRO): the banks stay.
    if (skyPro) return;
    app.fog?.setHeight?.(W.height);
    app.fog?.setDistance?.({ enabled: true, matchSky: true, ...W.distance });
  }
  setWeather("clear");
  return { fog, setWeather, rehook: hook, get weather() { return current; } };
}
