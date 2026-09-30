// WHAT THE AURÈS SOUNDS LIKE — GAME code, alg-rts only. The mixer is the
// shared one (games/shared-rts/rtsAudio.js: buses, distance from the camera
// focus, stereo from the screen, loops, voice caps); this file decides which
// event makes which sound. Recordings: public/sounds/alg/manifest.json, all
// CC0 from freesound.org, fetched by tools/algFetchSounds.mjs; Dev → Sound
// swaps candidates live.
//
//   shots      the French rifle (MAS-36/49) and the ALN's mixed old rifles
//              are told apart by ear; the MG, the tank gun are their own.
//   impacts    rounds landing near the camera: quiet dirt.
//   blasts     grenades, mortars, shells — far away another recording.
//   deaths     a man hit and going down: sometimes a cry.
//   loops      the jeep, the trucks and the half-track, the Alouette, fire.
//   the land   a WIND bed always, CICADAS by day; dogs bark in a village
//              when soldiers come near it; the flocks bleat; a donkey brays;
//              the call to prayer from the ksar's minaret now and then.
//   ui         clicks; a radio squelch when you give an order.
//
// Sound is ON by default here (nam's is off: its own call).
import { createRtsAudio } from "../shared-rts/rtsAudio.js";
import { LAYOUT } from "./layout.js";

const LABELS = {
  rifle: "Rifle (French)", boltRifle: "Rifle (ALN)", mg: "Machine gun", cannon: "Tank gun",
  impact: "Bullet impact", explosion: "Explosion", explFar: "Explosion, far", incoming: "Mortar whistle",
  cry: "A man hit", jeep: "Jeep (loop)", truck: "Truck / half-track (loop)", heli: "Alouette (loop)",
  fireLoop: "Fire (loop)", build: "Sappers digging", wind: "Wind (bed)", cicadas: "Cicadas (bed)",
  adhan: "Call to prayer", dog: "Dog", goat: "Goats / sheep", donkey: "Donkey", uiClick: "UI click", radio: "Radio (orders)",
};
const VEHICLE_LOOP = { willys: "jeep", gmc: "truck", halftrack: "truck", ebr: "truck", amx13: "truck" };

export function createAlgSounds({ app, rtsCamera, units }) {
  const audio = createRtsAudio({ app, getView: () => rtsCamera.getView?.(), manifestUrl: "/sounds/alg/manifest.json", storeKey: "algrts.audio.v1", startMuted: false });
  // The first click or key anywhere wakes the audio (browsers start it suspended).
  const wake = () => { if (!audio.settings.muted) audio.ctx.resume(); };
  window.addEventListener("pointerdown", wake, { once: true, capture: true });
  window.addEventListener("keydown", wake, { once: true, capture: true });

  const sfx = {
    shot(owner, w, at) {
      const k = owner?.weapon ?? "rifle";
      const slot = k === "rifle" ? (owner?.team === "enemy" ? "boltRifle" : "rifle") : k === "mg" ? "mg" : k === "cannon" ? "cannon" : "rifle";
      audio.play(slot, at.x, at.y, at.z);
    },
    rocket(at) { audio.play("cannon", at.x, at.y, at.z, { gain: 0.6, rate: 1.2 }); },
    impact(at) { audio.play("impact", at.x, at.y, at.z); },
    incoming(at, left) {
      const S = audio.slots.incoming, f = S?.files[S.use?.[0] ?? 0];
      const len = f ? (f.end ?? f.dur) - (f.start ?? 0) : 1.6;
      audio.play("incoming", at.x, at.y + 20, at.z, { delay: Math.max(0, left - len) });
    },
  };
  function blast(x, y, z, size = 10) {
    audio.play("explosion", x, y, z, { gain: Math.min(1.3, Math.max(0.5, size / 12)), rate: size > 18 ? 0.85 : 1 });
  }
  function death(e) {
    if (Math.random() < 0.55) audio.play("cry", e.position.x, e.position.y + 1, e.position.z, { rate: 0.9 + Math.random() * 0.25 });
  }

  // ── Loops: engines, rotors, fire ──────────────────────────────────────────
  audio.addLoopProvider(() => {
    const out = [];
    for (const u of units?.list ?? []) {
      if (!u.alive) continue;
      if (u.isAir) out.push({ slot: "heli", key: u, x: u.position.x, y: u.position.y, z: u.position.z, level: u.isMoving ? 1 : 0.3 });
      else if (VEHICLE_LOOP[u.typeKey] && u.isMoving) out.push({ slot: VEHICLE_LOOP[u.typeKey], key: u, x: u.position.x, y: u.position.y, z: u.position.z, level: 1 });
    }
    return out;
  });
  audio.addLoopProvider(() => {
    const fire = app.algCombat?.fire;
    if (!fire?.fires) return [];
    const now = fire.now ?? 0, out = [];
    for (const f of fire.fires) { const left = f.end - now; if (left > 0) out.push({ slot: "fireLoop", key: f, x: f.x, y: f.y, z: f.z, level: Math.min(1.2, 0.35 + f.radius * 0.18) * Math.min(1, left / 2) }); }
    return out;
  });
  audio.addLoopProvider(() => (app.algBuild?.sites ?? []).filter((s) => !s.done && (s.team !== "enemy" || !app.fogOfWar?.enabled || app.fogOfWar.isVisible(s.x, s.z))).map((s) => ({ slot: "build", key: s, x: s.x, y: app.getWorldHeight(s.x, s.z), z: s.z, level: 1 })));
  // The bed: wind always, cicadas by day, a little quieter from high up.
  audio.addLoopProvider(() => {
    const zoomT = rtsCamera.getView?.()?.zoomT ?? 0.5;
    const sunY = app.environment?.getLightDirection?.()?.y ?? 0.6;
    const day = Math.max(0, Math.min(1, (sunY - 0.05) / 0.25));
    return [
      { slot: "wind", key: "wind", level: 0.7 + zoomT * 0.5 },
      { slot: "cicadas", key: "cicadas", level: day * (1 - zoomT * 0.5) },
    ];
  });

  // ── The land: villages, flocks, the ksar ──────────────────────────────────
  const villages = LAYOUT.sites.filter((s) => ["hamlet", "dechra", "ksar"].includes(s.kind));
  const ksar = LAYOUT.sites.find((s) => s.kind === "ksar");
  let dogT = 3, bleatT = 5, brayT = 12, adhanT = 25;
  const rnd = (a, b) => a + Math.random() * (b - a);
  function life(dt) {
    // Dogs: a village with soldiers within 70 m (either side) barks.
    if ((dogT -= dt) <= 0) {
      dogT = rnd(2.5, 6);
      for (const v of villages) {
        const near = (units?.list ?? []).some((u) => u.alive && !u.isAir && Math.hypot(u.position.x - v.x, u.position.z - v.z) < v.r + 70);
        if (near && Math.random() < 0.6) { audio.play("dog", v.x + rnd(-15, 15), app.getWorldHeight(v.x, v.z), v.z + rnd(-15, 15)); break; }
      }
    }
    // The flocks bleat now and then (algHerds.js: their homes move).
    if ((bleatT -= dt) <= 0) {
      bleatT = rnd(3, 8);
      const f = app.algHerds?.flocks?.[Math.floor(Math.random() * (app.algHerds?.flocks?.length ?? 0))];
      if (f) audio.play("goat", f.anchor.x + rnd(-6, 6), app.getWorldHeight(f.anchor.x, f.anchor.z), f.anchor.z + rnd(-6, 6));
    }
    if ((brayT -= dt) <= 0) {
      brayT = rnd(25, 60);
      const d = app.algHerds?.herds?.find((h) => /Donkeys/.test(h?.herd?.name ?? h?.mesh?.name ?? ""))?.raw?.[0];
      const src = d ?? villages[Math.floor(Math.random() * villages.length)];
      if (src) audio.play("donkey", src.x, app.getWorldHeight(src.x, src.z), src.z);
    }
    // The call to prayer from the minaret: soon after the start, then every
    // few minutes (a game day is short).
    if (ksar && (adhanT -= dt) <= 0) {
      adhanT = rnd(240, 360);
      audio.play("adhan", ksar.x, app.getWorldHeight(ksar.x, ksar.z) + 25, ksar.z);
    }
  }

  // ── UI ─────────────────────────────────────────────────────────────────────
  const onDown = (e) => {
    const b = e.target.closest?.("button, [role=button]");
    if (!b || b.closest("#rts-dev")) return;
    audio.play("uiClick");
  };
  window.addEventListener("pointerdown", onDown, true);
  let lastOrder = -1;
  function order(kind, list) {
    const now = audio.ctx.currentTime;
    if (now - lastOrder < 0.35 || !list?.some?.((u) => !u.isStructure)) return;
    lastOrder = now;
    audio.play("radio", null, 0, 0, { rate: kind === "attack" ? 1.05 : 1 });
  }

  /**
   * Measure every file (loudness → `gain` to about -18 dB active RMS; the
   * silence at each end of a one-shot → `start`/`end`) and return the slots,
   * to bake into public/sounds/alg/manifest.json.
   */
  async function measure() {
    const out = {};
    for (const [name, S] of Object.entries(audio.slots)) {
      out[name] = [];
      for (const f of S.files) {
        const buf = await audio.ctx.decodeAudioData(await (await fetch(`/sounds/alg/${f.f}`)).arrayBuffer());
        const d = buf.getChannelData(0), sr = buf.sampleRate, win = Math.floor(sr * 0.02);
        let s0 = -1, s1 = 0, act = 0, sum = 0;
        const peak = d.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
        for (let i = 0; i + win <= d.length; i += win) {
          let e = 0;
          for (let k = i; k < i + win; k++) e += d[k] * d[k];
          const rms = Math.sqrt(e / win);
          if (rms > peak * 0.03) { if (s0 < 0) s0 = i; s1 = i + win; }
          if (rms > peak * 0.1) { sum += e; act += win; }
        }
        const rms = Math.sqrt(sum / Math.max(1, act));
        const gain = +Math.min(4, 0.126 / Math.max(1e-4, rms)).toFixed(3);   // -18 dBFS
        out[name].push({ f: f.f, gain, dur: +buf.duration.toFixed(2), ...(S.loop ? {} : { start: +Math.max(0, s0 / sr - 0.01).toFixed(2), end: +Math.min(buf.duration, s1 / sr + 0.05).toFixed(2) }) });
      }
    }
    return out;
  }

  app.addPreRenderHook((dt) => { life(Math.min(dt, 0.1)); audio.update(); });
  return {
    audio, sfx, blast, death, order, measure, labels: LABELS,
    getView: () => rtsCamera.getView?.(),
    dispose() { window.removeEventListener("pointerdown", onDown, true); audio.ctx.close(); },
  };
}

/** Dev → Sound: the mix, and each slot's candidates, swappable live. */
export function buildAlgSoundPanel(el, sounds) {
  const { audio } = sounds;
  el.innerHTML = `<div class="dp-hint">Loading sounds…</div>`;
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  audio.ready.then(() => {
    el.innerHTML = "";
    const row = (label, html) => { const r = document.createElement("div"); r.className = "prop-row"; r.innerHTML = `<span class="prop-label">${label}</span><div class="prop-value" style="gap:4px">${html}</div>`; el.append(r); return r; };
    const mute = row("Sound", `<button class="action-btn" type="button" style="width:auto;padding:2px 10px">${audio.settings.muted ? "Off" : "On"}</button>`).querySelector("button");
    mute.addEventListener("click", () => { audio.set("muted", !audio.settings.muted); mute.textContent = audio.settings.muted ? "Off" : "On"; });
    for (const [k, label] of [["master", "Master"], ["sfx", "Battle"], ["ambience", "Land (bed)"], ["ui", "UI"]]) {
      const inp = row(label, `<input type="range" min="0" max="150" step="5" value="${Math.round((audio.settings[k] ?? 1) * 100)}" aria-label="${label}" />`).querySelector("input");
      inp.addEventListener("input", () => audio.set(k, Number(inp.value) / 100));
    }
    for (const [name, S] of Object.entries(audio.slots)) {
      const label = sounds.labels[name] ?? name;
      const opts = S.files.map((f, i) => `<option value="${i}" ${(S.use ?? [0]).includes(i) ? "selected" : ""}>${i + 1}. ${esc(f.t).slice(0, 30)} — ${esc(f.by)}</option>`).join("");
      const r = row(label, `<select class="prop-select" aria-label="${esc(label)}" style="flex:1;min-width:0">${opts}</select><button class="action-btn" type="button" title="The recording alone" style="width:auto;padding:2px 7px">▶</button>`);
      const sel = r.querySelector("select"), dry = r.querySelector("button");
      sel.addEventListener("change", () => audio.choose(name, [Number(sel.value)]));
      dry.addEventListener("click", () => audio.audition(name, Number(sel.value)));
    }
    const hint = document.createElement("div");
    hint.className = "dp-hint";
    hint.innerHTML = "All CC0 (freesound.org). ▶ plays a candidate alone; the choice is kept across reloads — tell me the picks to bake in.";
    el.append(hint);
  });
}
