import { createToolState } from "../../../v2/app/state/toolState.js";

/** Foliage-mode toolState slice — same defaults as v2 createToolState().
 *  Own brush instance so foliage radius/strength don't fight tree mode. */
export function createFoliageToolState() {
  const ts = createToolState();
  return {
    brush: ts.brush,
    foliagePaint: ts.foliagePaint,
    foliageSlots: ts.foliageSlots,
    billboardFoliageLod: ts.billboardFoliageLod,
  };
}
