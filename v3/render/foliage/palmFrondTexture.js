/**
 * The palm frond texture — HALF a pinnate frond: the rachis runs up the left
 * edge and the leaflets reach to the right, drawn white on a tall canvas and
 * used as the ALPHA of a card. Same idea as plumeTexture.js and
 * bambooSprayTexture.js.
 *
 * Half, not whole, on purpose. A coconut frond is V-FOLDED along its rachis —
 * the two rows of leaflets hang down at an angle from the midrib, and that
 * fold is the thing that says "palm" from any distance: one half catches the
 * sun and the other falls into shade. One flat card cannot fold. Two half-cards
 * can, so the texture is a half and the geometry mirrors it (palmGeometry.js).
 *
 * Layout: rachis on u = 0, from the petiole at v = 0 to the tip at v = 1.
 * Leaflets from v ≈ 0.18 (the petiole is bare) to the tip, angled toward the
 * tip, curving down at their ends, shortest at both ends of the frond and
 * longest a third of the way along.
 *
 * Drawn white — colour and backlight are the shader's, off the alpha only.
 * Deterministic seed.
 */
export const FROND_TEX_W = 256;
export const FROND_TEX_H = 1024;

export function drawPalmFrondTexture(canvas, o = {}) {
  let seed = 4421;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  const W = FROND_TEX_W, H = FROND_TEX_H;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, W, H);

  const leaflets = o.leaflets ?? 42;
  const bare = o.bare ?? 0.18;                          // petiole share of the frond
  const angle = ((o.leafletDeg ?? 52) * Math.PI) / 180;  // leaflet lean toward the tip, from across
  const ratio = o.ratio ?? 0.085;                       // leaflet width / length

  // How far a leaflet reaches at `v`: nothing on the petiole, opens quickly,
  // longest a third along, a long taper to a fine tip. (The fern's outline.)
  const outline = (v) => {
    if (v <= bare) return 0;
    const s = (v - bare) / (1 - bare);
    return Math.min(1, s / 0.22 + 0.2) * Math.pow(Math.max(0, 1 - s), 0.75);
  };

  // The rachis: a tapering stroke up the left edge, thick at the petiole.
  ctx.lineCap = "round";
  // SHADE (alphaCoverageMips `shade`: the grey is multiplied into the frond's
  // colour). One flat white frond made every crown one flat green (your
  // screenshot, 2026-09-24). Now the rachis is pale, each leaflet runs from
  // darker at the rachis to lit toward its tip, and no two leaflets share a
  // tone — a coconut crown is a thousand blades catching the light apart.
  ctx.strokeStyle = "rgb(236,236,236)";
  for (let i = 0; i < 12; i++) {
    const v0 = i / 12, v1 = (i + 1) / 12;
    ctx.lineWidth = 11 * (1 - v0 * 0.72);
    ctx.beginPath();
    ctx.moveTo(6, H * (1 - v0));
    ctx.lineTo(5, H * (1 - v1));
    ctx.stroke();
  }

  /** One leaflet: a filled lanceolate polygon along a gently drooping axis. */
  const leaflet = (v, len, alpha, dull = 0) => {
    const steps = 10;
    const left = [], right = [];
    let x = 7, y = H * (1 - v);
    let th = -Math.PI / 2 + angle;               // up-and-to-the-right
    const curl = 0.035 + rand() * 0.03;          // then bending down
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const w = len * ratio * 0.5 * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.7)), 0.85);
      const nx = Math.cos(th + Math.PI / 2), ny = Math.sin(th + Math.PI / 2);
      left.push([x + nx * w, y + ny * w]);
      right.push([x - nx * w, y - ny * w]);
      x += Math.cos(th) * (len / steps);
      y += Math.sin(th) * (len / steps);
      th += curl;
    }
    // Darker where it leaves the rachis, lit along its body, a touch darker
    // at the tip; its own tone; the frond's stalk end darker than its tip.
    const tone = (0.84 + rand() * 0.2 - dull) * (0.8 + 0.2 * Math.min(1, (v - bare) / 0.3));
    const g = ctx.createLinearGradient(7, H * (1 - v), x, y);
    const grey = (k) => { const c = Math.round(Math.max(0, Math.min(1, k * tone)) * 255); return `rgba(${c},${c},${c},${alpha.toFixed(3)})`; };
    g.addColorStop(0, grey(0.6));
    g.addColorStop(0.45, grey(1.0));
    g.addColorStop(1, grey(0.88));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(left[0][0], left[0][1]);
    for (const p of left) ctx.lineTo(p[0], p[1]);
    for (let i = right.length - 1; i >= 0; i--) ctx.lineTo(right[i][0], right[i][1]);
    ctx.closePath();
    ctx.fill();
  };

  for (let k = 0; k < leaflets; k++) {
    const v = bare + ((k + 0.5) / leaflets) * (1 - bare) + (rand() - 0.5) * (0.3 / leaflets);
    const reach = outline(v);
    if (reach < 0.03) continue;
    const len = W * 0.98 * reach * (0.92 + rand() * 0.14);
    leaflet(v, len, 0.9 + rand() * 0.1);
    // A few leaflets are split at the tip, the way wind shreds a coconut
    // frond: a second, thinner blade from the same root.
    if (rand() < 0.28) leaflet(v + 0.004, len * 0.7, 0.8, 0.1);
  }
  // The terminal leaflet, straight on along the rachis.
  leaflet(0.985, W * 0.22, 1);
}
