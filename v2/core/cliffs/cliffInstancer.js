import * as THREE from "three";

const _tmp = new THREE.Matrix4();
const _hitboxMat = new THREE.MeshBasicMaterial({ visible: false });
const _boxColor = new THREE.Color(0x00ffff);

export class CliffInstancer {
  constructor(scene, cliffStore, maxInstances = 500) {
    this.scene = scene;
    this.store = cliffStore;
    this.MAX = maxInstances;
    this._lastGen = -1;

    this._typeRender = [];
    this._selectedIdx = -1;

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

  onTypeRegistered(typeIdx) {
    const type = this.store.types[typeIdx];
    if (!type) return;

    const entries = [];
    for (const { geometry, material, localMatrix } of type.entries) {
      const im = new THREE.InstancedMesh(geometry, material, this.MAX);
      im.count = 0;
      im.castShadow = true;
      im.receiveShadow = true;
      im.frustumCulled = false;
      this.scene.add(im);
      entries.push({ im, localMatrix });
    }

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

    while (this._typeRender.length <= typeIdx) this._typeRender.push(null);
    this._typeRender[typeIdx] = { entries, hitboxIM, hitboxGeo, boxCenterMatrix, boxSize: boxSize.clone() };
  }

  rebuild() {
    if (this.store.gen === this._lastGen) return;
    this._lastGen = this.store.gen;

    const countsByType = new Map();
    const indicesByType = new Map();

    for (let i = 0; i < this.store.instances.length; i++) {
      const inst = this.store.instances[i];
      const ti = inst.typeIdx;
      if (!countsByType.has(ti)) {
        countsByType.set(ti, 0);
        indicesByType.set(ti, []);
      }
      indicesByType.get(ti).push(i);
    }

    for (let ti = 0; ti < this._typeRender.length; ti++) {
      const tr = this._typeRender[ti];
      if (!tr) continue;
      const globalIndices = indicesByType.get(ti) || [];
      const n = globalIndices.length;

      for (const { im, localMatrix } of tr.entries) {
        im.count = n;
        for (let j = 0; j < n; j++) {
          const inst = this.store.instances[globalIndices[j]];
          const M = this.store.computeInstanceMatrix(inst);
          _tmp.multiplyMatrices(M, localMatrix);
          im.setMatrixAt(j, _tmp);
        }
        im.instanceMatrix.needsUpdate = true;
      }

      tr.hitboxIM.count = n;
      for (let j = 0; j < n; j++) {
        const inst = this.store.instances[globalIndices[j]];
        const M = this.store.computeInstanceMatrix(inst);
        _tmp.multiplyMatrices(M, tr.boxCenterMatrix);
        tr.hitboxIM.setMatrixAt(j, _tmp);
      }
      tr.hitboxIM.instanceMatrix.needsUpdate = true;
      tr.hitboxIM.boundingSphere = null;
      tr.hitboxIM.boundingBox = null;

      tr._globalIndices = globalIndices;
    }
  }

  raycast(raycaster) {
    let best = null;
    let bestDist = Infinity;
    for (let ti = 0; ti < this._typeRender.length; ti++) {
      const tr = this._typeRender[ti];
      if (!tr || tr.hitboxIM.count === 0) continue;
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

  setMaterial(mat) {
    for (const tr of this._typeRender) {
      if (!tr) continue;
      for (const entry of tr.entries) {
        entry.im.material = mat;
      }
    }
  }

  update() {
    this.rebuild();
  }

  dispose() {
    for (const tr of this._typeRender) {
      if (!tr) continue;
      for (const { im } of tr.entries) {
        this.scene.remove(im);
        im.dispose();
      }
      this.scene.remove(tr.hitboxIM);
      tr.hitboxIM.dispose();
      tr.hitboxGeo.dispose();
    }
    this._typeRender.length = 0;
    this.scene.remove(this.proxyObject);
    this.scene.remove(this._selectionBox);
    this._selectionBox.geometry.dispose();
    this._selectionBox.material.dispose();
  }
}
