/**
 * Broad-leaf card textures — HALF a leaf each, midrib on u = 0, blade to the
 * right, petiole bare at the bottom. White on a tall canvas, used as the
 * ALPHA of a half-card pair (palmGeometry addFrondCards). Same contract as
 * the palm and fern fronds; different outlines.
 *
 *   banana  a paddle: parallel-veined, and TORN — the wind splits a banana
 *           leaf into strips along its veins, perpendicular to the midrib,
 *           and a banana that is not torn reads as plastic. Tears are cut out
 *           of the alpha with destination-out, deeper and more frequent toward
 *           the tip and the outer edge.
 *   taro    (Colocasia, "elephant ear"): a broad heart — widest near the base
 *           where the two lobes flare, then a long taper to a drip tip. Whole,
 *           no tears; a taro leaf is thick and waxy.
 */
export const BROADLEAF_TEX_W = 256;
export const BROADLEAF_TEX_H = 1024;

function rng(seed) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

/**
 * SHADE a drawn half-leaf in place: keep every texel's alpha, write a grey
 * `shadeAt(u, v)` (0..1, u = 0 at the midrib, v = 0 at the petiole) into its
 * colour. The foliage shader multiplies that grey into the leaf's colour
 * (alphaCoverageMips `shade`), so a leaf has a lit and a shaded side, a pale
 * rib and veins, instead of one flat green (your screenshot, 2026-09-24).
 */
export function shadeHalfLeaf(ctx, W, H, shadeAt) {
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;
  for (let y = 0; y < H; y++) {
    const v = 1 - y / H;
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (d[i + 3] === 0) continue;
      const g = Math.round(Math.max(0, Math.min(1, shadeAt(x / W, v, x, y))) * 255);
      d[i] = d[i + 1] = d[i + 2] = g;
    }
  }
  ctx.putImageData(img, 0, 0);
}

/** A smooth 1-D value noise, deterministic: tone bands along a leaf. */
function bandNoise(seed) {
  const r = rng(seed);
  const vals = Array.from({ length: 257 }, () => r());
  return (t) => {
    const f = ((t % 256) + 256) % 256, i = Math.floor(f), k = f - i;
    const s = k * k * (3 - 2 * k);
    return vals[i] * (1 - s) + vals[i + 1] * s;
  };
}

/** The half-outline as a polygon: half-width (0..1 of W) at each v. */
function fillHalfBlade(ctx, W, H, widthAt, { bare, midribW = 7, steps = 60 }) {
  ctx.fillStyle = "rgba(255,255,255,1)";
  ctx.beginPath();
  ctx.moveTo(0, H);
  for (let i = 0; i <= steps; i++) {
    const v = i / steps;
    const w = v < bare ? 0 : widthAt(v);
    ctx.lineTo(W * w, H * (1 - v));
  }
  ctx.lineTo(0, 0);
  ctx.closePath();
  ctx.fill();
  // Midrib / petiole: a strip up the left edge, thick at the petiole.
  ctx.strokeStyle = "rgba(255,255,255,1)";
  ctx.lineCap = "round";
  for (let i = 0; i < 10; i++) {
    const v0 = i / 10, v1 = (i + 1) / 10;
    ctx.lineWidth = midribW * (1.4 - v0 * 0.9);
    ctx.beginPath(); ctx.moveTo(4, H * (1 - v0)); ctx.lineTo(4, H * (1 - v1)); ctx.stroke();
  }
}

export function drawBananaLeafTexture(canvas, o = {}) {
  const rand = rng(2711);
  const W = BROADLEAF_TEX_W, H = BROADLEAF_TEX_H;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, W, H);
  const bare = o.bare ?? 0.2;
  // A paddle: opens fast out of the petiole, holds nearly full width, rounds
  // off to a blunt tip.
  const widthAt = (v) => {
    const s = (v - bare) / (1 - bare);
    const open = Math.min(1, s / 0.18);
    const tip = s > 0.8 ? Math.sqrt(Math.max(0, 1 - Math.pow((s - 0.8) / 0.2, 2))) : 1;
    return 0.96 * Math.pow(open, 0.7) * tip;
  };
  fillHalfBlade(ctx, W, H, widthAt, { bare, midribW: 9 });

  // Tears: thin wedges cut in from the outer edge toward the midrib, along
  // the veins (perpendicular to the midrib). More of them, and deeper, toward
  // the tip; a few reach almost to the midrib and split the leaf.
  ctx.globalCompositeOperation = "destination-out";
  ctx.fillStyle = "rgba(0,0,0,1)";
  // 26, not 14. The plantation photographs are a wall of leaves SHREDDED into
  // ribbons — a banana leaf in the open lasts weeks before the wind has cut it
  // to the midrib, and an untorn one reads as plastic from any distance.
  const tears = o.tears ?? 26;
  for (let k = 0; k < tears; k++) {
    const v = bare + 0.1 + Math.pow(rand(), 0.7) * (0.9 - bare - 0.1);
    const w = widthAt(v);
    if (w < 0.2) continue;
    const depth = w * (0.3 + Math.pow(rand(), 1.3) * 0.68);
    const gap = 2 + rand() * 7;                       // width of the split, px
    const y = H * (1 - v);
    const x1 = W * w + 4, x0 = W * (w - depth);
    // Veins run a touch toward the tip: the tear leans by a few px.
    const lean = (rand() - 0.5) * 12;
    ctx.beginPath();
    ctx.moveTo(x1, y - gap * 0.5);
    ctx.lineTo(x0, y - gap * 0.15 + lean);
    ctx.lineTo(x0, y + gap * 0.15 + lean);
    ctx.lineTo(x1, y + gap * 0.5);
    ctx.closePath();
    ctx.fill();
  }
  // A couple of bites out of the tip and the edge — the ragged old-leaf look.
  for (let k = 0; k < 3; k++) {
    const v = 0.55 + rand() * 0.42;
    const w = widthAt(v);
    const r = W * (0.04 + rand() * 0.07);
    ctx.beginPath();
    ctx.arc(W * w + r * 0.4, H * (1 - v), r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalCompositeOperation = "source-over";

  // SHADE. A banana blade from above: the pale midrib, the blade lit beside
  // it and rolling down darker toward its edge, darker still at the stalk
  // end, fine parallel veins running out from the rib, and the torn strips
  // each a slightly different tone — the wind lifts them at different angles.
  const strips = bandNoise(8123);
  shadeHalfLeaf(ctx, W, H, (u, v, x, y) => {
    if (x < 7) return 0.98;                                   // the midrib
    const across = 0.9 - 0.26 * Math.pow(u, 1.4);            // lit by the rib, rolling off at the edge
    const along = 0.72 + 0.28 * Math.min(1, (v - bare) / 0.35);  // darker at the stalk
    const vein = 1 - 0.07 * Math.pow(Math.max(0, Math.sin(y * 0.9)), 8);
    const strip = 0.9 + 0.2 * strips(y / 14);
    return across * along * vein * strip;
  });
}

export function drawTaroLeafTexture(canvas, o = {}) {
  const W = BROADLEAF_TEX_W, H = BROADLEAF_TEX_H;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, W, H);
  // Half the card is petiole: a taro leaf stands on a stalk as long as
  // itself, and the blade hangs from the stalk's tip.
  const bare = o.bare ?? 0.5;
  // A heart: the lobes flare wide just above the petiole, then a long even
  // taper to a drip tip.
  const widthAt = (v) => {
    const s = (v - bare) / (1 - bare);
    const lobe = Math.sin(Math.min(1, s / 0.22) * Math.PI * 0.5);
    // Convex taper: the blade stays broad past the lobes and only draws in to
    // the drip tip over the last third — a heart, not an arrowhead.
    const taper = Math.pow(Math.max(0, 1 - Math.max(0, s - 0.2) / 0.8), 0.55);
    return 0.97 * lobe * taper;
  };
  fillHalfBlade(ctx, W, H, widthAt, { bare, midribW: 6 });
}
