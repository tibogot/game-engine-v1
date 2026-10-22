// The prototypes' ONE car tune, applied to the old car's module objects by every page and test that
// drives it (drive page, builder prediction, Node tests), so a prediction is the car you drive.
// The wheel: the old car writes WHEEL.radius/thickness from the wheel MODEL (setWheelStyle("glb")), so
// the drive page's car rolled on 0.374 m wheels and the builder's on the 0.36 m default — on a flip
// ramp's curl that was 146 vs 119 km/h at the lip (2026-10-18). The real build splits look from physics.
export const CAR_TUNE = {
  top: 63, // m/s (P3 speed step)
  substeps: 3, // 1/360 s: ≤ 0.25 m of travel per substep up to 90 m/s
  wheel: { radius: 0.3741902709007263, thickness: 0.2930562549199661 }, // the GLB wheel's, measured
  // WALLS GLANCE, THEY DON'T STOP THE CAR (Apex Rush's biggest complaint; wallTest.mjs on our rail, the
  // rail alone, throttle held). The old car's values were for Apex Rush's 40 m/s: a 20° clip at 216 km/h
  // pushes 20 m/s into the rail, over its 18 m/s CRASH line — assists off, 53% of the speed kept, up to
  // 115° of roll — and mu 0.45 scrubbed the slide along the rail. Now: 5–30° keep 85–99% and stay
  // straight and upright; 45° keeps 74%, 60° 56%, head-on stops. A rail NEVER tumbles the car (the speed
  // is the price, as in Trackmania); roof slams still crash (CRASH.roofSpeed, untouched).
  railMu: 0.15,
  railCrashSpeed: Infinity,
};

export function applyCarTune({ TIRE, WHEEL, SOLID, CRASH }, top = CAR_TUNE.top) {
  TIRE.topSpeed = top;
  TIRE.analogPedals = true; // the pad's triggers are pedals, not buttons (the physics review, 2026-10-23)
  TIRE.steerSpeedRef = top * 0.9; // "full reduction should land AT top speed" (old: 45 for 50)
  WHEEL.radius = CAR_TUNE.wheel.radius;
  WHEEL.thickness = CAR_TUNE.wheel.thickness;
  if (SOLID) SOLID.mu = CAR_TUNE.railMu;
  if (CRASH) CRASH.wallSpeed = CAR_TUNE.railCrashSpeed;
}
