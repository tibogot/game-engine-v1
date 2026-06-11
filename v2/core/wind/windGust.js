/**
 * Wind gust state machine — port of revo-realms WindManager's intensity
 * cycle, which is what makes its grass feel alive: calm ambient sway, a
 * gust ramps in, holds, decays, calm again. Without it the grass sits at
 * permanent maximum gust (static windIntensity slider) and reads as an
 * unnatural constant thrash.
 *
 * Phases: idle (ambient, random wait) → ramp (+rampRate/s) → hold (random
 * seconds at the gust's target) → decay (−decayRate/s) → idle.
 * Original constants: ambient 0.1, ramp 1.5/s, hold 3 s, decay 0.85/s.
 * Target gust strength is randomized per gust for variety.
 *
 * Self-clocked: call update() once per frame, returns intensity in
 * [ambient .. 1]. Use it as a multiplier on the wind sliders so they keep
 * their meaning as "strength at full gust".
 */
export class WindGustManager {
  constructor({
    ambient = 0.1,
    rampRate = 1.5,
    decayRate = 0.85,
    holdMin = 2,
    holdMax = 4,
    idleMin = 3,
    idleMax = 9,
    gustMin = 0.55,
    gustMax = 1.0,
  } = {}) {
    this.ambient = ambient;
    this.rampRate = rampRate;
    this.decayRate = decayRate;
    this.holdMin = holdMin;
    this.holdMax = holdMax;
    this.idleMin = idleMin;
    this.idleMax = idleMax;
    this.gustMin = gustMin;
    this.gustMax = gustMax;

    this.intensity = ambient;
    this._phase = "idle";
    this._timer = this._rand(idleMin, idleMax) * 0.5; // first gust comes sooner
    this._target = 1;
    this._last = null;
  }

  _rand(a, b) {
    return a + Math.random() * (b - a);
  }

  /** Advance the cycle; returns current intensity in [ambient..1]. */
  update() {
    const now = performance.now();
    const dt = this._last == null ? 0 : Math.min((now - this._last) / 1000, 0.1);
    this._last = now;

    switch (this._phase) {
      case "idle":
        this._timer -= dt;
        if (this._timer <= 0) {
          this._phase = "ramp";
          this._target = this._rand(this.gustMin, this.gustMax);
        }
        break;
      case "ramp":
        this.intensity = Math.min(
          this.intensity + dt * this.rampRate,
          this._target,
        );
        if (this.intensity >= this._target) {
          this._phase = "hold";
          this._timer = this._rand(this.holdMin, this.holdMax);
        }
        break;
      case "hold":
        this._timer -= dt;
        if (this._timer <= 0) this._phase = "decay";
        break;
      case "decay":
        this.intensity = Math.max(
          this.intensity - dt * this.decayRate,
          this.ambient,
        );
        if (this.intensity <= this.ambient) {
          this._phase = "idle";
          this._timer = this._rand(this.idleMin, this.idleMax);
        }
        break;
    }
    return this.intensity;
  }
}
