/**
 * LANCE LEAF — the alpha of one understory broadleaf: wild ginger (Alpinia),
 * heliconia, the whole mass of soft green stuff that fills a jungle floor
 * between the ferns.
 *
 * WHY THIS EXISTS. The bush and the ground cover were built with their leaves
 * as GEOMETRY — a three-segment polygon strip, five triangles a leaf, and the
 * outline of that strip was the outline of the leaf. That is why they read as
 * angular cardboard next to the ferns: a leaf silhouette has a curve, a taper
 * and a point, and three segments cannot make any of them. Every plant here
 * that came out well puts the SHAPE in an alpha texture and keeps the geometry
 * dumb — a card is two triangles against five, so this is cheaper as well as
 * better.
 *
 * DRAWN FROM PHOTOGRAPHS (Alpinia, Wikimedia Commons, 2026-09-23):
 *
 *   · LONG AND NARROW — about 5:1. The map's polygon leaves were nearly round,
 *     which is why the bush read as a cabbage.
 *   · THE WIDEST POINT IS PAST THE MIDDLE, at roughly 0.55 of the length, and
 *     the taper to the tip is longer and straighter than the taper to the
 *     stalk. That asymmetry is most of what makes it look like a leaf.
 *   · A DRIP TIP: the last tenth draws out into a fine point.
 *   · THE EDGE IS NOT CLEAN. A monsoon-forest leaf is split across the veins
 *     and nibbled at the margins. A few notches cost nothing and they break up
 *     the repeat when fifty of these fill the screen.
 *
 * TWO VARIANTS side by side in one texture: a whole leaf on the left half, a
 * torn one on the right. The geometry picks a half per leaf, so a clump is not
 * fifty copies of one silhouette.
 *
 * White on transparent, leaf pointing UP (v = 0 at the stalk); colour is the
 * shader's.
 */
export const LANCE_TEX_W = 512;
export const LANCE_TEX_H = 512;

function rng(seed) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

/** Half-width of the blade at `v` along its length, 0-1 of the max. */
function widthAt(v) {
  if (v <= 0) return 0;
  // Rises fast out of the stalk, widest at 0.55, then a long straight taper
  // into the drip tip.
  const rise = Math.pow(Math.min(1, v / 0.55), 0.45);
  const fall = v <= 0.55 ? 1 : Math.pow(1 - (v - 0.55) / 0.45, 0.85);
  return rise * fall;
}

/** One blade into the given half of the canvas. */
function drawBlade(ctx, cx, W, H, o) {
  const rand = rng(o.seed);
  // 4.3:1 over the blade's length. The first pass was 2.3:1 and the bush read
  // as a cabbage — the same "do the sum" error as everywhere else.
  const halfW = W * 0.5 * 0.22;
  const bottom = H * 0.985, top = H * 0.03;
  const len = bottom - top;
  const torn = o.torn;
  const steps = 72;

  // A slight S-curve down the midrib, so the leaf is not a symmetrical blade.
  const bend = (v) => Math.sin(v * 2.2) * W * 0.035 * o.bend;

  const edge = (side) => {
    const pts = [];
    for (let i = 0; i <= steps; i++) {
      const v = i / steps;
      let w = widthAt(v) * halfW;
      // Torn: bite chunks out of one edge at a few heights, as a wind-split
      // monsoon leaf is cut back to the midrib.
      if (torn) {
        const t1 = Math.abs(v - 0.34), t2 = Math.abs(v - 0.62), t3 = Math.abs(v - 0.8);
        // Split back toward the midrib, not bitten out of it: shallow and
        // narrow. Deep rectangular notches read as damage, not as a leaf.
        if (t1 < 0.028 && side > 0) w *= 0.5;
        if (t2 < 0.024 && side < 0) w *= 0.56;
        if (t3 < 0.02 && side > 0) w *= 0.62;
      }
      // Nibbled margin.
      // Low frequency ON PURPOSE. At 37 over 42 steps this was sampled at
      // barely above its own rate and aliased into big scallops down the edge
      // — the outline looked chewed rather than nibbled.
      w *= 1 - Math.abs(Math.sin(v * 9 + o.seed)) * 0.035;
      pts.push([cx + bend(v) + side * w, bottom - len * v]);
    }
    return pts;
  };

  const right = edge(1), left = edge(-1).reverse();
  ctx.beginPath();
  ctx.moveTo(right[0][0], right[0][1]);
  for (const p of right) ctx.lineTo(p[0], p[1]);
  for (const p of left) ctx.lineTo(p[0], p[1]);
  ctx.closePath();
  ctx.fill();

  // The stalk: short, thick, and it is what the card is hung from.
  ctx.strokeStyle = "rgba(255,255,255,1)";
  ctx.lineCap = "round";
  ctx.lineWidth = W * 0.016;
  ctx.beginPath();
  ctx.moveTo(cx, H);
  ctx.lineTo(cx + bend(0.02), bottom - len * 0.02);
  ctx.stroke();
}

export function drawLanceLeafTexture(canvas, o = {}) {
  const W = canvas.width, H = canvas.height;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "rgba(255,255,255,1)";
  // Left half: whole. Right half: torn.
  drawBlade(ctx, W * 0.25, W, H, { seed: o.seed ?? 913, torn: false, bend: 1 });
  drawBlade(ctx, W * 0.75, W, H, { seed: (o.seed ?? 913) + 37, torn: true, bend: -0.7 });
}
