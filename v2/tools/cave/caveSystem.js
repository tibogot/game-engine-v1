/**
 * Cave placement system.
 *
 * Editor click in "cave" mode → place a new box-room anchor at the click XZ
 * with the click's terrain Y as the surface reference. Cave size + opening
 * read from `toolState.cave` so the tweakpane sliders flow through here.
 *
 * Triggers a BVH rebake on every change so the player physics picks up the
 * new geometry immediately. The rebake also runs on undo / redo / clear /
 * project load via the same `onChange` listener path.
 */
export class CaveSystem {
  constructor({ toolState, caveStore, onRebakeBvh }) {
    this.toolState = toolState;
    this.caveStore = caveStore;
    this.onRebakeBvh = onRebakeBvh || (() => {});

    this.undoStack = [];
    this.redoStack = [];

    this._unsubscribe = caveStore.onChange(() => this.onRebakeBvh());
  }

  /** Place a cave anchored to the terrain hit point. Returns the new anchor id. */
  placeAt(hitPoint) {
    const params = this.toolState.cave;
    const id = this.caveStore.addAnchor({
      x: hitPoint.x,
      z: hitPoint.z,
      surfaceY: hitPoint.y,
      width: params.width,
      depth: params.depth,
      height: params.height,
      opening: params.opening,
      ceilingOffset: params.ceilingOffset,
    });
    this.undoStack.push({ kind: "place", id, snapshot: this._snapshotOf(id) });
    this.redoStack.length = 0;
    if (this.undoStack.length > 64) this.undoStack.shift();
    return id;
  }

  removeAnchor(id) {
    const snapshot = this._snapshotOf(id);
    if (!snapshot) return false;
    this.caveStore.removeAnchor(id);
    this.undoStack.push({ kind: "remove", id, snapshot });
    this.redoStack.length = 0;
    if (this.undoStack.length > 64) this.undoStack.shift();
    return true;
  }

  clearAll() {
    if (this.caveStore.count() === 0) return;
    const snapshots = this.caveStore.getAll().map((a) => this._snapshotOf(a.id));
    this.caveStore.clearAll();
    this.undoStack.push({ kind: "clearAll", snapshots });
    this.redoStack.length = 0;
    if (this.undoStack.length > 64) this.undoStack.shift();
  }

  undo() {
    const cmd = this.undoStack.pop();
    if (!cmd) return;
    if (cmd.kind === "place") {
      this.caveStore.removeAnchor(cmd.id);
    } else if (cmd.kind === "remove") {
      this.caveStore.addAnchor(cmd.snapshot);
    } else if (cmd.kind === "clearAll") {
      for (const s of cmd.snapshots) this.caveStore.addAnchor(s);
    }
    this.redoStack.push(cmd);
  }

  redo() {
    const cmd = this.redoStack.pop();
    if (!cmd) return;
    if (cmd.kind === "place") {
      this.caveStore.addAnchor(cmd.snapshot);
    } else if (cmd.kind === "remove") {
      this.caveStore.removeAnchor(cmd.id);
    } else if (cmd.kind === "clearAll") {
      this.caveStore.clearAll();
    }
    this.undoStack.push(cmd);
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  _snapshotOf(id) {
    const a = this.caveStore.anchors.get(id);
    if (!a) return null;
    return {
      id: a.id, x: a.x, z: a.z, surfaceY: a.surfaceY,
      width: a.width, depth: a.depth, height: a.height,
      opening: a.opening, ceilingOffset: a.ceilingOffset,
    };
  }

  dispose() {
    this._unsubscribe?.();
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }
}
