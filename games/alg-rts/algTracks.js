// THE TRACKS IN PLAY — the piste and the mule paths (tracks.js, routed by
// tools/algTracks.mjs over the real ground, painted and rutted in the map)
// as lines the game can ask about. Today the ALN lays its ambushes along
// them; patrols, convoys and mines will walk the same lines.
import { TRACKS } from "./tracks.js";

/** Catmull-Rom through the control points, every `step` metres. */
function resample(pts, step) {
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    const n = Math.max(2, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / step));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      const cr = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (-a + 3 * b - 3 * c + d) * t * t * t);
      out.push({ x: cr(p0[0], p1[0], p2[0], p3[0]), z: cr(p0[1], p1[1], p2[1], p3[1]) });
    }
  }
  const e = pts[pts.length - 1];
  out.push({ x: e[0], z: e[1] });
  return out;
}

/** Every track as { name, kind, length, line: [{x, z}] every 4 m }. */
export const TRACK_LINES = TRACKS.map((t) => ({ name: t.name, kind: t.kind, length: t.length, line: resample(t.points, 4) }));

/**
 * The nearest track point to (x, z): { track, i, x, z, d } — `i` its index
 * along `track.line`. `kind` limits it to "piste" or "mule". Null if none.
 */
export function nearestTrack(x, z, kind = null) {
  let best = null;
  for (const t of TRACK_LINES) {
    if (kind && t.kind !== kind) continue;
    t.line.forEach((p, i) => {
      const d = Math.hypot(p.x - x, p.z - z);
      if (!best || d < best.d) best = { track: t, i, x: p.x, z: p.z, d };
    });
  }
  return best;
}
