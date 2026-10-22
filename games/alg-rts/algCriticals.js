// VEHICLE CRITICAL HITS (2026-10-22, the CoH 3 comparison's biggest gap — you: "lets go"). A heavy hit on a
// vehicle does more than take hit points: it can break a part of it, CoH's way.
//
//   ENGINE     damaged: half speed, black smoke from it.
//   IMMOBILE   tracks or wheels gone: it does not move (it still turns and fires — a pillbox now).
//   GUN        its weapon knocked out: it does not fire.
//   CREW       stunned: for `stun` s it neither moves nor fires (combat's knockedT, as a man knocked down).
//
// WHAT CAUSES THEM: a SHELL or a ROCKET (the bazooka's, the recoilless's, a cannon's), a MINE, a BLAST (a mortar bomb,
// a grenade, a bomb). Bullets never. The chance grows with the hit's share of the vehicle's hit points, and with
// where it lands (algArmour's face: the side and the rear more than the front); the part by what and where — a
// mine takes the running gear, a rocket in the side the tracks, in the rear the engine, in the front the gun or
// the crew. One part once (a second hit on a broken engine breaks something else, or nothing).
// REPAIRED: sappers at work on it (algRepair) mend them all when it is whole again.
// SHOWN: the alert to its side; the unit card's chips (ui/unitBar.js); the engine's smoke.
import { faceHit } from "./algArmour.js";
import { isHuman } from "../shared-rts/teams.js";
import { SMOKE_TINTS } from "../shared-rts/litSmoke.js";
import { t } from "./i18n/i18n.js";

export const CRITS = {
  // the chance of a crit: × (the hit's damage / the vehicle's max hp), by face [front, side, rear]; a cap
  // (2.2 / 1.2 at first: 13 crits in 20 single bazooka hits on a half-track's side — CoH's is about one in four or five.
  // Now a bazooka in the side ~25 %, the rear ~35 %, the front ~12 %; a mortar bomb ~10 %; a mine still most of the time.)
  chance: { shell: 0.9, mine: 3, blast: 0.55 }, face: [0.45, 1, 1.4], max: 0.75,
  // which part, weights: by what hit and (a shell) where
  weights: {
    mine: { immobile: 5, engine: 1, crew: 1 },
    blast: { crew: 3, immobile: 1, engine: 1 },
    shell: [ { gun: 3, crew: 2, engine: 0.5 }, { immobile: 3, engine: 1, crew: 1, gun: 1 }, { engine: 4, immobile: 1, crew: 1 } ],
  },
  engineMul: 0.5,     // × its speed with the engine hit
  stun: 7,            // s the crew is stunned
  smokeEvery: 0.45,   // s between the damaged engine's puffs
};
const SOFT = new Set(["willys", "gmc"]);   // (no gun to knock out on a GMC; a jeep's MG can be)

/** What the part's loss is called, the alert's and the card's (FR, via t()). */
export const CRIT_LABEL = {
  engine: () => t("MOTEUR ENDOMMAGÉ"),
  immobile: () => t("IMMOBILISÉ"),
  gun: () => t("ARME DÉTRUITE"),
  crew: () => t("ÉQUIPAGE SONNÉ"),
};

export function createAlgCriticals(app) {
  const P = CRITS;
  const hit = new Set();   // vehicles with a crit (the per-tick work)

  function pick(weights, u) {
    const opts = Object.entries(weights).filter(([k]) => !u.crits?.[k] && !(k === "gun" && !u._gunRange && !u.range) && !(k === "immobile" && u.type?.isAir));
    const sum = opts.reduce((s, [, w]) => s + w, 0);
    let r = Math.random() * sum;
    for (const [k, w] of opts) if ((r -= w) <= 0) return k;
    return null;
  }

  function apply(u, part) {
    u.crits ??= {};
    u.crits[part] = true;
    if (part === "engine") u.moveMul = Math.min(u.moveMul ?? 1, P.engineMul);
    if (part === "immobile") { u.moveMul = 0; u.haltMovement?.(); }
    if (part === "gun") { u._gunRange = u.range; u.range = 0; u.target = null; }
    if (part === "crew") u.knockedT = Math.max(u.knockedT ?? 0, P.stun);
    hit.add(u);
    if (isHuman(u.team)) app.algBattle?.say?.(t("<b>{v}</b> : {part}.", { v: u.type?.name ?? u.typeKey, part: CRIT_LABEL[part]().toLowerCase() }), u.position.x, u.position.z, "bad");
    else app.algBattle?.say?.(t("Coup critique sur un véhicule ennemi : {part}.", { part: CRIT_LABEL[part]().toLowerCase() }), u.position.x, u.position.z, "good");
  }

  /** combat's onHit: (target, amount, at, owner, { shell, bullet }). */
  function onHit(u, amount, at, owner, how = {}) {
    if (!u?.alive || u.isStructure || u.type?.foot || u.isAir || how.bullet || !(amount > 0)) return;
    const blast = u.lastHit?.kind === "blast";
    const src = how.shell ? "shell" : blast && u.lastHit.src === "mine" ? "mine" : blast ? "blast" : null;
    if (!src) return;
    const face = src === "shell" && owner?.position ? faceHit(u, owner.position.x, owner.position.z) : 1;
    const p = Math.min(P.max, P.chance[src] * (amount / (u.maxHp || 100)) * P.face[face]);
    if (Math.random() >= p) return;
    const part = pick(src === "shell" ? P.weights.shell[face] : P.weights[src], u);
    if (part === "gun" && SOFT.has(u.typeKey) && u.typeKey === "gmc") return;
    if (part) apply(u, part);
  }

  /** Mended (algRepair, the vehicle whole again): every part back. */
  function repair(u) {
    if (!u.crits) return;
    if (u.crits.engine || u.crits.immobile) u.moveMul = 1;
    if (u.crits.gun && u._gunRange != null) { u.range = u._gunRange; u._gunRange = null; }
    u.crits = null;
    hit.delete(u);
  }

  let smokeT = 0;
  /** The sim's tick: the broken parts held (another system may write moveMul), the engine's smoke. */
  function step(dt) {
    smokeT -= dt;
    const puff = smokeT <= 0;
    if (puff) smokeT = P.smokeEvery;
    for (const u of hit) {
      if (!u.alive) { hit.delete(u); continue; }
      const c = u.crits;
      if (!c) { hit.delete(u); continue; }
      if (c.immobile) u.moveMul = 0;
      else if (c.engine) u.moveMul = Math.min(u.moveMul ?? 1, P.engineMul);
      if (c.gun) u.range = 0;
      if (puff && c.engine) app.algCombat?.fx?.lit?.puff?.(u.position.x, u.position.y + 1.6, u.position.z,
        { size: 2.2, duration: 3.2, tint: SMOKE_TINTS.soot, opacity: 0.55, grow: 1.8, vel: [0, 1.4, 0] });
    }
  }

  return { params: P, onHit, repair, step, apply, get list() { return [...hit]; } };
}
