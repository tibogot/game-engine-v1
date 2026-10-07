// INFANTRY POSTURE — suppression, pinning and cover, the Company of Heroes
// way (your go, 2026-09-30). Shared machinery; a game opts in (alg-rts does,
// algUnits.js) and passes its own numbers.
//
// SUPPRESSION is what incoming fire does to a man before it kills him. Every
// round fired AT a man on foot adds to his (a machine gun far more than a
// rifle); a shell landing near adds a burst; it drains away over seconds.
//
//   SUPPRESSED  he keeps his head down: KNEELS, moves at 70 %, fires at 80 %.
//   PINNED      he is flat on the ground: PRONE, crawls at 30 %, fires at
//               half rate, until the fire eases (hysteresis — he does not
//               bob up and down at the threshold).
//
// So an MG covering an open field stops a squad crossing it, which is the MG's
// whole job in CoH, and the answer is smoke, a flank or a mortar — not more men.
//
// COVER POSTURE: a man sheltered from whoever he is shooting at (the shared
// cover's directional test), or standing still beside something that shelters
// him, KNEELS behind it. Visual and honest: the damage cover takes off is
// already combat.js's; this makes it READ.
//
// What it writes on each unit on foot (the renderer and the sim read them):
//   posture   "stand" | "kneel" | "prone"
//   suppressed, pinned, inCover   booleans
//   moveMul   units.js multiplies his speed by it
//   fireMul   combat.js multiplies his rate of fire by it
//
// Hooks: combat.js calls onShot(shooter, target) for every round fired and
// onSplash(at, radius) for every shell that lands.

export const POSTURE = {
  /** Suppression a round adds, by the SHOOTER's weapon (units' `weapon`). */
  perRound: { rifle: 0.07, mg: 0.2, cannon: 0.45, gunship: 0.3 },
  perRoundDefault: 0.08,
  /**
   * The most suppression a weapon's rounds can build on their own (none: up
   * to `max`). alg-rts: rifles KNEEL a man under steady fire but never pin
   * him — pinning is the MG's job (CoH).
   */
  capByWeapon: {},
  /**
   * Metres round the target that a round also suppresses (at `areaShare`):
   * an MG keeps a whole SQUAD's heads down, not just the man it aims at
   * (MEASURED 2026-09-30: aimed at one man, a band under the post's MG only
   * ever knelt). A rifle round: its target alone.
   */
  area: { mg: 6, cannon: 8, gunship: 8 },
  areaShare: 0.6,
  /** A shell landing: this much at its centre, half at 1.5 × its blast radius. */
  splash: 0.9,
  /** Drained per second. */
  decay: 0.3,
  suppressed: 0.4,
  pinned: 1.0,
  /** A pinned man gets up again only below this. */
  unpin: 0.55,
  max: 1.6,
  /** Cover (0..1, the shared cover's scale) that makes a man kneel. */
  coverKneel: 0.2,
  moveSuppressed: 0.7, movePinned: 0.3,
  fireSuppressed: 0.8, firePinned: 0.5,
  /** Seconds between a man's cover checks (staggered across the squad). */
  coverEvery: 0.25,
};

const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];

/**
 * @param {object} o
 * @param {object} o.units   the shared units (list, near)
 * @param {object} [o.cover] the shared cover (coverBetween); none = no cover posture
 */
export function createInfantryPosture({ units, cover = null, params = POSTURE }) {
  const onFoot = (u) => !!u?.type?.foot;
  // `u.suppressMul` (a game's opt-in, 1 = as before): a veteran shrugs off part of it (alg-rts).
  const add = (u, a, cap = params.max) => { a *= u.suppressMul ?? 1; const s = u.suppression ?? 0; u.suppression = Math.max(s, Math.min(cap, s + a)); };
  const near = [];
  let seq = 0;

  /** How sheltered `u` is: from his target if he has one, else the best of four sides. */
  function coverOf(u) {
    const t = u.attackTarget?.alive ? u.attackTarget : u.target?.alive ? u.target : null;
    const x = u.position.x, z = u.position.z;
    if (t) return cover.coverBetween(t.position.x, t.position.z, x, z);
    let best = 0;
    for (const [dx, dz] of DIRS) best = Math.max(best, cover.coverBetween(x + dx * 12, z + dz * 12, x, z));
    return best;
  }

  return {
    params,
    /** A round fired at `target` (combat.js). */
    onShot(shooter, target) {
      if (!target?.alive) return;
      target.firedOnBy = shooter;   // who: the AI takes cover FROM him (algAI.js)
      // suppressOut: a shooter's own multiplier (alg-rts: a SET-UP machine gun pins harder).
      const w = shooter?.weapon, a = (params.perRound[w] ?? params.perRoundDefault) * (shooter?.suppressOut ?? 1);
      const cap = params.capByWeapon?.[w] ?? params.max;
      if (onFoot(target)) add(target, a, cap);
      const r = params.area[w];
      if (!r) return;
      for (const u of units.near(target.position.x, target.position.z, r, near)) {
        if (u === target || !u.alive || !onFoot(u) || u.team !== target.team) continue;
        if (Math.hypot(u.position.x - target.position.x, u.position.z - target.position.z) < r) add(u, a * params.areaShare, cap);
      }
    },
    /** A shell landed at `at` with blast `radius` (combat.js splashAt). */
    onSplash(at, radius) {
      const r = radius * 1.5;
      for (const u of units.near(at.x, at.z, r, near)) {
        if (!u.alive || !onFoot(u)) continue;
        const d = Math.hypot(u.position.x - at.x, u.position.z - at.z);
        if (d < r) add(u, params.splash * (1 - 0.5 * (d / r)));
      }
    },
    /** FIXED-STEP, after combat. */
    step(dt) {
      for (const u of units.list) {
        if (!u.alive || !onFoot(u)) continue;
        const s = Math.max(0, (u.suppression ?? 0) - params.decay * dt);
        u.suppression = s;
        u.pinned = u.pinned ? s > params.unpin : s >= params.pinned;
        u.suppressed = !u.pinned && s >= params.suppressed;
        if (cover) {
          u._coverT = (u._coverT ?? ((seq++ % 8) / 8) * params.coverEvery) - dt;
          if (u._coverT <= 0) {
            u._coverT = params.coverEvery;
            u.inCover = !u.isMoving && coverOf(u) >= params.coverKneel;
          }
        }
        u.posture = u.pinned ? "prone" : u.suppressed || (u.inCover && !u.isMoving) ? "kneel" : "stand";
        u.moveMul = u.pinned ? params.movePinned : u.suppressed ? params.moveSuppressed : 1;
        u.fireMul = u.pinned ? params.firePinned : u.suppressed ? params.fireSuppressed : 1;
      }
    },
  };
}
