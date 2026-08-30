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
  min,
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
import { createRoadMaterial, lineCoverageAt } from "./modularRoadMaterial.js";

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
  /**
   * Amplitude of the GRIT octave in the normal — its own knob now, where it
   * used to ride `bumpAgg`. Split off because it needed to be switchable
   * independently, and sharing an amplitude with a layer 30x its size hid that.
   *
   * ZERO IN THE GAME (see SURFACE_V2_GAME), non-zero here so the labs keep it.
   * Not a taste call: at gritScale 55 the octave is faded to exactly 0 on every
   * pixel the chase camera can see — the eye has to be within 6.3 m of the deck
   * and the boom is 8.2 m — so in game it was 3 of the normal's 18 noise
   * evaluations returning a guaranteed zero. Close cameras (the piece lab, the
   * surface lab, a bonnet or photo camera) are inside that range and do see it,
   * which is exactly why it is a knob and not a deletion.
   *
   * IF YOU ADD A BONNET OR PHOTO CAMERA TO road.html, turn this back on — the
   * fade will do the right thing from there, and the harness will tell you the
   * range it is worth.
   */
  bumpGrit: 1.0,
  /**
   * ...and from the macro drift (surface.x). Long, low swells — paver strips
   * and old repairs sitting slightly proud.
   *
   * RETIRED TO 0, and the measurement is why. "Subtle by construction" (what
   * this comment used to say) turned out to mean invisible: at macroScale 0.06
   * the period is 16.7 m, so at amplitude 0.35 the slope is 0.021/m against the
   * chip octave's 11.2/m. Run through the same bumpAmount and fade, that is a
   * shading-normal tilt of 0.060 DEGREES — 406x weaker than the chip, and about
   * a twentieth of a shading step at 8-bit.
   *
   * It is not free, though, and that is the point. It is a THREE-OCTAVE fractal
   * evaluated once per height tap, so it was 9 of the 18 noise evaluations the
   * normal cost — half the bump's entire budget — to move the normal by six
   * hundredths of a degree. Gated at build time (see createRoadSurfaceV2), so
   * at 0 the fractal is not in the compiled shader rather than multiplied away.
   *
   * Turn it back up only if you want genuinely visible long swells, and expect
   * to need a value in the several-units range before anything shows. Measured
   * by tools/roadBumpVisibilityTest.mjs, which still prints what it would be
   * worth so this decision stays re-checkable.
   */
  bumpMacro: 0,
  /**
   * ── THE MID OCTAVE, and the reason the bump was invisible in game ────────
   *
   * MEASURED, by tools/roadBumpVisibilityTest.mjs — which prints the whole
   * table and is the thing to re-run before touching any scale here. At FOV 60
   * over 1080 px the per-pixel angle is 9.7e-4 rad, and the chase boom is 3.2 m
   * up / 7.5 m back (chaseCamera.js CHASE_CAM), so the nearest deck fragment on
   * screen is 8.2 m away. Its footprint there is 7.9 mm ACROSS the road and
   * 20.1 mm ALONG it — pixels are 2.5x longer along the road, because that is
   * the grazing axis, and by 20 m ahead that ratio is 8.7x. So the finest relief
   * the game camera can resolve is roughly 3 cm at the very nearest point and
   * ~10 cm by the middle distance.
   *
   * The two octaves that existed sit either side of that band and neither is in
   * it: `gritScale` 55 is 1.8 cm — three times too fine, and correctly faded to
   * zero EVERYWHERE on screen (the eye has to be within 6.3 m of the deck for
   * it to survive, and the boom is 8.2 m, which is why it only ever showed in
   * the labs) — while `aggScale` 5 is 20 cm across and, stretched by `streak`,
   * 2.8 m along, so it is a long smooth swell that reads as tonal variation
   * rather than as texture.
   *
   * That gap is the whole bug. It is not a strength setting and not a fade
   * rate: there was simply no relief authored at the scale the player's camera
   * can actually see. This octave fills it.
   *
   * Amplitude weight of that layer, relative to the aggregate.
   */
  bumpChip: 0.7,
  /** Cycles per metre ACROSS the road. 16 => ~6 cm, mid-band by construction. */
  bumpChipScale: 16,
  /**
   * How many times longer a chip is along the road than across it. Mild — a
   * stone polished directionally by tyres, not a 14:1 smear like `streak`.
   * Keeping it low is what puts variation on the ACROSS axis, which is the
   * well-sampled one and therefore the one that survives into the distance.
   */
  bumpChipStretch: 3.0,
  /**
   * Fade rate for that octave, in the same units as `gritFade`.
   *
   * BELOW NYQUIST ON PURPOSE, which the older octaves could not afford. A rate
   * of 2.0 IS Nyquist — the octave dies exactly where a pixel spans half its
   * period — and that is the right rule when the taps point-sample, because
   * past that point the "slope" is aliasing. With `bumpFilter` on, the taps
   * span a pixel and the difference is a real average: at 20 m the across tap
   * is ~27 mm against a ~62 mm chip, still better than two samples per cycle.
   * So the fade can run past Nyquist and degrade gently instead of cutting out.
   *
   * 1.5 keeps the relief readable to ~20 m and gone by ~35 m, which is the band
   * a driver actually reads the surface from. Measured, with the table, by
   * tools/roadBumpVisibilityTest.mjs — raise it if the mid-distance crawls.
   */
  bumpChipFade: 1.5,
  /**
   * HOW FAR THE THREE HEIGHT TAPS SPREAD as the pixel footprint grows.
   * 0 = the old fixed 4 mm spacing. 1 = the taps track the footprint exactly.
   *
   * This is the filtering fix, and it replaces a fade rather than adding one.
   * A fixed 4 mm epsilon point-samples the height field; once a pixel covers
   * 33 mm that is sampling something eight times finer than the pixel, so the
   * "slope" it returns is aliasing, not slope — which is exactly why it then
   * had to be faded away to stop the deck glittering. Spreading the taps to one
   * pixel's width instead makes the finite difference measure the AVERAGE slope
   * the pixel actually sees, which is what a mip level would give you.
   *
   * It buys the anisotropy for free, and that is the part worth noticing. The
   * two taps are spread independently, so 20 m down a straight the along-road
   * tap spans 232 mm while the across-road tap spans 27 mm — 8.7:1. The
   * along-road slope therefore decays on its own (a secant over many cycles of
   * noise goes as 1/eps) while transverse relief survives. Screed lines running
   * down the road are exactly what you want left at distance, and they now fall
   * out of the sampling rather than out of a second per-axis fade.
   *
   * THE 4 mm FLOOR IS A FLOOR, NOT A PROMISE OF IDENTITY, and it is worth being
   * exact about who still gets the old behaviour. The floor wins only where a
   * pixel covers less than 4 mm of deck, i.e. with the eye within ~4 m — the
   * piece lab, the surface lab, a bonnet camera. The chase camera's nearest
   * fragment is 7.9 mm/px, so it is filtered too, and it SHOULD be: that is
   * precisely the range where a 4 mm tap was reading a field finer than the
   * pixel. Expect the game deck to look different from the old build at every
   * distance; expect the labs to look unchanged.
   *
   * Never narrows below the floor, so the filter cannot sharpen anything into
   * aliasing — it only ever widens.
   */
  bumpFilter: 1,
  // ── THE PAINT'S OWN RELIEF ───────────────────────────────────────────────
  //
  // Separate from `bumpAmount` on purpose, and this is the knob that was asked
  // for. Road marking is not asphalt with a different colour: it is a band of
  // thermoplastic laid ON the asphalt, ~2-3 mm thick, which FILLS the aggregate
  // under it and is smoother than what it covers. Driving its relief from the
  // asphalt slider gave a white stripe wearing full chip relief, which reads as
  // chalk dust or a bleached patch — never as something applied.
  //
  // The shading half of this (roughness, wet darkening, coat) lives on the base
  // material as `lineRough` / `lineWet` / `lineCoat` / `lineCoatRough`; these
  // two are the geometry half, because the normal is built here.
  /**
   * Height of the paint plateau, in the same units as the noise octaves above.
   *
   * What you actually SEE of this is the EDGE — a plateau has no slope in its
   * middle, so the whole effect is the lip where paint meets asphalt catching a
   * grazing sun. That lip is `edgeSoft`-ish wide (~3 cm), so the slope it makes
   * is `lineBump / 0.03`: comparable to the chip octave at 0.4, which is what a
   * 2-3 mm step should look like next to 6 cm stones.
   *
   * 0 = flat paint, i.e. the old behaviour with only the fill below.
   */
  lineBump: 0.4,
  /**
   * How thoroughly the paint SMOOTHS the asphalt under it, 0..1.
   *
   * This is the half that matters more, and it is the one a plateau alone does
   * not give you: paint fills the pores, so the aggregate relief has to go away
   * beneath it. Without this the line keeps every chip and grain of the deck
   * and merely sits a little higher, which is not what paint does to a road.
   *
   * Not 1 — a thin band does still follow the substrate a little, and a
   * perfectly flat line inside a rough deck reads as a decal.
   */
  lineFill: 0.85,
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
 * keeps A's albedo and only adds the bump.
 *
 * jointSpacing stays 0. At 12 m it drew a saw-cut groove across every
 * straight and those read as mesh seams — especially wet.
 *
 * bumpGrit is 0 HERE and 1 in the module defaults, and that split is the whole
 * point of it: the octave is real and the labs show it, but the chase camera
 * provably cannot — it is faded to exactly zero on every pixel on screen, so in
 * game it was three noise evaluations per fragment returning a guaranteed zero.
 * Together with `bumpMacro` retiring to 0, the normal's cost drops from 18 noise
 * evaluations per fragment to 6 for a measured 0.060 degrees of change. See
 * tools/roadBumpVisibilityTest.mjs. Turn it back on here if road.html ever gets
 * a bonnet or photo camera.
 */
export const SURFACE_V2_GAME = {
  streakSharp: 0,
  bumpAmount: 0.05,
  jointSpacing: 0,
  bumpGrit: 0,
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
 * @param {{grit: Node, chip: Node}} fades  0..1 each, computed ONCE at this
 *   fragment — NOT per tap. Passing them in is the contract: they are built
 *   from `fwidth`, and evaluating a screen derivative separately at each of the
 *   three tap positions would differentiate the fade along with the height and
 *   put back the aliasing the fade exists to remove.
 * @param {{lateral: Node, aa: Node, plain: Node}|null} line  where the paint is
 *   AT THIS TAP. `lateral` is the only part that moves between taps — see the
 *   call site for why the across-road tap has to shift it and the along-road
 *   one does not. `aa` follows the same shared-across-taps rule as `fades`.
 *   Null when there is no paint relief to add, so the mask is not even built.
 */
function bumpHeightAt(uvn, ru, v, fades, line, on) {
  const alongOff = uvn.x.add(attribute("aAlongOffset", "float"));
  const along = alongOff.div(ru.streak);
  const across = uvn.y;
  const agg = mx_noise_float(
    vec3(along.mul(ru.aggScale), across.mul(ru.aggScale), 0.0),
  );
  let height = agg.mul(0.5).mul(v.bumpAgg);

  // The long swell. Off by default — 0.060 degrees of tilt for a THREE-OCTAVE
  // fractal per tap, i.e. half the normal's whole noise budget. See bumpMacro.
  if (on.macro) {
    const macro = mx_fractal_noise_float(
      vec3(along.mul(ru.macroScale), across.mul(ru.macroScale), 0.0), 3, 2.0, 0.5, 1.0,
    );
    height = height.add(macro.mul(0.5).mul(v.bumpMacro));
  }

  // THE MID OCTAVE — see bumpChip. ~6 cm across, mildly stretched along, which
  // puts it in the 4-10 cm band the game camera can actually resolve. This is
  // the layer that makes the deck read as laid rather than as painted, and it
  // is the one that survives past the first few metres.
  //
  // Stretched on its OWN factor rather than `ru.streak`: at 14:1 it would land
  // on top of the aggregate it is supposed to sit between, which is how the
  // gap it fills came to exist in the first place.
  const chip = mx_noise_float(
    vec3(alongOff.div(v.bumpChipStretch).mul(v.bumpChipScale),
      across.mul(v.bumpChipScale), 0.0),
  );
  const mid = chip.mul(0.5).mul(v.bumpChip).mul(fades.chip);

  // Close-up grain. Unstretched (unlike agg), ~2 cm. Independent of
  // streakSharp: that knob is the paver LINES, this is the chips between them.
  //
  // Below the game camera's resolution EVERYWHERE (see bumpChip and bumpGrit),
  // so this is explicitly the LAB / bonnet-camera layer and the game compiles it
  // out. Not dead code: the piece lab, the surface lab and any close camera are
  // inside the 6.3 m range where it is the finest thing on the deck.
  if (on.grit) {
    const grit = mx_noise_float(
      vec3(alongOff.mul(v.gritScale), across.mul(v.gritScale), 0.0),
    );
    height = height.add(grit.mul(0.5).mul(v.bumpGrit).mul(fades.grit));
  }

  const spacing = max(v.jointSpacing, float(0.001));
  const cyc = fract(uvn.x.div(spacing));
  const dJoint = abs(cyc.sub(0.5)).mul(spacing);
  const joint = oneMinus(smoothstep(float(0), v.jointWidth, dJoint))
    .mul(smoothstep(0.0, 0.001, v.jointSpacing))
    .mul(v.jointDepth)
    .negate();

  // `height` already carries the aggregate, the optional macro swell and the
  // optional grit; `mid` is the chip octave. There is deliberately no separate
  // `fines` term any more — the grit folds into `height` inside its gate.
  const asphalt = height.add(mid);
  if (!line) return asphalt.add(joint);

  // ── PAINT ───────────────────────────────────────────────────────────────
  // Evaluated through the SAME function the albedo uses, so the relief and the
  // white can never disagree about where a line is (see lineCoverageAt). The
  // dash phase comes from uvn.x, which the along tap moves, and the across
  // position from `line.lateral`, which the caller moves — between them the
  // three taps see the real 2D shape of the paint edge.
  const paint = lineCoverageAt(ru, line.lateral, uvn.x, line.aa, line.plain);
  // Fill first, THEN lift. Order matters: the plateau must not be scaled down
  // by its own fill, or a fully-filled line would also be a flat one and the
  // lip that is the entire visible effect would vanish at lineFill 1.
  return asphalt.mul(oneMinus(paint.mul(v.lineFill)))
    .add(paint.mul(v.lineBump))
    .add(joint);
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
    bumpGrit: uniform(opts.bumpGrit ?? SURFACE_V2_DEFAULTS.bumpGrit),
    bumpMacro: uniform(opts.bumpMacro ?? SURFACE_V2_DEFAULTS.bumpMacro),
    bumpChip: uniform(opts.bumpChip ?? SURFACE_V2_DEFAULTS.bumpChip),
    bumpChipScale: uniform(opts.bumpChipScale ?? SURFACE_V2_DEFAULTS.bumpChipScale),
    bumpChipStretch: uniform(opts.bumpChipStretch ?? SURFACE_V2_DEFAULTS.bumpChipStretch),
    bumpChipFade: uniform(opts.bumpChipFade ?? SURFACE_V2_DEFAULTS.bumpChipFade),
    bumpFilter: uniform(opts.bumpFilter ?? SURFACE_V2_DEFAULTS.bumpFilter),
    lineBump: uniform(opts.lineBump ?? SURFACE_V2_DEFAULTS.lineBump),
    lineFill: uniform(opts.lineFill ?? SURFACE_V2_DEFAULTS.lineFill),
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
  /**
   * Whether the paint relief is compiled in — three extra mask evaluations, one
   * per height tap. Same build-time gate as the bump, for the same reason, and
   * REGISTERED in surfaceV2NeedsRebuild below: a gate that a live slider can
   * cross without triggering a rebuild is worse than no gate at all, because
   * the knob then appears to do nothing until something else happens to rebuild.
   *
   * Note this only matters when the bump itself is on — paint relief is normal
   * work, so `bumpAmount` 0 already means no normalNode and nothing to gate.
   */
  const paintOn = (opts.lineBump ?? SURFACE_V2_DEFAULTS.lineBump) > 0
    || (opts.lineFill ?? SURFACE_V2_DEFAULTS.lineFill) > 0;
  mat._surfaceV2PaintOn = paintOn;

  /**
   * The two octaves that are gated OUT of the height by default.
   *
   * Same build-time rule as everything else here, and here it is worth the most:
   * between them these were 12 of the normal's 18 noise evaluations per fragment
   * — two thirds of its entire cost — for a combined 0.060 degrees of shading
   * normal tilt. `macro` is a 3-octave fractal at a 16.7 m period (invisible at
   * any amplitude you would want); `grit` is a 1.8 cm octave the chase camera
   * fades to exactly zero everywhere on screen.
   *
   * Both are registered in surfaceV2NeedsRebuild, so a slider crossing 0 in
   * either direction rebuilds rather than silently doing nothing.
   */
  const octaves = {
    macro: (opts.bumpMacro ?? SURFACE_V2_DEFAULTS.bumpMacro) > 0,
    grit: (opts.bumpGrit ?? SURFACE_V2_DEFAULTS.bumpGrit) > 0,
  };
  mat._surfaceV2Octaves = octaves;

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

    // THE TWO SAMPLING RATES, in UV metres per pixel, kept SEPARATE.
    //
    // They are not close to each other and treating them as one number is what
    // made the bump invisible. Down a straight at the game's chase camera the
    // along-road footprint is ~3x the across-road one, because along is the
    // grazing axis. A `max()` of the two therefore judges every octave by the
    // worse axis and deletes transverse relief that is still comfortably
    // resolved — see bumpFilter.
    const texAlong = fwidth(alongRaw);
    const texAcross = fwidth(uvn.y);

    // Fades for the two fine octaves. One evaluation each, shared by all three
    // taps: putting fwidth inside bumpHeightAt would differentiate the fade
    // itself and bring the glitter back.
    //
    // Judged on the BETTER-sampled axis (min), not the worse one. A field that
    // one axis can still resolve has content worth keeping — the sampling on
    // the other axis is now handled by the tap spacing below rather than by
    // deleting the octave outright.
    const texBest = min(texAlong, texAcross);
    const gritFade = saturate(oneMinus(texBest.mul(v.gritScale).mul(v.gritFade)));
    const chipFade = saturate(oneMinus(texBest.mul(v.bumpChipScale).mul(v.bumpChipFade)));
    const fades = { grit: gritFade, chip: chipFade };

    // TAP SPACING TRACKS THE FOOTPRINT, per axis — the filtering fix. The 4 mm
    // floor keeps the close-up identical to before; past that the difference
    // spans one pixel and measures the average slope instead of point-sampling
    // a field finer than the pixel. `bumpFilter` 0 restores the fixed spacing.
    const epsFloor = float(BUMP_SAMPLE_EPS);
    const epsX = max(epsFloor, texAlong.mul(v.bumpFilter));
    const epsY = max(epsFloor, texAcross.mul(v.bumpFilter));

    // ── WHERE THE PAINT IS, AT EACH TAP ──────────────────────────────────────
    //
    // The line mask is a function of `aLateral`, which is an ATTRIBUTE — so
    // offsetting uv.y by epsY does not move it, and a tap that does not move
    // across the paint edge measures no edge at all. The conversion needed is
    // lateral-units per metre of uv.y.
    //
    // IT CANNOT BE A CONSTANT OR A UNIFORM. `aLateral` is stamped as x / hw and
    // hw is the PIECE's own half-width — the kit ships `narrow` at 8 m and
    // `platform` at 44 m against a default 16 m road — so any single number is
    // wrong for some piece on the track.
    //
    // The ratio of the two fwidths gives it exactly, per fragment, for whatever
    // piece this is. That is safe here and it is worth saying why, because
    // differencing in screen space is precisely the bug that produced the
    // close-up "diagonals": both `aLateral` and `uv.y` are LINEAR interpolants,
    // so the ratio of their derivatives is a constant across a triangle rather
    // than a sample of a high-frequency field. It is the same thing `lateralAA`
    // has always relied on. Guarded against a zero denominator, which a fragment
    // seen exactly edge-on can produce.
    const lateral = attribute("aLateral", "float");
    const latPerMetre = fwidth(lateral).div(max(texAcross, float(1e-6)));
    // Shared by all three taps, same rule as `fades` — it comes from fwidth.
    const lineAA = fwidth(lateral).mul(0.75);
    const plain = attribute("aPlain", "float");
    const lineAt = (lat) => (paintOn ? { lateral: lat, aa: lineAA, plain } : null);

    const h0 = bumpHeightAt(uvn, ru, v, fades, lineAt(lateral), octaves);
    // The along tap moves uv.x only — `aLateral` is unchanged by walking down
    // the road, so the same lateral is correct here. It still sees the dash ends.
    const hx = bumpHeightAt(uvn.add(vec2(epsX, 0)), ru, v, fades, lineAt(lateral), octaves);
    // ...and the across tap moves both, which is the whole point of latPerMetre.
    const hy = bumpHeightAt(
      uvn.add(vec2(0, epsY)), ru, v, fades,
      lineAt(lateral.add(epsY.mul(latPerMetre))), octaves,
    );
    const tsNx = hx.sub(h0).div(epsX).mul(scale).negate();
    const tsNy = hy.sub(h0).div(epsY).mul(scale).negate();
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
  const wantPaint = (p?.lineBump ?? SURFACE_V2_DEFAULTS.lineBump) > 0
    || (p?.lineFill ?? SURFACE_V2_DEFAULTS.lineFill) > 0;
  const wantMacro = (p?.bumpMacro ?? SURFACE_V2_DEFAULTS.bumpMacro) > 0;
  const wantGrit = (p?.bumpGrit ?? SURFACE_V2_DEFAULTS.bumpGrit) > 0;
  const oct = mat._surfaceV2Octaves ?? {};
  return wantBump !== !!mat._surfaceV2BumpOn
    || wantChips !== !!mat._surfaceV2ChipsOn
    || wantStreak !== !!mat._surfaceV2StreakOn
    || wantPaint !== !!mat._surfaceV2PaintOn
    || wantMacro !== !!oct.macro
    || wantGrit !== !!oct.grit;
}
