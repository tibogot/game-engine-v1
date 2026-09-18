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
export const MOTION = Object.freeze({ wander: 0, fall: 1, float: 2 });

/**
 * Atlas tiles — the index into AMBIENT_ART in ambientAtlas.js. Re-exported
 * from there so there is ONE list: adding art must not mean editing two files
 * that can then disagree about which tile is a butterfly.
 */
export { ART_TILE as TILE } from "../../render/ambient/ambientAtlas.js";

/** vec4 uniform rows per effect. Keep in step with pack() in ambientField.js. */
export const AMBIENT_ROWS = 10;

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
    /**
     * "card" or "billboard" — the only choice here that costs a draw call,
     * because the two live in different passes (see ambientFxSystem.js).
     * A card wears painted artwork and is alpha—tested; a billboard is a soft
     * additive blob of light and ignores `tile` entirely.
     */
    shape: "card",
    /** Index into AMBIENT_ART — which painted shape it wears (cards only). */
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
    /**
     * How far the card rolls to show its face to the camera, 0..1.
     *
     * A flat card seen edge-on is a one-pixel streak with no shape at all, and
     * a butterfly in level flight holds its wings horizontal — so from a
     * camera at the same height that is most of what you would see. 0 is pure
     * physics, 1 always shows the face and stops a leaf's tumble dead.
     * Somewhere in between is a lie that reads as the thing banking.
     */
    faceCamera: 0.55,
    /** How far the wind carries it, 0..1 of the world's wind. */
    windCoupling: 0.35,
    /** Seconds before it dies and respawns somewhere the rule allows. */
    lifetime: 16,
    /** Seconds a settled leaf lies on the ground before it fades (fall only). */
    settleTime: 12,

    /* -- Billboards only -- */
    /** Blinks per second, and how deep the blink goes (0 = a steady light). */
    pulseRate: 1.4,
    pulseAmount: 0,
    /** How bright the blob burns. Additive, so this really is its brightness. */
    glow: 1,

    /* ── Where it lives ── */
    /** Metres above the terrain at that point. */
    altMin: 0.4,
    altMax: 2.6,
    /** Terrain height band, metres. The full range means no limit. */
    heightMin: -1e5,
    heightMax: 1e5,
    /** Steeper than this (normal.y below it) and nothing spawns. */
    slopeMinY: 0.45,

    /**
     * "painted" — only where this effect is painted.
     * "everywhere" — anywhere its height and slope allow.
     *
     * A new effect starts everywhere so the mode shows something the moment
     * you open it; the FIRST brush stroke flips it to painted, because
     * painting an effect that ignores paint is the one genuinely confusing
     * state this could be in.
     */
    area: "everywhere",

    /**
     * The hours it is out, on a 24 h clock. The window WRAPS, so fireflies at
     * 19 → 5 is a normal thing to ask for, and start === end means always.
     *
     * It gates SPAWN, not opacity. An effect going out of season drains over
     * a lifetime or two instead of dimming — butterflies going home one by
     * one, which reads far better than the whole swarm fading together, and
     * costs nothing in the vertex stage.
     */
    dayStart: 0,
    dayEnd: 24,
    /** Hours of soft edge at each end of that window. */
    daySoft: 1.2,

    /* ── Culling (the budget you can trade) ── */
    /** Metres from the anchor where it starts thinning out, and where it is gone. */
    fadeStart: 26,
    fadeEnd: 38,
    /** Below this many pixels across, it is not drawn — it would only crawl. */
    minPixels: 2.2,
    /**
     * Never drawn SMALLER than this many pixels across: below it the card
     * grows in world space to hold the size.
     *
     * The other half of the same problem `minPixels` solves, and the more
     * important half here. A real butterfly is 8 cm, which at twenty metres
     * is four pixels — the painted wing is thrown away and what is left is a
     * speck. The birds in this repo have carried the same floor since they
     * were written; growing the thing is a lie about its distance that nobody
     * has ever been able to see. 0 turns it off, which is what something that
     * SHOULD vanish with distance (dust) wants.
     */
    pixelFloor: 0,

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
    // 500 in a 36 m radius is one butterfly per 8 square metres, which reads
    // as a plague rather than a meadow. Looked at and cut by 3.5x.
    budget: 150,
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
    faceCamera: 0.6,
    windCoupling: 0.3,
    lifetime: 18,
    altMin: 0.35,
    altMax: 2.4,
    slopeMinY: 0.45,
    dayStart: 7,          // out in the day, gone by dusk
    dayEnd: 19,
    daySoft: 1.5,
    fadeStart: 24,
    fadeEnd: 36,
    minPixels: 0,        // it grows instead of vanishing
    // 9 px was still a blob; at 14 the painted wing is actually legible,
    // which is the whole reason for using a painted wing.
    pixelFloor: 14,
  },
  fallingLeaves: {
    name: "Falling leaves",
    motion: MOTION.fall,
    tile: 1,                 // the photographic maple
    // Same cut, same reason: 700 falling at once inside 42 m was a blizzard.
    budget: 240,
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
    // Low: the tumble IS the leaf, and rolling it flat toward the camera
    // would trade the one motion that makes it read for a bigger silhouette.
    faceCamera: 0.2,
    windCoupling: 0.6,
    lifetime: 26,
    settleTime: 14,
    altMin: 3.0,         // born up in the canopy
    altMax: 11.0,
    slopeMinY: 0.3,
    fadeStart: 28,
    fadeEnd: 42,
    minPixels: 0,
    pixelFloor: 11,      // a leaf needs less than a wing, but not much less
  },
  dustMotes: {
    name: "Dust motes",
    enabled: false,        // opt-in: an existing world must not suddenly haze over
    shape: "billboard",
    motion: MOTION.float,
    budget: 900,
    size: 0.035,
    sizeVar: 0.55,
    colorA: "#fff2d4",
    colorB: "#ffd9a0",
    colorVar: 0.25,
    glow: 0.55,
    pulseAmount: 0,        // steady; dust does not blink
    speed: 0.12,           // barely steers itself - the wind moves it
    turbulence: 0.5,
    windCoupling: 0.9,
    lifetime: 22,
    altMin: 0.3,
    altMax: 6,
    slopeMinY: 0,          // dust hangs over a cliff face as readily as a lawn
    fadeStart: 9,
    fadeEnd: 20,           // close work: a mote further off is a sub-pixel speck
    minPixels: 1.6,
    pixelFloor: 0,         // dust SHOULD vanish with distance, not hold size
    faceCamera: 0,         // a billboard already faces you
  },
  fireflies: {
    name: "Fireflies",
    enabled: false,
    shape: "billboard",
    motion: MOTION.wander,
    budget: 400,
    size: 0.055,
    sizeVar: 0.3,
    colorA: "#d8ff7a",
    colorB: "#8fdd2e",
    colorVar: 0.2,
    glow: 2.2,             // they are the brightest thing in a night meadow
    pulseRate: 0.9,
    pulseAmount: 0.85,     // the blink IS the firefly
    speed: 0.5,
    turbulence: 0.5,
    flapRate: 0,           // nothing to flap
    flapAmp: 0,
    windCoupling: 0.15,
    lifetime: 20,
    altMin: 0.25,
    altMax: 1.8,
    slopeMinY: 0.4,
    dayStart: 19.5,        // out after dusk, gone before dawn
    dayEnd: 4.5,
    daySoft: 1.2,
    fadeStart: 18,
    fadeEnd: 34,
    minPixels: 0,
    pixelFloor: 3.5,       // a distant firefly is still a point of light
    faceCamera: 0,
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
 * The time-of-day window, normalised for the GPU.
 *
 * Pure, and tested, because the wrap is the part that is easy to get wrong:
 * a window from 19:00 to 05:00 is ten hours long, not minus fourteen, and
 * "always" has to be distinguishable from "a zero-length window" when both
 * arrive as start === end.
 *
 * @returns {{ s01:number, len01:number, soft01:number }}
 *   s01     window start, 0..1 of a day
 *   len01   its length, 0..1; 1 means ALWAYS (the shader special-cases it)
 *   soft01  soft edge at each end, never zero (smoothstep needs a width)
 */
export function dayWindow(start = 0, end = 24, softHours = 1) {
  const span = (((end - start) % 24) + 24) % 24;
  // start === end and a full 24 h both mean "always", and a zero-length
  // window is not a thing anybody wants to express.
  const always = end - start >= 24 || span === 0;
  const len01 = always ? 1 : span / 24;
  // The soft edge cannot eat more than half the window from each end, or the
  // ramps cross and the effect never reaches full strength.
  const soft01 = Math.max(0.002, Math.min(softHours / 24, len01 * 0.45));
  return { s01: ((start % 24) + 24) % 24 / 24, len01, soft01 };
}

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
