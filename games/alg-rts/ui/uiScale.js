// INTERFACE SIZE (you, 2026-10-07: "the text in the game is a bit small" — most of it was 11-13 px,
// labels 9-10). One option, Options → Taille de l'interface: every HUD PANEL is scaled from its own
// anchor (a panel at the top-left grows right and down, one at the bottom-right grows left and up,
// one centred grows both ways), so nothing slides off its edge. The labels pinned to the map
// (squad badges, village marks) are left alone: they are placed in pixels over the world.
// (Not #alg-tabs: the unit portraits down the right edge — pictures, a count; scaled they ran
// under the resources.)
const PANELS = "#alg-res, #alg-score, #alg-alerts, #alg-obj, #alg-hud > .block, .alg-modal-back > .alg-modal";

/**
 * Where a box grows from, along one axis: its NEAREST edge (0 / 1), or its middle when it sits
 * about as far from both (a centred bar, a modal). Proportional origins made neighbours collide
 * (the score bar grew into the resources).
 */
const frac = (pos, size, room) => {
  const a = pos, b = room - pos - size;
  if (Math.abs(a - b) < room * 0.12) return 0.5;
  return a < b ? 0 : 1;
};

export function createUiScale(initial = 1) {
  let scale = initial;
  function applyTo(el) {
    el.style.transform = "";
    if (scale === 1) { el.style.transformOrigin = ""; return; }
    const r = el.getBoundingClientRect();
    const ox = frac(r.left, r.width, innerWidth), oy = frac(r.top, r.height, innerHeight);
    el.style.transformOrigin = `${(ox * 100).toFixed(1)}% ${(oy * 100).toFixed(1)}%`;
    // ADDED to the panel's own transform (the score bar centres itself with translateX(-50%):
    // replacing it threw the bar half its width to the right, into the resources).
    const base = getComputedStyle(el).transform;
    el.style.transform = `${base && base !== "none" ? base + " " : ""}scale(${scale})`;
  }
  // The unit tabs (not scaled) hang under the resources: keep them clear of the grown panel.
  let tabsTop = null;
  function clearTabs() {
    const tabs = document.getElementById("alg-tabs"), res = document.getElementById("alg-res");
    if (!tabs || !res) return;
    if (tabsTop == null) tabsTop = parseFloat(getComputedStyle(tabs).top) || 0;
    tabs.style.top = `${Math.max(tabsTop, res.getBoundingClientRect().bottom + 6)}px`;
  }
  const applyAll = () => { document.querySelectorAll(PANELS).forEach(applyTo); clearTabs(); };
  // Panels and modals made later (the pause menu, the briefing, the end screen).
  const mo = new MutationObserver((list) => {
    for (const m of list) for (const n of m.addedNodes) {
      if (n.nodeType !== 1) continue;
      if (n.matches?.(PANELS)) applyTo(n);
      n.querySelectorAll?.(PANELS).forEach(applyTo);
    }
  });
  // (Not the whole subtree: the HUD rewrites its text every frame.)
  mo.observe(document.body, { childList: true });
  const hud = document.getElementById("alg-hud");
  if (hud) mo.observe(hud, { childList: true });
  addEventListener("resize", applyAll);
  applyAll();
  return {
    get scale() { return scale; },
    set(s) { scale = s; applyAll(); },
    refresh: applyAll,
    dispose() { mo.disconnect(); removeEventListener("resize", applyAll); },
  };
}
