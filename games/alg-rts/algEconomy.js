// THE ECONOMY — this war's, not nam's. What both sides fight over is the
// POPULATION (the mechtas, the dechra, the ksar) and the ROADS between them.
//
// THREE RESOURCES for the French (2026-10-03, you: "the full three-resource
// economy", Company of Heroes):
//   EFFECTIFS  (mp)   manpower: flows from Algiers all the time, less an
//                     UPKEEP per man and vehicle in the field. Buys and
//                     reinforces infantry, part of everything.
//   CARBURANT  (fuel) from the land: villages, fuel points. Vehicles, the
//                     Alouette, the tiers.
//   MUNITIONS  (mun)  from the land: villages, munition points. Grenades,
//                     the Légion, (later) abilities and upgrades.
// A point PAYS only while LINKED to the post — a chain of points the French
// hold, each within LINK m of the next (CoH's supply lines): lose the one in
// between and the far ones stop paying.
//
//   INFLUENCE  each point has a value, −1 (the ALN's) … +1 (the French's).
//              Men ON FOOT within 40 m push it their way (not vehicles) — the more
//              men, the faster (up to three count). Nobody there, it drifts
//              back toward neutral. Past ±0.6 the point is HELD, and stays held
//              until the value crosses back through 0.
//   POINTS     `points`  the VILLAGES (the war's score, the AI, the objectives);
//              `supply`  the FUEL / MUNITION points along the pistes;
//              `allPoints` both (the map's markers and rings).
//   THE ALN    keeps ONE purse (its supplies): a small base + its villages +
//              each arms cache still standing.
//   COSTS      charged when a unit is QUEUED (algProducer.js), refused if the
//              purse can't pay. A number = effectifs alone.
import * as THREE from "three";
import { MAP } from "./layout.js";
import { t } from "./i18n/i18n.js";

/** What each unit costs: French { mp, fuel, mun } (per SQUAD for infantry), the ALN's a number. */
export const COSTS = {
  appele: { mp: 270 }, sapeur: { mp: 170 }, piece: { mp: 240, mun: 20 },
  para: { mp: 320, fuel: 25 }, legion: { mp: 380, mun: 45 },
  willys: { mp: 110, fuel: 20 }, gmc: { mp: 140, fuel: 30 }, halftrack: { mp: 190, fuel: 50 },
  ebr: { mp: 240, fuel: 75 }, amx13: { mp: 290, fuel: 105 }, alouette: { mp: 280, fuel: 120 },
  moudjahid: 40, fmTeam: 70, tireur: 90,
};

/**
 * POPULATION (balance pass 2026-10-04, CoH's pop cap): what a French unit takes — a man 1 (a
 * squad: its men), a vehicle its number here. The cap grows with the villages held (algUnits.js
 * refuses a unit or a reinforcement past it).
 */
export const POP = { willys: 2, gmc: 2, halftrack: 3, ebr: 4, amx13: 4, alouette: 4 };

/** The three, in display order. */
export const RES = [
  { key: "mp", name: t("Effectifs"), short: "", cls: "mp" },
  { key: "fuel", name: t("Carburant"), short: "C", cls: "fuel" },
  { key: "mun", name: t("Munitions"), short: "M", cls: "mun" },
];

/** A cost as { mp, fuel, mun } (a number = effectifs). */
export function costOf(c) {
  if (c == null) return { mp: 0, fuel: 0, mun: 0 };
  if (typeof c === "number") return { mp: c, fuel: 0, mun: 0 };
  return { mp: c.mp ?? 0, fuel: c.fuel ?? 0, mun: c.mun ?? 0 };
}
export const hasCost = (c) => { const k = costOf(c); return k.mp > 0 || k.fuel > 0 || k.mun > 0; };

/** The supply points (fuel / munitions): the map's own (layout.js MAP.supply). */
const SUPPLY = MAP.supply ?? [];

const P = {
  start: { player: { mp: 600, fuel: 40, mun: 50 }, enemy: 240 },
  // Per minute. The French: Algiers' effectifs, a trickle of the rest.
  base: { player: { mp: 280, fuel: 4, mun: 6 }, enemy: 15 },
  // UPKEEP (effectifs a minute): every man past the first UPKEEP_FREE, every vehicle.
  // (balance 2026-10-04: 1.5 / 5 cost a 50-strong army 9% of its effectifs; CoH's ~30%)
  upkeepMan: 2.5, upkeepVehicle: 8, upkeepFree: 14, mpFloor: 100,
  // POP CAP: 30, +5 a village held, 50 at most (the start army is 16).
  popBase: 30, popPerVillage: 5, popMax: 50,
  // A village to its holder (the ALN: one number, as before).
  village: {
    hamlet: { mp: 20, fuel: 6, mun: 8 }, dechra: { mp: 25, fuel: 8, mun: 10 }, ksar: { mp: 30, fuel: 10, mun: 12 },
  },
  villageAln: { hamlet: 40, dechra: 60, ksar: 80 },
  supplyPoint: 12,                        // its resource a minute
  supplyAln: 6,                           // the ALN's supplies a minute per supply point it holds (algAI.js raids)
  // m between two held points of a supply line. 180: the ksar needs the col,
  // the far mechta the ford, the dechra Aïn Kerma (240 linked nearly all
  // straight to the post).
  link: 180,
  cache: 15,                              // per minute per standing arms cache (ALN)
  radius: 40,
  supplyRadius: 22,                       // a supply point's capture ring
  // Influence per second per man (up to 3): ~20 s from neutral with 3+.
  push: 0.01,
  drift: 0.005,                           // back toward 0 per second, nobody there
  hold: 0.6,
};

/** The ALN's one-number purse. */
function purse(start) {
  const p = {
    stock: start,
    earn(n) { p.stock += typeof n === "number" ? n : (n?.mp ?? 0); },
    spend(n) { const c = costOf(n).mp; if (p.stock < c) return false; p.stock -= c; return true; },
    canAfford(n) { return p.stock >= costOf(n).mp; },
  };
  return p;
}
/**
 * The French purse: three stocks. `stock` is the effectifs (the old calls:
 * a number spent, earned or checked is effectifs).
 */
function purse3(start) {
  const p = {
    mp: start.mp, fuel: start.fuel, mun: start.mun,
    get stock() { return p.mp; },
    set stock(v) { p.mp = v; },
    earn(n) { const c = costOf(n); p.mp += c.mp; p.fuel += c.fuel; p.mun += c.mun; },
    canAfford(n) { const c = costOf(n); return p.mp >= c.mp && p.fuel >= c.fuel && p.mun >= c.mun; },
    spend(n) {
      if (!p.canAfford(n)) return false;
      const c = costOf(n);
      p.mp -= c.mp; p.fuel -= c.fuel; p.mun -= c.mun;
      return true;
    },
    /** What is short for `n` (for a tooltip): "45 Carburant", or "". */
    short(n) {
      const c = costOf(n), out = [];
      for (const r of RES) if (p[r.key] < c[r.key]) out.push(`${Math.ceil(c[r.key] - p[r.key])} ${r.name}`);
      return out.join(", ");
    },
  };
  return p;
}

/**
 * @param {object} o
 * @param {object[]} o.sites   layout sites (kind "hamlet" / "dechra", x, z, name)
 * @param {object} o.structures algStructures (the arms caches)
 * @param {{x:number,z:number}} [o.post]  the French post (the supply lines' root)
 */
export function createAlgEconomy({ app, units, sites, structures, post = null }) {
  const purses = { player: purse3(P.start.player), enemy: purse(P.start.enemy) };
  const at = (x, z) => new THREE.Vector3(x, app.getWorldHeight?.(x, z) ?? 0, z);
  const points = sites.map((s) => ({
    name: s.name, kind: s.kind, position: at(s.x, s.z),
    value: 0, owner: null, progress: 0, linked: false, linkFrom: null, radius: P.radius,
  }));
  const supply = SUPPLY.map((s) => ({
    name: s.res === "fuel" ? t("{name} · carburant", { name: s.name }) : t("{name} · munitions", { name: s.name }), kind: "supply", res: s.res,
    position: at(s.x, s.z), value: 0, owner: null, progress: 0, linked: false, linkFrom: null, radius: P.supplyRadius,
  }));
  const allPoints = [...points, ...supply];
  let tick = 0;

  /** Which French points are linked to the post (a chain of held points, each within LINK m). */
  function relink() {
    for (const v of allPoints) { v.linked = false; v.linkFrom = null; }
    if (!post) { for (const v of allPoints) v.linked = v.owner === "player"; return; }
    // Breadth first from the post: each point hangs off the NEAREST linked one
    // reached first (the minimap draws these as the supply lines).
    const front = [{ position: { x: post.x, z: post.z } }];
    for (let i = 0; i < front.length; i++) {
      const a = front[i];
      for (const v of allPoints) {
        if (v.linked || v.owner !== "player") continue;
        if (Math.hypot(v.position.x - a.position.x, v.position.z - a.position.z) <= P.link) { v.linked = true; v.linkFrom = a.position; front.push(v); }
      }
    }
  }

  /** The upkeep: effectifs a minute for the French army in the field. */
  function upkeep() {
    let men = 0, veh = 0;
    for (const u of units.list) {
      if (!u.alive || u.team !== "player" || u.isStructure) continue;
      if (u.type?.foot) men++; else veh++;
    }
    return Math.max(0, men - P.upkeepFree) * P.upkeepMan + veh * P.upkeepVehicle;
  }

  /** Income a minute: the French { mp, fuel, mun }, the ALN a number. */
  function incomeOf(team) {
    if (team === "enemy") {
      let n = P.base.enemy;
      for (const v of points) if (v.owner === "enemy") n += P.villageAln[v.kind] ?? P.villageAln.hamlet;
      n += P.cache * structures.list.filter((s) => s.typeKey === "armsCache" && s.alive).length;
      n += P.supplyAln * supply.filter((v) => v.owner === "enemy").length;
      return n;
    }
    const inc = { ...P.base.player };
    // THE LINE CUT (algTelegraph.js): Algiers' effectifs come slower.
    if (app?.algTelegraph?.cut) inc.mp *= app.algTelegraph.params.mpMul;
    for (const v of points) {
      if (v.owner !== "player" || !v.linked) continue;
      const g = P.village[v.kind] ?? P.village.hamlet;
      inc.mp += g.mp; inc.fuel += g.fuel; inc.mun += g.mun;
    }
    for (const v of supply) if (v.owner === "player" && v.linked) inc[v.res] += P.supplyPoint;
    inc.mp = Math.max(P.mpFloor, inc.mp - upkeep());
    return inc;
  }

  function stepInfluence(dt) {
    for (const v of allPoints) {
      let fr = 0, al = 0;
      for (const u of units.list) {
        // MEN ON FOOT only (CoH's capture): a tank parked in a mechta wins nobody over.
        if (!u.alive || u.isAir || u.ghost || !u.type?.foot) continue;
        if (Math.hypot(u.position.x - v.position.x, u.position.z - v.position.z) > v.radius) continue;
        if (u.team === "player") fr++; else if (u.team === "enemy") al++;
      }
      const net = Math.max(-3, Math.min(3, fr - al));
      if (fr || al) v.value += net * P.push * dt * (v.kind === "supply" ? 1.6 : 1);
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
    /** The VILLAGES (the war's score). */
    points,
    /** The fuel and munition points. */
    supply,
    /** Villages and supply points (the map's markers, rings, minimap). */
    allPoints,
    get held() { return points.filter((v) => v.owner === "player").length; },
    /** The French population cap now (POP). */
    popCap: () => Math.min(P.popMax, P.popBase + P.popPerVillage * points.filter((v) => v.owner === "player").length),
    get heldByEnemy() { return points.filter((v) => v.owner === "enemy").length; },
    /** French points held but cut off from the post (they pay nothing). */
    get cutOff() { return allPoints.filter((v) => v.owner === "player" && !v.linked).length; },
    incomeOf,
    upkeep,
    /** The old call: effectifs a minute (French) / supplies (ALN). */
    incomePerMinute: (team) => (team === "enemy" ? incomeOf("enemy") : incomeOf("player").mp),
    /** Fixed clock: influence, links and income every step. */
    step(dt) {
      tick += dt;
      stepInfluence(dt);
      relink();
      purses.player.earn(Object.fromEntries(Object.entries(incomeOf("player")).map(([k, v]) => [k, (v / 60) * dt])));
      purses.enemy.earn((incomeOf("enemy") / 60) * dt);
    },
  };
}
