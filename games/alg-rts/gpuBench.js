// GPU BENCH — what each system costs, per view (DEV tool, 2026-10-01 audit).
//
//   const B = await import("/games/alg-rts/gpuBench.js");
//   await B.breakdown()              // per-pass deltas at close / default / max zoom
//   await B.panCost()                // still vs panning at the same views
//   await B.groundCacheAB()          // cache vs the live paint blend, same clock
//   await B.gpuHealth()              // TFLOPS of a fixed kernel vs the best seen (the latch)
//   await B.measureView()            // this view: frame ms, CPU ms, draws, what limits it
//   await B.breakdownHere()          // this view: what each system costs
//
// The Dev panel's Performance section runs the last three.
//
// THE METHOD (memory: ref_v3_perf_measurement_traps, proj_alg_rts_perf_pass).
// rAF sits on the 16.7 ms vsync grid and the GPU timer misattributes passes on
// this laptop, so: stop the loop, render N frames back to back through the
// app's own frame callback (nodeFrame.update() first each time, or every
// shadow map draws once and skips the rest), then onSubmittedWorkDone. The
// wall time / N is the frame's cost (CPU and GPU overlapped, as in play).
// Cases are INTERLEAVED inside every round (the laptop's clock drifts as it
// warms) and each case reports min and mean over rounds. Render scale 2 keeps
// the GPU the limit. A system's cost = frame(all) − frame(system hidden).

import { Fn, Loop, float, instanceIndex, instancedArray } from "three/tsl";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function loopOf(R) {
  const a = R._animation;
  return a._animationLoop;
}

/** Time N frames through the app's own loop. Returns ms per frame. */
export async function timeFrames(n = 24, { perFrame = null } = {}) {
  const R = window.__V3_DEBUG.renderer;
  const loop = loopOf(R);
  const dev = R.backend.device;
  await dev.queue.onSubmittedWorkDone();
  const t0 = performance.now();
  for (let i = 0; i < n; i++) {
    perFrame?.(i);
    R._nodes.nodeFrame.update();
    loop(performance.now());
  }
  await dev.queue.onSubmittedWorkDone();
  return (performance.now() - t0) / n;
}

/** Pause the app's rAF loop while benching (the loop would add frames). */
function pauseLoop() {
  const R = window.__V3_DEBUG.renderer;
  const a = R._animation;
  const saved = a._animationLoop;
  a.stop?.();
  return () => { a.start?.(); a._animationLoop = saved; };
}

// ── Systems that can be hidden ───────────────────────────────────────────────
function byName(pred) {
  return () => window.__ALG.scene.children.filter((c) => c.visible && pred(c.name || "", c));
}
const ANIMALS = /^(Sheep|Goats|Gazelles|Donkeys)/;
export const SYSTEMS = {
  terrain: () => window.__ALG.getTerrainMeshes().filter((m) => m.visible),
  tallPlants: byName((n) => n === "Tall plants"),
  foliage: byName((n) => n === "Foliage"),
  placedFoliage: byName((n) => n === "PlacedFoliage"),
  buildings: byName((n) => n.startsWith("showroom:")),
  units: byName((n) => n.startsWith("Crowd:") || n.startsWith("UnitXray")),
  stones: byName((n) => n === "AlgStones"),
  animals: byName((n) => ANIMALS.test(n)),
  sky: byName((n) => n === "SkyProSkyDome"),
  lakes: byName((n) => n === "Lakes"),
  birds: byName((n) => n.startsWith("RtsBird")),
};

function hide(list) { for (const o of list) o.visible = false; return () => { for (const o of list) o.visible = true; }; }

/** Toggles that are not a visibility flag. */
export const TOGGLES = {
  // Freeze the fitted sun shadow map (bit 0): its draws stop, receivers keep the old map.
  shadowMap: () => { const s = window.__ALG.shadows; s.debugSkipMask(1); return () => s.debugSkipMask(0); },
  post: () => { const p = window.__ALG.postFx; p.setEnabled(false); return () => p.setEnabled(true); },
  // Sky Pro's per-frame work (atmosphere LUTs, cloud trace/resolve/pano, the
  // cloud-shadow quarter, cirrus, env). The sun is fixed in this game, so a
  // skipped update leaves the frame's light unchanged.
  skyUpdate: () => {
    const sp = window.__V3_DEBUG.worldEnv?.skyPro; if (!sp) return () => {};
    const u = sp.update; sp.update = () => {}; return () => { sp.update = u; };
  },
  // The air haze (march + temporal + full-res apply + copy back).
  haze: () => {
    const sp = window.__V3_DEBUG.worldEnv?.skyPro; if (!sp) return () => {};
    const h = sp.params.haze; sp.params.haze = 0; return () => { sp.params.haze = h; };
  },
};

// ── Views ────────────────────────────────────────────────────────────────────
/** zoomT 0 = 28 m, the default 80 m ≈ 0.32, 1 = 190 m. */
export const ZOOMS = { close: 0, default: 0.321, max: 1 };

export async function setView({ x, z, zoom, yaw } = {}) {
  const cam = window.__ALG.rtsCamera;
  if (cam.getMode() !== "rts") cam.toggle();
  if (x != null) cam.focusOn(x, z);
  if (yaw != null) cam.setYaw(yaw);
  if (zoom != null) cam.setZoom(zoom);
  // Let the eased zoom land and the ground cache fill around it.
  const R = window.__V3_DEBUG.renderer, loop = loopOf(R);
  // In small batches with a yield between: right after a render-scale change
  // the resized targets are not on the GPU yet, and a synchronous burst binds
  // them half-made ("reading 'mipLevelCount'").
  for (let i = 0; i < 90; i++) {
    if (i % 10 === 0) { await wait(16); await R.backend.device.queue.onSubmittedWorkDone(); }
    R._nodes.nodeFrame.update(); loop(performance.now());
  }
  await window.__ALG.groundCache?.bakeAll?.(window.__ALG.camera);
  await R.backend.device.queue.onSubmittedWorkDone();
}

const stat = (v) => ({ min: +Math.min(...v).toFixed(2), mean: +(v.reduce((s, x) => s + x, 0) / v.length).toFixed(2) });

/**
 * Interleaved A/B over named cases. `cases` = { name: () => undo }.
 * Returns { name: {min, mean} } plus the base, and each case's delta vs base.
 */
export async function abCases(cases, { rounds = 5, n = 24, settle = 6, perFrame = null, rotate = false } = {}) {
  const names = ["base", ...Object.keys(cases)];
  const res = Object.fromEntries(names.map((k) => [k, []]));
  for (let r = 0; r < rounds; r++) {
    // rotate: each round starts at a different case, so the first-measured
    // penalty (a frame straight out of a pause or a big toggle) is spread.
    const order = rotate ? names.map((_, i) => names[(i + r) % names.length]) : names;
    for (const k of order) {
      const undo = k === "base" ? () => {} : cases[k]();
      await timeFrames(settle, { perFrame });
      res[k].push(await timeFrames(n, { perFrame }));
      undo();
    }
  }
  const out = {};
  for (const k of names) out[k] = stat(res[k]);
  for (const k of names) if (k !== "base") {
    out[k].costMin = +(out.base.min - out[k].min).toFixed(2);
    out[k].costMean = +(out.base.mean - out[k].mean).toFixed(2);
  }
  return out;
}

/** Per-system cost at each zoom, camera still. */
export async function breakdown({ at = null, zooms = ZOOMS, scale = 2, rounds = 4, systems = null } = {}) {
  const app = window.__ALG;
  const rs = app.renderScale;
  app.setRenderScale(scale, { persist: false });
  const resume = pauseLoop();
  const out = {};
  try {
    for (const [zk, zoom] of Object.entries(zooms)) {
      await setView({ ...(at ?? {}), zoom });
      const cases = {};
      for (const [k, get] of Object.entries(SYSTEMS)) {
        if (systems && !systems.includes(k)) continue;
        cases[k] = () => hide(get());
      }
      for (const [k, t] of Object.entries(TOGGLES)) if (!systems || systems.includes(k)) cases[k] = t;
      cases.everything = () => { const u = [hide(app.scene.children.filter((c) => c.visible))]; return () => u.forEach((f) => f()); };
      out[zk] = await abCases(cases, { rounds });
    }
  } finally { resume(); app.setRenderScale(rs, { persist: false }); }
  return out;
}

/** Still vs panning (focus moves at a brisk edge-scroll speed every frame). */
export async function panCost({ zooms = ZOOMS, scale = 2, rounds = 4, speed = 40 } = {}) {
  const app = window.__ALG, cam = app.rtsCamera;
  const rs = app.renderScale;
  app.setRenderScale(scale, { persist: false });
  const resume = pauseLoop();
  const out = {};
  try {
    for (const [zk, zoom] of Object.entries(zooms)) {
      await setView({ zoom });
      const f0 = { ...cam.getView().focus };
      let dir = 1, x = f0.x;
      // 60 Hz frames: `speed` m/s → speed/60 m a frame, back and forth over 60 m.
      const pan = () => { x += dir * speed / 60; if (Math.abs(x - f0.x) > 30) dir = -dir; cam.focusOn(x, f0.z); };
      const still = [], moving = [];
      for (let r = 0; r < rounds; r++) {
        cam.focusOn(f0.x, f0.z); await timeFrames(8);
        still.push(await timeFrames(24));
        await timeFrames(4, { perFrame: pan });
        moving.push(await timeFrames(24, { perFrame: pan }));
      }
      cam.focusOn(f0.x, f0.z);
      out[zk] = { still: stat(still), panning: stat(moving) };
    }
  } finally { resume(); app.setRenderScale(rs, { persist: false }); }
  return out;
}

/** The ground cache vs the live paint blend, swapped in-page (same clock). */
export async function groundCacheAB({ zooms = ZOOMS, scale = 2, rounds = 5 } = {}) {
  const app = window.__ALG, lod = window.__v3TerrainLOD;
  const feats = { cursor: false, snow: false, baseStyle: "flat", riverSand: false, grassFar: false, flowerTint: false };
  const live = lod.mesh.material;
  const blend = (window.__gcBlendMat ??= lod.buildVariant(feats, { groundCache: null }));
  const rs = app.renderScale;
  app.setRenderScale(scale, { persist: false });
  const resume = pauseLoop();
  const out = {};
  try {
    // Compile the blend once, outside the timing.
    lod.setVariant(blend); await timeFrames(4); lod.setVariant(live); await timeFrames(4);
    for (const [zk, zoom] of Object.entries(zooms)) {
      await setView({ zoom });
      out[zk] = await abCases({ liveBlend: () => { lod.setVariant(blend); return () => lod.setVariant(live); } }, { rounds });
    }
  } finally { lod.setVariant(live); resume(); app.setRenderScale(rs, { persist: false }); }
  return out;
}

// ── GPU health: is the clock where it should be? ─────────────────────────────
// THE LATCH (memory: user_msi_thin15_gpu_throttle). This laptop's GPU can sit
// at 780-885 MHz / 15-23 W for no visible reason; every ms measured then reads
// ~2-3x high, and it came back 30 min after an EC reset (2026-10-01). A page
// cannot read the clock, but it can time a fixed kernel: one dependent FMA
// chain per thread, 2^20 threads × 512 steps × 2 FLOP = 1.07 GFLOP a dispatch.
// The rate is compared with the BEST this browser has ever measured (kept in
// localStorage): ~100% healthy, well under that = throttled, numbers not
// comparable with ones taken healthy.
const HEALTH_KEY = "v3.gpuHealth.best.v2";   // v1 held a bogus min-based reading
let _healthKernel = null;
function healthKernel() {
  if (_healthKernel) return _healthKernel;
  const N = 1 << 20, STEPS = 512;
  const out = instancedArray(N, "float");
  const k = Fn(() => {
    const x = float(instanceIndex).mul(1e-7).toVar();
    Loop(STEPS, () => { x.assign(x.mul(0.99991).add(0.00013)); });
    out.element(instanceIndex).assign(x);
  })().compute(N);
  _healthKernel = { k, flop: N * STEPS * 2 };
  return _healthKernel;
}

export async function gpuHealth({ rounds = 5 } = {}) {
  const R = window.__V3_DEBUG.renderer, dev = R.backend.device;
  const { k, flop } = healthKernel();
  await R.computeAsync(k);   // compile
  // The slope between 8 and 40 dispatches: the ~3 ms onSubmittedWorkDone floor
  // cancels (ref_v3_perf_measurement_traps #5). MEDIAN of the rounds, not the
  // min: a difference of two noisy times has noise both ways, and the min
  // read 6.1 TFLOPS on a GPU latched at 780 MHz (impossible) on the first try.
  const run = async (n) => {
    await dev.queue.onSubmittedWorkDone();
    const t = performance.now();
    for (let i = 0; i < n; i++) R.compute(k);
    await dev.queue.onSubmittedWorkDone();
    return performance.now() - t;
  };
  await run(8);   // warm: the clock ramps up from idle
  const per = [];
  for (let r = 0; r < rounds; r++) per.push((await run(40) - await run(8)) / 32);
  per.sort((a, b) => a - b);
  const ms = Math.max(1e-3, per[per.length >> 1]);
  const tflops = flop / (ms * 1e-3) / 1e12;
  let best = 0;
  try { best = Number(localStorage.getItem(HEALTH_KEY)) || 0; } catch { /* private window */ }
  if (tflops > best) { best = tflops; try { localStorage.setItem(HEALTH_KEY, String(best)); } catch { /* */ } }
  const pct = Math.round((tflops / best) * 100);
  const verdict = pct >= 80 ? "healthy" : pct >= 55 ? "slowed (heat?)" : "THROTTLED — ms are not comparable";
  return { tflops: +tflops.toFixed(2), bestSeen: +best.toFixed(2), pct, verdict, msPerDispatch: +ms.toFixed(3) };
}

// ── This view ────────────────────────────────────────────────────────────────
/** Frame cost at the current view: pipelined frame ms, CPU ms, draws, the limit. */
export async function measureView({ rounds = 4, n = 24 } = {}) {
  const R = window.__V3_DEBUG.renderer, dev = R.backend.device, loop = loopOf(R);
  const resume = pauseLoop();
  try {
    await timeFrames(8);
    const frame = [], cpu = [];
    for (let r = 0; r < rounds; r++) {
      frame.push(await timeFrames(n));
      // CPU: the frame callback alone, each frame waited out so a queue that
      // is full does not block it (that wait is GPU time, not CPU).
      for (let i = 0; i < 6; i++) {
        await dev.queue.onSubmittedWorkDone();
        R._nodes.nodeFrame.update();
        const t = performance.now();
        loop(performance.now());
        cpu.push(performance.now() - t);
      }
    }
    cpu.sort((a, b) => a - b);
    const f = stat(frame), c = +cpu[cpu.length >> 1].toFixed(2);
    const draws = R.info.render.drawCalls;
    const limit = c > f.min * 0.85 ? "CPU-bound" : "GPU-bound";
    return { frameMin: f.min, frameMean: f.mean, cpu: c, draws, limit };
  } finally { resume(); }
}

/** What each system costs at the current view (hide it, interleaved). */
export async function breakdownHere({ rounds = 3, onProgress = null } = {}) {
  const resume = pauseLoop();
  try {
    const cases = { "(nothing)": () => () => {} };   // a second base: its gap is the noise
    for (const [k, get] of Object.entries(SYSTEMS)) cases[k] = () => hide(get());
    cases.shadowMap = TOGGLES.shadowMap;
    cases.haze = TOGGLES.haze;
    const names = Object.keys(cases);
    const total = rounds * names.length;
    let done = 0;
    const wrapped = Object.fromEntries(names.map((k) => [k, () => { onProgress?.(++done / total); return cases[k](); }]));
    const r = await abCases(wrapped, { rounds, settle: 8, rotate: true });
    // Nothing hidden, measured twice a round: the gap between the two (and the
    // base's own spread) is what a cost must beat to be a cost.
    const noise = +Math.max(Math.abs(r["(nothing)"].costMin), Math.abs(r["(nothing)"].costMean), r.base.mean - r.base.min).toFixed(2);
    const rows = names.filter((k) => k !== "(nothing)").map((k) => ({ name: k, ms: r[k].costMin })).sort((a, b) => b.ms - a.ms);
    return { frame: r.base.min, noise, rows };
  } finally { resume(); }
}
