// Selected-units bar — GAME UI (player-facing). Bottom-center panel that shows
// the current selection grouped by type, each as a 3D-baked thumbnail tile with
// a count badge (rts-chibs style). Hidden when nothing is selected.
export function createUnitBar({ thumbnails, onPickGroup = () => {}, onSelectAllType = () => {} }) {
  const root = document.createElement("div");
  root.id = "rts-unit-bar";
  document.body.appendChild(root);

  let current = []; // the selection currently shown

  const style = document.createElement("style");
  style.textContent = `
    #rts-unit-bar {
      position: fixed; left: 50%; bottom: 12px; transform: translateX(-50%);
      z-index: 55; display: none; gap: 8px; padding: 8px 10px;
      background: rgba(16,18,22,0.72); border: 1px solid rgba(255,255,255,0.1);
      border-radius: 10px; backdrop-filter: blur(6px);
    }
    #rts-unit-bar.show { display: flex; }
    #rts-unit-bar .tile {
      position: relative; width: 96px; height: 96px; border-radius: 8px; cursor: pointer;
      background: #11151c center/90% no-repeat; border: 1px solid rgba(255,255,255,0.14);
      display: flex; align-items: flex-end; justify-content: flex-start;
      transition: border-color 0.12s, transform 0.12s;
    }
    #rts-unit-bar .tile:hover { border-color: #6ab0ff; transform: translateY(-2px); }
    #rts-unit-bar .tile .name {
      position: absolute; left: 0; right: 0; bottom: 0; padding: 2px 4px;
      font: 10px system-ui, sans-serif; color: #dfe6ee; text-align: center;
      background: linear-gradient(transparent, rgba(0,0,0,0.6)); border-radius: 0 0 8px 8px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    #rts-unit-bar .tile .count {
      position: absolute; top: -6px; right: -6px; min-width: 18px; height: 18px;
      padding: 0 4px; border-radius: 9px; background: #2a6df0; color: #fff;
      font: 700 11px system-ui, sans-serif; display: flex; align-items: center; justify-content: center;
    }
  `;
  document.head.appendChild(style);

  /** Render tiles for the current selection (array of unit objects). */
  function render(selected) {
    current = selected;
    root.innerHTML = "";
    if (!selected.length) { root.classList.remove("show"); return; }

    // Group by unit type, keep one representative for name/thumbnail.
    const groups = new Map();
    for (const u of selected) {
      const g = groups.get(u.typeKey) ?? { unit: u, count: 0 };
      g.count++;
      groups.set(u.typeKey, g);
    }

    for (const [key, g] of groups) {
      const tile = document.createElement("div");
      tile.className = "tile";
      const url = thumbnails?.get(key);
      if (url) tile.style.backgroundImage = `url(${url})`;
      tile.innerHTML =
        `<span class="name">${g.unit.name ?? key}</span>` +
        (g.count > 1 ? `<span class="count">${g.count}</span>` : "");
      // Click → select just that type from the current selection.
      // Double-click → select every unit of that type on the whole map.
      tile.title = "Click: only this type · Double-click: all of this type";
      tile.addEventListener("click", () => onPickGroup(current.filter((u) => u.typeKey === key)));
      tile.addEventListener("dblclick", () => onSelectAllType(key));
      root.appendChild(tile);
    }
    root.classList.add("show");
  }

  return {
    root,
    render,
    dispose() { root.remove(); style.remove(); },
  };
}
