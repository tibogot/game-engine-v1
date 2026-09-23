/**
 * CANOPY CLUSTER — the alpha of one leaf plate in a jungle tree's crown.
 *
 * A rainforest giant's crown is not a ball of foliage; it is a set of roughly
 * horizontal PLATES of leaves held out on long branches, with sky between
 * them. jungleTreeGeometry.js builds the plates as crossed cards, and this
 * draws what is on a card: a spray of leaves on a short common stalk, entering
 * at the bottom edge (v = 0, the branch end) and fanning out and forward.
 *
 * Three things matter and they are all in the alpha:
 *
 *   · THE EDGE MUST BE RAGGED. A plate whose outline is a smooth disc reads as
 *     a cut-out sticker the moment two overlap. Leaf length and angle are
 *     jittered hard toward the rim, so the silhouette is made of leaf TIPS.
 *   · THE LEAVES MUST BE SMALL AND MANY, and the only way to get that right is
 *     to DO THE SUM IN METRES. This card is ~6 m across on a 26 m tree. The
 *     first version fanned 64 long blades from a point and read as a green
 *     COMB; the second scattered 150 over a disc and read as green SLABS,
 *     because each "leaf" was 60 cm. A real one is 15-25 cm — a twentieth of
 *     the card — so it takes ~700 of them, overlapping, to make a crown.
 *   · SKY MUST COME THROUGH, and it has to come through BETWEEN THE LEAVES.
 *     Punching holes out of a solid mass afterwards reads as a sheet with
 *     bites taken out of it; spacing the leaves on a jittered grid so they
 *     only just touch gives the same openness and keeps every gap leaf-shaped.
 *   · THE LEAF SHAPE IS SPECIFIC. Wet-tropic broadleaves are elliptic with a
 *     DRIP TIP — a drawn-out point that sheds monsoon rain. It is the one
 *     feature that separates this silhouette from an oak or a maple, and at
 *     the rim it is most of what you see.
 *
 * White on transparent, like every other card texture here; the colour is the
 * shader's, so one texture serves every tree colour on the map.
 */
export const CANOPY_TEX_W = 512;
export const CANOPY_TEX_H = 512;

function rng(seed) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

/**
 * One leaf: an ellipse pulled to a point at the tip. Drawn as two mirrored
 * quadratic curves so the widest part sits about a third of the way along,
 * which is where a broadleaf's is.
 */
function drawLeaf(ctx, x, y, len, halfW, ang) {
  const c = Math.cos(ang), s = Math.sin(ang);
  // Local (along, across) -> canvas, with `along` running toward the tip.
  const P = (a, b) => [x + c * a - s * b, y + s * a + c * b];
  const tip = P(len, 0);
  const wideA = P(len * 0.34, halfW);
  const wideB = P(len * 0.34, -halfW);
  // The control points that put the widest point where it belongs and let the
  // last quarter taper into the drip tip.
  const ctrl1 = P(len * 0.72, halfW * 0.82);
  const ctrl2 = P(len * 0.72, -halfW * 0.82);
  const base = P(0, 0);
  ctx.beginPath();
  ctx.moveTo(base[0], base[1]);
  ctx.quadraticCurveTo(P(len * 0.08, halfW * 0.75)[0], P(len * 0.08, halfW * 0.75)[1], wideA[0], wideA[1]);
  ctx.quadraticCurveTo(ctrl1[0], ctrl1[1], tip[0], tip[1]);
  ctx.quadraticCurveTo(ctrl2[0], ctrl2[1], wideB[0], wideB[1]);
  ctx.quadraticCurveTo(P(len * 0.08, -halfW * 0.75)[0], P(len * 0.08, -halfW * 0.75)[1], base[0], base[1]);
  ctx.closePath();
  ctx.fill();
}

export function drawCanopyClusterTexture(canvas, o = {}) {
  const W = canvas.width, H = canvas.height;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, W, H);
  const rand = rng(o.seed ?? 20260923);
  const leaves = o.leaves ?? 240;

  ctx.fillStyle = "rgba(255,255,255,1)";

  // The twigs the spray hangs on, spreading from the bottom edge. They are
  // mostly buried under leaves; they exist so the card does not read as leaves
  // floating free, and so the gaps between clusters have something in them.
  const hubX = W * 0.5, hubY = H * 0.94;
  ctx.strokeStyle = "rgba(255,255,255,1)";
  ctx.lineCap = "round";
  for (let i = 0; i < 5; i++) {
    const a = -Math.PI / 2 + (i / 4 - 0.5) * 1.5;
    ctx.lineWidth = W * (0.010 - i * 0.001);
    ctx.beginPath();
    ctx.moveTo(hubX, hubY);
    ctx.lineTo(hubX + Math.cos(a) * H * 0.42, hubY + Math.sin(a) * H * 0.42);
    ctx.stroke();
  }

  // The leaf mass. Leaves sit on a JITTERED GRID over the disc, not at random
  // points: scattered at random they pile up in places and leave holes in
  // others, and at any coverage high enough to read as a cluster they merge
  // into one white blob with a ragged edge — which is exactly what the third
  // version did. On a grid each leaf keeps its own space, so the silhouette
  // inside the cluster is made of LEAVES, which is the whole job of this
  // texture.
  const cx = W * 0.5, cy = H * 0.44;
  const R = H * 0.40;
  const cell = H * 0.05;                 // one leaf per cell, jittered inside it
  const n = Math.ceil((R * 2) / cell);
  for (let gy = 0; gy < n; gy++) {
    for (let gx = 0; gx < n; gx++) {
      const jx = (gx + 0.15 + rand() * 0.7) * cell - R;
      const jy = (gy + 0.15 + rand() * 0.7) * cell - R;
      const d = Math.hypot(jx, jy / 0.86) / R;
      if (d > 1) continue;
      // The rim thins out, so the edge is the odd leaf sticking into the sky
      // rather than a shaved circle.
      if (d > 0.72 && rand() < (d - 0.72) / 0.28) continue;
      const bx = cx + jx, by = cy + jy;
      // Leaves hang outward and a little down, with enough slop that the
      // cluster does not read as a rosette.
      const ang = Math.atan2(jy, jx) + (rand() - 0.5) * 1.9;
      // DO THE SUM IN METRES. This card is about 2 m across on a 26 m tree, so
      // a 20 cm leaf is a tenth of it. Bigger than that and a dozen leaves
      // become one slab; smaller and they vanish into mush two mips down.
      const len = H * (0.055 + 0.045 * rand());
      // 2.3:1 with the drip tip. Rounder than that and it reads as poplar or
      // birch — a temperate tree — which is the wrong continent.
      drawLeaf(ctx, bx, by, len, len * (0.20 + rand() * 0.055), ang);
    }
  }

  // A handful of leaves thrown clear of the rim. They cost nothing and they
  // are most of what the eye reads as "foliage" on the silhouette.
  for (let i = 0; i < 16; i++) {
    const a = rand() * Math.PI * 2;
    const d = R * (1.0 + rand() * 0.16);
    const len = H * (0.05 + 0.035 * rand());
    drawLeaf(ctx, cx + Math.cos(a) * d, cy + Math.sin(a) * d * 0.86, len, len * 0.22, a + (rand() - 0.5) * 0.8);
  }
}
