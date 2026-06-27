/**
 * PaintSystem — manages brush strokes into SplatMap with undo/redo.
 *
 * Adapted from V2's PaintSystem but simplified for V3's single-texture model:
 * each undo entry is a full snapshot of the two 512×512 RGBA slices (~2 MB/entry).
 * Up to 32 undo levels kept.
 *
 * paintState shape:
 *   { activeLayer, brushOpacity, brush:{radius,strength,falloff,spacingFactor},
 *     noiseMask, noiseScale, noiseOctaves, noiseEdgeOnly,
 *     maskRotation, maskRandomRotation, maskFollowStroke }
 *
 * brushMask is an instance of V2's BrushMask class (Float32Array CPU mask).
 */

export class PaintSystem {
  constructor({ paintState, splatMap, brushMask }) {
    this.paintState = paintState;
    this.splatMap   = splatMap;
    this.brushMask  = brushMask ?? null;

    this.isPainting      = false;
    this.lastPoint       = null;
    this._strokeDir      = 0;
    this._beforeSnap     = null;

    /** @type {Array<{before, after}>} */
    this.undoStack = [];
    this.redoStack = [];
  }

  // ── Stroke spacing check ───────────────────────────────────────────────────
  _shouldApply(wx, wz) {
    if (!this.lastPoint) return true;
    const dx = wx - this.lastPoint.x;
    const dz = wz - this.lastPoint.z;
    const spacing = this.paintState.brush.radius * this.paintState.brush.spacingFactor;
    return Math.sqrt(dx*dx + dz*dz) >= spacing;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  beginStroke(wx, wz, altKey = false) {
    this.isPainting  = true;
    this.lastPoint   = null;
    this._strokeDir  = 0;
    this._beforeSnap = this.splatMap.snapshot();
    this._applyAt(wx, wz, altKey);
  }

  continueStroke(wx, wz, altKey = false) {
    if (!this.isPainting) return;
    this._applyAt(wx, wz, altKey);
  }

  endStroke() {
    if (!this.isPainting) return;
    this.isPainting = false;
    if (!this._beforeSnap) return;
    const after = this.splatMap.snapshot();
    this.undoStack.push({ before: this._beforeSnap, after });
    this.redoStack.length = 0;
    if (this.undoStack.length > 32) this.undoStack.shift();
    this._beforeSnap = null;
  }

  undo() {
    const cmd = this.undoStack.pop();
    if (!cmd) return false;
    this.splatMap.restoreSnapshot(cmd.before);
    this.redoStack.push(cmd);
    return true;
  }

  redo() {
    const cmd = this.redoStack.pop();
    if (!cmd) return false;
    this.splatMap.restoreSnapshot(cmd.after);
    this.undoStack.push(cmd);
    return true;
  }

  fillWithActiveLayer() {
    const before = this.splatMap.snapshot();
    this.splatMap.fillAllWithLayer(this.paintState.activeLayer);
    const after  = this.splatMap.snapshot();
    this.undoStack.push({ before, after });
    this.redoStack.length = 0;
    if (this.undoStack.length > 32) this.undoStack.shift();
  }

  applyAutoRules(args) {
    const before = this.splatMap.snapshot();
    this.splatMap.applyAutoRules(args);
    const after  = this.splatMap.snapshot();
    this.undoStack.push({ before, after });
    this.redoStack.length = 0;
    if (this.undoStack.length > 32) this.undoStack.shift();
  }

  clearAll() {
    const before = this.splatMap.snapshot();
    this.splatMap.clearAll();
    const after  = this.splatMap.snapshot();
    this.undoStack.push({ before, after });
    this.redoStack.length = 0;
    if (this.undoStack.length > 32) this.undoStack.shift();
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  // ── Internal stamp ─────────────────────────────────────────────────────────
  _applyAt(wx, wz, altKey) {
    if (!this._shouldApply(wx, wz)) return;

    if (this.lastPoint) {
      const dx = wx - this.lastPoint.x;
      const dz = wz - this.lastPoint.z;
      if (dx*dx + dz*dz > 0.01) this._strokeDir = Math.atan2(dz, dx);
    }
    this.lastPoint = { x: wx, z: wz };

    const s           = this.paintState;
    const activeLayer = altKey ? 0 : s.activeLayer;

    let maskData = null, maskSize = 0, maskRotation = 0;
    const bm = this.brushMask;
    if (bm?.active && bm.data) {
      maskData = bm.data;
      maskSize = bm.size;
      const baseRad = (s.maskRotation ?? 0) * Math.PI / 180;
      if (s.maskRandomRotation)   maskRotation = Math.random() * Math.PI * 2;
      else if (s.maskFollowStroke) maskRotation = this._strokeDir + baseRad;
      else                         maskRotation = baseRad;
    }

    this.splatMap.applySplatStroke({
      cx:            wx,
      cz:            wz,
      radius:        s.brush.radius,
      strength:      s.brush.strength * s.brushOpacity,
      falloff:       s.brush.falloff,
      activeLayer,
      noiseMask:     s.noiseMask,
      noiseScale:    s.noiseScale,
      noiseOctaves:  s.noiseOctaves,
      noiseEdgeOnly: s.noiseEdgeOnly,
      maskData,
      maskSize,
      maskRotation,
    });
  }
}
