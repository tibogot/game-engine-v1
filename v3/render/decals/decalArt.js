/**
 * PROCEDURAL DECAL ART — ground wear drawn in code, not painted by hand.
 *
 * Every decal here is a 512² RGBA canvas returned as a data URL, which is what
 * a decal slot takes (see decalTextures.js) and what a project already stores
 * for its imported ones. Generating them means a level can be given a hundred
 * kinds of wear without a hundred PNGs, and every one is a parameter away from
 * being different.
 *
 * ── WHAT MAKES A GROUND DECAL READ, AND WHAT MAKES IT LOOK LIKE A STICKER ───
 *
 * Three rules, learned the hard way and obeyed by everything below:
 *
 *   1. THE EDGE MUST NOT EXIST. Any decal whose alpha reaches its boundary
 *      draws a visible rectangle the moment two of them overlap. Every mask
 *      here is multiplied by a border falloff, so alpha is exactly zero all the
 *      way round.
 *
 *   2. THE MASK IS NOISE, NOT A GRADIENT. A radial gradient reads as an
 *      airbrushed blob from any distance. Breaking the same shape with fBm
 *      turns it into dirt, and costs one multiply.
 *
 *   3. LOW CONTRAST. This is wear, not paint. A decal that is much darker than
 *      the ground it sits on reads as a hole; these sit within a stop or two
 *      of the terrain and let `opacity` do the rest per instance.
 *
 * Deterministic: same `seed`, same image, so a project that stores the data URL
 * and a regeneration from code agree.
 */

/** Everything is authored at this size; DECAL_LAYER_SIZE resamples if it differs. */
export const ART_SIZE = 512;

/** Small, fast, and good enough for a mask. */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Value noise on a lattice.
 *
 * `Math.imul` and not `*` in the hash: plain multiplication of two large ints
 * loses the low bits to float precision, and the noise comes out one-sided —
 * it never crosses 0.5, so every mask built on it is either all-on or all-off.
 */
export function makeValueNoise(seed) {
  const h = (x, y) => {
    let n = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(seed, 1274126177);
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  };
  const smooth = (t) => t * t * (3 - 2 * t);
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = smooth(x - xi), yf = smooth(y - yi);
    const a = h(xi, yi), b = h(xi + 1, yi), c = h(xi, yi + 1), d = h(xi + 1, yi + 1);
    return (a * (1 - xf) + b * xf) * (1 - yf) + (c * (1 - xf) + d * xf) * yf;
  };
}

/** Octaves of the above, 0..1. */
export function fbm(noise, x, y, octaves = 4, gain = 0.5, lac = 2) {
  let v = 0, amp = 0.5, norm = 0, f = 1;
  for (let i = 0; i < octaves; i++) {
    v += noise(x * f, y * f) * amp;
    norm += amp; amp *= gain; f *= lac;
  }
  return v / norm;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (a, b, t) => {
  const x = clamp01((t - a) / (b - a || 1e-6));
  return x * x * (3 - 2 * x);
};

/**
 * The border falloff that rule 1 demands: 1 in the middle, 0 at every edge.
 * `power` above 1 keeps more of the middle and dies faster at the rim.
 */
function borderFade(u, v, power = 1) {
  const d = Math.min(u, 1 - u, v, 1 - v) * 2;      // 0 at the edge, 1 at centre-ish
  return Math.pow(smoothstep(0, 0.42, d), power);
}

function canvas(size) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  return c;
}

/**
 * Shared plumbing: walk every pixel, call `shade(u, v, noise, rng)` and expect
 * `[r, g, b, a]` in 0..1. Keeps each recipe below to its own idea.
 */
function paint(size, seed, shade) {
  const c = canvas(size);
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(size, size);
  const d = img.data;
  const noise = makeValueNoise(seed);
  const rng = mulberry32(seed);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size, v = (y + 0.5) / size;
      const [r, g, b, a] = shade(u, v, noise, rng);
      const i = (y * size + x) * 4;
      d[i] = clamp01(r) * 255; d[i + 1] = clamp01(g) * 255;
      d[i + 2] = clamp01(b) * 255; d[i + 3] = clamp01(a) * 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c.toDataURL("image/png");
}

/* ── THE RECIPES ─────────────────────────────────────────────────────────── */

/**
 * FOOT PATH — a worn dirt band running top to bottom, to be laid end to end
 * along a route.
 *
 * The band WANDERS: a perfectly straight strip reads as a painted line, and
 * two laid end to end read as a road marking. One low-frequency noise term
 * displaces the centreline by a few percent of the width, which is enough.
 * It is also worn hardest in the MIDDLE and frays at both sides, because that
 * is where feet actually fall.
 */
export function footPath({ size = ART_SIZE, seed = 1, width = 0.34 } = {}) {
  return paint(size, seed, (u, v, noise) => {
    const wander = (fbm(noise, v * 2.2, 7.3, 3) - 0.5) * 0.16;
    const d = Math.abs(u - 0.5 - wander) / (width * 0.5);
    let a = 1 - smoothstep(0.45, 1.0, d);
    a *= 0.55 + 0.45 * fbm(noise, u * 9, v * 9, 4);          // broken, not solid
    a *= borderFade(u, v, 0.6);
    // Bare earth, a touch warmer and darker than the ground it replaces.
    const dirt = 0.40 + 0.16 * fbm(noise, u * 16, v * 16, 3);
    return [dirt * 0.95, dirt * 0.80, dirt * 0.60, a * 0.9];
  });
}

/**
 * DIRT APRON — compacted bare earth, for under a structure.
 *
 * Roughly round but deliberately lopsided (two offset lobes), because a circle
 * under a rectangular building is the most obvious "decal" shape there is.
 */
export function dirtApron({ size = ART_SIZE, seed = 2 } = {}) {
  return paint(size, seed, (u, v, noise) => {
    const cx = u - 0.5, cy = v - 0.5;
    const r = Math.hypot(cx, cy) * 2;
    const lop = 1 + 0.22 * Math.cos(Math.atan2(cy, cx) * 2 + 1.1)
      + 0.30 * (fbm(noise, u * 3.1, v * 3.1, 3) - 0.5);
    let a = 1 - smoothstep(0.45, 0.95, r / lop);
    a *= 0.6 + 0.4 * fbm(noise, u * 11, v * 11, 4);
    a *= borderFade(u, v, 0.7);
    const dirt = 0.38 + 0.18 * fbm(noise, u * 20, v * 20, 3);
    return [dirt, dirt * 0.84, dirt * 0.66, a];
  });
}

/**
 * PUDDLE — standing water on a monsoon map.
 *
 * The one decal here that is not dirt, and the only one whose POINT is the
 * material rather than the colour: placed with a low `roughness` it catches
 * the sky and the sun where the ground around it does not. The dark ring at
 * its edge is wet earth, which is what actually sells it — a puddle with a
 * clean rim reads as a hole in the ground.
 */
export function puddle({ size = ART_SIZE, seed = 3 } = {}) {
  return paint(size, seed, (u, v, noise) => {
    const cx = u - 0.5, cy = v - 0.5;
    const r = Math.hypot(cx, cy) * 2;
    const wob = 1 + 0.34 * (fbm(noise, u * 2.6, v * 2.6, 3) - 0.5)
      + 0.14 * Math.sin(Math.atan2(cy, cx) * 3);
    const edge = r / wob;
    const water = 1 - smoothstep(0.50, 0.72, edge);
    // A WIDE band of wet earth, and it is the important half. The first
    // version had a narrow rim and a near-black pool, and read as a hole
    // someone had dug: what tells the eye "water" is the damp ground spreading
    // out around it, not the pool.
    const damp = 1 - smoothstep(0.62, 1.02, edge);
    let a = Math.max(water, damp * 0.7);
    a *= 0.8 + 0.2 * fbm(noise, u * 10, v * 10, 3);
    a *= borderFade(u, v, 0.8);
    // Not black. Standing water on a bright day is a mid slate that the sky
    // lights; its darkness comes from the low roughness it is placed with.
    const shimmer = 0.06 * (fbm(noise, u * 7, v * 7, 3) - 0.5);
    const t = water;
    const rr = (0.27 + shimmer) * t + 0.30 * (1 - t);
    const gg = (0.31 + shimmer) * t + 0.25 * (1 - t);
    const bb = (0.35 + shimmer) * t + 0.19 * (1 - t);
    return [rr, gg, bb, a];
  });
}

/**
 * TRACK MARKS — a tracked vehicle, not a wheeled one.
 *
 * Two bands with RUNGS across them. The rungs are the whole difference: wheel
 * ruts are two smooth lines, and at this camera a tank track only reads as a
 * tank track because of the ladder.
 */
export function trackMarks({ size = ART_SIZE, seed = 4, gauge = 0.40, beltWidth = 0.21 } = {}) {
  return paint(size, seed, (u, v, noise) => {
    const wander = (fbm(noise, v * 1.8, 3.1, 2) - 0.5) * 0.06;
    const c = u - 0.5 - wander;
    const dL = Math.abs(c + gauge * 0.5), dR = Math.abs(c - gauge * 0.5);
    const belt = Math.min(dL, dR) / (beltWidth * 0.5);
    let a = 1 - smoothstep(0.55, 1.0, belt);
    // The rungs: a hard-ish sawtooth along the direction of travel.
    const rung = Math.abs(((v * 34) % 1) - 0.5) * 2;
    a *= 0.45 + 0.55 * smoothstep(0.15, 0.6, rung);
    a *= 0.65 + 0.35 * fbm(noise, u * 13, v * 13, 3);
    a *= borderFade(u, v, 0.6);
    const dirt = 0.33 + 0.16 * fbm(noise, u * 18, v * 18, 3);
    return [dirt, dirt * 0.88, dirt * 0.72, a * 0.95];
  });
}

/**
 * DEBRIS RAYS — what a crater throws out, to lay UNDER a crater decal.
 *
 * A crater on its own is a dark circle and reads as a hole someone dug. The
 * rays are what make it read as something that happened: spokes of thrown
 * earth, longest on one side because a shell arrives at an angle.
 */
export function debrisRays({ size = ART_SIZE, seed = 5, rays = 26 } = {}) {
  return paint(size, seed, (u, v, noise) => {
    const cx = u - 0.5, cy = v - 0.5;
    const r = Math.hypot(cx, cy) * 2;
    const th = Math.atan2(cy, cx);

    // EACH RAY GETS ITS OWN LENGTH, from a hash of its index.
    //
    // The first version modulated the reach with a sinusoid of the angle,
    // which gives every spoke the same length and the same spacing — it came
    // out as a child's drawing of a sun. Irregularity is the entire subject
    // here, so it has to come from a hash per ray, not from a wave.
    const s = ((th / (Math.PI * 2)) + 1) * rays;
    const i = Math.floor(s), f = s - i;
    const hash = (n) => noise(n * 17.3 + 0.5, n * 5.1 + 11.5);
    const len = 0.34 + 0.60 * Math.pow(hash(i), 0.85);
    // Narrow wedge, so they read as thrown streaks rather than petals.
    const across = Math.abs(f - 0.5) * 2;
    const wedge = 1 - smoothstep(0.20, 0.85, across);
    // One side favoured, but only a little: a shell arrives at an angle, it
    // does not throw earth in one direction only. The first correction of the
    // sun problem swung to 0.55 + 0.45cos, which starved the far side to a
    // tenth and left a one-sided spray.
    const bias = 0.78 + 0.22 * Math.cos(th - 0.9);
    const reach = len * bias;

    let a = wedge * (1 - smoothstep(reach * 0.35, reach, r)) * smoothstep(0.08, 0.22, r);
    a *= 0.45 + 0.55 * fbm(noise, u * 18, v * 18, 4);
    a *= borderFade(u, v, 0.9);
    const dirt = 0.30 + 0.16 * fbm(noise, u * 22, v * 22, 3);
    return [dirt, dirt * 0.82, dirt * 0.62, a * 0.75];
  });
}

/** Everything above, by name — what a level asks for. */
export const DECAL_ART = { footPath, dirtApron, puddle, trackMarks, debrisRays };

/**
 * Build slot definitions for a set of kinds.
 * @returns {{name:string, albedoUrl:string, normalUrl:null}[]}
 */
export function buildArtSlots(kinds, opts = {}) {
  return kinds.map((k, i) => {
    const fn = DECAL_ART[k];
    if (!fn) throw new Error(`no decal art named "${k}"`);
    return { name: k, albedoUrl: fn({ seed: i + 1, ...(opts[k] ?? {}) }), normalUrl: null };
  });
}
