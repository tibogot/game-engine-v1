// ============================================================================
// BATCHING — the three moves that turn a tree of little meshes into few draws.
//
// Shared because the same three kept being needed in different places and
// getting subtly different answers: roadside scenery, the drive-mode prop merge,
// and the physics-prop instancer.
//
//   materialKey       group by what a material RENDERS as, not its identity
//   flattenInstanced  undo instancing that is costing more than it saves
//   mergeByMaterial   collapse a rigid tree to one mesh per material
//
// None of this applies to anything that moves independently. A merged mesh bakes
// world (or root-local) transforms into vertices, so the pieces inside it can
// never move relative to each other again. That is the whole trade.
// ============================================================================
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

/**
 * Merge key for a material — a SIGNATURE, not its identity.
 *
 * Identity is the obvious key and it merges almost nothing: every prop's make()
 * builds its own materials, so twenty poles are twenty distinct
 * MeshStandardNodeMaterial objects that happen to be identical. Measured in the
 * page, that left poles at 8.0 draws each in drive mode while billboards — which
 * DO share materials by reference — collapsed to 0.8. Keying on what the
 * material actually renders as fixes every prop at once, with no catalog change.
 *
 * Materials carrying a custom shader graph fall back to identity: two of those
 * can agree on every plain property and still render nothing alike, and a
 * signature has no way to see the difference. `colorNode` is included BY NODE
 * IDENTITY rather than excepted, so the standard `materialColor` (a shared
 * singleton) groups while anything bespoke separates itself.
 *
 * `userData.batchKey` is the escape hatch from that fallback, and it is needed:
 * the identity rule is correct in principle and defeats merging entirely for the
 * props that glow, because v3's selective bloom puts an `mrtNode` on every one of
 * them. Measured — twenty glow rings merged into twenty meshes, i.e. not at all,
 * at 80 draws. A material sets `batchKey` to assert "my shader graph is fully
 * determined by my plain properties plus this tag", which is true of a bloom
 * treatment applied uniformly (see applyPropBloom) and false of anything with
 * its own per-instance uniforms (the LED panel's board dimensions).
 */
export function materialKey(m) {
  if (!m) return "-";
  const custom = m.fragmentNode || m.outputNode || m.positionNode || m.mrtNode;
  if (custom && !m.userData?.batchKey) return m.uuid;
  return [
    m.userData?.batchKey ?? "-",
    m.type,
    m.colorNode?.uuid ?? "-",
    m.color?.getHexString() ?? "-",
    m.roughness, m.metalness,
    m.emissive?.getHexString() ?? "-", m.emissiveIntensity,
    m.map?.uuid ?? "-",
    m.side, m.transparent, m.opacity, m.depthWrite,
  ].join("|");
}

/**
 * Expand quantized vertex attributes to plain float ones.
 *
 * MUST run before any matrix is applied to geometry that came out of a
 * KHR_mesh_quantization glTF (which is most compressed exports —
 * glTF-Transform emits it by default alongside Draco). Those files store
 * positions as NORMALIZED Int16 with the real scale folded into the node
 * transform, and `BufferGeometry.applyMatrix4` writes its results straight back
 * into the underlying array: float values truncated into an Int16Array, which
 * silently mangles the mesh rather than failing. Symptom when it bit here: a
 * 6 m container came out 15 cm across and floating below the ground.
 *
 * It is also what lets quantized and unquantized geometry merge — mergeGeometries
 * refuses to mix attributes whose array types differ.
 */
export function dequantize(geometry) {
  for (const [name, attr] of Object.entries(geometry.attributes)) {
    if (!attr.normalized && attr.array instanceof Float32Array) continue;
    const out = new Float32Array(attr.count * attr.itemSize);
    const get = [
      (i) => attr.getX(i), (i) => attr.getY(i), (i) => attr.getZ(i), (i) => attr.getW(i),
    ];
    for (let i = 0; i < attr.count; i++) {
      for (let c = 0; c < attr.itemSize; c++) out[i * attr.itemSize + c] = get[c](i);
    }
    geometry.setAttribute(name, new THREE.BufferAttribute(out, attr.itemSize, false));
  }
  return geometry;
}

/**
 * Turn InstancedMeshes back into ordinary geometry.
 *
 * Counter-intuitive, and measured. The v2 object builders instance because in
 * the LAB they stamp a whole SPLINE RUN from one call — dozens of units, one
 * draw. Placed one at a time those InstancedMeshes carry a count of one (or
 * twelve, for a floodlight's lamp array) and buy nothing, while costing
 * something real: an InstancedMesh keeps its transforms in a buffer that
 * mergeByMaterial cannot bake, so it is skipped and stays its own draw forever.
 * Measured: the LED board and floodlight sat at 9.6 and 9.45 draws per placement
 * purely because of this, while everything mergeable was at 0.4–0.6.
 *
 * Cheap at these counts — a floodlight's twelve lamps are twelve small boxes.
 */
export function flattenInstanced(root) {
  const found = [];
  root.traverse((o) => { if (o.isInstancedMesh) found.push(o); });
  const m4 = new THREE.Matrix4();
  for (const im of found) {
    const geos = [];
    for (let i = 0; i < im.count; i++) {
      im.getMatrixAt(i, m4);
      const g = im.geometry.clone();
      g.applyMatrix4(m4);
      geos.push(g);
    }
    const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
    if (geos.length > 1) for (const g of geos) g.dispose();
    if (!merged) continue; // attribute mismatch: leave it instanced, still valid
    const mesh = new THREE.Mesh(merged, im.material);
    mesh.name = im.name || "flattened";
    mesh.castShadow = im.castShadow;
    mesh.receiveShadow = im.receiveShadow;
    mesh.position.copy(im.position);
    mesh.quaternion.copy(im.quaternion);
    mesh.scale.copy(im.scale);
    im.parent?.add(mesh);
    im.removeFromParent();
    im.geometry.dispose();
  }
}

/**
 * Collapse a rigid tree to ONE mesh per material, in the ROOT's local space.
 *
 * Root-local, not world: the result has to stay reusable wherever the root ends
 * up — as a prop you can still drag, or as the template an InstancedMesh is
 * built from. Baking world space would nail it to wherever it happened to be
 * standing when this ran.
 *
 * Merge failures are survivable by design. mergeGeometries returns null on any
 * attribute mismatch between its inputs, and a silently-missing mesh is a far
 * worse outcome than a few extra draws, so a group that will not merge keeps its
 * original meshes.
 *
 * @returns {number} meshes removed (0 if nothing merged)
 */
export function mergeByMaterial(root) {
  root.updateMatrixWorld(true);
  const rootInv = root.matrixWorld.clone().invert();

  /** key -> { material, meshes } */
  const groups = new Map();
  root.traverse((o) => {
    if (!o.isMesh || o.isInstancedMesh || !o.geometry || o.userData.noRender) return;
    const key = materialKey(o.material);
    if (!groups.has(key)) groups.set(key, { material: o.material, meshes: [] });
    groups.get(key).meshes.push(o);
  });

  let removed = 0;
  const m4 = new THREE.Matrix4();
  for (const { material, meshes } of groups.values()) {
    if (meshes.length < 2) continue;
    const keys = Object.keys(meshes[0].geometry.attributes).sort().join(",");
    if (!meshes.every((m) => Object.keys(m.geometry.attributes).sort().join(",") === keys)) continue;

    const geos = meshes.map((m) => {
      const g = m.geometry.clone();
      g.applyMatrix4(m4.multiplyMatrices(rootInv, m.matrixWorld));
      return g;
    });
    const merged = mergeGeometries(geos, false);
    for (const g of geos) g.dispose();
    if (!merged) continue;

    const mesh = new THREE.Mesh(merged, material);
    mesh.name = `${root.name || "merged"}_${meshes.length}`;
    mesh.castShadow = meshes.some((m) => m.castShadow);
    mesh.receiveShadow = meshes.some((m) => m.receiveShadow);
    // Carried across, or a merge would silently strip a part's livery flag. Safe
    // to take from the first: the group already shares one material, and
    // tintability is a property of the material.
    if (meshes[0].userData.tintable) mesh.userData.tintable = true;
    for (const m of meshes) {
      m.removeFromParent();
      m.geometry.dispose();
      removed++;
    }
    root.add(mesh);
    removed--; // the replacement is not a removal
  }

  // Unit groups can be left empty by the above; each still costs a matrix update.
  for (const child of [...root.children]) {
    if (child.isGroup && child.children.length === 0) child.removeFromParent();
  }
  return removed;
}
