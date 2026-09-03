/**
 * SKY WEATHER — one dial that moves the whole atmosphere together.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * WHY A PRESET SYSTEM RATHER THAN MORE SLIDERS.
 *
 * Every knob needed for weather already existed: coverage, density, cirrus, haze,
 * shadow strength. What did not exist was the KNOWLEDGE that they move together. A
 * storm is not "coverage up" — it is coverage up AND the deck thicker AND its bases
 * darker AND the sun weaker AND the haze denser AND the shadows softer, because a solid
 * ceiling scatters light instead of casting it. Set one of those without the others and
 * the sky reads as broken rather than stormy, which is exactly what a pile of
 * independent sliders invites.
 *
 * So a preset is a claim about which values are consistent with each other, and the
 * table below is the actual content of this module. The code is only a crossfade.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * TRANSITIONS ARE THE POINT, not a nicety.
 *
 * Weather that snaps is worse than no weather — the cut reads as a bug, and a racing
 * game will change it mid-lap. So `set()` starts a timed crossfade and `update()` walks
 * it. Crucially the driver writes NOTHING once a transition has finished: the moment it
 * settles it lets go of the params, so the dev-panel sliders keep working normally
 * instead of being fought by a controller that never stops writing.
 *
 * WHAT IT DOES NOT TOUCH, deliberately:
 *   • the sun's colour, intensity and the exposure — those follow the SKY (time of day)
 *     and are already driven from real transmittance; weather has no business
 *     overriding the hour.
 *   • rain. There is a hook (`onWetness`) and nothing else, because the rain system is
 *     under active development elsewhere and this must not reach into it.
 *   • the volumetric tier's own params — it has a different shape model and different
 *     units. Weather drives the painted deck, which is the default tier.
 */

/**
 * The presets. Each is a SPARSE set of overrides: a key absent here keeps whatever the
 * deck already had, so a preset is a statement about the fields it actually cares about
 * rather than a full snapshot that would freeze every unrelated tweak you have made.
 *
 * `wetness` is advisory only — it is handed to `onWetness` for whoever owns the road
 * surface and the rain, and never applied here.
 */
export const WEATHER_PRESETS = {
  clear: {
    label: "Clear",
    painted: {
      coverage: 0.16, densityMul: 0.05, topMin: 0.2, thickness: 700,
      baseDark: 0.2, ambient: 0.5, sunStrength: 2.2, msFloor: 0.18,
      cirrusAmount: 0.22, cirrusCoverage: 0.28,
      shadowStrength: 0.42, rayStrength: 0.9,
    },
    aerial: { density: 0.00022, maxAmount: 0.8 },
    wetness: 0,
  },
  fair: {
    label: "Fair",
    painted: {
      coverage: 0.46, densityMul: 0.055, topMin: 0.25, thickness: 850,
      baseDark: 0.22, ambient: 0.55, sunStrength: 2.1, msFloor: 0.18,
      cirrusAmount: 0.42, cirrusCoverage: 0.34,
      shadowStrength: 0.5, rayStrength: 1.1,
    },
    aerial: { density: 0.00035, maxAmount: 0.88 },
    wetness: 0,
  },
  broken: {
    label: "Broken",
    painted: {
      coverage: 0.63, densityMul: 0.065, topMin: 0.3, thickness: 1000,
      baseDark: 0.26, ambient: 0.58, sunStrength: 2.0, msFloor: 0.2,
      cirrusAmount: 0.5, cirrusCoverage: 0.4,
      shadowStrength: 0.6, rayStrength: 1.5,
    },
    aerial: { density: 0.00048, maxAmount: 0.9 },
    wetness: 0.1,
  },
  overcast: {
    label: "Overcast",
    painted: {
      // A ceiling, not cumulus: nearly full coverage, cells all reaching the same
      // height (topMin high = little spread), and a deck thick enough to be opaque.
      coverage: 0.9, densityMul: 0.08, topMin: 0.68, thickness: 1150,
      // Bases go dark and the sun weakens, but the multiple-scattering floor RISES:
      // under a solid deck almost all the light arriving has been scattered, so the
      // cloud glows from within instead of showing a lit side.
      baseDark: 0.34, ambient: 0.72, sunStrength: 1.35, msFloor: 0.3,
      cirrusAmount: 0.1, cirrusCoverage: 0.2,
      // Diffuse light casts almost no shadow, and there is no gap for a shaft.
      shadowStrength: 0.16, rayStrength: 0.2,
    },
    aerial: { density: 0.00085, maxAmount: 0.93 },
    wetness: 0.45,
  },
  storm: {
    label: "Storm",
    painted: {
      coverage: 0.97, densityMul: 0.12, topMin: 0.8, thickness: 1400,
      baseDark: 0.45, ambient: 0.8, sunStrength: 1.0, msFloor: 0.34,
      cirrusAmount: 0.04, cirrusCoverage: 0.15,
      shadowStrength: 0.1, rayStrength: 0.08,
    },
    aerial: { density: 0.0014, maxAmount: 0.95 },
    wetness: 1,
  },
};

export const WEATHER_NAMES = Object.keys(WEATHER_PRESETS);

const lerp = (a, b, t) => a + (b - a) * t;
/** Smoothstep, so a transition eases out of the old sky and into the new one. */
const ease = (t) => t * t * (3 - 2 * t);

/**
 * @param {object}   opts
 * @param {object}   opts.painted  live painted-cloud params (mutated during a transition)
 * @param {object}   [opts.aerial] live aerial-perspective params
 * @param {function} [opts.onWetness] called with 0..1 when a transition settles — the
 *   ONLY thing this module says about rain, and it says it by handing the number over.
 */
export function createWeather({ painted, aerial, onWetness } = {}) {
  let current = "fair";
  /** Snapshot of where the fade started, so a transition interrupted halfway still
   *  starts from what is on screen rather than jumping back to a preset. */
  let from = null;
  let target = null;
  let elapsed = 0;
  let duration = 0;

  function snapshot() {
    const p = {};
    const a = {};
    if (target) {
      for (const k of Object.keys(target.painted ?? {})) p[k] = painted?.[k];
      for (const k of Object.keys(target.aerial ?? {})) a[k] = aerial?.[k];
    }
    return { painted: p, aerial: a };
  }

  /**
   * Start a crossfade to a named preset.
   * @param {string} name
   * @param {number} [seconds] 0 applies instantly
   */
  function set(name, seconds = 6) {
    const preset = WEATHER_PRESETS[name];
    if (!preset) return false;
    current = name;
    target = preset;
    from = snapshot();
    duration = Math.max(0, seconds);
    elapsed = 0;
    if (duration === 0) apply(1);
    return true;
  }

  function apply(t) {
    const e = ease(Math.min(1, Math.max(0, t)));
    if (painted && target.painted) {
      for (const [k, v] of Object.entries(target.painted)) {
        const a = from.painted[k];
        painted[k] = a === undefined ? v : lerp(a, v, e);
      }
    }
    if (aerial && target.aerial) {
      for (const [k, v] of Object.entries(target.aerial)) {
        const a = from.aerial[k];
        aerial[k] = a === undefined ? v : lerp(a, v, e);
      }
    }
  }

  /** @param {number} dt seconds */
  function update(dt) {
    // Idle costs nothing AND writes nothing — see the header: a controller that keeps
    // writing would silently overwrite every slider the moment you touched one.
    if (!target) return;
    elapsed += dt;
    const t = duration > 0 ? elapsed / duration : 1;
    apply(t);
    if (t >= 1) {
      const w = target.wetness ?? 0;
      target = null;
      from = null;
      onWetness?.(w);
    }
  }

  return {
    set,
    update,
    get name() { return current; },
    get transitioning() { return !!target; },
    /** 0..1 through the current transition, 1 when settled. */
    get progress() { return target ? Math.min(1, elapsed / Math.max(1e-6, duration)) : 1; },
    names: WEATHER_NAMES,
    presets: WEATHER_PRESETS,
  };
}
