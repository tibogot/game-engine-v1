// Moved to games/shared-rts/units.js (machinery both RTS games use,
// 2026-09-27). This game's unit list goes in here, so every caller in nam
// works unchanged.
import { UNIT_TYPES, UNIT_TYPE_KEYS } from "./unitTypes.js";
import { createUnits as createSharedUnits } from "../shared-rts/units.js";

export * from "../shared-rts/units.js";

export function createUnits(opts = {}) {
  return createSharedUnits({ types: UNIT_TYPES, typeKeys: UNIT_TYPE_KEYS, ...opts });
}
