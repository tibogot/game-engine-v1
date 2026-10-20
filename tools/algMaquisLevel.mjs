/**
 * THE FLN TRAINING LEVEL — LE MAQUIS (2026-10-20, games/alg-rts/FLN_TRAINING_PLAN.md): a small djebel valley
 * for the FLN's lessons, built from scratch heights and the LOOK of a template level (Oued Abdi's by default:
 * its pale ochre ground photos, light, plant slots) — none of its content.
 *
 *   node tools/algMaquisLevel.mjs [--from <template.v3proj>] [--out <maquis.v3proj>]
 *
 * THE GROUND (games/alg-rts/maps/maquis.js gives the sites, the tracks, the knoll, the scrub, the box):
 *   heights  a valley floor at 20 m, quiet swells; the land rising gently toward the maquis camp (south) and
 *            the DJEBEL behind it; the ambush KNOLL over the road; low hills framing the box; the camp, the
 *            mechta and the post levelled
 *   paint    slot 0 the valley soil, 1 red earth on the slopes and the djebel, 6 the dirt road and the mule
 *            tracks (the template's photos)
 *   plants   the SCRUB the lessons hide in: holm oak, juniper and alfa painted thick (concealment); sparse
 *            elsewhere; cedars on the djebel's skyline
 */
import { readProject, writeProject } from "./lib/v3proj.mjs";
import { PLAY, LAYOUT, MAP } from "../games/alg-rts/maps/maquis.js";

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
args.from ??= "public/levels/alg-abdi.v3proj";
args.out ??= "public/levels/alg-maquis.v3proj";

const tpl = await readProject(args.from);
const man = tpl.manifest;
const { worldSize: W, heightmapSize: N, maxHeight: TOP } = man.terrain;
const cell = W / (N - 1);

// ── A small value noise (Math.imul: the plain JS multiply loses bits past 2^53) ──
const hash = (x, z, s) => { let h = Math.imul(x, 374761393) ^ Math.imul(z, 668265263) ^ Math.imul(s, 2147483647); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
const sm = (t) => t * t * (3 - 2 * t);
function noise(x, z, s = 1) {
  const xi = Math.floor(x), zi = Math.floor(z), fx = sm(x - xi), fz = sm(z - zi);
  const a = hash(xi, zi, s), b = hash(xi + 1, zi, s), c = hash(xi, zi + 1, s), d = hash(xi + 1, zi + 1, s);
  return (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fz;   // 0..1
}
const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const smooth01 = (t) => smoothstep(0, 1, t);

/** Distance from (x, z) to a polyline. */
function lineDist(pts, x, z) {
  let best = Infinity;
  for (let k = 0; k < pts.length - 1; k++) {
    const [ax, az] = pts[k], [bx, bz] = pts[k + 1], dx = bx - ax, dz = bz - az, L = dx * dx + dz * dz;
    const u = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L));
    best = Math.min(best, Math.hypot(x - (ax + dx * u), z - (az + dz * u)));
  }
  return best;
}
const ROAD = MAP.tracks.find((t) => t.kind === "piste").points;
const MULES = MAP.tracks.filter((t) => t.kind === "mule").map((t) => t.points);
const roadD = (x, z) => lineDist(ROAD, x, z);
const muleD = (x, z) => Math.min(...MULES.map((p) => lineDist(p, x, z)));

// ── Heights ────────────────────────────────────────────────────────────────
const BASE = 20;
const outside = (x, z) => Math.hypot(Math.max(PLAY.x0 - x, 0, x - PLAY.x1), Math.max(PLAY.z0 - z, 0, z - PLAY.z1));
const knoll = MAP.knoll;
const flats = LAYOUT.sites.map((s) => ({ x: s.x, z: s.z, r: s.r + (s.kind === "aln" ? 40 : 14) }));
/** The ground before the sites are levelled. */
function naturalAt(x, z) {
  let calm = 1;
  for (const f of flats) calm = Math.min(calm, smoothstep(f.r * 0.6, f.r, Math.hypot(x - f.x, z - f.z)));
  let h = BASE + ((noise(x / 60, z / 60, 3) - 0.5) * 2.0 + (noise(x / 22, z / 22, 7) - 0.5) * 0.6) * (0.3 + 0.7 * calm);
  // the land rising toward the maquis (south): the camp looks down on the valley
  h += 6 * smoothstep(30, 120, z + 8 * (noise(x / 40, 3.1, 9) - 0.5));
  // THE DJEBEL behind the camp: a steep ragged rise past it, on out of the box
  const dj = z - 138 + 10 * (noise(x / 30, 7.3, 11) - 0.5) + 4 * (noise(x / 9, 2.2, 12) - 0.5);
  if (dj > 0) h += 26 * smoothstep(0, 40, dj) + 30 * smoothstep(40, 140, dj) * (0.7 + 0.5 * noise(x / 70, z / 70, 13));
  // the ambush knoll: a dome, ragged at its foot
  const kd = Math.hypot(x - knoll.x, z - knoll.z) / knoll.r + 0.12 * (noise(x / 8, z / 8, 14) - 0.5);
  if (kd < 1.6) h += knoll.h * Math.exp(-kd * kd * 1.6);
  // the framing hills (not on the djebel's side)
  const o = outside(x, z);
  if (o > 0 && z < PLAY.z1) h += 40 * smoothstep(6, 180, o) * (0.6 + 0.4 * noise(x / 90, z / 90, 15)) + 6 * smoothstep(20, 100, o) * noise(x / 30, z / 30, 16);
  return h;
}
// the sites LEVELLED at their own height, a soft rim
const LEVEL = LAYOUT.sites.map((s) => ({ x: s.x, z: s.z, r: s.kind === "aln" ? s.r + 30 : s.r * 0.9, rim: 14, h: naturalAt(s.x, s.z) }));
function heightAt(x, z) {
  let h = naturalAt(x, z);
  for (const L of LEVEL) { const d = Math.hypot(x - L.x, z - L.z); if (d < L.r + L.rim) h = L.h + (h - L.h) * smoothstep(L.r, L.r + L.rim, d); }
  // the road: a shallow bed, its crown smoothed (the convoy's way)
  const rd = roadD(x, z);
  if (rd < 9) h -= 0.25 * (1 - smoothstep(2, 9, rd));
  return h;
}
const hgt = new Float32Array(N * N);
let hi = 0, lo = Infinity;
for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
  const v = heightAt(-W / 2 + j * cell, -W / 2 + i * cell);   // row 0 = north (−Z)
  hgt[i * N + j] = Math.max(0, v) / TOP;
  hi = Math.max(hi, v); lo = Math.min(lo, v);
}
if (hi > TOP) throw new Error(`the ground reaches ${hi.toFixed(1)} m, over the level's ${TOP} m`);
const slopeDeg = (x, z) => Math.atan(Math.hypot(heightAt(x + 1, z) - heightAt(x - 1, z), heightAt(x, z + 1) - heightAt(x, z - 1)) / 2) * 180 / Math.PI;

// ── Paint: the soil, red earth on the slopes and the djebel, the road and the tracks ──
const S = man.terrain.splatSize ?? man.splatRes;
const splat = Buffer.alloc(S * S * 8);
const put = (t, c, v) => { splat[(c >> 2) * S * S * 4 + t * 4 + (c & 3)] = v; };
for (let i = 0; i < S; i++) for (let j = 0; j < S; j++) {
  const x = -W / 2 + ((j + 0.5) * W) / S, z = -W / 2 + ((i + 0.5) * W) / S, t = i * S + j;
  const road = 1 - smoothstep(2.6, 4.6, roadD(x, z)), mule = 1 - smoothstep(1.0, 2.2, muleD(x, z) + 0.6 * (noise(x / 5, z / 5, 21) - 0.5));
  const trk = Math.max(road, mule * 0.85);
  const red = Math.min(1, smoothstep(8, 22, slopeDeg(x, z)) * 0.9 + smoothstep(0.6, 0.75, noise(x / 60, z / 60, 22)) * 0.4 + smoothstep(130, 160, z) * 0.6);
  const wT = trk, wR = (1 - trk) * red, wS = (1 - trk) * (1 - red), sum = wT + wR + wS || 1;
  put(t, 0, Math.round((255 * wS) / sum));
  put(t, 1, Math.round((255 * wR) / sum));
  put(t, 6, Math.round((255 * wT) / sum));
}

// ── Plants: the SCRUB (the hiding lessons) thick, the rest sparse ─────────
const patches = (x, z, scale, cover, s) => {
  const n = noise(x / scale, z / scale, s) * 0.7 + noise(x / (scale * 0.35), z / (scale * 0.35), s + 7) * 0.3;
  return smooth01((n - (1 - cover)) / 0.12);
};
/** In a scrub patch: 1 inside, a ragged edge. */
const scrubK = (x, z) => Math.max(0, ...MAP.scrub.map((c) => 1 - smoothstep(c.r * 0.7, c.r, Math.hypot(x - c.x, z - c.z) + 6 * (noise(x / 9, z / 9, 23) - 0.5))));
const clearK = (x, z) => {
  let k = Math.min(smooth01((roadD(x, z) - 5) / 3), smooth01((muleD(x, z) - 1.6) / 2));
  for (const c of MAP.scenery.keepClear) k = Math.min(k, smooth01((Math.hypot(x - c.x, z - c.z) - c.r) / 8));
  for (const s of LAYOUT.sites) k = Math.min(k, smooth01((Math.hypot(x - s.x, z - s.z) - s.r - 6) / 8));
  return k;
};
const djebelK = (x, z) => smoothstep(130, 150, z);
// TALL (the template's: 0 cedar, 1 holm oak, 2 date palm, 3 juniper)
const TALL = {
  0: (x, z) => 0.6 * djebelK(x, z) * smoothstep(150, 200, z) * patches(x, z, 40, 0.5, 30),
  // (the scrub CONTINUOUS — patchy, the lessons' hiding spot fell in a hole; juniper bushes, a FEW holm oaks as
  // landmarks: dense oaks read as a wood from the RTS camera, the ground gone)
  1: (x, z) => 0.3 * scrubK(x, z) * patches(x, z, 14, 0.18, 31) + 0.2 * patches(x, z, 40, 0.08, 32),
  3: (x, z) => 0.75 * scrubK(x, z) + 0.4 * djebelK(x, z) * patches(x, z, 24, 0.4, 34),
};
// GROUND (0 alfa, 7 asphodel)
const GROUND = {
  0: (x, z) => 0.85 * scrubK(x, z) + 0.45 * patches(x, z, 22, 0.3, 40),
  7: (x, z) => 0.25 * patches(x, z, 36, 0.25, 47),
};
function plantPaint(res, pages, fns) {
  const out = Buffer.alloc(res * res * 4 * pages), counts = {};
  for (let pz = 0; pz < res; pz++) {
    const z = ((pz + 0.5) / res) * W - W / 2;
    for (let px = 0; px < res; px++) {
      const x = ((px + 0.5) / res) * W - W / 2;
      if (outside(x, z) > 200) continue;
      const k = clearK(x, z);
      if (!k) continue;
      for (const [ch, fn] of Object.entries(fns)) {
        const v = Math.round(Math.max(0, Math.min(1, fn(x, z) * k)) * 255);
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

// ── Manifest: the template's look, its content gone ───────────────────────
man.trees = { ...man.trees, instances: [] };
man.props = { ...man.props, instances: [] };
man.decals = { ...man.decals, decals: [] };
man.lakes = { ...man.lakes, lakes: [] };
man.roads = { nodes: [], edges: [], nextNodeId: 1, selectedNodeId: null };
man.splines = Object.fromEntries(Object.keys(man.splines ?? {}).map((k) => [k, []]));
for (const k of ["waterfalls", "riversV2", "riverNetwork", "tunnels", "spawn"]) man[k] = null;
if (man.farTerrain) man.farTerrain = { ...man.farTerrain, enabled: false };
if (man.environment?.worldOcean) man.environment = { ...man.environment, worldOcean: { ...man.environment.worldOcean, enabled: false } };

const blobs = new Map([["heightmap", Buffer.from(hgt.buffer)], ["splat", splat], ["susukiDensity", tallPaint.out], ["foliagePaint", groundPaint.out]]);
const bytes = await writeProject(args.out, { manifest: man, blobs });
console.log(`${args.out}: ${(bytes / 1e6).toFixed(1)} MB — the ground ${lo.toFixed(1)}..${hi.toFixed(1)} m`);
console.log(`plants (texels): tall ${JSON.stringify(tallPaint.counts)} · ground ${JSON.stringify(groundPaint.counts)}`);
for (const s of LAYOUT.sites) console.log(`  ${s.name.padEnd(22)} ${heightAt(s.x, s.z).toFixed(1)} m`);
console.log(`  knoll top ${heightAt(knoll.x, knoll.z).toFixed(1)} m, the road below it ${heightAt(MAP.spots.ambush.x, -92).toFixed(1)} m`);
