/**
 * GPU STATS PANEL — per-frame, per-pass GPU timing taken straight from the
 * WebGPU timestamp query pool.
 *
 * WHY THIS EXISTS RATHER THAN JUST READING `renderer.info.render.timestamp`.
 * That field is what stats-gl shows, and it is not a per-frame number. Measured
 * on this project, driving modular-road with a completely static scene (same 50
 * draws, same 327k triangles every frame):
 *
 *     info.render.timestamp   4.46 – 17.76 ms      (4x swing, nothing changing)
 *     this panel               4.65 ms stable
 *
 * and worse, it can under-report by an order of magnitude: the same scene that
 * measures 4.65 ms was reporting 0.33 ms whenever the car was moving. That is
 * not noise, it is a specific and repeatable defect — see PARTIAL FRAMES below.
 *
 * ── HOW three's POOL ACTUALLY WORKS ────────────────────────────────────────
 * `WebGPUTimestampQueryPool` allocates a query PAIR per render pass, keyed by a
 * uid of the form `r:<idx>:<n>:f<frameId>`. On resolve it groups every pending
 * query BY FRAME, stores each pass individually in `pool.timestamps`, and
 * returns `framesDuration[frames[frames.length - 1]]` — the total of only the
 * LAST frame in the batch.
 *
 * PARTIAL FRAMES are the bug that falls out of that. A resolve can be taken
 * while the newest frame is still mid-flight, having recorded only some of its
 * passes. Its "total" is then a fraction of the real cost, and that is exactly
 * what gets published. This project renders 18 passes per frame and ONE of them
 * is ~92% of the time, so a batch snapshot that misses it reports a frame as
 * near-free.
 *
 * THE FIX, and it needs no heuristics: frame ids are monotonic, so once a
 * LATER frame has appeared, every earlier frame is closed and complete. This
 * panel only ever reports frames that already have a successor. Nothing is
 * estimated and no pass count has to be guessed.
 *
 * ── WHAT ELSE IT BUYS ──────────────────────────────────────────────────────
 *  • PER-PASS BREAKDOWN. The pool already stores every pass; nothing surfaces
 *    it. One number cannot tell you that 92% of your frame is a single pass and
 *    that all 3 shadow cascades plus the whole bloom chain are 0.5 ms between
 *    them — which is the difference between optimising the right thing and
 *    spending a day on shadow draw counts that cost ~0.07 ms each.
 *  • A ROLLING MEDIAN instead of an instantaneous value, so the number is
 *    readable at a glance rather than changing 4x between two looks at it.
 *  • A LEAK FIX. `pool.timestamps.set()` is never cleared by three and nothing
 *    inside the renderer reads it (only the optional inspector does). Measured
 *    on this project after a few minutes: 1,128,674 entries and climbing at
 *    18/frame. This panel clears it on attach and prunes each frame it consumes.
 *
 * The `raw` readout is deliberately kept and displayed next to ours: it is what
 * stats-gl is showing, so the two panels can be compared directly while
 * deciding whether to retire the old one.
 *
 * GPU readback is inherently 1–3 frames behind — that is a property of
 * mapAsync, not something any panel can avoid. For a stats display it does not
 * matter; the numbers are still each a true measurement of one real frame.
 */

/** Frames kept for the rolling statistics. ~0.5 s at 60 fps. */
const WINDOW = 30;

/** Rows shown in the per-pass breakdown. */
const TOP_PASSES = 3;

function median(sorted) {
  if (!sorted.length) return 0;
  return sorted[Math.floor(sorted.length / 2)];
}

function pct(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

/**
 * @param {import("three/webgpu").WebGPURenderer} renderer
 * @param {object} [opts]
 * @param {HTMLElement} [opts.parent] where to mount (default document.body)
 * @param {string} [opts.top] CSS top offset — default clears the stats-gl panel
 * @param {string} [opts.left]
 * @param {boolean} [opts.prune] prune consumed entries (default true)
 * @returns {{ el: HTMLElement, dispose: () => void, sample: () => object }}
 */
export function createGpuStatsPanel(renderer, opts = {}) {
  const {
    parent = document.body,
    top = "52px",
    left = "0px",
    prune = true,
  } = opts;

  const el = document.createElement("div");
  el.dataset.gpuStatsPanel = "1";
  el.style.cssText = [
    "position:fixed", `top:${top}`, `left:${left}`, "z-index:10000",
    "font:11px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace",
    "background:rgba(12,14,18,0.88)", "color:#cfe6ff",
    "border:1px solid #2a3442", "border-radius:4px",
    "padding:6px 8px", "min-width:198px", "pointer-events:none",
    "white-space:pre", "backdrop-filter:blur(2px)",
  ].join(";");
  parent.appendChild(el);

  /** Resolve the backend's render-type query pool, defensively — this reaches
   *  into three internals, so every access is optional and a miss just leaves
   *  the panel reporting "unavailable" rather than throwing into the frame. */
  const getPool = () => {
    const b = renderer?.backend;
    const pools = b?.timestampQueryPool ?? b?._timestampQueryPool;
    return pools?.render ?? null;
  };

  // Drop whatever the leak has already accumulated before we start.
  const pool0 = getPool();
  let clearedAtStart = 0;
  if (pool0?.timestamps?.size) {
    clearedAtStart = pool0.timestamps.size;
    pool0.timestamps.clear();
  }

  const frameTotals = [];   // ms per COMPLETE frame
  const passCounts = [];
  let lastFrameId = -1;
  let framesSeen = 0;
  let topPasses = [];       // [{ idx, ms }] from the most recent complete frame
  let lastTotal = 0;

  // FPS / CPU cadence from our own rAF — independent of anything three reports.
  const frameStamps = [];

  let raf = 0;
  let disposed = false;
  let resolveInFlight = false;

  /**
   * Harvest every CLOSED frame out of the pool.
   *
   * "Closed" = a strictly newer frame id is present, so no further pass can be
   * appended to it. That is what makes this immune to the partial-frame
   * under-report; see the header.
   */
  function harvest(pool) {
    const ts = pool.timestamps;
    if (!ts || ts.size === 0) return;

    /** frameId -> { sum, passes: [{idx, ms}], uids: string[] } */
    const byFrame = new Map();
    let newest = -1;

    for (const [uid, ms] of ts) {
      // `r:<idx>:<n>:f<frameId>` — take the trailing frame id and the leading
      // pass index. A uid that does not match is left alone rather than guessed
      // at (and, being unparseable, is also never pruned).
      const at = uid.lastIndexOf(":f");
      if (at < 0) continue;
      const frameId = +uid.slice(at + 2);
      if (!Number.isFinite(frameId)) continue;
      if (frameId > newest) newest = frameId;
      let rec = byFrame.get(frameId);
      if (!rec) byFrame.set(frameId, (rec = { sum: 0, passes: [], uids: [] }));
      rec.sum += ms;
      rec.passes.push({ idx: uid.slice(0, at), ms });
      rec.uids.push(uid);
    }
    if (newest < 0) return;

    const closed = [...byFrame.keys()].filter((f) => f < newest).sort((a, b) => a - b);
    for (const frameId of closed) {
      const rec = byFrame.get(frameId);
      // Guard against a frame that somehow recorded nothing.
      if (rec.passes.length) {
        framesSeen++;
        lastFrameId = frameId;
        lastTotal = rec.sum;
        frameTotals.push(rec.sum);
        passCounts.push(rec.passes.length);
        if (frameTotals.length > WINDOW) frameTotals.shift();
        if (passCounts.length > WINDOW) passCounts.shift();
        rec.passes.sort((a, b) => b.ms - a.ms);
        topPasses = rec.passes.slice(0, TOP_PASSES);
      }
      if (prune) for (const uid of rec.uids) ts.delete(uid);
    }
    // The newest frame is deliberately LEFT IN PLACE — it is still open, and
    // consuming it here is precisely the bug this panel exists to avoid.
  }

  function render() {
    const pool = getPool();
    const info = renderer?.info?.render;
    const now = performance.now();

    frameStamps.push(now);
    while (frameStamps.length > 2 && now - frameStamps[0] > 1000) frameStamps.shift();
    const fps = frameStamps.length > 1
      ? (frameStamps.length - 1) * 1000 / (now - frameStamps[0])
      : 0;

    if (!pool) {
      el.textContent = "GPU panel: timestamp pool unavailable\n(needs WebGPU + timestamp-query)";
      return;
    }

    // Kick a resolve; three shares one in-flight promise, so calling this
    // alongside the engine's own resolve costs nothing extra.
    if (!resolveInFlight) {
      resolveInFlight = true;
      Promise.resolve(renderer.resolveTimestampsAsync("render"))
        .catch(() => {})
        .finally(() => { resolveInFlight = false; });
    }

    harvest(pool);

    const sorted = [...frameTotals].sort((a, b) => a - b);
    const med = median(sorted);
    const p95 = pct(sorted, 0.95);
    const lo = sorted.length ? sorted[0] : 0;
    const hi = sorted.length ? sorted[sorted.length - 1] : 0;
    const passes = passCounts.length ? passCounts[passCounts.length - 1] : 0;
    const raw = info?.timestamp ?? 0;
    const big = topPasses[0];
    const bigShare = big && lastTotal > 0 ? (big.ms / lastTotal) * 100 : 0;

    const lines = [
      `GPU  ${med.toFixed(2)} ms  med   (${lo.toFixed(2)}–${hi.toFixed(2)})`,
      `     p95 ${p95.toFixed(2)}   frames ${framesSeen}`,
      `raw  ${raw.toFixed(2)} ms   <- stats-gl reads this`,
      `passes ${passes}   draws ${info?.drawCalls ?? 0}   ${Math.round((info?.triangles ?? 0) / 1000)}k tri`,
      `fps  ${fps.toFixed(0)}`,
    ];
    if (big) {
      lines.push(`top  ${big.ms.toFixed(2)} ms  ${bigShare.toFixed(0)}% of frame`);
      for (let i = 1; i < topPasses.length; i++) {
        lines.push(`     ${topPasses[i].ms.toFixed(2)} ms`);
      }
    }
    el.textContent = lines.join("\n");
  }

  function loop() {
    if (disposed) return;
    raf = requestAnimationFrame(loop);
    try { render(); } catch { /* a stats panel must never break the app */ }
  }
  raf = requestAnimationFrame(loop);

  return {
    el,
    /** Current numbers, for tests / console probing. */
    sample() {
      const sorted = [...frameTotals].sort((a, b) => a - b);
      return {
        median: median(sorted),
        p95: pct(sorted, 0.95),
        min: sorted[0] ?? 0,
        max: sorted[sorted.length - 1] ?? 0,
        frames: framesSeen,
        lastFrameId,
        passes: passCounts[passCounts.length - 1] ?? 0,
        topPasses: topPasses.map((p) => ({ ...p })),
        raw: renderer?.info?.render?.timestamp ?? 0,
        clearedAtStart,
        poolSize: getPool()?.timestamps?.size ?? 0,
      };
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      el.remove();
    },
  };
}
