/**
 * THE SUGAR PALMS — give nam-valley its fan palms, and take the susuki out.
 *
 * Your call, 2026-09-24: susuki does not read Vietnam. It is *Miscanthus
 * sinensis*, the silver plume grass of Japanese autumn hillsides, and it was
 * on this map because it was the first plant the tall-plant field ever held.
 * Dropping it frees the one thing the fan palm needed — a slot.
 *
 * The fan palm (*thốt nốt*, Borassus) is the right plant to take it: palmate
 * rather than pinnate, so it reads as a hard spiked star where the coconut
 * reads as a soft plume, and it is the tree that stands over every paddy on
 * the Cambodian border. It is the Apocalypse Now skyline.
 *
 * TWO THINGS HAVE TO CHANGE TOGETHER, which is why this is one script:
 *
 *   1. THE SPECIES in slot 0. The map carries its own copy of every plant's
 *      numbers, so changing the preset in the engine does nothing here.
 *   2. THE PAINT in channel 0. Susuki was painted as a GRASS — broad swathes
 *      at high coverage. Leave that and every one of those texels becomes a
 *      16 m tree, which would be a wall. The channel is cleared and repainted
 *      for a big tree instead: only on open lowland floor, at a tenth of the
 *      coverage, in loose stands.
 *
 * WHY THE STRENGTH IS SO LOW. In this field the painted value scales the
 * field's own density, and a tree is not a grass: at full strength the test
 * stand came out as a thicket you could not walk through. 0.12 gives a palm
 * every ten metres or so, which is what a stand of them looks like.
 *
 * Run:  node tools/namFanPalms.mjs [--dry]
 */
import { readProject, writeProject } from "./lib/v3proj.mjs";
import { FOLIAGE_PRESETS } from "../v3/app/state/foliageScatterState.js";

const FILE = "public/levels/nam-valley.v3proj";
/** Splat layers a sugar palm stands on: the open lowland floor. */
const PALM_LAYERS = new Set([3]);
/** Painted coverage where a stand is thickest. */
const TARGET = 0.12;
/** How much the noise swings it, so stands clump instead of sprinkling. */
const VARY = 0.75;

const dry = process.argv.includes("--dry");

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
const density = p.blobs.get("susukiDensity");
const splat = p.blobs.get("splat");
if (!density || !splat) throw new Error("map has no susukiDensity/splat blob");

// ── 1. The species ──────────────────────────────────────────────────────────
const plants = p.manifest.susuki?.plants ?? [];
const slot = plants[0];
if (!slot) throw new Error("map has no tall-plant slot 0");
const was = slot.name;
Object.assign(slot, structuredClone(FOLIAGE_PRESETS.fanPalm), {
  name: "Fan palm",
  castShadow: true,
  // The map's own growing rules are the map's, not the preset's.
  heightMin: slot.heightMin, heightMax: slot.heightMax,
  onLayer: slot.onLayer, nearRiver: slot.nearRiver,
});

// ── 2. The paint ────────────────────────────────────────────────────────────
const gRes = Math.round(Math.sqrt(density.length / 4));
const sRes = Math.round(Math.sqrt(splat.length / 8));
const half = splat.length / 2;
const d0 = splat.subarray(0, half), d1 = splat.subarray(half);
const step = sRes / gRes;

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

const out = Buffer.from(density);
let wasPainted = 0, nowPainted = 0;
const total = gRes * gRes;
for (let gy = 0; gy < gRes; gy++) {
  for (let gx = 0; gx < gRes; gx++) {
    const i = (gy * gRes + gx) * 4;
    if (out[i] > 5) wasPainted++;
    // Channel 0 (R) is this slot's. Clear whatever the susuki had.
    out[i] = 0;
    if (!PALM_LAYERS.has(layerAt(gx, gy))) continue;
    // One broad octave decides WHERE a stand is, a finer one breaks its edge.
    const n = vnoise(gx / 34, gy / 34) * 0.78 + vnoise(gx / 9, gy / 9) * 0.22;
    // Only the upper part of the noise paints at all, so the palms gather in
    // stands with open ground between them rather than dusting the whole floor.
    if (n < 0.52) continue;
    const v = TARGET * (1 - VARY) + (n - 0.52) / 0.48 * VARY * 2 * TARGET;
    out[i] = Math.round(Math.min(1, v) * 255);
    if (out[i] > 5) nowPainted++;
  }
}

const pct = (n) => `${(100 * n / total).toFixed(1)}%`;
console.log(`tall-plant slot 0: ${was} -> Fan palm (${slot.size} m)`);
console.log(`paint channel 0, ${gRes}² over splat ${sRes}²`);
console.log(`  susuki covered   ${pct(wasPainted)}  (cleared)`);
console.log(`  fan palms now    ${pct(nowPainted)}  on open lowland floor`);
if (dry) console.log("\n--dry: not written.");
else {
  p.blobs.set("susukiDensity", out);
  await writeProject(FILE, p);
  console.log(`\nwrote ${FILE}`);
}
