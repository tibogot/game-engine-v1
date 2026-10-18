// The prototypes' ONE car tune, applied to the old car's module objects by every page and test that
// drives it (drive page, builder prediction, Node tests), so a prediction is the car you drive.
// The wheel: the old car writes WHEEL.radius/thickness from the wheel MODEL (setWheelStyle("glb")), so
// the drive page's car rolled on 0.374 m wheels and the builder's on the 0.36 m default — on a flip
// ramp's curl that was 146 vs 119 km/h at the lip (2026-10-18). The real build splits look from physics.
export const CAR_TUNE = {
  top: 63, // m/s (P3 speed step)
  substeps: 3, // 1/360 s: ≤ 0.25 m of travel per substep up to 90 m/s
  wheel: { radius: 0.3741902709007263, thickness: 0.2930562549199661 }, // the GLB wheel's, measured
};

export function applyCarTune({ TIRE, WHEEL }, top = CAR_TUNE.top) {
  TIRE.topSpeed = top;
  TIRE.steerSpeedRef = top * 0.9; // "full reduction should land AT top speed" (old: 45 for 50)
  WHEEL.radius = CAR_TUNE.wheel.radius;
  WHEEL.thickness = CAR_TUNE.wheel.thickness;
}
