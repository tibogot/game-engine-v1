// ============================================================================
// GLB CHASSIS — loads models/chassis_compressed.glb as the car's body visual.
//
// The file is a Lotus Emira GT4 body (18 nodes, 13 materials, Draco + KTX2), the
// same car the WHEEL glb comes from. That shared origin is why it drops straight
// in at scale 1.0 — MEASURED against the physics rig rather than assumed:
//
//     model body half-width  1.05 m   ==  wheel hub |x|            1.05 m
//     model half-width+aero  1.16 m   ≈   wheel outer edge         1.17 m
//     model height           1.26 m       (real Emira: 1.225)
//
// The wheels land exactly in the arches with no scaling. `+Z` is forward in the
// file (headlight lens nodes at z +2.07, brake-light node at z -1.98), which is
// already the Vehicle's forward axis, so there is no re-orientation either.
//
// Two normalisations the file does need:
//
//  • VERTICAL. The model's own y=0 is its ground plane, but the Vehicle parents
//    the body visual at the chassis ORIGIN, which sits `CHASSIS_GLB.offsetY`
//    above the ground when the suspension has settled. That figure is measured
//    from a headless settle on flat ground (tools/chassisFitTest.mjs), not
//    derived — the spring rate, rest length and wheel radius all feed it.
//
//  • LONGITUDINAL. The body's bounds are asymmetric about its origin (z −2.19 to
//    +2.66) because of the rear wing, so it needs shifting back to sit centred
//    on the axles.
//
// LIGHTS. The file carries its own, which is why this returns handles to them:
//   • `emiss` material — emissiveFactor [1,1,1] × strength 3.64 with an emissive
//     TEXTURE. Genuinely emissive, so brake lights need no invention. Despite
//     the node being called BRAKES_LEFT it spans the full 1.73 m width — it is
//     both tail lights in one mesh.
//   • HEADLIGHT_LENS_LEFT/RIGHT — separate nodes, but authored as `mm_windows`
//     glass, so they are lenses and NOT emissive. They get a cloned material
//     here so they can be lit without touching the windows that share it.
// ============================================================================
import * as THREE from "three";
import { materialEmissive } from "three/tsl";
import {
  getSharedGltfLoader,
  initGlbLoaderRenderer,
} from "../../v2/core/foliage/glbLoader.js";
import { applyBloomMRT } from "../../v3/render/bloomMRT.js";
// Intensities live with the Vehicle because it drives them per frame; only the
// lamp COLOUR is needed here, to build the lens material. Same direction as
// modularRoadTireMarks importing WHEEL — no cycle.
import { CHASSIS_GLB_LIGHTS } from "../../v3/play/modularRoadVehicle.js";

export const CHASSIS_GLB_URL = "/models/chassis_compressed.glb";

/**
 * Placement of the model inside the chassis anchor. All chassis-local metres.
 * Live-tunable from the dev panel (Chassis fit) — nudge, then copy the numbers
 * back here. `CHASSIS_GLB_DEFAULTS` below is the reset target.
 */
export const CHASSIS_GLB = {
  /** 1.0 is correct — see the width measurements in the header. */
  scale: 1.0,
  /** The file is laterally symmetric (x −1.16..+1.16), so this should stay 0 —
   *  it exists only so a fit problem can be ruled out rather than assumed. */
  offsetX: 0,
  /** Measured settled ride height: the chassis origin sits this far above the
   *  ground, so the model (whose y=0 IS the ground) drops by exactly that.
   *  NOTE tools/chassisModelTest.mjs asserts this against a fresh settle — if
   *  you tune it away from the measured value that test will tell you. */
  offsetY: -0.597,
  /** Body bounds centre is +0.23 in the file (rear wing skews it), but −0.23
   *  sits the car slightly too far back against the axles — eyeballed to −0.15,
   *  which is the wing's contribution to the bounds rather than the body's. */
  offsetZ: -0.15,
  /**
   * Glass in this file uses KHR_materials_transmission with transmission = 1.0
   * on SIX meshes (4 windows + 2 headlight lenses). Real transmission makes
   * three render a backdrop pass, which is a per-pixel cost on a car that is on
   * screen 100% of the time — expensive for a racer, and this project is
   * already GPU/fill-rate bound. Cheap alpha instead, by default.
   */
  cheapGlass: true,
  glassOpacity: 0.42,
};

const RE_HEADLIGHT_LENS = /HEADLIGHT_LENS/i;
const RE_EMISSIVE = /emiss/i;
const RE_GLASS = /windows/i;
/** Parts that define the car's OUTER silhouette — the only ones worth casting. */
const RE_SILHOUETTE = /mm_ext|misc/i;

const label = (o) => `${o.name ?? ""} ${o.material?.name ?? ""}`;

/**
 * @param {THREE.WebGPURenderer} renderer once, for KTX2 transcoder detection
 * @param {string} [url]
 * @returns {Promise<{
 *   object: THREE.Object3D,
 *   size: THREE.Vector3,
 *   brakeLights: THREE.Mesh[],
 *   headlampLenses: THREE.Mesh[],
 *   meshCount: number,
 *   casterCount: number,
 * }>}
 */
export async function loadChassisModel(renderer, url = CHASSIS_GLB_URL) {
  initGlbLoaderRenderer(renderer);
  const gltf = await getSharedGltfLoader().loadAsync(url);

  const root = gltf.scene;
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  if (box.isEmpty()) throw new Error("chassis GLB has no visible geometry");
  const size = box.getSize(new THREE.Vector3());

  // Wrap rather than bake, same as the wheel: the offsets stay live-tunable from
  // the dev panel without touching the loaded hierarchy or its shared geometry.
  const object = new THREE.Group();
  object.name = "ChassisModelGLB";
  object.add(root);
  applyChassisGlbTransform(object);

  const brakeLights = [];
  const headlampLenses = [];
  let meshCount = 0;
  let casterCount = 0;

  root.traverse((o) => {
    if (!o.isMesh) return;
    meshCount++;
    const tag = label(o);

    // SHADOW BUDGET — the same lesson the GLB wheel taught. Every caster is
    // redrawn once per shadow cascade and v3 runs 3, so a caster costs 1 main
    // draw + 3 shadow draws. Marking all 18 meshes would be 72 draws for one
    // car. Only the outer body and the mirrors/aero define the silhouette;
    // interior, seats, steering wheel and glass sit entirely inside it and
    // would cost 48 draws to change nothing.
    o.castShadow = RE_SILHOUETTE.test(tag);
    o.receiveShadow = false; // a car body self-shadowing is not worth a cascade lookup
    if (o.castShadow) casterCount++;

    if (RE_HEADLIGHT_LENS.test(o.name)) {
      // Clone: the lens shares `mm_windows` with the four windows, and lighting
      // the lenses must not light the windscreen.
      o.material = o.material.clone();
      o.material.name = "headlampLens";
      o.material.transparent = true;
      o.material.transmission = 0;
      o.material.opacity = 0.85;
      o.material.emissive = new THREE.Color(CHASSIS_GLB_LIGHTS.headlampColor);
      o.material.emissiveIntensity = 0;
      o.material.toneMapped = false;
      applyBloomMRT(o.material, materialEmissive);
      headlampLenses.push(o);
      return;
    }

    if (RE_EMISSIVE.test(tag)) {
      // Already emissive in the file (factor 1,1,1 × strength 3.64 + emissive
      // map). Clone so intensity can be driven per-vehicle, and route it through
      // the selective-bloom MRT — v3 only blooms what writes that buffer, so
      // without this the tail lights are bright but never glow.
      o.material = o.material.clone();
      o.material.emissiveIntensity = 0;
      o.material.toneMapped = false;
      applyBloomMRT(o.material, materialEmissive);
      brakeLights.push(o);
      return;
    }

    if (CHASSIS_GLB.cheapGlass && RE_GLASS.test(tag)) {
      o.material = o.material.clone();
      o.material.transmission = 0;
      o.material.transparent = true;
      o.material.opacity = CHASSIS_GLB.glassOpacity;
    }
  });

  return { object, size, brakeLights, headlampLenses, meshCount, casterCount };
}

/** The shipped fit, so the dev panel can offer a way back from a bad nudge. */
export const CHASSIS_GLB_DEFAULTS = { ...CHASSIS_GLB };

/** Re-apply CHASSIS_GLB placement after a live edit. */
export function applyChassisGlbTransform(object) {
  if (!object) return;
  object.scale.setScalar(CHASSIS_GLB.scale);
  object.position.set(CHASSIS_GLB.offsetX, CHASSIS_GLB.offsetY, CHASSIS_GLB.offsetZ);
}

/** Restore the shipped fit. Returns CHASSIS_GLB so callers can re-read sliders. */
export function resetChassisGlbFit(object) {
  Object.assign(CHASSIS_GLB, CHASSIS_GLB_DEFAULTS);
  applyChassisGlbTransform(object);
  return CHASSIS_GLB;
}
