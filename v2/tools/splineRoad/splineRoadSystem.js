import * as THREE from "three";
import {
  buildSplineRoadGeometry,
  makeSplineRoadCurve,
} from "../../core/splineRoad/splineRoadGeometry.js";

const _AXIS_Z = new THREE.Vector3(0, 0, 1);
const _rollQuat = new THREE.Quaternion();
const _relQuat = new THREE.Quaternion();
const _frameQuat = new THREE.Quaternion();
const _snapTan = new THREE.Vector3();

/**
 * Spline Road — a dedicated, isolated editor mode that builds solid "depth roads"
 * (thick drivable slabs + side barriers) along centripetal Catmull-Rom splines.
 *
 * Supports MULTIPLE independent roads (for sky courses with gaps/jumps between
 * segments) and extending a road from EITHER endpoint (right-click the first
 * point to grow the start, the last to grow the end). Deliberately separate from
 * SplineSystem so it can't affect the existing spline tool.
 *
 * A "road" is `{ points: THREE.Vector3[], rolls: number[] }`. All params come
 * from `toolState.splineRoad`; the road list serializes to `toolState.splineRoad.roadsData`.
 */
export class SplineRoadSystem {
  constructor({ scene, toolState, getWorldHeight }) {
    this.scene = scene;
    this.toolState = toolState;
    this.getWorldHeight = getWorldHeight || (() => 0);

    this.roads = [{ points: [], rolls: [] }];
    this.activeRoadIdx = 0;
    this.selectedIdx = -1; // point index within the active road
    this.dragging = false;
    this.pointMeshes = []; // each has userData { roadIdx, pointIdx }

    this.handleGroup = new THREE.Group();
    this.handleGroup.name = "SplineRoadHandles";
    scene.add(this.handleGroup);

    this.roadGroup = new THREE.Group();
    this.roadGroup.name = "SplineRoad";
    scene.add(this.roadGroup);

    this.roadMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.85,
      metalness: 0.0,
      side: THREE.DoubleSide,
    });
    this.roadMeshes = []; // deck meshes across all roads (wheel collider)
    this.barrierMeshes = []; // barrier meshes across all roads (chassis solids)

    this.gizmoProxy = new THREE.Object3D();
    this.gizmoProxy.name = "SplineRoadGizmoProxy";
    scene.add(this.gizmoProxy);
    this._gizmo = null;
    this._gizmoMode = "translate"; // "translate" = move point, "rotate" = bank
    this._gizmoBaseQuat = new THREE.Quaternion();
    // Roll-accumulation state so the Tilt gizmo can wind past ±180° (corkscrews).
    this._rollAtAttach = 0;
    this._gizmoPrevRaw = 0;
    this._gizmoAccum = 0;

    this.undoStack = [];
    this.redoStack = [];
  }

  get _s() {
    return this.toolState.splineRoad;
  }
  get _active() {
    return this.roads[this.activeRoadIdx] || this.roads[0];
  }

  // ── Undo/redo ────────────────────────────────────────────────────────────
  _snapshot() {
    return {
      roads: this.roads.map((rd) => ({
        points: rd.points.map((p) => ({ x: p.x, y: p.y, z: p.z })),
        rolls: rd.rolls.slice(),
      })),
      activeRoadIdx: this.activeRoadIdx,
      selectedIdx: this.selectedIdx,
    };
  }
  _pushUndo() {
    this.undoStack.push(this._snapshot());
    this.redoStack.length = 0;
    if (this.undoStack.length > 40) this.undoStack.shift();
  }
  _restore(snap) {
    this.roads = snap.roads.map((rd) => ({
      points: rd.points.map((p) => new THREE.Vector3(p.x, p.y, p.z)),
      rolls: rd.points.map((_, i) => (rd.rolls && rd.rolls[i]) || 0),
    }));
    if (this.roads.length === 0) this.roads = [{ points: [], rolls: [] }];
    this.activeRoadIdx = Math.min(snap.activeRoadIdx, this.roads.length - 1);
    this.selectedIdx = snap.selectedIdx;
    this.dragging = false;
    this._syncToolState();
    this._rebuild();
    this._updateSelected();
  }
  undo() {
    const snap = this.undoStack.pop();
    if (!snap) return;
    this.redoStack.push(this._snapshot());
    this._restore(snap);
  }
  redo() {
    const snap = this.redoStack.pop();
    if (!snap) return;
    this.undoStack.push(this._snapshot());
    this._restore(snap);
  }
  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  // ── Persistence ──────────────────────────────────────────────────────────
  _syncToolState() {
    this._s.roadsData = this.roads.map((rd) => ({
      points: rd.points.map((p) => ({ x: p.x, y: p.y, z: p.z })),
      rolls: rd.rolls.slice(),
    }));
  }
  loadFromToolState() {
    const data = this._s.roadsData;
    if (Array.isArray(data) && data.length) {
      this.roads = data.map((rd) => ({
        points: (rd.points || []).map((p) => new THREE.Vector3(p.x, p.y, p.z)),
        rolls: (rd.points || []).map((_, i) => (rd.rolls && rd.rolls[i]) || 0),
      }));
    } else if (Array.isArray(this._s.points) && this._s.points.length) {
      // Migrate a legacy single-road project.
      const rolls = Array.isArray(this._s.rolls) ? this._s.rolls : [];
      this.roads = [{
        points: this._s.points.map((p) => new THREE.Vector3(p.x, p.y, p.z)),
        rolls: this._s.points.map((_, i) => rolls[i] || 0),
      }];
    } else {
      this.roads = [{ points: [], rolls: [] }];
    }
    this.activeRoadIdx = this.roads.length - 1;
    const a = this._active;
    this.selectedIdx = a.points.length ? a.points.length - 1 : -1;
    this._rebuild();
    this._updateSelected();
  }

  // ── Editing ──────────────────────────────────────────────────────────────
  /** Add a point to the ACTIVE road. If the first point is selected, prepend
   *  (extend the start); otherwise append (extend the end). */
  addPoint(hit) {
    this._pushUndo();
    const rd = this._active;
    const lift = this._s.deckLift ?? 0.4;
    const p = new THREE.Vector3(hit.x, hit.y + lift, hit.z);
    // Prepend only when the FIRST point of a multi-point road is selected (a
    // deliberate right-click on the start). Otherwise append — including right
    // after adding the very first point, so a fresh road builds forward.
    if (this.selectedIdx === 0 && rd.points.length >= 2) {
      rd.points.unshift(p);
      rd.rolls.unshift(0);
      this.selectedIdx = 0; // keep extending from the start
    } else {
      rd.points.push(p);
      rd.rolls.push(0);
      this.selectedIdx = rd.points.length - 1;
    }
    this._syncToolState();
    this._rebuild();
    this._updateSelected();
  }
  /** Begin a new, separate road segment (for gaps / jumps between roads). */
  newRoad() {
    this._pushUndo();
    this.roads.push({ points: [], rolls: [] });
    this.activeRoadIdx = this.roads.length - 1;
    this.selectedIdx = -1;
    this._syncToolState();
    this._rebuild();
    this._updateSelected();
  }
  setSelectedRoll(rollRad) {
    if (this.selectedIdx < 0) return;
    this._active.rolls[this.selectedIdx] = rollRad;
    this._syncToolState();
    this._rebuild();
  }
  moveSelected(hit) {
    if (this.selectedIdx < 0) return;
    const p = this._active.points[this.selectedIdx];
    p.x = hit.x;
    p.z = hit.z;
    this._syncToolState();
    this._rebuild();
  }
  setSelectedPointY(y) {
    if (this.selectedIdx < 0) return;
    this._active.points[this.selectedIdx].y = y;
    this._syncToolState();
    this._rebuild();
  }
  deleteSelected() {
    if (this.selectedIdx < 0) return;
    this._pushUndo();
    const rd = this._active;
    rd.points.splice(this.selectedIdx, 1);
    rd.rolls.splice(this.selectedIdx, 1);
    // Drop an emptied road (unless it's the only one).
    if (rd.points.length === 0 && this.roads.length > 1) {
      this.roads.splice(this.activeRoadIdx, 1);
      this.activeRoadIdx = Math.max(0, this.activeRoadIdx - 1);
    }
    const a = this._active;
    this.selectedIdx = Math.min(this.selectedIdx, a.points.length - 1);
    this._syncToolState();
    this._rebuild();
    this._updateSelected();
  }
  clearAll() {
    this._pushUndo();
    this.roads = [{ points: [], rolls: [] }];
    this.activeRoadIdx = 0;
    this.selectedIdx = -1;
    this.dragging = false;
    this._syncToolState();
    this._rebuild();
    this._updateSelected();
  }

  /** Right-click pick → make the hit point's road active + select it. */
  selectFromRaycaster(raycaster) {
    const hits = raycaster.intersectObjects(this.pointMeshes, false);
    if (hits.length === 0) return false;
    const ud = hits[0].object.userData;
    this.activeRoadIdx = ud.roadIdx;
    this.selectedIdx = ud.pointIdx;
    this._rebuild();
    this._updateSelected();
    return true;
  }

  /** Called when a gizmo MOVE drag ends — snap an endpoint to a nearby other
   *  endpoint and align direction + bank for a seamless join. */
  onGizmoDragEnd() {
    if (this._s.snapEnabled === false) return;
    if (this._gizmoMode !== "translate") return;
    this._trySnapEndpoint(this.activeRoadIdx, this.selectedIdx);
  }
  _trySnapEndpoint(roadIdx, pointIdx) {
    const rd = this.roads[roadIdx];
    if (!rd || rd.points.length < 2 || pointIdx < 0) return;
    const isFirst = pointIdx === 0;
    const isLast = pointIdx === rd.points.length - 1;
    if (!isFirst && !isLast) return; // only endpoints snap
    const myPt = rd.points[pointIdx];
    const snapR = Math.max(4, this._s.width ?? 9);
    let best = null;
    let bestD = snapR;
    for (let ri = 0; ri < this.roads.length; ri++) {
      const ord = this.roads[ri];
      if (ord.points.length < 2) continue;
      for (const ei of [0, ord.points.length - 1]) {
        if (ri === roadIdx && ei === pointIdx) continue;
        const d = myPt.distanceTo(ord.points[ei]);
        if (d < bestD) {
          bestD = d;
          best = { ri, ei };
        }
      }
    }
    if (!best) return;
    const tRoad = this.roads[best.ri];
    const tPt = tRoad.points[best.ei];
    myPt.copy(tPt); // 1) snap position
    // 2) target's outward direction (the way it exits at that endpoint)
    if (best.ei === tRoad.points.length - 1) _snapTan.copy(tPt).sub(tRoad.points[best.ei - 1]);
    else _snapTan.copy(tPt).sub(tRoad.points[best.ei + 1]);
    if (_snapTan.lengthSq() > 1e-8) {
      _snapTan.normalize();
      // 3) align my adjacent point so my road continues opposite the target's
      //    exit (head-to-tail) → smooth, kink-free join.
      const adjIdx = isFirst ? 1 : rd.points.length - 2;
      const dist = Math.max(2, myPt.distanceTo(rd.points[adjIdx]));
      rd.points[adjIdx].copy(myPt).addScaledVector(_snapTan, dist);
    }
    rd.rolls[pointIdx] = tRoad.rolls[best.ei] || 0; // 4) match bank at the join
    this._syncToolState();
    this._rebuild();
    this._updateSelected();
    if (this._gizmo) this.attachGizmo(this._gizmo); // re-seat gizmo on snapped point
  }

  /** Deck meshes for the stunt car's drive-surface (wheel) collider. */
  getColliderMeshes() {
    return this.roadMeshes;
  }
  /** Barrier meshes for the stunt car's chassis-collision solids. */
  getSolidMeshes() {
    return this.barrierMeshes;
  }

  _updateSelected() {
    const a = this._active;
    if (this.selectedIdx >= 0 && this.selectedIdx < a.points.length) {
      this._s.selectedPointY = a.points[this.selectedIdx].y;
      this._s.selectedPointRoll = ((a.rolls[this.selectedIdx] || 0) * 180) / Math.PI;
    }
  }

  // ── 3D gizmo (shared TransformControls, owned by main.js) ────────────────
  setGizmo(gizmo) {
    this._gizmo = gizmo;
  }
  setGizmoMode(mode) {
    this._gizmoMode = mode === "rotate" ? "rotate" : "translate";
    this._s.gizmoMode = this._gizmoMode;
    if (this._gizmo) this.attachGizmo(this._gizmo);
    return this._gizmoMode;
  }
  toggleGizmoMode() {
    return this.setGizmoMode(this._gizmoMode === "rotate" ? "translate" : "rotate");
  }
  attachGizmo(gizmo) {
    this._gizmo = gizmo;
    const rd = this._active;
    if (this.selectedIdx < 0 || this.selectedIdx >= rd.points.length) {
      this.detachGizmo(gizmo);
      return;
    }
    const p = rd.points[this.selectedIdx];
    if (this._gizmoMode === "rotate" && rd.points.length >= 2) {
      const curve = makeSplineRoadCurve(rd.points, !!this._s.closed, this._s.tension ?? 0.5);
      const t = THREE.MathUtils.clamp(this.selectedIdx / (rd.points.length - 1), 0, 1);
      const tangent = curve.getTangentAt(t).normalize();
      const curRoll = rd.rolls[this.selectedIdx] || 0;
      // Base = the current rolled frame; the gizmo drag delta accumulates from
      // here (unwrapped), so you can twist past ±180° into full corkscrews.
      _frameQuat.setFromUnitVectors(_AXIS_Z, tangent);
      _rollQuat.setFromAxisAngle(_AXIS_Z, curRoll);
      this._gizmoBaseQuat.copy(_frameQuat).multiply(_rollQuat);
      this._rollAtAttach = curRoll;
      this._gizmoPrevRaw = 0;
      this._gizmoAccum = 0;
      this.gizmoProxy.position.copy(p);
      this.gizmoProxy.quaternion.copy(this._gizmoBaseQuat);
      gizmo.attach(this.gizmoProxy);
      gizmo.setMode("rotate");
      gizmo.setSpace("local");
      gizmo.showX = false;
      gizmo.showY = false;
      gizmo.showZ = true; // only the tangent-axis ring (= roll)
    } else {
      gizmo.setMode("translate");
      gizmo.showX = true;
      gizmo.showY = true;
      gizmo.showZ = true;
      this.gizmoProxy.quaternion.identity();
      this.gizmoProxy.position.copy(p);
      gizmo.attach(this.gizmoProxy);
    }
    gizmo.enabled = true;
    gizmo.visible = true;
  }
  detachGizmo(gizmo) {
    gizmo.detach();
    gizmo.enabled = false;
    gizmo.visible = false;
    gizmo.showX = true;
    gizmo.showY = true;
    gizmo.showZ = true;
    gizmo.setMode("translate");
    gizmo.setSpace(this.toolState.gizmo?.space === "local" ? "local" : "world");
    this.gizmoProxy.quaternion.identity();
  }
  syncFromGizmo() {
    const rd = this._active;
    if (this.selectedIdx < 0 || this.selectedIdx >= rd.points.length) return;
    if (this._gizmoMode === "rotate") {
      // Drag delta since attach (around the tangent), unwrapped + accumulated so
      // it can exceed ±180° → full corkscrews.
      _relQuat.copy(this._gizmoBaseQuat).invert().multiply(this.gizmoProxy.quaternion);
      const raw = 2 * Math.atan2(_relQuat.z, _relQuat.w);
      let d = raw - this._gizmoPrevRaw;
      if (d > Math.PI) d -= 2 * Math.PI;
      else if (d < -Math.PI) d += 2 * Math.PI;
      this._gizmoAccum += d;
      this._gizmoPrevRaw = raw;
      rd.rolls[this.selectedIdx] = this._rollAtAttach + this._gizmoAccum;
    } else {
      rd.points[this.selectedIdx].copy(this.gizmoProxy.position);
    }
    this._syncToolState();
    this._rebuild();
    this._updateSelected();
  }

  syncVisibility() {
    const inMode = this.toolState.mode === "splineRoad";
    this.handleGroup.visible = inMode && this._s.showHandles !== false;
    if (!inMode) this.dragging = false;
  }

  // ── Rebuild visuals + road meshes (all roads) ────────────────────────────
  _disposeGroup(group) {
    while (group.children.length) {
      const c = group.children[0];
      group.remove(c);
      if (c.geometry) c.geometry.dispose();
      if (c.material && c.material !== this.roadMat) c.material.dispose();
    }
  }

  _rebuild() {
    const s = this._s;
    this._disposeGroup(this.handleGroup);
    this.pointMeshes = [];
    this._disposeGroup(this.roadGroup);
    this.roadMeshes = [];
    this.barrierMeshes = [];

    for (let roadIdx = 0; roadIdx < this.roads.length; roadIdx++) {
      const rd = this.roads[roadIdx];
      const isActive = roadIdx === this.activeRoadIdx;
      const curve =
        rd.points.length >= 2
          ? makeSplineRoadCurve(rd.points, !!s.closed, s.tension ?? 0.5)
          : null;

      // Centreline
      if (curve) {
        const linePts = curve.getPoints(Math.max(60, rd.points.length * 24));
        const line = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(linePts),
          new THREE.LineBasicMaterial({ color: isActive ? 0x00ccff : 0x335f7a }),
        );
        this.handleGroup.add(line);
      }
      // Handle spheres
      for (let i = 0; i < rd.points.length; i++) {
        const selected = isActive && i === this.selectedIdx;
        const color = selected ? 0xffff00 : isActive ? 0xff4400 : 0x8a4a2a;
        const m = new THREE.Mesh(
          new THREE.SphereGeometry(1.1, 14, 10),
          new THREE.MeshBasicMaterial({ color, depthTest: false }),
        );
        m.renderOrder = 999;
        m.position.copy(rd.points[i]);
        m.userData = { roadIdx, pointIdx: i };
        this.handleGroup.add(m);
        this.pointMeshes.push(m);
      }

      // Road mesh + barriers
      if (curve) {
        const built = buildSplineRoadGeometry(curve, {
          width: s.width ?? 9,
          thickness: s.thickness ?? 1.0,
          bank: s.bank ?? 0.6,
          bankSmooth: s.bankSmooth ?? 0.12,
          segments: Math.max(
            24,
            Math.min(800, Math.round(rd.points.length * (s.segmentsPerPoint ?? 28))),
          ),
          deckColor: s.deckColor ?? 0x2c3138,
          sideColor: s.sideColor ?? 0x6f757c,
          kerbColor: s.kerbColor ?? 0xd23b3b,
          pointRolls: rd.rolls,
          barrier: {
            enabled: s.barrierEnabled !== false,
            height: s.barrierHeight ?? 0.7,
            depth: s.barrierDepth ?? 0.3,
            color: s.barrierColor ?? "#9aa3ad",
          },
        });
        const mesh = new THREE.Mesh(built.road, this.roadMat);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        this.roadGroup.add(mesh);
        this.roadMeshes.push(mesh);
        if (built.barrier) {
          const bmesh = new THREE.Mesh(built.barrier, this.roadMat);
          bmesh.castShadow = true;
          bmesh.receiveShadow = true;
          this.roadGroup.add(bmesh);
          this.barrierMeshes.push(bmesh);
        }
      }
    }

    this.syncVisibility();
  }

  dispose() {
    this._disposeGroup(this.handleGroup);
    this._disposeGroup(this.roadGroup);
    this.scene.remove(this.handleGroup);
    this.scene.remove(this.roadGroup);
    this.roadMat.dispose();
  }
}
