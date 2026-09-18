/**
 * THE WORLD LIT BY THE SKY IT IS UNDER.
 *
 * Given a sky look, this computes what the scene's lights should be: the key light's
 * colour and intensity, the hemisphere's two colours, exposure, the moon's strength at
 * night, and how bright the environment map is. It is the difference between a world with
 * a sky painted behind it and a world that is actually IN that sky — a sunset that reddens
 * the key light and dims the fill, a night that is genuinely dark but not black.
 *
 * Measured before this existed, in the racing game: from noon (sun +61.7°) down to +1°,
 * the applied key light was byte-identical at #fff5e0. The engine handled the day/night
 * SHAPE correctly — faded the sun out near the horizon, swapped to a cool moon below it —
 * but the sun's COLOUR was an authored constant, so a sunset only ever dimmed a
 * noon-white lamp.
 *
 * ENGINE-OWNED since 2026-09-18. It was ~140 lines inside `roadGame.js`
 * (`syncWorldLightToSky`); the v3 editor's "Atmosphere" sky mode needs the same thing, and
 * without it the editor sat on static defaults while the game was being lit by its sky —
 * which is exactly what the editor looking "darker and flatter" turned out to be.
 *
 * It COMPUTES and returns; it does not apply. The caller owns its own lights, and the
 * racing game has things to add on top (a lightning flash, the car's night rim, smoke
 * lamps, auto headlights) that have no business in here.
 *
 * @see v3/render/sky/cloudSkyLight.js — the same idea for a cloud deck
 * @see v3/render/sky/skyAtmosphere.js — `sunTransmittanceCPU`, where the key colour comes from
 */
import * as THREE from "three/webgpu";
import { sunTransmittanceCPU } from "./skyAtmosphere.js";

/**
 * `evaluateSky`'s own daylight values, used to normalise its output into a MULTIPLIER on
 * the caller's reference lighting. Without this the sky's absolute numbers would replace
 * whatever the world was tuned to instead of modulating it.
 */
const DAY_REF = 3.1;
const HEMI_DAY_REF = 0.62;

/**
 * What the world's lighting is at noon under this sky — the values the sky's day/night
 * curve multiplies. These are the racing game's, and it wrote down why: the v3 editor's
 * own defaults (0.2 env / 0.4 hemi) are "why the scene reads dark — almost nothing fills
 * the shadows". A reference, not a look: change these and noon changes, and every other
 * hour follows from it.
 */
export const WORLD_LIGHT_REFERENCE = {
  dir: 2.6,
  hemi: 0.6,
  exposure: 1.0,
  env: 0.45,
};

export function createSkyWorldLight() {
  /** 0 = keep a neutral lamp, 1 = full atmospheric reddening. */
  const params = { enabled: true, warmth: 1.0 };

  /*
   * A FLOOR UNDER THE NIGHT AMBIENT.
   *
   * The hemisphere light takes its two colours from the sky's own radiance, and at night
   * that is honestly, measurably black — #010104 overhead and #040811 underfoot at 22:30.
   * Multiply by a low intensity and a low exposure and the world's fill light is gone:
   * everything that is not in a light pool or emissive renders as a silhouette.
   *
   * Real night is never that. Airglow, starlight, scattered moonlight and — over a city —
   * skyglow all put a floor under it that the sky's own radiance does not model. This is
   * that floor. Deliberately a LERP TO, not a multiply: at noon nightK is 0 and every
   * number is untouched, so a hand-tuned day look cannot regress through here.
   */
  const night = {
    enabled: true,
    /** Hemisphere intensity at full night, as a fraction of the noon reference. */
    intensity: 1.0,
    /** What the night sky hands a surface facing up … */
    skyColor: "#7799cc",
    /** … and what the ground bounces back up at it. */
    groundColor: "#33404f",
  };

  const _white = new THREE.Color(1, 1, 1);
  const _keyCol = new THREE.Color();
  const _hemiSky = new THREE.Color();
  const _hemiGnd = new THREE.Color();
  const _nightSky = new THREE.Color();
  const _nightGnd = new THREE.Color();
  /**
   * Moonlight's own chromaticity — sunlight off grey rock, read blue by night vision.
   * Built from LINEAR components on purpose: `new THREE.Color(r, g, b)` writes working
   * space directly, while the same colour written as an sRGB hex would decode to roughly
   * (0.35, 0.46, 0.79) and give a far deeper blue night than the one that was tuned.
   */
  const _moonKeyCol = new THREE.Color(0.62, 0.72, 1.0);
  const _sunLitRgb = [0, 0, 0];
  let _key = "";

  const out = {
    dirColor: new THREE.Color(),
    dirIntensity: 1,
    hemiSkyColor: new THREE.Color(),
    hemiGroundColor: new THREE.Color(),
    hemiIntensity: 1,
    exposure: 1,
    moonIntensity: 0,
    envIntensity: 1,
    /** 0 above the horizon, 1 six degrees under it. Callers hang night effects on this. */
    nightK: 0,
  };

  /**
   * @param {object} look       the sky's look (`update()`'s return / `getLook()`)
   * @param {object} colors     `{ zenith, haze }` at the camera's altitude
   * @param {object} ref        the noon reference — see WORLD_LIGHT_REFERENCE
   * @param {number} [camY]     camera altitude, part of the cache key only
   * @returns {object|null} the computed lighting, or null when nothing moved
   *
   * KEY-CACHED ON SOLAR ELEVATION. With a frozen clock — the default — this runs once and
   * then returns null forever. That is right for the sky and wrong for anything that has
   * to change the light several times a second (a lightning flash), which is why this
   * only computes: the caller keeps the result and applies it every frame.
   */
  function compute(look, colors, ref = WORLD_LIGHT_REFERENCE, camY = 0) {
    if (!params.enabled || !look) return null;
    const el = look.sunElevation ?? 0;
    const key = `${el.toFixed(2)}|${params.warmth}|${Math.round(camY / 50)}`
      + `|${(look.moonLight ?? 0).toFixed(3)}|${ref.dir},${ref.hemi},${ref.exposure},${ref.env}`
      + `|${night.enabled ? night.intensity : -1}`;
    if (key === _key) return null;
    _key = key;

    /*
     * KEY COLOUR = the sun's own transmittance, reduced to CHROMATICITY.
     *
     * The raw transmittance is nearly black at sunset — that is what makes it red — but
     * the engine already owns the brightness (it multiplies by its own horizon fade).
     * Feeding the full value would dim twice and lose the sunset entirely. Dividing by the
     * max channel keeps the HUE and hands the magnitude back, which is the clean split.
     *
     * FLOORED AT THE HORIZON, not below it. Sampling transmittance at a NEGATIVE sun
     * elevation returns essentially zero through every channel, so the chromaticity divide
     * produced BLACK — a key light with no colour at all. Clamping to y = 0 keeps the
     * reddest VALID hue.
     *
     * AND THEN HANDED TO THE MOON. A first version stopped at the clamp, believing the
     * engine never reads this below the horizon. It does: the engine keeps the moon's
     * INTENSITY and DIRECTION at night, but the COLOUR written here wins every frame — so
     * the whole world was lit by a saturated sunset orange (#ff5502, measured at −21°)
     * from dusk until dawn. Below the horizon the key light IS the moon, so the
     * chromaticity has to become moonlight; it blends across the first six degrees under
     * the horizon, the same window in which the clouds swap their light source.
     */
    sunTransmittanceCPU(Math.max(look.sunDir.y, 0.0), 0, undefined, _sunLitRgb);
    const m = Math.max(_sunLitRgb[0], _sunLitRgb[1], _sunLitRgb[2], 1e-4);
    _keyCol.setRGB(_sunLitRgb[0] / m, _sunLitRgb[1] / m, _sunLitRgb[2] / m);
    if (params.warmth < 1) _keyCol.lerp(_white, 1 - params.warmth);
    const nightK = THREE.MathUtils.clamp(-look.sunDir.y / 0.1045, 0, 1);
    if (nightK > 0) _keyCol.lerp(_moonKeyCol, nightK);

    // Ambient from the sky itself: zenith overhead, haze underfoot.
    _hemiSky.copy(colors.zenith);
    _hemiGnd.copy(colors.haze ?? colors.horizon);
    const ambK = night.enabled ? nightK : 0;
    if (ambK > 0) {
      _nightSky.set(night.skyColor);
      _nightGnd.set(night.groundColor);
      _hemiSky.lerp(_nightSky, ambK);
      _hemiGnd.lerp(_nightGnd, ambK);
    }

    out.dirColor.copy(_keyCol);
    out.dirIntensity = (look.dirIntensity / DAY_REF) * ref.dir;
    out.hemiSkyColor.copy(_hemiSky);
    out.hemiGroundColor.copy(_hemiGnd);
    // Lerped, not multiplied: at ambK 0 this IS the plain expression.
    out.hemiIntensity = THREE.MathUtils.lerp(
      (look.hemiIntensity / HEMI_DAY_REF) * ref.hemi,
      night.intensity * ref.hemi,
      ambK,
    );
    out.exposure = look.exposure * ref.exposure;
    /*
     * THE MOON AS A REAL KEY LIGHT. A below-horizon sun makes the engine swap the
     * directional light to its own moon branch, which reads `moonIntensity` and IGNORES
     * the `dirIntensity` above — so the moon's PHASE never reached the world and every
     * night was lit the same. Handing it our own figure (illuminated fraction × how high
     * the moon is) is what makes a full moon overhead light the ground and a new moon
     * leave it dark.
     */
    out.moonIntensity = (look.moonLight ?? 0) * 0.55;
    /*
     * The env map's CONTENT follows the sky, but its STRENGTH was a constant at every
     * hour — so reflections stayed at noon brightness at midnight. Scaled on the same
     * daylight curve as the hemi, against the reference, so noon is unchanged.
     */
    out.envIntensity = (look.hemiIntensity / HEMI_DAY_REF) * ref.env;
    out.nightK = nightK;
    return out;
  }

  /**
   * COLOUR SPACE, and this project has been bitten here before: the engine consumes these
   * as authored sRGB HEX STRINGS (`sun.color.set(Li.dirColor)` decodes sRGB → linear).
   * The values above are already linear working space, so they must be ENCODED back to
   * sRGB on the way out or they get decoded a second time and land 5–10× too dark.
   */
  function toHex(c) {
    return "#" + c.getHexString(THREE.SRGBColorSpace);
  }

  return {
    params,
    night,
    compute,
    toHex,
    /** Force the next compute past its elevation cache. */
    invalidate: () => { _key = ""; },
  };
}
