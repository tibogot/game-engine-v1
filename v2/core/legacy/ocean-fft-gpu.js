/**
 * ocean-fft-gpu.js — GPU compute Tessendorf FFT ocean (JONSWAP + Phillips)
 *
 * Same two-cascade spectrum as ocean-fft.js (CPU bake, same seeds — the CPU sim
 * stays the buoyancy sampler and must keep matching), but the per-frame IFFT
 * runs entirely on the GPU via TSL compute shaders.
 *
 * ARCHITECTURE (Poseidon / gasgiant FFT-Ocean pattern):
 *  - Butterfly-table Stockham/Cooley-Tukey IFFT: a CPU-precomputed table holds
 *    (twiddle.re, twiddle.im, indexA, indexB) per step, so every step is a
 *    self-contained kernel with the step index baked in (no uniform pokes
 *    between dispatches).
 *  - 8 real fields ride on 4 complex IFFTs per cascade (A + i·B packing):
 *    DxDz, DyDxz (h + dDz/dx), DyxDyz (height gradient), DxxDzz. Derivatives
 *    are ANALYTIC (ik·h spectra) — no finite-difference pass.
 *  - Batched dispatch: renderer.compute() accepts an array, so each butterfly
 *    step submits ONCE for all cascades × fields. Per update:
 *    1 (time-evolve) + 2·log2(N) (butterfly) + 1 (assemble) ≈ 16 submits
 *    (was ~38 with the uniform-staged pipeline).
 *  - No (-1)^(x+y) permute pass: our spectrum bake is DC-at-index-0 (standard
 *    layout), so the butterfly network's plain inverse DFT is already correct.
 *    (Poseidon needs the permute only because its spectrum is centered.)
 *  - Assemble writes two rgba16f STORAGE TEXTURES per cascade (RepeatWrapping;
 *    mips regenerated explicitly per update — three's compute path doesn't):
 *      displacement = (chop·Dx, h, chop·Dz, turbulence)
 *      derivatives  = (dDy/dx, dDy/dz, chop·dDx/dx, chop·dDz/dz)
 *    The surface shader samples them with hardware (tri)linear filtering —
 *    no more manual bilinear over storage buffers.
 *  - Temporal foam: per-texel turbulence snaps down when the displacement
 *    Jacobian folds (breaking crest) and recovers at `fftFoamDecay`, so
 *    whitecaps linger and dissipate instead of flickering.
 *
 * NOTE: amplitude (uAmp) and choppiness (uChop) are baked into the textures at
 * assemble time; ocean-shader.js multiplies by fftSwellAmp/fftRippleAmp again
 * (historical double-scale — kept for look parity with the tuned params).
 */

import * as THREE from "three";
import {
  Fn, uniform, float, int, uint, uvec2, vec2, vec4,
  instancedArray, storage, instanceIndex, cos, sin, min, max, textureStore,
} from "three/tsl";

const GRAVITY = 9.81;
const TWO_PI = Math.PI * 2;

export const OCEAN_FFT_GPU_DEFAULTS = {
  size: 128, // must be a power of two
  swellTile: 512,
  swellAmp: 1.15,
  rippleTile: 48,
  rippleAmp: 0.55,
  choppiness: 1.28,
  windSpeed: 14,
  jonswapGamma: 3.3,
  windSpreadPow: 8,
  rippleCutoff: 1.2,
  /** Foam recovery rate (lower = whitecaps linger longer). */
  fftFoamDecay: 0.4,
  /**
   * "zelda"   — the original two-cascade JONSWAP+Phillips spectrum (default;
   *             stays in sync with the CPU buoyancy sampler in ocean-fft.js).
   * "horvath" — Poseidon/gasgiant open-ocean spectrum: Horvath 2015 JONSWAP
   *             (fetch-based α/ωp) × TMA depth correction × Donelan-Banner
   *             spreading, local wind-sea + swell components, over
   *             `HORVATH_DEFAULTS.lengthScales` cascades with disjoint
   *             wavenumber bands. NOTE: no CPU mirror — boat buoyancy is wrong
   *             in this mode.
   */
  spectrumMode: "zelda",
};

/** Horvath-mode defaults — values match the Poseidon repo (params.js). */
export const HORVATH_DEFAULTS = {
  lengthScales: [250, 17, 5],
  boundaryFactor: 6,
  depth: 500,
  local: {
    scale: 1.0,
    windSpeed: 16.0,
    windDirection: 45,
    fetch: 100000,
    spreadBlend: 1.0,
    swell: 0.2,
    peakEnhancement: 3.3,
    shortWavesFade: 0.02,
  },
  swell: {
    scale: 0.8,
    windSpeed: 2.0,
    windDirection: 70,
    fetch: 300000,
    spreadBlend: 1.0,
    swell: 1.0,
    peakEnhancement: 3.3,
    shortWavesFade: 0.01,
  },
};

// ─── Spectrum math (mirror of ocean-fft.js — kept local so this module is
//     self-contained for the v2 port) ────────────────────────────────────────
function mulberry32(a) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gaussianPair(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  const r = Math.sqrt(-2 * Math.log(u));
  const t = TWO_PI * v;
  return [r * Math.cos(t), r * Math.sin(t)];
}
function kIndex(i, n) {
  return i < (n >> 1) ? i : i - n;
}
function jonswapSpectrum(kx, kz, windSpeed, windDir, gamma, spreadPow) {
  const kLen = Math.hypot(kx, kz);
  if (kLen < 1e-5) return 0;
  const omega = Math.sqrt(GRAVITY * kLen);
  const U = Math.max(windSpeed, 0.5);
  const omegaP = (TWO_PI * 0.13 * GRAVITY) / U;
  const alpha = 0.0081;
  const sigma = omega <= omegaP ? 0.07 : 0.09;
  const r = Math.exp(-((omega - omegaP) ** 2) / (2 * sigma * sigma * omegaP * omegaP + 1e-8));
  const S = alpha * GRAVITY * GRAVITY * omega ** -5
    * Math.exp(-1.25 * (omegaP / omega) ** 4)
    * gamma ** r;
  const theta = Math.atan2(kz, kx);
  let dTheta = theta - windDir;
  while (dTheta > Math.PI) dTheta -= TWO_PI;
  while (dTheta < -Math.PI) dTheta += TWO_PI;
  if (Math.abs(dTheta) >= Math.PI * 0.5) return 0;
  const spread = Math.max(0, Math.cos(dTheta * 0.5)) ** spreadPow;
  return (S / kLen) * spread * (2 / Math.PI);
}
function phillipsSpectrum(kx, kz, windSpeed, windDir, L, cutoff) {
  const kLen = Math.hypot(kx, kz);
  if (kLen < 1e-5) return 0;
  const kMin = TWO_PI / L;
  if (kLen < kMin * cutoff) return 0;
  const kMax = kMin * 48;
  if (kLen > kMax) return 0;
  const kDotW = (kx * Math.cos(windDir) + kz * Math.sin(windDir)) / kLen;
  const dir = kDotW * kDotW;
  const A = 0.00008 * windSpeed * windSpeed;
  return (A * Math.exp(-1 / (kLen * L) ** 2)) / kLen ** 4 * dir;
}

// ─── Horvath 2015 spectrum (exact JS port of Poseidon/gasgiant spectrum.js) ──
// JONSWAP with fetch-based α/ωp × TMA depth correction × Donelan-Banner
// directional spreading × short-wave fade, summed over a local wind-sea set
// and a swell set. Returns the per-texel h0 AMPLITUDE (Poseidon calibration:
// sqrt(2·S·D·|dω/dk| / k · Δk²)) — multiply by the complex Gaussian noise.
function hvFrequency(k, g, depth) {
  return Math.sqrt(g * k * Math.tanh(Math.min(k * depth, 20)));
}
function hvFrequencyDerivative(k, g, depth) {
  const th = Math.tanh(Math.min(k * depth, 20));
  const ch = Math.cosh(Math.min(k * depth, 20));
  return (g * ((depth * k) / (ch * ch) + th)) / hvFrequency(k, g, depth) / 2;
}
function hvNormalisationFactor(s) {
  const s2 = s * s, s3 = s2 * s, s4 = s3 * s;
  if (s < 5) return -0.000564 * s4 + 0.00776 * s3 - 0.044 * s2 + 0.192 * s + 0.163;
  return -4.8e-8 * s4 + 1.07e-5 * s3 - 9.53e-4 * s2 + 5.9e-2 * s + 3.93e-1;
}
function hvCosine2s(theta, s) {
  return hvNormalisationFactor(s) * Math.abs(Math.cos(theta * 0.5)) ** (s * 2);
}
function hvSpreadPower(omega, peakOmega) {
  const r = omega / peakOmega;
  return omega > peakOmega
    ? 9.77 * Math.abs(r) ** -2.5
    : 6.97 * Math.abs(r) ** 5;
}
function hvDirectionSpectrum(theta, omega, p) {
  const s = hvSpreadPower(omega, p.peakOmega)
    + 16 * Math.tanh(Math.min(omega / p.peakOmega, 20)) * p.swell * p.swell;
  const base = Math.cos(theta) ** 2 * (2 / Math.PI);
  return base + (hvCosine2s(theta - p.angle, s) - base) * p.spreadBlend;
}
function hvTmaCorrection(omega, g, depth) {
  const omegaH = omega * Math.sqrt(depth / g);
  if (omegaH <= 1) return 0.5 * omegaH * omegaH;
  if (omegaH < 2) { const t = 2 - omegaH; return 1 - 0.5 * t * t; }
  return 1;
}
function hvJonswap(omega, g, depth, p) {
  const sigma = omega <= p.peakOmega ? 0.07 : 0.09;
  const dw = omega - p.peakOmega;
  const r = Math.exp(-(dw * dw) / (2 * sigma * sigma * p.peakOmega * p.peakOmega));
  return p.scale
    * hvTmaCorrection(omega, g, depth)
    * p.alpha * g * g
    * omega ** -5
    * Math.exp(-1.25 * (p.peakOmega / omega) ** 4)
    * p.gamma ** r;
}
function hvShortWavesFade(kLen, p) {
  return Math.exp(-p.shortWavesFade * p.shortWavesFade * kLen * kLen);
}
/** Derived per-set params (Poseidon fillSet). */
function hvParamSet(d, g) {
  return {
    scale: d.scale,
    angle: (d.windDirection * Math.PI) / 180,
    spreadBlend: d.spreadBlend,
    swell: Math.min(Math.max(d.swell, 0.01), 1),
    alpha: 0.076 * Math.pow((g * d.fetch) / (d.windSpeed * d.windSpeed), -0.22),
    peakOmega: 22 * Math.pow((d.windSpeed * d.fetch) / (g * g), -0.33),
    gamma: d.peakEnhancement,
    shortWavesFade: d.shortWavesFade,
  };
}
/** h0 amplitude at (kx, kz) for one cascade band [cutLow, cutHigh]. */
function horvathAmplitude(kx, kz, deltaK, cutLow, cutHigh, hv) {
  const kLen = Math.hypot(kx, kz);
  if (kLen < cutLow || kLen > cutHigh) return 0;
  const g = GRAVITY;
  const kSafe = Math.max(kLen, cutLow);
  const theta = Math.atan2(kz, kx + 1e-9);
  const omega = hvFrequency(kSafe, g, hv.depth);
  const dOmega = hvFrequencyDerivative(kSafe, g, hv.depth);
  const spectrum =
    hvJonswap(omega, g, hv.depth, hv._local)
      * hvDirectionSpectrum(theta, omega, hv._local)
      * hvShortWavesFade(kSafe, hv._local)
    + hvJonswap(omega, g, hv.depth, hv._swell)
      * hvDirectionSpectrum(theta, omega, hv._swell)
      * hvShortWavesFade(kSafe, hv._swell);
  return Math.sqrt(((spectrum * 2 * Math.abs(dOmega)) / kSafe) * deltaK * deltaK);
}

// ─── Butterfly table (gasgiant/FFT-Ocean via Poseidon, MIT) ──────────────────
// For each step and output column: (twiddle.re, twiddle.im, inputA, inputB).
// Forward twiddles; the kernels conjugate them for the inverse transform.
function fillButterfly(array, N) {
  const logN = Math.log2(N);
  for (let step = 0; step < logN; step++) {
    const b = N >> (step + 1);
    for (let j = 0; j < N / 2; j++) {
      const i = (2 * b * Math.floor(j / b) + (j % b)) % N;
      const X = Math.floor(j / b) * b;
      const twRe = Math.cos((2 * Math.PI * X) / N);
      const twIm = -Math.sin((2 * Math.PI * X) / N);
      const put = (col, re, im) => {
        const o = (step * N + col) * 4;
        array[o] = re; array[o + 1] = im; array[o + 2] = i; array[o + 3] = i + b;
      };
      put(j, twRe, twIm);
      put(j + N / 2, -twRe, -twIm);
    }
  }
}

// ─── TSL helpers ─────────────────────────────────────────────────────────────
const cMul = Fn(([a, b]) =>
  vec2(a.x.mul(b.x).sub(a.y.mul(b.y)), a.x.mul(b.y).add(a.y.mul(b.x))),
);

// rgba16f storage texture: filterable (bilinear) AND storage-capable, tiling
// via RepeatWrapping, mipmapped after each compute write.
function makeMapTexture(N, label) {
  const tex = new THREE.StorageTexture(N, N);
  tex.name = label;
  tex.type = THREE.HalfFloatType;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  return tex;
}

/**
 * @param {object} opts
 * @param {THREE.WebGPURenderer} opts.renderer
 */
export function createOceanFFTGPUSimulation(opts = {}) {
  const cfg = { ...OCEAN_FFT_GPU_DEFAULTS, ...opts };
  const renderer = cfg.renderer;
  const N = cfg.size;
  const LOG2N = Math.log2(N) | 0;
  const COUNT = N * N;
  const invN2 = 1 / (N * N);

  let windSpeed = cfg.windSpeed;
  let windDirRad = (cfg.windAngleDeg ?? 38) * (Math.PI / 180);
  let gamma = cfg.jonswapGamma;
  let spreadPow = cfg.windSpreadPow;

  const uTime = uniform(0);
  const uDt = uniform(1 / 30);
  const uFoamDecay = uniform(cfg.fftFoamDecay);
  let lastSimTime = -1;

  // Shared butterfly table (twiddles + pair indices per step).
  const bfAttr = new THREE.StorageInstancedBufferAttribute(
    new Float32Array(LOG2N * N * 4), 4,
  );
  fillButterfly(bfAttr.array, N);
  const bfBuf = storage(bfAttr, "vec4", LOG2N * N);

  // One butterfly step along rows (axis 0) or columns (axis 1). The step index
  // is baked into the kernel, so independent fields can share one submit.
  function makeStep(src, dst, s, axis) {
    return Fn(() => {
      const id = instanceIndex;
      const x = id.mod(uint(N));
      const y = id.div(uint(N));
      const line = axis === 0 ? x : y;
      const data = bfBuf.element(uint(s * N).add(line));
      const tw = vec2(data.x, data.y.negate()); // conjugate → inverse
      const a = axis === 0
        ? src.element(y.mul(N).add(uint(int(data.z))))
        : src.element(uint(int(data.z)).mul(N).add(x));
      const b = axis === 0
        ? src.element(y.mul(N).add(uint(int(data.w))))
        : src.element(uint(int(data.w)).mul(N).add(x));
      dst.element(id).assign(a.add(cMul(tw, b)));
    })().compute(COUNT);
  }

  // Full 2D inverse-FFT kernel chain for one complex field: 2·log2(N) steps
  // ping-ponging field ↔ scratch. 2·log2(N) is even, so the result lands back
  // in `field`. Returns kernels ordered by global step index.
  function buildFieldFFT(field, scratch) {
    const steps = [];
    for (let t = 0; t < LOG2N * 2; t++) {
      const axis = t < LOG2N ? 0 : 1;
      const s = axis === 0 ? t : t - LOG2N;
      const src = t % 2 === 0 ? field : scratch;
      const dst = t % 2 === 0 ? scratch : field;
      steps.push(makeStep(src, dst, s, axis));
    }
    return steps;
  }

  // ── Per-cascade state + kernels ──────────────────────────────────────────
  // `norm` rescales the raw butterfly output in assemble. The zelda calibration
  // (sqrt(P/2)·tile/8) was tuned WITH 1/N²; the Horvath amplitude
  // (sqrt(2·S·D·|dω/dk|/k·Δk²)) is calibrated for the UNNORMALIZED Tessendorf
  // synthesis sum (Poseidon's fft.js: "no 1/N² scaling") → norm = 1.
  function makeCascade({ tileSize, label, choppinessScale, norm = invN2 }) {
    // CPU-baked spectrum: h0 = (h0(k), conj(h0(-k))), kom = (kx, 1/|k|, kz, ω).
    const h0Attr = new THREE.StorageInstancedBufferAttribute(new Float32Array(COUNT * 4), 4);
    const komAttr = new THREE.StorageInstancedBufferAttribute(new Float32Array(COUNT * 4), 4);
    const h0Buf = storage(h0Attr, "vec4", COUNT);
    const komBuf = storage(komAttr, "vec4", COUNT);

    // Packed time-dependent spectra — the four complex IFFT inputs (8 real
    // fields). Each gets its own scratch so all steps can share one submit.
    const fields = {
      DxDz: instancedArray(COUNT, "vec2"),   // (Dx, Dz)
      DyDxz: instancedArray(COUNT, "vec2"),  // (h, dDz/dx)
      DyxDyz: instancedArray(COUNT, "vec2"), // (dDy/dx, dDy/dz)
      DxxDzz: instancedArray(COUNT, "vec2"), // (dDx/dx, dDz/dz)
    };
    const fieldFFTs = Object.values(fields).map((f) =>
      buildFieldFFT(f, instancedArray(COUNT, "vec2")),
    );

    // Sampled output maps + persistent foam turbulence.
    const dispTex = makeMapTexture(N, `oceanDisp_${label}`);
    const derivTex = makeMapTexture(N, `oceanDeriv_${label}`);
    const turbBuf = instancedArray(COUNT, "float");
    turbBuf.value.array.fill(1.0); // start un-foamed (flat Jacobian)
    turbBuf.value.needsUpdate = true;

    const uAmp = uniform(1);
    const uChop = uniform(cfg.choppiness * choppinessScale);

    // Time-evolve the spectrum and build the 4 packed complex spectra.
    // Sign convention: Poseidon/gasgiant verbatim — disp = +i·k̂·h with negated
    // second derivatives. Through this IFFT that PINCHES crests for λ > 0
    // (the −i packing we used historically rounds crests = anti-chop).
    // NOTE: the CPU buoyancy sim (ocean-fft.js) still uses the old sign for
    // horizontal displacement — re-sync it before reviving the boat.
    const timeDep = Fn(() => {
      const idx = instanceIndex;
      const kom = komBuf.element(idx); // (kx, 1/|k|, kz, omega)
      const kx = kom.x, invK = kom.y, kz = kom.z;
      const phase = kom.w.mul(uTime);
      const ex = vec2(cos(phase), sin(phase));
      const h0v = h0Buf.element(idx);
      const h = cMul(h0v.xy, ex).add(cMul(h0v.zw, vec2(ex.x, ex.y.negate())));
      const ih = vec2(h.y.negate(), h.x); // i·h

      const dispX = ih.mul(kx).mul(invK);
      const dispZ = ih.mul(kz).mul(invK);
      const dispYdx = ih.mul(kx);
      const dispYdz = ih.mul(kz);
      const dispXdx = h.mul(kx).mul(kx).mul(invK).negate();
      const dispZdz = h.mul(kz).mul(kz).mul(invK).negate();
      const dispZdx = h.mul(kx).mul(kz).mul(invK).negate();

      fields.DxDz.element(idx).assign(vec2(dispX.x.sub(dispZ.y), dispX.y.add(dispZ.x)));
      fields.DyDxz.element(idx).assign(vec2(h.x.sub(dispZdx.y), h.y.add(dispZdx.x)));
      fields.DyxDyz.element(idx).assign(vec2(dispYdx.x.sub(dispYdz.y), dispYdx.y.add(dispYdz.x)));
      fields.DxxDzz.element(idx).assign(vec2(dispXdx.x.sub(dispZdz.y), dispXdx.y.add(dispZdz.x)));
    })().compute(COUNT);

    // Normalise (stages don't divide by N²), scale, fold the Jacobian foam
    // accumulator, and pack everything into the two sampled maps.
    const assemble = Fn(() => {
      const idx = instanceIndex;
      const coord = uvec2(idx.mod(uint(N)), idx.div(uint(N)));
      const s = float(norm).mul(uAmp);
      const dxz = fields.DxDz.element(idx).mul(s);   // (Dx, Dz)
      const hxz = fields.DyDxz.element(idx).mul(s);  // (h, dDz/dx)
      const dyd = fields.DyxDyz.element(idx).mul(s); // (dDy/dx, dDy/dz)
      const dd = fields.DxxDzz.element(idx).mul(s);  // (dDx/dx, dDz/dz)

      const jxx = float(1).add(uChop.mul(dd.x));
      const jzz = float(1).add(uChop.mul(dd.y));
      const jxz = uChop.mul(hxz.y);
      const J = jxx.mul(jzz).sub(jxz.mul(jxz));

      // Snap down on a fold (foam appears with the crash), then recover slowly
      // toward 1 so whitecaps linger and dissipate instead of flickering.
      const prev = turbBuf.element(idx);
      const turb = min(J, prev.add(uDt.mul(uFoamDecay).div(max(J, float(0.5)))));
      turbBuf.element(idx).assign(turb);

      textureStore(dispTex, coord,
        vec4(dxz.x.mul(uChop), hxz.x, dxz.y.mul(uChop), turb)).toWriteOnly();
      textureStore(derivTex, coord,
        vec4(dyd.x, dyd.y, dd.x.mul(uChop), dd.y.mul(uChop))).toWriteOnly();
    })().compute(COUNT);

    const cascade = {
      tileSize, label,
      amp: 1,
      choppiness: cfg.choppiness * choppinessScale,
      h0Attr, komAttr, uAmp, uChop,
      dispTex, derivTex,
      timeDep, assemble, fieldFFTs,
    };

    // CPU-side spectrum bake into the storage attributes. `ampFn(kx,kz)` is the
    // h0 AMPLITUDE; `omegaFn(k)` the dispersion (deep-water default).
    cascade.bakeSpectrum = (ampFn, seed, omegaFn) => {
      const rng = mulberry32(seed >>> 0);
      const h0 = h0Attr.array, kom = komAttr.array;
      h0.fill(0); kom.fill(0);
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          const kx = (TWO_PI * kIndex(i, N)) / tileSize;
          const kz = (TWO_PI * kIndex(j, N)) / tileSize;
          const idx = j * N + i;
          const kLen = Math.hypot(kx, kz);
          if (kLen > 1e-6) {
            kom[idx * 4] = kx;
            kom[idx * 4 + 1] = 1 / kLen;
            kom[idx * 4 + 2] = kz;
            kom[idx * 4 + 3] = omegaFn ? omegaFn(kLen) : Math.sqrt(GRAVITY * kLen);
          }
          const A = ampFn(kx, kz);
          if (A <= 0) continue;
          const [gr, gi] = gaussianPair(rng);
          h0[idx * 4] = gr * A;
          h0[idx * 4 + 1] = gi * A;
        }
      }
      // zw = conj(h0(-k)) — mirror pass after all h0 values exist.
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          const oi = (N - i) % N, oj = (N - j) % N;
          const idx = j * N + i, oidx = oj * N + oi;
          h0[idx * 4 + 2] = h0[oidx * 4];
          h0[idx * 4 + 3] = -h0[oidx * 4 + 1];
        }
      }
      h0[0] = h0[1] = h0[2] = h0[3] = 0;
      h0Attr.needsUpdate = true;
      komAttr.needsUpdate = true;
    };

    return cascade;
  }

  // ── Cascade set — mode-dependent ─────────────────────────────────────────
  const mode = cfg.spectrumMode ?? "zelda";
  // Horvath state (mutable so the wind sliders can re-derive the param sets).
  const hv = structuredClone({ ...HORVATH_DEFAULTS, ...(cfg.horvath || {}) });
  const deriveHv = () => {
    hv._local = hvParamSet(hv.local, GRAVITY);
    hv._swell = hvParamSet(hv.swell, GRAVITY);
  };
  deriveHv();

  let cascades;
  if (mode === "horvath") {
    // Disjoint wavenumber bands (Poseidon): hand-off between cascade i-1 and i
    // at 2π/L_i × boundaryFactor. Amplitude comes entirely from the spectrum
    // (uAmp stays 1); one shared choppiness.
    cascades = hv.lengthScales.map((L, i) =>
      makeCascade({ tileSize: L, label: `c${i}`, choppinessScale: 1, norm: 1 }),
    );
  } else {
    const sw = makeCascade({ tileSize: cfg.swellTile, label: "swell", choppinessScale: 1 });
    const ri = makeCascade({ tileSize: cfg.rippleTile, label: "ripple", choppinessScale: 0.85 });
    sw.amp = cfg.swellAmp; sw.uAmp.value = cfg.swellAmp;
    ri.amp = cfg.rippleAmp; ri.uAmp.value = cfg.rippleAmp;
    cascades = [sw, ri];
  }
  // Back-compat aliases (ocean-shader / hosts historically address these two).
  const swell = cascades[0];
  const ripple = cascades[cascades.length - 1];

  // ── Batched dispatch groups: one renderer.compute() per step for ALL
  //    cascades × fields (each compute() is a separate submit — the barrier).
  const timeDepGroup = cascades.map((c) => c.timeDep);
  const assembleGroup = cascades.map((c) => c.assemble);
  const stepGroups = [];
  for (let t = 0; t < LOG2N * 2; t++) {
    const group = [];
    for (const c of cascades) for (const f of c.fieldFFTs) group.push(f[t]);
    stepGroups.push(group);
  }

  function rebuildSpectra(seed = 1337) {
    if (mode === "horvath") {
      deriveHv();
      const boundary = (i) => ((2 * Math.PI) / hv.lengthScales[i]) * hv.boundaryFactor;
      const last = cascades.length - 1;
      const omegaFn = (k) => hvFrequency(k, GRAVITY, hv.depth);
      cascades.forEach((c, i) => {
        const cutLow = i === 0 ? 1e-4 : boundary(i);
        const cutHigh = i === last ? 9999 : boundary(i + 1);
        const deltaK = (2 * Math.PI) / c.tileSize;
        c.bakeSpectrum(
          (kx, kz) => horvathAmplitude(kx, kz, deltaK, cutLow, cutHigh, hv),
          seed + i * 4099,
          omegaFn,
        );
      });
      return;
    }
    // zelda mode — amplitude = sqrt(P/2)·(tile/8), exactly the historical bake
    // (and the CPU buoyancy sampler's calibration in ocean-fft.js).
    cascades[0].bakeSpectrum(
      (kx, kz) => {
        const P = jonswapSpectrum(kx, kz, windSpeed, windDirRad, gamma, spreadPow);
        return P <= 0 ? 0 : Math.sqrt(P * 0.5) * (cascades[0].tileSize / 8);
      },
      seed,
    );
    cascades[1].bakeSpectrum(
      (kx, kz) => {
        const P = phillipsSpectrum(kx, kz, windSpeed, windDirRad, cfg.rippleTile, cfg.rippleCutoff);
        return P <= 0 ? 0 : Math.sqrt(P * 0.5) * (cascades[1].tileSize / 8);
      },
      seed + 4099,
    );
  }
  rebuildSpectra(cfg.seed ?? 1337);

  return {
    swell,
    ripple,
    cascades,
    spectrumMode: mode,
    isGPU: true,

    /** Run the FFT compute for this frame (1 + 2·log2(N) + 1 submits). */
    update(time) {
      uTime.value = time;
      // Foam accumulation timestep = actual sim interval (the host throttles).
      uDt.value = lastSimTime >= 0
        ? Math.min(Math.max(time - lastSimTime, 0), 0.25)
        : 1 / 30;
      lastSimTime = time;
      renderer.compute(timeDepGroup);
      for (const group of stepGroups) renderer.compute(group);
      renderer.compute(assembleGroup);
      // three does NOT regenerate storage-texture mips after compute writes —
      // fill the chain explicitly or far fragments sample empty (black) mips.
      // Runs at the throttled sim rate, not per rendered frame.
      for (const c of cascades) {
        renderer.backend.generateMipmaps(c.dispTex);
        renderer.backend.generateMipmaps(c.derivTex);
      }
    },

    syncParams(p) {
      if (!p) return;
      let rebuild = false;
      if (p.windSpeed != null) {
        windSpeed = p.windSpeed;
        hv.local.windSpeed = p.windSpeed; // horvath: wind slider drives the local sea
        rebuild = true;
      }
      if (p.windAngleDeg != null) {
        windDirRad = p.windAngleDeg * (Math.PI / 180);
        hv.local.windDirection = p.windAngleDeg;
        rebuild = true;
      }
      if (p.jonswapGamma != null) { gamma = p.jonswapGamma; hv.local.peakEnhancement = p.jonswapGamma; rebuild = true; }
      if (p.windSpreadPow != null) { spreadPow = p.windSpreadPow; rebuild = true; }
      if (mode === "zelda") {
        if (p.fftSwellAmp != null) { swell.amp = p.fftSwellAmp; swell.uAmp.value = p.fftSwellAmp; }
        if (p.fftRippleAmp != null) { ripple.amp = p.fftRippleAmp; ripple.uAmp.value = p.fftRippleAmp; }
      }
      if (p.fftChoppiness != null) {
        cascades.forEach((c, i) => {
          // zelda keeps the historical 0.85 ripple scale; horvath = uniform λ.
          const scale = mode === "zelda" && i === cascades.length - 1 ? 0.85 : 1;
          c.choppiness = p.fftChoppiness * scale;
          c.uChop.value = p.fftChoppiness * scale;
        });
      }
      if (p.fftFoamDecay != null) uFoamDecay.value = p.fftFoamDecay;
      if (p.fftSeed != null) rebuildSpectra(p.fftSeed | 0);
      else if (rebuild) rebuildSpectra(p.seed ?? 1337);
    },

    rebuildSpectra,
    dispose() {
      for (const c of cascades) {
        c.dispTex.dispose();
        c.derivTex.dispose();
      }
    },
  };
}

/**
 * Isolation test for the butterfly IFFT with our DC-at-index-0 spectrum layout
 * (no permute pass). Inverse-transforms two known spectra and compares against
 * the analytic spatial result. Dev-only — call from the lab via ?fftcheck=1.
 * @returns {Promise<{pass: boolean, err1: number, err2: number}>}
 */
export async function validateOceanFFTGPU(renderer, N = 128) {
  const LOG2N = Math.log2(N) | 0;
  const COUNT = N * N;
  const bfAttr = new THREE.StorageInstancedBufferAttribute(
    new Float32Array(LOG2N * N * 4), 4,
  );
  fillButterfly(bfAttr.array, N);
  const bfBuf = storage(bfAttr, "vec4", LOG2N * N);

  async function ifftOf(fill) {
    const field = instancedArray(COUNT, "vec2");
    const scratch = instancedArray(COUNT, "vec2");
    const steps = [];
    for (let t = 0; t < LOG2N * 2; t++) {
      const axis = t < LOG2N ? 0 : 1;
      const s = axis === 0 ? t : t - LOG2N;
      const src = t % 2 === 0 ? field : scratch;
      const dst = t % 2 === 0 ? scratch : field;
      steps.push(Fn(() => {
        const id = instanceIndex;
        const x = id.mod(uint(N));
        const y = id.div(uint(N));
        const line = axis === 0 ? x : y;
        const data = bfBuf.element(uint(s * N).add(line));
        const tw = vec2(data.x, data.y.negate());
        const a = axis === 0
          ? src.element(y.mul(N).add(uint(int(data.z))))
          : src.element(uint(int(data.z)).mul(N).add(x));
        const b = axis === 0
          ? src.element(y.mul(N).add(uint(int(data.w))))
          : src.element(uint(int(data.w)).mul(N).add(x));
        dst.element(id).assign(a.add(cMul(tw, b)));
      })().compute(COUNT));
    }
    fill(field.value.array);
    field.value.needsUpdate = true;
    for (const s of steps) await renderer.computeAsync(s);
    return new Float32Array(await renderer.getArrayBufferAsync(field.value));
  }

  // Test 1: impulse at DC (0,0) -> constant (1, 0) everywhere.
  const r1 = await ifftOf((a) => { a.fill(0); a[0] = 1; });
  let err1 = 0;
  for (let i = 0; i < COUNT; i++) {
    err1 = Math.max(err1, Math.abs(r1[i * 2] - 1), Math.abs(r1[i * 2 + 1]));
  }

  // Test 2: impulse at k=(1,0) -> ( cos(2πx/N), sin(2πx/N) ).
  const r2 = await ifftOf((a) => { a.fill(0); a[2] = 1; });
  let err2 = 0;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const o = (y * N + x) * 2;
      err2 = Math.max(
        err2,
        Math.abs(r2[o] - Math.cos((2 * Math.PI * x) / N)),
        Math.abs(r2[o + 1] - Math.sin((2 * Math.PI * x) / N)),
      );
    }
  }

  return { pass: err1 < 1e-3 && err2 < 1e-3, err1, err2 };
}
