// ============================================================================
// RAIN LENS — full-screen water droplets, as a screen-space node.
//
// The convention every wet racing game uses: drops on an invisible pane between
// the camera and the world. Not physically motivated on a chase camera (there
// is no glass there), but it is the established language for "it is raining"
// and it reads instantly.
//
// ── WHY THIS IS PROCEDURAL AND NOT PARTICLES ────────────────────────────────
//
// No drop list, no buffers, no CPU step, no draws. The screen is cut into a
// hash grid and each cell derives ONE drop from a hash of its own cell id, so a
// thousand drops cost the same as one: a few hashes per pixel. It is
// resolution-independent, there is nothing to allocate or update, and nothing
// to keep in sync with the frame rate.
//
// ── ONE HEIGHT FIELD, ONE NORMAL ────────────────────────────────────────────
//
// EVERYTHING below — coverage, shading, refraction — comes from a single
// quantity: `nxy`, the xy of the drop's surface normal, which for a spherical
// cap is exactly the offset from the drop centre divided by the drop radius.
//
// That is not tidiness for its own sake. The first version of this file
// computed coverage from `radius * sizeVar` and then recomputed the shading
// from the BASE radius, so every drop larger than base had an outer ring where
// the two disagreed: the cap height came out 0, the additive rim fired at full
// strength across it, and the result was a screen of opaque milky beads. Two
// expressions for one circle is a bug waiting to be written. There is now one.
//
// ── WHAT MAKES IT READ AS WATER RATHER THAN GREASE ──────────────────────────
//
// Three things, in order of how much they matter:
//
//  1. THE REAL IMAGE. A droplet is a thick plano-convex lens, so what you see
//     inside it is INVERTED and MAGNIFIED. The trick that gets this for one
//     texture tap is to anchor the sample at the drop's CENTRE rather than at
//     the pixel, and gather over a disc of radius `magnify` in SCREEN units:
//
//         lensUv = centreUv - nxy * magnify
//
//     Because the gather radius is fixed in screen space and `nxy` sweeps the
//     unit disc, a 40 px drop shows a complete, inverted, minified picture of a
//     region hundreds of pixels wide. The predecessor offset by the drop's own
//     cell-space extent, which worked out to ~4% of the screen — so each drop
//     sampled very nearly the pixel it was already covering, came out flat, and
//     read as opaque plastic. Magnification has to be independent of drop size,
//     or drops are not lenses.
//
//  2. THE RIM IS A REFLECTION, NOT A HIGHLIGHT. Water reflects hard at grazing
//     angles, so a bead's edge shows the SKY, not white paint. One extra tap
//     above the drop, and only on pixels a drop covers.
//
//  3. SOFT DROPS ON A SHARP WORLD. A drop sits millimetres from the lens and is
//     hopelessly out of focus, so what it gathers arrives as a milky smear. Go
//     and look at footage: the track is crisp and the drops are soft blobs, and
//     a crisp inverted photograph inside every bead is the giveaway that you
//     are looking at a decal. This was built the other way round first — sharp
//     drops on hazy glass — which is both wrong and, as it happens, the more
//     expensive arrangement.
//
// ── COST SHAPE ──────────────────────────────────────────────────────────────
//
// A full-screen effect on a frame that is ~88% fill in its main pass, so it
// lands on exactly the expensive axis. Two things keep it affordable:
//
//   • EVERY tap — the lens, the rim, and the blur taps that soften both — sits
//     behind a coverage test that ~90% of pixels fail. Blurring the drops
//     rather than the glass is what puts them there; the earlier arrangement
//     blurred the dry glass, which is exactly the pixels a drop is NOT on.
//   • the field itself is hashes and arithmetic — no texture, no VRAM, no
//     sampler slot, which matters on a project already at the WebGPU
//     16-sampler ceiling.
//
// The one term that still costs everywhere is `film`, the dry-glass haze, and
// it defaults to 0 for that reason.
//
// Measured in the lab over the captured frame at 3840x1778 and scaled to
// 1920x889, against a plain blit of the same backdrop:
//
//     beads + runner heads          0.147 ms
//     + drop blur (opts.blur)       0.197 ms   (+0.050)
//     + runner trails (opts.trail)  0.238 ms   (+0.041)
//
// HOW TO MEASURE THIS, because two of the three attempts that produced those
// lines were wrong:
//
//   • Interleave the configs in ONE page session and repeat them. An earlier
//     round compared numbers taken across separate page loads and had the trail
//     at +0.15 ms — nearly four times the truth. The run-to-run spread between
//     loads is larger than the thing being measured.
//   • Use the CAPTURED FRAME, never the procedural test card. The card
//     re-evaluates its own arithmetic on every tap, so what you time is the
//     card, not a texture read.
//   • Check the frame count. The lab's `measure()` returns `trustworthy`, and
//     it is false whenever fewer than a full 30-frame window closed — which is
//     what happens the moment the window stops being composited.
//
// And measure again in game before shipping: there the tap is an HDR render
// target rather than an 8-bit jpeg, so expect more than these figures.
// ============================================================================
import {
  Fn, uniform, vec2, float, floor, fract, max, mix, sin,
  smoothstep, step, length, sqrt, pow, saturate, oneMinus, time,
} from "three/tsl";

/**
 * Authored defaults. Everything is a uniform so the lab can drive it live and
 * the game can save a weather look without a rebuild.
 */
export const RAIN_LENS_DEFAULTS = {
  /** Master. 0 = the pass is a pass-through; nothing below is visible. */
  amount: 1.0,

  // ── BEADS: the drops that cling ──────────────────────────────────────────
  /** Cells across the screen height. Higher = more, smaller beads. */
  beadDensity: 18.0,
  /** Bead radius as a fraction of a cell. Above ~0.45 neighbours collide and
   *  the grid becomes visible, which is the one artefact this technique has. */
  beadSize: 0.20,
  /** Fraction of cells that actually hold a bead. This is the coverage knob,
   *  and sparse beats dense: drops are interesting because you can see BETWEEN
   *  them, and a full grid reads as frosted glass. */
  beadFill: 0.34,
  /** How far a bead creeps over its whole life, as a fraction of the room it
   *  has inside its cell. A clinging drop barely moves; this is a slow settle,
   *  not travel. See `beadLife` for why that is not the same as being static. */
  beadDrift: 0.55,
  /** Lopsidedness. Real beads are not discs; this pulls the radius in and out
   *  around the drop as sin(2θ), for the cost of one multiply and one divide,
   *  and it is most of what stops the field reading as printed dots. */
  beadWobble: 0.22,

  // ── THE LIFECYCLE: why the field looks alive when the drops do not move ──
  //
  // A bead that merely slides is wrong twice over. Slide it slowly and the
  // screen looks frozen — drops sitting still read as dirt on the monitor, not
  // as rain. Slide it fast and it looks like it is being dragged, which water
  // clinging to glass does not do.
  //
  // What actually happens is that drops ARRIVE. An impact is instantaneous: one
  // frame there is nothing, the next there is a drop, with a brief splash
  // corona as it settles. Then it clings, creeping barely at all, until it
  // merges away or gets torn off. So the motion in the field is birth and
  // death, not travel, and every cell runs that cycle on its own hashed phase.
  //
  /** Seconds from a bead's impact to its disappearance. */
  beadLife: 5.0,
  /** Fraction of that life spent appearing. Keep it tiny — an impact is not a
   *  fade-in, and anything above ~0.05 reads as drops materialising politely. */
  beadSplash: 0.02,
  /** Fraction of the life spent fading out. Unlike the arrival this IS gradual:
   *  a drop thins and merges away rather than vanishing. */
  beadFade: 0.30,
  /** Radius overshoot at the moment of impact — the splash corona, gone within
   *  a few frames. This is what sells the arrival as a hit rather than a spawn. */
  beadPop: 0.35,

  // ── RUNNERS: the drops that let go ───────────────────────────────────────
  /** Columns across the screen. Fewer than beads — a runner is an event. */
  runnerDensity: 9.0,
  /** Fraction of columns running at any time. */
  runnerFill: 0.28,
  /** Runner head radius, fraction of a column. */
  runnerSize: 0.26,
  /** How fast a runner falls, screens per second. */
  runnerSpeed: 0.35,
  /** Length of the trail behind the head, in screen heights. */
  runnerTrail: 0.28,
  /** Beads per screen height in that trail. A runner does not leave a smear; it
   *  leaves a CHAIN of small drops, and they are real drops with real optics —
   *  the earlier version drew a tapered stippled band instead, which is where
   *  the grey rectangles kept coming from and why it never looked like water. */
  trailDensity: 18.0,
  /** Fraction of the chain's slots that hold a bead. */
  trailFill: 0.70,
  /** Trail bead radius, relative to the head that shed it. */
  trailSize: 0.55,

  // ── OPTICS ───────────────────────────────────────────────────────────────
  /**
   * Blends the sample anchor from the pixel itself (0 — an ordinary refractive
   * smear) to the drop's centre (1 — a true inverted real image). The whole
   * "is that water?" read lives here; leave it high.
   */
  invert: 0.70,
  /**
   * Gather radius, in screen widths. THIS is the drop's optical power, and it
   * is deliberately in screen units rather than drop units so that small drops
   * are strong lenses like real ones. 0.16 means a bead shows an inverted
   * image of a region about a third of the screen across.
   */
  magnify: 0.13,
  /**
   * How blurred what a drop gathers is, as a screen-uv radius.
   *
   * The most important single value for making these read as water. A drop is
   * millimetres from the lens and hopelessly out of focus, so it delivers a
   * soft milky smear, not a crisp inverted photograph — compare any reference
   * footage and this is the thing that jumps out. Needs a blur sampler
   * (`opts.blur`); without one the drops are sharp and look like decals.
   */
  dropBlur: 0.014,
  /** How much of the rim turns into a reflection of the sky above the drop. */
  rim: 0.30,
  /** How tight the rim is. Higher = a thinner, harder edge. */
  rimPower: 3.0,
  /** Absorption through the body — thicker water at the centre, less light. */
  density: 0.12,
  /** Softness of the drop edge, as a fraction of the radius. */
  edgeSoft: 0.22,

  // ── FILM ─────────────────────────────────────────────────────────────────
  /**
   * How hazy the wetted glass is between the drops. Only has an effect when a
   * blur sampler is supplied (see `opts.blur`) — without one the taps are not
   * in the shader at all.
   */
  film: 0.0,

  // ── AIRFLOW ──────────────────────────────────────────────────────────────
  /**
   * Sideways lean, in screen widths per screen height. This is the speed cue:
   * parked, drops fall straight; at 200 km/h the airflow drags them across the
   * glass. The game drives it from road speed.
   */
  lean: 0.0,
  /** How much the lean also stretches drops along their direction of travel. */
  streak: 0.6,
};

export const RAIN_LENS_NUMBERS = Object.keys(RAIN_LENS_DEFAULTS);

/** Build the uniform bag. Kept separate so the lab and the game share one. */
export function createRainLensUniforms(opts = {}) {
  const u = {};
  for (const k of RAIN_LENS_NUMBERS) u[k] = uniform(opts[k] ?? RAIN_LENS_DEFAULTS[k]);
  return u;
}

/**
 * 1D and 2D value hashes, 0..1. The classic sin-fract pair: not good random
 * number generators and they do not need to be — they need to be cheap, stable
 * per cell, and free of visible structure at the scales used here.
 */
const hash11 = /*#__PURE__*/ Fn(([x]) => fract(sin(x.mul(127.1).add(0.317)).mul(43758.5453)));
const hash21 = /*#__PURE__*/ Fn(([p]) => fract(sin(p.dot(vec2(127.1, 311.7))).mul(43758.5453)));

/**
 * Turn an offset-from-centre into the spherical cap's surface normal.
 *
 * For a cap of radius `r`, the normal at offset `d` is simply `d / r` in xy —
 * the gradient of the height field, free, no derivative needed. Clamping the
 * LENGTH rather than the components keeps it a disc rather than a square, which
 * matters because everything downstream reads `length(nxy)` as "how close to
 * the rim am I".
 *
 * @returns vec2 inside the unit disc: (0,0) at the drop's summit, unit length
 *   at its rim.
 */
const capNormal = /*#__PURE__*/ Fn(([d, r]) => {
  const len = length(d);
  const dir = d.div(max(len, float(1e-9)));
  return dir.mul(saturate(len.div(max(r, float(1e-9)))));
});

/**
 * A drop, as everything downstream needs it: how much of this pixel it covers,
 * the surface normal there, and its radius (which is what lets the caller
 * recover the drop's CENTRE — `d = nxy * r` — for the real-image lens).
 *
 * A plain object rather than a packed `vec4` because there are now three of
 * these to compose and the packing was doing nothing but obscuring which
 * component was which.
 */
const makeDrop = (cover, nxy, radius) => ({ cover, nxy, radius });

/**
 * Compose two drop layers. A pixel cannot be inside two lenses at once, so the
 * one covering it more wins and brings its own normal and radius with it.
 */
const pickDrop = (a, b) => {
  const use = step(a.cover, b.cover);
  return makeDrop(
    max(a.cover, b.cover),
    mix(a.nxy, b.nxy, use),
    mix(a.radius, b.radius, use),
  );
};

/**
 * The clinging-bead field: one drop per grid cell, jittered, sized and shaped
 * per cell from hashes of the cell id, and living out a birth/cling/fade cycle
 * on that cell's own hashed phase.
 *
 * Plain JS rather than a TSL `Fn` — it is called once, so there is nothing to
 * deduplicate, and the argument list had grown to nine positional nodes.
 */
function beadField(uvn, u, stretch, t) {
  const { beadDensity: density, beadSize: size, beadWobble: wobble } = u;
  const g = uvn.mul(density);
  const id = floor(g);

  // Per-cell character. Presence, placement and size take separate hashes so
  // that an empty cell does not also shift its neighbours' jitter — sharing one
  // hash across all three correlates them and the grid becomes legible.
  const present = step(hash21(id), u.beadFill);
  const jx = hash21(id.add(vec2(11.3, 5.7))).sub(0.5).mul(0.62);
  const jy = hash21(id.add(vec2(3.1, 91.7)));
  const sizeVar = hash21(id.add(vec2(27.7, 41.3))).mul(0.85).add(0.55);

  // ── THE LIFECYCLE ───────────────────────────────────────────────────────
  //
  // `age` runs 0→1 over `beadLife`, offset per cell so the screen is never
  // synchronised. Everything about the drop's visibility hangs off it.
  const age = fract(jy.add(t.div(max(u.beadLife, float(0.05)))));

  // Arrival is a HIT, not a fade-in: `beadSplash` is a couple of percent of the
  // life, so a drop is simply there on the next frame. Departure is gradual, as
  // a real drop thins and merges away.
  const born = smoothstep(float(0), max(u.beadSplash, float(1e-4)), age);
  const dying = smoothstep(float(1), oneMinus(u.beadFade), age);
  const alive = born.mul(dying);

  // The splash corona: a brief radius overshoot right at impact, decaying over
  // the first few percent of the life. Without it the arrival reads as a drop
  // being switched on rather than one landing.
  const pop = float(1).add(u.beadPop.mul(oneMinus(smoothstep(float(0), float(0.06), age))));

  // The creep. A bead barely moves, and it moves over its LIFE rather than
  // wrapping around its cell — which also means there is no wrap to hide any
  // more, because the drop dies where it stops.
  const fall = age.mul(u.beadDrift).add(0.5).sub(u.beadDrift.mul(0.5));

  // ── THE DROP MUST STAY INSIDE ITS OWN CELL ──────────────────────────────
  //
  // This is a SINGLE-CELL lookup: a pixel only ever asks its own cell whether
  // there is a drop. Anything that crosses the boundary is therefore simply
  // not drawn on the far side, and what you see is drops SLICED CLEAN along
  // the cell edges — straight horizontal cuts, because `fall` sweeps a bead
  // through the full height of its cell while the x jitter never reaches as
  // far. That was visible on screen and it is a hard limit of the technique,
  // not a tuning problem.
  //
  // The fix is to shrink the region the centre may occupy by the largest
  // radius a cell can produce, so no drop can reach an edge. It costs jitter
  // range — drops sit closer to their cell centres, which is why `beadSize`
  // has to stay modest or the grid becomes legible. Sampling the 3x3
  // neighbourhood would keep the jitter, at nine times the field cost.
  //
  // The bound has to include the WOBBLE as well as the size variation, or the
  // handful of drops that come out both large and lopsided still cross the
  // edge and still get sliced — which is exactly what was left on screen after
  // the first go at this.
  const rMaxCell = size.mul(1.40).mul(float(1).add(wobble.mul(0.5)));
  const inset = max(oneMinus(rMaxCell.mul(2.0)), float(0.02));
  const centre = vec2(jx.mul(inset), fall.sub(0.5).mul(inset));

  // Into SCREEN units. Every length from here — offset, radius, gather — is a
  // fraction of the screen, which is what lets the optics be independent of how
  // dense the grid happens to be.
  const cellD = fract(g).sub(0.5).sub(centre);
  const d = vec2(cellD.x, cellD.y.div(max(stretch, float(0.05)))).div(density);
  const rBase = size.mul(sizeVar).mul(pop).div(density);

  // Lopsided: pull the radius in and out as sin(2θ), which `d.x*d.y/|d|²` IS,
  // without ever computing an angle.
  const len2 = max(d.dot(d), float(1e-12));
  const lobe = d.x.mul(d.y).div(len2);
  const r = rBase.mul(float(1).add(lobe.mul(wobble)));

  const rn = length(d).div(max(r, float(1e-9)));
  const cover = smoothstep(float(1), oneMinus(u.edgeSoft), rn).mul(present).mul(alive);

  return makeDrop(cover, capNormal(d, r), r);
}

/**
 * The chain of beads a runner leaves behind it.
 *
 * A runner does not smear the glass — it sheds. What is left in its wake is a
 * line of small drops, each a real drop with real optics, which is why this
 * returns the same shape as the bead field and composes with it rather than
 * being painted on afterwards.
 *
 * The predecessor drew a tapered, stippled band instead. That is where the grey
 * rectangles came from twice over: quantising the chain gave every link a hard
 * top and bottom, and a band with hard edges across is a rectangle however
 * softly you fade its ends. Beads have no edges to get wrong.
 *
 * @param rdx,rdy  offset from the runner HEAD, screen units (rdy > 0 is above
 *   it, i.e. where the head has already been)
 */
function trailBeads(rdx, rdy, colId, headRadius, u, present) {
  const tD = u.trailDensity;
  // Which link of the chain this pixel belongs to, and that link's own hashes.
  // Single-cell again, so the same rule applies: a link's bead must fit inside
  // its slot, which `trailSize` is small enough to guarantee.
  const slot = rdy.mul(tD);
  const k = floor(slot);
  const seed = k.add(colId.mul(31.7));
  const here = step(hash11(seed), u.trailFill);
  const jy = hash11(seed.add(5.9));
  const jx = hash11(seed.add(19.3)).sub(0.5);
  const sizeVar = hash11(seed.add(41.1)).mul(0.7).add(0.55);

  // Beads thin out and shrink the further back you look — the trail is drying.
  const taper = oneMinus(saturate(rdy.div(max(u.runnerTrail, float(1e-4)))));
  const r = headRadius.mul(u.trailSize).mul(sizeVar).mul(taper);

  // Wander across the column as well as along it. Without this the chain is a
  // dead-straight vertical line of evenly spaced beads, which no runner leaves.
  // The bound keeps bead plus wander inside the column, for the single-cell
  // reason that governs every offset in this file.
  const d = vec2(
    rdx.sub(jx.mul(headRadius).mul(1.6)),
    fract(slot).sub(jy).div(tD),
  );
  const rn = length(d).div(max(r, float(1e-9)));
  // Above the head only: below it the runner has not been yet.
  const cover = smoothstep(float(1), oneMinus(u.edgeSoft), rn)
    .mul(here).mul(present).mul(step(float(0), rdy)).mul(saturate(taper.mul(3.0)));

  return makeDrop(cover, capNormal(d, r), r);
}

/**
 * The full effect.
 *
 * @param {(uvNode) => Node} sampleScene  returns the scene colour (vec3) at a
 *   given screen uv. The lab hands it a texture; the game hands it the scene
 *   colour node from the post pipeline. Keeping this a callback is what lets
 *   the same shader serve both without knowing where the pixels come from.
 * @param {object} u        uniforms from createRainLensUniforms
 * @param {Node} uvNode     screen uv (vec2, 0..1)
 * @param {Node} aspectNode screen width / height
 * @param {object} [opts]
 * @param {(uvNode, radiusNode) => Node} [opts.blur]  optional BLURRED scene
 *   sampler. Supply it to get the soft out-of-focus drops; omit it and those
 *   taps are absent from the shader rather than multiplied by zero.
 * @param {boolean} [opts.trail=true]  build the runner trail layer. It is a
 *   whole extra drop field — hashes, a cap normal and a coverage test — though
 *   it measures cheaper than that sounds: about +0.04 ms of the effect's
 *   0.24 ms at 1080p. `trailFill = 0` would hide it while still costing every
 *   pixel; this removes it, which is what a light shower wants.
 *
 * Both are BUILD-TIME gates: changing either needs the material rebuilt, and
 * that is the point — off has to mean absent, not multiplied by zero.
 * @returns {Node<vec3>} the modified scene colour
 */
export function rainLensColor(sampleScene, u, uvNode, aspectNode, opts = {}) {
  const blurSample = opts.blur ?? null;
  const wantTrail = opts.trail !== false;
  /**
   * What a drop's optics sample. Blurred when a blur sampler is available,
   * because a drop is far out of focus — see the note at the lens tap.
   *
   * The cost lands well: these taps sit BEHIND the coverage test, so they run
   * on the ~10% of pixels a drop covers rather than on the whole screen. That
   * is the opposite of the first design, which blurred the dry glass instead —
   * prettier in theory, and it put four extra taps on every pixel that did NOT
   * have a drop on it.
   */
  const tap = blurSample ? (p) => blurSample(p, u.dropBlur) : sampleScene;

  return Fn(() => {
    // Aspect-corrected space, so drops are round rather than stretched by the
    // viewport. Only X is scaled; Y stays the animation axis.
    const uvn = vec2(uvNode.x.mul(aspectNode), uvNode.y);
    const t = time;

    // Airflow shears the whole field sideways. At rest drops fall straight;
    // under lean they rake across the glass, which is the speed cue.
    const shear = vec2(uvn.x.add(uvn.y.mul(u.lean)), uvn.y);
    const stretch = float(1).add(u.lean.abs().mul(u.streak));

    // ── BEADS ────────────────────────────────────────────────────────────
    const bead = beadField(shear, u, stretch, t);

    // ── RUNNERS ──────────────────────────────────────────────────────────
    //
    // Inline rather than a second `beadField` call, because a runner is a
    // COLUMN, not a cell: it must travel the whole screen height in one
    // unbroken movement. The predecessor reused the bead field, whose `fract`
    // wraps on BOTH axes — so every runner repeated itself once per cell down
    // its column, which is where the tiling grey rectangles came from.
    const gx = shear.x.mul(u.runnerDensity);
    const colId = floor(gx);
    const rPresent = step(hash11(colId), u.runnerFill);
    const rSpeedVar = hash11(colId.add(3.31)).mul(0.7).add(0.65);
    const rSizeVar = hash11(colId.add(19.7)).mul(0.7).add(0.6);
    // Inset for the same reason the beads are: a column is a single-cell lookup
    // across x, so a head that reaches its column edge gets sliced vertically.
    const rInset = max(oneMinus(u.runnerSize.mul(1.30).mul(2.0)), float(0.02));
    const rJx = hash11(colId.add(7.13)).sub(0.5).mul(rInset);

    // The head travels from above the top edge to below the bottom, so nothing
    // pops into existence inside the frame.
    const span = float(1).add(u.runnerTrail).add(0.2);
    const phase = fract(t.mul(u.runnerSpeed).mul(rSpeedVar).add(hash11(colId.add(51.3))));
    const headY = float(1).add(u.runnerTrail).sub(phase.mul(span));

    // Offsets in screen units. Note the jitter is applied HERE, so the head and
    // its trail below share one centreline — they were computed from different
    // x's before, which is why trails sat beside their heads instead of under.
    const rdx = fract(gx).sub(0.5).sub(rJx).div(u.runnerDensity);
    const rdy = uvn.y.sub(headY);

    const rd = vec2(rdx, rdy.div(max(stretch, float(0.05))));
    const rRadius = u.runnerSize.mul(rSizeVar).div(u.runnerDensity);
    const rRn = length(rd).div(max(rRadius, float(1e-9)));
    const head = makeDrop(
      smoothstep(float(1), oneMinus(u.edgeSoft), rRn).mul(rPresent),
      capNormal(rd, rRadius),
      rRadius,
    );

    // ── THE TRAIL ────────────────────────────────────────────────────────
    // Real beads, composed as a further lens layer rather than painted on as a
    // film. See `trailBeads` for why the film had to go, and `opts.trail` for
    // why it is a gate rather than a uniform.
    const withHead = pickDrop(bead, head);

    // ── COMPOSITE THE DROP LAYERS ────────────────────────────────────────
    const drop = wantTrail
      ? pickDrop(withHead, trailBeads(rdx, rdy, colId, rRadius, u, rPresent))
      : withHead;
    const cover = saturate(drop.cover.mul(u.amount));
    const nxy = drop.nxy;
    const radius = drop.radius;

    // ── OPTICS ───────────────────────────────────────────────────────────
    // Everything from here is behind the coverage test in the final mix, which
    // is what keeps the effect affordable: most pixels never need it.
    //
    // Recover the drop centre. `nxy` is the offset over the radius, so the
    // offset is `nxy * radius` — undo the aspect correction on x to land back
    // in uv space.
    const dScreen = nxy.mul(radius);
    const centreUv = vec2(uvNode.x.sub(dScreen.x.div(aspectNode)), uvNode.y.sub(dScreen.y));

    // THE REAL IMAGE. Anchor at the centre (invert=1) and gather over a disc of
    // radius `magnify` in screen units, so the drop shows an inverted, minified
    // picture of a wide region rather than a nudged copy of itself.
    const anchor = mix(uvNode, centreUv, u.invert);
    const gather = vec2(nxy.x.div(aspectNode), nxy.y).mul(u.magnify);
    const lensUv = anchor.sub(gather).clamp(vec2(0.002, 0.002), vec2(0.998, 0.998));
    // …and BLURRED, when a blur sampler is supplied. This is the single biggest
    // difference between this and reference footage: in a real game frame the
    // drops are soft, milky blobs, not crisp little photographs. A drop sits
    // millimetres from the lens and is wildly out of focus, so what it gathers
    // arrives smeared. A sharp inverted image inside every bead is a giveaway
    // that the drop is a decal rather than water.
    const behind = tap(lensUv);

    // Cap height: 1 at the summit, 0 at the rim. Thicker water absorbs more.
    const h = sqrt(saturate(oneMinus(nxy.dot(nxy))));
    const body = oneMinus(h.mul(u.density));

    // The rim is a REFLECTION, not a highlight. At grazing angles water is a
    // mirror, and what it mirrors is the sky — so tap above the drop and fade
    // toward that at the edge. A flat white rim is what makes these things read
    // as plastic beads.
    const skyUv = centreUv.add(vec2(0, u.magnify.mul(1.15)))
      .clamp(vec2(0.002, 0.002), vec2(0.998, 0.998));
    const rimCol = tap(skyUv);
    const fres = pow(saturate(length(nxy)), u.rimPower).mul(u.rim);
    const dropColor = mix(behind.mul(body), rimCol, saturate(fres));

    // ── THE DRY GLASS ────────────────────────────────────────────────────
    const sharp = sampleScene(uvNode);
    // The world itself stays SHARP. Reference footage is unambiguous about
    // this: the track is crisp and only the drops are soft. `film` adds a light
    // haze on top for a heavier downpour, and defaults to off — it is the one
    // term here that costs on every pixel, drop or not.
    const clean = blurSample ? mix(sharp, blurSample(uvNode, u.film.mul(0.03)), u.film) : sharp;


    return mix(clean, dropColor, cover);
  })();
}
