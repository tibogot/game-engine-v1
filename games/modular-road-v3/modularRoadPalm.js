// ============================================================================
// PALM TREE — public/models/palmtest_compressed.glb as a placeable obstacle.
//
// Same pipeline as the crane: load once, dequantize (the file is Draco +
// KHR_mesh_quantization), flatten node transforms, sit it on y = 0, convert
// materials so fog stays live, mark geometry shared so clones do not dispose
// each other's buffers.
//
// TWO MESHES in the file: `palm_trunk_…` (brown) and `palm_leaves_…` (green).
// Collision is the TRUNK ONLY — a capsule, not the visual triangles. Foliage
// in the static BVH would be a leafy wall you bounce off in the air, and a
// palm trunk is round and thin, which is the case capsules exist for (same
// as gate posts and scenery masts). The leaves stay noCollide.
// ============================================================================
import * as THREE from "three";
import { materialColor } from "three/tsl";
import { getSharedGltfLoader } from "../../v2/core/foliage/glbLoader.js";
import { mergeByMaterial, dequantize, markSharedGeometry } from "./modularRoadBatching.js";

export const PALM_URL = "/models/palmtest_compressed.glb";

/**
 * Target height in metres — a GAME number.
 *
 * The file's quantized accessors say nothing about metres, so the native size
 * is measured after Three dequantises and then scaled to this. 12 m towers
 * over the 5 m car the way a roadside palm should, without becoming a 40 m
 * landmark that fills the thumbnail.
 */
export const PALM_HEIGHT = 12;

/** In-game dimensions after normalise — filled once the model loads. */
export const PALM_SIZE = { length: 0, height: 0, width: 0 };
/** Trunk capsule, local space — filled with PALM_SIZE. */
export const PALM_TRUNK = { radius: 0, height: 0, x: 0, y: 0, z: 0 };

let _template = null;
let _loading = null;

/**
 * Load and normalise the palm once.
 * Must be awaited before thumbnails or placement — makePalm() is sync.
 */
export function preloadPalm() {
  if (_loading) return _loading;
  _loading = new Promise((resolve) => {
    getSharedGltfLoader().load(
      PALM_URL,
      (gltf) => { _template = normalise(gltf.scene); resolve(_template); },
      undefined,
      (err) => {
        console.warn("[ModularRoad-v3] palm GLB failed to load", err);
        resolve(null);
      },
    );
  });
  return _loading;
}

function isTrunkMesh(o) {
  return /trunk/i.test(o.name ?? "");
}

function normalise(scene) {
  const root = new THREE.Group();
  root.name = "Palm";

  scene.updateMatrixWorld(true);

  const rawAll = new THREE.Box3();
  const rawTrunk = new THREE.Box3();
  scene.traverse((o) => {
    if (!o.isMesh) return;
    const g = dequantize(o.geometry.clone());
    g.applyMatrix4(o.matrixWorld);
    g.computeBoundingBox();
    rawAll.union(g.boundingBox);
    if (isTrunkMesh(o)) rawTrunk.union(g.boundingBox);
    g.dispose();
  });
  if (rawAll.isEmpty()) return root;

  const uniform = PALM_HEIGHT / Math.max(rawAll.max.y - rawAll.min.y, 1e-6);
  // Plant the TRUNK on the click, not the canopy centroid — a palm's fronds
  // hang off to one side, and centering the full AABB would offset the bole.
  const trunkMid = rawTrunk.isEmpty()
    ? rawAll.getCenter(new THREE.Vector3())
    : rawTrunk.getCenter(new THREE.Vector3());
  const m = new THREE.Matrix4()
    .makeTranslation(-trunkMid.x * uniform, -rawAll.min.y * uniform, -trunkMid.z * uniform)
    .multiply(new THREE.Matrix4().makeScale(uniform, uniform, uniform));

  scene.updateMatrixWorld(true);
  scene.traverse((o) => {
    if (!o.isMesh) return;
    const g = dequantize(o.geometry.clone());
    g.applyMatrix4(o.matrixWorld);
    g.applyMatrix4(m);
    const trunk = isTrunkMesh(o);
    const mesh = new THREE.Mesh(g, toNodeMaterial(o.material, trunk));
    mesh.name = trunk ? "PalmTrunk" : "PalmLeaves";
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // Visual only — the capsule below is what the car hits.
    mesh.userData.noCollide = true;
    root.add(mesh);
  });

  mergeByMaterial(root);

  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  PALM_SIZE.length = size.x;
  PALM_SIZE.height = size.y;
  PALM_SIZE.width = size.z;

  const trunkMesh = root.children.find((c) => c.name === "PalmTrunk");
  if (trunkMesh) {
    trunkMesh.geometry.computeBoundingBox();
    const tb = trunkMesh.geometry.boundingBox;
    const ts = tb.getSize(new THREE.Vector3());
    const tc = tb.getCenter(new THREE.Vector3());
    // AABB xz is fat on a leaning bole. Radius is the farthest bark from the
    // vertical axis in the bottom 3 m — the band a car actually hits — so the
    // capsule hugs the trunk instead of filling the canopy-offset box.
    const pos = trunkMesh.geometry.getAttribute("position");
    let hitR = 0;
    const hitTop = tb.min.y + 3;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      if (y > hitTop) continue;
      hitR = Math.max(hitR, Math.hypot(pos.getX(i) - tc.x, pos.getZ(i) - tc.z));
    }
    PALM_TRUNK.radius = hitR > 0.05 ? hitR : 0.5 * Math.max(ts.x, ts.z);
    PALM_TRUNK.height = ts.y;
    PALM_TRUNK.x = tc.x;
    PALM_TRUNK.y = tc.y;
    PALM_TRUNK.z = tc.z;
    // Thumbnail: skip the bole. A sphere around the full 12 m tree is mostly
    // empty air, so the tile showed a speck. Frame the crown instead.
    trunkMesh.userData.thumbIgnore = true;
    const marker = new THREE.Object3D();
    marker.name = "PalmTrunkCapsule";
    marker.position.set(tc.x, tc.y, tc.z);
    marker.userData.capsule = { radius: PALM_TRUNK.radius, height: PALM_TRUNK.height };
    root.add(marker);
  }

  markSharedGeometry(root);
  return root;
}

function toNodeMaterial(src, trunk) {
  const mat = new THREE.MeshStandardNodeMaterial({
    color: src.color?.clone() ?? new THREE.Color(0xffffff),
    roughness: src.roughness ?? 0.7,
    metalness: src.metalness ?? 0,
    map: src.map ?? null,
    // Frond cards are one-sided in the file; DoubleSide so they do not vanish
    // from underneath when you drive past.
    side: trunk ? (src.side ?? THREE.FrontSide) : THREE.DoubleSide,
  });
  mat.colorNode = materialColor;
  mat.userData.batchKey = trunk ? "palm-trunk" : "palm-leaves";
  return mat;
}

/** A placement. Shares geometry and materials with every other palm. */
export function makePalm() {
  const g = new THREE.Group();
  g.name = "Palm";
  // Extra pull-in on top of leaf-only framing so the fronds fill the square
  // the way a container fills it. 0.55 ~ 90% of the tile; 1.0 is the default
  // road-piece sphere.
  g.userData.thumbFit = 0.55;
  if (_template) for (const c of _template.children) g.add(c.clone());
  return g;
}

export function palmReady() { return !!_template; }
