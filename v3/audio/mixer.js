// THE MIXER — the engine's game-neutral sound core (v3/AUDIO_PLAN.md). Ported from
// games/shared-rts/rtsAudio.js (which stays as it is until alg-rts ships, then becomes a thin layer on
// this): the same machinery, minus the RTS-only distance effects, plus a pluggable LISTENER.
//
// Plain WebAudio: one context, buses (music, sfx, ambience, ui by default) into a master gain and a
// gentle compressor, so a busy moment gets DENSE instead of clipping.
//
// Every recorded sound is a SLOT ("rifle", "engine_4000"…) with one or more files from the game's
// manifest ({ slots: { name: { files: [{ f, gain, start, end, peak }], bus, vol, ref, voices, loops,
// pitch, gap, use, far, farAt } } }). A slot holds several CANDIDATES that a dev panel can swap live
// (choose / audition): only ears can choose. Each file carries a measured `gain` (its loudness
// normalised) and, for one-shots, `start` / `end` (silence trimmed).
//
// THE LISTENER (listeners.js) says how loud, dull and left/right a point is: the RTS camera focus for an
// RTS, the chase camera for a racer. Sounds with no position (UI, the player's own car) skip it.
//
// Cost: one-shots are fire-and-forget; loops are asked from PROVIDERS once a frame and re-aimed; each
// slot caps its voices and the mix caps at maxVoices, stealing the quietest.

const XFADE = 1.2; // s a loop crossfades from its end into its start

/**
 * @param o.storeKey     localStorage key of the saved mix (per game)
 * @param o.defaults     the mix's defaults: { master, music, sfx, ambience, ui, muted }
 * @param o.buses        bus names (default music, sfx, ambience, ui)
 * @param o.listener     { spatial(x, y, z, ref, out) } (listeners.js); setListener() swaps it
 * @param o.manifestUrl  a slot manifest to load now (load() loads one later, or none: synth-only games)
 * @param o.maxVoices    the whole mix's voice cap (default 40)
 */
export function createMixer({ storeKey, defaults = {}, buses: busNames = ["music", "sfx", "ambience", "ui"], listener = null, manifestUrl = null, maxVoices = 40 } = {}) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx({ latencyHint: "interactive" });

  // ── The mix ────────────────────────────────────────────────────────────────
  const settings = { master: 0.8, muted: true, picks: {}, ...Object.fromEntries(busNames.map((b) => [b, 1])), ...defaults };
  try { Object.assign(settings, JSON.parse(localStorage.getItem(storeKey) || "{}")); } catch { /* private window */ }
  const save = () => { try { localStorage.setItem(storeKey, JSON.stringify(settings)); } catch { /* ignore */ } };

  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -16; comp.knee.value = 12; comp.ratio.value = 4;
  comp.attack.value = 0.004; comp.release.value = 0.25;
  const master = ctx.createGain();
  master.connect(comp).connect(ctx.destination);
  let meterNode = null;
  const buses = {};
  for (const k of busNames) { buses[k] = ctx.createGain(); buses[k].connect(master); }
  // The ambience is a BED: single loud events in a looped bed (one bird shouting every few seconds)
  // are held down to it by its own compressor (rtsAudio.js).
  if (buses.ambience) {
    const ambComp = ctx.createDynamicsCompressor();
    ambComp.threshold.value = -42; ambComp.knee.value = 6; ambComp.ratio.value = 8;
    ambComp.attack.value = 0.01; ambComp.release.value = 0.4;
    buses.ambience.disconnect();
    buses.ambience.connect(ambComp).connect(master);
  }

  // Muted is OFF, not silent: the context is suspended, so the audio thread does no work. PAUSED (a
  // game's pause menu, a hidden tab) suspends it too, without touching the saved mute.
  let paused = false;
  const running = () => !settings.muted && !paused && !document.hidden;
  function applyMix() {
    const now = ctx.currentTime;
    master.gain.setTargetAtTime(settings.muted ? 0 : settings.master, now, 0.03);
    for (const k in buses) buses[k].gain.setTargetAtTime(settings[k] ?? 1, now, 0.03);
    if (running()) ctx.resume(); else ctx.suspend();
  }
  applyMix();

  // Browsers start a context suspended until the player does something: the first key / click
  // resumes it, and calls what a game waited for (an AudioWorklet module, say).
  const unlockers = [];
  let unlocked = false;
  function unlock() {
    if (running() && ctx.state !== "running") ctx.resume();
    if (!unlocked && ctx.state === "running") { unlocked = true; for (const f of unlockers.splice(0)) f(ctx); }
  }
  window.addEventListener("pointerdown", unlock, true);
  window.addEventListener("keydown", unlock, true);
  ctx.addEventListener?.("statechange", unlock);
  document.addEventListener("visibilitychange", applyMix);

  // ── Slots and their files ──────────────────────────────────────────────────
  const slots = {};          // name -> { ...manifest slot, live: [], last }
  const buffers = new Map(); // file URL -> AudioBuffer | Promise | null
  let manifest = { slots: {} };

  function loadFile(url) {
    if (buffers.has(url)) return buffers.get(url);
    const p = fetch(url).then((r) => r.arrayBuffer()).then((b) => ctx.decodeAudioData(b))
      .then((buf) => { buffers.set(url, buf); return buf; })
      .catch((e) => { console.warn("[audio] could not load", url, e); buffers.set(url, null); return null; });
    buffers.set(url, p);
    return p;
  }
  const isBuf = (f) => buffers.get(f.url) instanceof AudioBuffer;
  /** The files a slot plays now: its chosen candidate(s). */
  const chosen = (S) => (S.use ?? [0]).map((i) => S.files[i]).filter(Boolean);

  /** Add slots ({ name: slot }); file paths resolve against `base`. Loads the chosen files. */
  function addSlots(defs, base = location.href) {
    for (const [name, s] of Object.entries(defs)) {
      const files = (s.files ?? []).map((f) => ({ ...f, url: new URL(f.f, base).href }));
      slots[name] = { ...s, files, name, live: [], last: -1 };
      // the picks from a dev panel outlive a reload (until they are baked into the manifest)
      const saved = settings.picks?.[name];
      if (Array.isArray(saved) && saved.every((i) => i < files.length)) slots[name].use = saved;
    }
    return Promise.all(Object.keys(defs).flatMap((n) => chosen(slots[n]).map((f) => loadFile(f.url))));
  }
  /** Load a slot manifest (JSON at `url`). */
  function load(url) {
    const base = new URL(url, location.href);
    return fetch(base).then((r) => r.json()).then((m) => { manifest = m; return addSlots(m.slots ?? {}, base.href); })
      .catch((e) => console.warn("[audio] no manifest", url, e));
  }
  const ready = manifestUrl ? load(manifestUrl) : Promise.resolve();

  // ── Where a sound is, heard from the listener ──────────────────────────────
  let L = listener;
  const spatial = (x, y, z, ref, out = {}) => {
    if (!L) { out.gain = 1; out.cutoff = 20000; out.pan = 0; out.eff = 0; return out; }
    return L.spatial(x, y, z, ref, out);
  };

  // ── Voices ─────────────────────────────────────────────────────────────────
  // A voice is a chain: level → low-pass → pan → its bus. Sources plug into it (one for a one-shot,
  // two briefly while a loop crossfades).
  let liveCount = 0;
  function chain(S, sp) {
    const g = ctx.createGain();
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = sp ? sp.cutoff : 20000;
    lp.Q.value = 0.5;
    const pan = ctx.createStereoPanner();
    pan.pan.value = sp ? sp.pan : 0;
    g.connect(lp).connect(pan).connect(buses[S.bus ?? "sfx"] ?? buses[busNames[0]]);
    return { g, lp, pan, S, level: 0, srcs: [] };
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
  /** Make room for a new voice in slot S (its cap, then the mix's): steal the quietest, if quieter. */
  function room(S, level) {
    const full = S.live.length >= (S.voices ?? 6);
    if (!full && liveCount < maxVoices) return true;
    const pool = full ? S.live : Object.values(slots).flatMap((s) => s.live);
    let q = null;
    for (const v of pool) if (!v.loop && !v.dead && (!q || v.level < q.level)) q = v;
    if (!q || q.level >= level) return false;
    stop(q, 0.03);
    return true;
  }

  /**
   * A one-shot at a world point, or anywhere with x = null (UI, the player's own car, stingers).
   * o: { gain, rate, delay, peakIn }. Returns the voice, or null when it would not be heard.
   */
  function play(name, x = null, y = 0, z = 0, o = {}) {
    let S = slots[name];
    if (!S || ctx.state !== "running") return null;
    let sp = null;
    if (x !== null) {
      sp = spatial(x, y, z, S.ref ?? 40);
      // far away, a loud sound becomes a different sound (a crack → a thump)
      if (S.far && slots[S.far] && sp.eff > (S.farAt ?? 200)) { S = slots[S.far]; sp = spatial(x, y, z, S.ref ?? 60); }
    }
    const level = (S.vol ?? 1) * (o.gain ?? 1) * (sp ? sp.gain : 1);
    if (level < 0.012) return null;
    const now = ctx.currentTime;
    // ANTI-PHASING (rtsAudio.js): the same recording twice within tens of ms combs against itself.
    // Never the same sound twice inside `gap`; never the same FILE twice in a row when there are
    // several; a copy close behind the last one is pitched clearly apart.
    if (now - S.last < (S.gap ?? 0.015)) return null;
    const files = chosen(S).filter(isBuf);
    if (!files.length) { chosen(S).forEach((f) => loadFile(f.url)); return null; }
    if (!room(S, level)) return null;
    let file = files[(Math.random() * files.length) | 0];
    if (files.length > 1 && file === S.lastFile) file = files[(files.indexOf(file) + 1 + ((Math.random() * (files.length - 1)) | 0)) % files.length];
    const buf = buffers.get(file.url);
    const v = chain(S, sp);
    v.level = level;
    const pv = S.pitch ?? 0.05;
    let rate = (o.rate ?? 1) * (1 + (Math.random() * 2 - 1) * pv);
    if (file === S.lastFile && now - S.last < 0.15 && Math.abs(rate / (S.lastRate || rate) - 1) < 0.07) rate = S.lastRate * (S.lastRate > (o.rate ?? 1) ? 0.92 : 1.08);
    const s = source(v, buf, rate);
    v.srcs.push(s);
    v.g.gain.value = level * (file.gain ?? 1);
    let t = now + (o.delay ?? 0);
    // `peakIn`: the recording's PEAK (its manifest `peak`, s into the file — else its middle: a flyby
    // is loudest as it passes) lands `peakIn` s from now: the file is entered part-way, or waited for.
    let skip = 0;
    if (o.peakIn != null) {
      const pk = file.peak ?? ((file.start ?? 0) + Math.min(buf.duration, file.end || buf.duration)) / 2;
      const lead = (pk - (file.start ?? 0)) / rate - o.peakIn;
      if (lead > 0) skip = lead * rate; else t += -lead;
    }
    const start = (file.start ?? 0) + skip;
    const end = Math.min(buf.duration, file.end || buf.duration);
    const dur = Math.max(0.02, end - start);
    s.src.start(t, start, dur);
    // a trimmed tail is faded, not cut: a cut clicks
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

  // ── Loops ──────────────────────────────────────────────────────────────────
  // Providers are asked once a frame for what COULD be sounding ({ slot, key, x, y, z, level, rate });
  // each slot keeps its `loops` loudest, by key, so a loop does not restart when another comes closer.
  // A loop crossfades its end into its start, so a long recording never clicks at the seam.
  const providers = [];
  const loops = new Map(); // key -> voice
  function addLoopProvider(fn) { providers.push(fn); return () => providers.splice(providers.indexOf(fn), 1); }

  function loopSource(v, when, offset) {
    const buf = buffers.get(v.file.url);
    const s = source(v, buf, v.rate);
    s.sg.gain.setValueAtTime(0, when);
    s.sg.gain.linearRampToValueAtTime(1, when + XFADE);
    s.src.start(when, offset);
    // when this one reaches its end (less the crossfade), the next begins
    s.nextAt = when + (buf.duration - offset) / v.rate - XFADE;
    v.srcs.push(s);
    return s;
  }

  const _sp = {};
  /** Once a frame: re-aim the loops. */
  function update() {
    if (ctx.state !== "running") return;
    const want = new Map(); // slot -> [{key, level, sp, rate}]
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
          if (!f) { chosen(S).forEach((ff) => loadFile(ff.url)); continue; }
          v = chain(S, c.sp);
          v.loop = true;
          v.file = f;
          v.rate = c.rate;
          v.g.gain.value = 0;
          // start somewhere in the recording, so two of them never beat in phase
          const dur = buffers.get(f.url).duration;
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
        // the seam: schedule the next pass a little ahead of the crossfade
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

  // ── A dev panel's tools ────────────────────────────────────────────────────
  /** Pick which candidate(s) a slot plays; loads them, restarts its loops. */
  async function choose(name, use) {
    const S = slots[name];
    if (!S) return;
    S.use = use;
    settings.picks = { ...(settings.picks ?? {}), [name]: use };
    save();
    await Promise.all(chosen(S).map((f) => loadFile(f.url)));
    for (const [key, v] of loops) if (v.S === S) { stop(v, 0.2); loops.delete(key); }
  }
  /** Audition: one of a slot's candidates, dry, whatever the slot is set to. */
  function audition(name, index) {
    const S = slots[name];
    const f = S?.files[index];
    if (!f) return;
    unlock();
    Promise.resolve(loadFile(f.url)).then((buf) => {
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
    ctx, buses, settings, ready, load, addSlots, play, addLoopProvider, update, choose, audition, spatial,
    /** a voice chain (level → low-pass → pan → the slot's bus) for a game's own sources (voices.js) */
    chain: (bus = "sfx", sp = null) => chain({ bus, live: [] }, sp),
    get slots() { return slots; },
    get manifest() { return manifest; },
    get voices() { return liveCount; },
    get unlocked() { return unlocked; },
    get paused() { return paused; },
    setListener(l) { L = l; },
    /** set a mix value (master, a bus, muted) and save it */
    set(key, value) { settings[key] = value; applyMix(); save(); },
    /** a game's pause (its menu): suspends the audio, keeps the mix */
    pause() { paused = true; applyMix(); },
    resume() { paused = false; applyMix(); unlock(); },
    /** run `fn(ctx)` once the context first runs (now if it already does) */
    onUnlock(fn) { if (unlocked) fn(ctx); else unlockers.push(fn); },
    unlock,
    /**
     * What is coming OUT, measured (nobody can listen for you):
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

