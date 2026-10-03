// THE PERF LINE (you, 2026-10-03: "our own perf stats ui"): one line, top
// left, where the stats-gl overlay sat. stats-gl wrapped every render and drew
// canvas graphs each frame (0.4-0.8 ms a frame, measured); this reads the
// engine's own counters (app.takeFrameStats) twice a second, off the frame.
//
//   FRAME  the rAF interval — vsync holds it at 16.7 while there is headroom
//   CPU    the loop's own work (sim, HUD, render submission); max = worst frame
//   draws  the last frame's draw calls
//   GPU    on click: measureFrame (below) — N frames back to back, the honest
//          frame cost and what limits it (pauses the game ~1 s)
//
// ?perf=0 hides it; Dev → Performance toggles it.

/**
 * The frame's real cost here (alg-rts gpuBench.measureView's method, game-
 * independent): the loop paused, N frames rendered back to back through the
 * app's own frame callback (nodeFrame.update first, or shadow maps draw once),
 * then onSubmittedWorkDone — wall time / N, CPU and GPU overlapped as in play.
 * CPU: the callback alone, each frame waited out. Pauses the game ~1 s.
 */
async function measureFrame(R, { rounds = 3, n = 24 } = {}) {
  const a = R._animation, loop = a._animationLoop, dev = R.backend.device;
  a.stop?.();
  try {
    const frame = () => { R._nodes.nodeFrame.update(); loop(performance.now()); };
    for (let i = 0; i < 8; i++) frame();
    const frames = [], cpu = [];
    for (let r = 0; r < rounds; r++) {
      await dev.queue.onSubmittedWorkDone();
      const t0 = performance.now();
      for (let i = 0; i < n; i++) frame();
      await dev.queue.onSubmittedWorkDone();
      frames.push((performance.now() - t0) / n);
      for (let i = 0; i < 6; i++) {
        await dev.queue.onSubmittedWorkDone();
        const t = performance.now(); frame(); cpu.push(performance.now() - t);
      }
    }
    cpu.sort((x, y) => x - y);
    const frameMin = Math.min(...frames), c = cpu[cpu.length >> 1];
    return { frameMin, cpu: c, limit: c > frameMin * 0.85 ? "CPU-bound" : "GPU-bound" };
  } finally { a.start?.(); a._animationLoop = loop; }
}

export function createPerfHud(app, { mount = document.body, visible = true } = {}) {
  const el = document.createElement("div");
  el.className = "alg-perf";
  const style = document.createElement("style");
  style.textContent = `
.alg-perf { position: fixed; left: 8px; top: 6px; z-index: 60; display: grid; grid-template-columns: auto auto; gap: 4px 8px; align-items: center;
  font: 600 11px/1 ui-monospace, Consolas, monospace; color: #d8cfb8; background: rgba(12,10,8,0.62);
  padding: 4px 8px; border-radius: 3px; pointer-events: auto; user-select: none; white-space: nowrap; }
.alg-perf b { font-weight: 700; color: #fff; }
.alg-perf .ok { color: #9fd38a; } .alg-perf .warn { color: #f0c05a; } .alg-perf .bad { color: #ff7a66; }
.alg-perf button { font: inherit; color: #d8cfb8; background: #2a241c; border: 1px solid #5a4d3a; border-radius: 2px; padding: 1px 6px; cursor: pointer; }
.alg-perf button:disabled { opacity: 0.5; cursor: default; }`;
  document.head.appendChild(style);

  const line = document.createElement("span");
  const gpuBtn = document.createElement("button");
  gpuBtn.textContent = "GPU";
  gpuBtn.title = "Measure the real frame cost here (frames back to back, ~1 s pause)";
  const gpuOut = document.createElement("span");
  gpuOut.textContent = "the real frame cost here";
  // Row 1: the live line (narrow: the score bar starts ~370 px in). Row 2: GPU.
  line.style.gridColumn = "1 / 3";
  el.append(line, gpuBtn, gpuOut);
  mount.appendChild(el);

  // Budget colours against 60 Hz (16.7 ms).
  const cls = (ms) => (ms < 12 ? "ok" : ms < 16.7 ? "warn" : "bad");
  const f1 = (v) => v.toFixed(1);
  let timer = 0;
  function tick() {
    const s = app.takeFrameStats?.();
    if (!s || !s.frames) return;
    const heap = performance.memory ? ` · ${Math.round(performance.memory.usedJSHeapSize / 1048576)} MB` : "";
    line.innerHTML = `<b class="${cls(s.frameMs)}">${f1(s.frameMs)}</b> ms ↑${Math.round(s.frameMaxMs)}`
      + ` · CPU <b class="${cls(s.cpuMs)}">${f1(s.cpuMs)}</b> ↑${Math.round(s.cpuMaxMs)}`
      + ` · ${s.draws} dr${heap}`;
    line.title = "frame: the rAF interval (vsync: 16.7 = 60 fps), ↑ = worst in the last ½ s · CPU: the loop's own work · dr: draw calls · MB: JS heap";
  }
  gpuBtn.onclick = async () => {
    gpuBtn.disabled = true;
    gpuOut.textContent = "measuring…";
    try {
      const m = await measureFrame(app.renderer);
      gpuOut.innerHTML = `frame <b class="${cls(m.frameMin)}">${f1(m.frameMin)}</b> · CPU ${f1(m.cpu)} · ${m.limit}`;
    } catch (e) {
      gpuOut.textContent = `failed: ${e?.message ?? e}`;
    } finally {
      gpuBtn.disabled = false;
      app.takeFrameStats?.();   // the bench's back-to-back frames are not play
    }
  };

  function setVisible(on) {
    el.style.display = on ? "" : "none";
    clearInterval(timer);
    timer = on ? setInterval(tick, 500) : 0;
    if (on) app.takeFrameStats?.();   // start the window now
  }
  setVisible(visible);

  return {
    get visible() { return el.style.display !== "none"; },
    setVisible,
    dispose() { clearInterval(timer); el.remove(); style.remove(); },
  };
}
