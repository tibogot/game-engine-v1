// THE ENGINE AS RECORDED LOOPS (user, 2026-10-20: the synth is "better, but still synthetic"). The way
// racing games do it: steady loops at fixed RPMs, all playing, the two around the current RPM crossfaded
// (equal power) and pitched the few percent between them. TWO SETS: on the throttle, and COASTING (no fuel:
// weak combustion, the intake shut, the mechanics heard) — LOAD crossfades them, and opens the tone.
// LIFT-OFF POPS ride on top (unburnt fuel cracking in the pipe, from the model's `pop`, as the synth's), the
// LIMITER chops the level and cracks too. The same calls as engineSound.js, so the drive rig takes either.
// The loops are rendered offline by the open-source enginesound (MIT, github.com/DasEtwas/enginesound);
// how: games/thunderline/assets-src/engines/README.md. A recorded pack drops into the same folders later.

// six were rendered (enginesound's example1-6: two V10s, a 3-, a 5- and two 4-cylinders); the user picked
// gen6, a four (2026-10-20), and only its loops are kept (16-bit, ~1.7 MB with the coasting set)
export const LOOP_ENGINES = {
  gen6: { label: "Gen 6 · 4-cyl", folder: "gen6", cylinders: 4 },
};
export const LOOP_RPMS = [1000, 1750, 2500, 3250, 4000, 5000, 6000, 7000, 8200];
export const isLoopEngine = (type) => !!LOOP_ENGINES[type];

// THE MIX (by ear in the engine lab; the user tunes these)
export const LOOP_MIX = {
  offGain: 2.2, // the coasting loops are rendered ~12 dB under the throttle ones: lift them to ~-5 dB
  toneMin: 1500, // lowpass (Hz) coasting …
  toneLoad: 5500, // … + this much at full load
  toneRpm: 1500, // … + this much at 8000 RPM
  // POPS OFF (user, 2026-10-20: the lift-off crackle was "very annoying to the ears, impossible to use") —
  // the cracks below are kept but silent: popGain 0
  popGain: 0, // a crack's peak, against the loops' ~0.12 RMS (was 0.55)
  popRate: 0.18, // the chance a firing cracks at full `pop` (the synth's rate)
  limiterCrack: 0.1, // the chance a cut firing cracks on the limiter
};

export function createEngineLoops({ type = "gen6", volume = 0.7 } = {}) {
  let ctx = null, master = null, tone = null, chop = null, popBus = null, noise = null, ready = false, starting = null;
  let vol = volume, muted = false, engine = LOOP_ENGINES[type] ? type : "gen6";
  let voices = []; // { rpm, src, gain, off }
  const buffers = new Map(); // engine -> { on: AudioBuffer[], off: AudioBuffer[] } (one per LOOP_RPMS)
  async function loadEngine(name) {
    if (buffers.has(name)) return buffers.get(name);
    const folder = LOOP_ENGINES[name].folder;
    const load = (sub) => Promise.all(LOOP_RPMS.map(async (r) => {
      const res = await fetch(`/sounds/thunderline/engines/${folder}/${sub}rpm_${r}.wav`);
      return ctx.decodeAudioData(await res.arrayBuffer());
    }));
    const [on, off] = await Promise.all([load(""), load("off/")]);
    buffers.set(name, { on, off });
    return buffers.get(name);
  }
  function startVoices({ on, off }) {
    for (const v of voices) { try { v.src.stop(); } catch {} v.src.disconnect(); v.gain.disconnect(); }
    const voice = (buf, i, isOff) => {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      src.connect(gain).connect(tone);
      src.start(ctx.currentTime, Math.random() * buf.duration); // not all in phase
      return { rpm: LOOP_RPMS[i], src, gain, off: isOff };
    };
    voices = [...on.map((b, i) => voice(b, i, false)), ...off.map((b, i) => voice(b, i, true))];
  }
  async function start() {
    ctx = new AudioContext({ latencyHint: "interactive" });
    tone = ctx.createBiquadFilter();
    tone.type = "lowpass";
    tone.Q.value = 0.6;
    chop = ctx.createGain(); // the limiter's stutter
    master = ctx.createGain();
    master.gain.value = muted ? 0 : vol;
    tone.connect(chop).connect(master).connect(ctx.destination);
    popBus = ctx.createGain(); // the cracks: bright, so not through the tone filter
    popBus.connect(master);
    noise = ctx.createBuffer(1, ctx.sampleRate / 2, ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    startVoices(await loadEngine(engine));
    ready = true;
  }
  /** one crack in the pipe at time `when`: a short bright snap, sometimes with a low bang under it */
  function crack(when, strength) {
    const burst = (type, f, q, peak, dur) => {
      const src = ctx.createBufferSource();
      src.buffer = noise;
      const filt = ctx.createBiquadFilter();
      filt.type = type; filt.frequency.value = f; filt.Q.value = q;
      const g = ctx.createGain();
      g.gain.setValueAtTime(peak, when);
      g.gain.exponentialRampToValueAtTime(0.0005, when + dur);
      src.connect(filt).connect(g).connect(popBus);
      src.start(when, Math.random() * 0.4);
      src.stop(when + dur + 0.02);
    };
    const k = LOOP_MIX.popGain * strength;
    burst("highpass", 900 + Math.random() * 900, 0.7, k, 0.018 + Math.random() * 0.03);
    if (Math.random() < 0.4) burst("bandpass", 160 + Math.random() * 120, 1.2, k * 1.4, 0.07 + Math.random() * 0.05);
  }
  const set = (param, v, tc = 0.02) => param.setTargetAtTime(v, ctx.currentTime, tc);
  let chopPhase = 0, lastT = 0;
  return {
    get ready() { return ready; },
    get context() { return ctx; },
    get type() { return engine; },
    unlock() {
      if (!starting) starting = start().catch((e) => console.warn("[engine loops] not started", e));
      else if (ctx?.state === "suspended") ctx.resume();
      return starting;
    },
    async setType(t) {
      if (!LOOP_ENGINES[t]) return;
      engine = t;
      if (ready) startVoices(await loadEngine(t));
    },
    setVolume(v) { vol = v; if (ready) set(master.gain, muted ? 0 : vol, 0.05); },
    setMuted(m) { muted = m; if (ready) set(master.gain, muted ? 0 : vol, 0.05); },
    /** each frame: the engine model's state ({ rpm, load, limiter, pop }) */
    update(s) {
      if (!ready || !voices.length) return;
      const rpm = Math.max(LOOP_RPMS[0] * 0.8, s.rpm);
      const load = Math.min(1, Math.max(0, s.load));
      // the two loops around this RPM, equal-power crossfade; each pitched to the RPM
      let k = 0;
      while (k < LOOP_RPMS.length - 2 && rpm > LOOP_RPMS[k + 1]) k++;
      const t = Math.min(1, Math.max(0, (rpm - LOOP_RPMS[k]) / (LOOP_RPMS[k + 1] - LOOP_RPMS[k])));
      // LOAD: throttle set vs coasting set, equal power
      const onMix = Math.sin((load * Math.PI) / 2), offMix = Math.cos((load * Math.PI) / 2) * LOOP_MIX.offGain;
      voices.forEach((v, i) => {
        const j = i % LOOP_RPMS.length;
        const w = j === k ? Math.cos((t * Math.PI) / 2) : j === k + 1 ? Math.sin((t * Math.PI) / 2) : 0;
        set(v.gain.gain, w * (v.off ? offMix : onMix), 0.03);
        set(v.src.playbackRate, rpm / v.rpm, 0.015);
      });
      set(tone.frequency, LOOP_MIX.toneMin + LOOP_MIX.toneLoad * load + LOOP_MIX.toneRpm * Math.min(1, rpm / 8000), 0.04);
      // LIMITER: the ignition cuts in bursts (~18 a second)
      const now = ctx.currentTime, dt = Math.min(0.05, now - lastT);
      lastT = now;
      chopPhase = (chopPhase + dt * 18) % 1;
      const cut = s.limiter && chopPhase < 0.45;
      set(chop.gain, cut ? 0.35 : 1, 0.004);
      // POPS: per firing in this frame, a chance of a crack (lift-off, and the limiter's cut firings)
      const chance = (s.pop > 0.05 ? s.pop * LOOP_MIX.popRate : 0) + (cut ? LOOP_MIX.limiterCrack : 0);
      if (chance > 0 && LOOP_MIX.popGain > 0) {
        const firings = Math.min(8, Math.round((rpm / 60) * (LOOP_ENGINES[engine].cylinders / 2) * dt));
        for (let f = 0; f < firings; f++) if (Math.random() < chance) crack(now + 0.01 + Math.random() * dt, 0.6 + 0.4 * Math.random() * Math.max(s.pop, cut ? 0.6 : 0));
      }
    },
    suspend() { if (ctx?.state === "running") ctx.suspend(); },
    resume() { if (ctx?.state === "suspended" && !muted) ctx.resume(); },
  };
}
