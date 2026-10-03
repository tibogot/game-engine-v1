// THE PATH DOTS (you, 2026-10-03, Company of Heroes): a trail of small white
// dots on the ground from each selected squad along the route it will walk —
// the A* path itself (units.route), so you SEE it go round the ravine, not
// through it. One trail per squad (its first man), one per vehicle. The dots
// are eaten as the squad walks; the trail ends at the goal.
//
// One draw call: the shared ring field with a filled disc, draped on the
// terrain in the vertex shader like the selection rings.
import { createSelectionRingField } from "../shared-rts/selectionRingField.js";

const P = {
  spacing: 2.4,    // metres between two dots
  radius: 0.32,    // a dot (0.16 was invisible from the play camera)
  maxDots: 60,     // per trail (~145 m)
  max: 900,        // the whole pool
  colour: 0xf4efe0,
};

/**
 * @param {object} o
 * @param {object} o.app
 * @param {object} o.selection  the shared selection (selected)
 * @param {object} [o.squads]   algSquads (one trail per squad)
 */
export function createAlgPathDots({ app, selection, squads = null }) {
  const dots = createSelectionRingField({ app, max: P.max, inner: 0.0001, segments: 8, opacity: 0.85, color: P.colour });
  let n = 0;

  /** One trail: from (x, z) through the route, a dot every SPACING m. */
  function trail(x, z, route) {
    let carry = P.spacing * 0.6, k = 0;   // the first dot a little ahead of the man
    let ax = x, az = z;
    for (const wp of route) {
      const dx = wp.x - ax, dz = wp.z - az, len = Math.hypot(dx, dz);
      let s = carry;
      while (s <= len) {
        if (k++ >= P.maxDots || n >= P.max) return;
        dots.add(ax + (dx * s) / len, az + (dz * s) / len, P.radius);
        n++;
        s += P.spacing;
      }
      carry = s - len;
      ax = wp.x; az = wp.z;
    }
    // The goal itself: a slightly bigger dot.
    if (n < P.max) { dots.add(ax, az, P.radius * 1.6); n++; }
  }

  return {
    params: P,
    /** Each frame (render side). */
    frame() {
      dots.begin();
      n = 0;
      const seen = new Set();
      for (const u of selection.selected ?? []) {
        if (!u.alive || u.team !== "player" || u.isStructure || u.isAir) continue;
        const r = u.route;
        if (!r?.length) continue;
        // The squad's first man still walking draws its trail.
        const sq = squads?.squadOf?.(u);
        if (sq) { if (seen.has(sq)) continue; seen.add(sq); }
        trail(u.position.x, u.position.z, r);
      }
      dots.commit();
    },
  };
}
