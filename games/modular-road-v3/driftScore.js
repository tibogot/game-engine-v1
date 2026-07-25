// ============================================================================
// DRIFT SCORING — turns sliding into a thing worth doing.
//
// Deliberately ALWAYS-ON and emergent, not a mode: the car already drifts
// whenever you exceed rear grip (handbrake drops the rear to `TIRE.gripHandbrake`
// and backs the yaw assist off via `driftYawAssistMul`), so this just watches
// and rewards it. No separate drift mode, no drift-only car.
//
// The chain model is the usual arcade one, and the reason it works is that it
// makes ENDING a drift a decision: points accumulate as "pending" while you
// slide, a multiplier grows the longer you hold it, and you only BANK the total
// when you straighten out. Push too far and you spin — pending is lost. So the
// interesting question is always "one more corner, or take the points?".
// ============================================================================

export const DRIFT_SCORE = {
  enabled: true,
  /** Below this speed (m/s) a slide is a parking-lot wiggle, not a drift. */
  minSpeed: 9,
  /** Slip (rad) to start scoring. ~9° — past ordinary cornering slip. */
  minAngle: 0.16,
  /** Slip (rad) that scores fullest. ~50°. */
  bestAngle: 0.87,
  /** Slip (rad) past which you are spinning, not drifting — scoring stops and
   *  the chain is at risk. ~110°. */
  spinAngle: 1.92,
  /** Points per second at `bestAngle` and `refSpeed`. */
  pointsPerSec: 55,
  /** Speed (m/s) where the speed factor is 1.0 — faster drifts score more. */
  refSpeed: 30,
  /** Seconds of continuous drift per +1 multiplier. */
  comboStep: 3.5,
  maxMultiplier: 6,
  /** Seconds below the angle threshold before the chain closes and banks. Keeps
   *  a transition between two corners from breaking the chain. */
  graceTime: 0.7,
};

/**
 * @returns {{
 *   update(dt:number, o:{slip:number, speed:number, grounded:boolean, hitSolid:boolean}): void,
 *   readonly total:number, readonly pending:number, readonly multiplier:number,
 *   readonly drifting:boolean, readonly angleDeg:number,
 *   consumeBanked():number, consumeFailed():boolean, reset():void,
 * }}
 */
export function createDriftScore() {
  let total = 0;        // banked across the run
  let pending = 0;      // this chain, not yet banked
  let driftTime = 0;    // continuous seconds in the current chain
  let grace = 0;        // seconds since slip dropped below threshold
  let drifting = false;
  let angleDeg = 0;
  let justBanked = 0;   // last banked amount, for a HUD flash
  let justFailed = false;

  /** Close the chain: bank pending × multiplier. */
  function bank() {
    if (pending > 0) {
      const gained = Math.round(pending * multiplierOf(driftTime));
      total += gained;
      justBanked = gained;
    }
    pending = 0;
    driftTime = 0;
    drifting = false;
  }

  /** Lose the chain (spun out, or hit something). */
  function fail() {
    if (pending > 0) justFailed = true;
    pending = 0;
    driftTime = 0;
    drifting = false;
  }

  const multiplierOf = (t) =>
    Math.min(DRIFT_SCORE.maxMultiplier, 1 + Math.floor(t / DRIFT_SCORE.comboStep));

  return {
    update(dt, { slip, speed, grounded, hitSolid }) {
      if (!DRIFT_SCORE.enabled) return;
      const a = Math.abs(slip);

      // Hitting a wall mid-chain loses it — that's the risk that makes a long
      // chain worth something.
      if (hitSolid && pending > 0) { fail(); return; }

      // Airborne isn't drifting, but it shouldn't break the chain either: a
      // jump between two slides is part of the run. Hold the chain in grace.
      const scoring =
        grounded && speed >= DRIFT_SCORE.minSpeed &&
        a >= DRIFT_SCORE.minAngle && a < DRIFT_SCORE.spinAngle;

      if (a >= DRIFT_SCORE.spinAngle && grounded) { fail(); return; }

      if (scoring) {
        drifting = true;
        grace = 0;
        driftTime += dt;
        angleDeg = a * 57.2958;
        // Angle factor peaks at `bestAngle` and tapers after — a wilder angle is
        // not automatically better, holding the sweet spot is.
        const t = Math.min(1, (a - DRIFT_SCORE.minAngle) /
          Math.max(1e-3, DRIFT_SCORE.bestAngle - DRIFT_SCORE.minAngle));
        const angleF = a <= DRIFT_SCORE.bestAngle
          ? t
          : Math.max(0.35, 1 - (a - DRIFT_SCORE.bestAngle) /
              Math.max(1e-3, DRIFT_SCORE.spinAngle - DRIFT_SCORE.bestAngle));
        const speedF = speed / DRIFT_SCORE.refSpeed;
        pending += DRIFT_SCORE.pointsPerSec * angleF * speedF * dt;
      } else if (pending > 0 || drifting) {
        grace += dt;
        if (grace >= DRIFT_SCORE.graceTime) bank();
      }
    },

    get total() { return total; },
    get pending() { return Math.round(pending); },
    get multiplier() { return multiplierOf(driftTime); },
    get drifting() { return drifting; },
    get angleDeg() { return angleDeg; },

    /** Banked amount since the last call (0 if none) — drives a HUD flash. */
    consumeBanked() { const v = justBanked; justBanked = 0; return v; },
    /** True once after a chain was lost. */
    consumeFailed() { const v = justFailed; justFailed = false; return v; },

    reset() {
      total = 0; pending = 0; driftTime = 0; grace = 0;
      drifting = false; justBanked = 0; justFailed = false;
    },
  };
}
