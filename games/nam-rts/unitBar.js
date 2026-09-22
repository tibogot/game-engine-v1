// Selection panel — GAME UI (player-facing). The HUD bar's centre slot
// (hudBar.js). One unit: a large portrait, its name and a live health bar.
// Several: the selection grouped by type, each a 3D-baked thumbnail tile with
// a count (click: only that type · double-click: every one on the map).
// Nothing: a quiet NO SELECTION, so the bar never changes shape.
export function createUnitBar({ thumbnails, onPickGroup = () => {}, onSelectAllType = () => {}, mount = document.body }) {
  const root = document.createElement("div");
  root.id = "rts-unit-bar";
  mount.appendChild(root);

  let current = []; // the selection currently shown
  let single = null; // the unit whose health bar tick() keeps live
  let lastHp = -1;

  const style = document.createElement("style");
  style.textContent = `
    #rts-unit-bar { height: 100%; }
    #rts-unit-bar .tiles { display: flex; flex-wrap: wrap; gap: 6px; align-content: flex-start; }
    #rts-unit-bar .tile {
      position: relative; width: 70px; height: 70px; cursor: pointer;
      background: #1b1e17 center/88% no-repeat;
      border: 1px solid #454c3a; border-radius: var(--hud-radius);
    }
    #rts-unit-bar .tile:hover { border-color: var(--hud-brass); }
    #rts-unit-bar .tile .name {
      position: absolute; left: 0; right: 0; bottom: 0; padding: 2px 3px;
      font-size: 9px; letter-spacing: 0.06em; text-transform: uppercase; text-align: center;
      color: var(--hud-text); background: rgba(10, 11, 8, 0.72);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    #rts-unit-bar .tile .count {
      position: absolute; top: 3px; right: 3px; min-width: 16px; padding: 1px 3px;
      background: rgba(10, 11, 8, 0.85); border: 1px solid var(--hud-brass);
      color: var(--hud-brass); font: 700 10px var(--hud-mono); text-align: center;
    }
    #rts-unit-bar .one { display: flex; gap: 14px; height: 100%; align-items: center; }
    #rts-unit-bar .one .portrait {
      width: 104px; height: 104px; flex: none;
      background: #1b1e17 center/90% no-repeat;
      border: 1px solid #454c3a; border-radius: var(--hud-radius);
    }
    #rts-unit-bar .one .portrait { display: flex; align-items: center; justify-content: center; }
    #rts-unit-bar .one .mono { font: 700 32px var(--hud-sans); letter-spacing: 0.08em; color: #4a4d3c; }
    #rts-unit-bar .one .who { font-size: 15px; font-weight: 600; letter-spacing: 0.04em; }
    #rts-unit-bar .one .kind { margin: 3px 0 12px; }
    #rts-unit-bar .one .hp { width: 170px; }   /* fits the 330 px selection slot */
    #rts-unit-bar .one .hp-bar { height: 5px; background: #23261d; border: 1px solid #3a4031; }
    #rts-unit-bar .one .hp-bar i { display: block; height: 100%; background: var(--hud-olive); }
    #rts-unit-bar .one .hp-bar i.low { background: var(--hud-red); }
    #rts-unit-bar .one .hp-num { margin-top: 4px; font-size: 11px; color: var(--hud-dim); }
  `;
  document.head.appendChild(style);

  function renderOne(u) {
    single = u;
    lastHp = -1;   // a new unit: write its bar even if its HP equals the last one's
    const url = u.isStructure ? null : thumbnails?.get(u.typeKey);
    // Buildings have no baked thumbnail: a stencilled monogram stands in.
    const mono = (u.name ?? u.typeKey).split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
    root.innerHTML = `
      <div class="one">
        <div class="portrait" style="${url ? `background-image:url(${url})` : ""}">${url ? "" : `<span class="mono">${mono}</span>`}</div>
        <div>
          <div class="who">${u.name ?? u.typeKey}</div>
          <div class="kind hud-label">${u.isStructure ? (u.team === "player" ? "Structure" : "Enemy structure") : `${u.isAir ? "Air" : "Ground"} unit`}</div>
          <div class="hp">
            <div class="hp-bar"><i id="ub-hp"></i></div>
            <div class="hp-num hud-num" id="ub-hp-num"></div>
          </div>
        </div>
      </div>`;
    tick();
  }

  /** Render the current selection (array of unit objects). */
  function render(selected) {
    current = selected;
    single = null;
    if (!selected.length) { root.innerHTML = `<div class="empty">No selection</div>`; return; }
    if (selected.length === 1) { renderOne(selected[0]); return; }

    // Group by unit type, keep one representative for name/thumbnail.
    const groups = new Map();
    for (const u of selected) {
      const g = groups.get(u.typeKey) ?? { unit: u, count: 0 };
      g.count++;
      groups.set(u.typeKey, g);
    }
    const tiles = document.createElement("div");
    tiles.className = "tiles";
    for (const [key, g] of groups) {
      const tile = document.createElement("div");
      tile.className = "tile";
      const url = thumbnails?.get(key);
      if (url) tile.style.backgroundImage = `url(${url})`;
      tile.innerHTML =
        `<span class="name">${g.unit.name ?? key}</span>` +
        (g.count > 1 ? `<span class="count">${g.count}</span>` : "");
      tile.title = "Click: only this type · Double-click: all of this type";
      tile.addEventListener("click", () => onPickGroup(current.filter((u) => u.typeKey === key)));
      tile.addEventListener("dblclick", () => onSelectAllType(key));
      tiles.appendChild(tile);
    }
    root.replaceChildren(tiles);
  }

  /** Keep a single unit's health live (called each frame; writes only on change). */
  function tick() {
    if (!single) return;
    const hp = Math.max(0, Math.ceil(single.hp ?? 0)), max = single.maxHp ?? 1;
    if (hp === lastHp) return;
    lastHp = hp;
    const bar = root.querySelector("#ub-hp"), num = root.querySelector("#ub-hp-num");
    if (!bar) return;
    const f = Math.max(0, Math.min(1, hp / max));
    bar.style.width = `${(f * 100).toFixed(0)}%`;
    bar.classList.toggle("low", f < 0.3);
    num.textContent = `${hp} / ${Math.round(max)}`;
  }

  render([]);

  return {
    root,
    render,
    tick,
    dispose() { root.remove(); style.remove(); },
  };
}
