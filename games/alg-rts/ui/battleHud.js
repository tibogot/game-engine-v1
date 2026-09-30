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
import { HUD_H, HUD_STRIP_H } from "./hudBar.js";

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
  position: fixed; left: 8px; bottom: ${HUD_H + HUD_STRIP_H + 14}px; z-index: 56;
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

.alg-vmark {
  position: fixed; left: 0; top: 0; z-index: 50; pointer-events: none;
  display: flex; flex-direction: column; align-items: center; gap: 2px;
  font: 600 11px var(--hud-sans); color: #efe8d2; text-shadow: 0 1px 2px #000, 0 0 6px rgba(0,0,0,0.6);
  will-change: transform;
}
.alg-vmark .flag { width: 14px; height: 14px; transform: rotate(45deg); border: 1.5px solid rgba(10,12,8,0.9); background: #e2d7b8; }
.alg-vmark.player .flag { background: #5aaeff; } .alg-vmark.enemy .flag { background: #ff5f4e; }
.alg-vmark .cap { width: 64px; height: 5px; background: rgba(20,22,16,0.85); border: 1px solid rgba(0,0,0,0.7); position: relative; }
.alg-vmark .cap i { position: absolute; top: 0; bottom: 0; }
.alg-vmark .cap::after { content: ""; position: absolute; left: 50%; top: -2px; bottom: -2px; width: 1px; background: rgba(239,232,210,0.6); }

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
    el.drain.textContent = heldFr < heldAln ? "◀ you are bleeding" : heldFr > heldAln ? "the FLN bleeds ▶" : "villages";
  }

  // ── Alerts ────────────────────────────────────────────────────────────────
  const feed = document.createElement("div");
  feed.id = "alg-alerts";
  document.body.appendChild(feed);
  const alerts = [];   // { node, x, z, t0 }
  let latest = null;
  function alert(text, { x, z, kind = "", time = 0 } = {}) {
    const node = document.createElement("div");
    node.className = `al ${kind}`;
    node.innerHTML = `<span class="t">${fmtTime(time)}</span>${text}`;
    const a = { node, x, z, t0: performance.now() };
    if (x != null) node.addEventListener("click", () => onJump(x, z));
    feed.appendChild(node);
    alerts.push(a);
    if (x != null) latest = a;
    while (alerts.length > 5) alerts.shift().node.remove();
  }
  function ageAlerts(now) {
    for (let i = alerts.length - 1; i >= 0; i--) {
      const a = alerts[i], age = now - a.t0;
      if (age > 14000) { a.node.remove(); alerts.splice(i, 1); } else if (age > 13000) a.node.classList.add("old");
    }
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
    const r = canvas.getBoundingClientRect();
    for (const p of points) {
      let m = marks.get(p);
      if (!m) {
        const node = document.createElement("div");
        node.className = "alg-vmark";
        node.innerHTML = `<div class="flag"></div><div class="name"></div><div class="cap"><i></i></div>`;
        node.querySelector(".name").textContent = p.name;
        document.body.appendChild(node);
        m = { node, cap: node.querySelector(".cap i"), last: "" };
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
      const key = `${p.owner}|${v.toFixed(2)}`;
      if (key === m.last) continue;
      m.last = key;
      m.node.className = `alg-vmark ${p.owner ?? ""}`;
      // The bar fills from the centre: right (blue) toward the French, left (red) toward the FLN.
      Object.assign(m.cap.style, v >= 0
        ? { left: "50%", right: "", width: `${v * 50}%`, background: "#5aaeff" }
        : { left: "", right: "50%", width: `${-v * 50}%`, background: "#ff5f4e" });
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
    setScore, alert, markers,
    /** Every frame. */
    tick(now = performance.now()) { ageAlerts(now); },
    briefing(html, onStart) { return modal(html, [{ label: "To your posts", go: true, onClick: onStart }]); },
    end(html, { onReplay }) {
      return modal(html, [{ label: "Keep watching" }, { label: "Play again", go: true, onClick: onReplay }]);
    },
    dispose() {
      window.removeEventListener("keydown", onKey);
      score.remove(); feed.remove(); style.remove();
      for (const m of marks.values()) m.node.remove();
    },
  };
}
