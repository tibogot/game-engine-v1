import * as THREE from "three";
import { MeshBVH } from "three-mesh-bvh";

const _bvhRay = new THREE.Ray(new THREE.Vector3(), new THREE.Vector3(0, -1, 0));
const _capSeg = new THREE.Line3();
const _capBox = new THREE.Box3();
const _capTriPt = new THREE.Vector3();
const _capSegPt = new THREE.Vector3();
const _capPush = new THREE.Vector3();
const _tmp = new THREE.Vector3();

/**
 * Bake static meshes into a capsule-ready BVH collider (same contract as cliffBvh).
 * Returns null when there are no meshes.
 */
export function buildMeshBvhCollider(meshes) {
  const list = meshes.filter(Boolean);
  if (list.length === 0) return null;

  const positions = [];
  const indices = [];
  let voff = 0;

  for (const mesh of list) {
    mesh.updateWorldMatrix(true, false);
    const geo = mesh.geometry;
    const pos = geo.getAttribute("position");
    if (!pos) continue;
    const idx = geo.getIndex();
    for (let i = 0; i < pos.count; i++) {
      _tmp.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      positions.push(_tmp.x, _tmp.y, _tmp.z);
    }
    if (idx) {
      for (let i = 0; i < idx.count; i++) indices.push(idx.getX(i) + voff);
    } else {
      for (let i = 0; i < pos.count; i++) indices.push(i + voff);
    }
    const base = indices.length - (idx ? idx.count : pos.count);
    const len = indices.length - base;
    for (let i = 0; i < len; i += 3) {
      indices.push(indices[base + i], indices[base + i + 2], indices[base + i + 1]);
    }
    voff += pos.count;
  }

  if (positions.length === 0) return null;

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  const bvh = new MeshBVH(geo);

  return {
    baked: true,
    _bvh: bvh,
    capsuleDepenetrate(sx, sy, sz, ex, ey, ez, radius) {
      _capSeg.start.set(sx, sy, sz);
      _capSeg.end.set(ex, ey, ez);
      _capBox.makeEmpty();
      _capBox.expandByPoint(_capSeg.start);
      _capBox.expandByPoint(_capSeg.end);
      _capBox.min.addScalar(-radius);
      _capBox.max.addScalar(radius);
      let maxNY = -1;
      let moved = false;
      bvh.shapecast({
        intersectsBounds: (b) => b.intersectsBox(_capBox),
        intersectsTriangle(tri) {
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
    },
    raycastDown(ox, oy, oz, maxDist) {
      _bvhRay.origin.set(ox, oy, oz);
      _bvhRay.direction.set(0, -1, 0);
      const hit = bvh.raycastFirst(_bvhRay);
      if (hit && hit.distance <= maxDist) {
        const n = hit.face.normal;
        const sign = n.y < 0 ? -1 : 1;
        return { y: hit.point.y, ny: n.y * sign, nx: n.x * sign, nz: n.z * sign };
      }
      return null;
    },
    raycastUp(ox, oy, oz, maxDist) {
      _bvhRay.origin.set(ox, oy, oz);
      _bvhRay.direction.set(0, 1, 0);
      const hit = bvh.raycastFirst(_bvhRay);
      if (hit && hit.distance <= maxDist) return hit.point.y;
      return null;
    },
  };
}
