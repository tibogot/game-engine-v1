// ── THE FACADE'S WINDOW GRID, ON THE CPU ─────────────────────────────────────
//
// The facade shader (modularRoadCityFacade.js) lays every window out per
// pixel: a per-lot hash picks the bay pitch, the pier width and the floor
// height, and the face's own size decides how many bays and floors fit. Nothing
// on the CPU ever knew where a window was — which is fine until something has
// to be BOLTED TO ONE. An air-conditioning unit in a window, a balcony under
// it, a fire escape across a row of them: all of that needs the same answer
// the shader gives, to the centimetre, or it hangs beside the window instead
// of in it.
//
// So this is that arithmetic, transcribed. The same integer hash (three's PCG,
// ported bit for bit), the same seven-plus dice, the same layout formulas,
// evaluated in float32 where the shader does so the two cannot disagree in a
// threshold. tools/facadeLayoutTest.mjs reads the shader's SOURCE and checks
// that the dice multipliers and the hash constants here are the ones it uses,
// so the day someone edits one side and not the other, the test fails rather
// than the AC units drifting off their sills.
//
// It does NOT know anything per pixel: arches, glazing bars, blinds and the
// like are paint, and paint does not move a window. It knows where the
// OPENING is — bay, floor, sill, head — on every face of every tier.

import { FACADE_DEFAULTS, BUILDING_TYPE, DISTRICT } from "./modularRoadCityFacade.js";

const f32 = Math.fround;
/** `fract(h1 * k)` in the shader — the same constants, in the same order. */
export const DICE = [197.31, 419.77, 733.19, 1279.53, 2411.87, 3571.13, 5153.71, 7307.17, 9173.29, 11311.7];
/** The shader's `qi`: quantise to 1/256 and offset into a safe uint range. */
const QI_SCALE = 256.0, QI_OFFSET = 1 << 22;
/** The shader's `ih2` multipliers. */
const IH_A = 73856093, IH_B = 19349663;

/**
 * three's TSL `hash()` — PCG, from shadertoy XlGcRh — for a uint32 seed.
 * Every multiply wraps at 2^32 and every shift is logical, as in WGSL.
 */
export function pcgHash(seed) {
  const state = (Math.imul(seed >>> 0, 747796405) + 2891336453) >>> 0;
  const shift = ((state >>> 28) + 4) >>> 0;
  const word = Math.imul(((state >>> shift) ^ state) >>> 0, 277803737) >>> 0;
  const result = ((word >>> 22) ^ word) >>> 0;
  // `result.toFloat().mul(1 / 2 ** 32)`: a float32 of a 32-bit integer keeps
  // 24 bits, and the shader's value is that, not the double.
  return f32(f32(result) * f32(1 / 2 ** 32));
}

const qi = (v) => (Math.floor(v * QI_SCALE) + QI_OFFSET) >>> 0;
/** The shader's `hash21`: 0..1 from two floats (lot cells, floor indices). */
export function hash21(x, y) {
  const a = qi(x), b = qi(y);
  return pcgHash(((Math.imul(a, IH_A) >>> 0) ^ (Math.imul(b, IH_B) >>> 0)) >>> 0);
}

/**
 * The per-lot dice, h1..h11, for a world position. `h1` is the hash of the
 * lot cell; the rest are `fract(h1 * k)`, evaluated in float32 as the GPU
 * does, so a value that sits near a 0.5 threshold lands on the same side.
 */
export function lotDice(x, z, lotSize) {
  const lx = Math.floor(x / lotSize), lz = Math.floor(z / lotSize);
  const h1 = hash21(lx, lz);
  const d = [h1];
  for (const k of DICE) {
    const m = f32(h1 * f32(k));
    d.push(f32(m - Math.floor(m)));
  }
  return { lot: [lx, lz], h1, h2: d[1], h3: d[2], h4: d[3], h5: d[4], h6: d[5], h7: d[6], h8: d[7], h9: d[8], h10: d[9], h11: d[10] };
}

/** The shader's `spread`: centre ± s, driven by a 0..1 dice. */
const spread = (c, s, h) => c + (h - 0.5) * 2 * s;
const roundHalfAwayLikeGpu = (v) => Math.round(v);

/**
 * Lay out one FACE of one TIER: the same result the shader's `buildFrame`
 * reaches for every pixel on it.
 *
 * @param {object} o
 * @param {object} o.P            facade params (FACADE_DEFAULTS plus overrides)
 * @param {object} o.dice         from `lotDice`
 * @param {number} o.btype        BUILDING_TYPE of the building
 * @param {number} o.district     DISTRICT of the building
 * @param {number} o.W            face width in world metres (the box's aFace.x)
 * @param {number} o.Hf           tier height in world metres (scaleY applied)
 * @param {boolean} o.groundTier  is this the tier standing on the ground
 */
export function faceLayout({ P, dice, btype, district, W, Hf, groundTier }) {
  const isCurtain = btype === BUILDING_TYPE.curtain;
  const isRibbon = btype === BUILDING_TYPE.ribbon;
  const isPunched = !isCurtain && !isRibbon;
  const isIndustrial = district === DISTRICT.industrial;
  const { h1, h2, h3, h4, h5, h7 } = dice;

  const bay0 = isCurtain ? P.curtainBay : isRibbon ? P.ribbonBay : spread(P.bayWidth, P.baySpread, h4);
  const pierW = Math.max(isCurtain ? P.curtainMullion : isRibbon ? P.ribbonMullion
    : spread(P.pierWidth, P.pierSpread, h5), 0.02);
  const winRatio = isCurtain ? P.curtainWinRatio : isRibbon ? P.ribbonWinRatio
    : (isIndustrial ? P.windowRatio * 0.72 : P.windowRatio);
  const border = isPunched ? P.frameBorder : 0.015;
  const floorH0 = Math.max(spread(P.floorHeight, P.floorSpread, h1), 2.6);

  const flat = W < pierW * 2 + bay0 * 0.6 || Hf < 2.5;
  const count = Math.max(Math.floor((W - pierW) / bay0), 1);
  const bayS = (W - pierW) / count;
  const bay = bay0 + (bayS - bay0) * (P.bayFit ?? 0);
  const slack = Math.max(W - count * bay, pierW);
  const ph = Math.min(1, Math.max(0, 0.5 + (h7 - 0.5) * (P.bayPhase ?? 0)));
  const uOrigin = pierW * 0.5 + (slack - pierW) * ph;
  const nF = Math.max(roundHalfAwayLikeGpu(Hf / floorH0), 1);
  const fh = Hf / nF;
  const winH = fh * winRatio;
  const slotL = pierW * 0.5, slotR = bay - pierW * 0.5;
  const oL = slotL + border, oR = Math.max(slotR - border, slotL + border + 0.05);
  const oB = (fh - winH) * 0.5, oT = (fh + winH) * 0.5;
  const nBase = h4 > 0.5 ? 3 : 2;
  const hasBase = isPunched && groundTier && nF > nBase + 1.5 && !flat;
  const courseEvery = isPunched && h3 < P.courseChance ? Math.floor(h2 * 5.99) + 3 : 0;

  return {
    isPunched, isCurtain, isRibbon, isIndustrial, flat,
    bay, count, uOrigin, nF, fh, winH, slotL, slotR, oL, oR, oB, oT,
    pierW, nBase, hasBase, courseEvery,
  };
}

/**
 * Every window OPENING on a face, in face coordinates: `u` across from the
 * face's u = 0 end, `sill`/`head` up from the tier's bottom, plus the bay and
 * floor index. Base-colonnade floors are not windows and are left out; the
 * ground floor of the ground tier is the shopfront and is left out too.
 */
export function windowsOf(L, { groundTier = false } = {}) {
  const out = [];
  if (L.flat) return out;
  const uc = (L.oL + L.oR) * 0.5 - L.slotL;
  for (let fi = 0; fi < L.nF; fi++) {
    if (L.hasBase && fi < L.nBase) continue;
    if (groundTier && fi === 0) continue;
    for (let bi = 0; bi < L.count; bi++) {
      out.push({
        bi, fi,
        u: L.uOrigin + bi * L.bay + uc,
        w: L.oR - L.oL,
        sill: fi * L.fh + L.oB,
        head: fi * L.fh + L.oT,
        floorY: fi * L.fh,
      });
    }
  }
  return out;
}

/**
 * The four faces of an axis-aligned tier, each with its width and how face
 * coordinates map to world: `origin` is the world point at u = 0 on the face
 * plane, `along` the unit vector u runs along (the shader's `uAxis`), `n` the
 * outward normal. Matches `u0 = ... .mul(W)` in the shader: u increases along
 * `cross(up, n)`.
 */
export function tierFaces(cx, cz, tier) {
  const faces = [];
  for (const [nx, nz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const W = nx !== 0 ? tier.d : tier.w;
    const half = nx !== 0 ? tier.w * 0.5 : tier.d * 0.5;
    const ax = nz, az = -nx;                        // uAxis = (n.z, 0, -n.x)
    faces.push({
      n: [nx, nz], W, along: [ax, az],
      // u = 0 is at the −along end: centre + n·half − along·W/2.
      origin: [cx + nx * half - ax * W * 0.5, cz + nz * half - az * W * 0.5],
    });
  }
  return faces;
}

export { FACADE_DEFAULTS };
