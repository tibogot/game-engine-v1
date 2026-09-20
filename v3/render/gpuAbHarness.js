/**
 * v3/render/gpuAbHarness.js — a GPU A/B that returns numbers you can trust.
 *
 * Built after a session where three separate conclusions were drawn from this
 * engine's own timing panel and all three were wrong. The panel is not at
 * fault; the way it was being read was. This wraps it so the reading is right
 * by construction.
 *
 * WHAT GOES WRONG WITHOUT IT
 *
 *   1. THE MEDIAN COLLAPSES. WebGPU's timestamp is heavily quantised — a
 *      sample of 90 frames holds only a handful of distinct values, all
 *      multiples of ~0.065 ms. A median therefore lands on the same value for
 *      both sides of an A/B and reports "no difference" across a real one.
 *      This takes the MEAN of the raw per-frame totals.
 *
 *   2. A PER-PASS NUMBER IS ONE FRAME. `sample().topPasses` describes the most
 *      recent COMPLETE frame, not the window — so it swings by 2x frame to
 *      frame. It is the right tool for "which pass is big" and the wrong tool
 *      for "did my change help". This only ever A/Bs `frameTotals`.
 *
 *   3. THE MACHINE DRIFTS. Readings at one fixed camera rose from 6.8 to 10 ms
 *      over a long session as the laptop warmed. Any A/B whose two sides are
 *      measured minutes apart measures the thermal ramp. Cases are INTERLEAVED
 *      inside every round, so drift hits all of them equally.
 *
 *   4. A STATE CHANGE IS NOT FREE. Toggling visibility or a material can
 *      rebuild a pipeline, and the frames during the rebuild are not the frames
 *      you meant to time. Every case settles before it is sampled.
 *
 *   5. A BACKGROUNDED TAB FREEZES THE COUNTERS, so both sides come back
 *      byte-identical. Bring the page to the front before calling this.
 *
 * See ref: if an A/B comes back identical, suspect the harness, not the change.
 *
 * USAGE
 *
 *   const g = await __V3_DEBUG.gpu();
 *   await gpuAB({
 *     sample: g.sample,
 *     cases: {
 *       all:       () => { foliage.visible = true;  grass.visible = true; },
 *       noFoliage: () => { foliage.visible = false; grass.visible = true; },
 *     },
 *     reset: () => { foliage.visible = true; grass.visible = true; },
 *   });
 *   // -> { all: { mean, spread, rounds }, noFoliage: {...},
 *   //      deltas: { noFoliage: -0.09 }, baseline: "all" }
 *
 * The result's `deltas` are against the FIRST case, which is the convention
 * that makes "what does this cost" readable: a case that removes something
 * comes back negative by what it removed.
 */

/** Mean and half-spread of a list, both in ms. */
function stats(a) {
  const mean = a.reduce((x, y) => x + y, 0) / a.length;
  return { mean, spread: (Math.max(...a) - Math.min(...a)) / 2 };
}

/**
 * @param {object} o
 *   sample     `(frames) => Promise<{ frameTotals: number[] }>` — from
 *              createGpuStatsPanel's handle (`__V3_DEBUG.gpu()`).
 *   cases      `{ name: () => void }` — each puts the scene in one state. The
 *              FIRST is the baseline the deltas are measured against.
 *   rounds     how many times the whole set is walked (default 4). More rounds
 *              beat more frames per round: rounds fight drift, frames fight
 *              noise, and drift is the bigger liar.
 *   frames     per sample (default 90)
 *   settleMs   after each case's setup, before sampling (default 2200)
 *   reset      optional, run once at the end
 *   onProgress optional `(done, total, name)`
 */
export async function gpuAB({
  sample, cases, rounds = 4, frames = 90, settleMs = 2200, reset = null, onProgress = null,
}) {
  if (typeof sample !== "function") throw new Error("gpuAB: `sample` is required (see __V3_DEBUG.gpu())");
  const names = Object.keys(cases ?? {});
  if (names.length < 1) throw new Error("gpuAB: at least one case");

  const runs = Object.fromEntries(names.map((n) => [n, []]));
  const total = rounds * names.length;
  let done = 0;

  for (let r = 0; r < rounds; r++) {
    for (const name of names) {
      cases[name]();
      await new Promise((res) => setTimeout(res, settleMs));
      const s = await sample(frames);
      const totals = s?.frameTotals ?? [];
      // A window with nothing in it means the tab is not rendering — say so
      // rather than averaging an empty list into NaN.
      if (!totals.length) throw new Error("gpuAB: no frames timed — is the tab in the foreground?");
      runs[name].push(totals.reduce((x, y) => x + y, 0) / totals.length);
      onProgress?.(++done, total, name);
    }
  }
  reset?.();

  const out = {};
  for (const n of names) {
    const { mean, spread } = stats(runs[n]);
    out[n] = { mean: +mean.toFixed(2), spread: +spread.toFixed(2), rounds: runs[n].map((v) => +v.toFixed(2)) };
  }
  const base = out[names[0]].mean;
  out.baseline = names[0];
  out.deltas = Object.fromEntries(names.slice(1).map((n) => [n, +(out[n].mean - base).toFixed(2)]));
  // A difference smaller than the round-to-round spread is not a difference.
  out.noise = +Math.max(...names.map((n) => out[n].spread)).toFixed(2);
  return out;
}
