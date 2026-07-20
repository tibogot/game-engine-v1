import * as THREE from "three";

/**
 * Ground / solids adapters for the modular-road `Vehicle` inside v3.
 *
 * The Vehicle (v3/play/modularRoadVehicle.js) comes from the modular-road
 * showcase, where the car drives on mesh BVHs only (even the
 * "floor" is a mesh). v3 instead has an analytic streamed terrain heightfield
 * plus a cliff BVH, and (later) a spline-road mesh BVH. Rather than baking the
 * whole terrain into a mesh every frame, these adapters duck-type the small
 * `groundBvh` / `solidsBvh` surface the Vehicle calls into:
 *
 *   ground:  baked, raycastFirst, spherecast, closestPointWithNormal
 *   solids:  baked, closestPointWithNormal
 *
 * so the car drives on terrain AND road with no changes to the Vehicle. Terrain
 * is handled analytically (cheap, no ramp-lips so sphere-sweep is unneeded
 * there); roads/cliffs are real mesh BVHs where sphere-sweep + deck contact
 * matter and "just work".
 */

const _tmpN = new THREE.Vector3();
const _cliffN = new THREE.Vector3();
const _treeN = new THREE.Vector3();
const _terrN = new THREE.Vector3();
const _deckN = new THREE.Vector3();
const _moverN = new THREE.Vector3();

/**
 * @param {object} opts
 * @param {(x:number,z:number)=>number} opts.getTerrainHeight analytic terrain height
 * @param {object|null} [opts.cliffBvh] v2 cliff BVH (raycast3D / closestPointToPoint / spherecast)
 * @param {object|null} [opts.roadBvh] RoadBvh of drive-surface road decks (optional, set later)
 * @param {object|null} [opts.roadSolidsBvh] RoadBvh of road barriers/guardrails (optional)
 */
export function createVehicleGround({
  getTerrainHeight,
  cliffBvh = null,
  roadBvh = null,
  roadSolidsBvh = null,
  treeBvh = null,
}) {
  const getTH = getTerrainHeight;

  /** Heightfield normal from central differences of the terrain sampler. */
  function terrainNormal(x, z, out, eps = 0.6) {
    const hL = getTH(x - eps, z);
    const hR = getTH(x + eps, z);
    const hD = getTH(x, z - eps);
    const hU = getTH(x, z + eps);
    out.set(-(hR - hL) / (2 * eps), 1, -(hU - hD) / (2 * eps));
    return out.normalize();
  }

  // moverBvh / moverSolidsBvh are the DYNAMIC counterparts of roadBvh /
  // roadSolidsBvh: geometry that moves every tick (elevator platforms, sliding
  // walls). Kept separate so the big static track BVH is baked once on edit and
  // only the handful of moving meshes is rebuilt per tick — rebuilding one
  // combined BVH per tick is O(whole track) and dominates the frame.
  const state = {
    cliffBvh, roadBvh, roadSolidsBvh, treeBvh,
    moverBvh: null, moverSolidsBvh: null,
  };

  // ── GROUND (wheel probes + deck contact) ────────────────────────────────
  const ground = {
    // Terrain always exists, so the ground surface is always "baked".
    get baked() {
      return true;
    },

    /** First surface along a (mostly-down) probe ray: nearest of road / cliff / terrain. */
    raycastFirst(origin, dir, far) {
      let best = null;

      if (state.roadBvh?.baked) {
        const h = state.roadBvh.raycastFirst(origin, dir, far);
        if (h && (!best || h.distance < best.distance)) best = h;
      }

      if (state.moverBvh?.baked) {
        const h = state.moverBvh.raycastFirst(origin, dir, far);
        if (h && (!best || h.distance < best.distance)) best = h;
      }

      if (state.cliffBvh?.baked) {
        const h = state.cliffBvh.raycast3D(
          origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, far,
        );
        // raycast3D reuses a scratch object — clone the fields we keep.
        if (h && (!best || h.distance < best.distance)) {
          best = {
            distance: h.distance,
            point: { x: h.point.x, y: h.point.y, z: h.point.z },
            normal: { x: h.normal.x, y: h.normal.y, z: h.normal.z },
          };
        }
      }

      // Terrain: plain VERTICAL projection at the ray origin's XZ (mirrors v2's
      // existing groundQuery). We deliberately do NOT divide by the ray's
      // vertical component — when the chassis tilts (landings, tumbles) a
      // non-vertical probe would otherwise blow `t` past `far` and the wheel
      // would lose the ground. `vertDist >= -1` keeps a small negative window so
      // the suspension can recover from a brief penetration instead of popping.
      const terrainY = getTH(origin.x, origin.z);
      if (isFinite(terrainY)) {
        const vertDist = origin.y - terrainY;
        if (vertDist <= far && vertDist >= -1.0 && (!best || vertDist < best.distance)) {
          best = {
            distance: vertDist,
            point: { x: origin.x, y: terrainY, z: origin.z },
            normal: terrainNormal(origin.x, origin.z, _terrN),
          };
        }
      }

      return best;
    },

    /** Anti-tunnel swept sphere — only the mesh BVHs (terrain is smooth). */
    spherecast(ox, oy, oz, radius, dx, dy, dz, maxDist) {
      let best = null;
      if (state.roadBvh?.baked) {
        const h = state.roadBvh.spherecast(ox, oy, oz, radius, dx, dy, dz, maxDist);
        if (h) best = h;
      }
      if (state.moverBvh?.baked) {
        const h = state.moverBvh.spherecast(ox, oy, oz, radius, dx, dy, dz, maxDist);
        if (h && (!best || h.distance < best.distance)) best = h;
      }
      if (state.cliffBvh?.spherecast && state.cliffBvh?.baked) {
        const h = state.cliffBvh.spherecast(ox, oy, oz, radius, dx, dy, dz, maxDist);
        if (h && (!best || h.distance < best.distance)) best = h;
      }
      return best;
    },

    /** Nearest drive-surface point + outward normal (used by DECK contact).
     *  Deliberately excludes terrain: DECK contact is a stiff anti-clip spring
     *  for THIN elevated track (road decks), and applying it to the terrain
     *  heightfield creates a springy invisible floor that fights the suspension
     *  and bounces the chassis. Over terrain the wheels + suspension are the
     *  only ground contact (matching v2's existing car). */
    closestPointWithNormal(px, py, pz, maxDist, outNormal) {
      let best = null;
      if (state.roadBvh?.baked) {
        const r = state.roadBvh.closestPointWithNormal(px, py, pz, maxDist, outNormal);
        if (r) best = r;
      }
      // A moving platform can be nearer than the static track, so compare rather
      // than returning the first hit — write into a scratch normal and only copy
      // it out if it wins, or a losing mover would still overwrite outNormal.
      if (state.moverBvh?.baked) {
        const r = state.moverBvh.closestPointWithNormal(px, py, pz, maxDist, _deckN);
        if (r && (!best || r.distance < best.distance)) {
          best = r;
          outNormal.copy(_deckN);
        }
      }
      return best;
    },
  };

  // ── SOLIDS (chassis collision vs walls: road barriers + cliffs) ──────────
  const solids = {
    get baked() {
      return !!(
        state.roadSolidsBvh?.baked ||
        state.moverSolidsBvh?.baked ||
        state.cliffBvh?.baked ||
        state.treeBvh?.baked
      );
    },

    closestPointWithNormal(px, py, pz, maxDist, outNormal) {
      let best = null;

      if (state.roadSolidsBvh?.baked) {
        const r = state.roadSolidsBvh.closestPointWithNormal(px, py, pz, maxDist, _tmpN);
        if (r) {
          best = r;
          outNormal.copy(_tmpN);
        }
      }

      // Moving walls / sliding barriers — same query as the static road solids,
      // but from the per-tick BVH so the chassis hits where the wall IS, not
      // where it was baked.
      if (state.moverSolidsBvh?.baked) {
        const r = state.moverSolidsBvh.closestPointWithNormal(px, py, pz, maxDist, _moverN);
        if (r && (!best || r.distance < best.distance)) {
          best = r;
          outNormal.copy(_moverN);
        }
      }

      // Cliffs as walls: closestPointToPoint has no normal, so approximate the
      // outward normal as the direction from the surface back to the query point.
      if (state.cliffBvh?.baked) {
        const r = state.cliffBvh.closestPointToPoint(px, py, pz, maxDist);
        if (r && (!best || r.distance < best.distance)) {
          _cliffN.set(px - r.x, py - r.y, pz - r.z);
          if (_cliffN.lengthSq() < 1e-10) _cliffN.set(0, 1, 0);
          else _cliffN.normalize();
          best = r;
          outNormal.copy(_cliffN);
        }
      }

      // Tree trunks as walls — same surface->query outward-normal approximation,
      // flattened to horizontal so the chassis is pushed sideways off the trunk
      // (never lifted onto it). closestPointToPoint has no face normal.
      if (state.treeBvh?.baked) {
        const r = state.treeBvh.closestPointToPoint(px, py, pz, maxDist);
        if (r && (!best || r.distance < best.distance)) {
          _treeN.set(px - r.x, 0, pz - r.z);
          if (_treeN.lengthSq() < 1e-10) _treeN.set(0, 1, 0);
          else _treeN.normalize();
          best = r;
          outNormal.copy(_treeN);
        }
      }

      return best;
    },
  };

  return {
    ground,
    solids,
    setRoadBvh(bvh) {
      state.roadBvh = bvh || null;
    },
    setRoadSolidsBvh(bvh) {
      state.roadSolidsBvh = bvh || null;
    },
    /** Dynamic deck BVH (moving platforms) — rebaked per physics tick. */
    setMoverBvh(bvh) {
      state.moverBvh = bvh || null;
    },
    /** Dynamic solids BVH (moving walls) — rebaked per physics tick. */
    setMoverSolidsBvh(bvh) {
      state.moverSolidsBvh = bvh || null;
    },
    setCliffBvh(bvh) {
      state.cliffBvh = bvh || null;
    },
    setTreeBvh(bvh) {
      state.treeBvh = bvh || null;
    },
  };
}
