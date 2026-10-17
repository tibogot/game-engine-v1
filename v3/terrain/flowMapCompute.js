// flowMap.js's pure compute (no three.js): the worker and the tests import it.
const SORT_BUCKETS = 65536;
const FLOW_EXP = 1.1;          // Freeman's slope exponent: ~1 spreads, higher follows the steepest
const DIAG = Math.SQRT1_2;     // a diagonal neighbour is √2 away

/**
 * The flow bytes for `heights` (size², row-major z·size + x, any unit — only
 * the order and the drops matter) into `out` (Uint8Array size²). Pure: the
 * worker and the tests call it.
 */
export function computeFlowBytes(heights, size, out) {
  const n = size * size;
  const acc = new Float32Array(n), sorted = new Uint32Array(n), counts = new Uint32Array(SORT_BUCKETS);

  let minH = Infinity, maxH = -Infinity;
  for (let i = 0; i < n; i++) { const h = heights[i]; if (h < minH) minH = h; if (h > maxH) maxH = h; }
  const scale = maxH > minH ? (SORT_BUCKETS - 1) / (maxH - minH) : 0;
  for (let i = 0; i < n; i++) counts[((heights[i] - minH) * scale) | 0]++;
  for (let b = 0, sum = 0; b < SORT_BUCKETS; b++) { const c = counts[b]; counts[b] = sum; sum += c; }
  for (let i = 0; i < n; i++) sorted[counts[((heights[i] - minH) * scale) | 0]++] = i;

  acc.fill(1);
  const last = size - 1;
  const wts = new Float32Array(8), nbr = new Int32Array(8);
  // High → low: every donor has handed on its water before its receivers do.
  for (let k = n - 1; k >= 0; k--) {
    const i = sorted[k];
    const x = i % size, z = (i / size) | 0;
    if (x === 0 || z === 0 || x === last || z === last) continue;   // the map's edge is the outlet
    const h = heights[i];
    let m = 0, sum = 0;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dz) continue;
        const j = i + dz * size + dx;
        const drop = (h - heights[j]) * (dx && dz ? DIAG : 1);
        if (drop <= 0) continue;
        const w = Math.pow(drop, FLOW_EXP);
        wts[m] = w; nbr[m] = j; m++; sum += w;
      }
    }
    if (!m) continue;                                                 // a pit: the water stays
    const a = acc[i] / sum;
    for (let q = 0; q < m; q++) acc[nbr[q]] += a * wts[q];
  }

  // log2(cells) → a byte, through a 3×3 MAX: a drainage line is one or two
  // texels wide, and a box blur averaged it with its dry banks (measured:
  // lines at 8-11 octaves came out at ~5). The max widens it to ~3 texels at
  // full value; the shader's bilinear read softens the edges.
  for (let i = 0; i < n; i++) acc[i] = Math.log2(acc[i]);
  for (let z = 0; z < size; z++) {
    for (let x = 0; x < size; x++) {
      let m = 0;
      for (let dz = -1; dz <= 1; dz++) {
        const zz = z + dz; if (zz < 0 || zz > last) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx; if (xx < 0 || xx > last) continue;
          const v = acc[zz * size + xx]; if (v > m) m = v;
        }
      }
      out[z * size + x] = Math.min(255, Math.round(m * 16));
    }
  }
  return out;
}
