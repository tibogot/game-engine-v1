import { createDepthWaterState, depthWaterParams } from "./depthWaterState.js";
import { createLakebedState } from "./lakebedState.js";

/**
 * Lake toolState slice.
 *
 * Bounds and water level are PER-LAKE (stored in LakeSystem). Everything under
 * `.water` is shared by every lake in the scene, the same way all rivers share one
 * material slice. One params set means one shader program and one material for the
 * whole system.
 *
 * `.water` has the same shape as River+'s Depth-style state (see depthWaterState.js),
 * but the VALUES are independent — a lake is deep and still, a river is shallow and
 * flows.
 */
export function createLakeToolState() {
  return {
    lake: {
      activeIndex: 0,
      showBounds: true,

      /**
       * Global kill-switch for SSR on ALL water — lakes and rivers. Lives on the lake
       * slice because lakes own the water settings, but the River+ panel edits the
       * same value through main.js's `waterGlobals` accessor.
       */
      ssrMaster: true,

      /** Lake drift direction, degrees clockwise from +X. Rivers flow downstream instead. */
      flowAngle: 0,
      flowSpeed: 0.1,

      water: createDepthWaterState(),

      /**
       * Underwater TERRAIN shading (sand + depth tint + caustics), rendered by the
       * terrain shader, not the water. Global: follows every water surface — lakes
       * and River+ alike — via the shared water-surface map.
       */
      lakebed: createLakebedState(),
    },
  };
}

/** toolState.lake -> createLakeMaterial params. */
export function lakeParamsFromToolState(lp) {
  const a = (lp.flowAngle * Math.PI) / 180;
  return {
    ...depthWaterParams(lp.water),
    flowSpeed: lp.flowSpeed,
    flowDir:   [Math.cos(a), Math.sin(a)],
  };
}
