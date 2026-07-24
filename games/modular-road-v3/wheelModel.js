// ============================================================================
// GLB WHEEL — loads models/wheellotus_compressed.glb as the car's wheel visual.
//
// The file is a Lotus Emira GT4 FRONT-LEFT assembly: four nodes (tyre, rim,
// brake rotor, caliper) with four materials, Draco-compressed and quantized
// (KHR_mesh_quantization + KHR_texture_basisu), so it needs the shared loader
// that already has the Draco + KTX2 decoders wired up.
//
// Two things about the file that this module normalises:
//
//  • It is authored OFF-ORIGIN — the tyre node sits at [-0.145, 0, 0.245], and
//    that X offset is exactly its own half-width. Left as-is the wheel would
//    orbit a point off to one side instead of spinning about its axle, so we
//    re-centre on the measured bounding-box centre.
//
//  • The measured dimensions are RETURNED rather than assumed, because
//    WHEEL.radius is a physics parameter (it scales the ray ring and the sphere
//    sweep in the tire probe), not just a visual one. The caller decides whether
//    to adopt them.
//
// Axis convention matches the procedural wheel already: the disc lies in YZ with
// +X as the axle, which is what `CylinderGeometry().rotateZ(PI/2)` produces and
// what Vehicle's `_spinLocalQ` spins about. No re-orientation needed.
// ============================================================================
import * as THREE from "three";
import {
  getSharedGltfLoader,
  initGlbLoaderRenderer,
} from "../../v2/core/foliage/glbLoader.js";

export const WHEEL_GLB_URL = "/models/wheellotus_compressed.glb";

/**
 * @param {THREE.WebGPURenderer} renderer needed once, for KTX2 transcoder support detection
 * @param {string} [url]
 * @returns {Promise<{ object: THREE.Object3D, radius: number, width: number }>}
 *          `object` is a template to clone per wheel, centred on its axle.
 */
export async function loadWheelModel(renderer, url = WHEEL_GLB_URL) {
  initGlbLoaderRenderer(renderer);
  const gltf = await getSharedGltfLoader().loadAsync(url);

  const root = gltf.scene;
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  if (box.isEmpty()) throw new Error("wheel GLB has no visible geometry");
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());

  // Wrap rather than bake: a pivot at the axle keeps the clone cheap and leaves
  // the loaded hierarchy (and its shared geometry) untouched.
  const object = new THREE.Group();
  object.name = "WheelModelGLB";
  root.position.sub(center);
  object.add(root);

  object.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    o.receiveShadow = false;
    o.frustumCulled = false; // small, always near the car — culling per wheel is waste
  });

  return {
    object,
    // The disc is in YZ, so either extent is a diameter; take the larger in case
    // the tyre is very slightly non-round after quantization.
    radius: Math.max(size.y, size.z) * 0.5,
    width: size.x,
  };
}
