/**
 * Flower mode state — painted meadow flowers (v3/render/grass/flowerSystem.js).
 *
 * Up to FLOWER_TYPE_COUNT flower types share one painted density texture, one
 * type per channel, so a meadow can mix them. A type is built as real geometry
 * from the numbers below (flowerGeometry.js): petals, a centre, a stem and
 * leaves. No textures.
 *
 * Saved whole with the project (`flowers` manifest key); the load merges per
 * key, so a setting added later keeps its default on an older file.
 */

export const FLOWER_TYPE_COUNT = 4;

/**
 * Type settings that change the MESH (rebuilt on edit); the rest are uniforms.
 * The panel uses this to know which edits need a rebuild.
 */
export const FLOWER_GEOMETRY_KEYS = [
  "petals", "petalLength", "petalWidth", "pointed", "cup", "curl", "doubleLayer",
  "centreSize", "centreHeight", "leaves", "leafSize",
];

/** Presets: a starting point per species. Colours are sRGB hex. */
export const FLOWER_PRESETS = {
  daisy: {
    petals: 16, petalLength: 0.42, petalWidth: 0.34, pointed: 0.1, cup: 0.12, curl: -0.15, doubleLayer: false,
    centreSize: 0.34, centreHeight: 0.12, leaves: 1, leafSize: 0.9,
    petalBase: "#f4f1e6", petalTip: "#ffffff", centre: "#f2b705", veins: 0.25, translucency: 0.5,
    size: 0.32, stemHeight: 0.28,
  },
  poppy: {
    petals: 5, petalLength: 0.46, petalWidth: 0.95, pointed: 0, cup: 0.45, curl: -0.05, doubleLayer: false,
    centreSize: 0.2, centreHeight: 0.18, leaves: 2, leafSize: 1,
    petalBase: "#8a0e0e", petalTip: "#e8261e", centre: "#1d1a14", veins: 0.35, translucency: 0.9,
    size: 0.38, stemHeight: 0.45,
  },
  cosmos: {
    petals: 8, petalLength: 0.46, petalWidth: 0.55, pointed: 0.2, cup: 0.18, curl: -0.1, doubleLayer: false,
    centreSize: 0.22, centreHeight: 0.1, leaves: 1, leafSize: 0.8,
    petalBase: "#c2185b", petalTip: "#f8a5c8", centre: "#f7c948", veins: 0.3, translucency: 0.8,
    size: 0.36, stemHeight: 0.5,
  },
  tulip: {
    petals: 6, petalLength: 0.5, petalWidth: 0.75, pointed: 0.35, cup: 0.9, curl: 0.2, doubleLayer: true,
    centreSize: 0.12, centreHeight: 0.1, leaves: 2, leafSize: 1.4,
    petalBase: "#b8860b", petalTip: "#ff5a36", centre: "#3b2a12", veins: 0.2, translucency: 0.6,
    size: 0.3, stemHeight: 0.42,
  },
  bluestar: {
    petals: 5, petalLength: 0.48, petalWidth: 0.45, pointed: 0.85, cup: 0.25, curl: -0.25, doubleLayer: false,
    centreSize: 0.16, centreHeight: 0.08, leaves: 0, leafSize: 0.7,
    petalBase: "#2f5fd0", petalTip: "#9cc4ff", centre: "#f5f0d0", veins: 0.45, translucency: 0.7,
    size: 0.22, stemHeight: 0,
  },
  sunflower: {
    petals: 22, petalLength: 0.3, petalWidth: 0.3, pointed: 0.6, cup: 0.08, curl: -0.2, doubleLayer: true,
    centreSize: 0.56, centreHeight: 0.08, leaves: 2, leafSize: 1.6,
    petalBase: "#e89a00", petalTip: "#ffd21f", centre: "#3a2412", veins: 0.2, translucency: 0.5,
    size: 0.7, stemHeight: 1.1,
  },
};

function fromPreset(name, preset) {
  return { name, preset, ...structuredClone(FLOWER_PRESETS[preset]) };
}

export function createFlowerState() {
  return {
    types: [
      fromPreset("Daisy", "daisy"),
      fromPreset("Poppy", "poppy"),
      fromPreset("Blue star", "bluestar"),
      fromPreset("Cosmos", "cosmos"),
    ],
    /** Plants kept where the paint is at full strength, 0..1. */
    density: 0.55,
    /** ± fraction of a type's size, per plant. */
    sizeVar: 0.25,
    /** ± colour jitter per plant. */
    colorVar: 0.1,
    /** Clumps and gaps instead of an even spread: how strong, and clump size (m). */
    clumping: 0.7,
    clumpSize: 4,
    /** Rise above painted grass: 1 = the bloom tops the grass blade height. */
    grassLift: 0.8,
    stemBase: "#2e5a1f",
    stemTop: "#5f9a3a",
    /** Light the flowers give off on top of the sun and sky. */
    glowLight: 0.08,
    /** Petals catch the light through them when the sun is behind. */
    translucencyMul: 1,
    flutter: 0.6,
    windMul: 1,
    flex: 0.5,
    interactRadius: 1.2,
    interactStrength: 0.9,
    /** Detailed flowers up to this distance, simple ones beyond (m). */
    lodDistance: 18,
    /** Flowers thin out between these distances from the camera (m). */
    fadeStart: 62,
    fadeEnd: 88,
    /** Terrain normal.y below which flowers stop growing (steep slopes). */
    slopeMinY: 0.7,
    /** Shadows on the detailed flowers (costs a little; far ones never take them). */
    receiveShadows: true,
  };
}
