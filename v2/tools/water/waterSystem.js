/**
 * waterSystem.js — Water body placement, selection, deletion, and transform control.
 *
 * Manages the lifecycle of water body meshes: click-to-place, click-to-select,
 * transform gizmo (translate/rotate/scale), delete, and JSON import/export.
 */

import * as THREE from "three";

const WATER_PRESETS = {
  Puddle:       { w: 3,  l: 3  },
  "Small lake": { w: 20, l: 20 },
  "Large lake": { w: 60, l: 60 },
  "River strip": { w: 8,  l: 50 },
};

export class WaterSystem {
  /**
   * @param {object} deps
   * @param {import("../../core/water/waterStore.js").WaterStore} deps.waterStore
   * @param {import("../../render/water/waterMaterial.js")} deps.waterMaterials — { makeGeo, makeMat }
   * @param {object} deps.toolState
   * @param {THREE.TransformControls} deps.transformControls
   */
  constructor({ waterStore, waterMaterials, toolState, transformControls }) {
    this._store = waterStore;
    this._mat = waterMaterials;
    this._ts = toolState;
    this._tc = transformControls;
    this._raycaster = new THREE.Raycaster();
  }

  place(wx, wy, wz) {
    const p = this._ts.water;
    const preset = WATER_PRESETS[p.preset] ?? WATER_PRESETS["Small lake"];
    const geo = this._mat.makeGeo(preset.w, preset.l, p.style);
    const mat = this._mat.makeMat(p.style);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.userData.waterStyle = p.style;
    mesh.position.set(wx, wy + p.sinkOffset, wz);
    this._store.add(mesh);
    this.select(mesh);
    return mesh;
  }

  select(mesh) {
    this._store.select(mesh);
    if (mesh) {
      this._tc.enabled = true;
      this._tc.visible = true;
      this._tc.attach(mesh);
    }
  }

  deselect() {
    this._store.deselect();
    this._tc.detach();
    this._tc.enabled = false;
    this._tc.visible = false;
  }

  deleteSelected() {
    const sel = this._store.selected;
    if (!sel) return;
    this._store.remove(sel);
    this.deselect();
  }

  clearAll() {
    this.deselect();
    this._store.clear();
  }

  /**
   * Handle pointer-down in water mode.
   * @param {THREE.Vector2} pointerNdc
   * @param {THREE.Camera} camera
   * @param {{ x: number, y: number, z: number } | null} terrainHit
   * @returns {boolean} true if event was consumed
   */
  handlePointerDown(pointerNdc, camera, terrainHit) {
    if (this._tc.dragging) return false;

    this._raycaster.setFromCamera(pointerNdc, camera);
    const hits = this._raycaster.intersectObjects(this._store.bodies, false);
    if (hits.length > 0) {
      const root = this._store.findRoot(hits[0].object) ?? hits[0].object;
      this.select(root);
      return true;
    }

    if (terrainHit) {
      this.place(terrainHit.x, terrainHit.y, terrainHit.z);
      return true;
    }
    return false;
  }

  setTransformMode(mode) {
    this._tc.setMode(mode);
  }

  saveJSON() {
    const data = this._store.exportData();
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: "application/json",
    });
    const a = document.createElement("a");
    a.download = "water-bodies.json";
    a.href = URL.createObjectURL(blob);
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 100);
  }

  loadJSON(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const data = JSON.parse(ev.target.result);
          this.applyBodies(data);
          resolve();
        } catch (err) {
          reject(err);
        }
      };
      reader.readAsText(file);
    });
  }

  applyBodies(data) {
    this.clearAll();
    for (const d of data) {
      const style = d.waterStyle ?? "Ocean";
      const geo = this._mat.makeGeo(1, 1, style);
      const mat = this._mat.makeMat(style);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.userData.waterStyle = style;
      mesh.position.set(d.x, d.y, d.z);
      mesh.rotation.set(d.rx, d.ry, d.rz);
      mesh.scale.set(d.sx, d.sy, d.sz);
      this._store.add(mesh);
    }
  }

  // Undo/redo stubs (water is placement-based, not stroke-based)
  undo() {}
  redo() {}
}
