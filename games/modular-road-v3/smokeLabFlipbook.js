import { ModularRoadDriftSmoke } from "./modularRoadDriftSmoke.js";
import {
  FlipbookDriftSmoke,
  DEFAULT_FLIPBOOK_SETTINGS,
  SMOKE_ATLASES,
  loadSmokeAtlases,
} from "./modularRoadDriftSmokeFlipbook.js";

/**
 * SMOKE-LAB ONLY glue. The flipbook look itself lives in the game module
 * (modularRoadDriftSmokeFlipbook.js), so what the lab tunes is what ships.
 *
 * The one thing added here is a lab-only fix: `update()` emits the lingering
 * bank from the base module's private `_rearPoints`, which only
 * `updateFromVehicle` fills. The lab calls `update()` directly, so those stay
 * at the world origin and the bank spawned there — invisible on a parked
 * burnout (the car sits on the origin), a pile of smoke in the middle of the
 * circle in donut mode. The game drives through `updateFromVehicle` and is
 * unaffected.
 */
const withLabRear = (Base) => class extends Base {
  /** @type {import("three").Vector3[] | null} set by the lab each frame */
  labRearPoints = null;

  _emit(emitter, cfg, rate, points, ...rest) {
    if (emitter === this.hazeEmitter && this.labRearPoints) points = this.labRearPoints;
    return super._emit(emitter, cfg, rate, points, ...rest);
  }
};

export const LabDriftSmoke = withLabRear(ModularRoadDriftSmoke);
export const LabFlipbookDriftSmoke = withLabRear(FlipbookDriftSmoke);
export { DEFAULT_FLIPBOOK_SETTINGS, SMOKE_ATLASES };

/** The game's atlases, awaited — the lab builds its A/B only once they are in. */
export async function loadLabAtlases() {
  const { textures, ready } = loadSmokeAtlases();
  await ready;
  return textures;
}
