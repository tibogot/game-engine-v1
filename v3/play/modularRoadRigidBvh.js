import * as THREE from "three";
import { RoadBvh } from "./modularRoadBvh.js";

/**
 * RigidBvh — a BVH for geometry that MOVES but never DEFORMS.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * The mover obstacles (elevator, rotating tube, pendulum, sliding gate) are
 * rigid bodies: their vertices never change relative to each other, only the
 * object's transform does. The collision path used to rebuild a world-space
 * `RoadBvh` from scratch on EVERY physics tick — up to 8 ticks a frame — which
 * is O(triangles) tree construction for a body whose tree is, in its own frame,
 * exactly the tree it already had.
 *
 * Measured in the running game with six movers placed (Chrome, r184):
 *
 *   RotoTubeShell   7152 tris   9.81 ms per bake
 *   Pendulum ball    600 tris   1.05 ms per bake
 *   whole per-tick mover pass  11.76 ms  →  ~78 ms/frame at 8 ticks
 *
 * A BVH baked ONCE in the mesh's own local space costs nothing per tick. The
 * transform moves to the QUERY side instead: bring the query into local space,
 * answer it there, push the answer back out to world. A rigid transform
 * preserves distances, so every answer is identical to what the world-space
 * bake gave — this is a change of frame, not an approximation.
 *
 * ── THE SCALE CAVEAT ───────────────────────────────────────────────────────
 * The mover gizmo has a scale mode (R), so the matrix is not guaranteed rigid.
 *  • uniform scale — still exact: divide the query radius by s, multiply the
 *    answer's distance by s.
 *  • NON-uniform scale — distance is direction-dependent and none of that
 *    holds. Rather than return quietly wrong contacts, this falls back to the
 *    old behaviour (rebake in world space when the pose changes), so a squashed
 *    mover is slow but correct. `usingFallback` says which path it is on.
 */

/** Largest relative spread between the three axis scales still called uniform. */
const UNIFORM_EPS = 1e-4;

const _p = new THREE.Vector3();
const _d = new THREE.Vector3();
const _n = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _t = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _localNormal = new THREE.Vector3();

export class RigidBvh {
  /**
   * @param {THREE.Mesh|{geometry:THREE.BufferGeometry, matrixWorld:THREE.Matrix4}} mesh
   *        The collision mesh. Its `geometry` is baked once; its `matrixWorld`
   *        is read LIVE on every query, so the caller only has to keep the
   *        scene graph's matrices current — which it does anyway.
   * @param {THREE.BufferGeometry} [collisionGeometry]
   *        Low-poly stand-in to bake instead of the visual geometry.
   */
  constructor(mesh, collisionGeometry = null) {
    this.mesh = mesh;
    this._bvh = new RoadBvh();
    /** True while the matrix is non-uniformly scaled — see the class note. */
    this.usingFallback = false;
    this._collisionGeometry = collisionGeometry;
    /** Identity-posed stand-in: this is what gets baked, so the tree is LOCAL. */
    this._localRef = {
      geometry: collisionGeometry ?? mesh.geometry,
      matrixWorld: new THREE.Matrix4(),
      updateMatrixWorld() {},
    };
    /** World-space stand-in for the non-uniform-scale fallback. */
    this._worldRef = {
      geometry: this._localRef.geometry,
      matrixWorld: mesh.matrixWorld,
      updateMatrixWorld() {},
    };
    this._inv = new THREE.Matrix4();
    this._scaleFactor = 1;
    this._sourceGeoUuid = this._localRef.geometry?.uuid ?? null;
    this.rebake();
  }

  get baked() { return this._bvh.baked; }
  get triCount() { return this._bvh.triCount; }

  /**
   * (Re)bake the local tree. Needed only when the GEOMETRY changes — moving the
   * object invalidates nothing.
   */
  rebake() {
    const geo = this._collisionGeometry ?? this.mesh.geometry;
    this._localRef.geometry = geo;
    this._worldRef.geometry = geo;
    this._sourceGeoUuid = geo?.uuid ?? null;
    this.usingFallback = false;
    this._bvh.bakeFromMeshes([this._localRef], { force: true });
  }

  /**
   * Pick up a geometry swap on the source mesh. Cheap enough to call every
   * frame — it compares uuids and does nothing on all but the frame that
   * changed.
   */
  syncGeometry() {
    const geo = this._collisionGeometry ?? this.mesh.geometry;
    if (geo?.uuid === this._sourceGeoUuid) return;
    this.rebake();
  }

  /**
   * Refresh the world→local transform from the mesh's current matrix.
   *
   * Called at the top of every QUERY rather than once per tick on purpose: the
   * caller cannot then get it wrong by moving the mesh between the two, and it
   * is a decompose plus an invert against a BVH descent, i.e. noise.
   *
   * @returns {boolean} true on the fast path, false if the caller must query
   *          the (world-space) fallback tree directly.
   */
  _sync() {
    const m = this.mesh.matrixWorld;
    m.decompose(_t, _q, _scale);
    const sx = Math.abs(_scale.x), sy = Math.abs(_scale.y), sz = Math.abs(_scale.z);
    const maxS = Math.max(sx, sy, sz);
    const minS = Math.min(sx, sy, sz);
    if (maxS - minS <= UNIFORM_EPS * Math.max(1, maxS)) {
      // Coming back from a squashed pose: the tree holds world-space triangles.
      if (this.usingFallback) this.rebake();
      this._scaleFactor = maxS > 1e-8 ? maxS : 1;
      this._inv.copy(m).invert();
      return true;
    }
    if (!this.usingFallback) {
      this.usingFallback = true;
      this._bvh.invalidate();
    }
    // `bakeFromMeshes` hashes the pose and returns the tree it already has when
    // nothing moved, so the ~208 hull samples of one substep pay for exactly one
    // rebuild between them, not 208.
    this._bvh.bakeFromMeshes([this._worldRef]);
    return false;
  }

  /** First hit along a world-space ray. Same result shape as RoadBvh. */
  raycastFirst(origin, dir, far = Infinity) {
    if (!this._bvh.baked) return null;
    if (!this._sync()) return this._bvh.raycastFirst(origin, dir, far);
    const s = this._scaleFactor;
    _p.copy(origin).applyMatrix4(this._inv);
    // Direction rides the rotation; transformDirection re-normalises, which is
    // what makes the local ray unit-length under a uniform scale.
    _d.copy(dir).transformDirection(this._inv);
    const hit = this._bvh.raycastFirst(_p, _d, far === Infinity ? Infinity : far / s);
    if (!hit) return null;
    hit.point.applyMatrix4(this.mesh.matrixWorld);
    hit.normal.transformDirection(this.mesh.matrixWorld).normalize();
    hit.distance *= s;
    return hit;
  }

  /** Nearest surface point within `maxDist` (world space), or null. */
  closestPointToPoint(px, py, pz, maxDist) {
    if (!this._bvh.baked) return null;
    if (!this._sync()) return this._bvh.closestPointToPoint(px, py, pz, maxDist);
    const s = this._scaleFactor;
    _p.set(px, py, pz).applyMatrix4(this._inv);
    const r = this._bvh.closestPointToPoint(_p.x, _p.y, _p.z, maxDist / s);
    if (!r) return null;
    _p.set(r.x, r.y, r.z).applyMatrix4(this.mesh.matrixWorld);
    // Fresh object, exactly like RoadBvh — the ground adapter holds the winner
    // across further queries, so a shared scratch would be rewritten under it.
    return { x: _p.x, y: _p.y, z: _p.z, distance: r.distance * s };
  }

  /**
   * Nearest surface point + outward normal.
   *
   * The normal is re-oriented toward the query point in WORLD space rather than
   * trusting the local answer: a mirrored (negatively scaled) matrix flips
   * handedness, and the local "outward" would then point into the surface.
   */
  closestPointWithNormal(px, py, pz, maxDist, outNormal) {
    if (!this._bvh.baked) return null;
    if (!this._sync()) {
      return this._bvh.closestPointWithNormal(px, py, pz, maxDist, outNormal);
    }
    const s = this._scaleFactor;
    _p.set(px, py, pz).applyMatrix4(this._inv);
    const r = this._bvh.closestPointWithNormal(_p.x, _p.y, _p.z, maxDist / s, _localNormal);
    if (!r) return null;
    _n.copy(_localNormal).transformDirection(this.mesh.matrixWorld).normalize();
    _p.set(r.x, r.y, r.z).applyMatrix4(this.mesh.matrixWorld);
    if ((px - _p.x) * _n.x + (py - _p.y) * _n.y + (pz - _p.z) * _n.z < 0) _n.negate();
    outNormal.copy(_n);
    return { x: _p.x, y: _p.y, z: _p.z, distance: r.distance * s };
  }

  /** Swept-sphere cast (world space). */
  spherecast(ox, oy, oz, radius, dx, dy, dz, maxDist) {
    if (!this._bvh.baked) return null;
    if (!this._sync()) {
      return this._bvh.spherecast(ox, oy, oz, radius, dx, dy, dz, maxDist);
    }
    const s = this._scaleFactor;
    _p.set(ox, oy, oz).applyMatrix4(this._inv);
    _d.set(dx, dy, dz).transformDirection(this._inv);
    const hit = this._bvh.spherecast(
      _p.x, _p.y, _p.z, radius / s, _d.x, _d.y, _d.z, maxDist / s,
    );
    if (!hit) return null;
    _p.set(hit.point.x, hit.point.y, hit.point.z).applyMatrix4(this.mesh.matrixWorld);
    _n.set(hit.normal.x, hit.normal.y, hit.normal.z)
      .transformDirection(this.mesh.matrixWorld).normalize();
    return {
      distance: hit.distance * s,
      point: { x: _p.x, y: _p.y, z: _p.z },
      normal: { x: _n.x, y: _n.y, z: _n.z },
    };
  }

  dispose() {
    this._bvh.invalidate();
    this._bvh.geometry?.dispose?.();
  }
}

/**
 * BvhSet — several BVHs behind ONE object with the RoadBvh query surface.
 *
 * The ground adapter (`modularRoadGround.js`) holds a single `moverBvh` and a
 * single `moverSolidsBvh` and asks each three questions. Movers used to be
 * MERGED into one world-space tree to fit that, and merging is exactly what
 * forced the per-tick rebuild: two bodies that move independently have no
 * shared frame to be static in. One tree per body, nearest answer wins, and the
 * adapter needs no changes at all — each tree is also smaller than the merged
 * one was.
 */
export class BvhSet {
  constructor() {
    /** @type {RigidBvh[]} */
    this.items = [];
  }

  set(items) { this.items = items ?? []; }

  get baked() {
    for (const b of this.items) if (b.baked) return true;
    return false;
  }

  get triCount() {
    let n = 0;
    for (const b of this.items) n += b.triCount;
    return n;
  }

  raycastFirst(origin, dir, far = Infinity) {
    let best = null;
    for (const b of this.items) {
      const h = b.raycastFirst(origin, dir, far);
      if (h && (!best || h.distance < best.distance)) best = h;
    }
    return best;
  }

  spherecast(ox, oy, oz, radius, dx, dy, dz, maxDist) {
    let best = null;
    for (const b of this.items) {
      const h = b.spherecast(ox, oy, oz, radius, dx, dy, dz, maxDist);
      if (h && (!best || h.distance < best.distance)) best = h;
    }
    return best;
  }

  /**
   * Nearest point across every member. `outNormal` is written only by the
   * WINNER — a loser writing it would leave the caller holding one body's
   * normal with another body's point, which is the failure the ground adapter's
   * own `_deckN` scratch exists to avoid.
   *
   * Each member is asked with the best distance so far as its budget, so later
   * members reject early instead of searching a radius that cannot win.
   */
  closestPointWithNormal(px, py, pz, maxDist, outNormal) {
    let best = null;
    for (const b of this.items) {
      const r = b.closestPointWithNormal(px, py, pz, best ? best.distance : maxDist, _setN);
      if (r && (!best || r.distance < best.distance)) {
        best = r;
        outNormal.copy(_setN);
      }
    }
    return best;
  }
}

const _setN = new THREE.Vector3();
