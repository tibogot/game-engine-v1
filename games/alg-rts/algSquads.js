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
//                       IN THE FIELD (2026-10-09, CoH's half-track): every man of
//                       the squad within 30 m of one of your half-tracks STANDING
//                       STILL — the man climbs out of its tailgate instead.
//   WIPED OUT           a squad with no one left is gone (its tab with it).
//   VETERANCY           the squad's XP and stars (algVeterancy.js): every man of
//                       it, newcomers too, fights with the squad's stars.
//   UPGRADES            bought for the SQUAD (munitions), kept by its slot:
//                       FM 24/29 — the appelés' slot-2 man (already dressed as
//                       the FM gunner) carries the light machine gun; a
//                       replacement in that slot gets it back.
//
// The ALN AI keeps its own bands (algAI.js); vehicles stay single units.
// PLAYING THE FLN (?side=fln, 2026-10-13): the human's moudjahidine come in squads too — bought as
// one at the cave, retreating to it, healing and reinforced there (`aln`, the FLN's home). The AI's
// men are never in one (it buys single men and makes its own bands).
import { vetStats } from "./algVeterancy.js";
import { isHuman } from "../shared-rts/teams.js";
import { t } from "./i18n/i18n.js";

/** Infantry squads: men per squad, the squad's name, and what one man costs to replace. */
export const SQUADS = {
  appele: { size: 6, name: t("Groupe"), reinforce: 30 },
  // 3 (balance 2026-10-04): two men at 170 were the dearest and the most fragile in the game (CoH: 3-4).
  sapeur: { size: 3, name: t("Équipe du génie"), reinforce: 45 },
  // The machine-gun team (algMgTeam.js): slot 0 carries the gun (`kit`, as an upgrade's weapon).
  piece: { size: 3, name: t("Pièce FM"), reinforce: 40, kit: { 0: { weapon: "mg", range: 48, damage: 6, fireRate: 5 } } },
  // The flamethrower team (algFlamethrower.js): slot 0 the operator (his type's lance), slot 1 the
  // loader with a rifle.
  lanceFlammes: { size: 2, name: t("Lance-flammes"), reinforce: 45, kit: { 1: { weapon: "rifle", range: 30, damage: 6, fireRate: 2.4 } } },
  // The 81 mm mortar team (algMortarTeam.js): slot 0 the tube (range 0: the module aims and fires it).
  mortierFr: { size: 3, name: t("Groupe de mortier"), reinforce: 40, kit: { 0: { weapon: "mortar", range: 0, damage: 0, fireRate: 1 } } },
  para: { size: 5, name: t("Stick para"), reinforce: 60 },
  legion: { size: 5, name: t("Groupe Légion"), reinforce: 80 },
  // A destroyed vehicle's CREW (algCrews.js): whoever got out, MAT 49s at short range; never
  // reinforced (reinforce 0: no price, no button).
  equipage: { size: 3, name: t("Équipage"), reinforce: 0, kit: Object.fromEntries([0, 1, 2].map((i) => [i, { weapon: "rifle", range: 24, damage: 5, fireRate: 3.2 }])) },
  // THE FLN's, for a human playing it: a faoudj of four moudjahidine (the ALN's smallest unit);
  // the FM gunner and the marksman each a squad of one (retreat, a badge — no reinforcing).
  moudjahid: { size: 4, name: t("Faoudj"), reinforce: 35, side: "enemy" },
  fmTeam: { size: 1, name: t("Tireur FM"), reinforce: 0, side: "enemy" },
  tireur: { size: 1, name: t("Tireur d'élite"), reinforce: 0, side: "enemy" },
  // The mortar team (algMortarTeam.js): slot 0 the tube (range 0: the module aims and fires it).
  mortier: { size: 3, name: t("Mortier"), reinforce: 40, side: "enemy", kit: { 0: { weapon: "mortar", range: 0, damage: 0, fireRate: 1 } } },
  // The recoilless rifle (algRecoilless.js): slot 0 the gun (his type's), slot 1 the loader's rifle.
  // The tripod HMG (algMgTeam.js set-up): slot 0 the gun, slot 1 the loader's rifle.
  mitrailleuse: { size: 2, name: t("Mitrailleuse"), reinforce: 45, side: "enemy", kit: { 1: { weapon: "rifle", range: 30, damage: 6, fireRate: 2.4 } } },
  sansRecul: { size: 2, name: t("Sans-recul"), reinforce: 45, side: "enemy", kit: { 1: { weapon: "rifle", range: 30, damage: 6, fireRate: 2.4 } } },
};
/** Men per purchase at a producer: a squad for the French, and for the FLN only when a human plays it. */
export const squadSize = (key, team) => (SQUADS[key] && (team === "player" || isHuman(team)) && (SQUADS[key].side ?? "player") === team ? SQUADS[key].size : 1);

/** Squad upgrades: who can buy it, the price, the slot that carries it, his weapon. */
export const UPGRADES = {
  lmg: {
    // (2026-10-09, munitions sinks: the Légion's and the paras' too — munitions piled up unspent.)
    label: "FM 24/29", squads: ["appele", "legion", "para"], cost: { mun: 60 }, slot: 2,
    weapon: { weapon: "mg", range: 42, damage: 5, fireRate: 4.5 },
    hint: t("Le tireur du groupe reçoit le fusil-mitrailleur FM 24/29 : des rafales qui clouent au sol à 42 m. Le groupe le garde (son remplaçant le reprend)."),
  },
  // THE RADIO (2026-10-10, CoH's forward observer): the radioman's set (slot 1 — his look already
  // carries one) — the section calls the mortar barrage and the T-6 itself, on ground it SEES
  // (algUnits.js radioBarrage / radioAir). No weapon: his rifle stays.
  radio: {
    label: t("Radio"), squads: ["appele", "legion", "para"], cost: { mun: 50 }, slot: 1,
    hint: t("Le radio du groupe reçoit un poste SCR-300 : le groupe appelle lui-même le tir de barrage (la fosse de mortier la plus proche, à sa portée) et le T-6 du poste, sur ce que vos hommes voient. Le groupe le garde (son remplaçant le reprend)."),
  },
  // THE FAOUDJ'S BAZOOKA (2026-10-15, you: "historically they had some"): the M20 3.5-inch, smuggled
  // in through the borders (and some taken from the French) — CoH's bazooka on a rifle squad. Slot 3,
  // a rifleman, carries it (`prop`: the renderer hands him the tube). A direct-fire SHELL like the
  // recoilless ("cannon": algArmour's shell table) — less reach and punch than the 57 mm team, but it
  // goes WITH the squad: the convoy ambush, a half-track on the move. Weak against men (footMul).
  // A human FLN's, paid from the FLN stock, only while an ARMS CACHE stands (the smuggled weapons).
  bazooka: {
    label: t("Bazooka"), squads: ["moudjahid"], side: "enemy", cost: 80, slot: 3, prop: "m20", needs: "armsCache",
    weapon: { weapon: "cannon", range: 40, damage: 70, fireRate: 0.16, footMul: 0.35 },
    hint: t("Un moudjahid du faoudj reçoit un bazooka M20 passé par les frontières : il perce un half-track ou un blindé léger à 40 m, peu efficace contre les hommes. Le faoudj le garde (son remplaçant le reprend)."),
  },
};

// s before a replacement steps out of the post that its gate starts to open (the leaves swing at
// 1.8 rad/s: open by the time he is at it).
const GATE_AHEAD = 1.2;

const P = {
  baseRadius: 48,        // m round the post's centre: retreat ends here, heals, reinforces
  heal: 3,               // hp per second, in the base zone, out of combat
  retreatSpeed: 1.4,
  retreatDamage: 0.6,
  reinforceTime: 4,      // s for a replacement to come out of the gate
  fieldRadius: 30,       // m: a squad this near a still half-track reinforces there
};

/**
 * @param {object} o
 * @param {object} o.units
 * @param {object} o.base    { x, z } the post's centre (the retreat point's zone)
 * @param {object} o.muster  { x, z } where retreating squads form up
 * @param {(n:number)=>boolean} o.pay  spend supplies (the French purse)
 * @param {object} o.post    the post's producer (inside/outside points) — replacements come out of it
 * @param {object} [o.aln]   the FLN's home when a human plays it: { base, muster, pay, post } (the cave)
 */
export function createAlgSquads({ app, units, base, muster, pay, post, popRoom = () => Infinity, fieldPoints = () => [], aln = null }) {
  /** A squad's home: the post for the French, the cave for the FLN. */
  const FR = { base, muster, pay, post };
  const home = (s) => (s?.team === "enemy" && aln ? aln : FR);
  // `fieldPoints()`: the vehicles a squad may reinforce at in the field (alg: your half-tracks standing still).
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

  const inBase = (x, z, s = null) => { const b = home(s).base; return Math.hypot(x - b.x, z - b.z) < P.baseRadius; };
  const squadInBase = (s) => s.members.length > 0 && s.members.every((u) => inBase(u.position.x, u.position.z, s));
  /** The field point (a still half-track) every man of the squad is within reach of, or null. */
  function fieldPointOf(s) {
    if (!s.members.length) return null;
    for (const v of fieldPoints()) {
      if (v.team && v.team !== s.team) continue;
      if (s.members.every((u) => Math.hypot(u.position.x - v.position.x, u.position.z - v.position.z) < P.fieldRadius)) return v;
    }
    return null;
  }

  /** RETREAT: run for the post (the FLN: for the cave). */
  function retreat(s) {
    if (!s || !s.members.length) return;
    s.retreating = true;
    const muster = home(s).muster;
    s.members.forEach((u, k) => {
      u.squadRetreating = true;   // (he runs, hurt or not: no limp — units.js, unitRenderer.js)
      u.holdFire = true;
      u.target = u.attackTarget = null;
      const a = k * 2.39996 + s.id, r = k === 0 ? 0 : 3;
      u.moveOrder(muster.x + Math.cos(a) * r + (s.id % 3 - 1) * 9, muster.z + Math.sin(a) * r + (Math.floor(s.id / 3) % 3 - 1) * 9);
    });
  }
  function endRetreat(s) {
    s.retreating = false;
    for (const u of s.members) { u.holdFire = false; u.squadRetreating = false; }
  }

  /** What one more man costs this squad (0 = can't). */
  function reinforceCost(s) {
    if (!s || !(s.team === "player" || (s.team === "enemy" && aln)) || s.count + pending.filter((p) => p.squad === s).length >= s.size) return 0;
    if (!SQUADS[s.typeKey]?.reinforce) return 0;
    if (!squadInBase(s) && !fieldPointOf(s)) return 0;
    if (s.team === "player" && popRoom() < 1) return 0;   // the pop cap (algEconomy.js POP; the French's)
    // (A doctrine may cut it: the Légion's esprit de corps — algDoctrines.js.)
    return Math.round(SQUADS[s.typeKey].reinforce * (app.algDoctrines?.reinforceMul?.(s.typeKey) ?? 1));
  }
  /** Call one man in (paid now): he comes out of the gate in the first empty slot. */
  function reinforce(s) {
    const cost = reinforceCost(s);
    if (!cost || !home(s).pay(cost)) return false;
    const taken = new Set(pending.filter((p) => p.squad === s).map((p) => p.slot));
    const slot = s.slots.findIndex((u, i) => !u?.alive && !taken.has(i));
    if (slot < 0) return false;
    // At the post if it is there, else at the half-track it stands by.
    pending.push({ squad: s, slot, t: P.reinforceTime, at: squadInBase(s) ? null : fieldPointOf(s) });
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
      const w = up?.weapon ?? SQUADS[s.typeKey]?.kit?.[i] ?? u.type;
      u.weapon = w.weapon ?? null;
      u.range = w.range ?? 0;
      u.damage = w.damage ?? 0;
      u.fireRate = (w.fireRate ?? 1) * v.fireRate;
      u.footMul = w.footMul;   // (an anti-tank weapon's, against men — undefined: his type's)
      // The upgrade's PROP in his hands (the bazooka's tube), once (a replacement gets it too).
      if (up?.prop && u._prop !== up.prop && app.algUnitRenderer?.setWeapon?.(u, up.prop)) u._prop = up.prop;
      u.vetAcc = v.acc;
      u.vetArmor = v.armor;
      u.suppressMul = v.suppress;
    });
  }

  /** What the upgrade `key` costs this squad now (null: it can't have it, or has it). */
  function upgradeCost(s, key) {
    const g = UPGRADES[key];
    if (!g || !s || s.team !== (g.side ?? "player") || !g.squads.includes(s.typeKey) || s.upgrades[key]) return null;
    if (s.team === "enemy" && !aln) return null;   // (the FLN's: only when a human plays it)
    return g.cost;
  }
  /** Why the squad can't buy `key` yet (its `needs`: a standing structure of the side), or "". */
  function upgradeBlocked(s, key) {
    const need = UPGRADES[key]?.needs;
    if (!need) return "";
    return (app.algStructures?.list ?? []).some((x) => x.typeKey === need && x.alive && x.team === s.team) ? "" : need;
  }
  /** Buy the upgrade `key` for the squad (paid now, from its side's purse). */
  function upgrade(s, key) {
    const cost = upgradeCost(s, key);
    if (!cost || upgradeBlocked(s, key) || !home(s).pay(cost)) return false;
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
        const m = home(s).muster;
        if (squadInBase(s) && s.members.every((u) => !u.isMoving || Math.hypot(u.position.x - m.x, u.position.z - m.z) < 14)) endRetreat(s);
      }
      // The wounded heal in the post's zone, out of the fight.
      for (const u of s.members) {
        if (u.hp < u.maxHp && inBase(u.position.x, u.position.z, s) && !u.target && (u.suppression ?? 0) < 0.1) u.hp = Math.min(u.maxHp, u.hp + P.heal * dt);
      }
    }
    // Replacements coming out of the gate.
    for (let i = pending.length - 1; i >= 0; i--) {
      const p = pending[i];
      p.t -= dt;
      // At the post: the gate opens a moment BEFORE he steps out, as for a trained man (algProducer
      // OPEN_AHEAD) — it never opened for a reinforcement (you, 2026-10-11).
      if (!p.at && p.t < GATE_AHEAD) home(p.squad).post.openGate?.();
      if (p.t > 0) continue;
      pending.splice(i, 1);
      const s = p.squad, post = home(s).post;
      // In the field: out of the half-track's tailgate (still there and alive), to his squad.
      const v = p.at?.alive ? p.at : null;
      let sx = post.inside.x, sz = post.inside.z;
      if (v) { const h = v.heading ?? 0, back = (v.radius ?? 4) + 1; sx = v.position.x - Math.sin(h) * back; sz = v.position.z - Math.cos(h) * back; }
      const u = units.spawn(s.typeKey, sx, sz, { snap: !!v, team: s.team, lookRole: p.slot });
      if (!u) continue;
      wrapDamage(u);
      join(s, u, p.slot);
      if (!list.includes(s)) list.push(s);
      const l = s.members.find((m) => m !== u) ?? null;
      const to = l ? l.position : home(s).muster;
      if (v) u.orderTo(to.x + 2, to.z + 2);
      else u.emerge(post.outside.x, post.outside.z, to.x + 2, to.z + 2);
      // Selected squad: the newcomer joins the selection.
      if ((s.members.find((m) => m !== u))?.selected && app.selection) app.selection.select([...new Set([...app.selection.selected, u])]);
    }
  }

  return {
    list, P, create, join, leave, retreat, endRetreat, reinforce, reinforceCost, step, inBase, upgrade, upgradeCost, upgradeBlocked, fieldPointOf,
    /** A new man of a squad being BOUGHT (the producer's batch): `slot` 0 opens a new squad. */
    bought(u, key, slot) {
      // (The French's, always — their AI uses them too; the FLN's only when a human plays it.)
      if (!SQUADS[key] || !(u.team === "player" || isHuman(u.team)) || (SQUADS[key].side ?? "player") !== u.team) return;
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
