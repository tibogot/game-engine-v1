import * as THREE from "three";
import { createBrushStrokeFromHit, shouldApplyStroke, worldBrushBounds } from "./brushModel.js";
import { chunkKey, getChunkCountPerAxis, parseChunkKey } from "../../core/terrain/chunkMath.js";
import {
  applyErosionBrushToTerrain,
  applyGlobalErosionToTerrain,
  erosionSnapshotMarginWorld,
} from "../../core/terrain/erosionBrush.js";

export class SculptSystem {
  constructor({ toolState, terrainStore, chunkStream, onHeightsChanged, brushMask = null }) {
    this.toolState = toolState;
    this.terrainStore = terrainStore;
    this.chunkStream = chunkStream;
    this.onHeightsChanged = onHeightsChanged || (() => {});
    this.brushMask = brushMask;
    this.isSculpting = false;
    this.sign = 1;
    this.flattenTargetY = 0;
    this.lastStrokePoint = null;
    /** Radians, updated between samples in a stroke — drives `followStroke` mask rotation. */
    this._strokeDirection = 0;
    this.beforeMap = new Map();
    this.afterMap = new Map();
    this.undoStack = [];
    this.redoStack = [];
    /** Matches splatmap-chunks `sculptBrushNoiseSeed` — stable for whole LMB drag. */
    this.sessionBrushSeed = 0;
    /** v1 `editState.rampPointA` — first click when `sculptMode === "ramp"`. */
    this.rampPointA = null;
  }

  clearRampPoint() {
    this.rampPointA = null;
  }

  hasRampPointA() {
    return this.rampPointA != null;
  }

  /**
   * First LMB in ramp mode — stores A with terrain height at (x,z).
   * @param {THREE.Vector3} hitPoint
   */
  setRampPointA(hitPoint) {
    const y = this.terrainStore.getWorldHeight(hitPoint.x, hitPoint.z);
    this.rampPointA = { x: hitPoint.x, y, z: hitPoint.z };
  }

  /**
   * Second LMB — v1 `applyRampAt` + undo. Clears ramp A after success.
   * @param {THREE.Vector3} hitPoint
   */
  commitRampSecondClick(hitPoint) {
    if (!this.rampPointA) return;
    const ptA = this.rampPointA;
    const ptB = {
      x: hitPoint.x,
      y: this.terrainStore.getWorldHeight(hitPoint.x, hitPoint.z),
      z: hitPoint.z,
    };
    const radius = this.toolState.brush.radius;
    const strength = THREE.MathUtils.clamp(this.toolState.brush.strength / 2.5, 0.02, 1);

    const keys = this.terrainStore.getChunkKeysInRampBounds(ptA, ptB, radius);
    const before = new Map();
    for (const key of keys) {
      const { cx, cz } = parseChunkKey(key);
      before.set(key, new Float32Array(this.terrainStore.ensureChunkData(cx, cz)));
    }

    const touched = this.terrainStore.applyRampStroke(ptA, ptB, radius, strength, this.toolState.ramp);
    if (touched.size === 0) return;

    const after = new Map();
    for (const key of touched) {
      const arr = this.terrainStore.getChunkHeightsByKey(key);
      if (arr) after.set(key, new Float32Array(arr));
    }
    this.undoStack.push({ before, after });
    this.redoStack.length = 0;
    if (this.undoStack.length > 64) this.undoStack.shift();
    this.chunkStream.markDirtyFull(touched);
    this.rampPointA = null;
    this.onHeightsChanged();
  }

  /**
   * @param {PointerEvent} event — modifiers: Shift locks raise/lower sign for the stroke (v1 `sculptSign`);
   *   Alt samples flatten height at stroke start; live Alt/Ctrl during drag handled in `applyAt`.
   */
  beginStroke(hitPoint, event = {}) {
    this.isSculpting = true;
    this.sign = event.shiftKey ? -1 : 1;
    this.lastStrokePoint = null;
    this._strokeDirection = 0;
    this.beforeMap.clear();
    this.afterMap.clear();
    this.sessionBrushSeed = Math.random() * 1000;
    const wantFlatten = this.toolState.sculptMode === "flatten" || !!event.altKey;
    this.flattenTargetY = wantFlatten
      ? this.terrainStore.getWorldHeight(hitPoint.x, hitPoint.z)
      : 0;
    this.applyAt(hitPoint, event);
  }

  applyAt(hitPoint, event = {}) {
    if (!this.isSculpting) return;
    if (
      !shouldApplyStroke(
        this.lastStrokePoint,
        hitPoint,
        this.toolState.brush.radius,
        this.toolState.brush.spacingFactor,
      )
    ) {
      return;
    }
    if (this.lastStrokePoint) {
      const sdx = hitPoint.x - this.lastStrokePoint.x;
      const sdz = hitPoint.z - this.lastStrokePoint.z;
      if (sdx * sdx + sdz * sdz > 0.01) {
        this._strokeDirection = Math.atan2(sdz, sdx);
      }
    }
    this.lastStrokePoint = this.lastStrokePoint ?? new THREE.Vector3();
    this.lastStrokePoint.copy(hitPoint);

    let maskData = null;
    let maskSize = 0;
    let maskRotation = 0;
    const bm = this.brushMask;
    if (bm && bm.active && bm.data) {
      maskData = bm.data;
      maskSize = bm.size;
      const sm = this.toolState.sculptMask ?? {};
      const baseRad = ((sm.rotation ?? 0) * Math.PI) / 180;
      if (sm.randomRotation) {
        maskRotation = Math.random() * Math.PI * 2;
      } else if (sm.followStroke) {
        maskRotation = this._strokeDirection + baseRad;
      } else {
        maskRotation = baseRad;
      }
    }

    const stroke = createBrushStrokeFromHit({
      hitPoint,
      toolState: this.toolState,
      sign: this.sign,
      flattenTargetY: this.flattenTargetY,
      sessionBrushSeed: this.sessionBrushSeed,
      pointerEvent: event,
      maskData,
      maskSize,
      maskRotation,
    });

    if (stroke.mode === "erosion") {
      const margin = erosionSnapshotMarginWorld(
        this.terrainStore.config,
        stroke.radius,
        this.toolState.erosion.radius,
      );
      const keys = this.chunkStream.getChunkKeysInBrushBounds(
        hitPoint.x - margin,
        hitPoint.z - margin,
        hitPoint.x + margin,
        hitPoint.z + margin,
      );
      for (const key of keys) {
        if (!this.beforeMap.has(key)) {
          let current = this.terrainStore.getChunkHeightsByKey(key);
          if (!current) {
            const { cx, cz } = parseChunkKey(key);
            current = this.terrainStore.ensureChunkData(cx, cz);
          }
          this.beforeMap.set(key, new Float32Array(current));
        }
      }
      const touched = applyErosionBrushToTerrain(
        this.terrainStore,
        hitPoint,
        stroke.radius,
        stroke.strength,
        this.toolState.erosion,
      );
      this.terrainStore.syncChunkEdgesAround(touched);
      this.chunkStream.markDirtyFull(touched);
      return;
    }

    const touchedKeys = this.chunkStream.getChunkKeysInBrushBounds(
      stroke.minX,
      stroke.minZ,
      stroke.maxX,
      stroke.maxZ,
    );
    for (const key of touchedKeys) {
      if (!this.beforeMap.has(key)) {
        let current = this.terrainStore.getChunkHeightsByKey(key);
        if (!current) {
          const { cx, cz } = parseChunkKey(key);
          current = this.terrainStore.ensureChunkData(cx, cz);
        }
        this.beforeMap.set(key, new Float32Array(current));
      }
    }

    const dirtyRects = new Map();
    this.terrainStore.applySculptStroke(stroke, dirtyRects);
    this.chunkStream.markDirtyRects(dirtyRects);
  }

  /**
   * v1 `runGlobalErosion` — hydraulic erosion across the whole map. Snapshots every
   * existing chunk for undo, runs the droplet sim, and then marks only touched
   * chunks + their neighbors for a full mesh rebuild (LOD stitch-safe).
   */
  applyGlobalErosion() {
    const maxC = getChunkCountPerAxis(this.terrainStore.config) - 1;
    const before = new Map();
    for (let cz = 0; cz <= maxC; cz++) {
      for (let cx = 0; cx <= maxC; cx++) {
        const key = chunkKey(cx, cz);
        const h = this.terrainStore.ensureChunkData(cx, cz);
        before.set(key, new Float32Array(h));
      }
    }
    const touched = applyGlobalErosionToTerrain(this.terrainStore, this.toolState.erosion);
    if (touched.size === 0) return;
    this.terrainStore.syncChunkEdgesAround(touched);
    const after = new Map();
    for (const key of touched) {
      const arr = this.terrainStore.getChunkHeightsByKey(key);
      if (arr) after.set(key, new Float32Array(arr));
    }
    this.undoStack.push({ before, after });
    this.redoStack.length = 0;
    if (this.undoStack.length > 64) this.undoStack.shift();
    this.chunkStream.markDirtyFull(touched);
    this.onHeightsChanged();
  }

  /**
   * v1 `applyProceduralTerrainToAllChunks` — CPU FBM/ridge over entire heightfield, with undo.
   */
  applyProceduralTerrainAllChunks() {
    const maxC = getChunkCountPerAxis(this.terrainStore.config) - 1;
    const before = new Map();
    for (let cz = 0; cz <= maxC; cz++) {
      for (let cx = 0; cx <= maxC; cx++) {
        const key = chunkKey(cx, cz);
        const h = this.terrainStore.ensureChunkData(cx, cz);
        before.set(key, new Float32Array(h));
      }
    }
    const touched = this.terrainStore.applyProceduralTerrainToAllChunks(this.toolState.gen);
    const after = new Map();
    for (const key of touched) {
      const arr = this.terrainStore.getChunkHeightsByKey(key);
      if (arr) after.set(key, new Float32Array(arr));
    }
    this.undoStack.push({ before, after });
    this.redoStack.length = 0;
    if (this.undoStack.length > 64) this.undoStack.shift();
    this.chunkStream.markDirtyFull(touched);
    this.onHeightsChanged();
  }

  endStroke() {
    if (!this.isSculpting) return;
    this.isSculpting = false;
    const touched = [...this.beforeMap.keys()];
    if (touched.length === 0) return;
    for (const key of touched) {
      const current = this.terrainStore.getChunkHeightsByKey(key);
      if (!current) continue;
      this.afterMap.set(key, new Float32Array(current));
    }
    if (this.afterMap.size > 0) {
      this.undoStack.push({
        before: new Map(this.beforeMap),
        after: new Map(this.afterMap),
      });
      this.redoStack.length = 0;
      if (this.undoStack.length > 64) this.undoStack.shift();
    }
    this.beforeMap.clear();
    this.afterMap.clear();
    this.onHeightsChanged();
  }

  undo() {
    const cmd = this.undoStack.pop();
    if (!cmd) return;
    this.terrainStore.restoreChunkHeightsFromMap(cmd.before);
    const dirty = new Set(cmd.before.keys());
    this.terrainStore.syncChunkEdgesAround(dirty);
    this.chunkStream.markDirtyFull(dirty);
    this.redoStack.push(cmd);
    this.onHeightsChanged();
  }

  redo() {
    const cmd = this.redoStack.pop();
    if (!cmd) return;
    this.terrainStore.restoreChunkHeightsFromMap(cmd.after);
    const dirty = new Set(cmd.after.keys());
    this.terrainStore.syncChunkEdgesAround(dirty);
    this.chunkStream.markDirtyFull(dirty);
    this.undoStack.push(cmd);
    this.onHeightsChanged();
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }

  get canRedo() {
    return this.redoStack.length > 0;
  }

  getStrokeBoundsPreview(hitPoint) {
    return worldBrushBounds(hitPoint, this.toolState.brush.radius);
  }
}

