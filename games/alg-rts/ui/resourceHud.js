// THE SUPPLY STRIP — the HUD bar's status strip (hudBar.js): the French
// three resources (effectifs, carburant, munitions, algEconomy.js), each with
// its income a minute, and the villages — how many are yours, how many the
// ALN's. This game's own (nam's shows its requisition points).
import { iconSvg } from "./resourceIcons.js";
const CSS = `
/* TOP RIGHT (2026-10-02, CoH): the numbers off the command card's back. */
#alg-res {
  position: fixed; top: 8px; right: calc(var(--alg-dev-w, 340px) + 8px); z-index: 56;
  display: flex; flex-direction: column; align-items: flex-end; gap: 2px; font-size: 11px; white-space: nowrap;
  padding: 5px 12px; background: var(--hud-bg); border: 1px solid var(--hud-edge-hi); border-radius: var(--hud-radius);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35); font-family: var(--hud-sans); color: var(--hud-text);
}
#alg-res .row { display: flex; align-items: center; gap: 10px; }
#alg-res .row2 { font-size: 10px; }
#alg-res .ric { display: inline-flex; color: var(--hud-dim); }
#alg-res .res.mp .ric { color: var(--hud-brass); } #alg-res .res.fuel .ric { color: #e2b25a; } #alg-res .res.mun .ric { color: #d48a6a; }
#alg-res .res { display: flex; align-items: baseline; gap: 5px; }
#alg-res .amount { font-weight: 700; font-size: 14px; color: var(--hud-brass); min-width: 30px; text-align: right; }
#alg-res .res.fuel .amount { color: #e2b25a; }
#alg-res .res.mun .amount { color: #d48a6a; }
#alg-res .inc { color: var(--hud-dim); font-size: 10px; }
#alg-res .cut { color: #e0a040; }
#alg-res .sep { width: 1px; height: 12px; background: var(--hud-edge-hi); }
#alg-res .dim { color: var(--hud-dim); letter-spacing: 0.06em; }
#alg-res b { color: var(--hud-text); font-weight: 600; }
#alg-res .enemy b { color: var(--hud-red); }
#alg-res .flash { color: var(--hud-brass); font-weight: 600; opacity: 0; transition: opacity 0.4s; }
#alg-res .flash.on { opacity: 1; transition: none; }
`;

export function createResourceHud({ mount = document.body, troops = null } = {}) {
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
  const root = document.createElement("div");
  root.id = "alg-res";
  root.innerHTML = `
    <div class="row">
    <span class="res mp" title="Effectifs (manpower): from Algiers all the time, less the upkeep of your army in the field. Buys and reinforces the squads."><span class="ric">${iconSvg("mp", { size: 15 })}</span><span class="amount hud-num" data-r="mp">0</span><span class="inc" data-i="mp"></span></span>
    <span class="res fuel" title="Carburant: from the villages and fuel points you hold, linked to the post. Vehicles, the Alouette, the tiers."><span class="ric">${iconSvg("fuel", { size: 15 })}</span><span class="amount hud-num" data-r="fuel">0</span><span class="inc" data-i="fuel"></span></span>
    <span class="res mun" title="Munitions: from the villages and munition points you hold, linked to the post. Grenades, the Légion."><span class="ric">${iconSvg("mun", { size: 15 })}</span><span class="amount hud-num" data-r="mun">0</span><span class="inc" data-i="mun"></span></span>
    </div>
    <div class="row row2">
    <span class="dim" id="alg-res-villages"></span>
    <span class="sep"></span>
    <span class="dim" id="alg-res-troops"></span>
    <span class="flash" id="alg-res-flash"></span>
    </div>
  `;
  mount.appendChild(root);
  const KEYS = ["mp", "fuel", "mun"];
  const elAmt = Object.fromEntries(KEYS.map((k) => [k, root.querySelector(`[data-r="${k}"]`)]));
  const elInc = Object.fromEntries(KEYS.map((k) => [k, root.querySelector(`[data-i="${k}"]`)]));
  const elVillages = root.querySelector("#alg-res-villages");
  const elFlash = root.querySelector("#alg-res-flash");
  const elTroops = root.querySelector("#alg-res-troops");
  let last = "", flashT = 0;

  /** Each frame; touches the DOM only when something shown has changed. */
  function update(economy) {
    const f = economy.french;
    const inc = economy.incomeOf("player");
    const held = economy.held, total = economy.points.length, theirs = economy.heldByEnemy, cut = economy.cutOff;
    const men = troops?.() ?? null;
    const key = `${KEYS.map((k) => Math.floor(f[k]) + "/" + Math.round(inc[k])).join("|")}|${held}|${theirs}|${cut}|${men}`;
    if (key === last) return;
    last = key;
    for (const k of KEYS) {
      elAmt[k].textContent = Math.floor(f[k]).toLocaleString();
      elInc[k].textContent = `+${Math.round(inc[k])}`;
    }
    elVillages.innerHTML = `villages <b class="hud-num">${held}</b>/${total}`
      + (theirs ? ` <span class="enemy">· ALN <b class="hud-num">${theirs}</b></span>` : "")
      + (cut ? ` <span class="cut" title="Points you hold that are cut off from the post: no supply line, they pay nothing.">· ${cut} coupé${cut > 1 ? "s" : ""}</span>` : "");
    if (men != null) elTroops.innerHTML = `troupes <b class="hud-num">${men}</b>`;
  }

  /** A moment's notice beside the numbers (a convoy's delivery: "+30 · convoi"). */
  function flash(text) {
    elFlash.textContent = text;
    elFlash.classList.add("on");
    clearTimeout(flashT);
    flashT = setTimeout(() => elFlash.classList.remove("on"), 2600);
  }

  return { root, update, flash, dispose() { clearTimeout(flashT); root.remove(); style.remove(); } };
}
