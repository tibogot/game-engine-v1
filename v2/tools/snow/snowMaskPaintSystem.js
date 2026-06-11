import * as THREE from "three";
import { shouldApplyStroke } from "../sculpt/brushModel.js";

/**
 * Brush paint system for the snow accumulation mask (`SnowMask`).
 * Mirrors `RevoGrassMaskPaintSystem`: same brush state, same undo/redo.
 *
 * Paint mode = "snow" in toolState; pointerdown / pointermove dispatched
 * by `v2/app/main.js` like every other brush mode.
 */
export class SnowMaskPaintSystem {
  constructor({ toolState, mask, config }) {
    this.toolState = toolState;
    this.mask = mask;
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
    this.beforeSnapshot = this.mask.getSnapshot();
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

    const erase = event.altKey || this.toolState.snowPaint?.erase;
    this.mask.stamp({
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
    const afterSnapshot = this.mask.getSnapshot();
    let changed = false;
    for (let i = 0; i < this.beforeSnapshot.length; i++) {
      if (this.beforeSnapshot[i] !== afterSnapshot[i]) {
        changed = true;
        break;
      }
    }
    if (!changed) {
      this.beforeSnapshot = null;
      return;
    }
    this.undoStack.push({ before: this.beforeSnapshot, after: afterSnapshot });
    this.redoStack.length = 0;
    if (this.undoStack.length > 32) this.undoStack.shift();
    this.beforeSnapshot = null;
  }

  undo() {
    const cmd = this.undoStack.pop();
    if (!cmd) return;
    this.mask.restoreSnapshot(cmd.before);
    this.redoStack.push(cmd);
  }

  redo() {
    const cmd = this.redoStack.pop();
    if (!cmd) return;
    this.mask.restoreSnapshot(cmd.after);
    this.undoStack.push(cmd);
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }
  get canRedo() {
    return this.redoStack.length > 0;
  }
}
