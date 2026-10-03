// THE RTS PERFORMANCE DEFAULTS — what alg-rts and nam-rts measured their way
// to (2026-10-03 audit; games/alg-rts/TODO.md "PERF + LOAD AUDIT 2"), in one
// place, so a new game starts with all of it instead of finding it again.
//
//   rtsEngineOptions(params)  → spread into startV3App({...}) first; the game's
//                               own options after it win
//   beginRtsPerfBoot(app, …)  → right after startV3App: boot loop, parallel
//                               pipelines, stats-gl off, the perf line
//     .endPipelines()         → after the game's pipeline warm-up
//     .releaseMemory()        → when the boot is done (CPU copies of GPU-only data)
//
// Every switch keeps its ?flag so a saving can be A/B'd, not taken on trust.
// What each one bought is written where it lives in the engine.

import { createPerfHud } from "./perfHud.js";
import { perfCheck } from "./perfCheck.js";
import { openParallelPipelines } from "../../v3/render/parallelPipelines.js";
import { releaseGpuOnly } from "../../v3/render/gpuOnlyArrays.js";

/**
 * Engine options every RTS game wants.
 * @param {URLSearchParams} [params]
 */
export function rtsEngineOptions(params = new URLSearchParams(location.search)) {
  return {
    // The editor's paint palette is overwritten by the level's own layers.
    preloadPaintTextures: false,
    // Instance matrices as vertex attributes: uploaded when they change, not
    // re-sent on every draw (main.js). ?instubo=1 = three's per-draw copy.
    instanceAttributes: params.get("instubo") !== "1",
    // Instanced meshes on one material share ONE shader build
    // (render/sharedInstanceBuilds.js). ?instshare=0 = one build each.
    shareInstanceBuilds: params.get("instshare") !== "0",
    // Plant-field draws that cannot hold a plant are skipped on the CPU
    // (ScatterField.setCpuDensity). ?plantcull=0 = draw them all.
    plantCpuCull: params.get("plantcull") !== "0",
    // The plant fields' draws batched: a few objects issuing many indirect
    // draws each (ScatterField._syncBatches). ?plantbatch=0 = one each.
    batchPlantDraws: params.get("plantbatch") !== "0",
    // Depth pre-pass for cut-out plant cards: each pixel shaded once.
    // ?prepass=0 = without.
    foliageDepthPrepass: params.get("prepass") !== "0",
    light: { shadowNormalBias: 0.12 },
  };
}

/**
 * The boot's performance scaffolding.
 * @param {object} app  startV3App's result
 * @param {object} [o]
 * @param {URLSearchParams} [o.params]
 * @param {boolean} [o.bootFrames=true]  engine frames under the loading screen
 *   (one a second) or none until the warm-up — MEASURE per game: nam-rts boots
 *   faster with none, alg-rts with them (both TODOs have the numbers).
 *   ?bootframes=0/1 overrides.
 */
export function beginRtsPerfBoot(app, { params = new URLSearchParams(location.search), bootFrames = true } = {}) {
  const bf = params.get("bootframes");
  const frames = bf === "0" ? false : bf === "1" ? true : bootFrames;
  app.setFrameThrottle?.(frames ? 1000 : 1e9);
  // Pipelines compile side by side for the whole boot; the draws behind the
  // loading screen wait for theirs. ?parboot=0 = one at a time.
  const pipelines = params.get("parboot") !== "0" ? openParallelPipelines(app.renderer, app.scene) : null;
  // stats-gl wrapped every render (0.4-0.8 ms a frame): off, ?stats=1 for it;
  // the perf line in its place, ?perf=0 hides it.
  app.setStatsOverlay?.(params.get("stats") === "1");
  app.perfHud = createPerfHud(app, { visible: params.get("perf") !== "0" });
  // The PERF_RULES.md counters on demand: await app.perfCheck()
  app.perfCheck = (o) => perfCheck(app, o);

  return {
    /** Wait for every pipeline compiled in parallel, and close the window. */
    async endPipelines() {
      if (!pipelines) return null;
      const t0 = performance.now(), p = await pipelines.end();
      console.log(`[pipelines] ${p.created} built in parallel during the boot, ${p.skipped} draws waited; the last ones took ${Math.round(performance.now() - t0)} ms`);
      return p;
    },
    /**
     * Drop the CPU copies of what only the GPU reads (grass, plant fields,
     * crowd skinning; the terrain's paint layers), now and every 5 s (a crowd
     * gets its buffers with its first man). ?gpuonly=0 keeps them.
     */
    releaseMemory() {
      if (params.get("gpuonly") === "0") return;
      const mb = releaseGpuOnly(app.renderer) / 1048576;
      let paintMb = (app.releasePaintCpuCopies?.() ?? 0) / 1048576;
      console.log(`[memory] ${mb.toFixed(0)} MB of GPU-only arrays + ${paintMb.toFixed(0)} MB of paint layers released from the JS heap`);
      setInterval(() => {
        releaseGpuOnly(app.renderer);
        if (!paintMb) paintMb = (app.releasePaintCpuCopies?.() ?? 0) / 1048576;
      }, 5000);
    },
  };
}
