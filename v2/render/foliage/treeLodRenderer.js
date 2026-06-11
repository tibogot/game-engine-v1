/**
 * TreeLodRenderer — instanced rendering with 2-tier LOD, chunk-level frustum
 * culling, and generation-based matrix caching.
 *
 * Per-chunk cache stores pre-composed world matrices (Float32Array) and slot
 * indices (Uint8Array). The cache is only rebuilt when the chunk's generation
 * counter in TreeStore changes (tree add/remove/height sync). This eliminates
 * per-tree compose() + setFromAxisAngle() on every frame — only the LOD
 * distance check and the cheap worldMat × submeshLocalMat multiply remain.
 */
import * as THREE from "three";

// Initial InstancedMesh capacity per slot. THREE.InstancedMesh allocates its
// GPU instance buffer at construction and cannot grow, so when a frame needs
// more visible instances than this, the meshes are recreated with doubled
// capacity and refilled the same frame (see _growSlotCapacity).
const INITIAL_CAPACITY = 4096;
// Expand the chunk cull AABB so trees whose canopy overhangs the chunk edge
// don't pop when the chunk footprint leaves the frustum.
const CULL_MARGIN = 12;
// LOD hysteresis band (±10%): a tree must cross threshold*(1+H) to demote and
// threshold*(1-H) to promote, so boundary trees can't flip tiers every frame.
const LOD_HYST = 0.1;

export class TreeLodRenderer {
  constructor(scene, config) {
    this.scene = scene;
    this.config = config;
    /**
     * slotRender[slotIdx] = {
     *   lod0: [{ geometry, material, localMatrix, instancedMesh }],
     *   lod1: [{ geometry, material, localMatrix, instancedMesh }] | null
     * } | null
     */
    this.slotRender = [];

    /**
     * Per-chunk matrix cache.
     * key -> { gen, count, slots: Uint8Array, mats: Float32Array,
     *          xs: Float32Array, ys: Float32Array, zs: Float32Array }
     */
    this._cache = new Map();

    this._frustum = new THREE.Frustum();
    this._projScreen = new THREE.Matrix4();
    this._worldMat = new THREE.Matrix4();
    this._finalMat = new THREE.Matrix4();
    this._pos = new THREE.Vector3();
    this._quat = new THREE.Quaternion();
    this._scl = new THREE.Vector3();
    this._box = new THREE.Box3();
    this._yAxis = new THREE.Vector3(0, 1, 0);

    // Idle early-out state: skip the full matrix rewrite + GPU upload when the
    // camera, store and LOD config are all unchanged since the last update.
    this._dirty = true;
    this._lastGen = -1;
    this._lastLod0 = -1;
    this._lastFade = -1;
    this._lastCam = new Float32Array(16).fill(NaN);
    this._lastProj = new Float32Array(16).fill(NaN);
  }

  _sameCamera(camera) {
    const a = camera.matrixWorld.elements;
    const p = camera.projectionMatrix.elements;
    const b = this._lastCam;
    const q = this._lastProj;
    for (let i = 0; i < 16; i++) {
      if (a[i] !== b[i] || p[i] !== q[i]) return false;
    }
    return true;
  }

  setSlotModel(slotIdx, lod, submeshes, castShadow = true) {
    while (this.slotRender.length <= slotIdx) this.slotRender.push(null);
    if (!this.slotRender[slotIdx]) {
      this.slotRender[slotIdx] = { lod0: null, lod1: null, cap: INITIAL_CAPACITY };
    }
    const slot = this.slotRender[slotIdx];
    if (!slot.cap) slot.cap = INITIAL_CAPACITY;

    const key = lod === 0 ? "lod0" : "lod1";
    this._disposeSlotLod(slotIdx, key);
    this._dirty = true;

    const data = submeshes.map((sm) => {
      const im = new THREE.InstancedMesh(sm.geometry, sm.material, slot.cap);
      im.count = 0;
      im.castShadow = castShadow;
      im.receiveShadow = true;
      im.frustumCulled = false;
      this.scene.add(im);
      return {
        geometry: sm.geometry,
        material: sm.material,
        localMatrix: sm.localMatrix,
        instancedMesh: im,
      };
    });
    this.slotRender[slotIdx][key] = data;
  }

  hasSlotLod(slotIdx, lod) {
    const slot = this.slotRender[slotIdx];
    if (!slot) return false;
    return lod === 0 ? slot.lod0 != null : slot.lod1 != null;
  }

  hasSlot(slotIdx) {
    return this.hasSlotLod(slotIdx, 0);
  }

  setCastShadow(slotIdx, on) {
    const slot = this.slotRender[slotIdx];
    if (!slot) return;
    for (const lodArr of [slot.lod0, slot.lod1]) {
      if (!lodArr) continue;
      for (const sm of lodArr) sm.instancedMesh.castShadow = on;
    }
  }

  /** Rebuild cached world matrices for a single chunk. */
  _rebuildChunkCache(key, trees, gen) {
    const n = trees.length;
    let entry = this._cache.get(key);
    if (!entry || entry.mats.length < n * 16) {
      entry = {
        gen,
        count: n,
        slots: new Uint8Array(Math.max(n, 64)),
        mats: new Float32Array(Math.max(n, 64) * 16),
        xs: new Float32Array(Math.max(n, 64)),
        ys: new Float32Array(Math.max(n, 64)),
        zs: new Float32Array(Math.max(n, 64)),
        // Last LOD tier per tree (0=lod0, 1=lod1, 2=hidden, 255=unset) for hysteresis.
        tiers: new Uint8Array(Math.max(n, 64)),
      };
      entry.tiers.fill(255);
      this._cache.set(key, entry);
    }
    entry.gen = gen;
    entry.count = n;
    // Tree indices shift on add/remove — stale tiers would attach to the wrong
    // tree, so reset and let the next frame pick fresh tiers.
    entry.tiers.fill(255, 0, n);

    const me = this._worldMat.elements;
    for (let i = 0; i < n; i++) {
      const t = trees[i];
      entry.slots[i] = t.slotIdx;
      entry.xs[i] = t.x;
      entry.ys[i] = t.y ?? 0;
      entry.zs[i] = t.z;

      this._pos.set(t.x, t.y ?? 0, t.z);
      this._quat.setFromAxisAngle(this._yAxis, t.rotY);
      this._scl.setScalar(t.scale);
      this._worldMat.compose(this._pos, this._quat, this._scl);

      const off = i * 16;
      for (let j = 0; j < 16; j++) entry.mats[off + j] = me[j];
    }
  }

  /**
   * Per-frame update with generation-based caching.
   * Compose is only done when a chunk's trees change; the hot loop
   * just reads cached world matrices.
   */
  update(treeStore, camera, lodCfg) {
    // Idle early-out: nothing moved, nothing changed — keep last frame's
    // instance buffers as-is and skip the rewrite + GPU upload entirely.
    const globalGen = treeStore.globalGen;
    if (
      !this._dirty &&
      globalGen === this._lastGen &&
      lodCfg.lod0Distance === this._lastLod0 &&
      lodCfg.fadeOutDistance === this._lastFade &&
      this._sameCamera(camera)
    ) {
      return;
    }
    this._dirty = false;
    this._lastGen = globalGen;
    this._lastLod0 = lodCfg.lod0Distance;
    this._lastFade = lodCfg.fadeOutDistance;
    this._lastCam.set(camera.matrixWorld.elements);
    this._lastProj.set(camera.projectionMatrix.elements);

    const grew = this._runUpdate(treeStore, camera, lodCfg);
    // A slot outgrew its instance buffers: they were recreated larger with
    // count 0 — refill immediately so trees don't blink for a frame.
    if (grew) this._runUpdate(treeStore, camera, lodCfg);
  }

  /** One fill pass. Returns true if any slot's capacity had to grow. */
  _runUpdate(treeStore, camera, lodCfg) {
    // Reset counts
    for (const slot of this.slotRender) {
      if (!slot) continue;
      if (slot.lod0) for (const sm of slot.lod0) sm.instancedMesh.count = 0;
      if (slot.lod1) for (const sm of slot.lod1) sm.instancedMesh.count = 0;
    }

    this._projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this._frustum.setFromProjectionMatrix(this._projScreen);

    const camX = camera.position.x;
    const camZ = camera.position.z;
    const lod0D2 = lodCfg.lod0Distance * lodCfg.lod0Distance;
    const fadeD2 = lodCfg.fadeOutDistance * lodCfg.fadeOutDistance;
    // Hysteresis bands (squared): demote past *(1+H), promote back under *(1-H).
    const out2 = (1 + LOD_HYST) * (1 + LOD_HYST);
    const in2 = (1 - LOD_HYST) * (1 - LOD_HYST);
    const lod0OutD2 = lod0D2 * out2;
    const lod0InD2 = lod0D2 * in2;
    const fadeOutD2 = fadeD2 * out2;
    const fadeInD2 = fadeD2 * in2;
    const chunkSize = this.config.world.chunkSize;
    const half = this.config.world.size * 0.5;

    const counts = [];
    for (let i = 0; i < this.slotRender.length; i++) {
      counts.push({ lod0: 0, lod1: 0 });
    }

    const wm = this._worldMat;

    for (const [key, trees] of treeStore.chunks) {
      if (trees.length === 0) continue;

      // Chunk-level frustum cull
      const sep = key.indexOf(",");
      const cx = +key.substring(0, sep);
      const cz = +key.substring(sep + 1);
      const minX = -half + cx * chunkSize;
      const minZ = -half + cz * chunkSize;
      this._box.min.set(minX - CULL_MARGIN, -100, minZ - CULL_MARGIN);
      this._box.max.set(minX + chunkSize + CULL_MARGIN, 600, minZ + chunkSize + CULL_MARGIN);
      if (!this._frustum.intersectsBox(this._box)) continue;

      // Ensure cache is fresh
      const gen = treeStore.getGen(key);
      let cached = this._cache.get(key);
      if (!cached || cached.gen !== gen) {
        this._rebuildChunkCache(key, trees, gen);
        cached = this._cache.get(key);
      }

      const n = cached.count;
      const slots = cached.slots;
      const mats = cached.mats;
      const xs = cached.xs;
      const zs = cached.zs;
      const tiers = cached.tiers;

      for (let i = 0; i < n; i++) {
        const si = slots[i];
        if (si >= this.slotRender.length || !this.slotRender[si]) continue;
        const slot = this.slotRender[si];
        if (!slot.lod0) continue;

        // 2D distance (xz) — matches FoliageLodRenderer so trunk and canopy
        // of the same tree change LOD together.
        const dx = xs[i] - camX;
        const dz = zs[i] - camZ;
        const dist2 = dx * dx + dz * dz;

        // Tier with hysteresis: 0=lod0, 1=lod1, 2=hidden, 255=unset.
        let tier = tiers[i];
        if (tier > 2) {
          tier = dist2 > fadeD2 ? 2 : dist2 > lod0D2 ? 1 : 0;
        } else if (tier === 2) {
          if (dist2 < fadeInD2) tier = dist2 < lod0InD2 ? 0 : 1;
        } else if (tier === 1) {
          if (dist2 > fadeOutD2) tier = 2;
          else if (dist2 < lod0InD2) tier = 0;
        } else {
          if (dist2 > fadeOutD2) tier = 2;
          else if (dist2 > lod0OutD2) tier = 1;
        }
        tiers[i] = tier;
        if (tier === 2) continue;

        const usingLod1 = tier === 1 && slot.lod1 != null;
        const lodArr = usingLod1 ? slot.lod1 : slot.lod0;
        const c = counts[si];
        const idx = usingLod1 ? c.lod1 : c.lod0;
        if (usingLod1) c.lod1++;
        else c.lod0++;

        // Over capacity: still counted (drives capacity growth below), not drawn.
        if (idx >= slot.cap) continue;

        // Read cached world matrix (16 floats) into reusable Matrix4
        const off = i * 16;
        const e = wm.elements;
        e[0] = mats[off]; e[1] = mats[off + 1]; e[2] = mats[off + 2]; e[3] = mats[off + 3];
        e[4] = mats[off + 4]; e[5] = mats[off + 5]; e[6] = mats[off + 6]; e[7] = mats[off + 7];
        e[8] = mats[off + 8]; e[9] = mats[off + 9]; e[10] = mats[off + 10]; e[11] = mats[off + 11];
        e[12] = mats[off + 12]; e[13] = mats[off + 13]; e[14] = mats[off + 14]; e[15] = mats[off + 15];

        for (let s = 0; s < lodArr.length; s++) {
          this._finalMat.multiplyMatrices(wm, lodArr[s].localMatrix);
          lodArr[s].instancedMesh.setMatrixAt(idx, this._finalMat);
        }
      }
    }

    // Apply counts and flag GPU upload
    let grewAny = false;
    for (let i = 0; i < this.slotRender.length; i++) {
      const slot = this.slotRender[i];
      if (!slot) continue;
      const c = counts[i];
      const needed = Math.max(c.lod0, c.lod1);
      if (needed > slot.cap) {
        this._growSlotCapacity(i, needed);
        grewAny = true;
        continue; // fresh meshes are empty — refilled by the second pass
      }
      if (slot.lod0) {
        for (const sm of slot.lod0) {
          if (sm.instancedMesh.count !== c.lod0 || c.lod0 > 0) {
            sm.instancedMesh.count = c.lod0;
            sm.instancedMesh.instanceMatrix.needsUpdate = true;
          }
        }
      }
      if (slot.lod1) {
        for (const sm of slot.lod1) {
          if (sm.instancedMesh.count !== c.lod1 || c.lod1 > 0) {
            sm.instancedMesh.count = c.lod1;
            sm.instancedMesh.instanceMatrix.needsUpdate = true;
          }
        }
      }
    }

    // Prune stale cache entries for chunks no longer in the store
    if (this._cache.size > treeStore.chunks.size + 16) {
      for (const k of this._cache.keys()) {
        if (!treeStore.chunks.has(k)) this._cache.delete(k);
      }
    }

    return grewAny;
  }

  /**
   * Recreate a slot's InstancedMeshes with a larger capacity (next power-of-two
   * ≥ needed). Geometry and material are shared with the old meshes, so only
   * the instance buffers are reallocated.
   */
  _growSlotCapacity(slotIdx, needed) {
    const slot = this.slotRender[slotIdx];
    if (!slot) return;
    let cap = slot.cap;
    while (cap < needed) cap *= 2;
    if (cap === slot.cap) return;

    for (const key of ["lod0", "lod1"]) {
      const arr = slot[key];
      if (!arr) continue;
      for (const sm of arr) {
        const old = sm.instancedMesh;
        const im = new THREE.InstancedMesh(sm.geometry, sm.material, cap);
        im.count = 0;
        im.castShadow = old.castShadow;
        im.receiveShadow = true;
        im.frustumCulled = false;
        this.scene.remove(old);
        old.dispose();
        this.scene.add(im);
        sm.instancedMesh = im;
      }
    }
    slot.cap = cap;
    console.log(
      `[TreeLodRenderer] slot ${slotIdx}: instance capacity grown to ${cap} (needed ${needed})`,
    );
  }

  getVisibleCounts() {
    const out = [];
    for (let i = 0; i < this.slotRender.length; i++) {
      const slot = this.slotRender[i];
      if (!slot) { out.push({ lod0: 0, lod1: 0 }); continue; }
      let l0 = 0, l1 = 0;
      if (slot.lod0) l0 = slot.lod0[0]?.instancedMesh.count ?? 0;
      if (slot.lod1) l1 = slot.lod1[0]?.instancedMesh.count ?? 0;
      out.push({ lod0: l0, lod1: l1 });
    }
    return out;
  }

  _disposeSlotLod(slotIdx, key) {
    const slot = this.slotRender[slotIdx];
    if (!slot || !slot[key]) return;
    for (const sm of slot[key]) {
      this.scene.remove(sm.instancedMesh);
      sm.instancedMesh.dispose();
    }
    slot[key] = null;
  }

  disposeSlot(slotIdx) {
    if (slotIdx >= this.slotRender.length) return;
    this._disposeSlotLod(slotIdx, "lod0");
    this._disposeSlotLod(slotIdx, "lod1");
    this.slotRender[slotIdx] = null;
    this._dirty = true;
  }

  dispose() {
    for (let i = 0; i < this.slotRender.length; i++) this.disposeSlot(i);
    this._cache.clear();
  }
}
