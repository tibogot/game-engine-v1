/**
 * Global fluvial erosion via the stream power law (Braun & Willett 2013
 * "Fastscape" implicit scheme). Carves a coherent dendritic drainage network —
 * the whole-terrain valley/ridge look the droplet sim (globalErosion.js)
 * cannot produce, because here every texel knows its upstream drainage area.
 *
 * Per iteration:
 *   1. flow routing — steepest-descent (D8) receiver per texel
 *   2. drainage area — accumulated downstream in height order
 *   3. incision — implicit update h = (h + f·h_rcv) / (1 + f) with f ∝ √area,
 *      processed upstream so the receiver's NEW height is used; this is
 *      unconditionally stable and can never cut a cell below its receiver
 *   4. optional uplift, then hillslope diffusion (keeps ridges from spiking)
 *
 * Local minima stay their own receivers (no lake spill-over routing) — the
 * diffusion pass and a droplet-sim run on top take care of small pits.
 *
 * Heights are in METRES, same caller contract as globalErosion.js: convert
 * from normalized, run, normalize back. Border texels are the base level —
 * they route flow out but are never eroded or uplifted.
 */

const SORT_BUCKETS = 65536;
const DIAG_FAC = Math.SQRT1_2; // dx/dist for diagonal neighbours

export const STREAM_POWER_DEFAULTS = {
  iterations: 120,
  strength: 0.01, // f multiplier per √(cells drained)
  uplift: 0, // metres added per iteration (interior only)
  smoothing: 0.05, // hillslope diffusion coefficient per iteration
};

/** Reusable working buffers so batched runs don't reallocate ~24MB per call. */
export function createStreamPowerScratch(size) {
  const n = size * size;
  return {
    rcv: new Int32Array(n), // steepest-descent receiver index (self = outlet/pit)
    recFac: new Float32Array(n), // dx/dist to receiver (1 or 1/√2)
    area: new Float32Array(n), // drainage area in cell units
    sorted: new Uint32Array(n), // texel indices, ascending by height
    counts: new Uint32Array(SORT_BUCKETS),
    temp: new Float32Array(n),
  };
}

/** Counting sort of all texels by height (16-bit quantized), ascending. */
function sortByHeight(heights, n, scratch) {
  const { sorted, counts } = scratch;
  let minH = Infinity;
  let maxH = -Infinity;
  for (let i = 0; i < n; i++) {
    const h = heights[i];
    if (h < minH) minH = h;
    if (h > maxH) maxH = h;
  }
  const scale = maxH > minH ? (SORT_BUCKETS - 1) / (maxH - minH) : 0;
  counts.fill(0);
  for (let i = 0; i < n; i++) {
    counts[((heights[i] - minH) * scale) | 0]++;
  }
  let sum = 0;
  for (let b = 0; b < SORT_BUCKETS; b++) {
    const c = counts[b];
    counts[b] = sum;
    sum += c;
  }
  for (let i = 0; i < n; i++) {
    sorted[counts[((heights[i] - minH) * scale) | 0]++] = i;
  }
}

/** Steepest-descent D8 receiver for every texel; borders are outlets (self). */
function routeFlow(heights, size, scratch) {
  const { rcv, recFac } = scratch;
  const last = size - 1;
  for (let z = 0; z < size; z++) {
    for (let x = 0; x < size; x++) {
      const i = z * size + x;
      if (x === 0 || x === last || z === 0 || z === last) {
        rcv[i] = i;
        continue;
      }
      const h = heights[i];
      let best = 0;
      let bestI = i;
      let bestFac = 1;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dz === 0) continue;
          const j = i + dz * size + dx;
          const fac = dx !== 0 && dz !== 0 ? DIAG_FAC : 1;
          const drop = (h - heights[j]) * fac;
          if (drop > best) {
            best = drop;
            bestI = j;
            bestFac = fac;
          }
        }
      }
      rcv[i] = bestI;
      recFac[i] = bestFac;
    }
  }
}

/**
 * Run `count` stream-power iterations over `heights` (metres, size×size,
 * row-major z·size+x). Mutates in place; state lives entirely in `heights`,
 * so callers can split a run into batches (yielding to the UI) freely.
 *
 * @param {Float32Array} heights — heightmap in metres, mutated in place
 * @param {number} size — texels per axis
 * @param {number} count — iterations to run
 * @param {{ strength: number, uplift: number, smoothing: number }} params
 * @param {ReturnType<typeof createStreamPowerScratch>} scratch
 */
export function streamPowerErode(heights, size, count, params, scratch) {
  const n = size * size;
  const { rcv, recFac, area, sorted, temp } = scratch;
  const K = params.strength;
  const uplift = params.uplift;
  const D = params.smoothing;
  const last = size - 1;

  for (let iter = 0; iter < count; iter++) {
    routeFlow(heights, size, scratch);
    sortByHeight(heights, n, scratch);

    // Drainage area: sweep high → low so every donor is added before its
    // receiver is itself drained further downstream.
    area.fill(1);
    for (let k = n - 1; k >= 0; k--) {
      const i = sorted[k];
      const r = rcv[i];
      if (r !== i) area[r] += area[i];
    }

    // Implicit incision, low → high: receivers (always lower) already hold
    // their post-incision height when their donors are processed.
    for (let k = 0; k < n; k++) {
      const i = sorted[k];
      const r = rcv[i];
      if (r === i) continue;
      const f = K * Math.sqrt(area[i]) * recFac[i];
      heights[i] = (heights[i] + f * heights[r]) / (1 + f);
    }

    if (uplift > 0) {
      // Feather uplift to zero near the map edge — borders are fixed base
      // level, and full-strength uplift beside them builds a rim cliff.
      const feather = Math.min(32, size >> 3);
      for (let z = 1; z < last; z++) {
        const row = z * size;
        for (let x = 1; x < last; x++) {
          const edge = Math.min(x, z, last - x, last - z);
          let t = edge >= feather ? 1 : edge / feather;
          t = t * t * (3 - 2 * t);
          heights[row + x] += uplift * t;
        }
      }
    }

    if (D > 0) {
      for (let z = 1; z < last; z++) {
        const row = z * size;
        for (let x = 1; x < last; x++) {
          const i = row + x;
          const h = heights[i];
          temp[i] =
            h +
            D *
              (heights[i - 1] +
                heights[i + 1] +
                heights[i - size] +
                heights[i + size] -
                4 * h);
        }
      }
      for (let z = 1; z < last; z++) {
        const row = z * size;
        for (let x = 1; x < last; x++) heights[row + x] = temp[row + x];
      }
    }
  }
}
