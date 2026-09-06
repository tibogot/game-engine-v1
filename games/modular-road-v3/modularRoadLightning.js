// ============================================================================
// LIGHTNING — the flash, as a number.
//
// ── WHY THERE IS NO LIGHT IN THIS FILE, AND NEVER WILL BE ───────────────────
//
// The obvious implementation is a PointLight per strike. It is also the one
// implementation this engine cannot have. three's WebGPU backend hashes the
// scene's LIGHT SET into every material's shader cache key, so adding or
// removing a light rebuilds every material in the world — the same stall that
// made hiding a lamp freeze the game for a second (see the note on
// `Light.visible` in ref_light_visible_recompiles_world). A strike is the exact
// moment you least want a pipeline rebuild.
//
// So this module renders nothing and owns nothing. It is a clock that produces
// ONE NUMBER, 0..1, and the caller adds that number to lights it already has.
// That also makes it testable without a GPU, which is why the timing can be
// asserted in tools/ rather than eyeballed.
//
// ── WHAT ACTUALLY READS AS LIGHTNING ────────────────────────────────────────
//
// Not the bolt. Most strikes are cloud-to-cloud and you never see a channel —
// what you see is the whole world going bright for a fraction of a second. So
// the flash is the feature, and the geometry, if it ever exists, is decoration
// on top of it.
//
// The one detail that separates lightning from a camera flash is that a strike
// is not ONE flash. It is a leader stroke followed by two or three return
// strokes over ~200 ms, with irregular gaps — that stutter is the whole tell,
// and a single smooth ramp reads as somebody switching a light on and off. The
// stroke count, the gaps and the per-stroke brightness are all randomised for
// that reason.
//
// ── DISTANCE DOES TWO JOBS ──────────────────────────────────────────────────
//
// It sets how bright the flash is, and it sets how long the thunder takes to
// arrive — 343 m/s, which at the far end of the range is eleven seconds. Both
// come from the same roll, so a dim flash is always the one with the long wait
// and a close one cracks almost immediately. Getting that pairing right is most
// of what makes a storm feel like it has a geography.
// ============================================================================

/** Speed of sound, m/s. The only physical constant here and it earns its keep. */
const SOUND_MPS = 343;

export const LIGHTNING_DEFAULTS = {
  /**
   * Master, 0..1. Driven by the weather preset; 0 means the clock does not even
   * run. Scales how OFTEN strikes happen, not how bright they are — a distant
   * storm is a rare flash, not a permanently dimmed one.
   */
  amount: 0,
  /** Seconds between strikes at amount = 1, and at amount just above 0. The gap
   *  is interpolated between them, so easing the weather in makes the strikes
   *  creep closer together rather than switching on at full rate. */
  gapAtFull: [2.5, 9],
  gapAtLow: [14, 40],
  /** Strokes per strike. Two to four is what the reference footage shows. */
  strokes: [2, 4],
  /** Seconds between strokes within one strike. Deliberately wide: evenly
   *  spaced flickers read as a fluorescent tube starting up. */
  strokeGap: [0.04, 0.16],
  /**
   * Per-stroke exponential decay, 1/s. With `strokeGap` it sets how SEPARATE
   * the strokes look — the strike is a sum of decaying strokes, so a slow decay
   * blurs them toward one long flash and a fast one leaves each of them
   * distinct.
   *
   * Measured over a two-stroke strike: at 11 the strike is still at 26% after
   * 250 ms, which reads as a soft, diffuse glow (fine for a distant flash lit
   * through cloud); at 18 it is down to 10%, and the individual strokes snap.
   * 18 is the sharper, more lightning-like default and this is the knob to drop
   * for a storm on the horizon.
   *
   * tools/lightningTimingTest counts the local maxima across a strike, so a
   * value that smears the strokes into one ramp fails there rather than
   * shipping as a light switch.
   */
  decay: 18,
  /** How bright a RETURN stroke is next to the leader. Never 1: the first
   *  stroke is always the brightest, and equal strokes read as a strobe. */
  returnScale: [0.45, 0.95],
  /** How far strikes can be, metres. The near end is "over the next ridge". */
  distance: [250, 4000],
  /** Flash brightness at the near and far ends of that range. */
  bright: [1.0, 0.18],
  /** Multiplies every flash. The artistic master, separate from `amount` so a
   *  storm can be frequent and subtle or rare and violent. */
  strength: 1.0,
};

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * @param {object} [overrides] on LIGHTNING_DEFAULTS
 * @param {function} [rng] 0..1 source. Injectable so the tests are deterministic;
 *   the game never passes one, because a storm that repeats is worse than one
 *   that cannot be reproduced.
 */
export function createLightning(overrides = {}, rng = Math.random) {
  const params = { ...LIGHTNING_DEFAULTS, ...overrides };

  /** Strokes still decaying, as { at, peak } with `at` in local seconds. */
  let strokes = [];
  /** Thunder that has been scheduled but not yet arrived. */
  let thunder = [];
  let clock = 0;
  let nextAt = 0;
  let flash = 0;
  /**
   * ARMED IS NOT THE SAME AS AMOUNT, and the difference is what makes a manual
   * strike possible. `amount` says how hard it is storming, so it scales how
   * often strikes fire on their own — at 0 the sky simply never picks one. But
   * a strike asked for BY NAME is a command, not weather, and on a clear
   * afternoon it is the only way anyone will ever see this code run. `armed` is
   * the real off switch: disarmed, nothing decays, nothing is scheduled, and
   * anything already in flight is dropped rather than left to arrive later.
   */
  let armed = true;
  /** The most recent strike, for anything that wants to point at it. */
  let last = null;

  const rand = (a, b) => a + (b - a) * rng();

  /** Seconds until the next strike, given how hard it is storming. */
  function rollGap() {
    const a = clamp01(params.amount);
    const lo = lerp(params.gapAtLow[0], params.gapAtFull[0], a);
    const hi = lerp(params.gapAtLow[1], params.gapAtFull[1], a);
    return rand(lo, hi);
  }

  /**
   * Fire a strike now. Also the dev-panel button — waiting up to forty seconds
   * to see whether a change worked is not a way to tune anything.
   */
  function strike(atDistance = null) {
    const [dNear, dFar] = params.distance;
    const d = atDistance ?? rand(dNear, dFar);
    // Brightness from distance, on the same roll that sets the thunder delay.
    const k = clamp01((d - dNear) / Math.max(1e-6, dFar - dNear));
    const peak = lerp(params.bright[0], params.bright[1], k) * params.strength;

    const n = Math.round(rand(params.strokes[0], params.strokes[1]));
    let t = 0;
    for (let i = 0; i < n; i++) {
      // The leader is the brightest; return strokes are dimmer and irregular.
      const scale = i === 0 ? 1 : rand(params.returnScale[0], params.returnScale[1]);
      strokes.push({ at: clock + t, peak: peak * scale });
      t += rand(params.strokeGap[0], params.strokeGap[1]);
    }

    // WHERE, not just how far. The cloud deck lights up around the strike rather
    // than uniformly, so a bearing is the difference between a storm that has a
    // geography and a sky that blinks all over at once.
    const azimuth = rng() * Math.PI * 2;
    last = {
      distance: d, peak, strokes: n, at: clock, azimuth,
      offsetX: Math.sin(azimuth) * d,
      offsetZ: Math.cos(azimuth) * d,
    };
    // Thunder leaves with the light and arrives late. Loudness falls off with
    // the same distance that dimmed the flash.
    thunder.push({ at: clock + d / SOUND_MPS, distance: d, loudness: 1 - k * 0.75 });
    return last;
  }

  /**
   * @param {number} dt seconds
   * @returns {number} the flash, 0..1
   */
  function update(dt) {
    if (!armed) {
      // Off means OFF: no clock, no pending strokes, no thunder left hanging to
      // arrive after the effect has been switched off.
      if (strokes.length || thunder.length) { strokes = []; thunder = []; }
      flash = 0;
      nextAt = 0;
      return 0;
    }

    clock += dt;
    // The AUTO clock is what `amount` gates. A strike already in flight keeps
    // decaying at amount 0 and its thunder still arrives, which is both the
    // physics — sound does not stop travelling because the rain did — and what
    // lets the dev panel fire one in clear weather.
    const a = clamp01(params.amount);
    if (a > 0) {
      if (nextAt === 0) nextAt = clock + rollGap();
      if (clock >= nextAt) {
        strike();
        nextAt = clock + rollGap();
      }
    } else {
      nextAt = 0;
    }

    // Strokes SUM rather than max: two return strokes 40 ms apart genuinely do
    // overlap, and taking the max of them loses the brightest moment of the
    // strike. Clamped, because the sum of a leader and two returns can exceed 1.
    let sum = 0;
    for (let i = strokes.length - 1; i >= 0; i--) {
      const s = strokes[i];
      const age = clock - s.at;
      if (age < 0) continue;                 // scheduled, not started
      const v = s.peak * Math.exp(-age * params.decay);
      if (v < 0.002) { strokes.splice(i, 1); continue; }
      sum += v;
    }
    flash = clamp01(sum);
    return flash;
  }

  /**
   * Thunder that has arrived since the last call, and is removed by asking.
   * A pull rather than a callback so the caller decides what a thunderclap is —
   * this module has no opinion about audio and cannot reach it.
   */
  function takeThunder() {
    if (!thunder.length) return null;
    let out = null;
    for (let i = thunder.length - 1; i >= 0; i--) {
      if (thunder[i].at <= clock) {
        // If two arrive in one frame, keep the louder.
        if (!out || thunder[i].loudness > out.loudness) out = thunder[i];
        thunder.splice(i, 1);
      }
    }
    return out;
  }

  return {
    params,
    update,
    strike,
    takeThunder,
    get flash() { return flash; },
    get lastStrike() { return last; },
    get pendingThunder() { return thunder.length; },
    setAmount(v) { params.amount = clamp01(v); },
    /** The master switch — see `armed`. Disarming drops everything in flight. */
    setArmed(v) { armed = !!v; },
    get armed() { return armed; },
    /** Seconds until the next strike, for a HUD readout. Infinity when off. */
    get nextIn() {
      return armed && params.amount > 0 ? Math.max(0, nextAt - clock) : Infinity;
    },
  };
}
