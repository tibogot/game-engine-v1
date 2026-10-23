// Thunderline builder B1 — the snapping builder (P1b's ghost, dock and next-piece chips) on the NEW
// pieces (kit.js: path × section × lean, drawn with the old look). Ends carry their lean; road
// overlaps and blocked flight corridors are checked live; "Drive" opens the track with the real car.
// Throwaway prototype (DESIGN.md §4–§5, §9).
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { Line2 } from "three/addons/lines/webgpu/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { uniform, positionLocal, abs, fract, fwidth, float, min, max, smoothstep, length, vec3, color } from "three/tsl";
import { applyBloomMRT } from "../../../../v3/render/bloomMRT.js";
import { startV3App } from "../../../../v3/engine.js";
import { TILES, integrate, socketMatrix, leanIn, leanOut, deckFrame, SECTIONS, DEG, ensureTile, ADJUSTABLE, adjustableId, parseAdjustable } from "./kit.js";
import { buildOldLook, createOldLookMaterials, edgesOf } from "./oldLook.js";
import { createAutopilot } from "./autopilot.js";
import { createCarRules, magnetZones, wallCutZones, JUMP } from "./carRules.js";
import { makeGateMesh, makeRingMesh } from "./gateMesh.js";
import { closureAt, wallAt } from "./tubeLook.js";
import { createRace } from "./race.js";
import { library, settings, PAGES } from "../../app/library.js";
import { createDriveRig } from "./driveSession.js";
import { createEditorNav } from "./editorNav.js";
import { applyWorld, WORLDS, DEFAULT_WORLD, TIMES, DEFAULT_TOD, groundFeatures } from "./worlds.js";
import { encodeTrack } from "../../app/trackCode.js";
import { buildTrackMeshes } from "./testTrack.js";
import { createBuilderTutorial } from "./builderTutorial.js";
import { OBSTACLES, HOLE, BOOST_PAD, isObstacle, obstacleLook, buildObstacleSet, avoidObstacles, shapeOf, boostZones } from "./obstacles.js";
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
const SNAP_COLORS = { end: 0x45e08a, road: 0x45e08a, side: 0x7dffc8, arc: 0xff9a3d, local: 0xc78bff, world: 0x3fd2ff };
const GRID_STEPS = [1, 2, 4, 8];

// THE DOCK'S TABS (user, 2026-10-22, from Apex Rush's palette: "game, straight, turns, banked, slope,
// ramps, loop, obstacles"): one home per piece, by what kind of road it is — our own dock and look
const CATS = [
  // the race's own things: where it starts and ends, what it hands the car
  { id: "game", label: "Game", tiles: ["start_line", "finish_line", "test_car", "air_ring", "ob_boost", "ob_jump"] }, // (boost_32 left the palette, user 2026-10-22: the Boost pad does it; old tracks keep it)
  { id: "straight", label: "Straight", tiles: ["adj_straight", "straight_64", "plank_32", "plank_64", "platform_32", "platform_64", "platform_128", "funnel_64", "flare_64", "wedge_48", "curved_wedge_48", "round_end_24"] },
  // flat-out first, then a lift, then the brake ones (PIECES.md §7d: the turn set)
  { id: "turns", label: "Turns", tiles: ["adj_turn", "sweep_160_15", "sweep_160_30", "sweep_160_45", "s_bend_96", "turn_96_45", "turn_96_90", "snake_60", "turn_48_90", "brake_turn_32", "turn_48_180", "hairpin_24", "platform_turn_90"] },
  { id: "banked", label: "Banked", tiles: ["bank_in_22", "banked_straight_64", "banked_turn_45", "fast_turn_128", "banked_turn_180", "bank_out_22", "wallride_90", "uturn_wall_32"] },
  { id: "slope", label: "Slope", tiles: ["adj_slope", "slope_up_12", "slope_down_12", "platform_up_12", "platform_down_12", "helix_up_360", "helix_down_360", "rollers_64", "drop_16"] },
  // the take-offs, then what you land on
  { id: "ramps", label: "Ramps", tiles: ["adj_kicker", "kicker_20", "launch_45", "launch_60", "quarter_pipe", "roll_kicker", "gap_jump", "fitted_landing", "landing_20", "banked_landing_20", "landing_turn_20", "catch_pad"] },
  { id: "loop", label: "Loop", tiles: ["loop_28", "sky_loop", "half_loop_28", "twist_120", "fitted_bowl", "flip_ramp_std", "flip_ramp_s"] },
  { id: "tubes", label: "Tubes", tiles: ["halfpipe_in", "halfpipe_64", "halfpipe_turn_64", "halfpipe_out", "tube_in", "tube_32", "tube_64", "tube_turn_64", "tube_turn_32", "tube_roof_drop", "tube_cannon", "tube_out", "catch_tube"] },
  // things on the road that are not road (obstacles.js): placed on a road or on the floor, kept in track.props
  { id: "obstacles", label: "Obstacles", tiles: ["ob_pole", "ob_slalom", "ob_gate", "ob_block", "ob_sweeper", "ob_wall_door", "ob_wall_hole"] },
];
const catOf = new Map();
for (const c of CATS) for (const t of c.tiles) catOf.set(t, c.id);

// ---------- state ----------
let track = load() ?? { pieces: [], nextUid: 1 };
let trackName = library.get(trackId)?.name ?? "Track";
let hand = 1; // +1 right, −1 left (picks the "_L" mirror)
let freeHold = false; // Alt held: free placement, no snapping
let edges = true; // rails: true both, "L" left only, "R" right only, false none (oldLook.js edgesOf)
/** A placed piece's fields for those rails (old tracks keep `open`; one side adds `rail`). */
const railFields = (e) => ({ open: e === false, ...(e === "L" || e === "R" ? { rail: e } : {}) });
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
// Since PRECISION LANDINGS (2026-10-21) landings no longer catch this whole band — they start at NEAR ×
// (0.95) and slower falls short; the orange arc stays as a picture of what a slow car does.
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
// TILTED LANDINGS (user, 2026-10-21, Apex Rush: the air roll must matter): with the Fitted landing in
// hand, ← / → lean its catch zone (5° steps, ±45; + = the right side low); it rolls back to flat by its exit
let landTilt = 0;
// "catch_tube": the same idea as a TUBE whose wide portal is laid on the jump's arc (kit.js ensureTile):
// the car flies into it and comes out level in a pipe (user, 2026-10-21: "jump to enter inside a tube in air")
const CATCH = "catch_tube";
let catchId = ensureTile(`catch_tube_${FITTED_ANGLE}_32`).id;
const TUBE_ROOF = 16; // m, floor to roof inside a tube (portal and pipe alike: tubeLook.js)
const ROOF_CLEAR = 3; // m: the car's height plus a margin under the roof
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
// THE TEST CAR (user, 2026-10-22: "a way to spawn the car anywhere I want so I don't have to redo the whole
// track to test a piece … use a ghost car for that"): a hologram of the car laid on a road like an obstacle
// (track.spawn = { on, s, lat, yaw, kmh }: it goes where its piece goes), Q/E turn it, its START SPEED in the
// panel. Drive starts there at that speed; R again from it, Delete from the start line.
const SPAWN = "test_car";
const SPAWN_SPEEDS = [0, 50, 100, 150, 200, 250];
let carHolo = null; // { geometry, material } once the car model is in (rig.carHologram)
const RING_R = 5.5;
const ringGateOf = (pc) => {
  const M = new THREE.Matrix4().fromArray(pc.M);
  return { kind: "cp", ring: true, P: new THREE.Vector3().setFromMatrixPosition(M), T: new THREE.Vector3(0, 0, -1).transformDirection(M), U: new THREE.Vector3(0, 1, 0).transformDirection(M), hw: RING_R };
};
const isRing = (p) => !!p?.ring;
// ADJUSTABLE pieces (kit.js ADJUSTABLE): the card's settings in hand, one set per kind
/** An adjustable setting as shown: its name (a Width's "Wide") or its number and unit. */
const adjShow = (q, v) => (q.names ? q.names[v] : `${v}${q.unit}`);
const adjDefaults = (base) => Object.fromEntries(Object.entries(ADJUSTABLE[base].params).map(([k, q]) => [k, q.def]));
const adjParams = Object.fromEntries(Object.keys(ADJUSTABLE).map((b) => [b, adjDefaults(b)]));
const tileId = (base, h = hand) => {
  if (ADJUSTABLE[base]) return ensureTile(adjustableId(base, adjParams[base], ADJUSTABLE[base].hand ? h : 1)).id;
  if (base === RING || isObstacle(base) || base === STAMP || base === SPAWN) return base;
  if (base === FITTED) return fittedId;
  if (base === CATCH) return catchId;
  if (base === FITTED_BOWL) return ensureTile(`bowl_${bowlR}${h < 0 ? "_L" : ""}`).id;
  return h < 0 && TILES[`${base}_L`] ? `${base}_L` : base;
};
const tileLabel = (base) => (base === SPAWN ? "Test car" : ADJUSTABLE[base] ? `${TILES[tileId(base)].label} ⚙` : base === STAMP ? `Section · ${clipboard?.n ?? 0} piece${clipboard?.n === 1 ? "" : "s"}${hand < 0 ? " (mirrored)" : ""}` : isObstacle(base) ? OBSTACLES[base].label : base === RING ? "Air ring" : base === FITTED ? "Fitted landing" : base === CATCH ? "Catch tube" : base === FITTED_BOWL ? `Fitted bowl · R${bowlR}` : TILES[base].label);
const thumbOf = (id) => (parseAdjustable(id) ? parseAdjustable(id).base : id === RING || isObstacle(id) ? id : id === FITTED || id.startsWith("fitted_landing_") ? "landing_20" : id === CATCH || id.startsWith("catch_tube_") ? "tube_in" : id === FITTED_BOWL || id.startsWith("bowl_") ? "fitted_bowl" : id.replace(/_L$/, ""));
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
  splatFeatures: groundFeatures(), // worlds.js: paint slots 0-2 only (3 layers, not 7) + the anti-tiling features
  terrainLayers: 3, // and the GPU paint arrays hold just those 3 (−42 MB of video memory)
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
// `open` here: true = no rails, false = both, "L" / "R" = one side (RAILS PER SIDE, 2026-10-21) —
// pcOE(pc) turns a placed piece into it, oeOf(edges) the dock's switch
const oeOf = (e) => (e === false ? true : e === "L" || e === "R" ? e : false);
const pcOE = (pc) => oeOf(edgesOf(pc));
function piece(id, open = false) {
  const key = `${id}|${open}`;
  if (!cache.has(key)) {
    const t = ensureTile(id);
    const b = integrate(t);
    cache.set(key, { t, b, look: buildOldLook(t, open === true ? false : open === false ? true : open), exitLocal: socketMatrix(b.exit) });
  }
  return cache.get(key);
}
function meshesFor(id, open) {
  const { look } = piece(id, open);
  const g = new THREE.Group();
  g.add(new THREE.Mesh(look.deck, TILES[id]?.tube || TILES[id]?.halfpipe ? mats.tube : mats.road));
  if (look.rail) g.add(new THREE.Mesh(look.rail, look.trim ? mats.trim : mats.rail));
  if (look.under) g.add(new THREE.Mesh(look.under, mats.stripe)); // stunt stripes (oldLook.js STRIPED)
  if (look.posts?.template && look.posts.matrices.length) {
    const im = new THREE.InstancedMesh(look.posts.template, mats.rail, look.posts.matrices.length);
    look.posts.matrices.forEach((m, i) => im.setMatrixAt(i, m));
    im.computeBoundingSphere();
    g.add(im);
  }
  return g;
}

// ---------- thumbnails: each tile rendered once, 3/4 view ----------
// THE DOCK'S PICTURES, per RAILS setting (user, 2026-10-22: in Apex Rush "the thumbnails change when we
// choose edges or no edges"): key `${piece}|${rails}` (rails = oeOf(edges): false both, true none, "L", "R").
// All pieces with both rails at start; another setting's pictures are drawn when first shown, one by one.
const thumbs = new Map();
let thumbKit = null;
function thumbSetup() {
  if (thumbKit) return thumbKit;
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
  return (thumbKit = { W, H, rt, ts, cam, cvs, ctx: cvs.getContext("2d") });
}
/** Whether a dock piece's picture depends on the rails (not obstacles, rings, tubes, half-pipes). */
const railsMatter = (id) => id !== RING && id !== SPAWN && !isObstacle(id) && id !== CATCH && !TILES[id]?.tube && !TILES[id]?.halfpipe;
async function renderThumb(id, open) {
  const { W, H, rt, ts, cam, ctx, cvs } = thumbSetup();
  const pid = id === FITTED_BOWL ? "bowl_110" : ADJUSTABLE[id] ? ensureTile(adjustableId(id, adjDefaults(id))).id : id; // a typical one
  const g = id === SPAWN
    ? new THREE.Group().add(new THREE.Mesh(carHolo?.geometry ?? new THREE.BoxGeometry(2, 1.2, 4.4).translate(0, 0.6, 0), carHolo?.material ?? ghostMat))
    : id === RING
    ? makeRingMesh({ P: new THREE.Vector3(), T: new THREE.Vector3(0.5, -0.15, -1).normalize(), U: new THREE.Vector3(0, 1, 0), hw: RING_R })
    : isObstacle(id) ? obstacleLook(id) : meshesFor(pid, open);
  const t = id === RING || isObstacle(id) || id === SPAWN ? {} : ensureTile(pid);
  if (t.start || t.finish) g.add(lineGate({ id: pid }, new THREE.Matrix4(), open)); // its gantry, as on the track
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
  thumbs.set(`${id}|${open}`, cvs.toDataURL());
  ts.remove(g);
}
async function bakeThumbs() {
  for (const c of CATS) for (const id of c.tiles) {
    if (id === FITTED || id === CATCH) continue; // drawn with the landing's / tube's picture (see pic)
    await renderThumb(id, false);
  }
}
const thumbQueue = [];
let thumbBusy = false;
function wantThumb(id, open) {
  const k = `${id}|${open}`;
  if (thumbs.has(k) || thumbQueue.some((q) => q.k === k)) return;
  thumbQueue.push({ id, open, k });
  if (!thumbBusy) runThumbQueue();
}
async function runThumbQueue() {
  thumbBusy = true;
  while (thumbQueue.length) { const q = thumbQueue.shift(); await renderThumb(q.id, q.open); }
  thumbBusy = false;
  renderDock();
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
    for (const r of piece(pc.id, pcOE(pc)).b.rings) pts.push(r.p.clone().applyMatrix4(b.M));
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
  const base = thumbOf(id);
  // the rails as the dock's switch sets them — on a mirrored (_L) piece, drawn flipped: its sides swap
  let open = railsMatter(base) ? oeOf(edges) : false;
  if (id.endsWith("_L") && (open === "L" || open === "R")) open = open === "L" ? "R" : "L";
  if (open !== false) wantThumb(base, open);
  const url = thumbs.get(`${base}|${open}`) ?? thumbs.get(`${base}|false`);
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
    b.dataset.cat = c.id; // (the tutorial points at it)
    b.innerHTML = `${c.label}<span class="n">${c.tiles.length}</span>`;
    b.onclick = () => { activeCat = c.id; renderDock(); };
    tabs.appendChild(b);
  }
  const sp = document.createElement("div"); sp.className = "spacer"; tabs.appendChild(sp);
  tabs.appendChild(toggleBtns("Rails", [[true, "Both"], ["L", "Left"], ["R", "Right"], [false, "None"]], edges, (v) => { edges = v; ghostDirty = true; renderDock(); }));
  tabs.appendChild(toggleBtns("Hand", [[-1, "L"], [1, "R"]], hand, (v) => { hand = v; ghostDirty = true; renderDock(); }));
  const cards = $("cards");
  cards.innerHTML = "";
  for (const base of CATS.find((c) => c.id === activeCat).tiles) {
    const b = document.createElement("button");
    b.className = "card cut" + (tileBase === base ? " on" : "");
    b.dataset.base = base;
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
    editWith(base === RING || base === FITTED || base === CATCH || base === FITTED_BOWL ? base : tileId(base, h ?? hand));
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

let chunkMeshes = null;
const pieceLooks = {}; // buildTrackMeshes' `built`: id -> { guarded, open } (the builder's piece cache)
function drawChunks() {
  const placements = [];
  for (const pc of track.pieces) {
    if (isRing(pc) || !built.has(pc.uid)) continue;
    pieceLooks[pc.id] ??= { guarded: piece(pc.id, false).look, open: piece(pc.id, true).look };
    placements.push({ id: pc.id, open: !!pc.open, rail: pc.rail, M: built.get(pc.uid).M });
    built.get(pc.uid).group.traverse((o) => { if (o.isMesh) o.visible = false; });
  }
  chunkMeshes = buildTrackMeshes(placements, pieceLooks, mats);
  chunkMeshes.group.name = "trackChunks";
  chunkMeshes.group.traverse((o) => { o.raycast = () => {}; }); // the mouse picks the pieces, never the chunks
  trackGroup.add(chunkMeshes.group);
}
/** While the gizmo drags: the pieces themselves are drawn (they move), the chunks hidden; rebuilt after. */
function showPieceMeshes(on) {
  if (chunkMeshes) chunkMeshes.group.visible = !on;
  for (const [uid, b] of built) if (!b.prop && track.pieces.some((p) => p.uid === uid && !isRing(p))) b.group.traverse((o) => { if (o.isMesh) o.visible = on; });
}
/**
 * RELEASE what a rebuild made new (performance pass, 2026-10-23: nothing was disposed — 10 edits on White 3
 * left +90 geometries and +28.5 MB of GPU buffers). The merged road chunks and their post instances, the
 * gates' and rings' own geometry and materials, the obstacles' geometry (their materials are shared), the
 * test car's stand-in box. NOT the pieces' own meshes: their geometry is the shared piece cache.
 */
function disposeTree(root, materials) {
  root.traverse((o) => {
    if (!o.isMesh && !o.isLine) return;
    o.geometry?.dispose();
    if (o.isInstancedMesh) o.dispose();
    if (materials) for (const m of [].concat(o.material)) m?.dispose();
  });
}
function releaseRebuilt() {
  if (chunkMeshes) { disposeTree(chunkMeshes.group, false); chunkMeshes = null; }
  for (const c of trackGroup.children) {
    if (c.userData.gate) disposeTree(c, true); // a checkpoint / start / finish gate or an air ring: all its own
    else if (c.userData.spawn && !carHolo) c.geometry?.dispose(); // (the stand-in box)
  }
  if (obstacleSet) disposeTree(obstacleSet.group, false);
}
let trackVer = 0; // bumped by every rebuild and arc refresh: the snap's cache key (updateGhost)
function rebuild() {
  trackVer++;
  releaseRebuilt();
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
    // (`off`: laid OFF-CENTRE across a wider end — a road leaving a platform from its side half)
    const M = pc.parent != null && built.has(pc.parent) ? built.get(pc.parent).exit.clone().multiply(new THREE.Matrix4().makeTranslation(pc.off ?? 0, 0, 0)) : new THREE.Matrix4().fromArray(pc.M);
    pc.M = M.toArray();
    ensureTile(pc.id); // generated pieces (fitted landings) are rebuilt from their id
    const g = meshesFor(pc.id, pcOE(pc));
    g.matrixAutoUpdate = false;
    g.matrix.copy(M);
    g.userData.uid = pc.uid;
    trackGroup.add(g);
    if (pc.cp) trackGroup.add(checkpointGate(pc, M));
    if (TILES[pc.id]?.start || TILES[pc.id]?.finish) trackGroup.add(lineGate(pc, M));
    built.set(pc.uid, { exit: M.clone().multiply(piece(pc.id, pcOE(pc)).exitLocal), group: g, M });
  }
  // THE ROAD IS DRAWN IN CHUNKS (testTrack.buildTrackMeshes, as the drive page: performance pass,
  // 2026-10-20 — every piece its own mesh was ~220 draws on a big track). The pieces' own groups stay for
  // the mouse (picking, selection boxes, the gizmo), HIDDEN: three's ray hits hidden meshes, the camera skips them.
  drawChunks();
  // OBSTACLES (track.props): drawn here, selectable like pieces; the sweepers turn on the page's clock.
  // Those on a piece are laid on it again first (it may have moved or changed: roadSnapAt)
  relayProps();
  obstacleSet = buildObstacleSet(track.props ?? []);
  // THE TEST CAR: re-laid on its piece (gone with it)
  if (track.spawn) {
    const m = spawnFrame();
    if (!m) delete track.spawn;
    else {
      const holo = new THREE.Mesh(carHolo?.geometry ?? new THREE.BoxGeometry(2, 1.2, 4.4).translate(0, 0.6, 0), carHolo?.material ?? ghostMat);
      holo.matrixAutoUpdate = false;
      holo.matrix.copy(m);
      holo.renderOrder = 12;
      holo.userData.spawn = true;
      trackGroup.add(holo);
    }
  }
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
  const { b, t } = piece(pc.id, pcOE(pc));
  const hw = SECTIONS[t.section ?? "road"].hw;
  const r = b.rings[Math.floor(b.rings.length / 2)];
  const f = deckFrame(r, hw);
  return makeGateMesh({ kind: "cp", P: f.P.clone().applyMatrix4(M), T: r.T.clone().transformDirection(M), U: f.U.clone().transformDirection(M), hw }, { lift: 0 });
}
// START / FINISH gantries (gateMesh.js) stand in the builder too, at the piece's line: you see at once
// where a track begins and ends (user, 2026-10-22)
function lineGate(pc, M, oe = pcOE(pc)) {
  const { b, t } = piece(pc.id, oe);
  const hw = SECTIONS[t.section ?? "road"].hw;
  const line = t.start ? t.start.line : t.finish.line;
  const r = b.rings.reduce((a, q) => (Math.abs(q.s - line) < Math.abs(a.s - line) ? q : a));
  const f = deckFrame(r, hw);
  const kind = t.start ? "start" : "finish";
  return makeGateMesh({ kind, P: f.P.clone().applyMatrix4(M), T: r.T.clone().transformDirection(M), U: f.U.clone().transformDirection(M), hw, slot: t.start ? t.start.line - t.start.spawn : 0 }, { lift: 0 });
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
const PRED_SLICE_MS = 12; // the background test lap's share of a frame (8 ms: the result came in ~7.6 s on White 3)
function schedulePrediction() { clearTimeout(predTimer); predTimer = setTimeout(runPrediction, 250); }
/** Every piece the road reaches: the driving order, plus pieces laid BESIDE them (`sideOf`) and the road
 * that goes on from those — they are deck to land on and drive across, not part of the test lap's line. */
/** The jump pads standing on a piece (obstacles.js ob_jump): each one a take-off, like a lip. */
const jumpPadsOn = (uid) => (track.props ?? []).filter((p) => p.on === uid && OBSTACLES[p.kind]?.boost?.jump);
const isJumpPad = (uid) => (track.props ?? []).some((p) => p.uid === uid && OBSTACLES[p.kind]?.boost?.jump);
function connectedUids() {
  const set = new Set(orderedPieces().map((p) => p.uid));
  // a jump pad is as connected as the piece it stands on (a landing hangs off it by `flightFrom`)
  const padHost = new Map((track.props ?? []).filter((p) => p.on != null).map((p) => [p.uid, p.on]));
  for (let grew = true; grew;) {
    grew = false;
    for (const p of track.pieces) if (!set.has(p.uid) && !isRing(p) && (set.has(p.sideOf) || set.has(p.parent) || set.has(p.flightFrom) || set.has(padHost.get(p.flightFrom)))) { set.add(p.uid); grew = true; }
  }
  return set;
}
/** Pieces in driving order: from the first piece, follow the road child, else the flight's landing. */
function orderedPieces() {
  const out = [];
  let cur = track.pieces[0];
  const seen = new Set();
  while (cur && !seen.has(cur.uid)) {
    seen.add(cur.uid);
    out.push(cur);
    const at = cur;
    cur = track.pieces.find((q) => q.parent === at.uid) ?? track.pieces.find((q) => q.flightFrom === at.uid && !isRing(q))
      // …or the landing of a JUMP PAD on it (the road ends; the pad throws the car onto the next piece)
      ?? jumpPadsOn(at.uid).map((pad) => track.pieces.find((q) => q.flightFrom === pad.uid && !isRing(q))).find(Boolean);
    // nothing after it: the road may go on from a piece laid BESIDE it (a wide landing whose way out
    // leaves from its other half) — the car drives across the joined decks to it, as the drive page does
    if (!cur) {
      for (const sp of track.pieces.filter((q) => q.sideOf === at.uid || q.uid === at.sideOf)) {
        cur = track.pieces.find((q) => q.parent === sp.uid && !seen.has(q.uid));
        if (cur) break;
      }
    }
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
    const { look, b, t } = piece(pc.id, pcOE(pc));
    const M = built.get(pc.uid).M;
    decks.push(col(look.deck, M, { roadHold: ROAD_HOLD.has(pc.id.replace(/_L$/, "")) || !!t.roadHold, freeCarve: !!t.freeCarve }));
    if (look.railCollision) solids.push(col(look.railCollision, M));
    const hw = SECTIONS[t.section ?? "road"].hw;
    for (const r of b.rings) {
      const f = deckFrame(r, hw);
      // the line 0.7 m above the deck, AS THE DRIVE PAGE'S (testTrack.layoutFromPlacements) — on a twist its
      // roll axis. (On the deck itself, the autopilot's touchdown on White 3's bowl came out wrong: the test
      // lap fell there while the drive page's autopilot landed it perfect, 2026-10-22.)
      const Pr = f.P.clone().addScaledVector(f.U, r.pivot ?? 0.7);
      ride.push({ P: Pr.clone().applyMatrix4(M), T: r.T.clone().transformDirection(M), U: f.U.clone().transformDirection(M), uid: pc.uid, tube: t.tube ? closureAt(t, r.s, b.L) : t.halfpipe ? 0.5 * wallAt(t, r.s, b.L) : 0, air: !!r.air });
    }
  }
  // the pieces BESIDE the road (and their own road): solid deck and rails, not on the line
  const inOrder = new Set(order.map((p) => p.uid)), conn = connectedUids();
  for (const pc of track.pieces) {
    if (inOrder.has(pc.uid) || !conn.has(pc.uid) || isRing(pc)) continue;
    const { look, t } = piece(pc.id, pcOE(pc));
    const M = built.get(pc.uid).M;
    decks.push(col(look.deck, M, { roadHold: !!t.roadHold, freeCarve: !!t.freeCarve }));
    if (look.railCollision) solids.push(col(look.railCollision, M));
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
  const boosts = [...order.filter((p) => p.id.startsWith("boost")).map((p) => built.get(p.uid).M.clone().invert()), ...boostZones(track.props)];
  let lowY = Infinity;
  for (const r of ride) lowY = Math.min(lowY, r.P.y);
  const lipSpeed = new Map(), launch = new Map();
  // each piece's exit frame AS THIS RUN STARTED: the run yields between slices, and an edit meanwhile
  // rebuilds `built` (a launch read a piece that was gone: "Cannot read … 'exit'")
  const exits = new Map(order.map((pc) => [pc.uid, built.get(pc.uid).exit.clone()]));
  // a track that ENDS on a lip (the jump you are building): run until the take-off is measured —
  // that number is the whole point — and call it an open jump, not a failure
  const lastUid = ride[ride.length - 1].uid;
  // a FINISH piece: the lap ends on its line (its entry), as the drive page times it
  const finPc = order.at(-1);
  const finishIdx = TILES[finPc.id]?.finish ? ride.findIndex((r) => r.uid === finPc.uid) : -1;
  // JUMP PADS: their zones (the car on one, wheels down, then airborne within 0.1 s = its take-off)
  const padZones = (track.props ?? []).filter((q) => q.on != null && OBSTACLES[q.kind]?.boost?.jump).map((q) => {
    const M = new THREE.Matrix4().fromArray(q.M);
    return { uid: q.uid, kind: q.kind, host: q.on, inv: M.clone().invert(), ...OBSTACLES[q.kind].boost };
  });
  let onPad = null, onPadTick = -1e9;
  const endsOnLip = lips.has(lastUid) || padZones.some((z) => z.host === lastUid);
  prediction.openJump = false;
  let idx = 0, slow = 0, wasGrounded = true, flying = null, airT = 0, sliceT0 = performance.now();
  const nose = new THREE.Vector3();
  const pilot = createAutopilot(avoidObstacles(ride, track.props)); // the drive page's autopilot (wall cut, air spin), its line round the obstacles
  const magnets = magnetZones(order.map((pc) => ({ id: pc.id, M: built.get(pc.uid).M })), TILES, integrate);
  const cutZones = wallCutZones(order.map((pc) => ({ id: pc.id, M: built.get(pc.uid).M })), Object.fromEntries(order.map((pc) => [pc.id, { b: piece(pc.id, pcOE(pc)).b }])));
  const rules = createCarRules(car, { boostPads: boosts, magnets, cutZones }); // the drive page's rules: wall cut (bowls, quarter pipes), landing boost, pads, magnets
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
      // stored in the LIP's frame (2026-10-21): a world position went stale when the lip moved, or when
      // a new track reused its uid — a catch tube was aimed 32 m to the side of the real flight
      const inv = exits.get(ride[idx].uid).clone().invert();
      const rInv = new THREE.Matrix4().extractRotation(inv);
      launch.set(ride[idx].uid, { id: track.pieces.find((q) => q.uid === ride[idx].uid)?.id, P: car.body.pos.clone().addScaledVector(carUp, -0.55).applyMatrix4(inv), V: car.body.vel.clone().applyMatrix4(rInv), U: carUp.clone().applyMatrix4(rInv), F: new THREE.Vector3(0, 0, 1).applyQuaternion(car.body.quat).applyMatrix4(rInv) });
      flying = ride[idx].uid;
      airT = 0;
    }
    if (grounded) for (const z of padZones) {
      const lp = car.body.pos.clone().applyMatrix4(z.inv);
      if (Math.abs(lp.x) < z.hx && Math.abs(lp.z) < z.hz && lp.y > -1 && lp.y < 3) { onPad = z; onPadTick = tick; }
    }
    if (wasGrounded && !grounded && onPad && tick - onPadTick < 12) {
      lipSpeed.set(onPad.uid, car.body.vel.length());
      const carUp = new THREE.Vector3(0, 1, 0).applyQuaternion(car.body.quat);
      const rInv = new THREE.Matrix4().extractRotation(onPad.inv);
      launch.set(onPad.uid, { id: onPad.kind, P: car.body.pos.clone().addScaledVector(carUp, -0.55).applyMatrix4(onPad.inv), V: car.body.vel.clone().applyMatrix4(rInv), U: carUp.clone().applyMatrix4(rInv), F: new THREE.Vector3(0, 0, 1).applyQuaternion(car.body.quat).applyMatrix4(rInv) });
      flying = onPad.host; // (a pad on the last piece: the open jump, as off a lip)
      airT = 0;
      onPad = null;
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
    // SLICES BY TIME, not by ticks (performance pass, 2026-10-23: 240 ticks were 120-570 ms with no frame
    // drawn — the builder stuttered for seconds after every edit): ~8 ms of physics, then a frame
    if ((tick & 7) === 7 && performance.now() - sliceT0 > PRED_SLICE_MS) {
      await new Promise((r) => requestAnimationFrame(() => r()));
      if (token !== predToken) return; // a newer edit started another prediction
      sliceT0 = performance.now();
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
  if (failBox) { scene.remove(failBox); disposeTree(failBox, true); failBox = null; }
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
  // (a finish, and a CLOSED platform shape — a wedge's point, a round end — have no end to go on from)
  return track.pieces.filter((p) => !isRing(p) && !hasChild.has(p.uid) && !TILES[p.id]?.finish && !TILES[p.id]?.closed).map((p) => {
    const m = built.get(p.uid).exit;
    const dir = new THREE.Vector3(0, 0, -1).transformDirection(m);
    return { uid: p.uid, m, lean: leanOut(TILES[p.id]), pitch: Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1)) };
  });
}

// ---------- flight arcs: the car's air model (gravity + drag), a SPEED BAND per lip ----------
const arcGroup = new THREE.Group();
scene.add(arcGroup);
let arcs = []; // { pts, tan, from, landing } — the SLOW edge of the band (landings fit there, P3)
let roadCache = null; // cutAtRoad: the road's points, kept per refreshArcs
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
/** The deck's up at a socket `m` leaned by `lean` (rad; kit.js deckFrame: + tips the up to the right). */
function surfaceUp(m, lean) {
  const U = new THREE.Vector3(0, 1, 0).transformDirection(m), R = new THREE.Vector3(1, 0, 0).transformDirection(m);
  return U.multiplyScalar(Math.cos(lean)).addScaledVector(R, Math.sin(lean)).normalize();
}
/** A frame's roll round its OWN forward `f` (rad, + = the up tipped right = the right side low): pitch
 * drops out — the player pitches onto the slope anyway; measured across the flight instead, a car
 * leaving a 20° lip rolled 30° read 45° onto a 35° landing. */
function rollRound(f, u) {
  const level = UP.clone().addScaledVector(f, -UP.dot(f)).normalize();
  const uu = u.clone().addScaledVector(f, -u.dot(f)).normalize();
  return Math.atan2(uu.dot(new THREE.Vector3().crossVectors(f, level)), uu.dot(level));
}
/** THE AIR ROLL a landing asks for: from the car's roll at take-off (it keeps it in the air unless the
 * player rolls) to the landing surface's, each round its own forward. Signed (°): + = roll right. */
function rollToLand(a, m, lean) {
  const r = rollRound(new THREE.Vector3(0, 0, -1).transformDirection(m), surfaceUp(m, lean)) - rollRound(a.fwd, a.up);
  return THREE.MathUtils.euclideanModulo(r + Math.PI, 2 * Math.PI) / DEG - 180;
}
/** The builder's line about it, or "" when the car lands as it flies (the PERFECT window, landing.js). */
function rollNote(a, m, lean) {
  const r = rollToLand(a, m, lean);
  return Math.abs(r) <= 6 ? "" : `roll ${Math.round(Math.abs(r) / 5) * 5}° ${r > 0 ? "right" : "left"} in the air to land`;
}
function refreshArcs() {
  trackVer++;
  for (const c of arcGroup.children.slice()) { arcGroup.remove(c); c.geometry.dispose(); }
  arcs = [];
  roadCache = null; // (cutAtRoad's road points: this track as it is now)
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
    // the measured take-off, back into the world from this lip's CURRENT frame (if it is still that piece)
    const L = prediction.launch?.get(p.uid);
    const rm = new THREE.Matrix4().extractRotation(m);
    const launch = L && L.id === p.id ? { P: L.P.clone().applyMatrix4(m), V: L.V.clone().applyMatrix4(rm), U: L.U?.clone().applyMatrix4(rm), F: L.F?.clone().applyMatrix4(rm) } : null;
    const v = prediction.lipSpeed.get(p.uid) ?? arcSpeed;
    const fly = (sc) => flight(m, v * sc, launch, sc);
    const slow = fly(BAND_SLOW), fast = fly(1), near = fly(NEAR);
    // the car's UP as it leaves (the roll kicker throws it tilted): measured, else the lip's leaned deck
    const up = launch?.U ?? surfaceUp(m, leanOut(TILES[p.id])), fwd = launch?.F ?? new THREE.Vector3(0, 0, -1).transformDirection(m);
    arcs.push({ ...slow, fast, near, from: p.uid, landing, lip: { m, launch, v }, up, fwd, fly }); // fly: any speed in the band (catch tube, reach)
  }
  // JUMP PADS (2026-10-21): a take-off like a lip — the car's speed along the road carries on, its speed
  // along the pad's up is the pad's (carRules JUMP: raised to it, so it does NOT scale with the band).
  // From the measured take-off (prediction) else a guess. A pad mid-road: the arc ends where it comes
  // back down on a road (no "flight passes under a road" for the road it lands back on).
  for (const pad of track.props ?? []) {
    if (pad.on == null || !OBSTACLES[pad.kind]?.boost?.jump) continue;
    const m = new THREE.Matrix4().fromArray(pad.M);
    const rm = new THREE.Matrix4().extractRotation(m);
    const padUp = new THREE.Vector3(0, 1, 0).transformDirection(m);
    const L = prediction.launch?.get(pad.uid);
    const P = L && L.id === pad.kind ? L.P.clone().applyMatrix4(m) : new THREE.Vector3(0, 0.55, -OBSTACLES[pad.kind].boost.hz).applyMatrix4(m);
    const V = L && L.id === pad.kind ? L.V.clone().applyMatrix4(rm) : new THREE.Vector3(0, 0, -1).transformDirection(m).multiplyScalar(prediction.lipSpeed.get(pad.uid) ?? arcSpeed).addScaledVector(padUp, JUMP.v);
    const vu = V.dot(padUp), rest = V.clone().addScaledVector(padUp, -vu);
    const v = V.length();
    const landing = track.pieces.find((q) => q.flightFrom === pad.uid && !isRing(q))?.uid ?? null;
    const fly = (sc) => cutAtRoad(flight(m, 0, { P: P.clone(), V: rest.clone().multiplyScalar(sc).addScaledVector(padUp, vu) }, 1), landing);
    const slow = fly(BAND_SLOW), fast = fly(1), near = fly(NEAR);
    const up = L?.U ? L.U.clone().applyMatrix4(rm) : padUp.clone(), fwd = L?.F ? L.F.clone().applyMatrix4(rm) : new THREE.Vector3(0, 0, -1).transformDirection(m);
    arcs.push({ ...slow, fast, near, from: pad.uid, host: pad.on, landing, lip: { m, launch: { P, V }, v }, up, fwd, fly });
  }
  // ONE ARC, RED, GLOWING (user, 2026-10-22: "two arcs is very confusing … make it red with a bit of bloom
  // so it reads well"): the full-speed flight — the one landings snap to. A flat line of constant screen
  // width (fat line), not a tube: the lit 0.35 m tube read as an object ("it looks weird being a tube"),
  // pink and fat up close, a hair far off. Unlit, so it opts into the selective bloom itself. The slower
  // edges stay computed for the notes, not drawn.
  for (const a of arcs) {
    const pts = a.fast.pts;
    if (pts.length < 2) continue;
    const g = new LineGeometry();
    g.setPositions(pts.flatMap((p) => [p.x, p.y, p.z]));
    const line = new Line2(g, ARC_MAT);
    line.computeLineDistances();
    arcGroup.add(line);
  }
}
const ARC_MAT = new THREE.Line2NodeMaterial({ color: 0xff2a3d, linewidth: 5 });
applyBloomMRT(ARC_MAT, color(0xff2a3d).mul(2));
/** A jump pad's flight, ended where it comes back DOWN onto a road (the one it left, or any). The road's
 * points are kept per refresh: the notes fly the arc again at up to 40 speeds per mouse move. */

function cutAtRoad(fl, landing = null) {
  const road = (roadCache ??= roadSamples());
  let apex = 0;
  fl.pts.forEach((q, i) => { if (q.y > fl.pts[apex].y) apex = i; });
  for (let i = apex + 1; i < fl.pts.length; i++) {
    const q = fl.pts[i];
    // (not on its own landing: the check that it catches the flight needs the arc to go through it)
    if (road.some((r) => r.uid !== landing && Math.abs(r.P.x - q.x) < 8 && Math.abs(r.P.z - q.z) < 8 && q.y - r.P.y < 0.3 && q.y - r.P.y > -3)) return { pts: fl.pts.slice(0, i + 1), tan: fl.tan.slice(0, i + 1) };
  }
  return fl;
}


// ---------- live checks: road overlap + flight corridors ----------
function roadSamples() {
  const out = [];
  for (const pc of track.pieces) {
    if (isRing(pc)) continue;
    const { b, t } = piece(pc.id, pcOE(pc));
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
  for (const p of track.pieces) for (const o of [p.parent, p.sideOf]) if (o != null) { neighbours.get(p.uid).add(o); neighbours.get(o)?.add(p.uid); }
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
  const chain = connectedUids();
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
      if (r.uid === a.landing || r.uid === a.from || r.uid === a.host) continue; // the flight's own lip (or pad's piece) and landing
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
    // THE LANDING ROAD, not only its first piece (user, 2026-10-23: "free to make any kind of tracks" — a
    // straight put before a platform became the landing, and the car coming down on the platform read as a
    // miss): the landing piece and up to 3 that follow it on the road, each with its own width
    const chain = [pc];
    for (let q = pc; chain.length < 4;) { q = track.pieces.find((x) => x.parent === q.uid && !isRing(x)); if (!q || !built.has(q.uid)) break; chain.push(q); }
    const segs = [], deck = [];
    for (const cp of chain) {
      const { b, t } = piece(cp.id, pcOE(cp));
      const M = built.get(cp.uid).M, hw = t.taper ? Math.max(t.taper.from, t.taper.to) : SECTIONS[t.section ?? "road"].hw;
      const d = b.rings.map((r) => { const f = deckFrame(r, hw); return { P: f.P.applyMatrix4(M), U: f.U.transformDirection(M) }; });
      for (let i = 0; i + 1 < d.length; i++) {
        const s0 = d[i], s1 = d[i + 1];
        const D = s1.P.clone().sub(s0.P), len = D.length();
        if (len < 1e-6) continue;
        const T = D.divideScalar(len), U = s0.U.clone().add(s1.U).normalize();
        segs.push({ P: s0.P, T, U, R: new THREE.Vector3().crossVectors(T, U).normalize(), len, hw });
      }
      deck.push(...d);
    }
    // THE DECK AS SEGMENTS between its rings: an arc point counts only if it is OVER the deck's footprint
    // — along a segment (its length, ± 3 m) and across it within its width. (A radius of hw round each
    // ring reached 24 m in FRONT of a wide platform's start: the car still rising before it read as "hits
    // it from below" — a level platform on an arc, 2026-10-21.)
    const lowest = Math.min(...deck.map((s) => s.P.y));
    const lands = (pts) => {
      let apex = 0;
      pts.forEach((p, i) => { if (p.y > pts[apex].y) apex = i; });
      let above = false; // the arc has been over the deck: coming down through it from there = landed
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        for (const s of segs) {
          const d = p.clone().sub(s.P);
          const along = d.dot(s.T);
          // (3 m of margin at the ends: a fitted landing starts exactly ON the near arc — the point just
          // before its start is where the arc arrives over it; 0.5 m flagged White 3's fitted landing)
          if (along < -3 || along > s.len + 3 || Math.abs(d.dot(s.R)) > Math.max(s.hw, 6)) continue;
          const h = d.dot(s.U);
          if (h >= -0.5) above = true; // over it, or ON it (a fitted landing starts exactly on the near arc)
          else if (above) return true; // came down onto the deck
          else if (h < -2) return false; // under the deck: it hits the landing from below
        }
        if (i > apex && p.y < lowest - 4) return false; // came down past it (rising below it is fine)
      }
      return false;
    };
    // every landing is a PRECISION target (2026-10-21): the full-speed flight has to come down on it;
    // a slower car falling short is the jump's challenge, not a fault
    if (!lands(a.fast.pts)) problems.misses.push({ uid: pc.uid });
  }
  for (const m of problems.misses) {
    const name = TILES[track.pieces.find((q) => q.uid === m.uid).id]?.label ?? "a landing";
    const fitted = track.pieces.find((q) => q.uid === m.uid).id.startsWith("fitted_landing_");
    if (track.pieces.find((q) => q.uid === m.uid).id.startsWith("catch_tube_")) { problems.messages.push(`"${name}": the full-speed car misses its mouth — Re-fit it to the jump`); continue; }
    problems.messages.push(`"${name}": the full-speed car misses it — ${fitted ? "Re-fit it to the jump" : "move it on the red arc or use a Fitted landing"}`);
  }
  // tint overlapping pieces: a red box around each
  for (const c of overlapBoxes.splice(0)) { scene.remove(c); disposeTree(c, true); }
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
  const on = roadUnder(ray.intersectObjects(trackGroup.children, true));
  if (on) return roadSnapAt(on.pc, tileBase, on.s, on.raw, rot.yaw);
  const hit = new THREE.Vector3();
  if (!ray.ray.intersectPlane(new THREE.Plane(UP, -FLOOR_Y), hit)) return null;
  const P = new THREE.Vector3(Math.round(hit.x / gridStep) * gridStep, FLOOR_Y, Math.round(hit.z / gridStep) * gridStep);
  return { type: "world", m: new THREE.Matrix4().makeRotationY(rot.yaw * DEG).setPosition(P) };
}
/** The test car in hand: on a road only (it drives from there), 2 m steps across, Q/E turn. */
function spawnSnap() {
  ray.setFromCamera(new THREE.Vector2((mouse.x / innerWidth) * 2 - 1, -(mouse.y / innerHeight) * 2 + 1), camera);
  const on = roadUnder(ray.intersectObjects(trackGroup.children, true));
  if (!on) return null;
  const sn = roadSnapAt(on.pc, SPAWN, on.s, on.raw, rot.yaw);
  const kmh = track.spawn?.kmh ?? 0;
  return { ...sn, note: `Test car · drives from here${kmh ? ` at ${kmh} km/h` : ", standing"}${rot.yaw ? ` · turned ${rot.yaw}°` : ""} · <kbd>Q</kbd>/<kbd>E</kbd> turn` };
}
/** The test car's frame on its road (null if its piece is gone). */
function spawnFrame() {
  const sp = track.spawn;
  const pc = sp && track.pieces.find((q) => q.uid === sp.on && !isRing(q));
  return pc && built.has(pc.uid) ? roadSnapAt(pc, SPAWN, sp.s, sp.lat, sp.yaw ?? 0).m : null;
}
/** The first road piece among ray hits, and where on it: distance along its path, offset across its deck. */
function roadUnder(hits) {
  for (const h of hits) {
    let o = h.object;
    while (o && o.userData.uid == null) o = o.parent;
    const pc = o && track.pieces.find((p) => p.uid === o.userData.uid && !isRing(p));
    if (!pc) continue;
    const { b, t } = piece(pc.id, pcOE(pc));
    const hw = SECTIONS[t.section ?? "road"].hw;
    const local = h.point.clone().applyMatrix4(built.get(pc.uid).M.clone().invert());
    let best = null, bd = Infinity;
    for (const r of b.rings) { if (r.air) continue; const d = r.p.distanceToSquared(local); if (d < bd) { bd = d; best = r; } }
    if (!best) continue;
    const f = deckFrame(best, hw);
    return { pc, s: best.s + local.clone().sub(f.P).dot(best.T), raw: local.clone().sub(f.P).dot(f.R) };
  }
  return null;
}
/**
 * AN OBSTACLE ON A PIECE (user, 2026-10-21: "everything easy to place … the builder is for the user"):
 * where it stands is the PIECE it is on, the distance ALONG that piece and the offset ACROSS — kept in the
 * prop (`on`, `s`, `lat`, `yaw`), and its frame re-laid from them at every rebuild, so an obstacle goes
 * where its piece goes (a road moved, a piece replaced or inserted before it, a landing re-fitted), a boost
 * pad takes the new shape under it, and deleting the piece deletes it. Placing and re-laying are this
 * one function: `raw` is the offset asked for, snapped here.
 */
function roadSnapAt(pc, kind, s, raw, yaw = 0) {
  const { b, t } = piece(pc.id, pcOE(pc));
  const M = built.get(pc.uid).M;
  const sec = SECTIONS[t.section ?? "road"], hw = sec.hw;
  const total = b.rings.at(-1).s;
  s = THREE.MathUtils.clamp(s, 0, total);
  const at = { on: pc.uid, s: +s.toFixed(2) };
  if (OBSTACLES[kind]?.decal) {
    const d = decalSnap(pc, b, t, M, s, raw, kind);
    return { ...d, extra: { ...d.extra, ...at, s: d.s, lat: d.lat } };
  }
  const rc = ringAt(b.rings, s), f = deckFrame(rc, hw);
  // a WALL · DOOR stays square across the road, its middle on the road's: only the door slides (1 m
  // steps, inside the kerbs)
  if (kind === "ob_wall_door") {
    const dx = THREE.MathUtils.clamp(Math.round(raw), -(hw - 5), hw - 5);
    const m = new THREE.Matrix4().makeBasis(f.R, f.U, rc.T.clone().negate()).setPosition(f.P);
    return { type: "road", m: M.clone().multiply(m), dx, hw, extra: { ...at, lat: dx }, note: `Door ${dx ? `${Math.abs(dx)} m ${dx > 0 ? "right" : "left"}` : "in the middle"}` };
  }
  const ext = Math.max(0, hw - 2 - (OBSTACLES[kind]?.halfW ?? 0)); // a slalom / gate keeps its poles on the road
  const lat = THREE.MathUtils.clamp(Math.round(raw / 2) * 2, -ext, ext);
  const m = new THREE.Matrix4().makeBasis(f.R, f.U, rc.T.clone().negate()).setPosition(f.P.clone().addScaledVector(f.R, lat));
  m.multiply(new THREE.Matrix4().makeRotationY(yaw * DEG));
  const side = lat ? `${Math.abs(lat)} m ${lat > 0 ? "right" : "left"}` : "in the middle";
  return { type: "road", m: M.clone().multiply(m), extra: { ...at, lat, ...(yaw ? { yaw } : {}) }, note: `${OBSTACLES[kind]?.label ?? "Obstacle"} · ${side} · ${Math.round(s)} m along the piece${yaw ? ` · turned ${yaw}°` : ""}` };
}
/** Whether an obstacle of this kind can be turned (Q/E): not a pad, a door or a gate — they lie square
 * to the road — nor a wall in the air (it faces its flight). */
const canTurn = (kind) => { const d = OBSTACLES[kind]; return !!d && !d.decal && !d.aimAt && !d.air; };
/** How an obstacle in hand is placed, in one line (the panel). */
function obstacleHow(kind) {
  const d = OBSTACLES[kind];
  if (d.air) return "on a jump's red arc";
  if (d.decal) return "on any road piece · slides across in 1 m steps";
  if (kind === "ob_wall_door") return "across a road · the door slides across in 1 m steps";
  if (d.aimAt) return "on a road · slides across in 2 m steps";
  return "on a road (2 m steps across) or the floor · <kbd>Q</kbd>/<kbd>E</kbd> turn";
}
const propOf = (uid) => (track.props ?? []).find((p) => p.uid === uid);
/** Re-lay every obstacle that stands on a piece (see roadSnapAt); one whose piece is gone goes too. */
function relayProps() {
  if (!track.props?.length) return;
  track.props = track.props.filter((p) => p.on == null || track.pieces.some((q) => q.uid === p.on && !isRing(q)));
  for (const p of track.props) {
    if (p.on == null) continue;
    const sn = roadSnapAt(track.pieces.find((q) => q.uid === p.on), p.kind, p.s, p.lat, p.yaw ?? 0);
    p.M = sn.m.toArray();
    if (sn.dx != null) { p.dx = sn.dx; p.hw = sn.hw; }
    if (sn.extra?.strip) p.strip = sn.extra.strip;
    p.lat = sn.extra.lat;
  }
}
/** A piece's path frame at distance s (rings interpolated): what deckFrame needs. */
function ringAt(rings, s) {
  let i = 0;
  while (i < rings.length - 2 && rings[i + 1].s < s) i++;
  const a = rings[i], b = rings[i + 1] ?? a, f = b.s > a.s ? THREE.MathUtils.clamp((s - a.s) / (b.s - a.s), 0, 1) : 0;
  return {
    p: a.p.clone().lerp(b.p, f), T: a.T.clone().lerp(b.T, f).normalize(), U: a.U.clone().lerp(b.U, f).normalize(),
    R: a.R.clone().lerp(b.R, f).normalize(), lean: a.lean + (b.lean - a.lean) * f, pivot: a.pivot, air: a.air || b.air, s,
  };
}
/**
 * A BOOST PAD on the road (obstacles.js BOOST_PAD): its middle where you point (1 m steps across, inside
 * the kerbs; along, kept on the piece), and its STRIP — the deck's left and right edge under it every
 * metre, lifted, in the pad's frame — so it lies on a curl or a bank instead of cutting through it.
 */
function decalSnap(pc, b, t, M, s0, raw, kind) {
  const { w, L, lift } = BOOST_PAD;
  const sec = SECTIONS[t.section ?? "road"], hw = sec.hw;
  const total = b.rings.at(-1).s;
  if (total < L) return { type: "road", m: M.clone(), bad: "This piece is shorter than a pad" };
  s0 = THREE.MathUtils.clamp(Math.round(s0), L / 2, total - L / 2);
  const room = Math.max(0, hw - sec.kerbW - w / 2 - 0.3);
  const lat = THREE.MathUtils.clamp(Math.round(raw), -Math.floor(room), Math.floor(room));
  const rc = ringAt(b.rings, s0), fc = deckFrame(rc, hw);
  const local = new THREE.Matrix4().makeBasis(fc.R, fc.U, rc.T.clone().negate()).setPosition(fc.P.clone().addScaledVector(fc.R, lat));
  const inv = local.clone().invert();
  const strip = [];
  let air = false;
  for (let k = 0; k <= L; k++) {
    const rk = ringAt(b.rings, s0 - L / 2 + k), fk = deckFrame(rk, hw);
    air ||= rk.air;
    const row = [];
    for (const side of [-1, 1]) {
      const q = fk.P.clone().addScaledVector(fk.R, lat + side * w / 2).addScaledVector(fk.U, lift).applyMatrix4(inv);
      row.push(+q.x.toFixed(3), +q.y.toFixed(3), +q.z.toFixed(3));
    }
    strip.push(row);
  }
  return {
    type: "road", m: M.clone().multiply(local), extra: { strip }, strip, s: s0, lat,
    bad: air ? "Not over a gap" : null,
    note: `${OBSTACLES[kind]?.label ?? "Pad"} · ${lat ? `${Math.abs(lat)} m ${lat > 0 ? "right" : "left"}` : "in the middle"} · ${Math.round(s0)} m along the piece`,
  };
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
/**
 * THE WALL WITH A HOLE IN THE AIR (Apex Rush plan step 5): upright, facing the flight (its horizontal
 * heading), the hole's centre on the FULL-SPEED arc where you point. The note says which take-off speeds
 * fly through (each flown, 1% steps): the car's half size inside the hole's edges.
 */
function wallHoleSnap() {
  let best = null;
  for (const a of arcs) for (let k = 3; k < a.fast.pts.length; k++) {
    const sp = toScreen(a.fast.pts[k]);
    if (!sp) continue;
    const d = Math.hypot(sp.x - mouse.x, sp.y - mouse.y);
    if (d < 40 && (!best || d < best.d)) best = { a, k, d };
  }
  if (!best) return null;
  const { a, k } = best;
  const h = new THREE.Vector3(a.fast.tan[k].x, 0, a.fast.tan[k].z).normalize();
  const R = new THREE.Vector3().crossVectors(h, UP).normalize();
  const P = a.fast.pts[k];
  const m = socketMatrix({ p: P, T: h, U: UP.clone(), R });
  const [hx0, hx1, hy0, hy1] = HOLE.hole;
  const through = (sc) => {
    const { pts } = a.fly(sc);
    for (let i = 1; i < pts.length; i++) {
      const d0 = pts[i - 1].clone().sub(P).dot(h), d1 = pts[i].clone().sub(P).dot(h);
      if (d0 < 0 && d1 >= 0) {
        const q = pts[i - 1].clone().lerp(pts[i], -d0 / (d1 - d0)).sub(P);
        const x = q.dot(R), y = q.y;
        return x > hx0 + 1.2 && x < hx1 - 1.2 && y > hy0 + 0.8 && y < hy1 - 0.8;
      }
    }
    return false;
  };
  let sMin = 1;
  for (let sc = 0.99; sc >= 0.8 - 1e-9 && through(sc); sc -= 0.01) sMin = sc;
  const kmh = (sc) => Math.round(a.lip.v * sc * 3.6);
  const guess = !prediction.lipSpeed.has(a.from);
  return { type: "arc", m, from: a.from, note: guess ? "Wall · hole: on the full-speed line (the take-off isn't measured yet)" : `Wall · hole: flies through from ${kmh(sMin)} to ${kmh(1)} km/h — slower hits the wall under the hole` };
}
/**
 * THE CATCH TUBE ON A JUMP. A tube in the air is a PRECISION target: the band (85–100% of the take-off
 * speed) spreads 20 m+ apart vertically by then — no 16 m mouth catches it all (measured: every spot on a
 * kicker's arc had the fast car 23–37 m over a floor laid on the slow one). So the mouth aims at the
 * FULL-SPEED flight (the real car's measured take-off), its floor CATCH_BELOW under it, at the height you
 * point at; the builder reports which take-off speeds get in (flown exactly, 1% steps), and the slope
 * runs until the full-speed car is down on it (+12 m), like a fitted landing.
 */
const CATCH_BELOW = 5; // m: the full-speed car crosses the mouth this far above its floor
function catchSnap(a, y) {
  const fast = a.fast;
  let k = -1;
  for (let i = 3; i < fast.pts.length; i++) if (fast.tan[i].y < -0.02 && fast.pts[i].y <= y) { k = i; break; }
  if (k < 0) return { type: "arc", m: new THREE.Matrix4(), from: a.from, bad: "The full-speed car never comes down to this height" };
  const Pf = fast.pts[k], Tf = fast.tan[k];
  const fall = Math.asin(THREE.MathUtils.clamp(-Tf.y, -1, 1)) / DEG;
  const angle = THREE.MathUtils.clamp(Math.round(fall / 5) * 5, 10, 45);
  const h = new THREE.Vector3(Tf.x, 0, Tf.z).normalize();
  const T = h.clone().multiplyScalar(Math.cos(angle * DEG)).setY(-Math.sin(angle * DEG));
  const R = new THREE.Vector3().crossVectors(T, UP).normalize();
  const U = new THREE.Vector3().crossVectors(R, T);
  const P0 = Pf.clone().addScaledVector(U, -CATCH_BELOW);
  // where a flight crosses the mouth (the plane through P0 across T), and how high over the floor
  const atMouth = (pts) => {
    for (let i = 1; i < pts.length; i++) {
      const a0 = pts[i - 1].clone().sub(P0).dot(T), a1 = pts[i].clone().sub(P0).dot(T);
      if (a0 < 0 && a1 >= 0) {
        const q = pts[i - 1].clone().lerp(pts[i], -a0 / (a1 - a0)).sub(P0);
        return { h: q.dot(U), side: q.dot(R) };
      }
    }
    return null;
  };
  const inside = (c) => c && c.h >= 0.5 && c.h <= TUBE_ROOF - ROOF_CLEAR && Math.abs(c.side) <= 12;
  let sMin = 1;
  for (let s = 1; s >= BAND_SLOW - 1e-9; s -= 0.01) {
    if (!inside(atMouth(a.fly(s).pts))) break;
    sMin = s;
  }
  // the slope: until the full-speed car is down on it, + 12 m; and never over the roof on the way
  let D = 24, over = 0;
  for (const q of fast.pts) {
    const rel = q.clone().sub(P0), along = rel.dot(T);
    if (along < 0) continue;
    over = Math.max(over, rel.dot(U));
    if (rel.dot(U) <= 0) { D = along + 12; break; }
  }
  D = Math.max(24, Math.ceil(D / 4) * 4);
  catchId = ensureTile(`catch_tube_${angle}_${D}`).id;
  const m = socketMatrix({ p: P0, T, U, R });
  const kmh = (s) => Math.round(a.lip.v * s * 3.6);
  const bad = over > TUBE_ROOF - ROOF_CLEAR ? `The full-speed car rises ${Math.round(over)} m over the floor inside: it hits the roof — point lower` : null;
  const guess = !prediction.lipSpeed.has(a.from);
  const note = guess
    ? "Catch tube · the take-off isn't measured yet (the test lap is running): place it, then Re-fit it to the jump"
    : `Catch tube · gets in from ${kmh(sMin)} to ${kmh(1)} km/h${sMin > 0.97 ? " (a near-perfect take-off)" : ""} · ends level in a pipe: a Tube piece next`;
  return { type: "arc", m, from: a.from, bad, note };
}
// PRECISION LANDINGS (user, 2026-10-21: "the car after a jump lands at the BEGINNING of the track in the
// air … if not enough speed he falls"; a landing that started long before was "too easy, not cool"):
// every landing starts where a car at NEAR × full speed comes down (a slope laid on the full-speed arc
// itself left 0 margin: 1% slower arrived under its start) — slower than that falls short
const NEAR = 0.95;
const LAND_LEAD = 4; // m: a level piece starts this far before that touchdown
/** The lowest take-off speed (× the measured one) whose flight still CLEARS the start edge of a deck
 * starting at P0 heading T: over P0's spot (along the horizontal heading) it is no lower than P0 — then
 * it comes down on the deck; lower, it hits the edge or passes under it and falls short. */
function reachScale(a, P0, T) {
  const h = new THREE.Vector3(T.x, 0, T.z).normalize();
  let sMin = 1;
  for (let sc = 1; sc >= 0.6 - 1e-9; sc -= 0.01) {
    const { pts } = a.fly(sc);
    let y = -Infinity;
    for (let i = 1; i < pts.length; i++) {
      const d0 = pts[i - 1].clone().sub(P0).dot(h), d1 = pts[i].clone().sub(P0).dot(h);
      if (d0 < 0 && d1 >= 0) { y = THREE.MathUtils.lerp(pts[i - 1].y, pts[i].y, -d0 / (d1 - d0)); break; }
    }
    if (y < P0.y - 0.5) break;
    sMin = sc;
  }
  return sMin;
}
/** Where `arc` ({pts, tan}) comes down through height y on its falling part: { p, T, fall (°) } or null. */
function downAt(arc, y) {
  for (let k = 1; k < arc.pts.length; k++) {
    if (arc.pts[k - 1].y >= y && arc.pts[k].y < y && arc.tan[k].y < 0) {
      const f = (arc.pts[k - 1].y - y) / (arc.pts[k - 1].y - arc.pts[k].y);
      const T = arc.tan[k - 1].clone().lerp(arc.tan[k], f).normalize();
      return { p: arc.pts[k - 1].clone().lerp(arc.pts[k], f), T, fall: Math.asin(THREE.MathUtils.clamp(-T.y, -1, 1)) / DEG };
    }
  }
  return null;
}
/** The builder's line about it. */
const reachNote = (a, sMin) => `lands from ${Math.round(a.lip.v * sMin * 3.6)} km/h (full speed ${Math.round(a.lip.v * 3.6)}) — slower falls short`;
const ROUGH_FALL = 22; // °: steeper than this onto flat needs the player to level the car (else rough)
function computeSnap() {
  if (tileBase === SPAWN) return spawnSnap();
  if (tileBase === RING) return ringSnap();
  if (OBSTACLES[tileBase]?.air) return wallHoleSnap();
  if (isObstacle(tileBase)) return obstacleSnap();
  // a pasted SECTION snaps like its first piece
  const id = tileBase === STAMP ? stampItems()[0]?.id : tileId(tileBase);
  const t = TILES[id];
  let best = null;
  // A LANDING in hand goes on a flight arc first: next to its lip, a short drop's whole arc sat inside
  // the open end's 60 px and the landing could only snap to the end (seen building, 2026-10-19)
  const landingInHand = !!t?.landAngle || tileBase === FITTED || tileBase === CATCH;
  if (freeHold && !landingInHand && tileBase !== STAMP) return gridSnap(t); // Alt: exactly where you point
  const onArc = landingInHand && arcs.some((a) => a.fast.pts.some((p, k) => {
    if (k < 3 || a.fast.tan[k].y > -0.02) return false;
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
  // the mouse near an end's EDGE, all across it — not only its middle: a 48 m platform's end was missed
  // pointing at its side half ("after a platform landing I cannot snap other pieces to it", 2026-10-21)
  if (!onArc && !TILES[id]?.start) for (const e of openEnds()) {
    const et = TILES[track.pieces.find((q) => q.uid === e.uid)?.id] ?? {};
    const ehw = et.taper ? et.taper.to : SECTIONS[et.section ?? "road"].hw;
    const a = toScreen(new THREE.Vector3(-ehw, 0, 0).applyMatrix4(e.m)), c = toScreen(new THREE.Vector3(ehw, 0, 0).applyMatrix4(e.m));
    if (!a || !c) continue;
    const ab = { x: c.x - a.x, y: c.y - a.y }, tA = THREE.MathUtils.clamp(((mouse.x - a.x) * ab.x + (mouse.y - a.y) * ab.y) / Math.max(1e-6, ab.x * ab.x + ab.y * ab.y), 0, 1);
    const d = Math.hypot(a.x + ab.x * tA - mouse.x, a.y + ab.y * tA - mouse.y);
    if (d < 60 && (!best || d < best.d)) {
      best = { type: "end", m: e.m.clone(), parent: e.uid, d, end: e };
      // OFF-CENTRE ON A WIDER END (user, 2026-10-22, Apex Rush shot 4: a quarter pipe off to one side of a
      // platform): the piece goes where you point along the end, in 2 m steps, its edge inside the end's
      const room = ehw - SECTIONS[t?.section ?? "road"].hw;
      if (t && tileBase !== STAMP && room >= 2) {
        const off = THREE.MathUtils.clamp(Math.round((-ehw + 2 * ehw * tA) / 2) * 2, -Math.floor(room), Math.floor(room));
        if (off) { best.off = off; best.m.multiply(new THREE.Matrix4().makeTranslation(off, 0, 0)); best.note = `${Math.abs(off)} m ${off > 0 ? "right" : "left"} of the end's middle`; }
      }
    }
  }
  // THE BACK OF A ROAD (user, 2026-10-23: "why can't I place a piece of road before the platform I just
  // placed?" — and: "the editor should make the user feel as free as possible"): a road's FIRST piece takes
  // a piece in front of it, this piece's END on its start. A landing hands its link to the jump
  // (flightFrom) to the new first piece. (Not before a Start: it is closed there.)
  if (!onArc && !best && t && !t.start && !t.finish && !t.closed && tileBase !== STAMP && tileBase !== FITTED && tileBase !== CATCH && tileBase !== FITTED_BOWL) {
    let hb = null;
    for (const pc of track.pieces) {
      if (isRing(pc) || pc.parent != null || pc.sideOf != null || !built.has(pc.uid)) continue;
      const ht = TILES[pc.id];
      if (!ht || ht.start) continue;
      const hM = built.get(pc.uid).M;
      const hhw = ht.taper ? ht.taper.from : SECTIONS[ht.section ?? "road"].hw;
      const a = toScreen(new THREE.Vector3(-hhw, 0, 0).applyMatrix4(hM)), c = toScreen(new THREE.Vector3(hhw, 0, 0).applyMatrix4(hM));
      if (!a || !c) continue;
      const ab = { x: c.x - a.x, y: c.y - a.y }, tA = THREE.MathUtils.clamp(((mouse.x - a.x) * ab.x + (mouse.y - a.y) * ab.y) / Math.max(1e-6, ab.x * ab.x + ab.y * ab.y), 0, 1);
      const d = Math.hypot(a.x + ab.x * tA - mouse.x, a.y + ab.y * tA - mouse.y);
      if (d < 60 && (!hb || d < hb.d)) hb = { pc, d, hM };
    }
    if (hb) {
      const m = hb.hM.clone().multiply(piece(id, oeOf(edges)).exitLocal.clone().invert());
      const want = leanIn(TILES[hb.pc.id]), have = leanOut(t);
      const bad = Math.abs(deg(want) - deg(have)) > 3 ? `That road starts ${want ? `leaning ${Math.abs(deg(want))}°` : "flat"}; this piece ends ${have ? `leaning ${Math.abs(deg(have))}°` : "flat"}` : null;
      return { type: "end", m, prepend: hb.pc.uid, bad, note: `Before ${TILES[hb.pc.id].label}${hb.pc.flightFrom != null ? " · it becomes the landing (the jump's arc lands on it)" : ""}` };
    }
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
  // BESIDE A PIECE (user, 2026-10-21, Apex Rush: pieces side by side make wide roads, 2×2 platforms, wide
  // jump areas): held near the left or right side of a placed piece, the piece in hand lies FLUSH against
  // it — the same start, the same height, offset by both half widths. Flat-starting pieces only (a bank
  // would need the offset along its tilted deck); not tubes / half-pipes (round, nothing to lay against).
  const sideOk = (tt) => tt && !tt.tube && !tt.halfpipe && !tt.landAngle && Math.abs(leanIn(tt)) < 1e-3;
  if (sideOk(t) && tileBase !== STAMP) {
    const hwB = SECTIONS[t.section ?? "road"].hw;
    const box = piece(id, oeOf(edges)).look.deck;
    if (!box.boundingBox) box.computeBoundingBox();
    const mid = box.boundingBox.getCenter(new THREE.Vector3());
    let sb = null;
    for (const pc of track.pieces) {
      if (isRing(pc) || !built.has(pc.uid) || !sideOk(TILES[pc.id])) continue;
      const hwA = SECTIONS[TILES[pc.id].section ?? "road"].hw;
      for (const side of [-1, 1]) {
        const m = built.get(pc.uid).M.clone().multiply(new THREE.Matrix4().makeTranslation(side * (hwA + hwB), 0, 0));
        const s = toScreen(mid.clone().applyMatrix4(m));
        if (!s) continue;
        const d = Math.hypot(s.x - mouse.x, s.y - mouse.y);
        if (d < 50 && (!sb || d < sb.d)) sb = { type: "side", m, sideOf: pc.uid, side, d, note: `Beside ${TILES[pc.id].label} (${side > 0 ? "right" : "left"}) · the rails between them come off` };
      }
    }
    if (sb) return sb;
  }
  // (on the FULL-SPEED arc, the red one: a landing starts where the fast car comes down)
  // A RAMP in hand (its own end points up: a kicker, a launch) also goes on the RISING half (user,
  // 2026-10-23: "place pieces all along the arc") — it meets the car still climbing: ramp to ramp
  const rampInHand = !!t && new THREE.Vector3(0, 0, -1).transformDirection(piece(id).exitLocal).y > Math.sin(3 * DEG) && !t.landAngle;
  for (const a of arcs) for (let k = 3; k < a.fast.pts.length; k++) {
    const rising = a.fast.tan[k].y > 0.03;
    if (a.fast.tan[k].y > -0.02 && !(rising && rampInHand)) continue; // the falling part (a ramp: the rising one too)
    const s = toScreen(a.fast.pts[k]);
    if (!s) continue;
    const d = Math.hypot(s.x - mouse.x, s.y - mouse.y);
    if (d < 30 && (!best || d < best.d)) best = { a, k, d, rising };
  }
  if (best?.rising) {
    // RAMP TO RAMP: the piece's start on the full-speed line, along it — the car meets it climbing
    const P0 = best.a.fast.pts[best.k].clone(), T = best.a.fast.tan[best.k].clone();
    const R = new THREE.Vector3().crossVectors(T, UP).normalize(), U = new THREE.Vector3().crossVectors(R, T);
    const m = socketMatrix({ p: P0, T, U, R });
    if (rot.roll) m.multiply(new THREE.Matrix4().makeRotationZ(rot.roll * DEG));
    const climb = Math.asin(THREE.MathUtils.clamp(T.y, -1, 1)) / DEG;
    const own = Math.asin(THREE.MathUtils.clamp(new THREE.Vector3(0, 0, -1).transformDirection(piece(id).exitLocal).y, -1, 1)) / DEG;
    return { type: "arc", m, from: best.a.from, bad: leanIn(t) ? "It must start flat (lean 0)" : null,
      note: `Ramp to ramp · meets the full-speed car climbing ${Math.round(climb)}° · launches at ~${Math.round(climb + own)}° · a slower car passes under it` };
  }
  // LAND ON ANY PIECE (user, 2026-10-21: "this game is about jumps … large platforms to land"): a road
  // piece that isn't a landing — a platform, a straight, a turn… — goes LEVEL at the height you point at
  // on the arc, heading the way the car flies, its start a few metres before the SLOW car touches down;
  // linked to the jump like a landing (flightFrom: the test lap flies onto it). It warns when the FAST
  // car lands past its end, and when the touchdown is steep on flat (rough: a landing slope keeps speed).
  // Tubes and halfpipes don't: the car would fall onto their roof or rim (a catch tube is its own piece).
  if (best && !t.landAngle && tileBase !== FITTED && tileBase !== CATCH && !t.tube && !t.halfpipe) {
    const a = best.a, y0 = a.fast.pts[best.k].y;
    // where an arc comes down through height y0 (on its falling part)
    const cross = (pts) => {
      for (let k = 1; k < pts.length; k++) {
        if (pts[k - 1].y >= y0 && pts[k].y < y0) {
          const f = (pts[k - 1].y - y0) / (pts[k - 1].y - pts[k].y);
          const p = pts[k - 1].clone().lerp(pts[k], f), d = pts[k].clone().sub(pts[k - 1]).normalize();
          return { p, fall: Math.asin(THREE.MathUtils.clamp(-d.y, -1, 1)) / DEG };
        }
      }
      return null;
    };
    const fast = cross(a.fast.pts) ?? { p: a.fast.pts[best.k].clone(), fall: Math.asin(THREE.MathUtils.clamp(-a.fast.tan[best.k].y, -1, 1)) / DEG };
    const near = cross(a.near.pts) ?? fast;
    const h = new THREE.Vector3(a.fast.tan[best.k].x, 0, a.fast.tan[best.k].z).normalize();
    const start = near.p.clone().addScaledVector(h, -LAND_LEAD);
    start.y = y0;
    const m = socketMatrix({ p: start, T: h, U: UP.clone(), R: new THREE.Vector3().crossVectors(h, UP).normalize() });
    if (rot.roll) m.multiply(new THREE.Matrix4().makeRotationZ(rot.roll * DEG));
    // (the full-speed car must come down on it too: a short piece under a long jump)
    const ex = new THREE.Vector3().setFromMatrixPosition(piece(id).exitLocal);
    const fastAt = fast.p.clone().sub(start).dot(h);
    const notes = [`level landing · touchdown ${Math.round(fast.fall)}°`, reachNote(a, reachScale(a, start, h))];
    if (fastAt > Math.hypot(ex.x, ex.z) - 4) notes.push(`the full-speed car lands ${Math.round(fastAt)} m on, past this piece — use a longer one`);
    // (the game grades by the car's angle to the surface — landing.js — and the player can level it in the air)
    if (fast.fall > ROUGH_FALL) notes.push(`steep onto flat (${Math.round(fast.fall)}°): level the car in the air, or use a landing slope`);
    const roll = rollNote(a, m, leanIn(t));
    if (roll) notes.push(roll);
    return { type: "arc", m, from: a.from, bad: leanIn(t) ? "A landing must start flat (lean 0)" : null, note: notes.join(" · ") };
  }
  if (best) {
    // a landing slides along the arc to where the fall angle equals its own → its exit comes out level
    // (not the FITTED landing: it takes the angle of the arc where you point — land at any depth)
    // A FIXED-SLOPE LANDING (user, 2026-10-23: "some even snap at one position in the arc"): it goes where
    // you point on the falling half, its own slope kept (its exit stays level); within 3° of the spot where
    // the car falls at exactly its angle it clicks there (the PERFECT spot), and the panel says how far off
    // a landing elsewhere meets the car
    let landOff = null;
    if (t.landAngle && tileBase !== FITTED && tileBase !== CATCH) {
      const want = t.landAngle * DEG;
      let kBest = best.k, err = Infinity;
      for (let k = 3; k < best.a.near.pts.length; k++) {
        const fall = Math.asin(THREE.MathUtils.clamp(-best.a.near.tan[k].y, -1, 1));
        if (fall > 0 && Math.abs(fall - want) < err) { err = Math.abs(fall - want); kBest = k; }
      }
      const here = downAt(best.a.near, best.a.fast.pts[best.k].y);
      if (!here || Math.abs(here.fall - t.landAngle) <= 3) best.k = kBest;
      else {
        const h = new THREE.Vector3(here.T.x, 0, here.T.z).normalize();
        const T = h.multiplyScalar(Math.cos(want)).add(new THREE.Vector3(0, -Math.sin(want), 0));
        landOff = { p: here.p, T, diff: here.fall - t.landAngle };
      }
    }
    if (tileBase === CATCH) return catchSnap(best.a, best.a.fast.pts[best.k].y);
    if (tileBase === FITTED) {
      // FITTED LANDING (fittedOnArc): the slope at the arc's own fall angle where you point (5° steps,
      // 10–45°), from where the NEAR-speed car comes down at that height until the FAST one is down too.
      // Leaned by the land tilt (not the Bank: that would leave its exit banked too)
      const f = fittedOnArc(best.a, best.k, landTilt);
      fittedId = f.id;
      const ft = TILES[f.id];
      const roll = rollNote(best.a, f.m, ft.tilt ?? 0);
      return { type: "arc", m: f.m, from: best.a.from, note: `${ft.label} · ${reachNote(best.a, reachScale(best.a, f.P0, f.T))}${roll ? ` · ${roll}` : landTilt ? " · the car already flies at that tilt" : ""}${landTilt ? "" : " · ← / → tilt it"}` };
    }
    // (a landing piece: best.k now on the NEAR arc, slid to its own angle; anything else at the pointed height)
    const nn = landOff ?? (t.landAngle ? { p: best.a.near.pts[best.k], T: best.a.near.tan[best.k] } : downAt(best.a.near, best.a.fast.pts[best.k].y) ?? { p: best.a.fast.pts[best.k], T: best.a.fast.tan[best.k] });
    const T = nn.T.clone();
    const R = new THREE.Vector3().crossVectors(T, UP).normalize();
    const U = new THREE.Vector3().crossVectors(R, T);
    const P0 = nn.p.clone();
    const m = socketMatrix({ p: P0, T, U, R });
    if (rot.roll) m.multiply(new THREE.Matrix4().makeRotationZ(rot.roll * DEG));
    const roll = rollNote(best.a, m, leanIn(t));
    const off = landOff ? `the car falls ${Math.round(Math.abs(landOff.diff))}° ${landOff.diff > 0 ? "steeper" : "flatter"} than this ${t.landAngle}° slope — ${Math.abs(landOff.diff) <= 6 ? "still perfect if it lands flat" : `pitch the nose ${landOff.diff > 0 ? "up" : "down"} in the air to land it perfect`}` : t.landAngle ? `on the perfect spot: the car falls at ${t.landAngle}°` : null;
    return { type: "arc", m, from: best.a.from, bad: leanIn(t) ? "A landing must start flat (lean 0)" : null, note: [off, reachNote(best.a, reachScale(best.a, P0, T)), roll].filter(Boolean).join(" · ") };
  }
  return gridSnap(t);
}
/** On the build plane (the height you set), on the world or the local grid. */
function gridSnap(t) {
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
// WHERE A FLOATING PIECE IS (user, 2026-10-21: "what's missing to place pieces freely"): a piece in hand
// that floats (on the grid, Alt free, on a jump's arc) gets a thin line down to what is under it — a road
// or the floor — and a ring where it lands; the panel says how high and how far from the nearest end.
const dropMat = new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 1.2, gapSize: 0.8, transparent: true, opacity: 0.7, depthTest: false });
const dropLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, -1, 0)]), dropMat);
const dropRing = new THREE.Mesh(new THREE.RingGeometry(1.6, 2.1, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7, depthTest: false, side: THREE.DoubleSide }));
dropLine.renderOrder = dropRing.renderOrder = 11;
dropLine.visible = dropRing.visible = false;
scene.add(dropLine, dropRing);
function updateDrop() {
  const floating = snap && !snap.bad && ["world", "local", "arc"].includes(snap.type);
  dropLine.visible = dropRing.visible = !!floating;
  if (!floating) { if (snap) snap.where = null; return; }
  const P = new THREE.Vector3().setFromMatrixPosition(snap.m);
  // what is under it: the first road piece (not the ghost: it is not in trackGroup), else the floor
  const hit = new THREE.Raycaster(P.clone().add(new THREE.Vector3(0, 0.5, 0)), new THREE.Vector3(0, -1, 0), 0, 5000).intersectObjects(trackGroup.children, true)[0];
  const G = hit ? hit.point : new THREE.Vector3(P.x, FLOOR_Y, P.z);
  dropLine.geometry.setFromPoints([P, G]);
  dropLine.computeLineDistances();
  dropRing.position.copy(G).add(new THREE.Vector3(0, 0.05, 0));
  const ends = openEnds().map((e) => new THREE.Vector3().setFromMatrixPosition(e.m));
  const near = ends.sort((a, b) => a.distanceTo(P) - b.distanceTo(P))[0];
  const dh = near ? Math.round(P.y - near.y) : 0;
  snap.where = `${Math.round(P.y - G.y)} m above ${hit ? "the road under it" : "the floor"}` +
    (near ? ` · ${Math.round(Math.hypot(P.x - near.x, P.z - near.z))} m from the nearest end${dh ? `, ${Math.abs(dh)} m ${dh > 0 ? "higher" : "lower"}` : ", same height"}` : "");
}
const ownGeo = (m) => { m.userData.ownGeo = true; return m; };
// THE SNAP ONLY WHEN SOMETHING IT READS CHANGED (performance pass, 2026-10-23: every frame with a piece in
// hand re-ran it — a landing over an arc flew up to 41 test flights × 1200 steps a frame, the mouse still)
let snapKey = "";
const _cm = new THREE.Matrix4();
function snapInputs() {
  _cm.copy(camera.matrixWorld);
  return [mouse.x, mouse.y, tileBase, hand, edges, rot.yaw, rot.pitch, rot.roll, buildY, gridMode, gridStep, arcSpeed, landTilt, freeHold, bowlR,
    ADJUSTABLE[tileBase] ? JSON.stringify(adjParams[tileBase]) : "", tileBase === STAMP ? clipboard?.n : "", trackVer, track.spawn?.kmh,
    _cm.elements.map((x) => x.toFixed(3)).join(",")].join("|");
}
function updateGhost() {
  if (!tileBase || !mouse.inside) { snapKey = ""; if (ghost) ghost.visible = false; snap = null; updateDrop(); renderStatus(); return; }
  const k = snapInputs();
  if (k === snapKey && !ghostDirty) { renderStatus(); return; } // nothing moved: the snap, the drop line and the ghost stand (the panel still follows the test lap)
  snapKey = k;
  snap = computeSnap();
  updateDrop();
  if (!snap) { if (ghost) ghost.visible = false; renderStatus(); return; }
  const id = tileId(tileBase);
  const key = `${id}|${hand}|${edges}|${snap.type}|${!!snap.bad}|${snap.dx}|${snap.hw}|${snap.strip ? JSON.stringify(snap.strip[0]) + JSON.stringify(snap.strip.at(-1)) : ""}|${snap.m.elements.map((x) => x.toFixed(3)).join(",")}`;
  if (key !== lastKey || ghostDirty) {
    lastKey = key; ghostDirty = false;
    // the old preview's OWN geometry released (tagged ownGeo: a ring, a pad strip, the stand-in box — not
    // the shared piece / car / obstacle shapes it otherwise shows)
    if (ghost) { scene.remove(ghost); ghost.traverse((o) => { if (o.userData.ownGeo) o.geometry.dispose(); }); }
    ghost = id === SPAWN ? (carHolo ? new THREE.Mesh(carHolo.geometry, ghostMat) : ownGeo(new THREE.Mesh(new THREE.BoxGeometry(2, 1.2, 4.4).translate(0, 0.6, 0), ghostMat)))
      : id === STAMP ? stampGhost()
      : isObstacle(id) ? (OBSTACLES[id].decal ? ownGeo : (m) => m)(new THREE.Mesh(shapeOf(id, snap).ghost, ghostMat)) // (a pad's strip is new each time; a door's is cached)
      : id === RING ? ownGeo(makeRingMesh({ P: new THREE.Vector3(), T: new THREE.Vector3(0, 0, -1), U: new THREE.Vector3(0, 1, 0), hw: RING_R }, { material: ghostMat }).children[0])
      : new THREE.Mesh(piece(id, oeOf(edges)).look.deck, ghostMat);
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
  if (end.pitch > 3 * DEG || TILES[track.pieces.find((p) => p.uid === end.uid)?.id]?.drop) return { label: "Lip · land it on the arc", items: [FITTED, CATCH, "banked_landing_20", "landing_turn_20", "catch_pad", "platform_64"].map((b) => ({ base: b, h: hand, id: tileId(b) })) };
  return recent.length ? { label: "Again", items: recent.slice(0, 4) } : null;
}
let nextKey = "";
let nextInputs = "";
function updateNext() {
  const el = $("next");
  // only when the track, the camera, the selection or the piece in hand changed (it scanned every open end a frame)
  _cm.copy(camera.matrixWorld);
  const ki = `${trackVer}|${sel}|${tileBase}|${hand}|${innerWidth}x${innerHeight}|${_cm.elements.map((x) => x.toFixed(3)).join(",")}`;
  if (ki === nextInputs) return;
  nextInputs = ki;
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
  if (id === SPAWN) {
    track.nextUid--;
    track.spawn = { on: snap.extra.on, s: snap.extra.s, lat: snap.extra.lat, yaw: snap.extra.yaw ?? 0, kmh: track.spawn?.kmh ?? 0 };
    tileBase = null; // one test car: placed, the tool is put down
    renderDock();
    rebuild();
    return;
  }
  if (id === RING) {
    track.pieces.push({ uid, id, ring: true, cp: true, M: snap.m.toArray(), parent: null, flightFrom: snap.from });
    rebuild();
    return;
  }
  if (isObstacle(id)) {
    (track.props ??= []).push({ uid, kind: id, M: snap.m.toArray(), ...(snap.from != null ? { from: snap.from } : {}), ...(snap.dx != null ? { dx: snap.dx, hw: snap.hw } : {}), ...(snap.extra ?? {}) });
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
    // BEFORE a road's first piece (a Start, or any piece at the back of a road): in the list just before it
    // (rebuild lays each piece on its parent), the old first piece now hangs off it; a landing hands its
    // jump link (flightFrom) to the new first piece
    const hi = track.pieces.findIndex((p) => p.uid === snap.prepend);
    const head = track.pieces[hi];
    track.pieces.splice(hi, 0, { uid, id, ...railFields(edges), M: snap.m.toArray(), parent: null, flightFrom: head.flightFrom ?? null });
    head.parent = uid;
    head.flightFrom = null;
  } else if (snap.type === "side") {
    // laid beside: no rail BETWEEN the two decks — the new piece keeps its outer side, the neighbour loses
    // its rail on the joined side (Rails: None stays none)
    const outer = snap.side > 0 ? "R" : "L", joined = snap.side > 0 ? "R" : "L", other = snap.side > 0 ? "L" : "R";
    const mine = edges === true ? outer : edges === outer ? outer : false;
    track.pieces.push({ uid, id, ...railFields(mine), M: snap.m.toArray(), parent: null, flightFrom: null, sideOf: snap.sideOf });
    const nb = track.pieces.find((q) => q.uid === snap.sideOf);
    const ne = edgesOf(nb);
    const keep = ne === true ? other : ne === joined ? false : ne;
    delete nb.rail;
    Object.assign(nb, railFields(keep));
  } else track.pieces.push({ uid, id, ...railFields(edges), M: snap.m.toArray(), parent: snap.type === "end" ? snap.parent : null, flightFrom: snap.type === "arc" ? snap.from : null, ...(snap.type === "end" && snap.off ? { off: snap.off } : {}) });
  const ri = recent.findIndex((r) => r.id === id);
  if (ri >= 0) recent.splice(ri, 1);
  recent.unshift({ base: tileBase, h: hand, id });
  rebuild();
  const exit = new THREE.Vector3().setFromMatrixPosition(built.get(uid).exit);
  buildY = Math.round(exit.y / 2) * 2;
  glide = exit;
}
function removePiece(uid) { removeMany([uid]); }
// ---------- SPLIT AND JOIN ROADS (user, 2026-10-21: "what's missing to place pieces freely") ----------
// SPLIT (K): the selected piece starts a road of its own — its link to the piece before (or to the jump it
// lands from) is cut, it stays where it is, and the gizmo then moves / turns it and what follows it alone.
function splitAt(uid) {
  const pc = track.pieces.find((p) => p.uid === uid);
  if (!pc || isRing(pc)) return;
  if (pc.parent == null && pc.flightFrom == null) { editMsg = "This piece already starts a road."; renderStatus(); return; }
  snapshot();
  pc.M = built.get(uid).M.toArray();
  pc.parent = null;
  pc.flightFrom = null;
  editMsg = "Split: this piece now starts its own road — move or turn it with the gizmo, or join it to an end.";
  rebuild();
}
/** The open end (not of its own road) nearest the START of the road beginning at `uid`, within maxD m. */
function nearestEndFor(uid, maxD) {
  const own = new Set(carried(uid).pieces);
  const M = built.get(uid)?.M;
  if (!M) return null;
  const P = new THREE.Vector3().setFromMatrixPosition(M), F = new THREE.Vector3(0, 0, -1).transformDirection(M);
  let best = null;
  for (const e of openEnds()) {
    if (own.has(e.uid)) continue;
    const d = P.distanceTo(new THREE.Vector3().setFromMatrixPosition(e.m));
    const ang = Math.acos(THREE.MathUtils.clamp(F.dot(new THREE.Vector3(0, 0, -1).transformDirection(e.m)), -1, 1)) / DEG;
    if (d < maxD && (!best || d < best.d)) best = { e, d, ang };
  }
  return best;
}
/** JOIN: the road starting at `uid` is laid on the nearest open end (exactly, linked) — what flies off it
 * (its landings) and what stands loose on it come along. Within maxD m, its heading within maxAng°. */
function joinRoad(uid, maxD = 30, maxAng = 180) {
  const pc = track.pieces.find((p) => p.uid === uid);
  const n = nearestEndFor(uid, maxD);
  if (!pc || !n || n.ang > maxAng) return false;
  if (Math.abs(deg(leanIn(TILES[pc.id])) - deg(n.e.lean)) > 3) { editMsg = `That end ${n.e.lean ? `leans ${Math.abs(deg(n.e.lean))}°` : "is flat"}: this road starts ${leanIn(TILES[pc.id]) ? `leaning ${Math.abs(deg(leanIn(TILES[pc.id])))}°` : "flat"}.`; renderStatus(); return false; }
  snapshot();
  const delta = n.e.m.clone().multiply(built.get(uid).M.clone().invert());
  const what = carried(uid);
  for (const u of what.pieces) {
    const q = track.pieces.find((p) => p.uid === u);
    if (q && q.uid !== uid && q.parent == null) q.M = delta.clone().multiply(new THREE.Matrix4().fromArray(q.M)).toArray();
  }
  for (const u of what.props) { const o = track.props.find((p) => p.uid === u); if (o && o.on == null) o.M = delta.clone().multiply(new THREE.Matrix4().fromArray(o.M)).toArray(); }
  pc.parent = n.e.uid;
  pc.flightFrom = null;
  editMsg = `Joined to the end of ${TILES[track.pieces.find((p) => p.uid === n.e.uid)?.id]?.label ?? "the road"}.`;
  rebuild();
  return true;
}
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
  const oldM = new Map([...built].map(([u, b]) => [u, b.M.clone()])); // pieces laid BESIDE follow their neighbour's start
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
    for (const pc of track.pieces) {
      const a = pc.sideOf;
      if (a == null || !oldM.has(a) || !built.has(a)) continue;
      const d = built.get(a).M.clone().multiply(oldM.get(a).clone().invert());
      if (d.elements.every((v, i) => Math.abs(v - IDENT[i]) < 1e-6)) continue;
      pc.M = d.multiply(new THREE.Matrix4().fromArray(pc.M)).toArray();
      moved.push(a);
      oldM.set(a, built.get(a).M.clone());
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
  if (id === RING || id === FITTED || id === CATCH || id === FITTED_BOWL) { editMsg = "Landings, bowls and air rings go on a flight arc: pick them with nothing selected."; return; }
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
      track.pieces.splice(track.pieces.indexOf(pc) + 1, 0, { uid, id, open: pc.open, ...(pc.rail ? { rail: pc.rail } : {}), M: pc.M, parent: pc.uid, flightFrom: null });
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
// stands at: its start where the near arc comes down to that height, its angle that fall's, its length
// until the fast arc lands on it too. The road after it follows (reflow).
function fittedOnArc(a, k, tilt = 0) {
  const n = downAt(a.near, a.fast.pts[k].y) ?? { p: a.fast.pts[k].clone(), T: a.fast.tan[k].clone() };
  let T = n.T;
  const fall = Math.asin(THREE.MathUtils.clamp(-T.y, -1, 1)) / DEG;
  const angle = THREE.MathUtils.clamp(Math.round(fall / 5) * 5, 10, 45);
  const h = new THREE.Vector3(T.x, 0, T.z).normalize();
  T = h.multiplyScalar(Math.cos(angle * DEG)).setY(-Math.sin(angle * DEG));
  const R = new THREE.Vector3().crossVectors(T, UP).normalize();
  const U = new THREE.Vector3().crossVectors(R, T);
  // the near-speed car touches down at its start; the slope runs until the full-speed one is down too (+12 m)
  const P0 = n.p;
  let D = 24;
  for (const q of a.fast.pts) {
    const rel = q.clone().sub(P0);
    if (rel.dot(T) > 0 && rel.dot(U) <= 0) { D = rel.dot(T) + 12; break; }
  }
  D = Math.max(24, Math.ceil(D / 4) * 4);
  // a TILTED one keeps its low edge on the path plane (kit.js deckFrame raises the centre hw·sin): laid
  // that much lower, the car meets the deck's middle where the flat one would be
  const p = P0.clone().addScaledVector(U, -SECTIONS.road.hw * Math.abs(Math.sin(tilt * DEG)));
  return { id: ensureTile(`fitted_landing_${angle}_${D}${tilt ? `_t${tilt}` : ""}`).id, m: socketMatrix({ p, T, U, R }), P0, T, U };
}
const refittable = () => problems.misses.filter((m) => /^(fitted_landing|catch_tube)_/.test(track.pieces.find((q) => q.uid === m.uid)?.id ?? "")).map((m) => m.uid);
function refitLandings(uids = refittable()) {
  const fits = [];
  for (const uid of uids) {
    const a = arcs.find((x) => x.landing === uid);
    if (!a) continue;
    const y = new THREE.Vector3().setFromMatrixPosition(built.get(uid).M).y;
    // a CATCH TUBE: aimed again at the full-speed flight, its floor at the same height (catchSnap)
    if (track.pieces.find((q) => q.uid === uid).id.startsWith("catch_tube_")) {
      const c = catchSnap(a, y + CATCH_BELOW);
      if (!c.bad || !/never comes down/.test(c.bad)) fits.push({ uid, id: catchId, m: c.m });
      continue;
    }
    let k = -1;
    for (let i = 3; i < a.fast.pts.length; i++) if (a.fast.tan[i].y < -0.02 && a.fast.pts[i].y <= y) { k = i; break; }
    if (k < 0) continue; // the full-speed arc never comes down to it: move it on the arc by hand
    fits.push({ uid, ...fittedOnArc(a, k, Math.round((TILES[track.pieces.find((q) => q.uid === uid).id].tilt ?? 0) / DEG)) });
  }
  if (!fits.length) { editMsg = "Couldn't re-fit: the jump's full-speed arc doesn't come down to that landing's height — place it again on the arc."; renderStatus(); return; }
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
    return { id: p.id, open: !!p.open, rail: p.rail, cp: !!p.cp, link, from: i === 0 ? -1 : order.indexOf(link === "parent" ? p.parent : p.flightFrom), rel: Hi.clone().multiply(built.get(u).M).toArray() };
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
  return clipboard.items.map((it) => ({ ...it, rail: it.rail ? (it.rail === "L" ? "R" : "L") : it.rail, id: it.link === "ring" ? it.id : mirrorId(it.id), rel: MIRROR_X.clone().multiply(new THREE.Matrix4().fromArray(it.rel)).multiply(MIRROR_X).toArray() }));
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
      ? ownGeo(makeRingMesh({ P: new THREE.Vector3(), T: new THREE.Vector3(0, 0, -1), U: new THREE.Vector3(0, 1, 0), hw: RING_R }, { material: ghostMat }).children[0])
      : new THREE.Mesh(piece(it.id, pcOE(it)).look.deck, ghostMat);
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
      uid: uids[i], id: it.id, open: it.open, ...(it.rail ? { rail: it.rail } : {}), ...(it.cp ? { cp: true } : {}), M: Ms[i].toArray(),
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
  // a rail on one side swaps side with the turn (RAILS PER SIDE)
  reflow(() => order.forEach((u, i) => { const pc = roadPc(u); pc.id = ids[i]; if (pc.rail) pc.rail = pc.rail === "L" ? "R" : "L"; }));
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
  if (selBox) { scene.remove(selBox); disposeTree(selBox, true); selBox = null; }
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
  if (pc.parent == null && pc.flightFrom == null) return "root";
  // a piece in the middle of a road (user, 2026-10-21: "I click a piece to move and rotate it but see no
  // gizmo"): its pieces are joined, so the gizmo moves the WHOLE road, turning round the piece you picked
  return rootOf(uid) != null ? "road" : null;
}
/** The first piece of the road a piece belongs to (back along parent, the jump it lands from — a lip or a
 * jump pad's piece — or the piece it lies beside), or null. */
function rootOf(uid) {
  const seen = new Set();
  let pc = track.pieces.find((p) => p.uid === uid);
  while (pc && !seen.has(pc.uid)) {
    seen.add(pc.uid);
    const up = pc.parent ?? pc.flightFrom ?? pc.sideOf;
    if (up == null) return pc.uid;
    const host = (track.props ?? []).find((o) => o.uid === up)?.on; // flightFrom a jump pad: its piece
    pc = track.pieces.find((p) => p.uid === (host ?? up));
  }
  return null;
}
// SEVERAL PIECES (user, 2026-10-22: "move several selected pieces with the gizmo"): the gizmo at their
// middle, level; every road they belong to moves / turns together (carriedMany).
const multiRoads = () => { const sl = selection(); return !tileBase && !driving && sl.length > 1 && sl.every((u) => ["root", "road", "ring"].includes(movableKind(u))); };
function attachGizmo() {
  const multi = multiRoads();
  const kind = !tileBase && !driving && selection().length <= 1 ? movableKind(sel) : null;
  if (!multi && (!kind || (kind === "prop" && propOf(sel)?.on != null))) { gizmo.detach(); return; }
  if (multi) {
    const c = new THREE.Vector3();
    for (const u of selection()) c.add(new THREE.Vector3().setFromMatrixPosition(built.get(u).M));
    gizmoProxy.position.copy(c.divideScalar(selection().length));
    gizmoProxy.quaternion.identity();
    gizmoProxy.scale.set(1, 1, 1);
  } else built.get(sel).M.decompose(gizmoProxy.position, gizmoProxy.quaternion, gizmoProxy.scale);
  gizmoProxy.updateMatrixWorld(true);
  gizmo.setMode(gizmoMode);
  // TURN: round the vertical, and (user, 2026-10-22: "tilt a placed road with the gizmo") PITCH and BANK —
  // the piece's own axes, 5° steps; MOVE: on the world grid
  gizmo.setSpace(gizmoMode === "rotate" && !multi ? "local" : "world");
  gizmo.showX = gizmo.showZ = true;
  gizmo.translationSnap = gridStep;
  gizmo.rotationSnap = 5 * DEG;
  gizmo.attach(gizmoProxy);
}
/** What moves with several selected pieces: every road they are part of (and what flies off / stands loose on them). */
function carriedMany(uids) {
  const pieces = new Set(), props = new Set();
  for (const u of uids) { const w = carried(u); for (const x of w.pieces) pieces.add(x); for (const x of w.props) props.add(x); }
  return { pieces: [...pieces], props: [...props] };
}
function setGizmoMode(m) { gizmoMode = m; attachGizmo(); statusKey = ""; renderStatus(); }
/** Everything that moves with `uid`: a root carries its road, what flies off it, and what stands on it. */
function carried(uid) {
  if (movableKind(uid) === "road") uid = rootOf(uid); // the whole road it is part of
  const kind = movableKind(uid);
  if (kind !== "root") return { pieces: [uid], props: kind === "prop" ? [uid] : [] };
  const S = new Set([uid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const p of track.pieces) if (!S.has(p.uid) && (S.has(p.parent) || S.has(p.flightFrom))) { S.add(p.uid); grew = true; }
  }
  const pts = [];
  for (const u of S) { const pc = track.pieces.find((p) => p.uid === u); if (pc && !isRing(pc)) for (const r of piece(pc.id, pcOE(pc)).b.rings) pts.push(r.p.clone().applyMatrix4(built.get(u).M)); }
  const props = (track.props ?? []).filter((o) => { const c = new THREE.Vector3(o.M[12], o.M[13], o.M[14]); return pts.some((q) => Math.hypot(q.x - c.x, q.z - c.z) < 12 && Math.abs(q.y - c.y) < 5); }).map((o) => o.uid);
  return { pieces: [...S], props };
}
gizmo.addEventListener("dragging-changed", (e) => {
  controls.enabled = !e.value;
  if (e.value) {
    const what = multiRoads() ? carriedMany(selection()) : carried(sel);
    showPieceMeshes(true);
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
  if (delta.equals(new THREE.Matrix4())) { showPieceMeshes(false); return; }
  snapshot();
  for (const u of moved.what.pieces) {
    const pc = track.pieces.find((p) => p.uid === u);
    if (pc && (pc.parent == null)) pc.M = delta.clone().multiply(new THREE.Matrix4().fromArray(pc.M)).toArray();
  }
  for (const u of moved.what.props) {
    const o = track.props.find((p) => p.uid === u);
    let M = delta.clone().multiply(new THREE.Matrix4().fromArray(o.M));
    if (movableKind(sel) === "prop") {
      // dropped on a road: it stands on the piece under it, at that distance along and offset across
      const p = new THREE.Vector3().setFromMatrixPosition(M);
      const on = roadUnder(new THREE.Raycaster(p.clone().add(new THREE.Vector3(0, 6, 0)), new THREE.Vector3(0, -1, 0), 0, 12).intersectObjects(trackGroup.children, true));
      if (on && !OBSTACLES[o.kind]?.air) { Object.assign(o, { on: on.pc.uid, s: +on.s.toFixed(2), lat: on.raw }); }
      else { delete o.on; M = settleOnRoad(M); }
    } else if (o.on != null) continue; // a road moved: what stands on it follows it (relayProps)
    o.M = M.toArray();
  }
  rebuild();
  // DROPPED NEAR AN END: a road's head let go within 4 m of an open end, heading its way (20°), joins it
  const kind = movableKind(sel);
  if (!multiRoads() && (kind === "root" || kind === "road")) joinRoad(kind === "root" ? sel : rootOf(sel), 4, 20);
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
  if (P.openJump) return `<div class="row"><span>real car takes off at</span><b>${lips} km/h — land it on the red arc</b></div>`;
  return `<div class="row"><span>${problems.loose?.length ? "real car: to the road's end" : "real car: lap"}</span><b>${P.lapS?.toFixed(1)} s · top ${Math.round(P.topKmh)} km/h</b></div>` +
    (lips ? `<div class="row"><span>take-offs</span><b>${lips} km/h</b></div>` : "") +
    (P.rings ? (P.rings.taken === P.rings.of
      ? `<div class="row"><span>air rings</span><b>${P.rings.taken}/${P.rings.of} flown through</b></div>`
      : `<div class="warn">⚠ the car misses ${P.rings.of - P.rings.taken} air ring${P.rings.of - P.rings.taken > 1 ? "s" : ""} — no author time</div>`) : "") +
    (P.landings?.length ? `<div class="row"><span>landings (lined up)</span><b>${P.landings.filter((g) => g === "perfect").length}/${P.landings.length} perfect</b></div>` : "");
}
function renderStatus() {
  const names = { end: "open end", road: "on the road", side: "beside it", arc: "flight arc", local: "local grid", world: "world grid" };
  const many = !tileBase ? selection() : [];
  const multi = many.length > 1;
  const selPc = sel != null && !tileBase && !multi ? track.pieces.find((p) => p.uid === sel) ?? (track.props ?? []).find((p) => p.uid === sel) : null;
  const k = [freeHold, snap?.type, snap?.bad, snap?.where, tileBase, hand, edges, sel, selPc?.id, many.join(), copiedNote, !!clipboard, lapLineOn, editMode, editMsg, gizmoMode, gridMode, gridStep, buildY, rot.yaw, rot.pitch, rot.roll, arcSpeed, track.pieces.length, problems.messages.join(), prediction.state, prediction.fail?.uid, snap?.note, track.authorTime, track.pieces.filter((p) => p.cp).length, JSON.stringify(track.spawn ?? null)].join("|");
  if (k === statusKey) return;
  statusKey = k;
  const col = snap?.bad ? "#ff4d5e" : snap ? `#${SNAP_COLORS[snap.type].toString(16).padStart(6, "0")}` : "#8796b5";
  $("status").innerHTML =
    `<div class="mode" style="color:${col}">${tileBase ? `${isObstacle(tileBase) || tileBase === STAMP || tileBase === SPAWN ? tileLabel(tileBase) : tileBase === RING ? "Air ring" : TILES[tileId(tileBase)].label} → ${names[snap?.type] ?? "—"}` : multi ? `${many.length} pieces selected` : selPc ? (selPc.kind ? OBSTACLES[selPc.kind]?.label ?? "Obstacle" : isRing(selPc) ? "Air ring" : TILES[selPc.id]?.label ?? "Piece") : "Pick a piece"}</div>` +
    (multi ? `<div class="acts"><button data-act="copy">Copy <kbd>Ctrl+C</kbd></button><button data-act="mirror">Mirror</button><button data-act="delmany">Delete <kbd>Del</kbd></button></div>` +
      (multiRoads() ? `<div class="acts"><button data-act="move" class="${gizmoMode === "translate" ? "on" : ""}">Move <kbd>M</kbd></button><button data-act="turn" class="${gizmoMode === "rotate" ? "on" : ""}">Turn <kbd>M</kbd></button></div><div class="row"><span>The roads they are part of move and turn together</span></div>` : "") : "") +
    (copiedNote ? `<div class="edit-ask">${copiedNote}</div>` : "") +
    (!tileBase && !multi && !selPc ? `<div class="legend">Shift-click: the road up to a piece · Ctrl-click: one more${clipboard ? " · Ctrl+V: paste" : ""}</div>` : "") +
    (!tileBase && !multi && !selPc && track.pieces.length > 1
      ? `<div class="acts"><button data-act="lapline" class="${lapLineOn ? "on" : ""}">Test lap line ${lapLineOn ? "on" : "off"} <kbd>L</kbd></button></div>` +
        (lapLineOn ? `<div class="legend">The test car: blue slow → white fast, dashed in the air · red: hits, falls · orange: hard braking, rough landing</div>` : "")
      : "") +
    // THE TEST CAR: placed → its speed and a remove, whenever nothing else is in hand
    ((track.spawn && !multi && (!tileBase || tileBase === SPAWN))
      ? `<div class="acts"><button data-act="spawnkmh" title="The speed the drive starts at (click: next)">Test car · ${track.spawn.kmh ? `${track.spawn.kmh} km/h` : "standing"}</button><button data-act="spawndel">Remove test car</button></div><div class="legend">Drive (Tab) starts from it · <kbd>R</kbd> again · <kbd>Del</kbd> from the start line</div>`
      : tileBase === SPAWN ? `<div class="legend">Click a road: the drive starts there · <kbd>Q</kbd>/<kbd>E</kbd> turn it</div>` : "") +
    (tileBase === STAMP ? `<div class="row"><span>Snaps like its first piece · R mirrors it · it stays in hand</span></div>` : "") +
    (isObstacle(tileBase) ? `<div class="row"><span>${OBSTACLES[tileBase].hint} · ${obstacleHow(tileBase)}</span></div>` : "") +
    (tileBase && !isObstacle(tileBase) && tileBase !== RING ? `<div class="row"><span>${freeHold ? "<b>FREE</b> · " : ""}<kbd>Alt</kbd> free · <kbd>Ctrl</kbd>+wheel turn · <kbd>Shift</kbd>+wheel height · <kbd>H</kbd> match height · arrows tilt · <kbd>0</kbd> level</span></div>` : "") +
    (selPc && !isRing(selPc) && !selPc.kind
      ? (editMode
          ? `<div class="edit-ask">${editMode === "insert" ? "Insert after it" : "Replace it"}: pick a piece in the dock below · <kbd>Esc</kbd> cancel</div>`
          : "") +
        `<div class="acts">` +
        `<button data-act="insert" class="${editMode === "insert" ? "on" : ""}">Insert after <kbd>I</kbd></button>` +
        `<button data-act="replace" class="${editMode === "replace" ? "on" : ""}">Replace <kbd>P</kbd></button>` +
        `<button data-act="delete">Delete <kbd>Del</kbd></button>` +
        `<button data-act="cp">${selPc.cp ? "No checkpoint" : "Checkpoint"} <kbd>C</kbd></button>` +
        (selPc.parent != null || selPc.flightFrom != null ? `<button data-act="split" title="This piece starts a road of its own: move it and what follows alone">Split here <kbd>K</kbd></button>` : "") +
        (selPc.parent == null && selPc.flightFrom == null && nearestEndFor(selPc.uid, 30) ? `<button data-act="join" title="Lay this road on the open end nearby">Join to the end nearby</button>` : "") +
        `</div>`
      : selPc ? `<div class="acts"><button data-act="delete">Delete <kbd>Del</kbd></button></div>` : "") +
    // a placed ADJUSTABLE piece: its settings, right here (the road after it follows)
    (selPc && !selPc.kind && !isRing(selPc) && parseAdjustable(selPc.id)
      ? (() => { const a = parseAdjustable(selPc.id), d = ADJUSTABLE[a.base];
          return `<div class="acts">${Object.entries(d.params).map(([pk, q]) => `<button data-act="adj:${pk}:-1" title="Shift: ×4">◀</button><span class="adjv">${q.label} ${adjShow(q, a.p[pk])}</span><button data-act="adj:${pk}:1" title="Shift: ×4">▶</button>`).join("")}</div>`; })()
      : "") +
    // the gizmo's two modes, or why this piece can't move on its own
    (selPc?.kind && selPc.on != null
      ? `<div class="row"><span><b>Drag it</b> along or across the road${canTurn(selPc.kind) ? ` · <kbd>Q</kbd>/<kbd>E</kbd> turn` : ""} · <kbd>Del</kbd> delete</span></div>`
      : selPc ? (movableKind(sel)
      ? `<div class="acts"><button data-act="move" class="${gizmoMode === "translate" ? "on" : ""}">Move <kbd>M</kbd></button><button data-act="turn" class="${gizmoMode === "rotate" ? "on" : ""}">Turn <kbd>M</kbd></button></div>` +
        (movableKind(sel) === "root" ? `<div class="row"><span>The whole road behind it moves too</span></div>`
          : movableKind(sel) === "road" ? `<div class="row"><span>Its pieces are joined: the whole road moves and turns with it</span></div>` : "")
      : `<div class="row"><span>Held by the road: Replace or Insert</span></div>`) : "") +
    (editMsg ? `<div class="warn">${editMsg}</div>` : "") +
    (snap?.bad ? `<div class="warn">${snap.bad}</div>` : "") +
    (snap?.note ? `<div class="row"><span>${snap.note}</span></div>` : "") +
    (snap?.where ? `<div class="row"><span>↧ ${snap.where}</span></div>` : "") +
    problems.messages.map((m) => `<div class="warn">⚠ ${m}</div>`).join("") +
    (refittable().length ? `<div class="acts"><button data-act="refit">Re-fit ${refittable().length > 1 ? `${refittable().length} landings` : "the landing"} to the jump</button></div>` : "") +
    predictionLine() +
    (tileBase // how the piece in hand is placed: nothing to say without one
      ? `<div class="row"><span>grid</span><b>${gridMode} · ${gridStep} m</b></div>` +
        `<div class="row"><span>height</span><b>${buildY} m</b></div>` +
        `<div class="row"><span>turn / pitch / bank</span><b>${rot.yaw}° / ${rot.pitch}° / ${rot.roll}°</b></div>`
      : "") +
    // (once the test car has taken off, the prediction line above says it: only the guess here)
    (prediction.lipSpeed.size ? "" : `<div class="row"><span>take-off (guess)</span><b>${Math.round(arcSpeed * 3.6)} km/h</b></div>`) +
    `<div class="row"><span>checkpoints (select + C)</span><b>${track.pieces.filter((p) => p.cp).length}</b></div>` +
    `<div class="row"><span>author time</span><b>${track.authorTime ? `${track.authorTime.toFixed(2)} s` : "—"}</b></div>` +
    `<div class="row"><span>pieces</span><b>${track.pieces.length}</b></div>`;
}

$("status").addEventListener("click", (e) => {
  const act = e.target.closest?.("button")?.dataset.act;
  if (act === "lapline") { setLapLine(!lapLineOn); return; }
  if (act === "spawnkmh" && track.spawn) { const i = SPAWN_SPEEDS.indexOf(track.spawn.kmh ?? 0); track.spawn.kmh = SPAWN_SPEEDS[(i + 1) % SPAWN_SPEEDS.length]; save(); statusKey = ""; renderStatus(); return; }
  if (act === "spawndel" && track.spawn) { snapshot(); delete track.spawn; rebuild(); statusKey = ""; renderStatus(); return; }
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
  else if (act === "split") splitAt(sel);
  else if (act === "join") { if (!joinRoad(sel)) { editMsg ??= "No open end within 30 m."; renderStatus(); } }
});

// ---------- input ----------
const canvas = renderer.domElement;
canvas.addEventListener("pointermove", (e) => { mouse.x = e.clientX; mouse.y = e.clientY; mouse.inside = true; });
// onto the piece-in-hand bar the ghost stays where it was (its buttons turn / raise it in place)
canvas.addEventListener("pointerleave", (e) => { if (!e.relatedTarget?.closest?.("#hand")) mouse.inside = false; });
let down = null;
// (a press on the gizmo is the gizmo's: no selecting, placing or panning under it)
canvas.addEventListener("pointerdown", (e) => { down = { x: e.clientX, y: e.clientY, b: e.button, gizmo: gizmo.axis != null }; });
// DRAG AN OBSTACLE (user, 2026-10-21: "everything easy to place … very UX friendly"): press on one that
// stands on a road and move: it slides along and across the road — any road — snapped as when placing it
// (roadSnapAt), a pad taking the shape under it. Capture phase: the camera must not orbit meanwhile.
let propDrag = null;
canvas.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || tileBase || driving || gizmo.axis != null) return;
  ray.setFromCamera(new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1), camera);
  let o = ray.intersectObjects(trackGroup.children, true)[0]?.object;
  while (o && o.userData.uid == null) o = o.parent;
  const prop = o && propOf(o.userData.uid);
  if (!prop || prop.on == null) return;
  propDrag = { uid: prop.uid, x: e.clientX, y: e.clientY, moving: false };
  controls.enabled = false;
}, { capture: true });
canvas.addEventListener("pointermove", (e) => {
  if (!propDrag) return;
  if (!propDrag.moving && Math.hypot(e.clientX - propDrag.x, e.clientY - propDrag.y) < 5) return;
  const prop = propOf(propDrag.uid);
  if (!propDrag.moving) { propDrag.moving = true; snapshot(); sel = prop.uid; selSet = new Set([prop.uid]); }
  ray.setFromCamera(new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1), camera);
  const on = roadUnder(ray.intersectObjects(trackGroup.children, true));
  if (!on) return;
  const sn = roadSnapAt(on.pc, prop.kind, on.s, on.raw, prop.yaw ?? 0);
  Object.assign(prop, { on: sn.extra.on, s: sn.extra.s, lat: sn.extra.lat });
  const b = built.get(prop.uid);
  if (b) { b.group.matrix.copy(sn.m); b.group.matrixWorldNeedsUpdate = true; b.M = sn.m.clone(); }
});
addEventListener("pointerup", () => {
  if (!propDrag) return;
  const was = propDrag;
  propDrag = null;
  controls.enabled = true;
  if (was.moving) { rebuild(); renderStatus(); }
});
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
// ---------- FREE PLACEMENT, FAST (user, 2026-10-21, Apex Rush: "he can place easily any piece and rotate
// it quick") ----------
// Alt held: no snapping; Ctrl + wheel: turn the piece in hand (15°, with Alt 5°); Shift + wheel: raise /
// lower it (the handler above, 2 m — kept as it was); H: the height of the piece under the cursor; arrows
// tilt (±90°), 0 / ` levels it.
// (`freeHold` is declared with the other settings at the top: the panel reads it while the page starts)
addEventListener("keyup", (e) => { if (e.key === "Alt" && freeHold) { freeHold = false; ghostDirty = true; e.preventDefault(); } });
addEventListener("blur", () => { freeHold = false; });
addEventListener("wheel", (e) => {
  if (driving || !tileBase || !e.ctrlKey) return;
  const v = e.deltaY || e.deltaX; // Shift + wheel scrolls sideways on Windows: the delta comes in deltaX
  if (!v) return;
  e.preventDefault();
  e.stopImmediatePropagation(); // before the camera's wheel (zoom) and the browser's (Ctrl = page zoom)
  rot.yaw = ((rot.yaw + Math.sign(-v) * (freeHold || e.altKey ? 5 : 15)) % 360 + 360) % 360;
  ghostDirty = true;
  renderStatus();
}, { capture: true, passive: false });
/** The deck height of the placed piece under the mouse, or null. */
function heightUnderCursor() {
  ray.setFromCamera(new THREE.Vector2((mouse.x / innerWidth) * 2 - 1, -(mouse.y / innerHeight) * 2 + 1), camera);
  const h = ray.intersectObjects(trackGroup.children, true)[0];
  return h ? h.point.y : null;
}
addEventListener("keydown", (e) => {
  if (driving) return; // the drive session owns the keys
  if (e.code === "Tab") { e.preventDefault(); startDrive(); return; }
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === "z") { e.preventDefault(); restore(e.shiftKey ? redo : undo, e.shiftKey ? undo : redo); return; }
  if ((e.ctrlKey || e.metaKey) && k === "y") { e.preventDefault(); restore(redo, undo); return; }
  if ((e.ctrlKey || e.metaKey) && k === "c" && !tileBase && selection().length) { e.preventDefault(); copySelection(); return; }
  if ((e.ctrlKey || e.metaKey) && k === "v") { e.preventDefault(); pasteSection(); return; }
  // ALT HELD: free placement — no snapping to an end, a side or an arc (FREE PLACEMENT, 2026-10-21)
  if (e.key === "Alt") { e.preventDefault(); if (!freeHold) { freeHold = true; ghostDirty = true; } return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const digit = /^Digit([1-4])$/.exec(e.code);
  if (digit) { gridStep = GRID_STEPS[+digit[1] - 1]; ghostDirty = true; return; }
  const step = e.shiftKey ? 5 : 15;
  switch (e.key) {
    // tilt: 5° steps (Shift: 15°), up to ±90° (was ±45: Apex Rush floats pieces at any angle)
    case "ArrowUp": rot.pitch = Math.min(90, rot.pitch + (e.shiftKey ? 15 : 5)); break;
    case "ArrowDown": rot.pitch = Math.max(-90, rot.pitch - (e.shiftKey ? 15 : 5)); break;
    case "ArrowLeft": if (tileBase === FITTED) landTilt = Math.max(-45, landTilt - 5); else rot.roll = Math.max(-90, rot.roll - (e.shiftKey ? 15 : 5)); break;
    case "ArrowRight": if (tileBase === FITTED) landTilt = Math.min(45, landTilt + 5); else rot.roll = Math.min(90, rot.roll + (e.shiftKey ? 15 : 5)); break;
    case "PageUp": buildY += 2; break;
    case "PageDown": buildY -= 2; break;
    case "Enter": place(); break;
    case "Escape": if (editMode) editMode = null; else if (tileBase) { tileBase = null; renderDock(); } else { sel = null; editMsg = null; refreshSelection(); } break;
    case "Delete": case "Backspace": if (!tileBase && selection().length > 1) removeMany(selection()); else if (!tileBase && sel != null) removePiece(sel); break;
    case "[": arcSpeed = Math.max(20, arcSpeed - 1); refreshArcs(); runChecks(); break;
    case "]": arcSpeed = Math.min(80, arcSpeed + 1); refreshArcs(); runChecks(); break;
    default:
      // by key POSITION (e.code): on AZERTY the letter Q is where A is — W A S D move the camera
      if ((e.code === "KeyQ" || e.code === "KeyE") && !tileBase && propOf(sel)?.on != null) {
        const o = propOf(sel);
        if (canTurn(o.kind)) { snapshot(); o.yaw = ((((o.yaw ?? 0) + (e.code === "KeyQ" ? step : -step)) % 360) + 360) % 360; rebuild(); }
      } else if (e.code === "KeyQ") rot.yaw += step;
      else if (e.code === "KeyE") rot.yaw -= step;
      else if (k === "r") { hand = -hand; renderDock(); }
      else if (k === "g") gridMode = gridMode === "world" ? "local" : "world";
      else if (k === "t") { const order = [true, "L", "R", false]; edges = order[(order.indexOf(edges) + 1) % order.length]; ghostDirty = true; renderDock(); }
      else if (k === "f") nav.frame();
      else if (k === "c" && !tileBase && sel != null) toggleCheckpoint(sel);
      else if (k === "k" && !tileBase && sel != null) splitAt(sel);
      else if (k === "i" && !tileBase && sel != null) startEdit("insert");
      else if (k === "m" && !tileBase && movableKind(sel)) setGizmoMode(gizmoMode === "translate" ? "rotate" : "translate");
      else if (k === "l") setLapLine(!lapLineOn);
      else if (k === "p" && !tileBase && sel != null) startEdit("replace");
      else if (k === "h") { const y = heightUnderCursor(); if (y != null) buildY = Math.round(y * 2) / 2; }
      else if (k === "0" || e.code === "Backquote") { rot.pitch = 0; rot.roll = 0; }
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
  const k = [id, free, mirror, hand, rot.yaw, rot.pitch, rot.roll, landTilt, buildY, adj ? JSON.stringify(adjParams[tileBase]) : ""].join("|");
  if (k === handKey) return;
  handKey = k;
  const off = free ? "" : " off";
  el.innerHTML =
    `<span class="nm">${tileBase === SPAWN ? tileLabel(SPAWN) : TILES[id]?.label ?? id}</span>` +
    // an ADJUSTABLE piece's own settings first (the ghost follows them)
    (tileBase === FITTED ? `<div class="gp"><span>Land tilt</span><button data-a="tl" title="Left side low (←)">↶</button><b>${landTilt ? `${Math.abs(landTilt)}° ${landTilt > 0 ? "R" : "L"}` : "flat"}</b><button data-a="tr" title="Right side low (→)">↷</button></div>` : "") +
    (adj ? Object.entries(adj.params).map(([pk, q]) => `<div class="gp"><span>${q.label}</span><button data-a="p-${pk}" title="Less (Shift: ×4)">◀</button><b>${adjShow(q, adjParams[tileBase][pk])}</b><button data-a="p+${pk}" title="More (Shift: ×4)">▶</button></div>`).join("") : "") +
    `<div class="gp${tileBase === SPAWN ? "" : off}" title="${free || tileBase === SPAWN ? "" : "Snapped to a road end: the road sets the angle"}"><span>Turn</span><button data-a="yl" title="Turn left (Q)">⟲</button><b>${rot.yaw}°</b><button data-a="yr" title="Turn right (E)">⟳</button></div>` +
    (tileBase === SPAWN ? "" : `<div class="gp${off}"><span>Height</span><button data-a="hd" title="Lower (PgDn)">▼</button><b>${buildY} m</b><button data-a="hu" title="Higher (PgUp)">▲</button></div>` +
    `<div class="gp${off}"><span>Tilt</span><button data-a="pd" title="Nose down (↓)">⤓</button><b>${rot.pitch}°</b><button data-a="pu" title="Nose up (↑)">⤒</button></div>` +
    `<div class="gp${off}"><span>Bank</span><button data-a="rl" title="Bank left (←)">↶</button><b>${rot.roll}°</b><button data-a="rr" title="Bank right (→)">↷</button></div>`) +
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
      case "tl": landTilt = Math.max(-45, landTilt - 5); renderDock(); break;
      case "tr": landTilt = Math.min(45, landTilt + 5); renderDock(); break;
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
// the TEST CAR's hologram: the car itself, once its model is in (its card, the one in hand, the placed one)
rig.modelsReady.then(() => {
  carHolo = rig.carHologram();
  if (!carHolo) return;
  ghostDirty = true;
  if (track.spawn) rebuild();
  renderThumb(SPAWN, false).then(renderDock);
});
let driving = false;
const builderUi = ["toolbar", "keys", "steps", "status", "next", "dock", "nav"];
let saved = null;
const DRIVE_HELP = `<kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> / arrows drive · <kbd>Space</kbd> handbrake · in the air: <kbd>Shift</kbd>/<kbd>C</kbd> pitch, <kbd>Q</kbd>/<kbd>E</kbd> spin, <kbd>Z</kbd>/<kbd>X</kbd> roll · <kbd>Backspace</kbd> last checkpoint · <kbd>R</kbd> restart${"" /* (the test car, if placed) */} · <kbd>Del</kbd> from the start line · <b style="color:#3fd2ff"><kbd>Esc</kbd> back to building</b>`;
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
  // the TEST CAR wins: exactly where it stands, at its speed
  const spawnM = spawnFrame();
  const from = spawnM ?? (selRoad ? built.get(sel)?.M ?? null : null);
  await rig.start({ track, trackId, from, fromExact: !!spawnM, fromKmh: spawnM ? track.spawn.kmh ?? 0 : 0, noTimer: !timerOn, autoFinish: false, fallReset: false, buttons: [{ label: "Back to building", key: "B", run: stopDrive }], onEscape: stopDrive, backLabel: "Building", help: DRIVE_HELP });
}
function stopDrive() {
  if (!driving) return;
  rig.stop();
  for (const [o, v] of saved.vis) o.visible = v;
  for (const [id, d] of saved.ui) $(id).style.display = d;
  camera.position.copy(saved.pos);
  controls.target.copy(saved.target);
  // the chase camera tilts camera.up (loops, banks) and widens the lens with speed: back to the editor's,
  // or the orbit comes back ROLLED (user, 2026-10-21: "the camera has rotated … a weird rotated camera")
  camera.up.set(0, 1, 0);
  camera.fov = saved.fov;
  camera.updateProjectionMatrix();
  controls.enabled = true;
  fitView();
  controls.update();
  driving = false;
  attachGizmo(); // the selection's gizmo again
  last = performance.now();
}
$("b-drive").onclick = startDrive;
// THE TIMER SWITCH (user, 2026-10-22): building and debugging, Drive starts at once — no countdown, no clock,
// no medals; on, it is the real race. Off by default, remembered.
let timerOn = false;
try { timerOn = localStorage.getItem("thunderline.builder.timer") === "1"; } catch {}
function showTimer() { $("b-timer").textContent = `Timer: ${timerOn ? "on" : "off"}`; $("b-timer").classList.toggle("on", timerOn); }
$("b-timer").onclick = () => { timerOn = !timerOn; try { localStorage.setItem("thunderline.builder.timer", timerOn ? "1" : "0"); } catch {} showTimer(); };
showTimer();
// THE TUTORIAL (builderTutorial.js): on a NEW track (yours stays as it is); offered by itself the first time
// the builder opens on an empty track
const tutorial = createBuilderTutorial({
  get track() { return track; }, get arcs() { return arcs; }, get driving() { return driving; }, get sel() { return sel; },
  camera, tiles: TILES,
}, { onEnd: () => { try { localStorage.setItem("thunderline.builder.tutorialSeen", "1"); } catch {} } });
$("b-tut").onclick = () => {
  if (!track.pieces.length && !(track.props ?? []).length) { tutorial.start(); return; }
  save();
  location.href = `${PAGES.builder}?track=${library.create().id}&tutorial=1`;
};
{
  let seen = false;
  try { seen = localStorage.getItem("thunderline.builder.tutorialSeen") === "1"; } catch {}
  if (params.get("tutorial") === "1" || (!seen && !track.pieces.length)) {
    try { localStorage.setItem("thunderline.builder.tutorialSeen", "1"); } catch {}
    setTimeout(() => tutorial.start(), 600);
  }
}
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
  chunkMeshes?.updateLod(camera); // the posts' / rails' detail (testTrack.js)
  obstacleSet?.setTime(now / 1000); // the sweepers turn while you build (the test lap has its own clock)
  renderHand();
  updateGrid();
  updateNext();
});
// test hooks: aiming updates the ghost/snap at once (a hidden or minimised window runs no frames)
const hookAim = (f) => (...a) => { controls.update(); camera.updateMatrixWorld(); const r = f(...a); updateGhost(); return r; };
window.__b3 = {
  app, get rig() { return rig; }, startDrive, stopDrive, get driving() { return driving; },
  get track() { return track; }, get snap() { return snap; }, get problems() { return problems; }, built: () => built, camera, controls, gizmo, gizmoProxy,
  pickTile: hookAim(pickTile), place, removePiece, frameAll, toggleCheckpoint, select(uid) { sel = uid; refreshSelection(); }, setMouse(x, y) { mouse.x = x; mouse.y = y; mouse.inside = true; },
  aimEnd() { const e = openEnds().at(-1); const s = e && toScreen(new THREE.Vector3().setFromMatrixPosition(e.m)); if (s) { mouse.x = s.x; mouse.y = s.y; mouse.inside = true; } return s; },
  aimFast(k) { const a = arcs.at(-1); if (!a) return null; const p = a.fast.pts[Math.min(k, a.fast.pts.length - 1)]; const s = toScreen(p); if (s) { mouse.x = s.x; mouse.y = s.y; mouse.inside = true; } return { s, n: a.fast.pts.length, p }; },
  aimArc(k) { const a = arcs.at(-1); if (!a) return null; const p = a.pts[Math.min(k, a.pts.length - 1)]; const s = toScreen(p); if (s) { mouse.x = s.x; mouse.y = s.y; mouse.inside = true; } return { s, n: a.pts.length }; },
  setHand(h) { hand = h; renderDock(); }, setEdges(v) { edges = v; renderDock(); }, setBuildY(y) { buildY = y; },
  reset() { track = { pieces: [], nextUid: 1 }; prediction.launch = new Map(); prediction.lipSpeed = new Map(); rebuild(); },
  setTrack(t) { track = t; rebuild(); },
  startEdit, get editMsg() { return editMsg; }, gizmo, gizmoProxy, setGizmoMode, movableKind,
  refitLandings, get problems2() { return problems; },
  selectRun(a, b) { sel = b; selSet = new Set(runBetween(a, b) ?? [b]); refreshSelection(); },
  get tutorial() { return tutorial; }, trackThumb,
  selectMany(uids) { sel = uids.at(-1); selSet = new Set(uids); refreshSelection(); renderStatus(); }, selection, copySelection, pasteSection, mirrorSelection, removeMany, get clipboard() { return clipboard; },
  get arcs() { return arcs; }, get launch() { return prediction.launch; },
  get prediction() { return { state: prediction.state, fail: prediction.fail, lapS: prediction.lapS, openJump: prediction.openJump, endSpeed: prediction.endSpeed, landings: prediction.landings, topKmh: Math.round(prediction.topKmh), lips: [...prediction.lipSpeed.entries()].map(([u, v]) => [u, Math.round(v * 3.6)]) }; },
};
for (const k of ["aimEnd", "aimArc", "aimFast", "setMouse", "frameAll"]) window.__b3[k] = hookAim(window.__b3[k]);

