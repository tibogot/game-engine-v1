/**
 * The bamboo leaf-spray texture — one spray of overlapping lanceolate blades
 * fanning up and out from a twig tip, drawn white on a canvas and used as the
 * ALPHA of a card. Same idea, same reasons as plumeTexture.js.
 *
 * Why a card and not blades of geometry: a spray is a FLAT FAN of 5-9 leaves
 * that overlap. Geometry blades cannot overlap without fighting, so they had
 * to be spread apart, and spread-apart narrow strips read as shards — and then
 * the wind moved every shard on its own, which is confetti. A card keeps the
 * overlap, keeps the fan's outline, and sways as one thing, which is what a
 * spray does. It is also what every stylised game that has a bamboo grove
 * draws (Genshin's Qingce bamboo is exactly this over geometry culms).
 *
 * Drawn white — colour, translucency and backlight are the shader's, off the
 * alpha only. Deterministic seed, so redraws match.
 *
 * Layout: the twig meets the card at the BOTTOM CENTRE (u 0.5, v 0); the fan
 * opens upward. The card in the plant is laid along the twig, so "up" here is
 * "outward along the twig" there, and the droop is in the plant's geometry.
 */
export const SPRAY_TEX_W = 256;
export const SPRAY_TEX_H = 256;

export function drawBambooSprayTexture(canvas, o = {}) {
  let seed = 7331;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  const W = SPRAY_TEX_W, H = SPRAY_TEX_H;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, W, H);

  const blades = o.blades ?? 8;
  const fan = ((o.fanDeg ?? 62) * Math.PI) / 180;   // half-angle of the fan
  const ratio = o.ratio ?? 0.13;                     // blade width / length
  const ox = W * 0.5, oy = H * 0.94;                 // where the twig meets the card

  // The twig itself: a short stroke up into the fan, so the leaves hang off
  // something instead of floating.
  ctx.strokeStyle = "rgba(170,170,170,0.9)";
  ctx.lineCap = "round";
  ctx.lineWidth = 2.2;
  ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(ox, oy - H * 0.16); ctx.stroke();

  /** One blade: a filled lanceolate polygon along a gently curving axis. */
  const blade = (angle, len, curl, alpha, back = false) => {
    const steps = 14;
    const left = [], right = [];
    let x = ox, y = oy - H * 0.05 - rand() * H * 0.08;
    const x0 = x, y0 = y;
    let th = angle;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      // Lanceolate: a point at the stalk, widest a third along, a fine tip.
      const w = len * ratio * 0.5 * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.75)), 0.9);
      const nx = Math.cos(th + Math.PI / 2), ny = Math.sin(th + Math.PI / 2);
      left.push([x + nx * w, y + ny * w]);
      right.push([x - nx * w, y - ny * w]);
      x += Math.cos(th) * (len / steps);
      y += Math.sin(th) * (len / steps);
      th += curl;
    }
    // SHADE (alphaCoverageMips `shade`, multiplied into the leaf colour):
    // darker at the twig, lit along the blade, a touch darker at the tip,
    // each blade its own tone and the back ones in the spray's shadow. A flat
    // white spray made the sugar cane a pale lime blob and the bamboo a grey
    // smudge (your screenshots, 2026-09-24).
    const tone = (0.84 + rand() * 0.2) * (back ? 0.7 : 1);
    const grey = (k) => { const c = Math.round(Math.max(0, Math.min(1, k * tone)) * 255); return `rgba(${c},${c},${c},${alpha.toFixed(3)})`; };
    const g = ctx.createLinearGradient(x0, y0, x, y);
    g.addColorStop(0, grey(0.62)); g.addColorStop(0.45, grey(1.0)); g.addColorStop(1, grey(0.85));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(left[0][0], left[0][1]);
    for (const p of left) ctx.lineTo(p[0], p[1]);
    for (let i = right.length - 1; i >= 0; i--) ctx.lineTo(right[i][0], right[i][1]);
    ctx.closePath();
    ctx.fill();
  };

  // Blades alternate sides, the middle ones longest and most upright, the
  // outer ones shorter and drooping outward — the shouldered outline of a
  // real spray. Back blades first at lower alpha for a little depth.
  const order = [];
  for (let b = 0; b < blades; b++) order.push(b);
  for (const b of order) {
    const s = (b / (blades - 1)) * 2 - 1;            // -1 … 1 across the fan
    const side = s < 0 ? -1 : 1;
    const a = -Math.PI / 2 + s * fan * (0.55 + 0.45 * Math.abs(s)) + (rand() - 0.5) * 0.12;
    const len = H * (0.62 + 0.28 * (1 - Math.abs(s)) + (rand() - 0.5) * 0.08);
    const curl = side * (0.018 + rand() * 0.02);      // bends outward and down
    blade(a, len, curl, 0.82 + rand() * 0.18);
  }
  // Two small back leaves peeking through the fan, dimmer.
  for (let b = 0; b < 2; b++) {
    const side = b ? 1 : -1;
    blade(-Math.PI / 2 + side * fan * 0.25, H * 0.5, side * 0.03, 0.55, true);
  }
}
