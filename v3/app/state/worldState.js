import { createToolState } from "../../../v2/app/state/toolState.js";

/** World-tab toolState slice — same defaults as v2 createToolState(). */
export function createWorldToolState() {
  const ts = createToolState();
  return {
    light: ts.light,
    skyMode: ts.skyMode,
    skyExposureByMode: ts.skyExposureByMode,
    physicalSky: ts.physicalSky,
    // V3 optimized sky (lab dayNightSky.js): astronomical arc + sky-view LUT +
    // smooth-horizon band fix. These params don't exist in v2's frozen toolState.
    proceduralSky: {
      ...ts.proceduralSky,
      latitude: 45, // observer latitude (°) — tilts the sun/moon arc
      dayOfYear: 172, // 1..365 → solar declination (172 ≈ N summer solstice)
      moonAge: 0.55, // synodic age 0=new .5=full 1=new → moon position + phase
      useLut: true, // sample the pre-baked sky-view LUT (perf)
      atmoHorizonSoft: 0.05, // soft terminator width — kills twilight banding
      // v2 shipped msAmount:0 because multi-scatter caused twilight bands. The
      // smooth-horizon fix in this sky module removes them, so re-enable the
      // bright-horizon glow by default in v3.
      msAmount: 1.0,
    },
    volumetricCloudDayNight: ts.volumetricCloudDayNight,
    cloudShadows: ts.cloudShadows,
    cloudGodRays: ts.cloudGodRays,
    cloudBloom: ts.cloudBloom,
    lensFlare: { ...ts.lensFlare, enabled: false },
    postFx: ts.postFx,
    csm: ts.csm,
    fog: ts.fog,
    interior: ts.interior,
    worldOcean: ts.worldOcean,
    audio: ts.audio,
  };
}
