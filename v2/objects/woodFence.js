import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import {
  seededRand,
  makeWoodMaterial,
  pickWoodColor,
} from "./woodUtils.js";

/**
 * Stylized cartoon wood picket fence along a spline.
 * Boards can lean and vary in height/color for a hand-built look.
 */

export const WOOD_FENCE_DEFAULTS = {
  height: 1.35,
  postSpacing: 2.4,
  postWidth: 0.14,
  postDepth: 0.12,
  picketWidth: 0.11,
  picketDepth: 0.045,
  picketGap: 0.04,
  railCount: 2,
  railThickness: 0.07,
  leanAmount: 9,
  leanRatio: 0.72,
  heightVariation: 0.08,
  colorVariation: 0.35,
  seed: 42,
  colorMain: "#c9a66b",
  colorAlt: "#a07840",
  roughness: 0.92,
  metalness: 0,
  flatShading: true,
};

// Reusable math objects (function-scope, not module-level, to stay per-call)
/**
 * @param {object} opts
 * @param {THREE.Vector3[]|{x:number,y:number,z:number}[]} opts.points
 * @param {boolean} [opts.closed]
 * @param {object} [opts.params]
 * @param {(x:number,z:number)=>number} [opts.getWorldHeight]
 * @returns {THREE.Group|null}
 */
export function buildWoodFenceMesh({
  points,
  closed = false,
  params = {},
  getWorldHeight = () => 0,
}) {
  if (!Array.isArray(points) || points.length < 2) return null;

  const p = { ...WOOD_FENCE_DEFAULTS, ...params };
  const fenceHeight = Math.max(0.4, p.height);
  const postSpacing = Math.max(0.6, p.postSpacing);
  const postW = Math.max(0.06, p.postWidth);
  const postD = Math.max(0.05, p.postDepth);
  const picketW = Math.max(0.04, p.picketWidth);
  const picketD = Math.max(0.02, p.picketDepth);
  const picketGap = Math.max(0, p.picketGap);
  const railCount = Math.max(0, p.railCount | 0);
  const railThick = Math.max(0.02, p.railThickness);
  const leanAmount = Math.max(0, p.leanAmount);
  const leanRatio = THREE.MathUtils.clamp(p.leanRatio, 0, 1);
  const heightVar = Math.max(0, p.heightVariation);
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
  group.name = "WoodFence";

  const postCount = Math.max(2, Math.floor(length / postSpacing) + 1);

  const postTs = [];
  for (let i = 0; i < postCount; i++) {
    const t = closed ? i / postCount : i / Math.max(1, postCount - 1);
    postTs.push(t);
  }

  const spanCount = closed ? postCount : postCount - 1;

  // Shared math scratch space
  const _m = new THREE.Matrix4();
  const _qY = new THREE.Quaternion();
  const _qZ = new THREE.Quaternion();
  const _q = new THREE.Quaternion();
  const _axY = new THREE.Vector3(0, 1, 0);
  const _axZ = new THREE.Vector3(0, 0, 1);
  const _pos3 = new THREE.Vector3();
  const _scl3 = new THREE.Vector3();

  // ── Posts — InstancedMesh with per-instance color → 1 draw call ──
  const postGeo = new THREE.BoxGeometry(postW, fenceHeight * 1.06, postD);
  const postMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: p.roughness,
    metalness: p.metalness,
    flatShading: !!p.flatShading,
  });
  const postMesh = new THREE.InstancedMesh(postGeo, postMat, postCount);
  postMesh.castShadow = true;
  postMesh.receiveShadow = true;

  for (let i = 0; i < postCount; i++) {
    const t = postTs[i];
    const pos = curve.getPointAt(t);
    const tangent = curve.getTangentAt(t);
    const groundY = getWorldHeight(pos.x, pos.z);
    const yaw = Math.atan2(tangent.x, tangent.z);
    const r = seededRand(seed, i + 5000);
    const postLean =
      leanAmount > 0 && r < leanRatio * 0.35
        ? THREE.MathUtils.degToRad(
            (seededRand(seed, i + 6000) * 2 - 1) * leanAmount * 0.45,
          )
        : 0;

    _qY.setFromAxisAngle(_axY, yaw);
    _qZ.setFromAxisAngle(_axZ, postLean);
    _q.multiplyQuaternions(_qY, _qZ);
    _pos3.set(pos.x, groundY + fenceHeight * 0.53, pos.z);
    _scl3.set(1, 1, 1); // geometry already sized correctly
    _m.compose(_pos3, _q, _scl3);
    postMesh.setMatrixAt(i, _m);
    postMesh.setColorAt(i, pickWoodColor(p, seededRand(seed, i + 7000)));
  }
  postMesh.instanceMatrix.needsUpdate = true;
  if (postMesh.instanceColor) postMesh.instanceColor.needsUpdate = true;
  group.add(postMesh);

  // ── Pickets — pre-pass to collect data, then InstancedMesh → 1 draw call ──
  // Two passes are needed because InstancedMesh requires a fixed count up front,
  // and picket count per span depends on measured arc length.
  const picketPitch = picketW + picketGap;
  const picketData = [];
  let picketIndex = 0;

  for (let s = 0; s < spanCount; s++) {
    const t0 = postTs[s];
    const t1 =
      closed && s === spanCount - 1 ? 1.0 : postTs[s + 1];

    const samples = 24;
    let spanLen = 0;
    let prev = curve.getPointAt(t0);
    for (let j = 1; j <= samples; j++) {
      const tt = t0 + (t1 - t0) * (j / samples);
      const pt = curve.getPointAt(Math.min(tt, 1));
      spanLen += pt.distanceTo(prev);
      prev = pt;
    }

    const inset = postW * 0.55;
    const usable = Math.max(0, spanLen - inset * 2);
    const picketCount = Math.max(
      0,
      Math.floor(usable / Math.max(0.05, picketPitch)),
    );

    for (let k = 0; k < picketCount; k++) {
      const dist = inset + picketPitch * (k + 0.5);
      if (dist > spanLen - inset) break;

      const u = dist / Math.max(1e-6, spanLen);
      const t = t0 + (t1 - t0) * u;
      const tClamped = Math.min(Math.max(t, 0), 1);
      const pos = curve.getPointAt(tClamped);
      const tangent = curve.getTangentAt(tClamped);
      const groundY = getWorldHeight(pos.x, pos.z);
      const yaw = Math.atan2(tangent.x, tangent.z);

      const r0 = seededRand(seed, picketIndex);
      const r1 = seededRand(seed, picketIndex + 9000);
      const r2 = seededRand(seed, picketIndex + 12000);

      const leanDeg =
        leanAmount > 0 && r0 < leanRatio ? (r1 * 2 - 1) * leanAmount : 0;
      const picketH = fenceHeight * (1 + (r2 * 2 - 1) * heightVar);

      picketData.push({
        x: pos.x,
        y: groundY,
        z: pos.z,
        yaw,
        leanRad: THREE.MathUtils.degToRad(leanDeg),
        picketH,
        color: pickWoodColor(p, r1),
      });
      picketIndex++;
    }
  }

  if (picketData.length > 0) {
    const boardGeo = new THREE.BoxGeometry(1, 1, 1);
    const boardMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: p.roughness,
      metalness: p.metalness,
      flatShading: !!p.flatShading,
    });
    const boardMesh = new THREE.InstancedMesh(
      boardGeo,
      boardMat,
      picketData.length,
    );
    boardMesh.castShadow = true;
    boardMesh.receiveShadow = true;

    for (let i = 0; i < picketData.length; i++) {
      const d = picketData[i];
      _qY.setFromAxisAngle(_axY, d.yaw);
      _qZ.setFromAxisAngle(_axZ, d.leanRad);
      _q.multiplyQuaternions(_qY, _qZ);
      _pos3.set(d.x, d.y + d.picketH * 0.5, d.z);
      _scl3.set(picketW, d.picketH, picketD);
      _m.compose(_pos3, _q, _scl3);
      boardMesh.setMatrixAt(i, _m);
      boardMesh.setColorAt(i, d.color);
    }
    boardMesh.instanceMatrix.needsUpdate = true;
    if (boardMesh.instanceColor) boardMesh.instanceColor.needsUpdate = true;
    group.add(boardMesh);
  }

  // ── Rails — single color, merge all tubes into 1 draw call ──
  if (railCount > 0) {
    const segCount = Math.max(16, Math.ceil(length * 0.8));
    const railMat = makeWoodMaterial(p, pickWoodColor(p, 0.42));
    const railGeos = [];

    for (let r = 0; r < railCount; r++) {
      const frac =
        railCount === 1 ? 0.5 : 0.1 + (0.8 * r) / Math.max(1, railCount - 1);
      const railPoints = [];
      for (let i = 0; i <= segCount; i++) {
        const t = i / segCount;
        const pos = curve.getPointAt(t);
        const groundY = getWorldHeight(pos.x, pos.z);
        railPoints.push(
          new THREE.Vector3(pos.x, groundY + fenceHeight * frac, pos.z),
        );
      }
      const railCurve = new THREE.CatmullRomCurve3(
        railPoints,
        closed,
        "catmullrom",
        0.5,
      );
      railGeos.push(
        new THREE.TubeGeometry(railCurve, segCount, railThick * 0.5, 5, closed),
      );
    }

    const merged = mergeGeometries(railGeos, false);
    railGeos.forEach((g) => g.dispose());
    if (merged) {
      const railMesh = new THREE.Mesh(merged, railMat);
      railMesh.castShadow = true;
      railMesh.receiveShadow = true;
      group.add(railMesh);
    }
  }

  return group;
}
