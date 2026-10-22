// GRENADES — the infantry's thrown abilities, the Company of Heroes way (your
// go, 2026-09-30; the SMOKE grenade 2026-10-04).
//
//   select infantry → GRENADE (G) or FUMIGÈNE (B) on the command card → a
//   ring the size of the blast / the cloud follows the cursor, green in reach
//   of a man who has one ready, amber beyond (he walks up first) →
//   left-click throws, right-click / Esc cancels.
//
// ONE man throws — the one with that grenade ready nearest the point (CoH: one
// grenade per squad use). He walks into reach if he has to, stops, turns to
// the point and throws: the pack's grenade_throw clip (the rifle slung for it,
// unitRenderer.js), started 0.6 s in so the wind-up is short, the grenade
// leaving his hand where the clip's throwing arm peaks (MEASURED on the clip:
// the arm, forearm and hand all peak at 1.85 s → 1.25 s after he starts). The
// grenade is an arcing shell (projectiles.spawnArc): a FRAG lands as a blast
// (combat.splashAt — damage, and the SUPPRESSION round it, infantryPosture.js
// onSplash); a SMOKE grenade lands as a screening cloud (algSmoke.js: nobody
// sees through it — algCombat's onArcImpact).
//
// His rifle is quiet while he throws (combat skips a man `throwing`), and a
// new order cancels the throw — ONLY a new order (2026-10-14, you: "sometimes the grenade does nothing":
// under fire, his walk into reach was a plain move, combat halted him to shoot the enemy in his rifle's
// reach, and "he stopped" read as "the player moved him" — dropped in silence. His walk is the
// player's order now, and only a NEW goal ends the throw; out of munitions or out of reach, he stops
// and the alert says why). Then that grenade is on cooldown (each kind its
// own). The ALN AI throws frags too (algAI.js), through order().
import { createSelectionRingField } from "../shared-rts/selectionRingField.js";
import { isHuman, isHostile, SIDES, hostileSide } from "../shared-rts/teams.js";
import { t } from "./i18n/i18n.js";

export const GRENADE = {
  range: 24,        // metres he can throw
  blast: 5,         // metres of the blast (splash)
  damage: 70,       // at the centre (a moudjahid has 60)
  cooldown: 30,     // s per man
  cost: { mun: 15 }, // the French pay MUNITIONS per throw (algEconomy.js), charged as it starts
  clipStart: 0.6,   // s into grenade_throw where the throw starts
  release: 1.25,    // s after that the grenade leaves the hand
  done: 2.0,        // s after that he is back to his rifle
  // FROM HIS KNEE (2026-10-19, CoH: a man in cover throws from cover): kneeling (in cover, suppressed) or
  // prone, he throws with the kneeling clip (grenade_throw_alt, 8.2 s — MEASURED on the clip: the hand
  // goes back by 3.1 s, peaks 1.38 m swinging forward at 3.5 s, is down again by 4.5 s).
  kneel: { start: 2.3, release: 1.2, done: 2.2, height: 1.8 },
};

/** The two kinds a man carries: what the button, the ring and the landing are. */
export const THROWS = {
  grenade: {
    key: "grenade", label: t("Grenade"), hotkey: "g", cd: "grenadeCd", range: GRENADE.range, ring: GRENADE.blast,
    cooldown: GRENADE.cooldown, cost: GRENADE.cost,
    hint: t("Un homme lance une grenade ({range} m, souffle {blast} m) : dégâts, et les hommes autour se jettent à terre. G.", { range: GRENADE.range, blast: GRENADE.blast }),
  },
  smoke: {
    key: "smoke", label: t("Fumigène"), hotkey: "b", cd: "smokeCd", range: 28, ring: 11,
    cooldown: 40, cost: { mun: 10 },
    hint: t("Un homme lance un fumigène (28 m) : un nuage de ~11 m pendant ~20 s que PERSONNE ne voit ni ne traverse au tir — franchir un terrain découvert, aveugler une mitrailleuse, couvrir un repli. B."),
  },
};

/**
 * @param {object} o
 * @param {object} o.app
 * @param {object} o.units        the shared units
 * @param {object} o.projectiles  (spawnArc, drawWarnings)
 * @param {object} o.selection    the shared selection (selected)
 * @param {() => void} [o.onChange]  the command card to refresh (a throw started / a cooldown ended)
 * @param {object} [o.purse]       the French purse (a throw costs munitions); none = free
 */
export function createAlgGrenades({ app, units, projectiles, selection, onChange = () => {}, purse = null }) {
  const P = GRENADE;
  const dom = app.renderer.domElement;
  const rings = createSelectionRingField({ app, max: 24, inner: 0.9, opacity: 0.8 });
  // The thrower's REACH: a thin, faint line (2026-10-15, you: "a big blue circle around the whole
  // squad"): the ring's band is a share of its radius, so the 23 m reach in the aim ring's pool was
  // a 2.3 m bright band. CoH draws the range as a thin line; the blast under the cursor stays bold.
  const reachRing = createSelectionRingField({ app, max: 2, inner: 0.988, segments: 96, opacity: 0.45 });
  let targeting = null;   // { sel, at, kind } while the player aims
  const throws = [];      // { u, x, z, t, thrown, walking, kind }
  const thrownCount = {};  // kind → thrown so far (the training's lesson reads it)

  /** Can this unit throw at all (a man on foot whose type carries grenades)? */
  const carries = (u) => u?.alive && !u.isStructure && u.type?.grenade;
  const ready = (u, kind = "grenade") => carries(u) && !(u[THROWS[kind].cd] > 0) && !u.throwing;

  // ── The command card's buttons ───────────────────────────────────────────
  function ability(sel, kind = "grenade") {
    const K = THROWS[kind];
    const men = sel.filter((u) => carries(u) && isHuman(u.team));
    if (!men.length) return null;
    const cds = men.map((u) => (u.throwing ? K.cooldown : Math.max(0, u[K.cd] ?? 0)));
    const cd = Math.min(...cds);
    return { key: K.key, label: K.label, cost: purse ? K.cost : undefined, hint: K.hint, ready: cd <= 0 && (!purse || purse.canAfford(K.cost)), cooldown: Math.ceil(cd) };
  }

  // ── Aiming ───────────────────────────────────────────────────────────────
  function begin(sel = selection.selected, kind = "grenade") {
    const men = (sel ?? []).filter((u) => ready(u, kind) && isHuman(u.team));
    if (!men.length || (purse && !purse.canAfford(THROWS[kind].cost))) return false;
    targeting = { sel: men, at: null, kind };
    dom.style.cursor = "crosshair";
    return true;
  }
  function cancel() { targeting = null; dom.style.cursor = ""; }

  function aimAt(e) {
    const hit = app.pickWorldAtClient?.(e.clientX, e.clientY);
    targeting.at = hit?.point ? { x: hit.point.x, z: hit.point.z } : null;
  }
  const onMove = (e) => { if (targeting) aimAt(e); };
  const onDown = (e) => {
    if (!targeting) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (e.button !== 0) { cancel(); return; }
    aimAt(e);
    const { at, kind } = targeting, men = targeting.sel.filter((u) => ready(u, kind));
    if (!e.shiftKey) cancel();
    if (!at || !men.length) return;
    // The man nearest the point throws.
    const u = men.reduce((b, m) => (dist(m, at) < dist(b, at) ? m : b));
    order(u, at.x, at.z, kind);
  };
  const onKey = (e) => {
    if (e.key === "Escape" && targeting) { cancel(); return; }
    if (e.ctrlKey || e.metaKey || targeting || isTyping(e)) return;
    for (const K of Object.values(THROWS)) {
      if (e.key.toLowerCase() === K.hotkey && begin(selection.selected, K.key)) { e.preventDefault(); return; }
    }
  };
  const onContext = (e) => { if (targeting) { e.preventDefault(); e.stopImmediatePropagation(); cancel(); } };
  // Capture: ahead of the selection's own handlers (a click here is not a select).
  dom.addEventListener("pointerdown", onDown, true);
  dom.addEventListener("contextmenu", onContext, true);
  window.addEventListener("pointermove", onMove);
  window.addEventListener("keydown", onKey);

  const dist = (u, p) => Math.hypot(u.position.x - p.x, u.position.z - p.z);
  /** Where he throws from (a little inside the reach: the ring shows the same). */
  const reach = (K) => K.range * 0.95;
  const say = (u, text) => { if (isHuman(u.team)) app.algBattle?.say?.(text, u.position.x, u.position.z, "bad"); };
  const isTyping = (e) => /input|textarea|select/i.test(e.target?.tagName ?? "");

  /** `u` throws a `kind` grenade at (x, z) — walking into reach first if he must. */
  function order(u, x, z, kind = "grenade") {
    for (let i = throws.length - 1; i >= 0; i--) if (throws[i].u === u) throws.splice(i, 1);
    const job = { u, x, z, t: -1, thrown: false, walking: false, kind, tries: 0 };
    throws.push(job);
    if (dist(u, job) > reach(THROWS[kind])) walk(job);
    onChange();
  }
  /** Into reach: the player's own move (combat lets him walk on — combat.js playerMove). */
  function walk(job) {
    job.u.moveOrder(job.x, job.z);
    job.u.playerMove = true;
    job.walking = true;
    job.goal = job.u.goalPoint ? { x: job.u.goalPoint.x, z: job.u.goalPoint.z } : null;
  }

  /** A new order given to him since (his goal is no longer the throw's walk): the throw is off. */
  const reordered = (job) => { const g = job.u.goalPoint; return !!g && (!job.goal || Math.hypot(g.x - job.goal.x, g.z - job.goal.z) > 0.5); };
  function end(job, i) {
    job.u.throwing = null;
    throws.splice(i, 1);
    onChange();
  }

  // ── The throw, on the fixed sim clock ────────────────────────────────────
  function step(dt) {
    for (const u of units.list) {
      if (u.grenadeCd > 0) { u.grenadeCd -= dt; if (u.grenadeCd <= 0) onChange(); }
      if (u.smokeCd > 0) { u.smokeCd -= dt; if (u.smokeCd <= 0) onChange(); }
    }
    for (let i = throws.length - 1; i >= 0; i--) {
      const job = throws[i], u = job.u, K = THROWS[job.kind];
      if (!u.alive) { end(job, i); continue; }
      if (job.t < 0) {
        // Walking into reach: a NEW order cancels; a stop does not (combat, a wall, the squad).
        if (job.walking && reordered(job)) { end(job, i); continue; }
        if (dist(u, job) > reach(K)) {
          if (!u.isMoving) {
            // Stopped short and still out of reach: on again, twice; then he cannot get there.
            if (++job.tries <= 2) walk(job);
            else { say(u, t("<b>Lancer impossible</b> : le point est hors d'atteinte.")); end(job, i); }
          } else if (!u.playerMove) u.playerMove = true;   // (combat clears it on a stop; it is his order)
          continue;
        }
        // The French pay as the throw starts (the munitions ran out meanwhile: no throw — he stops,
        // he does not walk on into the enemy).
        if (purse && u.team === "player" && !purse.spend(K.cost)) {
          u.haltMovement?.();
          say(u, t("<b>Pas assez de munitions</b> pour lancer ({n} M).", { n: K.cost.mun ?? 0 }));
          end(job, i);
          continue;
        }
        // Kneeling (in cover, suppressed) or down: he throws from his knee.
        job.kneel = u.posture === "kneel" || u.posture === "prone";
        u.stop();
        u.faceToward(job.x, job.z);
        // ...and HELD that way (2026-10-22, you: "I clicked behind them and they didn't turn at all"): a move gives a
        // man a held facing (selection.js faceAngle — the way he walked, or the drag's), and units.js turned him back to
        // it the next tick: he threw over his shoulder. The throw's direction is his facing now.
        u.faceAngle = Math.atan2(job.x - u.position.x, job.z - u.position.z);
        u.throwing = job.kneel ? { start: P.kneel.start, kneel: true } : { start: P.clipStart };
        u[K.cd] = K.cooldown;
        job.t = 0;
        onChange();
        continue;
      }
      // A NEW move order mid-throw: he drops it (nothing thrown yet) or goes after. (A nudge does not.)
      if (u.isMoving && u.goalPoint && Math.hypot(u.goalPoint.x - u.position.x, u.goalPoint.z - u.position.z) > 1.5) { end(job, i); continue; }
      job.t += dt;
      if (!job.thrown && job.t >= (job.kneel ? P.kneel.release : P.release)) {
        job.thrown = true;
        thrownCount[job.kind] = (thrownCount[job.kind] ?? 0) + 1;
        const h = app.getWorldHeight?.(job.x, job.z) ?? 0;
        const from = u.position.clone(); from.y += job.kneel ? P.kneel.height : 1.9;
        const to = from.clone().set(job.x, h + 0.2, job.z);
        const flight = 0.7 + from.distanceTo(to) / 30;
        // A smoke canister: no damage, no warning ring (splash 0) — it lands as a cloud.
        if (job.kind === "smoke") projectiles.spawnArc(from, to, { damage: 0, splash: 0, owner: u, flight, kind: "smoke" });
        else projectiles.spawnArc(from, to, { damage: P.damage, splash: P.blast, owner: u, flight, kind: "grenade" });
      }
      if (job.t >= (job.kneel ? P.kneel.done : P.done)) end(job, i);
    }
  }

  // ── Every frame: the aim ring, the landing warnings ──────────────────────
  function frame() {
    rings.begin();
    reachRing.begin();
    if (targeting?.at) {
      // The man who would throw (the nearest ready one) and his reach: green
      // in it, amber beyond — he walks up first.
      const K = THROWS[targeting.kind];
      const men = targeting.sel.filter((u) => ready(u, targeting.kind));
      if (men.length) {
        const u = men.reduce((b, m) => (dist(m, targeting.at) < dist(b, targeting.at) ? m : b));
        rings.add(targeting.at.x, targeting.at.z, K.ring, dist(u, targeting.at) <= reach(K) ? 0x58e070 : 0xffb020);
        reachRing.add(u.position.x, u.position.z, reach(K), 0xcfe4ff);
      }
    }
    projectiles.drawWarnings(rings);   // grenades and mortar bombs in the air
    rings.commit();
    reachRing.commit();
    reachRing.mesh.visible = !!targeting?.at;   // (an empty instanced draw still costs a draw per pass)
  }

  return {
    params: P, ability, begin, cancel, order, step, frame,
    /** Thrown so far, by kind ("grenade", "smoke"). */
    get thrown() { return thrownCount; },
    get targeting() { return !!targeting; },
    dispose() {
      dom.removeEventListener("pointerdown", onDown, true);
      dom.removeEventListener("contextmenu", onContext, true);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("keydown", onKey);
    },
  };
}
