// THE TUBE SECTION (PIECES.md §7c, user 2026-10-18: "make them better, we're missing nice pieces for
// funny tubes"). One cross-section with a CLOSURE c: 0 = the flat 16 m road, 1 = a closed pipe of
// radius 8 m; in between the road's sides curl up into a U. A tube piece carries `tube: {from, to}`
// and the closure eases along it (Tube in 0→1, Tube out 1→0, the pipe pieces 1→1), so every tube
// piece meets the road and the other tubes exactly. Drawn with the old kit's sweep and materials
// (zones 3/4 = tube inner/outer), the old look being the floor (PIECES.md §5a).
import { q5 } from "./kit.js";

export const TUBE = { R: 8, hw: 8, wall: 0.6, N: 48 };

/**
 * The section at closure c, as the old sweep wants it: a closed outline, inner (drivable) curve from
 * the left lip, across the floor, to the right lip, then the outer skin back. Points are spread by
 * ARC LENGTH along the inner curve, so the count stays fixed (the sweep morphs point by point) and
 * no edge ever collapses to zero length.
 */
export function tubeSection(c) {
  const { R, hw, wall, N } = TUBE;
  const theta = Math.PI * c; // each side's arc
  const w = 2 * hw * (1 - c); // the flat floor left
  const total = w + 2 * R * theta;
  const inner = [], normals = [];
  for (let k = 0; k <= N; k++) {
    const u = -total / 2 + (total * k) / N; // signed distance from the floor's middle
    const a = Math.abs(u), side = u < 0 ? -1 : 1;
    if (a <= w / 2 || theta === 0) {
      inner.push({ x: u, y: 0 });
      normals.push({ x: 0, y: -1 });
    } else {
      const phi = (a - w / 2) / R; // angle climbed up this side's arc
      const cx = side * (w / 2), cy = R;
      inner.push({ x: cx + side * Math.sin(phi) * R, y: cy - Math.cos(phi) * R });
      normals.push({ x: side * Math.sin(phi), y: -Math.cos(phi) }); // outward, away from the bore
    }
  }
  const pts = [];
  for (let k = 0; k <= N; k++) pts.push({ x: inner[k].x, y: inner[k].y, zone: 3 });
  for (let k = N; k >= 0; k--) pts.push({ x: inner[k].x + normals[k].x * wall, y: inner[k].y + normals[k].y * wall, zone: 4 });
  return { pts, hw };
}

/** Closure along a tube piece at s ∈ [0, L]: eased from `from` to `to`. */
export function closureAt(tile, s, L) {
  const { from = 1, to = 1 } = tile.tube;
  return from + (to - from) * q5(Math.min(1, Math.max(0, s / L)));
}

/**
 * Deck + collision for a tube piece. `oldFrames` gives the sweep frames ({pos, tangent, up, right})
 * with their distance along the piece.
 */
export function buildTubeLook(tile, frames, sAt, L, { buildSweepGeometry, NO_CHECKER, THREE }) {
  const ref = tubeSection(1);
  const deck = buildSweepGeometry(frames, ref, { profileAt: (_t, i) => tubeSection(closureAt(tile, sAt[i], L)) });
  const n = deck.getAttribute("position").count;
  const a = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) { a[i * 2] = 0; a[i * 2 + 1] = NO_CHECKER; }
  deck.setAttribute("aPiece", new THREE.Float32BufferAttribute(a, 2));
  return { deck, rail: null, railCollision: null, posts: null };
}
