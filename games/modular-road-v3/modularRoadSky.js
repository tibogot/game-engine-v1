/**
 * Game-owned sky for modular-road — independent of v3's dayNightSky.
 *
 * Time of day is the master: an astronomical sun (latitude + day-of-year + hour)
 * picks among four authored looks (night / twilight / golden / day), then altitude
 * blends below / inside / above the cloud deck. The nadir is always haze, never a
 * pit. Dawn vs dusk is a warmth bias on the twilight look, not a fifth sky.
 *
 * Not wired into the game. sky-lab.html is the harness.
 *
 * @see sky-lab.html
 */
import * as THREE from "three/webgpu";
import {
  float, vec2, vec3, vec4, Fn, If, uniform, texture,
  positionWorld, cameraPosition,
  normalize, dot, cross, sqrt, max, min, mix, smoothstep, pow, exp,
  sin, fract, floor, abs, length, step, saturate, atan,
} from "three/tsl";

import { sunTransmittanceCPU } from "./modularRoadSkyAtmosphere.js";
import { createMoonSurface } from "./modularRoadMoon.js";
import { createMilkyWay, galacticBasis, BAND_SIN } from "./modularRoadMilkyWay.js";
import { applyBloomMRT } from "../../v3/render/bloomMRT.js";

const SKY_RADIUS = 4000;
/** Scratch for the painted deck's key-light integrals — reused, allocates nothing. */
const _keyRgb = [1, 1, 1];
const _deckLight = new THREE.Vector3(0.4, 0.8, 0.3).normalize();
const _cirrusRgb = [1, 1, 1];
const DEG = Math.PI / 180;
const OBLIQUITY = 23.44 * DEG;

export const SKY_DEFAULTS = {
  timeOfDay: 16.25,
  latitude: 45,
  dayOfYear: 172,
  moonAge: 0.55,
  autoAdvance: false,
  /** Hours of clock advanced per real second. 0.4 ≈ a full day in a minute. */
  daySpeed: 0.4,

  cloudBase: 260,
  cloudThickness: 220,

  sunDiscBright: 11,
  /**
   * Angular DIAMETER of the sun's disc, in degrees — the control that actually makes the
   * sun bigger or smaller.
   *
   * The real sun is 0.53 deg. This is ~6x that, the same deliberate oversize the moon
   * gets (see moonSizeDeg) and for the same reason: at true angular size the disc is a
   * couple of pixels and reads as a bug rather than as the sun. Set 0.53 for astronomical
   * honesty.
   *
   * `sunDiscCos` below is DERIVED from this every frame — it is the cosine of the angular
   * RADIUS, which is the form the dot-product disc test needs, and it is a terrible thing
   * to put on a slider (the whole visible range lives between 0.9999 and 0.99). Authoring
   * happens in degrees; the cosine is an implementation detail.
   */
  sunSizeDeg: 3.4,
  sunDiscCos: 0.99955,
  sunGlowPow: 9,
  sunGlowStrength: 0.48,
  sunDiscScale: 1,
  /** How far refraction squashes the disc vertically at the horizon. 0.22 is close to
   *  the real figure; 0 keeps a perfect circle all the way down. */
  /**
   * THE AUREOLE — the tight, fierce halo hugging the sun, and the thing that separates
   * a sun that is BURNING from a bright circle pasted on a gradient.
   *
   * It is not the lens (that is the flare) and not the shafts (those are the god rays).
   * It is the atmosphere itself: haze and aerosol droplets are large compared to the
   * wavelength, so they scatter light overwhelmingly FORWARD, piling a few degrees of
   * sky around the disc into a glare far brighter than the sky beside it. Its width and
   * fury track how much air you are looking through, which is why a low sun drowns in
   * white while a high one is a hard disc in clean blue.
   */
  aureole: 0.18,
  /** Forward-scattering asymmetry. Higher is a tighter, fiercer core. */
  aureoleG: 0.86,
  /** How much the aureole swells as the sun nears the horizon and the air path grows. */
  aureoleHaze: 3.0,
  /**
   * How much of the sun's own glare reaches the BLOOM buffer. The game runs v3's
   * SELECTIVE bloom, so only what a material writes into the emissive MRT blooms at all
   * — and the sky wrote nothing, which is why the sun never bloomed no matter how bright
   * it was. The disc and the aureole belong in there; the broad low wash does not, or
   * the whole sky veils.
   */
  sunBloom: 0.25,
  moonBloom: 0.5,
  /**
   * How much of the starfield reaches the BLOOM buffer. This is what makes a star look
   * like it is shining instead of like a white pixel: the bloom spreads its core into
   * the halo the eye expects. The Milky Way is deliberately left out of it — a broad
   * band through the bloom is a grey smear, not a galaxy.
   */
  starBloom: 0.6,
  sunFlatten: 0.22,
  /** Limb darkening strength: 0 is a flat disc, 1 the full centre-to-rim falloff. */
  sunLimb: 0.85,
  /**
   * Angular DIAMETER in degrees. The real Moon is 0.52 deg — this is deliberately
   * ~3x oversized, the same cheat almost every game and film makes, because at true
   * scale it is a dot and reads as a bug rather than as the Moon. Set 0.52 for
   * astronomical honesty.
   */
  moonSizeDeg: 1.7,
  /** Light the Earth throws back onto the Moon's night side. */
  moonEarthshine: 0.055,
  moonDiscBright: 3.2,
  /**
   * How hard the moon lights the CLOUD DECK, as a fraction of the sun's key.
   *
   * Real moonlight is ~400,000x dimmer than sunlight, which after tone mapping is simply
   * black; the number that matters is not the physical ratio but how much SHAPE the deck
   * keeps at night. Scaled by the moon's illuminated fraction and its altitude, so a new
   * moon or a set moon leaves the deck genuinely flat and dark.
   */
  moonCloudKey: 0.055,

  horizonPow: 0.4,
  horizonGlow: 0.16,
  nadirPow: 1.25,
  cloudSea: 0.55,
  cloudSeaScale: 0.0035,
  zenithDepth: 1,
  starBrightness: 1,
  /** Airglow: the faint self-emission that stops a moonless night being black. */
  airglow: 0.05,
  /** Earth-shadow band opacity opposite a setting sun, and how fast its top edge climbs
   *  with the sun's depth (in `dir.y` units per unit of sun depth). */
  earthShadow: 0.85,
  earthShadowRise: 1.5,
  earthShadowSoft: 0.05,
  /** The Belt of Venus: the pink band riding just above that shadow. */
  belt: 0.5,
  beltWidth: 0.07,
  /** Cells per unit direction. Bigger = finer grid = more, smaller stars. One cell
   *  subtends 1/this radians, so 180 is ~0.32 deg, a few screen pixels. */
  starDensity: 180,
  /** Hash bar a cell must clear to hold a star. 0.985 over this shell is ~6000 stars,
   *  which is what a dark-sky naked eye sees; 0.86 (the old value) is ~100k. */
  starBar: 0.985,
  /** Multiplier on the per-star angular radius. */
  starSize: 1.0,
  /** Brightness of the galactic band. 0 removes it (the fetch stays, gated by night). */
  milkyWay: 0.85,
};

/** Clock times that hit the four looks at lat 45 / day 172. */
export const TIME_PRESETS = {
  dawn: 6.5,
  day: 10.5,
  hero: 16.25,
  dusk: 19.0,
  night: 22.0,
};

export function applyTimePreset(params, name) {
  if (TIME_PRESETS[name] == null) return;
  params.timeOfDay = TIME_PRESETS[name];
  params.autoAdvance = false;
}

/** Authored looks. Hex is sRGB; converted to linear on the way into the shader. */
const LOOK_NIGHT = {
  below:  { z: 0x010104, h: 0x0b1737, n: 0x040811 },
  inside: { z: 0x020305, h: 0x04080d, n: 0x030408 },
  above:  { z: 0x000101, h: 0x060d23, n: 0x020408 },
  sun: 0xffaf6f,
  seaDark: 0x020306, seaBright: 0x0b1429,
  twilight: 0x060b19, anti: 0x030511,
};
const LOOK_DAWN = {
  below:  { z: 0x030519, h: 0xffa193, n: 0x1a1723 },
  inside: { z: 0x64505a, h: 0xbea1a1, n: 0x937a86 },
  above:  { z: 0x01020a, h: 0xffafa1, n: 0xffd6ce },
  sun: 0xffbe93,
  seaDark: 0x1a111e, seaBright: 0xffcede,
  twilight: 0xff7a6f, anti: 0x0b1437,
};
const LOOK_DUSK = {
  below:  { z: 0x02030e, h: 0xff6f30, n: 0x0b0a11 },
  inside: { z: 0x32231e, h: 0xaf7a5a, n: 0x6f4737 },
  above:  { z: 0x010105, h: 0xff8647, n: 0xffbe86 },
  sun: 0xff410d,
  seaDark: 0x110a11, seaBright: 0xffa164,
  twilight: 0xff410d, anti: 0x0b1130,
};
const LOOK_GOLDEN = {
  below:  { z: 0x0c266f, h: 0xffbe7a, n: 0x52503f },
  inside: { z: 0x8d7a69, h: 0xd6bea8, n: 0xaf9a86 },
  above:  { z: 0x030b30, h: 0xffa864, n: 0xffdeb7 },
  sun: 0xffce86,
  seaDark: 0x251e19, seaBright: 0xffe7ce,
  twilight: 0xff8647, anti: 0x112550,
};
const LOOK_DAY = {
  below:  { z: 0x031352, h: 0xafcee7, n: 0x35648d },
  inside: { z: 0x6f8398, h: 0xa4b5c4, n: 0x8698a8 },
  above:  { z: 0x010523, h: 0x456fa1, n: 0xdae2eb },
  sun: 0xffe0ab,
  seaDark: 0x0b1930, seaBright: 0xe2e9ef,
  twilight: 0xffcea1, anti: 0x254786,
};

function equatorialToDir(H, decl, lat, out) {
  const sinD = Math.sin(decl), cosD = Math.cos(decl);
  const sinL = Math.sin(lat), cosL = Math.cos(lat);
  const cosH = Math.cos(H), sinH = Math.sin(H);
  return out
    .set(
      -cosD * sinH,
      sinL * sinD + cosL * cosD * cosH,
      cosD * sinL * cosH - sinD * cosL,
    )
    .normalize();
}

export function sunDirFromTime(P = SKY_DEFAULTS, target = new THREE.Vector3()) {
  const lat = (P.latitude ?? 45) * DEG;
  const lamSun = ((360 * ((P.dayOfYear ?? 172) - 80)) / 365.25) * DEG;
  const declSun = Math.asin(Math.sin(OBLIQUITY) * Math.sin(lamSun));
  const Hsun = ((P.timeOfDay ?? 12) - 12) * 15 * DEG;
  return equatorialToDir(Hsun, declSun, lat, target);
}

export function moonDirFromTime(P = SKY_DEFAULTS, target = new THREE.Vector3()) {
  const lat = (P.latitude ?? 45) * DEG;
  const lamSun = ((360 * ((P.dayOfYear ?? 172) - 80)) / 365.25) * DEG;
  const raSun = Math.atan2(Math.cos(OBLIQUITY) * Math.sin(lamSun), Math.cos(lamSun));
  const Hsun = ((P.timeOfDay ?? 12) - 12) * 15 * DEG;
  const lamMoon = lamSun + (P.moonAge ?? 0.55) * 2 * Math.PI;
  const declMoon = Math.asin(Math.sin(OBLIQUITY) * Math.sin(lamMoon));
  const raMoon = Math.atan2(Math.cos(OBLIQUITY) * Math.sin(lamMoon), Math.cos(lamMoon));
  return equatorialToDir(Hsun + raSun - raMoon, declMoon, lat, target);
}

export function sunDirFromAngles(elevDeg, azimDeg, target = new THREE.Vector3()) {
  const el = elevDeg * DEG;
  const az = azimDeg * DEG;
  return target
    .set(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az))
    .normalize();
}

/** below / inside / above weights at a camera height. Sum to 1. */
export function skyBandWeights(camY, P = SKY_DEFAULTS) {
  const base = P.cloudBase;
  const top = P.cloudBase + P.cloudThickness;
  const below = 1 - THREE.MathUtils.smoothstep(camY, base - 80, base + 20);
  const above = THREE.MathUtils.smoothstep(camY, top - 30, top + 100);
  const inside = Math.max(0, 1 - below - above);
  const sum = below + inside + above || 1;
  return { below: below / sum, inside: inside / sum, above: above / sum };
}

export function skyBandName(camY, P = SKY_DEFAULTS) {
  const w = skyBandWeights(camY, P);
  if (w.above >= w.below && w.above >= w.inside) return "above";
  if (w.inside >= w.below) return "inside";
  return "below";
}

/** Look weights from solar elevation (degrees). Sum to 1. */
export function skyLookWeights(elDeg) {
  const night = 1 - THREE.MathUtils.smoothstep(elDeg, -8, 6);
  const day = THREE.MathUtils.smoothstep(elDeg, 38, 58);
  const remain = Math.max(0, 1 - night - day);
  const goldenFrac = THREE.MathUtils.smoothstep(elDeg, 8, 28);
  return {
    night,
    dusk: remain * (1 - goldenFrac),
    golden: remain * goldenFrac,
    day,
  };
}

export function skyLookName(elDeg, timeOfDay = 12) {
  const w = skyLookWeights(elDeg);
  let name = "night", best = w.night;
  if (w.dusk > best) { name = "dusk"; best = w.dusk; }
  if (w.golden > best) { name = "golden"; best = w.golden; }
  if (w.day > best) name = "day";
  if (name === "dusk" && timeOfDay < 12) return "dawn";
  return name;
}

const _lin = new THREE.Color();
/**
 * An authored sRGB hex into `out`, in working (linear) space.
 *
 * `Color.set(number)` already linearises — see the note on `lin()` in
 * modularRoadMaterial.js. The `convertSRGBToLinear()` this used to chain ran
 * the curve a second time and made the whole palette 5–10× darker than its
 * hexes implied. The band hexes above were rebased when it was removed, so the
 * sky renders as it did to within half an 8-bit code.
 */
function toLinearHex(hex, out) {
  return out.set(hex);
}

const _acc = new THREE.Color();
const _tmp = new THREE.Color();

function mixTwilight(dawnHex, duskHex, duskBias, out) {
  toLinearHex(dawnHex, out);
  toLinearHex(duskHex, _tmp);
  return out.lerp(_tmp, duskBias);
}

const _sunDir = new THREE.Vector3();
const _moonDir = new THREE.Vector3();
const _zB = new THREE.Color(), _hB = new THREE.Color(), _nB = new THREE.Color();
const _zI = new THREE.Color(), _hI = new THREE.Color(), _nI = new THREE.Color();
const _zA = new THREE.Color(), _hA = new THREE.Color(), _nA = new THREE.Color();
const _sunCol = new THREE.Color();
const _seaDark = new THREE.Color(), _seaBright = new THREE.Color();
const _twilight = new THREE.Color(), _anti = new THREE.Color();
const _red = new THREE.Color(0xff1102);
const _moonCol = new THREE.Color(0xb8caff);

function twilightPair(dawnLook, duskLook, duskBias, key, band, out) {
  return mixTwilight(dawnLook[band][key], duskLook[band][key], duskBias, out);
}

/**
 * Evaluate the full sky at the current clock / altitude.
 * Colour fields are linear. Shared objects — copy if you retain them.
 */
export function evaluateSky(P = SKY_DEFAULTS) {
  sunDirFromTime(P, _sunDir);
  moonDirFromTime(P, _moonDir);
  const elDeg = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(_sunDir.y, -1, 1)));
  const azDeg = (THREE.MathUtils.radToDeg(Math.atan2(_sunDir.z, _sunDir.x)) + 360) % 360;
  const w = skyLookWeights(elDeg);
  const duskBias = THREE.MathUtils.smoothstep(P.timeOfDay, 10, 14);
  const nightF = w.night;
  const twilightF = w.dusk;
  const dayF = w.day;

  const twZb = twilightPair(LOOK_DAWN, LOOK_DUSK, duskBias, "z", "below", new THREE.Color());
  const twHb = twilightPair(LOOK_DAWN, LOOK_DUSK, duskBias, "h", "below", new THREE.Color());
  const twNb = twilightPair(LOOK_DAWN, LOOK_DUSK, duskBias, "n", "below", new THREE.Color());
  const twZi = twilightPair(LOOK_DAWN, LOOK_DUSK, duskBias, "z", "inside", new THREE.Color());
  const twHi = twilightPair(LOOK_DAWN, LOOK_DUSK, duskBias, "h", "inside", new THREE.Color());
  const twNi = twilightPair(LOOK_DAWN, LOOK_DUSK, duskBias, "n", "inside", new THREE.Color());
  const twZa = twilightPair(LOOK_DAWN, LOOK_DUSK, duskBias, "z", "above", new THREE.Color());
  const twHa = twilightPair(LOOK_DAWN, LOOK_DUSK, duskBias, "h", "above", new THREE.Color());
  const twNa = twilightPair(LOOK_DAWN, LOOK_DUSK, duskBias, "n", "above", new THREE.Color());
  const twSun = mixTwilight(LOOK_DAWN.sun, LOOK_DUSK.sun, duskBias, new THREE.Color());
  const twSeaD = mixTwilight(LOOK_DAWN.seaDark, LOOK_DUSK.seaDark, duskBias, new THREE.Color());
  const twSeaB = mixTwilight(LOOK_DAWN.seaBright, LOOK_DUSK.seaBright, duskBias, new THREE.Color());
  const twWash = mixTwilight(LOOK_DAWN.twilight, LOOK_DUSK.twilight, duskBias, new THREE.Color());
  const twAnti = mixTwilight(LOOK_DAWN.anti, LOOK_DUSK.anti, duskBias, new THREE.Color());

  function mix4(nHex, twCol, gHex, dHex, out) {
    toLinearHex(nHex, out).multiplyScalar(w.night);
    out.add(_acc.copy(twCol).multiplyScalar(w.dusk));
    out.add(toLinearHex(gHex, _tmp).multiplyScalar(w.golden));
    out.add(toLinearHex(dHex, _tmp).multiplyScalar(w.day));
    return out;
  }

  mix4(LOOK_NIGHT.below.z, twZb, LOOK_GOLDEN.below.z, LOOK_DAY.below.z, _zB);
  mix4(LOOK_NIGHT.below.h, twHb, LOOK_GOLDEN.below.h, LOOK_DAY.below.h, _hB);
  mix4(LOOK_NIGHT.below.n, twNb, LOOK_GOLDEN.below.n, LOOK_DAY.below.n, _nB);
  mix4(LOOK_NIGHT.inside.z, twZi, LOOK_GOLDEN.inside.z, LOOK_DAY.inside.z, _zI);
  mix4(LOOK_NIGHT.inside.h, twHi, LOOK_GOLDEN.inside.h, LOOK_DAY.inside.h, _hI);
  mix4(LOOK_NIGHT.inside.n, twNi, LOOK_GOLDEN.inside.n, LOOK_DAY.inside.n, _nI);
  mix4(LOOK_NIGHT.above.z, twZa, LOOK_GOLDEN.above.z, LOOK_DAY.above.z, _zA);
  mix4(LOOK_NIGHT.above.h, twHa, LOOK_GOLDEN.above.h, LOOK_DAY.above.h, _hA);
  mix4(LOOK_NIGHT.above.n, twNa, LOOK_GOLDEN.above.n, LOOK_DAY.above.n, _nA);
  mix4(LOOK_NIGHT.sun, twSun, LOOK_GOLDEN.sun, LOOK_DAY.sun, _sunCol);
  mix4(LOOK_NIGHT.seaDark, twSeaD, LOOK_GOLDEN.seaDark, LOOK_DAY.seaDark, _seaDark);
  mix4(LOOK_NIGHT.seaBright, twSeaB, LOOK_GOLDEN.seaBright, LOOK_DAY.seaBright, _seaBright);
  mix4(LOOK_NIGHT.twilight, twWash, LOOK_GOLDEN.twilight, LOOK_DAY.twilight, _twilight);
  mix4(LOOK_NIGHT.anti, twAnti, LOOK_GOLDEN.anti, LOOK_DAY.anti, _anti);

  if (P.zenithDepth !== 1) {
    _zB.multiplyScalar(P.zenithDepth);
    _zI.multiplyScalar(P.zenithDepth);
    _zA.multiplyScalar(P.zenithDepth);
  }

  const trans = THREE.MathUtils.smoothstep(_sunDir.y, -0.02, 0.2);
  _sunCol.lerp(_red, (1 - trans) * 0.85);

  const moonIllum = 1 - Math.abs((P.moonAge ?? 0.55) * 2 - 1);
  /*
   * MOONLIGHT NEEDS THE MOON TO BE UP — it was not checked, so the world carried a
   * moonlit key all night regardless of where the moon actually was. A gibbous moon that
   * has already set was still lighting the track, and a new moon lit it as brightly as a
   * full one would have if you only looked at the illuminated fraction. Both are the same
   * omission: the night key was a function of the CALENDAR and not of the sky.
   *
   * `moonLight` is the honest product — how much of the disc is lit, times how far above
   * the horizon it is — and it is what the night term now scales by. A new moon or a set
   * moon leaves a genuinely dark night, which is the whole reason to have a moon phase.
   */
  const moonUp = THREE.MathUtils.smoothstep(_moonDir.y, -0.05, 0.18);
  const moonLight = moonIllum * moonUp;
  const exposure = 0.52 * w.night + 0.78 * w.dusk + 0.92 * w.golden + 1.0 * w.day;
  const dirIntensity = 0.30 * moonLight * w.night + 1.1 * w.dusk + 2.4 * w.golden + 3.1 * w.day;
  const hemiIntensity = 0.18 * w.night + 0.35 * w.dusk + 0.5 * w.golden + 0.62 * w.day;

  return {
    sunDir: _sunDir,
    moonDir: _moonDir,
    sunElevation: elDeg,
    sunAzimuth: azDeg,
    zenithBelow: _zB, horizonBelow: _hB, nadirBelow: _nB,
    zenithInside: _zI, horizonInside: _hI, nadirInside: _nI,
    zenithAbove: _zA, horizonAbove: _hA, nadirAbove: _nA,
    sunColor: _sunCol,
    seaDark: _seaDark, seaBright: _seaBright,
    twilight: _twilight, anti: _anti,
    moonColor: _moonCol,
    nightF, twilightF, dayF, duskBias, moonIllum, moonUp, moonLight,
    exposure, dirIntensity, hemiIntensity,
    lookName: skyLookName(elDeg, P.timeOfDay),
    weights: w,
  };
}

export function skyColorsAt(camY, P = SKY_DEFAULTS) {
  const look = evaluateSky(P);
  const b = skyBandWeights(camY, P);
  const zenith = _lin.copy(look.zenithBelow).multiplyScalar(b.below)
    .add(_tmp.copy(look.zenithInside).multiplyScalar(b.inside))
    .add(_acc.copy(look.zenithAbove).multiplyScalar(b.above));
  const horizon = new THREE.Color().copy(look.horizonBelow).multiplyScalar(b.below)
    .add(_tmp.copy(look.horizonInside).multiplyScalar(b.inside))
    .add(_acc.copy(look.horizonAbove).multiplyScalar(b.above));
  const haze = new THREE.Color().copy(look.nadirBelow).multiplyScalar(b.below)
    .add(_tmp.copy(look.nadirInside).multiplyScalar(b.inside))
    .add(_acc.copy(look.nadirAbove).multiplyScalar(b.above));
  return {
    zenith, horizon, haze,
    sunDir: look.sunDir,
    sunColor: look.sunColor,
    look,
  };
}

/**
 * @param {object} [opts]
 * @param {object} [opts.params]
 * @param {object} [opts.atmosphere] optional `createSkyAtmosphere()` — when supplied, the
 *   authored gradient can be crossfaded to a physically-modelled sky (see setAtmosphereMix).
 * @param {object} [opts.paintedClouds] optional `createPaintedClouds()` — the cheap cloud
 *   tier. Handed in rather than built here for the same reason the atmosphere is: it
 *   costs a bake, and a caller running the volumetric deck should never pay for it.
 */
export function createModularRoadSky({ params, atmosphere, paintedClouds } = {}) {
  const P = { ...SKY_DEFAULTS, ...params };

  const uCamY = uniform(40);
  const uCloudBase = uniform(P.cloudBase);
  const uCloudTop = uniform(P.cloudBase + P.cloudThickness);
  const uTime = uniform(0);
  const uSunDir = uniform(new THREE.Vector3(0.4, 0.7, 0.5).normalize());
  const uMoonDir = uniform(new THREE.Vector3(-0.3, 0.5, 0.4).normalize());
  const uSunColor = uniform(new THREE.Color(1, 0.94, 0.82));
  const uMoonColor = uniform(_moonCol.clone());
  const uSunDiscBright = uniform(P.sunDiscBright);
  const uSunDiscCos = uniform(P.sunDiscCos);
  const uSunGlowPow = uniform(P.sunGlowPow);
  const uSunGlowStrength = uniform(P.sunGlowStrength);
  const uSunDiscScale = uniform(P.sunDiscScale);
  const uSunFlatten = uniform(P.sunFlatten);
  const uAureole = uniform(P.aureole);
  const uAureoleG = uniform(P.aureoleG);
  const uAureoleHaze = uniform(P.aureoleHaze);
  const uSunBloom = uniform(P.sunBloom);
  const uMoonBloom = uniform(P.moonBloom);
  const uStarBloom = uniform(P.starBloom);
  /** 1 = the sun is clear, 0 = fully hidden by cloud. Driven from the same occlusion
   *  the lens flare uses, so the glare, the flare and the bloom agree. */
  const uSunOcclusion = uniform(1);
  const uSunLimb = uniform(P.sunLimb);
  const uMoonCos = uniform(Math.cos((P.moonSizeDeg * DEG) / 2));
  const uMoonDiscBright = uniform(P.moonDiscBright);
  const uMoonCloudKey = uniform(P.moonCloudKey);
  /** moonIllum x moonUp — 0 for a new moon or a moon below the horizon. */
  const uMoonLight = uniform(0);
  /**
   * WHERE THE CLOUD DECK'S LIGHT COMES FROM. The sun by day, the MOON once the sun is
   * down — the deck used to be shaded from `uSunDir` around the clock, so at night it
   * was lit from below the horizon (i.e. not at all) and the moon contributed a flat
   * directionless tint. Everything the deck derives from this direction then follows for
   * free: the lit side faces the moon, the cloud-on-cloud shadows fall away from it, and
   * the forward-scatter term puts a real glow on thin cloud crossing in front of it.
   */
  const uDeckLightDir = uniform(new THREE.Vector3(0.4, 0.8, 0.3).normalize());
  /** Baked near-side albedo — see modularRoadMoon.js. ~40 ms once, at sky construction. */
  const moonSurface = createMoonSurface({ seed: P.moonSeed ?? 7919 });
  const moonTex = texture(moonSurface.map);
  /** Angular RADIUS in radians, for the disc-space projection. */
  const uMoonRad = uniform((P.moonSizeDeg * DEG) / 2);
  /** Faint light the Earth throws on the Moon's night side — the reason you can see the
   *  whole disc inside a thin crescent. */
  const uEarthshine = uniform(P.moonEarthshine ?? 0.055);
  /** 0 = authored gradient, 1 = physical atmosphere. See setAtmosphereMix. */
  const uAtmoMix = uniform(0);
  /** Sunlight reaching the painted deck — real transmittance, not the disc palette. */
  const uCloudKey = uniform(new THREE.Color(1, 1, 1));
  /** The same, at the CIRRUS altitude. Not a copy: 8 km up the sun still has a clear
   *  line long after it has reddened for the deck below, which is precisely why high
   *  cirrus keeps burning bright after sunset. */
  const uCirrusKey = uniform(new THREE.Color(1, 1, 1));

  const uZenithBelow = uniform(new THREE.Color());
  const uHorizonBelow = uniform(new THREE.Color());
  const uNadirBelow = uniform(new THREE.Color());
  const uZenithInside = uniform(new THREE.Color());
  const uHorizonInside = uniform(new THREE.Color());
  const uNadirInside = uniform(new THREE.Color());
  const uZenithAbove = uniform(new THREE.Color());
  const uHorizonAbove = uniform(new THREE.Color());
  const uNadirAbove = uniform(new THREE.Color());
  const uSeaDark = uniform(new THREE.Color());
  const uSeaBright = uniform(new THREE.Color());
  const uTwilight = uniform(new THREE.Color());
  const uAnti = uniform(new THREE.Color());

  const uHorizonPow = uniform(P.horizonPow);
  const uHorizonGlow = uniform(P.horizonGlow);
  const uNadirPow = uniform(P.nadirPow);
  const uCloudSea = uniform(P.cloudSea);
  const uCloudSeaScale = uniform(P.cloudSeaScale);
  const uNightF = uniform(0);
  const uTwilightF = uniform(0);
  const uStarBrightness = uniform(P.starBrightness);
  const uAirglow = uniform(P.airglow);
  /** Faintly green — airglow is oxygen and sodium emission, not grey haze. */
  const uAirglowColor = uniform(new THREE.Color(0.10, 0.17, 0.16));
  const uEarthShadow = uniform(P.earthShadow);
  const uEarthShadowRise = uniform(P.earthShadowRise);
  const uEarthShadowSoft = uniform(P.earthShadowSoft);
  const uBelt = uniform(P.belt);
  const uBeltWidth = uniform(P.beltWidth);
  /** Belt of Venus pink: reddened sunlight back-scattered, so warm and desaturated. */
  const uBeltColor = uniform(new THREE.Color(0.42, 0.20, 0.24));
  const uStarDensity = uniform(P.starDensity);
  const uStarBar = uniform(P.starBar);
  const uStarSize = uniform(P.starSize);
  /** Baked galactic band — see modularRoadMilkyWay.js. One fetch, no per-pixel noise. */
  const milkyWay = createMilkyWay({ seed: P.milkyWaySeed ?? 20287 });
  const milkyTex = texture(milkyWay.map);
  const _gal = galacticBasis();
  const uGalPole = uniform(_gal.pole);
  const uGalX = uniform(_gal.gx);
  const uGalY = uniform(_gal.gy);
  const uMilkyWay = uniform(P.milkyWay);
  /** sin(latitude) -> texture row. The strip covers +/-BAND_SIN, so this is its inverse
   *  span; outside it the clamp lands on rows the bake already faded to zero. */
  const uGalScale = uniform(0.5 / BAND_SIN);

  const hash12 = (p) =>
    fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453));

  const vnoise2 = Fn(([p]) => {
    const i = floor(p);
    const f = fract(p);
    const u = f.mul(f).mul(f.mul(-2.0).add(3.0));
    const a = hash12(i);
    const b = hash12(i.add(vec2(1, 0)));
    const c = hash12(i.add(vec2(0, 1)));
    const d = hash12(i.add(vec2(1, 1)));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  });

  /*
   * WHY THIS IS NOT THE USUAL `fract(sin(dot(p, big)) * 43758.5453)` — THE MISSING STARS.
   *
   * That hash is the one everybody writes, and here it silently returned ZERO for every
   * cell, so `present` never cleared its bar and the sky had no stars at all, at any hour,
   * at any brightness. The reason is the argument range: the star cell is
   * `floor(dir * 240)`, so its components reach +/-240, and dotting that with constants
   * like 311.7 hands `sin()` an argument around 1e5. A 32-bit float has ~7 significant
   * digits, so at 1e5 the spacing between representable values is already coarser than a
   * radian of phase — the range reduction inside the GPU's sin() has nothing left to work
   * with, and WGSL leaves the result implementation-defined out there. This GPU returns
   * something that lands on 0 after the multiply and the fract.
   *
   * Dave Hoskins' hash33 instead keeps every intermediate small: it multiplies by ~0.1 and
   * immediately takes `fract`, so nothing ever leaves [0, 1) where float32 has full
   * precision. No transcendental, three multiplies and two fracts, and it is stable for
   * the whole cell range this sky uses.
   */
  const hash33 = Fn(([p]) => {
    const q = fract(p.mul(vec3(0.1031, 0.1030, 0.0973))).toVar();
    q.addAssign(dot(q, q.yxz.add(33.33)));
    return fract(q.xxy.add(q.yxx).mul(q.zyx));
  });

  const starField = Fn(([dir, mwW]) => {
    /*
     * THE GALACTIC BAND.
     *
     * Sampled in galactic coordinates: latitude is one dot product against the pole,
     * longitude one atan of the two in-plane components. That is the whole projection —
     * the structure itself was baked (see modularRoadMilkyWay.js), so what happens here
     * per pixel is a projection and a fetch, not noise.
     *
     * It lives inside starField rather than beside it because both want the same night
     * gate, and because the band has to drive the STAR DENSITY as well as the glow: the
     * Milky Way is unresolved starlight, so resolved stars must crowd along it too. A
     * uniform starfield with a glowing stripe behind it reads as a painted backdrop.
     */
    const gb = dot(dir, uGalPole);
    const gl = atan(dot(dir, uGalY), dot(dir, uGalX)).mul(0.15915494).add(0.5);
    const mw = milkyTex.sample(vec2(gl, saturate(gb.mul(uGalScale).add(0.5))));
    const mwGlow = mw.r.mul(uMilkyWay);

    /*
     * ══════════════════════════════════════════════════════════════════════════════
     * WHY THERE WERE NO STARS AT ALL — two compounding scale bugs, both measured with a
     * debug view that wrote hash / present / core into R / G / B.
     *
     * 1. THE STARS WERE SUB-PIXEL. The cell grid was `dir * 240`, so one cell subtends
     *    1/240 rad ≈ 0.24°, which at this field of view is about 3.6 screen pixels. The
     *    star radius was 0.03–0.09 of a CELL — a tenth to a third of one pixel. A star
     *    was only ever hit if a pixel centre landed inside that speck, which essentially
     *    never happened, so the sky was empty at every brightness and every hour.
     * 2. THE DISTANCE TEST WAS 3D. `d` measured the full three-dimensional gap between
     *    the sample and the star inside the cell, but the visible sky is the SHELL those
     *    cells are crossed by. A star sitting a little off that shell could never be
     *    reached however exactly the ray pointed at it, which threw away most of the few
     *    that were left. Only the TANGENTIAL offset — the part perpendicular to the view
     *    ray — is what "how close am I to that star" means on a sky.
     *
     * So: a coarser grid, a real angular size, and a tangential distance. The density
     * bar then has to come down hard, because those fixes make every cell that passes it
     * actually visible: at the old 14% this shell holds ~100k stars, which is a white
     * haze, not a sky. The naked eye sees a few thousand.
     * ══════════════════════════════════════════════════════════════════════════════
     */
    const sp = dir.mul(uStarDensity);
    const cell = floor(sp);
    const f = fract(sp).sub(0.5);
    const rnd = hash33(cell);
    // Lower the bar for a cell to hold a star where the band is thick.
    const present = step(uStarBar.sub(mw.g.mul(uMilkyWay).mul(0.02)), rnd.x);
    const off = hash33(cell.add(vec3(1.7, 9.2, 3.3))).sub(0.5).mul(0.7);
    // TANGENTIAL distance only — see (2) above.
    const v = f.sub(off);
    const d = length(v.sub(dir.mul(dot(v, dir))));
    const size = mix(float(0.10), float(0.34), rnd.z.mul(rnd.z)).mul(uStarSize);
    /*
     * A GLOW, NOT A DISC — the third reason the sky was empty. Even after the grid and
     * the distance test were fixed, a star's radius is a fraction of a cell and a cell is
     * a few pixels, so a hard disc is still sub-pixel: it only lights a pixel whose centre
     * happens to fall inside it, and the rest of the star falls between samples. A real
     * star on a real sensor is a point spread — a bright core with a halo several pixels
     * across — and that is also what makes it survive anti-aliasing and read as a POINT
     * rather than a square. So the falloff runs out to 3x the radius and is raised to a
     * high power: the core stays tight, the halo catches the pixel grid.
     */
    /*
     * A TIGHT CORE PLUS A WIDE FAINT HALO — why the stars read as flat dots before.
     *
     * A single smooth falloff raised to a power is a BLOB: it has one radius, so it is
     * either small and hard or big and soft, and at a star's size on screen it lands as
     * a plain bright pixel. What the eye actually reads as a star is the point spread of
     * a real optic: an intense, almost sub-pixel core sitting inside a much wider, much
     * fainter halo. The halo is what makes it look like it is SHINING rather than
     * printed, and it is also what survives anti-aliasing.
     *
     * Two terms from the same ramp: one raised hard for the core, one barely raised at
     * all for the skirt.
     */
    const glow = saturate(float(1.0).sub(d.div(size.mul(3.2).max(1e-4))));
    const g2s = glow.mul(glow);
    const g4s = g2s.mul(g2s);
    const core = g4s.mul(g4s).add(g2s.mul(0.16));
    const mag = mix(float(0.35), float(1.8), rnd.y.mul(rnd.y));
    /*
     * BRIGHT STARS COME OUT FIRST — the thing everyone has watched happen and nobody
     * models. Dusk does not dim the sky uniformly onto a fixed starfield; the sky's own
     * brightness falls past one magnitude after another, so Venus and the first-magnitude
     * stars are out while the west is still orange, and the faint ones only arrive once
     * it is properly dark. Fading the whole field together by `nightF` reads as a
     * dimmer switch and is the giveaway.
     *
     * So each star gets its own threshold from its own magnitude: the brightest appear
     * almost as soon as the sun is down, the faintest need nearly full night.
     */
    const magN = saturate(mag.sub(0.35).div(1.45));
    const appear = saturate(uNightF.sub(magN.oneMinus().mul(0.55)).mul(3.0));
    /*
     * SCINTILLATION IS AN ATMOSPHERIC EFFECT, SO IT BELONGS TO ALTITUDE. A star twinkles
     * because its light crosses turbulent air, and a star near the horizon is seen
     * through many times the air column of one overhead — which is why the low ones
     * flash and shift colour while the zenith sits almost steady. A uniform twinkle over
     * the whole sky is the tell that it is a sine on a timer.
     *
     * Two beats at incommensurate rates rather than one, because a single sine reads as
     * a pulse; the pair wanders the way real seeing does.
     */
    const amp = mix(float(0.05), float(0.42), pow(saturate(float(1.0).sub(dir.y)), float(3.0)));
    const ph = rnd.y.mul(6.2831);
    const tw = float(1.0).add(
      sin(uTime.mul(2.4).add(ph)).mul(0.6).add(sin(uTime.mul(3.7).add(ph.mul(1.7))).mul(0.4)).mul(amp),
    );
    // Spectral class, roughly: hot blue-white through to a cool orange. Wider than it
    // looks it should be, because ACES at night exposure pulls everything toward white.
    const col = mix(vec3(0.55, 0.70, 1.0), vec3(1.0, 0.80, 0.55), rnd.z.mul(rnd.z));
    const stars = col.mul(present.mul(core).mul(mag).mul(tw).mul(appear).mul(uStarBrightness).mul(4.2));
    /*
     * The glow is faintly BLUE-WHITE, not grey. Integrated starlight is dominated by
     * hot main-sequence stars, and the dust that makes the rift also reddens what shows
     * through it — so a neutral band looks like fog and a slightly cool one looks like
     * a galaxy. Kept dim on purpose: it should be something the eye finds after a
     * moment, the way it is outdoors, not a feature competing with the moon.
     */
    const mwCol = vec3(0.62, 0.70, 0.95).mul(mwGlow.mul(0.5)).mul(uNightF).mul(mwW);
    return stars.add(mwCol);
  });

  /**
   * Henyey-Greenstein, normalised so the forward peak is exactly 1. `g` is the
   * asymmetry: 0 is isotropic, and the closer to 1 the tighter the forward spike.
   */
  const hgPeak = Fn(([mu, g]) => {
    const g2 = g.mul(g);
    const denom = pow(float(1.0).add(g2).sub(g.mul(mu).mul(2.0)).max(1e-4), float(1.5));
    return float(1.0).sub(g2).div(denom)
      .mul(pow(float(1.0).sub(g), float(2.0)).div(float(1.0).add(g).max(1e-4)));
  });

  /**
   * EVERYTHING ABOUT THE SUN THAT GLARES — disc, aureole and the broad wash — in ONE
   * place, because it is needed twice: once for what you see, and once for what blooms.
   * Writing it twice is how the two drift until the bloom stops matching the sun.
   *
   * `wideW` scales the broad low wash only. The visible sky passes 1; the bloom buffer
   * passes 0, so only the disc and the aureole glow and the sky itself does not veil.
   */
  const sunGlare = Fn(([dir, wideW]) => {
    const sunDot = dot(dir, uSunDir);
    const sunUpFade = smoothstep(float(-0.04), float(0.08), uSunDir.y);
    const mu = max(sunDot, float(0.0));
    // Refraction squashes the disc as it sets; see the note where sunFlatten is declared.
    const flat = uSunFlatten.mul(smoothstep(float(0.16), float(-0.02), uSunDir.y));
    const dirF = normalize(vec3(
      dir.x,
      uSunDir.y.add(dir.y.sub(uSunDir.y).div(float(1.0).sub(flat).max(0.2))),
      dir.z,
    ));
    const sunDotF = dot(dirF, uSunDir);
    const discU = saturate(sunDotF.sub(uSunDiscCos).div(float(1.0).sub(uSunDiscCos).max(1e-6)));
    const limbDark = mix(float(1.0), mix(float(0.42), float(1.0), sqrt(discU)), uSunLimb);
    const disc = smoothstep(uSunDiscCos, float(1.0), sunDotF)
      .mul(limbDark).mul(uSunDiscBright).mul(uSunDiscScale);
    // The aureole grows with the air path, so it swells as the sun drops.
    const haze = mix(float(1.0), uAureoleHaze, smoothstep(float(0.35), float(0.0), uSunDir.y));
    const aureole = hgPeak(mu, uAureoleG).mul(uAureole).mul(haze);
    const wide = pow(mu, uSunGlowPow).mul(uSunGlowStrength).mul(wideW);
    return uSunColor.mul(disc.add(aureole).add(wide)).mul(sunUpFade);
  });

  /** The moon's disc and its own small aureole. Same split: `wideW` is the soft halo. */
  const moonGlare = Fn(([dir, wideW]) => {
    const moonDot = dot(dir, uMoonDir);
    const moonUpFade = smoothstep(float(-0.05), float(0.06), uMoonDir.y);
    const mRight = normalize(cross(vec3(0.0, 1.0, 0.0).add(vec3(1e-4, 0.0, 0.0)), uMoonDir));
    const mUp = cross(uMoonDir, mRight);
    const mOff = dir.sub(uMoonDir.mul(moonDot));
    const du = dot(mOff, mRight).div(uMoonRad);
    const dv = dot(mOff, mUp).div(uMoonRad);
    const r2 = du.mul(du).add(dv.mul(dv));
    const moonSurf = moonTex.sample(vec2(du.mul(0.5).add(0.5), dv.mul(0.5).add(0.5)));
    const cosE = sqrt(saturate(r2.oneMinus()));
    const nrm = mRight.mul(du).add(mUp.mul(dv)).sub(uMoonDir.mul(cosE));
    const cosI = dot(nrm, uSunDir);
    // Lommel-Seeliger, not Lambert: lunar regolith backscatters, so a full moon is a
    // flat bright disc rather than a shaded ball.
    const lit = saturate(cosI);
    const ls = lit.div(lit.add(cosE).max(1e-3));
    const shade = ls.mul(1.6).add(uEarthshine);
    const discMask = moonSurf.a.mul(step(r2, float(1.0)));
    const body = uMoonColor.mul(moonSurf.r).mul(shade).mul(uMoonDiscBright).mul(discMask);
    const halo = hgPeak(max(moonDot, float(0.0)), float(0.92)).mul(0.18).mul(wideW);
    return body.add(uMoonColor.mul(halo)).mul(moonUpFade).mul(uNightF.add(0.15));
  });

  const skyColorNode = Fn(() => {
    const dir = normalize(positionWorld.sub(cameraPosition)).toVar();
    const up = dir.y.toVar();

    const belowW = float(1).sub(smoothstep(uCloudBase.sub(80), uCloudBase.add(20), uCamY)).toVar();
    const aboveW = smoothstep(uCloudTop.sub(30), uCloudTop.add(100), uCamY).toVar();
    const insideW = max(float(0), float(1).sub(belowW).sub(aboveW));
    const wSum = max(belowW.add(insideW).add(aboveW), float(1e-4));
    const wB = belowW.div(wSum);
    const wI = insideW.div(wSum);
    const wA = aboveW.div(wSum);

    const zenith = uZenithBelow.mul(wB).add(uZenithInside.mul(wI)).add(uZenithAbove.mul(wA)).toVar();
    const horizon = uHorizonBelow.mul(wB).add(uHorizonInside.mul(wI)).add(uHorizonAbove.mul(wA)).toVar();
    const nadir = uNadirBelow.mul(wB).add(uNadirInside.mul(wI)).add(uNadirAbove.mul(wA)).toVar();

    const tGrad = pow(max(up, float(0.0)), uHorizonPow);
    // Mix through a lifted atmosphere white so blue zenith + gold horizon does
    // not collapse to magenta (ACES + complementary lerp).
    const atm = mix(horizon, vec3(1.0, 0.96, 0.92), 0.18).toVar();
    const col = mix(mix(horizon, atm, tGrad), mix(atm, zenith, tGrad), tGrad).toVar();

    const limb = exp(up.mul(up).mul(-90.0)).mul(uHorizonGlow);
    col.addAssign(horizon.mul(limb));

    // Twilight: warm toward the sun, cool on the opposite limb (Earth shadow).
    const sunAmt = max(dot(dir, uSunDir), float(0.0));
    const horizonBand = smoothstep(float(0.42), float(0.0), abs(up));
    const warm = uTwilightF.mul(horizonBand).mul(mix(float(0.18), float(1.0), pow(sunAmt, 1.35)));
    const cool = uTwilightF.mul(horizonBand).mul(float(1.0).sub(sunAmt)).mul(0.5);
    col.assign(mix(col, uTwilight, clamp01(warm.mul(0.5))));
    col.assign(mix(col, uAnti, clamp01(cool.mul(0.55))));


    const belowH = smoothstep(float(0.04), float(-0.85), up);
    col.assign(mix(col, nadir, pow(belowH, uNadirPow)));

    // PHYSICAL ATMOSPHERE — swapped in for the AUTHORED GRADIENT ONLY.
    //
    // Everything below this point (stars, moon, cloud sea) still runs, which is the whole
    // reason the swap happens here rather than by replacing the dome: a physical
    // atmosphere is correctly black once the sun is down, so a dome that replaced the
    // entire sky would throw away the night sky along with the gradient. The model
    // supplies the daylight; the authored layer keeps everything the model does not
    // pretend to simulate.
    //
    // Crossfaded rather than switched so the authored look can still be dialled back in as
    // a grade when a scene wants a specific mood the physics will not give you.
    //
    // THE FLOOR IS THE HORIZON, DIMMED — never the model's own ground. Below the
    // horizon the Hillaire model renders the planet's surface: a sunlit ball with a
    // deliberately colourless albedo, i.e. a GREY floor, which is exactly what made the
    // physical sky's horizon read worse than the old dome's. The old DayNightSkyDome
    // never had a floor colour at all — it just multiplied the sky's own colour down
    // (mix(1, 0.05, belowH²)), so the floor is the horizon blue itself deepening toward
    // black, which is the rich "ocean mirror" look the old sky was loved for.
    //
    // Same recipe here, one better: downward rays sample the atmosphere AT the horizon
    // (y clamped, azimuth kept), so the floor inherits the physical horizon's actual
    // colour in that direction — warm on the sun's side of a sunset, cool opposite —
    // then dims with depth on the old dome's curve. Above the horizon the clamp is a
    // no-op and this is exactly skyRadiance(dir).
    // HOW DEEP BLUE HAPPENS: the old dome's LUT marches below-horizon rays to the
    // ground with NO albedo — a short path over black, which is a dark saturated blue
    // that deepens with steepness. Our Hillaire LUT instead adds a sun-lit ground term
    // (grey), and a first fix that mirrored the horizon band downward with a gentle dim
    // stayed pale for the whole visible range. So the floor is built explicitly: the
    // physical horizon colour AT the line (continuous, and warm on a sunset's sun side),
    // deepening quickly into the authored zenith blue — bright band at 0°, rich navy by
    // ~-25°, exactly the old floor's read with the physical sky's hue.
    if (atmosphere) {
      const dirH = normalize(vec3(dir.x, max(up, float(0.015)), dir.z));
      const depth = smoothstep(float(0.02), float(-0.45), up);
      const phys = mix(atmosphere.skyRadiance(dirH), zenith.mul(0.35), depth);
      col.assign(mix(col, phys, uAtmoMix));
    }

    /*
     * ── EARTH'S SHADOW AND THE BELT OF VENUS ────────────────────────────────────────
     *
     * The two things a real sky does at dusk that the wash above only gestures at, and
     * the reason a photograph of twilight is instantly recognisable.
     *
     * Look AWAY from a setting sun and you are looking at the planet's own shadow
     * projected onto the air: a blue-grey band sitting on the horizon with a soft but
     * definite top edge. Directly above it is the Belt of Venus, a pink band — sunlight
     * that has grazed the atmosphere, been reddened by the long path, and is
     * back-scattered toward you. The pair rises together as the sun sinks, and the
     * shadow's edge is the geometric line between them.
     *
     * The geometry, simplified to what the eye checks: the top of the shadow sits at
     * roughly the anti-solar elevation, so it climbs as the sun goes down; both bands
     * are centred on the anti-solar AZIMUTH and fade toward the sun's side; and the
     * whole effect only exists while the sun is within a few degrees of the horizon —
     * before that there is no shadow to see, after it the shadow has swallowed the sky.
     *
     * `antiAmt` is how far this ray is from the sun in azimuth (1 = opposite), `edge` is
     * the shadow's rising top. Below the edge the sky takes the shadow colour; just above
     * it, the belt.
     */
    {
      const sunBelow = uSunDir.y.negate();
      // Alive from just before sunset to the end of civil twilight (~-6 deg).
      const window = smoothstep(float(-0.13), float(-0.01), uSunDir.y)
        .mul(smoothstep(float(0.06), float(0.005), uSunDir.y));
      // Opposite the sun in azimuth only — the bands wrap the anti-solar horizon.
      const sunXZn = normalize(vec3(uSunDir.x, 0.0, uSunDir.z).add(vec3(1e-5, 0.0, 0.0)));
      const dirXZn = normalize(vec3(dir.x, 0.0, dir.z).add(vec3(1e-5, 0.0, 0.0)));
      const antiAmt = saturate(dot(dirXZn, sunXZn).negate().mul(0.5).add(0.5)).pow(1.5);
      // The shadow's top edge climbs with the sun's depth; floored so it exists at all
      // at the moment of sunset, when the band is a thin dark line on the horizon.
      const edge = sunBelow.max(0.0).mul(uEarthShadowRise).add(0.012);
      const inShadow = smoothstep(edge.add(uEarthShadowSoft), edge, up)
        .mul(smoothstep(float(-0.02), float(0.01), up));
      const inBelt = smoothstep(edge.sub(uEarthShadowSoft.mul(0.5)), edge.add(uBeltWidth.mul(0.5)), up)
        .mul(smoothstep(edge.add(uBeltWidth.mul(1.6)), edge.add(uBeltWidth.mul(0.6)), up));
      col.assign(mix(col, uAnti, saturate(inShadow.mul(antiAmt).mul(window).mul(uEarthShadow))));
      col.addAssign(uBeltColor.mul(inBelt.mul(antiAmt).mul(window).mul(uBelt)));
    }

    /*
     * ── AIRGLOW ─────────────────────────────────────────────────────────────────────
     *
     * Why a real night sky is not black. Even with no moon and no towns, the upper
     * atmosphere emits its own light — chemiluminescence from oxygen and sodium, which
     * is why it skews faintly green — and that emitting layer is ~90 km up, so looking
     * toward the horizon you see through far more of it than at the zenith. The result
     * is a sky that is deepest overhead and lifts noticeably in the last twenty degrees
     * above the horizon.
     *
     * Without it the night here was mathematically correct and visually dead: the stars
     * had nothing to sit against, and the horizon line vanished entirely. This is the
     * single cheapest thing that makes night read as OUTDOORS rather than as a black
     * screen with dots on it.
     */
    {
      const layer = pow(saturate(float(1.0).sub(max(up, float(0.0)))), float(2.2));
      const glow = layer.mul(0.55).add(0.45).mul(uNightF).mul(uAirglow);
      col.addAssign(uAirglowColor.mul(glow).mul(smoothstep(float(-0.03), float(0.06), up)));
    }

    const tHit = uCloudTop.sub(uCamY).div(min(up, float(-0.001)));
    const hitXZ = vec2(dir.x, dir.z).mul(tHit);
    const n1 = vnoise2(hitXZ.mul(uCloudSeaScale));
    const n2 = vnoise2(hitXZ.mul(uCloudSeaScale.mul(2.3)).add(vec2(17.1, 9.4)));
    const sea = n1.mul(0.65).add(n2.mul(0.35));
    const seaMask = smoothstep(float(0.0), float(0.2), tHit)
      .mul(smoothstep(float(0.02), float(-0.08), up))
      .mul(uCloudSea);
    const seaCol = mix(uSeaDark, uSeaBright, sea);
    col.assign(mix(col, seaCol, seaMask));

    const aboveHorizon = smoothstep(float(-0.02), float(0.1), up);
    If(uNightF.greaterThan(0.02).and(up.greaterThan(-0.02)), () => {
      // No blanket nightF fade here: each star carries its own (see `appear`), and the
      // Milky Way band keeps the global one inside starField.
      col.addAssign(starField(dir, float(1.0)).mul(aboveHorizon));
    });

    /*
     * THE MOON AND THE SUN, both from the shared glare functions above. They used to be
     * written out here; they moved because the BLOOM buffer needs exactly the same
     * maths, and two copies of a sun is how the glow stops matching the disc.
     */
    // Also read by the painted-cloud block below for its key light, so it lives HERE and
    // not only inside sunGlare — moving it into the glare function is what blanked the sky.
    const sunUpFade = smoothstep(float(-0.04), float(0.08), uSunDir.y);
    col.addAssign(moonGlare(dir, float(1.0)));
    col.addAssign(sunGlare(dir, float(1.0)));

    /*
     * PAINTED CLOUD DECK — the cheap tier, composited LAST ON PURPOSE.
     *
     * Everything above (stars, moon, sun disc and glow) is sky BEHIND the deck, so the
     * deck has to be able to cover it: an opaque cloud crossing the sun must hide the
     * sun, and a thin one must let it burn through at its own alpha. Compositing before
     * the sun instead would put the disc in front of the cloud — the classic giveaway.
     *
     * It also means the deck's aerial-perspective term gets the FULL sky colour behind
     * this exact pixel to dissolve into, including the sun glow, which is what stops a
     * far cloud sitting on top of a bright horizon like a sticker.
     */
    if (paintedClouds) {
      /*
       * THE KEY LIGHT IS REAL TRANSMITTANCE, NOT THE AUTHORED SUN COLOUR — the same trap
       * the volumetric deck already fell into, and the same fix.
       *
       * `uSunColor` is authored for the SUN DISC and the horizon wash: at dusk it is
       * `LOOK_DUSK.sun` = #ff8a40, a deep orange. On a disc that is right. Used as the
       * LIGHT COLOUR for a whole cloud deck it paints every lit face flat neon orange,
       * far more saturated than the sky behind it, and — because it saturates the
       * channel — it also erases all the shading form the normal and shadow terms
       * computed. Desaturating it was tried and only made a duller orange.
       *
       * `uCloudKey` is the sun's actual spectral transmittance to the deck's altitude
       * (see pushLook), which is what the volumetric tier is lit by. Both tiers now
       * agree about the colour of sunset by construction rather than by tuning.
       */
      /*
       * The deck's key light: the sun's transmittance while it is up, the MOON once it is
       * not. The moon term is a real key now, not the flat 0.12 tint it used to be — it is
       * scaled by how much of the disc is lit and how high it sits, so the deck only gets
       * moonlight when there is moonlight to get. See uDeckLightDir for the direction.
       */
      const keyCol = uCloudKey.mul(sunUpFade)
        .add(uMoonColor.mul(uMoonCloudKey).mul(uMoonLight).mul(uNightF));
      const ambCol = mix(horizon, zenith, float(0.55));
      const cirrusKey = uCirrusKey.mul(sunUpFade)
        .add(uMoonColor.mul(0.12).mul(smoothstep(-0.04, 0.08, uMoonDir.y)).mul(uNightF));
      /*
       * AMBIENT BY DIRECTION for the deck: the sky's own radiance straight up, and at the
       * horizon on the sun side and the anti-sun side. From the physical atmosphere when
       * it is showing. Handed over as a PROVIDER (a callback the deck invokes while building
       * its shader) so the deck decides where the nodes live. One flat ambient colour is
       * why a sunset deck used to be a single salmon mass.
       */
      paintedClouds.setAmbientProvider(() => ({
        // The authored gradient's own three directions — uniforms, no texture taps. The
        // physical-sky LUT version of these cost a quarter of the deck (measured) because
        // in a cloudy view nearly every pixel is a cloud pixel.
        zenith,
        sun: mix(horizon, uTwilight, uTwilightF.mul(0.5)),
        anti: mix(horizon, uAnti, uTwilightF.mul(0.55)),
      }));
      const deck = paintedClouds.shade(dir, col, uDeckLightDir, keyCol, ambCol, cirrusKey);
      col.assign(mix(col, deck.rgb, deck.a));
    }

    return vec4(col, 1.0);
  });

  function clamp01(x) {
    return max(float(0.0), min(float(1.0), x));
  }

  const material = new THREE.MeshBasicNodeMaterial();
  material.colorNode = skyColorNode();
  /*
   * ── THE SUN HAS TO REACH THE BLOOM BUFFER ────────────────────────────────────────
   *
   * v3's bloom is SELECTIVE: the post pipeline feeds the bloom pass the scene's
   * EMISSIVE MRT attachment and nothing else, so a surface glows only if its material
   * writes one. The sky wrote none. That is why the sun never bloomed however bright
   * the disc was set — it was never a candidate, and no amount of strength or threshold
   * on the bloom pass could have changed it.
   *
   * What goes in: the disc and the aureole, at `sunBloom`, and the moon at `moonBloom`.
   * What stays out: the broad low wash (the `wideW` argument is 0 here), because that
   * covers most of the sky and would come back as a veil over the whole frame — which
   * is the failure mode of unthresholded bloom, arrived at from the other direction.
   *
   * Multiplied by `uSunOcclusion`, the same figure the lens flare fades on, so when a
   * cloud crosses the sun the glare, the flare and the bloom all go together instead of
   * the sun blooming through a thunderhead.
   */
  applyBloomMRT(material, Fn(() => {
    const dir = normalize(positionWorld.sub(cameraPosition));
    const glare = sunGlare(dir, float(0.0)).mul(uSunBloom).mul(uSunOcclusion)
      .add(moonGlare(dir, float(0.0)).mul(uMoonBloom)).toVar();
    /*
     * THE STARS BLOOM TOO — without this they are flat dots. Gated on night exactly as
     * the visible field is, and passed mwW = 0 so the Milky Way band stays out: a broad
     * low band through a bloom is a grey smear across the sky, not a galaxy.
     */
    If(uNightF.greaterThan(0.02).and(dir.y.greaterThan(float(-0.02))), () => {
      const up = smoothstep(float(-0.02), float(0.1), dir.y);
      glare.addAssign(starField(dir, float(0.0)).mul(up).mul(uStarBloom));
    });
    return glare;
  })());
  material.side = THREE.BackSide;
  material.depthWrite = false;
  material.depthTest = false;
  material.fog = false;

  const mesh = new THREE.Mesh(new THREE.SphereGeometry(SKY_RADIUS, 32, 16), material);
  mesh.renderOrder = -2;
  mesh.frustumCulled = false;
  mesh.name = "ModularRoadSkyDome";

  let _timeSec = 0;
  let _lastLook = null;

  function pushLook(camY, look) {
    uCamY.value = camY;
    uCloudBase.value = P.cloudBase;
    uCloudTop.value = P.cloudBase + P.cloudThickness;
    uTime.value = _timeSec;
    uSunDir.value.copy(look.sunDir);
    uMoonDir.value.copy(look.moonDir);
    uSunColor.value.copy(look.sunColor);
    uMoonColor.value.copy(look.moonColor);
    uSunDiscBright.value = P.sunDiscBright;
    // Derived from the authored DIAMETER; see sunSizeDeg.
    P.sunDiscCos = Math.cos(THREE.MathUtils.degToRad(Math.max(0.02, P.sunSizeDeg) * 0.5));
    uSunDiscCos.value = P.sunDiscCos;
    uSunGlowPow.value = P.sunGlowPow;
    uSunGlowStrength.value = P.sunGlowStrength * (0.7 + 0.9 * look.twilightF);
    uSunDiscScale.value = P.sunDiscScale;
    uSunFlatten.value = P.sunFlatten;
    uAureole.value = P.aureole;
    uAureoleG.value = P.aureoleG;
    uAureoleHaze.value = P.aureoleHaze;
    uSunBloom.value = P.sunBloom;
    uMoonBloom.value = P.moonBloom;
    uStarBloom.value = P.starBloom;
    uSunLimb.value = P.sunLimb;
    uMoonCos.value = Math.cos((P.moonSizeDeg * DEG) / 2);
    uMoonRad.value = (P.moonSizeDeg * DEG) / 2;
    uEarthshine.value = P.moonEarthshine ?? 0.055;
    uMoonDiscBright.value = P.moonDiscBright;
    uMoonCloudKey.value = P.moonCloudKey;
    uMoonLight.value = look.moonLight ?? 0;
    /*
     * Switched, not blended. Interpolating between two directions passes through zero
     * when they are opposed, which is exactly the sunset-to-moonrise case. The switch is
     * safe because it happens where the sun's own key has already faded to nothing, so
     * there is no lit surface to pop.
     */
    _deckLight.copy(look.sunDir.y > 0 ? look.sunDir : look.moonDir);
    uDeckLightDir.value.copy(_deckLight);
    uAtmoMix.value = P.atmosphereMix ?? uAtmoMix.value;
    uZenithBelow.value.copy(look.zenithBelow);
    uHorizonBelow.value.copy(look.horizonBelow);
    uNadirBelow.value.copy(look.nadirBelow);
    uZenithInside.value.copy(look.zenithInside);
    uHorizonInside.value.copy(look.horizonInside);
    uNadirInside.value.copy(look.nadirInside);
    uZenithAbove.value.copy(look.zenithAbove);
    uHorizonAbove.value.copy(look.horizonAbove);
    uNadirAbove.value.copy(look.nadirAbove);
    uSeaDark.value.copy(look.seaDark);
    uSeaBright.value.copy(look.seaBright);
    uTwilight.value.copy(look.twilight);
    uAnti.value.copy(look.anti);
    uHorizonPow.value = P.horizonPow;
    uHorizonGlow.value = P.horizonGlow;
    uNadirPow.value = P.nadirPow;
    uCloudSea.value = P.cloudSea;
    uCloudSeaScale.value = P.cloudSeaScale;
    uNightF.value = look.nightF;
    uTwilightF.value = look.twilightF;
    uStarBrightness.value = P.starBrightness;
    uAirglow.value = P.airglow;
    uEarthShadow.value = P.earthShadow;
    uEarthShadowRise.value = P.earthShadowRise;
    uEarthShadowSoft.value = P.earthShadowSoft;
    uBelt.value = P.belt;
    uBeltWidth.value = P.beltWidth;
    uStarDensity.value = P.starDensity;
    uStarBar.value = P.starBar;
    uStarSize.value = P.starSize;
    uMilkyWay.value = P.milkyWay;

    /*
     * The painted deck's key light: what the sun actually looks like after travelling
     * through the atmosphere to the deck's altitude. Costs one CPU integral per look
     * change (the clock is frozen by default, so effectively never), and it is the same
     * function the volumetric tier's light colour comes from — which is the point.
     */
    if (paintedClouds) {
      const sy = THREE.MathUtils.clamp(look.sunDir.y, -1, 1);
      sunTransmittanceCPU(sy, paintedClouds.params.altitude, undefined, _keyRgb);
      uCloudKey.value.setRGB(_keyRgb[0], _keyRgb[1], _keyRgb[2]);
      sunTransmittanceCPU(sy, paintedClouds.params.cirrusAltitude, undefined, _cirrusRgb);
      uCirrusKey.value.setRGB(_cirrusRgb[0], _cirrusRgb[1], _cirrusRgb[2]);
    }
  }

  function update(frame = {}) {
    const dt = frame.dt ?? 0;
    _timeSec += dt;
    if (P.autoAdvance) {
      P.timeOfDay = (P.timeOfDay + P.daySpeed * dt + 24) % 24;
    }
    const cam = frame.camera;
    const y = cam?.position.y ?? 0;
    if (cam) mesh.position.copy(cam.position);
    const look = evaluateSky(P);
    _lastLook = look;
    pushLook(y, look);
    paintedClouds?.update(dt, cam?.position, look.sunDir, uCloudKey.value);
    P.sunElevation = look.sunElevation;
    P.sunAzimuth = look.sunAzimuth;
    return look;
  }

  function setTimeOfDay(t) {
    P.timeOfDay = ((t % 24) + 24) % 24;
  }

  /** 1 = clear sun, 0 = fully occluded. Fed from the game's lens-flare occlusion. */
  function setSunOcclusion(v) {
    uSunOcclusion.value = Math.max(0, Math.min(1, v));
  }

  function setSunDiscScale(v) {
    P.sunDiscScale = v;
    uSunDiscScale.value = v;
  }

  function dispose() {
    mesh.geometry.dispose();
    material.dispose();
    moonSurface.dispose();
    milkyWay.dispose();
  }

  return {
    mesh,
    params: P,
    update,
    setTimeOfDay,
    setSunDiscScale,
    setSunOcclusion,
    /** 0 = authored gradient, 1 = physical atmosphere. Crossfade, not a switch. */
    setAtmosphereMix: (x) => { uAtmoMix.value = Math.max(0, Math.min(1, x)); },
    getAtmosphereMix: () => uAtmoMix.value,
    hasAtmosphere: !!atmosphere,
    getLook: () => _lastLook,
    getColors: (camY) => skyColorsAt(camY ?? uCamY.value, P),
    dispose,
  };
}
