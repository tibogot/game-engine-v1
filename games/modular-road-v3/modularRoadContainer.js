// ============================================================================
// SHIPPING CONTAINER — public/models/container01_compressed.glb as a placeable
// prop, normalised to a real ISO container.
//
// WHAT THE FILE ACTUALLY IS (measured with tools/glbInspect.mjs and by loading
// it in the page — the GLB is KHR_mesh_quantization, so the accessor min/max in
// the JSON are raw integers and say nothing about real size):
//
//     1200 triangles, 4 meshes, 4 materials, ZERO textures
//     bounds  80.013 x 32.788 x 32.926 model units  (length along +X)
//     ratio   2.44 : 1 : 1
//     colours #a6a873 and #86885d olive, #8b8b8b and #535353 greys
//     UVs     TEXCOORD_0 and TEXCOORD_1, both present, both unused
//     y range 1.368 .. 34.156 — it does NOT sit on its own origin
//
// 2.44 : 1 : 1 is a 20 ft ISO container (6.058 x 2.591 x 2.438 m -> 2.49 : 1.06 : 1),
// not a 40 ft one, so that is what it is scaled to.
//
// EXACT ISO, NOT A UNIFORM SCALE. A uniform factor picked off the length leaves
// it 6.058 x 2.482 x 2.493 — 4% short and 2% wide — and a container is a
// standardised object whose whole visual identity is being the size it is: it
// has to stack, sit beside another one, and read correctly against a 4.85 m car.
// The three factors differ by ~3%, which is invisible on the corrugation but is
// the difference between "a container" and "a box that looks a bit like one".
//
// UNTEXTURED IS A FEATURE HERE. Every colour comes from a baseColorFactor, which
// means variation costs nothing: swapping a material colour gives a completely
// different container with no extra texture memory, no extra binding, and — via
// InstancedMesh.setColorAt — no extra draw call either. See CONTAINER_LIVERIES.
// ============================================================================
import * as THREE from "three";
import { materialColor } from "three/tsl";
import { getSharedGltfLoader } from "../../v2/core/foliage/glbLoader.js";
import { mergeByMaterial, dequantize } from "./modularRoadBatching.js";

export const CONTAINER_URL = "/models/container01_compressed.glb";

/** Real 20 ft ISO container, metres. */
export const CONTAINER_SIZE = { length: 6.058, height: 2.591, width: 2.438 };
/** The model's own bounds, measured. Kept here so the scale is derived, never
 *  guessed — re-export the GLB at a different size and only these change. */
const MODEL = {
  min: new THREE.Vector3(-40.009, 1.368, -16.339),
  max: new THREE.Vector3(40.004, 34.156, 16.587),
};

/**
 * Liveries — and they cost NOTHING, which is the whole reason to do it this way.
 *
 * three multiplies `InstancedMesh.instanceColor` into whatever the material's
 * colour node resolves to (NodeMaterial.setupDiffuseColor, "INSTANCED COLORS"),
 * so a per-container colour is a vec3 in an instance buffer — no extra material,
 * no extra binding, no extra draw call. Forty containers in six colours are the
 * same four draws as forty in one.
 *
 * Because it MULTIPLIES, the tintable materials are rebased to white (see
 * normalise): tint x 1 gives the livery exactly rather than the livery filtered
 * through the model's olive. The door end keeps a fixed 0.72 factor so it stays
 * a shade darker than the shell in every livery, which is how a real container
 * reads and is one number instead of a second palette.
 *
 * Ordinary shipping-line colours rather than anything invented — a yard reads as
 * a yard because the palette is familiar.
 */
export const CONTAINER_LIVERIES = [
  0x9c4030, // rust red
  0x1c4f80, // maersk blue
  0xa6a873, // the model's own olive
  0xa8541f, // oxide orange
  0x2f5e46, // weathered green
  0x8a8f94, // grey
  0xb8952c, // ochre
];

/** The two OLIVE source materials are the corrugated shell and the door end; the
 *  greys are frame rails and corner castings, which on a real container stay
 *  dark whatever the shell is painted, so they take no tint. */
const SHELL_HEX = 0xa6a873;
const DOOR_HEX = 0x86885d;
/** How much darker the door end sits than the shell, in every livery. */
const DOOR_SHADE = 0.72;

let _template = null;
let _loading = null;

/**
 * Load and normalise the container once.
 *
 * Must be awaited before the prop can draw anything — `makeContainer()` is
 * synchronous because the prop catalog is, so until this resolves it hands back
 * an empty group. The game preloads at startup and refreshes the instancing
 * template when it lands (see roadGame), so a container placed during the load
 * still appears.
 */
export function preloadContainer() {
  if (_loading) return _loading;
  _loading = new Promise((resolve) => {
    getSharedGltfLoader().load(
      CONTAINER_URL,
      (gltf) => { _template = normalise(gltf.scene); resolve(_template); },
      undefined,
      (err) => {
        // A missing model must not take the editor down — the prop just stays
        // empty and everything else keeps working.
        console.warn("[ModularRoad-v3] container GLB failed to load", err);
        resolve(null);
      },
    );
  });
  return _loading;
}

function normalise(scene) {
  const root = new THREE.Group();
  root.name = "Container";

  // Per-axis scale to exact ISO — see the header for why not uniform.
  const src = MODEL.max.clone().sub(MODEL.min);
  const s = new THREE.Vector3(
    CONTAINER_SIZE.length / src.x,
    CONTAINER_SIZE.height / src.y,
    CONTAINER_SIZE.width / src.z,
  );
  // Sit on y=0 and centre on x/z, so the placement point is the container's
  // footprint centre — which is what the gizmo and the ground snap both expect.
  const mid = MODEL.max.clone().add(MODEL.min).multiplyScalar(0.5);
  const m = new THREE.Matrix4()
    .makeTranslation(-mid.x * s.x, -MODEL.min.y * s.y, -mid.z * s.z)
    .multiply(new THREE.Matrix4().makeScale(s.x, s.y, s.z));

  scene.updateMatrixWorld(true);
  scene.traverse((o) => {
    if (!o.isMesh) return;
    // BEFORE any matrix — this GLB is KHR_mesh_quantization, and applyMatrix4
    // would write float results back into its Int16 position array. See
    // dequantize() for what that looked like when it bit.
    const g = dequantize(o.geometry.clone());
    g.applyMatrix4(o.matrixWorld); // flatten the file's own node transforms
    g.applyMatrix4(m);             // then into game metres, on the ground
    const mesh = new THREE.Mesh(g, toNodeMaterial(o.material));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    root.add(mesh);
  });

  // 4 meshes over 4 materials, so this only flattens the node tree — but it
  // keeps the container on the same path as every other prop, and would collapse
  // anything a future re-export splits further.
  mergeByMaterial(root);

  // REBASE THE TINTABLE PARTS TO WHITE. instanceColor multiplies, so leaving the
  // shell olive would make every livery an olive-filtered version of itself —
  // blue would come out muddy green. White means the instance colour IS the
  // livery.
  for (const child of root.children) {
    const hex = child.material.userData.sourceHex;
    const isShell = hex === SHELL_HEX;
    const isDoor = hex === DOOR_HEX;
    child.userData.tintable = isShell || isDoor;
    if (isShell) child.material.color.setScalar(1);
    else if (isDoor) child.material.color.setScalar(DOOR_SHADE);
    // The visible corrugation is 1200 triangles and none of it belongs in a
    // collision BVH — see the proxy below.
    child.userData.noCollide = true;
  }

  // A BOX, because it IS a box.
  //
  // Baking the corrugated shell put 1200 triangles per container into BOTH the
  // deck and the solids BVH — measured at 192,000 collision triangles for a
  // 40-container yard, for a shape a car cannot tell from a cuboid. 12 triangles
  // gives identical collision and rebuilds the BVH ~100x faster, which matters
  // because every prop edit rebakes it.
  //
  // Invisible AND `noRender`, so it stays out of the draw path and out of the
  // instancing template while still being real geometry the bake can read.
  const proxy = new THREE.Mesh(
    new THREE.BoxGeometry(CONTAINER_SIZE.length, CONTAINER_SIZE.height, CONTAINER_SIZE.width),
  );
  proxy.name = "ContainerCollider";
  proxy.position.y = CONTAINER_SIZE.height / 2;
  proxy.visible = false;
  proxy.userData.noRender = true;
  root.add(proxy);
  return root;
}

/**
 * The GLB ships MeshStandardMaterial, which in v3 freezes its fog: three's
 * WebGPU backend only re-uploads a render object's uniforms when the material
 * carries a NODE property, and scene-level uniforms behind `scene.fogNode` are
 * not tracked. A container parked beside the track is exactly that — static,
 * world-space, and lit by the same fog as the road next to it.
 */
function toNodeMaterial(src) {
  const m = new THREE.MeshStandardNodeMaterial({
    color: src.color?.clone() ?? new THREE.Color(0xffffff),
    roughness: src.roughness ?? 0.82,
    metalness: src.metalness ?? 0,
    map: src.map ?? null,
    side: src.side,
  });
  m.colorNode = materialColor;
  // Remembered so the livery pass can tell the shell from the frame after the
  // colours have been overwritten.
  m.userData.sourceHex = src.color?.getHex() ?? 0xffffff;
  m.userData.batchKey = "container";
  return m;
}

/** A placement. Shares geometry and materials with every other container. */
export function makeContainer() {
  const g = new THREE.Group();
  g.name = "Container";
  if (_template) for (const c of _template.children) g.add(c.clone());
  return g;
}

/** True once the model is in and props built from it will not be empty. */
export function containerReady() { return !!_template; }
