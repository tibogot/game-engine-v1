/**
 * PaintSystem — manages brush strokes into SplatMap with undo/redo.
 *
 * Strokes are interpolated: fast mouse drags stamp along the segment at
 * `radius × spacingFactor` intervals instead of once per mousemove, so
 * strokes never leave gaps.
 *
 * Undo is rect-based (same pattern as the sculpt brush): beginStroke copies
 * the splat data into a pre-stroke buffer, stamps accumulate a dirty rect,
 * and endStroke stores only that rect's pre-stroke content (~KBs per brush
 * stroke instead of the old ~8 MB full {before,after} snapshots). undo()
 * captures the current rect for redo before restoring.
 *
 * paintState shape:
 *   { activeLayer, brushOpacity, brush:{radius,strength,falloff,spacingFactor},
 *     noiseMask, noiseScale, noiseOctaves, noiseEdgeOnly,
 *     maskRotation, maskRandomRotation, maskFollowStroke }
 *
 * brushMask is an instance of V2's BrushMask class (Float32Array CPU mask).
 */

const MAX_HISTORY          = 32;
const MAX_STAMPS_PER_EVENT = 16;

export class PaintSystem {
  constructor({ paintState, splatMap, brushMask }) {
    this.paintState = paintState;
    this.splatMap   = splatMap;
    this.brushMask  = brushMask ?? null;

    this.isPainting = false;
    this.lastPoint  = null;
    this._strokeDir = 0;
    this._strokeRect = null;
    this._preD0 = null; // pre-stroke copies of the splat slices
    this._preD1 = null;

    /** @type {Array<{x,y,w,h,d0,d1}>} rect patches of pre-edit content */
    this.undoStack = [];
    this.redoStack = [];
  }

  // ── Stroke lifecycle ───────────────────────────────────────────────────────

  beginStroke(wx, wz, altKey = false) {
    if (this.isPainting) this.endStroke();
    if (!this._preD0) {
      this._preD0 = new Uint8Array(this.splatMap.data0.length);
      this._preD1 = new Uint8Array(this.splatMap.data1.length);
    }
    this._preD0.set(this.splatMap.data0);
    this._preD1.set(this.splatMap.data1);
    this.isPainting  = true;
    this.lastPoint   = null;
    this._strokeDir  = 0;
    this._strokeRect = null;
    this._stampAt(wx, wz, altKey);
    this.lastPoint = { x: wx, z: wz };
  }

  continueStroke(wx, wz, altKey = false) {
    if (!this.isPainting) return;
    if (!this.lastPoint) {
      this._stampAt(wx, wz, altKey);
      this.lastPoint = { x: wx, z: wz };
      return;
    }

    const dx = wx - this.lastPoint.x;
    const dz = wz - this.lastPoint.z;
    const dist = Math.hypot(dx, dz);
    const spacing = Math.max(0.25, this.paintState.brush.radius * this.paintState.brush.spacingFactor);
    if (dist < spacing) return;

    if (dist > 0.1) this._strokeDir = Math.atan2(dz, dx);

    // Interpolate stamps along the segment so fast drags don't leave gaps.
    const steps = Math.min(Math.ceil(dist / spacing), MAX_STAMPS_PER_EVENT);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      this._stampAt(this.lastPoint.x + dx * t, this.lastPoint.z + dz * t, altKey);
    }
    this.lastPoint = { x: wx, z: wz };
  }

  endStroke() {
    if (!this.isPainting) return;
    this.isPainting = false;
    if (!this._strokeRect) return; // click without effect — nothing to record
    this._pushUndo(this.splatMap.copyRect(this._strokeRect, this._preD0, this._preD1));
    this._strokeRect = null;
  }

  // ── History ────────────────────────────────────────────────────────────────

  _pushUndo(patch) {
    this.undoStack.push(patch);
    this.redoStack.length = 0;
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
  }

  undo() {
    this.endStroke();
    const patch = this.undoStack.pop();
    if (!patch) return false;
    this.redoStack.push(this.splatMap.copyRect(patch)); // current content for redo
    this.splatMap.pasteRect(patch);
    return true;
  }

  redo() {
    this.endStroke();
    const patch = this.redoStack.pop();
    if (!patch) return false;
    this.undoStack.push(this.splatMap.copyRect(patch));
    this.splatMap.pasteRect(patch);
    return true;
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  // ── Whole-map operations (full-rect undo entries) ──────────────────────────

  _fullRect() {
    const size = Math.sqrt(this.splatMap.data0.length / 4);
    return { x: 0, y: 0, w: size, h: size };
  }

  fillWithActiveLayer() {
    this._pushUndo(this.splatMap.copyRect(this._fullRect()));
    this.splatMap.fillAllWithLayer(this.paintState.activeLayer);
  }

  applyAutoRules(args) {
    this._pushUndo(this.splatMap.copyRect(this._fullRect()));
    this.splatMap.applyAutoRules(args);
  }

  clearAll() {
    this._pushUndo(this.splatMap.copyRect(this._fullRect()));
    this.splatMap.clearAll();
  }

  // ── Internal stamp ─────────────────────────────────────────────────────────

  _stampAt(wx, wz, altKey) {
    const s           = this.paintState;
    const activeLayer = altKey ? 0 : s.activeLayer;

    let maskData = null, maskSize = 0, maskRotation = 0;
    const bm = this.brushMask;
    if (bm?.active && bm.data) {
      maskData = bm.data;
      maskSize = bm.size;
      const baseRad = (s.maskRotation ?? 0) * Math.PI / 180;
      if (s.maskRandomRotation)    maskRotation = Math.random() * Math.PI * 2;
      else if (s.maskFollowStroke) maskRotation = this._strokeDir + baseRad;
      else                         maskRotation = baseRad;
    }

    const rect = this.splatMap.applySplatStroke({
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
    if (rect) this._strokeRect = this._unionRect(this._strokeRect, rect);
  }

  _unionRect(a, b) {
    if (!a) return { ...b };
    const x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y);
    const x1 = Math.max(a.x + a.w, b.x + b.w), y1 = Math.max(a.y + a.h, b.y + b.h);
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
}
