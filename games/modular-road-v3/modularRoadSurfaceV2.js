// ============================================================================
// ROAD SURFACE V2 — the B slot in road-surface-lab.html.
//
// This is a FORK POINT, not a copy. It builds the shipping road material and
// then adds to it, so A and B can never drift apart on anything except the
// thing being tested. The moment this file duplicates a term that
// modularRoadMaterial.js already computes, the lab stops comparing the game
// against a candidate and starts comparing two candidates, which is a much less
// useful question.
//
// V2 AT ITS MODULE DEFAULTS IS BYTE-IDENTICAL TO A, and that is deliberate:
// `chipsOn: 0` and `bumpAmount: 0` are build-time gates, so a V2 built with
// nothing set has no chip field and no normal node in the COMPILED SHADER — not
// a graph multiplied by zero. That is what makes the lab's "Match A" check mean
// something, and what the test suite asserts.
//
// NOTE that road-surface-lab.html overrides `streakSharp` at startup. The module
// promises identity; the LAB has to show the candidate, or it opens on two
// copies of the thing being replaced and reads as broken. Do not "fix" the lab
// to agree with these defaults — they answer different questions.
// ============================================================================
import {
  Fn,
  uniform,
  float,
  vec2,
  vec3,
  vec4,
  mix,
  saturate,
  oneMinus,
  abs,
  floor,
  fract,
  smoothstep,
  max,
  fwidth,
  attribute,
  uv,
  sqrt,
  normalMap,
  mx_noise_float,
  mx_fractal_noise_float,
  mx_worley_noise_float,
  mx_cell_noise_float,
} from "three/tsl";
import { createRoadMaterial } from "./modularRoadMaterial.js";

/**
 * Authored defaults for everything V2 adds on top of ROAD_LOOK.
 *
 * All zero-at-rest: every knob here has a default that produces exactly the
 * shipping look, so `{...ROAD_LOOK_defaults, ...SURFACE_V2_DEFAULTS}` and
 * `ROAD_LOOK_defaults` compile to the same material.
 */
export const SURFACE_V2_DEFAULTS = {
  // ── THE STREAK ────────────────────────────────────────────────────────────
  //
  // THE ACTUAL BRIEF. A race or kart circuit reads as long directional grain —
  // laid, dragged and polished along the direction of travel. That streak is
  // the LOOK, not a defect, and A already has it: `along` is divided by
  // `streak` (14) before the noise, so the aggregate runs 14× longer along the
  // road than across it.
  //
  // What is wrong with A is not the direction, it is the DEFINITION. One octave
  // of gradient noise stretched 14:1 has no hard transitions anywhere, so the
  // streaks read as soft blobs — long, but mushy, and at close range that mush
  // is the whole surface.
  //
  // (A previous pass here replaced the streak with a cellular chip field on the
  // grounds that real aggregate is isotropic. That is true of asphalt and wrong
  // for this track: round stones delete the directionality that is the point.
  // The chip mode is kept below as a switch, not as the direction.)
  /**
   * How hard the streak transitions are. 0 = exactly A. 1 = the field snaps
   * between light and dark, so every streak is a drawn line with an edge.
   *
   * Same field, same scale, same stretch as A — this changes only the shape of
   * the curve applied to it, never where it varies.
   */
  streakSharp: 0,
  /**
   * How straight the streaks run, as an along-road stretch factor. B's own —
   * A's shared `streak` stays at 14 and is not touched.
   *
   * 14 reproduces A exactly (wobbly ribbons). Higher is straighter: the
   * along-road period is `streakStraight / aggScale` metres, so 120 at
   * aggScale 5 is a ~24 m period — longer than anything in frame, so the grain
   * reads as parallel lines rather than as meandering noise.
   *
   * This, not `streakSharp`, is the knob that turns noise into asphalt.
   */
  streakStraight: 120,
  /**
   * Line WIDTH, as cycles per metre across the road. B's own, so it does not
   * drag A's shared `aggScale` with it.
   *
   * LOWER = fewer, wider lines. A's 5 is ~20 cm of period across a 16 m deck,
   * i.e. about 80 bands — which at this straightness reads as fine pinstripe.
   * 2.2 gives ~45 cm bands, around 35 across the deck: broad screed passes
   * rather than hairlines, which is what a paver actually leaves.
   */
  streakScale: 2.2,
  /**
   * Extra distance-fade rate for the sharpened streak. 1 = A's rule.
   *
   * Sharpening ADDS high-frequency content — that is what sharpening is — so a
   * crisp field aliases sooner than A's soft one and cannot keep A's fade rate.
   * This wants to rise roughly with `streakSharp`, or the deck crawls in the
   * middle distance. Milder version of the same lesson `chipFade` documents.
   */
  streakFade: 1.6,
  // ── THE CELLULAR CHIP MODE (opt-in, NOT the direction) ────────────────────
  /** Master for the cellular field. 0 = the streak mode above. */
  chipsOn: 0,
  /**
   * Cycles per metre of the chip field. B's OWN, deliberately not A's
   * `aggScale`.
   *
   * Two reasons. First the wipe: `aggScale` is a shared uniform, so tuning it
   * to suit the chips would move A as well and the divider would stop isolating
   * the change under test.
   *
   * Second, and more useful: 5 cycles/m is simply the WRONG NUMBER for
   * aggregate — it is a 20 cm stone. Real dense-graded asphalt is 8–14 mm, so
   * the honest value is nearer 80. A's smooth gradient noise concealed that
   * error completely, because a cloud has no scale you can read; a cellular
   * field states its scale outright, and the first thing you see at 5 is
   * cobbles. 14 is the compromise a procedural can actually hold — see
   * `chipFade` for why it cannot simply be pushed to 80, and why a baked
   * texture can.
   */
  chipScale: 14,
  /**
   * B's aggregate/macro tone balance, overriding the base `aggWeight` while the
   * chips are on. A keeps the shared 0.4.
   *
   * Higher than A's because the two are no longer comparable quantities: at 0.4
   * a smooth field is a subtle tonal wash, while a chip field is stones you can
   * barely make out. The layer is worth more once it has something to say.
   */
  chipWeight: 0.55,
  /**
   * How many times longer a chip is along the road than across it. ~1 is a
   * round stone; a little above 1 is a stone that has been polished
   * directionally by tyres, which is real and worth having. NOT 14.
   */
  chipStretch: 1.2,
  /**
   * How far feature points wander inside their cell. 1 = fully random (organic,
   * irregular packing); 0 = a perfect grid, which reads as tile.
   */
  chipJitter: 0.9,
  /**
   * How discrete the stones are. Low = soft blobs (basically where A already
   * was, minus the smear); high = hard-edged chips sitting in mastic.
   *
   * Real dense-graded asphalt is nearer the high end than it looks in photos —
   * what softens it in life is the binder skimming the tops, not the stones
   * being vague.
   */
  chipSharp: 0.4,
  /** How dark the binder between the stones goes, relative to the stone tops.
   *  This is the contrast that makes chips read as chips. */
  binderDepth: 0.5,
  /** Tone spread from stone to stone. Real mixes are not one rock — a little
   *  per-chip variation is most of what stops it looking like a pattern. */
  chipVary: 0.32,
  /**
   * How much earlier the chips fade out than A's aggregate does. 1 = A's rule.
   *
   * ABOVE 1 IS NOT A TASTE SETTING, it is what cellular noise costs. A gradient
   * noise is band-limited — its energy really does sit near its base frequency,
   * so fading it at Nyquist is about right, which is the rule A uses:
   *
   *     aggFade = 1 − texel · aggScale · 2
   *
   * A worley field has EDGES. Every chip boundary is a step, and a step has
   * energy at every frequency, so the field aliases long before its base
   * frequency reaches Nyquist. Fading at the same point leaves a band in the
   * middle distance where the chips are one to two pixels across and crawl —
   * which reads as a regular cobbled pattern, i.e. exactly the artefact the
   * cellular field was brought in to avoid.
   *
   * This is also the clearest argument for baking the surface to a texture:
   * a mip chain solves the same problem CORRECTLY, by pre-averaging the chips
   * into the right tone instead of fading them to flat grey.
   */
  chipFade: 3.2,
  // ── FINES ────────────────────────────────────────────────────────────────
  /**
   * Cycles per metre of the fine grit that lives BETWEEN the chips. ~26 ⇒ ~4 cm.
   *
   * This is the layer that exists purely for the close-up. The shipping surface
   * has exactly two scales — 0.06 and 5 cycles/m — an 83:1 gap with nothing in
   * it, so when you get close enough for the chips to be big there is no finer
   * detail behind them and the surface goes soft.
   */
  gritScale: 55,
  /** How strongly the grit shows. Small: this is texture, not another layer of
   *  stones. */
  gritAmount: 0.35,
  /** Grit dies much sooner than the chips do — it is under a pixel far earlier,
   *  and high-frequency noise is the first thing to alias. */
  gritFade: 3.0,
  // ── THE DECK NORMAL ───────────────────────────────────────────────────────
  //
  // The shipping material has NO normalNode at all — the only normal
  // perturbation anywhere in the road is the wet clearcoat's, and that exists
  // only when the weather is on. So a dry deck is geometrically flat and every
  // bit of variation you can see is albedo and roughness.
  //
  // That is why it reads as painted rather than laid. Roughness variation only
  // shows up in the specular lobe, and at deckRough 0.93 that lobe is wide and
  // weak — the aggregate you can SEE in the albedo never catches the sun,
  // because as far as the lighting is concerned the surface is a plane.
  //
  /**
   * Master. 0 = no normal node is compiled at all (see createRoadSurfaceV2).
   *
   * Deliberately small at its "on" settings. This is a RACE circuit, not a
   * street: polymer-modified race asphalt is finer, flatter and glossier than
   * public-road tarmac. The read to aim at is silky and directional, not
   * gravelly — if it looks like chip seal it is at least 3× too strong.
   */
  bumpAmount: 0,
  /** How much of the height comes from the aggregate speckle (surface.y).
   *  This is the term the sun rakes across; it is the effect. */
  bumpAgg: 1.0,
  /** ...and from the macro drift (surface.x). Long, low swells — paver strips
   *  and old repairs sitting slightly proud. Subtle by construction: at
   *  macroScale 0.06 × streak this is a metres-long feature, so it reads as the
   *  road being slightly unfair rather than as texture. */
  bumpMacro: 0.35,
  /**
   * TRANSVERSE RESURFACING JOINTS, metres apart. 0 = none.
   *
   * Cheap (one fract, no noise) and worth more than it looks. Real circuits are
   * laid in passes and the joints between them are visible from a long way off;
   * at 300 km/h they are also one of the only things giving you a sense of
   * scale and speed on an otherwise featureless deck. They ride in the normal
   * rather than the albedo on purpose — a painted-looking dark line reads as a
   * decal, a groove reads as construction.
   */
  jointSpacing: 0,
  /** Groove width in metres. Narrow — this is a saw cut, not a rut. */
  jointWidth: 0.06,
  /** How deep the joint pushes relative to bumpAmount. >1 so a joint still
   *  reads when the aggregate is turned down to almost nothing. */
  jointDepth: 1.8,
  /**
   * How hard the bump fades as the surface undersamples, on top of the deck's
   * own aggFade. 1 = follow aggFade exactly.
   *
   * NOT optional, and the reason is in the method (below): a screen-space
   * derivative is computed per 2×2 quad, so once the height field has more than
   * about one cycle per quad the derivative is measuring aliasing rather than
   * slope. Left ungated that is a field of crawling glitter down every straight
   * — the exact failure the deck's own aggFade was written to stop, and it
   * comes back harder in the normal because a normal is a DIRECTION and the eye
   * tracks direction far better than it tracks a tone.
   *
   * Push above 1 to kill the bump sooner than the albedo speckle, which is
   * usually what you want: the albedo can survive a bit of undersampling, the
   * normal cannot.
   */
  bumpFade: 1.35,
};

/**
 * What road.html actually ships. SURFACE_V2_DEFAULTS stays all-zero so the
 * surface lab's "B at rest is A" identity (and tools/roadSurfaceLabTest.mjs)
 * keep meaning something. The game is allowed to turn the candidate on.
 *
 * bumpAmount is small on purpose — race asphalt, not chip-seal.
 *
 * streakSharp stays 0. The lab candidate hardens the grain into drawn
 * paver lines (`streakStraight` 120); that is a different material from the
 * shipping deck, which is stretched noise that still meanders. The game
 * keeps A's albedo and only adds the bump — including the grit octave,
 * which lives in the normal so close-up chips still catch the sun.
 *
 * jointSpacing stays 0. At 12 m it drew a saw-cut groove across every
 * straight and those read as mesh seams — especially wet.
 */
export const SURFACE_V2_GAME = {
  streakSharp: 0,
  bumpAmount: 0.05,
  jointSpacing: 0,
};

export const SURFACE_V2_NUMBERS = Object.keys(SURFACE_V2_DEFAULTS);

/**
 * UV metres between the three height taps that build the bump normal.
 *
 * Sized for the GRIT (~18 mm at gritScale 55), not the 20 cm aggregate.
 * 12 mm was averaging the fines into a swell, which is why the close-up
 * went flat after the UV-space switch.
 */
const BUMP_SAMPLE_EPS = 0.004;

/**
 * Height of the deck at an arbitrary UV, in the same units the bump scale
 * expects (~−0.5..0.5 from the noise, plus a downward joint).
 *
 * Re-sampled at uv, uv+(ε,0), uv+(0,ε) so the slope is a function of THIS
 * fragment's UV only. Screen-space `dFdx(height)` is not — that derivative
 * is per 2×2 pixel quad, and on a triangle edge the helper pixel sits in a
 * different interpolator, so the slope spikes. Lighting then self-shadows
 * along those spikes (shadow normalBias follows the shading normal) and you
 * get repeating stripes and stair-step diagonals. That is what the close-up
 * "diagonals" were. The piece lab already does this 3-tap; this is that.
 *
 * Fade is NOT in the height. `fwidth` is itself a screen derivative, and
 * baking it into a value you then differentiate puts the aliasing right
 * back. Fade multiplies the tangent slope after the taps, same as isDeck.
 *
 * @param {Node} uvn  vec2(along metres, across metres)
 * @param {object} ru  the base road uniforms
 * @param {object} v   the V2 uniforms
 * @param {Node} gritFade  0..1, computed ONCE at this fragment — not per tap
 */
function bumpHeightAt(uvn, ru, v, gritFade) {
  const alongOff = uvn.x.add(attribute("aAlongOffset", "float"));
  const along = alongOff.div(ru.streak);
  const across = uvn.y;
  const macro = mx_fractal_noise_float(
    vec3(along.mul(ru.macroScale), across.mul(ru.macroScale), 0.0), 3, 2.0, 0.5, 1.0,
  );
  const agg = mx_noise_float(
    vec3(along.mul(ru.aggScale), across.mul(ru.aggScale), 0.0),
  );
  const height = agg.mul(0.5).mul(v.bumpAgg).add(macro.mul(0.5).mul(v.bumpMacro));

  // Close-up grain. Unstretched (unlike agg), ~2 cm. Independent of
  // streakSharp: that knob is the paver LINES, this is the chips between them.
  // Same weight as the aggregate so it actually reads in the normal; albedo
  // gritAmount stays the colour-side slider and is not reused here.
  const grit = mx_noise_float(
    vec3(alongOff.mul(v.gritScale), across.mul(v.gritScale), 0.0),
  );
  const fines = grit.mul(0.5).mul(v.bumpAgg).mul(gritFade);

  const spacing = max(v.jointSpacing, float(0.001));
  const cyc = fract(uvn.x.div(spacing));
  const dJoint = abs(cyc.sub(0.5)).mul(spacing);
  const joint = oneMinus(smoothstep(float(0), v.jointWidth, dJoint))
    .mul(smoothstep(0.0, 0.001, v.jointSpacing))
    .mul(v.jointDepth)
    .negate();
  return height.add(fines).add(joint);
}

/**
 * The replacement asphalt surface, honouring modularRoadMaterial's vec4
 * contract: x = macro tone, y = aggregate tone, z = wheel path, w = agg fade.
 *
 * TWO MODES, and the default one is the STREAK.
 *
 * `streak` keeps A's field exactly — same noise, same 14:1 stretch, same scale
 * — and only sharpens it. That is the whole change. The long directional grain
 * is the LOOK of a race circuit: laid, dragged and polished along the direction
 * of travel. It is not an artefact and it is not to be removed. What is wrong
 * with A is that one octave of gradient noise smeared 14:1 gives soft blobs
 * rather than drawn lines, so the streaks read as mush.
 *
 * `chips` is the cellular field, kept as a switch. It is a more truthful model
 * of what asphalt physically is and the wrong answer for what this track should
 * look like — round stones throw away the directionality that is the point.
 * Left in because it may suit a street piece later; not the direction.
 *
 * @param {object} u  the base road uniforms (streak, macroScale, aggScale…)
 * @param {object} v  the V2 uniforms
 * @param {{chips: boolean}} mode
 */
function buildSurfaceV2(u, v, { chips }) {
  return Fn(() => {
    // Per-piece noise phase, so neighbouring pieces are not painted with the
    // same patch of asphalt. See stampAlongOffset in modularRoadKit. Constant
    // per piece, so it cannot affect the fwidth-based fades below.
    const alongRaw = uv().x.add(attribute("aAlongOffset", "float"));
    const across = uv().y; // metres across the developed profile
    const lateral = attribute("aLateral", "float");

    // ── MACRO ──────────────────────────────────────────────────────────────
    // Byte-for-byte A's. Untouched in both modes.
    const alongMacro = alongRaw.div(u.streak);
    const macro = mx_fractal_noise_float(
      vec3(alongMacro.mul(u.macroScale), across.mul(u.macroScale), 0.0), 3, 2.0, 0.5, 1.0,
    ).mul(0.5).add(0.5);

    const wheelPath = smoothstep(0.18, 0.42, abs(lateral))
      .mul(oneMinus(smoothstep(0.55, 0.8, abs(lateral))));

    if (!chips) {
      // ── SHARPENED STREAK (the default) ──────────────────────────────────
      // A's aggregate, at A's stretch and A's scale. Nothing here changes WHERE
      // the field varies — only how hard the transition between light and dark
      // is, which is the difference between a drawn line and a smudge.
      // STRAIGHTNESS IS THE POINT, and it is not the same thing as length.
      //
      // A divides `along` by streak = 14. That makes the noise 14× longer along
      // the road than across it — but a stretched noise field still MEANDERS:
      // its contours wander sideways as they run, so what you get is long wobbly
      // ribbons. Sharpening those only gives you crisp wobbly ribbons, which is
      // why the last pass barely moved the look.
      //
      // A screed does not wander. It is dragged in a straight line, so the grain
      // it leaves varies ACROSS the road and almost not at all ALONG it. That is
      // the whole difference between "noise that happens to be long" and "lines".
      //
      // `streakStraight` is B's own stretch, separate from A's shared `streak`
      // so tuning it cannot move A. At 14 it reproduces A's wobble; at the
      // default 120 the along-period is ~24 m at aggScale 5, i.e. far longer
      // than anything on screen, so the lines read as dead straight while still
      // varying slowly enough down the track to avoid looking machined.
      const alongAgg = alongRaw.div(v.streakStraight);
      const raw = mx_noise_float(
        vec3(alongAgg.mul(v.streakScale), across.mul(v.streakScale), 0.0),
      ).mul(0.5).add(0.5); // 0..1, same shape as A before its fade

      // THE S-CURVE. `w` is the half-width of the transition band: at
      // streakSharp 0 it is 0.5, i.e. the curve spans the whole range and does
      // almost nothing; at 1 it is a hair either side of the midpoint and the
      // field snaps to light or dark.
      //
      // Mixed against the RAW value rather than used outright, so streakSharp 0
      // is exactly identity — smoothstep(0, 1, x) is not x, and without the mix
      // "off" would still quietly re-tone the deck.
      const w = mix(float(0.5), float(0.035), v.streakSharp);
      const shaped = mix(
        raw,
        smoothstep(float(0.5).sub(w), float(0.5).add(w), raw),
        v.streakSharp,
      );

      // FADE. Sharpening ADDS high-frequency content — that is what sharpening
      // is — so the field aliases sooner than A's does and cannot use A's fade
      // rate unchanged. Same lesson the cellular mode taught the hard way, in a
      // milder form: `streakFade` scales the rate, and it needs to rise roughly
      // with streakSharp or a crisp deck crawls in the middle distance.
      //
      // Measured on the RAW arc length, not the pre-stretched one: A divides
      // `along` by `streak` before taking fwidth, which understates the real
      // sampling rate along the road by 14× and is why its aggregate survives
      // further into the distance than it should.
      const texel = max(fwidth(alongRaw), fwidth(across));
      const aggFade = saturate(oneMinus(texel.mul(v.streakScale).mul(2.0).mul(v.streakFade)));

      // FINES. Shared with the chip mode, and it belongs in BOTH — it is the
      // close-up layer, not a property of either aggregate model.
      //
      // Without it the streak mode has nothing finer than `streakScale`, which
      // at 2.2 is a 45 cm band: no grain at any distance you actually drive at,
      // and nothing for the bump normal to bite on (a normal taken from 45 cm
      // bands is broad swells, not asphalt). This is the layer that makes the
      // deck read as a surface rather than as painted stripes.
      const grit = mx_noise_float(
        vec3(alongRaw.mul(v.gritScale), across.mul(v.gritScale), 0.0),
      );
      const gritFade = saturate(oneMinus(texel.mul(v.gritScale).mul(v.gritFade)));

      // Fades toward flat 0.5, exactly as A's does.
      const agg = float(0.5)
        .add(shaped.sub(0.5).mul(aggFade))
        .add(grit.mul(v.gritAmount).mul(gritFade).mul(0.5));
      // .w carries the CHIP/STREAK fade, which is what the bump's own fade
      // follows. Take the larger of the two so the normal survives as long as
      // there is any detail left to shade, rather than dying with the streaks
      // while the grit is still visible.
      return vec4(macro, saturate(agg), wheelPath, max(aggFade, gritFade));
    }

    // ── CELLULAR CHIPS (opt-in) ────────────────────────────────────────────
    const chipUv = vec2(alongRaw.div(v.chipStretch), across).mul(v.chipScale);
    const d = mx_worley_noise_float(chipUv, v.chipJitter, 0);
    const edge = mix(float(0.85), float(0.28), v.chipSharp);
    const chip = oneMinus(smoothstep(edge.mul(0.35), edge, d));
    const cellId = floor(chipUv);
    const vary = mx_cell_noise_float(cellId).sub(0.5).mul(v.chipVary);
    const grit = mx_noise_float(
      vec3(alongRaw.mul(v.gritScale), across.mul(v.gritScale), 0.0),
    );
    const texel = max(fwidth(alongRaw), fwidth(across));
    const chipFade = saturate(oneMinus(texel.mul(v.chipScale).mul(2.0).mul(v.chipFade)));
    const gritFade = saturate(oneMinus(texel.mul(v.gritScale).mul(v.gritFade)));
    const stone = chip.mul(chipFade);
    const agg = float(0.5)
      .add(stone.sub(0.5).mul(v.binderDepth))
      .add(vary.mul(stone))
      .add(grit.mul(v.gritAmount).mul(gritFade).mul(0.5));
    return vec4(macro, saturate(agg), wheelPath, chipFade);
  })();
}

/**
 * The road material, plus a deck micro-normal.
 *
 * @param {object} [opts] a ROAD_LOOK plus any of SURFACE_V2_DEFAULTS.
 * @returns {THREE.MeshStandardNodeMaterial|THREE.MeshPhysicalNodeMaterial}
 *   carrying `._surfaceV2Uniforms` alongside the base `._roadUniforms`.
 */
export function createRoadSurfaceV2(opts = {}) {
  /**
   * V2's uniforms, built BEFORE the material because the surface injection
   * needs them — `buildSurface` runs inside createRoadMaterial.
   */
  const v = {
    streakSharp: uniform(opts.streakSharp ?? SURFACE_V2_DEFAULTS.streakSharp),
    streakStraight: uniform(opts.streakStraight ?? SURFACE_V2_DEFAULTS.streakStraight),
    streakScale: uniform(opts.streakScale ?? SURFACE_V2_DEFAULTS.streakScale),
    streakFade: uniform(opts.streakFade ?? SURFACE_V2_DEFAULTS.streakFade),
    chipsOn: uniform(opts.chipsOn ?? SURFACE_V2_DEFAULTS.chipsOn),
    chipScale: uniform(opts.chipScale ?? SURFACE_V2_DEFAULTS.chipScale),
    chipWeight: uniform(opts.chipWeight ?? SURFACE_V2_DEFAULTS.chipWeight),
    chipStretch: uniform(opts.chipStretch ?? SURFACE_V2_DEFAULTS.chipStretch),
    chipJitter: uniform(opts.chipJitter ?? SURFACE_V2_DEFAULTS.chipJitter),
    chipSharp: uniform(opts.chipSharp ?? SURFACE_V2_DEFAULTS.chipSharp),
    binderDepth: uniform(opts.binderDepth ?? SURFACE_V2_DEFAULTS.binderDepth),
    chipVary: uniform(opts.chipVary ?? SURFACE_V2_DEFAULTS.chipVary),
    chipFade: uniform(opts.chipFade ?? SURFACE_V2_DEFAULTS.chipFade),
    gritScale: uniform(opts.gritScale ?? SURFACE_V2_DEFAULTS.gritScale),
    gritAmount: uniform(opts.gritAmount ?? SURFACE_V2_DEFAULTS.gritAmount),
    gritFade: uniform(opts.gritFade ?? SURFACE_V2_DEFAULTS.gritFade),
    bumpAmount: uniform(opts.bumpAmount ?? SURFACE_V2_DEFAULTS.bumpAmount),
    bumpAgg: uniform(opts.bumpAgg ?? SURFACE_V2_DEFAULTS.bumpAgg),
    bumpMacro: uniform(opts.bumpMacro ?? SURFACE_V2_DEFAULTS.bumpMacro),
    jointSpacing: uniform(opts.jointSpacing ?? SURFACE_V2_DEFAULTS.jointSpacing),
    jointWidth: uniform(opts.jointWidth ?? SURFACE_V2_DEFAULTS.jointWidth),
    jointDepth: uniform(opts.jointDepth ?? SURFACE_V2_DEFAULTS.jointDepth),
    bumpFade: uniform(opts.bumpFade ?? SURFACE_V2_DEFAULTS.bumpFade),
  };

  /**
   * THE CHIPS ARE A BUILD-TIME CHOICE too, same as the bump and for the same
   * two reasons: at rest B must be A in the compiled shader, and a worley is
   * nine hashes you do not want to pay for and multiply away.
   *
   * With it off, `buildSurface` is not passed at all and createRoadMaterial
   * builds its own field exactly as it always has.
   */
  const chipsOn = (opts.chipsOn ?? SURFACE_V2_DEFAULTS.chipsOn) > 0;
  const streakSharp = opts.streakSharp ?? SURFACE_V2_DEFAULTS.streakSharp;
  // Inject only when there is something to inject. With both off,
  // createRoadMaterial builds its own field and B is A in the compiled shader —
  // which is what "Match A" has to mean.
  const surfaceOn = chipsOn || streakSharp > 0;
  const mat = createRoadMaterial(
    surfaceOn
      ? {
          ...opts,
          // The chip mode owns its tone balance; the streak mode keeps A's,
          // because it IS A's field and re-weighting it would confound the one
          // thing being judged.
          ...(chipsOn
            ? { aggWeight: opts.chipWeight ?? SURFACE_V2_DEFAULTS.chipWeight }
            : {}),
          buildSurface: (u) => buildSurfaceV2(u, v, { chips: chipsOn }),
        }
      : opts,
  );
  mat._surfaceV2Uniforms = v;
  mat._surfaceV2ChipsOn = chipsOn;
  mat._surfaceV2StreakOn = streakSharp > 0;

  /**
   * BUILD-TIME GATE, not a uniform multiply — the same reasoning the wet
   * clearcoat uses one file over, and for a stronger reason.
   *
   * A normalNode set to a flat vec3 still compiles the whole perturbation:
   * three height taps, a TBN via `normalMap`, and — because `normalNode` is
   * present at all — three's own normal handling changes shape around it.
   * Multiplying that by a zero uniform pays for all of it to arrive back
   * where it started.
   *
   * More importantly it would break the lab's own premise. "B at rest is
   * identical to A" has to mean identical in the compiled shader, or the ms
   * readout compares a material that has a normal path against one that does
   * not and calls the difference a measurement.
   *
   * The cost is that crossing 0 is a rebuild. That is exactly how setRoadWet
   * handles wetAmount in roadGame.js: a rebuild at one end of the range, a
   * uniform poke everywhere else.
   */
  const bumpOn = (opts.bumpAmount ?? SURFACE_V2_DEFAULTS.bumpAmount) > 0;
  mat._surfaceV2BumpOn = bumpOn;
  if (!bumpOn) return mat;

  const surface = mat._surfaceNode;
  const ru = mat._roadUniforms;
  if (!surface || !ru) {
    // Loud rather than silently flat: this is the contract with
    // modularRoadMaterial and a rename there would otherwise cost an afternoon.
    throw new Error(
      "createRoadSurfaceV2: material has no _surfaceNode / _roadUniforms — "
      + "modularRoadMaterial must expose both for the bump normal.",
    );
  }

  mat.normalNode = Fn(() => {
    const zone = attribute("aZone", "float");
    // Deck (1) and kerb (2) only. The sides, the tube shell and the lacquered
    // panel are manufactured surfaces — asphalt relief on them is just wrong,
    // and the panel in particular is supposed to look moulded.
    const isDeck = smoothstep(0.5, 0.6, zone).mul(oneMinus(smoothstep(2.4, 2.5, zone)));

    // Fade still follows the albedo speckle (surface.w). Strength only —
    // it must not go into the height being differenced (see bumpHeightAt).
    const fade = saturate(surface.w.mul(v.bumpFade));
    let scale = v.bumpAmount.mul(fade).mul(isDeck);

    // WATER DROWNS RELIEF. A thin film still follows the chips — that is what
    // makes damp asphalt sparkle instead of looking varnished — but standing
    // water is a flat surface sitting ON the road, so the substrate bump has
    // to die inside a puddle or you see gravel lighting through a mirror.
    // `_wetField` is the same vec2(film, pond) the shading uses; null when
    // this material was built dry, so the extra mix is not even in the graph.
    const wetField = mat._wetField;
    if (wetField) {
      scale = scale
        .mul(oneMinus(wetField.x.mul(0.18))) // film fills pores a little
        .mul(oneMinus(wetField.y.mul(0.9))); // puddles almost geometrically flat
    }

    const uvn = uv();
    const alongRaw = uvn.x.add(attribute("aAlongOffset", "float"));
    // One fade for all three taps. Putting fwidth inside bumpHeightAt would
    // differentiate the fade itself and bring the glitter back.
    const gritFade = saturate(oneMinus(
      max(fwidth(alongRaw), fwidth(uvn.y)).mul(v.gritScale).mul(v.gritFade),
    ));
    const eps = float(BUMP_SAMPLE_EPS);
    const h0 = bumpHeightAt(uvn, ru, v, gritFade);
    const hx = bumpHeightAt(uvn.add(vec2(eps, 0)), ru, v, gritFade);
    const hy = bumpHeightAt(uvn.add(vec2(0, eps)), ru, v, gritFade);
    const tsNx = hx.sub(h0).div(eps).mul(scale).negate();
    const tsNy = hy.sub(h0).div(eps).mul(scale).negate();
    const tsNz = sqrt(max(float(1e-4), float(1).sub(tsNx.mul(tsNx).add(tsNy.mul(tsNy)))));
    // Packed 0..1 the way three's `normalMap` wants it. Scale of (1,1): the
    // slope already carries bumpAmount, so a second gain here would double-count.
    // A zero scale yields (0,0,1) → identity, so non-deck / far / puddles match A.
    const packed = vec3(
      tsNx.mul(0.5).add(0.5),
      tsNy.mul(0.5).add(0.5),
      tsNz.mul(0.5).add(0.5),
    );
    return normalMap(packed, vec2(1, 1));
  })();

  return mat;
}

/** Live-poke the V2 uniforms. Crossing `bumpAmount` 0 needs a rebuild, not
 *  this — see the build-time gate in createRoadSurfaceV2. */
export function syncSurfaceV2Uniforms(mat, p) {
  const v = mat?._surfaceV2Uniforms;
  if (!v || !p) return;
  for (const k of SURFACE_V2_NUMBERS) {
    if (p[k] != null) v[k].value = typeof p[k] === "boolean" ? (p[k] ? 1 : 0) : p[k];
  }
  // `chipWeight` is handed to createRoadMaterial as its `aggWeight` at build
  // time, so poking the V2 uniform alone would move a value nothing reads. Push
  // it through to the base uniform as well, or the slider does nothing until
  // something else happens to trigger a rebuild — which is the most annoying
  // class of bug to notice, because it looks like the knob has no effect.
  if (mat._surfaceV2ChipsOn && p.chipWeight != null) {
    const base = mat._roadUniforms?.aggWeight;
    if (base) base.value = p.chipWeight;
  }
}

/** True when `p` would need a material rebuild rather than a uniform poke. */
export function surfaceV2NeedsRebuild(mat, p) {
  if (!mat) return true;
  const wantBump = (p?.bumpAmount ?? SURFACE_V2_DEFAULTS.bumpAmount) > 0;
  const wantChips = (p?.chipsOn ?? SURFACE_V2_DEFAULTS.chipsOn) > 0;
  const wantStreak = (p?.streakSharp ?? SURFACE_V2_DEFAULTS.streakSharp) > 0;
  return wantBump !== !!mat._surfaceV2BumpOn
    || wantChips !== !!mat._surfaceV2ChipsOn
    || wantStreak !== !!mat._surfaceV2StreakOn;
}
