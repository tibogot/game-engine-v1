// Control groups — GAME UI. Your ask (2026-09-25): "don't you think it's time
// to be able to make some groups?"
//
//   Ctrl + 1..9      make the selection group N (replaces it)
//   Shift + 1..9     add the selection to group N
//   1..9             select group N
//   1..9 twice fast  select it AND centre the camera on it
//
// Keys by PHYSICAL position (e.code "Digit1".."Digit9", and the numpad), not by
// the character: on an AZERTY keyboard the number row types & é " ' ( - è _ ç
// without Shift, and the group keys must be the same keys on every layout.
//
// The groups also show as chips above the command panel — number and head
// count — and a chip click recalls it, like the key. Dead units drop out of
// their groups on their own; a group that empties disappears.
const GROUPS = 9;
const DOUBLE_TAP_MS = 350;

export function createControlGroups({ app, selection, mount }) {
  const groups = Array.from({ length: GROUPS + 1 }, () => []);   // [1..9]
  let lastTap = { n: 0, t: 0 };

  const style = document.createElement("style");
  style.textContent = `
    #nam-groups { position: absolute; right: 8px; bottom: 100%; margin-bottom: 38px;
      display: flex; gap: 4px; pointer-events: auto; }
    #nam-groups .g { cursor: pointer; min-width: 34px; padding: 3px 6px; text-align: center;
      background: var(--hud-bg, #1a1c16); border: 1px solid #454c3a; border-radius: 3px;
      font: 700 11px var(--hud-mono, monospace); color: var(--hud-text, #ddd); }
    #nam-groups .g b { color: var(--hud-brass, #c9a55a); margin-right: 4px; }
    #nam-groups .g:hover, #nam-groups .g.on { border-color: var(--hud-brass, #c9a55a); }
  `;
  document.head.appendChild(style);
  const bar = document.createElement("div");
  bar.id = "nam-groups";
  mount?.appendChild(bar);

  const alive = (n) => (groups[n] = groups[n].filter((u) => u.alive));

  function render() {
    const sel = new Set(selection.selected);
    bar.innerHTML = "";
    for (let n = 1; n <= GROUPS; n++) {
      const g = alive(n);
      if (!g.length) continue;
      const chip = document.createElement("div");
      chip.className = "g" + (g.length === sel.size && g.every((u) => sel.has(u)) ? " on" : "");
      chip.innerHTML = `<b>${n}</b>${g.length}`;
      chip.title = `Group ${n} — press ${n} (twice to centre the camera); Ctrl+${n} to reassign`;
      chip.addEventListener("click", () => recall(n, performance.now()));
      bar.appendChild(chip);
    }
  }

  function centreOn(units) {
    let x = 0, z = 0;
    for (const u of units) { x += u.position.x; z += u.position.z; }
    app.rtsCamera?.focusOn?.(x / units.length, z / units.length);
  }

  function recall(n, now) {
    const g = alive(n);
    if (!g.length) return;
    selection.select(g);
    if (lastTap.n === n && now - lastTap.t < DOUBLE_TAP_MS) centreOn(g);
    lastTap = { n, t: now };
    render();
  }

  const digitOf = (e) => {
    const m = /^(?:Digit|Numpad)([1-9])$/.exec(e.code);
    return m ? Number(m[1]) : 0;
  };

  function onKey(e) {
    // Never while typing in a field (dev panel inputs, a future chat box).
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    const n = digitOf(e);
    if (!n) return;
    const sel = selection.selected.filter((u) => u.alive && !u.isStructure);
    if (e.ctrlKey || e.metaKey) {
      // Make the group. preventDefault: Ctrl+1..9 is the browser's tab switch.
      e.preventDefault();
      groups[n] = sel;
      render();
    } else if (e.shiftKey) {
      e.preventDefault();
      groups[n] = [...new Set([...alive(n), ...sel])];
      render();
    } else if (!e.altKey) {
      recall(n, performance.now());
    }
  }
  window.addEventListener("keydown", onKey);

  return {
    groups,
    /** Call when the selection changes, so the chip of the group shown lights up. */
    render,
    dispose() { window.removeEventListener("keydown", onKey); bar.remove(); style.remove(); },
  };
}
