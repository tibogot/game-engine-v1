import * as THREE from "three";
import { PropPlacementPreview } from "./propPlacementPreview.js";

const MAX_UNDO = 64;

export const PROP_TOOL = {
  PLACE:  "place",
  ERASE:  "erase",
  SCATTER: "scatter",
  SELECT: "select",
};

export class PropSystem {
  constructor(scene, propStore, propInstancer, getTerrainHit, livePropManager) {
    this.scene            = scene;
    this.store            = propStore;
    this.instancer        = propInstancer;
    this.getTerrainHit    = getTerrainHit; // fn(mouseEvent) → THREE.Vector3 | null
    this._livePropManager = livePropManager ?? null;

    this.activeTool       = PROP_TOOL.PLACE;
    this.activeTypeIdx    = 0;
    this.scatterRadius    = 12;
    this.scatterCount     = 5;
    this.scatterMinSep    = 3;
    this.sinkAmount       = 0;
    this.randomYRot       = true;
    this.randomScale      = false;
    this.scaleMin         = 0.8;
    this.scaleMax         = 1.2;
    this.alignToNormal    = false;
    this.sampleTerrainNormal = null; // fn(wx, wz) → THREE.Vector3 | null

    this._undoStack = [];
    this._redoStack = [];

    this._painting     = false;
    this._stampPos     = null;
    this._stampMinDist = 1.0;

    this._preview = new PropPlacementPreview(scene, propStore);

    this._raycaster = new THREE.Raycaster();
    this._mouse     = new THREE.Vector2();
  }

  // ── Type selection ──────────────────────────────────────────────────────────

  setActiveType(typeIdx) {
    this.activeTypeIdx = typeIdx;
    this._preview.hide();
  }

  // ── Tool selection ──────────────────────────────────────────────────────────

  setTool(tool) {
    this.activeTool = tool;
    this._preview.hide();
    if (tool !== PROP_TOOL.SELECT) this.instancer.clearSelection();
  }

  // ── Mouse event handlers (called from main.js) ──────────────────────────────

  onMouseMove(event, camera) {
    const hit = this.getTerrainHit(event);
    if (!hit) { this._preview.hide(); return; }

    if (this.activeTool === PROP_TOOL.PLACE || this.activeTool === PROP_TOOL.SCATTER) {
      const ph = hit.clone();
      ph.y -= this.sinkAmount;
      this._preview.showAt(ph, this.activeTypeIdx);
    } else {
      this._preview.hide();
    }

    if (this._painting) {
      this._continuePaint(hit, event, camera);
    }
  }

  onMouseDown(event, camera) {
    if (event.button !== 0) return;
    const hit = this.getTerrainHit(event);
    if (!hit) return;

    if (this.activeTool === PROP_TOOL.SELECT) {
      this._trySelect(event, camera);
      return;
    }

    this._painting = true;
    this._beginPaint();
    this._stampPos  = null;
    this._applyPaint(hit);
  }

  onMouseUp() {
    this._painting = false;
    this._stampPos = null;
  }

  // ── Paint internals ─────────────────────────────────────────────────────────

  _beginPaint() {
    const snap = this.store.snapshot();
    if (this._undoStack.length >= MAX_UNDO) this._undoStack.shift();
    this._undoStack.push(snap);
    this._redoStack.length = 0;
  }

  _continuePaint(hit) {
    if (!this._painting) return;
    this._applyPaint(hit);
  }

  _applyPaint(hit) {
    if (this.activeTool === PROP_TOOL.PLACE) {
      if (this._stampPos) {
        const dx = hit.x - this._stampPos.x;
        const dz = hit.z - this._stampPos.z;
        if (dx * dx + dz * dz < this._stampMinDist * this._stampMinDist) return;
      }
      this._stampPos = hit.clone();
      this._placeOne(hit.x, hit.y - this.sinkAmount, hit.z);
    } else if (this.activeTool === PROP_TOOL.SCATTER) {
      this._scatter(hit.x, hit.y, hit.z);
    } else if (this.activeTool === PROP_TOOL.ERASE) {
      this.store.removeInRadius(hit.x, hit.z, this.scatterRadius);
    }
  }

  _placeOne(px, py, pz) {
    const ry = this.randomYRot ? Math.random() * 360 : 0;
    let sx = 1, sy = 1, sz = 1;
    if (this.randomScale) {
      const f = this.scaleMin + Math.random() * (this.scaleMax - this.scaleMin);
      sx = sy = sz = Math.max(0.01, f);
    }
    let rx = 0, rz = 0;
    if (this.alignToNormal && this.sampleTerrainNormal) {
      const normal = this.sampleTerrainNormal(px, pz);
      if (normal) {
        const q = new THREE.Quaternion().setFromUnitVectors(
          new THREE.Vector3(0, 1, 0), normal.normalize()
        );
        const e = new THREE.Euler().setFromQuaternion(q, "XYZ");
        rx = e.x * (180 / Math.PI);
        rz = e.z * (180 / Math.PI);
      }
    }
    this.store.addInstance(this.activeTypeIdx, px, py, pz, { rx, ry, rz, sx, sy, sz });
  }

  _scatter(cx, cy, cz) {
    const r = this.scatterRadius;
    let placed = 0;
    const attempts = this.scatterCount * 8;
    for (let a = 0; a < attempts && placed < this.scatterCount; a++) {
      const angle = Math.random() * Math.PI * 2;
      const dist  = Math.sqrt(Math.random()) * r;
      const wx    = cx + Math.cos(angle) * dist;
      const wz    = cz + Math.sin(angle) * dist;
      if (this.store.hasNearby(wx, wz, this.scatterMinSep)) continue;
      this._placeOne(wx, cy, wz);
      placed++;
    }
  }

  // ── Selection ───────────────────────────────────────────────────────────────

  _trySelect(event, camera) {
    const rect = event.target.getBoundingClientRect?.() ?? { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
    this._mouse.x = ((event.clientX - rect.left) / rect.width)  * 2 - 1;
    this._mouse.y = -((event.clientY - rect.top)  / rect.height) * 2 + 1;
    this._raycaster.setFromCamera(this._mouse, camera);

    const instResult = this.instancer.raycast(this._raycaster);
    const liveResult = this._livePropManager?.raycast(this._raycaster) ?? null;

    let best = null;
    if (instResult && (!liveResult || instResult.distance <= liveResult.distance)) best = instResult;
    else if (liveResult) best = liveResult;

    if (best) this.instancer.select(best.instIdx);
    else this.instancer.clearSelection();
  }

  deleteSelected() {
    if (!this.instancer.hasSelection) return;
    const snap = this.store.snapshot();
    if (this._undoStack.length >= MAX_UNDO) this._undoStack.shift();
    this._undoStack.push(snap);
    this._redoStack.length = 0;

    const idx = this.instancer.selectedIdx;
    this.instancer.clearSelection();
    this.store.removeInstance(idx);
  }

  duplicateSelected() {
    if (!this.instancer.hasSelection) return;
    const snap = this.store.snapshot();
    if (this._undoStack.length >= MAX_UNDO) this._undoStack.shift();
    this._undoStack.push(snap);
    this._redoStack.length = 0;

    const newIdx = this.store.duplicateInstance(this.instancer.selectedIdx);
    this.instancer.select(newIdx);
  }

  // ── Undo / redo ─────────────────────────────────────────────────────────────

  undo() {
    if (!this._undoStack.length) return;
    this._redoStack.push(this.store.snapshot());
    this.store.restoreFromSnapshot(this._undoStack.pop());
    this.instancer.clearSelection();
  }

  redo() {
    if (!this._redoStack.length) return;
    this._undoStack.push(this.store.snapshot());
    this.store.restoreFromSnapshot(this._redoStack.pop());
    this.instancer.clearSelection();
  }

  // ── Terrain height injection ────────────────────────────────────────────────
  // Call after scatter/place when you have a CPU heightmap to snap Y correctly.
  snapInstancesToTerrain(sampleTerrainHeight) {
    let any = false;
    for (const inst of this.store.instances) {
      const y = sampleTerrainHeight(inst.px, inst.pz);
      if (y != null) { inst.py = y - this.sinkAmount; any = true; }
    }
    if (any) this.store._bump();
  }

  dispose() {
    this._preview.dispose();
  }
}
