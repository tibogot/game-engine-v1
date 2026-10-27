/**
 * ── A MESH DRAWN `count` TIMES KEEPS ONE NODE BUILD WHATEVER ITS COUNT ───────────────────────────
 *
 * three keys a render object's node build on the object's uuid as soon as `object.count > 1`
 * (RenderObject.getMaterialCacheKey: `if (object.isInstancedMesh || object.count > 1)`). For a plain
 * Mesh drawn with instanceIndex (r186 style: the crowds, the herds, the scatter batches) the count
 * goes 0 → 1 → 2+ and back as things come into view, and every crossing of 1 changed the key: the
 * render object was disposed and its shader BUILT AGAIN — MEASURED alg 2026-10-27: a herd's count
 * flipped 1 ↔ 3 eight times = 8 full node builds (~25 ms of main thread each), in play, again and again;
 * the herds' and a small crowd's shadow builds showed up on every camera tour.
 *
 * For a plain Mesh the count changes nothing in the shader (three reads it only for a morph texture
 * and the RangeNode, neither used here — both keep three's key), so the key sees count as 1. Meshes
 * that do differ still differ: their materials' node graphs (each crowd's own buffers) key by identity.
 * InstancedMesh keeps three's rule (sharedInstanceBuilds.js shares those its own way).
 *
 * Installed once per page through the first render object (RenderObject is not exported).
 */
const AS_ONE = { get(t, p) { return p === "count" ? 1 : Reflect.get(t, p, t); } };

export function installCountStableKeys(renderer) {
  const objects = renderer._objects;
  if (!objects || objects._v3CountStable) return false;
  objects._v3CountStable = true;
  const create = objects.createRenderObject;
  objects.createRenderObject = function (...args) {
    const ro = create.apply(this, args);
    const P = Object.getPrototypeOf(ro);
    if (!P._v3CountStable) {
      P._v3CountStable = true;
      const getMaterialCacheKey = P.getMaterialCacheKey;
      P.getMaterialCacheKey = function () {
        const o = this.object;
        if (!(o?.isMesh === true && o.count > 1 && !o.isInstancedMesh && !o.isBatchedMesh && o.morphTexture == null)) {
          return getMaterialCacheKey.call(this);
        }
        this.object = new Proxy(o, AS_ONE);
        try { return getMaterialCacheKey.call(this); } finally { this.object = o; }
      };
      ro.initialCacheKey = ro.getCacheKey();   // made before the patch
    }
    return ro;
  };
  return true;
}
