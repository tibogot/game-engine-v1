/**
 * THE COAST LEVEL for the Algeria RTS (2026-10-12, rebuilt): its ground SHAPED FOR PLAY, from the
 * data in games/alg-rts/maps/coast.js — not a cut of the real coast any more (that build, from
 * algDem's Filfila cut, is in git: it gave a straight synthetic beach, a flat shelf and a corner of
 * sea). You: "smaller like CoH, a bit more flat; the sea should take more of the map".
 *
 *   node tools/algCoastLevel.mjs                       rebuild the coast IN PLACE (its own look)
 *   node tools/algCoastLevel.mjs --from <other.v3proj> --out <new.v3proj> [--force 1]
 *
 * THE GROUND
 *   the shore   coast.js SHORE, smoothed; every point's SIGNED distance to it (+ land, − sea)
 *   the sea     the seabed on TIDEWATER'S BAY PROFILE by distance out (5% for 70 m, 6% to 260 m,
 *               7% beyond, a longshore bar) — the colour gradient the game sea (algSea.js) draws
 *   the beach   sand rising gently (5%) for ~28 m, a berm; then the PLAIN, near flat, gentle swells
 *   headland    a dome in the north-east, cliffs where it meets the sea
 *   the wadi    coast.js wadis: a channel down to the bottom of the bay, its mouth in the sea
 *   ridges      low (≤ ~10 m) in the south-east, the FLN's side; hills framing it outside the box
 * THE PAINT   0 coastal plain (red earth, dry grass) · 1 beach sand · 2 seabed · 3 maquis ·
 *             4 wadi bed · 5 cliff rock · 6 the track (the template's 4-6 photos kept)
 * THE PLANTS  the template's slots, painted sparse: cork / holm oaks and junipers in the maquis and
 *             on the ridges, date palms by the post, oleander, reeds and tamarisk along the wadi,
 *             doum palms, prickly pear round the sites, thistle and asphodel drifts
 * NO OCEAN in the level (its worldOcean kept, switched off): the game draws its own sea and answers
 * the sea level itself (maps/coast.js sea.level; Ocean Pro compiled at the first frames and logged an
 * MSAA depth-type WGSL error). ?sea=pro switches Ocean Pro on at runtime, to compare.
 */
import fs from "node:fs";
import { readProject, writeProject } from "./lib/v3proj.mjs";
import { PLAY, LAYOUT, MAP, SHORE, SEA_LEVEL } from "../games/alg-rts/maps/coast.js";

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
args.out ??= "public/levels/alg-coast.v3proj";
args.from ??= args.out;   // in place: the coast's own look
if (args.from !== args.out && fs.existsSync(args.out) && args.force !== "1") throw new Error(`${args.out} exists — --force 1 to rebuild it`);

const tpl = await readProject(args.from);
const man = tpl.manifest;
const { worldSize: W, heightmapSize: N, maxHeight: TOP } = man.terrain;
const cell = W / (N - 1);
const SEA = SEA_LEVEL;

// ── Noise (Math.imul: the plain JS multiply loses bits past 2^53) ──────────
const hash = (x, z, s) => { let h = Math.imul(x, 374761393) ^ Math.imul(z, 668265263) ^ Math.imul(s, 2147483647); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
const sm = (t) => t * t * (3 - 2 * t);
function noise(x, z, s = 1) {
  const xi = Math.floor(x), zi = Math.floor(z), fx = sm(x - xi), fz = sm(z - zi);
  const a = hash(xi, zi, s), b = hash(xi + 1, zi, s), c = hash(xi, zi + 1, s), d = hash(xi + 1, zi + 1, s);
  return (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fz;   // 0..1
}
const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const smooth01 = (t) => smoothstep(0, 1, t);

// ── Polylines: the shore (signed), the wadi, the track ─────────────────────
/** Catmull-Rom through the points, resampled every `step` m. */
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
/** A polyline's distance field on a grid (coarse 2 m bins → nearest segment), and for the shore its SIDE. */
function polyField(pts) {
  const segs = [];
  for (let k = 0; k < pts.length - 1; k++) segs.push([pts[k][0], pts[k][1], pts[k + 1][0], pts[k + 1][1]]);
  const B = 16, grid = new Map();   // 16 m bins of segment indices
  const key = (i, j) => `${i},${j}`;
  segs.forEach((s, idx) => {
    const i0 = Math.floor(Math.min(s[0], s[2]) / B), i1 = Math.floor(Math.max(s[0], s[2]) / B);
    const j0 = Math.floor(Math.min(s[1], s[3]) / B), j1 = Math.floor(Math.max(s[1], s[3]) / B);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) { const k = key(i, j); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(idx); }
  });
  /** { d: distance (m), side: cross > 0 = right of the walk } */
  return (x, z, reach = 400) => {
    let best = Infinity, side = 0;
    const ci = Math.floor(x / B), cj = Math.floor(z / B);
    for (let r = 0; r * B <= reach; r++) {
      for (let i = ci - r; i <= ci + r; i++) for (let j = cj - r; j <= cj + r; j++) {
        if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== r) continue;
        for (const idx of grid.get(key(i, j)) ?? []) {
          const [ax, az, bx, bz] = segs[idx], dx = bx - ax, dz = bz - az, L = dx * dx + dz * dz || 1;
          const u = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L));
          const d = Math.hypot(x - (ax + dx * u), z - (az + dz * u));
          if (d < best) { best = d; side = dx * (z - az) - dz * (x - ax); }
        }
      }
      if (best < (r - 1) * B) break;   // nothing nearer can be further out
    }
    return { d: best, side };
  };
}
const shoreAt = polyField(spline(SHORE, 2));
/** Signed distance to the shore: + on the land (right of the walk), − in the sea. Past the shore's
 *  ends (the map's corners), the land side is south / east. */
function shoreSigned(x, z) {
  const { d, side } = shoreAt(x, z, 700);
  return side >= 0 ? d : -d;
}
const wadi = LAYOUT.wadis[0], wadiAt = polyField(spline(wadi.points, 2));
const trackAt = polyField(spline(MAP.tracks[0].points, 2));
const HEAD = { x: 196, z: -196, r: 62, h: 16 };   // the headland's dome
/** Distance outside the play box (0 inside). */
const outside = (x, z) => Math.hypot(Math.max(PLAY.x0 - x, 0, x - PLAY.x1), Math.max(PLAY.z0 - z, 0, z - PLAY.z1));
const flats = LAYOUT.sites.map((s) => ({ x: s.x, z: s.z, r: s.r + 16 }));

/** Height under the sea (m, ≤ 0) `d` m out from the shore: Tidewater's bay profile and its bar. */
function seabed(d) {
  const depth = d < 70 ? d * 0.05 : d < 260 ? 3.5 + (d - 70) * 0.06 : 14.9 + (d - 260) * 0.07;
  const bar = Math.exp(-(((d - 44) / 10) ** 2)) * 0.28 - Math.exp(-(((d - 26) / 9) ** 2)) * 0.31;
  return -Math.min(depth - bar, SEA - 0.5);
}

let lastS = 0;   // the last point's signed shore distance (kept per heightmap cell for the paint)
function heightAt(x, z) {
  const s = (lastS = shoreSigned(x, z));
  const hm = Math.exp(-((Math.hypot(x - HEAD.x, z - HEAD.z) / (HEAD.r * 1.15)) ** 2));   // the headland
  let h;
  if (s < 0) {
    // THE SEA: the seabed; off the headland a steeper drop (rocks, not sand)
    h = SEA + seabed(-s * (1 + hm * 1.6));
  } else {
    // THE BEACH, 5% for ~28 m, a berm, then the plain at ~+2 m with gentle swells
    let calm = 1;
    for (const f of flats) calm = Math.min(calm, smoothstep(f.r * 0.6, f.r, Math.hypot(x - f.x, z - f.z)));
    const beach = Math.min(s, 28) * 0.05 + 0.25 * smoothstep(22, 30, s);
    const swell = ((noise(x / 85, z / 85, 3) - 0.5) * 2.2 + (noise(x / 32, z / 32, 7) - 0.5) * 0.6) * smoothstep(25, 70, s) * (0.3 + 0.7 * calm);
    const plain = smoothstep(28, 140, s) * 1.2;
    // the RIDGES inland, south-east: low and gentle
    const se = smoothstep(-40, 160, x * 0.7 + z * 0.7);
    const ridges = se * smoothstep(120, 260, s) * (5 + 5 * noise(x / 70, z / 70, 11)) * (0.5 + 0.5 * calm);
    // THE HEADLAND: a dome, and cliffs where it meets the sea (no beach there)
    const cliff = Math.min(s, 9) * 1.4;
    const head = hm * (HEAD.h * Math.exp(-((Math.hypot(x - HEAD.x, z - HEAD.z) / HEAD.r) ** 2)) + cliff);
    h = SEA + (beach + plain + swell + ridges) * (1 - hm) + head;
    // the framing hills outside the box, land side
    const o = outside(x, z);
    if (o > 0) h += 40 * smoothstep(8, 220, o) * (0.6 + 0.4 * noise(x / 90, z / 90, 13)) * smoothstep(20, 80, s);
  }
  // THE WADI: a channel (flat bed, soft banks), DRY — its bed kept 0.35 m over the sea, except its
  // last ~18 m, where it runs into the sea (the plain is only ~1.5 m up near the shore: a 2.2 m
  // channel there went under the sea and the sea flooded it inland among the trees)
  const wd = wadiAt(x, z, 60).d;
  if (wd < wadi.width) {
    const k = 1 - smoothstep(wadi.width * 0.4, wadi.width, wd);
    const floor = SEA + 0.35 - 0.75 * (1 - smoothstep(4, 18, s));
    h = Math.max(h - k * wadi.depth, Math.min(h, floor));
  }
  return Math.max(0.2, h);
}

// ── Heights ──────────────────────────────────────────────────────────────
const hgt = new Float32Array(N * N), sGrid = new Float32Array(N * N);
let hi = 0, seaN = 0, boxN = 0, boxSea = 0;
for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
  const x = -W / 2 + j * cell, z = -W / 2 + i * cell;   // row 0 = north (−Z)
  const v = heightAt(x, z);
  hgt[i * N + j] = v / TOP;
  sGrid[i * N + j] = lastS;
  if (v > hi) hi = v;
  if (v < SEA) seaN++;
  if (!outside(x, z)) { boxN++; if (v < SEA) boxSea++; }
}
if (hi > TOP) throw new Error(`the hills reach ${hi.toFixed(1)} m, over the level's ${TOP} m`);
/** The signed shore distance (m, + land) at a world point, bilinear from the height pass's grid. */
const Sd = (x, z) => {
  const fu = Math.max(0, Math.min(N - 1.001, (x + W / 2) / cell)), fv = Math.max(0, Math.min(N - 1.001, (z + W / 2) / cell));
  const x0 = fu | 0, y0 = fv | 0, tx = fu - x0, ty = fv - y0;
  const a = sGrid[y0 * N + x0], b = sGrid[y0 * N + x0 + 1], c = sGrid[(y0 + 1) * N + x0], d = sGrid[(y0 + 1) * N + x0 + 1];
  return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
};
const H = (x, z) => {
  const fu = Math.max(0, Math.min(N - 1.001, (x + W / 2) / cell)), fv = Math.max(0, Math.min(N - 1.001, (z + W / 2) / cell));
  const x0 = fu | 0, y0 = fv | 0, tx = fu - x0, ty = fv - y0;
  const a = hgt[y0 * N + x0], b = hgt[y0 * N + x0 + 1], c = hgt[(y0 + 1) * N + x0], d = hgt[(y0 + 1) * N + x0 + 1];
  return ((a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty) * TOP;
};
const slopeDeg = (x, z) => { const e = 1.5; return (Math.atan(Math.hypot(H(x + e, z) - H(x - e, z), H(x, z + e) - H(x, z - e)) / (2 * e)) * 180) / Math.PI; };

// ── Paint ────────────────────────────────────────────────────────────────
const S = man.terrain.splatSize ?? man.splatRes;
const splat = Buffer.alloc(S * S * 8);   // two planar RGBA planes: layer c in plane c >> 2, channel c & 3
const put = (t, c, v) => { splat[(c >> 2) * S * S * 4 + t * 4 + (c & 3)] = v; };
for (let i = 0; i < S; i++) for (let j = 0; j < S; j++) {
  const x = -W / 2 + ((j + 0.5) * W) / S, z = -W / 2 + ((i + 0.5) * W) / S, t = i * S + j;
  const h = H(x, z), depth = SEA - h;
  const w = new Float32Array(7);
  if (depth > 0) {
    // under the sea: the beach's pale sand running out to ~6 m (the Mediterranean's turquoise band:
    // light seen through the shallows over pale sand — 3 m was too short), then the darker seabed
    const sand = 1 - smoothstep(3.5, 7.5, depth);
    w[1] = sand; w[2] = 1 - sand;
  } else {
    const above = -depth;
    // the BEACH by DISTANCE from the shore, ~30 m (by height it ran 60-80 m inland: the plain rises
    // so gently that "under 2.3 m" was most of the coast)
    const sand = 1 - smoothstep(24, 34, Sd(x, z));
    const sl = slopeDeg(x, z);
    const rock = smoothstep(20, 30, sl);                                      // cliffs
    const maquis = smoothstep(0.55, 0.7, noise(x / 45, z / 45, 21)) * 0.85 + smoothstep(4, 10, above - 2) * 0.35;
    const wd = wadiAt(x, z, 30).d, bed = 1 - smoothstep(wadi.width * 0.45, wadi.width * 0.8, wd);
    const trk = 1 - smoothstep(3, 5.5, trackAt(x, z, 30).d);
    w[6] = trk;
    w[4] = (1 - trk) * bed;
    w[5] = (1 - trk) * (1 - bed) * rock;
    w[1] = (1 - trk) * (1 - bed) * (1 - rock) * sand;
    const rest = (1 - trk) * (1 - bed) * (1 - rock) * (1 - sand);
    w[3] = rest * Math.min(1, maquis);
    w[0] = rest * (1 - Math.min(1, maquis));
  }
  const sum = w.reduce((a, b) => a + b, 0) || 1;
  for (let c = 0; c < 7; c++) if (w[c]) put(t, c, Math.round((255 * w[c]) / sum));
}

// ── Plants (the template's slots, sparse) ───────────────────────────────────
const patches = (x, z, scale, cover, s) => {
  const n = noise(x / scale, z / scale, s) * 0.7 + noise(x / (scale * 0.35), z / (scale * 0.35), s + 7) * 0.3;
  return smooth01((n - (1 - cover)) / 0.12);
};
const clearCircles = LAYOUT.sites.map((s) => ({ x: s.x, z: s.z, r: s.r + 10 }));
/** 0 where nothing grows: the sea, the beach, the track, the sites, the steep. */
function growK(x, z) {
  const above = H(x, z) - SEA;
  let k = smoothstep(2.2, 3.5, above) * smooth01((trackAt(x, z, 20).d - 6) / 5) * (1 - smoothstep(24, 32, slopeDeg(x, z)));
  for (const c of clearCircles) k = Math.min(k, smooth01((Math.hypot(x - c.x, z - c.z) - c.r) / 8));
  return k;
}
const wadiK = (x, z, a, b) => { const d = wadiAt(x, z, 40).d; return smoothstep(b, a, d) * (H(x, z) > SEA + 0.3 ? 1 : 0); };
const post = LAYOUT.sites.find((s) => s.kind === "french");
const TALL = {
  1: (x, z, o) => (o > 0 ? 0.55 * patches(x, z, 50, 0.4, 32) : 0.65 * patches(x, z, 40, 0.14, 33) * (0.5 + 0.5 * smoothstep(0.55, 0.7, noise(x / 45, z / 45, 21)))),   // cork / holm oak
  2: (x, z) => { const d = Math.hypot(x - post.x, z - post.z); return smoothstep(post.r + 6, post.r + 14, d) * (1 - smoothstep(post.r + 30, post.r + 44, d)) * patches(x, z, 14, 0.35, 34) * 0.9; },   // date palms by the post
  3: (x, z, o) => (o > 0 ? 0.45 * patches(x, z, 40, 0.5, 36) : 0.35 * patches(x, z, 35, 0.12, 37)),   // juniper
};
const GROUND = {
  1: (x, z) => 0.25 * patches(x, z, 25, 0.14, 41),                         // doum palm
  2: (x, z) => wadiK(x, z, 3, 7) * 0.6 * (1 - smoothstep(-60, 20, z)) ,    // reeds, the wadi's lower reach
  3: (x, z) => wadiK(x, z, 5, 11) * 0.55,                                  // oleander, its banks
  4: (x, z) => wadiK(x, z, 8, 16) * 0.35,                                  // tamarisk, behind them
  5: (x, z) => { let v = 0; for (const s of LAYOUT.sites) { const d = Math.hypot(x - s.x, z - s.z); v = Math.max(v, smoothstep(s.r + 8, s.r + 13, d) * (1 - smoothstep(s.r + 20, s.r + 26, d))); } return v * 0.45 * patches(x, z, 12, 0.45, 42); },   // prickly pear
  6: (x, z) => 0.55 * patches(x, z, 35, 0.12, 43),                         // thistle
  7: (x, z) => 0.55 * patches(x, z, 30, 0.12, 44),                         // asphodel
};
function plantPaint(res, pages, fns, gated = true) {
  const out = Buffer.alloc(res * res * 4 * pages);
  const counts = {};
  for (let pz = 0; pz < res; pz++) {
    const z = ((pz + 0.5) / res) * W - W / 2;
    for (let px = 0; px < res; px++) {
      const x = ((px + 0.5) / res) * W - W / 2, o = outside(x, z);
      if (o > 220) continue;
      const k = growK(x, z);
      for (const [ch, fn] of Object.entries(fns)) {
        // (the wadi's plants: on its banks whatever the slope gate says — the growK only off the sea)
        const g = +ch >= 2 && +ch <= 4 && pages === 2 ? (H(x, z) > SEA + 0.3 ? 1 : 0) * smooth01((trackAt(x, z, 20).d - 6) / 5) : k;
        const v = Math.round(Math.max(0, Math.min(1, fn(x, z, o) * g)) * 255);
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

// ── Manifest: the look kept; the content gone; the coast's photos ──────────
man.trees = { ...man.trees, instances: [] };
man.props = { ...man.props, instances: [] };
man.decals = { ...man.decals, decals: [] };
man.lakes = { ...man.lakes, lakes: [] };
man.roads = { nodes: [], edges: [], nextNodeId: 1, selectedNodeId: null };
for (const k of ["waterfalls", "riversV2", "riverNetwork", "tunnels", "spawn"]) man[k] = null;
if (man.farTerrain) man.farTerrain = { ...man.farTerrain, enabled: false };
if (man.environment?.worldOcean) man.environment = { ...man.environment, worldOcean: { ...man.environment.worldOcean, enabled: false, seaLevel: SEA } };
const photo = (dir, file) => ({ name: file, url: `${dir}/${file}` });
const set = (slot, name, dir, base, maps, look) => {
  man.paintLayers[slot] = { ...man.paintLayers[slot], name,
    albedo: photo(dir, `${base}${maps.diff}`), normal: photo(dir, `${base}${maps.nor}`), rough: photo(dir, `${base}${maps.rough}`),
    ao: maps.ao ? photo(dir, `${base}${maps.ao}`) : null, ...look };
};
const PH = { diff: "diff_1k.jpg", nor: "nor_gl_1k.jpg", rough: "rough_1k.jpg", ao: "ao_1k.jpg" };
const CG = { diff: "Color.jpg", nor: "NormalGL.jpg", rough: "Roughness.jpg", ao: "AmbientOcclusion.jpg" };
set(0, "Coastal plain", "/textures/ground/dirt_aerial_02", "dirt_aerial_02_", PH, { uvScale: W / 20, normalStr: 0.6, aoStr: 0.3, tint: "#e6c6a2" });
// (the beach the LIGHT sand, warmed golden — coast_sand_05 averages (66, 58, 45), near black: it is
// the seabed further out, where the Mediterranean floor turns to seagrass; the beach's sand runs
// in under the shallows first)
// (coast_sand_LIGHT: coast_sand_01 lifted to pale sand — every sand photo we have averages under half
// brightness, the beach read as the plain's brown; a tint can't brighten past white)
set(1, "Beach sand", "/textures/ground/coast_sand_light", "coast_sand_light_", PH, { uvScale: W / 12, normalStr: 0.5, aoStr: 0.25, tint: "#ffffff" });
set(2, "Seabed", "/textures/ground/coast_sand_05", "coast_sand_05_", PH, { uvScale: W / 25, normalStr: 0.5, aoStr: 0.2, tint: "#ffffff" });
set(3, "Maquis", "/textures/pbr_materials/Grass005", "Grass005_1K-JPG_", CG, { uvScale: W / 4, normalStr: 0.6, aoStr: 0.3, tint: "#b9b080" });

const blobs = new Map([["heightmap", Buffer.from(hgt.buffer)], ["splat", splat], ["susukiDensity", tallPaint.out], ["foliagePaint", groundPaint.out]]);
const bytes = await writeProject(args.out, { manifest: man, blobs });
console.log(`${args.out}: ${(bytes / 1e6).toFixed(1)} MB — sea ${((100 * seaN) / (N * N)).toFixed(0)}% of the map, ${((100 * boxSea) / boxN).toFixed(0)}% of the box; the hills to ${hi.toFixed(1)} m`);
console.log(`plants (texels): tall ${JSON.stringify(tallPaint.counts)} · ground ${JSON.stringify(groundPaint.counts)}`);
