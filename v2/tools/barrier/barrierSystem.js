import * as THREE from "three";
import { shouldApplyStroke } from "../sculpt/brushModel.js";
import { chunkKey } from "../../core/terrain/chunkMath.js";

export class BarrierSystem {
  constructor({ toolState, barrierStore, config }) {
    this.toolState = toolState;
    this.barrierStore = barrierStore;
    this.config = config;
    this.isPainting = false;
    this.lastStrokePoint = null;
    /** @type {Map<string, Uint8Array>} */
    this.beforeMap = new Map();
    /** @type {Map<string, Uint8Array>} */
    this.afterMap = new Map();
    this.undoStack = [];
    this.redoStack = [];
  }

  _snapshotAffectedChunks(worldX, worldZ, radius) {
    const affected = this.barrierStore.getChunkIndicesInBounds(
      worldX - radius, worldZ - radius,
      worldX + radius, worldZ + radius,
    );
    for (const { cx, cz } of affected) {
      const entry = this.barrierStore.ensureChunk(cx, cz);
      const key = chunkKey(cx, cz);
      if (!this.beforeMap.has(key)) {
        this.beforeMap.set(key, new Uint8Array(entry.data));
      }
    }
  }

  beginStroke(hitPoint, event = {}) {
    this.isPainting = true;
    this.lastStrokePoint = null;
    this.beforeMap.clear();
    this.afterMap.clear();
    this.applyAt(hitPoint, event);
  }

  applyAt(hitPoint, event = {}) {
    if (!this.isPainting) return;
    const brush = this.toolState.brush;
    if (
      !shouldApplyStroke(this.lastStrokePoint, hitPoint, brush.radius, brush.spacingFactor)
    ) {
      return;
    }
    this.lastStrokePoint = this.lastStrokePoint ?? new THREE.Vector3();
    this.lastStrokePoint.copy(hitPoint);

    this._snapshotAffectedChunks(hitPoint.x, hitPoint.z, brush.radius);

    const erase = event.shiftKey || this.toolState.barrier.erase;
    this.barrierStore.applyBarrierStroke({
      cx: hitPoint.x,
      cz: hitPoint.z,
      radius: brush.radius,
      strength: brush.strength,
      falloff: brush.falloff,
      erase,
    });
  }

  endStroke() {
    if (!this.isPainting) return;
    this.isPainting = false;
    const touched = [...this.beforeMap.keys()];
    if (touched.length === 0) return;

    for (const key of touched) {
      const entry = this.barrierStore.getChunkByKey(key);
      if (!entry) continue;
      this.afterMap.set(key, new Uint8Array(entry.data));
    }
    if (this.afterMap.size === 0) {
      this.beforeMap.clear();
      return;
    }
    this.undoStack.push({
      before: new Map(this.beforeMap),
      after: new Map(this.afterMap),
    });
    this.redoStack.length = 0;
    if (this.undoStack.length > 64) this.undoStack.shift();
    this.beforeMap.clear();
    this.afterMap.clear();
  }

  undo() {
    const cmd = this.undoStack.pop();
    if (!cmd) return;
    this.barrierStore.restoreFromSnapshot(cmd.before);
    this.redoStack.push(cmd);
  }

  redo() {
    const cmd = this.redoStack.pop();
    if (!cmd) return;
    this.barrierStore.restoreFromSnapshot(cmd.after);
    this.undoStack.push(cmd);
  }

  clearAll() {
    const before = new Map();
    for (const [key, entry] of this.barrierStore.chunks) {
      before.set(key, new Uint8Array(entry.data));
    }
    this.barrierStore.clearAll();
    const after = new Map();
    for (const [key, entry] of this.barrierStore.chunks) {
      after.set(key, new Uint8Array(entry.data));
    }
    if (before.size === 0) return;
    this.undoStack.push({ before, after });
    this.redoStack.length = 0;
    if (this.undoStack.length > 64) this.undoStack.shift();
  }

  fillAll() {
    const before = new Map();
    for (const [key, entry] of this.barrierStore.chunks) {
      before.set(key, new Uint8Array(entry.data));
    }
    this.barrierStore.fillWorld();
    const after = new Map();
    for (const [key, entry] of this.barrierStore.chunks) {
      after.set(key, new Uint8Array(entry.data));
    }
    if (before.size === 0 && after.size === 0) return;
    this.undoStack.push({ before, after });
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
