import { createToolState } from "../../../v2/app/state/toolState.js";

/** World-tab toolState slice — same defaults as v2 createToolState(). */
export function createWorldToolState() {
  const ts = createToolState();
  return {
    light: ts.light,
    skyMode: ts.skyMode,
    skyExposureByMode: ts.skyExposureByMode,
    physicalSky: ts.physicalSky,
    proceduralSky: ts.proceduralSky,
    volumetricCloudDayNight: ts.volumetricCloudDayNight,
    cloudShadows: ts.cloudShadows,
    cloudGodRays: ts.cloudGodRays,
    cloudBloom: ts.cloudBloom,
    lensFlare: ts.lensFlare,
    postFx: ts.postFx,
    csm: ts.csm,
    fog: ts.fog,
    interior: ts.interior,
    worldOcean: ts.worldOcean,
    audio: ts.audio,
  };
}
