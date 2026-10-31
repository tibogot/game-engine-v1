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
import { FOOT, HS, house } from "./villageKit.js";

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

/**
 * THE PORT (2026-10-31 — the Blender pieces, PORT_PLAN.md, in place of algPort.js's procedural one; you: "ok commit
 * and go ahead"): the TOWN field's rows (algGame: levelled pads, near / far, garrisons, damage, cover, sight).
 *   the QUAY FRONT   along the line from `FRONT[0]` to `FRONT[1]` (the top of the bay's beach east of the post), its
 *                    fronts toward the sea (the line's left, walking it) — and the camera: the magasin at its west end,
 *                    a lane, the café, the narrow house, a balcony house
 *   the SECOND ROW   across a street behind it; the CHURCH set back on its square in the middle, its tower over the
 *                    quay's roofs
 *   the MOLE         10 m (13 game) lengths out from the beach, the lighthouse at its head; its harbour side west
 *   the BOATS        moored along the mole's harbour side; pulled up on the sand west of its root, heeled
 *   the QUAY'S LIFE  the fish stall by the mole's root, cargo before the magasin, nets drying on the beach
 */
const FRONT = [[26, -69], [76, -91]], MOLE_ROOT = [44, -108], MOLE_LEN = 5;   // (the root at the water's edge: the beach dry to z ≈ -110, measured; the bay only ~3 m deep at the tip)
function portTown() {
  const [[ax, az], [bx, bz]] = FRONT, L = Math.hypot(bx - ax, bz - az), d = [(bx - ax) / L, (bz - az) / L];
  const sea = [d[1], -d[0]];   // the line's left: the fronts' way
  // (u along the line from its start, v inland from it) → world
  const at = (u, v) => [ax + d[0] * u - sea[0] * v, az + d[1] * u - sea[1] * v];
  const facing = (x, z) => [x + sea[0] * 50, z + sea[1] * 50];
  const houses = [], props = [];
  const row = (types, u0, v, states = {}, gap = 0.2) => {
    let u = u0;
    types.forEach((ty, k) => {
      if (ty === null) { u += gap * 15; return; }   // (a lane)
      const [x0, x1, z0, z1] = FOOT[ty].map((q) => q * HS), w = x1 - x0, dd = z1 - z0;
      const [cx, cz] = at(u + w / 2, v + dd / 2 + (k % 2 ? 0.4 : -0.2));   // (the fronts a little in and out)
      houses.push(house(ty, states[k] ?? "intact", cx, cz, ...facing(cx, cz)));
      u += w + gap;
    });
  };
  row(["magasin", null, "cafe", "etroite", "quai"], 0, 0);
  // the second row: the church's square between its houses (the church 19 m wide, its front 9 m behind the street)
  const back = 10.4 + 7;
  row(["quai", "etroite"], -1, back, { 0: "damaged" });
  const [cx, cz] = at(29, back + 9 + 21.6 * HS / 2);
  houses.push(house("eglise", "intact", cx, cz, ...facing(cx, cz)));
  row(["etroite", "quai"], 40.5, back);
  // the quay's life, on the strip before the fronts (v < 0, toward the sea)
  const prop = (ty, u, v, turn = 0) => { const [x, z] = at(u, v); const [tx, tz] = facing(x, z); props.push(house(ty, "intact", x, z, x + (tx - x) * Math.cos(turn) - (tz - z) * Math.sin(turn), z + (tx - x) * Math.sin(turn) + (tz - z) * Math.cos(turn))); };
  prop("caisses", 5, -4.5); prop("caisses", 13, -5.5, 0.6); prop("etal", 33, -5); prop("filets", 46, -9, 0.3); prop("filets", 52, -11, -0.2);
  // THE MOLE: north from its root (a length's +X the way out, so its yaw π/2 — its harbour face, -Z, then west), on the
  // sea (y: the sea level — the model's waterline at its origin); the lighthouse's piece (its body -5..2 m, the round
  // head past it) end to end with the last length
  const [mx, mz] = MOLE_ROOT, Lm = 10 * HS, yaw = Math.PI / 2, out = (t, w = 0) => [mx - w, mz - t];
  const onSea = (ty, t, w, hw, hz, dy = 0, m) => { const [x, z] = out(t, w); props.push([ty, "intact", x, SEA_LEVEL + dy, z, yaw, x, z, hw, hz, m]); };
  for (let i = 0; i < MOLE_LEN; i++) onSea("mole", Lm * (i + 0.5), 0, 5 * HS, 3 * HS);
  onSea("phare", Lm * MOLE_LEN + 5 * HS, 0, 5 * HS, 3 * HS);
  // the boats moored along its harbour side (3 m out from the face), bows out; two of the second colour. `afloat`: the
  // sea kept out of their hulls (algHouse afloatCaps — their floorboards are under the waterline, the swell over them)
  [[24, "barque"], [35, "barque2"], [47, "barque"], [59, "barque2"]].forEach(([t, ty]) => onSea(ty, t, 3 * HS + 2.1, 3.8 * HS, 1.2 * HS, 0, { afloat: true }));
  // pulled up on the sand west of its root (landward: dry), bows to the sea, heeled on their bilge
  [[-14, 12, 0.18, 0.15], [-22, 16, -0.2, -0.3], [-30, 13, 0.16, 0.25]].forEach(([dx, dz, heel, turn], k) => {
    const x = mx + dx, z = mz + dz, th = Math.PI / 2 + turn;
    props.push([k % 2 ? "barque2" : "barque", "intact", x, null, z, th, x, z, 3.8 * HS, 1.2 * HS, { ground: true, lift: 0.3 * HS, heel }]);
  });
  return { houses, props };
}
const PORT = portTown();

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
  // THE PORT (2026-10-31, the Blender pieces — portTown above): the TOWN field's. (The procedural one of 2026-10-16,
  // algPort.js's `port: { front, mole }`, retired from the map; the lab keeps it to compare.)
  town: { houses: PORT.houses, props: PORT.props },
  // THE CAP'S ROCKS (2026-10-16): the slabs in its cliff face and the reef at its foot, placed by the
  // level tool (maps/coastRocks.js), drawn as El Kantara's (algLandmarks / algSandstone), in the
  // Stora capes' ochre-grey. Nothing else of algLandmarks' scenery (a map with `scenery` starts at 0).
  sandstone: { colour: "coast", rocks: ROCKS },
  scenery: { quantities: {}, keepClear: [] },
  // THE MINIMAP's ground (ui/minimap.js), by paint layer (tools/algCoastLevel.mjs): the plain's red
  // earth, the sand, the seabed (under the water's own colour), the maquis, (4 unused), rock, the track.
  minimap: { layers: { 0: [168, 128, 92], 1: [214, 196, 156], 2: [190, 178, 140], 3: [118, 122, 72], 4: [150, 132, 104], 5: [128, 112, 96], 6: [178, 152, 112] } },
};
