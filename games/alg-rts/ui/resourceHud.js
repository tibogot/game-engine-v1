// THE SUPPLY STRIP — the HUD bar's status strip (hudBar.js): the French
// supplies, their income a minute, and the villages — how many are yours, how
// many the ALN's. This game's own (nam's shows its requisition points).
const CSS = `
#alg-res { display: flex; align-items: center; gap: 12px; font-size: 11px; white-space: nowrap; }
#alg-res .amount { font-weight: 700; font-size: 14px; color: var(--hud-brass); min-width: 44px; text-align: right; }
#alg-res .sep { width: 1px; height: 12px; background: var(--hud-edge-hi); }
#alg-res .dim { color: var(--hud-dim); letter-spacing: 0.06em; }
#alg-res b { color: var(--hud-text); font-weight: 600; }
#alg-res .enemy b { color: var(--hud-red); }
`;

export function createResourceHud({ mount = document.body } = {}) {
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
  `;
  mount.appendChild(root);
  const elAmount = root.querySelector("#alg-res-amount");
  const elIncome = root.querySelector("#alg-res-income");
  const elVillages = root.querySelector("#alg-res-villages");
  let last = "";

  /** Each frame; touches the DOM only when something shown has changed. */
  function update(economy) {
    const amount = Math.floor(economy.french.stock);
    const inc = economy.incomePerMinute("player");
    const held = economy.held, total = economy.points.length, theirs = economy.heldByEnemy;
    const key = `${amount}|${inc}|${held}|${theirs}`;
    if (key === last) return;
    last = key;
    elAmount.textContent = amount.toLocaleString();
    elIncome.innerHTML = `+<b class="hud-num">${inc}</b>/min`;
    elVillages.innerHTML = `villages <b class="hud-num">${held}</b>/${total}`
      + (theirs ? ` <span class="enemy">· ALN <b class="hud-num">${theirs}</b></span>` : "");
  }

  return { root, update, dispose() { root.remove(); style.remove(); } };
}
