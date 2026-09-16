/**
 * Noise for the waterfall shaders, PERIODIC ALONG Y.
 *
 * Both sheets scroll a pattern along the fall for ever, and the shader clock has
 * to wrap before float precision runs out. A wrap would jump the whole pattern
 * unless the noise repeats exactly over it, so every lattice cell index along y
 * is taken modulo a whole number of cells:
 *
 *   - the realistic sheet keys its pattern on the moment the water left the lip
 *     (`time − flightTime`) and scales y so one wrap is `n` cells
 *     (`periodicCells`, `vnoiseY`);
 *   - the stylized sheet scrolls in the old waterfall's own lattice units, where
 *     one wrap is `SCROLL_PERIOD` cells (`gnoiseY`, `voroFbmScroll`).
 *
 * An octave that scales y by s repeats over s times as many cells, so each one
 * passes its own `n` (see `voroFbmScroll`). Inputs must keep y >= 0 (WGSL `%`
 * keeps the sign of the dividend); callers add whole periods to be safe.
 */
import { Fn, float, vec2, dot, floor, fract, sin, cos, mix, min, length, mod, smoothstep, pow } from "three/tsl";

/** Seconds after which the realistic sheet's clock wraps. */
export const WRAP_PERIOD = 64;
/** Lattice units after which the stylized sheet's scroll wraps. */
export const SCROLL_PERIOD = 64;

/** Whole cells per wrap period for a pattern of `ratePerSecond`, at least 1. */
export function periodicCells(ratePerSecond) {
  return Math.max(1, Math.round(ratePerSecond * WRAP_PERIOD));
}

const hash = /*#__PURE__*/ Fn(([x, y]) => fract(sin(dot(vec2(x, y), vec2(127.1, 311.7))).mul(43758.5453)));
const hashB = /*#__PURE__*/ Fn(([x, y]) => fract(sin(dot(vec2(x, y), vec2(269.5, 183.3))).mul(43758.5453)));

/** Value noise, 0..1, period `n` along y. */
export const vnoiseY = /*#__PURE__*/ Fn(([p, n]) => {
  const i = floor(p).toVar();
  const f = fract(p);
  const u = f.mul(f).mul(float(3).sub(f.mul(2)));
  const y0 = mod(i.y, n), y1 = mod(i.y.add(1), n);
  const a = hash(i.x, y0), b = hash(i.x.add(1), y0);
  const c = hash(i.x, y1), d = hash(i.x.add(1), y1);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
});

/** Gradient noise, 0..1, period `n` along y (the old shader's `_wfGradientNoise`). */
export const gnoiseN = /*#__PURE__*/ Fn(([p, n]) => {
  const i = floor(p).toVar();
  const f = fract(p).toVar();
  const u = f.mul(f).mul(f).mul(f.mul(f.mul(6).sub(15)).add(10));
  const g = (ix, iy) => {
    const a = hash(ix, mod(iy, n)).mul(Math.PI * 2);
    return vec2(cos(a), sin(a));
  };
  return mix(
    mix(dot(g(i.x, i.y), f), dot(g(i.x.add(1), i.y), f.sub(vec2(1, 0))), u.x),
    mix(dot(g(i.x, i.y.add(1)), f.sub(vec2(0, 1))), dot(g(i.x.add(1), i.y.add(1)), f.sub(vec2(1, 1))), u.x),
    u.y,
  ).mul(0.5).add(0.5);
});

/** Gradient noise on the stylized sheet's scroll lattice. */
export const gnoiseY = /*#__PURE__*/ Fn(([p]) => gnoiseN(p, float(SCROLL_PERIOD)));

/** Cell noise F1 (distance to the nearest jittered point), period `n` along y. */
export const voroY = /*#__PURE__*/ Fn(([p, jitter, n]) => {
  const ip = floor(p).toVar();
  const fp = fract(p).toVar();
  const md = float(10).toVar();
  for (const [ox, oy] of [[-1, -1], [0, -1], [1, -1], [-1, 0], [0, 0], [1, 0], [-1, 1], [0, 1], [1, 1]]) {
    const cx = ip.x.add(ox), cy = mod(ip.y.add(oy), n);
    const h = vec2(hash(cx, cy), hashB(cx, cy));
    md.assign(min(md, length(vec2(ox, oy).add(mix(vec2(0.5), h, jitter)).sub(fp))));
  }
  return md;
});

/**
 * The old waterfall's `_wfVoroLayer`: a gradient-noise domain warp, then its
 * three-octave cell FBM (gain 0.41), raised to `contrast`. Lacunarity is 2.35
 * across and 2 along, so every octave's period along y stays a whole number of
 * cells; the old shader's 2.35 on both axes cannot wrap.
 */
export const voroFbmScroll = /*#__PURE__*/ Fn(([pIn, jitter, warpStr, warpScale, contrast]) => {
  const p = pIn.toVar();
  // Warped across only: warping y by a fraction of a cell would break the period.
  const w = vec2(
    gnoiseN(p.mul(vec2(warpScale, 1)), float(SCROLL_PERIOD)).sub(0.5),
    gnoiseN(p.mul(vec2(warpScale, 1)).add(vec2(3.7, 0)), float(SCROLL_PERIOD)).sub(0.5),
  );
  p.addAssign(w.mul(warpStr));
  const n = float(SCROLL_PERIOD);
  const v = voroY(p, jitter, n)
    .add(voroY(p.mul(vec2(2.35, 2)), jitter, n.mul(2)).mul(0.41))
    .add(voroY(p.mul(vec2(5.52, 4)), jitter, n.mul(4)).mul(0.168));
  return pow(v.div(1.578), contrast);
});

/** The old shader's `_wfBandMask`: a noise-wobbled band between `low` and `high`. */
export const bandMask = /*#__PURE__*/ Fn(([y, low, high, n, noiseAmt, sharpness]) => {
  const nLow = low.add(n.sub(0.5).mul(noiseAmt.mul(2)));
  const nHigh = high.add(n.sub(0.5).mul(noiseAmt.mul(2)));
  return smoothstep(nLow.sub(sharpness), nLow.add(sharpness), y)
    .mul(smoothstep(nHigh.add(sharpness), nHigh.sub(sharpness), y));
});
