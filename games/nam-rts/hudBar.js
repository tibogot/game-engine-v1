// HUD — player-facing. Two blocks at the bottom corners, Company of Heroes
// style, the middle of the bottom edge left to the battlefield:
//
//   ┌─────────┐                              ┌ supplies · harvesters · nodes ┐
//   │ minimap │                              │ selection  │  command card    │
//   └─────────┘                              └────────────┴──────────────────┘
//
// (A full-width bar was tried first and took too much of the screen.) The top
// of the screen stays EMPTY: nothing floats over the battlefield but alerts
// that come and go. The modules (minimap, unitBar, commandCard, resourceHud)
// keep their logic and render into the slots this creates.
//
// LOOK — field equipment, not a phone app: dark olive-black panels with a
// thin lighter edge, corners of 2 px at most, khaki type, a brass accent,
// spaced capitals for labels and a monospace face for numbers (they change
// every second; proportional digits make the readout jitter). Plain DOM and
// CSS, no per-frame cost beyond the modules' own change-only writes.
//
// The right block sits where the dev panel begins: --rts-dev-w is set by the
// dev panel (0 when it is collapsed).

export const HUD_H = 172;          // the blocks' height, px (strip excluded)
export const HUD_STRIP_H = 24;

const CSS = `
:root {
  --hud-bg: rgba(17, 19, 15, 0.97);   /* 0.9 let world health bars show through */
  --hud-bg-2: rgba(28, 31, 24, 0.98);
  --hud-edge: #3a4031;
  --hud-edge-hi: #59623f;
  --hud-text: #d8d2bf;
  --hud-dim: #8d8a78;
  --hud-brass: #c9a54a;
  --hud-olive: #7f8f55;
  --hud-red: #cf5e48;
  --hud-radius: 2px;
  --hud-mono: ui-monospace, "Cascadia Mono", Consolas, monospace;
  --hud-sans: "Segoe UI", system-ui, -apple-system, sans-serif;
}
#nam-hud { font-family: var(--hud-sans); color: var(--hud-text); }
#nam-hud .block {
  position: fixed; bottom: 0; z-index: 55;
  background: var(--hud-bg); border: 1px solid var(--hud-edge-hi); border-bottom: 0;
  box-shadow: 0 -6px 20px rgba(0, 0, 0, 0.35);
}
#nam-hud .block-left {
  left: 0; width: ${HUD_H}px; height: ${HUD_H}px; padding: 6px;
  border-left: 0; border-radius: 0 var(--hud-radius) 0 0;
}
#nam-hud .block-right {
  right: var(--rts-dev-w, 360px); height: ${HUD_H}px;
  display: grid; grid-template-columns: 330px 316px;
  border-right: 0; border-radius: var(--hud-radius) 0 0 0;
}
#nam-hud .strip {
  position: absolute; left: -1px; bottom: 100%; height: ${HUD_STRIP_H}px;
  display: flex; align-items: center; padding: 0 12px;
  background: var(--hud-bg); border: 1px solid var(--hud-edge-hi); border-bottom: 0;
  border-radius: var(--hud-radius) var(--hud-radius) 0 0;
}
#nam-hud .slot { position: relative; min-width: 0; }
#nam-hud .slot-centre { padding: 10px 12px; overflow: hidden; }
#nam-hud .slot-right { padding: 10px 12px; background: var(--hud-bg-2); overflow: hidden; border-left: 1px solid var(--hud-edge); }
#nam-hud .empty {
  height: 100%; display: flex; align-items: center; justify-content: center;
  font-size: 10px; letter-spacing: 0.3em; text-transform: uppercase; color: #5b5a4e;
}

/* Shared controls, so every module's buttons read as one set. */
#nam-hud .hud-btn {
  cursor: pointer; font: 11px var(--hud-sans); color: var(--hud-text);
  padding: 6px 4px; border-radius: var(--hud-radius);
  background: #252920; border: 1px solid #454c3a;
  text-align: center; line-height: 1.15;
}
#nam-hud .hud-btn:hover { border-color: var(--hud-brass); background: #2d3226; }
#nam-hud .hud-label {
  font-size: 10px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--hud-dim);
}
#nam-hud .hud-num { font-family: var(--hud-mono); font-variant-numeric: tabular-nums; }
`;

export function createHudBar() {
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);

  const root = document.createElement("div");
  root.id = "nam-hud";
  root.innerHTML = `
    <div class="block block-left"></div>
    <div class="block block-right">
      <div class="strip"></div>
      <div class="slot slot-centre"></div>
      <div class="slot slot-right"></div>
    </div>`;
  document.body.appendChild(root);

  return {
    root,
    strip: root.querySelector(".strip"),
    left: root.querySelector(".block-left"),
    centre: root.querySelector(".slot-centre"),
    right: root.querySelector(".slot-right"),
    dispose() { root.remove(); style.remove(); },
  };
}
