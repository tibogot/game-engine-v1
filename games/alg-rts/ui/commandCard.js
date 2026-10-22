// THE ALGERIA GAME'S COMMAND CARD — the HUD's right slot (hudBar.js).
// REBUILT 2026-10-02 (you: "the UI could be better — change it completely if
// you want"): a fixed GRID OF ICON BUTTONS, the Company of Heroes way.
//
//   • every order is a square: its icon, a short name, its hotkey in the
//     corner, its price; a cooldown sweeps round it; locked = dark with a lock
//   • the same order always sits in the same square (orders first, then the
//     abilities, then what the selection can build / train)
//   • hover: a real tooltip ABOVE the panel — name, price, what it does, why
//     it is locked, the key
//   • a building: its queue as portraits (the first with its progress), then
//     what it trains as portrait buttons
//
// Who the selection is (portrait, men, state, cover) is the selection card's
// (unitBar.js). Per frame: only classes, a CSS variable and text on change.
import { HOTKEY, hasIcon, iconStyle } from "./icons.js";
import { hasRendered, renderedStyle } from "./iconAtlas.js";
import { thumbKeyOf } from "../../shared-rts/thumbnails.js";
import { costOf, hasCost } from "../algEconomy.js";
import { iconSvg } from "./resourceIcons.js";
import { t } from "../i18n/i18n.js";
import { HUD_H } from "./hudBar.js";

// A price on a button: the effectifs, then the fuel / munitions under it.
function costTag(c) {
  const k = costOf(c);
  // Each resource with its icon (ui/resourceIcons.js), as CoH prices things.
  const ic = (key) => iconSvg(key, { size: 9 });
  const parts = [k.mp ? `<b>${ic("mp")}${k.mp}</b>` : "", k.fuel ? `<b class="fu">${ic("fuel")}${k.fuel}</b>` : "", k.mun ? `<b class="mu">${ic("mun")}${k.mun}</b>` : ""].filter(Boolean);
  return parts.length ? `<span class="co">${parts.join("")}</span>` : "";
}
// The same, spelled out for a tooltip.
function costText(c) {
  const k = costOf(c);
  return [k.mp && `${iconSvg("mp", { size: 11 })} ${t("{n} effectifs", { n: k.mp })}`, k.fuel && `${iconSvg("fuel", { size: 11 })} ${t("{n} carburant", { n: k.fuel })}`, k.mun && `${iconSvg("mun", { size: 11 })} ${t("{n} munitions", { n: k.mun })}`].filter(Boolean).join(" · ");
}

const CSS = `
#rts-cmd-card { height: 100%; display: flex; flex-direction: column; gap: 6px; font-family: var(--hud-sans); color: var(--hud-text); }
/* COMPANY OF HEROES' CARD (2026-10-22, you: "look how company of heroes does it"): a FIXED 5 × 3 grid always drawn —
   the empty slots dark recessed cells — retreat always top-right on red, the build page bottom-right; framed tiles,
   the hotkey small at the bottom-right. */
#rts-cmd-card .cc-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 4px; }
#rts-cmd-card .cc-empty { aspect-ratio: 1; border-radius: 3px; background: repeating-linear-gradient(135deg, #14150f 0 3px, #191a13 3px 6px);
  box-shadow: inset 0 1px 3px rgba(0,0,0,0.85), inset 0 0 0 1px #262820; }
#rts-cmd-card .cc-b {
  position: relative; height: 46px; cursor: pointer; overflow: hidden; padding: 0;
  display: flex; flex-direction: column; align-items: center; justify-content: flex-end;
  background: linear-gradient(#2a2e23, #1f221a); border: 1px solid #454c3a; border-radius: var(--hud-radius);
  color: var(--hud-text); font: 600 9px var(--hud-sans); letter-spacing: 0.04em; text-transform: uppercase;
}
#rts-cmd-card .cc-b:hover { border-color: var(--hud-brass); background: linear-gradient(#343929, #262a20); }
#rts-cmd-card .cc-b .ic { position: absolute; left: 50%; top: 4px; width: 24px; height: 24px; transform: translateX(-50%);
  background: #d9c58f; -webkit-mask: center/contain no-repeat; mask: center/contain no-repeat; }
/* SQUARE BUTTONS, PICTURES ONLY (2026-10-22, you: "make them squares, the image fills it, no text — the name in the
   hover info"): a RENDERED icon (iconAtlas.js) fills its button; the hotkey and the cost stay, on a dark backing. */
#rts-cmd-card .cc-b { height: auto; aspect-ratio: 1; }
#rts-cmd-card .cc-b.sq { border: 1px solid #5d5440; box-shadow: inset 0 1px 0 rgba(255,235,190,0.18), inset 0 -2px 3px rgba(0,0,0,0.6), 0 1px 2px rgba(0,0,0,0.7); }
#rts-cmd-card .cc-b.sq:hover { border-color: var(--hud-brass); }
#rts-cmd-card .cc-b.sq .ri { inset: 2px; border-radius: 2px; }
/* the colour code is baked into the tiles (iconAtlas CATEGORY); retreat's frame red too */
#rts-cmd-card .cc-b.c-red { border-color: #9a3a2c; }
#rts-cmd-card .cc-b .ri { position: absolute; inset: 0; background-repeat: no-repeat; }
#rts-cmd-card .cc-b.sq .lb { display: none; }
#rts-cmd-card .cc-b.sq .hk, #rts-cmd-card .cc-b.sq .co { z-index: 1; background: rgba(10,9,6,0.72); border-radius: 3px; padding: 0 3px; }
#rts-cmd-card .cc-b.sq .hk { left: auto; top: auto; right: 2px; bottom: 2px; color: #e8d9ae; font-size: 9px; }
#rts-cmd-card .cc-b.sq .co { right: 2px; top: 2px; }
#rts-cmd-card .cc-b .pic { inset: 0 0 15px 0; }
#rts-cmd-card .cc-b.poor .ri { opacity: 0.45; }
#rts-cmd-card .cc-b .pic { position: absolute; inset: 0 0 13px 0; background: center 22%/cover no-repeat; }
#rts-cmd-card .cc-b .lb { position: relative; padding: 0 2px 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
#rts-cmd-card .cc-b .hk { position: absolute; left: 3px; top: 2px; font: 700 9px var(--hud-mono); color: var(--hud-dim); }
#rts-cmd-card .cc-b .co { position: absolute; right: 3px; top: 2px; font: 700 10px var(--hud-mono); color: var(--hud-brass); text-shadow: 0 1px 2px #000; display: flex; flex-direction: column; align-items: flex-end; line-height: 1.05; }
#rts-cmd-card .cc-b .co b { font-weight: 700; }
#rts-cmd-card .cc-b .co .fu { color: #e2b25a; }
#rts-cmd-card .cc-b .co .mu { color: #d48a6a; }
#rts-cmd-card .cc-b.verb { background: linear-gradient(#3a3520, #2a2717); border-color: rgba(201,165,74,0.5); }
#rts-cmd-card .cc-b.verb:hover { background: linear-gradient(#463f25, #332f1c); border-color: var(--hud-brass); }
#rts-cmd-card .cc-b.tier { border-color: var(--hud-brass); box-shadow: inset 0 0 0 1px rgba(201,165,74,0.35); }
#rts-cmd-card .cc-b.tier .ic { background: #f1dfa6; }
/* Cooldown: a dark wedge that sweeps away as it comes back (--cd: 1 → 0). */
#rts-cmd-card .cc-b::after { content: ""; position: absolute; inset: 0; pointer-events: none;
  background: conic-gradient(rgba(8,9,6,0.78) calc(var(--cd, 0) * 360deg), transparent 0); }
#rts-cmd-card .cc-b.cool { cursor: default; }
#rts-cmd-card .cc-b.cool .co { display: none; }
#rts-cmd-card .cc-b .cdn { position: absolute; left: 0; right: 0; top: 13px; text-align: center; font: 700 12px var(--hud-mono); color: #f1e6c4; z-index: 1; text-shadow: 0 1px 2px #000; }
#rts-cmd-card .cc-b.poor .co { color: var(--hud-red); }
#rts-cmd-card .cc-b.poor .ic, #rts-cmd-card .cc-b.poor .pic { opacity: 0.45; }
#rts-cmd-card .cc-b.locked { cursor: not-allowed; filter: grayscale(1); opacity: 0.5; }
#rts-cmd-card .cc-b.locked .co { display: none; }
/* The post's tier button when it can be bought (2026-10-08): a slow brass pulse. */
#rts-cmd-card .cc-b.tier.ready { animation: cc-ready 1.6s ease-in-out infinite; }
@keyframes cc-ready { 0%, 100% { box-shadow: 0 0 0 0 rgba(242, 201, 76, 0); } 50% { box-shadow: 0 0 0 3px rgba(242, 201, 76, 0.55); } }
#rts-cmd-card .cc-b.locked::before { content: "🔒"; position: absolute; right: 3px; top: 1px; font-size: 9px; filter: grayscale(1); }
#rts-cmd-card .cc-q { display: flex; gap: 4px; align-items: center; min-height: 34px; }
#rts-cmd-card .cc-q .q { position: relative; width: 34px; height: 34px; flex: none; background: #1b1e17 center 22%/cover no-repeat; border: 1px solid #454c3a; border-radius: var(--hud-radius); }
#rts-cmd-card .cc-q .q.first { width: 40px; height: 40px; border-color: var(--hud-brass); }
#rts-cmd-card .cc-q .q { cursor: pointer; }
#rts-cmd-card .cc-q .q:hover { border-color: var(--hud-red); }
#rts-cmd-card .cc-q .q:hover::after { content: "✕"; position: absolute; inset: 0; display: grid; place-items: center;
  font: 700 16px var(--hud-sans); color: #ffb0a2; background: rgba(40, 10, 6, 0.55); }
#rts-cmd-card .cc-q .q .bar { position: absolute; left: 2px; right: 2px; bottom: 2px; height: 3px; background: #23261d; }
#rts-cmd-card .cc-q .q .bar i { display: block; height: 100%; width: 0; background: var(--hud-brass); }
#rts-cmd-card .cc-q .idle { font-size: 10px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--hud-dim); }
#rts-cmd-card .cc-hint { font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--hud-dim); }

#alg-tip {
  position: fixed; z-index: 70; pointer-events: none; display: none; width: 250px;
  background: rgba(14, 16, 12, 0.98); border: 1px solid var(--hud-edge-hi); border-top: 2px solid var(--hud-brass);
  border-radius: var(--hud-radius); padding: 8px 10px; box-shadow: 0 8px 22px rgba(0,0,0,0.5);
  font: 12px/1.4 var(--hud-sans); color: var(--hud-text);
}
#alg-tip .t { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
#alg-tip .t b { font-size: 13px; color: #efe8d2; }
#alg-tip .t span { font: 700 11px var(--hud-mono); color: var(--hud-brass); }
#alg-tip .d { margin-top: 4px; color: #b9b3a0; }
#alg-tip .l { margin-top: 5px; color: #ff9a86; font-weight: 600; }
#alg-tip .k { margin-top: 5px; font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--hud-dim); }
#alg-tip .k kbd { font: 700 10px var(--hud-mono); color: var(--hud-text); border: 1px solid #4a503c; border-radius: 2px; padding: 0 4px; }
`;

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

export function createCommandCard({
  thumbnails,
  onStop = () => {},
  onFocus = () => {},
  onBuild = () => {},          // (structure, key) — enqueue production on that structure
  productionFor = () => [],    // (structure) → [{ key, label, cost, locked, tier, tip, ready }]
  onLocked = null,             // (button) → a click on a locked one (alg-rts: to the post, where tiers are bought)
  canAfford = () => true,      // (cost) → affordable right now? (cost: a number = effectifs, or { mp, fuel, mun })
  shortOf = () => "",          // (cost) → what is missing ("45 Carburant"), for the tooltip
  structureBuilds = [],        // [{ key, label, tip }] — what a builder can raise
  buildingCosts = {},          // { key: supplies }
  onBuildStructure = () => {},
  abilitiesFor = () => [],     // (selected) → [{ key, label, hint, cost, ready, cooldown }]
  onAbility = () => {},        // (key, selected)
  stanceFor = () => null,      // kept for the API (the selection card shows the stance now)
  mount = document.body,
}) {
  const root = document.createElement("div");
  root.id = "rts-cmd-card";
  mount.appendChild(root);
  // the bottom HUD's height for what sits over it (the doctrine panel): the square buttons made it taller
  { const box = mount.closest?.(".block") ?? mount; new ResizeObserver(() => document.documentElement.style.setProperty("--alg-hud-h", `${Math.round(window.innerHeight - box.getBoundingClientRect().top)}px`)).observe(box); }
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
  const tip = document.createElement("div");
  tip.id = "alg-tip";
  document.body.appendChild(tip);

  let selRef = [];
  let baseRef = null;
  let buttons = [];        // { el, kind, key, cost, info, run }
  const cdMax = new Map(); // ability key → the longest cooldown seen (for the sweep)
  let prodSig = "", prodT = 0, abilSig = "";
  let buildPage = false, buildFor = "";   // the build page open, for which selection
  const ids = new WeakMap();
  let nextId = 0;
  const idOf = (e) => { let i = ids.get(e); if (i == null) ids.set(e, (i = ++nextId)); return i; };   // (units carry no id)

  // ── Buttons ────────────────────────────────────────────────────────────────
  function button({ kind, key, label, cost = 0, icon = null, pic = null, verb = false, tier = false, locked = null, info = "", ready = false, run }) {
    const el = document.createElement("button");
    el.className = `cc-b${verb ? " verb" : ""}${tier ? " tier" : ""}${locked ? " locked" : ""}${ready ? " ready" : ""}`;
    const hk = HOTKEY[key];
    el.innerHTML = `${pic ? `<span class="pic" style="background-image:url(${pic})"></span>` : icon && hasRendered(icon) ? `<span class="ri" style="${renderedStyle(icon)}"></span>` : icon && hasIcon(icon) ? `<span class="ic" style="${iconStyle(icon)}"></span>` : ""}`
      + `${hk ? `<span class="hk">${hk}</span>` : ""}${costTag(cost)}<span class="lb">${esc(label)}</span>`;
    el.dataset.key = key;
    const b = { el, kind, key, cost, label, info, locked, run };
    if (key === "retreat") el.classList.add("c-red");
    if (!pic && icon && hasRendered(icon)) el.classList.add("sq");
    el.addEventListener("click", () => {
      // A LOCKED unit: to where it is unlocked (the game's `onLocked`: the post).
      if (b.locked) { onLocked?.(b); return; }
      if (el.classList.contains("cool")) return;
      if (hasCost(b.cost) && !canAfford(b.cost)) return;
      run();
    });
    el.addEventListener("mouseenter", () => showTip(b));
    el.addEventListener("mouseleave", hideTip);
    buttons.push(b);
    return el;
  }
  function showTip(b) {
    const hk = HOTKEY[b.key];
    tip.innerHTML = `<div class="t"><b>${esc(b.label)}</b>${hasCost(b.cost) ? `<span>${costText(b.cost)}</span>` : ""}</div>`
      + (b.info ? `<div class="d">${esc(b.info)}</div>` : "")
      + (b.locked ? `<div class="l">${t("Verrouillé — {why}", { why: esc(b.locked) })}</div>` : hasCost(b.cost) && !canAfford(b.cost) ? `<div class="l">${t("Manque : {what}", { what: esc(shortOf(b.cost) || t("ressources")) })}</div>` : "")
      + (hk ? `<div class="k">${t("Touche")} <kbd>${hk}</kbd></div>` : "");
    tip.style.display = "block";
    const r = b.el.getBoundingClientRect(), panel = root.getBoundingClientRect();
    tip.style.left = `${Math.max(8, Math.min(window.innerWidth - 258, r.left + r.width / 2 - 125))}px`;
    tip.style.top = `${panel.top - 10 - tip.offsetHeight - 6}px`;
  }
  function hideTip() { tip.style.display = "none"; }

  /** CoH's fixed card: retreat top-right, the build page / back bottom-right, the empty slots drawn to 5 × 3. */
  const FIXED = { retreat: [5, 1], buildMenu: [5, 3], buildBack: [5, 3] };
  function layout(grid) {
    for (const el of grid.children) { const p = FIXED[el.dataset.key]; if (p) { el.style.gridColumn = p[0]; el.style.gridRow = p[1]; } }
    const n = grid.children.length, total = Math.max(15, Math.ceil(n / 5) * 5);
    for (let i = n; i < total; i++) { const e = document.createElement("div"); e.className = "cc-empty"; grid.appendChild(e); }
  }

  // ── Faces ──────────────────────────────────────────────────────────────────
  function abilityButtons(selected, into) {
    const list = abilitiesFor(selected);
    abilSig = list.map((a) => a.key).join(",");
    for (const a of list) {
      into.appendChild(button({
        kind: "abil", key: a.key, label: a.label, cost: a.cost ?? 0, icon: a.key, verb: true, info: a.hint,
        run: () => onAbility(a.key, selected),
      }));
    }
  }

  function renderUnits(selected) {
    baseRef = null;
    root.replaceChildren();
    const grid = document.createElement("div");
    grid.className = "cc-grid";
    grid.appendChild(button({ kind: "act", key: "stop", label: t("Halte"), icon: "stop", info: t("Halte : abandonner l'ordre en cours et tenir ici."), run: onStop }));
    grid.appendChild(button({ kind: "act", key: "focus", label: t("Caméra"), icon: "focus", info: t("Centrer la caméra sur la sélection."), run: onFocus }));
    // What these men can raise (the union of every builder's list).
    const can = new Set();
    for (const u of selected) for (const k of u.type?.builds ?? []) can.add(k);
    const builds = structureBuilds.filter((s) => can.has(s.key));
    // THE BUILD PAGE (CoH's engineers, 2026-10-12 — you: the sappers' card "is clipping under the
    // screen": 17 buttons, 5 rows in a 3-row panel). The buildings behind one CONSTRUIRE button; the
    // page they open has RETOUR first. It stays open while the same men are selected.
    if (buildPage && builds.length) {
      grid.replaceChildren();
      grid.appendChild(button({ kind: "act", key: "buildBack", label: t("‹ Retour"), info: t("Revenir aux ordres du groupe."), run: () => { buildPage = false; render(selRef); } }));
      for (const b of builds) {
        grid.appendChild(button({
          kind: "build", key: b.key, label: b.label, cost: buildingCosts[b.key] ?? 0, icon: b.key, info: b.tip,
          run: () => onBuildStructure(b.key, selected),
        }));
      }
    } else {
      abilityButtons(selected, grid);
      if (builds.length) grid.appendChild(button({ kind: "act", key: "buildMenu", label: t("Construire"), icon: "buildMenu",
        info: builds.some((b) => b.key === "sangar") ? t("Les ouvrages que ce groupe peut bâtir : sangars, écrans d'embuscade, caches d'armes, refuges.") : t("Les ouvrages que ce groupe peut bâtir : sacs de sable, barbelés, nids, fosses…"),
        run: () => { buildPage = true; render(selRef); } }));
    }
    layout(grid);
    root.appendChild(grid);
    refresh();
  }

  function renderProducer(s) {
    baseRef = s;
    root.replaceChildren();
    const opts = productionFor(s);
    prodSig = JSON.stringify(opts);
    const q = document.createElement("div");
    q.className = "cc-q";
    q.id = "cc-q";
    root.appendChild(q);
    const grid = document.createElement("div");
    grid.className = "cc-grid";
    for (const o of opts) {
      const pic = o.tier ? null : thumbnails?.get(o.key);
      grid.appendChild(button({
        kind: "train", key: o.key, label: o.tier ? o.label.replace(/^▲\s*/, "") : o.label, cost: o.cost ?? 0, pic, icon: o.tier ? "tier" : null,
        tier: !!o.tier, locked: o.locked, ready: !!o.ready, info: o.tip ?? (o.tier ? "" : t("Former. Sort par la porte vers le point de ralliement.")),
        run: () => onBuild(s, o.key),
      }));
    }
    // A producer's own ABILITIES after its production (the post: the air strike call-in).
    abilityButtons([s], grid);
    layout(grid);
    root.appendChild(grid);
    queueSig = "";
    refresh();
  }

  function renderStructure(s) {
    baseRef = null;
    root.replaceChildren();
    const grid = document.createElement("div");
    grid.className = "cc-grid";
    grid.appendChild(button({ kind: "act", key: "focus", label: t("Caméra"), icon: "focus", info: t("Centrer la caméra dessus."), run: onFocus }));
    abilityButtons([s], grid);
    layout(grid);
    root.appendChild(grid);
    const st = s.constructing ? t("En construction") : (s.deploy ?? 1) < 1 ? t("Réglage") : s.range ? t("Défensif · {m} m", { m: Math.round(s.range) }) : "";
    if (st) { const h = document.createElement("div"); h.className = "cc-hint"; h.textContent = st; root.appendChild(h); }
    refresh();
  }

  function render(selected) {
    // Another selection: back to the main page (a re-render of the same one keeps the build page).
    const sig = selected.map(idOf).join(",");
    if (sig !== buildFor) { buildFor = sig; buildPage = false; }
    selRef = selected;
    buttons = [];
    hideTip();
    if (!selected.length) { baseRef = null; root.replaceChildren(); fit(); return; }
    const producer = selected.find((e) => e.isStructure && e.enqueue);
    const mobile = selected.filter((e) => !e.isStructure);
    if (producer) renderProducer(producer);
    else if (mobile.length) renderUnits(mobile);
    else renderStructure(selected[0]);
    fit();
  }
  // THE SAFETY NET (2026-10-12: the card ran 90 px off the screen): a card taller than its panel grows
  // the panel UPWARD to fit (it stands on the screen's bottom edge) — never past the window again.
  // Measured from the CONTENT against the panel's own height (HUD_H): the panel may be folded or
  // mid-animation when a selection renders (the first cut measured it then and set it too short).
  // (`.collapsed` wins over this height: hudBar.js.)
  function fit() {
    const panel = mount.closest?.(".block-right") ?? null;
    if (!panel) return;
    const pad = parseFloat(getComputedStyle(mount).paddingTop) + parseFloat(getComputedStyle(mount).paddingBottom);
    // The content's own extent (its children), in CSS px (the panel may be scaled: uiScale.js) — not
    // root.scrollHeight, which is never less than the panel and grew it a pixel a render.
    const s = Number(getComputedStyle(document.documentElement).getPropertyValue("--alg-ui")) || 1;
    const top = root.getBoundingClientRect().top;
    let bottom = top;
    for (const k of root.children) bottom = Math.max(bottom, k.getBoundingClientRect().bottom);
    const need = (bottom - top) / s + pad + 2;
    panel.style.height = need > HUD_H ? `${Math.ceil(need)}px` : "";
  }

  // ── Live state (per frame: classes, a variable, text — on change) ─────────
  let queueSig = "";
  function refresh() {
    const live = new Map(abilitiesFor(selRef).map((a) => [a.key, a]));
    for (const b of buttons) {
      if (b.kind === "abil") {
        const a = live.get(b.key);
        const cool = !!a && !a.ready;
        b.el.classList.toggle("cool", cool);
        if (cool) {
          const m = Math.max(cdMax.get(b.key) ?? 0, a.cooldown || 0);
          cdMax.set(b.key, m);
          b.el.style.setProperty("--cd", m > 0 ? (a.cooldown / m).toFixed(3) : "1");
          let n = b.el.querySelector(".cdn");
          if (!n) { n = document.createElement("span"); n.className = "cdn"; b.el.appendChild(n); }
          const txt = a.cooldown > 0 ? `${a.cooldown}` : "";
          if (n.textContent !== txt) n.textContent = txt;
        } else if (b.el.style.getPropertyValue("--cd")) {
          b.el.style.removeProperty("--cd");
          b.el.querySelector(".cdn")?.remove();
          cdMax.delete(b.key);
        }
      }
      if (hasCost(b.cost) && !b.locked) b.el.classList.toggle("poor", !canAfford(b.cost));
    }
    if (baseRef) {
      const qEl = root.querySelector("#cc-q");
      const queue = baseRef.queue ?? [];
      const sig = queue.join(",");
      if (qEl && sig !== queueSig) {
        queueSig = sig;
        qEl.innerHTML = queue.length
          ? queue.slice(0, 7).map((k, i) => `<span class="q${i === 0 ? " first" : ""}" data-qi="${i}" style="background-image:url(${thumbnails?.get(k) ?? ""})" title="${t("Clic : annuler (remboursé)")}">${i === 0 ? `<span class="bar"><i></i></span>` : ""}</span>`).join("")
            + (queue.length > 7 ? `<span class="idle">+${queue.length - 7}</span>` : "")
          : `<span class="idle">${baseRef.constructing ? t("En construction") : t("Rien en formation")}</span>`;
      }
      const bar = qEl?.querySelector(".bar i");
      if (bar) bar.style.width = `${Math.round((baseRef.progress ?? 0) * 100)}%`;
    }
  }

  // CANCEL a queued unit: a click on its portrait in the queue (refunded).
  root.addEventListener("click", (e) => {
    const q = e.target.closest?.("[data-qi]");
    if (!q || !baseRef?.cancel) return;
    baseRef.cancel(+q.dataset.qi);
    queueSig = "";
    refresh();
  });

  // Hotkeys (printed key, AZERTY-safe): only orders on the card now.
  window.addEventListener("keydown", (e) => {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.target?.matches?.("input, textarea, select")) return;
    const k = e.key === "Delete" ? "Del" : e.key?.length === 1 ? e.key.toUpperCase() : null;
    if (!k || k === "G" || k === "B") return;   // G, B: algGrenades.js has its own (it targets)
    // (Shift + a letter: "⇧H" — Halte au feu; a Shift-key that is nobody's falls back to the plain letter)
    const b = (e.shiftKey && k.length === 1 && buttons.find((x) => HOTKEY[x.key] === `⇧${k}`)) || buttons.find((x) => HOTKEY[x.key] === k);
    if (b) { b.el.click(); e.preventDefault(); }
  });

  render([]);

  return {
    root,
    render,
    /** Called each frame — cooldowns, affordability, the queue and its bar. */
    tick() {
      if (!selRef.length) return;
      // A tier unlocking, abilities appearing (a site, wire in reach): re-render, twice a second.
      if (performance.now() - prodT > 500) {
        prodT = performance.now();
        if (baseRef && JSON.stringify(productionFor(baseRef)) !== prodSig) { renderProducer(baseRef); return; }
        if (!baseRef && abilitiesFor(selRef.filter((e) => !e.isStructure).length ? selRef.filter((e) => !e.isStructure) : selRef).map((a) => a.key).join(",") !== abilSig) { render(selRef); return; }
      }
      refresh();
    },
    dispose() { root.remove(); style.remove(); tip.remove(); },
  };
}

/** For the selection card: a portrait URL for anything selectable. */
export const portraitOf = (thumbnails, u) => thumbnails?.get(thumbKeyOf(u)) ?? null;
