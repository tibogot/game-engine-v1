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
  // the TOP END (user, 2026-10-20: "a bit muffled, no high frequency at all"): was 1500 + 5500 load + 1500
  // rpm (coasting 1.5 kHz, flat out 8.5 kHz) — now coasting ~3.5-7 kHz, flat out 12.5-16 kHz, plus presence
  toneMin: 3500, // lowpass (Hz) coasting …
  toneLoad: 9000, // … + this much at full load
  toneRpm: 3500, // … + this much at 8000 RPM
  presence: 4, // dB, a high shelf from presenceHz (the loops themselves are dark: centroid ~2.2 kHz)
  presenceHz: 2500,
  filterOff: false, // the sound lab's A/B: no lowpass at all
  // GRIT: the loops have almost nothing above 2 kHz (measured: 0.0-0.1% of their energy), so no filter or
  // shelf can brighten them. An EXCITER makes the top end: a copy, high-passed, saturated (new harmonics
  // that follow the engine), high-passed again, mixed in under the loops.
  grit: 1, // 0 = none … 3 = a lot (1: ~3% of the energy above 3 kHz, simulated on rpm_5000; was 0.0%)
  gritHz: 3000, // the harmonics kept above this
  // POPS OFF (user, 2026-10-20: the lift-off crackle was "very annoying to the ears, impossible to use") —
  // the cracks below are kept but silent: popGain 0
  popGain: 0, // a crack's peak, against the loops' ~0.12 RMS (was 0.55)
  popRate: 0.18, // the chance a firing cracks at full `pop` (the synth's rate)
  limiterCrack: 0.1, // the chance a cut firing cracks on the limiter
};

export function createEngineLoops({ type = "gen6", volume = 0.7 } = {}) {
  let ctx = null, master = null, tone = null, shelf = null, gritHp = null, gritGain = null, chop = null, popBus = null, noise = null, ready = false, starting = null;
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
    shelf = ctx.createBiquadFilter();
    shelf.type = "highshelf";
    shelf.frequency.value = 2500;
    shelf.gain.value = LOOP_MIX.presence;
    chop = ctx.createGain(); // the limiter's stutter
    master = ctx.createGain();
    master.gain.value = muted ? 0 : vol;
    tone.connect(shelf).connect(chop).connect(master).connect(ctx.destination);
    // the exciter (LOOP_MIX.grit), in parallel after the tone filter: so coasting stays duller
    const pre = ctx.createBiquadFilter();
    pre.type = "highpass"; pre.frequency.value = 700;
    const sat = ctx.createWaveShaper();
    const curve = new Float32Array(2048);
    for (let i = 0; i < curve.length; i++) { const x = (i / (curve.length - 1)) * 2 - 1; curve[i] = Math.tanh(x * 6); }
    sat.curve = curve;
    sat.oversample = "4x";
    const drive = ctx.createGain(); drive.gain.value = 4; // the loops are ~0.12 RMS: push them into the curve
    gritHp = ctx.createBiquadFilter();
    gritHp.type = "highpass"; gritHp.frequency.value = LOOP_MIX.gritHz; gritHp.Q.value = 0.7;
    gritGain = ctx.createGain(); gritGain.gain.value = 0;
    tone.connect(pre).connect(drive).connect(sat).connect(gritHp).connect(gritGain).connect(chop);
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
  // only when the value moved (performance pass, 2026-10-22: ~42 automation events a frame, most of them the
  // same value again — 14 silent loops re-ramped to 0, the constant filter settings re-sent)
  const setIf = (param, v, tc, eps = 1e-4) => { if (param._v !== undefined && Math.abs(param._v - v) <= eps) return; param._v = v; set(param, v, tc); };
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
    // muted: the whole context sleeps (the engine, and the sfx sharing it, do no audio work at all)
    setMuted(m) {
      muted = m;
      if (!ready) return;
      set(master.gain, muted ? 0 : vol, 0.05);
      if (muted) setTimeout(() => { if (muted && ctx.state === "running") ctx.suspend(); }, 150);
      else if (ctx.state === "suspended") ctx.resume();
    },
    /** each frame: the engine model's state ({ rpm, load, limiter, pop }) */
    update(s) {
      if (!ready || !voices.length || muted) return;
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
        const g = w * (v.off ? offMix : onMix);
        setIf(v.gain.gain, g, 0.03, 1e-3);
        if (g > 0) setIf(v.src.playbackRate, rpm / v.rpm, 0.015); // the pitch matters only while it is heard
      });
      setIf(tone.frequency, LOOP_MIX.filterOff ? 20000 : Math.min(20000, LOOP_MIX.toneMin + LOOP_MIX.toneLoad * load + LOOP_MIX.toneRpm * Math.min(1, rpm / 8000)), 0.04, 1);
      setIf(shelf.gain, LOOP_MIX.presence, 0.05);
      setIf(shelf.frequency, LOOP_MIX.presenceHz, 0.05);
      // the grit grows with load (pulling barks, coasting is softer)
      setIf(gritGain.gain, LOOP_MIX.grit * 0.5 * (0.35 + 0.65 * load), 0.05);
      setIf(gritHp.frequency, LOOP_MIX.gritHz, 0.05);
      // LIMITER: the ignition cuts in bursts (~18 a second)
      const now = ctx.currentTime, dt = Math.min(0.05, now - lastT);
      lastT = now;
      chopPhase = (chopPhase + dt * 18) % 1;
      const cut = s.limiter && chopPhase < 0.45;
      setIf(chop.gain, cut ? 0.35 : 1, 0.004);
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
