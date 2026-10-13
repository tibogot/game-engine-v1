// MAP 3 — "LA PORTE DU DÉSERT", EL KANTARA, 1958. ?map=kantara.
//
// World metres, north up = -Z. The map (public/levels/alg-kantara.v3proj, built by
// tools/algKantaraLevel.mjs from the data below, FROM THE EMPTY BASE — tools/algBaseLevel.mjs; the
// plan: games/alg-rts/TODO.md "MAP 3").
//
// El Kantara's own nickname, Foum es-Sahra: the gorge where the road and the oued come out of the
// grey Aurès onto the Saharan plain. The AURÈS WALL closes the north (scenery, outside the box) and
// the GORGE cuts it; the road runs south from the gorge across the box toward Biskra.
//
// THE GROUND, AS COMPANY OF HEROES 3's DESERT (2026-10-13, the second try — you, its frames: "the
// terrain looks very bad compared to the screenshots"; the first had a flat reg, a plateau walled with
// slabs and canyons — "I'm not sure CoH has this", and it hasn't): ROLLING relief everywhere, broad
// soft hills; in the WEST big crested DUNE HILLS; the colour by the relief (pale crests, red hollows);
// the rock as OUTCROPS and low SHELVES on the hills' shoulders, half buried. The OUED and its PALM
// GROVE in the west, the road through the middle.
//
// PROVISIONAL (step 1, the ground and the look): only the two starts; the points come next.
import { t } from "../i18n/i18n.js";
import { ROCKS } from "./kantaraRocks.js";

/** THE PLAYABLE AREA: 448 m (CoH 2v2 size, 14 × 32 m), starts ~360 m apart. */
export const PLAY = { x0: -224, x1: 224, z0: -224, z1: 224 };

/** The plain's mean height (m); it rises gently to the north (the Aurès' foot). */
export const PLAIN = 20;

/** THE ROLLING GROUND everywhere: two scales of soft hills (amplitude m, wavelength m) — GENTLE: CoH's
 *  desert between the dunes is near flat (frame C: the red ground, the ridges cross it). */
export const HILLS = { amp: 4, wave: 110, amp2: 1.5, wave2: 46 };

/** THE SAND, AS CoH 3's (2026-10-13, you, its frames: "it's not dunes going up down up down — the whole
 *  terrain goes down; more plateaus with a sharp crest"): a raised MASS of sand cut into LEVELS. Each
 *  level a near-flat top, a sharp lip (the crest), a short steep drop to the next level down; the last
 *  level a long apron to the flat red ground. The crests follow the mass's own contours: irregular arcs.
 *  The field in the west and south-west (an ellipse, `mass` m high in its middle, LUMPY ±`lumps` m); RIDGES crossing the
 *  red ground elsewhere (frame 8), `ridges` their share, `ridgeMass` their height (a level or two).
 *  `step` a level's height, `riser` the drop's mean slope (°; its lip ~1.3× that). `wind`: the
 *  frame's tall dunes outside the box (their slip faces away from the afternoon sun). */
export const SAND = { x: -150, z: 110, rx: 150, rz: 150, yaw: -0.35, mass: 4, lumps: 5, step: 1.8, riser: 26, ridges: 0.18, ridgeMass: 2.5, wind: [0.95, -0.3] };

/** THE ROCK: outcrops (a big slab and one to three smaller, along the slope) and low shelves (a row of
 *  low slabs along a contour) on the hills' shoulders, half buried. Fewer in the sand. */
export const ROCK = { outcrops: 30, shelves: 0, spacing: 26, sandShare: 0.35, seed: 1958, scale: 0.55 };   // scale: CoH's rocks are 1-4 m
// (shelves 0: a row of slabs on the open ground read as a LOG, not a ledge — a shelf wants a short
//  terrain step with the slabs sunk into it, as the first try's rims; TODO MAP 3)

/** THE GORGE through the Aurès wall (north, outside the box): its axis and half-width at the floor. */
export const GORGE = { points: [[-52, -600], [-50, -330], [-48, -238]], half: 30 };
/** The frame's big mesas outside the box (east and west). */
export const FAR_MESAS = [{ x: -340, z: -170, r: 52, h: 30 }, { x: 330, z: -120, r: 60, h: 26 }, { x: 350, z: 60, r: 44, h: 20 }];
/** The palm grove (the oasis): an ellipse, the oued through its east side. */
export const GROVE = { x: -112, z: -6, rx: 70, rz: 54, yaw: 0.3 };

export const LAYOUT = {
  sites: [
    // ── Starts (PROVISIONAL) ────────────────────────────────────────────────
    // The bordj on the plain in the south, by the road; the katiba in a hollow in the north-east.
    { kind: "french", name: t("Bordj d'El Kantara"), x: 20, z: 165, r: 34, turn: 35 },
    { kind: "aln", name: t("Katiba du ravin"), x: 160, z: -160, r: 26, turn: -30 },
  ],
  // No oued (2026-10-13): CoH's desert has none, and its grey bed spoiled the sand. The palm grove is
  // a spring oasis. (Oued El Haï ran from the gorge past the grove: in git, 2026-10-13.)
  wadis: [],
};

/** The road: out of the gorge on the oued's west bank, over it at the Roman bridge, south past the
 *  caravanserai, the checkpoint and the bordj, on to Biskra. */
const ROAD = [
  [-64, -500], [-64, -330], [-62, -240], [-58, -184], [-44, -150], [-26, -118], [-6, -62], [6, -18],
  [30, 40], [52, 92], [56, 140], [62, 190], [100, 248], [160, 330], [204, 500],
];

export const MAP = {
  id: "kantara",
  name: t("La porte du désert — El Kantara, 1958"),
  level: "/levels/alg-kantara.v3proj",
  tracks: [{ name: t("Route de Biskra"), kind: "piste", from: "gate", to: t("Katiba du ravin"), length: 520, points: ROAD }],
  supply: [],
  handPlaced: false,
  // WHAT THIS MAP SHOWS (mapSystems.js — one it does not list stays off). PROVISIONAL, as the map.
  systems: { ai: true, fow: true, birds: true, splats: true, stones: true },
  // ITS SPLATS (algSplats: CoH's polish layer — frame 9's red ground: pebbles, gravel, cracked red earth,
  // dust pans, wind streaks; a gravel fringe where the sand thins out). Its paint slots: 0 red ground,
  // 1 red earth, 2 sand, 3 grove, 6 road. `match` high: each patch takes the ground's own colour —
  // they add grain and relief, not the Aurès palette.
  splats: {
    // the photos warmed for the red ground (grey gravel at even 25 % of its own colour read LILAC beside
    // the orange — measured in the game, 2026-10-13)
    mats: {
      sandGrav: { slug: "sandy_gravel", tint: [1.25, 0.82, 0.6] },
      gravel:   { slug: "rocky_gravel", tint: [1.25, 0.82, 0.6] },
      redCrack: { slug: "cracked_red_ground", tint: [1.1, 0.8, 0.62] },
      dust:     { slug: "dry_ground_01", tint: [1.2, 0.92, 0.72] },
      redSand:  { slug: "red_sand", tint: [1.1, 0.85, 0.7] },
    },
    rules: (g) => [
      { mat: "dust", match: 0.55, per100: 0.12, size: [10, 20], aspect: [0.6, 1], opacity: [0.3, 0.55], soft: 0.5, push: 0.2, warp: 0.45, tile: 4,
        where: (p) => p.w[0] * g.clump(p, 60, 0.35) },
      { mat: "sandGrav", match: 0.88, per100: 0.9, size: [2, 6], aspect: [0.5, 1], opacity: [0.5, 0.85], soft: 0.5, push: 0.9, warp: 0.38, tile: 2,
        where: (p) => (p.w[0] + p.w[1] * 0.7) * g.clump(p, 20, 0.6) },
      { mat: "gravel", match: 0.88, per100: 0.5, size: [2, 5], aspect: [0.4, 0.9], opacity: [0.5, 0.85], soft: 0.5, push: 1.0, warp: 0.4, tile: 2,
        where: (p) => p.w[0] * g.clump(p, 30, 0.45) },
      { mat: "redCrack", match: 0.7, per100: 0.35, size: [4, 9], aspect: [0.5, 1], opacity: [0.4, 0.7], soft: 0.5, push: 1.2, warp: 0.45, tile: 3,
        where: (p) => p.w[1] + p.w[0] * p.hollow * p.flat },
      { mat: "redSand", match: 0.6, per100: 0.12, size: [8, 16], aspect: [0.25, 0.5], opacity: [0.3, 0.55], soft: 0.5, push: 0.4, warp: 0.4, tile: 4, windAligned: true,
        where: (p) => p.w[0] * p.flat * g.clump(p, 70, 0.5) },
      { mat: "sandGrav", match: 0.8, per100: 1.2, size: [2, 5], aspect: [0.5, 1], opacity: [0.5, 0.85], soft: 0.4, push: 0.6, warp: 0.45, tile: 2,
        where: (p) => (p.w[2] > 0.15 && p.w[2] < 0.75 ? 1 : 0) },
      { mat: "leaves", match: 0.45, per100: 1.4, size: [3, 7], aspect: [0.6, 1], opacity: [0.6, 0.95], soft: 0.35, push: 0.7, warp: 0.45, tile: 2,
        where: (p) => p.w[3] },
      { mat: "path", per100: 2.2, size: [2, 4.5], aspect: [0.5, 1], opacity: [0.55, 0.85], soft: 0.35, push: 0.8, warp: 0.4, tile: 2,
        where: (p) => (p.w[6] > 0.08 && p.w[6] < 0.6 ? 1 : 0) },
      { mat: "ruts", per100: 0.7, size: [3, 6], aspect: [0.35, 0.6], opacity: [0.35, 0.6], soft: 0.4, push: 0.6, warp: 0.2, tile: 3,
        where: (p) => (p.w[6] > 0.7 ? 1 : 0) },
    ],
  },
  // ITS STONES (algStones: loose stones, sunk, tilted to the slope — frame 9's pebbles on the red ground),
  // a warm sandstone photo so they read against the ground.
  stones: {
    red:      { slot: 0, id: "rock_boulder_cracked", tint: "#e8b48c", per100: 2.2, shapes: [["pebble", 0.65], ["rock", 0.32], ["lump", 0.03]] },
    redEarth: { slot: 1, id: "rock_boulder_cracked", tint: "#d8a07a", per100: 1.2, shapes: [["pebble", 0.6], ["rock", 0.4]] },
    sand:     { slot: 2, id: "rock_boulder_cracked", tint: "#f0c8a0", per100: 0.06, shapes: [["rock", 0.7], ["lump", 0.3]] },
  },
  // ITS LIGHT (algGame MAP_LIGHT, over the Aurès'), MEASURED against CoH 3's desert frames (2026-10-13,
  // assets-src/refs/coh3/camera-default-4/5, the game area: mean RGB ~(197,150,115), luma median
  // 167-173, saturation 0.40-0.45, R/G ~1.3). With the Aurès' light the same sand measured (146,84,45),
  // luma 92, saturation 0.70: dark and orange-brown. A LOW sun still (CoH's shadows are long), the
  // exposure up, the grade near neutral; with the sharp-crested dunes: (203,167,127), luma 180, sat 0.37
  // (frame 4: (202,156,122), 173, 0.39) — then a touch darker and warmer.
  light: {
    timeOfDay: 16.6,   // the sun ~20° up, from the west (CoH's long shadows; 16.2 = 25°, 16.9 = 17°)
    skyProExposure: 1.12,
    // THE SHADE (frames 6-7: a drop's shade is WARM and LIGHT, ~70 % of the lit sand — ours was near black
    // and blue-grey): the sun weaker against the sky's fill, the ground's bounce the sand's own colour.
    // Measured with the stepped sand: (203,165,127), luma 176, sat 0.38 — frame 7 (213,164,127), 177, 0.41.
    skyProSunScale: 0.38,
    polish: { contrast: 1.05, saturation: 0.95, temperature: 0.08 },
    skyPro: { coverage: 0.2, groundAlbedo: "#d2a678" },
  },
  // THE SANDSTONE: El Kantara's (algSandstone SANDSTONE_COLOURS.kantara, the CoH red lifted), the slabs the level tool
  // placed (algLandmarks adds them as it does its own: impassable, hard cover).
  sandstone: { colour: "kantara", rocks: ROCKS },
  // algLandmarks' own scenery: only the slabs above (a map with `scenery` starts at 0 of everything).
  scenery: { quantities: {}, keepClear: [] },
  // THE MINIMAP's ground, by paint layer (tools/algKantaraLevel.mjs).
  minimap: { layers: { 0: [196, 124, 80], 1: [176, 98, 60], 2: [218, 172, 122], 3: [120, 110, 70], 4: [160, 152, 140], 5: [176, 104, 66], 6: [214, 184, 150] } },
};
