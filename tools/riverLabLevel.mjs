/**
 * RIVER LAB LEVEL — a 512 m test bench for River v3 (the river network), opened
 * in the editor with  /v3/editor.html?project=/levels/river-lab.v3proj
 *
 * Built to exercise every case the network has to get right, with nothing else
 * on screen (no grass, no props, flat painted ground):
 *
 *   - a north–south VALLEY whose top third is STEEP (12 %: where step-pools
 *     belong) and whose lowland is gentle (1.5 %)
 *   - a SIDE VALLEY from the east joining it: a TRIBUTARY junction
 *   - a FLOODPLAIN in the south where the river SPLITS into two arms
 *
 * The network is pre-drawn as River v3 reaches with AUTO levels, so the solver
 * places the water; redraw it freely in the editor.
 *
 *   node tools/riverLabLevel.mjs [--from public/levels/rock-lab.v3proj]
 *        [--out public/levels/river-lab.v3proj] [--seed 11]
 */
import { readProject, writeProject } from "./lib/v3proj.mjs";

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
const FROM = args.from ?? "public/levels/rock-lab.v3proj";
const OUT = args.out ?? "public/levels/river-lab.v3proj";
const SEED = +(args.seed ?? 11);

// ── Size: the rock lab's (its paint layers and far terrain fit it) ─────────
const W = 512, N = 512, TOP = 140, S = 1024, G = 512;
const HALF = W / 2, CELL = W / (N - 1);

// ── Noise (Math.imul hashing — see ref_js_value_noise_imul) ───────────────
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
const fbm = (x, y, s = 1) => (vnoise(x, y, s) * 0.55 + vnoise(x * 2.03, y * 2.03, s + 1) * 0.3 + vnoise(x * 4.1, y * 4.1, s + 2) * 0.15) * 2 - 1;
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// ── The land ──────────────────────────────────────────────────────────────
/** Main valley centreline (meanders a little). North is −z. */
const xMain = (z) => 30 * Math.sin(z / 85) + 12 * Math.sin(z / 37 + 1);
/** Main valley floor: 12 % in the north third, 1.5 % below z = −110. */
const floorMain = (z) => (z >= -110 ? 10 + (250 - z) * 0.015 : 10 + 360 * 0.015 + (-110 - z) * 0.12);
/** Half width of the flat-ish floor: narrow up top, a floodplain down south. */
const floorHalf = (z) => 18 + 50 * smooth(90, 210, z);

const JZ = 20, JX = xMain(JZ);                 // the tributary's junction
const KZ = 150, KX = xMain(KZ);                // the split
// Side valley: from the east hills down to the junction, gently curved.
const TRIB = [];
for (let i = 0; i <= 40; i++) {
  const t = i / 40;
  TRIB.push({ x: 235 + (JX - 235) * t, z: -150 + (JZ + 150) * t + 30 * Math.sin(t * Math.PI), t });
}
const floorTrib = (t) => 36 + (floorMain(JZ) + 0.6 - 36) * t;

const hills = (x, z) => 58 + 16 * fbm(x / 130, z / 130, 3) + 7 * fbm(x / 45, z / 45, 4);

function heightAt(x, z) {
  const hl = hills(x, z);
  // Main valley.
  const dM = Math.abs(x - xMain(z));
  const fM = floorMain(z) + 0.5 * fbm(x / 22, z / 22, 5);
  const main = fM + (hl - fM) * smooth(floorHalf(z), floorHalf(z) + 95, dM);
  // Side valley (nearest point on its centreline).
  let best = Infinity, bt = 0;
  for (let i = 0; i < TRIB.length - 1; i++) {
    const a = TRIB[i], b = TRIB[i + 1];
    const ex = b.x - a.x, ez = b.z - a.z, L2 = ex * ex + ez * ez;
    const t = Math.max(0, Math.min(1, ((x - a.x) * ex + (z - a.z) * ez) / L2));
    const d = Math.hypot(x - a.x - ex * t, z - a.z - ez * t);
    if (d < best) { best = d; bt = a.t + (b.t - a.t) * t; }
  }
  const fT = floorTrib(bt) + 0.5 * fbm(x / 22, z / 22, 6);
  const trib = fT + (hl - fT) * smooth(12, 80, best);
  return Math.min(main, trib);
}

const H = new Float32Array(N * N);
for (let j = 0; j < N; j++) {
  const z = -HALF + j * CELL;                  // row 0 = north (−z)
  for (let i = 0; i < N; i++) H[j * N + i] = heightAt(-HALF + i * CELL, z);
}
const slopeAt = (x, z) => {
  const e = 1;
  const gx = (heightAt(x + e, z) - heightAt(x - e, z)) / (2 * e);
  const gz = (heightAt(x, z + e) - heightAt(x, z - e)) / (2 * e);
  return (Math.atan(Math.hypot(gx, gz)) * 180) / Math.PI;
};

// ── Paint: meadow, rock on the steep (the rock lab's own layers 0 and 1) ───
const splat = Buffer.alloc(S * S * 8);
{
  const TX = W / S;
  for (let j = 0; j < S; j++) {
    const z = -HALF + (j + 0.5) * TX;
    for (let i = 0; i < S; i++) {
      const x = -HALF + (i + 0.5) * TX;
      const rock = smooth(30, 40, slopeAt(x, z) + 4 * fbm(x / 14, z / 14, 7));
      const p = (j * S + i) * 4;
      splat[p] = Math.round((1 - rock) * 255);
      splat[p + 1] = Math.round(rock * 255);
    }
  }
}
// No grass: the river alone on screen.
const grass = Buffer.alloc(G * G * 4);
const bladeH = Buffer.alloc(G * G * 4, 128);

// ── The network: River v3 reaches, AUTO levels ────────────────────────────
const nd = (x, z, w, d = 1.5, b = 6) => ({ x: +x.toFixed(2), z: +z.toFixed(2), y: null, width: w, depth: d, bank: b });
const along = (z0, z1, step, w0, w1, d) => {
  const out = [];
  const n = Math.max(1, Math.round(Math.abs(z1 - z0) / step));
  for (let k = 0; k <= n; k++) {
    const z = z0 + (z1 - z0) * (k / n), t = k / n;
    out.push(nd(xMain(z), z, +(w0 + (w1 - w0) * t).toFixed(2), d));
  }
  return out;
};
const J = { id: 101, x: +JX.toFixed(2), z: JZ, y: null };
const K = { id: 102, x: +KX.toFixed(2), z: KZ, y: null };
const tribNodes = [0, 8, 16, 24, 32, 40].map((i) => nd(TRIB[i].x, TRIB[i].z, 5, 1.2, 5));
tribNodes[tribNodes.length - 1] = nd(J.x, J.z, 5, 1.2, 5);
const riverNetwork = {
  version: 1,
  junctions: [J, K],
  reaches: [
    { id: 1, from: null, to: J.id, q: null, nodes: along(-235, JZ, 32, 6, 8, 1.4) },
    { id: 2, from: null, to: J.id, q: null, nodes: tribNodes },
    { id: 3, from: J.id, to: K.id, q: null, nodes: along(JZ, KZ, 32, 10, 10, 1.8) },
    { id: 4, from: K.id, to: null, q: null, nodes: [nd(K.x, K.z, 7), nd(K.x - 30, 195, 7), nd(K.x - 65, 240, 7)] },
    { id: 5, from: K.id, to: null, q: null, nodes: [nd(K.x, K.z, 6), nd(K.x + 28, 198, 6), nd(K.x + 55, 242, 6)] },
  ],
};

// ── Manifest: the rock lab's look, none of its content ────────────────────
const tpl = await readProject(FROM);
const man = tpl.manifest;
man.terrain = { worldSize: W, heightmapSize: N, splatSize: S, maxHeight: TOP };
man.splatRes = S;
man.trees = { ...man.trees, instances: [] };
man.props = { types: [], instances: [], slots: [] };
man.decals = { ...man.decals, decals: [] };
man.lakes = { ...man.lakes, lakes: [] };
for (const k of ["waterfalls", "riversV2", "tunnels", "spawn"]) man[k] = null;
man.riverNetwork = riverNetwork;
// Neutral colours to judge water against: the rock lab's golden meadow read as
// saturated orange and its rock nearly white (seen in the editor, 2026-10-04).
const recolour = (slot, name, c) => {
  const L = man.paintLayers?.[slot];
  if (L?.procedural) { L.name = name; Object.assign(L.procedural, c); }
};
recolour(0, "Meadow", { dark: "#4c6632", mid: "#5a7539", light: "#698443", accent: "#647e3f", patches: 0.35, feature: 0.1, detail: 0.04, bump: 0.1, ao: 0.2 });
recolour(1, "Rock", { dark: "#66635d", mid: "#74716a", light: "#817e76", accent: "#817e76" });
// rockShade lit the slope like the rock-kit props, which read near-white here.
if (man.paintLayers?.[1]) man.paintLayers[1].rockShade = 0;

const norm = H.map((v) => Math.max(0, Math.min(1, v / TOP)));
const blobs = new Map([
  ["heightmap", Buffer.from(norm.buffer)],
  ["splat", splat],
  ["grassDensity", grass],
  ["grassHeight", bladeH],
]);
// Keep the rock lab's far mountains round the edge, for context.
if (tpl.blobs.has("farHeight")) blobs.set("farHeight", tpl.blobs.get("farHeight"));
else if (man.farTerrain) man.farTerrain = { ...man.farTerrain, enabled: false };

const bytes = await writeProject(OUT, { manifest: man, blobs });
let lo = Infinity, hi = -Infinity;
for (const v of H) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
console.log(`${OUT}: ${(bytes / 1e6).toFixed(1)} MB · heights ${lo.toFixed(1)}–${hi.toFixed(1)} m · `
  + `junction J (${J.x}, ${J.z}) floor ${floorMain(JZ).toFixed(1)} m · split K (${K.x}, ${K.z}) · `
  + `${riverNetwork.reaches.length} reaches`);
