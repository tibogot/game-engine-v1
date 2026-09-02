/**
 * Cloud noise primitives + volume bakes for the GAME's own cloud system.
 *
 * DELIBERATELY STANDALONE. The v3 editor's deck (v3/render/clouds/dayNightCloudLayer.js)
 * has its own copy of a Perlin/Worley bake and we do NOT share it: that one is tuned for
 * a viewer 2 km below a 1400 m-thick ceiling, and every frequency choice in it is wrong
 * for a car flying THROUGH the deck at 30 m/s. Sharing the bake would couple two sets of
 * requirements that genuinely disagree. Nothing here imports from v3/render/clouds/.
 *
 * The frequency budget is the whole point of this file, so it's worth stating plainly.
 * The editor tiles its 128³ base volume over ~6.7 km → one voxel is ~52 m. That is the
 * right call at 2 km viewing distance and useless at 5 m, where the camera sits inside a
 * single voxel and sees smooth grey soup. Here the same 128³ tiles over `BASE_TILE_M`
 * (~1200 m) → ~9.4 m per voxel, and a separate small high-frequency volume tiles over
 * `NEAR_TILE_M` (~90 m) → ~2.8 m per voxel, faded in only near the camera so it costs
 * nothing when you're looking at the horizon.
 *
 * Everything is TILEABLE (periodic Perlin lattice, wrapped Worley cell grids) so the
 * volumes can repeat across the sky without visible seams.
 *
 * @see modularRoadCloudNoiseWorker.js — runs the bakes off the main thread.
 */

/** World metres one wrap of the 128³ base volume covers. ~9.4 m / voxel. */
export const BASE_TILE_M = 1200;
/** World metres one wrap of the 64³ near-detail volume covers. ~1.4 m / voxel, carrying
 *  Worley cells of 11.25 / 5.6 / 2.8 m — see bakeNearVolume for why those numbers. */
export const NEAR_TILE_M = 90;
/** World metres one wrap of the 64³ mid-detail (edge erosion) volume covers. ~14 m / voxel. */
export const DETAIL_TILE_M = 900;
/** World metres one wrap of the 2D weather map covers. Bigger than the 2 km world so
 *  coverage genuinely varies across the playable area instead of repeating inside it. */
export const WEATHER_TILE_M = 6000;

export const BASE_SIZE = 128;
export const DETAIL_SIZE = 64;
export const NEAR_SIZE = 64;
export const WEATHER_SIZE = 256;

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

/**
 * Tileable inverted Worley (cellular) noise. One feature point per cell on a wrapping
 * `freq`³ grid, evaluated over the 27 neighbours. Inverted (1 - distance) so cloud cells
 * read as puffs rather than veins.
 *
 * PERF: this is the hot loop of the whole bake — 27 cells x 4 frequencies x 2M voxels for
 * the base volume. The neighbour offsets are hoisted and the distance test stays squared
 * (one sqrt at the end) because that measurably matters at this call count.
 */
export function makeWorley(freq, rng) {
  const n = freq * freq * freq;
  const pts = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    pts[i * 3] = rng(); pts[i * 3 + 1] = rng(); pts[i * 3 + 2] = rng();
  }
  return function worley(x, y, z) {
    const fx = x * freq, fy = y * freq, fz = z * freq;
    const cx = Math.floor(fx), cy = Math.floor(fy), cz = Math.floor(fz);
    let minD2 = 1e10;
    for (let dz = -1; dz <= 1; dz++) {
      const gz = ((cz + dz) % freq + freq) % freq;
      for (let dy = -1; dy <= 1; dy++) {
        const gy = ((cy + dy) % freq + freq) % freq;
        for (let dx = -1; dx <= 1; dx++) {
          const gx = ((cx + dx) % freq + freq) % freq;
          const idx = ((gz * freq + gy) * freq + gx) * 3;
          const px = (cx + dx) + pts[idx];
          const py = (cy + dy) + pts[idx + 1];
          const pz = (cz + dz) + pts[idx + 2];
          const ex = px - fx, ey = py - fy, ez = pz - fz;
          const d2 = ex * ex + ey * ey + ez * ez;
          if (d2 < minD2) minD2 = d2;
        }
      }
    }
    return 1 - Math.min(1, Math.sqrt(minD2));
  };
}

/** Tileable Worley FBM (three octaves, halving amplitude). → 0..1 */
function worleyFbm(a, b, c) {
  return a * 0.625 + b * 0.25 + c * 0.125;
}

/**
 * Stretch one interleaved channel to fill 0..255, using percentile bounds.
 *
 * THIS IS LOAD-BEARING, not a tidy-up. FBM and Worley fields are nominally 0..1 but in
 * practice occupy a narrow band around the middle — measured here, the raw Perlin-Worley
 * channel spanned 0.55..0.89 and the weather coverage 0.30..0.64. The Nubis density recipe
 * is a chain of `remap(field, threshold, 1)` steps that assumes each field actually
 * reaches its extremes; feed it a field with a 0.22-wide span and the threshold either
 * rejects everything or accepts everything, with almost no spatial variation in between.
 * The symptom is a sky that is uniformly empty or uniformly overcast no matter what the
 * coverage slider says.
 *
 * Percentile bounds rather than min/max so a handful of outlier voxels cannot squash the
 * rest of the distribution back into a narrow band.
 */
export function normalizeChannel(data, stride, offset, loPct = 0.005, hiPct = 0.995) {
  const n = Math.floor((data.length - offset + stride - 1) / stride);
  // Byte data — a 256-bin histogram IS the exact distribution, so no sort is needed.
  const hist = new Uint32Array(256);
  for (let i = offset, c = 0; c < n; i += stride, c++) hist[data[i]]++;
  let lo = 0, hi = 255, acc = 0;
  const loTarget = n * loPct, hiTarget = n * hiPct;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= loTarget) { lo = v; break; } }
  acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= hiTarget) { hi = v; break; } }
  if (hi <= lo) return; // degenerate (constant channel) — leave it alone
  const scale = 255 / (hi - lo);
  for (let i = offset, c = 0; c < n; i += stride, c++) {
    const v = (data[i] - lo) * scale;
    data[i] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
}

/**
 * BASE volume, 128³ RGBA — the Nubis layout (GPU Pro 7, "Real-Time Volumetric
 * Cloudscapes of Horizon: Zero Dawn").
 *
 *   R       Perlin-Worley: Perlin FBM inflated from below by low-frequency inverted
 *           Worley, which connects the Perlin field into rounded cauliflower masses
 *           instead of the smooth blobs plain Perlin gives.
 *   G,B,A   Worley FBM at rising frequencies. The shader erodes R with these
 *           (`remap(R, fbm-1, 1, 0, 1)`), which moves the iso-surface itself rather
 *           than just darkening — that's what carves real shape instead of a texture.
 */
export function bakeBaseVolume(seed = 137) {
  const rng = seededRandom(seed >>> 0);
  const perlin = makePeriodicPerlin(rng);
  const w4 = makeWorley(4, rng), w8 = makeWorley(8, rng);
  const w16 = makeWorley(16, rng), w32 = makeWorley(32, rng);

  const S = BASE_SIZE;
  const out = new Uint8Array(S * S * S * 4);
  let i = 0;
  for (let z = 0; z < S; z++) {
    // Divide by SIZE (not SIZE-1) so texel 0 !== texel N-1 and the wrap is seamless.
    const nz = z / S;
    for (let y = 0; y < S; y++) {
      const ny = y / S;
      for (let x = 0; x < S; x++) {
        const nx = x / S;
        const pf = perlinFbm(perlin, nx, ny, nz, 4, 5);
        const a4 = w4(nx, ny, nz), a8 = w8(nx, ny, nz);
        const a16 = w16(nx, ny, nz), a32 = w32(nx, ny, nz);
        const f4 = worleyFbm(a4, a8, a16);
        const f8 = worleyFbm(a8, a16, a32);
        const f16 = a16 * 0.75 + a32 * 0.25;
        // Perlin-Worley: remap(perlin, 0, 1, worley, 1).
        const pw = f4 + pf * (1 - f4);
        out[i++] = pw * 255;
        out[i++] = f4 * 255;
        out[i++] = f8 * 255;
        out[i++] = f16 * 255;
      }
    }
  }
  // Every channel feeds a `remap` threshold in the shader, so every channel needs its
  // full range. See normalizeChannel().
  for (let c = 0; c < 4; c++) normalizeChannel(out, 4, c);
  return out;
}

/** MID-DETAIL volume, 64³ RGB — Worley FBM at three frequencies, for edge erosion. */
export function bakeDetailVolume(seed = 41) {
  const rng = seededRandom(seed >>> 0);
  const d8 = makeWorley(8, rng), d16 = makeWorley(16, rng), d32 = makeWorley(32, rng);
  const S = DETAIL_SIZE;
  const out = new Uint8Array(S * S * S * 4);
  let i = 0;
  for (let z = 0; z < S; z++) {
    const nz = z / S;
    for (let y = 0; y < S; y++) {
      const ny = y / S;
      for (let x = 0; x < S; x++) {
        const nx = x / S;
        out[i++] = d8(nx, ny, nz) * 255;
        out[i++] = d16(nx, ny, nz) * 255;
        out[i++] = d32(nx, ny, nz) * 255;
        out[i++] = 255;
      }
    }
  }
  for (let c = 0; c < 3; c++) normalizeChannel(out, 4, c);
  return out;
}

/**
 * NEAR-DETAIL volume, 64³ RGBA — the octave that makes flying THROUGH a cloud read as
 * cloud rather than fog. The march fades it in only inside `nearRange`, so it is free for
 * every ray that is not close to one.
 *
 * FREQUENCY, NOT VOXEL SIZE, is what matters here, and it is easy to state the wrong one.
 * Over a 90 m tile, Worley frequencies 8/16/32 give cells of 11.25 / 5.6 / 2.8 m — those
 * are the feature sizes you actually see. An earlier version used 4/8/16 and weighted the
 * FBM toward the lowest, so its "near detail" was 22 m blobs: no finer than the mid-detail
 * volume it was supposed to be adding to, which is why close cloud read as smooth fog.
 *
 * 64³ rather than 32³ because the 2.8 m cells need at least two voxels each to survive
 * (1.4 m/voxel here). At 32³ they would alias into noise. The bake is ~150 ms.
 */
export function bakeNearVolume(seed = 907) {
  const rng = seededRandom(seed >>> 0);
  const n4 = makeWorley(8, rng), n8 = makeWorley(16, rng), n16 = makeWorley(32, rng);
  const S = NEAR_SIZE;
  const out = new Uint8Array(S * S * S * 4);
  let i = 0;
  for (let z = 0; z < S; z++) {
    const nz = z / S;
    for (let y = 0; y < S; y++) {
      const ny = y / S;
      for (let x = 0; x < S; x++) {
        const nx = x / S;
        const a = n4(nx, ny, nz), b = n8(nx, ny, nz), c = n16(nx, ny, nz);
        out[i++] = a * 255;
        out[i++] = b * 255;
        out[i++] = c * 255;
        out[i++] = worleyFbm(a, b, c) * 255;
      }
    }
  }
  for (let ch = 0; ch < 4; ch++) normalizeChannel(out, 4, ch);
  return out;
}

/**
 * WEATHER map, 256² RGBA — the thing the editor's deck does not have, and the reason its
 * sky reads as a uniform ceiling rather than as clouds. Coverage there is two global
 * uniforms applied identically to the whole sky; here it varies per XZ, so you get real
 * cloud masses with real gaps between them — which is what makes a fly-through track
 * possible at all.
 *
 *   R  coverage    0 = clear sky, 1 = solid. Low-frequency FBM.
 *   G  cloud type  0 = flat stratus, 1 = tall cumulus. Drives the vertical profile.
 *   B  density     local density multiplier (thin wisps vs. heavy cores).
 *   A  unused      reserved.
 */
export function bakeWeatherMap(seed = 2029) {
  const rng = seededRandom(seed >>> 0);
  const perlin = makePeriodicPerlin(rng);
  const S = WEATHER_SIZE;
  const out = new Uint8Array(S * S * 4);
  let i = 0;
  for (let y = 0; y < S; y++) {
    const ny = y / S;
    for (let x = 0; x < S; x++) {
      const nx = x / S;
      // Independent fields from one lattice by offsetting the sample plane in Z.
      const cov = perlinFbm(perlin, nx, ny, 0.13, 2, 4);
      const typ = perlinFbm(perlin, nx, ny, 0.61, 3, 3);
      const den = perlinFbm(perlin, nx, ny, 0.87, 4, 3);
      // Push coverage toward a bimodal clear/cloudy split so gaps are genuinely open
      // rather than uniformly hazy — smoothstep on the raw FBM flattens the midtones.
      const covS = cov * cov * (3 - 2 * cov);
      // CLOUD-TOP HEIGHT — how much of the slab this cell's cloud fills.
      //
      // This is what turns a layer into clouds. Without it every cell spans the same
      // height range, so the deck can only ever read as a flat sheet however good the
      // erosion is: the eye reads "cloud" from silhouettes of DIFFERENT heights standing
      // next to each other.
      //
      // CORRELATED WITH COVERAGE, deliberately. The first version was independent noise,
      // and an independent tall cell landing on a thin part of a mass extrudes a narrow
      // stalk — the "chimney / mesa" towers that read as rock formations, not cloud.
      // Real cumulus tower where the mass is FATTEST: convective depth grows with the
      // moisture supply. Weighting the top field toward the coverage field puts the
      // towers on the cores and tapers the skirts shallow, which is a cauliflower dome
      // per mass; the residual noise term keeps two equally-fat masses from having
      // identical ceilings. (normalizeChannel restores full range afterward.)
      const topN = perlinFbm(perlin, nx, ny, 0.41, 3, 2);
      const top = 0.4 * topN + 0.6 * covS;
      out[i++] = covS * 255;
      out[i++] = typ * 255;
      out[i++] = den * 255;
      out[i++] = top * 255;
    }
  }
  // Coverage especially: this channel IS the `1 - coverage` threshold, so a narrow range
  // here means the whole sky sits on one side of the bar and the slider does nothing.
  // Cloud-top needs it for the same reason — a narrow band of heights is precisely the
  // flat-sheet look the channel exists to break up.
  for (let c = 0; c < 4; c++) normalizeChannel(out, 4, c);
  return out;
}

// ── CPU-side sampling ────────────────────────────────────────────────────────────────
// The shader is not the only thing that needs to know where the clouds are. Gameplay does
// too — whether the car is inside cloud drives HUD/audio/visibility — and so does any
// headless test of the density field. These mirror the GPU's trilinear/bilinear filtering
// closely enough for both purposes.

/** Trilinear sample of a tiling interleaved-RGBA volume. `out` is filled with 0..1. */
export function sampleVolume3D(data, size, x, y, z, out = [0, 0, 0, 0]) {
  const wrap = (v) => ((v % size) + size) % size;
  const fx = x * size - 0.5, fy = y * size - 0.5, fz = z * size - 0.5;
  const x0 = Math.floor(fx), y0 = Math.floor(fy), z0 = Math.floor(fz);
  const tx = fx - x0, ty = fy - y0, tz = fz - z0;
  const wx = [1 - tx, tx], wy = [1 - ty, ty], wz = [1 - tz, tz];
  out[0] = out[1] = out[2] = out[3] = 0;
  for (let k = 0; k < 8; k++) {
    const dx = k & 1, dy = (k >> 1) & 1, dz = (k >> 2) & 1;
    const w = wx[dx] * wy[dy] * wz[dz];
    if (w === 0) continue;
    const base = ((wrap(z0 + dz) * size + wrap(y0 + dy)) * size + wrap(x0 + dx)) * 4;
    out[0] += data[base] * w; out[1] += data[base + 1] * w;
    out[2] += data[base + 2] * w; out[3] += data[base + 3] * w;
  }
  out[0] /= 255; out[1] /= 255; out[2] /= 255; out[3] /= 255;
  return out;
}

/** Bilinear sample of a tiling interleaved-RGBA 2D map. */
export function sampleMap2D(data, size, x, y, out = [0, 0, 0, 0]) {
  const wrap = (v) => ((v % size) + size) % size;
  const fx = x * size - 0.5, fy = y * size - 0.5;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = fx - x0, ty = fy - y0;
  const wx = [1 - tx, tx], wy = [1 - ty, ty];
  out[0] = out[1] = out[2] = out[3] = 0;
  for (let k = 0; k < 4; k++) {
    const dx = k & 1, dy = (k >> 1) & 1;
    const w = wx[dx] * wy[dy];
    if (w === 0) continue;
    const base = (wrap(y0 + dy) * size + wrap(x0 + dx)) * 4;
    out[0] += data[base] * w; out[1] += data[base + 1] * w;
    out[2] += data[base + 2] * w; out[3] += data[base + 3] * w;
  }
  out[0] /= 255; out[1] /= 255; out[2] /= 255; out[3] /= 255;
  return out;
}

const _clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const _mix = (a, b, t) => a + (b - a) * t;
function _smoothstep(e0, e1, x) {
  const t = _clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}
/** Mirrors the shader's guarded remapUnit — the divisor floor matters, see the shader. */
const _remapUnit = (v, lo, hi) => _clamp01((v - lo) / Math.max(hi - lo, 1e-4));

/**
 * CPU mirror of the shader's `sampleDensity`, minus the near-field octave (which is a
 * view-distance effect and meaningless without a ray).
 *
 * MUST BE KEPT IN SYNC with sampleDensity() in modularRoadClouds.js. If the two drift,
 * "is the car in a cloud" starts disagreeing with what the player sees.
 *
 * @param {object} vols  { base, detail, weather } — the raw Uint8Arrays
 * @param {object} P     the cloud params (base, thickness, coverage, …)
 * @param {THREE.Vector3Like} wind current wind offset in world metres
 */
export function densityAtCPU(vols, P, wind, x, y, z, scratch = { b: [0, 0, 0, 0], w: [0, 0, 0, 0], d: [0, 0, 0, 0] }) {
  const h = (y - P.base) / P.thickness;
  if (h <= 0 || h >= 1) return 0;

  const w = sampleMap2D(
    vols.weather, WEATHER_SIZE,
    (x + wind.x * 0.35) / WEATHER_TILE_M, (z + wind.z * 0.35) / WEATHER_TILE_M, scratch.w,
  );
  // Coverage is a THRESHOLD on the weather channel, not a multiplier — must match
  // sampleWeather() in modularRoadClouds.js (see CLOUD_DEFAULTS.coverage there for why).
  const covSoft = P.coverageSoft ?? 0.16;
  const covRaw = _clamp01(w[0] + P.coverageBias);
  const covBar = (1 + covSoft) - P.coverage * (1 + 2 * covSoft);
  const cov = _smoothstep(covBar - covSoft, covBar + covSoft, covRaw);
  const type = _clamp01(w[1] - 0.5 + P.typeBias);
  const denScale = _mix(0.55, 1.45, w[2]);
  // Per-cell cloud top — see the A channel in bakeWeatherMap. Local height is what gives
  // neighbouring clouds different heights; the shader does the same rescale.
  const topFrac = _mix(P.cloudTopMin ?? 0.18, 1, _clamp01(w[3] + (P.cloudTopBias ?? 0)));
  const hL = h / Math.max(topFrac, 0.05);

  const stratus = _smoothstep(0, 0.07, hL) * _smoothstep(0.38, 0.16, hL);
  const cumulus = _smoothstep(0, 0.18, hL) * _smoothstep(1.0, 0.80, hL);
  const grad = _mix(stratus, cumulus, type);

  const b = sampleVolume3D(
    vols.base, BASE_SIZE,
    (x + wind.x) / BASE_TILE_M, (y + wind.y) / BASE_TILE_M, (z + wind.z) / BASE_TILE_M, scratch.b,
  );
  const lowFbm = b[1] * 0.625 + b[2] * 0.25 + b[3] * 0.125;
  const pw = _remapUnit(b[0], lowFbm - 1, 1);
  let shaped = _remapUnit(pw * grad, 1 - cov, 1);

  if (shaped > 0.001) {
    const d = sampleVolume3D(
      vols.detail, DETAIL_SIZE,
      (x + wind.x * 1.8) / DETAIL_TILE_M, (y + wind.y * 1.8) / DETAIL_TILE_M,
      (z + wind.z * 1.8) / DETAIL_TILE_M, scratch.d,
    );
    const dF = d[0] * 0.625 + d[1] * 0.25 + d[2] * 0.125;
    const dMod = _mix(dF, 1 - dF, _clamp01(hL * 4));
    const erodeH = P.erode * _mix(0.65, 1.35, _clamp01(hL));
    shaped = _remapUnit(shaped, dMod * erodeH, 1);
  }
  return shaped * P.densityMul * denScale;
}

/** Bake everything. Slow (~3 s) — call it from the worker, not the main thread. */
export function bakeAll(seed = 137) {
  return {
    base: bakeBaseVolume(seed),
    detail: bakeDetailVolume(seed ^ 0x5f3a),
    near: bakeNearVolume(seed ^ 0x1d7b),
    weather: bakeWeatherMap(seed ^ 0x77e1),
  };
}
