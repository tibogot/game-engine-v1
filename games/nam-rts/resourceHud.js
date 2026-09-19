// Resource HUD — player-facing. Top-LEFT (the wave HUD owns top-centre): current
// supplies, how many harvesters are running, and how much is left on the map.
//
// The "nodes left" readout is the one that matters strategically: finite nodes
// mean the map itself is a clock, and you should be able to see it running down.
const CSS = `
#res-hud {
  position: fixed; top: 10px; left: 50%; transform: translateX(-50%) translateY(38px);
  z-index: 50; pointer-events: none;
  display: flex; align-items: center; gap: 12px;
  padding: 6px 14px; border-radius: 999px;
  background: rgba(12,16,20,0.82); border: 1px solid #2a343c;
  color: #dfe6ea; font: 13px/1 system-ui, sans-serif;
  font-variant-numeric: tabular-nums;
}
#res-hud .amount { font-weight: 700; font-size: 15px; color: #f0c86a; min-width: 52px; text-align: right; }
#res-hud .label { color: #8d9aa4; letter-spacing: .06em; text-transform: uppercase; font-size: 11px; }
#res-hud .sep { width: 1px; height: 15px; background: #2f3b45; }
#res-hud .harv { color: #cfd8de; }
#res-hud .harv b { color: #fff; }
#res-hud .harv.none { color: #ff9a6a; }
#res-hud .nodes { color: #9fb0bd; }
#res-hud .nodes b { color: #dfe6ea; }
#res-hud .nodes.low b { color: #ff8a7a; }
#res-hud .nodes.out { color: #ff6a5a; font-weight: 600; }
`;

export function createResourceHud() {
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);

  const root = document.createElement("div");
  root.id = "res-hud";
  root.innerHTML = `
    <span class="label">Supplies</span>
    <span class="amount" id="res-amount">0</span>
    <span class="sep"></span>
    <span class="harv" id="res-harv"></span>
    <span class="sep"></span>
    <span class="nodes" id="res-nodes"></span>
  `;
  document.body.appendChild(root);

  const elAmount = root.querySelector("#res-amount");
  const elHarv = root.querySelector("#res-harv");
  const elNodes = root.querySelector("#res-nodes");

  let lastAmount = -1, lastHarv = -1, lastNodes = -1;

  /** Called each frame; only touches the DOM when a displayed value changes. */
  function update(resources, units) {
    const amount = Math.floor(resources.stock);
    if (amount !== lastAmount) {
      lastAmount = amount;
      elAmount.textContent = amount.toLocaleString();
    }

    const harvesters = units.list.filter(
      (u) => u.alive && u.typeKey === "harvester" && u.team === "player",
    ).length;
    if (harvesters !== lastHarv) {
      lastHarv = harvesters;
      elHarv.innerHTML = `<b>${harvesters}</b> harvester${harvesters === 1 ? "" : "s"}`;
      elHarv.classList.toggle("none", harvesters === 0);
    }

    const live = resources.liveNodes;
    if (live !== lastNodes) {
      lastNodes = live;
      elNodes.innerHTML = live ? `<b>${live}</b> node${live === 1 ? "" : "s"} left` : "map tapped out";
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
