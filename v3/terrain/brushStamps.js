import * as THREE from "three";

// Heightmap brush stamps (Terrain3D's brush set, MIT), converted from EXR to
// 16-bit grayscale PNGs in public/brush-stamps/. terrain1/3/4/5/6 are full-bleed
// tiles and had a circular edge fade baked in at conversion, so no stamp cuts a
// square cliff into the terrain.
//
// Kept apart from the procedural BRUSH_MASKS on purpose: those are generated in
// code, these are image assets loaded on demand.
export const STAMP_GROUPS = [
  { label: "Mountains", stamps: ["hill1", "hill2", "mountain1", "mountain2", "mountain3", "mountain4", "peak1", "peak2", "peak3"] },
  { label: "Landscapes", stamps: ["terrain1", "terrain2", "terrain3", "terrain4", "terrain5", "terrain6"] },
  { label: "Features", stamps: ["ring1", "stones", "acrylic1", "smoke", "vegetation1"] },
  { label: "Surface", stamps: ["texture1", "texture2", "texture3", "texture4", "texture5"] },
  { label: "Basic", stamps: ["circle0", "circle1", "circle2", "circle3", "circle4", "square1", "square2", "square3", "square4", "square5"] },
];

const STAMP_URL = (name) => `/brush-stamps/${name}.png`;

// ── Minimal PNG decoder (grayscale 8/16-bit, non-interlaced) ────────────────
//
// WHY NOT new Image(): the browser decodes every PNG to 8 bits per channel, so a
// 16-bit stamp arrives as 256 levels and stacked stamps terrace. Decoding the
// bytes ourselves keeps all 65,536.
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Decode a grayscale PNG to Float32Array values in 0..1, row 0 = top. */
export async function decodeGrayPNG(buffer) {
  const bytes = new Uint8Array(buffer);
  const view  = new DataView(buffer);
  const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!SIG.every((b, i) => bytes[i] === b)) throw new Error("not a PNG");

  let width = 0, height = 0, depth = 0, colorType = 0, interlace = 0;
  const idat = [];
  for (let o = 8; o < bytes.length; ) {
    const len  = view.getUint32(o);
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
  if (colorType !== 0 || (depth !== 8 && depth !== 16) || interlace !== 0) {
    throw new Error(`unsupported PNG (colour type ${colorType}, depth ${depth}, interlace ${interlace})`);
  }

  const raw    = await inflate(new Blob(idat));
  const bpp    = depth / 8;
  const stride = width * bpp;
  const out    = new Float32Array(width * height);
  let prev = new Uint8Array(stride);
  let cur  = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const base   = y * (stride + 1);
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
        default: throw new Error(`bad PNG filter ${filter}`);
      }
    }
    const row = y * width;
    if (depth === 16) {
      for (let x = 0; x < width; x++) out[row + x] = ((cur[x * 2] << 8) | cur[x * 2 + 1]) / 65535;
    } else {
      for (let x = 0; x < width; x++) out[row + x] = cur[x] / 255;
    }
    [prev, cur] = [cur, prev];
  }
  return { width, height, data: out };
}

// ── Texture ─────────────────────────────────────────────────────────────────
//
// HALF FLOAT, RGBA — deliberately the same sample type ("float", filterable) as
// the 8-bit canvas presets, so swapping sculpt.maskNode.value between a preset
// and a stamp never changes the bind-group layout. Full float would be
// "unfilterable-float" on GPUs without float32-filterable. Half precision is
// 1/2048 near the top of the range and finer below — 8x better than 8-bit
// where it's coarsest.
function makeStampTexture({ width, height, data }) {
  const px = new Uint16Array(width * height * 4);
  const one = THREE.DataUtils.toHalfFloat(1);
  // PNG row 0 is the top. Canvas presets and the Load PNG path are uploaded
  // with flipY = true (image top at v = 1); a DataTexture is not flipped, so
  // the rows are reversed here to land the same way round.
  for (let y = 0; y < height; y++) {
    const src = (height - 1 - y) * width;
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      px[o] = px[o + 1] = px[o + 2] = THREE.DataUtils.toHalfFloat(data[src + x]);
      px[o + 3] = one;
    }
  }
  const tex = new THREE.DataTexture(px, width, height, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;

  // An 8-bit copy for the 48 px panel preview (a DataTexture's image can't be
  // drawn to a canvas).
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(width, height);
  for (let i = 0; i < width * height; i++) {
    const v = Math.round(data[i] * 255);
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  tex.userData.preview = canvas;
  return tex;
}

const _cache = new Map();

/** Load a stamp by name → Promise<THREE.DataTexture>. Cached per name. */
export function loadStamp(name) {
  if (!_cache.has(name)) {
    const p = fetch(STAMP_URL(name))
      .then((r) => {
        if (!r.ok) throw new Error(`brush stamp ${name}: HTTP ${r.status}`);
        return r.arrayBuffer();
      })
      .then(decodeGrayPNG)
      .then(makeStampTexture);
    p.catch(() => _cache.delete(name)); // allow a retry after a failed fetch
    _cache.set(name, p);
  }
  return _cache.get(name);
}
