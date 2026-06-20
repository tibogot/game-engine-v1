import * as THREE from "three";
import { buildMeshBvhCollider } from "./meshBvhCollider.js";
import { createOnFootCollider } from "./onFootCollider.js";

/** Same rolling hills as v2/car-test.html — analytic terrainStore equivalent. */
export const TERRAIN_LAB_SIZE = 400;
export const TERRAIN_LAB_HALF = TERRAIN_LAB_SIZE * 0.5;

export function sampleTerrainHeight(x, z) {
  const r = Math.hypot(x, z);
  const flatten = THREE.MathUtils.clamp((r - 14) / 22, 0, 1);
  const h =
    7.0 * Math.sin(x * 0.018) * Math.cos(z * 0.020) +
    3.5 * Math.sin(x * 0.045 + z * 0.030) +
    1.5 * Math.cos(z * 0.06 - x * 0.04);
  const ramp = 6.5 * Math.exp(-(((z - 42) / 10) ** 2) - ((x / 16) ** 2));
  return h * flatten + ramp;
}

/**
 * Procedural terrain heightfield + cliff/prop meshes baked into a BVH layer.
 * Mirrors play mode: getTerrainHeight for hills, cliff BVH for mesh collision.
 */
export function createTerrainValidationLab(scene) {
  const getTerrainHeight = sampleTerrainHeight;

  const terrainGeo = new THREE.PlaneGeometry(
    TERRAIN_LAB_SIZE, TERRAIN_LAB_SIZE, 240, 240,
  );
  terrainGeo.rotateX(-Math.PI / 2);
  {
    const pos = terrainGeo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      pos.setY(i, getTerrainHeight(pos.getX(i), pos.getZ(i)));
    }
    pos.needsUpdate = true;
    terrainGeo.computeVertexNormals();
  }
  const terrainMesh = new THREE.Mesh(
    terrainGeo,
    new THREE.MeshStandardMaterial({
      color: 0x6f8f5a,
      roughness: 0.95,
      metalness: 0,
    }),
  );
  terrainMesh.receiveShadow = true;
  terrainMesh.name = "terrain_lab";
  scene.add(terrainMesh);

  const grid = new THREE.GridHelper(TERRAIN_LAB_SIZE, 80, 0x223018, 0x33401f);
  grid.position.y = 0.02;
  grid.material.transparent = true;
  grid.material.opacity = 0.22;
  scene.add(grid);

  const matCliff = new THREE.MeshStandardMaterial({
    color: 0x7a6a58,
    roughness: 0.88,
    metalness: 0,
  });
  const matConcrete = new THREE.MeshStandardMaterial({
    color: 0x606070,
    roughness: 0.85,
    metalness: 0,
  });
  const matRamp = new THREE.MeshStandardMaterial({
    color: 0x7a5c3a,
    roughness: 0.8,
    metalness: 0,
  });

  const cliffMeshes = [];

  function addCliff(geo, mat, pos, rot, name) {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(pos);
    if (rot) mesh.rotation.copy(rot);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = name;
    scene.add(mesh);
    cliffMeshes.push(mesh);
    return mesh;
  }

  function snapY(x, z, lift = 0) {
    return getTerrainHeight(x, z) + lift;
  }

  // Tilted ramp on a hillside (slope-align test)
  {
    const x = -38, z = 18;
    const gy = snapY(x, z, 0.15);
    addCliff(
      new THREE.BoxGeometry(8, 0.35, 12),
      matRamp,
      new THREE.Vector3(x, gy + 0.8, z),
      new THREE.Euler(-Math.PI * 0.16, 0.35, 0),
      "cliff_ramp",
    );
  }

  // Stair chunk
  for (let i = 0; i < 6; i++) {
    const x = 28, z = -22 - i * 0.85;
    const h = 0.3 + i * 0.3;
    addCliff(
      new THREE.BoxGeometry(4, h, 0.85),
      matConcrete,
      new THREE.Vector3(x, snapY(x, z) + h * 0.5, z),
      null,
      `cliff_stair_${i}`,
    );
  }

  // Elevated platform at top of stairs
  {
    const x = 28, z = -28;
    addCliff(
      new THREE.BoxGeometry(6, 0.35, 6),
      matConcrete,
      new THREE.Vector3(x, snapY(x, z) + 2.05, z),
      null,
      "cliff_platform",
    );
  }

  // Vertical cliff face
  {
    const x = -18, z = -35;
    const gy = snapY(x, z);
    addCliff(
      new THREE.BoxGeometry(14, 5, 1.2),
      matCliff,
      new THREE.Vector3(x, gy + 2.5, z),
      new THREE.Euler(0, 0.2, 0),
      "cliff_wall",
    );
  }

  // Boulder cluster on a crest
  for (let i = 0; i < 3; i++) {
    const x = 12 + i * 2.2, z = 38 + i * 1.5;
    const s = 1.2 + i * 0.35;
    addCliff(
      new THREE.BoxGeometry(s, s * 0.8, s),
      matCliff,
      new THREE.Vector3(x, snapY(x, z) + s * 0.4, z),
      new THREE.Euler(0, i * 0.5, 0),
      `cliff_boulder_${i}`,
    );
  }

  const cliffBvh = buildMeshBvhCollider(cliffMeshes);
  const collider = createOnFootCollider({ cliffBvh });

  return {
    getTerrainHeight,
    collider,
    cliffBvh,
    cliffMeshes,
    terrainMesh,
    worldHalf: TERRAIN_LAB_HALF,
  };
}
