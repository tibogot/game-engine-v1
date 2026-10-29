// Thunderline OBSTACLES — things on (or off) the road that are not road: the builder's Obstacles tab,
// the drive page and the builder's test lap all build them from here, so what you place is what the car
// hits. A track keeps them in `track.props`: [{ uid, kind, M }] (M = the obstacle's frame: −Z along the
// road it stands on, +Y its up, as a piece's socket).
//
// TWO TO START (user, 2026-10-20: "just one or two to create the menu"; the rest designed from the
// user's Apex Rush screenshots):
//   - BLOCK: a solid barrier to dodge, or to jump onto (its top is a deck the wheels drive on)
//   - SWEEPER: a hazard bar turning over the road round a post. Its angle is a function of the RACE
//     CLOCK (setTime), never of the screen's: the same run meets the bar at the same angle every time,
//     so ghosts, author times and records stay fair. The vehicle collides with it as a moving solid
//     (setDynamicMovers: a tree baked once in the bar's own frame, the query moved — RigidBvh).
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { RigidBvh } from "../../../../v3/play/modularRoadRigidBvh.js";
import { body, physLook, physGhost, physModel, physKit, ViewLOD } from "./physProps.js";
import { ledSignMaterial } from "./ledSigns.js";
import { ARCH_LOD_FAR } from "./gateMesh.js";
import { GATE_WIDTH, GATE_POST_HEIGHT, TIRE_TUBE_R } from "../../../modular-road-v3/modularRoadPropPhysics.js";
import { rampGeometry, kickerRampGeometry, jumpRampGeometry } from "../../../modular-road-v3/modularRoadParkour.js";

const BOLT = 0x3fd2ff, SIGNAL = 0xff7a1a;
const ROAD_HW = 12; // the road's half width (kit.js SECTIONS.road.hw — 24 m since 2026-10-29): obstacles sized to it
let MATS = null;
const mats = () => (MATS ??= {
  body: new THREE.MeshStandardMaterial({ color: 0x1c2436, roughness: 0.55, metalness: 0.25 }),
  top: new THREE.MeshStandardMaterial({ color: 0x2a2f3a, roughness: 0.85, metalness: 0.05 }),
  bolt: new THREE.MeshStandardMaterial({ color: BOLT, emissive: BOLT, emissiveIntensity: 1.5, roughness: 0.4 }),
  signal: new THREE.MeshStandardMaterial({ color: SIGNAL, emissive: SIGNAL, emissiveIntensity: 0.9, roughness: 0.45 }),
  white: new THREE.MeshStandardMaterial({ color: 0xe8edf5, roughness: 0.5, metalness: 0.1 }),
});
const _r = new THREE.Vector3(), _vm = new THREE.Matrix4(), _vm2 = new THREE.Matrix4();
const box = (w, h, d, x = 0, y = 0, z = 0) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);

// ---------------------------------------------------------------- BLOCK
const BW = 7, BH = 2.6, BD = 5; // across the road, high, along it
function blockParts() {
  const m = mats();
  const g = new THREE.Group();
  g.add(new THREE.Mesh(new RoundedBoxGeometry(BW, BH, BD, 3, 0.35).translate(0, BH / 2, 0), m.body));
  // the top the car lands on: a deck plate just proud of the rounded top
  g.add(new THREE.Mesh(box(BW - 0.6, 0.06, BD - 0.6, 0, BH + 0.02, 0), m.top));
  // a glowing band round the top edge (reads from far, and in the dark) and an orange chevron row on
  // the face the car comes at (+Z)
  const band = mergeGeometries([
    box(BW + 0.04, 0.16, 0.08, 0, BH - 0.45, BD / 2 + 0.02), box(BW + 0.04, 0.16, 0.08, 0, BH - 0.45, -BD / 2 - 0.02),
    box(0.08, 0.16, BD + 0.04, BW / 2 + 0.02, BH - 0.45, 0), box(0.08, 0.16, BD + 0.04, -BW / 2 - 0.02, BH - 0.45, 0),
  ]);
  g.add(new THREE.Mesh(band, m.bolt));
  const chev = [];
  for (let i = -2; i <= 2; i++) {
    const c = new THREE.Shape();
    c.moveTo(-0.45, -0.45); c.lineTo(0, 0.1); c.lineTo(0.45, -0.45); c.lineTo(0.45, -0.05); c.lineTo(0, 0.5); c.lineTo(-0.45, -0.05); c.closePath();
    chev.push(new THREE.ShapeGeometry(c).translate(i * 1.2, 1.05, BD / 2 + 0.03));
  }
  g.add(new THREE.Mesh(mergeGeometries(chev), m.signal));
  return g;
}
const BLOCK_SOLID = box(BW, BH, BD, 0, BH / 2, 0);
const BLOCK_DECK = new THREE.PlaneGeometry(BW - 0.2, BD - 0.2).rotateX(-Math.PI / 2).translate(0, BH, 0);

// ---------------------------------------------------------------- SWEEPER
const ARM = 2 * ROAD_HW - 1.4, ARM_Y = 0.95, ARM_T = 0.7, POST_R = 0.6, POST_H = 3.4;
const SWEEP_PERIOD = 5; // s per turn: the tips move at ~9 m/s. The arm stays inside the kerbs (the road's width less 1.4 m: no gap a car fits through, and it never cuts the rails)
function sweeperParts() {
  const m = mats();
  const g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.CylinderGeometry(POST_R, POST_R * 1.25, POST_H, 20).translate(0, POST_H / 2, 0), m.body));
  g.add(new THREE.Mesh(new THREE.TorusGeometry(POST_R * 1.05, 0.09, 8, 28).rotateX(Math.PI / 2).translate(0, POST_H - 0.25, 0), m.signal));
  g.add(new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.8, 0.18, 28).translate(0, 0.09, 0), m.body));
  // the ARM: hazard stripes along it (orange glowing / white), a light at each tip
  const arm = new THREE.Group();
  arm.name = "arm";
  const n = 12, seg = ARM / n, orange = [], white = [];
  for (let i = 0; i < n; i++) (i % 2 ? white : orange).push(box(seg, ARM_T, ARM_T, -ARM / 2 + seg * (i + 0.5), ARM_Y, 0));
  orange.push(box(0.2, ARM_T + 0.2, ARM_T + 0.2, ARM / 2 + 0.1, ARM_Y, 0), box(0.2, ARM_T + 0.2, ARM_T + 0.2, -ARM / 2 - 0.1, ARM_Y, 0));
  arm.add(new THREE.Mesh(mergeGeometries(orange), m.signal));
  arm.add(new THREE.Mesh(mergeGeometries(white), m.white));
  arm.add(new THREE.Mesh(new THREE.CylinderGeometry(POST_R * 1.15, POST_R * 1.15, ARM_T + 0.3, 20).translate(0, ARM_Y, 0), m.body));
  g.add(arm);
  return g;
}
const SWEEP_POST = new THREE.CylinderGeometry(POST_R, POST_R, POST_H, 10).translate(0, POST_H / 2, 0);
const SWEEP_ARM = box(ARM + 0.4, ARM_T, ARM_T, 0, ARM_Y, 0);

// ---------------------------------------------------------------- WALLS WITH A HOLE
// (user, 2026-10-21, Apex Rush shot 2: a wall across the way with one hole to get through). Solid all
// round the hole: miss it and the car hits the wall. Two kinds, one build:
//   - DOOR: across the road, the hole at road level (8 × 5.5 m: half the road — aim for it). The wall is
//     CENTRED on the road (origin on its surface, its middle) and as wide as the road + 5 m each side; the
//     DOOR slides across it (prop `dx`, m right; `hw` the road's half width). A whole wall slid sideways
//     overhung one side by 9 m — "not centred, looks bad" (user, 2026-10-21).
//   - HOLE: standing in the air on a jump's flight (the builder lays it on the full-speed arc, upright,
//     facing the flight). 10 × 8 m, its origin the hole's centre: take off fast and straight.
const WALL_T = 1.2; // thick
/** The wall as boxes round a hole: [x0, x1, y0, y1] wall, [hx0, hx1, hy0, hy1] hole (the hole may touch the bottom). */
function wallBoxes([x0, x1, y0, y1], [hx0, hx1, hy0, hy1]) {
  const b = (a0, a1, b0, b1) => (a1 - a0 > 1e-3 && b1 - b0 > 1e-3 ? [box(a1 - a0, b1 - b0, WALL_T, (a0 + a1) / 2, (b0 + b1) / 2, 0)] : []);
  return [...b(x0, hx0, y0, y1), ...b(hx1, x1, y0, y1), ...b(hx0, hx1, hy1, y1), ...b(hx0, hx1, y0, hy0)];
}
function wallParts(boxes, [hx0, hx1, hy0, hy1], { sill = true } = {}) {
  const m = mats();
  const g = new THREE.Group();
  g.add(new THREE.Mesh(mergeGeometries(boxes), m.body));
  // a glowing frame round the hole, on both faces (reads from far, and in the dark)
  const f = 0.35, z = WALL_T / 2 + 0.03, frame = [];
  for (const s of [1, -1]) {
    frame.push(box(hx1 - hx0 + 2 * f, f, 0.06, (hx0 + hx1) / 2, hy1 + f / 2, s * z));
    if (sill) frame.push(box(hx1 - hx0 + 2 * f, f, 0.06, (hx0 + hx1) / 2, hy0 - f / 2, s * z));
    frame.push(box(f, hy1 - hy0, 0.06, hx0 - f / 2, (hy0 + hy1) / 2, s * z), box(f, hy1 - hy0, 0.06, hx1 + f / 2, (hy0 + hy1) / 2, s * z));
  }
  g.add(new THREE.Mesh(mergeGeometries(frame), m.bolt));
  // orange chevrons over the hole on the face the car comes at (+Z), pointing down at it
  const chev = [];
  for (let i = -2; i <= 2; i++) {
    const c = new THREE.Shape();
    c.moveTo(-0.6, 0.6); c.lineTo(0, -0.1); c.lineTo(0.6, 0.6); c.lineTo(0.6, 0.1); c.lineTo(0, -0.65); c.lineTo(-0.6, 0.1); c.closePath();
    chev.push(new THREE.ShapeGeometry(c).translate((hx0 + hx1) / 2 + i * 1.6, hy1 + 1.6, z + 0.01));
  }
  g.add(new THREE.Mesh(mergeGeometries(chev), m.signal));
  return g;
}
export const DOOR = { w: 26, h: 12, hole: [-4, 4, 0, 5.5] };
export const HOLE = { w: 30, h: 26, hole: [-5, 5, -4, 4] };
const DOOR_BOXES = wallBoxes([-DOOR.w / 2, DOOR.w / 2, 0, DOOR.h], DOOR.hole);
const doorShapes = new Map();
/** One door wall's shape (cached per road width and door offset). */
function doorShape({ hw = ROAD_HW, dx = 0 } = {}) {
  const key = `${hw}|${dx}`;
  if (!doorShapes.has(key)) {
    const w = 2 * hw + 10, hole = [dx + DOOR.hole[0], dx + DOOR.hole[1], DOOR.hole[2], DOOR.hole[3]];
    const boxes = wallBoxes([-w / 2, w / 2, 0, DOOR.h], hole);
    doorShapes.set(key, { solids: boxes, ghost: mergeGeometries(boxes), parts: () => wallParts(boxes, hole, { sill: false }) });
  }
  return doorShapes.get(key);
}
const HOLE_BOXES = wallBoxes([-HOLE.w / 2, HOLE.w / 2, -HOLE.h / 2, HOLE.h / 2], HOLE.hole);
// (the door's hole sits on the road: no frame under it)
const doorParts = () => wallParts(DOOR_BOXES, DOOR.hole, { sill: false });
const holeParts = () => wallParts(HOLE_BOXES, HOLE.hole);

// ---------------------------------------------------------------- BOOST PAD
// (user, 2026-10-21: "some boost decals"): a decal dropped on ANY piece (a straight, a lip, a platform, a
// tube's floor) instead of a whole Boost piece. The same glowing chevrons as Boost 32 (roadLook.js mark 4)
// and the same push (carRules BOOST). It FOLLOWS the deck: the builder samples the host piece's surface
// when it is placed and the prop keeps that strip (`strip`: per metre along, its left and right edge in
// the pad's own frame, 4 cm proud of the road — never z-fighting), so a pad on a curl or a bank lies on
// it. The car's rule is a box in the pad's frame (`boost`).
export const BOOST_PAD = { w: 8, L: 12, lift: 0.04 };
let boostTex = null;
/** The chevrons, as roadLook.js draws boost marks: step(0.6, fract(v + |u − 0.5| · 1.2)), one tile per 4 m. */
function boostTexture() {
  if (boostTex) return boostTex;
  const W = 128, H = 64, c = document.createElement("canvas");
  c.width = W; c.height = H;
  const g = c.getContext("2d"), img = g.createImageData(W, H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const u = (x + 0.5) / W, v = 1 - (y + 0.5) / H;
    const on = (v + Math.abs(u - 0.5) * 1.2) % 1 >= 0.6 && Math.abs(u - 0.5) < 0.46;
    const i = (y * W + x) * 4;
    img.data[i] = 0x3f; img.data[i + 1] = 0xd2; img.data[i + 2] = 0xff; img.data[i + 3] = on ? 255 : 0;
  }
  g.putImageData(img, 0, 0);
  boostTex = new THREE.CanvasTexture(c);
  boostTex.colorSpace = THREE.SRGBColorSpace;
  boostTex.wrapS = THREE.ClampToEdgeWrapping;
  boostTex.wrapT = THREE.RepeatWrapping;
  boostTex.anisotropy = 8;
  return boostTex;
}
let boostMat = null;
const boostMaterial = () => (boostMat ??= new THREE.MeshStandardMaterial({
  map: boostTexture(), emissiveMap: boostTexture(), emissive: BOLT, emissiveIntensity: 1.4, roughness: 0.4,
  transparent: true, alphaTest: 0.5, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
}));
/** The pad's surface from its strip ([xL, yL, zL, xR, yR, zR] per sample, pad frame); a flat plate without one. */
function boostGeometry(strip) {
  const { w, L, lift } = BOOST_PAD;
  const rows = strip ?? [L / 2, -L / 2].map((z) => [-w / 2, lift, z, w / 2, lift, z]); // back to front, as a strip
  const pos = [], uv = [], idx = [];
  rows.forEach((r, i) => {
    const along = (i / (rows.length - 1)) * L;
    pos.push(r[0], r[1], r[2], r[3], r[4], r[5]);
    uv.push(0, along / 4, 1, along / 4);
    if (i) { const a = 2 * (i - 1); idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); } // wound so the face points UP (seen from above)
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}
const BOOST_FLAT = boostGeometry(null);
// ---------------------------------------------------------------- JUMP PAD
// (user, 2026-10-21, chosen over a raised plate: "jump decals"): the same decal as the boost pad, ORANGE,
// one big up-arrow in a frame; rolled over with the wheels down it throws the car UP (carRules JUMP: its
// speed along the pad's up is raised to JUMP.v, never added to — two pads in a row don't stack).
let jumpTex = null;
function jumpTexture() {
  if (jumpTex) return jumpTex;
  const W = 128, H = 192, c = document.createElement("canvas");
  c.width = W; c.height = H;
  const g = c.getContext("2d");
  g.fillStyle = g.strokeStyle = "#ff7a1a";
  g.lineWidth = 8;
  g.strokeRect(10, 10, W - 20, H - 20); // the frame (canvas top = the pad's FRONT, the way the car drives)
  g.beginPath(); // the arrow: a head and a shaft, pointing forward / up
  g.moveTo(W / 2, 30); g.lineTo(W - 26, 92); g.lineTo(W / 2 + 18, 92); g.lineTo(W / 2 + 18, H - 30);
  g.lineTo(W / 2 - 18, H - 30); g.lineTo(W / 2 - 18, 92); g.lineTo(26, 92); g.closePath(); g.fill();
  jumpTex = new THREE.CanvasTexture(c);
  jumpTex.colorSpace = THREE.SRGBColorSpace;
  jumpTex.repeat.set(1, 4 / BOOST_PAD.L); // the strip's uv runs a metre per ¼: one picture over the pad
  jumpTex.anisotropy = 8;
  return jumpTex;
}
let jumpMat = null;
const jumpMaterial = () => (jumpMat ??= new THREE.MeshStandardMaterial({
  map: jumpTexture(), emissiveMap: jumpTexture(), emissive: SIGNAL, emissiveIntensity: 1.2, roughness: 0.4,
  transparent: true, alphaTest: 0.5, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
}));
function boostShape(p = {}, material = boostMaterial) {
  const geo = p.strip ? boostGeometry(p.strip) : BOOST_FLAT;
  return {
    ghost: geo,
    parts: () => {
      const g = new THREE.Group();
      const m = new THREE.Mesh(geo, material());
      m.castShadow = false;
      g.add(m);
      return g;
    },
  };
}

// ---------------------------------------------------------------- POLES
// (user, 2026-10-21: "we need some poles"): thin columns standing on the road — cheap, readable, best on
// wide platforms. One build, three layouts: a POLE; a SLALOM (4 poles 18 m apart, ±3 m across, the line
// weaves between them); a GATE (2 poles 8 m apart: drive between, the line aims at its middle).
const POLE = { r: 0.45, h: 6 };
const SLALOM = [-27, -9, 9, 27].map((z, i) => [i % 2 ? -3 : 3, z]);
const GATE = [[-4, 0], [4, 0]];
const POLE_SOLID = new THREE.CylinderGeometry(POLE.r, POLE.r, POLE.h, 10).translate(0, POLE.h / 2, 0);
/** Poles at [x, z] (obstacle frame): one merged mesh per material. */
function polesParts(at) {
  const m = mats();
  const body = [], orange = [], white = [], cap = [];
  for (const [x, z] of at) {
    body.push(new THREE.CylinderGeometry(POLE.r, POLE.r, POLE.h, 20).translate(x, POLE.h / 2, z));
    body.push(new THREE.CylinderGeometry(0.9, 1.0, 0.16, 24).translate(x, 0.08, z)); // its foot plate
    // hazard bands near the top, at the driver's eye: orange glowing / white
    for (let k = 0; k < 4; k++) (k % 2 ? white : orange).push(new THREE.CylinderGeometry(POLE.r + 0.03, POLE.r + 0.03, 0.5, 20).translate(x, POLE.h - 2.4 + k * 0.5, z));
    cap.push(new THREE.CylinderGeometry(POLE.r + 0.05, POLE.r + 0.05, 0.18, 20).translate(x, POLE.h + 0.09, z));
  }
  const g = new THREE.Group();
  g.add(new THREE.Mesh(mergeGeometries(body), m.body));
  g.add(new THREE.Mesh(mergeGeometries(orange), m.signal));
  g.add(new THREE.Mesh(mergeGeometries(white), m.white));
  g.add(new THREE.Mesh(mergeGeometries(cap), m.bolt));
  return g;
}
const polesSolids = (at) => at.map(([x, z]) => POLE_SOLID.clone().translate(x, 0, z));
// (a pole dead ahead: the line starts moving 70 m before it, not 35 — at 130 km/h the autopilot had moved
// only 1.3 m across when it got there and clipped it — passes 2.5 m clear of it, and eases back over 30 m
// (15: its tail swung back in 1.9 m from the pole)
const poleFoot = ([x, z]) => ({ x, z, hx: POLE.r + 0.3, hz: POLE.r + 0.3, lead: 70, tail: 30, clear: 2.5 });

// KNOCKABLE PROPS (physProps.js, user 2026-10-23: the old game's cones, tyres, barrels, swing gate): `phys` is
// their bodies in the obstacle's frame. In the drive they are simulated (the car knocks them flying, they
// never slow it); in the builder they stand as placed. Nothing solid but a gate's posts.
const CONE_ROW = [-6, -3.6, -1.2, 1.2, 3.6, 6].map((x) => body("cone", x, 0));
const TYRE_STACK = [0, 1, 2].map((i) => body("tyre", 0, 0, 0, i * 2 * TIRE_TUBE_R));
// two gates meeting in the middle, hinged at ±GATE_WIDTH: the right one turned round (its panel points −X)
const SWING_GATES = [body("gate", -GATE_WIDTH, 0), body("gate", GATE_WIDTH, 0, Math.PI)];
const GATE_POSTS = [-GATE_WIDTH, GATE_WIDTH].map((x) => new THREE.BoxGeometry(0.34, GATE_POST_HEIGHT, 0.34).translate(x, GATE_POST_HEIGHT / 2, 0));
const physKind = (label, bodies, extra) => ({ label, phys: bodies, parts: () => physLook(bodies), solids: [], decks: [], ghost: physGhost(bodies), ...extra });

// ---------------------------------------------------------------- SIGNS
// (user, 2026-10-23, Apex Rush shots in assets-src/refs/apex-rush: "all those chevron panels … pieces the user
// can place like the obstacles", "those START panels with the START and the chevron look awesome"). Placed on
// a road like an obstacle, but BESIDE or ABOVE it (sign: "pair" — centred, sized by the road's half width
// `hw`; "side" — past the edge on the side you point at, `dx` ±1). Boards and posts are solid (as a rail);
// what hangs over the road is not (a jump never snags on a sign).
const SIGN_YELLOW = 0xffc21a;
let SIGN_MATS = null;
const signMats = () => (SIGN_MATS ??= {
  green: new THREE.MeshStandardMaterial({ color: 0x1d6a26, roughness: 0.6, metalness: 0.05 }),
  black: new THREE.MeshStandardMaterial({ color: 0x0d1016, roughness: 0.55, metalness: 0.15 }),
  post: new THREE.MeshStandardMaterial({ color: 0x2a313d, roughness: 0.5, metalness: 0.4 }),
  yellow: new THREE.MeshStandardMaterial({ color: SIGN_YELLOW, emissive: SIGN_YELLOW, emissiveIntensity: 0.8, roughness: 0.45 }),
});
/** A chevron pointing +x, as a shape: w across, h tall, t thick stroke. */
function chevronShape(w = 1, h = 1.2, t = 0.42) {
  const c = new THREE.Shape();
  c.moveTo(-w / 2, h / 2); c.lineTo(-w / 2 + t, h / 2); c.lineTo(w / 2, 0); c.lineTo(-w / 2 + t, -h / 2); c.lineTo(-w / 2, -h / 2); c.lineTo(w / 2 - t, 0); c.closePath();
  return c;
}
/** The START / FINISH board's face: green, the word in white, lime chevrons at the end `dir` points to (+u / −u). */
function boardFace(word, dir) {
  const W = 1024, H = 192;
  const cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const font = "800 132px \"Barlow Condensed\", \"Arial Narrow\", Impact, sans-serif";
  const draw = () => {
    const g = cv.getContext("2d");
    g.fillStyle = "#1f7a2b"; g.fillRect(0, 0, W, H);
    g.fillStyle = "#16591f"; g.fillRect(0, H - 18, W, 18); g.fillRect(0, 0, W, 10);
    // the chevrons at the FORWARD end, pointing forward
    g.fillStyle = "#9dff00";
    const chev = (x) => { const s = dir; g.beginPath(); g.moveTo(x - 34 * s, 40); g.lineTo(x - 6 * s, 40); g.lineTo(x + 38 * s, 96); g.lineTo(x - 6 * s, 152); g.lineTo(x - 34 * s, 152); g.lineTo(x + 10 * s, 96); g.closePath(); g.fill(); };
    const x0 = dir > 0 ? W - 250 : 250;
    for (let k = 0; k < 3; k++) chev(x0 + dir * k * 70);
    g.fillStyle = "#ffffff";
    g.font = font;
    g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText(word, dir > 0 ? W * 0.38 : W * 0.62, H / 2 + 6);
    tex.needsUpdate = true;
  };
  draw();
  document.fonts?.load?.(font).then(draw, () => {}); // drawn again once the font is in
  return tex;
}
const boardFaces = new Map();
const boardMat = (word, dir) => {
  const k = `${word}|${dir}`;
  if (!boardFaces.has(k)) {
    const map = boardFace(word, dir);
    boardFaces.set(k, new THREE.MeshStandardMaterial({ map, emissiveMap: map, emissive: 0xffffff, emissiveIntensity: 0.35, roughness: 0.55 }));
  }
  return boardFaces.get(k);
};
// START / FINISH: a board on each edge of the road, over the kerb (the rail passes inside it)
const BOARD = { L: 10, h: 1.9, w: 1.3 };
// THE LED BOARDS (user, 2026-10-28: "make the start and finish panels look better, with digital dots for the chevrons
// and text"): the arch header's cabinet (thunderArch.py's 1 m slices and end plates, powder coat) laid along the road
// edge, its two faces LED dots — the word and three chevrons at the end the car drives to (ledSigns.js), bolt blue
// for START, white with checkered rows for FINISH. Collision unchanged (the board's box). Levels by distance
// (ViewLOD, the arch's). Without the kit file: the old green board.
const HEAD_Y0 = 7.05, LED_Y0 = 7.25, LED_Y1 = 9.15, LED_Z = 0.55; // thunderArch.py HY0, HY0 + LIP, HY1 − LIP, LZ
function ledBoards(kit, word, xs) {
  const g = new THREE.Group(), lod = new ViewLOD();
  const rot = new THREE.Matrix4().makeRotationY(Math.PI / 2), M = new THREE.Matrix4(), S = new THREE.Matrix4();
  for (let i = 0; i < 3; i++) {
    const geos = [];
    const put = (part, x, xk, sx = 1) => {
      // the kit's frame (x along the header) → the board's (z along the road), stood on the deck
      M.makeTranslation(x, 0.01 - HEAD_Y0, 0).multiply(rot).multiply(S.makeTranslation(xk, 0, 0)).multiply(new THREE.Matrix4().makeScale(sx, 1, 1));
      const geo = kit.parts[part][i].clone().applyMatrix4(M);
      if (sx < 0) { const ix = geo.index.array; for (let t = 0; t < ix.length; t += 3) { const k = ix[t + 1]; ix[t + 1] = ix[t + 2]; ix[t + 2] = k; } }
      geos.push(geo);
    };
    for (const x of xs) {
      for (let k = 0; k < BOARD.L; k++) put("head", x, -BOARD.L / 2 + k + 0.5);
      put("cap", x, BOARD.L / 2); put("cap", x, -BOARD.L / 2, -1);
    }
    const m = new THREE.Mesh(mergeGeometries(geos), kit.material.head);
    for (const q of geos) q.dispose();
    m.castShadow = m.receiveShadow = true;
    lod.addLevel(m, i ? ARCH_LOD_FAR[i - 1] : 0);
  }
  g.add(lod);
  const finish = word === "FINISH", h = LED_Y1 - LED_Y0, y = (LED_Y0 + LED_Y1) / 2 - HEAD_Y0 + 0.01;
  for (const x of xs) {
    const s = Math.sign(x);
    // toward the road (the chevrons at the end the car drives to, as the old board's) and the other way
    // (the road face turned −s·90° as the old board's, so its +u runs forward; the outer one the other way)
    for (const [side, dir, turn] of [[-s, s < 0 ? 1 : -1, -s * Math.PI / 2], [s, s < 0 ? -1 : 1, s * Math.PI / 2]]) {
      const mat = ledSignMaterial(kit, { word, w: BOARD.L, h, chevrons: dir, checker: finish, palette: finish ? "finish" : "start" });
      const face = new THREE.Mesh(new THREE.PlaneGeometry(BOARD.L, h).rotateY(turn), mat);
      face.position.set(x + side * LED_Z, y, 0);
      face.userData.noShadow = true;
      g.add(face);
    }
  }
  return g;
}
const boardShapes = new Map();
function boardShape(word) {
  return ({ hw = ROAD_HW } = {}) => {
    const key = `${word}|${hw}`;
    if (!boardShapes.has(key)) {
      const xs = [-1, 1].map((s) => s * (hw - 0.25));
      const solids = xs.map((x) => box(BOARD.w, BOARD.h, BOARD.L, x, BOARD.h / 2, 0));
      const parts = () => {
        const kit = physKit("arch");
        if (kit) return ledBoards(kit, word, xs);
        const m = signMats(), g = new THREE.Group();
        g.add(new THREE.Mesh(mergeGeometries(solids), m.green));
        // the faces toward the road: the left board's text runs along −Z (forward, as you read it), the right's +Z
        for (const s of [-1, 1]) {
          const face = new THREE.PlaneGeometry(BOARD.L - 0.2, BOARD.h - 0.2).rotateY(-s * Math.PI / 2).translate(s * (hw - 0.25 - BOARD.w / 2 - 0.02), BOARD.h / 2, 0);
          g.add(new THREE.Mesh(face, boardMat(word, s < 0 ? 1 : -1)));
        }
        return g;
      };
      boardShapes.set(key, { solids, ghost: mergeGeometries(solids), parts });
    }
    return boardShapes.get(key);
  };
}
// CHEVRON PANEL: a tall sign past the road's edge, facing the car, chevrons pointing toward the road (the way it
// takes you) — the LED cabinet below (its old procedural look removed, user 2026-10-28: "remove the old chevron and
// use the new one"); its plain box stays the look only if the model file is missing
const PANEL = { w: 3.4, h: 4.6, t: 0.35, gap: 1.2 };
const panelShapes = new Map();
function panelShape({ hw = ROAD_HW, dx = 1 } = {}) {
  const side = dx < 0 ? -1 : 1, key = `${hw}|${side}`;
  if (!panelShapes.has(key)) {
    const x = side * (hw + PANEL.gap + PANEL.w / 2), y0 = -1.0; // its foot level with the slab's underside
    const solids = [box(PANEL.w, PANEL.h, PANEL.t, x, y0 + PANEL.h / 2, 0)];
    const parts = () => {
      const model = physModel("chevron");
      if (model) return chevronCabinet(model, x, side);
      const g = new THREE.Group();
      g.add(new THREE.Mesh(solids[0], signMats().black));
      return g;
    };
    panelShapes.set(key, { solids, ghost: solids[0], parts });
  }
  return panelShapes.get(key);
}
// THE CHEVRON SIGN from Blender (tools/blender/thunderChevron.py; user, 2026-10-28: "it should have bevel; the chevron
// itself with digital dots"): an LED cabinet on the panel's own box (its solid unchanged), the dots the old game's shader
// (v3 ledMatrix.js, chevron mode: one material, every sign). Authored for the RIGHT side (its arm and chevrons toward −x,
// the road); the left side's is its mirror. Its levels by distance (three's LOD: the renderer picks one per camera).
export const CHEVRON_LOD_FAR = [40, 110];
export { ViewLOD } from "./physProps.js";
const mirrored = new Map();
function mirrorX(geo) {
  if (!mirrored.has(geo)) {
    const g = geo.clone().applyMatrix4(new THREE.Matrix4().makeScale(-1, 1, 1));
    const ix = g.index.array; // (mirrored, each triangle turned round: its front still outward)
    for (let i = 0; i < ix.length; i += 3) { const t = ix[i + 1]; ix[i + 1] = ix[i + 2]; ix[i + 2] = t; }
    mirrored.set(geo, g);
  }
  return mirrored.get(geo);
}
function chevronCabinet(model, x, side) {
  const geo = (g) => (side < 0 ? mirrorX(g) : g);
  const g = new THREE.Group();
  const lod = new ViewLOD();
  model.lods.forEach((l, i) => lod.addLevel(new THREE.Mesh(geo(l), model.material), i ? CHEVRON_LOD_FAR[i - 1] : 0));
  lod.position.x = x;
  g.add(lod);
  const led = new THREE.Mesh(geo(model.led.geometry), model.led.material);
  led.position.x = x;
  led.userData.noShadow = true; // (inside the cabinet: nothing to cast)
  g.add(led);
  return g;
}
// LANDING SIGN: two posts at the road's edges, a down-chevron panel on each, a yellow X hanging between
// them on a thin bar: "land here" (Apex Rush shot 09). The posts are solid; the bar and the X are not.
const AIM = { h: 8, post: 0.35 };
const aimShapes = new Map();
function aimShape({ hw = ROAD_HW } = {}) {
  if (!aimShapes.has(hw)) {
    const xs = [-1, 1].map((s) => s * (hw + 0.8));
    const solids = xs.map((x) => box(AIM.post, AIM.h + 1, AIM.post, x, (AIM.h - 1) / 2, 0));
    const parts = () => {
      const m = signMats(), g = new THREE.Group();
      g.add(new THREE.Mesh(mergeGeometries([...solids, box(2 * (hw + 0.8), 0.22, 0.22, 0, AIM.h, 0)]), m.post));
      g.add(new THREE.Mesh(mergeGeometries(xs.map((x) => box(2.2, 2.4, 0.25, x, AIM.h - 2.2, 0.25))), m.black));
      const yellow = [];
      for (const x of xs) for (const dy of [0.45, -0.35]) yellow.push(new THREE.ShapeGeometry(chevronShape(0.75, 1.3, 0.34)).rotateZ(-Math.PI / 2).translate(x, AIM.h - 2.2 + dy, 0.4));
      // the X: two crossed bars, hanging from the middle of the bar
      for (const a of [Math.PI / 4, -Math.PI / 4]) yellow.push(box(0.42, 2.6, 0.2).rotateZ(a).translate(0, AIM.h - 2.0, 0));
      g.add(new THREE.Mesh(mergeGeometries(yellow), m.yellow));
      return g;
    };
    aimShapes.set(hw, { solids, ghost: mergeGeometries(solids), parts });
  }
  return aimShapes.get(hw);
}
const signKind = (label, sign, shape, hint) => ({ label, sign, shape, parts: (o) => shape().parts(o), solids: shape().solids, decks: [], ghost: shape().ghost, hint });

// ---------------------------------------------------------------- ON THE GROUND (the physics lab; user, 2026-10-29:
// "add some jumps and ramps — not road jumps, see my old game, ramps I place on the ground; they show behaviour too,
// like collision … things to debug suspension"). The ramps are the OLD GAME'S shapes (modularRoadParkour.js): each
// solid carries its drive surface alone (userData.deckGeometry: the wheels' ground) and its cheeks + a low inset
// backstop (userData.solidGeometry: what the body hits) — never the lip cap (the old "straight up at the tip" pop).
// Frame: the low edge at z = 0, rising toward −Z (the way the car drives), feet on y = 0.
function groundRamp(geo, lipZ, lipY, w) {
  return () => {
    const m = mats(), g = new THREE.Group();
    g.add(new THREE.Mesh(geo, m.body));
    // the lip: a glowing edge (reads from far, and how high it stands)
    g.add(new THREE.Mesh(box(w + 0.04, 0.12, 0.12, 0, lipY + 0.02, lipZ), m.bolt));
    return g;
  };
}
const rampDef = (label, geo, lipZ, lipY, w, hint) => ({
  label, parts: groundRamp(geo, lipZ, lipY, w), solids: [geo.userData.solidGeometry], decks: [geo.userData.deckGeometry], ghost: geo,
  footprint: { hx: w / 2, hz: -lipZ / 2 }, ground: true, hint,
});
const JUMP_RAMP = jumpRampGeometry(12, 22, 6), KICKER_RAMP = kickerRampGeometry(12, 18, 4), SLOPE_RAMP = rampGeometry(12, 20, 20 * Math.PI / 180);
const SIDE_RAMP = rampGeometry(2.6, 12, 7 * Math.PI / 180);
// RUMBLE KERB: 0.9 m wide, 12 m long, round humps 12 cm high every 0.9 m, red / white — the wheels of ONE side
// on it (the roll, the springs one side at a time)
const KERB = { w: 0.9, L: 12, h: 0.12, pitch: 0.9 };
function kerbGeometry() {
  const n = Math.round(KERB.L / 0.1), hw = KERB.w / 2, pos = [], col = [], deck = [];
  const y = (z) => KERB.h * Math.max(0, Math.sin((Math.PI * -z) / KERB.pitch)) ** 0.7 + 0.01;
  const red = new THREE.Color(0xd8262b), white = new THREE.Color(0xeef1f5);
  for (let i = 0; i < n; i++) {
    const z0 = -i * 0.1, z1 = -(i + 1) * 0.1, c = Math.floor(-z0 / KERB.pitch) % 2 ? white : red;
    const q = [[-hw, y(z0), z0], [hw, y(z0), z0], [hw, y(z1), z1], [-hw, y(z1), z1]];
    for (const v of [q[0], q[1], q[2], q[0], q[2], q[3]]) { pos.push(...v); deck.push(...v); col.push(c.r, c.g, c.b); }
    for (const sx of [-hw, hw]) for (const v of [[sx, 0, z0], [sx, y(z0), z0], [sx, y(z1), z1], [sx, 0, z0], [sx, y(z1), z1], [sx, 0, z1]]) { pos.push(...v); col.push(c.r * 0.6, c.g * 0.6, c.b * 0.6); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  const d = new THREE.BufferGeometry();
  d.setAttribute("position", new THREE.Float32BufferAttribute(deck, 3));
  d.computeVertexNormals();
  g.userData.deckGeometry = d;
  return g;
}
const KERB_GEO = kerbGeometry();
// A STEP: a 25 cm high plate, 8 m across, 10 m long — up onto it, along, off it (a drop the springs take)
const STEP = { w: 8, L: 10, h: 0.25 };
const STEP_DECK = new THREE.PlaneGeometry(STEP.w, STEP.L).rotateX(-Math.PI / 2).translate(0, STEP.h, -STEP.L / 2);
// MOVERS FOR THE LAB (collision with a moving thing): the moving part's pose is a function of the race clock,
// `pose(t, out)` (a Matrix4 in the obstacle's frame), its velocity at a contact taken from that pose — any motion,
// not only the sweeper's turn
const PEND = { pivotY: 9, arm: 6.5, amp: 55 * Math.PI / 180, period: 3.6 };
const PEND_BOB = box(3, 2, 1.6, 0, PEND.pivotY - PEND.arm, 0);
const PEND_FRAME = [box(0.5, PEND.pivotY + 0.5, 0.5, -7, (PEND.pivotY + 0.5) / 2, 0), box(0.5, PEND.pivotY + 0.5, 0.5, 7, (PEND.pivotY + 0.5) / 2, 0)];
const SLIDE = { amp: 5, period: 4 };
const SLIDE_WALL = box(4, 2.4, 1, 0, 1.2, 0);
const LOWBAR = { len: 14, y: 0.35, t: 0.4, period: 4 };
const LOWBAR_ARM = box(LOWBAR.len, LOWBAR.t, LOWBAR.t, 0, LOWBAR.y, 0);
const _pm = new THREE.Matrix4(), _pm2 = new THREE.Matrix4();
// (`lookOnly`: drawn, never collided — the pendulum's beam over the lane and its rod)
function moverParts(staticGeos, armGeo, armMat = "signal", { lookStatic = [], lookArm = [] } = {}) {
  return () => {
    const m = mats(), g = new THREE.Group();
    for (const s of [...staticGeos, ...lookStatic]) g.add(new THREE.Mesh(s, m.body));
    const arm = new THREE.Group();
    arm.name = "arm";
    arm.add(new THREE.Mesh(armGeo, m[armMat]));
    for (const a of lookArm) arm.add(new THREE.Mesh(a, m.white));
    g.add(arm);
    return g;
  };
}
const MOVERS = {
  ob_pendulum: {
    label: "Pendulum", parts: moverParts(PEND_FRAME, PEND_BOB, "signal", {
      lookStatic: [box(14.5, 0.5, 0.5, 0, PEND.pivotY + 0.25, 0)],
      lookArm: [box(0.18, PEND.arm - 1, 0.18, 0, PEND.pivotY - (PEND.arm - 1) / 2, 0)],
    }), solids: PEND_FRAME, decks: [], ghost: mergeGeometries([...PEND_FRAME, PEND_BOB]),
    mover: { arm: PEND_BOB, pose: (t, out) => out.makeTranslation(0, PEND.pivotY, 0).multiply(_pm.makeRotationZ(PEND.amp * Math.sin((2 * Math.PI * t) / PEND.period))).multiply(_pm2.makeTranslation(0, -PEND.pivotY, 0)) },
    footprint: { hx: 7.5, hz: 1 }, ground: true, hint: "A block swinging across the lane (14 m frame): time it, or take the hit",
  },
  ob_slider: {
    label: "Sliding wall", parts: moverParts([], SLIDE_WALL), solids: [], decks: [], ghost: SLIDE_WALL,
    mover: { arm: SLIDE_WALL, pose: (t, out) => out.makeTranslation(SLIDE.amp * Math.sin((2 * Math.PI * t) / SLIDE.period), 0, 0) },
    footprint: { hx: 7, hz: 0.5 }, ground: true, hint: "A wall sliding left and right across 14 m",
  },
  ob_lowbar: {
    label: "Low spinning bar", parts: moverParts([box(0.6, 0.8, 0.6, 0, 0.4, 0)], LOWBAR_ARM), solids: [], decks: [], ghost: LOWBAR_ARM,
    mover: { arm: LOWBAR_ARM, pose: (t, out) => out.makeRotationY((2 * Math.PI * t) / LOWBAR.period) },
    footprint: { hx: 7, hz: 7 }, ground: true, hint: "A bar 35 cm off the ground, turning: it hits the wheels' height",
  },
};

const GROUND = {
  ...MOVERS,
  ob_ramp_jump: rampDef("Jump ramp", JUMP_RAMP, -22, 6, 12, "On the ground: a scooped ramp, 6 m high, ~23° at the lip"),
  ob_ramp_kicker: rampDef("Convex kicker", KICKER_RAMP, -18, 4, 12, "On the ground: steep first, flat at the top — a launch that rolls over"),
  ob_ramp_slope: rampDef("Slope ramp 20°", SLOPE_RAMP, -20, 20 * Math.sin(20 * Math.PI / 180), 12, "On the ground: a straight 20° wedge, a 6.8 m drop off its back"),
  ob_ramp_side: rampDef("Side ramp", SIDE_RAMP, -12, 12 * Math.sin(7 * Math.PI / 180), 2.6, "2.6 m wide: under the wheels of ONE side — the car tips, lands on one side"),
  ob_kerb: {
    label: "Rumble kerb", ground: true, solids: [], decks: [KERB_GEO.userData.deckGeometry], ghost: KERB_GEO,
    parts: () => { const g = new THREE.Group(); g.add(new THREE.Mesh(KERB_GEO, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7 }))); return g; },
    hint: "Humps 12 cm high: drive one side over it (the springs, the roll)",
  },
  ob_step: {
    label: "Step 25 cm", ground: true, solids: [], decks: [STEP_DECK], ghost: box(STEP.w, STEP.h, STEP.L, 0, STEP.h / 2, -STEP.L / 2),
    parts: () => { const m = mats(), g = new THREE.Group(); g.add(new THREE.Mesh(box(STEP.w, STEP.h, STEP.L, 0, STEP.h / 2, -STEP.L / 2), m.top)); g.add(new THREE.Mesh(box(STEP.w + 0.02, 0.05, 0.08, 0, STEP.h, 0), m.signal)); return g; },
    hint: "Up 25 cm, along, down: how the springs take a step",
  },
};

export const OBSTACLES = {
  ...GROUND,
  ob_block: { label: "Block", parts: blockParts, solids: [BLOCK_SOLID], decks: [BLOCK_DECK], ghost: BLOCK_SOLID, hint: "Dodge it, or jump onto it" },
  ob_sweeper: { label: "Sweeper", parts: sweeperParts, solids: [SWEEP_POST], decks: [], ghost: mergeGeometries([SWEEP_POST, SWEEP_ARM]), mover: { arm: SWEEP_ARM, omega: (2 * Math.PI) / SWEEP_PERIOD }, hint: "A bar turning over the road: time it" },
  ob_wall_door: { label: "Wall · door", parts: doorParts, solids: DOOR_BOXES, decks: [], ghost: mergeGeometries(DOOR_BOXES), shape: doorShape, hint: "A wall across the road: drive through its door" },
  // `air`: placed on a jump's flight, not on the road (the builder's arc snap)
  ob_wall_hole: { label: "Wall · hole", parts: holeParts, solids: HOLE_BOXES, decks: [], ghost: mergeGeometries(HOLE_BOXES), air: true, hint: "A wall in the air: fly through its hole" },
  ob_pole: { label: "Pole", parts: () => polesParts([[0, 0]]), solids: polesSolids([[0, 0]]), decks: [], ghost: mergeGeometries(polesSolids([[0, 0]])), footprints: [poleFoot([0, 0])], hint: "A pole on the road: go round it" },
  ob_slalom: { label: "Slalom", halfW: 3.5, parts: () => polesParts(SLALOM), solids: polesSolids(SLALOM), decks: [], ghost: mergeGeometries(polesSolids(SLALOM)), footprints: SLALOM.map(poleFoot), hint: "Four poles, left and right: weave through" },
  ob_gate: { label: "Pole gate", halfW: 4.5, parts: () => polesParts(GATE), solids: polesSolids(GATE), decks: [], ghost: mergeGeometries(polesSolids(GATE)), aimAt: { hz: POLE.r }, hint: "Two poles 8 m apart: drive between them" },
  // `decal`: lies on the road, conformed to it (the builder fills `strip`); nothing solid
  ob_boost: { label: "Boost pad", parts: boostShape().parts, solids: [], decks: [], ghost: BOOST_FLAT, shape: boostShape, decal: true, boost: { hx: BOOST_PAD.w / 2, hz: BOOST_PAD.L / 2 }, hint: "Drive over it: a push for 2 s" },
  ob_cone: physKind("Cone", [body("cone")], { hint: "A traffic cone: knock it flying" }),
  ob_cones: physKind("Cone row", CONE_ROW, { halfW: 6.3, hint: "Six cones across the road" }),
  ob_tyres: physKind("Tyre stack", TYRE_STACK, { hint: "Three tyres stacked: they scatter" }),
  ob_barrel: physKind("Oil barrel", [body("barrel")], { hint: "A heavy drum: it rolls away" }),
  ob_swing_gate: physKind("Swing gates", SWING_GATES, { halfW: 4.6, solids: GATE_POSTS, hint: "Two gates across the middle: smash through, or go round" }),
  // SIGNS (above): beside or over the road
  sg_start: signKind("START panels", "pair", boardShape("START"), "A green board on each edge of the road"),
  sg_finish: signKind("FINISH panels", "pair", boardShape("FINISH"), "A green board on each edge of the road"),
  sg_chevron: signKind("Chevron panel", "side", panelShape, "A tall black board past the edge: the way the road goes"),
  sg_aim: signKind("Landing sign", "pair", aimShape, "Two posts and a yellow X over the road: land here"),
  ob_jump: { label: "Jump pad", parts: boostShape({}, jumpMaterial).parts, solids: [], decks: [], ghost: BOOST_FLAT, shape: (p) => boostShape(p, jumpMaterial), decal: true, boost: { hx: BOOST_PAD.w / 2, hz: BOOST_PAD.L / 2, jump: true }, hint: "Drive over it: it throws the car up" },
};
/** The zones of a track's pads, for carRules: { inv (world → pad frame), hx, hz }, and for a JUMP pad
 * `jump` and `up` (the pad's up in the world: the direction it throws). */
export function boostZones(props = []) {
  return props.filter((p) => OBSTACLES[p.kind]?.boost).map((p) => {
    const M = new THREE.Matrix4().fromArray(p.M);
    const z = { inv: M.clone().invert(), ...OBSTACLES[p.kind].boost };
    if (z.jump) z.up = new THREE.Vector3(0, 1, 0).transformDirection(M);
    return z;
  });
}
export const isObstacle = (id) => !!OBSTACLES[id];
/** A placed obstacle's definition: its kind's, with the parts / solids / ghost of ITS shape (a door's offset). */
export const shapeOf = (kind, p = {}) => (OBSTACLES[kind].shape ? { ...OBSTACLES[kind], ...OBSTACLES[kind].shape(p) } : OBSTACLES[kind]);
// what stands IN THE WAY, in the obstacle's frame (half across x, half along z; m): the autopilot's line
// goes round it (avoidObstacles)
OBSTACLES.ob_block.footprint = { hx: BW / 2, hz: BD / 2 };
// (the poles carry `footprints`, one per pole, in the table)
OBSTACLES.ob_sweeper.footprint = { hx: POST_R + 0.3, hz: POST_R + 0.3 };
// a DOOR is the other way round: the line goes THROUGH it (its centre), not round it
OBSTACLES.ob_wall_door.aimAt = { hz: WALL_T / 2 };

/**
 * THE AUTOPILOT'S LINE ROUND THE OBSTACLES (builder test lap, drive page autopilot): a copy of the ride
 * whose points ease out sideways ~35 m before an obstacle that stands on the line, to the side with room
 * (2 m clear of it, inside the kerbs), hold past it and ease back. The race's own ride (gates) is untouched.
 * @param ride  [{P, T, U, …}]  @param props track.props  @param hw the road's half width
 */
export function avoidObstacles(ride, props = [], hw = ROAD_HW) {
  const shift = new Float32Array(ride.length);
  const C = new THREE.Vector3(), ax = new THREE.Vector3(), az = new THREE.Vector3(), R = new THREE.Vector3(), d = new THREE.Vector3();
  const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
  for (const p of props) {
    const def = OBSTACLES[p.kind];
    if (!def) continue;
    // what to steer ROUND (one footprint, or one per pole) or THROUGH (aimAt: a door, a gate)
    const feet = def.footprints ?? (def.footprint ? [def.footprint] : def.aimAt ? [def.aimAt] : []);
    const aim = !def.footprint && !def.footprints;
    const M = new THREE.Matrix4().fromArray(p.M);
    ax.set(1, 0, 0).transformDirection(M);
    az.set(0, 0, 1).transformDirection(M);
    for (const f of feet) {
    C.setFromMatrixPosition(M).addScaledVector(ax, (f.x ?? 0) + (aim && p.dx ? p.dx : 0)).addScaledVector(az, f.z ?? 0); // (the door's middle)
    ride.forEach((r, i) => {
      if (r.tube || r.air) return;
      R.crossVectors(r.T, r.U ?? UP).normalize();
      d.subVectors(C, r.P);
      if (Math.abs(d.dot(r.U ?? UP)) > 4) return; // another level (a crossover)
      const lat = d.dot(R), lon = d.dot(r.T);
      const across = Math.abs((f.hx ?? 0) * ax.dot(R)) + Math.abs(f.hz * az.dot(R));
      const along = Math.abs((f.hx ?? 0) * ax.dot(r.T)) + Math.abs(f.hz * az.dot(r.T));
      if (Math.abs(lat) > hw + across) return; // beside the road
      // weight: 0 → 1 over the 35 m before it, 1 alongside, back to 0 over 15 m after
      const w = lon > along ? smooth(1 - (lon - along) / (f.lead ?? 35)) : lon < -along ? smooth(1 - (-along - lon) / (f.tail ?? 15)) : 1;
      if (w <= 0) return;
      if (aim) { if (Math.abs(lat * w) > Math.abs(shift[i])) shift[i] = lat * w; return; }
      const room = hw - 1.6;
      const c = f.clear ?? 2;
      let target = lat > 0 ? lat - across - c : lat + across + c; // pass on the side away from its centre
      if (Math.abs(target) > room) target = lat > 0 ? lat + across + c : lat - across - c; // no room: the other side
      if (Math.abs(target) > room) return; // it blocks the road: nothing to steer round
      const s = target * w;
      if (Math.abs(s) > Math.abs(shift[i])) shift[i] = s;
    });
    }
  }
  return ride.map((r, i) => {
    if (!shift[i]) return r;
    R.crossVectors(r.T, r.U ?? UP).normalize();
    return { ...r, P: r.P.clone().addScaledVector(R, shift[i]) };
  });
}
const UP = new THREE.Vector3(0, 1, 0);

/** One obstacle's look (a fresh group; geometry and materials shared). */
export function obstacleLook(kind, p, o = {}) {
  const g = shapeOf(kind, p).parts(o);
  g.traverse((o) => { if (o.isMesh) { o.castShadow = !OBSTACLES[kind].decal && !o.userData.noShadow; o.receiveShadow = true; } });
  return g;
}

/**
 * Everything a page needs for a track's obstacles.
 * @param props  track.props
 * @param o.look  build the meshes (false in Node tests)
 * @returns {{ group, decks: {geometry, M}[], solids: {geometry, M}[], movers: object[], setTime(t: number): void }}
 */
export function buildObstacleSet(props = [], { look = true, physics = false } = {}) {
  const group = new THREE.Group();
  group.name = "obstacles";
  const decks = [], solids = [], movers = [], bodies = [];
  const up = new THREE.Vector3();
  for (const p of props) {
    if (!OBSTACLES[p.kind]) continue;
    const def = shapeOf(p.kind, p);
    const M = new THREE.Matrix4().fromArray(p.M);
    for (const g of def.solids) solids.push({ geometry: g, M });
    for (const g of def.decks) decks.push({ geometry: g, M });
    let vis = null, armVis = null;
    // physics: knockable bodies leave the static look — the drive simulates them (physProps.createPhysProps)
    if (physics && def.phys) { for (const b of def.phys) bodies.push({ kind: b.kind, M: M.clone().multiply(b.local) }); continue; }
    if (look) {
      vis = obstacleLook(p.kind, p);
      vis.matrixAutoUpdate = false;
      vis.matrix.copy(M);
      vis.userData.uid = p.uid;
      group.add(vis);
      armVis = vis.getObjectByName("arm") ?? null;
    }
    if (def.mover) {
      // the arm turns about the obstacle's own up, through its origin
      const proxy = { geometry: def.mover.arm, matrixWorld: M.clone(), updateMatrixWorld() {} };
      const pivot = new THREE.Vector3().setFromMatrixPosition(M);
      up.set(0, 1, 0).transformDirection(M);
      const angVel = up.clone().multiplyScalar(def.mover.omega);
      const rot = new THREE.Matrix4();
      const pose = def.mover.pose ?? null;
      const mv = {
        uid: p.uid, proxy, armVis, M, omega: def.mover.omega, angVel, pivot, rot, pose, t: 0,
        bvh: new RigidBvh(proxy),
        /** the bar's surface velocity at a contact: ω × r about the post — or, for a posed mover, the point carried
         *  from the pose now to the pose 10 ms on */
        velocityAt(pt, out) {
          if (!pose) { _r.subVectors(pt, pivot); return out.crossVectors(angVel, _r); }
          const h = 0.01;
          _vm.copy(mv.proxy.matrixWorld).invert();
          _r.copy(pt).applyMatrix4(_vm); // (the point in the moving part's frame)
          pose(mv.t + h, _vm2);
          _vm.multiplyMatrices(M, _vm2);
          return out.copy(_r).applyMatrix4(_vm).sub(pt).multiplyScalar(1 / h);
        },
      };
      movers.push(mv);
    }
  }
  function setTime(t) {
    for (const m of movers) {
      m.t = t;
      if (m.pose) m.pose(t, m.rot); else m.rot.makeRotationY(m.omega * t);
      m.proxy.matrixWorld.multiplyMatrices(m.M, m.rot);
      if (m.armVis) { m.armVis.matrixAutoUpdate = false; m.armVis.matrix.copy(m.rot); m.armVis.matrixWorldNeedsUpdate = true; }
    }
  }
  setTime(0);
  return { group, decks, solids, movers, bodies, setTime };
}
