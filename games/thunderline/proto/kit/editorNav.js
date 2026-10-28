// THE BUILDER'S CAMERA, for people who don't use 3D software (user, 2026-10-19: "a lot of users are
// not used to 3D softwares and they shouldn't get lost in a 3D space"). It behaves like the camera of a
// city builder or Trackmania's editor, the one players already know:
//   - it always looks at a point on the ground and orbits it; it never turns upside down, never goes
//     under the floor, never zooms absurdly far in or out
//   - W A S D (by key POSITION: Z Q S D on AZERTY) slide over the ground, faster when zoomed out,
//     Shift faster still; LEFT-DRAG grabs the ground: what you grab stays under the mouse (a click still
//     places / selects)
//   - right-drag turns round what you look at; the wheel zooms TO WHAT THE MOUSE POINTS AT (the piece or the ground under it: see
//     "the wheel" below)
//   - an on-screen panel for the mouse only: a compass (click = face north), turn 90° left / right,
//     zoom in / out, top view (V), go to the track's end (Home), frame everything (F)
// Every jump of the view is animated, so you always see where you went.
import * as THREE from "three";

// (12 → 2 m, user 2026-10-22: "I cannot zoom in as much as I would like" — close to place a pole or a pad)
const MIN_DIST = 2, MAX_DIST = 2600;
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
 * @param o.pick  (ndc: THREE.Vector2) => THREE.Vector3 | null — the point under the mouse (a piece, else the floor, else that way)
 */
export function createEditorNav({ camera, controls, dom, home, frameAll, floorY = 0, enabled = () => true, pick = null }) {
  // ---------- the orbit's rules ----------
  // (left-drag is ours when the builder can pick: "the drag" below; else three's pan)
  controls.mouseButtons = { LEFT: pick ? -1 : THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
  controls.screenSpacePanning = false; // drags slide over the ground, never up into the sky
  controls.minPolarAngle = MIN_POLAR;
  controls.maxPolarAngle = MAX_POLAR;
  controls.minDistance = 0.5; // (the wheel keeps its own limits: ZOOM_MIN from what you point at)
  controls.maxDistance = MAX_DIST;
  controls.dampingFactor = 0.12;
  controls.enableZoom = !pick; // the wheel is ours (below) when the builder can say what is under the mouse

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

  // ---------- THE WHEEL: zoom to what the mouse points at (user, 2026-10-28: "sometimes it feels like I can't
  // zoom more, or I can't zoom exactly where I want") ----------
  // three's zoom-to-cursor scaled the distance to the ORBIT CENTRE — a point in mid-air at the build height —
  // and stopped 2 m from it, wherever that left you (looking down at a piece below it: stuck far away); and it
  // aimed at the cursor on a plane through that centre, so what was really under the mouse slid away. Now each
  // step finds the REAL point under the mouse (a piece, else the floor) and scales the whole view about it —
  // camera and orbit centre together: that point stays exactly under the mouse, the zoom goes on until you are
  // ZOOM_MIN from it, and the orbit centre settles on it (right-drag then turns round what you zoomed to).
  // Eased over a few frames; wheel or trackpad, the same.
  const ZOOM_MIN = 1.2; // m from the point under the mouse
  const ndc = new THREE.Vector2(), toP = new THREE.Vector3(), toT = new THREE.Vector3();
  let zoomP = null, zoomLog = 0; // the point zoomed about, and the zoom still to do (log of the scale)
  if (pick) dom.addEventListener("wheel", (e) => {
    if (!enabled()) return;
    e.preventDefault();
    const r = dom.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    const P = pick(ndc);
    if (!P) return;
    zoomP = P;
    const px = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY; // lines / pages → px
    zoomLog += THREE.MathUtils.clamp(px, -300, 300) * 0.0016; // a wheel notch (100 px): ×0.85 or ×1.17
  }, { passive: false });
  // ---------- THE DRAG: the ground you grab stays under the mouse (2026-10-28) ----------
  // three's pan moved the view at the ORBIT CENTRE's depth: with the centre high above the ground you grabbed
  // (it sat at the build height, 120-190 m), the ground slid 44-93 px off the mouse over a 224 px drag —
  // slippery. Now: the point under the mouse at the press, and its height as the drag plane; every move puts
  // that point back under the mouse (camera and orbit centre slide together, never up or down). A press the
  // builder takes first (the gizmo, an obstacle dragged: they switch the orbit off) is not a drag of the view.
  let grab = null; // { y, P } while dragging the view
  const planeHit = (cx, cy, y, out) => {
    const r = dom.getBoundingClientRect();
    ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    gRay.setFromCamera(ndc, camera);
    const d = gRay.ray.direction, o = gRay.ray.origin;
    if (Math.abs(d.y) < 1e-4) return null;
    const t = (y - o.y) / d.y;
    return t > 0 ? out.copy(o).addScaledVector(d, t) : null;
  };
  const gRay = new THREE.Raycaster(), gHit = new THREE.Vector3(), gStep = new THREE.Vector3();
  if (pick) {
    dom.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || !enabled() || !controls.enabled) return;
      const r = dom.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      let P = pick(ndc);
      if (!P) return;
      // grabbing the far horizon: a pixel there is kilometres — drag at the orbit centre's distance instead
      const radius = camera.position.distanceTo(controls.target);
      if (camera.position.distanceTo(P) > 3 * radius + 200) {
        gRay.setFromCamera(ndc, camera);
        P = gRay.ray.origin.clone().addScaledVector(gRay.ray.direction, radius);
      }
      grab = { y: P.y, P };
    });
    dom.addEventListener("pointermove", (e) => {
      if (!grab || !(e.buttons & 1) || !controls.enabled) { if (grab && !(e.buttons & 1)) grab = null; return; }
      if (!planeHit(e.clientX, e.clientY, grab.y, gHit)) return;
      gStep.copy(grab.P).sub(gHit);
      gStep.y = 0;
      camera.position.add(gStep);
      controls.target.add(gStep);
    });
    addEventListener("pointerup", () => { grab = null; });
    // THE TURN (right-drag) turns round WHAT YOU LOOK AT: at the press, the orbit centre drops along the line of
    // sight onto the first piece or the ground there (it can float far above it, at the build height or where a
    // drag left it: the view then swung round a point in mid-air). On that same line, so the view does not jump.
    dom.addEventListener("pointerdown", (e) => {
      if (e.button !== 2 || !enabled() || !controls.enabled) return;
      const q = gHit.copy(controls.target).project(camera);
      const P = pick(ndc.set(q.x, q.y));
      if (P && camera.position.distanceTo(P) > ZOOM_MIN) controls.target.copy(P);
    }, { capture: true }); // (before three's own handler starts the turn from the old centre)
  }
  function stepZoom(dt) {
    if (!zoomP || Math.abs(zoomLog) < 1e-4) { zoomLog = 0; return; }
    const part = zoomLog * (1 - Math.exp(-dt * 16));
    let k = Math.exp(part);
    // the limits: no closer than ZOOM_MIN to the point, no further than MAX_DIST from the orbit centre
    const dP = toP.copy(camera.position).sub(zoomP).length();
    if (k < 1 && dP * k < ZOOM_MIN) k = Math.min(1, ZOOM_MIN / Math.max(dP, 1e-6));
    const dT = toT.copy(camera.position).sub(controls.target).length();
    if (k > 1 && dT * k > MAX_DIST) k = Math.max(1, MAX_DIST / Math.max(dT, 1e-6));
    if (k === 1) { zoomLog = 0; return; } // at a limit: the rest of the scroll is dropped, not stored
    zoomLog -= part;
    camera.position.sub(zoomP).multiplyScalar(k).add(zoomP);
    controls.target.sub(zoomP).multiplyScalar(k).add(zoomP);
  }

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
    stepZoom(dt);
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
    // never under the floor (zooming to the cursor near the ground can dip it); 0.8 m, was 3 (close to the
    // ground to place a cone, the 3 m stop read as "I can't zoom more")
    if (camera.position.y < floorY + 0.8) camera.position.y = floorY + 0.8;
    // the compass: north stays north on screen
    rose.style.transform = `rotate(${(read().theta * 180) / Math.PI}deg)`;
  };
  let shift = false;
  addEventListener("keydown", (e) => { if (e.key === "Shift") shift = true; });
  addEventListener("keyup", (e) => { if (e.key === "Shift") shift = false; });
  api.panel = panel;
  api.pickAt = pick; // (test hook: what the wheel would zoom to)
  return api;
}
