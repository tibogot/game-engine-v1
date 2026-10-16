/**
 * Single merged BufferGeometry helpers for spline wall / fence / barrier.
 * Capped segment/post counts to keep draw calls at one mesh each and CPU cost bounded.
 */
import * as THREE from "three";

const MAX_PATH_SEGS = 160;
const MAX_FENCE_POSTS = 72;

function _clampSegs(pathSegs) {
  return THREE.MathUtils.clamp(pathSegs | 0, 12, MAX_PATH_SEGS);
}

/**
 * Vertical double-sided sheet: profile rectangle in (binormal, normal) plane, grounded.
 */
export function buildWallGeometry(getWorldHeight, curve, pathSegs, wallWidth, wallHeight, closed) {
  const segs = _clampSegs(pathSegs);
  const w = Math.max(0.02, wallWidth);
  const h = Math.max(0.1, wallHeight);
  const ringVerts = 4;
  const rings = segs + 1;
  const positions = new Float32Array(rings * ringVerts * 3);
  const normals = new Float32Array(rings * ringVerts * 3);
  const uvs = new Float32Array(rings * ringVerts * 2);
  const indexCount = segs * (ringVerts - 1) * 6;
  const indices = (rings * ringVerts > 65535)
    ? new Uint32Array(indexCount)
    : new Uint16Array(indexCount);
  const frames = curve.computeFrenetFrames(segs, closed);
  const wUp = new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3();
  const tan = new THREE.Vector3();
  const profile = [
    { y: 0, x: 0 },
    { y: 0, x: w },
    { y: h, x: w },
    { y: h, x: 0 },
  ];
  let vi3 = 0;
  let vi2 = 0;
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const center = curve.getPointAt(t);
    const gy = getWorldHeight(center.x, center.z);
    tan.copy(frames.tangents[i]).normalize();
    right.crossVectors(tan, wUp);
    if (right.lengthSq() < 1e-8) right.copy(frames.binormals[i]);
    else right.normalize();
    for (let j = 0; j < ringVerts; j++) {
      const p = profile[j];
      positions[vi3] = center.x + right.x * p.x;
      positions[vi3 + 1] = gy + p.y + right.y * p.x;
      positions[vi3 + 2] = center.z + right.z * p.x;
      normals[vi3] = right.x;
      normals[vi3 + 1] = right.y;
      normals[vi3 + 2] = right.z;
      uvs[vi2] = t;
      uvs[vi2 + 1] = j / (ringVerts - 1);
      vi3 += 3;
      vi2 += 2;
    }
  }
  let ii = 0;
  for (let i = 0; i < segs; i++) {
    const r0 = i * ringVerts;
    const r1 = (i + 1) * ringVerts;
    for (let j = 0; j < ringVerts - 1; j++) {
      const a = r0 + j;
      const b = r1 + j;
      const c = r0 + j + 1;
      const d = r1 + j + 1;
      indices[ii++] = a;
      indices[ii++] = b;
      indices[ii++] = c;
      indices[ii++] = c;
      indices[ii++] = b;
      indices[ii++] = d;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Jersey-style trapezoid extrusion (single shell, low point count).
 */
export function buildBarrierGeometry(getWorldHeight, curve, pathSegs, depth, height, closed) {
  const segs = _clampSegs(pathSegs);
  const d = Math.max(0.08, depth);
  const h = Math.max(0.12, height);
  const profile = [
    { y: -0.5 * h, z: 0.52 },
    { y: -0.12 * h, z: 0.42 },
    { y: 0.38 * h, z: 0.14 },
    { y: 0.5 * h, z: 0.06 },
  ];
  const ringVerts = profile.length;
  const rings = segs + 1;
  const positions = new Float32Array(rings * ringVerts * 3);
  const normals = new Float32Array(rings * ringVerts * 3);
  const uvs = new Float32Array(rings * ringVerts * 2);
  const indexCount = segs * (ringVerts - 1) * 6;
  const indices = (rings * ringVerts > 65535)
    ? new Uint32Array(indexCount)
    : new Uint16Array(indexCount);
  const frames = curve.computeFrenetFrames(segs, closed);
  const wUp = new THREE.Vector3(0, 1, 0);
  const out = new THREE.Vector3();
  const tan = new THREE.Vector3();
  let vi3 = 0;
  let vi2 = 0;
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const center = curve.getPointAt(t);
    const gy = getWorldHeight(center.x, center.z);
    tan.copy(frames.tangents[i]).normalize();
    out.crossVectors(tan, wUp);
    if (out.lengthSq() < 1e-8) out.copy(frames.binormals[i]);
    else out.normalize();
    for (let j = 0; j < ringVerts; j++) {
      const p = profile[j];
      positions[vi3] = center.x + out.x * (p.z * d);
      positions[vi3 + 1] = gy + p.y + out.y * (p.z * d);
      positions[vi3 + 2] = center.z + out.z * (p.z * d);
      normals[vi3] = out.x;
      normals[vi3 + 1] = out.y;
      normals[vi3 + 2] = out.z;
      uvs[vi2] = t;
      uvs[vi2 + 1] = j / Math.max(1, ringVerts - 1);
      vi3 += 3;
      vi2 += 2;
    }
  }
  let ii = 0;
  for (let i = 0; i < segs; i++) {
    const r0 = i * ringVerts;
    const r1 = (i + 1) * ringVerts;
    for (let j = 0; j < ringVerts - 1; j++) {
      const a = r0 + j;
      const b = r1 + j;
      const c = r0 + j + 1;
      const d = r1 + j + 1;
      indices[ii++] = a;
      indices[ii++] = b;
      indices[ii++] = c;
      indices[ii++] = c;
      indices[ii++] = b;
      indices[ii++] = d;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.computeBoundingSphere();
  return geo;
}

const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _scale = new THREE.Vector3(1, 1, 1);
const _p0 = new THREE.Vector3();
const _p1 = new THREE.Vector3();
const _xAxis = new THREE.Vector3(1, 0, 0);

function _appendTransformedBox(posArr, norArr, uvArr, idxArr, matrix) {
  const base = new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  const bp = base.attributes.position;
  const bn = base.attributes.normal;
  const ix = base.index;
  const v0 = _v;
  const n0 = _n;
  const baseVert = posArr.length / 3;
  for (let i = 0; i < bp.count; i++) {
    v0.fromBufferAttribute(bp, i).applyMatrix4(matrix);
    n0.fromBufferAttribute(bn, i).transformDirection(matrix);
    posArr.push(v0.x, v0.y, v0.z);
    norArr.push(n0.x, n0.y, n0.z);
    uvArr.push(0.02, 0.98);
  }
  for (let t = 0; t < ix.count; t++) {
    idxArr.push(baseVert + ix.getX(t));
  }
  base.dispose();
}

/**
 * Merged posts + two thin horizontal rails per span. Post count capped.
 */
export function buildFenceGeometry(
  getWorldHeight,
  curve,
  closed,
  postSpacing,
  postW,
  postD,
  height,
  railThick,
) {
  const len = Math.max(0.1, curve.getLength());
  const spacing = Math.max(0.4, postSpacing);
  let postCount = Math.max(2, Math.floor(len / spacing) + 1);
  postCount = Math.min(postCount, MAX_FENCE_POSTS);
  const h = Math.max(0.35, height);
  const pw = Math.max(0.02, postW);
  const pd = Math.max(0.02, postD);
  const rt = Math.max(0.015, Math.min(railThick, h * 0.12));

  const posArr = [];
  const norArr = [];
  const uvArr = [];
  const idxArr = [];

  const tangent = new THREE.Vector3();
  const binorm = new THREE.Vector3();
  const center = new THREE.Vector3();
  const y0 = new THREE.Vector3();

  for (let i = 0; i < postCount; i++) {
    const t = closed ? (i / postCount) : (i / Math.max(1, postCount - 1));
    curve.getPointAt(t, center);
    curve.getTangentAt(t, tangent).normalize();
    if (tangent.lengthSq() < 1e-10) tangent.set(0, 0, 1);
    const gy = getWorldHeight(center.x, center.z);
    y0.set(center.x, gy, center.z);
    binorm.set(-tangent.z, 0, tangent.x);
    if (binorm.lengthSq() < 1e-10) binorm.set(1, 0, 0);
    binorm.normalize();
    const yFlat = Math.atan2(tangent.x, tangent.z);
    _m.compose(
      y0.clone().addScaledVector(binorm, pd * 0.25).addScaledVector(new THREE.Vector3(0, 1, 0), h * 0.5),
      _q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yFlat),
      _scale.set(pw, h, pd),
    );
    _appendTransformedBox(posArr, norArr, uvArr, idxArr, _m);
  }

  const spanCount = closed ? postCount : Math.max(1, postCount - 1);
  for (let ri = 0; ri < 2; ri++) {
    const frac = ri === 0 ? 0.22 : 0.78;
    const railY = h * frac;
    for (let i = 0; i < spanCount; i++) {
      let t0; let t1;
      if (closed) {
        t0 = i / postCount;
        t1 = (i + 1) / postCount;
      } else {
        t0 = i / Math.max(1, postCount - 1);
        t1 = (i + 1) / Math.max(1, postCount - 1);
      }
      curve.getPointAt(t0, _p0);
      curve.getPointAt(t1, _p1);
      const g0 = getWorldHeight(_p0.x, _p0.z) + railY;
      const g1 = getWorldHeight(_p1.x, _p1.z) + railY;
      _p0.y = g0;
      _p1.y = g1;
      const mid = _v.copy(_p0).add(_p1).multiplyScalar(0.5);
      const seg = _n.copy(_p1).sub(_p0);
      const segLen = Math.max(1e-4, seg.length());
      seg.multiplyScalar(1 / segLen);
      const dp = seg.dot(_xAxis);
      if (Math.abs(dp) > 1.0 - 1e-5) {
        _q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), dp < 0 ? Math.PI : 0);
      } else {
        _q.setFromUnitVectors(_xAxis, seg);
      }
      _m.compose(
        mid,
        _q,
        _scale.set(segLen, rt, pd * 0.85),
      );
      _appendTransformedBox(posArr, norArr, uvArr, idxArr, _m);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(posArr), 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(norArr), 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(uvArr), 2));
  geo.setIndex(idxArr);
  geo.computeBoundingSphere();
  return geo;
}
