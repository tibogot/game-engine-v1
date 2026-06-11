import * as THREE from "three";
import { shouldApplyStroke } from "../sculpt/brushModel.js";

export class GrassPaintSystem {
  constructor({ toolState, grassManager, config }) {
    this.toolState = toolState;
    this.grassManager = grassManager;
    this.config = config;
    this.isPainting = false;
    this.lastStrokePoint = null;
    this.beforeSnapshot = null;
    this.undoStack = [];
    this.redoStack = [];
  }

  beginStroke(hitPoint, event = {}) {
    this.isPainting = true;
    this.lastStrokePoint = null;
    this.beforeSnapshot = this.grassManager.getDensitySnapshot();
    this.applyAt(hitPoint, event);
  }

  applyAt(hitPoint, event = {}) {
    if (!this.isPainting) return;
    const brush = this.toolState.brush;
    if (!shouldApplyStroke(this.lastStrokePoint, hitPoint, brush.radius, brush.spacingFactor)) {
      return;
    }
    this.lastStrokePoint = this.lastStrokePoint ?? new THREE.Vector3();
    this.lastStrokePoint.copy(hitPoint);

    const erase = event.altKey;
    this.grassManager.stampDensity({
      cx: hitPoint.x,
      cz: hitPoint.z,
      radius: brush.radius,
      strength: THREE.MathUtils.clamp(brush.strength, 0, 1),
      falloff: brush.falloff,
      worldSize: this.config.world.size,
      erase,
    });
  }

  endStroke() {
    if (!this.isPainting) return;
    this.isPainting = false;
    if (!this.beforeSnapshot) return;
    const afterSnapshot = this.grassManager.getDensitySnapshot();
    let changed = false;
    for (let i = 0; i < this.beforeSnapshot.length; i++) {
      if (this.beforeSnapshot[i] !== afterSnapshot[i]) { changed = true; break; }
    }
    if (!changed) { this.beforeSnapshot = null; return; }
    this.undoStack.push({ before: this.beforeSnapshot, after: afterSnapshot });
    this.redoStack.length = 0;
    if (this.undoStack.length > 32) this.undoStack.shift();
    this.beforeSnapshot = null;
  }

  undo() {
    const cmd = this.undoStack.pop();
    if (!cmd) return;
    this.grassManager.restoreDensitySnapshot(cmd.before);
    this.redoStack.push(cmd);
  }

  redo() {
    const cmd = this.redoStack.pop();
    if (!cmd) return;
    this.grassManager.restoreDensitySnapshot(cmd.after);
    this.undoStack.push(cmd);
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
}
