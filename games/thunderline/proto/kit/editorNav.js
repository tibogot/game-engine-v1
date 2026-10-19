// THE BUILDER'S CAMERA, for people who don't use 3D software (user, 2026-10-19: "a lot of users are
// not used to 3D softwares and they shouldn't get lost in a 3D space"). It behaves like the camera of a
// city builder or Trackmania's editor, the one players already know:
//   - it always looks at a point on the ground and orbits it; it never turns upside down, never goes
//     under the floor, never zooms absurdly far in or out
//   - W A S D (by key POSITION: Z Q S D on AZERTY) slide over the ground, faster when zoomed out,
//     Shift faster still; LEFT-DRAG on the ground drags the map (a click still places / selects)
//   - right-drag turns, the wheel zooms where the mouse points (as before)
//   - an on-screen panel for the mouse only: a compass (click = face north), turn 90° left / right,
//     zoom in / out, top view (V), go to the track's end (Home), frame everything (F)
// Every jump of the view is animated, so you always see where you went.
import * as THREE from "three";

const MIN_DIST = 12, MAX_DIST = 2600;
const MIN_POLAR = 0.12; // ~7° from straight down (top view)
const MAX_POLAR = 1.40; // ~10° above the horizon: never level with the floor, never under it
const PANEL_CSS = `
  #nav { position: fixed; right: 16px; bottom: 190px; z-index: 25; display: flex; flex-direction: column; align-items: center; gap: 6px; }
  #nav .cmp { width: 64px; height: 64px; border-radius: 50%; background: rgba(11,17,32,0.9); border: 1px solid #23304d; position: relative; cursor: pointer; }
  #nav .cmp:hover { border-color: #3fd2ff; }
  #nav .cmp .rose { position: absolute; inset: 0; transition: none; }
  #nav .cmp .rose b { position: absolute; left: 50%; transform: translateX(-50%); font: 800 13px "Barlow Condensed"; color: #8796b5; }
  #nav .cmp .rose b.n { top: 3px; color: #ff4d5e; } #nav .cmp .rose b.s { bottom: 3px; }
  #nav .cmp .rose i { position: absolute; left: 50%; top: 50%; width: 0; height: 0; border-left: 6px solid transparent; border-right: 6px solid transparent; border-bottom: 20px solid #ff4d5e; transform: translate(-50%, -100%); }
  #nav .row { display: flex; gap: 4px; }
  #nav button { width: 36px; height: 32px; background: rgba(11,17,32,0.9); color: #e8f0ff; border: 1px solid #23304d; cursor: pointer; font: 700 16px "Barlow Condensed"; padding: 0; }
  #nav button:hover { border-color: #3fd2ff; color: #3fd2ff; }
  #nav button.on { border-color: #3fd2ff; color: #3fd2ff; }
  #nav button.wide { width: 76px; font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em; }
`;

/**
 * @param o.camera, o.controls  the builder's camera and its OrbitControls
 * @param o.dom  the canvas (pointer events)
 * @param o.home  () => THREE.Vector3 | null — where "go to the end" goes (the open end)
 * @param o.frameAll  () => void
 * @param o.floorY  the floor height the camera stays above
 * @param o.enabled  () => boolean — false while a test drive runs
 */
export function createEditorNav({ camera, controls, dom, home, frameAll, floorY = 0, enabled = () => true }) {
  // ---------- the orbit's rules ----------
  controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
  controls.screenSpacePanning = false; // drags slide over the ground, never up into the sky
  controls.minPolarAngle = MIN_POLAR;
  controls.maxPolarAngle = MAX_POLAR;
  controls.minDistance = MIN_DIST;
  controls.maxDistance = MAX_DIST;
  controls.dampingFactor = 0.12;
  controls.zoomToCursor = true;

  // ---------- smooth moves: the view eases to a goal (target, azimuth, polar, distance) ----------
  const sph = new THREE.Spherical(), off = new THREE.Vector3();
  let goal = null; // { target?, az?, polar?, dist? }
  const read = () => { off.copy(camera.position).sub(controls.target); sph.setFromVector3(off); return sph; };
  const write = () => { off.setFromSpherical(sph); camera.position.copy(controls.target).add(off); camera.lookAt(controls.target); };
  function moveTo(g) {
    const s = read();
    goal = { target: g.target?.clone() ?? controls.target.clone(), az: g.az ?? s.theta, polar: g.polar ?? s.phi, dist: g.dist ?? s.radius };
    // turn the short way round
    while (goal.az - s.theta > Math.PI) goal.az -= 2 * Math.PI;
    while (goal.az - s.theta < -Math.PI) goal.az += 2 * Math.PI;
  }
  let topSaved = null; // the view before Top view, to come back to
  const api = {
    turn(deg) { moveTo({ az: read().theta + (deg * Math.PI) / 180 }); },
    north() { moveTo({ az: 0 }); },
    zoom(f) { moveTo({ dist: THREE.MathUtils.clamp(read().radius * f, MIN_DIST, MAX_DIST) }); },
    top() {
      const s = read();
      if (topSaved) { moveTo({ polar: topSaved.polar, dist: topSaved.dist }); topSaved = null; }
      else { topSaved = { polar: s.phi, dist: s.radius }; moveTo({ polar: MIN_POLAR, dist: Math.max(s.radius, 260) }); }
      btnTop.classList.toggle("on", !!topSaved);
    },
    goEnd() { const p = home(); if (p) moveTo({ target: p, dist: Math.min(read().radius, 220) }); },
    frame() { frameAll(); goal = null; },
    /** another part of the builder moved the view (frame all, the glide after placing): stop easing */
    cancel() { goal = null; },
  };

  // ---------- keys: by POSITION (e.code), so AZERTY's Z Q S D are the same keys as W A S D ----------
  const held = new Set();
  const MOVE = new Set(["KeyW", "KeyA", "KeyS", "KeyD"]);
  addEventListener("keydown", (e) => {
    if (!enabled() || e.ctrlKey || e.metaKey || e.altKey || e.target?.tagName === "INPUT" || e.target?.tagName === "SELECT") return;
    if (MOVE.has(e.code)) { held.add(e.code); goal = null; e.preventDefault(); return; }
    if (e.code === "KeyV") { api.top(); e.preventDefault(); }
    if (e.code === "Home") { api.goEnd(); e.preventDefault(); }
  });
  addEventListener("keyup", (e) => held.delete(e.code));
  addEventListener("blur", () => held.clear());
  dom.addEventListener("pointerdown", () => { goal = null; });
  dom.addEventListener("wheel", () => { goal = null; }, { passive: true });

  // ---------- the panel ----------
  const style = document.createElement("style");
  style.textContent = PANEL_CSS;
  document.head.appendChild(style);
  const panel = document.createElement("div");
  panel.id = "nav";
  panel.innerHTML = `
    <div class="cmp" title="Compass — click to face north"><div class="rose"><b class="n">N</b><b class="s">S</b><i></i></div></div>
    <div class="row"><button data-a="left" title="Turn the view 90° left">⟲</button><button data-a="right" title="Turn the view 90° right">⟳</button></div>
    <div class="row"><button data-a="in" title="Zoom in (wheel)">+</button><button data-a="out" title="Zoom out (wheel)">−</button></div>
    <button class="wide" data-a="top" title="Top view, like a map (V)">Top view</button>
    <button class="wide" data-a="end" title="Go to the end of the track (Home)">Go to end</button>
    <button class="wide" data-a="frame" title="See the whole track (F)">Frame all</button>`;
  document.body.appendChild(panel);
  const rose = panel.querySelector(".rose");
  const btnTop = panel.querySelector('[data-a="top"]');
  panel.querySelector(".cmp").onclick = () => api.north();
  for (const b of panel.querySelectorAll("button")) {
    b.onclick = () => ({ left: () => api.turn(90), right: () => api.turn(-90), in: () => api.zoom(0.6), out: () => api.zoom(1.6), top: api.top, end: api.goEnd, frame: api.frame })[b.dataset.a]();
  }

  // ---------- every frame ----------
  const fwd = new THREE.Vector3(), right = new THREE.Vector3(), step = new THREE.Vector3();
  api.update = (dt) => {
    // W A S D: slide over the ground, relative to where you look, faster when far
    if (held.size) {
      camera.getWorldDirection(fwd);
      fwd.y = 0;
      if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1).applyQuaternion(camera.quaternion).setY(0); // top view: "up" on the screen
      fwd.normalize();
      right.crossVectors(fwd, camera.up).normalize();
      step.set(0, 0, 0);
      if (held.has("KeyW")) step.add(fwd);
      if (held.has("KeyS")) step.sub(fwd);
      if (held.has("KeyD")) step.add(right);
      if (held.has("KeyA")) step.sub(right);
      if (step.lengthSq() > 0) {
        const speed = THREE.MathUtils.clamp(read().radius * 1.1, 25, 1800) * (held.has("ShiftLeft") || held.has("ShiftRight") || shift ? 2.5 : 1);
        step.normalize().multiplyScalar(speed * dt);
        controls.target.add(step);
        camera.position.add(step);
      }
    }
    // the eased moves (buttons, compass, top view, go to end)
    if (goal) {
      const s = read(), k = 1 - Math.exp(-dt * 7);
      controls.target.lerp(goal.target, k);
      s.theta += (goal.az - s.theta) * k;
      s.phi += (goal.polar - s.phi) * k;
      s.radius += (goal.dist - s.radius) * k;
      write();
      if (Math.abs(goal.az - s.theta) < 1e-3 && Math.abs(goal.polar - s.phi) < 1e-3 && Math.abs(goal.dist - s.radius) < 0.05 && controls.target.distanceTo(goal.target) < 0.05) goal = null;
    }
    // never under the floor (zooming to the cursor near the ground can dip it)
    if (camera.position.y < floorY + 3) { const d = floorY + 3 - camera.position.y; camera.position.y += d; }
    // the compass: north stays north on screen
    rose.style.transform = `rotate(${(read().theta * 180) / Math.PI}deg)`;
  };
  let shift = false;
  addEventListener("keydown", (e) => { if (e.key === "Shift") shift = true; });
  addEventListener("keyup", (e) => { if (e.key === "Shift") shift = false; });
  api.panel = panel;
  return api;
}
