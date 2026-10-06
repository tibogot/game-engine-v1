// THE VOICES — soldiers who talk, and the radio (you, 2026-10-02: "the
// soldiers' communication is missing, the enemies' too; radio calls in French
// and Arabic"). The lines: tools/algVoiceLines.mjs, generated once by
// tools/genVoices.mjs (ElevenLabs) into public/sounds/alg/voices/.
//
//   BARKS   said by the man, from where he is (heard round the camera's focus,
//           panned from the screen): orders acknowledged, contact, under fire,
//           pinned, grenade, man down, sappers at work. The ALN shout in
//           Algerian Arabic — only when you can SEE them and are near.
//   RADIO   the post / HQ, through a radio filter (band-pass, a little grit)
//           after a squelch: what algBattle's alerts announce.
//
// Company of Heroes' rule: barks are RARE. One man speaks at a time per side,
// every line has its own cooldown, the urgent ones (grenade, man down) skip
// the queue of nothing — a line that cannot be said now is simply dropped.
// Each man keeps ONE voice (by his place in the unit list).
//
// Cost: a scan of the units 5 times a second (state changes only); a voice
// is a buffer source and four nodes, alive for a second or two.

import * as THREE from "three";

/** Seconds before the same line can be said again (anyone on that side). */
const COOLDOWN = {
  fr_select: 2.5, fr_move: 1.4, fr_attack: 2, fr_vehicleMove: 2, fr_contact: 9, fr_underFire: 7, fr_pinned: 9,
  fr_grenade: 2, fr_manDown: 6, fr_build: 15, fr_victory: 30,
  aln_contact: 9, aln_attack: 6, aln_underFire: 7, aln_grenade: 2, aln_manDown: 6, aln_retreat: 12, aln_move: 10,
};
const URGENT = new Set(["fr_grenade", "fr_manDown", "aln_grenade", "aln_manDown"]);
const SCAN = 0.2;
const HEAR = 150;    // m from the camera's focus past which a bark is not said at all

export function createAlgVoices({ app, audio, units, fogOfWar = null, manifestUrl = "/sounds/alg/voices/manifest.json" }) {
  const ctx = audio.ctx;
  let manifest = null;
  const buffers = new Map();
  const ready = fetch(manifestUrl).then((r) => (r.ok ? r.json() : null)).then((m) => { manifest = m; })
    .catch(() => { manifest = null; });

  const load = (f) => {
    if (buffers.has(f)) return buffers.get(f);
    const p = fetch(`/sounds/alg/voices/${f}`).then((r) => r.arrayBuffer()).then((b) => ctx.decodeAudioData(b))
      .then((buf) => { buffers.set(f, buf); return buf; }).catch(() => { buffers.set(f, null); return null; });
    buffers.set(f, p);
    return p;
  };

  // ── The radio's colour: a band-pass, a soft clip, a little hiss under it ──
  let radioIn = null;
  // The radio's own level (the pause menu's "Voix radio", ui/gameMenu.js), kept in the mixer's store.
  let level = audio.settings.voices ?? 1, outNode = null;
  function setLevel(v) { level = v; if (outNode) outNode.gain.value = 0.55 * v; audio.set("voices", v); }
  function radioChain() {
    if (radioIn) return radioIn;
    const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 420;
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 2900;
    const shaper = ctx.createWaveShaper();
    const k = 18, n = 1024, curve = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x)); }
    shaper.curve = curve;
    const out = ctx.createGain(); out.gain.value = 0.55 * level;
    outNode = out;
    hp.connect(lp).connect(shaper).connect(out).connect(audio.buses?.ui ?? ctx.destination);
    radioIn = hp;
    return radioIn;
  }

  const lastSaid = new Map();     // line → ctx time
  const busyUntil = { fr: 0, hq: 0, aln: 0 };
  const sideOf = (id) => manifest?.lines?.[id]?.side;
  const now = () => ctx.currentTime;
  const audible = () => manifest && !audio.settings.muted && ctx.state === "running";

  /** A man's voice name (stable for him). */
  function voiceOf(u, side) {
    const list = manifest?.voices?.[side] ?? [];
    if (!list.length) return null;
    const i = u ? Math.max(0, units.list.indexOf(u)) : (Math.random() * 1000) | 0;
    return list[i % list.length];
  }

  const _v = new THREE.Vector3();
  /** Where a sound is heard from: gain and pan (as the mixer's spatial()). */
  function where(x, z) {
    const view = app.rtsCamera?.getView?.();
    const f = view?.focus;
    if (!f) return { gain: 1, pan: 0, d: 0 };
    const h = (view.height ?? 60) * 0.55, d = Math.hypot(x - f.x, z - f.z, h), ref = 35;
    const p = _v.set(x, app.getWorldHeight?.(x, z) ?? 0, z).project(app.camera);
    const pan = Math.max(-0.85, Math.min(0.85, p.x * 0.75));
    return { gain: 1 / (1 + Math.max(0, d - ref) / ref), pan, d };
  }

  /** Say a line. o: { unit, x, z, radio }. Returns true when it was said. */
  function say(id, o = {}) {
    if (!audible()) return false;
    const line = manifest.lines?.[id];
    if (!line) return false;
    const side = line.side, t = now();
    if (t - (lastSaid.get(id) ?? -1e9) < (COOLDOWN[id] ?? 4)) return false;
    if (t < busyUntil[side] && !URGENT.has(id)) return false;
    const radio = side === "hq" || o.radio;
    let sp = { gain: 1, pan: 0, d: 0 };
    const x = o.unit?.position.x ?? o.x, z = o.unit?.position.z ?? o.z;
    if (!radio && x != null) {
      sp = where(x, z);
      if (sp.d > HEAR || sp.gain < 0.08) return false;
    }
    const voice = voiceOf(o.unit, side);
    const mine = line.files.filter((f) => f.voice === voice);
    const pool = mine.length ? mine : line.files;
    const file = pool[(Math.random() * pool.length) | 0];
    const buf = buffers.get(file.f);
    if (!(buf instanceof AudioBuffer)) { load(file.f); return false; }   // next time
    lastSaid.set(id, t);
    busyUntil[side] = t + buf.duration + 0.35;

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = 1 + (Math.random() - 0.5) * 0.04;
    const g = ctx.createGain();
    g.gain.value = (radio ? 1 : 0.95 * sp.gain);
    if (radio) {
      audio.play("radio", null, 0, 0, { gain: 0.7 });                    // the squelch first
      src.connect(g).connect(radioChain());
      src.start(t + 0.12);
    } else {
      const pan = ctx.createStereoPanner(); pan.pan.value = sp.pan;
      src.connect(g).connect(pan).connect(audio.buses?.sfx ?? ctx.destination);
      src.start(t);
    }
    return true;
  }

  // Preload every file once the manifest is in (they are small: ~2 MB in all).
  ready.then(() => { for (const l of Object.values(manifest?.lines ?? {})) for (const f of l.files) load(f.f); });

  // ── What makes a man speak: state changes, scanned 5 times a second ──────
  const was = new WeakMap();   // unit → { sup, pin, thr, work, tgt, alive, tgtT }
  let wait = 0, clock = 0;
  const seen = (u) => u.team === "player" || !fogOfWar?.enabled || fogOfWar.canSeeEntity(u);
  function friendNear(u, r = 30) {
    let best = null, bd = r;
    for (const o of units.list) {
      if (o === u || !o.alive || o.team !== u.team || !o.type?.foot) continue;
      const d = Math.hypot(o.position.x - u.position.x, o.position.z - u.position.z);
      if (d < bd) { bd = d; best = o; }
    }
    return best;
  }
  function step(dt) {
    if (!audible()) return;
    clock += dt;
    wait -= dt;
    if (wait > 0) return;
    wait = SCAN;
    for (const u of units.list) {
      if (u.isStructure || u.isAir) continue;
      const fr = u.team === "player", P = fr ? "fr" : "aln";
      let s = was.get(u);
      if (!s) { s = { alive: u.alive, sup: false, pin: false, thr: false, work: false, tgt: false, tgtT: -1e9 }; was.set(u, s); continue; }
      if (!u.alive) {
        if (s.alive && u.type?.foot && seen(u)) { const f = friendNear(u); if (f) say(`${P}_manDown`, { unit: f }); }
        s.alive = false;
        continue;
      }
      if (!seen(u)) continue;
      const tgt = !!(u.target?.alive || u.attackTarget?.alive);
      if (tgt && !s.tgt && clock - s.tgtT > 12) say(`${P}_contact`, { unit: u }) || (!fr && say("aln_attack", { unit: u }));
      if (tgt) s.tgtT = clock;
      if (u.pinned && !s.pin) say(`${P === "fr" ? "fr_pinned" : "aln_underFire"}`, { unit: u });
      else if (u.suppressed && !s.sup) say(`${P}_underFire`, { unit: u });
      if (u.throwing && !s.thr) say(`${P}_grenade`, { unit: u });
      if (fr && u.working && !s.work) say("fr_build", { unit: u });
      s.tgt = tgt; s.pin = !!u.pinned; s.sup = !!u.suppressed; s.thr = !!u.throwing; s.work = !!u.working;
    }
  }

  return {
    setLevel,
    ready, say, step,
    /** An order given (selection.js onOrder): the lead man acknowledges. */
    order(kind, list) {
      const u = list?.find((e) => e.alive && e.team === "player" && !e.isStructure);
      if (!u) return;
      say(kind === "attack" ? "fr_attack" : u.type?.foot ? "fr_move" : "fr_vehicleMove", { unit: u });
    },
    /** A new selection: the lead answers ("Oui, mon lieutenant ?"). */
    select(sel) {
      const u = sel?.find((e) => e.alive && e.team === "player" && !e.isStructure);
      if (u) say("fr_select", { unit: u });
    },
    /** HQ on the radio (algBattle's alerts). */
    radio(id) { if (id) say(id); },
  };
}
