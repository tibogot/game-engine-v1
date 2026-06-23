import * as THREE from "three";

const DEG = Math.PI / 180;

/**
 * Semi-transparent placement ghost for props Place (click) mode.
 * Reuses type geometry + local submesh matrices; transform comes from PropSystem stamp.
 */
export class PropPlacementPreview {
  constructor(scene, propStore, liveGhostBuilder = null) {
    this.scene = scene;
    this.store = propStore;
    // (factoryId) => THREE.Group | null — builds a ghost for LIVE prop types
    this._liveGhostBuilder = liveGhostBuilder;
    this._liveGhostRoot = null;

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
    if (this._liveGhostRoot) {
      // live ghost geometries are freshly built here — dispose them
      this._liveGhostRoot.traverse((o) => o.geometry?.dispose?.());
      this._liveGhostRoot = null;
    } else {
      for (const child of this.group.children) child.geometry = null; // shared store geo
    }
    this.group.clear();
  }

  _ensureMeshes(typeIdx) {
    if (typeIdx === this._builtTypeIdx) return this.group.children.length > 0;
    this._clearMeshes();
    this._builtTypeIdx = typeIdx;

    const type = this.store.types[typeIdx];
    if (!type) return false;

    // LIVE procedural prop → build the object once and ghost its materials
    if (type.live) {
      if (!this._liveGhostBuilder || !type.factoryId) return false;
      const g = this._liveGhostBuilder(type.factoryId);
      if (!g) return false;
      g.traverse((o) => {
        if (o.isMesh) o.material = this._ghostMat;
      });
      this._liveGhostRoot = g;
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

  /**
   * @param {{ point: THREE.Vector3 }} hit
   * @param {number} typeIdx
   * @param {{ rx: number, ry: number, rz: number, sx: number, sy: number, sz: number }} stamp
   * @param {number} sinkOffset
   */
  showAt(hit, typeIdx, stamp, sinkOffset = 0) {
    if (
      typeIdx == null ||
      typeIdx < 0 ||
      !hit?.point ||
      !this._ensureMeshes(typeIdx)
    ) {
      this.hide();
      return;
    }

    this.group.position.set(
      hit.point.x,
      hit.point.y - sinkOffset,
      hit.point.z,
    );
    this.group.rotation.set(
      stamp.rx * DEG,
      stamp.ry * DEG,
      stamp.rz * DEG,
    );
    this.group.scale.set(stamp.sx, stamp.sy, stamp.sz);
    this.group.visible = true;
  }

  hide() {
    this.group.visible = false;
  }

  invalidateType() {
    this._builtTypeIdx = -1;
    this._clearMeshes();
    this.hide();
  }

  dispose() {
    this._clearMeshes();
    this._ghostMat.dispose();
    this.scene.remove(this.group);
  }
}
