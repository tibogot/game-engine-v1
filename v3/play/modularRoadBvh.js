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
/** Float → its exact 32-bit pattern, for hashing poses without rounding. */
const _f32 = new Float32Array(1);
const _u32 = new Uint32Array(_f32.buffer);

export class RoadBvh {
  constructor() {
    this.baked = false;
    this._bvh = null;
    this.geometry = null;
    this.triCount = 0;
    /** Content signature of the meshes this tree was built from — see
     *  `_signature`. Null means "no tree", which never matches. */
    this._sig = null;
  }

  invalidate() {
    this.baked = false;
    this._sig = null; // force the next bake to actually run
  }

  /**
   * A cheap, exact description of what a bake WOULD read.
   *
   * `bakeFromMeshes` only ever looks at each mesh's geometry and its world
   * matrix, so two calls with the same geometries at the same poses must
   * produce the same tree — and rebuilding it is pure waste.
   *
   * That is not a rare case, it is most calls. `bakeCollision` is wired to the
   * onChange of the builder, the prop manager, the MOVER manager and the portal
   * manager, and it rebuilds the road's deck and solids trees unconditionally.
   * Movers and portals are not in either of those trees at all (movers live in
   * their own per-tick BVH), so releasing a mover gizmo rebuilt the whole road
   * for nothing — measured at 52 ms on a 41-piece track.
   *
   * A signature is the right shape of fix rather than gating each caller,
   * because it cannot be wrong about what changed: it is derived from the exact
   * inputs the bake consumes.
   *
   * Geometry is identified by `uuid`, which is sound here because nothing
   * mutates a geometry in place after handing it over — the builder's
   * `_applyBuilt` assigns a NEW BufferGeometry (and so a new uuid) whenever a
   * piece is remeshed, and a piece that merely MOVED keeps its geometry and
   * changes its matrix, which this reads too.
   */
  _signature(meshes) {
    // FNV-1a over the fields, plus an independent length/count tally so a hash
    // collision has to beat both.
    let h = 2166136261;
    let n = 0;
    const mix = (x) => { h = Math.imul(h ^ x, 16777619); };
    const mixNum = (v) => {
      // Exact for the float bit pattern, not a rounded value: a 1 mm pose
      // change must not hash the same as no change at all.
      _f32[0] = v;
      mix(_u32[0]);
    };
    for (const mesh of meshes) {
      if (!mesh) continue;
      const geo = mesh.geometry;
      const posAttr = geo?.getAttribute("position");
      if (!posAttr) continue;
      mesh.updateMatrixWorld(true);
      n += posAttr.count;
      const uuid = geo.uuid;
      for (let i = 0; i < uuid.length; i++) mix(uuid.charCodeAt(i));
      mix(posAttr.count);
      const e = mesh.matrixWorld.elements;
      for (let i = 0; i < 16; i++) mixNum(e[i]);
    }
    return `${h >>> 0}:${n}`;
  }

  /**
   * Merge `meshes` (using their world matrices) into one double-sided BVH.
   *
   * @param {object[]} meshes anything with `.geometry` + `.matrixWorld` — the
   *   road hands in lightweight stand-ins as well as real Meshes, so this must
   *   not assume Object3D beyond `updateMatrixWorld()`.
   * @param {object} [opts]
   * @param {boolean} [opts.force] rebuild even if the inputs are unchanged.
   */
  bakeFromMeshes(meshes, { force = false } = {}) {
    // ── UNCHANGED INPUTS ⇒ THE TREE WE ALREADY HAVE ─────────────────────────
    // Note this runs `updateMatrixWorld` on every mesh as it goes, so the poses
    // it hashes are the current ones and a skip can never be based on stale
    // matrices.
    const sig = this._signature(meshes);
    if (!force && this.baked && sig === this._sig) return true;

    // ── SIZE FIRST, THEN FILL ───────────────────────────────────────────────
    // This used to build `positions` and `indices` as plain JS arrays, one
    // element per `push` — ~100k pushes for a 33k-vertex track — and then copy
    // the whole thing again into a Float32Array. Counting first means each
    // buffer is allocated once, at the right size, and written straight into.
    let vertCount = 0;
    let indexCount = 0;
    for (const mesh of meshes) {
      if (!mesh) continue;
      const posAttr = mesh.geometry?.getAttribute("position");
      if (!posAttr) continue;
      vertCount += posAttr.count;
      const idx = mesh.geometry.getIndex();
      indexCount += idx ? idx.count : posAttr.count;
    }

    if (vertCount === 0) {
      this._bvh?.geometry?.dispose?.();
      this.baked = false;
      this._bvh = null;
      this.geometry = null;
      this.triCount = 0;
      this._sig = null;
      return false;
    }

    const positions = new Float32Array(vertCount * 3);
    // Doubled, because every triangle is about to get a winding-flipped twin.
    // 16-bit indices only when every index fits, matching what
    // BufferGeometry.setIndex would have chosen from a plain array.
    const indices = vertCount > 65535
      ? new Uint32Array(indexCount * 2)
      : new Uint16Array(indexCount * 2);

    let pw = 0; // position write cursor (floats)
    let iw = 0; // index write cursor
    let vertexOffset = 0;
    for (const mesh of meshes) {
      if (!mesh) continue;
      const geo = mesh.geometry;
      const posAttr = geo?.getAttribute("position");
      if (!posAttr) continue;
      // Already done by _signature above, but this method has to stay correct
      // when called with force:true on a caller that skipped it.
      mesh.updateMatrixWorld(true);
      const e = mesh.matrixWorld.elements;
      const count = posAttr.count;

      // Read straight out of the backing array where the layout allows it. An
      // interleaved or normalized attribute goes the accessor route — slower,
      // but the road does hand this arbitrary prop geometry.
      const flat = !posAttr.isInterleavedBufferAttribute
        && posAttr.itemSize === 3 && !posAttr.normalized
        ? posAttr.array
        : null;

      for (let i = 0; i < count; i++) {
        let x, y, z;
        if (flat) {
          const o = i * 3;
          x = flat[o]; y = flat[o + 1]; z = flat[o + 2];
        } else {
          x = posAttr.getX(i); y = posAttr.getY(i); z = posAttr.getZ(i);
        }
        // Vector3.applyMatrix4, inlined — including the perspective divide, so
        // this is bit-for-bit what the old path produced even though every
        // matrix the road uses is affine (w = 1).
        const w = 1 / (e[3] * x + e[7] * y + e[11] * z + e[15]);
        positions[pw++] = (e[0] * x + e[4] * y + e[8] * z + e[12]) * w;
        positions[pw++] = (e[1] * x + e[5] * y + e[9] * z + e[13]) * w;
        positions[pw++] = (e[2] * x + e[6] * y + e[10] * z + e[14]) * w;
      }

      const idx = geo.getIndex();
      if (idx) {
        const ia = idx.array;
        for (let i = 0; i < idx.count; i++) indices[iw++] = ia[i] + vertexOffset;
      } else {
        for (let i = 0; i < count; i++) indices[iw++] = i + vertexOffset;
      }
      vertexOffset += count;
    }

    // Duplicate every triangle with flipped winding → double-sided collision.
    //
    // NOT REMOVABLE, however much it looks like it. It doubles the triangle
    // count and every argument for dropping it is superficially sound —
    // raycastFirst already passes DoubleSide, closest-point is a distance
    // question, spherecast is sign-agnostic. It still changes answers:
    // tools/bvhWindingProbe.mjs measures 319 hit/miss and 35 distance
    // disagreements (max 4.11 m) across 2888 closest-point probes, against a
    // control of 0/0. Closest-point is what deck contact and the solids
    // resolver are built on. Read that file before touching this.
    const half = iw;
    for (let i = 0; i < half; i += 3) {
      indices[iw++] = indices[i];
      indices[iw++] = indices[i + 2];
      indices[iw++] = indices[i + 1];
    }

    const merged = new THREE.BufferGeometry();
    merged.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    merged.setIndex(new THREE.BufferAttribute(indices, 1));

    this._bvh?.geometry?.dispose?.();
    this._bvh = new MeshBVH(merged);
    this.geometry = merged;
    this.triCount = iw / 3;
    this.baked = true;
    this._sig = sig;
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
