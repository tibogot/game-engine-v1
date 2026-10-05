// ── Horse lab: animation editor ──────────────────────────────────────────────
// Pose the mount / dismount by hand instead of by numbers. The performance is
// a set of keyed channels (mount.js CHANNELS) in the saddle frame:
//
//   points   pelvis, both feet, both hands — coloured handles in the scene;
//            click one and drag its arrows (the limbs follow by IK, live)
//   amounts  facing, lean, hands-on-targets, knee up / down, astride, look —
//            sliders in the panel
//   on/off   each foot in its iron
//
// A change at the playhead sets a key there (or moves the one already there).
// Timeline: click / drag to scrub, drag a ◆ to move it in time, double-click a
// row to add a key, Delete removes the selected one. Save writes
// v3/horse-lab/anims/<clip>.json (dev server), which the game then plays.
//
// Keys while open: Space play · ← → one frame (Shift ×6) · Home / End ·
// Enter key the selected channel · Delete · Ctrl+Z undo · K close.
import * as THREE from "three";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { CHANNELS, perfToData } from "./mount.js";

const V3 = THREE.Vector3;
const FPS = 60;
const ROW = 20, RULER = 22, LEFT = 300;

const CSS = `
#ae { position: fixed; left: 0; right: 0; bottom: 0; height: ${RULER + CHANNELS.length * ROW + 46}px; z-index: 40;
      background: rgba(14,18,23,0.95); border-top: 1px solid #34404c; color: #dfe6ea;
      font: 12px/1.2 system-ui, sans-serif; display: none; user-select: none; }
#ae .bar { height: 36px; display: flex; gap: 8px; align-items: center; padding: 0 10px; border-bottom: 1px solid #2a333d; }
#ae button, #ae select, #ae input[type=number] { background: #232c35; color: #e8eef2; border: 1px solid #3a4652; border-radius: 4px;
      padding: 3px 8px; font: inherit; }
#ae button:hover { background: #2e3945; }
#ae button.on { background: #3b6ea8; border-color: #5a8fd0; }
#ae .time { font-variant-numeric: tabular-nums; min-width: 110px; }
#ae .status { margin-left: auto; color: #9fb0bd; }
#ae .body { display: flex; height: calc(100% - 37px); }
#ae .rows { width: ${LEFT}px; padding-top: ${RULER}px; box-sizing: border-box; border-right: 1px solid #2a333d; }
#ae .row { height: ${ROW}px; display: flex; align-items: center; gap: 6px; padding: 0 8px; cursor: pointer; }
#ae .row.sel { background: #24364a; }
#ae .row .sw { width: 9px; height: 9px; border-radius: 50%; flex: none; }
#ae .row .nm { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#ae .row input[type=range] { width: 90px; }
#ae .row .val { width: 44px; text-align: right; font-variant-numeric: tabular-nums; color: #b8c6d0; }
#ae canvas { flex: 1; height: 100%; display: block; }
body.ae-open #controls, body.ae-open #stats, body.ae-open .lil-gui.root, body.ae-open .labgui, body.ae-open #state { display: none !important; }
`;

export class AnimEditor {
  constructor({ renderer, scene, camera, rider, ctrl, D }) {
    Object.assign(this, { renderer, scene, camera, rider, ctrl, D });
    this.ms = rider.mountSys;
    this.isOpen = false;
    this.clip = "mount";
    this.sel = "pelvis";
    this.selKey = null;          // the key array itself ([t, v])
    this.speed = 0.5;
    this.loop = true;
    this.undo = [];
    this.buildDom();
    this.buildScene();
  }

  // ── DOM ───────────────────────────────────────────────────────────────────
  buildDom() {
    const st = document.createElement("style"); st.textContent = CSS; document.head.appendChild(st);
    const el = this.el = document.createElement("div"); el.id = "ae";
    el.innerHTML = `
      <div class="bar">
        <b>Animation</b>
        <select data-k="clip"><option value="mount">get on (mount)</option><option value="dismount">get off (dismount)</option></select>
        <button data-k="play" title="Space">▶ play</button>
        <select data-k="speed"><option value="0.25">×0.25</option><option value="0.5" selected>×0.5</option><option value="1">×1</option></select>
        <button data-k="loop" class="on">loop</button>
        <span class="time"></span>
        length <input data-k="dur" type="number" step="0.1" min="0.5" max="10" style="width:56px">
        <button data-k="key" title="Enter">◆ key</button>
        <button data-k="del" title="Delete">delete key</button>
        <button data-k="undo" title="Ctrl+Z">undo</button>
        <button data-k="reset">reset to built-in</button>
        <button data-k="save">💾 save</button>
        <span class="status"></span>
        <button data-k="close" title="K">close</button>
      </div>
      <div class="body"><div class="rows"></div><canvas></canvas></div>`;
    document.body.appendChild(el);
    const q = (k) => el.querySelector(`[data-k=${k}]`);
    this.ui = { clip: q("clip"), play: q("play"), speed: q("speed"), loop: q("loop"), dur: q("dur"), time: el.querySelector(".time"), status: el.querySelector(".status") };
    this.ui.clip.onchange = () => this.open(this.ui.clip.value);
    this.ui.play.onclick = () => this.togglePlay();
    this.ui.speed.onchange = () => (this.speed = +this.ui.speed.value);
    this.ui.loop.onclick = () => { this.loop = !this.loop; this.ui.loop.classList.toggle("on", this.loop); };
    this.ui.dur.onchange = () => { this.pushUndo(); this.data.duration = THREE.MathUtils.clamp(+this.ui.dur.value, 0.5, 10); this.changed(); };
    q("key").onclick = () => this.keySelected();
    q("del").onclick = () => this.deleteKey();
    q("undo").onclick = () => this.doUndo();
    q("reset").onclick = () => this.resetToCode();
    q("save").onclick = () => this.save();
    q("close").onclick = () => this.close();
    // channel rows
    const rows = el.querySelector(".rows");
    this.rowEls = {};
    for (const c of CHANNELS) {
      const r = document.createElement("div"); r.className = "row";
      const col = c.color != null ? `#${c.color.toString(16).padStart(6, "0")}` : "transparent";
      r.innerHTML = `<span class="sw" style="background:${col};${c.color == null ? "border:1px solid #556" : ""}"></span><span class="nm">${c.label}</span>`;
      if (c.type === "num") {
        const s = document.createElement("input"); s.type = "range"; s.min = c.min; s.max = c.max; s.step = 0.01;
        const v = document.createElement("span"); v.className = "val";
        s.addEventListener("pointerdown", () => this.pushUndo());
        s.oninput = () => { this.setKey(c.name, this.t, +s.value); };
        r.append(s, v); r.slider = s; r.val = v;
      } else if (c.type === "step") {
        const b = document.createElement("input"); b.type = "checkbox";
        b.onchange = () => { this.pushUndo(); this.setKey(c.name, this.t, b.checked ? 1 : 0); };
        r.append(b); r.box = b;
      } else {
        const v = document.createElement("span"); v.className = "val"; v.style.width = "120px"; r.append(v); r.val = v;
      }
      r.onclick = (e) => { if (e.target.tagName !== "INPUT") this.select(c.name); };
      rows.appendChild(r); this.rowEls[c.name] = r;
    }
    // timeline
    const cv = this.cv = el.querySelector("canvas");
    let drag = null;
    const toT = (x) => THREE.MathUtils.clamp((x - 8) / (cv.clientWidth - 16) * this.data.duration, 0, this.data.duration);
    const toX = (t) => 8 + t / this.data.duration * (cv.clientWidth - 16);
    this.toX = toX;
    cv.addEventListener("pointerdown", (e) => {
      if (!this.data) return;
      const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      const row = Math.floor((y - RULER) / ROW), c = CHANNELS[row];
      cv.setPointerCapture(e.pointerId);
      if (c) {
        this.select(c.name);
        const key = this.data.channels[c.name].keys.find((kk) => Math.abs(toX(kk[0]) - x) < 6);
        if (key) { this.pushUndo(); this.selKey = key; drag = { key, c }; this.setT(key[0]); return; }
      }
      this.selKey = null;
      drag = { scrub: true }; this.playing = false; this.setT(toT(x));
    });
    cv.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const r = cv.getBoundingClientRect(), t = Math.round(toT(e.clientX - r.left) * FPS) / FPS;
      if (drag.scrub) this.setT(t);
      else { drag.key[0] = t; this.setT(t); this.changed(); }
    });
    cv.addEventListener("pointerup", () => { if (drag?.key) { this.sortKeys(drag.c.name); this.changed(); } drag = null; });
    cv.addEventListener("dblclick", (e) => {
      const r = cv.getBoundingClientRect(), row = Math.floor((e.clientY - r.top - RULER) / ROW), c = CHANNELS[row];
      if (!c) return;
      this.pushUndo();
      const t = Math.round(toT(e.clientX - r.left) * FPS) / FPS;
      this.setT(t);
      this.selKey = this.setKey(c.name, t, this.value(c.name));
    });
  }

  // ── scene: handles, gizmo, motion paths ───────────────────────────────────
  buildScene() {
    this.handles = {};
    this.paths = {};
    for (const c of CHANNELS) {
      if (c.type !== "vec") continue;
      const m = new THREE.Mesh(new THREE.SphereGeometry(0.045, 14, 10), new THREE.MeshBasicMaterial({ color: c.color, depthTest: false, transparent: true, opacity: 0.9 }));
      m.renderOrder = 998; m.visible = false; m.userData.chan = c.name;
      this.scene.add(m); this.handles[c.name] = m;
      const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(81 * 3), 3));
      const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color: c.color, depthTest: false, transparent: true, opacity: 0.55 }));
      l.renderOrder = 997; l.visible = false; l.frustumCulled = false;
      this.scene.add(l); this.paths[c.name] = l;
    }
    const tc = this.tc = new TransformControls(this.camera, this.renderer.domElement);
    tc.setMode("translate"); tc.setSize(0.7);
    this.scene.add(tc.getHelper());
    tc.addEventListener("dragging-changed", (e) => { this.D.gizmoDrag = e.value; if (e.value) { this.pushUndo(); this.playing = false; } });
    tc.addEventListener("objectChange", () => {
      const h = tc.object; if (!h) return;
      this.selKey = this.setKey(h.userData.chan, this.t, this.toLocal(h.position).toArray());
    });
    // click a handle to pick it
    const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
    this.renderer.domElement.addEventListener("pointerdown", (e) => {
      if (!this.isOpen || this.D.gizmoDrag || tc.axis) return;
      const r = this.renderer.domElement.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, this.camera);
      const hit = ray.intersectObjects(Object.values(this.handles), false)[0];
      if (hit) this.select(hit.object.userData.chan);
    });
  }

  // ── open / close ──────────────────────────────────────────────────────────
  open(clip = this.clip) {
    const ms = this.ms;
    this.clip = clip; this.ui.clip.value = clip;
    ms.side = 1;
    ms.mode = clip; ms.t = 0; ms.blend = null; ms.groundW = null; ms.ironW = null;
    if (ms.acts.idle && ms.cur !== ms.acts.idle) ms.play("idle", 0.01);
    ms.edit = { clip, t: 0, playing: false };
    this.rider.update(0, { lookYaw: 0, input: {} });    // builds the code performance (the starting data)
    this.data = ms.dataFor(clip);
    ms.animVer++;
    this.t = 0; this.playing = false; this.selKey = null;
    this.isOpen = true; this.D.editing = true;
    this.el.style.display = "block";
    document.body.classList.add("ae-open");
    for (const h of Object.values(this.handles)) h.visible = true;
    for (const l of Object.values(this.paths)) l.visible = true;
    if (document.pointerLockElement) document.exitPointerLock();
    this.select(this.sel);
    this.status(this.ms.savedFrom?.[clip] ? "" : "editing the built-in version — save to keep changes");
  }
  close() {
    if (!this.isOpen) return;
    this.isOpen = false; this.D.editing = false; this.D.gizmoDrag = false;
    this.ms.edit = null;                                    // the performance runs to its end (riding / on foot)
    this.tc.detach();
    this.el.style.display = "none";
    document.body.classList.remove("ae-open");
    this.camera.clearViewOffset();
    for (const h of Object.values(this.handles)) h.visible = false;
    for (const l of Object.values(this.paths)) l.visible = false;
  }
  toggle() { this.isOpen ? this.close() : this.open(); }

  // ── data helpers ──────────────────────────────────────────────────────────
  frameInfo() { const S = this.rider.saddle; S.updateMatrixWorld(true); return { S, s: this.ms.side }; }
  toWorld(v) { const { S, s } = this.frameInfo(); const p = Array.isArray(v) ? new V3(...v) : v.clone(); p.x *= s; return S.localToWorld(p); }
  toLocal(w) { const { S, s } = this.frameInfo(); const p = S.worldToLocal(w.clone()); p.x *= s; return p; }
  value(name) {
    const M = this.ms.M; if (!M) return 0;
    const v = M[name](this.t);
    return v?.isVector3 ? v.toArray() : v;
  }
  setKey(name, t, value) {
    const keys = this.data.channels[name].keys;
    const r = (x) => +(+x).toFixed(4);
    const val = Array.isArray(value) ? value.map(r) : r(value);
    let key = keys.find((kk) => Math.abs(kk[0] - t) < 0.5 / FPS);
    if (key) key[1] = val; else { key = [r(t), val]; keys.push(key); this.sortKeys(name); }
    this.changed();
    return key;
  }
  sortKeys(name) { this.data.channels[name].keys.sort((a, b) => a[0] - b[0]); }
  changed() { this.ms.animVer++; this.dirty = true; }
  keySelected() { this.pushUndo(); this.selKey = this.setKey(this.sel, this.t, this.value(this.sel)); }
  deleteKey() {
    if (!this.selKey) return this.status("select a ◆ first");
    for (const c of CHANNELS) {
      const keys = this.data.channels[c.name].keys, i = keys.indexOf(this.selKey);
      if (i < 0) continue;
      if (keys.length < 2) return this.status("a channel needs at least one key");
      this.pushUndo(); keys.splice(i, 1); this.selKey = null; this.changed(); return;
    }
  }
  pushUndo() { this.undo.push(JSON.stringify(this.data)); if (this.undo.length > 100) this.undo.shift(); }
  doUndo() {
    const s = this.undo.pop(); if (!s) return this.status("nothing to undo");
    const d = JSON.parse(s);
    this.data = this.ms.anims[this.clip] = d; this.selKey = null; this.changed();
  }
  resetToCode() {
    if (!this.ms.codePerf) return;
    this.pushUndo();
    this.data = this.ms.anims[this.clip] = perfToData(this.ms.codePerf[this.clip]);
    this.selKey = null; this.changed(); this.status("reset to the built-in version (not saved yet)");
  }
  async save() {
    const body = JSON.stringify(this.data);
    try {
      const r = await fetch(`/__horse-lab/anims?name=${this.clip}`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
      const j = await r.json();
      if (!j.ok) throw new Error("save failed");
      this.dirty = false; this.status(`saved → ${j.file}`);
    } catch (e) {
      // no dev endpoint (restart the dev server after a vite.config change): download instead
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([body], { type: "application/json" })); a.download = `${this.clip}.json`; a.click();
      this.status(`downloaded ${this.clip}.json (put it in v3/horse-lab/anims/) — ${e.message}`);
    }
  }
  status(msg) { this.ui.status.textContent = msg; clearTimeout(this._st); if (msg) this._st = setTimeout(() => (this.ui.status.textContent = ""), 6000); }

  select(name) {
    this.sel = name;
    for (const [n, r] of Object.entries(this.rowEls)) r.classList.toggle("sel", n === name);
    for (const [n, h] of Object.entries(this.handles)) h.scale.setScalar(n === name ? 1.5 : 1);
    if (this.handles[name]) this.tc.attach(this.handles[name]); else this.tc.detach();
  }
  setT(t) { this.t = THREE.MathUtils.clamp(t, 0, this.data.duration); }
  togglePlay() { this.playing = !this.playing; if (this.playing && this.t >= this.data.duration - 1e-3) this.t = 0; }

  // ── keys (the page passes keydown here first while open; true = consumed) ─
  onKey(e) {
    if (!this.isOpen) return false;
    if (e.target?.tagName === "INPUT" && e.target.type === "number") return true;
    const k = e.key;
    if (k === " ") { e.preventDefault(); this.togglePlay(); }
    else if (k === "ArrowLeft" || k === "ArrowRight") { e.preventDefault(); this.playing = false; this.setT(Math.round((this.t + (k === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 6 : 1) / FPS) * FPS) / FPS); }
    else if (k === "Home") this.setT(0);
    else if (k === "End") this.setT(this.data.duration);
    else if (k === "Enter") this.keySelected();
    else if (k === "Delete" || k === "Backspace") this.deleteKey();
    else if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === "z") { e.preventDefault(); this.doUndo(); }
    else if (k.toLowerCase() === "k") this.close();
    return true;                                            // the game ignores keys while editing
  }

  // ── per frame (before rider.update) ───────────────────────────────────────
  update(dt) {
    if (!this.isOpen) return;
    const ms = this.ms, dur = this.data.duration;
    this.ctrl.idleT = -1e9;                                 // the horse stands still (no head tosses)
    if (this.playing) {
      this.t += dt * this.speed;
      if (this.t > dur) { if (this.loop) { this.t = 0; ms.groundW = null; ms.ironW = null; } else { this.t = dur; this.playing = false; } }
    }
    ms.mode = this.clip;
    ms.edit = { clip: this.clip, t: this.t, playing: this.playing };
    this.ui.play.textContent = this.playing ? "❚❚ pause" : "▶ play";
    this.ui.time.textContent = `${this.t.toFixed(2)} / ${dur.toFixed(2)} s · f${Math.round(this.t * FPS)}`;
    if (document.activeElement !== this.ui.dur) this.ui.dur.value = dur.toFixed(2);
    // the scene centred in the space above the panel
    const W = innerWidth, Hh = innerHeight, ph = this.el.offsetHeight;
    this.camera.setViewOffset(W, Hh, 0, ph / 2, W, Hh);
  }
  // after rider.update: handles, paths, panel values, timeline
  afterUpdate() {
    if (!this.isOpen || !this.ms.M) return;
    const M = this.ms.M;
    for (const c of CHANNELS) {
      const r = this.rowEls[c.name], v = M[c.name](this.t);
      if (c.type === "vec") {
        r.val.textContent = v.toArray().map((x) => x.toFixed(2)).join(" ");
        const h = this.handles[c.name];
        if (!(this.D.gizmoDrag && this.tc.object === h)) h.position.copy(this.toWorld(v));
        const pa = this.paths[c.name].geometry.attributes.position;
        for (let i = 0; i <= 80; i++) { const w = this.toWorld(M[c.name]((i / 80) * M.duration)); pa.setXYZ(i, w.x, w.y, w.z); }
        pa.needsUpdate = true;
      } else if (c.type === "num") {
        if (document.activeElement !== r.slider) r.slider.value = v;
        r.val.textContent = (+v).toFixed(2);
      } else r.box.checked = v > 0.5;
    }
    this.drawTimeline();
  }

  drawTimeline() {
    const cv = this.cv, dpr = devicePixelRatio, W = cv.clientWidth, H = cv.clientHeight;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const g = cv.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const dur = this.data.duration, X = this.toX;
    // ruler
    g.fillStyle = "#1b2229"; g.fillRect(0, 0, W, RULER);
    g.font = "10px system-ui"; g.textBaseline = "middle";
    for (let t = 0; t <= dur + 1e-6; t += 0.1) {
      const x = X(t), major = Math.abs(t * 2 - Math.round(t * 2)) < 1e-6;
      g.strokeStyle = major ? "#4a5866" : "#2c3640"; g.beginPath(); g.moveTo(x, major ? 8 : 15); g.lineTo(x, H); g.stroke();
      if (major) { g.fillStyle = "#8fa0ad"; g.fillText(t.toFixed(1), x + 3, 8); }
    }
    // rows
    CHANNELS.forEach((c, i) => {
      const y = RULER + i * ROW;
      g.fillStyle = c.name === this.sel ? "rgba(59,110,168,0.18)" : i % 2 ? "rgba(255,255,255,0.02)" : "transparent";
      g.fillRect(0, y, W, ROW);
      const keys = this.data.channels[c.name].keys;
      // on/off: shade where the foot is in its iron
      if (c.type === "step") {
        g.fillStyle = "rgba(90,180,255,0.25)";
        for (let j = 0; j < keys.length; j++) if (keys[j][1] > 0.5) { const x0 = X(keys[j][0]), x1 = X(keys[j + 1]?.[0] ?? dur); g.fillRect(x0, y + 5, x1 - x0, ROW - 10); }
      }
      const col = c.color != null ? `#${c.color.toString(16).padStart(6, "0")}` : "#c9d4dc";
      for (const kk of keys) {
        const x = X(kk[0]), cy = y + ROW / 2, r = kk === this.selKey ? 7 : 5;
        g.beginPath(); g.moveTo(x, cy - r); g.lineTo(x + r, cy); g.lineTo(x, cy + r); g.lineTo(x - r, cy); g.closePath();
        g.fillStyle = kk === this.selKey ? "#fff" : col; g.fill();
        g.strokeStyle = "#0d1115"; g.stroke();
      }
    });
    // playhead
    const px = X(this.t);
    g.strokeStyle = "#ff4d4d"; g.lineWidth = 2; g.beginPath(); g.moveTo(px, 0); g.lineTo(px, H); g.stroke(); g.lineWidth = 1;
  }
}
