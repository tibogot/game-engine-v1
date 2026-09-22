// Wave + match HUD. The wave STATUS (wave n · enemies · next wave) is a debug
// readout now and lives in the dev panel's Enemy Waves section (#dv-wave-status)
// — waves are a later mode, and the top of the screen stays clear. The
// player-facing parts stay: the "Wave n incoming" banner and the win/lose screen.
const CSS = `
#wave-hud {
  display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; margin-top: 6px;
  font: 11px/1.3 system-ui, sans-serif; font-variant-numeric: tabular-nums; color: #cfd8de;
}
#wave-hud .w { font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: #8fb8d8; }
#wave-hud .sep { width: 1px; height: 11px; background: #3a4450; }
#wave-hud .enemies { color: #ff8a7a; font-weight: 600; }
#wave-hud .enemies.none { color: #6f7c86; font-weight: 400; }
#wave-hud .next { color: #cfd8de; }
#wave-hud .next b { color: #fff; }
#wave-hud .objective { color: #ffb080; font-weight: 600; letter-spacing: .04em; }

#wave-banner {
  position: fixed; top: 22%; left: 50%; transform: translate(-50%, -10px);
  z-index: 60; pointer-events: none; opacity: 0;
  font: 700 34px/1 system-ui, sans-serif; letter-spacing: .12em; text-transform: uppercase;
  color: #ff6a5a; text-shadow: 0 2px 18px rgba(0,0,0,.7);
  transition: opacity .25s ease, transform .25s ease;
}
#wave-banner.show { opacity: 1; transform: translate(-50%, 0); }

#wave-end {
  position: fixed; inset: 0; z-index: 70; pointer-events: none;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 10px; background: rgba(8,6,6,0.55); opacity: 0;
  transition: opacity .6s ease;
  font-family: system-ui, sans-serif; color: #fff;
}
#wave-end.show { opacity: 1; }
#wave-end .title { font: 700 56px/1 system-ui; letter-spacing: .14em; color: #ff5a4a; }
#wave-end .title.win { color: #6fd4a0; }
#wave-end .sub { font-size: 15px; color: #cfd8de; }
`;

export function createWaveHud() {
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);

  const hud = document.createElement("div");
  hud.id = "wave-hud";
  hud.innerHTML = `
    <span class="objective" id="wave-objective" hidden>Destroy enemy HQ</span>
    <span class="sep" id="wave-objective-sep" hidden></span>
    <span class="w" id="wave-n">Wave —</span>
    <span class="sep"></span>
    <span class="enemies none" id="wave-enemies">no contact</span>
    <span class="sep"></span>
    <span class="next" id="wave-next">first wave in <b>—</b></span>
  `;
  // Parked until the dev panel exists (it is built after this), then moved in.
  hud.style.display = "none";
  document.body.appendChild(hud);
  let docked = false;

  const banner = document.createElement("div");
  banner.id = "wave-banner";
  document.body.appendChild(banner);

  const end = document.createElement("div");
  end.id = "wave-end";
  end.innerHTML = `<div class="title" id="end-title">Defeat</div><div class="sub" id="end-sub"></div>`;
  document.body.appendChild(end);

  const $ = (id) => document.getElementById(id);
  const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

  let lastWave = 0;
  let bannerT = 0;
  let shownOutcome = null;

  // WRITE THE DOM ONLY WHEN THE TEXT CHANGES. This ran every frame with
  // unconditional textContent / innerHTML / hidden assignments, and each one
  // invalidates style and layout even when the value is identical — Chrome's
  // trace flagged the result as forced reflow, and the profile put this
  // function at ~0.4 ms a frame before the layout it triggered. The values
  // change a few times a second at most; the writes now happen that often.
  const last = { obj: null, objText: null, waveN: null, enemies: null, enemiesNone: null, next: null };
  const setText = (key, el, text) => { if (last[key] !== text) { last[key] = text; el.textContent = text; } };

  return {
    /** Called every frame with live wave + match state. */
    update(dt, waves, match = null) {
      if (!docked) {
        const slot = document.getElementById("dv-wave-status");
        if (slot) { slot.appendChild(hud); hud.style.display = ""; docked = true; }
      }
      const matchOn = !!match?.enabled;
      const spawning = !!match?.spawning;
      if (last.obj !== matchOn) {
        last.obj = matchOn;
        $("wave-objective").hidden = !matchOn;
        $("wave-objective-sep").hidden = !matchOn;
      }
      setText("objText", $("wave-objective"), spawning ? "Deploying enemy HQ…" : "Destroy enemy HQ");

      const n = waves.wave;

      if (n !== lastWave && n > 0) {
        lastWave = n;
        banner.textContent = `Wave ${n} incoming`;
        banner.classList.add("show");
        bannerT = 2.4;
      }
      if (bannerT > 0) {
        bannerT -= dt;
        if (bannerT <= 0) banner.classList.remove("show");
      }

      setText("waveN", $("wave-n"), n > 0 ? `Wave ${n}` : "Wave —");

      const alive = waves.enemiesAlive;
      const e = $("wave-enemies");
      setText("enemies", e, alive > 0 ? `${alive} enemy${alive === 1 ? "" : " units"}` : "no contact");
      if (last.enemiesNone !== (alive === 0)) { last.enemiesNone = alive === 0; e.classList.toggle("none", alive === 0); }

      const next = !waves.enabled
        ? `<b>waves off</b>`
        : n > 0
          ? `next in <b>${mmss(waves.nextWaveIn)}</b>`
          : `first wave in <b>${mmss(waves.nextWaveIn)}</b>`;
      if (last.next !== next) { last.next = next; $("wave-next").innerHTML = next; }

      const outcome = match?.outcome ?? (waves.enabled ? waves.outcome : null);
      if (!outcome || outcome === shownOutcome) return;
      shownOutcome = outcome;

      const title = $("end-title");
      const sub = $("end-sub");
      if (outcome === "victory") {
        title.textContent = "Victory";
        title.classList.add("win");
        sub.textContent = "Enemy command base destroyed.";
      } else {
        title.textContent = "Defeat";
        title.classList.remove("win");
        sub.textContent = matchOn
          ? "Your command base was destroyed."
          : n > 1
            ? `The base fell on wave ${n}. You held ${n - 1}.`
            : "The base fell on the first wave.";
      }
      end.classList.add("show");
    },
  };
}
