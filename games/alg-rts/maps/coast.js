// MISSION 2 — THE NORTH CONSTANTINOIS COAST, AUGUST 1955 (the Philippeville
// uprising, the El Halia mine). ?map=coast.
//
// World metres, north up = -Z. The map (public/levels/alg-coast.v3proj, built by
// tools/algCoastLevel.mjs from the data below).
//
// THE NEW GROUND (2026-10-12, you: "smaller like CoH, a bit more flat; the sea should take more of
// the map — we barely see it"; the real-coast cut of 2026-10-04 is in git): shaped for play,
// inspired by the bay of Philippeville. The SEA along the whole north edge and down the west side
// (about a third of the box), a curved BAY biting into the land in the north-west, a rocky HEADLAND
// jutting north in the north-east, a sandy BEACH all along, a flat coastal PLAIN, low RIDGES in the south-east (the FLN's side), hills
// framing it outside the box. Sea level 30 m (the heightmap can't go below 0: the deep needs room).
//
// PROVISIONAL: the starts below only let the map load (the view needs both); the post, the ALN
// start, the points and the AI are the mission's next step.

/** THE PLAYABLE AREA: 500 m, the sea along its north and west. */
export const PLAY = { x0: -250, x1: 250, z0: -250, z1: 250 };

/** The sea level (m) — the level tool's, and the game sea's (algSea.js) through the level. */
export const SEA_LEVEL = 30;

/**
 * THE SHORE, walked with the SEA ON THE LEFT (land on the right): from the south-west round the bay
 * and the headland to the east. The level tool smooths it (Catmull-Rom) and measures every point's
 * signed distance to it.
 */
export const SHORE = [
  [-330, 200], [-232, 150], [-205, 70], [-200, -20], [-178, -92], [-128, -118],
  [-70, -102], [-28, -88], [18, -100], [70, -128], [112, -150],   // the bay, its bottom at x ≈ -30
  [138, -178], [160, -214], [196, -230], [232, -214], [252, -186], // the headland, jutting north
  [282, -172], [360, -176],
];

export const LAYOUT = {
  sites: [
    // ── Starts (PROVISIONAL) ────────────────────────────────────────────────
    // The post on the plain in the south-west, by the coast road; the ALN on the ridges inland.
    { kind: "french", name: "Poste de la plage", x: -125, z: 165, r: 34, turn: 35 },
    { kind: "aln", name: "Katiba des crêtes", x: 175, z: 45, r: 26, turn: -30 },
  ],
  // NO WADI (2026-10-13, you: "the carved dry river — I don't think we need it"): it cut the map in two
  // with nothing to fight over. The coast's cover is its villages, walls, vines and tree lines.
  wadis: [],
};

/** The coast road: the post, north to the bay's little port, east along the shore, up to the ridges. */
const TRACK = [[-118, 140], [-120, 80], [-100, 10], [-62, -48], [-15, -60], [40, -70], [95, -45], [140, 0], [172, 30]];

export const MAP = {
  id: "coast",
  name: "Côte du Constantinois — août 1955",
  level: "/levels/alg-coast.v3proj",
  tracks: [{ name: "Route de la côte", kind: "piste", from: "gate", to: "Katiba des crêtes", length: 420, points: TRACK }],
  supply: [],
  handPlaced: false,
  // WHAT THIS MAP SHOWS (mapSystems.js — one it does not list stays off). PROVISIONAL, as the map:
  // the battle's own (the FLN's AI, the fog of war); its scenery chosen when the coast is built —
  // not the Aurès' by default (2026-10-12, the cleanup).
  systems: { ai: true, fow: true },
  // THE GAME'S OWN SEA (algSea.js) instead of Ocean Pro (2026-10-12): drawn for the RTS camera, at
  // this level (the level file carries no ocean; algGame answers the sea level to every system).
  sea: { level: SEA_LEVEL },
  // THE MINIMAP's ground (ui/minimap.js), by paint layer (tools/algCoastLevel.mjs): the plain's red
  // earth, the sand, the seabed (under the water's own colour), the maquis, (4 unused), rock, the track.
  minimap: { layers: { 0: [168, 128, 92], 1: [214, 196, 156], 2: [190, 178, 140], 3: [118, 122, 72], 4: [150, 132, 104], 5: [128, 112, 96], 6: [178, 152, 112] } },
};
