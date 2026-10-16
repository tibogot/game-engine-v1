import * as THREE from "three";
import { buildWorldUpProfileGeometry } from "./guardrail.js";

/**
 * Jersey-style concrete barrier along a Catmull-Rom spline.
 * Param names mirror v2/toolState fullRoad block.
 */

export const BARRIER_DEFAULTS = {
  height: 0.85,
  topWidth: 0.15,
  bottomWidth: 0.45,
  pathSegments: 80,
  color: "#7d7d7d",
  roughness: 0.85,
  metalness: 0,
};

function makeJerseyProfile(height, topWidth, bottomWidth) {
  const h = Math.max(0.12, height);
  const top = Math.max(0.05, topWidth);
  const bottom = Math.max(0.08, bottomWidth);
  return [
    { y: 0, z: -bottom * 0.5 },
    { y: h * 0.3, z: -bottom * 0.35 },
    { y: h * 0.7, z: -top * 0.6 },
    { y: h, z: -top * 0.5 },
    { y: h, z: top * 0.5 },
    { y: h * 0.7, z: top * 0.6 },
    { y: h * 0.3, z: bottom * 0.35 },
    { y: 0, z: bottom * 0.5 },
  ];
}

/**
 * @param {object} opts
 * @param {THREE.Vector3[]|{x:number,y:number,z:number}[]} opts.points
 * @param {boolean} [opts.closed]
 * @param {object} [opts.params]
 * @param {(x:number,z:number)=>number} [opts.getWorldHeight]
 * @returns {THREE.Group|null}
 */
export function buildBarrierMesh({
  points,
  closed = false,
  params = {},
  getWorldHeight = () => 0,
}) {
  if (!Array.isArray(points) || points.length < 2) return null;

  const p = { ...BARRIER_DEFAULTS, ...params };
  const height = Math.max(0.12, p.height);
  const topWidth = Math.max(0.05, p.topWidth);
  const bottomWidth = Math.max(0.08, p.bottomWidth);
  const pathSegs = Math.max(16, p.pathSegments | 0);

  const groundedPoints = points.map((pt) => {
    const v = pt.isVector3 ? pt : new THREE.Vector3(pt.x, pt.y, pt.z);
    return new THREE.Vector3(v.x, getWorldHeight(v.x, v.z), v.z);
  });

  const curve = new THREE.CatmullRomCurve3(
    groundedPoints,
    !!closed,
    "catmullrom",
    0.5,
  );

  const profile = makeJerseyProfile(height, topWidth, bottomWidth);
  const geo = buildWorldUpProfileGeometry(
    curve,
    pathSegs,
    profile,
    1.0,
    closed,
    getWorldHeight,
  );

  const mat = new THREE.MeshStandardMaterial({
    color: p.color,
    roughness: p.roughness,
    metalness: p.metalness,
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  const group = new THREE.Group();
  group.name = "Barrier";
  group.add(mesh);
  return group;
}
