/**
 * v3/ui/buildOceanV2Panel.js — every control for the V2 ocean, in one place.
 *
 * The V2 ocean (oceanSurface.js + worldOceanV2.js + oceanUnderwater.js) has its
 * own settings bag, `toolState.worldOcean.v2`. Nothing here touches the classic
 * ocean's sliders, and the classic panel touches nothing here; only Enabled,
 * the shader switch and Sea level are shared (see buildWorldPanel.js).
 *
 * Layout: presets first, then one collapsible group per concern. Each group
 * shows the knobs you reach for and keeps the rest under "Advanced", and ends
 * with a Reset that puts just that group back to defaults. Presets and resets
 * write the bag and call refreshWidgets(), so nothing is rebuilt and no group
 * you had open closes.
 *
 * Deliberately absent: the sky and sun colours the reflection uses. The
 * environment pushes those every frame from the real sky, so a slider would
 * only fight it.
 */

import {
  section, separator, slider, color, toggle, dropdown, button, info, hint,
  refreshWidgets,
} from "./widgets.js";
import { OCEAN2_DEFAULTS } from "../render/water/oceanSurface.js";

// ── Sea-state presets ────────────────────────────────────────────────────────
// Physical sea states for the horvath spectrum. Wave heights (Hs, 4σ of the
// surface) were measured from the baked spectrum at 256² — they are the sea
// the spectrum makes before the Long/Short-wave height × multipliers.
const SEA_PRESETS = [
  {
    name: "Calm bay",
    hint: "Hs ≈ 0.4 m: a sheltered bay on a light breeze, short waves, almost no whitecaps.",
    values: { windSpeed: 5, seaFetchKm: 2, swellStrength: 0.01, swellWindSpeed: 4,
      fftChoppiness: 0.9, whitecapThreshold: 0.97 },
  },
  {
    name: "Coastal",
    hint: "Hs ≈ 1.3 m: a moderate coastal sea on a fresh wind with a long, low swell. The default.",
    values: { windSpeed: 14, seaFetchKm: 5, swellStrength: 0.04, swellWindSpeed: 6,
      fftChoppiness: 1.3, whitecapThreshold: 0.84 },
  },
  {
    name: "Open ocean",
    hint: "Hs ≈ 3.3 m: open water with a developed wind sea over a long ocean swell.",
    values: { windSpeed: 16, seaFetchKm: 25, swellStrength: 0.08, swellWindSpeed: 9,
      fftChoppiness: 1.35, whitecapThreshold: 0.78 },
  },
  {
    name: "Storm",
    hint: "Hs ≈ 10 m: a gale over hundreds of kilometres of ocean. Crests break everywhere.",
    values: { windSpeed: 24, seaFetchKm: 150, swellStrength: 0.15, swellWindSpeed: 12,
      fftChoppiness: 1.2, whitecapThreshold: 0.66 },
  },
];

// ── Per-channel coefficients shown as colours ────────────────────────────────
// The shader stores light absorption as three per-channel coefficients. Nobody
// can tune "0.42, 0.09, 0.055" by eye, but everybody can pick "the colour white
// light still has after going through this much water" — which is exactly
// exp(-coefficient · distance), per channel. The picker shows that colour and
// writes the coefficients back, so the saved values stay the shader's own.

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linearToSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

function hexFromLinear(rgb) {
  return "#" + rgb.map((c) => {
    const v = Math.round(Math.min(1, Math.max(0, linearToSrgb(c))) * 255);
    return v.toString(16).padStart(2, "0");
  }).join("");
}

function linearFromHex(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => srgbToLinear(v / 255));
}

/**
 * A `{ hex }` object bound to a coefficient triple. `distance()` is the path
 * length the colour describes, read live so it follows its own slider.
 */
function transmittanceColor(bag, key, distance) {
  return {
    get hex() {
      const d = distance();
      return hexFromLinear(bag[key].map((a) => Math.exp(-a * d)));
    },
    set hex(v) {
      const d = Math.max(distance(), 1e-3);
      // Clamped away from 0 and 1: black would be infinite absorption, white none.
      bag[key] = linearFromHex(v).map((t) => -Math.log(Math.min(0.999, Math.max(0.001, t))) / d);
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {HTMLElement} parent
 * @param {object} v2 — toolState.worldOcean.v2
 * @param {object} deps
 * @param {() => void} deps.onChange — push the bag to the live ocean
 * @param {() => object|null} [deps.getStats] — worldOceanV2 `stats`, or null
 */
export function buildOceanV2Controls(parent, v2, { onChange, getStats = () => null }) {
  const ch = onChange;

  /** Put `keys` back to their defaults and show it. */
  const resetKeys = (keys) => {
    for (const k of keys) {
      const d = OCEAN2_DEFAULTS[k];
      if (d === undefined) continue;
      v2[k] = Array.isArray(d) ? d.slice() : d;
    }
    ch();
    refreshWidgets();
  };

  /**
   * One group: a collapsible section, an "Advanced" fold inside it, and a
   * Reset covering every key the group's controls bind. `build(main, adv, s)`
   * adds controls through `s`, which records the keys.
   */
  const group = (title, build, { expanded = false } = {}) => {
    // Prefixed: these sit at the top level of the World tab beside Sky, Fog...
    const body = section(parent, `Ocean V2 · ${title}`, expanded);
    const keys = new Set();
    let adv = null;
    const advanced = () => (adv ??= section(body, "Advanced", false));
    const s = {
      slider: (where, key, opts) => { keys.add(key); return slider(where, v2, key, { onChange: ch, ...opts }); },
      toggle: (where, key, opts) => { keys.add(key); return toggle(where, v2, key, { onChange: ch, ...opts }); },
      color: (where, key, opts) => { keys.add(key); return color(where, v2, key, { onChange: ch, ...opts }); },
      /** Colour picker over a coefficient triple (see transmittanceColor). */
      transColor: (where, key, distance, opts) => {
        keys.add(key);
        return color(where, transmittanceColor(v2, key, distance), "hex", { onChange: ch, ...opts });
      },
      dropdown: (where, key, opts) => { keys.add(key); return dropdown(where, v2, key, { onChange: ch, ...opts }); },
      advanced,
    };
    build(body, s);
    // Reset lives at the bottom, after Advanced, so it reads as covering both.
    if (adv) body.appendChild(adv.parentElement);
    button(body, {
      title: `Reset ${title.toLowerCase()}`,
      hint: "Put every control in this group back to its default.",
      onClick: () => resetKeys(keys),
    });
    return body;
  };

  // ── Sea state ─────────────────────────────────────────────────────────────
  group("Sea state", (b, s) => {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:4px;flex-wrap:wrap;padding:2px 0 6px";
    b.appendChild(row);
    for (const p of SEA_PRESETS) {
      button(row, {
        title: p.name,
        hint: p.hint,
        style: "flex:1 1 45%;min-width:0",
        onClick: () => {
          Object.assign(v2, p.values);
          ch();
          refreshWidgets();
        },
      });
    }

    s.slider(b, "windSpeed", {
      label: "Wind (m/s)", min: 1, max: 40, step: 0.5,
      hint: "Local wind speed. Raises the wind sea — how much it can raise depends on Fetch.",
    });
    s.slider(b, "windAngleDeg", { label: "Wind direction", min: 0, max: 360, step: 1 });
    s.slider(b, "seaFetchKm", {
      label: "Fetch (km)", min: 0.5, max: 300, step: 0.5, curve: "log",
      hint: "How far the wind has blown over open water — the calm-coast to open-ocean "
        + "control, in real units. Wave height grows with √fetch: at 14 m/s, 3 km ≈ 0.8 m, "
        + "10 km ≈ 1.5 m, 100 km ≈ 5.5 m.",
    });
    separator(b);
    s.slider(b, "swellStrength", {
      label: "Swell", min: 0, max: 0.5, step: 0.005,
      hint: "Long waves from a storm far away, independent of the local wind. "
        + "Height grows with √this; 0.04 ≈ 0.8 m.",
    });
    s.slider(b, "swellWindSpeed", {
      label: "Swell length", min: 2, max: 16, step: 0.1,
      hint: "The far-away wind that raised the swell — sets its wavelength. "
        + "4 ≈ 40 m crests, 6 ≈ 84 m, 10 ≈ 225 m. Longer swell is also taller at the same strength.",
    });
    s.slider(b, "swellAngleOffsetDeg", {
      label: "Swell angle", min: -180, max: 180, step: 1,
      hint: "Swell direction relative to the wind. A crossed sea (60-90°) reads busier "
        + "than one running with the wind.",
    });
    separator(b);
    s.slider(b, "fftChoppiness", {
      label: "Choppiness", min: 0, max: 2.5, step: 0.05,
      hint: "Sideways displacement that pinches crests and widens troughs. 0 is rolling "
        + "sine hills; too high and crests fold through themselves.",
    });
    s.slider(b, "fftNormalStrength", {
      label: "Wave detail", min: 0, max: 2.5, step: 0.05,
      hint: "How strongly the small waves shade the surface (normals only — the mesh is unchanged).",
    });

    const a = s.advanced();
    s.slider(a, "fftSwellAmp", {
      label: "Long-wave height ×", min: 0, max: 2.5, step: 0.05,
      hint: "Artistic multiplier on the 250 m cascade, on top of the physical sea above.",
    });
    s.slider(a, "fftRippleAmp", {
      label: "Short-wave height ×", min: 0, max: 2, step: 0.05,
      hint: "Artistic multiplier on the 5 m cascade.",
    });
    s.slider(a, "shoalDistance", {
      label: "Shoaling reach (m)", min: 2, max: 120, step: 1,
      hint: "Metres from shore over which swell shrinks to nothing at the waterline.",
    });
    s.slider(a, "shoalPeak", {
      label: "Shoaling rise", min: 1, max: 2.5, step: 0.05,
      hint: "How much a wave stands up as it feels the bottom, before it dies at the shore.",
    });
    s.slider(a, "seaDepthM", {
      label: "Water depth (m)", min: 2, max: 1000, step: 1, curve: "log",
      hint: "Depth the spectrum assumes. Shallow water shortens and steepens the long waves.",
    });
    s.slider(a, "fftSeed", {
      label: "Seed", min: 1, max: 9999, step: 1,
      hint: "A different sea with the same statistics.",
    });
    separator(a);
    s.slider(a, "normalStrength", {
      label: "Ripple map strength", min: 0, max: 1, step: 0.01,
      hint: "Tiling normal map for detail finer than the smallest cascade. Close range only.",
    });
    s.slider(a, "normalTiling", { label: "Ripple map tiling", min: 0.005, max: 0.2, step: 0.001 });
    s.slider(a, "normalFlowSpeed", { label: "Ripple map speed", min: 0, max: 1, step: 0.01 });
    s.slider(a, "detailEnd", {
      label: "Ripple map range (m)", min: 20, max: 800, step: 10,
      hint: "Camera distance past which the ripple map is faded out.",
    });
  }, { expanded: true });

  // ── Water colour ──────────────────────────────────────────────────────────
  group("Water colour", (b, s) => {
    s.transColor(b, "absorption", () => v2.absorptionScale, {
      label: "Absorption colour",
      hint: "The colour white light still has after one 'Absorption depth' of water. "
        + "Whatever is dark here is absorbed first — this is the choice between "
        + "turquoise shallows and deep navy.",
    });
    s.slider(b, "depthDistance", {
      label: "Absorption depth (m)", min: 4, max: 200, step: 1,
      hint: "Metres of water the absorption colour describes. Higher = clearer water.",
    });
    s.color(b, "inscatterTint", {
      label: "Deep water colour",
      hint: "Light scattered back out of the body — what open, deep water looks like.",
    });
    s.slider(b, "inscatterStrength", { label: "Deep water strength", min: 0, max: 3, step: 0.02 });
    separator(b);
    s.color(b, "turbidityTint", {
      label: "Nearshore colour",
      hint: "Churned-up coastal water scatters more, and greener.",
    });
    s.slider(b, "turbidityStrength", { label: "Nearshore strength", min: 0, max: 2, step: 0.02 });
    s.slider(b, "turbidityReach", {
      label: "Nearshore reach (m)", min: 2, max: 150, step: 1,
      hint: "Metres offshore the nearshore colour fades over.",
    });

    const a = s.advanced();
    s.slider(a, "refractionStrength", {
      label: "Refraction", min: 0, max: 0.2, step: 0.001,
      hint: "How much the seabed wobbles through the surface.",
    });
    s.slider(a, "refractEnd", {
      label: "Refraction range (m)", min: 50, max: 1500, step: 10,
      hint: "Past this camera distance the refraction tap is skipped.",
    });
    s.slider(a, "absorptionScale", {
      label: "Absorption scale", min: 1, max: 40, step: 0.5,
      hint: "Multiplier the absorption colour is expressed against. Leave it unless the "
        + "colour picker runs out of range.",
    });
  });

  // ── Reflection & light ────────────────────────────────────────────────────
  group("Reflection & light", (b, s) => {
    s.slider(b, "glintIntensity", {
      label: "Sun glint", min: 0, max: 4, step: 0.02,
      hint: "Brightness of the sun's reflection on the waves.",
    });
    s.slider(b, "glintPower", {
      label: "Glint sharpness", min: 10, max: 2000, step: 1, curve: "log",
      hint: "Higher = a tighter, harder sun glitter path.",
    });
    s.slider(b, "glintSpread", {
      label: "Glint spread", min: 0, max: 1, step: 0.01,
      hint: "How far the glitter path spreads across the waves.",
    });
    separator(b);
    s.toggle(b, "sssEnabled", {
      label: "Crest glow",
      hint: "Sunlight shining through thin, backlit wave crests.",
    });
    s.slider(b, "sssIntensity", { label: "Crest glow strength", min: 0, max: 3, step: 0.02 });
    s.color(b, "sssColor", { label: "Crest glow colour" });
    separator(b);
    s.toggle(b, "shadowsEnabled", {
      label: "Shadows on water",
      hint: "Cliffs, trees and props shade the sea. Shade removes direct sun (glint, crest "
        + "glow, sun-lit foam) but keeps the sky reflection. Uses the terrain's own shadow "
        + "cascades, so it reaches as far as the World shadow distance and costs one lookup.",
    });
    s.slider(b, "shadowBodyDarken", {
      label: "Shade darkens water", min: 0, max: 1, step: 0.01,
      hint: "How much the water's own colour dims in full shade. 0 = only the sun terms react.",
    });
    s.slider(b, "shadowFoamDarken", { label: "Shade darkens foam", min: 0, max: 1, step: 0.01 });
    separator(b);
    s.slider(b, "envReflect", {
      label: "Env reflection", min: 0, max: 1, step: 0.02,
      hint: "How much of the reflection comes from the scene's real environment map rather "
        + "than the analytic sky. At grazing angles the water IS its reflection.",
    });
    s.slider(b, "waterRoughness", {
      label: "Water roughness", min: 0, max: 0.25, step: 0.005,
      hint: "Base roughness of undisturbed water — nearly a mirror.",
    });
    s.slider(b, "specAA", {
      label: "Distance roughness", min: 0, max: 1.5, step: 0.02,
      hint: "Folds the wave detail a pixel cannot resolve back in as roughness, so the "
        + "horizon neither goes glassy nor sparkles.",
    });

    const a = s.advanced();
    s.slider(a, "fresnelScale", { label: "Fresnel ×", min: 0, max: 2, step: 0.02 });
    s.slider(a, "envIntensity", { label: "Env intensity", min: 0, max: 3, step: 0.02 });
    s.slider(a, "skyReflectIntensity", { label: "Sky reflection ×", min: 0, max: 3, step: 0.02 });
    s.slider(a, "skyHorizonSpread", {
      label: "Horizon glow (°)", min: 1, max: 45, step: 1,
      hint: "Half-width of the bright band at the horizon in the analytic sky reflection.",
    });
    s.slider(a, "skySunGlow", { label: "Sun aureole", min: 0, max: 2, step: 0.02 });
    s.slider(a, "skySunGlowSize", { label: "Aureole tightness", min: 1, max: 64, step: 1 });
    s.slider(a, "specAAMax", { label: "Distance roughness cap", min: 0, max: 1, step: 0.01 });
    separator(a);
    s.toggle(a, "ssrEnabled", {
      label: "Reflections (SSR)",
      hint: "Screen-space reflections. Measured at ~5.5 ms on open sea — worth it only where "
        + "there is something on screen worth reflecting.",
    });
    s.slider(a, "ssrStrength", { label: "SSR strength", min: 0, max: 1, step: 0.02 });
    s.slider(a, "ssrMaxDistance", { label: "SSR ray length (m)", min: 10, max: 500, step: 5 });
    s.slider(a, "ssrThickness", { label: "SSR thickness (m)", min: 0.1, max: 10, step: 0.1 });
    s.slider(a, "ssrEdgeFade", { label: "SSR edge fade", min: 0.01, max: 0.5, step: 0.01 });
    s.slider(a, "ssrEnd", { label: "SSR range (m)", min: 50, max: 1000, step: 10 });
  });

  // ── Whitecaps ─────────────────────────────────────────────────────────────
  group("Whitecaps", (b, s) => {
    s.toggle(b, "whitecapEnabled", {
      label: "Whitecaps",
      hint: "Foam where open-sea crests fold over (the FFT's own Jacobian).",
    });
    s.slider(b, "whitecapIntensity", { label: "Strength", min: 0, max: 2, step: 0.02 });
    s.slider(b, "whitecapThreshold", {
      label: "Threshold", min: 0, max: 1, step: 0.01,
      hint: "How hard a crest has to fold before it foams. Higher = fewer whitecaps.",
    });
    s.slider(b, "whitecapSoftness", { label: "Softness", min: 0.01, max: 0.6, step: 0.01 });
    s.slider(b, "whitecapCoreSharpness", {
      label: "Core sharpness", min: 0.5, max: 6, step: 0.1,
      hint: "1 = a solid white sheet over the whole folding crest. Higher keeps only the "
        + "core solid and erodes the rest into lace — the look of real whitecaps.",
    });
    s.slider(b, "whitecapStreak", {
      label: "Wind streaks", min: 0, max: 1, step: 0.01,
      hint: "How much whitecap foam is dragged into long streaks along the wind.",
    });
    s.slider(b, "whitecapStreakScale", {
      label: "Streaks / m", min: 0.05, max: 1.5, step: 0.01,
      hint: "Streak density across the wind; they run about 8× longer along it. "
        + "The foam itself uses the same pattern as the shore foam (Foam group).",
    });
    s.slider(b, "fftFoamDecay", {
      label: "Fade speed", min: 0.05, max: 3, step: 0.05,
      hint: "How fast whitecap foam dissolves after the crest passes. Lower = it lingers.",
    });
  });

  // ── Foam: surf, shore, contact — and the pattern and relief every foam shares ──
  group("Foam", (b, s) => {
    s.toggle(b, "surfEnabled", { label: "Surf" });
    s.slider(b, "surfHz", {
      label: "Sets / second", min: 0.02, max: 0.6, step: 0.005,
      hint: "Wave sets arriving per second. Times crest spacing = shoreward speed in m/s.",
    });
    s.slider(b, "surfLength", { label: "Crest spacing (m)", min: 12, max: 160, step: 1 });
    s.slider(b, "surfReach", {
      label: "Surf zone (m)", min: 4, max: 120, step: 1,
      hint: "Metres offshore the surf reaches. A beach wants 40-60; a quay wall ~14.",
    });
    s.slider(b, "crestIntensity", { label: "Breaker brightness", min: 0, max: 2, step: 0.02 });
    separator(b);
    s.toggle(b, "foamEnabled", { label: "Shore foam" });
    s.color(b, "foamColor", { label: "Foam colour" });
    s.slider(b, "foamCutoff", {
      label: "Foam density", min: 0, max: 0.8, step: 0.01,
      hint: "Threshold at full coverage. Low is a solid sheet with holes; ~0.6 a connected web.",
    });
    s.slider(b, "edgeIntensity", {
      label: "Edge foam", min: 0, max: 1.5, step: 0.02,
      hint: "The permanent lace at the water's edge, which moves with it.",
    });
    s.slider(b, "edgeWidth", { label: "Edge width (m)", min: 0.1, max: 8, step: 0.1 });
    s.slider(b, "foamSunLit", {
      label: "Sun-lit foam", min: 0, max: 1, step: 0.01,
      hint: "0 = flat white; 1 = foam lit and shaded by the sun like a surface.",
    });
    s.slider(b, "foamBubbles", {
      label: "Bubbles", min: 0, max: 1, step: 0.01,
      hint: "Holes punched in foam seen up close — small in fresh foam, wide in old foam, "
        + "so it ages into bubbly lace. Fades out with distance on its own.",
    });
    s.slider(b, "foamBubbleScale", { label: "Bubbles / m", min: 0.5, max: 12, step: 0.1 });
    s.slider(b, "foamRelief", {
      label: "Foam relief", min: 0, max: 0.3, step: 0.005,
      hint: "Apparent thickness of the foam layer: how strongly its edges catch the sun. "
        + "Applies to every foam — surf, whitecaps, contact.",
    });
    separator(b);
    s.toggle(b, "contactFoamEnabled", {
      label: "Contact foam",
      hint: "Foam wherever water meets geometry — pier legs, rocks, hulls, cliff feet — "
        + "and over rocks just under the surface. Read from the depth buffer; no setup.",
    });
    s.slider(b, "contactFoamWidth", {
      label: "Contact depth (m)", min: 0.05, max: 3, step: 0.05,
      hint: "Water shallower than this over any geometry foams. Wider ring = larger value.",
    });
    s.slider(b, "contactFoamIntensity", { label: "Contact strength", min: 0, max: 2, step: 0.02 });

    const a = s.advanced();
    s.slider(a, "crestSharpness", { label: "Breaker sharpness", min: 1, max: 20, step: 0.5 });
    s.slider(a, "foamWakeIntensity", { label: "Wake brightness", min: 0, max: 2, step: 0.02 });
    s.slider(a, "foamDecay", {
      label: "Wake decay", min: 0.5, max: 10, step: 0.1,
      hint: "Higher = the foam a breaker leaves dies sooner.",
    });
    s.slider(a, "surfAlongShore", {
      label: "Along-shore stagger", min: 0, max: 0.02, step: 0.0002,
      hint: "Phase shift per metre along the beach, so an angled swell breaks progressively.",
    });
    s.slider(a, "slopeGain", {
      label: "Seabed slope influence", min: 0, max: 10, step: 0.1,
      hint: "Steep bed = tight plunging breaker, shallow = wide spilling one.",
    });
    separator(a);
    s.slider(a, "foamNoiseScale", { label: "Foam cells / m", min: 0.05, max: 1.6, step: 0.01 });
    s.slider(a, "foamMacroScale", {
      label: "Sheet cells / m", min: 0.005, max: 0.12, step: 0.002,
      hint: "The large pattern that decides where foam clumps at all — 0.03 ≈ 33 m sheets.",
    });
    s.slider(a, "foamMacroAmt", { label: "Sheet contrast", min: 0, max: 1, step: 0.02 });
    s.slider(a, "foamMacroDrift", { label: "Sheet drift", min: 0, max: 5, step: 0.05 });
    s.slider(a, "foamTransition", { label: "Edge softness", min: 0.02, max: 0.45, step: 0.01 });
    s.slider(a, "foamGain", { label: "Pattern gain", min: 0.5, max: 4, step: 0.05 });
    s.slider(a, "foamContrast", { label: "Pattern contrast", min: 0.2, max: 4, step: 0.05 });
    s.slider(a, "foamErode", {
      label: "Erosion curve", min: 0.2, max: 5, step: 0.05,
      hint: "Higher = foam holds together longer, then shatters late.",
    });
    s.slider(a, "foamJitter", { label: "Cell jitter", min: 0, max: 1, step: 0.01 });
    s.slider(a, "foamWarpScale", { label: "Warp frequency", min: 0.1, max: 8, step: 0.1 });
    s.slider(a, "foamWarpStrength", { label: "Warp strength", min: 0, max: 2, step: 0.02 });
    s.slider(a, "foamDrift", { label: "Foam drift (m/s)", min: 0, max: 6, step: 0.05 });
    s.slider(a, "foamLodPixels", {
      label: "Foam LOD (px/cell)", min: 1, max: 8, step: 0.1,
      hint: "Pixels per cell at which a pattern octave is dropped. Below ~2 it crawls.",
    });
    s.slider(a, "foamDetailNear", { label: "Detail fade start (m)", min: 20, max: 1500, step: 10 });
    s.slider(a, "foamDetailFar", { label: "Detail fade end (m)", min: 50, max: 3000, step: 10 });
    s.slider(a, "foamFarDensity", { label: "Far foam density", min: 0, max: 1, step: 0.01 });
    s.slider(a, "foamReliefEnd", { label: "Relief range (m)", min: 20, max: 600, step: 10 });
    s.slider(a, "contactFoamEnd", {
      label: "Contact range (m)", min: 30, max: 1000, step: 10,
      hint: "Camera distance past which contact foam fades — depth precision gets too coarse.",
    });
  });

  // ── Run-up & wet sand ─────────────────────────────────────────────────────
  group("Run-up & wet sand", (b, s) => {
    s.toggle(b, "runupEnabled", {
      label: "Run-up",
      hint: "The water's edge climbs the beach and drains back, as real geometry.",
    });
    s.slider(b, "runupReach", {
      label: "Run-up (m)", min: 0, max: 26, step: 0.25,
      hint: "Metres the edge climbs at the top of the surge. Off where the seabed is too steep.",
    });
    s.slider(b, "wetDarken", { label: "Wet sand darkening", min: 0, max: 1, step: 0.01 });
    s.slider(b, "wetGloss", { label: "Wet sand gloss", min: 0, max: 2, step: 0.02 });

    const a = s.advanced();
    s.slider(a, "runupRush", {
      label: "Rush fraction", min: 0.02, max: 0.95, step: 0.01,
      hint: "Share of the cycle spent rushing in; the rest is the slower drain.",
    });
    s.slider(a, "runupShape", { label: "Surge shape", min: 0.2, max: 3, step: 0.05 });
    s.slider(a, "runupMaxSlope", {
      label: "Max slope", min: 0.02, max: 1.5, step: 0.01,
      hint: "Seabed slope above which there is no run-up — water meets rock, it does not climb it.",
    });
    s.slider(a, "filmThickness", { label: "Sheet thickness (m)", min: 0.005, max: 0.3, step: 0.005 });
    s.slider(a, "wetFade", { label: "Wet sand width (m)", min: 0, max: 10, step: 0.1 });
    s.slider(a, "runupNearEnd", { label: "Run-up fade start (m)", min: 20, max: 1000, step: 10 });
    s.slider(a, "runupFarEnd", { label: "Run-up fade end (m)", min: 40, max: 2000, step: 10 });
  });

  // ── Underwater ────────────────────────────────────────────────────────────
  group("Underwater", (b, s) => {
    s.toggle(b, "uwEnabled", {
      label: "Underwater",
      hint: "The waterline across the lens, the water between the camera and what it sees, "
        + "and Snell's window from below. Not drawn at all while the camera is above 'Active band'.",
    });
    s.slider(b, "uwDensity", {
      label: "Murk", min: 0.1, max: 4, step: 0.05,
      hint: "0.5 tropical clarity, 1 clear coastal, 2+ a murky harbour.",
    });
    s.transColor(b, "uwExtinction", () => 10, {
      label: "Colour after 10 m",
      hint: "The colour white light keeps after 10 m of water (at Murk 1). Whatever is dark "
        + "here is gone first with distance — normally red.",
    });
    s.color(b, "uwScatterColor", {
      label: "Water colour",
      hint: "A line of sight that never hits anything, just under the surface. Lit by the "
        + "scene's own sun and sky, so it darkens at dusk and with depth by itself.",
    });
    s.slider(b, "uwLightGain", { label: "Light in water", min: 0, max: 3, step: 0.02 });
    s.slider(b, "uwSunGlow", {
      label: "Sun glow", min: 0, max: 1, step: 0.01,
      hint: "The bright haze toward the sun, which under water is always within ~48° of straight up.",
    });
    s.slider(b, "uwWindowSky", {
      label: "Snell's window", min: 0, max: 3, step: 0.02,
      hint: "Brightness of the disc of sky seen through the surface from below.",
    });
    separator(b);
    s.toggle(b, "uwShaftsEnabled", {
      label: "Light shafts",
      hint: "Sunlight focused by the waves into columns. A short march inside the underwater "
        + "pass — only pixels under water pay.",
    });
    s.slider(b, "uwShaftIntensity", { label: "Shaft strength", min: 0, max: 24, step: 0.1 });
    s.slider(b, "uwShaftDistance", {
      label: "Shaft reach (m)", min: 5, max: 120, step: 1,
      hint: "Longer reach spreads the same 10 steps thinner, so shafts get grainier.",
    });
    s.slider(b, "uwShaftScale", { label: "Shaft cells / m", min: 0.01, max: 0.4, step: 0.005 });
    s.slider(b, "uwShaftSharpness", { label: "Shaft sharpness", min: 0.5, max: 10, step: 0.1 });
    s.slider(b, "uwShaftSpeed", { label: "Shaft drift", min: 0, max: 3, step: 0.05 });
    separator(b);
    s.toggle(b, "uwSnowEnabled", { label: "Marine snow" });
    s.slider(b, "uwSnowCount", { label: "Snow specks", min: 0, max: 4000, step: 50 });
    s.slider(b, "uwSnowIntensity", { label: "Snow brightness", min: 0, max: 3, step: 0.02 });
    s.slider(b, "uwSnowSize", { label: "Snow size (m)", min: 0.003, max: 0.05, step: 0.001 });
    separator(b);
    s.toggle(b, "uwCausticsEnabled", {
      label: "Seabed caustics",
      hint: "Pattern, speed and colour are shared with the lakebed (Lakes panel).",
    });
    s.slider(b, "uwCausticsIntensity", { label: "Caustics", min: 0, max: 3, step: 0.02 });
    s.slider(b, "uwCausticsMaxDepth", { label: "Caustics depth (m)", min: 2, max: 80, step: 1 });

    const a = s.advanced();
    s.slider(a, "uwSunGlowG", {
      label: "Sun glow tightness", min: 0, max: 0.95, step: 0.01,
      hint: "Forward-scattering g. Higher = a smaller, brighter halo.",
    });
    s.slider(a, "uwLineWidth", { label: "Waterline width (px)", min: 0.5, max: 8, step: 0.1 });
    s.slider(a, "uwLineDarken", { label: "Waterline dark", min: 0, max: 1, step: 0.01 });
    s.slider(a, "uwLineDistort", { label: "Waterline drag (px)", min: 0, max: 20, step: 0.5 });
    s.slider(a, "uwActiveBand", {
      label: "Active band (m)", min: 1, max: 20, step: 0.5,
      hint: "Camera height above sea level at which the underwater pass starts running. "
        + "Must clear the tallest crest.",
    });
    s.slider(a, "uwSnowBox", { label: "Snow box (m)", min: 4, max: 60, step: 1 });
    s.slider(a, "uwCausticsRange", {
      label: "Caustics range (m)", min: 20, max: 1000, step: 10,
      hint: "Camera distance past which seabed caustics are not computed at all.",
    });
  });

  // ── Distance & performance ────────────────────────────────────────────────
  group("Distance & performance", (b, s) => {
    s.slider(b, "horizonFadeStart", {
      label: "Horizon fade start (m)", min: 200, max: 20000, step: 10, curve: "log",
    });
    s.slider(b, "horizonFadeEnd", {
      label: "Horizon fade end (m)", min: 500, max: 40000, step: 10, curve: "log",
    });
    s.slider(b, "dispFadeStart", {
      label: "Wave mesh fade start (m)", min: 50, max: 2000, step: 10,
      hint: "Past here the waves stop displacing the mesh, fading to a flat shaded plane.",
    });
    s.slider(b, "dispFadeEnd", { label: "Wave mesh fade end (m)", min: 100, max: 4000, step: 10 });
    s.slider(b, "fftEnd", {
      label: "Wave shading range (m)", min: 200, max: 6000, step: 50,
      hint: "Past this the FFT is not sampled at all and the sea shades as a flat mirror.",
    });
    separator(b);
    s.slider(b, "fftUpdateHz", {
      label: "Sim rate (Hz)", min: 5, max: 60, step: 5,
      hint: "How often the FFT runs. Compute cost, independent of frame rate.",
    });
    s.dropdown(b, "fftSize", {
      label: "Wave resolution",
      options: [[128, "128²"], [256, "256² (default)"], [512, "512²"]],
      hint: "FFT grid per cascade. Changing it rebuilds the ocean (a short hitch). 512² "
        + "bakes its spectrum in ~0.8 s.",
    });
    separator(b);
    s.slider(b, "levels", { label: "Mesh rings", min: 2, max: 10, step: 1 });
    s.slider(b, "gridM", { label: "Ring grid", min: 16, max: 128, step: 8 });
    s.slider(b, "baseCell", {
      label: "Inner cell (m)", min: 0.25, max: 8, step: 0.25,
      hint: "Vertex spacing of the innermost ring. Smaller = finer near waves, more triangles.",
    });
    s.slider(b, "horizonScale", { label: "Mesh reach ×", min: 1, max: 20, step: 0.5 });

    const statsLine = info(b, "Mesh", "—", { layout: "prop" });
    const simLine = info(b, "Waves", "—", { layout: "prop" });
    const bakeLine = info(b, "Shore bake", "—", { layout: "prop" });
    const tick = () => {
      if (!statsLine.row.isConnected) return;   // panel rebuilt: stop
      const st = getStats();
      if (st) {
        statsLine.update(`${(st.triangles / 1000).toFixed(0)}k tris · ${st.rings} rings · `
          + `${st.draws} draw · ${(st.reach / 1000).toFixed(1)} km`);
        simLine.update(`${st.spectrumMode} · ${st.cascades} × ${st.fftSize}²`);
        bakeLine.update(`${st.shoreBakeMs.toFixed(0)} ms`);
      } else {
        statsLine.update("not built (select V2)");
        simLine.update("—");
        bakeLine.update("—");
      }
      setTimeout(tick, 1000);
    };
    tick();
  });

  hint(parent, "Sea level, the on/off switch and the shader choice are in World Ocean above. "
    + "Nothing here changes the classic ocean.");
}
