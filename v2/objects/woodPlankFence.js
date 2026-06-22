import * as THREE from "three";
import {
  seededRand,
  makeWoodMaterial,
  pickWoodColor,
} from "./woodUtils.js";

/**
 * Stylized cartoon horizontal-plank fence (ranch / farm style).
 * Thick posts + 2–3 slanted rails per bay, with optional lean per span.
 */

export const WOOD_PLANK_FENCE_DEFAULTS = {
  height: 1.45,
  postSpacing: 2.8,
  postWidth: 0.16,
  postDepth: 0.14,
  postOverhang: 0.12,
  railCount: 3,
  railThickness: 0.1,
  railDepth: 0.07,
  railInset: 0.02,
  leanAmount: 0.22,
  leanRatio: 0.55,
  railYOffset: 0.04,
  colorVariation: 0.3,
  seed: 17,
  colorMain: "#b8884a",
  colorAlt: "#8a5e32",
  roughness: 0.9,
  metalness: 0,
  flatShading: true,
};

const _xAxis = new THREE.Vector3(1, 0, 0);
const _dir = new THREE.Vector3();
const _mid = new THREE.Vector3();
const _start = new THREE.Vector3();
const _end = new THREE.Vector3();
const _quat = new THREE.Quaternion();

function addRailPlank(group, start, end, thickness, depth, mat) {
  _start.copy(start);
  _end.copy(end);
  _dir.copy(_end).sub(_start);
  const len = _dir.length();
  if (len < 0.05) return;

  _dir.multiplyScalar(1 / len);
  _mid.copy(_start).add(_end).multiplyScalar(0.5);

  const geo = new THREE.BoxGeometry(len, thickness, depth);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.copy(_mid);
  _quat.setFromUnitVectors(_xAxis, _dir);
  mesh.quaternion.copy(_quat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
}

/**
 * @param {object} opts
 * @param {THREE.Vector3[]|{x:number,y:number,z:number}[]} opts.points
 * @param {boolean} [opts.closed]
 * @param {object} [opts.params]
 * @param {(x:number,z:number)=>number} [opts.getWorldHeight]
 * @returns {THREE.Group|null}
 */
export function buildWoodPlankFenceMesh({
  points,
  closed = false,
  params = {},
  getWorldHeight = () => 0,
}) {
  if (!Array.isArray(points) || points.length < 2) return null;

  const p = { ...WOOD_PLANK_FENCE_DEFAULTS, ...params };
  const fenceHeight = Math.max(0.5, p.height);
  const postSpacing = Math.max(0.8, p.postSpacing);
  const postW = Math.max(0.08, p.postWidth);
  const postD = Math.max(0.07, p.postDepth);
  const postOverhang = Math.max(0, p.postOverhang);
  const railCount = Math.max(1, Math.min(4, p.railCount | 0));
  const railThick = Math.max(0.04, p.railThickness);
  const railDepth = Math.max(0.03, p.railDepth);
  const railInset = Math.max(0, p.railInset);
  const leanAmount = Math.max(0, p.leanAmount);
  const leanRatio = THREE.MathUtils.clamp(p.leanRatio, 0, 1);
  const railYOffset = p.railYOffset;
  const seed = p.seed | 0;

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

  const length = curve.getLength();
  const group = new THREE.Group();
  group.name = "WoodPlankFence";

  const postCount = Math.max(2, Math.floor(length / postSpacing) + 1);
  const postTs = [];
  for (let i = 0; i < postCount; i++) {
    const t = closed ? i / postCount : i / Math.max(1, postCount - 1);
    postTs.push(t);
  }

  const postHeight = fenceHeight + postOverhang;
  const postGeo = new THREE.BoxGeometry(postW, postHeight, postD);

  for (let i = 0; i < postCount; i++) {
    const t = postTs[i];
    const pos = curve.getPointAt(t);
    const tangent = curve.getTangentAt(t);
    const groundY = getWorldHeight(pos.x, pos.z);
    const yaw = Math.atan2(tangent.x, tangent.z);

    const pivot = new THREE.Group();
    pivot.position.set(pos.x, groundY, pos.z);
    pivot.rotation.y = yaw;

    const post = new THREE.Mesh(
      postGeo,
      makeWoodMaterial(p, pickWoodColor(p, seededRand(seed, i + 3000))),
    );
    post.position.y = postHeight * 0.5;
    post.castShadow = true;
    post.receiveShadow = true;
    pivot.add(post);
    group.add(pivot);
  }

  const spanCount = closed ? postCount : postCount - 1;
  let railIndex = 0;

  for (let s = 0; s < spanCount; s++) {
    const t0 = postTs[s];
    const t1 = closed && s === spanCount - 1 ? 1.0 : postTs[s + 1];

    const pos0 = curve.getPointAt(t0);
    const pos1 = curve.getPointAt(t1);
    const y0 = getWorldHeight(pos0.x, pos0.z);
    const y1 = getWorldHeight(pos1.x, pos1.z);

    _dir.set(pos1.x - pos0.x, 0, pos1.z - pos0.z);
    const spanXZ = _dir.length();
    if (spanXZ < 1e-4) continue;
    _dir.multiplyScalar(1 / spanXZ);

    // Pull endpoints slightly into the post volume so planks meet the uprights.
    const railOverlap = postW * 0.14 + railDepth * 0.35;
    const endOffset = Math.max(0.02, postW * 0.5 - railOverlap - railInset);
    const ax = pos0.x + _dir.x * endOffset;
    const az = pos0.z + _dir.z * endOffset;
    const bx = pos1.x - _dir.x * endOffset;
    const bz = pos1.z - _dir.z * endOffset;

    for (let r = 0; r < railCount; r++) {
      const frac =
        railCount === 1
          ? 0.42
          : 0.14 + (0.68 * r) / Math.max(1, railCount - 1);

      const rRand = seededRand(seed, railIndex + 8000);
      const rLean = seededRand(seed, railIndex + 8100);
      const rY = seededRand(seed, railIndex + 8200);

      const yOff =
        (rY * 2 - 1) * railYOffset +
        (rRand < leanRatio * 0.25 ? (rLean - 0.5) * railYOffset * 0.5 : 0);

      const baseLift0 = fenceHeight * frac + yOff;
      const baseLift1 = fenceHeight * frac + yOff;

      let endDrop0 = 0;
      let endDrop1 = 0;
      if (leanAmount > 0 && rRand < leanRatio) {
        const sign = rLean > 0.5 ? 1 : -1;
        const mag = leanAmount * (0.35 + rLean * 0.65);
        endDrop0 = sign * mag * 0.5;
        endDrop1 = -sign * mag * 0.5;
        if (r === railCount - 1 && rLean > 0.65) {
          endDrop1 -= mag * 0.35;
        }
      }

      _start.set(ax, y0 + baseLift0 + endDrop0, az);
      _end.set(bx, y1 + baseLift1 + endDrop1, bz);

      addRailPlank(
        group,
        _start,
        _end,
        railThick,
        railDepth,
        makeWoodMaterial(p, pickWoodColor(p, seededRand(seed, railIndex + 9000))),
      );

      railIndex++;
    }
  }

  return group;
}
