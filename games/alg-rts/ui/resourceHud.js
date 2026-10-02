// THE SUPPLY STRIP — the HUD bar's status strip (hudBar.js): the French
// supplies, their income a minute, and the villages — how many are yours, how
// many the ALN's. This game's own (nam's shows its requisition points).
const CSS = `
/* TOP RIGHT (2026-10-02, CoH): the numbers off the command card's back. */
#alg-res {
  position: fixed; top: 8px; right: calc(var(--alg-dev-w, 340px) + 8px); z-index: 56;
  display: flex; align-items: center; gap: 12px; font-size: 11px; white-space: nowrap;
  padding: 5px 12px; background: var(--hud-bg); border: 1px solid var(--hud-edge-hi); border-radius: var(--hud-radius);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35); font-family: var(--hud-sans); color: var(--hud-text);
}
#alg-res .amount { font-weight: 700; font-size: 14px; color: var(--hud-brass); min-width: 44px; text-align: right; }
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
    <span class="hud-label">Ravitaillement</span>
    <span class="amount hud-num" id="alg-res-amount">0</span>
    <span class="sep"></span>
    <span class="dim" id="alg-res-income"></span>
    <span class="sep"></span>
    <span class="dim" id="alg-res-villages"></span>
    <span class="sep"></span>
    <span class="dim" id="alg-res-troops"></span>
    <span class="flash" id="alg-res-flash"></span>
  `;
  mount.appendChild(root);
  const elAmount = root.querySelector("#alg-res-amount");
  const elIncome = root.querySelector("#alg-res-income");
  const elVillages = root.querySelector("#alg-res-villages");
  const elFlash = root.querySelector("#alg-res-flash");
  const elTroops = root.querySelector("#alg-res-troops");
  let last = "", flashT = 0;

  /** Each frame; touches the DOM only when something shown has changed. */
  function update(economy) {
    const amount = Math.floor(economy.french.stock);
    const inc = economy.incomePerMinute("player");
    const held = economy.held, total = economy.points.length, theirs = economy.heldByEnemy;
    const men = troops?.() ?? null;
    const key = `${amount}|${inc}|${held}|${theirs}|${men}`;
    if (key === last) return;
    last = key;
    elAmount.textContent = amount.toLocaleString();
    elIncome.innerHTML = `+<b class="hud-num">${inc}</b>/min`;
    elVillages.innerHTML = `villages <b class="hud-num">${held}</b>/${total}`
      + (theirs ? ` <span class="enemy">· ALN <b class="hud-num">${theirs}</b></span>` : "");
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
