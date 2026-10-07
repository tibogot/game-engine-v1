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
// new order cancels the throw. Then that grenade is on cooldown (each kind its
// own). The ALN AI throws frags too (algAI.js), through order().
import { createSelectionRingField } from "../shared-rts/selectionRingField.js";
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
  let targeting = null;   // { sel, at, kind } while the player aims
  const throws = [];      // { u, x, z, t, thrown, walking, kind }

  /** Can this unit throw at all (a man on foot whose type carries grenades)? */
  const carries = (u) => u?.alive && !u.isStructure && u.type?.grenade;
  const ready = (u, kind = "grenade") => carries(u) && !(u[THROWS[kind].cd] > 0) && !u.throwing;

  // ── The command card's buttons ───────────────────────────────────────────
  function ability(sel, kind = "grenade") {
    const K = THROWS[kind];
    const men = sel.filter((u) => carries(u) && u.team === "player");
    if (!men.length) return null;
    const cds = men.map((u) => (u.throwing ? K.cooldown : Math.max(0, u[K.cd] ?? 0)));
    const cd = Math.min(...cds);
    return { key: K.key, label: K.label, cost: purse ? K.cost : undefined, hint: K.hint, ready: cd <= 0 && (!purse || purse.canAfford(K.cost)), cooldown: Math.ceil(cd) };
  }

  // ── Aiming ───────────────────────────────────────────────────────────────
  function begin(sel = selection.selected, kind = "grenade") {
    const men = (sel ?? []).filter((u) => ready(u, kind) && u.team === "player");
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
  const isTyping = (e) => /input|textarea|select/i.test(e.target?.tagName ?? "");

  /** `u` throws a `kind` grenade at (x, z) — walking into reach first if he must. */
  function order(u, x, z, kind = "grenade") {
    for (let i = throws.length - 1; i >= 0; i--) if (throws[i].u === u) throws.splice(i, 1);
    const job = { u, x, z, t: -1, thrown: false, walking: false, kind };
    throws.push(job);
    if (dist(u, job) > THROWS[kind].range * 0.95) { u.moveOrder(x, z); job.walking = true; }
    onChange();
  }

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
        // Walking into reach; the player moving him elsewhere cancels.
        if (job.walking && !u.isMoving) { end(job, i); continue; }
        if (dist(u, job) > K.range * 0.95) continue;
        // The French pay as the throw starts (the munitions ran out meanwhile: no throw).
        if (purse && u.team === "player" && !purse.spend(K.cost)) { end(job, i); continue; }
        u.stop();
        u.faceToward(job.x, job.z);
        u.throwing = { start: P.clipStart };
        u[K.cd] = K.cooldown;
        job.t = 0;
        onChange();
        continue;
      }
      // A move order mid-throw: he drops it (nothing thrown yet) or goes after.
      if (u.isMoving) { end(job, i); continue; }
      job.t += dt;
      if (!job.thrown && job.t >= P.release) {
        job.thrown = true;
        const h = app.getWorldHeight?.(job.x, job.z) ?? 0;
        const from = u.position.clone(); from.y += 1.9;
        const to = from.clone().set(job.x, h + 0.2, job.z);
        const flight = 0.7 + from.distanceTo(to) / 30;
        // A smoke canister: no damage, no warning ring (splash 0) — it lands as a cloud.
        if (job.kind === "smoke") projectiles.spawnArc(from, to, { damage: 0, splash: 0, owner: u, flight, kind: "smoke" });
        else projectiles.spawnArc(from, to, { damage: P.damage, splash: P.blast, owner: u, flight, kind: "grenade" });
      }
      if (job.t >= P.done) end(job, i);
    }
  }

  // ── Every frame: the aim ring, the landing warnings ──────────────────────
  function frame() {
    rings.begin();
    if (targeting?.at) {
      // The man who would throw (the nearest ready one) and his reach: green
      // in it, amber beyond — he walks up first.
      const K = THROWS[targeting.kind];
      const men = targeting.sel.filter((u) => ready(u, targeting.kind));
      if (men.length) {
        const u = men.reduce((b, m) => (dist(m, targeting.at) < dist(b, targeting.at) ? m : b));
        rings.add(targeting.at.x, targeting.at.z, K.ring, dist(u, targeting.at) <= K.range ? 0x58e070 : 0xffb020);
        rings.add(u.position.x, u.position.z, K.range, 0x6ab0ff);
      }
    }
    projectiles.drawWarnings(rings);   // grenades and mortar bombs in the air
    rings.commit();
  }

  return {
    params: P, ability, begin, cancel, order, step, frame,
    get targeting() { return !!targeting; },
    dispose() {
      dom.removeEventListener("pointerdown", onDown, true);
      dom.removeEventListener("contextmenu", onContext, true);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("keydown", onKey);
    },
  };
}
