/**
 * Lakebed (underwater terrain) state — the terrain-side half of the water look,
 * ported from revo-realms' Terrain.ts "WATER" block. Where the water-surface map
 * says a terrain fragment is submerged, the terrain shader blends toward a sand
 * colour, tints it deeper-blue with depth, boosts the shallows, and lays animated
 * caustics on top. Purely cosmetic: no heightmap or geometry involvement.
 *
 * ONE global set for the whole world — it follows every water surface (lakes and
 * River+ alike) via the shared water-surface map, so per-lake values would be a
 * lie. Lives on the lake slice because lakes own the water look; persists with it.
 *
 * All depths are METRES of vertical water above the terrain (waterY - terrainY),
 * unlike revo's normalized units — same reasoning as depthWaterState.
 */
export function createLakebedState(overrides = {}) {
  return {
    enabled: true,

    /** Bed colour. sandMix = how much it replaces the splat-painted terrain (revo: 1). */
    sandColor: "#b38c4a",
    sandMix:   1.0,

    /** Deep-water tint, fully in after tintDepth metres. */
    deepColor: "#3a4b5b",
    tintDepth: 8,

    /** Warm sand highlight that fades IN over the first shallowDepth metres. */
    shallowBoost: 1.0,
    shallowDepth: 1.5,

    // Caustics — the classic iterative-trig water caustic (lakebedTsl.js): a
    // filament net that morphs internally like real refracted sunlight, with
    // optional chromatic dispersion (R/B fringing on the filaments).
    causticsIntensity: 1.5,
    causticsColor:     "#8fb8cc",
    /** Pattern tiles per metre. 0.15 => one ~6.7 m tile, filaments well under that. */
    causticsScale:     0.15,
    /** Final pow shaping: higher pinches the net into thinner, brighter filaments. */
    causticsSharpness: 8,
    /** 0 = white filaments, 1 = strong red/blue fringing. */
    causticsDispersion: 0.5,
    /** Morph rate of the net, in pattern time. ~0.5 reads as gentle sunlight. */
    causticsSpeed:     0.5,
    /** Caustics die out by this depth — light stops reaching the bed. */
    causticsMaxDepth:  7.5,

    /** Metres of depth over which the whole treatment fades in at the waterline. */
    shoreBlend: 0.35,

    ...overrides,
  };
}
