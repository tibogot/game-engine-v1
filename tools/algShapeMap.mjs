/**
 * SHAPE AN ALGERIA MAP — relief scale + a border that meets the plain.
 *
 * Outside the heightmap the engine draws flat ground at 0 m
 * (terrainLOD.js multiplies height by hmInBounds). A map cut from real
 * mountains ends in a wall where its edge meets that plain. This fades the
 * border down to exactly 0 over `--band` metres, the band's inner edge
 * wobbled by value noise so the map doesn't read as a square plinth, and
 * optionally scales the relief first.
 *
 * Reads `--in`, writes `--out`, so re-running with other numbers starts from
 * the same ground every time instead of compounding:
 *
 *   node tools/algShapeMap.mjs --in public/levels/alg-aures.v3proj.bak \
 *        --out public/levels/alg-aures.v3proj --scale 0.6 --band 170 --warp 50
 *
 * Only the `heightmap` blob changes. Prints the RTS metrics before and after.
 */
import { readProject, writeProject } from "./lib/v3proj.mjs";
import { measureRtsMap, printRtsMetrics } from "./lib/rtsMapMetrics.mjs";

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
if (!args.in || !args.out) throw new Error("usage: --in <file> --out <file> [--scale 1] [--band 170] [--warp 50] [--seed 7]");
const SCALE = +(args.scale ?? 1);
const BAND = +(args.band ?? 170);      // metres of ground over which the border falls to 0
const WARP = +(args.warp ?? 50);       // metres the band's inner edge wanders
const SEED = +(args.seed ?? 7);

const project = await readProject(args.in);
const { worldSize: W, heightmapSize: N, maxHeight: TOP } = project.manifest.terrain;
const blob = project.blobs.get("heightmap");
const norm = new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.length));
if (norm.length !== N * N) throw new Error(`heightmap is ${norm.length} texels, expected ${N}²`);

const metres = norm.map((v) => v * TOP);
printRtsMetrics(measureRtsMap(metres, N, W), `before  (${args.in})`);

// Value noise; Math.imul, or the hash drops its low bits (ref_js_value_noise_imul).
const hash = (x, y) => {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(SEED, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
};
const vnoise = (x, y) => {
  const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
};
const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

const cell = W / (N - 1);
for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
  const x = j * cell, z = i * cell;
  const d = Math.min(x, z, W - x, W - z);               // metres to the nearest edge
  const n = vnoise(x / 140, z / 140) * 0.7 + vnoise(x / 55 + 17, z / 55 + 31) * 0.3;
  // The wobble fades out toward the edge, so the border texel is always 0.
  const w = (n * 2 - 1) * WARP * Math.min(1, d / (BAND * 0.5));
  const t = smooth((d + w) / BAND);
  const k = i * N + j;
  metres[k] = Math.max(0, metres[k] * SCALE) * t;
}

const after = measureRtsMap(metres, N, W);
printRtsMetrics(after, `after  (scale ${SCALE}, band ${BAND} m, warp ${WARP} m)`);
let edgeMax = 0;
for (let k = 0; k < N; k++) edgeMax = Math.max(edgeMax, metres[k], metres[(N - 1) * N + k], metres[k * N], metres[k * N + N - 1]);
console.log(`border texels: max ${edgeMax.toFixed(3)} m (must be 0 to meet the plain)`);

const outNorm = new Float32Array(metres.length);
for (let k = 0; k < metres.length; k++) outNorm[k] = metres[k] / TOP;
project.blobs.set("heightmap", Buffer.from(outNorm.buffer));
await writeProject(args.out, project);
console.log(`\nwritten ${args.out}`);
