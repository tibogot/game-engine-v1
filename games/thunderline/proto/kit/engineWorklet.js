// THE SYNTHESISED ENGINE (AudioWorklet, runs on the audio thread). Physically flavoured, not physical:
// every cylinder FIRING kicks a small bank of resonators — the exhaust's body (low), its growl (mid)
// and the rasp (high) — and the sum is soft-clipped like an overdriven pipe. What makes it read as an
// engine and not a buzzer:
//   • each cylinder fires a little differently (fixed per-cylinder offsets + a little jitter), which
//     gives the burble at idle and the texture at speed;
//   • the firing order is uneven on a cross-plane V8 (the classic "lope"), even on the others;
//   • load brightens it (more rasp, harder kick) and lifts the intake hiss;
//   • the limiter skips firings in bursts; lift-off throws crackles (short broadband cracks).
// Params (k-rate): rpm, load 0..1, gain, limiter 0/1, pop 0..1. Engine type via port message.

const TYPES = {
  // cylinders, firing irregularity (V8 cross-plane lope), resonators [freq Hz, Q, gain], kick decay ms
  v8: { cyl: 8, lope: 0.22, res: [[95, 3.2, 1.0], [310, 5, 0.55], [1250, 2.6, 0.32]], kick: 1.6, drive: 2.2 },
  i6: { cyl: 6, lope: 0.0, res: [[130, 3.5, 0.8], [520, 6, 0.6], [2100, 3, 0.38]], kick: 1.1, drive: 2.1 },
  v10: { cyl: 10, lope: 0.05, res: [[150, 3, 0.7], [640, 5, 0.65], [2600, 3, 0.42]], kick: 0.9, drive: 1.5 },
};

class Biquad {
  // a band-pass resonator (RBJ cookbook, constant 0 dB peak)
  set(f, q, sr) {
    const w = (2 * Math.PI * f) / sr, a = Math.sin(w) / (2 * q), c = Math.cos(w), a0 = 1 + a;
    this.b0 = a / a0; this.b2 = -a / a0; this.a1 = (-2 * c) / a0; this.a2 = (1 - a) / a0;
    this.x1 ??= 0; this.x2 ??= 0; this.y1 ??= 0; this.y2 ??= 0;
  }
  run(x) {
    const y = this.b0 * x + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

class EngineProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "rpm", defaultValue: 950, minValue: 0, maxValue: 12000, automationRate: "k-rate" },
      { name: "load", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "gain", defaultValue: 0.5, minValue: 0, maxValue: 2, automationRate: "k-rate" },
      { name: "limiter", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "pop", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
    ];
  }
  constructor(options) {
    super();
    this.phase = 0; // crank revolutions (fraction)
    this.nextFire = 0;
    this.kickEnv = 0; this.kickAmp = 0;
    this.crack = 0;
    this.limitTimer = 0;
    this.seed = 12345;
    this.lp = 0; // intake noise one-pole
    this.res = [new Biquad(), new Biquad(), new Biquad()];
    this.noiseBP = new Biquad();
    this.crackHP = 0;
    // the type at creation (processorOptions) — a port message would arrive after rendering started
    this.setType(options?.processorOptions?.type ?? "v8");
    this.port.onmessage = (e) => { if (e.data?.type) this.setType(e.data.type); };
  }
  rand() { this.seed = (Math.imul(this.seed, 1664525) + 1013904223) | 0; return ((this.seed >>> 0) / 4294967296); }
  setType(name) {
    this.t = TYPES[name] ?? TYPES.v8;
    this.res.forEach((r, i) => r.set(this.t.res[i][0], this.t.res[i][1], sampleRate));
    this.noiseBP.set(900, 0.8, sampleRate);
    // each cylinder a little different, fixed for the engine (its "voice")
    this.cylAmp = Array.from({ length: this.t.cyl }, () => 0.8 + 0.4 * this.rand());
    // firing intervals over a 4-stroke cycle (2 revolutions); a cross-plane V8 is uneven
    const n = this.t.cyl, base = 2 / n;
    this.gaps = Array.from({ length: n }, (_, i) => base * (1 + (i % 2 ? -1 : 1) * this.t.lope * (i % 4 < 2 ? 1 : -0.6)));
    const sum = this.gaps.reduce((a, b) => a + b, 0);
    this.gaps = this.gaps.map((g) => (g * 2) / sum);
    this.cylIdx = 0;
    this.nextFire = this.phase + this.gaps[0];
  }
  process(_in, outputs, p) {
    const out = outputs[0][0];
    if (!out) return true;
    const rpm = p.rpm[0], load = p.load[0], gain = p.gain[0], limiter = p.limiter[0] > 0.5, pop = p.pop[0];
    const revPerSample = rpm / 60 / sampleRate;
    const kickDecay = Math.exp(-1 / ((this.t.kick / 1000) * sampleRate));
    const w = this.t.res;
    // brighter with load and revs
    const bright = 0.45 + 0.75 * load + 0.25 * Math.min(1, rpm / 8000);
    for (let i = 0; i < out.length; i++) {
      this.phase += revPerSample;
      if (this.phase >= this.nextFire) {
        // the limiter cuts firings in bursts of ~40 ms
        this.limitTimer -= 1;
        const cut = limiter && ((this.phase * 7.3) % 1) < 0.55;
        if (!cut) {
          this.kickAmp = (0.35 + 0.65 * load) * this.cylAmp[this.cylIdx] * (0.9 + 0.2 * this.rand());
          this.kickEnv = 1;
        } else if (pop > 0.05 || limiter) {
          // an unburnt charge going off in the pipe: a crack
          if (this.rand() < 0.35 + 0.4 * pop) this.crack = 0.8 + 0.4 * this.rand();
        }
        // lift-off crackles between firings
        if (pop > 0.05 && this.rand() < pop * 0.18) this.crack = Math.max(this.crack, 0.5 + 0.6 * this.rand() * pop);
        this.cylIdx = (this.cylIdx + 1) % this.t.cyl;
        this.nextFire += this.gaps[this.cylIdx];
      }
      if (this.phase > 1e6) { this.phase -= 1e6; this.nextFire -= 1e6; }
      // the excitation: a fast-decaying kick plus a pinch of noise in it (combustion isn't clean)
      const n = this.rand() * 2 - 1;
      const kick = this.kickEnv * this.kickAmp * (0.85 + 0.3 * n);
      this.kickEnv *= kickDecay;
      let y = this.res[0].run(kick) * w[0][2] + this.res[1].run(kick) * w[1][2] * (0.7 + 0.5 * load) + this.res[2].run(kick) * w[2][2] * bright;
      // intake / mechanical hiss, up with load and revs
      this.lp += 0.2 * (n - this.lp);
      y += this.noiseBP.run(n) * (0.02 + 0.06 * load) * Math.min(1.4, rpm / 5000);
      // cracks: broadband, high-passed, very short
      if (this.crack > 0.001) {
        const hp = n - this.crackHP; this.crackHP = n;
        y += hp * this.crack * 0.9;
        this.crack *= 0.993;
      }
      // the pipe overdrives
      out[i] = Math.tanh(y * this.t.drive * 6) * 0.5 * gain;
    }
    for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(out);
    return true;
  }
}
registerProcessor("thunderline-engine", EngineProcessor);
