// ── Horse lab: render optimisations shared by the levels ─────────────────────
// mergeStatic: every static level mesh that shares a material (and shadow
// flags) becomes ONE mesh — one draw, one shadow draw. The originals leave the
// scene but keep their (frozen) world matrices, so the horse's rays still test
// them exactly as before (they stay in the level's ground / blockers lists).
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

export function mergeStatic(scene, meshes) {
  const groups = new Map();
  for (const m of meshes) {
    if (!m.isMesh || m.isInstancedMesh || m.isSkinnedMesh || Array.isArray(m.material) || !m.parent) continue;
    // a material FAMILY (material.userData.family: flat colours that differ only in
    // colour) merges too — each mesh's colour baked into its vertices
    const key = `${m.material.userData.family ?? m.material.uuid}|${m.castShadow}|${m.receiveShadow}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }
  let before = 0, after = 0;
  for (const list of groups.values()) {
    before += list.length;
    if (list.length < 2) { after += list.length; continue; }
    // one attribute set for all (mergeGeometries returns null otherwise)
    const fam = list[0].material.userData.family;
    const bake = !!fam && new Set(list.map((m) => m.material)).size > 1;   // several colours: bake them
    const names = ["position", "normal", "uv", "color"].filter((n) => list.every((m) => m.geometry.getAttribute(n)) && !(bake && n === "color"));
    const geos = list.map((m) => {
      m.updateMatrixWorld(true);
      let g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
      const out = new THREE.BufferGeometry();
      for (const n of names) {
        const a = g.getAttribute(n);                      // to Float32 (a quantized attribute would break the stride)
        const f = new Float32Array(a.count * a.itemSize);
        for (let i = 0; i < a.count; i++) for (let k = 0; k < a.itemSize; k++) f[i * a.itemSize + k] = a.getComponent(i, k);
        out.setAttribute(n, new THREE.BufferAttribute(f, a.itemSize));
      }
      if (bake) {
        const c = m.material.userData.bakeColor ?? m.material.color, n = out.getAttribute("position").count, col = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
        out.setAttribute("color", new THREE.BufferAttribute(col, 3));
      }
      out.applyMatrix4(m.matrixWorld);
      return out;
    });
    const merged = mergeGeometries(geos);
    if (!merged) { after += list.length; continue; }
    merged.computeBoundingSphere();
    const mm = new THREE.Mesh(merged, bake ? list[0].material.userData.vertexColored() : list[0].material);
    mm.castShadow = list[0].castShadow; mm.receiveShadow = list[0].receiveShadow;
    mm.name = "merged";
    scene.add(mm);
    for (const m of list) m.removeFromParent();           // still a ray target (frozen matrixWorld)
    after += 1;
  }
  return { before, after };
}

// ── Characters ───────────────────────────────────────────────────────────────
// to Float32 (a quantized glTF attribute: Int16 normalized, a 6-byte stride
// WebGPU rejects once merged, and it cannot hold a transformed position)
function f32(a) {
  const f = new Float32Array(a.count * a.itemSize);
  for (let i = 0; i < a.count; i++) for (let k = 0; k < a.itemSize; k++) f[i * a.itemSize + k] = a.getComponent(i, k);
  return new THREE.BufferAttribute(f, a.itemSize);
}

/**
 * Every SkinnedMesh under `root` (one per material in the glTF) → ONE skinned
 * mesh, its colour baked per vertex from the old materials. They must share
 * their bones (a glTF gives each primitive its own Skeleton over the same
 * bones — each one packed and uploaded every frame). Returns { mesh, zones }:
 * zones[materialName] = [first vertex, count, Color] to recolour later
 * (setZoneColor). Returns null if there is nothing to merge.
 */
export function mergeSkinned(root, { roughness, metalness, flatShading = false } = {}) {   // (default: the first material's)
  const list = [];
  root.traverse((o) => { if (o.isSkinnedMesh) list.push(o); });
  if (list.length < 2) return null;
  const A = list[0], bones = A.skeleton.bones;
  if (!list.every((m) => m.skeleton.bones.length === bones.length && m.skeleton.bones.every((b, i) => b === bones[i]))) return null;
  root.updateMatrixWorld(true);
  const zones = {}, geos = [];
  let first = 0;
  const T = new THREE.Matrix4(), N = new THREE.Matrix3();
  for (const m of list) {
    const g0 = m.geometry, g = new THREE.BufferGeometry();
    // its geometry → A's bind space. Skinned (attached mode) a vertex lands at
    // bone × inverseBind × bind × v, so what can differ between parts is their
    // INVERSE BINDS: each glTF part has its own Skeleton, and a quantized part folds
    // its dequantization (scale + offset) into them — the horse's 8 parts do, and
    // ignoring it exploded parts 2–8. The fix is the same for every bone:
    //   v' = bindA⁻¹ · invBindA[i]⁻¹ · invBindM[i] · bindM · v
    // (bindA⁻¹ computed: in attached mode three overwrites bindMatrixInverse with
    //  the WORLD inverse every frame — using it collapsed the horse to a 36 cm blob)
    const bindAinv = A.bindMatrix.clone().invert();
    const bi = 0, iA = A.skeleton.boneInverses[bi], iM = m.skeleton.boneInverses[bi];
    T.copy(bindAinv).multiply(iA.clone().invert()).multiply(iM).multiply(m.bindMatrix);
    for (let k = 1; k < bones.length; k++) {                     // (check it is one transform for all bones)
      const Tk = new THREE.Matrix4().copy(bindAinv).multiply(A.skeleton.boneInverses[k].clone().invert()).multiply(m.skeleton.boneInverses[k]).multiply(m.bindMatrix);
      if (Tk.elements.some((e, j) => Math.abs(e - T.elements[j]) > 1e-3 * Math.max(1, Math.abs(e)))) { console.warn("[mergeSkinned] parts disagree per bone — not merging", m.name); return null; }
    }
    N.getNormalMatrix(T);
    g.setAttribute("position", f32(g0.attributes.position).applyMatrix4(T));
    g.setAttribute("normal", f32(g0.attributes.normal).applyNormalMatrix(N));
    g.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(Array.from({ length: g0.attributes.skinIndex.count * 4 }, (_, i) => g0.attributes.skinIndex.getComponent(i >> 2, i & 3)), 4));
    g.setAttribute("skinWeight", f32(g0.attributes.skinWeight));
    const n = g0.attributes.position.count, c = m.material.color ?? new THREE.Color(1, 1, 1), col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    g.setIndex(g0.index ? Array.from(g0.index.array) : Array.from({ length: n }, (_, i) => i));
    zones[m.material.name || `m${geos.length}`] = [first, n, c.clone()];
    first += n;
    geos.push(g);
  }
  const merged = mergeGeometries(geos);
  if (!merged) return null;
  // keep the FIRST part (its skeleton, bind and GPU skinning setup already work) and
  // give it the merged geometry: a new SkinnedMesh bound to the same skeleton
  // drew nothing on the horse (WebGPU), while the CPU skinning of it was right
  const mesh = A;
  A.geometry = merged;
  // TRAP (WebGPU): a source with QUANTIZED attributes (Int16 interleaved) leaves a
  // render pipeline whose vertex layout is reused for any later geometry drawn with
  // an equal material key — our Float32 copy then skins into spikes or nothing.
  // A material that differs in its program (flatShading for the flat-shaded horse)
  // gets its own pipeline.
  A.material = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading, roughness: roughness ?? A.material.roughness ?? 0.8, metalness: metalness ?? A.material.metalness ?? 0 });
  A.name = (A.name || "skin") + "_merged";
  for (const m of list) if (m !== A) m.removeFromParent();
  return { mesh, zones };
}

/** Recolour one zone of a merged character (e.g. the coat). */
export function setZoneColor(merged, name, color) {
  const z = merged?.zones[name];
  if (!z) return;
  const a = merged.mesh.geometry.attributes.color;
  for (let i = z[0]; i < z[0] + z[1]; i++) a.setXYZ(i, color.r, color.g, color.b);
  a.needsUpdate = true;
}

/**
 * Rigid meshes under `group` (all fixed relative to it: a saddle, a hat) →
 * ONE mesh in the group's space, colour per vertex. Keeps `group` as the
 * parent, so it still follows its bone.
 */
export function mergeRigid(group, { roughness = 0.85, flatShading = false, side = THREE.FrontSide } = {}) {
  const list = [];
  group.traverse((o) => { if (o.isMesh && !o.isSkinnedMesh && !o.isInstancedMesh) list.push(o); });
  if (list.length < 2) return null;
  group.updateMatrixWorld(true);
  const inv = group.matrixWorld.clone().invert(), M = new THREE.Matrix4(), N = new THREE.Matrix3();
  const geos = list.map((m) => {
    const g0 = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry, g = new THREE.BufferGeometry();
    M.copy(inv).multiply(m.matrixWorld); N.getNormalMatrix(M);
    g.setAttribute("position", f32(g0.attributes.position).applyMatrix4(M));
    if (!g0.attributes.normal) g0.computeVertexNormals();
    g.setAttribute("normal", f32(g0.attributes.normal).applyNormalMatrix(N));
    const n = g0.attributes.position.count, c = m.material.color, col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    return g;
  });
  const merged = mergeGeometries(geos);
  if (!merged) return null;
  merged.computeBoundingSphere();
  const mesh = new THREE.Mesh(merged, new THREE.MeshStandardMaterial({ vertexColors: true, roughness, flatShading, side }));
  mesh.castShadow = list.some((m) => m.castShadow); mesh.receiveShadow = true;
  mesh.name = "merged";
  for (const m of list) m.removeFromParent();
  group.add(mesh);
  return mesh;
}
