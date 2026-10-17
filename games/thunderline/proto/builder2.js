// Thunderline prototype P1b — the old kit's pieces and palette, placed with a snapping ghost.
// Throwaway: it answers DESIGN.md §9 P1b. The kit, presets, thumbnails and materials are imported
// from games/modular-road-v3 untouched (the parts bin).
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  buildPiece, socketMatrix, PIECE_PARAM_DEFAULTS, ROAD_PARAM_DEFAULTS, GUARDRAIL_PARAM_DEFAULTS, PIECE_BY_ID, isHandedPiece,
} from "../../modular-road-v3/modularRoadKit.js";
import { PALETTE_CATEGORIES, CATEGORY_PRESETS, categoryThumbnailKey } from "../../modular-road-v3/modularRoadBuilder.js";
import { bakeRoadThumbnails, createThumbnailSprites } from "../../modular-road-v3/modularRoadThumbnails.js";
import {
  createRoadMaterial, createGuardrailMaterial, createTunnelMaterial, createTubeMaterial, createDecorMaterial,
  createStartGateBodyMaterialForThumb, createStartGateGlowMaterialForThumb, createFinishGateGlowMaterialForThumb,
  createCheckpointGlowMaterialForThumb, createRoadGlassMaterial,
} from "../../modular-road-v3/modularRoadMaterial.js";

const $ = (id) => document.getElementById(id);
const STORE = "thunderline.proto.p1b.track";
const UP = new THREE.Vector3(0, 1, 0);
const G = 9.81;
const DEG = Math.PI / 180;
const SNAP_COLORS = { end: 0x5be37d, arc: 0xffa53d, local: 0xc78bff, world: 0x4fd4ee };
const GRID_STEPS = [1, 2, 4, 8];

// ---------- tiles ----------
const GAME_TILES = ["start_new", "checkpoint_new", "finish_new"];
const categories = [];
const tileByKey = new Map();
for (const cat of PALETTE_CATEGORIES) {
  let tiles = [];
  if (CATEGORY_PRESETS[cat.id]?.length) tiles = CATEGORY_PRESETS[cat.id].map((pr) => ({ key: pr.id, label: pr.label, base: pr.base, params: pr.params ?? {} }));
  else if (cat.id === "game") tiles = GAME_TILES.filter((id) => PIECE_BY_ID.has(id)).map((id) => ({ key: id, label: PIECE_BY_ID.get(id).label ?? id, base: id, params: {} }));
  if (!tiles.length) continue;
  for (const t of tiles) tileByKey.set(t.key, t);
  categories.push({ ...cat, tiles });
}

// ---------- state ----------
let track = load() ?? { pieces: [], nextUid: 1 };
let hand = 1; // +1 right, -1 left
let tile = null; // tile in hand
let sel = null; // selected uid (no tile in hand)
let gridMode = "world";
let gridStep = 4;
let buildY = 30;
const ghostRot = { yaw: 0, pitch: 0, roll: 0 }; // deg; yaw relative to the local grid in local mode
let jumpSpeed = 50; // m/s, for the flight arcs
let undo = [];
let redo = [];

function load() { try { return JSON.parse(localStorage.getItem(STORE)); } catch { return null; } }
function save() { try { localStorage.setItem(STORE, JSON.stringify(track)); } catch {} }
function snapshot() { undo.push(JSON.stringify(track)); if (undo.length > 200) undo.shift(); redo = []; }
function restore(from, to) {
  if (!from.length) return;
  to.push(JSON.stringify(track));
  track = JSON.parse(from.pop());
  sel = null;
  rebuild();
}

// ---------- renderer ----------
const renderer = new THREE.WebGPURenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
$("view").appendChild(renderer.domElement);
await renderer.init();

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9fc6e6);
scene.add(new THREE.HemisphereLight(0xdfeeff, 0x5d5a52, 1.5));
const sun = new THREE.DirectionalLight(0xfff1dc, 2.6);
sun.position.set(-300, 500, 200);
scene.add(sun);

const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.5, 6000);
camera.position.set(70, 95, 110);
// Centre the view in the space above the dock, not behind it.
const DOCK_H = 175;
function fitView() {
  camera.aspect = innerWidth / innerHeight;
  camera.setViewOffset(innerWidth, innerHeight, 0, DOCK_H / 2, innerWidth, innerHeight);
  camera.updateProjectionMatrix();
}
fitView();
const controls = new OrbitControls(camera, renderer.domElement);
controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
controls.zoomToCursor = true;
controls.enableDamping = true;
controls.dampingFactor = 0.12;
controls.target.set(0, buildY, 0);
controls.maxPolarAngle = Math.PI * 0.49;

// Grid at the build height (world or local), plus a far ground plane only to read heights.
const grid = new THREE.GridHelper(256, 64, 0x3a7f97, 0x5f97aa);
grid.material.transparent = true;
grid.material.opacity = 0.45;
scene.add(grid);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(8000, 8000), new THREE.MeshStandardMaterial({ color: 0xa9b8a0, roughness: 1 }));
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.05;
scene.add(ground);

// ---------- materials (the real ones) ----------
const mats = {
  road: createRoadMaterial(), rail: createGuardrailMaterial(), shell: createTunnelMaterial(), tube: createTubeMaterial(),
  decor: createDecorMaterial(), decorGate: createStartGateBodyMaterialForThumb(), decorGlow: createStartGateGlowMaterialForThumb(),
  finishGlow: createFinishGateGlowMaterialForThumb(), checkpointGlow: createCheckpointGlowMaterialForThumb(),
  glass: createRoadGlassMaterial({ transmission: 0, opacity: 0.32 }),
};

// ---------- thumbnails + palette ----------
let thumbs = null;
try {
  const items = [...tileByKey.values()].map((t) => ({ key: t.key, pieceId: t.base, params: t.params }));
  const baked = await bakeRoadThumbnails({ renderer, materials: mats, items, size: 160 });
  thumbs = createThumbnailSprites(baked);
} catch (e) {
  console.warn("[P1b] thumbnail bake failed", e);
}
$("boot").classList.add("gone");

// ---------- the dock (Thunderline's own UI: family tabs + piece cards) ----------
let activeCat = categories[0]?.id;
const catOfTile = new Map();
for (const c of categories) for (const t of c.tiles) catOfTile.set(t.key, c.id);
const BOLT_SVG = `<svg viewBox="0 0 16 16"><path fill="currentColor" d="M9.5 0 2 9h5l-1.5 7L14 6.5H9z"/></svg>`;

function pic(key, cls = "pic") {
  const el = document.createElement("div");
  el.className = cls;
  thumbs?.apply(el, key);
  return el;
}
function renderPalette() {
  const tabs = $("tabs");
  tabs.innerHTML = `<div class="brand cond">${BOLT_SVG}Build</div>`;
  for (const cat of categories) {
    const b = document.createElement("button");
    b.className = "tab" + (cat.id === activeCat ? " on" : "");
    b.innerHTML = `${cat.label}<span class="n">${cat.tiles.length}</span>`;
    b.onclick = () => { activeCat = cat.id; renderPalette(); };
    tabs.appendChild(b);
  }
  const sp = document.createElement("div");
  sp.className = "spacer";
  tabs.appendChild(sp);
  const hd = document.createElement("div");
  hd.className = "hand cond";
  hd.innerHTML = `<span style="color:var(--dim)">Hand</span>`;
  for (const [h, l] of [[-1, "L"], [1, "R"]]) {
    const b = document.createElement("button");
    b.textContent = l;
    if (hand === h) b.className = "on";
    b.onclick = () => { hand = h; renderPalette(); ghostDirty = true; };
    hd.appendChild(b);
  }
  tabs.appendChild(hd);

  const cat = categories.find((c) => c.id === activeCat);
  const cards = $("cards");
  cards.innerHTML = "";
  for (const t of cat?.tiles ?? []) {
    const b = document.createElement("button");
    b.className = "card cut" + (tile?.key === t.key ? " on" : "");
    b.title = t.label;
    b.appendChild(pic(t.key));
    const nm = document.createElement("span");
    nm.className = "nm";
    nm.textContent = t.label;
    b.appendChild(nm);
    b.onclick = () => pickTile(t.key);
    cards.appendChild(b);
  }
  cards.querySelector(".card.on")?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function pickTile(key, h = null) {
  tile = tileByKey.get(key) ?? null;
  if (h != null) hand = h;
  if (tile) activeCat = catOfTile.get(key) ?? activeCat;
  sel = null;
  ghostDirty = true;
  renderPalette();
  refreshSelection();
}

// ---------- building ----------
const trackGroup = new THREE.Group();
scene.add(trackGroup);
let built = new Map(); // uid → { exit: Matrix4, group, entry: Matrix4 }

function paramsFor(t, h = hand) {
  const pp = { ...PIECE_PARAM_DEFAULTS, ...t.params };
  if (isHandedPiece(t.base)) pp.curveDir = h;
  return pp;
}

function meshesFor(b, base) {
  const g = new THREE.Group();
  const def = PIECE_BY_ID.get(base);
  const add = (geo, mat) => { if (geo) { const m = new THREE.Mesh(geo, mat); g.add(m); } };
  add(b.geometry, def?.tubeShader ? mats.tube : mats.road);
  add(b.railGeometry, mats.rail);
  add(b.shellGeometry, def?.tubeShader ? mats.tube : mats.shell);
  add(b.decorGeometry, mats.decor);
  add(b.decorGateGeometry, mats.decorGate);
  add(b.decorGlowGeometry, /finish/.test(base) ? mats.finishGlow : /checkpoint/.test(base) ? mats.checkpointGlow : mats.decorGlow);
  add(b.glassGeometry, mats.glass);
  const posts = b.railPosts;
  if (posts?.template?.isBufferGeometry && posts.matrices?.length) {
    const im = new THREE.InstancedMesh(posts.template, mats.rail, posts.matrices.length);
    posts.matrices.forEach((m, i) => im.setMatrixAt(i, m));
    g.add(im);
  }
  g.matrixAutoUpdate = false;
  g.matrix.copy(b.world);
  g.matrixWorldNeedsUpdate = true;
  return g;
}

function disposeGroup(g) {
  g.traverse((o) => { if (o.isMesh && !o.isInstancedMesh) o.geometry?.dispose(); });
}

/** Rebuild every piece. A piece with a parent always starts at the parent's exit (links are exact). */
function rebuild() {
  for (const c of trackGroup.children.slice()) { trackGroup.remove(c); disposeGroup(c); }
  built = new Map();
  for (const pc of track.pieces) {
    const t = { base: pc.base, params: pc.params };
    const entry = pc.parent != null && built.has(pc.parent) ? built.get(pc.parent).exit.clone() : new THREE.Matrix4().fromArray(pc.entry);
    pc.entry = entry.toArray();
    const b = buildPiece(pc.base, entry, paramsFor(t, pc.hand ?? 1), ROAD_PARAM_DEFAULTS, GUARDRAIL_PARAM_DEFAULTS, true);
    const group = meshesFor(b, pc.base);
    group.userData.uid = pc.uid;
    trackGroup.add(group);
    built.set(pc.uid, { exit: b.connectorOut.clone(), group, entry });
  }
  save();
  refreshArcs();
  refreshSelection();
  ghostDirty = true;
}

function openEnds() {
  const hasChild = new Set(track.pieces.map((p) => p.parent).filter((u) => u != null));
  return track.pieces.filter((p) => !hasChild.has(p.uid)).map((p) => {
    const m = built.get(p.uid).exit;
    const dir = new THREE.Vector3(0, 0, -1).transformDirection(m);
    return { uid: p.uid, m, lean: tileLean(pieceTile(p), p.hand ?? 1).exit, pitch: Math.asin(Math.max(-1, Math.min(1, dir.y))) / DEG };
  });
}

// ---------- flight arcs ----------
const arcGroup = new THREE.Group();
scene.add(arcGroup);
let arcs = []; // { pts: Vector3[], tan: Vector3[] }
const arcMat = new THREE.LineBasicMaterial({ color: 0xffa53d, transparent: true, opacity: 0.9 });
function refreshArcs() {
  for (const c of arcGroup.children.slice()) { arcGroup.remove(c); c.geometry.dispose(); }
  arcs = [];
  for (const e of openEnds()) {
    const p0 = new THREE.Vector3().setFromMatrixPosition(e.m);
    const dir = new THREE.Vector3(0, 0, -1).transformDirection(e.m);
    const v = dir.clone().multiplyScalar(jumpSpeed);
    const pts = [];
    const tan = [];
    for (let t = 0; t <= 9; t += 0.04) {
      const p = p0.clone().addScaledVector(v, t);
      p.y -= 0.5 * G * t * t;
      pts.push(p);
      tan.push(new THREE.Vector3(v.x, v.y - G * t, v.z).normalize());
      if (p.y < -20) break;
    }
    arcs.push({ pts, tan });
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    arcGroup.add(new THREE.Line(geo, arcMat));
  }
}

// ---------- ghost + snapping ----------
const ghostMat = new THREE.MeshBasicMaterial({ color: SNAP_COLORS.world, transparent: true, opacity: 0.5, depthWrite: false });
let ghost = null;
let ghostDirty = true;
let snap = null; // { type, m, parent? }
let lastSnapKey = "";
const mouse = { x: innerWidth / 2, y: innerHeight / 2, inside: false };
const ray = new THREE.Raycaster();

function toScreen(v) {
  const p = v.clone().project(camera);
  if (p.z > 1) return null;
  return { x: (p.x * 0.5 + 0.5) * innerWidth, y: (-p.y * 0.5 + 0.5) * innerHeight };
}

function freeMatrix(pos, yawDeg) {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(ghostRot.pitch * DEG, yawDeg * DEG, ghostRot.roll * DEG, "YXZ"));
  return new THREE.Matrix4().compose(pos, q, new THREE.Vector3(1, 1, 1));
}

/** How much a tile pitches its road UP from entry to exit (rad). A landing ramp's is its angle. */
const liftCache = new Map();
function tileLift(t) {
  const key = `${t.key}|${hand}`;
  if (!liftCache.has(key)) {
    const b = buildPiece(t.base, new THREE.Matrix4(), paramsFor(t), ROAD_PARAM_DEFAULTS, GUARDRAIL_PARAM_DEFAULTS, false, { deckOnly: true });
    const dir = new THREE.Vector3(0, 0, -1).transformDirection(b.connectorOut);
    liftCache.set(key, Math.asin(Math.max(-1, Math.min(1, dir.y))));
  }
  return liftCache.get(key);
}

/**
 * How much the DECK leans (deg, sign = which side is down) at a tile's entry and exit. The kit's
 * banked pieces keep LEVEL sockets (the old Apex rule), so the socket alone can't tell a leaning end
 * from a flat one — this can.
 */
const leanCache = new Map();
function tileLean(t, h = hand) {
  const key = `${t.key}|${h}`;
  if (!leanCache.has(key)) {
    const b = buildPiece(t.base, new THREE.Matrix4(), paramsFor(t, h), ROAD_PARAM_DEFAULTS, GUARDRAIL_PARAM_DEFAULTS, false, { deckOnly: true });
    const lean = (fr) => {
      const right = new THREE.Vector3().crossVectors(fr.tangent, UP);
      if (right.lengthSq() < 1e-6) return 0; // vertical (loops): no meaningful lean
      right.normalize();
      return Math.round((Math.atan2(fr.up.dot(right), fr.up.dot(UP)) / DEG) * 10) / 10;
    };
    leanCache.set(key, { entry: lean(b.frames[0]), exit: lean(b.frames[b.frames.length - 1]) });
  }
  return leanCache.get(key);
}
const pieceTile = (pc) => ({ key: pc.key, base: pc.base, params: pc.params });

/** Pieces that fit an open end: same lean in, for a leaning end; landings for a ramp lip; else recent. */
const recent = [];
function suggestionsFor(end) {
  if (Math.abs(end.lean) > 3) {
    const out = [];
    for (const c of categories) for (const t of c.tiles) for (const h of [1, -1]) {
      if (!isHandedPiece(t.base) && h === -1) continue;
      if (Math.abs(tileLean(t, h).entry - end.lean) < 3 && !out.some((o) => o.t.key === t.key)) out.push({ t, h });
    }
    // the way back to flat ALWAYS shows, then the pieces that keep the lean going
    const back = out.filter((o) => Math.abs(tileLean(o.t, o.h).exit) <= 3);
    const keep = out.filter((o) => Math.abs(tileLean(o.t, o.h).exit) > 3);
    return { label: `Leans ${Math.abs(end.lean)}° · fits`, items: [...back.slice(0, 2), ...keep.slice(0, 6 - Math.min(2, back.length))] };
  }
  if (end.pitch > 3) {
    const items = ["land_10", "land_20", "land_40"].filter((k) => tileByKey.has(k)).map((k) => ({ t: tileByKey.get(k), h: hand }));
    return { label: "Ramp · land it on the arc", items };
  }
  return recent.length ? { label: "Again", items: recent.slice(0, 4) } : null;
}

/** The reference frame of the local grid: the selected piece, else the last one placed. */
function localRef() {
  const uid = sel ?? track.pieces[track.pieces.length - 1]?.uid;
  const b = uid != null ? built.get(uid) : null;
  if (!b) return null;
  const m = b.exit;
  const pos = new THREE.Vector3().setFromMatrixPosition(m);
  const fwd = new THREE.Vector3(0, 0, -1).transformDirection(m);
  const yaw = Math.atan2(-fwd.x, -fwd.z); // yaw of a -Z-forward frame
  return { pos, yaw };
}

function computeSnap() {
  // 1. open ends near the cursor (screen space)
  let best = null;
  for (const e of openEnds()) {
    const s = toScreen(new THREE.Vector3().setFromMatrixPosition(e.m));
    if (!s) continue;
    const d = Math.hypot(s.x - mouse.x, s.y - mouse.y);
    if (d < 60 && (!best || d < best.d)) best = { type: "end", m: e.m.clone(), parent: e.uid, d, end: e };
  }
  if (best) {
    const inLean = tileLean(tile).entry;
    if (Math.abs(inLean - best.end.lean) > 3) {
      best.bad = best.end.lean
        ? `This end leans ${Math.abs(best.end.lean)}°; this piece starts ${inLean ? `at ${Math.abs(inLean)}°` : "flat"}. Pick one of the pieces suggested at the end, or "Down" to come back flat.`
        : `This end is flat; this piece starts leaning ${Math.abs(inLean)}°. Start a bank with "Up".`;
    }
    return best;
  }
  // 2. flight arcs (skip the first 0.2 s, which belongs to the end itself)
  for (const a of arcs) {
    for (let k = 5; k < a.pts.length; k++) {
      if (a.tan[k].y > -0.02) continue; // you land while FALLING: only the descending part snaps
      const s = toScreen(a.pts[k]);
      if (!s) continue;
      const d = Math.hypot(s.x - mouse.x, s.y - mouse.y);
      if (d < 30 && (!best || d < best.d)) best = { type: "arc", k, a, d };
    }
  }
  if (best) {
    // A LANDING tile (one that pitches up from entry to exit) slides along the arc you picked to
    // where the fall angle equals its own, so its exit comes out level and the road after it does too.
    const lift = tileLift(tile);
    if (lift > 2 * DEG) {
      let kBest = best.k;
      let err = Infinity;
      for (let k = 5; k < best.a.pts.length; k++) {
        const fall = Math.asin(Math.max(-1, Math.min(1, -best.a.tan[k].y)));
        if (fall > 0 && Math.abs(fall - lift) < err) { err = Math.abs(fall - lift); kBest = k; }
      }
      best.k = kBest;
      best.matched = err < 1.5 * DEG;
    }
    // Aligned with the flight; ↑/↓ lift the nose toward level (a flatter landing), ←/→ bank it.
    const m = socketMatrix(best.a.pts[best.k], best.a.tan[best.k], UP);
    if (ghostRot.pitch) m.multiply(new THREE.Matrix4().makeRotationX(ghostRot.pitch * DEG));
    if (ghostRot.roll) m.multiply(new THREE.Matrix4().makeRotationZ(ghostRot.roll * DEG));
    return { type: "arc", m, d: best.d };
  }
  // 3/4. grid on the build-height plane
  ray.setFromCamera(new THREE.Vector2((mouse.x / innerWidth) * 2 - 1, -(mouse.y / innerHeight) * 2 + 1), camera);
  const hit = new THREE.Vector3();
  if (!ray.ray.intersectPlane(new THREE.Plane(UP, -buildY), hit)) return null;
  const ref = gridMode === "local" ? localRef() : null;
  if (ref) {
    const d = hit.clone().sub(ref.pos);
    const c = Math.cos(-ref.yaw), s = Math.sin(-ref.yaw);
    let lx = d.x * c + d.z * s;
    let lz = -d.x * s + d.z * c;
    lx = Math.round(lx / gridStep) * gridStep;
    lz = Math.round(lz / gridStep) * gridStep;
    const c2 = Math.cos(ref.yaw), s2 = Math.sin(ref.yaw);
    const p = new THREE.Vector3(ref.pos.x + lx * c2 + lz * s2, buildY, ref.pos.z - lx * s2 + lz * c2);
    return { type: "local", m: freeMatrix(p, ref.yaw / DEG + ghostRot.yaw) };
  }
  const p = new THREE.Vector3(Math.round(hit.x / gridStep) * gridStep, buildY, Math.round(hit.z / gridStep) * gridStep);
  return { type: "world", m: freeMatrix(p, ghostRot.yaw) };
}

function updateGhost() {
  if (!tile || !mouse.inside) { if (ghost) ghost.visible = false; snap = null; renderHud(); return; }
  snap = computeSnap();
  if (!snap) { if (ghost) ghost.visible = false; renderHud(); return; }
  const key = `${tile.key}|${hand}|${snap.type}|${!!snap.bad}|${snap.m.elements.map((x) => x.toFixed(3)).join(",")}`;
  if (key !== lastSnapKey || ghostDirty) {
    lastSnapKey = key;
    ghostDirty = false;
    if (ghost) { scene.remove(ghost); ghost.geometry.dispose(); }
    const b = buildPiece(tile.base, snap.m, paramsFor(tile), ROAD_PARAM_DEFAULTS, GUARDRAIL_PARAM_DEFAULTS, false, { deckOnly: true });
    ghostMat.color.setHex(snap.bad ? 0xff4d5e : SNAP_COLORS[snap.type]);
    ghost = new THREE.Mesh(b.geometry, ghostMat);
    ghost.matrixAutoUpdate = false;
    ghost.matrix.copy(b.world);
    ghost.renderOrder = 10;
    scene.add(ghost);
  }
  ghost.visible = true;
  renderHud();
}

// grid follows the build height and the local frame
function updateGrid() {
  const ref = gridMode === "local" ? localRef() : null;
  const focus = snap?.m ? new THREE.Vector3().setFromMatrixPosition(snap.m) : controls.target;
  if (ref) {
    grid.rotation.y = ref.yaw;
    grid.position.set(ref.pos.x, buildY, ref.pos.z);
  } else {
    grid.rotation.y = 0;
    grid.position.set(Math.round(focus.x / 8) * 8, buildY, Math.round(focus.z / 8) * 8);
  }
  grid.material.color?.setHex(gridMode === "local" ? 0x9b6fd0 : 0x3a7f97);
}

// ---------- actions ----------
function place() {
  if (!tile || !snap) return;
  snapshot();
  const uid = track.nextUid++;
  track.pieces.push({ uid, key: tile.key, base: tile.base, params: tile.params, hand, entry: snap.m.toArray(), parent: snap.type === "end" ? snap.parent : null });
  const ri = recent.findIndex((r) => r.t.key === tile.key && r.h === hand);
  if (ri >= 0) recent.splice(ri, 1);
  recent.unshift({ t: tile, h: hand });
  rebuild();
  const exit = new THREE.Vector3().setFromMatrixPosition(built.get(uid).exit);
  buildY = Math.round(exit.y / 2) * 2;
  glideTo(exit);
}

/** Remove a piece; its child (if any) re-attaches to the piece before it, so the road closes up. */
function removePiece(uid) {
  const i = track.pieces.findIndex((p) => p.uid === uid);
  if (i < 0) return;
  snapshot();
  const pc = track.pieces[i];
  for (const c of track.pieces) if (c.parent === uid) { c.parent = pc.parent; if (pc.parent == null) c.entry = pc.entry; }
  track.pieces.splice(i, 1);
  sel = null;
  rebuild();
}

let selBox = null;
function refreshSelection() {
  if (selBox) { scene.remove(selBox); selBox = null; }
  const b = sel != null ? built.get(sel) : null;
  if (!b) return;
  const box = new THREE.Box3().setFromObject(b.group);
  selBox = new THREE.Box3Helper(box, 0xdce622);
  scene.add(selBox);
}

// ---------- camera glide ----------
let glide = null;
function glideTo(p) { glide = p.clone(); }
function stepGlide(dt) {
  if (!glide) return;
  const d = glide.clone().sub(controls.target);
  if (d.length() < 0.05) { glide = null; return; }
  d.multiplyScalar(1 - Math.exp(-dt * 5));
  controls.target.add(d);
  camera.position.add(d);
}
function frameAll() {
  const box = new THREE.Box3().setFromObject(trackGroup);
  if (box.isEmpty()) return;
  const c = box.getCenter(new THREE.Vector3());
  const r = box.getSize(new THREE.Vector3()).length() * 0.6 + 20;
  const dir = camera.position.clone().sub(controls.target).normalize();
  controls.target.copy(c);
  camera.position.copy(c).addScaledVector(dir, r * 2.0);
}

// ---------- HUD ----------
let hudKey = "";
function renderHud() {
  const type = tile ? (snap?.type ?? "—") : "no tile";
  const col = snap?.bad ? "#ff4d5e" : snap ? `#${SNAP_COLORS[snap.type].toString(16).padStart(6, "0")}` : "#8796b5";
  const names = { end: "open end", arc: "flight arc", local: "local grid", world: "world grid" };
  const key = `${type}|${snap?.bad}|${tile?.key}|${sel}|${gridMode}|${gridStep}|${buildY}|${ghostRot.yaw}|${ghostRot.pitch}|${ghostRot.roll}|${jumpSpeed}|${track.pieces.length}`;
  if (key === hudKey) return;
  hudKey = key;
  $("status").innerHTML =
    `<div class="mode" style="color:${col}">${tile ? `${tile.label} → ${names[type] ?? type}` : sel != null ? "Piece selected" : "Pick a piece"}</div>` +
    (snap?.bad ? `<div class="warn">${snap.bad}</div>` : "") +
    `<div class="row"><span>grid</span><b>${gridMode} · ${gridStep} m</b></div>` +
    `<div class="row"><span>height</span><b>${buildY} m</b></div>` +
    `<div class="row"><span>turn / pitch / bank</span><b>${ghostRot.yaw}° / ${ghostRot.pitch}° / ${ghostRot.roll}°</b></div>` +
    `<div class="row"><span>flight arcs at</span><b>${Math.round(jumpSpeed * 3.6)} km/h</b></div>` +
    `<div class="row"><span>pieces</span><b>${track.pieces.length}</b></div>`;
}

// ---------- next-piece chips, floating at the newest open end ----------
let nextKey = "";
function updateNext() {
  const el = $("next");
  const ends = openEnds();
  const lastUid = track.pieces[track.pieces.length - 1]?.uid;
  const head = ends.find((e) => e.uid === lastUid) ?? ends[ends.length - 1];
  const sug = head ? suggestionsFor(head) : null;
  const s = head ? toScreen(new THREE.Vector3().setFromMatrixPosition(head.m)) : null;
  if (!sug || !s || s.y > innerHeight - DOCK_H - 40) { el.style.display = "none"; nextKey = ""; return; }
  el.style.display = "flex";
  el.style.left = `${Math.min(innerWidth - 420, s.x + 34)}px`;
  el.style.top = `${Math.max(60, s.y - 52)}px`;
  const key = sug.label + sug.items.map((i) => i.t.key + i.h).join() + tile?.key;
  if (key === nextKey) return;
  nextKey = key;
  el.innerHTML = `<div class="lbl">${sug.label}</div>`;
  const row = document.createElement("div");
  row.className = "row";
  for (const { t, h } of sug.items) {
    const b = document.createElement("button");
    b.appendChild(pic(t.key));
    b.appendChild(document.createTextNode(t.label + (isHandedPiece(t.base) ? ` ${h > 0 ? "R" : "L"}` : "")));
    if (tile?.key === t.key) b.style.borderColor = "var(--bolt)";
    b.onclick = () => pickTile(t.key, h);
    row.appendChild(b);
  }
  el.appendChild(row);
}

// ---------- input ----------
const canvas = renderer.domElement;
canvas.addEventListener("pointermove", (e) => { mouse.x = e.clientX; mouse.y = e.clientY; mouse.inside = true; });
canvas.addEventListener("pointerleave", () => { mouse.inside = false; });
let down = null;
canvas.addEventListener("pointerdown", (e) => { down = { x: e.clientX, y: e.clientY, b: e.button }; });
canvas.addEventListener("pointerup", (e) => {
  const d = down;
  down = null;
  if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5) return;
  if (d.b === 2 && tile) { tile = null; renderPalette(); updateGhost(); return; }
  if (d.b !== 0) return;
  if (tile) { place(); return; }
  ray.setFromCamera(new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1), camera);
  const hit = ray.intersectObjects(trackGroup.children, true)[0];
  let o = hit?.object;
  while (o && o.userData.uid == null) o = o.parent;
  sel = o?.userData.uid ?? null;
  refreshSelection();
  renderHud();
});
canvas.addEventListener("contextmenu", (e) => e.preventDefault());
canvas.addEventListener("wheel", (e) => {
  if (!e.shiftKey) return; // plain wheel = zoom (OrbitControls)
  e.preventDefault();
  e.stopImmediatePropagation();
  buildY += (e.deltaY || e.deltaX) < 0 ? 2 : -2;
  ghostDirty = true;
}, { capture: true, passive: false });

addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === "z") { e.preventDefault(); restore(e.shiftKey ? redo : undo, e.shiftKey ? undo : redo); return; }
  if ((e.ctrlKey || e.metaKey) && k === "y") { e.preventDefault(); restore(redo, undo); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const step = e.shiftKey ? 5 : 15;
  const digit = /^Digit([1-4])$/.exec(e.code);
  if (digit) { gridStep = GRID_STEPS[+digit[1] - 1]; ghostDirty = true; e.preventDefault(); return; }
  switch (e.key) {
    case "ArrowUp": ghostRot.pitch = Math.min(60, ghostRot.pitch + 5); break;
    case "ArrowDown": ghostRot.pitch = Math.max(-60, ghostRot.pitch - 5); break;
    case "ArrowLeft": ghostRot.roll = Math.max(-60, ghostRot.roll - 5); break;
    case "ArrowRight": ghostRot.roll = Math.min(60, ghostRot.roll + 5); break;
    case "PageUp": buildY += 2; break;
    case "PageDown": buildY -= 2; break;
    case "Enter": place(); break;
    case "Escape": if (tile) { tile = null; renderPalette(); } else { sel = null; refreshSelection(); } break;
    case "Delete": case "Backspace": if (!tile && sel != null) removePiece(sel); break;
    case "[": jumpSpeed = Math.max(10, jumpSpeed - 2.5); refreshArcs(); break;
    case "]": jumpSpeed = Math.min(80, jumpSpeed + 2.5); refreshArcs(); break;
    default:
      if (k === "q") ghostRot.yaw += step;
      else if (k === "e") ghostRot.yaw -= step;
      else if (k === "r") { hand = -hand; renderPalette(); }
      else if (k === "g") gridMode = gridMode === "world" ? "local" : "world";
      else if (k === "f") frameAll();
      else return;
  }
  ghostRot.yaw = ((ghostRot.yaw % 360) + 360) % 360;
  ghostDirty = true;
  e.preventDefault();
});
addEventListener("resize", () => { fitView(); renderer.setSize(innerWidth, innerHeight); });
$("b-undo").onclick = () => restore(undo, redo);
$("b-redo").onclick = () => restore(redo, undo);
$("b-frame").onclick = frameAll;
$("b-keys").onclick = () => $("keys").classList.toggle("hidden");
$("b-new").onclick = () => { snapshot(); track = { pieces: [], nextUid: 1 }; sel = null; rebuild(); };

// ---------- loop ----------
renderPalette();
rebuild();
renderHud();
let last = performance.now();
renderer.setAnimationLoop(() => {
  const now = performance.now();
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  stepGlide(dt);
  controls.update();
  updateGhost();
  updateGrid();
  updateNext();
  renderer.render(scene, camera);
});

window.__p1b = {
  get track() { return track; }, get snap() { return snap; }, built: () => built,
  pickTile, place, removePiece, frameAll, setMouse(x, y) { mouse.x = x; mouse.y = y; mouse.inside = true; },
  tiles: () => [...tileByKey.keys()], set(t) { track = t; rebuild(); }, toScreen,
  rot: ghostRot, setBuildY(y) { buildY = y; }, setSpeed(v) { jumpSpeed = v; refreshArcs(); },
  // test helpers: put the mouse on the newest open end, or on point k of arc i
  aimEnd() {
    const uid = track.pieces[track.pieces.length - 1]?.uid;
    const s = toScreen(new THREE.Vector3().setFromMatrixPosition(built.get(uid).exit));
    if (s) { mouse.x = s.x; mouse.y = s.y; mouse.inside = true; }
    return s;
  },
  aimArc(i, k) {
    const s = toScreen(arcs[i].pts[k]);
    if (s) { mouse.x = s.x; mouse.y = s.y; mouse.inside = true; }
    return { s, p: arcs[i].pts[k].toArray().map((x) => +x.toFixed(1)), n: arcs[i].pts.length };
  },
  arcCount: () => arcs.length,
};
