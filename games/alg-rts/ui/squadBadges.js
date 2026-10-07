// THE SQUAD BADGES (you, 2026-10-03, watching Company of Heroes: "the health
// bar looks thinner in CoH but it has an icon"): over each French squad, as
// CoH draws it —
//   ( n ) [shield]     the men left in the squad · the squad's type
//         ▬▬▬▬▬        ONE thin bar: the health of the men it has
//   chevrons over the shield: the squad's VETERANCY (algVeterancy.js); a brass
//   "FM" tag at its foot: the FM 24/29 upgrade (algSquads UPGRADES).
// The men themselves no longer carry bars (unitRenderer `barFor`). Blue rim
// = yours, white = selected, amber = retreating. Click a badge: select the
// squad; double click: the camera goes there.
//
// DOM, not the world: a dozen squads at most, crisp at any zoom, and each
// badge only touches the DOM when what it shows has changed.

import { rectOf } from "../../shared-rts/canvasRect.js";
import { iconStyle } from "./icons.js";

const ICONS = {
  // A rifle, slung diagonally.
  appele: `<path d="M4.5 19.5 L18.5 5.5" stroke-width="2.4"/><path d="M3 18 L6 21" stroke-width="3.2"/><path d="M18.5 5.5 L21 3" stroke-width="1.2"/><path d="M11 13 L9.5 11.5" stroke-width="1.6"/>`,
  // A machine gun on its bipod: the pièce FM (algMgTeam.js).
  piece: `<path d="M3 10.5 L21 10.5" stroke-width="2.4"/><path d="M5 10.5 L4 14 L7 14 Z" fill="currentColor" stroke-width="1.2"/><path d="M11 8 L13 8 L13 10.5" stroke-width="1.6"/><path d="M16 10.5 L13.5 18 M16 10.5 L18.5 18" stroke-width="1.6"/>`,
  // A spanner (Feather "tool", MIT).
  sapeur: `<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" stroke-width="1.9"/>`,
  // A parachute: canopy, lines, the man.
  para: `<path d="M3 11 A9 7 0 0 1 21 11 Z" fill="currentColor" stroke-width="1.2"/><path d="M3 11 L11 18 M9 11 L11.5 18 M15 11 L12.5 18 M21 11 L13 18" stroke-width="1.1"/><circle cx="12" cy="19.5" r="1.8" fill="currentColor" stroke="none"/>`,
  // The Légion's grenade with its seven flames.
  legion: `<circle cx="12" cy="16.5" r="4.6" fill="currentColor" stroke="none"/><path d="M12 11.5 C11 8 13 6 12 2.5 M10 11.8 C8 9.5 9 7.5 7.5 5 M14 11.8 C16 9.5 15 7.5 16.5 5" stroke-width="1.5"/>`,
};

const CSS = `
.alg-sqb { position: fixed; left: 0; top: 0; z-index: 40; display: grid; grid-template-columns: auto auto; align-items: center;
  column-gap: 3px; row-gap: 2px; pointer-events: none; will-change: transform; }
.alg-sqb .n { grid-row: 1; width: 14px; height: 14px; border-radius: 50%; background: rgba(12,16,22,0.92);
  border: 1px solid rgba(220,230,240,0.55); color: #e8eef4; font: 700 9px/12px var(--hud-sans, sans-serif); text-align: center; }
.alg-sqb svg.shield { grid-row: 1; width: 22px; height: 26px; display: block; pointer-events: auto; cursor: pointer; }
.alg-sqb svg.shield .rim { fill: rgba(12,16,22,0.92); stroke: #5aaeff; stroke-width: 1.6; }
.alg-sqb svg.shield .ic { color: #dfe9f2; stroke: currentColor; fill: none; stroke-linecap: round; stroke-linejoin: round; }
.alg-sqb.sel svg.shield .rim { stroke: #ffffff; stroke-width: 2; }
.alg-sqb.ret svg.shield .rim { stroke: #e0a040; }
.alg-sqb.enemy svg.shield .rim { stroke: #ff5f4e; } .alg-sqb.enemy svg.shield { pointer-events: none; cursor: default; }
.alg-sqb.enemy .n { border-color: rgba(255,120,100,0.7); }
.alg-sqb .bar { grid-row: 2; grid-column: 2; width: 26px; height: 3px; background: rgba(10,12,14,0.9); border: 1px solid rgba(0,0,0,0.7);
  justify-self: center; position: relative; }
.alg-sqb .bar i { position: absolute; left: 0; top: 0; bottom: 0; background: #3ddc60; }
/* Veterancy: CoH's gold CHEVRONS (ui/icons.js vet1-3, a mask), over the shield. */
.alg-sqb .st { position: absolute; left: 21px; width: 14px; height: 12px; top: -13px; background: #f2c94c;
  -webkit-mask-size: contain; mask-size: contain; -webkit-mask-repeat: no-repeat; mask-repeat: no-repeat;
  -webkit-mask-position: center; mask-position: center; filter: drop-shadow(0 1px 1px #000); }
.alg-sqb .up { position: absolute; left: 33px; top: 17px; padding: 0 2px; border-radius: 2px; background: #c9a54a; color: #15120a;
  font: 800 7px/9px var(--hud-sans, sans-serif); box-shadow: 0 1px 2px rgba(0,0,0,0.8); }
`;

/**
 * @param {object} o
 * @param {object} o.app      (camera, renderer, selection, rtsCamera)
 * @param {object} o.squads   algSquads
 */
export function createSquadBadges({ app, squads, groups = null }) {
  // `groups()`: more squads to badge — the FLN's bands ({ id, team, typeKey, members, stars }),
  // shown while any of their men is seen (fog of war), not clickable.
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
  const canvas = app.renderer.domElement;
  const badges = new Map();   // squad → { el, n, fill, last, x, y, shown }
  const v = app.camera.position.clone();

  function make(s, key = s) {
    const el = document.createElement("div");
    el.className = `alg-sqb${s.team === "enemy" ? " enemy" : ""}`;
    el.innerHTML = `<div class="n"></div>`
      + `<svg class="shield" viewBox="-2 -2 28 32"><path class="rim" d="M12 0 L24 3.5 V13 C24 21 18.5 25.5 12 28 C5.5 25.5 0 21 0 13 V3.5 Z"/>`
      + `<g class="ic" transform="translate(4.2 4.6) scale(0.65)">${ICONS[s.typeKey] ?? ICONS.appele}</g></svg>`
      + `<div class="bar"><i></i></div><div class="st"></div><div class="up" hidden>FM</div>`;
    document.body.appendChild(el);
    const shield = el.querySelector("svg.shield");
    shield.addEventListener("click", (e) => { e.stopPropagation(); if (s.team === "player") app.selection?.select(s.members); });
    shield.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      const l = s.leader;
      if (l) app.rtsCamera?.focusOn(l.position.x, l.position.z);
    });
    shield.addEventListener("pointerdown", (e) => e.stopPropagation());
    const b = { el, n: el.querySelector(".n"), fill: el.querySelector(".bar i"), st: el.querySelector(".st"), up: el.querySelector(".up"), last: "", pos: "", shown: true };
    badges.set(key, b);
    return b;
  }

  /** Each frame (render side). */
  function frame(camera) {
    const r = rectOf(canvas);   // cached: a read per frame forced a layout (shared-rts/canvasRect.js)
    const live = new Set();
    const fog = app.fogOfWar;
    for (const s of [...squads.list, ...(groups?.() ?? [])]) {
      const enemy = s.team === "enemy";
      if (s.team !== "player" && !enemy) continue;
      const men = s.members;
      if (!men.length) continue;
      if (enemy && fog?.enabled && !men.some((u) => fog.isVisible(u.position.x, u.position.z))) continue;
      live.add(s.id ?? s);
      const key0 = s.id ?? s;
      const b = badges.get(key0) ?? make(s, key0);
      // Over the squad: its men's centre, 3.6 m up (over their heads at 1.3x).
      let x = 0, y = 0, z = 0, hp = 0, max = 0, sel = false;
      for (const u of men) { x += u.position.x; y += u.position.y; z += u.position.z; hp += u.hp; max += u.maxHp; sel ||= !!u.selected; }
      v.set(x / men.length, y / men.length + 3.6, z / men.length).project(camera);
      const on = v.z < 1 && Math.abs(v.x) < 1.05 && Math.abs(v.y) < 1.05;
      if (on !== b.shown) { b.el.style.display = on ? "" : "none"; b.shown = on; }
      if (!on) continue;
      const sx = Math.round(r.left + (v.x * 0.5 + 0.5) * r.width), sy = Math.round(r.top + (-v.y * 0.5 + 0.5) * r.height);
      const pos = `${sx},${sy}`;
      if (pos !== b.pos) { b.pos = pos; b.el.style.transform = `translate(${sx}px, ${sy}px) translate(-60%, -100%)`; }
      const f = max > 0 ? hp / max : 0;
      const key = `${men.length}|${Math.round(f * 50)}|${sel}|${s.retreating}|${s.stars ?? 0}|${!!s.upgrades?.lmg}`;
      if (key === b.last) continue;
      b.last = key;
      b.n.textContent = men.length;
      b.fill.style.width = `${(f * 100).toFixed(0)}%`;
      b.fill.style.background = f > 0.6 ? "#3ddc60" : f > 0.3 ? "#f5c542" : "#e4483a";
      b.el.classList.toggle("sel", sel);
      b.el.classList.toggle("ret", !!s.retreating);
      const vet = Math.min(3, s.stars ?? 0);
      b.st.hidden = !vet;
      if (vet) b.st.style.cssText = iconStyle(`vet${vet}`);
      b.up.hidden = !s.upgrades?.lmg;
    }
    for (const [s, b] of badges) if (!live.has(s)) { b.el.remove(); badges.delete(s); }
  }

  return {
    frame,
    dispose() { for (const b of badges.values()) b.el.remove(); badges.clear(); style.remove(); },
  };
}
