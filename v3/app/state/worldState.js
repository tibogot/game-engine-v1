import { createToolState } from "../../../v2/app/state/toolState.js";
import { OCEAN2_DEFAULTS } from "../../render/water/oceanSurface.js";

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
      // v2's additive multi-scatter hack washed the day sky toward white at 1.0;
      // v3's sky replaced it with an energy-conserving Ψms LUT (Hillaire), so
      // 1.0 now means "the physical amount" and stays the default.
      msAmount: 1.0,
      // Sun disc → emissive MRT scale (selective bloom; needs Post FX on).
      sunBloom: 1.0,
      // v2 ships βM×1.0 = 21e-6 — a HAZY day; the Mie aureole washed a third of
      // the sky white around the sun. 0.4 ≈ 8.4e-6 = clear day (verified in
      // browser: deep blue zenith, tight natural aureole).
      mie: 0.4,
      // With the haze gone the extra artistic glow reads doubled — v2's 0.55
      // was tuned to punch through βM 21e-6. Keep a modest kiss of it.
      sunGlowStrength: 0.25,
    },
    volumetricCloudDayNight: ts.volumetricCloudDayNight,
    cloudShadows: ts.cloudShadows,
    cloudGodRays: {
      ...ts.cloudGodRays,
      // Occlusion luminance gate (v3 god-rays pass) — see godRaysPass.js.
      occLumThreshold: 0.45,
    },
    cloudBloom: ts.cloudBloom,
    lensFlare: { ...ts.lensFlare, enabled: false },
    postFx: ts.postFx,
    csm: ts.csm,
    fog: ts.fog,
    interior: ts.interior,
    /*
     * TWO OCEANS, ONE SLICE.
     *
     * `mode` picks which shader draws: "classic" is oceanShader.js exactly as it
     * has always been, "v2" is oceanSurface.js (shoreline distance field,
     * travelling surf, transparent shallows). Default is classic, so nothing
     * about an existing project changes until the switch is thrown.
     *
     * The v2 params live in their own `v2` bag rather than beside the classic
     * ones because several names collide with DIFFERENT meanings — `foamCutoff`
     * is a 0..1 threshold in classic and a gain-normalised one in v2, and mixing
     * them would have each shader quietly corrupting the other's tuning. The
     * genuinely shared quantities (sea level, wind, swell, the clipmap LOD) stay
     * at the top level and are forwarded to whichever ocean is active.
     */
    worldOcean: {
      ...ts.worldOcean,
      mode: "classic",
      v2: structuredClone(OCEAN2_DEFAULTS),
    },
    audio: ts.audio,
  };
}
