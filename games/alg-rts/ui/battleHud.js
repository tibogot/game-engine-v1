// THE BATTLE ON SCREEN — what algBattle.js decides, shown the Company of
// Heroes way (you, 2026-10-01: "no enemies, what do I do with the village?"):
//
//   SCORE     top centre, small: the two victory-point counters, the villages
//             each side holds, and which way the score is draining.
//   VILLAGES  a marker over each village in the world: its name, its owner's
//             colour and the capture bar (who is winning it over, how far).
//   ALERTS    left, above the minimap: "contact", "a village is turning", "a
//             mine went up" — click one (or Space: the latest) to go there.
//   BRIEFING  at the start: what the fight is about, in six lines.
//   END       victory / defeat, why, and the numbers; keep watching or replay.
//
// Plain DOM in the HUD's own look (hudBar.js tokens); per frame it writes only
// what changed. The top of the screen otherwise stays empty (hudBar.js).
import { MINI } from "./hudBar.js";
import { rectOf } from "../../shared-rts/canvasRect.js";
import { iconSvg, pointIcon } from "./resourceIcons.js";
import { hasIcon, iconStyle } from "./icons.js";

const CSS = `
#alg-score {
  position: fixed; top: 8px; z-index: 56;
  left: calc((100vw - var(--alg-dev-w, 340px)) / 2); transform: translateX(-50%);
  display: flex; align-items: center; gap: 10px; padding: 4px 12px;
  background: var(--hud-bg); border: 1px solid var(--hud-edge-hi); border-radius: var(--hud-radius);
  font: 11px var(--hud-sans); color: var(--hud-text); white-space: nowrap;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35); pointer-events: none;
}
#alg-score .side { display: flex; align-items: center; gap: 6px; }
#alg-score .num { font: 700 15px var(--hud-mono); min-width: 34px; text-align: center; }
#alg-score .fr .num { color: #8fc8ff; }
#alg-score .aln .num { color: #ff8f80; }
#alg-score .bar { width: 90px; height: 6px; background: #23261d; border: 1px solid var(--hud-edge); position: relative; }
#alg-score .bar i { position: absolute; top: 0; bottom: 0; }
#alg-score .fr .bar i { right: 0; background: #5aaeff; }
#alg-score .aln .bar i { left: 0; background: #ff5f4e; }
#alg-score .mid { display: flex; flex-direction: column; align-items: center; gap: 1px; }
#alg-score .held { font: 600 12px var(--hud-mono); letter-spacing: 0.05em; }
#alg-score .held .f { color: #8fc8ff; } #alg-score .held .a { color: #ff8f80; }
#alg-score .drain { font-size: 9px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--hud-dim); }
#alg-score .drain.bad { color: var(--hud-red); } #alg-score .drain.good { color: var(--hud-olive); }

#alg-alerts {
  position: fixed; left: 8px; bottom: ${MINI + 12}px; z-index: 56;
  display: flex; flex-direction: column-reverse; gap: 4px; width: 290px;
  font: 12px var(--hud-sans);
}
#alg-alerts .al {
  pointer-events: auto; cursor: pointer; padding: 5px 9px 5px 8px;
  background: var(--hud-bg); border: 1px solid var(--hud-edge); border-left: 3px solid var(--hud-brass);
  border-radius: var(--hud-radius); color: var(--hud-text); line-height: 1.3;
  transition: opacity 0.6s; box-shadow: 0 3px 10px rgba(0, 0, 0, 0.3);
}
#alg-alerts .al:hover { border-color: var(--hud-brass); }
#alg-alerts .al.bad { border-left-color: var(--hud-red); }
#alg-alerts .al.good { border-left-color: #5aaeff; }
#alg-alerts .al .t { color: var(--hud-dim); font: 10px var(--hud-mono); margin-right: 6px; }
#alg-alerts .al.old { opacity: 0; }
#alg-alerts .al.has-ic { position: relative; padding-left: 30px; }
#alg-alerts .al .aic { position: absolute; left: 7px; top: 50%; width: 17px; height: 17px; transform: translateY(-50%); background: var(--hud-brass);
  -webkit-mask-size: contain; mask-size: contain; -webkit-mask-repeat: no-repeat; mask-repeat: no-repeat; }
#alg-alerts .al.bad .aic { background: #ff6a55; } #alg-alerts .al.good .aic { background: #5aaeff; }
#alg-alerts .al.tip { border-left-color: var(--hud-brass); background: #2a2614; border-color: #5c5126; color: #f1e6c4; }
#alg-alerts .al.tip::before { content: "CONSEIL  "; font: 700 9px var(--hud-sans); letter-spacing: 0.18em; color: var(--hud-brass); }

#alg-obj {
  position: fixed; left: 8px; top: 72px; z-index: 56; width: 300px;   /* under the dev stats strip */
  background: var(--hud-bg); border: 1px solid var(--hud-edge-hi); border-radius: var(--hud-radius);
  font: 12px var(--hud-sans); color: var(--hud-text); padding: 6px 10px 8px;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
}
#alg-obj .hd { font-size: 9px; letter-spacing: 0.22em; text-transform: uppercase; color: var(--hud-brass); margin-bottom: 4px; display: flex; justify-content: space-between; }
#alg-obj .hd span { color: var(--hud-dim); letter-spacing: 0.12em; }
#alg-obj .o { display: flex; gap: 7px; align-items: baseline; padding: 3px 0; line-height: 1.3; }
#alg-obj .o.go { cursor: pointer; }
#alg-obj .o.go:hover .t { color: #f1e6c4; }
#alg-obj .m { flex: none; width: 10px; height: 10px; border: 1px solid var(--hud-edge-hi); transform: translateY(1px); }
#alg-obj .o.done .m { background: var(--hud-olive); border-color: var(--hud-olive); }
#alg-obj .o.bad .m { background: var(--hud-red); border-color: var(--hud-red); }
#alg-obj .sub { color: var(--hud-dim); font-size: 11px; }
/* COLLAPSED (CoH audit 2, 2026-10-07: the HUD ate the left third of the map): the header and
   the objective at hand on one line; click the header for the list. */
#alg-obj .hd { cursor: pointer; user-select: none; }
#alg-obj .hd .l { font-style: normal; } #alg-obj .hd .tw { font-style: normal; color: var(--hud-dim); margin-right: 5px; letter-spacing: 0; }
#alg-obj.closed { width: auto; max-width: 300px; padding: 5px 10px 6px; }
#alg-obj.closed .o { display: none; }
#alg-obj.closed .o.now { display: flex; }
#alg-obj.closed .o.now .sub { display: none; }
#alg-obj.closed .hd { margin-bottom: 2px; }

.alg-vmark .flag, .alg-vmark .name { pointer-events: auto; cursor: help; }
#alg-vtip {
  position: fixed; z-index: 60; pointer-events: none; display: none; max-width: 260px;
  background: var(--hud-bg); border: 1px solid var(--hud-edge-hi); border-radius: var(--hud-radius);
  padding: 7px 10px; font: 12px/1.4 var(--hud-sans); color: var(--hud-text); box-shadow: 0 6px 18px rgba(0,0,0,0.45);
}
#alg-vtip b { color: #efe8d2; }
#alg-vtip .dim { color: var(--hud-dim); }
.alg-modal .levels { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; margin-bottom: 14px; }
.alg-modal .levels button { text-align: left; text-transform: none; letter-spacing: 0; padding: 9px 11px; }
.alg-modal .levels button b { display: block; letter-spacing: 0.08em; text-transform: uppercase; font-size: 12px; margin-bottom: 2px; }
.alg-modal .levels button span { font: 400 11px var(--hud-sans); color: var(--hud-dim); }
.alg-modal .levels button.sel { border-color: var(--hud-brass); background: #3a3417; }

.alg-vmark {
  position: fixed; left: 0; top: 0; z-index: 50; pointer-events: none;
  display: flex; flex-direction: column; align-items: center; gap: 2px;
  font: 600 11px var(--hud-sans); color: #efe8d2; text-shadow: 0 1px 2px #000, 0 0 6px rgba(0,0,0,0.6);
  will-change: transform;
}
/* THE POINT MARKER (2026-10-04, CoH): the point's icon (ui/resourceIcons.js — a star for a
   village, a jerrycan / cartridges for a supply point) in a dark disc, the CAPTURE RING round it
   filling toward whoever is winning it (blue France, red FLN); the icon in its holder's colour. */
.alg-vmark .flag { position: relative; width: 32px; height: 32px; }
.alg-vmark.supply .flag { width: 26px; height: 26px; }
.alg-vmark .flag svg.ring { position: absolute; inset: 0; width: 100%; height: 100%; transform: rotate(-90deg); overflow: visible; }
.alg-vmark .ring .bg { fill: rgba(14,16,12,0.82); stroke: rgba(239,232,210,0.35); stroke-width: 2; }
.alg-vmark .ring .pr { fill: none; stroke-width: 3.2; stroke-linecap: round; stroke-dasharray: 0 100; }
.alg-vmark .flag .ic { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: #e2d7b8; }
.alg-vmark.player .ic { color: #5aaeff; } .alg-vmark.enemy .ic { color: #ff5f4e; }
.alg-vmark.player .ring .bg { stroke: rgba(90,174,255,0.6); } .alg-vmark.enemy .ring .bg { stroke: rgba(255,95,78,0.6); }
/* Held, but cut off from the post: pays nothing. */
.alg-vmark.player.cut .ic { color: #e0a040; } .alg-vmark.player.cut .ring .bg { stroke: rgba(224,160,64,0.7); }
.alg-vmark.supply .name { font-size: 10px; opacity: 0.85; }

.alg-modal-back {
  position: fixed; inset: 0; z-index: 90; display: flex; align-items: center; justify-content: center;
  background: rgba(8, 9, 6, 0.55); padding: 16px;
}
.alg-modal {
  width: min(560px, 100%); max-height: calc(100vh - 32px); overflow: auto;
  background: var(--hud-bg); border: 1px solid var(--hud-edge-hi); border-radius: var(--hud-radius);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5); padding: 20px 24px; color: var(--hud-text);
  font: 13px/1.5 var(--hud-sans);
}
.alg-modal .kicker { font-size: 10px; letter-spacing: 0.24em; text-transform: uppercase; color: var(--hud-brass); }
.alg-modal h2 { margin: 4px 0 12px; font: 600 22px var(--hud-sans); letter-spacing: 0.02em; }
.alg-modal h2.win { color: #8fc8ff; } .alg-modal h2.lose { color: #ff8f80; }
.alg-modal ul { margin: 0 0 14px; padding-left: 18px; display: grid; gap: 6px; }
.alg-modal b { color: #efe8d2; }
.alg-modal .keys { font-size: 11px; color: var(--hud-dim); margin-bottom: 14px; }
.alg-modal .keys kbd { font: 11px var(--hud-mono); padding: 0 4px; border: 1px solid var(--hud-edge-hi); border-radius: 2px; color: var(--hud-text); }
.alg-modal .row { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
.alg-modal button {
  cursor: pointer; font: 600 12px var(--hud-sans); letter-spacing: 0.08em; text-transform: uppercase;
  padding: 8px 16px; border-radius: var(--hud-radius); color: var(--hud-text);
  background: #252920; border: 1px solid #454c3a;
}
.alg-modal button.go { background: #3a3417; border-color: var(--hud-brass); color: #f1dfa6; }
.alg-modal button:hover { border-color: var(--hud-brass); }
.alg-modal table { width: 100%; border-collapse: collapse; margin-bottom: 14px; font-variant-numeric: tabular-nums; }
.alg-modal td { padding: 3px 0; border-bottom: 1px solid var(--hud-edge); }
.alg-modal td + td { text-align: right; }
`;

const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/**
 * @param {object} o
 * @param {THREE.Camera} o.camera
 * @param {HTMLElement} o.canvas     the render canvas (marker projection)
 * @param {(x:number, z:number) => void} o.onJump   go there (the camera, the minimap ping)
 */
export function createBattleHud({ camera, canvas, onJump }) {
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);

  // ── Score ─────────────────────────────────────────────────────────────────
  const score = document.createElement("div");
  score.id = "alg-score";
  score.innerHTML = `
    <div class="side fr"><span class="hud-label">France</span><span class="num">500</span><span class="bar"><i></i></span></div>
    <div class="mid"><span class="held"><span class="f">0</span> · <span class="a">0</span></span><span class="drain">villages</span></div>
    <div class="side aln"><span class="bar"><i></i></span><span class="num">500</span><span class="hud-label">FLN</span></div>`;
  document.body.appendChild(score);
  const el = {
    frNum: score.querySelector(".fr .num"), frBar: score.querySelector(".fr .bar i"),
    alNum: score.querySelector(".aln .num"), alBar: score.querySelector(".aln .bar i"),
    heldF: score.querySelector(".held .f"), heldA: score.querySelector(".held .a"),
    drain: score.querySelector(".drain"),
  };
  let lastScore = "";
  function setScore({ fr, aln, max, heldFr, heldAln }) {
    const key = `${Math.ceil(fr)}|${Math.ceil(aln)}|${heldFr}|${heldAln}`;
    if (key === lastScore) return;
    lastScore = key;
    el.frNum.textContent = Math.ceil(fr);
    el.alNum.textContent = Math.ceil(aln);
    el.frBar.style.width = `${(100 * fr) / max}%`;
    el.alBar.style.width = `${(100 * aln) / max}%`;
    el.heldF.textContent = heldFr;
    el.heldA.textContent = heldAln;
    el.drain.className = `drain${heldFr < heldAln ? " bad" : heldFr > heldAln ? " good" : ""}`;
    el.drain.textContent = heldFr < heldAln ? "◀ vous perdez des points" : heldFr > heldAln ? "le FLN perd des points ▶" : "villages";
  }

  // ── Alerts ────────────────────────────────────────────────────────────────
  const feed = document.createElement("div");
  feed.id = "alg-alerts";
  document.body.appendChild(feed);
  const alerts = [];   // { node, x, z, t0 }
  let latest = null;
  function alert(text, { x, z, kind = "", time = 0, life = 10, icon = null } = {}) {
    const node = document.createElement("div");
    node.className = `al ${kind}${icon ? " has-ic" : ""}`;
    // CoH's alert pictures (ui/icons.js alert*), the kind's colour.
    const ic = icon && hasIcon(icon) ? `<span class="aic" style="${iconStyle(icon)}"></span>` : "";
    node.innerHTML = kind === "tip" ? text : `${ic}<span class="t">${fmtTime(time)}</span>${text}`;
    const a = { node, x, z, t0: performance.now(), life: life * 1000 };
    if (x != null) node.addEventListener("click", () => onJump(x, z));
    // Click a tip away.
    if (kind === "tip" && x == null) node.addEventListener("click", () => { a.life = 0; });
    feed.appendChild(node);
    alerts.push(a);
    if (x != null) latest = a;
    while (alerts.length > 4) alerts.shift().node.remove();   // (6 stacked up to the objectives)
  }
  function ageAlerts(now) {
    for (let i = alerts.length - 1; i >= 0; i--) {
      const a = alerts[i], age = now - a.t0;
      if (age > a.life) { a.node.remove(); alerts.splice(i, 1); } else if (age > a.life - 1000) a.node.classList.add("old");
    }
  }

  // ── Objectives (top left) ─────────────────────────────────────────────────
  const obj = document.createElement("div");
  obj.id = "alg-obj";
  document.body.appendChild(obj);
  let objKey = "";
  // Collapsed by default (one line), remembered.
  const OBJ_STORE = "algrts.objectives.open";
  let objOpen = false;
  try { objOpen = localStorage.getItem(OBJ_STORE) === "1"; } catch { /* private window */ }
  obj.classList.toggle("closed", !objOpen);
  /** [{ text, sub, state: ""|"done"|"bad", x, z }] — rewritten only when it changes. */
  function setObjectives(list, headRight = "") {
    const key = JSON.stringify([list, headRight]);
    if (key === objKey) return;
    objKey = key;
    // The objective at hand (shown when collapsed): the first one failing, else the first not done.
    const now = Math.max(0, list.findIndex((o) => o.state === "bad") >= 0 ? list.findIndex((o) => o.state === "bad") : list.findIndex((o) => o.state !== "done"));
    obj.innerHTML = `<div class="hd"><i class="l"><i class="tw">${objOpen ? "▾" : "▸"}</i>Objectifs</i><span>${headRight}</span></div>` + list.map((o, i) =>
      `<div class="o ${o.state ?? ""}${o.x != null ? " go" : ""}${i === now ? " now" : ""}" data-i="${i}"><div class="m"></div><div><div class="t">${o.text}</div>${o.sub ? `<div class="sub">${o.sub}</div>` : ""}</div></div>`).join("");
    obj.querySelector(".hd").addEventListener("click", () => {
      objOpen = !objOpen;
      try { localStorage.setItem(OBJ_STORE, objOpen ? "1" : "0"); } catch { /* ignore */ }
      obj.classList.toggle("closed", !objOpen);
      obj.querySelector(".hd .tw").textContent = objOpen ? "▾" : "▸";
    });
    obj.querySelectorAll(".o.go").forEach((n) => {
      const o = list[+n.dataset.i];
      n.addEventListener("click", () => onJump(o.x, o.z));
    });
  }

  // ── Village tooltip (hover a marker) ──────────────────────────────────────
  const vtip = document.createElement("div");
  vtip.id = "alg-vtip";
  document.body.appendChild(vtip);
  let hovered = null, tipFor = () => "", mouse = [0, 0];
  const onMove = (e) => { mouse = [e.clientX, e.clientY]; };
  window.addEventListener("pointermove", onMove);
  function tooltipTick() {
    if (!hovered) { vtip.style.display = "none"; return; }
    vtip.innerHTML = tipFor(hovered);
    vtip.style.display = "block";
    vtip.style.left = `${Math.min(mouse[0] + 16, innerWidth - 280)}px`;
    vtip.style.top = `${mouse[1] + 14}px`;
  }
  // Space: go to the latest alert (CoH). Not while typing in a field.
  const onKey = (e) => {
    if (e.key !== " " || e.repeat || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName ?? "")) return;
    if (!latest) return;
    e.preventDefault();
    onJump(latest.x, latest.z);
  };
  window.addEventListener("keydown", onKey);

  // ── Village markers ───────────────────────────────────────────────────────
  const marks = new Map();   // point → { node, cap, last }
  let pv = null;             // a scratch vector (the first point's type)
  function markers(points) {
    const r = rectOf(canvas);   // cached: a read per frame forced a layout (shared-rts/canvasRect.js)
    for (const p of points) {
      let m = marks.get(p);
      if (!m) {
        const node = document.createElement("div");
        node.className = "alg-vmark";
        const supply = p.kind === "supply";
        node.innerHTML = `<div class="flag"><svg class="ring" viewBox="0 0 36 36"><circle class="bg" cx="18" cy="18" r="15"/><circle class="pr" cx="18" cy="18" r="15" pathLength="100"/></svg>`
          + `<span class="ic">${iconSvg(pointIcon(p), { size: supply ? 14 : 17 })}</span></div><div class="name"></div>`;
        node.querySelector(".name").textContent = supply ? p.name.split(" · ")[0] : p.name;
        for (const el of node.querySelectorAll(".flag, .name")) {
          el.addEventListener("pointerenter", () => { hovered = p; });
          el.addEventListener("pointerleave", () => { if (hovered === p) hovered = null; });
        }
        document.body.appendChild(node);
        m = { node, ring: node.querySelector(".ring .pr"), last: "" };
        marks.set(p, m);
      }
      // 9 m over the village's centre, projected; hidden off screen or behind.
      pv = (pv ?? p.position.clone()).copy(p.position);
      pv.y += 9;
      pv.project(camera);
      const on = pv.z < 1 && Math.abs(pv.x) < 1.05 && Math.abs(pv.y) < 1.05;
      m.node.style.display = on ? "" : "none";
      if (!on) continue;
      const sx = r.left + (pv.x * 0.5 + 0.5) * r.width, sy = r.top + (-pv.y * 0.5 + 0.5) * r.height;
      m.node.style.transform = `translate(${sx.toFixed(0)}px, ${sy.toFixed(0)}px) translate(-50%, -100%)`;
      const v = p.progress ?? 0;
      const key = `${p.owner}|${v.toFixed(2)}|${p.linked}`;
      if (key === m.last) continue;
      m.last = key;
      m.node.className = `alg-vmark ${p.owner ?? ""}${p.kind === "supply" ? " supply" : ""}${p.owner === "player" && p.linked === false ? " cut" : ""}`;
      // The ring fills clockwise toward whoever is winning it: blue the French, red the FLN.
      m.ring.style.strokeDasharray = `${(Math.abs(v) * 100).toFixed(1)} 100`;
      m.ring.style.stroke = v >= 0 ? "#5aaeff" : "#ff5f4e";
    }
  }

  // ── Modals ────────────────────────────────────────────────────────────────
  function modal(html, buttons) {
    const back = document.createElement("div");
    back.className = "alg-modal-back";
    back.innerHTML = `<div class="alg-modal">${html}<div class="row"></div></div>`;
    const row = back.querySelector(".row");
    for (const b of buttons) {
      const btn = document.createElement("button");
      btn.textContent = b.label;
      if (b.go) btn.className = "go";
      btn.addEventListener("click", () => { back.remove(); b.onClick?.(); });
      row.appendChild(btn);
    }
    document.body.appendChild(back);
    back.querySelector("button.go")?.focus();
    return back;
  }

  return {
    setScore, alert, markers, setObjectives,
    /** The village tooltip's content: fn(point) → html. */
    setTooltip(fn) { tipFor = fn; },
    /** Every frame. */
    tick(now = performance.now()) { ageAlerts(now); tooltipTick(); },
    /**
     * The briefing, with the difficulty: `levels` [{ key, label, blurb }],
     * `current` the remembered one; onStart(key) when the player goes.
     */
    briefing(html, onStart, { levels = [], current = "normal" } = {}) {
      let pick = current;
      const back = modal(`${html}${levels.length ? `<div class="kicker">Difficulté</div><div class="levels">${levels.map((l) => `<button data-lv="${l.key}" class="${l.key === current ? "sel" : ""}"><b>${l.label}</b><span>${l.blurb}</span></button>`).join("")}</div>` : ""}`,
        [{ label: "À vos postes", go: true, onClick: () => onStart(pick) }]);
      back.querySelectorAll("[data-lv]").forEach((b) => b.addEventListener("click", () => {
        pick = b.dataset.lv;
        back.querySelectorAll("[data-lv]").forEach((o) => o.classList.toggle("sel", o === b));
      }));
      return back;
    },
    end(html, { onReplay }) {
      return modal(html, [{ label: "Continuer à regarder" }, { label: "Rejouer", go: true, onClick: onReplay }]);
    },
    dispose() {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointermove", onMove);
      score.remove(); feed.remove(); style.remove(); obj.remove(); vtip.remove();
      for (const m of marks.values()) m.node.remove();
    },
  };
}
