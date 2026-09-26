/**
 * The three numbers that say whether an RTS map plays
 * (proj_v3_rts_terrain_recipe): slope histogram + walkable %, walkable share
 * per tile on a 4×4 grid (dead corners), and the biggest CONNECTED gentle
 * patch — whether an army can manoeuvre.
 *
 * `h` is heights in METRES on an N×N grid covering `world` metres.
 */
export const NAV_MAX_SLOPE_DEG = 34;   // games/nam-rts/navGrid.js
export const GENTLE_DEG = 15;

export function measureRtsMap(h, N, world) {
  const cell = world / (N - 1);
  const slope = new Float32Array(N * N);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    const j0 = Math.max(j - 1, 0), j1 = Math.min(j + 1, N - 1);
    const i0 = Math.max(i - 1, 0), i1 = Math.min(i + 1, N - 1);
    const gx = (h[i * N + j1] - h[i * N + j0]) / (cell * (j1 - j0));
    const gz = (h[i1 * N + j] - h[i0 * N + j]) / (cell * (i1 - i0));
    slope[i * N + j] = (Math.atan(Math.hypot(gx, gz)) * 180) / Math.PI;
    const v = h[i * N + j];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const bins = [5, 10, 15, 20, 25, 30, 34, 40, 50, 90];
  const hist = new Array(bins.length).fill(0);
  let walk = 0, flat = 0;
  for (const s of slope) {
    hist[bins.findIndex((b) => s <= b)]++;
    if (s <= NAV_MAX_SLOPE_DEG) walk++;
    if (s <= GENTLE_DEG) flat++;
  }
  const tiles = [];
  const T = N / 4;
  for (let ti = 0; ti < 4; ti++) {
    const row = [];
    for (let tj = 0; tj < 4; tj++) {
      let w = 0, n = 0;
      for (let i = ti * T; i < (ti + 1) * T; i++) for (let j = tj * T; j < (tj + 1) * T; j++) { n++; if (slope[i * N + j] <= NAV_MAX_SLOPE_DEG) w++; }
      row.push(Math.round((100 * w) / n));
    }
    tiles.push(row);
  }
  // Biggest connected gentle patch (4-neighbour flood fill).
  const label = new Int32Array(N * N);
  const stack = new Int32Array(N * N);
  let best = 0, bestId = 0, id = 0;
  for (let s = 0; s < N * N; s++) {
    if (label[s] || slope[s] > GENTLE_DEG) continue;
    id++; let sp = 0, size = 0; stack[sp++] = s; label[s] = id;
    while (sp) {
      const c = stack[--sp]; size++;
      const ci = (c / N) | 0, cj = c - ci * N;
      if (cj > 0 && !label[c - 1] && slope[c - 1] <= GENTLE_DEG) { label[c - 1] = id; stack[sp++] = c - 1; }
      if (cj < N - 1 && !label[c + 1] && slope[c + 1] <= GENTLE_DEG) { label[c + 1] = id; stack[sp++] = c + 1; }
      if (ci > 0 && !label[c - N] && slope[c - N] <= GENTLE_DEG) { label[c - N] = id; stack[sp++] = c - N; }
      if (ci < N - 1 && !label[c + N] && slope[c + N] <= GENTLE_DEG) { label[c + N] = id; stack[sp++] = c + N; }
    }
    if (size > best) { best = size; bestId = id; }
  }
  const area = cell * cell;
  return {
    slope, label, bestId, lo, hi,
    walkPct: (100 * walk) / (N * N), flatPct: (100 * flat) / (N * N),
    patchHa: (best * area) / 1e4, mapHa: (N * N * area) / 1e4,
    hist: bins.map((b, k) => `≤${b}°:${((100 * hist[k]) / (N * N)).toFixed(1)}%`),
    tiles,
  };
}

export function printRtsMetrics(m, label = "") {
  if (label) console.log(`\n── ${label}`);
  console.log(`height ${m.lo.toFixed(1)}–${m.hi.toFixed(1)} m`);
  console.log(`walkable ${m.walkPct.toFixed(1)}%   gentle ≤${GENTLE_DEG}° ${m.flatPct.toFixed(1)}%   biggest connected gentle patch ${m.patchHa.toFixed(1)} of ${m.mapHa.toFixed(0)} ha`);
  console.log(m.hist.join("  "));
  console.log("walkable % by tile (north row first):");
  for (const row of m.tiles) console.log("  " + row.map((v) => String(v).padStart(4)).join(""));
}
