/**
 * Procedural pickup SFX — no asset file, generated via Web Audio API.
 * Kept separate from the Howler-based V2 audio system because these are
 * fire-and-forget short blips that don't need bus routing beyond a single
 * gain wired into context.destination (mixer integration can come later).
 *
 * Bus-aware volume: reads the sfx scalar from createV2AudioSystem so
 * the editor's Audio panel still mutes/scales these dings.
 */

const PROFILE = {
  coin:  { freq: 880,  freq2: 1320, dur: 0.18, gain: 0.18 },
  heart: { freq: 660,  freq2: 990,  dur: 0.30, gain: 0.20 },
  key:   { freq: 520,  freq2: 1040, dur: 0.35, gain: 0.20 },
};

export function createCollectibleSfx(audioSystem) {
  let ctx = null;
  function getCtx() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try { ctx = new AC(); } catch { return null; }
    }
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    return ctx;
  }

  function play(kind) {
    const c = getCtx();
    if (!c) return;
    const prof = PROFILE[kind] || PROFILE.coin;
    const busScalar = audioSystem?.getEffectiveBusScalar?.("sfx") ?? 1.0;
    if (busScalar <= 0) return;

    const now = c.currentTime;
    const dur = prof.dur;
    const g = c.createGain();
    const peak = Math.max(0, Math.min(1, prof.gain * busScalar));
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(peak, now + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    g.connect(c.destination);

    const o1 = c.createOscillator();
    o1.type = "triangle";
    o1.frequency.setValueAtTime(prof.freq, now);
    o1.frequency.exponentialRampToValueAtTime(prof.freq2, now + dur * 0.7);
    o1.connect(g);
    o1.start(now);
    o1.stop(now + dur + 0.02);

    const o2 = c.createOscillator();
    o2.type = "sine";
    o2.frequency.setValueAtTime(prof.freq * 2, now);
    o2.frequency.exponentialRampToValueAtTime(prof.freq2 * 2, now + dur * 0.7);
    const g2 = c.createGain();
    g2.gain.setValueAtTime(peak * 0.5, now);
    g2.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    o2.connect(g2).connect(c.destination);
    o2.start(now);
    o2.stop(now + dur + 0.02);
  }

  return { play };
}
