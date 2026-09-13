// ============================================================================
// PAUSE MENU — the overlay. The pause itself lives in roadGame.js.
//
// What "paused" MEANS is decided there, because it is a property of every
// system the game ticks and only the game knows all of them: one `worldDt`
// that is 0 while paused, handed to the car's fixed ticks, the race clock, the
// city (traffic, knockables, checkpoints), the clouds, the weather, lightning,
// the birds, the ocean, the rain, the smoke and the flags. The camera and the
// renderer keep running, so a paused world is still a world you can look at.
//
// This file is only the menu: a dimmed full-screen layer with RESUME, RESTART
// and BACK TO BUILDER, and a line saying WHY it paused ("window lost focus"
// reads very differently from a pause you asked for).
//
// ── WHY THE STYLE IS INJECTED AND NOT A <link> ───────────────────────────────
//
// road.html has `<base href="/v3/">`, and a stylesheet linked from a page like
// that works under the dev server and 404s in the build (see the memory note on
// it). A <style> element written from here has no URL to get wrong.
//
// ── WHY ENTER IS HANDLED HERE AND NOT BY THE BUTTON ──────────────────────────
//
// The game's keydown listener runs in the CAPTURE phase on window and calls
// stopImmediatePropagation, so a focused <button> never sees Enter or Space.
// The game forwards the pause keys to `handleKey` instead.
// ============================================================================

const STYLE_ID = "road-pause-style";

const CSS = `
#road-pause {
  position: fixed; inset: 0; z-index: 10045;
  display: flex; align-items: center; justify-content: center;
  background: radial-gradient(ellipse at center, rgba(8, 10, 14, 0.46) 0%, rgba(8, 10, 14, 0.78) 100%);
  backdrop-filter: blur(2px) saturate(0.8);
  font-family: "Segoe UI", system-ui, sans-serif;
  color: #f2f4f7;
  animation: road-pause-in 140ms ease-out;
}
#road-pause[hidden] { display: none; }
@keyframes road-pause-in { from { opacity: 0; } to { opacity: 1; } }
#road-pause-panel {
  min-width: 300px; max-width: min(420px, calc(100vw - 48px));
  padding: 26px 28px 22px;
  background: rgba(18, 22, 30, 0.94);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-top: 3px solid #dce622;
  box-shadow: 0 18px 60px rgba(0, 0, 0, 0.55);
}
#road-pause-title {
  margin: 0; font-size: 30px; font-weight: 800; letter-spacing: 0.18em;
  font-style: italic; color: #dce622;
}
#road-pause-reason {
  margin: 4px 0 18px; min-height: 1.2em;
  font-size: 13px; color: #c5ccd6;
}
.road-pause-btn {
  display: flex; align-items: center; justify-content: space-between;
  width: 100%; margin: 0 0 8px; padding: 11px 14px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: #f2f4f7; font: inherit; font-size: 15px; font-weight: 600;
  text-align: left; cursor: pointer;
  transition: background 80ms, border-color 80ms, color 80ms;
}
.road-pause-btn:hover, .road-pause-btn:focus-visible {
  background: rgba(220, 230, 34, 0.12); border-color: #dce622; color: #dce622; outline: none;
}
.road-pause-btn[hidden] { display: none; }
.road-pause-key {
  font-family: "Cascadia Code", "Fira Code", Consolas, monospace;
  font-size: 12px; font-weight: 500; color: #9aa3ad;
  padding: 1px 6px; border: 1px solid rgba(255, 255, 255, 0.16);
}
#road-pause-hint {
  margin-top: 10px; font-size: 12px; color: #8b94a0;
}
`;

/**
 * @param {object} o
 * @param {() => void} o.onResume
 * @param {() => void} o.onRestart   full retry from the spawn
 * @param {() => void} o.onBuilder   leave drive mode
 * @param {HTMLElement} [o.parent]
 */
export function createPauseMenu({ onResume, onRestart, onBuilder, parent = document.body } = {}) {
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  const root = document.createElement("div");
  root.id = "road-pause";
  root.hidden = true;
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-labelledby", "road-pause-title");
  root.innerHTML = `
    <div id="road-pause-panel">
      <h2 id="road-pause-title">PAUSED</h2>
      <div id="road-pause-reason"></div>
      <button class="road-pause-btn" data-act="resume" type="button">Resume <span class="road-pause-key">Esc</span></button>
      <button class="road-pause-btn" data-act="restart" type="button">Restart from start <span class="road-pause-key">R</span></button>
      <button class="road-pause-btn" data-act="builder" type="button">Back to builder <span class="road-pause-key">B</span></button>
      <div id="road-pause-hint">Esc, P or the pad's Start button to resume</div>
    </div>`;
  parent.appendChild(root);
  const reasonEl = root.querySelector("#road-pause-reason");

  const act = (name) => {
    if (name === "resume") onResume?.();
    else if (name === "restart") onRestart?.();
    else if (name === "builder") onBuilder?.();
  };
  root.addEventListener("click", (e) => {
    const btn = e.target.closest?.(".road-pause-btn");
    if (btn) act(btn.dataset.act);
  });

  const REASONS = {
    key: "",
    pad: "",
    focus: "The window lost focus",
    api: "",
  };

  return {
    el: root,
    isOpen: () => !root.hidden,
    open(reason = "key") {
      reasonEl.textContent = REASONS[reason] ?? "";
      root.hidden = false;
      // Focus for screen readers and a visible focus ring; activation by
      // keyboard comes through handleKey (see the header).
      root.querySelector('[data-act="resume"]')?.focus({ preventScroll: true });
    },
    close() {
      root.hidden = true;
    },
    /**
     * Keys while the menu is open, forwarded by the game's capture listener.
     * @returns {boolean} true when the key was consumed
     */
    handleKey(code) {
      if (root.hidden) return false;
      if (code === "enter" || code === "numpadenter" || code === "space") {
        const focused = document.activeElement?.closest?.(".road-pause-btn");
        act(focused ? focused.dataset.act : "resume");
        return true;
      }
      if (code === "keyr") { act("restart"); return true; }
      if (code === "keyb") { act("builder"); return true; }
      if (code === "arrowdown" || code === "arrowup" || code === "tab") {
        const btns = [...root.querySelectorAll(".road-pause-btn:not([hidden])")];
        const i = btns.indexOf(document.activeElement);
        const step = code === "arrowup" ? -1 : 1;
        btns[(i + step + btns.length) % btns.length]?.focus({ preventScroll: true });
        return true;
      }
      return false;
    },
    dispose() {
      root.remove();
    },
  };
}
