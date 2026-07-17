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

    // Caustics — two counter-scrolling Voronoi crack webs (revo samples its
    // noise atlas's "cracks" channel — same pattern), summed and cubed.
    // Scales are Voronoi CELLS per metre: 0.5 => one bright-line cell every 2 m.
    causticsIntensity: 0.35,
    causticsColor:     "#4d6680",
    causticsScale1:    0.35,
    causticsScale2:    0.65,
    /** Cell-units/second each web drifts (in metres: speed / scale). */
    causticsSpeed:     0.6,
    /** Caustics die out by this depth — light stops reaching the bed. */
    causticsMaxDepth:  7.5,

    /** Metres of depth over which the whole treatment fades in at the waterline. */
    shoreBlend: 0.35,

    ...overrides,
  };
}
