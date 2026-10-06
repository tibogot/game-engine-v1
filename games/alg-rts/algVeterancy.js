// VETERANCY (you, 2026-10-04: "veterancy + smoke + the LMG upgrade + the mortar barrage") — the
// Company of Heroes way: a French SQUAD earns experience from the enemies it kills, and at three
// thresholds a STAR. A veteran squad is worth saving: retreat it, reinforce it — the newcomers
// fight with the squad's stars (they are the squad's, not the men's).
//
//   XP          per kill credited to one of the squad's men (combat.js `lastHitBy`: the man
//               whose round or grenade hit him last): a moudjahid 10, an FM team 14, a vehicle
//               30, a building 25.
//   STARS       at 40 / 110 / 220 XP (CoH-ish: the first star after a few fights, the third
//               after a long war).
//   EACH STAR   +12% accuracy (algAccuracy.js `vetAcc`), −8% damage taken (algSquads'
//               damage wrap `vetArmor`), −15% suppression taken (infantryPosture `suppressMul`),
//               +5% rate of fire.
//
// The stars show on the squad's badge (ui/squadBadges.js); a promotion is announced. Vehicles
// and the ALN have no veterancy yet (TODO.md).

export const VET = {
  thresholds: [40, 110, 220],
  value: { man: 10, fmTeam: 14, vehicle: 30, structure: 25 },
  perStar: { acc: 0.12, armor: 0.08, suppress: 0.15, fireRate: 0.05 },
};

/** The multipliers for a squad with `stars` stars. */
export function vetStats(stars = 0) {
  const k = VET.perStar;
  return { acc: 1 + k.acc * stars, armor: 1 - k.armor * stars, suppress: 1 - k.suppress * stars, fireRate: 1 + k.fireRate * stars };
}

/**
 * @param {object} o
 * @param {object} o.app
 * @param {object} o.squads   algSquads (of, the squads' xp / stars)
 */
export function createAlgVeterancy({ app, squads }) {
  const P = VET;
  const worth = (e) => (e.isStructure ? P.value.structure : e.type?.foot ? (P.value[e.typeKey] ?? P.value.man) : P.value.vehicle);

  /** XP still needed for the next star (null at three). */
  const toNext = (s) => (s.stars >= P.thresholds.length ? null : P.thresholds[s.stars] - s.xp);

  /** A unit died (algUnits' onDeath): the squad of the man who killed him gains. */
  function onDeath(e) {
    const k = e.lastHitBy;
    if (!k || k.team !== "player" || e.team === k.team) return;
    const s = squads.of(k);
    if (!s) return;
    s.xp += worth(e);
    while (s.stars < P.thresholds.length && s.xp >= P.thresholds[s.stars]) {
      s.stars++;
      const l = s.leader?.position;
      app.algBattle?.say?.(`<b>${s.name}</b> — ${"★".repeat(s.stars)} vétérans : ils tirent plus juste et tiennent mieux sous le feu.`, l?.x ?? null, l?.z ?? null, "good");
    }
  }

  return { params: P, onDeath, toNext, vetStats };
}
