/**
 * Aggregated capsule collider — same contract as playMode's _onFootCollider.
 * Pass cliffBvh / treeBvh directly, or as `() => bvh` getters for live rebakes.
 */
function resolveSource(src) {
  return typeof src === "function" ? src() : src;
}

export function createOnFootCollider({
  cliffBvh = null,
  treeBvh = null,
  extraColliders = [],
} = {}) {
  return {
    get baked() {
      return !!(
        resolveSource(cliffBvh)?.baked ||
        resolveSource(treeBvh)?.baked ||
        extraColliders.some((c) => c?.baked)
      );
    },
    capsuleDepenetrate(sx, sy, sz, ex, ey, ez, r) {
      let ax = 0;
      let ay = 0;
      let az = 0;
      let maxNY = -1;
      let moved = false;
      const run = (src) => {
        const bvh = resolveSource(src);
        if (!bvh?.baked || !bvh.capsuleDepenetrate) return;
        const c = bvh.capsuleDepenetrate(
          sx + ax, sy + ay, sz + az,
          ex + ax, ey + ay, ez + az,
          r,
        );
        if (!c) return;
        ax += c.dx;
        ay += c.dy;
        az += c.dz;
        if (c.maxNY > maxNY) maxNY = c.maxNY;
        if (c.dx || c.dy || c.dz) moved = true;
      };
      run(cliffBvh);
      run(treeBvh);
      for (const c of extraColliders) run(c);
      if (!moved) return { dx: 0, dy: 0, dz: 0, maxNY: -1 };
      return { dx: ax, dy: ay, dz: az, maxNY };
    },
    raycastDown(ox, oy, oz, maxDist) {
      let best = null;
      const run = (src) => {
        const bvh = resolveSource(src);
        if (!bvh?.baked || !bvh.raycastDown) return;
        const h = bvh.raycastDown(ox, oy, oz, maxDist);
        if (h && (best === null || h.y > best.y)) best = h;
      };
      run(cliffBvh);
      run(treeBvh);
      for (const c of extraColliders) run(c);
      return best;
    },
    raycastUp(ox, oy, oz, maxDist) {
      let best = null;
      const run = (src) => {
        const bvh = resolveSource(src);
        if (!bvh?.baked || !bvh.raycastUp) return;
        const y = bvh.raycastUp(ox, oy, oz, maxDist);
        if (y != null && (best === null || y < best)) best = y;
      };
      run(cliffBvh);
      run(treeBvh);
      for (const c of extraColliders) run(c);
      return best;
    },
  };
}
