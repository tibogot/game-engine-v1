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

const BOLT = 0x3fd2ff, SIGNAL = 0xff7a1a;
let MATS = null;
const mats = () => (MATS ??= {
  body: new THREE.MeshStandardMaterial({ color: 0x1c2436, roughness: 0.55, metalness: 0.25 }),
  top: new THREE.MeshStandardMaterial({ color: 0x2a2f3a, roughness: 0.85, metalness: 0.05 }),
  bolt: new THREE.MeshStandardMaterial({ color: BOLT, emissive: BOLT, emissiveIntensity: 1.5, roughness: 0.4 }),
  signal: new THREE.MeshStandardMaterial({ color: SIGNAL, emissive: SIGNAL, emissiveIntensity: 0.9, roughness: 0.45 }),
  white: new THREE.MeshStandardMaterial({ color: 0xe8edf5, roughness: 0.5, metalness: 0.1 }),
});
const _r = new THREE.Vector3();
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
const ARM = 14.6, ARM_Y = 0.95, ARM_T = 0.7, POST_R = 0.6, POST_H = 3.4;
const SWEEP_PERIOD = 5; // s per turn: the tips move at ~9 m/s. The arm stays inside the kerbs (16 m road: no gap a car fits through, and it never cuts the rails)
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
function doorShape({ hw = 8, dx = 0 } = {}) {
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

export const OBSTACLES = {
  ob_block: { label: "Block", parts: blockParts, solids: [BLOCK_SOLID], decks: [BLOCK_DECK], ghost: BLOCK_SOLID, hint: "Dodge it, or jump onto it" },
  ob_sweeper: { label: "Sweeper", parts: sweeperParts, solids: [SWEEP_POST], decks: [], ghost: mergeGeometries([SWEEP_POST, SWEEP_ARM]), mover: { arm: SWEEP_ARM, omega: (2 * Math.PI) / SWEEP_PERIOD }, hint: "A bar turning over the road: time it" },
  ob_wall_door: { label: "Wall · door", parts: doorParts, solids: DOOR_BOXES, decks: [], ghost: mergeGeometries(DOOR_BOXES), shape: doorShape, hint: "A wall across the road: drive through its door" },
  // `air`: placed on a jump's flight, not on the road (the builder's arc snap)
  ob_wall_hole: { label: "Wall · hole", parts: holeParts, solids: HOLE_BOXES, decks: [], ghost: mergeGeometries(HOLE_BOXES), air: true, hint: "A wall in the air: fly through its hole" },
};
export const isObstacle = (id) => !!OBSTACLES[id];
/** A placed obstacle's definition: its kind's, with the parts / solids / ghost of ITS shape (a door's offset). */
export const shapeOf = (kind, p = {}) => (OBSTACLES[kind].shape ? { ...OBSTACLES[kind], ...OBSTACLES[kind].shape(p) } : OBSTACLES[kind]);
// what stands IN THE WAY, in the obstacle's frame (half across x, half along z; m): the autopilot's line
// goes round it (avoidObstacles)
OBSTACLES.ob_block.footprint = { hx: BW / 2, hz: BD / 2 };
OBSTACLES.ob_sweeper.footprint = { hx: POST_R + 0.3, hz: POST_R + 0.3 };
// a DOOR is the other way round: the line goes THROUGH it (its centre), not round it
OBSTACLES.ob_wall_door.aimAt = { hz: WALL_T / 2 };

/**
 * THE AUTOPILOT'S LINE ROUND THE OBSTACLES (builder test lap, drive page autopilot): a copy of the ride
 * whose points ease out sideways ~35 m before an obstacle that stands on the line, to the side with room
 * (2 m clear of it, inside the kerbs), hold past it and ease back. The race's own ride (gates) is untouched.
 * @param ride  [{P, T, U, …}]  @param props track.props  @param hw the road's half width
 */
export function avoidObstacles(ride, props = [], hw = 8) {
  const shift = new Float32Array(ride.length);
  const C = new THREE.Vector3(), ax = new THREE.Vector3(), az = new THREE.Vector3(), R = new THREE.Vector3(), d = new THREE.Vector3();
  const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
  for (const p of props) {
    const f = OBSTACLES[p.kind]?.footprint ?? OBSTACLES[p.kind]?.aimAt;
    if (!f) continue;
    const aim = !OBSTACLES[p.kind].footprint;
    const M = new THREE.Matrix4().fromArray(p.M);
    C.setFromMatrixPosition(M);
    ax.set(1, 0, 0).transformDirection(M);
    if (aim && p.dx) C.addScaledVector(ax, p.dx); // the door's middle
    az.set(0, 0, 1).transformDirection(M);
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
      const w = lon > along ? smooth(1 - (lon - along) / 35) : lon < -along ? smooth(1 - (-along - lon) / 15) : 1;
      if (w <= 0) return;
      if (aim) { if (Math.abs(lat * w) > Math.abs(shift[i])) shift[i] = lat * w; return; }
      const room = hw - 1.6;
      let target = lat > 0 ? lat - across - 2 : lat + across + 2; // pass on the side away from its centre
      if (Math.abs(target) > room) target = lat > 0 ? lat + across + 2 : lat - across - 2; // no room: the other side
      if (Math.abs(target) > room) return; // it blocks the road: nothing to steer round
      const s = target * w;
      if (Math.abs(s) > Math.abs(shift[i])) shift[i] = s;
    });
  }
  return ride.map((r, i) => {
    if (!shift[i]) return r;
    R.crossVectors(r.T, r.U ?? UP).normalize();
    return { ...r, P: r.P.clone().addScaledVector(R, shift[i]) };
  });
}
const UP = new THREE.Vector3(0, 1, 0);

/** One obstacle's look (a fresh group; geometry and materials shared). */
export function obstacleLook(kind, p) {
  const g = shapeOf(kind, p).parts();
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

/**
 * Everything a page needs for a track's obstacles.
 * @param props  track.props
 * @param o.look  build the meshes (false in Node tests)
 * @returns {{ group, decks: {geometry, M}[], solids: {geometry, M}[], movers: object[], setTime(t: number): void }}
 */
export function buildObstacleSet(props = [], { look = true } = {}) {
  const group = new THREE.Group();
  group.name = "obstacles";
  const decks = [], solids = [], movers = [];
  const up = new THREE.Vector3();
  for (const p of props) {
    if (!OBSTACLES[p.kind]) continue;
    const def = shapeOf(p.kind, p);
    const M = new THREE.Matrix4().fromArray(p.M);
    for (const g of def.solids) solids.push({ geometry: g, M });
    for (const g of def.decks) decks.push({ geometry: g, M });
    let vis = null, armVis = null;
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
      movers.push({
        uid: p.uid, proxy, armVis, M, omega: def.mover.omega, angVel, pivot, rot,
        bvh: new RigidBvh(proxy),
        /** the bar's surface velocity at a contact: ω × r about the post */
        velocityAt(pt, out) { _r.subVectors(pt, pivot); return out.crossVectors(angVel, _r); },
      });
    }
  }
  function setTime(t) {
    for (const m of movers) {
      m.rot.makeRotationY(m.omega * t);
      m.proxy.matrixWorld.multiplyMatrices(m.M, m.rot);
      if (m.armVis) { m.armVis.matrixAutoUpdate = false; m.armVis.matrix.copy(m.rot); m.armVis.matrixWorldNeedsUpdate = true; }
    }
  }
  setTime(0);
  return { group, decks, solids, movers, setTime };
}
