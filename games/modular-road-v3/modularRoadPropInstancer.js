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
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { attribute } from "three/tsl";
import { mergeByMaterial, isSharedGeometry } from "./modularRoadBatching.js";
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

/** Below this total height (metres) a prop counts as lying flat on the road and
 *  stops casting shadows — see the note in `_template`. Comfortably under a
 *  traffic cone (~0.7 m) and over any painted decal. */
const FLAT_PROP_HEIGHT = 0.12;

/**
 * The attribute set a part must have to join the shared plain material. Merging
 * demands identical attributes across every geometry, so parts are normalised to
 * exactly this — extras dropped, missing ones filled — before they are combined.
 */
const PLAIN_ATTRS = ["position", "normal", "uv"];

/**
 * ONE MATERIAL FOR EVERY PLAIN OPAQUE PROP PART, with the colour, roughness and
 * metalness moved into vertex attributes.
 *
 * A draw call is one material, so a prop costs a batch per distinct LOOK. A
 * traffic cone is three: orange body (rough 0.55), white collars (0.35, a little
 * metal), black base (0.9). Nothing about those needs its own shader — they
 * differ only in numbers a vertex can carry.
 *
 * Measured across the whole catalogue (tools/propMaterialProbe.mjs): 64 distinct
 * batches become 48. The cone goes 3 -> 1, the lab ramps 5 -> 1, the flag 3 -> 1.
 *
 * DELIBERATELY NOT USED FOR:
 *   - transparent / faded parts — they need their own sorted draw regardless
 *   - anything with a map — a texture cannot be a vertex attribute
 *   - emissive parts — they route through applyBloomMRT for selective bloom, so
 *     folding them in means handling that buffer too. Worth another 5 batches
 *     catalogue-wide; left for later rather than risked here.
 *   - TINTABLE parts — the instancer writes a per-instance livery through
 *     `instanceColor`, and three only multiplies that into the default diffuse
 *     path. Overriding `colorNode` would silently drop the livery, so liveried
 *     parts keep their own material.
 */
let _plainPropMaterial = null;
function plainPropMaterial() {
  if (_plainPropMaterial) return _plainPropMaterial;
  const m = new THREE.MeshStandardNodeMaterial();
  // `aColor`, not `color`: three treats a `color` attribute as the vertex-colour
  // path and would multiply it in a second time.
  m.colorNode = attribute("aColor", "vec3");
  m.roughnessNode = attribute("aRough", "float");
  m.metalnessNode = attribute("aMetal", "float");
  m.name = "PropPlainVertex";
  _plainPropMaterial = m;
  return m;
}

/** What forces a part to keep its own draw, beyond colour/roughness/metalness. */
function plainGroupKey(p) {
  const m = p.material;
  if (!m) return null;
  if (m.transparent || (m.opacity ?? 1) < 1) return null;
  if (m.map || m.normalMap || m.roughnessMap || m.metalnessMap || m.emissiveMap || m.alphaMap) return null;
  const e = m.emissive;
  if (e && (e.r + e.g + e.b) > 1e-6) return null;
  if (p.tintable) return null;
  if (typeof m.roughness !== "number" || typeof m.metalness !== "number") return null;
  // castShadow / receiveShadow live on the MESH, not the material, so two parts
  // that shade identically still cannot share a draw if one casts and the other
  // does not.
  return `${m.side}|${p.castShadow ? 1 : 0}|${p.receiveShadow ? 1 : 0}`;
}

/**
 * Normalise one geometry to exactly PLAIN_ATTRS + the three baked ones.
 *
 * `mergeGeometries` returns NULL when the inputs disagree on attributes, and it
 * does so silently — the codebase has been bitten by that before, which is why
 * this drops extras rather than hoping every prop builder happens to agree. A
 * BoxGeometry and a LatheGeometry both carry position/normal/uv, but anything a
 * builder added on top would poison the merge.
 */
function bakePlainAttrs(src, material) {
  const g = new THREE.BufferGeometry();
  const pos = src.getAttribute("position");
  g.setAttribute("position", pos.clone());
  g.setAttribute("normal", src.getAttribute("normal")?.clone()
    ?? new THREE.Float32BufferAttribute(new Float32Array(pos.count * 3), 3));
  g.setAttribute("uv", src.getAttribute("uv")?.clone()
    ?? new THREE.Float32BufferAttribute(new Float32Array(pos.count * 2), 2));
  if (src.getIndex()) g.setIndex(src.getIndex().clone());

  const n = pos.count;
  const col = new Float32Array(n * 3);
  const rough = new Float32Array(n);
  const metal = new Float32Array(n);
  // The material's colour is already linear — `mat()` builds it through
  // THREE.Color from a hex the callers author in linear space — so it goes
  // straight into the attribute with no conversion.
  const c = material.color ?? { r: 1, g: 1, b: 1 };
  for (let i = 0; i < n; i++) {
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    rough[i] = material.roughness;
    metal[i] = material.metalness;
  }
  g.setAttribute("aColor", new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute("aRough", new THREE.Float32BufferAttribute(rough, 1));
  g.setAttribute("aMetal", new THREE.Float32BufferAttribute(metal, 1));
  return g;
}

/**
 * Collapse every group of plain opaque parts into a single vertex-shaded part.
 *
 * Runs on the TEMPLATE, once per prop type, so the cost is paid at first
 * placement and never again. Parts that cannot join keep their own entry
 * untouched, in their original order.
 */
function collapsePlainParts(parts) {
  const groups = new Map();
  const out = [];
  for (const p of parts) {
    const key = plainGroupKey(p);
    if (key === null) { out.push(p); continue; }
    let g = groups.get(key);
    if (!g) { g = []; groups.set(key, g); }
    g.push(p);
  }
  for (const [key, group] of groups) {
    // A lone part gains nothing from the shared material and would only lose its
    // own (possibly hand-tuned) one, so leave it exactly as it was.
    if (group.length < 2) { out.push(...group); continue; }
    const baked = group.map((p) => bakePlainAttrs(p.geometry, p.material));
    const merged = mergeGeometries(baked, false);
    for (const b of baked) b.dispose();
    if (!merged) {
      // Refused the merge — keep the originals rather than lose the prop. Silent
      // null is exactly the failure mode bakePlainAttrs exists to prevent, so if
      // this ever fires the normalisation missed something.
      console.warn("[PropInstancer] plain-part merge refused; keeping separate parts");
      out.push(...group);
      continue;
    }
    merged.computeBoundingSphere();
    for (const p of group) if (!isSharedGeometry(p.geometry)) p.geometry.dispose();
    const [side, cast, recv] = key.split("|");
    const mat = plainPropMaterial();
    out.push({
      geometry: merged,
      material: Number(side) === THREE.FrontSide ? mat : (() => {
        // A DoubleSide group needs its own material object — `side` is a
        // material property, not something a vertex can carry.
        const c = mat.clone();
        c.side = Number(side);
        return c;
      })(),
      castShadow: cast === "1",
      receiveShadow: recv === "1",
      tintable: false,
    });
  }
  return out;
}

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
      /**
       * A PROP THAT LIES FLAT ON THE ROAD CASTS NOTHING WORTH DRAWING.
       *
       * `enableMeshShadows` turns casting on for every part of every prop, which
       * is right for a cone or a gate and wrong for paint. A boost decal is a
       * few triangles lying in the deck: its shadow is coplanar with the surface
       * it sits on, so it contributes nothing but a shadow-map draw — and with
       * three cascades a caster is drawn FOUR times, once per cascade plus once
       * for the view. Measured on bench-current.json, the boost decal was 8 draw
       * calls to render 5 triangles.
       *
       * `_syncDecals` already states this rule for sticker batches ("a flat
       * sticker casting a shadow reads as a bug"); this is the same rule applied
       * to props whose own geometry is flat.
       *
       * Decided from the geometry rather than a catalogue flag so it stays true
       * for props nobody has annotated, and measured on the Y extent
       * specifically: "thin" is not the test, "lying down" is. A sign panel is
       * thin in Z but tall in Y, and it should still cast.
       */
      const bb = new THREE.Box3();
      const pb = new THREE.Box3();
      for (const p of parts) {
        p.geometry.computeBoundingBox();
        bb.union(pb.copy(p.geometry.boundingBox));
      }
      if (parts.length && bb.max.y - bb.min.y < FLAT_PROP_HEIGHT) {
        for (const p of parts) p.castShadow = false;
      }

      // AFTER the shadow decision above, deliberately: the group key includes
      // castShadow, so collapsing first would split a flat prop's parts on a
      // flag that is about to become uniform anyway.
      parts = collapsePlainParts(parts);

      // The template tree itself is scaffolding; only the parts are kept —
      // except where `make()` handed back a clone of a SHARED template (all of
      // the scenery catalogue does), in which case the scaffolding's geometry is
      // the one every placement of that type renders with.
      root.traverse((o) => {
        if (o.isMesh && !isSharedGeometry(o.geometry)) o.geometry.dispose();
      });
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
        // Which prop this batch is, so callers can pick batches out by type —
        // the wet road's mirror wants the scenery (lamps, boards) and not the
        // cones. Instancing is all-or-nothing per batch, so this is the only
        // granularity available and it is the right one.
        im.userData.propId = id;
        im.castShadow = p.castShadow;
        // An InstancedMesh receives shadows exactly like a plain Mesh — instancing
        // only changes the VERTEX stage, and the shadow lookup is a fragment-stage
        // branch keyed off this flag. So this is the whole switch; there is nothing
        // instancing-specific to work around.
        im.receiveShadow = p.receiveShadow;
        im.count = insts.length;
        /**
         * CULLED — and the objection this used to carry is now handled.
         *
         * It read: "a knocked cone can end up anywhere; culling the whole batch
         * on a bounding box computed from wherever they started would pop them
         * out." That is true of a bound computed ONCE. `update()` now discards
         * `boundingSphere` every time it rewrites the matrices, so three rebuilds
         * it from where the props actually are, this frame. A cone can roll
         * wherever it likes and the bound follows it.
         *
         * Worth doing because props are the cheapest geometry and the most
         * expensive draws in the game. Measured on bench-current.json — 6 props,
         * the whole obstacle set of a real track — they were 36 draws a frame,
         * 42% of the entire frame's draw calls, to render 5,900 triangles. One
         * boost decal alone was 8 draws for 5 triangles. They are small, local,
         * and off-screen most of the time, which is exactly the case frustum
         * culling is for (and exactly what the guardrail posts, spread along the
         * whole track, were NOT — see the sweep in roadGame's rebuildRailPosts).
         */
        im.frustumCulled = true;
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
      // NOT culled, unlike the prop batches above, and the reason is this
      // batch's fixed stride. Instances for props that wear no sticker are
      // collapsed with `_ZERO` — and they sit INSIDE `count`, which is what
      // computeBoundingSphere walks. Every one of them would union a sphere at
      // the world origin into the bound, stretching it across the map and
      // culling nothing. Decals are a handful of quads, so the fix is not worth
      // the compaction it would need.
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
      for (const m of meshes) {
        m.instanceMatrix.needsUpdate = true;
        // THE BOUNDS MOVED, SO THROW THEM AWAY. three recomputes a null
        // boundingSphere on the next frustum test, from the CURRENT instance
        // matrices, which is what makes culling safe for props that move — see
        // the note where frustumCulled is set. It walks `count`, not the
        // allocated capacity, so the SLACK instances cannot inflate it.
        m.boundingSphere = null;
      }

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
