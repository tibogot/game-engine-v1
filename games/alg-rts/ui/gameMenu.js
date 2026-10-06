// THE GAME MENU (2026-10-06, you: "in the gamer's pause menu he should reach some of it — at
// least sound on/off"). What a player gets; the dev panel is for us (hidden at release, ?dev=1).
//   Esc / F10   PAUSE — the sim, the clocks, the animals and flags stop (algGame.js gives the
//               game's frame hooks no time while app.paused); the camera still moves; the
//               sound is held. Esc again (or REPRENDRE) resumes.
//   OPTIONS     sound (on/off, master, effects, radio voices, ambience), the game (gore,
//               advice tips), the camera (pan speed, edge scrolling) — kept between games
//               (localStorage "algrts.options.v1"; the volumes live in the mixer's own store).
//   COMMANDES   the keys.
//   RECOMMENCER a new battle (the briefing again).
// Esc does not pause while another mode owns it (a grenade or a building being placed: their
// own Esc cancels them).
import { HOTKEY } from "./icons.js";
import { GIBS } from "../algCombat.js";

const STORE = "algrts.options.v1";
const DEFAULTS = { gore: "coh", tips: true, panSpeed: 55, edgeScroll: true };

/** The saved options (defaults where none). */
export function loadOptions() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORE) || "{}") }; } catch { return { ...DEFAULTS }; }
}

const CSS = `
.alg-menu .opts { display: grid; gap: 14px; margin-bottom: 16px; }
.alg-menu fieldset { border: 1px solid var(--hud-edge); border-radius: var(--hud-radius); padding: 8px 12px 10px; margin: 0; display: grid; gap: 7px; }
.alg-menu legend { padding: 0 6px; font-size: 10px; letter-spacing: 0.2em; text-transform: uppercase; color: var(--hud-brass); }
.alg-menu label.r { display: grid; grid-template-columns: 150px 1fr 44px; align-items: center; gap: 10px; font-size: 12px; }
.alg-menu label.r output { font: 11px var(--hud-mono); color: var(--hud-dim); text-align: right; font-variant-numeric: tabular-nums; }
.alg-menu input[type=range] { width: 100%; accent-color: #c9a54a; }
.alg-menu select { font: 12px var(--hud-sans); background: #252920; color: var(--hud-text); border: 1px solid #454c3a; border-radius: var(--hud-radius); padding: 3px 6px; }
.alg-menu input[type=checkbox] { accent-color: #c9a54a; width: 15px; height: 15px; justify-self: start; }
.alg-menu .main { display: grid; gap: 8px; margin: 6px 0 4px; }
.alg-menu .main button { width: 100%; text-align: left; padding: 11px 16px; }
.alg-menu .keyt { width: 100%; border-collapse: collapse; font-size: 12px; margin-bottom: 14px; }
.alg-menu .keyt td { padding: 4px 0; border-bottom: 1px solid var(--hud-edge); }
.alg-menu .keyt td:first-child { width: 150px; }
.alg-menu .keyt kbd { font: 11px var(--hud-mono); padding: 0 5px; border: 1px solid var(--hud-edge-hi); border-radius: 2px; margin-right: 3px; color: var(--hud-text); }
#alg-paused { position: fixed; top: 64px; left: calc((100vw - var(--alg-dev-w, 340px)) / 2); transform: translateX(-50%); z-index: 89;
  font: 700 13px var(--hud-sans); letter-spacing: 0.4em; color: #f1dfa6; text-shadow: 0 1px 3px #000; pointer-events: none; }
`;

const ABILITY_NAMES = { patrol: "Patrouille", grenade: "Grenade", smoke: "Fumigène", stop: "Halte", focus: "Caméra sur la sélection", cutWire: "Couper les barbelés", cancelSite: "Annuler un chantier", retreat: "Retraite", reinforce: "Renforcer", lmg: "FM 24/29", barrage: "Tir de barrage", airStrike: "Frappe aérienne", repair: "Réparer" };

/**
 * @param {object} o
 * @param {object} o.app
 * @param {object} [o.audio]   the shared mixer (algSounds.audio)
 * @param {object} [o.voices]  algVoices (its radio level)
 * @param {object} [o.rtsCamera]
 */
export function createGameMenu({ app, audio = null, voices = null, rtsCamera = null }) {
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
  const opts = loadOptions();
  const save = () => { try { localStorage.setItem(STORE, JSON.stringify(opts)); } catch { /* private window */ } };

  // The saved options, applied now.
  function apply() {
    GIBS.mode = opts.gore;
    app.algOptions = opts;
    if (rtsCamera?.params) { rtsCamera.params.panSpeed = opts.panSpeed; rtsCamera.params.edgeScroll = opts.edgeScroll; }
  }
  apply();

  let back = null, paused = false, savedScale = 1, heldAudio = false;
  const badge = document.createElement("div");
  badge.id = "alg-paused";
  badge.textContent = "PAUSE";
  badge.hidden = true;
  document.body.appendChild(badge);

  function pause() {
    if (paused) return;
    paused = true;
    app.paused = true;
    savedScale = app.timeScale ?? 1;
    app.timeScale = 0;
    // Hold the sound (the engines' loops, the bed); not when it was off anyway.
    if (audio && !audio.settings.muted && audio.ctx.state === "running") { audio.ctx.suspend(); heldAudio = true; }
    badge.hidden = false;
  }
  function resume() {
    if (!paused) return;
    close();
    paused = false;
    app.paused = false;
    app.timeScale = savedScale || 1;
    if (heldAudio && audio && !audio.settings.muted) audio.ctx.resume();
    heldAudio = false;
    badge.hidden = true;
  }
  function close() { back?.remove(); back = null; }
  function show(html, wire) {
    close();
    back = document.createElement("div");
    back.className = "alg-modal-back";
    back.innerHTML = `<div class="alg-modal alg-menu">${html}</div>`;
    back.addEventListener("pointerdown", (e) => e.stopPropagation());
    back.addEventListener("click", (e) => { if (e.target === back) resume(); });
    document.body.appendChild(back);
    wire?.(back.querySelector(".alg-menu"));
  }

  function mainPage() {
    show(`<div class="kicker">Sand &amp; Blood</div><h2>Pause</h2>
      <div class="main">
        <button class="go" data-a="resume">Reprendre</button>
        <button data-a="options">Options</button>
        <button data-a="keys">Commandes</button>
        <button data-a="restart">Recommencer la bataille</button>
      </div>`, (el) => {
      el.querySelector('[data-a="resume"]').onclick = resume;
      el.querySelector('[data-a="options"]').onclick = optionsPage;
      el.querySelector('[data-a="keys"]').onclick = keysPage;
      el.querySelector('[data-a="restart"]').onclick = () => location.reload();
    });
  }

  const pct = (v) => `${Math.round(v * 100)}%`;
  function optionsPage() {
    const s = audio?.settings ?? {};
    const slider = (key, label, v, min, max, step, fmt) =>
      `<label class="r">${label}<input type="range" data-k="${key}" min="${min}" max="${max}" step="${step}" value="${v}"><output>${fmt(v)}</output></label>`;
    show(`<div class="kicker">Pause</div><h2>Options</h2>
      <div class="opts">
        <fieldset><legend>Son</legend>
          <label class="r">Son<input type="checkbox" data-k="sound" ${s.muted ? "" : "checked"}><output></output></label>
          ${slider("master", "Volume général", s.master ?? 0.8, 0, 1, 0.05, pct)}
          ${slider("sfx", "Combats et véhicules", s.sfx ?? 1, 0, 1, 0.05, pct)}
          ${slider("voices", "Voix radio", s.voices ?? 1, 0, 1, 0.05, pct)}
          ${slider("ambience", "Ambiance", s.ambience ?? 0.7, 0, 1, 0.05, pct)}
        </fieldset>
        <fieldset><legend>Jeu</legend>
          <label class="r">Corps déchiquetés<select data-k="gore"><option value="coh"${opts.gore === "coh" ? " selected" : ""}>Explosions proches</option><option value="off"${opts.gore === "off" ? " selected" : ""}>Non</option></select><output></output></label>
          <label class="r">Conseils<input type="checkbox" data-k="tips" ${opts.tips ? "checked" : ""}><output></output></label>
        </fieldset>
        <fieldset><legend>Caméra</legend>
          ${slider("panSpeed", "Vitesse de défilement", opts.panSpeed, 25, 110, 5, (v) => `${v}`)}
          <label class="r">Défilement au bord<input type="checkbox" data-k="edgeScroll" ${opts.edgeScroll ? "checked" : ""}><output></output></label>
        </fieldset>
      </div>
      <div class="row"><button data-a="back">Retour</button><button class="go" data-a="resume">Reprendre</button></div>`, (el) => {
      el.querySelector('[data-a="back"]').onclick = mainPage;
      el.querySelector('[data-a="resume"]').onclick = resume;
      el.addEventListener("input", (e) => {
        const t = e.target, k = t.dataset.k;
        if (!k) return;
        const out = t.closest("label")?.querySelector("output");
        if (t.type === "range") {
          const v = Number(t.value);
          if (k === "panSpeed") { opts.panSpeed = v; save(); apply(); out.textContent = `${v}`; return; }
          out.textContent = pct(v);
          if (k === "voices") voices?.setLevel?.(v);
          else audio?.set(k, v);
          // (paused: the mixer's set() resumes the context — hold it again)
          if (paused && audio && !audio.settings.muted) { audio.ctx.suspend(); heldAudio = true; }
        } else if (k === "sound") {
          audio?.set("muted", !t.checked);
          if (paused && audio && !audio.settings.muted) { audio.ctx.suspend(); heldAudio = true; }
        } else if (k === "gore") { opts.gore = t.value; save(); apply(); }
        else if (k === "tips" || k === "edgeScroll") { opts[k] = t.checked; save(); apply(); }
      });
    });
  }

  function keysPage() {
    const row = (what, ...keys) => `<tr><td>${what}</td><td>${keys.map((k) => `<kbd>${k}</kbd>`).join(" ")}</td></tr>`;
    const abil = Object.entries(HOTKEY).map(([k, key]) => row(ABILITY_NAMES[k] ?? k, key)).join("");
    show(`<div class="kicker">Pause</div><h2>Commandes</h2>
      <table class="keyt">
        ${row("Déplacer la caméra", "Z Q S D", "↑ ← ↓ →")}
        ${row("Tourner la caméra", "A", "E")}
        ${row("Zoom", "molette")}
        ${row("Sélectionner", "clic gauche", "glisser")}
        ${row("Ajouter à la sélection", "Maj + clic")}
        ${row("Tous du même type", "double-clic")}
        ${row("Déplacer / attaquer", "clic droit")}
        ${row("Groupes", "Ctrl + 1…9", "1…9")}
        ${row("Voir la couverture", "V (maintenu)")}
        ${row("Dernière alerte", "Espace")}
        ${row("Tourner un bâtiment", "R")}
        ${row("Pause / menu", "Échap", "F10")}
        ${abil}
      </table>
      <div class="keys">Les touches suivent leur place sur le clavier : sur un clavier QWERTY, la caméra se déplace avec W A S D et tourne avec Q / E.</div>
      <div class="row"><button data-a="back">Retour</button><button class="go" data-a="resume">Reprendre</button></div>`, (el) => {
      el.querySelector('[data-a="back"]').onclick = mainPage;
      el.querySelector('[data-a="resume"]').onclick = resume;
    });
  }

  function open() { pause(); mainPage(); }
  // Esc: not while another mode owns it (a targeting crosshair, a building being placed) or a
  // modal of the battle's own is up (the briefing, the end).
  const busy = () => !!app.renderer.domElement.style.cursor || app.algBuild?.placing || (!!document.querySelector(".alg-modal-back") && !back);
  function onKey(e) {
    if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName ?? "") && e.key !== "Escape") return;
    if (e.key === "F10") { e.preventDefault(); if (paused) resume(); else open(); return; }
    if (e.key !== "Escape" || e.repeat) return;
    if (paused) { e.preventDefault(); resume(); return; }
    if (busy()) return;
    e.preventDefault();
    open();
  }
  // Capture: before the targeting modes' own Esc (they run after and see their crosshair gone).
  window.addEventListener("keydown", onKey, true);

  return {
    open, pause, resume, options: opts,
    get paused() { return paused; },
    dispose() { resume(); window.removeEventListener("keydown", onKey, true); badge.remove(); style.remove(); },
  };
}
