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
import { RigidBvh, BvhSet } from "../../../../v3/play/modularRoadRigidBvh.js";
import { body, physLook, physGhost, physModel, physKit, physPalm, physLedBuilder, ViewLOD } from "./physProps.js";
import { createFlag as createFlagProp } from "../../../../v3/props/liveProps.js";
import { buildChainLinkFenceMesh } from "../../../../v3/props/objects/chainLinkFence.js";
import { buildBarbWireMesh } from "../../../../v3/props/objects/barbWire.js";
import { buildAdBillboardMesh, buildAdTotemMesh, setAdPosterImage, AD_BILLBOARD, AD_TOTEM } from "../../../modular-road-v3/modularRoadAdBillboard.js";
import { buildAdPrismMesh, setAdPrismImages, AD_PRISM } from "../../../modular-road-v3/modularRoadAdPrism.js";
import { adPoster } from "./adPosters.js";
import { ledSignMaterial, LED_PITCH } from "./ledSigns.js";
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
// A LAB SIGN (user, 2026-10-29: "the bumps are almost invisible … add a sign that there are bumps so I know what this
// road is for"): an amber LED board on two posts, facing +Z (the physics lab's roads run −Z: the car comes at it), the
// word in the dot font, the board as wide as the word. Placed by the lab beside a road (props with `word`), never from
// the palette. Its posts and board are solid.
const LABEL = { h: 1.0, t: 0.3, y0: 2.4, post: 0.18, margin: 4 };
const labelShapes = new Map();
function labelShape({ word = "LAB" } = {}) {
  if (!labelShapes.has(word)) {
    const cols = word.length * 7 - 2 + 2 * LABEL.margin, w = cols * LED_PITCH, px = w / 2 - 0.5;
    const board = box(w + 0.2, LABEL.h + 0.2, LABEL.t, 0, LABEL.y0 + LABEL.h / 2, 0);
    const posts = [-px, px].map((x) => box(LABEL.post, LABEL.y0, LABEL.post, x, LABEL.y0 / 2, -LABEL.t / 2 - LABEL.post / 2));
    const solids = [board, ...posts];
    const parts = () => {
      const g = new THREE.Group(), m = signMats();
      g.add(new THREE.Mesh(board, m.black), new THREE.Mesh(mergeGeometries(posts), m.post));
      const kit = physKit("arch");
      if (kit) {
        const face = new THREE.Mesh(new THREE.PlaneGeometry(w, LABEL.h), ledSignMaterial(kit, { word, w, h: LABEL.h, palette: "amber" }));
        face.position.set(0, LABEL.y0 + LABEL.h / 2, LABEL.t / 2 + 0.01);
        face.userData.noShadow = true;
        g.add(face);
      }
      return g;
    };
    labelShapes.set(word, { solids, ghost: mergeGeometries(solids), parts });
  }
  return labelShapes.get(word);
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

// ---------------------------------------------------------------- STATIC OBSTACLES, SET 2
// (user, 2026-11-01: "compared to the old game some pieces are missing … a container, a road block, a concrete
// barrier, the rounded hole gate and hole wall, the arch"): designed new in Thunderline's look — the old game's
// ones were the brief for what each does, not the meshes.
const extrude = (shape, depth, bevel = 0) => {
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 40 });
  return g.translate(0, 0, -depth / 2);
};
let MATS2 = null;
const mats2 = () => (MATS2 ??= {
  steel: new THREE.MeshStandardMaterial({ color: 0x245a78, roughness: 0.62, metalness: 0.35 }),
  steelDark: new THREE.MeshStandardMaterial({ color: 0x173a50, roughness: 0.7, metalness: 0.3 }),
  concrete: new THREE.MeshStandardMaterial({ color: 0xb9b6ad, roughness: 0.92, metalness: 0 }),
  red: new THREE.MeshStandardMaterial({ color: 0xd8262b, roughness: 0.45, metalness: 0 }),
  whiteP: new THREE.MeshStandardMaterial({ color: 0xeef0f2, roughness: 0.45, metalness: 0 }),
  orange: new THREE.MeshStandardMaterial({ color: 0xff7a1a, roughness: 0.5, metalness: 0.1 }),
});
/** Boxes filling a wall [x0,x1]×[y0,y1] round a circle (cx, cy, r) in 0.4 m strips — its solids (the hole stays open). */
function roundHoleBoxes([x0, x1, y0, y1], cx, cy, r, t = WALL_T) {
  const out = [], step = 0.4;
  for (let ya = y0; ya < y1 - 1e-6; ya += step) {
    const yb = Math.min(y1, ya + step);
    const inBand = ya < cy + r && yb > cy - r;
    // (the chord at the strip's edge nearest the middle: the widest — the boxes never stand in the visible hole)
    const dy = ya <= cy && yb >= cy ? 0 : Math.min(Math.abs(ya - cy), Math.abs(yb - cy));
    const c = inBand ? Math.sqrt(Math.max(0, r * r - dy * dy)) : 0;
    const spans = c > 0 ? [[x0, cx - c], [cx + c, x1]] : [[x0, x1]];
    for (const [a, b] of spans) if (b - a > 1e-3) out.push(box(b - a, yb - ya, t, (a + b) / 2, (ya + yb) / 2, 0));
  }
  return out;
}

// CONTAINER: a 40 ft box along the road — steer round it, or land on its roof
const CT = { w: 2.44, h: 2.6, L: 12.2 };
function containerParts() {
  const m = mats2(), mm = mats(), g = new THREE.Group();
  g.add(new THREE.Mesh(box(CT.w - 0.12, CT.h - 0.1, CT.L - 0.1, 0, CT.h / 2, 0), m.steel));
  // the corrugation: ribs down both sides; the corner posts and rails darker
  const ribs = [];
  for (let z = -CT.L / 2 + 0.35; z < CT.L / 2 - 0.3; z += 0.3) for (const s of [1, -1]) ribs.push(box(0.06, CT.h - 0.36, 0.14, s * (CT.w / 2 - 0.05), CT.h / 2, z));
  g.add(new THREE.Mesh(mergeGeometries(ribs), m.steel));
  const frame = [];
  for (const sx of [1, -1]) for (const sz of [1, -1]) frame.push(box(0.16, CT.h, 0.16, sx * (CT.w / 2 - 0.08), CT.h / 2, sz * (CT.L / 2 - 0.08)));
  for (const y of [0.09, CT.h - 0.09]) for (const sx of [1, -1]) frame.push(box(0.14, 0.18, CT.L, sx * (CT.w / 2 - 0.07), y, 0));
  for (const y of [0.09, CT.h - 0.09]) for (const sz of [1, -1]) frame.push(box(CT.w, 0.18, 0.14, 0, y, sz * (CT.L / 2 - 0.07)));
  // the doors' lock bars on the end facing the car (+Z)
  for (const x of [-0.85, -0.3, 0.3, 0.85]) frame.push(box(0.05, CT.h - 0.4, 0.05, x, CT.h / 2, CT.L / 2 + 0.03));
  g.add(new THREE.Mesh(mergeGeometries(frame), m.steelDark));
  // the roof you land on, and a glowing band down each side (reads from far)
  g.add(new THREE.Mesh(box(CT.w - 0.3, 0.05, CT.L - 0.3, 0, CT.h + 0.01, 0), mm.top));
  g.add(new THREE.Mesh(mergeGeometries([1, -1].map((s) => box(0.06, 0.12, CT.L - 0.4, s * (CT.w / 2 + 0.01), CT.h - 0.35, 0))), mm.bolt));
  return g;
}
const CT_SOLID = box(CT.w, CT.h, CT.L, 0, CT.h / 2, 0);
const CT_DECK = new THREE.PlaneGeometry(CT.w - 0.2, CT.L - 0.2).rotateX(-Math.PI / 2).translate(0, CT.h, 0);

// ROAD BLOCK: water-filled plastic barriers, red and white, four in a row across the road
const RB = { n: 4, L: 2, h: 1.0, base: 0.6 };
function rbShape() {
  const s = new THREE.Shape(), b = RB.base / 2;
  s.moveTo(-b, 0); s.lineTo(b, 0); s.lineTo(b, 0.18); s.lineTo(0.16, 0.55); s.lineTo(0.13, RB.h); s.lineTo(-0.13, RB.h); s.lineTo(-0.16, 0.55); s.lineTo(-b, 0.18); s.closePath();
  return s;
}
function roadBlockParts() {
  const m = mats2(), g = new THREE.Group(), seg = extrude(rbShape(), RB.L - 0.1, 0.03).rotateY(Math.PI / 2);
  for (let i = 0; i < RB.n; i++) {
    const mesh = new THREE.Mesh(seg, i % 2 ? m.whiteP : m.red);
    mesh.position.x = (i - (RB.n - 1) / 2) * RB.L;
    g.add(mesh);
  }
  return g;
}
const RB_SOLID = box(RB.n * RB.L, RB.h, RB.base, 0, RB.h / 2, 0);

// CONCRETE BARRIER: three jersey blocks end to end, an orange band near the top
const JB = { n: 3, L: 3, h: 0.81, base: 0.6 };
function jerseyShape() {
  const s = new THREE.Shape(), b = JB.base / 2;
  s.moveTo(-b, 0); s.lineTo(b, 0); s.lineTo(b, 0.075); s.lineTo(0.13, 0.33); s.lineTo(0.075, JB.h); s.lineTo(-0.075, JB.h); s.lineTo(-0.13, 0.33); s.lineTo(-b, 0.075); s.closePath();
  return s;
}
function jerseyParts() {
  const m = mats2(), mm = mats(), g = new THREE.Group(), seg = extrude(jerseyShape(), JB.L - 0.06, 0.015).rotateY(Math.PI / 2);
  const stripes = [];
  for (let i = 0; i < JB.n; i++) {
    const x = (i - (JB.n - 1) / 2) * JB.L, mesh = new THREE.Mesh(seg, m.concrete);
    mesh.position.x = x;
    g.add(mesh);
    for (let k = 0; k < 5; k++) for (const s of [1, -1]) stripes.push(box(0.28, 0.1, 0.02, x - JB.L / 2 + 0.4 + k * 0.55, JB.h - 0.14, s * 0.092));
  }
  g.add(new THREE.Mesh(mergeGeometries(stripes), mm.signal));
  return g;
}
const JB_SOLID = box(JB.n * JB.L, JB.h, JB.base, 0, JB.h / 2, 0);

// ROUND-HOLE WALL: across the road, a round port at road level — a tunnel mouth to aim through
const RW = { w: 2 * ROAD_HW + 10, h: 12, r: 5, cy: 3.5 };
function roundWallShape() {
  const { w, h, r, cy } = RW, c = Math.sqrt(r * r - cy * cy);
  const a0 = Math.atan2(-cy, -c), a1 = Math.atan2(-cy, c);
  const s = new THREE.Shape();
  s.moveTo(-w / 2, 0); s.lineTo(-c, 0);
  s.absarc(0, cy, r, a0, a1, true); // from the left foot, over the top, to the right foot
  s.lineTo(w / 2, 0); s.lineTo(w / 2, h); s.lineTo(-w / 2, h); s.closePath();
  return s;
}
const RW_BOXES = roundHoleBoxes([-RW.w / 2, RW.w / 2, 0, RW.h], 0, RW.cy, RW.r);
function roundWallParts() {
  const mm = mats(), g = new THREE.Group();
  g.add(new THREE.Mesh(extrude(roundWallShape(), WALL_T), mm.body));
  // the glowing rim over the port (the part above the road), both faces
  const { r, cy } = RW, a = Math.asin(cy / r), arc = [];
  for (const s of [1, -1]) arc.push(new THREE.TorusGeometry(r + 0.12, 0.16, 8, 48, Math.PI + 2 * a).rotateZ(-a).translate(0, cy, s * (WALL_T / 2 + 0.05)));
  g.add(new THREE.Mesh(mergeGeometries(arc), mm.bolt));
  const chev = [];
  for (let i = -2; i <= 2; i++) {
    const c = new THREE.Shape();
    c.moveTo(-0.6, 0.6); c.lineTo(0, -0.1); c.lineTo(0.6, 0.6); c.lineTo(0.6, 0.1); c.lineTo(0, -0.65); c.lineTo(-0.6, 0.1); c.closePath();
    chev.push(new THREE.ShapeGeometry(c).translate(i * 1.6, cy + r + 1.6, WALL_T / 2 + 0.04));
  }
  g.add(new THREE.Mesh(mergeGeometries(chev), mm.signal));
  return g;
}

// RING GATE (air): a floating plate with a round hole, placed on a jump's flight — thread it, or hit the plate
export const RING_GATE = { w: 20, h: 20, r: 5 };
function ringGateShape() {
  const { w, h, r } = RING_GATE, s = new THREE.Shape();
  s.moveTo(-w / 2, -h / 2); s.lineTo(w / 2, -h / 2); s.lineTo(w / 2, h / 2); s.lineTo(-w / 2, h / 2); s.closePath();
  const hole = new THREE.Path();
  hole.absarc(0, 0, r, 0, 2 * Math.PI, true);
  s.holes.push(hole);
  return s;
}
const RG_BOXES = roundHoleBoxes([-RING_GATE.w / 2, RING_GATE.w / 2, -RING_GATE.h / 2, RING_GATE.h / 2], 0, 0, RING_GATE.r);
function ringGateParts() {
  const mm = mats(), g = new THREE.Group();
  g.add(new THREE.Mesh(extrude(ringGateShape(), WALL_T), mm.body));
  const rim = mergeGeometries([1, -1].map((s) => new THREE.TorusGeometry(RING_GATE.r + 0.12, 0.16, 8, 64).translate(0, 0, s * (WALL_T / 2 + 0.05))));
  g.add(new THREE.Mesh(rim, mm.bolt));
  return g;
}

// ARCH: a short orange vault over part of the road — aim through its opening (10 m wide, 8 m high)
const AR = { open: 5, side: 3, outer: 8, depth: 4 };
function archShape() {
  const { open, side, outer } = AR, s = new THREE.Shape();
  s.moveTo(-outer, 0); s.lineTo(-open, 0); s.lineTo(-open, side);
  s.absarc(0, side, open, Math.PI, 0, true); // the opening's top, left to right
  s.lineTo(open, 0); s.lineTo(outer, 0); s.lineTo(outer, side);
  s.absarc(0, side, outer, 0, Math.PI, false); // the outside, back over
  s.closePath();
  return s;
}
const AR_BOXES = (() => {
  const out = [], { open, side, outer, depth } = AR, n = 14, rm = (open + outer) / 2;
  for (const sx of [1, -1]) out.push(box(outer - open, side, depth, (sx * (open + outer)) / 2, side / 2, 0));
  // the vault as wedges round its arc (each box: radial thickness × arc length, turned to its angle)
  for (let i = 0; i < n; i++) {
    const a = (Math.PI * (i + 0.5)) / n, len = (Math.PI * rm) / n + 0.15;
    out.push(box(outer - open, len, depth).rotateZ(a).translate(Math.cos(a) * rm, side + Math.sin(a) * rm, 0));
  }
  return out;
})();
function archParts() {
  const m = mats2(), mm = mats(), g = new THREE.Group();
  g.add(new THREE.Mesh(extrude(archShape(), AR.depth, 0.12), m.orange));
  // a glowing strip round the opening, on the face the car comes at (+Z)
  const strip = new THREE.TorusGeometry(AR.open - 0.1, 0.12, 8, 48, Math.PI).translate(0, AR.side, AR.depth / 2 + 0.14);
  const legs = [1, -1].map((s) => new THREE.CylinderGeometry(0.12, 0.12, AR.side, 8).translate(s * (AR.open - 0.1), AR.side / 2, AR.depth / 2 + 0.14));
  g.add(new THREE.Mesh(strip, mm.bolt), new THREE.Mesh(mergeGeometries(legs), mm.bolt));
  return g;
}

// ---------------------------------------------------------------- BOOST TUBE · OPEN CYLINDER
// (user, 2026-11-01: "the booster tube, the open cylinder" — from the old game: a hoop that punches the car to speed,
// and a big open pipe lying on the road to ride inside)
// BOOST TUBE: an arch of glowing chevrons over the road (the hoop's upper half: its zone the whole circle); anything going
// through is raised to BOOST_TUBE.v along the tube — on the wheels or in the air (carRules)
export const BOOST_TUBE = { r: 12.6, len: 6, v: 68, accel: 400 };
function boostTubeParts() {
  const mm = mats(), g = new THREE.Group(), { r, len } = BOOST_TUBE, cy = 0.6;
  const K = 9, ROWS = 3, half = 1.8, stroke = 0.5, pitch = len * 0.3, pos = [];
  const at = (ph, z, rr = r) => pos.push(Math.cos(ph) * rr, cy + Math.sin(ph) * rr, z);
  const tri = (a, b, c) => { at(...a); at(...b); at(...c); };
  for (let row = 0; row < ROWS; row++) {
    const zTip = -pitch + row * pitch, zBack = zTip + len * 0.22, zIn = zTip + (zBack - zTip) * 0.48; // (tips point along −Z: the way through)
    const dO = half / r, dI = Math.max(0.05, (half - stroke) / r);
    for (let k = 0; k <= K; k++) {
      const ph = -0.05 + ((Math.PI + 0.1) * k) / K; // (over the road only: an arch — the lower half hung below the deck over the drop)
      tri([ph, zTip], [ph + dO, zBack], [ph + dI, zBack]); tri([ph, zTip], [ph + dI, zBack], [ph, zIn]);
      tri([ph, zTip], [ph, zIn], [ph - dI, zBack]); tri([ph, zTip], [ph - dI, zBack], [ph - dO, zBack]);
    }
  }
  const chev = new THREE.BufferGeometry();
  chev.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  chev.computeVertexNormals();
  const glow = new THREE.MeshStandardMaterial({ color: BOLT, emissive: BOLT, emissiveIntensity: 1.6, roughness: 0.4, side: THREE.DoubleSide });
  const m = new THREE.Mesh(chev, glow);
  m.userData.noShadow = true;
  g.add(m);
  // two thin hoops at the mouths (read the tube's edge from far)
  for (const z of [-len / 2, len / 2]) g.add(new THREE.Mesh(new THREE.TorusGeometry(r, 0.14, 6, 64, Math.PI + 0.1).rotateZ(-0.05).translate(0, cy, z), mm.bolt));
  return g;
}
const BOOST_TUBE_GHOST = new THREE.TorusGeometry(BOOST_TUBE.r, 0.6, 6, 32, Math.PI).translate(0, 0.6, 0);

// OPEN CYLINDER: a pipe 30 m long lying along the road, its inner floor flush with the road (no step in): ride its
// walls inside. The inside is a DECK (the wheels drive it); the outside and the two rims are solid.
export const OPEN_CYL = { r: 9, wall: 0.6, L: 30 };
const CYL_CY = OPEN_CYL.r + 0.02; // (the inner floor 2 cm over the road: never z-fighting)
const cylAlong = (geo) => geo.rotateX(Math.PI / 2).translate(0, CYL_CY, 0); // (a cylinder's axis turned along Z)
const CYL_INNER = cylAlong(new THREE.CylinderGeometry(OPEN_CYL.r, OPEN_CYL.r, OPEN_CYL.L, 64, 8, true));
const CYL_OUTER = cylAlong(new THREE.CylinderGeometry(OPEN_CYL.r + OPEN_CYL.wall, OPEN_CYL.r + OPEN_CYL.wall, OPEN_CYL.L, 64, 1, true));
const flipped = (geo) => {
  const g = geo.clone(), ix = g.index.array;
  for (let i = 0; i < ix.length; i += 3) { const t = ix[i + 1]; ix[i + 1] = ix[i + 2]; ix[i + 2] = t; }
  const n = g.attributes.normal.array;
  for (let i = 0; i < n.length; i++) n[i] = -n[i];
  return g;
};
const CYL_INNER_LOOK = flipped(CYL_INNER);
// (SOLID: the two rims, as 0.5 m-deep rings of boxes, and SKIRTS under the low flanks — the road up to the shell, where
// a car beside the pipe would run into it. Not the shell itself: 0.6 m behind the inner floor, a car riding the wall
// inside touched it and crashed at 3 m up, 2026-11-01)
const CYL_SKIRTS = [];
for (let x = 4.6; x < 6.6; x += 0.4) { // (from where the floor's edge at the mouth is a 1.2 m step: nearer the middle the wheels climb it)
  const ro = OPEN_CYL.r + OPEN_CYL.wall, y = CYL_CY - Math.sqrt(ro * ro - x * x); // (the shell's underside at the box's inner edge: its lowest)
  if (y > 0.05) for (const sx of [1, -1]) CYL_SKIRTS.push(box(0.4, y, OPEN_CYL.L, sx * (x + 0.2), y / 2, 0));
}
const CYL_RIM_SOLIDS = [1, -1].flatMap((s) => Array.from({ length: 32 }, (_, i) => {
  // (from 15 cm outside the floor: flush with it, a tyre pressed 3 cm into the floor near the exit was INSIDE the rim's
  // box — a 234 → 104 km/h crash into nothing you could see)
  const r0 = OPEN_CYL.r + 0.15, r1 = OPEN_CYL.r + OPEN_CYL.wall, a = (2 * Math.PI * (i + 0.5)) / 32, rm = (r0 + r1) / 2;
  if (Math.sin(a) * rm + CYL_CY < 0.3) return null; // (under the road: nothing to hit)
  return box(r1 - r0, (2 * Math.PI * rm) / 32 + 0.1, 0.5).rotateZ(a).translate(Math.cos(a) * rm, CYL_CY + Math.sin(a) * rm, s * (OPEN_CYL.L / 2 - 0.25));
}).filter(Boolean));
const CYL_RIMS = [1, -1].map((s) => new THREE.RingGeometry(OPEN_CYL.r, OPEN_CYL.r + OPEN_CYL.wall, 64).translate(0, CYL_CY, (s * OPEN_CYL.L) / 2));
function openCylParts() {
  const mm = mats(), g = new THREE.Group();
  const shell = new THREE.MeshStandardMaterial({ color: 0x1c2436, roughness: 0.55, metalness: 0.3, side: THREE.DoubleSide });
  const inside = new THREE.MeshStandardMaterial({ color: 0x2a2f3a, roughness: 0.85, metalness: 0.05 });
  g.add(new THREE.Mesh(CYL_OUTER, shell), new THREE.Mesh(CYL_INNER_LOOK, inside), ...CYL_RIMS.map((r) => new THREE.Mesh(r, shell)));
  // glowing rings at both mouths and three lines along the inside (the way through, and how far up the wall you are)
  const glow = [];
  for (const s of [1, -1]) glow.push(new THREE.TorusGeometry(OPEN_CYL.r + OPEN_CYL.wall / 2, 0.14, 6, 96).translate(0, CYL_CY, (s * OPEN_CYL.L) / 2 + s * 0.05));
  for (const a of [-Math.PI / 2 + 1.2, -Math.PI / 2 - 1.2, Math.PI / 2]) {
    const rr = OPEN_CYL.r - 0.03;
    glow.push(new THREE.BoxGeometry(0.25, 0.04, OPEN_CYL.L - 1).rotateZ(a + Math.PI / 2).translate(Math.cos(a) * rr, CYL_CY + Math.sin(a) * rr, 0));
  }
  g.add(new THREE.Mesh(mergeGeometries(glow.map((x) => x.toNonIndexed())), mm.bolt));
  return g;
}

// ---------------------------------------------------------------- MOVERS, SET 2
// (user, 2026-11-01: "the spin barrel smooth and probably others" — the old game's movers, new in Thunderline's look).
// Posed by the RACE CLOCK like the pendulum (ghosts and author times stay fair).
// TURNSTILE: two bars crossed at car height turning round a post — slip between the arms
const TS = { span: 20, thick: 0.9, tall: 1.4, y0: 0.4, period: 8 };
const TS_ARM = mergeGeometries([
  box(TS.span, TS.tall, TS.thick, 0, TS.y0 + TS.tall / 2, 0), box(TS.thick, TS.tall, TS.span, 0, TS.y0 + TS.tall / 2, 0),
]);
const TS_POST = new THREE.CylinderGeometry(0.75, 0.9, TS.y0 + TS.tall + 0.6, 16).translate(0, (TS.y0 + TS.tall + 0.6) / 2, 0);
const TS_STRIPES = (() => {
  const s = [];
  for (const sgn of [1, -1]) for (let k = 1; k <= 4; k++) {
    const d = sgn * (1.4 + k * 2), y = TS.y0 + TS.tall / 2;
    s.push(box(0.9, TS.tall + 0.04, TS.thick + 0.04, d, y, 0), box(TS.thick + 0.04, TS.tall + 0.04, 0.9, 0, y, d));
  }
  return mergeGeometries(s);
})();
// PUSH GATE: a block sliding to and fro along the road, 16 m of travel — get past before it comes back
const PG = { w: 8, h: 5, d: 3.5, amp: 8, period: 14 };
const PG_BLOCK = box(PG.w, PG.h, PG.d, 0, PG.h / 2, 0);
const PG_FACES = (() => {
  const c = [];
  for (const z of [PG.d / 2 + 0.03, -PG.d / 2 - 0.03]) for (let i = -2; i <= 2; i++) {
    const sh = new THREE.Shape();
    sh.moveTo(-0.6, -0.5); sh.lineTo(0, 0.1); sh.lineTo(0.6, -0.5); sh.lineTo(0.6, -0.05); sh.lineTo(0, 0.55); sh.lineTo(-0.6, -0.05); sh.closePath();
    const g = new THREE.ShapeGeometry(sh);
    if (z < 0) g.rotateY(Math.PI); // (the back face's chevrons face out of it too)
    c.push(g.translate(i * 1.45, PG.h * 0.55, z));
  }
  return mergeGeometries(c);
})();
const PG_BAND = mergeGeometries([PG.d / 2 + 0.03, -PG.d / 2 - 0.03].map((z) => box(PG.w + 0.04, 0.18, 0.06, 0, PG.h - 0.5, z)));
// SPIN COLUMN: a square pillar 7 m tall turning on its spot — its corners sweep 2.5 m round it
const SC = { w: 3.5, h: 7, period: 11 };
const SC_ARM = box(SC.w, SC.h, SC.w, 0, SC.h / 2, 0);
const SC_BANDS = mergeGeometries([1.2, 3.5, 5.8].map((y) => box(SC.w + 0.06, 0.22, SC.w + 0.06, 0, y, 0)));
const SC_BASE = new THREE.CylinderGeometry(2.7, 2.9, 0.12, 32).translate(0, 0.06, 0);

const _mp = new THREE.Matrix4();
const MOVERS2 = {
  ob_turnstile: {
    label: "Turnstile", parts: () => {
      const m = mats(), g = new THREE.Group();
      g.add(new THREE.Mesh(TS_POST, m.body));
      const arm = new THREE.Group(); arm.name = "arm";
      arm.add(new THREE.Mesh(TS_ARM, m.signal), new THREE.Mesh(TS_STRIPES, m.white));
      g.add(arm);
      return g;
    },
    solids: [TS_POST], decks: [], ghost: mergeGeometries([TS_ARM, TS_POST]),
    mover: { arm: TS_ARM, pose: (t, out) => out.makeRotationY((2 * Math.PI * t) / TS.period) },
    footprint: { hx: 1.2, hz: 1.2 }, hint: "Two bars crossed at car height, turning: slip between the arms",
  },
  ob_push_gate: {
    label: "Push gate", parts: () => {
      const m = mats(), g = new THREE.Group();
      const arm = new THREE.Group(); arm.name = "arm";
      arm.add(new THREE.Mesh(PG_BLOCK, m.body), new THREE.Mesh(PG_FACES, m.signal), new THREE.Mesh(PG_BAND, m.bolt));
      g.add(arm);
      return g;
    },
    solids: [], decks: [], ghost: mergeGeometries([PG_BLOCK, box(PG.w, 0.1, PG.amp * 2 + PG.d, 0, 0.05, 0)]),
    mover: { arm: PG_BLOCK, pose: (t, out) => out.makeTranslation(0, 0, PG.amp * Math.sin((2 * Math.PI * t) / PG.period)) },
    footprint: { hx: PG.w / 2, hz: PG.amp + PG.d / 2 }, hint: "A block sliding up and down the road: pass it on the side",
  },
  ob_spin_column: {
    label: "Spin column", parts: () => {
      const m = mats(), g = new THREE.Group();
      g.add(new THREE.Mesh(SC_BASE, m.top));
      const arm = new THREE.Group(); arm.name = "arm";
      arm.add(new THREE.Mesh(SC_ARM, m.body), new THREE.Mesh(SC_BANDS, m.bolt));
      g.add(arm);
      return g;
    },
    solids: [], decks: [], ghost: SC_ARM,
    mover: { arm: SC_ARM, pose: (t, out) => out.makeRotationY((2 * Math.PI * t) / SC.period) },
    footprint: { hx: 2.6, hz: 2.6 }, hint: "A pillar turning on its spot: its corners knock you aside",
  },
};

// SPIN BARREL (the old game's "Spin barrel (smooth)"): a barrel 40 m long lying along the road, its floor flush with the
// road, turning slowly on its own axis — four staggered holes in its wall come round. Its inside is a MOVING DECK (the
// wheels drive on it: the ground's mover tree) and a car on it is carried round with it (carry(), arcadeCar): drive
// along it, or be lifted up the wall until you slide — or drop out of a hole.
export const SPIN_BARREL = { r: 8, wall: 0.6, L: 40, period: 11.5 };
const SB_CY = SPIN_BARREL.r + 0.02;
const SB_HOLES = [ // (angle from the bottom, span, z from its start, length: m)
  { a: 40, span: 70, z: 5, len: 7 }, { a: 150, span: 70, z: 14, len: 7 }, { a: 250, span: 80, z: 23, len: 7 }, { a: 330, span: 60, z: 31, len: 6 },
];
/** The barrel's wall as a grid (A round × NZ along), the holes' cells left out; inner and outer skins, the holes' sides. */
function barrelGeometry({ A = 72, NZ = 40, inner = true, outer = true, sides = true } = {}) {
  const { r, wall, L } = SPIN_BARREL, ro = r + wall, DEG1 = Math.PI / 180;
  const hole = (i, j) => {
    const a = ((i + 0.5) / A) * 360, z = ((j + 0.5) / NZ) * L;
    return SB_HOLES.some((h) => z > h.z && z < h.z + h.len && ((a - h.a + 360) % 360) < h.span);
  };
  // angle measured from the BOTTOM (−Y), round toward +X
  const P = (rr, i, j) => { const t = (i / A) * 2 * Math.PI; return [Math.sin(t) * rr, SB_CY - Math.cos(t) * rr, -L / 2 + (j / NZ) * L]; };
  const pos = [], nrm = [], side = [];
  const quad = (out, a, b, c, d) => out.push(...a, ...b, ...c, ...a, ...c, ...d);
  for (let i = 0; i < A; i++) for (let j = 0; j < NZ; j++) {
    if (hole(i, j)) continue;
    if (inner) quad(pos, P(r, i, j), P(r, i, j + 1), P(r, i + 1, j + 1), P(r, i + 1, j)); // (faces the axis)
    if (outer) quad(pos, P(ro, i, j), P(ro, i + 1, j), P(ro, i + 1, j + 1), P(ro, i, j + 1));
    if (sides) { // the wall's edge where a hole (or the barrel's end) is next to this cell
      if (hole((i + 1) % A, j)) quad(side, P(r, i + 1, j), P(r, i + 1, j + 1), P(ro, i + 1, j + 1), P(ro, i + 1, j));
      if (hole((i - 1 + A) % A, j)) quad(side, P(r, i, j), P(ro, i, j), P(ro, i, j + 1), P(r, i, j + 1));
      if (j + 1 < NZ && hole(i, j + 1)) quad(side, P(r, i, j + 1), P(ro, i, j + 1), P(ro, i + 1, j + 1), P(r, i + 1, j + 1));
      if (j > 0 && hole(i, j - 1)) quad(side, P(r, i, j), P(r, i + 1, j), P(ro, i + 1, j), P(ro, i, j));
    }
  }
  const geo = (arr) => { const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(arr, 3)); return g; };
  const shell = geo(pos);
  // SMOOTH: radial normals (inward on the inner skin, outward on the outer), not the faceted ones
  const p = shell.attributes.position.array, n = new Float32Array(p.length);
  for (let k = 0; k < p.length; k += 3) {
    const x = p[k], y = p[k + 1] - SB_CY, len = Math.hypot(x, y) || 1, s = len < r + wall / 2 ? -1 : 1;
    n[k] = (s * x) / len; n[k + 1] = (s * y) / len; n[k + 2] = 0;
  }
  shell.setAttribute("normal", new THREE.BufferAttribute(n, 3));
  const sideGeo = geo(side); sideGeo.computeVertexNormals();
  return { shell, sides: sideGeo };
}
const SB_LOOK = barrelGeometry();
const SB_DECK = barrelGeometry({ A: 48, NZ: 20, outer: false, sides: false }).shell; // (what the wheels drive: the inner skin, lower poly)
const SB_RIMS = [1, -1].map((s) => new THREE.TorusGeometry(SPIN_BARREL.r + SPIN_BARREL.wall / 2, 0.16, 6, 96).translate(0, SB_CY, (s * SPIN_BARREL.L) / 2));
// (static solids: a ring's rims and the skirts under its flanks look the same at any angle — as the Open cylinder's)
const SB_SOLIDS = (() => {
  const out = [], { r, wall, L } = SPIN_BARREL, r0 = r + 0.15, r1 = r + wall;
  for (const s of [1, -1]) for (let i = 0; i < 32; i++) {
    const a = (2 * Math.PI * (i + 0.5)) / 32, rm = (r0 + r1) / 2;
    if (Math.sin(a) * rm + SB_CY < 0.3) continue;
    out.push(box(r1 - r0, (2 * Math.PI * rm) / 32 + 0.1, 0.5).rotateZ(a).translate(Math.cos(a) * rm, SB_CY + Math.sin(a) * rm, s * (L / 2 - 0.25)));
  }
  for (let x = 4.2; x < 6; x += 0.4) {
    const y = SB_CY - Math.sqrt(r1 * r1 - x * x);
    if (y > 0.05) for (const sx of [1, -1]) out.push(box(0.4, y, L, sx * (x + 0.2), y / 2, 0));
  }
  return out;
})();
const _sbm = new THREE.Matrix4(), _sbm2 = new THREE.Matrix4();
function spinBarrelParts() {
  const mm = mats(), g = new THREE.Group();
  const shellMat = new THREE.MeshStandardMaterial({ color: 0x232a3a, roughness: 0.7, metalness: 0.2, side: THREE.DoubleSide });
  const arm = new THREE.Group(); arm.name = "arm";
  const sh = new THREE.Mesh(SB_LOOK.shell, shellMat);
  const rimMat = new THREE.MeshStandardMaterial({ color: 0xff3ea5, emissive: 0xff3ea5, emissiveIntensity: 1.6, roughness: 0.45, side: THREE.DoubleSide });
  arm.add(sh, new THREE.Mesh(SB_LOOK.sides, rimMat));
  g.add(arm, ...SB_RIMS.map((t) => new THREE.Mesh(t, mm.bolt)));
  return g;
}
const MOVERS3 = {
  ob_spin_barrel: {
    label: "Spin barrel", halfW: SPIN_BARREL.r + SPIN_BARREL.wall, parts: spinBarrelParts, solids: SB_SOLIDS, decks: [],
    ghost: mergeGeometries([SB_DECK, ...SB_SOLIDS.map((g) => g.toNonIndexed())].map((g) => { const c = g.clone(); for (const k of Object.keys(c.attributes)) if (k !== "position") c.deleteAttribute(k); return c; })),
    // turns about its own axis (the obstacle's Z, through the barrel's middle)
    mover: {
      arm: SB_DECK, deck: true, spin: { cy: SB_CY, omega: (2 * Math.PI) / SPIN_BARREL.period, r: SPIN_BARREL.r, L: SPIN_BARREL.L },
      pose: (t, out) => out.makeTranslation(0, SB_CY, 0).multiply(_sbm.makeRotationZ((2 * Math.PI * t) / SPIN_BARREL.period)).multiply(_sbm2.makeTranslation(0, -SB_CY, 0)),
    },
    hint: "A barrel turning on its axis: drive through it — it carries you up its wall, and its holes come round",
  },
};

// ---------------------------------------------------------------- SCENERY: STREET LIGHTS
// (user, 2026-11-01: "the scenery could be important, especially the street lights for a night time track"): a tall
// pole past the road's edge, an arm reaching over the road and an LED head. Its LIGHT is real (trackLamps.js: a pool
// point light at the head, scaled by the night), its lens glows with the night too (streetLensMaterial). One beside the
// road (point at the side), or a pair facing each other.
export const STREET_LIGHT = { gap: 1.6, h: 10.4, reach: 4.6, color: 0xffe2bd, cd: 170, range: 34 };
let lensMat = null;
/** The lamp heads' glowing lens — shared: trackLamps turns it up with the night. */
export const streetLensMaterial = () => (lensMat ??= new THREE.MeshStandardMaterial({ color: 0x2a2a2a, emissive: STREET_LIGHT.color, emissiveIntensity: 0.25, roughness: 0.3 }));
const streetShapes = new Map();
function streetLightShape({ hw = ROAD_HW, dx = 1, pair = false } = {}) {
  const sides = pair ? [1, -1] : [dx < 0 ? -1 : 1], key = `${hw}|${sides.join(",")}`;
  if (!streetShapes.has(key)) {
    const S = STREET_LIGHT, y0 = -1.0; // (its foot level with the slab's underside, as the chevron panels')
    const solids = [], look = [], heads = [], lights = [];
    for (const side of sides) {
      const xp = side * (hw + S.gap), xh = xp - side * S.reach;
      solids.push(box(0.4, S.h - y0, 0.4, xp, (S.h + y0) / 2, 0));
      look.push(new THREE.CylinderGeometry(0.11, 0.17, S.h - y0, 12).translate(xp, (S.h + y0) / 2, 0));
      look.push(box(0.7, 0.5, 0.7, xp, y0 + 0.25, 0)); // (the foot's plinth)
      // the arm: a gentle curve from the pole's top out over the road
      const arm = new THREE.QuadraticBezierCurve3(new THREE.Vector3(xp, S.h - 0.9, 0), new THREE.Vector3(xp, S.h + 0.35, 0), new THREE.Vector3(xh + side * 0.5, S.h + 0.25, 0));
      look.push(new THREE.TubeGeometry(arm, 16, 0.085, 8, false));
      heads.push(box(1.5, 0.26, 0.6, xh, S.h + 0.18, 0)); // the head's housing
      lights.push({ x: xh, y: S.h - 0.4, z: 0, color: S.color, cd: S.cd, range: S.range });
    }
    const lens = mergeGeometries(sides.map((side) => box(1.3, 0.05, 0.46, side * (hw + S.gap - S.reach), S.h + 0.03, 0)));
    const parts = () => {
      const m = mats(), g = new THREE.Group();
      g.add(new THREE.Mesh(mergeGeometries(look.map((x) => x.toNonIndexed())), m.body));
      g.add(new THREE.Mesh(mergeGeometries(heads), m.body));
      const l = new THREE.Mesh(lens, streetLensMaterial()); l.userData.noShadow = true;
      g.add(l);
      return g;
    };
    streetShapes.set(key, { solids, ghost: mergeGeometries([...solids, ...heads]), parts, lights });
  }
  return streetShapes.get(key);
}
const lightKind = (label, sign, shape, hint) => ({ label, sign, shape, parts: (o) => shape().parts(o), solids: shape().solids, decks: [], ghost: shape().ghost, lights: shape().lights, hint });

// ---------------------------------------------------------------- SCENERY: FLAGS, PALMS
// (user, 2026-11-01: "you can add flags and palms"): beside the road like the street lights (point at the side). The
// cloth is the engine's Verlet flag (v3/props/flagFactory.js, the RTS's) — each its own little sim, stepped by the
// obstacle set's clock (`animate`); the designs are Thunderline's own colours, no real brand.
const flagTextures = new Map();
/** A flag's design on a canvas: "bolt" (navy, a cyan bolt, an orange hem) or "chevron" banners in `color`. */
function flagTexture(kind, color = "#3fd2ff") {
  const key = `${kind}|${color}`;
  if (flagTextures.has(key) || typeof document === "undefined") return flagTextures.get(key) ?? null;
  const c = document.createElement("canvas");
  c.width = kind === "bolt" ? 384 : 128; c.height = kind === "bolt" ? 256 : 448;
  const g = c.getContext("2d"), W = c.width, H = c.height;
  if (kind === "bolt") {
    g.fillStyle = "#101a2e"; g.fillRect(0, 0, W, H);
    g.fillStyle = "#ff7a1a"; g.fillRect(0, H - 26, W, 26);
    g.fillStyle = "#3fd2ff";
    g.beginPath(); g.moveTo(W * 0.56, H * 0.1); g.lineTo(W * 0.3, H * 0.55); g.lineTo(W * 0.48, H * 0.55); g.lineTo(W * 0.38, H * 0.9); g.lineTo(W * 0.72, H * 0.4); g.lineTo(W * 0.53, H * 0.4); g.closePath(); g.fill();
  } else {
    g.fillStyle = "#101a2e"; g.fillRect(0, 0, W, H);
    g.fillStyle = color;
    for (let k = 0; k < 4; k++) { const y = 40 + k * 70; g.beginPath(); g.moveTo(14, y + 40); g.lineTo(W / 2, y); g.lineTo(W - 14, y + 40); g.lineTo(W - 14, y + 64); g.lineTo(W / 2, y + 24); g.lineTo(14, y + 64); g.closePath(); g.fill(); }
    g.fillRect(0, H - 22, W, 22);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
  flagTextures.set(key, tex);
  return tex;
}
/** One flag on its own pole at local x; returns its group (and pushes its sim's step into `anims`). */
function flagOn(x, { w, h, pole, tex }, anims) {
  const f = createFlagProp({ clothWidth: w, clothHeight: h, poleHeight: pole, poleRadius: 0.1, xSegs: 12, ySegs: 10, showPole: false, windIntensity: 260, windSpeed: 900 });
  const cloth = f.group.children[1];
  if (tex) { cloth.material.map = tex; cloth.material.color.set(0xffffff); cloth.material.needsUpdate = true; }
  f.group.position.x = x;
  anims.push(f.update);
  return f.group;
}
const FLAGS = {
  mast: { gap: 4, poles: [0], w: 6, h: 4, pole: 15, tex: () => flagTexture("bolt") },
  banners: { gap: 3, poles: [-3, 0, 3], w: 1.3, h: 4.2, pole: 7.5, tex: (i) => flagTexture("chevron", ["#3fd2ff", "#ff7a1a", "#e8edf5"][i]) },
};
const flagShapes = new Map();
function flagShape({ hw = ROAD_HW, dx = 1, style = "mast" } = {}) {
  const side = dx < 0 ? -1 : 1, key = `${hw}|${side}|${style}`, F = FLAGS[style];
  if (!flagShapes.has(key)) {
    const y0 = -1.0, xp = side * (hw + F.gap);
    // (along the road, the poles: the cloth hangs toward the way the car comes, +Z)
    const poles = F.poles.map((z) => new THREE.CylinderGeometry(0.1, 0.14, F.pole - y0, 10).rotateY(0).translate(xp, (F.pole + y0) / 2, z));
    const solids = F.poles.map((z) => box(0.35, F.pole - y0, 0.35, xp, (F.pole + y0) / 2, z));
    const parts = () => {
      const m = mats(), g = new THREE.Group(), anims = [];
      g.add(new THREE.Mesh(mergeGeometries(poles), m.white));
      F.poles.forEach((z, i) => {
        const fg = flagOn(0, { w: F.w, h: F.h, pole: F.pole, tex: F.tex(i) }, anims);
        fg.position.set(xp, y0, z);
        fg.rotation.y = Math.PI / 2; // (the cloth's +X runs toward +Z: it flies back along the road)
        g.add(fg);
      });
      let last = null;
      g.userData.animate = (t) => { const dt = last == null ? 1 / 60 : Math.min(0.05, Math.max(0, t - last)); last = t; if (dt > 0) for (const a of anims) a(dt); };
      return g;
    };
    flagShapes.set(key, { solids, ghost: mergeGeometries(solids), parts });
  }
  return flagShapes.get(key);
}
// PALM: the old game's palm model (public/models/palmtest_compressed.glb, 12 m), the trunk solid; a simple stand-in
// until it is loaded
const PALM = { gap: 5, trunk: 0.45 };
const palmShapes = new Map();
function palmShape({ hw = ROAD_HW, dx = 1 } = {}) {
  const side = dx < 0 ? -1 : 1, key = `${hw}|${side}`;
  if (!palmShapes.has(key)) {
    const xp = side * (hw + PALM.gap), y0 = -1.0;
    const solids = [box(0.7, 12 - y0, 0.7, xp, (12 + y0) / 2, 0)];
    const parts = () => {
      const g = new THREE.Group(), model = physPalm();
      if (model) { model.position.set(xp, y0, 0); g.add(model); }
      else g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.4, 12 - y0, 8).translate(xp, (12 + y0) / 2, 0), mats().top));
      return g;
    };
    palmShapes.set(key, { solids, ghost: solids[0], parts });
  }
  return palmShapes.get(key);
}

// ---------------------------------------------------------------- SCENERY: FENCES ALONG A PIECE'S EDGE
// (user, 2026-11-01: "the barbed wire and chain link fences"): the engine's fence and wire (v3/props/objects — the old
// game's) laid along a piece's EDGE, its whole length (the roads float: beside them a fence would hang in the air — on
// the deck's edge it is a motorsport catch fence). `edge`: the builder samples the piece's edge (edgeSnap) into the
// prop — [x, y, z] every 2 m in the PIECE's frame (the prop's M is the piece's): it follows the turn and the slope, and
// is re-laid with the piece. Solid: a thin wall per stretch.
const edgeShapes = new Map();
function edgeShape(kind, { edge = null, dx = 1 } = {}) {
  const pts = edge?.length >= 2 ? edge : [[dx * (ROAD_HW - 0.4), 0, 0], [dx * (ROAD_HW - 0.4), 0, -24]];
  const key = `${kind}|${JSON.stringify(pts)}`;
  if (!edgeShapes.has(key)) {
    const E = EDGE_KINDS[kind], solids = [];
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0, z0] = pts[i - 1], [x1, y1, z1] = pts[i], L = Math.hypot(x1 - x0, z1 - z0);
      if (L < 1e-3) continue;
      solids.push(box(E.thick, E.h, L + 0.05).rotateY(Math.atan2(x1 - x0, z1 - z0)).translate((x0 + x1) / 2, (y0 + y1) / 2 + E.h / 2, (z0 + z1) / 2));
    }
    // (the fence builders walk a flat path; the posts stand on the edge's height there — the nearest sample's)
    const heightAt = (x, z) => { let best = pts[0], bd = Infinity; for (const p of pts) { const d = (p[0] - x) ** 2 + (p[2] - z) ** 2; if (d < bd) { bd = d; best = p; } } return best[1]; };
    const parts = () => {
      const g = new THREE.Group();
      const mesh = E.build({ points: pts.map(([x, , z]) => ({ x, y: 0, z })), params: { ...E.params, pathSegments: Math.max(12, Math.round(pts.length * 1.5)) }, getWorldHeight: heightAt });
      if (mesh) g.add(mesh);
      return g;
    };
    edgeShapes.set(key, { solids, ghost: solids.length ? mergeGeometries(solids) : box(0.2, 2, 2), parts });
    if (edgeShapes.size > 64) edgeShapes.delete(edgeShapes.keys().next().value); // (the ghost's every position: keep a few)
  }
  return edgeShapes.get(key);
}
const EDGE_KINDS = {
  sc_fence: { build: buildChainLinkFenceMesh, h: 3.2, thick: 0.2, inset: 0.15, params: { height: 3.2, postSpacing: 3, topRail: true, arms: true, armSide: "in", strands: 3, coil: false, meshPitch: 0.3, meshWire: 0.05, meshOpacityCut: 0.3 } }, // (coarser, thicker wire than the lab's 14 cm / 2 cm: at racing distance that weave vanished into its mips)
  sc_barbwire: { build: buildBarbWireMesh, h: 1.4, thick: 0.6, inset: 0.6, params: { stacking: "pyramid", coilRadius: 0.5, coilPitch: 0.34, segsPerRev: 8, stakes: true, stakeSpacing: 4 } },
};
/** How far inside the road's edge a kind's run stands (the builder's edgeSnap). */
export const edgeInset = (kind) => EDGE_KINDS[kind]?.inset ?? 0;
/** A straight run centred on its own origin, along its Z (2 m samples): the free-placed fence's path. */
const straightRun = (L) => Array.from({ length: Math.round(L / 2) + 1 }, (_, i) => [0, 0, -L / 2 + i * 2]);
const freeRunKind = (label, kind, L, hint) => {
  const sh = edgeShape(kind, { edge: straightRun(L) });
  return { label, parts: sh.parts, solids: sh.solids, decks: [], ghost: sh.ghost, footprint: { hx: EDGE_KINDS[kind].thick / 2 + 0.3, hz: L / 2 }, hint };
};
const edgeKind = (label, kind, hint) => ({ label, edge: true, shape: (p) => edgeShape(kind, p), parts: (o) => edgeShape(kind).parts(o), solids: edgeShape(kind).solids, decks: [], ghost: edgeShape(kind).ghost, hint });

// ---------------------------------------------------------------- SCENERY: LED BOARD, BILLBOARDS
// (user, 2026-11-01: "the different billboard would be cool … the prism one especially, also the LED board"): the old
// game's boards (modular-road-v3: the ad billboard and totem, the tri-vision prism; the engine's LED matrix), placed
// as the old game places them — anywhere, on the ground or a road, Q / E turn — facing the way the car comes (+Z).
// A board shows Thunderline's own made-up ads (adPosters.js; `ad`: which) or YOUR picture (`img`: a data URL in the
// track); the LED board chevrons or YOUR text (`text`), scrolling. The builder's panel sets them (Next ad, Your picture,
// Text).
const posterOf = (p, portrait) => p?.img ?? adPoster(p?.ad ?? (p?.uid ?? 0), portrait);
const adShapes = new Map();
function adShape(kind, p = {}) {
  const key = `${kind}|${p.ad ?? p.uid ?? 0}|${p.img ? p.img.length + p.img.slice(-24) : ""}|${p.text ?? ""}`;
  if (!adShapes.has(key)) {
    const A = AD_SPECS[kind];
    const parts = () => {
      const g = new THREE.Group(), board = A.build(p);
      if (board) g.add(board);
      return g;
    };
    adShapes.set(key, { solids: A.solids, ghost: mergeGeometries(A.solids), parts });
    if (adShapes.size > 48) adShapes.delete(adShapes.keys().next().value);
  }
  return adShapes.get(key);
}
const capsuleBoxes = (xs, z, r, h) => xs.map((x) => box(2 * r, h, 2 * r, x, h / 2, z));
const AD_SPECS = {
  sc_billboard: {
    build: (p) => { const g = buildAdBillboardMesh(); setAdPosterImage(g, posterOf(p, false)); return g; },
    solids: capsuleBoxes([-AD_BILLBOARD.panelW * 0.34, AD_BILLBOARD.panelW * 0.34], -0.38, 0.2, AD_BILLBOARD.panelBottom + AD_BILLBOARD.panelH + 0.55),
  },
  sc_prism: {
    // three faces: the ad and the next two (or your picture on all three)
    build: (p) => { const g = buildAdPrismMesh(); const a = p?.ad ?? (p?.uid ?? 0); setAdPrismImages(g, p?.img ? [p.img, p.img, p.img] : [0, 1, 2].map((k) => adPoster(a + k, false))); return g; },
    solids: capsuleBoxes([-AD_PRISM.panelW * 0.34 * AD_PRISM.scale, AD_PRISM.panelW * 0.34 * AD_PRISM.scale], -0.38 * AD_PRISM.scale, 0.2 * AD_PRISM.scale, (AD_PRISM.panelBottom + AD_PRISM.panelH + 0.55) * AD_PRISM.scale),
  },
  sc_totem: {
    build: (p) => { const g = buildAdTotemMesh(); setAdPosterImage(g, posterOf(p, true)); return g; },
    solids: [box(AD_TOTEM.panelW + AD_TOTEM.frame * 2, AD_TOTEM.baseH + AD_TOTEM.panelH + AD_TOTEM.frame, AD_TOTEM.depth + 0.06, 0, (AD_TOTEM.baseH + AD_TOTEM.panelH + AD_TOTEM.frame) / 2, 0)],
  },
  sc_led_board: {
    build: (p) => physLedBuilder()?.({
      points: [{ x: 0, y: 0, z: 0 }],
      params: {
        ...(p?.text ? { source: "text", text: `${p.text}   •   `, coreColor: "#bff4ff", edgeColor: "#3fd2ff", panSpeed: 0.5 } : { source: "chevron", coreColor: "#ffd27a", edgeColor: "#ff6a00" }),
        boardW: 8, boardH: 2.2, standHeight: 2.6, legs: true, cols: 96, rows: 26, shape: "round", emissive: 5,
      },
    }),
    solids: capsuleBoxes([-8 * 0.35, 8 * 0.35], -0.05, 0.13, 2.6),
  },
};
const adKind = (label, kind, hint, extra = {}) => ({ label, shape: (p) => adShape(kind, p), parts: (o) => adShape(kind).parts(o), solids: AD_SPECS[kind].solids, decks: [], ghost: adShape(kind).ghost, hint, ...extra });

export const OBSTACLES = {
  ...MOVERS2,
  ...MOVERS3,
  ...GROUND,
  ob_block: { label: "Block", parts: blockParts, solids: [BLOCK_SOLID], decks: [BLOCK_DECK], ghost: BLOCK_SOLID, hint: "Dodge it, or jump onto it" },
  ob_sweeper: { label: "Sweeper", parts: sweeperParts, solids: [SWEEP_POST], decks: [], ghost: mergeGeometries([SWEEP_POST, SWEEP_ARM]), mover: { arm: SWEEP_ARM, omega: (2 * Math.PI) / SWEEP_PERIOD }, hint: "A bar turning over the road: time it" },
  ob_wall_door: { label: "Wall · door", parts: doorParts, solids: DOOR_BOXES, decks: [], ghost: mergeGeometries(DOOR_BOXES), shape: doorShape, hint: "A wall across the road: drive through its door" },
  // `air`: placed on a jump's flight, not on the road (the builder's arc snap)
  ob_wall_hole: { label: "Wall · hole", parts: holeParts, solids: HOLE_BOXES, decks: [], ghost: mergeGeometries(HOLE_BOXES), air: true, passes: (x, y) => x > HOLE.hole[0] + 1.2 && x < HOLE.hole[1] - 1.2 && y > HOLE.hole[2] + 0.8 && y < HOLE.hole[3] - 0.8, hint: "A wall in the air: fly through its hole" },
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
  sg_label: { label: "Lab sign", shape: labelShape, ...labelShape(), decks: [], hint: "The physics lab's word on a post: what this road tests" },
  ob_container: { label: "Container", parts: containerParts, solids: [CT_SOLID], decks: [CT_DECK], ghost: CT_SOLID, hint: "A shipping container: steer round it, or land on its roof" },
  ob_roadblock: { label: "Road block", halfW: RB.n * RB.L / 2, parts: roadBlockParts, solids: [RB_SOLID], decks: [], ghost: RB_SOLID, hint: "Plastic water barriers, red and white: go round" },
  ob_jersey: { label: "Concrete barrier", halfW: JB.n * JB.L / 2, parts: jerseyParts, solids: [JB_SOLID], decks: [], ghost: JB_SOLID, hint: "Three concrete blocks in a row: go round" },
  // (halfW = the road's: it stays square across the middle of the road, its port in the middle)
  ob_wall_round: { label: "Wall · round hole", halfW: ROAD_HW, parts: roundWallParts, solids: RW_BOXES, decks: [], ghost: mergeGeometries(RW_BOXES), aimAt: { hz: WALL_T / 2 }, hint: "A wall across the road: through its round port" },
  ob_ring_gate: { label: "Ring gate", parts: ringGateParts, solids: RG_BOXES, decks: [], ghost: mergeGeometries(RG_BOXES), air: true, passes: (x, y) => x * x + y * y < (RING_GATE.r - 1.3) ** 2, hint: "A ring in the air: fly through it" },
  ob_arch: { label: "Arch", halfW: AR.outer, parts: archParts, solids: AR_BOXES, decks: [], ghost: mergeGeometries(AR_BOXES), aimAt: { hz: AR.depth / 2 }, hint: "An orange vault: aim through it" },
  // (no solids: a ring of light. `boost.tube`: carRules raises the speed along it, on the wheels or in the air)
  ob_boost_tube: { label: "Boost tube", halfW: ROAD_HW, parts: boostTubeParts, solids: [], decks: [], ghost: BOOST_TUBE_GHOST, boost: { tube: true, r: BOOST_TUBE.r - 0.4, cy: 0.6, hz: BOOST_TUBE.len / 2 + 0.5, v: BOOST_TUBE.v, accel: BOOST_TUBE.accel }, hint: `Drive or fly through it: ${Math.round(BOOST_TUBE.v * 3.6)} km/h at once` },
  ob_open_cyl: { label: "Open cylinder", halfW: OPEN_CYL.r + OPEN_CYL.wall, parts: openCylParts, solids: [...CYL_SKIRTS, ...CYL_RIM_SOLIDS], decks: [CYL_INNER], ghost: mergeGeometries([CYL_OUTER, CYL_INNER].map((g) => g.toNonIndexed())), hint: "A big open pipe on the road: drive through it, ride up its walls" },
  sc_street_light: lightKind("Street light", "side", (p) => streetLightShape({ ...p, pair: false }), "A tall lamp past the road's edge, its arm over the road: it lights the road at night"),
  sc_street_lights: lightKind("Street lights · pair", "pair", (p) => streetLightShape({ ...p, pair: true }), "Two lamps facing each other across the road: they light it at night"),
  sc_flag: lightKind("Flag", "side", (p) => flagShape({ ...p, style: "mast" }), "A big flag on a 14 m mast beside the road, flying in the wind"),
  sc_banners: lightKind("Banner flags", "side", (p) => flagShape({ ...p, style: "banners" }), "Three tall banners beside the road, cyan, orange and white"),
  sc_palm: lightKind("Palm", "side", palmShape, "A 12 m palm beside the road"),
  // FREE RUNS, as the old game places them (user, 2026-11-01: "place them also like the old game"): a straight run
  // anywhere — on the ground or on a road — turned with Q / E
  sc_fence_run: freeRunKind("Chain-link fence", "sc_fence", 24, "A straight 24 m chain-link fence, anywhere: on the ground or a road (Q / E turn it)"),
  sc_wire_run: freeRunKind("Barbed wire", "sc_barbwire", 20, "A straight 20 m run of barbed wire, anywhere: on the ground or a road (Q / E turn it)"),
  sc_fence: edgeKind("Catch fence · edge", "sc_fence", "A 3 m chain-link fence along this piece's edge, its whole length (it follows the curve)"),
  sc_barbwire: edgeKind("Barbed wire · edge", "sc_barbwire", "Coils of barbed wire along this piece's edge, its whole length (it follows the curve)"),
  sc_led_board: adKind("LED board", "sc_led_board", "An LED board on two legs: chevrons, or your own scrolling text (Text in the panel)", { ledText: true }),
  sc_billboard: adKind("Ad billboard", "sc_billboard", "A billboard on two masts: our ads, or your own picture", { advert: "landscape" }),
  sc_prism: adKind("Ad prism", "sc_prism", "A tri-vision billboard: its slats turn every few seconds through three ads", { advert: "landscape" }),
  sc_totem: adKind("Ad totem", "sc_totem", "A tall poster cabinet on the ground: our ads, or your own picture", { advert: "portrait" }),
  ob_jump: { label: "Jump pad", parts: boostShape({}, jumpMaterial).parts, solids: [], decks: [], ghost: BOOST_FLAT, shape: (p) => boostShape(p, jumpMaterial), decal: true, boost: { hx: BOOST_PAD.w / 2, hz: BOOST_PAD.L / 2, jump: true }, hint: "Drive over it: it throws the car up" },
};
/** The zones of a track's pads, for carRules: { inv (world → pad frame), hx, hz }, and for a JUMP pad
 * `jump` and `up` (the pad's up in the world: the direction it throws). */
export function boostZones(props = []) {
  return props.filter((p) => OBSTACLES[p.kind]?.boost).map((p) => {
    const M = new THREE.Matrix4().fromArray(p.M);
    const z = { inv: M.clone().invert(), ...OBSTACLES[p.kind].boost };
    if (z.jump) z.up = new THREE.Vector3(0, 1, 0).transformDirection(M);
    if (z.tube) z.fwd = new THREE.Vector3(0, 0, -1).transformDirection(M); // (the way through: −Z, as along a road)
    return z;
  });
}
export const isObstacle = (id) => !!OBSTACLES[id];
/**
 * A track's movers to a car: the moving SOLIDS push it (setDynamicMovers), the moving DECKS are driven on (the
 * ground's mover tree) and carry it (car.deckMovers, arcadeCar). One call wherever a car meets a track's obstacles.
 */
export function attachMovers(car, ground, movers = []) {
  car.setDynamicMovers(movers.filter((m) => !m.deck));
  const decks = movers.filter((m) => m.deck);
  car.deckMovers = decks;
  if (ground?.setMoverBvh) {
    if (decks.length) { const set = new BvhSet(); set.set(decks.map((m) => m.bvh)); ground.setMoverBvh(set); } else ground.setMoverBvh(null);
  }
}
/** A placed obstacle's definition: its kind's, with the parts / solids / ghost of ITS shape (a door's offset). */
export const shapeOf = (kind, p = {}) => (OBSTACLES[kind].shape ? { ...OBSTACLES[kind], ...OBSTACLES[kind].shape(p) } : OBSTACLES[kind]);
// what stands IN THE WAY, in the obstacle's frame (half across x, half along z; m): the autopilot's line
// goes round it (avoidObstacles)
OBSTACLES.ob_block.footprint = { hx: BW / 2, hz: BD / 2 };
OBSTACLES.ob_container.footprint = { hx: CT.w / 2, hz: CT.L / 2 };
OBSTACLES.ob_roadblock.footprint = { hx: (RB.n * RB.L) / 2, hz: RB.base / 2 };
OBSTACLES.ob_jersey.footprint = { hx: (JB.n * JB.L) / 2, hz: JB.base / 2 };
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
      // weight: 0 → 1 over the 100 m before it, 1 alongside, back to 0 over 15 m after
      // (100, was 35, 2026-11-01: the arcade car at 268 km/h covers 35 m in 0.47 s — the test lap steered too late round
      // a Block in the middle and stopped on it)
      const w = lon > along ? smooth(1 - (lon - along) / (f.lead ?? 100)) : lon < -along ? smooth(1 - (-along - lon) / (f.tail ?? 15)) : 1;
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
export function buildObstacleSet(props = [], { look = true, physics = false, cache = null } = {}) {
  const group = new THREE.Group();
  // `cache` (the builder's, a Map uid → { sig, vis }): an obstacle whose record did not change keeps its look — an edit
  // rebuilt every prop's meshes and the next frame set every one up again for drawing (audit 2026-11-02)
  const usedLooks = cache ? new Set() : null;
  group.name = "obstacles";
  const decks = [], solids = [], movers = [], bodies = [], anims = []; // anims: looks that move by themselves (the flags' cloth)
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
      const sig = cache ? JSON.stringify(p) : null, hit = cache?.get(p.uid);
      if (cache) usedLooks.add(p.uid);
      vis = hit?.sig === sig ? hit.vis : obstacleLook(p.kind, p);
      if (cache) cache.set(p.uid, { sig, vis });
      vis.matrixAutoUpdate = false;
      vis.matrix.copy(M);
      vis.userData.uid = p.uid;
      group.add(vis);
      armVis = vis.getObjectByName("arm") ?? null;
      if (vis.userData.animate) anims.push(vis.userData.animate);
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
      // a MOVING DECK (the Spin barrel): its tree is a drive surface (attachMovers), and a car on it is carried round
      if (def.mover.deck) {
        mv.deck = true;
        const sp = def.mover.spin, axis = new THREE.Vector3(0, 0, 1).transformDirection(M), centre = new THREE.Vector3(0, sp.cy, 0).applyMatrix4(M);
        const inv = M.clone().invert(), q = new THREE.Quaternion(), lp = new THREE.Vector3();
        /** The car riding the floor: turned with it about its axis, ω·dt (wheels down, inside it, near the floor). */
        mv.carry = (body, dt) => {
          lp.copy(body.pos).applyMatrix4(inv);
          if (Math.abs(lp.z) > sp.L / 2 || Math.hypot(lp.x, lp.y - sp.cy) < sp.r - 2.5) return;
          q.setFromAxisAngle(axis, sp.omega * dt);
          body.pos.sub(centre).applyQuaternion(q).add(centre);
          body.vel.applyQuaternion(q);
          body.quat.premultiply(q);
        };
      }
      movers.push(mv);
    }
  }
  function setTime(t) {
    for (const a of anims) a(t);
    for (const m of movers) {
      m.t = t;
      if (m.pose) m.pose(t, m.rot); else m.rot.makeRotationY(m.omega * t);
      m.proxy.matrixWorld.multiplyMatrices(m.M, m.rot);
      if (m.armVis) { m.armVis.matrixAutoUpdate = false; m.armVis.matrix.copy(m.rot); m.armVis.matrixWorldNeedsUpdate = true; }
    }
  }
  setTime(0);
  if (cache) for (const k of [...cache.keys()]) if (!usedLooks.has(k)) cache.delete(k);
  return { group, decks, solids, movers, bodies, setTime };
}

// ---------------------------------------------------------------- STATIC LOOKS, INSTANCED
// (performance audit 2026-11-03, step 3: the builder drew its 77 obstacles mesh by mesh — 154 of an idle frame's 277
// draws, ~18 µs of CPU each — though most are the same drum, tyre, cone or block many times.) Every mesh of the given
// looks that has an identical twin (same geometry, same material, same shadow flags) and stays still is drawn in ONE
// InstancedMesh per kind; the meshes themselves stay, HIDDEN — the mouse still picks them (three's raycast ignores
// `visible`), and a page can show them again (setActive(false): the builder while the gizmo drags). Never batched:
// what moves on its own — a look with `userData.animate` (the flags), anything under a mover's "arm", anything with its
// own onBeforeRender (the prism's slats) — transparent parts (their sort order is per object) and multi-material meshes.
const NO_HOOK = THREE.Object3D.prototype.onBeforeRender;
/**
 * @param looks   the obstacles' look groups (their matrices set)
 * @param parent  where the instanced meshes go (world-placed like the looks' parent)
 * @param cache   a Map kept across calls: a kind whose instances did not change keeps its InstancedMesh
 * @returns {{ meshes: THREE.InstancedMesh[], setActive(on: boolean): void, dropped: THREE.InstancedMesh[] }}
 */
export function batchStaticLooks(looks, parent, cache = new Map()) {
  const groups = new Map();
  const _m = new THREE.Matrix4();
  // (a look kept from the last call may hold meshes the last batch hid: shown again first, then sorted anew)
  for (const vis of looks) vis.traverse((o) => { if (o.userData.batchHidden) { o.visible = true; o.userData.batchHidden = false; } });
  for (const vis of looks) {
    if (vis.userData.animate) continue;
    vis.updateMatrixWorld(true);
    const stack = [[vis, false]];
    while (stack.length) {
      const [o, skip] = stack.pop();
      const no = skip || o.name === "arm" || (o.onBeforeRender !== NO_HOOK);
      if (o.isMesh && !o.isInstancedMesh && !no && o.visible && !Array.isArray(o.material) && !o.material?.transparent) {
        const k = `${o.geometry.uuid}|${o.material.uuid}|${o.castShadow ? 1 : 0}${o.receiveShadow ? 1 : 0}`;
        (groups.get(k) ?? groups.set(k, []).get(k)).push(o);
      }
      for (const c of o.children) stack.push([c, no]);
    }
  }
  const meshes = [], hidden = [], used = new Set(), dropped = [];
  const toParent = parent.matrixWorld.clone().invert();
  for (const [k, list] of groups) {
    if (list.length < 2) continue;
    const mats = list.map((o) => _m.multiplyMatrices(toParent, o.matrixWorld).toArray());
    const sig = mats.map((a) => a.join(",")).join(";");
    used.add(k);
    let hit = cache.get(k);
    if (hit?.sig !== sig) {
      if (hit) dropped.push(hit.mesh);
      const src = list[0];
      const im = new THREE.InstancedMesh(src.geometry, src.material, list.length);
      mats.forEach((a, i) => im.setMatrixAt(i, _m.fromArray(a)));
      im.instanceMatrix.needsUpdate = true;
      im.castShadow = src.castShadow;
      im.receiveShadow = src.receiveShadow;
      im.matrixAutoUpdate = false;
      im.raycast = () => {}; // (the hidden meshes are picked, never these)
      im.computeBoundingSphere();
      im.name = "batchedLooks";
      hit = { sig, mesh: im };
      cache.set(k, hit);
    }
    hit.mesh.visible = true; // (a gizmo drag hid it — setActive(false) — and the rebuild after the move reuses it: user 11-03, "the hole wall disappearing")
    parent.add(hit.mesh);
    meshes.push(hit.mesh);
    for (const o of list) { o.visible = false; o.userData.batchHidden = true; hidden.push(o); }
  }
  // …and what has NO twin (a kerb, a ramp, a label: geometry made to measure, materials shared): MERGED per material
  // and vertex layout, like the road's chunks — one draw per material instead of one per piece
  const layout = (g) => Object.entries(g.attributes).map(([n, a]) => `${n}:${a.itemSize}:${a.array.constructor.name}:${a.normalized ? 1 : 0}`).sort().join(",") + (g.index ? "|i" : "|n");
  const merges = new Map();
  for (const [k, list] of groups) {
    if (list.length >= 2) continue;
    const o = list[0];
    const mk = `merge|${o.material.uuid}|${o.castShadow ? 1 : 0}${o.receiveShadow ? 1 : 0}|${layout(o.geometry)}`;
    (merges.get(mk) ?? merges.set(mk, []).get(mk)).push(o);
  }
  for (const [k, list] of merges) {
    if (list.length < 2) continue;
    const mats = list.map((o) => _m.multiplyMatrices(toParent, o.matrixWorld).toArray());
    const sig = list.map((o, i) => `${o.geometry.uuid}@${mats[i].join(",")}`).join(";");
    let hit = cache.get(k);
    if (hit?.sig !== sig) {
      let g = null;
      try { g = mergeGeometries(list.map((o, i) => o.geometry.clone().applyMatrix4(_m.fromArray(mats[i]))), false); } catch { g = null; }
      if (!g) continue; // (not mergeable after all: they stay as they are)
      if (hit) dropped.push(hit.mesh);
      g.computeBoundingSphere();
      const mesh = new THREE.Mesh(g, list[0].material);
      mesh.castShadow = list[0].castShadow;
      mesh.receiveShadow = list[0].receiveShadow;
      mesh.matrixAutoUpdate = false;
      mesh.raycast = () => {};
      mesh.name = "batchedLooks";
      mesh.userData.ownGeo = true;
      hit = { sig, mesh };
      cache.set(k, hit);
    }
    used.add(k);
    hit.mesh.visible = true; // (a gizmo drag hid it — setActive(false) — and the rebuild after the move reuses it: user 11-03, "the hole wall disappearing")
    parent.add(hit.mesh);
    meshes.push(hit.mesh);
    for (const o of list) { o.visible = false; o.userData.batchHidden = true; hidden.push(o); }
  }
  for (const [k, v] of [...cache]) if (!used.has(k)) { dropped.push(v.mesh); cache.delete(k); }
  for (const im of dropped) im.removeFromParent();
  return {
    meshes, dropped,
    /** true: the instances / merges draw, the meshes hidden (the default); false: the meshes themselves draw (while they move) */
    setActive(on) { for (const im of meshes) im.visible = on; for (const o of hidden) o.visible = !on; },
  };
}
