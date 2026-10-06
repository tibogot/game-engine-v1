// ACCURACY — does a round HIT? The Company of Heroes way (your ask,
// 2026-09-30: a balance pass on the infantry fights). Before this every round
// hit: 6 men on 5 at 22 m lost 40 % in 2 s, and the fight was over before
// suppression, cover, a flank or a grenade could matter.
//
// Now each round rolls (combat.js `hitChance`); a miss still flies — its
// tracer into the dirt round the man — and still SUPPRESSES (infantryPosture
// hangs on every round fired, hit or not: CoH's fire keeps heads down whether
// it connects or not). What decides it:
//   RANGE     a weapon's chance at point blank, falling to its chance at the
//             edge of its range (rifle 0.4 → 0.15);
//   POSTURE   a man kneeling is a smaller target, a man lying flat smaller
//             still (pinned men survive — CoH);
//   COVER     the wall / rocks / bank between him and the shooter
//             (cover.coverBetween, directional): hides part of him — the
//             damage cut combat.js already takes off a round that hits
//             comes on top;
//   MOVING    a man running is harder to hit.
// Vehicles, buildings and aircraft: every round hits (they are big) — their
// own armour is their hp. A cannon or a grenade: no roll (splash).
//
// MEASURED (2026-09-30, scripted duels in the game, 5 appelés v 5 moudjahidine
// at 26 m, "decided" = one side down 3 men):
//   every round hits (before)      ~2 s, over before anything else matters
//   rifle 0.5 → 0.2                open ground 9-15 s
//   rifle 0.4 → 0.15 (kept)        open ground 12-21 s, ~16 s — CoH's pace
//   the French behind a wall       they win 5-0 in 10-28 s, whatever
//     coverHide (0, 0.3, 0.6): combat.js's damage cut behind cover (up to
//     80 %) does that, and it is CoH's rule — men in the open do not shoot a
//     section out of green cover; a GRENADE or a FLANK does.

export const ACCURACY = {
  // [point blank, edge of range], men on foot as the target.
  rifle: [0.4, 0.15],
  mg: [0.55, 0.3],
  gunship: [0.5, 0.3],
  kneel: 0.8,       // × for a man kneeling (suppressed, or in cover)
  prone: 0.5,       // × for a man lying (pinned)
  coverHide: 0.3,   // × (1 - coverHide * coverBetween)
  moving: 0.75,     // × for a man on the move
  inside: 0.35,     // × for a man in a house (algGarrison.js): a window, not the street (0.5 measured: 20 lost vs 25 in the street — too little)
};

/**
 * @param {object} o
 * @param {object} [o.cover]  the shared cover (coverBetween)
 * @returns {(shooter: object, target: object, d: number) => number}  0..1
 */
export function createAlgAccuracy({ cover = null, params = ACCURACY } = {}) {
  return function hitChance(e, tgt, d) {
    if (!tgt.type?.foot || tgt.isStructure) return 1;
    const w = params[e.weapon];
    if (!w) return 1;   // a cannon: the shell's splash does the work
    const f = Math.min(1, Math.max(0, d / Math.max(1, e.range || 1)));
    let p = w[0] + (w[1] - w[0]) * f;
    if (tgt.posture === "prone") p *= params.prone;
    else if (tgt.posture === "kneel") p *= params.kneel;
    if (tgt.isMoving) p *= params.moving;
    if (tgt.inside) p *= params.inside;
    if (cover) p *= 1 - params.coverHide * cover.coverBetween(e.position.x, e.position.z, tgt.position.x, tgt.position.z);
    // VETERANCY (algVeterancy.js): a veteran squad's men shoot straighter.
    return Math.min(0.95, p * (e.vetAcc ?? 1));
  };
}
