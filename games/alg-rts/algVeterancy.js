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
// The stars show on the squad's badge (ui/squadBadges.js); a promotion is announced.
//
// 2026-10-06 (the FLN's brain, C):
//   VEHICLES   their own XP and stars (no squad): accuracy, armour, rate of fire; chevrons on
//              their tab (ui/armyTabs.js).
//   THE KATIBA the ALN's bands come and go, so the katiba hardens AS A WHOLE: every French
//              soldier it kills counts, and at KATIBA thresholds every fighter of it has one
//              star more (accuracy, suppression, rate of fire; damage taken as before — the
//              guerrilla's edge is in the shooting, not the skin). Announced to the player.

export const VET = {
  thresholds: [40, 110, 220],
  value: { man: 10, fmTeam: 14, tireur: 16, vehicle: 30, structure: 25 },
  katiba: [8, 20, 40],   // French dead at the ALN's hands: the katiba's stars
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

  // THE KATIBA's experience: French killed by the ALN.
  const katiba = { kills: 0, stars: 0 };
  /** A vehicle's own: the XP on the unit, its stats set at once (no squad's kit to reset them). */
  function promoteVehicle(k) {
    while ((k.stars ?? 0) < P.thresholds.length && k.xp >= P.thresholds[k.stars ?? 0]) {
      k.stars = (k.stars ?? 0) + 1;
      const v = vetStats(k.stars);
      k.vetAcc = v.acc;
      k.fireRate = (k.type?.fireRate ?? 1) * v.fireRate;
      if (!k._vetWrapped) {
        k._vetWrapped = true;
        const td = k.takeDamage.bind(k);
        k.takeDamage = (n) => td(n * vetStats(k.stars ?? 0).armor);
      }
      app.algBattle?.say?.(`<b>${k.type?.name ?? "Un véhicule"}</b> — ${"★".repeat(k.stars)} : un équipage aguerri.`, k.position.x, k.position.z, "good");
    }
  }
  /** Every ALN fighter at the katiba's stars (each step: the new ones too). */
  function step() {
    if (!katiba.stars) return;
    const v = vetStats(katiba.stars);
    for (const u of app.algUnits?.units?.list ?? []) {
      if (!u.alive || u.team !== "enemy" || u.isStructure || u._kat === katiba.stars) continue;
      u._kat = katiba.stars;
      u.stars = katiba.stars;
      u.vetAcc = v.acc;
      u.suppressMul = v.suppress;
      u.fireRate = (u.type?.fireRate ?? 1) * v.fireRate;
    }
  }

  /** A unit died (algUnits' onDeath): the squad of the man who killed him gains. */
  function onDeath(e) {
    const k = e.lastHitBy;
    // The ALN killed a Frenchman: the katiba's tally.
    if (e.team === "player" && !e.isStructure && k?.team === "enemy") {
      katiba.kills++;
      while (katiba.stars < P.katiba.length && katiba.kills >= P.katiba[katiba.stars]) {
        katiba.stars++;
        app.algBattle?.say?.(`<b>La katiba s'aguerrit</b> — ${"★".repeat(katiba.stars)} : ses combattants tirent plus juste et tiennent mieux sous le feu.`, null, null, "bad");
      }
    }
    if (!k || k.team !== "player" || e.team === k.team) return;
    const s = squads.of(k);
    if (!s) {
      // A VEHICLE (or a man in no squad): its own XP.
      if (!k.type?.foot && !k.isStructure) { k.xp = (k.xp ?? 0) + worth(e); promoteVehicle(k); }
      return;
    }
    s.xp += worth(e);
    while (s.stars < P.thresholds.length && s.xp >= P.thresholds[s.stars]) {
      s.stars++;
      const l = s.leader?.position;
      app.algBattle?.say?.(`<b>${s.name}</b> — ${"★".repeat(s.stars)} vétérans : ils tirent plus juste et tiennent mieux sous le feu.`, l?.x ?? null, l?.z ?? null, "good");
    }
  }

  return { params: P, onDeath, toNext, vetStats, step, katiba };
}
