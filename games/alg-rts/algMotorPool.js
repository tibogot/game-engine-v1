// THE MOTOR POOL, NEW STANDARD (2026-10-18, you: "see how far we could make a better looking AAA motor pool").
// tools/blender/motorPool.py builds it as the real thing is built — I-section columns, Howe trusses, purlins,
// lapped corrugated sheets, a rendered workshop with its openings cut through — and bakes one texture per
// object (colour × ambient occlusion) → public/models/alg/motorPool.glb: Shed, Workshop, Apron, Props, and the
// garage bay's two doors (DoorL / DoorR, origin on the hinge). Front at -Z, as buildMotorPool.
// In the BUILDINGS LAB first (the kit's motor pool beside it).
import * as THREE from "three";
import { loadSandbags, sandbagMesh, sandbagWallBags } from "./algSandbags.js";

let _p = null, _scene = null;
const S = 1.3;          // (built in real metres; the game draws its buildings at unit scale ×1.3, as rtsAlgeria's)

/** Load the GLB once. Null if missing. */
export function loadMotorPool() {
  return (_p ??= import("three/addons/loaders/GLTFLoader.js").then(async ({ GLTFLoader }) => {
    const [gltf] = await Promise.all([new GLTFLoader().loadAsync("/models/alg/motorPool.glb").catch(() => null), loadSandbags()]);
    if (!gltf) return null;
    // THE SANDBAGS (you: "we have already made some — I have several realistic ones"): the game's cloth-
    // simulated bags (algSandbags.js), a low wall shielding the drums at the shed's left gable, on the apron.
    // (built in the game's units, then ÷S: the bags the size of the game's walls, not ×1.3 again)
    const bags = sandbagMesh(sandbagWallBags({ length: 3.4 * S, courses: 3, thick: 1, seed: 11, x0: -9.08 * S, z0: -2.55 * S, yaw: Math.PI / 2 }), "MotorPoolBags");
    bags.scale.setScalar(1 / S);
    bags.position.y = 0.15;
    gltf.scene.add(bags);
    gltf.scene.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = o.receiveShadow = true;
      const m = o.material;
      if (m?.map) { m.map.anisotropy = 8; m.map.needsUpdate = true; }
    });
    return (_scene = gltf.scene);
  }));
}

/** A copy of the motor pool (meshes and materials shared), or null if not loaded. */
export function motorPoolMesh() {
  if (!_scene) return null;
  const g = _scene.clone(true);
  g.name = "MotorPoolV2";
  g.scale.setScalar(S);
  return g;
}

/** Stats for the lab's readout: triangles, draws, texture pixels. */
export function motorPoolStats(root) {
  let tris = 0, draws = 0; const tex = new Set();
  root.traverse((o) => {
    if (!o.isMesh) return;
    draws++;
    const g = o.geometry; tris += (g.index ? g.index.count : g.getAttribute("position").count) / 3;
    if (o.material?.map) tex.add(o.material.map);
  });
  let px = 0;
  for (const t of tex) px += (t.image?.width ?? 0) * (t.image?.height ?? 0);
  return { tris, draws, textures: tex.size, mpx: px / 1e6 };
}
