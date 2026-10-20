// Thunderline builder B1 — the snapping builder (P1b's ghost, dock and next-piece chips) on the NEW
// pieces (kit.js: path × section × lean, drawn with the old look). Ends carry their lean; road
// overlaps and blocked flight corridors are checked live; "Drive" opens the track with the real car.
// Throwaway prototype (DESIGN.md §4–§5, §9).
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { uniform, positionLocal, abs, fract, fwidth, float, min, max, smoothstep, length, vec3 } from "three/tsl";
import { startV3App } from "../../../../v3/engine.js";
import { TILES, integrate, socketMatrix, leanIn, leanOut, deckFrame, SECTIONS, DEG, ensureTile, ADJUSTABLE, adjustableId, parseAdjustable } from "./kit.js";
import { buildOldLook, createOldLookMaterials } from "./oldLook.js";
import { createAutopilot } from "./autopilot.js";
import { createCarRules, magnetZones } from "./carRules.js";
import { makeGateMesh, makeRingMesh } from "./gateMesh.js";
import { closureAt, wallAt } from "./tubeLook.js";
import { createRace } from "./race.js";
import { library, settings, PAGES } from "../../app/library.js";
import { createDriveRig } from "./driveSession.js";
import { createEditorNav } from "./editorNav.js";
import { applyWorld, WORLDS, DEFAULT_WORLD, TIMES, DEFAULT_TOD } from "./worlds.js";
import { encodeTrack } from "../../app/trackCode.js";
import { OBSTACLES, isObstacle, obstacleLook, buildObstacleSet, avoidObstacles } from "./obstacles.js";
import { Vehicle, FIXED_DT, TIRE, WHEEL, SOLID, CRASH } from "../../../../v3/play/modularRoadVehicle.js";
import { applyCarTune } from "./carTune.js";
import { RoadBvh } from "../../../../v3/play/modularRoadBvh.js";
import { createVehicleGround } from "../../../../v3/play/modularRoadGround.js";

// the drive page's tune (carTune.js): the prediction drives the SAME car
applyCarTune({ TIRE, WHEEL, SOLID, CRASH });
const ROAD_HOLD = new Set(["bank_in_22", "bank_out_22", "fast_turn_128"]);

const $ = (id) => document.getElementById(id);
// THE TRACK: one record of the library (app/library.js), ?track=<id>; without one, the track last
// worked on, else a new one
const params = new URLSearchParams(location.search);
let trackId = params.get("track");
if (!trackId || !library.get(trackId)) trackId = (library.current && library.get(library.current) ? library.current : null) ?? library.list()[0]?.id ?? library.create().id;
library.current = trackId;
history.replaceState(null, "", `${location.pathname}?track=${trackId}`);
const UP = new THREE.Vector3(0, 1, 0);
// THE FLOOR (the drive page's default floor, solid): pieces must stay above it, flights end on it
const FLOOR_Y = 0;
const G = 9.81;
const AIR_DRAG = 0.45 / 1400; // the car's AERO.drag / mass (P3: arcs must use it)
const SNAP_COLORS = { end: 0x45e08a, road: 0x45e08a, arc: 0xff9a3d, local: 0xc78bff, world: 0x3fd2ff };
const GRID_STEPS = [1, 2, 4, 8];

const CATS = [
  { id: "road", label: "Road", tiles: ["start_line", "finish_line", "adj_straight", "adj_slope", "straight_64", "boost_32", "slope_up_12", "slope_down_12", "helix_up_360", "helix_down_360", "rollers_64"] },
  // flat-out first, then a lift, then the brake ones (PIECES.md §7d: the turn set)
  { id: "turns", label: "Turns", tiles: ["adj_turn", "sweep_160_15", "sweep_160_30", "sweep_160_45", "s_bend_96", "turn_96_45", "turn_96_90", "fast_turn_128", "snake_60", "turn_48_90", "brake_turn_32", "turn_48_180", "hairpin_24"] },
  { id: "lean", label: "Lean", tiles: ["bank_in_22", "bank_out_22"] },
  { id: "air", label: "Air", tiles: ["adj_kicker", "kicker_20", "gap_jump", "drop_16", "air_ring", "fitted_landing", "landing_20", "banked_landing_20", "landing_turn_20", "catch_pad"] },
  { id: "tubes", label: "Tubes", tiles: ["halfpipe_in", "halfpipe_64", "halfpipe_turn_64", "halfpipe_out", "tube_in", "tube_32", "tube_64", "tube_turn_64", "tube_turn_32", "tube_roof_drop", "tube_cannon", "tube_out"] },
  { id: "platforms", label: "Platforms", tiles: ["platform_32", "platform_64", "platform_128", "platform_turn_90", "platform_up_12", "platform_down_12"] },
  { id: "stunts", label: "Stunts", tiles: ["twist_120", "fitted_bowl", "flip_ramp_std", "flip_ramp_s", "loop_28", "wallride_90"] },
  // things on the road that are not road (obstacles.js): placed on a road or on the floor, kept in track.props
  { id: "obstacles", label: "Obstacles", tiles: ["ob_block", "ob_sweeper"] },
];
const catOf = new Map();
for (const c of CATS) for (const t of c.tiles) catOf.set(t, c.id);

// ---------- state ----------
let track = load() ?? { pieces: [], nextUid: 1 };
let trackName = library.get(trackId)?.name ?? "Track";
let hand = 1; // +1 right, −1 left (picks the "_L" mirror)
let edges = true; // guarded / open
let tileBase = null; // base id in hand
let sel = null;
let gridMode = "world";
let gridStep = 8;
let buildY = 120;
const rot = { yaw: 0, pitch: 0, roll: 0 };
let arcSpeed = 57; // m/s at a lip (≈ 0.91 × top 63, P3); [ ] change it
// THE SLOW EDGE of a jump's speed band, as a share of the real car's take-off speed: landings catch every
// car from here to full speed. Was 0.93 (the autopilot's spread); a player who lands crooked keeps 85%
// and loses the perfect-landing boost, and arrived at a kicker at 0.74 × and fell short (user, 2026-10-19:
// "I cannot land on this track at all"). 0.75 made every landing 200-300 m long (100 m of height each);
// 0.85 is the middle: one crooked landing before a jump still lands it.
const BAND_SLOW = 0.85;
let undo = [], redo = [];
const recent = [];
function load() { const t = library.get(trackId)?.track; return t ? JSON.parse(JSON.stringify(t)) : null; }
// every edit saves the track; its thumbnail is re-rendered a moment after the edits stop
let thumbTimer = null;
function save() {
  library.saveTrack(trackId, track);
  clearTimeout(thumbTimer);
  thumbTimer = setTimeout(() => trackThumb().then((url) => url && library.saveTrack(trackId, track, url)), 1200);
}
function snapshot() { undo.push(JSON.stringify(track)); if (undo.length > 200) undo.shift(); redo = []; }
function restore(from, to) {
  if (!from.length) return;
  to.push(JSON.stringify(track));
  const world = track.world, tod = track.tod ?? DEFAULT_TOD;
  track = JSON.parse(from.pop());
  sel = null;
  rebuild();
  if (track.world !== world) { applyWorld(app, track.world); $("b-world").value = WORLDS[track.world] ? track.world : DEFAULT_WORLD; } // an undone world switch
  if ((track.tod ?? DEFAULT_TOD) !== tod) { app.sky?.setTimeOfDay?.(track.tod ?? DEFAULT_TOD); $("b-tod").value = String(track.tod ?? DEFAULT_TOD); } // … or time
}
// "fitted_landing" is not a fixed tile: the builder generates one per jump, sized to its speed band
// (kit.js ensureTile). Until the ghost is on an arc it shows a default size.
const FITTED = "fitted_landing";
const FITTED_ANGLE = 20;
let fittedId = ensureTile(`fitted_landing_${FITTED_ANGLE}_32`).id;
// "fitted_bowl": a U-turn bowl (oldTiles.js) whose radius fits the speed the car ARRIVES at that end
// (the background prediction measures it). bowlTest.mjs, real car, wall cut, air 180: at the speed it
// is fitted to, R = 95 + 2.2·(v − 44) gives ~4.5 s of air and a 26–30 m apex over the lip, and 7%
// slower still ~3.5 s; ≥ v²/2g + ~15 m it stalls on the face. Hand = the side of the return lane.
const FITTED_BOWL = "fitted_bowl";
const bowlRadius = (v) => THREE.MathUtils.clamp(Math.round((95 + 2.2 * (v - 44)) / 5) * 5, 80, 160);
let bowlR = bowlRadius(arcSpeed);
for (const id of ["flip_ramp_std", "flip_ramp_s", "start_line", "finish_line"]) ensureTile(id);
// "air_ring": a CHECKPOINT IN THE AIR, placed on a flight arc (never on road). Its centre sits on the
// FAST edge of the band — the line of a full-speed take-off — so it tests the take-off: hit the lip at
// speed, on the right line (in the air the car only rotates; nothing there changes where it flies).
const RING = "air_ring";
const RING_R = 5.5;
const ringGateOf = (pc) => {
  const M = new THREE.Matrix4().fromArray(pc.M);
  return { kind: "cp", ring: true, P: new THREE.Vector3().setFromMatrixPosition(M), T: new THREE.Vector3(0, 0, -1).transformDirection(M), U: new THREE.Vector3(0, 1, 0).transformDirection(M), hw: RING_R };
};
const isRing = (p) => !!p?.ring;
// ADJUSTABLE pieces (kit.js ADJUSTABLE): the card's settings in hand, one set per kind
const adjDefaults = (base) => Object.fromEntries(Object.entries(ADJUSTABLE[base].params).map(([k, q]) => [k, q.def]));
const adjParams = Object.fromEntries(Object.keys(ADJUSTABLE).map((b) => [b, adjDefaults(b)]));
const tileId = (base, h = hand) => {
  if (ADJUSTABLE[base]) return ensureTile(adjustableId(base, adjParams[base], ADJUSTABLE[base].hand ? h : 1)).id;
  if (base === RING || isObstacle(base) || base === STAMP) return base;
  if (base === FITTED) return fittedId;
  if (base === FITTED_BOWL) return ensureTile(`bowl_${bowlR}${h < 0 ? "_L" : ""}`).id;
  return h < 0 && TILES[`${base}_L`] ? `${base}_L` : base;
};
const tileLabel = (base) => (ADJUSTABLE[base] ? `${TILES[tileId(base)].label} ⚙` : base === STAMP ? `Section · ${clipboard?.n ?? 0} piece${clipboard?.n === 1 ? "" : "s"}${hand < 0 ? " (mirrored)" : ""}` : isObstacle(base) ? OBSTACLES[base].label : base === RING ? "Air ring" : base === FITTED ? "Fitted landing" : base === FITTED_BOWL ? `Fitted bowl · R${bowlR}` : TILES[base].label);
const thumbOf = (id) => (parseAdjustable(id) ? parseAdjustable(id).base : id === RING || isObstacle(id) ? id : id === FITTED || id.startsWith("fitted_landing_") ? "landing_20" : id === FITTED_BOWL || id.startsWith("bowl_") ? "fitted_bowl" : id.replace(/_L$/, ""));
const deg = (r) => Math.round((r / DEG) * 10) / 10;

// ---------- renderer ----------
const DOCK_H = 175;
// THE SAME WORLD AS THE DRIVE PAGE (user, 2026-10-19: "the track editor should have the nice sky… really
// the same as the track when pressing play"): the engine app with drive.js's sky, time of day, light,
// bloom and default floor. The builder keeps its own orbit (its mouse buttons) and its frame work runs
// in the engine's pre-update hook; the engine renders.
const app = await startV3App({
  container: $("view"),
  skyMode: "skypro",
  cloudShadows: true,
  light: { envIntensity: 0.45, hemiIntensity: 0.6, dirIntensity: 2.6, exposure: 1.0, shadowNormalBias: 0.12 },
  terrainFeatures: { cursor: false },
  splatFeatures: { solo: false },
  preloadPaintTextures: false,
  csm: { cascades: 2 },
});
app.sky?.setMode?.("skypro");
app.sky?.setTimeOfDay?.(track.tod ?? DEFAULT_TOD); // the track's own time of day (worlds.js TIMES)
app.fog?.setHeight?.({ enabled: false });
applyWorld(app, track.world); // worlds.js: the track's world (the haze too), before any material is built
app.postFx?.setEnabled?.(true);
app.postFx?.setBloomSelective?.(true);
app.postFx?.setBloom?.({ enabled: true, strength: 0.9, threshold: 0.0, radius: 0.5 });
const { scene, camera, renderer } = app;
app.controls.update = () => {}; // the builder's orbit below owns the camera
app.controls.enabled = false;
camera.far = Math.max(camera.far, 9000);
function fitView() { camera.aspect = innerWidth / innerHeight; camera.setViewOffset(innerWidth, innerHeight, 0, DOCK_H / 2, innerWidth, innerHeight); camera.updateProjectionMatrix(); }
fitView();
camera.position.set(120, buildY + 110, 160);
const controls = new OrbitControls(camera, renderer.domElement);
// the mouse buttons, limits and keys of the orbit: editorNav.js (made below, once the builder is up)
controls.zoomToCursor = true;
controls.enableDamping = true;
controls.target.set(0, buildY, 0);
// THE BUILD GRID (user, 2026-10-20: the editor's grid over the ground's own grid was confusing): bolt
// blue, at the grid step in use (a brighter line every 4), and only ROUND the cursor / the piece in hand,
// fading out by ~140 m — not a sheet over the whole ground
const gridStepU = uniform(8);
// (pushed back in depth: at the build height it is coplanar with the road there — the road must win, never flicker)
const gridMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, fog: false, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 8 });
{
  const lineAt = (scale) => {
    const q = positionLocal.xz.div(gridStepU.mul(scale));
    const d = abs(fract(q.sub(0.5)).sub(0.5)).div(fwidth(q));
    return float(1).sub(min(min(d.x, d.y), 1));
  };
  const fade = float(1).sub(smoothstep(50, 140, length(positionLocal.xz)));
  gridMat.colorNode = vec3(0.25, 0.82, 1.0);
  gridMat.opacityNode = max(lineAt(1).mul(0.28), lineAt(4).mul(0.55)).mul(fade);
}
const grid = new THREE.Mesh(new THREE.PlaneGeometry(300, 300).rotateX(-Math.PI / 2), gridMat);
grid.renderOrder = 5;
scene.add(grid);

// ---------- pieces (geometry cache) ----------
const mats = createOldLookMaterials();
const cache = new Map();
function piece(id, open = false) {
  const key = `${id}|${open}`;
  if (!cache.has(key)) {
    const t = ensureTile(id);
    const b = integrate(t);
    cache.set(key, { t, b, look: buildOldLook(t, !open), exitLocal: socketMatrix(b.exit) });
  }
  return cache.get(key);
}
function meshesFor(id, open) {
  const { look } = piece(id, open);
  const g = new THREE.Group();
  g.add(new THREE.Mesh(look.deck, TILES[id]?.tube || TILES[id]?.halfpipe ? mats.tube : mats.road));
  if (look.rail) g.add(new THREE.Mesh(look.rail, look.trim ? mats.trim : mats.rail));
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
    const pid = id === FITTED_BOWL ? "bowl_110" : ADJUSTABLE[id] ? ensureTile(adjustableId(id, adjDefaults(id))).id : id; // a typical one
    const g = id === RING
      ? makeRingMesh({ P: new THREE.Vector3(), T: new THREE.Vector3(0.5, -0.15, -1).normalize(), U: new THREE.Vector3(0, 1, 0), hw: RING_R })
      : isObstacle(id) ? obstacleLook(id) : meshesFor(pid, false);
    const t = id === RING || isObstacle(id) ? {} : ensureTile(pid);
    if (id !== RING) g.rotation.x = -(t.landAngle ?? 0) * DEG;
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

// ---------- the track's thumbnail (library cards): the track alone, 3/4 view ----------
const thumbScene = new THREE.Scene();
thumbScene.background = new THREE.Color(0x4a4a51); // a neutral grey behind the dark road (the menu is black: user, 2026-10-20)
thumbScene.add(new THREE.HemisphereLight(0xeaf3ff, 0x6a6a72, 3.2));
{ const d = new THREE.DirectionalLight(0xfff2e0, 3.6); d.position.set(-300, 500, 200); thumbScene.add(d); }
async function trackThumb() {
  if (!trackGroup.children.length) return null;
  const W = 320, H = 180;
  const rt = new THREE.RenderTarget(W, H, { type: THREE.UnsignedByteType, colorSpace: THREE.SRGBColorSpace });
  const cam = new THREE.PerspectiveCamera(35, W / H, 1, 20000);
  // ZOOMED ON THE ROAD (user, 2026-10-20: "it needs to be zoomed in more to see something"): fit the
  // road's own points (a box's empty corners kept a long track small in the middle), looking ACROSS the
  // track's long side so its length runs along the picture's width, from a steep 3/4 view
  const pts = [];
  for (const pc of track.pieces) {
    const b = built.get(pc.uid);
    if (!b || isRing(pc)) continue;
    for (const r of piece(pc.id, pc.open).b.rings) pts.push(r.p.clone().applyMatrix4(b.M));
  }
  if (!pts.length) { rt.dispose(); return null; }
  // ...and not the WHOLE track (user: "zoomed in way more"): a 1 km track whole is a hairline whatever
  // the framing. The picture is the BUSIEST spot — where the most road sits within 70 m (a loop, a
  // helix, a run of jumps) — framed close, like a screenshot of it
  const R = 70;
  let focus = pts[0], bestN = -1;
  for (let i = 0; i < pts.length; i += 2) {
    let n = 0;
    for (const q of pts) if (q.distanceToSquared(pts[i]) < R * R) n++;
    if (n > bestN) { bestN = n; focus = pts[i]; }
  }
  const near = pts.filter((q) => q.distanceToSquared(focus) < R * R);
  pts.length = 0;
  pts.push(...near);
  let mx = 0, mz = 0;
  for (const p of pts) { mx += p.x; mz += p.z; }
  mx /= pts.length; mz /= pts.length;
  let sxx = 0, szz = 0, sxz = 0;
  for (const p of pts) { const dx = p.x - mx, dz = p.z - mz; sxx += dx * dx; szz += dz * dz; sxz += dx * dz; }
  const ang = 0.5 * Math.atan2(2 * sxz, sxx - szz); // the long axis
  const across = new THREE.Vector3(-Math.sin(ang), 0, Math.cos(ang)); // perpendicular to it
  const dir = across.multiplyScalar(Math.cos(40 * DEG)).add(new THREE.Vector3(0, Math.sin(40 * DEG), 0)).normalize();
  const box = new THREE.Box3().setFromPoints(pts);
  const c = box.getCenter(new THREE.Vector3());
  let dist = box.getSize(new THREE.Vector3()).length();
  for (let i = 0; i < 30; i++) {
    cam.position.copy(c).addScaledVector(dir, dist);
    cam.lookAt(c);
    cam.updateMatrixWorld();
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of pts) { const q = p.clone().project(cam); x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y); }
    // re-centre on what the camera sees, then settle where the road just fills ~90% of the frame
    const off = new THREE.Vector3((x0 + x1) / 2, (y0 + y1) / 2, 0.5).unproject(cam).sub(cam.position).normalize();
    const along = new THREE.Vector3().subVectors(c, cam.position).length();
    c.copy(cam.position).addScaledVector(off, along);
    const ext = Math.max((x1 - x0) / 2, (y1 - y0) / 2);
    dist *= ext > 0.9 ? 1.05 : 0.96;
  }
  // the track borrowed into the thumbnail scene for one render, then given back
  thumbScene.add(trackGroup);
  renderer.setRenderTarget(rt);
  renderer.render(thumbScene, cam);
  renderer.setRenderTarget(null);
  scene.add(trackGroup);
  const px = await renderer.readRenderTargetPixelsAsync(rt, 0, 0, W, H);
  rt.dispose();
  const cvs = document.createElement("canvas"); cvs.width = W; cvs.height = H;
  const ctx = cvs.getContext("2d");
  const img = ctx.createImageData(W, H);
  const stride = px.length / H;
  for (let y = 0; y < H; y++) for (let x = 0; x < W * 4; x++) img.data[y * W * 4 + x] = px[y * stride + x];
  ctx.putImageData(img, 0, 0);
  return cvs.toDataURL("image/jpeg", 0.82);
}

// ---------- dock ----------
let activeCat = CATS[0].id;
const BOLT = `<svg viewBox="0 0 16 16"><path fill="currentColor" d="M9.5 0 2 9h5l-1.5 7L14 6.5H9z"/></svg>`;
function pic(id, cls = "pic") {
  const el = document.createElement("div");
  el.className = cls;
  const url = thumbs.get(thumbOf(id));
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
  if (editMode && sel != null) {
    editWith(base === RING || base === FITTED || base === FITTED_BOWL ? base : tileId(base, h ?? hand));
    renderDock();
    renderStatus();
    return;
  }
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
let obstacleSet = null; // the track's obstacles as drawn (obstacles.js); the sweepers turn on the page's clock
let problems = { overlap: new Set(), messages: [], loose: [], misses: [] };

function rebuild() {
  for (const c of trackGroup.children.slice()) trackGroup.remove(c);
  built = new Map();
  for (const pc of track.pieces) {
    if (isRing(pc)) {
      const g = makeRingMesh(ringGateOf(pc));
      g.userData.uid = pc.uid;
      trackGroup.add(g);
      const M = new THREE.Matrix4().fromArray(pc.M);
      built.set(pc.uid, { exit: M.clone(), group: g, M });
      continue;
    }
    const M = pc.parent != null && built.has(pc.parent) ? built.get(pc.parent).exit.clone() : new THREE.Matrix4().fromArray(pc.M);
    pc.M = M.toArray();
    ensureTile(pc.id); // generated pieces (fitted landings) are rebuilt from their id
    const g = meshesFor(pc.id, pc.open);
    g.matrixAutoUpdate = false;
    g.matrix.copy(M);
    g.userData.uid = pc.uid;
    trackGroup.add(g);
    if (pc.cp) trackGroup.add(checkpointGate(pc, M));
    built.set(pc.uid, { exit: M.clone().multiply(piece(pc.id, pc.open).exitLocal), group: g, M });
  }
  // OBSTACLES (track.props): drawn here, selectable like pieces; the sweepers turn on the page's clock
  obstacleSet = buildObstacleSet(track.props ?? []);
  for (const vis of obstacleSet.group.children.slice()) {
    trackGroup.add(vis);
    const M = vis.matrix.clone();
    built.set(vis.userData.uid, { exit: M, group: vis, M, prop: true });
  }
  save();
  refreshArcs();
  runChecks();
  refreshSelection();
  ghostDirty = true;
  schedulePrediction();
}

// ---------- CHECKPOINTS (race.js): a flag on any piece; select it and press C ----------
function checkpointGate(pc, M) {
  const { b, t } = piece(pc.id, pc.open);
  const hw = SECTIONS[t.section ?? "road"].hw;
  const r = b.rings[Math.floor(b.rings.length / 2)];
  const f = deckFrame(r, hw);
  return makeGateMesh({ kind: "cp", P: f.P.clone().applyMatrix4(M), T: r.T.clone().transformDirection(M), U: f.U.clone().transformDirection(M), hw }, { lift: 0 });
}
function toggleCheckpoint(uid) {
  const pc = track.pieces.find((p) => p.uid === uid);
  if (!pc || isRing(pc)) return; // an air ring IS a checkpoint
  snapshot();
  pc.cp = !pc.cp;
  if (!pc.cp) delete pc.cp;
  rebuild();
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
    cur = track.pieces.find((q) => q.parent === cur.uid) ?? track.pieces.find((q) => q.flightFrom === cur.uid && !isRing(q));
  }
  return out;
}
// ---------- THE TEST LAP, DRAWN ON THE TRACK (user, 2026-10-20) ----------
// The prediction's car, every few ticks: a ribbon just above the road coloured by its SPEED (deep blue
// slow → bolt blue → white fast), dashed where it flies; marks where it hits something or falls (red)
// and where it brakes hard or lands rough (orange). You see WHY a jump falls short or where a track
// kills the speed, not just a number.
let lapLineOn = true;
const lapGroup = new THREE.Group();
scene.add(lapGroup);
const lapRibbonMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
const lapMarkMats = { hit: new THREE.MeshBasicMaterial({ color: 0xff4d5e }), fall: new THREE.MeshBasicMaterial({ color: 0xff4d5e }), brake: new THREE.MeshBasicMaterial({ color: 0xff9a3d }), rough: new THREE.MeshBasicMaterial({ color: 0xff9a3d }) };
const lapMarkGeo = new THREE.OctahedronGeometry(1.6);
const speedTone = (v, top) => {
  const t = Math.min(1, v / Math.max(1, top));
  const c0 = [0.12, 0.36, 0.79], c1 = [0.25, 0.82, 1.0], c2 = [0.95, 0.98, 1.0];
  const [A, B, f] = t < 0.6 ? [c0, c1, t / 0.6] : [c1, c2, (t - 0.6) / 0.4];
  return A.map((x, i) => x + (B[i] - x) * f);
};
function drawLapLine(samples, events) {
  for (const c of lapGroup.children.slice()) { lapGroup.remove(c); c.geometry?.dispose?.(); }
  lapGroup.visible = lapLineOn && !driving;
  if (samples.length < 2) return;
  const top = Math.max(...samples.map((q) => q.v));
  const pos = [], col = [], idx = [];
  const dir = new THREE.Vector3(), right = new THREE.Vector3();
  for (let i = 0; i < samples.length; i++) {
    const q = samples[i], n = samples[Math.min(samples.length - 1, i + 1)], b = samples[Math.max(0, i - 1)];
    dir.subVectors(n.p, b.p);
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
    right.crossVectors(dir.normalize(), q.up).normalize();
    const base = q.p.clone().addScaledVector(q.up, -0.42); // just above the deck under the car
    const w = 0.9;
    pos.push(...base.clone().addScaledVector(right, -w).toArray(), ...base.clone().addScaledVector(right, w).toArray());
    const c = speedTone(q.v, top);
    col.push(...c, ...c);
    // in the AIR: dashed (every other step left out)
    if (i < samples.length - 1 && !(q.air && n.air && i % 2)) { const k = i * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  const ribbon = new THREE.Mesh(g, lapRibbonMat);
  ribbon.renderOrder = 6;
  ribbon.frustumCulled = false;
  lapGroup.add(ribbon);
  for (const e of events) {
    const m = new THREE.Mesh(lapMarkGeo, lapMarkMats[e.kind]);
    m.position.copy(e.p).addScaledVector(e.up ?? UP, 1.8);
    m.scale.setScalar(e.kind === "fall" ? 1.6 : 1);
    m.renderOrder = 7;
    lapGroup.add(m);
  }
}
function setLapLine(on) { lapLineOn = on; lapGroup.visible = on && !driving; statusKey = ""; renderStatus(); }

async function runPrediction() {
  const token = ++predToken;
  const order = orderedPieces();
  if (order.length < 2) { prediction = { state: "idle", lipSpeed: new Map(), fail: null, lapS: null, topKmh: 0, ticks: 0 }; return; }
  prediction = { state: "running", lipSpeed: prediction.lipSpeed, launch: prediction.launch, endSpeed: prediction.endSpeed, fail: null, lapS: null, topKmh: 0, ticks: 0 };
  renderStatus();
  // collision, as drive.js: decks (road hold on banked pieces) + rail collision proxies
  const col = (geometry, M, userData = {}) => ({ geometry, matrixWorld: M, userData, updateMatrixWorld() {} });
  const decks = [], solids = [], ride = [];
  for (const pc of order) {
    const { look, b, t } = piece(pc.id, pc.open);
    const M = built.get(pc.uid).M;
    decks.push(col(look.deck, M, { roadHold: ROAD_HOLD.has(pc.id.replace(/_L$/, "")) || !!t.roadHold, freeCarve: !!t.freeCarve }));
    if (look.railCollision) solids.push(col(look.railCollision, M));
    const hw = SECTIONS[t.section ?? "road"].hw;
    for (const r of b.rings) {
      const f = deckFrame(r, hw);
      const Pr = r.pivot != null ? f.P.clone().addScaledVector(f.U, r.pivot) : f.P; // a twist: its roll axis
      ride.push({ P: Pr.clone().applyMatrix4(M), T: r.T.clone().transformDirection(M), U: f.U.clone().transformDirection(M), uid: pc.uid, tube: t.tube ? closureAt(t, r.s, b.L) : t.halfpipe ? 0.5 * wallAt(t, r.s, b.L) : 0, air: !!r.air });
    }
  }
  // the obstacles, as the drive page has them (the movers on the run's clock, tick by tick)
  const obs = buildObstacleSet(track.props ?? [], { look: false });
  for (const d of obs.decks) decks.push(col(d.geometry, d.M));
  for (const s of obs.solids) solids.push(col(s.geometry, s.M));
  const deckBvh = new RoadBvh(), solidsBvh = new RoadBvh();
  deckBvh.bakeFromMeshes(decks);
  solidsBvh.bakeFromMeshes(solids);
  const ground = createVehicleGround({ getTerrainHeight: () => FLOOR_Y });
  ground.setRoadBvh(deckBvh.baked ? deckBvh : null);
  ground.setRoadSolidsBvh(solidsBvh.baked ? solidsBvh : null);
  const car = new Vehicle({ scene: predScene, showArrows: false });
  car.SUBSTEPS = 3;
  car.setBvh(ground.ground, ground.solids);
  car.getFloorY = () => FLOOR_Y;
  car.setSolidCapsules([]);
  car.setDynamicMovers(obs.movers);
  const M0 = built.get(order[0].uid).M;
  const fwd0 = new THREE.Vector3(0, 0, -1).transformDirection(M0);
  car.setSpawn(new THREE.Vector3().setFromMatrixPosition(M0).addScaledVector(fwd0, TILES[order[0].id]?.start?.spawn ?? 12).add(new THREE.Vector3(0, 0.6, 0)),
    new THREE.Quaternion().setFromAxisAngle(UP, Math.atan2(fwd0.x, fwd0.z)));
  car.enabled = true;
  car.respawn();
  const lips = new Set(arcs.map((a) => a.from));
  const boosts = order.filter((p) => p.id.startsWith("boost")).map((p) => built.get(p.uid).M.clone().invert());
  let lowY = Infinity;
  for (const r of ride) lowY = Math.min(lowY, r.P.y);
  const lipSpeed = new Map(), launch = new Map();
  // a track that ENDS on a lip (the jump you are building): run until the take-off is measured —
  // that number is the whole point — and call it an open jump, not a failure
  const lastUid = ride[ride.length - 1].uid;
  // a FINISH piece: the lap ends on its line (its entry), as the drive page times it
  const finPc = order.at(-1);
  const finishIdx = TILES[finPc.id]?.finish ? ride.findIndex((r) => r.uid === finPc.uid) : -1;
  const endsOnLip = lips.has(lastUid);
  prediction.openJump = false;
  let idx = 0, slow = 0, wasGrounded = true, flying = null, airT = 0;
  const nose = new THREE.Vector3();
  const pilot = createAutopilot(avoidObstacles(ride, track.props)); // the drive page's autopilot (wall cut, air spin), its line round the obstacles
  const magnets = magnetZones(order.map((pc) => ({ id: pc.id, M: built.get(pc.uid).M })), TILES, integrate);
  const rules = createCarRules(car, { boostPads: boosts, magnets }); // the drive page's rules: wall cut, landing boost, pads, magnets
  // the air rings, judged by the race's own rule (race.js): through the hoop or missed
  const ringGates = track.pieces.filter(isRing).map(ringGateOf);
  const ringRace = ringGates.length ? createRace({ gates: [...ringGates, { kind: "finish", P: new THREE.Vector3(1e9, 1e9, 1e9), T: UP.clone(), U: new THREE.Vector3(1, 0, 0), hw: 0 }], countdown: 0 }) : null;
  prediction.landings = [];
  let endSpeed = null;
  const lapSamples = [], lapEvents = [];
  let vPrev = 0, hitCool = 0, brakeCool = 0;
  for (let tick = 0; tick < 120 * 180; tick++) {
    const p = car.body.pos;
    obs.setTime(tick * FIXED_DT); // the drive page's race clock: 0 at the green light
    const landed = rules.step(pilot.input(car), FIXED_DT);
    if (landed) prediction.landings.push(landed.grade);
    // THE LAP LINE (drawLapLine): a sample every 3 ticks, and the moments worth a mark
    {
      const vNow = car.body.vel.length(), upNow = new THREE.Vector3(0, 1, 0).applyQuaternion(car.body.quat);
      if (tick % 3 === 0) lapSamples.push({ p: car.body.pos.clone(), up: upNow, v: vNow, air: car.groundedCount === 0 });
      hitCool -= FIXED_DT; brakeCool -= FIXED_DT;
      if ((car._solidImpactSpeed ?? 0) > 5 && hitCool <= 0) { lapEvents.push({ kind: "hit", p: car.body.pos.clone(), up: upNow }); hitCool = 0.6; }
      else if (car.groundedCount > 0 && (vPrev - vNow) / FIXED_DT > 14 && brakeCool <= 0) { lapEvents.push({ kind: "brake", p: car.body.pos.clone(), up: upNow }); brakeCool = 1.2; }
      if (landed && /rough/i.test(landed.grade ?? "")) lapEvents.push({ kind: "rough", p: car.body.pos.clone(), up: upNow });
      vPrev = vNow;
    }
    ringRace?.tick(car, FIXED_DT);
    idx = pilot.idx;
    nose.set(0, 0, 1).applyQuaternion(car.body.quat);
    const v = car.body.vel.length();
    // take-off at a lip: the speed the arc band is built from
    const grounded = car.groundedCount > 0;
    // the LAST time the wheels leave a lip piece is the take-off: a flip ramp's curl can lift them
    // for a moment before the real launch (that early, wrong one fell 35 m short)
    if (wasGrounded && !grounded && lips.has(ride[idx].uid)) {
      lipSpeed.set(ride[idx].uid, car.body.vel.length());
      // the take-off itself: deck point under the car (≈ 0.55 m below its centre) + its velocity
      const carUp = new THREE.Vector3(0, 1, 0).applyQuaternion(car.body.quat);
      launch.set(ride[idx].uid, { P: car.body.pos.clone().addScaledVector(carUp, -0.55), V: car.body.vel.clone() });
      flying = ride[idx].uid;
      airT = 0;
    }
    if (grounded) flying = null; else airT += FIXED_DT;
    if (flying === lastUid && airT > 0.5) { prediction.openJump = true; break; }
    wasGrounded = grounded;
    prediction.topKmh = Math.max(prediction.topKmh, v * 3.6);
    prediction.ticks = tick;
    if (p.y < lowY - 60) { prediction.fail = { uid: ride[idx].uid, why: "falls off" }; break; }
    // down on the floor, away from the road: it fell
    if (p.y < FLOOR_Y + 2 && ride[idx].P.distanceTo(p) > 12) { prediction.fail = { uid: ride[idx].uid, why: "falls to the floor" }; break; }
    slow = v < 2 ? slow + FIXED_DT : 0;
    if (slow > 3) { prediction.fail = { uid: ride[idx].uid, why: "stops" }; break; }
    if ((finishIdx >= 0 ? idx >= finishIdx : idx >= ride.length - 5) && !endsOnLip) { prediction.lapS = tick * FIXED_DT; endSpeed = v; break; }
    if (tick % 240 === 239) {
      await new Promise((r) => setTimeout(r, 0)); // let the page breathe between slices
      if (token !== predToken) return; // a newer edit started another prediction
    }
  }
  if (token !== predToken) return;
  if (prediction.fail) lapEvents.push({ kind: "fall", p: car.body.pos.clone() });
  drawLapLine(lapSamples, lapEvents);
  prediction.state = "done";
  prediction.lipSpeed = lipSpeed;
  prediction.launch = launch;
  prediction.endSpeed = endSpeed; // the speed the car arrives at the track's end (a fitted bowl is sized to it)
  prediction.rings = ringRace ? { taken: ringRace.s.taken.size, of: ringGates.length } : null;
  // AUTHOR TIME (DESIGN.md §8, medals): the prediction's lap, when it reaches the end of a track with
  // nothing wrong (no fall, no loose pieces, no overlap, every landing catches its band). The drive page
  // reads it from the saved track. The arcs first: the landing check needs THIS run's take-offs.
  refreshArcs();
  runChecks();
  const ringsOk = !prediction.rings || prediction.rings.taken === prediction.rings.of;
  const clean = prediction.lapS != null && !prediction.fail && !problems.loose.length && !problems.overlap.size && !problems.misses.length && ringsOk;
  const author = clean ? Math.round(prediction.lapS * 100) / 100 : null;
  if (track.authorTime !== author) { if (author) track.authorTime = author; else delete track.authorTime; save(); }
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
  const hasChild = new Set(track.pieces.filter((p) => !isRing(p)).flatMap((p) => [p.parent, p.flightFrom]).filter((u) => u != null));
  return track.pieces.filter((p) => !isRing(p) && !hasChild.has(p.uid) && !TILES[p.id]?.finish).map((p) => {
    const m = built.get(p.uid).exit;
    const dir = new THREE.Vector3(0, 0, -1).transformDirection(m);
    return { uid: p.uid, m, lean: leanOut(TILES[p.id]), pitch: Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1)) };
  });
}

// ---------- flight arcs: the car's air model (gravity + drag), a SPEED BAND per lip ----------
const arcGroup = new THREE.Group();
scene.add(arcGroup);
let arcs = []; // { pts, tan, from, landing } — the SLOW edge of the band (landings fit there, P3)
/** From the lip socket `m` at `speed` along it — or from a MEASURED take-off ({P, V}, the real car's)
 * with its velocity scaled by `scale`. */
function flight(m, speed, launch = null, scale = 1) {
  const vel = launch ? launch.V.clone().multiplyScalar(scale) : new THREE.Vector3(0, 0, -1).transformDirection(m).multiplyScalar(speed);
  const P = launch ? launch.P.clone() : new THREE.Vector3().setFromMatrixPosition(m);
  const pts = [], tan = [];
  for (let i = 0; i < 120 * 10; i++) {
    const dt = 1 / 120, sp = vel.length();
    vel.addScaledVector(vel, -AIR_DRAG * sp * dt);
    vel.y -= G * dt;
    P.addScaledVector(vel, dt);
    if (i % 4 === 0) { pts.push(P.clone()); tan.push(vel.clone().normalize()); }
    if (P.y < FLOOR_Y) break; // a flight ends on the floor
  }
  return { pts, tan };
}
function refreshArcs() {
  for (const c of arcGroup.children.slice()) { arcGroup.remove(c); c.geometry.dispose(); }
  arcs = [];
  // every lip (a road end pointing up with no road after it): open, or flown to a landing
  const roadChild = new Set(track.pieces.map((p) => p.parent).filter((u) => u != null));
  for (const p of track.pieces) {
    if (roadChild.has(p.uid) || isRing(p)) continue;
    const m = built.get(p.uid).exit;
    const dir = new THREE.Vector3(0, 0, -1).transformDirection(m);
    // level ends are not lips — except a DROP piece, whose whole point is the fall
    if (Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1)) < 3 * DEG && !TILES[p.id]?.drop) continue;
    const landing = track.pieces.find((q) => q.flightFrom === p.uid && !isRing(q))?.uid ?? null;
    // the REAL car's take-off speed at this lip (background prediction), else the global guess
    // where and how the REAL car left this lip (background prediction): a flip ramp's curl lets the
    // car go in another direction than its exit socket says (the socket's arc fell 35 m short)
    const launch = prediction.launch?.get(p.uid) ?? null;
    const v = prediction.lipSpeed.get(p.uid) ?? arcSpeed;
    const slow = flight(m, v * BAND_SLOW, launch, BAND_SLOW), fast = flight(m, v, launch, 1);
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
    if (isRing(pc)) continue;
    const { b, t } = piece(pc.id, pc.open);
    const M = built.get(pc.uid).M;
    const hw = SECTIONS[t.section ?? "road"].hw;
    for (const r of b.rings) out.push({ P: deckFrame(r, hw).P.applyMatrix4(M), uid: pc.uid });
  }
  return out;
}
function runChecks() {
  problems = { overlap: new Set(), loose: [], misses: [], messages: [] };
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
  // UNDER THE FLOOR: the floor is solid, so road under it can't be driven
  const under = new Set(roads.filter((r) => r.P.y < FLOOR_Y + 1).map((r) => r.uid));
  for (const u of under) problems.overlap.add(u);
  if (under.size) problems.messages.push(`${under.size} piece${under.size > 1 ? "s go" : " goes"} under the floor (red) — build higher`);
  // LOOSE PIECES: not reachable from the first piece by road or flight (placed on a grid, not snapped
  // to an end). The car falls off where the connected road stops; the prediction used to stop there
  // too and call it a lap (user, 2026-10-18: "the last pieces … are not aligned and make the car fall")
  const chain = new Set(orderedPieces().map((p) => p.uid));
  problems.loose = track.pieces.filter((p) => !(isRing(p) ? chain.has(p.flightFrom) : chain.has(p.uid))).map((p) => p.uid);
  if (problems.loose.length) problems.messages.push(`${problems.loose.length} piece${problems.loose.length > 1 ? "s are" : " is"} not connected to the road (orange) — the car falls where the road stops`);
  let blocked = 0;
  for (const a of arcs) {
    // a flight that has its landing ends there: the arc beyond it never happens (it ran on under the
    // road after a flip ramp's landing and called it blocked)
    let end = a.pts.length;
    const land = a.landing != null ? built.get(a.landing) : null;
    if (land) {
      const L = new THREE.Vector3().setFromMatrixPosition(land.M);
      let bd = Infinity;
      a.pts.forEach((q, k) => { const d = q.distanceToSquared(L); if (d < bd) { bd = d; end = k + 1; } });
    }
    for (const p of a.pts.slice(0, end)) {
    for (const r of gridMap.get(key(p.x, p.z)) ?? []) {
      if (r.uid === a.landing || r.uid === a.from) continue; // the flight's own lip and landing
      const dy = r.P.y - p.y;
      if (dy > 0.5 && dy < 6 && Math.hypot(r.P.x - p.x, r.P.z - p.z) < 9) { blocked++; break; }
    }
    }
  }
  if (blocked) problems.messages.push(`a flight passes under a road (${blocked} points) — the car would hit it`);
  // DOES THE LANDING CATCH THE WHOLE BAND? Both arcs (the slow edge and full speed) must come down ON
  // its deck. A catch pad laid 23 m above its kicker caught only the full-speed car, and the player
  // could not land it at all (user, 2026-10-19) — the builder said nothing.
  problems.misses = [];
  for (const a of arcs) {
    if (a.landing == null) continue;
    const pc = track.pieces.find((q) => q.uid === a.landing);
    const { b, t } = piece(pc.id, pc.open);
    const M = built.get(pc.uid).M, hw = SECTIONS[t.section ?? "road"].hw;
    const deck = b.rings.map((r) => { const f = deckFrame(r, hw); return { P: f.P.applyMatrix4(M), U: f.U.transformDirection(M) }; });
    const lowest = Math.min(...deck.map((s) => s.P.y));
    const lands = (pts) => {
      let apex = 0;
      pts.forEach((p, i) => { if (p.y > pts[apex].y) apex = i; });
      let above = false; // the arc has been over the deck: coming down through it from there = landed
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        for (const s of deck) {
          const d = p.clone().sub(s.P);
          if (Math.hypot(d.x, d.z) >= Math.max(hw, 6)) continue;
          const h = d.dot(s.U);
          if (h >= -0.5) above = true; // over it, or ON it (a fitted landing starts exactly on the slow arc)
          else if (above) return true; // came down onto the deck
          else if (h < -2) return false; // under the deck: it hits the landing from below
        }
        if (i > apex && p.y < lowest - 4) return false; // came down past it (rising below it is fine)
      }
      return false;
    };
    const slowOk = lands(a.pts), fastOk = lands(a.fast.pts);
    if (!slowOk || !fastOk) problems.misses.push({ uid: pc.uid, slowOk, fastOk });
  }
  for (const m of problems.misses) {
    const name = TILES[track.pieces.find((q) => q.uid === m.uid).id]?.label ?? "a landing";
    const fitted = track.pieces.find((q) => q.uid === m.uid).id.startsWith("fitted_landing_");
    problems.messages.push(`"${name}": ${!m.slowOk && !m.fastOk ? "the car misses it" : !m.slowOk ? "a slower car falls short of it" : "a fast car flies past it"} — ${fitted ? "Re-fit it to the jump" : "move it on the arc or use a Fitted landing"}`);
  }
  // tint overlapping pieces: a red box around each
  for (const c of overlapBoxes.splice(0)) scene.remove(c);
  for (const [uid, color] of [...[...problems.overlap].map((u) => [u, 0xff4d5e]), ...problems.loose.map((u) => [u, 0xff9a3d]), ...problems.misses.map((m) => [m.uid, 0xff9a3d])]) {
    const b = built.get(uid);
    if (!b) continue;
    const box = new THREE.Box3Helper(new THREE.Box3().setFromObject(b.group), color);
    scene.add(box);
    overlapBoxes.push(box);
  }
}
const overlapBoxes = [];

// ---------- ghost + snapping (P1b order: open ends → flight arcs → local grid → world grid) ----------
const ghostMat = new THREE.MeshBasicMaterial({ color: SNAP_COLORS.world, transparent: true, opacity: 0.5, depthWrite: false });
let ghost = null, ghostDirty = true, snap = null, lastKey = "";
// HEIGHT CUE: a ghost floating in the sky gives no height to someone new to 3D — a line from the piece in
// hand down to the floor, a ring where it meets it, and the height in metres beside the line
const cueLine = new THREE.Line(new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(6), 3)), new THREE.LineBasicMaterial({ color: 0x3fd2ff, transparent: true, opacity: 0.85, depthTest: false }));
const cueRing = new THREE.Mesh(new THREE.RingGeometry(7, 8.5, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x3fd2ff, transparent: true, opacity: 0.7, depthTest: false, depthWrite: false }));
for (const o of [cueLine, cueRing]) { o.renderOrder = 11; o.frustumCulled = false; o.visible = false; scene.add(o); }
const cueLabel = document.createElement("div");
cueLabel.style.cssText = "position:fixed;z-index:15;pointer-events:none;display:none;color:#3fd2ff;background:rgba(11,15,23,.8);padding:1px 6px;font:700 13px 'Barlow Condensed';letter-spacing:.04em";
document.body.appendChild(cueLabel);
function updateHeightCue() {
  const P = tileBase && snap ? new THREE.Vector3().setFromMatrixPosition(snap.m) : null;
  const h = P ? P.y - FLOOR_Y : 0;
  const show = !!P && h > 1 && !driving;
  cueLine.visible = cueRing.visible = show;
  if (!show) { cueLabel.style.display = "none"; return; }
  const a = cueLine.geometry.attributes.position;
  a.setXYZ(0, P.x, P.y, P.z);
  a.setXYZ(1, P.x, FLOOR_Y, P.z);
  a.needsUpdate = true;
  cueRing.position.set(P.x, FLOOR_Y, P.z);
  const s = toScreen(new THREE.Vector3(P.x, FLOOR_Y + h / 2, P.z));
  if (!s) { cueLabel.style.display = "none"; return; }
  cueLabel.style.display = "block";
  cueLabel.style.left = `${s.x + 8}px`;
  cueLabel.style.top = `${s.y - 10}px`;
  cueLabel.textContent = `↑ ${Math.round(h)} m`;
}
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
/**
 * OBSTACLES snap ON A ROAD (the deck under the mouse): standing on the deck, along the road's direction
 * and bank, across it in 2 m steps (kept inside the kerbs), Q/E turning it from there. Off the road
 * they stand on the FLOOR, on the world grid.
 */
function obstacleSnap() {
  ray.setFromCamera(new THREE.Vector2((mouse.x / innerWidth) * 2 - 1, -(mouse.y / innerHeight) * 2 + 1), camera);
  for (const h of ray.intersectObjects(trackGroup.children, true)) {
    let o = h.object;
    while (o && o.userData.uid == null) o = o.parent;
    const pc = o && track.pieces.find((p) => p.uid === o.userData.uid && !isRing(p));
    if (!pc) continue;
    const { b, t } = piece(pc.id, pc.open);
    const hw = SECTIONS[t.section ?? "road"].hw;
    const M = built.get(pc.uid).M;
    const local = h.point.clone().applyMatrix4(M.clone().invert());
    let best = null, bd = Infinity;
    for (const r of b.rings) { if (r.air) continue; const d = r.p.distanceToSquared(local); if (d < bd) { bd = d; best = r; } }
    if (!best) continue;
    const f = deckFrame(best, hw);
    const lat = THREE.MathUtils.clamp(Math.round(local.clone().sub(f.P).dot(f.R) / 2) * 2, -(hw - 2), hw - 2);
    const along = local.clone().sub(f.P).dot(best.T);
    const P = f.P.clone().addScaledVector(f.R, lat).addScaledVector(best.T, along);
    const m = new THREE.Matrix4().makeBasis(f.R, f.U, best.T.clone().negate()).setPosition(P);
    m.multiply(new THREE.Matrix4().makeRotationY(rot.yaw * DEG));
    return { type: "road", m: M.clone().multiply(m) };
  }
  const hit = new THREE.Vector3();
  if (!ray.ray.intersectPlane(new THREE.Plane(UP, -FLOOR_Y), hit)) return null;
  const P = new THREE.Vector3(Math.round(hit.x / gridStep) * gridStep, FLOOR_Y, Math.round(hit.z / gridStep) * gridStep);
  return { type: "world", m: new THREE.Matrix4().makeRotationY(rot.yaw * DEG).setPosition(P) };
}
function ringSnap() {
  let best = null;
  for (const a of arcs) for (let k = 3; k < a.fast.pts.length; k++) {
    const s = toScreen(a.fast.pts[k]);
    if (!s) continue;
    const d = Math.hypot(s.x - mouse.x, s.y - mouse.y);
    if (d < 40 && (!best || d < best.d)) best = { a, k, d };
  }
  if (!best) return null;
  const T = best.a.fast.tan[best.k];
  const R = new THREE.Vector3().crossVectors(T, UP).normalize();
  const U = new THREE.Vector3().crossVectors(R, T);
  return { type: "arc", m: socketMatrix({ p: best.a.fast.pts[best.k], T, U, R }), from: best.a.from, note: "Air ring: on the full-speed line — take off fast and straight to go through" };
}
function computeSnap() {
  if (tileBase === RING) return ringSnap();
  if (isObstacle(tileBase)) return obstacleSnap();
  // a pasted SECTION snaps like its first piece
  const id = tileBase === STAMP ? stampItems()[0]?.id : tileId(tileBase);
  const t = TILES[id];
  let best = null;
  // A LANDING in hand goes on a flight arc first: next to its lip, a short drop's whole arc sat inside
  // the open end's 60 px and the landing could only snap to the end (seen building, 2026-10-19)
  const landingInHand = !!t?.landAngle || tileBase === FITTED;
  const onArc = landingInHand && arcs.some((a) => a.pts.some((p, k) => {
    if (k < 3 || a.tan[k].y > -0.02) return false;
    const s = toScreen(p);
    return s && Math.hypot(s.x - mouse.x, s.y - mouse.y) < 30;
  }));
  // a START goes on the HEAD of the road (its end on the first piece's start), or anywhere on an empty track
  if (TILES[id]?.start) {
    const first = track.pieces.find((p) => !isRing(p));
    if (first && first.parent == null && !TILES[first.id]?.start) {
      const m = built.get(first.uid).M.clone().multiply(piece(id).exitLocal.clone().invert());
      const s = toScreen(new THREE.Vector3().setFromMatrixPosition(built.get(first.uid).M));
      if (s && Math.hypot(s.x - mouse.x, s.y - mouse.y) < 160) return { type: "end", m, prepend: first.uid, note: "Start · on the head of your road" };
    }
  }
  if (!onArc && !TILES[id]?.start) for (const e of openEnds()) {
    const s = toScreen(new THREE.Vector3().setFromMatrixPosition(e.m));
    if (!s) continue;
    const d = Math.hypot(s.x - mouse.x, s.y - mouse.y);
    if (d < 60 && (!best || d < best.d)) best = { type: "end", m: e.m.clone(), parent: e.uid, d, end: e };
  }
  if (best) {
    if (tileBase === FITTED_BOWL) {
      // sized to the speed the real car arrives at THIS end (the end the prediction drove to), else the guess
      const lastUid = orderedPieces().at(-1)?.uid;
      const v = best.parent === lastUid && prediction.endSpeed ? prediction.endSpeed : arcSpeed;
      bowlR = bowlRadius(v);
      best.note = `Bowl R${bowlR} for ${Math.round(v * 3.6)} km/h · spin 180° in the air`;
    }
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
    // (not the FITTED landing: it takes the angle of the arc where you point — land at any depth)
    if (t.landAngle && tileBase !== FITTED) {
      const want = t.landAngle * DEG;
      let kBest = best.k, err = Infinity;
      for (let k = 3; k < best.a.pts.length; k++) {
        const fall = Math.asin(THREE.MathUtils.clamp(-best.a.tan[k].y, -1, 1));
        if (fall > 0 && Math.abs(fall - want) < err) { err = Math.abs(fall - want); kBest = k; }
      }
      best.k = kBest;
    }
    let T = best.a.tan[best.k];
    let fittedAngle = FITTED_ANGLE;
    if (tileBase === FITTED) {
      // the slope at the arc's own fall angle where you point, in 5° steps (10–45°), and the landing
      // laid exactly at that angle so its exit comes out level
      const fall = Math.asin(THREE.MathUtils.clamp(-T.y, -1, 1)) / DEG;
      fittedAngle = THREE.MathUtils.clamp(Math.round(fall / 5) * 5, 10, 45);
      const h = new THREE.Vector3(T.x, 0, T.z).normalize();
      T = h.multiplyScalar(Math.cos(fittedAngle * DEG)).setY(-Math.sin(fittedAngle * DEG));
    }
    const R = new THREE.Vector3().crossVectors(T, UP).normalize();
    const U = new THREE.Vector3().crossVectors(R, T);
    const P0 = best.a.pts[best.k];
    if (tileBase === FITTED) {
      // FITTED LANDING: the down-slope starts here on the SLOW arc and runs until the FAST arc meets
      // it too (+12 m margin): every speed in the band lands on the slope, not past it
      let D = 24;
      for (const q of best.a.fast.pts) {
        const rel = q.clone().sub(P0);
        const along = rel.dot(T);
        if (along > 0 && rel.dot(U) <= 0) { D = along + 12; break; } // crossed the slope surface
      }
      D = Math.max(24, Math.ceil(D / 4) * 4);
      fittedId = ensureTile(`fitted_landing_${fittedAngle}_${D}`).id;
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
  const key = `${id}|${hand}|${edges}|${snap.type}|${!!snap.bad}|${snap.m.elements.map((x) => x.toFixed(3)).join(",")}`;
  if (key !== lastKey || ghostDirty) {
    lastKey = key; ghostDirty = false;
    if (ghost) scene.remove(ghost);
    ghost = id === STAMP ? stampGhost() : isObstacle(id) ? new THREE.Mesh(OBSTACLES[id].ghost, ghostMat) : id === RING ? makeRingMesh({ P: new THREE.Vector3(), T: new THREE.Vector3(0, 0, -1), U: new THREE.Vector3(0, 1, 0), hw: RING_R }, { material: ghostMat }).children[0] : new THREE.Mesh(piece(id, !edges).look.deck, ghostMat);
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
  gridStepU.value = gridStep;
  if (ref) { grid.rotation.y = ref.yaw; grid.position.set(ref.pos.x, buildY, ref.pos.z); }
  else { grid.rotation.y = 0; grid.position.set(Math.round(f.x / 8) * 8, buildY, Math.round(f.z / 8) * 8); }
}

// ---------- next-piece chips at the newest open end ----------
function suggestionsFor(end) {
  const out = [];
  if (Math.abs(deg(end.lean)) > 3) {
    for (const c of CATS) for (const base of c.tiles) for (const h of [1, -1]) {
      if (base === RING || isObstacle(base)) continue; // not road
      const id = tileId(base, h);
      if (h < 0 && id === base) continue;
      if (Math.abs(deg(leanIn(TILES[id])) - deg(end.lean)) < 3 && !out.some((o) => o.id === id)) out.push({ base, h, id });
    }
    const back = out.filter((o) => Math.abs(deg(leanOut(TILES[o.id]))) <= 3), keep = out.filter((o) => Math.abs(deg(leanOut(TILES[o.id]))) > 3);
    return { label: `Leans ${Math.abs(deg(end.lean))}° · fits`, items: [...back.slice(0, 2), ...keep.slice(0, 4)] };
  }
  if (end.pitch > 3 * DEG || TILES[track.pieces.find((p) => p.uid === end.uid)?.id]?.drop) return { label: "Lip · land it on the arc", items: [FITTED, "banked_landing_20", "landing_turn_20", "catch_pad"].map((b) => ({ base: b, h: hand, id: tileId(b) })) };
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
  // (not while a piece is selected: the chips are about the open end, and they covered the edit panel)
  if (!sug || !s || s.y > innerHeight - DOCK_H - 40 || (sel != null && !tileBase)) { el.style.display = "none"; nextKey = ""; return; }
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
    b.appendChild(document.createTextNode(it.id === RING ? "Air ring" : TILES[it.id].label));
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
  if (id === RING) {
    track.pieces.push({ uid, id, ring: true, cp: true, M: snap.m.toArray(), parent: null, flightFrom: snap.from });
    rebuild();
    return;
  }
  if (isObstacle(id)) {
    (track.props ??= []).push({ uid, kind: id, M: snap.m.toArray() });
    rebuild();
    return;
  }
  if (id === STAMP) {
    track.nextUid--; // the stamp numbers its own pieces
    const uids = placeStamp();
    rebuild();
    const exit = new THREE.Vector3().setFromMatrixPosition(built.get(uids.filter((u) => roadPc(u)).at(-1)).exit);
    buildY = Math.round(exit.y / 2) * 2;
    glide = exit;
    return;
  }
  if (snap.prepend != null) {
    // a START on the head of the road: first in the list (rebuild lays each piece on its parent), the
    // old first piece now hangs off it
    track.pieces.unshift({ uid, id, open: !edges, M: snap.m.toArray(), parent: null, flightFrom: null });
    track.pieces.find((p) => p.uid === snap.prepend).parent = uid;
  } else track.pieces.push({ uid, id, open: !edges, M: snap.m.toArray(), parent: snap.type === "end" ? snap.parent : null, flightFrom: snap.type === "arc" ? snap.from : null });
  const ri = recent.findIndex((r) => r.id === id);
  if (ri >= 0) recent.splice(ri, 1);
  recent.unshift({ base: tileBase, h: hand, id });
  rebuild();
  const exit = new THREE.Vector3().setFromMatrixPosition(built.get(uid).exit);
  buildY = Math.round(exit.y / 2) * 2;
  glide = exit;
}
function removePiece(uid) { removeMany([uid]); }
/** Take one piece (or obstacle) out of the track's data; its road closes up. */
function cutOut(uid) {
  const k = (track.props ?? []).findIndex((p) => p.uid === uid);
  if (k >= 0) { track.props.splice(k, 1); return; }
  const i = track.pieces.findIndex((p) => p.uid === uid);
  if (i < 0) return;
  const pc = track.pieces[i];
  for (const c of track.pieces) if (c.parent === uid) { c.parent = pc.parent; if (pc.parent == null) c.M = pc.M; }
  track.pieces.splice(i, 1);
}
// ---------- EDIT MID-TRACK: insert after / replace the selected piece ----------
// The road downstream follows by itself (rebuild() lays each road child on its parent's exit); what
// hangs off a lip by its FLIGHT (landings, air rings) has its own matrix, so it is carried rigidly by
// however much its lip moved — the jump stays the same jump.
let editMode = null; // "insert" | "replace" while the dock picks the piece
let editMsg = null; // why the last edit was refused
const IDENT = new THREE.Matrix4().elements;
function reflow(mutate) {
  const old = new Map([...built].map(([u, b]) => [u, b.exit.clone()]));
  snapshot();
  mutate(old);
  rebuild();
  for (let pass = 0; pass < 8; pass++) {
    const moved = [];
    for (const pc of track.pieces) {
      const src = pc.flightFrom;
      if (src == null || !old.has(src) || !built.has(src)) continue;
      const d = built.get(src).exit.clone().multiply(old.get(src).clone().invert());
      if (d.elements.every((v, i) => Math.abs(v - IDENT[i]) < 1e-6)) continue;
      pc.M = d.multiply(new THREE.Matrix4().fromArray(pc.M)).toArray();
      moved.push(src);
    }
    if (!moved.length) break;
    for (const src of moved) old.set(src, built.get(src).exit.clone());
    rebuild(); // pieces after a carried landing follow it, and their own lips move in the next pass
  }
}
/** Why `id` can't sit between the lean it meets and the lean it hands on, or null. */
function leanClash(id, inLean, nextPc) {
  const t = TILES[id];
  if (Math.abs(deg(leanIn(t)) - deg(inLean)) > 3) return `${t.label} starts ${leanIn(t) ? `leaning ${Math.abs(deg(leanIn(t)))}°` : "flat"}, but the road there ${inLean ? `leans ${Math.abs(deg(inLean))}°` : "is flat"}.`;
  if (nextPc && Math.abs(deg(leanOut(t)) - deg(leanIn(TILES[nextPc.id]))) > 3) return `${t.label} ends ${leanOut(t) ? `leaning ${Math.abs(deg(leanOut(t)))}°` : "flat"}, but the next piece starts ${leanIn(TILES[nextPc.id]) ? `leaning ${Math.abs(deg(leanIn(TILES[nextPc.id])))}°` : "flat"}.`;
  return null;
}
function editWith(id) {
  const pc = track.pieces.find((p) => p.uid === sel);
  const mode = editMode;
  editMode = null;
  if (!pc || isRing(pc)) return;
  if (id === RING || id === FITTED || id === FITTED_BOWL) { editMsg = "Landings, bowls and air rings go on a flight arc: pick them with nothing selected."; return; }
  const child = track.pieces.find((q) => q.parent === pc.uid);
  if (mode === "insert") {
    editMsg = leanClash(id, leanOut(TILES[pc.id]), child);
    if (editMsg) return;
    reflow((old) => {
      const uid = track.nextUid++;
      for (const c of track.pieces) {
        if (c.parent === pc.uid) c.parent = uid;
        if (c.flightFrom === pc.uid) c.flightFrom = uid; // the jump now leaves from the new end
      }
      old.set(uid, old.get(pc.uid)); // …and is carried from where it left before
      track.pieces.splice(track.pieces.indexOf(pc) + 1, 0, { uid, id, open: pc.open, M: pc.M, parent: pc.uid, flightFrom: null });
      sel = uid;
    });
  } else {
    const parent = track.pieces.find((q) => q.uid === pc.parent);
    editMsg = leanClash(id, parent ? leanOut(TILES[parent.id]) : 0, child);
    if (editMsg) return;
    reflow(() => { pc.id = id; });
  }
}
// ---------- RE-FIT A LANDING (user, 2026-10-20): an edit that changes the speed into a jump left its
// fitted landing sized for the old band ("a slower car falls short of it"). The same sizing as placing a
// Fitted landing (computeSnap), redone on the jump's arcs as they fly NOW, at the height the landing
// stands at: its start where the slow arc comes down to that height, its angle that fall's, its length
// until the fast arc lands on it too. The road after it follows (reflow).
function fittedOnArc(a, k) {
  let T = a.tan[k];
  const fall = Math.asin(THREE.MathUtils.clamp(-T.y, -1, 1)) / DEG;
  const angle = THREE.MathUtils.clamp(Math.round(fall / 5) * 5, 10, 45);
  const h = new THREE.Vector3(T.x, 0, T.z).normalize();
  T = h.multiplyScalar(Math.cos(angle * DEG)).setY(-Math.sin(angle * DEG));
  const R = new THREE.Vector3().crossVectors(T, UP).normalize();
  const U = new THREE.Vector3().crossVectors(R, T);
  const P0 = a.pts[k];
  let D = 24;
  for (const q of a.fast.pts) {
    const rel = q.clone().sub(P0);
    const along = rel.dot(T);
    if (along > 0 && rel.dot(U) <= 0) { D = along + 12; break; }
  }
  D = Math.max(24, Math.ceil(D / 4) * 4);
  return { id: ensureTile(`fitted_landing_${angle}_${D}`).id, m: socketMatrix({ p: P0, T, U, R }) };
}
const refittable = () => problems.misses.filter((m) => track.pieces.find((q) => q.uid === m.uid)?.id.startsWith("fitted_landing_")).map((m) => m.uid);
function refitLandings(uids = refittable()) {
  const fits = [];
  for (const uid of uids) {
    const a = arcs.find((x) => x.landing === uid);
    if (!a) continue;
    const y = new THREE.Vector3().setFromMatrixPosition(built.get(uid).M).y;
    let k = -1;
    for (let i = 3; i < a.pts.length; i++) if (a.tan[i].y < -0.02 && a.pts[i].y <= y) { k = i; break; }
    if (k < 0) continue; // the slow arc never comes down to it: move it on the arc by hand
    fits.push({ uid, ...fittedOnArc(a, k) });
  }
  if (!fits.length) { editMsg = "Couldn't re-fit: the jump's slow arc doesn't come down to that landing's height — place it again on the arc."; renderStatus(); return; }
  reflow(() => { for (const f of fits) { const pc = track.pieces.find((q) => q.uid === f.uid); pc.id = f.id; pc.M = f.m.toArray(); } });
}

/** One setting of an adjustable piece moved by `steps` (clamped; a signed height skips 0 — a flat slope is a straight). */
function stepAdjust(base, params, key, steps) {
  const q = ADJUSTABLE[base].params[key];
  let v = params[key] + steps * q.step;
  if (q.signed && v === 0) v += Math.sign(steps) * q.step;
  return { ...params, [key]: Math.min(q.max, Math.max(q.min, v)) };
}
/** A PLACED adjustable piece's setting changed: the piece is rebuilt, the road after it follows. */
function adjustPlaced(uid, key, steps) {
  const pc = track.pieces.find((q) => q.uid === uid);
  const a = pc && parseAdjustable(pc.id);
  if (!a) return;
  const id = ensureTile(adjustableId(a.base, stepAdjust(a.base, a.p, key, steps), a.hand)).id;
  if (id === pc.id) return;
  reflow(() => { pc.id = id; });
}

function startEdit(mode) {
  const pc = track.pieces.find((p) => p.uid === sel);
  if (!pc || isRing(pc)) return;
  editMode = editMode === mode ? null : mode;
  editMsg = null;
  renderStatus();
}

// ---------- SEVERAL PIECES (user, 2026-10-20): select a run, COPY it, PASTE it as one stamp (R mirrors it),
// MIRROR it in place, DELETE it. Shift-click = the road between the selected piece and the clicked one;
// Ctrl-click = add / remove one. `sel` stays the last one clicked.
let selSet = new Set();
const STAMP = "__section";
let clipboard = null; // { items: [{ id, open, cp, link: "head"|"parent"|"flight"|"ring", from, rel }], n }
let copiedNote = null;
const roadPc = (uid) => track.pieces.find((p) => p.uid === uid && !isRing(p));
const selection = () => [...selSet].filter((u) => built.has(u));
/** The road from `a` to `b` along their chain (either way round), or null if they are not on one road. */
function runBetween(a, b) {
  const walk = (from, to) => {
    const out = [], seen = new Set();
    for (let p = roadPc(from); p && !seen.has(p.uid); p = roadPc(p.parent ?? p.flightFrom)) {
      seen.add(p.uid);
      out.unshift(p.uid);
      if (p.uid === to) return out;
    }
    return null;
  };
  return walk(b, a) ?? walk(a, b);
}
/** The selected road pieces in driving order, if they are ONE run (each the next of the one before). */
function selectedRun() {
  const set = new Set(selection().filter((u) => roadPc(u)));
  if (!set.size) return null;
  const head = [...set].find((u) => { const p = roadPc(u); return !set.has(p.parent) && !set.has(p.flightFrom); });
  const order = [head];
  for (let cur = head; ;) {
    const next = track.pieces.find((q) => set.has(q.uid) && !order.includes(q.uid) && (q.parent === cur || q.flightFrom === cur));
    if (!next) break;
    order.push(next.uid);
    cur = next.uid;
  }
  return order.length === set.size ? order : null;
}
function copySelection() {
  const order = selectedRun();
  if (!order) { editMsg = "Copy a run of road: pieces one after another (Shift-click the last one)."; renderStatus(); return; }
  const Hi = built.get(order[0]).M.clone().invert();
  const items = order.map((u, i) => {
    const p = roadPc(u);
    const link = i === 0 ? "head" : p.parent != null ? "parent" : "flight";
    return { id: p.id, open: !!p.open, cp: !!p.cp, link, from: i === 0 ? -1 : order.indexOf(link === "parent" ? p.parent : p.flightFrom), rel: Hi.clone().multiply(built.get(u).M).toArray() };
  });
  for (const q of track.pieces) if (isRing(q) && order.includes(q.flightFrom)) items.push({ id: RING, link: "ring", from: order.indexOf(q.flightFrom), rel: Hi.clone().multiply(new THREE.Matrix4().fromArray(q.M)).toArray() });
  clipboard = { items, n: order.length };
  editMsg = null;
  copiedNote = `Copied ${order.length} piece${order.length > 1 ? "s" : ""} · Ctrl+V to paste`;
  statusKey = "";
  renderStatus();
}
const MIRROR_X = new THREE.Matrix4().makeScale(-1, 1, 1);
const mirrorId = (id) => (id.endsWith("_L") ? id.slice(0, -2) : TILES[`${id}_L`] ? `${id}_L` : id);
/** The stamp in hand: the clipboard, mirrored when the hand is left (R). */
function stampItems() {
  if (!clipboard) return [];
  if (hand > 0) return clipboard.items;
  return clipboard.items.map((it) => ({ ...it, id: it.link === "ring" ? it.id : mirrorId(it.id), rel: MIRROR_X.clone().multiply(new THREE.Matrix4().fromArray(it.rel)).multiply(MIRROR_X).toArray() }));
}
/** Each stamp item's frame when its head stands on `m` (a road piece follows its parent's exit). */
function stampMatrices(m, items) {
  const Ms = [];
  items.forEach((it, i) => {
    if (i === 0) Ms.push(m.clone());
    else if (it.link === "parent") Ms.push(Ms[it.from].clone().multiply(piece(items[it.from].id).exitLocal));
    else Ms.push(m.clone().multiply(new THREE.Matrix4().fromArray(it.rel)));
  });
  return Ms;
}
/** The stamp's ghost: every piece's deck (and its rings), laid out from an identity head. */
function stampGhost() {
  const g = new THREE.Group();
  const items = stampItems(), Ms = stampMatrices(new THREE.Matrix4(), items);
  items.forEach((it, i) => {
    const m = it.link === "ring"
      ? makeRingMesh({ P: new THREE.Vector3(), T: new THREE.Vector3(0, 0, -1), U: new THREE.Vector3(0, 1, 0), hw: RING_R }, { material: ghostMat }).children[0]
      : new THREE.Mesh(piece(it.id, it.open).look.deck, ghostMat);
    m.matrixAutoUpdate = false;
    m.matrix.copy(Ms[i]);
    g.add(m);
  });
  return g;
}
function pasteSection() {
  if (!clipboard) { editMsg = "Nothing copied yet: select pieces and Ctrl+C."; renderStatus(); return; }
  copiedNote = null;
  pickTile(STAMP);
}
function placeStamp() {
  const items = stampItems(), Ms = stampMatrices(snap.m, items);
  const uids = items.map(() => track.nextUid++);
  items.forEach((it, i) => {
    if (it.link === "ring") { track.pieces.push({ uid: uids[i], id: RING, ring: true, cp: true, M: Ms[i].toArray(), parent: null, flightFrom: uids[it.from] }); return; }
    const head = i === 0;
    track.pieces.push({
      uid: uids[i], id: it.id, open: it.open, ...(it.cp ? { cp: true } : {}), M: Ms[i].toArray(),
      parent: head ? (snap.type === "end" ? snap.parent : null) : it.link === "parent" ? uids[it.from] : null,
      flightFrom: head ? (snap.type === "arc" ? snap.from : null) : it.link === "flight" ? uids[it.from] : null,
    });
  });
  return uids;
}
/** Mirror the selected run in place: every turn and bank its other hand; the road after it follows. */
function mirrorSelection() {
  const order = selectedRun();
  if (!order) { editMsg = "Mirror a run of road: pieces one after another."; renderStatus(); return; }
  const first = roadPc(order[0]), last = roadPc(order.at(-1));
  const parent = roadPc(first.parent), next = track.pieces.find((q) => q.parent === last.uid);
  const ids = order.map((u) => mirrorId(roadPc(u).id));
  editMsg = leanClash(ids[0], parent ? leanOut(TILES[parent.id]) : 0, null) ?? leanClash(ids.at(-1), leanIn(TILES[ids.at(-1)]), next);
  if (editMsg) { renderStatus(); return; }
  reflow(() => order.forEach((u, i) => { roadPc(u).id = ids[i]; }));
}
/**
 * Delete one or several (one undo step): each road closes up, and what hangs off a jump further on
 * (landings, air rings) is carried with its lip (reflow) — deleting the straight before a kicker used
 * to pull the kicker back and leave its landing behind (the test lap then missed it, 2026-10-20).
 */
function removeMany(uids) {
  sel = null;
  selSet.clear();
  reflow(() => { for (const uid of uids) cutOut(uid); });
}

let selBox = null;
function refreshSelection() {
  if (sel == null || !selSet.has(sel)) selSet = new Set(sel != null ? [sel] : []);
  if (selBox) { scene.remove(selBox); selBox = null; }
  const many = selection();
  if (many.length) {
    selBox = new THREE.Group();
    for (const u of many) selBox.add(new THREE.Box3Helper(new THREE.Box3().setFromObject(built.get(u).group), 0x3fd2ff));
    scene.add(selBox);
  }
  attachGizmo();
}

// ---------- THE GIZMO (user, 2026-10-20: "don't you think we should have a gizmo?") ----------
// Arrows to MOVE (grid-snapped) or a ring to TURN (about the vertical, 15° steps) what can move freely:
// a road's FIRST piece (the whole road behind it comes along, with the landings, rings and obstacles on
// it), an obstacle (dropped onto the road under it), an air ring. A piece in the middle of a road is
// held by the road: Replace / Insert instead.
const gizmoProxy = new THREE.Object3D();
scene.add(gizmoProxy);
const gizmo = new TransformControls(camera, renderer.domElement);
gizmo.setSpace("world");
gizmo.setSize(0.9);
scene.add(gizmo.getHelper());
let gizmoMode = "translate";
let gizmoDrag = null;
/** What the selection is, for the gizmo: "root" | "prop" | "ring" | null (held by the road). */
function movableKind(uid) {
  if (uid == null) return null;
  if ((track.props ?? []).some((p) => p.uid === uid)) return "prop";
  const pc = track.pieces.find((p) => p.uid === uid);
  if (!pc) return null;
  if (isRing(pc)) return "ring";
  return pc.parent == null && pc.flightFrom == null ? "root" : null;
}
function attachGizmo() {
  const kind = !tileBase && !driving && selection().length <= 1 ? movableKind(sel) : null;
  if (!kind) { gizmo.detach(); return; }
  built.get(sel).M.decompose(gizmoProxy.position, gizmoProxy.quaternion, gizmoProxy.scale);
  gizmoProxy.updateMatrixWorld(true);
  gizmo.setMode(gizmoMode);
  gizmo.showX = gizmo.showZ = gizmoMode === "translate";
  gizmo.translationSnap = gridStep;
  gizmo.rotationSnap = 15 * DEG;
  gizmo.attach(gizmoProxy);
}
function setGizmoMode(m) { gizmoMode = m; attachGizmo(); statusKey = ""; renderStatus(); }
/** Everything that moves with `uid`: a root carries its road, what flies off it, and what stands on it. */
function carried(uid) {
  const kind = movableKind(uid);
  if (kind !== "root") return { pieces: [uid], props: kind === "prop" ? [uid] : [] };
  const S = new Set([uid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const p of track.pieces) if (!S.has(p.uid) && (S.has(p.parent) || S.has(p.flightFrom))) { S.add(p.uid); grew = true; }
  }
  const pts = [];
  for (const u of S) { const pc = track.pieces.find((p) => p.uid === u); if (pc && !isRing(pc)) for (const r of piece(pc.id, pc.open).b.rings) pts.push(r.p.clone().applyMatrix4(built.get(u).M)); }
  const props = (track.props ?? []).filter((o) => { const c = new THREE.Vector3(o.M[12], o.M[13], o.M[14]); return pts.some((q) => Math.hypot(q.x - c.x, q.z - c.z) < 12 && Math.abs(q.y - c.y) < 5); }).map((o) => o.uid);
  return { pieces: [...S], props };
}
gizmo.addEventListener("dragging-changed", (e) => {
  controls.enabled = !e.value;
  if (e.value) {
    const what = carried(sel);
    gizmoDrag = { start: gizmoProxy.matrixWorld.clone(), what, groups: [...what.pieces, ...what.props].map((u) => built.get(u)).filter(Boolean).map((b) => ({ g: b.group, M0: b.group.matrix.clone() })) };
    for (const { g } of gizmoDrag.groups) g.matrixAutoUpdate = false;
    return;
  }
  if (!gizmoDrag) return;
  // COMMIT: the absolute frames move (a root, what flies off it, rings, obstacles); the rest of the road
  // is laid on its parents again by rebuild()
  const delta = gizmoProxy.matrixWorld.clone().multiply(gizmoDrag.start.clone().invert());
  const moved = gizmoDrag;
  gizmoDrag = null;
  if (delta.equals(new THREE.Matrix4())) return;
  snapshot();
  for (const u of moved.what.pieces) {
    const pc = track.pieces.find((p) => p.uid === u);
    if (pc && (pc.parent == null)) pc.M = delta.clone().multiply(new THREE.Matrix4().fromArray(pc.M)).toArray();
  }
  for (const u of moved.what.props) {
    const o = track.props.find((p) => p.uid === u);
    let M = delta.clone().multiply(new THREE.Matrix4().fromArray(o.M));
    if (movableKind(sel) === "prop") M = settleOnRoad(M); // an obstacle dropped on a road stands on its deck
    o.M = M.toArray();
  }
  rebuild();
});
gizmo.addEventListener("objectChange", () => {
  if (!gizmoDrag) return;
  const delta = gizmoProxy.matrixWorld.clone().multiply(gizmoDrag.start.clone().invert());
  for (const { g, M0 } of gizmoDrag.groups) { g.matrix.multiplyMatrices(delta, M0); g.matrixWorldNeedsUpdate = true; }
  if (selBox?.children[0]) selBox.children[0].box.setFromObject(built.get(sel).group);
});
/** An obstacle's frame moved onto the road under it (within 6 m up or down): stood on that deck. */
function settleOnRoad(M) {
  const p = new THREE.Vector3().setFromMatrixPosition(M);
  const r = new THREE.Raycaster(p.clone().add(new THREE.Vector3(0, 6, 0)), new THREE.Vector3(0, -1, 0), 0, 12);
  for (const h of r.intersectObjects(trackGroup.children, true)) {
    let o = h.object;
    while (o && o.userData.uid == null) o = o.parent;
    if (!o || !track.pieces.some((q) => q.uid === o.userData.uid && !isRing(q))) continue;
    return M.clone().setPosition(h.point);
  }
  return M;
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
  const name = (uid) => { const pc = track.pieces.find((q) => q.uid === uid); return pc ? (isRing(pc) ? "Air ring" : TILES[pc.id].label) : "?"; };
  const lips = [...P.lipSpeed.values()].map((v) => Math.round(v * 3.6)).join(", ");
  if (P.fail) return `<div class="warn">⚠ the car ${P.fail.why} at "${name(P.fail.uid)}" (orange box)</div>`;
  if (P.openJump) return `<div class="row"><span>real car takes off at</span><b>${lips} km/h — land it on the band</b></div>`;
  return `<div class="row"><span>${problems.loose?.length ? "real car: to the road's end" : "real car: lap"}</span><b>${P.lapS?.toFixed(1)} s · top ${Math.round(P.topKmh)} km/h</b></div>` +
    (lips ? `<div class="row"><span>take-offs</span><b>${lips} km/h</b></div>` : "") +
    (P.rings ? (P.rings.taken === P.rings.of
      ? `<div class="row"><span>air rings</span><b>${P.rings.taken}/${P.rings.of} flown through</b></div>`
      : `<div class="warn">⚠ the car misses ${P.rings.of - P.rings.taken} air ring${P.rings.of - P.rings.taken > 1 ? "s" : ""} — no author time</div>`) : "") +
    (P.landings?.length ? `<div class="row"><span>landings (lined up)</span><b>${P.landings.filter((g) => g === "perfect").length}/${P.landings.length} perfect</b></div>` : "");
}
function renderStatus() {
  const names = { end: "open end", road: "on the road", arc: "flight arc", local: "local grid", world: "world grid" };
  const many = !tileBase ? selection() : [];
  const multi = many.length > 1;
  const selPc = sel != null && !tileBase && !multi ? track.pieces.find((p) => p.uid === sel) ?? (track.props ?? []).find((p) => p.uid === sel) : null;
  const k = [snap?.type, snap?.bad, tileBase, hand, edges, sel, selPc?.id, many.join(), copiedNote, !!clipboard, lapLineOn, editMode, editMsg, gizmoMode, gridMode, gridStep, buildY, rot.yaw, rot.pitch, rot.roll, arcSpeed, track.pieces.length, problems.messages.join(), prediction.state, prediction.fail?.uid, snap?.note, track.authorTime, track.pieces.filter((p) => p.cp).length].join("|");
  if (k === statusKey) return;
  statusKey = k;
  const col = snap?.bad ? "#ff4d5e" : snap ? `#${SNAP_COLORS[snap.type].toString(16).padStart(6, "0")}` : "#8796b5";
  $("status").innerHTML =
    `<div class="mode" style="color:${col}">${tileBase ? `${isObstacle(tileBase) || tileBase === STAMP ? tileLabel(tileBase) : tileBase === RING ? "Air ring" : TILES[tileId(tileBase)].label} → ${names[snap?.type] ?? "—"}` : multi ? `${many.length} pieces selected` : selPc ? (selPc.kind ? OBSTACLES[selPc.kind]?.label ?? "Obstacle" : isRing(selPc) ? "Air ring" : TILES[selPc.id]?.label ?? "Piece") : "Pick a piece"}</div>` +
    (multi ? `<div class="acts"><button data-act="copy">Copy <kbd>Ctrl+C</kbd></button><button data-act="mirror">Mirror</button><button data-act="delmany">Delete <kbd>Del</kbd></button></div>` : "") +
    (copiedNote ? `<div class="edit-ask">${copiedNote}</div>` : "") +
    (!tileBase && !multi && !selPc ? `<div class="legend">Shift-click: the road up to a piece · Ctrl-click: one more${clipboard ? " · Ctrl+V: paste" : ""}</div>` : "") +
    (!tileBase && !multi && !selPc && track.pieces.length > 1
      ? `<div class="acts"><button data-act="lapline" class="${lapLineOn ? "on" : ""}">Test lap line ${lapLineOn ? "on" : "off"} <kbd>L</kbd></button></div>` +
        (lapLineOn ? `<div class="legend">The test car: blue slow → white fast, dashed in the air · red: hits, falls · orange: hard braking, rough landing</div>` : "")
      : "") +
    (tileBase === STAMP ? `<div class="row"><span>Snaps like its first piece · R mirrors it · it stays in hand</span></div>` : "") +
    (isObstacle(tileBase) ? `<div class="row"><span>${OBSTACLES[tileBase].hint} · on a road or the floor · Q/E turn</span></div>` : "") +
    (selPc && !isRing(selPc) && !selPc.kind
      ? (editMode
          ? `<div class="edit-ask">${editMode === "insert" ? "Insert after it" : "Replace it"}: pick a piece in the dock below · <kbd>Esc</kbd> cancel</div>`
          : "") +
        `<div class="acts">` +
        `<button data-act="insert" class="${editMode === "insert" ? "on" : ""}">Insert after <kbd>I</kbd></button>` +
        `<button data-act="replace" class="${editMode === "replace" ? "on" : ""}">Replace <kbd>P</kbd></button>` +
        `<button data-act="delete">Delete <kbd>Del</kbd></button>` +
        `<button data-act="cp">${selPc.cp ? "No checkpoint" : "Checkpoint"} <kbd>C</kbd></button></div>`
      : selPc ? `<div class="acts"><button data-act="delete">Delete <kbd>Del</kbd></button></div>` : "") +
    // a placed ADJUSTABLE piece: its settings, right here (the road after it follows)
    (selPc && !selPc.kind && !isRing(selPc) && parseAdjustable(selPc.id)
      ? (() => { const a = parseAdjustable(selPc.id), d = ADJUSTABLE[a.base];
          return `<div class="acts">${Object.entries(d.params).map(([pk, q]) => `<button data-act="adj:${pk}:-1" title="Shift: ×4">◀</button><span class="adjv">${q.label} ${a.p[pk]}${q.unit}</span><button data-act="adj:${pk}:1" title="Shift: ×4">▶</button>`).join("")}</div>`; })()
      : "") +
    // the gizmo's two modes, or why this piece can't move on its own
    (selPc ? (movableKind(sel)
      ? `<div class="acts"><button data-act="move" class="${gizmoMode === "translate" ? "on" : ""}">Move <kbd>M</kbd></button><button data-act="turn" class="${gizmoMode === "rotate" ? "on" : ""}">Turn <kbd>M</kbd></button></div>` +
        (movableKind(sel) === "root" ? `<div class="row"><span>The whole road behind it moves too</span></div>` : "")
      : `<div class="row"><span>Held by the road: Replace or Insert</span></div>`) : "") +
    (editMsg ? `<div class="warn">${editMsg}</div>` : "") +
    (snap?.bad ? `<div class="warn">${snap.bad}</div>` : "") +
    (snap?.note ? `<div class="row"><span>${snap.note}</span></div>` : "") +
    problems.messages.map((m) => `<div class="warn">⚠ ${m}</div>`).join("") +
    (refittable().length ? `<div class="acts"><button data-act="refit">Re-fit ${refittable().length > 1 ? `${refittable().length} landings` : "the landing"} to the jump</button></div>` : "") +
    predictionLine() +
    (tileBase // how the piece in hand is placed: nothing to say without one
      ? `<div class="row"><span>grid</span><b>${gridMode} · ${gridStep} m</b></div>` +
        `<div class="row"><span>height</span><b>${buildY} m</b></div>` +
        `<div class="row"><span>turn / pitch / bank</span><b>${rot.yaw}° / ${rot.pitch}° / ${rot.roll}°</b></div>`
      : "") +
    (prediction.lipSpeed.size
      ? `<div class="row"><span>band (real car)</span><b>${[...prediction.lipSpeed.values()].map((v) => `${Math.round(v * BAND_SLOW * 3.6)}–${Math.round(v * 3.6)}`).join(" · ")} km/h</b></div>`
      : `<div class="row"><span>arc band (guess)</span><b>${Math.round(arcSpeed * BAND_SLOW * 3.6)}–${Math.round(arcSpeed * 3.6)} km/h</b></div>`) +
    `<div class="row"><span>checkpoints (select + C)</span><b>${track.pieces.filter((p) => p.cp).length}</b></div>` +
    `<div class="row"><span>author time</span><b>${track.authorTime ? `${track.authorTime.toFixed(2)} s` : "—"}</b></div>` +
    `<div class="row"><span>pieces</span><b>${track.pieces.length}</b></div>`;
}

$("status").addEventListener("click", (e) => {
  const act = e.target.closest?.("button")?.dataset.act;
  if (act === "lapline") { setLapLine(!lapLineOn); return; }
  if (act === "refit") { refitLandings(); return; }
  if (!act || sel == null) return;
  const adjA = /^adj:(\w+):(-?1)$/.exec(act);
  if (adjA) { adjustPlaced(sel, adjA[1], Number(adjA[2]) * (e.shiftKey ? 4 : 1)); return; }
  if (act === "copy") copySelection();
  else if (act === "mirror") mirrorSelection();
  else if (act === "delmany") removeMany(selection());
  else if (act === "move" || act === "turn") setGizmoMode(act === "move" ? "translate" : "rotate");
  else if (act === "insert" || act === "replace") startEdit(act);
  else if (act === "delete") { editMode = null; removePiece(sel); }
  else if (act === "cp") toggleCheckpoint(sel);
});

// ---------- input ----------
const canvas = renderer.domElement;
canvas.addEventListener("pointermove", (e) => { mouse.x = e.clientX; mouse.y = e.clientY; mouse.inside = true; });
// onto the piece-in-hand bar the ghost stays where it was (its buttons turn / raise it in place)
canvas.addEventListener("pointerleave", (e) => { if (!e.relatedTarget?.closest?.("#hand")) mouse.inside = false; });
let down = null;
// (a press on the gizmo is the gizmo's: no selecting, placing or panning under it)
canvas.addEventListener("pointerdown", (e) => { down = { x: e.clientX, y: e.clientY, b: e.button, gizmo: gizmo.axis != null }; });
canvas.addEventListener("pointerup", (e) => {
  const d = down; down = null;
  if (driving || d?.gizmo) return;
  if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5) return;
  if (d.b === 2 && tileBase) { tileBase = null; renderDock(); return; }
  if (d.b !== 0) return;
  if (tileBase) { place(); return; }
  ray.setFromCamera(new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1), camera);
  let o = ray.intersectObjects(trackGroup.children, true)[0]?.object;
  while (o && o.userData.uid == null) o = o.parent;
  const hit = o?.userData.uid ?? null;
  const run = e.shiftKey && sel != null && hit != null ? runBetween(sel, hit) : null;
  if (run) { selSet = new Set(run); sel = hit; } // the road between the two
  else if ((e.ctrlKey || e.metaKey) && hit != null) { if (selSet.has(hit)) selSet.delete(hit); else selSet.add(hit); sel = selSet.size ? (selSet.has(hit) ? hit : [...selSet].at(-1)) : null; }
  else { sel = hit; selSet = new Set(hit != null ? [hit] : []); }
  editMode = editMsg = null;
  copiedNote = null;
  refreshSelection();
  renderStatus();
});
canvas.addEventListener("contextmenu", (e) => e.preventDefault());
canvas.addEventListener("wheel", (e) => {
  if (!e.shiftKey) return;
  e.preventDefault(); e.stopImmediatePropagation();
  buildY += (e.deltaY || e.deltaX) < 0 ? 2 : -2;
  ghostDirty = true;
}, { capture: true, passive: false });
addEventListener("keydown", (e) => {
  if (driving) return; // the drive session owns the keys
  if (e.code === "Tab") { e.preventDefault(); startDrive(); return; }
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === "z") { e.preventDefault(); restore(e.shiftKey ? redo : undo, e.shiftKey ? undo : redo); return; }
  if ((e.ctrlKey || e.metaKey) && k === "y") { e.preventDefault(); restore(redo, undo); return; }
  if ((e.ctrlKey || e.metaKey) && k === "c" && !tileBase && selection().length) { e.preventDefault(); copySelection(); return; }
  if ((e.ctrlKey || e.metaKey) && k === "v") { e.preventDefault(); pasteSection(); return; }
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
    case "Escape": if (editMode) editMode = null; else if (tileBase) { tileBase = null; renderDock(); } else { sel = null; editMsg = null; refreshSelection(); } break;
    case "Delete": case "Backspace": if (!tileBase && selection().length > 1) removeMany(selection()); else if (!tileBase && sel != null) removePiece(sel); break;
    case "[": arcSpeed = Math.max(20, arcSpeed - 1); refreshArcs(); runChecks(); break;
    case "]": arcSpeed = Math.min(80, arcSpeed + 1); refreshArcs(); runChecks(); break;
    default:
      // by key POSITION (e.code): on AZERTY the letter Q is where A is — W A S D move the camera
      if (e.code === "KeyQ") rot.yaw += step;
      else if (e.code === "KeyE") rot.yaw -= step;
      else if (k === "r") { hand = -hand; renderDock(); }
      else if (k === "g") gridMode = gridMode === "world" ? "local" : "world";
      else if (k === "t") { edges = !edges; renderDock(); }
      else if (k === "f") nav.frame();
      else if (k === "c" && !tileBase && sel != null) toggleCheckpoint(sel);
      else if (k === "i" && !tileBase && sel != null) startEdit("insert");
      else if (k === "m" && !tileBase && movableKind(sel)) setGizmoMode(gizmoMode === "translate" ? "rotate" : "translate");
      else if (k === "l") setLapLine(!lapLineOn);
      else if (k === "p" && !tileBase && sel != null) startEdit("replace");
      else return;
  }
  rot.yaw = ((rot.yaw % 360) + 360) % 360;
  ghostDirty = true;
  e.preventDefault();
});
addEventListener("resize", () => setTimeout(fitView)); // after the engine's own resize
$("b-undo").onclick = () => restore(undo, redo);
$("b-redo").onclick = () => restore(redo, undo);
$("b-frame").onclick = () => nav.frame();
// FIRST STEPS (three lines) or the full key list, in the same corner; ✕ hides the steps for good
const STEPS_OFF = "thunderline.builder.stepsOff";
const stepsOff = () => { try { return localStorage.getItem(STEPS_OFF) === "1"; } catch { return false; } };
$("steps").classList.toggle("hidden", stepsOff());
const toggleKeys = () => {
  const show = $("keys").classList.toggle("hidden") === false;
  $("steps").classList.toggle("hidden", show || stepsOff());
};
$("b-keys").onclick = toggleKeys;
$("steps-keys").onclick = toggleKeys;
$("steps-x").onclick = () => { try { localStorage.setItem(STEPS_OFF, "1"); } catch {} $("steps").classList.add("hidden"); };
// New = a new track in the library (the current one stays, saved)
$("b-new").onclick = () => { save(); location.href = `${PAGES.builder}?track=${library.create().id}`; };
$("b-menu").onclick = () => { save(); location.href = `${PAGES.menu}#build`; };
$("b-name").value = trackName;
$("b-name").onchange = () => { library.rename(trackId, $("b-name").value); trackName = library.get(trackId).name; $("b-name").value = trackName; };
$("b-name").onkeydown = (e) => { e.stopPropagation(); if (e.key === "Enter") e.target.blur(); };
// test drive in the same tab; the drive page's finish screen (and Esc) comes back here
// THE PIECE IN HAND, with the mouse (user, 2026-10-19: players are not used to 3D software): a fixed
// bar over the dock — turn, height, tilt, bank, mirror, put down. Not a 3D gizmo on the ghost: the
// ghost follows the mouse, so reaching for handles on it moved it. While the pointer is on the bar the
// ghost stays where it was (canvas pointerleave below), and each click turns / raises it in place.
let handKey = "";
function renderHand() {
  const el = $("hand");
  const on = !!tileBase && !driving;
  el.classList.toggle("on", on);
  if (!on) { handKey = ""; return; }
  const id = tileId(tileBase);
  const free = snap?.type === "world" || snap?.type === "local";
  const mirror = !!(TILES[`${tileBase}_L`] || TILES[tileBase]?.hand || ADJUSTABLE[tileBase]?.hand);
  const adj = ADJUSTABLE[tileBase];
  const k = [id, free, mirror, hand, rot.yaw, rot.pitch, rot.roll, buildY, adj ? JSON.stringify(adjParams[tileBase]) : ""].join("|");
  if (k === handKey) return;
  handKey = k;
  const off = free ? "" : " off";
  el.innerHTML =
    `<span class="nm">${TILES[id]?.label ?? id}</span>` +
    // an ADJUSTABLE piece's own settings first (the ghost follows them)
    (adj ? Object.entries(adj.params).map(([pk, q]) => `<div class="gp"><span>${q.label}</span><button data-a="p-${pk}" title="Less (Shift: ×4)">◀</button><b>${adjParams[tileBase][pk]}${q.unit}</b><button data-a="p+${pk}" title="More (Shift: ×4)">▶</button></div>`).join("") : "") +
    `<div class="gp${off}" title="${free ? "" : "Snapped to a road end: the road sets the angle"}"><span>Turn</span><button data-a="yl" title="Turn left (Q)">⟲</button><b>${rot.yaw}°</b><button data-a="yr" title="Turn right (E)">⟳</button></div>` +
    `<div class="gp${off}"><span>Height</span><button data-a="hd" title="Lower (PgDn)">▼</button><b>${buildY} m</b><button data-a="hu" title="Higher (PgUp)">▲</button></div>` +
    `<div class="gp${off}"><span>Tilt</span><button data-a="pd" title="Nose down (↓)">⤓</button><b>${rot.pitch}°</b><button data-a="pu" title="Nose up (↑)">⤒</button></div>` +
    `<div class="gp${off}"><span>Bank</span><button data-a="rl" title="Bank left (←)">↶</button><b>${rot.roll}°</b><button data-a="rr" title="Bank right (→)">↷</button></div>` +
    (mirror ? `<div class="gp"><span>Side</span><button data-a="L" class="${hand < 0 ? "on" : ""}" title="Left-hand version (R)">L</button><button data-a="R" class="${hand > 0 ? "on" : ""}" title="Right-hand version (R)">R</button></div>` : "") +
    (free && (rot.yaw || rot.pitch || rot.roll) ? `<button data-a="z" title="Straighten">Reset</button>` : "") +
    `<button class="x" data-a="x" title="Put the piece down (Esc)">✕</button>`;
  for (const b of el.querySelectorAll("button")) b.onclick = (e) => {
    const big = e.shiftKey;
    const pa = /^p([+-])(\w+)$/.exec(b.dataset.a);
    if (pa) {
      adjParams[tileBase] = stepAdjust(tileBase, adjParams[tileBase], pa[2], (pa[1] === "+" ? 1 : -1) * (big ? 4 : 1));
      renderDock();
    }
    switch (b.dataset.a) {
      case "yl": rot.yaw += big ? 5 : 15; break;
      case "yr": rot.yaw -= big ? 5 : 15; break;
      case "hu": buildY += big ? 8 : 2; break;
      case "hd": buildY -= big ? 8 : 2; break;
      case "pu": rot.pitch = Math.min(45, rot.pitch + 5); break;
      case "pd": rot.pitch = Math.max(-45, rot.pitch - 5); break;
      case "rl": rot.roll = Math.max(-45, rot.roll - 5); break;
      case "rr": rot.roll = Math.min(45, rot.roll + 5); break;
      case "L": hand = -1; renderDock(); break;
      case "R": hand = 1; renderDock(); break;
      case "z": rot.yaw = rot.pitch = rot.roll = 0; break;
      case "x": tileBase = null; renderDock(); break;
    }
    rot.yaw = ((rot.yaw % 360) + 360) % 360;
    ghostDirty = true;
    updateGhost();
    renderHand();
  };
}
// TEST DRIVE IN PLACE (user, 2026-10-19): the same page, the same world — Drive (or Tab) puts the car on
// the start in a second; Esc / B brings you back to building, the camera where you left it. The page
// reload each way cost ~30 s since the builder runs on the engine.
const rig = createDriveRig(app, { prefs: settings.get(), car: settings.get().car });
let driving = false;
const builderUi = ["toolbar", "keys", "steps", "status", "next", "dock", "nav"];
let saved = null;
const DRIVE_HELP = `<kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> / arrows drive · <kbd>Space</kbd> handbrake · in the air: <kbd>Shift</kbd>/<kbd>Ctrl</kbd> pitch, <kbd>Q</kbd>/<kbd>E</kbd> spin, <kbd>Z</kbd>/<kbd>X</kbd> roll · <kbd>Backspace</kbd> last checkpoint · <kbd>R</kbd> restart · <b style="color:#3fd2ff"><kbd>Esc</kbd> back to building</b>`;
async function startDrive() {
  if (driving || !orderedPieces().length) return;
  save();
  driving = true;
  gizmo.detach();
  // the builder's own scene objects and panels leave; the camera is kept to come back to
  const objs = [grid, trackGroup, arcGroup, lapGroup, ghost, selBox, failBox, ...overlapBoxes].filter(Boolean);
  saved = { vis: objs.map((o) => [o, o.visible]), ui: builderUi.map((id) => [id, $(id).style.display]), pos: camera.position.clone(), quat: camera.quaternion.clone(), fov: camera.fov, target: controls.target.clone() };
  for (const o of objs) o.visible = false;
  for (const id of builderUi) $(id).style.display = "none";
  controls.enabled = false;
  camera.clearViewOffset();
  camera.updateProjectionMatrix();
  // a selected road piece = practice from it (Trackmania's "test from here"); nothing selected = the full run
  const selRoad = track.pieces.find((p) => p.uid === sel && !isRing(p)); // (not an obstacle or a ring)
  const from = selRoad ? built.get(sel)?.M ?? null : null;
  await rig.start({ track, trackId, from, buttons: [{ label: "Back to building", key: "B", run: stopDrive }], onEscape: stopDrive, help: DRIVE_HELP });
}
function stopDrive() {
  if (!driving) return;
  rig.stop();
  for (const [o, v] of saved.vis) o.visible = v;
  for (const [id, d] of saved.ui) $(id).style.display = d;
  camera.position.copy(saved.pos);
  controls.target.copy(saved.target);
  controls.enabled = true;
  fitView();
  controls.update();
  driving = false;
  attachGizmo(); // the selection's gizmo again
  last = performance.now();
}
$("b-drive").onclick = startDrive;
// THE CAMERA for people who don't use 3D software (editorNav.js)
const nav = createEditorNav({
  camera, controls, dom: renderer.domElement, frameAll, floorY: FLOOR_Y, enabled: () => !driving,
  home: () => { const e = openEnds().at(-1); return e ? new THREE.Vector3().setFromMatrixPosition(e.m) : null; },
});
// THE WORLD (worlds.js), saved with the track: flat to the horizon, or the mountain valley
$("b-world").innerHTML = Object.entries(WORLDS).map(([k, w]) => `<option value="${k}">World: ${w.label}</option>`).join("");
$("b-world").value = WORLDS[track.world] ? track.world : DEFAULT_WORLD;
$("b-world").onchange = () => {
  snapshot(); // undoable like any edit
  track.world = $("b-world").value;
  applyWorld(app, track.world);
  save();
  $("b-world").blur(); // the builder's keys again
};
// TIME OF DAY: the track's own (undoable); the builder's shadows are live, the drive page bakes its own
$("b-tod").innerHTML = TIMES.map(([h, n]) => `<option value="${h}">Time: ${n}</option>`).join("");
$("b-tod").value = String(track.tod ?? DEFAULT_TOD);
$("b-tod").onchange = () => {
  snapshot();
  track.tod = Number($("b-tod").value);
  app.sky?.setTimeOfDay?.(track.tod);
  save();
  $("b-tod").blur();
};
// TRACK INFO: the description (on the track's card) and the SHARE CODE (app/trackCode.js)
async function refreshShareCode() {
  try { $("info-code").value = await encodeTrack(trackName, track); } catch (e) { $("info-code").value = `(no code: ${e.message})`; }
}
let descTimer = null;
$("b-info").onclick = () => {
  const show = $("info").classList.toggle("hidden") === false;
  if (show) { $("info-desc").value = track.description ?? ""; $("info-note").textContent = ""; refreshShareCode(); }
  $("b-info").blur();
};
$("info-desc").oninput = () => {
  track.description = $("info-desc").value.trim() || undefined;
  clearTimeout(descTimer);
  descTimer = setTimeout(() => { save(); refreshShareCode(); }, 400);
};
$("info-desc").onkeydown = $("info-code").onkeydown = (e) => e.stopPropagation(); // typing is not building
$("info-copy").onclick = async () => {
  await refreshShareCode();
  try { await navigator.clipboard.writeText($("info-code").value); $("info-note").textContent = `Copied · ${$("info-code").value.length} characters`; }
  catch { $("info-code").select(); $("info-note").textContent = "Select it and copy (Ctrl+C)"; }
};

// ---------- go ----------
await bakeThumbs();
$("boot").classList.add("gone");
renderDock();
rebuild();
if (track.pieces.length) { frameAll(); controls.update(); } // an opened track starts in view
let last = performance.now();
app.addPreUpdateHook(function builderFrame() {
  const now = performance.now();
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (driving) { if (cueLine.visible) updateHeightCue(); return; } // hides it
  nav.update(dt);
  stepGlide(dt);
  controls.update();
  updateGhost();
  updateHeightCue();
  obstacleSet?.setTime(now / 1000); // the sweepers turn while you build (the test lap has its own clock)
  renderHand();
  updateGrid();
  updateNext();
});
// test hooks: aiming updates the ghost/snap at once (a hidden or minimised window runs no frames)
const hookAim = (f) => (...a) => { controls.update(); camera.updateMatrixWorld(); const r = f(...a); updateGhost(); return r; };
window.__b3 = {
  app, get rig() { return rig; }, startDrive, stopDrive, get driving() { return driving; },
  get track() { return track; }, get snap() { return snap; }, get problems() { return problems; }, built: () => built, camera, controls,
  pickTile: hookAim(pickTile), place, removePiece, frameAll, toggleCheckpoint, select(uid) { sel = uid; refreshSelection(); }, setMouse(x, y) { mouse.x = x; mouse.y = y; mouse.inside = true; },
  aimEnd() { const e = openEnds().at(-1); const s = e && toScreen(new THREE.Vector3().setFromMatrixPosition(e.m)); if (s) { mouse.x = s.x; mouse.y = s.y; mouse.inside = true; } return s; },
  aimFast(k) { const a = arcs.at(-1); if (!a) return null; const p = a.fast.pts[Math.min(k, a.fast.pts.length - 1)]; const s = toScreen(p); if (s) { mouse.x = s.x; mouse.y = s.y; mouse.inside = true; } return { s, n: a.fast.pts.length, p }; },
  aimArc(k) { const a = arcs.at(-1); if (!a) return null; const p = a.pts[Math.min(k, a.pts.length - 1)]; const s = toScreen(p); if (s) { mouse.x = s.x; mouse.y = s.y; mouse.inside = true; } return { s, n: a.pts.length }; },
  setHand(h) { hand = h; renderDock(); }, setEdges(v) { edges = v; renderDock(); }, setBuildY(y) { buildY = y; },
  reset() { track = { pieces: [], nextUid: 1 }; rebuild(); },
  setTrack(t) { track = t; rebuild(); },
  startEdit, get editMsg() { return editMsg; }, gizmo, gizmoProxy, setGizmoMode, movableKind,
  refitLandings, get problems2() { return problems; },
  selectRun(a, b) { sel = b; selSet = new Set(runBetween(a, b) ?? [b]); refreshSelection(); }, selection, copySelection, pasteSection, mirrorSelection, removeMany, get clipboard() { return clipboard; },
  get arcs() { return arcs; }, get launch() { return prediction.launch; },
  get prediction() { return { state: prediction.state, fail: prediction.fail, lapS: prediction.lapS, openJump: prediction.openJump, endSpeed: prediction.endSpeed, landings: prediction.landings, topKmh: Math.round(prediction.topKmh), lips: [...prediction.lipSpeed.entries()].map(([u, v]) => [u, Math.round(v * 3.6)]) }; },
};
for (const k of ["aimEnd", "aimArc", "aimFast", "setMouse", "frameAll"]) window.__b3[k] = hookAim(window.__b3[k]);

