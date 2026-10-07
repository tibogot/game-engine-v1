// THE TACTICAL MAP (a player, 2026-10-07, zoomed right out to see more; CoH's answer is not the
// zoom, it is this): the minimap, full screen.
//
//   HOLD Tab   it shows while held — a look, then back to the fight
//   TAP Tab    it stays open (until Tab or Esc again)
//   left click / drag   the camera goes there · RIGHT click   the selection moves there
//
// It IS a second minimap (ui/minimap.js — the same bake, territory, supply lines, units, combat
// pulses, the camera's outline), built at boot at its full size so opening it costs nothing; drawn
// only while open. The game runs on underneath (CoH doesn't pause for it).
import { t } from "../i18n/i18n.js";
const TAP_MS = 250;

/**
 * @param {object} o
 * @param {object} o.app
 * @param {(mount: HTMLElement) => object} o.create  builds the map into `mount` (createMinimap)
 */
export function createTacticalMap({ app, create }) {
  const back = document.createElement("div");
  back.id = "alg-tacmap-back";
  back.innerHTML = `
    <div class="sheet">
      <div class="head"><span class="kicker">${t("Aurès · vallée de Tighanimine")}</span><span class="title">${t("Carte tactique")}</span></div>
      <div class="map"></div>
      <div class="foot">${t("<kbd>Clic gauche</kbd> y aller · <kbd>Clic droit</kbd> y envoyer la sélection · <kbd>Tab</kbd> maintenu : un coup d'œil, tapé : reste ouverte · <kbd>Échap</kbd> fermer")}</div>
    </div>`;
  const style = document.createElement("style");
  style.textContent = `
    #alg-tacmap-back { position: fixed; inset: 0; z-index: 80; display: flex; align-items: center; justify-content: center;
      background: radial-gradient(ellipse at center, rgba(8,10,6,0.78), rgba(8,10,6,0.94));
      visibility: hidden; opacity: 0; transition: opacity 0.12s; }
    #alg-tacmap-back.open { visibility: visible; opacity: 1; }
    #alg-tacmap-back .sheet { display: flex; flex-direction: column; align-items: center; gap: 8px; }
    #alg-tacmap-back .head { display: flex; flex-direction: column; align-items: center; gap: 2px; pointer-events: none; }
    #alg-tacmap-back .kicker { font: 600 11px 'Segoe UI', system-ui, sans-serif; letter-spacing: 0.2em; text-transform: uppercase; color: var(--hud-brass, #c9a85a); }
    #alg-tacmap-back .title { font: 600 22px 'Segoe UI', system-ui, sans-serif; color: #f1e6c8; text-shadow: 0 2px 6px #000; }
    #alg-tacmap-back .map { width: var(--tac-size); height: var(--tac-size); filter: drop-shadow(0 8px 24px rgba(0,0,0,0.7)); }
    #alg-tacmap-back .foot { font: 13px 'Segoe UI', system-ui, sans-serif; color: #d8cfb8; text-shadow: 0 1px 3px #000; pointer-events: none; }
    #alg-tacmap-back kbd { font: 11px ui-monospace, Consolas, monospace; padding: 0 5px; border: 1px solid rgba(201,168,90,0.6); border-radius: 2px; }
  `;
  document.head.appendChild(style);
  document.body.appendChild(back);
  // Its size, set BEFORE the map is built (the minimap bakes at its slot's real pixel size).
  const size = Math.round(Math.min(innerHeight - 130, innerWidth * 0.72, 900));
  back.style.setProperty("--tac-size", `${size}px`);
  const map = create(back.querySelector(".map"));

  let open = false, pinned = false, downAt = 0;
  function show() { open = true; back.classList.add("open"); }
  function hide() { open = false; pinned = false; back.classList.remove("open"); }
  const typing = () => /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName ?? "");
  const onDown = (e) => {
    if (e.key === "Escape" && open) { hide(); return; }   // (the menu's Esc skips while open)
    if (e.key !== "Tab" || typing()) return;
    e.preventDefault();                                     // not the browser's focus walk
    if (e.repeat) return;
    if (open && pinned) { hide(); return; }
    if (document.querySelector(".alg-modal-back")) return;  // the pause menu, a briefing
    downAt = performance.now();
    show();
  };
  const onUp = (e) => {
    if (e.key !== "Tab" || !open || pinned) return;
    if (performance.now() - downAt < TAP_MS) pinned = true; else hide();
  };
  window.addEventListener("keydown", onDown);
  window.addEventListener("keyup", onUp);
  window.addEventListener("blur", hide);

  return {
    map,
    get open() { return open; },
    show() { pinned = true; show(); },
    hide,
    /** Once a frame: drawn only while open. */
    draw() { if (open) map.draw(); },
    dispose() {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", hide);
      map.dispose(); back.remove(); style.remove();
    },
  };
}
