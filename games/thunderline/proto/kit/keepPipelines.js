// KEEP COMPILED SHADERS FOR THE PAGE'S LIFE (2026-10-28, the one always-loaded page).
//
// three.js frees a material's built shader (its node-builder state), its shader programs and its GPU pipeline
// as soon as no object uses them. The shell switches the whole scene between shading setups: building / the
// menu draw with the engine's shadow cascades, a played track with the baked sun shadows (and the switch draws
// a frame with no sun shadow at all). Each switch left the other setup's shaders unused, three freed them, and
// the way back built them all again: measured, a replay of the same track rebuilt ~160 shaders, ~7 s of
// JavaScript building them and ~11 s of the GPU driver compiling them — byte-identical code every time.
//
// Programs and pipelines are keyed by their CODE and state, so keeping them is bounded by the game's handful of
// setups. Node-builder states can be keyed by an OBJECT (three puts an instanced mesh's uuid in the key: the
// state holds that object's instance data) — a played track's guardrail chunks are new objects every run — so
// the states freed by three are kept in a queue and the oldest still unused are really freed past CAP.
// Engine-internal fields (three r186: renderer._pipelines, renderer._nodes.nodeBuilderCache): if three renames
// them this does nothing and says so — the game still runs, only slower.

const CAP = 400; // freed-but-kept node-builder states (a played track leaves ~40-90)

/** @param {import("three/webgpu").WebGPURenderer} renderer — once, after the renderer is initialised */
export function keepPipelines(renderer) {
  const P = renderer._pipelines, cache = renderer._nodes?.nodeBuilderCache;
  if (!P?._releasePipeline || !P?._releaseProgram || !(cache instanceof Map)) {
    console.warn("[keepPipelines] three's caches not found: compiled shaders will be freed and rebuilt");
    return false;
  }
  P._releasePipeline = () => {};
  P._releaseProgram = () => {};
  const realDelete = cache.delete.bind(cache);
  const kept = new Set(); // keys three freed, oldest first (a Set keeps insertion order)
  cache.delete = (key) => {
    kept.delete(key);
    kept.add(key);
    if (kept.size > CAP) {
      for (const k of kept) {
        if (kept.size <= CAP) break;
        kept.delete(k);
        if (!(cache.get(k)?.usedTimes > 0)) realDelete(k); // (in use again since: it stays)
      }
    }
    return true;
  };
  return true;
}
