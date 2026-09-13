/**
 * Industry heightmap formats: 16-bit PNG and RAW (.raw / .r16).
 *
 * What Gaea, World Machine, Unity and Unreal read and write, so terrain made
 * elsewhere can come in and v3 terrain can go out. The editor's own `.v3height`
 * (float, self-describing) stays the lossless internal format.
 *
 * CONVENTIONS (shared by import and export, so a round trip is exact):
 * - Heights are NORMALIZED like the editor's heightmap: 0 = 0 m, 1 = the chosen
 *   top height (by default the project's MAX_HEIGHT). 16 bits give 65,536 steps
 *   — about 4 mm on a 250 m terrain.
 * - Row 0 of the file is the terrain's −Z edge (the top of the image is north
 *   when looking down with −Z forward), column 0 its −X edge. `flipY` reverses
 *   the rows for tools that store the other way round.
 * - RAW has no header: the size comes from the byte count (N×N×2 = 16-bit,
 *   N×N = 8-bit). Unity and Unreal .r16 are little-endian ("Windows"); some
 *   tools write big-endian ("Mac").
 *
 * No three.js import: this file also runs under Node for the test suite.
 */

// ── PNG ─────────────────────────────────────────────────────────────────────

const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];

export function isPng(buffer) {
  if (buffer.byteLength < 8) return false;
  const b = new Uint8Array(buffer, 0, 8);
  return PNG_SIG.every((v, i) => b[i] === v);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

async function zlibInflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function zlibDeflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Channels per colour type: grey, RGB, grey+alpha, RGBA. Palette is unsupported. */
const PNG_CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

/**
 * Decode a PNG to normalized heights (0..1), row 0 = top. Reads 8- and 16-bit
 * grey, grey+alpha, RGB and RGBA; colour images use their FIRST channel (height
 * exporters that write RGB put the same value in all three).
 * @returns {Promise<{width:number, height:number, data:Float32Array, bitDepth:number}>}
 */
export async function decodePngHeights(buffer) {
  if (!isPng(buffer)) throw new Error("Not a PNG file.");
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  let width = 0, height = 0, depth = 0, colorType = -1, interlace = 0;
  const idat = [];
  for (let o = 8; o + 8 <= bytes.length; ) {
    const len = view.getUint32(o);
    const type = String.fromCharCode(bytes[o + 4], bytes[o + 5], bytes[o + 6], bytes[o + 7]);
    const body = bytes.subarray(o + 8, o + 8 + len);
    if (type === "IHDR") {
      width = view.getUint32(o + 8); height = view.getUint32(o + 12);
      depth = body[8]; colorType = body[9]; interlace = body[12];
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "IEND") {
      break;
    }
    o += 12 + len;
  }
  const channels = PNG_CHANNELS[colorType];
  if (!channels) throw new Error(`Unsupported PNG colour type ${colorType} (use a greyscale or RGB PNG).`);
  if (depth !== 8 && depth !== 16) throw new Error(`Unsupported PNG bit depth ${depth} (use 8 or 16 bits).`);
  if (interlace !== 0) throw new Error("Interlaced PNGs are not supported — re-export without interlacing.");

  const raw = await zlibInflate(new Blob(idat));
  const bytesPerSample = depth / 8;
  const bpp = channels * bytesPerSample; // bytes per pixel, for the filters
  const stride = width * bpp;
  if (raw.length < height * (stride + 1)) throw new Error("PNG image data is truncated.");
  const out = new Float32Array(width * height);
  let prev = new Uint8Array(stride);
  let cur = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const base = y * (stride + 1);
    const filter = raw[base];
    for (let i = 0; i < stride; i++) {
      const x = raw[base + 1 + i];
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      switch (filter) {
        case 0: cur[i] = x; break;
        case 1: cur[i] = x + a; break;
        case 2: cur[i] = x + b; break;
        case 3: cur[i] = x + ((a + b) >> 1); break;
        case 4: cur[i] = x + paeth(a, b, c); break;
        default: throw new Error(`Bad PNG filter type ${filter}.`);
      }
    }
    const row = y * width;
    if (depth === 16) {
      for (let x = 0; x < width; x++) {
        const p = x * bpp;
        out[row + x] = ((cur[p] << 8) | cur[p + 1]) / 65535;
      }
    } else {
      for (let x = 0; x < width; x++) out[row + x] = cur[x * bpp] / 255;
    }
    [prev, cur] = [cur, prev];
  }
  return { width, height, data: out, bitDepth: depth };
}

let _crcTable = null;
function crc32(bytes) {
  if (!_crcTable) {
    _crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      _crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = _crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/**
 * Encode 16-bit greyscale samples (row 0 = top) as a PNG. Each row uses the
 * "up" filter, which compresses smooth terrain far better than none.
 * @param {Uint16Array} samples  width×height values
 * @returns {Promise<ArrayBuffer>}
 */
export async function encodeGray16Png(samples, width, height) {
  const stride = width * 2;
  const raw = new Uint8Array(height * (stride + 1));
  let prev = new Uint8Array(stride);
  const cur = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const v = samples[row + x];
      cur[x * 2] = v >> 8;
      cur[x * 2 + 1] = v & 0xff;
    }
    const base = y * (stride + 1);
    raw[base] = 2; // up
    for (let i = 0; i < stride; i++) raw[base + 1 + i] = (cur[i] - prev[i]) & 0xff;
    prev = cur.slice();
  }
  const ihdr = new Uint8Array(13);
  const iv = new DataView(ihdr.buffer);
  iv.setUint32(0, width); iv.setUint32(4, height);
  ihdr[8] = 16; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const idat = await zlibDeflate(raw);
  const parts = [new Uint8Array(PNG_SIG), pngChunk("IHDR", ihdr), pngChunk("IDAT", idat), pngChunk("IEND", new Uint8Array(0))];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out.buffer;
}

// ── RAW ─────────────────────────────────────────────────────────────────────

/**
 * Work out what a headerless RAW file is from its size alone.
 * @returns {{size:number, bits:8|16} | null}
 */
export function inferRawLayout(byteLength) {
  const n16 = Math.round(Math.sqrt(byteLength / 2));
  if (n16 > 1 && n16 * n16 * 2 === byteLength) return { size: n16, bits: 16 };
  const n8 = Math.round(Math.sqrt(byteLength));
  if (n8 > 1 && n8 * n8 === byteLength) return { size: n8, bits: 8 };
  return null;
}

/**
 * Decode a headerless square RAW heightmap to normalized heights.
 * @param {ArrayBuffer} buffer
 * @param {{littleEndian?: boolean}} [opts] 16-bit byte order (default little-endian)
 */
export function decodeRawHeights(buffer, { littleEndian = true } = {}) {
  const layout = inferRawLayout(buffer.byteLength);
  if (!layout) {
    throw new Error(
      `A RAW heightmap must be square: ${buffer.byteLength} bytes is neither N×N (8-bit) nor N×N×2 (16-bit).`,
    );
  }
  const { size, bits } = layout;
  const data = new Float32Array(size * size);
  if (bits === 16) {
    const view = new DataView(buffer);
    for (let i = 0; i < data.length; i++) data[i] = view.getUint16(i * 2, littleEndian) / 65535;
  } else {
    const b = new Uint8Array(buffer);
    for (let i = 0; i < data.length; i++) data[i] = b[i] / 255;
  }
  return { width: size, height: size, data, bitDepth: bits };
}

/** Encode 16-bit samples as headerless RAW. */
export function encodeRaw16(samples, { littleEndian = true } = {}) {
  const buf = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buf);
  for (let i = 0; i < samples.length; i++) view.setUint16(i * 2, samples[i], littleEndian);
  return buf;
}

// ── Conversions ─────────────────────────────────────────────────────────────

/** Reverse the row order in place (row 0 ↔ last row). */
export function flipRows(data, width, height) {
  const tmp = new data.constructor(width);
  for (let y = 0; y < height >> 1; y++) {
    const a = y * width, b = (height - 1 - y) * width;
    tmp.set(data.subarray(a, a + width));
    data.copyWithin(a, b, b + width);
    data.set(tmp, b);
  }
  return data;
}

/**
 * Bilinear resample of a height grid. Corner-aligned — the first and last
 * rows/columns map onto each other — which is the right model for heightmaps,
 * where samples sit ON the grid lines (2049² → 1024² keeps both edges).
 */
export function resampleHeights(src, sw, sh, dw, dh) {
  if (sw === dw && sh === dh) return new Float32Array(src);
  const out = new Float32Array(dw * dh);
  const sx = dw > 1 ? (sw - 1) / (dw - 1) : 0;
  const sy = dh > 1 ? (sh - 1) / (dh - 1) : 0;
  for (let y = 0; y < dh; y++) {
    const fy = y * sy;
    const y0 = Math.floor(fy), y1 = Math.min(y0 + 1, sh - 1), ty = fy - y0;
    for (let x = 0; x < dw; x++) {
      const fx = x * sx;
      const x0 = Math.floor(fx), x1 = Math.min(x0 + 1, sw - 1), tx = fx - x0;
      const a = src[y0 * sw + x0], b = src[y0 * sw + x1];
      const c = src[y1 * sw + x0], d = src[y1 * sw + x1];
      out[y * dw + x] = (a + (b - a) * tx) + ((c + (d - c) * tx) - (a + (b - a) * tx)) * ty;
    }
  }
  return out;
}

/**
 * Editor heights (normalized to MAX_HEIGHT) → 16-bit samples, where 65535 is
 * `topMetres`. Returns the samples and how many were clipped at either end.
 */
export function heightsToUint16(heights, maxHeight, topMetres = maxHeight) {
  const out = new Uint16Array(heights.length);
  const k = (maxHeight / topMetres) * 65535;
  let clippedLow = 0, clippedHigh = 0;
  for (let i = 0; i < heights.length; i++) {
    let v = Math.round(heights[i] * k);
    if (v < 0) { v = 0; clippedLow++; } else if (v > 65535) { v = 65535; clippedHigh++; }
    out[i] = v;
  }
  return { samples: out, clippedLow, clippedHigh };
}
