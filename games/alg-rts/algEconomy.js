// THE ECONOMY — this war's, not nam's. What both sides fight over is the
// POPULATION: the mechtas and the dechra.
//
//   INFLUENCE  each village has a value, −1 (the ALN's) … +1 (the French's).
//              Men ON FOOT within 40 m push it their way (not vehicles) — the more
//              men, the faster (up to three count); both sides there, the
//              stronger pushes. Nobody there, it drifts back toward neutral
//              (a village left alone for two minutes is nobody's). Past
//              ±0.6 the village is HELD, and stays held until the value
//              crosses back through 0.
//   INCOME     the French: Algiers' budget (a base) + each village they hold.
//              The ALN: a small base + each village it holds + each arms
//              cache still standing (burn the caches and the katiba starves).
//   COSTS      charged when a unit is QUEUED (algProducer.js), refused if the
//              purse can't pay.
//
// Villages are shaped as the minimap's points ({position, owner, progress}),
// so the tactical map shows them in their holder's colour for free.
import * as THREE from "three";

export const COSTS = {
  // French infantry: per SQUAD (algSquads.js: 6 appelés, 2 sapeurs, 5 paras,
  // 5 légionnaires), a little under the old per-man price × the squad.
  appele: 300, sapeur: 150, para: 450, legion: 650, willys: 90, gmc: 110, halftrack: 160, ebr: 220, amx13: 260, alouette: 320,
  moudjahid: 40, fmTeam: 70,
};

const P = {
  // ~3x the French income (you, 2026-10-02: "it takes long to be able to
  // build things"): 40/min was one appelé every 90 s with nothing held. Now
  // one every 30 s from Algiers alone; villages still clearly pay (CoH:
  // manpower always flows, territory pays for the expensive things).
  start: { player: 600, enemy: 240 },
  base: { player: 120, enemy: 15 },       // per minute (the ALN's: algDifficulty)
  village: { hamlet: 40, dechra: 60, ksar: 80 },    // per minute to its holder (a ksar: a market town)
  cache: 15,                              // per minute per standing arms cache (ALN)
  radius: 40,
  // Influence per second per man (up to 3). 0.02 turned a neutral village in
  // 10 s — the "the FLN is working it" alert came too late to answer
  // (2026-10-01). Now ~20 s from neutral with 3+, ~53 s to win one back.
  push: 0.01,
  drift: 0.005,                           // back toward 0 per second, nobody there
  hold: 0.6,
};

function purse(start) {
  const p = {
    stock: start,
    earn(n) { p.stock += n; },
    spend(n) { if (p.stock < n) return false; p.stock -= n; return true; },
    canAfford(n) { return p.stock >= n; },
  };
  return p;
}

/**
 * @param {object} o
 * @param {object[]} o.sites   layout sites (kind "hamlet" / "dechra", x, z, name)
 * @param {object} o.structures algStructures (the arms caches)
 */
export function createAlgEconomy({ app, units, sites, structures }) {
  const purses = { player: purse(P.start.player), enemy: purse(P.start.enemy) };
  const points = sites.map((s) => ({
    name: s.name, kind: s.kind,
    position: new THREE.Vector3(s.x, app.getWorldHeight?.(s.x, s.z) ?? 0, s.z),
    value: 0, owner: null, progress: 0,
  }));
  let tick = 0;

  function incomePerMinute(team) {
    let n = P.base[team];
    for (const v of points) if (v.owner === team) n += P.village[v.kind] ?? P.village.hamlet;
    if (team === "enemy") n += P.cache * structures.list.filter((s) => s.typeKey === "armsCache" && s.alive).length;
    return n;
  }

  function stepInfluence(dt) {
    for (const v of points) {
      let fr = 0, al = 0;
      for (const u of units.list) {
        // MEN ON FOOT only (as the proposal, and CoH's capture): a tank parked
        // in a mechta wins nobody over.
        if (!u.alive || u.isAir || u.ghost || !u.type?.foot) continue;
        if (Math.hypot(u.position.x - v.position.x, u.position.z - v.position.z) > P.radius) continue;
        if (u.team === "player") fr++; else if (u.team === "enemy") al++;
      }
      const net = Math.max(-3, Math.min(3, fr - al));
      if (fr || al) v.value += net * P.push * dt;
      else v.value -= Math.sign(v.value) * Math.min(Math.abs(v.value), P.drift * dt);
      v.value = Math.max(-1, Math.min(1, v.value));
      if (v.value >= P.hold) v.owner = "player";
      else if (v.value <= -P.hold) v.owner = "enemy";
      else if ((v.owner === "player" && v.value <= 0) || (v.owner === "enemy" && v.value >= 0)) v.owner = null;
      // The minimap's arc: toward whoever is winning it.
      v.progress = v.value;
    }
  }

  return {
    params: P,
    costs: COSTS,
    purses,
    french: purses.player,
    aln: purses.enemy,
    /** The minimap reads these as its points. */
    points,
    get held() { return points.filter((v) => v.owner === "player").length; },
    get heldByEnemy() { return points.filter((v) => v.owner === "enemy").length; },
    incomePerMinute,
    /** Fixed clock: influence every half second, income every second. */
    step(dt) {
      tick += dt;
      stepInfluence(dt);
      for (const team of ["player", "enemy"]) purses[team].earn((incomePerMinute(team) / 60) * dt);
    },
  };
}
