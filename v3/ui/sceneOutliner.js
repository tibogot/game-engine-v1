/**
 * v3/ui/sceneOutliner.js — the Scene list (outliner) in the left panel.
 *
 * Pure DOM: the host hands it a model and callbacks, it draws groups and rows.
 *
 *   model = [{ key, label, icon, count, inTotal?, hidden?, canHide?, items: [
 *     { key, label, sub?, selected?, hidden?, canHide?, icon?, children?: { total, items } }
 *   ] }]
 *
 * Click selects, double-click frames the camera on it, the eye hides or shows
 * it in the editor. Groups and prop types expand and collapse; an expanded
 * prop type lists at most MAX_ROWS props (a scene can hold tens of thousands).
 *
 * The host calls update() as often as it likes: the list redraws only when the
 * model's signature changes, and at most a few times a second.
 */

const MAX_ROWS = 200;
const MIN_REDRAW_MS = 200;

const SVG = {
  chevron: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>',
  eye: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  eyeOff: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.9 4.2A10.4 10.4 0 0 1 12 4c6.5 0 10 8 10 8a17 17 0 0 1-2.1 3.1M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><line x1="2" y1="2" x2="22" y2="22"/></svg>',
};

function _icon(name) {
  const L = typeof lucide !== "undefined" ? lucide : null;
  const pascal = name.split("-").map((p) => p[0].toUpperCase() + p.slice(1)).join("");
  const node = L?.icons?.[pascal] && L.createElement ? L.createElement(L.icons[pascal]) : null;
  if (node) {
    node.setAttribute("width", "14");
    node.setAttribute("height", "14");
    node.classList.add("outliner-icon");
    return node;
  }
  const dot = document.createElement("span");
  dot.className = "outliner-icon outliner-dot";
  return dot;
}

/**
 * @param {object} o
 * @param {HTMLElement} o.container       the #hierarchy element
 * @param {() => object[]} o.getModel
 * @param {() => string} o.signature      cheap string that changes when the model would
 * @param {(key:string) => void} o.onSelect
 * @param {(key:string) => void} o.onFrame
 * @param {(key:string) => void} o.onToggleHidden
 */
export function createSceneOutliner({ container, getModel, signature, onSelect, onFrame, onToggleHidden }) {
  const list = container.querySelector(".tree-list") ?? container.appendChild(Object.assign(document.createElement("div"), { className: "tree-list" }));
  const header = container.querySelector(".panel-header span");
  const expanded = new Set(["environment", "terrain", "props", "tunnels", "rivers", "lakes", "roads", "spawn"]);
  let lastSig = null;
  let lastDraw = 0;
  let pending = false;

  function row({ key, label, sub, icon, depth, selected, hidden, canHide, expandable, isOpen }) {
    const el = document.createElement("div");
    el.className = "tree-item outliner-row" + (selected ? " selected" : "") + (hidden ? " is-hidden" : "");
    el.style.paddingLeft = `${6 + depth * 14}px`;
    el.dataset.key = key;

    const chev = document.createElement("span");
    chev.className = "outliner-chevron" + (expandable ? "" : " empty") + (isOpen ? " open" : "");
    if (expandable) chev.innerHTML = SVG.chevron;
    chev.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!expandable) return;
      if (expanded.has(key)) expanded.delete(key); else expanded.add(key);
      lastSig = null;
      update(true);
    });
    el.appendChild(chev);
    if (icon) el.appendChild(_icon(icon));

    const text = document.createElement("span");
    text.className = "outliner-label";
    text.textContent = label;
    el.appendChild(text);
    if (sub != null) {
      const s = document.createElement("span");
      s.className = "tree-type";
      s.textContent = sub;
      el.appendChild(s);
    }
    if (canHide) {
      const eye = document.createElement("button");
      eye.type = "button";
      eye.className = "outliner-eye";
      eye.title = hidden ? "Show in the editor" : "Hide in the editor";
      eye.innerHTML = hidden ? SVG.eyeOff : SVG.eye;
      eye.addEventListener("click", (e) => { e.stopPropagation(); onToggleHidden(key); lastSig = null; update(true); });
      el.appendChild(eye);
    }
    el.addEventListener("click", () => { onSelect(key); lastSig = null; update(true); });
    el.addEventListener("dblclick", () => onFrame(key));
    return el;
  }

  function draw() {
    const model = getModel();
    const frag = document.createDocumentFragment();
    let total = 0;
    for (const g of model) {
      if (g.inTotal !== false) total += g.count ?? g.items.length;
      const open = expanded.has(g.key);
      frag.appendChild(row({
        key: g.key, label: g.label, sub: g.count != null ? String(g.count) : null, icon: g.icon, depth: 0,
        hidden: g.hidden, canHide: g.canHide, expandable: g.items.length > 0, isOpen: open,
      }));
      if (!open) continue;
      for (const it of g.items) {
        const childOpen = !!it.children && expanded.has(it.key);
        frag.appendChild(row({
          key: it.key, label: it.label, sub: it.sub, icon: it.icon, depth: 1, selected: it.selected,
          hidden: it.hidden, canHide: it.canHide, expandable: !!it.children?.total, isOpen: childOpen,
        }));
        if (!childOpen) continue;
        const kids = it.children.items();
        for (const k of kids.slice(0, MAX_ROWS)) {
          frag.appendChild(row({ key: k.key, label: k.label, sub: k.sub, depth: 2, selected: k.selected, hidden: k.hidden, canHide: k.canHide }));
        }
        if (it.children.total > MAX_ROWS) {
          const more = document.createElement("div");
          more.className = "tree-item outliner-more";
          more.style.paddingLeft = `${6 + 2 * 14 + 14}px`;
          more.textContent = `… ${it.children.total - MAX_ROWS} more (click one in the viewport)`;
          frag.appendChild(more);
        }
      }
    }
    list.replaceChildren(frag);
    if (header) header.textContent = `Scene (${total})`;
  }

  /** Redraw if the model changed. `force` skips the rate limit (after a click). */
  function update(force = false) {
    const sig = signature() + "|" + [...expanded].join(",");
    if (sig === lastSig) return;
    const now = performance.now();
    if (!force && now - lastDraw < MIN_REDRAW_MS) {
      if (!pending) { pending = true; setTimeout(() => { pending = false; update(); }, MIN_REDRAW_MS); }
      return;
    }
    lastSig = sig;
    lastDraw = now;
    draw();
  }

  return { update, expanded };
}
