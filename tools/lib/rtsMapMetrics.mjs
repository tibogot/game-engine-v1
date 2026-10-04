/**
 * The three numbers that say whether an RTS map plays
 * (proj_v3_rts_terrain_recipe): slope histogram + walkable %, walkable share
 * per tile on a 4×4 grid (dead corners), and the biggest CONNECTED gentle
 * patch — whether an army can manoeuvre.
 *
 * `h` is heights in METRES on an N×N grid covering `world` metres.
 * `seaLevel` / `seaMask` (optional): cells at or below the level, or set in
 * the mask (1 = sea), are SEA — left out of every
 * number (the flat sea would read as perfect walkable ground otherwise).
 */
export const NAV_MAX_SLOPE_DEG = 34;   // games/nam-rts/navGrid.js
export const GENTLE_DEG = 15;

export function measureRtsMap(h, N, world, { seaLevel = -Infinity, seaMask = null } = {}) {
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
  const sea = seaMask ? (k) => seaMask[k] === 1 : (k) => h[k] <= seaLevel;
  let walk = 0, flat = 0, land = 0;
  for (let k = 0; k < N * N; k++) {
    if (sea(k)) continue;
    const s = slope[k];
    land++;
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
      for (let i = Math.round(ti * T); i < Math.round((ti + 1) * T); i++) for (let j = Math.round(tj * T); j < Math.round((tj + 1) * T); j++) { if (sea(i * N + j)) continue; n++; if (slope[i * N + j] <= NAV_MAX_SLOPE_DEG) w++; }
      row.push(n ? Math.round((100 * w) / n) : -1);
    }
    tiles.push(row);
  }
  // Biggest connected gentle patch (4-neighbour flood fill).
  const label = new Int32Array(N * N);
  const stack = new Int32Array(N * N);
  const gentle = (k) => slope[k] <= GENTLE_DEG && !sea(k);
  let best = 0, bestId = 0, id = 0;
  for (let s = 0; s < N * N; s++) {
    if (label[s] || !gentle(s)) continue;
    id++; let sp = 0, size = 0; stack[sp++] = s; label[s] = id;
    while (sp) {
      const c = stack[--sp]; size++;
      const ci = (c / N) | 0, cj = c - ci * N;
      if (cj > 0 && !label[c - 1] && gentle(c - 1)) { label[c - 1] = id; stack[sp++] = c - 1; }
      if (cj < N - 1 && !label[c + 1] && gentle(c + 1)) { label[c + 1] = id; stack[sp++] = c + 1; }
      if (ci > 0 && !label[c - N] && gentle(c - N)) { label[c - N] = id; stack[sp++] = c - N; }
      if (ci < N - 1 && !label[c + N] && gentle(c + N)) { label[c + N] = id; stack[sp++] = c + N; }
    }
    if (size > best) { best = size; bestId = id; }
  }
  const area = cell * cell;
  return {
    slope, label, bestId, lo, hi, seaLevel,
    landPct: (100 * land) / (N * N), landHa: (land * area) / 1e4,
    walkPct: (100 * walk) / land, flatPct: (100 * flat) / land,
    patchHa: (best * area) / 1e4, mapHa: (N * N * area) / 1e4,
    hist: bins.map((b, k) => `≤${b}°:${((100 * hist[k]) / land).toFixed(1)}%`),
    tiles,
  };
}

export function printRtsMetrics(m, label = "") {
  if (label) console.log(`\n── ${label}`);
  console.log(`height ${m.lo.toFixed(1)}–${m.hi.toFixed(1)} m`);
  if (m.landPct < 100) console.log(`SEA${Number.isFinite(m.seaLevel) ? ` below ${m.seaLevel.toFixed(1)} m` : ""}: land ${m.landPct.toFixed(1)}% (${m.landHa.toFixed(1)} ha) — every % below is of LAND only`);
  console.log(`walkable ${m.walkPct.toFixed(1)}%   gentle ≤${GENTLE_DEG}° ${m.flatPct.toFixed(1)}%   biggest connected gentle patch ${m.patchHa.toFixed(1)} of ${m.mapHa.toFixed(0)} ha`);
  console.log(m.hist.join("  "));
  console.log("walkable % by tile (north row first):");
  for (const row of m.tiles) console.log("  " + row.map((v) => (v < 0 ? " sea" : String(v).padStart(4))).join(""));
}
