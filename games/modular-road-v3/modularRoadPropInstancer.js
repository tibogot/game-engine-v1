// ============================================================================
// PROP INSTANCER — every prop on the track in a fixed handful of draws, in BOTH
// modes.
//
// One geometry and one material per prop type, N matrices. The matrices are the
// prop roots' own world transforms, which the editor writes when you drag
// something and the sim writes when a cone gets punted — so the same mechanism
// covers static scenery and simulated props without caring which is which.
//
// WHY NOT JUST MERGE. Merging (one baked mesh per material, see the road pieces
// in roadGame.js) collapses further — every prop type sharing a material becomes
// a single draw — and it is genuinely better for geometry that never changes.
// It is the wrong tool here for two reasons:
//
//   • A merged mesh has its transforms baked into vertices, so nothing inside it
//     can move. Cones and gates are out immediately.
//   • Every edit invalidates the whole bake. Moving one prop of a hundred means
//     re-merging all hundred, and the editor is where you move props constantly.
//     Instancing writes one matrix.
//
// So merging only ever paid off in drive mode, and that left the EDITOR scaling
// linearly — measured, 100 poles cost 648 draws while building and 58 driving.
// Which is the wrong way round: the editor is where a track gets big.
//
// The loose per-prop objects are NOT thrown away, only hidden. three's Raycaster
// tests `layers`, not `visible` (Raycaster.js — `object.layers.test(...)` then
// `object.raycast(...)`, no visibility check), so picking and the gizmo keep
// working on exactly the objects they always did.
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
      // HIDE HERE, not only in setEnabled. Props placed AFTER the instancer was
      // switched on would otherwise stay visible and also get an instance — drawn
      // twice, which reads as the optimisation doing nothing at all (measured:
      // 200 poles at 1152 draws, slightly WORSE than before instancing).
      inst.root.visible = !this._enabled;
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

  /**
   * Throw away the cached templates for these types so the next sync rebuilds
   * them from the catalog.
   *
   * Needed because a template is a SNAPSHOT: it holds its own copies of the
   * materials `make()` produced, so anything that live-tunes a prop's look (the
   * dev panel's glow colour and intensity) writes to the loose roots — which are
   * only what the gizmo and picking act on — and never reaches what is drawn.
   * Rebuilding is one `make()` per type, which for a glow box is a single
   * BoxGeometry, so this is cheap enough to run on a slider drag.
   */
  refreshTemplates(ids) {
    for (const id of ids) {
      for (const p of this._templates.get(id) ?? []) p.geometry.dispose();
      this._templates.delete(id);
      const batch = this._batches.get(id);
      if (batch) {
        for (const m of batch.meshes) this.group.remove(m);
        this._batches.delete(id);
      }
    }
    this.sync();
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
