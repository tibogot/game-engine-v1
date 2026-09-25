// Specimen plants — the ones that make the jungle VIETNAM and CAMBODIA and
// not any jungle (your ask 2026-09-25: "anything you think will look very
// nice in that Vietnam Cambodian jungle"). Planted at boot, one by one, where
// each grows (placedPlants.plant — one instanced draw per kind):
//
//   PANDANUS   the screw pine — clumps along the river's edge, on the bank
//              and not in it; the spiky stars on stilt roots.
//   SUGAR PALM the 24 m thốt nốt — round the village and the temple's
//              approach, and alone out in the open ground: the Cambodian
//              silhouette.
//   FLAME TREE phượng vĩ — a couple in the village, one at the temple: the
//              only red in the forest.
//
// Seeded: the same map every boot. Nothing is planted on walls, props, under
// the canopy, in the water, or within 40 m of a structure (the camps).
import { plant } from "./placedPlants.js";

function rng(seed) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
}

/**
 * @param {object} o
 *   field      the canopy field (jungleCanopy.js) — may be null
 *   structures the camps' structures (kept clear)
 *   hamlets    [{ x, z }] village sites
 *   temples    [{ x, z }] temple sites
 * @returns {{ pandanus, sugarPalm, flameTree }} how many of each
 */
export function plantSpecimens(app, { field = null, structures = null, hamlets = [], temples = [] } = {}) {
  const rand = rng(90173);
  const W = app.worldSize ?? 1024, half = W / 2, G = 4, N = Math.floor(W / G);
  const ground = (x, z) => app.getWorldHeight?.(x, z) ?? 0;
  const blocked = (x, z) => app.navGrid?.isBlockedAtWorld?.(x, z) ?? false;
  const built = (structures?.list ?? []).filter((s) => s.alive).map((s) => s.position);
  const nearBuilt = (x, z, r) => built.some((p) => Math.hypot(p.x - x, p.z - z) < r);
  const forest = (x, z) => (field ? field.open(x, z) * field.forest(x, z) : 0);
  const slope = (x, z) => {
    const y = ground(x, z);
    return Math.max(Math.abs(ground(x + 3, z) - y), Math.abs(ground(x, z + 3) - y)) / 3;
  };
  const placed = [];
  const free = (x, z, r) => !placed.some((p) => Math.hypot(p.x - x, p.z - z) < r);
  const put = (kind, x, z, scale) => {
    plant(app, kind, x, z, { rotY: rand() * Math.PI * 2, scale, seed: rand() });
    placed.push({ x, z, kind });
  };
  const count = { pandanus: 0, sugarPalm: 0, flameTree: 0 };

  // ── PANDANUS: the river's edge ───────────────────────────────────────────
  // Distance to open water on a 4 m grid (a flood from it), then bank cells
  // 1-3 cells out: on the bank, not in the stream.
  if (app.getWaterLevelAt) {
    const dist = new Float32Array(N * N).fill(1e9);
    const q = [];
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      const x = -half + i * G + G / 2, z = -half + j * G + G / 2;
      if (app.getWaterLevelAt(x, z) > ground(x, z) + 0.15) { dist[i * N + j] = 0; q.push(i * N + j); }
    }
    for (let h = 0; h < q.length; h++) {
      const k = q[h], i = (k / N) | 0, j = k % N;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= N || jj >= N) continue;
        const kk = ii * N + jj;
        if (dist[kk] > dist[k] + 1) { dist[kk] = dist[k] + 1; q.push(kk); }
      }
    }
    const bank = [];
    for (let i = 2; i < N - 2; i++) for (let j = 2; j < N - 2; j++) {
      const d = dist[i * N + j];
      if (d < 1 || d > 3) continue;
      const x = -half + i * G + G / 2, z = -half + j * G + G / 2;
      if (slope(x, z) > 0.6 || blocked(x, z) || forest(x, z) > 0.3 || nearBuilt(x, z, 40)) continue;
      bank.push({ x, z });
    }
    // Shuffle (seeded), then clumps at least 26 m apart.
    for (let i = bank.length - 1; i > 0; i--) { const k = (rand() * (i + 1)) | 0; [bank[i], bank[k]] = [bank[k], bank[i]]; }
    for (const b of bank) {
      if (count.pandanus >= 60) break;
      if (!free(b.x, b.z, 26)) continue;
      const n = 1 + Math.floor(rand() * 3);
      for (let k = 0; k < n; k++) {
        const x = b.x + (k ? (rand() - 0.5) * 7 : 0), z = b.z + (k ? (rand() - 0.5) * 7 : 0);
        if (k && (blocked(x, z) || app.getWaterLevelAt(x, z) > ground(x, z))) continue;
        put("pandanus", x, z, 0.75 + rand() * 0.45);
        count.pandanus++;
      }
    }
  }

  // ── SUGAR PALMS and FLAME TREES: the village, the temple, the open ground ──
  const open = (x, z) => !blocked(x, z) && slope(x, z) < 0.35 && forest(x, z) < 0.05
    && (app.getWaterLevelAt?.(x, z) ?? -Infinity) < ground(x, z)
    && (app.sampleFoliageDensity?.(x, z) ?? 0) < 0.35;
  /** Up to `n` of `kind` in a ring round (cx, cz), spaced `gap`. */
  const ring = (kind, cx, cz, r0, r1, n, gap, scale) => {
    let got = 0;
    for (let t = 0; t < n * 30 && got < n; t++) {
      const a = rand() * Math.PI * 2, r = r0 + rand() * (r1 - r0);
      const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
      if (!open(x, z) || !free(x, z, gap) || nearBuilt(x, z, 25)) continue;
      put(kind, x, z, scale());
      got++;
    }
    return got;
  };
  for (const h of hamlets) {
    count.flameTree += ring("flameTree", h.x, h.z, 18, 45, 2, 30, () => 0.85 + rand() * 0.3);
    count.sugarPalm += ring("sugarPalm", h.x, h.z, 30, 90, 7, 14, () => 0.8 + rand() * 0.35);
  }
  for (const t of temples) {
    count.flameTree += ring("flameTree", t.x, t.z, 30, 55, 1, 30, () => 1);
    count.sugarPalm += ring("sugarPalm", t.x, t.z, 35, 110, 8, 16, () => 0.85 + rand() * 0.35);
  }
  // A few alone out in the open ground: the paddy-edge silhouette.
  for (let t = 0; t < 600 && count.sugarPalm < 28; t++) {
    const x = (rand() - 0.5) * W * 0.85, z = (rand() - 0.5) * W * 0.85;
    if (!open(x, z) || !free(x, z, 70) || nearBuilt(x, z, 60)) continue;
    const n = rand() < 0.4 ? 2 : 1;
    for (let k = 0; k < n; k++) {
      const px = x + (k ? 6 + rand() * 6 : 0), pz = z + (k ? (rand() - 0.5) * 10 : 0);
      if (k && !open(px, pz)) continue;
      put("sugarPalm", px, pz, 0.75 + rand() * 0.4);
      count.sugarPalm++;
    }
  }
  return count;
}
