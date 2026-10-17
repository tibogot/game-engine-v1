// flowMap.js's compute, off the main thread (~150 ms at 1024²).
import { computeFlowBytes } from "./flowMapCompute.js";

self.onmessage = (e) => {
  const { heights, size } = e.data;
  const t0 = performance.now();
  const bytes = computeFlowBytes(heights, size, new Uint8Array(size * size));
  self.postMessage({ bytes, ms: performance.now() - t0 }, [bytes.buffer]);
};
