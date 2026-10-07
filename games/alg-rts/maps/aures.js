// THE AURÈS MAP'S LAYOUT — where each side starts, what there is to fight
// over, and the terrain features built for it. Plain data, read by the game
// (showroom / gameplay), the map tools (tools/algVegetation.mjs keeps sites
// clear; tools/algWadi.mjs carves the wadis) and tools/algPlanView.mjs (the
// plan image to argue the layout over).
//
// World metres, north up = -Z. The map (public/levels/alg-aures.v3proj):
// the Tighanimine massif fills the north-west, its gullies draining south-
// east into a wide open valley; a long low ridge closes the south-east.
//
// A COMPANY OF HEROES-SIZED BATTLE (your call, 2026-09-28): the starts are
// still on the diagonal, ALN north-west, French south-east, but ~470 m
// apart, not ~930 — at a credible infantry pace (~5.5 m/s) the old corners
// were a three-minute walk over empty slopes. The play happens in PLAY, a
// 610 m box over the valley, the dechra and the gully mouths; the terrain
// outside it is scenery (the massif on the skyline), not ground you walk.
// Sites were MEASURED: the post on the valley floor 95 m from the oasis
// (1.2 m of height over its pad, bare), the katiba high in the broken ground
// (51 m up, 14 m of relief round it). The line between them turned 7° from
// the old one, so the buildings still stand at three-quarters to the camera.
// (The first layout had the post near the centre, ~600 m; then the long
// diagonal, ~930 m, 2026-09-26.)
//
// OBJECTIVES are balanced by distance, not mirrored (the terrain is not
// symmetric, on purpose): one home point each, near points each side, and
// the rest in a belt across the middle. ALN-leaning ones are in the
// mountains, French-leaning ones in the valley — the war's own asymmetry.
//
// THE SHAPE OF THE FIGHT (asymmetric, French playable):
//   · the FRENCH hold the valley — the post, the road, the open ground where
//     their armour and helicopters count;
//   · the ALN start hidden in the massif — broken ground, gullies, cedars —
//     and come down the gullies to raid;
//   · between them, seven objectives: the hamlets and water (civilians and
//     supply), the gully mouths (the ways down), a watch point on the ridge;
//   · two WADIS cut the valley: dry riverbeds with steep banks, crossable at
//     a few fords — the chokepoints an open valley does not have.

import { TRACKS } from "../tracks.js";
import { t } from "../i18n/i18n.js";

/**
 * THE PLAYABLE AREA: the camera, the units' paths and the minimap stay in
 * it. 610 m square — both starts with room behind them, the three villages,
 * the koubba, the near oasis, both gully mouths. Outside: scenery.
 */
export const PLAY = { x0: -320, x1: 290, z0: -285, z1: 325 };

export const LAYOUT = {
  sites: [
    // ── Starts ───────────────────────────────────────────────────────────────
    // The valley floor near the oasis; the katiba high in the massif.
    { kind: "french", name: "Poste de Tighanimine", x: 90, z: 213, r: 34, turn: 35 },
    { kind: "aln", name: "Katiba camp", x: -199, z: -162, r: 26, turn: -30 },

    // ── Objectives (capture points) ─────────────────────────────────────────
    { kind: "hamlet", name: "Mechta Ouled Ali", x: 150, z: 60, r: 40, turn: 40 },
    { kind: "oasis", name: "Ain Tighanimine", x: 132, z: 128, r: 24 },
    { kind: "pass", name: "Gully mouth west", x: -276, z: -2, r: 16 },
    { kind: "pass", name: "Gully mouth east", x: -78, z: -82, r: 16 },
    { kind: "point", name: "Cedar spring", x: -150, z: -300, r: 16 },
    { kind: "point", name: "Kef lookout", x: 237, z: -354, r: 16 },
    { kind: "pass", name: "Col de l'Ouest", x: -275, z: 326, r: 16 },
    { kind: "oasis", name: "Ain el Oued", x: -136, z: 352, r: 22 },
    { kind: "hamlet", name: "Mechta el Oued", x: 270, z: -70, r: 36, turn: -25 },
    // The dechra up a 17° slope in the contested west (MEASURED: rises
    // straight away from the player's camera, ~0 side tilt), its koubba on the
    // crest 28 m above it, the cemetery beside the koubba.
    { kind: "dechra", name: "Dechra Tighanimine", x: -224, z: 136, r: 34, turn: 25 },
    { kind: "koubba", name: "Sidi Ahmed", x: -273, z: 86, r: 12, turn: 30 },
    { kind: "cemetery", name: "Cemetery", x: -256, z: 70, r: 13, turn: 30 },
    // THE KSAR (you, 2026-09-29, a photo of Ghardaïa): a plastered town up a
    // knoll in the middle belt, ALN-leaning (1.8x nearer the katiba), the one
    // knoll in the play box that stands clear (MEASURED: 6.5 m over the ground
    // 38 m round, < 23 deg, 116 m from a wadi). x/z is the SUMMIT (its mosque);
    // `souk`: the market square, that many metres down its front — the town is
    // built solid, so it is held from the square (sitePoint).
    { kind: "ksar", name: "Ksar el Hamra", x: -10, z: -120, r: 52, turn: -30, souk: 43 },
  ],

  // ── Wadis: dry riverbeds, polyline in world metres, bed width, depth ──────
  // `fords` are the fractions along the wadi where the banks ease to a ramp.
  wadis: [
    {
      name: "Oued Tighanimine",
      // North of the hamlet (not through it), bending south-east round its fields.
      points: [[-60, 20], [10, -5], [90, 0], [170, 5], [230, 25], [320, 80], [400, 150], [480, 190]],
      width: 12, depth: 3.2, fords: [0.12, 0.45, 0.8],
    },
    {
      name: "Oued el Abiod",
      // From below the west gully mouth, past the second oasis on its bank.
      points: [[-285, 40], [-290, 120], [-250, 210], [-180, 275], [-150, 292], [-60, 352], [40, 410], [120, 470]],
      width: 11, depth: 3.0, fords: [0.3, 0.62, 0.88],
    },
  ],
};

/**
 * THE MAP ITSELF: its level file, its tracks (tools/algTracks.mjs), its supply
 * points, and `handPlaced` — the showroom's gardens, terraces and threshing
 * floors, placed by hand on THIS ground.
 */
export const MAP = {
  id: "aures",
  name: "Aurès — Tighanimine",
  level: "/levels/alg-aures.v3proj",
  tracks: TRACKS,
  // The supply points (fuel / munitions), on the pistes between the post and the villages.
  // Their names are descriptions, not place names: translated (i18n/en/systems.js).
  supply: [
    { name: t("Puits d'Ain Tighanimine"), x: 134, z: 157, res: "mun" },   // the oasis' dry north shore (132,128 is the pond)
    { name: t("Carrefour de la piste"), x: 2, z: 177, res: "fuel" },
    { name: t("Gué de l'oued"), x: 193, z: 20, res: "fuel" },          // beside the ford (181,32 is half in the oued)
    { name: t("Col du ravin"), x: 19, z: -14, res: "mun" },
    { name: t("Source d'Aïn Kerma"), x: -110, z: 150, res: "mun" },         // the step from the crossroads to the dechra
    { name: t("Débouché du ravin"), x: -78, z: -82, res: "fuel" },
  ],
  handPlaced: true,
};
