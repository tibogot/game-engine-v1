import * as THREE from "three";

const _tmp = new THREE.Matrix4();
const _hitboxMat = new THREE.MeshBasicMaterial({ visible: false });
const _boxColor = new THREE.Color(0xff8800);

const MAX_INSTANCES = 4096;

export class PropInstancer {
  constructor(scene, propStore, maxInstances = MAX_INSTANCES) {
    this.scene = scene;
    this.store = propStore;
    this.MAX = maxInstances;
    this._lastGen = -1;

    this._typeRender = [];
    this._selectedIdx = -1;

    // Matrix cache (rebuilt only when store gen changes)
    this._cacheCount = 0;
    this._cacheMats = null;
    this._cacheXs = null;
    this._cacheYs = null;
    this._cacheZs = null;
    this._cacheTypes = null;

    this._worldMat = new THREE.Matrix4();

    this.proxyObject = new THREE.Object3D();
    scene.add(this.proxyObject);

    this._selectionBox = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
      new THREE.LineBasicMaterial({ color: _boxColor, depthTest: true, transparent: true, opacity: 0.9 })
    );
    this._selectionBox.renderOrder = 0;
    this._selectionBox.visible = false;
    scene.add(this._selectionBox);
  }

  _createLodMeshes(entries, castShadow) {
    const meshes = [];
    for (const { geometry, material, localMatrix } of entries) {
      const im = new THREE.InstancedMesh(geometry, material, this.MAX);
      im.count = 0;
      im.castShadow = castShadow;
      im.receiveShadow = true;
      im.frustumCulled = false;
      this.scene.add(im);
      meshes.push({ im, localMatrix });
    }
    return meshes;
  }

  _disposeLodMeshes(meshes) {
    if (!meshes) return;
    for (const { im } of meshes) {
      this.scene.remove(im);
      im.dispose();
    }
  }

  onTypeRegistered(typeIdx) {
    const type = this.store.types[typeIdx];
    if (!type) return;

    while (this._typeRender.length <= typeIdx) this._typeRender.push(null);

    if (type.live) {
      const boxSize = new THREE.Vector3();
      const boxCenter = new THREE.Vector3();
      type.mergedBox.getSize(boxSize);
      type.mergedBox.getCenter(boxCenter);
      const boxCenterMatrix = new THREE.Matrix4().makeTranslation(boxCenter.x, boxCenter.y, boxCenter.z);
      this._typeRender[typeIdx] = {
        lod0: [], lod1: null, lod2: null,
        hitboxIM: null, hitboxGeo: null, boxCenterMatrix, boxSize: boxSize.clone(),
        _globalIndices: [], live: true,
      };
      return;
    }

    const lod0 = this._createLodMeshes(type.entries, true);

    const boxSize = new THREE.Vector3();
    const boxCenter = new THREE.Vector3();
    type.mergedBox.getSize(boxSize);
    type.mergedBox.getCenter(boxCenter);

    const hitboxGeo = new THREE.BoxGeometry(boxSize.x, boxSize.y, boxSize.z);
    const hitboxIM = new THREE.InstancedMesh(hitboxGeo, _hitboxMat, this.MAX);
    hitboxIM.count = 0;
    hitboxIM.frustumCulled = false;
    this.scene.add(hitboxIM);

    const boxCenterMatrix = new THREE.Matrix4().makeTranslation(boxCenter.x, boxCenter.y, boxCenter.z);

    this._typeRender[typeIdx] = {
      lod0,
      lod1: null,
      lod2: null,
      hitboxIM, hitboxGeo, boxCenterMatrix, boxSize: boxSize.clone(),
      _globalIndices: [],
    };
  }

  /** Swap the material on every LOD InstancedMesh for this type. Disposes the prior material. */
  setTypeMaterial(typeIdx, newMaterial) {
    const tr = this._typeRender[typeIdx];
    if (!tr) return;
    const seen = new Set();
    const lods = [tr.lod0, tr.lod1, tr.lod2];
    for (const lod of lods) {
      if (!lod) continue;
      for (const { im } of lod) {
        const prev = im.material;
        im.material = newMaterial;
        if (prev && prev !== newMaterial) seen.add(prev);
      }
    }
    for (const m of seen) m.dispose?.();
  }

  onTypeLodRegistered(typeIdx, lod) {
    const type = this.store.types[typeIdx];
    if (!type) return;
    const tr = this._typeRender[typeIdx];
    if (!tr) return;

    const key = lod === 1 ? "lod1" : "lod2";
    const entriesKey = lod === 1 ? "lod1Entries" : "lod2Entries";
    const entries = type[entriesKey];
    if (!entries) return;

    this._disposeLodMeshes(tr[key]);
    tr[key] = this._createLodMeshes(entries, false);
  }

  setCastShadow(on) {
    for (const tr of this._typeRender) {
      if (!tr) continue;
      for (const { im } of tr.lod0) im.castShadow = on;
    }
  }

  // --- Matrix cache (rebuilt when store.gen changes) ---

  _rebuildCache() {
    const n = this.store.instances.length;
    if (!this._cacheMats || this._cacheMats.length < n * 16) {
      const cap = Math.max(n * 2, 128);
      this._cacheMats = new Float32Array(cap * 16);
      this._cacheXs = new Float32Array(cap);
      this._cacheYs = new Float32Array(cap);
      this._cacheZs = new Float32Array(cap);
      this._cacheTypes = new Uint16Array(cap);
    }
    this._cacheCount = n;

    for (let i = 0; i < n; i++) {
      const inst = this.store.instances[i];
      this._cacheTypes[i] = inst.typeIdx;
      this._cacheXs[i] = inst.px;
      this._cacheYs[i] = inst.py;
      this._cacheZs[i] = inst.pz;

      const M = this.store.computeInstanceMatrix(inst);
      const e = M.elements;
      const off = i * 16;
      for (let j = 0; j < 16; j++) this._cacheMats[off + j] = e[j];
    }

    // Rebuild hitboxes (always all instances for raycasting)
    const indicesByType = new Map();
    for (let i = 0; i < n; i++) {
      const ti = this._cacheTypes[i];
      if (!indicesByType.has(ti)) indicesByType.set(ti, []);
      indicesByType.get(ti).push(i);
    }

    const wm = this._worldMat;
    for (let ti = 0; ti < this._typeRender.length; ti++) {
      const tr = this._typeRender[ti];
      if (!tr) continue;
      const indices = indicesByType.get(ti) || [];
      tr._globalIndices = indices;

      if (tr.live || !tr.hitboxIM) continue;

      const len = indices.length;
      tr.hitboxIM.count = len;
      for (let j = 0; j < len; j++) {
        const off = indices[j] * 16;
        const e = wm.elements;
        for (let k = 0; k < 16; k++) e[k] = this._cacheMats[off + k];
        _tmp.multiplyMatrices(wm, tr.boxCenterMatrix);
        tr.hitboxIM.setMatrixAt(j, _tmp);
      }
      tr.hitboxIM.instanceMatrix.needsUpdate = true;
      tr.hitboxIM.boundingSphere = null;
      tr.hitboxIM.boundingBox = null;
    }
  }

  // --- Per-frame LOD assignment ---

  _assignLod(camera, lodCfg) {
    for (const tr of this._typeRender) {
      if (!tr) continue;
      for (const e of tr.lod0) e.im.count = 0;
      if (tr.lod1) for (const e of tr.lod1) e.im.count = 0;
      if (tr.lod2) for (const e of tr.lod2) e.im.count = 0;
    }

    const camX = camera.position.x;
    const camY = camera.position.y;
    const camZ = camera.position.z;
    const lod0D2 = lodCfg.lod0Distance * lodCfg.lod0Distance;
    const lod1D2 = lodCfg.lod1Distance * lodCfg.lod1Distance;
    const fadeD2 = lodCfg.fadeOutDistance * lodCfg.fadeOutDistance;

    const typeCounts = [];
    for (let i = 0; i < this._typeRender.length; i++) {
      typeCounts.push(this._typeRender[i] ? { lod0: 0, lod1: 0, lod2: 0 } : null);
    }

    const n = this._cacheCount;
    const wm = this._worldMat;

    for (let i = 0; i < n; i++) {
      const ti = this._cacheTypes[i];
      if (ti >= this._typeRender.length) continue;
      const tr = this._typeRender[ti];
      if (!tr || tr.live) continue;

      const dx = this._cacheXs[i] - camX;
      const dy = this._cacheYs[i] - camY;
      const dz = this._cacheZs[i] - camZ;
      const dist2 = dx * dx + dy * dy + dz * dz;

      if (dist2 > fadeD2) continue;

      let lodArr, lodKey;
      if (dist2 <= lod0D2) {
        lodArr = tr.lod0;
        lodKey = "lod0";
      } else if (dist2 <= lod1D2) {
        lodArr = tr.lod1 || tr.lod0;
        lodKey = tr.lod1 ? "lod1" : "lod0";
      } else {
        lodArr = tr.lod2 || tr.lod1 || tr.lod0;
        lodKey = tr.lod2 ? "lod2" : tr.lod1 ? "lod1" : "lod0";
      }

      const c = typeCounts[ti];
      const idx = c[lodKey];
      if (idx >= this.MAX) continue;

      const off = i * 16;
      const e = wm.elements;
      for (let j = 0; j < 16; j++) e[j] = this._cacheMats[off + j];

      for (const entry of lodArr) {
        _tmp.multiplyMatrices(wm, entry.localMatrix);
        entry.im.setMatrixAt(idx, _tmp);
      }

      c[lodKey]++;
    }

    for (let ti = 0; ti < this._typeRender.length; ti++) {
      const tr = this._typeRender[ti];
      if (!tr) continue;
      const c = typeCounts[ti];
      if (!c) continue;

      for (const e of tr.lod0) {
        if (e.im.count !== c.lod0 || c.lod0 > 0) {
          e.im.count = c.lod0;
          e.im.instanceMatrix.needsUpdate = true;
        }
      }
      if (tr.lod1) {
        for (const e of tr.lod1) {
          if (e.im.count !== c.lod1 || c.lod1 > 0) {
            e.im.count = c.lod1;
            e.im.instanceMatrix.needsUpdate = true;
          }
        }
      }
      if (tr.lod2) {
        for (const e of tr.lod2) {
          if (e.im.count !== c.lod2 || c.lod2 > 0) {
            e.im.count = c.lod2;
            e.im.instanceMatrix.needsUpdate = true;
          }
        }
      }
    }
  }

  _assignAllLod0() {
    for (const tr of this._typeRender) {
      if (!tr || tr.live) continue;
      const indices = tr._globalIndices;
      const n = indices.length;
      for (const { im, localMatrix } of tr.lod0) {
        im.count = n;
        const wm = this._worldMat;
        for (let j = 0; j < n; j++) {
          const off = indices[j] * 16;
          const e = wm.elements;
          for (let k = 0; k < 16; k++) e[k] = this._cacheMats[off + k];
          _tmp.multiplyMatrices(wm, localMatrix);
          im.setMatrixAt(j, _tmp);
        }
        im.instanceMatrix.needsUpdate = true;
      }
    }
  }

  // --- Public API ---

  update(camera, lodCfg) {
    const genChanged = this.store.gen !== this._lastGen;
    if (genChanged) {
      this._lastGen = this.store.gen;
      this._rebuildCache();
    }

    if (camera && lodCfg) {
      this._assignLod(camera, lodCfg);
    } else if (genChanged) {
      this._assignAllLod0();
    }
  }

  raycast(raycaster) {
    let best = null;
    let bestDist = Infinity;
    for (let ti = 0; ti < this._typeRender.length; ti++) {
      const tr = this._typeRender[ti];
      if (!tr || !tr.hitboxIM || tr.hitboxIM.count === 0) continue;
      const hits = raycaster.intersectObject(tr.hitboxIM, false);
      if (hits.length > 0 && hits[0].distance < bestDist) {
        bestDist = hits[0].distance;
        const localIdx = hits[0].instanceId;
        const globalIdx = tr._globalIndices?.[localIdx];
        if (globalIdx != null) {
          best = { instIdx: globalIdx, distance: bestDist };
        }
      }
    }
    return best;
  }

  select(instIdx) {
    this._selectedIdx = instIdx;
    const inst = this.store.instances[instIdx];
    if (!inst) {
      this.clearSelection();
      return;
    }
    const DEG = Math.PI / 180;
    this.proxyObject.position.set(inst.px, inst.py, inst.pz);
    this.proxyObject.rotation.set(inst.rx * DEG, inst.ry * DEG, inst.rz * DEG);
    this.proxyObject.scale.set(inst.sx, inst.sy, inst.sz);
    this.proxyObject.updateMatrix();
    this._updateSelectionBox(inst);
  }

  clearSelection() {
    this._selectedIdx = -1;
    this._selectionBox.visible = false;
  }

  get selectedIdx() { return this._selectedIdx; }
  get hasSelection() { return this._selectedIdx >= 0; }

  syncFromProxy() {
    if (this._selectedIdx < 0) return;
    const inst = this.store.instances[this._selectedIdx];
    if (!inst) return;
    const DEG = Math.PI / 180;
    inst.px = this.proxyObject.position.x;
    inst.py = this.proxyObject.position.y;
    inst.pz = this.proxyObject.position.z;
    inst.rx = this.proxyObject.rotation.x / DEG;
    inst.ry = this.proxyObject.rotation.y / DEG;
    inst.rz = this.proxyObject.rotation.z / DEG;
    inst.sx = this.proxyObject.scale.x;
    inst.sy = this.proxyObject.scale.y;
    inst.sz = this.proxyObject.scale.z;
    this.store._bump();
    this._updateSelectionBox(inst);
  }

  _updateSelectionBox(inst) {
    const type = this.store.types[inst.typeIdx];
    if (!type) { this._selectionBox.visible = false; return; }

    const tr = this._typeRender[inst.typeIdx];
    if (!tr) { this._selectionBox.visible = false; return; }

    const boxSize = tr.boxSize;
    const boxCenter = new THREE.Vector3();
    type.mergedBox.getCenter(boxCenter);

    const DEG = Math.PI / 180;
    this._selectionBox.scale.set(
      boxSize.x * inst.sx,
      boxSize.y * inst.sy,
      boxSize.z * inst.sz
    );
    this._selectionBox.position.set(inst.px, inst.py, inst.pz);
    this._selectionBox.rotation.set(inst.rx * DEG, inst.ry * DEG, inst.rz * DEG);

    const offset = boxCenter.clone();
    offset.multiply(new THREE.Vector3(inst.sx, inst.sy, inst.sz));
    offset.applyEuler(this._selectionBox.rotation);
    this._selectionBox.position.add(offset);

    this._selectionBox.visible = true;
  }

  getVisibleCounts() {
    const out = [];
    for (const tr of this._typeRender) {
      if (!tr) { out.push({ lod0: 0, lod1: 0, lod2: 0 }); continue; }
      let l0 = 0, l1 = 0, l2 = 0;
      if (tr.lod0.length) l0 = tr.lod0[0].im.count;
      if (tr.lod1?.length) l1 = tr.lod1[0].im.count;
      if (tr.lod2?.length) l2 = tr.lod2[0].im.count;
      out.push({ lod0: l0, lod1: l1, lod2: l2 });
    }
    return out;
  }

  dispose() {
    for (const tr of this._typeRender) {
      if (!tr) continue;
      this._disposeLodMeshes(tr.lod0);
      this._disposeLodMeshes(tr.lod1);
      this._disposeLodMeshes(tr.lod2);
      if (tr.hitboxIM) {
        this.scene.remove(tr.hitboxIM);
        tr.hitboxIM.dispose();
      }
      if (tr.hitboxGeo) tr.hitboxGeo.dispose();
    }
    this._typeRender.length = 0;
    this.scene.remove(this.proxyObject);
    this.scene.remove(this._selectionBox);
    this._selectionBox.geometry.dispose();
    this._selectionBox.material.dispose();
  }
}
