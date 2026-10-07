// BAKE — a Fire Pro simulation into the game's six-way flipbook (games/shared-rts
// litSmoke.js format), with the flame's own light and the gas's real motion.
//
// The sim is not read voxel by voxel: its own renderer (the ray-march the editor
// shows) is pointed at the bake box with an ORTHOGRAPHIC camera, and the frozen
// frame is drawn several times with only the light changed:
//
//   emission  sun off, the preset's look  → the flame's light (premultiplied) + opacity
//   motion    vendor-patched debug field   → Σ T·α·v: where the visible gas goes (m/s)
//   ±X ±Y ±Z  one white sun along each axis of the CARD's frame (X right, Y up, Z to
//             the viewer), flame dark, smoke albedo white, isotropic → the lit fraction
//
// The render is premultiplied (his material blends One, OneMinusSrcAlpha) into a cleared
// half-float target, so alpha is exactly 1 - transmittance and nothing needs a white pass.
// Every pass renders `ss`× the cell and is box-filtered down (his per-pixel jitter
// averages out).
//
// OUTPUT, as litSmoke reads it (frame 0 top-left, left→right, top→bottom; sRGB light):
//   A  RGB = lit from +X, +Y, +Z   A = opacity
//   B  RGB = lit from -X, -Y, -Z   A = sqrt(emission / emissionMax)   (was unused: 1)
//   M  RG  = motion to the next frame, cell uv × mvScale + 0.5          (lossless)
//      B   = the flame's colour: its green / red (blackbody warmth)
// meta: emissionMax (radiance at a sun of 1), mvScale, fill, timing.
import * as THREE from "three";
import { DataUtils } from "three";
import { FIXED_DT } from "../vendor/fire-pro/src/engine/types.ts";

/** Fire Pro's direct-light factor with isotropic scattering: .35 + phase(=1) × .3. */
const DIRECT = 0.65;
/** Opacity below which a texel holds no light to speak of (filled from its neighbours). */
const EMPTY = 0.004;

let HALF = null;
function toFloat(src) {
  if (src instanceof Float32Array) return src;
  if (src instanceof Uint16Array) {
    if (!HALF) { HALF = new Float32Array(65536); for (let i = 0; i < 65536; i++) HALF[i] = DataUtils.fromHalfFloat(i); }
    const out = new Float32Array(src.length);
    for (let i = 0; i < src.length; i++) out[i] = HALF[src[i]];
    return out;
  }
  return Float32Array.from(src);   // Float16Array where the browser has it
}

const colorString = (v) => (v && typeof v === "object" ? `#${new THREE.Color(v.r, v.g, v.b).getHexString()}` : v);
const srgb8 = (x) => {
  x = Math.min(1, Math.max(0, x));
  const s = x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
  return Math.round(s * 255);
};
const lin8 = (x) => Math.round(Math.min(1, Math.max(0, x)) * 255);
function percentile(values, p) {
  if (!values.length) return 0;
  values.sort((a, b) => a - b);
  return values[Math.min(values.length - 1, Math.floor(p * values.length))];
}

/**
 * Bake `sim` (fresh, its blasts already triggered, in `scene` with nothing else) from
 * its step 0. `opts`: { cell, ss, cols, rows, flipRows }.
 * @returns {Promise<{ W, H, A: Uint8Array, B: Uint8Array, M: Uint8Array, meta }>}
 */
export async function bakeBook({ renderer, scene, sim, preset, opts, beforeStep = () => {}, onProgress = () => {}, cancelled = () => false }) {
  const { cell = 192, ss = 2, cols = 8, rows = 8, flipRows = false } = opts;
  const bake = preset.bake;
  const N = cols * rows, K = bake.loop ? bake.blend : 0, total = N + K;
  const S = bake.size, R = cell * ss;
  const center = new THREE.Vector3(...bake.center);

  // The bake camera: orthographic, looking at the box from `pitch` degrees above the
  // horizon, from +Z. Its basis is the card's frame.
  const pitch = THREE.MathUtils.degToRad(bake.pitch);
  const back = new THREE.Vector3(0, Math.sin(pitch), Math.cos(pitch));
  const camera = new THREE.OrthographicCamera(-S / 2, S / 2, S / 2, -S / 2, 0.01, S * 6);
  camera.position.copy(center).addScaledVector(back, S * 3);
  camera.lookAt(center);
  camera.updateMatrixWorld(true);
  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
  const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
  const axes = [right, up, back, right.clone().negate(), up.clone().negate(), back.clone().negate()];

  const sun = new THREE.DirectionalLight(0xffffff, 0);
  sun.target.position.copy(center);
  scene.add(sun, sun.target);

  const rt = new THREE.RenderTarget(R, R, { type: THREE.HalfFloatType, depthBuffer: true });
  const prevTarget = renderer.getRenderTarget();
  const prevClear = renderer.getClearColor(new THREE.Color());
  const prevAlpha = renderer.getClearAlpha();
  renderer.setClearColor(0x000000, 0);

  const o = sim.getOptions();
  const look = {
    flame: { brightness: o.flame.brightness },
    smoke: { color: colorString(o.smoke.color), scattering: o.smoke.scattering },
  };
  const white = { flame: { brightness: 0 }, smoke: { color: "#ffffff", scattering: 0 } };
  sim.configure({ lighting: { illuminateScene: false }, rendering: { halfResolution: false, raySteps: 512, filter: "cubic" } });

  // One pass: render, read back, box-filter to the cell (premultiplied, top row first).
  const CC = cell * cell;
  async function pass() {
    renderer.setRenderTarget(rt);
    renderer.render(scene, camera);
    const px = toFloat(await renderer.readRenderTargetPixelsAsync(rt, 0, 0, R, R));
    const out = new Float32Array(CC * 4), k = 1 / (ss * ss);
    for (let y = 0; y < R; y++) {
      const srcRow = flipRows ? R - 1 - y : y, oy = (y / ss) | 0;
      for (let x = 0; x < R; x++) {
        const s = (srcRow * R + x) * 4, d = (oy * cell + ((x / ss) | 0)) * 4;
        out[d] += px[s] * k; out[d + 1] += px[s + 1] * k; out[d + 2] += px[s + 2] * k; out[d + 3] += px[s + 3] * k;
      }
    }
    return out;
  }

  const frames = [];
  const dtFrame = bake.duration / N;
  let steps = 0;
  const t0 = performance.now();
  try {
    for (let i = 0; i < total; i++) {
      if (cancelled()) throw new Error("cancelled");
      const target = Math.round((bake.start + i * dtFrame) / FIXED_DT);
      while (steps < target) { beforeStep(steps * FIXED_DT); sim.update(FIXED_DT); steps++; }

      sun.intensity = 0;
      sim.debug({ field: "beauty" });
      const em = await pass();
      sim.debug({ field: "motion" });
      const mo = await pass();
      sim.debug({ field: "beauty" });
      sim.configure(white);
      sun.intensity = 1;
      const lit = [];
      for (const axis of axes) {
        sun.position.copy(center).addScaledVector(axis, S * 3);
        sun.updateMatrixWorld(true);
        const p = await pass();
        const l = new Float32Array(CC);
        for (let j = 0; j < CC; j++) l[j] = (p[j * 4] + p[j * 4 + 1] + p[j * 4 + 2]) / 3 / DIRECT;
        lit.push(l);
      }
      sim.configure(look);
      sun.intensity = 0;

      const f = {
        a: new Float32Array(CC), er: new Float32Array(CC), eg: new Float32Array(CC), e: new Float32Array(CC),
        mx: new Float32Array(CC), my: new Float32Array(CC), lit,
      };
      for (let j = 0; j < CC; j++) {
        f.a[j] = em[j * 4 + 3];
        f.er[j] = em[j * 4]; f.eg[j] = em[j * 4 + 1];
        f.e[j] = 0.2126 * em[j * 4] + 0.7152 * em[j * 4 + 1] + 0.0722 * em[j * 4 + 2];
        const vx = mo[j * 4], vy = mo[j * 4 + 1], vz = mo[j * 4 + 2];
        f.mx[j] = vx * right.x + vy * right.y + vz * right.z;
        f.my[j] = vx * up.x + vy * up.y + vz * up.z;
        // The motion pass's opacity is the beauty's; keep the alpha it was weighted with.
        f.mx[j] *= f.a[j] > 1e-5 ? 1 : 0; f.my[j] *= f.a[j] > 1e-5 ? 1 : 0;
        f.moA ??= new Float32Array(CC); f.moA[j] = mo[j * 4 + 3];
      }
      frames.push(f);
      onProgress(i + 1, total, (performance.now() - t0) / 1000);
    }
  } finally {
    sim.configure(look);
    sim.debug({ field: "beauty" });
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(prevClear, prevAlpha);
    scene.remove(sun, sun.target);
    sun.dispose();
    rt.dispose();
  }

  // A LOOP: the last K frames crossfade into the first, so frame N-1 → frame 0 is the
  // sim's own next step (out[j] = f[j]·j/K + f[j+N]·(1 - j/K) for j < K).
  const book = frames.slice(0, N);
  if (K > 0) {
    for (let j = 0; j < K; j++) {
      const w = j / K, a = frames[j], b = frames[j + N], m = {};
      const mix = (x, y) => { const r = new Float32Array(CC); for (let q = 0; q < CC; q++) r[q] = x[q] * w + y[q] * (1 - w); return r; };
      for (const key of ["a", "er", "eg", "e", "mx", "my", "moA"]) m[key] = mix(a[key], b[key]);
      m.lit = a.lit.map((l, q) => mix(l, b.lit[q]));
      book[j] = m;
    }
  }

  // Ranges over the whole book.
  const eSamples = [], mvSamples = [];
  let reach = 0;
  for (const f of book) {
    for (let j = 0; j < CC; j++) {
      if (f.e[j] > 1e-6) eSamples.push(f.e[j]);
      if (f.moA[j] > 0.05) mvSamples.push(Math.hypot(f.mx[j], f.my[j]) / f.moA[j]);
      if (f.a[j] > 0.02) {
        const x = j % cell, y = (j / cell) | 0;
        reach = Math.max(reach, Math.abs(x + 0.5 - cell / 2), Math.abs(y + 0.5 - cell / 2));
      }
    }
  }
  const emissionMax = Math.max(1e-6, percentile(eSamples, 0.998));
  const speed = percentile(mvSamples, 0.995);                    // m/s
  const mvCell = (speed * dtFrame) / S;                           // cell uv per frame
  const mvScale = Math.min(400, Math.max(4, mvCell > 0 ? 0.48 / mvCell : 400));

  // Unpremultiplied channels, filled outward into the empty texels (bilinear taps and
  // mips at a cloud's edge would otherwise pull in black light and zero motion).
  function fill(values, valid, fallback) {
    const v = values, ok = valid.slice();
    for (let it = 0; it < 12; it++) {
      const next = ok.slice();
      let changed = false;
      for (let j = 0; j < CC; j++) {
        if (ok[j]) continue;
        const x = j % cell, y = (j / cell) | 0;
        let s = 0, n = 0;
        if (x > 0 && ok[j - 1]) { s += v[j - 1]; n++; }
        if (x < cell - 1 && ok[j + 1]) { s += v[j + 1]; n++; }
        if (y > 0 && ok[j - cell]) { s += v[j - cell]; n++; }
        if (y < cell - 1 && ok[j + cell]) { s += v[j + cell]; n++; }
        if (n) { v[j] = s / n; next[j] = 1; changed = true; }
      }
      ok.set(next);
      if (!changed) break;
    }
    for (let j = 0; j < CC; j++) if (!ok[j]) v[j] = fallback;
  }

  const W = cols * cell, H = rows * cell;
  const A = new Uint8Array(W * H * 4), B = new Uint8Array(W * H * 4), M = new Uint8Array(W * H * 4);
  book.forEach((f, idx) => {
    const valid = new Uint8Array(CC), validE = new Uint8Array(CC), validM = new Uint8Array(CC);
    const lit = f.lit.map(() => new Float32Array(CC));
    const mx = new Float32Array(CC), my = new Float32Array(CC), warm = new Float32Array(CC);
    for (let j = 0; j < CC; j++) {
      const a = f.a[j];
      if (a > EMPTY) { valid[j] = 1; for (let q = 0; q < 6; q++) lit[q][j] = f.lit[q][j] / a; }
      if (f.moA[j] > EMPTY) { validM[j] = 1; mx[j] = (f.mx[j] / f.moA[j]) * dtFrame / S; my[j] = (f.my[j] / f.moA[j]) * dtFrame / S; }
      if (f.e[j] > emissionMax * 1e-3 && f.er[j] > 1e-7) { validE[j] = 1; warm[j] = Math.min(1, f.eg[j] / f.er[j]); }
    }
    for (const l of lit) fill(l, valid, 0.5);
    fill(mx, validM, 0); fill(my, validM, 0); fill(warm, validE, 0.35);
    const col = idx % cols, row = (idx / cols) | 0;
    for (let y = 0; y < cell; y++) {
      for (let x = 0; x < cell; x++) {
        const j = y * cell + x, d = ((row * cell + y) * W + col * cell + x) * 4;
        A[d] = srgb8(lit[0][j]); A[d + 1] = srgb8(lit[1][j]); A[d + 2] = srgb8(lit[2][j]); A[d + 3] = lin8(f.a[j]);
        B[d] = srgb8(lit[3][j]); B[d + 1] = srgb8(lit[4][j]); B[d + 2] = srgb8(lit[5][j]);
        B[d + 3] = lin8(Math.sqrt(Math.min(1, f.e[j] / emissionMax)));
        M[d] = lin8(mx[j] * mvScale + 0.5); M[d + 1] = lin8(my[j] * mvScale + 0.5); M[d + 2] = lin8(warm[j]); M[d + 3] = 255;
      }
    }
  });

  return {
    W, H, A, B, M,
    meta: {
      format: "firepro-sixway-1",
      cols, rows, cell, frames: N,
      mvScale: +mvScale.toFixed(3),
      emissionMax: +emissionMax.toPrecision(5),
      /** The cloud's widest reach over the book, as a share of the card. */
      fill: +Math.min(1, (reach * 2) / cell).toFixed(3),
      size: S, pitch: bake.pitch, duration: bake.duration, loop: !!bake.loop,
      /** The sim's smoke albedo (linear): the maps are lit as white, the player tints them. */
      tint: new THREE.Color(look.smoke.color).toArray().map((v) => +v.toFixed(4)),
      seconds: +((performance.now() - t0) / 1000).toFixed(1),
    },
  };
}
