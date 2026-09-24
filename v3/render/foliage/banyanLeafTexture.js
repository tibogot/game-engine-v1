/**
 * BANYAN LEAF CLUSTER — one card's worth of a banyan's canopy: a lumpy clump
 * of small, rounded, leathery ficus leaves, packed solid in the middle and
 * breaking up into single leaves round a ragged edge.
 *
 * The canopy is built from hundreds of these cards laid over a dome
 * (banyanGeometry.js), so what this texture has to get right is the thing a
 * banyan's crown IS in every photograph: a surface of small leaves in big soft
 * lumps. Two channels:
 *
 *   alpha  the clump's outline — a union of overlapping sub-lumps, so no two
 *          cards share a round silhouette, with leaves thinning out past it
 *   red    a SHADE per leaf (alphaCoverageMips `shade`): each sub-lump lit
 *          from above, bright on its upper side and dark underneath, and
 *          every leaf a little different. The foliage shader multiplies it
 *          into the leaf colour, so a card reads as leaves and not as a
 *          flat green disc — the one thing the old jungle tree's clusters never
 *          did.
 *
 * Leaves are drawn heart first, rim last, so the ragged edge sits over the
 * solid middle and the outline stays broken.
 */
export const BANYAN_TEX_W = 512;
export const BANYAN_TEX_H = 512;

function rng(seed) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
}

export function drawBanyanLeafTexture(canvas, o = {}) {
  const rand = rng(o.seed ?? 4099);
  const W = BANYAN_TEX_W, H = BANYAN_TEX_H;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, W, H);

  // The clump: a big central lump and a ring of smaller ones round it.
  const lumps = [{ x: 0.5, y: 0.5, r: 0.3 }];
  const nL = 7;
  for (let k = 0; k < nL; k++) {
    const a = (k / nL) * Math.PI * 2 + (rand() - 0.5) * 0.5;
    const d = 0.18 + rand() * 0.08;
    lumps.push({ x: 0.5 + Math.cos(a) * d, y: 0.5 + Math.sin(a) * d, r: 0.14 + rand() * 0.08 });
  }
  /** 0 at a lump's centre, 1 at its edge — the nearest lump decides. */
  const depth = (x, y) => {
    let best = 9;
    for (const L of lumps) best = Math.min(best, Math.hypot(x - L.x, y - L.y) / L.r);
    return best;
  };

  // Leaves, scattered through the clump, sorted heart-first.
  const leaves = [];
  const N = o.leaves ?? 900;
  for (let i = 0; i < N * 3 && leaves.length < N; i++) {
    const x = 0.04 + rand() * 0.92, y = 0.04 + rand() * 0.92;
    const d = depth(x, y);
    // Solid inside, thinning over the last fifth, and a few strays past it.
    const keep = d < 0.8 ? 1 : d < 1.12 ? 1 - (d - 0.8) / 0.32 : 0;
    if (rand() > keep) continue;
    leaves.push({ x, y, d });
  }
  leaves.sort((a, b) => a.d - b.d);

  for (const L of leaves) {
    // Ficus benghalensis leaf: broad oval, blunt tip. Drawn larger than life
    // (a card spans ~7 m, so these are ~35 cm): at RTS range a true-size leaf
    // is under a pixel, and it is the speckle of individual leaves that says
    // "leaves" instead of "moss".
    const len = 20 + rand() * 10;
    const wid = len * (0.52 + rand() * 0.12);
    // Leaves face roughly outward from the lump, with plenty of scatter.
    const ang = Math.atan2(L.y - 0.5, L.x - 0.5) + (rand() - 0.5) * 2.2;
    // Shade — TOP-LIT SUB-LUMPS, not a dark heart. The geometry turns every
    // card so the canvas top points up the dome, so this is the light from
    // above: each sub-lump bright on its upper side and dark underneath, where
    // the lump above shades it. A radial dark heart (the first try) made every
    // card a rosette, and the crown a heap of lettuce.
    let near = lumps[0], nd = 9;
    for (const q of lumps) {
      const dd = Math.hypot(L.x - q.x, L.y - q.y) / q.r;
      if (dd < nd) { nd = dd; near = q; }
    }
    const up = Math.max(-1, Math.min(1, (near.y - L.y) / near.r));   // canvas y runs down
    let g = 0.62 + 0.3 * up - 0.12 * Math.max(0, nd - 0.7) + (rand() - 0.5) * 0.2;
    // The card as a whole is lit from above too.
    g += 0.12 * (0.5 - L.y);
    if (rand() < 0.05) g += 0.18;
    g = Math.max(0.28, Math.min(1, g));
    const v = Math.round(g * 255);
    ctx.save();
    ctx.translate(L.x * W, L.y * H);
    ctx.rotate(ang);
    ctx.fillStyle = `rgb(${v},${v},${v})`;
    ctx.beginPath();
    ctx.ellipse(0, 0, len * 0.5, wid * 0.5, 0, 0, Math.PI * 2);
    ctx.fill();
    // The midrib: a slightly darker line, visible close up only.
    ctx.strokeStyle = `rgb(${Math.round(v * 0.82)},${Math.round(v * 0.82)},${Math.round(v * 0.82)})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-len * 0.42, 0); ctx.lineTo(len * 0.42, 0);
    ctx.stroke();
    ctx.restore();
  }
}
