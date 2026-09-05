/**
 * WET ROAD — the surface-condition half of the asphalt shader.
 *
 * Lives in its own module rather than inside modularRoadMaterial.js because it
 * is a self-contained model with its own vocabulary (drainage, ponding, film),
 * and because the lab has to be able to reason about it on its own. The
 * UNIFORMS, however, are declared in createRoadMaterial's `u` block like every
 * other look knob — that is what keeps them inside ROAD_LOOK_KEYS and therefore
 * inside the lab → look.json → game → track-save pipeline. Nothing here owns
 * state; it builds nodes from uniforms it is handed.
 *
 * ── WHY THIS IS MOSTLY NOT A REFLECTION ──────────────────────────────────────
 *
 * The instinct with wet roads is to reach for a reflection first. That is the
 * last 20%. A water film changes three things about the surface, in this order
 * of visual importance:
 *
 *   1. ALBEDO DROPS, hard. Water fills the pores in the asphalt; light that
 *      would have scattered straight back out gets trapped bouncing between the
 *      aggregate and the underside of the film. Real measurements put wet
 *      asphalt at roughly HALF the reflectance of the same road dry. Add a
 *      reflection without this and you get wet plastic, which is exactly what
 *      the naive version looks like.
 *   2. A SMOOTH DIELECTRIC LAYER appears over a rough one. That is a clearcoat,
 *      literally — a second GGX lobe at its own (low) roughness with its own
 *      normal, over a substrate that keeps most of its own roughness. The
 *      double lobe, sharp sheen over dull grey, IS the wet look.
 *   3. FRESNEL DOES THE REST, and this game gets that for free. Reflectance at
 *      a 5–10° grazing angle goes to ~1.0, and a chase camera looks down the
 *      road at 5–10° essentially all the time. The single most flattering
 *      viewing angle for wet asphalt is the one the player never leaves.
 *
 * So this module produces a WETNESS FIELD and leaves the shading to the caller.
 * No textures, no samplers (v3 is near the Windows WebGPU 16-sampler cap), no
 * VRAM, and it tiles down a track of any length.
 *
 * ── THE FIELD ────────────────────────────────────────────────────────────────
 *
 * Two channels, because thin film and standing water behave differently:
 *
 *   FILM  — a sheet over everything that can hold one. Darkens, smooths, and
 *           puts a slightly rough coat on top. This is "it has been raining".
 *   POND  — standing water in the low places. Darker still and near-mirror.
 *           This is "puddles", and it is what stops a wet road reading as one
 *           uniformly varnished ribbon.
 *
 * Both are shaped by things the geometry already carries, so the drainage story
 * is real rather than painted on:
 *
 *   normalWorld.y  water cannot stand on a wall. This is doing more work than it
 *                  looks like in THIS game: loops, half-pipes, wall-rides and
 *                  banked holds all have deck (aZone 1) pointing sideways or
 *                  straight down, and every one of them dries out on its own
 *                  without a single authored mask.
 *   aLateral       camber. A crowned road sheds to both edges.
 *   aCurve         bank. A banked corner sheds to the LOW side instead, so the
 *                  pooling swaps from two gutters to one. Signed, so it knows
 *                  which side that is.
 *   wheel paths    tyres squeegee. The two bands where cars actually run stay
 *                  the driest part of a wet road, and turning that up while
 *                  turning `wetAmount` down is the whole "racing line dries out
 *                  after the rain stops" effect — no second system.
 */

import {
  Fn,
  attribute,
  uv,
  vec2,
  vec3,
  float,
  mix,
  clamp,
  saturate,
  smoothstep,
  abs,
  sign,
  max,
  oneMinus,
  pow,
  cos,
  sin,
  floor,
  fract,
  length,
  dot,
  fwidth,
  normalWorld,
  positionWorld,
  normalMap,
  time,
  mx_fractal_noise_float,
} from "three/tsl";

/**
 * Authored defaults. Everything here is also a uniform in createRoadMaterial,
 * and every key is listed in WET_COLORS / WET_NUMBERS below — miss one and it
 * silently stops being tunable (tools/roadUniformSyncTest.mjs enforces it).
 *
 * The defaults describe a road a few minutes after a heavy shower, EXCEPT for
 * `wetAmount`, which is 0. A material built with `wet: true` therefore looks
 * exactly like the dry one until something turns the master up.
 */
export const WET_DEFAULTS = {
  // ── MASTER ────────────────────────────────────────────────────────────────
  /** 0 = bone dry, 1 = soaked. The one knob weather should drive. */
  wetAmount: 0,

  // ── FILM ──────────────────────────────────────────────────────────────────
  /**
   * How mirror-like a FILM is, as a fraction of what standing water is. Below 1
   * because a sheet a millimetre thick clinging to open aggregate never gets as
   * clean a reflection as a puddle with a flat surface does.
   *
   * This gates the CLEARCOAT ONLY, and that separation is the whole point of
   * the knob. It was originally a ceiling on the film channel itself, which
   * quietly throttled `wetDarken` along with the coat: at the default weather
   * the film reached 0.51, so the albedo drop came out at 23% instead of the
   * 45% the number says. Measured wet-vs-dry in the lab, that was the
   * difference between "it has rained" and "the road is slightly beige".
   * Darkening is not optional and must not be gated by a gloss control.
   */
  wetCoatStrength: 0.55,
  /**
   * How hard the sun's shadow is allowed to darken the WET extras — the
   * clearcoat's environment and the planar/rail reflections that are added as
   * emissive. Direct sun on the asphalt is already shadowed; these terms are
   * not, and they are what wash a car-shaped shadow off a soaked road.
   *
   * 0 = previous look (coat IBL and reflections ignore the shadow map).
   * 1 = those terms go fully dark in umbra, which reads as a black puddle.
   * 0.7 keeps a readable shadow without crushing the sky still sitting in the
   * water. Scales with the coat, so a dry pixel on a wet material is untouched.
   */
  wetShadow: 0.7,
  /** Albedo multiplier at full film. ~0.5 matches the measured "wet asphalt is
   *  about half as bright as dry asphalt". This is the single most important
   *  number in the file. */
  wetDarken: 0.48,
  /** SUBSTRATE roughness at full film — the asphalt UNDER the water, not the
   *  water. It drops (pores fill in) but nowhere near to a mirror; the sheen
   *  comes from the coat. Setting this near 0 is the other classic mistake and
   *  it reads as polished stone. */
  wetRough: 0.32,
  /** Clearcoat roughness of the film. Damp asphalt has a sheen, not a mirror —
   *  the mirror is reserved for `puddleCoatRough`, and keeping those two far
   *  apart is what stops the road reading as one uniformly varnished slab. */
  wetCoatRough: 0.10,
  /** Hue of the wet darkening. Near-neutral by default with a slight cool cast;
   *  push it warm for a sodium-lit street, cool for overcast. */
  wetTint: 0xbccadc,

  // ── PONDING ───────────────────────────────────────────────────────────────
  //
  // THIS is the layer that has to carry the look. A road under rain is not
  // evenly glossy from kerb to kerb — reference photography of a wet circuit is
  // dark damp asphalt with a handful of big, sharply bounded sheets of standing
  // water in it, and those sheets are the only part that behaves like a mirror.
  // So the film is tuned down to "damp" (wetCoatStrength, wetCoatRough) and the
  // contrast between the two is turned up here: fewer, larger, harder-edged.
  /** Master for the standing-water layer. 0 = an evenly wet road, no puddles. */
  puddleAmount: 1,
  /**
   * Cycles per metre ACROSS the road. 0.2 ⇒ sheets about 5 m across and, with
   * `puddleStreak`, roughly 15 m long.
   *
   * MEASURED, not guessed. The first pass used 0.06, reasoning that puddles are
   * big; across a 16 m deck that is under one cycle, so the whole road became a
   * single slow gradient with no puddle edge anywhere in it. The false-colour
   * view (D in the lab) is what showed it — on screen it just looked like the
   * ponding layer was not working.
   */
  puddleScale: 0.2,
  /** How many times longer puddles are ALONG the road than across. Water pools
   *  in the direction the road runs, but nothing like as strongly as the
   *  asphalt's own wear streaks (`streak`, 14), so this is its own number. */
  puddleStreak: 3.0,
  /** Noise level above which water stands. Raise for a nearly-drained road. */
  puddleThreshold: 0.58,
  /** Edge feather. A puddle edge in life is a waterline a few centimetres
   *  wide — sharp. This was 0.09, which over a 17 m sheet is a metres-long
   *  gradient, and a puddle with no edge is just a damp patch. */
  puddleSoft: 0.035,
  /** FURTHER albedo multiplier inside standing water, on top of wetDarken. Deep
   *  water traps nearly everything; the puddle should read close to black with
   *  the sky sitting on it. */
  puddleDarken: 0.42,
  /** Clearcoat roughness in standing water. This one really is near-glass. */
  puddleCoatRough: 0.012,
  // ── THE WATERLINE ─────────────────────────────────────────────────────────
  //
  // The dark rim at a puddle's edge, and it is what gives standing water DEPTH
  // instead of reading as a patch of gloss painted on the road. Without it a
  // puddle is a smooth ramp from damp to mirror with no boundary anywhere, and
  // the eye takes it for a change of finish rather than a body of water.
  //
  // Physically it is the shallowest water there is: a few millimetres over dark
  // aggregate, too thin to have any depth of its own to brighten it, and the
  // meniscus tilts away from the sky so it returns less of it. Darker than both
  // the dry road AND the puddle centre — which is exactly why it draws an
  // outline rather than a gradient.
  //
  // IT COSTS TWO MULTIPLIES. `pond` is already a 0..1 ramp, so 4·pond·(1−pond)
  // is a parabola that peaks at 1 exactly where pond crosses 0.5 — the
  // waterline — and falls to 0 both on the dry side and in the deep. No new
  // field, no second threshold, no extra noise.
  /** Extra albedo darkening at the rim, on top of the wet and puddle terms. */
  waterlineDark: 0.55,
  /** How TIGHT the rim is. 1 is a broad band across the whole transition; higher
   *  narrows it to a line. Above about 4 it starts to alias on a soft edge. */
  waterlineSharp: 2.5,

  // ── DRAINAGE ──────────────────────────────────────────────────────────────
  /** Drainage potential at which pooling starts to be favoured, 0..1. */
  wetDrainStart: 0.3,
  /** Weight of the CAMBER term — a crowned road shedding to both edges. */
  wetCamber: 1.0,
  /** Weight of the BANK term — a banked corner shedding to its low side. Above
   *  1 because a bank is a far stronger slope than a camber. */
  wetBank: 1.1,
  /** Curvature (1/m) at which a corner counts as fully banked. 0.035 ≈ R28. */
  wetCurveRef: 0.035,
  /** How far downhill drainage lowers the ponding threshold. This is what makes
   *  puddles collect in the gutter and on the low side of a bank rather than
   *  sitting wherever the noise happened to peak. */
  wetDrainStrength: 0.22,

  // ── WHERE WATER CANNOT STAY ───────────────────────────────────────────────
  /** normalWorld.y below which the surface is a wall and holds nothing. */
  wetSlopeMin: 0.45,
  /** normalWorld.y above which it is flat enough to hold water normally. */
  wetSlopeMax: 0.86,
  /** How thoroughly the wheel paths are squeegeed clear, 0..1. Turn this up and
   *  wetAmount down for a drying racing line. */
  wetWheelClear: 0.45,

  // ── SURFACE BREAK-UP ──────────────────────────────────────────────────────
  //
  // NOT WAVES. The first version of this drifted a set of sine swells across
  // the road and it read as a river: standing water on tarmac has no current
  // and no wind fetch, so a reflection that crawls is instantly wrong, and it
  // was the first thing anyone said about it.
  //
  // What actually breaks up a reflection on a wet road is the ROAD — aggregate
  // and paver ripple poking through a film that is only a millimetre or two
  // deep. So the same cheap wave sum is used as a STATIC height field standing
  // in for that surface, and it is faded out as the water gets deeper
  // (`rippleDamp`), because a real puddle deep enough to submerge the chips is
  // a mirror. Shallow film: textured. Standing water: glass. That contrast is
  // most of what makes puddles read as puddles.
  /** Slope of the break-up. Small — this is wet chip showing through a film. */
  rippleAmp: 0.05,
  /** Cycles per metre across the road. Roughly aggregate-sized. */
  rippleScale: 1.6,
  /**
   * Drift speed, and 0 is the correct default — see above. Turn it up ONLY for
   * water that really is moving: a gutter running downhill, or the surface of
   * a puddle during active rainfall.
   */
  rippleSpeed: 0,
  /** Elongation along the road, following the asphalt's own wear direction. */
  rippleStretch: 2.5,
  /**
   * How completely standing water flattens the break-up out. 1 = a full puddle
   * is perfect glass; 0 = puddles are as textured as the film around them.
   */
  rippleDamp: 0.9,

  // ── IMPACT RINGS ──────────────────────────────────────────────────────────
  //
  // The rings a raindrop leaves when it lands in standing water. This is the
  // ONE thing that says the rain is falling NOW rather than having fallen an
  // hour ago, and without it the wet road and the rain are two effects that
  // never acknowledge each other.
  //
  // It is also the exact inverse of the break-up above, and that is the point.
  // `rippleDamp` fades the aggregate texture OUT as the water deepens, because
  // a puddle deep enough to submerge the chips is glass. Rings do the opposite:
  // a one-millimetre film has nothing to ring, so they fade IN with depth. The
  // two together mean a puddle is a mirror when it is merely wet and a live
  // surface while it is being rained on, which is the whole read.
  //
  // BUILD-TIME, not a uniform at zero. Nine cells of trig per fragment is not
  // something a dry track should evaluate and discard — see `impacts` on
  // createWetShading. `impactAmount` is the artistic fade WITHIN a build.
  //
  // MEASURED, in game, on the loop-back showcase parked where puddles fill the
  // frame, four interleaved rounds of the road material rebuilt each way with
  // the world rain isolated off: **+0.131 ms at 1920x889**, and +1.310 ms at
  // pixelRatio 3. Ten times the cost for nine times the pixels, which is what
  // pure fill on the largest surface on screen looks like. Roughly 2.5% of a
  // 5.2 ms frame, and about 40% on top of what the rest of the wet road costs.
  // `setRoadImpacts(false)` in roadGame is the machine-level off switch.
  /** Master, 0..1. The game drives this from the rain switch. */
  impactAmount: 1,
  /**
   * Slope of a ring at its steepest. Deliberately the same order as
   * `rippleAmp` so the two normal contributions are comparable numbers.
   *
   * Judged in game on a full-width puddle: 0.09 is barely there, 0.30 reads as
   * a downpour on a pond and starts to fight the reflection it is supposed to
   * be breaking up. 0.16 is a shower.
   */
  impactAmp: 0.16,
  /** Ring cells per metre. 0.75 ≈ one impact site every 1.3 m, which is dense
   *  enough that a puddle always has two or three rings alive in it. */
  impactScale: 0.75,
  /** How often each cell fires, in rings per second. */
  impactSpeed: 1.1,

  // ── MIRRORED-GEOMETRY RAIL REFLECTION ─────────────────────────────────────
  //
  // The guardrail's reflection, drawn as a mirrored COPY of the rail seen by
  // the ordinary camera — not as a mirrored camera, and not solved in the
  // shader. Both of those shipped here first and both failed the same way.
  //
  // A planar mirror flips the world about ONE plane, fitted under the car. That
  // is exact for water, which never bends. On a crest the road climbs above
  // that plane while the flipped image always goes down, so the reflected rail
  // descends as the real rail climbs — measured on Apex Parkour's dip, rails
  // 20-40 m out sit up to 12 m off the plane, displacing their images by twice
  // that. No fade on the RECEIVING fragment fixes that, because the error is in
  // the mirror's CONTENT; three of them were tried and all three failed.
  //
  // The analytic replacement was correct — it solved a line/plane intersection
  // in each fragment's own tangent frame, so it followed any slope — but it
  // could only draw the rail's colour BANDS, and a flat band of colour at a
  // constant height reads as paint on the road, not as a reflection.
  //
  // What is left is the oldest trick there is: build the reflected object and
  // look at it normally. buildMirroredRailGeometry flips each rail vertex about
  // the deck AT ITS OWN STATION, so a crest, a dip, a bank and the inside of a
  // loop all mirror correctly — there is no plane in the method to be off. The
  // real camera then renders it, which puts it at the screen position where the
  // reflection belongs, so the road samples it at screenUV with no projection.
  //
  // The cost is one extra pass over one merged mesh, skipped entirely when the
  // road is dry. What it still cannot do is occlusion: it is an image of the
  // mirrored rail with nothing in front of it, so it shows through the car.
  /** Master, 0 = off. 1 = exactly the mirrored rail as rendered; unlike the
   *  colour bands this replaced, that is the physically right answer. */
  railReflect: 1.0,
  /**
   * METRES between a mirrored rail and the fragment showing it, before that
   * reflection is treated as belonging to somewhere else and faded out.
   *
   * The pre-mirror pass has no occluders (see modularRoadReflection), so
   * without this the road shows the mirrored rail of a section hidden behind a
   * crest — the reflection draws straight through the hill. A correct
   * reflection sits a metre or two from its own deck; a see-through is tens of
   * metres, so almost any value in between separates them.
   *
   * 4 m is deliberately loose. The rail stands ~0.8 m above the deck and the
   * mirror the same below, but on a bank or the inside of a loop the receiving
   * fragment can be a couple of metres off along the view ray without being
   * wrong. Tighten it if see-through survives near the crest line; loosen it if
   * legitimate reflections cut off early on banked pieces.
   *
   * Tall pre-mirrored props (neon arm ~8 m) need more: their virtual image is
   * that far below the deck, so the along-ray gap at a chase-camera angle is
   * ~25–35 m. roadGame raises this uniform to 36 m while those copies exist.
   */
  railDepthTol: 4.0,
  /**
   * Fraction of `railDepthTol` the cutoff fades across. Small = a clean edge.
   *
   * This is the crest knob. Wide fades do not hide the limitation, they change
   * what it looks like: a reflection that dissolves reads as a rail sinking
   * into the road, while one that stops reads as a rail passing out of sight
   * behind the hill — which is what is actually happening. Raise it only if the
   * edge starts to look cut with scissors.
   */
  railDepthSoft: 0.15,

  // ── PLANAR REFLECTION ─────────────────────────────────────────────────────
  // Only does anything when the material was built with a reflection texture
  // (see modularRoadReflection.js). These are the AUTHORED half; the plane and
  // its matrix are per-frame runtime state and live in `mat._reflectUniforms`,
  // deliberately outside the look so a saved track cannot pin a stale matrix.
  /**
   * Overall reflection brightness. 1 = exactly what the mirror rendered.
   *
   * Above 1 by default, and that is a deliberate cheat rather than a fudge for a
   * bug. See reflectFresnel: at the angle a chase camera actually sits at, the
   * physically correct reflectance is about a tenth, and a tenth of a dark car
   * on a lit road is invisible. Every racing game pushes this.
   */
  reflectStrength: 1.4,
  /**
   * Fresnel falloff exponent. LOWER = the reflection survives at steeper
   * viewing angles.
   *
   * This exists because of a measured gap between the lab and the game.
   * wet-road-lab's camera sits 1.55 m up at 7.5 m back — about 12 degrees off
   * the deck, cos(theta) 0.20 — where the reflection is obvious. road.html's
   * chase camera is 3.8 m up at 8.7 m back, about 24 degrees, cos(theta) 0.44.
   * At the original hard-coded exponent of 4 that is 0.101 against the lab's
   * 0.406: four times weaker, which took the same correct, correctly-placed
   * reflection from clearly visible to not visible at all.
   *
   * Schlick says 5 (with an F0 floor), so 4 was already generous and dropping to
   * 2.5 is frankly artistic licence. It is the right kind of licence: the real
   * cue a wet road gives you is that SOMETHING is mirrored in it, and a curve
   * tuned for a camera lying on the tarmac does not deliver that from a chase
   * camera. Raise it back toward 4-5 for a physically tighter falloff.
   */
  reflectFresnel: 2.5,
  /**
   * How far the water surface pushes the reflection around, in UV. This is what
   * stops it looking like a decal: a reflection that lands on a rippled film
   * has to break up with the film, and it uses the same normal the clearcoat
   * does, so a puddle (flat, see rippleDamp) reflects sharply while the damp
   * asphalt around it smears.
   */
  reflectDistort: 0.05,
  /**
   * How far up the reflection mip chain a rough surface reaches, as a
   * multiplier on the coat roughness. 1 = a fully rough coat samples the
   * smallest mip; the shipped coat roughness is 0.012 in a puddle and 0.1 on
   * damp film, so most of the road sits low in the chain and puddles stay
   * near-sharp. Zero restores the old always-LOD-0 look, aliasing included.
   */
  reflectBlur: 3.2,
  /**
   * Vertical smear of the reflection, in screen-uv per unit coat roughness.
   *
   * A wet road stretches reflections ALONG the view direction rather than
   * blurring them evenly — at a grazing angle a small normal perturbation
   * swings the reflected ray far vertically and barely across. 0.25 puts the
   * damp film at about 0.025 uv of smear and a puddle at 0.003, so standing
   * water still mirrors cleanly. Zero collapses it to a plain vertical average
   * of three identical taps, i.e. the previous look at three times the cost —
   * turn the taps off in code if you want it truly gone.
   */
  reflectStretch: 0.25,
  /**
   * How much of the wet treatment the KERB gets, relative to the deck.
   *
   * Below 1 because a painted kerb is not asphalt: paint is close to
   * non-porous, so it neither darkens as much nor holds water in its surface
   * the way open aggregate does. But it is emphatically not 0, which is what it
   * was — kerbs were excluded entirely, and since the drainage model pools
   * water against them (|aLateral| near 1 is the bottom of the camber) that
   * removed the wettest strip of the road. It also deleted the guardrail's
   * reflection, which lands mostly on that strip.
   */
  kerbWet: 0.6,
  /**
   * Metres a surface may sit OFF the mirror plane before its reflection is gone.
   *
   * This is the fade that matters on a curve, and the original had only a
   * spherical distance falloff, which is the wrong criterion. A planar mirror is
   * exact only ON its plane; the error in a reflected position grows with how
   * far the surface has left it. A straight deck IS the plane, so deviation is
   * ~0 and the reflection can run for tens of metres. An R26 curve deviates
   * roughly d²/2R — about 0.5 m at 5 m out and 1.9 m at 10 m — so it should die
   * within a few metres, which a radius fade tuned for straights never did.
   * That mismatch is exactly the smeared, morphed guardrail on curves.
   *
   * Self-tuning as a result: one number gives long reflections on straights and
   * short ones through corners, with no per-piece authoring.
   */
  reflectPlaneTol: 0.7,
  /**
   * METRES of reflection displacement a fragment may show before it is faded
   * out. This is the term that governs banks, crests and dips.
   *
   * Two earlier attempts measured the wrong thing. `reflectPlaneTol` fades by
   * the fragment's own distance from the plane, which on a bank never fires —
   * the deck under the car IS the plane. Then a coplanarity cosine, which does
   * not fire either: over a crest the deck's normal diverges by only 5-8
   * degrees, comfortably inside any sane angular threshold, while the reflected
   * guardrail is already displaced by metres. The visible symptom is not a
   * wobble but an INVERSION — the mirrored rail descends while the real rail
   * climbs — because the road ahead is being told it sits at the car's height
   * and angle when it has since risen.
   *
   * Distance and angle only matter multiplied together. A point `d` away on a
   * surface whose normal has turned by `t` from the plane has its reflection
   * displaced by roughly `d * sin(t)`: 8 degrees at 10 m is 1.4 m of error,
   * which is exactly the scale of the artefact. Fading on that number fades on
   * the thing you can actually see.
   */
  reflectErrTol: 0.8,
  /** Metres from the car's contact point at which the reflection has faded to
   *  nothing. The mirror is only geometrically right ON its plane, and a deck
   *  that banks or loops leaves that plane quickly — so it is faded out rather
   *  than left to smear across the curve. */
  reflectFade: 26,
};

/** Wet uniforms authored as sRGB hex numbers. */
export const WET_COLORS = ["wetTint"];

/** Wet uniforms authored as plain numbers. */
export const WET_NUMBERS = [
  "wetAmount", "wetCoatStrength", "wetShadow", "wetDarken", "wetRough", "wetCoatRough",
  "puddleAmount", "puddleScale", "puddleStreak", "puddleThreshold",
  "puddleSoft", "puddleDarken", "puddleCoatRough", "waterlineDark", "waterlineSharp",
  "wetDrainStart", "wetCamber", "wetBank", "wetCurveRef", "wetDrainStrength",
  "wetSlopeMin", "wetSlopeMax", "wetWheelClear",
  "rippleAmp", "rippleScale", "rippleSpeed", "rippleStretch", "rippleDamp",
  "impactAmount", "impactAmp", "impactScale", "impactSpeed",
  "reflectStrength", "reflectFresnel", "reflectDistort", "reflectBlur", "reflectStretch", "reflectFade",
  "reflectPlaneTol", "reflectErrTol",
  "railReflect", "railDepthTol", "railDepthSoft",
  "kerbWet",
];

export const WET_KEYS = [...WET_COLORS, ...WET_NUMBERS];

/**
 * The wetness field.
 *
 * @param {object} u        createRoadMaterial's uniform bag (must carry WET_KEYS).
 * @param {Node} wheelPath  The deck's existing wheel-path mask — passed in, not
 *   recomputed, so the whole drainage model costs no new noise beyond the one
 *   ponding octave pair below.
 * @returns {Node<vec2>} x = film 0..1, y = pond 0..1. Build it ONCE and
 *   reference the same node from colour, roughness and clearcoat; the graph
 *   then emits it a single time per fragment.
 */
export function createWetField(u, wheelPath) {
  return Fn(() => {
    const lateral = attribute("aLateral", "float");
    // NOTE there is no `along`/`across` here any more. The ponding field used to
    // ride per-piece arc length plus `aAlongOffset` — a random phase per piece —
    // which decorrelated neighbouring pieces but guaranteed a hard edge through
    // every puddle at every joint. It is world-space now; see the blob below.

    // WALLS SHED. The one term that makes this work on a stunt track: a loop's
    // deck is the same aZone as a straight's, and without this the inside of
    // every loop would be a hanging sheet of water.
    const flat = smoothstep(u.wetSlopeMin, u.wetSlopeMax, normalWorld.y);

    // DRAINAGE POTENTIAL, 0..1, "how far downhill is this point".
    //
    // Two shapes blended by how hard the corner is. Camber is symmetric — both
    // gutters — while a bank is one-sided, and `aCurve` being signed is what
    // tells us which side. (+aCurve is a right-hand corner; the deck tips down
    // toward the inside, which is +aLateral. Note this is the OPPOSITE sign to
    // driftField, where the rubber sits toward the corner's outside.)
    const k = clamp(attribute("aCurve", "float").div(u.wetCurveRef), -1.0, 1.0);
    const corner = abs(k);
    const camberD = abs(lateral).mul(u.wetCamber);
    const bankD = saturate(lateral.mul(sign(k)).mul(0.5).add(0.5)).mul(u.wetBank);
    const drain = mix(camberD, bankD, corner);
    const pool = smoothstep(u.wetDrainStart, 1.0, drain);

    // Tyres clear water. Also the drying racing line — see wetWheelClear.
    const clear = oneMinus(wheelPath.mul(u.wetWheelClear));

    // Everything scales off this, so wetAmount 0 really is dry: both channels
    // go to exactly zero and every wet term below collapses to a no-op mix.
    const base = u.wetAmount.mul(flat).mul(clear);

    // Full range on purpose: this channel drives the albedo drop, and that is
    // the term that has to be allowed to reach its authored value.
    const film = saturate(base);

    // PONDING. The one genuinely new cost in this module: a 2-octave fractal at
    // puddle scale. The deck's existing `macro` field cannot stand in for it —
    // at macroScale 0.06 × streak 14 its period is ~16 m across and ~230 m
    // along, i.e. one broad gradient, which thresholds into a vague dark half
    // of the road rather than into puddles.
    // WORLD SPACE, for the same reason the deck's macro tone is — and here the
    // symptom is worse. Puddles are ~5 m across and ~15 m long, so a field driven
    // by per-piece arc length puts a HARD EDGE through standing water at every
    // joint: half a puddle, then bare road, then the other half offset sideways.
    // A tonal step can pass as variation; a severed puddle cannot.
    //
    // `puddleStreak` therefore no longer stretches this along a per-piece axis —
    // it now elongates the pond field along WORLD Z. On a straight that is still
    // "along the road" for the usual track orientation, and on a curve it reads
    // as water pooling with the terrain rather than with the ribbon, which is
    // what water actually does.
    const pw = positionWorld.mul(u.puddleScale);
    const blob = mx_fractal_noise_float(
      vec3(pw.x, pw.y, pw.z.div(u.puddleStreak)), 2, 2.0, 0.5, 1.0,
    ).mul(0.5).add(0.5);

    // Downhill lowers the bar, so water collects where it would actually run.
    const thr = u.puddleThreshold.sub(pool.mul(u.wetDrainStrength));
    const pond = smoothstep(thr, thr.add(u.puddleSoft), blob)
      .mul(u.puddleAmount).mul(base);

    return vec2(film, saturate(pond));
  })();
}

/**
 * Tangent-space normal for the water surface, packed 0..1 for normalMap.
 *
 * A STATIC height field by default — see the note on rippleSpeed. What it
 * represents is the asphalt under a thin film, not waves on top of it.
 *
 * THREE DIRECTIONAL SINE WAVES, not noise, and the reason is derivatives. A
 * noise height field needs finite differences — three extra noise samples per
 * octave — just to get a normal out. A sine's derivative is a cosine: free,
 * exact, and six trig calls for the whole thing. For an anisotropic ripple
 * running with the road it is also a fair likeness of what a paver leaves
 * behind, which is what `rippleStretch` is stretching it along.
 *
 * Amplitude is deliberately NOT rescaled by `rippleScale`, so frequency and
 * steepness stay independent knobs instead of fighting each other.
 */
export function wetRippleNormal(u) {
  return packSlope(wetBreakupSlope(u));
}

/**
 * Pack a tangent-space SLOPE (dh/dx, dh/dy) as a normal for `normalMap`.
 *
 * Split out because there are now two height fields — the break-up and the
 * impact rings — and they must be summed as SLOPES and packed ONCE. Packing
 * each and blending the results would normalise twice and give a surface that
 * is neither field, and it would leave the clearcoat and the two reflection
 * paths reading different wobbles, which is the bug tools/roadWetReflectionTest
 * exists to prevent.
 */
function packSlope(slope) {
  return vec3(slope.x.negate(), slope.y.negate(), 1.0).normalize().mul(0.5).add(0.5);
}

/** The paver/aggregate break-up, as a raw slope. See wetRippleNormal. */
function wetBreakupSlope(u) {
  return Fn(() => {
    const a = uv().x.div(u.rippleStretch).mul(u.rippleScale);
    const b = uv().y.mul(u.rippleScale);
    const t = time.mul(u.rippleSpeed);

    // [dirX, dirY, frequency, amplitude, drift speed]
    const WAVES = [
      [1.0, 0.35, 1.0, 1.0, 1.0],
      [-0.6, 1.0, 1.73, 0.55, 1.31],
      [0.25, -1.0, 2.91, 0.3, 0.77],
    ];

    let dha = float(0);
    let dhb = float(0);
    for (const [dx, dy, f, amp, sp] of WAVES) {
      const phase = a.mul(dx * f).add(b.mul(dy * f)).add(t.mul(sp));
      const c = cos(phase).mul(amp * f);
      dha = dha.add(c.mul(dx));
      dhb = dhb.add(c.mul(dy));
    }

    // DISTANCE FADE. These sines are ~1.6 cycles/m (and the third wave is
    // 2.91× that). On a 16 m road the chase camera never sees enough deck
    // for the undersampling to read as a pattern. On a 200 m lot it fills
    // the screen at 5–10° and the waves beat against the pixel grid into
    // horizontal bands — worse with distance, which is the tell.
    //
    // Same rule the dry aggregate already uses: once a pixel covers half a
    // cycle of the HIGHEST wave, the slope is noise, not ripple. Fade the
    // amplitude to zero rather than let it alias. fwidth is a 2×2 screen
    // derivative, so triangle size does not matter — a subdivided lot
    // would band the same way without this.
    const texel = max(fwidth(a), fwidth(b));
    const fade = saturate(oneMinus(texel.mul(2.91 * 2.0)));
    const g = u.rippleAmp.mul(fade);
    return vec2(dha.mul(g), dhb.mul(g));
  })();
}

/* ── IMPACT RINGS ─────────────────────────────────────────────────────────── */

/** Radians of wavelet per cell unit. ~4.9 cycles across a cell. */
const RING_K = 31.0;
/** How far a ring's front travels, in cell units, over one cycle. Kept under
 *  the 3×3 neighbourhood's reach so no ring is ever clipped by the cell it
 *  strayed out of — which would read as rings dying against invisible walls. */
const RING_REACH = 1.5;

/** hash: cell id -> [0,1). */
const ringHash1 = /*@__PURE__*/ Fn(([p]) =>
  fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453)));

/** hash: cell id -> a jitter inside the cell. */
const ringHash2 = /*@__PURE__*/ Fn(([p]) => fract(
  sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))).mul(43758.5453)));

/**
 * Concentric rings spreading from raindrop impacts, as a raw slope.
 *
 * ── WHY A CELL GRID AND NOT PARTICLES ───────────────────────────────────────
 *
 * There is no list of impacts and nothing to update. The plane is cut into
 * cells; each cell hashes its own impact point and its own phase, so it fires
 * on its own clock forever, for free. 3×3 because a ring outgrows the cell that
 * spawned it and a fragment has to be able to see its neighbours' rings.
 *
 * Unrolled in JS rather than looped in TSL — nine compile-time offsets, the
 * same shape the three break-up waves above already use, and it sidesteps the
 * nested-Loop aliasing trap this repo has already been bitten by.
 *
 * ── WHY THE SLOPE IS ANALYTIC ───────────────────────────────────────────────
 *
 * The reference implementation central-differences the windowed sine at ±0.001
 * to get its derivative — two sines and four smoothsteps per cell. But the
 * height is W(m)·sin(k·m), so dh/dm = W·k·cos(k·m) + W'·sin(k·m), and with
 * k = 31 the first term is an order of magnitude larger than the second.
 * Keeping only it costs ONE cosine and two smoothsteps, and the dropped term is
 * bounded by W' — which is only non-zero where W is heading for zero anyway.
 *
 * The k factor is then dropped as well, so `impactAmp` is a slope in the same
 * units as `rippleAmp` instead of a number 31× smaller.
 *
 * ── WORLD SPACE, NOT UV ─────────────────────────────────────────────────────
 *
 * A ring is an event at a PLACE. On `uv()` the pattern would restart at every
 * piece seam and change size whenever a piece was rescaled — the same failure
 * the road-surface lab already catalogued for procedural noise on this deck.
 */
export function wetImpactSlope(u) {
  return Fn(() => {
    const p = positionWorld.xz.mul(u.impactScale).toVar();
    const cell = floor(p).toVar();
    const t = time.mul(u.impactSpeed);

    let gx = float(0);
    let gy = float(0);
    for (let ox = -1; ox <= 1; ox++) {
      for (let oz = -1; oz <= 1; oz++) {
        const id = cell.add(vec2(ox, oz));
        // Impact point: the cell's corner plus its own fixed jitter, so sites
        // are irregular but never move.
        const centre = id.add(ringHash2(id));
        // Each cell on its own clock, offset by a per-cell constant so they do
        // not all fire on the same beat.
        const phase = fract(t.add(ringHash1(id))).toVar();
        const d = centre.sub(p);
        const r = length(d).toVar();
        // Signed distance to the expanding front: negative inside it.
        const m = r.sub(phase.mul(RING_REACH)).toVar();
        // A band of wavelets just INSIDE the front and nothing outside it.
        // Written as `1 - smoothstep(hi, lo)` rather than smoothstep with its
        // arguments reversed: WGSL leaves that undefined when low >= high.
        const w = m.smoothstep(-0.55, -0.28)
          .mul(m.smoothstep(-0.28, 0.0).oneMinus());
        // Amplitude dies over the cycle, so a ring fades rather than vanishing.
        const amp = phase.oneMinus().mul(phase.oneMinus());
        const dh = cos(m.mul(RING_K)).mul(w).mul(amp);
        // Radially outward from the impact. Guarded: r is exactly 0 at the
        // impact point itself, and normalize() there is a NaN that propagates
        // into the clearcoat normal and blackens the fragment.
        const inv = r.max(1e-4).reciprocal();
        gx = gx.add(d.x.mul(inv).mul(dh));
        gy = gy.add(d.y.mul(inv).mul(dh));
      }
    }

    // SAME ANTI-ALIASING RULE AS THE BREAK-UP, and it matters more here: the
    // wavelets run at ~4.9 cycles per cell unit, comfortably the highest
    // frequency on this surface. Past a pixel per half-cycle the rings stop
    // being rings and start being moiré that crawls with the camera — worst at
    // exactly the grazing angles a chase camera spends its life at.
    const texel = max(fwidth(p.x), fwidth(p.y));
    const fade = saturate(oneMinus(texel.mul((RING_K / Math.PI))));
    const g = u.impactAmp.mul(fade);
    return vec2(gx.mul(g), gy.mul(g));
  })();
}


/**
 * Everything the caller needs to shade a wet deck, built from one field.
 *
 * Returned rather than applied, because the deck's colour and roughness are
 * assembled from a dozen other terms in modularRoadMaterial.js and this module
 * has no business knowing the order they go in.
 *
 * @returns {{
 *   field: Node, film: Node, pond: Node, coat: Node,
 *   albedoScale: Node, tint: Node, substrateRough: Node,
 *   coatRough: Node, coatNormalPacked: Node,
 * }}
 */
export function createWetShading(u, wheelPath, { impacts = false } = {}) {
  const field = createWetField(u, wheelPath);
  const film = field.x;
  const pond = field.y;
  // COAT STRENGTH, which is not the same thing as wetness. A film reflects less
  // cleanly than standing water does (wetCoatStrength), and the two channels are
  // computed independently — a puddle can sit in a wheel path the film term has
  // partly squeegeed — so the coat takes whichever wins rather than assuming
  // ponding implies film.
  const coat = saturate(max(film.mul(u.wetCoatStrength), pond));

  /**
   * The puddle's EDGE, 0..1 — see waterlineDark. Peaks where `pond` crosses
   * 0.5 and vanishes both on the dry side and in the deep, so it traces the
   * waterline without needing a second threshold or another noise sample.
   */
  const waterline = pow(saturate(pond.mul(oneMinus(pond)).mul(4.0)), u.waterlineSharp);

  /**
   * ONE SLOPE FIELD, packed ONCE, for the clearcoat and both mirrors.
   *
   * The two contributions are weighted here rather than outside, because they
   * want OPPOSITE things from the water and a single `coatNormalGain` cannot
   * express both:
   *
   *   • the break-up is the asphalt showing through, so standing water DROWNS
   *     it (`rippleDamp`) — that contrast is what makes a puddle read as a
   *     puddle rather than as more textured road;
   *   • the rings are the water's own surface, so they need standing water to
   *     exist on at all. A film a millimetre deep has nothing to ring.
   *
   * `coatNormalGain` is therefore now just the wetness gate, and the relative
   * weighting lives in here where both terms can see `pond`.
   *
   * The damping consequently happens BEFORE the pack rather than after it,
   * which is very slightly different arithmetic (the pack normalises). At these
   * slopes — 0.05 to 0.15, so z stays above 0.99 — the difference is far below
   * anything visible, and having one field beats having two that agree by hand.
   */
  const slope = impacts
    ? wetBreakupSlope(u).mul(oneMinus(pond.mul(u.rippleDamp)))
      .add(wetImpactSlope(u).mul(pond).mul(u.impactAmount))
    : wetBreakupSlope(u).mul(oneMinus(pond.mul(u.rippleDamp)));

  return {
    field,
    film,
    pond,
    coat,
    waterline,
    /**
     * Multiply the deck albedo by this. Three terms, in the order water
     * actually applies them: the film darkens everything it wets, standing
     * water darkens further, and the rim darkens further still — a waterline is
     * the darkest part of a puddle, being too thin to have any depth to
     * brighten it.
     */
    albedoScale: mix(float(1), u.wetDarken, film)
      .mul(mix(float(1), u.puddleDarken, pond))
      .mul(oneMinus(waterline.mul(u.waterlineDark))),
    /** ...and by this, for the hue of the darkening. */
    tint: mix(vec3(1, 1, 1), u.wetTint, film),
    /** Blend the deck's own roughness toward this by `film`. */
    substrateRough: u.wetRough,
    coatRough: mix(u.wetCoatRough, u.puddleCoatRough, pond),
    coatNormalPacked: packSlope(slope),
    /**
     * How hard to push that normal: simply how wet the fragment is.
     *
     * The pond damping that used to live here has moved into `slope` above —
     * it applies to the break-up ONLY, and the rings need the opposite sign of
     * the same quantity. Anything that is true of the whole water surface
     * belongs here; anything that distinguishes the two fields belongs there.
     */
    coatNormalGain: coat,
  };
}

/**
 * Clearcoat normal node, ready to assign. Split out only because `normalMap`
 * has to be told how hard to push, and the answer is "as hard as it is wet" —
 * a dry fragment gets a scale of 0, which is an exactly flat normal, so the
 * ripple fades in with the water instead of being masked afterwards.
 */
export function wetClearcoatNormal(wetShading) {
  const w = wetShading.coatNormalGain;
  return normalMap(wetShading.coatNormalPacked, vec2(w, w));
}
