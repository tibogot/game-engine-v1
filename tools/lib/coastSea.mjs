/**
 * THE SEA of a map cut from real elevation (tools/algDem.mjs): low ground
 * joined to the map edge (Terrarium reads the sea as ~0 m with noise), plus
 * the low specks of "land" out in it (the noise) — islands under 3 ha that
 * never rise 3 m over the sea. Low hollows inland stay land.
 *
 * `h`: heights in metres, N×N over `world` m. Returns a Uint8Array, 1 = sea.
 */
export function coastSeaMask(h, N, world, seaLevel) {
  const sea = new Uint8Array(N * N);
  if (seaLevel == null) return sea;
  const cell = world / (N - 1), cellHa = (cell * cell) / 1e4;
  const stack = new Int32Array(N * N);
  let sp = 0;
  const push = (k) => { if (!sea[k] && h[k] <= seaLevel) { sea[k] = 1; stack[sp++] = k; } };
  for (let t = 0; t < N; t++) { push(t); push((N - 1) * N + t); push(t * N); push(t * N + N - 1); }
  while (sp) {
    const c = stack[--sp], i = (c / N) | 0, j = c - i * N;
    if (j > 0) push(c - 1); if (j < N - 1) push(c + 1); if (i > 0) push(c - N); if (i < N - 1) push(c + N);
  }
  const lab = new Int32Array(N * N);
  let id = 0;
  for (let s = 0; s < N * N; s++) {
    if (sea[s] || lab[s]) continue;
    id++; const cells = []; let hi = -Infinity; sp = 0; stack[sp++] = s; lab[s] = id;
    while (sp) {
      const c = stack[--sp]; cells.push(c); if (h[c] > hi) hi = h[c];
      const i = (c / N) | 0, j = c - i * N;
      for (const n of [j > 0 ? c - 1 : -1, j < N - 1 ? c + 1 : -1, i > 0 ? c - N : -1, i < N - 1 ? c + N : -1]) {
        if (n >= 0 && !sea[n] && !lab[n]) { lab[n] = id; stack[sp++] = n; }
      }
    }
    if (cells.length * cellHa < 3 && hi < seaLevel + 3) for (const c of cells) sea[c] = 1;
  }
  return sea;
}

/**
 * Metres from each cell to the nearest cell where `blocked(k)` (chamfer 1 / √2,
 * in CELLS; blocked cells are 0). `edge`: the grid border counts as blocked.
 */
export function chamferDistance(N, blocked, edge = false) {
  const d = new Float32Array(N * N);
  for (let k = 0; k < N * N; k++) d[k] = blocked(k) ? 0 : 1e9;
  const D = Math.SQRT2;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    const k = i * N + j; if (!d[k]) continue;
    let v = edge ? Math.min(d[k], i + 1, j + 1) : d[k];
    if (j > 0) v = Math.min(v, d[k - 1] + 1);
    if (i > 0) { v = Math.min(v, d[k - N] + 1); if (j > 0) v = Math.min(v, d[k - N - 1] + D); if (j < N - 1) v = Math.min(v, d[k - N + 1] + D); }
    d[k] = v;
  }
  for (let i = N - 1; i >= 0; i--) for (let j = N - 1; j >= 0; j--) {
    const k = i * N + j; if (!d[k]) continue;
    let v = edge ? Math.min(d[k], N - i, N - j) : d[k];
    if (j < N - 1) v = Math.min(v, d[k + 1] + 1);
    if (i < N - 1) { v = Math.min(v, d[k + N] + 1); if (j < N - 1) v = Math.min(v, d[k + N + 1] + D); if (j > 0) v = Math.min(v, d[k + N - 1] + D); }
    d[k] = v;
  }
  return d;
}
