import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

/**
 * Collapse the Smart Road group's per-piece meshes into one mesh per material.
 * The lab builds every deck, skirt wall, stripe and center-line DASH as its own
 * mesh (~140 draw calls for a handful of edges); since they all share a few
 * materials and live in world space (identity transforms), they merge losslessly.
 * Run after each FULL rebuild — draft (mid-drag) rebuilds are skipped by the
 * caller to keep drags light.
 *
 * All road geometries are indexed position+normal, so mergeGeometries can't hit
 * the attribute-mismatch case (which would return null); if it ever does, the
 * bucket is simply left unmerged.
 */
export function mergeRoadDrawCalls(roadGroup) {
  const buckets = new Map(); // material → meshes sharing it
  for (const child of roadGroup.children) {
    if (!child.isMesh || !child.geometry) continue;
    let bucket = buckets.get(child.material);
    if (!bucket) buckets.set(child.material, bucket = []);
    bucket.push(child);
  }
  for (const [material, meshes] of buckets) {
    if (meshes.length < 2) continue;
    const merged = mergeGeometries(meshes.map((m) => m.geometry), false);
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, material);
    mesh.receiveShadow = true;
    // Deck/walkable flags survive only when the whole bucket agrees — the
    // collider BVH must never swallow walls via a mixed-material bucket.
    mesh.userData.isDeck = meshes.every((m) => m.userData.isDeck);
    mesh.userData.isWalkable = meshes.every((m) => m.userData.isWalkable);
    mesh.renderOrder = Math.max(...meshes.map((m) => m.renderOrder));
    for (const m of meshes) {
      roadGroup.remove(m);
      // Created this same rebuild pass and never rendered — no GPU buffer
      // exists yet, so immediate dispose is safe (no retire queue needed).
      m.geometry.dispose();
    }
    roadGroup.add(mesh);
  }
}
