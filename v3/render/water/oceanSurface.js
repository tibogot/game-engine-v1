/**
 * v3/render/water/oceanSurface.js — the new ocean surface (TSL / WebGPU)
 *
 * A replacement candidate for v3/render/water/oceanShader.js. Nothing imports
 * both; the old one is untouched and still what v3/editor.html runs. Compare them
 * side by side in v3/water-lab.html before deciding anything.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT IS ACTUALLY DIFFERENT, AND WHY EACH CHANGE EARNS ITS PLACE
 *
 * 1. THE COAST IS PARAMETERISED IN METRES ALONG THE GROUND, NOT IN METRES OF
 *    WATER DEPTH.
 *    The old shader's `foamBandWidth: 2.6` is 2.6 m of DEPTH, so the visible band
 *    is however far the seabed takes to fall that much — a hundred metres on a
 *    beach, a hairline on a cliff, from one slider. Everything here reads
 *    `shorelineField.js`, which supplies signed distance to the waterline in
 *    metres, so a 6 m foam band is 6 m of sand everywhere on the map.
 *
 * 2. THE SURF TRAVELS.
 *    The old shader adds `sin(time · foamBreatheHz)` to the depth GLOBALLY, so
 *    every beach in the world surges in the same instant — the map breathes
 *    instead of the sea arriving. Here the phase carries a `sd / surfLength`
 *    term, which makes a crest a locus that moves shoreward at
 *    `surfHz · surfLength` metres per second, and an along-shore term, so a swell
 *    running in at an angle breaks progressively down the beach.
 *
 * 3. THE WATERLINE MOVES, AS GEOMETRY.
 *    Run-up and backwash are not painted on. In the run-up band the surface rides
 *    the sand (vertex stage), and the fragment stage discards where the surge has
 *    not reached, so the water's edge genuinely advances and retreats over the
 *    beach and leaves a receding wet sheen behind it. This is the single thing
 *    that reads as "sea" rather than "a blue plane meeting a brown plane", and it
 *    costs one extra heightmap tap in a strip a few metres wide.
 *
 * 4. WATER YOU CAN SEE INTO.
 *    The old ocean is opaque: `transparent:false`, and its colour is a three-stop
 *    hex ramp keyed on heightmap depth. It never shows the sand. This one takes
 *    the lake's model — thickness from the scene depth buffer, per-channel
 *    Beer-Lambert absorption, refraction through the grabbed backbuffer — which
 *    is what the lake is liked for, and adds what a lake has no reason to have:
 *    swell, whitecaps, crest subsurface scattering, surf.
 *
 * 5. THE WAVES CANNOT CUT INTO THE SEABED.
 *    `max(waveY, seabed + film)` near the shore. The old shader damps waves as
 *    depth shrinks (`shoreDampStart/End`) but nothing stops a trough from passing
 *    below the sand, which is visible as the beach flickering through the water.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * COST — WHAT IS MEASURED AND WHAT IS STILL ONLY ARGUED
 *
 * Read this before quoting any number below it.
 *
 * MEASURED, and it changed the defaults:
 *   • SSR is ~5.5 ms on its own. Looking out to open sea at 2x render scale the
 *     whole ocean measured 6.88 ms with the march on and 1.38 ms with it off,
 *     back to back at a fixed camera. Turning off refraction, the detail normal
 *     and the FFT after it moved nothing (1.18–1.31 ms). So SSR was the entire
 *     cost and everything else together is a rounding error — which is why
 *     `ssrEnabled` now defaults to FALSE, the same call lakeMaterial.js makes.
 *   • Draw calls: 4 vs 13 in the lab scene (the merged clipmap is 1 draw where
 *     the old host builds 10). That is a counter, not a timer, so it is solid.
 *
 * NOT MEASURED, and do not repeat it as though it were: the head-to-head GPU
 * cost of this shader against oceanShader.js. Repeated A/B runs on this machine
 * gave everything from "identical" to "24x apart", and the giveaway was a
 * monotonic ramp (0.52 → 3.41 ms over eight alternating samples) that tracked
 * elapsed time rather than which ocean was enabled. `nvidia-smi` confirmed the
 * GPU sitting at 1605 of 3105 MHz under SW power cap + thermal slowdown. The
 * ocean's own cost is a few tenths of a millisecond and the timestamp tick is
 * ~0.065 ms, so the drift is an order of magnitude bigger than the signal.
 * Re-run it on a cold machine before believing any ratio.
 *
 * The list below is therefore the ARGUMENT for why it should be cheaper — the
 * work each version does per fragment — not a measurement of the result.
 *
 *   old                                            new
 *   ───────────────────────────────────────────────────────────────────────────
 *   5 heightmap taps EVERY fragment, everywhere     1 shore-field tap
 *   (`shoreColorDepth4Tap`, a fixed 60 m cardinal   (which also carries the
 *   cross, on open ocean 10 km from any land)       offshore direction and the
 *                                                   seabed slope — the old one
 *                                                   had neither at any price)
 *
 *   9 × mx_noise_float per fragment for the two     0. Surface detail comes from
 *   scrolling normal layers plus a third micro      the FFT ripple cascade's own
 *   layer — unconditionally, at every distance      derivative, already fetched,
 *                                                   plus one optional normal-map
 *                                                   tap gated on distance
 *
 *   5-octave Worley FBM (45 hashes) behind a gate   a 3-octave field plus ONE
 *   whose condition is a DEPTH band, so on a        extra octave (36 hashes),
 *   shallow map it is open almost everywhere        behind a gate whose
 *                                                   condition is a metre band a
 *                                                   few m wide. Two full FBMs
 *                                                   (72) was the only place this
 *                                                   measured DEARER than the old
 *                                                   one, and the second field's
 *                                                   upper octaves were below a
 *                                                   pixel anyway
 *
 *   6 Gerstner waves in the vertex stage AND 6      none by default. The FFT is
 *   more in the fragment stage, on top of the FFT   the swell; `gerstnerBlend`
 *   that already supplies the swell                 was 0.15 of a second opinion
 *
 *   a 24-step SSR march and a backbuffer tap        both branched out past a
 *   would be new cost on every water fragment       distance, and the foam block
 *   if they were added unconditionally              behind a metre-wide gate
 *
 * The three surviving gates — Worley foam, SSR, refraction — are real WGSL
 * branches, not multiplies by zero, and they pay off because their conditions
 * (camera distance, metres from shore) are near-perfectly coherent across a warp:
 * each clipmap ring IS a distance band, so a skipped block is skipped for the
 * whole warp rather than executed for one straggler. Same reasoning, and the same
 * kind of payoff, as the terrain's splat/snow/groundProc gates.
 *
 * What is NOT branched, and why, is written at the normal-calculation below: a
 * mipmapped `textureSample` is only legal in uniform control flow, so anything
 * that reads one spends distance as a fade instead of a branch.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * COMPOSITING: OPAQUE, WITH THE BLEND DONE BY HAND.
 *
 * `transparent = false` and we mix against the grabbed backbuffer ourselves. This
 * is not a style choice. Under r184's MRT, only the `output` attachment is
 * blended, so a genuinely transparent surface ERASES the emissive attachment
 * behind it and kills selective bloom through the water — the sun's glitter path
 * would punch a hole in its own bloom. Manual compositing keeps the surface in
 * the opaque queue where the emissive buffer survives.
 *
 * `depthWrite` stays TRUE (the lake turns it off because a lake quad overhangs
 * its banks; an ocean should occlude, and the racing game's aerial-perspective
 * and headlight passes both read scene depth, so the sea has to be in it).
 * `renderOrder` is high so the backbuffer grab happens after opaque geometry —
 * opaque objects otherwise sort front-to-back and the sea could grab an empty
 * frame.
 *
 * @see shorelineField.js — the distance field every coast effect keys off
 * @see worldOceanV2.js   — clipmap, FFT wiring, host API
 */

import * as THREE from "three";
import { MeshBasicNodeMaterial } from "three";
import {
  Fn, If, Break, Discard, uniform, float, vec2, vec3, vec4,
  mix, smoothstep, step, dot, cross, sign, exp, pow, max, min, abs, saturate, clamp,
  floor, fract, sin, cos, sqrt, length, round, log2, fwidth, dFdx, dFdy, Loop, attribute,
  normalize, reflect, texture, positionLocal, positionWorld, positionView,
  modelWorldMatrix, cameraPosition, cameraNear, cameraFar,
  cameraViewMatrix, cameraProjectionMatrix, screenUV,
  viewportDepthTexture, viewportSharedTexture, perspectiveDepthToViewZ,
  pmremTexture, faceDirection, nodeObject,
} from "three/tsl";

const TWO_PI = 6.283185307179586;
const DEG2RAD = Math.PI / 180;

/*
 * Foam octaves. THE number that decides whether foam reads as foam.
 *
 * Fractal edges are the whole look: at 2 octaves the field is smooth blobs with
 * rounded boundaries however it is thresholded, and no amount of tuning gets
 * past that — the shapes simply have no detail to tear. Each octave added puts
 * structure one scale finer, and by 5 the boundary never resolves into a line,
 * which is what makes it read like a cloud rather than a decal. Rendered
 * side by side at 2/3/4/5 against a reference implementation before choosing.
 *
 * 5 x 9 = 45 hashes. It is the most expensive thing in the foam block and it is
 * the reason the block is worth having.
 */
const FOAM_OCTAVES = 5;

/** SSR march. TSL unrolls Loop counts, so these are compile-time. */
const SSR_STEPS = 20;
const SSR_REFINE = 4;

// ─────────────────────────────────────────────────────────────────────────────
// Noise. Copied rather than imported from lakeMaterial.js on purpose: this file
// is a candidate, and a candidate that reaches into the shipped lake shader can
// break it. If the ocean wins, these and the lake's copies collapse into one
// module — that is a deliberate follow-up, not an oversight.
// ─────────────────────────────────────────────────────────────────────────────

const _hash22 = /*#__PURE__*/ Fn(([p]) => {
  const px = dot(p, vec2(127.1, 311.7));
  const py = dot(p, vec2(269.5, 183.3));
  return fract(sin(vec2(px, py)).mul(43758.5453));
});

const _hash21 = /*#__PURE__*/ Fn(([p]) =>
  fract(sin(dot(p, vec2(12.9898, 78.233))).mul(43758.5453)),
);

const _vnoise2 = /*#__PURE__*/ Fn(([p]) => {
  const i = floor(p);
  const f = fract(p);
  const u = f.mul(f).mul(float(3).sub(f.mul(2)));
  const a = _hash21(i);
  const b = _hash21(i.add(vec2(1, 0)));
  const c = _hash21(i.add(vec2(0, 1)));
  const d = _hash21(i.add(vec2(1, 1)));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
});

/** 3-octave value FBM — only ever used to domain-warp the foam. The reference
 *  implementation uses 5; the top two are below a pixel at any distance the
 *  surf zone is actually seen from, and cost 8 hashes each. */
const _warpFbm = /*#__PURE__*/ Fn(([p_immutable]) => {
  const p = p_immutable.toVar();
  const v = float(0).toVar();
  const a = float(1).toVar();
  const t = float(0).toVar();
  Loop(3, () => {
    v.addAssign(a.mul(_vnoise2(p)));
    t.addAssign(a);
    p.assign(p.mul(2.3));
    a.assign(a.mul(0.4));
  });
  return v.div(max(t, float(1e-4)));
});

const _NEIGHBORS = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0], [0, 0], [1, 0],
  [-1, 1], [0, 1], [1, 1],
];

const _worleyF1 = /*#__PURE__*/ Fn(([p, jitter]) => {
  const ip = floor(p);
  const fp = fract(p);
  const md = float(10).toVar();
  for (const [nx, ny] of _NEIGHBORS) {
    const cell = vec2(float(nx), float(ny));
    const pt = mix(vec2(0.5, 0.5), _hash22(ip.add(cell)), jitter);
    md.assign(min(md, length(cell.add(pt).sub(fp))));
  }
  return md;
});

/**
 * Domain-warped Worley (F1) FBM with per-octave screen-space LOD — the foam
 * pattern.
 *
 * NOT inverted: F1 is small at cell centres and large at the boundaries, so the
 * high values form the network BETWEEN cells, and at enough octaves that network
 * is a ragged fractal web — which is what foam looks like.
 *
 * An inverted variant was tried and shipped briefly, on the theory that the
 * un-inverted form only ever yields thin ridge lines. It does, at two or three
 * octaves; the fix for that is octaves, not inversion. See FOAM_OCTAVES.
 *
 * `lod` is the (fractional) octave index at which one cell has shrunk to about
 * a pixel. Octaves past it fade out AND leave the normaliser with them, so the
 * field converges on the average of the octaves that are still resolvable
 * rather than on a constant — no brightness step as an octave goes.
 *
 * Fading a sub-pixel octave rather than thresholding it is the entire point. A
 * Voronoi cell smaller than a pixel cannot be resolved, and running an erosion
 * threshold across one is how procedural foam becomes crawling static — which
 * is exactly what the shoreline looked like from above before this existed.
 */
const _worleyFbmLod = /*#__PURE__*/ Fn(([p_immutable, jitter, lod]) => {
  const p = p_immutable.toVar();
  const v = float(0).toVar();
  const a = float(0.5).toVar();
  const t = float(0).toVar();
  const oct = float(0).toVar();
  Loop(FOAM_OCTAVES, () => {
    // 1 while the octave is resolvable, ramping to 0 across the octave that
    // crosses Nyquist. Weighting the normaliser by the same number is what
    // keeps the mean steady as octaves leave, so foam does not brighten or
    // darken as it recedes.
    const w = a.mul(saturate(lod.sub(oct)));
    v.addAssign(w.mul(_worleyF1(p, jitter)));
    t.addAssign(w);
    p.assign(p.mul(2.0));
    a.assign(a.mul(0.5));
    oct.addAssign(float(1));
  });
  return v.div(max(t, float(1e-4)));
});

/**
 * Bubble field: the signed distance to the nearest bubble, where every Voronoi
 * cell carries a bubble of its OWN random radius (`rMin`..`rMax`, in cell
 * units). Negative = inside a bubble.
 *
 * A plain F1 threshold punches the same-sized hole in every cell, evenly
 * spaced — which reads as dice or cheese, not foam. With a per-cell radius the
 * holes vary, and neighbours that grow into each other merge into irregular
 * gaps, which is what thinning foam actually does.
 */
const _bubbleSdf = /*#__PURE__*/ Fn(([p, rMin, rMax]) => {
  const ip = floor(p);
  const fp = fract(p);
  const md = float(10).toVar();
  for (const [nx, ny] of _NEIGHBORS) {
    const cell = vec2(float(nx), float(ny));
    const h = _hash22(ip.add(cell));
    const r = mix(rMin, rMax, _hash21(ip.add(cell).add(vec2(7.3, 1.9))));
    md.assign(min(md, length(cell.add(h).sub(fp)).sub(r)));
  }
  return md;
});

/** Reoriented Normal Mapping — blends two tangent normals without flattening. */
const _blendRNM = /*#__PURE__*/ Fn(([n1, n2]) =>
  vec3(
    n1.z.mul(n2.x).add(n1.x.mul(n2.z)),
    n1.z.mul(n2.y).add(n1.y.mul(n2.z)),
    n1.z.mul(n2.z).sub(n1.x.mul(n2.x).add(n1.y.mul(n2.y))),
  ).normalize(),
);

// ─────────────────────────────────────────────────────────────────────────────

/**
 * A 2x2 mid-grey equirect stand-in for the environment map.
 *
 * PMREMNode dereferences its texture while the material is being BUILT, so it
 * cannot be handed null and given a real map later — and the ocean is often
 * constructed before the sky has baked. This keeps the graph valid until a host
 * calls `setEnvMap`; `envPresent` stays 0 meanwhile, so nothing it produces is
 * ever actually mixed in.
 */
let _envPlaceholder = null;
function envPlaceholder() {
  if (!_envPlaceholder) {
    _envPlaceholder = new THREE.DataTexture(
      new Uint8Array([128, 128, 128, 255, 128, 128, 128, 255,
                      128, 128, 128, 255, 128, 128, 128, 255]),
      2, 2, THREE.RGBAFormat,
    );
    _envPlaceholder.mapping = THREE.EquirectangularReflectionMapping;
    _envPlaceholder.colorSpace = THREE.NoColorSpace;
    _envPlaceholder.needsUpdate = true;
  }
  return _envPlaceholder;
}

export const OCEAN2_DEFAULTS = {
  // ── Body colour ────────────────────────────────────────────────────────────
  // Per-channel Beer-Lambert. Red is absorbed an order of magnitude faster than
  // blue, which is the whole reason deep water is blue and a metre of it over
  // sand is turquoise; a three-stop colour ramp can imitate the endpoints but
  // never the way the transition tracks what is underneath.
  absorption: [0.42, 0.09, 0.055],
  /** Metres over which `absorption` is applied once. */
  absorptionScale: 14,
  /** Metres of water at which absorption is considered saturated. Ocean water
   *  keeps getting darker far longer than a lake's 20 m. */
  depthDistance: 45,
  /** Light scattered back out of the body — what stops deep water going black. */
  inscatterTint: "#042b33",
  inscatterStrength: 1.0,
  /** Extra scatter in the churned-up nearshore, faded over this many metres. */
  turbidityTint: "#2f7f7a",
  turbidityStrength: 0.5,
  turbidityReach: 28,

  // ── Refraction ─────────────────────────────────────────────────────────────
  refractionStrength: 0.055,
  /** Past this many metres from the camera the refraction tap is skipped: the
   *  wobble is sub-pixel out there and the water is deep enough to be opaque. */
  refractEnd: 420,

  // ── Reflection ─────────────────────────────────────────────────────────────
  skyZenithColor: "#1d4f8f",
  skyHorizonColor: "#b6cfe6",
  sunColor: "#fff2d8",
  skyReflectIntensity: 1.0,
  /** Horizon glow half-width, in degrees above the horizon. The old shader's
   *  reflection is a straight lerp between two colours, which is why it reads as
   *  plastic — a real sky is bright and desaturated in a narrow band and this is
   *  the knob that puts that band back. */
  skyHorizonSpread: 14,
  /** Sun aureole in the reflection, separate from the specular lobe. */
  skySunGlow: 0.35,
  skySunGlowSize: 9,
  fresnelScale: 1.0,

  /*
   * ── THE ENVIRONMENT ────────────────────────────────────────────────────────
   * How much of the reflection comes from the scene's real environment map
   * rather than from the analytic two-colour sky above.
   *
   * At grazing angles Fresnel goes to ~1, so the water IS its reflection — and
   * from a car, or from any camera near the surface, almost every ray is
   * grazing. Reflecting a two-stop gradient is the reason a sea reads as tinted
   * plastic no matter how good its waves and foam are; no amount of work on
   * either fixes something that is mostly a mirror pointed at nothing.
   *
   * Costs one prefiltered cube tap. The analytic sky stays as the fallback for
   * hosts with no environment (`setEnvMap(null)`), so nothing regresses.
   */
  envReflect: 1.0,
  /** Multiplier on the environment tap, matching scene.environmentIntensity. */
  envIntensity: 1.0,

  /*
   * ── ROUGHNESS, AND WHY IT IS NOT A CONSTANT ────────────────────────────────
   * Base roughness of undisturbed water. Very low — water is nearly a mirror.
   */
  waterRoughness: 0.035,
  /*
   * Weight on the normal variance a pixel cannot resolve, folded into roughness
   * (Kaplanyan/Tokuyoshi geometric specular antialiasing).
   *
   * Past a few hundred metres there are many waves inside one pixel. Averaging
   * their normals throws the variance away, so the surface reads as a mirror it
   * physically is not: distant water goes glassy and the sun glint aliases into
   * crawling sparkle. Measuring the variance from the screen-space derivative of
   * the normal and adding it to roughness puts the lost detail back where it
   * belongs — as a wider specular lobe and a blurrier environment tap. It is a
   * few ALU and it is most of what makes a horizon believable.
   */
  specAA: 0.55,
  /** Clamp on that term. Unclamped, a near-silhouette pixel can drive roughness
   *  to 1 and punch a dull grey hole in the horizon. */
  specAAMax: 0.3,

  /**
   * OFF BY DEFAULT, and this is not timidity — it is the single most expensive
   * thing in the file by a factor of forty. Measured at 2x render scale looking
   * out to open sea, the whole ocean costs 6.88 ms with the march on and 1.38 ms
   * with it off: ~5.5 ms for a reflection that, on open water at a grazing angle,
   * is almost entirely sky the analytic term already supplies. It earns its keep
   * where there is something ON SCREEN worth reflecting — a headland, a pier, a
   * boat — so it is an opt-in per scene, exactly as lakeMaterial.js decided for
   * the same reason.
   */
  ssrEnabled: false,
  ssrStrength: 1.0,
  ssrMaxDistance: 160,
  ssrThickness: 1.8,
  ssrEdgeFade: 0.15,
  /** SSR is skipped past this camera distance — a reflection that small is the
   *  sky gradient anyway. */
  ssrEnd: 260,

  /*
   * ── SHADOWS ON THE WATER ────────────────────────────────────────────────────
   * The sun's own shadow map (the terrain's cascades — the same node, so nothing
   * renders twice). Shade takes away DIRECT sunlight only: the glint, the crest
   * glow, the sun-lit side of foam, the wet-sand sheen, the sun through Snell's
   * window. Sky reflection stays, because shade does not remove the sky — which
   * is exactly what makes water in shadow read as shaded rather than painted.
   * Reaches as far as the World panel's shadow distance (CSM max far).
   */
  shadowsEnabled: true,
  /** How much the water's own colour darkens in full shade (less sun in the
   *  water column). 0 = only the direct-sun terms react. */
  shadowBodyDarken: 0.3,
  /** How much foam darkens in full shade. Foam is lit mostly by the sun. */
  shadowFoamDarken: 0.45,

  // ── Sun specular ───────────────────────────────────────────────────────────
  glintIntensity: 0.9,
  glintPower: 220,
  /** Flattens the normal for the glint only, spreading the glitter path. */
  glintSpread: 0.4,

  // ── Subsurface scattering on crests ────────────────────────────────────────
  sssEnabled: true,
  sssIntensity: 0.5,
  sssColor: "#3fd6b4",

  // ── Waves (FFT) ────────────────────────────────────────────────────────────
  fftEnabled: true,
  fftSwellAmp: 1.15,
  fftRippleAmp: 0.6,
  fftChoppiness: 1.3,
  fftNormalStrength: 1.05,
  windSpeed: 14,
  windAngleDeg: 38,
  /*
   * ── SEA STATE (horvath spectrum, physical units) ───────────────────────────
   * The spectrum is calibrated, so these are real seas, not multipliers. Its
   * built-in defaults are an open-ocean storm (100 km fetch: Hs 5.5 m at
   * 14 m/s). These are a moderate coastal sea: ~1 m of wind waves on ~0.8 m of
   * long swell, Hs ≈ 1.3 m — about what the old two-cascade sea showed, now
   * with every wavelength between 5 m and 250 m actually present.
   */
  /** Km of water the wind has blown across. Height grows with √fetch:
   *  3 km ≈ 0.8 m, 10 km ≈ 1.5 m, 40 km ≈ 3.4 m of wind sea at 14 m/s. */
  seaFetchKm: 5,
  /** Energy of the distant swell; its height grows with √this. */
  swellStrength: 0.04,
  /** The far-away wind that raised the swell: its wavelength (6 ≈ 84 m crests). */
  swellWindSpeed: 6,
  /** Swell direction relative to the local wind, degrees. */
  swellAngleOffsetDeg: 32,
  /** Water depth the spectrum assumes, metres (TMA correction). 500 = deep. */
  seaDepthM: 500,
  /** Spectrum random seed — a different sea with the same statistics. */
  fftSeed: 1337,
  /** How long whitecap foam lingers after a crest folds; lower = longer. */
  fftFoamDecay: 0.4,
  /** FFT simulation rate, Hz. Compute cost, not per-frame. */
  fftUpdateHz: 30,
  /** FFT grid per cascade (128 / 256 / 512). Changing it REBUILDS the ocean. */
  fftSize: 256,

  // ── Mesh (clipmap) ─────────────────────────────────────────────────────────
  levels: 7,
  gridM: 64,
  baseCell: 1,
  horizonScale: 6,

  /** Marks a V2 bag written after the V2 controls left the shared World Ocean
   *  sliders. A save without it took wind, swell and mesh from the top level. */
  ownControls: true,
  /** Displacement fades out between these; past `fftEnd` the FFT is not sampled
   *  at all and the surface shades as a flat mirror. */
  dispFadeStart: 260,
  dispFadeEnd: 900,
  fftEnd: 1600,
  /** Metres from shore over which swell height is scaled down to nothing. Real
   *  shoaling raises a wave before it breaks; that is the `shoalPeak` bump. */
  shoalDistance: 26,
  shoalPeak: 1.35,

  // ── Surface detail ─────────────────────────────────────────────────────────
  normalTiling: 0.035,
  normalStrength: 0.22,
  normalFlowSpeed: 0.12,
  /** Detail normal map is skipped past this camera distance. */
  detailEnd: 220,

  // ── Whitecaps (FFT Jacobian) ───────────────────────────────────────────────
  whitecapEnabled: true,
  whitecapIntensity: 0.9,
  /** Retuned for the horvath spectrum (0.68 under zelda): its 17 m cascade
   *  folds far more at the same choppiness, and 0.68 turned a moderate sea
   *  into a field of white blobs. */
  whitecapThreshold: 0.84,
  whitecapSoftness: 0.25,
  /** Power on whitecap coverage. 1 = a solid sheet over the whole fold; higher
   *  keeps only the fold's core solid and erodes the rest into lace. */
  whitecapCoreSharpness: 2.5,
  /** How much whitecap foam is dragged into streaks along the wind. 0 = none. */
  whitecapStreak: 0.6,
  /** Streaks per metre ACROSS the wind (they run ~8× longer along it). */
  whitecapStreakScale: 0.35,

  // ── Contact foam: where water meets geometry ───────────────────────────────
  contactFoamEnabled: true,
  /** Metres of water depth over geometry that still foams — the width of the
   *  ring around a pier leg, and how deep a rock can sit and still show. */
  contactFoamWidth: 1.5,
  contactFoamIntensity: 1.0,
  /** Camera distance past which contact foam fades out (depth precision). */
  contactFoamEnd: 250,

  // ── Foam bubbles ───────────────────────────────────────────────────────────
  /** How strongly bubbles punch holes in foam seen up close. 0 = smooth foam. */
  foamBubbles: 0.85,
  /** Bubble cells per metre (3 ≈ 33 cm bubbles). */
  foamBubbleScale: 3,

  // ── Foam relief ────────────────────────────────────────────────────────────
  /** Apparent height of foam, metres: how strongly its edges catch the sun. */
  foamRelief: 0.06,
  /** Camera distance by which the relief has faded out. */
  foamReliefEnd: 160,

  // ── Surf: the travelling part ──────────────────────────────────────────────
  surfEnabled: true,
  /** Wave sets per second arriving at the beach. */
  surfHz: 0.14,
  /** Metres between successive crests. surfHz × surfLength = shoreward speed,
   *  so these two defaults are a crest every ~7 s moving in at ~8.7 m/s. */
  surfLength: 62,
  /** Metres offshore that the surf zone extends. */
  surfReach: 46,
  /** Phase shift per metre ALONG the shore — what makes a swell arriving at an
   *  angle break progressively instead of all at once. 0 = every point on the
   *  beach breaks together (the old shader's only behaviour). */
  surfAlongShore: 0.0032,
  /** How tight the breaking crest is. Higher = a thinner, harder line. */
  crestSharpness: 7,
  crestIntensity: 0.95,
  /** Foam laid down by a passing crest decays over the rest of the cycle; higher
   *  = it dies sooner and the beach breathes rather than staying white. */
  foamDecay: 3.4,
  foamWakeIntensity: 0.70,
  /** Steep seabed = plunging breaker (tight, bright). Shallow = spilling (wide,
   *  soft). This is the gain on the slope channel of the shore field, and it is
   *  what stops every stretch of coast looking identical. */
  slopeGain: 3.5,

  // ── Surf: the waterline itself ─────────────────────────────────────────────
  runupEnabled: true,
  /** Metres the water's edge climbs the beach at the top of the surge. */
  runupReach: 7,
  /** Fraction of the cycle spent rushing in. The rest is the slower drain — the
   *  asymmetry is most of why it reads as water and not as a sine. */
  runupRush: 0.24,
  runupShape: 0.7,
  /** Above this seabed slope there is no run-up: water meets rock, it does not
   *  climb it. */
  runupMaxSlope: 0.34,
  /** Thickness of the sheet lying on wet sand, metres. */
  filmThickness: 0.045,
  /** Metres of camera distance over which run-up geometry fades back to a flat
   *  plane — far clipmap rings have cells far too coarse to resolve a beach. */
  runupNearEnd: 240,
  runupFarEnd: 420,
  /** Metres of already-drained sand that keeps a wet sheen behind the backwash. */
  wetFade: 2.2,
  wetDarken: 0.55,
  wetGloss: 0.5,

  // ── Foam appearance ────────────────────────────────────────────────────────
  foamEnabled: true,
  foamColor: "#f2fbfb",
  /** How much the sun lights the foam (wrapped diffuse) rather than it being a
   *  flat white. 0 = the old constant, 1 = fully sun-tinted. */
  foamSunLit: 0.7,
  /** Permanent band right at the water's edge, metres. */
  edgeWidth: 1.6,
  edgeIntensity: 0.9,
  /** Voronoi cells per metre in the coarse field. */
  foamNoiseScale: 0.145,
  /*
   * ── THE MACRO FIELD ────────────────────────────────────────────────────────
   * Cells per metre of a third, much larger Voronoi that modulates COVERAGE
   * rather than texture: 0.03 ≈ 33 m cells.
   *
   * This is the thing the foam was missing. Everything else here lives between
   * 0.45 m and 1.8 m, so from any distance the whole band averaged out to one
   * uniform ribbon of noise — foam-coloured static rather than foam. Real surf
   * is scale-invariant across two orders of magnitude: 30-50 m sheets where a
   * set has just broken, 5-10 m patches as it drains, then metre-scale lace.
   * Without a macro term you can add octaves forever and never get the first
   * of those, because no octave is anywhere near that size.
   *
   * It drives coverage, not brightness, so it feeds the erosion threshold: a
   * cell with low macro value does not get faint foam, it gets torn-open foam
   * with holes in it, and eventually none.
   */
  foamMacroScale: 0.03,
  /** How hard the macro field bites. 0 = the old uniform band, 1 = coverage is
   *  entirely at the macro field's mercy (too much — sets vanish between cells). */
  foamMacroAmt: 0.45,
  /** How far the macro sheets are dragged along the shore per second. Sets do
   *  not sit still; a stationary macro field reads as a stain on the water. */
  foamMacroDrift: 0.9,
  /** 1 = fully random cell points, 0 = a regular grid (and it looks like one). */
  foamJitter: 1.0,
  /** Domain warp: frequency, then how hard it pushes. The warp is what stops the
   *  Voronoi reading as a grid, so `foamWarpStrength` near 1 is not optional. */
  foamWarpScale: 3.0,
  foamWarpStrength: 0.6,
  /** Stretches the summed Voronoi field to fill 0..1. Without it the field sits
   *  around 0.35 and every threshold knob below is unusable — see the note at
   *  the point of use. */
  foamGain: 1.6,
  /** Shapes the web: >1 thins the filaments, <1 fattens them. */
  foamContrast: 1.5,
  /**
   * Erosion curve. Coverage sets a THRESHOLD on the noise field rather than
   * scaling the foam's opacity, so ageing foam breaks into filaments and flecks
   * instead of politely fading out. Higher = it holds together longer and then
   * shatters late.
   */
  foamErode: 1.6,
  /**
   * The threshold at FULL coverage, in the gain-normalised field's own units.
   * Low is a solid white sheet with round holes punched in it (which is what it
   * looks like, and not what foam looks like); around 0.6 leaves a connected web
   * with roughly half the area open, which is the target. Above ~0.75 even a
   * breaking crest is only flecks.
   */
  foamCutoff: 0.35,
  /** Width of the threshold's shoulder, and it is load-bearing: a near-binary
   *  cut turns any field into flat shapes with drawn edges. This is what lets
   *  thin foam be thin rather than absent. */
  foamTransition: 0.18,
  /*
   * Between these the foam stops being a thresholded field and becomes its own
   * area average.
   *
   * These are now a BACKSTOP, not the mechanism. Sub-pixel detail is killed per
   * octave by the screen-space LOD in `_worleyFbmLod`, which measures the real
   * footprint of a pixel in metres instead of guessing from camera distance —
   * a fixed metre range cannot be right, because whether a cell is sub-pixel
   * depends on resolution and field of view as much as on how far away it is.
   * The old 70/190 m pair was tuned at one window size on one machine, and from
   * a high camera it left the band still hard-thresholding cells about a pixel
   * across, which is exactly where the static came from. Pushed out so the LOD
   * does the work and these only catch the far horizon.
   */
  foamDetailNear: 260,
  foamDetailFar: 620,
  /** Pixels per Voronoi cell at which an octave is considered spent. Below ~2
   *  you are sampling under Nyquist and it sparkles; far above it, foam goes
   *  soft before it needs to. */
  foamLodPixels: 2.5,
  /** Area fraction the eroded field covers at full coverage, which is what the
   *  far field converges on. Read it off a close-up: it is how white the densest
   *  foam looks when you squint. */
  foamFarDensity: 0.72,
  /** Metres/second the foam texture is dragged offshore by the backwash. The
   *  direction comes from the shore field, so it is correct in every bay. */
  foamDrift: 1.4,

  // ── Horizon ────────────────────────────────────────────────────────────────
  horizonFadeStart: 2200,
  horizonFadeEnd: 9000,

  /*
   * ── UNDERWATER ─────────────────────────────────────────────────────────────
   * Read by THREE places that must agree: this shader's underside (Snell's
   * window), oceanUnderwater.js (the waterline + the water between the camera
   * and everything it sees, + marine snow), and the terrain's seabed caustics
   * (lakebedTsl.js). One set of numbers, so the surface seen from below and the
   * volume in front of it are the same water.
   */
  uwEnabled: true,
  /** Per-metre extinction, linear RGB. Red dies in a few metres, blue carries
   *  tens — which is the entire reason the underwater world turns blue-green
   *  with distance instead of just going grey. Clear coastal water. */
  uwExtinction: [0.32, 0.075, 0.05],
  /** Multiplier on `uwExtinction`. 0.5 = tropical clarity, 2+ = a murky harbour. */
  uwDensity: 1.0,
  /** Albedo of the suspended matter: the colour of a horizontal line of sight
   *  that never hits anything, at the surface, under the scene's own light. */
  uwScatterColor: "#1c86a6",
  /** Gain on the scene light the water scatters. 1 = the sun and sky lights
   *  exactly as the terrain receives them. */
  uwLightGain: 1.0,
  /** Forward-scattering glow toward the (refracted) sun. 0 = isotropic murk. */
  uwSunGlow: 0.55,
  /** Henyey-Greenstein g of that glow. Higher = a tighter, brighter halo. */
  uwSunGlowG: 0.78,
  /** Brightness of the sky seen through Snell's window from below. */
  uwWindowSky: 1.0,
  /** Camera metres above sea level at which the underwater pass starts running.
   *  Must clear the tallest crest or a wave washing over the lens pops in. */
  uwActiveBand: 6,
  /** The waterline across the lens: width in pixels, how dark its core is, and
   *  how many pixels the scene is dragged just below it. */
  uwLineWidth: 2.5,
  uwLineDarken: 0.6,
  uwLineDistort: 5,
  /** Marine snow: the suspended specks that make motion through water legible. */
  uwSnowEnabled: true,
  uwSnowCount: 1400,
  uwSnowSize: 0.012,
  uwSnowIntensity: 0.9,
  /** Metres: the wrapped box of specks that travels with the camera. */
  uwSnowBox: 18,
  /*
   * Light shafts: sunlight focused by the waves into columns, marched along the
   * view ray inside the underwater pass (no extra draw). They lean toward the
   * REFRACTED sun and fade with depth and distance on their own.
   */
  uwShaftsEnabled: true,
  uwShaftIntensity: 8,
  /** Metres along the view ray the march covers. Past it the water is haze. */
  uwShaftDistance: 45,
  /** Pattern cells per metre at the surface — the width of a shaft. */
  uwShaftScale: 0.07,
  /** >1 pinches the pattern into fewer, thinner, brighter shafts. */
  uwShaftSharpness: 2,
  /** Metres/second the pattern drifts with the wind. */
  uwShaftSpeed: 0.6,
  /** Caustics on the seabed under the sea — visible from above AND below. */
  uwCausticsEnabled: true,
  uwCausticsIntensity: 0.7,
  /** Metres of water past which the caustic net has faded out. */
  uwCausticsMaxDepth: 28,
  /** Camera distance past which caustics are not computed at all. */
  uwCausticsRange: 220,

  opacity: 1.0,
  seaLevel: 0,
};

/**
 * @param {object}            deps
 * @param {THREE.TextureNode} deps.heightTexNode — live terrain heightmap node
 * @param {THREE.Texture}     deps.shoreTexture  — from createShorelineField()
 * @param {THREE.Texture}     [deps.normalMap]   — tiling water normal map
 * @param {number}            deps.terrainSize   — world metres per side
 * @param {number}            [deps.maxHeight=500]
 * @param {number}            [deps.heightBase=0] — world Y that a stored 0.0 means.
 *   v3 terrain stores heights upward from 0 and leaves this alone; a game placing
 *   a dock at y=0 with sea beneath it sets a negative base so the stored range
 *   still lands in the 0..1 the texture wants.
 * @param {object|null}       [deps.fft]         — createOceanFFTGPUSimulation()
 */
export function createOceanSurface({
  heightTexNode,
  shoreTexture,
  normalMap = null,
  terrainSize,
  maxHeight = 500,
  heightBase = 0,
  fft = null,
  envMap = null,
  shadowNode = null,
}) {
  /*
   * The scene's prefiltered environment. `scene.environment` is already a PMREM
   * result and PMREMNode passes such a texture straight through (isPMREMTexture),
   * so no second prefilter happens. The node's `value` is settable at runtime and
   * only resets its cached PMREM, so following a sky change costs no recompile.
   */
  let _envTexture = envMap ?? null;
  /**
   * The sun's shadow node (a CSMShadowNode in the editor), or null for none.
   * Read when the colour graph is BUILT, so changing it rebuilds the material —
   * see setShadowNode. Not a uniform on purpose: a dead cascade node left in a
   * compiled graph keeps running its updateBefore on three r184.
   */
  let _sunShadowNode = shadowNode ?? null;
  /** Every PMREM tap in the graph (the reflection, and Snell's window from
   *  below) — setEnvMap has to repoint all of them. */
  const _envNodes = [];
  const envTap = (dir, rough) => {
    const n = pmremTexture(_envTexture ?? envPlaceholder(), dir, rough);
    _envNodes.push(n);
    return n;
  };

  const D = OCEAN2_DEFAULTS;
  const u = {};

  u.time = uniform(0);
  u.waterY = uniform(D.seaLevel);
  /** Metres per quad in the innermost clipmap ring; the host keeps it current. */
  u.meshBaseCell = uniform(1);

  u.absorption = uniform(new THREE.Vector3(...D.absorption));
  u.absorptionScale = uniform(D.absorptionScale);
  u.depthDistance = uniform(D.depthDistance);
  u.inscatterTint = uniform(new THREE.Color(D.inscatterTint));
  u.inscatterStrength = uniform(D.inscatterStrength);
  u.turbidityTint = uniform(new THREE.Color(D.turbidityTint));
  u.turbidityStrength = uniform(D.turbidityStrength);
  u.turbidityReach = uniform(D.turbidityReach);

  u.refractionStrength = uniform(D.refractionStrength);
  u.refractEnd = uniform(D.refractEnd);

  u.skyZenithColor = uniform(new THREE.Color(D.skyZenithColor));
  u.skyHorizonColor = uniform(new THREE.Color(D.skyHorizonColor));
  u.sunColor = uniform(new THREE.Color(D.sunColor));
  u.skyReflectIntensity = uniform(D.skyReflectIntensity);
  u.envReflect = uniform(D.envReflect);
  u.envIntensity = uniform(D.envIntensity);
  /** 0 until a host hands us an environment; keeps the analytic fallback exact. */
  u.envPresent = uniform(_envTexture ? 1 : 0);
  u.waterRoughness = uniform(D.waterRoughness);
  u.specAA = uniform(D.specAA);
  u.specAAMax = uniform(D.specAAMax);
  u.skyHorizonSpread = uniform(Math.sin(D.skyHorizonSpread * DEG2RAD));
  u.skySunGlow = uniform(D.skySunGlow);
  u.skySunGlowSize = uniform(D.skySunGlowSize);
  u.fresnelScale = uniform(D.fresnelScale);

  u.ssrEnabled = uniform(D.ssrEnabled ? 1 : 0);
  u.ssrStrength = uniform(D.ssrStrength);
  u.ssrMaxDistance = uniform(D.ssrMaxDistance);
  u.ssrThickness = uniform(D.ssrThickness);
  u.ssrEdgeFade = uniform(D.ssrEdgeFade);
  u.ssrEnd = uniform(D.ssrEnd);

  u.shadowsEnabled = uniform(D.shadowsEnabled ? 1 : 0);
  u.shadowBodyDarken = uniform(D.shadowBodyDarken);
  u.shadowFoamDarken = uniform(D.shadowFoamDarken);

  u.sunDir = uniform(new THREE.Vector3(0.4, 0.55, 0.3).normalize());
  u.glintIntensity = uniform(D.glintIntensity);
  u.glintPower = uniform(D.glintPower);
  u.glintSpread = uniform(D.glintSpread);

  u.sssEnabled = uniform(D.sssEnabled ? 1 : 0);
  u.sssIntensity = uniform(D.sssIntensity);
  u.sssColor = uniform(new THREE.Color(D.sssColor));

  u.fftEnabled = uniform(D.fftEnabled ? 1 : 0);
  u.fftSwellAmp = uniform(D.fftSwellAmp);
  u.fftRippleAmp = uniform(D.fftRippleAmp);
  u.fftNormalStrength = uniform(D.fftNormalStrength);
  u.windAngle = uniform(D.windAngleDeg * DEG2RAD);
  u.dispFadeStart = uniform(D.dispFadeStart);
  u.dispFadeEnd = uniform(D.dispFadeEnd);
  u.fftEnd = uniform(D.fftEnd);
  u.shoalDistance = uniform(D.shoalDistance);
  u.shoalPeak = uniform(D.shoalPeak);

  u.normalTiling = uniform(D.normalTiling);
  u.normalStrength = uniform(D.normalStrength);
  u.normalFlowSpeed = uniform(D.normalFlowSpeed);
  u.detailEnd = uniform(D.detailEnd);

  u.whitecapEnabled = uniform(D.whitecapEnabled ? 1 : 0);
  u.whitecapIntensity = uniform(D.whitecapIntensity);
  u.whitecapThreshold = uniform(D.whitecapThreshold);
  u.whitecapSoftness = uniform(D.whitecapSoftness);
  u.whitecapCoreSharpness = uniform(D.whitecapCoreSharpness);
  u.whitecapStreak = uniform(D.whitecapStreak);
  u.whitecapStreakScale = uniform(D.whitecapStreakScale);
  u.contactFoamEnabled = uniform(D.contactFoamEnabled ? 1 : 0);
  u.contactFoamWidth = uniform(D.contactFoamWidth);
  u.contactFoamIntensity = uniform(D.contactFoamIntensity);
  u.contactFoamEnd = uniform(D.contactFoamEnd);
  u.foamBubbles = uniform(D.foamBubbles);
  u.foamBubbleScale = uniform(D.foamBubbleScale);
  u.foamRelief = uniform(D.foamRelief);
  u.foamReliefEnd = uniform(D.foamReliefEnd);

  u.surfEnabled = uniform(D.surfEnabled ? 1 : 0);
  u.surfHz = uniform(D.surfHz);
  u.surfLength = uniform(D.surfLength);
  u.surfReach = uniform(D.surfReach);
  u.surfAlongShore = uniform(D.surfAlongShore);
  u.crestSharpness = uniform(D.crestSharpness);
  u.crestIntensity = uniform(D.crestIntensity);
  u.foamDecay = uniform(D.foamDecay);
  u.foamWakeIntensity = uniform(D.foamWakeIntensity);
  u.slopeGain = uniform(D.slopeGain);

  u.runupEnabled = uniform(D.runupEnabled ? 1 : 0);
  u.runupReach = uniform(D.runupReach);
  u.runupRush = uniform(D.runupRush);
  u.runupShape = uniform(D.runupShape);
  u.runupMaxSlope = uniform(D.runupMaxSlope);
  u.filmThickness = uniform(D.filmThickness);
  u.runupNearEnd = uniform(D.runupNearEnd);
  u.runupFarEnd = uniform(D.runupFarEnd);
  u.wetFade = uniform(D.wetFade);
  u.wetDarken = uniform(D.wetDarken);
  u.wetGloss = uniform(D.wetGloss);

  u.foamEnabled = uniform(D.foamEnabled ? 1 : 0);
  u.foamColor = uniform(new THREE.Color(D.foamColor));
  u.foamSunLit = uniform(D.foamSunLit);
  u.edgeWidth = uniform(D.edgeWidth);
  u.edgeIntensity = uniform(D.edgeIntensity);
  u.foamNoiseScale = uniform(D.foamNoiseScale);
  u.foamMacroScale = uniform(D.foamMacroScale);
  u.foamMacroAmt = uniform(D.foamMacroAmt);
  u.foamMacroDrift = uniform(D.foamMacroDrift);
  u.foamLodPixels = uniform(D.foamLodPixels);
  u.foamJitter = uniform(D.foamJitter);
  u.foamWarpScale = uniform(D.foamWarpScale);
  u.foamWarpStrength = uniform(D.foamWarpStrength);
  u.foamGain = uniform(D.foamGain);
  u.foamContrast = uniform(D.foamContrast);
  u.foamErode = uniform(D.foamErode);
  u.foamCutoff = uniform(D.foamCutoff);
  u.foamTransition = uniform(D.foamTransition);
  u.foamDetailNear = uniform(D.foamDetailNear);
  u.foamDetailFar = uniform(D.foamDetailFar);
  u.foamFarDensity = uniform(D.foamFarDensity);
  u.foamDrift = uniform(D.foamDrift);

  u.horizonFadeStart = uniform(D.horizonFadeStart);
  u.horizonFadeEnd = uniform(D.horizonFadeEnd);

  u.uwExtinction = uniform(new THREE.Vector3(...D.uwExtinction));
  u.uwDensity = uniform(D.uwDensity);
  u.uwScatterColor = uniform(new THREE.Color(D.uwScatterColor));
  u.uwSunGlow = uniform(D.uwSunGlow);
  u.uwSunGlowG = uniform(D.uwSunGlowG);
  u.uwWindowSky = uniform(D.uwWindowSky);
  u.uwActiveBand = uniform(D.uwActiveBand);
  u.uwLineWidth = uniform(D.uwLineWidth);
  u.uwLineDarken = uniform(D.uwLineDarken);
  u.uwLineDistort = uniform(D.uwLineDistort);
  u.uwSnowSize = uniform(D.uwSnowSize);
  u.uwSnowIntensity = uniform(D.uwSnowIntensity);
  u.uwSnowBox = uniform(D.uwSnowBox);
  u.uwShaftsEnabled = uniform(D.uwShaftsEnabled ? 1 : 0);
  u.uwShaftIntensity = uniform(D.uwShaftIntensity);
  u.uwShaftDistance = uniform(D.uwShaftDistance);
  u.uwShaftScale = uniform(D.uwShaftScale);
  u.uwShaftSharpness = uniform(D.uwShaftSharpness);
  u.uwShaftSpeed = uniform(D.uwShaftSpeed);
  /*
   * The light the water scatters, split in two because only the sun part is
   * directional (it gets the forward-scattering lobe). Radiance units — the host
   * divides the lights' irradiance by π, the same factor a Lambert surface
   * applies, so murk and seabed brighten and darken together. Pushed per frame
   * by worldOceanV2.setLight(); these defaults are a plain noon for hosts that
   * never call it.
   */
  u.uwLightSun = uniform(new THREE.Vector3(0.7, 0.67, 0.62));
  u.uwLightAmb = uniform(new THREE.Vector3(0.16, 0.19, 0.22));
  /** Direction TOWARD the sun as seen from under the water — refracted, so a
   *  sunset sun still sits ~48° off vertical down here. */
  u.uwSunDirUnder = uniform(new THREE.Vector3(0, 1, 0));
  u.opacity = uniform(D.opacity);

  const uTerrainSize = uniform(terrainSize);
  const uMaxHeight = float(maxHeight);
  const uHeightBase = float(heightBase);

  const fftCascades = fft ? fft.cascades : [];
  const ampForCascade = (i) =>
    i === 0 ? u.fftSwellAmp
      : i === fftCascades.length - 1 ? u.fftRippleAmp
        : float(1);

  // ── The one framebuffer grab this material needs ───────────────────────────
  // lakeMaterial.js hoists an identical pair to module scope so a lake and a
  // river share one copy rather than taking two each. We cannot reuse those
  // without editing that file, which this candidate deliberately does not touch.
  // If the ocean ships, exporting them from there is a one-line, behaviour-free
  // change and this pair goes away.
  const sceneColorTex = viewportSharedTexture();
  const sceneDepthTex = viewportDepthTexture();

  const sceneDistAt = Fn(([suv = vec2(0)]) =>
    perspectiveDepthToViewZ(sceneDepthTex.sample(suv).r, cameraNear, cameraFar).negate(),
  );

  // ── Sampling helpers ───────────────────────────────────────────────────────

  /** World XZ → heightmap/shore-field UV, clamped just inside the border. */
  function fieldUV(xz) {
    return vec2(
      clamp(xz.x.div(uTerrainSize).add(0.5), float(0.0005), float(0.9995)),
      clamp(xz.y.div(uTerrainSize).add(0.5), float(0.0005), float(0.9995)),
    );
  }

  /** Terrain height in world metres. */
  function terrainYAt(xz) {
    return texture(heightTexNode, fieldUV(xz)).r.mul(uMaxHeight).add(uHeightBase);
  }

  /**
   * One tap, four numbers: metres to the waterline (signed, + = water), the unit
   * offshore direction, and the seabed slope. Replaces the old shader's five
   * heightmap taps AND supplies two quantities it never had.
   *
   * Outside the terrain the clamp returns the border value, which for any island
   * map is deep water — exactly the answer we want out there.
   */
  function shoreAt(xz) {
    return texture(shoreTexture, fieldUV(xz));
  }

  // ── The travelling surf, shared by the vertex and fragment stages ──────────
  // Both stages must agree exactly or the geometry and the foam drift apart, so
  // this is written once and called twice.

  /**
   * Phase of the arriving swell. The `sd / surfLength` term is what makes a crest
   * TRAVEL: hold the phase constant and sd falls linearly with time, i.e. the
   * crest moves shoreward at surfHz · surfLength metres per second. The
   * along-shore term staggers the break down the beach.
   */
  function surfPhase(xz, sd) {
    const alongDir = vec2(cos(u.windAngle.add(float(Math.PI * 0.5))),
      sin(u.windAngle.add(float(Math.PI * 0.5))));
    return u.time.mul(u.surfHz)
      .add(sd.div(max(u.surfLength, float(1))))
      .add(dot(xz, alongDir).mul(u.surfAlongShore));
  }

  /**
   * How far up the beach the water's edge has climbed right now, in metres.
   * Evaluated at the shoreline (sd = 0), because the surge at a point on the
   * sand is set by when the wave reached THAT point, not by where the point sits
   * within the sheet.
   *
   * The shape is a triangle with its peak at `runupRush`, so the water rushes in
   * over a quarter of the cycle and drains over the remaining three quarters.
   * A symmetric sine here is the single most common reason CG surf looks wrong.
   */
  function runupAt(xz) {
    const t = fract(surfPhase(xz, float(0))).toVar();
    const rush = clamp(u.runupRush, float(0.02), float(0.95));
    const rise = saturate(t.div(rush));
    const fall = saturate(float(1).sub(t).div(max(float(1).sub(rush), float(0.02))));
    const tri = min(rise, fall);
    return pow(tri, u.runupShape).mul(u.runupReach).mul(u.runupEnabled);
  }

  // ── FFT helpers ────────────────────────────────────────────────────────────

  /**
   * Summed cascade displacement at a world XZ.
   *
   * `spacing` (metres between the samples that will reconstruct this — a
   * vertex's grid cell) picks each cascade's mip so the grid never samples
   * detail it cannot represent. Without it every cascade is read at mip 0,
   * which is fine for a 128² swell but not for a 5 m cascade at 256²: its
   * texels are 2 cm, the inner ring's vertices are 1 m apart, and point-
   * sampling that makes vertices jump between unrelated values every sim tick
   * — visible as crawling, sparkling geometry. The level puts one texel at
   * roughly one cell; the fragment normals keep the detail the mesh drops.
   * Omit it for single-point queries (the waterline on the lens).
   */
  function fftDispAt(xz, ampScale, spacing = null) {
    if (!fftCascades.length) return vec3(0);
    let sum = vec3(0);
    fftCascades.forEach((c, i) => {
      const tap = texture(c.dispTex, xz.div(c.tileSize));
      const texelsPerMetre = (c.dispTex.image?.width ?? 128) / c.tileSize;
      const level = spacing
        ? log2(max(spacing.mul(texelsPerMetre), float(1)))
        : float(0);
      sum = sum.add(tap.level(level).xyz.mul(ampForCascade(i)));
    });
    return sum.mul(ampScale).mul(u.fftEnabled);
  }

  function fftSlopeAt(xz, ampScale) {
    if (!fftCascades.length) return vec2(0);
    let sum = vec2(0);
    fftCascades.forEach((c, i) => {
      const d = texture(c.derivTex, xz.div(c.tileSize));
      const g = vec2(d.x.div(float(1).add(d.z)), d.y.div(float(1).add(d.w)));
      sum = sum.add(g.mul(ampForCascade(i)));
    });
    return sum.mul(u.fftNormalStrength).mul(ampScale).mul(u.fftEnabled);
  }

  /** Jacobian turbulence: ~1 flat, →0 where a crest is pinching over. */
  function fftJacobianAt(xz) {
    if (!fftCascades.length) return float(1);
    const foamCascades = fftCascades.length > 2 ? fftCascades.slice(0, -1) : fftCascades;
    let j = texture(foamCascades[0].dispTex, xz.div(foamCascades[0].tileSize)).level(0).w;
    for (const c of foamCascades.slice(1)) {
      j = min(j, texture(c.dispTex, xz.div(c.tileSize)).level(0).w);
    }
    return j;
  }

  /** Displacement fade with camera distance. */
  function ampScaleAt(xz) {
    const d = length(xz.sub(cameraPosition.xz));
    return saturate(float(1).sub(smoothstep(u.dispFadeStart, u.dispFadeEnd, d)));
  }

  /**
   * Shoaling: swell height falls to nothing at the waterline, but RISES first as
   * it feels the bottom. The old shader only ever damps (`shoreDampStart/End` on
   * depth), so its waves shrink into the beach instead of standing up before
   * they break.
   */
  function shoalAt(sd) {
    const t = saturate(max(sd, float(0)).div(max(u.shoalDistance, float(0.5))));
    const peak = float(1).add(u.shoalPeak.sub(1).mul(sin(t.mul(float(Math.PI)))));
    return smoothstep(float(0), float(0.35), t).mul(peak);
  }

  /**
   * World Y of the displaced surface above a world XZ — for things that are NOT
   * the surface mesh but must agree with it: the waterline across the camera
   * lens, and specks that must not float above the water.
   *
   * The FFT displaces HORIZONTALLY too (choppiness), so the vertex that ends up
   * above `xz` started somewhere else. One fixed-point step back
   * (`p = xz - disp(xz).xz`) recovers it to a few centimetres at default chop;
   * reading the height straight at `xz` instead puts the waterline visibly off
   * the crest it should be riding, worst exactly where waves are steepest.
   *
   * Run-up is left out on purpose: it only exists on a beach, in a strip a few
   * metres wide, where nobody is filming from under the water.
   */
  function waterHeightAt(xz) {
    const sd = shoreAt(xz).x;
    const amp = ampScaleAt(xz).mul(shoalAt(sd));
    // Same mips the INNER clipmap ring reads — the camera is always inside it,
    // so this is the surface the lens is actually crossing, not a finer one.
    const first = fftDispAt(xz, amp, u.meshBaseCell);
    const back = xz.sub(vec2(first.x, first.z));
    return u.waterY.add(fftDispAt(back, amp, u.meshBaseCell).y);
  }

  // ── Analytic sky ───────────────────────────────────────────────────────────
  /**
   * The old shader reflects `mix(horizon, zenith, smoothstep(dir.y))` — two
   * colours and nothing else, which is why the sea reads as tinted plastic: real
   * water is mostly a mirror, and a mirror is only as interesting as what it is
   * pointed at. This adds the two features that carry a sea reflection: a bright
   * narrow band at the horizon, and the sun's aureole.
   *
   * `setSky()` overrides all three colours per frame, so a host with a real sky
   * model (the racing game's physical sky) feeds this instead of guessing.
   */
  function analyticSky(dir) {
    const up = saturate(dir.y);
    const grad = mix(u.skyHorizonColor, u.skyZenithColor, pow(up, float(0.55)));
    // Horizon band: bright and desaturated within a few degrees of level.
    // NOT boosted above the horizon colour itself. An earlier 1.18× here made
    // the band brighter than the sky it is supposed to be reflecting, which is
    // invisible from above and overwhelming from a low camera — at eye level a
    // metre off the water almost every reflected ray IS near-horizontal, so the
    // whole near field washed out to white.
    const band = float(1).sub(smoothstep(float(0), max(u.skyHorizonSpread, float(1e-3)), up));
    const withBand = mix(grad, u.skyHorizonColor, band.mul(0.4));
    // Sun aureole — broad, low-contrast; the specular lobe is separate.
    const sunCos = saturate(dot(normalize(dir), u.sunDir));
    const glow = pow(sunCos, max(u.skySunGlowSize, float(1)));
    return withBand.add(u.sunColor.mul(glow.mul(u.skySunGlow)));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // VERTEX
  // ═══════════════════════════════════════════════════════════════════════════
  const oceanPosition = Fn(() => {
    // CDLOD morph, unchanged from the old clipmap — it works and it is not the
    // problem. Snaps the outer quarter of each ring to the next-coarser grid so
    // ring boundaries do not pop.
    const localXZ = positionLocal.xz;
    const cell = attribute("aCell", "float");
    const outerHalf = max(attribute("aOuterHalf", "float"), float(1e-3));
    const cheb = max(abs(localXZ.x), abs(localXZ.y));
    const morphK = saturate(cheb.div(outerHalf).sub(0.75).div(0.25));
    const grid = cell.mul(2);
    const snapXZ = round(localXZ.div(grid)).mul(grid);
    const morphedXZ = mix(localXZ, snapXZ, morphK).toVar();

    const worldBase = modelWorldMatrix.mul(vec4(positionLocal, float(1))).xz;
    const worldXZ = worldBase.add(morphedXZ.sub(localXZ)).toVar();

    const shore = shoreAt(worldXZ).toVar();
    const sd = shore.x.toVar();
    const camDist = length(worldXZ.sub(cameraPosition.xz)).toVar();

    // Swell, faded by distance and shaped by the seabed.
    const amp = ampScaleAt(worldXZ).mul(shoalAt(sd)).toVar();
    // Effective vertex spacing: the ring's cell, doubling across the morph zone
    // as vertices snap to the next-coarser grid.
    const disp = fftDispAt(worldXZ, amp, cell.mul(morphK.add(1))).toVar();

    // Local Y is relative to the group, which sits at sea level.
    const waveY = disp.y.toVar();
    const outY = waveY.toVar();

    // ── Run-up: the sheet rides the sand near the waterline ──────────────────
    // Gated three ways, and every gate is there because without it something
    // breaks: by distance (far rings have cells tens of metres across and cannot
    // resolve a beach), by seabed slope (water climbs sand, not cliffs), and by
    // proximity to the waterline (everywhere else this must be exactly a plane).
    If(u.runupEnabled.greaterThan(0), () => {
      const nearGate = float(1).sub(smoothstep(u.runupNearEnd, u.runupFarEnd, camDist));
      const slopeGate = float(1).sub(
        smoothstep(u.runupMaxSlope, u.runupMaxSlope.mul(2), shore.w),
      );
      const bandGate = float(1).sub(
        smoothstep(u.runupReach.mul(1.5), u.runupReach.mul(3), abs(sd)),
      );
      const g = nearGate.mul(slopeGate).mul(bandGate).toVar();

      If(g.greaterThan(0.001), () => {
        const seabedRel = terrainYAt(worldXZ).sub(u.waterY);
        // The surface can never pass below the seabed. The old shader has no
        // such clamp, which is why its troughs flicker the sand through the
        // water at the waterline.
        const rideY = max(waveY, seabedRel.add(u.filmThickness));
        outY.assign(mix(waveY, rideY, g));
      });
    });

    // `outY` already carries the wave height (or the ride height that replaced
    // it), so the horizontal choppiness is the only part of `disp` added here.
    return vec3(morphedXZ.x.add(disp.x), outY, morphedXZ.y.add(disp.z));
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // FRAGMENT
  // ═══════════════════════════════════════════════════════════════════════════
  const oceanColor = Fn(() => {
    const wXZ = positionWorld.xz.toVar();

    // ── Shared values, all materialised BEFORE the first branch ──────────────
    // A node first referenced inside an If gets emitted inside that block, so
    // anything read by a later branch has to be forced into a variable up here
    // or it reads garbage. (Same trap as the terrain's branch gates.)
    const shore = shoreAt(wXZ).toVar();
    const sd = shore.x.toVar();
    const offDir = normalize(vec2(shore.y, shore.z)).toVar();
    const slope = shore.w.toVar();

    const camDist = length(wXZ.sub(cameraPosition.xz)).toVar();
    const fragDist = positionView.z.negate().toVar();
    const viewDir = normalize(cameraPosition.sub(positionWorld)).toVar();

    // ── Sun shadow: 1 lit, 0 in full shade ───────────────────────────────────
    // Sampled here, ahead of every Discard and branch, so it is in uniform
    // control flow whatever the shadow node's sampler turns out to need. The
    // cascade node already renders its maps for the terrain; this only reads
    // them at the water's own world position.
    const sunLit = float(1).toVar();
    if (_sunShadowNode) {
      sunLit.assign(mix(float(1), nodeObject(_sunShadowNode).r, u.shadowsEnabled));
    }

    // Where the water's edge is right now, and therefore what is wet.
    const surge = runupAt(wXZ).toVar();
    const sdEff = sd.add(surge).toVar();

    // ── Discard 1: behind opaque geometry ────────────────────────────────────
    // The depth buffer holds only what drew before the water, so this is an exact
    // shoreline against arbitrary geometry — rocks, piers, the terrain — with no
    // heightmap involved.
    const sceneDist = sceneDistAt(screenUV).toVar();
    const thickness = sceneDist.sub(fragDist).toVar();
    Discard(thickness.lessThanEqual(0));

    // ── Discard 2: the backwash has drained past this point ──────────────────
    // Everything seaward of the moving edge stays; a strip of already-drained
    // sand behind it keeps a wet sheen and fades out over `wetFade` metres.
    Discard(sdEff.lessThan(u.wetFade.negate()));
    const wetT = saturate(sdEff.negate().div(max(u.wetFade, float(0.01)))).toVar();
    const isWetSand = step(float(0), sdEff.negate()).toVar();

    // ── Normal ───────────────────────────────────────────────────────────────
    // Slope comes from the FFT cascades' own derivative textures — which is
    // where the old shader's nine mx_noise_float calls went — plus two taps of a
    // tiling normal map for the sub-cascade detail that carries close-up water.
    //
    // BOTH ARE UNCONDITIONAL, AND THAT IS DELIBERATE.
    // A tempting extra saving here is to branch the whole block out past a
    // distance where a wave is under a pixel. WGSL will not have it: an implicit
    // `textureSample` computes derivatives and is only legal in UNIFORM control
    // flow, so a mipmapped tap inside an `If` is a validation error, not a
    // slow path. (The FFT displacement taps carry an explicit `.level(0)` and
    // would be legal, but the derivative taps want their mips — that is what
    // keeps the far sea from sparkling.) So distance is spent as a FADE here and
    // the real branches are kept for blocks that read no mipmapped texture at
    // all: the Worley foam, the SSR march, and the refraction tap — which is
    // where nearly all of the cost was anyway.
    const distFade = float(1).sub(smoothstep(u.fftEnd.mul(0.6), u.fftEnd, camDist)).toVar();
    const amp = ampScaleAt(wXZ).mul(shoalAt(sd)).mul(distFade).toVar();
    const nSlope = fftSlopeAt(wXZ, amp).toVar();
    const jacobian = fftJacobianAt(wXZ).toVar();

    const worldN = vec3(nSlope.x.negate(), float(1), nSlope.y.negate()).normalize().toVar();
    const flatN = worldN.toVar(); // kept for the glint, before detail roughens it

    if (normalMap) {
      const fade = float(1).sub(smoothstep(u.detailEnd.mul(0.7), u.detailEnd, camDist));
      const base = wXZ.mul(u.normalTiling);
      const drift = vec2(cos(u.windAngle), sin(u.windAngle))
        .mul(u.time.mul(u.normalFlowSpeed));
      const t1 = texture(normalMap, base.mul(1.37).add(drift)).rgb.mul(2).sub(1).normalize();
      const t2 = texture(normalMap, base.mul(0.71).sub(drift.mul(0.6))).rgb.mul(2).sub(1).normalize();
      const tsn = _blendRNM(t1, t2);
      const det = vec3(tsn.x, tsn.z, tsn.y).mul(u.normalStrength.mul(fade));
      worldN.assign(normalize(worldN.add(vec3(det.x, 0, det.z))));
    }

    /*
     * ── ROUGHNESS FROM WHAT THE PIXEL CANNOT SEE ─────────────────────────────
     * Kaplanyan/Tokuyoshi geometric specular antialiasing: the variance of the
     * normal inside one pixel, measured from its screen-space derivative and
     * added to the roughness.
     *
     * This is the whole answer to the distant sea. Out past a few hundred
     * metres a pixel covers many waves; averaging their normals discards the
     * spread, leaving a mirror the water is not, so the horizon goes glassy and
     * the sun glint aliases into crawling sparkle. Feeding the discarded
     * variance back as roughness widens the specular lobe and blurs the
     * environment tap by exactly as much as was lost.
     *
     * Derivatives, so this must stay in UNIFORM control flow — same rule that
     * keeps mipmapped textureSample out of the branches below. It sits here, in
     * the main body, and the branches read the result.
     */
    const dNx = dFdx(worldN);
    const dNy = dFdy(worldN);
    const normalVar = dot(dNx, dNx).add(dot(dNy, dNy));
    const kernelRough = min(normalVar.mul(u.specAA), u.specAAMax).toVar();
    // Roughness composes in alpha (= roughness²), not in roughness.
    const baseAlpha = u.waterRoughness.mul(u.waterRoughness);
    const specAlpha2 = saturate(baseAlpha.add(kernelRough)).toVar();
    const envRough = saturate(sqrt(specAlpha2)).toVar();

    // ── Reflection ───────────────────────────────────────────────────────────
    const reflectDir = reflect(viewDir.negate(), worldN).toVar();
    const skyColor = analyticSky(reflectDir).mul(u.skyReflectIntensity).toVar();
    /*
     * The real environment, prefiltered, sampled at the roughness derived
     * above — so a calm near surface takes a sharp mip and the far sea takes a
     * blurred one, which is what stops the horizon from shimmering.
     *
     * `envPresent` is 0 until a host calls setEnvMap, so with no environment
     * this collapses to exactly the analytic sky it replaced.
     */
    const envColor = envTap(reflectDir, envRough).mul(u.envIntensity);
    const reflected = mix(
      skyColor, envColor, saturate(u.envReflect.mul(u.envPresent)),
    ).toVar();

    If(u.ssrEnabled.greaterThan(0).and(camDist.lessThan(u.ssrEnd)), () => {
      const vsNrm = cameraViewMatrix.mul(vec4(worldN, 0)).xyz.normalize().toVar();
      const vsPos = positionView.add(vsNrm.mul(0.05)).toVar();
      const vsDir = reflect(normalize(vsPos), vsNrm).normalize().toVar();

      const stepLen = u.ssrMaxDistance.div(float(SSR_STEPS)).toVar();
      const hitUv = vec2(0).toVar();
      const crossed = float(0).toVar();
      const tNear = float(0).toVar();
      const tFar = float(0).toVar();

      Loop(SSR_STEPS, ({ i }) => {
        const t = stepLen.mul(float(i).add(1)).toVar();
        const p = vsPos.add(vsDir.mul(t));
        If(p.z.greaterThan(cameraNear.negate()), () => { Break(); });

        const clip = cameraProjectionMatrix.mul(vec4(p, 1));
        const suv = clip.xy.div(clip.w).mul(0.5).add(0.5).toVar();
        If(suv.x.lessThan(0).or(suv.x.greaterThan(1))
          .or(suv.y.lessThan(0)).or(suv.y.greaterThan(1)), () => { Break(); });

        If(p.z.negate().sub(sceneDistAt(suv)).greaterThan(0), () => {
          crossed.assign(1);
          hitUv.assign(suv);
          tNear.assign(t.sub(stepLen));
          tFar.assign(t);
          Break();
        });
      });

      If(crossed.greaterThan(0), () => {
        const finalDiff = float(0).toVar();
        Loop(SSR_REFINE, () => {
          const tMid = tNear.add(tFar).mul(0.5).toVar();
          const p = vsPos.add(vsDir.mul(tMid));
          const clip = cameraProjectionMatrix.mul(vec4(p, 1));
          const suv = clip.xy.div(clip.w).mul(0.5).add(0.5);
          const diff = p.z.negate().sub(sceneDistAt(suv)).toVar();
          If(diff.greaterThan(0), () => {
            tFar.assign(tMid);
            hitUv.assign(suv);
            finalDiff.assign(diff);
          }).Else(() => {
            tNear.assign(tMid);
          });
        });

        const valid = float(1).sub(smoothstep(u.ssrThickness, u.ssrThickness.mul(2), finalDiff));
        const e = max(u.ssrEdgeFade, float(1e-4));
        const edge = smoothstep(0, e, hitUv.x).mul(smoothstep(0, e, float(1).sub(hitUv.x)))
          .mul(smoothstep(0, e, hitUv.y)).mul(smoothstep(0, e, float(1).sub(hitUv.y)));
        const back = saturate(vsDir.z.negate().mul(4));
        // Fade the march out as it approaches its distance gate, so the tier
        // boundary is a gradient rather than a visible seam on the water.
        const tier = float(1).sub(smoothstep(u.ssrEnd.mul(0.75), u.ssrEnd, camDist));
        const w = valid.mul(edge).mul(back).mul(u.ssrStrength).mul(tier).clamp();
        reflected.assign(mix(skyColor, sceneColorTex.sample(hitUv).rgb, w));
      });
    });

    // ── What is underneath: refraction + Beer-Lambert ─────────────────────────
    // In deep water the transmittance is zero and the backbuffer tap would be
    // multiplied out, so it is skipped — which is most of the sea most of the
    // time. Nearshore it is what lets you see the sand, and that is the whole
    // difference between this and the old opaque ramp.
    const screenColor = vec3(0).toVar();
    const waterThickness = thickness.toVar();

    If(camDist.lessThan(u.refractEnd), () => {
      const depth01 = saturate(thickness.div(u.depthDistance));
      const distortion = worldN.xz.mul(u.refractionStrength.mul(mix(float(1), float(1.6), depth01)));
      const refractedUv = screenUV.add(distortion);
      const refractedDist = sceneDistAt(refractedUv).toVar();
      // Reject an offset that lands on something in FRONT of the water, or a
      // boat standing in the sea bleeds its silhouette into the surface.
      const isSafe = step(fragDist, refractedDist).toVar();
      const safeUv = mix(screenUV, refractedUv, isSafe).clamp();
      screenColor.assign(sceneColorTex.sample(safeUv).rgb);
      waterThickness.assign(mix(thickness, refractedDist.sub(fragDist).max(0), isSafe));
    });

    // Beer-Lambert, and the optical depth is NOT clamped at one `depthDistance`.
    //
    // Saturating it there — which is what the lake does, and what this did at
    // first — puts a FLOOR under transmittance: with the default sigma the blue
    // channel still passes 46% of whatever is behind the water no matter how deep
    // it gets. A lake never notices, because a lake is shallow and always has a
    // bed a few metres down. An ocean notices immediately: past the edge of the
    // terrain there is no seabed at all, so that 46% is 46% of raw sky, and the
    // open sea turns pale cyan in a hard-edged patch shaped exactly like the
    // terrain's border. Beer-Lambert has no such floor; letting the exponent run
    // (bounded only against overflow) makes deep water properly opaque, which is
    // both correct and what kills the artefact.
    const sigma = u.absorption.mul(u.absorptionScale);
    const opticalDepth = clamp(
      waterThickness.div(max(u.depthDistance, float(0.01))), float(0), float(16),
    );
    const transmittance = exp(sigma.negate().mul(opticalDepth)).toVar();
    // Nearshore turbidity: churned-up water scatters more and greener. Keyed on
    // distance to shore, so it hugs the coast rather than following bathymetry.
    const turbid = float(1).sub(smoothstep(float(0), u.turbidityReach, max(sd, float(0))));
    const inscatter = u.inscatterTint.mul(u.inscatterStrength)
      .add(u.turbidityTint.mul(u.turbidityStrength.mul(turbid)))
      // Less sun into the water column in shade: the body dims, partly.
      .mul(mix(float(1).sub(u.shadowBodyDarken), float(1), sunLit));
    const throughWater = mix(inscatter, screenColor, transmittance).toVar();

    // ── Fresnel (Schlick, F0 = 0.02) ─────────────────────────────────────────
    const cosTheta = saturate(dot(worldN, viewDir));
    const g = float(1).sub(cosTheta).toVar();
    const g2 = g.mul(g);
    const fresnel = float(0.02).add(float(0.98).mul(g2.mul(g2).mul(g))).toVar();
    const fresnelW = saturate(fresnel.mul(u.fresnelScale)).toVar();

    const body = mix(throughWater, reflected, fresnelW).toVar();

    // ── Sun specular, off a flattened normal so the glitter path spreads ──────
    const glintN = normalize(mix(vec3(0, 1, 0), flatN, u.glintSpread));
    const halfV = normalize(viewDir.add(u.sunDir));
    const NdotH = max(dot(glintN, halfV), float(0.001));
    const NdotL = max(dot(glintN, u.sunDir), float(0.0));
    // Same widening applied to the sun glint. Without it the glint keeps a
    // pinpoint lobe out to the horizon and turns into a field of flickering
    // white dots — the classic aliased-ocean look, and the one thing a player
    // notices before anything else about the water.
    const ggxAlpha = clamp(sqrt(float(2).div(u.glintPower.add(2))), float(0.01), float(1));
    const a2 = saturate(ggxAlpha.mul(ggxAlpha).add(kernelRough));
    const denom = NdotH.mul(NdotH).mul(a2.sub(1)).add(1);
    const specD = a2.mul(a2).div(denom.mul(denom));
    body.addAssign(u.sunColor.mul(specD.mul(NdotL).mul(u.glintIntensity).mul(fresnelW.add(0.15)))
      .mul(sunLit));

    // ── Subsurface scatter on thin, backlit crests ───────────────────────────
    If(u.sssEnabled.greaterThan(0), () => {
      const thin = saturate(float(1).sub(jacobian));
      const lit = saturate(dot(worldN, u.sunDir).negate());
      const toward = saturate(dot(viewDir, u.sunDir.negate()));
      const amount = lit.mul(toward).mul(float(1).add(thin.mul(2.5))).mul(u.sssIntensity).mul(sunLit);
      body.addAssign(u.sssColor.mul(amount));
    });

    // ═══ FOAM ════════════════════════════════════════════════════════════════
    /*
     * ONE PATTERN, THREE SOURCES OF COVERAGE.
     *
     * Every foam on this sea is the same material — the domain-warped Voronoi
     * FBM, eroded by a coverage-driven threshold — and only COVERAGE differs by
     * where the foam comes from:
     *
     *   surf     — the travelling breaker, its wake, and the lace at the edge
     *              (metres along the ground, from the shore field)
     *   whitecap — open-sea crests folding over (the FFT's persistent fold
     *              trail), streaked along the wind
     *   contact  — water thinner than a hand's depth over ANY geometry: rocks
     *              just under the surface, pier legs, hulls, a cliff foot —
     *              read straight off the depth buffer, no authoring
     *
     * The whitecaps used to be their own single Voronoi octave with no warp.
     * One octave cannot tear, so a high coverage filled whole cells: flat white
     * shapes with smooth edges — the "paper cutout" blobs. Sharing the surf
     * pattern gives them the same fractal edge, and the same erosion makes them
     * age the same way: sheet → lace → flecks.
     *
     * All three coverages are cheap arithmetic up here; the pattern (the
     * expensive part) runs once, in a branch, only where some coverage exists.
     */
    const foam = float(0).toVar();
    const foamShade = float(1).toVar();

    // Falls off over most of the surf zone rather than sitting at full strength
    // out to a cliff edge at `surfReach`: foam belongs densest at the shore and
    // thinning seaward, with only the crest line reaching the outer edge.
    const surfBand = float(1).sub(smoothstep(u.surfReach.mul(0.22), u.surfReach, max(sd, float(0))));
    const nearEdge = float(1).sub(smoothstep(u.edgeWidth, u.edgeWidth.mul(3), abs(sdEff)));
    const foamWanted = max(surfBand.mul(u.surfEnabled), nearEdge).mul(u.foamEnabled).toVar();

    const windDir = vec2(cos(u.windAngle), sin(u.windAngle)).toVar();

    // ── Whitecap coverage ────────────────────────────────────────────────────
    // `jacobian` is the FFT's persistent fold trail (it snaps down when a crest
    // folds and recovers at `fftFoamDecay`), so this is a crest AND its wake.
    // Gated on distance FROM SHORE, not on the surf band: waves steepen most as
    // they shoal, so an ungated term fires hardest exactly where the surf model
    // already draws foam and the two sum into an even white mat.
    //
    // SHAPED BY A POWER CURVE, and this is what makes it lace rather than a
    // blob. Erosion only draws filaments where coverage sits mid-range; full
    // coverage passes the whole pattern and draws a solid sheet. The surf gets
    // that for free — only its crest LINE is full, the wide wake behind it is
    // mid. A fold's coverage is a wide dome that is near-full over most of its
    // area, so unshaped it eroded into solid white shapes. Raised to a power,
    // only the fold's core reaches a sheet and the rest of the dome falls into
    // the lace range.
    const wcCover = pow(smoothstep(
      u.whitecapThreshold, u.whitecapThreshold.add(u.whitecapSoftness),
      saturate(float(1).sub(jacobian)),
    ), max(u.whitecapCoreSharpness, float(0.1))).mul(u.whitecapIntensity)
      .mul(smoothstep(u.surfReach, u.surfReach.mul(2.5), max(sd, float(0))))
      .mul(u.whitecapEnabled)
      .toVar();

    // ── Contact coverage ─────────────────────────────────────────────────────
    // `thickness` runs along the view ray; times the ray's steepness it is the
    // VERTICAL depth of water over whatever the ray hits next. Shallower than
    // `contactFoamWidth` = foam. That is a ring hugging every object that
    // pierces the surface, and a skin over rocks just below it. Faded out with
    // distance, where depth precision cannot tell a hand's depth from a metre.
    const contactDepth = thickness.mul(max(abs(viewDir.y), float(0.05))).toVar();
    // Square root: dense right against the object, thinning only near the
    // band's outer edge. A linear ramp left most of the ring at mid coverage,
    // which the erosion turns into a few specks.
    const contactCover = sqrt(float(1).sub(smoothstep(float(0), max(u.contactFoamWidth, float(0.01)), contactDepth)))
      .mul(float(1).sub(smoothstep(u.contactFoamEnd.mul(0.6), u.contactFoamEnd, fragDist)))
      // A slow surge, so the ring breathes instead of sitting painted on.
      .mul(sin(u.time.mul(1.7).add(dot(wXZ, windDir).mul(0.35))).mul(0.2).add(0.8))
      .mul(u.contactFoamIntensity).mul(u.contactFoamEnabled)
      .toVar();

    const anyFoam = max(foamWanted, max(wcCover, contactCover)).toVar();

    /*
     * How many metres of ground one pixel covers here, measured rather than
     * guessed — the number the pattern LOD needs. Taken OUT HERE because WGSL
     * only allows derivatives under uniform control flow and the pattern below
     * is branched on a per-fragment value.
     *
     * `foamLod` is the octave index at which a Voronoi cell has shrunk to
     * `foamLodPixels` pixels: octave k has cells 1/(scale·2^k) metres across.
     */
    const mPerPx = max(fwidth(wXZ.x), fwidth(wXZ.y)).toVar();
    const baseCellM = float(1).div(max(u.foamNoiseScale, float(1e-4)));
    const foamLod = log2(
      max(baseCellM.div(max(mPerPx.mul(u.foamLodPixels), float(1e-5))), float(1)),
    ).toVar();

    If(anyFoam.greaterThan(0.002), () => {
      // Steep bed → plunging breaker: a tight, bright line that dies fast.
      // Shallow bed → spilling: wide, soft, long-lived.
      const steep = saturate(slope.mul(u.slopeGain)).toVar();
      const sharp = mix(u.crestSharpness.mul(0.45), u.crestSharpness, steep);
      const decay = mix(u.foamDecay.mul(0.6), u.foamDecay, steep);

      /*
       * ── THE PATTERN ───────────────────────────────────────────────────────
       * Domain-warped Worley FBM in PLAIN WORLD SPACE, advected along the WIND
       * (one constant vector: a pure translation, which cannot shear the noise
       * the way a per-fragment offshore direction did), contrast, then the soft
       * threshold below. What matters, each learned the hard way:
       *  - five octaves, because foam's edge is fractal down to the pixel;
       *  - a high-frequency WEAK warp (3.0 / 0.6) that jitters cells, not a
       *    strong low one that bends boundaries into fingerprints;
       *  - a real threshold shoulder, or thin foam is absent instead of thin.
       */
      const drift = windDir.mul(u.time.mul(u.foamDrift));
      const base = wXZ.add(drift).mul(u.foamNoiseScale).toVar();
      const warpP = base.mul(u.foamWarpScale);
      const warp = vec2(_warpFbm(warpP).sub(0.5), _warpFbm(warpP.add(vec2(4, 4))).sub(0.5));
      const wp = base.add(warp.mul(u.foamWarpStrength)).toVar();
      const nRaw = _worleyFbmLod(wp, u.foamJitter, foamLod).toVar();
      const shaped = pow(saturate(nRaw.mul(u.foamGain)), u.foamContrast).toVar();

      const detFade = float(1).sub(smoothstep(u.foamDetailNear, u.foamDetailFar, camDist)).toVar();

      // ── Surf coverage ─────────────────────────────────────────────────────
      const ph = surfPhase(wXZ, sd).toVar();
      const age = fract(ph).toVar();
      const crest = pow(saturate(sin(ph.mul(float(TWO_PI)))), sharp)
        .mul(u.crestIntensity).mul(surfBand).mul(u.surfEnabled).toVar();
      const wake = pow(saturate(float(1).sub(age)), decay)
        .mul(u.foamWakeIntensity).mul(surfBand).mul(u.surfEnabled);
      const edge = nearEdge.mul(u.edgeIntensity);
      const surfCover = max(crest, max(wake, edge)).mul(u.foamEnabled);

      /*
       * ── THE MACRO FIELD ──────────────────────────────────────────────────
       * One warped Voronoi octave at ~33 m drifting on the wind, folded into
       * COVERAGE rather than into the pattern: a low-macro patch does not get
       * dimmer foam, it gets foam torn open and then none. It is the scale that
       * gives sheets and gaps instead of one even ribbon, and it now breaks the
       * whitecaps up the same way — a sea does not foam uniformly either.
       */
      const macroBase = wXZ.add(windDir.mul(u.time.mul(u.foamMacroDrift))).mul(u.foamMacroScale);
      const macroWarp = vec2(
        _warpFbm(macroBase.mul(1.9)).sub(0.5),
        _warpFbm(macroBase.mul(1.9).add(vec2(11, 7))).sub(0.5),
      );
      const macroP = macroBase.add(macroWarp.mul(0.75)).toVar();
      const macroRaw = float(1).sub(_worleyF1(macroP, u.foamJitter)).toVar();
      const macro = saturate(macroRaw.sub(0.35).mul(1.7).add(0.5)).toVar();
      const macroMod = mix(float(1), macro, u.foamMacroAmt).toVar();

      /*
       * ── WIND STREAKS ─────────────────────────────────────────────────────
       * Whitecap foam is dragged downwind into long streaks. A value noise in
       * the WIND's frame — long along it, tight across it — modulates whitecap
       * coverage. The frame is one constant rotation for the whole sea, so the
       * field stays smooth (unlike a per-fragment frame, which whorls).
       */
      const along = dot(wXZ, windDir);
      const across = dot(wXZ, vec2(windDir.y.negate(), windDir.x));
      const sq = vec2(
        along.mul(u.whitecapStreakScale.mul(0.12)).sub(u.time.mul(0.05)),
        across.mul(u.whitecapStreakScale),
      );
      const streak = _vnoise2(sq).mul(0.65).add(_vnoise2(sq.mul(2.3).add(vec2(17, 3))).mul(0.35));
      const streakMod = mix(float(1), saturate(streak.mul(1.8).sub(0.25)), u.whitecapStreak);

      const cover = saturate(max(
        surfCover.mul(macroMod),
        max(wcCover.mul(macroMod).mul(streakMod), contactCover),
      )).toVar();

      /*
       * ── EROSION, not fading ───────────────────────────────────────────────
       * Coverage drives the THRESHOLD, not the brightness. Full coverage passes
       * most of the field (a sheet); as coverage drops the threshold climbs and
       * only the densest cores survive, so foam breaks into filaments and then
       * flecks before it goes — whichever source laid it down.
       */
      const thr = mix(float(0.985), u.foamCutoff, pow(cover, u.foamErode)).toVar();
      const eroded = smoothstep(thr, thr.add(max(u.foamTransition, float(0.01))), shaped).toVar();

      /*
       * ── BUBBLES ──────────────────────────────────────────────────────────
       * The pattern's octaves halve in weight, so below about a metre it has
       * almost no structure left: seen from a few metres, a whitecap or a
       * patch of surf is a smooth solid shape. What real foam has at that
       * scale is bubbles — dark holes, tens of centimetres across, that grow
       * as the foam thins until only their rims are left.
       *
       * One small Voronoi octave: F1 is ~0 at a cell's centre, so a threshold
       * on it punches a hole there and keeps the rim. The hole radius follows
       * coverage — tiny in a fresh sheet, wide in old foam — so foam ages into
       * bubbly lace instead of merely shrinking. Faded out once a bubble is
       * under ~3 px, which is also what leaves the far foam exactly as it was.
       */
      // Bubbles grow as coverage falls: pinholes in a fresh sheet, merged gaps
      // in old foam. Two sizes at unrelated scales so the spacing never reads
      // as a grid.
      const grow = float(1).sub(cover).mul(0.8).add(0.2);
      const bubbleP = wXZ.add(drift).mul(u.foamBubbleScale).add(warp.mul(0.8)).toVar();
      const bigB = _bubbleSdf(bubbleP, grow.mul(0.05), grow.mul(0.42));
      const smallB = _bubbleSdf(bubbleP.mul(2.37).add(vec2(5.1, 9.7)), grow.mul(0.0), grow.mul(0.3));
      const inBubble = min(bigB, smallB.mul(0.42));      // small field in big-cell units
      const holes = smoothstep(float(-0.02), float(0.06), inBubble);
      const bubbleVisible = saturate(float(1.5).sub(mPerPx.mul(u.foamBubbleScale).mul(3)));
      eroded.mulAssign(mix(float(1), holes, bubbleVisible.mul(u.foamBubbles)));

      // Past resolvable detail, converge on the eroded field's area average,
      // which `cover` already is.
      foam.assign(saturate(mix(cover.mul(u.foamFarDensity), eroded, detFade)));

      // Thin lace lets water through and sits in its own shadow; only the dense
      // cores are paper white.
      foamShade.assign(mix(float(0.7), float(1.0), saturate(eroded.mul(1.15).add(0.1))));
    });

    /*
     * ── FOAM RELIEF ──────────────────────────────────────────────────────────
     * Foam is a layer of bubbles standing proud of the water, and its edges
     * catch the sun. Treat the finished foam amount as a height and bump the
     * normal with its screen-space derivatives (Mikkelsen's surface gradient):
     * free — no second evaluation of the pattern — and exactly as detailed as
     * the pattern on screen.
     *
     * Out HERE, after the branch closes, because derivatives need uniform
     * control flow; `foam` is only a value by now. Faded with distance: past a
     * pixel's worth of pattern the derivatives are noise, not relief.
     */
    const reliefFade = float(1).sub(smoothstep(u.foamReliefEnd.mul(0.5), u.foamReliefEnd, camDist));
    const foamH = foam.mul(u.foamRelief).mul(reliefFade).toVar();
    const dpdxW = dFdx(positionWorld).toVar();
    const dpdyW = dFdy(positionWorld).toVar();
    const dhdx = dFdx(foamH);
    const dhdy = dFdy(foamH);
    const r1 = cross(dpdyW, worldN);
    const r2 = cross(worldN, dpdxW);
    const det = dot(dpdxW, r1);
    const surfGrad = r1.mul(dhdx).add(r2.mul(dhdy)).mul(sign(det));
    const foamN = normalize(worldN.mul(abs(det)).sub(surfGrad)).toVar();

    // Foam is LIT, not a flat white decal: a dense scattering medium with a
    // light side and a shaded side. Wrapped diffuse (half-Lambert), because it
    // scatters so much that even the side facing away from the sun is far from
    // black — on the bumped normal, so the relief reads.
    const foamLit = saturate(dot(foamN, u.sunDir).mul(0.5).add(0.5));
    const foamCol = u.foamColor
      .mul(foamShade)
      .mul(mix(float(1), u.sunColor.mul(mix(float(0.62), float(1.15), foamLit)), u.foamSunLit))
      .mul(mix(float(1).sub(u.shadowFoamDarken), float(1), sunLit));
    const withFoam = mix(body, foamCol, foam).toVar();

    // ── Wet sand behind the backwash ─────────────────────────────────────────
    // Not a decal and not a second material: the same sheet, gone almost
    // transparent, darkening what it lies on and adding a low gloss. It is the
    // cheapest part of this file and does more for the coast than anything but
    // the run-up itself.
    const wetSheen = u.sunColor.mul(specD.mul(u.wetGloss)).mul(sunLit);
    const wetLook = mix(screenColor.mul(float(1).sub(u.wetDarken.mul(0.6))).add(wetSheen),
      withFoam, saturate(foam.add(0.15)));
    const shaded = mix(withFoam, wetLook, isWetSand.mul(float(1).sub(wetT))).toVar();

    // ── Shoreline softening ──────────────────────────────────────────────────
    // A hard Discard removes what is truly over land; the last few centimetres
    // fade into the backbuffer so the edge is not a stair-stepped line.
    const alpha = saturate(waterThickness.div(0.12))
      .mul(saturate(sdEff.add(u.wetFade).div(max(u.wetFade, float(0.01)))))
      .toVar();
    const composited = mix(screenColor, shaded, alpha).toVar();

    // ── Horizon ──────────────────────────────────────────────────────────────
    const hf = smoothstep(u.horizonFadeStart, u.horizonFadeEnd, camDist);
    const skyAhead = analyticSky(normalize(vec3(
      positionWorld.x.sub(cameraPosition.x),
      max(positionWorld.y.sub(cameraPosition.y), float(0.02)),
      positionWorld.z.sub(cameraPosition.z),
    )));
    const aboveWater = mix(composited, skyAhead, hf).toVar();

    /*
     * ── SEEN FROM BELOW: SNELL'S WINDOW ──────────────────────────────────────
     * From under the water the surface is two different things depending on
     * the angle. Inside ~48.6° of the normal, light gets OUT: you see the whole
     * sky squeezed into a bright disc. Past it, total internal reflection: the
     * surface is a perfect mirror of the water beneath it, i.e. dim blue. That
     * hard ring is the single thing that makes a shot read as underwater, and it
     * is free here — no extra draw, one refract and one environment tap.
     *
     * The water between the camera and this fragment is NOT applied here.
     * oceanUnderwater.js hazes every pixel by its distance afterwards, the
     * surface included, so doing it twice would bury the window.
     *
     * Back faces only, AND only where this bit of surface is ABOVE the camera.
     * Choppy waves fold their crests over, so from above the water you do see
     * back faces — on every steep crest in a rough sea. Gating on "camera within
     * a few metres of sea level" (the first version) let those folds light up
     * as bright sky discs whenever the camera was low, which in a storm meant
     * large flat white shapes on every wave. A fold seen from above is below
     * the camera; the underside of the sea seen from beneath is above it.
     */
    const below = step(faceDirection, float(0))
      .mul(step(cameraPosition.y, positionWorld.y)).toVar();

    const nDown = worldN.negate().toVar();
    const rayUp = viewDir.negate().toVar();            // camera → surface
    const cosI = saturate(dot(viewDir, nDown)).toVar();
    const eta = float(1.333);
    const k = float(1).sub(eta.mul(eta).mul(float(1).sub(cosI.mul(cosI)))).toVar();
    const tir = step(k, float(0)).toVar();              // 1 = total internal reflection
    const cosT = sqrt(max(k, float(0))).toVar();
    // refract(I, N, η) with N facing against I, written out so the TIR case is
    // an explicit, blendable number rather than a zero vector to normalise.
    const transDir = normalize(mix(
      rayUp.mul(eta).add(nDown.mul(eta.mul(cosI).sub(cosT))),
      vec3(0, 1, 0), tir,
    )).toVar();
    // Water → air Fresnel is Schlick on the TRANSMITTED angle; TIR is 1.
    const oneMinusT = float(1).sub(cosT);
    const fT = float(0.02).add(float(0.98).mul(pow(oneMinusT, float(5))));
    const fUnder = mix(fT, float(1), tir).toVar();

    const windowSky = mix(
      analyticSky(transDir),
      envTap(transDir, envRough).mul(u.envIntensity),
      saturate(u.envReflect.mul(u.envPresent)),
    ).mul(u.uwWindowSky);
    // The sun through the window: a hard disc and a soft aureole around it.
    const sunCos = saturate(dot(transDir, u.sunDir));
    const sunThrough = u.sunColor.mul(
      pow(sunCos, float(1200)).mul(6).add(pow(sunCos, float(40)).mul(0.25)),
    ).mul(u.glintIntensity).mul(float(1).sub(tir)).mul(sunLit);

    // The mirror half: radiance of the water column looking DOWN from the
    // surface — the same closed form oceanUnderwater.js integrates, at depth 0
    // and infinite length, which reduces to L / (1 - dir.y).
    const mirrorDir = reflect(rayUp, nDown);
    const lightIn = u.uwLightAmb.add(u.uwLightSun);
    const waterBelow = u.uwScatterColor.mul(lightIn)
      .div(max(float(1).sub(mirrorDir.y), float(1)));

    const under = mix(windowSky.add(sunThrough), waterBelow, fUnder).toVar();
    // Foam blocks the window: from below it is a dim, sun-lit diffuse sheet.
    under.assign(mix(under, u.foamColor.mul(lightIn).mul(0.45), foam));

    return vec4(mix(aboveWater, under, below), u.opacity);
  });

  // ── Material ───────────────────────────────────────────────────────────────
  const frag = oceanColor();
  const material = new MeshBasicNodeMaterial({
    transparent: false,   // see the compositing note in the header
    depthWrite: true,
    depthTest: true,
    side: THREE.DoubleSide,
    colorNode: frag.rgb,
    opacityNode: frag.a,
    positionNode: oceanPosition(),
  });
  material.name = "OceanSurfaceV2";
  material.fog = true;

  // ── Params ─────────────────────────────────────────────────────────────────
  const NUM_KEYS = [
    "absorptionScale", "depthDistance", "inscatterStrength", "turbidityStrength",
    "turbidityReach", "refractionStrength", "refractEnd", "skyReflectIntensity",
    "skySunGlow", "skySunGlowSize", "fresnelScale", "ssrStrength", "ssrMaxDistance",
    "ssrThickness", "ssrEdgeFade", "ssrEnd", "glintIntensity", "glintPower",
    "glintSpread", "sssIntensity", "fftSwellAmp", "fftRippleAmp", "fftNormalStrength",
    "dispFadeStart", "dispFadeEnd", "fftEnd", "shoalDistance", "shoalPeak",
    "normalTiling", "normalStrength", "normalFlowSpeed", "detailEnd",
    "whitecapIntensity", "whitecapThreshold", "whitecapSoftness",
    "whitecapStreak", "whitecapStreakScale", "whitecapCoreSharpness",
    "contactFoamWidth", "contactFoamIntensity", "contactFoamEnd", "foamRelief", "foamReliefEnd",
    "foamBubbles", "foamBubbleScale",
    "surfHz", "surfLength", "surfReach", "surfAlongShore", "crestSharpness",
    "crestIntensity", "foamDecay", "foamWakeIntensity", "slopeGain",
    "runupReach", "runupRush", "runupShape", "runupMaxSlope", "filmThickness",
    "runupNearEnd", "runupFarEnd", "wetFade", "wetDarken", "wetGloss",
    "foamSunLit", "edgeWidth", "edgeIntensity", "foamNoiseScale", "foamJitter", "foamWarpScale",
    "foamWarpStrength", "foamGain", "foamContrast", "foamErode",
    "envReflect", "envIntensity", "waterRoughness", "specAA", "specAAMax",
    "foamCutoff", "foamTransition", "foamDrift", "foamDetailNear", "foamDetailFar", "foamFarDensity",
    "foamMacroScale", "foamMacroAmt", "foamMacroDrift", "foamLodPixels",
    "horizonFadeStart", "horizonFadeEnd", "opacity",
    "uwDensity", "uwSunGlow", "uwSunGlowG", "uwWindowSky", "uwActiveBand",
    "uwLineWidth", "uwLineDarken", "uwLineDistort",
    "uwSnowSize", "uwSnowIntensity", "uwSnowBox",
    "uwShaftIntensity", "uwShaftDistance", "uwShaftScale", "uwShaftSharpness", "uwShaftSpeed",
    "shadowBodyDarken", "shadowFoamDarken",
  ];
  const BOOL_KEYS = [
    "fftEnabled", "sssEnabled", "whitecapEnabled", "surfEnabled",
    "runupEnabled", "foamEnabled", "ssrEnabled", "uwShaftsEnabled", "shadowsEnabled",
    "contactFoamEnabled",
  ];
  const COLOR_KEYS = [
    "inscatterTint", "turbidityTint", "skyZenithColor", "skyHorizonColor",
    "sunColor", "sssColor", "foamColor", "uwScatterColor",
  ];

  function syncParams(p) {
    if (!p) return;
    for (const k of NUM_KEYS) if (p[k] != null) u[k].value = p[k];
    for (const k of BOOL_KEYS) if (p[k] != null) u[k].value = p[k] ? 1 : 0;
    for (const k of COLOR_KEYS) if (p[k] != null) u[k].value.set(p[k]);
    if (p.absorption != null) u.absorption.value.set(...p.absorption);
    if (p.uwExtinction != null) u.uwExtinction.value.set(...p.uwExtinction);
    if (p.windAngleDeg != null) u.windAngle.value = p.windAngleDeg * DEG2RAD;
    if (p.skyHorizonSpread != null) {
      u.skyHorizonSpread.value = Math.sin(p.skyHorizonSpread * DEG2RAD);
    }
    if (p.seaLevel != null) u.waterY.value = p.seaLevel;
  }

  return {
    material,
    uniforms: u,
    /**
     * The surface's own sampling, for oceanUnderwater.js. Handing these over
     * rather than re-deriving them is what keeps the waterline on the lens and
     * the wave mesh in the same place: same cascades, same amplitudes, same
     * shoaling, same field UVs.
     */
    helpers: { waterHeightAt, shoreAt, terrainYAt },
    syncParams,
    update(dt, elapsed) { u.time.value = elapsed; },
    /**
     * Receive the sun's shadow: its shadow node (the editor's CSMShadowNode, or
     * a light's `shadow.shadowNode`), or null for none. Rebuilds the colour
     * graph — one pipeline compile — so call it when the node CHANGES (shadows
     * toggled), not per frame; it no-ops when handed the node it already has.
     */
    setShadowNode(node) {
      const next = node ?? null;
      if (next === _sunShadowNode) return;
      _sunShadowNode = next;
      const f = oceanColor();
      material.colorNode = f.rgb;
      material.opacityNode = f.a;
      material.needsUpdate = true;
    },
    setSunDir(v) { if (v) u.sunDir.value.copy(v).normalize(); },
    /** Host-supplied sky, so the reflection matches the sky actually in frame. */
    setSky({ zenith, horizon, sun } = {}) {
      if (zenith) u.skyZenithColor.value.copy(zenith);
      if (horizon) u.skyHorizonColor.value.copy(horizon);
      if (sun) u.sunColor.value.copy(sun);
    },
    /**
     * Point the reflection at the scene's environment map, or null to fall back
     * to the analytic sky. Cheap enough to call every frame — it no-ops unless
     * the texture identity actually changed.
     */
    setEnvMap(tex) {
      const next = tex ?? null;
      if (next === _envTexture) return;
      _envTexture = next;
      u.envPresent.value = next ? 1 : 0;
      for (const n of _envNodes) n.value = next ?? envPlaceholder();
    },
    dispose() { material.dispose(); },
  };
}
