// Resource HUD — player-facing. Lives in the HUD bar's status strip (hudBar.js):
// current supplies, how many harvesters are running, and how much is left on
// the map. It was a floating pill at the top of the screen; the top of the
// screen now stays clear.
//
// The "nodes left" readout is the one that matters strategically: finite nodes
// mean the map itself is a clock, and you should be able to see it running down.
const CSS = `
#res-hud { display: flex; align-items: center; gap: 12px; font-size: 11px; white-space: nowrap; }
#res-hud .amount { font-weight: 700; font-size: 14px; color: var(--hud-brass); min-width: 44px; text-align: right; }
#res-hud .sep { width: 1px; height: 12px; background: var(--hud-edge-hi); }
#res-hud .harv b, #res-hud .nodes b { color: var(--hud-text); font-weight: 600; }
#res-hud .harv, #res-hud .nodes { color: var(--hud-dim); letter-spacing: 0.06em; }
#res-hud .harv.none { color: var(--hud-red); }
#res-hud .nodes.low b { color: #e09a5a; }
#res-hud .nodes.out { color: var(--hud-red); font-weight: 600; }
`;

export function createResourceHud({ mount = document.body } = {}) {
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);

  const root = document.createElement("div");
  root.id = "res-hud";
  root.innerHTML = `
    <span class="hud-label">Supplies</span>
    <span class="amount hud-num" id="res-amount">0</span>
    <span class="sep"></span>
    <span class="harv" id="res-harv"></span>
    <span class="sep"></span>
    <span class="nodes" id="res-nodes"></span>
  `;
  mount.appendChild(root);

  const elAmount = root.querySelector("#res-amount");
  const elHarv = root.querySelector("#res-harv");
  const elNodes = root.querySelector("#res-nodes");

  let lastAmount = -1, lastHarv = -1, lastNodes = -1;

  let lastPts = "";

  /**
   * Called each frame; only touches the DOM when a displayed value changes.
   * With `requisition` (the default economy) the strip reads points held and
   * income a minute instead of harvesters and nodes.
   */
  function update(resources, units, requisition = null) {
    const amount = Math.floor(resources.stock);
    if (amount !== lastAmount) {
      lastAmount = amount;
      elAmount.textContent = amount.toLocaleString();
    }

    if (requisition) {
      const held = requisition.held, total = requisition.points.length;
      const key = `${held}/${total}/${requisition.heldByEnemy}`;
      if (key !== lastPts) {
        lastPts = key;
        elHarv.innerHTML = `<b class="hud-num">${held}</b>/${total} points`;
        elHarv.classList.toggle("none", held === 0);
        elNodes.innerHTML = `+<b class="hud-num">${requisition.incomePerMinute}</b>/min`
          + (requisition.heldByEnemy ? ` · enemy <b class="hud-num">${requisition.heldByEnemy}</b>` : "");
        elNodes.classList.remove("low", "out");
      }
      return;
    }

    const harvesters = units.list.filter(
      (u) => u.alive && u.typeKey === "harvester" && u.team === "player",
    ).length;
    if (harvesters !== lastHarv) {
      lastHarv = harvesters;
      elHarv.innerHTML = `<b class="hud-num">${harvesters}</b> harvester${harvesters === 1 ? "" : "s"}`;
      elHarv.classList.toggle("none", harvesters === 0);
    }

    const live = resources.liveNodes;
    if (live !== lastNodes) {
      lastNodes = live;
      elNodes.innerHTML = live ? `<b class="hud-num">${live}</b> node${live === 1 ? "" : "s"} left` : "map tapped out";
      elNodes.classList.toggle("low", live > 0 && live <= 2);
      elNodes.classList.toggle("out", live === 0);
    }
  }

  return {
    root,
    update,
    dispose() { root.remove(); style.remove(); },
  };
}
