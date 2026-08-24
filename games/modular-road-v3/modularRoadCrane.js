// ============================================================================
// CRANE — public/models/crane2_compressed.glb as a placeable obstacle.
//
// Same pipeline as the shipping container: load once, flatten node transforms
// into geometry, sit it on y = 0, convert materials so fog stays live, mark
// geometry shared so clones do not dispose each other's buffers.
//
// WHAT THE FILE ACTUALLY IS (KHR_mesh_quantization — accessor min/max in the
// JSON are raw int16 and say nothing about metres). After Three dequantises and
// the node's TRS is applied:
//
//     3433 triangles, 1 mesh, 1 material, ZERO textures
//     construction orange  (0.93, 0.27, 0.01)
//     native bounds  ~4.02 x 4.07 x 0.68 m
//
// 4 m beside a 5 m car is a toy. CRANE_SCALE lifts it to a small site crane
// (~12 m tall, ~12 m long, ~2 m thick) so it reads as something you drive
// around, not park next to. Collision is the visual mesh — a box proxy would
// fill the empty air under the boom.
// ============================================================================
import * as THREE from "three";
import { materialColor } from "three/tsl";
import { getSharedGltfLoader } from "../../v2/core/foliage/glbLoader.js";
import { mergeByMaterial, dequantize, markSharedGeometry } from "./modularRoadBatching.js";

export const CRANE_URL = "/models/crane2_compressed.glb";

/**
 * Uniform size multiplier — a GAME number.
 * Native height is ~4.07 m; 3× puts the boom around 12 m, a small crawler crane
 * against the 5 m car.
 */
export const CRANE_SCALE = 3;

/** In-game dimensions after normalise — filled once the model loads. */
export const CRANE_SIZE = { length: 0, height: 0, width: 0 };

let _template = null;
let _loading = null;

/**
 * Load and normalise the crane once.
 * Must be awaited before thumbnails or placement — makeCrane() is sync.
 */
export function preloadCrane() {
  if (_loading) return _loading;
  _loading = new Promise((resolve) => {
    getSharedGltfLoader().load(
      CRANE_URL,
      (gltf) => { _template = normalise(gltf.scene); resolve(_template); },
      undefined,
      (err) => {
        console.warn("[ModularRoad-v3] crane GLB failed to load", err);
        resolve(null);
      },
    );
  });
  return _loading;
}

function normalise(scene) {
  const root = new THREE.Group();
  root.name = "Crane";

  scene.updateMatrixWorld(true);

  const raw = new THREE.Box3();
  scene.traverse((o) => {
    if (!o.isMesh) return;
    const g = dequantize(o.geometry.clone());
    g.applyMatrix4(o.matrixWorld);
    g.computeBoundingBox();
    raw.union(g.boundingBox);
  });
  if (raw.isEmpty()) return root;

  const mid = raw.getCenter(new THREE.Vector3());
  const uniform = CRANE_SCALE;
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
    root.add(mesh);
  });

  mergeByMaterial(root);

  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  CRANE_SIZE.length = size.x;
  CRANE_SIZE.height = size.y;
  CRANE_SIZE.width = size.z;

  markSharedGeometry(root);
  return root;
}

function toNodeMaterial(src) {
  const mat = new THREE.MeshStandardNodeMaterial({
    color: src.color?.clone() ?? new THREE.Color(0xffffff),
    roughness: src.roughness ?? 0.88,
    metalness: src.metalness ?? 0,
    map: src.map ?? null,
    side: src.side,
  });
  mat.colorNode = materialColor;
  mat.userData.batchKey = "crane";
  return mat;
}

/** A placement. Shares geometry and materials with every other crane. */
export function makeCrane() {
  const g = new THREE.Group();
  g.name = "Crane";
  if (_template) for (const c of _template.children) g.add(c.clone());
  return g;
}

export function craneReady() { return !!_template; }
