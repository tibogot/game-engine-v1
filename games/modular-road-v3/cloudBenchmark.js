/**
 * A/B benchmark: the game's cloud system vs. the v3 editor's deck, same scene, same camera,
 * same resolution, GPU-timed.
 *
 * WHY THIS EXISTS. The game system was built on the argument that it would be both better
 * looking and cheaper than the editor's deck. The "better looking" half was checked by
 * looking at it. The "cheaper" half was never measured at all, and the reasoning cuts both
 * ways — so this replaces the assumption with a number.
 *
 * Reasons the game system might legitimately be SLOWER per pixel, which is what makes the
 * measurement worth doing:
 *   - The editor's deck sits at 1900 m and is viewed from the ground: rays cross a distant
 *     slab that covers little of the screen. That is its best case.
 *   - The game deck sits at 260 m, so it fills far more of the frame and more pixels march.
 *   - The game system adds a temporal resolve pass and a depth-aware upsample that does
 *     ~9 texture fetches at FULL resolution. The editor's upsample is 5 fetches.
 * Against that the game system has empty-space skipping actually enabled (the editor ships
 * `emptySkip: 1.0`, i.e. off), transmittance early-out, a 6-step light march vs 8, and the
 * adaptive step schedule.
 *
 * WHAT THIS DOES *NOT* MEASURE. The largest structural win claimed for the game system is
 * eliminating the duplicate full-scene render that the editor's post-FX path performs
 * (`prepareFrame()` renders the whole scene once purely for a depth buffer, then
 * PostFxPipeline renders it again). That only happens on the post-FX path. Both systems'
 * owns-the-frame entry points — `renderFrame()` here, `tryRenderFrame()` there — render the
 * scene exactly once, so this harness compares the CLOUD SHADER honestly and says nothing
 * about the integration win. Do not quote this number as covering that.
 *
 * The editor's file is imported, never modified.
 */
import * as THREE from "three/webgpu";
import { createDayNightCloudLayer } from "../../v3/render/clouds/dayNightCloudLayer.js";

/**
 * The editor deck's shipped defaults, copied from v2/app/config.js
 * (`V2_CONFIG.volumetricCloudDayNight`) rather than imported, so this harness does not drag
 * the whole v2 config graph into the lab bundle. If those defaults change, this drifts —
 * it is a benchmark baseline, so pin it rather than track it.
 */
export const EDITOR_DECK_DEFAULTS = {
  enabled: true,
  base: 1900,
  thickness: 1400,
  scale: 0.00015,
  detailMul: 4.0,
  coverage: 0.4,
  softness: 0.12,
  erode: 0.15,
  densityMul: 12.0,
  steps: 128,
  lightSteps: 8,
  emptySkip: 1.0,
  bufferScale: 0.5,
  maxDist: 24000,
  planetRadius: 160000,
  opacity: 0.7,
  lightAbsorb: 1.1,
  phaseG: 0.3,
  powder: 0.5,
  msAmount: 0.7,
  msExtinction: 0.5,
  msContribution: 0.5,
  msEccentricity: 0.5,
  windDeg: 35,
  windSpeed: 0.02,
  aerialEnabled: true,
  aerialDensity: 0.00012,
  aerialAmount: 1.0,
};

/**
 * Build the benchmark. Constructing the editor deck bakes its noise volumes SYNCHRONOUSLY
 * (~3.3 s, the very cost the game system moved to a worker), so it is deferred until the
 * first run rather than paid at lab boot.
 */
export function createCloudBenchmark({ renderer, scene, camera, clouds, sunDir, skyColors }) {
  let deck = null;

  function ensureDeck() {
    if (deck) return deck;
    const t0 = performance.now();
    deck = createDayNightCloudLayer({ scene, camera, renderer });
    deck.blockingBakeMs = performance.now() - t0;
    scene.add(deck.mesh);
    scene.add(deck.sunMesh);
    // Shadows, bloom and god-rays all default off; the game system has none of them, so
    // leaving them off is what makes this apples-to-apples.
    return deck;
  }

  const _lightColor = new THREE.Color(0xfff2dc);
  const _ambColor = new THREE.Color();

  /** One frame of the editor deck. Mirrors what worldEnvironment.js does per frame. */
  function renderDeckFrame(P, dt) {
    const d = ensureDeck();
    _ambColor.copy(skyColors.horizon);
    d.update(P, {
      dt,
      camera,
      lightDir: sunDir,
      lightColor: _lightColor,
      lightIntensity: 3.0,
      ambientColor: _ambColor,
      ambientIntensity: 0.5,
      fog: { color: skyColors.horizon },
    });
    return d.tryRenderFrame({});
  }

  function hideDeck() {
    if (deck) deck.mesh.visible = false;
  }

  /** Average whole-frame GPU ms over `frames`, discarding a warm-up run. */
  async function timeGpu(renderOne, frames = 60, warmup = 20) {
    for (let i = 0; i < warmup; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      renderOne(1 / 60);
    }
    let acc = 0, n = 0;
    for (let i = 0; i < frames; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      renderOne(1 / 60);
      renderer.resolveTimestampsAsync(THREE.TimestampQuery.RENDER);
      const g = renderer.info.render.timestamp;
      if (g > 0) { acc += g; n++; }
    }
    return n ? acc / n : 0;
  }

  const GAME_LAYER = clouds.CLOUD_LAYER;
  const DECK_LAYER = 18; // CLOUD_LAYER in dayNightCloudLayer.js

  /** Baseline: the scene with no cloud system at all, straight to the canvas. */
  function renderNone() {
    clouds.mesh.visible = false;
    hideDeck();
    camera.layers.disable(GAME_LAYER);
    camera.layers.disable(DECK_LAYER);
    renderer.setRenderTarget(null);
    renderer.render(scene, camera);
  }

  function renderGame(dt) {
    hideDeck();
    clouds.params.enabled = true;
    clouds.update(dt, {
      sunDir,
      sunColor: 0xfff2dc,
      skyZenith: skyColors.zenith,
      skyHorizon: skyColors.horizon,
      hazeColor: skyColors.horizon,
    });
    clouds.renderFrame();
  }

  function makeDeckRenderer(P) {
    return (dt) => {
      clouds.mesh.visible = false;
      clouds.params.enabled = false;
      renderDeckFrame(P, dt);
    };
  }

  /**
   * @param {object[]} views [{ name, pos:[x,y,z], yaw, pitch }]
   * @param {function} applyView positions the camera
   * @param {object} deckParams params for the editor deck this pass
   */
  async function run({ views, applyView, deckParams, frames = 60, label = "" }) {
    const rows = [];
    for (const v of views) {
      applyView(v);
      await new Promise((r) => setTimeout(r, 500));

      const none = await timeGpu(renderNone, frames);
      const game = await timeGpu(renderGame, frames);
      const deckMs = await timeGpu(makeDeckRenderer(deckParams), frames);

      rows.push({
        view: v,
        label,
        sceneOnly: +none.toFixed(3),
        gameTotal: +game.toFixed(3),
        deckTotal: +deckMs.toFixed(3),
        gameCloudCost: +(game - none).toFixed(3),
        deckCloudCost: +(deckMs - none).toFixed(3),
      });
    }
    // Leave the game system active and the deck hidden.
    hideDeck();
    clouds.params.enabled = true;
    clouds.mesh.visible = true;
    camera.layers.enable(GAME_LAYER);
    return rows;
  }

  return {
    run,
    ensureDeck,
    hideDeck,
    renderDeckFrame,
    get deck() { return deck; },
    get blockingBakeMs() { return deck?.blockingBakeMs ?? 0; },
    EDITOR_DECK_DEFAULTS,
  };
}
