// ── Horse lab: the bow's timeline editor (U) ─────────────────────────────────
// The arrow fetch as keyed channels (bow.js FETCH_CHANNELS) on a timeline, so a
// frame can be pointed at and changed:
//
//   right hand   green handle — drag its arrows (the arm follows by IK, with
//                the same limits as the game: wrist, forearm roll, no locked elbow)
//   elbow        orange handle — the direction the elbow points, from the shoulder
//   amounts      forearm roll, fingers (open · pinch · hook), wrist, head — sliders
//   phases       reach · close · pull · bring · nock — drag a border to retime
//                (the keys inside stretch with it)
//   notes        a comment on a frame ("f84: the hand goes through the hat")
//   checks       every frame measured (wrist, elbow, roll jumps, hand
//                acceleration, the arrow through the hand / head / chest) — red
//                ticks on the ruler, the reason under the playhead
//
// "after a shot" plays the fetch from the follow-through (the usual one, shooting
// again); "from rest" from the bow lowered — the …Low channels are its start.
// A frame always shows the same pose: the fetch is replayed from its start at
// 1/60 s (the elbow and the roll are rate-limited, so a pose depends on the path).
// Save writes v3/horse-lab/anims/bow-fetch.json, which the game then plays (Bow ▸ keyed).
//
// Keys while open: Space play · ← → one frame (Shift ×6) · Home / End ·
// Enter key the selected channel · Delete · Ctrl+Z undo · U close.
import * as THREE from "three";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { BP, FETCH_CHANNELS, keyAt } from "./bow.js";
import { loadMixamoRef } from "./mixamoRef.js";
import { bakeMixamoOnto, bakedToJSON, bakedFromJSON } from "./retarget.js";

// the Mixamo reference (v3/horse-lab/refs, kept out of git) and its phases, measured
// at 30 fps: reach · grab · pull · bring (the bow comes up, the torso turns to it) ·
// nock (the torso leans over it); the draw follows to 2.75 s
const MIX_URL = "/v3/horse-lab/refs/Shooting%20Arrow.fbx";
const MIX_PHASES = { reach: [0, 0.83], close: [0.83, 0.93], pull: [0.93, 1.1], bring: [1.1, 1.43], nock: [1.43, 1.95] };

const V3 = THREE.Vector3, clamp = THREE.MathUtils.clamp;
const FPS = 60, DT = 1 / FPS;
const ROW = 18, RULER = 22, BAND = 20, NOTES = 20, LEFT = 330;
const PHASES = ["reach", "close", "pull", "bring", "nock"];
const PHASE_COL = { reach: "#35506a", close: "#5a4a2a", pull: "#3c5a36", bring: "#4f3a5a", nock: "#5a3838" };
const TOL = { bowReady: 0.02, turn: 0.5, lean: 0.5, hand: 0.004, handLow: 0.004, elbow: 0.03, elbowLow: 0.03, roll: 1, fingers: 0.02, wristNocks: 0.02, wristString: 0.02, look: 0.01, headDown: 0.01 };
const hex = (c) => `#${c.toString(16).padStart(6, "0")}`;
const mj = (x) => { x = Math.min(1, Math.max(0, x)); return x * x * x * (10 - 15 * x + 6 * x * x); };

const CSS = `
#be { position: fixed; left: 0; right: 0; bottom: 0; height: ${72 + RULER + BAND + FETCH_CHANNELS.length * ROW + NOTES + 6}px; z-index: 40;
      background: rgba(14,18,23,0.95); border-top: 1px solid #34404c; color: #dfe6ea;
      font: 12px/1.2 system-ui, sans-serif; display: none; user-select: none; }
#be .bar { height: 35px; display: flex; gap: 8px; align-items: center; padding: 0 10px; border-bottom: 1px solid #2a333d; white-space: nowrap; }
#be button, #be select, #be input[type=text] { background: #232c35; color: #e8eef2; border: 1px solid #3a4652; border-radius: 4px; padding: 3px 8px; font: inherit; }
#be button:hover { background: #2e3945; }
#be button.on { background: #3b6ea8; border-color: #5a8fd0; }
#be .time { font-variant-numeric: tabular-nums; min-width: 150px; }
#be .status { margin-left: auto; color: #9fb0bd; overflow: hidden; text-overflow: ellipsis; }
#be .info { color: #ffb4a8; overflow: hidden; text-overflow: ellipsis; flex: 1; }
#be .body { display: flex; height: calc(100% - 72px); }
#be .rows { width: ${LEFT}px; padding-top: ${RULER + BAND}px; box-sizing: border-box; border-right: 1px solid #2a333d; flex: none; }
#be .row { height: ${ROW}px; display: flex; align-items: center; gap: 6px; padding: 0 8px; cursor: pointer; }
#be .row.sel { background: #24364a; }
#be .row.dim { opacity: 0.45; }
#be .row .sw { width: 9px; height: 9px; border-radius: 50%; flex: none; }
#be .row .nm { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#be .row input[type=range] { width: 90px; }
#be .row .val { width: 44px; text-align: right; font-variant-numeric: tabular-nums; color: #b8c6d0; }
#be canvas { flex: 1; height: 100%; display: block; min-width: 0; }
body.be-open #controls, body.be-open #stats, body.be-open .lil-gui.root, body.be-open .labgui, body.be-open #state { display: none !important; }
`;

export class BowEditor {
  constructor({ renderer, scene, camera, rider, archer, D, camState }) {
    Object.assign(this, { renderer, scene, camera, rider, archer, D, camState });
    this.isOpen = false;
    this.sel = "hand"; this.selKey = null; this.selNote = null;
    this.speed = 0.5; this.loop = true; this.fromHold = false;
    this.t = 0; this.undo = []; this.flags = [];
    this.buildDom();
    this.buildScene();
  }

  // ── DOM ───────────────────────────────────────────────────────────────────
  buildDom() {
    const st = document.createElement("style"); st.textContent = CSS; document.head.appendChild(st);
    const el = this.el = document.createElement("div"); el.id = "be";
    el.innerHTML = `
      <div class="bar">
        <b>Bow — arrow fetch</b>
        <select data-k="start" title="where the fetch starts from"><option value="rest">from rest (bow down)</option><option value="hold">after a shot (follow-through)</option></select>
        <button data-k="play" title="Space">▶ play</button>
        <select data-k="speed"><option value="1">×1</option><option value="0.5" selected>×0.5</option><option value="0.25">×0.25</option><option value="0.1">×0.1</option></select>
        <button data-k="loop" class="on">loop</button>
        <span class="time"></span>
        <button data-k="key" title="Enter">◆ key</button>
        <button data-k="del" title="Delete">delete</button>
        <button data-k="undo" title="Ctrl+Z">undo</button>
        <button data-k="rebuild" title="the keys again from the coded fetch">rebuild from code</button>
        <button data-k="mixamo" title="the keys from the Mixamo clip (refs/Shooting Arrow.fbx): its hand, elbow, roll, torso and timing">from Mixamo</button>
        <label title="the Mixamo figure beside the robot, at the same time"><input data-k="ghost" type="checkbox"> show Mixamo</label>
        <button data-k="bakeBase" title="the Mixamo clip retargeted onto the robot's whole body (collarbones, spine, hips, legs, head) — saved as anims/bow-shot-mocap.json; the IK then only corrects">bake Mixamo body</button>
        <button data-k="check" title="measure every frame">check frames</button>
        <label title="the game plays these keys (off: the coded fetch)"><input data-k="keyed" type="checkbox"> game plays keys</label>
        <button data-k="save">💾 save</button>
        <span class="status"></span>
        <button data-k="close" title="U">close</button>
      </div>
      <div class="bar">
        <b>Note</b>
        <input data-k="note" type="text" placeholder="what should happen at this frame…" style="width:380px">
        <button data-k="addNote">add at playhead</button>
        <span class="info"></span>
      </div>
      <div class="body"><div class="rows"></div><canvas></canvas></div>`;
    document.body.appendChild(el);
    const q = (k) => el.querySelector(`[data-k=${k}]`);
    this.ui = { start: q("start"), play: q("play"), speed: q("speed"), loop: q("loop"), keyed: q("keyed"), note: q("note"), time: el.querySelector(".time"), status: el.querySelector(".status"), info: el.querySelector(".info") };
    this.ui.start.onchange = () => { this.fromHold = this.ui.start.value === "hold"; this.dirty = true; this.select(this.sel); this.runChecksSoon(); };
    this.ui.play.onclick = () => this.togglePlay();
    this.ui.speed.onchange = () => (this.speed = +this.ui.speed.value);
    this.ui.loop.onclick = () => { this.loop = !this.loop; this.ui.loop.classList.toggle("on", this.loop); };
    this.ui.keyed.onchange = () => (BP.keyed = this.ui.keyed.checked);
    q("key").onclick = () => this.keySelected();
    q("del").onclick = () => this.deleteSel();
    q("undo").onclick = () => this.doUndo();
    q("rebuild").onclick = () => { this.pushUndo(); this.archer.anim = this.data = this.bake(); this.changed(); this.status("rebuilt from the coded fetch (not saved yet)"); };
    q("check").onclick = () => this.runChecks(true);
    q("mixamo").onclick = () => this.fromMixamo();
    q("bakeBase").onclick = () => this.bakeBase();
    this.ui.ghost = q("ghost"); this.ui.ghost.onchange = () => this.showGhost(this.ui.ghost.checked);
    q("save").onclick = () => this.save();
    q("close").onclick = () => this.close();
    q("addNote").onclick = () => this.addNote();
    this.ui.note.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") this.addNote(); });
    this.ui.note.addEventListener("input", () => { if (this.selNote) { this.selNote[1] = this.ui.note.value; this.unsaved = true; } });
    // channel rows
    const rows = el.querySelector(".rows");
    this.rowEls = {};
    for (const c of FETCH_CHANNELS) {
      const r = document.createElement("div"); r.className = "row";
      r.innerHTML = `<span class="sw" style="background:${c.color != null ? hex(c.color) : "transparent"};${c.color == null ? "border:1px solid #556" : ""}"></span><span class="nm" title="${c.label}">${c.label}</span>`;
      if (c.type === "num") {
        const s = document.createElement("input"); s.type = "range"; s.min = c.min; s.max = c.max; s.step = (c.max - c.min) / 400;
        const v = document.createElement("span"); v.className = "val";
        s.addEventListener("pointerdown", () => { this.pushUndo(); this.playing = false; });
        s.oninput = () => { this.selKey = this.setKey(c.name, this.t, +s.value); };
        s.addEventListener("change", () => this.runChecksSoon());
        r.append(s, v); r.slider = s; r.val = v;
      } else { const v = document.createElement("span"); v.className = "val"; v.style.width = "118px"; r.append(v); r.val = v; }
      r.onclick = (e) => { if (e.target.tagName !== "INPUT") this.select(c.name); };
      rows.appendChild(r); this.rowEls[c.name] = r;
    }
    // timeline
    const cv = this.cv = el.querySelector("canvas");
    const toT = (x) => THREE.MathUtils.clamp((x - 8) / (cv.clientWidth - 16) * this.dur(), 0, this.dur());
    const toX = (t) => 8 + t / this.dur() * (cv.clientWidth - 16);
    this.toX = toX;
    const snap = (t) => Math.round(t * FPS) / FPS;
    let drag = null;
    const at = (e) => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    cv.addEventListener("pointerdown", (e) => {
      if (!this.data) return;
      const { x, y } = at(e);
      cv.setPointerCapture(e.pointerId);
      this.playing = false;
      // the phase band: a border to drag
      if (y >= RULER && y < RULER + BAND) {
        const P = this.data.phases, bi = PHASES.findIndex((n) => Math.abs(toX(P[n][1]) - x) < 6);
        if (bi >= 0) { this.pushUndo(); drag = { border: PHASES[bi] }; return; }
      }
      // a key row
      const row = Math.floor((y - RULER - BAND) / ROW), c = y >= RULER + BAND ? FETCH_CHANNELS[row] : null;
      if (c) {
        this.select(c.name);
        const key = this.data.channels[c.name].keys.find((kk) => Math.abs(toX(kk[0]) - x) < 6);
        if (key) { this.pushUndo(); this.selKey = key; this.selNote = null; drag = { key, c }; this.setT(key[0]); return; }
      }
      // the notes row
      if (y >= RULER + BAND + FETCH_CHANNELS.length * ROW) {
        const n = this.data.notes.find((nn) => Math.abs(toX(nn[0]) - x) < 7);
        if (n) { this.pushUndo(); this.selNote = n; this.selKey = null; this.ui.note.value = n[1]; drag = { note: n }; this.setT(n[0]); return; }
      }
      this.selKey = null; this.selNote = null;
      drag = { scrub: true }; this.setT(snap(toT(x)));
    });
    cv.addEventListener("pointermove", (e) => {
      const { x, y } = at(e);
      if (!drag) {
        const P = this.data?.phases, onBorder = P && y >= RULER && y < RULER + BAND && PHASES.some((n) => Math.abs(toX(P[n][1]) - x) < 6);
        cv.style.cursor = onBorder ? "ew-resize" : "default";
        return;
      }
      const t = snap(toT(x));
      if (drag.scrub) this.setT(t);
      else if (drag.key) { drag.key[0] = t; this.setT(t); this.changed(); }
      else if (drag.note) { drag.note[0] = t; this.setT(t); this.unsaved = true; }
      else if (drag.border) this.moveBorder(drag.border, Math.max(t, 0.2));
    });
    cv.addEventListener("pointerup", () => {
      if (drag?.key) { this.sortKeys(drag.c.name); this.changed(); this.runChecksSoon(); }
      if (drag?.border) { this.changed(); this.runChecksSoon(); }
      drag = null;
    });
    cv.addEventListener("dblclick", (e) => {
      const { x, y } = at(e), row = Math.floor((y - RULER - BAND) / ROW), c = FETCH_CHANNELS[row];
      if (!c || y < RULER + BAND) return;
      this.pushUndo();
      const t = snap(toT(x)); this.setT(t);
      this.selKey = this.setKey(c.name, t, this.value(c.name));
    });
  }

  // ── scene: handles, the hand's path ───────────────────────────────────────
  buildScene() {
    const ball = (r, col) => { const m = new THREE.Mesh(new THREE.SphereGeometry(r, 14, 10), new THREE.MeshBasicMaterial({ color: col, depthTest: false, transparent: true, opacity: 0.9 })); m.renderOrder = 998; m.visible = false; this.scene.add(m); return m; };
    this.hHand = ball(0.03, 0x4fd06a); this.hHand.userData.chan = "hand";
    this.hElbow = ball(0.03, 0xf0b030); this.hElbow.userData.chan = "elbow";
    this.dotReal = ball(0.012, 0xffffff);                    // where the fingers really are (the IK's result)
    const line = (n, col, op) => { const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3)); const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color: col, depthTest: false, transparent: true, opacity: op })); l.renderOrder = 997; l.visible = false; l.frustumCulled = false; this.scene.add(l); return l; };
    this.path = line(121, 0x4fd06a, 0.6);
    this.elbowLine = line(2, 0xf0b030, 0.8);
    const tc = this.tc = new TransformControls(this.camera, this.renderer.domElement);
    tc.setMode("translate"); tc.setSize(0.6);
    this.scene.add(tc.getHelper());
    tc.addEventListener("dragging-changed", (e) => { this.D.gizmoDrag = e.value; if (e.value) { this.pushUndo(); this.playing = false; } else this.runChecksSoon(); });
    tc.addEventListener("objectChange", () => {
      const h = tc.object; if (!h || !this.frame) return;
      const F = this.frame, d = h.position.clone().sub(F.SR);
      const loc = [d.dot(F.Rt), d.dot(F.cu), d.dot(F.cf)];
      if (h === this.hHand) this.selKey = this.setKey(this.activeChan("hand"), this.t, loc);
      else { const n = Math.hypot(...loc) || 1; this.selKey = this.setKey(this.activeChan("elbow"), this.t, loc.map((x) => x / n)); }
    });
    const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
    this.renderer.domElement.addEventListener("pointerdown", (e) => {
      if (!this.isOpen || this.D.gizmoDrag || tc.axis) return;
      const r = this.renderer.domElement.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, this.camera);
      const hit = ray.intersectObjects([this.hHand, this.hElbow], false)[0];
      if (hit) this.select(this.activeChan(hit.object.userData.chan));
    });
  }

  // ── open / close ──────────────────────────────────────────────────────────
  open() {
    const A = this.archer, ms = this.rider.mountSys;
    if (this.rider.mode !== "ground") return { err: "get off the horse first (F)" };
    BP.on = true;
    // the aim held fixed: level, where the archer stands turned now
    this.gyaw0 = ms.gyaw; A.edit = null;
    if (!A.anim) A.anim = this.bake(true);
    this.data = A.anim;
    this.data.notes ??= [];
    const yaw = ms.gyaw + Math.PI / 2 - BP.hipOpen, d = new V3(Math.sin(yaw), 0, Math.cos(yaw));
    const head = this.rider.B.head.getWorldPosition(new V3());
    A.edit = { aim: { P: head.addScaledVector(d, 30), d }, fromHold: this.fromHold };
    this.isOpen = true; this.D.editing = true; this.dirty = true;
    this.el.style.display = "block"; document.body.classList.add("be-open");
    this.ui.keyed.checked = BP.keyed;
    for (const o of [this.hHand, this.hElbow, this.dotReal, this.path, this.elbowLine]) o.visible = true;
    if (document.pointerLockElement) document.exitPointerLock();
    this.camState?.set({ yaw: ms.gyaw + 0.75, pitch: 0.18, dist: 3.4, pan: [0, -0.15, 0], fov: 50 });
    this.select(this.sel);
    this.runChecks();
    this.status(this.saved ? "" : "keys from the coded fetch — save to keep changes");
    return {};
  }
  close() {
    if (!this.isOpen) return;
    const A = this.archer;
    this.isOpen = false; this.D.editing = false; this.D.gizmoDrag = false;
    A.edit = null; A.phase = "empty"; A.aimW = 0; A.t = 0; A.ext = 0; A.elbowDir = null; A.twistPrev = undefined;
    this.tc.detach();
    this.el.style.display = "none"; document.body.classList.remove("be-open");
    this.camera.clearViewOffset();
    this.camera.fov = 55; this.camera.updateProjectionMatrix();
    for (const o of [this.hHand, this.hElbow, this.dotReal, this.path, this.elbowLine]) o.visible = false;
    this.showGhost(false); this.ui.ghost.checked = false;
  }
  toggle() { return this.isOpen ? this.close() : this.open(); }

  // ── the fetch, replayed to a time ─────────────────────────────────────────
  dur() { return this.data.phases.nock[1]; }
  step() {
    this.rider.update(DT, { lookYaw: this.gyaw0, input: { hold: true } });
    this.archer.update(DT, { camera: this.camera, aim: true, fire: false });
  }
  reset() {
    const ms = this.rider.mountSys, A = this.archer;
    ms.gyaw = this.gyaw0; ms.gv = 0;
    if (ms.cur) ms.cur.time = 0;                            // (the idle clip from its start: the same pose every replay)
    A.edit.fromHold = this.fromHold;
    A.editReset(this.fromHold);
    A.t = -DT; this.simT = -DT;
    if (!this.fromHold) {                                   // the lead-in: aim pressed until the fetch starts (its frame 0)
      for (let i = 0; i < 60 && A.phase !== "fetch"; i++) this.step();
      this.simT = 0;
    }
  }
  simTo(t) {
    if (this.dirty || this.simT == null || t < this.simT - 1e-6) { this.reset(); this.dirty = false; }
    while (this.simT < t - 1e-6) { this.step(); this.simT += DT; }
  }
  // the coded fetch, sampled each frame and thinned to the keys that matter
  bake(silent) {
    const A = this.archer, wasEdit = A.edit, wasHold = this.fromHold;
    const ms = this.rider.mountSys;
    this.gyaw0 ??= ms.gyaw;
    if (!A.edit) { const yaw = ms.gyaw + Math.PI / 2 - BP.hipOpen, d = new V3(Math.sin(yaw), 0, Math.cos(yaw)); A.edit = { aim: { P: this.rider.B.head.getWorldPosition(new V3()).addScaledVector(d, 30), d }, fromHold: true }; }
    const ST = { reach: [0, 1.1], close: [1.1, 1.3], pull: [1.3, 1.85], bring: [1.85, 2.7], nock: [2.7, BP.fetchTime] };
    A.useCode = true;
    const run = (hold) => { this.fromHold = hold; this.reset(); A.rec = []; while (this.simT < BP.fetchTime - 1e-6) { this.step(); this.simT += DT; } const r = A.rec; A.rec = null; return r; };
    let H, L;
    try { H = run(true); L = run(false); } finally { A.useCode = false; this.fromHold = wasHold; if (!wasEdit) A.edit = null; this.dirty = true; }
    const ch = {};
    for (const c of FETCH_CHANNELS) {
      const src = c.low ? L : H, name = c.low ? c.name.replace("Low", "") : c.name;
      const until = c.name === "handLow" ? ST.reach[1] : c.name === "elbowLow" ? 0.6 : Infinity;
      if (src[0][name] === undefined) { ch[c.name] = { keys: [[0, { bowReady: 1, turn: 0, lean: 0 }[name] ?? 0]] }; continue; }
      const samples = src.filter((r) => r.t <= until + 1e-6).map((r) => [Math.max(0, r.t), r[name]]);
      ch[c.name] = { keys: thin(samples, TOL[c.name]) };
    }
    if (!silent) this.status("rebuilt");
    return { version: 1, phases: ST, channels: ch, notes: this.data?.notes ?? [] };
  }

  // ── the checks (as the frame-by-frame analysis): every frame of the fetch ──
  runChecksSoon() { clearTimeout(this._ck); this._ck = setTimeout(() => this.isOpen && this.runChecks(), 350); }
  runChecks(report) {
    const A = this.archer, rd = this.rider, B = rd.B, arm = B.arms[1], hd = rd.hands[1], deg = (x) => x * 180 / Math.PI;
    const P = (o) => o.getWorldPosition(new V3());
    const segDist = (p, a, b) => { const ab = b.clone().sub(a), t = Math.max(0, Math.min(1, p.clone().sub(a).dot(ab) / ab.lengthSq())); return p.distanceTo(a.clone().addScaledVector(ab, t)); };
    // the yardstick for "jerks": with Mixamo keys, its own wrist at the same moment ×1.5
    // (a real fetch whips the arrow round at 6 m/s, ~100 m/s²); else a flat 40 m/s²
    const refAcc = this.data.source?.startsWith("mixamo") && this.mix ? this.mixAcc() : null;
    this.reset();
    const flags = []; let prev = null, prev2 = null, vmax = 0;
    while (this.simT < this.dur() - 1e-6) {
      this.step(); this.simT += DT;
      const S = P(arm.u), E = P(arm.l), Wr = P(arm.tip), Mk = P(hd.middle);
      const ua = E.clone().sub(S).normalize(), fa = Wr.clone().sub(E).normalize(), hand = Mk.clone().sub(Wr).normalize();
      const r = { t: Math.max(0, this.simT), elbow: deg(ua.angleTo(fa)), wrist: deg(fa.angleTo(hand)), twist: A.forearmTwist(arm, hd).tw, hand: Wr };
      if (prev) { r.v = r.hand.distanceTo(prev.hand) / DT; r.dElbow = r.elbow - prev.elbow; r.dTwist = ((r.twist - prev.twist + 540) % 360) - 180; vmax = Math.max(vmax, r.v); }
      if (prev2) r.acc = r.hand.clone().sub(prev.hand).sub(prev.hand.clone().sub(prev2.hand)).divideScalar(DT * DT).length();
      const bad = [];
      const wristMax = A.useBase() ? 70 : 40;                // (a wrist goes ~70°; Mixamo bends it to 62° pulling the arrow — ours kept it to 40)
      if (r.wrist > wristMax) bad.push(`wrist bent ${r.wrist.toFixed(0)}°`);
      if (r.elbow < 8) bad.push(`elbow locked`);
      if (Math.abs(r.dElbow ?? 0) > 8) bad.push(`elbow jumps ${r.dElbow.toFixed(0)}°`);
      if (Math.abs(r.dTwist ?? 0) > 15) bad.push(`roll jumps ${r.dTwist.toFixed(0)}°`);   // (the limit is 800°/s ≈ 13°/frame)
      const accMax = refAcc ? 1.5 * Math.max(...[-2, -1, 0, 1, 2].map((d) => refAcc[clamp(Math.round(r.t * 60) + d, 0, refAcc.length - 1)])) + 15 : 40;
      if ((r.acc ?? 0) > accMax) bad.push(`hand jerks (${r.acc.toFixed(0)} m/s², ${refAcc ? "Mixamo " + ((accMax - 15) / 1.5).toFixed(0) : "max 40"})`);
      if (A.nocked.visible) {
        const a0 = A.nocked.localToWorld(new V3(0, 0, 0.06)), a1 = A.nocked.localToWorld(new V3(0, 0, 0.74));
        const dh = Math.min(...[hd.hand, hd.middle, hd.index, hd.pinky].map((bn) => segDist(P(bn), a0, a1)));
        if (dh < 0.025) bad.push(`arrow in the hand (${(dh * 100).toFixed(1)} cm)`);
        // the head: a ball; the torso: an elliptic cylinder (wider than deep), pelvis to neck
        if (segDist(P(B.head).add(new V3(0, 0.08, 0)), a0, a1) < 0.11) bad.push("arrow through the head");
        const ch = A.chest(), c0 = P(B.spine2);
        for (let i = 0; i <= 24; i++) {
          const d = a0.clone().lerp(a1, i / 24).sub(c0), y = d.dot(ch.u);
          if (y > -0.28 && y < 0.36 && (d.dot(ch.L) / 0.16) ** 2 + (d.dot(ch.f) / 0.11) ** 2 < 1) { bad.push("arrow through the body"); break; }
        }
      }
      if (bad.length) flags.push([r.t, bad.join(", ")]);
      prev2 = prev; prev = r;
    }
    this.flags = flags; this.dirty = true;
    this.lastCheck = { vmax };
    if (report) this.status(flags.length ? `${flags.length} frames flagged (red ticks) — hand at most ${vmax.toFixed(2)} m/s` : `no frame flagged — hand at most ${vmax.toFixed(2)} m/s`);
  }

  // ── data ──────────────────────────────────────────────────────────────────
  // the channel a handle edits now: from rest, the …Low one until its last key
  activeChan(base) {
    const L = this.data.channels[base + "Low"]?.keys;
    return !this.fromHold && L?.length && this.t <= L[L.length - 1][0] + 1e-6 ? base + "Low" : base;
  }
  value(name) { return keyAt(this.data.channels[name].keys, this.t); }
  setKey(name, t, value) {
    const keys = this.data.channels[name].keys, r = (x) => +(+x).toFixed(4);
    const val = Array.isArray(value) ? value.map(r) : r(value);
    let key = keys.find((kk) => Math.abs(kk[0] - t) < 0.5 / FPS);
    if (key) key[1] = val; else { key = [r(t), val]; keys.push(key); this.sortKeys(name); }
    this.changed();
    return key;
  }
  sortKeys(name) { this.data.channels[name].keys.sort((a, b) => a[0] - b[0]); }
  changed() { this.dirty = true; this.unsaved = true; }
  keySelected() { this.pushUndo(); this.selKey = this.setKey(this.sel, this.t, this.value(this.sel)); this.runChecksSoon(); }
  deleteSel() {
    if (this.selNote) { this.pushUndo(); this.data.notes.splice(this.data.notes.indexOf(this.selNote), 1); this.selNote = null; this.ui.note.value = ""; this.unsaved = true; return; }
    if (!this.selKey) return this.status("select a ◆ or a note first");
    for (const c of FETCH_CHANNELS) {
      const keys = this.data.channels[c.name].keys, i = keys.indexOf(this.selKey);
      if (i < 0) continue;
      if (keys.length < 2) return this.status("a channel needs at least one key");
      this.pushUndo(); keys.splice(i, 1); this.selKey = null; this.changed(); this.runChecksSoon(); return;
    }
  }
  addNote() {
    const txt = this.ui.note.value.trim(); if (!txt) return this.status("type the note first");
    this.pushUndo();
    const t = Math.round(this.t * FPS) / FPS, n = this.selNote && Math.abs(this.selNote[0] - t) < 1e-6 ? this.selNote : null;
    if (n) n[1] = txt; else { this.data.notes.push([t, txt]); this.data.notes.sort((a, b) => a[0] - b[0]); }
    this.selNote = null; this.ui.note.value = ""; this.unsaved = true;
    this.status(`note at f${Math.round(t * FPS)} — save to keep it`);
  }
  // a phase border moved: everything after the phase's start stretches with it
  moveBorder(name, tNew) {
    const P = this.data.phases, i = PHASES.indexOf(name), a = P[name][0], b = P[name][1];
    const next = PHASES[i + 1], c = next ? P[next][1] : null;
    tNew = Math.max(a + 0.05, next ? Math.min(c - 0.05, tNew) : Math.min(10, tNew));
    if (Math.abs(tNew - b) < 1e-6) return;
    const map = (t) => t <= a ? t : t <= b ? a + (t - a) * (tNew - a) / (b - a) : next ? (t <= c ? tNew + (t - b) * (c - tNew) / (c - b) : t) : t + (tNew - b);
    for (const ch of Object.values(this.data.channels)) for (const k of ch.keys) k[0] = +map(k[0]).toFixed(4);
    for (const n of this.data.notes) n[0] = map(n[0]);
    this.flags = this.flags.map(([t, m]) => [map(t), m]);
    P[name][1] = tNew; if (next) P[next][0] = tNew;
    this.setT(map(this.t));
    this.changed();
  }
  pushUndo() { this.undo.push(JSON.stringify(this.data)); if (this.undo.length > 100) this.undo.shift(); }
  doUndo() {
    const s = this.undo.pop(); if (!s) return this.status("nothing to undo");
    this.archer.anim = this.data = JSON.parse(s); this.selKey = null; this.selNote = null; this.changed(); this.runChecksSoon();
  }
  async save() {
    const body = JSON.stringify(this.data);
    try {
      const r = await fetch(`/__horse-lab/anims?name=bow-fetch`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
      const j = await r.json();
      if (!j.ok) throw new Error("save failed");
      this.unsaved = false; this.saved = true; this.status(`saved → ${j.file}`);
    } catch (e) {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([body], { type: "application/json" })); a.download = "bow-fetch.json"; a.click();
      this.status(`downloaded bow-fetch.json (put it in v3/horse-lab/anims/) — ${e.message}`);
    }
  }
  status(msg) { this.ui.status.textContent = msg; clearTimeout(this._st); if (msg) this._st = setTimeout(() => (this.ui.status.textContent = ""), 7000); }
  select(name) {
    this.sel = name;
    for (const [n, r] of Object.entries(this.rowEls)) r.classList.toggle("sel", n === name);
    const base = name.replace("Low", "");
    if (base === "hand") this.tc.attach(this.hHand); else if (base === "elbow") this.tc.attach(this.hElbow); else this.tc.detach();
  }
  setT(t) { this.t = THREE.MathUtils.clamp(t, 0, this.dur()); }
  togglePlay() { this.playing = !this.playing; if (this.playing && this.t >= this.dur() - 1e-3) this.t = 0; }

  onKey(e) {
    if (!this.isOpen) return false;
    if (e.target?.tagName === "INPUT" && e.target.type === "text") return true;
    const k = e.key;
    if (k === " ") { e.preventDefault(); this.togglePlay(); }
    else if (k === "ArrowLeft" || k === "ArrowRight") { e.preventDefault(); this.playing = false; this.setT(Math.round((this.t + (k === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 6 : 1) / FPS) * FPS) / FPS); }
    else if (k === "Home") this.setT(0);
    else if (k === "End") this.setT(this.dur());
    else if (k === "Enter") this.keySelected();
    else if (k === "Delete" || k === "Backspace") this.deleteSel();
    else if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === "z") { e.preventDefault(); this.doUndo(); }
    else if (k.toLowerCase() === "u") this.close();
    return true;
  }

  // ── per frame (in place of the rider's and the archer's updates) ──────────
  update(dt) {
    if (!this.isOpen) return;
    const dur = this.dur();
    if (this.playing) {
      this.t += dt * this.speed;
      if (this.t > dur) { if (this.loop) this.t = 0; else { this.t = dur; this.playing = false; } }
    }
    this.simTo(Math.floor(this.t * FPS + 1e-6) / FPS);      // (whole frames: slow play steps frame by frame)
    const A = this.archer, F = this.frame = A.fetchFrame;
    const f = Math.round(this.t * FPS), ph = PHASES.find((n) => this.t <= this.data.phases[n][1] + 1e-6) ?? "nock";
    this.ui.play.textContent = this.playing ? "❚❚ pause" : "▶ play";
    this.ui.time.textContent = `${this.t.toFixed(2)} / ${dur.toFixed(2)} s · f${f} · ${ph}`;
    // what is at the playhead: notes, then the checks' flags
    const near = (arr) => arr.filter(([t]) => Math.abs(t - this.t) < 1.5 / FPS).map(([, m]) => m);
    const nn = near(this.data.notes), fl = near(this.flags);
    this.ui.info.innerHTML = (nn.length ? `<span style="color:#ffe08a">✎ ${nn.map(esc).join(" · ")}</span> ` : "") + (fl.length ? `⚠ ${fl.map(esc).join(" · ")}` : "");
    this.ui.info.title = this.ui.info.textContent;
    this.camera.setViewOffset(innerWidth, innerHeight, 0, this.el.offsetHeight / 2, innerWidth, innerHeight);
    // rows: values at the playhead; the …Low rows dim when they don't play
    for (const c of FETCH_CHANNELS) {
      const r = this.rowEls[c.name], v = this.value(c.name);
      r.classList.toggle("dim", !!c.low === this.fromHold);
      if (c.type === "num") { if (document.activeElement !== r.slider) r.slider.value = v; r.val.textContent = (+v).toFixed(2); }
      else r.val.textContent = v.map((x) => x.toFixed(2)).join(" ");
    }
    // handles (in the shoulder's frame now) and the hand's path
    if (F) {
      const toW = (v) => F.SR.clone().addScaledVector(F.Rt, v[0]).addScaledVector(F.cu, v[1]).addScaledVector(F.cf, v[2]);
      const hc = this.activeChan("hand"), ec = this.activeChan("elbow");
      if (!(this.D.gizmoDrag && this.tc.object === this.hHand)) this.hHand.position.copy(toW(this.value(hc)));
      if (!(this.D.gizmoDrag && this.tc.object === this.hElbow)) this.hElbow.position.copy(toW(this.value(ec).map((x) => x * 0.3)));
      this.hHand.scale.setScalar(this.sel.startsWith("hand") ? 1.4 : 1); this.hElbow.scale.setScalar(this.sel.startsWith("elbow") ? 1.4 : 1);
      this.dotReal.position.copy(A.pinchPoint());
      const pa = this.path.geometry.attributes.position, chs = this.data.channels, Lk = chs.handLow.keys, tL = Lk[Lk.length - 1][0];
      for (let i = 0; i <= 120; i++) {
        const t = (i / 120) * dur;
        let v = keyAt(chs.hand.keys, t);
        if (!this.fromHold) { if (t <= tL) v = keyAt(Lk, t); else { const a = keyAt(Lk, tL), b = keyAt(chs.hand.keys, tL), k = 1 - mj((t - tL) / 0.3); v = v.map((x, j) => x + (a[j] - b[j]) * k); } }
        const w = toW(v); pa.setXYZ(i, w.x, w.y, w.z);
      }
      pa.needsUpdate = true;
      const el = this.elbowLine.geometry.attributes.position; el.setXYZ(0, F.SR.x, F.SR.y, F.SR.z); el.setXYZ(1, this.hElbow.position.x, this.hElbow.position.y, this.hElbow.position.z); el.needsUpdate = true;
    }
    if (this.ghostOn && this.mix) this.mix.at(Math.min(this.t, this.mix.clip.duration));
    this.drawTimeline();
  }

  // ── the Mixamo reference ──────────────────────────────────────────────────
  async mixRef() {
    if (!this.mix) { this.status("loading the Mixamo clip…"); this.mix = await loadMixamoRef(MIX_URL); }
    return this.mix;
  }
  // its figure beside the robot (1.1 m to its right), turned the same way, see-through
  async showGhost(on) {
    this.ghostOn = on;
    if (!on) { if (this.mix) this.mix.root.visible = false; return; }
    let M;
    try { M = await this.mixRef(); } catch (e) { this.ui.ghost.checked = this.ghostOn = false; return this.status("no Mixamo clip: put “Shooting Arrow.fbx” in v3/horse-lab/refs — " + e.message); }
    if (!M.ghostMat) {
      M.ghostMat = new THREE.MeshStandardMaterial({ color: 0x7fd4ff, roughness: 0.6, transparent: true, opacity: 0.55 });
      M.root.traverse((o) => { if (o.isMesh) { o.material = M.ghostMat; o.frustumCulled = false; } });
    }
    if (!M.root.parent) this.scene.add(M.root);
    // place: its rest pose's chest facing ours, its hips 1.1 m to our right
    M.root.position.set(0, 0, 0); M.root.rotation.set(0, 0, 0); M.at(0);
    const P = (o) => o.getWorldPosition(new V3());
    const mf = (() => { const L = P(M.bone("LeftArm")).sub(P(M.bone("RightArm"))); L.y = 0; L.normalize(); return new V3(-L.z, 0, L.x); })();   // (L × up)
    const ch = this.archer.chest(), of = ch.f.clone().setY(0).normalize();
    M.root.rotation.y = Math.atan2(of.x, of.z) - Math.atan2(mf.x, mf.z);
    M.at(0);
    const want = P(this.rider.B.pelvis).addScaledVector(ch.L, -0.9).addScaledVector(of, 1.0), hips = P(M.bone("Hips"));
    M.root.position.set(want.x - hips.x, this.rider.mountSys.gpos.y, want.z - hips.z);
    M.root.visible = true; M.at(this.t);
    this.status("Mixamo figure: in front, to the robot's right, at the playhead's time");
  }
  // the clip retargeted onto the robot (retarget.js), its arrow line (right hand → left
  // hand at full draw, 2.8 s) for the stance; saved, and the bow plays it at once
  async bakeBase() {
    let M;
    try { M = await this.mixRef(); } catch (e) { return this.status("no Mixamo clip: put “Shooting Arrow.fbx” in v3/horse-lab/refs — " + e.message); }
    const was = { p: M.root.position.clone(), r: M.root.rotation.y };
    M.root.position.set(0, 0, 0); M.root.rotation.set(0, 0, 0);
    const b = bakeMixamoOnto(M, this.rider.r.model);
    const a = b.dirAt(2.8, "Head", "LeftHand"), arrowYaw = Math.atan2(a.x, a.z);   // (the arrow runs from the anchor at the jaw to the bow hand — wrist to wrist was 29° off it)
    M.root.position.copy(was.p); M.root.rotation.y = was.r; M.at(this.t);
    const json = bakedToJSON(b, { source: "mixamo:Shooting Arrow", arrowYaw });
    this.archer.base = bakedFromJSON(json, this.rider.r.model); this.archer.calibrateBase();
    this.dirty = true; this.runChecksSoon();
    try {
      const r = await fetch(`/__horse-lab/anims?name=bow-shot-mocap${this.rider.r.kind === "ybot" ? "-ybot" : ""}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(json) });   // (per rider)
      const j = await r.json(); if (!j.ok) throw new Error("save failed");
      this.status(`Mixamo body baked (${b.names.length} bones, arrow line ${(arrowYaw * 180 / Math.PI).toFixed(0)}°) → ${j.file}`);
    } catch (e) { this.status("baked (playing), not saved — " + e.message); }
  }
  mixAcc() {
    if (this._mixAcc) return this._mixAcc;
    const M = this.mix, P = (o) => o.getWorldPosition(new V3()), w = [];
    const was = M.root.position.clone();
    for (let i = 0; i <= Math.round(MIX_PHASES.nock[1] * 60) + 2; i++) { M.at(i / 60); w.push(P(M.bone("RightHand"))); }
    M.at(this.t);
    return (this._mixAcc = w.map((p, i) => (i && i < w.length - 1 ? w[i + 1].clone().add(w[i - 1]).sub(p.clone().multiplyScalar(2)).multiplyScalar(3600).length() * 0.97 : 0)));
  }
  // the keys from the Mixamo clip: the pinch point and the elbow in the right shoulder's
  // frame (scaled by arm length), the forearm's roll, the torso's turn / lean, the bow
  // hand coming up — on its timing; the fingers / wrist by its phases
  async fromMixamo() {
    let M;
    try { M = await this.mixRef(); } catch (e) { return this.status("no Mixamo clip: put “Shooting Arrow.fbx” in v3/horse-lab/refs — " + e.message); }
    const b = M.bone, P = (o) => o.getWorldPosition(new V3());
    const was = { p: M.root.position.clone(), r: M.root.rotation.y, s: M.root.scale.x };
    M.root.position.set(0, 0, 0); M.root.rotation.set(0, 0, 0);
    const armLen = (u, l, t) => P(u).distanceTo(P(l)) + P(l).distanceTo(P(t));
    M.at(0);
    const rB = this.rider.B, k = armLen(rB.arms[1].u, rB.arms[1].l, rB.arms[1].tip) / armLen(b("RightArm"), b("RightForeArm"), b("RightHand"));
    const frame = () => {
      const sR = P(b("RightArm")), sL = P(b("LeftArm")), u = P(b("Neck")).sub(P(b("Spine1"))).normalize();
      const L = sL.clone().sub(sR); L.addScaledVector(u, -L.dot(u)).normalize();
      return { sR, sL, u, L, f: new V3().crossVectors(L, u) };
    };
    const f0 = frame().f.setY(0).normalize();
    const S = [];
    const end = MIX_PHASES.nock[1];
    for (let i = 0; i <= Math.round(end * 30); i++) {
      const t = i / 30; M.at(t);
      const F = frame(), Rt = F.L.clone().negate(), loc = (w, o = F.sR) => { const d = w.clone().sub(o); return [d.dot(Rt), d.dot(F.u), d.dot(F.f)]; };
      const W = P(b("RightHand")), E = P(b("RightForeArm"));
      const pinch = P(b("RightHandThumb4")).lerp(P(b("RightHandIndex3")).lerp(P(b("RightHandIndex4")), 0.45), 0.5);
      const Fd = W.clone().sub(E).normalize(), ref = F.sR.clone().sub(E); ref.addScaledVector(Fd, -ref.dot(Fd)).normalize();
      const N = new V3().crossVectors(P(b("RightHandIndex1")).sub(W), P(b("RightHandPinky1")).sub(W)).normalize(); N.addScaledVector(Fd, -N.dot(Fd)).normalize();
      const fh = F.f.clone().setY(0).normalize();
      const e = loc(E), en = Math.hypot(...e);
      S.push({ t, hand: loc(pinch).map((x) => x * k), elbow: e.map((x) => x / en), roll: Math.atan2(new V3().crossVectors(ref, N).dot(Fd), ref.dot(N)) * 180 / Math.PI,
        turn: Math.atan2(new V3().crossVectors(f0, fh).y, f0.dot(fh)) * 180 / Math.PI, lean: Math.asin(clamp(F.u.dot(fh), -1, 1)) * 180 / Math.PI, lHand: loc(P(b("LeftHand")), F.sL) });
    }
    M.root.position.copy(was.p); M.root.rotation.y = was.r; M.at(this.t);
    const ser = (name, t0 = 0, t1 = end, f = (v) => v) => S.filter((r) => r.t >= t0 - 1e-6 && r.t <= t1 + 1e-6).map((r) => [r.t, f(r[name])]);
    // the bow coming up: the bow hand's way from hanging to where it nocks (Mixamo 1.43 s),
    // fully up from there on (the draw raises it further — that is the game's own push–pull)
    const lean0 = S[0].lean, l0 = S[0].lHand, iN = S.findIndex((r) => r.t >= MIX_PHASES.nock[0] - 1e-6), lN = S[iN].lHand;
    const dl = (a) => Math.hypot(...a.map((x, i) => x - l0[i])), dN = dl(lN);
    S.forEach((r, i) => (r.bowReady = i >= iN ? 1 : clamp(dl(r.lHand) / dN, 0, 1)));
    const old = this.data.channels;
    this.pushUndo();
    const ch = {
      handLow: { keys: thin(ser("hand", 0, MIX_PHASES.reach[1]), TOL.hand) },
      hand: { keys: [[0, old.hand.keys[0][1]], ...thin(ser("hand", 0.6), TOL.hand)] },
      elbowLow: { keys: thin(ser("elbow", 0, MIX_PHASES.reach[1]), TOL.elbow) },
      elbow: { keys: [[0, old.elbow.keys[0][1]], ...thin(ser("elbow", 0.6), TOL.elbow)] },
      roll: { keys: thin(ser("roll", 0, end, (v) => clamp(v, -165, -15)), TOL.roll) },
      fingers: { keys: [[0, 0], [0.83, 0], [0.93, 1], [1.43, 1], [1.95, 2]] },
      wristNocks: { keys: [[0, 0]] },   // (Mixamo keeps the wrist straight there; bent down to the nocks, the hand flipped over at 0.67 s)
      wristString: { keys: [[0, 0], [1.43, 0], [1.95, 1]] },
      bowReady: { keys: thin(ser("bowReady"), TOL.bowReady) },
      turn: { keys: thin(ser("turn"), TOL.turn) },
      lean: { keys: thin(ser("lean", 0, end, (v) => v - lean0), TOL.lean) },
      look: { keys: [[0, 0.45]] },
      headDown: { keys: [[0, 0.3]] },
    };
    for (const c of Object.values(ch)) c.keys = c.keys.map(([t, v]) => [+t.toFixed(4), Array.isArray(v) ? v.map((x) => +x.toFixed(4)) : +v.toFixed(4)]);
    this.archer.anim = this.data = { version: 1, source: "mixamo:Shooting Arrow", phases: JSON.parse(JSON.stringify(MIX_PHASES)), channels: ch, notes: this.data.notes ?? [] };
    this.setT(Math.min(this.t, this.dur()));
    this.changed(); this.runChecksSoon();
    this.status(`keys from Mixamo (${Object.values(ch).reduce((n, c) => n + c.keys.length, 0)} keys, arm ×${k.toFixed(2)}) — not saved yet`);
  }

  drawTimeline() {
    const cv = this.cv, dpr = devicePixelRatio, W = cv.clientWidth, H = cv.clientHeight;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const g = cv.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const dur = this.dur(), X = this.toX;
    // ruler: seconds, and every 6th frame
    g.fillStyle = "#1b2229"; g.fillRect(0, 0, W, RULER);
    g.font = "10px system-ui"; g.textBaseline = "middle";
    const fpx = (W - 16) / dur / FPS;                       // px a frame
    for (let f = 0; f <= Math.round(dur * FPS); f++) {
      const x = X(f / FPS), sec = f % FPS === 0, tenth = f % 6 === 0;
      if (!tenth && fpx < 4) continue;
      g.strokeStyle = sec ? "#5a6a78" : tenth ? "#36424d" : "#262e36";
      g.beginPath(); g.moveTo(x, sec ? 6 : tenth ? 13 : 17); g.lineTo(x, sec || tenth ? H : RULER); g.stroke();
      if (sec || (tenth && fpx > 1.2 && f % 30 === 0)) { g.fillStyle = "#8fa0ad"; g.fillText(`${(f / FPS).toFixed(1)}s f${f}`, x + 3, 7); }
    }
    // the checks: red ticks
    g.fillStyle = "#ff5a4a";
    for (const [t] of this.flags) g.fillRect(X(t) - 1, RULER - 6, 2, 6);
    // phases
    const P = this.data.phases;
    for (const n of PHASES) {
      const x0 = X(P[n][0]), x1 = X(P[n][1]);
      g.fillStyle = PHASE_COL[n]; g.fillRect(x0, RULER + 2, x1 - x0, BAND - 4);
      g.fillStyle = "#dfe6ec"; g.fillText(n, x0 + 4, RULER + BAND / 2);
      g.fillStyle = "#9fb4c4"; g.fillRect(x1 - 1, RULER, 2, BAND);
    }
    // rows
    FETCH_CHANNELS.forEach((c, i) => {
      const y = RULER + BAND + i * ROW;
      g.fillStyle = c.name === this.sel ? "rgba(59,110,168,0.18)" : i % 2 ? "rgba(255,255,255,0.02)" : "transparent";
      g.fillRect(0, y, W, ROW);
      const dim = !!c.low === this.fromHold;
      const col = c.color != null ? hex(c.color) : "#c9d4dc";
      g.globalAlpha = dim ? 0.35 : 1;
      for (const kk of this.data.channels[c.name].keys) {
        const x = X(kk[0]), cy = y + ROW / 2, r = kk === this.selKey ? 7 : 5;
        g.beginPath(); g.moveTo(x, cy - r); g.lineTo(x + r, cy); g.lineTo(x, cy + r); g.lineTo(x - r, cy); g.closePath();
        g.fillStyle = kk === this.selKey ? "#fff" : col; g.fill(); g.strokeStyle = "#0d1115"; g.stroke();
      }
      g.globalAlpha = 1;
    });
    // notes
    const yN = RULER + BAND + FETCH_CHANNELS.length * ROW;
    g.fillStyle = "#1b2229"; g.fillRect(0, yN, W, NOTES);
    g.fillStyle = "#6f7f8c"; if (!this.data.notes.length) g.fillText("notes — type above, “add at playhead”", 10, yN + NOTES / 2);
    for (const n of this.data.notes) {
      const x = X(n[0]);
      g.fillStyle = n === this.selNote ? "#fff" : "#ffd24a";
      g.beginPath(); g.moveTo(x, yN + 3); g.lineTo(x + 9, yN + 7); g.lineTo(x, yN + 11); g.closePath(); g.fill();
      g.fillRect(x - 1, yN + 3, 2, NOTES - 5);
    }
    // playhead
    const px = X(this.t);
    g.strokeStyle = "#ff4d4d"; g.lineWidth = 2; g.beginPath(); g.moveTo(px, 0); g.lineTo(px, H); g.stroke(); g.lineWidth = 1;
  }
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// samples [[t, v]] → the fewest keys that stay within tol of every sample
// (greedy: drop the key whose removal costs least, while it stays within tol)
function thin(samples, tol) {
  const dist = (a, b) => (Array.isArray(a) ? Math.hypot(...a.map((x, i) => x - b[i])) : Math.abs(a - b));
  const rnd = (v) => (Array.isArray(v) ? v.map((x) => +x.toFixed(4)) : +v.toFixed(4));
  let keys = samples.filter((s, i) => i % 3 === 0 || i === samples.length - 1).map(([t, v]) => [+t.toFixed(4), rnd(v)]);
  const errOver = (ks, t0, t1) => { let e = 0; for (const [t, v] of samples) if (t >= t0 && t <= t1) e = Math.max(e, dist(keyAt(ks, t), v)); return e; };
  for (;;) {
    let best = null;
    for (let i = 1; i < keys.length - 1; i++) {
      const ks = keys.slice(0, i).concat(keys.slice(i + 1));
      const e = errOver(ks, keys[Math.max(0, i - 2)][0], keys[Math.min(keys.length - 1, i + 2)][0]);
      if (e < tol && (!best || e < best.e)) best = { i, e };
    }
    if (!best) break;
    keys.splice(best.i, 1);
  }
  return keys;
}
