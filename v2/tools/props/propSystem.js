import * as THREE from "three";
import { shouldApplyStroke } from "../sculpt/brushModel.js";

export class PropSystem {
  constructor({ toolState, propStore, propInstancer, cliffBvh, terrainStore, config }) {
    this.toolState = toolState;
    this.store = propStore;
    this.instancer = propInstancer;
    this.bvh = cliffBvh;
    this.terrainStore = terrainStore;
    this.config = config;

    this._undoStack = [];
    this._redoStack = [];
    this._maxUndo = 64;

    this._painting = false;
    this._lastStrokePoint = null;
    this._beforeSnap = null;
  }

  _pushUndo(before) {
    const after = this.store.snapshot();
    this._undoStack.push({ before, after });
    this._redoStack.length = 0;
    if (this._undoStack.length > this._maxUndo) this._undoStack.shift();
  }

  handlePlace(hitPoint, typeIdx) {
    if (typeIdx == null || typeIdx < 0 || typeIdx >= this.store.types.length) return;

    const before = this.store.snapshot();
    const sinkOffset = this.toolState.props.sinkOffset || 0;
    const py = hitPoint.y - sinkOffset;
    const instIdx = this.store.addInstance(typeIdx, hitPoint.x, py, hitPoint.z);
    this._pushUndo(before);

    this.instancer.select(instIdx);
    if (this.bvh) this.bvh.invalidate();
    return instIdx;
  }

  handleSelect(raycaster) {
    const hit = this.instancer.raycast(raycaster);
    if (hit) {
      this.instancer.select(hit.instIdx);
    } else {
      this.instancer.clearSelection();
    }
    return hit;
  }

  handleDelete() {
    if (!this.instancer.hasSelection) return;
    const before = this.store.snapshot();
    const idx = this.instancer.selectedIdx;
    this.instancer.clearSelection();
    this.store.removeInstance(idx);
    this._pushUndo(before);
    if (this.bvh) this.bvh.invalidate();
  }

  /** Copies selected instance (transform + live params). Returns new index or null. */
  handleDuplicate() {
    if (!this.instancer.hasSelection) return null;
    this.instancer.syncFromProxy();
    const srcIdx = this.instancer.selectedIdx;
    const src = this.store.instances[srcIdx];
    if (!src) return null;
    const before = this.store.snapshot();
    const newIdx = this.store.duplicateInstance(srcIdx);
    this._pushUndo(before);
    if (this.bvh) this.bvh.invalidate();
    return newIdx;
  }

  handleTransformChange() {
    this.instancer.syncFromProxy();
  }

  handleTransformEnd() {
    if (this.bvh) this.bvh.invalidate();
  }

  // --- Brush paint mode ---

  beginStroke(hitPoint, event = {}) {
    this._painting = true;
    this._lastStrokePoint = null;
    this._beforeSnap = this.store.snapshot();
    this.applyAt(hitPoint, event);
  }

  applyAt(hitPoint, event = {}) {
    if (!this._painting) return;
    const brush = this.toolState.brush;
    if (!shouldApplyStroke(this._lastStrokePoint, hitPoint, brush.radius, brush.spacingFactor)) return;
    this._lastStrokePoint = this._lastStrokePoint ?? new THREE.Vector3();
    this._lastStrokePoint.copy(hitPoint);

    const radius = brush.radius;
    const isErase = event.altKey;

    if (isErase) {
      this.store.removeInRadius(hitPoint.x, hitPoint.z, radius);
    } else {
      this._scatter(hitPoint.x, hitPoint.z, radius);
    }
  }

  _scatter(wx, wz, radius) {
    const p = this.toolState.props;
    const typeIdx = this._getActiveTypeIdx();
    if (typeIdx == null) return;

    const spacing = p.minSpacing;
    const area = Math.PI * radius * radius;
    const attempts = Math.ceil(area * p.density * 0.01);
    const sinkOffset = p.sinkOffset || 0;
    const halfW = this.config.world.size * 0.5;

    for (let i = 0; i < attempts; i++) {
      const angle = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * radius;
      const tx = wx + Math.cos(angle) * r;
      const tz = wz + Math.sin(angle) * r;

      if (tx < -halfW || tx > halfW || tz < -halfW || tz > halfW) continue;
      if (this.store.hasNearby(tx, tz, spacing)) continue;

      const rotY = p.randomRotation ? Math.random() * 360 : 0;
      const scale = p.scaleMin + Math.random() * (p.scaleMax - p.scaleMin);
      const y = this.terrainStore.getWorldHeight(tx, tz) - sinkOffset;
      const instIdx = this.store.instances.length;
      this.store.instances.push({
        typeIdx, px: tx, py: y, pz: tz,
        rx: 0, ry: rotY, rz: 0,
        sx: scale, sy: scale, sz: scale,
      });
    }
    this.store._bump();
  }

  _getActiveTypeIdx() {
    const slotIdx = this.toolState.props.activeSlot;
    const slot = this.toolState.propSlots[slotIdx];
    return slot?.typeIdx ?? null;
  }

  endStroke() {
    if (!this._painting) return;
    this._painting = false;
    if (this._beforeSnap) {
      this._pushUndo(this._beforeSnap);
      this._beforeSnap = null;
    }
    if (this.bvh) this.bvh.invalidate();
  }

  clearAll() {
    const before = this.store.snapshot();
    this.instancer.clearSelection();
    this.store.clear();
    this._pushUndo(before);
    if (this.bvh) this.bvh.invalidate();
  }

  undo() {
    const cmd = this._undoStack.pop();
    if (!cmd) return;
    this.instancer.clearSelection();
    this.store.restoreFromSnapshot(cmd.before);
    this._redoStack.push(cmd);
    if (this.bvh) this.bvh.invalidate();
  }

  redo() {
    const cmd = this._redoStack.pop();
    if (!cmd) return;
    this.instancer.clearSelection();
    this.store.restoreFromSnapshot(cmd.after);
    this._undoStack.push(cmd);
    if (this.bvh) this.bvh.invalidate();
  }

  get canUndo() { return this._undoStack.length > 0; }
  get canRedo() { return this._redoStack.length > 0; }
}
