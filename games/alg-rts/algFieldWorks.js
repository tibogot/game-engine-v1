// FIELD WORKS — what the sappers raise OUT on the map (2026-10-10, you: "compare with CoH — do we
// have enough buildings?"). CoH's engineers build in the field, not only at the base: a forward HQ,
// an aid station, a point dug in. Ours (algBuild.js BUILDS, the sappers' card):
//
//   POSTE AVANCÉ    a radio shelter inside a point you hold: your squads within P.reach reinforce
//                   there as at the post (algSquads fieldPoints — the still half-track's rule).
//   POSTE DE SECOURS the medic's tent: your men on foot within P.aidReach heal, out of the fight.
//   POINT FORTIFIÉ  sandbags in a point you hold: it pays 25% more and the FLN takes twice as long
//                   to turn it (algEconomy reads `fortified`). One of each per point.
//
// Destroyed, they stop working (they are structures: the FLN can shoot them down).
// THE FLN'S (2026-10-13, A3): its INFIRMERIE heals its men as the aid station heals the French; its REFUGES
// are its forward posts — its squads reinforce there (a human playing the FLN: algSquads `aln`).
export const FIELDWORKS = { reach: 30, aidReach: 20, aidHeal: 2.5, check: 0.5 };
const P = FIELDWORKS;

export function createAlgFieldWorks(app, { units, structures, economy }) {
  const of = (key) => structures.list.filter((s) => s.alive && s.typeKey === key && !s.constructing);
  let checkT = 0;
  function step(dt) {
    // The aid stations: a slow heal to men on foot nearby who are not fighting.
    const aids = [...of("aidStation"), ...of("infirmary")];
    if (aids.length) {
      for (const u of units.list) {
        if (!u.alive || !u.type?.foot || u.type.animal || u.inside || u.hp >= u.maxHp) continue;
        if (u.target || (u.suppression ?? 0) > 0.1) continue;
        if (aids.some((s) => s.team === u.team && Math.hypot(u.position.x - s.position.x, u.position.z - s.position.z) < P.aidReach)) u.hp = Math.min(u.maxHp, u.hp + P.aidHeal * dt);
      }
    }
    if ((checkT -= dt) > 0) return;
    checkT = P.check;
    // The fortified points: a point with a standing fort in its ring.
    const forts = of("fortPoint");
    for (const v of economy.allPoints) v.fortified = forts.some((s) => Math.hypot(s.position.x - v.position.x, s.position.z - v.position.z) < (v.radius ?? 40));
  }
  return {
    params: P, step,
    /** Field reinforcement points (algSquads `fieldPoints`): the standing forward posts. */
    forwardPosts: () => of("forwardPost").map((s) => { s.radius ??= 6; return s; }),
    /** The FLN's: its standing refuges (a human's squads reinforce there). */
    refuges: () => of("refuge").filter((s) => s.team === "enemy").map((s) => { s.radius ??= 4; return s; }),
  };
}
