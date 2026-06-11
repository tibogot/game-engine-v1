/**
 * Snow tile config — sizing helpers for `SnowSystem`.
 *
 * The snow tile is a moving-window grid of `subdivisions²` quads centered
 * around the active anchor (player in play mode, camera target in editor).
 * Like RevoGrass, the cost is independent of world size — only the visible
 * window around the anchor is meshed and displaced.
 */

export const SNOW_QUALITY = {
  low: { subdivisions: 128, tileSize: 80, label: "Low (16k tris)" },
  medium: { subdivisions: 192, tileSize: 96, label: "Medium (37k tris)" },
  high: { subdivisions: 256, tileSize: 110, label: "High (66k tris)" },
  ultra: { subdivisions: 320, tileSize: 128, label: "Ultra (102k tris)" },
};

export function subdivisionsForQuality(preset) {
  return (
    SNOW_QUALITY[preset]?.subdivisions ?? SNOW_QUALITY.high.subdivisions
  );
}

export function tileSizeForQuality(preset) {
  return SNOW_QUALITY[preset]?.tileSize ?? SNOW_QUALITY.high.tileSize;
}

/**
 * @param {object} sp toolState.snow
 */
export function getSnowConfig(sp) {
  const presetSubs = sp.qualityPreset
    ? subdivisionsForQuality(sp.qualityPreset)
    : null;
  const presetTile = sp.qualityPreset
    ? tileSizeForQuality(sp.qualityPreset)
    : null;
  const subdivisions = Math.max(
    32,
    Math.min(512, Math.floor(sp.subdivisions ?? presetSubs ?? 256)),
  );
  const tileSize = Math.max(20, Math.min(256, sp.tileSize ?? presetTile ?? 110));
  return {
    subdivisions,
    tileSize,
    tileHalfSize: tileSize * 0.5,
    /** Side length of the elevation render target (one texel per shared vertex). */
    elevationResolution: subdivisions + 1,
  };
}
