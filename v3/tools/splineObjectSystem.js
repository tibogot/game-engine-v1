import * as THREE from "three";
import { OBJECTS, OBJECT_MAP } from "../../v2/objects/index.js";
import { updateWindmillRotors, preloadWindmillModel } from "../../v2/objects/windmill.js";

export { OBJECTS, OBJECT_MAP };

preloadWindmillModel().catch(err =>
  console.warn("[SplineObjectSystem] Windmill preload failed:", err)
);

const _handleGeo = new THREE.SphereGeometry(0.45, 8, 8);
const _handleMat = new THREE.MeshBasicMaterial({ color: 0xff8800, depthTest: false, transparent: true, opacity: 0.9 });
const _lineMat   = new THREE.LineBasicMaterial({ color: 0x00ffff, depthTest: false });

// Flat terrain for ghost/thumbnail builds — returns 0 always
const _flatGround = () => 0;

export class SplineObjectSystem {
  constructor(scene, getWorldHeight) {
    this.scene          = scene;
    this.getWorldHeight = getWorldHeight;

    this.activeObjDef   = OBJECTS[0] ?? null;
    this.activeParams   = { ...(this.activeObjDef?.defaults ?? {}) };
    this.draftClosed    = false;

    // "place" = click to place (default), "spline" = multi-point path mode
    this.mode           = "place";

    // Ghost (hover preview)
    this._ghostGrp      = null;
    this._ghostTypeId   = null;
    this._ghostLastRebuild = 0; // timestamp for throttle
    this._ghostThrottle = 80;  // ms

    // Place-mode draft (for path objects: collecting clicks)
    this._placePts      = [];

    // Spline-mode draft
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

  // ── Accessors ───────────────────────────────────────────────────────────────

  get isDrafting()       { return this._drafting; }
  get draftPointCount()  { return this._draftPts.length; }
  get activeMinPoints()  { return this.activeObjDef?.minPoints ?? 2; }
  get isPlacingPath()    { return this._placePts.length > 0; }

  // ── Type & Params ───────────────────────────────────────────────────────────

  setActiveType(id) {
    const def = OBJECT_MAP.get(id);
    if (!def) return;
    this.activeObjDef = def;
    this.activeParams = { ...(def.defaults ?? {}) };
    // Ghost needs rebuild for the new type
    this._clearGhost();
    this._placePts = [];
    if (this._drafting) this.cancelDraft();
    this._onChange();
  }

  setParam(key, val) {
    this.activeParams[key] = val;
    this._clearGhost(); // will rebuild next mousemove
    if (this._drafting && this._draftPts.length >= this.activeMinPoints) {
      this._rebuildPreview();
    }
  }

  setMode(m) {
    if (this.mode === m) return;
    if (this._drafting) this.cancelDraft();
    this._placePts = [];
    this._clearGhost();
    this.mode = m;
    this._onChange();
  }

  // ── Ghost / hover preview ───────────────────────────────────────────────────

  updateGhost(wx, wy, wz, cameraForward) {
    if (!this.activeObjDef) return;

    const isDynamic = this._placePts.length > 0;
    const isPoint   = this.activeObjDef.preview === "point" || this.activeObjDef.minPoints === 1;
    const now = performance.now();

    // Compute normalised forward for strip orientation tracking
    const fwdRaw = cameraForward ?? new THREE.Vector3(1, 0, 0);
    const fwd = new THREE.Vector3(fwdRaw.x, 0, fwdRaw.z).normalize();

    // Decide whether we need a full rebuild:
    //  • dynamic path   → throttled (80 ms) so live-drag isn't too expensive
    //  • strip preview  → rebuild whenever cursor OR direction changes (cheap 3-pt build)
    //  • point preview  → build once per type; just slide position after
    let needRebuild = !this._ghostGrp || this._ghostTypeId !== this.activeObjDef.id;
    if (!needRebuild) {
      if (isDynamic) {
        needRebuild = (now - this._ghostLastRebuild) > this._ghostThrottle;
      } else if (!isPoint) {
        // Strip: rebuild if direction changed enough (dot < 0.9998 ≈ 1° of arc)
        needRebuild = !this._ghostFwd || this._ghostFwd.dot(fwd) < 0.9998;
      }
    }

    if (needRebuild) {
      this._clearGhost();
      let pts;
      let useWorldPos = false;

      if (isDynamic) {
        pts = [this._placePts[0], new THREE.Vector3(wx, wy, wz)];
        useWorldPos = true;
      } else if (isPoint) {
        // Build at origin, slide to cursor each frame — cheap
        pts = [new THREE.Vector3(0, 0, 0)];
      } else {
        // Strip: build at world position so terrain-height and rotation match placement exactly
        const half = 6; // matches handlePlaceClick
        const p0x = wx - fwd.x * half, p0z = wz - fwd.z * half;
        const p1x = wx + fwd.x * half, p1z = wz + fwd.z * half;
        pts = [
          new THREE.Vector3(p0x, this.getWorldHeight(p0x, p0z), p0z),
          new THREE.Vector3(wx, wy, wz),
          new THREE.Vector3(p1x, this.getWorldHeight(p1x, p1z), p1z),
        ];
        useWorldPos = true;
      }

      const params = this._resolveParams(this.activeObjDef, this.activeParams);
      try {
        const grp = this.activeObjDef.build({
          points: pts,
          closed: false,
          params,
          getWorldHeight: useWorldPos ? this.getWorldHeight : _flatGround,
        });
        if (grp) {
          _makeTransparent(grp, 0.45);
          if (!useWorldPos) grp.position.set(wx, wy, wz); // point-object: slide mode
          this._ghostGrp       = grp;
          this._ghostTypeId    = this.activeObjDef.id;
          this._ghostLastRebuild = now;
          this._ghostFwd       = fwd.clone();
          this.scene.add(grp);
        }
      } catch {}
    } else if (this._ghostGrp && isPoint && !isDynamic) {
      // Point object — just slide, no rebuild needed
      this._ghostGrp.position.set(wx, wy, wz);
    } else if (this._ghostGrp && !isPoint && !isDynamic) {
      // Strip at world pos — cursor moved but direction didn't change enough to rebuild.
      // Move the existing ghost by the delta to keep it responsive between rebuilds.
      this._ghostGrp.position.x += wx - (this._ghostLastWx ?? wx);
      this._ghostGrp.position.z += wz - (this._ghostLastWz ?? wz);
    }

    this._ghostLastWx = wx;
    this._ghostLastWz = wz;
    if (this._ghostGrp) this._ghostGrp.visible = true;
  }

  hideGhost() {
    if (this._ghostGrp) this._ghostGrp.visible = false;
  }

  // ── Place mode (default) ────────────────────────────────────────────────────

  // cameraForward: THREE.Vector3 — camera look direction, used to orient path objects
  handlePlaceClick(wx, wz, cameraForward) {
    if (!this.activeObjDef) return;
    const wy = this.getWorldHeight(wx, wz);

    if (this.activeObjDef.preview === "point" || this.activeObjDef.minPoints === 1) {
      // Point object — single click, immediate placement
      this._commitPoints([new THREE.Vector3(wx, wy, wz)]);
    } else {
      // Path object — place a short default strip aligned to camera forward
      const fwd = cameraForward
        ? new THREE.Vector3(cameraForward.x, 0, cameraForward.z).normalize()
        : new THREE.Vector3(1, 0, 0);
      const half = 6; // 6m each side = 12m default strip
      const p0 = new THREE.Vector3(wx - fwd.x * half, 0, wz - fwd.z * half);
      const pm = new THREE.Vector3(wx, 0, wz);
      const p1 = new THREE.Vector3(wx + fwd.x * half, 0, wz + fwd.z * half);
      p0.y = this.getWorldHeight(p0.x, p0.z);
      pm.y = wy;
      p1.y = this.getWorldHeight(p1.x, p1.z);
      this._commitPoints([p0, pm, p1]);
    }
    this._onChange();
  }

  cancelPlaceDraft() {
    this._placePts = [];
    this._clearGhost();
    this._onChange();
  }

  // ── Spline mode ─────────────────────────────────────────────────────────────

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
    const last = this._handleGroup.children[this._handleGroup.children.length - 1];
    if (last && last !== this._lineObj) this._handleGroup.remove(last);
    this._rebuildLine();
    if (this._draftPts.length >= this.activeMinPoints) this._rebuildPreview();
    else this._clearPreview();
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
    if (this._draftPts.length >= this.activeMinPoints) this._rebuildPreview();
    this._onChange();
  }

  canCommit() {
    return this._drafting && this._draftPts.length >= this.activeMinPoints;
  }

  commit() {
    if (!this.canCommit()) return null;
    this._clearPreview();
    const grp = this._commitPoints(this._draftPts.slice());
    this._drafting = false;
    this._draftPts = [];
    this._clearHandles();
    this._onChange();
    return grp;
  }

  // ── Objects list ────────────────────────────────────────────────────────────

  removeObject(idx) {
    const entry = this.objects[idx];
    if (!entry) return;
    this.scene.remove(entry.group);
    entry.group.traverse(o => { if (o.isMesh) o.geometry?.dispose(); });
    const wi = this._windmills.findIndex(w => w.group === entry.group);
    if (wi >= 0) this._windmills.splice(wi, 1);
    this.objects.splice(idx, 1);
    this._onChange();
  }

  // ── Render loop ──────────────────────────────────────────────────────────────

  update(dt) {
    for (const { group, params } of this._windmills) {
      try { updateWindmillRotors(group, params, dt); } catch {}
    }
  }

  // ── Internals ────────────────────────────────────────────────────────────────

  _commitPoints(pts) {
    const params = this._resolveParams(this.activeObjDef, this.activeParams);
    let group = null;
    try {
      group = this.activeObjDef.build({
        points: pts,
        closed: this.draftClosed,
        params,
        getWorldHeight: this.getWorldHeight,
      });
    } catch (err) {
      console.error("[SplineObjectSystem] Build failed:", err);
    }
    if (group) {
      // Wrap in a pivot at the visual center so TransformControls attaches correctly.
      // The inner group keeps geometry at its original world-space vertices;
      // the wrapper sits at the bounding-box center so the gizmo appears on the object.
      const wrapper = this._wrapWithPivot(group);
      this.scene.add(wrapper);
      const entry = { objDef: this.activeObjDef, label: this.activeObjDef.label, params, points: pts, closed: this.draftClosed, group: wrapper };
      if (this.activeObjDef.id === "windmill") this._windmills.push({ group: wrapper, params });
      this.objects.push(entry);
    }
    return group;
  }

  // Wraps innerGroup in a parent placed at its visual bounding-box center.
  // innerGroup.position is set to -center so world positions of all meshes are unchanged.
  // The returned wrapper has position = visual center → TC attaches there correctly.
  _wrapWithPivot(innerGroup) {
    const box = new THREE.Box3().setFromObject(innerGroup);
    const wrapper = new THREE.Group();
    if (!box.isEmpty()) {
      const center = new THREE.Vector3();
      box.getCenter(center);
      wrapper.position.copy(center);
      innerGroup.position.set(-center.x, -center.y, -center.z);
    }
    wrapper.add(innerGroup);
    return wrapper;
  }

  // 3 collinear points for strip objects — avoids CatmullRom phantom-endpoint curl.
  // Aligned to cameraForward so the ghost matches what handlePlaceClick will produce.
  _previewPointsAtOrigin(cameraForward) {
    const def = this.activeObjDef;
    if (!def) return [new THREE.Vector3(0, 0, 0)];
    if (def.preview === "point" || def.minPoints === 1) {
      return [new THREE.Vector3(0, 0, 0)];
    }
    const fwd = cameraForward
      ? new THREE.Vector3(cameraForward.x, 0, cameraForward.z).normalize()
      : new THREE.Vector3(1, 0, 0);
    const half = 6; // must match handlePlaceClick's half = 6
    return [
      new THREE.Vector3(-fwd.x * half, 0, -fwd.z * half),
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(fwd.x * half, 0, fwd.z * half),
    ];
  }

  _resolveParams(def, userParams) {
    const merged = { ...(def.defaults ?? {}), ...userParams };
    return def.resolveParams ? def.resolveParams(merged) : merged;
  }

  _clearGhost() {
    if (this._ghostGrp) {
      this.scene.remove(this._ghostGrp);
      this._ghostGrp.traverse(o => { if (o.isMesh) o.geometry?.dispose(); });
      this._ghostGrp = null;
      this._ghostTypeId = null;
    }
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
    const geo  = new THREE.BufferGeometry().setFromPoints(curve.getPoints(Math.max(80, pts.length * 20)));
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
        _makeTransparent(grp, 0.55);
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
      this._previewGrp.traverse(o => { if (o.isMesh) o.geometry?.dispose(); });
      this._previewGrp = null;
    }
  }

  _clearHandles() {
    if (this._lineObj) { this._lineObj.geometry.dispose(); this._lineObj = null; }
    this._handleGroup.clear();
  }

  _onChange() { this.onChange?.(); }

  dispose() {
    this.cancelDraft();
    this._clearGhost();
    this.scene.remove(this._handleGroup);
  }
}

function _makeTransparent(grp, opacity) {
  grp.traverse(o => {
    if (o.isMesh) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) { m.transparent = true; m.opacity = opacity; }
    }
  });
}
