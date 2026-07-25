// ============================================================================
// AUTO GEARBOX — speed → gear + tach reading for the HUD.
//
// IMPORTANT: this is DISPLAY-ONLY. The vehicle has no transmission — drive
// force is one continuous curve (`TIRE.accelForce × (1 - normSpeed^powerCurveExp)`
// in modularRoadVehicle.js), so there is no real gear to read. This derives a
// plausible one from road speed, which is what arcade racers do anyway: the
// tach sawtooth is a *feedback* device, not a simulation.
//
// That matters for the planned MANUAL mode. Manual shifting only becomes
// meaningful if the gear also feeds the drive force (per-gear torque + a
// shift-time cut). The split is deliberate: this module owns the gear MODEL, so
// when the physics wants it, it reads from here instead of growing its own.
//
// The engine audio (modularRoadVehicleAudio.js) currently sweeps pitch
// continuously from idle to top speed, so it does NOT dip on upshift the way
// the tach does. Feeding `rpm` from here into `enginePitchFromSpeed` is the
// natural follow-up once the visual model is agreed.
// ============================================================================

/** Tuning for the auto box. Mutable so a dev panel can drive it live. */
export const GEARBOX = {
  /**
   * Upper bound of each gear, as a fraction of top speed. Lower gears are short
   * and upper gears long — the usual progression, and it makes the tach sweep
   * fast early (feels punchy off the line) and lazily at speed.
   */
  ratios: [0.14, 0.28, 0.44, 0.62, 0.8, 1.0],
  /** Tach reading at a standstill. */
  idleRpm: 0.1,
  /** Tach reading just after an upshift — where the needle "lands". Real boxes
   *  drop to roughly 55–65% of redline; that gap is what reads as a shift. */
  landRpm: 0.42,
  /** Fraction of the tach that is redline (drawn hot, and where a manual mode
   *  would want you to shift). */
  redline: 0.88,
  /**
   * Downshift lag, as a fraction of top speed. Without it, speed sitting exactly
   * on a shift point flickers between two gears every frame. The box only drops
   * a gear once speed falls this far BELOW the boundary it climbed through.
   */
  hysteresis: 0.02,
  /** Reverse is a single gear; this is its top speed as a fraction of top speed. */
  reverseRatio: 0.25,
};

/**
 * @returns {{ update(speedMs:number, topSpeedMs:number, forwardMs:number):
 *             {gear:number, label:string, rpm:number, reverse:boolean, shifted:boolean} }}
 */
export function createGearbox() {
  let gear = 1;      // current forward gear, 1-based
  let lastLabel = "1";

  return {
    /**
     * @param {number} speedMs      horizontal speed (m/s, unsigned)
     * @param {number} topSpeedMs   the car's top speed (TIRE.topSpeed)
     * @param {number} forwardMs    speed along the car's own forward axis, SIGNED
     *                              — negative means actually reversing, which a
     *                              speed magnitude alone cannot tell you.
     */
    update(speedMs, topSpeedMs, forwardMs) {
      const top = Math.max(1, topSpeedMs);
      const r = GEARBOX.ratios;

      // REVERSE — only when genuinely travelling backwards. Sliding backwards
      // mid-spin is not "in reverse", but it reads as one to the player, and the
      // alternative (holding a forward gear while going backwards) looks broken.
      if (forwardMs < -0.5) {
        const t = Math.min(1, Math.abs(forwardMs) / (top * GEARBOX.reverseRatio));
        gear = 1;
        const shifted = lastLabel !== "R";
        lastLabel = "R";
        return { gear: 0, label: "R", rpm: lerp(GEARBOX.idleRpm, 1, t), reverse: true, shifted };
      }

      const frac = speedMs / top;

      // Pick the gear whose band contains `frac`. Hysteresis applies ONLY on the
      // way down, so accelerating shifts crisply at the boundary while a small
      // wobble at that speed can't chatter back and forth.
      let next = r.length;
      for (let i = 0; i < r.length; i++) {
        if (frac < r[i]) { next = i + 1; break; }
      }
      if (next < gear) {
        const bound = r[next - 1] ?? 0;
        if (frac > bound - GEARBOX.hysteresis) next = gear; // still within the lag
      }
      gear = Math.min(r.length, Math.max(1, next));

      // Tach position within the gear's band. Bottom of 1st is idle; bottom of
      // every other gear is `landRpm`, which is what produces the sawtooth.
      const lo = gear === 1 ? 0 : r[gear - 2];
      const hi = r[gear - 1];
      const t = hi > lo ? (frac - lo) / (hi - lo) : 0;
      const base = gear === 1 ? GEARBOX.idleRpm : GEARBOX.landRpm;
      // Not clamped at the top: overspeed (a long downhill, a boost pad) pushes
      // the needle past redline in top gear, which is the correct read.
      const rpm = Math.max(0, lerp(base, 1, t));

      const label = String(gear);
      const shifted = label !== lastLabel;
      lastLabel = label;
      return { gear, label, rpm, reverse: false, shifted };
    },
  };
}

const lerp = (a, b, t) => a + (b - a) * t;
