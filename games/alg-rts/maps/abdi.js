// AURÈS — OUED ABDI (map 4, planned 2026-10-19: games/alg-rts/AURES2_PLAN.md). THE LAYOUT, FIRST SKETCH —
// plain data, argued over on a plan image (tools/algLayoutSketch.mjs) before any ground exists. NOT in the
// game's MENU yet: ?map=abdi loads it (its ground: tools/algAbdiLevel.mjs → public/levels/alg-abdi.v3proj).
//
// A valley of the Aurès south of Arris: the djebel steep north and west, the valley floor open south and
// east, the oued across it. CoH 3-sized: a ~500 m PLAYABLE box, the starts ~410 m apart on the diagonal.
//   · the FRENCH hold the valley: the post south-east, its motor pool and helipad, the piste north;
//   · the FLN start hidden in the djebel (north-west): the maquis camp and the cave, two GULLIES down;
//   · between: the ALGERIAN TOWN on a knoll (its souk the big point), the oasis, a hamlet and farms (the
//     brown houses: farmers, shepherds), the stone DECHRA at the mountain's foot, a lookout on a spur.
// World metres, north up = -Z (as every map).
import { t } from "../i18n/i18n.js";
import { ROCKS } from "./abdiRocks.js";
import { TOWN_HOUSES, TOWN_SQUARE, TOWN_WALLS } from "./abdiTown.js";
import { FIELD_PLOTS, FIELD_WALLS, FIELD_HEDGES } from "./abdiFields.js";
import { garden, hamlet, house, koubbaAndCemetery } from "./villageKit.js";

export const PLAY = { x0: -250, x1: 250, z0: -250, z1: 250 };

export const LAYOUT = {
  sites: [
    // ── Starts ──
    { kind: "french", name: "Poste d'Oued Abdi", x: 110, z: 165, r: 34, turn: 35 },
    { kind: "aln", name: "Katiba camp", x: -150, z: -160, r: 26, turn: -30 },
    { kind: "cave", name: "Grotte", x: -190, z: -205, r: 10 },
    // ── The French base's other pieces (not points) ──
    { kind: "motorPool", name: "Parc auto", x: 160, z: 200, r: 18 },
    { kind: "helipad", name: "Hélisurface", x: 60, z: 205, r: 14 },
    // ── Objectives ──
    { kind: "town", name: "Abdi (souk)", x: 15, z: -10, r: 40, knoll: [5, -55, 60], point: true },
    { kind: "oasis", name: "Aïn Abdi", x: -75, z: 95, r: 24, point: true },
    { kind: "hamlet", name: "Mechta el Djorf", x: 175, z: 25, r: 30, point: true },
    { kind: "farm", name: "Ferme Ouled Saïd", x: -160, z: 55, r: 20, point: true },   // (pulled toward the middle: the west lane)
    { kind: "dechra", name: "Dechra Taghit", x: -195, z: -55, r: 30, point: true },
    { kind: "koubba", name: "Sidi Ali", x: -230, z: -95, r: 10 },
    { kind: "pass", name: "Débouché du ravin", x: 85, z: -110, r: 16, point: true },
    { kind: "point", name: "Kef (guet)", x: 175, z: -170, r: 16, point: true },
    { kind: "farm", name: "Bergerie", x: 200, z: -80, r: 16 },
  ],
  // the oued across the valley (3 fords) and the two gullies down from the djebel
  wadis: [
    { name: "Oued Abdi", points: [[-260, 0], [-170, 25], [-110, 60], [-30, 50], [40, 55], [120, 80], [200, 60], [260, 35]], width: 12, depth: 3, fords: [0.3, 0.55, 0.78] },
  ],
  gullies: [
    { name: "Ravin ouest", points: [[-140, -150], [-150, -90], [-120, -40], [-110, 10]] },
    { name: "Ravin est", points: [[-110, -175], [-30, -150], [40, -125], [85, -110]] },
  ],
  pistes: [
    [[110, 165], [70, 110], [40, 55], [20, 10]],                // the post to the souk, over the middle ford
    [[70, 110], [-20, 100], [-75, 95], [-160, 55]],              // west: the oasis, the farm
    [[-160, 55], [-175, 0], [-195, -55]],                        // the WEST LANE: the farm up to the dechra (the French way west)
    [[110, 165], [150, 90], [175, 25], [200, -80]],               // east: the hamlet, the sheepfold
  ],
  // supply (munitions / fuel), placed in the gaps the sketch measures
  supply: [
    { name: "Gué du milieu", x: 40, z: 60, res: "fuel" },
    { name: "Puits de l'oasis", x: -40, z: 120, res: "mun" },
    { name: "Carrefour de la piste", x: 75, z: 110, res: "mun" },
    { name: "Pont de l'est", x: 130, z: 80, res: "fuel" },
    { name: "Source du ravin", x: -120, z: -40, res: "mun" },
    { name: "Col du ravin est", x: -20, z: -150, res: "fuel" },
    { name: "Terrasses", x: -110, z: 10, res: "mun" },
    { name: "Gué de l'ouest", x: -140, z: 135, res: "fuel" },
    { name: "Piste de la bergerie", x: 200, z: -20, res: "mun" },
    { name: "Hauteurs du souk", x: 70, z: -60, res: "fuel" },
    { name: "Vergers du sud", x: 0, z: 180, res: "mun" },
    { name: "Crête nord", x: 60, z: -200, res: "mun" },
    // the FLN's own pair by its start (CoH: a fuel and a munitions point near each base)
    { name: "Cache du camp", x: -95, z: -205, res: "mun" },
    { name: "Bergerie du djebel", x: -205, z: -130, res: "fuel" },
    // the west lane's middle, between the farm and the dechra
    { name: "Moulin de l'oued", x: -205, z: 5, res: "fuel" },
  ],
};

// ── THE PORT TO THE NEW KITS (2026-10-29 — you: "start working on the port … AAA Company of Heroes type of assets") ──
// The places the old procedural pieces stood, rebuilt from the Blender kits (maps/villageKit.js, as the new Aurès):
// their houses in the TOWN field (garrisons, damage, collapse), their smaller pieces its props. The ground measured
// (2026-10-29): the hamlet's and the dechra's sites are flat pads (0.5 m over 60 m), the koubba on a small crest.
// ?stone=0: the old pieces, to compare.
const STONE = typeof location === "undefined" || new URLSearchParams(location.search).get("stone") !== "0";
const site = (name) => LAYOUT.sites.find((s) => s.name === name);
const DJ = site("Mechta el Djorf"), TG = site("Dechra Taghit"), SA = site("Sidi Ali");
// MECHTA EL DJORF (the east lane's hamlet): two rows behind a small square, a house at each side of it, a yard behind,
// a lean-to and an oven; one house shelled
const DJORF = STONE && hamlet(DJ.x, DJ.z, {
  rows: [{ types: ["petite", "etage", "petite"], x: -11, z: -6, states: { 2: "damaged" } },
    { types: ["pente", "petite", "etage"], x: -13, z: -18, yards: [1] }],
  sides: [{ type: "etage", x: -15.5, z: 2 }, { type: "petite", x: 15, z: 0.5 }],
  props: [{ type: "appentis", x: 16, z: -9 }, { type: "tabouna", x: -7, z: 3 }] });
// DECHRA TAGHIT (at the djebel's foot, the west lane's end): the bigger village — two long rows round its square, a
// house on each side, its MOSQUE at the back against the hill (the minaret the landmark from the valley), the djemaa
// and an oven in the square; one house a ruin, one shelled (the war has been here)
const TAGHIT = STONE && (() => {
  const v = hamlet(TG.x, TG.z, {
    rows: [{ types: ["petite", "etage", "petite", "etage"], x: -17, z: -7 },
      { types: ["etage", "petite", "pente", "petite"], x: -19, z: -20, states: { 1: "ruin" } }],
    sides: [{ type: "etage", x: -21, z: 3 }, { type: "petite", x: 20, z: 2, state: "damaged" }],
    props: [{ type: "djemaa", x: 6, z: 4 }, { type: "tabouna", x: -8, z: 5 }, { type: "appentis", x: 21.5, z: -10 }] });
  v.houses.push(house("masjid", "intact", TG.x, TG.z - 36, TG.x, TG.z));
  return v;
})();
// THE FARMS (2026-10-30, FARM_PLAN.md — the mechta kit's houses and its new farm pieces). FERME OULED SAÏD: the farmer's
// loggia house and his son's beside it, their yard behind, the goats' lean-to at the west end; the THRESHING FLOOR out in front on the
// open ground (the oued runs north-east of the site: everything south and west of it). The point in the front yard.
const FS = site("Ferme Ouled Saïd"), BG = site("Bergerie");
const FARM = STONE && hamlet(FS.x, FS.z, {
  rows: [{ types: ["petite", "etage"], x: -14, z: 2, gap: 1.5, yards: [1] }],
  props: [{ type: "appentis", x: -18.5, z: -1 }, { type: "aire", x: -4, z: 13 }],   // (the lean-to west: east of the houses the piste runs north)
});
// THE BERGERIE (the shepherd's, up the east piste): the sheepfold and its zriba, his one-room house beside it, its oven
const FOLD = STONE && hamlet(BG.x, BG.z, {
  rows: [{ types: ["petite"], x: 9, z: 4 }],
  props: [{ type: "bergerie", x: -2, z: 0 }, { type: "tabouna", x: 14, z: 7 }],
});
// AÏN ABDI, THE OASIS (2026-10-30, OASIS_PLAN.md): the whitewashed kit's houses in two short rows between the piste and
// the oued (their fronts to the piste, 9 m off it — the point on the piste between them, the oasis's square); the SPRING
// south of the piste, its seguia running south down the lane between two GARDENS fenced in palm ribs (the grove beyond)
const OA = site("Aïn Abdi");
const OASIS = STONE && (() => {
  const v = hamlet(OA.x, OA.z, {
    rows: [{ types: ["haute", "maison"], x: -36, z: -21 }, { types: ["boutique", "haute"], x: 2, z: -15, states: { 1: "damaged" } }],
    props: [{ type: "ain", x: 5, z: 13 }],
  });
  v.props.push(...garden(OA.x - 27, OA.z + 22, 5, 3, { gate: ["n", 4] }), ...garden(OA.x + 11, OA.z + 22, 5, 3, { gate: ["n", 0], damaged: [6] }));
  return v;
})();
// SIDI ALI: the koubba on its crest; the village's dead on the slope below it (south)
const SAINT = STONE ? koubbaAndCemetery(SA.x, SA.z, SA.x - 6, SA.z + 21, { seed: 1961, cols: 5, rows: 4 }) : [];   // (east of it the graves ran under the mosque, north into a walled field — seen; south: clear, measured)

/** THE MAP: its level, its pistes as tracks, its supply — the ground only for now (no town, no AI). */
export const MAP = {
  id: "abdi",
  name: t("Aurès — Oued Abdi"),
  level: "/levels/alg-abdi.v3proj",
  tracks: LAYOUT.pistes.map((p, i) => ({ name: t("Piste de l'oued"), kind: "piste", from: "gate", to: "", length: Math.round(p.slice(1).reduce((a, q, k) => a + Math.hypot(q[0] - p[k][0], q[1] - p[k][1]), 0)), points: p, id: i })),
  supply: LAYOUT.supply,
  handPlaced: false,
  // WHAT THIS MAP SHOWS (mapSystems.js): the ground under review — no AI yet.
  systems: { fow: true, birds: true, splats: true, stones: true, life: true },   // (life: the villages' hay, wood, ovens, hives and the squares' wells — 2026-10-29)
  // THE PLANTS BARELY MOVE (you, 2026-10-19: "in CoH there is no wind on foliage"): a slight breath, 1/4 of
  // the Aurès' sway; the flags and the windsock keep the full wind. ?plantwind=0..1 to compare.
  foliageWind: 0,   // (you, 2026-10-19: "make wind 0 for foliage" on this map — 0.25 was the first try)
  // ITS LIGHT (algGame MAP_LIGHT, over the Aurès'): the Aurès' grade is tuned for its dark brown ground — on
  // this pale ochre one it read too dark and too saturated (measured 2026-10-19 at the RTS zoom: luma 118,
  // saturation 0.60; CoH's frames 133-159, 0.45-0.51). A little more exposure, the grade less warm, less
  // saturated.
  light: { skyProExposure: 0.52, polish: { saturation: 0.8, temperature: 0.08 } },   // (the Aurès: 0.42; 1.12 read luma 197)
  // ITS STONES (algStones, by paint slot — the Aurès' meanings): warm limestone and sandstone that sit on
  // the pale ochre ground (the Aurès' grey ones read as foreign on it — the first look, 2026-10-19).
  stones: {
    soil:  { slot: 0, id: "rock_boulder_cracked", tint: "#f0d2b4", per100: 0.5, shapes: [["pebble", 0.6], ["rock", 0.4]] },
    red:   { slot: 1, id: "rock_boulder_cracked", tint: "#e0aa86", per100: 1.6, shapes: [["pebble", 0.5], ["rock", 0.42], ["lump", 0.08]] },
    wadi:  { slot: 4, id: "rocky_trail", tint: "#f4ece0", per100: 4.0, shapes: [["cobble", 0.7], ["pebble", 0.3]] },
    gravel:{ slot: 6, id: "rock_boulder_cracked", tint: "#ead2b8", per100: 6.0, shapes: [["pebble", 0.85], ["rock", 0.15]], edge: [0.08, 0.55] },
  },
  // THE SANDSTONE (algSandstone, the building lab's rock): outcrops on the djebel's crests (cover, landmarks) and
  // the frame's cliffs — placed by tools/algAbdiLevel.mjs. The Aurès' ochre colour.
  sandstone: { colour: "abdi", rocks: ROCKS },
  // ITS TOWN (algGame: an instanced house field): placed by tools/algAbdiLevel.mjs on the knoll's ring terraces,
  // the souk square at the town's point
  town: { houses: [...TOWN_HOUSES, ...(DJORF?.houses ?? []), ...(TAGHIT?.houses ?? []), ...(FARM?.houses ?? []), ...(FOLD?.houses ?? []), ...(OASIS?.houses ?? [])],
    props: [...(DJORF?.props ?? []), ...(TAGHIT?.props ?? []), ...SAINT, ...(FARM?.props ?? []), ...(FOLD?.props ?? []), ...(OASIS?.props ?? [])],
    square: TOWN_SQUARE, walls: TOWN_WALLS, replacesHamlet: STONE },
  // the old procedural pieces the kits replace (the hamlet: replacesHamlet), the old wells (the props kit puts one in each
  // square: villageProps)
  skip: STONE ? ["dechra", "koubba", "wellDechra", "wellHamlet1"] : [],
  villageProps: STONE,
  // THE FLN CAMP AND ITS CAVE in Blender (algAlnCamp kit, algBuild loadGrotte — FLN_CAMP_PLAN.md); ?flnkit=0 the old
  flnKit: typeof location === "undefined" || new URLSearchParams(location.search).get("flnkit") !== "0",
  // ITS FIELDS (tools/algAbdiDecals.mjs: the plots round the farms, their soil laid as decals; algGame clears
  // their plants — worked land). Their walls and crops next.
  fields: { plots: FIELD_PLOTS, walls: FIELD_WALLS, hedges: FIELD_HEDGES },
  // algLandmarks' own scenery: none (its Aurès places are on the old map's ground).
  scenery: { quantities: {}, keepClear: [] },
};
