/**
 * v3/tools/lakeSystem.js — bounds-quad lakes.
 *
 * A lake is a horizontal quad plus a water level. It has no authored outline:
 * lakeMaterial.js discards every fragment where the scene depth buffer says the
 * terrain is at or in front of the water plane, so the shoreline is derived per
 * pixel and re-derives itself the moment the terrain is sculpted. Drag out a
 * rough rectangle over a basin, set the level, done.
 *
 * All lakes share one material (toolState.lake is global, only bounds + level
 * are per-lake), so the whole system is one shader program and N draw calls.
 *
 * Caveat: because the material refracts a single shared grab of the backbuffer,
 * two lakes that overlap in screen space will not refract each other correctly.
 * Lakes at different levels in different basins never do.
 */

import * as THREE from "three";
import { createLakeMaterial } from "../render/water/lakeMaterial.js";
import { lakeParamsFromToolState } from "../app/state/lakeState.js";

/** Below this the drag was a click, not a rectangle. */
const MIN_SIZE = 4;

const ACTIVE_COLOR   = 0x4fd8ff;
const INACTIVE_COLOR = 0x2a7f96;
const PREVIEW_COLOR  = 0xffd24f;

function makeOutline(color) {
  // Unit square in XZ, centred on the origin; scaled/positioned per lake.
  // THREE.Line with an explicit closing point, NOT LineLoop — WebGPURenderer
  // rejects LineLoop outright (see Renderer.js "Objects of type THREE.LineLoop
  // are not supported").
  const g = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-0.5, 0, -0.5),
    new THREE.Vector3( 0.5, 0, -0.5),
    new THREE.Vector3( 0.5, 0,  0.5),
    new THREE.Vector3(-0.5, 0,  0.5),
    new THREE.Vector3(-0.5, 0, -0.5),
  ]);
  const line = new THREE.Line(g, new THREE.LineBasicMaterial({
    color, depthTest: false, transparent: true, opacity: 0.9,
  }));
  line.renderOrder = 900;
  return line;
}

export class LakeSystem {
  /**
   * @param {object}   deps
   * @param {THREE.Scene} deps.scene
   * @param {object}   deps.toolState        — object with a `.lake` slice
   * @param {THREE.Texture} deps.normalMap   — tiling water normal map
   * @param {function} deps.sampleTerrainHeight — (u, v) => metres
   * @param {number}   deps.worldSize
   */
  constructor({ scene, toolState, normalMap, sampleTerrainHeight, worldSize }) {
    this.scene = scene;
    this.toolState = toolState;
    this.sampleTerrainHeight = sampleTerrainHeight;
    this.worldSize = worldSize;

    /** @type {{cx:number,cz:number,sizeX:number,sizeZ:number,level:number,mesh:THREE.Mesh,outline:THREE.Line}[]} */
    this.lakes = [];
    this.editActive = false;

    this.group = new THREE.Group();
    this.group.name = "Lakes";
    scene.add(this.group);

    this.handleGroup = new THREE.Group();   // outlines; named to match river/spline convention
    this.handleGroup.name = "LakeBounds";
    this.handleGroup.visible = false;
    scene.add(this.handleGroup);

    this._water = createLakeMaterial({ normalMap });
    this._geometry = new THREE.PlaneGeometry(1, 1);
    this._geometry.rotateX(-Math.PI / 2);   // bake the rotation, so mesh.scale maps to world XZ

    this._preview = makeOutline(PREVIEW_COLOR);
    this._preview.visible = false;
    this.handleGroup.add(this._preview);

    this._drag = null;   // { x0, z0, x1, z1, level }

    this.syncMaterial();
  }

  // ── Material ──────────────────────────────────────────────────────────────

  /** Push toolState.lake into the shared material. */
  syncMaterial() {
    this._water.syncParams(lakeParamsFromToolState(this.toolState.lake));
  }

  update(dt, elapsed) {
    if (this.lakes.length === 0) return;
    this._water.update(dt, elapsed);
  }

  setSunDir(v)                { this._water.setSunDir(v); }
  setSkyColors(zenith, horizon) { this._water.setSkyColors(zenith, horizon); }

  // ── Selection ─────────────────────────────────────────────────────────────

  get active() {
    return this.lakes[this._activeIdx()] ?? null;
  }

  _activeIdx() {
    if (this.lakes.length === 0) return -1;
    const i = this.toolState.lake.activeIndex | 0;
    return Math.min(Math.max(i, 0), this.lakes.length - 1);
  }

  _clampActive() {
    this.toolState.lake.activeIndex = Math.max(0, this._activeIdx());
  }

  setActiveIndex(i) {
    this.toolState.lake.activeIndex = i;
    this._clampActive();
    this._refreshOutlines();
  }

  // ── Editing ───────────────────────────────────────────────────────────────

  setEditActive(on) {
    this.editActive = !!on;
    this.handleGroup.visible = this.editActive && this.toolState.lake.showBounds;
    if (!this.editActive) this.cancelDrag();
  }

  /** Terrain height at the clicked point becomes the new lake's water level. */
  beginDrag(wx, wz) {
    const u = (wx + this.worldSize / 2) / this.worldSize;
    const v = (wz + this.worldSize / 2) / this.worldSize;
    this._drag = { x0: wx, z0: wz, x1: wx, z1: wz, level: this.sampleTerrainHeight(u, v) };
    this._preview.visible = true;
    this._syncPreview();
  }

  updateDrag(wx, wz) {
    if (!this._drag) return;
    this._drag.x1 = wx;
    this._drag.z1 = wz;
    this._syncPreview();
  }

  /** @returns {boolean} true if a lake was created */
  endDrag() {
    const d = this._drag;
    this._drag = null;
    this._preview.visible = false;
    if (!d) return false;

    const sizeX = Math.abs(d.x1 - d.x0);
    const sizeZ = Math.abs(d.z1 - d.z0);
    if (sizeX < MIN_SIZE || sizeZ < MIN_SIZE) return false;

    this.addLake({
      cx: (d.x0 + d.x1) / 2,
      cz: (d.z0 + d.z1) / 2,
      sizeX, sizeZ,
      level: d.level,
    });
    return true;
  }

  cancelDrag() {
    this._drag = null;
    this._preview.visible = false;
  }

  _syncPreview() {
    const d = this._drag;
    if (!d) return;
    this._preview.position.set((d.x0 + d.x1) / 2, d.level, (d.z0 + d.z1) / 2);
    this._preview.scale.set(
      Math.max(Math.abs(d.x1 - d.x0), 0.01), 1,
      Math.max(Math.abs(d.z1 - d.z0), 0.01),
    );
  }

  addLake({ cx, cz, sizeX, sizeZ, level }) {
    const mesh = new THREE.Mesh(this._geometry, this._water.material);
    mesh.frustumCulled = false;
    // Opaque queue, but after every other opaque: the grabbed backbuffer must
    // already hold the terrain we are going to refract and absorb through.
    mesh.renderOrder = 100;
    this.group.add(mesh);

    const outline = makeOutline(INACTIVE_COLOR);
    this.handleGroup.add(outline);

    const lake = { cx, cz, sizeX, sizeZ, level, mesh, outline };
    this.lakes.push(lake);
    this.toolState.lake.activeIndex = this.lakes.length - 1;
    this._syncLake(lake);
    this._refreshOutlines();
    return lake;
  }

  deleteActive() {
    const i = this._activeIdx();
    if (i < 0) return false;
    const [lake] = this.lakes.splice(i, 1);
    this.group.remove(lake.mesh);
    this.handleGroup.remove(lake.outline);
    lake.outline.geometry.dispose();
    lake.outline.material.dispose();
    this._clampActive();
    this._refreshOutlines();
    return true;
  }

  clear() {
    while (this.lakes.length) {
      this.toolState.lake.activeIndex = 0;
      this.deleteActive();
    }
  }

  /** Panel changed the active lake's bounds or level. */
  syncActiveTransform() {
    const lake = this.active;
    if (lake) this._syncLake(lake);
  }

  _syncLake(lake) {
    lake.mesh.position.set(lake.cx, lake.level, lake.cz);
    lake.mesh.scale.set(lake.sizeX, 1, lake.sizeZ);
    lake.outline.position.copy(lake.mesh.position);
    lake.outline.scale.copy(lake.mesh.scale);
  }

  _refreshOutlines() {
    const activeIdx = this._activeIdx();
    this.lakes.forEach((lake, i) => {
      lake.outline.material.color.setHex(i === activeIdx ? ACTIVE_COLOR : INACTIVE_COLOR);
    });
    this.handleGroup.visible = this.editActive && this.toolState.lake.showBounds;
  }

  /** Call after showBounds toggles. */
  refreshBoundsVisibility() { this._refreshOutlines(); }

  // ── Persistence ───────────────────────────────────────────────────────────

  exportData() {
    const lp = this.toolState.lake;
    return {
      params: { ...lp },
      lakes: this.lakes.map(({ cx, cz, sizeX, sizeZ, level }) => ({ cx, cz, sizeX, sizeZ, level })),
    };
  }

  importData(data) {
    this.clear();
    if (!data) return;
    if (data.params) {
      // Only adopt keys we still know about — old projects may carry retired ones.
      for (const k of Object.keys(this.toolState.lake)) {
        if (data.params[k] !== undefined) this.toolState.lake[k] = data.params[k];
      }
      this.syncMaterial();
    }
    for (const l of data.lakes ?? []) this.addLake(l);
    this.toolState.lake.activeIndex = 0;
    this._clampActive();
    this._refreshOutlines();
  }

  dispose() {
    this.clear();
    this.handleGroup.remove(this._preview);
    this._preview.geometry.dispose();
    this._preview.material.dispose();
    this.scene.remove(this.group);
    this.scene.remove(this.handleGroup);
    this._geometry.dispose();
    this._water.material.dispose();
  }
}
