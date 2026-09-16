/**
 * Painted foliage (ferns and friends) — the plants' look and where they grow.
 *
 * Four types, one painted density channel each, exactly like the flowers. A
 * type is a shape (the geometry builder reads it), a colour, and its rules for
 * where it may grow.
 */

export const FOLIAGE_TYPE_COUNT = 8;

/** Shape keys — changing one of these rebuilds that type's meshes. */
export const FOLIAGE_GEOMETRY_KEYS = [
  "kind", "fronds", "frondLength", "leaflets", "leafletWidth", "leafletAngle", "spread", "arch", "droop", "stemWidth", "bareStalk",
];

/** Height band that means "no limit" (the full slider range). */
export const FOLIAGE_HEIGHT_ANY = { heightMin: -200, heightMax: 900 };

// Shapes are tuned against a game fern pack: wide low rosettes of arching
// fronds, each with 14-20 separate round-tipped leaflets per side.
export const FOLIAGE_PRESETS = {
  fern: {
    kind: "fern",
    fronds: 9, frondLength: 1.05, leaflets: 18, leafletWidth: 1.0, leafletAngle: 65,
    spread: 0.8, arch: 0.75, droop: 0.2, stemWidth: 1, bareStalk: 0.06,
    colorBase: "#4b7431", colorTip: "#7fa848", colorHead: "#7fa848", size: 2.3, translucency: 0.9,
  },
  ladyFern: {
    kind: "fern",
    fronds: 9, frondLength: 1.05, leaflets: 20, leafletWidth: 0.8, leafletAngle: 56,
    spread: 0.68, arch: 0.95, droop: 0.4, stemWidth: 0.8, bareStalk: 0.2,
    colorBase: "#3b6a2e", colorTip: "#78a446", colorHead: "#78a446", size: 2.5, translucency: 1.0,
  },
  bracken: {
    kind: "fern",
    fronds: 6, frondLength: 1.1, leaflets: 14, leafletWidth: 1.25, leafletAngle: 46,
    spread: 0.6, arch: 0.5, droop: 0.2, stemWidth: 1.3, bareStalk: 0.3,
    colorBase: "#4a6a28", colorTip: "#8ea03e", colorHead: "#8ea03e", size: 3.2, translucency: 0.7,
  },
  undergrowth: {
    kind: "fern",
    fronds: 7, frondLength: 0.65, leaflets: 10, leafletWidth: 1.1, leafletAngle: 60,
    spread: 1.15, arch: 0.9, droop: 0.4, stemWidth: 0.7, bareStalk: 0.12,
    colorBase: "#345826", colorTip: "#6a9138", colorHead: "#6a9138", size: 1.3, translucency: 0.9,
  },
  reeds: {
    kind: "blades",
    fronds: 16, frondLength: 1.1, leaflets: 6, leafletWidth: 1.0, leafletAngle: 60,
    spread: 0.3, arch: 1.0, droop: 0.2, stemWidth: 1, bareStalk: 0,
    colorBase: "#5c7a34", colorTip: "#a8b95a", colorHead: "#d8cf7e", size: 1.6, translucency: 1.0,
  },
  bush: {
    kind: "bush",
    fronds: 42, frondLength: 1.25, leaflets: 6, leafletWidth: 1.15, leafletAngle: 60,
    spread: 0.6, arch: 0.6, droop: 0.35, stemWidth: 1, bareStalk: 0,
    colorBase: "#34602c", colorTip: "#6f9a3c", colorHead: "#6f9a3c", size: 1.8, translucency: 0.7,
  },
  typha: {
    kind: "typha",
    fronds: 9, frondLength: 1.2, leaflets: 5, leafletWidth: 1.0, leafletAngle: 60,
    spread: 0.2, arch: 0.45, droop: 0.15, stemWidth: 1, bareStalk: 0,
    colorBase: "#4f8a33", colorTip: "#93c25a", colorHead: "#7e3f1f", size: 2.0, translucency: 0.8,
  },
  plumeReed: {
    kind: "plume",
    fronds: 9, frondLength: 1.25, leaflets: 6, leafletWidth: 1.0, leafletAngle: 60,
    spread: 0.3, arch: 0.85, droop: 0.4, stemWidth: 0.9, bareStalk: 0,
    colorBase: "#5f9a3a", colorTip: "#9ccb5e", colorHead: "#f2e4a8", size: 2.2, translucency: 1.1,
  },
  pampas: {
    kind: "pampas",
    fronds: 9, frondLength: 1.3, leaflets: 5, leafletWidth: 1.0, leafletAngle: 60,
    spread: 0.32, arch: 0.8, droop: 0.45, stemWidth: 0.9, bareStalk: 0,
    colorBase: "#5f9a3a", colorTip: "#9ccb5e", colorHead: "#efe3b0", size: 2.4, translucency: 1.1,
  },
  groundCover: {
    kind: "broadleaf",
    fronds: 16, frondLength: 0.9, leaflets: 4, leafletWidth: 1.3, leafletAngle: 60,
    spread: 0.5, arch: 0.4, droop: 0.25, stemWidth: 0.8, bareStalk: 0,
    colorBase: "#3a6b2a", colorTip: "#7fa945", colorHead: "#7fa945", size: 0.5, translucency: 0.9,
  },
};

const TYPE_DEFAULTS = [
  { name: "Fern", preset: "fern" },
  { name: "Bush", preset: "bush" },
  { name: "Cattails", preset: "typha" },
  { name: "Plume reeds", preset: "plumeReed" },
  { name: "Ground cover", preset: "groundCover" },
  { name: "Reeds", preset: "reeds" },
  { name: "Pampas", preset: "pampas" },
  { name: "Bracken", preset: "bracken" },
];

export function createFoliageScatterState() {
  return {
    // ── The field ──
    density: 0.25,
    clumping: 0.75,
    clumpSize: 8,
    sizeVar: 0.3,
    colorVar: 0.06,
    grassLift: 0.4,
    slopeMinY: 0.6,
    // ── Wind & push (multiplies the shared grass wind). Off by default: the
    // shape is judged at rest; wind is switched on once it is right. ──
    windMul: 0,
    flex: 0.6,
    flutter: 0,
    interactRadius: 1.4,
    interactStrength: 1.0,
    // ── Light ──
    translucencyMul: 1,
    glowLight: 0.02,
    receiveShadows: true,
    // ── Distance: every leaflet up close, a cut sheet, then a plain blade ──
    lodDistance: 18,
    lodDistance2: 45,
    fadeStart: 70,
    fadeEnd: 95,
    types: TYPE_DEFAULTS.map((t) => ({
      ...t,
      ...structuredClone(FOLIAGE_PRESETS[t.preset]),
      // Where a plant MAY grow is off by default: painting it somewhere is you
      // saying it grows there. The rules below are an opt-in filter, for
      // scattering a plant over a whole world rather than by hand.
      ...FOLIAGE_HEIGHT_ANY,
      onLayer: -1,
      nearRiver: 0,
    })),
  };
}
