import * as THREE from "three";
import { MeshBVH } from "three-mesh-bvh";

const _viewInvShared = new THREE.Matrix4();
import { WORLD_SIZE } from "../terrain/heightmapTexture.js";
import { shareInstancePipeline } from "../render/instancePipeline.js";
import { simplifyEntries, simplifierReady } from "../render/instancing/autoLod.js";

const _tmp       = new THREE.Matrix4();
const _tmpDelta  = new THREE.Matrix4();
const _tmpMat    = new THREE.Matrix4();
const _tmpPos    = new THREE.Vector3();
const _tmpQuat   = new THREE.Quaternion();
const _tmpScl    = new THREE.Vector3();
const _tmpEul    = new THREE.Euler();
const _boxColor  = new THREE.Color(0xff8800);
const MAX_GROUP_BOXES = 128; // selection outline pool cap (selection can exceed this)

/** Starting capacity of each LOD mesh. Meshes GROW past it (they used to drop). */
const INITIAL_INSTANCES = 4096;
export { INITIAL_INSTANCES as MAX_PROP_INSTANCES_PER_MESH };
const CULL_MARGIN   = 12;
const LOD_HYST      = 0.1;
const TIER_UNSET    = 255;

const CELL_SIZE  = 256;
const HALF_WORLD = WORLD_SIZE * 0.5;
const CELL_COUNT = Math.ceil(WORLD_SIZE / CELL_SIZE);

/*
 * SHADOW LISTS LIVE ON THEIR OWN LAYERS.
 *
 * The camera list and the shadow list want opposite things: the camera wants
 * what is on screen, the sun wants what is inside a cascade — which includes
 * props BEHIND the camera. While one instanced mesh served both, culling for
 * one broke the other, so nothing could be culled at all (`frustumCulled` is
 * false on these meshes) and every prop inside maxFar was drawn into all three
 * cascades. Cascade 0's box is ~24 m across and cascade 1's ~85 m, so most of
 * that was work no fragment could ever sample.
 *
 * Now each cascade owns an instanced mesh on layer SHADOW_LAYER_BASE + i,
 * holding only the instances inside THAT cascade, drawn with the cheapest
 * geometry the type has. three makes this work in two places: a shadow camera
 * keeps its own layer mask as long as any layer above 0 is enabled
 * (ShadowNode.js — otherwise it inherits the main camera's), and every object
 * is layer-tested against the camera it is being rendered for (Renderer.js).
 * The main camera never enables these layers, so it never sees them; each
 * cascade camera keeps layer 0, so terrain, trees and the player still cast
 * into every cascade exactly as before.
 *
 * Layers 1-7 are free in v3 (the cloud deck uses 18).
 */
const SHADOW_LAYER_BASE     = 1;
const MAX_SHADOW_CASCADES   = 4;
/*
 * The cascade cameras are positioned by the CSM during the render, so the
 * boxes we test against here are one frame old. At 60 Hz a sprinting camera
 * moves ~0.2 m in a frame; 3 m of slack costs a handful of instances and
 * removes any chance of a shadow popping in at a cascade edge.
 */
const SHADOW_CULL_MARGIN    = 3;

// Picking scratch
const _pickInv   = new THREE.Matrix4();
const _pickRay   = new THREE.Ray();
const _pickPoint = new THREE.Vector3();
const _corner    = new THREE.Vector3();
/** One MeshBVH per geometry, shared by every prop type that uses it. */
const _geoBvh = new WeakMap();

function _cellIdx(wx, wz) {
  const cx = Math.max(0, Math.min(CELL_COUNT - 1, Math.floor((wx + HALF_WORLD) / CELL_SIZE)));
  const cz = Math.max(0, Math.min(CELL_COUNT - 1, Math.floor((wz + HALF_WORLD) / CELL_SIZE)));
  return cz * CELL_COUNT + cx;
}

function _bvhFor(geometry) {
  let bvh = _geoBvh.get(geometry);
  if (!bvh) {
    // indirect: the BVH keeps its own triangle order instead of rewriting the
    // index of a geometry that is also being rendered.
    bvh = new MeshBVH(geometry, { indirect: true });
    _geoBvh.set(geometry, bvh);
  }
  return bvh;
}

/**
 * Ray against an axis-aligned box (slab method). Returns the entry distance,
 * or -1 on a miss. The ray direction must be normalised.
 */
function _rayBox(ox, oy, oz, idx, idy, idz, b, o) {
  let t1 = (b[o] - ox) * idx, t2 = (b[o + 3] - ox) * idx;
  let tmin = Math.min(t1, t2), tmax = Math.max(t1, t2);
  t1 = (b[o + 1] - oy) * idy; t2 = (b[o + 4] - oy) * idy;
  tmin = Math.max(tmin, Math.min(t1, t2)); tmax = Math.min(tmax, Math.max(t1, t2));
  t1 = (b[o + 2] - oz) * idz; t2 = (b[o + 5] - oz) * idz;
  tmin = Math.max(tmin, Math.min(t1, t2)); tmax = Math.min(tmax, Math.max(t1, t2));
  if (tmax < Math.max(tmin, 0)) return -1;
  return Math.max(tmin, 0);
}

export class PropInstancer {
  /** One shared queue: auto-LOD work runs one type at a time, never in parallel. */
  static _autoLodChain = Promise.resolve();

  constructor(scene, propStore, initialCapacity = INITIAL_INSTANCES) {
    this.scene = scene;
    this.store = propStore;
    this.MAX   = initialCapacity;

    this._lastGen    = -1;
    this._lodDirty   = true;
    this._castShadow = true;
    // How far the sun's shadow map actually reaches (CSM maxFar). Props past it
    // cannot darken anything, so their detail levels stop casting.
    this._shadowFar  = Infinity;
    this._shadowKey  = "";

    this._typeRender  = [];

    // SELECTION IS BY PROP ID, not by slot. The store swap-removes, so a slot
    // can hold a different prop a moment later (a brush erase used to make the
    // gizmo drag the wrong prop). `_selectedId` is the primary (stamp memory,
    // prop panel); group transforms apply the proxy's delta matrix to base
    // matrices captured at selection time.
    this._selectedId     = -1;
    this._selection      = new Set();  // ids
    this._groupBaseMats  = null;       // Map<id, Matrix4> at group setup
    this._groupProxyInv  = null;       // inverse of the proxy matrix at group setup
    this._groupBoxPool   = [];         // extra selection outlines for group members
    /** Called when the selected prop(s) stop existing (erased, cleared, undone). */
    this.onSelectionLost = null;

    // EDITOR visibility (Scene list eye): hidden props are not drawn or picked.
    // Not saved, and ignored while revealHidden is on (play mode).
    this.hiddenTypes  = new Set();   // typeIdx
    this.hiddenIds    = new Set();   // prop ids
    this.revealHidden = false;

    this._cacheCount   = 0;
    this._cacheMats    = null;
    this._cacheXs      = null;
    this._cacheYs      = null;
    this._cacheZs      = null;
    this._cacheTypes   = null;
    this._cacheTiers   = null;
    this._cacheToStore = null;  // cache index → propStore.instances index
    this._cellBuckets  = new Array(CELL_COUNT * CELL_COUNT).fill(null);

    // World-space AABB per cache entry, for picking. Built lazily at pick time,
    // so a drag (a gen change every frame) never pays for it.
    this._pickBoxes    = null;
    this._pickBoxesGen = -1;

    // Per-cascade shadow lists. `_shadowCsm` is the CSMShadowNode (read live —
    // it is REBUILT when the cascade count changes), null when a game runs
    // without CSM, in which case we fall back to the old behaviour of letting
    // the camera meshes cast.
    this._shadowCsm     = null;
    this._shadowCascades = 0;
    this._lastShadowCamN = -1;
    this._lastShadowCam  = new Float32Array(32).fill(NaN);
    this._shadowFrusta  = [];
    this._shadowProj    = new THREE.Matrix4();
    this._sphere        = new THREE.Sphere();
    this._cacheRadii    = null;

    this._frustum    = new THREE.Frustum();
    this._projScreen = new THREE.Matrix4();
    this._box        = new THREE.Box3();
    this._worldMat   = new THREE.Matrix4();
    this._lastCam    = new Float32Array(16).fill(NaN);
    this._lastProj   = new Float32Array(16).fill(NaN);
    this._lastLod0   = -1;
    this._lastLod1   = -1;
    this._lastFade   = -1;

    this.proxyObject = new THREE.Object3D();
    scene.add(this.proxyObject);

    this._selectionBox = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
      new THREE.LineBasicMaterial({ color: _boxColor, depthTest: true, transparent: true, opacity: 0.9 }),
    );
    this._selectionBox.visible = false;
    scene.add(this._selectionBox);
  }

  /** Call after changing hiddenTypes / hiddenIds / revealHidden. */
  visibilityChanged() {
    this._lodDirty = true;
  }

  _hiddenAt(ci) {
    if (this.revealHidden || (this.hiddenTypes.size === 0 && this.hiddenIds.size === 0)) return false;
    if (this.hiddenTypes.has(this._cacheTypes[ci])) return true;
    return this.hiddenIds.size > 0 && this.hiddenIds.has(this.store.instances[this._cacheToStore[ci]]?.id);
  }

  // ── Cast shadow ─────────────────────────────────────────────────────────────

  setCastShadow(val) {
    this._castShadow = val;
    // The per-cascade lists exist only to cast, so switching casting off drops
    // them entirely rather than leaving empty meshes to be walked every frame.
    if (!val) this._disposeAllShadowMeshes();
    this._shadowKey = "";
    this._lodDirty = true;
    for (const tr of this._typeRender) {
      if (!tr) continue;
      for (const lod of [tr.lod0, tr.lod1, tr.lod2]) {
        if (lod) for (const e of lod) e.im.castShadow = val;
      }
    }
  }

  // ── Type registration ──────────────────────────────────────────────────────

  _makeMesh(geometry, material, capacity) {
    const im = shareInstancePipeline(new THREE.InstancedMesh(geometry, material, capacity));
    im.count         = 0;
    im.castShadow    = this._castShadow;
    im.receiveShadow = true;
    im.frustumCulled = false;
    this.scene.add(im);
    return im;
  }

  _createLodMeshes(entries) {
    return entries.map(({ geometry, material, localMatrix }) => {
      const im = this._makeMesh(geometry, material, this.MAX);
      return { im, localMatrix, cap: im.instanceMatrix.count, _written: false };
    });
  }

  /**
   * Make room for at least `needed` instances in every mesh of one LOD tier.
   * A new, larger InstancedMesh replaces each one (same geometry and material,
   * so the same pipeline); what is already written is copied across.
   */
  _growLod(lod, needed) {
    for (const e of lod) {
      if (e.cap >= needed) continue;
      let cap = e.cap;
      while (cap < needed) cap = cap + (cap >> 1) + 512;   // 1.5x + 512
      const old = e.im;
      const im = this._makeMesh(old.geometry, old.material, cap);
      im.instanceMatrix.array.set(old.instanceMatrix.array.subarray(0, Math.min(old.instanceMatrix.array.length, im.instanceMatrix.array.length)));
      im.count = old.count;
      im.visible = old.visible;
      this.scene.remove(old);
      old.dispose();
      e.im = im;
      e.cap = im.instanceMatrix.count;
    }
  }

  _disposeLodMeshes(meshes) {
    if (!meshes) return;
    for (const { im } of meshes) { this.scene.remove(im); im.dispose(); }
  }

  onTypeRegistered(typeIdx) {
    const type = this.store.types[typeIdx];
    if (!type || type.live) return;  // live types → LivePropManager
    while (this._typeRender.length <= typeIdx) this._typeRender.push(null);

    const lod0      = this._createLodMeshes(type.entries);
    const boxSize   = new THREE.Vector3();
    type.mergedBox.getSize(boxSize);

    this._typeRender[typeIdx] = {
      lod0, lod1: null, lod2: null,
      boxSize: boxSize.clone(),
      shadow: null,      // built on demand, once the cascade count is known
      shadowKey: "",     // which geometry the shadow meshes were built from
    };
    this._pickBoxesGen = -1;
    this._queueAutoLod(typeIdx);
  }

  // ── Per-cascade shadow lists ───────────────────────────────────────────────

  /**
   * One instanced mesh per cascade, on that cascade's layer, using the cheapest
   * level the type has. Rebuilt when the cascade count changes or when auto-LOD
   * hands us a cheaper geometry than the one we built from.
   */
  _ensureShadowMeshes(typeIdx, cascades) {
    const tr = this._typeRender[typeIdx];
    if (!tr) return null;
    const pick = this._lodForTier(tr, 2);
    if (!pick) return null;
    const key = `${cascades}|${pick.key}`;
    if (tr.shadow && tr.shadowKey === key) return tr.shadow;

    this._disposeShadowMeshes(tr);
    const sets = [];
    for (let i = 0; i < cascades; i++) {
      const entries = pick.lod.map(({ im, localMatrix }) => {
        const inst = shareInstancePipeline(
          new THREE.InstancedMesh(im.geometry, im.material, this.MAX),
        );
        inst.count         = 0;
        inst.castShadow    = true;
        inst.receiveShadow = false;            // it is never seen, only sampled
        inst.frustumCulled = false;
        inst.layers.set(SHADOW_LAYER_BASE + i);
        this.scene.add(inst);
        return { im: inst, localMatrix, cap: inst.instanceMatrix.count, _written: false };
      });
      sets.push(entries);
    }
    tr.shadow = sets;
    tr.shadowKey = key;
    return sets;
  }

  _disposeShadowMeshes(tr) {
    if (!tr?.shadow) return;
    for (const set of tr.shadow) this._disposeLodMeshes(set);
    tr.shadow = null;
    tr.shadowKey = "";
  }

  /** Drop every shadow list — used when the CSM goes away or is rebuilt. */
  _disposeAllShadowMeshes() {
    for (const tr of this._typeRender) this._disposeShadowMeshes(tr);
  }

  /**
   * Fill each cascade's list with the instances inside it. Unlike the camera
   * pass this culls against the LIGHT, so a prop behind the camera still casts
   * into view — which it could never do while the two shared one list.
   */
  _assignShadow() {
    const lights = this._shadowCsm?.lights;
    const n = Math.min(lights?.length ?? 0, MAX_SHADOW_CASCADES);
    if (!n || !this._castShadow) return false;

    // Cascade frusta, from the cameras the CSM positioned last frame.
    this._shadowFrusta.length = n;
    for (let i = 0; i < n; i++) {
      const cam = lights[i].shadow?.camera;
      if (!cam) return false;
      cam.updateMatrixWorld();
      this._shadowProj.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
      (this._shadowFrusta[i] ??= new THREE.Frustum()).setFromProjectionMatrix(this._shadowProj);
      // A cascade camera must keep layer 0 (terrain, trees, the player) AND
      // its own layer. Enabling a layer above 0 is also what stops three
      // overwriting the mask with the main camera's.
      cam.layers.enable(SHADOW_LAYER_BASE + i);
    }
    this._shadowCascades = n;

    const counts = [];
    for (let ti = 0; ti < this._typeRender.length; ti++) {
      const tr = this._typeRender[ti];
      if (!tr) { counts.push(null); continue; }
      const sets = this._ensureShadowMeshes(ti, n);
      if (!sets) { counts.push(null); continue; }
      for (const set of sets) for (const e of set) { e.im.count = 0; e._written = false; }
      counts.push(new Array(n).fill(0));
    }

    const wm = this._worldMat;
    const sph = this._sphere;

    for (let i = 0; i < n; i++) {
      const fr = this._shadowFrusta[i];
      for (let cz = 0; cz < CELL_COUNT; cz++) {
        for (let cx = 0; cx < CELL_COUNT; cx++) {
          const bucket = this._cellBuckets[cz * CELL_COUNT + cx];
          if (!bucket) continue;
          const minX = -HALF_WORLD + cx * CELL_SIZE;
          const minZ = -HALF_WORLD + cz * CELL_SIZE;
          this._box.min.set(minX - CULL_MARGIN, -100, minZ - CULL_MARGIN);
          this._box.max.set(minX + CELL_SIZE + CULL_MARGIN, 600, minZ + CELL_SIZE + CULL_MARGIN);
          if (!fr.intersectsBox(this._box)) continue;

          for (let k = 0; k < bucket.length; k++) {
            const ci = bucket[k];
            const ti = this._cacheTypes[ci];
            const tr = this._typeRender[ti];
            if (!tr?.shadow || this._hiddenAt(ci)) continue;

            sph.center.set(this._cacheXs[ci], this._cacheYs[ci], this._cacheZs[ci]);
            sph.radius = this._cacheRadii[ci] + SHADOW_CULL_MARGIN;
            if (!fr.intersectsSphere(sph)) continue;

            const set = tr.shadow[i];
            const idx = counts[ti][i];
            if (idx >= set[0].cap) this._growLod(set, idx + 1);

            const off = ci * 16;
            for (let j = 0; j < 16; j++) wm.elements[j] = this._cacheMats[off + j];
            for (const entry of set) {
              _tmp.multiplyMatrices(wm, entry.localMatrix);
              entry.im.setMatrixAt(idx, _tmp);
              entry._written = true;
            }
            counts[ti][i]++;
          }
        }
      }
    }

    for (let ti = 0; ti < this._typeRender.length; ti++) {
      const tr = this._typeRender[ti];
      if (!tr?.shadow || !counts[ti]) continue;
      for (let i = 0; i < n; i++) {
        for (const e of tr.shadow[i]) {
          const nv = counts[ti][i];
          if (e._written || e.im.count !== nv) {
            e.im.count = nv;
            if (e._written || nv > 0) e.im.instanceMatrix.needsUpdate = true;
          }
        }
      }
    }
    return true;
  }

  /**
   * Build the detail levels a type does not have. Imported props may ship
   * hand-made LOD GLBs; a built-in shape or a procedural cliff never did, so
   * it drew its full triangle count at any distance.
   *
   * The work is CPU-side milliseconds per mesh, chained and yielding between
   * types so registering a palette never stalls a frame. A level simplified
   * from another shares its material, so `refreshTypeMaterials` keeps them in
   * step with LOD0.
   */
  _queueAutoLod(typeIdx) {
    const type = this.store.types[typeIdx];
    if (!type || type.live || type._autoLodQueued) return;
    if (type.lod1Entries && type.lod2Entries) return;   // hand-made, leave alone
    type._autoLodQueued = true;

    PropInstancer._autoLodChain = PropInstancer._autoLodChain
      .then(async () => {
        await simplifierReady;
        if (!type.lod1Entries) {
          const lod1 = simplifyEntries(type.entries, { ratio: 0.45 });
          if (lod1) {
            type.lod1Entries = lod1;
            type._autoLod1 = true;
            this.onTypeLodRegistered(typeIdx, 1);
          }
        }
        if (!type.lod2Entries) {
          // From LOD1 when there is one: half the work, and the two levels
          // then differ by a predictable step rather than by two guesses.
          const from = type.lod1Entries ?? type.entries;
          const lod2 = simplifyEntries(from, { ratio: 0.35 });
          if (lod2) {
            type.lod2Entries = lod2;
            type._autoLod2 = true;
            this.onTypeLodRegistered(typeIdx, 2);
          }
        }
        await new Promise((r) => setTimeout(r, 0));
      })
      .catch((e) => console.warn(`[V3] Auto-LOD for prop type ${typeIdx} failed:`, e));
  }

  onTypeLodRegistered(typeIdx, lod) {
    const type = this.store.types[typeIdx];
    const tr   = this._typeRender[typeIdx];
    if (!type || !tr || type.live) return;
    const key = lod === 1 ? "lod1" : "lod2";
    const ek  = lod === 1 ? "lod1Entries" : "lod2Entries";
    if (!type[ek]) return;
    this._disposeLodMeshes(tr[key]);
    tr[key] = this._createLodMeshes(type[ek]);
    // The shadow lists borrow the cheapest level's geometry, which just
    // changed underneath them — drop them and let the next frame rebuild.
    this._disposeShadowMeshes(tr);
    this._shadowKey = "";   // re-apply the shadow rule to the new meshes
    this._lodDirty = true;
  }

  /**
   * Re-read per-entry materials from the store after they were swapped in
   * place (e.g. wrapping imported cliff GLB materials with the terrain
   * blend). Imported LOD1/2 carry their own materials, but GENERATED ones are
   * copies of LOD0's submeshes and must follow it, or a cliff would change
   * appearance at the distance where it switches level.
   */
  refreshTypeMaterials(typeIdx) {
    const tr   = this._typeRender[typeIdx];
    const type = this.store.types[typeIdx];
    if (!tr?.lod0 || !type) return;
    const seen = new Set();
    const apply = (meshes) => {
      meshes?.forEach((lodEntry, i) => {
        const mat = type.entries[i]?.material;
        if (!mat || lodEntry.im.material === mat) return;
        seen.add(lodEntry.im.material);
        lodEntry.im.material = mat;
      });
    };
    apply(tr.lod0);
    if (type._autoLod1) apply(tr.lod1);
    if (type._autoLod2) apply(tr.lod2);
    this._disposeShadowMeshes(tr);
    this._lodDirty = true;
    for (const m of seen) m?.dispose?.();
  }

  /** Swap material on every LOD InstancedMesh for this type. */
  setTypeMaterial(typeIdx, newMaterial) {
    const tr = this._typeRender[typeIdx];
    if (!tr) return;
    const seen = new Set();
    for (const lod of [tr.lod0, tr.lod1, tr.lod2]) {
      if (!lod) continue;
      for (const { im } of lod) {
        const prev = im.material;
        im.material = newMaterial;
        if (prev && prev !== newMaterial) seen.add(prev);
      }
    }
    // Shadow lists borrow these materials; rebuild them rather than leave a
    // disposed one behind.
    this._disposeShadowMeshes(tr);
    this._lodDirty = true;
    for (const m of seen) m.dispose?.();
  }

  onTypeRemoved(typeIdx) {
    this.unregisterType(typeIdx);
    this._typeRender.splice(typeIdx, 1);
    this._lastGen = -1;
  }

  unregisterType(typeIdx) {
    const tr = this._typeRender[typeIdx];
    if (!tr) return;
    this._disposeLodMeshes(tr.lod0);
    this._disposeLodMeshes(tr.lod1);
    this._disposeLodMeshes(tr.lod2);
    this._disposeShadowMeshes(tr);
    this._typeRender[typeIdx] = null;
  }

  // ── Cache rebuild ──────────────────────────────────────────────────────────

  _rebuildCache() {
    const allN = this.store.instances.length;

    // Only non-live instances go into the GPU cache
    let n = 0;
    for (let i = 0; i < allN; i++) {
      if (!this.store.types[this.store.instances[i].typeIdx]?.live) n++;
    }

    const cap = Math.max(n * 2, 128);
    if (!this._cacheMats || this._cacheToStore == null || this._cacheToStore.length < n) {
      this._cacheMats    = new Float32Array(cap * 16);
      this._cacheXs      = new Float32Array(cap);
      this._cacheYs      = new Float32Array(cap);
      this._cacheZs      = new Float32Array(cap);
      this._cacheTypes   = new Uint16Array(cap);
      this._cacheTiers   = new Uint8Array(cap);
      this._cacheToStore = new Uint32Array(cap);
      this._cacheRadii   = new Float32Array(cap);
    }
    this._cacheCount = n;
    this._cacheTiers.fill(TIER_UNSET, 0, n);
    this._cellBuckets.fill(null);

    const tmp = [];
    let   ci  = 0;
    for (let si = 0; si < allN; si++) {
      const inst = this.store.instances[si];
      if (this.store.types[inst.typeIdx]?.live) continue;

      this._cacheToStore[ci] = si;
      this._cacheTypes[ci]   = inst.typeIdx;
      this._cacheXs[ci]      = inst.px;
      this._cacheYs[ci]      = inst.py;
      this._cacheZs[ci]      = inst.pz;
      // Bounding sphere for the shadow cull, scale included. Centred on the
      // instance ORIGIN, which for a prop is the foot, so the radius has to
      // reach the top of the box rather than half of it.
      const mb = this.store.types[inst.typeIdx]?.mergedBox;
      if (mb) {
        const sx = Math.abs(inst.sx ?? 1), sy = Math.abs(inst.sy ?? 1), sz = Math.abs(inst.sz ?? 1);
        const ex = Math.max(Math.abs(mb.min.x), Math.abs(mb.max.x)) * sx;
        const ey = Math.max(Math.abs(mb.min.y), Math.abs(mb.max.y)) * sy;
        const ez = Math.max(Math.abs(mb.min.z), Math.abs(mb.max.z)) * sz;
        this._cacheRadii[ci] = Math.sqrt(ex * ex + ey * ey + ez * ez);
      } else {
        this._cacheRadii[ci] = 2;
      }

      const c = _cellIdx(inst.px, inst.pz);
      if (!tmp[c]) tmp[c] = [];
      tmp[c].push(ci);

      const M   = this.store.computeInstanceMatrix(inst);
      const off = ci * 16;
      for (let j = 0; j < 16; j++) this._cacheMats[off + j] = M.elements[j];
      ci++;
    }
    for (let c = 0; c < CELL_COUNT * CELL_COUNT; c++) {
      if (tmp[c]) this._cellBuckets[c] = Uint32Array.from(tmp[c]);
    }
    this._lodDirty = true;
    this._validateSelection();
  }

  /** Drop selected ids that no longer exist; tell the host if the primary went. */
  _validateSelection() {
    if (this._selection.size === 0) return;
    let lost = false;
    for (const id of [...this._selection]) {
      if (this.store.indexOfId(id) < 0) { this._selection.delete(id); lost = true; }
    }
    if (!lost) return;
    if (this._selection.size === 0 || this.store.indexOfId(this._selectedId) < 0) {
      this.clearSelection();
      this.onSelectionLost?.();
    } else {
      this._afterSelectionChange(this._selectedId);
    }
  }

  // ── LOD assignment ─────────────────────────────────────────────────────────

  _sameCamera(cam) {
    const a = cam.matrixWorld.elements, p = cam.projectionMatrix.elements;
    for (let i = 0; i < 16; i++) {
      if (a[i] !== this._lastCam[i] || p[i] !== this._lastProj[i]) return false;
    }
    return true;
  }

  _sameLodCfg(c) {
    return c.lod0Distance === this._lastLod0 &&
           c.lod1Distance === this._lastLod1 &&
           c.fadeOutDistance === this._lastFade;
  }

  _resetWriteFlags() {
    for (const tr of this._typeRender) {
      if (!tr) continue;
      for (const lod of [tr.lod0, tr.lod1, tr.lod2]) {
        if (lod) for (const e of lod) e._written = false;
      }
    }
  }

  _commitCounts(typeCounts) {
    for (let ti = 0; ti < this._typeRender.length; ti++) {
      const tr = this._typeRender[ti];
      const c  = typeCounts[ti];
      if (!tr || !c) continue;
      for (const [key, lod] of [["lod0", tr.lod0], ["lod1", tr.lod1], ["lod2", tr.lod2]]) {
        if (!lod) continue;
        const nv = c[key];
        for (const e of lod) {
          if (e._written || e.im.count !== nv) {
            e.im.count = nv;
            if (e._written || nv > 0) e.im.instanceMatrix.needsUpdate = true;
          }
        }
      }
    }
  }

  _pickTier(dist2, tier, d0, d1, dF) {
    const out2 = (1 + LOD_HYST) ** 2, in2 = (1 - LOD_HYST) ** 2;
    if (tier > 3 || tier === TIER_UNSET) {
      if (dist2 > dF) return 3;
      if (dist2 > d1) return 2;
      if (dist2 > d0) return 1;
      return 0;
    }
    const [d0o,d0i,d1o,d1i,dFo,dFi] = [d0*out2,d0*in2,d1*out2,d1*in2,dF*out2,dF*in2];
    if (tier===3) return dist2<dFi?(dist2<d1i?(dist2<d0i?0:1):2):3;
    if (tier===2) return dist2>dFo?3:(dist2<d1i?(dist2<d0i?0:1):2);
    if (tier===1) return dist2>dFo?3:(dist2>d1o?2:(dist2<d0i?0:1));
    return dist2>dFo?3:(dist2>d1o?2:(dist2>d0o?1:0));
  }

  _lodForTier(tr, tier) {
    if (tier===0) return { lod: tr.lod0, key: "lod0" };
    if (tier===1) return tr.lod1 ? { lod: tr.lod1, key: "lod1" } : { lod: tr.lod0, key: "lod0" };
    if (tier===2) {
      if (tr.lod2) return { lod: tr.lod2, key: "lod2" };
      if (tr.lod1) return { lod: tr.lod1, key: "lod1" };
      return { lod: tr.lod0, key: "lod0" };
    }
    return null;
  }

  _assignLod(camera, cfg) {
    for (const tr of this._typeRender) {
      if (!tr) continue;
      for (const lod of [tr.lod0, tr.lod1, tr.lod2]) {
        if (lod) for (const e of lod) e.im.count = 0;
      }
    }
    this._resetWriteFlags();

    // Frustum from the camera's CURRENT transform — camera.matrixWorldInverse
    // belongs to the render passes and can be stale here (one-frame tree flash).
    camera.updateMatrixWorld();
    _viewInvShared.copy(camera.matrixWorld).invert();
    this._projScreen.multiplyMatrices(camera.projectionMatrix, _viewInvShared);
    this._frustum.setFromProjectionMatrix(this._projScreen);

    const camX = camera.position.x, camZ = camera.position.z;
    const d0sq = cfg.lod0Distance ** 2;
    const d1sq = cfg.lod1Distance ** 2;
    const dFsq = cfg.fadeOutDistance ** 2;
    const tiers = this._cacheTiers;
    const wm    = this._worldMat;

    const counts = this._typeRender.map(tr => tr ? { lod0: 0, lod1: 0, lod2: 0 } : null);

    for (let cz = 0; cz < CELL_COUNT; cz++) {
      for (let cx = 0; cx < CELL_COUNT; cx++) {
        const bucket = this._cellBuckets[cz * CELL_COUNT + cx];
        if (!bucket) continue;
        const minX = -HALF_WORLD + cx * CELL_SIZE;
        const minZ = -HALF_WORLD + cz * CELL_SIZE;
        this._box.min.set(minX - CULL_MARGIN, -100, minZ - CULL_MARGIN);
        this._box.max.set(minX + CELL_SIZE + CULL_MARGIN, 600, minZ + CELL_SIZE + CULL_MARGIN);
        if (!this._frustum.intersectsBox(this._box)) continue;

        for (let k = 0; k < bucket.length; k++) {
          const ci = bucket[k];
          const ti = this._cacheTypes[ci];
          const tr = this._typeRender[ti];
          if (!tr || this._hiddenAt(ci)) continue;

          const dx    = this._cacheXs[ci] - camX;
          const dz    = this._cacheZs[ci] - camZ;
          const dist2 = dx * dx + dz * dz;

          let tier  = tiers[ci];
          tier      = this._pickTier(dist2, tier, d0sq, d1sq, dFsq);
          tiers[ci] = tier;
          if (tier === 3) continue;

          const pick = this._lodForTier(tr, tier);
          if (!pick) continue;

          const c   = counts[ti];
          const idx = c[pick.key];
          // Grow instead of dropping: a type past its capacity used to vanish.
          if (idx >= pick.lod[0].cap) this._growLod(pick.lod, idx + 1);

          const off = ci * 16;
          for (let j = 0; j < 16; j++) wm.elements[j] = this._cacheMats[off + j];
          for (const entry of pick.lod) {
            _tmp.multiplyMatrices(wm, entry.localMatrix);
            entry.im.setMatrixAt(idx, _tmp);
            entry._written = true;
          }
          c[pick.key]++;
        }
      }
    }
    this._commitCounts(counts);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * The distance the shadow map covers, from the CSM. Two thirds of the prop
   * GPU cost was the shadow pass, and most of it was props far beyond this:
   * with the defaults, everything from 150 m to 500 m was drawn into an 80 m
   * shadow map. A detail level whose range starts past it no longer casts.
   */
  setShadowDistance(metres) {
    this._shadowFar = Number.isFinite(metres) && metres > 0 ? metres : Infinity;
    this._lodDirty = true;
  }

  /**
   * The cascaded shadow node, so props can be culled per cascade instead of
   * every prop inside maxFar being drawn into all of them. Pass null (or never
   * call it) and the old whole-tier gate is used instead, so a game with CSM
   * off still gets prop shadows.
   *
   * Read live and re-read every frame: the node is REBUILT when the cascade
   * count changes, and its cameras move with the camera and the sun.
   */
  setShadowCsm(csm) {
    if (csm === this._shadowCsm) return;
    this._shadowCsm = csm ?? null;
    this._disposeAllShadowMeshes();
    this._lastShadowCamN = -1;
    this._shadowKey = "";
    this._lodDirty = true;
  }

  /** Apply the shadow rule to each tier's meshes; cheap, and only on a change. */
  _syncShadowCasters(lodCfg, perCascade) {
    const key = `${this._castShadow}|${this._shadowFar}|${lodCfg.lod0Distance}|${lodCfg.lod1Distance}|${perCascade}`;
    if (key === this._shadowKey) return;
    this._shadowKey = key;
    // With per-cascade lists the camera meshes hand their shadow job over
    // entirely: they would otherwise cast the SAME props a second time, into
    // every cascade, which is the cost this replaced.
    //
    // Without a CSM (a game that turned it off) the old tier gate still
    // applies: a tier casts when its NEAREST prop can still be inside the map.
    const casts = perCascade ? [false, false, false] : [
      this._castShadow,
      this._castShadow && lodCfg.lod0Distance < this._shadowFar,
      this._castShadow && lodCfg.lod1Distance < this._shadowFar,
    ];
    for (const tr of this._typeRender) {
      if (!tr) continue;
      [tr.lod0, tr.lod1, tr.lod2].forEach((lod, i) => {
        if (lod) for (const e of lod) e.im.castShadow = casts[i];
      });
    }
  }

  update(camera, lodCfg) {
    const genChanged = this.store.gen !== this._lastGen;
    if (genChanged) { this._lastGen = this.store.gen; this._rebuildCache(); }
    if (!camera || !lodCfg) return;
    // The cascade boxes follow the camera AND the sun, so a static camera under
    // a moving sun still needs the shadow lists rebuilt.
    if (!this._lodDirty && !genChanged && this._sameLodCfg(lodCfg)
        && this._sameCamera(camera) && this._sameShadowCams()) return;
    this._lastLod0 = lodCfg.lod0Distance;
    this._lastLod1 = lodCfg.lod1Distance;
    this._lastFade = lodCfg.fadeOutDistance;
    this._lastCam.set(camera.matrixWorld.elements);
    this._lastProj.set(camera.projectionMatrix.elements);
    this._lodDirty = false;
    const perCascade = this._assignShadow();
    this._syncShadowCasters(lodCfg, perCascade);
    if (!perCascade) this._disposeAllShadowMeshes();
    this._assignLod(camera, lodCfg);
  }

  /** Have the cascade cameras moved since the last assignment? */
  _sameShadowCams() {
    const lights = this._shadowCsm?.lights;
    const n = Math.min(lights?.length ?? 0, MAX_SHADOW_CASCADES);
    if (n !== this._lastShadowCamN) { this._lastShadowCamN = n; return false; }
    if (!n) return true;
    const e = lights[0].shadow?.camera?.matrixWorld?.elements;
    const p = lights[n - 1].shadow?.camera?.projectionMatrix?.elements;
    if (!e || !p) return false;
    const last = this._lastShadowCam;
    let same = true;
    for (let i = 0; i < 16; i++) {
      if (last[i] !== e[i] || last[16 + i] !== p[i]) { same = false; break; }
    }
    if (!same) {
      for (let i = 0; i < 16; i++) { last[i] = e[i]; last[16 + i] = p[i]; }
    }
    return same;
  }

  /** World AABB of every cached prop (type bounds × instance matrix), for picking. */
  _ensurePickBoxes() {
    if (this.store.gen !== this._lastGen) { this._lastGen = this.store.gen; this._rebuildCache(); }
    if (this._pickBoxesGen === this._lastGen && this._pickBoxes) return;
    const n = this._cacheCount;
    if (!this._pickBoxes || this._pickBoxes.length < n * 6) this._pickBoxes = new Float32Array(Math.max(64, n * 2) * 6);
    const b = this._pickBoxes, m = this._worldMat.elements;
    for (let ci = 0; ci < n; ci++) {
      const box = this.store.types[this._cacheTypes[ci]]?.mergedBox;
      const o = ci * 6;
      if (!box) { b[o] = b[o + 1] = b[o + 2] = Infinity; b[o + 3] = b[o + 4] = b[o + 5] = -Infinity; continue; }
      const off = ci * 16;
      for (let j = 0; j < 16; j++) m[j] = this._cacheMats[off + j];
      let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
      for (let k = 0; k < 8; k++) {
        _corner.set(k & 1 ? box.max.x : box.min.x, k & 2 ? box.max.y : box.min.y, k & 4 ? box.max.z : box.min.z)
          .applyMatrix4(this._worldMat);
        if (_corner.x < x0) x0 = _corner.x; if (_corner.x > x1) x1 = _corner.x;
        if (_corner.y < y0) y0 = _corner.y; if (_corner.y > y1) y1 = _corner.y;
        if (_corner.z < z0) z0 = _corner.z; if (_corner.z > z1) z1 = _corner.z;
      }
      b[o] = x0; b[o + 1] = y0; b[o + 2] = z0; b[o + 3] = x1; b[o + 4] = y1; b[o + 5] = z1;
    }
    this._pickBoxesGen = this._lastGen;
  }

  /**
   * Pick the prop under a ray by its REAL triangles (it used to be the type's
   * bounding box, so a small prop inside a big one's box could not be clicked).
   *
   * Broad phase: ray vs each prop's world AABB. Narrow phase, nearest box first:
   * the ray in the prop's local space against each LOD0 mesh's MeshBVH; stop
   * once the next box starts beyond the best hit.
   *
   * @returns {{ instIdx:number, id:number, distance:number, point:THREE.Vector3 } | null}
   */
  raycast(raycaster) {
    this._ensurePickBoxes();
    const ray = raycaster.ray;
    const ox = ray.origin.x, oy = ray.origin.y, oz = ray.origin.z;
    const idx = 1 / ray.direction.x, idy = 1 / ray.direction.y, idz = 1 / ray.direction.z;
    const far = raycaster.far ?? Infinity;
    const b = this._pickBoxes;
    const cands = [];
    for (let ci = 0; ci < this._cacheCount; ci++) {
      const t = _rayBox(ox, oy, oz, idx, idy, idz, b, ci * 6);
      if (t >= 0 && t <= far && !this._hiddenAt(ci)) cands.push(t, ci);
    }
    if (!cands.length) return null;
    const order = [];
    for (let i = 0; i < cands.length; i += 2) order.push(i);
    order.sort((p, q) => cands[p] - cands[q]);

    let best = null, bestDist = Infinity;
    for (const i of order) {
      if (cands[i] > bestDist) break;
      const ci = cands[i + 1];
      const type = this.store.types[this._cacheTypes[ci]];
      if (!type) continue;
      const off = ci * 16;
      for (let j = 0; j < 16; j++) this._worldMat.elements[j] = this._cacheMats[off + j];
      for (const entry of type.entries) {
        if (!entry.geometry?.attributes?.position) continue;
        _tmpMat.multiplyMatrices(this._worldMat, entry.localMatrix);
        _pickInv.copy(_tmpMat).invert();
        _pickRay.copy(ray).applyMatrix4(_pickInv);
        const hit = _bvhFor(entry.geometry).raycastFirst(_pickRay, THREE.DoubleSide);
        if (!hit) continue;
        _pickPoint.copy(hit.point).applyMatrix4(_tmpMat);
        const d = _pickPoint.distanceTo(ray.origin);
        if (d < bestDist && d <= far) {
          bestDist = d;
          const si = this._cacheToStore[ci];
          // World-space face normal too (decals project into what was clicked).
          const normal = hit.face?.normal
            ? hit.face.normal.clone().applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(_tmpMat)).normalize()
            : null;
          best = { instIdx: si, id: this.store.instances[si]?.id, distance: d, point: _pickPoint.clone(), normal };
        }
      }
    }
    return best;
  }

  // ── Selection (by id) ──────────────────────────────────────────────────────

  _idAt(instIdx) { return this.store.instances[instIdx]?.id ?? -1; }
  _instById(id) { const i = this.store.indexOfId(id); return i >= 0 ? this.store.instances[i] : null; }

  select(instIdx) {
    const inst = this.store.instances[instIdx];
    if (!inst) { this.clearSelection(); return; }
    if (inst.id == null) this.store._bump();   // a prop pushed without a bump yet
    this._selection.clear();
    this._selection.add(inst.id);
    this._groupBaseMats = null;
    this._groupProxyInv = null;
    this._hideGroupBoxes();
    this._selectedId = inst.id;
    const RAD_TO_DEG = Math.PI / 180;
    this.proxyObject.position.set(inst.px, inst.py, inst.pz);
    this.proxyObject.rotation.set(inst.rx * RAD_TO_DEG, inst.ry * RAD_TO_DEG, inst.rz * RAD_TO_DEG);
    this.proxyObject.scale.set(inst.sx, inst.sy, inst.sz);
    this.proxyObject.updateMatrix();
    this._updateSelectionBox(inst);
  }

  /** Shift+click: add/remove an instance from the selection set. */
  toggleSelect(instIdx) {
    const id = this._idAt(instIdx);
    if (id < 0) return;
    if (this._selection.has(id)) this._selection.delete(id);
    else this._selection.add(id);
    this._afterSelectionChange(id);
  }

  /** Replace the whole selection (e.g. after group duplicate). Takes slots. */
  setSelection(indices, primary = indices[indices.length - 1]) {
    this._selection = new Set(indices.map((i) => this._idAt(i)).filter((id) => id >= 0));
    this._afterSelectionChange(this._idAt(primary));
  }

  _afterSelectionChange(primaryId) {
    if (this._selection.size === 0) { this.clearSelection(); return; }
    if (this._selection.size === 1) { this.select(this.store.indexOfId([...this._selection][0])); return; }
    this._selectedId = this._selection.has(primaryId) ? primaryId : [...this._selection][0];
    this._setupGroupProxy();
  }

  /** Proxy at the selection centroid (identity rotation/scale); capture each
   *  member's base matrix so drags apply a clean delta with no drift. */
  _setupGroupProxy() {
    const c = new THREE.Vector3();
    let n = 0;
    for (const id of this._selection) {
      const inst = this._instById(id);
      if (!inst) continue;
      c.x += inst.px; c.y += inst.py; c.z += inst.pz; n++;
    }
    c.divideScalar(Math.max(1, n));
    this.proxyObject.position.copy(c);
    this.proxyObject.rotation.set(0, 0, 0);
    this.proxyObject.scale.set(1, 1, 1);
    this.proxyObject.updateMatrix();
    this._groupProxyInv = this.proxyObject.matrix.clone().invert();

    const DEG = Math.PI / 180;
    this._groupBaseMats = new Map();
    for (const id of this._selection) {
      const inst = this._instById(id);
      if (!inst) continue;
      this._groupBaseMats.set(id, new THREE.Matrix4().compose(
        new THREE.Vector3(inst.px, inst.py, inst.pz),
        new THREE.Quaternion().setFromEuler(_tmpEul.set(inst.rx * DEG, inst.ry * DEG, inst.rz * DEG, "XYZ")),
        new THREE.Vector3(inst.sx, inst.sy, inst.sz),
      ));
    }
    this._selectionBox.visible = false;
    this._updateGroupBoxes();
  }

  clearSelection() {
    this._selectedId           = -1;
    this._selection.clear();
    this._groupBaseMats        = null;
    this._groupProxyInv        = null;
    this._selectionBox.visible = false;
    this._hideGroupBoxes();
  }

  syncFromProxy() {
    if (this._selection.size > 1) { this._syncGroupFromProxy(); return; }
    if (this._selectedId < 0) return;
    const inst = this._instById(this._selectedId);
    if (!inst) return;   // erased since it was selected: never write into its old slot
    const DEG = 180 / Math.PI;
    inst.px = this.proxyObject.position.x;
    inst.py = this.proxyObject.position.y;
    inst.pz = this.proxyObject.position.z;
    inst.rx = this.proxyObject.rotation.x * DEG;
    inst.ry = this.proxyObject.rotation.y * DEG;
    inst.rz = this.proxyObject.rotation.z * DEG;
    inst.sx = this.proxyObject.scale.x;
    inst.sy = this.proxyObject.scale.y;
    inst.sz = this.proxyObject.scale.z;
    this.store._bump();
    this._updateSelectionBox(inst);
  }

  _syncGroupFromProxy() {
    if (!this._groupBaseMats) return;
    this.proxyObject.updateMatrix();
    // Delta since group setup; recomputing from base matrices every change
    // keeps repeated drags exact (no incremental drift).
    _tmpDelta.multiplyMatrices(this.proxyObject.matrix, this._groupProxyInv);
    const DEG = 180 / Math.PI;
    for (const [id, base] of this._groupBaseMats) {
      const inst = this._instById(id);
      if (!inst) continue;
      _tmpMat.multiplyMatrices(_tmpDelta, base).decompose(_tmpPos, _tmpQuat, _tmpScl);
      _tmpEul.setFromQuaternion(_tmpQuat, "XYZ");
      inst.px = _tmpPos.x; inst.py = _tmpPos.y; inst.pz = _tmpPos.z;
      inst.rx = _tmpEul.x * DEG; inst.ry = _tmpEul.y * DEG; inst.rz = _tmpEul.z * DEG;
      inst.sx = _tmpScl.x; inst.sy = _tmpScl.y; inst.sz = _tmpScl.z;
    }
    this.store._bump();
    this._updateGroupBoxes();
  }

  _updateGroupBoxes() {
    let n = 0;
    for (const id of this._selection) {
      if (n >= MAX_GROUP_BOXES) break;
      const inst = this._instById(id);
      if (!inst) continue;
      let box = this._groupBoxPool[n];
      if (!box) {
        box = new THREE.LineSegments(this._selectionBox.geometry, this._selectionBox.material);
        this.scene.add(box);
        this._groupBoxPool[n] = box;
      }
      if (this._placeSelectionBox(box, inst)) n++;
    }
    for (let k = n; k < this._groupBoxPool.length; k++) this._groupBoxPool[k].visible = false;
  }

  _hideGroupBoxes() {
    for (const box of this._groupBoxPool) box.visible = false;
  }

  /** Position a selection outline over an instance. Returns false for live types. */
  _placeSelectionBox(box, inst) {
    const tr   = this._typeRender[inst.typeIdx];
    const type = this.store.types[inst.typeIdx];
    if (!tr || !type || type.live) { box.visible = false; return false; }
    const boxCenter = new THREE.Vector3();
    type.mergedBox.getCenter(boxCenter);
    const DEG = Math.PI / 180;
    box.scale.set(tr.boxSize.x * inst.sx, tr.boxSize.y * inst.sy, tr.boxSize.z * inst.sz);
    box.position.set(inst.px, inst.py, inst.pz);
    box.rotation.set(inst.rx * DEG, inst.ry * DEG, inst.rz * DEG);
    const offset = boxCenter.clone().multiply(new THREE.Vector3(inst.sx, inst.sy, inst.sz));
    offset.applyEuler(box.rotation);
    box.position.add(offset);
    box.visible = true;
    return true;
  }

  _updateSelectionBox(inst) {
    this._placeSelectionBox(this._selectionBox, inst);
  }

  /** Current slot of the primary selection (it can change as the store swap-removes). */
  get selectedIdx()     { return this._selectedId < 0 ? -1 : this.store.indexOfId(this._selectedId); }
  get selectedId()      { return this._selectedId; }
  get hasSelection()    { return this._selectedId >= 0 && this.store.indexOfId(this._selectedId) >= 0; }
  get selectionCount()  { return this._selection.size; }
  /** Current slots of the whole selection. */
  get selectedIndices() { return [...this._selection].map((id) => this.store.indexOfId(id)).filter((i) => i >= 0); }
  get selectedIds()     { return [...this._selection]; }

  dispose() {
    for (let ti = 0; ti < this._typeRender.length; ti++) this.unregisterType(ti);
    this.scene.remove(this.proxyObject);
    this.scene.remove(this._selectionBox);
    for (const box of this._groupBoxPool) this.scene.remove(box);
    this._groupBoxPool.length = 0;
    this._selectionBox.geometry.dispose();
    this._selectionBox.material.dispose();
  }
}
