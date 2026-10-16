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
// THE AXIS (2026-10-16, you: "in CoH you start at the bottom of the map, the enemy at the top"): the
// camera looks SOUTH, from the sea inland — the French hold the coast at the BOTTOM of the screen
// (the post behind the bay, the port between it and the sea: their rear), the FLN come down from
// the ridges at the TOP. The cap (north-east) bottom-left, its cliffs facing the camera; the west
// coast down the right edge. Points and the AI: the mission's next step.

/** THE PLAYABLE AREA: 500 m, the sea along its north and west. */
import { ROCKS } from "./coastRocks.js";

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
    // ── Starts: the post at the bottom (behind the bay), the katiba at the top (the ridges) ──
    { kind: "french", name: "Poste de la plage", x: -40, z: -20, r: 34, turn: 35 },
    { kind: "aln", name: "Katiba des crêtes", x: 40, z: 205, r: 26, turn: -30 },
  ],
  // NO WADI (2026-10-13, you: "the carved dry river — I don't think we need it"): it cut the map in two
  // with nothing to fight over. The coast's cover is its villages, walls, vines and tree lines.
  wadis: [],
};

/** The road: from the post's gate (its north side, toward the bay and the port), round its east side
 *  and south across the plain, up into the ridges to the katiba. */
const TRACK = [[-40, -62], [5, -52], [22, -10], [24, 45], [14, 100], [22, 150], [36, 186]];

export const MAP = {
  id: "coast",
  viewYaw: 0,   // the camera looks south: the post at the bottom, the katiba at the top (layout.js)
  // THE SUN FROM BEHIND THE CAMERA (2026-10-16): looking south, the afternoon sun stood at the
  // camera's right and a little in front — the shadows fell toward the camera, backlit. Its path
  // turned 45°: it lights from the back-right (north-west), the shadows fall away up the screen.
  light: { sunTurn: 45 },
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
  // THE PORT (algPort.js, 2026-10-16): its quay front along the top of the bay's beach east of the post
  // (the magasin west, the houses east, facing the sea), the mole out from the beach into the bay.
  port: { front: { from: [26, -69], to: [76, -91] }, mole: { root: [44, -99], dir: 0, len: 75 } },   // (east of the road from the gate and of the post's helipad)
  // THE CAP'S ROCKS (2026-10-16): the slabs in its cliff face and the reef at its foot, placed by the
  // level tool (maps/coastRocks.js), drawn as El Kantara's (algLandmarks / algSandstone), in the
  // Stora capes' ochre-grey. Nothing else of algLandmarks' scenery (a map with `scenery` starts at 0).
  sandstone: { colour: "coast", rocks: ROCKS },
  scenery: { quantities: {}, keepClear: [] },
  // THE MINIMAP's ground (ui/minimap.js), by paint layer (tools/algCoastLevel.mjs): the plain's red
  // earth, the sand, the seabed (under the water's own colour), the maquis, (4 unused), rock, the track.
  minimap: { layers: { 0: [168, 128, 92], 1: [214, 196, 156], 2: [190, 178, 140], 3: [118, 122, 72], 4: [150, 132, 104], 5: [128, 112, 96], 6: [178, 152, 112] } },
};
