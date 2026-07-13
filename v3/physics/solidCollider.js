/**
 * SolidCollider — instanced per-asset BVH collider.
 *
 * One MeshBVH per unique solid type (built once at registration, shared by all
 * placed instances), instance transforms applied at query time. Placing, moving
 * or deleting instances never rebuilds any BVH — only a cheap transform-list
 * resync (watching `store.gen`).
 *
 * Handles ANY affine instance transform (rotation, non-uniform scale, shear):
 * the shared BVH is used purely as a triangle *finder* — query bounds are
 * brought into type-local space conservatively, and candidate triangles are
 * transformed to world space where the actual capsule/sphere tests run.
 * Rays are the exception: affine maps preserve ordering along a line, so rays
 * are cast fully in local space and only the hit is mapped back to world.
 *
 * Exposes the same query contract as v2's CliffBvh so play-mode consumers
 * (capsule, flight, cars) work unchanged.
 */
import * as THREE from "three";
import { MeshBVH, ExtendedTriangle } from "three-mesh-bvh";

const _worldRay = new THREE.Ray();
const _localRay = new THREE.Ray();
const _boxHitPt = new THREE.Vector3();
const _worldPt = new THREE.Vector3();
const _worldNrm = new THREE.Vector3();
const _localPt = new THREE.Vector3();
const _capSeg = new THREE.Line3();
const _capBox = new THREE.Box3();
const _localBox = new THREE.Box3();
const _worldTri = new ExtendedTriangle();
const _triPt = new THREE.Vector3();
const _segPt = new THREE.Vector3();
const _push = new THREE.Vector3();
const _closestTarget = { point: new THREE.Vector3(), distance: Infinity, faceIndex: -1 };
const _sweepBox = new THREE.Box3();
const _mat4 = new THREE.Matrix4();

/** Max column length of a matrix's 3x3 basis — conservative local↔world length scale. */
function maxBasisScale(m) {
  const e = m.elements;
  const cx = Math.hypot(e[0], e[1], e[2]);
  const cy = Math.hypot(e[4], e[5], e[6]);
  const cz = Math.hypot(e[8], e[9], e[10]);
  return Math.max(cx, cy, cz);
}

// ── World-space sphere sweep vs triangle (ported from v2 CliffBvh) ────────────

function spherePointSweep(ox, oy, oz, r, dx, dy, dz, px, py, pz, maxT) {
  const lx = ox - px, ly = oy - py, lz = oz - pz;
  const a = dx * dx + dy * dy + dz * dz;
  const b = 2 * (lx * dx + ly * dy + lz * dz);
  const c = lx * lx + ly * ly + lz * lz - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  return (t >= 0 && t <= maxT) ? t : null;
}

function sphereEdgeSweep(ox, oy, oz, r, dx, dy, dz, ex, ey, ez, fx, fy, fz, maxT) {
  const segX = fx - ex, segY = fy - ey, segZ = fz - ez;
  const lx = ox - ex, ly = oy - ey, lz = oz - ez;
  const segLenSq = segX * segX + segY * segY + segZ * segZ;
  const dDotSeg = dx * segX + dy * segY + dz * segZ;
  const lDotSeg = lx * segX + ly * segY + lz * segZ;

  const a = (dx * dx + dy * dy + dz * dz) - (dDotSeg * dDotSeg) / segLenSq;
  const b = 2 * ((lx * dx + ly * dy + lz * dz) - (dDotSeg * lDotSeg) / segLenSq);
  const c = (lx * lx + ly * ly + lz * lz) - (lDotSeg * lDotSeg) / segLenSq - r * r;

  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  if (t < 0 || t > maxT) return null;
  const s = (lDotSeg + t * dDotSeg) / segLenSq;
  if (s >= 0 && s <= 1) return t;
  return null;
}

function sphereTriSweep(ox, oy, oz, r, dx, dy, dz, maxT, a, b, c) {
  const ax = a.x, ay = a.y, az = a.z;
  const bx = b.x, by = b.y, bz = b.z;
  const cx = c.x, cy = c.y, cz = c.z;

  const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
  const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
  let nx = e1y * e2z - e1z * e2y;
  let ny = e1z * e2x - e1x * e2z;
  let nz = e1x * e2y - e1y * e2x;
  const nLen = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (nLen < 1e-10) return null;
  nx /= nLen; ny /= nLen; nz /= nLen;

  const dDotN = dx * nx + dy * ny + dz * nz;
  const dist = (ox - ax) * nx + (oy - ay) * ny + (oz - az) * nz;

  let t0, t1;
  if (Math.abs(dDotN) < 1e-8) {
    if (Math.abs(dist) > r) return null;
    t0 = 0; t1 = maxT;
  } else {
    t0 = (r - dist) / dDotN;
    t1 = (-r - dist) / dDotN;
    if (t0 > t1) { const tmp = t0; t0 = t1; t1 = tmp; }
    if (t0 > maxT || t1 < 0) return null;
    t0 = Math.max(t0, 0);
  }

  const px = ox + dx * t0 - ax;
  const py2 = oy + dy * t0 - ay;
  const pz2 = oz + dz * t0 - az;
  const d00 = e1x * e1x + e1y * e1y + e1z * e1z;
  const d01 = e1x * e2x + e1y * e2y + e1z * e2z;
  const d11 = e2x * e2x + e2y * e2y + e2z * e2z;
  const d20 = px * e1x + py2 * e1y + pz2 * e1z;
  const d21 = px * e2x + py2 * e2y + pz2 * e2z;
  const denom = d00 * d11 - d01 * d01;
  if (Math.abs(denom) > 1e-10) {
    const v = (d11 * d20 - d01 * d21) / denom;
    const w = (d00 * d21 - d01 * d20) / denom;
    if (v >= 0 && w >= 0 && v + w <= 1) return t0;
  }

  let best = maxT + 1;
  const edges = [[ax, ay, az, bx, by, bz], [bx, by, bz, cx, cy, cz], [cx, cy, cz, ax, ay, az]];
  for (const [ex, ey, ez, fx, fy, fz] of edges) {
    const t = sphereEdgeSweep(ox, oy, oz, r, dx, dy, dz, ex, ey, ez, fx, fy, fz, maxT);
    if (t !== null && t < best) best = t;
  }
  const verts = [[ax, ay, az], [bx, by, bz], [cx, cy, cz]];
  for (const [vx, vy, vz] of verts) {
    const t = spherePointSweep(ox, oy, oz, r, dx, dy, dz, vx, vy, vz, maxT);
    if (t !== null && t < best) best = t;
  }
  return best <= maxT ? best : null;
}

/** Merge a type's entries ({geometry, localMatrix}) into one indexed local-space geometry. */
function mergeTypeGeometry(entries) {
  const positions = [];
  const indices = [];
  let vertexOffset = 0;
  const v = new THREE.Vector3();

  for (const { geometry, localMatrix } of entries) {
    const posAttr = geometry.getAttribute("position");
    if (!posAttr) continue;
    for (let i = 0; i < posAttr.count; i++) {
      v.set(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i));
      v.applyMatrix4(localMatrix);
      positions.push(v.x, v.y, v.z);
    }
    const idx = geometry.getIndex();
    if (idx) {
      for (let i = 0; i < idx.count; i++) indices.push(idx.getX(i) + vertexOffset);
    } else {
      for (let i = 0; i < posAttr.count; i++) indices.push(i + vertexOffset);
    }
    vertexOffset += posAttr.count;
  }

  if (positions.length === 0) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  return geo;
}

export class SolidCollider {
  /**
   * @param {import("../tools/propStore.js").PropStore} store — instances of
   *   types flagged `solid: true` participate in collision.
   */
  constructor(store) {
    this.store = store;
    this._lastGen = -1;
    /** @type {WeakMap<object, { bvh: MeshBVH, localBox: THREE.Box3 } | null>} */
    this._typeBvh = new WeakMap();
    /** @type {Array<{ type: object, matrix: THREE.Matrix4, inverse: THREE.Matrix4, normalMatrix: THREE.Matrix3, worldBox: THREE.Box3, invScaleMax: number }>} */
    this._instances = [];
    this._debugGeo = null;
    this._debugGen = -1;
  }

  _ensureTypeBvh(type) {
    if (this._typeBvh.has(type)) return this._typeBvh.get(type);
    const geo = mergeTypeGeometry(type.entries);
    let rec = null;
    if (geo) {
      const bvh = new MeshBVH(geo);
      geo.computeBoundingBox();
      rec = { bvh, localBox: geo.boundingBox.clone() };
    }
    this._typeBvh.set(type, rec);
    return rec;
  }

  _sync() {
    if (this.store.gen === this._lastGen) return;
    this._lastGen = this.store.gen;
    this._instances.length = 0;

    for (const inst of this.store.instances) {
      const type = this.store.types[inst.typeIdx];
      if (!type?.solid) continue;
      const rec = this._ensureTypeBvh(type);
      if (!rec) continue;

      const matrix = this.store.computeInstanceMatrix(inst).clone();
      const inverse = new THREE.Matrix4().copy(matrix).invert();
      const normalMatrix = new THREE.Matrix3().getNormalMatrix(matrix);
      const worldBox = rec.localBox.clone().applyMatrix4(matrix);
      this._instances.push({
        type,
        matrix,
        inverse,
        normalMatrix,
        worldBox,
        invScaleMax: maxBasisScale(inverse),
      });
    }
  }

  get baked() {
    this._sync();
    return this._instances.length > 0;
  }

  /** Compat no-op — this collider resyncs automatically from store.gen. */
  invalidate() {}

  /** Union of all solid instance world AABBs, or null if none. For cheaply
   *  skipping empty regions before per-texel raycasts (e.g. cliff-grass bake). */
  worldBounds() {
    this._sync();
    if (this._instances.length === 0) return null;
    const box = new THREE.Box3().makeEmpty();
    for (const inst of this._instances) box.union(inst.worldBox);
    return box;
  }

  // ── Rays ────────────────────────────────────────────────────────────────────

  /**
   * Nearest world-space hit along a ray, or null.
   * Returns { point:{x,y,z}, normal:{x,y,z}, distance } (normal world-oriented,
   * flipped to face the ray origin — geometry is treated as double-sided).
   */
  raycast3D(ox, oy, oz, dx, dy, dz, maxDist = Infinity) {
    this._sync();
    if (this._instances.length === 0) return null;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-8) return null;
    const ndx = dx / len, ndy = dy / len, ndz = dz / len;
    _worldRay.origin.set(ox, oy, oz);
    _worldRay.direction.set(ndx, ndy, ndz);

    let best = null;
    for (const inst of this._instances) {
      if (!inst.worldBox.containsPoint(_worldRay.origin)) {
        const boxHit = _worldRay.intersectBox(inst.worldBox, _boxHitPt);
        if (!boxHit) continue;
        if (maxDist !== Infinity && boxHit.distanceTo(_worldRay.origin) > maxDist) continue;
        if (best && boxHit.distanceTo(_worldRay.origin) > best.distance) continue;
      }

      const rec = this._typeBvh.get(inst.type);
      if (!rec) continue;
      _localRay.origin.copy(_worldRay.origin).applyMatrix4(inst.inverse);
      _localRay.direction.copy(_worldRay.direction).transformDirection(inst.inverse);
      const far = maxDist === Infinity ? Infinity : maxDist * inst.invScaleMax * 1.0001;
      const hit = rec.bvh.raycastFirst(_localRay, THREE.DoubleSide, 0, far);
      if (!hit) continue;

      _worldPt.copy(hit.point).applyMatrix4(inst.matrix);
      const dist = _worldPt.distanceTo(_worldRay.origin);
      if (dist > maxDist) continue;
      if (best && dist >= best.distance) continue;

      _worldNrm.copy(hit.face.normal).applyMatrix3(inst.normalMatrix).normalize();
      // double-sided: orient the normal against the ray
      if (_worldNrm.x * ndx + _worldNrm.y * ndy + _worldNrm.z * ndz > 0) _worldNrm.negate();
      best = {
        point: { x: _worldPt.x, y: _worldPt.y, z: _worldPt.z },
        normal: { x: _worldNrm.x, y: _worldNrm.y, z: _worldNrm.z },
        distance: dist,
      };
    }
    return best;
  }

  raycastLateral(ox, oy, oz, dirX, dirZ, maxDist) {
    return this.raycast3D(ox, oy, oz, dirX, 0, dirZ, maxDist);
  }

  raycastUp(ox, oy, oz, maxDist) {
    const hit = this.raycast3D(ox, oy, oz, 0, 1, 0, maxDist);
    return hit ? hit.point.y : null;
  }

  /**
   * The FULL surface normal comes back, not just its Y: the husky pitches its
   * body to the ground it stands on, and with only `ny` it fell back to the
   * terrain normal — tilting on flat bridge decks over sloped ground.
   * raycast3D already orients the normal against the ray, so it points up here.
   */
  raycastDown(ox, oy, oz, maxDist) {
    const hit = this.raycast3D(ox, oy, oz, 0, -1, 0, maxDist);
    if (!hit) return null;
    const n = hit.normal;
    const s = n.y < 0 ? -1 : 1;
    return { y: hit.point.y, nx: n.x * s, ny: Math.abs(n.y), nz: n.z * s };
  }

  raycastHeight(wx, wz) {
    return this.raycastHeightFrom(wx, 99999, wz);
  }

  raycastHeightFrom(wx, wy, wz) {
    const hit = this.raycast3D(wx, wy, wz, 0, -1, 0, Infinity);
    return hit ? hit.point.y : null;
  }

  /** No baked grid here — exact ray query instead (same result, no bake). */
  sampleHeight(wx, wz) {
    return this.raycastHeight(wx, wz);
  }

  // ── Capsule ─────────────────────────────────────────────────────────────────

  /**
   * Push a vertical capsule out of all overlapping instances. Same contract as
   * v2 CliffBvh: (sx,sy,sz)=bottom sphere centre, (ex,ey,ez)=top sphere centre.
   * Returns accumulated displacement + most-upward contact normal.y.
   */
  capsuleDepenetrate(sx, sy, sz, ex, ey, ez, radius) {
    this._sync();
    if (this._instances.length === 0) return { dx: 0, dy: 0, dz: 0, maxNY: -1 };

    _capSeg.start.set(sx, sy, sz);
    _capSeg.end.set(ex, ey, ez);
    let maxNY = -1;
    let moved = false;

    for (const inst of this._instances) {
      _capBox.makeEmpty();
      _capBox.expandByPoint(_capSeg.start);
      _capBox.expandByPoint(_capSeg.end);
      _capBox.min.addScalar(-radius);
      _capBox.max.addScalar(radius);
      if (!_capBox.intersectsBox(inst.worldBox)) continue;

      _localBox.copy(_capBox).applyMatrix4(inst.inverse);
      const rec = this._typeBvh.get(inst.type);
      if (!rec) continue;
      const m = inst.matrix;

      rec.bvh.shapecast({
        intersectsBounds: (box) => box.intersectsBox(_localBox),
        intersectsTriangle: (tri) => {
          // capsule test runs in WORLD space so non-uniform scale stays exact
          _worldTri.a.copy(tri.a).applyMatrix4(m);
          _worldTri.b.copy(tri.b).applyMatrix4(m);
          _worldTri.c.copy(tri.c).applyMatrix4(m);
          _worldTri.needsUpdate = true;
          const dist = _worldTri.closestPointToSegment(_capSeg, _triPt, _segPt);
          if (dist < radius) {
            const depth = radius - dist;
            _push.copy(_segPt).sub(_triPt);
            const len = _push.length();
            if (len > 1e-9) {
              _push.multiplyScalar(1 / len);
              _capSeg.start.addScaledVector(_push, depth);
              _capSeg.end.addScaledVector(_push, depth);
              if (_push.y > maxNY) maxNY = _push.y;
              moved = true;
            }
          }
          return false;
        },
      });
    }

    if (!moved) return { dx: 0, dy: 0, dz: 0, maxNY: -1 };
    return {
      dx: _capSeg.start.x - sx,
      dy: _capSeg.start.y - sy,
      dz: _capSeg.start.z - sz,
      maxNY,
    };
  }

  // ── Point / sphere queries (car physics) ────────────────────────────────────

  closestPointToPoint(px, py, pz, maxDist) {
    this._sync();
    if (this._instances.length === 0) return null;
    let best = null;
    for (const inst of this._instances) {
      if (inst.worldBox.distanceToPoint(_worldPt.set(px, py, pz)) > maxDist) continue;
      const rec = this._typeBvh.get(inst.type);
      if (!rec) continue;

      _localPt.set(px, py, pz).applyMatrix4(inst.inverse);
      _closestTarget.distance = Infinity;
      const localBound = maxDist * inst.invScaleMax * 1.0001;
      const res = rec.bvh.closestPointToPoint(_localPt, _closestTarget, 0, localBound);
      if (!res) continue;

      _worldPt.copy(_closestTarget.point).applyMatrix4(inst.matrix);
      const dist = Math.hypot(_worldPt.x - px, _worldPt.y - py, _worldPt.z - pz);
      if (dist > maxDist) continue;
      if (!best || dist < best.distance) {
        best = { x: _worldPt.x, y: _worldPt.y, z: _worldPt.z, distance: dist };
      }
    }
    return best;
  }

  spherecast(ox, oy, oz, radius, dx, dy, dz, maxDist) {
    this._sync();
    if (this._instances.length === 0) return null;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-8) return null;
    const ndx = dx / len, ndy = dy / len, ndz = dz / len;

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

    let minT = maxDist;
    let hitPoint = null;
    let hitNormal = null;

    for (const inst of this._instances) {
      if (!_sweepBox.intersectsBox(inst.worldBox)) continue;
      const rec = this._typeBvh.get(inst.type);
      if (!rec) continue;
      _localBox.copy(_sweepBox).applyMatrix4(inst.inverse);
      const m = inst.matrix;

      rec.bvh.shapecast({
        intersectsBounds: (box) => box.intersectsBox(_localBox),
        intersectsTriangle: (tri) => {
          _worldTri.a.copy(tri.a).applyMatrix4(m);
          _worldTri.b.copy(tri.b).applyMatrix4(m);
          _worldTri.c.copy(tri.c).applyMatrix4(m);
          const t = sphereTriSweep(
            ox, oy, oz, radius, ndx, ndy, ndz, minT,
            _worldTri.a, _worldTri.b, _worldTri.c,
          );
          if (t !== null && t < minT) {
            minT = t;
            hitPoint = { x: ox + ndx * t, y: oy + ndy * t, z: oz + ndz * t };
            _triPt.copy(_worldTri.b).sub(_worldTri.a);
            _segPt.copy(_worldTri.c).sub(_worldTri.a);
            _push.crossVectors(_triPt, _segPt).normalize();
            hitNormal = { x: _push.x, y: _push.y, z: _push.z };
          }
          return false;
        },
      });
    }

    if (hitPoint) return { distance: minT, point: hitPoint, normal: hitNormal };
    return null;
  }

  // ── Debug ───────────────────────────────────────────────────────────────────

  /** Merged world-space geometry of all solid instances (debug wireframes only). */
  getCollisionGeometry() {
    this._sync();
    if (this._instances.length === 0) return null;
    if (this._debugGeo && this._debugGen === this._lastGen) return this._debugGeo;

    const positions = [];
    const indices = [];
    let vertexOffset = 0;
    const v = new THREE.Vector3();

    for (const inst of this._instances) {
      for (const { geometry, localMatrix } of inst.type.entries) {
        const posAttr = geometry.getAttribute("position");
        if (!posAttr) continue;
        _mat4.multiplyMatrices(inst.matrix, localMatrix);
        for (let i = 0; i < posAttr.count; i++) {
          v.set(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i));
          v.applyMatrix4(_mat4);
          positions.push(v.x, v.y, v.z);
        }
        const idx = geometry.getIndex();
        if (idx) {
          for (let i = 0; i < idx.count; i++) indices.push(idx.getX(i) + vertexOffset);
        } else {
          for (let i = 0; i < posAttr.count; i++) indices.push(i + vertexOffset);
        }
        vertexOffset += posAttr.count;
      }
    }

    this._debugGeo?.dispose();
    this._debugGeo = new THREE.BufferGeometry();
    this._debugGeo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    this._debugGeo.setIndex(indices);
    this._debugGen = this._lastGen;
    return this._debugGeo;
  }
}
