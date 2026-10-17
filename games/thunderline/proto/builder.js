// Thunderline prototype P1/P2 — grey-box builder. Throwaway: it exists to answer DESIGN.md §9 P1/P2.
import * as THREE from "three/webgpu";
import { FAMILIES, CELL, STEP, ROAD_HW, FWD, rightOf, layout, predict, toWorld, dirToWorld, clampParams, MAX_GRADE } from "./pieces.js";

const $ = (id) => document.getElementById(id);
const STORE = "thunderline.proto.p1.track";
const kmh = (v) => Math.round(v * 3.6);

// ---------- state ----------
const DEFAULT_TRACK = { start: { x: 0, y: 20, z: 0, h: 0 }, pieces: [{ fam: "road", p: { size: 6 } }] };
let track = load() ?? structuredClone(DEFAULT_TRACK);
let sel = null; // selected piece index, or null = build at the end
let draft = null; // { fam, p } preview to insert after `sel ?? last`
const lastParams = {}; // remembered per family, so repeated pieces are one key each
let undo = [];
let redo = [];
let lastEditKey = null;
let lastEditTime = 0;

function load() {
  try { return JSON.parse(localStorage.getItem(STORE)); } catch { return null; }
}
function save() {
  try { localStorage.setItem(STORE, JSON.stringify(track)); } catch {}
}
function snapshot(coalesceKey = null) {
  const now = performance.now();
  if (coalesceKey && coalesceKey === lastEditKey && now - lastEditTime < 1500) { lastEditTime = now; return; }
  lastEditKey = coalesceKey;
  lastEditTime = now;
  undo.push(JSON.stringify({ track, sel }));
  if (undo.length > 200) undo.shift();
  redo = [];
}
function restore(from, to) {
  if (!from.length) return;
  to.push(JSON.stringify({ track, sel }));
  const s = JSON.parse(from.pop());
  track = s.track;
  sel = s.sel;
  draft = null;
  lastEditKey = null;
  changed();
}

const insertAt = () => (sel ?? track.pieces.length - 1) + 1;

/** The track as shown: the real one with the draft inserted. */
function viewTrack() {
  if (!draft) return { t: track, draftIdx: -1 };
  const pieces = track.pieces.slice();
  const i = insertAt();
  pieces.splice(i, 0, { fam: draft.fam, p: draft.p, draft: true });
  return { t: { start: track.start, pieces }, draftIdx: i };
}

// ---------- three ----------
const renderer = new THREE.WebGPURenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
$("view").appendChild(renderer.domElement);
await renderer.init();

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9cc4e4);
scene.add(new THREE.HemisphereLight(0xdfeeff, 0x6b6a5e, 1.6));
const sun = new THREE.DirectionalLight(0xfff2dd, 2.2);
sun.position.set(-300, 600, 250);
scene.add(sun);

const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.5, 8000);
camera.position.set(-80, 120, -120);
const camLook = new THREE.Vector3();
const camWant = new THREE.Vector3();
const lookWant = new THREE.Vector3();
let zoom = 1;
let yawOff = 0;
let overview = false;

// Ground far below: only there to read heights (the footprint shadows lie on it).
const ground = new THREE.Mesh(new THREE.PlaneGeometry(6000, 6000), new THREE.MeshStandardMaterial({ color: 0xb9c4b0, roughness: 1 }));
ground.rotation.x = -Math.PI / 2;
scene.add(ground);
const groundGrid = new THREE.GridHelper(4096, 512, 0x9aa592, 0xa9b4a1);
groundGrid.position.y = 0.02;
scene.add(groundGrid);
// A grid at the build height around the focus, so the cells are visible where you build.
const buildGrid = new THREE.GridHelper(CELL * 24, 24, 0x2c6f8a, 0x4f8fa6);
buildGrid.material.transparent = true;
buildGrid.material.opacity = 0.55;
scene.add(buildGrid);

const trackGroup = new THREE.Group();
scene.add(trackGroup);
const matTrack = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 });
const matDraft = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, transparent: true, opacity: 0.72 });
const matFoot = new THREE.MeshBasicMaterial({ color: 0x1b2620, transparent: true, opacity: 0.22, depthWrite: false });
const matLine = new THREE.LineBasicMaterial({ color: 0x3a4a55, transparent: true, opacity: 0.5 });

// Cross-section (x right, y up), closed, wound so normals face out (see buildRingMesh).
const PROFILE = [[-8.4, -0.8], [-8.4, 1.0], [-8.0, 1.0], [-8.0, 0], [8.0, 0], [8.0, 1.0], [8.4, 1.0], [8.4, -0.8]];
const DECK_EDGE = 3; // profile edge index of the deck top

const C = {
  deckA: new THREE.Color(0x8d929b), deckB: new THREE.Color(0x7d828b), rail: new THREE.Color(0xc4c8cf), side: new THREE.Color(0x5c6068),
  cp: new THREE.Color(0xe2c552), boost: new THREE.Color(0x4fd0e0), sel: new THREE.Color(0xffa938), draft: new THREE.Color(0x59d6ea), bad: new THREE.Color(0xff4b4b),
};

let view = null; // { t, draftIdx, laid, pred, rings[], overlaps:Set, ride[] }

function buildView() {
  const { t, draftIdx } = viewTrack();
  const laid = layout(t);
  const pred = predict(laid);
  const rings = laid.map((L) => framesFor(L));
  const ride = [];
  // ride path in the same order as predict's pts
  let k = 0;
  laid.forEach((L, i) => {
    const rs = rings[i];
    for (let j = i === 0 ? 0 : 1; j < rs.length; j++, k++) ride.push({ ...rs[j], v: pred.speeds[k], i });
  });
  const overlaps = findOverlaps(laid, rings);
  view = { t, draftIdx, laid, pred, rings, overlaps, ride };
}

/** World frames per sample: P (road centre, after low-edge raise), R, U, T, d, air. */
function framesFor(L) {
  const s = L.built.samples;
  const P = s.map((x) => new THREE.Vector3(...toWorld(L.entry, x.p)));
  return s.map((x, j) => {
    const a = P[Math.max(0, j - 1)];
    const b = P[Math.min(P.length - 1, j + 1)];
    const T = b.clone().sub(a).normalize();
    const U0 = new THREE.Vector3(...dirToWorld(L.entry, x.up));
    let R = new THREE.Vector3().crossVectors(T, U0).normalize();
    let U = new THREE.Vector3().crossVectors(R, T).normalize();
    const pos = P[j].clone();
    if (x.roll) {
      const c = Math.cos(x.roll);
      const sn = Math.sin(x.roll);
      const U2 = U.clone().multiplyScalar(c).addScaledVector(R, sn);
      const R2 = R.clone().multiplyScalar(c).addScaledVector(U, -sn);
      if (x.lowEdge) pos.addScaledVector(U, ROAD_HW * Math.abs(sn)); // inner edge stays on the plane
      U = U2;
      R = R2;
    }
    return { P: pos, R, U, T, d: x.d, air: !!x.air };
  });
}

/** Pieces whose road passes through the same cells as a non-neighbour, at a similar height. */
function findOverlaps(laid, rings) {
  const occ = new Map();
  const bad = new Set();
  rings.forEach((rs, i) => {
    const seen = new Set();
    for (const r of rs) {
      for (const off of [-6, -2, 2, 6]) {
        const x = r.P.x + r.R.x * off;
        const z = r.P.z + r.R.z * off;
        const key = `${Math.round(x / 4)},${Math.round(z / 4)}`;
        const tag = `${key}:${Math.round(r.P.y)}`;
        if (seen.has(tag)) continue;
        seen.add(tag);
        const list = occ.get(key);
        if (list) {
          for (const o of list) {
            if (Math.abs(o.i - i) <= 1) continue;
            if (Math.abs(o.y - r.P.y) < 6) { bad.add(i); bad.add(o.i); }
          }
          list.push({ i, y: r.P.y });
        } else occ.set(key, [{ i, y: r.P.y }]);
      }
    }
  });
  return bad;
}

function buildRingMesh(rs, colorOf, mat) {
  const pos = [];
  const col = [];
  const idx = [];
  const tmp = new THREE.Vector3();
  for (let e = 0; e < PROFILE.length; e++) {
    const pa = PROFILE[e];
    const pb = PROFILE[(e + 1) % PROFILE.length];
    let prev = -1;
    for (let j = 0; j < rs.length; j++) {
      const r = rs[j];
      if (r.air) { prev = -1; continue; }
      const base = pos.length / 3;
      for (const p of [pa, pb]) {
        tmp.copy(r.P).addScaledVector(r.R, p[0]).addScaledVector(r.U, p[1]);
        pos.push(tmp.x, tmp.y, tmp.z);
        const c = colorOf(e, r);
        col.push(c.r, c.g, c.b);
      }
      // (a0, b0, a1) has normal (profile edge dir) × T, i.e. outward for this winding
      if (prev >= 0) idx.push(prev, prev + 1, base, prev + 1, base + 1, base);
      prev = base;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return new THREE.Mesh(g, mat);
}

function buildFootprint(rs) {
  const pos = [];
  const idx = [];
  let prev = -1;
  for (const r of rs) {
    if (r.air) { prev = -1; continue; }
    const base = pos.length / 3;
    for (const s of [-ROAD_HW, ROAD_HW]) pos.push(r.P.x + r.R.x * s, 0.06, r.P.z + r.R.z * s);
    if (prev >= 0) idx.push(prev, base, prev + 1, prev + 1, base, base + 1);
    prev = base;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return new THREE.Mesh(g, matFoot);
}

function gate(r, color) {
  const g = new THREE.Group();
  const m = new THREE.MeshStandardMaterial({ color, roughness: 0.6 });
  const post = new THREE.BoxGeometry(0.8, 7, 0.8);
  for (const s of [-9, 9]) {
    const p = new THREE.Mesh(post, m);
    p.position.set(s, 3.5, 0);
    g.add(p);
  }
  const ban = new THREE.Mesh(new THREE.BoxGeometry(18.8, 1.6, 0.5), m);
  ban.position.set(0, 6.6, 0);
  g.add(ban);
  g.matrixAutoUpdate = false;
  g.matrix.makeBasis(r.R.clone().negate(), r.U, r.T).setPosition(r.P);
  return g;
}

function rebuildScene() {
  for (const c of trackGroup.children.slice()) {
    trackGroup.remove(c);
    c.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
  }
  const { laid, rings, draftIdx, overlaps } = view;
  const lines = [];
  laid.forEach((L, i) => {
    const pc = L.piece;
    const isDraft = i === draftIdx;
    const isSel = !draft && i === sel;
    const bad = overlaps.has(i) || !!L.built.warn || (L.built.grade ?? 0) > MAX_GRADE || !!view.pred.perPiece[i].warn;
    const tint = isDraft ? (bad ? C.bad : C.draft) : isSel ? C.sel : null;
    const colorOf = (e, r) => {
      let c;
      if (e === DECK_EDGE) c = pc.boost ? C.boost : pc.cp ? C.cp : Math.floor(r.d / CELL) % 2 ? C.deckB : C.deckA;
      else if (e === 1 || e === 5) c = C.rail;
      else c = C.side;
      if (bad && !isDraft) c = c.clone().lerp(C.bad, 0.45);
      return tint ? c.clone().lerp(tint, isDraft ? 0.75 : 0.5) : c;
    };
    const mesh = buildRingMesh(rings[i], colorOf, isDraft ? matDraft : matTrack);
    mesh.userData.idx = isDraft ? -1 : i - (draftIdx >= 0 && i > draftIdx ? 1 : 0);
    mesh.userData.isDraft = isDraft;
    trackGroup.add(mesh);
    trackGroup.add(buildFootprint(rings[i]));
    const e = rings[i][0].P;
    lines.push(e.x, e.y, e.z, e.x, 0, e.z);
    if (pc.cp) trackGroup.add(gate(rings[i][Math.floor(rings[i].length / 2)], 0xf0cf40));
  });
  if (laid.length) {
    trackGroup.add(gate(rings[0][0], 0x3ccf6a));
    const last = rings[rings.length - 1];
    trackGroup.add(gate(last[last.length - 1], 0x111111));
  }
  const lg = new THREE.BufferGeometry();
  lg.setAttribute("position", new THREE.Float32BufferAttribute(lines, 3));
  trackGroup.add(new THREE.LineSegments(lg, matLine));
}

// ---------- UI ----------
function speedColor(v) {
  const t = Math.max(0, Math.min(1, (v - 15) / 50)); // 54 → 234 km/h
  return `hsl(${Math.round(t * 125)}, 70%, ${55 + t * 5}%)`;
}

function renderPalette() {
  const pal = $("palette");
  pal.innerHTML = "";
  for (const [id, F] of Object.entries(FAMILIES)) {
    const b = document.createElement("button");
    b.innerHTML = `<span class="ic">${F.icon}</span>${F.label}<span class="k">${F.key}</span>`;
    if (draft?.fam === id) b.classList.add("on");
    b.onclick = () => startDraft(id);
    pal.appendChild(b);
  }
  pal.appendChild(document.createElement("hr"));
  const flag = (label, key, fn) => {
    const b = document.createElement("button");
    b.innerHTML = `<span class="ic">${label[0]}</span>${label.slice(2)}<span class="k">${key}</span>`;
    b.onclick = fn;
    pal.appendChild(b);
  };
  flag("◆ Checkpoint", "C", () => toggleFlag("cp"));
  flag("» Boost", "B", () => toggleFlag("boost"));
}

function renderTools() {
  const tools = $("tools");
  tools.innerHTML = "";
  const btn = (label, fn) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.onclick = fn;
    tools.appendChild(b);
  };
  btn("▶ Ride (P)", () => startRide());
  btn("Overview (O)", () => { overview = !overview; });
  btn("Undo", () => restore(undo, redo));
  btn("Redo", () => restore(redo, undo));
  btn("Copy code", exportCode);
  btn("Paste code", importCode);
  btn("New", () => { snapshot(); track = structuredClone(DEFAULT_TRACK); sel = null; draft = null; changed(); });
}

function renderStats() {
  const { pred, laid } = view;
  const real = view.draftIdx >= 0 ? pred.total - pred.perPiece[view.draftIdx].time : pred.total;
  let len = 0;
  laid.forEach((L, i) => { if (i !== view.draftIdx) len += L.built.L; });
  const code = encode(track);
  $("stats").innerHTML =
    `<b>${track.pieces.length}</b> pieces · <b>${Math.round(len)}</b> m · predicted <b>${real.toFixed(2)} s</b>` +
    ` · code <b>${code.length}</b> chars`;
}

function renderParams() {
  const el = $("params");
  const target = draft ? { fam: draft.fam, p: draft.p, i: view.draftIdx } : sel !== null ? { ...track.pieces[sel], i: sel } : null;
  if (!target) { el.classList.remove("show"); return; }
  el.classList.add("show");
  const F = FAMILIES[target.fam];
  const p = clampParams(target.fam, target.p);
  const L = view.laid[target.i];
  const pp = view.pred.perPiece[target.i];
  const warns = [];
  if (view.overlaps.has(target.i)) warns.push("overlaps the track");
  if (L.built.warn) warns.push(L.built.warn);
  if (pp.warn) warns.push(pp.warn);
  if ((L.built.grade ?? 0) > MAX_GRADE) warns.push("too steep");
  if (target.fam === "jump" && Math.abs(p.v - pp.vIn) > 3) warns.push(`fitted for ${kmh(p.v)}, you arrive at ${kmh(pp.vIn)} km/h (F = refit)`);
  const has = (k) => k in F.defaults;
  el.innerHTML = "";
  const add = (html, fn, cls) => {
    const b = document.createElement(fn ? "button" : "span");
    b.innerHTML = html;
    if (cls) b.className = cls;
    if (fn) b.onclick = fn;
    el.appendChild(b);
  };
  add(draft ? F.label : `${F.label} #${sel + 1}`, null, draft ? "name" : "name sel");
  add(F.describe(p), null, "desc");
  if (has("bend")) { add("◀ L", () => edit("bend", -1)); add("R ▶", () => edit("bend", +1)); }
  add("− size", () => edit("size", -1));
  add("+ size", () => edit("size", +1));
  if (has("rise")) { add("▼", () => edit("rise", -1)); add("▲", () => edit("rise", +1)); }
  add(`${kmh(pp.vIn)}→${kmh(pp.vOut)} km/h`, null, "desc");
  if (warns.length) add("⚠ " + warns.join(" · "), null, "warn");
  if (draft) { add("Place ⏎", commitDraft, "place"); add("Esc", () => { draft = null; changed(); }); }
  else add("Delete", deleteSel);
}

function renderTimeline() {
  const tl = $("timeline");
  tl.innerHTML = "";
  const { t, draftIdx, pred } = view;
  t.pieces.forEach((pc, i) => {
    const F = FAMILIES[pc.fam];
    const chip = document.createElement("div");
    const pp = pred.perPiece[i];
    chip.className = "chip";
    if (i === draftIdx) chip.classList.add("draft");
    const realIdx = draftIdx >= 0 && i > draftIdx ? i - 1 : i;
    if (i !== draftIdx && !draft && realIdx === sel) chip.classList.add("sel");
    if (pc.cp) chip.classList.add("cp");
    if (view.overlaps.has(i) || pp.warn || view.laid[i].built.warn) chip.classList.add("bad");
    const vShow = i === 0 ? pp.vOut : pp.vMin; // the start piece begins standing still
    chip.style.background = speedColor(vShow);
    chip.innerHTML = `<span class="t">${F.icon}${pc.boost ? "»" : ""}</span><span>${F.describe(clampParams(pc.fam, pc.p))}</span><span>${kmh(vShow)}</span>`;
    chip.title = `${F.label}: ${kmh(pp.vIn)} → ${kmh(pp.vOut)} km/h, ${pp.time.toFixed(2)} s`;
    if (i !== draftIdx) chip.onclick = () => { draft = null; sel = realIdx; changed(); };
    tl.appendChild(chip);
    if (!draft && sel === realIdx && i !== draftIdx) {
      const c = document.createElement("div");
      c.className = "caret";
      tl.appendChild(c);
    }
  });
  const active = tl.querySelector(".draft, .sel");
  if (active) active.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function changed() {
  save();
  buildView();
  rebuildScene();
  renderPalette();
  renderParams();
  renderTimeline();
  renderStats();
}

// ---------- editing ----------
function startDraft(fam) {
  const F = FAMILIES[fam];
  const p = { ...F.defaults, ...(lastParams[fam] ?? {}) };
  draft = { fam, p };
  if (fam === "jump") fitJump(draft.p, insertAt());
  changed();
}

/** Predicted arrival speed at track index i (with the current track, no draft). */
function arrivalSpeed(i) {
  const laid = layout({ start: track.start, pieces: track.pieces.slice(0, i) });
  if (!laid.length) return 0;
  const pr = predict(laid);
  return pr.perPiece[pr.perPiece.length - 1].vOut;
}
function fitJump(p, i) {
  p.v = Math.round(Math.max(arrivalSpeed(i), 15) * 2) / 2;
}

function edit(key, delta) {
  const tgt = draft ? draft : sel !== null ? track.pieces[sel] : null;
  if (!tgt) return;
  const F = FAMILIES[tgt.fam];
  if (!(key in F.defaults)) return;
  if (!draft) snapshot(`edit:${sel}`);
  const p = { ...F.defaults, ...tgt.p };
  if (key === "bend") {
    p.bend = tgt.fam === "road" ? Math.max(-1, Math.min(1, p.bend + delta)) : delta;
  } else if (key === "size") {
    p.size += delta * (F.sizeStep ?? 1);
  } else p[key] += delta;
  tgt.p = clampParams(tgt.fam, p);
  if (draft) lastParams[tgt.fam] = { ...tgt.p };
  changed();
}

function commitDraft() {
  if (!draft) return;
  snapshot();
  const i = insertAt();
  const pc = { fam: draft.fam, p: clampParams(draft.fam, draft.p) };
  track.pieces.splice(i, 0, pc);
  lastParams[draft.fam] = { ...pc.p };
  if (sel !== null) sel = i;
  // keep stamping the same piece: a fresh draft after the one just placed
  const fam = draft.fam;
  draft = null;
  startDraft(fam);
}

function deleteSel() {
  if (sel === null || track.pieces.length <= 1) return;
  snapshot();
  track.pieces.splice(sel, 1);
  sel = sel > 0 ? sel - 1 : null;
  changed();
}

function toggleFlag(k) {
  const tgt = draft ? draft : sel !== null ? track.pieces[sel] : track.pieces[track.pieces.length - 1];
  if (!draft) snapshot();
  tgt[k] = !tgt[k];
  changed();
}

// ---------- track code ----------
const FAM_IDS = Object.keys(FAMILIES);
function encode(t) {
  const arr = [t.start.x, t.start.y, t.start.z, t.start.h, ...t.pieces.flatMap((pc) => {
    const p = clampParams(pc.fam, pc.p);
    return [FAM_IDS.indexOf(pc.fam) | (pc.cp ? 8 : 0) | (pc.boost ? 16 : 0), p.size, p.bend ?? 0, p.rise ?? 0, Math.round((p.v ?? 0) * 2)];
  })];
  return "TL1." + btoa(arr.join(",")).replace(/=+$/, "");
}
function decode(code) {
  const a = atob(code.replace(/^TL1\./, "")).split(",").map(Number);
  const t = { start: { x: a[0], y: a[1], z: a[2], h: a[3] }, pieces: [] };
  for (let i = 4; i + 4 < a.length + 0; i += 5) {
    const f = a[i];
    const fam = FAM_IDS[f & 7];
    t.pieces.push({ fam, p: { size: a[i + 1], bend: a[i + 2], rise: a[i + 3], v: a[i + 4] / 2 }, cp: !!(f & 8), boost: !!(f & 16) });
  }
  return t;
}
function exportCode() {
  const code = encode(track);
  navigator.clipboard?.writeText(code).catch(() => {});
  prompt("Track code (copied):", code);
}
function importCode() {
  const code = prompt("Paste a track code:");
  if (!code) return;
  try { const t = decode(code.trim()); snapshot(); track = t; sel = null; draft = null; changed(); } catch (e) { alert("Bad code: " + e.message); }
}

// ---------- ride ----------
let ride = null; // { s (index float), car }
const car = new THREE.Mesh(new THREE.BoxGeometry(1.9, 1.1, 4.4), new THREE.MeshStandardMaterial({ color: 0xff6a1a, roughness: 0.4 }));
car.visible = false;
scene.add(car);

function startRide() {
  draft = null;
  changed();
  let k = 0;
  if (sel !== null) k = Math.max(0, view.ride.findIndex((r) => r.i === sel));
  ride = { k, t: 0, time: 0 };
  car.visible = true;
  $("ridehud").style.display = "block";
}
function stopRide() {
  ride = null;
  car.visible = false;
  $("ridehud").style.display = "none";
  camera.fov = 55;
  camera.updateProjectionMatrix();
}

function stepRide(dt) {
  const R = view.ride;
  let remaining = dt;
  while (remaining > 0 && ride.k < R.length - 1) {
    const a = R[ride.k];
    const b = R[ride.k + 1];
    const seg = a.P.distanceTo(b.P) || 1e-3;
    const v = Math.max((a.v + b.v) / 2, 1);
    const left = (1 - ride.t) * seg / v;
    if (left > remaining) { ride.t += (remaining * v) / seg; ride.time += remaining; remaining = 0; }
    else { remaining -= left; ride.time += left; ride.k++; ride.t = 0; }
  }
  const a = R[ride.k];
  const b = R[Math.min(ride.k + 1, R.length - 1)];
  const P = a.P.clone().lerp(b.P, ride.t);
  const U = a.U.clone().lerp(b.U, ride.t).normalize();
  const T = a.T.clone().lerp(b.T, ride.t).normalize();
  const Rr = new THREE.Vector3().crossVectors(T, U).normalize();
  const v = a.v + (b.v - a.v) * ride.t;
  car.matrixAutoUpdate = false;
  car.matrix.makeBasis(Rr.clone().negate(), U, T).setPosition(P.clone().addScaledVector(U, 0.75));
  // chase camera: world-level view, boom behind along travel (the old game's rule: the car rotates, not the camera)
  const flatT = new THREE.Vector3(T.x, 0, T.z);
  if (flatT.lengthSq() < 0.04) flatT.copy(camLook).sub(camera.position).setY(0);
  flatT.normalize();
  camWant.copy(P).addScaledVector(flatT, -13).add(new THREE.Vector3(0, 4.5, 0));
  lookWant.copy(P).addScaledVector(flatT, 12).add(new THREE.Vector3(0, 1, 0));
  const k = 1 - Math.exp(-dt * 10);
  camera.position.lerp(camWant, k);
  camLook.lerp(lookWant, k);
  camera.lookAt(camLook);
  camera.fov = 62 + 16 * Math.min(1, v / 60);
  camera.updateProjectionMatrix();
  $("ridehud").textContent = `${kmh(v)} km/h · ${ride.time.toFixed(2)} s`;
  if (ride.k >= R.length - 1) { $("ridehud").textContent = `Finish ${ride.time.toFixed(2)} s`; ride.done = (ride.done ?? 0) + dt; if (ride.done > 1.5) stopRide(); }
}

// ---------- automatic builder camera ----------
function focusFrames() {
  if (overview) return null;
  const { rings, draftIdx } = view;
  let i;
  if (draftIdx >= 0) i = draftIdx;
  else if (sel !== null) i = sel;
  else i = rings.length - 1;
  return rings[i];
}

function updateBuildCamera(dt) {
  const fr = focusFrames();
  const box = new THREE.Box3();
  let fwd;
  if (!fr) {
    for (const rs of view.rings) for (const r of rs) box.expandByPoint(r.P);
    fwd = new THREE.Vector3(...FWD[track.start.h]);
  } else {
    for (const r of fr) box.expandByPoint(r.P);
    const end = fr[fr.length - 1];
    if (!draft && sel === null) box.expandByPoint(end.P.clone().addScaledVector(end.T, 40)); // look ahead of the head
    const a = fr[0].T;
    fwd = new THREE.Vector3(a.x + end.T.x, 0, a.z + end.T.z);
    if (fwd.lengthSq() < 1e-3) fwd.set(a.x, 0, a.z);
    fwd.normalize();
  }
  const c = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3()).length();
  const D = Math.max(55, size * (overview ? 0.9 : 1.15)) * zoom;
  const yaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yawOff);
  const back = fwd.clone().negate().applyQuaternion(yaw);
  const right = new THREE.Vector3().crossVectors(back, new THREE.Vector3(0, 1, 0));
  if (overview) camWant.copy(c).add(new THREE.Vector3(0.001, D * 1.1, D * 0.25));
  else camWant.copy(c).addScaledVector(back, D * 0.8).addScaledVector(right, D * 0.3).add(new THREE.Vector3(0, D * 0.62, 0));
  lookWant.copy(c);
  const k = 1 - Math.exp(-dt * 4);
  camera.position.lerp(camWant, k);
  camLook.lerp(lookWant, k);
  camera.lookAt(camLook);
  // build-height grid follows the head
  const head = view.laid.length ? view.laid[view.draftIdx >= 0 ? view.draftIdx : sel ?? view.laid.length - 1] : null;
  if (head) buildGrid.position.set(head.exit.x * CELL, head.exit.y * STEP + 0.05, head.exit.z * CELL);
}

// ---------- input ----------
addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT") return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === "z") { e.preventDefault(); restore(e.shiftKey ? redo : undo, e.shiftKey ? undo : redo); return; }
  if ((e.ctrlKey || e.metaKey) && k === "y") { e.preventDefault(); restore(redo, undo); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (ride) { if (k === "escape" || k === "p") stopRide(); return; }
  const digit = /^Digit([1-9])$/.exec(e.code) || /^Numpad([1-9])$/.exec(e.code);
  if (digit) {
    const fam = Object.entries(FAMILIES).find(([, F]) => F.key === digit[1]);
    if (fam) { startDraft(fam[0]); e.preventDefault(); }
    return;
  }
  switch (e.key) {
    case "ArrowLeft": edit("bend", -1); break;
    case "ArrowRight": edit("bend", +1); break;
    case "ArrowUp": edit("rise", +1); break;
    case "ArrowDown": edit("rise", -1); break;
    case "+": case "=": edit("size", +1); break;
    case "-": case "_": edit("size", -1); break;
    case "Enter": case " ": commitDraft(); break;
    case "Escape": if (draft) draft = null; else sel = null; overview = false; changed(); break;
    case "Delete": case "Backspace": if (draft) { draft = null; changed(); } else deleteSel(); break;
    case "Tab": {
      draft = null;
      const n = track.pieces.length;
      sel = sel === null ? (e.shiftKey ? n - 1 : 0) : (sel + (e.shiftKey ? -1 : 1) + n) % n;
      changed();
      break;
    }
    case "Home": draft = null; sel = null; changed(); break;
    default:
      if (k === "c") toggleFlag("cp");
      else if (k === "b") toggleFlag("boost");
      else if (k === "p") startRide();
      else if (k === "o") overview = !overview;
      else if (k === "f" && sel !== null && track.pieces[sel].fam === "jump") {
        snapshot(); fitJump(track.pieces[sel].p, sel); changed();
      } else return;
  }
  e.preventDefault();
});
addEventListener("keydown", (e) => { if (e.code === "NumpadAdd") edit("size", +1); if (e.code === "NumpadSubtract") edit("size", -1); });

const ray = new THREE.Raycaster();
let down = null;
renderer.domElement.addEventListener("pointerdown", (e) => { down = { x: e.clientX, y: e.clientY, b: e.button, yaw: yawOff }; });
renderer.domElement.addEventListener("pointermove", (e) => {
  if (down && down.b === 2) yawOff = down.yaw - (e.clientX - down.x) * 0.006;
});
renderer.domElement.addEventListener("pointerup", (e) => {
  const d = down;
  down = null;
  if (!d || d.b !== 0 || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6 || ride) return;
  ray.setFromCamera(new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1), camera);
  const hit = ray.intersectObjects(trackGroup.children.filter((m) => m.userData.idx !== undefined), false)[0];
  if (!hit) { if (!draft) { sel = null; changed(); } return; }
  if (hit.object.userData.isDraft) commitDraft();
  else { draft = null; sel = hit.object.userData.idx; changed(); }
});
renderer.domElement.addEventListener("contextmenu", (e) => e.preventDefault());
renderer.domElement.addEventListener("wheel", (e) => { zoom = Math.max(0.35, Math.min(4, zoom * Math.exp(e.deltaY * 0.001))); e.preventDefault(); }, { passive: false });
addEventListener("resize", () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });

// ---------- loop ----------
renderTools();
changed();
let last = performance.now();
renderer.setAnimationLoop(() => {
  const now = performance.now();
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (ride) stepRide(dt);
  else updateBuildCamera(dt);
  renderer.render(scene, camera);
});

// for my own checks from the console / MCP
window.__tl = {
  get track() { return track; }, get view() { return view; },
  set(t) { track = t; sel = null; draft = null; changed(); },
  encode, decode, startDraft, commitDraft, edit, startRide, stopRide,
};
