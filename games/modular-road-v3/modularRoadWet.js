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
  step,
  abs,
  sign,
  max,
  oneMinus,
  cos,
  normalWorld,
  positionWorld,
  cameraPosition,
  dot,
  length,
  dFdx,
  dFdy,
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
  wetCoatStrength: 0.45,
  /** Albedo multiplier at full film. ~0.55 matches the measured "wet asphalt is
   *  about half as bright as dry asphalt". This is the single most important
   *  number in the file. */
  wetDarken: 0.55,
  /** SUBSTRATE roughness at full film — the asphalt UNDER the water, not the
   *  water. It drops (pores fill in) but nowhere near to a mirror; the sheen
   *  comes from the coat. Setting this near 0 is the other classic mistake and
   *  it reads as polished stone. */
  wetRough: 0.38,
  /** Clearcoat roughness of the film. Damp asphalt has a sheen, not a mirror —
   *  the mirror is reserved for `puddleCoatRough`, and keeping those two far
   *  apart is what stops the road reading as one uniformly varnished slab. */
  wetCoatRough: 0.16,
  /** Hue of the wet darkening. Near-neutral by default with a slight cool cast;
   *  push it warm for a sodium-lit street, cool for overcast. */
  wetTint: 0xdfe6ef,

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
  puddleDarken: 0.55,
  /** Clearcoat roughness in standing water. This one really is near-glass. */
  puddleCoatRough: 0.02,

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
  "wetAmount", "wetCoatStrength", "wetDarken", "wetRough", "wetCoatRough",
  "puddleAmount", "puddleScale", "puddleStreak", "puddleThreshold",
  "puddleSoft", "puddleDarken", "puddleCoatRough",
  "wetDrainStart", "wetCamber", "wetBank", "wetCurveRef", "wetDrainStrength",
  "wetSlopeMin", "wetSlopeMax", "wetWheelClear",
  "rippleAmp", "rippleScale", "rippleSpeed", "rippleStretch", "rippleDamp",
  "reflectStrength", "reflectFresnel", "reflectDistort", "reflectFade",
  "reflectPlaneTol", "reflectErrTol",
  "railReflect",
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
    const along = uv().x; // metres along the path
    const across = uv().y; // metres across the developed profile

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
    const blob = mx_fractal_noise_float(
      vec3(along.div(u.puddleStreak).mul(u.puddleScale), across.mul(u.puddleScale), 0.0),
      2, 2.0, 0.5, 1.0,
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

    const g = u.rippleAmp;
    const n = vec3(dha.mul(g).negate(), dhb.mul(g).negate(), 1.0).normalize();
    return n.mul(0.5).add(0.5);
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
export function createWetShading(u, wheelPath) {
  const field = createWetField(u, wheelPath);
  const film = field.x;
  const pond = field.y;
  // COAT STRENGTH, which is not the same thing as wetness. A film reflects less
  // cleanly than standing water does (wetCoatStrength), and the two channels are
  // computed independently — a puddle can sit in a wheel path the film term has
  // partly squeegeed — so the coat takes whichever wins rather than assuming
  // ponding implies film.
  const coat = saturate(max(film.mul(u.wetCoatStrength), pond));

  return {
    field,
    film,
    pond,
    coat,
    /** Multiply the deck albedo by this. */
    albedoScale: mix(float(1), u.wetDarken, film).mul(mix(float(1), u.puddleDarken, pond)),
    /** ...and by this, for the hue of the darkening. */
    tint: mix(vec3(1, 1, 1), u.wetTint, film),
    /** Blend the deck's own roughness toward this by `film`. */
    substrateRough: u.wetRough,
    coatRough: mix(u.wetCoatRough, u.puddleCoatRough, pond),
    coatNormalPacked: wetRippleNormal(u),
    /**
     * How hard to push that normal. Wet enough to have a coat at all, MINUS
     * however much of the break-up the standing water has drowned. This is the
     * term that makes a puddle a mirror and the film around it textured, which
     * is the read the reference photos actually have — not a uniformly rippled
     * sheet from kerb to kerb.
     */
    coatNormalGain: coat.mul(oneMinus(pond.mul(u.rippleDamp))),
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
