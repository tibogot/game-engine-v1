import { makeLedMatrixMaterial } from "./ledMatrix.js";

/**
 * Legacy entry point for the emissive LED-board material (trackside billboard +
 * overhead gantry). The shader itself now lives in ./ledMatrix.js, which every
 * board in the registry shares; this only adapts the older param names.
 *
 * The mapping is implicit — resolveMode/resolveShape/resolveGrid in ledMatrix.js
 * already fall back to `boardMode`, `boardShape` and `dotPitch`. `useRamp: false`
 * selects the flat-tint brightness ramp these boards were authored against,
 * rather than the LED matrix board's core→rim gradient.
 *
 * Expected params (all optional, sensible fallbacks):
 *   boardMode   "checker" | "chevron" | "lights"
 *   boardShape  "round" | "square" | "diamond" | "solid"
 *   dotPitch, dotRadius, emissive, offLevel
 *   checkerSize, boardColorA, boardColorB
 *   chevronSpacing, chevronSkew, chevronDuty, chevronColor, panSpeed
 *   lightColor
 *
 * Build it ONCE per object and share it across every board in the run — it is
 * fully uniform-driven, so a per-unit material would only buy duplicate shader
 * compiles.
 */
export function makeLedBoardMaterial(p, boardW, boardH) {
  return makeLedMatrixMaterial({
    boardW,
    boardH,
    params: { ...p, useRamp: false },
  });
}
