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
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

const _m4a = new THREE.Matrix4();
const _m4b = new THREE.Matrix4();

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
  /**
   * The file ships a full cabin — seats, door cards, dashboard, steering wheel —
   * as SIX separate meshes. Behind tinted glass, from a chase camera, at
   * 170 km/h, none of it is ever legible. Dropping it is a third of the car's
   * draw calls for nothing visible.
   *
   * Turn it on if you ever add a cockpit camera; it is only ever a waste from
   * the outside.
   */
  showInterior: false,
  /**
   * Merge meshes that share a material into one draw. Only `mm_windows` is
   * shared here (four windows + two headlight lenses), and the lenses have to
   * stay separate because they are driven as lights — so this is the four
   * windows collapsing into one draw.
   */
  mergeByMaterial: true,
};

/** The six cabin meshes. `_INT_` catches the door/steering/interior nodes, and
 *  `INTERIOR` the cab shell — every one of them is authored `..._INT_...` or
 *  `...INTERIOR...` in this file. */
const RE_INTERIOR = /_INT_|INTERIOR|STEERING_WHEEL/i;
const RE_HEADLIGHT_LENS = /HEADLIGHT_LENS/i;
const RE_EMISSIVE = /emiss/i;
const RE_GLASS = /windows/i;
/** Parts that define the car's OUTER silhouette — the only ones worth casting. */
const RE_SILHOUETTE = /mm_ext|misc/i;

const label = (o) => `${o.name ?? ""} ${o.material?.name ?? ""}`;

/**
 * Collapse several meshes that share a material into one draw.
 *
 * mergeGeometries returns NULL — silently, no throw — when the inputs disagree
 * on their attribute set or on indexed-ness, and the caller ends up adding
 * nothing to the scene and losing the parts. So both are normalised first, and
 * a null result falls back to keeping the originals: fewer draw calls is never
 * worth a car with no windows.
 *
 * @returns {THREE.Mesh|null} the merged mesh (already parented), or null if the
 *          originals were kept.
 */
function mergeMeshes(meshes, root, name) {
  if (meshes.length < 2) return null;
  const inv = _m4a.copy(root.matrixWorld).invert();
  const geos = meshes.map((m) => {
    const g = m.geometry.clone();
    g.applyMatrix4(_m4b.multiplyMatrices(inv, m.matrixWorld)); // bake to root space
    return g;
  });

  // Attribute intersection — anything not present on EVERY input has to go.
  let common = new Set(Object.keys(geos[0].attributes));
  for (const g of geos.slice(1)) {
    common = new Set([...common].filter((k) => k in g.attributes));
  }
  for (const g of geos) {
    for (const k of Object.keys(g.attributes)) if (!common.has(k)) g.deleteAttribute(k);
    g.morphAttributes = {};
  }
  // Indexed-ness must agree too. Dropping to non-indexed is the safe direction:
  // building an index for the odd one out can change vertex order.
  if (!geos.every((g) => g.index)) {
    for (let i = 0; i < geos.length; i++) {
      if (geos[i].index) { const n = geos[i].toNonIndexed(); geos[i].dispose(); geos[i] = n; }
    }
  }

  const merged = mergeGeometries(geos, false);
  for (const g of geos) g.dispose();
  if (!merged) {
    console.warn(`[ModularRoad-v3] chassis: could not merge "${name}" — keeping ${meshes.length} draws`);
    return null;
  }

  const out = new THREE.Mesh(merged, meshes[0].material);
  out.name = name;
  out.castShadow = meshes.some((m) => m.castShadow);
  out.receiveShadow = false;
  root.add(out);
  for (const m of meshes) { m.removeFromParent(); m.geometry.dispose(); }
  return out;
}

/**
 * Rebuild a loaded GLB material as a REAL node material for the light meshes.
 *
 * This is not fussiness. GLTFLoader produces classic MeshPhysicalMaterials, and
 * three converts those to node materials exactly ONCE, at shader build, with a
 * by-value copy (`NodeLibrary.fromMaterial`: `for (const key in material)
 * nodeMaterial[key] = material[key]`). Two consequences, both of which bite
 * precisely the thing we want here:
 *
 *   • `mrtNode` survives the copy, so bloom LOOKS wired — but
 *   • every later write to `emissiveIntensity` lands on the ORIGINAL material,
 *     after the copy was taken, so the lights never actually change brightness.
 *
 * Driving lights means writing that value every frame, so they have to be node
 * materials from the start. Only the properties a lamp needs are carried over —
 * copying wholesale would drag `type`/`uuid` across too.
 */
function makeLightMaterial(src, { name, emissive, opacity = 1, transparent = true }) {
  const mat = new THREE.MeshStandardNodeMaterial({
    name,
    map: src.map ?? null,
    // The emissive MAP is the whole point of reusing the file's lamp art — it
    // carries the internal lens structure that a flat emissive colour cannot.
    emissiveMap: src.emissiveMap ?? null,
    emissive: new THREE.Color(emissive),
    emissiveIntensity: 0, // driven per-frame by Vehicle._updateTaillights
    roughness: src.roughness ?? 0.5,
    metalness: 0,
    transparent,
    opacity,
    side: src.side ?? THREE.FrontSide,
    // Lamps are a bloom SOURCE; tone mapping them first would crush the very
    // headroom the bloom threshold keys off.
    toneMapped: false,
  });
  applyBloomMRT(mat, materialEmissive);
  return mat;
}

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

  // ── 1. CLASSIFY ─────────────────────────────────────────────────────────────
  // Collect first, act after: dropping and merging both mutate the hierarchy,
  // which is not safe to do from inside a traverse.
  const all = [];
  root.traverse((o) => { if (o.isMesh) all.push(o); });
  const loadedCount = all.length;

  const interior = [];
  const glass = [];
  const brakeLights = [];
  const headlampLenses = [];

  for (const o of all) {
    const tag = label(o);

    // SHADOW BUDGET — the same lesson the GLB wheel taught. Every caster is
    // redrawn once per shadow cascade and v3 runs 3, so a caster costs 1 main
    // draw + 3 shadow draws. Marking all 18 meshes would be 72 draws for one
    // car. Only the outer body and the mirrors/aero define the silhouette;
    // everything else sits inside it and would cost 48 draws to change nothing.
    o.castShadow = RE_SILHOUETTE.test(tag);
    o.receiveShadow = false; // a car body self-shadowing is not worth a cascade lookup

    if (RE_INTERIOR.test(o.name)) { interior.push(o); continue; }

    if (RE_HEADLIGHT_LENS.test(o.name)) {
      // A REBUILT node material, not a clone — see makeLightMaterial. Also note
      // the lens shares `mm_windows` with the four windows, so lighting it must
      // not light the windscreen; rebuilding gives that for free.
      o.material = makeLightMaterial(o.material, {
        name: "headlampLens",
        emissive: CHASSIS_GLB_LIGHTS.headlampColor,
        opacity: 0.85,
      });
      headlampLenses.push(o);
      continue;
    }

    if (RE_EMISSIVE.test(tag)) {
      // Already emissive in the file (factor 1,1,1 × strength 3.64 + an emissive
      // MAP, which is kept — it is what gives the lamp its internal structure
      // instead of a flat glowing slab).
      o.material = makeLightMaterial(o.material, {
        name: "brakeLight",
        emissive: "#ffffff",
        opacity: o.material.opacity ?? 1,
        transparent: o.material.transparent,
      });
      brakeLights.push(o);
      continue;
    }

    if (RE_GLASS.test(tag)) {
      if (CHASSIS_GLB.cheapGlass) {
        o.material = o.material.clone();
        o.material.transmission = 0;
        o.material.transparent = true;
        o.material.opacity = CHASSIS_GLB.glassOpacity;
      }
      glass.push(o);
    }
  }

  // ── 2. DROP THE CABIN ───────────────────────────────────────────────────────
  if (!CHASSIS_GLB.showInterior) {
    for (const o of interior) { o.removeFromParent(); o.geometry.dispose(); }
  }

  // ── 3. MERGE WHAT SHARES A MATERIAL ─────────────────────────────────────────
  // The windows are one material across four meshes. The two lenses share it too
  // but are driven as lights, so they merge into their OWN mesh rather than
  // joining the glass — they are always lit together, so one draw covers both.
  if (CHASSIS_GLB.mergeByMaterial) {
    const g = mergeMeshes(glass, root, "chassisGlass");
    if (g) { glass.length = 0; glass.push(g); }
    const l = mergeMeshes(headlampLenses, root, "headlampLenses");
    if (l) { headlampLenses.length = 0; headlampLenses.push(l); }
  }

  let meshCount = 0;
  let casterCount = 0;
  root.traverse((o) => { if (o.isMesh) { meshCount++; if (o.castShadow) casterCount++; } });

  return {
    object, size, brakeLights, headlampLenses, meshCount, casterCount,
    loadedCount, droppedInterior: CHASSIS_GLB.showInterior ? 0 : interior.length,
  };
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
