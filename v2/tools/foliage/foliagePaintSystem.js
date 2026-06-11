/**
 * FoliagePaintSystem — brush-based billboard foliage scattering and erasing with undo/redo.
 *
 * LMB: scatter foliage of the active slot within the brush radius.
 * Alt/Shift+LMB (or Erase toggle): remove foliage in brush — active slot only by default.
 * Enable eraseAllSlots to remove every type in the brush (old behavior).
 * Follows the same beginStroke → applyAt → endStroke pattern as TreeSystem.
 */
import * as THREE from "three";
import { shouldApplyStroke, SCATTER_DENSITY_SCALE } from "../sculpt/brushModel.js";

export class FoliagePaintSystem {
  constructor({ toolState, foliageStore, terrainStore, config }) {
    this.toolState = toolState;
    this.foliageStore = foliageStore;
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
    const keys = this.foliageStore.getChunkKeysInRadius(wx, wz, radius);
    for (const key of keys) {
      if (!this.beforeMap.has(key)) {
        const items = this.foliageStore.chunks.get(key);
        this.beforeMap.set(key, items ? items.map((f) => ({ ...f })) : []);
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

    const fp = this.toolState.foliagePaint;
    const isErase = event.altKey || event.shiftKey || fp.erase;

    if (isErase) {
      const slotFilter = fp.eraseAllSlots ? -1 : fp.activeSlot;
      this.foliageStore.removeFoliageInRadius(hitPoint.x, hitPoint.z, radius, slotFilter);
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
    const fp = this.toolState.foliagePaint;
    if (!fp.slopeEnabled) return false;
    return this._terrainNormalY(x, z) < fp.slopeMax;
  }

  _scatter(wx, wz, radius) {
    const fp = this.toolState.foliagePaint;
    const slotIdx = fp.activeSlot;
    const slot = this.toolState.foliageSlots[slotIdx];
    if (!slot || !slot.enabled) return;

    const baseScale = slot.baseScale ?? 1.0;
    const spacing = fp.minSpacing * Math.max(baseScale, 0.1);
    const strength = THREE.MathUtils.clamp(this.toolState.brush.strength, 0, 1);
    const area = Math.PI * radius * radius;
    const attempts = Math.ceil(area * fp.density * SCATTER_DENSITY_SCALE * strength);

    for (let i = 0; i < attempts; i++) {
      const angle = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * radius;
      const tx = wx + Math.cos(angle) * r;
      const tz = wz + Math.sin(angle) * r;

      const halfW = this.config.world.size * 0.5;
      if (tx < -halfW || tx > halfW || tz < -halfW || tz > halfW) continue;

      if (this.foliageStore.hasFoliageNearby(tx, tz, spacing)) continue;
      if (this._isTooSteep(tx, tz)) continue;

      const rotY = fp.randomRotation ? Math.random() * Math.PI * 2 : 0;
      const scale =
        (fp.scaleMin + Math.random() * (fp.scaleMax - fp.scaleMin)) * baseScale;
      const y = this.terrainStore.getWorldHeight(tx, tz);
      this.foliageStore.addFoliage(tx, tz, y, rotY, scale, slotIdx);
    }
  }

  endStroke() {
    if (!this.isPlacing) return;
    this.isPlacing = false;
    const touchedKeys = [...this.beforeMap.keys()];
    if (touchedKeys.length === 0) return;

    const afterMap = new Map();
    for (const key of touchedKeys) {
      const items = this.foliageStore.chunks.get(key);
      afterMap.set(key, items ? items.map((f) => ({ ...f })) : []);
    }

    this.undoStack.push({ before: new Map(this.beforeMap), after: afterMap });
    this.redoStack.length = 0;
    if (this.undoStack.length > 64) this.undoStack.shift();
    this.beforeMap.clear();
  }

  undo() {
    const cmd = this.undoStack.pop();
    if (!cmd) return;
    this.foliageStore.restoreFromSnapshot(cmd.before);
    this.redoStack.push(cmd);
  }

  redo() {
    const cmd = this.redoStack.pop();
    if (!cmd) return;
    this.foliageStore.restoreFromSnapshot(cmd.after);
    this.undoStack.push(cmd);
  }

  massPlace(count) {
    const fp = this.toolState.foliagePaint;
    const slotIdx = fp.activeSlot;
    const slot = this.toolState.foliageSlots[slotIdx];
    if (!slot || !slot.enabled) return 0;

    const baseScale = slot.baseScale ?? 1.0;
    const spacing = fp.minSpacing * Math.max(baseScale, 0.1);
    const halfW = this.config.world.size * 0.5;

    const beforeKeys = new Set();
    for (const key of this.foliageStore.chunks.keys()) beforeKeys.add(key);
    const before = new Map();
    for (const key of beforeKeys) {
      const items = this.foliageStore.chunks.get(key);
      before.set(key, items ? items.map((f) => ({ ...f })) : []);
    }

    if (!fp.massPlaceKeepExisting) {
      this.foliageStore.clear();
    }

    let placed = 0;
    let maxAttempts = count * 20;
    while (placed < count && maxAttempts-- > 0) {
      const tx = (Math.random() - 0.5) * this.config.world.size;
      const tz = (Math.random() - 0.5) * this.config.world.size;

      if (tx < -halfW || tx > halfW || tz < -halfW || tz > halfW) continue;
      if (this.foliageStore.hasFoliageNearby(tx, tz, spacing)) continue;
      if (this._isTooSteep(tx, tz)) continue;

      const rotY = fp.randomRotation ? Math.random() * Math.PI * 2 : 0;
      const scale =
        (fp.scaleMin + Math.random() * (fp.scaleMax - fp.scaleMin)) * baseScale;
      const y = this.terrainStore.getWorldHeight(tx, tz);
      this.foliageStore.addFoliage(tx, tz, y, rotY, scale, slotIdx);
      placed++;
    }

    const afterKeys = new Set(beforeKeys);
    for (const key of this.foliageStore.chunks.keys()) afterKeys.add(key);
    for (const key of afterKeys) {
      if (!before.has(key)) before.set(key, []);
    }
    const after = new Map();
    for (const key of afterKeys) {
      const items = this.foliageStore.chunks.get(key);
      after.set(key, items ? items.map((f) => ({ ...f })) : []);
    }

    this.undoStack.push({ before, after });
    this.redoStack.length = 0;
    if (this.undoStack.length > 64) this.undoStack.shift();

    console.log(`[FoliagePaintSystem] Mass-placed ${placed} instances (requested ${count})`);
    return placed;
  }

  clearAll() {
    const before = new Map();
    for (const [key, items] of this.foliageStore.chunks) {
      before.set(key, items.map((f) => ({ ...f })));
    }
    this.foliageStore.clear();
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
