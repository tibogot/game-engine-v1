import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

/**
 * Procedural power line / telephone poles along a Catmull-Rom spline.
 *
 * Poles are placed at intervals and CONFORM to the terrain (getWorldHeight).
 * Between consecutive poles the wires hang in a catenary sag — the same span
 * math as the bridge arch, just inverted (downward parabola).
 */

export const POWER_LINE_DEFAULTS = {
  spacing: 18, // distance between poles
  poleHeight: 7.0,
  poleRadius: 0.14,

  crossarms: 2, // horizontal arms near the top
  crossarmLength: 2.4,
  crossarmThick: 0.12,
  crossarmDrop: 0.5, // first arm this far below the top
  crossarmSpacing: 0.9, // gap between arms

  insulators: true,
  topWire: true, // a single earth wire at the pole apex

  wireSag: 1.2, // mid-span droop
  wireRadius: 0.035,
  wireSegments: 14,

  poleColor: "#6b4f2f",
  armColor: "#5a4226",
  wireColor: "#171717",
  insulatorColor: "#2a2f36",
  roughness: 0.85,
  metalness: 0.05,
};

const WORLD_UP = new THREE.Vector3(0, 1, 0);

function mat(hex, p, rough = p.roughness, metal = p.metalness) {
  return new THREE.MeshStandardMaterial({ color: hex, roughness: rough, metalness: metal });
}

// catenary-ish sag curve between two points (downward parabola)
function sagCurve(a, b, sag, segs) {
  const pts = [];
  const t = new THREE.Vector3();
  for (let i = 0; i <= segs; i++) {
    const k = i / segs;
    t.copy(a).lerp(b, k);
    t.y -= sag * 4 * k * (1 - k);
    pts.push(t.clone());
  }
  return new THREE.CatmullRomCurve3(pts);
}

/**
 * @param {object} opts
 * @param {THREE.Vector3[]|{x,y,z}[]} opts.points
 * @param {boolean} [opts.closed]
 * @param {object} [opts.params]
 * @param {(x:number,z:number)=>number} [opts.getWorldHeight]
 * @returns {THREE.Group|null}
 */
export function buildPowerLineMesh({
  points,
  closed = false,
  params = {},
  getWorldHeight = () => 0,
}) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const p = { ...POWER_LINE_DEFAULTS, ...params };

  const grounded = points.map((pt) =>
    new THREE.Vector3(pt.x, getWorldHeight(pt.x, pt.z), pt.z),
  );
  const curve = new THREE.CatmullRomCurve3(grounded, !!closed, "catmullrom", 0.5);
  const length = curve.getLength();
  const poleCount = Math.max(2, Math.floor(length / Math.max(2, p.spacing)) + 1);

  // wire attachment offsets relative to a pole {uy: height, px: perp offset}
  const arms = Math.max(1, p.crossarms | 0);
  const wireDefs = [];
  for (let c = 0; c < arms; c++) {
    const armY = p.poleHeight - p.crossarmDrop - c * p.crossarmSpacing;
    const half = p.crossarmLength * 0.5 * 0.85;
    for (const px of [-half, 0, half]) wireDefs.push({ uy: armY, px });
  }
  if (p.topWire) wireDefs.push({ uy: p.poleHeight + 0.06, px: 0 });

  const group = new THREE.Group();
  group.name = "PowerLine";

  const poleMat = mat(p.poleColor, p);
  const armMat = mat(p.armColor, p);
  const wireMat = mat(p.wireColor, p, 0.7, 0.2);
  const insMat = mat(p.insulatorColor, p, 0.4, 0.1);

  // ── per-pole transforms + wire attachment points ──
  const attaches = []; // attaches[i] = [Vector3, ...] for that pole
  const poleGeo = new THREE.CylinderGeometry(p.poleRadius * 0.8, p.poleRadius, p.poleHeight, 8);
  const poles = new THREE.InstancedMesh(poleGeo, poleMat, poleCount);
  poles.castShadow = true;
  poles.receiveShadow = true;

  const armGeo = new THREE.BoxGeometry(1, 1, 1);
  const armMesh = new THREE.InstancedMesh(armGeo, armMat, poleCount * arms);
  armMesh.castShadow = true;

  const insGeo = new THREE.CylinderGeometry(0.05, 0.05, 0.16, 6);
  const insMesh = p.insulators
    ? new THREE.InstancedMesh(insGeo, insMat, poleCount * wireDefs.length)
    : null;
  if (insMesh) insMesh.castShadow = true;

  const m = new THREE.Matrix4();
  const scl = new THREE.Vector3();
  const tangent = new THREE.Vector3();
  const perp = new THREE.Vector3();
  const zc = new THREE.Vector3();
  let ai = 0;
  let ii = 0;

  for (let i = 0; i < poleCount; i++) {
    const t = poleCount === 1 ? 0 : i / (poleCount - 1);
    const pos = curve.getPointAt(t);
    const groundY = getWorldHeight(pos.x, pos.z);
    tangent.copy(curve.getTangentAt(t));
    tangent.y = 0;
    if (tangent.lengthSq() < 1e-9) tangent.set(0, 0, 1);
    tangent.normalize();
    perp.set(-tangent.z, 0, tangent.x).normalize();

    // pole (vertical)
    m.identity().setPosition(pos.x, groundY + p.poleHeight * 0.5, pos.z);
    poles.setMatrixAt(i, m);

    // crossarms (length along perp)
    zc.crossVectors(perp, WORLD_UP);
    for (let c = 0; c < arms; c++) {
      const armY = groundY + p.poleHeight - p.crossarmDrop - c * p.crossarmSpacing;
      scl.set(p.crossarmLength, p.crossarmThick, p.crossarmThick);
      m.makeBasis(perp, WORLD_UP, zc).scale(scl).setPosition(pos.x, armY, pos.z);
      armMesh.setMatrixAt(ai++, m);
    }

    // attachment points (+ insulators)
    const list = [];
    for (const d of wireDefs) {
      const wp = new THREE.Vector3(
        pos.x + perp.x * d.px,
        groundY + d.uy,
        pos.z + perp.z * d.px,
      );
      list.push(wp);
      if (insMesh) {
        m.identity().setPosition(wp.x, wp.y - 0.08, wp.z);
        insMesh.setMatrixAt(ii++, m);
      }
    }
    attaches.push(list);
  }
  poles.instanceMatrix.needsUpdate = true;
  armMesh.instanceMatrix.needsUpdate = true;
  group.add(poles, armMesh);
  if (insMesh) {
    insMesh.instanceMatrix.needsUpdate = true;
    group.add(insMesh);
  }

  // ── wires: catenary tubes between consecutive poles, merged ──
  const tubes = [];
  const segs = Math.max(4, p.wireSegments | 0);
  for (let i = 0; i < poleCount - 1; i++) {
    for (let k = 0; k < wireDefs.length; k++) {
      const curveW = sagCurve(attaches[i][k], attaches[i + 1][k], p.wireSag, segs);
      tubes.push(new THREE.TubeGeometry(curveW, segs, p.wireRadius, 4, false));
    }
  }
  if (tubes.length) {
    const merged = mergeGeometries(tubes, false);
    tubes.forEach((g) => g.dispose());
    if (merged) {
      const wires = new THREE.Mesh(merged, wireMat);
      wires.castShadow = true;
      group.add(wires);
    }
  }

  return group;
}

/** Fixed hero run — a few poles so the catenary sag reads clearly. */
export const POWER_LINE_HERO_POINTS = [
  { x: -24, y: 0, z: -14 },
  { x: -8, y: 0, z: -14 },
  { x: 8, y: 0, z: -14 },
  { x: 24, y: 0, z: -14 },
];
