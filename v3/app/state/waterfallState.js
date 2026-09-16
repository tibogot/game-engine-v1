/**
 * Waterfall look — shared by every waterfall in the scene (one material, one
 * draw), saved with the `waterfalls` section. The SHAPE of each fall (lip,
 * width, speed…) lives on the fall itself (waterfallPath.js FALL_DEFAULTS).
 *
 * Two styles, like River v2: "realistic" (waterfallMaterial.js) and "stylized"
 * (waterfallStylizedMaterial.js). With `followRiver` on, the style and the
 * stylized colours come from River v2's water settings, so a river and the
 * falls it pours over always read as the same water.
 */
import { RIVER_STYLIZED_DEFAULTS } from "./riverV2State.js";

export function createWaterfallLookState(overrides = {}) {
  return {
    /** "realistic" | "stylized" */
    style: "realistic",
    /** Take the style and stylized colours from River v2's water look. */
    followRiver: true,

    // ── Realistic ──────────────────────────────────────────────────────────
    /** Tint of the clear water: the scene is seen THROUGH it, this only colours it. */
    waterColor: "#a9dfe3",
    /** How much of that tint the glass takes (0 = colourless glass). */
    glassTint: 0.35,
    /** How much the glass bends what is behind it (screen fraction). */
    refraction: 0.03,
    /** How present the glass is; the refracted scene fills the rest. */
    glassAlpha: 0.85,
    /** Sky reflected off the sheet, Fresnel-weighted. */
    glassReflect: 0.8,
    /** Light bouncing around inside the moving water, so it glows rather than
     *  acting as a window onto dark rock. */
    glassScatter: 0.32,
    /** Aerated white water. */
    foamColor: "#f4f8f8",
    opacity: 1,
    /** Seconds of fall before the sheet is fully aerated (white). */
    aerateTime: 0.9,
    /**
     * How much the sheet thins as it accelerates. Water falling three times
     * faster really is a third as thick, and thin water absorbs less — which
     * makes a thinning fall a paler colour than the river feeding it. At 0 the
     * sheet keeps the river's own depth the whole way down, so the two are the
     * same water; turn it up for a fall that should look gauzy.
     */
    thinning: 0,
    /**
     * How much of the river's sky reflection the SHEET keeps.
     *
     * A river is flat, so you look down onto it and see mostly through it. A
     * fall is vertical, so you look across it at a grazing angle and Fresnel
     * turns it into a mirror — the same water, the same setting, reading as a
     * sheet of sky. Damping it is what makes a fall look like the river that
     * feeds it. 1 keeps the physics as it is.
     */
    reflect: 0.25,
    /** How white the fall gets overall (needs the river's whitewater on). */
    foam: 1,
    /** The churn right at the lip, where the water tears off the edge. */
    lipFoam: 0.7,
    /** Seconds the lip churn lasts. */
    lipFoamTime: 0.25,
    /** Streaks per metre across the sheet. */
    streakScale: 1.3,
    /** Streak pattern cycles per second of fall. Lower = longer streaks. */
    streakRate: 1.2,
    streakContrast: 1.6,
    /** Seconds of fall where the ropes start / finish parting into separate strands. */
    breakupStart: 0.8,
    breakupEnd: 3.5,
    /** How wide the gaps between the ropes open once fully broken up (0 = a solid sheet). */
    breakup: 0.7,
    /** Metres of ragged fade at the sides. */
    edgeFade: 0.8,
    /** The outer veil (loose ropes standing off the sheet). 0 = off. */
    veil: 0.35,
    /** Metres the veil stands off the body, growing with the fall. */
    veilOffset: 0.35,
    /** Sun shining THROUGH the sheet when it is behind it. */
    translucency: 1.2,
    roughness: 0.25,
    /** Metres over which the sheet fades into the ground or rock it meets. */
    softDepth: 0.8,
    /** Fraction of the fall, at the bottom, spent fading out (into the pool). */
    bottomFade: 0.08,
    /** Metres beyond which the detail noise is skipped. */
    detailDistance: 220,

    // ── Impact cap (waterfallCap.js) ───────────────────────────────────────
    // A real dome of churned water where the fall lands — the old waterfall's
    // splash cap, instanced and driven by the solved landing. ON by default;
    // the flat pool foam below is the alternative, not the partner.
    capEnabled: false,
    capColor: "#eef4f5",
    /** The trough colour between the boils. */
    capDeepColor: "#a9c8ce",
    capOpacity: 0.96,
    /** Multiplies the radius the landing implies. */
    capSize: 1,
    /** Height as a fraction of the radius: a plunge is a wide LOW boil. */
    capHeight: 0.3,
    /** How hard the surface boils (displacement, as a fraction of the radius). */
    capRelief: 0.6,
    /** How fast the boil travels down and out. */
    capFlow: 1.3,
    /** How white the aerated water reads. */
    capFoam: 1,
    /** How much of the dome, from the rim, fades into the water. */
    capRim: 0.35,
    capSoftDepth: 0.8,

    // ── Plunge pool (waterfallPool.js) ─────────────────────────────────────
    // Flat foam on the water surface around the cap: the ring a plunge pool has
    // where the boil spreads and breaks up. Kept subtle so the cap reads as the
    // impact and this as its wake.
    poolEnabled: false,
    poolColor: "#eef5f6",
    poolOpacity: 0.7,
    /** Multiplies the radius the landing itself implies (width and speed). */
    poolSize: 1,
    /** How fast the foam travels outward. */
    poolFlow: 0.55,
    /** The white churn directly under the falling water. */
    poolChurn: 0.35,
    /** Rings travelling out from the impact. */
    poolRings: 0.35,
    poolRingRate: 2.2,
    /** How much of the disc is spent fading out at the rim. */
    poolEdge: 0.45,
    poolSoftDepth: 0.5,
    /** Second noise octave; 0 is cheaper and flatter. */
    poolDetail: 1,

    // ── Spray and mist (waterfallSpray.js) ─────────────────────────────────
    sprayEnabled: false,
    /** Fraction of the droplet field in use. 0 stops the simulation. */
    sprayAmount: 0.7,
    /** m/s droplets leave the impact at (times how hard the water lands). */
    spraySpeed: 5,
    sprayLife: 1.1,
    spraySize: 0.13,
    sprayOpacity: 0.75,
    /** How much a droplet stretches along the way it travels. */
    sprayStretch: 2.2,
    sprayColor: "#ffffff",
    spraySoftDepth: 0.6,
    /** Metres beyond which spray and mist fade out entirely. */
    sprayDistance: 260,

    mistEnabled: false,
    mistAmount: 0.6,
    /** m/s the cloud lifts. */
    mistRise: 0.8,
    mistLife: 5,
    mistSize: 3.2,
    /** How much bigger a mist puff gets over its life. */
    mistGrow: 2.4,
    mistOpacity: 0.16,
    /** How far out from the impact mist is born, as a multiple of its radius. */
    mistSpread: 1.6,
    /** Forward scattering: how much the mist lights up looking into the sun. */
    mistScatter: 1.4,

    /** Wind on the spray and mist (m/s, world X and Z). */
    windX: 0.4,
    windZ: 0,

    // ── Stylized ───────────────────────────────────────────────────────────
    // The OLD waterfall's look and numbers (v2/tools/waterfall). The keys are
    // River v2's, so `followRiver` can hand its colours straight over.
    ...RIVER_STYLIZED_DEFAULTS,
    styDarkColor: "#00544c",
    styBodyColor: "#38d0d0",
    styShimmerColor: "#00fff4",
    styFoamColor: "#ffffff",
    styStreakColor: "#ffffff",
    styOpacity: 0.92,
    /** Lattice units the pattern scrolls down the fall per second. */
    styFlowSpeed: 0.5,
    styDepthStrength: 0.5,
    /** The cyan band down the middle. */
    styShimmer: 0.1,
    /** The wide foam layer ("red" in the old shader) and the bright one ("green"). */
    styFoamInner: 0.3,
    styFoamOuter: 1,
    styFoamThreshold: 0.12,
    /** The vertical drip streaks. */
    styStreaks: 0.9,
    styStreakThreshold: 0.12,
    /**
     * Seconds of fall the lip foam covers (the wide layer gets 2.6× that). The
     * old shader used a fraction of its hand-built mesh, which cannot mean the
     * same thing on a 5 m fall and a 60 m one.
     */
    styFoamLength: 0.7,

    ...overrides,
  };
}

/** The look the materials actually use: `look`, with River v2's style when following it. */
export function effectiveWaterfallLook(look, riverWater) {
  if (!look.followRiver || !riverWater) return look;
  const out = { ...look, style: riverWater.style === "stylized" ? "stylized" : "realistic" };
  for (const k of Object.keys(RIVER_STYLIZED_DEFAULTS)) if (riverWater[k] != null) out[k] = riverWater[k];
  return out;
}

/** Shape presets for the next fall placed (and the selected one). */
export const WATERFALL_PRESETS = {
  ribbon:  { label: "Ribbon",  width: 2.5, speed: 1.2, depth: 0.25, spread: 0.08, foam: 0.9, crest: 2 },
  curtain: { label: "Curtain", width: 18,  speed: 2,   depth: 0.4,  spread: 0.06, foam: 1,   crest: 3 },
  cascade: { label: "Cascade", width: 8,   speed: 0.8, depth: 0.5,  spread: 0.1,  foam: 1.2, friction: 0.35, crest: 2.5 },
  torrent: { label: "Torrent", width: 14,  speed: 6,   depth: 1.4,  spread: 0.14, foam: 1.3, crest: 5 },
};
