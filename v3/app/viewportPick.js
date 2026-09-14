/**
 * v3/app/viewportPick.js — click-to-select in View mode (Unity / Unreal style).
 *
 * The editor is mode based: each tool owns its objects and its own picking.
 * This is the one place that asks ALL of them "what is under the cursor?" and
 * hands the winner back to its own mode, so selecting a tunnel opens Tunnel
 * mode with that tunnel active, a prop opens Props mode with the gizmo on it.
 *
 * A source is { kind, pick(raycaster) → { distance, ... } | null,
 * select(hit) }. The nearest hit wins — unless the terrain is in front of it
 * (a tunnel inside a hill cannot be clicked through the hill).
 */

/** A click is a press and release that barely moved and did not take long. */
export function createClickDetector({ maxMovePx = 5, maxMs = 450 } = {}) {
  let down = null;
  return {
    down(e) { down = { x: e.clientX, y: e.clientY, t: performance.now() }; },
    /** True when this mouseup completes a click (not an orbit drag). */
    up(e) {
      if (!down) return false;
      const ok = Math.hypot(e.clientX - down.x, e.clientY - down.y) <= maxMovePx
        && performance.now() - down.t <= maxMs;
      down = null;
      return ok;
    },
  };
}

/**
 * @param {THREE.Raycaster} raycaster  already set from the camera and mouse
 * @param {Array<{kind:string, pick:Function}>} sources
 * @param {number} terrainDistance     distance to the terrain under the cursor (Infinity if none)
 * @param {number} [slack]             an object this close behind the ground still wins (sits on it)
 * @returns {{ source:object, hit:object } | null}
 */
export function pickNearest(raycaster, sources, terrainDistance = Infinity, slack = 0.75) {
  let best = null;
  for (const source of sources) {
    let hit = null;
    try { hit = source.pick(raycaster); } catch (err) { console.warn(`[V3] pick failed for ${source.kind}`, err); }
    if (!hit || !Number.isFinite(hit.distance)) continue;
    if (hit.distance > terrainDistance + slack) continue;
    if (!best || hit.distance < best.hit.distance) best = { source, hit };
  }
  return best;
}

/** Nearest raycast hit against a list of meshes, with the list index it came from. */
export function raycastMeshes(raycaster, meshes) {
  let best = null;
  meshes.forEach((mesh, index) => {
    if (!mesh?.visible && mesh?.visible !== undefined) return;
    const hit = mesh ? raycaster.intersectObject(mesh, true)[0] : null;
    if (hit && (!best || hit.distance < best.distance)) best = { index, distance: hit.distance, point: hit.point };
  });
  return best;
}

/** Index of the point nearest (in XZ) to `p` in a list of { x, z }. */
export function nearestXZ(points, p) {
  let best = -1, bd = Infinity;
  points.forEach((q, i) => {
    const d = (q.x - p.x) ** 2 + (q.z - p.z) ** 2;
    if (d < bd) { bd = d; best = i; }
  });
  return best;
}
