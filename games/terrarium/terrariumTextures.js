/**
 * CPU-baked textures for the terrarium lab.
 *
 * Everything here is generated once at boot into a DataTexture. That is deliberate:
 * at terrarium scale the camera sits 30-60 cm from every surface, so the detail that
 * decides whether a thing reads as soil or as glass is *fine* detail — grain, grit,
 * smudge, droplets — and a baked map gives that at 1-2 texels per millimetre for a few
 * milliseconds of boot time. Doing the same in TSL would mean sampling noise several
 * times per pixel every frame to get a normal, which is the expensive way to buy a
 * detail that never changes.
 *
 * No file loads either, so the page is self-contained.
 */
import * as THREE from "three/webgpu";

// ── deterministic value noise ────────────────────────────────────────────────────────
// Bake-time only, so a sin-based hash is fine: it never runs per pixel per frame.

function hash2(x, y, seed) {
  const n = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453123;
  return n - Math.floor(n);
}

function smoothT(t) {
  return t * t * (3 - 2 * t);
}

/** Value noise in [0,1], tiling over `period` so the map can repeat seamlessly. */
export function valueNoise(x, y, seed = 0, period = 0) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const wrap = (v) => (period > 0 ? ((v % period) + period) % period : v);
  const x0 = wrap(xi), x1 = wrap(xi + 1);
  const y0 = wrap(yi), y1 = wrap(yi + 1);
  const a = hash2(x0, y0, seed), b = hash2(x1, y0, seed);
  const c = hash2(x0, y1, seed), d = hash2(x1, y1, seed);
  const u = smoothT(xf), v = smoothT(yf);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

/** Fractal sum. `period` is in cells at the *base* octave and doubles with frequency. */
export function fbm(x, y, { octaves = 5, lacunarity = 2, gain = 0.5, seed = 0, period = 0 } = {}) {
  let sum = 0, amp = 1, norm = 0, freq = 1;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise(x * freq, y * freq, seed + o * 17, period > 0 ? period * freq : 0);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

/** Ridged variant — thin crests instead of blobs. Used for grit and for wood grain. */
export function ridged(x, y, opts = {}) {
  const n = fbm(x, y, opts);
  return 1 - Math.abs(n * 2 - 1);
}

// ── texture construction ─────────────────────────────────────────────────────────────

/**
 * Wrap raw RGBA bytes in a repeating, mipmapped DataTexture.
 *
 * `colorSpace` matters: albedo is authored by eye in sRGB, but a normal/roughness/mask
 * map is *data* and must stay linear or the values come out bent.
 */
export function makeDataTexture(data, size, { colorSpace = THREE.NoColorSpace, anisotropy = 8 } = {}) {
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = colorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = anisotropy;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Bake a tangent-space normal map out of a height function by central differences.
 *
 * The height function is sampled on the texel grid and differenced against its
 * neighbours *with wraparound*, so the resulting map tiles without a visible seam.
 * `strength` is the height scale in texel units — bigger means steeper apparent relief.
 */
export function bakeNormalMap(size, heightFn, strength = 1) {
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) h[y * size + x] = heightFn(x, y);
  }
  const data = new Uint8Array(size * size * 4);
  const at = (x, y) => h[(((y % size) + size) % size) * size + (((x % size) + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      // Normal of the height field: (-dh/dx, -dh/dy, 1), normalised then packed.
      let nx = -dx, ny = -dy, nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len; ny /= len; nz /= len;
      const i = (y * size + x) * 4;
      data[i] = (nx * 0.5 + 0.5) * 255;
      data[i + 1] = (ny * 0.5 + 0.5) * 255;
      data[i + 2] = (nz * 0.5 + 0.5) * 255;
      data[i + 3] = 255;
    }
  }
  return makeDataTexture(data, size);
}

/** Small helpers used by the bakers below. */
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
