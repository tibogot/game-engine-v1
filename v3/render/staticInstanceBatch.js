/**
 * ── STATIC INSTANCED MESHES, BATCHED ──────────────────────────────────────────
 *
 * A game's static props are many InstancedMeshes on ONE material — alg-rts: the field walls, the
 * outcrops, the village props, the telegraph poles, the supply depots (17 meshes on the kit's
 * atlas material), the loose stones (9 on theirs). Each is a render object in every pass, and a
 * render object is three's expensive unit on the CPU (bindings, node updates, the draw: ~15 µs
 * each, measured), whatever it draws.
 *
 * This merges every group of them (same material, shadow flags, layers, render order and vertex
 * layout) into ONE InstancedMesh that issues one INDIRECT draw per member — the plant fields'
 * trick (scatterField._buildBatches), with instancing: the members' geometries end to end
 * (firstIndex / baseVertex, nothing renumbered), all their instances in one buffer in member
 * order, each draw starting at its member's `firstInstance` (WebGPU feature
 * "indirect-first-instance" — without it nothing is batched). Instance-rate attributes (alg's
 * stones carry `ground`) are joined the same way. A member's own world matrix is baked into its
 * instances, so the batch sits at the origin.
 *
 * For meshes that DO NOT CHANGE after the call: the members are hidden, not removed, and nothing
 * reads them back. A member whose matrices, count or material change later must stay out.
 * `restore()` shows them again and drops the batches (A/B).
 */
import * as THREE from "three";

const layoutOf = (g) => {
  if (!g.index || (g.morphAttributes && Object.keys(g.morphAttributes).length)) return null;
  const parts = [];
  for (const [n, a] of Object.entries(g.attributes)) {
    if (a.isInterleavedBufferAttribute) return null;
    parts.push(`${n}:${a.itemSize}:${a.array.constructor.name}:${a.normalized}:${a.isInstancedBufferAttribute ? "i" : "v"}`);
  }
  return parts.sort().join(",");
};

/**
 * @param {THREE.WebGPURenderer} renderer
 * @param {THREE.Object3D} root         where the batches go (the scene)
 * @param {THREE.InstancedMesh[]} meshes  the static candidates
 * @param {{ name?: string }} [o]
 * @returns {{ batches: THREE.InstancedMesh[], members: number, restore(): void }}
 */
export function batchStaticInstances(renderer, root, meshes, { name = "StaticBatch" } = {}) {
  const none = { batches: [], members: 0, restore() {} };
  const dev = renderer?.backend?.device;
  if (!dev?.features?.has?.("indirect-first-instance")) return none;

  const groups = new Map();
  for (const m of meshes) {
    if (!m?.isInstancedMesh || m.count === 0 || m.instanceColor || !m.visible) continue;
    const layout = layoutOf(m.geometry);
    if (layout === null || Array.isArray(m.material)) continue;
    const key = `${m.material.id}|${m.castShadow}|${m.receiveShadow}|${m.layers.mask}|${m.renderOrder}|${layout}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = []));
    g.push(m);
  }

  const batches = [], hidden = [];
  const mw = new THREE.Matrix4(), mi = new THREE.Matrix4();
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const first = list[0].geometry;
    let vTotal = 0, iTotal = 0, nTotal = 0;
    for (const m of list) { vTotal += m.geometry.attributes.position.count; iTotal += m.geometry.index.count; nTotal += m.count; }

    const geometry = new THREE.BufferGeometry();
    for (const [an, a] of Object.entries(first.attributes)) {
      const inst = a.isInstancedBufferAttribute === true;
      const arr = new a.array.constructor((inst ? nTotal : vTotal) * a.itemSize);
      let o = 0;
      for (const m of list) {
        const b = m.geometry.attributes[an];
        const n = (inst ? m.count : b.count) * b.itemSize;
        arr.set(b.array.subarray(0, n), o);
        o += n;
      }
      geometry.setAttribute(an, inst
        ? new THREE.InstancedBufferAttribute(arr, a.itemSize, a.normalized)
        : new THREE.BufferAttribute(arr, a.itemSize, a.normalized));
    }
    const idx = new Uint32Array(iTotal);
    const indirect = new THREE.IndirectStorageBufferAttribute(new Uint32Array(list.length * 5), 5);
    const offsets = [];
    let io = 0, vo = 0, no = 0;
    const mesh = new THREE.InstancedMesh(geometry, list[0].material, nTotal);
    list.forEach((m, k) => {
      const g = m.geometry;
      idx.set(g.index.array.subarray(0, g.index.count), io);
      indirect.array.set([g.index.count, m.count, io, vo, no], k * 5);
      offsets.push(k * 5 * 4);
      // The member's own placement baked into its instances.
      m.updateWorldMatrix(true, false);
      mw.copy(m.matrixWorld);
      for (let i = 0; i < m.count; i++) {
        m.getMatrixAt(i, mi);
        mesh.setMatrixAt(no + i, mi.premultiply(mw));
      }
      io += g.index.count; vo += g.attributes.position.count; no += m.count;
    });
    geometry.setIndex(new THREE.BufferAttribute(idx, 1));
    geometry.setIndirect(indirect, offsets);
    mesh.name = `${name}:${list[0].material.name || list[0].material.type}(${list.length})`;
    mesh.frustumCulled = false;   // members span the map; their own bounds culled nothing either
    mesh.castShadow = list[0].castShadow;
    mesh.receiveShadow = list[0].receiveShadow;
    mesh.layers.mask = list[0].layers.mask;
    mesh.renderOrder = list[0].renderOrder;
    mesh.userData.batchMembers = list;
    mesh.instanceMatrix.needsUpdate = true;
    root.add(mesh);
    batches.push(mesh);
    for (const m of list) { m.visible = false; hidden.push(m); }
  }

  return {
    batches,
    members: hidden.length,
    restore() {
      for (const b of batches) { root.remove(b); b.geometry.dispose(); }
      for (const m of hidden) m.visible = true;
      batches.length = 0; hidden.length = 0;
    },
  };
}
