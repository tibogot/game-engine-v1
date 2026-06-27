import * as THREE from "three";

const _ghostMat = new THREE.MeshBasicMaterial({
  color: 0x66ccff,
  transparent: true,
  opacity: 0.42,
  depthWrite: false,
  side: THREE.DoubleSide,
});

export class PropPlacementPreview {
  constructor(scene, propStore) {
    this.scene = scene;
    this.store = propStore;

    this._group    = new THREE.Group();
    this._group.visible = false;
    scene.add(this._group);

    this._typeIdx = -1;
    this._meshes  = [];
  }

  showAt(hitPoint, typeIdx) {
    this._ensureMeshes(typeIdx);
    this._group.position.copy(hitPoint);
    this._group.visible = true;
  }

  hide() {
    this._group.visible = false;
  }

  _ensureMeshes(typeIdx) {
    if (this._typeIdx === typeIdx) return;
    this._typeIdx = typeIdx;

    for (const m of this._meshes) {
      this._group.remove(m);
      // don't dispose shared geometry/material from the type
    }
    this._meshes = [];

    const type = this.store.types[typeIdx];
    if (!type) return;

    for (const { geometry, localMatrix } of type.entries) {
      const mesh = new THREE.Mesh(geometry, _ghostMat);
      mesh.applyMatrix4(localMatrix);
      mesh.frustumCulled = false;
      this._group.add(mesh);
      this._meshes.push(mesh);
    }
  }

  dispose() {
    for (const m of this._meshes) this._group.remove(m);
    this._meshes = [];
    this.scene.remove(this._group);
    _ghostMat.dispose();
  }
}
