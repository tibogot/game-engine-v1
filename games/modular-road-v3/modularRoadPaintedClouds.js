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
  float, vec2, vec3, vec4, Fn, If, Loop, Break, uniform, texture, texture3D, uv,
  normalize, dot, length, max, min, mix, smoothstep, pow, exp, abs, sqrt, saturate, log2, fract, select,
  screenCoordinate, interleavedGradientNoise, screenSize, cameraProjectionMatrix,
} from "three/tsl";
import {
  seededRandom, makePeriodicPerlin, perlinFbm, makeWorley, normalizeChannel,
} from "./modularRoadCloudNoise.js";

/** Bake resolution. 256² over a few km is ~15 m per texel — finer than the billow
 *  octave the shader erodes with, and 256 KB of VRAM. */
export const PAINTED_MAP_SIZE = 256;
/** Compile-time ceiling on the march; `steps` cuts the loop short at runtime. */
const MAX_STEPS = 32;
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
  /**
   * Frequency of the regional SIZE field, as a multiple of weatherScale. 7 puts it near
   * 4.5 km — several times a cloud, but many times smaller than the 31 km weather field,
   * so a single view contains two or three regions of differing cloud size.
   */
  sizeScale: 7.0,
  /**
   * How strongly that field pushes coverage (and cell height) around. 0 restores the one
   * uniform cloud size the deck used to have. Self-disabling at clear and at overcast —
   * see `regional`.
   */
  sizeVary: 0.35,
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
  /**
   * How tall a column is at the cloud's OUTLINE, as a fraction of its height at the
   * core. This is what domes the deck instead of extruding it: at 1.0 every cloud is a
   * flat-topped box (the old behaviour, and the marshmallow), and low values taper the
   * rim to a wisp so the profile reads as cauliflower.
   */
  edgeTaper: 0.12,
  /**
   * How much individual cells sit above or below the shared condensation level, as a
   * fraction of deck thickness. 0 gives the ruled, perfectly flat base every cloud in
   * the sky used to share. Keep it SMALL — a cumulus field really does line up along one
   * height, and losing that reads as fog rather than as cumulus.
   */
  baseVary: 0.14,
  /**
   * Strength of the SHORT-range sun occlusion sampled per march step, as a multiplier on
   * absorb. This is what darkens a lobe's own shaded flank and lets neighbouring lobes
   * shadow each other; the per-ray mid-plane taps keep the long range. 0 removes its
   * effect (the tap itself is one fetch per step and stays; it measured as free).
   * 0.7 read as a grey deck — the whole body dimmed, not just the flanks — so it sits
   * lower and the flank term carries the modelling instead.
   */
  selfShadow: 0.6,
  /** Metres the per-step occlusion tap reaches toward the sun. About a lobe: shorter
   *  and it only darkens the pixel's own surface, longer and it becomes the long-range
   *  shadow the mid-plane taps already provide. */
  selfReach: 160,
  /**
   * How much the column top's NORMAL drives the key light, 0..1. At 0 the deck is lit by
   * height alone (tops bright, bases dark, every flank the same); at 1 a flank turned
   * away from the sun goes fully to the wrapped-lambert floor. This is what turns a
   * flat white mass into lobes with a lit side and a shaded side.
   */
  flank: 0.75,
  /**
   * Gain on the eroded density before extinction. 1 is the raw remap, which rises
   * linearly from the bite and so leaves a wide translucent fringe on every edge — the
   * "soft airbrushed" look. Above 1 the fringe collapses toward the silhouette and the
   * cauliflower reads crisp; too high and edges alias against the step length.
   */
  edgeHard: 2.4,
  /**
   * Offset on the analytic mip level the march samples at. 0 is the exact footprint;
   * positive is softer (and cheaper to fetch), negative sharper and more speckled.
   */
  lodBias: 0.0,
  /**
   * DIAGNOSTIC. 1 splits the screen into thirds showing, where the deck was hit: the
   * hit distance (repeating grey ramp), the alpha, and the mid-plane shadow term. For
   * telling which term carries an artifact; 0 in normal use.
   */
  debugView: 0,
  /**
   * Fraction of one search step treated as the smallest resolvable feature, driving a
   * second mip floor on the height field. The search must not sample the surface finer
   * than it steps: at a grazing angle a step covers hundreds of metres horizontally,
   * and a cloud smaller than that is HIT by some rows of rays and JUMPED by the next —
   * row-aligned terraces on the far deck. Filtering the height field to the step's own
   * footprint makes hit-or-miss vary smoothly with the ray instead. (Interpolating the
   * crossing fixes WHERE a hit is, not WHETHER one is found — that distinction cost a
   * detour.) The normal is taken at the screen footprint's mip regardless, so this
   * does not facet the shading.
   */
  stepLod: 0.5,
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
  /*
   * AN IRRADIANCE, since the 2026-09-05 light model: the phases carry their 1/4π and the
   * ambient is the sky's own radiance, so the sun has to sit at the physical ratio above
   * the sky (~880 W/m² of direct sun against ~40 W/m²/sr of sky, i.e. ~20x). The old 2.5
   * belonged to a formula with no phase function. See the LIGHT MODEL note in the march.
   */
  sunStrength: 15,
  /** Powder: thin front-lit cloud is darker than Beer says (no room to scatter forward
   *  yet). Gated on sun-behind-viewer geometry, like the volumetric deck. */
  powder: 0.4,
  /** Ground albedo lighting the undersides, as a fraction of the sun irradiance / π. */
  groundBounce: 0.12,
  /** Dual-lobe Henyey-Greenstein eccentricities (forward, back); each scatter octave
   *  halves them. `silver` scales the forward lobe. */
  phaseFwd: 0.8,
  phaseBack: 0.2,
  /** Metres one wrap of the 3D erosion volume covers (32 voxels → ~10 m). This is the
   *  fine cauliflower octave; it replaces a height-shifted 2D lookup near the camera. */
  erosionScale: 320,
  /**
   * Multiple-scattering floor: the fraction of key light that survives where the
   * horizontal shadow has killed the direct term.
   *
   * Droplet albedo is ~0.99, so light inside a cloud is not absorbed, it is DIFFUSED —
   * radiance tends to a diffusion solution rather than to zero. Without a floor the
   * shadowed cores go a dull flat grey, which is the single most common way rendered
   * clouds look like smoke. The volumetric deck has the same term for the same reason.
   */
  msFloor: 0.25,
  /** Sky ambient reaching the shaded side. 0 = black undersides. Sits well below 1 on
   *  purpose: the ambient is now the sky's own radiance, and at 0.55 the fill outweighed
   *  the key and the deck went flat blue-grey (measured 2026-09-05; 0.35 holds form). */
  ambient: 0.35,
  /** Silver lining on thin cloud when looking toward the sun. */
  silver: 1.1,
  /** How strongly distance dissolves the deck into the sky behind it. */
  /**
   * Ceiling on how far distance can dissolve a cloud into the sky behind it. Reached
   * asymptotically; `aerialDensity` sets how fast.
   */
  aerial: 0.55,
  /**
   * Extinction per metre for that dissolve — the air between you and the cloud.
   *
   * This USED TO BE A PROXY: the fade was `smoothstep(0.42, 0.02, dir.y)`, i.e. driven by
   * how low in the sky a ray pointed rather than by how far it actually travelled. That is
   * right on average and wrong in every specific case. A cloud overhead got NO fade even at
   * five kilometres, a cloud just above the horizon got the full fade even when it was
   * close, and moving the deck's altitude or tile size changed the real distances without
   * changing the fade at all. Distance is already known at every one of these sites — the
   * slab crossing for the thin layers, the hit for the deck — so the honest form is just
   * Beer extinction over it, and it costs one exp.
   *
   * 8e-5 puts a cloud 3 km out at ~20% dissolved and one near the 121 km horizon at ~100%.
   */
  aerialDensity: 0.00008,
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
  /**
   * MID-LEVEL ALTOCUMULUS — the layer between the cumulus deck and the cirrus.
   * 0 removes it (and its three fetches) entirely.
   */
  altoAmount: 0.38,
  /** Metres. Real altocumulus sits 2-6 km; this wants to be clearly above the deck and
   *  clearly below the cirrus, because the SEPARATION is the whole point. */
  altoAltitude: 3800,
  /** Metres per map wrap. Smaller than the deck's tile: these cloudlets are small. */
  altoTile: 2600,
  altoCoverage: 0.5,
  /** Wind multiplier. Higher air moves faster, and the differing rates between layers
   *  are what give a moving camera its parallax. */
  altoDrift: 0.55,
  /** How far the cells stretch along the wind into rolls. 1 = round cells. */
  altoRoll: 2.4,
  /** Forward scattering — droplets, so much gentler than the cirrus's ice. */
  altoSilver: 0.5,
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
  /** Max darkening of the world under a cloud. OFF by default: the stamped shadow
   *  reads as patchy on a road surface rather than as weather, and the deck looks
   *  better without it.
   *
   *  0 also drops this half of the fullscreen pass — though not the pass itself,
   *  which god rays keep alive on their own (see `shadowsOn() || raysOn()`), so
   *  turning shadows off does not quietly take the rays with them.
   *
   *  Note the weather presets each set this: switching weather turns ground
   *  shadows back on at that preset's strength. They are sparse overrides, so
   *  dropping the key from WEATHER_PRESETS is what would make this stick. */
  shadowStrength: 0,
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

/** 32³ inverted-Worley FBM (cells 3/6/12) — the deck's fine 3D erosion octave. */
const EROSION_SIZE = 32;
function bakeErosionVolume(seed = 0x3c5d, S = EROSION_SIZE) {
  const rng = seededRandom(seed >>> 0);
  const w3 = makeWorley(3, rng), w6 = makeWorley(6, rng), w12 = makeWorley(12, rng);
  const data = new Uint8Array(S * S * S * 4);
  let i = 0;
  for (let z = 0; z < S; z++) {
    const nz = z / S;
    for (let y = 0; y < S; y++) {
      const ny = y / S;
      for (let x = 0; x < S; x++) {
        const nx = x / S;
        const a = w3(nx, ny, nz), b = w6(nx, ny, nz), c = w12(nx, ny, nz);
        data[i++] = (a * 0.625 + b * 0.25 + c * 0.125) * 255;
        data[i++] = b * 255;
        data[i++] = c * 255;
        data[i++] = 255;
      }
    }
  }
  for (let ch = 0; ch < 3; ch++) normalizeChannel(data, 4, ch);
  const t = new THREE.Data3DTexture(data, S, S, S);
  t.format = THREE.RGBAFormat;
  t.type = THREE.UnsignedByteType;
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = t.wrapR = THREE.RepeatWrapping;
  t.needsUpdate = true;
  return t;
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
  const uSizeScale = uniform(P.sizeScale);
  const uSizeVary = uniform(P.sizeVary);
  const uErode = uniform(P.erode);
  const uLump = uniform(P.lumpiness);
  const uDensityMul = uniform(P.densityMul);
  const uTopMin = uniform(P.topMin);
  const uEdgeTaper = uniform(P.edgeTaper);
  const uBaseVary = uniform(P.baseVary);
  const uSelfShadow = uniform(P.selfShadow);
  const uSelfReach = uniform(P.selfReach);
  const uFlank = uniform(P.flank);
  const uEdgeHard = uniform(P.edgeHard);
  const uLodBias = uniform(P.lodBias);
  /** Diagnostic split view of the deck's terms; see debugView. */
  const uDebug = uniform(P.debugView ?? 0);
  const uStepLod = uniform(P.stepLod);
  const uSteps = uniform(P.steps);
  const uAbsorb = uniform(P.absorb);
  const uShadowReach = uniform(P.shadowReach);
  const uBaseDark = uniform(P.baseDark);
  const uSunStrength = uniform(P.sunStrength);
  const uAmbient = uniform(P.ambient);
  const uSilver = uniform(P.silver);
  const uPowder = uniform(P.powder);
  const uGroundBounce = uniform(P.groundBounce);
  const uPhaseFwd = uniform(P.phaseFwd);
  const uPhaseBack = uniform(P.phaseBack);
  const uErosionScale = uniform(P.erosionScale);
  /** World-space base altitude (camera y + altitude), for the published field. */
  const uBaseWorld = uniform(0);
  /** 3D Worley-FBM erosion volume — the one true-3D thing in this deck, and the reason
   *  near lobes no longer read as an outline extruded and sheared. Baked synchronously:
   *  32³ x 3 octaves is ~30 ms. */
  const erosionVolume = bakeErosionVolume(seed ^ 0x3c5d);
  const erosionTex = texture3D(erosionVolume, null, 0);

  const INV_4PI = 1.0 / (4.0 * Math.PI);
  const HG = Fn(([g, m]) => {
    const g2 = g.mul(g);
    return float(1.0).sub(g2)
      .div(pow(float(1.0).add(g2).sub(g.mul(m).mul(2.0)).max(1e-4), 1.5))
      .mul(INV_4PI);
  });
  const uAerial = uniform(P.aerial);
  const uAerialDensity = uniform(P.aerialDensity);
  const uHorizonFade = uniform(P.horizonFade);
  /** 1 / (2R) in metres — the only form the curvature maths actually needs. */
  const uInv2R = uniform(0.5 / (P.planetRadiusKm * 1000));
  const uCirrusAmount = uniform(P.cirrusAmount);
  const uAltoAmount = uniform(P.altoAmount);
  const uAltoAlt = uniform(P.altoAltitude);
  const uAltoTile = uniform(P.altoTile);
  const uAltoCoverage = uniform(P.altoCoverage);
  const uAltoDrift = uniform(P.altoDrift);
  const uAltoRoll = uniform(P.altoRoll);
  const uAltoSilver = uniform(P.altoSilver);
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

  /*
   * ── LIGHTNING, LIT FROM INSIDE THE DECK ────────────────────────────────────────
   *
   * Its own uniforms rather than a push on `ambient` / `msFloor`, and that is not
   * fastidiousness. The weather system CROSSFADES those params and snapshots them
   * when a transition starts (modularRoadWeather's `snapshot`), so a strike landing
   * mid-transition would be captured as the value the sky was fading FROM and burned
   * into the deck permanently. A separate channel cannot corrupt anything.
   *
   * `uFlashUV` is a strike position in the same space `uvMid` lives in — world XZ
   * divided by the tile — so the falloff is one subtract and a dot on a quantity the
   * march already computed, and no world-space reconstruction is needed.
   */
  const uFlash = uniform(0);
  const uFlashCol = uniform(new THREE.Color(0.82, 0.88, 1.0));
  const uFlashUV = uniform(new THREE.Vector2());
  /** 1/r² in tile units, so the falloff is `exp(-d²·k)`. */
  const uFlashFalloff = uniform(1.0);
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
  // `v` is clamped to 1 first: the lumped mass can exceed 1, and at coverage 0 (lo = 1)
  // that excess over the guarded divisor blew up to full density — stepped ghost
  // columns standing in an otherwise clear sky.
  /** Set by the sky before it builds its shader: returns {zenith, sun, anti} sky-radiance
   *  nodes, evaluated where the deck needs them. See modularRoadSky. */
  let ambientProvider = null;
  const setAmbientProvider = (fn) => { ambientProvider = fn; };

  /**
   * How much the air between here and `dist` metres has dissolved what is out there.
   * Beer extinction, capped by `aerial`. One exp, no fetches — the same curve the terrain's
   * own aerial perspective uses, so a cloud and the hill under it agree about the air.
   */
  const aerialAt = Fn(([dist]) =>
    saturate(exp(dist.mul(uAerialDensity).negate()).oneMinus().mul(uAerial)));

  const remapUnit = Fn(([v, lo]) => saturate(min(v, 1.0).sub(lo).div(float(1.0).sub(lo).max(1e-4))));

  // ── Published field (world-space, for the environment probe) ─────────────────────
  const fieldWeather = Fn(([p]) => {
    const r = regional(p.xz.div(uTile).add(uWind));
    return vec4(r.x, r.y, 0.0, 0.0);
  });
  const fieldDensityW = Fn(([p, wm]) => {
    const fuv = p.xz.div(uTile).add(uWind);
    const m = mapTex.sample(fuv);
    const hBot = m.a.sub(0.5).mul(uBaseVary);
    const h = p.y.sub(uBaseWorld).div(uThickness).sub(hBot);
    const massL = m.r.add(m.b.sub(0.5).mul(uLump));
    const planMass = remapUnit(massL, wm.x.oneMinus());
    const top = mix(uTopMin, float(1.0), m.g).mul(mix(uEdgeTaper, float(1.0), planMass)).mul(wm.y);
    const hL = h.div(top.max(0.05));
    const prof = smoothstep(0.0, 0.06, hL).mul(smoothstep(1.0, 0.55, hL));
    // Mean erosion taken out, as the volumetric deck's cheap sample does.
    return remapUnit(massL.mul(prof), wm.x.oneMinus()).mul(uDensityMul).mul(uErode.mul(0.5).oneMinus());
  });

  /*
   * REGIONAL CHARACTER — how big the clouds are HERE, not just how many.
   *
   * Every cloud in frame used to come out the same size, and the reason is structural:
   * apparent cloud size is set by WHERE the coverage threshold cuts the mass field, and
   * coverage varied only with `weatherScale` — one wrap in 31 km. Across a 10-20 km view
   * that is very nearly a constant, so the whole sky was cut at one level and produced
   * one characteristic size. Real skies mix small fair-weather puffs with large merged
   * masses, and that uniformity was the most artificial thing left.
   *
   * So the weather field gains a second, finer octave (`sizeScale` x weatherScale, about
   * 4.5 km) which pushes coverage up and down region by region: where it is high the
   * blobs merge into big masses, where it is low they break into small isolated ones.
   *
   * The deviation is scaled by `base * (1 - base)`, which VANISHES AT BOTH ENDS. That
   * matters: a clear preset must stay clear and an overcast ceiling must stay solid — a
   * plain multiply would punch holes in a storm, which is the one thing a storm must not
   * have. Same self-disabling property as `edgeTaper`.
   *
   * Returns vec2(coverage, topScale) — a REAL vector type, because an `Fn` that returns
   * an object silently collapses to a swizzle.
   */
  const regional = Fn(([ruv]) => {
    const wLow = mapTex.sample(ruv.mul(uWeatherScale)).a;
    const wMid = mapTex.sample(ruv.mul(uWeatherScale.mul(uSizeScale))).a;
    const base = saturate(uCoverage.mul(mix(float(0.55), float(1.45), wLow)));
    const dev = wMid.sub(0.5).mul(2.0).mul(uSizeVary).mul(base).mul(base.oneMinus());
    // A wider cumulus is a taller one — convection roughly preserves the aspect, which
    // is why the baked `top` channel is already correlated with mass. This carries that
    // same relationship up to the regional scale, so a patch of big clouds also towers.
    const topScale = float(1.0).add(wMid.sub(0.5).mul(uSizeVary).mul(0.9));
    return vec2(saturate(base.add(dev)), topScale);
  });

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
      const aerC = aerialAt(tC);
      cirCol.assign(mix(lit, bgCol, aerC));
      cirA.assign(shapedC.mul(uCirrusAmount).mul(maskC));
    });

    /*
     * ── MID-LEVEL ALTOCUMULUS ─────────────────────────────────────────────────────
     *
     * The sky had a cumulus deck at ~1.2 km and cirrus at 8 km and nothing between, so
     * every frame read as two planes with a void in it. Depth in a real sky comes from
     * layers at DIFFERENT heights sliding past each other at different rates, and one
     * gap that wide is most of what was still missing once the deck's own shape was
     * fixed.
     *
     * Altocumulus is the right cloud for the slot, and conveniently the cheapest kind to
     * draw: it is a thin sheet, so — exactly like the cirrus above and unlike the deck
     * below — it has no thickness to march and nothing to self-occlude. One crossing,
     * three fetches, no loop.
     *
     * What makes it read as altocumulus rather than as more cirrus:
     *  - CELLS, not fibres. It is a mackerel sky: discrete cloudlets with gaps. So this
     *    samples the BILLOW channel, which is Worley, where the cirrus samples it for
     *    high frequency and then smears it along a filament axis.
     *  - ROLLS. The cells organise into bands across the shear, so they are stretched
     *    along the wind — but only a little, where cirrus is stretched enormously.
     */
    const altCol = vec3(0.0).toVar();
    const altA = float(0.0).toVar();
    If(uAltoAmount.greaterThan(0.001).and(y.greaterThan(0.0)), () => {
      const tA = tAt(uAltoAlt);
      const wA = uCamXZ.add(vec2(dir.x, dir.z).mul(tA).div(uAltoTile))
        .add(uWind.mul(uAltoDrift));
      // Into roll space: along the wind, and across it.
      const along = dot(wA, uWindDir);
      const across = dot(wA, vec2(uWindDir.y.negate(), uWindDir.x));
      const ruv = vec2(along.div(uAltoRoll.max(0.05)), across);

      const c1 = mapTex.sample(ruv.add(vec2(uEvolve.mul(0.2), 0.0))).b;
      const c2 = mapTex.sample(ruv.mul(2.3).add(vec2(7.7, uEvolve.mul(-0.4)))).b;
      const cell = c1.mul(0.68).add(c2.mul(0.32));
      // Its own regional gate, at a finer scale than the deck's — altocumulus arrives in
      // patches with clear sky between, not as a wall to the horizon.
      const wAlt = mapTex.sample(wA.mul(uWeatherScale.mul(1.7))).a;
      const covA = saturate(uAltoCoverage.mul(mix(float(0.45), float(1.45), wAlt)));
      const shapedA = remapUnit(cell, covA.oneMinus());

      /*
       * ITS OWN KEY COLOUR, interpolated by ALTITUDE. At 3.8 km the sun clears the
       * horizon later than it does at the deck but sooner than at the cirrus, so the
       * three layers must redden in that ORDER at dusk — deck first, then this, then the
       * cirrus still burning above both. Picking either neighbour's colour collapses
       * that, and it is the most legible thing a layered sky does all day.
       */
      const keyA = mix(keyCol, cirrusKey, saturate(uAltoAlt.div(uCirrusAlt.max(1.0))));
      const muA = saturate(dot(dir, sunDir));
      const fwdA = pow(muA, float(5.0)).mul(uAltoSilver);
      // Cores brighter than edges. With no thickness to march, this gradient is the only
      // thing standing between a mackerel sky and a field of printed dots.
      const shapeLit = mix(float(0.72), float(1.0), saturate(shapedA.mul(1.6)));
      const litA = keyA.mul(float(0.9).add(fwdA)).mul(shapeLit).add(ambCol.mul(0.35));

      const maskA = smoothstep(float(0.004), float(0.045), y);
      const aerA = aerialAt(tA);
      altCol.assign(mix(litA, bgCol, aerA));
      altA.assign(shapedA.mul(uAltoAmount).mul(maskA));
    });

    const deckCol = vec3(0.0).toVar();
    const deckA = float(0.0).toVar();

    If(hMask.greaterThan(0.001), () => {
      /*
       * ══════════════════════════════════════════════════════════════════════════════
       * THE DECK IS A SURFACE, NOT A VOLUME — and why the march had to stop integrating.
       *
       * The previous deck raymarched a thin slab: 18 stochastic steps, each ray's entry
       * jittered by a dither so the steps would not quantise into shells. That is the
       * right tool for a VOLUMETRIC cloud, and the wrong one here, for a reason that no
       * amount of tuning can reach: with each step nearly opaque, the dither decides
       * WHERE a pixel's cloud starts, so neighbouring pixels integrate different answers
       * and the whole body carries a residual. Gradient noise made it diagonal hatching;
       * blue noise made it grain; with no temporal history to average across frames,
       * something always remained. The volumetric tier pays for its temporal blend to
       * make that residual go away. The painted tier deliberately has no render target
       * to blend into.
       *
       * So this tier now does what a painted cloud should have done from the start: it
       * treats each cloud as a SOLID with a flat base and a domed, eroded top — a
       * height field — and finds where the view ray ENTERS it. That is an intersection,
       * not an integral, and an intersection has a property an integral lacks: once the
       * march brackets the crossing between two samples, the crossing can be REFINED by
       * interpolation. Two secant steps put it to within a metre. No dither is needed
       * because there is no quantisation left to hide, and so there is no residual.
       *
       * The surface also hands over the thing the volume never had: a NORMAL. Lit tops
       * and shaded flanks now come from the height field's gradient, the way every
       * 2.5D AAA cloud gets its modelling, rather than from a vertical gradient guessed
       * from height alone.
       *
       * And it is cheaper. The search costs two fetches per step until the hit, instead
       * of four for every dense step; the shading is paid once, at the hit.
       * ══════════════════════════════════════════════════════════════════════════════
       */
      // Start a little BELOW the slab, so the first sample is guaranteed outside the
      // solid (the base can hang up to baseVary below the nominal altitude) and the
      // bracket the refinement needs always exists.
      const tStart = tAt(uAltitude.sub(uThickness.mul(0.12))).toVar();
      const tTop = tAt(uAltitude.add(uThickness)).toVar();
      /*
       * STEPS FOLLOW THE CROSSING LENGTH. A fixed count is fine at the zenith (a step
       * is ~50 m) and hopeless at a grazing angle, where the same count has to span a
       * slab crossing of several kilometres and a step becomes longer than the clouds
       * it is looking for. So the step LENGTH is bounded instead: the count grows with
       * the crossing up to the loop's cap, and only the low-elevation rays that need it
       * pay for it. `steps` stays the floor the zenith uses.
       */
      const crossing = tTop.sub(tStart);
      // Step no longer than a tenth of the slab (was 0.14): at grazing angles that is
      // the difference between an 85 m and a 119 m step against masses a few hundred
      // metres tall, and the search is one fetch per step, so it is cheap headroom.
      const nSteps = min(float(MAX_STEPS), max(uSteps, crossing.div(uThickness.mul(0.14)).ceil())).toVar();
      const dt = crossing.div(nSteps.max(1.0)).toVar();

      // ── One horizontal shadow, at the slab mid-plane ────────────────────────────
      // Mass-to-mass shadowing. Two taps toward the sun, stretched by 1/sin(elevation)
      // because a low sun throws long shadows — CLAMPED to a quarter wrap, or at dusk
      // the taps land more than a full texture wrap away, sample effectively at random,
      // and every cloud in the sky shades identically (that bug shipped once already).
      const tMid = tAt(uAltitude.add(uThickness.mul(0.5)));
      const uvMid = uCamXZ.add(vec2(dir.x, dir.z).mul(tMid).div(uTile)).add(uWind);
      const sunXZ = normalize(vec3(sunDir.x, 1e-5, sunDir.z)).xz;
      const reach = min(uShadowReach.div(max(sunDir.y, 0.15)).div(uTile), float(0.25));

      // LARGE-SCALE WEATHER AND REGIONAL SIZE, once per ray at the slab mid-plane: both
      // are kilometres-wide fields and barely change across one slab crossing.
      const reg = regional(uvMid).toVar();

      // Silver lining: thin cloud between you and the sun blazes. Gated on geometry.
      /*
       * PHASE FUNCTIONS, per pixel: a 50/50 dual-lobe Henyey-Greenstein (forward lobe
       * scaled by `silver`), at full, half and quarter eccentricity for the three scatter
       * octaves. The forward lobe IS the silver lining; the old pow(mu, 8) rim is gone.
       */
      const mu = dot(dir, sunDir);
      const phaseAt = (k) => HG(uPhaseFwd.mul(k), mu).mul(0.5).mul(uSilver)
        .add(HG(uPhaseBack.negate().mul(k), mu).mul(0.5));
      // toVar: these are used inside the sub-march loop, and an un-cached TSL expression is
      // re-evaluated at every use site — six HG lobes per STEP, not per pixel.
      const ph0 = phaseAt(1.0).toVar();
      const ph1 = phaseAt(0.5).toVar();
      const ph2 = phaseAt(0.25).toVar();
      // Ground radiance under the deck: albedo x sun irradiance / π, with the sun's height.
      const groundLum = keyCol.mul(uSunStrength).mul(saturate(sunDir.y)).mul(uGroundBounce).mul(INV_4PI * 4.0).toVar();

      /*
       * ANALYTIC MIP LEVEL. Mip selection normally comes from screen-space derivatives,
       * which are garbage inside a loop that breaks early: at every cloud edge one
       * pixel is still marching while its neighbour has stopped. So the level is
       * computed — pixel footprint from the projection matrix and framebuffer height,
       * per-step log2(t), and log2(k) for the erosion octave's own frequency — with a
       * second floor from the step length so the noise is never sampled finer than the
       * march can resolve along the ray.
       */
      const lodK = log2(
        float(2.0 * PAINTED_MAP_SIZE)
          .div(cameraProjectionMatrix.element(1).element(1).mul(screenSize.y).mul(uTile)),
      ).add(uLodBias);
      const lodStepK = log2(dt.mul(uStepLod).mul(float(PAINTED_MAP_SIZE)).div(uTile).max(1e-4));

      const uvAt = Fn(([tt]) => uCamXZ.add(vec2(dir.x, dir.z).mul(tt).div(uTile)).add(uWind));
      // Height in slab units above the CURVED surface, not above a plane.
      const hAt = Fn(([tt]) => yy.mul(tt).add(tt.mul(tt).mul(uInv2R)).sub(uAltitude).div(uThickness));
      const lodAt = Fn(([tt]) => max(log2(tt.max(1.0)).add(lodK), lodStepK));

      /*
       * THE CLOUD COLUMN at one map position: vec4(hBot, hTop, planMass, height).
       *
       * Everything the shape passes established still holds, it just describes a
       * surface now instead of a density:
       *  - the base is flat but not RULED: `baseVary` lets each cell sit a little off
       *    the shared condensation level (a cumulus base is a thermodynamic boundary,
       *    shared by the airmass — but not to the metre);
       *  - the mass is perturbed by the billow channel BEFORE the coverage threshold,
       *    so the outline in plan is lobed rather than an FBM ellipse (`lumpiness`);
       *  - the column is TALL WHERE IT IS THICK: height follows how deep into the cloud
       *    the column stands, full at the core and tapering to `edgeTaper` at the rim.
       *    That is what makes a dome instead of a box, and it was the marshmallow;
       *  - the top is eroded by a billow octave, hardest at the rim, which is where the
       *    cauliflower comes from. Only the coarser octave here — it is fetched every
       *    search step; the fine one is paid once, at the hit.
       */
      /*
       * THE COLUMN is only the SEARCH's shape: an UNERODED, conservative bound on where
       * cloud can be — flat base at hBot, top at the tapered cell height. It exists to
       * find the entry deterministically; it is NOT what gets shaded. One fetch.
       */
      const column = Fn(([uv, lod]) => {
        const m = mapTex.sample(uv).level(lod);
        const hBot = m.a.sub(0.5).mul(uBaseVary);
        const massL = m.r.add(m.b.sub(0.5).mul(uLump));
        const planMass = remapUnit(massL, reg.x.oneMinus());
        const present = smoothstep(0.0, 0.03, planMass);
        const top = mix(uTopMin, float(1.0), m.g)
          .mul(mix(uEdgeTaper, float(1.0), planMass)).mul(reg.y).mul(present);
        return vec4(hBot, hBot.add(top), planMass, top);
      });

      // ── The search: the first STEP whose segment can cross the column ───────────
      // Segments, not points: rays in one screen row share their sample heights, and a
      // point test misses a low distant cloud between samples for some rows and not
      // others — row-aligned terraces. Gated on the column having height, or the
      // interval test passes wherever a ray crosses the base level.
      /*
       * CONSERVATIVE SEGMENT TEST — the silhouette notches. The test used to read the
       * column ONCE, at the segment's midpoint. Seen from the side at a grazing angle,
       * a tall narrow mass is a vertical wall in this bound, and whether a segment's
       * single midpoint lands inside that wall flips from one screen row to the next:
       * the outline came out notched in horizontal steps one search step tall (the
       * debug view's alpha panel shows the sawtooth plainly; it survived every change
       * to the integrator because it is decided before the integrator runs). Testing
       * the segment against the UNION of the column at both its ends makes a hit
       * monotone in how close the ray passes — and costs nothing: the end sample is
       * carried into the next step as its start, so it is still one fetch per step.
       */
      const segOverlap = (cA, cB, t0, t1) => min(
        min(hAt(t1).sub(min(cA.x, cB.x)), max(cA.y, cB.y).sub(hAt(t0))),
        max(cA.w, cB.w).sub(0.002),
      );
      const t = tStart.toVar();
      const lo = float(-1.0).toVar();
      const hi = float(-1.0).toVar();
      const hitT = float(-1.0).toVar();
      const cA = column(uvAt(tStart), lodAt(tStart)).toVar();
      const cLo = vec4(0.0).toVar();
      Loop(MAX_STEPS, ({ i }) => {
        If(float(i).greaterThanEqual(nSteps), () => Break());
        const tB = t.add(dt);
        const cB = column(uvAt(tB), lodAt(tB)).toVar();
        If(segOverlap(cA, cB, t, tB).greaterThan(0.0), () => {
          lo.assign(t);
          hi.assign(tB);
          hitT.assign(t.add(tB).mul(0.5));
          cLo.assign(cA);
          Break();
        });
        cA.assign(cB);
        t.assign(tB);
      });

      If(hitT.greaterThan(0.0), () => {
        // Refine by halving the segment with the same test: the entry to within dt/64.
        Loop(6, () => {
          const mid = lo.add(hi).mul(0.5);
          const cM = column(uvAt(mid), lodAt(mid)).toVar();
          If(segOverlap(cLo, cM, lo, mid).greaterThan(0.0), () => {
            hi.assign(mid);
          }).Else(() => {
            lo.assign(mid);
            cLo.assign(cM);
          });
        });
        hitT.assign(lo);   // the start of the entry sub-segment: begin the march OUTSIDE

        const uvH = uvAt(hitT);
        const lodH = lodAt(hitT);

        // Cloud-on-cloud shadow, cast onto the HIT (at the mid-plane it belonged to
        // somewhere kilometres away and slid with the ray, printing stripes).
        const sA = mapTex.sample(uvH.add(sunXZ.mul(reach.mul(0.45)))).level(lodH);
        const sB = mapTex.sample(uvH.add(sunXZ.mul(reach))).level(lodH);
        // toVar, or both taps are re-fetched at every sub-step that reads sTau.
        const sTau = sA.r.add(sA.b.sub(0.5).mul(uLump)).mul(0.55)
          .add(sB.r.add(sB.b.sub(0.5).mul(uLump)).mul(0.45)).toVar();
        const sunShadow = exp(sTau.mul(uAbsorb).negate());
        const shadeLifted = sunShadow.add(uMsFloor.mul(sunShadow.oneMinus()));

        /*
         * A NORMAL from the column top, for the flank modelling the volume never had.
         * Taken at the screen footprint's mip one level softer with a two-texel stencil
         * (a bilinear height field's gradient is constant per texel — at the search mip
         * it facets), with the fine erosion octave folded in as a bump at its own scale.
         */
        const lodN = log2(hitT.max(1.0)).add(lodK).add(1.0).max(0.0);
        const cN = column(uvH, lodN);
        const eps = float(2.0 / PAINTED_MAP_SIZE).mul(pow(float(2.0), lodN));
        const cX = column(uvH.add(vec2(eps, 0.0)), lodN);
        const cZ = column(uvH.add(vec2(0.0, eps)), lodN);
        const sX = cX.y.sub(cN.y).mul(uThickness).div(eps.mul(uTile)).toVar();
        const sZ = cZ.y.sub(cN.y).mul(uThickness).div(eps.mul(uTile)).toVar();
        const hH = hAt(hitT);
        const fUv = uvH.mul(9.7).add(vec2(hH.mul(-0.8), hH.mul(0.6).sub(uEvolve.mul(1.7))));
        const lodF = lodN.add(3.278);
        const epsF = float(2.0 / PAINTED_MAP_SIZE).mul(pow(float(2.0), lodF));
        const fine = mapTex.sample(fUv).level(lodF).b;
        const fX = mapTex.sample(fUv.add(vec2(epsF, 0.0))).level(lodF).b;
        const fZ = mapTex.sample(fUv.add(vec2(0.0, epsF))).level(lodF).b;
        const bumpAmp = uErode.mul(0.09).mul(saturate(cN.z.mul(3.0)));
        const bumpK = bumpAmp.mul(uThickness).div(epsF.div(9.7).mul(uTile));
        sX.addAssign(fX.sub(fine).mul(bumpK));
        sZ.addAssign(fZ.sub(fine).mul(bumpK));
        const nTop = normalize(vec3(sX.negate(), 1.0, sZ.negate()));
        // Wrapped lambert on the column-top normal; `flank` says how much of it counts.
        const ndl = saturate(dot(nTop, sunDir).mul(0.5).add(0.5)).toVar();
        // Which horizon this flank faces: the sun side takes the warm sky, the far side
        // the cool one. This is what gives a sunset cloud a lit side AND a blue-grey side.
        const sw = saturate(dot(vec2(nTop.x, nTop.z), sunXZ).mul(2.5).add(0.5));
        // Built HERE, inside the hit branch, so only cloud pixels pay for the sky taps.
        const ambNodes = ambientProvider ? ambientProvider() : { zenith: ambCol, sun: ambCol, anti: ambCol };
        const ambZenith = vec3(ambNodes.zenith).toVar();
        const ambHoriz = mix(ambNodes.anti, ambNodes.sun, sw).toVar();

        /*
         * ══════════════════════════════════════════════════════════════════════════
         * THE MARCH FROM THE ENTRY — the volume deck's own integrand, unchanged.
         *
         * This is the synthesis the surface pass should have been from the start.
         * The grain came from the old march's RANDOM start; the fluffiness came from
         * its DENSITY — a soft field shaped by the vertical profile and eaten by two
         * erosion octaves, edge-weighted so rims come apart and cores stay solid.
         * The surface version kept the first fix and threw the second away, replacing
         * that density with a hard inside/outside test, which is why it read as
         * plaster. So: the entry is deterministic (the search above) and the density
         * is the old one. Neighbouring pixels start from continuous points and
         * integrate near-identical chords, and the clouds are clouds again.
         *
         * WHY THE CHORD CANNOT BE CAPPED IN METRES — the hollow clouds. The search
         * finds where the ray enters the UNERODED column bound, and that bound is far
         * larger than the eroded cloud inside it: at the rim the erosion octaves eat
         * most of the column, so the first hundreds of metres past the entry are clear
         * air. Eight fixed sub-steps capped at 1.6 search steps (~85 m at the zenith,
         * ~190 m at grazing angles) ran out inside that clear air, and the pixel came
         * back nearly transparent although solid cloud lay a little further along the
         * same ray. That printed as a thin bright rim around a see-through body — cores
         * you could see the sky through — and it was worst exactly where the taper and
         * the erosion are strongest. The debug view shows the mechanism plainly: alpha
         * is a small white core inside a wide black halo of "hit, integrated nothing".
         * Fewer search steps (a longer chord) or a higher density both filled the
         * clouds in, which is how the cause was pinned before anything was changed.
         *
         * So the march runs until it is DONE, not for a fixed distance: it stops when
         * the ray is opaque, when it leaves the top of the slab, or at the step budget.
         * The stride is half a search step on contact and lengthens through clear air
         * (up to three search steps), so the budget is spent cheaply where there is
         * nothing and the dense part is still integrated at twice the search
         * resolution. Neighbouring pixels still start from continuous entries and take
         * the same stride decisions, so nothing grains.
         * ══════════════════════════════════════════════════════════════════════════
         */
        const SUB = 24; // rewinds spend a step or two; opaque rays still break early
        const ds0 = dt.mul(0.5).toVar();
        const lodSubK = log2(ds0.mul(uStepLod).mul(float(PAINTED_MAP_SIZE)).div(uTile).max(1e-4));
        const transmittance = float(1.0).toVar();
        const scattered = vec3(0.0).toVar();
        // Previous sample, for the trapezoid: the march starts OUTSIDE the cloud.
        const dPrev = float(0.0).toVar();
        const lumPrev = vec3(0.0).toVar();
        const ds = ds0.toVar();
        const ts = hitT.add(ds0.mul(0.5)).toVar();
        Loop(SUB, () => {
          // Opaque, or out through the top of the slab (the tallest cell reaches ~1.2
          // once baseVary and the regional height scale are in): nothing left to add.
          /*
           * AN OPAQUE RAY IS OPAQUE — and this is why STARS SHOWED THROUGH THICK CLOUD.
           *
           * The march gives up once the ray has almost nothing left to collect, at 2%
           * transmittance. Leaving it there hands the composite an alpha of 0.98, so 2%
           * of whatever is BEHIND the deck still comes through. For a sky gradient that
           * is invisible. For a star it is not: a star is a point of several units of
           * radiance against a night sky near zero, so two percent of it is still a
           * clearly visible dot — sitting in the middle of a cloud that ought to be
           * kilometres of water. The thicker the cloud the worse it looked, because
           * thick cloud is exactly where the march quits early.
           *
           * A real cumulus at this density has an optical depth in the hundreds; its
           * true transmittance is not 0.02, it is effectively zero. So when the march
           * stops for that reason it says so, and the pixel goes fully opaque. (This is
           * also what the volumetric deck and the reference renderer both do at their
           * early-exit — the alpha is the whole point of stopping.)
           *
           * Leaving the slab through the top is a DIFFERENT reason to stop: there the
           * ray really has finished and whatever transmittance it has left is honest.
           */
          If(transmittance.lessThan(0.02), () => {
            transmittance.assign(0.0);
            Break();
          });
          If(hAt(ts).greaterThan(1.25), () => Break());
          const uv = uvAt(ts);
          // The density is integrated at the SUB-step, so its mip floor comes from ds, not
          // from the search step; and the erosion octaves are clamped off the tiny mips,
          // where a magnified 4x4 level sampled along a height-shifted offset prints as
          // horizontal striations through the body.
          const lod = max(log2(ts.max(1.0)).add(lodK), lodSubK);
          const m = mapTex.sample(uv).level(lod);
          const hBot = m.a.sub(0.5).mul(uBaseVary);
          const h = hAt(ts).sub(hBot);
          const massL = m.r.add(m.b.sub(0.5).mul(uLump));
          const planMass = remapUnit(massL, reg.x.oneMinus());
          const top = mix(uTopMin, float(1.0), m.g)
            .mul(mix(uEdgeTaper, float(1.0), planMass)).mul(reg.y);
          const hL = h.div(top.max(0.05));
          // A cumulus base is SHARP (the condensation level); the top is domed.
          const prof = smoothstep(0.0, 0.06, hL).mul(smoothstep(1.0, 0.55, hL));
          const shaped = remapUnit(massL.mul(prof), reg.x.oneMinus());

          /*
           * ══════════════════════════════════════════════════════════════════════════
           * EVERYTHING BELOW IS GATED ON THERE BEING CLOUD HERE.
           *
           * The march spends most of its steps in clear air: the stride lengthens through
           * the void the erosion carves at a rim, and a landing stride is rewound rather
           * than integrated. Those steps used to run the WHOLE body anyway — two erosion
           * fetches, the sun-occlusion fetch, three scatter octaves, the ambient — and
           * throw the answer away. On a sky filling the frame that was measured at 2.4 ms
           * of the deck's cost at native resolution.
           *
           * So: erosion only where the shaped mass is above the noise floor, and the light
           * model only on a step that is actually going to be integrated. An empty step is
           * now one texture fetch and some arithmetic.
           *
           * (`dens` and `lum` must be declared OUTSIDE the branches: a TSL value created
           * inside an `If` does not exist after it.)
           * ══════════════════════════════════════════════════════════════════════════
           */
          const dens = float(0.0).toVar();
          If(shaped.greaterThan(0.001), () => {
            // Two erosion octaves, shifting with height so the mass is not its own outline
            // extruded; churned by uEvolve. Edge-weighted: rims erode, cores survive.
            const dUv = uv.mul(3.1).add(vec2(h.mul(0.35).add(uEvolve), h.mul(-0.27)));
            const fUv2 = uv.mul(9.7).add(vec2(h.mul(-0.8), h.mul(0.6).sub(uEvolve.mul(1.7))));
            /*
             * THE FINE OCTAVE IS 3D NEAR THE CAMERA. A 2D lookup shifted with height can
             * only shear one outline through the body; a real cauliflower lobe differs
             * with height. One volume fetch at the sample's world position (x, z from the
             * map uv, y from the slab height) gives that. It fades to the 2D octave with
             * the mip level: the volume has no mips, and at a distance where a sub-step
             * spans several voxels it would only add shimmer that the 2D octave's mip chain
             * already filters away.
             */
            const p3 = vec3(uv.x.mul(uTile), h.mul(uThickness).add(uEvolve.mul(140.0)), uv.y.mul(uTile))
              .div(uErosionScale);
            const near3 = smoothstep(2.5, 0.5, lod);
            // One fetch, not two, except in the crossfade band: the 3D volume near, the 2D
            // octave far. A volume sample is eight taps, so this branch is worth having.
            const fine = float(0.0).toVar();
            If(near3.greaterThan(0.999), () => {
              fine.assign(erosionTex.sample(p3).level(0.0).r);
            }).ElseIf(near3.lessThan(0.001), () => {
              fine.assign(mapTex.sample(fUv2).level(lod.add(3.278).min(4.0)).b);
            }).Else(() => {
              fine.assign(mix(
                mapTex.sample(fUv2).level(lod.add(3.278).min(4.0)).b, erosionTex.sample(p3).level(0.0).r, near3,
              ));
            });
            const billow = mapTex.sample(dUv).level(lod.add(1.632).min(4.0)).b.mul(0.62)
              .add(fine.mul(0.38));
            const biteRaw = billow.mul(uErode).mul(mix(float(0.6), float(1.25), saturate(hL)));
            const bite = biteRaw.mul(mix(float(0.35), float(1.0), shaped.oneMinus()));
            dens.assign(saturate(remapUnit(shaped, bite).mul(uEdgeHard)).mul(uDensityMul));
          });

          /*
           * REWIND, OR THE DECK TERRACES. The stride lengthens through the clear air the
           * erosion carves at the rim; when a long stride LANDS in cloud, the boundary is
           * somewhere inside the stride just taken, and integrating the whole stride from
           * this one sample credits the pixel with up to 4 fine steps of density at once.
           * Neighbouring rays land after different numbers of skips, so that credit jumps
           * between them in discrete amounts — horizontal terraces up every tall mass at
           * low coverage (measured: erode 0, which makes the bound exact so nothing is ever
           * skipped, removed them; sharper mips did not). So a landing stride is not
           * integrated: the ray steps back to the start of that stride plus one fine
           * step and resumes at the fine rate, exactly like the volumetric deck's step-back.
           */
          const landed = dens.greaterThan(1e-6).and(ds.greaterThan(ds0.mul(1.01)));
          If(landed, () => {
            ts.assign(ts.sub(ds).add(ds0));
            ds.assign(ds0);
          }).Else(() => {
            const lum = vec3(0.0).toVar();
            If(dens.greaterThan(1e-6), () => {
              /*
               * SHORT-RANGE SUN OCCLUSION, one tap: the uneroded shaped density a lobe's
               * length toward the sun, at the height the sun ray reaches there. This is
               * what darkens a lobe's own shaded side and lets neighbouring lobes shadow
               * each other; the per-ray mid-plane taps only carry the long range, and with
               * nothing local every mass came out one flat white.
               */
              const sS = mapTex.sample(uv.add(vec2(sunDir.x, sunDir.z).mul(uSelfReach).div(uTile))).level(lod);
              const hS = hAt(ts).add(sunDir.y.mul(uSelfReach).div(uThickness)).sub(sS.a.sub(0.5).mul(uBaseVary));
              const massS = sS.r.add(sS.b.sub(0.5).mul(uLump));
              const planS = remapUnit(massS, reg.x.oneMinus());
              const topS = mix(uTopMin, float(1.0), sS.g).mul(mix(uEdgeTaper, float(1.0), planS)).mul(reg.y);
              const hLS = hS.div(topS.max(0.05));
              const profS = smoothstep(0.0, 0.06, hLS).mul(smoothstep(1.0, 0.55, hLS));
              const shapedS = remapUnit(massS.mul(profS), reg.x.oneMinus());
              /*
               * ════════════════════════════════════════════════════════════════════════
               * THE LIGHT MODEL (2026-09-05) — the same physics the volumetric tiers use,
               * fed by the two cheap occlusion estimates this deck already had.
               *
               * Before this the sun term was a vertical gradient times a normal times an
               * occlusion, with a pow(mu, 8) "silver" bolted on: no phase function, no
               * multiple scattering, one flat ambient colour. It tuned to "white" but never
               * to cumulus, because what makes a lit crown read as cloud is the RATIO — a
               * forward-scatter peak against the sun, a diffusion-lifted body, and
               * undersides lit by sky and ground alone.
               *
               *   • Optical depth toward the sun: this lobe tap (short range) plus the
               *     per-ray mid-plane taps (long range), summed.
               *   • Three Wrenninge scatter octaves at fixed weights 1 / 0.5 / 0.25 and
               *     extinction e^-τ / e^-τ/2 / e^-τ/4, each with its own phase (eccentricity
               *     halved per octave) — the dual-lobe HG above.
               *   • A diffusion floor (isotropic, sun-coloured) where the octaves have died.
               *   • Powder, gated front-lit; the vertical gradient and the flank normal keep
               *     their roles as the cheap stand-ins for the light march this deck lacks.
               *   • Ambient BY DIRECTION: zenith sky on the crown, the sun-side or anti-sun
               *     horizon on the flank (see `sw`), ground bounce under the base. This is
               *     the term that makes dusk a lit side and a blue-grey side instead of one
               *     salmon mass.
               * ════════════════════════════════════════════════════════════════════════
               */
              const tauSun = shapedS.mul(uSelfShadow).mul(3.0).add(sTau.mul(uAbsorb));
              const eS = exp(tauSun.mul(-0.25));
              const eS2 = eS.mul(eS);
              const eS4 = eS2.mul(eS2);
              const ms = eS4.mul(ph0).add(eS2.mul(0.5).mul(ph1)).add(eS.mul(0.25).mul(ph2));
              const floorTerm = uMsFloor.mul(INV_4PI).mul(eS4.oneMinus());
              const hC = saturate(hL);
              const vertG = mix(uBaseDark, float(1.0), hC);
              const flankMix = mix(float(1.0), ndl, uFlank);
              const powder = mix(
                float(1.0), exp(dens.div(uDensityMul.max(1e-4)).mul(-2.0)).oneMinus(),
                uPowder.mul(saturate(mu.negate())),
              );
              const sunTerm = ms.mul(flankMix).add(floorTerm).mul(vertG).mul(powder);
              const lit = keyCol.mul(uSunStrength).mul(sunTerm);
              const skyAmb = mix(mix(ambZenith, ambHoriz, 0.5), ambZenith, sqrt(hC));
              const amb = skyAmb.add(groundLum.mul(hC.oneMinus())).mul(uAmbient);
              lum.assign(lit.add(amb));
            });
            /*
             * TRAPEZOID, NOT ZERO-ORDER HOLD — the finer striations. Point-sampling the
             * density and holding it over the whole step turns every boundary the erosion
             * carves inside the body into a step function of WHERE it falls between two
             * samples; across a cloud that phase cycles once per step of height, and the
             * accumulated alpha prints it as fine horizontal contours. (Measured: they
             * survived zeroing the erosion's height shift, so they were never the texture.)
             * Integrating the density as LINEAR between successive samples makes the
             * integral continuous in the boundary position — the same trick as the
             * volumetric deck's dither, without the grain. Colour is density-weighted, so
             * an empty step's `lum` of zero carries no weight and is free to be skipped.
             */
            const dAvg = dPrev.add(dens).mul(0.5);
            const lumAvg = dPrev.mul(lumPrev).add(dens.mul(lum)).div(dAvg.mul(2.0).max(1e-6));
            const stepT = exp(dAvg.mul(ds).negate());
            scattered.addAssign(transmittance.mul(lumAvg).mul(stepT.oneMinus()));
            transmittance.mulAssign(stepT);
            dPrev.assign(dens);
            lumPrev.assign(lum);
            ts.addAssign(ds);
            // Empty-space skipping: lengthen the stride through clear air (capped at two
            // search steps so a rewind wastes little), snap back on density.
            ds.assign(select(dens.greaterThan(1e-6), ds0, min(ds.mul(1.6), ds0.mul(4.0))));
          });
        });


        const alpha = transmittance.oneMinus().mul(hMask).toVar();
        // Premultiplied during integration; back to straight alpha for the composite.
        const col = scattered.div(alpha.max(1e-4)).toVar();

        // Aerial perspective: distant deck recedes into the sky BEHIND it.
        const aerial = aerialAt(hitT);
        col.assign(mix(col, bgCol, aerial));

        /*
         * THE STRIKE, and it goes AFTER the haze rather than before it.
         *
         * Before felt right — a distant flash should recede like the cloud carrying
         * it — and measured, it was useless. From a chase camera you see the deck near
         * the HORIZON, where storm-density aerial is ~95%, so the mix erased the flash
         * almost entirely: at a realistic strength nothing visible happened, and it took
         * driving the term to 25 to see the sky move at all.
         *
         * It is also not what a strike does. The flash lights the AIR between you and
         * the cloud as well as the cloud itself, so the haze is not a filter over it —
         * the haze glows too. Modelling that properly belongs in the aerial pass; until
         * then, not attenuating twice is much closer than attenuating twice.
         *
         * Distance still dims it, through `uFlashFalloff`: the falloff is radial around
         * the strike, so a storm on the horizon is faint because it is FAR, which is the
         * honest reason, rather than because the haze ate it.
         *
         * Gated by the deck's alpha at composite time, so the flash exists only where
         * there is cloud to light — dense core bright, thin fringe faint. `uWind` comes
         * back off `uvMid` because the deck scrolls and the strike does not; leave it in
         * and the glow drifts across the sky with the weather.
         */
        /*
         * BEHIND A REAL `If`, not a multiply by zero.
         *
         * `uFlash` is 0 for all but a fraction of a second every half minute, and
         * an `exp` of a `dot` on every cloud pixel of every frame to multiply the
         * answer by nothing is exactly the trap this project has already written
         * down: a uniform toggle saves nothing until the work sits inside a WGSL
         * branch. Gated, a storm with the lightning switched off costs one scalar
         * compare per cloud pixel.
         */
        const flashAdd = vec3(0.0).toVar();
        If(uFlash.greaterThan(0.0001), () => {
          const fd = uvMid.sub(uWind).sub(uFlashUV);
          const fw = exp(dot(fd, fd).mul(uFlashFalloff).negate());
          flashAdd.assign(uFlashCol.mul(uFlash.mul(fw)));
        });
        col.addAssign(flashAdd);

        deckCol.assign(col);
        deckA.assign(alpha);

        If(uDebug.greaterThan(0.5), () => {
          const fx = screenCoordinate.x.div(screenSize.x);
          const dbg = vec3(fract(hitT.div(2500.0))).toVar();
          // BRACES, not an implicit return. `() => dbg.assign(x)` hands the
          // assignment back as the branch's VALUE, and TSL treats a value at
          // the end of an `If` inside an inline `Fn` as a return it cannot
          // honour: it warns, then comments the line out. Harmless for an
          // assign — the assignment is emitted as flow code before the value is
          // returned — but it is the whole of this file's share of that warning,
          // and a branch that ends in a real expression WOULD be silently lost.
          If(fx.greaterThan(0.3333), () => { dbg.assign(vec3(alpha)); });
          If(fx.greaterThan(0.6667), () => { dbg.assign(vec3(sunShadow)); });
          deckCol.assign(dbg);
          deckA.assign(hMask);
        });
      });
    });

    // ── COMPOSITE: cirrus UNDER the deck ──────────────────────────────────────────
    // The cumulus deck is 7 km closer, so it occludes the cirrus — getting this order
    // wrong is what makes a two-layer sky look like a decal. Straight-alpha "over".
    // Back to front by ALTITUDE: the cirrus is behind the mid layer, which is behind the
    // deck. Getting this order wrong would let an 8 km sheet draw over a 1 km cumulus.
    const behind = deckA.oneMinus();
    const midVis = altA.mul(behind);
    const cirVis = cirA.mul(behind).mul(altA.oneMinus());
    const outA = deckA.add(midVis).add(cirVis).toVar();
    const outCol = deckCol.mul(deckA).add(altCol.mul(midVis)).add(cirCol.mul(cirVis))
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
            // Costs a second weather fetch per tap, and it is worth it: if the mask
            // still thought a region held small clouds while the deck drew big merged
            // ones, shafts would come streaming through solid cloud.
            const covLocal = regional(cuv).x;
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
      // Same regional field as the deck, or the shadows would be cast by a
      // differently-covered sky than the one overhead — with sizes to match.
      const covLocal = regional(uvS).x;
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
    uSizeScale.value = P.sizeScale;
    uSizeVary.value = P.sizeVary;
    uErode.value = P.erode;
    uLump.value = P.lumpiness;
    uDensityMul.value = P.densityMul;
    uTopMin.value = P.topMin;
    uEdgeTaper.value = P.edgeTaper;
    uBaseVary.value = P.baseVary;
    uSelfShadow.value = P.selfShadow;
    uSelfReach.value = P.selfReach;
    uFlank.value = P.flank;
    uEdgeHard.value = P.edgeHard;
    uLodBias.value = P.lodBias;
    uDebug.value = P.debugView ?? 0;
    uStepLod.value = P.stepLod;
    uSteps.value = Math.min(P.steps, MAX_STEPS);
    uAbsorb.value = P.absorb;
    uShadowReach.value = P.shadowReach;
    uBaseDark.value = P.baseDark;
    uSunStrength.value = P.sunStrength;
    uAmbient.value = P.ambient;
    uSilver.value = P.silver;
    uPowder.value = P.powder;
    uGroundBounce.value = P.groundBounce;
    uPhaseFwd.value = P.phaseFwd;
    uPhaseBack.value = P.phaseBack;
    uErosionScale.value = P.erosionScale;
    uBaseWorld.value = (camPos?.y ?? 0) + P.altitude;
    uAerial.value = P.aerial;
    uAerialDensity.value = P.aerialDensity;
    uHorizonFade.value = P.horizonFade;
    uInv2R.value = 0.5 / Math.max(1e3, P.planetRadiusKm * 1000);
    uCirrusAmount.value = P.cirrusAmount;
    uAltoAmount.value = P.altoAmount;
    uAltoAlt.value = P.altoAltitude;
    uAltoTile.value = P.altoTile;
    uAltoCoverage.value = P.altoCoverage;
    uAltoDrift.value = P.altoDrift;
    uAltoRoll.value = P.altoRoll;
    uAltoSilver.value = P.altoSilver;
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

  /*
   * HOW MUCH SUN GETS THROUGH THE DECK — a CPU mirror of the shader's silhouette.
   *
   * The lens flare needs to know when the sun is behind a cloud, and it cannot ask the
   * GPU: the deck is drawn inside the sky dome's fragment shader and never exists as
   * geometry, so a raycast finds nothing and a depth test sees empty sky. The volumetric
   * tier answers this with densityAtCPU; the painted tier had no equivalent, which is why
   * the flare blazed straight through solid cloud.
   *
   * It only needs the SILHOUETTE, not the full march: where the sun ray crosses the deck,
   * is there cloud there? So this reproduces the mass field, the regional coverage and
   * the threshold — the three things that decide the outline — and skips the vertical
   * profile, erosion and lighting, which decide how it looks rather than whether it is
   * there. Four bilinear taps of the same baked array, once per frame.
   */
  const mapData = map.image.data;
  function sampleMap(u, v, ch) {
    // Bilinear, wrapping — matching RepeatWrapping + LinearFilter on the GPU.
    const N = PAINTED_MAP_SIZE;
    const fx = u * N - 0.5, fy = v * N - 0.5;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const tx = fx - x0, ty = fy - y0;
    const wrap = (n) => ((n % N) + N) % N;
    const x1 = wrap(x0 + 1), y1 = wrap(y0 + 1);
    const xa = wrap(x0), ya = wrap(y0);
    const at = (x, y) => mapData[(y * N + x) * 4 + ch] / 255;
    return (at(xa, ya) * (1 - tx) + at(x1, ya) * tx) * (1 - ty)
         + (at(xa, y1) * (1 - tx) + at(x1, y1) * tx) * ty;
  }

  /**
   * Fraction of the sun that reaches `camPos` through the deck: 1 clear, 0 fully hidden.
   * @param {{x:number,y:number,z:number}} camPos
   * @param {{x:number,y:number,z:number}} sunDir normalised, pointing AT the sun
   */
  function sunThrough(camPos, sunDir) {
    if (sunDir.y <= 0.005) return 1; // below the horizon: the flare's own fade owns this
    // Same curved-earth slab crossing as the march (see `tAt`), at the mid-plane.
    const yy = Math.max(sunDir.y, 1e-3);
    const hMid = P.altitude + P.thickness * 0.5;
    const inv2R = 0.5 / Math.max(1e3, P.planetRadiusKm * 1000);
    const t = (hMid * 2) / (Math.sqrt(yy * yy + hMid * inv2R * 4) + yy);

    const wx = _windAccum.x / P.tile, wy = _windAccum.y / P.tile;
    const u = camPos.x / P.tile + (sunDir.x * t) / P.tile + wx;
    const v = camPos.z / P.tile + (sunDir.z * t) / P.tile + wy;

    // Regional coverage — the same two weather octaves the shader uses, or the mask
    // would disagree with the sky about where the clouds even are.
    const wLow = sampleMap(u * P.weatherScale, v * P.weatherScale, 3);
    const wMid = sampleMap(u * P.weatherScale * P.sizeScale, v * P.weatherScale * P.sizeScale, 3);
    const base = Math.min(1, Math.max(0, P.coverage * (0.55 + 0.9 * wLow)));
    const cov = Math.min(1, Math.max(0, base + (wMid - 0.5) * 2 * P.sizeVary * base * (1 - base)));

    const mass = sampleMap(u, v, 0);
    const billow = sampleMap(u, v, 2);
    const massL = Math.min(1, mass + (billow - 0.5) * P.lumpiness);
    const lo = 1 - cov;
    const shaped = Math.min(1, Math.max(0, (massL - lo) / Math.max(1e-4, 1 - lo)));

    // shaped is 0 at the outline and 1 in the core; the sun dims fast once it is behind
    // anything at all, which is what a real occultation looks like.
    return 1 - Math.min(1, shaped * 2.2);
  }

  return {
    params: P,
    map,
    shade,
    setAmbientProvider,
    update,
    sunThrough,
    /**
     * Light the deck from inside for one strike.
     *
     * @param {number} amount   0..1 flash, straight off the lightning clock
     * @param {number} [worldX] where it struck; the deck lights up around it
     * @param {number} [worldZ]
     * @param {number} [radius] metres to 1/e of the glow
     *
     * Uniform pokes only — nothing here rebuilds or reallocates, so it is safe to
     * call every frame of a strike. See the note on `uFlash` for why the flash has
     * its own channel instead of pushing `ambient`.
     */
    setLightningFlash(amount, worldX = 0, worldZ = 0, radius = 2000) {
      uFlash.value = Math.max(0, amount);
      // Into the march's own space: world XZ over the tile size.
      uFlashUV.value.set(worldX / P.tile, worldZ / P.tile);
      const rTiles = Math.max(1e-3, radius / P.tile);
      uFlashFalloff.value = 1 / (rTiles * rTiles);
    },
    setLightningColor(c) { uFlashCol.value.copy(c); },
    /**
     * THE DENSITY FIELD AS TSL, for the sky-with-clouds environment probe (and anything
     * else that wants to ask "how much cloud is here" from its own shader). The same
     * contract the volumetric deck publishes: weather at a world point, cheap density
     * given that weather, and the slab bounds as uniforms — so the probe cannot drift
     * from the deck it lights the world with.
     */
    field: {
      sampleWeather: fieldWeather,
      sampleDensityCheapW: fieldDensityW,
      sampleDensityCheap: Fn(([p]) => fieldDensityW(p, fieldWeather(p))),
      uBase: uBaseWorld,
      uThickness,
    },
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
      erosionVolume.dispose();
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
