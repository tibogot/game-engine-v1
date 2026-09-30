// GRENADES — the infantry's thrown ability, the Company of Heroes way (your
// go, 2026-09-30).
//
//   select infantry → GRENADE on the command card (or G) → a ring the size of
//   the blast follows the cursor, green in reach of a man who has one ready,
//   amber beyond (he walks up first) → left-click throws, right-click / Esc
//   cancels.
//
// ONE man throws — the one with a grenade ready nearest the point (CoH: one
// grenade per squad use). He walks into reach if he has to, stops, turns to
// the point and throws: the pack's grenade_throw clip (the rifle slung for it,
// unitRenderer.js), started 0.6 s in so the wind-up is short, the grenade
// leaving his hand where the clip's throwing arm peaks (MEASURED on the clip:
// the arm, forearm and hand all peak at 1.85 s → 1.25 s after he starts). The
// grenade is an arcing shell (projectiles.spawnArc), and where it lands
// combat.splashAt does the blast — the damage, and the SUPPRESSION round it
// (infantryPosture.js onSplash): men near it go down.
//
// His rifle is quiet while he throws (combat skips a man `throwing`), and a
// new order cancels the throw. Then his grenade is on cooldown. The ALN AI
// throws too (algAI.js), through order().
import { createSelectionRingField } from "../shared-rts/selectionRingField.js";

export const GRENADE = {
  range: 24,        // metres he can throw
  blast: 5,         // metres of the blast (splash)
  damage: 70,       // at the centre (a moudjahid has 60)
  cooldown: 30,     // s per man
  clipStart: 0.6,   // s into grenade_throw where the throw starts
  release: 1.25,    // s after that the grenade leaves the hand
  done: 2.0,        // s after that he is back to his rifle
};

/**
 * @param {object} o
 * @param {object} o.app
 * @param {object} o.units        the shared units
 * @param {object} o.projectiles  (spawnArc, drawWarnings)
 * @param {object} o.selection    the shared selection (selected)
 * @param {() => void} [o.onChange]  the command card to refresh (a throw started / a cooldown ended)
 */
export function createAlgGrenades({ app, units, projectiles, selection, onChange = () => {} }) {
  const P = GRENADE;
  const dom = app.renderer.domElement;
  const rings = createSelectionRingField({ app, max: 24, inner: 0.9, opacity: 0.8 });
  let targeting = null;   // { sel, at } while the player aims
  const throws = [];      // { u, x, z, t, thrown, walking }

  /** Can this unit throw at all (a man on foot whose type carries grenades)? */
  const carries = (u) => u?.alive && !u.isStructure && u.type?.grenade;
  const ready = (u) => carries(u) && !(u.grenadeCd > 0) && !u.throwing;

  // ── The command card's button ────────────────────────────────────────────
  function ability(sel) {
    const men = sel.filter((u) => carries(u) && u.team === "player");
    if (!men.length) return null;
    const cds = men.map((u) => (u.throwing ? P.cooldown : Math.max(0, u.grenadeCd ?? 0)));
    const cd = Math.min(...cds);
    return { key: "grenade", label: "Grenade", hint: `A man throws a grenade (${P.range} m, blast ${P.blast} m): damage, and men near it go down. G.`, ready: cd <= 0, cooldown: Math.ceil(cd) };
  }

  // ── Aiming ───────────────────────────────────────────────────────────────
  function begin(sel = selection.selected) {
    const men = (sel ?? []).filter((u) => ready(u) && u.team === "player");
    if (!men.length) return false;
    targeting = { sel: men, at: null };
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
    const at = targeting.at, men = targeting.sel.filter(ready);
    if (!e.shiftKey) cancel();
    if (!at || !men.length) return;
    // The man nearest the point throws.
    const u = men.reduce((b, m) => (dist(m, at) < dist(b, at) ? m : b));
    order(u, at.x, at.z);
  };
  const onKey = (e) => {
    if (e.key === "Escape" && targeting) { cancel(); return; }
    if ((e.key === "g" || e.key === "G") && !e.ctrlKey && !e.metaKey && !targeting && !isTyping(e)) {
      if (begin()) e.preventDefault();
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

  /** `u` throws at (x, z) — walking into reach first if he must. */
  function order(u, x, z) {
    for (let i = throws.length - 1; i >= 0; i--) if (throws[i].u === u) throws.splice(i, 1);
    const job = { u, x, z, t: -1, thrown: false, walking: false };
    throws.push(job);
    if (dist(u, job) > P.range * 0.95) { u.moveOrder(x, z); job.walking = true; }
    onChange();
  }

  function end(job, i) {
    job.u.throwing = null;
    throws.splice(i, 1);
    onChange();
  }

  // ── The throw, on the fixed sim clock ────────────────────────────────────
  function step(dt) {
    for (const u of units.list) if (u.grenadeCd > 0) { u.grenadeCd -= dt; if (u.grenadeCd <= 0) onChange(); }
    for (let i = throws.length - 1; i >= 0; i--) {
      const job = throws[i], u = job.u;
      if (!u.alive) { end(job, i); continue; }
      if (job.t < 0) {
        // Walking into reach; the player moving him elsewhere cancels.
        if (job.walking && !u.isMoving) { end(job, i); continue; }
        if (dist(u, job) > P.range * 0.95) continue;
        u.stop();
        u.faceToward(job.x, job.z);
        u.throwing = { start: P.clipStart };
        u.grenadeCd = P.cooldown;
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
        projectiles.spawnArc(from, to, { damage: P.damage, splash: P.blast, owner: u, flight: 0.7 + from.distanceTo(to) / 30, kind: "grenade" });
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
      const men = targeting.sel.filter(ready);
      if (men.length) {
        const u = men.reduce((b, m) => (dist(m, targeting.at) < dist(b, targeting.at) ? m : b));
        rings.add(targeting.at.x, targeting.at.z, P.blast, dist(u, targeting.at) <= P.range ? 0x58e070 : 0xffb020);
        rings.add(u.position.x, u.position.z, P.range, 0x6ab0ff);
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
