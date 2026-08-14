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
import { enableMeshShadows } from "./modularRoadParkour.js";
import { decalMaterial, decalGeometry } from "./modularRoadDecals.js";

/** Reused for "no tint" — three multiplies instanceColor in, so white is the
 *  identity and an unset entry would render black. */
const _WHITE = new THREE.Color(0xffffff);

/** All-zero matrix — a decal instance for a prop that is not wearing one. Every
 *  triangle comes out degenerate, so it rasterises nothing. */
const _ZERO = new THREE.Matrix4().set(0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0);

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

    /** id -> [{ geometry, material, castShadow, receiveShadow }] — built once per type. */
    this._templates = new Map();
    /** id -> { insts, meshes } */
    this._batches = new Map();
    this._enabled = false;
    this._lastCount = -1;
    this._m4 = new THREE.Matrix4();
    this._face = new THREE.Matrix4();
    /** key -> shared quad geometry for a decal batch. */
    this._decalGeo = new Map();
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
      // SAME TREATMENT THE LOOSE PROP GETS. PropManager.add()/duplicateSelected()
      // run this over every root they build; `make()` on its own leaves three's
      // defaults, which are cast=false receive=false. Without it the template is
      // a prop that neither casts nor catches light — and since the instancer
      // takes over rendering for EVERY id, that was every obstacle on the track:
      // drive onto a container and the car's shadow vanished, because the thing
      // it landed on was not a receiver.
      enableMeshShadows(root);
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
        parts.push({
          geometry: g, material: o.material,
          castShadow: o.castShadow, receiveShadow: o.receiveShadow,
          // Marked by the prop's own builder — the container's shell and door
          // take a livery, its frame rails do not.
          tintable: !!o.userData.tintable,
        });
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

    // Drop batches for types that no longer have any props. Decal batches are
    // keyed `<id>::decal` and are never in `wanted`, so they are left to
    // _syncDecals — without this guard they would be torn down every sync.
    for (const [id, batch] of [...this._batches]) {
      if (batch.decal || wanted.has(id)) continue;
      for (const m of batch.meshes) this.group.remove(m);
      this._batches.delete(id);
    }
    for (const [key, batch] of [...this._batches]) {
      if (!batch.decal) continue;
      if (wanted.has(key.replace(/::decal$/, ""))) continue;
      for (const m of batch.meshes) this.group.remove(m);
      this._batches.delete(key);
    }

    for (const [id, insts] of wanted) {
      const parts = this._template(id);
      if (!parts?.length) continue;
      let batch = this._batches.get(id);
      // Reuse while the buffers are still big enough — an InstancedMesh's count
      // can be lowered for free, only growing needs new buffers.
      if (batch && batch.capacity >= insts.length && batch.meshes.length === parts.length) {
        batch.insts = insts;
        batch.colorsDirty = true; // the list changed, so index -> livery did too
        for (const m of batch.meshes) m.count = insts.length;
        continue;
      }
      if (batch) for (const m of batch.meshes) this.group.remove(m);
      const capacity = insts.length + SLACK;
      const meshes = parts.map((p) => {
        const im = new THREE.InstancedMesh(p.geometry, p.material, capacity);
        im.instanceMatrix.setUsage(THREE.DynamicDrawUsage); // rewritten every frame
        im.userData.tintable = p.tintable;
        im.castShadow = p.castShadow;
        // An InstancedMesh receives shadows exactly like a plain Mesh — instancing
        // only changes the VERTEX stage, and the shadow lookup is a fragment-stage
        // branch keyed off this flag. So this is the whole switch; there is nothing
        // instancing-specific to work around.
        im.receiveShadow = p.receiveShadow;
        im.count = insts.length;
        // A knocked cone can end up anywhere; culling the whole batch on a
        // bounding box computed from wherever they started would pop them out.
        im.frustumCulled = false;
        this.group.add(im);
        return im;
      });
      this._batches.set(id, { insts, meshes, capacity, colorsDirty: true });
    }
    this._syncDecals(wanted);
    if (this._enabled) this.update();
  }

  /**
   * One extra InstancedMesh per decal-carrying prop type, holding every face of
   * every placement.
   *
   * FIXED STRIDE — `faces.length` instances per prop, whether or not that prop
   * actually wears a decal, with the unwanted ones scaled to zero. The
   * alternative is a compacted list, which means the mapping from prop to
   * instance index changes every time anyone toggles a sticker, and every
   * toggle becomes a buffer rebuild. A degenerate instance costs four vertices
   * and produces no fragments; that is cheaper than the bookkeeping.
   */
  _syncDecals(wanted) {
    for (const [id, insts] of wanted) {
      const def = this.catalog.find((d) => d.id === id);
      const decal = def?.decal;
      const key = `${id}::decal`;
      const material = decal ? decalMaterial(decal.url) : null;
      // No decal declared, or its texture never loaded — drop any batch we had.
      if (!material) {
        const old = this._batches.get(key);
        if (old) { for (const m of old.meshes) this.group.remove(m); this._batches.delete(key); }
        continue;
      }
      const faces = decal.faces ?? [];
      const need = insts.length * faces.length;
      let batch = this._batches.get(key);
      if (batch && batch.capacity >= need) {
        batch.insts = insts;
        batch.faces = faces;
        for (const m of batch.meshes) m.count = need;
        continue;
      }
      if (batch) for (const m of batch.meshes) this.group.remove(m);
      if (!this._decalGeo.has(key)) {
        this._decalGeo.set(key, decalGeometry(decal.size?.[0] ?? 1, decal.size?.[1] ?? 1));
      }
      const capacity = need + SLACK * faces.length;
      const im = new THREE.InstancedMesh(this._decalGeo.get(key), material, capacity);
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.castShadow = false;   // a flat sticker casting a shadow reads as a bug
      im.receiveShadow = true; // but it must darken with the wall it is on
      im.count = need;
      im.frustumCulled = false;
      im.renderOrder = 1;      // after the wall it sits on
      this.group.add(im);
      this._batches.set(key, { insts, meshes: [im], capacity, faces, decal: true });
    }
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
    for (const batch of this._batches.values()) {
      const { insts, meshes } = batch;
      if (batch.decal) { this._updateDecals(batch); continue; }
      for (let i = 0; i < insts.length; i++) {
        const root = insts[i].root;
        root.updateWorldMatrix(false, false);
        for (const m of meshes) m.setMatrixAt(i, root.matrixWorld);
      }
      for (const m of meshes) m.instanceMatrix.needsUpdate = true;

      // COLOURS ONLY WHEN THEY CHANGE. Matrices are rewritten every frame because
      // props move; a livery is picked once at placement and then sits there, so
      // re-uploading the colour buffer at 60 Hz would be pure waste. Dirty flag
      // instead, raised by sync() and by any variant change.
      if (!batch.colorsDirty) continue;
      batch.colorsDirty = false;
      for (const m of meshes) {
        if (!m.userData.tintable) continue;
        for (let i = 0; i < insts.length; i++) {
          // No tint means "render as the material says" — white, since three
          // MULTIPLIES the instance colour in. Leaving it unset would give black.
          const c = insts[i].tint ?? _WHITE;
          m.setColorAt(i, c);
        }
        if (m.instanceColor) m.instanceColor.needsUpdate = true;
      }
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

  /** Pose one decal batch: prop world matrix x the face's local placement, or a
   *  zero matrix for a prop that is not wearing one. */
  _updateDecals(batch) {
    const { insts, faces, meshes } = batch;
    const im = meshes[0];
    let k = 0;
    for (const inst of insts) {
      inst.root.updateWorldMatrix(false, false);
      for (const f of faces) {
        if (inst.decal) {
          this._face.makeRotationY(f.yaw ?? 0);
          this._face.setPosition(f.pos[0], f.pos[1], f.pos[2]);
          im.setMatrixAt(k++, this._m4.multiplyMatrices(inst.root.matrixWorld, this._face));
        } else {
          // Collapsed to a point: the vertex shader still runs on four vertices
          // and the triangles come out degenerate, so nothing is rasterised.
          im.setMatrixAt(k++, _ZERO);
        }
      }
    }
    im.instanceMatrix.needsUpdate = true;
  }

  /** Re-upload instance colours on the next update. Cheap and idempotent —
   *  colours are otherwise only written when a batch is built or resized. */
  markColorsDirty() {
    for (const b of this._batches.values()) b.colorsDirty = true;
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
