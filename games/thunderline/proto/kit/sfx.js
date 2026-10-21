// THE OTHER SOUNDS, synthesised (no files): tyres, wind, landings, boost, the race's beeps and chimes.
// Shares the engine's AudioContext (engineSound.js — it is created on the first key press). Noise-based
// sounds synthesise convincingly, unlike an engine: a tyre's roar is filtered noise, its squeal a
// resonant band of noise, wind a swept band of noise.
//   update(dt, car)  each frame: {kmh, slip (m/s sideways), grounded, braking, boosting}
//   landing(ev), boost(), beep(kind) one-shots
export function createSfx(getCtx, { volume = 0.7 } = {}) {
  let ctx = null, master = null, noise = null, built = false, muted = false, vol = volume;
  // which synthesised parts play (setPart): a recorded sound replaces one at a time (sound lab, 2026-10-20)
  const on = { roll: true, squeal: true, wind: true, landing: true };
  let roll, rollF, squeal, squealF, wind, windF, whine;
  function noiseBuffer(c) {
    // 2 s of white noise, looped (shared by every noise voice)
    const b = c.createBuffer(1, c.sampleRate * 2, c.sampleRate), d = b.getChannelData(0);
    let s = 7;
    for (let i = 0; i < d.length; i++) { s = (Math.imul(s, 1664525) + 1013904223) | 0; d[i] = ((s >>> 0) / 4294967296) * 2 - 1; }
    return b;
  }
  function loopVoice(type, f, q) {
    const src = ctx.createBufferSource();
    src.buffer = noise; src.loop = true;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const filt = ctx.createBiquadFilter(); filt.type = type; filt.frequency.value = f; filt.Q.value = q;
    const g = ctx.createGain(); g.gain.value = 0;
    src.connect(filt).connect(g).connect(master);
    src.start();
    return { g, filt };
  }
  function build() {
    ctx = getCtx();
    if (!ctx) return false;
    master = ctx.createGain(); master.gain.value = muted ? 0 : vol;
    master.connect(ctx.destination);
    noise = noiseBuffer(ctx);
    // TYRES ROLLING: a low roar, rising with speed
    ({ g: roll, filt: rollF } = loopVoice("lowpass", 300, 0.7));
    // SQUEAL: a resonant band, wavering — sliding sideways, braking hard
    ({ g: squeal, filt: squealF } = loopVoice("bandpass", 1500, 9));
    // WIND: a swept band, louder and higher with speed, louder in the air
    ({ g: wind, filt: windF } = loopVoice("bandpass", 600, 0.6));
    // BOOST WHINE: a soft turbine tone while boosting
    whine = ctx.createOscillator(); whine.type = "sawtooth"; whine.frequency.value = 900;
    const wf = ctx.createBiquadFilter(); wf.type = "bandpass"; wf.frequency.value = 2400; wf.Q.value = 6;
    whine.g = ctx.createGain(); whine.g.gain.value = 0;
    whine.connect(wf).connect(whine.g).connect(master); whine.start();
    built = true;
    return true;
  }
  const ramp = (param, v, tc) => param.setTargetAtTime(v, ctx.currentTime, tc);
  let wobble = 0;
  /** a short tone: a few partials with an envelope */
  function tone(freqs, { dur = 0.18, gain = 0.25, type = "sine", attack = 0.005, delay = 0 } = {}) {
    if (!built) return;
    const t0 = ctx.currentTime + delay;
    for (const f of freqs) {
      const o = ctx.createOscillator(); o.type = type; o.frequency.value = f;
      const g = ctx.createGain(); g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(gain / freqs.length, t0 + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g).connect(master); o.start(t0); o.stop(t0 + dur + 0.05);
    }
  }
  /** a noise burst through a filter (thumps, whooshes) */
  function burst({ dur = 0.25, gain = 0.5, type = "lowpass", f0 = 200, f1 = 80, q = 0.8 } = {}) {
    if (!built) return;
    const t0 = ctx.currentTime;
    const src = ctx.createBufferSource(); src.buffer = noise;
    const filt = ctx.createBiquadFilter(); filt.type = type; filt.Q.value = q;
    filt.frequency.setValueAtTime(f0, t0); filt.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
    const g = ctx.createGain(); g.gain.setValueAtTime(gain, t0); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(filt).connect(g).connect(master); src.start(t0, Math.random()); src.stop(t0 + dur + 0.05);
  }
  return {
    setMuted(m) { muted = m; if (built) ramp(master.gain, m ? 0 : vol, 0.05); },
    /** switch one synthesised part (roll, squeal, wind, landing) off when a recording plays it instead */
    setPart(name, v) { if (name in on) on[name] = v; },
    setVolume(v) { vol = v; if (built) ramp(master.gain, muted ? 0 : vol, 0.05); },
    update(dt, car) {
      if (!built && !build()) return;
      const sp = Math.min(1, car.kmh / 260);
      const g = car.grounded;
      ramp(roll.gain, g && on.roll ? 0.05 + 0.32 * sp : 0, 0.05);
      ramp(rollF.frequency, 160 + 900 * sp, 0.08);
      // squeal from sliding sideways (m/s) or locking the brakes at speed
      const slide = Math.max(0, Math.min(1, (Math.abs(car.slip) - 3) / 9));
      const brake = car.braking && car.kmh > 40 ? 0.55 : 0;
      wobble += dt * 9;
      ramp(squeal.gain, g && on.squeal ? Math.max(slide, brake) * 0.22 : 0, 0.03);
      ramp(squealF.frequency, 1250 + 450 * Math.sin(wobble) * 0.3 + 700 * slide, 0.03);
      ramp(wind.gain, on.wind ? (g ? 0.03 : 0.08) + 0.3 * sp * sp + (g ? 0 : 0.12 * sp) : 0, 0.15);
      ramp(windF.frequency, 350 + 1800 * sp, 0.2);
      ramp(whine.g.gain, car.boosting ? 0.05 : 0, 0.08);
      ramp(whine.frequency, 700 + 900 * sp, 0.1);
    },
    /** a landing: a thump by how hard; a PERFECT landing rings */
    landing(ev, impact = 6) {
      if (!on.landing) return;
      const k = Math.min(1, impact / 18);
      burst({ dur: 0.18 + 0.25 * k, gain: 0.25 + 0.6 * k, f0: 260, f1: 60 });
      tone([55, 82], { dur: 0.25, gain: 0.2 + 0.3 * k, type: "sine" });
      if (ev.grade === "perfect") tone([1318.5, 1975.5, 2637], { dur: 0.6, gain: 0.22, type: "triangle", delay: 0.05 });
      if (ev.grade === "rough") burst({ dur: 0.35, gain: 0.45, type: "bandpass", f0: 900, f1: 300, q: 1.2 });
    },
    /** the boost kicks in: a rising whoosh */
    boost() { burst({ dur: 0.7, gain: 0.35, type: "bandpass", f0: 400, f1: 3200, q: 1.4 }); },
    /** the race: countdown beeps, GO, checkpoint, finish, a missed checkpoint */
    beep(kind) {
      if (kind === "count") tone([660], { dur: 0.16, gain: 0.25, type: "square" });
      else if (kind === "go") tone([1320], { dur: 0.45, gain: 0.3, type: "square" });
      else if (kind === "cp") { tone([988], { dur: 0.12, gain: 0.22, type: "triangle" }); tone([1480], { dur: 0.3, gain: 0.22, type: "triangle", delay: 0.08 }); }
      else if (kind === "finish") [784, 988, 1175, 1568].forEach((f, i) => tone([f], { dur: 0.45, gain: 0.24, type: "triangle", delay: i * 0.09 }));
      else if (kind === "miss") tone([220, 233], { dur: 0.35, gain: 0.25, type: "sawtooth" });
    },
  };
}
