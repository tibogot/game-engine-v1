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

const MAX_LEAVES_PER_CHUNK = 65536;
// Expand the chunk cull AABB so canopies overhanging the chunk edge don't pop.
const CULL_MARGIN = 12;
// LOD hysteresis band (±10%) so chunks sitting on a tier boundary can't flip
// tiers every frame while the orbit camera damps.
const LOD_HYST = 0.1;

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
     * Per-chunk meshes.
     * _chunkMeshes: Map<chunkKey, {
     *   gen: number,
     *   slots: Map<slotIdx, { lod0: InstancedMesh|null, lod1: InstancedMesh|null, lod2: InstancedMesh|null }>
     * }>
     */
    this._chunkMeshes = new Map();

    this._frustum = new THREE.Frustum();
    this._projScreen = new THREE.Matrix4();
    this._box = new THREE.Box3();
    this._tmpMat = new THREE.Matrix4();
    this._treeMat = new THREE.Matrix4();
    this._pos = new THREE.Vector3();
    this._quat = new THREE.Quaternion();
    this._scl = new THREE.Vector3();
    this._yAxis = new THREE.Vector3(0, 1, 0);
    this._tmpCenter = new THREE.Vector3();
    this._tmpTreeCenter = new THREE.Vector3();
  }

  setSlotPreset(slotIdx, preset) {
    while (this.slotPresets.length <= slotIdx) this.slotPresets.push(null);
    this._clearSlotChunkMeshes(slotIdx);
    this.slotPresets[slotIdx] = preset;
    this._invalidateAllChunks();
  }

  hasSlot(slotIdx) {
    return slotIdx < this.slotPresets.length && this.slotPresets[slotIdx] != null;
  }

  clearSlot(slotIdx) {
    this._clearSlotChunkMeshes(slotIdx);
    if (slotIdx < this.slotPresets.length) this.slotPresets[slotIdx] = null;
  }

  _invalidateAllChunks() {
    for (const [, entry] of this._chunkMeshes) {
      entry.gen = -1;
    }
  }

  _clearSlotChunkMeshes(slotIdx) {
    for (const [, entry] of this._chunkMeshes) {
      const slotEntry = entry.slots.get(slotIdx);
      if (!slotEntry) continue;
      for (const key of ["lod0", "lod1", "lod2"]) {
        if (slotEntry[key]) {
          this.scene.remove(slotEntry[key]);
          slotEntry[key].dispose();
          slotEntry[key] = null;
        }
      }
      entry.slots.delete(slotIdx);
    }
  }

  /**
   * Build foliage InstancedMeshes for one chunk + one slot + one LOD tier.
   * Each tree in the chunk gets its leaves placed at (treeWorldPos + leafLocalPos).
   */
  _buildChunkSlotLod(trees, slotIdx, lodIdx) {
    const preset = this.slotPresets[slotIdx];
    if (!preset) return null;
    const lodData = preset.lods[lodIdx];
    if (!lodData || lodData.count === 0) return null;

    const slotTrees = trees.filter(t => t.slotIdx === slotIdx);
    if (slotTrees.length === 0) return null;

    const totalLeaves = slotTrees.length * lodData.count;
    if (totalLeaves === 0) return null;
    const cappedTotal = Math.min(totalLeaves, MAX_LEAVES_PER_CHUNK);

    const geo = lodData.geometry.clone();
    const randSrc = lodData.randData;
    const centerSrc = lodData.centerData;
    const scaleSrc = lodData.scaleData;
    const billboard = !!lodData.billboard;
    // Trunk-local canopy center for this preset (same for every tree of this slot).
    // Applied per-tree via treeMat below to get the world-space canopy center.
    const canopyLocal = (preset.bounds && preset.bounds.canopyCenter) || null;
    const randData = new Float32Array(cappedTotal * 2);
    // Per-instance world center for the per-instance sphere normal. Without this
    // the chunked InstancedMesh would reuse aLeafCenter from the cloned geometry,
    // which only has lodData.count entries — out-of-bounds for trees > 1 in chunk.
    const centerData = new Float32Array(cappedTotal * 3);
    // Per-instance world canopy center of the tree this leaf belongs to.
    // sphereDir = leafCenter - treeCenter must use world-space endpoints; otherwise
    // trees placed away from world origin get wrong outward directions and the
    // whole canopy flat-shades + flickers as the camera orbits.
    const treeCenterData = new Float32Array(cappedTotal * 3);
    // Per-instance scale; consulted by the shader's billboard path
    // (in non-billboard mode the matrix already carries scale; we still
    // upload aLeafScale per-instance to keep attribute layout consistent).
    const scaleData = new Float32Array(cappedTotal);

    const im = new THREE.InstancedMesh(geo, preset.material, cappedTotal);
    im.count = cappedTotal;
    im.castShadow = true;
    im.receiveShadow = false;
    im.frustumCulled = false;

    const leavesPerTree = lodData.count;
    const localMats = lodData.matrices;
    let idx = 0;

    for (const t of slotTrees) {
      if (idx >= cappedTotal) break;

      this._pos.set(t.x, t.y ?? 0, t.z);
      this._quat.setFromAxisAngle(this._yAxis, t.rotY);
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
          // Leaf world center first (treeMat applied to trunk-local center).
          this._tmpCenter.set(
            centerSrc[li * 3],
            centerSrc[li * 3 + 1],
            centerSrc[li * 3 + 2],
          ).applyMatrix4(this._treeMat);
          // Instance matrix = pure translation to that world center.
          // No rotation (so the camera-aligned quad in the shader isn't
          // re-rotated by tree rotation) and no scale (carried by aLeafScale).
          this._tmpMat.makeTranslation(this._tmpCenter.x, this._tmpCenter.y, this._tmpCenter.z);
          im.setMatrixAt(idx, this._tmpMat);
          centerData[idx * 3]     = this._tmpCenter.x;
          centerData[idx * 3 + 1] = this._tmpCenter.y;
          centerData[idx * 3 + 2] = this._tmpCenter.z;
          // Effective size = tree scale × per-leaf base size.
          scaleData[idx] = scaleSrc[li] * t.scale;
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
          scaleData[idx] = scaleSrc[li]; // not consulted by non-billboard shader
        }
        randData[idx * 2] = randSrc[li * 2];
        randData[idx * 2 + 1] = randSrc[li * 2 + 1];
        treeCenterData[idx * 3]     = tcx;
        treeCenterData[idx * 3 + 1] = tcy;
        treeCenterData[idx * 3 + 2] = tcz;
      }
    }

    im.count = idx;
    im.instanceMatrix.needsUpdate = true;
    geo.setAttribute("aRand", new THREE.InstancedBufferAttribute(randData.slice(0, idx * 2), 2));
    geo.setAttribute("aLeafCenter", new THREE.InstancedBufferAttribute(centerData.slice(0, idx * 3), 3));
    geo.setAttribute("aTreeCenter", new THREE.InstancedBufferAttribute(treeCenterData.slice(0, idx * 3), 3));
    geo.setAttribute("aLeafScale", new THREE.InstancedBufferAttribute(scaleData.slice(0, idx), 1));

    return im;
  }

  _ensureChunkMeshes(chunkKey, trees, gen) {
    let entry = this._chunkMeshes.get(chunkKey);
    if (entry && entry.gen === gen) return entry;

    if (entry) {
      for (const [, slotEntry] of entry.slots) {
        for (const k of ["lod0", "lod1", "lod2"]) {
          if (slotEntry[k]) { this.scene.remove(slotEntry[k]); slotEntry[k].dispose(); }
        }
      }
    }

    // Carry the LOD tier across rebuilds so painting into a chunk doesn't
    // reset its hysteresis state (-1 = unset, pick fresh from raw thresholds).
    entry = { gen, slots: new Map(), tier: entry ? entry.tier : -1 };

    const slotsInChunk = new Set();
    for (const t of trees) slotsInChunk.add(t.slotIdx);

    for (const si of slotsInChunk) {
      if (si >= this.slotPresets.length || !this.slotPresets[si]) continue;
      const slotEntry = { lod0: null, lod1: null, lod2: null };
      for (let li = 0; li < 3; li++) {
        const mesh = this._buildChunkSlotLod(trees, si, li);
        if (mesh) {
          mesh.visible = false;
          this.scene.add(mesh);
          slotEntry[`lod${li}`] = mesh;
        }
      }
      entry.slots.set(si, slotEntry);
    }

    this._chunkMeshes.set(chunkKey, entry);
    return entry;
  }

  update(treeStore, camera, lodCfg) {
    this._projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this._frustum.setFromProjectionMatrix(this._projScreen);

    const camX = camera.position.x;
    const camZ = camera.position.z;
    const chunkSize = this.config.world.chunkSize;
    const half = this.config.world.size * 0.5;

    const lod0D = lodCfg.lod0Distance ?? 80;
    const lod1D = lodCfg.lod1Distance ?? 200;
    const fadeD = lodCfg.fadeOutDistance ?? 600;
    const th = [lod0D, lod1D, fadeD];

    const activeChunks = new Set();

    for (const [key, trees] of treeStore.chunks) {
      if (trees.length === 0) continue;
      activeChunks.add(key);

      const sep = key.indexOf(",");
      const cx = +key.substring(0, sep);
      const cz = +key.substring(sep + 1);
      const minX = -half + cx * chunkSize;
      const minZ = -half + cz * chunkSize;
      this._box.min.set(minX - CULL_MARGIN, -100, minZ - CULL_MARGIN);
      this._box.max.set(minX + chunkSize + CULL_MARGIN, 600, minZ + chunkSize + CULL_MARGIN);

      if (!this._frustum.intersectsBox(this._box)) {
        const entry = this._chunkMeshes.get(key);
        if (entry) {
          for (const [, se] of entry.slots) {
            if (se.lod0) se.lod0.visible = false;
            if (se.lod1) se.lod1.visible = false;
            if (se.lod2) se.lod2.visible = false;
          }
        }
        continue;
      }

      const gen = treeStore.getGen(key);
      const entry = this._ensureChunkMeshes(key, trees, gen);

      const chunkCX = minX + chunkSize * 0.5;
      const chunkCZ = minZ + chunkSize * 0.5;
      const dx = chunkCX - camX;
      const dz = chunkCZ - camZ;
      const dist = Math.sqrt(dx * dx + dz * dz);

      // Tier with hysteresis: 0=lod0, 1=lod1, 2=lod2, 3=hidden.
      // Demote (further tier) past threshold*(1+H); promote back under *(1-H).
      let tier = entry.tier;
      if (tier < 0) {
        tier = dist > fadeD ? 3 : dist > lod1D ? 2 : dist > lod0D ? 1 : 0;
      } else {
        while (tier < 3 && dist > th[tier] * (1 + LOD_HYST)) tier++;
        while (tier > 0 && dist < th[tier - 1] * (1 - LOD_HYST)) tier--;
      }
      entry.tier = tier;

      for (const [, se] of entry.slots) {
        if (se.lod0) se.lod0.visible = tier === 0;
        if (se.lod1) se.lod1.visible = tier === 1;
        if (se.lod2) se.lod2.visible = tier === 2;
      }
    }

    // Prune stale chunks
    if (this._chunkMeshes.size > activeChunks.size + 16) {
      for (const [k, entry] of this._chunkMeshes) {
        if (!activeChunks.has(k)) {
          for (const [, se] of entry.slots) {
            for (const lk of ["lod0", "lod1", "lod2"]) {
              if (se[lk]) { this.scene.remove(se[lk]); se[lk].dispose(); }
            }
          }
          this._chunkMeshes.delete(k);
        }
      }
    }
  }

  updateTime(t) {
    for (const preset of this.slotPresets) {
      if (preset) preset.uniforms.time.value = t;
    }
  }

  updateSunDirection(dir) {
    for (const preset of this.slotPresets) {
      if (preset) preset.uniforms.sunDir.value.copy(dir).normalize();
    }
  }

  dispose() {
    for (const [, entry] of this._chunkMeshes) {
      for (const [, se] of entry.slots) {
        for (const lk of ["lod0", "lod1", "lod2"]) {
          if (se[lk]) { this.scene.remove(se[lk]); se[lk].dispose(); }
        }
      }
    }
    this._chunkMeshes.clear();
  }
}
