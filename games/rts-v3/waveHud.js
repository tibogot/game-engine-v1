// Wave HUD — player-facing. Top-centre: which wave, how long until the next one,
// how many enemies are still alive. Plus the two moments that matter: a wave
// landing, and the base falling.
const CSS = `
#wave-hud {
  position: fixed; top: 10px; left: 50%; transform: translateX(-50%);
  z-index: 50; pointer-events: none;
  display: flex; align-items: center; gap: 14px;
  padding: 7px 16px; border-radius: 999px;
  background: rgba(12,16,20,0.82); border: 1px solid #2a343c;
  color: #dfe6ea; font: 13px/1 system-ui, sans-serif;
  font-variant-numeric: tabular-nums;
}
#wave-hud .w { font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: #8fb8d8; }
#wave-hud .sep { width: 1px; height: 16px; background: #2f3b45; }
#wave-hud .enemies { color: #ff8a7a; font-weight: 600; }
#wave-hud .enemies.none { color: #6f7c86; font-weight: 400; }
#wave-hud .next { color: #cfd8de; }
#wave-hud .next b { color: #fff; }

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
#wave-end .sub { font-size: 15px; color: #cfd8de; }
`;

export function createWaveHud() {
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);

  const hud = document.createElement("div");
  hud.id = "wave-hud";
  hud.innerHTML = `
    <span class="w" id="wave-n">Wave —</span>
    <span class="sep"></span>
    <span class="enemies none" id="wave-enemies">no contact</span>
    <span class="sep"></span>
    <span class="next" id="wave-next">first wave in <b>—</b></span>
  `;
  document.body.appendChild(hud);

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

  return {
    /** Called every frame with the live wave state. */
    update(dt, waves) {
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

      $("wave-n").textContent = n > 0 ? `Wave ${n}` : "Wave —";

      const alive = waves.enemiesAlive;
      const e = $("wave-enemies");
      e.textContent = alive > 0 ? `${alive} enemy${alive === 1 ? "" : " units"}` : "no contact";
      e.classList.toggle("none", alive === 0);

      $("wave-next").innerHTML = !waves.enabled
        ? `<b>waves off</b>`
        : n > 0
          ? `next in <b>${mmss(waves.nextWaveIn)}</b>`
          : `first wave in <b>${mmss(waves.nextWaveIn)}</b>`;

      if (waves.outcome === "defeat" && !end.classList.contains("show")) {
        $("end-title").textContent = "Defeat";
        $("end-sub").textContent = n > 1
          ? `The base fell on wave ${n}. You held ${n - 1}.`
          : `The base fell on the first wave.`;
        end.classList.add("show");
      }
    },
  };
}
