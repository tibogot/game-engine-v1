/**
 * ── EMPTY INSTANCED DRAWS SKIPPED ─────────────────────────────────────────────
 *
 * An InstancedMesh with `count` 0, or an InstancedBufferGeometry with `instanceCount` 0, draws
 * nothing — but three still runs its whole per-object path for it, in every pass: bindings,
 * node updates, attribute checks, the draw call. The games keep such meshes around on purpose
 * (pools that fill in play: wrecks, rubble, order marks, decal and ring fields), so most frames
 * have dozens. MEASURED alg-rts 2026-10-07, default view: ~45 empty render objects a frame
 * (main + shadow) = 3.69 → 3.21 ms of draw submission when hidden.
 *
 * Renderer.renderObject is where both the main pass and a shadow map's renderObjectFunction end
 * up; it returns at once for an empty one. NOT skipped: an INDIRECT draw (its count lives on the
 * GPU — the plant fields), anything else. The pipeline warm-up sets empties to count 1 while it
 * compiles (games/shared-rts/pipelineWarmup.js), so a skipped mesh is still built at boot.
 *
 * opts.emptyDrawSkip === false or ?emptyskip=0 = three's own behaviour, to A/B; in a live page,
 * renderer._v3EmptySkipOff = true.
 */
export function installEmptyDrawSkip(renderer) {
  if (!renderer || renderer._v3EmptyDrawSkip) return false;
  const renderObject = renderer.renderObject;
  if (typeof renderObject !== "function") return false;
  renderer._v3EmptyDrawSkip = true;
  renderer.renderObject = function (object, scene, camera, geometry, material, group, lightsNode, clippingContext, passId) {
    if (this._v3EmptySkipOff === true) {
      // (a live switch for A/B in one page)
    } else if (object.isInstancedMesh === true) {
      if (object.count === 0) return;
    } else if (geometry?.isInstancedBufferGeometry === true && geometry.instanceCount === 0 && !geometry.indirect) {
      return;
    }
    return renderObject.call(this, object, scene, camera, geometry, material, group, lightsNode, clippingContext, passId);
  };
  return true;
}
