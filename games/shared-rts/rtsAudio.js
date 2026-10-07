// THE RTS MIXER — shared by the RTS games (moved from nam-rts/namAudio.js
// 2026-09-30, unchanged: identical machinery). Each game passes its own
// manifest, its own storage key and whether it starts muted; what event makes
// which sound stays each game's (namSounds.js, algSounds.js).
//
// Plain WebAudio: one context, three buses
// (sfx, ambience, ui) into a master gain and a gentle compressor, so a big
// firefight gets DENSE instead of clipping.
//
// Every sound is a SLOT ("rifle", "huey", "jungle"…) with one or more files
// (public/sounds/nam/manifest.json — all CC0, with where each came from). A
// slot holds several CANDIDATES; Dev → SOUND swaps them live, in the game,
// because only ears can choose. Each file carries a measured `gain` (its
// loudness normalised) and, for one-shots, `start`/`end` (silence trimmed).
//
// THE LISTENER is the RTS camera, not a head: what you hear is what is round
// the point the camera looks at. Distance is measured to that focus with the
// camera's height folded in, so zooming out makes the whole fight a little
// quieter and duller, the way Company of Heroes does. Far sounds lose their
// top end (a low-pass per voice) — distant gunfire is a thump, not a crack.
// Left/right comes from where the thing is ON SCREEN.
//
// Cost: one-shots are fire-and-forget; loops (rotors, engines, fire, the
// jungle) are re-aimed once a frame. Each slot caps its voices and the mix
// caps at MAX_VOICES, stealing the quietest.
import * as THREE from "three";

const MAX_VOICES = 40;
const XFADE = 1.2;     // seconds a loop crossfades from its end into its start

export function createRtsAudio({ app, getView, manifestUrl, storeKey, startMuted = true, distanceFx = null }) {
  const STORE = storeKey;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx({ latencyHint: "interactive" });

  // ── The mix ────────────────────────────────────────────────────────────────
  const settings = { master: 0.8, sfx: 1, ambience: 0.7, ui: 0.6, muted: startMuted, picks: {} };
  try { Object.assign(settings, JSON.parse(localStorage.getItem(STORE) || "{}")); } catch { /* private window */ }
  const save = () => { try { localStorage.setItem(STORE, JSON.stringify(settings)); } catch { /* ignore */ } };

  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -16; comp.knee.value = 12; comp.ratio.value = 4;
  comp.attack.value = 0.004; comp.release.value = 0.25;
  const master = ctx.createGain();
  master.connect(comp).connect(ctx.destination);
  let meterNode = null;
  const buses = {};
  for (const k of ["sfx", "ambience", "ui"]) { buses[k] = ctx.createGain(); buses[k].connect(master); }
  // The ambience is a BED: a recorded jungle has single birds calling 12-16 dB
  // over it, and looped that is one bird shouting at you every few seconds
  // (your report). Its own compressor holds the calls down to the bed.
  {
    const ambComp = ctx.createDynamicsCompressor();
    ambComp.threshold.value = -42; ambComp.knee.value = 6; ambComp.ratio.value = 8;
    ambComp.attack.value = 0.01; ambComp.release.value = 0.4;
    buses.ambience.disconnect();
    buses.ambience.connect(ambComp).connect(master);
  }
  // ── DISTANCE, the way a valley sounds (opt-in `distanceFx`, alg-rts 2026-10-07) ─────────────
  //   ECHO      a far shot rings off the slopes: a send to one shared convolver whose impulse is
  //             SYNTHESISED (no recording): two slap-backs off the valley walls and a long diffuse
  //             tail, low-passed. The send grows with distance — near, a dry crack; far, the
  //             crack is gone and the echo is most of what you hear.
  //   DELAY     sound takes ~3 ms a metre: past `delayFrom` m a shot is heard after its flash.
  //   DUCKING   a fight near the camera pushes the AMBIENCE bed (wind, cicadas) down, and it
  //             comes back as the fight dies — the battle takes the soundscape over.
  const DFX = distanceFx ? { echoMax: 0.75, echoFrom: 1.2, echoSpan: 5, delayFrom: 140, soundSpeed: 343, duck: 0.65, duckK: 0.9, duckRelease: 0.35, ...distanceFx } : null;
  let echoIn = null, battle = 0;
  if (DFX) {
    const sr = ctx.sampleRate, len = Math.round(sr * 3.2);
    const ir = ctx.createBuffer(2, len, sr);
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c);
      for (let i = 0; i < len; i++) {
        const t = i / sr;
        // the diffuse tail: noise decaying over ~2.5 s, slow onset (no direct sound in it)
        // (a 45 ms pre-delay: echo energy overlapping the dry crack combs against it — the "jet")
        let v = t < 0.045 ? 0 : (Math.random() * 2 - 1) * Math.exp(-t / 0.75) * Math.min(1, (t - 0.045) / 0.06) * 0.35;
        // two slaps off the valley walls, a little different per ear
        for (const [at, a] of [[0.32 + c * 0.04, 0.9], [0.86 - c * 0.05, 0.55], [1.45 + c * 0.03, 0.3]]) {
          const k = (t - at) / 0.025;
          if (k > 0 && k < 6) v += (Math.random() * 2 - 1) * a * Math.exp(-k);
        }
        d[i] = v;
      }
    }
    const conv = ctx.createConvolver();
    conv.buffer = ir;
    const tone = ctx.createBiquadFilter();
    tone.type = "lowpass"; tone.frequency.value = 2400; tone.Q.value = 0.4;
    const wet = ctx.createGain(); wet.gain.value = 0.9;
    echoIn = ctx.createGain();
    echoIn.connect(conv).connect(tone).connect(wet).connect(buses.sfx);
  }

  // Muted is OFF, not silent: the context is suspended, so the audio thread
  // does no work at all (and no loop is kept alive — see updateLoops).
  function applyMix() {
    master.gain.value = settings.muted ? 0 : settings.master;
    for (const k in buses) { buses[k].gain.cancelScheduledValues?.(0); buses[k].gain.value = settings[k]; }
    if (settings.muted) ctx.suspend(); else if (!document.hidden) ctx.resume();
  }
  applyMix();

  // Browsers start a context suspended until the player does something.
  const unlock = () => { if (!settings.muted && ctx.state === "suspended") ctx.resume(); };
  window.addEventListener("pointerdown", unlock, true);
  window.addEventListener("keydown", unlock, true);
  // A hidden tab should not keep a battle going in the background.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) ctx.suspend(); else if (!settings.muted) ctx.resume();
  });

  // ── Slots and their files ──────────────────────────────────────────────────
  let manifest = { slots: {} };
  const slots = {};          // name -> { ...manifest slot, live: [], last }
  const buffers = new Map(); // file path -> AudioBuffer | Promise | null
  const base = new URL(manifestUrl, location.origin);

  function load(file) {
    if (buffers.has(file)) return buffers.get(file);
    const p = fetch(new URL(file, base)).then((r) => r.arrayBuffer()).then((b) => ctx.decodeAudioData(b))
      .then((buf) => { buffers.set(file, buf); return buf; })
      .catch((e) => { console.warn("[audio] could not load", file, e); buffers.set(file, null); return null; });
    buffers.set(file, p);
    return p;
  }
  const isBuf = (f) => buffers.get(f.f) instanceof AudioBuffer;
  /** The files a slot plays now: its chosen candidate(s). */
  const chosen = (S) => (S.use ?? [0]).map((i) => S.files[i]).filter(Boolean);

  const ready = fetch(base).then((r) => r.json()).then(async (m) => {
    manifest = m;
    for (const [name, s] of Object.entries(m.slots)) {
      slots[name] = { ...s, name, live: [], last: -1 };
      // Your picks from the panel outlive a reload (until they are baked into the manifest).
      const saved = settings.picks?.[name];
      if (Array.isArray(saved) && saved.every((i) => i < s.files.length)) slots[name].use = saved;
    }
    // Only the chosen files; the other candidates load when the panel picks them.
    await Promise.all(Object.values(slots).flatMap((S) => chosen(S).map((f) => load(f.f))));
  }).catch((e) => console.warn("[audio] no manifest", e));

  // ── Where a sound is, heard from the camera ────────────────────────────────
  const _v = new THREE.Vector3();
  function spatial(x, y, z, ref, out = {}) {
    const view = getView();
    const f = view?.focus;
    if (!f) { out.gain = 1; out.cutoff = 20000; out.pan = 0; out.eff = 0; return out; }
    const h = (view.height ?? 60) * 0.55;
    const eff = Math.hypot(x - f.x, z - f.z, h);
    out.gain = 1 / (1 + Math.max(0, eff - ref) / ref);
    // Air eats the top end: halve the cutoff every ~1.3 refs past the first.
    out.cutoff = Math.max(650, 20000 * Math.pow(0.5, Math.max(0, eff - ref) / (ref * 1.3)));
    _v.set(x, y, z).project(app.camera);
    out.pan = THREE.MathUtils.clamp(_v.x * 0.75, -0.85, 0.85);
    out.eff = eff;
    return out;
  }

  // ── Voices ─────────────────────────────────────────────────────────────────
  // A voice is a chain: level → low-pass → pan → its bus. Sources plug into it
  // (one for a one-shot, two briefly while a loop crossfades).
  let liveCount = 0;
  function chain(S, sp) {
    const g = ctx.createGain();
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = sp ? sp.cutoff : 20000;
    lp.Q.value = 0.5;
    const pan = ctx.createStereoPanner();
    pan.pan.value = sp ? sp.pan : 0;
    g.connect(lp).connect(pan).connect(buses[S.bus ?? "sfx"]);
    // The valley echo: the further, the more of it (sfx one-shots and loops alike).
    if (echoIn && sp && !S.loop && (S.bus ?? "sfx") === "sfx" && S.echo !== false) {
      const ref = S.ref ?? 40;
      const k = Math.min(1, Math.max(0, (sp.eff - ref * DFX.echoFrom) / (ref * DFX.echoSpan)));
      if (k > 0.02) {
        const send = ctx.createGain();
        send.gain.value = DFX.echoMax * k;
        pan.connect(send).connect(echoIn);
        // Far, the dry sound gives way to its echo (applied where the level is set: `dry`).
        return { g, lp, pan, S, level: 0, srcs: [], dry: 1 - 0.5 * k };
      }
    }
    return { g, lp, pan, S, level: 0, srcs: [], dry: 1 };
  }
  function source(v, buf, rate) {
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const sg = ctx.createGain();
    src.connect(sg).connect(v.g);
    return { src, sg };
  }
  function release(v) {
    if (v.dead) return;
    v.dead = true;
    const i = v.S.live.indexOf(v);
    if (i >= 0) { v.S.live.splice(i, 1); liveCount--; }
    try { v.pan.disconnect(); } catch { /* already */ }
  }
  function stop(v, fade = 0.08) {
    const now = ctx.currentTime;
    v.g.gain.cancelScheduledValues(now);
    v.g.gain.setValueAtTime(v.g.gain.value, now);
    v.g.gain.linearRampToValueAtTime(0, now + fade);
    for (const s of v.srcs) { try { s.src.stop(now + fade + 0.02); } catch { /* not started */ } }
    setTimeout(() => release(v), (fade + 0.1) * 1000);
  }

  /**
   * A one-shot at a world point (or anywhere, with x = null: UI and stingers).
   * o: { gain, rate, delay }. Returns quietly when it would not be heard.
   */
  function play(name, x = null, y = 0, z = 0, o = {}) {
    let S = slots[name];
    if (!S || settings.muted || ctx.state !== "running") return null;
    let sp = null;
    if (x !== null) {
      sp = spatial(x, y, z, S.ref ?? 40);
      // Far away, a loud sound becomes a different sound (a crack → a thump).
      if (S.far && slots[S.far] && sp.eff > (S.farAt ?? 200)) { S = slots[S.far]; sp = spatial(x, y, z, S.ref ?? 60); }
    }
    const level = (S.vol ?? 1) * (o.gain ?? 1) * (sp ? sp.gain : 1);
    if (level < 0.012) return null;
    const now = ctx.currentTime;
    // ANTI-PHASING (you, 2026-10-07: "phasing/flanging when two shots play almost together"): the
    // same recording twice within tens of ms combs against itself. So: never the same sound twice
    // inside `gap` (raised: 25-60 ms IS the flanging range); never the same FILE twice in a row
    // when there are several; and a copy close behind the last one is pitched clearly apart.
    if (now - S.last < (S.gap ?? 0.015)) return null;
    const files = chosen(S).filter(isBuf);
    if (!files.length) { chosen(S).forEach((f) => load(f.f)); return null; }
    // Voice caps: this slot's, then the whole mix's — steal the quietest if we are louder.
    const full = S.live.length >= (S.voices ?? 6);
    if (full || liveCount >= MAX_VOICES) {
      const pool = full ? S.live : Object.values(slots).flatMap((s) => s.live);
      let q = null;
      for (const v of pool) if (!v.loop && !v.dead && (!q || v.level < q.level)) q = v;
      if (!q || q.level >= level) return null;
      stop(q, 0.03);
    }
    let file = files[(Math.random() * files.length) | 0];
    if (files.length > 1 && file === S.lastFile) file = files[(files.indexOf(file) + 1 + ((Math.random() * (files.length - 1)) | 0)) % files.length];
    const buf = buffers.get(file.f);
    const v = chain(S, sp);
    v.level = level;
    const pv = S.pitch ?? 0.05;
    let rate = (o.rate ?? 1) * (1 + (Math.random() * 2 - 1) * pv);
    // Close behind the last copy of the same file: at least 7% apart in pitch (the comb then sweeps
    // fast enough to read as two shots, not one smeared one).
    if (file === S.lastFile && now - S.last < 0.15 && Math.abs(rate / (S.lastRate || rate) - 1) < 0.07) rate = S.lastRate * (S.lastRate > (o.rate ?? 1) ? 0.92 : 1.08);
    const s = source(v, buf, rate);
    v.srcs.push(s);
    v.g.gain.value = level * (file.gain ?? 1) * v.dry;
    // Sound takes time to arrive from far away.
    const travel = DFX && sp && sp.eff > DFX.delayFrom ? (sp.eff - DFX.delayFrom) / DFX.soundSpeed : 0;
    const t = now + (o.delay ?? 0) + travel;
    // A fight near the camera (the ducking): its loudness, here.
    if (DFX && (S.bus ?? "sfx") === "sfx" && sp && sp.eff < (S.ref ?? 40) * 2.5) battle += level;
    const start = file.start ?? 0;
    const end = Math.min(buf.duration, file.end || buf.duration);
    const dur = Math.max(0.02, end - start);
    s.src.start(t, start, dur);
    // A trimmed tail is faded, not cut: a cut clicks.
    if (end < buf.duration - 0.01) {
      const tEnd = t + dur / rate;
      s.sg.gain.setValueAtTime(1, Math.max(t, tEnd - 0.06));
      s.sg.gain.linearRampToValueAtTime(0, tEnd);
    }
    s.src.onended = () => release(v);
    S.live.push(v); liveCount++;
    S.last = now; S.lastFile = file; S.lastRate = rate;
    return v;
  }

  // ── Loops: rotors, engines, fire, the jungle ───────────────────────────────
  // Providers are asked once a frame for what COULD be sounding; each slot
  // keeps its `loops` loudest, by key, so a rotor does not restart when
  // another Huey comes closer. A loop crossfades its end into its start, so a
  // 16 s recording never clicks at the seam.
  const providers = [];
  const loops = new Map();   // key -> voice
  function addLoopProvider(fn) { providers.push(fn); }

  function loopSource(v, when, offset) {
    const f = v.file, buf = buffers.get(f.f);
    const s = source(v, buf, v.rate);
    s.sg.gain.setValueAtTime(0, when);
    s.sg.gain.linearRampToValueAtTime(1, when + XFADE);
    s.src.start(when, offset);
    // When this one reaches its end (less the crossfade), the next begins.
    s.nextAt = when + (buf.duration - offset) / v.rate - XFADE;
    v.srcs.push(s);
    return s;
  }

  const _sp = {};
  let _lastDuck = 0;
  function updateLoops() {
    if (ctx.state !== "running") return;
    // THE DUCKING: the fight's loudness near the camera, decaying; the ambience bed pushed down
    // by it (at most DFX.duck), coming back over a few seconds.
    if (DFX) {
      const now = ctx.currentTime, dt = Math.min(0.25, now - _lastDuck);
      _lastDuck = now;
      battle *= Math.exp(-dt / DFX.duckRelease * 0.35);
      const duck = Math.min(DFX.duck, battle * DFX.duckK * 0.1);
      buses.ambience.gain.setTargetAtTime(settings.ambience * (1 - duck), now, duck > 0.05 ? 0.15 : 1.2);
    }
    const want = new Map();  // slot -> [{key, level, sp, rate}]
    for (const p of providers) {
      for (const c of p() ?? []) {
        const S = slots[c.slot];
        if (!S) continue;
        const sp = c.x == null ? null : { ...spatial(c.x, c.y ?? 0, c.z, S.ref ?? 40, _sp) };
        const level = (S.vol ?? 1) * (c.level ?? 1) * (sp ? sp.gain : 1);
        if (level < 0.008) continue;
        if (!want.has(c.slot)) want.set(c.slot, []);
        want.get(c.slot).push({ key: c.key ?? c.slot, level, sp, rate: c.rate ?? 1 });
      }
    }
    const keep = new Set();
    const now = ctx.currentTime;
    for (const [name, list] of want) {
      const S = slots[name];
      list.sort((a, b) => b.level - a.level);
      for (const c of list.slice(0, S.loops ?? 2)) {
        let v = loops.get(c.key);
        if (!v) {
          const f = chosen(S).find(isBuf);
          if (!f) { chosen(S).forEach((ff) => load(ff.f)); continue; }
          v = chain(S, c.sp);
          v.loop = true;
          v.file = f;
          v.rate = c.rate;
          v.g.gain.value = 0;
          // Start somewhere in the recording so two rotors never beat in phase.
          const dur = buffers.get(f.f).duration;
          loopSource(v, now, Math.random() * Math.max(0, dur - XFADE * 3));
          S.live.push(v); liveCount++;
          loops.set(c.key, v);
        }
        keep.add(c.key);
        v.level = c.level;
        v.g.gain.setTargetAtTime(c.level * (v.file.gain ?? 1), now, 0.15);
        if (c.sp) {
          v.lp.frequency.setTargetAtTime(c.sp.cutoff, now, 0.15);
          v.pan.pan.setTargetAtTime(c.sp.pan, now, 0.15);
        }
        // The seam: schedule the next pass a little ahead of the crossfade.
        const cur = v.srcs[v.srcs.length - 1];
        if (cur && now > cur.nextAt - 0.25 && !cur.handed) {
          cur.handed = true;
          const at = Math.max(now + 0.02, cur.nextAt);
          cur.sg.gain.setValueAtTime(1, at);
          cur.sg.gain.linearRampToValueAtTime(0, at + XFADE);
          try { cur.src.stop(at + XFADE + 0.05); } catch { /* ok */ }
          cur.src.onended = () => { const i = v.srcs.indexOf(cur); if (i >= 0) v.srcs.splice(i, 1); };
          loopSource(v, at, 0);
        }
      }
    }
    for (const [key, v] of loops) {
      if (keep.has(key)) continue;
      stop(v, 0.6);
      loops.delete(key);
    }
  }

  // ── The Dev → SOUND panel ──────────────────────────────────────────────────
  /** Pick which candidate(s) a slot plays; loads them, restarts its loops. */
  async function choose(name, use) {
    const S = slots[name];
    if (!S) return;
    S.use = use;
    settings.picks = { ...(settings.picks ?? {}), [name]: use };
    save();
    await Promise.all(chosen(S).map((f) => load(f.f)));
    for (const [key, v] of loops) if (v.S === S) { stop(v, 0.2); loops.delete(key); }
  }

  /** Audition: one of a slot's candidates, dry, whatever the slot is set to. */
  function audition(name, index) {
    const S = slots[name];
    const f = S?.files[index];
    if (!f) return;
    unlock();
    Promise.resolve(load(f.f)).then((buf) => {
      if (!buf) return;
      const v = chain(S, null);
      v.g.gain.value = (S.vol ?? 1) * (f.gain ?? 1);
      const s = source(v, buf, 1);
      const start = f.start ?? 0;
      const len = Math.min((f.end || buf.duration) - start, S.loop ? 8 : 10);
      s.src.start(ctx.currentTime, start, len);
      s.sg.gain.setValueAtTime(1, ctx.currentTime + len - 0.3);
      s.sg.gain.linearRampToValueAtTime(0, ctx.currentTime + len);
      s.src.onended = () => { try { v.pan.disconnect(); } catch { /* ok */ } };
    });
  }

  return {
    ready, ctx, play, addLoopProvider, choose, audition, settings,
    /** The sfx / ambience / ui buses, for a game's own nodes (alg-rts voices). */
    buses,
    update: updateLoops,
    get slots() { return slots; },
    get manifest() { return manifest; },
    get voices() { return liveCount; },
    set(key, value) { settings[key] = value; applyMix(); save(); },
    /**
     * What is coming OUT, measured (a dev check — nobody can listen for you):
     * { peakDb, rmsDb, reductionDb } over the last ~0.1 s after the compressor.
     */
    meter() {
      if (!meterNode) { meterNode = ctx.createAnalyser(); meterNode.fftSize = 4096; comp.connect(meterNode); }
      const d = new Float32Array(meterNode.fftSize);
      meterNode.getFloatTimeDomainData(d);
      let pk = 0, s = 0;
      for (const x of d) { pk = Math.max(pk, Math.abs(x)); s += x * x; }
      const db = (v) => +(20 * Math.log10(v + 1e-9)).toFixed(1);
      return { peakDb: db(pk), rmsDb: db(Math.sqrt(s / d.length)), reductionDb: +comp.reduction.toFixed(1) };
    },
  };
}
