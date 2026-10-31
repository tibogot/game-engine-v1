/**
 * ── r187: ONE compileAsync AT A TIME ─────────────────────────────────────────────────────────────
 *
 * r187's compileAsync builds its pipelines in parallel and yields to the main thread between items,
 * swapping the renderer's ONE precompile state (render target, MRT, render context) out and back in
 * around each yield. Two calls in flight at once — our systems warm up side by side: foliage, grass,
 * scatter, the game's own warm-up — take each other's state across those yields, and the second
 * finds none ("Cannot destructure property 'useFrameBufferTarget' of 'this._precompilationState' as
 * it is null": alg-rts' foliage build failed on r187). The calls are queued here, each starting when
 * the one before it ends; inside a call three still compiles in parallel.
 *
 * Install once per page (main.js), on the app's renderer. Retest at every three upgrade
 * (v3/THREE_UPGRADES.md).
 */
export function installSerialCompile(renderer) {
  if (renderer._v3SerialCompile) return false;
  renderer._v3SerialCompile = true;
  const compileAsync = renderer.compileAsync.bind(renderer);
  let tail = Promise.resolve();
  renderer.compileAsync = function (...args) {
    const run = tail.then(() => compileAsync(...args));
    tail = run.catch(() => {});   // a failed call does not block the ones after it
    return run;
  };
  return true;
}
