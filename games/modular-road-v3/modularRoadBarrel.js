// ============================================================================
// OIL BARREL — public/models/barrell_compressed.glb as a knockable obstacle.
//
// Same pipeline as the palm / tire wall: load once, dequantize (Draco +
// KHR_mesh_quantization), flatten node transforms, sit on y = 0, convert
// materials so fog stays live, mark geometry shared so clones do not dispose
// each other's buffers.
//
// Physics lives in modularRoadPropPhysics.js (free body, like the cone). Visual
// triangles stay out of the static BVH — `collision: "none"` on the catalog
// entry — so a yard of barrels does not weld invisible walls into the track.
// ============================================================================
import * as THREE from "three";
import { materialColor } from "three/tsl";
import { getSharedGltfLoader } from "../../v2/core/foliage/glbLoader.js";
import { mergeByMaterial, dequantize, markSharedGeometry } from "./modularRoadBatching.js";
import { BARREL_HEIGHT, PHYSICS_PROP_TYPES } from "./modularRoadPropPhysics.js";

export const BARREL_URL = "/models/barrell_compressed.glb";

/** In-game dimensions after normalise — filled once the model loads. */
export const BARREL_SIZE = { length: 0, height: 0, width: 0 };

let _template = null;
let _loading = null;

/**
 * Load and normalise the barrel once.
 * Must be awaited before thumbnails or placement — makeBarrel() is sync.
 */
export function preloadBarrel() {
  if (_loading) return _loading;
  _loading = new Promise((resolve) => {
    getSharedGltfLoader().load(
      BARREL_URL,
      (gltf) => { _template = normalise(gltf.scene); resolve(_template); },
      undefined,
      (err) => {
        console.warn("[ModularRoad-v3] barrel GLB failed to load", err);
        resolve(null);
      },
    );
  });
  return _loading;
}

function normalise(scene) {
  const root = new THREE.Group();
  root.name = "Barrel";

  scene.updateMatrixWorld(true);

  const raw = new THREE.Box3();
  scene.traverse((o) => {
    if (!o.isMesh) return;
    const g = dequantize(o.geometry.clone());
    g.applyMatrix4(o.matrixWorld);
    g.computeBoundingBox();
    raw.union(g.boundingBox);
    g.dispose();
  });
  if (raw.isEmpty()) return root;

  const src = raw.getSize(new THREE.Vector3());
  const mid = raw.getCenter(new THREE.Vector3());
  const uniform = BARREL_HEIGHT / Math.max(src.y, 1e-6);
  const m = new THREE.Matrix4()
    .makeTranslation(-mid.x * uniform, -raw.min.y * uniform, -mid.z * uniform)
    .multiply(new THREE.Matrix4().makeScale(uniform, uniform, uniform));

  scene.updateMatrixWorld(true);
  scene.traverse((o) => {
    if (!o.isMesh) return;
    const g = dequantize(o.geometry.clone());
    g.applyMatrix4(o.matrixWorld);
    g.applyMatrix4(m);
    const mesh = new THREE.Mesh(g, toNodeMaterial(o.material));
    mesh.name = "BarrelBody";
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // PropPhysics owns the hit — baking these tris would weld a static wall.
    mesh.userData.noCollide = true;
    root.add(mesh);
  });

  mergeByMaterial(root);

  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  BARREL_SIZE.length = size.x;
  BARREL_SIZE.height = size.y;
  BARREL_SIZE.width = size.z;
  syncBarrelPhysicsFromSize();

  markSharedGeometry(root);
  return root;
}

/** Keep PHYSICS_PROP_TYPES.barrel honest after measure (and after HMR resets the profile). */
export function syncBarrelPhysicsFromSize() {
  const p = PHYSICS_PROP_TYPES.barrel;
  if (!p || !(BARREL_SIZE.height > 0)) return;
  const diam = Math.max(BARREL_SIZE.length, BARREL_SIZE.width);
  p.size.width = diam;
  p.size.length = diam;
  p.size.height = BARREL_SIZE.height;
  p.radius = BARREL_SIZE.height * 0.5;
  p.hitRadius = Math.max(diam * 0.5, BARREL_SIZE.height * 0.5);
}

function toNodeMaterial(src) {
  // File ships pure black (0,0,0). Lift slightly so the metalness can catch
  // light — a zero albedo reads as a silhouette hole under most sky setups.
  const c = src.color?.clone() ?? new THREE.Color(0x1a1c1e);
  if (c.r + c.g + c.b < 0.04) c.setHex(0x1c2024);
  const mat = new THREE.MeshStandardNodeMaterial({
    color: c,
    roughness: src.roughness ?? 0.35,
    metalness: src.metalness ?? 0.55,
    map: src.map ?? null,
    side: src.side ?? THREE.FrontSide,
  });
  mat.colorNode = materialColor;
  mat.userData.batchKey = "barrel";
  return mat;
}

/** A placement. Shares geometry and materials with every other barrel. */
export function makeBarrel() {
  const g = new THREE.Group();
  g.name = "Barrel";
  syncBarrelPhysicsFromSize();
  if (_template) for (const c of _template.children) g.add(c.clone());
  // Root at the centre (physics rotates about it); mesh sits on y=0 so the
  // base is ground-flush — same split as the traffic cone.
  const R = PHYSICS_PROP_TYPES.barrel?.radius ?? BARREL_HEIGHT * 0.5;
  g.children.forEach((c) => { c.position.y -= R; });
  g.position.y = R;
  return g;
}

/** True once the model is in and props built from it will not be empty. */
export function barrelReady() { return !!_template; }
