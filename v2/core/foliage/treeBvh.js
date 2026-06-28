/**
 * TreeBvh — lateral-collision BVH for tree TRUNKS (the player/car walk under the
 * canopy; only the trunk blocks). Mirrors CliffBvh's wall-query methods, but:
 *   - emits cheap low-poly CYLINDER proxies per tree (radius/height x tree scale),
 *   - has NO height grid (trees are obstacles, never walkable ground — a height
 *     grid would make you stand on the canopy),
 *   - single merged BVH, rebuilt on invalidate() (cheap without the height grid).
 *
 * The play-mode physics queries this for WALLS alongside CliffBvh (nearest hit).
 */
import * as THREE from "three";
import { MeshBVH } from "three-mesh-bvh";

const _latRay = new THREE.Ray(new THREE.Vector3(), new THREE.Vector3());
const _latHit = { point: new THREE.Vector3(), normal: new THREE.Vector3(), distance: 0 };
const _sweepBox = new THREE.Box3();
const _triA = new THREE.Vector3();
const _triB = new THREE.Vector3();
const _triC = new THREE.Vector3();
const _queryPoint = new THREE.Vector3();
const _closestTarget = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
const _capSeg = new THREE.Line3();
const _capBox = new THREE.Box3();
const _capTriPt = new THREE.Vector3();
const _capSegPt = new THREE.Vector3();
const _capPush = new THREE.Vector3();

// Collider proxy dims (multiplied by each tree's scale). Trunk-radius-ish + tall
// enough to cover the player at any nearby ground height. Per-slot override later.
const TRUNK_R = 0.4;
const TRUNK_H = 6.0;
const SIDES = 6; // low-poly cylinder (12 tris/tree)

// Unit circle ring [x0,z0, x1,z1, ...] for the cylinder sides.
function makeRing(sides) {
  const ring = new Float32Array(sides * 2);
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2;
    ring[i * 2] = Math.cos(a);
    ring[i * 2 + 1] = Math.sin(a);
  }
  return ring;
}

export class TreeBvh {
  /**
   * @param treeStore   the TreeStore (positions + slotIdx per tree)
   * @param getSlotDims optional (slotIdx) => { radius, height } in local units
   *                    (x tree scale at bake). Falls back to TRUNK_R/TRUNK_H.
   *                    Call invalidate() when these change (gen won't bump).
   */
  constructor(treeStore, getSlotDims = null) {
    this.store = treeStore;
    this._getSlotDims = getSlotDims;
    this.baked = false;
    this._bvh = null;
    this._ring = makeRing(SIDES);
    this._bakedGen = -1;
  }

  invalidate() {
    this.baked = false;
  }

  /** Merged trunk-proxy mesh — for editor BVH debug wireframes only. */
  getCollisionGeometry() {
    return this.baked && this._bvh ? this._bvh.geometry : null;
  }

  /** Rebuild if tree data changed since last bake (cheap: no height grid). */
  ensureBaked() {
    if (this.baked && this._bakedGen === this.store.globalGen) return;
    this.bake();
  }

  bake() {
    const positions = [];
    const indices = [];
    const ring = this._ring;
    const sides = SIDES;
    let vo = 0;

    const getDims = this._getSlotDims;
    for (const trees of this.store.chunks.values()) {
      for (const t of trees) {
        const dims = getDims ? getDims(t.slotIdx) : null;
        // dims present (incl. 0) => honor it; null/undefined => legacy default.
        const r = (dims && dims.radius != null ? dims.radius : TRUNK_R) * t.scale;
        const h = (dims && dims.height != null ? dims.height : TRUNK_H) * t.scale;
        if (r <= 0 || h <= 0) continue; // collider disabled for this slot
        const bx = t.x;
        const by = t.y ?? 0;
        const bz = t.z;
        // bottom + top ring (interleaved: bottom_i, top_i)
        for (let i = 0; i < sides; i++) {
          const cx = ring[i * 2] * r;
          const cz = ring[i * 2 + 1] * r;
          positions.push(bx + cx, by, bz + cz);
          positions.push(bx + cx, by + h, bz + cz);
        }
        // side quads — single-sided, OUTWARD-facing normals (so the player's
        // dot(step, normal) < 0 wall-push resolves correctly).
        for (let i = 0; i < sides; i++) {
          const i0 = vo + i * 2;
          const i1 = vo + ((i + 1) % sides) * 2;
          indices.push(i0, i0 + 1, i1);
          indices.push(i0 + 1, i1 + 1, i1);
        }
        vo += sides * 2;
      }
    }

    if (positions.length === 0) {
      this.baked = false;
      this._bvh = null;
      this._bakedGen = this.store.globalGen;
      return;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setIndex(indices);
    this._bvh = new MeshBVH(geo);
    this.baked = true;
    this._bakedGen = this.store.globalGen;
  }

  /** Horizontal wall ray — same signature/return as CliffBvh.raycastLateral. */
  raycastLateral(ox, oy, oz, dirX, dirZ, maxDist) {
    if (!this.baked || !this._bvh) return null;
    const len = Math.hypot(dirX, dirZ);
    if (len < 1e-8) return null;
    _latRay.origin.set(ox, oy, oz);
    _latRay.direction.set(dirX / len, 0, dirZ / len);
    const hit = this._bvh.raycastFirst(_latRay);
    if (hit && hit.distance <= maxDist) {
      _latHit.point.copy(hit.point);
      _latHit.normal.copy(hit.face.normal);
      _latHit.distance = hit.distance;
      return _latHit;
    }
    return null;
  }

  /** Arbitrary-direction ray (for car/flying wall probes). */
  raycast3D(ox, oy, oz, dx, dy, dz, maxDist) {
    if (!this.baked || !this._bvh) return null;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-8) return null;
    _latRay.origin.set(ox, oy, oz);
    _latRay.direction.set(dx / len, dy / len, dz / len);
    const hit = this._bvh.raycastFirst(_latRay);
    if (hit && hit.distance <= maxDist) {
      _latHit.point.copy(hit.point);
      _latHit.normal.copy(hit.face.normal);
      _latHit.distance = hit.distance;
      return _latHit;
    }
    return null;
  }

  // Swept-sphere cast — mirror of CliffBvh.spherecast (the car sweeps its hull
  // spheres against trunks; a thin ray would slip between thin trunks). Returns
  // { distance, point, normal } where distance = sphere-CENTER travel to contact.
  spherecast(ox, oy, oz, radius, dx, dy, dz, maxDist) {
    if (!this.baked || !this._bvh) return null;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-8) return null;
    const ndx = dx / len;
    const ndy = dy / len;
    const ndz = dz / len;

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
        const t = this._sphereTriSweep(
          ox, oy, oz, radius, ndx, ndy, ndz, minT, tri.a, tri.b, tri.c,
        );
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
      const t = this._sphereEdgeSweep(ox, oy, oz, r, dx, dy, dz, ex, ey, ez, fx, fy, fz, maxT);
      if (t !== null && t < best) best = t;
    }
    const verts = [[ax, ay, az], [bx, by, bz], [cx, cy, cz]];
    for (const [vx, vy, vz] of verts) {
      const t = this._spherePointSweep(ox, oy, oz, r, dx, dy, dz, vx, vy, vz, maxT);
      if (t !== null && t < best) best = t;
    }
    return best <= maxT ? best : null;
  }

  // Nearest trunk surface point (for the stunt vehicle's chassis-collision push,
  // via the ground adapter). Same return shape as CliffBvh.closestPointToPoint.
  closestPointToPoint(px, py, pz, maxDist) {
    if (!this.baked || !this._bvh) return null;
    _queryPoint.set(px, py, pz);
    _closestTarget.distance = Infinity;
    const result = this._bvh.closestPointToPoint(_queryPoint, _closestTarget, 0, maxDist);
    if (!result || _closestTarget.distance > maxDist) return null;
    return {
      x: _closestTarget.point.x,
      y: _closestTarget.point.y,
      z: _closestTarget.point.z,
      distance: _closestTarget.distance,
    };
  }

  // Down ray — trunks are side-only (no caps) so this rarely hits; kept for the
  // aggregating collider's interface. Returns { y, ny } or null.
  raycastDown(ox, oy, oz, maxDist) {
    if (!this.baked || !this._bvh) return null;
    _latRay.origin.set(ox, oy, oz);
    _latRay.direction.set(0, -1, 0);
    const hit = this._bvh.raycastFirst(_latRay);
    if (hit && hit.distance <= maxDist) {
      return { y: hit.point.y, ny: Math.abs(hit.face.normal.y) };
    }
    return null;
  }

  // Push a capsule (vertical segment + radius) out of the trunk BVH — blocks the
  // player against trunks via the same depenetration the cliffs use. Trunk sides
  // are vertical, so pushes are horizontal (never grounds you). Same return shape
  // as CliffBvh.capsuleDepenetrate.
  capsuleDepenetrate(sx, sy, sz, ex, ey, ez, radius) {
    if (!this.baked || !this._bvh) return null;
    _capSeg.start.set(sx, sy, sz);
    _capSeg.end.set(ex, ey, ez);
    _capBox.makeEmpty();
    _capBox.expandByPoint(_capSeg.start);
    _capBox.expandByPoint(_capSeg.end);
    _capBox.min.addScalar(-radius);
    _capBox.max.addScalar(radius);
    let maxNY = -1;
    let moved = false;
    this._bvh.shapecast({
      intersectsBounds: (box) => box.intersectsBox(_capBox),
      intersectsTriangle: (tri) => {
        const dist = tri.closestPointToSegment(_capSeg, _capTriPt, _capSegPt);
        if (dist < radius) {
          const depth = radius - dist;
          _capPush.copy(_capSegPt).sub(_capTriPt);
          const len = _capPush.length();
          if (len > 1e-9) {
            _capPush.multiplyScalar(1 / len);
            _capSeg.start.addScaledVector(_capPush, depth);
            _capSeg.end.addScaledVector(_capPush, depth);
            if (_capPush.y > maxNY) maxNY = _capPush.y;
            moved = true;
          }
        }
        return false;
      },
    });
    if (!moved) return { dx: 0, dy: 0, dz: 0, maxNY: -1 };
    return {
      dx: _capSeg.start.x - sx,
      dy: _capSeg.start.y - sy,
      dz: _capSeg.start.z - sz,
      maxNY,
    };
  }

  _spherePointSweep(ox, oy, oz, r, dx, dy, dz, px, py, pz, maxT) {
    const lx = ox - px, ly = oy - py, lz = oz - pz;
    const a = dx * dx + dy * dy + dz * dz;
    const b = 2 * (lx * dx + ly * dy + lz * dz);
    const c = lx * lx + ly * ly + lz * lz - r * r;
    const disc = b * b - 4 * a * c;
    if (disc < 0) return null;
    const t = (-b - Math.sqrt(disc)) / (2 * a);
    return (t >= 0 && t <= maxT) ? t : null;
  }

  _sphereEdgeSweep(ox, oy, oz, r, dx, dy, dz, ex, ey, ez, fx, fy, fz, maxT) {
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
}
