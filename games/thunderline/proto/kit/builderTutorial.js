// THE BUILDER TUTORIAL (user, 2026-10-22: "a tutorial for people to use the editor so they are not lost, and
// me neither … it should show really how the builder works"). A coach panel walks a fresh track through the
// builder in ten steps: it says what to do, lights up the tab / piece / button to use, and moves on by itself
// when the track shows it was done (a start placed, a landing on a jump's arc, a drive and back…) — so a run
// through it also proves each part works. Steps that only show something have a Next button.
//
// api (from builder3.js): { track, arcs, driving, sel, camera, tiles } — read each tick, never written.

const CSS = `
  #tut { position: fixed; left: 16px; top: 76px; width: 340px; z-index: 60; background: rgba(8, 11, 18, 0.94);
    border: 1px solid #23304d; border-left: 3px solid #3fd2ff; color: #dbe4f5; font: 500 14px/1.45 "Barlow", system-ui, sans-serif;
    padding: 14px 16px 12px; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45); }
  #tut .k { font: 700 12px "Barlow Condensed", sans-serif; letter-spacing: 0.12em; text-transform: uppercase; color: #3fd2ff; }
  #tut h3 { margin: 4px 0 6px; font: 800 22px "Barlow Condensed", sans-serif; letter-spacing: 0.03em; text-transform: uppercase; color: #fff; }
  #tut p { margin: 0 0 8px; }
  #tut .tip { color: #8796b5; font-size: 13px; }
  #tut kbd { font: 600 12px "Barlow Condensed", sans-serif; border: 1px solid #3a4a6b; padding: 0 5px; color: #fff; }
  #tut .bar { display: flex; gap: 8px; align-items: center; margin-top: 8px; }
  #tut .bar .sp { flex: 1; }
  #tut .dots { display: flex; gap: 4px; }
  #tut .dots i { width: 14px; height: 4px; background: #23304d; }
  #tut .dots i.on { background: #3fd2ff; }
  #tut button { background: none; border: 1px solid #3a4a6b; color: #dbe4f5; padding: 5px 10px; cursor: pointer;
    font: 600 13px "Barlow Condensed", sans-serif; letter-spacing: 0.06em; text-transform: uppercase; }
  #tut button:hover, #tut button.go { border-color: #3fd2ff; color: #3fd2ff; }
  #tut .ok { color: #3fd2ff; font: 700 13px "Barlow Condensed", sans-serif; letter-spacing: 0.08em; text-transform: uppercase; }
  .tut-hi { outline: 3px solid #3fd2ff !important; outline-offset: -3px; animation: tutPulse 1.1s ease-in-out infinite; } /* inside the edge: the card row clips anything outside */
  @keyframes tutPulse { 0%, 100% { box-shadow: inset 0 0 0 0 rgba(63, 210, 255, 0.0); } 50% { box-shadow: inset 0 0 0 8px rgba(63, 210, 255, 0.35); } }
`;

const isTurn = (t) => !!t?.segs?.some((s) => Math.abs(s.turn ?? 0) > 0.2) && !t.tube && !t.halfpipe;
const roadPieces = (api) => api.track.pieces.filter((p) => !p.ring);

/** The ten steps: what to say, what to light up (CSS selectors), and when it is done. */
const STEPS = [
  {
    k: "The camera", title: "Look around",
    text: "Drag with the <b>right mouse button</b> to turn the view, the <b>wheel</b> to zoom, <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> to move. <kbd>F</kbd> frames the whole track.",
    tip: "Move the camera a little to go on.",
    done: (api, c) => api.camera.position.distanceTo(c.cam0) > 8,
  },
  {
    k: "Piece 1", title: "Place the start",
    text: "Open the <b>Road</b> tab, pick <b>Start</b>, and click on the grid. A blue ghost shows where it goes; <kbd>Q</kbd> / <kbd>E</kbd> turn it first.",
    hi: ['[data-cat="road"]', '[data-base="start_line"]'],
    done: (api) => roadPieces(api).some((p) => p.id === "start_line"),
  },
  {
    k: "Road", title: "Add straights",
    text: "Pick <b>Straight 64</b> and point at the <b>open end</b> of your road: the ghost snaps onto it. Click to place. Add <b>two</b>.",
    tip: "The piece stays in your hand: click again for the next one. Right-click or <kbd>Esc</kbd> puts it down.",
    hi: ['[data-cat="road"]', '[data-base="straight_64"]'],
    done: (api) => roadPieces(api).filter((p) => p.parent != null && /straight/.test(p.id)).length >= 2,
  },
  {
    k: "Road", title: "A turn",
    text: "Open <b>Turns</b> and add any turn to the end. <kbd>R</kbd> (or the <b>Hand L / R</b> switch) makes it turn left or right.",
    hi: ['[data-cat="turns"]'],
    done: (api) => roadPieces(api).some((p) => p.parent != null && isTurn(api.tiles[p.id])),
  },
  {
    k: "Jumps", title: "A kicker",
    text: "Open <b>Ramps</b> and add a <b>Kicker 20°</b>. Two lines appear: where the car <b>flies</b> — orange a bit slower, yellow at full speed.",
    tip: "The test car drives your track by itself in the background: its speed sets these arcs.",
    hi: ['[data-cat="ramps"]', '[data-base="kicker_20"]'],
    done: (api) => roadPieces(api).some((p) => /kicker/.test(p.id)) && api.arcs.length > 0,
  },
  {
    k: "Jumps", title: "Land it",
    text: "Open <b>Air</b>, pick <b>Fitted landing</b> and point at the <b>yellow arc</b>, where the car comes down. The panel says from what speed the car makes it.",
    tip: "Any road piece can go on the arc too — a platform, a straight. ← / → tilt a fitted landing for the air roll.",
    hi: ['[data-cat="air"]', '[data-base="fitted_landing"]'],
    done: (api) => roadPieces(api).some((p) => p.flightFrom != null),
  },
  {
    k: "Test it", title: "Drive",
    text: "Add a straight after the landing, then press <b>Drive ▶</b> (or <kbd>Tab</kbd>). <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> drive, <kbd>Space</kbd> handbrake; in the air <kbd>Shift</kbd> / <kbd>Ctrl</kbd> pitch and <kbd>Z</kbd> / <kbd>X</kbd> roll — land flat for a boost. <kbd>Esc</kbd> comes back here.",
    tip: "Timer off (the toolbar) drives at once; on, it is the real race.",
    hi: ["#b-drive"],
    done: (api, c) => { if (api.driving) c.drove = true; return c.drove && !api.driving; },
  },
  {
    k: "Obstacles", title: "A boost pad",
    text: "Open <b>Obstacles</b>, pick <b>Boost pad</b> and drop it on a straight. Then <b>drag it</b> with the mouse: it slides along and across the road.",
    tip: "Obstacles stay on their piece: move or replace the road and they follow.",
    hi: ['[data-cat="obstacles"]', '[data-base="ob_boost"]'],
    done: (api) => (api.track.props ?? []).some((p) => p.kind === "ob_boost"),
  },
  {
    k: "Editing", title: "Change a piece",
    text: "Put the piece down (<kbd>Esc</kbd>) and <b>click a piece</b> of your road. The panel offers <b>Insert</b> <kbd>I</kbd>, <b>Replace</b> <kbd>P</kbd>, <b>Delete</b>, <b>Split</b> <kbd>K</kbd>. The <b>gizmo</b> arrows move the whole road; <kbd>M</kbd> turns and tilts it.",
    tip: "Shift-click selects the road up to a piece, Ctrl-click one more. Ctrl+Z undoes anything.",
    done: (api) => api.sel != null && roadPieces(api).some((p) => p.uid === api.sel),
  },
  {
    k: "Finish", title: "Finish it",
    text: "Open <b>Road</b> and put a <b>Finish</b> at the end. When the test car drives it cleanly, the track gets an <b>author time</b>: the medals are set from it.",
    tip: "The track saves by itself. Play it from the menu — there the shadows are baked for it.",
    hi: ['[data-cat="road"]', '[data-base="finish_line"]'],
    done: (api) => roadPieces(api).some((p) => p.id === "finish_line"),
  },
];

/**
 * @param api  live getters from the builder
 * @param o.onEnd  called when the tutorial closes (finished or skipped)
 */
export function createBuilderTutorial(api, { onEnd } = {}) {
  if (!document.getElementById("tut-css")) {
    const st = document.createElement("style");
    st.id = "tut-css";
    st.textContent = CSS;
    document.head.appendChild(st);
  }
  let el = null, i = -1, timer = 0, lit = [], doneAt = 0;
  const c = { cam0: null, drove: false };
  function light(sels) {
    for (const e of lit) e.classList.remove("tut-hi");
    lit = (sels ?? []).flatMap((s) => [...document.querySelectorAll(s)]);
    for (const e of lit) e.classList.add("tut-hi");
  }
  function render(finished) {
    if (!el) { el = document.createElement("div"); el.id = "tut"; document.body.appendChild(el); }
    const s = STEPS[i];
    const dots = STEPS.map((_, k) => `<i class="${k <= i ? "on" : ""}"></i>`).join("");
    el.innerHTML = finished
      ? `<div class="k">Tutorial · done</div><h3>That's the builder</h3><p>You placed, jumped, landed, drove, edited and finished a track. <b>Keys</b> in the toolbar lists every shortcut.</p><div class="bar"><div class="sp"></div><button class="go" data-a="close">Close</button></div>`
      : `<div class="k">Tutorial · ${i + 1} / ${STEPS.length} · ${s.k}</div><h3>${s.title}</h3><p>${s.text}</p>${s.tip ? `<p class="tip">${s.tip}</p>` : ""}` +
        `<div class="bar"><div class="dots">${dots}</div><div class="sp"></div>` +
        (doneAt ? `<span class="ok">✓ Done</span>` : "") +
        (s.done ? "" : `<button class="go" data-a="next">Next</button>`) +
        `<button data-a="skip">${i < STEPS.length - 1 ? "Skip step" : "Close"}</button><button data-a="close" title="Close the tutorial">✕</button></div>`;
    for (const b of el.querySelectorAll("button")) b.onclick = () => {
      const a = b.dataset.a;
      if (a === "close") stop();
      else go(i + 1);
    };
  }
  function go(k) {
    i = k;
    doneAt = 0;
    if (i >= STEPS.length) { light([]); render(true); return; }
    if (i === 0) c.cam0 = api.camera.position.clone();
    c.drove = false;
    render(false);
  }
  function tick() {
    if (i < 0 || i >= STEPS.length) return;
    const s = STEPS[i];
    light(api.driving ? [] : s.hi); // (the dock re-renders: lit again every tick)
    if (el) el.style.display = api.driving ? "none" : "";
    if (!doneAt && s.done?.(api, c)) { doneAt = performance.now(); render(false); }
    if (doneAt && performance.now() - doneAt > 900) go(i + 1); // a beat to see the ✓, then on
  }
  function start() { stop(true); go(0); timer = setInterval(tick, 250); }
  function stop(quiet) {
    clearInterval(timer); timer = 0;
    light([]);
    el?.remove(); el = null;
    const was = i;
    i = -1;
    if (!quiet && was >= 0) onEnd?.();
  }
  return { start, stop, get step() { return i; }, get steps() { return STEPS.length; } };
}
