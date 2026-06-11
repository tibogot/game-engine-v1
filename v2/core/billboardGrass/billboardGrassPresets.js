/** Named color palettes for procedural billboard ground cover. */
export const BILLBOARD_GRASS_PRESETS = {
  meadow: {
    colorBottom: "#1a4d12",
    colorMid: "#3d8f2a",
    colorTop: "#6bc44a",
  },
  dry: {
    colorBottom: "#4a3d1a",
    colorMid: "#8f7a3d",
    colorTop: "#c4a85a",
  },
  moss: {
    colorBottom: "#142e18",
    colorMid: "#2a5234",
    colorTop: "#4a8f55",
  },
  wheat: {
    colorBottom: "#5a4a18",
    colorMid: "#9a7a28",
    colorTop: "#d4b850",
  },
};

/**
 * @param {object} slot
 * @param {keyof BILLBOARD_GRASS_PRESETS} [presetId]
 */
export function applyBillboardGrassPreset(slot, presetId = slot.preset) {
  const p = BILLBOARD_GRASS_PRESETS[presetId] ?? BILLBOARD_GRASS_PRESETS.meadow;
  slot.preset = presetId in BILLBOARD_GRASS_PRESETS ? presetId : "meadow";
  slot.colorBottom = p.colorBottom;
  slot.colorMid = p.colorMid;
  slot.colorTop = p.colorTop;
}
