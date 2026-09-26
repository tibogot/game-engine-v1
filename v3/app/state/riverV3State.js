/**
 * v3/app/state/riverV3State.js — River v3 tool state.
 *
 * River v3 is a NETWORK (riverV3Network.js): reaches joined at junctions. The
 * channel parameters and the water look are River v2's on purpose — the same
 * cross-section and the same surface shader, so v3 can replace v2 without the
 * map changing look. Only the solver fields that the network changes are new
 * (discharge-driven speed: `widthCoef`).
 */
import { RIVER_NODE_DEFAULTS, createRiverWaterState } from "./riverV2State.js";
import { V3_DEFAULTS } from "../../tools/riverV3/riverV3Network.js";

export function createRiverV3ToolState() {
  return {
    riverV3: {
      ...V3_DEFAULTS,

      // ── Authoring ──────────────────────────────────────────────────────────
      showHandles: true,
      /** Flow arrows: direction and speed; RED where the surface climbs. */
      showArrows: true,

      newWidth: RIVER_NODE_DEFAULTS.width,
      newDepth: RIVER_NODE_DEFAULTS.depth,
      newBank: RIVER_NODE_DEFAULTS.bank,

      /** Live values for the selected node, mirrored into the panel. */
      selWidth: RIVER_NODE_DEFAULTS.width,
      selDepth: RIVER_NODE_DEFAULTS.depth,
      selBank: RIVER_NODE_DEFAULTS.bank,
      selLevel: 0,

      // ── Surface mesh (as River v2) ─────────────────────────────────────────
      surfaceDrop: 0.05,
      meshStep: 0.8,
      meshAcross: 12,

      water: createRiverWaterState(),
    },
  };
}
