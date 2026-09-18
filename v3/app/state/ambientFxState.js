/**
 * AMBIENT FX — what an effect IS.
 *
 * The whole point of this system is that an effect is DATA, not a file.
 * Butterflies and falling leaves differ by a motion id, a shape id, a couple
 * of colours and a spawn rule — nothing else. Adding moths, petals, fireflies
 * or embers later is an entry in AMBIENT_PRESETS, not a new module.
 *
 * Everything here is packed into `AMBIENT_ROWS` vec4 uniform rows per effect
 * (see ambientField.js `pack()`), read on the GPU through `field.rowOf()`.
 * Nothing in this file is per-particle: the GPU derives size, colour jitter,
 * phase and lifetime spread from hash(slot).
 *
 * ── MOTION ──────────────────────────────────────────────────────────────────
 * The integrator the compute runs, selected by a real branch. Four are planned;
 * two are built.
 *   0 wander  — seek a drifting heading, bank into it, flap. Butterflies.
 *   1 fall    — gravity to terminal velocity, tumble, settle on the ground.
 *   (2 float, 3 rise — dust/pollen and embers/midges. Not built.)
 *
 * ── SHAPE ───────────────────────────────────────────────────────────────────
 * Which atlas tile the card wears, and how the two halves of the card are
 * hinged. Every effect in this slice is a CARD, so they all share one draw
 * call; a billboard class would be a second.
 */

/** Motion integrator ids — must match the branches in ambientMotion.js. */
export const MOTION = Object.freeze({ wander: 0, fall: 1 });

/**
 * Atlas tiles — the index into AMBIENT_ART in ambientAtlas.js. Re-exported
 * from there so there is ONE list: adding art must not mean editing two files
 * that can then disagree about which tile is a butterfly.
 */
export { ART_TILE as TILE } from "../../render/ambient/ambientAtlas.js";

/** vec4 uniform rows per effect. Keep in step with pack() in ambientField.js. */
export const AMBIENT_ROWS = 7;

/** How many effects the field allocates rows and a paint channel for. */
export const AMBIENT_EFFECT_COUNT = 4;

/**
 * One effect. Every field has a sane default so a preset only says what is
 * interesting about it.
 */
export function createAmbientEffect(over = {}) {
  return {
    name: "Effect",
    enabled: true,
    /** Which AMBIENT_PRESETS entry it was last loaded from — the panel's picker. */
    preset: "",

    /** Slots in the shared pool. This IS the budget — see ambientField.js. */
    budget: 600,

    motion: MOTION.wander,
    /** Index into AMBIENT_ART — which painted shape it wears. */
    tile: 0,

    /* ── Look ── */
    /** Metres, tip to tip. */
    size: 0.09,
    sizeVar: 0.3,
    /**
     * A TINT over the painted artwork, spine colour to tip colour — not the
     * colour itself. At tint 0 the painting shows through untouched, which is
     * the right default: a hand-painted Ulysses does not want recolouring.
     */
    tint: 0,
    colorA: "#e8b33c",
    colorB: "#c8521f",
    /** Per-individual drift, so a swarm is not one image repeated. */
    colorVar: 0.18,
    /** A wing lit from behind glows; a dry leaf barely does. */
    translucency: 0.55,

    /* ── Motion ── */
    /** Metres per second at cruise. */
    speed: 1.1,
    /** How hard the heading wanders. Higher is more erratic. */
    turbulence: 0.6,
    /** Wing beats (or tumbles) per second. */
    flapRate: 7.0,
    /** How far the hinge swings, radians. A butterfly's wing stroke. */
    flapAmp: 0.85,
    /** How far the wind carries it, 0..1 of the world's wind. */
    windCoupling: 0.35,
    /** Seconds before it dies and respawns somewhere the rule allows. */
    lifetime: 16,
    /** Seconds a settled leaf lies on the ground before it fades (fall only). */
    settleTime: 12,

    /* ── Where it lives ── */
    /** Metres above the terrain at that point. */
    altMin: 0.4,
    altMax: 2.6,
    /** Terrain height band, metres. The full range means no limit. */
    heightMin: -1e5,
    heightMax: 1e5,
    /** Steeper than this (normal.y below it) and nothing spawns. */
    slopeMinY: 0.45,

    /* ── Culling (the budget you can trade) ── */
    /** Metres from the anchor where it starts thinning out, and where it is gone. */
    fadeStart: 26,
    fadeEnd: 38,
    /** Below this many pixels across, it is not drawn — it would only crawl. */
    minPixels: 2.2,

    ...over,
  };
}

/**
 * The two effects this slice ships. Both are cards, so both draw in one call.
 */
export const AMBIENT_PRESETS = {
  butterflies: {
    name: "Butterflies",
    motion: MOTION.wander,
    tile: 0,                 // the painted Ulysses
    budget: 500,
    size: 0.085,
    sizeVar: 0.28,
    tint: 0,                 // keep the painting's own blue
    colorA: "#f2c14a",
    colorB: "#b8431c",
    colorVar: 0.12,
    translucency: 0.7,
    speed: 1.15,
    turbulence: 0.7,
    flapRate: 7.5,
    flapAmp: 0.95,
    windCoupling: 0.3,
    lifetime: 18,
    altMin: 0.35,
    altMax: 2.4,
    slopeMinY: 0.45,
    fadeStart: 24,
    fadeEnd: 36,
    minPixels: 2.2,
  },
  fallingLeaves: {
    name: "Falling leaves",
    motion: MOTION.fall,
    tile: 1,                 // the photographic maple
    budget: 700,
    size: 0.13,
    sizeVar: 0.35,
    // A little tint, so a drift of leaves is not one photograph repeated.
    tint: 0.35,
    colorA: "#d89434",
    colorB: "#8a3d14",
    colorVar: 0.3,
    translucency: 0.35,
    speed: 1.4,          // terminal fall speed, m/s
    turbulence: 0.8,     // how wide the tumble swings
    flapRate: 1.4,       // tumbles per second
    // FLAT. The maple's midrib runs diagonally from its stem, so folding a
    // hinge across the painting looks wrong — and a falling leaf is nearly
    // flat anyway. It reads through its tumble, not through a fold.
    flapAmp: 0,
    windCoupling: 0.6,
    lifetime: 26,
    settleTime: 14,
    altMin: 3.0,         // born up in the canopy
    altMax: 11.0,
    slopeMinY: 0.3,
    fadeStart: 28,
    fadeEnd: 42,
    minPixels: 2.6,
  },
};

/**
 * The field as a whole. `effects` is a fixed-length array so a paint channel
 * and a uniform row block belong to a stable index.
 */
export function createAmbientFxState() {
  const presets = Object.entries(AMBIENT_PRESETS).map(([preset, p]) => ({ preset, ...p }));
  return {
    /** Nothing is built or dispatched while this is off. */
    enabled: false,

    /**
     * The camera-following box, metres. Particles that leave it die; the
     * distance fade is clamped inside it so nothing is ever visible at the
     * boundary (a hard edge of butterflies moving with you is the one thing
     * that gives a volume like this away).
     */
    volumeXZ: 80,
    volumeY: 34,
    /** How far ahead of the anchor the box sits, as a fraction of volumeXZ. */
    forwardOffset: 0.22,

    /**
     * Scalability tier, 0..1. Multiplies every effect's live slot count. No
     * reallocation — slots above the line simply never spawn — so it is free
     * to change per frame.
     */
    tier: 1,

    /** The world's wind, scaled per effect by windCoupling. */
    windMul: 1,

    effects: Array.from({ length: AMBIENT_EFFECT_COUNT }, (_, i) =>
      createAmbientEffect(presets[i] ?? { name: `Effect ${i + 1}`, enabled: false, budget: 0 })),
  };
}

/** Pool size. Every effect's budget is a slice of this; the sum may not exceed it. */
export const AMBIENT_MAX_PARTICLES = 8192;

/**
 * Slice starts and lengths from the effects' budgets, clamped so the sum fits
 * the pool. Pure — the field uploads the result, and tools/ambientFieldTest
 * checks it.
 *
 * An effect that is off or has no budget still gets a (zero-length) slice, so
 * every effect index keeps its uniform row block whatever else changed.
 *
 * @returns {{ starts: number[], lengths: number[], total: number }}
 */
export function sliceBudgets(effects, max = AMBIENT_MAX_PARTICLES) {
  const want = effects.map((e) => (e.enabled ? Math.max(0, Math.floor(e.budget)) : 0));
  const sum = want.reduce((a, b) => a + b, 0);
  // Over budget: scale everyone down proportionally rather than starving the last one.
  const scale = sum > max ? max / sum : 1;
  const lengths = want.map((w) => Math.floor(w * scale));
  const starts = [];
  let at = 0;
  for (const len of lengths) { starts.push(at); at += len; }
  return { starts, lengths, total: at };
}
