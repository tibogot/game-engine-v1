// SIX-WAY LIT SMOKE — bakes the flipbook the lit smoke uses (games/shared-rts
// litSmoke.js). You, 2026-10-02: "can we have better than the flipbook?" —
// the old Explosion01 book has its light PAINTED IN from one side, so it
// never matches the game's sun. A six-way book stores how each frame looks lit
// from +X, -X, +Y, -Y, +Z, -Z, and the shader mixes them with the real sun
// (Unity's "six-way lighting", EmberGen's export): dark undersides, bright
// tops, glowing edges against a low sun.
//
// THE PUFF is procedural, not a fluid sim: a ball that grows fast then slow,
// its edge pushed out and in by low-frequency noise (the billows), filled with
// finer noise that ERODES as it ages (it thins, breaks up, is gone) — the
// noise is sampled in the ball's own expanding frame, so the billows swell
// outward with it. Desert dust is soft and shapeless: the case a procedural
// puff does best.
//
// THE LIGHT: the volume is a voxel grid per frame; light comes along the grid
// axes, so the transmittance to each of the six lights is a running sum along
// a row (no shadow rays). The view is orthographic down -Z (Z toward the
// viewer), composited front to back; the +Z light's shadow IS the view's
// running sum, the -Z one the column's total minus it.
//
// MOTION: the puff's velocity is known exactly (it expands about its centre),
// so each pixel stores where its smoke moves to in the next frame — the shader
// slides both frames along it (motion-vector blending: smooth with 64 frames).
//
// OUTPUT (public/textures/fx/): smoke6_a.webp  RGB = lit from +X (right), +Y
// (top), +Z (front), A = opacity; smoke6_b.webp  RGB = -X, -Y, -Z, A = 1;
// smoke6_mv.webp  RG = motion (0.5 = still, MV_SCALE), B = 0. Lightmaps are
// gamma-encoded (sRGB) to keep the dark side's detail. 8 x 8 frames.
//
//   node tools/bakeSixWaySmoke.mjs [--size 192] [--depth 80] [--workers 6]
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const SMOKE6 = { cols: 8, rows: 8, mvScale: 24 };
const SIGMA = 14;   // extinction per world unit at density 1 (the cell spans 2)

// ── Noise: 3D value noise (Math.imul hash — see ref_js_value_noise_imul) ──
function hash(x, y, z) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x, y, z) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  let fx = x - ix, fy = y - iy, fz = z - iz;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy); fz = fz * fz * (3 - 2 * fz);
  const a = hash(ix, iy, iz), b = hash(ix + 1, iy, iz), c = hash(ix, iy + 1, iz), d = hash(ix + 1, iy + 1, iz);
  const e = hash(ix, iy, iz + 1), f = hash(ix + 1, iy, iz + 1), g = hash(ix, iy + 1, iz + 1), h = hash(ix + 1, iy + 1, iz + 1);
  const x0 = a + (b - a) * fx, x1 = c + (d - c) * fx, x2 = e + (f - e) * fx, x3 = g + (h - g) * fx;
  const y0 = x0 + (x1 - x0) * fy, y1 = x2 + (x3 - x2) * fy;
  return y0 + (y1 - y0) * fz;
}
function fbm(x, y, z, oct) {
  let s = 0, a = 0.5, n = 0;
  for (let o = 0; o < oct; o++) { s += a * vnoise(x, y, z); n += a; x *= 2.03; y *= 2.03; z *= 2.03; a *= 0.5; }
  return s / n;
}

/** The puff's radius and centre at age t (0..1), and dR/dt. */
// A burst: most of the growth in the first third, then a slow spread.
const radius = (t) => 0.34 + 0.3 * (1 - (1 - t) ** 4);
const dRadius = (t) => 0.3 * 4 * (1 - t) ** 3;
const rise = 0.1;   // the centre's climb over the life (in cell units)

/** Density (0..1) at p in the cell ([-1, 1]³), age t. */
function density(px, py, pz, t) {
  const R = radius(t), cy = rise * t;
  // A slow turn about the vertical, so the billows roll rather than only swell.
  const ang = 0.7 * t, ca = Math.cos(ang), sa = Math.sin(ang);
  const x0 = px / R, y = (py - cy) / R, z0 = pz / R;
  const x = x0 * ca - z0 * sa, z = x0 * sa + z0 * ca;
  const r = Math.sqrt(x * x + y * y + z * z);
  if (r > 1.6) return 0;
  // Billows: a few big lumps (the cauliflower) and smaller ones on them, the
  // edge pushed out where they are; flatter underneath (it sits on the air it
  // pushed down).
  const big = fbm(x * 1.25 + 11.3, y * 1.25 + 3.1 - t * 0.5, z * 1.25 + 5.7, 2);
  const small = fbm(x * 3.1 - 2.2, y * 3.1 + 7.7 - t * 0.8, z * 3.1 + 1.9, 2);
  // and the curls on those (the detail the old book had: a cauliflower, not a ball)
  const fine = fbm(x * 7.3 + 3.3, y * 7.3 - t * 1.2, z * 7.3 - 6.1, 2);
  const edge = r - (big - 0.5) * 1.3 - (small - 0.5) * 0.45 - (fine - 0.5) * 0.22 + Math.max(0, -y) * 0.3;
  // Soft-edged (dust, not cotton), and never past the cell: a window at its rim.
  const win = Math.min(1, Math.max(0, (0.97 - Math.max(Math.abs(px), Math.abs(py), Math.abs(pz))) / 0.12));
  const shape = Math.min(1, Math.max(0, (1.0 - edge) / 0.5)) * win;
  if (shape <= 0) return 0;
  // Fill and erosion: soft, low noise; a rising threshold opens holes from the
  // thin parts first and the puff comes apart in wisps, not speckle.
  const n2 = 0.25 * fine + 0.45 * fbm(x * 2.2 - 4.1, y * 2.2 + t * 0.7, z * 2.2 + 8.3, 3) + 0.3 * small;
  const thr = 0.08 + 0.55 * t ** 1.6;
  let d = shape * shape * Math.min(1, Math.max(0, (n2 - thr) / 0.35)) * 1.7;
  d *= 1 / (1 + 1.4 * t);                                   // it thins as it spreads
  const end = Math.min(1, Math.max(0, (t - 0.72) / 0.28));
  d *= 1 - end * end * (3 - 2 * end);                       // and is gone at the end
  return Math.min(1, d);
}

/** One frame: { a: RGBA float, b: RGB float, mv: RG float } of size N². */
function bakeFrame(f, frames, N, D) {
  const t = f / (frames - 1);
  const dx = 2 / N, dz = 2 / D;
  const vol = new Float32Array(N * N * D);   // [z][y][x]
  const idx = (x, y, z) => (z * N + y) * N + x;
  for (let k = 0; k < D; k++) {
    const pz = -1 + (k + 0.5) * dz;
    for (let j = 0; j < N; j++) {
      const py = 1 - (j + 0.5) * dx;          // image rows go DOWN, y goes up
      for (let i = 0; i < N; i++) vol[idx(i, j, k)] = density(-1 + (i + 0.5) * dx, py, pz, t);
    }
  }
  // Optical depth toward each side light, by running sums along X and Y.
  const tauPX = new Float32Array(N * N * D), tauNX = new Float32Array(N * N * D);
  const tauPY = new Float32Array(N * N * D), tauNY = new Float32Array(N * N * D);
  for (let k = 0; k < D; k++) for (let j = 0; j < N; j++) {
    let s = 0;
    for (let i = N - 1; i >= 0; i--) { const d = vol[idx(i, j, k)]; tauPX[idx(i, j, k)] = SIGMA * (s + d * 0.5) * dx; s += d; }
    s = 0;
    for (let i = 0; i < N; i++) { const d = vol[idx(i, j, k)]; tauNX[idx(i, j, k)] = SIGMA * (s + d * 0.5) * dx; s += d; }
  }
  for (let k = 0; k < D; k++) for (let i = 0; i < N; i++) {
    let s = 0;   // +Y light is above: j = 0 is the top row
    for (let j = 0; j < N; j++) { const d = vol[idx(i, j, k)]; tauPY[idx(i, j, k)] = SIGMA * (s + d * 0.5) * dx; s += d; }
    s = 0;
    for (let j = N - 1; j >= 0; j--) { const d = vol[idx(i, j, k)]; tauNY[idx(i, j, k)] = SIGMA * (s + d * 0.5) * dx; s += d; }
  }
  // Lit fraction from an optical depth: single scattering plus a soft
  // multiple-scattering term (thick smoke is not black inside).
  const lit = (tau) => 0.78 * Math.exp(-tau) + 0.22 * Math.exp(-tau * 0.22);

  const R = radius(t), dR = dRadius(t), cy = rise * t, dt = 1 / (frames - 1);
  const a = new Float32Array(N * N * 4), b = new Float32Array(N * N * 3), mv = new Float32Array(N * N * 2);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    let total = 0;
    for (let k = 0; k < D; k++) total += vol[idx(i, j, k)];
    let T = 1, front = 0;
    const C = [0, 0, 0, 0, 0, 0];
    let mx = 0, my = 0;
    const px = -1 + (i + 0.5) * dx, py = 1 - (j + 0.5) * dx;
    for (let k = D - 1; k >= 0; k--) {      // front (z = +1, the viewer's side) to back
      const n = idx(i, j, k), d = vol[n];
      if (d > 0) {
        const al = 1 - Math.exp(-SIGMA * d * dz), w = T * al;
        const tauPZ = SIGMA * (front + d * 0.5) * dz, tauNZ = SIGMA * (total - front - d * 0.5) * dz;
        C[0] += w * lit(tauPX[n]); C[1] += w * lit(tauPY[n]); C[2] += w * lit(tauPZ);
        C[3] += w * lit(tauNX[n]); C[4] += w * lit(tauNY[n]); C[5] += w * lit(tauNZ);
        // velocity: expansion about the centre + the climb (cell units per life)
        mx += w * (dR * px / R); my += w * (dR * (py - cy) / R + rise);
        T *= 1 - al;
        if (T < 0.003) break;
      }
      front += d;
    }
    const alpha = 1 - T, o = (j * N + i);
    const inv = alpha > 1e-4 ? 1 / alpha : 0;
    a[o * 4] = C[0] * inv; a[o * 4 + 1] = C[1] * inv; a[o * 4 + 2] = C[2] * inv; a[o * 4 + 3] = alpha;
    b[o * 3] = C[3] * inv; b[o * 3 + 1] = C[4] * inv; b[o * 3 + 2] = C[5] * inv;
    // uv per frame: the cell's uv spans 2 units; image y down = uv y down? no —
    // stored as WORLD-up motion (+y = up), the shader flips as it needs.
    mv[o * 2] = mx * inv * dt / 2; mv[o * 2 + 1] = my * inv * dt / 2;
  }
  return { a, b, mv };
}

if (!isMainThread) {
  const { frames, N, D, list } = workerData;
  for (const f of list) {
    const r = bakeFrame(f, frames, N, D);
    parentPort.postMessage({ f, ...r }, [r.a.buffer, r.b.buffer, r.mv.buffer]);
  }
} else {
  const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? Number(process.argv[i + 1]) : d; };
  const N = arg("size", 192), D = arg("depth", 80), W = arg("workers", Math.max(1, Math.min(8, os.cpus().length - 1)));
  const { cols, rows, mvScale } = SMOKE6, frames = cols * rows, AW = cols * N, AH = rows * N;
  const A = new Uint8Array(AW * AH * 4), B = new Uint8Array(AW * AH * 4), M = new Uint8Array(AW * AH * 4);
  const enc = (v) => Math.round(255 * Math.min(1, Math.max(0, v)) ** (1 / 2.2));   // sRGB-ish
  const lin = (v) => Math.round(255 * Math.min(1, Math.max(0, v)));
  const t0 = Date.now();
  let done = 0;
  await Promise.all(Array.from({ length: W }, (_, w) => new Promise((res, rej) => {
    const list = [];
    for (let f = w; f < frames; f += W) list.push(f);
    const wk = new Worker(fileURLToPath(import.meta.url), { workerData: { frames, N, D, list } });
    wk.on("message", ({ f, a, b, mv }) => {
      const ox = (f % cols) * N, oy = Math.floor(f / cols) * N;
      for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
        const s = j * N + i, d = ((oy + j) * AW + ox + i) * 4;
        A[d] = enc(a[s * 4]); A[d + 1] = enc(a[s * 4 + 1]); A[d + 2] = enc(a[s * 4 + 2]); A[d + 3] = lin(a[s * 4 + 3]);
        B[d] = enc(b[s * 3]); B[d + 1] = enc(b[s * 3 + 1]); B[d + 2] = enc(b[s * 3 + 2]); B[d + 3] = 255;
        M[d] = lin(0.5 + mv[s * 2] * mvScale); M[d + 1] = lin(0.5 + mv[s * 2 + 1] * mvScale); M[d + 2] = 0; M[d + 3] = 255;
      }
      process.stdout.write(`\r  frames ${++done}/${frames}`);
    });
    wk.on("error", rej);
    wk.on("exit", res);
  })));
  console.log(`\n  baked ${frames} frames of ${N}x${N}x${D} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const out = path.join(root, "public/textures/fx");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "smoke6-"));
  const jobs = [["smoke6_a", A, "RGBA"], ["smoke6_b", B, "RGB"], ["smoke6_mv", M, "RGB"]];
  for (const [name, buf] of jobs) fs.writeFileSync(path.join(tmp, `${name}.raw`), buf);
  // WebP through PIL (no image encoder in node_modules): lossless for the
  // motion (exact values matter), high quality for the light.
  const py = `
import sys
from PIL import Image
w, h, tmp, out = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3], sys.argv[4]
for name, mode, q in [("smoke6_a", "RGBA", 92), ("smoke6_b", "RGB", 92), ("smoke6_mv", "RGB", -1)]:
    im = Image.frombytes("RGBA", (w, h), open(f"{tmp}/{name}.raw", "rb").read())
    if mode == "RGB": im = im.convert("RGB")
    kw = {"lossless": True} if q < 0 else {"quality": q, "method": 6}
    im.save(f"{out}/{name}.webp", "WEBP", **kw)
`;
  const r = spawnSync("python", ["-c", py, String(AW), String(AH), tmp, out], { stdio: "inherit" });
  fs.rmSync(tmp, { recursive: true, force: true });
  if (r.status !== 0) { console.error("python/PIL failed"); process.exit(1); }
  for (const [name] of jobs) console.log(`  ${name}.webp  ${(fs.statSync(path.join(out, `${name}.webp`)).size / 1024).toFixed(0)} KB`);
}
