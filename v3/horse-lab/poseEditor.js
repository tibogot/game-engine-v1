// ── Horse lab: the POSE editor (J) ───────────────────────────────────────────
// Click a joint (dots on the horse and the rider), turn it with the gizmo: a
// key is set at the current time. The keys are a LAYER on top of whatever
// moves the bones (the clips, the procedural rear, IK, the tail rope): each key
// is a rotation offset per bone, eased between keys, and fading to nothing at
// the clip's start and end (the rear begins and ends as before). The game plays
// the same layer whenever that clip runs — saved to anims/poses.json.
//
// Step 1: the rear (R). The timeline scrubs it: replayed from its start at a
// fixed 1/60 s, so a time always shows the same pose.
//
// Frame order (horse-lab.html): restore() → ctrl.update → applyHorse() →
// rider.update → applyRider(). restore() puts the layered bones back to what
// the animation wrote, BEFORE the animation runs again (the mixer skips
// writing a bone whose value did not change: an offset would pile up).
import * as THREE from "three";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { HP, solveTwoBone } from "./horse.js";

// move mode: the end you drag → the two joints that bend to reach it
const CHAINS = {};
for (const s of ["L", "R"]) {
  CHAINS[`H:FF${s}`] = [`H:FrontUpperLeg${s}`, `H:FrontLowerLeg${s}`];       // front hoof: elbow + knee
  CHAINS[`H:FFB${s}`] = [`H:BackUpperLeg${s}`, `H:BackLowerLeg${s}`];       // hind hoof: stifle + hock
  CHAINS[`H:BackLowerLeg${s}`] = [`H:BackLeg${s}`, `H:BackUpperLeg${s}`];   // hock: hip + stifle
  CHAINS[`H:FrontLowerLeg${s}`] = [`H:FrontShoulder${s}`, `H:FrontUpperLeg${s}`];   // front knee: shoulder + elbow
}
for (const s of ["l", "r"]) {
  CHAINS[`R:hand_${s}`] = [`R:upperarm_${s}`, `R:lowerarm_${s}`];
  CHAINS[`R:foot_${s}`] = [`R:thigh_${s}`, `R:calf_${s}`];
}
import { REAR_REFS, rearViewFit } from "./refCompare.js";

const V3 = THREE.Vector3, Q = THREE.Quaternion;
const FPS = 60, PANEL = 172, PANEL_MIN = 30, LABEL = 118, RULER = 16, ROW = 17;
const sm = (u) => u * u * (3 - 2 * u);
const rearLength = () => HP.rearPrep + HP.rearRise + HP.rearHold + HP.rearFall + HP.rearSettle;
const SKIP = /IK|Pole|Armature|Root$|^Tail[2-9]|^Ear[2-4]|index|middle|pinky|ring_|thumb|leaf/;   // control bones; the tail is the rope's; finger + ear-tip clutter

// every joint: its body part (one colour each) and a plain name (hover, timeline)
const PARTS = {
  spine: { color: 0xb8bec4, label: "spine" }, head: { color: 0xc77dff, label: "neck + head" },
  fl: { color: 0xff5252, label: "front left leg" }, fr: { color: 0xff9f1c, label: "front right leg" },
  hl: { color: 0x3ddc84, label: "hind left leg" }, hr: { color: 0x2f9bff, label: "hind right leg" },
  tail: { color: 0x00e5c8, label: "tail" }, rider: { color: 0xff4fd8, label: "rider" },
};
const HORSE_NAMES = {
  Body: "whole body (root)", Back: "croup (rear of the back)", Torso: "back, middle", Torso2: "back, front", Torso3: "withers / chest",
  Neck1: "neck base", Neck2: "neck middle", Neck3: "neck top", Head: "head (poll)", Ear1L: "left ear", Ear1R: "right ear", Tail1: "tail root",
  FrontShoulder: "shoulder", FrontUpperLeg: "elbow", FrontLowerLeg: "knee", FF: "hoof",
  BackShoulder: "pelvis", BackLeg: "hip joint", BackUpperLeg: "stifle (front knee of the hind leg)", BackLowerLeg: "hock (back knee)", FFB: "hoof",
};
function describe(id) {
  const who = id[0], n = id.slice(2);
  if (who === "R") {
    const side = /_l$/.test(n) ? "left " : /_r$/.test(n) ? "right " : "";
    return { part: "rider", name: "rider — " + side + n.replace(/_[lr]$/, "").replace(/_0?(\d)/, " $1").replace(/_/g, " ") };
  }
  if (HORSE_NAMES[n]) return { part: /^Tail/.test(n) ? "tail" : /^(Neck|Head|Ear)/.test(n) ? "head" : "spine", name: HORSE_NAMES[n] };
  const m = n.match(/^(FrontShoulder|FrontUpperLeg|FrontLowerLeg|BackShoulder|BackLeg|BackUpperLeg|BackLowerLeg|FFB|FF)([LR])$/);
  if (m) {
    const front = !/^(Back|FFB)/.test(m[1]), side = m[2] === "L" ? "left" : "right";
    return { part: (front ? "f" : "h") + m[2].toLowerCase(), name: `${front ? "front" : "hind"} ${side} — ${HORSE_NAMES[m[1]]}` };
  }
  return { part: "spine", name: n };
}

const CSS = `
#pe { position: fixed; left: 0; right: 0; bottom: 0; z-index: 40; background: #14191e; color: #d6dde3;
  font: 12px system-ui, sans-serif; border-top: 1px solid #2c3640; user-select: none; }
#pe .hd { display: flex; align-items: center; gap: 6px; padding: 4px 8px; height: 22px; white-space: nowrap; overflow: hidden; }
#pe .hd b { color: #ffd98a; }
#pe button, #pe select { background: #222b33; color: #d6dde3; border: 1px solid #36424d; border-radius: 3px; font: 12px system-ui; padding: 1px 6px; height: 21px; }
#pe button:hover { background: #2c3742; }
#pe button.on { background: #3b6ea8; border-color: #4f86c6; }
#pe .sep { width: 1px; height: 16px; background: #36424d; margin: 0 2px; }
#pe .bone { color: #9fd3ff; min-width: 110px; }
#pe .msg { color: #9fb0bd; overflow: hidden; text-overflow: ellipsis; flex: 1; text-align: right; }
#pe canvas { display: block; width: 100%; }
#pe.min canvas { display: none; }
#peRef { position: fixed; z-index: 30; pointer-events: none; display: none; }
#peTip { position: fixed; z-index: 45; pointer-events: none; display: none; background: rgba(12,16,20,0.92); color: #fff;
  font: 12px system-ui; padding: 3px 7px; border-radius: 4px; border-left: 4px solid #fff; white-space: nowrap; }
#peLegend { position: fixed; left: 8px; top: 8px; z-index: 41; display: none; background: rgba(12,16,20,0.78); color: #d6dde3;
  font: 11px system-ui; padding: 5px 8px; border-radius: 5px; line-height: 16px; }
#peLegend i { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 6px; vertical-align: -1px; }
`;

export class PoseEditor {
  constructor({ renderer, scene, camera, ctrl, rider, D, camState }) {
    Object.assign(this, { renderer, scene, camera, ctrl, rider, D, camState });
    this.isOpen = false; this.clip = "rear"; this.t = 0; this.playing = false; this.speed = 0.5; this.loop = true;
    this.data = {};                                          // clip → { boneId: [[t, [x,y,z,w]], …] }
    this.base = new Map();                                   // boneId → the animation's quaternion this frame
    this.layered = new Set();                                // bones the layer changed this frame
    this.sel = null; this.selKey = null; this.undo = [];
    this.showJ = "both";
    this.collectBones();
    this.buildUI();
    this.buildScene();
    this.load();
  }

  // ── bones ────────────────────────────────────────────────────────────────
  collectBones() {
    this.bones = new Map();                                  // id → { b, who }
    const add = (root, who) => root.traverse((o) => {
      if (!o.isBone || SKIP.test(o.name)) return;
      const id = `${who}:${o.name}`, d = describe(id);
      this.bones.set(id, { b: o, who, part: d.part, name: d.name, color: new THREE.Color(PARTS[d.part].color) });
    });
    add(this.ctrl.h.rig, "H");
    add(this.rider.r.rig, "R");
    this.ids = [...this.bones.keys()];
  }
  keysOf(id) { return this.data[this.clip]?.[id]; }

  // the layer's offset for a bone at time t: eased between keys, fading to none
  // at the clip's ends (virtual zero keys there, unless keyed)
  offsetAt(keys, t, end) {
    if (!keys?.length) return null;
    const pts = keys.slice();
    if (pts[0][0] > 1e-3) pts.unshift([0, [0, 0, 0, 1]]);
    if (pts[pts.length - 1][0] < end - 1e-3) pts.push([end, [0, 0, 0, 1]]);
    if (t <= pts[0][0]) return new Q(...pts[0][1]);
    for (let i = 0; i < pts.length - 1; i++) {
      const [t0, a] = pts[i], [t1, b] = pts[i + 1];
      if (t <= t1) { const u = t1 > t0 ? sm((t - t0) / (t1 - t0)) : 1; return new Q(...a).slerp(new Q(...b), u); }
    }
    return new Q(...pts[pts.length - 1][1]);
  }

  // where the layer's clock is: the editor's time, or the game's rear
  layerTime() {
    if (this.isOpen) return this.t;
    if (this.clip === "rear" && this.ctrl.rearT >= 0) return this.ctrl.rearT;
    return null;
  }

  restore() {
    for (const id of this.layered) { const e = this.bones.get(id); const q = this.base.get(id); if (e && q) e.b.quaternion.copy(q); }
    this.layered.clear();
  }
  // (the hooves hang on IK bones that are not children of the legs: put them back
  // on the leg tips after the layer turned the legs — else a posed leg leaves its hoof)
  applyHorse() { if (this.applyWho("H")) this.ctrl.glueHooves(); }
  applyRider() { this.applyWho("R"); }
  applyWho(who) {
    const t = this.layerTime(), set = this.data[this.clip];
    const ids = new Set(Object.keys(set ?? {}).filter((id) => id.startsWith(who + ":")));
    if (this.isOpen && this.sel?.startsWith(who + ":")) { ids.add(this.sel); for (const id of CHAINS[this.sel] ?? []) ids.add(id); }   // (move mode keys the two joints above)
    if (!ids.size) return false;
    const end = rearLength();
    for (const id of ids) {
      const e = this.bones.get(id); if (!e) continue;
      (this.base.get(id) ?? this.base.set(id, new Q()).get(id)).copy(e.b.quaternion);   // what the animation wrote
      const off = t === null ? null : this.offsetAt(set?.[id], t, end);
      if (off) { e.b.quaternion.multiply(off); }
      this.layered.add(id);
    }
    (who === "H" ? this.ctrl.h.rig : this.rider.r.rig).updateMatrixWorld(true);
    return true;
  }

  // ── keys ─────────────────────────────────────────────────────────────────
  pushUndo() { this.undo.push(JSON.stringify(this.data)); if (this.undo.length > 80) this.undo.shift(); }
  doUndo() { const s = this.undo.pop(); if (s) { this.data = JSON.parse(s); this.selKey = null; this.msg("undone"); } }
  setKey(id, t, q) {
    const set = (this.data[this.clip] ??= {}), keys = (set[id] ??= []);
    const r = (x) => +x.toFixed(5), v = [r(q.x), r(q.y), r(q.z), r(q.w)];
    let k = keys.find((kk) => Math.abs(kk[0] - t) < 0.5 / FPS);
    if (k) k[1] = v; else { k = [+t.toFixed(4), v]; keys.push(k); keys.sort((a, b) => a[0] - b[0]); }
    this.dirty = true;
    return k;
  }
  // the selected bone's offset NOW (what the gizmo shows) — keyed at the current time
  keyHere() {
    if (!this.sel) return this.msg("click a joint first");
    const e = this.bones.get(this.sel), base = this.base.get(this.sel);
    if (!base) return;
    this.pushUndo();
    this.selKey = this.setKey(this.sel, this.t, base.clone().invert().multiply(e.b.quaternion));
  }
  deleteKey() {
    const keys = this.sel && this.keysOf(this.sel);
    if (!keys) return;
    const k = this.selKey && keys.includes(this.selKey) ? this.selKey : keys.find((kk) => Math.abs(kk[0] - this.t) < 0.5 / FPS);
    if (!k) return this.msg("no key of this joint here");
    this.pushUndo();
    keys.splice(keys.indexOf(k), 1);
    if (!keys.length) delete this.data[this.clip][this.sel];
    this.selKey = null; this.dirty = true;
  }
  resetBone() {
    if (!this.sel || !this.keysOf(this.sel)) return;
    this.pushUndo(); delete this.data[this.clip][this.sel]; this.selKey = null; this.dirty = true;
    this.msg(`${this.sel.slice(2)}: all its keys removed`);
  }

  async load() {
    try {
      const r = await fetch(`/v3/horse-lab/anims/poses.json?${Date.now()}`);
      if (r.ok) this.data = await r.json();
    } catch { /* none saved yet */ }
  }
  async save() {
    const body = JSON.stringify(this.data);
    try {
      const r = await fetch("/__horse-lab/anims?name=poses", { method: "POST", headers: { "Content-Type": "application/json" }, body });
      if (!r.ok) throw new Error(await r.text());
      this.dirty = false; this.msg("saved → v3/horse-lab/anims/poses.json (the game plays it)");
    } catch (e) { this.msg("save failed: " + e.message); }
  }

  // ── UI ───────────────────────────────────────────────────────────────────
  buildUI() {
    if (!document.getElementById("peCss")) { const s = document.createElement("style"); s.id = "peCss"; s.textContent = CSS; document.head.appendChild(s); }
    const el = this.el = document.createElement("div"); el.id = "pe"; el.style.display = "none";
    el.innerHTML = `<div class="hd">
      <b>Pose</b>
      <select data-k="clip"><option value="rear">rear (R)</option></select>
      <button data-k="play" title="Space">▶</button>
      <select data-k="speed"><option value="0.25">×0.25</option><option value="0.5" selected>×0.5</option><option value="1">×1</option></select>
      <span data-k="time" style="min-width:150px"></span>
      <span class="sep"></span>
      <button data-k="mode" title="M: rotate a joint / move a hoof, hand or foot (the leg follows)">⟲ rotate</button>
      <span class="bone" data-k="bone">no joint</span>
      <button data-k="key" title="K: key this joint here">◆ key</button>
      <button data-k="del" title="Delete">✕ key</button>
      <button data-k="reset" title="all keys of this joint">reset joint</button>
      <button data-k="undo" title="Ctrl+Z">undo</button>
      <span class="sep"></span>
      joints <select data-k="joints"><option value="both">horse + rider</option><option value="H">horse</option><option value="R">rider</option><option value="none">hidden</option></select>
      <span class="sep"></span>
      ref <select data-k="ref"><option value="">none</option>${Object.keys(REAR_REFS).map((n) => `<option>${n}</option>`).join("")}<option>rearLeg</option></select>
      <input data-k="refOp" type="range" min="0" max="1" step="0.05" value="0.5" style="width:60px">
      <button data-k="fit" title="our rear's matching moment + the screenshot's camera">fit</button>
      <span class="sep"></span>
      <button data-k="save">💾 save</button>
      <span class="msg"></span>
      <button data-k="min" title="fold the timeline">▾</button>
      <button data-k="close" title="J">close</button></div>
      <canvas></canvas>`;
    document.body.appendChild(el);
    const q = (k) => el.querySelector(`[data-k=${k}]`);
    this.ui = { time: q("time"), bone: q("bone"), play: q("play"), ref: q("ref"), msg: el.querySelector(".msg") };
    q("play").onclick = () => this.togglePlay();
    q("speed").onchange = (e) => (this.speed = +e.target.value);
    this.ui.mode = q("mode");
    q("mode").onclick = () => this.setMode(this.mode === "move" ? "rotate" : "move");
    q("key").onclick = () => this.keyHere();
    q("del").onclick = () => this.deleteKey();
    q("reset").onclick = () => this.resetBone();
    q("undo").onclick = () => this.doUndo();
    q("joints").onchange = (e) => (this.showJ = e.target.value);
    q("ref").onchange = (e) => this.setRef(e.target.value);
    q("refOp").oninput = (e) => (this.refImg.style.opacity = e.target.value);
    q("fit").onclick = () => this.fit();
    q("save").onclick = () => this.save();
    q("min").onclick = () => { el.classList.toggle("min"); q("min").textContent = el.classList.contains("min") ? "▴" : "▾"; };
    q("close").onclick = () => this.close();
    this.refImg = document.createElement("img"); this.refImg.id = "peRef"; this.refImg.style.opacity = "0.5";
    document.body.appendChild(this.refImg);
    // hover name + the colour legend
    this.tip = document.createElement("div"); this.tip.id = "peTip"; document.body.appendChild(this.tip);
    this.legend = document.createElement("div"); this.legend.id = "peLegend";
    this.legend.innerHTML = Object.values(PARTS).map((p) => `<div><i style="background:#${p.color.toString(16).padStart(6, "0")}"></i>${p.label}</div>`).join("")
      + `<div style="margin-top:3px;color:#9fb0bd">white = selected · big = has keys</div>`;
    document.body.appendChild(this.legend);
    // timeline: scrub, select / drag keys, wheel scrolls the rows
    const cv = this.cv = el.querySelector("canvas");
    cv.style.height = PANEL - 30 + "px";
    this.scroll = 0;
    const toT = (x) => THREE.MathUtils.clamp((x - LABEL) / (cv.clientWidth - LABEL - 8) * rearLength(), 0, rearLength());
    this.toX = (t) => LABEL + t / rearLength() * (cv.clientWidth - LABEL - 8);
    let drag = null;
    cv.addEventListener("pointerdown", (e) => {
      const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      cv.setPointerCapture(e.pointerId);
      const row = this.rows?.[Math.floor((y - RULER - ROW) / ROW) + this.scroll];
      if (row && y > RULER + ROW) {
        if (x < LABEL) { this.select(row); drag = null; return; }
        const k = (this.keysOf(row) ?? []).find((kk) => Math.abs(this.toX(kk[0]) - x) < 6);
        if (k) { this.select(row); this.pushUndo(); this.selKey = k; drag = { k, id: row }; this.t = k[0]; this.playing = false; return; }
      }
      this.selKey = null; this.playing = false; drag = { scrub: true }; this.t = toT(x);
    });
    cv.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const t = Math.round(toT(e.clientX - cv.getBoundingClientRect().left) * FPS) / FPS;
      if (drag.scrub) this.t = t; else { drag.k[0] = t; this.t = t; this.dirty = true; }
    });
    cv.addEventListener("pointerup", () => { if (drag?.k) this.keysOf(drag.id)?.sort((a, b) => a[0] - b[0]); drag = null; });
    cv.addEventListener("wheel", (e) => { this.scroll = Math.max(0, this.scroll + Math.sign(e.deltaY)); e.preventDefault(); }, { passive: false });
  }
  msg(s) { this.ui.msg.textContent = s; this.ui.msg.title = s; }

  buildScene() {
    // joint dots (one instanced draw), always on top, clickable
    const n = this.ids.length;
    this.dots = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 10, 8), new THREE.MeshBasicMaterial({ depthTest: false, transparent: true, opacity: 0.9 }), n);
    this.dots.renderOrder = 999; this.dots.frustumCulled = false; this.dots.visible = false;
    for (let i = 0; i < n; i++) this.dots.setColorAt(i, new THREE.Color(0xffffff));
    this.scene.add(this.dots);
    // the gizmo: rotate, in the bone's own axes
    const tc = this.tc = new TransformControls(this.camera, this.renderer.domElement);
    tc.setMode("rotate"); tc.setSpace("local"); tc.setSize(0.8);
    this.scene.add(tc.getHelper());
    tc.getHelper().visible = false;
    tc.addEventListener("dragging-changed", (e) => { this.D.gizmoDrag = e.value; if (e.value) { this.playing = false; this.pushUndo(); } });
    tc.addEventListener("objectChange", () => {
      if (!this.sel || !this.tc.dragging) return;
      if (this.mode === "move" && CHAINS[this.sel]) return this.dragEnd();
      const e = this.bones.get(this.sel), base = this.base.get(this.sel);
      if (base) this.selKey = this.setKey(this.sel, this.t, base.clone().invert().multiply(e.b.quaternion));   // auto-key
    });
    // move mode: a hoof / hand / foot is dragged by this target; its two joints follow (IK)
    this.target = new THREE.Object3D(); this.scene.add(this.target);
    this.mode = "rotate";
    // click a dot (a click, not the end of a camera drag)
    let downAt = null;
    this.renderer.domElement.addEventListener("pointerdown", (e) => { if (this.isOpen && e.button === 0) downAt = [e.clientX, e.clientY]; });
    this.renderer.domElement.addEventListener("pointerup", (e) => {
      if (!this.isOpen || !downAt || this.tc.dragging || this.D.gizmoDrag) { downAt = null; return; }
      const moved = Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]); downAt = null;
      if (moved > 4 || !this.dots.visible) return;
      const id = this.pick(e.clientX, e.clientY);
      if (id) this.select(id);
    });
    // hover: the joint's plain name beside the cursor
    let lastHover = 0;
    this.renderer.domElement.addEventListener("pointermove", (e) => {
      if (!this.isOpen || e.buttons || performance.now() - lastHover < 40) { if (e.buttons) this.tip.style.display = "none"; return; }
      lastHover = performance.now();
      const id = this.pick(e.clientX, e.clientY);
      if (!id) { this.tip.style.display = "none"; return; }
      const b = this.bones.get(id);
      const hitId = id;
      Object.assign(this.tip.style, { display: "block", left: e.clientX + 14 + "px", top: e.clientY - 8 + "px", borderLeftColor: `#${b.color.getHexString()}` });
      this.tip.textContent = b.name + (this.keysOf(hitId) ? "  ◆" : "");
    });
    this.renderer.domElement.addEventListener("pointerleave", () => (this.tip.style.display = "none"));
  }
  // the joint nearest the cursor on screen (within 16 px) — the dots are a few
  // pixels big at a normal zoom; hitting the sphere itself was near impossible
  pick(cx, cy) {
    if (!this.dots.visible) return null;
    const r = this.renderer.domElement.getBoundingClientRect(), p = new V3();
    let best = null, bd = 16;
    for (const id of this.ids) {
      if (!this.dotVisible(id)) continue;
      this.bones.get(id).b.getWorldPosition(p).project(this.camera);
      if (p.z > 1) continue;
      const d = Math.hypot(r.left + (p.x + 1) / 2 * r.width - cx, r.top + (1 - p.y) / 2 * r.height - cy);
      if (d < bd || (best && d < bd + 3 && id === this.sel)) { bd = d; best = id; }
    }
    return best;
  }
  dotVisible(id) { return this.showJ === "both" || id.startsWith(this.showJ + ":"); }
  select(id) {
    this.sel = id; this.selKey = null;
    const e = this.bones.get(id);
    this.attachGizmo();
    this.ui.bone.textContent = e.name + (CHAINS[id] ? (this.mode === "move" ? "  (drag it: the leg follows)" : "  (M: move it, the leg follows)") : "");
    this.ui.bone.style.color = `#${e.color.getHexString()}`;
  }
  // rotate: the gizmo on the joint itself; move (hooves, hands, feet): a target the leg reaches for
  attachGizmo() {
    if (!this.sel) return;
    const e = this.bones.get(this.sel);
    if (this.mode === "move" && CHAINS[this.sel]) {
      e.b.getWorldPosition(this.target.position); this.target.updateMatrixWorld();
      this.tc.setMode("translate"); this.tc.setSpace("world"); this.tc.attach(this.target);
    } else { this.tc.setMode("rotate"); this.tc.setSpace("local"); this.tc.attach(e.b); }
    this.tc.getHelper().visible = true;
  }
  setMode(m) {
    this.mode = m;
    this.ui.mode.textContent = m === "move" ? "✥ move" : "⟲ rotate";
    this.ui.mode.classList.toggle("on", m === "move");
    if (this.sel) this.select(this.sel);
    if (m === "move" && this.sel && !CHAINS[this.sel]) this.msg("move works on hooves, hocks, front knees, hands and feet — pick one of those");
  }
  // the end dragged: the two joints above it bend so it reaches the target (the
  // bend stays on the side it already has), both keyed here
  dragEnd() {
    const [uId, lId] = CHAINS[this.sel], up = this.bones.get(uId), lo = this.bones.get(lId), end = this.bones.get(this.sel);
    if (!up || !lo) return;
    const c = this.ctrl, fwd = new V3(Math.sin(c.yaw), 0, Math.cos(c.yaw));
    end.b.updateWorldMatrix(true, false);
    const C = end.b.getWorldPosition(new V3());
    solveTwoBone(up.b, lo.b, C, this.target.position.clone(), fwd, new V3());
    if (end.who === "H") this.ctrl.glueHooves();
    for (const [id, e] of [[uId, up], [lId, lo]]) {
      const base = this.base.get(id); if (!base) continue;
      this.setKey(id, this.t, base.clone().invert().multiply(e.b.quaternion));
    }
    up.b.updateMatrixWorld(true);
  }

  // ── reference overlay ────────────────────────────────────────────────────
  setRef(name) {
    this.refName = name || null;
    if (!name) { this.refImg.style.display = "none"; return; }
    this.refImg.onload = () => this.placeRef();
    this.refImg.src = `/v3/horse-lab/refs/${name}.png`;
  }
  panelH() { return this.el.offsetHeight; }
  placeRef() {
    const im = this.refImg;
    if (!this.isOpen || !this.refName || !im.naturalWidth) { im.style.display = "none"; return; }
    const hv = innerHeight - this.panelH(), w = hv * im.naturalWidth / im.naturalHeight;
    Object.assign(im.style, { display: "block", top: "0px", height: hv + "px", width: w + "px", left: (innerWidth - w) / 2 + "px" });
  }
  fit() {
    const name = this.refName;
    if (!REAR_REFS[name]) return this.msg("pick rear1–rear4 in ref first");
    const H = { ctrl: this.ctrl, horse: this.ctrl.h, rider: this.rider };
    const view = { W: innerWidth, Hh: innerHeight, ph: this.panelH() };
    let best = null, q0 = null;
    this.restore(); this.simDirty = true;
    for (let t = 0.1; t <= rearLength() - HP.rearSettle; t += 0.05) {
      this.simTo(t);
      const f = rearViewFit(H, name, view, q0); q0 = f.q;
      if (!best || f.rms < best.rms) best = { ...f, t };
    }
    this.t = best.t; this.simTo(best.t);
    const c = this.ctrl, want = new V3(c.pos.x, c.y + c.lift * 0.6 + 1.8, c.pos.z);
    const d = best.pos.clone().sub(best.look), dist = d.length();
    this.camState.set({ yaw: Math.atan2(-d.x, -d.z), pitch: Math.asin(d.y / dist), dist, pan: best.look.clone().sub(want).toArray(), fov: best.fov });
    this.msg(`${name}: matches our rear at ${best.t.toFixed(2)} s (±${best.rms.toFixed(0)} px) — pose the joints onto the picture`);
  }

  // ── the rear, scrubbed: replayed at a fixed 1/60 s ────────────────────────
  simTo(t) {
    const c = this.ctrl, rd = this.rider, DT = 1 / 60, idle = { fwd: 0, turn: 0, run: false };
    const st = () => { c.update(DT, idle); rd.update(DT, { lookYaw: 0, input: {} }); };
    if (this.simDirty || this.simT == null || t < this.simT - 1e-6) {
      if (c.oneShot) c.endOneShot(); c.refusing = false; c.v = 0; c.idleT = -1e9;
      for (let i = 0; i < 600 && (c.rearT >= 0 || c.rearA > 0); i++) st();   // an earlier rear runs out first
      for (let i = 0; i < 20; i++) st();
      c.startRear(); this.simT = 0; this.simDirty = false;
    }
    while (this.simT < t - 1e-6) { st(); this.simT += DT; }
  }

  // ── open / close / per frame ─────────────────────────────────────────────
  open() {
    if (this.isOpen) return;
    this.isOpen = true; this.D.editing = true;
    const ms = this.rider.mountSys, rd = this.rider;
    if (ms.mode !== "riding") { ms.edit = null; ms.mode = "riding"; ms.blend = null; rd.seatY = null; rd.sitAction.reset().play(); ms.cur?.stop(); ms.cur = null; }
    this.el.style.display = "block"; this.dots.visible = true; this.legend.style.display = "block";
    this.simDirty = true; this.playing = false;
    if (document.pointerLockElement) document.exitPointerLock();
    this.msg("click a joint, turn it: a key is set here · drag on the timeline to scrub · Space plays");
  }
  close() {
    if (!this.isOpen) return;
    this.restore();
    this.isOpen = false; this.D.editing = false; this.D.gizmoDrag = false;
    this.el.style.display = "none"; this.dots.visible = false; this.refImg.style.display = "none"; this.legend.style.display = "none"; this.tip.style.display = "none";
    this.tc.detach(); this.tc.getHelper().visible = false;
    this.camera.clearViewOffset();
    if (this.dirty) console.warn("[pose editor] unsaved keys (💾 save keeps them)");
  }
  toggle() { this.isOpen ? this.close() : this.open(); }
  togglePlay() { this.playing = !this.playing; if (this.playing && this.t >= rearLength() - 1e-3) this.t = 0; }

  onKey(e) {
    const k = e.key;
    if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return false;
    if (k === " ") { e.preventDefault(); this.togglePlay(); }
    else if (k === "ArrowLeft" || k === "ArrowRight") { e.preventDefault(); this.playing = false; this.t = THREE.MathUtils.clamp(Math.round((this.t + (k === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 6 : 1) / FPS) * FPS) / FPS, 0, rearLength()); }
    else if (k === "Home") this.t = 0;
    else if (k === "End") this.t = rearLength();
    else if (k === "Delete" || k === "Backspace") this.deleteKey();
    else if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === "z") { e.preventDefault(); this.doUndo(); }
    else if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === "s") { e.preventDefault(); this.save(); }
    else if (k.toLowerCase() === "k") this.keyHere();
    else if (k.toLowerCase() === "m") this.setMode(this.mode === "move" ? "rotate" : "move");
    else if (k.toLowerCase() === "j" || k === "Escape") this.close();
    return true;                                            // the game ignores keys while editing
  }

  // before ctrl.update: the layer off, the rear stepped to the editor's time
  update(dt) {
    this.restore();
    if (!this.isOpen) return;
    const dur = rearLength();
    if (this.playing) { this.t += dt * this.speed; if (this.t > dur) { if (this.loop) this.t = 0; else { this.t = dur; this.playing = false; } } }
    this.simTo(this.t);
    this.ui.play.textContent = this.playing ? "❚❚" : "▶";
    this.ui.time.textContent = `${this.t.toFixed(2)} / ${dur.toFixed(2)} s · f${Math.round(this.t * FPS)} · body ${(this.ctrl.rearPitch * 57.3).toFixed(0)}°`;
    this.camera.setViewOffset(innerWidth, innerHeight, 0, this.panelH() / 2, innerWidth, innerHeight);
    this.placeRef();
  }
  // after the rider: the dots where the joints are, the timeline
  afterFrame() {
    if (!this.isOpen) return;
    // move mode: the target sits on the hoof / hand / foot until dragged
    if (this.mode === "move" && this.sel && CHAINS[this.sel] && !this.tc.dragging) { this.bones.get(this.sel).b.getWorldPosition(this.target.position); this.target.updateMatrixWorld(); }
    const m = new THREE.Matrix4(), p = new V3(), cam = this.camera.position;
    const sel = new THREE.Color(0xffffff);
    this.ids.forEach((id, i) => {
      const e = this.bones.get(id), vis = this.dotVisible(id);
      e.b.getWorldPosition(p);
      const s = vis ? (id === this.sel ? 0.042 : this.keysOf(id) ? 0.036 : 0.028) * Math.max(0.6, Math.min(2.5, p.distanceTo(cam) / 4)) : 0;   // keyed joints: bigger
      m.makeScale(s, s, s).setPosition(p);
      this.dots.setMatrixAt(i, m);
      this.dots.setColorAt(i, id === this.sel ? sel : e.color);
    });
    this.dots.instanceMatrix.needsUpdate = true; this.dots.instanceColor.needsUpdate = true;
    this.drawTimeline();
  }

  drawTimeline() {
    const cv = this.cv;
    if (this.el.classList.contains("min")) return;
    const dpr = devicePixelRatio, W = cv.clientWidth, H = cv.clientHeight;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const g = cv.getContext("2d"), X = this.toX, dur = rearLength();
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    g.font = "10px system-ui"; g.textBaseline = "middle";
    // ruler
    g.fillStyle = "#1b2229"; g.fillRect(0, 0, W, RULER);
    for (let t = 0; t <= dur + 1e-6; t += 0.1) {
      const x = X(t), major = Math.abs(t * 2 - Math.round(t * 2)) < 1e-6;
      g.strokeStyle = major ? "#3d4955" : "#252e37"; g.beginPath(); g.moveTo(x, major ? 6 : 12); g.lineTo(x, H); g.stroke();
      if (major) { g.fillStyle = "#8fa0ad"; g.fillText(t.toFixed(1), x + 3, 8); }
    }
    // the rear's phases
    let t0 = 0;
    for (const [nm, d, col] of [["gather", HP.rearPrep, "#33424f"], ["rise", HP.rearRise, "#3f5a33"], ["up", HP.rearHold, "#5a4c26"], ["down", HP.rearFall, "#4f3442"], ["settle", HP.rearSettle, "#2c343c"]]) {
      g.fillStyle = col; g.fillRect(X(t0), RULER + 2, X(t0 + d) - X(t0), ROW - 4); g.fillStyle = "#c9d4dc"; g.fillText(nm, X(t0) + 3, RULER + ROW / 2); t0 += d;
    }
    g.fillStyle = "#8fa0ad"; g.fillText("rear (R)", 6, RULER + ROW / 2);
    // one row per keyed joint (+ the selected one)
    const set = this.data[this.clip] ?? {};
    const rows = this.rows = Object.keys(set).sort();
    if (this.sel && !rows.includes(this.sel)) rows.unshift(this.sel);
    const fit = Math.floor((H - RULER - ROW) / ROW);
    this.scroll = Math.min(this.scroll, Math.max(0, rows.length - fit));
    rows.slice(this.scroll, this.scroll + fit).forEach((id, i) => {
      const y = RULER + ROW + i * ROW, e = this.bones.get(id);
      g.fillStyle = id === this.sel ? "rgba(59,110,168,0.25)" : i % 2 ? "rgba(255,255,255,0.025)" : "transparent"; g.fillRect(0, y, W, ROW);
      g.fillStyle = e ? `#${e.color.getHexString()}` : "#999"; g.fillText((e?.name ?? id).slice(0, 19), 6, y + ROW / 2);
      for (const k of set[id] ?? []) {
        const x = X(k[0]), cy = y + ROW / 2, r = k === this.selKey ? 6 : 4.5;
        g.beginPath(); g.moveTo(x, cy - r); g.lineTo(x + r, cy); g.lineTo(x, cy + r); g.lineTo(x - r, cy); g.closePath();
        g.fillStyle = k === this.selKey ? "#fff" : "#ffe066"; g.fill(); g.strokeStyle = "#0d1115"; g.stroke();
      }
    });
    if (!rows.length) { g.fillStyle = "#6f7f8c"; g.fillText("no keys yet — click a joint in the view and turn it", LABEL, RULER + ROW * 1.6); }
    const px = X(this.t);
    g.strokeStyle = "#ff4d4d"; g.lineWidth = 2; g.beginPath(); g.moveTo(px, 0); g.lineTo(px, H); g.stroke(); g.lineWidth = 1;
  }
}
