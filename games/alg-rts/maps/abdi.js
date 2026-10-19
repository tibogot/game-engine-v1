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

/** THE MAP: its level, its pistes as tracks, its supply — the ground only for now (no town, no AI). */
export const MAP = {
  id: "abdi",
  name: t("Aurès — Oued Abdi"),
  level: "/levels/alg-abdi.v3proj",
  tracks: LAYOUT.pistes.map((p, i) => ({ name: t("Piste de l'oued"), kind: "piste", from: "gate", to: "", length: Math.round(p.slice(1).reduce((a, q, k) => a + Math.hypot(q[0] - p[k][0], q[1] - p[k][1]), 0)), points: p, id: i })),
  supply: LAYOUT.supply,
  handPlaced: false,
  // WHAT THIS MAP SHOWS (mapSystems.js): the ground under review — no AI yet.
  systems: { fow: true, birds: true, splats: true, stones: true },
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
  // algLandmarks' own scenery: none (its Aurès places are on the old map's ground).
  scenery: { quantities: {}, keepClear: [] },
};
