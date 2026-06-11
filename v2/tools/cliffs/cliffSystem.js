export class CliffSystem {
  constructor({ toolState, cliffStore, cliffInstancer, cliffBvh, terrainStore }) {
    this.toolState = toolState;
    this.store = cliffStore;
    this.instancer = cliffInstancer;
    this.bvh = cliffBvh;
    this.terrainStore = terrainStore;

    this._undoStack = [];
    this._redoStack = [];
    this._maxUndo = 64;
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
    const sinkOffset = this.toolState.cliffs.sinkOffset || 0;
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

  handleTransformChange() {
    this.instancer.syncFromProxy();
  }

  handleTransformEnd() {
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
