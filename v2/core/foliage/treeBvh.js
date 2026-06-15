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
  constructor(treeStore) {
    this.store = treeStore;
    this.baked = false;
    this._bvh = null;
    this._ring = makeRing(SIDES);
    this._bakedGen = -1;
  }

  invalidate() {
    this.baked = false;
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

    for (const trees of this.store.chunks.values()) {
      for (const t of trees) {
        const r = TRUNK_R * t.scale;
        const h = TRUNK_H * t.scale;
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
}
