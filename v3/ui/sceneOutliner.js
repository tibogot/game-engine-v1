/**
 * v3/ui/sceneOutliner.js — the Scene list (outliner) in the left panel.
 *
 * Pure DOM: the host hands it a model and callbacks, it draws groups and rows.
 *
 *   model = [{ key, label, icon, count, inTotal?, hidden?, canHide?, items: [
 *     { key, label, sub?, selected?, hidden?, canHide?, icon?, children?: { total, items(query) } }
 *   ] }]
 *
 * Click selects, double-click frames the camera on it, the eye hides or shows
 * it in the editor, right-click opens a menu of what can be done to it. The
 * search box filters every level by name; matching groups open while a search
 * is typed. Groups and prop types expand and collapse; an expanded prop type
 * lists at most MAX_ROWS props (a scene can hold tens of thousands).
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

/** Does `label` match the search `q` (already lower-cased)? Every word must appear. */
export function outlinerMatches(label, q) {
  if (!q) return true;
  const hay = String(label).toLowerCase();
  return q.split(/\s+/).every((w) => !w || hay.includes(w));
}

/**
 * @param {object} o
 * @param {HTMLElement} o.container       the #hierarchy element
 * @param {() => object[]} o.getModel
 * @param {() => string} o.signature      cheap string that changes when the model would
 * @param {(key:string) => void} o.onSelect
 * @param {(key:string) => void} o.onFrame
 * @param {(key:string) => void} o.onToggleHidden
 * @param {(key:string) => Array<{label:string, onClick:() => void, danger?:boolean, disabled?:boolean}|null>} [o.getMenu]
 */
export function createSceneOutliner({ container, getModel, signature, onSelect, onFrame, onToggleHidden, getMenu }) {
  const list = container.querySelector(".tree-list") ?? container.appendChild(Object.assign(document.createElement("div"), { className: "tree-list" }));
  const header = container.querySelector(".panel-header span");
  const expanded = new Set(["environment", "terrain", "props", "tunnels", "rivers", "lakes", "roads", "spawn"]);
  let lastSig = null;
  let lastDraw = 0;
  let pending = false;
  let query = "";

  // ── Search ────────────────────────────────────────────────────────────────
  const search = document.createElement("div");
  search.className = "outliner-search";
  const input = document.createElement("input");
  input.type = "search";
  input.placeholder = "Search the scene…";
  input.title = "Filter by name (Esc clears)";
  input.spellcheck = false;
  search.appendChild(input);
  list.before(search);
  input.addEventListener("input", () => {
    query = input.value.trim().toLowerCase();
    lastSig = null;
    update(true);
  });
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();   // typing a name must not trigger editor shortcuts
    if (e.key === "Escape") { input.value = ""; input.dispatchEvent(new Event("input")); input.blur(); }
  });

  // ── Right-click menu ──────────────────────────────────────────────────────
  let menuEl = null;
  function closeMenu() {
    menuEl?.remove();
    menuEl = null;
  }
  function openMenu(key, x, y) {
    closeMenu();
    const items = (getMenu?.(key) ?? []).filter(Boolean);
    if (!items.length) return;
    menuEl = document.createElement("div");
    menuEl.className = "outliner-menu";
    for (const it of items) {
      if (it.separator) {
        menuEl.appendChild(Object.assign(document.createElement("div"), { className: "outliner-menu-sep" }));
        continue;
      }
      const b = document.createElement("button");
      b.type = "button";
      b.className = "outliner-menu-item" + (it.danger ? " danger" : "");
      b.textContent = it.label;
      b.disabled = !!it.disabled;
      b.addEventListener("click", () => { closeMenu(); it.onClick(); lastSig = null; update(true); });
      menuEl.appendChild(b);
    }
    document.body.appendChild(menuEl);
    // Keep it on screen.
    const r = menuEl.getBoundingClientRect();
    menuEl.style.left = `${Math.min(x, window.innerWidth - r.width - 4)}px`;
    menuEl.style.top = `${Math.min(y, window.innerHeight - r.height - 4)}px`;
  }
  window.addEventListener("pointerdown", (e) => { if (menuEl && !menuEl.contains(e.target)) closeMenu(); }, true);
  window.addEventListener("keydown", (e) => { if (menuEl && e.key === "Escape") closeMenu(); });
  window.addEventListener("blur", closeMenu);
  list.addEventListener("scroll", closeMenu);

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
      if (!expandable || query) return;   // a search keeps matches open
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
    el.addEventListener("contextmenu", (e) => { e.preventDefault(); openMenu(key, e.clientX, e.clientY); });
    return el;
  }

  function draw() {
    const model = getModel();
    const frag = document.createDocumentFragment();
    let total = 0;
    let shown = 0;
    for (const g of model) {
      if (g.inTotal !== false) total += g.count ?? g.items.length;
      // With a search: keep a group if its name matches (then all of it shows)
      // or any item / child does (then only those show).
      const groupHit = outlinerMatches(g.label, query);
      const itemRows = [];
      for (const it of g.items) {
        const itemHit = groupHit || outlinerMatches(it.label, query);
        const kids = it.children && (query || expanded.has(it.key))
          ? it.children.items(itemHit ? "" : query)
          : null;
        if (!itemHit && !(kids && kids.length)) continue;
        itemRows.push({ it, kids });
      }
      if (query && !groupHit && itemRows.length === 0) continue;
      const open = query ? itemRows.length > 0 : expanded.has(g.key);
      frag.appendChild(row({
        key: g.key, label: g.label, sub: g.count != null ? String(g.count) : null, icon: g.icon, depth: 0,
        hidden: g.hidden, canHide: g.canHide, expandable: g.items.length > 0, isOpen: open,
      }));
      shown++;
      if (!open) continue;
      for (const { it, kids } of itemRows) {
        const childOpen = !!it.children && (query ? !!kids?.length : expanded.has(it.key));
        frag.appendChild(row({
          key: it.key, label: it.label, sub: it.sub, icon: it.icon, depth: 1, selected: it.selected,
          hidden: it.hidden, canHide: it.canHide, expandable: !!it.children?.total, isOpen: childOpen,
        }));
        shown++;
        if (!childOpen || !kids) continue;
        for (const k of kids.slice(0, MAX_ROWS)) {
          frag.appendChild(row({ key: k.key, label: k.label, sub: k.sub, depth: 2, selected: k.selected, hidden: k.hidden, canHide: k.canHide }));
          shown++;
        }
        const more = (query ? kids.length : it.children.total) - MAX_ROWS;
        if (more > 0) {
          const moreEl = document.createElement("div");
          moreEl.className = "tree-item outliner-more";
          moreEl.style.paddingLeft = `${6 + 2 * 14 + 14}px`;
          moreEl.textContent = `… ${more} more (${query ? "narrow the search" : "click one in the viewport"})`;
          frag.appendChild(moreEl);
        }
      }
    }
    if (query && shown === 0) {
      const none = document.createElement("div");
      none.className = "tree-item outliner-more";
      none.style.paddingLeft = "12px";
      none.textContent = `Nothing named “${input.value.trim()}”`;
      frag.appendChild(none);
    }
    list.replaceChildren(frag);
    if (header) header.textContent = `Scene (${total})`;
  }

  /** Redraw if the model changed. `force` skips the rate limit (after a click). */
  function update(force = false) {
    const sig = signature() + "|" + [...expanded].join(",") + "|" + query;
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

  return { update, expanded, get query() { return query; }, closeMenu };
}
