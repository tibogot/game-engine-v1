/**
 * LEAF-SPRAY CARD — a leaf-cluster card built from real leaf-spray MASKS (the
 * arborist's billboard textures: white leaflets on twigs over black), not a
 * procedural blob.
 *
 * Why (your note, 2026-09-25): the canopy tree's crown read flat next to the
 * rest of the forest, and the reason is in its card — the banyan texture is
 * a solid white mass with a ragged rim, so a crown of those is a skin of
 * green sheets. A spray has SKY BETWEEN ITS LEAVES, all through it, and a
 * crown of overlapping sprays shows leaves behind leaves through those gaps:
 * the depth your arborist trees have.
 *
 *   alpha  the union of a few sprays, rotated and scaled so a leaflet comes
 *          out near real size on the card (a canopy card is ~5 m across; one
 *          spray filling it made 65 cm leaves)
 *   red    a SHADE per leaf (read by alphaCoverageMips `shade`): dark at each
 *          leaf's own rim, bright in its middle (a distance transform of the
 *          mask), lit from the top of the card, and each spray a little
 *          lighter or darker than the next — so every leaf reads as a leaf.
 *
 * Masks are PNG files (see LEAF_SPRAY_MASKS); luminance is the mask.
 */

export const LEAF_SPRAY_TEX = 512;

/** Your arborist masks that read as tropical broadleaf (elliptic leaflets on pinnate sprays). */
export const LEAF_SPRAY_MASKS = [
  "/textures/leaves/Leaf-Billboard-Texture-1.png",
  "/textures/leaves/Leaf-Billboard-Texture-5.png",
];

function rng(seed) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
}

/** Load the mask images once. Resolves to HTMLImageElements (failed ones dropped). */
export function loadLeafSprayMasks(urls = LEAF_SPRAY_MASKS) {
  return Promise.all(urls.map((u) => new Promise((res) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => res(null);
    im.src = u;
  }))).then((a) => a.filter(Boolean));
}

/**
 * Draw one card from loaded masks.
 * o: { sprays (3), scale (0.62 of the card per spray), seed }
 */
export function drawLeafSprayCard(canvas, masks, o = {}) {
  const W = LEAF_SPRAY_TEX, H = LEAF_SPRAY_TEX;
  canvas.width = W; canvas.height = H;
  const rand = rng(o.seed ?? 7717);
  const n = o.sprays ?? 3;
  const scale = o.scale ?? 0.62;

  // Each spray into its own layer: its mask (luminance) and which spray it is.
  const alpha = new Float32Array(W * H);
  const owner = new Int16Array(W * H).fill(-1);
  const tmp = document.createElement("canvas");
  tmp.width = W; tmp.height = H;
  const tc = tmp.getContext("2d", { willReadFrequently: true });
  for (let k = 0; k < n; k++) {
    const im = masks[k % masks.length];
    tc.setTransform(1, 0, 0, 1, 0, 0);
    tc.clearRect(0, 0, W, H);
    tc.fillStyle = "#000";
    tc.fillRect(0, 0, W, H);
    // Round the centre, a little apart, so the card has a heart and a broken rim.
    const a = (k / n) * Math.PI * 2 + rand() * 0.8;
    const r = n === 1 ? 0 : 0.14 + rand() * 0.06;
    const cx = W * (0.5 + Math.cos(a) * r), cy = H * (0.5 + Math.sin(a) * r);
    const s = scale * (0.85 + rand() * 0.3);
    tc.translate(cx, cy);
    tc.rotate(rand() * Math.PI * 2);
    tc.drawImage(im, -W * s / 2, -H * s / 2, W * s, H * s);
    const d = tc.getImageData(0, 0, W, H).data;
    for (let i = 0; i < W * H; i++) {
      const v = d[i * 4] / 255;
      if (v > alpha[i]) { alpha[i] = v; owner[i] = k; }
    }
  }

  // Distance to the nearest gap (a two-pass chamfer on the solid mask): a
  // leaf is dark at its rim and bright in its middle.
  const INF = 1e6, dist = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) dist[i] = alpha[i] > 0.5 ? INF : 0;
  const D1 = 1, D2 = 1.414;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (dist[i] === 0) continue;
    let m = dist[i];
    if (x > 0) m = Math.min(m, dist[i - 1] + D1);
    if (y > 0) m = Math.min(m, dist[i - W] + D1);
    if (x > 0 && y > 0) m = Math.min(m, dist[i - W - 1] + D2);
    if (x < W - 1 && y > 0) m = Math.min(m, dist[i - W + 1] + D2);
    dist[i] = m;
  }
  for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) {
    const i = y * W + x;
    if (dist[i] === 0) continue;
    let m = dist[i];
    if (x < W - 1) m = Math.min(m, dist[i + 1] + D1);
    if (y < H - 1) m = Math.min(m, dist[i + W] + D1);
    if (x < W - 1 && y < H - 1) m = Math.min(m, dist[i + W + 1] + D2);
    if (x > 0 && y < H - 1) m = Math.min(m, dist[i + W - 1] + D2);
    dist[i] = m;
  }

  const tone = Array.from({ length: n }, () => 0.78 + rand() * 0.36);
  const ctx = canvas.getContext("2d");
  const out = ctx.createImageData(W, H);
  const rimPx = o.rimPx ?? 7;
  const rimDark = o.rimDark ?? 0.4;
  // The CLUMP is lit too, not only each leaf: bright on top, shaded under —
  // without it a crown of sprays lost the cauliflower lumps the old card had.
  const litTop = o.litTop ?? 1.22, litBottom = o.litBottom ?? 0.68;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x, a = alpha[i];
      const o4 = i * 4;
      if (a <= 0.02) { out.data[o4 + 3] = 0; continue; }
      // A ball: lit from above, with the rim of the clump falling off.
      const dx = x / W - 0.5, dy = y / H - 0.5;
      const lit = (litTop + (litBottom - litTop) * (y / H)) * (1 - 0.35 * Math.min(1, (dx * dx + dy * dy) * 4));
      const t = Math.min(1, dist[i] / rimPx);
      const rim = (1 - rimDark) + rimDark * t * (2 - t);   // dark rim → bright middle
      const sh = Math.max(0, Math.min(1, rim * lit * (owner[i] >= 0 ? tone[owner[i]] : 1) * 0.92));
      out.data[o4] = Math.round(sh * 255);
      out.data[o4 + 1] = out.data[o4 + 2] = 255;
      out.data[o4 + 3] = Math.round(a * 255);
    }
  }
  ctx.putImageData(out, 0, 0);
  return canvas;
}
