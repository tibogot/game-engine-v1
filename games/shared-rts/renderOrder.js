// THE DRAW ORDER of everything SEE-THROUGH in the RTS games — one table.
//
// Transparent things don't write depth, so between two of them the one drawn
// LAST is on top, whatever is really nearer. three draws them by renderOrder
// first (then by distance). A ground layer drawn after something lying ON the
// ground covers it: the alg fields over the smoke, over a sapper's site, over
// the path dots (2026-10-03, you: "it should never happen again"). Every one
// of those had no renderOrder (0) or a guess under the ground layers' 40.
//
// So: pick a BAND from here, never a bare number. tools/renderOrderBandTest.mjs
// fails on a transparent material in games/shared-rts or a game's folder with
// no band, and on a bare number.
//
//   GROUND      painted ON the ground, in this order: fields, tyre marks,
//               craters + blood pools, the cover view (V)
//   ON_GROUND   lies on / hovers just over the ground: selection rings and
//               brackets, path dots, capture rings, searchlight pools, bird
//               shadows, a building being placed
//   AIR         stands in the air: drops, sprites, glass, smoke, flames, tracers
//   HUD         over everything (depthTest off): health bars, debug

export const RENDER_ORDER = {
  // (opaque: the terrain's own 8, the editor decals' 9, water 10 — engine)
  XRAY: 30,      // the units' silhouettes through walls (xraySilhouette.js), opaque queue
  UNITS: 31,     // the units, just after their silhouettes
  FIELDS: 40,
  TRACKS: 41,
  CRATERS: 42,
  POOLS: 42,
  COVER_VIEW: 44,
  ON_GROUND: 46,
  AIR: 49,
  GLASS: 49,
  SMOKE: 50,
  FLAMES: 51,
  TRACERS: 52,
  LIGHTS: 53,    // muzzle flashes, impacts, fire glows: over the smoke
  HUD: 1000,
  HUD_TOP: 1001,
  DEBUG: 998,
};
