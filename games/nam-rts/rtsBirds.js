// nam's birds — the shared engine (games/shared-rts/rtsBirds.js, moved there
// 2026-09-27) with THIS game's species: white egrets in a V, crows, hornbills
// over the canopy; egrets (and now and then a grey heron) standing on the open
// banks. Every caller in nam works unchanged.
import { SPECIES, birdShapes } from "./birdShapes.js";
import { createRtsBirds as createSharedRtsBirds } from "../shared-rts/rtsBirds.js";

export { RTS_BIRD_PARAMS } from "../shared-rts/rtsBirds.js";

/** nam's birds, in the shared engine's terms (shapes by index: birdShapes.js). */
export const NAM_BIRDS = {
  shapes: birdShapes,
  species: SPECIES,
  standingFrom: 3,
  kinds: {
    // White egrets in a loose V (the rice-paddy image) — half the crossings.
    egret: { shape: 0, n: [7, 15], formation: "v", weight: 0.5 },
    crow: { shape: 1, n: [6, 13], formation: "straggle", weight: 0.3 },
    // Hornbills in ones and twos, over the canopy, a little slower.
    hornbill: { shape: 2, n: [3, 5], formation: "line", altAdd: 8, speedMul: 0.8, weight: 0.2 },
  },
  lander: "egret",
  standing: [[3, 0.82], [4, 0.18]],          // mostly egrets, now and then a heron
  flushKinds: (size) => ["egret", "crow", size >= 16 ? "hornbill" : "egret"],
};

export function createRtsBirds(opts = {}) {
  return createSharedRtsBirds({ birds: NAM_BIRDS, ...opts });
}
