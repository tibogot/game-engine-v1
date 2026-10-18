// The engine sound, main-thread side: the AudioWorklet synth (engineWorklet.js) fed by the engine
// model (engineModel.js). Browsers only start audio after a user gesture, so `unlock()` is called from
// the first key press / click. A recorded engine pack later replaces only the worklet; the model and
// this wiring stay.
export function createEngineSound({ type = "v8", volume = 0.7 } = {}) {
  let ctx = null, node = null, tone = null, master = null, ready = false, starting = null;
  let vol = volume, muted = false, engineType = type;
  async function start() {
    ctx = new AudioContext({ latencyHint: "interactive" });
    await ctx.audioWorklet.addModule(new URL("./engineWorklet.js", import.meta.url));
    node = new AudioWorkletNode(ctx, "thunderline-engine", { numberOfOutputs: 1, outputChannelCount: [2], processorOptions: { type: engineType } });
    // a gentle low-pass that opens with load: off-throttle the engine goes muffled, on it barks
    tone = ctx.createBiquadFilter();
    tone.type = "lowpass";
    tone.frequency.value = 2500;
    tone.Q.value = 0.5;
    master = ctx.createGain();
    master.gain.value = muted ? 0 : vol;
    node.connect(tone).connect(master).connect(ctx.destination);
    ready = true;
  }
  const set = (param, v, tc = 0.02) => param.setTargetAtTime(v, ctx.currentTime, tc);
  return {
    get ready() { return ready; },
    get context() { return ctx; },
    /** call from a user gesture (first key press / click) */
    unlock() {
      if (!starting) starting = start().catch((e) => console.warn("[engine sound] not started", e));
      else if (ctx?.state === "suspended") ctx.resume();
      return starting;
    },
    setType(t) { engineType = t; node?.port.postMessage({ type: t }); },
    setVolume(v) { vol = v; if (ready) set(master.gain, muted ? 0 : vol, 0.05); },
    setMuted(m) { muted = m; if (ready) set(master.gain, muted ? 0 : vol, 0.05); },
    /** each frame: the engine model's state */
    update(s) {
      if (!ready) return;
      const p = node.parameters;
      set(p.get("rpm"), s.rpm, 0.015);
      set(p.get("load"), s.load, 0.03);
      set(p.get("limiter"), s.limiter ? 1 : 0, 0.005);
      set(p.get("pop"), s.pop, 0.01);
      set(p.get("gain"), 0.55 + 0.45 * s.load, 0.04);
      set(tone.frequency, 1400 + 5200 * s.load + 1200 * Math.min(1, s.rpm / 8000), 0.04);
    },
    /** pause with the page (a hidden tab must not keep revving) */
    suspend() { ctx?.suspend(); },
    resume() { ctx?.resume(); },
  };
}
