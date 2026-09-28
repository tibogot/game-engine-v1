// OCEAN PRO — the shore wave field (part of the "pro" ocean mode, v3/render/oceanpro/). Port of
// Tidewater's world/ShoreField.js (MIT, Copyright (c) 2026 DRG Software Solutions LLC — see
// v3/skypro-real/tidewater/LICENSE). The solver is Tidewater's; changes are marked `// PORT:`.
//
// Offline wave-propagation field for shoreline waves. Solves the Eikonal equation |grad T| = 1 / c(x)
// with the Fast Marching Method, where c = sqrt(g * depth) is the shallow-water wave speed (capped
// offshore). Sources are the domain borders initialized with a plane wave travelling along
// `swellDir`, so wave fronts refract naturally around headlands and align with the depth contours
// near the beach.
//
// Output (RGBA float, res x res over the domain):
//   r = arrival time T (s), g,b = propagation direction * exposure (length = exposure 0..1),
//   a = arrival time at the nearest shoreline (extended onto land for swash timing)
//
// PORT: the domain is the engine's heightmap plus a SHELF margin all round, over which the floor
// falls to open-ocean depth exactly as the water shader assumes (oceanproShader.js terrainHeightAt),
// so the swell comes in from deep water on every side and the field and the water agree.

const GRAVITY = 9.81;
export const SHELF = 400; // m (oceanproShader.js OP_SHELF)
export const DEEP = -300; // m (oceanproShader.js OP_DEEP)

class MinHeap {
  constructor(cap) {
    this.keys = new Float64Array(cap);
    this.vals = new Int32Array(cap);
    this.size = 0;
  }

  push(k, v) {
    let i = this.size++;
    const keys = this.keys, vals = this.vals;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= k) break;
      keys[i] = keys[p]; vals[i] = vals[p];
      i = p;
    }
    keys[i] = k; vals[i] = v;
  }

  pop() {
    const keys = this.keys, vals = this.vals;
    const top = vals[0];
    const k = keys[--this.size], v = vals[this.size];
    let i = 0;
    const n = this.size;
    while (true) {
      let c = 2 * i + 1;
      if (c >= n) break;
      if (c + 1 < n && keys[c + 1] < keys[c]) c++;
      if (keys[c] >= k) break;
      keys[i] = keys[c]; vals[i] = vals[c];
      i = c;
    }
    keys[i] = k; vals[i] = v;
    return top;
  }
}

/**
 * PORT: the terrain as the water sees it — our normalised heightmap (row = +z, uv = xz / size + 0.5)
 * in metres, and beyond it the shelf falling to DEEP (the same rule as the shader).
 */
export function makeHeightAt({ heights, size, terrainSize, maxHeight, heightBase = 0 }) {
  const half = terrainSize / 2;
  const inside = (x, z) => {
    const fx = Math.min(Math.max((x / terrainSize + 0.5) * size - 0.5, 0), size - 1.001);
    const fz = Math.min(Math.max((z / terrainSize + 0.5) * size - 0.5, 0), size - 1.001);
    const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j;
    const k = j * size + i;
    const a = heights[k], b = heights[k + 1], c = heights[k + size], d = heights[k + size + 1];
    return ((a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz) * maxHeight + heightBase;
  };
  return (x, z) => {
    const h = inside(x, z);
    const ex = Math.max(Math.abs(x) - half, 0), ez = Math.max(Math.abs(z) - half, 0);
    const out = Math.hypot(ex, ez);
    if (out <= 0) return h;
    const t = Math.min(out / SHELF, 1);
    const s = t * t * (3 - 2 * t);
    return h + (Math.min(h, DEEP) - h) * s;
  };
}

/**
 * @param {object} terrain  { heightAt(x, z), origin, size } (PORT: origin / size of the domain)
 * @param {object} [o]      res, swellDir [x, z] (travel direction), seaLevel, maxDepth, minDepth
 */
export function computeShoreField(terrain, { res = 512, swellDir = [0, -1], seaLevel = 0, maxDepth = 25, minDepth = 0.25 } = {}) {
  const size = terrain.size;
  const origin = terrain.origin;
  const h = size / res;
  const N = res * res;

  const depth = new Float32Array(N);
  const speed = new Float32Array(N);
  for (let j = 0; j < res; j++) {
    const z = origin + (j + 0.5) * h;
    for (let i = 0; i < res; i++) {
      const x = origin + (i + 0.5) * h;
      const d = seaLevel - terrain.heightAt(x, z);
      depth[j * res + i] = d;
    }
  }
  // PORT: the wave speed comes from a blurred depth (land stays land). Tidewater's seabed is smooth
  // sand; a game heightmap point-sampled every few metres gives a speed with cell-scale noise, and
  // the arrival time inherits kinks that tear a plunging crest into a sawtooth (the face's sideways
  // throw swings over a few cm of phase).
  let db = depth;
  for (let it = 0; it < 6; it++) {
    const out = new Float32Array(N);
    for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) {
      const k = j * res + i;
      let s = db[k] * 2, w = 2;
      if (i > 0) { s += db[k - 1]; w++; }
      if (i < res - 1) { s += db[k + 1]; w++; }
      if (j > 0) { s += db[k - res]; w++; }
      if (j < res - 1) { s += db[k + res]; w++; }
      out[k] = s / w;
    }
    db = out;
  }
  for (let k = 0; k < N; k++) {
    speed[k] = depth[k] > 0 ? Math.sqrt(GRAVITY * Math.min(Math.max(db[k], minDepth), maxDepth)) : 0;
  }

  const T = new Float32Array(N).fill(Infinity);
  const state = new Uint8Array(N); // 0 far, 1 trial, 2 known
  const heap = new MinHeap(N * 4);
  const [sdx, sdz] = swellDir;
  const c0 = Math.sqrt(GRAVITY * maxDepth);

  // plane-wave initial condition on the border water cells
  for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) {
    if (i !== 0 && j !== 0 && i !== res - 1 && j !== res - 1) continue;
    const k = j * res + i;
    if (speed[k] <= 0) continue;
    const x = origin + (i + 0.5) * h, z = origin + (j + 0.5) * h;
    T[k] = (x * sdx + z * sdz) / c0 + size; // offset keeps T positive
    state[k] = 1;
    heap.push(T[k], k);
  }

  const solve = (i, j) => {
    const k = j * res + i;
    const c = speed[k];
    if (c <= 0) return Infinity;
    const f = h / c;
    const tx = Math.min(
      i > 0 && state[k - 1] === 2 ? T[k - 1] : Infinity,
      i < res - 1 && state[k + 1] === 2 ? T[k + 1] : Infinity);
    const tz = Math.min(
      j > 0 && state[k - res] === 2 ? T[k - res] : Infinity,
      j < res - 1 && state[k + res] === 2 ? T[k + res] : Infinity);
    const a = Math.min(tx, tz), b = Math.max(tx, tz);
    if (!isFinite(b) || b - a >= f) return a + f;
    return 0.5 * (a + b + Math.sqrt(2 * f * f - (a - b) * (a - b)));
  };

  while (heap.size > 0) {
    const k = heap.pop();
    if (state[k] === 2) continue;
    state[k] = 2;
    const i = k % res, j = (k / res) | 0;
    // (PORT: the four neighbours unrolled — Tidewater allocates an array of pairs per cell)
    for (let q = 0; q < 4; q++) {
      const ni = q === 0 ? i - 1 : q === 1 ? i + 1 : i;
      const nj = q === 2 ? j - 1 : q === 3 ? j + 1 : j;
      if (ni < 0 || nj < 0 || ni >= res || nj >= res) continue;
      const nk = nj * res + ni;
      if (state[nk] === 2 || speed[nk] <= 0) continue;
      const t = solve(ni, nj);
      if (t < T[nk]) {
        T[nk] = t;
        state[nk] = 1;
        heap.push(t, nk);
      }
    }
  }

  // Extend a field onto land one ring of cells per pass (average of the known neighbours + inc).
  // Each pass reads the previous pass only: filling in place while scanning would let values from
  // far away (e.g. the other side of the island) sweep across the land in a single pass.
  const extend = (F, passes, inc) => {
    const prev = new Float32Array(N);
    for (let pass = 0; pass < passes; pass++) {
      prev.set(F);
      let changed = false;
      for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) {
        const k = j * res + i;
        if (isFinite(prev[k])) continue;
        let s = 0, n = 0;
        if (i > 0 && isFinite(prev[k - 1])) { s += prev[k - 1]; n++; }
        if (i < res - 1 && isFinite(prev[k + 1])) { s += prev[k + 1]; n++; }
        if (j > 0 && isFinite(prev[k - res])) { s += prev[k - res]; n++; }
        if (j < res - 1 && isFinite(prev[k + res])) { s += prev[k + res]; n++; }
        if (n > 0) { F[k] = s / n + inc; changed = true; }
      }
      if (!changed) break;
    }
  };

  // arrival time at the nearest shoreline, extended unchanged onto land (swash timing)
  const Tshore = new Float32Array(T);
  extend(Tshore, 40, 0);

  // extend T onto land (so the swash zone has a continuous phase), continuing slowly up the beach
  const Tfilled = new Float32Array(T);
  extend(Tfilled, 24, h / 1.5);

  // smooth to remove first-order FMM kinks (keeps phase monotonic)
  let Ts = Tfilled;
  for (let it = 0; it < 3; it++) {
    const out = new Float32Array(N);
    for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) {
      const k = j * res + i;
      if (!isFinite(Ts[k])) { out[k] = Ts[k]; continue; }
      let s = Ts[k] * 4, w = 4;
      if (i > 0 && isFinite(Ts[k - 1])) { s += Ts[k - 1]; w++; }
      if (i < res - 1 && isFinite(Ts[k + 1])) { s += Ts[k + 1]; w++; }
      if (j > 0 && isFinite(Ts[k - res])) { s += Ts[k - res]; w++; }
      if (j < res - 1 && isFinite(Ts[k + res])) { s += Ts[k + res]; w++; }
      out[k] = s / w;
    }
    Ts = out;
  }

  // directions + exposure
  const data = new Float32Array(N * 4);
  const sl = Math.hypot(sdx, sdz);
  for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) {
    const k = j * res + i;
    const t = Ts[k];
    const g = (a, b) => (isFinite(a) && isFinite(b)) ? (a - b) : 0;
    const tl = i > 0 ? Ts[k - 1] : t, tr = i < res - 1 ? Ts[k + 1] : t;
    const td = j > 0 ? Ts[k - res] : t, tu = j < res - 1 ? Ts[k + res] : t;
    let gx = g(tr, tl), gz = g(tu, td);
    if (gx === 0 && isFinite(tr) && isFinite(t)) gx = tr - t;
    if (gz === 0 && isFinite(tu) && isFinite(t)) gz = tu - t;
    const len = Math.hypot(gx, gz) || 1;
    const dx = gx / len, dz = gz / len;
    // exposure: how directly the local wave direction faces the incoming swell
    const align = (dx * sdx + dz * sdz) / sl;
    const exposure = Math.min(1, Math.max(0.02, align * 1.4 + 0.1));
    // direction scaled by exposure (length = exposure), alpha = shoreline arrival time
    data[k * 4] = isFinite(t) ? t : 1e5;
    data[k * 4 + 1] = dx * exposure;
    data[k * 4 + 2] = dz * exposure;
    data[k * 4 + 3] = isFinite(Tshore[k]) ? Tshore[k] : (isFinite(t) ? t : 1e5);
  }

  return { data, res, cellSize: h, origin, size, depth };
}
