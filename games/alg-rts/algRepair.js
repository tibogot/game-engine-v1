// SAPPERS REPAIR (2026-10-06, a player's friend: "engineers should be able to repair vehicles";
// Company of Heroes' engineers fix vehicles and buildings). Two ways to give the order:
//   RIGHT-CLICK a damaged vehicle or building of yours with only sapeurs selected;
//   RÉPARER (the wrench, J) on their card, then left-click it (right-click / Esc: cancel).
// They walk up round it and work (the build clip, `working`): REPAIR_RATE hp a second a man,
// free, paused while they are under fire. Done when it is whole, dead, or they get another
// order (algUnits.js onOrder → cancel). A vehicle that drives off: they follow it.
import * as THREE from "three";

const P = {
  rate: 3,            // hp a second, per sapper at work (three: a half-track in ~27 s)
  reach: 3.2,         // m past the target's radius a sapper works from
  underFire: 0.15,    // suppression that stops the work
  follow: 4,          // m the target may move before they walk after it
  pickPx: 14,         // least screen radius a target is picked within
};

/**
 * @param {object} app
 * @param {object} o
 * @param {object} o.units        the shared units
 * @param {object} o.structures   algStructures
 * @param {(u) => boolean} o.isSapper
 */
export function createAlgRepair(app, { units, structures, isSapper }) {
  const dom = app.renderer.domElement;
  const jobs = new Map();   // sapper → { tgt, at: {x, z} }
  const v = new THREE.Vector3(), e = new THREE.Vector3();

  const damaged = (t) => t?.alive && t.team === "player" && (t.hp ?? 0) < (t.maxHp ?? 0) - 0.5;
  const repairable = (t) => damaged(t) && (t.isStructure ? !t.site : !t.type?.foot);

  /** A damaged vehicle or building of yours under the cursor (screen outline), or null. */
  function pickAt(clientX, clientY) {
    const rect = dom.getBoundingClientRect(), cam = app.camera;
    let best = null, bd = Infinity;
    const test = (t, r) => {
      v.set(t.position.x, t.position.y + Math.min(2, r * 0.4), t.position.z).project(cam);
      if (v.z > 1) return;
      e.set(t.position.x + r, t.position.y + Math.min(2, r * 0.4), t.position.z).project(cam);
      const sx = rect.left + (v.x * 0.5 + 0.5) * rect.width, sy = rect.top + (-v.y * 0.5 + 0.5) * rect.height;
      const rpx = Math.max(P.pickPx, Math.hypot((e.x - v.x) * 0.5 * rect.width, (e.y - v.y) * 0.5 * rect.height));
      const d = Math.hypot(sx - clientX, sy - clientY);
      if (d < rpx * 1.1 && d < bd) { bd = d; best = t; }
    };
    for (const u of units.list) if (repairable(u)) test(u, u.radius ?? u.type?.radius ?? 3);
    for (const s of structures.list ?? []) if (repairable(s)) test(s, s.radius ?? 6);
    return best;
  }

  const workSpot = (t, i, n) => {
    const r = (t.radius ?? t.type?.radius ?? 3) + P.reach * 0.6;
    const a = Math.atan2(app.camera.position.x - t.position.x, app.camera.position.z - t.position.z) + (i - (n - 1) / 2) * 0.7;
    const x = t.position.x + Math.sin(a) * r, z = t.position.z + Math.cos(a) * r;
    return app.navGrid?.nearestOpenWorld?.(x, z, true) ?? { x, z };
  };

  /** Send these sapeurs to repair `tgt`. True if any went. */
  function order(sel, tgt) {
    const men = sel.filter((u) => u?.alive && u.team === "player" && isSapper(u));
    if (!men.length || !repairable(tgt)) return false;
    men.forEach((u, i) => {
      const p = workSpot(tgt, i, men.length);
      u.playerMove = false;
      u.moveOrder(p.x, p.z);
      jobs.set(u, { tgt, at: { x: tgt.position.x, z: tgt.position.z }, i, n: men.length, retried: false });
    });
    app.algOrderMarks?.order?.(tgt.position.x, tgt.position.y, tgt.position.z, men, "move");
    app.algVoices?.order?.("move", men);
    return true;
  }

  function end(u) {
    jobs.delete(u);
    if (u.repairing) { u.repairing = null; if (u.working?.repair) u.working = null; }
  }
  /** Another order for these men: their repair ends. */
  function cancel(list) { for (const u of list) if (jobs.has(u)) end(u); }

  /** Fixed clock. */
  function step(dt) {
    for (const [u, j] of jobs) {
      const t = j.tgt;
      if (!u.alive || !repairable(t)) { end(u); continue; }
      const reach = (t.radius ?? t.type?.radius ?? 3) + P.reach;
      const d = Math.hypot(u.position.x - t.position.x, u.position.z - t.position.z);
      // The target drove off: after it.
      if (Math.hypot(t.position.x - j.at.x, t.position.z - j.at.z) > P.follow) {
        j.at = { x: t.position.x, z: t.position.z };
        const p = workSpot(t, j.i, j.n);
        u.moveOrder(p.x, p.z);
        continue;
      }
      if (u.isMoving) continue;
      if (d > reach) {
        // Stopped short (a wall, a crowd): once more, then give up.
        if (j.retried) { end(u); continue; }
        j.retried = true;
        const p = workSpot(t, j.i + 1, j.n + 2);
        u.moveOrder(p.x, p.z);
        continue;
      }
      // At work: facing it, the build clip (algBuild's `working`), unless under fire.
      if ((u.suppression ?? 0) > P.underFire) { if (u.working?.repair) u.working = null; continue; }
      if (!u.working?.repair) { u.working = { x: t.position.x, z: t.position.z, repair: t }; u.faceToward?.(t.position.x, t.position.z); }
      u.repairing = t;
      t.hp = Math.min(t.maxHp, t.hp + P.rate * dt);
      if (t.hp >= t.maxHp - 0.5) { t.hp = t.maxHp; end(u); }
    }
  }

  // ── The orders: right-click on a damaged one (sapeurs only), or the button then a click ──
  const selection = () => (app.selection?.selected ?? []).filter((u) => !u.isStructure);
  const onlySappers = (sel) => sel.length > 0 && sel.every((u) => u.team === "player" && isSapper(u));
  function onContext(ev) {
    if (targeting) { ev.preventDefault(); ev.stopImmediatePropagation(); stopTargeting(); return; }
    const sel = selection();
    if (!onlySappers(sel)) return;
    const t = pickAt(ev.clientX, ev.clientY);
    if (!t) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();   // not a move order
    order(sel, t);
  }
  let targeting = null;   // the sapeurs, while the button waits for a click
  function begin(sel) {
    const men = sel.filter((u) => u.team === "player" && isSapper(u));
    if (!men.length) return;
    targeting = men;
    dom.style.cursor = "crosshair";
  }
  function stopTargeting() { targeting = null; dom.style.cursor = ""; }
  function onDown(ev) {
    if (!targeting || ev.button !== 0) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    const t = pickAt(ev.clientX, ev.clientY);
    if (t) order(targeting, t);
    stopTargeting();
  }
  const onKey = (ev) => { if (targeting && ev.key === "Escape") stopTargeting(); };
  dom.addEventListener("contextmenu", onContext, true);   // capture: before the move order
  dom.addEventListener("pointerdown", onDown, true);      // capture: before the selection
  window.addEventListener("keydown", onKey);

  return {
    params: P, step, order, cancel, begin, pickAt,
    /** The command card's button for this selection (null: no sapeurs). */
    ability(sel) {
      if (!sel.some((u) => u.team === "player" && isSapper(u))) return null;
      const any = units.list.some(repairable) || (structures.list ?? []).some(repairable);
      return { key: "repair", label: "Réparer", hint: "Réparer un de vos véhicules ou bâtiments endommagés : cliquez dessus (ou clic droit avec des sapeurs sélectionnés). Gratuit ; s'arrête sous le feu.", ready: any };
    },
    get jobs() { return jobs; },
    dispose() {
      dom.removeEventListener("contextmenu", onContext, true);
      dom.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    },
  };
}
