/**
 * PAINTED CLOUDS — the cheap tier, for machines that cannot afford the raymarch.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * V2: A SLAB MARCH, NOT A STENCIL ON A PLANE. Why the first version looked wrong.
 *
 * v1 projected the view ray onto ONE plane, thresholded a 2D field there and shaded the
 * result with a fake normal. It read as a painted ceiling, and no amount of shading was
 * ever going to fix that, because three things the eye uses to identify cloud cannot
 * exist on a single plane:
 *
 *   • THICKNESS. A cloud seen from below-and-ahead shows its side. A plane shows its
 *     face, always, everywhere — so the deck reads as wallpaper however good the noise.
 *   • SELF-OCCLUSION. Real masses hide each other and pile up toward the horizon. On a
 *     plane every cloud is exactly as visible as every other, which is why v1's sky
 *     looked like a map of islands rather than weather.
 *   • SOFT EDGES FROM DEPTH. A cloud edge is thin cloud you can see through, not an
 *     alpha ramp. Thresholding a plane gives torn-paper outlines.
 *
 * So this marches a THIN SLAB instead: 12 steps between a base and a top altitude,
 * integrating density with Beer-Lambert exactly as the volumetric deck does. That buys
 * every one of the three above, and it is still nothing like the volumetric's cost —
 * 12 steps against 160, a 2D map against three 3D volumes, no render targets, no
 * temporal pass, no worker bake, and it lives inside the sky dome's own fragment shader
 * so it adds no draw call at all.
 *
 * The shape recipe is the volumetric deck's, ported down a dimension: Perlin-Worley
 * masses, coverage as a THRESHOLD (never a multiplier — see modularRoadClouds.js),
 * per-cell cloud TOPS so neighbours differ in height, and Worley billow erosion whose
 * lookup shifts with altitude so a mass is not merely its own outline extruded.
 *
 * @see modularRoadClouds.js — the expensive tier this stands in for
 * @see modularRoadSky.js    — composites this last, so cloud occludes stars/moon/sun
 */
import * as THREE from "three/webgpu";
import {
  float, vec2, vec3, vec4, Fn, If, Loop, Break, uniform, texture, uv,
  normalize, dot, max, min, mix, smoothstep, pow, exp, abs, sqrt, saturate,
  screenCoordinate, interleavedGradientNoise,
} from "three/tsl";
import {
  seededRandom, makePeriodicPerlin, perlinFbm, makeWorley, normalizeChannel,
} from "./modularRoadCloudNoise.js";

/** Bake resolution. 256² over a few km is ~15 m per texel — finer than the billow
 *  octave the shader erodes with, and 256 KB of VRAM. */
export const PAINTED_MAP_SIZE = 256;
/** Compile-time ceiling on the march; `steps` cuts the loop short at runtime. */
const MAX_STEPS = 24;
/** Compile-time ceiling on the god-ray march; `raySteps` cuts it short at runtime. */
const MAX_RAY_STEPS = 24;

export const PAINTED_CLOUD_DEFAULTS = {
  // NO `enabled` FLAG HERE, deliberately. The cloud TIER owns whether this deck exists
  // at all (see roadGame's setCloudTier): out of its tier the module is never
  // constructed, so there is nothing to switch off — no bake, no texture, and no cloud
  // code in the dome's shader. A local enabled flag would be a second, weaker source of
  // truth that reads as if the deck were merely hidden while still costing fetches.

  // ── Shape ────────────────────────────────────────────────────────────────────────
  /** Metres to the BASE of the deck. */
  altitude: 1150,
  /** Metres from base to top. This is the slab the march crosses — it is what gives the
   *  deck thickness, so it is a look control, not just a placement one. */
  thickness: 850,
  /** Metres one wrap of the map covers. Tuned WITH `altitude`: together they set a
   *  cloud's angular size, which is the whole difference between broken cumulus and
   *  smeared overcast. */
  tile: 4300,
  /** Fraction of sky covered. A THRESHOLD, so masses keep solid cores at any setting. */
  coverage: 0.46,
  /**
   * Frequency of the large-scale WEATHER modulation, relative to the cloud tile — and
   * the fix for the sky looking ruled into rows.
   *
   * The map wraps every `tile` metres, and the deck now runs to a 121 km horizon, so it
   * repeats ~28 times across the view. The weather channel exists to make whole regions
   * cloudier or clearer and so hide that, but it was being read from the SAME fetch at
   * the SAME uv as the mass field — which means it repeated on exactly the same period
   * and reinforced the grid instead of breaking it. Every tile got not just the same
   * clouds but the same amount of cloud, and the eye locks onto that instantly as rows
   * converging to a seam.
   *
   * Sampling it at a much lower, incommensurate frequency gives it a ~30 km period, so
   * repeats of the mass field land under different coverage each time and stop reading
   * as copies. (Real skies DO form cloud streets, so rows as such are fine — what is
   * not fine is identical rows at a fixed spacing.)
   */
  weatherScale: 0.137,
  /** How hard the mid-scale billow perturbs the mass BEFORE the coverage threshold.
   *  This is the lobe-vs-blob dial: 0 gives smooth elliptical clouds however hard you
   *  erode them afterwards. See the note at its use site. */
  lumpiness: 0.4,
  /** Billow erosion strength — carves mass edges into cauliflower. */
  erode: 0.68,
  /** Extinction per metre at full shaped density. */
  densityMul: 0.055,
  /** Shortest cloud as a fraction of the slab. The spread between this and 1 IS the
   *  towering-vs-flat look: at 1 every cell fills the slab and you get a sheet. */
  topMin: 0.25,
  /** March steps across the slab (≤ MAX_STEPS). */
  steps: 18,

  // ── Lighting ─────────────────────────────────────────────────────────────────────
  /** Extinction along the 2-tap horizontal shadow — mass shadowing mass. */
  absorb: 2.2,
  /** Metres the shadow tap reaches across the deck before the sun-elevation stretch. */
  shadowReach: 900,
  /** Brightness of a cloud BASE relative to its top. The vertical gradient is most of
   *  what reads as volume once the silhouette is right. */
  baseDark: 0.22,
  /** Key-light gain. Droplet albedo is ~0.9 and a sunlit top is far brighter than the
   *  sky beside it; at 1.0 the deck comes out beige because it can never exceed the sun
   *  colour lighting it. */
  sunStrength: 2.1,
  /**
   * Multiple-scattering floor: the fraction of key light that survives where the
   * horizontal shadow has killed the direct term.
   *
   * Droplet albedo is ~0.99, so light inside a cloud is not absorbed, it is DIFFUSED —
   * radiance tends to a diffusion solution rather than to zero. Without a floor the
   * shadowed cores go a dull flat grey, which is the single most common way rendered
   * clouds look like smoke. The volumetric deck has the same term for the same reason.
   */
  msFloor: 0.18,
  /** Sky ambient reaching the shaded side. 0 = black undersides. */
  ambient: 0.55,
  /** Silver lining on thin cloud when looking toward the sun. */
  silver: 1.1,
  /** How strongly distance dissolves the deck into the sky behind it. */
  aerial: 0.55,
  /**
   * Below this `dir.y` the deck fades out. Small now that the deck CURVES: with a
   * planet under it the slab crossing is finite even at dir.y = 0, so the deck can be
   * followed almost all the way down to the true horizon instead of being cut off
   * early to hide an infinite smear.
   */
  horizonFade: 0.004,
  // ── High cirrus ──────────────────────────────────────────────────────────────────
  /**
   * Master opacity of the high cirrus sheet. 0 skips it entirely.
   *
   * A SECOND LAYER IS WHAT SELLS DEPTH. One deck, however good, gives the eye a single
   * distance to lock onto and the sky reads as a ceiling; two layers at very different
   * altitudes give it parallax and a size comparison, which is most of why a real sky
   * feels deep. This one is also the cheap half of the pair.
   */
  cirrusAmount: 0.42,
  /**
   * Metres. Real cirrus lives at 6-12 km, far above the cumulus deck — and that gap is
   * the point: it is what the eye measures depth against.
   */
  cirrusAltitude: 8000,
  /** Metres one wrap covers. Big, because cirrus fields are. */
  cirrusTile: 15000,
  /** Fraction covered — a threshold, like the deck's. */
  cirrusCoverage: 0.34,
  /**
   * Anisotropy. Cirrus is ice crystals falling through wind shear, so it comes in long
   * parallel filaments rather than blobs; stretching the lookup is what makes streaks.
   */
  cirrusStretch: 4.5,
  /** Cross-streak bend, so the filaments curve instead of running dead straight. */
  cirrusWarp: 0.8,
  /**
   * How far the filament direction wanders off the wind, per region.
   *
   * WITHOUT THIS THE SKY IS RULED PAPER. Stretching the lookup along one fixed axis
   * makes every filament in the sky share one orientation and one spacing, which reads
   * as parallel scratches rather than cloud — the giveaway is that it looks *drawn*.
   * Real cirrus follows the shear, but the shear itself curves and varies, so the fibres
   * arrive in bundles that fan and cross. Rotating the sample axis by a low-frequency
   * field buys exactly that for one extra fetch.
   */
  cirrusSwirl: 0.85,
  /** Forward-scatter gain. Ice is strongly forward-scattering: cirrus near the sun
   *  blazes silver-white, which is its most recognisable behaviour. */
  cirrusSilver: 1.8,
  /** Wind multiplier. High cloud runs with the jet stream — much faster than the deck. */
  cirrusDrift: 2.4,

  /**
   * Planet radius in KILOMETRES — the whole reason the deck has a horizon.
   *
   * A flat slab is hit at `t = altitude / dir.y`, which runs to INFINITY as the ray
   * levels out: the last few degrees above the horizon then contain the entire rest of
   * the deck, smeared into a mushy band that never ends. That band was the weakest part
   * of the look. On a sphere the same ray hits the shell at a finite distance —
   * `sqrt(2·R·h)` at the horizon, about 121 km for a 1.15 km base on Earth — so the
   * clouds bunch up, recede and STOP, which is what a real sky does.
   *
   * Lower it to exaggerate the curve for a stylised, small-planet look.
   */
  planetRadiusKm: 6371,

  // ── God rays ─────────────────────────────────────────────────────────────────────
  /**
   * Sun shafts through the gaps in the deck. 0 skips the pass entirely.
   *
   * The volumetric tier gets these from its resolved cloud buffer's alpha. The painted
   * deck has no such buffer — its clouds live in the sky dome's shader — so the march
   * re-derives occlusion by sampling the cloud map ONCE along each tap's view ray. That
   * is an approximation of the full slab march, and it is the right one: a shaft is a
   * low-frequency wash, so it only needs to know roughly where the deck is solid.
   */
  rayStrength: 1.1,
  /** Per-tap decay along the march — lower = shorter, punchier shafts. */
  rayDecay: 0.975,
  /** Taps per pixel (<= MAX_RAY_STEPS). Quarter-res pass, so these are cheap. */
  raySteps: 16,
  /** March length toward the sun, as a fraction of the screen. */
  rayLength: 0.75,
  /** How tightly the shaft source hugs the sun. Higher = a compact core, which is what
   *  makes the beams read as beams instead of one broad halo. */
  rayTightness: 18,

  // ── Ground shadows ───────────────────────────────────────────────────────────────
  /** Max darkening of the world under a cloud. 0 turns the whole pass off — and with it
   *  the custom-cloud render path, so the frame goes back to its plain route. */
  shadowStrength: 0.5,
  /** Edge softness of the shadow threshold, in shaped-density units. */
  shadowSoftness: 0.35,
  /** Metres beyond which shadows fade out, so far terrain does not sparkle. */
  shadowFar: 5000,

  // ── Wind ─────────────────────────────────────────────────────────────────────────
  windDeg: 35,
  /** Metres per second, same units as the volumetric deck so tiers drift alike. */
  windSpeed: 6.0,
  /**
   * How fast cloud SHAPE changes, independent of how fast it drifts.
   *
   * Wind alone slides a rigid pattern across the sky, and a rigid sky is a dead one —
   * the eye reads translation-without-change as a moving texture. Drifting the erosion
   * lookups through a third dimension instead makes the billows churn and dissolve in
   * place, which is what convection actually does. Cheap: it is an offset, not a fetch.
   */
  evolve: 0.02,
};

/**
 * Bake the tileable cloud map. ~120 ms at 256², lazily and only in this tier.
 *
 *   R  coverage   Perlin-Worley mass field — what the coverage threshold cuts
 *   G  cloud top  per-cell height fraction, CORRELATED with coverage
 *   B  billow     Worley FBM — erodes mass edges into cauliflower
 *   A  weather    very low frequency — makes whole regions cloudier or clearer
 *
 * Every channel is percentile-stretched, for the same load-bearing reason the volumetric
 * bake is: raw fbm occupies a narrow mid band, and a threshold against a 0.2-wide range
 * either accepts everything or rejects everything, so the coverage dial does nothing.
 */
export function bakePaintedCloudMap(seed = 4177, size = PAINTED_MAP_SIZE) {
  const rng = seededRandom(seed >>> 0);
  const perlin = makePeriodicPerlin(rng);
  // Worley cell grids. Low frequencies build the masses, high ones erode them.
  const w3 = makeWorley(3, rng), w6 = makeWorley(6, rng);
  const w12 = makeWorley(12, rng), w24 = makeWorley(24, rng);

  const out = new Uint8Array(size * size * 4);
  let i = 0;
  for (let y = 0; y < size; y++) {
    // Divide by size (not size-1) so texel 0 !== texel N-1 and the wrap is seamless.
    const ny = y / size;
    for (let x = 0; x < size; x++) {
      const nx = x / size;

      // PERLIN-WORLEY. Plain Perlin gives smooth amoeba blobs — the "torn paper islands"
      // v1's silhouettes were made of. Inflating it from below by inverted Worley
      // connects it into rounded, lumpy masses, which is what a cumulus outline is.
      const pf = perlinFbm(perlin, nx, ny, 0.13, 3, 5);
      const wf = w3(nx, ny, 0.21) * 0.625 + w6(nx, ny, 0.21) * 0.25 + w12(nx, ny, 0.21) * 0.125;
      const pw = wf + pf * (1 - wf);

      // CLOUD TOP, correlated with coverage — the volumetric deck's lesson: independent
      // top noise puts tall cells on thin mass edges and extrudes narrow chimneys, while
      // real cumulus tower where the mass is fattest.
      const tn = perlinFbm(perlin, nx, ny, 0.41, 2, 3);
      const top = tn * 0.4 + pw * 0.6;

      const billow = w6(nx, ny, 0.66) * 0.5 + w12(nx, ny, 0.66) * 0.35 + w24(nx, ny, 0.66) * 0.15;
      // WEATHER: one wrap across the whole sky, so some regions are busy and others open.
      // Without it every part of the sky is equally cloudy and the deck reads as a texture.
      const weather = perlinFbm(perlin, nx, ny, 0.77, 1, 3);

      out[i++] = pw * 255;
      out[i++] = top * 255;
      out[i++] = billow * 255;
      out[i++] = weather * 255;
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
export function createPaintedClouds({ seed = 4177, params = {}, camera = null } = {}) {
  /*
   * THE CALLER'S OBJECT IS KEPT, not copied — filled in with any defaults it is
   * missing. Identity matters because the deck is destroyed and rebuilt whenever the
   * quality tier changes, and a dev-panel slider bound to a copy would go dead the
   * first time you switched tiers and back (the same trap the road material's captured
   * uniform bag fell into). Hand in an object and it stays the live one.
   */
  const P = params;
  for (const k of Object.keys(PAINTED_CLOUD_DEFAULTS)) {
    if (P[k] === undefined) P[k] = PAINTED_CLOUD_DEFAULTS[k];
  }

  const map = new THREE.DataTexture(
    bakePaintedCloudMap(seed), PAINTED_MAP_SIZE, PAINTED_MAP_SIZE, THREE.RGBAFormat,
  );
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.magFilter = THREE.LinearFilter;
  // MIPMAPS ARE THE HORIZON ANTI-ALIASING. The slab crossing runs to tens of kilometres
  // at grazing angles, so texel density there goes to infinity; without mips that band
  // is a shimmering moiré that no amount of fading hides.
  map.minFilter = THREE.LinearMipmapLinearFilter;
  map.generateMipmaps = true;
  map.needsUpdate = true;
  const mapTex = texture(map);

  const uAltitude = uniform(P.altitude);
  const uThickness = uniform(P.thickness);
  const uTile = uniform(P.tile);
  const uCoverage = uniform(P.coverage);
  const uWeatherScale = uniform(P.weatherScale);
  const uErode = uniform(P.erode);
  const uLump = uniform(P.lumpiness);
  const uDensityMul = uniform(P.densityMul);
  const uTopMin = uniform(P.topMin);
  const uSteps = uniform(P.steps);
  const uAbsorb = uniform(P.absorb);
  const uShadowReach = uniform(P.shadowReach);
  const uBaseDark = uniform(P.baseDark);
  const uSunStrength = uniform(P.sunStrength);
  const uAmbient = uniform(P.ambient);
  const uSilver = uniform(P.silver);
  const uAerial = uniform(P.aerial);
  const uHorizonFade = uniform(P.horizonFade);
  /** 1 / (2R) in metres — the only form the curvature maths actually needs. */
  const uInv2R = uniform(0.5 / (P.planetRadiusKm * 1000));
  const uCirrusAmount = uniform(P.cirrusAmount);
  const uCirrusAlt = uniform(P.cirrusAltitude);
  const uCirrusTile = uniform(P.cirrusTile);
  const uCirrusCoverage = uniform(P.cirrusCoverage);
  const uCirrusStretch = uniform(P.cirrusStretch);
  const uCirrusWarp = uniform(P.cirrusWarp);
  const uCirrusSilver = uniform(P.cirrusSilver);
  const uCirrusDrift = uniform(P.cirrusDrift);
  const uCirrusSwirl = uniform(P.cirrusSwirl);
  const uMsFloor = uniform(P.msFloor);
  /** Seconds x evolve — the offset that churns the erosion lookups. */
  const uEvolve = uniform(0);
  /** Unit wind vector — cirrus aligns with the shear, not with world X. */
  const uWindDir = uniform(new THREE.Vector2(1, 0));
  const uWind = uniform(new THREE.Vector2());
  /** Camera XZ in map units, so the deck is anchored to the WORLD and drifts past you
   *  as you drive instead of being glued to the camera. */
  const uCamXZ = uniform(new THREE.Vector2());

  /**
   * remap(v, lo..1 → 0..1) with a GUARDED denominator.
   *
   * Not TSL's `remapClamp`: the coverage step is `remap(field, 1 - coverage, 1)`, so the
   * divisor IS the coverage and in clear sky it is zero. 0/0 is NaN, NaN survives the
   * clamp, and the sky goes black wherever there is no cloud. The volumetric deck lost a
   * day to exactly this.
   */
  const remapUnit = Fn(([v, lo]) => saturate(v.sub(lo).div(float(1.0).sub(lo).max(1e-4))));

  /**
   * Shade the deck for one view ray.
   *
   * @param dir      normalised view direction
   * @param bgCol    sky colour already computed BEHIND the deck (for the aerial fade)
   * @param sunDir   normalised sun direction
   * @param keyCol   light colour (sun, or moon at night — the caller decides)
   * @param ambCol   sky ambient colour reaching the shaded side
   * @param cirrusKey light colour at the CIRRUS altitude — a separate colour on purpose,
   *   see the cirrus block: 8 km up the sun is still clear of the horizon long after the
   *   deck below has gone red, which is exactly why cirrus keeps burning at dusk.
   * @returns vec4(rgb, alpha) — straight alpha, to be mix()'d over the sky
   */
  const shade = Fn(([dir, bgCol, sunDir, keyCol, ambCol, cirrusKey]) => {
    const out = vec4(0.0).toVar();

    const y = dir.y;
    // Rays at or below the horizon never reach a deck that is above the camera, and the
    // slab crossing diverges there. Fade rather than cut: the last degrees are
    // unresolvable however many mips we have.
    const hMask = smoothstep(uHorizonFade, uHorizonFade.add(0.035), y);
    const yy = max(y, float(0.0));

    /*
     * CURVED LAYERS. Distance along the ray to altitude h over a planet of radius R,
     * using the small-angle drop `alt(t) = y·t + t²/2R` (exact to millimetres here:
     * the deck's horizon is ~121 km against R = 6371 km). Solving for t gives
     *
     *     t = R·(sqrt(y² + 2h/R) − y)
     *
     * which is written below in its CONJUGATE form, `2h / (sqrt(...) + y)`. That is
     * not cosmetic: the direct form subtracts two nearly-equal numbers of order 1e6,
     * and in float32 that cancellation throws away several kilometres of the answer
     * at exactly the grazing angles this whole change exists to fix.
     *
     * Shared by both layers, so the cirrus gets its own (much further, ~340 km at
     * 8 km altitude) horizon for free.
     */
    const tAt = Fn(([h]) => h.mul(2.0).div(sqrt(yy.mul(yy).add(h.mul(uInv2R).mul(4.0))).add(yy)));

    // ── HIGH CIRRUS ───────────────────────────────────────────────────────────────
    // A flat sheet, and here that is CORRECT rather than a compromise: cirrus is
    // optically thin and always seen from far below, so it has no thickness to miss and
    // nothing to self-occlude — the two things that made a plane wrong for the cumulus
    // deck. One projection, two fetches, no march.
    const cirCol = vec3(0.0).toVar();
    const cirA = float(0.0).toVar();
    If(uCirrusAmount.greaterThan(0.001).and(y.greaterThan(0.0)), () => {
      const tC = tAt(uCirrusAlt);
      const wC = uCamXZ.add(vec2(dir.x, dir.z).mul(tC).div(uCirrusTile))
        .add(uWind.mul(uCirrusDrift));
      /*
       * ORIENT THE FILAMENTS, THEN STRETCH ALONG THAT.
       *
       * Stretching along a fixed world axis gave every filament in the sky the same
       * direction and spacing — ruled paper, not weather. The axis now starts from the
       * WIND (cirrus is ice falling through shear, so that is where it should point)
       * and is then rotated per region by a very low frequency field, so the fibres
       * arrive in bundles that fan and cross the way real cirrus does.
       *
       * The rotation is built from a noise-derived unit vector rather than sin/cos of
       * an angle: same result, no trig, and one fetch already on hand.
       */
      const rnd = mapTex.sample(wC.mul(0.11));
      const axis = normalize(
        vec2(rnd.r.sub(0.5), rnd.g.sub(0.5)).mul(uCirrusSwirl).add(uWindDir),
      );
      // Project onto the local axis and its perpendicular — a rotation into filament space.
      const along = dot(wC, axis);
      const across = dot(wC, vec2(axis.y.negate(), axis.x));
      const suv = vec2(along.div(uCirrusStretch), across);
      // Bend them, or even correctly-oriented fibres read as a printed hatch.
      const wv = mapTex.sample(suv.mul(0.31)).a.sub(0.5);
      const uvC = suv.add(vec2(wv.mul(0.12), wv.mul(uCirrusWarp)));

      const c1 = mapTex.sample(uvC.add(vec2(uEvolve.mul(0.35), 0.0)));
      const c2 = mapTex.sample(uvC.mul(2.7).add(vec2(11.3, uEvolve.mul(-0.8).add(4.1))));
      // The BILLOW channel, not the mass channel: its higher frequency is what reads as
      // fibrous. The weather channel gates whole regions so the sheet has gaps.
      const fib = c1.b.mul(0.6).add(c2.b.mul(0.4));
      // Its own low-frequency gate, for the same reason the deck has one.
      const wCir = mapTex.sample(uvC.mul(uWeatherScale.mul(0.6))).a;
      const covC = saturate(uCirrusCoverage.mul(mix(float(0.4), float(1.5), wCir)));
      const shapedC = remapUnit(fib, covC.oneMinus());

      // Ice is strongly forward-scattering, so cirrus near the sun blazes and cirrus
      // away from it stays a pale wash. That contrast is its signature.
      const muC = saturate(dot(dir, sunDir));
      const fwd = pow(muC, float(3.0)).mul(uCirrusSilver);
      const lit = cirrusKey.mul(float(0.85).add(fwd)).add(ambCol.mul(0.3));

      // Its own horizon fade and aerial: much further away, so it dissolves sooner in
      // angular terms even though it reaches further in metres.
      const maskC = smoothstep(float(0.002), float(0.03), y);
      const aerC = smoothstep(float(0.30), float(0.005), y).mul(uAerial);
      cirCol.assign(mix(lit, bgCol, aerC));
      cirA.assign(shapedC.mul(uCirrusAmount).mul(maskC));
    });

    const deckCol = vec3(0.0).toVar();
    const deckA = float(0.0).toVar();

    If(hMask.greaterThan(0.001), () => {
      const tBase = tAt(uAltitude).toVar();
      const tTop = tAt(uAltitude.add(uThickness)).toVar();
      const dt = tTop.sub(tBase).div(uSteps.max(1.0)).toVar();

      // ── One horizontal shadow, at the slab mid-plane ────────────────────────────
      // Mass-to-mass shadowing. Two taps toward the sun, stretched by 1/sin(elevation)
      // because a low sun throws long shadows — CLAMPED to a quarter wrap, or at dusk
      // the taps land more than a full texture wrap away, sample effectively at random,
      // and every cloud in the sky shades identically (that bug shipped once already).
      const tMid = tAt(uAltitude.add(uThickness.mul(0.5)));
      const uvMid = uCamXZ.add(vec2(dir.x, dir.z).mul(tMid).div(uTile)).add(uWind);
      const sunXZ = normalize(vec3(sunDir.x, 1e-5, sunDir.z)).xz;
      const reach = min(uShadowReach.div(max(sunDir.y, 0.15)).div(uTile), float(0.25));
      const sTau = mapTex.sample(uvMid.add(sunXZ.mul(reach.mul(0.45)))).r.mul(0.55)
        .add(mapTex.sample(uvMid.add(sunXZ.mul(reach))).r.mul(0.45));
      const sunShadow = exp(sTau.mul(uAbsorb).negate()).toVar();

      // LARGE-SCALE WEATHER, sampled ONCE per ray at the slab mid-plane and at a low,
      // incommensurate frequency (see weatherScale). Once per ray rather than per step
      // because it is a kilometres-wide field: it barely changes across one slab
      // crossing, so 18 fetches of it would buy nothing.
      const wLow = mapTex.sample(uvMid.mul(uWeatherScale)).a.toVar();

      // Silver lining: thin cloud between you and the sun blazes. Gated on geometry —
      // applied unconditionally it just greys the deck (the volumetric powder term paid
      // for that lesson).
      const mu = saturate(dot(dir, sunDir));
      const rim = pow(mu, float(8.0)).mul(uSilver);

      // Dither the entry by up to one step, or the slab bands into shells — the same
      // failure the volumetric march has, and the same fix.
      const jit = interleavedGradientNoise(screenCoordinate.xy);
      const t = tBase.add(dt.mul(jit)).toVar();
      const transmittance = float(1.0).toVar();
      const scattered = vec3(0.0).toVar();

      Loop(MAX_STEPS, ({ i }) => {
        If(float(i).greaterThanEqual(uSteps), () => Break());
        If(transmittance.lessThan(0.01), () => Break());

        // Height above the CURVED surface, not above a plane — otherwise the far field
        // would sit at the wrong place in the slab and the vertical profile would drift
        // out from under the clouds it is shaping.
        const h = yy.mul(t).add(t.mul(t).mul(uInv2R)).sub(uAltitude).div(uThickness);
        const uv = uCamXZ.add(vec2(dir.x, dir.z).mul(t).div(uTile)).add(uWind);
        const m = mapTex.sample(uv);

        // Per-cell top: local height runs 0..1 inside THIS cell's own cloud, so a
        // neighbour can be shallow while this one towers. Without it every cell spans
        // the same band and the deck can only read as a sheet.
        const top = mix(uTopMin, float(1.0), m.g);
        const hL = h.div(top.max(0.05));
        // Rounded profile: flat-ish base, domed top.
        // A CUMULUS BASE IS SHARP AND FLAT — it is the condensation level, a
        // thermodynamic boundary, not a fade. Ramping it over 22% of the cloud's height
        // (as this did) rounds every mass into a lozenge and is a large part of why the
        // deck read as fog. The top stays domed, which is the shape convection gives it.
        const prof = smoothstep(0.0, 0.06, hL).mul(smoothstep(1.0, 0.55, hL));

        // Weather makes whole regions cloudier — this is what stops the sky reading as
        // one uniform texture repeated to the horizon.
        const covLocal = saturate(uCoverage.mul(mix(float(0.55), float(1.45), wLow)));
        /*
         * LUMPY ISO-SURFACE, and this is what stops small clouds being marshmallows.
         *
         * The threshold keeps only the top of the mass field, and an FBM peak is SMOOTH
         * by construction — every octave carries half the amplitude of the one below it,
         * so near a maximum the lowest frequency dominates and the outline is an
         * ellipse. Eroding afterwards only nibbles that ellipse; it cannot make it
         * lumpy, because by then the shape is already decided.
         *
         * Perturbing the mass BEFORE the threshold moves the iso-surface itself, so the
         * outline breaks into lobes at any coverage. It uses the billow channel of the
         * fetch already in hand — 180-700 m cells at the base frequency, which is
         * exactly cauliflower scale — so it costs no extra sample.
         */
        const massL = m.r.add(m.b.sub(0.5).mul(uLump));
        const shaped = remapUnit(massL.mul(prof), covLocal.oneMinus()).toVar();

        If(shaped.greaterThan(0.002), () => {
          // BILLOW EROSION, and the lookup SHIFTS WITH HEIGHT. Sampling it at the same
          // uv for every step would carve the identical bite at every altitude, i.e. the
          // mass would be its own outline extruded — the exact tell v1 had. Offsetting
          // by height makes the erosion twist as it rises, which is what reads as a
          // three-dimensional billow.
          // TWO OCTAVES, because one is a lumpy edge and two is cauliflower. The finer
          // one carries most of the crispness the eye reads as "cloud" rather than
          // "smoke"; both shift with height so the mass is not its own outline extruded.
          // The `uEvolve` offsets are what make the billows CHURN rather than merely
          // slide past: each octave walks a different way through the field, so the
          // shape dissolves and re-forms instead of translating rigidly.
          const dUv = uv.mul(3.1).add(vec2(h.mul(0.35).add(uEvolve), h.mul(-0.27)));
          const fUv = uv.mul(9.7).add(vec2(h.mul(-0.8), h.mul(0.6).sub(uEvolve.mul(1.7))));
          const billow = mapTex.sample(dUv).b.mul(0.62).add(mapTex.sample(fUv).b.mul(0.38));
          /*
           * EDGE-WEIGHTED EROSION — the fix for clouds reading as marshmallows.
           *
           * The bite is subtracted AFTER the coverage threshold, so it removes an
           * ABSOLUTE amount from a value that is already small wherever coverage is
           * low. At `clear` settings almost nothing clears the bar, the bite then
           * wipes most of what did, and what survives is simply wherever the billow
           * happened to be weakest — a smooth rounded lump. Cores and rims were being
           * eroded equally, so the outline never got carved at all.
           *
           * Weighting the bite by (1 - shaped) inverts that: the RIM, where the mass is
           * thinnest, is eroded hardest and comes apart into cauliflower, while the
           * core keeps enough of its density to stay solid. A third of the bite is left
           * on the core so it still gains internal texture rather than going flat.
           */
          const biteRaw = billow.mul(uErode).mul(mix(float(0.6), float(1.25), saturate(hL)));
          const bite = biteRaw.mul(mix(float(0.35), float(1.0), shaped.oneMinus()));
          const dens = remapUnit(shaped, bite).mul(uDensityMul).toVar();

          If(dens.greaterThan(1e-5), () => {
            // Vertical light gradient: tops catch the sun, bases sit in their own shadow.
            // Cheap, and with the silhouette now correct it does most of the volume read.
            const vert = mix(uBaseDark, float(1.0), saturate(hL));
            // MULTIPLE-SCATTERING FLOOR — see msFloor. Lifts the shadow term so a core
            // that the horizontal march says is fully occluded still glows, instead of
            // flattening to grey. mix(floor, 1, shadow), written as an add to keep it
            // one madd.
            const shadeLifted = sunShadow.add(uMsFloor.mul(sunShadow.oneMinus()));
            const lit = keyCol.mul(uSunStrength).mul(shadeLifted.mul(vert).add(rim.mul(vert)));
            const amb = ambCol.mul(uAmbient).mul(mix(float(0.55), float(1.0), saturate(hL)));
            const lum = lit.add(amb);

            const stepT = exp(dens.mul(dt).negate());
            scattered.addAssign(transmittance.mul(lum).mul(stepT.oneMinus()));
            transmittance.mulAssign(stepT);
          });
        });
        t.addAssign(dt);
      });

      const alpha = transmittance.oneMinus().mul(hMask).toVar();
      // Premultiplied during integration, so divide back out to straight alpha for the
      // caller's mix(). Guarded, or a fully clear pixel divides by zero.
      const col = scattered.div(alpha.max(1e-4)).toVar();

      // Aerial perspective: distant deck recedes into the sky BEHIND it, so it dissolves
      // toward the horizon instead of holding full contrast to the edge.
      const aerial = smoothstep(float(0.42), float(0.02), y).mul(uAerial);
      col.assign(mix(col, bgCol, aerial));

      deckCol.assign(col);
      deckA.assign(alpha);
    });

    // ── COMPOSITE: cirrus UNDER the deck ──────────────────────────────────────────
    // The cumulus deck is 7 km closer, so it occludes the cirrus — getting this order
    // wrong is what makes a two-layer sky look like a decal. Straight-alpha "over".
    const behind = deckA.oneMinus();
    const outA = deckA.add(cirA.mul(behind)).toVar();
    const outCol = deckCol.mul(deckA).add(cirCol.mul(cirA).mul(behind))
      .div(outA.max(1e-4));
    out.assign(vec4(outCol, outA));
    return out;
  });

  // ── GOD RAYS ──────────────────────────────────────────────────────────────────
  //
  // Screen-space radial shafts, ported from the volumetric tier (which had three
  // artifact fixes beaten out of it) with ONE thing changed: where occlusion comes
  // from. That tier reads the alpha of its resolved cloud buffer; this tier has no
  // cloud buffer at all, so each tap reconstructs its own view ray and samples the
  // cloud map once at the deck's mid-plane. One fetch instead of a buffer read, and no
  // render target is added for the clouds themselves — only the quarter-res shaft
  // buffer, which is the one allocation this whole tier makes.
  const uRayStrength = uniform(P.rayStrength);
  const uRayDecay = uniform(P.rayDecay);
  const uRaySteps = uniform(P.raySteps);
  const uRayLen = uniform(P.rayLength);
  const uRayTight = uniform(P.rayTightness);
  const uAspect = uniform(1);
  /** Sun position in the same flipped uv space the post passes sample in. */
  const uSunUV = uniform(new THREE.Vector2(0.5, 0.5));
  /** Folds together "in front of us", "near enough to the frame" and "above the
   *  horizon" — and gates the composite too, so a stale buffer can never show. */
  const uRayActive = uniform(0);

  const shaftRT = new THREE.RenderTarget(1, 1, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat,
    type: THREE.HalfFloatType,
    depthBuffer: false,
  });
  const shaftTex = texture(shaftRT.texture);
  const uShaftTexel = uniform(new THREE.Vector2(1, 1));

  const shaftColorNode = Fn(() => {
    const fuv = vec2(uv().x, uv().y.oneMinus());
    const acc = float(0.0).toVar();
    const decay = float(1.0).toVar();
    const delta = uSunUV.sub(fuv);
    const dist = length(delta).max(1e-4);
    // March at most rayLength of the screen, ending at the sun if it is closer.
    const stepUv = delta.mul(min(float(1.0), uRayLen.div(dist))).div(uRaySteps.max(1.0));

    /*
     * TWO SAMPLES PER TAP, HALF-TAP DITHER — carried over from the volumetric tier,
     * where all three of these were needed in sequence. Discrete taps slice the glow
     * into concentric rings (the march's shell banding, in polar coordinates); a
     * FULL-tap dither killed the rings but printed as a stationary weave, because this
     * buffer has no temporal accumulation to average it; sampling twice per tap halves
     * both the ring pitch and the dither amplitude, leaving a residual the composite
     * tent filter can actually erase.
     */
    const halfStep = stepUv.mul(0.5);
    const jit = interleavedGradientNoise(screenCoordinate.xy);
    const p = fuv.add(halfStep.mul(jit)).toVar();
    const skyDepth = uReversed.oneMinus();

    const shaftSrc = Fn(([q]) => {
      const out = float(0.0).toVar();
      const inb = q.x.greaterThan(0.0).and(q.x.lessThan(1.0))
        .and(q.y.greaterThan(0.0)).and(q.y.lessThan(1.0));
      If(inb, () => {
        // Only sky carries a shaft: geometry in the way blocks it, and the sky dome
        // writes no depth, so this test is exactly "nothing solid here".
        const isSky = abs(depthTex.sample(q).r.sub(skyDepth)).lessThan(0.0001);
        If(isSky, () => {
          const off = q.sub(uSunUV).mul(vec2(uAspect, 1.0));
          const glow = exp(dot(off, off).mul(uRayTight.negate()));
          If(glow.greaterThan(0.002), () => {
            // Rebuild this tap's view ray and ask the cloud map, once, whether the deck
            // is solid along it. Same curved distance as the main march (see `tAt`),
            // inlined because that one closes over the shade pass's own `yy`.
            const ndc = vec4(q.x.mul(2.0).sub(1.0), q.y.mul(2.0).sub(1.0), 0.5, 1.0);
            const wpH = uInvViewProj.mul(ndc);
            const dir = normalize(wpH.xyz.div(wpH.w).sub(uCamPos));
            const yy = max(dir.y, float(1e-3));
            const hMid = uAltitude.add(uThickness.mul(0.5));
            const t = hMid.mul(2.0)
              .div(sqrt(yy.mul(yy).add(hMid.mul(uInv2R).mul(4.0))).add(yy));
            const cuv = uCamXZ.add(vec2(dir.x, dir.z).mul(t).div(uTile)).add(uWind);
            const m = mapTex.sample(cuv);
            const wLow = mapTex.sample(cuv.mul(uWeatherScale)).a;
            const covLocal = saturate(uCoverage.mul(mix(float(0.55), float(1.45), wLow)));
            // EROSION IS IN THE MASK ON PURPOSE. With only the low-frequency mass field
            // the occluder is far smoother than the cloud actually drawn, and smooth
            // occluders make a smooth glow - the shafts came out as one wash instead of
            // beams. Carving the same billow the deck is carved with is what gives the
            // gaps hard enough edges to throw a ray.
            const bite = mapTex.sample(cuv.mul(3.1)).b.mul(uErode);
            const shaped = remapUnit(m.r, covLocal.oneMinus());
            const trans = remapUnit(shaped, bite).oneMinus();
            out.assign(glow.mul(trans));
          });
        });
      });
      return out;
    });

    Loop(MAX_RAY_STEPS, ({ i }) => {
      If(float(i).greaterThanEqual(uRaySteps), () => Break());
      p.addAssign(halfStep);
      const s0 = shaftSrc(p);
      p.addAssign(halfStep);
      const s1 = shaftSrc(p);
      acc.addAssign(s0.add(s1).mul(0.5).mul(decay));
      decay.mulAssign(uRayDecay);
    });

    const amount = acc.div(uRaySteps.max(1.0)).mul(uRayStrength).mul(uRayActive);
    return vec4(uShaftKey.mul(amount), 1.0);
  });

  const shaftMat = new THREE.MeshBasicNodeMaterial();
  shaftMat.colorNode = shaftColorNode();
  shaftMat.depthTest = false;
  shaftMat.depthWrite = false;
  shaftMat.fog = false;
  shaftMat.toneMapped = false;
  shaftMat.transparent = false;
  shaftMat.blending = THREE.NoBlending;

  /**
   * Composite fetch: a 4-tap diagonal tent over the quarter-res buffer. Shafts are
   * inherently low-frequency, so the blur costs nothing in detail and is what erases
   * the residual half-tap dither (see the march).
   */
  const sampleShafts = Fn(([fuv]) => {
    const o = uShaftTexel;
    return shaftTex.sample(fuv.add(vec2(o.x, o.y)))
      .add(shaftTex.sample(fuv.add(vec2(o.x.negate(), o.y))))
      .add(shaftTex.sample(fuv.add(vec2(o.x, o.y.negate()))))
      .add(shaftTex.sample(fuv.add(vec2(o.x.negate(), o.y.negate()))))
      .mul(0.25).rgb;
  });

  const shaftAddColor = Fn(() =>
    vec4(sampleShafts(vec2(uv().x, uv().y.oneMinus())).mul(uRayActive), 1.0));

  const shaftAddMat = new THREE.MeshBasicNodeMaterial();
  shaftAddMat.colorNode = shaftAddColor();
  shaftAddMat.depthTest = false;
  shaftAddMat.depthWrite = false;
  shaftAddMat.fog = false;
  shaftAddMat.toneMapped = false;
  shaftAddMat.transparent = true;
  // Scattered light ADDS; it never occludes what is behind it.
  shaftAddMat.blending = THREE.AdditiveBlending;

  const shaftScene = new THREE.Scene();
  const shaftCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const shaftQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), shaftMat);
  shaftScene.add(shaftQuad);

  const _sunClip = new THREE.Vector4();
  /**
   * Sun screen position + activation, from the CURRENT frame's view-projection. The sun
   * is a direction, so it projects as a point at infinity (w = 0 in).
   */
  function updateSunScreen(vp, sunDir) {
    _sunClip.set(sunDir.x, sunDir.y, sunDir.z, 0).applyMatrix4(vp);
    if (!(P.rayStrength > 0.001) || _sunClip.w <= 1e-4) {
      uRayActive.value = 0;
      return;
    }
    const nx = _sunClip.x / _sunClip.w;
    const ny = _sunClip.y / _sunClip.w;
    uSunUV.value.set(nx * 0.5 + 0.5, ny * 0.5 + 0.5);
    // Shafts can stream in from just off-screen, so fade rather than cut; and die as the
    // sun sinks, because below the horizon the source is the sky's own glow, not a disc.
    const edge = Math.max(Math.abs(nx), Math.abs(ny));
    const offFade = 1 - THREE.MathUtils.smoothstep(edge, 1.1, 2.2);
    const upFade = THREE.MathUtils.smoothstep(sunDir.y, 0.01, 0.09);
    uRayActive.value = offFade * upFade;
  }

  // ── GROUND SHADOWS ────────────────────────────────────────────────────────────
  //
  // The deck darkening the world beneath it, which is most of what makes clouds feel
  // PRESENT while driving rather than painted on a backdrop.
  //
  // The volumetric tier gets this from its own composite pass. The painted deck has no
  // pass at all — it lives inside the sky dome's fragment shader — so it borrows the
  // engine's custom-cloud hook instead: `worldEnvironment` hands any registered cloud
  // system the scene depth and lets it draw once after the solids pass. We use that slot
  // for a single fullscreen quad that MULTIPLIES the frame by the shadow and nothing
  // else; the clouds themselves are already in the sky.
  //
  // It is cheaper here than in the volumetric tier: the shadow caster is one 2D texture
  // fetch, not a density march.
  const uShadowStrength = uniform(P.shadowStrength);
  const uShadowSoft = uniform(P.shadowSoftness);
  const uShadowFar = uniform(P.shadowFar);
  const uSunDirG = uniform(new THREE.Vector3(0.4, 0.8, 0.3).normalize());
  /** Shaft tint — the sun's own transmitted colour, pushed from the sky. */
  const uShaftKey = uniform(new THREE.Color(0xfff2dc));
  const uInvViewProj = uniform(new THREE.Matrix4());
  const uCamPos = uniform(new THREE.Vector3());
  const uCamFwd = uniform(new THREE.Vector3(0, 0, -1));
  const uCamNear = uniform(0.5);
  const uCamFar = uniform(8192);
  /** 1 for a reversed depth buffer. Every depth compare has to agree with it. */
  const uReversed = uniform(0);

  // Placeholder until setDepthSource binds the pipeline's real depth — only ever
  // swapped by `.value`, so its size is irrelevant.
  const _depthPlaceholder = new THREE.DepthTexture(1, 1);
  const depthTex = texture(_depthPlaceholder);

  const normDepth = Fn(([d]) => mix(d, d.oneMinus(), uReversed));
  /** Depth to view-space distance. Denominator floored: at the far plane it is zero. */
  const depthDist = Fn(([d]) => {
    const z = normDepth(d);
    return uCamNear.mul(uCamFar)
      .div(uCamFar.sub(uCamNear).mul(z).sub(uCamFar).min(-1e-6))
      .negate();
  });

  const shadowColor = Fn(() => {
    // Render-target sampling is Y-flipped versus the canvas under WebGPU.
    const fuv = vec2(uv().x, uv().y.oneMinus());
    const sh = float(1.0).toVar();

    const d = depthTex.sample(fuv).r;
    const skyDepth = uReversed.oneMinus();
    // Sky pixels hold the cleared far-plane depth. Gate on real geometry, or the shadow
    // would darken the very sky that casts it — and the sky dome writes no depth, so
    // this test is exactly "is there something solid here".
    If(abs(d.sub(skyDepth)).greaterThan(0.0001), () => {
      const ndc = vec4(fuv.x.mul(2.0).sub(1.0), fuv.y.mul(2.0).sub(1.0), 0.5, 1.0);
      const wpH = uInvViewProj.mul(ndc);
      const dirW = normalize(wpH.xyz.div(wpH.w).sub(uCamPos));
      const dist = depthDist(d).div(dot(dirW, uCamFwd).max(1e-3));
      const wp = uCamPos.add(dirW.mul(dist));

      // Walk up the sun ray to the deck. SAME altitude convention as the sky march
      // (relative to the camera) or the shadows drift away from the clouds casting
      // them. Slightly below mid-slab: the denser lower half throws the shadow.
      const deckY = uCamPos.y.add(uAltitude).add(uThickness.mul(0.35));
      const tS = deckY.sub(wp.y).div(max(uSunDirG.y, 0.08));
      const sxz = vec2(wp.x, wp.z).add(vec2(uSunDirG.x, uSunDirG.z).mul(tS));
      const uvS = sxz.div(uTile).add(uWind);

      // ONE fetch. The mass silhouette is what casts a shadow; billow detail is finer
      // than a soft shadow edge would preserve anyway.
      const m = mapTex.sample(uvS);
      // Same low-frequency weather as the deck, or the shadows would be cast by a
      // differently-covered sky than the one overhead.
      const wLowS = mapTex.sample(uvS.mul(uWeatherScale)).a;
      const covLocal = saturate(uCoverage.mul(mix(float(0.55), float(1.45), wLowS)));
      const cov = smoothstep(float(0.0), uShadowSoft, remapUnit(m.r, covLocal.oneMinus()));

      // Above the deck you cannot be shadowed by it — matters on a sky track.
      const below = saturate(deckY.sub(wp.y).div(uThickness.max(1.0)));
      const nearM = smoothstep(uShadowFar, uShadowFar.mul(0.55), dist);
      // Die with the sun, like the volumetric deck's shadows: no noon-strength dapples
      // stamped on the ground at dusk.
      const sunUp = smoothstep(float(0.02), float(0.16), uSunDirG.y);
      sh.assign(float(1.0).sub(cov.mul(uShadowStrength).mul(below).mul(nearM).mul(sunUp)));
    });
    return vec4(sh, sh, sh, 1.0);
  });

  const shadowMat = new THREE.MeshBasicNodeMaterial();
  shadowMat.colorNode = shadowColor();
  shadowMat.depthTest = false;
  shadowMat.depthWrite = false;
  shadowMat.fog = false;
  shadowMat.toneMapped = false;
  shadowMat.transparent = true;
  // MULTIPLY: dst = src*0 + dst*src.rgb. Alpha is left alone.
  shadowMat.blending = THREE.CustomBlending;
  shadowMat.blendSrc = THREE.ZeroFactor;
  shadowMat.blendDst = THREE.SrcColorFactor;
  shadowMat.blendSrcAlpha = THREE.ZeroFactor;
  shadowMat.blendDstAlpha = THREE.OneFactor;

  const shadowScene = new THREE.Scene();
  const shadowCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const shadowQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), shadowMat);
  shadowScene.add(shadowQuad);

  let _depthBound = false;
  const _vp = new THREE.Matrix4();
  const _fwd = new THREE.Vector3();

  const shadowsOn = () => P.shadowStrength > 0.001;
  const raysOn = () => P.rayStrength > 0.001;

  /** Bind the pipeline's scene depth. Null = the owns-the-frame path, which we sit out. */
  function setDepthSource(tex) {
    _depthBound = !!tex;
    if (tex) depthTex.value = tex;
  }

  function prepareFrame() { return (shadowsOn() || raysOn()) && _depthBound; }

  /**
   * The one fullscreen pass, run by PostFxPipeline right after the solids pass.
   * Multiplies the linear HDR buffer by the cloud shadow; adds no colour of its own.
   */
  const _bufSize = new THREE.Vector2();

  function compositeOntoLinearHDR(renderer, targetRT) {
    if (!_depthBound || !camera) return;
    const wantShadow = shadowsOn();
    const wantRays = raysOn();
    if (!wantShadow && !wantRays) return;

    // Camera state both passes need.
    uCamNear.value = camera.near;
    uCamFar.value = camera.far;
    uReversed.value = camera.reversedDepth ? 1 : 0;
    _vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    uInvViewProj.value.copy(_vp).invert();
    uCamPos.value.copy(camera.position);
    camera.getWorldDirection(_fwd);
    uCamFwd.value.copy(_fwd);

    const prevAuto = renderer.autoClear;
    renderer.autoClear = false;

    if (wantShadow) {
      uShadowStrength.value = P.shadowStrength;
      uShadowSoft.value = P.shadowSoftness;
      uShadowFar.value = P.shadowFar;
      renderer.setRenderTarget(targetRT);
      renderer.render(shadowScene, shadowCam);
    }

    if (wantRays) {
      uRayStrength.value = P.rayStrength;
      uRayDecay.value = P.rayDecay;
      uRaySteps.value = Math.min(P.raySteps, MAX_RAY_STEPS);
      uRayLen.value = P.rayLength;
      uRayTight.value = P.rayTightness;

      renderer.getDrawingBufferSize(_bufSize);
      const w = Math.max(1, Math.floor(_bufSize.x) >> 2);
      const h = Math.max(1, Math.floor(_bufSize.y) >> 2);
      if (w !== shaftRT.width || h !== shaftRT.height) {
        shaftRT.setSize(w, h);
        uShaftTexel.value.set(1 / w, 1 / h);
      }
      uAspect.value = Math.max(1e-3, _bufSize.x / Math.max(1, _bufSize.y));

      // Skipped entirely when the sun cannot cast anything into this frame; the
      // additive composite is gated on the same uniform, so a stale buffer cannot show.
      updateSunScreen(_vp, uSunDirG.value);
      if (uRayActive.value > 0) {
        shaftQuad.material = shaftMat;
        renderer.setRenderTarget(shaftRT);
        renderer.clear();
        renderer.render(shaftScene, shaftCam);

        shaftQuad.material = shaftAddMat;
        renderer.setRenderTarget(targetRT);
        renderer.render(shaftScene, shaftCam);
        shaftQuad.material = shaftMat;
      }
    }

    renderer.autoClear = prevAuto;
  }

  /**
   * The no-post-FX path. Returning false hands the frame back to the normal renderer:
   * without the pipeline there is no scene depth to read and no HDR target to multiply,
   * so the painted deck simply goes without ground shadows there rather than
   * manufacturing a depth buffer of its own — which is the expense this tier exists to
   * avoid. The clouds themselves are unaffected; they live in the sky shader.
   */
  function renderFrame() { return false; }

  const _windAccum = new THREE.Vector2();

  /**
   * @param {number} dt seconds
   * @param {THREE.Vector3} [camPos] world camera position — anchors the deck
   */
  let _evolveAccum = 0;

  function update(dt, camPos, sunDir, keyCol) {
    _evolveAccum += (dt || 0) * P.evolve;
    uEvolve.value = _evolveAccum;
    uMsFloor.value = P.msFloor;
    const rad = THREE.MathUtils.degToRad(P.windDeg);
    // Metres, converted to map units on read, so the wind dial means the same thing here
    // as it does on the volumetric deck.
    _windAccum.x += Math.cos(rad) * P.windSpeed * dt;
    _windAccum.y += Math.sin(rad) * P.windSpeed * dt;
    uWind.value.set(_windAccum.x / P.tile, _windAccum.y / P.tile);
    if (camPos) uCamXZ.value.set(camPos.x / P.tile, camPos.z / P.tile);
    if (sunDir) uSunDirG.value.copy(sunDir).normalize();
    if (keyCol) uShaftKey.value.copy(keyCol);

    uAltitude.value = P.altitude;
    uThickness.value = P.thickness;
    uTile.value = P.tile;
    uCoverage.value = P.coverage;
    uWeatherScale.value = P.weatherScale;
    uErode.value = P.erode;
    uLump.value = P.lumpiness;
    uDensityMul.value = P.densityMul;
    uTopMin.value = P.topMin;
    uSteps.value = Math.min(P.steps, MAX_STEPS);
    uAbsorb.value = P.absorb;
    uShadowReach.value = P.shadowReach;
    uBaseDark.value = P.baseDark;
    uSunStrength.value = P.sunStrength;
    uAmbient.value = P.ambient;
    uSilver.value = P.silver;
    uAerial.value = P.aerial;
    uHorizonFade.value = P.horizonFade;
    uInv2R.value = 0.5 / Math.max(1e3, P.planetRadiusKm * 1000);
    uCirrusAmount.value = P.cirrusAmount;
    uCirrusAlt.value = P.cirrusAltitude;
    uCirrusTile.value = P.cirrusTile;
    uCirrusCoverage.value = P.cirrusCoverage;
    uCirrusStretch.value = P.cirrusStretch;
    uCirrusWarp.value = P.cirrusWarp;
    uCirrusSilver.value = P.cirrusSilver;
    uCirrusDrift.value = P.cirrusDrift;
    uCirrusSwirl.value = P.cirrusSwirl;
    uWindDir.value.set(Math.cos(rad), Math.sin(rad));
  }

  return {
    params: P,
    map,
    shade,
    update,
    // Custom-cloud contract (see worldEnvironment.setCustomCloudSystem). Registered only
    // while the painted tier is live, and only to cast ground shadows — the deck itself
    // is drawn by the sky dome, not here.
    get enabled() { return shadowsOn() || raysOn(); },
    setDepthSource,
    prepareFrame,
    compositeOntoLinearHDR,
    renderFrame,
    dispose() {
      map.dispose();
      shadowMat.dispose();
      shadowQuad.geometry.dispose();
      shaftMat.dispose();
      shaftAddMat.dispose();
      shaftQuad.geometry.dispose();
      shaftRT.dispose();
      _depthPlaceholder.dispose?.();
    },
  };
}
