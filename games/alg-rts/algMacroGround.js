// THE MACRO PHOTO (the Ground Lab's proposal, 2026-10-02; in the game 2026-10-07 — the AAA gap list
// #1): an aerial photo's LUMINANCE RATIO laid over every ground layer at tens of metres a tile, so
// the ground varies at the scale the RTS camera sees (the layers' own photos repeat every ~16 m).
// splatOverlay setMacroImage: texel loads, no sampler; baked in the ground cache = free per frame.
// ?macro=0 = without.
export const MACRO = { slug: "dirt_aerial_02", strength: 0.7, tile: 45 };

export async function applyMacroGround(app, P = MACRO) {
  const ov = app.splatOverlay ?? (typeof window !== "undefined" ? window.__V3_DEBUG?.splatOverlay : null);
  if (!ov?.setMacroImage) return false;
  const N = ov.macroImageSize;
  const img = new Image();
  img.src = `/textures/ground/${P.slug}/${P.slug}_diff_1k.jpg`;
  await img.decode();
  const c = document.createElement("canvas");
  c.width = c.height = N;
  const g = c.getContext("2d", { willReadFrequently: true });
  g.drawImage(img, 0, 0, N, N);
  const px = g.getImageData(0, 0, N, N).data;
  const lum = new Float32Array(N * N);
  const l = (v) => (v / 255) ** 2.2;
  let mean = 0;
  for (let i = 0; i < N * N; i++) { lum[i] = 0.2126 * l(px[i * 4]) + 0.7152 * l(px[i * 4 + 1]) + 0.0722 * l(px[i * 4 + 2]); mean += lum[i]; }
  mean /= N * N;
  const bytes = new Uint8Array(N * N);
  for (let i = 0; i < N * N; i++) bytes[i] = Math.max(0, Math.min(255, Math.round((lum[i] / mean) * 0.5 * 255)));
  ov.setMacroImage(bytes);
  ov.uMacroTexStrength.value = P.strength;
  ov.uMacroTexScale.value = P.tile;
  app.groundCache?.markAllStale?.();
  return true;
}
