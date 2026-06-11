import * as THREE from "three";
import { MeshBVH } from "three-mesh-bvh";

const _ray = new THREE.Ray(new THREE.Vector3(), new THREE.Vector3(0, -1, 0));
const _latRay = new THREE.Ray(new THREE.Vector3(), new THREE.Vector3());
const _latHit = { point: new THREE.Vector3(), normal: new THREE.Vector3() };
const _closestTarget = { point: new THREE.Vector3(), distance: Infinity, faceIndex: -1 };
const _queryPoint = new THREE.Vector3();
const _sweepBox = new THREE.Box3();
const _triA = new THREE.Vector3();
const _triB = new THREE.Vector3();
const _triC = new THREE.Vector3();

export class CliffBvh {
  constructor(cliffStore) {
    this.store = cliffStore;
    this.baked = false;
    this._bvh = null;
    this._gridRes = 0;
    this._heightGrid = null;
    this._worldSize = 0;
    this._worldHalf = 0;
  }

  invalidate() {
    this.baked = false;
  }

  bake(terrainStore, config, extraStores) {
    const positions = [];
    const indices = [];
    let vertexOffset = 0;

    const collectStore = (store) => {
      store.forEachMeshInstance((geo, worldMatrix) => {
        const posAttr = geo.getAttribute("position");
        if (!posAttr) return;
        const idx = geo.getIndex();
        const v = new THREE.Vector3();

        for (let i = 0; i < posAttr.count; i++) {
          v.set(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i));
          v.applyMatrix4(worldMatrix);
          positions.push(v.x, v.y, v.z);
        }

        if (idx) {
          for (let i = 0; i < idx.count; i++) {
            indices.push(idx.getX(i) + vertexOffset);
          }
        } else {
          for (let i = 0; i < posAttr.count; i++) {
            indices.push(i + vertexOffset);
          }
        }
        vertexOffset += posAttr.count;
      });
    };

    collectStore(this.store);
    if (extraStores) {
      for (const es of extraStores) collectStore(es);
    }

    if (positions.length === 0) {
      this.baked = false;
      this._bvh = null;
      this._heightGrid = null;
      return;
    }

    // duplicate every triangle with flipped winding for double-sided collision
    const origLen = indices.length;
    for (let i = 0; i < origLen; i += 3) {
      indices.push(indices[i], indices[i + 2], indices[i + 1]);
    }

    const mergedGeo = new THREE.BufferGeometry();
    mergedGeo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    mergedGeo.setIndex(indices);
    this._bvh = new MeshBVH(mergedGeo);

    const worldSize = config.world.size;
    const worldHalf = worldSize * 0.5;
    const gridRes = Math.min(512, Math.ceil(worldSize / 2));
    const grid = new Float32Array(gridRes * gridRes);
    grid.fill(-9999);

    const cellSize = worldSize / gridRes;

    for (let iz = 0; iz < gridRes; iz++) {
      for (let ix = 0; ix < gridRes; ix++) {
        const wx = -worldHalf + (ix + 0.5) * cellSize;
        const wz = -worldHalf + (iz + 0.5) * cellSize;

        const terrainY = terrainStore.getWorldHeight(wx, wz);
        _ray.origin.set(wx, 99999, wz);
        _ray.direction.set(0, -1, 0);

        const hit = this._bvh.raycastFirst(_ray);
        grid[iz * gridRes + ix] = (hit && hit.point.y > terrainY)
          ? hit.point.y
          : terrainY;
      }
    }

    this._heightGrid = grid;
    this._gridRes = gridRes;
    this._worldSize = worldSize;
    this._worldHalf = worldHalf;
    this.baked = true;
  }

  raycastHeight(wx, wz) {
    if (!this.baked || !this._bvh) return null;
    _ray.origin.set(wx, 99999, wz);
    _ray.direction.set(0, -1, 0);
    const hit = this._bvh.raycastFirst(_ray);
    return hit ? hit.point.y : null;
  }

  raycastHeightFrom(wx, wy, wz) {
    if (!this.baked || !this._bvh) return null;
    _ray.origin.set(wx, wy, wz);
    _ray.direction.set(0, -1, 0);
    const hit = this._bvh.raycastFirst(_ray);
    return hit ? hit.point.y : null;
  }

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

  raycastUp(ox, oy, oz, maxDist) {
    if (!this.baked || !this._bvh) return null;
    _latRay.origin.set(ox, oy, oz);
    _latRay.direction.set(0, 1, 0);
    const hit = this._bvh.raycastFirst(_latRay);
    if (hit && hit.distance <= maxDist) {
      return hit.point.y;
    }
    return null;
  }

  sampleHeight(wx, wz) {
    if (!this.baked || !this._heightGrid) return null;

    const cellSize = this._worldSize / this._gridRes;
    const fx = (wx + this._worldHalf) / cellSize - 0.5;
    const fz = (wz + this._worldHalf) / cellSize - 0.5;

    const ix0 = Math.max(0, Math.min(this._gridRes - 2, Math.floor(fx)));
    const iz0 = Math.max(0, Math.min(this._gridRes - 2, Math.floor(fz)));
    const tx = fx - ix0;
    const tz = fz - iz0;

    const res = this._gridRes;
    const h00 = this._heightGrid[iz0 * res + ix0];
    const h10 = this._heightGrid[iz0 * res + ix0 + 1];
    const h01 = this._heightGrid[(iz0 + 1) * res + ix0];
    const h11 = this._heightGrid[(iz0 + 1) * res + ix0 + 1];

    return h00 + (h10 - h00) * tx + (h01 - h00) * tz + (h00 - h10 - h01 + h11) * tx * tz;
  }

  closestPointToPoint(px, py, pz, maxDist) {
    if (!this.baked || !this._bvh) return null;
    _queryPoint.set(px, py, pz);
    _closestTarget.distance = Infinity;
    const result = this._bvh.closestPointToPoint(_queryPoint, _closestTarget, 0, maxDist);
    if (!result || _closestTarget.distance > maxDist) return null;
    return { x: _closestTarget.point.x, y: _closestTarget.point.y, z: _closestTarget.point.z, distance: _closestTarget.distance };
  }

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
          const cx = ox + ndx * t;
          const cy = oy + ndy * t;
          const cz = oz + ndz * t;
          hitPoint = { x: cx, y: cy, z: cz };
          tri.getNormal(tri.a); // reuse vec
          const e1 = _triA.copy(tri.b).sub(tri.a);
          const e2 = _triB.copy(tri.c).sub(tri.a);
          hitNormal = _triC.crossVectors(e1, e2).normalize();
          hitNormal = { x: hitNormal.x, y: hitNormal.y, z: hitNormal.z };
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

    // Check if sphere center projected at t0 is inside triangle
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

    // Check edges and vertices (sphere vs line segments)
    let best = maxT + 1;
    const edges = [[ax, ay, az, bx, by, bz], [bx, by, bz, cx, cy, cz], [cx, cy, cz, ax, ay, az]];
    for (const [ex, ey, ez, fx, fy, fz] of edges) {
      const t = this._sphereEdgeSweep(ox, oy, oz, r, dx, dy, dz, ex, ey, ez, fx, fy, fz, maxT);
      if (t !== null && t < best) best = t;
    }
    // vertices
    const verts = [[ax, ay, az], [bx, by, bz], [cx, cy, cz]];
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
