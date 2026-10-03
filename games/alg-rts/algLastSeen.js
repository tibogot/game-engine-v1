// LAST SEEN — where an enemy was when he dropped out of sight (you,
// 2026-10-03; Company of Heroes' ghost markers). With guerrillas who vanish
// into gullies, the fog of war is fair only if you remember where you lost
// them.
//
//   An FLN man (or vehicle) seen, then not: a MARKER where he was last, the
//   men lost close together merged into one (with how many). It fades over
//   FADE s, and goes at once when you look there again (the spot in sight) or
//   when one of them is seen anew nearby. A dead man leaves none.
//
// Drawn as a faint red ring on the ground (a ring field) and a small label
// over it ("? ×4", how long ago). Checked 4 times a second.

const P = {
  every: 0.25,
  fade: 35,            // s a marker lasts
  merge: 12,           // m: men lost within this of a marker join it
  clearSeen: 0.6,      // s the spot must be in sight before the marker goes
};

export function createAlgLastSeen({ app, units, fogOfWar, rings, team = "enemy", mount = document.body }) {
  const ghosts = [];        // { x, z, n, t, seenT, el }
  const wasVisible = new Map();
  let wait = 0, simT = 0;

  const style = document.createElement("style");
  style.textContent = `
.alg-ghost { position: fixed; z-index: 40; pointer-events: none; transform: translate(-50%, -100%);
  font: 700 11px var(--hud-sans, sans-serif); letter-spacing: 0.04em; color: #ffb3a6;
  text-shadow: 0 1px 2px #000, 0 0 4px #000; white-space: nowrap; }
.alg-ghost b { color: #ff7a66; font-size: 13px; }
.alg-ghost i { font-style: normal; color: #c9a69e; font-weight: 400; margin-left: 4px; }`;
  document.head.appendChild(style);

  function addGhost(x, z) {
    const g = ghosts.find((q) => Math.hypot(q.x - x, q.z - z) < P.merge);
    if (g) { g.x = (g.x * g.n + x) / (g.n + 1); g.z = (g.z * g.n + z) / (g.n + 1); g.n++; g.t = simT; g.seenT = 0; return; }
    const el = document.createElement("div");
    el.className = "alg-ghost";
    mount.appendChild(el);
    ghosts.push({ x, z, n: 1, t: simT, seenT: 0, el, label: "" });
  }
  function drop(i) { ghosts[i].el.remove(); ghosts.splice(i, 1); }

  function scan() {
    if (!fogOfWar?.enabled) { while (ghosts.length) drop(0); wasVisible.clear(); return; }
    for (const u of units.list) {
      if (u.team !== team || u.isStructure) continue;
      const seen = u.alive && fogOfWar.canSeeEntity(u);
      const before = wasVisible.get(u);
      // Where he was LAST SEEN (not where he is now, out of sight).
      if (before && !seen && u.alive && !u.vanished) addGhost(before.x, before.z);
      if (seen) {
        // Seen anew: the marker he made is answered.
        for (let i = ghosts.length - 1; i >= 0; i--) if (Math.hypot(ghosts[i].x - u.position.x, ghosts[i].z - u.position.z) < P.merge * 1.5) drop(i);
      }
      if (u.alive && seen) wasVisible.set(u, { x: u.position.x, z: u.position.z });
      else wasVisible.delete(u);
    }
    for (let i = ghosts.length - 1; i >= 0; i--) {
      const g = ghosts[i];
      // In sight AGAIN with nobody there: they've moved on. (The spot a man
      // slips out of view from is usually still in view — so only once it has
      // been out of sight, i.e. you have looked away and come back.)
      const vis = fogOfWar.isVisible(g.x, g.z);
      if (!vis) g.hiddenOnce = true;
      g.seenT = vis && g.hiddenOnce ? g.seenT + P.every : 0;
      if (g.seenT >= P.clearSeen || simT - g.t > P.fade) drop(i);
    }
  }

  return {
    get list() { return ghosts; },
    /** Sim seconds (the game's fixed step). */
    step(dt) {
      simT += dt;
      wait -= dt;
      if (wait > 0) return;
      wait = P.every;
      scan();
    },
    /** Every frame: the rings and the labels. */
    frame(camera) {
      const dom = app.renderer.domElement.getBoundingClientRect();
      for (const g of ghosts) {
        const age = simT - g.t, a = Math.max(0, 1 - age / P.fade);
        const y = app.getWorldHeight?.(g.x, g.z) ?? 0;
        rings?.add(g.x, g.z, 3 + Math.min(4, g.n), 0xff5a46);
        const p = { x: g.x, y: y + 2.5, z: g.z };
        const v = camera.position.clone().set(p.x, p.y, p.z).project(camera);
        const off = v.z > 1 || Math.abs(v.x) > 1.05 || Math.abs(v.y) > 1.05;
        g.el.style.display = off ? "none" : "";
        if (off) continue;
        g.el.style.left = `${dom.left + (v.x * 0.5 + 0.5) * dom.width}px`;
        g.el.style.top = `${dom.top + (-v.y * 0.5 + 0.5) * dom.height}px`;
        g.el.style.opacity = (0.35 + 0.65 * a).toFixed(2);
        const label = `<b>?</b>${g.n > 1 ? ` ×${g.n}` : ""}<i>${Math.round(age)} s</i>`;
        if (label !== g.label) { g.label = label; g.el.innerHTML = label; }
      }
    },
    dispose() { while (ghosts.length) drop(0); style.remove(); },
  };
}
