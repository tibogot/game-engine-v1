import * as THREE from "three";

const DEG = Math.PI / 180;
const _dummy = new THREE.Object3D();
const _tmp = new THREE.Matrix4();

export class CliffStore {
  constructor() {
    this.types = [];
    this.instances = [];
    this._gen = 0;
  }

  get gen() { return this._gen; }

  _bump() { this._gen++; }

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
    this.types.push({ name, entries, mergedBox });
    return idx;
  }

  addInstance(typeIdx, px, py, pz) {
    const inst = {
      typeIdx,
      px, py, pz,
      rx: 0, ry: Math.round(Math.random() * 360), rz: 0,
      sx: 1, sy: 1, sz: 1,
    };
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
      if (!type) continue;
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

  get totalCount() { return this.instances.length; }

  snapshot() {
    return this.instances.map((i) => ({ ...i }));
  }

  restoreFromSnapshot(snap) {
    this.instances = snap.map((i) => ({ ...i }));
    this._bump();
  }

  exportData() {
    return {
      types: this.types.map((t) => t.name),
      instances: this.instances.map((i) => ({ ...i })),
    };
  }

  importData(data, typeNameToIdx) {
    for (const saved of data.instances) {
      const mappedIdx = typeNameToIdx?.[data.types[saved.typeIdx]];
      if (mappedIdx == null) continue;
      saved.typeIdx = mappedIdx;
      this.instances.push({ ...saved });
    }
    this._bump();
  }

  clear() {
    this.instances.length = 0;
    this._bump();
  }
}
