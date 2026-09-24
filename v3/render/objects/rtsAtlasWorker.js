/**
 * Builds the RTS surface atlas off the main thread — see rtsAtlas() in
 * rtsTextures.js. Runs the SAME makeSurfaceAtlas the main thread would, on an
 * OffscreenCanvas, and transfers the pixels back as an ImageBitmap.
 */
import { makeSurfaceAtlas } from "./rtsTextures.js";

self.onmessage = (e) => {
  try {
    const t = makeSurfaceAtlas({ cell: e.data?.cell ?? 512 });
    const bitmap = t.image.transferToImageBitmap();
    t.dispose();
    self.postMessage(bitmap, [bitmap]);
  } catch (err) {
    self.postMessage({ error: String(err?.message ?? err) });
  }
};
