// FIRMAMENT — the engine's global sky (v3/render/firmament/). Forked 2026-11-01 from Sky Pro
// (v3/render/skypro/skyproSky.js, which stays frozen as the reference). Lab: v3/firmament-lab.html.
//
// SKY PRO — the sky mode, as one object the engine drives (v3/app/worldEnvironment.js, skyMode "skypro").
//
// Everything in it is its own, on purpose (user's decision, 2026-09-28): Tidewater's atmosphere
// (skyproAtmosphere.js — NOT skyAtmosphere.js / dayNightSky.js), the Sky Pro cumulus
// (skyproClouds.js), Tidewater's cirrus (skyproCirrus.js) and a sky environment baked from them
// (skyproEnv.js). The other sky modes are untouched and share nothing with it. MIT, Copyright (c) 2026
// DRG Software Solutions LLC — see v3/skypro-real/tidewater/LICENSE.
//
// What the engine gets:
//   const s = createFirmamentSky( { renderer, camera, params } ); await s.ready;
//   scene.add( s.mesh )              the dome: sky + sun, moon and stars + cumulus + cirrus
//                                    (Tidewater Sky.js skyViewRadiance with the cirrus layered behind
//                                    the cumulus, as its Clouds.js did)
//   s.update( dt, { sunDir, moonDir, night, drawingBufferSize } )   the per-frame work (bakes, cloud
//                                    trace, environment); sunDir = the REAL sun, from the engine's clock
//   s.light()                        what the world should be lit by, in Tidewater's units:
//                                    { sunColor [lin rgb], skyIrradiance, horizon, keyIsMoon, moonColor,
//                                      keyDir (Vector3 toward the key light: the sun, or the moon at night) }
//   s.environment                    the texture for scene.environment (three runs its PMREM)
//   s.params                         the live settings (FIRMAMENT_DEFAULTS' shape; the editor binds it)
//   s.dispose()
//
//   s.postProcess( rt, { depthTex, light, shadowDepth } )   the air haze and sun shafts
//                                    (skyproHaze.js) on the linear HDR frame in rt, written back
//                                    into it; depthTex = the scene depth, light + shadowDepth =
//                                    a directional light and its shadow map (optional)
//   s.cloudShadow                    { texture, center, size, strength }: the cumulus shadow
//                                    map over the ground, for the sun's colorNode

import * as THREE from "three/webgpu";
import { Fn, uniform, vec2, vec3, vec4, float, normalize, positionWorld, cameraPosition, max, min, exp, mix, smoothstep, screenUV, texture, uv } from "three/tsl";
import { createFirmamentAtmosphere } from "./firmamentAtmosphere.js";
import { createFirmamentClouds } from "./firmamentClouds.js";
import { createCirrus, clOver } from "./firmamentCirrus.js";
import { createSkyEnvironment } from "./firmamentEnv.js";
import { createAirHaze } from "./firmamentHaze.js";
import { createFirmamentExposure } from "./firmamentExposure.js";
import { sunDirection, moonDirection, moonIllumination } from "./firmamentCelestial.js";

/** The settings the mode saves with a project (toolState.skyProSky). */
export const FIRMAMENT_DEFAULTS = {
  /**
   * The sun's strength against the sky, day only (worldEnvironment reads it; alg-rts
   * sets 0.55 for CoH-like shade). A default key so a level that saves it keeps it:
   * the look loader merges only keys that exist here (2026-10-17).
   */
  sunScale: 1,
  /**
   * FIRMAMENT: the sun disc's DIAMETER in degrees (Unreal's "source angle"). The real sun is 0.53°;
   * Tidewater drew it 1.15x that (0.616°, the default, so the A/B against Sky Pro stays exact). Games
   * often draw it 2-4x real: a true-size sun reads tiny on screen. Look only: the light is unchanged.
   */
  sunSizeDeg: 2 * 0.004675 * 1.15 * 180 / Math.PI,
  /** FIRMAMENT: the moon disc's diameter in degrees (Tidewater 0.55°; the real moon 0.52°) */
  moonSizeDeg: 2 * 0.0048 * 180 / Math.PI,

  // ---- FIRMAMENT: the clock and the place (used when the host does not pass a sunDir to update)
  /** local SOLAR time, hours (12 = the sun at its highest) */
  timeOfDay: 16.2,
  /** 1..365; 96 (early April) + latitude 24 = Tidewater's fixed sun path */
  dayOfYear: 96,
  /** degrees, + north */
  latitude: 24,
  /**
   * true = the moon where the date puts it, lit by phase (it can be new, or below the horizon all
   * night: dark nights); false = Tidewater's moon, always opposite the sun, always up, always full
   */
  realMoon: false,
  /** days since the new moon (0..29.5): 7.4 first quarter, 14.8 full, 22.1 last quarter */
  moonAge: 14.8,
  /** -1 = the phase from the real sun; 0..1 = an art choice (0 new, 0.5 quarter, 1 full), the moon stays where it is */
  moonPhase: -1,

  // ---- FIRMAMENT: the air (the atmosphere's medium; 1 / 1 / 1.2 / 0.8 / 1 / 0 = Tidewater's)
  /** Rayleigh: the blue of the sky (more = deeper blue and redder sunsets, less = a pale high-altitude sky) */
  airDensity: 1,
  /**
   * Mie aerosols (haze, humidity, pollution, dust): more = whiter sky, a bigger glow round the sun.
   * x Tidewater's very clean air (optical depth 0.005): 6 = clean, 30 = hazy, 45 + height 3 = dusty
   */
  aerosols: 1,
  /** km, how high the aerosols reach (1.2 humid sea air; 2-4 desert dust lifted by the wind) */
  aerosolHeight: 1.2,
  /** the aerosols' forward scattering, 0..0.95: higher = a tighter, brighter glow round the sun */
  sunGlow: 0.8,
  /** ozone: the blue of the zenith at twilight */
  ozone: 1,
  /** mineral dust in the aerosols, 0..1+: absorbs blue, browns the sky (use with more aerosols) */
  dust: 0,
  /** cumulus cover (the "Partly cloudy" preset's shell coverage) */
  coverage: 0.49,

  // ---- FIRMAMENT: cloud types (firmamentClouds.js scTypedTop; these defaults = Sky Pro's cumulus)
  /** 0 = a flat stratus sheet (overcast), 0.5 = cumulus, 1 = towering storm clouds (cumulonimbus) */
  cloudType: 0.5,
  /** 0..1: how much the type changes from place to place (~10 km patches) */
  typeVariation: 0,
  /** how high a storm cloud's top reaches, as a fraction of the deck (0.95 = near its ceiling) */
  towerTop: 0.95,
  /** how far a storm cloud's top spreads out (the anvil) */
  anvil: 0.25,
  /** a stratus sheet's depth, as a fraction of the deck's thickness */
  stratusThickness: 0.06,
  /** 0..1: denser, darker, rain-heavy clouds (storms add their own) */
  wetness: 0,
  /** m: the cloud deck's base and thickness (Sky Pro: 4000 / 5200) */
  cloudBase: 4000,
  cloudThickness: 5200,
  // ---- FIRMAMENT: a weather front — clear on one side, covered on the other, a storm line between
  /** extra coverage behind the front (0 = no front) */
  frontCoverage: 0,
  /** storm clouds along its edge (0..1) */
  frontStorm: 0,
  /** degrees: the direction the front faces (its clear side); m: its position along that line; m: its width */
  frontDeg: 0,
  frontPos: 0,
  frontWidth: 8000,
  /** m/s the front advances (toward its clear side: the weather moving in); 0 = parked */
  frontSpeed: 0,

  // ---- FIRMAMENT: THE CLOUD LOOK — Sky Pro's cloud model, every knob (CLOUD_MODEL_MAP below; these
  // defaults = its "Partly cloudy" exactly). What a look like a storm or a sunset is tuned with.
  /** extinction per m at full density: how opaque / dark-cored the clouds are */
  cloudDensity: 0.019,
  /** soft edges (deck fraction at the base; constant in metres whatever the deck's thickness) */
  edgeSoftness: 0.095,
  /** m: the size of the cloud shapes' noise (bigger = bigger, smoother masses) */
  cloudScale: 7500,
  /** how much the shape noise swells the tops (lumpier, taller heads) */
  cloudDilation: 0.69,
  /** the erosion noise's size vs the shape noise (smaller = finer detail) */
  erosionScale: 0.13,
  /** erosion at the base and at the top (the top's high = cauliflower heads) */
  erosionBase: 0.24,
  erosionTop: 2.15,
  /** 0 = wispy erosion, 1 = billowy */
  erosionShape: 1,
  /** how much weather a cloud's base needs (higher = narrower bases than bodies) */
  baseRequired: 0.54,
  /** m: the size of the weather map's tile (cloud fields' spacing) */
  weatherScale: 29000,
  /** the weather map: overall bias, the main masses' contrast, the fine detail */
  weatherBias: 0.26,
  weatherContrast: 1.32,
  weatherDetail: 0.13,
  /** extra coverage toward the horizon */
  horizonCoverage: 0.12,
  /** scattering albedo (1 = white clouds, lower = darker, sootier) */
  cloudAlbedo: 1,
  /** the powder effect (dark edges facing the sun): 0..1 */
  powder: 0.7,
  /** the sky light inside the clouds (their shaded sides) */
  cloudAmbient: 0.7,
  /** multiple scattering (brighter, softer interiors) */
  multiScatter: 0.99,
  /** the darkening of the clouds' bases (their own shadow), 0..1 */
  baseShadow: 0.88,
  /** the ground's light bounced up onto the bases (x Sky Pro's) */
  bounce: 1,
  /** m: where distant clouds start / finish melting into the sky (Sky Pro 25 / 45 km; flight wants more) */
  meltStart: 25000,
  meltEnd: 45000,
  /** m: the air between the eye and the clouds (aerial perspective distance; Sky Pro 30 km) */
  cloudAP: 30000,
  /** m/s at the deck: Tidewater 12; the Sky Pro preset's own drift (a time-lapse) is 89 */
  windSpeed: 12,
  /** degrees, the direction the wind blows toward (atan2 of Tidewater's default wind) */
  windDeg: Math.round(Math.atan2(0.94, 0.35) * 180 / Math.PI),
  /** cirrus amount, Tidewater's 0..1 (0 = off); higher is a thicker veil than Tidewater allowed */
  cirrus: 0.5,
  cirrusAlt: 9000,
  /** Tidewater hides clouds below the horizon; off = clouds seen from above and inside the deck */
  horizonMask: false,
  /** Tidewater's exposure for its units (the engine's exposure follows it while this sky is shown) */
  exposure: 0.55,
  /** Tidewater's eye adaptation on top of `exposure` (skyproExposure.js): x0.6..x6, at most x2 at night */
  autoExposure: true,
  /** the eye adaptation's target luminance (Tidewater's 0.25); a game may aim brighter (alg: see algGame) */
  aeRefLum: 0.25,
  /**
   * THE NIGHT LOOK — a layer on top of the faithful Tidewater night, never part of it. Off = the
   * night exactly as Tidewater draws it.
   */
  nightLook: false,
  /** night look: extra exposure at full night, in stops (eased with the adaptation) */
  nightEV: 1.0,
  /**
   * night look: the moon's height in degrees; 0 = Tidewater's (opposite the sun, lifted to >= ~14°,
   * ~59° at 23 h). A glitter path that reaches the horizon needs a low moon (~10-25°); 18 keeps the
   * path and still lights the land for a high RTS camera (12 left it near black).
   */
  moonElev: 18,
  /** night look: the moon's azimuth, degrees turned from Tidewater's (opposite the sun) */
  moonAzim: 0,
  /**
   * night look: the Purkinje grade (rod vision: the darks drain of colour and shift blue, bright
   * things keep theirs), 0..1, eased in with the night
   */
  nightGrade: 0.6,
  /** night look: how blue the rod response reads: 0 = only desaturated, 1 = rod blue, 2 = stronger */
  nightBlue: 0.8,
  /** night look, the sky (skyproAtmosphere skyNightLookP / skyStarsP; Tidewater's sky = 0, 0, 1, 1, 1, 1, 0) */
  nightHalo: 1.0,        // more glow round the moon (its aureole), added
  nightHorizon: 1.0,     // a faint glow low on the horizon, added
  nightStars: 1.5,       // star brightness x
  nightStarSize: 1.3,    // star size x (same light, spread wider: reads bigger, not whiter)
  nightStarDensity: 2.0, // how many stars x
  nightMilkyWay: 3.0,    // the Milky Way's glow x
  nightRing: 0,          // the 22° ring round the moon of a hazy night, 0..1
  nightCloudMoon: 2.0,   // the moonlight on the clouds only x (silver edges near the moon; the world's is unchanged)
  /** the lower hemisphere of the sky light (a flat ground of this albedo) */
  groundAlbedo: "#54493a",
  /** air haze density (Tidewater AirHaze: marine + aerosol layers); 0 = no haze pass at all */
  haze: 1.6,
  /** sun shafts through the shadow map and the cloud shadow, 0..1 (Tidewater 1) */
  shafts: 1.0,
  /** screen-space god rays round a low sun in view */
  godRays: true,
  /**
   * INTERNAL (no control): the world's lights from before this sky took them over, restored
   * when the mode is left. Kept HERE, in the saved slice, not in memory: the editor persists
   * its lights, so after a reload in this mode the saved lights ARE this sky's, and a snapshot
   * held in memory would be gone — leaving the mode would strand the other skies under a sun
   * of ~10 (Tidewater's units) instead of the ~2 they were tuned with. null = none taken.
   */
  savedLight: null,
};

/**
 * The night look's two styles (chosen 2026-10-04 at the bay shot): "realistic" is the default (a
 * moonlit night, the sea and the moon path carry the frame); "cinematic" is day-for-night (all of it
 * readable in deep blue). The panel's buttons set these; the sliders stay free after.
 */
export const FIRMAMENT_NIGHT_STYLES = {
  realistic: {
    nightEV: 1.0, nightGrade: 0.6, nightBlue: 0.8,
    nightHalo: 1.0, nightHorizon: 1.0, nightStars: 1.5, nightStarSize: 1.3, nightStarDensity: 2.0, nightMilkyWay: 3.0, nightCloudMoon: 2.0,
  },
  cinematic: {
    nightEV: 2.0, nightGrade: 1.0, nightBlue: 1.6,
    nightHalo: 1.6, nightHorizon: 1.6, nightStars: 2.2, nightStarSize: 1.5, nightStarDensity: 2.6, nightMilkyWay: 5.0, nightCloudMoon: 2.6,
  },
};

/**
 * FIRMAMENT: air presets (the atmosphere's medium + the ground haze pass). A starting point the
 * sliders stay free after. "humid" = Tidewater's tropical coast, the defaults.
 */
// Aerosol optical depth (vertical, the haze's thickness) = 4.44e-3/km x aerosolHeight x aerosols:
// Tidewater's 1 x 1.2 km = 0.005, a very clean sky (its haze pass carries the low haze instead). Real
// skies: clean ~0.05, hazy summer ~0.15-0.3, desert dust 0.5-1+.
/**
 * FIRMAMENT: WHOLE LOOKS — the sky, the air, the clouds, the hour and the exposure in one. Each is a
 * delta over FIRMAMENT_DEFAULTS (applyFirmamentLook resets to the defaults first). Tuned BY EYE
 * (2026-11-02) side by side with the original Sky Pro's public demo (threejsskypro.com, v2.2.1) at the
 * same hour and framing — its preset VALUES are not used (a paid product; not taken from its code).
 * exposure = 0.55 x the demo's shown exposure factor.
 */
export const FIRMAMENT_LOOKS = {
  partlyCloudy: { timeOfDay: 14.98 },
  fluffy: { timeOfDay: 14.98, coverage: 0.6, weatherBias: 0.1, cloudScale: 11500, weatherScale: 42000, edgeSoftness: 0.11, cloudAmbient: 0.8, aerosols: 4, sunSizeDeg: 1.2 },
  hazy: { timeOfDay: 10.85, coverage: 0.5, weatherBias: 0.5, weatherContrast: 0.4, cloudDensity: 0.006, edgeSoftness: 0.25, cloudType: 0.2, stratusThickness: 0.15, aerosols: 30, haze: 3 },
  moonlitNight: { timeOfDay: 4.03, nightLook: true, moonElev: 42, moonPhase: 0.22, moonSizeDeg: 1.3, coverage: 0.6, weatherBias: 0.15, nightHalo: 4, nightCloudMoon: 14, nightEV: 1.5, nightStars: 0.9, nightStarDensity: 1.2 },
  stylized: { timeOfDay: 14.98, coverage: 0.47, cloudScale: 6000, edgeSoftness: 0.07, erosionTop: 3, baseRequired: 0.8, multiScatter: 1.3, cloudAmbient: 1.0, airDensity: 0.85 },
  stormyEvening: { timeOfDay: 10.85, coverage: 0.58, weatherBias: 0.2, cloudScale: 12000, cloudDensity: 0.05, cloudAlbedo: 0.6, cloudAmbient: 0.35, aerosols: 70, aerosolHeight: 2.5, dust: 0.45, haze: 2.5, cloudAP: 90000 },
  sunset: { timeOfDay: 18.15, coverage: 0.55, cloudBase: 3000, cloudThickness: 3000, cloudScale: 6000, weatherContrast: 0.9, weatherBias: 0.3, cloudDensity: 0.05, aerosols: 12, exposure: 0.55 * 1.46 },
  thunderstorm: { timeOfDay: 10.85, coverage: 0.64, weatherBias: 0.3, weatherContrast: 1.3, cloudBase: 1500, cloudThickness: 5500, cloudDensity: 0.045, cloudAmbient: 0.3, multiScatter: 0.5, cloudScale: 9000, haze: 2.0, aerosols: 30, aerosolHeight: 2, dust: 0.7, cloudAP: 90000, baseShadow: 0.95, exposure: 0.55 * 0.52 },
};
/** Reset `params` to the defaults (but the saved lights) and apply a look. */
export function applyFirmamentLook(params, name) {
  for (const [k, v] of Object.entries(FIRMAMENT_DEFAULTS)) if (k !== "savedLight") params[k] = Array.isArray(v) ? [...v] : v;
  Object.assign(params, FIRMAMENT_LOOKS[name] || {});
  return params;
}

/**
 * FIRMAMENT: cloud presets (a starting point; the sliders stay free after). "fair" = Sky Pro's
 * "Partly cloudy" exactly. The front preset parks a front 15 km east of the origin (its clear side
 * faces west, so the afternoon sun lights the storm wall).
 */
export const FIRMAMENT_CLOUD_PRESETS = {
  fair: { coverage: 0.49, cloudType: 0.5, typeVariation: 0, wetness: 0, cloudBase: 4000, cloudThickness: 5200, towerTop: 0.95, anvil: 0.25, stratusThickness: 0.06, frontCoverage: 0, frontStorm: 0, frontSpeed: 0 },
  lowCumulus: { coverage: 0.5, cloudType: 0.5, typeVariation: 0.25, wetness: 0, cloudBase: 1500, cloudThickness: 4500, towerTop: 0.95, anvil: 0.25, stratusThickness: 0.06, frontCoverage: 0, frontStorm: 0, frontSpeed: 0 },
  mixed: { coverage: 0.55, cloudType: 0.5, typeVariation: 0.7, wetness: 0.1, cloudBase: 1800, cloudThickness: 7000, towerTop: 0.9, anvil: 0.3, stratusThickness: 0.06, frontCoverage: 0, frontStorm: 0, frontSpeed: 0 },
  overcast: { coverage: 1.0, cloudType: 0.08, typeVariation: 0.12, wetness: 0.35, cloudBase: 1200, cloudThickness: 3000, towerTop: 0.95, anvil: 0.25, stratusThickness: 0.14, frontCoverage: 0, frontStorm: 0, frontSpeed: 0 },
  storm: { coverage: 0.47, cloudType: 0.85, typeVariation: 0.3, wetness: 0.5, cloudBase: 1500, cloudThickness: 9500, towerTop: 0.95, anvil: 0.35, stratusThickness: 0.06, frontCoverage: 0, frontStorm: 0, frontSpeed: 0 },
  front: { coverage: 0.42, cloudType: 0.5, typeVariation: 0.2, wetness: 0, cloudBase: 1800, cloudThickness: 8000, towerTop: 0.9, anvil: 0.3, stratusThickness: 0.08, frontCoverage: 0.45, frontStorm: 0.6, frontDeg: 180, frontPos: -15000, frontWidth: 8000, frontSpeed: 0 },
};

export const FIRMAMENT_AIR_PRESETS = {
  humid: { airDensity: 1, aerosols: 1, aerosolHeight: 1.2, sunGlow: 0.8, ozone: 1, dust: 0, haze: 1.6 },
  clear: { airDensity: 1, aerosols: 6, aerosolHeight: 1.2, sunGlow: 0.76, ozone: 1, dust: 0, haze: 0.5 },   // AOD 0.03
  hazy: { airDensity: 1, aerosols: 30, aerosolHeight: 1.6, sunGlow: 0.75, ozone: 1, dust: 0, haze: 2.4 },  // AOD 0.21
  desert: { airDensity: 1, aerosols: 35, aerosolHeight: 2.5, sunGlow: 0.72, ozone: 1, dust: 0.8, haze: 2.0 },   // AOD 0.39
};

const SKY_RADIUS = 4000;

/**
 * light().groundE at noon (Tidewater's sun path, 12 h; measured 2026-10-03): the reference the
 * engine's fog colours are authored against. Sky Pro's atmosphere has no live parameters, so it is
 * a constant.
 */
export const FIRMAMENT_NOON_GROUND_E = [3.22, 3.08, 2.97];

/**
 * Tidewater sky/Sky.js sunDirectionFromTime: the sun's direction at `hours` (latitude 24°, declination
 * 6°; +x east, -z north, y up). Writes `out`.
 */
export function firmamentSunFromTime(hours, out, latitudeDeg = 24, declinationDeg = 6) {
  const phi = latitudeDeg * Math.PI / 180;
  const dec = declinationDeg * Math.PI / 180;
  const H = (hours - 12) * 15 * Math.PI / 180;
  const east = -Math.cos(dec) * Math.sin(H);
  const north = Math.cos(phi) * Math.sin(dec) - Math.sin(phi) * Math.cos(dec) * Math.cos(H);
  const up = Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H);
  return out.set(east, up, -north).normalize();
}

/**
 * Tidewater App.updateSun: the key light's direction for a sun direction. The sun until it is well
 * below the horizon (it gives no direct light in twilight anyway), then the moon — opposite the sun
 * in azimuth, lifted so it always stands at least ~14 deg up. Writes `out`, returns whether it is the moon.
 */
export function firmamentKeyDir(sunDir, out) {
  const keyIsMoon = sunDir.y <= -0.07;
  if (keyIsMoon) out.set(-sunDir.x, Math.abs(sunDir.y) * 0.8 + 0.25, -sunDir.z).normalize();
  else out.copy(sunDir);
  return keyIsMoon;
}

/**
 * @param {object} o
 * @param {THREE.WebGPURenderer} o.renderer
 * @param {THREE.PerspectiveCamera} o.camera
 * @param {object} [o.params]  live settings (merged over FIRMAMENT_DEFAULTS; the object is KEPT, not copied)
 */
/** FIRMAMENT: the flat cloud-look settings -> the clouds' live model (firmamentClouds api.model). */
const BOUNCE_ALBEDO = [0.009134058699157796, 0.015208514418949472, 0.018500220124016652];   // Sky Pro's
function applyCloudModel(m, P) {
  const s = m.shape, l = m.lighting;
  s.density = Math.max(0, P.cloudDensity);
  s.edgeSoftness = Math.max(0.001, P.edgeSoftness);
  s.baseScale = Math.max(100, P.cloudScale);
  s.baseStrength = Math.max(0, P.cloudDilation);
  s.erosionScaleBaseMultiplier = Math.max(0.01, P.erosionScale);
  s.erosionStrengthBase = Math.max(0, P.erosionBase);
  s.erosionStrengthPeak = Math.max(0, P.erosionTop);
  s.erosionShape = THREE.MathUtils.clamp(P.erosionShape, 0, 1);
  s.baseWeatherStrength = Math.max(0, P.baseRequired);
  s.weatherScale = Math.max(1000, P.weatherScale);
  s.horizonCoverageAmount = P.horizonCoverage;
  m.weather.coverage = P.weatherBias;
  m.weather.mainMass[3] = P.weatherContrast;
  m.weather.detail[3] = P.weatherDetail;
  l.scatteringAlbedo = Math.max(0, P.cloudAlbedo);
  l.powderStrength = Math.max(0, P.powder);
  l.ambientIntensity = Math.max(0, P.cloudAmbient);
  m.atmosphere.multipleScattering = Math.max(0, P.multiScatter);
  l.baseShadowStrength = THREE.MathUtils.clamp(P.baseShadow, 0, 1);
  for (let i = 0; i < 3; i++) l.groundBounceAlbedo[i] = BOUNCE_ALBEDO[i] * Math.max(0, P.bounce);
  m.fade.horizonMeltStart = Math.max(0, P.meltStart);
  m.fade.horizonMeltEnd = Math.max(m.fade.horizonMeltStart + 1, P.meltEnd);
  m.fade.apDistance = Math.max(100, P.cloudAP);
}

export function createFirmamentSky({ renderer, camera, params = {} }) {
  for (const [k, v] of Object.entries(FIRMAMENT_DEFAULTS)) if (params[k] === undefined) params[k] = v;
  const P = params;

  const atmosphere = createFirmamentAtmosphere({ renderer });
  const clouds = createFirmamentClouds({ renderer, atmosphere });
  const cirrus = createCirrus({ renderer, atmosphere });
  const ground = new THREE.Color();
  const env = createSkyEnvironment({ renderer, atmosphere, clouds, cirrus, groundAlbedo: [0.33, 0.29, 0.22] });

  // ---- the dome: Tidewater Sky.js skyViewRadiance, the cirrus behind the cumulus
  const uPxAngle = uniform(0.001);
  // the ground below the horizon (see the dome): key light, its direction, the floor's albedo, mean cloud shadow
  const uKey = uniform(new THREE.Vector3(0, 0, 0));
  const uKeyDir = uniform(new THREE.Vector3(0, 1, 0));
  const uFloor = uniform(new THREE.Vector3(0.33, 0.29, 0.22));
  const uCloudMean = uniform(1);
  const uHaze = uniform(1.6);
  const material = new THREE.MeshBasicNodeMaterial();
  material.colorNode = Fn(() => {
    const dir = normalize(positionWorld.sub(cameraPosition)).toVar();
    // the sky half is read at or above the horizon: in the blend band just below it, the sky-view
    // LUT's near-black lower half drew a dark blue strip under the horizon
    const skyDir = normalize(vec3(dir.x, max(dir.y, 0.0), dir.z)).toVar();
    const base = atmosphere.skyBackground(skyDir).add(atmosphere.moon(skyDir));
    const sun = atmosphere.sunDisk(dir);
    const c = clouds.viewSample(dir).toVar();
    const all = clOver(c, cirrus.sample(dir, uPxAngle)).toVar();
    const sky = base.mul(all.a).add(sun.mul(clouds.sunTransmittance(all.a))).add(all.rgb);
    /*
     * BELOW THE HORIZON. Tidewater's sky-view LUT is near black down there — its sea always
     * covered it. The editor shows the dome beyond the terrain's edge, so this sky paints the
     * ground the world stands on: a flat floor at sea level under the key light and the sky
     * (Tidewater's lighting: sun / PI, sky irradiance already / PI), fading to the horizon's sky
     * colour with distance. The clouds between the camera and it (seen from above) lie over it.
     */
    const camY = max(cameraPosition.y, 1.0);
    const t = camY.div(max(dir.y.negate(), 1e-4));
    const E = uKey.mul(max(uKeyDir.y, 0.0)).mul(uCloudMean).div(Math.PI).add(atmosphere.irradianceNode);
    const floor = vec3(uFloor).mul(E);
    const hz = atmosphere.skyLuminance(normalize(vec3(dir.x, 0.02, dir.z)));
    // The air between: the haze pass's own two layers (skyproHaze.js hazeLayerDepth, marine +
    // aerosol) at its density, so the floor fades into the horizon exactly as the terrain does;
    // a 12 km fade underneath for when the haze is off.
    const d = min(t, 1e6);
    const dy = min(dir.y, -1e-4);   // (looking down; kept off 0 so the sky half stays finite)
    const layer = (sigma, H) => {
      const k = dy.mul(d).div(H);
      return exp(camY.div(-H)).mul(sigma).mul(float(H).mul(float(1.0).sub(exp(k.negate()))).div(dy));
    };
    const tau = layer(1.5e-4, 110).add(layer(3.2e-5, 1400)).mul(uHaze);
    const far = max(float(1.0).sub(exp(tau.negate())), float(1.0).sub(exp(d.div(-12000.0))));
    const groundView = mix(floor, hz, far).mul(c.a).add(c.rgb);
    return vec4(mix(groundView, sky, smoothstep(-0.02, 0.0, dir.y)), 1.0);
  })();
  material.side = THREE.BackSide;
  material.depthWrite = false;
  material.depthTest = false;
  material.fog = false;
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(SKY_RADIUS, 48, 24), material);
  mesh.renderOrder = -2;
  mesh.frustumCulled = false;
  mesh.name = "FirmamentSkyDome";
  // centred on whatever camera draws it (the main view, or an env probe's cube camera)
  mesh.onBeforeRender = (_r, _s, cam) => { mesh.position.copy(cam.position); mesh.updateMatrixWorld(); };

  // ---- per frame
  const lightDir = new THREE.Vector3(), moonDir = new THREE.Vector3(), windDir = new THREE.Vector2();
  const bufferSize = new THREE.Vector2();
  const sunColor = [0, 0, 0], T = [0, 0, 0];
  const moonColor = new THREE.Vector3();
  const ownSun = new THREE.Vector3(), moonSide = new THREE.Vector3(), moonLight = new THREE.Vector3();
  const cloudMoon = new THREE.Vector3();
  let time = 0;
  const out = {
    sunColor: [0, 0, 0], skyIrradiance: [0, 0, 0], horizon: [0, 0, 0], keyIsMoon: false, moonColor, keyDir: lightDir, night: 0,
    /** the light on a level surface, as radiance off a white Lambert floor: key N.L / PI + sky (Tidewater units) */
    groundE: [0, 0, 0],
  };

  /**
   * @param {number} dt
   * @param {object} o  sunDir (the REAL sun, from the engine's clock — may be below the horizon),
   *                    moonDir (optional: Tidewater's moon, opposite the sun, if absent),
   *                    drawingBufferSize (Vector2, optional)
   */
  function update(dt, o = {}) {
    time += dt;
    // FIRMAMENT: the sky can own its clock — no sunDir given = the sun of P.timeOfDay / dayOfYear / latitude
    const s = o.sunDir ?? sunDirection({ hours: P.timeOfDay, dayOfYear: P.dayOfYear, latitude: P.latitude }, ownSun);
    const night = THREE.MathUtils.smoothstep(-s.y, 0.02, 0.18);   // Tidewater App.updateSun
    if (o.moonDir) moonDir.copy(o.moonDir);
    else if (P.realMoon) {
      // a host that drives the sun itself passes its clock's hour too (o.hours), else P.timeOfDay
      moonDirection({ hours: o.hours ?? P.timeOfDay, dayOfYear: P.dayOfYear, latitude: P.latitude, moonAge: P.moonAge }, moonDir);
    } else moonDir.set(-s.x, Math.abs(s.y) * 0.8 + 0.25, -s.z).normalize();
    // the night look's moon: placed by height and a turn of its azimuth (disc, key light and glitter
    // follow). Not with the real moon: that one is where the date puts it.
    if (P.nightLook && !P.realMoon && (P.moonElev > 0 || P.moonAzim !== 0)) {
      const el = P.moonElev > 0 ? THREE.MathUtils.degToRad(P.moonElev) : Math.asin(moonDir.y);
      const az = Math.atan2(moonDir.x, moonDir.z) + THREE.MathUtils.degToRad(P.moonAzim);
      moonDir.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
    }
    const keyIsMoon = s.y <= -0.07;
    lightDir.copy(keyIsMoon ? moonDir : s);   // (firmamentKeyDir, with a given moon)
    moonColor.set(0.6, 0.7, 1.0).multiplyScalar(0.12 * night);
    // FIRMAMENT: the moon's PHASE — from the real sun (moonPhase < 0), or an art choice (0 new .. 1 full)
    // that keeps the moon where it is (a crescent high in the sky, which the real sky never shows at
    // night). moonLight = the direction the disc is lit from.
    let alpha;   // phase angle, 0 = full, PI = new
    if (P.moonPhase >= 0) {
      alpha = Math.acos(THREE.MathUtils.clamp(2 * P.moonPhase - 1, -1, 1));
      // lit from the sun's side of the moon (the part of the sun's direction across the moon's)
      moonSide.copy(s).addScaledVector(moonDir, -s.dot(moonDir));
      if (moonSide.lengthSq() < 1e-6) moonSide.set(1, 0, 0).addScaledVector(moonDir, -moonDir.x);
      moonSide.normalize();
      moonLight.copy(moonDir).multiplyScalar(-Math.cos(alpha)).addScaledVector(moonSide, Math.sin(alpha)).normalize();
    } else {
      alpha = Math.acos(THREE.MathUtils.clamp(-s.dot(moonDir), -1, 1));
      moonLight.copy(s);
    }
    if (P.realMoon || P.moonPhase >= 0) {
      // moonlight follows the phase (a Lambert sphere: 1/PI of full at a quarter, 0 at new) and goes
      // when the moon sets. Tidewater's moon is always ~full and always up.
      const phase = (Math.sin(alpha) + (Math.PI - alpha) * Math.cos(alpha)) / Math.PI;
      moonColor.multiplyScalar(phase * THREE.MathUtils.smoothstep(moonDir.y, -0.03, 0.05));
    }
    out.moonDir = moonDir;
    out.moonIllumination = moonIllumination(s, moonDir);
    out.sunDir = s;

    // FIRMAMENT: the air (the medium of the bakes; atmosphere.update re-bakes when it changes)
    const A = atmosphere.params;
    A.rayleighScale = Math.max(0, P.airDensity);
    A.mieScale = Math.max(0, P.aerosols);
    A.mieHeight = Math.max(0.1, P.aerosolHeight);
    A.mieG = THREE.MathUtils.clamp(P.sunGlow, 0, 0.95);
    A.ozoneScale = Math.max(0, P.ozone);
    A.dust = Math.max(0, P.dust);

    const nightSky = P.nightLook ? {
      halo: P.nightHalo, horizon: P.nightHorizon, stars: P.nightStars, starSize: P.nightStarSize,
      starDensity: P.nightStarDensity, milkyWay: P.nightMilkyWay, ring: P.nightRing,
    } : null;
    atmosphere.update({ dt, cameraY: camera.position.y, sunDir: s, moonDir, starIntensity: night, night, time, sunDiskIntensity: 1, nightLook: nightSky,
      sunRadius: Math.max(0.01, P.sunSizeDeg) * Math.PI / 360, moonRadius: Math.max(0.01, P.moonSizeDeg) * Math.PI / 360, moonLightDir: moonLight });

    // Tidewater applyAtmosphereReadback: the sun at sea level x its illuminance x a horizon fade
    atmosphere.sunColorAt(0, s.y, T);
    const fade = THREE.MathUtils.smoothstep(s.y, -0.03, 0.02);
    sunColor[0] = T[0] * fade; sunColor[1] = T[1] * fade; sunColor[2] = T[2] * fade;
    const irr = atmosphere.skyIrradiance || [0, 0, 0];
    const nA = 0.012 * night;
    const skyIrr = [irr[0] + nA * 0.6, irr[1] + nA * 0.7, irr[2] + nA];

    if (o.drawingBufferSize) bufferSize.copy(o.drawingBufferSize);
    else renderer.getDrawingBufferSize(bufferSize);
    const wr = THREE.MathUtils.degToRad(P.windDeg);
    windDir.set(Math.cos(wr), Math.sin(wr));
    clouds.coverage.value = P.coverage;
    applyCloudModel(clouds.model, P);
    // FIRMAMENT: types, wetness, the deck, the front (advancing on its own at frontSpeed)
    // (the covered side is dot(xz, dir) < frontPos: a growing frontPos moves the front toward its clear side)
    if (P.frontSpeed) P.frontPos += P.frontSpeed * dt;
    Object.assign(clouds.types, {
      cloudType: P.cloudType, typeVariation: P.typeVariation, towerTop: P.towerTop, anvil: P.anvil,
      stratusThickness: P.stratusThickness, wetness: P.wetness,
      base: P.cloudBase, thickness: P.cloudThickness,
      frontDeg: P.frontDeg, frontPos: P.frontPos, frontWidth: P.frontWidth,
      frontCoverage: P.frontCoverage, frontStorm: P.frontStorm, frontMoving: !!P.frontSpeed,
    });
    clouds.windSpeed.value = P.windSpeed;
    clouds.horizonMask = !!P.horizonMask;
    camera.updateMatrixWorld();
    // the night look's moonlight on the clouds (only theirs: the world's key stays moonColor)
    cloudMoon.copy(moonColor).multiplyScalar(P.nightLook ? Math.max(0, P.nightCloudMoon) : 1);
    clouds.update(dt, camera, {
      sunDir: s, lightDir, moonColor: cloudMoon, windDir, drawingBufferSize: bufferSize,
      nightAmbient: [skyIrr[0] * night, skyIrr[1] * night, skyIrr[2] * night],
    });
    cirrus.amount.value = P.cirrus;
    cirrus.altitude.value = P.cirrusAlt;
    cirrus.update(dt, camera, { lightDir, sunDir: s, moonE: cloudMoon, coverage: P.coverage, windDir, windSpeed: P.windSpeed });
    uPxAngle.value = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5)) / Math.max(1, bufferSize.y);

    const keyLight = keyIsMoon ? moonColor : new THREE.Vector3(...sunColor);
    ground.set(P.groundAlbedo);
    uKey.value.copy(keyLight);
    uKeyDir.value.copy(lightDir);
    uFloor.value.set(ground.r, ground.g, ground.b);
    uCloudMean.value = 1 - 0.6 * P.coverage;
    uHaze.value = Math.max(0, P.haze);
    env.update({ lightDir, sunColor: keyLight, cloudMean: 1 - 0.6 * P.coverage, groundAlbedo: [ground.r, ground.g, ground.b] });

    out.sunColor[0] = sunColor[0]; out.sunColor[1] = sunColor[1]; out.sunColor[2] = sunColor[2];
    out.skyIrradiance = skyIrr;
    out.horizon = atmosphere.horizon || [0, 0, 0];
    out.keyIsMoon = keyIsMoon;
    out.night = night;
    const up = Math.max(lightDir.y, 0) / Math.PI;
    out.groundE[0] = keyLight.x * up + skyIrr[0];
    out.groundE[1] = keyLight.y * up + skyIrr[1];
    out.groundE[2] = keyLight.z * up + skyIrr[2];
  }

  // ---- eye adaptation (Tidewater's auto exposure) + the night look's EV
  const ae = createFirmamentExposure({ renderer });
  mesh.userData.exposure = ae.state;   // (debug: the dome is reachable from the scene)
  mesh.userData.light = out;
  /** The factor on P.exposure for this frame (call once per frame, after update). */
  function exposureFactor(dt) {
    return ae.update(dt, {
      night: out.night, enabled: !!P.autoExposure, nightEV: P.nightLook ? P.nightEV : 0,
      refLum: P.aeRefLum ?? undefined,
    });
  }

  // ---- the air haze and sun shafts, on the engine's linear HDR frame
  const haze = createAirHaze({ renderer, atmosphere, clouds });
  const uInvVP = uniform(new THREE.Matrix4());
  const uCamPos = uniform(new THREE.Vector3());
  // the world view direction at this pixel (the haze's god-ray mask reads the cloud view with it)
  const viewDir = Fn(() => {
    const ndc = vec2(screenUV.x.mul(2.0).sub(1.0), float(1.0).sub(screenUV.y.mul(2.0)));
    const p = uInvVP.mul(vec4(ndc, 0.5, 1.0));
    return normalize(p.xyz.div(p.w).sub(uCamPos));
  });
  // the hazed frame is copied back into the engine's target (a pass cannot read what it writes)
  const copySrc = texture(new THREE.Texture());
  const copyMat = new THREE.MeshBasicNodeMaterial();
  copyMat.fragmentNode = copySrc.sample(uv()).level(0);   // render-target to render-target: uv(), see the haze
  copyMat.depthTest = false; copyMat.depthWrite = false;
  const copyQuad = new THREE.QuadMesh(copyMat);
  const keyVec = new THREE.Vector3();

  /**
   * @param {THREE.RenderTarget} rt  the linear HDR frame (read, then overwritten)
   * @param {object} o  depthTex (the scene depth), light + shadowDepth (optional: a directional
   *                    light whose shadow camera matches that depth map), size (Vector2),
   *                    seaLevel (m: where the marine haze layer sits; 0 without a sea)
   */
  function postProcess(rt, o) {
    if (!(P.haze > 0)) return;
    haze.params.enabled = true;
    haze.params.density = P.haze;
    haze.params.shafts = P.shafts;
    haze.params.godRays = !!P.godRays;
    camera.updateMatrixWorld();
    uInvVP.value.multiplyMatrices(camera.matrixWorld, camera.projectionMatrixInverse);
    uCamPos.value.copy(camera.position);
    keyVec.copy(uKey.value);
    if (o.size) bufferSize.copy(o.size);
    const hazed = haze.render({
      colorTex: rt.texture, depthTex: o.depthTex, camera, light: o.light, shadowDepth: o.shadowDepth,
      sunDir: lightDir, sunColor: keyVec, size: bufferSize, viewDir, seaLevel: o.seaLevel ?? 0,
    });
    if (hazed === rt.texture) return;
    copySrc.value = hazed;
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(rt);
    copyQuad.render(renderer);
    renderer.setRenderTarget(prev);
  }

  const ready = clouds.ready;

  function dispose() {
    mesh.geometry.dispose();
    material.dispose();
    env.target?.dispose?.();
    ae.dispose();
  }

  return {
    mesh, params: P, ready, update, dispose, postProcess, haze,
    /** meter the linear HDR frame (after postProcess) for the auto exposure */
    meter: (rt) => { if (P.autoExposure) ae.meter(rt); },
    exposureFactor, exposureState: ae.state,
    light: () => out,
    cloudShadow: {
      texture: clouds.textures.shadowMap,
      center: clouds.shadowUniforms.center,
      size: clouds.shadowUniforms.size,
      strength: clouds.shadowUniforms.strength,
    },
    get environment() { return env.texture; },
    atmosphere, clouds, cirrus, env,
  };
}
void vec2; void vec3; void float;
