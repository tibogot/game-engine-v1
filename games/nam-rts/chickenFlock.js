// THE HENS, from your model (public/models/Chicken_001_compressed.glb) —
// 976 triangles, textured, three clips (idle 8.2 s with its own pecking and
// looking round, walk, run). GAME code.
//
// COST. Not a SkinnedMesh + mixer each (a draw and a CPU pose apiece): the
// same GPU crowd path as the soldiers (crowdSkinning.js) — the clips baked
// once into a bone table, every hen skinned by one compute pass, ONE draw
// for the flock, idle ⇄ walk crossfaded on the GPU. What they DO is
// chickens.js's henBrain; a failed load falls back to its procedural hen.
import * as THREE from "three";
import { getSharedGltfLoader } from "../../v2/core/foliage/glbLoader.js";
import { createCrowdField } from "./crowdSkinning.js";
import { createChickens, henBrain } from "./chickens.js";

const URL = "/models/Chicken_001_compressed.glb";

/** A float copy (the GLB's skin weights are packed bytes; the kernel reads floats). */
function floatAttr(a) {
  const out = new Float32Array(a.count * a.itemSize);
  for (let i = 0; i < a.count; i++) for (let k = 0; k < a.itemSize; k++) out[i * a.itemSize + k] = a.getComponent(i, k);
  return new THREE.BufferAttribute(out, a.itemSize);
}

/**
 * `homes`: [{ x, z }]; opts as chickens.js's createChickens, plus `height`
 * (m, the hen standing). Returns { update(dt), count, mesh }.
 */
export async function createChickenFlock(app, homes, { roam = 7, blocked = () => false, height = 0.42 } = {}) {
  if (!homes.length) return null;
  let gltf;
  try {
    gltf = await getSharedGltfLoader().loadAsync(URL);
  } catch (e) {
    console.warn("[chickens] model failed, procedural hens instead:", e);
    return createChickens(app, homes, { roam, blocked });
  }
  const root = gltf.scene;
  root.updateMatrixWorld(true);
  let src = null;
  root.traverse((o) => { if (o.isSkinnedMesh && !src) src = o; });
  const clip = (re) => gltf.animations.find((c) => re.test(c.name));
  const idle = clip(/idle/i), walk = clip(/walk/i);
  if (!src || !idle || !walk) return createChickens(app, homes, { roam, blocked });
  src.geometry.setAttribute("skinWeight", floatAttr(src.geometry.getAttribute("skinWeight")));

  // Its size, measured on the SKINNED rest pose (the raw vertices are
  // quantised; the bones hold the scale).
  const v = new THREE.Vector3(), P = src.geometry.getAttribute("position");
  let lo = Infinity, hi = -Infinity, fz = 0, bz = 0;
  for (let i = 0; i < P.count; i += 3) {
    src.getVertexPosition(i, v);
    v.applyMatrix4(src.matrixWorld);
    lo = Math.min(lo, v.y); hi = Math.max(hi, v.y);
    fz = Math.max(fz, v.z); bz = Math.min(bz, v.z);
  }
  const scale = height / Math.max(1e-3, hi - lo);

  const field = createCrowdField({
    scene: app.scene, renderer: app.renderer, source: src, animRoot: root,
    clips: { idle, run: walk }, max: homes.length, castShadow: false,
  });
  field.mesh.name = "ChickenFlock";
  const brain = henBrain(homes, { roam, blocked });
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3(scale, scale, scale);
  const up = new THREE.Vector3(0, 1, 0);
  const clocks = brain.hens.map((h) => h.phase * 8.2);
  return {
    mesh: field.mesh, count: homes.length,
    /** Where each hen is (x, z, yaw, state) — for a look from the console. */
    get hens() { return brain.hens; },
    update(dt) {
      brain.step(dt);
      field.begin();
      brain.hens.forEach((h, i) => {
        // The walk clip's stride at this size wants ~0.55 m/s: faster, it plays faster.
        clocks[i] += dt * (h.walk > 0.5 ? Math.max(1, h.speed / 0.55) : 1);
        p.set(h.x, app.getWorldHeight(h.x, h.z) - lo * scale, h.z);
        q.setFromAxisAngle(up, h.yaw);
        m.compose(p, q, sc);
        field.add(m, clocks[i], h.walk);
      });
      field.commit();
    },
  };
}
