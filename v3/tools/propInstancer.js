import * as THREE from "three";
import { WORLD_SIZE } from "../terrain/heightmapTexture.js";

const _tmp       = new THREE.Matrix4();
const _hitboxMat = new THREE.MeshBasicMaterial({ visible: false });
const _boxColor  = new THREE.Color(0xff8800);

const MAX_INSTANCES = 4096;
const CULL_MARGIN   = 12;
const LOD_HYST      = 0.1;
const TIER_UNSET    = 255;

const CELL_SIZE  = 256;
const HALF_WORLD = WORLD_SIZE * 0.5;
const CELL_COUNT = Math.ceil(WORLD_SIZE / CELL_SIZE);

function _cellIdx(wx, wz) {
  const cx = Math.max(0, Math.min(CELL_COUNT - 1, Math.floor((wx + HALF_WORLD) / CELL_SIZE)));
  const cz = Math.max(0, Math.min(CELL_COUNT - 1, Math.floor((wz + HALF_WORLD) / CELL_SIZE)));
  return cz * CELL_COUNT + cx;
}

export class PropInstancer {
  constructor(scene, propStore, maxInstances = MAX_INSTANCES) {
    this.scene = scene;
    this.store = propStore;
    this.MAX   = maxInstances;

    this._lastGen    = -1;
    this._lodDirty   = true;
    this._castShadow = true;

    this._typeRender  = [];
    this._selectedIdx = -1;

    this._cacheCount   = 0;
    this._cacheMats    = null;
    this._cacheXs      = null;
    this._cacheYs      = null;
    this._cacheZs      = null;
    this._cacheTypes   = null;
    this._cacheTiers   = null;
    this._cacheToStore = null;  // cache index → propStore.instances index
    this._cellBuckets  = new Array(CELL_COUNT * CELL_COUNT).fill(null);

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

  // ── Cast shadow ─────────────────────────────────────────────────────────────

  setCastShadow(val) {
    this._castShadow = val;
    for (const tr of this._typeRender) {
      if (!tr) continue;
      for (const lod of [tr.lod0, tr.lod1, tr.lod2]) {
        if (lod) for (const e of lod) e.im.castShadow = val;
      }
    }
  }

  // ── Type registration ──────────────────────────────────────────────────────

  _createLodMeshes(entries) {
    return entries.map(({ geometry, material, localMatrix }) => {
      const im = new THREE.InstancedMesh(geometry, material, this.MAX);
      im.count         = 0;
      im.castShadow    = this._castShadow;
      im.receiveShadow = true;
      im.frustumCulled = false;
      this.scene.add(im);
      return { im, localMatrix, _written: false };
    });
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
    const boxCenter = new THREE.Vector3();
    type.mergedBox.getSize(boxSize);
    type.mergedBox.getCenter(boxCenter);

    const hitboxGeo = new THREE.BoxGeometry(boxSize.x, boxSize.y, boxSize.z);
    const hitboxIM  = new THREE.InstancedMesh(hitboxGeo, _hitboxMat, this.MAX);
    hitboxIM.count         = 0;
    hitboxIM.frustumCulled = false;
    this.scene.add(hitboxIM);

    this._typeRender[typeIdx] = {
      lod0, lod1: null, lod2: null,
      hitboxIM, hitboxGeo,
      boxCenterMatrix: new THREE.Matrix4().makeTranslation(boxCenter.x, boxCenter.y, boxCenter.z),
      boxSize: boxSize.clone(),
      _globalIndices: [],
    };
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
    if (tr.hitboxIM) { this.scene.remove(tr.hitboxIM); tr.hitboxIM.dispose(); }
    tr.hitboxGeo?.dispose();
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

    // Rebuild hitboxes — by type, keyed by cache index
    const byType = new Map();
    for (let ci2 = 0; ci2 < n; ci2++) {
      const ti = this._cacheTypes[ci2];
      if (!byType.has(ti)) byType.set(ti, []);
      byType.get(ti).push(ci2);
    }
    const wm = this._worldMat;
    for (let ti = 0; ti < this._typeRender.length; ti++) {
      const tr = this._typeRender[ti];
      if (!tr || !tr.hitboxIM) continue;
      const indices = byType.get(ti) ?? [];
      tr._globalIndices = indices;
      tr.hitboxIM.count = indices.length;
      for (let j = 0; j < indices.length; j++) {
        const off = indices[j] * 16;
        for (let k = 0; k < 16; k++) wm.elements[k] = this._cacheMats[off + k];
        _tmp.multiplyMatrices(wm, tr.boxCenterMatrix);
        tr.hitboxIM.setMatrixAt(j, _tmp);
      }
      tr.hitboxIM.instanceMatrix.needsUpdate = true;
      tr.hitboxIM.boundingSphere = null;
      tr.hitboxIM.boundingBox    = null;
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

    this._projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
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
          if (!tr) continue;

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
          if (idx >= this.MAX) continue;

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

  update(camera, lodCfg) {
    const genChanged = this.store.gen !== this._lastGen;
    if (genChanged) { this._lastGen = this.store.gen; this._rebuildCache(); }
    if (!camera || !lodCfg) return;
    if (!this._lodDirty && !genChanged && this._sameLodCfg(lodCfg) && this._sameCamera(camera)) return;
    this._lastLod0 = lodCfg.lod0Distance;
    this._lastLod1 = lodCfg.lod1Distance;
    this._lastFade = lodCfg.fadeOutDistance;
    this._lastCam.set(camera.matrixWorld.elements);
    this._lastProj.set(camera.projectionMatrix.elements);
    this._lodDirty = false;
    this._assignLod(camera, lodCfg);
  }

  raycast(raycaster) {
    let best = null, bestDist = Infinity;
    for (let ti = 0; ti < this._typeRender.length; ti++) {
      const tr = this._typeRender[ti];
      if (!tr || !tr.hitboxIM || tr.hitboxIM.count === 0) continue;
      const hits = raycaster.intersectObject(tr.hitboxIM, false);
      if (hits.length > 0 && hits[0].distance < bestDist) {
        bestDist = hits[0].distance;
        const cacheIdx = tr._globalIndices?.[hits[0].instanceId];
        const storeIdx = cacheIdx != null ? this._cacheToStore[cacheIdx] : undefined;
        if (storeIdx != null) best = { instIdx: storeIdx, distance: bestDist };
      }
    }
    return best;
  }

  select(instIdx) {
    this._selectedIdx = instIdx;
    const inst = this.store.instances[instIdx];
    if (!inst) { this.clearSelection(); return; }
    const RAD_TO_DEG = Math.PI / 180;
    this.proxyObject.position.set(inst.px, inst.py, inst.pz);
    this.proxyObject.rotation.set(inst.rx * RAD_TO_DEG, inst.ry * RAD_TO_DEG, inst.rz * RAD_TO_DEG);
    this.proxyObject.scale.set(inst.sx, inst.sy, inst.sz);
    this.proxyObject.updateMatrix();
    this._updateSelectionBox(inst);
  }

  clearSelection() {
    this._selectedIdx          = -1;
    this._selectionBox.visible = false;
  }

  syncFromProxy() {
    if (this._selectedIdx < 0) return;
    const inst = this.store.instances[this._selectedIdx];
    if (!inst) return;
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

  _updateSelectionBox(inst) {
    const tr   = this._typeRender[inst.typeIdx];
    const type = this.store.types[inst.typeIdx];
    if (!tr || !type || type.live) { this._selectionBox.visible = false; return; }
    const boxCenter = new THREE.Vector3();
    type.mergedBox.getCenter(boxCenter);
    const DEG = Math.PI / 180;
    this._selectionBox.scale.set(tr.boxSize.x * inst.sx, tr.boxSize.y * inst.sy, tr.boxSize.z * inst.sz);
    this._selectionBox.position.set(inst.px, inst.py, inst.pz);
    this._selectionBox.rotation.set(inst.rx * DEG, inst.ry * DEG, inst.rz * DEG);
    const offset = boxCenter.clone().multiply(new THREE.Vector3(inst.sx, inst.sy, inst.sz));
    offset.applyEuler(this._selectionBox.rotation);
    this._selectionBox.position.add(offset);
    this._selectionBox.visible = true;
  }

  get selectedIdx()  { return this._selectedIdx; }
  get hasSelection() { return this._selectedIdx >= 0; }

  dispose() {
    for (let ti = 0; ti < this._typeRender.length; ti++) this.unregisterType(ti);
    this.scene.remove(this.proxyObject);
    this.scene.remove(this._selectionBox);
    this._selectionBox.geometry.dispose();
    this._selectionBox.material.dispose();
  }
}
