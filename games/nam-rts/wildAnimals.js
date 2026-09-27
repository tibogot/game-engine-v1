// WILD ANIMALS — sambar deer (stag and hinds) and muntjac at the jungle's
// edge. GAME code. Your models (2026-09-26): public/models/Deer_compressed.glb
// and Stag_compressed.glb, from the same pack as the bull — the same clips
// (Eating, Idle, Idle_2, Idle_Headlow, Walk, Gallop).
//
// Vietnam's deer, recoloured from the pack's European red deer:
//   · SAMBAR — big, dark grey-brown, the stag with heavy dark antlers;
//   · MUNTJAC (barking deer) — small and red-brown: the deer model at 0.55.
//
// WHAT THEY DO. Small groups on the sunny fringe of the jungle, away from the
// camps: graze, lift the head and look round, walk a few metres. When a
// soldier — either side's — comes within 35 m they BOLT, galloping 40-70 m
// away from him, then settle again where they stopped. Deer breaking out of a
// treeline is a tell that someone is moving in it.
//
// COST. Each kind is the soldiers' GPU crowd path (crowdSkinning.js): the
// model's pieces merged onto one skeleton (the stag's antlers are a separate,
// unskinned mesh on the Head bone — bound to it here), the clips baked once,
// the whole group skinned in one compute pass and drawn in ONE call.
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { getSharedGltfLoader } from "../../v2/core/foliage/glbLoader.js";

/** A float copy of an attribute (the GLBs' are quantised). */
function floatAttr(a) {
  const out = new Float32Array(a.count * a.itemSize);
  for (let i = 0; i < a.count; i++) for (let k = 0; k < a.itemSize; k++) out[i * a.itemSize + k] = a.getComponent(i, k);
  return new THREE.BufferAttribute(out, a.itemSize);
}

/**
 * Load a model of the pack and merge it to ONE skinned mesh on one skeleton,
 * every piece in the model's rest space, its material colour (or the
 * override `colors[materialName]`) baked into the vertices.
 * Returns { root, source, clips }.
 */
export async function loadAnimal(url, colors = {}) {
  const gltf = await getSharedGltfLoader().loadAsync(url);
  const root = gltf.scene;
  root.updateMatrixWorld(true);
  const skinned = [], rigid = [];
  root.traverse((o) => {
    if (o.isSkinnedMesh) skinned.push(o);
    else if (o.isMesh) rigid.push(o);
  });
  const bones = skinned[0].skeleton.bones;
  const colorOf = (m) => new THREE.Color(colors[m.name] ?? `#${m.color.getHexString()}`);
  const geos = [];
  const v = new THREE.Vector3();
  const pack = (P, Nn, skinIndex, skinWeight, index, mat) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", P);
    g.setAttribute("normal", Nn);
    g.setAttribute("skinIndex", skinIndex);
    g.setAttribute("skinWeight", skinWeight);
    const c = colorOf(mat);
    g.setAttribute("color", new THREE.Float32BufferAttribute(new Float32Array(P.count * 3).map((_, i) => [c.r, c.g, c.b][i % 3]), 3));
    g.setIndex(index ? index.clone() : null);
    geos.push(g);
  };
  const place = (P, Nn, M) => {
    const nm = new THREE.Matrix3().getNormalMatrix(M);
    for (let i = 0; i < P.count; i++) {
      v.fromBufferAttribute(P, i).applyMatrix4(M); P.setXYZ(i, v.x, v.y, v.z);
      v.fromBufferAttribute(Nn, i).applyMatrix3(nm).normalize(); Nn.setXYZ(i, v.x, v.y, v.z);
    }
  };
  for (const p of skinned) {
    // Its rest space → the model's: bone at rest × its own inverse bind.
    const D = new THREE.Matrix4().multiplyMatrices(p.skeleton.bones[0].matrixWorld, p.skeleton.boneInverses[0]).multiply(p.bindMatrix);
    const P = floatAttr(p.geometry.attributes.position), Nn = floatAttr(p.geometry.attributes.normal);
    place(P, Nn, D);
    pack(P, Nn, floatAttr(p.geometry.attributes.skinIndex), floatAttr(p.geometry.attributes.skinWeight), p.geometry.index, p.material);
  }
  for (const r of rigid) {
    // A rigid piece on a bone (the stag's antlers on its Head): its world rest
    // placement, every vertex bound fully to that bone.
    let b = r.parent;
    while (b && !b.isBone) b = b.parent;
    const bi = Math.max(0, bones.indexOf(b));
    const P = floatAttr(r.geometry.attributes.position), Nn = floatAttr(r.geometry.attributes.normal);
    place(P, Nn, r.matrixWorld);
    const n = P.count;
    pack(P, Nn,
      new THREE.Float32BufferAttribute(new Float32Array(n * 4).map((_, i) => (i % 4 === 0 ? bi : 0)), 4),
      new THREE.Float32BufferAttribute(new Float32Array(n * 4).map((_, i) => (i % 4 === 0 ? 1 : 0)), 4),
      r.geometry.index, r.material);
  }
  const merged = mergeGeometries(geos, false);
  if (!merged) throw new Error(`wildAnimals: merge failed for ${url}`);
  merged.computeBoundingSphere();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 });
  const mesh = new THREE.SkinnedMesh(merged, mat);
  for (const o of [...skinned, ...rigid]) o.parent?.remove(o);
  root.add(mesh);
  mesh.bind(new THREE.Skeleton(bones), new THREE.Matrix4());
  return { root, source: mesh, clips: gltf.animations };
}

// The herd behaviour (graze, wander, bolt from soldiers, one GPU crowd draw per
// kind) is shared machinery now — alg-rts's goats and sheep use it too.
export { createWildHerd } from "../shared-rts/wildHerd.js";
