// LES AURÈS — 1956, REBUILT (2026-10-22, you: "keep the old Aurès as legacy … maybe we need a new Aurès because the
// terrain itself is cool"). THE SAME GROUND AND LAYOUT as the old map (maps/aures.js — untouched, the legacy map: its
// level file, its sites, wadis, tracks, supply points, gardens and terraces), with what stands on it REBUILT from the
// new kits, village by village:
//   · the merged procedural villages (the two mechtas, the dechra, the ksar) are left out (MAP.skip) and each is
//     rebuilt as SEPARATE houses of the Blender kits (algHouse.js) in the map's TOWN field — garrisons, damage and
//     collapse (algTownDamage) from day one, each on its own levelled pad (algGame: a row without a baked height);
//   · the old gardens, terraces and threshing floors left out too: the Oued Abdi's FIELDS in their place (tools/
//     algAuresNewFields.mjs: soil decals and barley in the map's OWN copy of the level, alg-aures-new.v3proj; the
//     Blender dry-stone walls and the prickly-pear hedges in MAP.fields);
//   · the rest arrives as it is rebuilt (the post, the stone dechra kit, the field walls, the stones…).
// ?map=auresNew (the menu's "Les Aurès — 1956"; the old map is "Les Aurès (ancien)"). Plan: games/alg-rts/AURES_NEW_PLAN.md.
import { LAYOUT as OLD_LAYOUT, MAP as OLD_MAP, PLAY as OLD_PLAY } from "./aures.js";
import { t } from "../i18n/i18n.js";
import { COVER_CLEAR, COVER_ROCKS, FIELD_HEDGES, FIELD_PLOTS, FIELD_WALLS } from "./auresNewFields.js";
import { hamlet, house, koubbaAndCemetery, terraced, village } from "./villageKit.js";

// THE PLAY BOX, TIGHTER (2026-10-24, you: "the Aurès is quite a big map for an RTS compared to Company of Heroes … we
// might adapt it"; "make the best, our inspiration is CoH 3"). The old 610 x 610 m kept its empty north-east and far
// south — nothing to hold there, ground only crossed. The north edge in from -285 to -225 (the katiba camp at -162
// keeps its back), the south from 325 to 280 (the post and the helipad keep theirs): 610 x 505 m. Its soldiers run
// 5.5 m/s — post to the far villages ~60 s, CoH's rhythm. What is left gets its COVER (tools/algAuresNewFields.mjs).
export const PLAY = { ...OLD_PLAY, z0: -225, z1: 280 };
export const LAYOUT = OLD_LAYOUT;

const site = (name) => OLD_LAYOUT.sites.find((s) => s.name === name);
const OA = site("Mechta Ouled Ali"), EO = site("Mechta el Oued"), DE = site("Dechra Tighanimine"), KS = site("Ksar el Hamra");

// THE TWO MECHTAS: the whitewashed kit, five or six houses round each square (one shelled)
// — or, with ?mechta=1 (2026-10-27, MECHTA_PLAN.md: the Aurès' own STONE houses, waiting for your verdict), the mechta
// kit as a CLUSTER (hamlet() above): two rows behind a small square, a house on each side of it; one shelled, one a ruin
// (THE DEFAULT since 2026-10-27 — you: "ok lets go ahead as long as old aures didnt change"; ?mechta=0: the old stand-ins, to compare)
const STONE_MECHTA = typeof location === "undefined" || new URLSearchParams(location.search).get("mechta") !== "0";
// (the back row closed by the HILLSIDE house, yards behind two of its houses, a lean-to at each row's end, an oven in the square)
const STONE_OA = STONE_MECHTA && hamlet(OA.x, OA.z, {
  rows: [{ types: ["petite", "etage", "petite"], x: -12, z: -6 },
    { types: ["etage", "petite", "pente"], x: -14, z: -18, states: { 0: "damaged" }, yards: [0, 2] }],
  sides: [{ type: "petite", x: -15.5, z: 1 }, { type: "petite", x: 15.5, z: 0, state: "ruin" }],
  props: [{ type: "appentis", x: 14.8, z: -8.2 }, { type: "appentis", x: -16.7, z: -20.2 }, { type: "tabouna", x: 8, z: 2 }] });
const STONE_EO = STONE_MECHTA && hamlet(EO.x, EO.z, {
  rows: [{ types: ["etage", "petite"], x: -8.5, z: -6, states: { 1: "ruin" } },
    { types: ["petite", "pente", "petite"], x: -12, z: -17.5, yards: [1] }],
  sides: [{ type: "petite", x: -13.5, z: 0.5, state: "damaged" }],
  props: [{ type: "appentis", x: 11.0, z: -8.2 }, { type: "tabouna", x: 6, z: 2 }] });
const MECHTA_OA = STONE_OA ? STONE_OA.houses : village(OA.x, OA.z, ["cour", "maison", "haute", "boutique", "cour", "haute"], { ring: [30, -178, -2], damaged: 2 });
const MECHTA_EO = STONE_EO ? STONE_EO.houses : village(EO.x, EO.z, ["haute", "cour", "maison", "boutique", "haute"], { ring: [27, -178, -2], damaged: 3 });
// THE STONE DECHRA (?dechra=1 while you judge it — DECHRA_PLAN.md): four terraces up the slope (it falls toward
// +0.6 x +0.8 z, ~17°: measured), the mechta's houses shoulder to shoulder on each, a retaining wall along every
// terrace with steps through it; the DJEMAA square (the village's point) in the second row's gap; the MOSQUE at the top,
// its minaret the landmark. One house shelled, one a ruin.
// (THE DEFAULT since 2026-10-27; ?dechra=0: the M'zab stand-ins, to compare)
const STONE_DECHRA = typeof location === "undefined" || new URLSearchParams(location.search).get("dechra") !== "0";
const STONE_DE = STONE_DECHRA && terraced("DE", DE.x, DE.z, [0.6, 0.8], {
  rows: [
    { types: ["petite", "etage", "petite", "etage"], u: -17, v: 17, level: 0 },
    { types: ["etage", "petite"], u: -23, v: 4, level: 1, states: { 1: "damaged" } },   // (the square between)
    { types: ["petite", "pente"], u: 6, v: 4, level: 1 },
    { types: ["petite", "etage", "petite", "etage", "petite"], u: -20, v: -9, level: 2, states: { 3: "ruin" } },
    { types: ["petite", "masjid", "petite"], u: -14.5, v: -22, level: 3 },
  ],
  walls: [
    { u0: -21.77, v: 5.6, level: 1, n: 4 }, { u0: 2.27, v: 5.6, level: 1, n: 4 },
    { u0: -24.6, v: -7.4, level: 2, n: 5 }, { u0: 4.6, v: -7.4, level: 2, n: 4 },
    { u0: -16.7, v: -20.4, level: 3, n: 3 }, { u0: 2.1, v: -20.4, level: 3, n: 3 },
  ],
  props: [
    { type: "escalier", u: 0.65, v: 6.64, level: 0, pad: false }, { type: "escalier", u: 3.0, v: -6.37, level: 1, pad: false },
    { type: "escalier", u: 0.5, v: -19.36, level: 2, pad: false },
    { type: "djemaa", u: -3, v: -2, level: 1 }, { type: "tabouna", u: 4, v: 1.5, level: 1 },
  ] });
// (without ?dechra=1: the M'zab kit's plain houses as before, two rows)
const DECHRA = STONE_DE ? STONE_DE.houses : [
  ...village(DE.x, DE.z, ["bas", "dar", "bas", "terrasse", "bas"], { ring: [21, -170, -10] }),
  ...village(DE.x, DE.z, ["dar", "bas", "dar", "tour", "dar", "bas"], { ring: [37, -165, -15], damaged: 4 }),
];
// THE KSAR on its knoll: the mosque on the summit, two rings of M'zab houses round it (the town of the Ghardaïa photo)
const KSAR = [
  house("mosquee", "intact", KS.x, KS.z, KS.x, KS.z + 30),
  ...village(KS.x, KS.z, ["dar", "tour", "dar", "terrasse", "dar", "tour"], { ring: [24, -205, 25], gap: 3 }),
  ...village(KS.x, KS.z, ["dar", "bas", "tour", "dar", "terrasse", "dar", "bas", "dar"], { ring: [40, -210, 30], gap: 3.5, damaged: 5 }),
];

// THE KOUBBA AND ITS CEMETERY in the mechta kit (2026-10-29 — REMAINING.md 8; the old procedural pair left out, MAP.skip):
// the marabout's tomb on its crest facing the camera (its pad levelled); below it the graves, each on the slope as it is
// (algGame: `ground`), every one laid toward Mecca — the axis 18° (NNE–SSW), the head NNE (the body on its right side,
// facing the qibla, ~108°) — in loose rows, some missing, a few whitewashed; a low broken wall along their feet.
// ?koubba=0: the old ones, to compare.
const STONE_KOUBBA = typeof location === "undefined" || new URLSearchParams(location.search).get("koubba") !== "0";
const KB = site("Sidi Ahmed"), CM = site("Cemetery");
const SAINT = STONE_KOUBBA && KB && CM ? koubbaAndCemetery(KB.x, KB.z, CM.x, CM.z) : null;

export const MAP = {
  ...OLD_MAP,
  id: "auresNew",
  base: "aures",   // (the Aurès' briefing, post name and map title — algBattle, algUnits, tacticalMap)
  name: t("Aurès · vallée de Tighanimine"),
  level: "/levels/alg-aures-new.v3proj",
  // the old merged villages, left out: rebuilt below as separate houses; the old gardens, terraces and threshing
  // floors: the fields below
  // (+ the old procedural wells: the Blender village props put one in each square — MAP.villageProps)
  skip: ["wellHamlet1", "wellHamlet2", "wellDechra", "mechta", "mechta2", "dechra", "ksar", "gardenOA1", "gardenOA2", "threshOA", "gardenEO1", "gardenEO2", "threshEO", "terracesEO",
    "terracesD1", "terracesD2", "terracesD3", "gardenD", "threshD", "terracesOpen1", "terracesOpen2", "terracesOpen3", "terracesOpen4", ...(SAINT ? ["koubba", "cemetery"] : [])],
  // (the old almond terraces of the open slopes, algLandmarks: none)
  // (the lone trees and outcrops keep off the cover runs and the supply points — tools/algAuresNewFields.mjs COVER_CLEAR)
  scenery: { over: { terraces: 0 }, keepClear: COVER_CLEAR },
  // (its farmsteads, ruins, rocks and lone trees: scattered in the OLD box, so they stay where they were — algLandmarks)
  sceneryBox: OLD_PLAY,
  // the village life in Blender (tools/blender/villageProps.py): haystacks, firewood, ovens, hives round each village;
  // a well, a trough, jars and benches in its square (algVillageLife)
  villageProps: true,
  // the boulder groups of the cover pass (the gully mouths, the ravine pass, the west slopes)
  sandstone: { ...(OLD_MAP.sandstone ?? {}), rocks: COVER_ROCKS },
  // (no trampled-yard splat at the villages: its 2.4 m photo repeated across the square — seen)
  splats: { yards: false },
  // the supply points: the old map's, the South pass moved in from (31, -241) — outside the tighter box — to the flatter
  // ground beside its track
  supply: OLD_MAP.supply.map((p) => (p.name === "South pass" ? { ...p, x: 55, z: -190 } : p)),
  fields: { plots: FIELD_PLOTS, walls: FIELD_WALLS, hedges: FIELD_HEDGES },
  town: { houses: [...MECHTA_OA, ...MECHTA_EO, ...DECHRA, ...KSAR], props: [...(STONE_OA?.props ?? []), ...(STONE_EO?.props ?? []), ...(STONE_DE?.props ?? []), ...(SAINT ?? [])], replacesHamlet: true },
  // THE FLN CAMP AND ITS CAVE in Blender (FLN_CAMP_PLAN.md, 2026-10-28): the command post, the casemates and the hidden
  // fire in the camp (algAlnCamp kit), the cave's mouth set into its rocks with its damaged and blown-in states
  // (algBuild loadGrotte). ?flnkit=0 = the code-built camp and the old shoring, to compare.
  flnKit: typeof location === "undefined" || new URLSearchParams(location.search).get("flnkit") !== "0",
};
