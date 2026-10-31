/**
 * ── A CHANGED INSTANCE BUFFER UPLOADS ONLY THE INSTANCES DRAWN ──────────────────────────────────
 *
 * three uploads an instanced mesh's whole matrix buffer whenever it changes — its CAPACITY, not the
 * instances drawn. The soldiers' kit pieces have room for 640 and sent all 40 KB each frame for a
 * dozen men. Here a changed buffer with no update ranges of its own gets one: the first `mesh.count`
 * instances. A caller's own ranges win.
 *
 * r187 draws every instanced mesh from its OWN instanceMatrix, read per object (the reference
 * attributes behind three's shared instanced builds — what our sharedInstanceBuilds.js did by hand
 * on r184 / r186, retired with it) and uploads it with its update ranges. So the range goes on the
 * instanceMatrix itself, in nodes.updateBefore — before the draw's attribute uploads (Renderer
 * runs updateBefore, then the geometry update), and only when an upload is due (its version moved),
 * for draws that read it as vertex data (not three's uniform-buffer fallback, which ignores ranges).
 *
 * Install once per page (main.js, with opts.instanceAttributes). Retest at every three upgrade
 * (v3/THREE_UPGRADES.md).
 */
const _uploaded = new WeakMap();   // instanceMatrix → the version last given a drawn range

export function installDrawnRangeUploads(renderer) {
  const nodes = renderer._nodes;
  if (!nodes || nodes._v3DrawnRange) return false;
  nodes._v3DrawnRange = true;
  const updateBefore = nodes.updateBefore;
  nodes.updateBefore = function (renderObject) {
    const o = renderObject.object;
    const im = o?.isInstancedMesh === true ? o.instanceMatrix : null;
    if (im && im.isStorageInstancedBufferAttribute !== true && _uploaded.get(im) !== im.version) {
      _uploaded.set(im, im.version);
      if (im.updateRanges.length === 0 && o.count < im.count && drawsFrom(renderObject, im)) {
        im.addUpdateRange(0, Math.max(1, o.count) * 16);
      }
    }
    return updateBefore.call(this, renderObject);
  };
  return true;
}

/** The draw reads `im` as vertex data (three's matrix columns are views of it). */
function drawsFrom(renderObject, im) {
  for (const a of renderObject.getAttributes()) {
    if ((a.isInterleavedBufferAttribute ? a.data : a) === im) return true;
  }
  return false;
}
