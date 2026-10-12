/**
 * TRACKS CARVED INTO THE GROUND (2026-10-12, you: "the path looks flat — shouldn't it carve the
 * terrain a bit?"), for the level tools (the coast first; the camp and the Aurès to follow). A track
 * was only PAINT and rut decals: flat stripes, and on a slope plainly wrong (a truck track cut into
 * a hillside makes a level shelf). The heightmap is 1 m a point — too coarse for ruts (those stay
 * the decals' and the ground's detail); what it CAN carry is the track's PROFILE:
 *
 *   the ROAD LEVEL   the natural ground under the centre line, averaged over ±`smooth` m ALONG it —
 *                    smooth along, LEVEL ACROSS: on flat ground a trough, on a slope CUT into the
 *                    hillside uphill and FILLED downhill (the real mountain piste's shelf)
 *   the running surface   `half` m each side, a shallow hollow (`dip` m at the middle)
 *   the edge         a low bank (`berm` m) just past it — the dust and stones a track throws aside
 *   the SHOULDER     back to the natural ground, wider where the cut / fill is deeper (a batter)
 *
 * `field(x, z)` → { d, px, pz, tx, tz } (distance, nearest centre-line point, unit tangent).
 */
const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export const PISTE = { half: 2.6, dip: 0.22, berm: 0.1, shoulder: 2.5, batter: 1.6, smooth: 8 };

/**
 * @param {(x, z) => number} base   the natural ground height (m)
 * @param {(x, z) => object} field  the track's distance field (see above)
 * @param {object} [P]              the profile (PISTE)
 * @returns {(x, z, h) => number}   the carved height at (x, z), given the natural height h there
 */
export function trackCarver(base, field, P = PISTE) {
  const reach = P.half + P.shoulder + P.batter * 4 + 1;
  return (x, z, h) => {
    const f = field(x, z, reach + 2);
    if (!(f.d < reach)) return h;
    // the road level: the natural ground along the centre line, averaged (weights 1-2-3-2-1)
    let sum = 0, w = 0;
    for (const [k, wk] of [[-1, 1], [-0.5, 2], [0, 3], [0.5, 2], [1, 1]]) {
      sum += base(f.px + f.tx * k * P.smooth, f.pz + f.tz * k * P.smooth) * wk; w += wk;
    }
    const road = sum / w;
    // the shoulder: wider where the ground stands far from the road level (a deep cut / fill)
    const sh = P.shoulder + P.batter * Math.abs(h - road);
    const d = f.d;
    if (d > P.half + sh) return h;
    const surface = road - P.dip * (1 - smoothstep(0, P.half, d) ** 2);   // the hollow, deepest at the middle
    const bank = P.berm * Math.exp(-(((d - P.half - 0.7) / 0.6) ** 2));   // the low bank at the edge
    const t = smoothstep(P.half, P.half + sh, d);                           // 0 on the road → 1 natural
    return (d <= P.half ? surface : road - 0 + (h - road) * t) + bank;
  };
}
