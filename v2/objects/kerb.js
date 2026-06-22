import * as THREE from "three";
import { buildChunkedKerbGroup } from "./kerbChunk.js";

/**
 * Racing kerb (red/white chunks) along a Catmull-Rom spline.
 * Uses the same chunked geometry as v2 full road / smart road accessories.
 */

export const KERB_DEFAULTS = {
  width: 0.8,
  height: 0.12,
  lipHeight: 0.03,
  stripeLength: 0.8,
  side: "right",
  colorA: "#cc2222",
  colorB: "#f2f2f2",
  roughness: 0.6,
  metalness: 0,
};

function sideToSign(side) {
  return side === "left" ? 1 : -1;
}

/**
 * @param {object} opts
 * @param {THREE.Vector3[]|{x:number,y:number,z:number}[]} opts.points
 * @param {boolean} [opts.closed]
 * @param {object} [opts.params]
 * @param {(x:number,z:number)=>number} [opts.getWorldHeight]
 * @returns {THREE.Group|null}
 */
export function buildKerbMesh({
  points,
  closed = false,
  params = {},
  getWorldHeight = () => 0,
}) {
  if (!Array.isArray(points) || points.length < 2) return null;

  const p = { ...KERB_DEFAULTS, ...params };
  const kerbWidth = Math.max(0.05, p.width);
  const kerbHeight = Math.max(0.01, p.height);
  const lipHeight = Math.max(0, p.lipHeight);
  const squareSize = Math.max(0.1, p.stripeLength);
  const sideSign = sideToSign(p.side);

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

  const group = buildChunkedKerbGroup({
    curve,
    startT: 0,
    endT: 1,
    sideSign,
    lateralDist: 0,
    kerbWidth,
    kerbHeight,
    lipHeight,
    squareSize,
    colorA: p.colorA,
    colorB: p.colorB,
    getWorldHeight,
    isPreview: false,
  });

  if (!group) return null;
  group.name = "Kerb";

  group.traverse((obj) => {
    if (obj.isMesh && obj.material) {
      obj.material.roughness = p.roughness;
      obj.material.metalness = p.metalness;
    }
  });

  return group;
}
