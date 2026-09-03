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
  float, vec2, vec3, vec4, Fn, If, uniform,
  positionWorld, cameraPosition,
  normalize, dot, max, min, mix, smoothstep, pow, exp,
  sin, fract, floor, abs, length, step,
} from "three/tsl";

import { sunTransmittanceCPU } from "./modularRoadSkyAtmosphere.js";

const SKY_RADIUS = 4000;
/** Scratch for the painted deck's key-light integrals — reused, allocates nothing. */
const _keyRgb = [1, 1, 1];
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
  sunDiscCos: 0.99955,
  sunGlowPow: 9,
  sunGlowStrength: 0.48,
  sunDiscScale: 1,
  moonSizeDeg: 1.7,
  moonDiscBright: 3.2,

  horizonPow: 0.4,
  horizonGlow: 0.16,
  nadirPow: 1.25,
  cloudSea: 0.55,
  cloudSeaScale: 0.0035,
  zenithDepth: 1,
  starBrightness: 1,
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
  const exposure = 0.52 * w.night + 0.78 * w.dusk + 0.92 * w.golden + 1.0 * w.day;
  const dirIntensity = 0.22 * moonIllum * w.night + 1.1 * w.dusk + 2.4 * w.golden + 3.1 * w.day;
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
    nightF, twilightF, dayF, duskBias, moonIllum,
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
  const uMoonCos = uniform(Math.cos((P.moonSizeDeg * DEG) / 2));
  const uMoonDiscBright = uniform(P.moonDiscBright);
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

  const hash33 = Fn(([p]) => {
    const q = vec3(
      dot(p, vec3(127.1, 311.7, 74.7)),
      dot(p, vec3(269.5, 183.3, 246.1)),
      dot(p, vec3(113.5, 271.9, 124.6)),
    );
    return fract(sin(q).mul(43758.5453));
  });

  const starField = Fn(([dir]) => {
    const sp = dir.mul(240.0);
    const cell = floor(sp);
    const f = fract(sp).sub(0.5);
    const rnd = hash33(cell);
    const present = step(0.86, rnd.x);
    const off = hash33(cell.add(vec3(1.7, 9.2, 3.3))).sub(0.5).mul(0.65);
    const d = length(f.sub(off));
    const size = mix(float(0.03), float(0.09), rnd.z.mul(rnd.z));
    const core = smoothstep(size, float(0.0), d);
    const mag = mix(float(0.45), float(1.8), rnd.y.mul(rnd.y));
    const tw = sin(uTime.mul(2.4).add(rnd.y.mul(6.2831))).mul(0.28).add(0.72);
    const col = mix(vec3(0.65, 0.78, 1.0), vec3(1.0, 0.88, 0.7), rnd.z.mul(rnd.z));
    return col.mul(present.mul(core).mul(mag).mul(tw).mul(uStarBrightness).mul(4.2));
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
      col.addAssign(starField(dir).mul(uNightF).mul(aboveHorizon));
    });

    const moonDot = dot(dir, uMoonDir);
    const moonUpFade = smoothstep(-0.05, 0.06, uMoonDir.y);
    const moonDisc = smoothstep(uMoonCos, float(1.0), moonDot);
    const moonN = normalize(uMoonDir.add(dir.sub(uMoonDir).mul(22.0)));
    const moonLit = max(dot(moonN, uSunDir), float(0.04));
    const moonGlow = pow(max(moonDot, float(0.0)), float(80.0)).mul(0.22);
    col.addAssign(
      uMoonColor.mul(moonDisc.mul(moonLit).mul(uMoonDiscBright).add(moonGlow))
        .mul(moonUpFade).mul(uNightF.add(0.15)),
    );

    const sunDot = dot(dir, uSunDir);
    const sunUpFade = smoothstep(-0.04, 0.08, uSunDir.y);
    const mu = max(sunDot, float(0.0));
    const disc = smoothstep(uSunDiscCos, float(1.0), sunDot)
      .mul(uSunDiscBright).mul(uSunDiscScale);
    const glow = pow(mu, uSunGlowPow).mul(uSunGlowStrength);
    col.addAssign(uSunColor.mul(disc.add(glow)).mul(sunUpFade));

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
      const keyCol = uCloudKey.mul(sunUpFade)
        .add(uMoonColor.mul(0.12).mul(smoothstep(-0.04, 0.08, uMoonDir.y)).mul(uNightF));
      const ambCol = mix(horizon, zenith, float(0.55));
      const cirrusKey = uCirrusKey.mul(sunUpFade)
        .add(uMoonColor.mul(0.12).mul(smoothstep(-0.04, 0.08, uMoonDir.y)).mul(uNightF));
      const deck = paintedClouds.shade(dir, col, uSunDir, keyCol, ambCol, cirrusKey);
      col.assign(mix(col, deck.rgb, deck.a));
    }

    return vec4(col, 1.0);
  });

  function clamp01(x) {
    return max(float(0.0), min(float(1.0), x));
  }

  const material = new THREE.MeshBasicNodeMaterial();
  material.colorNode = skyColorNode();
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
    uSunDiscCos.value = P.sunDiscCos;
    uSunGlowPow.value = P.sunGlowPow;
    uSunGlowStrength.value = P.sunGlowStrength * (0.7 + 0.9 * look.twilightF);
    uSunDiscScale.value = P.sunDiscScale;
    uMoonCos.value = Math.cos((P.moonSizeDeg * DEG) / 2);
    uMoonDiscBright.value = P.moonDiscBright;
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

  function setSunDiscScale(v) {
    P.sunDiscScale = v;
    uSunDiscScale.value = v;
  }

  function dispose() {
    mesh.geometry.dispose();
    material.dispose();
  }

  return {
    mesh,
    params: P,
    update,
    setTimeOfDay,
    setSunDiscScale,
    /** 0 = authored gradient, 1 = physical atmosphere. Crossfade, not a switch. */
    setAtmosphereMix: (x) => { uAtmoMix.value = Math.max(0, Math.min(1, x)); },
    getAtmosphereMix: () => uAtmoMix.value,
    hasAtmosphere: !!atmosphere,
    getLook: () => _lastLook,
    getColors: (camY) => skyColorsAt(camY ?? uCamY.value, P),
    dispose,
  };
}
