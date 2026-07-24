/**
 * Grey-box structure kit — parametric building blocks for fast level blockout.
 *
 * Design (why this shape, not CSG):
 *   • Every piece is a *fixed* preset → one primitive type → one InstancedMesh →
 *     ONE draw call for any number of placed copies (PropStore dedupes slots by
 *     name, exactly like `Cube`). No boolean = no unique per-instance geometry =
 *     no draw-call blow-up.
 *   • A hole (door / window) is NOT a subtraction — it is a frame of boxes
 *     merged into one geometry, the way Quake/Source/Unreal blockout kits do it.
 *     ~50-150 clean tris, no float-robustness issues, no T-junctions.
 *   • Collision: box-shaped pieces stay non-solid (cheap AABB proxy, one box).
 *     Pieces with holes / slopes / steps are flagged `solid` so SolidCollider
 *     gives real-triangle collision from a single shared-per-type BVH — the
 *     doorway is genuinely walkable, and cost is one ~100-tri BVH no matter how
 *     many instances exist.
 *
 * All builders return ONE merged BufferGeometry, centered on X/Z and sitting on
 * the ground (min.y = 0), so they rotate about their centre like `Cube` and tile
 * on the editor's 1 m shift-snap grid. Module wall = 4 wide × 3 tall × 0.2 thick.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

// ── Module dimensions (metres) ────────────────────────────────────────────────
const W = 4.0;    // wall segment width
const H = 3.0;    // wall / storey height
const T = 0.2;    // wall thickness
const FLOOR_T = 0.2;

// ── Box merge helper ──────────────────────────────────────────────────────────
// All inputs are BoxGeometry (position + normal + uv), so the merge never hits
// the attribute-mismatch → null-mesh trap. Intermediates are disposed.

/** Axis-aligned box given size + center. */
function box(w, h, d, cx, cy, cz) {
  return new THREE.BoxGeometry(w, h, d).translate(cx, cy, cz);
}

/** Merge a list of box geometries into one, then dispose the parts. */
function mergeBoxes(parts) {
  const geo = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (!geo) throw new Error("[greyboxKit] mergeGeometries failed (attribute mismatch)");
  geo.computeBoundingBox();
  return geo;
}

// ── Builders ──────────────────────────────────────────────────────────────────

/** Flat floor / ceiling slab. Box-shaped → non-solid. */
function buildFloor() {
  return box(W, FLOOR_T, W, 0, FLOOR_T / 2, 0);
}

/** Solid wall panel. Box-shaped → non-solid. */
function buildWall() {
  return box(W, H, T, 0, H / 2, 0);
}

/** Low half-wall / vault ledge for parkour. Box-shaped → non-solid. */
function buildHalfWall() {
  return box(W, 1.0, 0.3, 0, 0.5, 0);
}

/** Square pillar / column. Box-shaped → non-solid. */
function buildPillar() {
  return box(0.5, H, 0.5, 0, H / 2, 0);
}

/**
 * Wall with a doorway opening (frame of boxes: 2 jambs + lintel). Solid.
 * Door: 1.4 wide, 2.2 tall, floor-to-lintel, centred.
 */
function buildDoorway() {
  const doorW = 1.4, doorH = 2.2;
  const sideW = (W - doorW) / 2;
  const lintelH = H - doorH;
  return mergeBoxes([
    box(sideW, H, T, -(doorW / 2 + sideW / 2), H / 2, 0),        // left jamb
    box(sideW, H, T,  (doorW / 2 + sideW / 2), H / 2, 0),        // right jamb
    box(doorW, lintelH, T, 0, doorH + lintelH / 2, 0),           // lintel above
  ]);
}

/**
 * Wall with a window opening (below-sill + header + 2 sides). Solid.
 * Window: 1.8 wide, 1.2 tall, sill at 1.0 m.
 */
function buildWindow() {
  const winW = 1.8, winH = 1.2, sill = 1.0;
  const sideW = (W - winW) / 2;
  const headY = sill + winH;
  const headH = H - headY;
  return mergeBoxes([
    box(sideW, H, T, -(winW / 2 + sideW / 2), H / 2, 0),         // left
    box(sideW, H, T,  (winW / 2 + sideW / 2), H / 2, 0),         // right
    box(winW, sill, T, 0, sill / 2, 0),                          // below sill
    box(winW, headH, T, 0, headY + headH / 2, 0),                // header above
  ]);
}

/**
 * Straight staircase, W wide × H up × W deep, `steps` treads. Solid (real steps).
 * Each step is a full-height block up to its tread so the capsule walks up it.
 */
function buildStairs(steps = 12) {
  const stepH = H / steps;
  const stepD = W / steps;
  const parts = [];
  for (let i = 0; i < steps; i++) {
    const h = (i + 1) * stepH;
    const cz = -W / 2 + (i + 0.5) * stepD;
    parts.push(box(W, h, stepD, 0, h / 2, cz));
  }
  return mergeBoxes(parts);
}

/**
 * Ramp wedge, W wide × H up × W deep. Flat bottom, vertical back at +z,
 * hypotenuse rising from the front (-z) to the back. Solid (walkable slope).
 * Built non-indexed for flat shading; SolidCollider reads position only.
 */
function buildRamp() {
  const hw = W / 2, hd = W / 2, h = H;
  // 6 corners: front-bottom (z=-hd, y=0), back-bottom (z=+hd, y=0),
  //            back-top (z=+hd, y=h), across the two x sides.
  const L = -hw, R = hw;
  // Named points: b=bottom, t=top; f=front, k=back; l=left, r=right
  const fbl = [L, 0, -hd], fbr = [R, 0, -hd];
  const kbl = [L, 0,  hd], kbr = [R, 0,  hd];
  const ktl = [L, h,  hd], ktr = [R, h,  hd];

  const tris = [
    // bottom (2)
    fbl, kbr, kbl,  fbl, fbr, kbr,
    // back vertical (2)
    kbl, kbr, ktr,  kbl, ktr, ktl,
    // slope / hypotenuse (2)
    fbl, ktl, ktr,  fbl, ktr, fbr,
    // left triangular side (1)
    fbl, kbl, ktl,
    // right triangular side (1)
    fbr, ktr, kbr,
  ];

  const pos = new Float32Array(tris.length * 3);
  for (let i = 0; i < tris.length; i++) {
    pos[i * 3] = tris[i][0]; pos[i * 3 + 1] = tris[i][1]; pos[i * 3 + 2] = tris[i][2];
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();  // non-indexed → flat per-face normals
  geo.computeBoundingBox();
  return geo;
}

// ── Registry ──────────────────────────────────────────────────────────────────
// `solid: true` routes the type through SolidCollider (real-triangle collision);
// otherwise it uses the cheap one-box AABB proxy. Names double as slot ids and
// must stay stable (saved in .v3proj, restored by name).

export const GREYBOX_KIT = [
  { name: "Floor slab",   solid: false, build: buildFloor },
  { name: "Wall",         solid: false, build: buildWall },
  { name: "Doorway wall", solid: true,  build: buildDoorway },
  { name: "Window wall",  solid: true,  build: buildWindow },
  { name: "Half wall",    solid: false, build: buildHalfWall },
  { name: "Pillar",       solid: false, build: buildPillar },
  { name: "Stairs",       solid: true,  build: () => buildStairs(12) },
  { name: "Ramp block",   solid: true,  build: buildRamp },
];

export function buildGreyboxGeometry(name) {
  const piece = GREYBOX_KIT.find((p) => p.name === name);
  return piece ? piece.build() : null;
}
