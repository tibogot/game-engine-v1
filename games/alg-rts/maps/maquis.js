// THE FLN TRAINING MAP — LE MAQUIS (2026-10-20, games/alg-rts/FLN_TRAINING_PLAN.md). ?map=maquis.
//
// The FLN's country, small and readable like the French camp (330 m): a djebel valley. You are the FLN
// here (MAP.side) and, CoH's way, you start at the BOTTOM of the screen: the djebel, the maquis camp and its
// cave in the SOUTH (the camera looks north: viewYaw π); the valley in the middle — the mule track down
// through the SCRUB (the hiding lessons), a rocky KNOLL over the road (the ambush spot), a small mechta (the
// village lesson); the ROAD across the north with its telegraph line (the convoys, the sabotage); a French
// post beyond it, seen, never fought for here.
//
// World metres, north = -Z. The ground: tools/algMaquisLevel.mjs → public/levels/alg-maquis.v3proj (from
// these very sites, tracks, knoll and scrub).
import { t } from "../i18n/i18n.js";

/** THE PLAYABLE AREA: 330 m. Outside: the djebel south, low hills round the rest. */
export const PLAY = { x0: -165, x1: 165, z0: -165, z1: 165 };

export const LAYOUT = {
  sites: [
    // ── Starts ──
    { kind: "aln", name: t("Camp du maquis"), x: -20, z: 112, r: 22, turn: -20 },
    { kind: "french", name: t("Poste de la vallée"), x: 20, z: -148, r: 26, turn: 25 },
    // ── The lessons' ground ──
    { kind: "hamlet", name: t("Mechta de l'oued"), x: -82, z: 8, r: 26, turn: 30 },
  ],
  wadis: [],
};

/** THE ROAD (a piste: the telegraph line follows it) and the MULE TRACKS down from the camp. */
const ROAD = [[-210, -100], [-120, -92], [-30, -99], [60, -88], [130, -95], [210, -91]];
const MULE = [[-12, 92], [8, 60], [30, 22], [44, -8], [40, -40], [28, -72], [20, -92]];
const MULE_HAMLET = [[8, 60], [-20, 40], [-52, 22], [-72, 14]];

export const MAP = {
  id: "maquis",
  name: t("Le maquis — instruction FLN"),
  level: "/levels/alg-maquis.v3proj",
  // THE HUMAN IS THE FLN here (algGame setHumanSide), whatever the address says
  side: "fln",
  // the camera looks NORTH: the FLN's camp at the bottom of the screen, the road and the French at the top
  viewYaw: Math.PI,
  tracks: [
    { name: t("La route"), kind: "piste", from: "gate", to: "", length: 420, points: ROAD },
    { name: t("Sentier muletier"), kind: "mule", from: "", to: "", length: 200, points: MULE },
    { name: t("Sentier de la mechta"), kind: "mule", from: "", to: "", length: 90, points: MULE_HAMLET },
  ],
  // one supply point: the spring on the way down
  supply: [{ name: t("Source du ravin"), x: -34, z: 44, res: "mun" }],
  handPlaced: false,
  // THE TRAINING (algTutorialFln.js): the lessons run instead of the AIs and the win rules; no French start
  // army (the lessons bring their French: a patrol, a jeep, a truck, a half-track, the convoy)
  tutorial: true,
  noStartArmy: { player: true },
  systems: { birds: true, civ: true, splats: true, stones: true, poles: true },
  // the ambush knoll over the road (the level tool raises it)
  knoll: { x: 52, z: -42, r: 24, h: 7 },
  // THE SCRUB the lessons hide in (the level paints holm oak, juniper and alfa thick here: concealment)
  scrub: [
    { x: 22, z: 34, r: 30 },     // along the mule track, below the camp
    { x: 30, z: -50, r: 22 },    // the knoll's road side: the ambush
    { x: -48, z: -32, r: 18 },   // west of the mechta
    { x: 96, z: -70, r: 16 },    // the road's verge, east
  ],
  // the lessons' spots (algTutorialFln.js)
  spots: {
    camp: { x: -10, z: 86 },           // the first marker, below the camp
    hide: { x: 6, z: 26 },             // in the scrub, off the track (measured: a solid stretch, concealment 0.85)
    patrolPath: [[-90, -14], [-20, 0], [40, -4], [110, 16]],   // the French foot patrol, past the scrub 25 m out
    ambush: { x: 18, z: -58 },         // the knoll's road side, in the scrub
    knollTop: { x: 52, z: -42 },
    refuge: { x: 70, z: -20 },         // forward, near the road
    roadWest: { x: -150, z: -94 }, roadEast: { x: 160, z: -93 },   // where the French drive in and out
    mine: { x: 10, z: -96 },           // the mine lesson's spot on the road
  },
  minimap: { layers: { 0: [196, 170, 132], 1: [178, 128, 92], 6: [210, 188, 150] } },
  scenery: {
    quantities: {
      outcrops: 4, trees: 6, treeSpacing: 40, deadTrees: 2, betoums: 2, betoumSpacing: 60,
      tamariskGroups: 0, broomClumps: 3, agaveRun: 0, clusters: 5, clusterSpacing: 40,
      sandstone: 8, sandstoneSpacing: 44, sandstoneSiteClear: 28,
    },
    keepClear: [
      { x: -20, z: 112, r: 60 },   // the camp and its cave
      { x: 52, z: -42, r: 16 },    // the knoll's top
      { x: -34, z: 44, r: 14 },    // the spring
      { x: 20, z: -148, r: 40 },   // the post
    ],
  },
  // no doctrines, no wind in the plants (Oued Abdi's rule)
  foliageWind: 0,
  light: { skyProExposure: 0.52, polish: { saturation: 0.8, temperature: 0.08 } },
};
