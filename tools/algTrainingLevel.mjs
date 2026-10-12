/**
 * THE TRAINING LEVEL for the Algeria RTS (2026-10-09): a small green plain for the tutorial,
 * built from scratch heights and the LOOK of a template level (sky, light, grass and plant
 * settings, paint layers) — none of its content (decals, lakes, trees, props, painted plants,
 * far terrain).
 *
 *   node tools/algTrainingLevel.mjs --from public/levels/alg-aures.v3proj --out public/levels/alg-training.v3proj [--force 1]
 *
 * THE GROUND (games/alg-rts/maps/training.js gives the sites, the track, the box, the knoll):
 *   heights  a plain at 20 m with gentle swells (±1.5 m), flattened round the post and the
 *            hamlet; the KNOLL (the high-ground lesson); hills rising outside the box to frame it
 *   paint    slot 0 = GREEN GRASS (Grass005, olive tint), slot 1 = DUSTY EARTH (dirt_aerial_02:
 *            bare patches, the framing hills, the post's worn yard), slot 6 = the DIRT TRACK
 *            (painted along the map's track). The other slots keep the template's photos.
 */
import fs from "node:fs";
import { readProject, writeProject } from "./lib/v3proj.mjs";
import { PLAY, LAYOUT, MAP } from "../games/alg-rts/maps/training.js";

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
if (!args.from || !args.out) throw new Error("usage: --from <template.v3proj> --out <new.v3proj> [--force 1]");
if (fs.existsSync(args.out) && args.force !== "1") throw new Error(`${args.out} exists — --force 1 to rebuild it`);

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

// ── Heights ────────────────────────────────────────────────────────────────
const BASE = 20;
const site = (k) => LAYOUT.sites.find((s) => s.kind === k);
const flats = LAYOUT.sites.filter((s) => s.kind === "french" || s.kind === "hamlet").map((s) => ({ x: s.x, z: s.z, r: s.r + 18 }));
const knoll = MAP.knoll;
/** Distance outside the play box (0 inside). */
const outside = (x, z) => Math.hypot(Math.max(PLAY.x0 - x, 0, x - PLAY.x1), Math.max(PLAY.z0 - z, 0, z - PLAY.z1));
function heightAt(x, z) {
  // the swells: two octaves, quieter on the flats
  let calm = 1;
  for (const f of flats) calm = Math.min(calm, smoothstep(f.r * 0.6, f.r, Math.hypot(x - f.x, z - f.z)));
  const swell = ((noise(x / 70, z / 70, 3) - 0.5) * 2.4 + (noise(x / 28, z / 28, 7) - 0.5) * 0.8) * (0.25 + 0.75 * calm);
  // the knoll: a soft dome
  const kd = Math.hypot(x - knoll.x, z - knoll.z) / knoll.r;
  const dome = kd < 1.6 ? knoll.h * Math.exp(-(kd * kd) * 1.6) : 0;
  // the framing hills, rising from the box's edge
  const o = outside(x, z);
  const hills = o > 0 ? 48 * smoothstep(6, 200, o) * (0.6 + 0.4 * noise(x / 90, z / 90, 11)) + 8 * smoothstep(20, 120, o) * noise(x / 35, z / 35, 13) : 0;
  return BASE + swell + dome + hills;
}
const h = new Float32Array(N * N);
let hi = 0;
for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
  const x = -W / 2 + j * cell, z = -W / 2 + i * cell;   // row 0 = north (−Z)
  const v = heightAt(x, z);
  h[i * N + j] = v / TOP;
  if (v > hi) hi = v;
}
if (hi > TOP) throw new Error(`the hills reach ${hi.toFixed(1)} m, over the level's ${TOP} m`);

// ── Paint: grass, bare rock, the track ─────────────────────────────────────
const S = man.terrain.splatSize ?? man.splatRes;
const splat = Buffer.alloc(S * S * 8);   // two planar RGBA planes: layer c in plane c >> 2, channel c & 3
const put = (t, c, v) => { splat[(c >> 2) * S * S * 4 + t * 4 + (c & 3)] = v; };
const track = MAP.tracks[0].points;
/** Distance from (x, z) to the track's polyline. */
function trackDist(x, z) {
  let best = Infinity;
  for (let k = 0; k < track.length - 1; k++) {
    const [ax, az] = track[k], [bx, bz] = track[k + 1], dx = bx - ax, dz = bz - az, L = dx * dx + dz * dz;
    const u = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L));
    best = Math.min(best, Math.hypot(x - (ax + dx * u), z - (az + dz * u)));
  }
  return best;
}
const post = site("french");
for (let i = 0; i < S; i++) for (let j = 0; j < S; j++) {
  const x = -W / 2 + ((j + 0.5) * W) / S, z = -W / 2 + ((i + 0.5) * W) / S, t = i * S + j;
  const ht = heightAt(x, z);
  // bare ground: patches on the plain, the hills' flanks, the post's worn yard
  let rock = smoothstep(0.64, 0.8, noise(x / 40, z / 40, 21)) * 0.7;   // fewer, softer than a rocky plain
  rock = Math.max(rock, smoothstep(BASE + 6, BASE + 18, ht));
  rock = Math.max(rock, 1 - smoothstep(post.r * 0.7, post.r + 12, Math.hypot(x - post.x, z - post.z)));
  const trk = 1 - smoothstep(3, 5.5, trackDist(x, z));
  const wTrack = trk, wRock = (1 - trk) * rock, wGrass = (1 - trk) * (1 - rock);
  const sum = wTrack + wRock + wGrass || 1;
  put(t, 0, Math.round((255 * wGrass) / sum));
  put(t, 1, Math.round((255 * wRock) / sum));
  put(t, 6, Math.round((255 * wTrack) / sum));
}

// ── Manifest: the template's look, its content gone, the new photos ────────
man.trees = { ...man.trees, instances: [] };
man.props = { ...man.props, instances: [] };
man.decals = { ...man.decals, decals: [] };
man.lakes = { ...man.lakes, lakes: [] };
man.roads = { nodes: [], edges: [], nextNodeId: 1, selectedNodeId: null };
man.splines = Object.fromEntries(Object.keys(man.splines ?? {}).map((k) => [k, []]));
for (const k of ["waterfalls", "riversV2", "riverNetwork", "tunnels", "spawn"]) man[k] = null;
if (man.farTerrain) man.farTerrain = { ...man.farTerrain, enabled: false };
if (man.environment?.worldOcean) man.environment = { ...man.environment, worldOcean: { ...man.environment.worldOcean, enabled: false } };
const photo = (dir, file) => ({ name: file, url: `${dir}/${file}` });
const L0 = man.paintLayers[0], L1 = man.paintLayers[1];
// The camp's OWN look (2026-10-12, not the Aurès): a green spring plain — smooth grass with no
// stones in the photo, soft normals (the aerial grass-rock photo at normal 1.6 read rocky and
// bumpy), dusty earth for the bare patches and the post's yard. Tiles in metres: uvScale = W / m.
const G = "/textures/pbr_materials/Grass005", D = "/textures/ground/dirt_aerial_02";
man.paintLayers[0] = { ...L0, name: "Training grass",
  albedo: photo(G, "Grass005_1K-JPG_Color.jpg"),
  normal: photo(G, "Grass005_1K-JPG_NormalGL.jpg"),
  rough: photo(G, "Grass005_1K-JPG_Roughness.jpg"),
  ao: photo(G, "Grass005_1K-JPG_AmbientOcclusion.jpg"), uvScale: W / 4, normalStr: 0.6, aoStr: 0.3, tint: "#ccc49c" };
man.paintLayers[1] = { ...L1, name: "Bare ground",
  albedo: photo(D, "dirt_aerial_02_diff_1k.jpg"),
  normal: photo(D, "dirt_aerial_02_nor_gl_1k.jpg"),
  rough: photo(D, "dirt_aerial_02_rough_1k.jpg"),
  ao: photo(D, "dirt_aerial_02_ao_1k.jpg"), uvScale: W / 20, normalStr: 0.6, aoStr: 0.3, tint: "#e8dcc4" };

const blobs = new Map([["heightmap", Buffer.from(h.buffer)], ["splat", splat]]);
const bytes = await writeProject(args.out, { manifest: man, blobs });
console.log(`${args.out}: ${(bytes / 1e6).toFixed(1)} MB — plain ${BASE} m, the knoll +${knoll.h} m, the hills to ${hi.toFixed(1)} m`);
