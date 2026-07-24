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

  // SHADOW BUDGET. Every caster is re-drawn once per shadow cascade, and v3 runs
  // 3 (v2/app/config.js: capped at 3, not 4, by the Windows WebGPU 16-sampler
  // limit). So a caster costs 1 main draw + 3 shadow draws.
  //
  // Only the TYRE casts. The rim, rotor and caliper all sit INSIDE the tyre's
  // silhouette, so their shadows are entirely contained by it and cost 9 draws
  // per wheel for nothing. Marking all four (the obvious thing, and what this
  // did at first) put the GLB wheels at 64 draws/frame against the procedural
  // wheels' 40.
  //
  // frustumCulled is deliberately left ON: "it's small and near the car" is true
  // for the main pass but wrong for shadows, where each cascade culls against
  // its own frustum and would otherwise redraw all four wheels in all three.
  const meshes = [];
  object.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = false;
    o.receiveShadow = false;
    meshes.push(o);
  });

  // TYRE **and RIM** cast. The tyre alone is not enough: a tyre mesh is an
  // ANNULUS, so on its own it casts a ring with a hole punched through the
  // middle. The rim (outer radius ~0.29 against the tyre's ~0.37) fills that
  // hole, and the two together give a solid disc silhouette. The rotor and
  // caliper stay off — they sit inside the rim and add nothing but draws.
  const _b = new THREE.Box3();
  const _s = new THREE.Vector3();
  const label = (m) => `${m.material?.name ?? ""} ${m.name ?? ""}`;
  const tyre = meshes.find((m) => /tyre|tire/i.test(label(m)));
  const rim = meshes.find((m) => m !== tyre && /wheel|rim/i.test(label(m)));
  if (tyre) tyre.castShadow = true;
  if (rim) rim.castShadow = true;

  // Fallback for an unrecognised file: cast from the two physically largest
  // parts, measured in WORLD space. Raw local bounding radii would pick wrong —
  // the four nodes carry very different scales (0.374 down to 0.178).
  if (!tyre && !rim) {
    const bySize = meshes
      .map((m) => ({ m, size: (_b.setFromObject(m), _b.getSize(_s).length()) }))
      .sort((a, b) => b.size - a.size);
    for (const { m } of bySize.slice(0, 2)) m.castShadow = true;
  }

  return {
    object,
    // The disc is in YZ, so either extent is a diameter; take the larger in case
    // the tyre is very slightly non-round after quantization.
    radius: Math.max(size.y, size.z) * 0.5,
    width: size.x,
  };
}
