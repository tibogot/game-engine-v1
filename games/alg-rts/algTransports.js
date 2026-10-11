// TRANSPORTS — a squad rides in a truck or a half-track (2026-10-08, you: "what is the truck for?";
// before, the GMC only ran supply convoys, and the open one's men on the benches were decoration).
// The appelés went everywhere in the GMC "Jimmy"; the M3 half-track is CoH's way to carry a squad
// safely. Each takes ONE squad (6 men):
//   BOARD     right-click your truck or half-track with infantry selected (the cursor turns to a
//             truck over one with room): they run to it — it may be moving — and climb in.
//   INSIDE    not drawn, not pushed, not steered (`inside`, as a house's men); never targeted
//             (`passive`) and no blast reaches them — they don't fire either. They do not take
//             points (algEconomy.js). Their badge rides on the vehicle.
//   UNLOAD    the vehicle's DÉBARQUER, or the men's (their badge selects them), or any move
//             order given to the men: out at the tailgate, fanned out.
//   LOST      the vehicle destroyed: everyone thrown out, hurt — a soft GMC hurts (a mined truck
//             is a disaster for the squad in it), the armoured half-track much less.
// An empty GMC on patrol still delivers supplies to the villages you hold (algPatrols.js).
import * as THREE from "three";
import { isHuman, isHostile, SIDES, hostileSide } from "../shared-rts/teams.js";
import { iconStyle } from "./ui/icons.js";
import { t } from "./i18n/i18n.js";

const P = {
  cap: { gmc: 6, gmcOpen: 6, halftrack: 6 },
  reach: 3.5,             // m past the vehicle's radius: in he climbs
  repath: 0.6,            // s between re-aims at a moving vehicle
  giveUp: 30,             // s a man runs after a vehicle before he gives up
  // The vehicle destroyed: each man thrown out takes this (±30 %).
  wreckDamage: { gmc: 48, gmcOpen: 48, halftrack: 22 },
};

/**
 * @param {object} app
 * @param {object} o
 * @param {object} o.units   the shared units
 * @param {object} [o.navGrid]
 */
export function createAlgTransports(app, { units, navGrid = null }) {
  const dom = app.renderer.domElement;
  const load = new Map();      // vehicle → its men
  const pending = new Map();   // man → { v, t, re } on his way to a vehicle
  const isCarrier = (v) => !!v?.alive && !v.isStructure && P.cap[v.typeKey] > 0;
  const menOf = (v) => load.get(v) ?? [];
  const room = (v) => (P.cap[v.typeKey] ?? 0) - menOf(v).length - [...pending.values()].filter((p) => p.v === v).length;

  function board(u, v) {
    let m = load.get(v);
    if (!m) { m = []; load.set(v, m); }
    m.push(u);
    u.inside = true;
    u.carrier = v;
    u.passive = true;
    u._holdBefore = u.holdFire;
    u.holdFire = true;
    u.target = null; u.attackTarget = null;
    u.haltMovement?.();
    u.playerMove = false;
    u.position.set(v.position.x, v.position.y, v.position.z);
  }
  function unboard(u, k = 0) {
    const v = u.carrier;
    if (!v) return;
    const m = menOf(v), i = m.indexOf(u);
    if (i >= 0) m.splice(i, 1);
    if (!m.length) load.delete(v);
    u.inside = false;
    u.carrier = null;
    u.passive = false;
    u.holdFire = u._holdBefore ?? false;
    // Out at the TAILGATE, fanned out in a short arc behind the vehicle.
    const h = v.heading ?? 0, back = (v.radius ?? 3) + 1.2;
    const a = h + Math.PI + (k - 2.5) * 0.32;
    const x = v.position.x + Math.sin(a) * back, z = v.position.z + Math.cos(a) * back;
    const p = navGrid?.nearestOpenWorld?.(x, z, true) ?? { x, z };
    u.position.set(p.x, app.getWorldHeight(p.x, p.z), p.z);
  }
  /** Every man of `list` that rides out (a move order, a DÉBARQUER on the men). */
  const exitAll = (list) => { let k = 0; for (const u of list) if (u.carrier) unboard(u, k++); };
  /** A vehicle's whole load out. */
  const unloadAll = (v) => { [...menOf(v)].forEach((u, k) => unboard(u, k)); };

  /** Men told to board `v`; returns how many go. */
  function order(men, v) {
    if (!isCarrier(v)) return 0;
    let n = 0;
    for (const u of men) {
      if (!u?.alive || !u.type?.foot || u.inside || u.team !== v.team) continue;
      if (room(v) <= 0) break;
      pending.set(u, { v, t: 0, re: P.repath });
      u.moveOrder(v.position.x, v.position.z);
      n++;
    }
    return n;
  }

  function step(dt) {
    for (const [u, p] of pending) {
      const v = p.v;
      if (!u.alive || u.inside || !v.alive) { pending.delete(u); continue; }
      if (Math.hypot(u.position.x - v.position.x, u.position.z - v.position.z) < (v.radius ?? 3) + P.reach) {
        pending.delete(u);
        if (menOf(v).length < (P.cap[v.typeKey] ?? 0)) board(u, v);
        continue;
      }
      p.t += dt;
      if (p.t > P.giveUp) { pending.delete(u); continue; }
      // The vehicle moves: aim at where it is now.
      if ((p.re -= dt) <= 0) { p.re = P.repath; u.orderTo(v.position.x, v.position.z); }
    }
    for (const [v, m] of [...load]) {
      // The vehicle gone, whatever killed it (a shell, a mine, a script): its men out, hurt.
      if (!v.alive) { onDeath(v); continue; }
      for (const u of [...m]) {
        // A retreating squad (RETRAITE): out, and it runs home on foot.
        if (u.squad?.retreating) { unboard(u, m.length); continue; }
        u.position.set(v.position.x, v.position.y, v.position.z);
      }
    }
  }

  /** The vehicle destroyed (combat's onDeath): everyone out, hurt. */
  function onDeath(v) {
    const m = [...menOf(v)];
    if (!m.length) return;
    const dmg = P.wreckDamage[v.typeKey] ?? 35;
    m.forEach((u, k) => { unboard(u, k); u.takeDamage?.(dmg * (0.7 + Math.random() * 0.6)); });
    load.delete(v);
    if (isHuman(v.team)) app.algBattle?.say?.(t("<b>Véhicule détruit</b> avec un groupe à bord : les survivants sautent."), v.position.x, v.position.z, "bad", null, "alertAttack");
  }

  // ── The player's order: right-click your vehicle; the cursor over one with room ──
  const _v = new THREE.Vector3(), _e = new THREE.Vector3();
  /** Your carrier under the cursor (its outline on screen, as the selection picks a vehicle). */
  function pickAt(clientX, clientY) {
    const r = dom.getBoundingClientRect();
    let best = null, bd = Infinity;
    for (const v of units.list) {
      if (!isCarrier(v) || !isHuman(v.team)) continue;
      const rad = v.radius ?? 3;
      _v.set(v.position.x, v.position.y + 1.2, v.position.z).project(app.camera);
      if (_v.z > 1) continue;
      _e.set(v.position.x + rad, v.position.y + 1.2, v.position.z).project(app.camera);
      const sx = r.left + (_v.x * 0.5 + 0.5) * r.width, sy = r.top + (-_v.y * 0.5 + 0.5) * r.height;
      const rpx = Math.max(14, Math.hypot((_e.x - _v.x) * 0.5 * r.width, (_e.y - _v.y) * 0.5 * r.height));
      const d = Math.hypot(sx - clientX, sy - clientY);
      if (d < rpx && d < bd) { bd = d; best = v; }
    }
    return best;
  }
  const infantry = () => (app.selection?.selected ?? []).filter((u) => u.alive && isHuman(u.team) && u.type?.foot && !u.inside);
  function onContext(e) {
    const men = infantry();
    if (!men.length || dom.style.cursor === "crosshair") return;
    const v = pickAt(e.clientX, e.clientY);
    if (!v) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (order(men, v)) {
      app.algOrderMarks?.order?.(v.position.x, v.position.y, v.position.z, men, "move");
      app.algVoices?.order?.("move", men);
    }
  }
  const TRUCK_CURSOR = `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><g fill="none" stroke-linejoin="round"><path d="M3 9h15v12H3zM18 13h6l4 4v4H18z" fill="#000" fill-opacity=".55" stroke="#000" stroke-width="3.5"/><path d="M3 9h15v12H3zM18 13h6l4 4v4H18z" stroke="#7fc3ff" stroke-width="2"/><circle cx="8" cy="23" r="2.4" fill="#0b0f14" stroke="#7fc3ff" stroke-width="1.8"/><circle cx="23" cy="23" r="2.4" fill="#0b0f14" stroke="#7fc3ff" stroke-width="1.8"/></g></svg>')}") 16 16, pointer`;
  let hoverT = 0, hoverOn = false;
  function onHover(e) {
    const now = performance.now();
    if (now - hoverT < 90) return;
    hoverT = now;
    if (dom.style.cursor && !hoverOn) return;   // another mode owns it
    const v = infantry().length ? pickAt(e.clientX, e.clientY) : null;
    const on = !!v && room(v) > 0;
    if (on !== hoverOn) { hoverOn = on; dom.style.cursor = on ? TRUCK_CURSOR : ""; }
  }
  dom.addEventListener("contextmenu", onContext, true);   // capture: before the move order
  dom.addEventListener("pointermove", onHover);

  // ── The badge over a loaded vehicle: its men (n / places); a click selects them ──
  const badges = new Map();   // vehicle → { el, txt, last }
  const _b = new THREE.Vector3();
  function frame(camera) {
    const r = dom.getBoundingClientRect();
    for (const [v, b] of badges) if (!load.has(v)) { b.el.remove(); badges.delete(v); }
    for (const [v, m] of load) {
      let b = badges.get(v);
      if (!b) {
        const el = document.createElement("div");
        el.className = "alg-gar";
        el.innerHTML = `<i style="${iconStyle("transport")}"></i><span></span>`;
        el.title = t("Groupe à bord — clic : le sélectionner · Débarquer");
        el.addEventListener("click", (e) => { e.stopPropagation(); app.selection?.select(menOf(v).filter((u) => u.alive)); });
        el.addEventListener("pointerdown", (e) => e.stopPropagation());
        document.body.appendChild(el);
        b = { el, txt: el.querySelector("span"), last: "" };
        badges.set(v, b);
      }
      _b.set(v.position.x, v.position.y + 5.2, v.position.z).project(camera);
      const on = v.alive && _b.z < 1 && Math.abs(_b.x) < 1.05 && Math.abs(_b.y) < 1.05;
      b.el.style.display = on ? "" : "none";
      if (!on) continue;
      b.el.style.transform = `translate(${Math.round(r.left + (_b.x * 0.5 + 0.5) * r.width)}px, ${Math.round(r.top + (-_b.y * 0.5 + 0.5) * r.height)}px) translate(-50%, -100%)`;
      const key = `${m.length}`;
      if (key !== b.last) { b.last = key; b.txt.textContent = `${m.length}/${P.cap[v.typeKey]}`; }
    }
  }

  return {
    params: P, order, exitAll, unloadAll, onDeath, step, frame, pickAt,
    /** Men aboard `v`. */
    menOf,
    /**
     * DÉBARQUER on the command card: a selected vehicle with men aboard, or selected men aboard.
     */
    ability(sel) {
      if (!sel.some((u) => (isCarrier(u) && menOf(u).length) || u.carrier)) return null;
      return { key: "disembark", label: t("Débarquer"), hint: t("Le groupe descend à l'arrière du véhicule."), ready: true };
    },
    disembark(sel) {
      // The men still RUNNING to the vehicle are told off too (you, 2026-10-11, the training's
      // half-track: "K to disembark doesn't work" — it emptied the vehicle, then the stragglers
      // still chasing it, up to `giveUp` s, caught up and climbed in: it looked full again).
      for (const [u, p] of [...pending]) {
        if (sel.includes(p.v) || sel.includes(u)) { pending.delete(u); u.haltMovement?.(); }
      }
      for (const u of sel) if (isCarrier(u)) unloadAll(u);
      exitAll(sel);
    },
    dispose() {
      dom.removeEventListener("contextmenu", onContext, true);
      dom.removeEventListener("pointermove", onHover);
      for (const b of badges.values()) b.el.remove();
    },
  };
}
