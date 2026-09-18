/**
 * THE INTEGRATORS — how an ambient particle moves.
 *
 * These are plain JS functions that INLINE TSL into whatever scope calls them,
 * not `Fn()` wrappers. That is deliberate: an integrator has to mutate several
 * `.toVar()` nodes at once (position, velocity, state, lifetime), and a TSL
 * `Fn` that returns an object collapses to a single node — a trap this repo
 * has already paid for once. Inlining keeps the assignments in the caller's
 * scope, where they mean what they say.
 *
 * Each integrator is selected by a REAL branch on the effect's motion id, so
 * an effect only pays for its own motion. Two are built:
 *
 *   0  WANDER — butterflies. A heading that turns on three decorrelated sines,
 *      a vertical bob locked to the wing beat, a soft spring holding the
 *      altitude band, and a hard floor at the ground.
 *
 *   1  FALL — leaves. Acceleration to a terminal speed, a side-to-side
 *      autorotation swing (which is the whole reason a falling leaf reads as a
 *      leaf and not as a dropped pebble), then SETTLE on the ground: the leaf
 *      stops, lies down on the terrain normal, and holds for `settleTime`
 *      before it dies and is respawned up in the canopy.
 *
 * ── WHY NO NOISE TEXTURE ────────────────────────────────────────────────────
 * Curl noise is the textbook answer and it costs several taps per particle per
 * frame. Sines of (time, seed) cost a handful of ALU, never repeat within a
 * particle's life because each particle's phases are decorrelated, and — the
 * part that actually matters — they are C-infinity, so a heading never kinks.
 * The birds in this repo are built on the same argument.
 *
 * ── THE SETTLED-LEAF STORAGE TRICK ──────────────────────────────────────────
 * A settled leaf needs the terrain normal it is lying on, and it has no use
 * for a velocity any more. So the normal is written OVER the velocity in
 * `bufB.xyz`, flagged by `state = 1`. No fourth buffer, no unpacking.
 */
import {
  If, cos, cross, float, max, mix, normalize, saturate, sin, smoothstep, vec2, vec3, PI2,
} from "three/tsl";

/** Motion ids — must match MOTION in v3/app/state/ambientFxState.js. */
export const MOTION_WANDER = 0;
export const MOTION_FALL = 1;

/** How close to the ground a leaf has to get before it lies down, metres. */
const SETTLE_REACH = 0.06;
/** And how far above the sampled height it then sits. */
const SETTLE_LIFT = 0.025;

/**
 * Advance one particle. Mutates `pos`, `vel`, `state` and `life` in place.
 *
 * @param {object} c
 *   motionId   float node — the effect's motion (branched on)
 *   pos, vel   vec3 .toVar() — world metres, metres/second
 *   state      float .toVar() — 0 flying, 1 settled
 *   age, life  float node / .toVar() — seconds
 *   dt         float node — frame time, already clamped by the caller
 *   phase      float node 0..1 — this particle's own phase, hash(slot)
 *   seed       float node 0..1 — a second decorrelated hash
 *   groundY    float node — terrain height under the particle
 *   groundN    vec3 node — terrain normal under the particle
 *   wind       vec3 node — the world's wind as a velocity, m/s
 *   band       vec2 node — (altMin, altMax) above the ground, metres
 *   speed, turbulence, flapRate, windCoupling, settleTime   float nodes
 */
export function integrateMotion(c) {
  const {
    motionId, pos, vel, state, age, life, dt, phase, seed,
    groundY, groundN, wind, band, speed, turbulence, flapRate, windCoupling, settleTime,
  } = c;

  const t2 = float(PI2);
  const ph = phase.mul(t2);
  const sd = seed.mul(t2);

  /* ── 0 · WANDER ─────────────────────────────────────────────────────────── */
  If(motionId.lessThan(0.5), () => {
    // The heading. Three sines at incommensurate rates, so the path curves
    // for ever without ever retracing itself. `turbulence` is how fast it
    // turns, not how far it goes — a butterfly at high turbulence still
    // covers ground, it just stops flying in a straight line.
    const w = age.mul(turbulence);
    const dir = vec3(
      sin(w.mul(0.73).add(ph)),
      sin(w.mul(0.41).add(sd)).mul(0.28),
      cos(w.mul(0.57).add(ph).add(sd)),
    );
    const desired = normalize(dir.add(vec3(1e-4, 0, 1e-4))).mul(speed);
    // Turn toward the heading rather than snapping to it: a butterfly has
    // momentum, and without this the wings point somewhere the body is not going.
    vel.assign(mix(vel, desired, saturate(dt.mul(2.4))));

    // The wing beat lifts it. This is the signature of the whole insect: a
    // butterfly does not cruise, it bobs once per downstroke, and without
    // this term it reads as a leaf on a string.
    const beat = sin(age.mul(flapRate).mul(t2).add(ph));
    vel.y.addAssign(beat.mul(speed).mul(0.85).mul(dt).mul(6));

    // Hold the altitude band, softly.
    const targetY = groundY.add(mix(band.x, band.y, seed));
    vel.y.addAssign(targetY.sub(pos.y).mul(1.6).mul(dt));

    vel.addAssign(wind.mul(windCoupling).mul(dt).mul(1.5));
    pos.addAssign(vel.mul(dt));

    // A hard floor. The band spring alone lets a fast descent clip a rise in
    // the ground before it can pull back.
    const floorY = groundY.add(0.12);
    If(pos.y.lessThan(floorY), () => {
      pos.y.assign(floorY);
      vel.y.assign(max(vel.y, float(0)));
    });
  });

  /* ── 1 · FALL ───────────────────────────────────────────────────────────── */
  If(motionId.greaterThanEqual(0.5).and(motionId.lessThan(1.5)), () => {
    If(state.lessThan(0.5), () => {
      // Falling. `speed` is the TERMINAL speed, not gravity: a leaf reaches it
      // almost at once, and simulating the approach from g buys nothing you
      // can see while making light leaves fall at silly rates.
      vel.y.assign(mix(vel.y, speed.negate(), saturate(dt.mul(1.8))));

      // Autorotation. A leaf falls by stalling alternately on each side, which
      // throws it sideways along an axis that itself drifts. This is the term
      // that makes it a leaf; without it you have snow.
      const swingPh = age.mul(flapRate).mul(t2).add(ph);
      const axis = sd.add(age.mul(0.23));
      const swing = sin(swingPh).mul(turbulence).mul(speed).mul(0.9);
      const target = vec2(cos(axis).mul(swing), sin(axis).mul(swing));
      vel.x.assign(mix(vel.x, target.x, saturate(dt.mul(3.0))));
      vel.z.assign(mix(vel.z, target.y, saturate(dt.mul(3.0))));

      vel.addAssign(wind.mul(windCoupling).mul(dt).mul(2.0));
      pos.addAssign(vel.mul(dt));

      // Touchdown.
      If(pos.y.lessThan(groundY.add(SETTLE_REACH)), () => {
        pos.y.assign(groundY.add(SETTLE_LIFT));
        state.assign(1);
        // The normal is written OVER the velocity — see the header.
        vel.assign(groundN);
        // Die `settleTime` from now, however much life was left.
        life.assign(age.add(settleTime));
      });
    });
    // Settled: nothing to integrate. It lies there until `life` catches `age`,
    // which the caller checks, and the fade-out is driven from the same pair.
  });
}

/**
 * How visible a particle is from its own age, 0..1 — a fade in over the first
 * moments and out over the last. A particle that blinks into existence is the
 * thing you notice about an effect like this, so nothing ever pops.
 *
 * Settled leaves fade out over a good deal longer, because a leaf that
 * vanishes off the ground in a quarter second while you are looking at it is
 * worse than one that is simply never there.
 */
export function ageFade(age, life, state) {
  const inFade = smoothstep(float(0), float(0.45), age);
  const outLen = mix(float(0.7), float(2.2), saturate(state));
  const outFade = smoothstep(float(0), outLen, life.sub(age));
  return inFade.mul(outFade);
}

/**
 * The card's local frame and hinge angle, for the vertex stage.
 * Returns nothing — it assigns into the `.toVar()` nodes handed in, for the
 * same reason the integrator does.
 *
 * @param {object} c  motionId, vel, state, age, phase, seed, flapRate, flapAmp,
 *                    and the out-vars fwd / rgt / upv / hinge
 */
export function cardFrame(c) {
  const { motionId, vel, state, age, phase, seed, flapRate, flapAmp, fwd, rgt, upv, hinge } = c;
  const ph = phase.mul(PI2);
  const worldUp = vec3(0, 1, 0);

  // A settled leaf has the GROUND NORMAL in `vel` (see the header), so its
  // frame is built from that instead — it lies on the slope, not in the air.
  const settled = state.greaterThan(0.5);

  const speedSq = vel.dot(vel);
  // Below a crawl the velocity direction is noise, so fall back to a fixed
  // heading from the particle's own seed rather than letting the card spin.
  const fallback = vec3(cos(seed.mul(PI2)), 0, sin(seed.mul(PI2)));
  const flyFwd = normalize(mix(fallback, vel, saturate(speedSq.mul(40))).add(vec3(1e-5, 0, 1e-5)));

  // normalize() is evaluated on BOTH sides of a select, so the settled branch
  // is nudged off zero: a flying particle at a dead stop would otherwise
  // produce a NaN frame that propagates to every vertex of the card.
  const upRef = settled.select(normalize(vel.add(vec3(0, 1e-5, 0))), worldUp);
  const fRef = settled.select(fallback, flyFwd);

  // Gram-Schmidt, guarded: a butterfly climbing straight up would otherwise
  // have no valid right vector at all.
  const r0 = cross(upRef, fRef);
  const degenerate = r0.dot(r0).lessThan(1e-6);
  const r1 = degenerate.select(vec3(1, 0, 0), normalize(r0));
  rgt.assign(r1);
  fwd.assign(normalize(cross(r1, upRef)));
  upv.assign(cross(fwd, r1));

  // The hinge. Butterflies beat; leaves hold a shallow fold and roll about
  // their own spine instead (the roll is applied by the caller, which has the
  // vertex position to rotate).
  const beat = sin(age.mul(flapRate).mul(PI2).add(ph));
  const flap = float(0.25).add(beat.mul(flapAmp));
  // A falling leaf's fold is driven by the SAME slider, so setting it to zero
  // gives a genuinely flat card — which is what a painted leaf wants, because
  // a photograph's midrib does not run down the middle of the image.
  const fold = flapAmp.mul(float(1).add(sin(age.mul(flapRate).mul(0.6).add(ph)).mul(0.3)));
  const wander = motionId.lessThan(0.5);
  hinge.assign(wander.select(flap, settled.select(flapAmp.mul(0.5), fold)));
}

/** A leaf's roll about its own spine, radians. Zero for anything else. */
export function cardRoll(motionId, state, age, phase, flapRate, turbulence) {
  const tumbling = motionId.greaterThanEqual(0.5).and(state.lessThan(0.5));
  const roll = age.mul(flapRate).mul(1.7).add(phase.mul(PI2))
    .mul(float(0.6).add(turbulence.mul(0.8)));
  return tumbling.select(roll, phase.mul(PI2));
}
