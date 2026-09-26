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
// THE SHAPE OF THE FIGHT (asymmetric, French playable):
//   · the FRENCH hold the valley — the post, the road, the open ground where
//     their armour and helicopters count;
//   · the ALN start hidden in the massif — broken ground, gullies, cedars —
//     and come down the gullies to raid;
//   · between them, seven objectives: the hamlets and water (civilians and
//     supply), the gully mouths (the ways down), a watch point on the ridge;
//   · two WADIS cut the valley: dry riverbeds with steep banks, crossable at
//     a few fords — the chokepoints an open valley does not have.

export const LAYOUT = {
  sites: [
    // ── Starts ───────────────────────────────────────────────────────────────
    { kind: "french", name: "Poste de Tighanimine", x: 40, z: 150, r: 34 },
    { kind: "aln", name: "Katiba camp", x: -350, z: -315, r: 26 },

    // ── Objectives (capture points) ─────────────────────────────────────────
    { kind: "hamlet", name: "Mechta Ouled Ali", x: 150, z: 60, r: 40 },
    { kind: "oasis", name: "Ain Tighanimine", x: 132, z: 128, r: 24 },
    { kind: "pass", name: "Gully mouth west", x: -276, z: -2, r: 16 },
    { kind: "pass", name: "Gully mouth east", x: -78, z: -82, r: 16 },
    { kind: "point", name: "Cedar spring", x: -150, z: -300, r: 16 },
    { kind: "point", name: "Ridge watch", x: 330, z: 330, r: 16 },
    { kind: "oasis", name: "Ain el Oued", x: -120, z: 330, r: 22 },
    { kind: "hamlet", name: "Mechta el Oued", x: 270, z: -70, r: 36 },
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
