// THE ARMY TABS — every group you have, down the right edge, the Company of
// Heroes way (you, 2026-10-02: "the bottom UI could be better" → squad tabs
// + the card collapsing when nothing is selected).
//
// This game has no squads in code — a man is a unit — so a TAB is what you
// see as one on the map: every VEHICLE its own tab; the MEN of one type
// standing together (each within LINK m of another) one tab, which splits
// in two when they do. Each tab: the type's portrait, how many, their health
// together, what they are doing, and a red edge while they are under fire.
//   click        select them (shift: add them to the selection)
//   double-click the camera to them
//
// Cheap: grouped 4 times a second; the DOM is rebuilt only when the groups
// change, otherwise only a bar's width and a class are written.
import { thumbKeyOf } from "../../shared-rts/thumbnails.js";
import { HUD_H, HUD_STRIP_H } from "./hudBar.js";
import { iconStyle } from "./icons.js";

const LINK = 15;           // m: men closer than this to one of the group are in it
const EVERY = 0.25;        // s between regroupings
const MAX_TABS = 14;

const CSS = `
#alg-tabs {
  position: fixed; z-index: 55; right: calc(var(--alg-dev-w, 340px) + 8px); top: 56px;
  bottom: calc(var(--alg-hud-right-h, ${HUD_H}px) + ${HUD_STRIP_H + 52}px);
  display: flex; flex-direction: column; gap: 5px; overflow: hidden; pointer-events: none;
  transition: bottom 0.18s ease;
}
#alg-tabs .tab {
  pointer-events: auto; cursor: pointer; position: relative; flex: none;
  width: 62px; height: 58px; box-sizing: border-box;
  background: var(--hud-bg) center 22%/cover no-repeat; border: 1px solid var(--hud-edge-hi); border-radius: var(--hud-radius);
  box-shadow: 0 3px 10px rgba(0, 0, 0, 0.35);
}
#alg-tabs .tab:hover { border-color: var(--hud-brass); }
#alg-tabs .tab.sel { border-color: var(--hud-brass); box-shadow: 0 0 0 1px var(--hud-brass), 0 3px 10px rgba(0, 0, 0, 0.35); }
#alg-tabs .tab.fire { border-color: var(--hud-red); animation: alg-tab-fire 0.9s ease-in-out infinite alternate; }
@keyframes alg-tab-fire { to { box-shadow: 0 0 9px rgba(207, 94, 72, 0.75); } }
#alg-tabs .n {
  position: absolute; right: 3px; top: 2px; font: 700 11px var(--hud-mono); color: var(--hud-text);
  text-shadow: 0 1px 2px #000;
}
#alg-tabs .st {
  position: absolute; left: 3px; top: 2px; font: 700 9px var(--hud-sans); letter-spacing: 0.08em;
  padding: 0 3px; border-radius: 2px; background: rgba(10, 11, 8, 0.8); color: var(--hud-dim);
}
#alg-tabs .st.pinned { color: #ffb0a2; background: #6a2418; }
#alg-tabs .st.supp { color: #ffd59a; background: #5a3d12; }
#alg-tabs .st.fight { color: #f1e6c4; }
#alg-tabs .st.cover { color: #b8d08a; }
#alg-tabs .st.retreat { color: #fff; background: #7a5a18; }
#alg-tabs .n.short { color: #ffcf8a; }
/* The squad's veterancy, CoH's gold chevrons (ui/icons.js vet1-3) in the portrait's corner. */
#alg-tabs .vet { position: absolute; right: 3px; bottom: 10px; width: 15px; height: 13px; background: #f2c94c;
  -webkit-mask-size: contain; mask-size: contain; -webkit-mask-repeat: no-repeat; mask-repeat: no-repeat;
  -webkit-mask-position: center; mask-position: center; filter: drop-shadow(0 1px 1px #000); }
#alg-tabs .hp { position: absolute; left: 4px; right: 4px; bottom: 4px; height: 4px; background: #23261d; border: 1px solid #3a4031; }
#alg-tabs .hp i { display: block; height: 100%; background: var(--hud-olive); }
#alg-tabs .hp i.low { background: var(--hud-red); }
#alg-tabs .more { pointer-events: none; font: 10px var(--hud-sans); color: var(--hud-dim); text-align: center; width: 62px; }
`;

/** What a group is doing, most urgent first: [class, label, words]. */
function stateOf(g) {
  if (g.squad?.retreating) return ["retreat", "REPLI", "en repli"];
  if (g.some((u) => u.pinned)) return ["pinned", "CLOUÉ", "cloués au sol"];
  if (g.some((u) => u.suppressed)) return ["supp", "FEU!", "sous le feu"];
  if (g.some((u) => u.target?.alive || u.attackTarget?.alive)) return ["fight", "FEU", "font feu"];
  if (g.some((u) => u.isMoving)) return ["move", "»", "en mouvement"];
  if (g.some((u) => u.inCover)) return ["cover", "ABRI", "in cover"];
  return ["idle", "", "holding"];
}

export function createArmyTabs({ units, selection, thumbnails, focus = () => {}, team = "player", mount = document.body, squads = null }) {
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
  const root = document.createElement("div");
  root.id = "alg-tabs";
  mount.appendChild(root);

  let groups = [];      // [[unit…]]
  let sig = "";
  let views = [];       // per tab: { el, bar, st, hpLast, stLast, fireLast, selLast }
  let wait = 0;

  /**
   * SQUADS first (algSquads.js, 2026-10-03): one stable tab per squad, its
   * men alive and the dead slots counted (`g.squad`). Then vehicles alone;
   * men in no squad, of one type, linked within LINK m.
   */
  function regroup() {
    const out = [];
    const byType = new Map();
    for (const s of squads?.list ?? []) {
      if (s.team !== team) continue;
      const g = s.members;
      if (!g.length) continue;
      g.squad = s;
      out.push(g);
    }
    for (const u of units.list) {
      if (!u.alive || u.team !== team || u.isStructure || u.site) continue;
      if (squads?.of(u)) continue;
      if (!u.type?.foot) { out.push([u]); continue; }
      (byType.get(u.typeKey) ?? byType.set(u.typeKey, []).get(u.typeKey)).push(u);
    }
    for (const men of byType.values()) {
      const left = new Set(men);
      while (left.size) {
        const seed = left.values().next().value;
        left.delete(seed);
        const g = [seed];
        for (let i = 0; i < g.length; i++) {
          const a = g[i].position;
          for (const b of left) {
            if (Math.abs(b.position.x - a.x) < LINK && Math.abs(b.position.z - a.z) < LINK && Math.hypot(b.position.x - a.x, b.position.z - a.z) < LINK) { g.push(b); left.delete(b); }
          }
        }
        out.push(g);
      }
    }
    // A stable order: squads (by when they were raised), other infantry,
    // then vehicles; by type; by the oldest member.
    const rank = (g) => (g.squad ? 0 : g[0].type?.foot ? 1 : 2);
    const first = (g) => (g.squad ? g.squad.id : Math.min(...g.map((u) => units.list.indexOf(u))));
    out.sort((a, b) => rank(a) - rank(b) || (a.squad && b.squad ? a.squad.id - b.squad.id : 0) || a[0].typeKey.localeCompare(b[0].typeKey) || first(a) - first(b));
    return out;
  }

  function build() {
    root.replaceChildren();
    views = [];
    groups.slice(0, MAX_TABS).forEach((g) => {
      const u = g[0];
      const el = document.createElement("div");
      el.className = "tab";
      const url = thumbnails?.get(thumbKeyOf(u));
      if (url) el.style.backgroundImage = `url(${url})`;
      // A squad: men alive / its full strength (CoH's pips as a number).
      const n = g.squad ? `${g.length}/${g.squad.size}` : g.length > 1 ? `${g.length}` : "";
      el.innerHTML = `<span class="st"></span>${n ? `<span class="n${g.squad && g.length < g.squad.size ? " short" : ""}">${n}</span>` : ""}<span class="vet" hidden></span><div class="hp"><i></i></div>`;
      el.addEventListener("click", (e) => {
        const live = g.filter((m) => m.alive);
        if (!live.length) return;
        selection.select(e.shiftKey ? [...new Set([...(selection.selected ?? []), ...live])] : live);
      });
      el.addEventListener("dblclick", () => {
        const live = g.filter((m) => m.alive);
        if (live.length) focus(live.reduce((s, m) => s + m.position.x, 0) / live.length, live.reduce((s, m) => s + m.position.z, 0) / live.length);
      });
      root.appendChild(el);
      views.push({ el, g, bar: el.querySelector(".hp i"), st: el.querySelector(".st"), vet: el.querySelector(".vet"), vetLast: 0, hpLast: -1, stLast: null, fireLast: null, selLast: null });
    });
    if (groups.length > MAX_TABS) {
      const more = document.createElement("div");
      more.className = "more";
      more.textContent = `+${groups.length - MAX_TABS}`;
      root.appendChild(more);
    }
  }

  function refresh() {
    const sel = new Set(selection.selected ?? []);
    for (const v of views) {
      let hp = 0, max = 0, fire = false;
      for (const u of v.g) {
        max += u.maxHp ?? u.type?.maxHp ?? 1;
        if (u.alive) hp += Math.max(0, u.hp ?? 0);
        if (u.alive && (u.suppression ?? 0) > 0.12) fire = true;
      }
      const f = max > 0 ? hp / max : 0, pct = Math.round(f * 100);
      if (pct !== v.hpLast) { v.hpLast = pct; v.bar.style.width = `${pct}%`; v.bar.classList.toggle("low", f < 0.3); }
      const live = v.g.filter((u) => u.alive);
      live.squad = v.g.squad;
      const [cls, label, words] = stateOf(live);
      if (cls !== v.stLast) {
        v.stLast = cls;
        v.st.className = `st ${cls}`;
        v.st.textContent = label;
        v.st.style.display = label ? "" : "none";
      }
      const vet = Math.min(3, v.g.squad?.stars ?? v.g[0]?.stars ?? 0);   // a vehicle: its own (algVeterancy.js)
      if (vet !== v.vetLast) { v.vetLast = vet; v.vet.hidden = !vet; if (vet) v.vet.style.cssText = iconStyle(`vet${vet}`); }
      if (fire !== v.fireLast) { v.fireLast = fire; v.el.classList.toggle("fire", fire); }
      const isSel = v.g.some((u) => sel.has(u));
      if (isSel !== v.selLast) { v.selLast = isSel; v.el.classList.toggle("sel", isSel); }
      const name = v.g.squad?.name ?? v.g[0].type?.name ?? v.g[0].typeKey;
      const count = v.g.squad ? ` (${live.length}/${v.g.squad.size} hommes)` : v.g.length > 1 ? ` ×${v.g.length}` : "";
      v.el.title = `${name}${count} — ${words}, ${pct} % de santé\nClic : sélectionner · Maj : ajouter · Double-clic : y aller${v.g.squad ? " · T : retraite · Y : renforcer (au poste)" : ""}`;
    }
  }

  return {
    root,
    /** Every frame (real seconds); regroups 4 times a second. */
    tick(dt) {
      wait -= dt;
      if (wait > 0) return;
      wait = EVERY;
      groups = regroup();
      const s = groups.map((g) => g.map((u) => units.list.indexOf(u)).join(",")).join("|");
      if (s !== sig) { sig = s; build(); }
      refresh();
    },
    dispose() { root.remove(); style.remove(); },
  };
}
