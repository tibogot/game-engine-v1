// THE FAR MOUNTAINS — the REAL Aurès round the battlefield. The map was cut
// from real elevation (tools/algDem.mjs, site "aures-tighanimine": 35.215 N,
// 6.300 E, 4 km of country in 1024 m, relief ×0.6); the country round it is
// the same data, squeezed the same way (tools/algMountains.mjs fits the
// transform on the map itself), so the ridges beyond the edge are the ones
// that really stand there — the massif to the north-west, the Oued el Abiod's
// side, the long ridges of the Aurès — not invented ones.
//
// tools/algMountains.mjs raises the map's own outer ring (between the PLAY box
// and the 1 km edge) back to your eroded ground, and writes the FAR GRID into
// the project, which the engine's terrain draws past the edge out to the
// horizon (v3/terrain/farTerrain.js) — in the editor and in the game.
//
// Plain JS (no three): the tool runs it in Node.
import { LAYOUT } from "./layout.js";

/**
 * The far grid: FAR.n × FAR.n Float32 heights in map metres (the map's own
 * transform, the wadis' gaps carved), covering ±FAR.extent map metres round
 * the map centre, row 0 = north (−z), as the heightmap.
 */
export const FAR = { n: 1024, extent: 3900 };

const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/**
 * THE WADIS' GAPS: our two wadis (layout.js, carved by tools/algWadi.mjs) are
 * the map's, not the data's — each runs on out of the map along its last leg
 * (3 km), and the ground is lowered along it: 0.15 of its height in the bed,
 * back to 1 over ~120 m either side. So an oued never ends against a real
 * ridge at the map's edge.
 */
const WADI_LINES = LAYOUT.wadis.map((w) => {
  const P = w.points.map(([x, z]) => [x, z]);
  const [ax, az] = P[P.length - 2], [bx, bz] = P[P.length - 1], L = Math.hypot(bx - ax, bz - az);
  P.push([bx + ((bx - ax) / L) * 3000, bz + ((bz - az) / L) * 3000]);
  return P;
});
export function valleyFactor(x, z) {
  let d = Infinity;
  for (const P of WADI_LINES) {
    for (let i = 0; i < P.length - 1; i++) {
      const [ax, az] = P[i], [bx, bz] = P[i + 1], dx = bx - ax, dz = bz - az;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)));
      d = Math.min(d, Math.hypot(x - ax - dx * t, z - az - dz * t));
    }
  }
  return 0.15 + 0.85 * smooth((d - 12) / 110);
}
