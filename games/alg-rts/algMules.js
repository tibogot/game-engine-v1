// THE FLN'S MULE (2026-10-13, A2 — the wilayas moved on foot and on mules: "a moving supply point").
// A pack mule loaded with ammunition, bought at the cave by a human FLN. A UNIT in the sim (it is
// selected, ordered, shot at — 90 hp, no weapon), DRAWN by the herds (algHerds.js: a loaded donkey in
// their crowd, its anchor driven from here — the unit renderer skips its type, `drawnElsewhere`).
//   FOLLOWS   right-click one of your faoudjs with the mule selected: it keeps behind that squad
//             (any other order lets it go).
//   SUPPLIES  every man of yours within P.radius of a living mule: a squad short of men REINFORCES
//             there as at the cave (algSquads fieldPoints — the half-track's way for the French);
//             his wounds heal slowly (its medical pannier).
//   LOST      a dead mule is a loss of P.cost — the French gain nothing, but they will hunt it.
import * as THREE from "three";
import { createSelectionRingField } from "../shared-rts/selectionRingField.js";
import { isHuman } from "../shared-rts/teams.js";
import { t } from "./i18n/i18n.js";

export const MULES = {
  key: "mulet",
  radius: 25,       // m: its men are within reach of it
  heal: 0.6,        // hp a second for a wounded man near it, out of combat
  follow: 5,        // m behind the squad's centre
  repath: 1.2,      // s between two follow orders
};
const P = MULES;

export function createAlgMules(app, { units, squads, selection }) {
  const dom = app.renderer.domElement;
  const follows = new Map();   // mule → squad
  const mules = () => units.list.filter((u) => u.alive && u.typeKey === P.key);
  const near = (m, u) => Math.hypot(u.position.x - m.position.x, u.position.z - m.position.z) < P.radius;

  // ── Drawn by the herds: one loaded donkey per mule, on its anchor ──────────
  const slots = new Map();     // mule → herd slot { anchor }
  function draw() {
    const pool = app.algHerds?.muleSlots;
    if (!pool) return;
    for (const [m, s] of slots) if (!m.alive) { s.anchor.moving = false; s.park(); slots.delete(m); }
    for (const m of mules()) {
      let s = slots.get(m);
      if (!s) { s = pool.find((q) => !q.used); if (!s) continue; s.used = true; slots.set(m, s); s.place(m.position.x, m.position.z); }
      s.anchor.x = m.position.x; s.anchor.z = m.position.z; s.anchor.yaw = m.heading ?? 0;
      s.anchor.moving = m.isMoving;
      s.anchor.pace = m.type.speed;   // (wildHerd: the donkey keeps the unit's pace)
    }
    for (const s of pool) if (s.used && ![...slots.values()].includes(s)) s.used = false;
  }

  // ── Orders: right-click a faoudj of yours with mules selected ──────────────
  const selectedMules = () => (selection.selected ?? []).filter((u) => u.alive && u.typeKey === P.key && isHuman(u.team));
  const _v = new THREE.Vector3();
  function squadUnder(clientX, clientY) {
    const r = dom.getBoundingClientRect();
    let best = null, bd = 28;
    for (const s of squads.list) {
      if (!isHuman(s.team)) continue;
      for (const u of s.members) {
        _v.set(u.position.x, u.position.y + 1, u.position.z).project(app.camera);
        if (_v.z > 1) continue;
        const d = Math.hypot(r.left + (_v.x * 0.5 + 0.5) * r.width - clientX, r.top + (-_v.y * 0.5 + 0.5) * r.height - clientY);
        if (d < bd) { bd = d; best = s; }
      }
    }
    return best;
  }
  function onContext(e) {
    const ms = selectedMules();
    if (!ms.length) return;
    const s = squadUnder(e.clientX, e.clientY);
    for (const m of ms) follows.delete(m);   // any right-click: a new order (the move goes on as usual)
    if (!s) return;
    e.preventDefault(); e.stopImmediatePropagation();
    for (const m of ms) { follows.set(m, s); m._muleRe = 0; }
    app.algOrderMarks?.order?.(s.leader?.position.x ?? 0, s.leader?.position.y ?? 0, s.leader?.position.z ?? 0, ms, "move");
  }
  dom.addEventListener("contextmenu", onContext, true);

  function step(dt) {
    for (const [m, s] of [...follows]) {
      if (!m.alive || !s.members.length) { follows.delete(m); continue; }
      if ((m._muleRe -= dt) > 0) continue;
      m._muleRe = P.repath;
      const ms = s.members, cx = ms.reduce((a, u) => a + u.position.x, 0) / ms.length, cz = ms.reduce((a, u) => a + u.position.z, 0) / ms.length;
      const h = s.leader?.heading ?? 0;
      const tx = cx - Math.sin(h) * P.follow, tz = cz - Math.cos(h) * P.follow;
      if (Math.hypot(tx - m.position.x, tz - m.position.z) > 3) m.orderTo(tx, tz);
    }
    // The wounded heal slowly by a mule (its medical pannier), out of the fight.
    for (const m of mules()) {
      for (const u of units.near ? units.near(m.position.x, m.position.z, P.radius, []) : units.list) {
        if (u.team !== m.team || !u.type?.foot || u.type?.animal || u.hp >= u.maxHp || u.target || (u.suppression ?? 0) > 0.1) continue;
        if (near(m, u)) u.hp = Math.min(u.maxHp, u.hp + P.heal * dt);
      }
    }
  }

  const rings = createSelectionRingField({ app, inner: 0.95, segments: 64 });
  function frame() {
    draw();
    rings.begin();
    for (const m of mules()) {
      if (!isHuman(m.team)) continue;
      if (m.selected) { rings.add(m.position.x, m.position.z, 2.2, 0x58e070); rings.add(m.position.x, m.position.z, P.radius, 0xe0a93a); }
    }
    rings.commit();
  }

  return {
    params: P, step, frame,
    /** Mules of `team` (fieldPoints: a squad reinforces by one). */
    pointsFor: (team) => mules().filter((m) => m.team === team),
    /** A man within a mule's reach (a grenade at half price — algGrenades). */
    supplied: (u) => mules().some((m) => m.team === u.team && near(m, u)),
    following: (m) => follows.get(m) ?? null,
    dispose() { dom.removeEventListener("contextmenu", onContext, true); },
  };
}
