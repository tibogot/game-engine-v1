import * as THREE from "three";
import { seededRand } from "./woodUtils.js";

/**
 * Tire-wall barrier along a spline — tyres laid FLAT (axis vertical) and stacked
 * on top of each other into a wall, in rows (height) and depth (toward track),
 * with an optional brick-style offset per layer and a dark binding rail on top.
 */

export const TIRE_WALL_DEFAULTS = {
  outerRadius: 0.36, // tyre outer radius (footprint)
  tube: 0.13, // rubber thickness (half the flat tyre's height)
  rows: 5, // stacked height (tyres)
  depth: 2, // tyres deep (toward track)
  sideOffset: 0, // shift off the spline centre
  side: "right",
  brickOffset: true, // offset alternate layers by half a tyre
  jitter: 0.03, // random position wobble
  rotJitter: 1.5, // random flat spin so treads differ

  topRail: true,
  railColor: "#15161a",
  tireColor: "#16171b",
  toneVar: 0.1,
  roughness: 0.92,
  seed: 9,
};

const _t = new THREE.Vector3();
const _perp = new THREE.Vector3();
const WORLD_UP = new THREE.Vector3(0, 1, 0);

export function buildTireWallMesh({
  points,
  closed = false,
  params = {},
  getWorldHeight = () => 0,
}) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const p = { ...TIRE_WALL_DEFAULTS, ...params };

  const grounded = points.map((pt) =>
    new THREE.Vector3(pt.x, getWorldHeight(pt.x, pt.z), pt.z),
  );
  const curve = new THREE.CatmullRomCurve3(grounded, !!closed, "catmullrom", 0.5);
  const length = curve.getLength();

  const R = Math.max(0.12, p.outerRadius);
  const tube = Math.max(0.04, Math.min(p.tube, R * 0.6));
  const torusR = R - tube;
  const rows = Math.max(1, p.rows | 0);
  const depth = Math.max(1, p.depth | 0);
  const sign = p.side === "left" ? 1 : -1;

  const along = R * 1.85; // spacing between tyre columns along the path
  const depthStep = R * 1.85; // spacing toward the track
  const rowStep = tube * 1.9; // vertical stack step (flat tyres nest a little)
  const cols = Math.max(2, Math.floor(length / along) + 1);
  const total = cols * rows * depth;

  const group = new THREE.Group();
  group.name = "TireWall";

  const tireMat = new THREE.MeshStandardMaterial({
    color: p.tireColor,
    roughness: p.roughness,
    metalness: 0,
  });
  const tireGeo = new THREE.TorusGeometry(torusR, tube, 10, 22);
  const tires = new THREE.InstancedMesh(tireGeo, tireMat, total);
  tires.castShadow = true;
  tires.receiveShadow = true;

  // lay the tyre flat: torus axis (local Z) -> world up
  const flatQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0));

  const m = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3(1, 1, 1);
  const baseCol = new THREE.Color(p.tireColor);
  const col = new THREE.Color();
  let idx = 0;

  for (let c = 0; c < cols; c++) {
    const t = cols === 1 ? 0 : c / (cols - 1);
    const cp = curve.getPointAt(t);
    _t.copy(curve.getTangentAt(t));
    _t.y = 0;
    if (_t.lengthSq() < 1e-9) _t.set(0, 0, 1);
    _t.normalize();
    _perp.set(-_t.z, 0, _t.x).normalize();
    const groundY = getWorldHeight(cp.x, cp.z);

    for (let r = 0; r < rows; r++) {
      // offset alternate layers by half a tyre along the path (brick stacking)
      const brick = p.brickOffset && r % 2 === 1 ? along * 0.5 : 0;
      for (let d = 0; d < depth; d++) {
        const sd = (seededRand(p.seed, idx * 2 + 1) - 0.5) * p.jitter;
        const sa = (seededRand(p.seed, idx * 2 + 2) - 0.5) * p.jitter;
        const off = sign * (p.sideOffset + d * depthStep);
        pos.set(
          cp.x + _perp.x * off + _t.x * (brick + sa),
          groundY + tube + r * rowStep,
          cp.z + _perp.z * off + _t.z * (brick + sa),
        );
        pos.addScaledVector(_perp, sd);

        const spin = seededRand(p.seed, idx * 3 + 3) * Math.PI * 2 * (p.rotJitter > 0 ? 1 : 0);
        const rot = new THREE.Quaternion().setFromAxisAngle(WORLD_UP, spin).multiply(flatQ);
        m.compose(pos, rot, scl);
        tires.setMatrixAt(idx, m);

        const v = (seededRand(p.seed, idx * 5 + 4) - 0.5) * 2 * p.toneVar;
        col.copy(baseCol).offsetHSL(0, 0, v);
        tires.setColorAt(idx, col);
        idx++;
      }
    }
  }
  tires.instanceMatrix.needsUpdate = true;
  if (tires.instanceColor) tires.instanceColor.needsUpdate = true;
  group.add(tires);

  // dark binding rail along the top of the wall
  if (p.topRail) {
    const railMat = new THREE.MeshStandardMaterial({ color: p.railColor, roughness: 0.8, metalness: 0.1 });
    const railGeo = new THREE.BoxGeometry(1, 1, 1);
    const railY = tube + (rows - 1) * rowStep + tube * 0.8;
    const wallDepth = (depth - 1) * depthStep + R * 1.6;
    const segs = Math.max(2, cols);
    const rail = new THREE.InstancedMesh(railGeo, railMat, segs - 1);
    rail.castShadow = true;
    const rm = new THREE.Matrix4();
    const rp = new THREE.Vector3();
    const negT = new THREE.Vector3();
    for (let i = 0; i < segs - 1; i++) {
      const a = curve.getPointAt(i / (segs - 1));
      const b = curve.getPointAt((i + 1) / (segs - 1));
      _t.subVectors(b, a);
      _t.y = 0;
      const segLen = _t.length() + 0.05;
      _t.normalize();
      _perp.set(-_t.z, 0, _t.x).normalize();
      negT.copy(_t).multiplyScalar(-1);
      const gy = getWorldHeight((a.x + b.x) / 2, (a.z + b.z) / 2);
      const off = sign * (p.sideOffset + ((depth - 1) * depthStep) / 2);
      rp.set(
        (a.x + b.x) / 2 + _perp.x * off,
        gy + railY,
        (a.z + b.z) / 2 + _perp.z * off,
      );
      rm.makeBasis(negT, WORLD_UP, _perp)
        .scale(new THREE.Vector3(segLen, tube * 1.5, wallDepth))
        .setPosition(rp);
      rail.setMatrixAt(i, rm);
    }
    rail.instanceMatrix.needsUpdate = true;
    group.add(rail);
  }

  return group;
}

export const TIRE_WALL_HERO_POINTS = [
  { x: -14, y: 0, z: -14 },
  { x: 14, y: 0, z: -14 },
];
