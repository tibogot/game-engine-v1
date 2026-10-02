// BUILD-QUEUE BADGES — over every one of your buildings that is training
// something, in the world (you, 2026-10-02, the HUD pass): the portrait of
// what is coming, its progress, how many more are queued. So the queue can be
// followed without keeping the building selected (CoH does the same).
//
// One small DOM badge per producing building, placed each frame by projecting
// a point over its roof; hidden when idle, off screen or behind the camera.
import * as THREE from "three";

const CSS = `
.alg-qb {
  position: fixed; left: 0; top: 0; z-index: 52; pointer-events: none; display: none;
  transform: translate(-50%, -100%); padding: 3px; gap: 4px; align-items: center;
  background: rgba(17, 19, 15, 0.92); border: 1px solid var(--hud-brass); border-radius: var(--hud-radius);
  box-shadow: 0 3px 10px rgba(0, 0, 0, 0.4); font: 700 10px var(--hud-mono); color: var(--hud-brass);
}
.alg-qb .p { width: 30px; height: 30px; background: #1b1e17 center 22%/cover no-repeat; position: relative; }
.alg-qb .p i { position: absolute; left: 1px; right: 1px; bottom: 1px; height: 3px; background: #23261d; }
.alg-qb .p i b { display: block; height: 100%; width: 0; background: var(--hud-brass); }
`;

export function createQueueBadges({ app, producers, thumbnails }) {
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
  const v = new THREE.Vector3();
  const badges = new Map();   // structure → { el, pic, bar, n, sig }

  function badgeOf(s) {
    let b = badges.get(s);
    if (b) return b;
    const el = document.createElement("div");
    el.className = "alg-qb";
    el.innerHTML = `<span class="p"><i><b></b></i></span><span class="n"></span>`;
    document.body.appendChild(el);
    b = { el, pic: el.querySelector(".p"), bar: el.querySelector("b"), n: el.querySelector(".n"), sig: "", shown: false };
    badges.set(s, b);
    return b;
  }

  return {
    /** Every frame. */
    frame() {
      const cam = app.camera, w = window.innerWidth, h = window.innerHeight;
      for (const p of producers) {
        const s = p.structure;
        if (!s || s.team !== "player") continue;
        const q = s.alive !== false ? s.queue ?? [] : [];
        const b = q.length ? badgeOf(s) : badges.get(s);
        if (!b) continue;
        let show = q.length > 0;
        if (show) {
          v.set(s.position.x, s.position.y + (s.barY ?? 10) + 7, s.position.z).project(cam);
          show = v.z < 1 && v.x > -1.1 && v.x < 1.1 && v.y > -1.1 && v.y < 1.1;
          if (show) b.el.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px) translate(-50%, -100%)`;
        }
        if (show !== b.shown) { b.shown = show; b.el.style.display = show ? "flex" : "none"; }
        if (!show) continue;
        const sig = q.join(",");
        if (sig !== b.sig) {
          b.sig = sig;
          b.pic.style.backgroundImage = `url(${thumbnails?.get(q[0]) ?? ""})`;
          b.n.textContent = q.length > 1 ? `+${q.length - 1}` : "";
          b.n.style.display = q.length > 1 ? "" : "none";
        }
        b.bar.style.width = `${Math.round((s.progress ?? 0) * 100)}%`;
      }
    },
    dispose() { for (const b of badges.values()) b.el.remove(); style.remove(); },
  };
}
