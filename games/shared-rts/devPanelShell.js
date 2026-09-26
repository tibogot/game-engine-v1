// DEV PANEL SHELL — the frame both RTS games' developer panels sit in: a
// fixed right-hand column that folds to a tab, sections that fold and
// remember it, and the row helpers (slider, toggle, select, button, colour,
// readout, hint). DEVELOPER UI, not player-facing.
//
// Only the frame is shared. What goes IN the panel is each game's own
// (games/alg-rts/devPanel.js) — the two games are different games, and their
// dev controls are too. nam-rts's panel (games/nam-rts/devPanel.js) predates
// this and keeps its own HTML; it is the same look because both use the v3
// editor's classes (editor.css: .inspector-section / .section-header /
// .prop-row / .prop-toggle / .action-btn), which the game must import.
//
//   const panel = createDevPanelShell({ id: "alg-dev", storageKey: "alg-rts.devPanel" });
//   const cam = panel.section("Camera", { open: true });
//   cam.slider("Pan speed", { min: 10, max: 160, step: 5, get: () => p.panSpeed, set: (v) => (p.panSpeed = v) });

const CHECK_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
const ARROW_SVG =
  '<svg class="section-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor"'
  + ' stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">'
  + '<polyline points="6 9 12 15 18 9"></polyline></svg>';

/** Open width: the editor's --right-w (300) plus room for a 4-digit readout. */
export const DEV_PANEL_W = 340;

const css = (id) => `
  #${id} {
    position: fixed; right: 0; top: 0; bottom: 0; width: ${DEV_PANEL_W}px; z-index: 200;
    background: var(--bg-panel); border-left: 1px solid var(--border);
    display: flex; flex-direction: column; overflow: hidden;
    font-family: var(--font); pointer-events: auto; box-sizing: border-box;
  }
  #${id} .dp-bar { display: flex; flex: 0 0 auto; border-bottom: 1px solid var(--border); }
  #${id} .dp-bar button {
    flex: 0 0 32px; background: none; border: none; color: var(--text-dim); cursor: pointer;
    font: 600 12px var(--font); padding: 7px 0;
  }
  #${id} .dp-bar button:hover { color: var(--text); }
  #${id} .dp-bar .dp-title { flex: 1 1 auto; text-align: left; padding-left: 12px; color: var(--text); cursor: default; }
  #${id} .dp-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; }
  #${id} .prop-row { min-width: 0; }
  #${id} .prop-label { width: 96px; min-width: 96px; flex-shrink: 0; }
  #${id} .prop-value { min-width: 0; overflow: visible; }
  #${id} .prop-num { width: auto; min-width: 48px; flex-shrink: 0; white-space: nowrap; font-variant-numeric: tabular-nums; }
  #${id} .dp-select {
    flex: 1 1 auto; min-width: 0; background: var(--bg-input, #1b1f24); color: var(--text);
    border: 1px solid var(--border); border-radius: 4px; padding: 2px 6px; font: inherit; font-size: 11px;
  }
  #${id} input[type="color"] { width: 36px; height: 22px; padding: 0; border: 1px solid var(--border); background: transparent; cursor: pointer; }
  #${id} .dp-hint { margin-top: 6px; font-size: 11px; line-height: 1.5; color: var(--text-dim); }
  #${id} .dp-hint b { color: var(--text); font-weight: 600; }
  #${id} .dp-readout { font: 11px ui-monospace, Consolas, monospace; color: var(--text); white-space: pre; margin-top: 4px; }
  #${id} .action-btn + .action-btn { margin-top: 4px; }
  #${id}.collapsed {
    top: 10px; bottom: auto; width: auto; border-left: none; border-radius: 6px 0 0 6px;
    box-shadow: 0 2px 14px rgba(0, 0, 0, 0.45);
  }
  #${id}.collapsed .dp-body, #${id}.collapsed .dp-bar button:not(.dp-fold) { display: none; }
  #${id}.collapsed .dp-bar { border-bottom: none; }
  #${id}.collapsed .dp-fold { flex: 0 0 auto; padding: 7px 12px; color: var(--text); }
`;

/**
 * @param {object} o
 * @param {string} o.id           DOM id of the panel (scopes its CSS)
 * @param {string} o.storageKey   localStorage prefix: section folds + panel fold
 * @param {string} [o.title]
 * @param {boolean} [o.startCollapsed]  folded to its tab on a fresh profile
 */
export function createDevPanelShell({ id, storageKey, title = "Dev", startCollapsed = false }) {
  const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem(`${storageKey}.${k}`)); return v ?? d; } catch { return d; } };
  const save = (k, v) => { try { localStorage.setItem(`${storageKey}.${k}`, JSON.stringify(v)); } catch { /* private mode */ } };

  const style = document.createElement("style");
  style.textContent = css(id);
  document.head.appendChild(style);

  const root = document.createElement("div");
  root.id = id;
  root.innerHTML = `
    <div class="dp-bar">
      <button class="dp-title" type="button" tabindex="-1">${title}</button>
      <button class="dp-all-open" type="button" title="Expand all sections">⊞</button>
      <button class="dp-all-shut" type="button" title="Collapse all sections">⊟</button>
      <button class="dp-fold" type="button" title="Collapse panel">»</button>
    </div>
    <div class="dp-body"></div>`;
  document.body.appendChild(root);
  const body = root.querySelector(".dp-body");
  const foldBtn = root.querySelector(".dp-fold");

  // Keys typed into the panel are not game keys (WASD, C…).
  root.addEventListener("keydown", (e) => e.stopPropagation());

  const setCollapsed = (c) => {
    root.classList.toggle("collapsed", c);
    foldBtn.textContent = c ? `« ${title}` : "»";
    foldBtn.title = c ? "Open dev controls" : "Collapse panel";
    document.documentElement.style.setProperty(`--${id}-w`, c ? "0px" : `${DEV_PANEL_W}px`);
    save("collapsed", c);
  };
  setCollapsed(load("collapsed", startCollapsed));
  foldBtn.addEventListener("click", () => setCollapsed(!root.classList.contains("collapsed")));

  const folds = load("folds", {});
  const sections = [];
  root.querySelector(".dp-all-open").addEventListener("click", () => sections.forEach((s) => s.setOpen(true, true)));
  root.querySelector(".dp-all-shut").addEventListener("click", () => sections.forEach((s) => s.setOpen(false, true)));

  /** Every control, so refresh() can re-read values changed elsewhere. */
  const refreshers = [];

  function row(label, valueHtml) {
    const r = document.createElement("div");
    r.className = "prop-row";
    r.innerHTML = `<span class="prop-label">${label}</span><div class="prop-value">${valueHtml}</div>`;
    return r;
  }

  function section(name, { open = false } = {}) {
    const sec = document.createElement("div");
    sec.className = "inspector-section";
    sec.innerHTML = `<div class="section-header" data-toggle="">${ARROW_SVG}${name}</div><div class="section-body"></div>`;
    body.appendChild(sec);
    const hdr = sec.firstElementChild, el = sec.lastElementChild;
    const setOpen = (o, persist = false) => {
      hdr.classList.toggle("collapsed", !o);
      el.classList.toggle("hidden", !o);
      if (persist) { folds[name] = o; save("folds", folds); }
    };
    setOpen(folds[name] ?? open);
    hdr.addEventListener("click", () => setOpen(hdr.classList.contains("collapsed"), true));
    sections.push({ setOpen });

    const add = (node) => (el.appendChild(node), node);
    const api = {
      el,
      /**
       * A range with a readout. `live: false` applies on release only (for
       * setters that rebuild something).
       */
      slider(label, { min, max, step = 0.01, get, set, fmt, live = true }) {
        const r = add(row(label, `<input type="range" min="${min}" max="${max}" step="${step}"><span class="prop-num"></span>`));
        const inp = r.querySelector("input"), num = r.querySelector(".prop-num");
        const dp = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
        // Rounded to the step first: a value converted on the way in (radians
        // shown as degrees) comes back 29.9999…
        const show = (v) => { v = Number((Math.round(v / step) * step).toFixed(dp)); num.textContent = fmt ? fmt(v) : v.toFixed(dp); };
        const read = () => { const v = get(); inp.value = v; show(v); };
        inp.addEventListener("input", () => { const v = Number(inp.value); show(v); if (live) set(v); });
        inp.addEventListener("change", () => { if (!live) set(Number(inp.value)); });
        read(); refreshers.push(read);
        return api;
      },
      toggle(label, { get, set }) {
        const r = add(row(label, `<button class="prop-toggle" type="button" aria-label="${label}">${CHECK_SVG}</button>`));
        const b = r.querySelector("button");
        const read = () => b.classList.toggle("checked", !!get());
        b.addEventListener("click", () => { set(!b.classList.contains("checked")); read(); });
        read(); refreshers.push(read);
        return api;
      },
      select(label, { options, get, set }) {
        const r = add(row(label, `<select class="dp-select">${options.map((o) => {
          const [v, t] = Array.isArray(o) ? o : [o, o];
          return `<option value="${v}">${t}</option>`;
        }).join("")}</select>`));
        const s = r.querySelector("select");
        const read = () => { const v = get?.(); if (v != null) s.value = v; };
        s.addEventListener("change", () => set(s.value));
        read(); refreshers.push(read);
        return api;
      },
      color(label, { get, set }) {
        const r = add(row(label, `<input type="color">`));
        const c = r.querySelector("input");
        const read = () => (c.value = get());
        c.addEventListener("input", () => set(c.value));
        read(); refreshers.push(read);
        return api;
      },
      button(label, onClick, { primary = false } = {}) {
        const b = document.createElement("button");
        b.className = `action-btn${primary ? " primary" : ""}`;
        b.type = "button";
        b.textContent = label;
        b.addEventListener("click", () => onClick(b));
        add(b);
        return api;
      },
      hint(html) {
        const d = document.createElement("div");
        d.className = "dp-hint";
        d.innerHTML = html;
        add(d);
        return api;
      },
      /** A monospace block to write into: `readout().set(text)`. */
      readout() {
        const d = add(document.createElement("div"));
        d.className = "dp-readout";
        return { set: (t) => (d.textContent = t) };
      },
    };
    return api;
  }

  return {
    root,
    section,
    setCollapsed,
    /** Re-read every control's value (after something else changed them). */
    refresh() { for (const f of refreshers) f(); },
    dispose() { root.remove(); style.remove(); },
  };
}
