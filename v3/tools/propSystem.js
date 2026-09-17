import * as THREE from "three";
import { shouldApplyStroke } from "../../v2/tools/sculpt/brushModel.js";

/**
 * V2-compatible props tool: Place (click + stamp) and Paint (brush scatter + Alt erase).
 */
export class PropSystem {
  constructor({ propState, propSlots, propBrush, propStore, propInstancer, getWorldHeight, worldSize, cliffBvh = null }) {
    this.propState = propState;
    this.propSlots = propSlots;
    this.propBrush = propBrush;
    this.store = propStore;
    this.instancer = propInstancer;
    this.getWorldHeight = getWorldHeight;
    this.worldSize = worldSize;
    this.bvh = cliffBvh;

    this._undoStack = [];
    this._redoStack = [];
    this._maxUndo = 64;

    this._painting = false;
    this._lastStrokePoint = null;
    this._beforeSnap = null;

    /** @type {Map<number, { rx: number, ry: number, rz: number, sx: number, sy: number, sz: number }>} */
    this._lastStampByType = new Map();

    /**
     * Optional paint override: `(wx, wz, radius) => instance records`. Set by
     * the app for multi-type brushes (the rock set); null = paint the active slot.
     */
    this.scatterPlanner = null;
  }

  _defaultStamp() {
    return { rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 };
  }

  _stampForType(typeIdx) {
    return this._lastStampByType.get(typeIdx) ?? this._defaultStamp();
  }

  stampForType(typeIdx) {
    return this._stampForType(typeIdx);
  }

  recordStampFromInstance(instIdx) {
    const inst = this.store.instances[instIdx];
    if (!inst || this.store.isLiveType(inst.typeIdx)) return;
    this._lastStampByType.set(inst.typeIdx, {
      rx: inst.rx,
      ry: inst.ry,
      rz: inst.rz,
      sx: inst.sx,
      sy: inst.sy,
      sz: inst.sz,
    });
  }

  _pushUndo(before) {
    const after = this.store.snapshot();
    this._undoStack.push({ before, after });
    this._redoStack.length = 0;
    if (this._undoStack.length > this._maxUndo) this._undoStack.shift();
  }

  /** Transforms of the selected props, as a string that changes when any of them moves. */
  _selectionTransformKey() {
    let s = "";
    for (const idx of this.instancer.selectedIndices) {
      const p = this.store.instances[idx];
      if (p) s += `${p.id}:${p.px},${p.py},${p.pz},${p.rx},${p.ry},${p.rz},${p.sx},${p.sy},${p.sz};`;
    }
    return s;
  }

  /**
   * Bracket a transform edit of the selection (a gizmo drag, an Inspector
   * field) so it becomes ONE undo step — and none if nothing actually moved,
   * e.g. a click on the gizmo that did not drag.
   */
  beginEdit() {
    if (this._editBefore || !this.instancer.hasSelection) return;
    this._editBefore = { snap: this.store.snapshot(), key: this._selectionTransformKey() };
  }

  endEdit() {
    const before = this._editBefore;
    this._editBefore = null;
    if (!before || this._selectionTransformKey() === before.key) return false;
    this._pushUndo(before.snap);
    if (this.bvh) this.bvh.invalidate();
    return true;
  }

  _getActiveTypeIdx() {
    const slotIdx = this.propState.activeSlot;
    const slot = this.propSlots[slotIdx];
    return slot?.typeIdx ?? null;
  }

  handlePlace(hitPoint, typeIdx) {
    if (typeIdx == null || typeIdx < 0 || typeIdx >= this.store.types.length) return null;

    const before = this.store.snapshot();
    const sinkOffset = this.propState.sinkOffset || 0;
    const py = hitPoint.y - sinkOffset;
    const stamp = this.store.isLiveType(typeIdx) ? null : this._stampForType(typeIdx);
    const instIdx = this.store.addInstance(typeIdx, hitPoint.x, py, hitPoint.z, stamp);
    this._pushUndo(before);
    this.recordStampFromInstance(instIdx);
    this.instancer.select(instIdx);
    if (this.bvh) this.bvh.invalidate();
    return instIdx;
  }

  handleSelect(raycaster) {
    const hit = this.instancer.raycast(raycaster);
    if (hit) this.instancer.select(hit.instIdx);
    else this.instancer.clearSelection();
    return hit;
  }

  handleDelete() {
    if (!this.instancer.hasSelection) return;
    const before = this.store.snapshot();
    // Descending order is required: removeInstance swap-removes with the last
    // element, so deleting the largest remaining index first stays correct.
    const indices = this.instancer.selectedIndices.sort((a, b) => b - a);
    this.instancer.clearSelection();
    for (const idx of indices) this.store.removeInstance(idx);
    this._pushUndo(before);
    if (this.bvh) this.bvh.invalidate();
  }

  handleDuplicate() {
    if (!this.instancer.hasSelection) return null;
    this.instancer.syncFromProxy();
    const srcIndices = this.instancer.selectedIndices;
    if (srcIndices.length === 0) return null;
    const before = this.store.snapshot();
    const newIndices = [];
    for (const src of srcIndices) {
      if (!this.store.instances[src]) continue;
      newIndices.push(this.store.duplicateInstance(src));
    }
    if (newIndices.length === 0) return null;
    this._pushUndo(before);
    const primary = newIndices[newIndices.length - 1];
    this.recordStampFromInstance(primary);
    // The copies become the new selection (single or group) so a duplicate can
    // immediately be dragged into place.
    this.instancer.setSelection(newIndices, primary);
    if (this.bvh) this.bvh.invalidate();
    return primary;
  }

  /**
   * Copy the selected props (Ctrl+C): types, transforms relative to their
   * centroid, live params. Returns a clipboard object, or null with nothing
   * selected.
   */
  copySelection() {
    if (!this.instancer.hasSelection) return null;
    this.instancer.syncFromProxy();
    const list = this.instancer.selectedIndices.map((i) => this.store.instances[i]).filter(Boolean);
    if (!list.length) return null;
    const c = { x: 0, y: 0, z: 0 };
    for (const p of list) { c.x += p.px; c.y += p.py; c.z += p.pz; }
    c.x /= list.length; c.y /= list.length; c.z /= list.length;
    const groundAtCentroid = this.getWorldHeight(c.x, c.z);
    return {
      heightAboveGround: c.y - groundAtCentroid,
      centroid: c,
      items: list.map((p) => ({
        typeIdx: p.typeIdx, dx: p.px - c.x, dy: p.py - c.y, dz: p.pz - c.z,
        rx: p.rx, ry: p.ry, rz: p.rz, sx: p.sx, sy: p.sy, sz: p.sz,
        liveParams: p.liveParams ? { ...p.liveParams } : undefined,
      })),
    };
  }

  /**
   * Paste a clipboard (Ctrl+V) centred on `at` (a terrain point) — or next to
   * where it was copied when there is no point — keeping the group's height
   * above the ground. The copies become the selection. One undo step.
   * @returns {number|null} slot of the primary pasted prop
   */
  paste(clip, at = null) {
    if (!clip?.items?.length) return null;
    const cx = at ? at.x : clip.centroid.x + 2;
    const cz = at ? at.z : clip.centroid.z + 2;
    const cy = this.getWorldHeight(cx, cz) + clip.heightAboveGround;
    const before = this.store.snapshot();
    const slots = [];
    for (const it of clip.items) {
      if (!this.store.types[it.typeIdx]) continue;
      slots.push(this.store.instances.length);
      this.store.instances.push({
        typeIdx: it.typeIdx, px: cx + it.dx, py: cy + it.dy, pz: cz + it.dz,
        rx: it.rx, ry: it.ry, rz: it.rz, sx: it.sx, sy: it.sy, sz: it.sz,
        ...(it.liveParams ? { liveParams: { ...it.liveParams } } : {}),
      });
    }
    if (!slots.length) return null;
    this.store._bump();
    this._pushUndo(before);
    const primary = slots[slots.length - 1];
    this.instancer.setSelection(slots, primary);
    if (this.bvh) this.bvh.invalidate();
    return primary;
  }

  handleTransformChange() {
    this.instancer.syncFromProxy();
  }

  handleTransformEnd() {
    if (this.instancer.hasSelection) {
      this.instancer.syncFromProxy();
      this.recordStampFromInstance(this.instancer.selectedIdx);
    }
    if (this.bvh) this.bvh.invalidate();
  }

  beginStroke(hitPoint, event = {}) {
    this._painting = true;
    this._lastStrokePoint = null;
    this._beforeSnap = this.store.snapshot();
    this.applyAt(hitPoint, event);
  }

  applyAt(hitPoint, event = {}) {
    if (!this._painting) return;
    const brush = this.propBrush;
    if (!shouldApplyStroke(this._lastStrokePoint, hitPoint, brush.radius, brush.spacingFactor)) return;
    this._lastStrokePoint = this._lastStrokePoint ?? new THREE.Vector3();
    this._lastStrokePoint.copy(hitPoint);

    const radius = brush.radius;
    if (event.altKey) {
      this.store.removeInRadius(hitPoint.x, hitPoint.z, radius);
    } else {
      this._scatter(hitPoint.x, hitPoint.z, radius);
    }
  }

  _scatter(wx, wz, radius) {
    if (this.scatterPlanner) {
      const planned = this.scatterPlanner(wx, wz, radius);
      if (!planned?.length) return;
      for (const rec of planned) this.store.instances.push(rec);
      this.store._bump();
      return;
    }
    const p = this.propState;
    const typeIdx = this._getActiveTypeIdx();
    if (typeIdx == null) return;

    const spacing = p.minSpacing;
    const area = Math.PI * radius * radius;
    const attempts = Math.ceil(area * p.density * 0.01);
    const sinkOffset = p.sinkOffset || 0;
    const halfW = this.worldSize * 0.5;

    for (let i = 0; i < attempts; i++) {
      const angle = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * radius;
      const tx = wx + Math.cos(angle) * r;
      const tz = wz + Math.sin(angle) * r;

      if (tx < -halfW || tx > halfW || tz < -halfW || tz > halfW) continue;
      if (this.store.hasNearby(tx, tz, spacing)) continue;

      const rotY = p.randomRotation ? Math.random() * 360 : 0;
      const scale = p.scaleMin + Math.random() * (p.scaleMax - p.scaleMin);
      const y = this.getWorldHeight(tx, tz) - sinkOffset;
      this.store.instances.push({
        typeIdx,
        px: tx,
        py: y,
        pz: tz,
        rx: 0,
        ry: rotY,
        rz: 0,
        sx: scale,
        sy: scale,
        sz: scale,
        ...(this.store.isLiveType(typeIdx)
          ? { liveParams: { ...this.store.types[typeIdx].defaultParams } }
          : {}),
      });
    }
    this.store._bump();
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
