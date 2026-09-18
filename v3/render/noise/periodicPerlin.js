/**
 * Tileable value/Perlin noise on the CPU — the three primitives a baked texture needs.
 *
 * Split out of the cloud-noise module (v3/render/clouds/cloudNoise.js) on 2026-09-18 when
 * the sky moved into the engine: the moon's surface and the Milky Way band bake from these
 * too, and a sky module has no business importing the cloud volume baker to get at three
 * noise functions. cloudNoise re-exports them, so its own importers were untouched.
 *
 * Everything here is PERIODIC: lattice coordinates wrap at `period`, so an FBM whose
 * octave frequency equals its period tiles seamlessly. That is what lets a baked volume
 * or equirect repeat without a visible seam, and it is why this is not just
 * `Math.random()` + smoothstep.
 *
 * CPU, not TSL, on purpose — these run once at bake time into a texture, so the cost is
 * paid at startup and never per pixel.
 *
 * @see v3/render/sky/moonSurface.js — maria and craters
 * @see v3/render/sky/milkyWay.js    — the band's star clouds and dust lanes
 */

/** Deterministic PRNG so a given seed always bakes the same sky. */
export function seededRandom(seed) {
  let s = seed >>> 0;
  return function next() {
    let t = (s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Periodic (tileable) improved Perlin noise. Lattice coordinates wrap at `period`, so an
 * FBM whose octave frequency equals its period tiles seamlessly — no 8-corner blend, which
 * costs 8x and muddies contrast. Returns roughly [-1, 1].
 */
export function makePeriodicPerlin(rng) {
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = (rng() * (i + 1)) | 0;
    const t = p[i]; p[i] = p[j]; p[j] = t;
  }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];

  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const lerp = (a, b, t) => a + (b - a) * t;
  function grad(hash, x, y, z) {
    const h = hash & 15;
    const u = h < 8 ? x : y;
    const v = h < 4 ? y : (h === 12 || h === 14) ? x : z;
    return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
  }

  return function noise(x, y, z, period) {
    const Xf = Math.floor(x), Yf = Math.floor(y), Zf = Math.floor(z);
    const xf = x - Xf, yf = y - Yf, zf = z - Zf;
    const X0 = ((Xf % period) + period) % period;
    const Y0 = ((Yf % period) + period) % period;
    const Z0 = ((Zf % period) + period) % period;
    const X1 = (X0 + 1) % period, Y1 = (Y0 + 1) % period, Z1 = (Z0 + 1) % period;
    const u = fade(xf), v = fade(yf), w = fade(zf);
    const h = (xi, yi, zi) => perm[perm[perm[xi] + yi] + zi];
    return lerp(
      lerp(
        lerp(grad(h(X0, Y0, Z0), xf, yf, zf), grad(h(X1, Y0, Z0), xf - 1, yf, zf), u),
        lerp(grad(h(X0, Y1, Z0), xf, yf - 1, zf), grad(h(X1, Y1, Z0), xf - 1, yf - 1, zf), u),
        v,
      ),
      lerp(
        lerp(grad(h(X0, Y0, Z1), xf, yf, zf - 1), grad(h(X1, Y0, Z1), xf - 1, yf, zf - 1), u),
        lerp(grad(h(X0, Y1, Z1), xf, yf - 1, zf - 1), grad(h(X1, Y1, Z1), xf - 1, yf - 1, zf - 1), u),
        v,
      ),
      w,
    );
  };
}

/** Tileable Perlin FBM over the unit cube; octave frequency = wrap period. → 0..1 */
export function perlinFbm(noise, x, y, z, baseFreq, octaves) {
  let sum = 0, amp = 1, norm = 0, freq = baseFreq;
  for (let o = 0; o < octaves; o++) {
    sum += noise(x * freq, y * freq, z * freq, freq) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return (sum / norm) * 0.5 + 0.5;
}
