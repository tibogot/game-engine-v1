import * as THREE from "three";
import { OBJECTS, OBJECT_MAP } from "../../v2/objects/index.js";
import { updateWindmillRotors, preloadWindmillModel } from "../../v2/objects/windmill.js";

export { OBJECTS, OBJECT_MAP };

// Preload windmill GLB immediately (fire-and-forget)
preloadWindmillModel().catch(err =>
  console.warn("[SplineObjectSystem] Windmill preload failed:", err)
);

const _handleGeo = new THREE.SphereGeometry(0.45, 8, 8);
const _handleMat = new THREE.MeshBasicMaterial({ color: 0xff8800, depthTest: false, transparent: true, opacity: 0.9 });
const _lineMat   = new THREE.LineBasicMaterial({ color: 0x00ffff, depthTest: false });

export class SplineObjectSystem {
  constructor(scene, getWorldHeight) {
    this.scene          = scene;
    this.getWorldHeight = getWorldHeight;

    this.activeObjDef   = OBJECTS[0] ?? null;
    this.activeParams   = { ...(this.activeObjDef?.defaults ?? {}) };
    this.draftClosed    = false;

    this._drafting      = false;
    this._draftPts      = [];

    this._handleGroup   = new THREE.Group();
    this._handleGroup.renderOrder = 999;
    scene.add(this._handleGroup);

    this._lineObj       = null;
    this._previewGrp    = null;

    this.objects        = [];
    this._windmills     = [];

    this.onChange       = null;
  }

  get isDrafting()       { return this._drafting; }
  get draftPointCount()  { return this._draftPts.length; }
  get activeMinPoints()  { return this.activeObjDef?.minPoints ?? 2; }

  setActiveType(id) {
    const def = OBJECT_MAP.get(id);
    if (!def) return;
    this.activeObjDef = def;
    this.activeParams = { ...(def.defaults ?? {}) };
    this._onChange();
  }

  setParam(key, val) {
    this.activeParams[key] = val;
    if (this._drafting && this._draftPts.length >= this.activeMinPoints) {
      this._rebuildPreview();
    }
  }

  startDraft() {
    if (this._drafting) return;
    this._drafting = true;
    this._draftPts = [];
    this._clearPreview();
    this._onChange();
  }

  cancelDraft() {
    this._drafting = false;
    this._draftPts = [];
    this._clearHandles();
    this._clearPreview();
    this._onChange();
  }

  undoLastPoint() {
    if (!this._drafting || !this._draftPts.length) return;
    this._draftPts.pop();
    const h = this._handleGroup.children[this._handleGroup.children.length - 1];
    if (h && h !== this._lineObj) this._handleGroup.remove(h);
    this._rebuildLine();
    if (this._draftPts.length >= this.activeMinPoints) {
      this._rebuildPreview();
    } else {
      this._clearPreview();
    }
    this._onChange();
  }

  addPoint(wx, wz) {
    if (!this._drafting || !this.activeObjDef) return;
    const wy = this.getWorldHeight(wx, wz);
    this._draftPts.push(new THREE.Vector3(wx, wy, wz));

    const sphere = new THREE.Mesh(_handleGeo, _handleMat);
    sphere.position.set(wx, wy + 0.5, wz);
    sphere.renderOrder = 999;
    this._handleGroup.add(sphere);

    this._rebuildLine();
    if (this._draftPts.length >= this.activeMinPoints) {
      this._rebuildPreview();
    }
    this._onChange();
  }

  canCommit() {
    return this._drafting && this._draftPts.length >= this.activeMinPoints;
  }

  commit() {
    if (!this.canCommit()) return null;

    this._clearPreview();

    const params = this._resolveParams(this.activeObjDef, this.activeParams);
    let group = null;
    try {
      group = this.activeObjDef.build({
        points: this._draftPts.map(p => p.clone()),
        closed: this.draftClosed,
        params,
        getWorldHeight: this.getWorldHeight,
      });
    } catch (err) {
      console.error("[SplineObjectSystem] Build failed:", err);
    }

    if (group) {
      this.scene.add(group);
      const entry = {
        objDef: this.activeObjDef,
        label: this.activeObjDef.label,
        params,
        points: this._draftPts.slice(),
        closed: this.draftClosed,
        group,
      };
      if (this.activeObjDef.id === "windmill") {
        this._windmills.push({ group, params });
      }
      this.objects.push(entry);
    }

    this._drafting = false;
    this._draftPts = [];
    this._clearHandles();
    this._onChange();
    return group;
  }

  removeObject(idx) {
    const entry = this.objects[idx];
    if (!entry) return;
    this.scene.remove(entry.group);
    entry.group.traverse(o => { if (o.isMesh) { o.geometry?.dispose(); } });
    const wi = this._windmills.findIndex(w => w.group === entry.group);
    if (wi >= 0) this._windmills.splice(wi, 1);
    this.objects.splice(idx, 1);
    this._onChange();
  }

  update(dt) {
    for (const { group, params } of this._windmills) {
      try { updateWindmillRotors(group, params, dt); } catch {}
    }
  }

  _resolveParams(def, userParams) {
    const merged = { ...(def.defaults ?? {}), ...userParams };
    if (def.resolveParams) return def.resolveParams(merged);
    return merged;
  }

  _rebuildLine() {
    if (this._lineObj) {
      this._handleGroup.remove(this._lineObj);
      this._lineObj.geometry.dispose();
      this._lineObj = null;
    }
    if (this._draftPts.length < 2) return;

    const pts = this._draftPts.map(p => new THREE.Vector3(p.x, p.y + 0.15, p.z));
    const curve = new THREE.CatmullRomCurve3(pts, this.draftClosed);
    const positions = curve.getPoints(Math.max(80, pts.length * 20));
    const geo  = new THREE.BufferGeometry().setFromPoints(positions);
    const line = new THREE.Line(geo, _lineMat);
    line.renderOrder = 999;
    this._lineObj = line;
    this._handleGroup.add(line);
  }

  _rebuildPreview() {
    this._clearPreview();
    if (!this.activeObjDef || this._draftPts.length < this.activeMinPoints) return;

    const params = this._resolveParams(this.activeObjDef, this.activeParams);
    try {
      const grp = this.activeObjDef.build({
        points: this._draftPts.map(p => p.clone()),
        closed: this.draftClosed,
        params,
        getWorldHeight: this.getWorldHeight,
      });
      if (grp) {
        grp.traverse(o => {
          if (o.isMesh) {
            const mats = Array.isArray(o.material) ? o.material : [o.material];
            for (const mat of mats) { mat.transparent = true; mat.opacity = 0.55; }
          }
        });
        this._previewGrp = grp;
        this.scene.add(grp);
      }
    } catch (err) {
      console.warn("[SplineObjectSystem] Preview failed:", err);
    }
  }

  _clearPreview() {
    if (this._previewGrp) {
      this.scene.remove(this._previewGrp);
      this._previewGrp.traverse(o => { if (o.isMesh) { o.geometry?.dispose(); } });
      this._previewGrp = null;
    }
  }

  _clearHandles() {
    if (this._lineObj) {
      this._lineObj.geometry.dispose();
      this._lineObj = null;
    }
    this._handleGroup.clear();
  }

  _onChange() {
    this.onChange?.();
  }

  dispose() {
    this.cancelDraft();
    this.scene.remove(this._handleGroup);
  }
}
