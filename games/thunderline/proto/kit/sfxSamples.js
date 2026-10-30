// RECORDED CAR SOUNDS (user, 2026-10-20: "find those free sounds online"): CC0 recordings from BigSoundBank
// (Joseph Sardin) and Kenney's Impact Sounds, cut into seamless loops and one-shots (how:
// public/sounds/thunderline/sfx-candidates/README.md). The same car state as sfx.js drives them:
//   update(dt, { kmh, slip, grounded, scrape }), landing(impact)
// Loops: the tyres ROLLING (louder and higher with speed), the DRIFT squeal (sliding sideways), the WIND
// (speed², more in the air), a RAIL SCRAPE (while scraping). Landings: one of three takes, harder = louder,
// lower. Each loop is levelled to the same RMS by the cutter, so the gains below are the mix.
const BASE = "/sounds/thunderline/sfx-candidates/";
// The user's picks, 2026-10-20: the drift squeal is B, the long screech (in the game: GAME_PICK). Wind and
// rolling are kept for later. The scrape and landing recordings were rejected and deleted (the landings
// sounded "like Mario Bros"); the code for both stays for a later sound.
// GRAIN BANKS (user, 2026-10-30: "the drift sound is repeating badly"): a 1.5 s loop of one screech repeats every
// 1.5 s, and the ear hears it. A bank is the loud cores of several squeals side by side (scratchpad grainBank.py);
// the player lays overlapping 0.25–0.5 s grains of them, each from a random place, crossfaded — nothing repeats.
//   ga: the long screech (B's source, BigSoundBank #2371), 3 cores. (A bank of #0500's 17 short squeals was rejected:
//   "completely unusable", user 2026-10-30.)
export const GRAINS = {
  squeal_grains_a: { segs: [[0, 0.65], [0.65, 1.15], [1.15, 2.95]], rate: 1 },
};
export const SAMPLE_SETS = {
  squeal: { b: "squeal_b", ga: "squeal_grains_a" },
  roll: { a: "roll_a", b: "roll_b" },
  wind: { a: "wind_a", b: "wind_b", c: "wind_c" },
  scrape: {},
  landing: {},
};
export const GAME_PICK = { squeal: "ga" }; // (2026-10-30: the grain bank A — the old loop "b" repeated)
const LOOPS = ["squeal", "roll", "wind", "scrape"];

/**
 * @param ctx  an AudioContext (or a function returning one once audio is unlocked)
 * @param pick { squeal: "a", roll: "b", … } — a part left out (or null) plays nothing
 */
export function createSfxSamples(getCtx, { volume = 0.7, pick = {} } = {}) {
  let ctx = null, master = null, muted = false, vol = volume, solo = null;
  const buffers = new Map(); // file -> AudioBuffer (or a promise)
  const loops = {}; // part -> { src, gain, filt, file }
  const choice = { ...pick };
  const load = (file) => {
    if (!buffers.has(file)) buffers.set(file, fetch(BASE + file + ".wav").then((r) => r.arrayBuffer()).then((b) => ctx.decodeAudioData(b)).then((buf) => (buffers.set(file, buf), buf)));
    return buffers.get(file);
  };
  function build() {
    ctx = typeof getCtx === "function" ? getCtx() : getCtx;
    if (!ctx) return false;
    master = ctx.createGain();
    master.gain.value = muted ? 0 : vol;
    master.connect(ctx.destination);
    for (const p of LOOPS) setLoop(p);
    if (choice.landing) for (let v = 0; v < 3; v++) load(`${SAMPLE_SETS.landing[choice.landing]}_${v}`);
    return true;
  }
  async function setLoop(part) {
    const old = loops[part];
    if (old) { old.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.03); old.src?.stop(ctx.currentTime + 0.2); delete loops[part]; }
    const key = choice[part], file = key && SAMPLE_SETS[part][key];
    if (!file) return;
    const buf = await load(file);
    if (choice[part] !== key || loops[part]) return; // changed while loading
    if (GRAINS[file]) { // a grain bank: no looping source, grains scheduled by update()
      const filt = ctx.createBiquadFilter(), gain = ctx.createGain();
      filt.type = "lowpass"; filt.frequency.value = 18000; gain.gain.value = 0;
      filt.connect(gain).connect(master);
      loops[part] = { grain: GRAINS[file], buf, filt, gain, file, next: 0, last: -1 };
      return;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const filt = ctx.createBiquadFilter();
    filt.type = "lowpass";
    filt.frequency.value = 18000;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(filt).connect(gain).connect(master);
    src.start(0, Math.random() * buf.duration);
    loops[part] = { src, gain, filt, file };
  }
  const ramp = (param, v, tc) => param.setTargetAtTime(v, ctx.currentTime, tc);
  // the grains a little ahead of now: each 0.35–0.7 s from a random place in a random core (never the last one), at
  // the drift's rate, joined to the next by a 40 ms equal-power crossfade. (A screech is ONE tone: 40 % overlaps at ±3 %
  // pitch were two detuned copies — "it's echoing and playing twice", user 2026-10-30.)
  const FADE = new Float32Array(32).map((_, i) => Math.sin((i / 31) * Math.PI / 2));
  const FADE_OUT = FADE.slice().reverse();
  function grains(L, rate) {
    const now = ctx.currentTime, G = L.grain;
    if (L.next < now) L.next = now + 0.01;
    while (L.next < now + 0.12) {
      let k = Math.floor(Math.random() * G.segs.length);
      if (k === L.last && G.segs.length > 1) k = (k + 1) % G.segs.length;
      L.last = k;
      const [a, b] = G.segs[k], r = rate * G.rate;
      const d = Math.min(0.35 + 0.35 * Math.random(), (b - a) / r * 0.95), x = Math.min(0.04, d * 0.2); // seconds of output
      const off = a + Math.random() * Math.max(0, (b - a) - d * r);
      const src = ctx.createBufferSource(), env = ctx.createGain();
      src.buffer = L.buf; src.playbackRate.value = r;
      env.gain.setValueAtTime(0, L.next);
      env.gain.setValueCurveAtTime(FADE, L.next, x);
      env.gain.setValueCurveAtTime(FADE_OUT, L.next + d - x, x);
      src.connect(env).connect(L.filt);
      src.start(L.next, off, d * r);
      L.next += d - x;
    }
  }
  return {
    get choice() { return { ...choice }; },
    /** the loops playing now, with their level (checks) */
    get playing() { return Object.fromEntries(Object.entries(loops).map(([p, l]) => [p, { file: l.file, gain: +l.gain.gain.value.toFixed(3) }])); },
    /** pick one recording for a part (or null for none) */
    pick(part, key) { choice[part] = key; if (ctx && LOOPS.includes(part)) setLoop(part); },
    setMuted(m) { muted = m; if (master) ramp(master.gain, m ? 0 : vol, 0.05); },
    /** play only this part's loop (the lab's audition), or null for all */
    solo(part) { solo = part; },
    setVolume(v) { vol = v; if (master) ramp(master.gain, muted ? 0 : vol, 0.05); },
    update(dt, car) {
      if (!ctx && !build()) return;
      const sp = Math.min(1, car.kmh / 260), g = car.grounded;
      const slide = Math.max(0, Math.min(1, (Math.abs(car.slip ?? 0) - 3) / 9));
      const L = {};
      for (const p of LOOPS) if (loops[p] && (!solo || solo === p)) L[p] = loops[p];
      else if (loops[p]) ramp(loops[p].gain.gain, 0, 0.03);
      if (L.roll) {
        ramp(L.roll.gain.gain, g ? (car.kmh < 3 ? 0 : 0.1 + 0.6 * sp) : 0, 0.05);
        ramp(L.roll.src.playbackRate, 0.7 + 0.6 * sp, 0.08);
        ramp(L.roll.filt.frequency, 500 + 6000 * sp, 0.08);
      }
      if (L.squeal) {
        // sliding sideways, or the brakes held hard at speed (as sfx.js's squeal, which this replaces)
        const sq = Math.max(slide, car.braking && car.kmh > 40 ? 0.55 : 0);
        ramp(L.squeal.gain.gain, g ? sq * 0.6 : 0, 0.04);
        if (L.squeal.grain) { if (g && sq > 0) grains(L.squeal, 0.92 + 0.16 * sq); } // (a slide stopping for an instant: the grains go on from where they were — a fresh one over the last was heard twice)
        else ramp(L.squeal.src.playbackRate, 0.92 + 0.16 * sq, 0.05);
      }
      if (L.wind) {
        ramp(L.wind.gain.gain, 0.02 + 0.55 * sp * sp + (g ? 0 : 0.25 * sp), 0.15);
        ramp(L.wind.src.playbackRate, 0.8 + 0.5 * sp + (g ? 0 : 0.1), 0.2);
      }
      if (L.scrape) {
        const s = Math.max(0, Math.min(1, car.scrape ?? 0));
        ramp(L.scrape.gain.gain, s * (0.35 + 0.5 * sp), 0.03);
        ramp(L.scrape.src.playbackRate, 0.85 + 0.35 * sp, 0.05);
      }
    },
    /** a landing: impact 0..18 m/s down (as sfx.landing) — one of the three takes, harder = louder, lower */
    landing(impact = 6) {
      if (!ctx || !choice.landing) return;
      const k = Math.min(1, impact / 18);
      const buf = buffers.get(`${SAMPLE_SETS.landing[choice.landing]}_${Math.floor(Math.random() * 3)}`);
      if (!buf || buf.then) return;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = 1.1 - 0.3 * k;
      const g = ctx.createGain();
      g.gain.value = 0.3 + 0.7 * k;
      src.connect(g).connect(master);
      src.start();
    },
    /** preload a part's files (the lab, before a demo) */
    preload(part, key) { const f = SAMPLE_SETS[part]?.[key]; if (!f || !ctx) return; if (part === "landing") for (let v = 0; v < 3; v++) load(`${f}_${v}`); else load(f); },
  };
}
