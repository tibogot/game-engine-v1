import * as THREE from "three";

/**
 * ── ONE NODE BUILD FOR A FAMILY OF INSTANCED MESHES ──────────────────────────
 *
 * three r184 keys every InstancedMesh's node build on its uuid
 * (RenderObject.getMaterialCacheKey: `if (object.isInstancedMesh || …)
 * cacheKey += object.uuid`), so N instanced meshes on ONE material build the
 * same node graph N times, and again for every pass. MEASURED 2026-10-03,
 * nam-rts boot: 728 builds for 199 distinct shaders, 13.3 s of the ~35 s boot
 * in getForRender — the 60 rock types alone 240 builds of one shader.
 *
 * Why three keys on the uuid: the build captures the mesh's InstanceNode, and
 * the node's vertex attributes hold THAT mesh's matrix buffer; a second mesh
 * sharing the build would draw the first one's matrices.
 *
 * What this does (only with the matrices on the vertex-attribute path —
 * main.js's opts.instanceAttributes, uniform-buffer limit 0 — where the shader
 * text no longer depends on the mesh):
 *   1. the key drops the uuid for a plain InstancedMesh (no instance colours,
 *      no morphs, no storage matrices) — everything else in it stays;
 *   2. a mesh drawn with a build another mesh made gets ITS OWN matrix buffer
 *      in place of the builder's (the render object's attribute list, patched
 *      once when three makes it);
 *   3. that buffer follows instanceMatrix.version before each draw — three's
 *      InstanceNode.update did it for the builder's mesh only. Same rule as
 *      main.js's patch: a caller's update ranges win, else only the instances
 *      drawn (mesh.count) go up.
 *   4. a draw whose matrices CHANGED is refreshed. three refreshes a draw (runs
 *      updateBefore and the uploads) once per render through the BUILD's observer
 *      (RenderObject.getMonitor → getNodeBuilderState().observer) — shared too, so
 *      only the first mesh of a build drawn in a frame got it; the others were
 *      judged by equals(), which never looks at the instance matrices. FOUND
 *      2026-10-07 (alg-rts, you: "some soldiers' gun and backpack stay in place"):
 *      the kit's 60 meshes on two materials, all but the first frozen where they
 *      were first drawn — their buffers at version 1 while the matrices were at 539.
 * The builder's own mesh keeps three's path unchanged.
 */

const OWN = new WeakMap();   // mesh → { im, buf, attrs: Map(offset → attribute) }
let _warned = false;

/** A mesh whose build can be shared: its shader text depends on nothing of its own. */
function shareable(o) {
  return o.isInstancedMesh === true && o.isBatchedMesh !== true
    && o.instanceColor == null
    && !Array.isArray(o.morphTargetInfluences)
    && o.instanceMatrix?.itemSize === 16
    && o.instanceMatrix.isStorageInstancedBufferAttribute !== true
    && o.userData?.ownBuild !== true;
}

// Seen through this, the mesh's uuid is a class tag: the rest of three's key
// (geometry layout, material, shadows, context) is read as it is.
const AS_CLASS = {
  get(t, p) { return p === "uuid" ? "shared-instanced" : Reflect.get(t, p, t); },
};

function ownAttribute(o, shared) {
  const im = o.instanceMatrix;
  let own = OWN.get(o);
  if (!own || own.im !== im) {
    const buf = new THREE.InstancedInterleavedBuffer(im.array, 16, 1);
    buf.setUsage(shared.data.usage);
    buf.version = im.version;          // created from the array as it is now
    own = { im, buf, attrs: new Map() };
    OWN.set(o, own);
  }
  let a = own.attrs.get(shared.offset);
  if (!a) {
    a = new THREE.InterleavedBufferAttribute(own.buf, shared.itemSize, shared.offset, shared.normalized);
    a.isInstancedBufferAttribute = shared.isInstancedBufferAttribute;
    own.attrs.set(shared.offset, a);
  }
  return a;
}

function syncOwn(o) {
  const own = OWN.get(o);
  if (!own) return;
  const im = o.instanceMatrix;
  if (im !== own.im) {
    // three's own InstanceNode has the same limit (it captures the attribute).
    if (!_warned) { _warned = true; console.error("[V3] sharedInstanceBuilds: instanceMatrix replaced after first draw — not followed", o); }
    return;
  }
  const buf = own.buf;
  if (im.version === buf.version) return;
  buf.clearUpdateRanges();
  if (im.updateRanges.length) {
    for (const r of im.updateRanges) buf.addUpdateRange(r.start, r.count);
  } else {
    const n = Math.min(im.count, Math.max(1, o.count));
    if (n < im.count) buf.addUpdateRange(0, n * 16);
  }
  buf.version = im.version;
}

function patchPrototype(P) {
  if (P._v3SharedInstanceBuilds) return;
  P._v3SharedInstanceBuilds = true;

  const getMaterialCacheKey = P.getMaterialCacheKey;
  P.getMaterialCacheKey = function () {
    const o = this.object;
    if (!shareable(o)) return getMaterialCacheKey.call(this);
    this.object = new Proxy(o, AS_CLASS);
    try { return getMaterialCacheKey.call(this); } finally { this.object = o; }
  };

  const getAttributes = P.getAttributes;
  P.getAttributes = function () {
    const attrs = getAttributes.call(this);
    if (this._v3OwnFor === attrs) return attrs;
    this._v3OwnFor = attrs;
    const o = this.object;
    if (!shareable(o)) return attrs;
    const inode = this.getNodeBuilderState().updateNodes.find((n) => n instanceof THREE.InstanceNode);
    if (!inode || inode.buffer == null || inode.instanceMatrix === o.instanceMatrix) return attrs;   // its own build
    let swapped = false;
    for (let i = 0; i < attrs.length; i++) {
      const a = attrs[i];
      if (a.isInterleavedBufferAttribute && a.data === inode.buffer) { attrs[i] = ownAttribute(o, a); swapped = true; }
    }
    if (swapped) {
      this.vertexBuffers = [...new Set(attrs.map((a) => (a.isInterleavedBufferAttribute ? a.data : a)))];
    }
    return attrs;
  };
}

/**
 * Install on a renderer whose instance matrices go by vertex attributes
 * (capabilities.getUniformBufferLimit() === 0). Patches three's RenderObject
 * class (not exported: reached through the first one made) — once per page.
 */
export function installSharedInstanceBuilds(renderer) {
  const objects = renderer._objects, nodes = renderer._nodes;
  if (!objects || !nodes || objects._v3Shared) return false;
  objects._v3Shared = true;

  const create = objects.createRenderObject;
  objects.createRenderObject = function (...args) {
    const ro = create.apply(this, args);
    const P = Object.getPrototypeOf(ro);
    if (!P._v3SharedInstanceBuilds) {
      patchPrototype(P);
      ro.initialCacheKey = ro.getCacheKey();   // made before the patch; nothing built yet
    }
    return ro;
  };

  // A shared-build draw whose matrices moved since ITS last refresh is refreshed
  // (4. above) — the builder's too: whichever mesh of a build is drawn first takes
  // three's once-a-frame refresh, and it need not be the builder.
  const seen = new WeakMap();   // render object → instanceMatrix.version at its last refresh
  const needsRefresh = nodes.needsRefresh;
  nodes.needsRefresh = function (renderObject, ...rest) {
    const o = renderObject.object;
    if (o?.isInstancedMesh === true && shareable(o)) {
      const v = o.instanceMatrix.version;
      if (seen.get(renderObject) !== v) {
        seen.set(renderObject, v);
        needsRefresh.call(this, renderObject, ...rest);   // keep three's observer bookkeeping
        return true;
      }
    }
    return needsRefresh.call(this, renderObject, ...rest);
  };

  // Before the draw's attribute uploads (Renderer._renderObjectDirect calls
  // updateBefore, then the geometry update) — no frame of lag.
  const updateBefore = nodes.updateBefore;
  nodes.updateBefore = function (renderObject) {
    syncOwn(renderObject.object);
    return updateBefore.call(this, renderObject);
  };
  return true;
}
