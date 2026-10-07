// THE ALGERIA GAME'S SELECTION CARD — the HUD's centre slot (hudBar.js).
// REBUILT 2026-10-02 (you: "change the UI completely if you want"): WHO is
// selected and HOW THEY ARE, the Company of Heroes way.
//
//   one type     the portrait, the name and how many; a PIP PER MAN (his
//                health; red when low); what they are doing (pinned,
//                suppressed, firing, moving); where they stand (hard / light
//                cover, concealed, spotted); their weapon
//   mixed        a tile per type with its count (click: only those ·
//                double-click: every one of that type on the map)
//   a building   its portrait, name, health
//
// Per frame (tick): the pips and the lines are rewritten only when they change.
import { thumbKeyOf } from "../../shared-rts/thumbnails.js";
import { t } from "../i18n/i18n.js";

const WEAPON = { rifle: t("Fusils"), mg: t("Mitrailleuse"), cannon: t("Canon"), gunship: t("Roquettes + mitrailleuse") };

const CSS = `
#rts-unit-bar { height: 100%; }
#rts-unit-bar .tiles { display: flex; flex-wrap: wrap; gap: 6px; align-content: flex-start; }
#rts-unit-bar .tile {
  position: relative; width: 70px; height: 70px; cursor: pointer;
  background: #1b1e17 center 25%/cover no-repeat; border: 1px solid #454c3a; border-radius: var(--hud-radius);
}
#rts-unit-bar .tile:hover { border-color: var(--hud-brass); }
#rts-unit-bar .tile .name {
  position: absolute; left: 0; right: 0; bottom: 0; padding: 2px 3px;
  font-size: 9px; letter-spacing: 0.06em; text-transform: uppercase; text-align: center;
  color: var(--hud-text); background: rgba(10, 11, 8, 0.72); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
#rts-unit-bar .tile .count {
  position: absolute; top: 3px; right: 3px; min-width: 16px; padding: 1px 3px;
  background: rgba(10, 11, 8, 0.85); border: 1px solid var(--hud-brass); color: var(--hud-brass); font: 700 10px var(--hud-mono); text-align: center;
}
#rts-unit-bar .one { display: flex; gap: 12px; height: 100%; }
#rts-unit-bar .portrait {
  width: 96px; height: 120px; flex: none; position: relative;
  background: #1b1e17 center 20%/cover no-repeat; border: 1px solid #454c3a; border-radius: var(--hud-radius);
}
#rts-unit-bar .portrait .n { position: absolute; right: 4px; bottom: 3px; font: 700 13px var(--hud-mono); color: var(--hud-brass); text-shadow: 0 1px 2px #000; }
#rts-unit-bar .portrait .mono { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font: 700 30px var(--hud-sans); color: #4a4d3c; }
#rts-unit-bar .info { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 5px; }
#rts-unit-bar .who { font-size: 15px; font-weight: 600; letter-spacing: 0.03em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#rts-unit-bar .pips { display: flex; flex-wrap: wrap; gap: 3px; }
#rts-unit-bar .pip { width: 9px; height: 16px; background: #23261d; border: 1px solid #3a4031; position: relative; }
#rts-unit-bar .pip i { position: absolute; left: 0; right: 0; bottom: 0; background: var(--hud-olive); }
#rts-unit-bar .pip i.low { background: var(--hud-red); }
#rts-unit-bar .hpbar { height: 6px; background: #23261d; border: 1px solid #3a4031; }
#rts-unit-bar .hpbar i { display: block; height: 100%; background: var(--hud-olive); }
#rts-unit-bar .hpbar i.low { background: var(--hud-red); }
#rts-unit-bar .chips { display: flex; flex-wrap: wrap; gap: 4px; min-height: 17px; }
#rts-unit-bar .chip { font-size: 9px; font-weight: 700; letter-spacing: 0.1em; padding: 2px 6px; border-radius: var(--hud-radius); border: 1px solid; }
#rts-unit-bar .chip.pinned { color: #ffb0a2; border-color: rgba(255,120,100,0.5); background: rgba(106,36,24,0.6); }
#rts-unit-bar .chip.supp { color: #ffd59a; border-color: rgba(255,200,120,0.45); background: rgba(90,61,18,0.55); }
#rts-unit-bar .chip.act { color: #e8dfc4; border-color: rgba(220,210,180,0.3); background: rgba(60,58,48,0.5); }
#rts-unit-bar .chip.cover { color: #c9b98a; border-color: rgba(201,185,138,0.4); background: rgba(74,66,42,0.4); }
#rts-unit-bar .chip.conceal { color: #9fcf7a; border-color: rgba(159,207,122,0.4); background: rgba(52,74,38,0.4); }
#rts-unit-bar .chip.seen { color: #e0905a; border-color: rgba(224,144,90,0.45); background: rgba(94,52,25,0.4); }
#rts-unit-bar .sub { font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--hud-dim); }
`;

export function createUnitBar({ thumbnails, onPickGroup = () => {}, onSelectAllType = () => {}, stanceFor = () => null, mount = document.body }) {
  const root = document.createElement("div");
  root.id = "rts-unit-bar";
  mount.appendChild(root);
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);

  let current = [];
  let one = null;      // { units, pips: [el], chips, hp } while one type is shown
  let lastPips = "", lastChips = "", lastHp = -1;

  const portrait = (u) => thumbnails?.get(thumbKeyOf(u));

  function renderOne(units) {
    const u = units[0], url = portrait(u);
    const mono = (u.name ?? u.typeKey).split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
    const isStruct = !!u.isStructure;
    root.innerHTML = `
      <div class="one">
        <div class="portrait" style="${url ? `background-image:url(${url})` : ""}">${url ? "" : `<span class="mono">${mono}</span>`}${units.length > 1 ? `<span class="n">×${units.length}</span>` : ""}</div>
        <div class="info">
          <div class="who">${u.type?.name ?? u.name ?? u.typeKey}</div>
          ${isStruct || !u.type?.foot ? `<div class="hpbar"><i></i></div>` : `<div class="pips"></div>`}
          <div class="chips"></div>
          <div class="sub">${isStruct ? (u.team === "player" ? t("Bâtiment") : t("Bâtiment ennemi")) : `${WEAPON[u.weapon ?? u.type?.weapon] ?? ""}${u.type?.speed ? ` · ${u.type.speed} m/s` : ""}`}</div>
        </div>
      </div>`;
    one = { units, pips: root.querySelector(".pips"), hpbar: root.querySelector(".hpbar i"), chips: root.querySelector(".chips") };
    lastPips = ""; lastChips = ""; lastHp = -1;
    tick();
  }

  function render(selected) {
    current = selected;
    one = null;
    if (!selected.length) { root.replaceChildren(); return; }
    const types = new Set(selected.map((u) => u.typeKey));
    if (types.size === 1) { renderOne(selected); return; }
    const groups = new Map();
    for (const u of selected) {
      const g = groups.get(u.typeKey) ?? { unit: u, count: 0 };
      g.count++;
      groups.set(u.typeKey, g);
    }
    const tiles = document.createElement("div");
    tiles.className = "tiles";
    for (const [key, g] of groups) {
      const tile = document.createElement("div");
      tile.className = "tile";
      const url = portrait(g.unit);
      if (url) tile.style.backgroundImage = `url(${url})`;
      tile.innerHTML = `<span class="name">${g.unit.type?.name ?? g.unit.name ?? key}</span>${g.count > 1 ? `<span class="count">${g.count}</span>` : ""}`;
      tile.title = t("Clic : seulement ce type · Double-clic : tous ceux de ce type");
      tile.addEventListener("click", () => onPickGroup(current.filter((u) => u.typeKey === key)));
      tile.addEventListener("dblclick", () => onSelectAllType(key));
      tiles.appendChild(tile);
    }
    root.replaceChildren(tiles);
  }

  /** Per frame: pips / health and the state chips, written on change only. */
  function tick() {
    if (!one) return;
    const live = one.units.filter((u) => u.alive);
    if (one.pips) {
      const fr = one.units.map((u) => (u.alive ? Math.max(0, Math.min(1, (u.hp ?? 0) / (u.maxHp ?? u.type?.maxHp ?? 1))) : 0));
      const sig = fr.map((f) => Math.round(f * 10)).join("");
      if (sig !== lastPips) {
        lastPips = sig;
        one.pips.innerHTML = fr.filter((f, i) => one.units[i].alive).map((f) => `<span class="pip"><i class="${f < 0.35 ? "low" : ""}" style="height:${Math.round(f * 100)}%"></i></span>`).join("");
      }
    } else if (one.hpbar) {
      const u = one.units[0], f = Math.max(0, Math.min(1, (u.hp ?? 0) / (u.maxHp ?? 1))), pct = Math.round(f * 100);
      if (pct !== lastHp) { lastHp = pct; one.hpbar.style.width = `${pct}%`; one.hpbar.classList.toggle("low", f < 0.3); }
    }
    // What they are doing, then where they stand (the cover map's thresholds).
    let chips = "";
    if (live.some((u) => u.pinned)) chips += `<span class="chip pinned">${t("CLOUÉS AU SOL")}</span>`;
    else if (live.some((u) => u.suppressed)) chips += `<span class="chip supp">${t("SOUS LE FEU")}</span>`;
    if (live.some((u) => u.target?.alive || u.attackTarget?.alive)) chips += `<span class="chip act">${t("FEU")}</span>`;
    else if (live.some((u) => u.isMoving)) chips += `<span class="chip act">${t("EN MOUVEMENT")}</span>`;
    if (!one.units[0].isStructure) {
      const st = stanceFor(live);
      if (st) {
        if (st.revealed) chips += `<span class="chip seen">${t("REPÉRÉS")}</span>`;
        else if (st.concealment >= 0.3) chips += `<span class="chip conceal">${t("CAMOUFLÉS")}</span>`;
        if (st.cover >= 0.35) chips += `<span class="chip cover">${t("COUVERTURE SOLIDE")}</span>`;
        else if (st.cover >= 0.12) chips += `<span class="chip cover">${t("COUVERTURE LÉGÈRE")}</span>`;
      }
    }
    if (chips !== lastChips) { lastChips = chips; one.chips.innerHTML = chips; }
  }

  render([]);
  return { root, render, tick, dispose() { root.remove(); style.remove(); } };
}
