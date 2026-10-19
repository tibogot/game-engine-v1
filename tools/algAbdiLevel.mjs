/**
 * MAP 4 — AURÈS, OUED ABDI (2026-10-19, games/alg-rts/AURES2_PLAN.md): its ground SHAPED FOR PLAY from the
 * layout in games/alg-rts/maps/abdi.js, built FROM THE EMPTY BASE (tools/algBaseLevel.mjs) every time — the
 * Aurès look (sky, light, plants), nothing of another map. The old Aurès (alg-aures.v3proj) is not touched.
 *
 *   node tools/algAbdiLevel.mjs [--from <base.v3proj>] [--out <new.v3proj>]
 *
 * READABLE FIRST (the old Aurès' lessons): the fighting ground calm and walkable — CoH-flat where the points
 * are, the slopes BETWEEN places as steps and ramps; rocky paint only on the frame nobody fights on.
 *   the valley   the floor falling gently south-east, low swells, calm round every site
 *   the djebel   north and west: inside the box TERRACED (walkable steps, the FLN's ground), outside it the
 *                skyline rising to ~95 m
 *   the knoll    the town's, a flat-topped rise ~9 m over the valley
 *   the oued     across the valley, its banks steep, three fords (the chokepoints)
 *   the gullies  two ravines down from the djebel (the FLN's ways down), floors walkable
 *   the pistes   carved (tools/lib/trackCarve.mjs)
 * THE PAINT (the base's Aurès slots, kept so the game's splats / stones / minimap work unchanged):
 *   0 valley soil · 1 red earth (hollows, terraces) · 2 scree (the frame's slopes) · 3 the oasis' grove ·
 *   4 the oued's bed · 5 cliff rock (the frame's faces only) · 6 the pistes
 */
import { readProject, writeProject } from "./lib/v3proj.mjs";
import { blankManifest, BASE_LEVEL } from "./lib/algLevelBase.mjs";
import { measureRtsMap, printRtsMetrics } from "./lib/rtsMapMetrics.mjs";
import { trackCarver, PISTE } from "./lib/trackCarve.mjs";
import { PLAY, LAYOUT } from "../games/alg-rts/maps/abdi.js";

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
args.out ??= "public/levels/alg-abdi.v3proj";
args.from ??= BASE_LEVEL;

const tpl = await readProject(args.from);
const man = tpl.manifest;
const { worldSize: W, heightmapSize: N, maxHeight: TOP } = man.terrain;
const cell = W / (N - 1);

// ── Noise, polylines (as tools/algKantaraLevel.mjs) ────────────────────────
const hash = (x, z, s) => { let h = Math.imul(x, 374761393) ^ Math.imul(z, 668265263) ^ Math.imul(s, 2147483647); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
const sm = (t) => t * t * (3 - 2 * t);
function noise(x, z, s = 1) {
  const xi = Math.floor(x), zi = Math.floor(z), fx = sm(x - xi), fz = sm(z - zi);
  const a = hash(xi, zi, s), b = hash(xi + 1, zi, s), c = hash(xi, zi + 1, s), d = hash(xi + 1, zi + 1, s);
  return (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fz;
}
const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const smooth01 = (t) => smoothstep(0, 1, t);
function spline(pts, step = 2) {
  const out = [];
  for (let k = 0; k < pts.length - 1; k++) {
    const p0 = pts[Math.max(0, k - 1)], p1 = pts[k], p2 = pts[k + 1], p3 = pts[Math.min(pts.length - 1, k + 2)];
    const n = Math.max(1, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / step));
    for (let i = 0; i < n; i++) {
      const t = i / n, t2 = t * t, t3 = t2 * t;
      const f = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}
function polyField(pts) {
  const segs = [], at = [0];
  for (let k = 0; k < pts.length - 1; k++) {
    segs.push([pts[k][0], pts[k][1], pts[k + 1][0], pts[k + 1][1]]);
    at.push(at[k] + Math.hypot(pts[k + 1][0] - pts[k][0], pts[k + 1][1] - pts[k][1]));
  }
  const Bn = 16, grid = new Map(), key = (i, j) => `${i},${j}`;
  segs.forEach((s, idx) => {
    const i0 = Math.floor(Math.min(s[0], s[2]) / Bn), i1 = Math.floor(Math.max(s[0], s[2]) / Bn);
    const j0 = Math.floor(Math.min(s[1], s[3]) / Bn), j1 = Math.floor(Math.max(s[1], s[3]) / Bn);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) { const k = key(i, j); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(idx); }
  });
  const field = (x, z, reach = 400) => {
    let best = Infinity, px = x, pz = z, tx = 1, tz = 0, s = 0;
    const ci = Math.floor(x / Bn), cj = Math.floor(z / Bn);
    for (let r = 0; r * Bn <= reach; r++) {
      for (let i = ci - r; i <= ci + r; i++) for (let j = cj - r; j <= cj + r; j++) {
        if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== r) continue;
        for (const idx of grid.get(key(i, j)) ?? []) {
          const [ax, az, bx, bz] = segs[idx], dx = bx - ax, dz = bz - az, L = dx * dx + dz * dz || 1;
          const u = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L));
          const d = Math.hypot(x - (ax + dx * u), z - (az + dz * u));
          if (d < best) { best = d; px = ax + dx * u; pz = az + dz * u; const l = Math.sqrt(L); tx = dx / l; tz = dz / l; s = at[idx] + u * l; }
        }
      }
      if (best < (r - 1) * Bn) break;
    }
    return { d: best, px, pz, tx, tz, s };
  };
  field.len = at[at.length - 1];
  return field;
}
const outside = (x, z) => Math.hypot(Math.max(PLAY.x0 - x, 0, x - PLAY.x1), Math.max(PLAY.z0 - z, 0, z - PLAY.z1));

// ── The layout's shapes ───────────────────────────────────────────────────
const wadi = LAYOUT.wadis[0];
// (the oued runs on, past the box, to the map's edges)
const wadiAt = polyField(spline([[-560, -20], ...wadi.points, [560, 10]], 2));
const gullyAt = LAYOUT.gullies.map((g) => polyField(spline(g.points, 2)));
const pisteAt = LAYOUT.pistes.map((p) => polyField(spline(p, 2)));
const site = (k) => LAYOUT.sites.find((s) => s.kind === k);
const TOWN = site("town"), KNOLL = { x: TOWN.knoll[0], z: TOWN.knoll[1], r: TOWN.knoll[2] };
const OASIS = site("oasis");
const flats = LAYOUT.sites.map((s) => ({ x: s.x, z: s.z, r: s.r + 14 }));
/** 1 away from the sites, 0 on them (the ground calmed under a place). */
const calmK = (x, z) => flats.reduce((k, f) => Math.min(k, smoothstep(f.r * 0.55, f.r, Math.hypot(x - f.x, z - f.z))), 1);

const PLAIN = 22;
/** The valley floor: falling gently to the south-east. */
const floorAt = (x, z) => PLAIN - z * 0.01 - x * 0.006;
/** How far INTO the djebel (m, north-west of its foot; the foot a line from (-250, 20) to (250, -120), wobbling). */
const djebelD = (x, z) => (20 - (x + 250) * 0.28 + 14 * (noise(x / 70, 3.3, 5) - 0.5)) - z;
/** The terraces: levels STEP_H high, each a walkable plateau with a short ramp up to the next. */
const STEP_H = 5, STEP_L = 32;
function terraces(d) {
  if (d <= 0) return 0;
  const s = d / STEP_L, f = s - Math.floor(s);
  return (Math.floor(s) + smoothstep(0.62, 0.95, f)) * STEP_H;
}

function naturalAt(x, z) {
  const calm = calmK(x, z), o = outside(x, z);
  let h = floorAt(x, z);
  // low swells on the valley floor (two scales), calmed on the sites
  const swell = (noise(x / 90, z / 90, 3) - 0.5) * 2 * 1.4 + (noise(x / 34, z / 34, 7) - 0.5) * 2 * 0.45;
  h += swell * calm;
  // THE DJEBEL: terraced inside the box (at most ~4 steps), then the skyline outside it
  const d = djebelD(x, z);
  if (d > 0) {
    const inBox = Math.min(terraces(d), 4 * STEP_H);
    h += inBox * (0.85 + 0.3 * noise(x / 60, z / 60, 11));
    h += smoothstep(0, 160, o) * smoothstep(0, 60, d) * 75 * (0.7 + 0.5 * noise(x / 90, z / 90, 13));
  }
  // the frame south and east: low hills rising past the box
  if (o > 0 && d <= 0) h += smoothstep(0, 140, o) * 22 * (0.5 + noise(x / 80, z / 80, 17));
  // THE KNOLL (the town): flat-topped, a soft shoulder
  const kd = Math.hypot(x - KNOLL.x, z - KNOLL.z);
  h += 9 * (1 - smoothstep(KNOLL.r * 0.55, KNOLL.r * 1.15, kd + 6 * (noise(x / 20, z / 20, 19) - 0.5)));
  // THE GULLIES: ravines down the djebel — a flat floor 10 m wide, banks steep, depth with the terraces
  for (const g of gullyAt) {
    const q = g(x, z, 40);
    if (q.d < 20) {
      const depth = Math.min(8, 2 + Math.max(0, d) * 0.06);
      h -= depth * (1 - smoothstep(5, 14, q.d + 2 * (noise(x / 9, z / 9, 23) - 0.5)));
    }
  }
  // THE OUED: the valley eased toward it, a channel with STEEP banks, shallower at its fords
  const w = wadiAt(x, z, 60);
  if (w.d < wadi.width + 16) {
    const f = (w.s - 0) / wadiAt.len;
    // (the fords' fractions are along the box's oued: re-measured on the extended line)
    const ford = FORDS.reduce((k, fp) => Math.max(k, 1 - smoothstep(10, 22, Math.abs(w.s - fp))), 0);
    const fl = floorAt(x, z);
    h = fl + (h - fl) * smoothstep(wadi.width * 0.7, wadi.width + 16, w.d);
    const bank = ford > 0.01 ? smoothstep(wadi.width * 0.3, wadi.width * 1.2, w.d) : smoothstep(wadi.width * 0.45, wadi.width * 0.62, w.d);
    h -= (1 - bank) * wadi.depth * (1 - 0.8 * ford);
    void f;
  }
  return h;
}
// the fords: their arc length along the extended oued
const FORDS = (() => {
  const inner = polyField(spline(wadi.points, 2));
  return wadi.fords.map((fr) => {
    // the point at that fraction of the box's oued, then its arc length on the extended line
    const pts = spline(wadi.points, 2), target = fr * inner.len;
    let acc = 0;
    for (let k = 1; k < pts.length; k++) {
      const l = Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
      if (acc + l >= target) { const t = (target - acc) / l; const p = [pts[k - 1][0] + (pts[k][0] - pts[k - 1][0]) * t, pts[k - 1][1] + (pts[k][1] - pts[k - 1][1]) * t]; return wadiAt(p[0], p[1], 20).s; }
      acc += l;
    }
    return 0;
  });
})();
/** EVERY SITE LEVELLED: the ground under a place blended to its own height (its centre's, before
 *  levelling), a soft rim beyond — a camp on a terrace step or a souk on the knoll's shoulder stood on 4-10 m
 *  of relief (measured, the first build). */
const LEVEL = LAYOUT.sites.map((s) => ({ x: s.x, z: s.z, r: s.r * 0.9, rim: s.r * 0.6 + 8, h: naturalAt(s.x, s.z) }));
function levelledAt(x, z) {
  let h = naturalAt(x, z);
  for (const L of LEVEL) {
    const d = Math.hypot(x - L.x, z - L.z);
    if (d < L.r + L.rim) h = L.h + (h - L.h) * smoothstep(L.r, L.r + L.rim, d);
  }
  return h;
}
/** The ground with every piste CARVED in. */
let ground = (x, z) => levelledAt(x, z);
for (const p of pisteAt) { const base = ground, carve = trackCarver(base, p, PISTE); ground = (x, z) => carve(x, z, base(x, z)); }
const heightAt = ground;

// ── Heights ──────────────────────────────────────────────────────────────
const hgt = new Float32Array(N * N);
let hi = 0, lo = Infinity;
for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
  const v = heightAt(-W / 2 + j * cell, -W / 2 + i * cell);   // row 0 = north (−Z)
  hgt[i * N + j] = Math.max(0, v) / TOP;
  if (v > hi) hi = v; if (v < lo) lo = v;
}
if (hi > TOP) throw new Error(`the ground reaches ${hi.toFixed(1)} m, over the level's ${TOP} m`);
const H = (x, z) => {
  const fu = Math.max(0, Math.min(N - 1.001, (x + W / 2) / cell)), fv = Math.max(0, Math.min(N - 1.001, (z + W / 2) / cell));
  const x0 = fu | 0, y0 = fv | 0, tx = fu - x0, ty = fv - y0;
  const a = hgt[y0 * N + x0], b = hgt[y0 * N + x0 + 1], c = hgt[(y0 + 1) * N + x0], d = hgt[(y0 + 1) * N + x0 + 1];
  return ((a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty) * TOP;
};
const grad = (x, z, e = 2) => [(H(x + e, z) - H(x - e, z)) / (2 * e), (H(x, z + e) - H(x, z - e)) / (2 * e)];
const slopeDeg = (x, z) => (Math.atan(Math.hypot(...grad(x, z, 1.5))) * 180) / Math.PI;
function hollow(x, z, r = 9) {
  let s = 0;
  for (let k = 0; k < 8; k++) { const a = (k / 8) * Math.PI * 2; s += H(x + Math.cos(a) * r, z + Math.sin(a) * r); }
  return s / 8 - H(x, z);
}

// ── Paint, by the relief — calm in the box, rock only on the frame ──────────
const S = man.terrain.splatSize ?? man.splatRes;
const splat = Buffer.alloc(S * S * 8);
const put = (t, c, v) => { splat[(c >> 2) * S * S * 4 + t * 4 + (c & 3)] = v; };
const pisteD = (x, z, r) => Math.min(...pisteAt.map((p) => p(x, z, r).d));
for (let i = 0; i < S; i++) for (let j = 0; j < S; j++) {
  const x = -W / 2 + ((j + 0.5) * W) / S, z = -W / 2 + ((i + 0.5) * W) / S, t = i * S + j;
  const w = new Float32Array(7), sl = slopeDeg(x, z), o = outside(x, z), frame = smoothstep(10, 50, o);
  const road = 1 - smoothstep(3.0, 5.2, pisteD(x, z, 20));
  const bed = 1 - smoothstep(wadi.width * 0.35, wadi.width * 0.6, wadiAt(x, z, 30).d);
  // the frame only: cliff faces where steep, scree on its slopes; in the box a steep bank is red earth
  const cliff = frame * smoothstep(30, 42, sl);
  const scree = frame * smoothstep(14, 26, sl);
  const grove = 1 - smoothstep(OASIS.r + 6, OASIS.r + 26, Math.hypot(x - OASIS.x, z - OASIS.z) + 10 * (noise(x / 14, z / 14, 46) - 0.5));
  const d = djebelD(x, z);
  const red = Math.min(1, smoothstep(0.08, 0.6, hollow(x, z) + (noise(x / 18, z / 18, 41) - 0.5) * 0.5) * 0.7
    + smoothstep(18, 30, sl) * 0.6 + smoothstep(0, 40, d) * 0.35 * smoothstep(0.45, 0.65, noise(x / 40, z / 40, 43)));
  w[6] = road;
  let rest = 1 - road;
  w[4] = rest * bed; rest -= w[4];
  w[5] = rest * cliff; rest -= w[5];
  w[2] = rest * scree; rest -= w[2];
  w[3] = rest * grove; rest -= w[3];
  w[1] = rest * red; rest -= w[1];
  w[0] = rest;
  const sum = w.reduce((a, b) => a + b, 0) || 1;
  for (let c = 0; c < 7; c++) if (w[c]) put(t, c, Math.round((255 * w[c]) / sum));
}

// ── Plants (the base's slots) ──────────────────────────────────────────────
const patches = (x, z, scale, cover, s) => {
  const n = noise(x / scale, z / scale, s) * 0.7 + noise(x / (scale * 0.35), z / (scale * 0.35), s + 7) * 0.3;
  return smooth01((n - (1 - cover)) / 0.12);
};
const clear = LAYOUT.sites.map((s) => ({ x: s.x, z: s.z, r: s.r + 8 }));
const fordPts = FORDS;
function growK(x, z, bedOk = false) {
  let k = smooth01((pisteD(x, z, 20) - 5) / 4) * (1 - smoothstep(26, 34, slopeDeg(x, z)));
  if (!bedOk) k *= smoothstep(wadi.width * 0.5, wadi.width * 0.9, wadiAt(x, z, 30).d);
  const w = wadiAt(x, z, 40);
  if (w.d < 30) for (const fs of fordPts) k *= smoothstep(14, 26, Math.abs(w.s - fs));   // the fords stay open
  for (const c of clear) k = Math.min(k, smooth01((Math.hypot(x - c.x, z - c.z) - c.r) / 8));
  return k;
}
const bankK = (x, z, a, b) => smoothstep(b, a, wadiAt(x, z, 40).d);
const oasisIn = (x, z) => 1 - smoothstep(OASIS.r + 4, OASIS.r + 22, Math.hypot(x - OASIS.x, z - OASIS.z));
const djebel = (x, z) => smoothstep(0, 50, djebelD(x, z));
const TALL = {
  0: (x, z) => 0.5 * djebel(x, z) * smoothstep(20, 120, outside(x, z)) * patches(x, z, 40, 0.55, 30),        // cedars on the skyline
  1: (x, z) => 0.3 * djebel(x, z) * (1 - smoothstep(20, 80, outside(x, z))) * patches(x, z, 34, 0.32, 31),   // holm oaks: the FLN's cover
  2: (x, z) => 0.6 * oasisIn(x, z) * patches(x, z, 16, 0.55, 34) + 0.25 * bankK(x, z, 16, 30) * patches(x, z, 30, 0.25, 35),   // date palms
  3: (x, z) => 0.35 * djebel(x, z) * patches(x, z, 26, 0.4, 36),                                               // juniper scrub
};
const GROUND = {
  0: (x, z) => (0.4 + 0.3 * smoothstep(0, 0.5, hollow(x, z))) * patches(x, z, 24, 0.4, 40) * (1 - oasisIn(x, z)),   // alfa
  1: (x, z) => 0.3 * Math.max(oasisIn(x, z) * 0.7, bankK(x, z, 14, 24) * 0.6) * patches(x, z, 20, 0.35, 41),        // doum palms
  3: (x, z) => 0.5 * bankK(x, z, 8, 14),                                                                              // oleander
  4: (x, z) => 0.35 * bankK(x, z, 10, 20) * patches(x, z, 25, 0.5, 44),                                              // tamarisk
  5: (x, z) => 0.4 * Math.max(...LAYOUT.sites.filter((s) => ["farm", "hamlet", "oasis"].includes(s.kind)).map((s) => { const r = Math.hypot(x - s.x, z - s.z); return smoothstep(s.r + 4, s.r + 10, r) * (1 - smoothstep(s.r + 16, s.r + 26, r)); })) * patches(x, z, 10, 0.5, 42),   // prickly pear hedges
  7: (x, z) => 0.25 * (1 - djebel(x, z)) * patches(x, z, 40, 0.3, 47),                                               // asphodel
};
function plantPaint(res, pages, fns) {
  const out = Buffer.alloc(res * res * 4 * pages), counts = {};
  for (let pz = 0; pz < res; pz++) {
    const z = ((pz + 0.5) / res) * W - W / 2;
    for (let px = 0; px < res; px++) {
      const x = ((px + 0.5) / res) * W - W / 2;
      if (outside(x, z) > 220) continue;
      const k = growK(x, z), kBank = growK(x, z, true);
      for (const [ch, fn] of Object.entries(fns)) {
        const g = pages === 2 && (+ch === 3 || +ch === 4) ? kBank : k;
        const v = Math.round(Math.max(0, Math.min(1, fn(x, z) * g)) * 255);
        if (!v) continue;
        out[((ch / 4) | 0) * res * res * 4 + (pz * res + px) * 4 + (ch % 4)] = v;
        counts[ch] = (counts[ch] ?? 0) + 1;
      }
    }
  }
  return { out, counts };
}
const tallPaint = plantPaint(512, 1, TALL);
const groundPaint = plantPaint(1024, 2, GROUND);

// ── Manifest: the base's look and its Aurès slots (kept: the game's splats / stones / minimap read them) ──
blankManifest(man);
const blobs = new Map([["heightmap", Buffer.from(hgt.buffer)], ["splat", splat], ["susukiDensity", tallPaint.out], ["foliagePaint", groundPaint.out]]);
const bytes = await writeProject(args.out, { manifest: man, blobs });
console.log(`${args.out}: ${(bytes / 1e6).toFixed(1)} MB — the ground ${lo.toFixed(1)}..${hi.toFixed(1)} m`);
console.log(`plants (texels): tall ${JSON.stringify(tallPaint.counts)} · ground ${JSON.stringify(groundPaint.counts)}`);
for (const s of LAYOUT.sites) {
  let mx = 0; for (let k = 0; k < 8; k++) { const a = (k / 8) * Math.PI * 2; mx = Math.max(mx, Math.abs(H(s.x + Math.cos(a) * s.r * 0.7, s.z + Math.sin(a) * s.r * 0.7) - H(s.x, s.z))); }
  console.log(`  ${s.name.padEnd(22)} ${H(s.x, s.z).toFixed(1)} m, relief over its ground ${mx.toFixed(1)} m`);
}
const bx = Math.round(PLAY.x1 - PLAY.x0), box = new Float32Array(bx * bx);
for (let i = 0; i < bx; i++) for (let j = 0; j < bx; j++) box[i * bx + j] = H(PLAY.x0 + j, PLAY.z0 + i);
printRtsMetrics(measureRtsMap(box, bx, bx - 1), "the box");
