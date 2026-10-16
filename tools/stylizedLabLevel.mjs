/**
 * STYLIZED LAB LEVEL — a green meadow to judge Genshin-style cliffs and rocks
 * on (games/stylized-lab/): 512 m of gently rolling grass, a raised BANK to
 * the north for cliffs to sit against, a pale dirt path, green Revo grass, far
 * hills past the edge. No props: the lab places its own candidates.
 *
 *   node tools/stylizedLabLevel.mjs [--from public/levels/alg-aures.v3proj]
 *        [--out public/levels/stylized-lab.v3proj]
 */
import { readProject, writeProject } from "./lib/v3proj.mjs";

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
const FROM = args.from ?? "public/levels/alg-aures.v3proj";
const OUT = args.out ?? "public/levels/stylized-lab.v3proj";

const W = 512, N = 512, TOP = 140, S = 1024, G = 512;
const HALF = W / 2, CELL = W / (N - 1);
const SEED = 21;
const hash = (x, y, s) => {
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
const fbm = (x, y, s) => (vnoise(x, y, s) * 0.55 + vnoise(x * 2.03, y * 2.03, s + 1) * 0.3 + vnoise(x * 4.1, y * 4.1, s + 2) * 0.15) * 2 - 1;
const smooth = (e0, e1, x) => { const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;

// Ground (2026-10-09, third pass — you: "not flat terraces; Zelda and Genshin
// use a nice open-world MOUNTAIN with the cliffs ON it"): a natural massif to
// the north — ridges, spurs, valleys, flanks steep enough (35-60°) in places
// for rock to come out — and a rocky KNOLL in the meadow. Soft ridged noise
// (no saw-tooth crests). The lab places its outcrops wherever the ground is
// steep (games/stylized-lab).
const edgeFade = (x, z) => smooth(0, 40, HALF - Math.max(Math.abs(x), Math.abs(z)));
const ridged = (x, z, s) => {
  let sum = 0, amp = 0.55, f = 1, norm = 0;
  for (let o = 0; o < 4; o++) {
    const n = fbm(x * f, z * f, s + o * 5);
    const r = 1 - Math.sqrt(n * n + 0.015);                     // soft crest
    sum += r * r * amp; norm += amp; amp *= 0.5; f *= 2.1;
  }
  return sum / norm;
};
const peak = (x, z, cx, cz, rx, rz) => { const e = Math.hypot((x - cx) / rx, (z - cz) / rz); return smooth(1, 0, e); };
// Fifth pass (2026-10-09, the Genshin cliff ref): GREEN slopes (<= ~25°) with
// STEPS in them — the steepness lives only in the steps, and the cliffs are
// walls of blocks on the steps with grass carrying on above. The massif is
// gentler; three winding step bands (10-16 m, sharp) cross its flanks; the
// HERO HILL in the meadow (east of the path) rises in two stepped tiers like
// the ref.
const massif = (x, z) => {
  const dome = Math.pow(peak(x, z, -20, -190, 300, 180), 1.4);
  const second = Math.pow(peak(x, z, 160, -110, 140, 120), 1.4);
  const r = ridged(x / 150, z / 150, SEED + 30);
  const d = Math.max(dome, second * 0.8);
  // STEPS: winding lines where a slow noise field crosses zero (value x ~90
  // is roughly metres from the line), 4-6 m wide: ~65-75°
  const step = (sd, hgt) => hgt * smooth(-2.5, 2.5, fbm(x / 140, z / 140, SEED + sd) * 90);
  const bands = (step(40, 16) + step(41, 12) + step(42, 10)) * smooth(0.15, 0.4, d);
  return 52 * d * (0.6 + 0.45 * r) + 5 * d * fbm(x / 35, z / 35, SEED + 31) + bands;
};
const HERO = { x: 95, z: 120 };
const knoll = (x, z) => {
  // the hero hill: rises toward +x in two tiers (8 + 8 m), then a gentle crown
  const w = 6 * Math.sin(z / 23) + 4 * fbm(x / 30, z / 30, SEED + 33);
  const d = x - HERO.x + w;
  const mask = smooth(95, 55, Math.abs(z - HERO.z)) * smooth(230, 200, x);
  return mask * (8 * smooth(-1.8, 1.8, d) + 8 * smooth(-1.8, 1.8, d - 9) + 0.12 * Math.max(0, d - 10) + 2 * fbm(x / 25, z / 25, SEED + 34) * smooth(0, 20, d));
};
const groundH = (x, z) => 12 + 2.2 * fbm(x / 70, z / 70, SEED) + (massif(x, z) + knoll(x, z)) * edgeFade(x, z);
const H = new Float32Array(N * N);
for (let iz = 0; iz < N; iz++) for (let ix = 0; ix < N; ix++) H[iz * N + ix] = groundH(-HALF + ix * CELL, -HALF + iz * CELL);
const hAt = (x, z) => {
  const fx = Math.max(0, Math.min(N - 1.0001, (x + HALF) / CELL)), fz = Math.max(0, Math.min(N - 1.0001, (z + HALF) / CELL));
  const x0 = fx | 0, z0 = fz | 0, tx = fx - x0, tz = fz - z0;
  return lerp(lerp(H[z0 * N + x0], H[z0 * N + x0 + 1], tx), lerp(H[(z0 + 1) * N + x0], H[(z0 + 1) * N + x0 + 1], tx), tz);
};
const slopeAt = (x, z) => (Math.atan(Math.hypot((hAt(x + 1, z) - hAt(x - 1, z)) / 2, (hAt(x, z + 1) - hAt(x, z - 1)) / 2)) * 180) / Math.PI;

// A path winding through the meadow in front of the test row.
const pathX = (z) => 18 * Math.sin(z / 45) - 10;
const pathDist = (x, z) => Math.abs(x - pathX(z)) * 0.9 + Math.max(0, z - 200) + Math.max(0, -30 - z);

// Paint: 0 meadow (flat, the grass colour), 1 rock (steep), 2 path, 3-6 meadow.
const proc = (name, p, extra = {}) => ({
  name, albedo: null, normal: null, rough: null, ao: null,
  uvScale: Math.min(200, Math.max(1, Math.round(W / p.tileM))),
  normalStr: 1, aoStr: 0.8, roughStr: 1, triplanar: false, tint: "#ffffff", uvRotation: 0, contourAlign: 0, rockShade: 0,
  procedural: { seed: 1, size: 0.5, accentAmt: 0, ...p }, blocksGrass: false, blocksTrees: false,
  auto: { enabled: false, heightMin: 0, heightMax: 500, slopeMin: 0, slopeMax: 90, blend: 15, strength: 1 }, ...extra,
});
const meadow = { preset: "genshinGrass", pattern: "painted", dark: "#4f8a2c", mid: "#4f8a2c", light: "#4f8a2c", accent: "#4f8a2c", scale: 8, patches: 0, feature: 0, detail: 0, rough: 0.95, bump: 0, ao: 0, tileM: 60 };
const TEXL = (id, m) => ({ name: `${id}_${m}_1k.jpg`, url: `/textures/ground/${id}/${id}_${m}_1k.jpg` });
const photoLayer = (name, id, extra = {}) => ({
  name, albedo: TEXL(id, "diff"), normal: TEXL(id, "nor_gl"), rough: TEXL(id, "rough"), ao: TEXL(id, "ao"),
  uvScale: 64, normalStr: 1, aoStr: 0.8, roughStr: 1, triplanar: false, tint: "#ffffff", uvRotation: 0, contourAlign: 0, rockShade: 0,
  procedural: null, blocksGrass: false, blocksTrees: false,
  auto: { enabled: false, heightMin: 0, heightMax: 500, slopeMin: 0, slopeMax: 90, blend: 15, strength: 1 }, ...extra,
});
const PAINT = [
  proc("Meadow", meadow),
  // STEEP ground: the SAME stone as the cliff blocks (you: "that's how they
  // blend") — the layered-rock photo baked into the blocks' blue-grey
  // (tools/stylizedCliffTexture.py), triplanar, ~6 m a tile like the blocks
  // (the texture is DE-TILED: 2k spanning four photo tiles, hex-remapped —
  // 24 m a tile at the blocks' texel density, no grid on a far slope)
  photoLayer("Rock", "cliff_stylized", { uvScale: Math.round(W / 24), triplanar: true, normalStr: 1.2, aoStr: 0.4, tint: "#f0f0f2" }),   // tint MEASURED: rock-pixel medians in the same view, blocks 115/126/147 vs the terrain's
  proc("Path", { preset: "genshinPath", pattern: "path", dark: "#d8c48f", mid: "#e2cf9b", light: "#eadaa8", accent: "#b9b8ae", scale: 18, patches: 0.3, feature: 0.25, size: 0.6, detail: 0.03, accentAmt: 0.3, rough: 0.95, bump: 0.3, ao: 0.2, tileM: 18 }),
  proc("Spare A", meadow), proc("Spare B", meadow), proc("Spare C", meadow), proc("Spare D", meadow),
];
const TX = W / S, splat = Buffer.alloc(S * S * 8);
for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
  const x = -HALF + (i + 0.5) * TX, z = -HALF + (j + 0.5) * TX;
  const rock = smooth(42, 52, slopeAt(x, z));
  const path = (1 - smooth(1.6, 3.2, pathDist(x, z) + 0.6 * fbm(x / 3, z / 3, SEED + 9))) * (1 - rock);
  const meadowW = Math.max(0, 1 - rock - path);
  const p = (j * S + i) * 4;
  splat[p] = Math.round(meadowW * 255); splat[p + 1] = Math.round(rock * 255); splat[p + 2] = Math.round(path * 255);
}
const grass = Buffer.alloc(G * G * 4), bladeH = Buffer.alloc(G * G * 4, 128);
for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) {
  const x = -HALF + (i + 0.5) * (W / G), z = -HALF + (j + 0.5) * (W / G);
  const v = (1 - smooth(38, 46, slopeAt(x, z))) * smooth(2.4, 4, pathDist(x, z));
  const k = (j * G + i) * 4;
  grass[k] = grass[k + 1] = grass[k + 2] = grass[k + 3] = Math.round(v * 255);
  const tall = 1 + 0.25 * fbm(x / 11, z / 11, SEED + 3);
  bladeH[k] = bladeH[k + 1] = bladeH[k + 2] = bladeH[k + 3] = Math.round(128 * tall);
}

// Far hills past the edge (the engine's far terrain), green and soft.
const FAR = { n: 384, extent: 2600 };
const farH = new Float32Array(FAR.n * FAR.n);
{
  const fc = (2 * FAR.extent) / (FAR.n - 1);
  for (let i = 0; i < FAR.n; i++) for (let j = 0; j < FAR.n; j++) {
    const x = -FAR.extent + j * fc, z = -FAR.extent + i * fc;
    const out = Math.hypot(Math.max(Math.abs(x) - HALF, 0), Math.max(Math.abs(z) - HALF, 0));
    const r = 1 - Math.abs(fbm(x / 600, z / 600, SEED + 20));
    farH[i * FAR.n + j] = 12 + (25 + 150 * smooth(200, 2000, out)) * (0.4 * (0.5 + 0.5 * fbm(x / 900, z / 900, SEED + 21)) + 0.7 * r * r);
  }
}

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
if (man.environment?.worldOcean) man.environment.worldOcean = { ...man.environment.worldOcean, enabled: false };
if (man.environment?.look) man.environment.look.skyMode = "skypro";
man.paintLayers = PAINT;
man.paintBlend = { ...man.paintBlend, macroStrength: 0 };
man.grass = { ...man.grass, system: "revo" };
man.revoGrass = {
  ...man.revoGrass,
  baseColor: "#3e7a26", tipColor: "#a6d05a", colorMix: 0.7, colorVariation: 0.35,
  viewNormal: true, farShading: false,
  bladeHeight: 0.6, bladeWidth: 0.12, clumpStrength: 0.6, clumpScale: 2.6,
};
man.props = { types: [], instances: [], slots: [] };
man.farTerrain = {
  enabled: true, n: FAR.n, extent: FAR.extent, stand: 1, standStart: 100, standEnd: 1500, blend: 200,
  rule: { flatSlot: 0, highSlot: 1, screeSlot: 0, cliffSlot: 1, screeLo: 14, screeHi: 24, cliffLo: 26, cliffHi: 36, highLo: 400, highHi: 500 },
};
const norm = H.map((v) => Math.max(0, Math.min(1, v / TOP)));
const bytes = await writeProject(OUT, {
  manifest: man,
  blobs: new Map([["heightmap", Buffer.from(norm.buffer)], ["splat", splat], ["grassDensity", grass], ["grassHeight", bladeH], ["farHeight", Buffer.from(farH.buffer)]]),
});
const bins = [0, 0, 0, 0, 0, 0];
for (let z = -250; z < 250; z += 4) for (let x = -250; x < 250; x += 4) { const sl = slopeAt(x, z); bins[Math.min(5, Math.floor(sl / 10))]++; }
console.log('slope histogram (0-10,10-20,...,50+ deg, % of map):', bins.map((b) => (b / 156.25).toFixed(1)).join(' '));
let steep = 0, top = 0;
for (let i = 0; i < N * N; i++) top = Math.max(top, H[i]);
for (let z = -250; z < 250; z += 4) for (let x = -250; x < 250; x += 4) if (slopeAt(x, z) > 35) steep++;
console.log(`${OUT}: ${(bytes / 1e6).toFixed(1)} MB; peak ${top.toFixed(0)} m; ${(steep * 16 / 1e4).toFixed(1)} ha steeper than 35°`);
