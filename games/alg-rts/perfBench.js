// PERF BENCH — a repeatable frame-time measurement for this game (DEV tool).
//
//   const { bench } = await import("/games/alg-rts/perfBench.js");
//   await bench("label")
//
// WHY FRAME TIME AT 2x AND NOT THE GPU TIMER. On this machine the GPU
// timestamp panel misattributed the cost (one pass read 16 ms whatever was
// hidden, shadows included), and at 1x the frame sits on the 60 FPS vsync
// line so real savings never show. Rendering at 2x (the engine max) keeps every view above
// the cap, so the median rAF interval IS the frame's cost. Two back-to-back
// runs agreed to 0.15% (2026-09-27).
//
// Seven fixed views over the map's cases — the base, the oasis, the hills,
// a wadi, the ALN heights, the worst spot found (facing the cedar massif) and
// the full zoom-out. `total` = the sum of the seven median frame times (ms at
// 2x); `cpu` = the median time of the engine's own frame callback (ms).
export const VIEWS = [
  ["base", 305, 345, 0.35],
  ["oasis", 132, 128, 0.35],
  ["hills", 0, 0, 0.25],
  ["wadi", 170, 5, 0.25],
  ["aln", -350, -315, 0.35],
  ["mountain", -220, -200, 0.25],
  ["zoomOut", 0, 0, 1.0],
];

const median = (v) => { const s = [...v].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] ?? 0; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const frame = () => new Promise((r) => requestAnimationFrame(r));

/** Time the engine's frame callback (CPU). Installed once. */
function cpuProbe(renderer) {
  const a = renderer._animation;
  if (!a.__probe) {
    const orig = a._animationLoop;
    a.__probe = [];
    a._animationLoop = (...x) => { const s = performance.now(); orig(...x); a.__probe.push(performance.now() - s); };
  }
  return a.__probe;
}

export async function bench(label = "", { scale = 2, settle = 2500, sample = 2500 } = {}) {
  const app = window.__ALG, renderer = window.__V3_DEBUG.renderer;
  const cpu = cpuProbe(renderer);
  const cam = app.rtsCamera;
  if (cam.getMode() !== "rts") cam.toggle();
  const yaw = cam.getView().yaw;
  const rs = app.renderScale;
  app.setRenderScale(scale, { persist: false });
  const views = {};
  for (const [k, x, z, zoom] of VIEWS) {
    cam.focusOn(x, z);
    cam.setZoom(zoom);
    await wait(settle);
    cpu.length = 0;
    const d = [];
    let t = performance.now();
    const end = t + sample;
    while (performance.now() < end) { await frame(); const n = performance.now(); d.push(n - t); t = n; }
    views[k] = { frame: +median(d).toFixed(2), cpu: +median(cpu).toFixed(2) };
  }
  app.setRenderScale(rs, { persist: false });
  cam.setYaw(yaw);
  const total = +Object.values(views).reduce((s, v) => s + v.frame, 0).toFixed(2);
  const cpuTotal = +Object.values(views).reduce((s, v) => s + v.cpu, 0).toFixed(2);
  const res = { label, total, cpuTotal, views, t: new Date().toISOString() };
  (window.__benchLog ??= []).push(res);
  return res;
}

/** One line for the log. */
export const line = (r) => `${r.total} (cpu ${r.cpuTotal}) ` + Object.entries(r.views).map(([k, v]) => `${k}:${v.frame}/${v.cpu}`).join(" ");
