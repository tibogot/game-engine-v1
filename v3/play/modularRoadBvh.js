import * as THREE from "three";
import { MeshBVH, getTriangleHitPointInfo } from "three-mesh-bvh";

/**
 * RoadBvh — a merged, double-sided MeshBVH baked from an arbitrary set of
 * meshes. Recreated from the v2 cliff BVH pattern (minus the world height-grid,
 * which only makes sense for a single-valued terrain). A 3D modular track can
 * loop back over itself, so we keep pure 3D queries: raycast, closest-point,
 * and a swept-sphere cast.
 *
 * Bake decks and solids into separate instances:
 *   - deck BVH  → wheel raycast probes (drive surface)
 *   - solids BVH → chassis sphere collision (guardrails / walls)
 */

const _ray = new THREE.Ray();
const _closestTarget = { point: new THREE.Vector3(), distance: Infinity, faceIndex: -1 };
const _queryPoint = new THREE.Vector3();
const _sweepBox = new THREE.Box3();
const _triA = new THREE.Vector3();
const _triB = new THREE.Vector3();
const _triC = new THREE.Vector3();
const _v = new THREE.Vector3();
const _hitTriInfo = {};
const _hitNormal = new THREE.Vector3();

export class RoadBvh {
  constructor() {
    this.baked = false;
    this._bvh = null;
    this.geometry = null;
    this.triCount = 0;
  }

  invalidate() {
    this.baked = false;
  }

  /** Merge `meshes` (using their world matrices) into one double-sided BVH. */
  bakeFromMeshes(meshes) {
    const positions = [];
    const indices = [];
    let vertexOffset = 0;

    for (const mesh of meshes) {
      if (!mesh) continue;
      const geo = mesh.geometry;
      const posAttr = geo?.getAttribute("position");
      if (!posAttr) continue;
      mesh.updateMatrixWorld(true);
      const m = mesh.matrixWorld;
      const idx = geo.getIndex();

      for (let i = 0; i < posAttr.count; i++) {
        _v.set(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)).applyMatrix4(m);
        positions.push(_v.x, _v.y, _v.z);
      }
      if (idx) {
        for (let i = 0; i < idx.count; i++) indices.push(idx.getX(i) + vertexOffset);
      } else {
        for (let i = 0; i < posAttr.count; i++) indices.push(i + vertexOffset);
      }
      vertexOffset += posAttr.count;
    }

    if (positions.length === 0) {
      this.baked = false;
      this._bvh = null;
      this.geometry = null;
      this.triCount = 0;
      return false;
    }

    // Duplicate every triangle with flipped winding → double-sided collision.
    const origLen = indices.length;
    for (let i = 0; i < origLen; i += 3) {
      indices.push(indices[i], indices[i + 2], indices[i + 1]);
    }

    const merged = new THREE.BufferGeometry();
    merged.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    merged.setIndex(indices);

    this._bvh?.geometry?.dispose?.();
    this._bvh = new MeshBVH(merged);
    this.geometry = merged;
    this.triCount = indices.length / 3;
    this.baked = true;
    return true;
  }

  /** Face normal at a hit (geometry is baked in world space). */
  _normalAtHit(point, faceIndex, outNormal) {
    const fi = faceIndex;
    if (fi < 0 || !this.geometry) {
      outNormal.set(0, 1, 0);
      return outNormal;
    }
    getTriangleHitPointInfo(point, this.geometry, fi, _hitTriInfo);
    outNormal.copy(_hitTriInfo.face.normal);
    if (outNormal.lengthSq() < 1e-12) outNormal.set(0, 1, 0);
    else outNormal.normalize();
    return outNormal;
  }

  /** First hit along a ray (filtered to `far`). Returns point, distance, faceIndex, normal. */
  raycastFirst(origin, dir, far = Infinity) {
    if (!this.baked) return null;
    _ray.origin.copy(origin);
    _ray.direction.copy(dir);
    const hit = this._bvh.raycastFirst(_ray, THREE.DoubleSide);
    if (!hit || hit.distance > far) return null;
    this._normalAtHit(hit.point, hit.faceIndex, _hitNormal);
    return {
      point: hit.point.clone(),
      distance: hit.distance,
      faceIndex: hit.faceIndex,
      normal: _hitNormal.clone(),
    };
  }

  /** Nearest surface point within `maxDist`, or null. */
  closestPointToPoint(px, py, pz, maxDist) {
    if (!this.baked) return null;
    _queryPoint.set(px, py, pz);
    _closestTarget.distance = Infinity;
    const res = this._bvh.closestPointToPoint(_queryPoint, _closestTarget, 0, maxDist);
    if (!res || _closestTarget.distance > maxDist) return null;
    return {
      x: _closestTarget.point.x,
      y: _closestTarget.point.y,
      z: _closestTarget.point.z,
      distance: _closestTarget.distance,
    };
  }

  /** Nearest surface point + face normal (oriented toward the query point). */
  closestPointWithNormal(px, py, pz, maxDist, outNormal) {
    const res = this.closestPointToPoint(px, py, pz, maxDist);
    if (!res) return null;
    this._normalAtHit(_closestTarget.point, _closestTarget.faceIndex, outNormal);
    // Orient toward the query point so it points "out of" the surface.
    if ((px - res.x) * outNormal.x + (py - res.y) * outNormal.y + (pz - res.z) * outNormal.z < 0) {
      outNormal.negate();
    }
    return res;
  }

  /** Swept-sphere cast — anti-tunnel helper for fast movement. */
  spherecast(ox, oy, oz, radius, dx, dy, dz, maxDist) {
    if (!this.baked) return null;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-8) return null;
    const ndx = dx / len, ndy = dy / len, ndz = dz / len;

    let minT = maxDist;
    let hitPoint = null;
    let hitNormal = null;

    _sweepBox.min.set(
      Math.min(ox, ox + ndx * maxDist) - radius,
      Math.min(oy, oy + ndy * maxDist) - radius,
      Math.min(oz, oz + ndz * maxDist) - radius,
    );
    _sweepBox.max.set(
      Math.max(ox, ox + ndx * maxDist) + radius,
      Math.max(oy, oy + ndy * maxDist) + radius,
      Math.max(oz, oz + ndz * maxDist) + radius,
    );

    this._bvh.shapecast({
      intersectsBounds: (box) => _sweepBox.intersectsBox(box),
      intersectsTriangle: (tri) => {
        const t = this._sphereTriSweep(ox, oy, oz, radius, ndx, ndy, ndz, minT, tri.a, tri.b, tri.c);
        if (t !== null && t < minT) {
          minT = t;
          hitPoint = { x: ox + ndx * t, y: oy + ndy * t, z: oz + ndz * t };
          const e1 = _triA.copy(tri.b).sub(tri.a);
          const e2 = _triB.copy(tri.c).sub(tri.a);
          const n = _triC.crossVectors(e1, e2).normalize();
          hitNormal = { x: n.x, y: n.y, z: n.z };
        }
        return false;
      },
    });

    if (hitPoint) return { distance: minT, point: hitPoint, normal: hitNormal };
    return null;
  }

  _sphereTriSweep(ox, oy, oz, r, dx, dy, dz, maxT, a, b, c) {
    const ax = a.x, ay = a.y, az = a.z;
    const e1x = b.x - ax, e1y = b.y - ay, e1z = b.z - az;
    const e2x = c.x - ax, e2y = c.y - ay, e2z = c.z - az;
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    const nLen = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (nLen < 1e-10) return null;
    nx /= nLen; ny /= nLen; nz /= nLen;

    const dDotN = dx * nx + dy * ny + dz * nz;
    const dist = (ox - ax) * nx + (oy - ay) * ny + (oz - az) * nz;

    let t0;
    if (Math.abs(dDotN) < 1e-8) {
      if (Math.abs(dist) > r) return null;
      t0 = 0;
    } else {
      let ta = (r - dist) / dDotN;
      let tb = (-r - dist) / dDotN;
      if (ta > tb) { const tmp = ta; ta = tb; tb = tmp; }
      if (ta > maxT || tb < 0) return null;
      t0 = Math.max(ta, 0);
    }

    const px = ox + dx * t0 - ax;
    const py = oy + dy * t0 - ay;
    const pz = oz + dz * t0 - az;
    const d00 = e1x * e1x + e1y * e1y + e1z * e1z;
    const d01 = e1x * e2x + e1y * e2y + e1z * e2z;
    const d11 = e2x * e2x + e2y * e2y + e2z * e2z;
    const d20 = px * e1x + py * e1y + pz * e1z;
    const d21 = px * e2x + py * e2y + pz * e2z;
    const denom = d00 * d11 - d01 * d01;
    if (Math.abs(denom) > 1e-10) {
      const v = (d11 * d20 - d01 * d21) / denom;
      const w = (d00 * d21 - d01 * d20) / denom;
      if (v >= 0 && w >= 0 && v + w <= 1) return t0;
    }

    let best = maxT + 1;
    const edges = [
      [ax, ay, az, b.x, b.y, b.z],
      [b.x, b.y, b.z, c.x, c.y, c.z],
      [c.x, c.y, c.z, ax, ay, az],
    ];
    for (const [ex, ey, ez, fx, fy, fz] of edges) {
      const t = this._sphereEdgeSweep(ox, oy, oz, r, dx, dy, dz, ex, ey, ez, fx, fy, fz, maxT);
      if (t !== null && t < best) best = t;
    }
    const verts = [[ax, ay, az], [b.x, b.y, b.z], [c.x, c.y, c.z]];
    for (const [vx, vy, vz] of verts) {
      const t = this._spherePointSweep(ox, oy, oz, r, dx, dy, dz, vx, vy, vz, maxT);
      if (t !== null && t < best) best = t;
    }
    return best <= maxT ? best : null;
  }

  _spherePointSweep(ox, oy, oz, r, dx, dy, dz, px, py, pz, maxT) {
    const lx = ox - px, ly = oy - py, lz = oz - pz;
    const a = dx * dx + dy * dy + dz * dz;
    const b = 2 * (lx * dx + ly * dy + lz * dz);
    const c = lx * lx + ly * ly + lz * lz - r * r;
    const disc = b * b - 4 * a * c;
    if (disc < 0) return null;
    const t = (-b - Math.sqrt(disc)) / (2 * a);
    return t >= 0 && t <= maxT ? t : null;
  }

  _sphereEdgeSweep(ox, oy, oz, r, dx, dy, dz, ex, ey, ez, fx, fy, fz, maxT) {
    const segX = fx - ex, segY = fy - ey, segZ = fz - ez;
    const lx = ox - ex, ly = oy - ey, lz = oz - ez;
    const segLenSq = segX * segX + segY * segY + segZ * segZ;
    const dDotSeg = dx * segX + dy * segY + dz * segZ;
    const lDotSeg = lx * segX + ly * segY + lz * segZ;

    const a = dx * dx + dy * dy + dz * dz - (dDotSeg * dDotSeg) / segLenSq;
    const b = 2 * ((lx * dx + ly * dy + lz * dz) - (dDotSeg * lDotSeg) / segLenSq);
    const c = lx * lx + ly * ly + lz * lz - (lDotSeg * lDotSeg) / segLenSq - r * r;

    const disc = b * b - 4 * a * c;
    if (disc < 0) return null;
    const t = (-b - Math.sqrt(disc)) / (2 * a);
    if (t < 0 || t > maxT) return null;
    const s = (lDotSeg + t * dDotSeg) / segLenSq;
    if (s >= 0 && s <= 1) return t;
    return null;
  }
}
