/**
 * PAINT THE JUNGLE FLOOR WITH GRASS — nam-valley's biggest coverage win.
 *
 * MEASURED in the running game before writing a line of this: grass density
 * covers 60.3% of the map at mean 0.43, and 27% of the whole map is ground
 * that is GENTLE, WALKABLE, NOT WATER and has no grass paint at all. Broken
 * down by what is painted there:
 *
 *     Jungle floor   54.5%   ← the gap. Undergrowth belongs here.
 *     Beach sand     31.9%   ← correctly bare
 *     Dirt road      10.1%   ← correctly bare (the layer blocks grass)
 *     Cliff Rock      1.9%   ← correctly bare
 *     Dry ridge       1.3%
 *     Lowland floor   0.4%
 *
 * So this paints grass on the JUNGLE FLOOR layer only, and leaves the sand,
 * the roads and the rock alone. It does not need to think about slope: the
 * grass system rejects steep ground at runtime (`slopeEnabled` in the map's
 * grass section), so a painted cliff simply grows nothing.
 *
 * Nor does it need to think about the camp, the hamlet or the temple: those
 * clear their own ground at boot (app.clearVegetation), which stamps the
 * density down over whatever is painted here.
 *
 * Run:  node tools/namGrassPaint.mjs [--dry] [--target 0.6]
 */
import { readProject, writeProject } from "./lib/v3proj.mjs";

const FILE = "public/levels/nam-valley.v3proj";
const dry = process.argv.includes("--dry");
const targetArg = process.argv.indexOf("--target");
const TARGET = targetArg > 0 ? Number(process.argv[targetArg + 1]) : 0.6;

/** Layers that should carry undergrowth, by index in the map's paintLayers. */
const GRASS_LAYERS = new Set([0, 3]);     // Jungle floor, Lowland floor
/** How much the painted density varies, so a filled area is not a flat field. */
const VARY = 0.18;

/** Value noise on a wrapping lattice — the same hash the kit's textures use. */
function hash2(x, y) {
  let n = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}
function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

const p = await readProject(FILE);
const density = p.blobs.get("grassDensity");
const splat = p.blobs.get("splat");
if (!density || !splat) throw new Error("map has no grassDensity/splat blob");

const gRes = Math.round(Math.sqrt(density.length / 4));
const sRes = Math.round(Math.sqrt(splat.length / 8));          // data0 + data1
const half = splat.length / 2;
const d0 = splat.subarray(0, half), d1 = splat.subarray(half);
const step = sRes / gRes;

/** The layer with the most weight in the splat block under one density texel. */
function layerAt(gx, gy) {
  const w = new Array(8).fill(0);
  const x0 = Math.floor(gx * step), y0 = Math.floor(gy * step);
  const n = Math.max(1, Math.floor(step));
  for (let y = y0; y < y0 + n; y++) {
    for (let x = x0; x < x0 + n; x++) {
      const i = (y * sRes + x) * 4;
      for (let k = 0; k < 4; k++) { w[k] += d0[i + k]; w[4 + k] += d1[i + k]; }
    }
  }
  let best = -1, bv = 0;
  for (let k = 0; k < 8; k++) if (w[k] > bv) { bv = w[k]; best = k; }
  return bv > n * n * 12 ? best : -1;
}

let before = 0, after = 0, painted = 0, total = gRes * gRes;
const out = Buffer.from(density);
for (let gy = 0; gy < gRes; gy++) {
  for (let gx = 0; gx < gRes; gx++) {
    const i = (gy * gRes + gx) * 4;
    const cur = density[i] / 255;
    if (cur > 0.02) before++;
    if (cur < TARGET && GRASS_LAYERS.has(layerAt(gx, gy))) {
      // Two octaves of noise, so filled ground reads as patches of undergrowth
      // rather than as a lawn someone rolled over the jungle.
      const n = vnoise(gx / 26, gy / 26) * 0.65 + vnoise(gx / 7, gy / 7) * 0.35;
      const v = Math.max(cur, Math.min(1, TARGET * (1 - VARY) + n * VARY * 2 * TARGET));
      const b = Math.round(v * 255);
      out[i] = b; out[i + 1] = b; out[i + 2] = b; out[i + 3] = b;   // all 4: the engine's convention
      painted++;
    }
    if (out[i] / 255 > 0.02) after++;
  }
}

const pct = (n) => `${(100 * n / total).toFixed(1)}%`;
console.log(`grass density ${gRes}² over splat ${sRes}²`);
console.log(`  covered before  ${pct(before)}`);
console.log(`  painted now     ${pct(painted)}  (jungle/lowland floor that had none)`);
console.log(`  covered after   ${pct(after)}`);
if (!dry && painted) {
  p.blobs.set("grassDensity", out);
  await writeProject(FILE, p);
  console.log(`\nwrote ${FILE}`);
}
