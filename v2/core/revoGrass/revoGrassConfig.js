/** Grid side presets — 1088² is Revo Realms ultra; use balanced/high for editor play.
 *  ultraCompact matches Ultra density (~70 blades/m²) over a smaller 60 m tile
 *  so total instances stay at ~262k while the visible look around the player
 *  is indistinguishable from Ultra. */
export const REVO_GRASS_QUALITY = {
  balanced: { bladesPerSide: 384, label: "Balanced (~147k)" },
  high: { bladesPerSide: 512, label: "High (~262k)" },
  ultraCompact: { bladesPerSide: 512, label: "Ultra Compact (~262k)" },
  ultra: { bladesPerSide: 1088, label: "Ultra / Revo (~1.18M)" },
};

export function bladesPerSideForQuality(preset) {
  return REVO_GRASS_QUALITY[preset]?.bladesPerSide ?? REVO_GRASS_QUALITY.balanced.bladesPerSide;
}

/**
 * Revo-style fluffy grass tile — density / size from toolState.revoGrass.
 */
export function getRevoGrassConfig(rp) {
  const presetSide = rp.qualityPreset ? bladesPerSideForQuality(rp.qualityPreset) : null;
  const bladesPerSide = Math.max(
    32,
    Math.min(1088, Math.floor(rp.bladesPerSide ?? presetSide ?? 1088)),
  );
  const tileSize = Math.max(20, rp.tileSize ?? 130);
  const segments = Math.max(1, Math.min(8, Math.floor(rp.segments ?? 4)));
  const bladeHeight = rp.bladeHeight ?? 1.75;
  const bladeWidth = rp.bladeWidth ?? 0.06;
  return {
    segments,
    bladeWidth,
    bladeHeight,
    bladeBoundingRadius: bladeHeight,
    tileSize,
    tileHalfSize: tileSize * 0.5,
    bladesPerSide,
    count: bladesPerSide * bladesPerSide,
    spacing: tileSize / bladesPerSide,
    workgroupSize: 64,
  };
}
