/**
 * PAINTED CLOUDS — the cheap tier, for machines that cannot afford the raymarch.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS, AND WHY IT IS NOT THE ENGINE DOME'S CIRRUS.
 *
 * `v3/render/sky/dayNightSky.js` already paints a 2D cirrus deck, and this deliberately
 * replaces it for the game's own sky rather than reusing it, for two measured reasons:
 *
 *   1. IT IS NOT ACTUALLY CHEAP. That deck evaluates a 5-octave 3D value-noise fbm TWICE
 *      per sky pixel — order 40 hash+lerp chains of pure ALU. On the weak integrated GPUs
 *      this tier exists to serve, ALU is exactly the scarce resource and texture units are
 *      the idle one. Here the whole field is BAKED ONCE into one tileable RGBA map and the
 *      shader does ~5 texture fetches. A fallback that costs as much as the thing it is
 *      falling back from is not a fallback.
 *
 *   2. IT IS LIT AS A FLAT SHEET. Its brightness is `mix(0.82, 1.3, pow(dot(view,sun),2.5))`
 *      — a function of VIEW ANGLE ONLY. Every pixel of every cloud at the same screen
 *      position gets the same light regardless of the cloud's own shape, which is precisely
 *      what makes painted clouds read as painted: no form, no self-shadow, no volume. The
 *      eye reads a cloud as three-dimensional from the shading gradient ACROSS its own
 *      billows, and that information was never computed.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * WHAT MAKES A FLAT LAYER READ AS VOLUME (the whole trick, in order of how much it buys):
 *
 *   • SELF-SHADOWING BY OFFSET SAMPLING. Step a few taps across the field TOWARD the sun
 *     and accumulate what you find as optical depth. A pixel with cloud between it and the
 *     sun goes dark; a pixel with clear field beside it stays lit. That single term turns
 *     a noise blob into a lumpy mass with a lit side and a shaded side — it is a real
 *     (if 2D) light march, not a fake. Everything else here is a refinement of it.
 *   • SHADOW LENGTH FROM SUN ELEVATION. The offset scales with 1/sin(elevation), so a low
 *     sun throws long shadows across the deck and the whole sky goes dramatic at dusk for
 *     free, because it is the same geometry the real thing uses.
 *   • DOMAIN WARP. Sampling the field through a low-frequency displacement turns round
 *     fbm blobs into sheared, curled masses. Noise looks like noise; warped noise looks
 *     like weather.
 *   • COVERAGE AS A THRESHOLD, NOT A MULTIPLIER — the same lesson the volumetric deck
 *     taught: multiplying caps a mass core at the dial value and the whole sky turns to
 *     translucent popcorn. Thresholding leaves cores solid and gaps genuinely open.
 *   • SILVER LINING gated on view/sun geometry, so thin edges blaze when you look toward
 *     the sun and stay neutral when it is behind you.
 *
 * @see modularRoadClouds.js — the expensive tier this stands in for
 * @see modularRoadSky.js    — composites this last, so cloud occludes stars/moon/sun
 */
import * as THREE from "three/webgpu";
import {
  float, vec2, vec3, vec4, Fn, uniform, texture,
  normalize, dot, max, min, mix, smoothstep, pow, exp, abs, saturate,
} from "three/tsl";
import {
  seededRandom, makePeriodicPerlin, perlinFbm, normalizeChannel,
} from "./modularRoadCloudNoise.js";

/** Bake resolution. 256² tiles a few km, so one texel is ~15 m of sky — finer than the
 *  layer's own detail octave, and 256 KB of VRAM. */
export const PAINTED_MAP_SIZE = 256;

export const PAINTED_CLOUD_DEFAULTS = {
  enabled: false,

  // ── Shape ────────────────────────────────────────────────────────────────────────
  /** Metres the deck floats above the CAMERA. Not an absolute altitude: a flat layer has
   *  no parallax to give away that it follows you, and pinning it to the camera keeps the
   *  perspective sane whether you are on the ground or on a sky track at 300 m. */
  altitude: 1500,
  /**
   * Metres one wrap of the map covers.
   *
   * TUNED AGAINST THE ALTITUDE, not independently: the pair sets the ANGULAR size of a
   * cloud, which is the whole difference between "broken cumulus sky" and "smeared
   * overcast". At 780 m / 5200 m the low-frequency field's ~1700 m masses sat so close
   * overhead that two of them filled the view and the deck read as featureless stratus.
   * 1500 m / 3200 m puts a mass at a few degrees across, so you see dozens with blue
   * between them — which is what the coverage threshold was carving all along.
   */
  tile: 3200,
  /** Fraction of sky covered. A THRESHOLD (see the header) — 0 clear, 1 overcast. */
  coverage: 0.5,
  /** Edge softness of the coverage threshold, in field units. */
  softness: 0.13,
  /** Master opacity of the deck. */
  density: 1.0,
  /** Mid/fine octave bite — carves the mass edges into billows. */
  detail: 0.62,
  /** Domain-warp strength, in map units. This is most of "looks like weather". */
  warp: 0.22,
  /** Anisotropy. 1 = cumulus mass, 3+ = stretched cirrus streaks. */
  stretch: 1.0,

  // ── Lighting ─────────────────────────────────────────────────────────────────────
  /** Metres of deck depth the shadow march pretends to cross. Longer = deeper shading. */
  depth: 850,
  /** Extinction along the (2D) light march. */
  absorb: 1.7,
  /**
   * How steeply the coverage field is read as a HEIGHT field for the fake normal.
   * This is the single dial that decides whether the deck looks like billowing cloud
   * or like a printed sheet — it is what gives each mass a lit top and a shaded flank.
   */
  bump: 5.5,
  /**
   * Key-light gain. Cloud droplet albedo is ~0.9 and a sunlit top is far brighter than
   * the sky beside it — at 1.0 the deck comes out a dull beige because it can never
   * exceed the sun colour it is lit by, which is not what a cumulus top looks like.
   * Above ~1.6 the tops clip toward white through the tone map, which is correct.
   */
  sunStrength: 1.9,
  /** Sky ambient reaching the shaded side. 0 = black undersides. */
  ambient: 0.75,
  /** Silver-lining strength on thin edges when looking toward the sun. */
  silver: 0.85,
  /** How strongly the deck dissolves into the sky behind it toward the horizon. */
  aerial: 0.8,
  /** Below this `dir.y` the deck is faded out entirely (it would alias to mush). */
  horizonFade: 0.06,

  // ── Wind ─────────────────────────────────────────────────────────────────────────
  windDeg: 35,
  /** Metres per second. Matches the volumetric deck's units so switching tiers keeps
   *  the same drift. */
  windSpeed: 6.0,
};

/**
 * Bake the tileable cloud map. ~90 ms on this laptop at 256².
 *
 *   R  coverage   low-frequency mass field — what the threshold cuts
 *   G  detail     mid-frequency — erodes mass edges into billows
 *   B  fine       high-frequency — the last bite of texture near the camera
 *   A  warp       very low frequency — displaces the lookup (see `warp`)
 *
 * Every channel is percentile-stretched, for the same load-bearing reason the volumetric
 * bake is: raw fbm occupies a narrow mid band, and a threshold against a 0.2-wide range
 * either accepts everything or rejects everything, so the coverage dial does nothing.
 */
export function bakePaintedCloudMap(seed = 4177, size = PAINTED_MAP_SIZE) {
  const rng = seededRandom(seed >>> 0);
  const perlin = makePeriodicPerlin(rng);
  const out = new Uint8Array(size * size * 4);
  let i = 0;
  for (let y = 0; y < size; y++) {
    // Divide by size (not size-1) so texel 0 !== texel N-1 and the wrap is seamless.
    const ny = y / size;
    for (let x = 0; x < size; x++) {
      const nx = x / size;
      // One lattice, four independent fields by offsetting the sampling plane in Z.
      out[i++] = perlinFbm(perlin, nx, ny, 0.13, 3, 5) * 255;
      out[i++] = perlinFbm(perlin, nx, ny, 0.57, 9, 4) * 255;
      out[i++] = perlinFbm(perlin, nx, ny, 0.91, 22, 3) * 255;
      out[i++] = perlinFbm(perlin, nx, ny, 0.37, 2, 3) * 255;
    }
  }
  for (let c = 0; c < 4; c++) normalizeChannel(out, 4, c);
  return out;
}

/**
 * @param {object}  [opts]
 * @param {number}  [opts.seed]
 * @param {object}  [opts.params] merged onto PAINTED_CLOUD_DEFAULTS
 */
export function createPaintedClouds({ seed = 4177, params = {} } = {}) {
  const P = { ...PAINTED_CLOUD_DEFAULTS, ...params };

  const map = new THREE.DataTexture(
    bakePaintedCloudMap(seed), PAINTED_MAP_SIZE, PAINTED_MAP_SIZE, THREE.RGBAFormat,
  );
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.magFilter = THREE.LinearFilter;
  // MIPMAPS ARE THE HORIZON ANTI-ALIASING. The plane projection compresses the whole
  // remaining deck into the last few degrees above the horizon, so texel density there
  // goes to infinity; without mips that band is a shimmering moiré that no amount of
  // fading hides. With them the hardware picks the LOD per pixel for free.
  map.minFilter = THREE.LinearMipmapLinearFilter;
  map.generateMipmaps = true;
  map.needsUpdate = true;
  const mapTex = texture(map);

  const uAltitude = uniform(P.altitude);
  const uTile = uniform(P.tile);
  const uCoverage = uniform(P.coverage);
  const uSoftness = uniform(P.softness);
  const uDensity = uniform(P.density);
  const uDetail = uniform(P.detail);
  const uWarp = uniform(P.warp);
  const uStretch = uniform(P.stretch);
  const uDepth = uniform(P.depth);
  const uAbsorb = uniform(P.absorb);
  const uBump = uniform(P.bump);
  const uSunStrength = uniform(P.sunStrength);
  const uAmbient = uniform(P.ambient);
  const uSilver = uniform(P.silver);
  const uAerial = uniform(P.aerial);
  const uHorizonFade = uniform(P.horizonFade);
  const uWind = uniform(new THREE.Vector2());

  /** Field lookup at a map position: returns the eroded, thresholded cloud amount. */
  const fieldAt = Fn(([uv]) => {
    const s = mapTex.sample(uv);
    // Erosion REMAPS the mass rather than multiplying it, so the iso-surface itself
    // moves and the silhouette gains billows instead of merely getting darker — the
    // same reason the volumetric deck erodes this way.
    const bite = s.g.mul(0.65).add(s.b.mul(0.35)).mul(uDetail);
    const shaped = s.r.sub(bite.mul(0.5));
    const bar = uCoverage.oneMinus();
    return smoothstep(bar, bar.add(uSoftness), shaped);
  });

  /**
   * Shade the deck for one view ray.
   *
   * @param dir      normalised view direction
   * @param bgCol    the sky colour already computed BEHIND the deck (for aerial fade)
   * @param sunDir   normalised sun direction
   * @param keyCol   the light colour (sun, or moon at night — the caller decides)
   * @param ambCol   sky ambient colour reaching the shaded side
   * @returns vec4(rgb, alpha) — straight alpha, to be mix()'d over the sky
   */
  const shade = Fn(([dir, bgCol, sunDir, keyCol, ambCol]) => {
    const out = vec4(0.0).toVar();

    // Rays at or below the horizon never hit a deck that is above the camera. Fading
    // rather than cutting: the projection compresses infinitely there, so the last few
    // degrees are unresolvable however many mips we have.
    const y = dir.y;
    const hMask = smoothstep(uHorizonFade, uHorizonFade.add(0.16), y);

    // Plane projection: this is what makes a flat layer converge toward the horizon like
    // a real deck instead of sitting on the dome like wallpaper.
    const t = uAltitude.div(max(y, 0.001));
    const world = vec2(dir.x, dir.z).mul(t);
    const uv0 = vec2(world.x.div(uStretch), world.y).div(uTile).add(uWind).toVar();

    // DOMAIN WARP — noise looks like noise; warped noise looks like weather.
    const w = mapTex.sample(uv0.mul(0.35)).a.sub(0.5);
    const uv = uv0.add(vec2(w, w.mul(0.7)).mul(uWarp)).toVar();

    const c = fieldAt(uv).toVar();

    // ── FAKE NORMAL FROM THE FIELD GRADIENT ───────────────────────────────────────
    // Treat the coverage field as a HEIGHT field and difference it: where the mass thickens
    // quickly the surface is steep, where it plateaus it faces up. Two extra taps buy
    // a normal, and a normal buys N·L — which is what puts a bright top and a shaded
    // flank on every individual billow. The shadow march below handles mass-to-mass
    // occlusion; this handles the form of each mass, and the eye needs both.
    const e = float(0.006);
    const cx = fieldAt(uv.add(vec2(e, 0.0))).sub(c);
    const cy = fieldAt(uv.add(vec2(0.0, e))).sub(c);
    const n = normalize(vec3(cx.negate().mul(uBump), 1.0, cy.negate().mul(uBump)));

    // ── SELF-SHADOW MARCH (mass shadowing mass) ───────────────────────────────────
    // Step across the field toward the sun and accumulate what is in the way. The step
    // grows as the sun sinks — 1/sin(elevation) is the real geometry of a long shadow —
    // so dusk gets dramatic banks of light and shade for nothing.
    const sunXZ = normalize(vec3(sunDir.x, 0.0, sunDir.z).add(vec3(1e-5, 0.0, 0.0)));
    // CLAMPED, and the clamp is load-bearing rather than defensive. The 1/sin term runs
    // away as the sun sets — at 11° it asks for 4.2 km of reach, which on a 3.2 km tile
    // is more than one WRAP of the map, so the three taps land at effectively random
    // places, tau averages to a constant and every cloud shades identically. That is
    // exactly when the deck went flat orange at dusk. A quarter of a wrap is as far as
    // the shadow can travel and still be sampling this cloud's own neighbourhood.
    const reach = min(uDepth.div(max(sunDir.y, 0.12)).div(uTile), float(0.25));
    const stepUv = vec2(sunXZ.x.div(uStretch), sunXZ.z).mul(reach);
    const tau = fieldAt(uv.add(stepUv.mul(0.33))).mul(0.5)
      .add(fieldAt(uv.add(stepUv.mul(0.66))).mul(0.3))
      .add(fieldAt(uv.add(stepUv)).mul(0.2));
    const shade = exp(tau.mul(uAbsorb).negate());
    const ndl = saturate(dot(n, sunDir)).mul(0.85).add(0.15); // wrap: droplets scatter round
    const light = ndl.mul(shade);

    // SILVER LINING, gated on geometry: thin cloud between you and the sun blazes, and
    // only then — applied unconditionally it just greys the whole deck (a lesson the
    // volumetric powder term already paid for).
    const mu = saturate(dot(dir, sunDir));
    const rim = pow(mu, float(6.0)).mul(c.oneMinus()).mul(uSilver);

    const lit = keyCol.mul(light.mul(uSunStrength).add(rim));
    // Thin cloud passes more sky light than a thick core does.
    const amb = ambCol.mul(uAmbient).mul(mix(float(1.0), float(0.55), c));
    const col = lit.add(amb).toVar();

    // Aerial perspective: distant deck recedes into the sky BEHIND it, so the layer
    // dissolves toward the horizon instead of holding full contrast to the edge.
    const aerial = smoothstep(float(0.45), float(0.02), y).mul(uAerial);
    col.assign(mix(col, bgCol, aerial));

    out.assign(vec4(col, c.mul(uDensity).mul(hMask)));
    return out;
  });

  const _windAccum = new THREE.Vector2();

  /** @param {number} dt seconds */
  function update(dt) {
    const rad = THREE.MathUtils.degToRad(P.windDeg);
    // Metres, converted to map units on read — so the wind speed dial means the same
    // thing here as it does on the volumetric deck.
    _windAccum.x += Math.cos(rad) * P.windSpeed * dt;
    _windAccum.y += Math.sin(rad) * P.windSpeed * dt;
    uWind.value.set(_windAccum.x / P.tile, _windAccum.y / P.tile);

    uAltitude.value = P.altitude;
    uTile.value = P.tile;
    uCoverage.value = P.coverage;
    uSoftness.value = P.softness;
    uDensity.value = P.density;
    uDetail.value = P.detail;
    uWarp.value = P.warp;
    uStretch.value = P.stretch;
    uDepth.value = P.depth;
    uAbsorb.value = P.absorb;
    uBump.value = P.bump;
    uSunStrength.value = P.sunStrength;
    uAmbient.value = P.ambient;
    uSilver.value = P.silver;
    uAerial.value = P.aerial;
    uHorizonFade.value = P.horizonFade;
  }

  return {
    params: P,
    map,
    shade,
    update,
    dispose() { map.dispose(); },
  };
}
