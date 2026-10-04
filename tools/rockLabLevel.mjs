/**
 * ROCK LAB LEVEL — a small 512 m map that shows cliffs and rocks the way a
 * stylised off-road game uses them (reference: "over the hill", 2026-10-04):
 *
 *   - a MOUNTAIN, not a plateau (the user, 2026-10-04: "look how they place
 *     them on a hill, a mountain"): a ridged massif to the north with a lower
 *     second peak. The rock is NOT a wall stood on a step — it is OUTCROPS:
 *     crags and cliff pieces wherever the mountain is steep, faced downhill,
 *     buried 35-55% so they read as bedrock breaking through the slope, with
 *     blocks fallen below them.
 *   - a TRAIL up the mountain that FOLLOWS THE LAND: a grade-limited path
 *     search (switchbacks where it is steep), then only a light shoulder so a
 *     car does not roll off it — not a cut. An off-road route is driven over
 *     the ground, not carved through it.
 *   - a valley TRACK along the mountain's foot, a BOULDER FIELD on a hill to
 *     the south-east, loose rocks on the floor.
 *   - GROUND: flat painted colours (golden meadow matched to the lit grass,
 *     grey rock, bare earth under the stones, a pinkish dirt track whose only
 *     detail is small stone bumps in the normal) — procedural layers, no image
 *     textures — and REVO GRASS, golden, clumped.
 *
 * Everything is ordinary level data (the editor's rock kit, cliff presets, grass
 * paint), so the map opens in the editor too. The light is Sky Pro.
 *
 *   node tools/rockLabLevel.mjs [--from public/levels/alg-aures.v3proj]
 *        [--out public/levels/rock-lab.v3proj] [--seed 7]
 *
 * Also writes games/rock-lab/spots.js (camera views + the scale car's spot).
 */
import fs from "node:fs";
import { readProject, writeProject } from "./lib/v3proj.mjs";
import { simplifierReady } from "../v3/render/instancing/autoLod.js";
import { ROCK_KIT, ROCK_CLIFF_PRESETS, rockKitParams, getRockGeometry } from "../v3/props/proceduralRock.js";

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
const FROM = args.from ?? "public/levels/alg-aures.v3proj";
const OUT = args.out ?? "public/levels/rock-lab.v3proj";
const SPOTS = "games/rock-lab/spots.js";
const SEED = +(args.seed ?? 7);

// ── Size ──────────────────────────────────────────────────────────────────
const W = 512, N = 512, TOP = 140, S = 1024;   // 1 m height cells, 0.5 m paint texels
const HALF = W / 2, CELL = W / (N - 1);
const G = 512;                                  // grass paint (GrassTerrainData DENSITY_RES), 1 m

// ── Noise (Math.imul hashing: value noise without it repeats in bands) ─────
const hash = (x, y, s = SEED) => {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(s, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
};
const vnoise = (x, y, s) => {
  const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash(xi, yi, s), b = hash(xi + 1, yi, s), c = hash(xi, yi + 1, s), d = hash(xi + 1, yi + 1, s);
  return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
};
/** ≈ −1..1 */
const fbm = (x, y, s = 1) => (vnoise(x, y, s) * 0.55 + vnoise(x * 2.03, y * 2.03, s + 1) * 0.3 + vnoise(x * 4.1, y * 4.1, s + 2) * 0.15) * 2 - 1;
const smooth = (e0, e1, x) => { const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;
let rs = SEED * 7919 + 13;
const rnd = () => ((rs = (rs * 16807) % 2147483647) / 2147483647);
const T0 = Date.now();
const stage = (name) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)} s] ${name}`);

// ── The ground: valley floor + a mountain ─────────────────────────────────
const floorH = (x, z) => 14 + 2.5 * fbm(x / 60, z / 60, 3) + Math.max(0, z - 80) * 0.04
  + 11 * Math.exp(-((x - 110) ** 2 + (z - 95) ** 2) / (2 * 50 ** 2));      // the boulder hill
/**
 * One peak: a concave cone (steep near the top, easing out at the foot) with
 * ridged noise on its flanks — the ridges are what make steep faces for the
 * outcrops and gentler spurs for the trail. Domain-warped so it is not round.
 */
function peak(x, z, cx, cz, height, radius, seed) {
  const wx = x + 28 * fbm(x / 90, z / 90, seed), wz = z + 28 * fbm(x / 90, z / 90, seed + 1);
  const r = Math.hypot(wx - cx, (wz - cz) * 0.85);
  const t = Math.max(0, 1 - r / radius);
  const cone = height * Math.pow(t, 1.5);
  // SOFT ridges: abs() of a 3-octave fbm creased the crest at every scale
  // down to ~10 m — a saw-tooth silhouette (the user, 2026-10-04). Two octaves,
  // and a rounded abs (sqrt(v² + k²)) so a crest is a ridge, not a blade.
  const v = (vnoise(wx / 55, wz / 55, seed + 2) * 0.68 + vnoise(wx / 27, wz / 27, seed + 3) * 0.32) * 2 - 1;
  const ridged = 1 - Math.sqrt(v * v + 0.02);
  return cone + 16 * ridged * ridged * smooth(0, 0.55, t);
}
const smax = (a, b, k = 8) => { const h = Math.max(0, Math.min(1, 0.5 + 0.5 * (a - b) / k)); return lerp(b, a, h) + k * h * (1 - h); };
// Both peaks INSIDE the map, and every mountain fades to the floor 45 m before
// the edge: past the edge the engine blends the border heights out into the
// far grid, and a mountain cut by the edge was extruded into long stripes.
const edgeFade = (x, z) => smooth(0, 45, HALF - Math.max(Math.abs(x), Math.abs(z)));
const mountainH = (x, z) => smax(peak(x, z, -35, -120, 92, 150, 61), peak(x, z, 140, -125, 52, 100, 71)) * edgeFade(x, z);
const groundH = (x, z) => floorH(x, z) + mountainH(x, z);

// ── Heights ───────────────────────────────────────────────────────────────
const H = new Float32Array(N * N);
for (let iz = 0; iz < N; iz++) {
  for (let ix = 0; ix < N; ix++) H[iz * N + ix] = groundH(-HALF + ix * CELL, -HALF + iz * CELL);
}
// Two light 3x3 smoothing passes: rounds off what is left of sharp crests at
// the 1-2 m scale (a terrain vertex every metre draws them as teeth).
for (let pass = 0; pass < 2; pass++) {
  const src = H.slice();
  for (let iz = 1; iz < N - 1; iz++) {
    for (let ix = 1; ix < N - 1; ix++) {
      let s = 0;
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) s += src[(iz + dz) * N + ix + dx] * (dx === 0 && dz === 0 ? 4 : dx === 0 || dz === 0 ? 2 : 1);
      H[iz * N + ix] = s / 16;
    }
  }
}
const hAt = (x, z) => {
  const fx = Math.max(0, Math.min(N - 1.0001, (x + HALF) / CELL)), fz = Math.max(0, Math.min(N - 1.0001, (z + HALF) / CELL));
  const x0 = fx | 0, z0 = fz | 0, tx = fx - x0, tz = fz - z0;
  const a = H[z0 * N + x0], b = H[z0 * N + x0 + 1], c = H[(z0 + 1) * N + x0], d = H[(z0 + 1) * N + x0 + 1];
  return lerp(lerp(a, b, tx), lerp(c, d, tx), tz);
};
const gradAt = (x, z, e = 1) => [(hAt(x + e, z) - hAt(x - e, z)) / (2 * e), (hAt(x, z + e) - hAt(x, z - e)) / (2 * e)];
const slopeAt = (x, z, e = 0.75) => { const [gx, gz] = gradAt(x, z, e); return (Math.atan(Math.hypot(gx, gz)) * 180) / Math.PI; };
/** Lowest ground under a footprint (centre + 8 points on its rim). */
const hMinUnder = (x, z, r) => {
  let m = hAt(x, z);
  for (let k = 0; k < 8; k++) { const a = (k / 8) * Math.PI * 2; m = Math.min(m, hAt(x + Math.cos(a) * r, z + Math.sin(a) * r)); }
  return m;
};
const normalAt = (x, z) => { const [gx, gz] = gradAt(x, z); const l = Math.hypot(gx, 1, gz); return [-gx / l, 1 / l, -gz / l]; };

// ── Paths ─────────────────────────────────────────────────────────────────
function spline(ctrl) {
  const cr = (p0, p1, p2, p3, t) => {
    const t2 = t * t, t3 = t2 * t;
    return [0, 1].map((k) => 0.5 * ((2 * p1[k]) + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3));
  };
  const out = [];
  for (let i = 0; i < ctrl.length - 1; i++) {
    const p0 = ctrl[Math.max(0, i - 1)], p1 = ctrl[i], p2 = ctrl[i + 1], p3 = ctrl[Math.min(ctrl.length - 1, i + 2)];
    const n = Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]));
    for (let j = 0; j < n; j++) out.push(cr(p0, p1, p2, p3, j / n));
  }
  out.push(ctrl[ctrl.length - 1]);
  return out;
}
/** Resample a polyline every `step` metres. */
function resample(pts, step = 1) {
  const out = [pts[0]];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const [ax, az] = pts[i - 1], [bx, bz] = pts[i];
    const L = Math.hypot(bx - ax, bz - az);
    let d = step - carry;
    while (d <= L) { out.push([lerp(ax, bx, d / L), lerp(az, bz, d / L)]); d += step; }
    carry = L - (d - step);
  }
  return out;
}
const minDist = (pts, x, z) => {
  let best = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const dx = pts[i][0] - x, dz = pts[i][1] - z, d = dx * dx + dz * dz;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
};

// The valley track along the mountain's foot.
const track = spline([[-262, 80], [-190, 50], [-125, 22], [-60, 12], [0, 16], [55, 22], [120, 40], [175, 32], [262, 18]]);

/**
 * THE TRAIL: a least-cost path over a 2 m grid where a step costs its length,
 * more as it gets steeper, a lot past ~18% and nothing past 34% (not
 * drivable), plus a little for side slope (a car leans on a cross-fall). The
 * search finds the switchbacks itself; nothing is carved to make it drivable.
 */
function findTrail(from, to) {
  const GS = 2, GN = Math.floor(W / GS);
  const idx = (i, j) => j * GN + i;
  const toCell = ([x, z]) => [Math.round((x + HALF) / GS), Math.round((z + HALF) / GS)];
  const pos = (i, j) => [-HALF + i * GS, -HALF + j * GS];
  const hC = new Float32Array(GN * GN), sideC = new Float32Array(GN * GN);
  for (let j = 0; j < GN; j++) for (let i = 0; i < GN; i++) {
    const [x, z] = pos(i, j);
    hC[idx(i, j)] = hAt(x, z);
    sideC[idx(i, j)] = slopeAt(x, z, 2);
  }
  const [si, sj] = toCell(from), [ti, tj] = toCell(to);
  const g = new Float64Array(GN * GN).fill(Infinity), came = new Int32Array(GN * GN).fill(-1);
  const closed = new Uint8Array(GN * GN);   // each cell expanded once: stale heap entries are skipped
  const heap = [];   // binary heap of [f, k]
  const push = (f, k) => { heap.push([f, k]); let c = heap.length - 1; while (c > 0) { const p = (c - 1) >> 1; if (heap[p][0] <= heap[c][0]) break; [heap[p], heap[c]] = [heap[c], heap[p]]; c = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let c = 0; for (;;) { const l = 2 * c + 1, r = l + 1; let m = c; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === c) break; [heap[m], heap[c]] = [heap[c], heap[m]]; c = m; } } return top; };
  const hEst = (i, j) => Math.hypot(i - ti, j - tj) * GS;
  g[idx(si, sj)] = 0;
  push(hEst(si, sj), idx(si, sj));
  const goal = idx(ti, tj);
  const NB = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1], [2, 1], [1, 2], [-1, 2], [-2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1]];
  while (heap.length) {
    const [, k] = pop();
    if (closed[k]) continue;
    closed[k] = 1;
    if (k === goal) break;
    const i = k % GN, j = (k / GN) | 0;
    for (const [di, dj] of NB) {
      const ni = i + di, nj = j + dj;
      if (ni < 4 || nj < 4 || ni >= GN - 4 || nj >= GN - 4) continue;
      const nk = idx(ni, nj);
      const L = Math.hypot(di, dj) * GS;
      const grade = Math.abs(hC[nk] - hC[k]) / L;
      if (grade > 0.28) continue;
      const side = Math.max(0, sideC[nk] - 24) / 10;
      const cost = L * (1 + 4 * grade + 260 * Math.max(0, grade - 0.15) ** 2 + 1.5 * side * side);
      const ng = g[k] + cost;
      if (ng < g[nk]) { g[nk] = ng; came[nk] = k; push(ng + hEst(ni, nj), nk); }
    }
  }
  if (came[goal] < 0) throw new Error("trail: no drivable route found");
  const cells = [];
  for (let k = goal; k >= 0; k = came[k]) cells.push(pos(k % GN, (k / GN) | 0));
  cells.reverse();
  // Chaikin twice: the grid's zig-zags become curves.
  let pts = cells;
  for (let it = 0; it < 2; it++) {
    const o = [pts[0]];
    for (let q = 0; q < pts.length - 1; q++) {
      const [ax, az] = pts[q], [bx, bz] = pts[q + 1];
      o.push([0.75 * ax + 0.25 * bx, 0.75 * az + 0.25 * bz], [0.25 * ax + 0.75 * bx, 0.25 * az + 0.75 * bz]);
    }
    o.push(pts[pts.length - 1]);
    pts = o;
  }
  return resample(pts, 1);
}
// From the valley track at the mountain's foot to the shoulder below the summit.
const trailFrom = track.reduce((b, p) => (Math.hypot(p[0] + 30, p[1] - 14) < Math.hypot(b[0] + 30, b[1] - 14) ? p : b));
let summit = [-40, -175], summitH = -Infinity;
for (let z = -165; z <= -80; z += 2) for (let x = -75; x <= 5; x += 2) { const h = hAt(x, z); if (h > summitH) { summitH = h; summit = [x, z]; } }
const trailTo = [summit[0] + 14, summit[1] + 20];   // below the top, not on it
stage("heights");
const trail = findTrail(trailFrom, trailTo);
stage(`trail ${trail.length} m`);
const trackDist = (x, z) => Math.min(minDist(track, x, z), minDist(trail, x, z));

/** Ease the ground within `R` of a path toward the path's own height `line[i]`. */
function conform(pts, line, core, R, amount) {
  const wgt = new Float32Array(N * N), acc = new Float32Array(N * N);
  pts.forEach(([x, z], i) => {
    const cx = Math.round((x + HALF) / CELL), cz = Math.round((z + HALF) / CELL), rr = Math.ceil(R / CELL) + 1;
    for (let dz = -rr; dz <= rr; dz++) for (let dx = -rr; dx <= rr; dx++) {
      const ix = cx + dx, iz = cz + dz;
      if (ix < 0 || iz < 0 || ix >= N || iz >= N) continue;
      const d = Math.hypot(-HALF + ix * CELL - x, -HALF + iz * CELL - z);
      const w = 1 - smooth(core, R, d);
      if (w <= 0) continue;
      const k = iz * N + ix;
      if (w > wgt[k]) { wgt[k] = w; acc[k] = line[i]; }
    }
  });
  for (let k = 0; k < N * N; k++) if (wgt[k] > 0) H[k] = lerp(H[k], acc[k], wgt[k] * amount);
}
const smoothLine = (pts, win) => {
  const raw = pts.map(([x, z]) => hAt(x, z));
  return raw.map((_, i) => {
    let s = 0, n = 0;
    for (let k = -win; k <= win; k++) { const j = i + k; if (j >= 0 && j < raw.length) { s += raw[j]; n++; } }
    return s / n;
  });
};
// Valley track: a driven line, levelled across.
conform(track, smoothLine(track, 6), 2.4, 5, 0.85);
// Trail: only a SHOULDER — levelled across (no cross-fall to roll on), the
// ground's own ups and downs kept along it (a short window), half strength.
conform(trail, smoothLine(trail, 3), 1.6, 3.6, 0.55);

// ── The kit's real shape sizes (generated here exactly as the engine will) ─
await simplifierReady;
await new Promise((r) => setTimeout(r, 10));
const box = (params) => { const b = getRockGeometry(params).boundingBox; return { w: b.max.x - b.min.x, h: b.max.y - b.min.y, d: b.max.z - b.min.z }; };
const KIT = Object.fromEntries(ROCK_KIT.map((k) => [k.name, { ...k, ...box(rockKitParams(k.name)) }]));
const CLIFFS = Object.fromEntries(ROCK_CLIFF_PRESETS.map((c) => [c.name, { ...c, ...box(c.params) }]));
const byCls = (cls) => ROCK_KIT.filter((k) => k.cls === cls).map((k) => k.name);
// The blocky off-road set for everything you read as a boulder; the small
// round stones only fill in between (at their size the shape does not show).
const SHAPES = { crag: byCls("crag"), block: byCls("block"), rock: byCls("rock"), pebble: byCls("pebble") };
for (const [c, list] of Object.entries(SHAPES)) if (!list.length) throw new Error(`no "${c}" shapes in ROCK_KIT`);
/** Size rank: a much smaller rock may tuck against a bigger one's base. */
const RANK = { cliff: 4, crag: 3, block: 2, rock: 1, pebble: 0 };
/** Instance scale range and tilt (deg) per class. */
const CLS = {
  crag:   { scale: [0.65, 1.3], tilt: 5 },
  block:  { scale: [1.0, 2.6],  tilt: 8 },
  rock:   { scale: [0.8, 2.0],  tilt: 18 },
  pebble: { scale: [0.8, 2.2],  tilt: 30 },
};

// ── Props ─────────────────────────────────────────────────────────────────
const types = [], typeIdx = new Map();
const typeOf = (name, solid) => {
  if (!typeIdx.has(name)) {
    typeIdx.set(name, types.length);
    types.push({ name, live: false, solid, isPrimitive: true, primShape: name });
  }
  return typeIdx.get(name);
};
const instances = [];
const placed = [];   // { x, z, r, rank } — the spacing test
const TRACK_CLEAR = 4.5;
const spaced = (x, z, r, rank) => {
  for (const e of placed) {
    const kk = Math.abs(e.rank - rank) >= 2 ? 0.5 : 0.9;
    const dd = (e.r + r) * kk;
    if ((e.x - x) ** 2 + (e.z - z) ** 2 < dd * dd) return false;
  }
  return true;
};

function tryPlace(cls, x, z, { sink = [0.15, 0.3], scaleMul = 1 } = {}) {
  if (Math.abs(x) > HALF - 8 || Math.abs(z) > HALF - 8) return null;
  const name = SHAPES[cls][Math.floor(rnd() * SHAPES[cls].length)];
  const k = KIT[name], C = CLS[cls];
  const base = (C.scale[0] + (C.scale[1] - C.scale[0]) * rnd()) * scaleMul;
  const sx = base * (0.85 + rnd() * 0.3), sy = base * (0.8 + rnd() * 0.4), sz = base * (0.85 + rnd() * 0.3);
  const r = (Math.max(k.w * sx, k.d * sz)) / 2;
  if (trackDist(x, z) < r + TRACK_CLEAR) return null;
  if (!spaced(x, z, r, RANK[cls])) return null;
  // Resting on the LOWEST ground under it, then sunk: a stone on a slope must
  // not hang its downhill edge in the air.
  const sinkF = sink[0] + (sink[1] - sink[0]) * rnd();
  const py = hMinUnder(x, z, r * 0.8) - sinkF * k.h * sy;
  const [nx, , nz] = normalAt(x, z);
  const rx = (nz * 0.5 * 57.3) + (rnd() - 0.5) * 2 * C.tilt;
  const rz = (-nx * 0.5 * 57.3) + (rnd() - 0.5) * 2 * C.tilt;
  instances.push({ typeIdx: typeOf(name, cls === "crag" || cls === "block"), px: x, py, pz: z, rx, ry: rnd() * 360, rz, sx, sy, sz });
  const e = { x, z, r, rank: RANK[cls], cls };
  placed.push(e);
  return e;
}

/** Satellites: small rocks round a big one's base — most of what makes a pile read. */
function satellites(e, n) {
  for (let j = 0; j < n; j++) {
    const a = rnd() * Math.PI * 2, d = e.r * (0.75 + rnd() * 0.9);
    tryPlace(rnd() < 0.5 ? "pebble" : "rock", e.x + Math.cos(a) * d, e.z + Math.sin(a) * d);
  }
}

// 1. OUTCROPS: rock breaking through the mountain wherever it is steep.
//    Steepest ground gets cliff pieces, steep ground crags; each faces
//    downhill (its long side along the contour), leans with the slope, is
//    buried 35-55% at its centre (so its uphill side is deep in the hill and
//    its downhill face stands out), and drops blocks below it.
const outcrops = [];
{
  const cands = [];
  for (let z = -HALF + 10; z < HALF - 10; z += 9) {
    for (let x = -HALF + 10; x < HALF - 10; x += 9) {
      const px = x + (rnd() - 0.5) * 7, pz = z + (rnd() - 0.5) * 7;
      const s = slopeAt(px, pz, 2);
      if (s < 31) continue;
      cands.push({ x: px, z: pz, s });
    }
  }
  cands.sort((a, b) => b.s - a.s);   // steepest first: the big pieces claim them
  for (const c of cands) {
    // FEW and BIG (first pass: 225 pieces peppered the slopes like stones
    // dropped on it; the reference has a few outcrops growing out of it).
    if (rnd() > smooth(33, 46, c.s) * 0.45) continue;
    const big = c.s > 38 && rnd() < 0.75;
    const name = big ? (rnd() < 0.7 ? "Cliff: Crag Wall" : "Cliff: Crag Tower") : SHAPES.crag[Math.floor(rnd() * SHAPES.crag.length)];
    const shape = big ? CLIFFS[name] : KIT[name];
    const s = big ? 0.55 + rnd() * 0.45 : 1.2 + rnd() * 0.8;
    const r = (Math.max(shape.w, shape.d) * s) / 2;
    if (trackDist(c.x, c.z) < r + 6) continue;
    if (!spaced(c.x, c.z, r * 1.3, big ? 4 : 3)) continue;
    const [gx, gz] = gradAt(c.x, c.z, 2);
    const gl = Math.hypot(gx, gz) || 1;
    const dx = -gx / gl, dz = -gz / gl;             // downhill
    const tx = -dz, tz = dx;                        // along the contour
    const yaw = Math.atan2(-tz, tx) + (rnd() - 0.5) * 0.4;
    const [nx, , nz] = normalAt(c.x, c.z);
    const bury = 0.45 + rnd() * 0.15;
    const py = hAt(c.x, c.z) - bury * shape.h * s;
    instances.push({
      typeIdx: typeOf(name, true), px: c.x, py, pz: c.z,
      rx: nz * 0.4 * 57.3, ry: (yaw * 180) / Math.PI, rz: -nx * 0.4 * 57.3,
      sx: s * (0.9 + rnd() * 0.2), sy: s, sz: s,
    });
    const e = { x: c.x, z: c.z, r, rank: big ? 4 : 3, cls: big ? "cliff" : "crag" };
    placed.push(e);
    outcrops.push({ ...e, dx, dz });
  }
  // Fallen blocks below each outcrop: down the slope, the bigger ones nearer.
  for (const o of outcrops) {
    const n = o.cls === "cliff" ? 2 + Math.floor(rnd() * 4) : Math.floor(rnd() * 2);
    for (let j = 0; j < n; j++) {
      const along = o.r * (1.1 + rnd() * 1.8), side = (rnd() - 0.5) * o.r * 2.2;
      const x = o.x + o.dx * along - o.dz * side, z = o.z + o.dz * along + o.dx * side;
      const e = tryPlace(rnd() < 0.55 ? "block" : rnd() < 0.5 ? "rock" : "pebble", x, z);
      if (e && e.rank >= 2) satellites(e, 1 + Math.floor(rnd() * 2));
    }
  }
}

stage(`outcrops ${outcrops.length}`);
// 2. A rock pile where the mountain meets the valley: the biggest fall the
//    furthest, so the foot of the steepest flanks collects blocks.
for (let i = 0; i < 900; i++) {
  const x = -230 + rnd() * 460, z = -200 + rnd() * 220;
  const s = slopeAt(x, z, 2), m = mountainH(x, z);
  if (m < 3 || m > 30 || s > 30) continue;
  // Below steep ground: look 15 m uphill.
  const [gx, gz] = gradAt(x, z, 2);
  const gl = Math.hypot(gx, gz) || 1;
  const up = slopeAt(x + (gx / gl) * 15, z + (gz / gl) * 15, 2);
  if (up < 35 || rnd() > 0.25) continue;
  const e = tryPlace(rnd() < 0.3 ? "crag" : rnd() < 0.7 ? "block" : "rock", x, z);
  if (e && e.rank >= 2) satellites(e, 1 + Math.floor(rnd() * 3));
}

// 3. The boulder field on the south-east hill: clusters of a crag and blocks.
for (let c = 0; c < 9; c++) {
  const a = rnd() * Math.PI * 2, d = Math.sqrt(rnd()) * 62;
  const cx = 110 + Math.cos(a) * d, cz = 95 + Math.sin(a) * d;
  const big = tryPlace(rnd() < 0.6 ? "crag" : "block", cx, cz);
  if (!big) continue;
  satellites(big, 3 + Math.floor(rnd() * 4));
  for (let j = 0; j < 2 + Math.floor(rnd() * 3); j++) {
    const aa = rnd() * Math.PI * 2, dd = big.r * (1.4 + rnd() * 1.5);
    const e = tryPlace("block", cx + Math.cos(aa) * dd, cz + Math.sin(aa) * dd);
    if (e) satellites(e, 1 + Math.floor(rnd() * 2));
  }
}

// 4. Loose singles over the valley floor.
for (let i = 0; i < 140; i++) {
  const x = -230 + rnd() * 460, z = -10 + rnd() * 230;
  if (mountainH(x, z) > 2) continue;
  const r = rnd();
  const e = tryPlace(r < 0.3 ? "block" : r < 0.7 ? "rock" : "pebble", x, z);
  if (e && e.rank >= 2) satellites(e, 1 + Math.floor(rnd() * 2));
}

stage(`rocks ${placed.length}`);
// ── Paint: 7 procedural layers ────────────────────────────────────────────
// FLAT colours: each layer's three shades sit close together, and the only
// texture detail is in the bump (the track's small stones). The first pass's
// patterned albedo (pebble circles, cracks, ripples) read as noise.
const MEADOW = 0, ROCK = 1, EARTH = 2, TRACK = 3;
const proc = (name, procedural, extra = {}) => ({
  name, albedo: null, normal: null, rough: null, ao: null,
  uvScale: Math.min(200, Math.max(1, Math.round(W / procedural.tileM))),
  normalStr: 1, aoStr: 0.8, roughStr: 1, triplanar: false, tint: "#ffffff", uvRotation: 0, contourAlign: 0, rockShade: 0,
  procedural: { seed: 1, size: 0.5, accentAmt: 0, ...procedural },
  blocksGrass: false, blocksTrees: false,
  auto: { enabled: false, heightMin: 0, heightMax: 500, slopeMin: 0, slopeMax: 90, blend: 15, strength: 1 },
  ...extra,
});
// ONE FLAT COLOUR, the grass as it reads lit: measured off the frame (grass vs
// the ground under it, same pixels, at 16.3 h — top-down AND low, weighted
// 60/40 to the low view the car sees; they differ: from the side the blades
// show their lighter tips) and the ratio taken back to albedo in linear
// light. A bare spot then reads as more of the same field (the reference:
// grass and the ground under it are one colour), and the grass tile's fade
// draws no ring round the camera. No pattern, no bump.
const meadow = { preset: "genshinGrass", pattern: "painted", dark: "#bd6a1b", mid: "#bd6a1b", light: "#bd6a1b", accent: "#bd6a1b", scale: 8, patches: 0, feature: 0, detail: 0, rough: 0.95, bump: 0, ao: 0, tileM: 60 };
const PAINT = [
  // Under the grass, and what is left of it past the grass tile's fade.
  proc("Golden meadow", meadow),
  // The rock layer: the rock kit's own grey, shaded like the rock props
  // (rockShade), so a bare slope and a crag read as one stone.
  proc("Cliff rock", { preset: "genshinGrass", pattern: "painted", dark: "#8f949b", mid: "#9ca1a8", light: "#a7abb1", accent: "#a7abb1", scale: 6, patches: 0.2, feature: 0.15, detail: 0.03, rough: 0.85, bump: 0.15, ao: 0.2, tileM: 40 }, { triplanar: true, rockShade: 1 }),
  // Bare earth: under the stones.
  proc("Bare earth", { preset: "genshinGrass", pattern: "painted", dark: "#a3816a", mid: "#ad8b73", light: "#b5937a", accent: "#b5937a", scale: 8, patches: 0.2, feature: 0.15, detail: 0.03, rough: 0.95, bump: 0.2, ao: 0.2, tileM: 30 }),
  // The track: pinkish tan, flat colour; the stones are ~10 cm and live almost
  // only in the BUMP (accent ≈ the ground), with soft dents between them.
  proc("Dirt track", { preset: "genshinPath", pattern: "path", dark: "#bb937a", mid: "#c39b82", light: "#c9a289", accent: "#bf977e", scale: 18, patches: 0.15, feature: 0.35, size: 0.2, detail: 0.03, accentAmt: 0.5, rough: 0.95, bump: 1.1, ao: 0.3, tileM: 6 }),
  proc("Spare A", meadow),
  proc("Spare B", meadow),
  proc("Spare C", meadow),
];

// Rock proximity: bare earth right under each stone's base (the join).
const TX = W / S;
const earthF = new Float32Array(S * S), trackF = new Float32Array(S * S), rockF = new Float32Array(S * S);
const stamp = (field, res, x, z, R, fn) => {
  const tx = W / res;
  const cx = (x + HALF) / tx - 0.5, cz = (z + HALF) / tx - 0.5, rr = Math.ceil(R / tx) + 1;
  for (let j = Math.floor(cz - rr); j <= cz + rr; j++) {
    if (j < 0 || j >= res) continue;
    for (let i = Math.floor(cx - rr); i <= cx + rr; i++) {
      if (i < 0 || i >= res) continue;
      const d = Math.hypot((i - cx) * tx, (j - cz) * tx);
      if (d > R) continue;
      const v = fn(d, -HALF + (i + 0.5) * tx, -HALF + (j + 0.5) * tx);
      const k = j * res + i;
      if (v > field[k]) field[k] = v;
    }
  }
};
for (const e of placed) {
  if (e.rank < 1) continue;
  const dR = e.r * 1.15 + 0.4;
  stamp(earthF, S, e.x, e.z, dR, (d, wx, wz) => (1 - smooth(e.r * 0.7, dR, d + 0.5 * fbm(wx / 1.5, wz / 1.5, 23))) * 0.8);
}
// Rock paint under every outcrop: their flat tops take the paint BELOW them
// (cliffTerrainBlend), and meadow there smeared orange across grey stone.
for (const o of outcrops) stamp(rockF, S, o.x, o.z, o.r * 1.05, (d) => 1 - smooth(o.r * 0.7, o.r * 1.05, d));
// The valley track full width; the trail narrower — two wheel ruts' worth.
for (const [x, z] of track) stamp(trackF, S, x, z, 4.2, (d, wx, wz) => 1 - smooth(1.9, 3.9, d + 0.7 * fbm(wx / 2.5, wz / 2.5, 24)));
for (const [x, z] of trail) stamp(trackF, S, x, z, 3.6, (d, wx, wz) => 1 - smooth(1.5, 3.2, d + 0.6 * fbm(wx / 2.5, wz / 2.5, 25)));

const splat = Buffer.alloc(S * S * 8);
const share = new Float64Array(4);
const worn = (x, z) => smooth(0.35, 0.6, fbm(x / 18, z / 18, 41)) * 0.85;
for (let j = 0; j < S; j++) {
  const z = -HALF + (j + 0.5) * TX;
  for (let i = 0; i < S; i++) {
    const x = -HALF + (i + 0.5) * TX;
    const slope = slopeAt(x, z);
    const n = fbm(x / 14, z / 14, 31);
    const k = j * S + i;
    const rock = Math.max(smooth(36, 46, slope + n * 5), rockF[k]);
    const trackW = trackF[k] * (1 - rock);
    // Bare earth only right under the stones; the worn patches are bare of
    // GRASS (the grass paint below) but keep the meadow colour.
    const earth = earthF[k] * (1 - rock) * (1 - trackW);
    const meadowW = Math.max(0, 1 - rock - trackW - earth);
    const w = [meadowW, rock, earth, trackW];
    const sum = w.reduce((a, b) => a + b, 0) || 1;
    const p = k * 4;
    splat[p] = Math.round((w[MEADOW] / sum) * 255);
    splat[p + 1] = Math.round((w[ROCK] / sum) * 255);
    splat[p + 2] = Math.round((w[EARTH] / sum) * 255);
    splat[p + 3] = Math.round((w[TRACK] / sum) * 255);
    // plane 2 (slots 4-6) stays 0; its alpha = holes, none
    for (let c = 0; c < 4; c++) share[c] += w[c] / sum;
  }
}

// ── Grass paint (Revo reads it as a probability): the meadow, cut back ────
const grass = Buffer.alloc(G * G * 4);
const bladeH = Buffer.alloc(G * G * 4, 128);   // 128 = 1x blade height
{
  // Grass stops a little short of every stone and the tracks.
  const gTX = W / G;
  const clear = new Float32Array(G * G);
  for (const e of placed) stamp(clear, G, e.x, e.z, e.r * 1.05 + 0.6, (d) => 1 - smooth(e.r * 0.85, e.r * 1.05 + 0.6, d));
  for (const [x, z] of track) stamp(clear, G, x, z, 4.6, (d) => 1 - smooth(2.6, 4.6, d));
  for (const [x, z] of trail) stamp(clear, G, x, z, 3.8, (d) => 1 - smooth(2.0, 3.8, d));
  let sum = 0;
  for (let j = 0; j < G; j++) {
    const z = -HALF + (j + 0.5) * gTX;
    for (let i = 0; i < G; i++) {
      const x = -HALF + (i + 0.5) * gTX;
      const k = j * G + i;
      const rock = smooth(32, 40, slopeAt(x, z, 1));
      const v = (1 - rock) * (1 - clear[k]) * (1 - worn(x, z));
      const b = Math.round(Math.max(0, Math.min(1, v)) * 255);
      grass[k * 4] = grass[k * 4 + 1] = grass[k * 4 + 2] = grass[k * 4 + 3] = b;
      // Shorter up the mountain, a little taller in its lee.
      const tall = 1.1 - 0.35 * smooth(15, 70, mountainH(x, z)) + 0.15 * fbm(x / 9, z / 9, 51);
      bladeH[k * 4] = bladeH[k * 4 + 1] = bladeH[k * 4 + 2] = bladeH[k * 4 + 3] = Math.round(Math.max(32, Math.min(255, 128 * tall)));
      sum += b / 255;
    }
  }
  console.log(`grass paint: ${(100 * sum / (G * G)).toFixed(1)}% of the map`);
}

// ── Manifest: the template's look, none of its content ────────────────────
const tpl = await readProject(FROM);
const man = tpl.manifest;
man.terrain = { worldSize: W, heightmapSize: N, splatSize: S, maxHeight: TOP };
man.splatRes = S;
man.trees = { ...man.trees, instances: [] };
man.decals = { ...man.decals, decals: [] };
man.lakes = { ...man.lakes, lakes: [] };
man.roads = { nodes: [], edges: [], nextNodeId: 1, selectedNodeId: null };
man.splines = Object.fromEntries(Object.keys(man.splines ?? {}).map((k) => [k, []]));
for (const k of ["waterfalls", "riversV2", "riverNetwork", "tunnels", "spawn"]) man[k] = null;
if (man.farTerrain) man.farTerrain = { ...man.farTerrain, enabled: false };
if (man.environment?.worldOcean) man.environment.worldOcean = { ...man.environment.worldOcean, enabled: false };
// Sky Pro: the page sets its clock (a low afternoon sun) — see rockLab.js.
const look = man.environment?.look;
if (look) look.skyMode = "skypro";
man.paintLayers = PAINT;
// No macro variation: the terrain shader's big colour washes would break the
// flat meadow that has to match the grass.
man.paintBlend = { ...man.paintBlend, macroStrength: 0 };
// REVO GRASS, golden: the fuller stylised field (the user's call over the
// hybrid rings, 2026-10-04). The template's tuned openWorld settings, recoloured.
man.grass = { ...man.grass, system: "revo" };
man.revoGrass = {
  ...man.revoGrass,
  baseColor: "#c07428", tipColor: "#f6c25c", colorMix: 0.75,
  // colorVariation MULTIPLIES the root colour by smoothstep(0, it, noise): the
  // template's 2.2 left most roots at 0-40% = a dark brown field. viewNormal:
  // light the blades with a view-space normal (the dark-disc fix, see
  // revoGrassSystem.js).
  colorVariation: 0.35, viewNormal: true,
  // The meadow paint is measured to match the lit grass: no far imitation.
  farShading: false,
  // MORE CLUMPING (the user, 2026-10-04): tufts with gaps between, not an
  // even pile — closer to the reference's soft masses.
  bladeHeight: 0.75, bladeWidth: 0.13, clumpStrength: 0.8, clumpScale: 3.2,
};
man.props = {
  types,
  instances,
  slots: types.map((t) => ({ name: t.name, builtin: true, live: false, solid: t.solid, materialId: "__none__", triplanar: !!CLIFFS[t.name] })),
};

// ── FAR MOUNTAINS: the engine's far terrain past the map's edge ───────────
// (v3/terrain/farTerrain.js — what alg-rts does; the user, 2026-10-04: the
// flat striped plain past the edge "looks bad"). A grid of ranges round the
// map: foothills near it, big ridged mountains a few km out, the massif
// carrying on to the north. The engine blends the map's own edge into it over
// `blend` metres and paints it with the rule below (meadow, rock on steep
// slopes and high up), so it wears the same colours as the map.
const FAR = { n: 512, extent: 3200 };
const farH = new Float32Array(FAR.n * FAR.n);
{
  const fcell = (2 * FAR.extent) / (FAR.n - 1);
  const ridge = (x, z, s) => { const r = 1 - Math.abs(fbm(x, z, s)); return r * r; };
  for (let i = 0; i < FAR.n; i++) {
    const z = -FAR.extent + i * fcell;               // row 0 = north (−z), as the heightmap
    for (let j = 0; j < FAR.n; j++) {
      const x = -FAR.extent + j * fcell;
      const out = Math.hypot(Math.max(Math.abs(x) - HALF, 0), Math.max(Math.abs(z) - HALF, 0));
      const amp = 20 + 210 * smooth(150, 2200, out) + 60 * smooth(0, 1, -z / 800) * smooth(0, 900, out);
      const wx = x + 300 * fbm(x / 1500, z / 1500, 81), wz = z + 300 * fbm(x / 1500, z / 1500, 82);
      const h = 14
        + amp * (0.35 * (0.5 + 0.5 * fbm(wx / 900, wz / 900, 83)) + 0.75 * ridge(wx / 520, wz / 520, 84))
        + 18 * ridge(wx / 140, wz / 140, 85) * smooth(200, 900, out);
      farH[i * FAR.n + j] = h;
    }
  }
}
man.farTerrain = {
  enabled: true, n: FAR.n, extent: FAR.extent,
  stand: 1, standStart: 100, standEnd: 1500, blend: 220,
  // Our layers: 0 golden meadow, 1 rock. Out there a slope is measured over
  // 12 m cells, so the bands sit lower than the map's own (alg's lesson).
  rule: { flatSlot: 0, highSlot: 1, screeSlot: 0, cliffSlot: 1, screeLo: 14, screeHi: 24, cliffLo: 24, cliffHi: 34, highLo: 170, highHi: 230 },
};

const norm = H.map((v) => Math.max(0, Math.min(1, v / TOP)));
const blobs = new Map([
  ["heightmap", Buffer.from(norm.buffer)],
  ["splat", splat],
  ["grassDensity", grass],
  ["grassHeight", bladeH],
  ["farHeight", Buffer.from(farH.buffer)],
]);
const bytes = await writeProject(OUT, { manifest: man, blobs });

// ── Spots for the lab page: views + the scale car ─────────────────────────
// The car sits on the trail where the most rock lies within 25 m of it.
const r1 = (v) => Math.round(v * 10) / 10;
let carI = 10, carScore = -1;
for (let i = 10; i < trail.length - 10; i += 2) {
  const [x, z] = trail[i];
  let sc = 0;
  for (const e of placed) if ((e.x - x) ** 2 + (e.z - z) ** 2 < 625) sc += e.rank;
  if (sc > carScore) { carScore = sc; carI = i; }
}
const [cx, cz] = trail[carI], [nx2, nz2] = trail[Math.min(trail.length - 1, carI + 3)];
const back = trail[Math.max(0, carI - 14)];
const mid = trail[Math.floor(trail.length * 0.5)], midAhead = trail[Math.floor(trail.length * 0.62)];
const bigOut = outcrops.filter((o) => o.cls === "cliff").sort((a, b) => b.r - a.r)[0] ?? outcrops[0];
const spots = {
  car: { x: r1(cx), z: r1(cz), yaw: +Math.atan2(nx2 - cx, nz2 - cz).toFixed(3) },
  views: {
    top:      { label: "Top-down (the reference shot)", pos: [r1(cx + 4), r1(hAt(cx, cz) + 44), r1(cz + 16)], target: [r1(cx), r1(hAt(cx, cz)), r1(cz - 6)] },
    chase:    { label: "Low chase", pos: [r1(back[0]), r1(hAt(back[0], back[1]) + 4.5), r1(back[1])], target: [r1(nx2), r1(hAt(nx2, nz2) + 1.5), r1(nz2)] },
    mountain: { label: "The mountain from the valley", pos: [80, 60, 110], target: [-35, 45, -120] },
    trail:    { label: "Up the trail", pos: [r1(mid[0]), r1(hAt(mid[0], mid[1]) + 6), r1(mid[1])], target: [r1(midAhead[0]), r1(hAt(midAhead[0], midAhead[1]) + 2), r1(midAhead[1])] },
    outcrop:  { label: "An outcrop close up", pos: [r1(bigOut.x + bigOut.dx * 32), r1(hAt(bigOut.x + bigOut.dx * 32, bigOut.z + bigOut.dz * 32) + 6), r1(bigOut.z + bigOut.dz * 32)], target: [r1(bigOut.x), r1(hAt(bigOut.x, bigOut.z) + 2), r1(bigOut.z)] },
    field:    { label: "Boulder field", pos: [40, 44, 150], target: [110, 22, 90] },
  },
};
fs.writeFileSync(SPOTS, `// Written by tools/rockLabLevel.mjs — do not edit by hand.\nexport const SPOTS = ${JSON.stringify(spots)};\n`);

// ── Report ────────────────────────────────────────────────────────────────
const T = S * S;
const count = (c) => placed.filter((e) => e.cls === c).length;
let steep = 0, hiH = 0;
for (let k = 0; k < N * N; k++) hiH = Math.max(hiH, H[k]);
for (let z = -HALF + 2; z < HALF - 2; z += 4) for (let x = -HALF + 2; x < HALF - 2; x += 4) if (slopeAt(x, z, 2) > 35) steep++;
const trailGrades = [];
let worstAt = null, worst = 0;
for (let i = 4; i < trail.length; i += 4) { const gr = Math.abs(hAt(...trail[i]) - hAt(...trail[i - 4])) / 4; trailGrades.push(gr); if (gr > worst) { worst = gr; worstAt = [i, trail[i].map(r1)]; } }
console.log("steepest trail step at", worstAt, "of", trail.length, "; steps over 30%:", trailGrades.filter((g) => g > 0.3).length);
trailGrades.sort((a, b) => a - b);
console.log(`${OUT}: ${(bytes / 1e6).toFixed(1)} MB — ${W} m, ${N}² heights, ${S}² paint; top ${hiH.toFixed(1)} m, ${(100 * steep / ((W / 4) ** 2)).toFixed(1)}% steeper than 35°`);
console.log(`outcrops ${outcrops.length} (cliff ${count("cliff")}, crag-in-slope ${outcrops.length - count("cliff")}); rocks total ${placed.length}: crag ${count("crag")}, block ${count("block")}, rock ${count("rock")}, pebble ${count("pebble")}`);
console.log(`prop types ${types.length}, instances ${instances.length}`);
console.log(`paint: meadow ${(100 * share[0] / T).toFixed(1)}%  rock ${(100 * share[1] / T).toFixed(1)}%  earth ${(100 * share[2] / T).toFixed(1)}%  track ${(100 * share[3] / T).toFixed(1)}%`);
console.log(`trail ${trail.length} m, ${r1(hAt(...trail[0]))} → ${r1(hAt(...trail[trail.length - 1]))} m; grade median ${(100 * trailGrades[trailGrades.length >> 1]).toFixed(0)}%, p95 ${(100 * trailGrades[Math.floor(trailGrades.length * 0.95)]).toFixed(0)}%, max ${(100 * trailGrades[trailGrades.length - 1]).toFixed(0)}%`);
console.log(`car at (${r1(cx)}, ${r1(cz)}) on the trail; spots → ${SPOTS}`);
