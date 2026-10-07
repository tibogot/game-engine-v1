// THE GAME'S CURSORS (you, 2026-10-07: "a custom cursor instead of Chrome's default arrow — CoH
// uses its own"): WHITE on a dark rim (brass at first — you: "I prefer white").
//
//   ARROW    everywhere (the HUD, the map) — a stylesheet, so the canvas has NO inline cursor
//            (rtsCamera's edge scroll stands down while the canvas has one)
//   TARGET   what the targeting modes set as "crosshair" (grenade, smoke, barrage, flare, air
//            strike, repair) — the canvas's style.cursor is wrapped: the modules still write and
//            read "crosshair", the browser gets the reticle
//   EDGES    the edge scroll's eight arrows (rtsCamera params.edgeCursors)
// The red sight over an enemy and the blue house over a garrison are already the game's own.

const svg = (w, body) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${w}" viewBox="0 0 ${w} ${w}">${body}</svg>`)}`;
const FILL = `<defs><linearGradient id="b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#d9d9d4"/></linearGradient></defs>`;

// The arrow: a sharp pointer, a shadow under it.
const ARROW_PATH = "M3 2 L3 23 L8.4 18.2 L12.2 26.4 L16 24.8 L12.3 16.8 L19.6 16.8 Z";
const ARROW = `url("${svg(32, `${FILL}<path d="${ARROW_PATH}" transform="translate(1.6 1.8)" fill="#000" fill-opacity=".38"/><path d="${ARROW_PATH}" fill="url(#b)" stroke="#111" stroke-width="1.5" stroke-linejoin="round"/>`)}") 3 2, default`;

// The reticle: a broken ring, four ticks, a dot.
const ring = (stroke, w) => `<g fill="none" stroke="${stroke}" stroke-width="${w}" stroke-linecap="round"><path d="M16 6.5a9.5 9.5 0 0 1 9.5 9.5M25.5 16a9.5 9.5 0 0 1-9.5 9.5M16 25.5a9.5 9.5 0 0 1-9.5-9.5M6.5 16A9.5 9.5 0 0 1 16 6.5" stroke-dasharray="11 3.9"/><path d="M16 1.5v6M16 24.5v6M1.5 16h6M24.5 16h6"/></g>`;
const TARGET = `url("${svg(32, `${ring("#000", 4)}${ring("#ffffff", 1.8)}<circle cx="16" cy="16" r="1.8" fill="#ffffff" stroke="#000" stroke-width="1"/>`)}") 16 16, crosshair`;

// An edge arrow pointing UP, turned for each of the eight edges.
const edge = (deg) => `url("${svg(32, `${FILL}<g transform="rotate(${deg} 16 16)"><path d="M16 4 L26 17 L19.5 17 L19.5 27 L12.5 27 L12.5 17 L6 17 Z" fill="url(#b)" stroke="#111" stroke-width="1.5" stroke-linejoin="round"/></g>`)}") 16 16, move`;
const EDGES = { n: edge(0), ne: edge(45), e: edge(90), se: edge(135), s: edge(180), sw: edge(225), w: edge(270), nw: edge(315) };

/**
 * @param {object} o
 * @param {object} o.app  (renderer, rtsCamera)
 */
export function installGameCursors({ app }) {
  const style = document.createElement("style");
  style.id = "alg-cursors";
  style.textContent = `
    /* Everything but the canvas: !important over the HUD's own pointer cursors. */
    html, body, *:not(canvas) { cursor: ${ARROW} !important; }
    /* The canvas: not !important, so a mode's inline cursor (the red sight, the house) wins. */
    canvas { cursor: ${ARROW}; }
    /* The maps: click = go there. */
    #rts-minimap, #rts-minimap *, #alg-tacmap, #alg-tacmap * { cursor: ${TARGET} !important; }
  `;
  document.head.appendChild(style);

  // "crosshair" written on the canvas → the reticle; read back as "crosshair".
  const dom = app.renderer.domElement, st = dom.style;
  const MAP = { crosshair: TARGET };
  let logical = st.cursor || "";
  Object.defineProperty(st, "cursor", {
    configurable: true,
    get: () => logical,
    set: (v) => { logical = v ?? ""; st.setProperty("cursor", MAP[logical] ?? logical); },
  });

  if (app.rtsCamera?.params) app.rtsCamera.params.edgeCursors = EDGES;
  return {
    ARROW, TARGET, EDGES,
    dispose() { style.remove(); delete st.cursor; if (app.rtsCamera?.params) app.rtsCamera.params.edgeCursors = null; },
  };
}
