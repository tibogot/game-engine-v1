// SQUADS — Company of Heroes squads for the French (you, 2026-10-03: "squads +
// retreat + reinforce"). A LAYER over the men: every man stays a unit in
// units.list (combat, the fog, the economy, the voices all read the men); a
// squad is a named group of them with slots, and the orders, the HUD and the
// production work by squad.
//
//   BOUGHT AS A SQUAD   the post trains a whole squad per click (algProducer
//                       `countOf`), one man per slot; slot 0 is the leader,
//                       1 the radioman, 2 the FM gunner (soldierLooks roles).
//   SELECTED AS ONE     a click or a box on one man selects his squad
//                       (shared selection `squadOf`); a move forms each squad
//                       round its own spot.
//   RETREAT (T)         the squad drops everything and runs for the post:
//                       holds its fire, shrugs off pinning, runs at 140%,
//                       takes 40% less fire. Back inside the post's zone it
//                       stops — and its wounded HEAL there.
//   REINFORCE           in the post's zone, a squad short of men can call one
//                       in per click (a fraction of the squad's price): he
//                       comes out of the gate in the dead man's slot (his kit)
//                       and runs to his squad.
//   WIPED OUT           a squad with no one left is gone (its tab with it).
//   VETERANCY           the squad's XP and stars (algVeterancy.js): every man of
//                       it, newcomers too, fights with the squad's stars.
//   UPGRADES            bought for the SQUAD (munitions), kept by its slot:
//                       FM 24/29 — the appelés' slot-2 man (already dressed as
//                       the FM gunner) carries the light machine gun; a
//                       replacement in that slot gets it back.
//
// The ALN keeps its own bands (algAI.js); vehicles stay single units.
import { vetStats } from "./algVeterancy.js";

/** Infantry squads: men per squad, the squad's name, and what one man costs to replace. */
export const SQUADS = {
  appele: { size: 6, name: "Groupe", reinforce: 30 },
  sapeur: { size: 2, name: "Équipe du génie", reinforce: 45 },
  para: { size: 5, name: "Stick para", reinforce: 60 },
  legion: { size: 5, name: "Groupe Légion", reinforce: 80 },
};

/** Squad upgrades: who can buy it, the price, the slot that carries it, his weapon. */
export const UPGRADES = {
  lmg: {
    label: "FM 24/29", squads: ["appele"], cost: { mun: 60 }, slot: 2,
    weapon: { weapon: "mg", range: 42, damage: 5, fireRate: 4.5 },
    hint: "The squad's FM gunner gets the FM 24/29 light machine gun: bursts that pin men down at 42 m. Kept by the squad (a replacement in his slot picks it up).",
  },
};

const P = {
  baseRadius: 48,        // m round the post's centre: retreat ends here, heals, reinforces
  heal: 3,               // hp per second, in the base zone, out of combat
  retreatSpeed: 1.4,
  retreatDamage: 0.6,
  reinforceTime: 4,      // s for a replacement to come out of the gate
};

/**
 * @param {object} o
 * @param {object} o.units
 * @param {object} o.base    { x, z } the post's centre (the retreat point's zone)
 * @param {object} o.muster  { x, z } where retreating squads form up
 * @param {(n:number)=>boolean} o.pay  spend supplies (the French purse)
 * @param {object} o.post    the post's producer (inside/outside points) — replacements come out of it
 */
export function createAlgSquads({ app, units, base, muster, pay, post }) {
  const list = [];
  const ofUnit = new Map();
  let seq = 0;
  const pending = [];    // replacements on their way: { squad, slot, t }

  /** A new, empty squad of `typeKey` for `team`. */
  function create(typeKey, team = "player") {
    const def = SQUADS[typeKey];
    if (!def) return null;
    const n = list.filter((s) => s.typeKey === typeKey).length + 1;
    const s = {
      id: ++seq, typeKey, team, size: def.size, name: `${def.name} ${n}`,
      slots: new Array(def.size).fill(null),
      retreating: false,
      xp: 0, stars: 0,          // algVeterancy.js
      upgrades: {},             // UPGRADES keys bought
      get members() { return s.slots.filter((u) => u?.alive); },
      get count() { return s.members.length; },
      get leader() { return s.members[0] ?? null; },
    };
    list.push(s);
    return s;
  }
  function join(s, u, slot) {
    s.slots[slot] = u;
    u.squad = s;
    ofUnit.set(u, s);
  }
  /** A man is in no squad any more (dead, or the squad gone). */
  function leave(u) {
    const s = ofUnit.get(u);
    if (!s) return;
    ofUnit.delete(u);
    const i = s.slots.indexOf(u);
    if (i >= 0) s.slots[i] = null;
    if (!s.members.length && !pending.some((p) => p.squad === s)) list.splice(list.indexOf(s), 1);
  }

  const inBase = (x, z) => Math.hypot(x - base.x, z - base.z) < P.baseRadius;
  const squadInBase = (s) => s.members.length > 0 && s.members.every((u) => inBase(u.position.x, u.position.z));

  /** RETREAT: run for the post. */
  function retreat(s) {
    if (!s || !s.members.length) return;
    s.retreating = true;
    s.members.forEach((u, k) => {
      u.holdFire = true;
      u.target = u.attackTarget = null;
      const a = k * 2.39996 + s.id, r = k === 0 ? 0 : 3;
      u.moveOrder(muster.x + Math.cos(a) * r + (s.id % 3 - 1) * 9, muster.z + Math.sin(a) * r + (Math.floor(s.id / 3) % 3 - 1) * 9);
    });
  }
  function endRetreat(s) {
    s.retreating = false;
    for (const u of s.members) u.holdFire = false;
  }

  /** What one more man costs this squad (0 = can't). */
  function reinforceCost(s) {
    if (!s || s.team !== "player" || s.count + pending.filter((p) => p.squad === s).length >= s.size) return 0;
    if (!squadInBase(s)) return 0;
    return SQUADS[s.typeKey].reinforce;
  }
  /** Call one man in (paid now): he comes out of the gate in the first empty slot. */
  function reinforce(s) {
    const cost = reinforceCost(s);
    if (!cost || !pay(cost)) return false;
    const taken = new Set(pending.filter((p) => p.squad === s).map((p) => p.slot));
    const slot = s.slots.findIndex((u, i) => !u?.alive && !taken.has(i));
    if (slot < 0) return false;
    pending.push({ squad: s, slot, t: P.reinforceTime });
    return true;
  }

  // Combat damage on a retreating man is cut (wrap each man's takeDamage once).
  function wrapDamage(u) {
    if (u._squadDmg) return;
    const td = u.takeDamage.bind(u);
    // A veteran squad takes less (vetArmor, set each step by applyKit).
    u.takeDamage = (n) => td((u.squad?.retreating ? n * P.retreatDamage : n) * (u.vetArmor ?? 1));
    u._squadDmg = true;
  }

  /**
   * Every man's kit and bonuses from his squad: the weapon of his slot (an
   * upgrade, or his type's), and the squad's veterancy (algVeterancy.js).
   */
  function applyKit(s) {
    const v = vetStats(s.stars);
    s.slots.forEach((u, i) => {
      if (!u?.alive) return;
      const up = Object.keys(s.upgrades).map((k) => UPGRADES[k]).find((g) => g.slot === i && g.squads.includes(s.typeKey));
      const w = up?.weapon ?? u.type;
      u.weapon = w.weapon ?? null;
      u.range = w.range ?? 0;
      u.damage = w.damage ?? 0;
      u.fireRate = (w.fireRate ?? 1) * v.fireRate;
      u.vetAcc = v.acc;
      u.vetArmor = v.armor;
      u.suppressMul = v.suppress;
    });
  }

  /** What the upgrade `key` costs this squad now (null: it can't have it, or has it). */
  function upgradeCost(s, key) {
    const g = UPGRADES[key];
    if (!g || !s || s.team !== "player" || !g.squads.includes(s.typeKey) || s.upgrades[key]) return null;
    return g.cost;
  }
  /** Buy the upgrade `key` for the squad (paid now). */
  function upgrade(s, key) {
    const cost = upgradeCost(s, key);
    if (!cost || !pay(cost)) return false;
    s.upgrades[key] = true;
    applyKit(s);
    return true;
  }

  /** FIXED STEP, after posture (it overrides a retreating man's posture). */
  function step(dt) {
    for (const s of [...list]) {
      for (const u of s.slots) if (u && !u.alive) leave(u);
      if (!list.includes(s)) continue;
      applyKit(s);
      if (s.retreating) {
        for (const u of s.members) {
          u.pinned = false; u.suppressed = false; u.posture = "stand";
          u.moveMul = P.retreatSpeed;
        }
        // Home: every man in the zone and (nearly) stopped.
        if (squadInBase(s) && s.members.every((u) => !u.isMoving || Math.hypot(u.position.x - muster.x, u.position.z - muster.z) < 14)) endRetreat(s);
      }
      // The wounded heal in the post's zone, out of the fight.
      for (const u of s.members) {
        if (u.hp < u.maxHp && inBase(u.position.x, u.position.z) && !u.target && (u.suppression ?? 0) < 0.1) u.hp = Math.min(u.maxHp, u.hp + P.heal * dt);
      }
    }
    // Replacements coming out of the gate.
    for (let i = pending.length - 1; i >= 0; i--) {
      const p = pending[i];
      p.t -= dt;
      if (p.t > 0) continue;
      pending.splice(i, 1);
      const s = p.squad;
      const u = units.spawn(s.typeKey, post.inside.x, post.inside.z, { snap: false, team: s.team, lookRole: p.slot });
      if (!u) continue;
      wrapDamage(u);
      join(s, u, p.slot);
      if (!list.includes(s)) list.push(s);
      const l = s.members.find((m) => m !== u) ?? null;
      const to = l ? l.position : muster;
      u.emerge(post.outside.x, post.outside.z, to.x + 2, to.z + 2);
      // Selected squad: the newcomer joins the selection.
      if ((s.members.find((m) => m !== u))?.selected && app.selection) app.selection.select([...new Set([...app.selection.selected, u])]);
    }
  }

  return {
    list, P, create, join, leave, retreat, endRetreat, reinforce, reinforceCost, step, inBase, upgrade, upgradeCost,
    /** A new man of a squad being BOUGHT (the producer's batch): `slot` 0 opens a new squad. */
    bought(u, key, slot) {
      if (!SQUADS[key] || u.team !== "player") return;
      wrapDamage(u);
      let s = slot === 0 ? null : [...list].reverse().find((q) => q.typeKey === key && q._forming);
      if (!s) { s = create(key, u.team); s._forming = true; }
      join(s, u, slot);
      if (slot === SQUADS[key].size - 1) s._forming = false;
    },
    /** Start-of-game men into squads. */
    adopt(men, key) {
      const size = SQUADS[key]?.size ?? men.length;
      for (let i = 0; i < men.length; i += size) {
        const s = create(key, men[i].team);
        men.slice(i, i + size).forEach((u, k) => { wrapDamage(u); join(s, u, k); });
      }
    },
    /** The man's squad mates (him included), or null. */
    squadOf(u) { return ofUnit.get(u)?.members ?? null; },
    of(u) { return ofUnit.get(u) ?? null; },
    /** The squads of a selection, each once. */
    squadsIn(sel) { return [...new Set(sel.map((u) => ofUnit.get(u)).filter(Boolean))]; },
    pendingFor(s) { return pending.filter((p) => p.squad === s).length; },
  };
}
