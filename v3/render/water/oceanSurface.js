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
  mix, smoothstep, step, dot, exp, pow, max, min, abs, saturate, clamp,
  floor, fract, sin, cos, sqrt, length, round, Loop, attribute,
  normalize, reflect, texture, positionLocal, positionWorld, positionView,
  modelWorldMatrix, cameraPosition, cameraNear, cameraFar,
  cameraViewMatrix, cameraProjectionMatrix, screenUV,
  viewportDepthTexture, viewportSharedTexture, perspectiveDepthToViewZ,
} from "three/tsl";

const TWO_PI = 6.283185307179586;
const DEG2RAD = Math.PI / 180;

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

/** 2-octave value FBM — only ever used to domain-warp the foam, where a third
 *  octave changes nothing you can see. */
const _warpFbm = /*#__PURE__*/ Fn(([p_immutable]) => {
  const p = p_immutable.toVar();
  const v = float(0).toVar();
  const a = float(1).toVar();
  const t = float(0).toVar();
  Loop(2, () => {
    v.addAssign(a.mul(_vnoise2(p)));
    t.addAssign(a);
    p.assign(p.mul(2.3));
    a.assign(a.mul(0.45));
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
 * 4-octave Voronoi (Worley F1) FBM — the foam pattern.
 *
 * NOT inverted: F1 is small at cell centres and large at the boundaries, so the
 * high values form the NETWORK BETWEEN cells. That web is what makes foam read
 * as foam — a connected, ragged mesh of filaments with holes in it — where the
 * inverted form gives disconnected blobs, and where stretching it anisotropically
 * (tried, discarded) gives parallel brush strokes.
 *
 * 4 octaves rather than the old ocean's 5: the lake recorded that the 5th is
 * invisible at a shoreline, but 3 loses the fine lace once a domain warp is
 * pulling the coarse octaves around. 36 hashes vs 45.
 */
const _worleyFbm = /*#__PURE__*/ Fn(([p_immutable, jitter]) => {
  const p = p_immutable.toVar();
  const v = float(0).toVar();
  const a = float(0.5).toVar();
  const t = float(0).toVar();
  Loop(3, () => {
    v.addAssign(a.mul(_worleyF1(p, jitter)));
    t.addAssign(a);
    p.assign(p.mul(2.0));
    a.assign(a.mul(0.5));
  });
  return v.div(max(t, float(1e-4)));
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
  whitecapThreshold: 0.68,
  whitecapSoftness: 0.26,
  /** Voronoi cells per metre for the whitecap breakup. Coarser than the surf
   *  foam because whitecaps are seen from much further away. */
  whitecapScale: 0.16,

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
  foamNoiseScale: 0.55,
  /** 1 = fully random cell points, 0 = a regular grid (and it looks like one). */
  foamJitter: 1.0,
  /** Domain warp: frequency, then how hard it pushes. The warp is what stops the
   *  Voronoi reading as a grid, so `foamWarpStrength` near 1 is not optional. */
  foamWarpScale: 0.5,
  foamWarpStrength: 1.0,
  /** Second Voronoi field, as a multiple of the first, and how much of it rides
   *  on the coarse one. This is what puts holes and clumping in the filaments. */
  foamFineScale: 3.4,
  foamFineAmt: 0.70,
  /** Stretches the summed Voronoi field to fill 0..1. Without it the field sits
   *  around 0.35 and every threshold knob below is unusable — see the note at
   *  the point of use. */
  foamGain: 2.1,
  /** Shapes the web: >1 thins the filaments, <1 fattens them. */
  foamContrast: 1.35,
  /**
   * Erosion curve. Coverage sets a THRESHOLD on the noise field rather than
   * scaling the foam's opacity, so ageing foam breaks into filaments and flecks
   * instead of politely fading out. Higher = it holds together longer and then
   * shatters late.
   */
  foamErode: 2.0,
  /**
   * The threshold at FULL coverage, in the gain-normalised field's own units.
   * Low is a solid white sheet with round holes punched in it (which is what it
   * looks like, and not what foam looks like); around 0.6 leaves a connected web
   * with roughly half the area open, which is the target. Above ~0.75 even a
   * breaking crest is only flecks.
   */
  foamCutoff: 0.60,
  /** Softness of that threshold. Small keeps foam edges crisp — foam does not
   *  have soft edges, it has torn ones. */
  foamTransition: 0.13,
  /** Between these the foam stops being a thresholded field and becomes its own
   *  area average — cells are sub-pixel past here, and thresholding something
   *  you cannot resolve is how procedural foam turns into crawling sparkle. */
  foamDetailNear: 70,
  foamDetailFar: 190,
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

  // ── Underwater ─────────────────────────────────────────────────────────────
  underwaterMurk: 0.45,

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
}) {
  const D = OCEAN2_DEFAULTS;
  const u = {};

  u.time = uniform(0);
  u.waterY = uniform(D.seaLevel);

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
  u.whitecapScale = uniform(D.whitecapScale);

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
  u.foamJitter = uniform(D.foamJitter);
  u.foamWarpScale = uniform(D.foamWarpScale);
  u.foamWarpStrength = uniform(D.foamWarpStrength);
  u.foamFineScale = uniform(D.foamFineScale);
  u.foamFineAmt = uniform(D.foamFineAmt);
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

  u.underwaterT = uniform(0);
  u.underwaterMurk = uniform(D.underwaterMurk);
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

  function fftDispAt(xz, ampScale) {
    if (!fftCascades.length) return vec3(0);
    let sum = vec3(0);
    fftCascades.forEach((c, i) => {
      sum = sum.add(texture(c.dispTex, xz.div(c.tileSize)).level(0).xyz.mul(ampForCascade(i)));
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
    const disp = fftDispAt(worldXZ, amp).toVar();

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

    // ── Reflection ───────────────────────────────────────────────────────────
    const reflectDir = reflect(viewDir.negate(), worldN).toVar();
    const skyColor = analyticSky(reflectDir).mul(u.skyReflectIntensity).toVar();
    const reflected = skyColor.toVar();

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
      .add(u.turbidityTint.mul(u.turbidityStrength.mul(turbid)));
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
    const ggxAlpha = clamp(sqrt(float(2).div(u.glintPower.add(2))), float(0.01), float(1));
    const a2 = ggxAlpha.mul(ggxAlpha);
    const denom = NdotH.mul(NdotH).mul(a2.sub(1)).add(1);
    const specD = a2.mul(a2).div(denom.mul(denom));
    body.addAssign(u.sunColor.mul(specD.mul(NdotL).mul(u.glintIntensity).mul(fresnelW.add(0.15))));

    // ── Subsurface scatter on thin, backlit crests ───────────────────────────
    If(u.sssEnabled.greaterThan(0), () => {
      const thin = saturate(float(1).sub(jacobian));
      const lit = saturate(dot(worldN, u.sunDir).negate());
      const toward = saturate(dot(viewDir, u.sunDir.negate()));
      const amount = lit.mul(toward).mul(float(1).add(thin.mul(2.5))).mul(u.sssIntensity);
      body.addAssign(u.sssColor.mul(amount));
    });

    // ═══ FOAM ════════════════════════════════════════════════════════════════
    // Three contributions, all in metres along the ground:
    //   crest — the breaking line, travelling shoreward
    //   wake  — what the crest left behind, decaying until the next one
    //   edge  — the permanent lace at the water's edge, which moves with it
    // and one Worley field breaking all three up. The whole block is branched
    // out beyond the surf zone, which offshore is almost the entire ocean.
    const foam = float(0).toVar();
    const foamShade = float(1).toVar();

    // Falls off over most of the surf zone rather than sitting at full strength
    // out to a cliff edge at `surfReach`. A plateau put an even sheet of foam
    // across the whole zone the instant a crest passed; foam belongs densest at
    // the shore and thinning seaward, with only the crest line reaching the
    // outer edge.
    const surfBand = float(1).sub(smoothstep(u.surfReach.mul(0.22), u.surfReach, max(sd, float(0))));
    const nearEdge = float(1).sub(smoothstep(u.edgeWidth, u.edgeWidth.mul(3), abs(sdEff)));
    const foamWanted = max(surfBand.mul(u.surfEnabled), nearEdge).mul(u.foamEnabled).toVar();

    If(foamWanted.greaterThan(0.002), () => {
      // Steep bed → plunging breaker: a tight, bright line that dies fast.
      // Shallow bed → spilling: wide, soft, long-lived. One number from the
      // shore field, and the coast stops looking uniform.
      const steep = saturate(slope.mul(u.slopeGain)).toVar();
      const sharp = mix(u.crestSharpness.mul(0.45), u.crestSharpness, steep);
      const decay = mix(u.foamDecay.mul(0.6), u.foamDecay, steep);

      // ── Domain-warped Voronoi FBM ─────────────────────────────────────────
      // The classic, and the reason it works: a plain Voronoi is visibly a grid
      // of cells, and no amount of octaves hides the regularity. Pushing the
      // lookup around with a value-noise FBM first destroys the grid and leaves a
      // ragged, organic web — that warp is doing as much for the look as the
      // Voronoi is. `foamDrift` scrolls it offshore, in the shore field's own
      // direction, so the backwash pulls correctly in every bay.
      const drift = offDir.mul(u.time.mul(u.foamDrift));
      const base = wXZ.add(drift).mul(u.foamNoiseScale).toVar();

      const warpP = base.mul(u.foamWarpScale);
      const warp = vec2(_warpFbm(warpP).sub(0.5), _warpFbm(warpP.add(vec2(4, 4))).sub(0.5));
      const wp = base.add(warp.mul(u.foamWarpStrength)).toVar();

      // Two Voronoi FBMs at different scales, SUMMED — not multiplied.
      //
      // Multiplying them was wrong and wrong in an instructive way. A Worley F1
      // FBM does not live in 0..1: normalised by its own amplitude it centres
      // around ~0.35 with most of its mass in 0.15..0.55. Multiply two of those
      // and the product centres near 0.12 with a range of a tenth — so the
      // erosion threshold, which is a number in 0..1, goes from "passes
      // everything" to "kills everything" over about 0.05 of slider travel, and
      // there is no setting in between. Summing preserves the distribution;
      // `foamGain` then stretches it to fill 0..1 so the threshold means what it
      // says and the sliders are usable.
      // Coarse is the 3-octave FBM; FINE IS A SINGLE OCTAVE. Two full FBMs was
      // 72 hashes and measured as the only place the new ocean is dearer than the
      // old one (2.36 vs 2.10 ms with the screen full of surf zone). The fine
      // field's whole job is to put holes and clumping into the coarse web, and
      // its own upper octaves are far below a pixel by the time they would
      // matter — so one octave does the job for 9 hashes instead of 27.
      const coarse = _worleyFbm(wp, u.foamJitter).toVar();
      const fine = _worleyF1(wp.mul(u.foamFineScale).add(vec2(17.3, 5.1)), u.foamJitter).toVar();
      const mixed = mix(coarse, coarse.mul(0.55).add(fine.mul(0.45)), u.foamFineAmt);
      const combined = pow(saturate(mixed.mul(u.foamGain)), u.foamContrast).toVar();

      // Past a few tens of metres a cell is under a pixel, and thresholding a
      // sub-pixel field is exactly how you manufacture sparkle. Fade the detail
      // toward flat so distant foam becomes smooth coverage instead of speckle.
      const detFade = float(1).sub(smoothstep(u.foamDetailNear, u.foamDetailFar, camDist)).toVar();
      const detail = combined.toVar();

      const ph = surfPhase(wXZ, sd).toVar();
      const age = fract(ph).toVar();

      // Crest: a thin bright arc where the phase peaks.
      const crest = pow(saturate(sin(ph.mul(float(TWO_PI)))), sharp)
        .mul(u.crestIntensity).mul(surfBand).mul(u.surfEnabled).toVar();

      // Wake: laid down as the crest passes, decaying over the rest of the cycle.
      const wake = pow(saturate(float(1).sub(age)), decay)
        .mul(u.foamWakeIntensity).mul(surfBand).mul(u.surfEnabled);

      // Edge lace at the moving waterline.
      const edge = nearEdge.mul(u.edgeIntensity);

      // ── EROSION, not fading ───────────────────────────────────────────────
      // Coverage does not scale the foam's brightness — it drives a THRESHOLD.
      // Full coverage passes almost the whole field (a solid sheet at the
      // breaking crest); as the wake ages and coverage drops, the threshold
      // climbs and only the densest cores survive, so the sheet breaks up into
      // filaments and then into scattered flecks before it goes.
      //
      // That is what foam actually does, and it is the difference between foam
      // and a white shape getting more transparent. Same mechanism as the drift
      // smoke's rising erosion threshold.
      const cover = saturate(max(crest, max(wake, edge))).toVar();
      const thr = mix(float(0.985), u.foamCutoff, pow(cover, u.foamErode)).toVar();
      const eroded = smoothstep(thr, thr.add(max(u.foamTransition, float(0.01))), detail);

      // ── Distance: stop thresholding, start averaging ──────────────────────
      // Past a few tens of metres a Voronoi cell is smaller than a pixel, and
      // thresholding a field you cannot resolve is precisely how procedural foam
      // turns into crawling sparkle. Fading the FIELD toward a constant does not
      // work either — whichever constant you pick sits on one side of the
      // threshold, so distant foam either vanishes or goes solid. What is
      // actually wanted is the area average of the eroded field, and `cover` is
      // already that number, so far foam converges on it directly.
      foam.assign(saturate(mix(cover.mul(u.foamFarDensity), eroded, detFade)));

      // Foam is not one flat white. Thin lace lets a little water through and
      // sits in its own shadow; the dense cores are the only part that is paper
      // white. Without this the mask reads as a decal laid on the surface.
      foamShade.assign(mix(float(0.74), float(1.0), saturate(detail.mul(cover.add(0.35)))));
    });

    // ── Whitecaps out at sea, from the FFT's own crest pinching ──────────────
    // Two things this needs that the raw Jacobian threshold did not have.
    //
    // It must NOT reach into the surf zone. The Jacobian goes low wherever waves
    // steepen, and waves steepen most as they shoal — so an ungated whitecap term
    // fires hardest exactly where the surf model is already drawing foam, and the
    // two sum into an even white mat over the whole nearshore.
    //
    // And it must have STRUCTURE. `smoothstep` of a smooth field is smooth blobs;
    // at a distance a field of those reads as uniform speckle, which is what it
    // looked like. One Voronoi octave (9 hashes — a quarter of what the surf foam
    // spends) breaks them into crests with torn edges.
    // Safe to branch: `jacobian` was read above, so nothing here touches a texture.
    If(u.whitecapEnabled.greaterThan(0), () => {
      const cover = smoothstep(
        u.whitecapThreshold, u.whitecapThreshold.add(u.whitecapSoftness),
        saturate(float(1).sub(jacobian)),
      // Gated on DISTANCE FROM SHORE, not on `surfBand`. Keying it to the band
      // looks equivalent and is not: the band has already decayed to near zero a
      // few metres out, so the gate opens right where shoaling drives the
      // Jacobian lowest and the whitecaps simply replace the surf foam. Whitecaps
      // belong to open water, and open water starts past the surf zone.
      ).mul(u.whitecapIntensity)
        .mul(smoothstep(u.surfReach, u.surfReach.mul(2.5), max(sd, float(0))))
        .toVar();

      If(cover.greaterThan(0.003), () => {
        const p = wXZ.mul(u.whitecapScale).add(
          vec2(cos(u.windAngle), sin(u.windAngle)).mul(u.time.mul(0.4)),
        );
        const n = float(1).sub(_worleyF1(p, u.foamJitter)).mul(u.foamGain);
        // Same erosion contract as the surf foam: coverage sets a threshold.
        const t = mix(float(0.97), u.foamCutoff, pow(cover, u.foamErode));
        foam.assign(saturate(max(foam, smoothstep(t, t.add(u.foamTransition), n))));
      });
    });

    // Foam is LIT, not a flat white decal. It is a dense scattering medium, so it
    // has no specular to speak of, but it very much has a light side and a shaded
    // side — and a constant white is the last thing keeping this reading as paint
    // rather than as a surface. A wrapped diffuse term (half-Lambert) is the
    // right shape: foam scatters so much that even the side facing away from the
    // sun is far from black.
    const foamLit = saturate(dot(worldN, u.sunDir).mul(0.5).add(0.5));
    const foamCol = u.foamColor
      .mul(foamShade)
      .mul(mix(float(1), u.sunColor.mul(mix(float(0.62), float(1.15), foamLit)), u.foamSunLit));
    const withFoam = mix(body, foamCol, foam).toVar();

    // ── Wet sand behind the backwash ─────────────────────────────────────────
    // Not a decal and not a second material: the same sheet, gone almost
    // transparent, darkening what it lies on and adding a low gloss. It is the
    // cheapest part of this file and does more for the coast than anything but
    // the run-up itself.
    const wetSheen = u.sunColor.mul(specD.mul(u.wetGloss));
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

    // ── Seen from below ──────────────────────────────────────────────────────
    const under = mix(u.inscatterTint.mul(u.underwaterMurk), reflected, fresnelW);
    return vec4(mix(aboveWater, under, u.underwaterT), u.opacity);
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
    "whitecapIntensity", "whitecapThreshold", "whitecapSoftness", "whitecapScale",
    "surfHz", "surfLength", "surfReach", "surfAlongShore", "crestSharpness",
    "crestIntensity", "foamDecay", "foamWakeIntensity", "slopeGain",
    "runupReach", "runupRush", "runupShape", "runupMaxSlope", "filmThickness",
    "runupNearEnd", "runupFarEnd", "wetFade", "wetDarken", "wetGloss",
    "foamSunLit", "edgeWidth", "edgeIntensity", "foamNoiseScale", "foamJitter", "foamWarpScale",
    "foamWarpStrength", "foamFineScale", "foamFineAmt", "foamGain", "foamContrast", "foamErode",
    "foamCutoff", "foamTransition", "foamDrift", "foamDetailNear", "foamDetailFar", "foamFarDensity",
    "horizonFadeStart", "horizonFadeEnd", "underwaterMurk", "opacity",
  ];
  const BOOL_KEYS = [
    "fftEnabled", "sssEnabled", "whitecapEnabled", "surfEnabled",
    "runupEnabled", "foamEnabled", "ssrEnabled",
  ];
  const COLOR_KEYS = [
    "inscatterTint", "turbidityTint", "skyZenithColor", "skyHorizonColor",
    "sunColor", "sssColor", "foamColor",
  ];

  function syncParams(p) {
    if (!p) return;
    for (const k of NUM_KEYS) if (p[k] != null) u[k].value = p[k];
    for (const k of BOOL_KEYS) if (p[k] != null) u[k].value = p[k] ? 1 : 0;
    for (const k of COLOR_KEYS) if (p[k] != null) u[k].value.set(p[k]);
    if (p.absorption != null) u.absorption.value.set(...p.absorption);
    if (p.windAngleDeg != null) u.windAngle.value = p.windAngleDeg * DEG2RAD;
    if (p.skyHorizonSpread != null) {
      u.skyHorizonSpread.value = Math.sin(p.skyHorizonSpread * DEG2RAD);
    }
    if (p.seaLevel != null) u.waterY.value = p.seaLevel;
  }

  return {
    material,
    uniforms: u,
    syncParams,
    update(dt, elapsed) { u.time.value = elapsed; },
    setSunDir(v) { if (v) u.sunDir.value.copy(v).normalize(); },
    /** Host-supplied sky, so the reflection matches the sky actually in frame. */
    setSky({ zenith, horizon, sun } = {}) {
      if (zenith) u.skyZenithColor.value.copy(zenith);
      if (horizon) u.skyHorizonColor.value.copy(horizon);
      if (sun) u.sunColor.value.copy(sun);
    },
    setUnderwater(t) { u.underwaterT.value = t; },
    dispose() { material.dispose(); },
  };
}
