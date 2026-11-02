// The road's collision tree built OFF THE MAIN THREAD (modularRoadBvh.js bakeFromMeshesAsync): the merged geometry's
// position + index in, the MeshBVH built with the defaults (as the sync bake builds it), its roots and its reordered
// index back.
import { BufferGeometry, BufferAttribute } from "three";
import { MeshBVH } from "three-mesh-bvh";

self.onmessage = ({ data }) => {
  const { id, position, index } = data;
  try {
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(position, 3));
    g.setIndex(new BufferAttribute(index, 1));
    const bvh = new MeshBVH(g);
    const s = MeshBVH.serialize(bvh, { cloneBuffers: false });
    self.postMessage({ id, roots: s.roots, index: s.index }, [...s.roots, s.index.buffer]);
  } catch (e) {
    self.postMessage({ id, error: String(e?.stack ?? e) });
  }
};
