/**
 * FLOW MAP — where rain on this terrain runs and gathers (TEXTURING_PLAN step 3,
 * wetness). Per texel: log2 of the upstream area that drains through it, so a
 * drainage line on a hillside reads as a line and a valley floor as a band.
 *
 * MULTIPLE flow direction (Freeman 1991): a texel passes its water to EVERY
 * lower neighbour, in proportion to slope^FLOW_EXP. The single-direction (D8)
 * routing of streamPowerErosion.js is right for carving — one channel per
 * valley — but as a mask it draws 1-texel staircase lines; spreading the water
 * gives the soft, braided drainage that real wet ground follows. It also
 * spreads it thin: on nam-valley the drainage lines sit at 5-11 octaves and
 * most of the map below 6, hence the shader's defaults (start 4, range 4).
 *
 * Once per height EDIT (debounced by the caller, never during a stroke), in a
 * WORKER: ~150 ms at 1024², which on the main thread was a hitch after every
 * stroke. Stored as R8 = log2(cells) × 16 (0..16 octaves), read by the paint
 * shader with textureLoad — no sampler, the terrain stage is at its 16-sampler
 * limit. Pits keep their water (wet hollows); flat plains get none.
 */
import * as THREE from "three";
import { computeFlowBytes } from "./flowMapCompute.js";

export { computeFlowBytes };

export function createFlowMap(size) {
  const data = new Uint8Array(size * size);
  const tex = new THREE.DataTexture(data, size, size, THREE.RedFormat, THREE.UnsignedByteType);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.name = "TerrainFlowMap";
  tex.needsUpdate = true;

  let worker = null;
  try {
    worker = new Worker(new URL("./flowMapWorker.js", import.meta.url), { type: "module" });
  } catch { worker = null; }   // no workers (tests, odd hosts): compute inline

  /**
   * Recompute from `heights` (copied — the caller's mirror stays live).
   * Resolves with the milliseconds the compute took.
   */
  function compute(heights) {
    const t0 = performance.now();
    if (!worker) {
      computeFlowBytes(heights, size, data);
      tex.needsUpdate = true;
      return Promise.resolve(performance.now() - t0);
    }
    const copy = new Float32Array(heights);
    return new Promise((resolve, reject) => {
      worker.onmessage = (e) => {
        data.set(e.data.bytes);
        tex.needsUpdate = true;
        resolve(e.data.ms);
      };
      worker.onerror = (e) => reject(e);
      worker.postMessage({ heights: copy, size }, [copy.buffer]);
    });
  }

  return { texture: tex, size, compute, dispose() { tex.dispose(); worker?.terminate(); } };
}
