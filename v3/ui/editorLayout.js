/**
 * Editor chrome around the viewport: the draggable panel edges and the status
 * bar along the bottom.
 *
 * Panel widths live in the CSS variables --left-w / --right-w on <html>, the
 * same ones the #app grid reads, so dragging an edge reflows the grid and the
 * viewport's ResizeObserver resizes the renderer. Widths are remembered per
 * browser (a layout preference of this machine, not part of a project).
 */

const WIDTH_KEYS = { left: "v3.layout.leftW", right: "v3.layout.rightW" };
const DEFAULT_WIDTHS = { left: 220, right: 300 };
const MIN_WIDTHS = { left: 160, right: 240 };
const MIN_VIEWPORT = 320;

function _readWidth(side) {
  try {
    const v = parseFloat(localStorage.getItem(WIDTH_KEYS[side]));
    return Number.isFinite(v) ? v : DEFAULT_WIDTHS[side];
  } catch {
    return DEFAULT_WIDTHS[side];
  }
}

function _saveWidth(side, px) {
  try { localStorage.setItem(WIDTH_KEYS[side], String(Math.round(px))); } catch { /* private mode */ }
}

/**
 * Clamp a panel width: at least its minimum, and never so wide that the
 * viewport drops below MIN_VIEWPORT with the other panel at `otherPx`.
 */
export function clampPanelWidth(side, px, windowWidth, otherPx) {
  const max = Math.max(MIN_WIDTHS[side], windowWidth - otherPx - MIN_VIEWPORT);
  return Math.round(Math.min(max, Math.max(MIN_WIDTHS[side], px)));
}

/**
 * Add a drag handle on the inner edge of the left and right panels.
 * Double-click a handle to restore that panel's default width.
 * @param {HTMLElement} app  the #app grid
 */
export function initPanelSplitters(app) {
  const root = document.documentElement;
  const widths = { left: _readWidth("left"), right: _readWidth("right") };
  const other = (side) => (side === "left" ? "right" : "left");

  const apply = (side, px, { save = false } = {}) => {
    widths[side] = clampPanelWidth(side, px, window.innerWidth, widths[other(side)]);
    root.style.setProperty(side === "left" ? "--left-w" : "--right-w", `${widths[side]}px`);
    if (save) _saveWidth(side, widths[side]);
  };
  apply("left", widths.left);
  apply("right", widths.right);

  for (const side of ["left", "right"]) {
    const handle = document.createElement("div");
    handle.className = `panel-splitter panel-splitter-${side}`;
    handle.title = "Drag to resize · double-click to reset";
    app.appendChild(handle);

    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      handle.classList.add("active");
      // Panels and canvas ignore the pointer while dragging (CSS), so the
      // window keeps receiving moves even when the cursor crosses them.
      document.body.classList.add("panel-resizing");
      const startX = e.clientX;
      const startW = widths[side];
      const onMove = (ev) => {
        const dx = ev.clientX - startX;
        apply(side, side === "left" ? startW + dx : startW - dx);
      };
      const onUp = () => {
        handle.classList.remove("active");
        document.body.classList.remove("panel-resizing");
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        apply(side, widths[side], { save: true });
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    });
    handle.addEventListener("dblclick", () => apply(side, DEFAULT_WIDTHS[side], { save: true }));
  }

  // A smaller window must not squeeze the viewport away; the saved widths
  // stay what the user chose.
  window.addEventListener("resize", () => {
    apply("left", _readWidth("left"));
    apply("right", _readWidth("right"));
  });
}

/**
 * The status bar: a message on the left (what just happened), live numbers on
 * the right. `update` is cheap to call every frame; it writes the DOM a few
 * times a second.
 * @param {HTMLElement} el  the #status-bar element
 */
export function createStatusBar(el) {
  el.innerHTML =
    '<span class="status-dot"></span>' +
    '<span class="status-message">Ready</span>' +
    '<span class="status-spacer"></span>' +
    '<span class="status-mode" title="Editor mode"></span>' +
    '<span class="status-cam" title="Camera position (m)"></span>' +
    '<span class="status-draws" title="Draw calls last frame"></span>' +
    '<span class="status-tris" title="Triangles drawn last frame"></span>' +
    '<span class="status-frame" title="Time between frames, averaged — capped by the display refresh (vsync)"></span>';
  const q = (c) => el.querySelector(c);
  const dot = q(".status-dot"), msg = q(".status-message"), mode = q(".status-mode"),
    cam = q(".status-cam"), draws = q(".status-draws"), tris = q(".status-tris"), frame = q(".status-frame");

  let messageTimer = 0;
  let lastWrite = 0;

  return {
    /** Show what just happened. `kind` "error" tints it; messages clear after a few seconds. */
    setMessage(text, { kind = "info", holdMs = 6000 } = {}) {
      msg.textContent = text;
      msg.classList.toggle("error", kind === "error");
      clearTimeout(messageTimer);
      if (holdMs > 0) {
        messageTimer = setTimeout(() => {
          msg.textContent = "Ready";
          msg.classList.remove("error");
        }, holdMs);
      }
    },
    /**
     * @param {{ now: number, frameMs: number, draws: number, triangles: number,
     *   camera: { x: number, y: number, z: number }, fly: boolean, modeLabel: string }} s
     */
    update(s) {
      if (s.now - lastWrite < 250) return;
      lastWrite = s.now;
      frame.textContent = s.frameMs > 0 ? `${s.frameMs.toFixed(1)} ms` : "";
      // Green up to ~60 Hz, amber to ~30 Hz, red below.
      dot.dataset.level = s.frameMs <= 18 ? "good" : s.frameMs <= 34 ? "slow" : "bad";
      draws.textContent = `${s.draws} draws`;
      tris.textContent = s.triangles >= 1e6
        ? `${(s.triangles / 1e6).toFixed(2)}M tris`
        : `${Math.round(s.triangles / 1000)}k tris`;
      const c = s.camera;
      cam.textContent = `${s.fly ? "FLY  " : ""}X ${c.x.toFixed(0)}  Y ${c.y.toFixed(0)}  Z ${c.z.toFixed(0)}`;
      mode.textContent = s.modeLabel;
    },
  };
}
