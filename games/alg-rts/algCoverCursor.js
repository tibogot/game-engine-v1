// COVER AT THE CURSOR (2026-10-07, the AAA list's gameplay depth — Company of Heroes' signature):
// with men selected, the spot EACH MAN would stand on shows under the cursor, coloured by its cover
// (ui/orderMarks.js preview: green heavy, yellow light, pale open, cyan concealed) — you see a
// move's worth before you give it.
//
// And the men GO TO THE COVER, as in CoH: a move's spots are snapped onto the best cover within a
// few metres (a wall, a bank, a boulder), each man his own, not two on one spot. The same rule
// runs for the preview and for the order (selection.js formationAt → `adjustSlots` here), so
// what is shown is what is ordered.
//
// Not shown while another mode owns the cursor (a grenade's crosshair, the red sight over an
// enemy, a house to garrison), while placing a building, over the HUD, or with only vehicles
// selected (cover is the infantry's).

export const COVER_CURSOR = {
  snap: [1.6, 3.2],   // m: the rings searched round each spot
  dirs: 8,            // directions on each ring
  gain: 0.2,          // the cover a move must gain to leave the spot clicked
  nearCost: 0.06,     // per metre: of two equal covers, the nearer
  apart: 1.3,         // m between two men's spots
  hug: 3.5, gap: 1.1, // m: in cover, step in toward a solid thing this near, to this far from it
  everyMs: 60,        // the preview's refresh
};

/**
 * @param {object} o
 * @param {object} o.app        (renderer, pickWorldAtClient, algCover, navGrid, algOrderMarks, algBuild, algTacMap)
 * @param {object} o.selection  (selected, previewMove)
 */
export function createAlgCoverCursor({ app, selection }) {
  const P = COVER_CURSOR;
  const dom = app.renderer.domElement;

  /** selection.js `adjustSlots`: each foot soldier's spot onto the best cover near it. */
  function adjustSlots(slots, units) {
    const cover = app.algCover;
    if (!cover?.coverAt) return slots;
    const nav = app.navGrid;
    const taken = [];
    return slots.map((s, i) => {
      const u = units[i];
      if (!u?.type?.foot) return s;
      const here = cover.coverAt(s.x, s.z);
      let best = s, bestScore = here;
      for (const r of P.snap) {
        for (let k = 0; k < P.dirs; k++) {
          const a = (k / P.dirs) * Math.PI * 2 + (r > P.snap[0] ? Math.PI / P.dirs : 0);
          const x = s.x + Math.cos(a) * r, z = s.z + Math.sin(a) * r;
          if (nav?.isBlockedAtWorld?.(x, z, true)) continue;
          if (taken.some((t) => (t.x - x) ** 2 + (t.z - z) ** 2 < P.apart ** 2)) continue;
          const score = cover.coverAt(x, z) - r * P.nearCost;
          if (score > bestScore) { bestScore = score; best = { x, z }; }
        }
      }
      // Only for a real gain: on open ground the formation stays as it is.
      let out = best !== s && cover.coverAt(best.x, best.z) - here >= P.gain ? best : s;
      // HUG IT: the cover map is a 4 m grid, so "in cover" left men standing 3-5 m off a boulder.
      // In cover, step in toward the nearest solid thing within `hug` m until `gap` m from it.
      if (nav?.isBlockedAtWorld && cover.coverAt(out.x, out.z) >= P.gain) {
        let bd = Infinity, bx = 0, bz = 0;
        for (let k = 0; k < 16; k++) {
          const a = (k / 16) * Math.PI * 2, cx = Math.cos(a), cz = Math.sin(a);
          for (let d = 0.5; d <= P.hug && d < bd; d += 0.5) {
            if (nav.isBlockedAtWorld(out.x + cx * d, out.z + cz * d, true)) { bd = d; bx = cx; bz = cz; break; }
          }
        }
        if (bd < Infinity && bd > P.gap) {
          const hx = out.x + bx * (bd - P.gap), hz = out.z + bz * (bd - P.gap);
          if (!taken.some((t) => (t.x - hx) ** 2 + (t.z - hz) ** 2 < P.apart ** 2)) out = { x: hx, z: hz };
        }
      }
      taken.push(out);
      return out;
    });
  }

  // ── The preview ───────────────────────────────────────────────────────────
  let px = 0, py = 0, overCanvas = false, buttons = 0, t = 0, shown = false;
  const onMove = (e) => { px = e.clientX; py = e.clientY; overCanvas = e.target === dom; buttons = e.buttons; };
  const onLeave = () => { overCanvas = false; };
  window.addEventListener("pointermove", onMove);
  dom.addEventListener("pointerleave", onLeave);

  const hide = () => { if (shown) { app.algOrderMarks?.preview(null); shown = false; } };

  /** Each frame: refresh the marks every `everyMs` while it should show. */
  function frame() {
    const now = performance.now();
    if (now - t < P.everyMs) return;
    t = now;
    const sel = selection.selected ?? [];
    const busy = !overCanvas || buttons !== 0 || dom.style.cursor || app.algBuild?.placing || app.algTacMap?.open;
    if (busy || !sel.some((u) => u.alive && u.type?.foot && !u.isStructure)) { hide(); return; }
    const hit = app.pickWorldAtClient?.(px, py);
    if (!hit?.point) { hide(); return; }
    const { arr, slots } = selection.previewMove(hit.point.x, hit.point.z);
    const spots = [];
    arr.forEach((u, i) => { if (u.type?.foot && u.alive && slots[i]) spots.push(slots[i]); });
    app.algOrderMarks?.preview(spots);
    shown = true;
  }

  return {
    params: P, adjustSlots, frame, hide,
    dispose() { window.removeEventListener("pointermove", onMove); dom.removeEventListener("pointerleave", onLeave); hide(); },
  };
}
