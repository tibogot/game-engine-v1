// Builds one plane-SDF cliff piece (cliffSlabs.js) off the main thread and
// posts its arrays back (transferred, not copied).
import { createSlabCliff } from "./cliffSlabs.js";
import { simplifierReady } from "../../v3/render/instancing/autoLod.js";

self.onmessage = async (e) => {
  const { id, opts } = e.data;
  try {
    await simplifierReady;
    const g = createSlabCliff(opts);
    const out = { id, index: g.index.array, userData: g.userData };
    const transfer = [out.index.buffer];
    for (const k of ["position", "normal", "rockShade"]) { out[k] = g.attributes[k].array; transfer.push(out[k].buffer); }
    self.postMessage(out, transfer);
  } catch (err) {
    self.postMessage({ id, error: String(err?.stack ?? err) });
  }
};
