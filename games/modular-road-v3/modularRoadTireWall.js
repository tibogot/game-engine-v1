// ============================================================================
// TIRE WALL — public/models/race_track_tire_wall_compressed.glb as a placeable
// track-side barrier prop.
//
// Same pipeline as the shipping container: load once, flatten node transforms
// into geometry, normalise to game metres on the ground, merge by material,
// and collider as a cheap box proxy so the corrugated mesh does not bloat the
// static BVH.
// ============================================================================
import * as THREE from "three";
import { materialColor } from "three/tsl";
import {
  getSharedGltfLoader,
  initGlbLoaderRenderer,
} from "../../v2/core/foliage/glbLoader.js";
import { mergeByMaterial, dequantize, markSharedGeometry } from "./modularRoadBatching.js";

export const TIRE_WALL_URL = "/models/race_track_tire_wall_compressed.glb";

/**
 * Uniform size multiplier — a game number, not a real one.
 * At true scale the segment reads small beside the car; bump it like CONTAINER_SCALE.
 */
export const TIRE_WALL_SCALE = 1.0;

/** Target wall height in metres (single-stack tire barrier). */
const TARGET_HEIGHT = 1.15 * TIRE_WALL_SCALE;

/** In-game dimensions after normalise — filled once the model loads. */
export const TIRE_WALL_SIZE = { length: 0, height: 0, depth: 0 };

let _template = null;
let _loading = null;

/**
 * Load and normalise the tire wall once.
 * Must be awaited before thumbnails or placement — makeTireWall() is sync.
 */
export function preloadTireWall(renderer) {
  if (_loading) return _loading;
  initGlbLoaderRenderer(renderer);
  _loading = new Promise((resolve) => {
    getSharedGltfLoader().load(
      TIRE_WALL_URL,
      (gltf) => { _template = normalise(gltf.scene); resolve(_template); },
      undefined,
      (err) => {
        console.warn("[ModularRoad-v3] tire wall GLB failed to load", err);
        resolve(null);
      },
    );
  });
  return _loading;
}

function normalise(scene) {
  const root = new THREE.Group();
  root.name = "TireWall";

  scene.updateMatrixWorld(true);

  // Measure the authored bounds in world space before rescaling.
  const raw = new THREE.Box3();
  scene.traverse((o) => {
    if (!o.isMesh) return;
    const g = dequantize(o.geometry.clone());
    g.applyMatrix4(o.matrixWorld);
    g.computeBoundingBox();
    raw.union(g.boundingBox);
  });
  if (raw.isEmpty()) return root;

  const src = raw.getSize(new THREE.Vector3());
  const mid = raw.getCenter(new THREE.Vector3());
  const uniform = TARGET_HEIGHT / Math.max(src.y, 1e-6);
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
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.noCollide = true;
    root.add(mesh);
  });

  mergeByMaterial(root);

  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  TIRE_WALL_SIZE.length = size.x;
  TIRE_WALL_SIZE.height = size.y;
  TIRE_WALL_SIZE.depth = size.z;

  const proxy = new THREE.Mesh(
    new THREE.BoxGeometry(size.x, size.y, size.z),
  );
  proxy.name = "TireWallCollider";
  proxy.position.copy(box.getCenter(new THREE.Vector3()));
  proxy.visible = false;
  proxy.userData.noRender = true;
  root.add(proxy);

  // Shared with every placement and every ghost — see markSharedGeometry, and
  // the container, which had the identical bug.
  markSharedGeometry(root);
  return root;
}

function toNodeMaterial(src) {
  const m = new THREE.MeshStandardNodeMaterial({
    color: src.color?.clone() ?? new THREE.Color(0xffffff),
    roughness: src.roughness ?? 0.667,
    metalness: src.metalness ?? 0,
    map: src.map ?? null,
    normalMap: src.normalMap ?? null,
    aoMap: src.aoMap ?? null,
    metalnessMap: src.metalnessMap ?? null,
    roughnessMap: src.roughnessMap ?? null,
    side: src.side,
  });
  m.colorNode = materialColor;
  m.userData.batchKey = "tirewall";
  return m;
}

/** A placement. Shares geometry and materials with every other tire wall. */
export function makeTireWall() {
  const g = new THREE.Group();
  g.name = "TireWall";
  if (_template) for (const c of _template.children) g.add(c.clone());
  return g;
}

export function tireWallReady() { return !!_template; }
