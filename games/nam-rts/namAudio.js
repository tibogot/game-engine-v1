// SOUND for nam-rts — GAME code. Plain WebAudio: one context, three buses
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
const STORE = "namrts.audio.v2";   // v2: sound OFF by default (your call, 2026-09-25)
const XFADE = 1.2;     // seconds a loop crossfades from its end into its start

export function createNamAudio({ app, getView, manifestUrl = "/sounds/nam/manifest.json" }) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx({ latencyHint: "interactive" });

  // ── The mix ────────────────────────────────────────────────────────────────
  const settings = { master: 0.8, sfx: 1, ambience: 0.7, ui: 0.6, muted: true, picks: {} };
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
  // Muted is OFF, not silent: the context is suspended, so the audio thread
  // does no work at all (and no loop is kept alive — see updateLoops).
  function applyMix() {
    master.gain.value = settings.muted ? 0 : settings.master;
    for (const k in buses) buses[k].gain.value = settings[k];
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
    // The same sound started twice within a few ms only phases against itself.
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
    const file = files[(Math.random() * files.length) | 0];
    const buf = buffers.get(file.f);
    const v = chain(S, sp);
    v.level = level;
    const pv = S.pitch ?? 0.05;
    const rate = (o.rate ?? 1) * (1 + (Math.random() * 2 - 1) * pv);
    const s = source(v, buf, rate);
    v.srcs.push(s);
    v.g.gain.value = level * (file.gain ?? 1);
    const t = now + (o.delay ?? 0);
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
    S.last = now;
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
  function updateLoops() {
    if (ctx.state !== "running") return;
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
