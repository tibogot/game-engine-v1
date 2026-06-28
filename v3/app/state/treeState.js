import { createToolState } from "../../../v2/app/state/toolState.js";

/** Tree-mode toolState slice — same defaults as v2 createToolState(). */
export function createTreeToolState() {
  const ts = createToolState();
  return {
    brush: ts.brush,
    treePaint: ts.treePaint,
    treeSlots: ts.treeSlots,
    treeLod: ts.treeLod,
    foliageLod: ts.foliageLod,
  };
}
