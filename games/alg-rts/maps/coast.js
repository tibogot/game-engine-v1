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
// coast down the right edge. The objectives, supply and the AI: 2026-11-01 (LAYOUT below).

/** THE PLAYABLE AREA: 500 m, the sea along its north and west. */
import { t } from "../i18n/i18n.js";
import { FOOT, HS, hamlet, house, koubbaAndCemetery } from "./villageKit.js";

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
    // ── THE OBJECTIVES (2026-11-01, you: "lets go with 1" — the coast playable: its HUD read "villages 0/0"). Seven
    // flagged places, as Oued Abdi's (algUnits: a map with `point` sites fights over those): the French side's three
    // near the post and the sea, two in the middle on the road and the plain, two up toward the katiba. Their kinds
    // are the coast's own — the showroom builds its OLD pieces (wells, a zeriba, the SAS post) for "hamlet", "koubba"…;
    // the kits build these (portTown, COAST_VILLAGES below) ──
    { kind: "port", name: "Port de la Marsa", x: 56, z: -72, r: 40, point: true },
    { kind: "point", name: "Vigie du cap", x: 190, z: -165, r: 16, point: true },        // (the cape's top, 55 m: up its south slope)
    { kind: "village", name: "Mechta Ouled Ali", x: -130, z: 30, r: 30, point: true },   // (the west plain, by the shore)
    { kind: "farm", name: "Ferme Ben Salah", x: 85, z: 40, r: 20, point: true },         // (a farm, east of the road)
    { kind: "point", name: "Carrefour de la route", x: 20, z: 100, r: 16, point: true }, // (on the road, the plain's middle)
    { kind: "village", name: "Mechta des crêtes", x: 175, z: 115, r: 30, point: true },  // (on the ridges' shelf, 39 m)
    { kind: "marabout", name: "Sidi Mabrouk", x: -110, z: 160, r: 14, point: true },     // (the saint's tomb, the FLN's west)
  ],
  // NO WADI (2026-10-13, you: "the carved dry river — I don't think we need it"): it cut the map in two
  // with nothing to fight over. The coast's cover is its villages, walls, vines and tree lines.
  wadis: [],
  // SUPPLY (munitions / fuel, CoH's): spread over the plain between the places, a pair by each start
  supply: [
    { name: "Dépôt de la plage", x: -90, z: -60, res: "mun" },
    { name: "Pompe de la route", x: 10, z: -40, res: "fuel" },
    { name: "Dunes de l'ouest", x: -170, z: -50, res: "fuel" },
    { name: "Pied du cap", x: 130, z: -110, res: "mun" },
    { name: "Gué de la plaine", x: 40, z: 30, res: "mun" },
    { name: "Puits des oliviers", x: -60, z: 60, res: "fuel" },
    { name: "Vignes Ben Salah", x: 130, z: 60, res: "fuel" },
    { name: "Haies de l'ouest", x: -150, z: 110, res: "mun" },
    { name: "Talus des crêtes", x: 100, z: 150, res: "mun" },
    { name: "Col de l'est", x: 210, z: 40, res: "fuel" },
    // the FLN's own pair by the katiba
    { name: "Cache des crêtes", x: 90, z: 215, res: "mun" },
    { name: "Bergerie du col", x: -20, z: 225, res: "fuel" },
  ],
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
const FRONT = [[26, -69], [76, -91]], MOLE_U = 22.3, MOLE_LEN = 7;   // (the mole from the quay before the lane at u 20.8-23.8; the beach dry ~26 m out, the bay ~3 m deep at the tip)
function portTown() {
  const [[ax, az], [bx, bz]] = FRONT, L = Math.hypot(bx - ax, bz - az), d = [(bx - ax) / L, (bz - az) / L];
  const sea = [d[1], -d[0]];   // the line's left: the fronts' way
  // (u along the line from its start, v inland from it) → world
  const at = (u, v) => [ax + d[0] * u - sea[0] * v, az + d[1] * u - sea[1] * v];
  const facing = (x, z) => [x + sea[0] * 50, z + sea[1] * 50];
  const houses = [], props = [];
  // (`quay`: the front row ON the quay — its fronts in one line, the deck meeting each wall, and its pads one level, the
  // quay's: the site "port" — algGame's terraced base, the mean ground of its houses)
  const QUAY = { site: "port", level: 0 };
  const row = (types, u0, v, states = {}, gap = 0.2, quay = false) => {
    let u = u0;
    types.forEach((ty, k) => {
      if (ty === null) { u += gap * 15; return; }   // (a lane)
      const [x0, x1, z0, z1] = FOOT[ty].map((q) => q * HS), w = x1 - x0, dd = z1 - z0;
      const [cx, cz] = at(u + w / 2, v + dd / 2 + (quay ? 0 : k % 2 ? 0.4 : -0.2));   // (else the fronts a little in and out)
      houses.push(quay ? [...house(ty, states[k] ?? "intact", cx, cz, ...facing(cx, cz)), QUAY] : house(ty, states[k] ?? "intact", cx, cz, ...facing(cx, cz)));
      u += w + gap;
    });
  };
  row(["magasin", null, "cafe", "etroite", "quai"], 0, 0, {}, 0.2, true);
  // THE STREET behind it (2026-11-01, port.py rue: 10 × 6 m lengths, 13 × 7.8 game), and the SECOND ROW across it — the
  // church's square between its houses. ONE LEVEL for the whole port (the site "port": the back row stood 0.4-0.8 m up
  // the slope, and a street between the two would have had a bank along it): the street's lengths at it, their ground
  // carved. Behind the magasin (10.9 m deep) the street runs 1.4 m further back than behind the houses (9.1-9.75), so the
  // back row's west houses stand further back too; both stretches end where the square begins (u 19.2 — the setts
  // and the square's flagstones at one height: overlapped, they z-fought).
  const SW = 6 * HS, U_SQ = 19.2, V_W = 10.92 + 0.05, V_E = 17.4 - SW - 0.05;
  const street = (u, v0) => { const [x, z] = at(u, v0 + SW / 2); props.push([...house("rue", "intact", x, z, ...facing(x, z)), { ...QUAY, pad: false, carve: true }]); };
  for (let i = 0; i < 2; i++) street(U_SQ - 13 * (i + 0.5), V_W);
  for (let i = 0; i < 3; i++) street(U_SQ + 13 * (i + 0.5), V_E);
  row(["quai", "etroite"], -1, V_W + SW + 0.05, { 0: "damaged" }, 0.2, true);
  // the church, its front 9.75 m behind the street (the square's depth): its steps on the square
  const SQ0 = 17.4, [cx, cz] = at(29, SQ0 + 7.5 * HS + 21.6 * HS / 2);
  houses.push([...house("eglise", "intact", cx, cz, ...facing(cx, cz)), QUAY]);
  // ITS SQUARE (port.py place, 7.5 m: 9.75 game): two before its steps — on a pad at the port's level (the ground falls
  // away before the church: carved alone, the paving stood up as a slab), the ground under the paving then carved below it
  for (const du of [-1, 1]) { const [x, z] = at(29 + du * 3.75 * HS, SQ0 + 3.75 * HS); props.push([...house("place", "intact", x, z, ...facing(x, z)), { ...QUAY, carve: true }]); }
  row(["etroite", "quai"], 40.5, SQ0, {}, 0.2, true);
  // THE QUAY (port.py pave: 10 × 8 m lengths, 13 × 10.4 game) under the front row, end to end from just past the magasin's
  // end to past the last house: the deck at the row's level (no pad of its own: the sand under it CARVED below it —
  // algGame `carve` — its wall showing where the beach falls away to the sea)
  const onQuay = { ...QUAY, pad: false };
  const [px0, px1, pz0, pz1] = FOOT.pave.map((q) => q * HS);
  for (let i = 0; i < 5; i++) { const [x, z] = at(-5 + (px1 - px0) * (i + 0.5), -(pz1 - pz0) / 2); props.push([...house("pave", "intact", x, z, ...facing(x, z)), { ...onQuay, carve: true }]); }
  // the quay's life, on the deck before the fronts (v < 0, toward the sea) at its level; the nets on the sand below it
  const prop = (ty, u, v, turn = 0, m) => { const [x, z] = at(u, v); const [tx, tz] = facing(x, z); const r = house(ty, "intact", x, z, x + (tx - x) * Math.cos(turn) - (tz - z) * Math.sin(turn), z + (tx - x) * Math.sin(turn) + (tz - z) * Math.cos(turn)); props.push(m ? [...r, m] : r); };
  prop("caisses", 5, -4.5, 0, onQuay); prop("caisses", 13, -5.5, 0.6, onQuay); prop("etal", 33, -5, 0, onQuay);
  for (const u of [8, 41, 58]) prop("lampadaire", u, -8.6, 0, onQuay);   // (along the sea edge, behind the coping)
  prop("filets", 46, -14, 0.3); prop("filets", 52, -16, -0.2);
  // THE MOLE, OUT FROM THE QUAY (2026-10-31, you: "do what you think would look the best" — it stood alone 15 m out on
  // the sand): square to the quay's sea edge, from before the lane between the magasin and the café, its deck LEVEL with
  // the quay's (`dy`: the model's deck is 2.25 m over its origin, the waterline — so that sits 0.46 m under the sea, in
  // its weed). A length's +X the way out: its yaw turns +X onto `sea`; its harbour face (-Z) then looks west, to the
  // magasin's end. The lighthouse's piece (its body -5..2 m, the round head past it) end to end with the last length.
  const Lm = 10 * HS, yaw = Math.atan2(-sea[1], sea[0]), harbour = [-d[0], -d[1]];
  const [mx, mz] = at(MOLE_U, -(pz1 - pz0));   // (the quay's sea face)
  const out = (t, w = 0) => [mx + sea[0] * t + harbour[0] * w, mz + sea[1] * t + harbour[1] * w];
  const onMole = { ...QUAY, pad: false, dy: 0.03 * HS - (1.7 + 0.03) * HS };   // (the flagstones' tops: the quay's 0.03, the mole's DECK + 0.03)
  const mole = (ty, t) => { const [x, z] = out(t); props.push([ty, "intact", x, null, z, yaw, x, z, 5 * HS, 3 * HS, onMole]); };
  for (let i = 0; i < MOLE_LEN; i++) mole("mole", Lm * (i + 0.5));
  mole("phare", Lm * MOLE_LEN + 5 * HS);
  // the boats moored along its harbour side (3 m out from the face), bows out, past where the sand ends; two of the second
  // colour. `afloat`: the sea kept out of their hulls (algHouse afloatCaps — their floorboards are under the waterline)
  [[36, "barque"], [47, "barque2"], [59, "barque"], [71, "barque2"]].forEach(([t, ty]) => {
    const [x, z] = out(t, 3 * HS + 2.1);
    props.push([ty, "intact", x, SEA_LEVEL, z, yaw, x, z, 3.8 * HS, 1.2 * HS, { afloat: true }]);
  });
  // pulled up on the sand west of the mole (landward: dry), bows to the sea, heeled on their bilge
  [[30, -96, 0.18, 0.15], [22, -92, -0.2, -0.3], [14, -95, 0.16, 0.25]].forEach(([x, z, heel, turn], k) => {
    const th = Math.PI / 2 + turn;
    props.push([k % 2 ? "barque2" : "barque", "intact", x, null, z, th, x, z, 3.8 * HS, 1.2 * HS, { ground: true, lift: 0.3 * HS, heel }]);
  });
  return { houses, props };
}
const PORT = portTown();

/**
 * THE COAST'S VILLAGES (2026-11-01, the objectives): the mechta kit's houses as Oued Abdi's (villageKit hamlet), TURNED
 * (`flip`: written fronts to +Z for the Aurès' camera; this one looks south, so a front faces -Z). Each house its own
 * pad; garrisons, damage, cover, sight as every town house.
 */
const at = (name) => LAYOUT.sites.find((s) => s.name === name);
const OA = at("Mechta Ouled Ali"), FR = at("Ferme Ben Salah"), CR = at("Mechta des crêtes"), SM = at("Sidi Mabrouk");
const COAST_VILLAGES = [
  // MECHTA OULED ALI (the west plain): two rows behind a small square, a house at each side of it, a yard, a lean-to and
  // an oven; one house shelled
  hamlet(OA.x, OA.z, { flip: true,
    rows: [{ types: ["petite", "etage", "petite"], x: -11, z: -6, states: { 2: "damaged" } }, { types: ["etage", "petite", "petite"], x: -13, z: -18, yards: [1] }],
    sides: [{ type: "etage", x: -15.5, z: 2 }, { type: "petite", x: 15, z: 0.5 }],
    props: [{ type: "appentis", x: 16, z: -9 }, { type: "tabouna", x: -7, z: 3 }] }),
  // FERME BEN SALAH (the plain's middle, east of the road): the farmhouse and its neighbour, their yard, the lean-to, the
  // threshing floor out front, the sheepfold beside
  hamlet(FR.x, FR.z, { flip: true,
    rows: [{ types: ["etage", "petite"], x: -14, z: 2, gap: 1.5, yards: [0] }],
    props: [{ type: "appentis", x: 5, z: -1 }, { type: "aire", x: -4, z: 13 }, { type: "bergerie", x: 18, z: 2 }] }),
  // MECHTA DES CRÊTES (the ridges' shelf, the FLN's side): a short row, a house on the square's side — shelled —, an oven
  hamlet(CR.x, CR.z, { flip: true,
    rows: [{ types: ["etage", "petite", "etage"], x: -12, z: -5 }],
    sides: [{ type: "petite", x: 14, z: 1, state: "damaged" }],
    props: [{ type: "tabouna", x: -6, z: 3 }, { type: "appentis", x: -16, z: 2 }] }),
  // SIDI MABROUK: the koubba, its door to the camera; the village's dead before it (north)
  { houses: [], props: koubbaAndCemetery(SM.x, SM.z, SM.x + 4, SM.z - 22, { seed: 1955, cols: 5, rows: 3, face: -1 }) },
];

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
  supply: LAYOUT.supply,
  // the briefing's list of the places (algBattle: a map with flagged objectives)
  places: t("le port, des villages, une ferme, un carrefour, la vigie du cap, un marabout"),
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
  // (+ its villages, the objectives: COAST_VILLAGES)
  town: { houses: [...PORT.houses, ...COAST_VILLAGES.flatMap((v) => v.houses)], props: [...PORT.props, ...COAST_VILLAGES.flatMap((v) => v.props)] },
  // THE CAP'S ROCKS REMOVED (2026-11-01, you: "the rocks we added on it — it looks bad, so remove them"): the slabs of
  // 2026-10-16 (tools/algCoastLevel.mjs still writes maps/coastRocks.js; the map no longer places them). Nothing of
  // algLandmarks' scenery (a map with `scenery` starts at 0).
  scenery: { quantities: {}, keepClear: [] },
  // THE MINIMAP's ground (ui/minimap.js), by paint layer (tools/algCoastLevel.mjs): the plain's red
  // earth, the sand, the seabed (under the water's own colour), the maquis, (4 unused), rock, the track.
  minimap: { layers: { 0: [168, 128, 92], 1: [214, 196, 156], 2: [190, 178, 140], 3: [118, 122, 72], 4: [150, 132, 104], 5: [128, 112, 96], 6: [178, 152, 112] } },
};
