/**
 * THE LIGHT A CLOUD DECK IS LIT BY, derived from the sky it sits under.
 *
 * This is the piece that makes a sky and a cloud deck look like one world instead of two
 * systems in the same frame: the deck's key light, its ambient, and the colour distant
 * clouds fade into all come out of the same atmosphere model the dome is drawn with, so
 * they track the whole day cycle together instead of drifting apart as two authored
 * palettes.
 *
 * ENGINE-OWNED since 2026-09-18. It was ~120 lines inside `roadGame.js`
 * (`syncCloudSkyColours`), where only that game could reach it; the v3 editor's
 * "Atmosphere" sky mode needs exactly the same derivation, and a second copy would have
 * drifted from this one within a week. Both callers now use this.
 *
 * Every non-obvious constant here was arrived at by looking at a wrong frame. The
 * comments say which wrong frame; do not tidy them into numbers.
 *
 * @see v3/render/sky/atmosphereSkyDome.js — `skyColorsAt`, the look this reads
 * @see v3/render/sky/skyAtmosphere.js — `sunTransmittanceCPU`, the slant-path integral
 */
import * as THREE from "three/webgpu";
import { skyColorsAt, moonDirFromTime, SKY_DEFAULTS } from "./atmosphereSkyDome.js";
import { sunTransmittanceCPU } from "./skyAtmosphere.js";

/**
 * @param {object} [opts]
 * @param {number} [opts.skyTint] see `params.skyTint` below.
 */
export function createCloudSkyLight({ skyTint = 0.6 } = {}) {
  const _skyParams = { ...SKY_DEFAULTS };

  /**
   * HOW MUCH OF THE SKY'S COLOUR THE CLOUDS TAKE. 1 = exactly what the sky model says,
   * 0 = neutral grey of the same brightness.
   *
   * Not 1 by default, because the sky's sun colour is authored for the SUN DISC and the
   * horizon wash: `evaluateSky` lerps it 85% toward #ff4a12 as the sun nears the horizon.
   * On a disc that is right. Used as the LIGHT COLOUR for a cloud deck it makes every
   * cloud a single flat neon orange, far more saturated than the sky behind it — which
   * reads as a bug even though each half is behaving as designed.
   *
   * Saturation only: the mix target is the colour's own luminance, so dawn stays as
   * bright as it was and night stays as dark. Only the vividness moves.
   */
  const params = { skyTint };

  const _tintSun = new THREE.Color();
  const _tintZenith = new THREE.Color();
  const _tintHorizon = new THREE.Color();
  const _tintHaze = new THREE.Color();
  const _tintHazeSun = new THREE.Color();
  const _tintGrey = new THREE.Color();
  const _sunTransScratch = [0, 0, 0];
  const moonDir = new THREE.Vector3();
  let _usingMoon = false;
  let _key = "";

  const temperTint = (src, dst) => {
    dst.copy(src);
    const t = params.skyTint;
    if (t >= 1) return dst;
    const l = src.r * 0.2126 + src.g * 0.7152 + src.b * 0.0722;
    return dst.lerp(_tintGrey.setRGB(l, l, l), 1 - t);
  };

  /**
   * The object a cloud deck's `update(dt, frame)` reads. `sunDir` is left for the CALLER
   * to write — it owns the light — except at night, where `sync` points it at the moon
   * (see below) because the decision and the matching colour have to be made together.
   */
  const frame = {
    sunDir: new THREE.Vector3(),
    sunColor: 0xfff2dc,
    skyZenith: 0x3f78c8,
    skyHorizon: 0xc9dcef,
    hazeColor: 0xc9dcef,
  };

  /**
   * @param {object} sky   the sky params (timeOfDay / latitude / dayOfYear / moonAge)
   * @param {number} camY  camera altitude, metres
   * @param {number} cloudMidAlt  mid-height of the deck being lit, metres
   *
   * KEY-CACHED. The work below is ~40 `exp()` calls plus a full authored-look blend; the
   * result only moves when the clock, the observer, the altitude band or the tint does.
   */
  function sync(sky, camY, cloudMidAlt) {
    // Latitude / day-of-year / moon age as well as the hour: the look is driven by the
    // sun's ELEVATION, and those are what place the sun in the sky.
    const tod = sky.timeOfDay ?? 12;
    const lat = sky.latitude ?? _skyParams.latitude;
    const doy = sky.dayOfYear ?? _skyParams.dayOfYear;
    const age = sky.moonAge ?? _skyParams.moonAge;
    const band = Math.round(camY / 25);
    // skyTint is in the key so dragging its slider re-evaluates — without it the cache
    // would hold the old tint until the clock happened to move.
    const key = `${tod.toFixed(3)}|${lat}|${doy}|${age}|${band}|${params.skyTint}|${Math.round(cloudMidAlt)}`;
    if (key === _key) return false;
    _key = key;
    _skyParams.timeOfDay = tod;
    _skyParams.latitude = lat;
    _skyParams.dayOfYear = doy;
    _skyParams.moonAge = age;
    const look = skyColorsAt(camY, _skyParams);

    /*
     * SUN COLOUR = REAL TRANSMITTANCE, NOT THE SKY MODEL'S DISC COLOUR.
     *
     * `look.sunColor` is authored for the sun DISC: evaluateSky lerps it 85% toward
     * #ff4a12 as the sun drops. On a disc that is right; used as the LIGHT on a whole
     * cloud deck it floods every mass with one flat saturated salmon — worst at golden
     * hour, where the multiple-scattering floor paints cloud interiors with pure sun
     * colour. The physical answer is the same one the sky itself uses: how much of each
     * wavelength actually survives the slant path to the cloud's altitude. Warm white at
     * noon, gold at 10°, ember at 2°, gone below the horizon — and cloud SHADING keeps
     * its contrast, because only the direct terms carry the colour while ambient stays
     * the sky's. ~40 exp() calls, no GPU readback.
     */
    const elRad = THREE.MathUtils.degToRad(look.look.sunElevation);
    sunTransmittanceCPU(Math.sin(elRad), cloudMidAlt, undefined, _sunTransScratch);
    frame.sunColor = _tintSun.setRGB(
      _sunTransScratch[0], _sunTransScratch[1], _sunTransScratch[2],
    );

    /*
     * NIGHT: THE MOON IS THE LIGHT. The march has exactly one directional light, and with
     * sun-only the deck went pitch black at night — no silvery tops, no lit edges, nothing
     * for the eye to read the sky by. Once the sun is truly down its transmittance is
     * zero, so the light slot is FREE: hand it the moon. Direction snaps rather than lerps
     * (two directions cannot share one march), but the snap happens inside the window
     * where BOTH colours are near-black, so nothing pops. Intensity is cinematic, not
     * physical — the real sun:moon ratio (~1/400000) tone-maps to nothing.
     */
    _usingMoon = look.look.sunElevation < -5;
    if (_usingMoon) {
      moonDirFromTime(_skyParams, moonDir);
      const moonEl = Math.asin(THREE.MathUtils.clamp(moonDir.y, -1, 1));
      sunTransmittanceCPU(Math.sin(moonEl), cloudMidAlt, undefined, _sunTransScratch);
      // Moonlight = sunlight off a grey rock, read blue by night vision (Purkinje).
      // 0.25 is cinematic: through the transmittance, phase and density chain it puts a
      // near-full moon's clouds at ~5% of their daytime brightness — clearly readable
      // silver, nowhere near daylight. 0.055 (the first guess) was invisible.
      const moonAmp = 0.25 * (look.look.moonIllum ?? 1);
      _tintSun.setRGB(
        _sunTransScratch[0] * 0.62 * moonAmp,
        _sunTransScratch[1] * 0.72 * moonAmp,
        _sunTransScratch[2] * 1.0 * moonAmp,
      );
    }

    frame.skyZenith = temperTint(look.zenith, _tintZenith);
    frame.skyHorizon = temperTint(look.horizon, _tintHorizon);

    /*
     * AT TWILIGHT, AMBIENT LEANS ON THE DOME, NOT THE HORIZON BAND. The cloud shader
     * lights bases with `skyHorizon` and tops with `skyZenith`, which is right in daylight
     * where the horizon is just paler blue. At dusk the authored horizon is a saturated
     * orange BAND — a thin strip of sky — while the shadowed underside of a cloud sees
     * mostly the (blue) dome above it. Feeding the band colour straight in painted every
     * anti-solar cloud as a red-rock butte. Verified by elimination: killing the ms floor
     * left the orange untouched — it was ambient all along.
     */
    const twF = look.look.twilightF ?? 0;
    _tintHorizon.lerp(_tintZenith, 0.55 * twF);

    /*
     * AERIAL TARGET = THE HORIZON SKY, NOT THE NADIR HAZE, AND NOT TEMPERED.
     *
     * Distant clouds fade toward this colour, and they sit ON the horizon sky — so if the
     * target is darker than that sky, every far cloud converges to a dirty grey-brown band
     * pasted across a bright horizon. That is exactly what `look.haze` (the NADIR colour —
     * what you see looking DOWN into the murk) was doing, and cloud-lab never showed it
     * because the lab passes its own horizon colour here. Untempered because the temper
     * exists to keep the sky model's saturated sun off the cloud LIGHTING; the aerial term
     * is not lighting, it is the sky showing through, and it should match that sky.
     *
     * DIRECTIONAL at twilight: the sky model already evaluates a warm sunward wash
     * (`twilight`) and a cool anti-solar limb (`anti`) for the dome — hand the same pair to
     * the clouds' aerial term, weighted by how deep into twilight we are, so far clouds go
     * bright gold toward the sun and stay dusky blue opposite it instead of one uniform
     * cream. In full day twilightF is 0 and both targets collapse to the plain horizon.
     */
    frame.hazeColor = _tintHaze.copy(look.horizon);
    frame.hazeSunColor = _tintHazeSun.copy(look.horizon).lerp(look.look.twilight, twF * 0.85);
    frame.hazeColor.lerp(look.look.anti, twF * 0.6);
    frame.skyLook = look.look;
    return true;
  }

  return {
    params,
    frame,
    sync,
    moonDir,
    /** True when `sync` decided the deck's key light is the moon, not the sun. */
    usingMoon: () => _usingMoon,
    /** Force the next `sync` to recompute (e.g. after the sky model's params changed). */
    invalidate: () => { _key = ""; },
  };
}
