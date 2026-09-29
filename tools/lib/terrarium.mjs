/**
 * TERRARIUM ELEVATION — real ground from the public Terrarium tiles
 * (SRTM-derived, ~30 m source, s3.amazonaws.com/elevation-tiles-prod, no key),
 * cached in the OS temp dir. Moved out of tools/algDem.mjs (2026-09-29) when
 * tools/algMountains.mjs needed the same ground round the same site.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

// ── PNG in (Terrarium tiles are 8-bit RGB/RGBA) ─────────────────────────────

export function decodePngRgb(buf) {
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

// ── Elevation ──────────────────────────────────────────────────────────────

const CACHE = path.join(os.tmpdir(), "terrarium-cache");

export async function tile(z, x, y) {
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

export const mercX = (lon, z) => ((lon + 180) / 360) * 256 * 2 ** z;
export const mercY = (lat, z) => { const r = (lat * Math.PI) / 180; return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 256 * 2 ** z; };

/** Real elevation (m) on an N×N grid covering span km, row 0 = north. */
export async function sampleSite({ lat, lon, span }, N, z) {
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
