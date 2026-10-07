// ARMOUR BY FACING (2026-10-07, the AAA list's gameplay depth — CoH's vehicle armour): where a
// hit lands on a vehicle decides what it does. The FLN has no anti-tank gun — rifles, the FM,
// grenades, mines — so this is what makes armour worth having AND beatable:
//
//   BULLETS (rifle, MG) on ARMOUR glance off the front, bite on the sides, go in at the rear (the
//            engine deck, the thin plates). A band in front of an AMX-13 barely scratches it; the
//            same band on its flank or behind it kills it. The half-track's thin armour stops less.
//   SHELLS (a direct hit, the cannons) by facing too, less steeply.
//   EXPLOSIONS (grenades, mines, mortar bombs, a splash: no direction) — full damage from anywhere:
//            the FLN's grenade is its answer to a tank that faces it.
//   Soft vehicles (the jeep, the GMC) and men: no armour.
//
// The angle is between the vehicle's heading and the line to the shooter: FRONT within 50° of the
// nose, REAR within 50° of the tail, SIDE between.

export const ARMOUR = {
  frontHalf: (50 * Math.PI) / 180,
  rearHalf: (50 * Math.PI) / 180,
  // × a hit's damage by facing: [front, side, rear]. MEASURED in real time (2026-10-07, the
  // fast-forward gave other numbers: don't trust it for this), six FLN riflemen at 26 m on an
  // AMX-13: front −18 hp in 15 s (~3.5 min to kill); rear at 0.75 killed it in 11 s — too easy
  // without an anti-tank weapon: 0.45 now — RE-MEASURED (open ground, no French near, 6/6 firing
  // throughout): destroyed after 24 s from the rear.
  types: {
    amx13: { bullet: [0.05, 0.25, 0.45], shell: [0.6, 1, 1.4] },
    ebr: { bullet: [0.07, 0.3, 0.55], shell: [0.7, 1, 1.4] },
    halftrack: { bullet: [0.25, 0.5, 0.75], shell: [0.85, 1, 1.25] },
  },
};

/** Which face of `target` a hit from (x, z) lands on: 0 front, 1 side, 2 rear. */
export function faceHit(target, x, z) {
  const toShooter = Math.atan2(x - target.position.x, z - target.position.z);
  let a = toShooter - (target.heading ?? 0);
  a = Math.abs(Math.atan2(Math.sin(a), Math.cos(a)));
  return a <= ARMOUR.frontHalf ? 0 : a >= Math.PI - ARMOUR.rearHalf ? 2 : 1;
}

/** combat.js `armourMul`: × the damage of a hit landing on `target` from `owner`. */
export function armourMul(target, owner, { bullet = false, shell = false } = {}) {
  const t = ARMOUR.types[target?.typeKey];
  if (!t || !owner?.position || (!bullet && !shell)) return 1;
  const f = faceHit(target, owner.position.x, owner.position.z);
  target.lastHitFace = f;   // the HUD and the AI can read it
  return (bullet ? t.bullet : t.shell)[f];
}
