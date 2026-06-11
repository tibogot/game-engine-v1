/**
 * V2 uses the repo-root `tileMaterial.js` unchanged. This file only picks the same defaults as
 * `splatmap-chunks.html` tile view (`createChunkTileMaterialWithHoles` minus splat punch-through).
 *
 * Root `tileMaterial` loads `textures/grid.png` relative to the HTML document; keep a copy at
 * `v2/textures/grid.png` so `v2/splatmap-chunks-v2.html` resolves the same path under `/v2/`.
 */
import { createTileMaterial } from "../../core/legacy/tileMaterial.js";

export function createSharedTileMaterial() {
  return createTileMaterial({
    roughness: 0.95,
    textureScale: 400,
    tileColor: 0xe6e3e3,
    gridColor: 0x444444,
    gridLineColor: 0x111111,
  });
}
