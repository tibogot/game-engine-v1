// THE QUICK-SELECT BUTTONS by the minimap (2026-10-27, HUD_COH3_COMPARE.md 5 — CoH 3's round buttons round its minimap):
// all your infantry, all your vehicles, your idle sappers (a sapper with no site to build, standing, not fighting). Round,
// in the minimap block's bottom-right corner (outside the map's diamond). Double click: the camera to them as well.
import { isHuman } from "../../shared-rts/teams.js";
import { ICONS } from "./squadBadges.js";
import { t } from "../i18n/i18n.js";

const JEEP = `<path d="M3 15 L5 10 L15 10 L17 13 L21 13.5 L21 16.5 L3 16.5 Z" fill="currentColor" stroke-width="1.1"/><circle cx="7" cy="17.5" r="2.2" fill="currentColor" stroke="none"/><circle cx="17" cy="17.5" r="2.2" fill="currentColor" stroke="none"/><path d="M9 10 L10.5 6.5" stroke-width="1.4"/>`;

const CSS = `
#alg-qsel { position: absolute; right: 6px; bottom: 6px; width: 74px; height: 74px; pointer-events: none; }
#alg-qsel button { position: absolute; width: 32px; height: 32px; padding: 0; border-radius: 50%; cursor: pointer; pointer-events: auto;
  display: grid; place-items: center; background: var(--hud-bg); border: 1px solid var(--hud-edge-hi); color: #dfe9f2;
  box-shadow: 0 2px 8px rgba(0,0,0,0.45); }
#alg-qsel button:hover { border-color: var(--hud-brass); color: #f1dfa6; }
#alg-qsel button:disabled { opacity: 0.35; cursor: default; }
#alg-qsel button svg { width: 19px; height: 19px; stroke: currentColor; fill: none; stroke-linecap: round; stroke-linejoin: round; }
#alg-qsel button .n { position: absolute; right: -3px; bottom: -3px; min-width: 14px; height: 14px; padding: 0 2px; border-radius: 7px; box-sizing: border-box;
  background: #c9a54a; color: #15120a; font: 800 9px/14px var(--hud-sans); text-align: center; }
#alg-qsel button .n[hidden] { display: none; }
`;

/**
 * @param {object} o
 * @param {HTMLElement} o.mount   the minimap's block (hudBar.js left)
 * @param {object} o.units        (list)
 * @param {object} o.selection
 * @param {(x: number, z: number) => void} o.focus
 */
export function createQuickSelect({ mount, units, selection, focus }) {
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
  const root = document.createElement("div");
  root.id = "alg-qsel";
  const mine = (u) => u.alive && isHuman(u.team) && !u.isStructure && !u.site;
  const KINDS = [
    { key: "inf", at: [0, 42], icon: ICONS.appele, tip: t("Toute l'infanterie (double-clic : y aller)"), pick: () => units.list.filter((u) => mine(u) && u.type?.foot) },
    { key: "veh", at: [42, 42], icon: JEEP, tip: t("Tous les véhicules (double-clic : y aller)"), pick: () => units.list.filter((u) => mine(u) && !u.type?.foot) },
    { key: "idle", at: [42, 0], icon: ICONS.sapeur, tip: t("Les sapeurs sans travail (double-clic : y aller)"),
      pick: () => units.list.filter((u) => mine(u) && u.typeKey === "sapeur" && !u.buildSite && !u.isMoving && !u.target?.alive && !u.attackTarget?.alive) },
  ];
  const btns = KINDS.map((k) => {
    const b = document.createElement("button");
    b.type = "button";
    b.style.left = `${k.at[0]}px`; b.style.top = `${k.at[1]}px`;
    b.title = k.tip;
    b.innerHTML = `<svg viewBox="0 0 24 24">${k.icon}</svg><span class="n" hidden></span>`;
    b.addEventListener("pointerdown", (e) => e.stopPropagation());
    b.addEventListener("click", () => { const l = k.pick(); if (l.length) selection.select(l); });
    b.addEventListener("dblclick", () => {
      const l = k.pick();
      if (l.length) focus(l.reduce((s, u) => s + u.position.x, 0) / l.length, l.reduce((s, u) => s + u.position.z, 0) / l.length);
    });
    root.appendChild(b);
    return { b, k, n: b.querySelector(".n"), last: -1 };
  });
  mount.appendChild(root);
  let wait = 0;
  return {
    /** Every frame (real seconds): the counts, 4 times a second — the idle sappers' count lit as CoH's. */
    tick(dt) {
      if ((wait -= dt) > 0) return;
      wait = 0.25;
      for (const v of btns) {
        const n = v.k.pick().length;
        if (n === v.last) continue;
        v.last = n;
        v.b.disabled = !n;
        v.n.hidden = v.k.key !== "idle" || !n;
        v.n.textContent = n;
      }
    },
    dispose() { root.remove(); style.remove(); },
  };
}
