/**
 * Bake Three.js parkour collider meshes into Rapier fixed trimesh bodies.
 */
import * as THREE from "three";
import { LOTUS_PARKOUR_CONSTANTS } from "./lotusParkourTrack.js";

const _v = new THREE.Vector3();
const _center = new THREE.Vector3();
const _box = new THREE.Box3();

/** Thick floor slab — top face at y=0 (avoids zero-thickness plane trimesh). */
const GROUND_HALF_THICK = 0.04;

function bakeGroundCuboid(RAPIER, world) {
  const half = LOTUS_PARKOUR_CONSTANTS.TERRAIN_SIZE * 0.5;
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(0, -GROUND_HALF_THICK, 0),
  );
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(half, GROUND_HALF_THICK, half),
    body,
  );
  return body;
}

/**
 * @param {object} RAPIER
 * @param {import("@dimforge/rapier3d").World} world
 * @param {THREE.Mesh[]} colliderRoots
 * @param {(groupId: string) => boolean} isGroupEnabled
 * @returns {{ bodies: import("@dimforge/rapier3d").RigidBody[], dispose: () => void }}
 */
export function bakeRapierParkourColliders(RAPIER, world, colliderRoots, isGroupEnabled) {
  const bodies = [];
  const tf = RAPIER.TriMeshFlags ?? {};
  const triFlags =
    (tf.MERGE_DUPLICATE_VERTICES ?? 16) |
    (tf.DELETE_DEGENERATE_TRIANGLES ?? 32) |
    (tf.FIX_INTERNAL_EDGES ?? 144);

  for (const root of colliderRoots) {
    const groupId = root.userData.parkourGroup;
    if (groupId && !isGroupEnabled(groupId)) continue;

    if (root.userData.rapierGroundCuboid) {
      bodies.push(bakeGroundCuboid(RAPIER, world));
      continue;
    }

    root.updateMatrixWorld(true);
    _box.setFromObject(root);
    if (_box.isEmpty()) continue;
    _box.getCenter(_center);

    const verts = [];
    const inds = [];
    let vertexOffset = 0;

    root.traverse((node) => {
      if (!node.isMesh || node.userData.bvhIgnore) return;
      const geo = node.geometry;
      const posAttr = geo?.getAttribute?.("position") ?? geo?.attributes?.position;
      if (!posAttr || posAttr.count < 3) return;

      const worldMat = node.matrixWorld;
      for (let i = 0; i < posAttr.count; i++) {
        _v.fromBufferAttribute(posAttr, i).applyMatrix4(worldMat);
        verts.push(_v.x - _center.x, _v.y - _center.y, _v.z - _center.z);
      }

      const idxAttr = geo.index;
      if (idxAttr) {
        for (let i = 0; i < idxAttr.count; i++) {
          inds.push(vertexOffset + idxAttr.getX(i));
        }
      } else {
        for (let i = 0; i < posAttr.count; i++) inds.push(vertexOffset + i);
      }
      vertexOffset += posAttr.count;
    });

    if (verts.length < 9 || inds.length < 3) continue;

    try {
      const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.fixed().setTranslation(_center.x, _center.y, _center.z),
      );
      world.createCollider(
        RAPIER.ColliderDesc.trimesh(
          new Float32Array(verts),
          new Uint32Array(inds),
          triFlags,
        ),
        body,
      );
      bodies.push(body);
    } catch (e) {
      console.warn("[rapier-parkour] trimesh bake failed:", root.name || root.uuid, e);
    }
  }

  return {
    bodies,
    dispose() {
      for (const body of bodies) {
        world.removeRigidBody(body);
      }
      bodies.length = 0;
    },
  };
}

/**
 * @param {import("@dimforge/rapier3d").World} world
 * @param {object} RAPIER
 * @param {number} x
 * @param {number} z
 * @param {number} [fromY=12]
 */
export function sampleGroundY(world, RAPIER, x, z, fromY = 12) {
  const ray = new RAPIER.Ray({ x, y: fromY, z }, { x: 0, y: -1, z: 0 });
  const hit = world.castRay(ray, fromY + 4, true);
  if (!hit) return 0;
  const p = ray.pointAt(hit.timeOfImpact);
  return p.y;
}
