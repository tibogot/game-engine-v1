/**
 * Global hydraulic erosion — the v2 droplet sim (`v2/core/terrain/erosionBrush.js`
 * `applyGlobalErosionToTerrain`) rebased onto v3's flat heightmap grid. All of
 * v2's chunk-seam bookkeeping (shared-vertex propagation, touched-key tracking)
 * is gone: v3's heightmap is a single row-major array.
 *
 * The sim expects heights in METRES — v2's tuned constants (capacity, gravity,
 * min-slope, deposit epsilon) are metre-scale. v3 stores normalized heights
 * (value × MAX_HEIGHT = metres), so callers convert to a metres working copy,
 * run the sim, and normalize back; see the Run Erosion handler in main.js.
 */

const GRAVITY = 4;
const MIN_SLOPE = 0.001;

/** v2 `toolState.erosion` defaults (v2/app/config.js), iterations rescaled for
 * v3's 1024² grid — v2-era 30k droplets only scratch ~3% of a map this size. */
export const EROSION_DEFAULTS = {
  iterations: 300000,
  erosionRate: 0.3,
  depositionRate: 0.3,
  evaporation: 0.015,
  inertia: 0.1,
  capacity: 6,
  radius: 3,
};

/** Cone-weighted deposit/erode kernel, normalized to sum 1 (v2 buildErosionKernel). */
export function buildErosionKernel(erRad) {
  const r = Math.ceil(erRad);
  const offX = [];
  const offZ = [];
  const w = [];
  let totalW = 0;
  for (let dz = -r; dz <= r; dz++) {
    for (let dx = -r; dx <= r; dx++) {
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist >= erRad) continue;
      const weight = erRad - dist;
      offX.push(dx);
      offZ.push(dz);
      w.push(weight);
      totalW += weight;
    }
  }
  for (let i = 0; i < w.length; i++) w[i] /= totalW;
  return { offX, offZ, w };
}

// Scratch for bilinear height + gradient samples (erodeDroplets is not reentrant).
const _s = { h: 0, gx: 0, gz: 0 };

function sampleHG(heights, size, px, pz) {
  const maxI = size - 1;
  const x0 = px | 0;
  const z0 = pz | 0;
  const x1 = x0 + 1 > maxI ? maxI : x0 + 1;
  const z1 = z0 + 1 > maxI ? maxI : z0 + 1;
  const tx = px - x0;
  const tz = pz - z0;
  const h00 = heights[z0 * size + x0];
  const h10 = heights[z0 * size + x1];
  const h01 = heights[z1 * size + x0];
  const h11 = heights[z1 * size + x1];
  _s.h =
    h00 * (1 - tx) * (1 - tz) +
    h10 * tx * (1 - tz) +
    h01 * (1 - tx) * tz +
    h11 * tx * tz;
  _s.gx = (h10 - h00) * (1 - tz) + (h11 - h01) * tz;
  _s.gz = (h01 - h00) * (1 - tx) + (h11 - h10) * tx;
}

function deposit(heights, size, px, pz, amt) {
  if (amt === 0) return;
  const maxI = size - 1;
  const x0 = px | 0;
  const z0 = pz | 0;
  const x1 = x0 + 1 > maxI ? maxI : x0 + 1;
  const z1 = z0 + 1 > maxI ? maxI : z0 + 1;
  const tx = px - x0;
  const tz = pz - z0;
  heights[z0 * size + x0] += amt * (1 - tx) * (1 - tz);
  heights[z0 * size + x1] += amt * tx * (1 - tz);
  heights[z1 * size + x0] += amt * (1 - tx) * tz;
  heights[z1 * size + x1] += amt * tx * tz;
}

function erodeAt(heights, size, px, pz, amt, kernel) {
  // Bilinear splat per kernel tap, mirroring deposit(). Centering the kernel
  // on the floored texel instead carves staircase channel walls as the
  // droplet's smooth path quantizes to texel centers.
  const maxI = size - 1;
  const { offX, offZ, w } = kernel;
  for (let i = 0; i < w.length; i++) {
    const ex = px + offX[i];
    const ez = pz + offZ[i];
    if (ex < 0 || ez < 0 || ex > maxI || ez > maxI) continue;
    deposit(heights, size, ex, ez, -amt * w[i]);
  }
}

/**
 * Run `count` droplets over `heights` (metres, size×size, row-major z·size+x).
 * Mutates in place. Droplets are independent, so callers can split a big run
 * into batches (yielding to the UI between them) with identical results.
 *
 * @param {Float32Array} heights — heightmap in metres, mutated in place
 * @param {number} size — texels per axis
 * @param {number} count — droplets to simulate
 * @param {{ erosionRate: number, depositionRate: number, evaporation: number,
 *           inertia: number, capacity: number }} params
 * @param {ReturnType<typeof buildErosionKernel>} kernel
 */
export function erodeDroplets(heights, size, count, params, kernel) {
  const Ke = params.erosionRate;
  const Kd = params.depositionRate;
  const Kev = params.evaporation;
  const Kin = params.inertia;
  const Kc = params.capacity;
  const maxG = size - 1;
  // Droplet lifetime scales with the grid — a fixed 80 steps (v2's constant,
  // tuned for smaller maps) chops channels into short disconnected gouges on
  // a 1024² grid. Evaporation still caps life at ~350 steps at default rate.
  const maxSteps = Math.max(80, (size * 0.3) | 0);

  for (let iter = 0; iter < count; iter++) {
    let px = 1 + Math.random() * (maxG - 2);
    let pz = 1 + Math.random() * (maxG - 2);
    let ddx = 0;
    let ddz = 0;
    let speed = 1;
    let water = 1;
    let sediment = 0;

    for (let step = 0; step < maxSteps; step++) {
      sampleHG(heights, size, px, pz);
      const h = _s.h;
      ddx = ddx * Kin - _s.gx * (1 - Kin);
      ddz = ddz * Kin - _s.gz * (1 - Kin);
      const len = Math.sqrt(ddx * ddx + ddz * ddz) || 1;
      ddx /= len;
      ddz /= len;
      const nx2 = px + ddx;
      const nz2 = pz + ddz;
      if (nx2 < 0 || nx2 >= maxG || nz2 < 0 || nz2 >= maxG) break;

      sampleHG(heights, size, nx2, nz2);
      const dh = _s.h - h;
      const cap = Math.max(MIN_SLOPE, -dh) * speed * water * Kc;
      if (sediment > cap || dh > 0) {
        const amt = dh > 0 ? Math.min(sediment, dh) : (sediment - cap) * Kd;
        sediment -= amt;
        deposit(heights, size, px, pz, amt);
      } else {
        const amt = Math.min((cap - sediment) * Ke, -dh + 0.001);
        sediment += amt;
        erodeAt(heights, size, px, pz, amt, kernel);
      }
      speed = Math.min(8, Math.sqrt(Math.max(0, speed * speed - dh * GRAVITY)));
      water *= 1 - Kev;
      if (water < 0.005) break;
      px = nx2;
      pz = nz2;
    }
    deposit(heights, size, px, pz, sediment * Kd);
  }
}

/**
 * Post-run hillslope smoothing: `passes` Laplacian diffusion sweeps (borders
 * pinned). Rounds off the texel-frequency noise droplets leave behind — the
 * end-of-life sediment dumps and carve edges — which otherwise reads as
 * faceted "low poly" normals at clipmap render time. `amount` must stay
 * < 0.25 for stability.
 */
export function smoothHeights(heights, size, passes, amount = 0.15) {
  if (passes <= 0) return;
  const temp = new Float32Array(heights.length);
  const last = size - 1;
  for (let p = 0; p < passes; p++) {
    for (let z = 1; z < last; z++) {
      const row = z * size;
      for (let x = 1; x < last; x++) {
        const i = row + x;
        const h = heights[i];
        temp[i] =
          h +
          amount *
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
