import * as THREE from "three";

/**
 * Collision for objects placed in SPLINE mode.
 *
 * Props get real-triangle collision because they live in the PropStore, which
 * SolidCollider reads (types → shared BVH, instances → transforms). Spline
 * objects live somewhere else entirely — `SplineSystem.linearFeatures`, each
 * with its own one-off world-space mesh — so nothing was colliding with them.
 *
 * Rather than duplicate SolidCollider's ray/capsule/sweep maths, this exposes
 * the linear features through a PROPSTORE-SHAPED VIEW. Feed it to a plain
 * `new SolidCollider(store)` and every query works unchanged:
 *
 *   store.gen                     — bumps only when the features actually change
 *   store.instances               — one per feature: { typeIdx }
 *   store.types[i]                — { solid, entries: [{geometry, localMatrix}] }
 *   store.computeInstanceMatrix() — the feature root's world matrix
 *
 * Why the BVH is cached on the mesh object: a feature's geometry is rebuilt
 * (new Group) whenever its spline is edited or re-synced to the ground, so
 * keying the type cache on the root object means an edit naturally invalidates
 * exactly one BVH, while merely MOVING a feature only changes its instance
 * matrix and reuses the BVH — same trick SolidCollider plays with props.
 *
 * `refresh()` is a cheap per-frame poll (a signature over feature count, mesh
 * identity and root transform). That beats hooking every edit path in the v2
 * SplineSystem, which is shared code and would be easy to miss a case in.
 */

/** Objects that should never block movement, by registry id. */
const NON_SOLID_OBJECT_IDS = new Set([
  // nothing yet — fences, wire, bridges, docks, lamps all block by design.
  // Add ids here (e.g. decals/markings) if they should be walk-through.
]);

const _inv = new THREE.Matrix4();

export function createSplineFeatureColliderStore(getFeatures) {
  /** @type {WeakMap<THREE.Object3D, object>} root mesh/group → collider "type" */
  const typeCache = new WeakMap();

  const store = {
    types: [],
    instances: [],
    _gen: 0,
    _sig: "",

    get gen() {
      return this._gen;
    },

    /** SolidCollider asks for each instance's world transform. */
    computeInstanceMatrix(inst) {
      return inst.matrix;
    },

    /**
     * Re-read the spline features. Cheap when nothing changed (string compare);
     * rebuilds the type/instance lists and bumps `gen` when something did.
     */
    refresh() {
      const features = getFeatures() || [];

      // Signature: what would change the collision world? A feature appearing or
      // disappearing, a mesh being rebuilt, or a feature being moved.
      let sig = "";
      for (const f of features) {
        const root = f?.mesh;
        if (!root) continue;
        if (f.kind === "object" && NON_SOLID_OBJECT_IDS.has(f.objectId)) continue;
        const e = root.matrixWorld.elements;
        sig += `${root.uuid}:${e[12].toFixed(2)},${e[13].toFixed(2)},${e[14].toFixed(2)}|`;
      }
      if (sig === this._sig) return false;
      this._sig = sig;

      this.types = [];
      this.instances = [];

      for (const f of features) {
        const root = f?.mesh;
        if (!root) continue;
        if (f.kind === "object" && NON_SOLID_OBJECT_IDS.has(f.objectId)) continue;

        root.updateMatrixWorld(true);

        let type = typeCache.get(root);
        if (!type) {
          // Collect every mesh under this feature, in the ROOT's local space, so
          // the BVH survives the feature being moved.
          const entries = [];
          _inv.copy(root.matrixWorld).invert();
          root.traverse((o) => {
            if (!o.isMesh || !o.geometry?.getAttribute("position")) return;
            const localMatrix = new THREE.Matrix4()
              .copy(_inv)
              .multiply(o.matrixWorld);
            entries.push({ geometry: o.geometry, localMatrix });
          });
          if (entries.length === 0) continue;
          type = { name: f.objectId || f.kind || "splineFeature", entries, solid: true };
          typeCache.set(root, type);
        }

        const typeIdx = this.types.length;
        this.types.push(type);
        this.instances.push({
          typeIdx,
          matrix: root.matrixWorld.clone(),
        });
      }

      this._gen++;
      return true;
    },
  };

  return store;
}
