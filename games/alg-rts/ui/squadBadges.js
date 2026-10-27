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
import { isHuman, isHostile, SIDES, hostileSide } from "../../shared-rts/teams.js";
import { iconStyle } from "./icons.js";
import { hasRendered, renderedOnly } from "./iconAtlas.js";
import { t } from "../i18n/i18n.js";

export const ICONS = {   // (ui/quickSelect.js: its buttons' too)
  // A rifle, slung diagonally.
  appele: `<path d="M4.5 19.5 L18.5 5.5" stroke-width="2.4"/><path d="M3 18 L6 21" stroke-width="3.2"/><path d="M18.5 5.5 L21 3" stroke-width="1.2"/><path d="M11 13 L9.5 11.5" stroke-width="1.6"/>`,
  // A machine gun on its bipod: the pièce FM (algMgTeam.js).
  piece: `<path d="M3 10.5 L21 10.5" stroke-width="2.4"/><path d="M5 10.5 L4 14 L7 14 Z" fill="currentColor" stroke-width="1.2"/><path d="M11 8 L13 8 L13 10.5" stroke-width="1.6"/><path d="M16 10.5 L13.5 18 M16 10.5 L18.5 18" stroke-width="1.6"/>`,
  // A mortar on its bipod: the mortar teams (algMortarTeam.js), French and FLN.
  mortierFr: `<path d="M8 20 L14.5 4.5" stroke-width="3"/><path d="M5 20.5 L12 20.5" stroke-width="2"/><path d="M12.5 10 L17 20 M12.5 10 L9.5 20" stroke-width="1.4"/>`,
  mortier: `<path d="M8 20 L14.5 4.5" stroke-width="3"/><path d="M5 20.5 L12 20.5" stroke-width="2"/><path d="M12.5 10 L17 20 M12.5 10 L9.5 20" stroke-width="1.4"/>`,
  // A flame: the lance-flammes (algFlamethrower.js).
  lanceFlammes: `<path d="M12 21 C7 21 5 17.5 6.5 14 C7.5 11.5 9.5 10.5 9.5 7.5 C11.5 9 12.5 11 12 13 C13.5 12 14.5 10 14 7 C17 9.5 19 13 17.5 17 C16.5 19.5 14.5 21 12 21 Z" fill="currentColor" stroke-width="1.2"/>`,
  // A spanner (Feather "tool", MIT).
  sapeur: `<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" stroke-width="1.9"/>`,
  // A parachute: canopy, lines, the man.
  para: `<path d="M3 11 A9 7 0 0 1 21 11 Z" fill="currentColor" stroke-width="1.2"/><path d="M3 11 L11 18 M9 11 L11.5 18 M15 11 L12.5 18 M21 11 L13 18" stroke-width="1.1"/><circle cx="12" cy="19.5" r="1.8" fill="currentColor" stroke="none"/>`,
  // The Légion's grenade with its seven flames.
  legion: `<circle cx="12" cy="16.5" r="4.6" fill="currentColor" stroke="none"/><path d="M12 11.5 C11 8 13 6 12 2.5 M10 11.8 C8 9.5 9 7.5 7.5 5 M14 11.8 C16 9.5 15 7.5 16.5 5" stroke-width="1.5"/>`,
};

const STATE_TIP = { pinned: () => t("Cloués au sol"), supp: () => t("Sous le feu"), hard: () => t("Couverture solide"), light: () => t("Couverture légère") };

// (2026-10-12, you: "the badges with the health bar and icon are too small": every part ×1.45 —
// the shield 22×26 → 32×38, the count 14 → 20 px, the bar 26×3 → 38×5.)
const CSS = `
.alg-sqb { position: fixed; left: 0; top: 0; z-index: 40; display: grid; grid-template-columns: auto auto; align-items: center;
  column-gap: 4px; row-gap: 3px; pointer-events: none; will-change: transform; }
.alg-sqb .n { grid-row: 1; width: 20px; height: 20px; border-radius: 50%; background: rgba(12,16,22,0.92);
  border: 1px solid rgba(220,230,240,0.55); color: #e8eef4; font: 700 12px/18px var(--hud-sans, sans-serif); text-align: center; }
.alg-sqb svg.shield { grid-row: 1; width: 32px; height: 38px; display: block; pointer-events: auto; cursor: pointer; }
.alg-sqb svg.shield .rim { fill: rgba(12,16,22,0.92); stroke: #5aaeff; stroke-width: 1.6; }
.alg-sqb svg.shield .ic { color: #dfe9f2; stroke: currentColor; fill: none; stroke-linecap: round; stroke-linejoin: round; }
.alg-sqb.sel svg.shield .rim { stroke: #ffffff; stroke-width: 2; }
.alg-sqb.ret svg.shield .rim { stroke: #e0a040; }
/* HALTE AU FEU: a dashed rim and a "no" sign beside the shield (algUnits holdFire). */
.alg-sqb.hold svg.shield .rim { stroke-dasharray: 3 2; }
.alg-sqb.hold::after { content: ""; position: absolute; left: -15px; top: 6px; width: 11px; height: 11px; border: 2px solid #f2c94c; border-radius: 50%;
  background: linear-gradient(45deg, transparent 42%, #f2c94c 42%, #f2c94c 58%, transparent 58%); filter: drop-shadow(0 1px 1px #000); }
.alg-sqb.enemy svg.shield .rim { stroke: #ff5f4e; } .alg-sqb.enemy svg.shield { pointer-events: none; cursor: default; }
.alg-sqb.enemy .n { border-color: rgba(255,120,100,0.7); }
.alg-sqb .bar { grid-row: 2; grid-column: 2; width: 38px; height: 5px; background: rgba(10,12,14,0.9); border: 1px solid rgba(0,0,0,0.7);
  justify-self: center; position: relative; }
.alg-sqb .bar i { position: absolute; left: 0; top: 0; bottom: 0; background: #3ddc60; }
/* Veterancy: CoH's gold CHEVRONS (ui/icons.js vet1-3, a mask), over the shield. */
.alg-sqb .st { position: absolute; left: 30px; width: 20px; height: 20px; top: -21px; background: #f2c94c;
  -webkit-mask-size: contain; mask-size: contain; -webkit-mask-repeat: no-repeat; mask-repeat: no-repeat;
  -webkit-mask-position: center; mask-position: center; filter: drop-shadow(0 1px 1px #000); }
.alg-sqb .up { position: absolute; left: 47px; top: 25px; padding: 0 3px; border-radius: 2px; background: #c9a54a; color: #15120a;
  font: 800 10px/13px var(--hud-sans, sans-serif); box-shadow: 0 1px 2px rgba(0,0,0,0.8); }
/* THE CONTROL GROUP and THE STATE (2026-10-27, HUD_COH3_COMPARE.md 2 — CoH 3's badge): the group's number (Ctrl+1…9) over
   the head count; beside the shield a small sign — pinned (red), suppressed (amber), in hard / light cover (green / khaki) */
.alg-sqb .g { position: absolute; left: 5px; top: -16px; font: 800 12px/14px var(--hud-sans, sans-serif); color: #f1dfa6; text-shadow: 0 1px 2px #000, 0 0 4px #000; }
.alg-sqb .sg { position: absolute; left: 50px; top: 1px; width: 15px; height: 15px; border-radius: 50%; box-sizing: border-box;
  font: 900 10px/15px var(--hud-sans, sans-serif); text-align: center; color: #15120a; box-shadow: 0 1px 2px rgba(0,0,0,0.8); }
.alg-sqb .sg[hidden] { display: none; }
.alg-sqb .sg.pinned { background: #e4483a; color: #fff; } .alg-sqb .sg.supp { background: #f5a742; }
.alg-sqb .sg.hard { background: #7fbf5a; border-radius: 3px 3px 7px 7px; } .alg-sqb .sg.light { background: #c9b98a; border-radius: 3px 3px 7px 7px; }
`;

/**
 * @param {object} o
 * @param {object} o.app      (camera, renderer, selection, rtsCamera)
 * @param {object} o.squads   algSquads
 */
export function createSquadBadges({ app, squads, groups = null, groupOf = () => 0 }) {
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
    el.className = `alg-sqb${isHostile(s.team) ? " enemy" : ""}`;
    el.innerHTML = `<div class="n"></div>`
      + `<svg class="shield" viewBox="-2 -2 28 32"><path class="rim" d="M12 0 L24 3.5 V13 C24 21 18.5 25.5 12 28 C5.5 25.5 0 21 0 13 V3.5 Z"/>`
      + `<g class="ic" transform="translate(4.2 4.6) scale(0.65)">${ICONS[s.typeKey] ?? ICONS.appele}</g></svg>`
      + `<div class="bar"><i></i></div><div class="st"></div><div class="up" hidden>${t("FM")}</div><div class="g"></div><div class="sg" hidden></div>`;
    document.body.appendChild(el);
    const shield = el.querySelector("svg.shield");
    shield.addEventListener("click", (e) => { e.stopPropagation(); if (isHuman(s.team)) app.selection?.select(s.members); });
    shield.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      const l = s.leader;
      if (l) app.rtsCamera?.focusOn(l.position.x, l.position.z);
    });
    shield.addEventListener("pointerdown", (e) => e.stopPropagation());
    const b = { el, g: el.querySelector(".g"), sg: el.querySelector(".sg"), n: el.querySelector(".n"), fill: el.querySelector(".bar i"), st: el.querySelector(".st"), up: el.querySelector(".up"), last: "", pos: "", shown: true };
    badges.set(key, b);
    return b;
  }

  /** Each frame (render side). */
  function frame(camera) {
    const r = rectOf(canvas);   // cached: a read per frame forced a layout (shared-rts/canvasRect.js)
    const live = new Set();
    const fog = app.fogOfWar;
    for (const s of [...squads.list, ...(groups?.() ?? [])]) {
      const enemy = isHostile(s.team);
      if (!isHuman(s.team) && !enemy) continue;
      const men = s.members;
      if (!men.length) continue;
      if (enemy && fog?.enabled && !men.some((u) => fog.isVisible(u.position.x, u.position.z))) continue;
      live.add(s.id ?? s);
      const key0 = s.id ?? s;
      const b = badges.get(key0) ?? make(s, key0);
      // Over ONE MAN, as CoH: the squad's leader (the first alive, out in the open), 3 m up (just over
      // his head at 1.3x). Over the men's CENTRE it floated over empty ground whenever they spread —
      // a straggler, a man running back, a band strung out in the scrub (you, 2026-10-08: "the bar
      // and icon move alone, not on the unit").
      let hp = 0, max = 0, sel = false;
      for (const u of men) { hp += u.hp; max += u.maxHp; sel ||= !!u.selected; }
      const lead = men.find((u) => !u.inside) ?? men[0];
      v.set(lead.position.x, lead.position.y + 3.0, lead.position.z).project(camera);
      const on = v.z < 1 && Math.abs(v.x) < 1.05 && Math.abs(v.y) < 1.05;
      if (on !== b.shown) { b.el.style.display = on ? "" : "none"; b.shown = on; }
      if (!on) continue;
      const sx = Math.round(r.left + (v.x * 0.5 + 0.5) * r.width), sy = Math.round(r.top + (-v.y * 0.5 + 0.5) * r.height);
      const pos = `${sx},${sy}`;
      if (pos !== b.pos) { b.pos = pos; b.el.style.transform = `translate(${sx}px, ${sy}px) translate(-60%, -100%)`; }
      const f = max > 0 ? hp / max : 0;
      // its control group, and its state (the enemy's cover is not yours to know)
      const grp = enemy ? 0 : groupOf(lead);
      let state = "";
      if (men.some((u) => u.pinned)) state = "pinned";
      else if (men.some((u) => u.suppressed)) state = "supp";
      else if (!enemy && app.algCover) { const c = app.algCover.coverAt(lead.position.x, lead.position.z); state = c >= 0.35 ? "hard" : c >= 0.12 ? "light" : ""; }
      const key = `${grp}|${state}|${men.length}|${Math.round(f * 50)}|${sel}|${s.retreating}|${s.stars ?? 0}|${!!(s.upgrades?.lmg || s.upgrades?.bazooka)}|${!!s.holdFire}`;
      if (key === b.last) continue;
      b.last = key;
      b.n.textContent = men.length;
      b.g.textContent = grp ? String(grp) : "";
      b.sg.hidden = !state;
      if (state) { b.sg.className = `sg ${state}`; b.sg.textContent = state === "pinned" || state === "supp" ? "!" : ""; b.sg.title = STATE_TIP[state](); }
      b.fill.style.width = `${(f * 100).toFixed(0)}%`;
      b.fill.style.background = f > 0.6 ? "#3ddc60" : f > 0.3 ? "#f5c542" : "#e4483a";
      b.el.classList.toggle("sel", sel);
      b.el.classList.toggle("ret", !!s.retreating);
      b.el.classList.toggle("hold", !!s.holdFire);
      const vet = Math.min(3, s.stars ?? 0);
      b.st.hidden = !vet;
      if (vet) b.st.style.cssText = hasRendered(`vet${vet}`) ? renderedOnly(`vet${vet}`) : iconStyle(`vet${vet}`);   // (the brass chevrons, ui/iconAtlas.js)
      b.up.hidden = !(s.upgrades?.lmg || s.upgrades?.bazooka);
      b.up.textContent = s.upgrades?.bazooka ? t("Bazooka") : t("FM");   // (the faoudj's M20, algSquads)
    }
    for (const [s, b] of badges) if (!live.has(s)) { b.el.remove(); badges.delete(s); }
  }

  return {
    frame,
    dispose() { for (const b of badges.values()) b.el.remove(); badges.clear(); style.remove(); },
  };
}
