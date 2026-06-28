import * as THREE from "three";

const DEG = Math.PI / 180;

/**
 * Semi-transparent placement ghost for props Place (click) mode — matches v2.
 */
export class PropPlacementPreview {
  constructor(scene, propStore, liveGhostBuilder = null) {
    this.scene = scene;
    this.store = propStore;
    this._liveGhostBuilder = liveGhostBuilder;
    this._liveCache = new Map();

    this.group = new THREE.Group();
    this.group.name = "PropPlacementPreview";
    this.group.visible = false;
    this.group.renderOrder = 4;
    scene.add(this.group);

    this._ghostMat = new THREE.MeshBasicMaterial({
      color: 0x66ccff,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this._ghostMat.fog = false;

    this._builtTypeIdx = -1;
  }

  _clearMeshes() {
    for (const child of this.group.children) {
      if (!child.isGroup) child.geometry = null;
    }
    this.group.clear();
  }

  _ensureMeshes(typeIdx) {
    if (typeIdx === this._builtTypeIdx && this.group.children.length > 0) return true;
    this._clearMeshes();
    this._builtTypeIdx = typeIdx;

    const type = this.store.types[typeIdx];
    if (!type) return false;

    if (type.live) {
      if (!this._liveGhostBuilder || !type.factoryId) return false;
      let g = this._liveCache.get(typeIdx);
      if (!g) {
        g = this._liveGhostBuilder(type.factoryId);
        if (!g) return false;
        const lights = [];
        g.traverse((o) => {
          if (o.isMesh) o.material = this._ghostMat;
          if (o.isLight) lights.push(o);
        });
        for (const l of lights) l.parent?.remove(l);
        this._liveCache.set(typeIdx, g);
      }
      this.group.add(g);
      return true;
    }

    if (!type.entries?.length) return false;
    for (const { geometry, localMatrix } of type.entries) {
      const mesh = new THREE.Mesh(geometry, this._ghostMat);
      mesh.matrix.copy(localMatrix);
      mesh.matrixAutoUpdate = false;
      this.group.add(mesh);
    }
    return this.group.children.length > 0;
  }

  showAt(hit, typeIdx, stamp, sinkOffset = 0) {
    const point = hit?.point ?? hit;
    if (
      typeIdx == null ||
      typeIdx < 0 ||
      !point ||
      !this._ensureMeshes(typeIdx)
    ) {
      this.hide();
      return;
    }

    this.group.position.set(point.x, point.y - sinkOffset, point.z);
    const s = stamp ?? { rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 };
    this.group.rotation.set(s.rx * DEG, s.ry * DEG, s.rz * DEG);
    this.group.scale.set(s.sx, s.sy, s.sz);
    this.group.visible = true;
  }

  hide() {
    this.group.visible = false;
  }

  dispose() {
    this._clearMeshes();
    this._liveCache.clear();
    this.scene.remove(this.group);
    this._ghostMat.dispose();
  }
}
