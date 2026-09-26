/**
 * CEDAR SPRAY — one card's worth of an Atlas cedar's foliage (Cedrus
 * atlantica, the tree of the Aurès heights): a flat FAN of twigs, each set
 * with ROSETTES of short stiff needles on short shoots. A cedar's plate is
 * dozens of these sprays laid level, overlapping, all pointing out along
 * their branch — so the card is a spray, not a clump: a round clump card made
 * the crown a heap of green coins (first try, 2026-09-26).
 *
 * Layout: the spray's main twig runs UP the canvas (the card's v axis, which
 * the builder points out along the branch); side twigs leave it alternately,
 * swept forward, shortening toward the tip, so the outline is a feathered
 * wedge, widest two-thirds of the way out.
 *
 * Same two channels as the banyan card (banyanLeafTexture.js):
 *   alpha  the spray's outline, broken into single rosettes at its edges
 *   red    a SHADE per rosette: the upper face of the spray lit, the tips of
 *          the side twigs a touch brighter (new growth), the heart darker
 */
export const NEEDLE_TEX_W = 256;
export const NEEDLE_TEX_H = 512;

function rng(seed) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
}

export function drawCedarNeedleTexture(canvas, o = {}) {
  const rand = rng(o.seed ?? 7331);
  const W = NEEDLE_TEX_W, H = NEEDLE_TEX_H;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, W, H);
  ctx.lineCap = "round";

  const rosette = (x, y, len, g) => {
    const v = Math.round(Math.max(0.22, Math.min(1, g)) * 255);
    const n = 11 + Math.floor(rand() * 6);
    ctx.strokeStyle = `rgb(${v},${v},${v})`;
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + rand() * 0.5;
      const l = len * (0.65 + rand() * 0.5);
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
    }
    ctx.stroke();
    const dv = Math.round(v * 0.55);
    ctx.fillStyle = `rgb(${dv},${dv},${dv})`;
    ctx.beginPath(); ctx.arc(x, y, 1.6, 0, Math.PI * 2); ctx.fill();
  };

  // Main twig: bottom centre up to near the top, a slight curve.
  const bend = (rand() - 0.5) * 0.16;
  const main = (t) => [W * (0.5 + bend * Math.sin(t * Math.PI)), H * (0.97 - 0.92 * t)];
  // Side twigs, alternating, swept toward the tip.
  const twigs = [];
  const nSide = 15;
  for (let i = 0; i < nSide; i++) {
    const t = 0.08 + (i / nSide) * 0.85;
    const side = i % 2 ? 1 : -1;
    // Longest two-thirds out: the wedge.
    const reach = W * 0.5 * Math.sin(Math.min(1, t / 0.7) * Math.PI * 0.5) * (1 - Math.max(0, t - 0.7) * 1.6) * (0.8 + rand() * 0.3);
    const [bx, by] = main(t);
    const ang = -Math.PI / 2 + side * (0.95 + rand() * 0.25);        // swept up
    twigs.push({ bx, by, ang, reach, t });
  }
  // Heart first (shaded), then outward, so the edge rosettes sit on top.
  const pts = [];
  for (let k = 0; k <= 26; k++) {
    const t = k / 26;
    const [x, y] = main(t);
    pts.push({ x, y, g: 0.5 + 0.2 * t + (rand() - 0.5) * 0.15, len: 8 });
  }
  for (const tw of twigs) {
    const n = Math.max(3, Math.round(tw.reach / 7));
    for (let k = 1; k <= n; k++) {
      const f = k / n;
      const x = tw.bx + Math.cos(tw.ang) * tw.reach * f + (rand() - 0.5) * 5;
      const y = tw.by + Math.sin(tw.ang) * tw.reach * f + (rand() - 0.5) * 5;
      pts.push({ x, y, g: 0.55 + 0.25 * f + 0.1 * tw.t + (rand() - 0.5) * 0.2, len: 7 + rand() * 3 });
      // A spur rosette either side of the twig, so it reads as foliage, not a line.
      if (f < 0.95) {
        const s = rand() < 0.5 ? 1 : -1;
        pts.push({ x: x + Math.cos(tw.ang + s * 1.3) * 10, y: y + Math.sin(tw.ang + s * 1.3) * 10, g: 0.5 + 0.2 * f + (rand() - 0.5) * 0.2, len: 6 + rand() * 3 });
      }
    }
  }
  pts.sort((a, b) => a.g - b.g);
  // The twigs themselves, thin and dark, under the needles.
  ctx.strokeStyle = "rgb(70,70,70)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let k = 0; k <= 20; k++) { const [x, y] = main(k / 20); if (k) ctx.lineTo(x, y); else ctx.moveTo(x, y); }
  for (const tw of twigs) { ctx.moveTo(tw.bx, tw.by); ctx.lineTo(tw.bx + Math.cos(tw.ang) * tw.reach, tw.by + Math.sin(tw.ang) * tw.reach); }
  ctx.stroke();
  for (const p of pts) rosette(p.x, p.y, p.len, p.g);
}
