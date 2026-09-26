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

// ── PNG in (Terrarium tiles are 8-bit RGB/RGBA) and out (preview) ──────────

function decodePngRgb(buf) {
  let o = 8, w = 0, h = 0, ct = 0;
  const idat = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o), type = buf.toString("ascii", o + 4, o + 8);
    const data = buf.subarray(o + 8, o + 8 + len);
    if (type === "IHDR") { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ct = data[9]; if (data[8] !== 8) throw new Error("8-bit PNG only"); }
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    o += 12 + len;
  }
  const bpp = ct === 6 ? 4 : ct === 2 ? 3 : 0;
  if (!bpp) throw new Error(`PNG colour type ${ct} not handled`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp, out = new Uint8Array(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const r = raw[src + x];
      const left = x >= bpp ? out[dst + x - bpp] : 0;
      const up = y > 0 ? out[dst - stride + x] : 0;
      const ul = y > 0 && x >= bpp ? out[dst - stride + x - bpp] : 0;
      let v;
      if (f === 0) v = r;
      else if (f === 1) v = r + left;
      else if (f === 2) v = r + up;
      else if (f === 3) v = r + ((left + up) >> 1);
      else { const p = left + up - ul, pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - ul); v = r + (pa <= pb && pa <= pc ? left : pb <= pc ? up : ul); }
      out[dst + x] = v & 0xff;
    }
  }
  return { w, h, bpp, px: out };
}

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

// ── Elevation ──────────────────────────────────────────────────────────────

const CACHE = path.join(os.tmpdir(), "terrarium-cache");

async function tile(z, x, y) {
  const file = path.join(CACHE, `${z}-${x}-${y}.png`);
  if (!fs.existsSync(file)) {
    const res = await fetch(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`);
    if (!res.ok) throw new Error(`tile ${z}/${x}/${y}: HTTP ${res.status}`);
    fs.mkdirSync(CACHE, { recursive: true });
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
  const { px, bpp } = decodePngRgb(fs.readFileSync(file));
  const m = new Float32Array(256 * 256);
  for (let i = 0; i < m.length; i++) m[i] = px[i * bpp] * 256 + px[i * bpp + 1] + px[i * bpp + 2] / 256 - 32768;
  return m;
}

const mercX = (lon, z) => ((lon + 180) / 360) * 256 * 2 ** z;
const mercY = (lat, z) => { const r = (lat * Math.PI) / 180; return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 256 * 2 ** z; };

/** Real elevation (m) on an N×N grid covering span km, row 0 = north. */
async function sampleSite({ lat, lon, span }, N, z) {
  const half = (span * 1000) / 2;
  const dLat = half / 111320, dLon = half / (111320 * Math.cos((lat * Math.PI) / 180));
  // 3 px of margin: the bicubic below reads one source pixel past each side.
  const x0 = Math.floor((mercX(lon - dLon, z) - 3) / 256), x1 = Math.floor((mercX(lon + dLon, z) + 3) / 256);
  const y0 = Math.floor((mercY(lat + dLat, z) - 3) / 256), y1 = Math.floor((mercY(lat - dLat, z) + 3) / 256);
  const tiles = new Map();
  for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) tiles.set(`${tx},${ty}`, await tile(z, tx, ty));
  const at = (px, py) => {
    const tx = Math.floor(px / 256), ty = Math.floor(py / 256);
    return tiles.get(`${tx},${ty}`)[(py - ty * 256) * 256 + (px - tx * 256)];
  };
  // Catmull-Rom, not bilinear: a source pixel is ~15 m, i.e. ~4 map texels,
  // and bilinear leaves a crease along every source pixel edge — a grid of
  // facets in the hillshade and on the terrain.
  const cr = (p0, p1, p2, p3, t) => p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
  const out = new Float32Array(N * N);
  for (let i = 0; i < N; i++) {
    const la = lat + dLat - (2 * dLat * i) / (N - 1);
    const fy = mercY(la, z) - 0.5;
    for (let j = 0; j < N; j++) {
      const fx = mercX(lon - dLon + (2 * dLon * j) / (N - 1), z) - 0.5;
      const ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy;
      const row = (y) => cr(at(ix - 1, y), at(ix, y), at(ix + 1, y), at(ix + 2, y), tx);
      out[i * N + j] = cr(row(iy - 1), row(iy), row(iy + 1), row(iy + 2), ty);
    }
  }
  return out;
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
