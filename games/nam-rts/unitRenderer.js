// Moved to games/shared-rts/unitRenderer.js (machinery both RTS games use,
// 2026-09-27). This game's unit list and its vehicles built in code go in
// here, so every caller in nam works unchanged.
import { buildM113, buildM151, buildM35, buildM48, buildM551, buildMolotova, buildPT76, buildUH1 } from "../../v3/render/objects/rtsVehicles.js";
import { UNIT_TYPES, UNIT_TYPE_KEYS } from "./unitTypes.js";
import { createUnitRenderer as createSharedUnitRenderer } from "../shared-rts/unitRenderer.js";

export * from "../shared-rts/unitRenderer.js";

/** Vehicles built in code, by a unit type's `procedural` key. */
export const PROCEDURAL_VEHICLES = {
  m113: () => buildM113(), m48: () => buildM48(), m151: () => buildM151(), uh1: () => buildUH1(),
  m551: () => buildM551(), m35: () => buildM35(), pt76: () => buildPT76(), molotova: () => buildMolotova(),
};

export function createUnitRenderer(opts = {}) {
  return createSharedUnitRenderer({ types: UNIT_TYPES, typeKeys: UNIT_TYPE_KEYS, procedural: PROCEDURAL_VEHICLES, ...opts });
}
