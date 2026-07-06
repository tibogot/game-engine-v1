/**
 * Flight collision — world props/cliffs/solids + tree trunks (same coverage as on-foot).
 */
function resolve(src) {
  return typeof src === "function" ? src() : src;
}

export function createFlightCollider({ getWorld, getTreeBvh }) {
  const sources = () => [resolve(getWorld), resolve(getTreeBvh)].filter((s) => s?.baked);

  return {
    get baked() {
      return sources().length > 0;
    },

    raycast3D(ox, oy, oz, dx, dy, dz, maxDist) {
      let best = null;
      for (const s of sources()) {
        if (!s.raycast3D) continue;
        const h = s.raycast3D(ox, oy, oz, dx, dy, dz, maxDist);
        if (h && (!best || h.distance < best.distance)) best = h;
      }
      return best;
    },

    raycastHeightFrom(wx, wy, wz) {
      let best = null;
      for (const s of sources()) {
        if (!s.raycastHeightFrom) continue;
        const y = s.raycastHeightFrom(wx, wy, wz);
        if (y != null && (best === null || y > best)) best = y;
      }
      return best;
    },

    raycastDown(ox, oy, oz, maxDist) {
      let best = null;
      for (const s of sources()) {
        if (!s.raycastDown) continue;
        const h = s.raycastDown(ox, oy, oz, maxDist);
        if (h && (best === null || h.y > best.y)) best = h;
      }
      return best;
    },

    raycastUp(ox, oy, oz, maxDist) {
      let best = null;
      for (const s of sources()) {
        if (!s.raycastUp) continue;
        const y = s.raycastUp(ox, oy, oz, maxDist);
        if (y != null && (best === null || y < best)) best = y;
      }
      return best;
    },

    spherecast(ox, oy, oz, radius, dx, dy, dz, maxDist) {
      let best = null;
      for (const s of sources()) {
        if (!s.spherecast) continue;
        const h = s.spherecast(ox, oy, oz, radius, dx, dy, dz, maxDist);
        if (h && (!best || h.distance < best.distance)) best = h;
      }
      return best;
    },

    closestPointToPoint(px, py, pz, maxDist) {
      let best = null;
      for (const s of sources()) {
        if (!s.closestPointToPoint) continue;
        const r = s.closestPointToPoint(px, py, pz, maxDist);
        if (r && (!best || r.distance < best.distance)) best = r;
      }
      return best;
    },
  };
}
