/**
 * ColliderGroup — presents multiple collision sources (merged prop CliffBvh,
 * SolidCollider, …) behind the single CliffBvh-shaped API that play-mode
 * consumers (capsule, flight, cars, ball) already speak.
 *
 * Combination rules: rays keep the nearest hit, capsule pushes accumulate,
 * heights take the highest surface.
 */
import * as THREE from "three";

export function createColliderGroup(sources) {
  const active = () => sources.filter((s) => s?.baked);

  let _debugGeo = null;
  let _debugStamp = "";

  return {
    get baked() {
      return sources.some((s) => s?.baked);
    },

    invalidate() {
      for (const s of sources) s?.invalidate?.();
    },

    raycast3D(ox, oy, oz, dx, dy, dz, maxDist) {
      let best = null;
      for (const s of active()) {
        if (!s.raycast3D) continue;
        const h = s.raycast3D(ox, oy, oz, dx, dy, dz, maxDist);
        if (h && (!best || h.distance < best.distance)) best = h;
      }
      return best;
    },

    raycastLateral(ox, oy, oz, dirX, dirZ, maxDist) {
      let best = null;
      for (const s of active()) {
        if (!s.raycastLateral) continue;
        const h = s.raycastLateral(ox, oy, oz, dirX, dirZ, maxDist);
        if (h && (!best || h.distance < best.distance)) best = h;
      }
      return best;
    },

    raycastUp(ox, oy, oz, maxDist) {
      let best = null;
      for (const s of active()) {
        if (!s.raycastUp) continue;
        const y = s.raycastUp(ox, oy, oz, maxDist);
        if (y != null && (best === null || y < best)) best = y;
      }
      return best;
    },

    raycastDown(ox, oy, oz, maxDist) {
      let best = null;
      for (const s of active()) {
        if (!s.raycastDown) continue;
        const h = s.raycastDown(ox, oy, oz, maxDist);
        if (h && (best === null || h.y > best.y)) best = h;
      }
      return best;
    },

    raycastHeight(wx, wz) {
      let best = null;
      for (const s of active()) {
        if (!s.raycastHeight) continue;
        const y = s.raycastHeight(wx, wz);
        if (y != null && (best === null || y > best)) best = y;
      }
      return best;
    },

    raycastHeightFrom(wx, wy, wz) {
      let best = null;
      for (const s of active()) {
        if (!s.raycastHeightFrom) continue;
        const y = s.raycastHeightFrom(wx, wy, wz);
        if (y != null && (best === null || y > best)) best = y;
      }
      return best;
    },

    sampleHeight(wx, wz) {
      let best = null;
      for (const s of active()) {
        if (!s.sampleHeight) continue;
        const y = s.sampleHeight(wx, wz);
        if (y != null && (best === null || y > best)) best = y;
      }
      return best;
    },

    capsuleDepenetrate(sx, sy, sz, ex, ey, ez, r) {
      let ax = 0, ay = 0, az = 0;
      let maxNY = -1;
      let moved = false;
      for (const s of active()) {
        if (!s.capsuleDepenetrate) continue;
        const c = s.capsuleDepenetrate(sx + ax, sy + ay, sz + az, ex + ax, ey + ay, ez + az, r);
        if (!c) continue;
        ax += c.dx; ay += c.dy; az += c.dz;
        if (c.maxNY > maxNY) maxNY = c.maxNY;
        if (c.dx || c.dy || c.dz) moved = true;
      }
      if (!moved) return { dx: 0, dy: 0, dz: 0, maxNY: -1 };
      return { dx: ax, dy: ay, dz: az, maxNY };
    },

    closestPointToPoint(px, py, pz, maxDist) {
      let best = null;
      for (const s of active()) {
        if (!s.closestPointToPoint) continue;
        const r = s.closestPointToPoint(px, py, pz, maxDist);
        if (r && (!best || r.distance < best.distance)) best = r;
      }
      return best;
    },

    spherecast(ox, oy, oz, radius, dx, dy, dz, maxDist) {
      let best = null;
      for (const s of active()) {
        if (!s.spherecast) continue;
        const h = s.spherecast(ox, oy, oz, radius, dx, dy, dz, maxDist);
        if (h && (!best || h.distance < best.distance)) best = h;
      }
      return best;
    },

    /** Merged debug geometry across sources (cached — rebuilt only when sources change). */
    getCollisionGeometry() {
      const geos = [];
      for (const s of active()) {
        const g = s.getCollisionGeometry?.();
        if (g) geos.push(g);
      }
      if (geos.length === 0) return null;
      if (geos.length === 1) return geos[0];

      const stamp = geos.map((g) => `${g.uuid}:${g.attributes.position.count}`).join("|");
      if (_debugGeo && stamp === _debugStamp) return _debugGeo;

      const positions = [];
      const indices = [];
      let vertexOffset = 0;
      for (const g of geos) {
        const pos = g.attributes.position;
        for (let i = 0; i < pos.count; i++) {
          positions.push(pos.getX(i), pos.getY(i), pos.getZ(i));
        }
        const idx = g.getIndex();
        if (idx) {
          for (let i = 0; i < idx.count; i++) indices.push(idx.getX(i) + vertexOffset);
        } else {
          for (let i = 0; i < pos.count; i++) indices.push(i + vertexOffset);
        }
        vertexOffset += pos.count;
      }
      _debugGeo?.dispose();
      _debugGeo = new THREE.BufferGeometry();
      _debugGeo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      _debugGeo.setIndex(indices);
      _debugStamp = stamp;
      return _debugGeo;
    },
  };
}
