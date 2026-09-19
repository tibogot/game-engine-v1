/**
 * The fern frond texture — HALF a bipinnate frond: rachis up the left edge,
 * pinnae reaching right, each pinna a blade whose edges are cut into
 * pinnules. White on a tall canvas, used as the ALPHA of a half-card (see
 * palmFrondTexture.js for why a half: the geometry mirrors it and folds the
 * two halves).
 *
 * What a fern needs that a palm does not: the pinnae sit nearly ACROSS the
 * rachis (about 75°, where a palm's leaflets sweep forward at ~50°), they sit
 * close with almost no gap, and each one is itself divided — the lace. That
 * second level of division is the whole reason this is a texture: the
 * geometry fern (foliageGeometry.js) draws 18 leaflets a side as strips and
 * cannot afford to notch them, so it reads as a comb up close and as a blob
 * at range. Here the notching costs nothing.
 *
 * A pinna is drawn as ONE tapered blade with a SCALLOPED edge, not as a row
 * of separate lobes: separate lobes came out as beads on a wire (a
 * caterpillar), because at any texel size the gaps between them are as loud
 * as the lobes. A blade with cut edges stays a blade — solid where a real
 * pinna is solid, toothed where it is toothed.
 *
 * Layout: rachis on u = 0, petiole bare for v < 0.12, tip at v = 1.
 */
export const FERN_TEX_W = 256;
export const FERN_TEX_H = 768;

export function drawFernFrondTexture(canvas, o = {}) {
  let seed = 9173;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  const W = FERN_TEX_W, H = FERN_TEX_H;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, W, H);

  const pinnae = o.pinnae ?? 34;
  const bare = o.bare ?? 0.12;
  const across = ((o.pinnaDeg ?? 74) * Math.PI) / 180;   // lean from "straight across" toward the tip
  const ratio = o.ratio ?? 0.2;                          // pinna width / length

  // Reach of a pinna at `v`: widest about a third along, a fine tip.
  const outline = (v) => {
    if (v <= bare) return 0;
    const s = (v - bare) / (1 - bare);
    return Math.min(1, s / 0.28 + 0.25) * Math.pow(Math.max(0, 1 - s), 0.8);
  };

  ctx.lineCap = "round";
  ctx.strokeStyle = "rgba(255,255,255,1)";
  ctx.fillStyle = "rgba(255,255,255,1)";

  // The rachis.
  for (let i = 0; i < 10; i++) {
    const v0 = i / 10, v1 = (i + 1) / 10;
    ctx.lineWidth = 8 * (1 - v0 * 0.7);
    ctx.beginPath(); ctx.moveTo(6, H * (1 - v0)); ctx.lineTo(5, H * (1 - v1)); ctx.stroke();
  }

  /**
   * One pinna: a tapered blade along a gently bending midrib, its two edges
   * cut into pinnules — deep cuts near the base (where the pinnules are
   * nearly separate), shallow toward the tip (where they merge).
   */
  const pinna = (v, len) => {
    const steps = 44;
    const teeth = Math.max(5, Math.round(len / 11));
    let x = 8, y = H * (1 - v);
    let th = -Math.PI / 2 + across;
    const curl = (0.016 + rand() * 0.016) * (44 / steps) * 9;
    const left = [], right = [];
    const phase = rand() * Math.PI;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      // The blade: a point at the stalk, widest a third along, a long taper.
      const body = len * ratio * 0.5 * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.7)), 0.85);
      // The teeth: cut depth 45% near the base, 20% near the tip, offset on the
      // two edges so the pinnules alternate like a real pinna's.
      const depth = 0.45 - 0.25 * t;
      const cutL = 1 - depth * (0.5 + 0.5 * Math.cos(t * Math.PI * 2 * teeth + phase));
      const cutR = 1 - depth * (0.5 + 0.5 * Math.cos(t * Math.PI * 2 * teeth + phase + Math.PI));
      const nx = Math.cos(th + Math.PI / 2), ny = Math.sin(th + Math.PI / 2);
      left.push([x + nx * body * cutL, y + ny * body * cutL]);
      right.push([x - nx * body * cutR, y - ny * body * cutR]);
      x += Math.cos(th) * (len / steps);
      y += Math.sin(th) * (len / steps);
      th += curl / 9;
    }
    ctx.beginPath();
    ctx.moveTo(left[0][0], left[0][1]);
    for (const p of left) ctx.lineTo(p[0], p[1]);
    for (let i = right.length - 1; i >= 0; i--) ctx.lineTo(right[i][0], right[i][1]);
    ctx.closePath();
    ctx.fill();
    // Its midrib, so the pinna reads as a pinna and not a feather.
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.moveTo(8, H * (1 - v));
    ctx.lineTo(x, y);
    ctx.stroke();
  };

  for (let k = 0; k < pinnae; k++) {
    const v = bare + ((k + 0.5) / pinnae) * (1 - bare) + (rand() - 0.5) * (0.2 / pinnae);
    const reach = outline(v);
    if (reach < 0.04) continue;
    pinna(v, W * 0.95 * reach * (0.94 + rand() * 0.12));
  }
  // Terminal pinna, straight up the rachis.
  ctx.beginPath();
  ctx.moveTo(6, H * 0.06);
  ctx.lineTo(6 + W * 0.05, H * 0.03);
  ctx.lineTo(6, H * 0.005);
  ctx.lineTo(6 - W * 0.02, H * 0.03);
  ctx.closePath();
  ctx.fill();
}
