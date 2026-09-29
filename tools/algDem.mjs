/**
 * REAL GROUND FOR THE ALGERIA RTS — a map heightmap cut from real elevation.
 *
 * Fetches public Terrarium elevation tiles (SRTM-derived, ~30 m source data,
 * s3.amazonaws.com/elevation-tiles-prod — no key), cuts a square of real
 * country `--span` km wide centred on `--lat/--lon`, and squeezes it into the
 * game's 1024 m map. Height is squeezed by the SAME factor by default
 * (`--vscale 1`), so every slope is the real slope — the metric that matters
 * for an RTS. `--vscale` above 1 exaggerates relief, below 1 flattens it.
 *
 *   node tools/algDem.mjs --site aures-arris --out <dir>
 *   node tools/algDem.mjs --lat 35.26 --lon 6.35 --span 4 --name test --out <dir>
 *
 * Writes, per site:
 *   <name>.png          16-bit grey heightmap, row 0 = north, white = --top m
 *                       (editor: Sculpt → Heightmap File → import)
 *   <name>.f32          the same heights as raw Float32 normalised to --top,
 *                       i.e. exactly a .v3proj `heightmap` blob
 *   <name>-shade.png    hillshade preview; ground steeper than the nav limit
 *                       tinted red, the biggest connected gentle patch green
 *
 * and prints the three metrics of proj_v3_rts_terrain_recipe: slope histogram
 * + walkable %, walkable % per tile on a 4×4 grid, and the biggest CONNECTED
 * gentle patch — the one that says whether an army can manoeuvre.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { encodeGray16Png, heightsToUint16 } from "../v3/io/heightmapFormats.js";
import { measureRtsMap, printRtsMetrics, NAV_MAX_SLOPE_DEG } from "./lib/rtsMapMetrics.mjs";
import { sampleSite } from "./lib/terrarium.mjs";


// Candidate ground. Centres are real places; spans are how much real country
// the 1024 m map swallows.
const SITES = {
  // Arris, heart of the Aurès — the first night of the war, 1 Nov 1954.
  "aures-arris":       { lat: 35.258, lon: 6.346, span: 4 },
  // Tighanimine gorges, south of Arris — the ambush on the Biskra–Arris road.
  "aures-tighanimine": { lat: 35.215, lon: 6.300, span: 4 },
  // Oued Abdi valley — a long cultivated valley between two ridges.
  "aures-oued-abdi":   { lat: 35.200, lon: 6.200, span: 5 },
  // Ghoufi canyon — the balcony villages above the Oued el Abiod.
  "aures-ghoufi":      { lat: 35.055, lon: 6.145, span: 3 },
  // Greater Kabylie below the Djurdjura — ridge-top villages.
  "kabylie-irathen":   { lat: 36.635, lon: 4.197, span: 4 },
};

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const k = argv[i].slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
      a[k] = v;
    }
  }
  return a;
}

// ── PNG out (the preview; the tiles are read in tools/lib/terrarium.mjs) ─────


const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (b) => { let c = -1; for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function chunk(type, data) {
  const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}
function encodePngRgb(rgb, w, h) {
  const raw = Buffer.alloc(h * (w * 3 + 1));
  for (let y = 0; y < h; y++) rgb.subarray(y * w * 3, (y + 1) * w * 3).forEach((v, i) => { raw[y * (w * 3 + 1) + 1 + i] = v; });
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}


function hillshade(h, N, world, m, P) {
  const rgb = new Uint8Array(P * P * 3);
  const cell = world / (N - 1);
  const L = [-0.5, 0.7, -0.5], ln = Math.hypot(...L);
  for (let y = 0; y < P; y++) for (let x = 0; x < P; x++) {
    const i = Math.min(N - 2, Math.round((y * (N - 1)) / (P - 1))), j = Math.min(N - 2, Math.round((x * (N - 1)) / (P - 1)));
    const dx = (h[i * N + j + 1] - h[i * N + j]) / cell, dz = (h[(i + 1) * N + j] - h[i * N + j]) / cell;
    const nl = Math.hypot(dx, 1, dz);
    const lit = Math.max(0, (-dx * L[0] + 1 * L[1] - dz * L[2]) / (nl * ln));
    let r = 60 + 190 * lit, g = r, b = r;
    const s = i * N + j;
    if (m.slope[s] > NAV_MAX_SLOPE_DEG) { r = r * 0.6 + 100; g *= 0.55; b *= 0.55; }
    else if (m.label[s] === m.bestId) { r *= 0.75; b *= 0.75; g = g * 0.8 + 40; }
    const o = (y * P + x) * 3;
    rgb[o] = Math.min(255, r); rgb[o + 1] = Math.min(255, g); rgb[o + 2] = Math.min(255, b);
  }
  return encodePngRgb(rgb, P, P);
}

// ── Main ───────────────────────────────────────────────────────────────────

const args = parseArgs(process.argv.slice(2));
const N = +(args.size ?? 1024);
const WORLD = +(args.world ?? 1024);
const TOP = +(args.top ?? 250);          // MAX_HEIGHT of the map
const FLOOR = +(args.floor ?? 4);        // lowest ground, metres (keep a sea-level fog band usable)
const Z = +(args.zoom ?? 13);
const outDir = args.out ?? path.join(os.tmpdir(), "alg-dem");
fs.mkdirSync(outDir, { recursive: true });

const names = args.site === "all" ? Object.keys(SITES) : [args.site ?? args.name ?? "custom"];
for (const name of names) {
  const site = SITES[name] ? { ...SITES[name] } : { lat: +args.lat, lon: +args.lon, span: +(args.span ?? 4) };
  if (args.span && SITES[name]) site.span = +args.span;
  if (!Number.isFinite(site.lat) || !Number.isFinite(site.lon)) throw new Error(`unknown site "${name}" and no --lat/--lon`);

  const real = await sampleSite(site, N, Z);
  let lo = Infinity, hi = -Infinity;
  for (const v of real) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const k = (WORLD / (site.span * 1000)) * +(args.vscale ?? 1);
  const h = new Float32Array(N * N);
  let gameHi = 0;
  for (let i = 0; i < h.length; i++) { h[i] = FLOOR + (real[i] - lo) * k; if (h[i] > gameHi) gameHi = h[i]; }

  // The source carries fine horizontal striping (visible in the hillshade as
  // combed ridges). A small separable box blur, 3 passes ≈ gaussian, removes
  // it; the editor's erosion puts real detail back afterwards.
  const R = +(args.smooth ?? 3);
  if (R > 0) {
    const tmp = new Float32Array(N * N);
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
        let s = 0, n = 0;
        for (let d = -R; d <= R; d++) { const jj = j + d; if (jj >= 0 && jj < N) { s += h[i * N + jj]; n++; } }
        tmp[i * N + j] = s / n;
      }
      for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
        let s = 0, n = 0;
        for (let d = -R; d <= R; d++) { const ii = i + d; if (ii >= 0 && ii < N) { s += tmp[ii * N + j]; n++; } }
        h[i * N + j] = s / n;
      }
    }
  }

  const m = measureRtsMap(h, N, WORLD);
  const norm = h.map((v) => v / TOP);
  const { samples, clippedHigh } = heightsToUint16(norm, TOP, TOP);
  fs.writeFileSync(path.join(outDir, `${name}.png`), Buffer.from(await encodeGray16Png(samples, N, N)));
  fs.writeFileSync(path.join(outDir, `${name}.f32`), Buffer.from(norm.buffer));
  fs.writeFileSync(path.join(outDir, `${name}-shade.png`), hillshade(h, N, WORLD, m, 512));

  console.log(`\n── ${name}  (${site.lat}, ${site.lon}, ${site.span} km → ${WORLD} m, ×${k.toFixed(3)})`);
  console.log(`real ${lo.toFixed(0)}–${hi.toFixed(0)} m  → game ${FLOOR}–${gameHi.toFixed(1)} m${clippedHigh ? `  (${clippedHigh} texels CLIPPED at ${TOP} m)` : ""}`);
  printRtsMetrics(m);
}
console.log(`\nwritten to ${outDir}`);
