import * as THREE from "three";

/**
 * ── INSTANCE MATRICES ONE FRAME LATE (three r184) ────────────────────────────
 *
 * Renderer._renderObjectDirect runs, per draw:
 *
 *     nodes.updateBefore(ro) → geometries.updateForRender(ro) → nodes.updateForRender(ro) → draw
 *
 * The instanced matrix buffer is uploaded in the GEOMETRY step, when its
 * version moved — but InstanceNode.update(), which copies
 * instanceMatrix.version (and its update ranges) onto that buffer, is a node
 * update and runs in the step AFTER. So a changed instanceMatrix is uploaded on
 * the NEXT draw of that mesh, while `mesh.count` (read at the draw) is already
 * the new one. A mesh drawn once a frame shows last frame's matrices for one
 * frame.
 *
 * Harmless while matrices only move a little. Fatal for a prop instancer that
 * re-packs its lists every frame (v3/tools/propInstancer.js): when a rock
 * changes detail level or the cull lets one in or out, every later slot shifts,
 * and for one frame each slot draws the matrix of whichever rock held it
 * before — a rock flashing up somewhere else. Found in the rock lab
 * (2026-10-04): "the big stones flicker, for an instant it shows another cliff
 * at another position"; turning the rock LOD off stopped it.
 *
 * The fix: run the InstanceNode's own update in updateBefore, i.e. before the
 * geometry upload. It is idempotent (it copies the version and ranges), so
 * three running it again afterwards changes nothing.
 */
const INODE = Symbol("v3InstanceNode");

export function installInstanceMatrixSync(renderer) {
  const nodes = renderer?._nodes;
  if (!nodes || nodes._v3InstanceSync) return false;
  nodes._v3InstanceSync = true;
  const updateBefore = nodes.updateBefore;
  nodes.updateBefore = function (renderObject) {
    const o = renderObject.object;
    if (o?.isInstancedMesh === true) {
      let inode = renderObject[INODE];
      if (inode === undefined) {
        inode = renderObject.getNodeBuilderState?.().updateNodes.find((n) => n instanceof THREE.InstanceNode) ?? null;
        renderObject[INODE] = inode;
      }
      if (inode && inode.instanceMatrix === o.instanceMatrix) inode.update(null);
    }
    return updateBefore.call(this, renderObject);
  };
  return true;
}
