// ============================================================================
// CITY COLLIDER — buildings you cannot drive through, without a city-sized BVH.
//
// ── WHY THERE IS NO BIG TREE HERE ────────────────────────────────────────────
//
// The obvious build is one merged MeshBVH over every tower. Measured on the
// real 2107-building city: 54k triangles, 32 ms to merge, 33 ms to build,
// 2.5 MB. That is survivable once — but the corridor restamp REBUILDS THE
// LAYOUT every time a track piece is placed near buildings, so it is a 65 ms
// hitch on every edit.
//
// A BVH is an acceleration structure for IRREGULAR geometry. This city is not
// irregular: one building per cell of a uniform lot grid, which is the same
// fact the facade shader uses to identify a tower from a pixel. So the broad
// phase is `floor(worldXZ / lotSize)` — O(1), no tree — and the only BVHs are
// ONE PER ARCHETYPE:
//
//   merged, world space    54,000 tris   65 ms build   2.5 MB   65 ms/restamp
//   per archetype + grid    1,476 tris  1.8 ms build    59 KB  0.15 ms/restamp
//
// Measured query: 0.73 µs per closest-point. A physics tick doing eight of
// them is 0.006 ms.
//
// ── THE INSTANCE TRANSFORM ───────────────────────────────────────────────────
//
// A building is its archetype translated to (x, y, z) and scaled in Y ONLY
// (X and Z are never scaled — see modularRoadCity.js). That inverts exactly,
// so a query is moved into archetype space rather than the geometry being
// moved into the world.
//
// The Y scale is why the distance cannot simply be handed back: local space is
// stretched vertically, so a local distance is not a world distance. The hit
// point is transformed back and the distance re-measured in the world, and the
// local search radius is widened by 1/scaleY first so a hit is never missed.
// The NORMAL takes the inverse transpose, which for scale(1, s, 1) is
// scale(1, 1/s, 1) followed by a normalise.
//
// ── WHAT IT PLUGS INTO ───────────────────────────────────────────────────────
//
// `closestPointWithNormal` and `raycastFirst`, the two methods
// v3/play/modularRoadGround.js already calls on the road solids, the movers,
// the cliffs and the trees. Buildings become a fifth source in that same
// nearest-wins aggregation, which means the CRASH comes free: the vehicle
// arms `_crashYield` off any solid hit above CRASH.wallSpeed, and it has no
// idea what kind of solid it was.
// ============================================================================
import * as THREE from "three";
import { MeshBVH, getTriangleHitPointInfo } from "three-mesh-bvh";

const _q = new THREE.Vector3();
const _hit = new THREE.Vector3();
const _n = new THREE.Vector3();
const _target = { point: new THREE.Vector3(), distance: Infinity, faceIndex: -1 };
const _triInfo = {};
const _ray = new THREE.Ray();
const _rayDir = new THREE.Vector3();
const _box = new THREE.Box3();

/** Grid key. Cells run to ±160 either way, so this never collides. */
const key = (cx, cz) => cx * 1000003 + cz;

/**
 * @param {object} o
 * @param {object} o.kit        the archetype kit (buildCityKit)
 * @param {Array}  o.buildings  placed buildings: {x,y,z,top,arch,scaleY,cx,cz}
 * @param {number} o.lotSize    the layout's cell pitch, in metres
 */
export function createCityCollider({ kit, buildings, lotSize }) {
  const t0 = performance.now();

  // ── One BVH per archetype, L0 geometry, positions only ─────────────────────
  // L0 and not the drawn tier: what you hit must not depend on how far away it
  // happens to be rendered.
  const arch = kit.archetypes.map((a) => {
    const g = a.lods[0].clone();
    // The BVH only needs positions; dropping the rest halves the memory and
    // `getTriangleHitPointInfo` reads the face from the index either way.
    if (g.hasAttribute("normal")) g.deleteAttribute("normal");
    if (g.hasAttribute("uv")) g.deleteAttribute("uv");
    g.computeBoundingBox();
    return {
      geometry: g,
      bvh: new MeshBVH(g),
      /** Archetype-space AABB, for the cheap reject before the tree. */
      box: g.boundingBox.clone(),
    };
  });

  // ── The broad phase: one building per lot cell ─────────────────────────────
  const byCell = new Map();
  for (let i = 0; i < buildings.length; i++) {
    const b = buildings[i];
    byCell.set(key(b.cx, b.cz), b);
  }

  const stats = {
    archetypes: arch.length,
    buildings: buildings.length,
    tris: arch.reduce((s, a) => s + (a.geometry.index ? a.geometry.index.count : a.geometry.attributes.position.count) / 3, 0),
    buildMs: performance.now() - t0,
  };

  let enabled = true;

  /** World AABB of one building, into `_box`. Cheap reject before the tree. */
  function worldBox(b, out) {
    const a = arch[b.arch].box;
    out.min.set(b.x + a.min.x, b.y + a.min.y * b.scaleY, b.z + a.min.z);
    out.max.set(b.x + a.max.x, b.y + a.max.y * b.scaleY, b.z + a.max.z);
    return out;
  }

  /**
   * Nearest point on any building, with an outward normal.
   *
   * Matches RoadBvh's contract exactly: returns `{x, y, z, distance, behind}`
   * in WORLD space and writes the normal into `outNormal`, or null.
   */
  function closestPointWithNormal(px, py, pz, maxDist, outNormal) {
    if (!enabled || !byCell.size) return null;
    // Cells the search sphere can touch. maxDist is a chassis radius — two or
    // three metres against a 34 m cell — so this is almost always one cell.
    const c0x = Math.floor((px - maxDist) / lotSize);
    const c1x = Math.floor((px + maxDist) / lotSize);
    const c0z = Math.floor((pz - maxDist) / lotSize);
    const c1z = Math.floor((pz + maxDist) / lotSize);

    let bestDist = maxDist;
    let bestX = 0, bestY = 0, bestZ = 0, bestBehind = false;
    let found = false;

    for (let cx = c0x; cx <= c1x; cx++) {
      for (let cz = c0z; cz <= c1z; cz++) {
        const b = byCell.get(key(cx, cz));
        if (b === undefined) continue;
        // World AABB reject, expanded by the current best — far cheaper than
        // descending a tree to find out the tower is out of range.
        worldBox(b, _box);
        if (_box.distanceToPoint(_q.set(px, py, pz)) > bestDist) continue;

        const A = arch[b.arch];
        const s = b.scaleY || 1;
        // Into archetype space. X and Z are never scaled, so only Y divides.
        _q.set(px - b.x, (py - b.y) / s, pz - b.z);
        // Local space is stretched by 1/s vertically, so a world radius of
        // `bestDist` reaches FURTHER in local units when s < 1. Widen, then
        // re-measure in the world below and reject honestly.
        const localMax = bestDist / Math.min(s, 1);
        _target.distance = Infinity;
        _target.faceIndex = -1;
        const r = A.bvh.closestPointToPoint(_q, _target, 0, localMax);
        if (!r || _target.faceIndex < 0) continue;

        // Back to the world, and the REAL distance.
        const wx = _target.point.x + b.x;
        const wy = _target.point.y * s + b.y;
        const wz = _target.point.z + b.z;
        const dx = px - wx, dy = py - wy, dz = pz - wz;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d > bestDist) continue;

        // Face normal, then the inverse transpose of scale(1, s, 1).
        getTriangleHitPointInfo(_target.point, A.geometry, _target.faceIndex, _triInfo);
        _n.copy(_triInfo.face.normal);
        if (_n.lengthSq() < 1e-12) _n.set(0, 1, 0);
        _n.y /= s;
        if (_n.lengthSq() < 1e-12) _n.set(0, 1, 0);
        else _n.normalize();
        // Orient out of the surface, toward the query point — a tower is a
        // closed shell, so a wheel inside one gets pushed the right way.
        const toward = dx * _n.x + dy * _n.y + dz * _n.z;
        const behind = toward < 0;
        if (behind) _n.negate();

        bestDist = d;
        bestX = wx; bestY = wy; bestZ = wz;
        bestBehind = behind;
        outNormal.copy(_n);
        found = true;
      }
    }
    if (!found) return null;
    return { x: bestX, y: bestY, z: bestZ, distance: bestDist, behind: bestBehind };
  }

  /**
   * First building hit along a ray. The chassis uses this to tell "walled in"
   * from "open air next to a wall".
   *
   * Walks the lot grid the ray crosses rather than testing every tower: a
   * stepped march at half a cell, which for the short rays the chassis casts
   * (a few metres) visits one or two cells.
   */
  function raycastFirst(origin, dir, far) {
    if (!enabled || !byCell.size) return null;
    _rayDir.copy(dir).normalize();
    const step = lotSize * 0.5;
    let best = null;
    let lastKey = NaN;

    for (let t = 0; t <= far + step; t += step) {
      const tt = Math.min(t, far);
      const sx = origin.x + _rayDir.x * tt;
      const sz = origin.z + _rayDir.z * tt;
      const cx = Math.floor(sx / lotSize), cz = Math.floor(sz / lotSize);
      // The march can sit in one cell for several steps; test each once.
      const k = key(cx, cz);
      if (k === lastKey) continue;
      lastKey = k;
      const b = byCell.get(k);
      if (b === undefined) continue;

      const A = arch[b.arch];
      const s = b.scaleY || 1;
      _ray.origin.set(origin.x - b.x, (origin.y - b.y) / s, origin.z - b.z);
      // The direction takes the same inverse scale, and must NOT be
      // renormalised — the distance it returns is then in local units, which
      // is exactly what the world-space conversion below undoes.
      _ray.direction.set(_rayDir.x, _rayDir.y / s, _rayDir.z);
      const scale = _ray.direction.length();
      _ray.direction.divideScalar(scale);
      const h = A.bvh.raycastFirst(_ray, THREE.DoubleSide);
      if (!h) continue;
      // Local distance → world distance: the local ray was unit length after
      // the divide, so one local unit is 1/scale world units along `dir`.
      const dist = h.distance / scale;
      if (dist > far) continue;
      if (best && dist >= best.distance) continue;

      getTriangleHitPointInfo(h.point, A.geometry, h.faceIndex, _triInfo);
      _n.copy(_triInfo.face.normal);
      _n.y /= s;
      if (_n.lengthSq() < 1e-12) _n.set(0, 1, 0);
      else _n.normalize();
      best = {
        distance: dist,
        point: {
          x: h.point.x + b.x,
          y: h.point.y * s + b.y,
          z: h.point.z + b.z,
        },
        normal: { x: _n.x, y: _n.y, z: _n.z },
      };
    }
    return best;
  }

  return {
    /** The ground adapter tests this before querying, like every other source. */
    get baked() { return enabled && byCell.size > 0; },
    stats,
    closestPointWithNormal,
    raycastFirst,
    /** Turn collision off without tearing the trees down (the dev panel). */
    setEnabled(on) { enabled = !!on; },
    /**
     * Re-point at a new layout. The BVHs belong to the ARCHETYPES, so a
     * corridor restamp, a density change or a reseed only refills this map —
     * measured at 0.15 ms for 2107 buildings, against 65 ms to rebuild a
     * merged tree.
     */
    setBuildings(list) {
      byCell.clear();
      for (let i = 0; i < list.length; i++) {
        const b = list[i];
        byCell.set(key(b.cx, b.cz), b);
      }
      stats.buildings = list.length;
    },
    dispose() {
      for (const a of arch) a.geometry.dispose();
      arch.length = 0;
      byCell.clear();
    },
  };
}
