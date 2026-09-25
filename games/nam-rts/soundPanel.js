// Dev → SOUND — DEVELOPER UI. The mix, and every slot's candidate
// recordings, swappable LIVE in the game: choosing a sound is an ears job, and
// a gunshot heard alone in a menu is not the gunshot heard across a valley
// with a jungle under it. So each slot offers:
//   ▶      the candidate dry, at full level (what the file is)
//   ◎      the chosen one AT THE CAMERA FOCUS, through the real mix
//   select which candidate(s) the game plays — kept across reloads
// "Firefight here" plays a scripted minute of battle round the focus, so the
// picks can be judged together. "Copy picks" puts the choices on the
// clipboard (for baking into public/sounds/nam/manifest.json).

const LABELS = {
  rifle: "M16 (yours)", ak: "AK-47 (the Front)", mg: "Machine gun", minigun: "Gunship minigun",
  cannon: "Tank gun", rocket: "Rocket", explosion: "Explosion", explFar: "Explosion, far",
  napalm: "Napalm", fireLoop: "Fire (loop)", huey: "Huey rotor (loop)", jeep: "Jeep / truck (loop)",
  tank: "Tank (loop)", jungle: "Jungle (loop)", birdFlush: "Birds flushed", smoke: "Smoke grenade",
  uiClick: "UI click", radio: "Radio (orders)", impact: "Bullet impact", incoming: "Mortar whistle",
  build: "Building (hammering)",
};

export function buildSoundPanel(el, sounds) {
  const { audio } = sounds;
  el.innerHTML = `<div class="dv-hint">Loading sounds…</div>`;
  audio.ready.then(() => render());

  function slider(label, key, max = 1.5) {
    const row = document.createElement("div");
    row.className = "prop-row";
    row.innerHTML = `<span class="prop-label">${label}</span><div class="prop-value">
      <input type="range" min="0" max="${max * 100}" step="5" value="${Math.round((audio.settings[key] ?? 1) * 100)}" />
      <span class="prop-num">${Math.round((audio.settings[key] ?? 1) * 100)}</span></div>`;
    const inp = row.querySelector("input"), num = row.querySelector(".prop-num");
    inp.addEventListener("input", () => { audio.set(key, inp.value / 100); num.textContent = inp.value; });
    return row;
  }

  function render() {
    el.innerHTML = "";
    const mute = document.createElement("button");
    mute.className = "action-btn";
    mute.type = "button";
    const paint = () => { mute.textContent = audio.settings.muted ? "Sound: OFF" : "Sound: on"; };
    paint();
    mute.addEventListener("click", () => { audio.set("muted", !audio.settings.muted); paint(); });
    el.append(mute);
    el.append(slider("Master", "master", 1), slider("Effects", "sfx"), slider("Ambience", "ambience"), slider("UI", "ui"));

    const fight = document.createElement("button");
    fight.className = "action-btn primary";
    fight.type = "button";
    fight.textContent = "Firefight here (20 s)";
    fight.addEventListener("click", () => firefight());
    const copy = document.createElement("button");
    copy.className = "action-btn";
    copy.type = "button";
    copy.textContent = "Copy picks";
    copy.addEventListener("click", () => {
      const picks = Object.fromEntries(Object.entries(audio.slots).map(([k, S]) => [k, S.use ?? [0]]));
      navigator.clipboard?.writeText(JSON.stringify(picks));
      copy.textContent = "Copied";
      setTimeout(() => { copy.textContent = "Copy picks"; }, 1200);
    });
    el.append(fight, copy);

    const hint = document.createElement("div");
    hint.className = "dv-hint";
    hint.innerHTML = `▶ the recording alone · ◎ at the camera focus, through the mix.
      All CC0 (freesound.org). <b>!</b> = the file clips (distorts) — heard, not guessed.
      Sound is OFF by default: switch it on above to audition. <span id="dv-snd-voices"></span>`;
    el.append(hint);
    const voices = hint.querySelector("#dv-snd-voices");
    setInterval(() => { voices.textContent = `· ${audio.voices} voices`; }, 500);

    for (const [name, S] of Object.entries(audio.slots)) {
      const row = document.createElement("div");
      row.className = "prop-row";
      const opts = S.files.map((f, i) =>
        `<option value="${i}" ${(S.use ?? [0]).includes(i) ? "selected" : ""}>${i + 1}. ${esc(f.t).slice(0, 34)} — ${esc(f.by)}${f.clip > 100 ? " !" : ""}</option>`).join("");
      row.innerHTML = `<span class="prop-label" title="${name}">${LABELS[name] ?? name}</span>
        <div class="prop-value" style="gap:4px">
          <select class="prop-select" style="flex:1;min-width:0">${opts}</select>
          <button class="action-btn" type="button" title="The recording alone" style="width:auto;padding:2px 7px">▶</button>
          <button class="action-btn" type="button" title="At the camera focus, through the mix" style="width:auto;padding:2px 7px">◎</button>
        </div>`;
      const sel = row.querySelector("select");
      const [dry, wet] = row.querySelectorAll("button");
      sel.addEventListener("change", () => audio.choose(name, [Number(sel.value)]));
      dry.addEventListener("click", () => audio.audition(name, Number(sel.value)));
      wet.addEventListener("click", () => {
        const f = focus();
        if (!audio.settings.muted) audio.ctx.resume();
        audio.play(name, S.bus === "sfx" ? f.x + 6 : null, f.y, f.z);
      });
      el.append(row);
    }
  }

  const focus = () => {
    const v = sounds.getView?.() ?? null;
    const f = v?.focus ?? { x: 0, y: 0, z: 0 };
    return { x: f.x, y: f.y ?? 0, z: f.z };
  };

  /** Twenty seconds of a fight round the focus: sound only, nothing spawned. */
  function firefight() {
    if (!audio.settings.muted) audio.ctx.resume();
    const f = focus();
    const at = (dx, dz) => [f.x + dx, f.y, f.z + dz];
    const ev = [];
    for (let t = 0; t < 20; t += 0.12 + Math.random() * 0.35) ev.push([t, "rifle", at(-40 + Math.random() * 30, -20 + Math.random() * 40)]);
    for (let t = 0.6; t < 20; t += 0.1 + Math.random() * 0.45) ev.push([t, "ak", at(35 + Math.random() * 40, -30 + Math.random() * 60)]);
    for (let t = 2; t < 20; t += 2.5 + Math.random() * 2) ev.push([t, "mg", at(-55, 10)]);
    for (let t = 4; t < 20; t += 5 + Math.random() * 3) ev.push([t, "cannon", at(-70, -30)]);
    for (let t = 6; t < 20; t += 4 + Math.random() * 4) {
      const p = at(40 + Math.random() * 30, -20 + Math.random() * 40);
      ev.push([t - 1.6, "incoming", p], [t, "explosion", p]);
    }
    ev.push([9, "explosion", at(420, 300)], [14, "explosion", at(-500, 200)]);   // far: the other recording
    ev.push([11, "napalm", at(60, 40)], [3, "birdFlush", at(20, -40)]);
    const t0 = performance.now();
    ev.sort((a, b) => a[0] - b[0]);
    let i = 0;
    const tick = () => {
      const t = (performance.now() - t0) / 1000;
      while (i < ev.length && ev[i][0] <= t) { const [, s, p] = ev[i++]; audio.play(s, p[0], p[1], p[2]); }
      if (i < ev.length) requestAnimationFrame(tick);
    };
    tick();
  }
}

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
