// SAPPERS REPAIR (2026-10-06, a player's friend: "engineers should be able to repair vehicles";
// Company of Heroes' engineers fix vehicles and buildings). Two ways to give the order:
//   RIGHT-CLICK a damaged vehicle or building of yours with only sapeurs selected;
//   RÉPARER (the wrench, J) on their card, then left-click it (right-click / Esc: cancel).
// They walk up round it and work (the build clip, `working`): REPAIR_RATE hp a second a man,
// free, paused while they are under fire. Done when it is whole, dead, or they get another
// order (algUnits.js onOrder → cancel). A vehicle that drives off: they follow it.
// THE WORK SHOWS (you, 2026-10-06: "sparkles or something cool"): on a vehicle, WELDING —
// bursts of sparks where each man works, now and then a white flash, and at night a flickering
// blue-white light on it (app.localLights); the sappers' work sound (algSounds "build").
import * as THREE from "three";

const SPARK = [1.0, 0.72];   // a spark's colour (tracerField: r, g; the core is white-hot)

const P = {
  rate: 3,            // hp a second, per sapper at work (three: a half-track in ~27 s)
  reach: 3.2,         // m past the target's radius a sapper works from
  underFire: 0.15,    // suppression that stops the work
  follow: 4,          // m the target may move before they walk after it
  pickPx: 14,         // least screen radius a target is picked within
  sparkEvery: [0.18, 0.45],   // s between a man's bursts of sparks
  streaks: [12, 16],  // sparks in a burst
  flash: 0.3,         // share of bursts with a white flash
  lightCd: 30,        // the welding light at full night (a gate lamp is 22)
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

  /**
   * AGAINST THE HULL (you, 2026-10-06: "the welder looks too far from the vehicle" — he stood by
   * its 4.3 m collision circle, 5 m off a 1.2 m-wide hull): the side nearer the man, ~0.5 m off
   * the plating, the men spread along its length. `contact`: the point of the hull he works on.
   */
  function hullSpot(t, u, i, n) {
    const S = app.algWrecks?.sizeOf?.(t.typeKey);
    if (!S || t.isStructure) return null;
    const h = t.heading ?? 0, c = Math.cos(h), s = Math.sin(h);
    const dx = u.position.x - t.position.x, dz = u.position.z - t.position.z;
    const side = (dx * c - dz * s) >= 0 ? 1 : -1;     // the man's side of the hull (local x)
    const lz = S.cz + Math.max(-S.hz * 0.7, Math.min(S.hz * 0.7, (i - (n - 1) / 2) * 1.5));
    const at = (lx) => ({ x: t.position.x + lx * c + lz * s, z: t.position.z - lx * s + lz * c });
    return { ...at(side * (S.hx + 0.5)), contact: at(side * (S.hx + 0.05)) };
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
    u.noPush = false;
    if (u.repairing) { u.repairing = null; if (u.working?.repair) u.working = null; }
  }
  /** Another order for these men: their repair ends. */
  function cancel(list) { for (const u of list) if (jobs.has(u)) end(u); }

  /** A burst of welding sparks where `u` works on `t` (the side facing him, waist to chest high). */
  function weld(u, t, dt, contact = null) {
    u._spark = (u._spark ?? Math.random() * P.sparkEvery[1]) - dt;
    if (u._spark > 0) return;
    u._spark = P.sparkEvery[0] + Math.random() * (P.sparkEvery[1] - P.sparkEvery[0]);
    // At the plating he works on (contact), else half its radius out toward him.
    const r = (t.radius ?? t.type?.radius ?? 3) * 0.5;
    let dx = u.position.x - t.position.x, dz = u.position.z - t.position.z, d = Math.hypot(dx, dz) || 1;
    const cx = contact ? contact.x : t.position.x + (dx / d) * r, cz = contact ? contact.z : t.position.z + (dz / d) * r;
    if (contact) { dx = u.position.x - cx; dz = u.position.z - cz; d = Math.hypot(dx, dz) || 1; }
    const x = cx + (Math.random() - 0.5) * 0.3, z = cz + (Math.random() - 0.5) * 0.3;
    const y = app.getWorldHeight(x, z) + 0.6 + Math.random() * 0.8;
    // STREAKS, not specks (you, 2026-10-06: real welding sparks read as lines): each a short
    // fast flight on the tracers' field (shared tracerField.js — one draw with the bullets),
    // fanned out from the torch toward the man and down, gone in a few tenths of a second.
    const pr = app.algCombat?.projectiles, tr = pr?.tracers;
    if (tr) {
      const t0 = pr.clock, base = Math.atan2(dz, dx), n = P.streaks[0] + Math.floor(Math.random() * (P.streaks[1] - P.streaks[0] + 1));
      for (let k = 0; k < n; k++) {
        const a = base + (Math.random() - 0.5) * 2.6, sp = 3 + Math.random() * 5, life = 0.1 + Math.random() * 0.25;
        const vy = -2 + Math.random() * 3.5;
        tr.fire(x, y, z, x + Math.cos(a) * sp * life, Math.max(app.getWorldHeight(x, z) + 0.05, y + vy * life), z + Math.sin(a) * sp * life, t0, t0 + life,
          { width: 0.03 + Math.random() * 0.02, length: 0.3 + Math.random() * 0.4, colour: SPARK });
      }
    } else app.algCombat?.fx?.bulletHit?.(x, y, z, { metal: true });
    if (Math.random() < P.flash) app.algCombat?.fx?.impact?.(x, y, z);
  }
  // The welding light on each vehicle being repaired (only worth anything at night).
  const working = new Set(), lights = new Map(), _lp = new THREE.Vector3();
  function stepLights() {
    const night = app.sky?.night ?? 0;
    for (const [t, h] of lights) if (!working.has(t)) { h.remove(); lights.delete(t); }
    for (const t of working) {
      if (t.isStructure) continue;
      let h = lights.get(t);
      if (!h) {
        h = app.localLights?.add({ position: { x: t.position.x, y: t.position.y + 1.2, z: t.position.z }, color: 0xcfe2ff, intensity: 0, range: 9, flicker: 0.65, importance: 2 }) ?? null;
        if (!h) continue;
        lights.set(t, h);
      }
      h.set({ position: _lp.set(t.position.x, app.getWorldHeight(t.position.x, t.position.z) + 1.2, t.position.z), intensity: P.lightCd * night * (0.6 + Math.random() * 0.4) });
    }
    working.clear();
  }

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
        j.close = null; u.noPush = false;
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
      // In reach: a vehicle — the last steps to its hull, out of the units' pushing (shared noPush).
      if (!t.isStructure && !j.close) {
        const sp = hullSpot(t, u, j.i, j.n);
        if (sp) { j.close = sp; u.noPush = true; u.moveTo?.(sp.x, sp.z); continue; }
      }
      // At work: facing it, the build clip (algBuild's `working`), unless under fire.
      if ((u.suppression ?? 0) > P.underFire) { if (u.working?.repair) u.working = null; continue; }
      if (!u.working?.repair) { u.working = { x: t.position.x, z: t.position.z, repair: t }; u.faceToward?.(j.close?.contact.x ?? t.position.x, j.close?.contact.z ?? t.position.z); }
      u.repairing = t;
      working.add(t);
      if (!t.isStructure) weld(u, t, dt, j.close?.contact);
      t.hp = Math.min(t.maxHp, t.hp + P.rate * dt);
      if (t.hp >= t.maxHp - 0.5) { t.hp = t.maxHp; end(u); }
    }
    stepLights();
    hookSound();
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

  // The work sound: the sappers' loop (algSounds "build") where men are at work on something.
  // Registered on the first step: the sound is made after the units (algGame.js).
  let soundOn = false;
  function hookSound() {
    if (soundOn || !app.algSounds?.audio?.addLoopProvider) return;
    soundOn = true;
    app.algSounds.audio.addLoopProvider(() => {
      const out = [];
      for (const [u] of jobs) if (u.repairing && u.alive) out.push({ slot: "build", key: u, x: u.position.x, y: u.position.y, z: u.position.z, level: 0.8 });
      return out;
    });
  }

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
