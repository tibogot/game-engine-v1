/**
 * TreeSystem — brush-based tree scattering and erasing with undo/redo.
 *
 * LMB: scatter trees of the active slot within the brush radius.
 * Alt+LMB: erase trees within the brush radius.
 * Follows the same beginStroke → applyAt → endStroke pattern as SculptSystem/PaintSystem.
 */
import * as THREE from "three";
import { shouldApplyStroke, SCATTER_DENSITY_SCALE } from "../sculpt/brushModel.js";

export class TreeSystem {
  constructor({ toolState, treeStore, terrainStore, config }) {
    this.toolState = toolState;
    this.treeStore = treeStore;
    this.terrainStore = terrainStore;
    this.config = config;
    this._slopeEps = 0.5;
    this.isPlacing = false;
    this.lastStrokePoint = null;
    /** @type {Map<string, Array>} */
    this.beforeMap = new Map();
    /** @type {{ before: Map, after: Map }[]} */
    this.undoStack = [];
    this.redoStack = [];
  }

  _snapshotAffected(wx, wz, radius) {
    const keys = this.treeStore.getChunkKeysInRadius(wx, wz, radius);
    for (const key of keys) {
      if (!this.beforeMap.has(key)) {
        const trees = this.treeStore.chunks.get(key);
        this.beforeMap.set(key, trees ? trees.map((t) => ({ ...t })) : []);
      }
    }
  }

  beginStroke(hitPoint, event = {}) {
    this.isPlacing = true;
    this.lastStrokePoint = null;
    this.beforeMap.clear();
    this.applyAt(hitPoint, event);
  }

  applyAt(hitPoint, event = {}) {
    if (!this.isPlacing) return;
    const brush = this.toolState.brush;
    if (
      !shouldApplyStroke(this.lastStrokePoint, hitPoint, brush.radius, brush.spacingFactor)
    ) {
      return;
    }
    this.lastStrokePoint = this.lastStrokePoint ?? new THREE.Vector3();
    this.lastStrokePoint.copy(hitPoint);

    const radius = brush.radius;
    this._snapshotAffected(hitPoint.x, hitPoint.z, radius);

    const isErase = event.altKey || this.toolState.treePaint.activeSlot < 0;

    if (isErase) {
      this.treeStore.removeTreesInRadius(hitPoint.x, hitPoint.z, radius);
    } else {
      this._scatter(hitPoint.x, hitPoint.z, radius);
    }
  }

  _terrainNormalY(x, z) {
    const e = this._slopeEps;
    const hL = this.terrainStore.getWorldHeight(x - e, z);
    const hR = this.terrainStore.getWorldHeight(x + e, z);
    const hD = this.terrainStore.getWorldHeight(x, z - e);
    const hU = this.terrainStore.getWorldHeight(x, z + e);
    const dx = hL - hR;
    const dz = hD - hU;
    const e2 = e * 2;
    return e2 / Math.sqrt(dx * dx + e2 * e2 + dz * dz);
  }

  _isTooSteep(x, z) {
    const tp = this.toolState.treePaint;
    if (!tp.slopeEnabled) return false;
    return this._terrainNormalY(x, z) < tp.slopeMax;
  }

  _scatter(wx, wz, radius) {
    const tp = this.toolState.treePaint;
    const slotIdx = tp.activeSlot;
    const baseScale = this.toolState.treeSlots[slotIdx]?.baseScale ?? 1.0;
    const spacing = tp.minSpacing * Math.max(baseScale, 0.1);
    const strength = THREE.MathUtils.clamp(this.toolState.brush.strength, 0, 1);
    const area = Math.PI * radius * radius;
    const attempts = Math.ceil(area * tp.density * SCATTER_DENSITY_SCALE * strength);

    for (let i = 0; i < attempts; i++) {
      const angle = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * radius;
      const tx = wx + Math.cos(angle) * r;
      const tz = wz + Math.sin(angle) * r;

      // Bounds check
      const halfW = this.config.world.size * 0.5;
      if (tx < -halfW || tx > halfW || tz < -halfW || tz > halfW) continue;

      if (this.treeStore.hasTreeNearby(tx, tz, spacing)) continue;
      if (this._isTooSteep(tx, tz)) continue;

      const rotY = tp.randomRotation ? Math.random() * Math.PI * 2 : 0;
      const scale =
        (tp.scaleMin + Math.random() * (tp.scaleMax - tp.scaleMin)) * baseScale;
      const y = this.terrainStore.getWorldHeight(tx, tz);
      this.treeStore.addTree(tx, tz, y, rotY, scale, slotIdx);
    }
  }

  endStroke() {
    if (!this.isPlacing) return;
    this.isPlacing = false;
    const touchedKeys = [...this.beforeMap.keys()];
    if (touchedKeys.length === 0) return;

    const afterMap = new Map();
    for (const key of touchedKeys) {
      const trees = this.treeStore.chunks.get(key);
      afterMap.set(key, trees ? trees.map((t) => ({ ...t })) : []);
    }

    this.undoStack.push({ before: new Map(this.beforeMap), after: afterMap });
    this.redoStack.length = 0;
    if (this.undoStack.length > 64) this.undoStack.shift();
    this.beforeMap.clear();
  }

  undo() {
    const cmd = this.undoStack.pop();
    if (!cmd) return;
    this.treeStore.restoreFromSnapshot(cmd.before);
    this.redoStack.push(cmd);
  }

  redo() {
    const cmd = this.redoStack.pop();
    if (!cmd) return;
    this.treeStore.restoreFromSnapshot(cmd.after);
    this.undoStack.push(cmd);
  }

  massPlace(count) {
    const tp = this.toolState.treePaint;
    const slotIdx = tp.activeSlot;
    if (slotIdx < 0) return;
    const baseScale = this.toolState.treeSlots[slotIdx]?.baseScale ?? 1.0;
    const spacing = tp.minSpacing * Math.max(baseScale, 0.1);
    const halfW = this.config.world.size * 0.5;

    const beforeKeys = new Set();
    for (const key of this.treeStore.chunks.keys()) beforeKeys.add(key);
    const before = new Map();
    for (const key of beforeKeys) {
      const trees = this.treeStore.chunks.get(key);
      before.set(key, trees ? trees.map((t) => ({ ...t })) : []);
    }

    if (!tp.massPlaceKeepExisting) {
      this.treeStore.clear();
    }

    let placed = 0;
    let maxAttempts = count * 20;
    while (placed < count && maxAttempts-- > 0) {
      const tx = (Math.random() - 0.5) * this.config.world.size;
      const tz = (Math.random() - 0.5) * this.config.world.size;

      if (tx < -halfW || tx > halfW || tz < -halfW || tz > halfW) continue;
      if (this.treeStore.hasTreeNearby(tx, tz, spacing)) continue;
      if (this._isTooSteep(tx, tz)) continue;

      const rotY = tp.randomRotation ? Math.random() * Math.PI * 2 : 0;
      const scale =
        (tp.scaleMin + Math.random() * (tp.scaleMax - tp.scaleMin)) * baseScale;
      const y = this.terrainStore.getWorldHeight(tx, tz);
      this.treeStore.addTree(tx, tz, y, rotY, scale, slotIdx);
      placed++;
    }

    const afterKeys = new Set(beforeKeys);
    for (const key of this.treeStore.chunks.keys()) afterKeys.add(key);
    for (const key of afterKeys) {
      if (!before.has(key)) before.set(key, []);
    }
    const after = new Map();
    for (const key of afterKeys) {
      const trees = this.treeStore.chunks.get(key);
      after.set(key, trees ? trees.map((t) => ({ ...t })) : []);
    }

    this.undoStack.push({ before, after });
    this.redoStack.length = 0;
    if (this.undoStack.length > 64) this.undoStack.shift();

    console.log(`[TreeSystem] Mass-placed ${placed} trees (requested ${count})`);
    return placed;
  }

  clearAll() {
    const before = new Map();
    for (const [key, trees] of this.treeStore.chunks) {
      before.set(key, trees.map((t) => ({ ...t })));
    }
    this.treeStore.clear();
    this.undoStack.push({ before, after: new Map() });
    this.redoStack.length = 0;
    if (this.undoStack.length > 64) this.undoStack.shift();
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }
  get canRedo() {
    return this.redoStack.length > 0;
  }
}
