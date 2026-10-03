// THE CANVAS RECT, CACHED (2026-10-03, alg-rts perf audit).
//
// Every per-frame HUD (squad badges, battle markers, last-seen labels), the
// unit hover test and the camera's edge scroll read the canvas' rect each
// frame. getBoundingClientRect after last frame's style writes forces a full
// layout: measured 0.37-0.46 ms a frame for ONE caller in a fight. They all
// ask about the same element, which only moves when the window or a panel
// resizes — so one read, dropped on resize / scroll, and at most once a second
// anyway in case something moved it without resizing it.

const cache = new WeakMap();

/** `el.getBoundingClientRect()`, cached until a resize, a scroll or 1 s. */
export function rectOf(el) {
  let c = cache.get(el);
  if (!c) {
    c = { r: null, t: 0 };
    const dirty = () => { c.r = null; };
    if (typeof ResizeObserver === "function") new ResizeObserver(dirty).observe(el);
    window.addEventListener("resize", dirty);
    window.addEventListener("scroll", dirty, true);
    cache.set(el, c);
  }
  const now = performance.now();
  if (!c.r || now - c.t > 1000) { c.r = el.getBoundingClientRect(); c.t = now; }
  return c.r;
}
