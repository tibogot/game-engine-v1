// Custom game UI for the RTS project — GAME code, not engine.
//
// This is a plain DOM overlay on top of the viewport, fully owned by the game.
// It's independent of the engine's editor panels (which are hidden). Grow this
// into the real HUD: minimap, resources, selected-unit card, build menu, etc.
//
// For now it hosts the camera-mode toggle (orbit ⇄ RTS), which you use while
// building the game.

export function createGameUi({ rtsCamera, navGrid }) {
  const root = document.createElement("div");
  root.id = "rts-hud";
  root.innerHTML = `
    <div class="rts-hud-bar">
      <button id="rts-cam-toggle" type="button" title="Toggle camera (C)">
        Camera: <b>RTS</b>
      </button>
      <button id="rts-nav-toggle" type="button" title="Toggle nav-grid overlay (N)">
        Nav grid: <b>off</b>
      </button>
      <span class="rts-hud-hint">Left-click / drag: select (Shift adds) · Right-click: move · WASD pan · wheel zoom · Q/E rotate</span>
    </div>
  `;
  document.body.appendChild(root);

  const style = document.createElement("style");
  style.textContent = `
    #rts-hud {
      position: fixed; left: 12px; top: 12px; z-index: 50;
      font-family: system-ui, -apple-system, sans-serif; color: #e8e8e8;
      user-select: none;
    }
    #rts-hud .rts-hud-bar {
      display: flex; align-items: center; gap: 12px;
      padding: 8px 12px; border-radius: 8px;
      background: rgba(16,18,22,0.72); backdrop-filter: blur(6px);
      border: 1px solid rgba(255,255,255,0.08);
    }
    #rts-hud button {
      cursor: pointer; font: inherit; color: #e8e8e8;
      padding: 6px 12px; border-radius: 6px;
      background: #2a6df0; border: 1px solid #3d7bff;
    }
    #rts-hud button:hover { background: #3d7bff; }
    #rts-hud button b { font-weight: 700; }
    #rts-hud .rts-hud-hint { font-size: 12px; color: #9aa4b2; }
  `;
  document.head.appendChild(style);

  const btn = root.querySelector("#rts-cam-toggle");
  const navBtn = root.querySelector("#rts-nav-toggle");
  const render = () => {
    btn.querySelector("b").textContent = rtsCamera.getMode() === "rts" ? "RTS" : "Orbit";
  };
  const toggle = () => { rtsCamera.toggle(); render(); };
  const toggleNav = () => {
    const on = navGrid?.toggleDebug?.() ?? false;
    navBtn.querySelector("b").textContent = on ? "on" : "off";
  };

  btn.addEventListener("click", toggle);
  navBtn.addEventListener("click", toggleNav);
  const onKey = (e) => {
    if (e.repeat) return;
    if (e.code === "KeyC") toggle();
    else if (e.code === "KeyN") toggleNav();
  };
  window.addEventListener("keydown", onKey);
  render();

  return {
    /** Add your own HUD widgets into this root as the game grows. */
    root,
    dispose() {
      window.removeEventListener("keydown", onKey);
      root.remove();
      style.remove();
    },
  };
}
