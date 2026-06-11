import * as THREE from "three";

const DEG = Math.PI / 180;
const _dummy = new THREE.Object3D();

export class PropStore {
  constructor() {
    this.types = [];
    this.instances = [];
    this._gen = 0;
  }

  get gen() { return this._gen; }

  _bump() { this._gen++; }

  registerLiveType(name, factoryId, defaultParams, mergedBox) {
    const idx = this.types.length;
    this.types.push({ name, live: true, factoryId, defaultParams, mergedBox, entries: [] });
    return idx;
  }

  isLiveType(typeIdx) {
    return !!this.types[typeIdx]?.live;
  }

  registerPrimitive(name, geometry, material) {
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    const yShift = -geometry.boundingBox.min.y;
    if (yShift !== 0) geometry.translate(0, yShift, 0);
    geometry.computeBoundingBox();
    const localMatrix = new THREE.Matrix4();
    const mergedBox = geometry.boundingBox.clone();
    const entries = [{ geometry, material, localMatrix }];
    const idx = this.types.length;
    this.types.push({ name, entries, mergedBox, builtin: true });
    return idx;
  }

  registerType(gltfScene, name) {
    const entries = [];
    gltfScene.updateMatrixWorld(true);
    const rootInv = new THREE.Matrix4().copy(gltfScene.matrixWorld).invert();
    const mergedBox = new THREE.Box3();

    gltfScene.traverse((child) => {
      if (!child.isMesh) return;
      const localMatrix = new THREE.Matrix4().multiplyMatrices(rootInv, child.matrixWorld);
      const geo = child.geometry;
      if (!geo.boundingBox) geo.computeBoundingBox();
      const localBox = geo.boundingBox.clone().applyMatrix4(localMatrix);
      mergedBox.union(localBox);
      entries.push({ geometry: geo, material: child.material, localMatrix });
    });

    if (entries.length === 0) return -1;

    const idx = this.types.length;
    this.types.push({ name, entries, lod1Entries: null, lod2Entries: null, mergedBox });
    return idx;
  }

  registerTypeLod(typeIdx, lod, gltfScene) {
    const type = this.types[typeIdx];
    if (!type) return;

    const entries = [];
    gltfScene.updateMatrixWorld(true);
    const rootInv = new THREE.Matrix4().copy(gltfScene.matrixWorld).invert();

    gltfScene.traverse((child) => {
      if (!child.isMesh) return;
      const localMatrix = new THREE.Matrix4().multiplyMatrices(rootInv, child.matrixWorld);
      entries.push({ geometry: child.geometry, material: child.material, localMatrix });
    });

    if (entries.length === 0) return;

    const key = lod === 1 ? "lod1Entries" : "lod2Entries";
    type[key] = entries;
  }

  addInstance(typeIdx, px, py, pz) {
    const type = this.types[typeIdx];
    const inst = {
      typeIdx,
      px, py, pz,
      rx: 0, ry: type?.live ? 0 : Math.round(Math.random() * 360), rz: 0,
      sx: 1, sy: 1, sz: 1,
    };
    if (type?.live) inst.liveParams = { ...type.defaultParams };
    const idx = this.instances.length;
    this.instances.push(inst);
    this._bump();
    return idx;
  }

  /** Deep enough for editor round-trip; matches snapshot liveParams handling. */
  duplicateInstance(srcIdx, { dpx = 0.6, dpz = 0.6 } = {}) {
    const src = this.instances[srcIdx];
    if (!src) return -1;
    const inst = {
      typeIdx: src.typeIdx,
      px: src.px + dpx,
      py: src.py,
      pz: src.pz + dpz,
      rx: src.rx,
      ry: src.ry,
      rz: src.rz,
      sx: src.sx,
      sy: src.sy,
      sz: src.sz,
    };
    if (src.liveParams) inst.liveParams = { ...src.liveParams };
    const idx = this.instances.length;
    this.instances.push(inst);
    this._bump();
    return idx;
  }

  removeInstance(instIdx) {
    const last = this.instances.length - 1;
    if (instIdx !== last) {
      this.instances[instIdx] = this.instances[last];
    }
    this.instances.pop();
    this._bump();
  }

  updateInstance(instIdx, patch) {
    const inst = this.instances[instIdx];
    if (!inst) return;
    Object.assign(inst, patch);
    this._bump();
  }

  computeInstanceMatrix(inst) {
    _dummy.position.set(inst.px, inst.py, inst.pz);
    _dummy.rotation.order = "XYZ";
    _dummy.rotation.set(inst.rx * DEG, inst.ry * DEG, inst.rz * DEG);
    _dummy.scale.set(inst.sx, inst.sy, inst.sz);
    _dummy.updateMatrix();
    return _dummy.matrix;
  }

  forEachMeshInstance(cb) {
    const mat = new THREE.Matrix4();
    for (const inst of this.instances) {
      const type = this.types[inst.typeIdx];
      if (!type || type.live) continue;
      const M = this.computeInstanceMatrix(inst);
      for (const { geometry, localMatrix } of type.entries) {
        mat.multiplyMatrices(M, localMatrix);
        cb(geometry, mat);
      }
    }
  }

  getInstanceCountByType(typeIdx) {
    let n = 0;
    for (const inst of this.instances) {
      if (inst.typeIdx === typeIdx) n++;
    }
    return n;
  }

  hasNearby(px, pz, minDist) {
    const d2 = minDist * minDist;
    for (const inst of this.instances) {
      const dx = inst.px - px;
      const dz = inst.pz - pz;
      if (dx * dx + dz * dz < d2) return true;
    }
    return false;
  }

  removeInRadius(wx, wz, radius) {
    const r2 = radius * radius;
    let removed = false;
    for (let i = this.instances.length - 1; i >= 0; i--) {
      const inst = this.instances[i];
      const dx = inst.px - wx;
      const dz = inst.pz - wz;
      if (dx * dx + dz * dz < r2) {
        const last = this.instances.length - 1;
        if (i !== last) this.instances[i] = this.instances[last];
        this.instances.pop();
        removed = true;
      }
    }
    if (removed) this._bump();
    return removed;
  }

  get totalCount() { return this.instances.length; }

  snapshot() {
    return this.instances.map((i) => {
      const c = { ...i };
      if (c.liveParams) c.liveParams = { ...c.liveParams };
      return c;
    });
  }

  restoreFromSnapshot(snap) {
    this.instances = snap.map((i) => {
      const c = { ...i };
      if (c.liveParams) c.liveParams = { ...c.liveParams };
      return c;
    });
    this._bump();
  }

  exportData() {
    return {
      types: this.types.map((t) => ({ name: t.name, ...(t.live ? { live: true, factoryId: t.factoryId } : {}) })),
      instances: this.instances.map((i) => {
        const c = { ...i };
        if (c.liveParams) c.liveParams = { ...c.liveParams };
        return c;
      }),
    };
  }

  importData(data, typeNameToIdx) {
    for (const saved of data.instances) {
      const typeName = typeof data.types[saved.typeIdx] === "string"
        ? data.types[saved.typeIdx]
        : data.types[saved.typeIdx]?.name;
      const mappedIdx = typeNameToIdx?.[typeName];
      if (mappedIdx == null) continue;
      saved.typeIdx = mappedIdx;
      const c = { ...saved };
      if (c.liveParams) c.liveParams = { ...c.liveParams };
      this.instances.push(c);
    }
    this._bump();
  }

  clear() {
    this.instances.length = 0;
    this._bump();
  }
}
