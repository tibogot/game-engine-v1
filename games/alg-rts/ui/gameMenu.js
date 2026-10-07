// THE GAME MENU (2026-10-06, you: "in the gamer's pause menu he should reach some of it — at
// least sound on/off"). What a player gets; the dev panel is for us (hidden at release, ?dev=1).
//   Esc / F10   PAUSE — the sim, the clocks, the animals and flags stop (algGame.js gives the
//               game's frame hooks no time while app.paused); the camera still moves; the
//               sound is held. Esc again (or REPRENDRE) resumes.
//   OPTIONS     sound (on/off, master, effects, radio voices, ambience), the game (gore,
//               advice tips), the camera (pan speed, edge scrolling) — kept between games
//               (localStorage "algrts.options.v1"; the volumes live in the mixer's own store).
//   COMMANDES   the keys.
//   MANUEL      how the game works (you, 2026-10-07: "make a manual"): the goal, the resources,
//               the units, the post and the buildings, the special orders — in French, short.
//   RECOMMENCER a new battle (the briefing again).
// Esc does not pause while another mode owns it (a grenade or a building being placed: their
// own Esc cancels them).
import { HOTKEY } from "./icons.js";
import { GIBS } from "../algCombat.js";
import { createUiScale } from "./uiScale.js";
import { t, LANG, LANGS, setLang } from "../i18n/i18n.js";

const STORE = "algrts.options.v1";
// uiScale: the HUD's size (ui/uiScale.js). 1.15 by default (you: "the text is a bit small").
const DEFAULTS = { gore: "coh", tips: true, panSpeed: 55, edgeScroll: true, uiScale: 1.15 };

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
.alg-menu fieldset .note { font-size: 11px; color: var(--hud-dim); }
.alg-menu .main { display: grid; gap: 8px; margin: 6px 0 4px; }
.alg-menu .main button { width: 100%; text-align: left; padding: 11px 16px; }
.alg-menu .keyt { width: 100%; border-collapse: collapse; font-size: 12px; margin-bottom: 14px; }
.alg-menu .keyt td { padding: 4px 0; border-bottom: 1px solid var(--hud-edge); }
.alg-menu .keyt td:first-child { width: 150px; }
.alg-menu .keyt kbd { font: 11px var(--hud-mono); padding: 0 5px; border: 1px solid var(--hud-edge-hi); border-radius: 2px; margin-right: 3px; color: var(--hud-text); }
.alg-menu.manual { width: min(640px, 92vw); }
.alg-menu .man { max-height: 62vh; overflow-y: auto; padding-right: 8px; margin-bottom: 14px; font-size: 13px; line-height: 1.5; color: var(--hud-text); }
.alg-menu .man h3 { margin: 16px 0 6px; font-size: 11px; letter-spacing: 0.2em; text-transform: uppercase; color: var(--hud-brass); }
.alg-menu .man h3:first-child { margin-top: 0; }
.alg-menu .man p { margin: 0 0 8px; }
.alg-menu .man ul { margin: 0 0 8px; padding-left: 18px; }
.alg-menu .man li { margin: 2px 0; }
.alg-menu .man kbd { font: 11px var(--hud-mono); padding: 0 5px; border: 1px solid var(--hud-edge-hi); border-radius: 2px; }
.alg-menu .man .tabs { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
.alg-menu .man .tabs button { padding: 4px 10px; font-size: 11px; }
.alg-menu .man .tabs button.on { border-color: var(--hud-brass); color: #f1dfa6; }
#alg-paused { position: fixed; top: 64px; left: calc((100vw - var(--alg-dev-w, 340px)) / 2); transform: translateX(-50%); z-index: 89;
  font: 700 13px var(--hud-sans); letter-spacing: 0.4em; color: #f1dfa6; text-shadow: 0 1px 3px #000; pointer-events: none; }
`;

const ABILITY_NAMES = { patrol: t("Patrouille"), grenade: t("Grenade"), smoke: t("Fumigène"), stop: t("Halte"), focus: t("Caméra sur la sélection"), cutWire: t("Couper les barbelés"), cancelSite: t("Annuler un chantier"), retreat: t("Retraite"), reinforce: t("Renforcer"), lmg: "FM 24/29", barrage: t("Tir de barrage"), airStrike: t("Frappe aérienne"), repair: t("Réparer"), unload: t("Sortir / débarquer"), aimArc: t("Orienter la mitrailleuse") };

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

  // The HUD's size (ui/uiScale.js), from the saved option.
  const uiScale = createUiScale(opts.uiScale);
  app.algUiScale = uiScale;
  // The saved options, applied now.
  function apply() {
    uiScale.set(opts.uiScale);
    GIBS.mode = opts.gore;
    app.algOptions = opts;
    if (rtsCamera?.params) { rtsCamera.params.panSpeed = opts.panSpeed; rtsCamera.params.edgeScroll = opts.edgeScroll; }
  }
  apply();

  let back = null, paused = false, savedScale = 1, heldAudio = false;
  const badge = document.createElement("div");
  badge.id = "alg-paused";
  badge.textContent = t("PAUSE");
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
    show(`<div class="kicker">Sand &amp; Blood</div><h2>${t("Pause")}</h2>
      <div class="main">
        <button class="go" data-a="resume">${t("Reprendre")}</button>
        <button data-a="options">${t("Options")}</button>
        <button data-a="keys">${t("Commandes")}</button>
        <button data-a="manual">${t("Manuel")}</button>
        <button data-a="restart">${t("Recommencer la bataille")}</button>
      </div>`, (el) => {
      el.querySelector('[data-a="resume"]').onclick = resume;
      el.querySelector('[data-a="options"]').onclick = optionsPage;
      el.querySelector('[data-a="keys"]').onclick = keysPage;
      el.querySelector('[data-a="manual"]').onclick = () => manualPage();
      el.querySelector('[data-a="restart"]').onclick = () => location.reload();
    });
  }

  const pct = (v) => `${Math.round(v * 100)}%`;
  function optionsPage() {
    const s = audio?.settings ?? {};
    const slider = (key, label, v, min, max, step, fmt) =>
      `<label class="r">${label}<input type="range" data-k="${key}" min="${min}" max="${max}" step="${step}" value="${v}"><output>${fmt(v)}</output></label>`;
    show(`<div class="kicker">${t("Pause")}</div><h2>${t("Options")}</h2>
      <div class="opts">
        <fieldset><legend>${t("Son")}</legend>
          <label class="r">${t("Son")}<input type="checkbox" data-k="sound" ${s.muted ? "" : "checked"}><output></output></label>
          ${slider("master", t("Volume général"), s.master ?? 0.8, 0, 1, 0.05, pct)}
          ${slider("sfx", t("Combats et véhicules"), s.sfx ?? 1, 0, 1, 0.05, pct)}
          ${slider("voices", t("Voix radio"), s.voices ?? 1, 0, 1, 0.05, pct)}
          ${slider("ambience", t("Ambiance"), s.ambience ?? 0.7, 0, 1, 0.05, pct)}
        </fieldset>
        <fieldset><legend>${t("Jeu")}</legend>
          <label class="r">${t("Corps déchiquetés")}<select data-k="gore"><option value="coh"${opts.gore === "coh" ? " selected" : ""}>${t("Explosions proches")}</option><option value="off"${opts.gore === "off" ? " selected" : ""}>${t("Non")}</option></select><output></output></label>
          <label class="r">${t("Conseils")}<input type="checkbox" data-k="tips" ${opts.tips ? "checked" : ""}><output></output></label>
        </fieldset>
        <fieldset><legend>${t("Langue")}</legend>
          <label class="r">${t("Langue")}<select data-k="lang">${LANGS.map((l) => `<option value="${l.key}"${l.key === LANG ? " selected" : ""}>${l.label}</option>`).join("")}</select><output></output></label>
          <div class="note">${t("La partie recommence dans la langue choisie.")}</div>
        </fieldset>
        <fieldset><legend>${t("Affichage")}</legend>
          ${slider("uiScale", t("Taille de l'interface"), opts.uiScale, 1, 1.5, 0.05, pct)}
        </fieldset>
        <fieldset><legend>${t("Caméra")}</legend>
          ${slider("panSpeed", t("Vitesse de défilement"), opts.panSpeed, 25, 110, 5, (v) => `${v}`)}
          <label class="r">${t("Défilement au bord")}<input type="checkbox" data-k="edgeScroll" ${opts.edgeScroll ? "checked" : ""}><output></output></label>
        </fieldset>
      </div>
      <div class="row"><button data-a="back">${t("Retour")}</button><button class="go" data-a="resume">${t("Reprendre")}</button></div>`, (el) => {
      el.querySelector('[data-a="back"]').onclick = mainPage;
      el.querySelector('[data-a="resume"]').onclick = resume;
      el.addEventListener("input", (e) => {
        const el2 = e.target, k = el2.dataset.k;
        if (!k) return;
        const out = el2.closest("label")?.querySelector("output");
        if (k === "lang") { if (el2.value !== LANG) setLang(el2.value); return; }
        if (el2.type === "range") {
          const v = Number(el2.value);
          if (k === "panSpeed") { opts.panSpeed = v; save(); apply(); out.textContent = `${v}`; return; }
          if (k === "uiScale") { opts.uiScale = v; save(); apply(); out.textContent = pct(v); return; }
          out.textContent = pct(v);
          if (k === "voices") voices?.setLevel?.(v);
          else audio?.set(k, v);
          // (paused: the mixer's set() resumes the context — hold it again)
          if (paused && audio && !audio.settings.muted) { audio.ctx.suspend(); heldAudio = true; }
        } else if (k === "sound") {
          audio?.set("muted", !el2.checked);
          if (paused && audio && !audio.settings.muted) { audio.ctx.suspend(); heldAudio = true; }
        } else if (k === "gore") { opts.gore = el2.value; save(); apply(); }
        else if (k === "tips" || k === "edgeScroll") { opts[k] = el2.checked; save(); apply(); }
      });
    });
  }

  function keysPage() {
    const row = (what, ...keys) => `<tr><td>${what}</td><td>${keys.map((k) => `<kbd>${k}</kbd>`).join(" ")}</td></tr>`;
    const abil = Object.entries(HOTKEY).map(([k, key]) => row(ABILITY_NAMES[k] ?? k, key)).join("");
    show(`<div class="kicker">${t("Pause")}</div><h2>${t("Commandes")}</h2>
      <table class="keyt">
        ${row(t("Déplacer la caméra"), "Z Q S D", "↑ ← ↓ →")}
        ${row(t("Tourner la caméra"), "A", "E")}
        ${row(t("Zoom"), t("molette"))}
        ${row(t("Sélectionner"), t("clic gauche"), t("glisser"))}
        ${row(t("Ajouter à la sélection"), t("Maj + clic"))}
        ${row(t("Tous du même type"), t("double-clic"))}
        ${row(t("Déplacer / attaquer"), t("clic droit"))}
        ${row(t("Groupes"), "Ctrl + 1…9", "1…9")}
        ${row(t("Voir la couverture"), t("V (maintenu)"))}
        ${row(t("Carte tactique"), t("Tab (maintenu ou tapé)"))}
        ${row(t("Dernière alerte"), t("Espace"))}
        ${row(t("Tourner un bâtiment"), "R")}
        ${row(t("Pause / menu"), t("Échap"), "F10")}
        ${abil}
      </table>
      <div class="keys">${t("Les touches suivent leur place sur le clavier : sur un clavier QWERTY, la caméra se déplace avec W A S D et tourne avec Q / E.")}</div>
      <div class="row"><button data-a="back">${t("Retour")}</button><button class="go" data-a="resume">${t("Reprendre")}</button></div>`, (el) => {
      el.querySelector('[data-a="back"]').onclick = mainPage;
      el.querySelector('[data-a="resume"]').onclick = resume;
    });
  }

  // ── THE MANUAL ─────────────────────────────────────────────────────────────
  const K = (k) => `<kbd>${k}</kbd>`;
  const P = (s) => `<p>${s}</p>`;
  const UL = (...items) => `<ul>${items.map((s) => `<li>${s}</li>`).join("")}</ul>`;
  const MANUAL = [
    [t("But"),
      P(t("Algérie, 1957, la vallée de Tighanimine dans les Aurès. Vous commandez le poste français ; le FLN tient la montagne.")) +
      P(t("<b>Les villages sont l'enjeu.</b> Chaque camp part de <b>500 points</b>. Celui qui tient <b>moins</b> de villages perd des points chaque seconde ; à 0, il a perdu.")) +
      UL(
        t("<b>Prendre un village :</b> postez des hommes <b>à pied</b> dans son cercle, sans ennemi dedans."),
        t("<b>Victoire immédiate :</b> détruisez la <b>grotte du FLN</b> (au nord-ouest)."),
        t("<b>Défaite immédiate :</b> le <b>poste</b> est détruit."),
      )],
    [t("Ressources"),
      P(t("Trois ressources, en haut à droite :")) +
      UL(
        t("<b>Effectifs</b> : former les unités. Le poste en rapporte toujours un peu."),
        t("<b>Carburant</b> : les véhicules, l'Alouette, les échelons."),
        t("<b>Munitions</b> : grenades, capacités (barrage, frappe aérienne…), la Légion."),
      ) +
      P(t("Les villages et les points de ravitaillement que vous tenez en rapportent, s'ils sont <b>reliés au poste</b> par des terrains à vous. Un GMC en patrouille ravitaille les villages tenus.")) +
      P(t("<b>Échelons</b> (sur la fiche du poste) : <b>Moyens héliportés</b> (tenir 1 village) ouvre les paras, l'Alouette, le half-track ; <b>Blindés</b> (tenir 2 villages) ouvre l'EBR, l'AMX-13, la Légion."))],
    [t("Unités"),
      UL(
        t("<b>Appelés</b> (groupe de 6) : l'infanterie de base. Grenades, fumigène ; l'amélioration <b>FM 24/29</b> leur donne un fusil-mitrailleur."),
        t("<b>Sapeurs du Génie</b> (3) : construisent, réparent, coupent les barbelés."),
        t("<b>Pièce FM</b> (3) : une mitrailleuse et ses servants. Arrêtée, elle <b>se met en batterie</b> (quelques secondes) et ne tire que dans son <b>secteur</b> (le cône au sol) — mais elle cloue au sol tout ce qui y entre. Pour bouger, elle se replie d'abord. Prenez-la de flanc ou aveuglez-la au fumigène."),
        t("<b>Paras coloniaux</b> : infanterie d'élite, arrivent par l'hélisurface."),
        t("<b>Légionnaires</b> : l'infanterie la plus solide."),
        t("<b>Jeep Willys</b> : rapide, une mitrailleuse ; éclaire le terrain."),
        t("<b>Camion GMC</b> : transporte, ravitaille les villages en patrouille."),
        t("<b>Half-track M3</b> : blindé léger, une .50 qui touche aussi les avions."),
        t("<b>Panhard EBR, AMX-13</b> : blindés à canon de 75, contre les positions et les bâtiments. <b>Le blindage dépend du côté touché</b> : les balles ricochent sur l'avant, mordent sur les flancs et percent l'arrière (l'AMX-13 tient des minutes face à un groupe, une vingtaine de secondes de dos). Gardez l'avant vers l'ennemi ; grenades et mines frappent de partout."),
        t("<b>Alouette II</b> : hélicoptère armé d'une AA-52."),
      ) +
      P(t("L'infanterie se commande <b>par groupe</b> : un clic sur un homme sélectionne tout son groupe. Les unités gagnent des <b>galons</b> (vétérance) en combattant."))],
    [t("Le poste et les bâtiments"),
      P(t("<b>Le poste de Tighanimine</b> (le fort blanc au drapeau) : cliquez-le pour former l'infanterie, débloquer les échelons, et appeler la <b>frappe aérienne</b>. Ses tours tirent seules sur l'ennemi proche.")) +
      P(t("<b>Le parc auto</b> forme les véhicules ; <b>l'hélisurface</b> les paras et l'Alouette.")) +
      P(t("<b>Construire</b> (sapeurs sélectionnés) : sacs de sable, barbelés, nid de mitrailleuse, fosse de mortier, mirador, projecteur. Choisissez sur leur fiche, placez avec le clic gauche, {key} pour tourner.", { key: K("R") }))],
    [t("Ordres spéciaux"),
      UL(
        t("<b>Carte tactique</b> : maintenez {key} pour un coup d'œil sur toute la vallée, tapez-le pour la garder ouverte. Clic gauche : la caméra y va ; clic droit : la sélection y part.", { key: K("Tab") }),
        t("<b>Couverture</b> : maintenez {key} pour voir où les hommes sont à couvert (vert) et cachés (cyan). Derrière murs et rochers on survit ; à découvert, non.", { key: K("V") }),
        t("<b>Garnison</b> : infanterie sélectionnée, <b>clic droit sur une maison</b> : le groupe entre et tire par les fenêtres. Une grenade dedans les fait sortir. {key} : sortir.", { key: K("K") }),
        t("<b>Orienter la mitrailleuse</b> {key} : pièce FM sélectionnée, cliquez où elle doit tirer : en batterie, elle pivote (lentement) ; repliée, elle se mettra en batterie face à ce point.", { key: K("O") }),
        t("<b>Grenade</b> {g}, <b>fumigène</b> {b} : visez avec le clic gauche. La fumée coupe la vue.", { g: K("G"), b: K("B") }),
        t("<b>Retraite</b> {t} : le groupe rentre au poste, plus vite. <b>Renforcer</b> {y} : au poste, remplace les hommes perdus.", { t: K("T"), y: K("Y") }),
        t("<b>Réparer</b> {key} : sapeurs sélectionnés, clic droit sur un véhicule ou un bâtiment abîmé.", { key: K("J") }),
        t("<b>Couper les barbelés</b> {key} : les sapeurs coupent les plus proches.", { key: K("X") }),
        t("<b>Patrouille</b> {key} : aller-retour sur la piste la plus proche.", { key: K("P") }),
      )],
    [t("Appuis"),
      UL(
        t("<b>Tir de barrage</b> {key} (fosse de mortier) : six obus sur une zone ; les abris ne protègent pas.", { key: K("M") }),
        t("<b>Fusée éclairante</b> (fosse de mortier, la nuit) : éclaire une zone et révèle ceux qui s'y cachent."),
        t("<b>Frappe aérienne</b> {key} (le poste) : un T-6 arrive en quelques secondes, mitraille une ligne jusqu'au point puis y largue deux bombes.", { key: K("L") }),
      ) +
      P(t("Pour ces trois appuis : cliquez le bouton, un cercle suit la souris, <b>clic gauche</b> pour tirer, clic droit ou {key} pour annuler.", { key: K(t("Échap")) }))],
    [t("Le FLN"),
      P(t("Le FLN ne se bat pas à découvert : ses bandes attendent dans les broussailles et frappent ceux qui s'approchent, puis se replient vers la montagne. Ses <b>caches d'armes</b> arment des tireurs FM : trouvez-les et détruisez-les.")) +
      P(t("Éclairez avec la jeep, avancez groupés, gardez le FM avec vous, et méfiez-vous des villages tranquilles."))],
  ];
  function manualPage(i = 0) {
    show(`<div class="kicker">${t("Pause")}</div><h2>${t("Manuel")}</h2>
      <div class="man">
        <div class="tabs">${MANUAL.map(([title], k) => `<button data-t="${k}"${k === i ? ' class="on"' : ""}>${title}</button>`).join("")}</div>
        <h3>${MANUAL[i][0]}</h3>${MANUAL[i][1]}
      </div>
      <div class="row"><button data-a="back">${t("Retour")}</button><button class="go" data-a="resume">${t("Reprendre")}</button></div>`, (el) => {
      el.classList.add("manual");
      el.querySelector('[data-a="back"]').onclick = mainPage;
      el.querySelector('[data-a="resume"]').onclick = resume;
      el.querySelectorAll("[data-t]").forEach((b) => (b.onclick = () => manualPage(+b.dataset.t)));
    });
  }

  function open() { pause(); mainPage(); }
  // Esc: not while another mode owns it (a targeting crosshair, a building being placed) or a
  // modal of the battle's own is up (the briefing, the end).
  const busy = () => app.algTacMap?.open || !!app.renderer.domElement.style.cursor || app.algBuild?.placing || (!!document.querySelector(".alg-modal-back") && !back);
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
