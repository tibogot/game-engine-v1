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
export const SAMPLE_SETS = {
  squeal: { b: "squeal_b" },
  roll: { a: "roll_a", b: "roll_b" },
  wind: { a: "wind_a", b: "wind_b", c: "wind_c" },
  scrape: {},
  landing: {},
};
export const GAME_PICK = { squeal: "b" };
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
    if (old) { old.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.03); old.src.stop(ctx.currentTime + 0.2); delete loops[part]; }
    const key = choice[part], file = key && SAMPLE_SETS[part][key];
    if (!file) return;
    const buf = await load(file);
    if (choice[part] !== key || loops[part]) return; // changed while loading
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
        ramp(L.squeal.src.playbackRate, 0.92 + 0.16 * sq, 0.05);
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
