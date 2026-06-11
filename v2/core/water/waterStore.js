/**
 * waterStore.js — Manages water body data (meshes, selection, lake cache).
 *
 * Keeps the scene-graph meshes + metadata in a flat array.
 * Provides add / remove / select / clear / export / import.
 */

import * as THREE from "three";

export class WaterStore {
  /** @type {THREE.Mesh[]} */
  bodies = [];

  /** @type {THREE.Mesh[]} — subset whose userData.waterStyle === "Lake" */
  _lakeBodies = [];

  /** @type {THREE.Mesh | null} */
  selected = null;

  /** @param {THREE.Scene} scene */
  constructor(scene) {
    this._scene = scene;
  }

  get lakeBodies() {
    return this._lakeBodies;
  }

  invalidateLakeCache() {
    this._lakeBodies = this.bodies.filter(
      (m) => m.userData.waterStyle === "Lake",
    );
  }

  add(mesh) {
    mesh.renderOrder = 2;
    mesh.frustumCulled = true;
    this._scene.add(mesh);
    this.bodies.push(mesh);
    this.invalidateLakeCache();
  }

  remove(mesh) {
    this._scene.remove(mesh);
    this.bodies = this.bodies.filter((m) => m !== mesh);
    if (this.selected === mesh) this.selected = null;
    this.invalidateLakeCache();
  }

  select(mesh) {
    this.selected = mesh;
  }

  deselect() {
    this.selected = null;
  }

  clear() {
    for (const m of this.bodies) this._scene.remove(m);
    this.bodies = [];
    this.selected = null;
    this._lakeBodies = [];
  }

  findRoot(object) {
    let obj = object;
    while (obj) {
      if (this.bodies.includes(obj)) return obj;
      obj = obj.parent;
    }
    return null;
  }

  exportData() {
    return this.bodies.map((m) => ({
      x: m.position.x,
      y: m.position.y,
      z: m.position.z,
      rx: m.rotation.x,
      ry: m.rotation.y,
      rz: m.rotation.z,
      sx: m.scale.x,
      sy: m.scale.y,
      sz: m.scale.z,
      waterStyle: m.userData.waterStyle ?? "Ocean",
    }));
  }
}
