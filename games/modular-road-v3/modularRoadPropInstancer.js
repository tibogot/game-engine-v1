// ============================================================================
// PHYSICS-PROP INSTANCER — every cone on the track in a couple of draws.
//
// Static props are handled by merging (see buildMergedProps in roadGame.js), and
// merging is off the table here for the obvious reason: a cone that gets punted
// has to MOVE, and a merged mesh has its transforms baked into vertices.
//
// Instancing is the version of the same trade that keeps the movement. One
// geometry, one material, N matrices — and the matrices are exactly what the sim
// already produces every tick, so the per-frame cost is a matrix copy per cone
// rather than a draw call per mesh per cone.
//
// WHY IT WAS WORTH DOING. Measured in the running page, 20 props, drive mode:
//
//     pole        0.4 draws each   (static -> merged)
//     billboard   0.6             (static -> merged)
//     cone       12.65            (simulated -> neither)
//
// The cone was quietly the most expensive thing on the track — four meshes each,
// doubled by the shadow pass — and cones are the one prop you place by the
// dozen. After this it is a fixed handful of draws for any number of them.
//
// The loose per-prop objects are NOT thrown away, only hidden: build mode still
// needs something real for the gizmo to grab and for right-click picking, and
// the sim still writes each prop's root transform, which is what gets read here.
// ============================================================================
import * as THREE from "three";
import { mergeByMaterial } from "./modularRoadBatching.js";

/** Growth headroom so placing one more cone does not rebuild every buffer. */
const SLACK = 8;

export class PropInstancer {
  /**
   * @param {THREE.Scene} scene
   * @param {import("./modularRoadProps.js").PropManager} props
   * @param {object[]} catalog PROP_CATALOG
   * @param {(id: string) => boolean} isInstanceable which ids to take over
   */
  constructor(scene, props, catalog, isInstanceable) {
    this.props = props;
    this.catalog = catalog;
    this.isInstanceable = isInstanceable;
    this.group = new THREE.Group();
    this.group.name = "ModularRoadPropsInstanced";
    this.group.visible = false;
    scene.add(this.group);

    /** id -> [{ geometry, material, castShadow }] — built once per type. */
    this._templates = new Map();
    /** id -> { insts, meshes } */
    this._batches = new Map();
    this._enabled = false;
    this._lastCount = -1;
    this._m4 = new THREE.Matrix4();
  }

  /**
   * The shared geometry for one prop type: build it once, merge it down, and
   * keep the pieces. Merging first matters as much as instancing — a cone is
   * four meshes, so without it this would be four InstancedMeshes instead of the
   * two its materials actually need.
   */
  _template(id) {
    if (this._templates.has(id)) return this._templates.get(id);
    const def = this.catalog.find((d) => d.id === id);
    let parts = null;
    if (def) {
      const root = def.make();
      root.updateMatrixWorld(true);
      mergeByMaterial(root); // geometry comes back in ROOT-local space
      parts = [];
      root.traverse((o) => {
        if (!o.isMesh || !o.geometry || o.userData.noRender) return;
        // Anything still carrying a local transform gets it baked in, so the
        // instance matrix is exactly the prop root's world matrix and nothing
        // downstream has to remember a per-part offset.
        const g = o.geometry.clone();
        o.updateWorldMatrix(true, false);
        g.applyMatrix4(this._m4.multiplyMatrices(
          root.matrixWorld.clone().invert(), o.matrixWorld,
        ));
        parts.push({ geometry: g, material: o.material, castShadow: o.castShadow });
      });
      // The template tree itself is scaffolding; only the parts are kept.
      root.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
    }
    this._templates.set(id, parts);
    return parts;
  }

  /**
   * Rebuild the batches from the CURRENT prop set. Cheap enough to call on any
   * add/delete/track load — the per-type templates survive, so this only resizes
   * instance buffers.
   */
  sync() {
    this._lastCount = this.props.instances?.length ?? 0;
    const wanted = new Map();
    for (const inst of this.props.instances ?? []) {
      if (!this.isInstanceable(inst.id)) continue;
      if (!wanted.has(inst.id)) wanted.set(inst.id, []);
      wanted.get(inst.id).push(inst);
    }

    // Drop batches for types that no longer have any props.
    for (const [id, batch] of [...this._batches]) {
      if (wanted.has(id)) continue;
      for (const m of batch.meshes) this.group.remove(m);
      this._batches.delete(id);
    }

    for (const [id, insts] of wanted) {
      const parts = this._template(id);
      if (!parts?.length) continue;
      let batch = this._batches.get(id);
      // Reuse while the buffers are still big enough — an InstancedMesh's count
      // can be lowered for free, only growing needs new buffers.
      if (batch && batch.capacity >= insts.length && batch.meshes.length === parts.length) {
        batch.insts = insts;
        for (const m of batch.meshes) m.count = insts.length;
        continue;
      }
      if (batch) for (const m of batch.meshes) this.group.remove(m);
      const capacity = insts.length + SLACK;
      const meshes = parts.map((p) => {
        const im = new THREE.InstancedMesh(p.geometry, p.material, capacity);
        im.instanceMatrix.setUsage(THREE.DynamicDrawUsage); // rewritten every frame
        im.castShadow = p.castShadow;
        im.receiveShadow = false;
        im.count = insts.length;
        // A knocked cone can end up anywhere; culling the whole batch on a
        // bounding box computed from wherever they started would pop them out.
        im.frustumCulled = false;
        this.group.add(im);
        return im;
      });
      this._batches.set(id, { insts, meshes, capacity });
    }
    if (this._enabled) this.update();
  }

  /** Per frame, after the sim has posed the props. */
  update() {
    if (!this._enabled) return;
    // SELF-HEAL, for the same reason PropPhysics has one: PropManager owns its
    // own Delete key, so there is no single choke point a caller can hook to
    // know the set changed. An O(1) length check beats a cone that has been
    // deleted still being drawn — or worse, an index past the end of a batch.
    const n = this.props.instances?.length ?? 0;
    if (n !== this._lastCount) { this._lastCount = n; this.sync(); }
    for (const { insts, meshes } of this._batches.values()) {
      for (let i = 0; i < insts.length; i++) {
        const root = insts[i].root;
        root.updateWorldMatrix(false, false);
        for (const m of meshes) m.setMatrixAt(i, root.matrixWorld);
      }
      for (const m of meshes) m.instanceMatrix.needsUpdate = true;
    }
  }

  /**
   * Take over rendering (drive) or hand it back (build).
   *
   * Hiding the loose roots rather than removing them keeps every editor
   * behaviour that walks `props.instances` — picking, the gizmo, deletion —
   * working on exactly the objects it always did.
   */
  setEnabled(on) {
    this._enabled = !!on;
    this.group.visible = this._enabled;
    for (const inst of this.props.instances ?? []) {
      if (!this.isInstanceable(inst.id)) continue;
      inst.root.visible = !this._enabled;
    }
    if (this._enabled) { this.sync(); this.update(); }
  }

  /** Draw calls this is currently responsible for — for the stats readout. */
  get drawCount() {
    let n = 0;
    for (const b of this._batches.values()) n += b.meshes.length;
    return n;
  }

  dispose() {
    for (const batch of this._batches.values()) {
      for (const m of batch.meshes) this.group.remove(m);
    }
    this._batches.clear();
    for (const parts of this._templates.values()) {
      for (const p of parts ?? []) p.geometry.dispose();
    }
    this._templates.clear();
  }
}
