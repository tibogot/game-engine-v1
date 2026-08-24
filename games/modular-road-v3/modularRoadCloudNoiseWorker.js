/**
 * Bakes the cloud volumes off the main thread.
 *
 * WHY THIS EXISTS: the bake is ~3.1 s of straight-line CPU work for the 128³ base volume
 * (measured, this machine). The v3 editor's deck does the equivalent bake synchronously
 * inside its constructor — fine for a panel toggle you flip once, a 3-second freeze on a
 * game boot. Same cost, moved off the critical path: the game renders immediately with no
 * clouds and fades them in when the buffers land.
 *
 * Transfers the buffers rather than copying them (they total ~9.5 MB).
 */
import { bakeAll } from "./modularRoadCloudNoise.js";

self.onmessage = (e) => {
  const { seed = 137, jobId = 0 } = e.data ?? {};
  const t0 = performance.now();
  try {
    const v = bakeAll(seed);
    self.postMessage(
      { ok: true, jobId, ms: performance.now() - t0, ...v },
      [v.base.buffer, v.detail.buffer, v.near.buffer, v.weather.buffer],
    );
  } catch (err) {
    self.postMessage({ ok: false, jobId, error: String(err?.stack ?? err) });
  }
};
