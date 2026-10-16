/**
 * FoliageLodRenderer — per-chunk instanced foliage with 3-tier LOD.
 *
 * Architecture: each chunk gets one InstancedMesh per slot per LOD tier.
 * Meshes are rebuilt only when the chunk's generation counter changes.
 * Per-frame: frustum cull chunks, pick LOD tier by distance, show/hide.
 *
 * Foliage presets are registered per slot. Each preset contains pre-sampled
 * leaf positions (from foliageSampler) and a shared TSL material.
 */
import * as THREE from "three";
import { FoliageMergeGroups } from "./foliageSlotMerge.js";

const MAX_LEAVES_PER_CHUNK = 65536;
// Expand the chunk cull AABB so canopies overhanging the chunk edge don't pop.
const CULL_MARGIN = 12;
// LOD hysteresis band (±10%) so chunks sitting on a tier boundary can't flip
// tiers every frame while the orbit camera damps.
const LOD_HYST = 0.1;
const DEFAULT_CHUNK_MESH_CACHE_EXTRA = 64;
// Time-slicing: cap the LEAF-FILL work per update() call — crossing a LOD
// boundary or entering fresh chunks never spikes a single frame. Budgeting by
// leaf count (not mesh count) lets many small far-tier meshes build in one
// frame while a 65k-leaf near mesh takes a frame to itself.
const DEFAULT_BUILD_LEAF_BUDGET = 48000;
// Evicted meshes are pooled per (slot, lod) and refilled instead of
// reallocated — kills the GC churn (and the old path leaked the cloned
// geometry's GPU buffers on eviction; pooling reuses them instead).
const POOL_MAX_PER_KEY = 24;
// Cache thrash guard: never evict a chunk seen in-frustum within this many
// frames. Orbit/fly sweeps chunks out of view for a few seconds — evicting
// them meant a sparse/late canopy on re-entry (the "tree flash" bug).
const RETAIN_FRAMES = 600;
// Foliage draw-call reducer: group N×N store chunks into one render cell
// (2 → 200 m cells at the default 100 m chunk ≈ 4× fewer draw calls).
// Cells whose leaves exceed MAX_LEAVES_PER_CHUNK split into multiple meshes
// (which also fixes the old silent truncation on dense 100 m chunks).
const DEFAULT_CHUNK_GROUP = 2;
// Tier transitions cross-dissolve over this many frames by ramping the
// incoming mesh's instance count up while the outgoing ramps down —
// scattered leaves stream in/out instead of the whole canopy popping
// (and the LOD0 shadow grows in with the count instead of snapping on).
const TIER_FADE_FRAMES = 16;

export class FoliageLodRenderer {
  constructor(scene, config) {
    this.scene = scene;
    this.config = config;

    /**
     * slotPresets[slotIdx] = {
     *   material, leafMapNode, uniforms,
     *   lods: [
     *     { localPositions, localRands, count, geometry },  // LOD0
     *     { localPositions, localRands, count, geometry },  // LOD1
     *     { localPositions, localRands, count, geometry },  // LOD2
     *   ],
     *   bounds: { yMin, yMax, canopyCenter, aoRadius }
     * } | null
     */
    this.slotPresets = [];

    /**
     * Per-chunk meshes, keyed per RENDER UNIT: "s:<slotIdx>" for stand-alone
     * slots, "g:<mergeKey>" for a merge group (all atlas-sharing slots of the
     * cell in one mesh). Each unit entry: { lod0, lod1, lod2, _meta } where
     * lodN is null | false | Mesh[] and _meta = { si } or { group }.
     * _chunkMeshes: Map<chunkKey, { gen: number, slots: Map<unitKey, unit> }>
     */
    this._chunkMeshes = new Map();

    /** Atlas slot-merge groups (shared material + uniform arrays per atlas). */
    this.mergeGroups = new FoliageMergeGroups();

    /** When true (v3's GPU leaf field), merged slots are drawn EXTERNALLY —
     *  no chunked cell meshes are built for them. Per-slot units (pine,
     *  non-atlas) still render here, and syncParams keeps feeding the shared
     *  param arrays the external material binds. */
    this.externalMergeRendering = false;

    this._frustum = new THREE.Frustum();
    this._projScreen = new THREE.Matrix4();
    this._viewInv = new THREE.Matrix4();
    this._box = new THREE.Box3();
    this._tmpMat = new THREE.Matrix4();
    this._treeMat = new THREE.Matrix4();
    this._pos = new THREE.Vector3();
    this._quat = new THREE.Quaternion();
    this._scl = new THREE.Vector3();
    this._yAxis = new THREE.Vector3(0, 1, 0);
    this._tmpCenter = new THREE.Vector3();
    this._tmpTreeCenter = new THREE.Vector3();
    this._surfNorm = new THREE.Vector3();
    this._quatNorm = new THREE.Quaternion();
    this._quatSpin = new THREE.Quaternion();

    /** Evicted-mesh pool: "slot:lod" → InstancedMesh[] (reused on rebuild). */
    this._meshPool = new Map();
    /** Missing chunk-tier meshes wanted this frame; rebuilt every update(). */
    this._pendingBuilds = [];

    /** Blink detector — counts every path that hides a canopy that was
     *  visible last frame. Read/reset via window.__treeDebug.stats(). */
    this._dbg = {
      frame: 0, blinks: 0, frustumHides: 0, genRebuilds: 0,
      emergency: 0, builds: 0, tierSwaps: 0, orphanHides: 0,
      firstDrawMisses: 0, notes: [],
    };
  }

  _dbgNote(msg) {
    if (this._dbg.notes.length < 12) this._dbg.notes.push(`[f${this._dbg.frame}] ${msg}`);
  }

  /** Snapshot + reset the blink counters. */
  debugStats() {
    const s = { ...this._dbg, notes: [...this._dbg.notes] };
    const frame = this._dbg.frame;
    this._dbg = {
      frame, blinks: 0, frustumHides: 0, genRebuilds: 0,
      emergency: 0, builds: 0, tierSwaps: 0, orphanHides: 0,
      firstDrawMisses: 0, notes: [],
    };
    return s;
  }

  _buildBudget() {
    return this.config.foliageLod?.buildLeafBudgetPerFrame ?? DEFAULT_BUILD_LEAF_BUDGET;
  }

  _chunkGroup() {
    return this.config.foliageLod?.chunkGroup ?? DEFAULT_CHUNK_GROUP;
  }

  /** se[lodK] is null | false | Mesh[] — run fn over the meshes if present. */
  _eachMesh(v, fn) {
    if (Array.isArray(v)) for (const m of v) fn(m);
  }

  /** Instance count setter for both mesh kinds: InstancedMesh (non-billboard)
   *  and matrix-less Mesh + InstancedBufferGeometry (billboard). */
  _setCount(m, n) {
    if (m.isInstancedMesh) m.count = n;
    else m.geometry.instanceCount = n;
  }

  /** Rough leaf-fill cost of building one chunk-unit-tier mesh. */
  _jobCost(job) {
    if (job.meta.group) {
      let total = 0;
      for (const t of job.trees) {
        if (!job.meta.group.members.has(t.slotIdx)) continue;
        total += this.slotPresets[t.slotIdx]?.lods?.[job.tier]?.count ?? 0;
      }
      return Math.min(total, MAX_LEAVES_PER_CHUNK);
    }
    const preset = this.slotPresets[job.meta.si];
    const perTree = preset?.lods?.[job.tier]?.count ?? 0;
    return Math.min(job.trees.length * perTree, MAX_LEAVES_PER_CHUNK);
  }

  // ── Mesh pool ──────────────────────────────────────────────────────────────

  _acquireFromPool(slotIdx, lodIdx, needed) {
    const arr = this._meshPool.get(`${slotIdx}:${lodIdx}`);
    if (!arr) return null;
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i].userData._poolCap >= needed) return arr.splice(i, 1)[0];
    }
    return null;
  }

  /** Return an evicted mesh to the pool (or truly dispose past the cap). */
  _releaseMesh(mesh) {
    this.scene.remove(mesh);
    const key = mesh.userData._poolKey;
    if (key) {
      let arr = this._meshPool.get(key);
      if (!arr) this._meshPool.set(key, (arr = []));
      if (arr.length < POOL_MAX_PER_KEY) {
        mesh.visible = false;
        arr.push(mesh);
        return;
      }
    }
    mesh.geometry.dispose();
    mesh.dispose?.();
  }

  /** Drop every pooled mesh for a slot (preset replaced — geometry/material stale). */
  _purgeSlotPool(slotIdx) {
    for (const [key, arr] of this._meshPool) {
      if (!key.startsWith(`${slotIdx}:`)) continue;
      for (const m of arr) { m.geometry.dispose(); m.dispose?.(); }
      this._meshPool.delete(key);
    }
  }

  setSlotPreset(slotIdx, preset) {
    while (this.slotPresets.length <= slotIdx) this.slotPresets.push(null);
    this._clearSlotChunkMeshes(slotIdx);
    const wasMerged = this.mergeGroups.slotToGroup.has(slotIdx);
    this.slotPresets[slotIdx] = preset;
    // Membership change ⇒ merged instance data (slot ids, union card) is
    // stale for EVERY member — meshes and pools must go before rebuild()
    // disposes the card geometry their vertex buffers are shared with.
    if (wasMerged || preset?.mergeKey) {
      this._clearMergedChunkMeshes();
      this.mergeGroups.rebuild(this.slotPresets);
    }
    this._invalidateAllChunks();
  }

  hasSlot(slotIdx) {
    return slotIdx < this.slotPresets.length && this.slotPresets[slotIdx] != null;
  }

  clearSlot(slotIdx) {
    this._clearSlotChunkMeshes(slotIdx);
    const wasMerged = this.mergeGroups.slotToGroup.has(slotIdx);
    if (slotIdx < this.slotPresets.length) this.slotPresets[slotIdx] = null;
    if (wasMerged) {
      this._clearMergedChunkMeshes();
      this.mergeGroups.rebuild(this.slotPresets);
      // Surviving members need their group units re-established per cell.
      this._invalidateAllChunks();
    }
  }

  /** Drop every merged-unit mesh + pooled merged mesh (full dispose, no pool:
   *  merged meshes share the group card geometry's vertex buffers, which the
   *  next rebuild() replaces). */
  _clearMergedChunkMeshes() {
    for (const [, entry] of this._chunkMeshes) {
      for (const [ukey, se] of entry.slots) {
        if (typeof ukey !== "string" || !ukey.startsWith("g:")) continue;
        for (const lk of ["lod0", "lod1", "lod2"]) {
          this._eachMesh(se[lk], (m) => {
            this.scene.remove(m);
            m.geometry.dispose();
            m.dispose?.();
          });
        }
        entry.slots.delete(ukey);
      }
    }
    for (const [key, arr] of this._meshPool) {
      if (!key.startsWith("g:")) continue;
      for (const m of arr) { m.geometry.dispose(); m.dispose?.(); }
      this._meshPool.delete(key);
    }
  }

  _invalidateAllChunks() {
    for (const [, entry] of this._chunkMeshes) {
      entry.gen = -1;
    }
  }

  _clearSlotChunkMeshes(slotIdx) {
    const ukey = "s:" + slotIdx;
    for (const [, entry] of this._chunkMeshes) {
      const slotEntry = entry.slots.get(ukey);
      if (!slotEntry) continue;
      for (const key of ["lod0", "lod1", "lod2"]) {
        this._eachMesh(slotEntry[key], (m) => {
          this.scene.remove(m);
          m.geometry.dispose();
          m.dispose?.();
        });
        slotEntry[key] = null;
      }
      entry.slots.delete(ukey);
    }
    // The preset (geometry/material) is being replaced — pooled meshes built
    // from it must not be reused.
    this._purgeSlotPool(slotIdx);
  }

  _chunkMeshCacheExtra() {
    return this.config.foliageLod?.chunkMeshCacheExtra ?? DEFAULT_CHUNK_MESH_CACHE_EXTRA;
  }

  _hideSlotMeshes(se) {
    for (const lk of ["lod0", "lod1", "lod2"]) {
      this._eachMesh(se[lk], (m) => { m.visible = false; });
    }
  }

  _hideEntry(entry) {
    for (const [, se] of entry.slots) this._hideSlotMeshes(se);
  }

  _disposeEntry(key) {
    const entry = this._chunkMeshes.get(key);
    if (!entry) return;
    for (const [, se] of entry.slots) {
      for (const lk of ["lod0", "lod1", "lod2"]) {
        this._eachMesh(se[lk], (m) => this._releaseMesh(m));
      }
    }
    this._chunkMeshes.delete(key);
  }

  /** Drop hidden orphan caches only when over the retention cap (LRU-ish: map order). */
  _trimChunkMeshCache(activeKeys, frame) {
    // A frame with an empty/near-empty frustum set is a glitch (bad camera
    // matrices), not a real view change — trimming then would evict the whole
    // cache and force a rebuild storm. Skip; a sane frame will trim shortly.
    if (activeKeys.size === 0) return;
    const maxSize = activeKeys.size + this._chunkMeshCacheExtra();
    if (this._chunkMeshes.size <= maxSize) return;
    for (const [k, entry] of this._chunkMeshes) {
      if (this._chunkMeshes.size <= maxSize) break;
      if (activeKeys.has(k)) continue;
      // Age gate: chunks recently in view WILL come back (orbit sweeps) —
      // evicting them caused the re-entry canopy flash. Only evict cold ones.
      if (frame - (entry._seen ?? 0) < RETAIN_FRAMES) continue;
      this._disposeEntry(k);
    }
  }

  /**
   * Build the foliage meshes for one cell + slot + LOD tier. Cells whose leaf
   * total exceeds MAX_LEAVES_PER_CHUNK split into multiple InstancedMeshes
   * (the old single-mesh path silently TRUNCATED dense chunks instead).
   * Returns Mesh[] or null.
   */
  _buildChunkSlotLod(trees, slotIdx, lodIdx) {
    const preset = this.slotPresets[slotIdx];
    if (!preset) return null;
    const lodData = preset.lods[lodIdx];
    if (!lodData || lodData.count === 0) return null;

    const slotTrees = trees.filter(t => t.slotIdx === slotIdx);
    if (slotTrees.length === 0) return null;

    const maxTrees = Math.max(1, Math.floor(MAX_LEAVES_PER_CHUNK / lodData.count));
    const out = [];
    for (let s = 0; s < slotTrees.length; s += maxTrees) {
      const mesh = this._buildLeafMesh(slotTrees.slice(s, s + maxTrees), preset, lodData, slotIdx, lodIdx);
      if (mesh) out.push(mesh);
    }
    return out.length ? out : null;
  }

  /** Build ONE InstancedMesh (≤ MAX_LEAVES_PER_CHUNK leaves), pool-first. */
  _buildLeafMesh(slotTrees, preset, lodData, slotIdx, lodIdx) {
    const cappedTotal = slotTrees.length * lodData.count;
    if (cappedTotal === 0) return null;

    const randSrc = lodData.randData;
    const centerSrc = lodData.centerData;
    const scaleSrc = lodData.scaleData;
    const billboard = !!lodData.billboard;
    // Trunk-local canopy center for this preset (same for every tree of this slot).
    // Applied per-tree via treeMat below to get the world-space canopy center.
    const canopyLocal = (preset.bounds && preset.bounds.canopyCenter) || null;
    const _bYMin = (preset.bounds && preset.bounds.yMin) ?? 0;
    const _bRange = Math.max(((preset.bounds && preset.bounds.yMax) ?? 8) - _bYMin, 0.001);

    // Pool-first: refill an evicted mesh of this slot/lod in place instead of
    // reallocating geometry + 4 instanced attributes (GC churn while travelling).
    //
    // Attribute semantics (unchanged from the original allocation path):
    //  - aRand        per-leaf 2D random (wind phase / color variation)
    //  - aLeafCenter  per-instance WORLD leaf center (sphere-normal math; the
    //                 cloned source geometry only has lodData.count entries)
    //  - aTreeCenter  per-instance WORLD canopy center of the owning tree
    //  - aLeafScale   vec2 [leaf size, canopy height fraction 0..1] — packed
    //                 because WebGPU caps vertex buffers at 8
    let im = this._acquireFromPool(slotIdx, lodIdx, cappedTotal);
    let geo, randData, centerData, treeCenterData, scaleData;
    const fromPool = !!im;
    if (fromPool) {
      geo            = im.geometry;
      randData       = geo.getAttribute("aRand").array;
      centerData     = geo.getAttribute("aLeafCenter").array;
      treeCenterData = geo.getAttribute("aTreeCenter").array;
      scaleData      = geo.getAttribute("aLeafScale").array;
    } else {
      if (billboard) {
        // MATRIX-LESS billboards: a plain Mesh with InstancedBufferGeometry.
        // Billboard instance matrices were pure translation — 64 bytes/leaf
        // duplicating what aLeafCenter (12 bytes) already stores. The shader's
        // billboard branch outputs card offset + aLeafCenter directly, so the
        // matrix (and its per-rebuild compose loop) is dropped entirely:
        // ~2.6× less instance memory/upload and faster cell rebuilds.
        // Base card attributes are SHARED with the preset geometry (no copies).
        const base = lodData.geometry;
        geo = new THREE.InstancedBufferGeometry();
        geo.setIndex(base.index);
        geo.setAttribute("position", base.getAttribute("position"));
        geo.setAttribute("normal", base.getAttribute("normal"));
        geo.setAttribute("uv", base.getAttribute("uv"));
        im = new THREE.Mesh(geo, preset.material);
      } else {
        geo = lodData.geometry.clone();
        im = new THREE.InstancedMesh(geo, preset.material, cappedTotal);
      }
      randData       = new Float32Array(cappedTotal * 2);
      centerData     = new Float32Array(cappedTotal * 3);
      treeCenterData = new Float32Array(cappedTotal * 3);
      scaleData      = new Float32Array(cappedTotal * 2);
      // Shadow policy: LOD0 always casts; LOD1 casts but is distance-gated
      // per frame in update() — only cells whose nearest corner is inside the
      // LOD0 band cast (a NEAR tree can live in a tier-1 cell; LOD0-only left
      // close canopies shadowless, while far tier-1 cells casting was pure
      // shadow-pass draw-call waste). LOD2 (far) stays off; the terrain
      // shadow blend hides it at that distance.
      im.castShadow = lodIdx <= 1 && !this.debugNoLeafShadows;
      im.receiveShadow = false;
      im.frustumCulled = false;
      im.userData._poolKey = `${slotIdx}:${lodIdx}`;
      im.userData._poolCap = cappedTotal;
    }

    const leavesPerTree = lodData.count;
    const localMats = lodData.matrices;
    let idx = 0;

    for (const t of slotTrees) {
      if (idx >= cappedTotal) break;

      this._pos.set(t.x, t.y ?? 0, t.z);
      const _nx = t.nx ?? 0;
      const _nz = t.nz ?? 0;
      if (_nx !== 0 || _nz !== 0) {
        const _ny = Math.sqrt(Math.max(0, 1 - _nx * _nx - _nz * _nz));
        this._surfNorm.set(_nx, _ny, _nz);
        this._quatNorm.setFromUnitVectors(this._yAxis, this._surfNorm);
        this._quatSpin.setFromAxisAngle(this._yAxis, t.rotY);
        this._quat.multiplyQuaternions(this._quatNorm, this._quatSpin);
      } else {
        this._quat.setFromAxisAngle(this._yAxis, t.rotY);
      }
      this._scl.setScalar(t.scale);
      this._treeMat.compose(this._pos, this._quat, this._scl);

      // Tree's world canopy center — computed once per tree, written for every leaf below.
      if (canopyLocal) {
        this._tmpTreeCenter.copy(canopyLocal).applyMatrix4(this._treeMat);
      } else {
        this._tmpTreeCenter.copy(this._pos);
      }
      const tcx = this._tmpTreeCenter.x;
      const tcy = this._tmpTreeCenter.y;
      const tcz = this._tmpTreeCenter.z;

      for (let li = 0; li < leavesPerTree && idx < cappedTotal; li++, idx++) {
        if (billboard) {
          // Leaf world center (treeMat applied to trunk-local center) goes
          // ONLY into aLeafCenter — matrix-less meshes have no instanceMatrix;
          // the shader's billboard branch positions the card from this.
          this._tmpCenter.set(
            centerSrc[li * 3],
            centerSrc[li * 3 + 1],
            centerSrc[li * 3 + 2],
          ).applyMatrix4(this._treeMat);
          centerData[idx * 3]     = this._tmpCenter.x;
          centerData[idx * 3 + 1] = this._tmpCenter.y;
          centerData[idx * 3 + 2] = this._tmpCenter.z;
          // Effective size = tree scale × per-leaf base size.
          scaleData[idx * 2] = scaleSrc[li] * t.scale;
        } else {
          const off = li * 16;
          this._tmpMat.fromArray(localMats, off);
          this._tmpMat.premultiply(this._treeMat);
          im.setMatrixAt(idx, this._tmpMat);
          // Leaf center in trunk-local -> world via this tree's matrix.
          this._tmpCenter.set(
            centerSrc[li * 3],
            centerSrc[li * 3 + 1],
            centerSrc[li * 3 + 2],
          ).applyMatrix4(this._treeMat);
          centerData[idx * 3]     = this._tmpCenter.x;
          centerData[idx * 3 + 1] = this._tmpCenter.y;
          centerData[idx * 3 + 2] = this._tmpCenter.z;
          scaleData[idx * 2] = scaleSrc[li]; // size — not consulted by non-billboard shader
        }
        randData[idx * 2] = randSrc[li * 2];
        randData[idx * 2 + 1] = randSrc[li * 2 + 1];
        treeCenterData[idx * 3]     = tcx;
        treeCenterData[idx * 3 + 1] = tcy;
        treeCenterData[idx * 3 + 2] = tcz;
        // centerSrc is the leaf's trunk-LOCAL centre -> stable height fraction,
        // packed into aLeafScale.y (idx*2+1).
        const _leafLocalY = centerSrc[li * 3 + 1];
        scaleData[idx * 2 + 1] = Math.min(1, Math.max(0, (_leafLocalY - _bYMin) / _bRange));
      }
    }

    this._setCount(im, idx);
    im._fullCount = idx; // tier cross-dissolve ramps count; this is "100%"
    if (im.isInstancedMesh) im.instanceMatrix.needsUpdate = true;
    if (fromPool) {
      geo.getAttribute("aRand").needsUpdate = true;
      geo.getAttribute("aLeafCenter").needsUpdate = true;
      geo.getAttribute("aTreeCenter").needsUpdate = true;
      geo.getAttribute("aLeafScale").needsUpdate = true;
    } else {
      // Full-capacity arrays (no defensive .slice copies — idx === cappedTotal
      // in practice, and im.count caps what draws).
      geo.setAttribute("aRand", new THREE.InstancedBufferAttribute(randData, 2));
      geo.setAttribute("aLeafCenter", new THREE.InstancedBufferAttribute(centerData, 3));
      geo.setAttribute("aTreeCenter", new THREE.InstancedBufferAttribute(treeCenterData, 3));
      geo.setAttribute("aLeafScale", new THREE.InstancedBufferAttribute(scaleData, 2));
    }

    return im;
  }

  /**
   * Build the foliage meshes for one cell + MERGE GROUP + LOD tier: every
   * member slot's trees in one mesh, batched at MAX_LEAVES_PER_CHUNK.
   * Returns Mesh[] or null.
   */
  _buildChunkGroupLod(trees, group, lodIdx) {
    const out = [];
    let batch = [];
    let batchLeaves = 0;
    const flush = () => {
      if (batchLeaves > 0) {
        const m = this._buildMergedLeafMesh(batch, batchLeaves, group, lodIdx);
        if (m) out.push(m);
      }
      batch = [];
      batchLeaves = 0;
    };
    for (const t of trees) {
      if (!group.members.has(t.slotIdx)) continue;
      const count = this.slotPresets[t.slotIdx]?.lods?.[lodIdx]?.count ?? 0;
      if (count === 0) continue;
      if (batchLeaves > 0 && batchLeaves + count > MAX_LEAVES_PER_CHUNK) flush();
      batch.push(t);
      batchLeaves += count;
    }
    flush();
    return out.length ? out : null;
  }

  /**
   * ONE merged mesh (≤ MAX_LEAVES_PER_CHUNK leaves), pool-first. Merge groups
   * are billboard-only, so this is the matrix-less Mesh + InstancedBufferGeometry
   * path of _buildLeafMesh with two differences: per-tree leaf data comes from
   * that tree's OWN slot preset, and aLeafScale is vec3 with the group-local
   * slot id in .z (the merged material's uniform-array index).
   */
  _buildMergedLeafMesh(batchTrees, cappedTotal, group, lodIdx) {
    if (cappedTotal === 0) return null;
    // cardGen in the key: a membership change replaces the shared card
    // geometry, so pooled meshes from the old card must never be refilled
    // (they are fully disposed in _clearMergedChunkMeshes).
    const poolKey = `g:${group.key}:${group.cardGen}:${lodIdx}`;
    let im = null;
    const poolArr = this._meshPool.get(poolKey);
    if (poolArr) {
      for (let i = poolArr.length - 1; i >= 0; i--) {
        if (poolArr[i].userData._poolCap >= cappedTotal) { im = poolArr.splice(i, 1)[0]; break; }
      }
    }
    let geo, randData, centerData, treeCenterData, scaleData;
    const fromPool = !!im;
    if (fromPool) {
      geo            = im.geometry;
      randData       = geo.getAttribute("aRand").array;
      centerData     = geo.getAttribute("aLeafCenter").array;
      treeCenterData = geo.getAttribute("aTreeCenter").array;
      scaleData      = geo.getAttribute("aLeafScale").array;
    } else {
      const base = group.cardGeometry;
      geo = new THREE.InstancedBufferGeometry();
      geo.setIndex(base.index);
      geo.setAttribute("position", base.getAttribute("position"));
      geo.setAttribute("normal", base.getAttribute("normal"));
      geo.setAttribute("uv", base.getAttribute("uv"));
      im = new THREE.Mesh(geo, group.material);
      randData       = new Float32Array(cappedTotal * 2);
      centerData     = new Float32Array(cappedTotal * 3);
      treeCenterData = new Float32Array(cappedTotal * 3);
      scaleData      = new Float32Array(cappedTotal * 3);
      im.castShadow = lodIdx <= 1 && !this.debugNoLeafShadows;
      im.receiveShadow = false;
      im.frustumCulled = false;
      im.userData._poolKey = poolKey;
      im.userData._poolCap = cappedTotal;
    }

    let idx = 0;
    for (const t of batchTrees) {
      const preset = this.slotPresets[t.slotIdx];
      const lodData = preset.lods[lodIdx];
      const memberIdx = group.members.get(t.slotIdx) ?? 0;
      const randSrc = lodData.randData;
      const centerSrc = lodData.centerData;
      const scaleSrc = lodData.scaleData;
      const canopyLocal = (preset.bounds && preset.bounds.canopyCenter) || null;
      const bYMin = (preset.bounds && preset.bounds.yMin) ?? 0;
      const bRange = Math.max(((preset.bounds && preset.bounds.yMax) ?? 8) - bYMin, 0.001);

      this._pos.set(t.x, t.y ?? 0, t.z);
      const _nx = t.nx ?? 0;
      const _nz = t.nz ?? 0;
      if (_nx !== 0 || _nz !== 0) {
        const _ny = Math.sqrt(Math.max(0, 1 - _nx * _nx - _nz * _nz));
        this._surfNorm.set(_nx, _ny, _nz);
        this._quatNorm.setFromUnitVectors(this._yAxis, this._surfNorm);
        this._quatSpin.setFromAxisAngle(this._yAxis, t.rotY);
        this._quat.multiplyQuaternions(this._quatNorm, this._quatSpin);
      } else {
        this._quat.setFromAxisAngle(this._yAxis, t.rotY);
      }
      this._scl.setScalar(t.scale);
      this._treeMat.compose(this._pos, this._quat, this._scl);

      if (canopyLocal) {
        this._tmpTreeCenter.copy(canopyLocal).applyMatrix4(this._treeMat);
      } else {
        this._tmpTreeCenter.copy(this._pos);
      }
      const tcx = this._tmpTreeCenter.x;
      const tcy = this._tmpTreeCenter.y;
      const tcz = this._tmpTreeCenter.z;

      for (let li = 0; li < lodData.count && idx < cappedTotal; li++, idx++) {
        this._tmpCenter.set(
          centerSrc[li * 3],
          centerSrc[li * 3 + 1],
          centerSrc[li * 3 + 2],
        ).applyMatrix4(this._treeMat);
        centerData[idx * 3]     = this._tmpCenter.x;
        centerData[idx * 3 + 1] = this._tmpCenter.y;
        centerData[idx * 3 + 2] = this._tmpCenter.z;
        randData[idx * 2] = randSrc[li * 2];
        randData[idx * 2 + 1] = randSrc[li * 2 + 1];
        treeCenterData[idx * 3]     = tcx;
        treeCenterData[idx * 3 + 1] = tcy;
        treeCenterData[idx * 3 + 2] = tcz;
        scaleData[idx * 3] = scaleSrc[li] * t.scale;
        const _leafLocalY = centerSrc[li * 3 + 1];
        scaleData[idx * 3 + 1] = Math.min(1, Math.max(0, (_leafLocalY - bYMin) / bRange));
        scaleData[idx * 3 + 2] = memberIdx;
      }
    }

    this._setCount(im, idx);
    im._fullCount = idx;
    if (fromPool) {
      geo.getAttribute("aRand").needsUpdate = true;
      geo.getAttribute("aLeafCenter").needsUpdate = true;
      geo.getAttribute("aTreeCenter").needsUpdate = true;
      geo.getAttribute("aLeafScale").needsUpdate = true;
    } else {
      geo.setAttribute("aRand", new THREE.InstancedBufferAttribute(randData, 2));
      geo.setAttribute("aLeafCenter", new THREE.InstancedBufferAttribute(centerData, 3));
      geo.setAttribute("aTreeCenter", new THREE.InstancedBufferAttribute(treeCenterData, 3));
      geo.setAttribute("aLeafScale", new THREE.InstancedBufferAttribute(scaleData, 3));
    }

    return im;
  }

  _ensureChunkMeshes(chunkKey, members, gen) {
    let entry = this._chunkMeshes.get(chunkKey);
    if (entry && entry.gen === gen) return entry;

    if (entry) {
      this._dbg.genRebuilds++;
      this._dbgNote(`genRebuild ${chunkKey} (${entry.gen} → ${gen})`);
      for (const [, slotEntry] of entry.slots) {
        for (const k of ["lod0", "lod1", "lod2"]) {
          this._eachMesh(slotEntry[k], (m) => this._releaseMesh(m));
        }
      }
    }

    // Flatten the group's member chunks once per gen change; builds and the
    // queue reuse entry.trees so the per-frame loop never re-flattens.
    const trees = [];
    for (const arr of members) for (const t of arr) trees.push(t);

    // Carry the LOD tier across rebuilds so painting into a chunk doesn't
    // reset its hysteresis state (-1 = unset, pick fresh from raw thresholds).
    entry = { gen, trees, slots: new Map(), tier: entry ? entry.tier : -1 };

    // Render units: merged slots collapse into one "g:<key>" unit per group;
    // everything else stays per-slot ("s:<idx>").
    const units = new Map();
    for (const t of trees) {
      const si = t.slotIdx;
      if (si >= this.slotPresets.length || !this.slotPresets[si]) continue;
      const g = this.mergeGroups.slotToGroup.get(si);
      // GPU leaf field draws merged slots AND any slot it claimed (pines).
      if (this.externalMergeRendering) {
        if (g || this.externalSlots?.has(si)) continue;
      }
      const ukey = g ? "g:" + g.key : "s:" + si;
      if (!units.has(ukey)) units.set(ukey, g ? { group: g } : { si });
    }
    for (const [ukey, meta] of units) {
      // Lazy: tier meshes start null and are built on demand in update() — only
      // the chunk's currently-visible tier, never all 3 (saves ~3x memory + the
      // build hitch when a fresh chunk enters the frustum).
      entry.slots.set(ukey, { lod0: null, lod1: null, lod2: null, _meta: meta });
    }

    this._chunkMeshes.set(chunkKey, entry);
    return entry;
  }

  // Build one (chunk-unit-lod) mesh on demand and cache it. `false` = this tier
  // genuinely has no leaves for this unit, so it isn't retried each frame.
  _ensureTier(slotEntry, meta, trees, lodIdx) {
    const key = `lod${lodIdx}`;
    if (slotEntry[key] !== null) return;
    this._dbg.builds++;
    const meshes = meta.group
      ? this._buildChunkGroupLod(trees, meta.group, lodIdx)
      : this._buildChunkSlotLod(trees, meta.si, lodIdx);
    if (meshes) {
      for (const mesh of meshes) {
        mesh.visible = false;
        this.scene.add(mesh);
      }
      slotEntry[key] = meshes;
    } else {
      slotEntry[key] = false;
    }
  }

  update(treeStore, camera, lodCfg) {
    // Diagnostic kill-switch (window.__treeDebug) — hides all leaf tiers.
    if (this.debugHide) {
      for (const [, entry] of this._chunkMeshes) this._hideEntry(entry);
      return;
    }
    // Build the frustum from the camera's CURRENT transform. Do NOT use
    // camera.matrixWorldInverse — that's refreshed by render passes, so during
    // this pre-render update it holds whatever the last pass left there;
    // single stale/foreign frames culled every visible chunk at once (the
    // "trees flash for one frame" bug — see 2026-07-04 blink-detector session).
    camera.updateMatrixWorld();
    this._viewInv.copy(camera.matrixWorld).invert();
    this._projScreen.multiplyMatrices(camera.projectionMatrix, this._viewInv);
    this._frustum.setFromProjectionMatrix(this._projScreen);

    // Mirror per-slot uniforms into merge-group arrays so panel edits on a
    // merged slot show up without any extra plumbing (~a hundred float copies).
    this.mergeGroups.syncParams(this.slotPresets);

    const f = ++this._dbg.frame;
    const camX = camera.position.x;
    const camZ = camera.position.z;
    const chunkSize = this.config.world.chunkSize;
    const half = this.config.world.size * 0.5;

    const lod0D = lodCfg.lod0Distance ?? 80;
    const lod1D = lodCfg.lod1Distance ?? 200;
    const fadeD = lodCfg.fadeOutDistance ?? 600;
    const th = [lod0D, lod1D, fadeD];

    // ── Super-chunk grouping: N×N store chunks render as ONE cell ───────────
    // (one InstancedMesh per cell-slot-tier instead of per chunk — the main
    // draw-call reducer for big forests).
    const GROUP = this._chunkGroup();
    const cellSize = chunkSize * GROUP;
    const groups = new Map(); // gKey -> { gen, members, gx, gz }
    for (const [key, trees] of treeStore.chunks) {
      if (trees.length === 0) continue;
      const sep = key.indexOf(",");
      const cx = +key.substring(0, sep);
      const cz = +key.substring(sep + 1);
      const gx = Math.floor(cx / GROUP);
      const gz = Math.floor(cz / GROUP);
      const gKey = gx + "," + gz;
      let g = groups.get(gKey);
      if (!g) groups.set(gKey, (g = { gen: 0, members: [], gx, gz }));
      // Sum of member gens: changes whenever ANY member chunk mutates.
      g.gen += treeStore.getGen(key);
      g.members.push(trees);
    }

    const activeChunks = new Set(groups.keys());
    const frustumChunks = new Set();

    for (const [key, g] of groups) {
      const minX = -half + g.gx * cellSize;
      const minZ = -half + g.gz * cellSize;
      this._box.min.set(minX - CULL_MARGIN, -100, minZ - CULL_MARGIN);
      this._box.max.set(minX + cellSize + CULL_MARGIN, 600, minZ + cellSize + CULL_MARGIN);

      if (!this._frustum.intersectsBox(this._box)) {
        const entry = this._chunkMeshes.get(key);
        if (entry) {
          for (const [, se] of entry.slots) {
            if (se._shownFrame === f - 1) {
              this._dbg.frustumHides++;
              this._dbgNote(`frustumHide ${key} camDist=${Math.round(Math.hypot(minX + cellSize / 2 - camX, minZ + cellSize / 2 - camZ))}`);
            }
            this._hideSlotMeshes(se);
          }
        }
        continue;
      }

      frustumChunks.add(key);
      const entry = this._ensureChunkMeshes(key, g.members, g.gen);
      entry._seen = f; // age-based retention (anti-thrash)
      const trees = entry.trees;

      const chunkCX = minX + cellSize * 0.5;
      const chunkCZ = minZ + cellSize * 0.5;
      const dx = chunkCX - camX;
      const dz = chunkCZ - camZ;
      const dist = Math.sqrt(dx * dx + dz * dz);

      // Tier with hysteresis: 0=lod0, 1=lod1, 2=lod2, 3=hidden.
      // Demote (further tier) past threshold*(1+H); promote back under *(1-H).
      //
      // The HIDE boundary (tier 3) AND the LOD0 boundary use the cell's
      // NEAREST-corner distance, not its center: with big cells, a tree can
      // sit ~cellRadius nearer than the center — hiding by center distance
      // left bare trunks before the impostors took over, and demoting by it
      // showed HALF-DENSITY canopies right next to the camera (the "sparse
      // near pine" bug). Only the lod1→lod2 boundary keeps center distance.
      const cellRadius = cellSize * 0.7071;
      const distFar = Math.max(0, dist - cellRadius);
      const dFor = (i) => (i === 1 ? dist : distFar);
      let tier = entry.tier;
      if (this.debugFreeze) {
        // Diagnostic freeze: no tier changes, no builds — warmed meshes only.
        tier = tier >= 0 ? tier : 3;
      } else if (tier < 0) {
        tier = distFar > fadeD ? 3 : dist > lod1D ? 2 : distFar > lod0D ? 1 : 0;
        entry.tier = tier;
      } else {
        while (tier < 3 && dFor(tier) > th[tier] * (1 + LOD_HYST)) tier++;
        while (tier > 0 && dFor(tier - 1) < th[tier - 1] * (1 - LOD_HYST)) tier--;
        entry.tier = tier;
      }

      for (const [ukey, se] of entry.slots) {
        // Time-sliced builds: queue missing tier meshes instead of building
        // synchronously — at most _buildBudget() builds happen per frame,
        // nearest chunks first. Until the wanted tier exists, show the best
        // ALREADY-BUILT tier (prefer coarser) so the chunk never blinks.
        let showTier = -1;
        if (tier < 3) {
          const wantedMissing = se[`lod${tier}`] === null;
          // NEAR chunks build their wanted tier SYNCHRONOUSLY: a close canopy
          // must never appear sparse or late — a pooled refill costs ~1-2 ms,
          // a wrong-density canopy is a visible flash. Far chunks stream via
          // the budgeted queue (a coarse stand-in is fine at distance).
          if (wantedMissing && !this.debugFreeze) {
            if (dist < lod1D) this._ensureTier(se, se._meta, trees, tier);
            else this._pendingBuilds.push({ se, meta: se._meta, trees, tier, dist });
          }
          if (se[`lod${tier}`]) showTier = tier;
          else {
            for (const alt of [tier + 1, tier + 2, tier - 1, tier - 2]) {
              if (alt >= 0 && alt <= 2 && se[`lod${alt}`]) { showTier = alt; break; }
            }
          }
          // Far-chunk fallback: LOD2 is tiny — build it synchronously so a
          // canopy always exists while the wanted tier streams in.
          if (showTier === -1 && se.lod2 === null && !this.debugFreeze) {
            this._dbg.emergency++;
            this._ensureTier(se, se._meta, trees, 2);
            if (se.lod2) showTier = 2;
          }
        }
        // Blink detector: we're about to hide a canopy that was visible last
        // frame while its chunk is still wanted (tier<3) — that's the flash.
        if (showTier >= 0) {
          if (se._lastTier != null && se._lastTier !== showTier && se._shownFrame === f - 1) this._dbg.tierSwaps++;
          se._lastTier = showTier;
          se._shownFrame = f;
        } else if (tier < 3 && se._shownFrame === f - 1) {
          this._dbg.blinks++;
          this._dbgNote(`BLINK ${key}:${ukey} tier=${tier} lod0=${!!se.lod0} lod1=${!!se.lod1} lod2=${String(se.lod2)}`);
        }

        // Tier CROSS-DISSOLVE, density-safe: only the DENSER tier ramps its
        // instance count (a free draw parameter); the sparser tier stays at
        // FULL count throughout. Promoting (approach): sparse old holds while
        // dense leaves stream in on top — the canopy only ever gains. Demoting:
        // sparse target shows instantly while dense leaves stream out. Density
        // never drops below what was already on screen (ramping the dense tier
        // in from zero over a full old fade LOOKED like the canopy vanishing
        // to bare trunks on approach). The LOD0 shadow still grows with count.
        const newKey = showTier >= 0 ? `lod${showTier}` : null;
        if (newKey !== se._shownKey) {
          if (se._shownKey && se[se._shownKey] && newKey && se[newKey]) {
            se._fadeFrom = se._shownKey;
            // Lower lod index = denser. That one ramps; the other holds full.
            se._fadeRamp = newKey < se._shownKey ? newKey : se._shownKey;
            se._fadeT = 0;
          } else {
            se._fadeFrom = null;
          }
          se._shownKey = newKey;
        }
        let fading = false;
        if (se._fadeFrom && se[se._fadeFrom] && se._shownKey) {
          se._fadeT += 1 / TIER_FADE_FRAMES;
          if (se._fadeT >= 1) se._fadeFrom = null;
          else fading = true;
        }
        // LOD1 shadow gate: cast only when some tree in the cell can be near
        // the camera (nearest-corner distance inside the LOD0 band). Far
        // tier-1 cells skip the shadow pass entirely.
        const lod1Shadow = distFar < lod0D && !this.debugNoLeafShadows;
        for (const lk of ["lod0", "lod1", "lod2"]) {
          const isNew = lk === se._shownKey;
          const isOld = fading && lk === se._fadeFrom;
          this._eachMesh(se[lk], (m) => {
            m.visible = isNew || isOld;
            if (lk === "lod1") m.castShadow = lod1Shadow;
            const full = m._fullCount ?? 0;
            if (isNew) {
              this._setCount(m, (fading && lk === se._fadeRamp)
                ? Math.max(1, Math.ceil(full * se._fadeT))
                : full);
            } else if (isOld) {
              this._setCount(m, (lk === se._fadeRamp)
                ? Math.max(0, Math.floor(full * (1 - se._fadeT)))
                : full);
            }
          });
        }
      }
    }

    // Process the build queue: nearest chunks first, leaf-count budget per
    // frame (always at least one job so huge meshes can't stall the queue).
    if (this._pendingBuilds.length > 0) {
      this._pendingBuilds.sort((a, b) => a.dist - b.dist);
      let remaining = this._buildBudget();
      for (let i = 0; i < this._pendingBuilds.length; i++) {
        const job = this._pendingBuilds[i];
        if (job.se[`lod${job.tier}`] !== null) continue; // built as emergency LOD2 etc.
        const cost = this._jobCost(job);
        if (i > 0 && cost > remaining) break;
        remaining -= cost;
        this._ensureTier(job.se, job.meta, job.trees, job.tier);
        // No manual visibility here: next frame's pass sees the built tier
        // and starts the cross-dissolve from whatever fallback was showing.
        if (remaining <= 0) break;
      }
      this._pendingBuilds.length = 0;
    }

    // Orphan caches (chunk emptied in store): hide, keep GPU pipelines warm for re-orbit.
    for (const [k, entry] of this._chunkMeshes) {
      if (!activeChunks.has(k)) {
        for (const [, se] of entry.slots) {
          if (se._shownFrame === f - 1) { this._dbg.orphanHides++; this._dbgNote(`orphanHide ${k}`); }
        }
        this._hideEntry(entry);
      }
    }
    if (!this.debugFreeze) this._trimChunkMeshCache(frustumChunks, f);
  }

  updateTime(t) {
    for (const preset of this.slotPresets) {
      if (preset) preset.uniforms.time.value = t;
    }
    for (const [, g] of this.mergeGroups.groups) g.uniforms.time.value = t;
  }

  updateSunDirection(dir) {
    for (const preset of this.slotPresets) {
      if (preset) preset.uniforms.sunDir.value.copy(dir).normalize();
    }
    for (const [, g] of this.mergeGroups.groups) g.uniforms.sunDir.value.copy(dir).normalize();
  }

  dispose() {
    for (const [, entry] of this._chunkMeshes) {
      for (const [, se] of entry.slots) {
        for (const lk of ["lod0", "lod1", "lod2"]) {
          this._eachMesh(se[lk], (m) => {
            this.scene.remove(m);
            m.geometry.dispose();
            m.dispose?.();
          });
        }
      }
    }
    this._chunkMeshes.clear();
    for (const [, arr] of this._meshPool) {
      for (const m of arr) { m.geometry.dispose(); m.dispose?.(); }
    }
    this._meshPool.clear();
    this.mergeGroups.dispose();
  }
}
