/**
 * The plume strand texture — hundreds of fine arcing strands drawn white on a
 * canvas, used as the ALPHA of a plume card (pampas, susuki). Geometry cannot
 * afford that detail; a texture can. Proven in v3/susuki-lab.html.
 */
// ── Plume strand texture (canvas) ────────────────────────────────────────────
// Hundreds of fine arcing white strokes fanning up-and-out from a central
// spine, a blurred low-alpha pass underneath for volume, bright dots for seed
// sparkle. Drawn white — tint / AO / backlight happen in the shader off the
// alpha channel only. Deterministic seed so redraws with equal params match.
export const PLUME_TEX_W = 256;
export const PLUME_TEX_H = 512;

export function drawPlumeTexture(canvas, sp) {
  let seed = 12345;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  const W = PLUME_TEX_W, H = PLUME_TEX_H;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, W, H);
  ctx.lineCap = "round";
  const cx = W / 2;
  const spreadRad = ((sp.texSpread ?? 52) * Math.PI) / 180;
  const strands = sp.texStrands ?? 460;

  const strand = (soft) => {
    const t = Math.pow(rand(), 0.8);              // 0 base → 1 top of spine
    let x = cx + (rand() - 0.5) * 10;
    let y = H * (1 - 0.05 - t * 0.88);
    const side = rand() < 0.5 ? -1 : 1;
    let theta = -Math.PI / 2 + side * spreadRad * (0.2 + 0.8 * rand());
    const len = H * (sp.texStrandLen ?? 0.33) *
      (0.3 + 0.7 * Math.sin(Math.min(t * 1.2, 1) * Math.PI));
    const segs = 8, stepLen = len / segs;
    const curl = side * (0.04 + rand() * 0.07);
    const droop = (sp.texDroop ?? 0.6) * 0.05;
    let alpha = soft ? 0.07 + rand() * 0.07 : 0.35 + rand() * 0.55;
    let lw = soft ? 6 + rand() * 9 : 0.9 + rand() * 1.5;
    for (let k = 0; k < segs; k++) {
      const nx = x + Math.cos(theta) * stepLen * 0.6;
      const ny = y + Math.sin(theta) * stepLen;
      ctx.strokeStyle = `rgba(255,255,255,${alpha.toFixed(3)})`;
      ctx.lineWidth = lw;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(nx, ny); ctx.stroke();
      x = nx; y = ny;
      theta += curl + droop;
      alpha *= soft ? 0.85 : 0.78;
      lw *= 0.9;
    }
    return { x, y };
  };

  for (let i = 0; i < strands * 0.2; i++) strand(true);   // soft volume pass
  const tips = [];
  for (let i = 0; i < strands; i++) tips.push(strand(false));
  for (let i = 0; i < strands * 0.6; i++) {               // seed sparkle
    const tip = tips[(rand() * tips.length) | 0];
    const a = 0.4 + rand() * 0.5;
    ctx.fillStyle = `rgba(255,255,255,${a.toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(tip.x + (rand() - 0.5) * 14, tip.y + (rand() - 0.5) * 14,
            0.5 + rand() * 0.9, 0, Math.PI * 2);
    ctx.fill();
  }
}
