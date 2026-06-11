/** World-aligned patch grid for billboard grass streaming (independent of terrain chunks). */

export const BILLBOARD_GRASS_PATCH_SIZE = 16;
export const BILLBOARD_GRASS_OCC_RES = 64;

export function patchKey(px, pz) {
  return `${px},${pz}`;
}

export function parsePatchKey(key) {
  const [a, b] = key.split(",");
  return { px: Number(a), pz: Number(b) };
}

/**
 * @param {number} wx
 * @param {number} wz
 * @param {number} worldSize
 * @param {number} [patchSize]
 */
export function worldToPatchIndex(wx, wz, worldSize, patchSize = BILLBOARD_GRASS_PATCH_SIZE) {
  const half = worldSize * 0.5;
  return {
    px: Math.floor((wx + half) / patchSize),
    pz: Math.floor((wz + half) / patchSize),
  };
}

export function patchWorldCenter(px, pz, worldSize, patchSize = BILLBOARD_GRASS_PATCH_SIZE) {
  const half = worldSize * 0.5;
  return {
    x: -half + px * patchSize + patchSize * 0.5,
    z: -half + pz * patchSize + patchSize * 0.5,
  };
}

/** World-aligned cell center (same convention as Gemini grass patches). */
export function snapPatchCellCenter(wx, wz, patchSize) {
  return {
    x: Math.floor(wx / patchSize) * patchSize,
    z: Math.floor(wz / patchSize) * patchSize,
  };
}

export function patchIndexRangeForWorldRect(minX, maxX, minZ, maxZ, worldSize, patchSize) {
  const half = worldSize * 0.5;
  const minPx = Math.floor((minX + half) / patchSize);
  const maxPx = Math.floor((maxX + half) / patchSize);
  const minPz = Math.floor((minZ + half) / patchSize);
  const maxPz = Math.floor((maxZ + half) / patchSize);
  return { minPx, maxPx, minPz, maxPz };
}
