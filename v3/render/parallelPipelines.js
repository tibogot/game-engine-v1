// PARALLEL PIPELINES — let the browser compile render pipelines side by side.
//
// three builds a pipeline the first time a (material, geometry, pass) is drawn,
// with the SYNCHRONOUS device.createRenderPipeline: Chrome then compiles each
// one on the GPU process' main thread, one after another, and every later GPU
// call (a readback, a bake, the next frame) waits behind the queue.
// createRenderPipelineAsync compiles on worker threads. Measured 2026-10-03
// (laptop, 16 threads, the game's own WGSL): 16 pipelines 1.0-1.1 s one at a
// time, 0.21 s all at once. alg-rts builds ~385 at boot: ~26 s of GPU-process
// time, and its boot ends waiting on that queue whatever the main thread saves.
//
// While a window is open (a boot under a loading screen), a new render
// pipeline for an object of `scene` is created ASYNC, and three skips its draw
// until it is ready (Pipelines.isReady). Only that scene: bakes render their
// own scenes (ground cache, sky, thumbnails, env) and keep three's synchronous
// path — none of their draws is ever skipped. `end()` waits for every pipeline
// started and closes the window.
//
//   const win = openParallelPipelines(renderer, scene);
//   …boot…
//   const { created, skipped } = await win.end();

export function openParallelPipelines(renderer, scene) {
  const backend = renderer.backend;
  const pending = [];
  let created = 0, skipped = 0, open = true;

  const createRenderPipeline = backend.createRenderPipeline;
  backend.createRenderPipeline = function (renderObject, promises) {
    if (!open || promises || renderObject.scene !== scene) return createRenderPipeline.call(this, renderObject, promises);
    created++;
    return createRenderPipeline.call(this, renderObject, pending);
  };
  // Count the draws three skipped for a pipeline still compiling.
  const pipes = renderer._pipelines;
  const isReady = pipes.isReady;
  pipes.isReady = function (renderObject) {
    const ok = isReady.call(this, renderObject);
    if (!ok && open) skipped++;
    return ok;
  };

  return {
    get created() { return created; },
    get pending() { return pending.length; },
    /** Wait for every pipeline started in the window; restore three's calls. */
    async end() {
      open = false;
      backend.createRenderPipeline = createRenderPipeline;
      pipes.isReady = isReady;
      await Promise.all(pending);
      return { created, skipped };
    },
  };
}
