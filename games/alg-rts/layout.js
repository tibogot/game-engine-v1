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
// THE STARTS ARE ON THE LONG DIAGONAL (your call, 2026-09-26): ALN in the
// NW corner of the playable area, French in the SE, ~930 m apart, so the
// whole map is between them. (The first layout had the post near the
// centre: ~600 m, half the map behind the French unused.)
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

export const LAYOUT = {
  sites: [
    // ── Starts ───────────────────────────────────────────────────────────────
    // On the SE ridge bench, 25 m up.
    { kind: "french", name: "Poste de Tighanimine", x: 305, z: 345, r: 34, turn: 35 },
    { kind: "aln", name: "Katiba camp", x: -350, z: -315, r: 26, turn: -30 },

    // ── Objectives (capture points) ─────────────────────────────────────────
    { kind: "hamlet", name: "Mechta Ouled Ali", x: 150, z: 60, r: 40, turn: 40 },
    { kind: "oasis", name: "Ain Tighanimine", x: 132, z: 128, r: 24 },
    { kind: "pass", name: "Gully mouth west", x: -276, z: -2, r: 16 },
    { kind: "pass", name: "Gully mouth east", x: -78, z: -82, r: 16 },
    { kind: "point", name: "Cedar spring", x: -150, z: -300, r: 16 },
    { kind: "point", name: "Kef lookout", x: 237, z: -354, r: 16 },
    { kind: "pass", name: "Col de l'Ouest", x: -275, z: 326, r: 16 },
    { kind: "oasis", name: "Ain el Oued", x: -120, z: 330, r: 22 },
    { kind: "hamlet", name: "Mechta el Oued", x: 270, z: -70, r: 36, turn: -25 },
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

const _fr = LAYOUT.sites.find((s) => s.kind === "french");
const _aln = LAYOUT.sites.find((s) => s.kind === "aln");
/**
 * THE VIEW: the player's camera looks from the French base toward the ALN
 * (forward = (sin VIEW_YAW, cos VIEW_YAW)). A kit building's front is its
 * local -Z, which at yaw = VIEW_YAW points straight back at the camera.
 *
 * BUILDINGS TURN THEIR FRONTS TOWARD THE CAMERA, AT THREE-QUARTERS (your
 * rule, 2026-09-26, the Company of Heroes way): a front that matters (a gate,
 * a door, the good-looking side) is turned more toward the camera than away,
 * but ~25-45 deg off it — front and one side visible at once. Square-on
 * looks flat and staged; facing away shows back walls. Each site says its
 * own `turn` (degrees off the camera), so they do not all match.
 */
export const VIEW_YAW = Math.atan2(_aln.x - _fr.x, _aln.z - _fr.z);

/** A site's building yaw: the camera-facing yaw turned by its `turn` degrees. */
export const siteYaw = (site) => VIEW_YAW + ((site.turn ?? 30) * Math.PI) / 180;
