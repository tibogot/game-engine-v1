// THE TRAINING MAP — CAMP D'INSTRUCTION (2026-10-09, you: "a first mission that teaches the
// basics, on another terrain, smaller, simple — aerial grass, aerial rock"). ?map=training.
//
// World metres, north up = -Z. The map (public/levels/alg-training.v3proj, built by
// tools/algTrainingLevel.mjs from these very sites and track): a near-flat green plain of
// 330 m with gentle swells, one knoll (the high-ground lesson), hills framing it outside the
// box. The post in the south, the practice hamlet in the middle, a supply depot on the track,
// the FLN's ground in the north. Small and readable: everything a lesson needs is on screen.
import { t } from "../i18n/i18n.js";

/** THE PLAYABLE AREA: 330 m. Outside: the framing hills. */
export const PLAY = { x0: -165, x1: 165, z0: -170, z1: 165 };

export const LAYOUT = {
  sites: [
    // ── Starts ────────────────────────────────────────────────────────────────
    { kind: "french", name: t("Camp d'instruction"), x: 0, z: 118, r: 34, turn: 30 },
    { kind: "aln", name: t("Bande du FLN"), x: 10, z: -140, r: 22, turn: -30 },
    // ── The lessons' ground ──────────────────────────────────────────────────
    // The practice hamlet: the capture lesson, then the final defence.
    { kind: "hamlet", name: t("Mechta d'exercice"), x: -40, z: -12, r: 38, turn: 35 },
  ],
  wadis: [],
};

/** The track: the post's gate north to the hamlet and on toward the FLN's ground (algTracks resamples it). */
const TRACK = [[2, 98], [6, 70], [-4, 40], [-20, 14], [-26, -6], [-14, -46], [2, -86], [8, -120]];

// THE PRACTICE HAMLET IN THE NEW HOUSES (2026-10-22, TRAINING_CAMP_PLAN.md step 1): five whitewashed houses (the
// kit's four types, algHouse) round a small square at the hamlet's site — the town field, as Oued Abdi's: the
// garrison lesson's houses DAMAGE AND COLLAPSE (algTownDamage); one already damaged (what a shell does). Rows as
// abdiTown.js — [type, state, x, y, z, yaw, fx, fz, hx, hz]; y null: the ground under it (algGame levels a pad).
const HS = 1.3;
const FOOT = { maison: [-3.8, 8.45, -3.5, 3.0], haute: [-2.6, 2.6, -3.7, 2.8], cour: [-3.4, 3.4, -4.2, 5.0], boutique: [-4.6, 4.6, -3.6, 2.6] };
const rotY = (th, lx, lz) => [lx * Math.cos(th) + lz * Math.sin(th), -lx * Math.sin(th) + lz * Math.cos(th)];
function houseRow(type, state, cx, cz, towardX, towardZ) {
  const [x0, x1, z0, z1] = FOOT[type].map((v) => v * HS), th = Math.atan2(-(towardX - cx), -(towardZ - cz));
  const [ox, oz] = rotY(th, (x0 + x1) / 2, (z0 + z1) / 2);
  return [type, state, cx - ox, null, cz - oz, th, cx, cz, (x1 - x0) / 2, (z1 - z0) / 2];
}
// An ARC on the north side of a small square that opens SOUTH (toward the camera): every front faces the player at
// three-quarters (you: buildings face the camera), a gap between each (a full ring crowded them; a north–south lane
// showed their sides). [type, state, angle (deg, from the square's centre; -90 = north)]
const SQ = { x: -42, z: -4 }, R = 22;
const HAMLET_HOUSES = [["haute", "damaged", -165], ["cour", "intact", -128], ["maison", "intact", -91], ["boutique", "intact", -52], ["haute", "intact", -15]]
  .map(([ty, st, a]) => houseRow(ty, st, SQ.x + R * Math.cos((a * Math.PI) / 180), SQ.z + R * Math.sin((a * Math.PI) / 180), SQ.x, SQ.z));

export const MAP = {
  id: "training",
  name: t("Camp d'instruction — 1956"),
  level: "/levels/alg-training.v3proj",
  tracks: [{ name: t("Piste du camp"), kind: "piste", from: "gate", to: t("Mechta d'exercice"), length: 230, points: TRACK }],
  // One supply depot beside the track: the "points pay" lesson.
  supply: [{ name: t("Dépôt de munitions"), x: 48, z: 36, res: "mun" }],
  handPlaced: false,
  // THE TRAINING (algTutorial.js): the lessons run instead of the FLN's AI and the win rules.
  tutorial: true,
  // the practice hamlet's houses (the old merged mechta not placed on this map: showroom.js replacesHamlet)
  town: { houses: HAMLET_HOUSES, replacesHamlet: true },
  // THE PRACTICE RANGE by the post (TRAINING_CAMP_PLAN step 2): what the sappers build, stood finished — your sandbag
  // walls, the wire, a crewed MG nest; the mortar pit as a set piece ("mortarPit2": not a gun that would shell the lessons)
  // (on clear ground EAST of the post, off the gate where the squads start: the wire and walls in a line facing north,
  // the nest and the pit behind them — world x, z; yaw 0 faces north, -Z)
  range: {
    sandbags1: { at: [44, 112], yaw: 0 }, sandbags2: { at: [52, 113], yaw: -0.08 }, wire1: { at: [44, 104], yaw: 0 }, wire2: { at: [53, 104.5], yaw: 0.05 },
    mgNest: { at: [48, 124], yaw: 0 }, mortarPit: { as: "mortarPit2", at: [62, 128], yaw: 0 },
  },
  // WHAT THIS MAP SHOWS (mapSystems.js — one it does not list stays off): the birds, the
  // villagers (the mechta's people, the shepherd's lesson), the ground's splats, stones and macro
  // photo. Not the Aurès' farmsteads, fields, herds, hens, village life or telegraph; no FLN AI
  // (the lessons bring their enemies), no fog of war. Its own rocks and trees: `scenery` below.
  systems: { birds: true, civ: true, splats: true, stones: true, macro: true },
  // The knoll (the high-ground / cover lesson), as the level tool raises it.
  knoll: { x: 70, z: -58, r: 30, h: 5 },
  // A FARMSTEAD west of the track (algGame.js places it; algCivilians puts its "shepherd" there —
  // the moussebel of the shepherd's lesson). `turn`: off the camera's three-quarter view.
  farmsteads: [{ x: -58, z: 64, turn: 0.5 }],
  // THE MINIMAP's ground (ui/minimap.js): the paint layers' colours (0 grass, 1 dusty earth,
  // 6 the track), not the Aurès' ochre by height — on a flat plain that was one brown.
  minimap: { layers: { 0: [104, 124, 62], 1: [158, 134, 96], 6: [178, 152, 112] } },
  // THE SCENERY (2026-10-12, you: "some big rocks like the building lab's, a bit more trees, palms
  // and foliage — nothing much, it's the training camp, but it should look fine"). algLandmarks'
  // rocks and lone trees, a FEW of each (the Aurès' counts are 3-10x), kept off the lessons'
  // ground; the bushes and palm clumps are the level's plant paint (tools/algTrainingLevel.mjs,
  // the same circles). No farmsteads or ruins: the training keeps its one.
  scenery: {
    quantities: {
      outcrops: 3, trees: 9, treeSpacing: 38, deadTrees: 0, betoums: 3, betoumSpacing: 55,
      tamariskGroups: 0, broomClumps: 4, agaveRun: 0.5, clusters: 7, clusterSpacing: 38,
      sandstone: 6, sandstoneSpacing: 48, sandstoneSiteClear: 28,
    },
    keepClear: [
      { x: 0, z: 118, r: 70 },     // the post, its vehicle park and helipad
      { x: 48, z: 36, r: 20 },     // the supply depot (the points lesson)
      { x: 70, z: -58, r: 18 },    // the knoll's top (the high-ground lesson)
      { x: -58, z: 64, r: 20 },    // the farmstead (the shepherd's lesson)
      { x: 10, z: -140, r: 34 },   // the FLN's ground
    ],
  },
};
