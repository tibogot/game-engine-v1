/**
 * Generates procedural rock geometry off the main thread — see
 * prewarmRockGeometries() in proceduralRock.js. Runs the SAME
 * createRockGeometry (same JS, same meshoptimizer WASM, so the same bits) and
 * sends the arrays back, transferred.
 */
import { createRockGeometry } from "./proceduralRock.js";
import { simplifierReady } from "../render/instancing/autoLod.js";

self.onmessage = async (e) => {
  const { id, params } = e.data;
  try {
    await simplifierReady;
    const geo = createRockGeometry(params);
    const attributes = {};
    const transfer = new Set();
    for (const [name, a] of Object.entries(geo.attributes)) {
      attributes[name] = { array: a.array, itemSize: a.itemSize, normalized: a.normalized };
      transfer.add(a.array.buffer);
    }
    const index = geo.index.array;
    transfer.add(index.buffer);
    self.postMessage({ id, attributes, index, rock: geo.userData.rock }, [...transfer]);
  } catch (err) {
    self.postMessage({ id, error: String(err?.message ?? err) });
  }
};
