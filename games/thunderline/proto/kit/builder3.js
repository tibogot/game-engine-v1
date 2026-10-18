// Thunderline builder B1 — the snapping builder (P1b's ghost, dock and next-piece chips) on the NEW
// pieces (kit.js: path × section × lean, drawn with the old look). Ends carry their lean; road
// overlaps and blocked flight corridors are checked live; "Drive" opens the track with the real car.
// Throwaway prototype (DESIGN.md §4–§5, §9).
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TILES, integrate, socketMatrix, leanIn, leanOut, deckFrame, SECTIONS, DEG, ensureTile } from "./kit.js";
import { buildOldLook, createOldLookMaterials } from "./oldLook.js";
import { Vehicle, FIXED_DT, TIRE } from "../../../../v3/play/modularRoadVehicle.js";
import { RoadBvh } from "../../../../v3/play/modularRoadBvh.js";
import { createVehicleGround } from "../../../../v3/play/modularRoadGround.js";

// the drive page's tune (P3): the prediction drives the SAME car
const TOP = 63;
TIRE.topSpeed = TOP;
TIRE.steerSpeedRef = TOP * 0.9;
const ROAD_HOLD = new Set(["bank_in_22", "bank_out_22", "fast_turn_128"]);

const $ = (id) => document.getElementById(id);
const STORE = "thunderline.track.v1"; // drive.html?track=local reads the same key
const UP = new THREE.Vector3(0, 1, 0);
const G = 9.81;
const AIR_DRAG = 0.45 / 1400; // the car's AERO.drag / mass (P3: arcs must use it)
const SNAP_COLORS = { end: 0x45e08a, arc: 0xff9a3d, local: 0xc78bff, world: 0x3fd2ff };
const GRID_STEPS = [1, 2, 4, 8];

const CATS = [
  { id: "road", label: "Road", tiles: ["straight_64", "boost_32", "slope_down_12"] },
  { id: "turns", label: "Turns", tiles: ["fast_turn_128", "brake_turn_32"] },
  { id: "lean", label: "Lean", tiles: ["bank_in_22", "bank_out_22"] },
  { id: "air", label: "Air", tiles: ["kicker_20", "fitted_landing", "landing_20", "banked_landing_20", "landing_turn_20", "catch_pad"] },
  { id: "stunts", label: "Stunts", tiles: ["loop_28", "wallride_90"] },
];
const catOf = new Map();
for (const c of CATS) for (const t of c.tiles) catOf.set(t, c.id);

// ---------- state ----------
let track = load() ?? { pieces: [], nextUid: 1 };
let hand = 1; // +1 right, −1 left (picks the "_L" mirror)
let edges = true; // guarded / open
let tileBase = null; // base id in hand
let sel = null;
let gridMode = "world";
let gridStep = 8;
let buildY = 120;
const rot = { yaw: 0, pitch: 0, roll: 0 };
let arcSpeed = 57; // m/s at a lip (≈ 0.91 × top 63, P3); [ ] change it
let undo = [], redo = [];
const recent = [];
function load() { try { return JSON.parse(localStorage.getItem(STORE)); } catch { return null; } }
function save() { try { localStorage.setItem(STORE, JSON.stringify(track)); } catch {} }
function snapshot() { undo.push(JSON.stringify(track)); if (undo.length > 200) undo.shift(); redo = []; }
function restore(from, to) { if (!from.length) return; to.push(JSON.stringify(track)); track = JSON.parse(from.pop()); sel = null; rebuild(); }
// "fitted_landing" is not a fixed tile: the builder generates one per jump, sized to its speed band
// (kit.js ensureTile). Until the ghost is on an arc it shows a default size.
const FITTED = "fitted_landing";
const FITTED_ANGLE = 20;
let fittedId = ensureTile(`fitted_landing_${FITTED_ANGLE}_32`).id;
const tileId = (base, h = hand) => (base === FITTED ? fittedId : h < 0 && TILES[`${base}_L`] ? `${base}_L` : base);
const tileLabel = (base) => (base === FITTED ? "Fitted landing" : TILES[base].label);
const deg = (r) => Math.round((r / DEG) * 10) / 10;

// ---------- renderer ----------
const DOCK_H = 175;
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
const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.5, 9000);
function fitView() { camera.aspect = innerWidth / innerHeight; camera.setViewOffset(innerWidth, innerHeight, 0, DOCK_H / 2, innerWidth, innerHeight); camera.updateProjectionMatrix(); }
fitView();
camera.position.set(120, buildY + 110, 160);
const controls = new OrbitControls(camera, renderer.domElement);
controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
controls.zoomToCursor = true;
controls.enableDamping = true;
controls.target.set(0, buildY, 0);
const grid = new THREE.GridHelper(512, 64, 0x3a7f97, 0x5f97aa);
grid.material.transparent = true;
grid.material.opacity = 0.45;
scene.add(grid);

// ---------- pieces (geometry cache) ----------
const mats = createOldLookMaterials();
const cache = new Map();
function piece(id, open = false) {
  const key = `${id}|${open}`;
  if (!cache.has(key)) {
    const t = TILES[id];
    const b = integrate(t);
    cache.set(key, { t, b, look: buildOldLook(t, !open), exitLocal: socketMatrix(b.exit) });
  }
  return cache.get(key);
}
function meshesFor(id, open) {
  const { look } = piece(id, open);
  const g = new THREE.Group();
  g.add(new THREE.Mesh(look.deck, mats.road));
  if (look.rail) g.add(new THREE.Mesh(look.rail, mats.rail));
  if (look.posts?.template && look.posts.matrices.length) {
    const im = new THREE.InstancedMesh(look.posts.template, mats.rail, look.posts.matrices.length);
    look.posts.matrices.forEach((m, i) => im.setMatrixAt(i, m));
    im.computeBoundingSphere();
    g.add(im);
  }
  return g;
}

// ---------- thumbnails: each tile rendered once, 3/4 view ----------
const thumbs = new Map();
async function bakeThumbs() {
  const W = 192, H = 128;
  // sRGB, like the old thumbnail baker: a linear target copied straight to a canvas comes out dark
  const rt = new THREE.RenderTarget(W, H, { type: THREE.UnsignedByteType, colorSpace: THREE.SRGBColorSpace });
  const ts = new THREE.Scene();
  // lighter than the panel, brighter light: dark asphalt on a dark card read as nothing
  ts.background = new THREE.Color(0x3a4a6b);
  ts.add(new THREE.HemisphereLight(0xeaf3ff, 0x6a6a72, 3.6));
  const d = new THREE.DirectionalLight(0xfff2e0, 4.2); d.position.set(5, 9, 6); ts.add(d);
  const cam = new THREE.PerspectiveCamera(30, W / H, 0.5, 5000);
  const cvs = document.createElement("canvas"); cvs.width = W; cvs.height = H;
  const ctx = cvs.getContext("2d");
  for (const c of CATS) for (const id of c.tiles) {
    if (id === FITTED) continue; // drawn with the landing's picture (see pic)
    const g = meshesFor(id, false);
    const t = TILES[id];
    g.rotation.x = -(t.landAngle ?? 0) * DEG;
    ts.add(g);
    g.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(g);
    const sph = box.getBoundingSphere(new THREE.Sphere());
    const dir = new THREE.Vector3(0.75, 0.6, 0.9).normalize();
    cam.position.copy(sph.center).addScaledVector(dir, sph.radius / Math.sin((cam.fov * DEG) / 2) * 0.62);
    cam.lookAt(sph.center);
    renderer.setRenderTarget(rt);
    renderer.render(ts, cam);
    renderer.setRenderTarget(null);
    const px = await renderer.readRenderTargetPixelsAsync(rt, 0, 0, W, H);
    const img = ctx.createImageData(W, H);
    const stride = px.length / H;
    for (let y = 0; y < H; y++) for (let x = 0; x < W * 4; x++) img.data[y * W * 4 + x] = px[y * stride + x];
    ctx.putImageData(img, 0, 0);
    thumbs.set(id, cvs.toDataURL());
    ts.remove(g);
  }
  rt.dispose();
}

// ---------- dock ----------
let activeCat = CATS[0].id;
const BOLT = `<svg viewBox="0 0 16 16"><path fill="currentColor" d="M9.5 0 2 9h5l-1.5 7L14 6.5H9z"/></svg>`;
function pic(id, cls = "pic") {
  const el = document.createElement("div");
  el.className = cls;
  const url = thumbs.get(id === FITTED || id.startsWith("fitted_landing_") ? "landing_20" : id.replace(/_L$/, ""));
  if (url) { el.style.backgroundImage = `url(${url})`; el.style.backgroundSize = "cover"; el.style.backgroundPosition = "center"; if (id.endsWith("_L")) el.style.transform = "scaleX(-1)"; }
  return el;
}
function toggleBtns(label, opts, value, onPick) {
  const wrap = document.createElement("div");
  wrap.className = "hand cond";
  wrap.innerHTML = `<span style="color:var(--dim)">${label}</span>`;
  for (const [v, txt] of opts) {
    const b = document.createElement("button");
    b.textContent = txt;
    b.style.width = "auto"; b.style.padding = "0 8px";
    if (value === v) b.className = "on";
    b.onclick = () => onPick(v);
    wrap.appendChild(b);
  }
  return wrap;
}
function renderDock() {
  const tabs = $("tabs");
  tabs.innerHTML = `<div class="brand cond">${BOLT}Build</div>`;
  for (const c of CATS) {
    const b = document.createElement("button");
    b.className = "tab" + (c.id === activeCat ? " on" : "");
    b.innerHTML = `${c.label}<span class="n">${c.tiles.length}</span>`;
    b.onclick = () => { activeCat = c.id; renderDock(); };
    tabs.appendChild(b);
  }
  const sp = document.createElement("div"); sp.className = "spacer"; tabs.appendChild(sp);
  tabs.appendChild(toggleBtns("Edges", [[true, "Guarded"], [false, "Open"]], edges, (v) => { edges = v; ghostDirty = true; renderDock(); }));
  tabs.appendChild(toggleBtns("Hand", [[-1, "L"], [1, "R"]], hand, (v) => { hand = v; ghostDirty = true; renderDock(); }));
  const cards = $("cards");
  cards.innerHTML = "";
  for (const base of CATS.find((c) => c.id === activeCat).tiles) {
    const b = document.createElement("button");
    b.className = "card cut" + (tileBase === base ? " on" : "");
    b.appendChild(pic(tileId(base)));
    const nm = document.createElement("span");
    nm.className = "nm";
    nm.textContent = tileLabel(base);
    b.appendChild(nm);
    b.onclick = () => pickTile(base);
    cards.appendChild(b);
  }
}
function pickTile(base, h = null) {
  tileBase = base;
  if (h != null) hand = h;
  activeCat = catOf.get(base) ?? activeCat;
  sel = null;
  ghostDirty = true;
  renderDock();
  refreshSelection();
}

// ---------- the placed track ----------
const trackGroup = new THREE.Group();
scene.add(trackGroup);
let built = new Map(); // uid → { exit: Matrix4, group, M }
let problems = { overlap: new Set(), messages: [] };

function rebuild() {
  for (const c of trackGroup.children.slice()) trackGroup.remove(c);
  built = new Map();
  for (const pc of track.pieces) {
    const M = pc.parent != null && built.has(pc.parent) ? built.get(pc.parent).exit.clone() : new THREE.Matrix4().fromArray(pc.M);
    pc.M = M.toArray();
    ensureTile(pc.id); // generated pieces (fitted landings) are rebuilt from their id
    const g = meshesFor(pc.id, pc.open);
    g.matrixAutoUpdate = false;
    g.matrix.copy(M);
    g.userData.uid = pc.uid;
    trackGroup.add(g);
    built.set(pc.uid, { exit: M.clone().multiply(piece(pc.id, pc.open).exitLocal), group: g, M });
  }
  save();
  refreshArcs();
  runChecks();
  refreshSelection();
  ghostDirty = true;
  schedulePrediction();
}

// ---------- PREDICTION: the real car drives your track in the background (B2) ----------
// Deterministic physics (P5) at ~0.45 ms per tick makes this affordable: after each edit a fresh car
// runs the autopilot over the track in slices, and reports every lip's TAKE-OFF speed (the arc band
// comes from it), the lap time, and where the car falls or stops.
let prediction = { state: "idle", lipSpeed: new Map(), fail: null, lapS: null, topKmh: 0, ticks: 0 };
let predTimer = null, predToken = 0, failBox = null;
const predScene = new THREE.Scene(); // the car's meshes live here; never rendered
function schedulePrediction() { clearTimeout(predTimer); predTimer = setTimeout(runPrediction, 250); }
/** Pieces in driving order: from the first piece, follow the road child, else the flight's landing. */
function orderedPieces() {
  const out = [];
  let cur = track.pieces[0];
  const seen = new Set();
  while (cur && !seen.has(cur.uid)) {
    seen.add(cur.uid);
    out.push(cur);
    cur = track.pieces.find((q) => q.parent === cur.uid) ?? track.pieces.find((q) => q.flightFrom === cur.uid);
  }
  return out;
}
async function runPrediction() {
  const token = ++predToken;
  const order = orderedPieces();
  if (order.length < 2) { prediction = { state: "idle", lipSpeed: new Map(), fail: null, lapS: null, topKmh: 0, ticks: 0 }; return; }
  prediction = { state: "running", lipSpeed: prediction.lipSpeed, fail: null, lapS: null, topKmh: 0, ticks: 0 };
  renderStatus();
  // collision, as drive.js: decks (road hold on banked pieces) + rail collision proxies
  const col = (geometry, M, userData = {}) => ({ geometry, matrixWorld: M, userData, updateMatrixWorld() {} });
  const decks = [], solids = [], ride = [];
  for (const pc of order) {
    const { look, b, t } = piece(pc.id, pc.open);
    const M = built.get(pc.uid).M;
    decks.push(col(look.deck, M, { roadHold: ROAD_HOLD.has(pc.id.replace(/_L$/, "")) }));
    if (look.railCollision) solids.push(col(look.railCollision, M));
    const hw = SECTIONS[t.section ?? "road"].hw;
    for (const r of b.rings) {
      const f = deckFrame(r, hw);
      ride.push({ P: f.P.clone().applyMatrix4(M), T: r.T.clone().transformDirection(M), uid: pc.uid });
    }
  }
  const deckBvh = new RoadBvh(), solidsBvh = new RoadBvh();
  deckBvh.bakeFromMeshes(decks);
  solidsBvh.bakeFromMeshes(solids);
  const ground = createVehicleGround({ getTerrainHeight: () => NaN });
  ground.setRoadBvh(deckBvh.baked ? deckBvh : null);
  ground.setRoadSolidsBvh(solidsBvh.baked ? solidsBvh : null);
  const car = new Vehicle({ scene: predScene, showArrows: false });
  car.SUBSTEPS = 3;
  car.setBvh(ground.ground, ground.solids);
  car.getFloorY = () => NaN;
  car.setSolidCapsules([]);
  const M0 = built.get(order[0].uid).M;
  const fwd0 = new THREE.Vector3(0, 0, -1).transformDirection(M0);
  car.setSpawn(new THREE.Vector3().setFromMatrixPosition(M0).addScaledVector(fwd0, 12).add(new THREE.Vector3(0, 0.6, 0)),
    new THREE.Quaternion().setFromAxisAngle(UP, Math.atan2(fwd0.x, fwd0.z)));
  car.enabled = true;
  car.respawn();
  const lips = new Set(arcs.map((a) => a.from));
  const boosts = order.filter((p) => p.id.startsWith("boost")).map((p) => built.get(p.uid).M.clone().invert());
  let lowY = Infinity;
  for (const r of ride) lowY = Math.min(lowY, r.P.y);
  const lipSpeed = new Map();
  // a track that ENDS on a lip (the jump you are building): run until the take-off is measured —
  // that number is the whole point — and call it an open jump, not a failure
  const lastUid = ride[ride.length - 1].uid;
  const endsOnLip = lips.has(lastUid);
  prediction.openJump = false;
  let idx = 0, boost = 0, slow = 0, wasGrounded = true;
  const inv = new THREE.Quaternion(), lp = new THREE.Vector3(), nose = new THREE.Vector3();
  for (let tick = 0; tick < 120 * 180; tick++) {
    // autopilot (drive.js): steer at the centreline 25 m ahead, brake only for flat brake turns
    const p = car.body.pos;
    let best = idx, bd = Infinity;
    for (let i = Math.max(0, idx - 20); i < Math.min(ride.length, idx + 400); i++) { const d = ride[i].P.distanceToSquared(p); if (d < bd) { bd = d; best = i; } }
    idx = best;
    const aim = (dist) => { let i = best, acc = 0; while (i + 1 < ride.length && acc < dist) { acc += ride[i].P.distanceTo(ride[i + 1].P); i++; } return ride[i]; };
    inv.copy(car.body.quat).invert();
    const local = aim(25).P.clone().sub(p).applyQuaternion(inv);
    const steer = THREE.MathUtils.clamp((local.x / Math.max(local.z, 4)) * 2.5, -1, 1);
    const far = aim(90).T;
    nose.set(0, 0, 1).applyQuaternion(car.body.quat);
    const bend = Math.acos(THREE.MathUtils.clamp(far.dot(nose), -1, 1));
    const v = car.body.vel.length();
    const throttle = bend > 1.1 && Math.abs(far.y) < 0.4 && Math.abs(nose.y) < 0.4 && v > 26 && car.groundedCount > 0 ? -1 : 1;
    car.tick({ steerTarget: steer, rollTarget: 0, throttle, handbrake: false, yaw: 0, pitch: 0, analog: true });
    for (const b of boosts) { lp.copy(car.body.pos).applyMatrix4(b); if (Math.abs(lp.x) < 8 && lp.y > -1 && lp.y < 3 && lp.z < -4 && lp.z > -28) boost = 2.0; }
    if (boost > 0 && car.groundedCount > 0) car.body.vel.addScaledVector(nose, 14 * FIXED_DT);
    boost = Math.max(0, boost - FIXED_DT);
    // take-off at a lip: the speed the arc band is built from
    const grounded = car.groundedCount > 0;
    if (wasGrounded && !grounded && lips.has(ride[idx].uid) && !lipSpeed.has(ride[idx].uid)) {
      lipSpeed.set(ride[idx].uid, car.body.vel.length());
      if (ride[idx].uid === lastUid) { prediction.openJump = true; break; }
    }
    wasGrounded = grounded;
    prediction.topKmh = Math.max(prediction.topKmh, v * 3.6);
    prediction.ticks = tick;
    if (p.y < lowY - 60) { prediction.fail = { uid: ride[idx].uid, why: "falls off" }; break; }
    slow = v < 2 ? slow + FIXED_DT : 0;
    if (slow > 3) { prediction.fail = { uid: ride[idx].uid, why: "stops" }; break; }
    if (idx >= ride.length - 5 && !endsOnLip) { prediction.lapS = tick * FIXED_DT; break; }
    if (tick % 240 === 239) {
      await new Promise((r) => setTimeout(r, 0)); // let the page breathe between slices
      if (token !== predToken) return; // a newer edit started another prediction
    }
  }
  if (token !== predToken) return;
  prediction.state = "done";
  prediction.lipSpeed = lipSpeed;
  if (failBox) { scene.remove(failBox); failBox = null; }
  if (prediction.fail && built.get(prediction.fail.uid)) {
    failBox = new THREE.Box3Helper(new THREE.Box3().setFromObject(built.get(prediction.fail.uid).group), 0xff9a3d);
    scene.add(failBox);
  }
  refreshArcs();
  runChecks();
  statusKey = "";
  renderStatus();
}

/** Ends with no road after them. A lip whose flight has a landing (`flightFrom`) is not open. */
function openEnds() {
  const hasChild = new Set(track.pieces.flatMap((p) => [p.parent, p.flightFrom]).filter((u) => u != null));
  return track.pieces.filter((p) => !hasChild.has(p.uid)).map((p) => {
    const m = built.get(p.uid).exit;
    const dir = new THREE.Vector3(0, 0, -1).transformDirection(m);
    return { uid: p.uid, m, lean: leanOut(TILES[p.id]), pitch: Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1)) };
  });
}

// ---------- flight arcs: the car's air model (gravity + drag), a SPEED BAND per lip ----------
const arcGroup = new THREE.Group();
scene.add(arcGroup);
let arcs = []; // { pts, tan, from, landing } — the SLOW edge of the band (landings fit there, P3)
function flight(m, speed) {
  const vel = new THREE.Vector3(0, 0, -1).transformDirection(m).multiplyScalar(speed);
  const P = new THREE.Vector3().setFromMatrixPosition(m);
  const pts = [], tan = [];
  for (let i = 0; i < 120 * 10; i++) {
    const dt = 1 / 120, sp = vel.length();
    vel.addScaledVector(vel, -AIR_DRAG * sp * dt);
    vel.y -= G * dt;
    P.addScaledVector(vel, dt);
    if (i % 4 === 0) { pts.push(P.clone()); tan.push(vel.clone().normalize()); }
    if (P.y < buildY - 400) break;
  }
  return { pts, tan };
}
function refreshArcs() {
  for (const c of arcGroup.children.slice()) { arcGroup.remove(c); c.geometry.dispose(); }
  arcs = [];
  // every lip (a road end pointing up with no road after it): open, or flown to a landing
  const roadChild = new Set(track.pieces.map((p) => p.parent).filter((u) => u != null));
  for (const p of track.pieces) {
    if (roadChild.has(p.uid)) continue;
    const m = built.get(p.uid).exit;
    const dir = new THREE.Vector3(0, 0, -1).transformDirection(m);
    if (Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1)) < 3 * DEG) continue; // level ends just drop
    const landing = track.pieces.find((q) => q.flightFrom === p.uid)?.uid ?? null;
    // the REAL car's take-off speed at this lip (background prediction), else the global guess
    const v = prediction.lipSpeed.get(p.uid) ?? arcSpeed;
    const slow = flight(m, v * 0.93), fast = flight(m, v);
    arcs.push({ ...slow, fast, from: p.uid, landing });
    for (const [a, color] of [[slow, 0xff9a3d], [fast, 0xffd27a]]) {
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(a.pts), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 }));
      arcGroup.add(line);
    }
  }
}

// ---------- live checks: road overlap + flight corridors ----------
function roadSamples() {
  const out = [];
  for (const pc of track.pieces) {
    const { b, t } = piece(pc.id, pc.open);
    const M = built.get(pc.uid).M;
    const hw = SECTIONS[t.section ?? "road"].hw;
    for (const r of b.rings) out.push({ P: deckFrame(r, hw).P.applyMatrix4(M), uid: pc.uid });
  }
  return out;
}
function runChecks() {
  problems = { overlap: new Set(), messages: [] };
  const neighbours = new Map();
  for (const p of track.pieces) { neighbours.set(p.uid, new Set([p.uid])); }
  for (const p of track.pieces) if (p.parent != null) { neighbours.get(p.uid).add(p.parent); neighbours.get(p.parent)?.add(p.uid); }
  const roads = roadSamples();
  const gridMap = new Map();
  const key = (x, z) => `${Math.floor(x / 16)},${Math.floor(z / 16)}`;
  for (const r of roads) { const k = key(r.P.x, r.P.z); (gridMap.get(k) ?? gridMap.set(k, []).get(k)).push(r); }
  for (const r of roads) {
    const cx = Math.floor(r.P.x / 16), cz = Math.floor(r.P.z / 16);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (const o of gridMap.get(`${cx + dx},${cz + dz}`) ?? []) {
      if (neighbours.get(r.uid)?.has(o.uid)) continue;
      if (Math.abs(o.P.y - r.P.y) < 6 && Math.hypot(o.P.x - r.P.x, o.P.z - r.P.z) < 16) { problems.overlap.add(r.uid); problems.overlap.add(o.uid); }
    }
  }
  if (problems.overlap.size) problems.messages.push(`${problems.overlap.size} pieces overlap another road (red)`);
  let blocked = 0;
  for (const a of arcs) for (const p of a.pts) {
    for (const r of gridMap.get(key(p.x, p.z)) ?? []) {
      if (r.uid === a.landing || r.uid === a.from) continue; // the flight's own lip and landing
      const dy = r.P.y - p.y;
      if (dy > 0.5 && dy < 6 && Math.hypot(r.P.x - p.x, r.P.z - p.z) < 9) { blocked++; break; }
    }
  }
  if (blocked) problems.messages.push(`a flight passes under a road (${blocked} points) — the car would hit it`);
  // tint overlapping pieces: a red box around each
  for (const c of overlapBoxes.splice(0)) scene.remove(c);
  for (const uid of problems.overlap) {
    const b = built.get(uid);
    if (!b) continue;
    const box = new THREE.Box3Helper(new THREE.Box3().setFromObject(b.group), 0xff4d5e);
    scene.add(box);
    overlapBoxes.push(box);
  }
}
const overlapBoxes = [];

// ---------- ghost + snapping (P1b order: open ends → flight arcs → local grid → world grid) ----------
const ghostMat = new THREE.MeshBasicMaterial({ color: SNAP_COLORS.world, transparent: true, opacity: 0.5, depthWrite: false });
let ghost = null, ghostDirty = true, snap = null, lastKey = "";
const mouse = { x: 0, y: 0, inside: false };
const ray = new THREE.Raycaster();
const toScreen = (v) => { const p = v.clone().project(camera); return p.z > 1 ? null : { x: (p.x * 0.5 + 0.5) * innerWidth, y: (-p.y * 0.5 + 0.5) * innerHeight }; };
const freeMatrix = (pos, yawDeg) => new THREE.Matrix4().compose(pos, new THREE.Quaternion().setFromEuler(new THREE.Euler(rot.pitch * DEG, yawDeg * DEG, rot.roll * DEG, "YXZ")), new THREE.Vector3(1, 1, 1));
function localRef() {
  const uid = sel ?? track.pieces[track.pieces.length - 1]?.uid;
  const b = uid != null ? built.get(uid) : null;
  if (!b) return null;
  const pos = new THREE.Vector3().setFromMatrixPosition(b.exit);
  const fwd = new THREE.Vector3(0, 0, -1).transformDirection(b.exit);
  return { pos, yaw: Math.atan2(-fwd.x, -fwd.z) };
}
function computeSnap() {
  const id = tileId(tileBase);
  const t = TILES[id];
  let best = null;
  for (const e of openEnds()) {
    const s = toScreen(new THREE.Vector3().setFromMatrixPosition(e.m));
    if (!s) continue;
    const d = Math.hypot(s.x - mouse.x, s.y - mouse.y);
    if (d < 60 && (!best || d < best.d)) best = { type: "end", m: e.m.clone(), parent: e.uid, d, end: e };
  }
  if (best) {
    const want = leanIn(t);
    if (Math.abs(deg(want) - deg(best.end.lean)) > 3) {
      best.bad = best.end.lean
        ? `This end leans ${Math.abs(deg(best.end.lean))}°; this piece starts ${want ? `at ${Math.abs(deg(want))}°` : "flat"}. Use a suggested piece, or "Bank out".`
        : `This end is flat; this piece starts leaning ${Math.abs(deg(want))}°. Start the bank with "Bank in".`;
    }
    return best;
  }
  for (const a of arcs) for (let k = 3; k < a.pts.length; k++) {
    if (a.tan[k].y > -0.02) continue; // only the falling part
    const s = toScreen(a.pts[k]);
    if (!s) continue;
    const d = Math.hypot(s.x - mouse.x, s.y - mouse.y);
    if (d < 30 && (!best || d < best.d)) best = { a, k, d };
  }
  if (best) {
    // a landing slides along the arc to where the fall angle equals its own → its exit comes out level
    if (t.landAngle) {
      const want = t.landAngle * DEG;
      let kBest = best.k, err = Infinity;
      for (let k = 3; k < best.a.pts.length; k++) {
        const fall = Math.asin(THREE.MathUtils.clamp(-best.a.tan[k].y, -1, 1));
        if (fall > 0 && Math.abs(fall - want) < err) { err = Math.abs(fall - want); kBest = k; }
      }
      best.k = kBest;
    }
    const T = best.a.tan[best.k];
    const R = new THREE.Vector3().crossVectors(T, UP).normalize();
    const U = new THREE.Vector3().crossVectors(R, T);
    const P0 = best.a.pts[best.k];
    if (tileBase === FITTED) {
      // FITTED LANDING: the down-slope starts where the SLOW arc falls at 20° and runs until the FAST
      // arc meets it too (+12 m margin): every speed in the band lands on the slope, not past it
      let D = 24;
      for (const q of best.a.fast.pts) {
        const rel = q.clone().sub(P0);
        const along = rel.dot(T);
        if (along > 0 && rel.dot(U) <= 0) { D = along + 12; break; } // crossed the slope surface
      }
      D = Math.max(24, Math.ceil(D / 4) * 4);
      fittedId = ensureTile(`fitted_landing_${FITTED_ANGLE}_${D}`).id;
    }
    const m = socketMatrix({ p: P0, T, U, R });
    if (rot.roll) m.multiply(new THREE.Matrix4().makeRotationZ(rot.roll * DEG));
    return { type: "arc", m, from: best.a.from, bad: leanIn(t) ? "A landing must start flat (lean 0)" : null };
  }
  ray.setFromCamera(new THREE.Vector2((mouse.x / innerWidth) * 2 - 1, -(mouse.y / innerHeight) * 2 + 1), camera);
  const hit = new THREE.Vector3();
  if (!ray.ray.intersectPlane(new THREE.Plane(UP, -buildY), hit)) return null;
  const ref = gridMode === "local" ? localRef() : null;
  const lean = leanIn(t);
  const bad = lean ? `This piece starts leaning ${Math.abs(deg(lean))}°; start it on a leaning end` : null;
  if (ref) {
    const d = hit.clone().sub(ref.pos);
    const c = Math.cos(-ref.yaw), s = Math.sin(-ref.yaw);
    const lx = Math.round((d.x * c + d.z * s) / gridStep) * gridStep, lz = Math.round((-d.x * s + d.z * c) / gridStep) * gridStep;
    const c2 = Math.cos(ref.yaw), s2 = Math.sin(ref.yaw);
    return { type: "local", bad, m: freeMatrix(new THREE.Vector3(ref.pos.x + lx * c2 + lz * s2, buildY, ref.pos.z - lx * s2 + lz * c2), ref.yaw / DEG + rot.yaw) };
  }
  return { type: "world", bad, m: freeMatrix(new THREE.Vector3(Math.round(hit.x / gridStep) * gridStep, buildY, Math.round(hit.z / gridStep) * gridStep), rot.yaw) };
}
function updateGhost() {
  if (!tileBase || !mouse.inside) { if (ghost) ghost.visible = false; snap = null; renderStatus(); return; }
  snap = computeSnap();
  if (!snap) { if (ghost) ghost.visible = false; renderStatus(); return; }
  const id = tileId(tileBase);
  const key = `${id}|${edges}|${snap.type}|${!!snap.bad}|${snap.m.elements.map((x) => x.toFixed(3)).join(",")}`;
  if (key !== lastKey || ghostDirty) {
    lastKey = key; ghostDirty = false;
    if (ghost) scene.remove(ghost);
    ghost = new THREE.Mesh(piece(id, !edges).look.deck, ghostMat);
    ghostMat.color.setHex(snap.bad ? 0xff4d5e : SNAP_COLORS[snap.type]);
    ghost.matrixAutoUpdate = false;
    ghost.matrix.copy(snap.m);
    ghost.renderOrder = 10;
    scene.add(ghost);
  }
  ghost.visible = true;
  renderStatus();
}
function updateGrid() {
  const ref = gridMode === "local" ? localRef() : null;
  const f = snap?.m ? new THREE.Vector3().setFromMatrixPosition(snap.m) : controls.target;
  if (ref) { grid.rotation.y = ref.yaw; grid.position.set(ref.pos.x, buildY, ref.pos.z); }
  else { grid.rotation.y = 0; grid.position.set(Math.round(f.x / 8) * 8, buildY, Math.round(f.z / 8) * 8); }
}

// ---------- next-piece chips at the newest open end ----------
function suggestionsFor(end) {
  const out = [];
  if (Math.abs(deg(end.lean)) > 3) {
    for (const c of CATS) for (const base of c.tiles) for (const h of [1, -1]) {
      const id = tileId(base, h);
      if (h < 0 && id === base) continue;
      if (Math.abs(deg(leanIn(TILES[id])) - deg(end.lean)) < 3 && !out.some((o) => o.id === id)) out.push({ base, h, id });
    }
    const back = out.filter((o) => Math.abs(deg(leanOut(TILES[o.id]))) <= 3), keep = out.filter((o) => Math.abs(deg(leanOut(TILES[o.id]))) > 3);
    return { label: `Leans ${Math.abs(deg(end.lean))}° · fits`, items: [...back.slice(0, 2), ...keep.slice(0, 4)] };
  }
  if (end.pitch > 3 * DEG) return { label: "Lip · land it on the arc", items: [FITTED, "banked_landing_20", "landing_turn_20", "catch_pad"].map((b) => ({ base: b, h: hand, id: tileId(b) })) };
  return recent.length ? { label: "Again", items: recent.slice(0, 4) } : null;
}
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
  const k = sug.label + sug.items.map((i) => i.id).join() + tileBase;
  if (k === nextKey) return;
  nextKey = k;
  el.innerHTML = `<div class="lbl">${sug.label}</div>`;
  const row = document.createElement("div");
  row.className = "row";
  for (const it of sug.items) {
    const b = document.createElement("button");
    b.appendChild(pic(it.id));
    b.appendChild(document.createTextNode(TILES[it.id].label));
    b.onclick = () => pickTile(it.base, it.h);
    row.appendChild(b);
  }
  el.appendChild(row);
}

// ---------- actions ----------
function place() {
  if (!tileBase || !snap) return;
  snapshot();
  const uid = track.nextUid++;
  const id = tileId(tileBase);
  track.pieces.push({ uid, id, open: !edges, M: snap.m.toArray(), parent: snap.type === "end" ? snap.parent : null, flightFrom: snap.type === "arc" ? snap.from : null });
  const ri = recent.findIndex((r) => r.id === id);
  if (ri >= 0) recent.splice(ri, 1);
  recent.unshift({ base: tileBase, h: hand, id });
  rebuild();
  const exit = new THREE.Vector3().setFromMatrixPosition(built.get(uid).exit);
  buildY = Math.round(exit.y / 2) * 2;
  glide = exit;
}
function removePiece(uid) {
  const i = track.pieces.findIndex((p) => p.uid === uid);
  if (i < 0) return;
  snapshot();
  const pc = track.pieces[i];
  for (const c of track.pieces) if (c.parent === uid) { c.parent = pc.parent; if (pc.parent == null) c.M = pc.M; }
  track.pieces.splice(i, 1);
  sel = null;
  rebuild();
}
let selBox = null;
function refreshSelection() {
  if (selBox) { scene.remove(selBox); selBox = null; }
  const b = sel != null ? built.get(sel) : null;
  if (b) { selBox = new THREE.Box3Helper(new THREE.Box3().setFromObject(b.group), 0x3fd2ff); scene.add(selBox); }
}
let glide = null;
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
  const r = box.getSize(new THREE.Vector3()).length() * 0.6 + 30;
  const dir = camera.position.clone().sub(controls.target).normalize();
  controls.target.copy(c);
  camera.position.copy(c).addScaledVector(dir, r * 2);
}

// ---------- status ----------
let statusKey = "";
function predictionLine() {
  const P = prediction;
  if (P.state === "running") return `<div class="row"><span>the car drives your track…</span><b>${(P.ticks / 120).toFixed(1)} s</b></div>`;
  if (P.state !== "done") return "";
  const name = (uid) => { const pc = track.pieces.find((q) => q.uid === uid); return pc ? TILES[pc.id].label : "?"; };
  const lips = [...P.lipSpeed.values()].map((v) => Math.round(v * 3.6)).join(", ");
  if (P.fail) return `<div class="warn">⚠ the car ${P.fail.why} at "${name(P.fail.uid)}" (orange box)</div>`;
  if (P.openJump) return `<div class="row"><span>real car takes off at</span><b>${lips} km/h — land it on the band</b></div>`;
  return `<div class="row"><span>real car: lap</span><b>${P.lapS?.toFixed(1)} s · top ${Math.round(P.topKmh)} km/h</b></div>` +
    (lips ? `<div class="row"><span>take-offs</span><b>${lips} km/h</b></div>` : "");
}
function renderStatus() {
  const names = { end: "open end", arc: "flight arc", local: "local grid", world: "world grid" };
  const k = [snap?.type, snap?.bad, tileBase, hand, edges, sel, gridMode, gridStep, buildY, rot.yaw, rot.pitch, rot.roll, arcSpeed, track.pieces.length, problems.messages.join(), prediction.state, prediction.fail?.uid].join("|");
  if (k === statusKey) return;
  statusKey = k;
  const col = snap?.bad ? "#ff4d5e" : snap ? `#${SNAP_COLORS[snap.type].toString(16).padStart(6, "0")}` : "#8796b5";
  $("status").innerHTML =
    `<div class="mode" style="color:${col}">${tileBase ? `${TILES[tileId(tileBase)].label} → ${names[snap?.type] ?? "—"}` : sel != null ? "Piece selected" : "Pick a piece"}</div>` +
    (snap?.bad ? `<div class="warn">${snap.bad}</div>` : "") +
    problems.messages.map((m) => `<div class="warn">⚠ ${m}</div>`).join("") +
    predictionLine() +
    `<div class="row"><span>grid</span><b>${gridMode} · ${gridStep} m</b></div>` +
    `<div class="row"><span>height</span><b>${buildY} m</b></div>` +
    `<div class="row"><span>turn / pitch / bank</span><b>${rot.yaw}° / ${rot.pitch}° / ${rot.roll}°</b></div>` +
    (prediction.lipSpeed.size
      ? `<div class="row"><span>band (real car)</span><b>${[...prediction.lipSpeed.values()].map((v) => `${Math.round(v * 0.93 * 3.6)}–${Math.round(v * 3.6)}`).join(" · ")} km/h</b></div>`
      : `<div class="row"><span>arc band (guess)</span><b>${Math.round(arcSpeed * 0.93 * 3.6)}–${Math.round(arcSpeed * 3.6)} km/h</b></div>`) +
    `<div class="row"><span>pieces</span><b>${track.pieces.length}</b></div>`;
}

// ---------- input ----------
const canvas = renderer.domElement;
canvas.addEventListener("pointermove", (e) => { mouse.x = e.clientX; mouse.y = e.clientY; mouse.inside = true; });
canvas.addEventListener("pointerleave", () => { mouse.inside = false; });
let down = null;
canvas.addEventListener("pointerdown", (e) => { down = { x: e.clientX, y: e.clientY, b: e.button }; });
canvas.addEventListener("pointerup", (e) => {
  const d = down; down = null;
  if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5) return;
  if (d.b === 2 && tileBase) { tileBase = null; renderDock(); return; }
  if (d.b !== 0) return;
  if (tileBase) { place(); return; }
  ray.setFromCamera(new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1), camera);
  let o = ray.intersectObjects(trackGroup.children, true)[0]?.object;
  while (o && o.userData.uid == null) o = o.parent;
  sel = o?.userData.uid ?? null;
  refreshSelection();
});
canvas.addEventListener("contextmenu", (e) => e.preventDefault());
canvas.addEventListener("wheel", (e) => {
  if (!e.shiftKey) return;
  e.preventDefault(); e.stopImmediatePropagation();
  buildY += (e.deltaY || e.deltaX) < 0 ? 2 : -2;
  ghostDirty = true;
}, { capture: true, passive: false });
addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === "z") { e.preventDefault(); restore(e.shiftKey ? redo : undo, e.shiftKey ? undo : redo); return; }
  if ((e.ctrlKey || e.metaKey) && k === "y") { e.preventDefault(); restore(redo, undo); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const digit = /^Digit([1-4])$/.exec(e.code);
  if (digit) { gridStep = GRID_STEPS[+digit[1] - 1]; ghostDirty = true; return; }
  const step = e.shiftKey ? 5 : 15;
  switch (e.key) {
    case "ArrowUp": rot.pitch = Math.min(45, rot.pitch + 5); break;
    case "ArrowDown": rot.pitch = Math.max(-45, rot.pitch - 5); break;
    case "ArrowLeft": rot.roll = Math.max(-45, rot.roll - 5); break;
    case "ArrowRight": rot.roll = Math.min(45, rot.roll + 5); break;
    case "PageUp": buildY += 2; break;
    case "PageDown": buildY -= 2; break;
    case "Enter": place(); break;
    case "Escape": if (tileBase) { tileBase = null; renderDock(); } else { sel = null; refreshSelection(); } break;
    case "Delete": case "Backspace": if (!tileBase && sel != null) removePiece(sel); break;
    case "[": arcSpeed = Math.max(20, arcSpeed - 1); refreshArcs(); runChecks(); break;
    case "]": arcSpeed = Math.min(80, arcSpeed + 1); refreshArcs(); runChecks(); break;
    default:
      if (k === "q") rot.yaw += step;
      else if (k === "e") rot.yaw -= step;
      else if (k === "r") { hand = -hand; renderDock(); }
      else if (k === "g") gridMode = gridMode === "world" ? "local" : "world";
      else if (k === "t") { edges = !edges; renderDock(); }
      else if (k === "f") frameAll();
      else return;
  }
  rot.yaw = ((rot.yaw % 360) + 360) % 360;
  ghostDirty = true;
  e.preventDefault();
});
addEventListener("resize", () => { fitView(); renderer.setSize(innerWidth, innerHeight); });
$("b-undo").onclick = () => restore(undo, redo);
$("b-redo").onclick = () => restore(redo, undo);
$("b-frame").onclick = frameAll;
$("b-keys").onclick = () => $("keys").classList.toggle("hidden");
$("b-new").onclick = () => { snapshot(); track = { pieces: [], nextUid: 1 }; sel = null; rebuild(); };
$("b-drive").onclick = () => { save(); window.open("/games/thunderline/proto/kit/drive.html?track=local", "_blank"); };

// ---------- go ----------
await bakeThumbs();
$("boot").classList.add("gone");
renderDock();
rebuild();
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
window.__b3 = {
  get track() { return track; }, get snap() { return snap; }, get problems() { return problems; }, built: () => built,
  pickTile, place, removePiece, frameAll, setMouse(x, y) { mouse.x = x; mouse.y = y; mouse.inside = true; },
  aimEnd() { const e = openEnds().at(-1); const s = e && toScreen(new THREE.Vector3().setFromMatrixPosition(e.m)); if (s) { mouse.x = s.x; mouse.y = s.y; mouse.inside = true; } return s; },
  aimArc(k) { const a = arcs.at(-1); if (!a) return null; const p = a.pts[Math.min(k, a.pts.length - 1)]; const s = toScreen(p); if (s) { mouse.x = s.x; mouse.y = s.y; mouse.inside = true; } return { s, n: a.pts.length }; },
  setHand(h) { hand = h; renderDock(); }, setEdges(v) { edges = v; renderDock(); }, setBuildY(y) { buildY = y; },
  reset() { track = { pieces: [], nextUid: 1 }; rebuild(); },
  setTrack(t) { track = t; rebuild(); },
  get prediction() { return { state: prediction.state, fail: prediction.fail, lapS: prediction.lapS, openJump: prediction.openJump, topKmh: Math.round(prediction.topKmh), lips: [...prediction.lipSpeed.entries()].map(([u, v]) => [u, Math.round(v * 3.6)]) }; },
};
