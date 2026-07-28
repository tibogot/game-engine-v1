import * as THREE from "three";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import {
  PIECE_CATALOG,
  PIECE_BY_ID,
  roadParams,
  pieceParams,
  guardrailParams,
  buildPiece,
  initialConnector,
  socketMatrix,
} from "./modularRoadKit.js";

/** Shared empty geometry used to drop the selection-highlight's reference to a
 *  piece geometry without disposing that (shared) geometry. */
const _EMPTY_GEO = new THREE.BufferGeometry();

/** Scratch for the anchor-orientation math (avoids per-drag allocation). */
const _YUP = new THREE.Vector3(0, 1, 0);
const _A_TRAVEL = new THREE.Vector3();
const _A_UP = new THREE.Vector3();
const _A_Q = new THREE.Quaternion();
const _A_E = new THREE.Euler();
const _A_M = new THREE.Matrix4();
const _A_Q2 = new THREE.Quaternion();
const _A_V = new THREE.Vector3();
const _A_V2 = new THREE.Vector3();
const _UNIT_SCALE = new THREE.Vector3(1, 1, 1);
const _isIdentityQuat = (q) => Math.abs(q.w) > 0.9999999;

/** Ballistic landing for demo jumps — same math as GapPreview.update().
 *  Connector Z column is −travel, so launch dir is the negated Z axis. */
function _ballisticLanding(connector, speed, g, landingDrop) {
  const e = connector.elements;
  const exit = new THREE.Vector3().setFromMatrixPosition(connector);
  const dir = new THREE.Vector3(-e[8], -e[9], -e[10]).normalize();
  const v0 = dir.clone().multiplyScalar(speed);
  const targetY = exit.y - landingDrop;
  const dt = 1 / 60;
  let prevY = exit.y;
  for (let t = dt; t < 12; t += dt) {
    const y = exit.y + v0.y * t - 0.5 * g * t * t;
    if (prevY > targetY && y <= targetY) {
      const x = exit.x + v0.x * t;
      const z = exit.z + v0.z * t;
      // Match beginNewChain yaw: travel = R_y(yaw)·(0,0,-1) = (−sin, 0, −cos).
      return {
        pos: new THREE.Vector3(x, targetY, z),
        yaw: Math.atan2(-dir.x, -dir.z),
      };
    }
    prevY = y;
  }
  return null;
}

/**
 * Auto-chain modular road builder. Pieces always snap onto the track's current
 * open exit connector — no grid. Each placed entry stores the piece id and a
 * snapshot of its geometry params so the whole chain can be rebuilt (e.g. when
 * the shared cross-section profile changes) while staying connected.
 */
export class ModularRoadBuilder {
  /**
   * @param {object} o
   * @param {THREE.Scene} o.scene
   * @param {THREE.Material} o.material shared road material
   * @param {THREE.Material} [o.railMaterial] shared guardrail material
   * @param {THREE.Material} [o.shellMaterial] shared tunnel-shell material
   * @param {THREE.Material} [o.decorMaterial] start/finish/checkpoint decor
   * @param {THREE.Camera} [o.camera] for free-placement gizmo
   * @param {HTMLElement} [o.domElement] canvas element for gizmo input
   * @param {import("three/addons/controls/OrbitControls.js").OrbitControls} [o.orbit]
   * @param {() => boolean} [o.isBuildMode]
   * @param {() => void} [o.onChange]
   */
  constructor({
    scene,
    material,
    railMaterial = null,
    shellMaterial = null,
    decorMaterial = null,
    camera = null,
    domElement = null,
    orbit = null,
    isBuildMode = () => true,
    onChange = null,
  }) {
    this.scene = scene;
    this.material = material;
    this.railMaterial = railMaterial;
    this.shellMaterial = shellMaterial;
    this.decorMaterial = decorMaterial;
    this.orbit = orbit;
    this.isBuildMode = isBuildMode;
    this.onChange = onChange;
    // Kept for click-to-pick (delete / replace / insert). The placement gizmo
    // below also uses them, but only when both are present.
    this._camera = camera;
    this._domElement = domElement;
    /** The placed piece currently selected for editing, or null. */
    this.selectedPiece = null;
    /** Pivot pose captured when a gizmo drag begins — piece edits snap the
     *  DELTA against it (see _onPieceGizmoChange). */
    this._dragStartPos = new THREE.Vector3();
    this._dragStartQuat = new THREE.Quaternion();
    this._raycaster = new THREE.Raycaster();
    this._pickNdc = new THREE.Vector2();

    // Build-grid snapping (see setSnap). 8 m cells + 15° yaw by default.
    this.snapEnabled = true;
    this.snapStep = 8;
    this.snapYawDeg = 15;

    this.activePieceId = PIECE_CATALOG[0].id;
    /** @type {{id:string, chainId:number, pp:object, mesh:THREE.Mesh, railMesh:THREE.Mesh|null, shellMesh:THREE.Mesh|null, decorMesh:THREE.Mesh|null, connectorIn:THREE.Matrix4, connectorOut:THREE.Matrix4}[]} */
    this.pieces = [];

    /**
     * First-class chains. Each chain owns an `anchor` connector (its start) that
     * the placement gizmo edits; pieces in a chain are rebuilt sequentially from
     * that anchor, so moving the anchor rigidly moves/rotates the whole chain.
     * New pieces append to `activeChainId`; N starts a new chain, [ / ] cycle.
     * @type {{id:number, anchor:THREE.Matrix4}[]}
     */
    this.chains = [{ id: 0, anchor: initialConnector() }];
    this.chainSeq = 1;
    this.activeChainId = 0;
    this.currentConnector = initialConnector();

    /** Anchor gizmo state for the active chain. `_freeQuat` is the FULL
     *  orientation (pitch/roll/yaw) — this is what lets an anchor tilt, e.g. a
     *  banked landing strip after a jump. `freeYaw` is kept in sync as the
     *  extracted yaw for the few consumers that only want a heading. */
    this.freePlaceMode = true;
    this.freeYaw = 0;
    this._freeQuat = new THREE.Quaternion();
    this._freePos = new THREE.Vector3(0, 0, 0);

    /**
     * What the placement gizmo edits (Apex-Rush placement model):
     *  - "chain": the active chain's ANCHOR — dragging moves the whole chain
     *    (entered via N / chain cycling, and on empty chains).
     *  - "ghost": the NEXT PIECE. It rides the open connector; dragging DETACHES
     *    it for free XYZ + yaw placement, with a magnetic snap back onto any
     *    chain's open end. Placing while detached starts a new chain there.
     */
    this._gizmoTarget = "chain";
    this.ghostDetached = false;
    this._ghostPos = new THREE.Vector3();
    this._ghostYaw = 0;

    this.root = new THREE.Group();
    this.root.name = "ModularRoad";
    scene.add(this.root);

    // Instanced render layer. The per-piece meshes below are kept (invisible) as
    // collision/edit/undo handles, but rendering is done by one InstancedMesh per
    // unique (role + geometry) — so a track of mostly-repeated canonical pieces
    // draws in a handful of calls instead of one per piece. Rebuilt on any change.
    this.instGroup = new THREE.Group();
    this.instGroup.name = "ModularRoadInstances";
    this.root.add(this.instGroup);
    /** @type {THREE.InstancedMesh[]} */
    this._instMeshes = [];
    /**
     * Default OFF: draw the per-piece meshes directly (each frustum-culled
     * individually, which CSM shadow cascades rely on). Instancing-by-type
     * groups pieces that are spread across the whole track and can't be region-
     * culled, so it re-renders everything into every shadow cascade — a net loss
     * for a spread-out track with shadows. Kept as a toggle (`setInstancing` / the
     * `I` key) for measuring; the real perf path is spatial-chunk merging.
     */
    this.instancingEnabled = false;

    this.ghostMat = new THREE.MeshBasicMaterial({
      color: 0x4a9eff,
      transparent: true,
      opacity: 0.32,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.ghost = new THREE.Mesh(new THREE.BufferGeometry(), this.ghostMat);
    this.ghost.name = "ModularRoadGhost";
    this.ghost.matrixAutoUpdate = false;
    scene.add(this.ghost);

    // Faint marker for GAP pieces (empty-space spacers). They're `noRender` so
    // they never draw as road or instance/merge into the drive track — but a
    // build-time ghost makes the hole visible and gives you something to
    // right-click to change it back. Drive mode hides builder.root entirely, so
    // this only ever shows while building.
    this.gapMaterial = new THREE.MeshBasicMaterial({
      color: 0xff7043, transparent: true, opacity: 0.14,
      depthWrite: false, side: THREE.DoubleSide,
    });

    /** Pivot + gizmo for free-chain placement (N). */
    this.placementPivot = new THREE.Object3D();
    this.placementPivot.name = "RoadPlacementPivot";
    scene.add(this.placementPivot);
    this.placementGizmo = null;
    if (camera && domElement) {
      this.placementGizmo = new TransformControls(camera, domElement);
      this.placementGizmo.setMode("translate");
      this.placementGizmo.setSpace("world");
      this.placementGizmo.enabled = false;
      this.placementGizmo.visible = false;
      this.placementGizmo.size = 1.15;
      scene.add(this.placementGizmo.getHelper());
      // Apply snap BEFORE wiring the change listener: assigning translationSnap /
      // rotationSnap makes TransformControls fire "change", and handling that
      // during construction cascades into onChange → the game's bakeCollision,
      // which touches `builder` before `new ModularRoadBuilder()` has returned
      // (temporal dead zone). Order matters here.
      this._applyGizmoSnap();
      this.placementGizmo.addEventListener("dragging-changed", (e) => {
        if (this.orbit) this.orbit.enabled = !e.value && this.isBuildMode();
        // Capture the pose the drag STARTED from. Piece edits snap the delta
        // against this rather than snapping absolute coordinates, so a piece
        // that isn't on a grid cell (which is most of them — the chain spaces
        // them by piece length, not by grid step) doesn't jump on first touch.
        if (e.value) {
          this._dragStartPos.copy(this.placementPivot.position);
          this._dragStartQuat.copy(this.placementPivot.quaternion);
        }
      });
      this.placementGizmo.addEventListener("change", () => this._onPlacementGizmoChange());
    }

    this.refreshGhost();
  }

  /**
   * Grid snapping for chain anchors — the TrackMania discipline that lets two
   * separately-built chains actually MEET (and therefore lets a circuit close).
   * Applies to the placement gizmo (native translationSnap/rotationSnap) and to
   * anchors set programmatically.
   */
  setSnap({ enabled, step, yawDeg } = {}) {
    if (enabled !== undefined) this.snapEnabled = !!enabled;
    if (step !== undefined) this.snapStep = Math.max(0.25, step);
    if (yawDeg !== undefined) this.snapYawDeg = Math.max(1, yawDeg);
    this._applyGizmoSnap();
  }

  _applyGizmoSnap() {
    const g = this.placementGizmo;
    if (!g) return;
    // TransformControls' translationSnap rounds the object's ABSOLUTE position
    // to the grid. That's right for placing a new chain anchor, but wrong for a
    // PLACED PIECE: pieces sit wherever the chain put them (a straight is 22 m,
    // the grid is 8 m), so touching the gizmo teleported the piece to the
    // nearest cell before you had moved anything. For pieces we turn it off and
    // snap the DRAG DELTA ourselves in _onPieceGizmoChange, which keeps the
    // piece where it is while still moving in tidy steps.
    //
    // rotationSnap is left on for every target — TransformControls snaps the
    // rotation ANGLE of the drag, which is already relative.
    const editingPiece = this._gizmoTarget === "piece";
    g.translationSnap = this.snapEnabled && !editingPiece ? this.snapStep : null;
    g.rotationSnap = this.snapEnabled ? THREE.MathUtils.degToRad(this.snapYawDeg) : null;
  }

  /** Snap a world position onto the build grid (in place). */
  snapPos(v) {
    if (!this.snapEnabled) return v;
    const s = this.snapStep;
    v.set(Math.round(v.x / s) * s, Math.round(v.y / s) * s, Math.round(v.z / s) * s);
    return v;
  }

  /** Snap a yaw (radians) onto the angle grid. */
  snapYaw(a) {
    if (!this.snapEnabled) return a;
    const s = THREE.MathUtils.degToRad(this.snapYawDeg);
    return Math.round(a / s) * s;
  }

  get count() {
    return this.pieces.length;
  }

  _snapshotParams() {
    return { ...pieceParams };
  }

  _notify() {
    this.onChange?.();
  }

  setActivePiece(id) {
    if (!PIECE_BY_ID.has(id)) return;
    this.activePieceId = id;
    this._ensureGizmoOnGhost();
    this.refreshGhost();
    this._notify();
  }

  /** Selecting a shape summons the gizmo on it (Apex-style) — at the open end,
   *  or wherever the ghost was already dragged to. */
  _ensureGizmoOnGhost() {
    if (!this.isBuildMode()) return;
    if (this._gizmoTarget === "ghost" && this.ghostDetached) {
      this._showGizmoAt(this._ghostPos, this._ghostYaw);
    } else {
      this._syncGizmoToOpenEnd();
    }
  }

  /**
   * Select a curated kit preset: apply its frozen params onto the shared
   * pieceParams, then make its base piece active. The generator is unchanged —
   * a preset is just a named param snapshot, so placing it builds identical
   * local geometry every time (instancing-friendly).
   * @param {{base:string, params:object}} preset
   */
  setActivePreset(preset) {
    if (!preset || !PIECE_BY_ID.has(preset.base)) return;
    Object.assign(pieceParams, preset.params);
    this.activePieceId = preset.base;
    this._ensureGizmoOnGhost();
    this.refreshGhost();
    this._notify();
  }

  /** Flip curve direction (only meaningful for the curve piece). */
  flip() {
    pieceParams.curveDir = pieceParams.curveDir >= 0 ? -1 : 1;
    this.refreshGhost();
    this._notify();
  }

  /** Start a new disconnected chain at `atPos` and make it active. */
  beginNewChain(atPos = null, yaw = null) {
    this.freePlaceMode = true;
    this._gizmoTarget = "chain";
    this.ghostDetached = false;
    this.freeYaw = this.snapYaw(yaw != null ? yaw : 0);
    this._freeQuat.setFromAxisAngle(_YUP, this.freeYaw); // new chains start level
    if (atPos) this._freePos.copy(atPos);
    else if (this.orbit?.target) this._freePos.copy(this.orbit.target);
    this.snapPos(this._freePos); // land the new chain on the build grid
    const id = this.chainSeq++;
    const anchor = this._anchorFromFree();
    this.chains.push({ id, anchor });
    this.activeChainId = id;
    this.currentConnector = anchor.clone();
    this._showPlacementGizmo();
    this.refreshGhost();
    this._notify();
  }

  _activeChain() {
    return this.chains.find((c) => c.id === this.activeChainId) ?? null;
  }

  /** Pieces of one chain, in placement order. */
  _chainPieces(chainId) {
    return this.pieces.filter((p) => p.chainId === chainId);
  }

  _lastPieceOfChain(chainId) {
    const ps = this._chainPieces(chainId);
    return ps.length ? ps[ps.length - 1] : null;
  }

  /** Recompute the open connector for the active chain (end, or its anchor). */
  _syncCurrentConnector() {
    const last = this._lastPieceOfChain(this.activeChainId);
    const chain = this._activeChain();
    this.currentConnector = last
      ? last.connectorOut.clone()
      : chain
        ? chain.anchor.clone()
        : initialConnector();
  }

  /** Switch the active (append) chain — gizmo grabs the WHOLE chain's anchor. */
  selectChain(chainId) {
    const chain = this.chains.find((c) => c.id === chainId);
    if (!chain) return;
    this.activeChainId = chainId;
    this.freePlaceMode = true;
    this._gizmoTarget = "chain";
    this.ghostDetached = false;
    // Seed the gizmo from the chain's anchor — FULL orientation, so a tilted
    // chain shows its tilt when re-selected instead of snapping back to level.
    this._freePos.setFromMatrixPosition(chain.anchor);
    _A_M.extractRotation(chain.anchor);
    this._setFreeQuat(_A_Q.setFromRotationMatrix(_A_M));
    this._syncCurrentConnector();
    this._showPlacementGizmo();
    this.refreshGhost();
    this._notify();
  }

  /** Cycle the active chain (dir -1 = previous, +1 = next). */
  cycleChain(dir = -1) {
    if (this.chains.length < 2) return;
    const i = this.chains.findIndex((c) => c.id === this.activeChainId);
    const n = this.chains.length;
    const next = this.chains[(i + (dir < 0 ? -1 : 1) + n) % n];
    this.selectChain(next.id);
  }

  get activeChainIndex() {
    return this.chains.findIndex((c) => c.id === this.activeChainId);
  }

  get chainCount() {
    return this.chains.length;
  }

  /** Hide the active-chain gizmo (used when another gizmo takes over). */
  deselectPlacement() {
    this._hidePlacementGizmo();
  }

  setPlacementGizmoMode(mode) {
    if (!this.placementGizmo) return;
    this.placementGizmo.setMode(mode);
    // A CHAIN ANCHOR may tilt on all 3 axes (banked landing strips); the NEXT
    // PIECE stays yaw-only because every socket in the kit is level by
    // convention. See _applyGizmoAxes.
    this._applyGizmoAxes();
    this._notify();
  }

  /** "chain" (gizmo moves the whole chain) or "ghost" (gizmo moves the next piece). */
  get gizmoMode() {
    return this._gizmoTarget;
  }

  /** Open end (last piece's exit, or the anchor) of every chain. */
  _openConnectors() {
    const out = [];
    for (const chain of this.chains) {
      const last = this._lastPieceOfChain(chain.id);
      out.push({ chainId: chain.id, matrix: last ? last.connectorOut : chain.anchor });
    }
    return out;
  }

  _nearestOpenConnector(pos) {
    let best = null;
    const p = new THREE.Vector3();
    for (const oc of this._openConnectors()) {
      const d = p.setFromMatrixPosition(oc.matrix).distanceTo(pos);
      if (!best || d < best.dist) best = { ...oc, dist: d };
    }
    return best;
  }

  /** Connector matrix from the detached ghost pose (level, yaw only). */
  _anchorFromGhost() {
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this._ghostYaw);
    const travel = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    return socketMatrix(this._ghostPos, travel, new THREE.Vector3(0, 1, 0));
  }

  /**
   * Bind the gizmo to the next piece at the active chain's open end (the default
   * state after selecting or placing a piece). Empty chains keep the "chain"
   * anchor target instead — same pose, and dragging it is what N expects.
   */
  _syncGizmoToOpenEnd() {
    const last = this._lastPieceOfChain(this.activeChainId);
    if (!last) {
      this._gizmoTarget = "chain";
      this.ghostDetached = false;
      this._showPlacementGizmo();
      return;
    }
    this._gizmoTarget = "ghost";
    this.ghostDetached = false;
    this._ghostPos.setFromMatrixPosition(this.currentConnector);
    this._ghostYaw = new THREE.Euler().setFromRotationMatrix(this.currentConnector, "YXZ").y;
    this._showGizmoAt(this._ghostPos, this._ghostYaw);
  }

  _showGizmoAt(pos, yaw) {
    if (!this.placementGizmo) return;
    this.placementPivot.position.copy(pos);
    this.placementPivot.rotation.set(0, yaw, 0);
    this.placementGizmo.attach(this.placementPivot);
    this.placementGizmo.enabled = true;
    this.placementGizmo.visible = true;
    this._applyGizmoAxes();
  }

  /** True while dragging / hovering the placement gizmo (suppress LMB place).
   *  Also covers the SELECTED-PIECE gizmo, whose target isn't freePlaceMode. */
  isUsingPlacementGizmo() {
    return !!(
      this.placementGizmo &&
      (this.freePlaceMode || this._gizmoTarget === "piece") &&
      (this.placementGizmo.dragging || this.placementGizmo.axis != null)
    );
  }

  _showPlacementGizmo() {
    if (!this.placementGizmo) return;
    // The anchor carries a FULL orientation, so drive the pivot's quaternion —
    // not a yaw scalar — or a tilt would be flattened the moment the gizmo shows.
    this.placementPivot.position.copy(this._freePos);
    this.placementPivot.quaternion.copy(this._freeQuat);
    this.placementGizmo.attach(this.placementPivot);
    this.placementGizmo.enabled = true;
    this.placementGizmo.visible = true;
    this._applyGizmoAxes();
  }

  _hidePlacementGizmo() {
    if (!this.placementGizmo) return;
    this.placementGizmo.detach();
    this.placementGizmo.enabled = false;
    this.placementGizmo.visible = false;
  }

  /**
   * Gizmo drag on a SELECTED PIECE.
   *  • rotate → set the piece's entry TILT (base⁻¹·pose), banking it + downstream.
   *  • translate → move the WHOLE CHAIN (a single piece can't move alone without
   *    tearing the chain), by shifting the chain anchor by the drag delta.
   * After rebuildAll the piece has moved, so the pivot is re-seated on it.
   */
  _onPieceGizmoChange() {
    const p = this.selectedPiece;
    if (!p) return;

    const rotating = this.placementGizmo.mode === "rotate";

    if (rotating && !p.detached) {
      // ATTACHED + rotate = TILT, which propagates down the chain. This is the
      // banked-landing-strip tool: bank one piece and the rest of the run banks
      // with it. Detach the piece first if you want it to turn on its own.
      _A_M.extractRotation(p._baseIn);
      _A_Q.setFromRotationMatrix(_A_M);            // base rotation
      // tilt = base⁻¹ · pivotOrientation
      _A_Q2.copy(this.placementPivot.quaternion).premultiply(_A_Q.invert());
      if (this.snapEnabled) {
        const step = THREE.MathUtils.degToRad(this.snapYawDeg || 15);
        _A_E.setFromQuaternion(_A_Q2, "YXZ");
        _A_E.x = Math.round(_A_E.x / step) * step;
        _A_E.y = Math.round(_A_E.y / step) * step;
        _A_E.z = Math.round(_A_E.z / step) * step;
        _A_Q2.setFromEuler(_A_E);
      }
      p.tilt.copy(_A_Q2);
    } else {
      // FREE MOVE / FREE ROTATE of this piece alone. Translating always detaches
      // (a chain piece has no position of its own to edit), and a detached piece
      // rotates on its own rather than tilting the run.
      this.detachPiece(p);
      // SNAP THE DELTA, NOT THE ABSOLUTE POSE. Pieces sit where the chain put
      // them, which is almost never on a grid cell, so rounding their absolute
      // position teleported them the instant the gizmo was touched. Snapping the
      // movement instead keeps the piece put and still moves in tidy steps.
      _A_V.copy(this.placementPivot.position);
      _A_Q2.copy(this.placementPivot.quaternion);
      if (this.snapEnabled) {
        _A_V.sub(this._dragStartPos);
        this.snapPos(_A_V);
        _A_V.add(this._dragStartPos);

        const step = THREE.MathUtils.degToRad(this.snapYawDeg || 15);
        _A_Q.copy(this._dragStartQuat).invert();
        _A_Q2.premultiply(_A_Q);                 // delta = start⁻¹ · current
        _A_E.setFromQuaternion(_A_Q2, "YXZ");
        _A_E.x = Math.round(_A_E.x / step) * step;
        _A_E.y = Math.round(_A_E.y / step) * step;
        _A_E.z = Math.round(_A_E.z / step) * step;
        _A_Q2.setFromEuler(_A_E).premultiply(this._dragStartQuat); // back to world
      }
      // pinnedIn is the seam BEFORE tilt, so strip this piece's own tilt back
      // out — otherwise a tilted piece would drift further every drag.
      _A_Q.copy(p.tilt).invert();
      _A_Q2.multiply(_A_Q);
      p.pinnedIn.compose(_A_V, _A_Q2, _UNIT_SCALE);
    }

    this.rebuildAll();
    // Re-seat the pivot on the piece's new pose (rebuild moved it).
    this.placementPivot.position.setFromMatrixPosition(p.connectorIn);
    _A_M.extractRotation(p.connectorIn);
    this.placementPivot.quaternion.setFromRotationMatrix(_A_M);
    this._updateSelectionHighlight();
  }

  _onPlacementGizmoChange() {
    // TransformControls fires "change" for PROPERTY writes too, not just drags —
    // `mode`, `enabled`, `showX/showY/showZ`, the snap settings, all of them go
    // through a defineProperty setter that dispatches it.
    //
    // ONLY REACT TO ACTUAL DRAGS. Attaching the gizmo to a freshly right-clicked
    // piece writes several of those properties (see _showPieceGizmo →
    // _applyGizmoAxes), so the setup itself arrived here looking like a drag:
    // the piece got detached and grid-snapped the instant you selected it, which
    // shifted it. `dragging` is true only between pointerdown and pointerup, and
    // every real transform in TransformControls dispatches inside that window
    // (including reset()), so nothing legitimate is lost.
    if (!this.placementGizmo?.visible) return;
    if (!this.placementGizmo.dragging) return;

    if (this._gizmoTarget === "piece") {
      this._onPieceGizmoChange();
      return;
    }

    if (this._gizmoTarget === "ghost") {
      // Moving the NEXT PIECE. Within magnet range of any chain's open end the
      // ghost locks onto it exactly (and that chain becomes the append target);
      // otherwise it detaches for free grid-snapped placement.
      const pos = this.placementPivot.position;
      const hit = this._nearestOpenConnector(pos);
      const magnet = Math.max(4, this.snapEnabled ? this.snapStep * 0.75 : 4);
      if (hit && hit.dist <= magnet) {
        this.activeChainId = hit.chainId;
        this._syncCurrentConnector();
        this.ghostDetached = false;
        this._ghostPos.setFromMatrixPosition(this.currentConnector);
        this._ghostYaw = new THREE.Euler().setFromRotationMatrix(this.currentConnector, "YXZ").y;
      } else {
        this.ghostDetached = true;
        this._ghostPos.copy(pos);
        this.snapPos(this._ghostPos);
        this._ghostYaw = this.snapYaw(this.placementPivot.rotation.y);
      }
      this.placementPivot.position.copy(this._ghostPos);
      this.placementPivot.rotation.set(0, this._ghostYaw, 0);
      this.refreshGhost();
      return; // ghost moves never touch placed geometry — no rebuild/rebake
    }

    if (!this.freePlaceMode) return;
    // The gizmo's own translationSnap/rotationSnap handle the drag, but re-snap
    // here too: rotationSnap doesn't apply in translate mode, and a programmatic
    // move would otherwise land off-grid. Read the pivot's FULL quaternion so a
    // 3-axis tilt of a chain anchor is kept (the next-piece gizmo stays yaw-only
    // via _applyGizmoAxes, so it can only ever produce a yaw here).
    this._freePos.copy(this.placementPivot.position);
    this.snapPos(this._freePos);
    this._setFreeQuat(this.placementPivot.quaternion);
    this._snapFreeQuat();
    this.placementPivot.position.copy(this._freePos);
    this.placementPivot.quaternion.copy(this._freeQuat);
    // Push the new anchor onto the active chain, then re-chain it rigidly.
    const chain = this._activeChain();
    if (chain) {
      chain.anchor = this._anchorFromFree();
      this.rebuildAll();
    } else {
      this._syncCurrentConnector();
      this.refreshGhost();
    }
  }

  setFreePlacement(pos, yaw) {
    this._freePos.copy(pos);
    if (yaw !== undefined) {
      this.freeYaw = yaw;
      this._freeQuat.setFromAxisAngle(_YUP, yaw); // an explicit yaw resets any tilt
    }
    this.placementPivot.position.copy(this._freePos);
    this.placementPivot.quaternion.copy(this._freeQuat);
    const chain = this._activeChain();
    if (chain) chain.anchor = this._anchorFromFree();
    this.rebuildAll();
  }

  rotateFreeYaw(delta) {
    if (this._gizmoTarget === "ghost") {
      // Q/E rotate the NEXT PIECE: detach it in place and spin it (yaw only).
      if (!this.ghostDetached) {
        this.ghostDetached = true;
        this._ghostPos.setFromMatrixPosition(this.currentConnector);
        this._ghostYaw = new THREE.Euler().setFromRotationMatrix(this.currentConnector, "YXZ").y;
      }
      this._ghostYaw += delta;
      this.placementPivot.position.copy(this._ghostPos);
      this.placementPivot.rotation.set(0, this._ghostYaw, 0);
      this.refreshGhost();
      return;
    }
    if (!this.freePlaceMode) return;
    // Q/E spin the anchor about WORLD up, PRESERVING any pitch/roll it carries
    // (premultiply, not a scalar reset), so a quick yaw doesn't flatten a bank.
    _A_Q.setFromAxisAngle(_YUP, delta);
    this._freeQuat.premultiply(_A_Q);
    this.freeYaw = _A_E.setFromQuaternion(this._freeQuat, "YXZ").y;
    this.placementPivot.quaternion.copy(this._freeQuat);
    const chain = this._activeChain();
    if (chain) chain.anchor = this._anchorFromFree();
    this.rebuildAll();
  }

  /** Reset the active chain's anchor tilt to level (keeps position + yaw). */
  levelAnchor() {
    if (!this.freePlaceMode) return false;
    this._freeQuat.setFromAxisAngle(_YUP, this.freeYaw);
    if (this.placementGizmo) this.placementPivot.quaternion.copy(this._freeQuat);
    const chain = this._activeChain();
    if (chain) { chain.anchor = this._anchorFromFree(); this.rebuildAll(); }
    return true;
  }

  /** Pitch/roll of the active anchor in degrees (yaw excluded), for a readout. */
  anchorTiltDeg() {
    _A_E.setFromQuaternion(this._freeQuat, "YXZ");
    return { pitch: THREE.MathUtils.radToDeg(_A_E.x), roll: THREE.MathUtils.radToDeg(_A_E.z) };
  }

  /** Build a connector matrix from the gizmo's pos + yaw. */
  /** Build the active chain's anchor matrix from the FULL free orientation.
   *  socketMatrix reconstructs exactly `_freeQuat` from the rotated travel+up
   *  (verified: for R, travel=R·-Z and up=R·+Y give basis R), so this supports
   *  any pitch/roll, and collapses to the old yaw-only behaviour when _freeQuat
   *  is a pure yaw (up stays +Y). */
  _anchorFromFree() {
    _A_TRAVEL.set(0, 0, -1).applyQuaternion(this._freeQuat);
    _A_UP.set(0, 1, 0).applyQuaternion(this._freeQuat);
    return socketMatrix(this._freePos, _A_TRAVEL, _A_UP);
  }

  /** Set the free orientation from a quaternion and keep `freeYaw` (the extracted
   *  yaw) in sync for consumers that only want a heading. */
  _setFreeQuat(q) {
    this._freeQuat.copy(q);
    this.freeYaw = _A_E.setFromQuaternion(this._freeQuat, "YXZ").y;
  }

  /** Snap each Euler component of an orientation to the yaw step. Snapping
   *  pitch/roll too keeps tilted anchors on tidy angles (e.g. 15° banks). */
  _snapFreeQuat() {
    if (!this.snapEnabled) return;
    const step = THREE.MathUtils.degToRad(this.snapYawDeg || 15);
    _A_E.setFromQuaternion(this._freeQuat, "YXZ");
    _A_E.x = Math.round(_A_E.x / step) * step;
    _A_E.y = Math.round(_A_E.y / step) * step;
    _A_E.z = Math.round(_A_E.z / step) * step;
    this._freeQuat.setFromEuler(_A_E);
    this.freeYaw = _A_E.y;
  }

  /** Show/hide gizmo axes for the current mode + target: translate = all axes;
   *  rotate = yaw-only for the NEXT PIECE (level-socket convention), but full
   *  3-axis for a CHAIN ANCHOR so it can tilt. */
  _applyGizmoAxes() {
    const g = this.placementGizmo;
    if (!g) return;
    // Snap policy depends on the target (see _applyGizmoSnap), and every place
    // that changes the target comes through here.
    this._applyGizmoSnap();
    const rot = g.mode === "rotate";
    // A CHAIN anchor or a selected PIECE may tilt on all 3 axes; the next-piece
    // ghost stays yaw-only (kit sockets are level).
    const fullTilt = rot && (this._gizmoTarget === "chain" || this._gizmoTarget === "piece");
    g.showX = !rot || fullTilt;
    g.showY = true;
    g.showZ = !rot || fullTilt;
  }

  /** Rebuild the translucent ghost at the open connector (or the detached pose). */
  refreshGhost() {
    const conn =
      this._gizmoTarget === "ghost" && this.ghostDetached
        ? this._anchorFromGhost()
        : this.currentConnector;
    const { geometry, world } = buildPiece(
      this.activePieceId,
      conn,
      pieceParams,
      roadParams,
      guardrailParams,
      guardrailParams.enabled,
    );
    this.ghost.geometry.dispose();
    this.ghost.geometry = geometry;
    this.ghost.matrix.copy(world);
    this.ghost.visible = this.isBuildMode();
  }

  setGhostVisible(v) {
    const on = v && this.isBuildMode();
    this.ghost.visible = on;
    if (!on) {
      this._hidePlacementGizmo();
    } else if (this._gizmoTarget === "ghost") {
      this._syncGizmoToOpenEnd();
    } else if (this.freePlaceMode) {
      this._showPlacementGizmo();
    }
  }

  /**
   * Build a per-piece mesh. It is kept (in root, but INVISIBLE) purely as a
   * collision / undo / edit handle — `bakeFromMeshes` reads its geometry +
   * matrixWorld, and undo/rebuild dispose its geometry. Visible rendering is the
   * InstancedMesh layer (see _rebuildInstances), so these never draw.
   */
  _makeMesh(geometry, material, world) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(world);
    // Invisible while instancing draws the road; visible (real mesh) when off.
    mesh.visible = !this.instancingEnabled;
    mesh.castShadow = mesh.receiveShadow = true;
    this.root.add(mesh);
    return mesh;
  }

  /** Toggle GPU instancing vs. drawing the per-piece meshes directly. */
  setInstancing(on) {
    this.instancingEnabled = !!on;
    for (const p of this.pieces) {
      for (const m of [p.mesh, p.railMesh, p.shellMesh, p.decorMesh]) {
        if (m) m.visible = m.userData.noRender ? true : !this.instancingEnabled;
      }
    }
    this._rebuildInstances();
    this._notify();
  }

  /** Stable 32-bit hash of a geometry's vertex positions (cached on the geometry),
   *  so identical pieces group into the same InstancedMesh. */
  _hashGeometry(geometry) {
    const ud = geometry.userData;
    if (ud._rhash !== undefined) return ud._rhash;
    const a = geometry.getAttribute("position").array;
    let h = 2166136261;
    h = Math.imul(h ^ a.length, 16777619);
    for (let i = 0; i < a.length; i++) h = Math.imul(h ^ Math.round(a[i] * 4096), 16777619);
    ud._rhash = h >>> 0;
    return ud._rhash;
  }

  /**
   * Rebuild the instanced render layer from the current pieces: group every
   * renderable sub-mesh by (role + geometry hash) and emit one InstancedMesh per
   * group with the pieces' world matrices. Cheap — called after any change; the
   * per-geometry hash is cached so repeats are O(pieces).
   */
  _rebuildInstances() {
    for (const im of this._instMeshes) {
      this.instGroup.remove(im);
      im.dispose();
    }
    this._instMeshes.length = 0;
    if (!this.instancingEnabled) return; // proxies render directly instead

    const groups = new Map(); // key -> { geometry, material, role, mats: Matrix4[] }
    const add = (proxy, material, role) => {
      if (!proxy || !material || proxy.userData.noRender) return;
      const g = proxy.geometry;
      const key = role + ":" + this._hashGeometry(g);
      let grp = groups.get(key);
      if (!grp) {
        grp = { geometry: g, material, role, mats: [] };
        groups.set(key, grp);
      }
      grp.mats.push(proxy.matrix);
    };
    for (const p of this.pieces) {
      add(p.mesh, this.material, "road");
      add(p.railMesh, this.railMaterial, "rail");
      add(p.shellMesh, this.shellMaterial, "shell");
      add(p.decorMesh, this.decorMaterial, "decor");
    }
    for (const grp of groups.values()) {
      const im = new THREE.InstancedMesh(grp.geometry, grp.material, grp.mats.length);
      for (let i = 0; i < grp.mats.length; i++) im.setMatrixAt(i, grp.mats[i]);
      im.instanceMatrix.needsUpdate = true;
      im.matrixAutoUpdate = false; // root/instGroup at origin → instance mats are world
      im.frustumCulled = false; // a track spans a large area; skip per-mesh culling
      im.castShadow = grp.role !== "decor";
      im.receiveShadow = true;
      this.instGroup.add(im);
      this._instMeshes.push(im);
    }
  }

  /**
   * Build a piece + its meshes and return the piece record — WITHOUT touching
   * `this.pieces`, the connector, or the render layer. Shared by place() and
   * insertPieceBefore(): they differ only in WHERE the record goes in the array.
   * Every sub-mesh carries a back-reference to the record so a raycast hit on
   * any part maps straight to the piece (see pickPiece).
   */
  _makePieceEntry(id, chainId, connectorIn, pp, edges) {
    const built = buildPiece(id, connectorIn, pp, roadParams, guardrailParams, edges);
    const mesh = this._makeMesh(built.geometry, this.material, built.world);
    mesh.userData.pieceId = id;
    if (built.def.noMesh) {
      mesh.userData.noCollision = true;
      mesh.userData.noRender = true; // gap spacer: no road, no instance/merge
      mesh.material = this.gapMaterial; // ...but a faint build-time marker
      mesh.visible = true;
    }
    const railMesh =
      built.railGeometry && this.railMaterial
        ? this._makeMesh(built.railGeometry, this.railMaterial, built.world)
        : null;
    const shellMesh =
      built.shellGeometry && this.shellMaterial
        ? this._makeMesh(built.shellGeometry, this.shellMaterial, built.world)
        : null;
    const decorMesh =
      built.decorGeometry && this.decorMaterial
        ? this._makeMesh(built.decorGeometry, this.decorMaterial, built.world)
        : null;
    if (decorMesh) decorMesh.castShadow = false; // flat markings don't cast

    const piece = {
      id,
      chainId,
      pp: { ...pp },
      edges,
      mesh,
      railMesh,
      shellMesh,
      decorMesh,
      connectorIn: connectorIn.clone(),
      connectorOut: built.connectorOut.clone(),
      /** Per-piece entry tilt (local-frame rotation, propagates downstream). */
      tilt: new THREE.Quaternion(),
      /** Entry seam BEFORE the tilt — filled by rebuildAll, used by the edit gizmo. */
      _baseIn: connectorIn.clone(),
      /** Free-placed? Then `pinnedIn` replaces the chain's running connector. */
      detached: false,
      /** @type {THREE.Matrix4|null} absolute entry seam while detached. */
      pinnedIn: null,
    };
    for (const m of [mesh, railMesh, shellMesh, decorMesh]) {
      if (m) m.userData.piece = piece;
    }
    return piece;
  }

  /** Place the active piece — onto the open end, or wherever the detached
   *  ghost sits (which starts a new chain there, Apex-style). */
  place() {
    if (this._gizmoTarget === "ghost" && this.ghostDetached) {
      const id = this.chainSeq++;
      const anchor = this._anchorFromGhost();
      this.chains.push({ id, anchor });
      this.activeChainId = id;
      this.currentConnector = anchor.clone();
      this.ghostDetached = false;
    }
    const piece = this._makePieceEntry(
      this.activePieceId,
      this.activeChainId,
      this.currentConnector,
      this._snapshotParams(),
      guardrailParams.enabled,
    );
    this.pieces.push(piece);
    this.currentConnector = piece.connectorOut.clone();
    this._rebuildInstances();
    // Hand the gizmo to the NEXT piece at the fresh open end.
    this._syncGizmoToOpenEnd();
    this.refreshGhost();
    this._notify();
    return piece.mesh;
  }

  // ── PIECE EDITING (delete / replace / insert) ──────────────────────────────
  // All three are the same move: change `this.pieces`, then rebuildAll() re-walks
  // each chain from its anchor and reconnects everything downstream. The array
  // order WITHIN a chain is the chain order, so a splice is all that's needed.

  /**
   * Which placed piece is under a screen-space point, or null.
   * Raycasts the per-piece proxy meshes — they stay in the scene as edit handles
   * even while the instanced layer does the drawing, and a raycast hits them
   * regardless of their `visible` flag.
   */
  pickPiece(clientX, clientY) {
    if (!this._camera || !this._domElement) return null;
    const rect = this._domElement.getBoundingClientRect();
    this._pickNdc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this._raycaster.setFromCamera(this._pickNdc, this._camera);
    this.root.updateMatrixWorld(true); // proxies are matrixAutoUpdate=false
    const targets = [];
    for (const p of this.pieces) {
      // Include the road mesh even for GAPS (noRender) so an empty-space spacer
      // stays selectable — its full-span geometry raycasts fine invisible.
      if (p.mesh?.geometry?.attributes?.position) targets.push(p.mesh);
      for (const m of [p.railMesh, p.shellMesh]) {
        if (m && !m.userData.noRender && m.geometry?.attributes?.position) targets.push(m);
      }
    }
    const hits = this._raycaster.intersectObjects(targets, false);
    return hits.length ? hits[0].object.userData.piece ?? null : null;
  }

  /** Highlight a placed piece and put the transform gizmo ON it (null clears).
   *  Focuses the piece's chain so appends/gizmo follow it. Rotate the gizmo (E)
   *  to tilt the piece + downstream; translate (W) to move the whole chain. */
  selectPiece(p) {
    this.selectedPiece = p && this.pieces.includes(p) ? p : null;
    if (this.selectedPiece) {
      this.activeChainId = this.selectedPiece.chainId;
      this._syncCurrentConnector();
      this._showPieceGizmo(this.selectedPiece);
    }
    this._updateSelectionHighlight();
    this._notify();
  }

  deselectPiece() {
    if (!this.selectedPiece) return;
    this.selectedPiece = null;
    this._updateSelectionHighlight();
    // Hand the gizmo back to the next-piece / anchor.
    this._syncGizmoToOpenEnd();
    this._notify();
  }

  /** Attach the transform gizmo to a selected piece, at its entry connector. */
  _showPieceGizmo(p) {
    if (!this.placementGizmo) return;
    this._gizmoTarget = "piece";
    this.ghostDetached = false;
    this.placementPivot.position.setFromMatrixPosition(p.connectorIn);
    _A_M.extractRotation(p.connectorIn);
    this.placementPivot.quaternion.setFromRotationMatrix(_A_M);
    this.placementGizmo.attach(this.placementPivot);
    this.placementGizmo.enabled = true;
    this.placementGizmo.visible = true;
    this._applyGizmoAxes();
  }

  /** A translucent gold overlay of the exact selected piece, drawn on top
   *  (depthTest off) so it reads through other geometry. Shares the piece's
   *  geometry — never disposes it. */
  _updateSelectionHighlight() {
    const p = this.selectedPiece;
    if (!this._selMesh) {
      this._selMesh = new THREE.Mesh(
        new THREE.BufferGeometry(),
        new THREE.MeshBasicMaterial({
          color: 0xffd24a, transparent: true, opacity: 0.4,
          depthWrite: false, depthTest: false, side: THREE.DoubleSide,
        }),
      );
      this._selMesh.matrixAutoUpdate = false;
      this._selMesh.renderOrder = 999;
      this._selMesh.frustumCulled = false;
      this.scene.add(this._selMesh);
    }
    if (p && p.mesh?.geometry) {
      this._selMesh.geometry = p.mesh.geometry; // shared — do NOT dispose
      this._selMesh.matrix.copy(p.mesh.matrix);
      this._selMesh.visible = true;
    } else {
      this._selMesh.geometry = _EMPTY_GEO; // drop the reference
      this._selMesh.visible = false;
    }
  }

  /** Remove a placed piece; everything downstream in its chain reconnects. */
  deletePiece(p) {
    const idx = this.pieces.indexOf(p);
    if (idx < 0) return false;
    // Drop the highlight's reference to p's geometry BEFORE _removePiece disposes
    // it, or a frame could draw a disposed buffer.
    if (this.selectedPiece === p) {
      this.selectedPiece = null;
      this._updateSelectionHighlight();
    }
    this.activeChainId = p.chainId;
    this.pieces.splice(idx, 1);
    this._removePiece(p);
    this.rebuildAll();
    return true;
  }

  /** Swap a placed piece's TYPE in place (keeps its slot in the chain); the rest
   *  of the chain re-flows from the new piece's exit. */
  replacePiece(p, newId, pp = this._snapshotParams()) {
    if (this.pieces.indexOf(p) < 0 || !PIECE_BY_ID.has(newId)) return false;
    const def = PIECE_BY_ID.get(newId);
    p.id = newId;
    p.pp = { ...pp };
    p.mesh.userData.pieceId = newId;
    // A piece can gain/lose its render+collision presence across the swap (e.g.
    // to/from a gap) — rebuildAll only replaces geometry, not these flags.
    p.mesh.userData.noCollision = !!def.noMesh;
    p.mesh.userData.noRender = !!def.noMesh;
    p.mesh.material = def.noMesh ? this.gapMaterial : this.material;
    p.mesh.visible = def.noMesh ? true : !this.instancingEnabled;
    this.rebuildAll();
    this._updateSelectionHighlight();
    return true;
  }

  /**
   * Set a piece's entry TILT (a local-frame rotation quaternion). Banks this
   * piece and everything after it in the chain; the chain stays connected.
   * `q` is the tilt relative to the piece's un-tilted seam (`_baseIn`).
   */
  setPieceTilt(p, q) {
    if (this.pieces.indexOf(p) < 0) return false;
    p.tilt.copy(q);
    this.rebuildAll();
    if (this.selectedPiece === p) this._updateSelectionHighlight();
    return true;
  }

  /**
   * Turn a piece into a FLAT empty-space spacer — a level hole the same forward
   * length as the piece it replaces, so the rest of the chain doesn't move.
   *
   * The plain `gap` piece is a downward JUMP (its exit drops `gapDrop` and
   * pitches nose-down), which is why replacing a flat straight with it dropped
   * and tilted everything after it. Here we size the gap to the replaced piece's
   * span and force `gapDrop: 0`, so a flat run stays flat and downstream is
   * left where it was.
   */
  makeGap(p) {
    if (this.pieces.indexOf(p) < 0) return false;
    _A_V.setFromMatrixPosition(p.connectorIn);
    _A_V2.setFromMatrixPosition(p.connectorOut);
    const len = _A_V.distanceTo(_A_V2);
    const pp = { ...this._snapshotParams(), gapLength: Math.max(4, len), gapDrop: 0 };
    return this.replacePiece(p, "gap", pp);
  }

  /** Turn this piece's guardrails/kerbs on or off — PER PIECE, independent of
   *  the palette's global "new pieces get edges" default. */
  setPieceEdges(p, on) {
    if (this.pieces.indexOf(p) < 0) return false;
    p.edges = !!on;
    this.rebuildAll();
    if (this.selectedPiece === p) this._updateSelectionHighlight();
    return true;
  }

  // ── DETACH: free-placing one piece without dragging the chain ─────────────
  // The chain (each piece's entry = the previous piece's exit) is what makes
  // building fast and gap-free, but it means a piece has no position of its own
  // to edit. A DETACHED piece carries an absolute `pinnedIn` instead, which
  // rebuildAll uses in place of the running connector — so it can be moved and
  // rotated freely while everything else stays put.
  //
  // The save format already stores an absolute matrix per piece, so this needed
  // no format change; `detached`/`pinnedIn` just ride along with it.

  /** The next piece in the same chain, or null. */
  _nextInChain(p) {
    const ps = this._chainPieces(p.chainId);
    return ps[ps.indexOf(p) + 1] ?? null;
  }

  /**
   * Free this piece from the chain, pinned where it currently sits.
   *
   * ALSO pins the NEXT piece at its current place — that is what stops the rest
   * of the chain from following when you then move this one. Everything past
   * the next piece still chains from it, so it stays put too: one extra pin
   * holds the whole downstream still.
   */
  detachPiece(p) {
    if (this.pieces.indexOf(p) < 0 || p.detached) return false;
    p.detached = true;
    // `_baseIn` is the entry BEFORE this piece's tilt, so pinning it keeps any
    // tilt working as a rotation on top rather than baking it in.
    p.pinnedIn = (p._baseIn ?? p.connectorIn).clone();
    const next = this._nextInChain(p);
    if (next && !next.detached) {
      next.detached = true;
      next.pinnedIn = (next._baseIn ?? next.connectorIn).clone();
    }
    return true;
  }

  /** Re-join the chain: snap back onto the previous piece's exit. */
  attachPiece(p) {
    if (this.pieces.indexOf(p) < 0 || !p.detached) return false;
    p.detached = false;
    p.pinnedIn = null;
    this.rebuildAll();
    if (this.selectedPiece === p) this._updateSelectionHighlight();
    return true;
  }

  /** Reset a piece's tilt to none (downstream re-levels from here). */
  levelPiece(p) {
    if (this.pieces.indexOf(p) < 0) return false;
    p.tilt.identity();
    this.rebuildAll();
    if (this.selectedPiece === p) this._updateSelectionHighlight();
    return true;
  }

  /** Pitch/roll of a piece's tilt in degrees (for a readout). */
  pieceTiltDeg(p) {
    if (!p?.tilt) return { pitch: 0, roll: 0 };
    _A_E.setFromQuaternion(p.tilt, "YXZ");
    return { pitch: THREE.MathUtils.radToDeg(_A_E.x), roll: THREE.MathUtils.radToDeg(_A_E.z) };
  }

  /** Insert a new piece just BEFORE `p` in its chain; `p` and the rest shift
   *  downstream. Selects the new piece. */
  insertPieceBefore(p, newId, pp = this._snapshotParams()) {
    const idx = this.pieces.indexOf(p);
    if (idx < 0 || !PIECE_BY_ID.has(newId)) return false;
    // rebuildAll re-derives the transform from the chain walk, so p.connectorIn
    // here is only a placeholder for the initial build.
    const entry = this._makePieceEntry(newId, p.chainId, p.connectorIn, pp, guardrailParams.enabled);
    this.pieces.splice(idx, 0, entry);
    this.activeChainId = p.chainId;
    this.rebuildAll();
    this.selectPiece(entry);
    return true;
  }

  _removePiece(p) {
    this.root.remove(p.mesh);
    p.mesh.geometry.dispose();
    if (p.railMesh) {
      this.root.remove(p.railMesh);
      p.railMesh.geometry.dispose();
    }
    if (p.shellMesh) {
      this.root.remove(p.shellMesh);
      p.shellMesh.geometry.dispose();
    }
    if (p.decorMesh) {
      this.root.remove(p.decorMesh);
      p.decorMesh.geometry.dispose();
    }
  }

  undo() {
    // Remove the last piece of the active chain (fall back to global last).
    let last = this._lastPieceOfChain(this.activeChainId);
    if (!last) last = this.pieces[this.pieces.length - 1];
    if (!last) return false;
    this.activeChainId = last.chainId;
    const idx = this.pieces.indexOf(last);
    this.pieces.splice(idx, 1);
    this._removePiece(last);
    this._rebuildInstances();
    this._syncCurrentConnector();
    this._syncGizmoToOpenEnd();
    this.refreshGhost();
    this._notify();
    return true;
  }

  clear() {
    this.selectedPiece = null;
    this._updateSelectionHighlight();
    for (const p of this.pieces) this._removePiece(p);
    this.pieces = [];
    this._rebuildInstances();
    this.chains = [{ id: 0, anchor: initialConnector() }];
    this.chainSeq = 1;
    this.activeChainId = 0;
    this.freePlaceMode = true;
    this._gizmoTarget = "chain";
    this.ghostDetached = false;
    this._freePos.set(0, 0, 0);
    this.freeYaw = 0;
    this._freeQuat.identity();
    this.currentConnector = initialConnector();
    this._hidePlacementGizmo();
    this.refreshGhost();
    this._notify();
  }

  /**
   * Rebuild every chain from its anchor: pieces are re-chained sequentially
   * (each piece's entry = the previous piece's exit), so moving a chain anchor
   * or editing a piece flows correctly down the rest of that chain.
   */
  rebuildAll() {
    for (const chain of this.chains) {
      let conn = chain.anchor.clone();
      for (const p of this.pieces) {
        if (p.chainId !== chain.id) continue;
        // DETACHED pieces ignore the running connector and sit at their own
        // absolute `pinnedIn` — that is what lets one piece be moved or rotated
        // without dragging the chain with it. The running connector resumes from
        // this piece's exit, so anything after it still chains normally.
        if (p.detached && p.pinnedIn) conn = p.pinnedIn.clone();

        // PER-PIECE TILT: a rotation applied at this piece's entry seam, in the
        // connector's LOCAL frame (roll about travel, pitch about lateral). It
        // banks this piece AND flows into every piece after it — the chain stays
        // connected because it's a rotation at the joint, never a free move.
        // `_baseIn` is the seam BEFORE the tilt, kept so the edit gizmo can read
        // the current tilt back as base⁻¹·pose.
        p._baseIn = conn.clone();
        if (p.tilt && !_isIdentityQuat(p.tilt)) {
          conn.multiply(_A_M.makeRotationFromQuaternion(p.tilt));
        }
        p.connectorIn = conn.clone();
        const edges = p.edges ?? true;
        const built = buildPiece(p.id, conn, p.pp, roadParams, guardrailParams, edges);
        this._applyBuilt(p, built);
        p.connectorOut = built.connectorOut.clone();
        conn = built.connectorOut.clone();
      }
    }
    this._rebuildInstances();
    this._syncCurrentConnector();
    // A rebuild moves the open end; if the gizmo is riding the (attached)
    // ghost, keep it glued to the new end.
    if (this._gizmoTarget === "ghost" && !this.ghostDetached && this.placementGizmo?.visible) {
      this._syncGizmoToOpenEnd();
    }
    // The selected piece may have moved (an anchor drag or an upstream edit flows
    // down the chain), so keep its highlight glued to it.
    if (this.selectedPiece) this._updateSelectionHighlight();
    this.refreshGhost();
    this._notify();
  }

  /** Update a placed piece's meshes from a freshly built result. */
  _applyBuilt(p, built) {
    p.mesh.geometry.dispose();
    p.mesh.geometry = built.geometry;
    p.mesh.matrix.copy(built.world);

    if (built.railGeometry && this.railMaterial) {
      if (p.railMesh) {
        p.railMesh.geometry.dispose();
        p.railMesh.geometry = built.railGeometry;
        p.railMesh.matrix.copy(built.world);
      } else {
        p.railMesh = this._makeMesh(built.railGeometry, this.railMaterial, built.world);
      }
    } else if (p.railMesh) {
      this.root.remove(p.railMesh);
      p.railMesh.geometry.dispose();
      p.railMesh = null;
    }

    if (built.shellGeometry && this.shellMaterial) {
      if (p.shellMesh) {
        p.shellMesh.geometry.dispose();
        p.shellMesh.geometry = built.shellGeometry;
        p.shellMesh.matrix.copy(built.world);
      } else {
        p.shellMesh = this._makeMesh(built.shellGeometry, this.shellMaterial, built.world);
      }
    } else if (p.shellMesh) {
      this.root.remove(p.shellMesh);
      p.shellMesh.geometry.dispose();
      p.shellMesh = null;
    }

    if (built.decorGeometry && this.decorMaterial) {
      if (p.decorMesh) {
        p.decorMesh.geometry.dispose();
        p.decorMesh.geometry = built.decorGeometry;
        p.decorMesh.matrix.copy(built.world);
      } else {
        p.decorMesh = this._makeMesh(built.decorGeometry, this.decorMaterial, built.world);
        p.decorMesh.castShadow = false;
      }
    } else if (p.decorMesh) {
      this.root.remove(p.decorMesh);
      p.decorMesh.geometry.dispose();
      p.decorMesh = null;
    }
  }

  /**
   * Replace all chains from saved pieces (supports disconnected chains via
   * stored chainId + connectors).
   * @param {{id:string, chainId?:number, pp:object, edges?:boolean, connectorIn:number[]}[]} entries
   */
  importTrackPieces(entries) {
    this.clear();
    if (!Array.isArray(entries)) return;
    for (const e of entries) {
      if (!PIECE_BY_ID.has(e.id) || !Array.isArray(e.connectorIn) || e.connectorIn.length !== 16) continue;
      const connectorIn = new THREE.Matrix4().fromArray(e.connectorIn);
      const edges = e.edges ?? true;
      const pp = { ...e.pp };
      const built = buildPiece(e.id, connectorIn, pp, roadParams, guardrailParams, edges);
      const mesh = this._makeMesh(built.geometry, this.material, built.world);
      mesh.userData.pieceId = e.id;
      if (built.def.noMesh) {
        mesh.userData.noCollision = true;
        mesh.userData.noRender = true;
        mesh.material = this.gapMaterial;
        mesh.visible = true;
      }
      const railMesh =
        built.railGeometry && this.railMaterial
          ? this._makeMesh(built.railGeometry, this.railMaterial, built.world)
          : null;
      const shellMesh =
        built.shellGeometry && this.shellMaterial
          ? this._makeMesh(built.shellGeometry, this.shellMaterial, built.world)
          : null;
      const decorMesh =
        built.decorGeometry && this.decorMaterial
          ? this._makeMesh(built.decorGeometry, this.decorMaterial, built.world)
          : null;
      if (decorMesh) decorMesh.castShadow = false;

      const piece = {
        id: e.id,
        chainId: e.chainId ?? 0,
        pp,
        edges,
        mesh,
        railMesh,
        shellMesh,
        decorMesh,
        connectorIn,
        connectorOut: built.connectorOut.clone(),
        tilt: new THREE.Quaternion(),
        _baseIn: connectorIn.clone(),
        detached: !!e.detached,
        pinnedIn: Array.isArray(e.pinnedIn) && e.pinnedIn.length === 16
          ? new THREE.Matrix4().fromArray(e.pinnedIn)
          : null,
      };
      for (const m of [mesh, railMesh, shellMesh, decorMesh]) {
        if (m) m.userData.piece = piece;
      }
      this.pieces.push(piece);
    }
    this._rebuildInstances();
    // Reconstruct chains from the loaded pieces (anchor = first piece's entry).
    const seen = new Map();
    for (const p of this.pieces) {
      if (!seen.has(p.chainId)) seen.set(p.chainId, { id: p.chainId, anchor: p.connectorIn.clone() });
    }
    // RECOVER per-piece tilt from the stored connectors, so a later edit's
    // rebuildAll reproduces the loaded (possibly banked) track instead of
    // re-flattening it. tilt = baseIn_rotation⁻¹ · connectorIn_rotation, where
    // baseIn is the anchor (first piece) or the previous piece's exit.
    for (const chain of seen.values()) {
      let baseIn = chain.anchor;
      for (const p of this.pieces) {
        if (p.chainId !== chain.id) continue;
        // A DETACHED piece's entry comes from its own saved `pinnedIn`, so its
        // difference from the chain is deliberate, not a tilt to recover. Take
        // that as the base instead or the offset would be folded into `tilt`.
        if (p.detached && p.pinnedIn) baseIn = p.pinnedIn;
        _A_M.extractRotation(baseIn);
        _A_Q.setFromRotationMatrix(_A_M);           // base rotation
        _A_M.extractRotation(p.connectorIn);
        p.tilt.setFromRotationMatrix(_A_M).premultiply(_A_Q.invert()); // base⁻¹ · in
        p._baseIn = baseIn.clone();
        baseIn = p.connectorOut;
      }
    }
    this.chains = seen.size ? [...seen.values()] : [{ id: 0, anchor: initialConnector() }];
    this.chainSeq = Math.max(-1, ...this.chains.map((c) => c.id)) + 1;
    this.activeChainId = this.chains[this.chains.length - 1].id;
    this.freePlaceMode = true;
    const a = this.chains[this.chains.length - 1].anchor;
    this._freePos.setFromMatrixPosition(a);
    _A_M.extractRotation(a);
    this._setFreeQuat(_A_Q.setFromRotationMatrix(_A_M)); // carry any tilt from the loaded track
    this._syncCurrentConnector();
    this._hidePlacementGizmo();
    this.refreshGhost();
    this._notify();
  }

  /**
   * Load a short sky-stunt showcase — open chain (not a closed lap), floating
   * above the terrain. Uses only well-behaved kit pieces: flat corners, a climb,
   * one jump with a SECOND chain for the landing (jump→gap in one chain inherits
   * the ramp pitch and climbs forever — the gap preview / jump-debug track both
   * use a fresh level chain for the far side), a tunnel, a narrow, then finish.
   * Avoids loops / tubes / wall-rides / twists — those need hand-tuned placement.
   *
   * @param {{ startPos?: THREE.Vector3, yaw?: number, refSpeed?: number }} [opts]
   *        `startPos` seats the anchor in the sky (terrain + buildHeight from the
   *        game). Without it the track starts at the origin like the old demo.
   *        `refSpeed` is the approach speed the jump landing is sized for —
   *        keep it BELOW top speed; after a climb you rarely arrive at 40+.
   */
  loadDemo(opts = {}) {
    this.clear();
    // 28 m/s ≈ 100 km/h: reachable after the climb. A long platform then covers
    // overshoot up to ~40 m/s so a hot approach still lands on deck.
    const { startPos = null, yaw = 0, refSpeed = 28 } = opts;
    if (startPos) {
      this.freePlaceMode = true;
      this._gizmoTarget = "chain";
      this.ghostDetached = false;
      this.freeYaw = this.snapYaw(yaw);
      this._freeQuat.setFromAxisAngle(_YUP, this.freeYaw);
      this._freePos.copy(startPos);
      this.snapPos(this._freePos);
      const anchor = this._anchorFromFree();
      this.chains = [{ id: 0, anchor }];
      this.chainSeq = 1;
      this.activeChainId = 0;
      this.currentConnector = anchor.clone();
    }

    const saved = { ...pieceParams };
    const put = (id, overrides = {}) => {
      Object.assign(pieceParams, overrides);
      this.activePieceId = id;
      this.place();
    };

    // Wide sweeping corners — readable at speed, easy to hold.
    const R = 28;
    const Rtight = 20;

    // ── Launch plateau ──────────────────────────────────────────────────────
    put("start", { gameLineLength: 18 });
    put("straight", { straightLength: 28 });
    put("curve", { curveRadius: R, curveAngle: 90, curveDir: 1 });
    put("straight", { straightLength: 22 });

    // ── Climb into the sky a bit more ───────────────────────────────────────
    put("slope", { slopeLength: 30, slopeRise: 8 });
    put("straight", { straightLength: 18 });
    put("checkpoint", { gameLineLength: 16 });
    put("curve", { curveRadius: R, curveAngle: 90, curveDir: 1 });

    // ── Signature jump → empty air → fresh landing chain ────────────────────
    // Same pattern as the gap preview / jump-debug track: the takeoff ends this
    // chain; the far side is a NEW level chain seated on the ballistic landing.
    put("straight", { straightLength: 30 }); // longer run-up so you can build speed
    put("jump", { jumpLength: 18, jumpAngle: 12 });
    const landNear = _ballisticLanding(this.currentConnector, refSpeed, 9.81, 0);
    const landFar = _ballisticLanding(this.currentConnector, Math.max(refSpeed + 12, 40), 9.81, 0);
    if (landNear) {
      const snapWas = this.snapEnabled;
      this.snapEnabled = false; // keep the ballistic point exact (grid would nudge it)
      this.beginNewChain(landNear.pos, landNear.yaw);
      this.snapEnabled = snapWas;
      this.deselectPlacement?.();
      // Platform long enough that a faster jump still lands on it, not past it.
      const span = landFar
        ? Math.hypot(landFar.pos.x - landNear.pos.x, landFar.pos.z - landNear.pos.z)
        : 36;
      put("platform", { platformLength: Math.max(36, span + 8), platformWidth: 40 });
    } else {
      put("platform", { platformLength: 40, platformWidth: 40 });
    }
    put("straight", { straightLength: 22 });

    // ── Flow section ────────────────────────────────────────────────────────
    put("scurve", { curveRadius: 18, curveAngle: 40, curveDir: 1 });
    put("tunnel", { straightLength: 28 });
    put("curve", { curveRadius: R, curveAngle: 90, curveDir: -1 });

    // ── Precision + exit ────────────────────────────────────────────────────
    put("straight", { straightLength: 16 });
    put("narrow", { straightLength: 22, narrowWidth: 8 });
    put("curve", { curveRadius: Rtight, curveAngle: 45, curveDir: 1 });
    put("curve", { curveRadius: Rtight, curveAngle: 45, curveDir: 1 });
    put("crest", { slopeLength: 24, slopeRise: 4 });
    put("straight", { straightLength: 24 });
    put("finish", { gameLineLength: 18 });

    Object.assign(pieceParams, saved);
    this.activePieceId = PIECE_CATALOG[0].id;
    this.deselectPlacement?.();
    this.refreshGhost();
    this._notify();
  }

  /**
   * Load a large CLOSED sky circuit — floats at `startPos`, returns onto its own
   * start line. Only uses pieces that appear as tiles in the left palette
   * (Straight / Turns / Tubes / Slopes / Game) — no kit orphans like twist.
   *
   * Closure rules:
   *  - **180° rotational symmetry.** Two identical halves, each turning exactly
   *    180° (two 90° corners; S-curve nets 0°).
   *  - **Dead flat ends.** Hill crest rises mid-piece but returns to level.
   *
   * @param {{ startPos?: THREE.Vector3, yaw?: number }} [opts]
   */
  loadBigCircuit(opts = {}) {
    this.clear();
    const { startPos = null, yaw = 0 } = opts;
    if (startPos) {
      this.freePlaceMode = true;
      this._gizmoTarget = "chain";
      this.ghostDetached = false;
      this.freeYaw = this.snapYaw(yaw);
      this._freeQuat.setFromAxisAngle(_YUP, this.freeYaw);
      this._freePos.copy(startPos);
      this.snapPos(this._freePos);
      const anchor = this._anchorFromFree();
      this.chains = [{ id: 0, anchor }];
      this.chainSeq = 1;
      this.activeChainId = 0;
      this.currentConnector = anchor.clone();
    }

    const saved = { ...pieceParams };
    const put = (id, overrides = {}) => {
      Object.assign(pieceParams, overrides);
      this.activePieceId = id;
      this.place();
    };

    // Radii / lengths match CATEGORY_PRESETS tiles (Tube Turn, Arch Turn, etc.).
    const R = 26;
    const tubeR = 8;
    const chanR = 4;

    // One half-lap: turns exactly 180° (two 90° corners; S-curve nets 0°).
    const half = (gameId) => {
      put(gameId, { gameLineLength: 22 });
      put("straight", { straightLength: 32 }); // Straight → Long

      // Tubes → Tube Long → Tube Turn
      put("tube", { straightLength: 44, tubeRadius: tubeR, tubeWall: 0.6 });
      put("tube_curve", {
        curveRadius: R, curveAngle: 90, curveDir: 1,
        tubeRadius: tubeR, tubeWall: 0.6,
      }); // 90°

      put("channel", { straightLength: 26, channelRadius: chanR }); // Tubes → Half-pipe
      put("scurve", { curveRadius: 20, curveAngle: 38, curveDir: 1 }); // Turns → S Right
      put("checkpoint", { gameLineLength: 16 });

      // Tubes → Arch Tunnel, another Tube, then Arch Turn
      put("tunnel", { straightLength: 26, tunnelHeight: 7 });
      put("tube", { straightLength: 26, tubeRadius: tubeR, tubeWall: 0.6 });
      put("straight", { straightLength: 14 }); // Straight → Short
      put("tunnel_curve", {
        curveRadius: R, curveAngle: 90, curveDir: 1, tunnelHeight: 7,
      }); // 90°

      put("narrow", { straightLength: 24, narrowWidth: 8 }); // Straight → Narrow
      put("crest", { slopeLength: 32, slopeRise: 8 }); // Slopes → Hill
    };

    half("start");
    half("finish");

    Object.assign(pieceParams, saved);
    this.activePieceId = PIECE_CATALOG[0].id;
    this.deselectPlacement?.();
    this.refreshGhost();
    this._notify();
  }

  /**
   * `detached`/`pinnedIn` must be saved explicitly. `connectorIn` alone is not
   * enough: on load the tilt-recovery pass can express a rotation difference
   * from the chain, but NOT a translation — so a free-placed piece would snap
   * back onto the chain and lose its position.
   * @returns {{id:string, chainId:number, pp:object, edges:boolean,
   *            connectorIn:number[], detached?:boolean, pinnedIn?:number[]}[]}
   */
  exportTrackPieces() {
    return this.pieces.map((p) => {
      const e = {
        id: p.id,
        chainId: p.chainId ?? 0,
        pp: { ...p.pp },
        edges: p.edges ?? true,
        connectorIn: p.connectorIn.toArray(),
      };
      if (p.detached && p.pinnedIn) {
        e.detached = true;
        e.pinnedIn = p.pinnedIn.toArray();
      }
      return e;
    });
  }

  dispose() {
    this.clear();
    this._hidePlacementGizmo();
    this.placementGizmo?.dispose();
    this.scene.remove(this.placementGizmo?.getHelper());
    this.scene.remove(this.placementPivot);
    this.scene.remove(this.ghost);
    this.ghost.geometry.dispose();
    this.ghostMat.dispose();
    this.scene.remove(this.root);
  }
}

/**
 * TrackMania-style palette categories + SVG silhouette previews (no 3D thumbnails yet).
 */
const PIECE_TO_CATEGORY = {
  straight: "straight",
  platform: "straight",
  narrow: "straight",
  tunnel: "tubes",
  tunnel_curve: "tubes",
  tube: "tubes",
  tube_curve: "tubes",
  channel: "tubes",
  channel_curve: "tubes",
  curve: "turns",
  scurve: "turns",
  jump: "ramps",
  dive: "ramps",
  gap: "ramps",
  landing: "ramps",
  brow: "ramps",
  slope: "slopes",
  crest: "slopes",
  spiral: "slopes",
  banked: "banked",
  banktilt: "banked",
  wallride: "banked",
  bankin: "banked",
  bankout: "banked",
  loop: "loop",
  loop_half: "loop",
  loop_spiral: "loop",
  quarterpipe: "loop",
  quarterpipe_down: "loop",
  start: "game",
  checkpoint: "game",
  finish: "game",
};

export const PALETTE_CATEGORIES = [
  { id: "straight", label: "Straight" },
  { id: "turns", label: "Turns" },
  { id: "game", label: "Game" },
  { id: "ramps", label: "Ramps" },
  { id: "slopes", label: "Slopes" },
  { id: "banked", label: "Banked" },
  { id: "tubes", label: "Tubes" },
  { id: "obstacles", label: "Obstacles" },
  { id: "moving", label: "Moving" },
  { id: "portals", label: "Portals" },
  { id: "loop", label: "Loop" },
];

/** Shared road stroke for preview SVGs. */
const _RS = 'stroke="#e8eaed" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"';
const _RB = 'fill="#2a2e36" stroke="#c0392b" stroke-width="1.8"';
function categoryIconSvg(id) {
  const icons = {
    straight: `<svg viewBox="0 0 48 48"><rect x="6" y="20" width="36" height="10" rx="1" ${_RB}/><line x1="8" y1="25" x2="40" y2="25" ${_RS}/></svg>`,
    turns: `<svg viewBox="0 0 48 48"><path d="M8 34 L8 18 Q8 8 22 8 L34 8" ${_RS}/><rect x="6" y="16" width="28" height="8" rx="1" ${_RB} opacity="0.85"/></svg>`,
    game: `<svg viewBox="0 0 48 48"><rect x="10" y="22" width="28" height="8" rx="1" ${_RB}/><line x1="16" y1="12" x2="16" y2="22" stroke="#fff" stroke-width="2"/><polygon points="16,8 12,14 20,14" fill="#fff"/><line x1="32" y1="12" x2="32" y2="22" stroke="#fff" stroke-width="2"/><polygon points="32,8 28,14 36,14" fill="#fff"/></svg>`,
    ramps: `<svg viewBox="0 0 48 48"><polygon points="8,36 40,36 40,14" fill="#2a2e36" stroke="#c0392b" stroke-width="1.8"/><line x1="10" y1="34" x2="38" y2="16" ${_RS}/></svg>`,
    slopes: `<svg viewBox="0 0 48 48"><polygon points="6,36 42,36 42,12" fill="#2a2e36" stroke="#c0392b" stroke-width="1.8"/><line x1="8" y1="34" x2="40" y2="14" ${_RS}/></svg>`,
    banked: `<svg viewBox="0 0 48 48"><path d="M6 30 L42 18" ${_RS}/><rect x="8" y="16" width="32" height="8" rx="1" transform="rotate(-12 24 20)" ${_RB}/></svg>`,
    tubes: `<svg viewBox="0 0 48 48"><circle cx="24" cy="24" r="16" fill="none" stroke="#6a7580" stroke-width="3"/><rect x="12" y="28" width="24" height="6" rx="1" ${_RB}/></svg>`,
    obstacles: `<svg viewBox="0 0 48 48"><rect x="12" y="14" width="14" height="22" rx="1" fill="#6a7580" stroke="#999" stroke-width="1.5"/><ellipse cx="34" cy="28" rx="8" ry="10" fill="none" stroke="#dce622" stroke-width="2"/></svg>`,
    moving: `<svg viewBox="0 0 48 48"><rect x="8" y="22" width="32" height="6" rx="1" fill="#e8c040" stroke="#999" stroke-width="1.2"/><path d="M24 8 L24 18 M24 32 L24 42" stroke="#dce622" stroke-width="2" stroke-linecap="round"/><path d="M18 8 L24 14 L30 8" fill="none" stroke="#dce622" stroke-width="2" stroke-linecap="round"/></svg>`,
    loop: `<svg viewBox="0 0 48 48"><circle cx="24" cy="26" r="14" fill="none" stroke="#c0392b" stroke-width="1.8"/><path d="M10 38 L10 26 Q10 12 24 12 Q38 12 38 26 L38 38" ${_RS}/></svg>`,
  };
  return icons[id] ?? icons.straight;
}

function piecePreviewSvg(pieceId) {
  const p = {
    straight: `<svg viewBox="0 0 80 80"><rect x="8" y="32" width="64" height="16" rx="2" ${_RB}/><line x1="12" y1="40" x2="68" y2="40" ${_RS}/></svg>`,
    tunnel: `<svg viewBox="0 0 80 80"><rect x="8" y="32" width="64" height="16" rx="2" ${_RB}/><path d="M8 32 Q40 8 72 32" fill="none" stroke="#6a7580" stroke-width="3"/></svg>`,
    curve: `<svg viewBox="0 0 80 80"><path d="M12 68 L12 28 Q12 12 36 12 L68 12" ${_RS}/><path d="M14 66 L14 30 Q14 16 34 16 L66 16" fill="#2a2e36" stroke="#c0392b" stroke-width="1.5"/></svg>`,
    scurve: `<svg viewBox="0 0 80 80"><path d="M12 68 L12 48 Q12 28 32 28 L48 28 Q68 28 68 12" ${_RS}/></svg>`,
    slope: `<svg viewBox="0 0 80 80"><polygon points="8,64 72,64 72,20" fill="#2a2e36" stroke="#c0392b" stroke-width="1.8"/><line x1="12" y1="60" x2="68" y2="24" ${_RS}/></svg>`,
    crest: `<svg viewBox="0 0 80 80"><path d="M8 56 L24 24 L40 56 L56 24 L72 56" ${_RS}/><line x1="8" y1="56" x2="72" y2="56" stroke="#c0392b" stroke-width="1.5"/></svg>`,
    spiral: `<svg viewBox="0 0 80 80"><path d="M14 66 L14 40 Q14 20 36 16 Q58 12 62 36" ${_RS}/><line x1="14" y1="66" x2="14" y2="50" stroke="#dce622" stroke-width="1.5" opacity="0.7"/></svg>`,
    banked: `<svg viewBox="0 0 80 80"><path d="M8 52 L72 28" ${_RS}/><rect x="10" y="30" width="60" height="12" rx="2" transform="rotate(-14 40 36)" ${_RB}/></svg>`,
    bankin: `<svg viewBox="0 0 80 80"><rect x="10" y="38" width="28" height="10" rx="1" ${_RB}/><rect x="38" y="32" width="32" height="10" rx="1" transform="rotate(-16 54 37)" ${_RB}/></svg>`,
    bankout: `<svg viewBox="0 0 80 80"><rect x="10" y="32" width="32" height="10" rx="1" transform="rotate(-16 26 37)" ${_RB}/><rect x="42" y="38" width="28" height="10" rx="1" ${_RB}/></svg>`,
    jump: `<svg viewBox="0 0 80 80"><polygon points="8,60 72,60 72,28" fill="#2a2e36" stroke="#c0392b" stroke-width="1.8"/><line x1="10" y1="58" x2="70" y2="30" ${_RS}/></svg>`,
    dive: `<svg viewBox="0 0 80 80"><polygon points="8,20 72,52 8,52" fill="#2a2e36" stroke="#c0392b" stroke-width="1.8"/><line x1="10" y1="22" x2="70" y2="50" ${_RS}/></svg>`,
    gap: `<svg viewBox="0 0 80 80"><rect x="8" y="48" width="24" height="8" rx="1" ${_RB}/><rect x="48" y="56" width="24" height="8" rx="1" ${_RB}/><path d="M32 52 L48 58" stroke="#dce622" stroke-width="1.5" stroke-dasharray="4 3"/></svg>`,
    landing: `<svg viewBox="0 0 80 80"><polygon points="8,36 72,36 72,60" fill="#2a2e36" stroke="#c0392b" stroke-width="1.8"/><line x1="10" y1="38" x2="70" y2="58" ${_RS}/></svg>`,
    brow: `<svg viewBox="0 0 80 80"><polygon points="8,52 72,20 72,52" fill="#2a2e36" stroke="#c0392b" stroke-width="1.8"/><line x1="10" y1="50" x2="70" y2="22" ${_RS}/></svg>`,
    twist: `<svg viewBox="0 0 80 80"><path d="M12 40 Q40 12 68 40 Q40 68 12 40" ${_RS}/><rect x="30" y="34" width="20" height="8" rx="1" transform="rotate(30 40 38)" ${_RB}/></svg>`,
    loop: `<svg viewBox="0 0 80 80"><path d="M40 68 Q16 68 16 40 Q16 12 40 12 Q64 12 64 40 Q64 68 40 68" ${_RS}/></svg>`,
    loop_half: `<svg viewBox="0 0 80 80"><path d="M40 68 Q16 68 16 40 Q16 12 40 12" ${_RS}/></svg>`,
    loop_spiral: `<svg viewBox="0 0 80 80"><line x1="12" y1="62" x2="28" y2="62" stroke="#c0392b" stroke-width="1.5"/><path d="M28 62 Q22 48 26 34 Q34 18 48 14 Q58 24 54 38 Q48 52 36 58" ${_RS}/></svg>`,
    start: `<svg viewBox="0 0 80 80"><rect x="10" y="34" width="60" height="12" rx="2" ${_RB}/><rect x="14" y="20" width="8" height="24" fill="#fff"/><rect x="14" y="20" width="16" height="8" fill="#fff"/><rect x="12" y="38" width="8" height="4" fill="#111"/><rect x="20" y="38" width="8" height="4" fill="#fff"/></svg>`,
    checkpoint: `<svg viewBox="0 0 80 80"><rect x="10" y="34" width="60" height="12" rx="2" ${_RB}/><line x1="28" y1="18" x2="28" y2="34" stroke="#fff" stroke-width="3"/><polygon points="28,12 22,20 34,20" fill="#fff"/><line x1="52" y1="18" x2="52" y2="34" stroke="#fff" stroke-width="3"/><polygon points="52,12 46,20 58,20" fill="#fff"/><polygon points="40,42 34,48 46,48" fill="#ffcc00"/></svg>`,
    finish: `<svg viewBox="0 0 80 80"><rect x="10" y="34" width="60" height="12" rx="2" ${_RB}/><rect x="36" y="16" width="8" height="28" fill="#fff"/><polygon points="36,12 32,20 40,20" fill="#fff"/><rect x="12" y="38" width="8" height="4" fill="#111"/><rect x="20" y="38" width="8" height="4" fill="#fff"/><rect x="52" y="38" width="8" height="4" fill="#111"/><rect x="60" y="38" width="8" height="4" fill="#fff"/></svg>`,
    box: `<svg viewBox="0 0 80 80"><rect x="22" y="28" width="36" height="28" rx="2" fill="#6a7580" stroke="#999" stroke-width="1.5"/></svg>`,
    ramp: `<svg viewBox="0 0 80 80"><polygon points="12,60 68,60 68,24" fill="#e8912d" stroke="#c0392b" stroke-width="1.5"/></svg>`,
    tube: `<svg viewBox="0 0 80 80"><ellipse cx="40" cy="40" rx="28" ry="14" fill="none" stroke="#3a7bd5" stroke-width="3"/></svg>`,
    ring: `<svg viewBox="0 0 80 80"><ellipse cx="40" cy="40" rx="26" ry="26" fill="none" stroke="#dce622" stroke-width="4"/></svg>`,
    airtunnel: `<svg viewBox="0 0 80 80"><rect x="10" y="32" width="60" height="16" rx="2" ${_RB}/><path d="M10 32 Q40 10 70 32" fill="none" stroke="#6a7580" stroke-width="3"/></svg>`,
  };
  return p[pieceId] ?? p.straight;
}

/**
 * Curated "kit" presets — premade pieces (TrackMania-style) layered over the
 * parametric generator. Each preset is a named snapshot of pieceParams on a base
 * piece (the generator stays the authoring tool). Identical presets place the
 * same local geometry, so they're instancing-friendly later. Categories listed
 * here render presets instead of raw parametric pieces; categories absent here
 * fall back to the raw PIECE_CATALOG (converted step by step).
 * @type {Record<string, {id:string,label:string,base:string,params:object,preview:string}[]>}
 */
export const CATEGORY_PRESETS = {
  // The Apex-Rush Banks palette: Up/Down transitions curl the deck up from the
  // plane, Straight/Turn tiles HOLD the lean. Level sockets keep every piece
  // upright wherever it's dropped.
  banked: [
    {
      id: "bank_up_right",
      label: "Up Right",
      base: "bankin",
      params: { straightLength: 18, bankAngle: 22, curveDir: 1 },
      preview: `<svg viewBox="0 0 80 80"><rect x="10" y="40" width="26" height="10" rx="1" ${_RB}/><rect x="38" y="32" width="32" height="10" rx="1" transform="rotate(-16 54 37)" ${_RB}/></svg>`,
    },
    {
      id: "bank_up_left",
      label: "Up Left",
      base: "bankin",
      params: { straightLength: 18, bankAngle: 22, curveDir: -1 },
      preview: `<svg viewBox="0 0 80 80"><rect x="10" y="40" width="26" height="10" rx="1" ${_RB}/><rect x="38" y="32" width="32" height="10" rx="1" transform="rotate(16 54 37)" ${_RB}/></svg>`,
    },
    {
      id: "bank_straight_right",
      label: "Straight Right",
      base: "banktilt",
      params: { straightLength: 22, bankAngle: 22, curveDir: 1 },
      preview: `<svg viewBox="0 0 80 80"><rect x="10" y="34" width="60" height="12" rx="2" transform="rotate(-16 40 40)" ${_RB}/></svg>`,
    },
    {
      id: "bank_straight_left",
      label: "Straight Left",
      base: "banktilt",
      params: { straightLength: 22, bankAngle: 22, curveDir: -1 },
      preview: `<svg viewBox="0 0 80 80"><rect x="10" y="34" width="60" height="12" rx="2" transform="rotate(16 40 40)" ${_RB}/></svg>`,
    },
    {
      id: "bank_road_tilted",
      label: "Road Tilted",
      base: "banktilt",
      params: { straightLength: 22, bankAngle: 35, curveDir: 1 },
      preview: `<svg viewBox="0 0 80 80"><rect x="10" y="34" width="60" height="12" rx="2" transform="rotate(-26 40 40)" ${_RB}/></svg>`,
    },
    {
      id: "bank_down_right",
      label: "Down Right",
      base: "bankout",
      params: { straightLength: 18, bankAngle: 22, curveDir: 1 },
      preview: `<svg viewBox="0 0 80 80"><rect x="10" y="32" width="32" height="10" rx="1" transform="rotate(-16 26 37)" ${_RB}/><rect x="44" y="40" width="26" height="10" rx="1" ${_RB}/></svg>`,
    },
    {
      id: "bank_down_left",
      label: "Down Left",
      base: "bankout",
      params: { straightLength: 18, bankAngle: 22, curveDir: -1 },
      preview: `<svg viewBox="0 0 80 80"><rect x="10" y="32" width="32" height="10" rx="1" transform="rotate(16 26 37)" ${_RB}/><rect x="44" y="40" width="26" height="10" rx="1" ${_RB}/></svg>`,
    },
    {
      id: "bank_short_turn",
      label: "Short Turn",
      base: "banked",
      params: { curveRadius: 20, curveAngle: 60, bankAngle: 22, curveDir: 1 },
      preview: `<svg viewBox="0 0 80 80"><path d="M22 68 L22 40 Q22 22 44 22 L66 22" ${_RS}/><rect x="30" y="30" width="34" height="11" rx="2" transform="rotate(-16 47 36)" ${_RB}/></svg>`,
    },
    {
      id: "bank_long_turn",
      label: "Long Turn",
      base: "banked",
      params: { curveRadius: 30, curveAngle: 90, bankAngle: 22, curveDir: 1 },
      preview: `<svg viewBox="0 0 80 80"><path d="M18 70 L18 40 Q18 18 40 18 L70 18" ${_RS}/><rect x="30" y="30" width="34" height="11" rx="2" transform="rotate(-16 47 36)" ${_RB}/></svg>`,
    },
    {
      id: "wall_ride_right",
      label: "Wall Ride R",
      base: "wallride",
      params: { wallRideLength: 70, wallAngle: 70, wallRamp: 0.38, curveDir: 1 },
      preview: `<svg viewBox="0 0 80 80"><path d="M14 66 Q26 66 30 40 Q34 14 46 14" fill="none" stroke="#8e6fc0" stroke-width="8" stroke-linecap="round"/></svg>`,
    },
    {
      id: "wall_ride_left",
      label: "Wall Ride L",
      base: "wallride",
      params: { wallRideLength: 70, wallAngle: 70, wallRamp: 0.38, curveDir: -1 },
      preview: `<svg viewBox="0 0 80 80"><path d="M66 66 Q54 66 50 40 Q46 14 34 14" fill="none" stroke="#8e6fc0" stroke-width="8" stroke-linecap="round"/></svg>`,
    },
  ],
  tubes: [
    {
      id: "tube_str",
      label: "Tube",
      base: "tube",
      params: { straightLength: 26, tubeRadius: 8, tubeWall: 0.6 },
      preview: `<svg viewBox="0 0 80 80"><circle cx="40" cy="40" r="26" fill="none" stroke="#6a7580" stroke-width="5"/><circle cx="40" cy="40" r="20" fill="none" stroke="#3f4650" stroke-width="2"/><rect x="30" y="56" width="20" height="5" rx="2" fill="#2a2e36"/></svg>`,
    },
    {
      id: "tube_long",
      label: "Tube Long",
      base: "tube",
      params: { straightLength: 44, tubeRadius: 8, tubeWall: 0.6 },
      preview: `<svg viewBox="0 0 80 80"><ellipse cx="26" cy="40" rx="12" ry="22" fill="none" stroke="#6a7580" stroke-width="4"/><path d="M26 18 L66 22 M26 62 L66 58" stroke="#6a7580" stroke-width="3"/><ellipse cx="66" cy="40" rx="7" ry="18" fill="none" stroke="#6a7580" stroke-width="3"/></svg>`,
    },
    {
      id: "tube_turn",
      label: "Tube Turn",
      base: "tube_curve",
      params: { curveRadius: 26, curveAngle: 90, curveDir: 1, tubeRadius: 8, tubeWall: 0.6 },
      preview: `<svg viewBox="0 0 80 80"><path d="M18 70 L18 40 Q18 18 40 18 L70 18" ${_RS}/><circle cx="52" cy="52" r="16" fill="none" stroke="#6a7580" stroke-width="4"/><circle cx="52" cy="52" r="11" fill="none" stroke="#3f4650" stroke-width="2"/></svg>`,
    },
    {
      id: "tunnel_str",
      label: "Arch Tunnel",
      base: "tunnel",
      params: { straightLength: 26, tunnelHeight: 7 },
      preview: `<svg viewBox="0 0 80 80"><rect x="8" y="34" width="64" height="14" rx="2" ${_RB}/><path d="M8 34 Q40 8 72 34" fill="none" stroke="#6a7580" stroke-width="3"/></svg>`,
    },
    {
      id: "tunnel_turn",
      label: "Arch Turn",
      base: "tunnel_curve",
      params: { curveRadius: 26, curveAngle: 90, curveDir: 1, tunnelHeight: 7 },
      preview: `<svg viewBox="0 0 80 80"><path d="M18 70 L18 40 Q18 18 40 18 L70 18" ${_RS}/><path d="M30 52 Q30 30 52 30" fill="none" stroke="#6a7580" stroke-width="6" stroke-linecap="round"/></svg>`,
    },
    {
      id: "channel_str",
      label: "Half-pipe",
      base: "channel",
      params: { straightLength: 26, channelRadius: 4 },
      preview: `<svg viewBox="0 0 80 80"><path d="M12 28 Q16 46 40 46 Q64 46 68 28" fill="none" stroke="#3a7bd5" stroke-width="4"/><rect x="26" y="42" width="28" height="7" rx="1" ${_RB}/></svg>`,
    },
    {
      id: "channel_turn",
      label: "Half-pipe Turn",
      base: "channel_curve",
      params: { curveRadius: 26, curveAngle: 90, curveDir: 1, channelRadius: 4 },
      preview: `<svg viewBox="0 0 80 80"><path d="M18 70 L18 40 Q18 18 40 18 L70 18" ${_RS}/><path d="M32 56 Q32 32 56 32" fill="none" stroke="#3a7bd5" stroke-width="6" stroke-linecap="round"/></svg>`,
    },
  ],
  straight: [
    {
      id: "straight_short",
      label: "Short",
      base: "straight",
      params: { straightLength: 14 },
      preview: `<svg viewBox="0 0 80 80"><rect x="26" y="32" width="28" height="16" rx="2" ${_RB}/><line x1="30" y1="40" x2="50" y2="40" ${_RS}/></svg>`,
    },
    {
      id: "straight_long",
      label: "Long",
      base: "straight",
      params: { straightLength: 32 },
      preview: `<svg viewBox="0 0 80 80"><rect x="8" y="32" width="64" height="16" rx="2" ${_RB}/><line x1="12" y1="40" x2="68" y2="40" ${_RS}/></svg>`,
    },
    {
      id: "straight_tunnel",
      label: "Tunnel",
      base: "tunnel",
      params: { straightLength: 22, tunnelHeight: 7 },
      preview: `<svg viewBox="0 0 80 80"><rect x="8" y="34" width="64" height="14" rx="2" ${_RB}/><path d="M8 34 Q40 8 72 34" fill="none" stroke="#6a7580" stroke-width="3"/></svg>`,
    },
    {
      id: "platform_pad",
      label: "Platform",
      base: "platform",
      params: { platformLength: 24, platformWidth: 44 },
      preview: `<svg viewBox="0 0 80 80"><rect x="10" y="22" width="60" height="36" rx="2" fill="#565f6b" stroke="#8a929c" stroke-width="1.5"/></svg>`,
    },
    {
      id: "narrow_run",
      label: "Narrow",
      base: "narrow",
      params: { straightLength: 24, narrowWidth: 8 },
      preview: `<svg viewBox="0 0 80 80"><rect x="34" y="10" width="12" height="60" rx="1" ${_RB}/><line x1="40" y1="14" x2="40" y2="66" ${_RS}/></svg>`,
    },
  ],
  ramps: [
    {
      id: "ramp_10",
      label: "Ramp 10",
      base: "jump",
      params: { jumpLength: 12, jumpAngle: 18 },
      preview: `<svg viewBox="0 0 80 80"><line x1="8" y1="62" x2="72" y2="62" stroke="#c0392b" stroke-width="1.5"/><path d="M14 62 Q46 62 64 40" ${_RS}/></svg>`,
    },
    {
      id: "ramp_20",
      label: "Ramp 20",
      base: "jump",
      params: { jumpLength: 18, jumpAngle: 24 },
      preview: `<svg viewBox="0 0 80 80"><line x1="8" y1="62" x2="72" y2="62" stroke="#c0392b" stroke-width="1.5"/><path d="M12 62 Q44 62 66 32" ${_RS}/></svg>`,
    },
    {
      id: "ramp_40",
      label: "Ramp 40",
      base: "jump",
      params: { jumpLength: 26, jumpAngle: 30 },
      preview: `<svg viewBox="0 0 80 80"><line x1="8" y1="64" x2="72" y2="64" stroke="#c0392b" stroke-width="1.5"/><path d="M12 64 Q42 64 66 24" ${_RS}/></svg>`,
    },
    {
      id: "ramp_100",
      label: "Ramp 100",
      base: "jump",
      params: { jumpLength: 44, jumpAngle: 36 },
      preview: `<svg viewBox="0 0 80 80"><line x1="8" y1="66" x2="72" y2="66" stroke="#c0392b" stroke-width="1.5"/><path d="M10 66 Q40 66 68 16" ${_RS}/></svg>`,
    },
    {
      id: "ramp_mega",
      label: "Mega ramp",
      base: "jump",
      params: { jumpLength: 56, jumpAngle: 44 },
      preview: `<svg viewBox="0 0 80 80"><line x1="6" y1="70" x2="74" y2="70" stroke="#c0392b" stroke-width="1.5"/><path d="M8 70 Q44 70 70 8" stroke="#e8eaed" stroke-width="3" fill="none" stroke-linecap="round"/></svg>`,
    },
    {
      id: "dive_10",
      label: "Dive 10",
      base: "dive",
      params: { diveLength: 12, diveAngle: 18 },
      preview: `<svg viewBox="0 0 80 80"><line x1="8" y1="18" x2="72" y2="18" stroke="#c0392b" stroke-width="1.5"/><path d="M14 18 Q46 18 64 40" ${_RS}/></svg>`,
    },
    {
      id: "dive_20",
      label: "Dive 20",
      base: "dive",
      params: { diveLength: 18, diveAngle: 24 },
      preview: `<svg viewBox="0 0 80 80"><line x1="8" y1="18" x2="72" y2="18" stroke="#c0392b" stroke-width="1.5"/><path d="M12 18 Q44 18 66 48" ${_RS}/></svg>`,
    },
    {
      id: "dive_40",
      label: "Dive 40",
      base: "dive",
      params: { diveLength: 26, diveAngle: 30 },
      preview: `<svg viewBox="0 0 80 80"><line x1="8" y1="16" x2="72" y2="16" stroke="#c0392b" stroke-width="1.5"/><path d="M12 16 Q42 16 66 56" ${_RS}/></svg>`,
    },
    {
      id: "dive_100",
      label: "Dive 100",
      base: "dive",
      params: { diveLength: 44, diveAngle: 36 },
      preview: `<svg viewBox="0 0 80 80"><line x1="8" y1="14" x2="72" y2="14" stroke="#c0392b" stroke-width="1.5"/><path d="M10 14 Q40 14 68 64" ${_RS}/></svg>`,
    },
    {
      id: "drop_vert",
      label: "Vert drop",
      base: "dive",
      params: { diveLength: 30, diveAngle: 78 },
      preview: `<svg viewBox="0 0 80 80"><line x1="8" y1="12" x2="72" y2="12" stroke="#c0392b" stroke-width="1.5"/><path d="M14 12 Q40 12 44 70" stroke="#e8eaed" stroke-width="3" fill="none" stroke-linecap="round"/></svg>`,
    },
    {
      id: "land_10",
      label: "Land 10",
      base: "landing",
      params: { landLength: 12, landAngle: 18 },
      preview: `<svg viewBox="0 0 80 80"><line x1="8" y1="62" x2="72" y2="62" stroke="#c0392b" stroke-width="1.5"/><path d="M16 40 Q34 62 66 62" ${_RS}/></svg>`,
    },
    {
      id: "land_20",
      label: "Land 20",
      base: "landing",
      params: { landLength: 18, landAngle: 24 },
      preview: `<svg viewBox="0 0 80 80"><line x1="8" y1="62" x2="72" y2="62" stroke="#c0392b" stroke-width="1.5"/><path d="M14 32 Q36 62 68 62" ${_RS}/></svg>`,
    },
    {
      id: "land_40",
      label: "Land 40",
      base: "landing",
      params: { landLength: 26, landAngle: 30 },
      preview: `<svg viewBox="0 0 80 80"><line x1="8" y1="64" x2="72" y2="64" stroke="#c0392b" stroke-width="1.5"/><path d="M14 24 Q38 64 68 64" ${_RS}/></svg>`,
    },
    {
      id: "land_100",
      label: "Land 100",
      base: "landing",
      params: { landLength: 44, landAngle: 36 },
      preview: `<svg viewBox="0 0 80 80"><line x1="8" y1="66" x2="72" y2="66" stroke="#c0392b" stroke-width="1.5"/><path d="M12 16 Q40 66 70 66" ${_RS}/></svg>`,
    },
    {
      id: "brow_10",
      label: "Brow 10",
      base: "brow",
      params: { browLength: 12, browAngle: 18 },
      preview: `<svg viewBox="0 0 80 80"><line x1="8" y1="18" x2="72" y2="18" stroke="#c0392b" stroke-width="1.5"/><path d="M16 40 Q34 18 66 18" ${_RS}/></svg>`,
    },
    {
      id: "brow_20",
      label: "Brow 20",
      base: "brow",
      params: { browLength: 18, browAngle: 24 },
      preview: `<svg viewBox="0 0 80 80"><line x1="8" y1="18" x2="72" y2="18" stroke="#c0392b" stroke-width="1.5"/><path d="M14 48 Q36 18 68 18" ${_RS}/></svg>`,
    },
    {
      id: "brow_40",
      label: "Brow 40",
      base: "brow",
      params: { browLength: 26, browAngle: 30 },
      preview: `<svg viewBox="0 0 80 80"><line x1="8" y1="16" x2="72" y2="16" stroke="#c0392b" stroke-width="1.5"/><path d="M14 56 Q38 16 68 16" ${_RS}/></svg>`,
    },
    {
      id: "brow_100",
      label: "Brow 100",
      base: "brow",
      params: { browLength: 44, browAngle: 36 },
      preview: `<svg viewBox="0 0 80 80"><line x1="8" y1="14" x2="72" y2="14" stroke="#c0392b" stroke-width="1.5"/><path d="M12 64 Q40 14 70 14" ${_RS}/></svg>`,
    },
  ],
  slopes: [
    // Climbs — slope base levels off (smoothstep) at both ends, so they chain cleanly.
    {
      id: "slope_up_gentle",
      label: "Up Gentle",
      base: "slope",
      params: { slopeLength: 30, slopeRise: 5 },
      preview: `<svg viewBox="0 0 80 80"><polygon points="10,64 70,64 70,48" ${_RB}/><line x1="12" y1="62" x2="68" y2="50" ${_RS}/></svg>`,
    },
    {
      id: "slope_up_medium",
      label: "Up Medium",
      base: "slope",
      params: { slopeLength: 28, slopeRise: 10 },
      preview: `<svg viewBox="0 0 80 80"><polygon points="10,64 70,64 70,34" ${_RB}/><line x1="12" y1="62" x2="68" y2="36" ${_RS}/></svg>`,
    },
    {
      id: "slope_up_steep",
      label: "Up Steep",
      base: "slope",
      params: { slopeLength: 26, slopeRise: 16 },
      preview: `<svg viewBox="0 0 80 80"><polygon points="10,64 70,64 70,20" ${_RB}/><line x1="12" y1="62" x2="68" y2="22" ${_RS}/></svg>`,
    },
    // Descents — same shape, negative rise.
    {
      id: "slope_down_gentle",
      label: "Down Gentle",
      base: "slope",
      params: { slopeLength: 30, slopeRise: -5 },
      preview: `<svg viewBox="0 0 80 80"><polygon points="10,48 10,64 70,64" ${_RB}/><line x1="12" y1="50" x2="68" y2="62" ${_RS}/></svg>`,
    },
    {
      id: "slope_down_medium",
      label: "Down Medium",
      base: "slope",
      params: { slopeLength: 28, slopeRise: -10 },
      preview: `<svg viewBox="0 0 80 80"><polygon points="10,34 10,64 70,64" ${_RB}/><line x1="12" y1="36" x2="68" y2="62" ${_RS}/></svg>`,
    },
    {
      id: "slope_down_steep",
      label: "Down Steep",
      base: "slope",
      params: { slopeLength: 26, slopeRise: -16 },
      preview: `<svg viewBox="0 0 80 80"><polygon points="10,20 10,64 70,64" ${_RB}/><line x1="12" y1="22" x2="68" y2="62" ${_RS}/></svg>`,
    },
    // Crests — net-zero bump / dip (rise to the middle, level at both ends).
    {
      id: "slope_hill",
      label: "Hill",
      base: "crest",
      params: { slopeLength: 32, slopeRise: 8 },
      preview: `<svg viewBox="0 0 80 80"><path d="M10 64 L10 52 Q40 18 70 52 L70 64 Z" ${_RB}/><path d="M12 52 Q40 24 68 52" fill="none" ${_RS}/></svg>`,
    },
    {
      id: "slope_dip",
      label: "Dip",
      base: "crest",
      params: { slopeLength: 32, slopeRise: -8 },
      preview: `<svg viewBox="0 0 80 80"><path d="M10 34 Q40 70 70 34 L70 64 L10 64 Z" ${_RB}/><path d="M10 34 Q40 66 70 34" fill="none" ${_RS}/></svg>`,
    },
    // Climbing turn — stack to gain height.
    {
      id: "slope_helix",
      label: "Helix",
      base: "spiral",
      params: { spiralRadius: 18, spiralAngle: 180, spiralRise: 10, curveDir: 1 },
      preview: `<svg viewBox="0 0 80 80"><path d="M20 64 L20 44 Q20 26 40 26 Q60 26 60 44" ${_RS}/><path d="M26 54 Q40 40 56 48" fill="none" stroke="#c0392b" stroke-width="1.4" opacity="0.7"/></svg>`,
    },
  ],
  turns: [
    {
      id: "turn_smooth_small",
      label: "Smooth Small",
      base: "curve",
      params: { curveRadius: 24, curveAngle: 45, curveDir: 1 },
      preview: `<svg viewBox="0 0 80 80"><path d="M20 70 L20 46 Q20 30 40 26 L62 22" ${_RS}/></svg>`,
    },
    {
      id: "turn_smooth_long",
      label: "Smooth Long",
      base: "curve",
      params: { curveRadius: 24, curveAngle: 90, curveDir: 1 },
      preview: `<svg viewBox="0 0 80 80"><path d="M20 70 L20 40 Q20 20 40 20 L70 20" ${_RS}/></svg>`,
    },
    {
      id: "turn_smooth_longer",
      label: "Smooth Longer",
      base: "curve",
      params: { curveRadius: 30, curveAngle: 135, curveDir: 1 },
      preview: `<svg viewBox="0 0 80 80"><path d="M22 70 L22 38 Q22 16 44 16 Q62 16 64 36" ${_RS}/></svg>`,
    },
    {
      id: "turn_smooth_longest",
      label: "Smooth Longest",
      base: "curve",
      params: { curveRadius: 34, curveAngle: 180, curveDir: 1 },
      preview: `<svg viewBox="0 0 80 80"><path d="M20 70 L20 40 Q20 14 42 14 Q64 14 64 40 L64 70" ${_RS}/></svg>`,
    },
    {
      id: "turn_sharp_small",
      label: "Sharp Small",
      base: "curve",
      params: { curveRadius: 12, curveAngle: 90, curveDir: 1 },
      preview: `<svg viewBox="0 0 80 80"><path d="M22 70 L22 36 Q22 22 36 22 L70 22" stroke="#e8eaed" stroke-width="3" fill="none" stroke-linecap="round"/></svg>`,
    },
    {
      id: "turn_s_left",
      label: "S Left",
      base: "scurve",
      params: { curveRadius: 20, curveAngle: 38, curveDir: -1 },
      preview: `<svg viewBox="0 0 80 80"><path d="M58 70 L58 50 Q58 34 40 34 Q22 34 22 18 L22 10" ${_RS}/></svg>`,
    },
    {
      id: "turn_s_right",
      label: "S Right",
      base: "scurve",
      params: { curveRadius: 20, curveAngle: 38, curveDir: 1 },
      preview: `<svg viewBox="0 0 80 80"><path d="M22 70 L22 50 Q22 34 40 34 Q58 34 58 18 L58 10" ${_RS}/></svg>`,
    },
  ],
  loop: [
    {
      id: "looping_full",
      label: "Looping",
      base: "loop",
      params: { loopRadius: 25, loopOffset: 16, loopFlat: 12, loopSpread: 1, loopLean: 0, loopTighten: 0, loopHalf: "full", curveDir: 1 },
      preview: `<svg viewBox="0 0 80 80"><path d="M14 66 Q14 14 40 14 Q66 14 66 50 Q66 66 50 66" ${_RS}/><line x1="8" y1="66" x2="72" y2="66" stroke="#c0392b" stroke-width="1.2"/></svg>`,
    },
    {
      id: "loop_half_right",
      label: "Ring half (in)",
      base: "loop_half",
      params: { loopRadius: 25, loopOffset: 16, loopFlat: 12, loopSpread: 1, loopHalf: "in", curveDir: 1 },
      preview: `<svg viewBox="0 0 80 80"><path d="M40 68 Q18 68 18 40 Q18 14 40 14" ${_RS}/></svg>`,
    },
    {
      id: "loop_half_left",
      label: "Ring half (out)",
      base: "loop_half",
      params: { loopRadius: 25, loopOffset: 16, loopFlat: 12, loopSpread: 1, loopHalf: "out", curveDir: 1 },
      preview: `<svg viewBox="0 0 80 80"><path d="M40 14 Q62 14 62 40 Q62 68 40 68" ${_RS}/></svg>`,
    },
    {
      id: "loop_spiral_right",
      label: "Spiral ramp (R)",
      base: "loop_spiral",
      params: { loopSpiralRadius: 12, loopSpiralTurns: 1, loopSpiralRise: 32, curveDir: 1 },
      preview: `<svg viewBox="0 0 80 80"><line x1="10" y1="62" x2="26" y2="62" stroke="#c0392b" stroke-width="1.5"/><path d="M26 62 Q20 46 24 32 Q32 16 46 12 Q56 22 52 36 Q46 50 34 56" ${_RS}/></svg>`,
    },
    {
      id: "loop_spiral_left",
      label: "Spiral ramp (L)",
      base: "loop_spiral",
      params: { loopSpiralRadius: 12, loopSpiralTurns: 1, loopSpiralRise: 32, curveDir: -1 },
      preview: `<svg viewBox="0 0 80 80"><line x1="70" y1="62" x2="54" y2="62" stroke="#c0392b" stroke-width="1.5"/><path d="M54 62 Q60 46 56 32 Q48 16 34 12 Q24 22 28 36 Q34 50 46 56" ${_RS}/></svg>`,
    },
    {
      id: "quarterpipe_full",
      label: "Quarter-pipe",
      base: "quarterpipe",
      params: { qpRadius: 16, qpAngle: 90 },
      preview: `<svg viewBox="0 0 80 80"><line x1="6" y1="66" x2="74" y2="66" stroke="#c0392b" stroke-width="1.2"/><path d="M14 66 Q52 66 56 16" stroke="#e8eaed" stroke-width="3" fill="none" stroke-linecap="round"/></svg>`,
    },
    {
      id: "quarterpipe_kick",
      label: "Wall kicker",
      base: "quarterpipe",
      params: { qpRadius: 13, qpAngle: 72 },
      preview: `<svg viewBox="0 0 80 80"><line x1="6" y1="66" x2="74" y2="66" stroke="#c0392b" stroke-width="1.2"/><path d="M14 66 Q48 66 62 26" stroke="#e8eaed" stroke-width="3" fill="none" stroke-linecap="round"/></svg>`,
    },
    {
      id: "quarterpipe_down",
      label: "Quarter-pipe down",
      base: "quarterpipe_down",
      params: { qpRadius: 16, qpAngle: 90 },
      preview: `<svg viewBox="0 0 80 80"><line x1="6" y1="14" x2="74" y2="14" stroke="#c0392b" stroke-width="1.2"/><path d="M14 14 Q52 14 56 64" stroke="#e8eaed" stroke-width="3" fill="none" stroke-linecap="round"/></svg>`,
    },
  ],
};

/** Thumbnail map key for the first tile shown in a palette category. */
export function categoryThumbnailKey(catId, propCatalog = [], moverCatalog = []) {
  if (catId === "moving") return moverCatalog[0]?.id ?? null;
  if (catId === "obstacles") return propCatalog[0]?.id ?? null;
  if (catId === "portals") return "portal_door";
  const presets = CATEGORY_PRESETS[catId];
  if (presets?.length) return presets[0].id;
  const piece = PIECE_CATALOG.find((p) => PIECE_TO_CATEGORY[p.id] === catId);
  return piece?.id ?? null;
}

/**
 * Wire the left palette + toolbar DOM to a builder instance.
 * @param {ModularRoadBuilder} builder
 * @param {{ propCatalog?: object[], moverCatalog?: object[], onAddProp?: (id:string)=>void, onAddMover?: (id:string)=>void, onEdgesChange?: ()=>void }} [opts]
 */
export function buildRoadPaletteUI(builder, opts = {}) {
  const {
    propCatalog = [],
    moverCatalog = [],
    thumbnails = null,
    onAddProp = null,
    onAddMover = null,
    onAddPortal = null,
    /** Called when the palette selects something that is NOT a prop/mover
     *  brush, so the game can put a live cursor brush down. */
    onPickPiece = null,
    onEdgesChange = null,
    /** Optional: seat the demo in the sky (terrain + buildHeight). */
    onLoadDemo = null,
    /** Optional: seat the big circuit in the sky. */
    onLoadCircuit = null,
  } = opts;
  const catList = document.getElementById("category-list");
  const grid = document.getElementById("piece-grid");
  const titleEl = document.getElementById("category-title");
  const statusEl = document.getElementById("road-status");
  const edgesBtn = document.getElementById("edges-toggle");
  const collapseTab = document.getElementById("palette-collapse-tab");
  const palette = document.getElementById("palette");

  /** @type {Map<string, HTMLButtonElement>} */
  const pieceTiles = new Map();
  /** @type {Map<string, HTMLButtonElement>} */
  const catBtns = new Map();

  let activeCategory = "straight";
  let activePropId = null;
  let activeMoverId = null;
  let activePresetId = null;

  function categoryIconMarkup(catId) {
    const key = categoryThumbnailKey(catId, propCatalog, moverCatalog);
    const thumb = key ? thumbnails?.get(key) : null;
    if (thumb) return `<img src="${thumb}" alt="" draggable="false">`;
    return categoryIconSvg(catId);
  }

  function piecesInCategory(catId) {
    if (catId === "obstacles") {
      return propCatalog.map((p) => ({ id: p.id, label: p.label, isProp: true, hint: "" }));
    }
    if (catId === "moving") {
      return moverCatalog.map((m) => ({ id: m.id, label: m.label, isMover: true, hint: "" }));
    }
    if (catId === "portals") {
      // Teleport doors are placed, not chained — one tile that drops a door pair.
      return [{ id: "portal_door", label: "Portal door", isPortal: true, hint: "Adds a door (pairs up in twos)" }];
    }
    // Curated kit: if this category has presets, show those instead of raw pieces.
    if (CATEGORY_PRESETS[catId]) {
      return CATEGORY_PRESETS[catId].map((pr) => ({
        id: pr.id,
        label: pr.label,
        isPreset: true,
        preset: pr,
        preview: pr.preview,
      }));
    }
    return PIECE_CATALOG.filter((p) => PIECE_TO_CATEGORY[p.id] === catId);
  }

  function syncEdgesBtn() {
    if (!edgesBtn) return;
    const on = guardrailParams.enabled;
    edgesBtn.classList.toggle("on", on);
    edgesBtn.innerHTML = on ? "Edges<br>On" : "Edges<br>Off";
  }

  function renderPieces() {
    grid.innerHTML = "";
    pieceTiles.clear();
    activePropId = null;
    activeMoverId = null;

    const items = piecesInCategory(activeCategory);
    const catLabel = PALETTE_CATEGORIES.find((c) => c.id === activeCategory)?.label ?? activeCategory;
    if (titleEl) titleEl.textContent = catLabel;

    for (const item of items) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "piece-tile";
      btn.dataset.pieceId = item.id;
      if (item.soon) {
        btn.classList.add("soon");
        btn.disabled = true;
      }
      if (item.isProp) btn.dataset.isProp = "1";
      if (item.isMover) btn.dataset.isMover = "1";
      if (item.isPreset) btn.dataset.isPreset = "1";

      const preview = document.createElement("div");
      preview.className = "piece-tile-preview";
      const thumb = thumbnails?.get(item.id);
      if (thumb) {
        const img = document.createElement("img");
        img.src = thumb;
        img.alt = item.label;
        img.draggable = false;
        preview.appendChild(img);
      } else {
        preview.innerHTML = item.isPreset ? item.preview : piecePreviewSvg(item.id);
      }

      const name = document.createElement("span");
      name.className = "piece-tile-name";
      name.textContent = item.label;

      btn.appendChild(preview);
      btn.appendChild(name);
      if (item.key && !item.soon) {
        const key = document.createElement("span");
        key.className = "piece-tile-key";
        key.textContent = item.key;
        btn.appendChild(key);
      }

      btn.addEventListener("click", () => {
        if (item.soon) return;
        // PROPS AND MOVERS ARM A CURSOR BRUSH — they do not place anything yet.
        // Clicking the tile used to drop the object at the camera's orbit target
        // and leave you to drag it into position with a gizmo, which is a
        // different mental model from road PIECES (ghost, aim, click) in the
        // same palette. Now both work the same way: pick it here, aim with the
        // mouse, left-click to place, Escape to put the brush down.
        if (item.isProp && onAddProp) {
          activePropId = item.id;
          activeMoverId = null;
          activePresetId = null;
          builder.setActivePiece(builder.activePieceId);
          onAddProp(item.id);
          refreshStatus();
          return;
        }
        if (item.isMover && onAddMover) {
          activeMoverId = item.id;
          activePropId = null;
          activePresetId = null;
          builder.setActivePiece(builder.activePieceId);
          onAddMover(item.id);
          refreshStatus();
          return;
        }
        if (item.isPortal && onAddPortal) {
          activePropId = null;
          activeMoverId = null;
          activePresetId = null;
          onPickPiece?.(); // a door is placed immediately — drop any live brush
          onAddPortal();
          refreshStatus();
          return;
        }
        if (item.isPreset) {
          activePropId = null;
          activeMoverId = null;
          activePresetId = item.id;
          onPickPiece?.();
          builder.setActivePreset(item.preset);
          refreshStatus();
          return;
        }
        activePropId = null;
        activeMoverId = null;
        activePresetId = null;
        onPickPiece?.(); // choosing a road piece cancels a prop brush
        builder.setActivePiece(item.id);
        refreshStatus();
      });

      grid.appendChild(btn);
      const suffix = item.isProp ? ":prop" : item.isMover ? ":mover" : item.isPreset ? ":preset" : "";
      pieceTiles.set(item.id + suffix, btn);
    }
    refreshStatus();
  }

  /** Highlight whichever tile + category is currently selected. */
  function syncTiles() {
    for (const [key, btn] of pieceTiles) {
      let active;
      if (key.endsWith(":prop")) {
        active = activePropId === key.slice(0, -5);
      } else if (key.endsWith(":mover")) {
        active = activeMoverId === key.slice(0, -6);
      } else if (key.endsWith(":preset")) {
        active = activePresetId === key.slice(0, -7);
      } else {
        active = !activePropId && !activeMoverId && !activePresetId && key === builder.activePieceId;
      }
      btn.classList.toggle("active", active);
    }
    for (const [id, btn] of catBtns) {
      btn.classList.toggle("active", id === activeCategory);
    }
  }

  function refreshStatus() {
    // A prop/mover brush is a MODE, and the status line is the only thing that
    // says so — without this it goes on naming the road piece while the mouse is
    // carrying a cone, which is the same class of lie selectPieceById fixed.
    if (statusEl && (activePropId || activeMoverId)) {
      const src = activePropId ? propCatalog : moverCatalog;
      const id = activePropId ?? activeMoverId;
      const label = src.find((p) => p.id === id)?.label ?? id;
      statusEl.textContent =
        `${builder.count} placed · ${label} — click to place, Esc to cancel`;
      syncTiles();
      return;
    }
    if (statusEl) {
      let label;
      if (activePresetId) {
        const all = Object.values(CATEGORY_PRESETS).flat();
        label = all.find((p) => p.id === activePresetId)?.label ?? activePresetId;
      } else {
        const def = PIECE_BY_ID.get(builder.activePieceId);
        label = def?.label ?? builder.activePieceId;
      }
      const dir = pieceParams.curveDir >= 0 ? "R" : "L";
      const curveIds = new Set(["curve", "banked", "scurve", "spiral", "loop_half", "loop_spiral"]);
      const chainInfo =
        builder.chainCount > 1 ? ` · chain ${builder.activeChainIndex + 1}/${builder.chainCount}` : "";
      const gizmoHint =
        builder.gizmoMode === "ghost"
          ? builder.ghostDetached
            ? "free piece — drag near an open end to snap"
            : "drag gizmo to move the piece anywhere"
          : "anchor gizmo drags whole chain";
      statusEl.textContent = `${builder.count} placed · ${label}${
        curveIds.has(builder.activePieceId) ? " (" + dir + ")" : ""
      }${chainInfo} · ${gizmoHint}`;
    }
    syncTiles();
  }

  // Category rail
  if (catList) {
    for (const cat of PALETTE_CATEGORIES) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "cat-btn";
      btn.dataset.categoryId = cat.id;
      btn.innerHTML = `
        <span class="cat-btn-icon">${categoryIconMarkup(cat.id)}</span>
        <span class="cat-btn-label">${cat.label}</span>
      `;
      btn.addEventListener("click", () => {
        activeCategory = cat.id;
        renderPieces();
      });
      catList.appendChild(btn);
      catBtns.set(cat.id, btn);
    }
  }

  edgesBtn?.addEventListener("click", () => {
    guardrailParams.enabled = !guardrailParams.enabled;
    syncEdgesBtn();
    builder.refreshGhost();
    onEdgesChange?.();
  });
  syncEdgesBtn();

  collapseTab?.addEventListener("click", () => {
    palette?.classList.toggle("collapsed");
  });

  renderPieces();

  document.getElementById("road-place")?.addEventListener("click", () => {
    builder.place();
    refreshStatus();
  });
  document.getElementById("road-flip")?.addEventListener("click", () => {
    builder.flip();
    refreshStatus();
  });
  document.getElementById("road-undo")?.addEventListener("click", () => {
    builder.undo();
    refreshStatus();
  });
  document.getElementById("road-demo")?.addEventListener("click", () => {
    if (onLoadDemo) onLoadDemo();
    else builder.loadDemo();
    refreshStatus();
  });
  document.getElementById("road-circuit")?.addEventListener("click", () => {
    if (onLoadCircuit) onLoadCircuit();
    else builder.loadBigCircuit();
    refreshStatus();
  });
  document.getElementById("road-clear")?.addEventListener("click", () => {
    builder.clear();
    refreshStatus();
  });

  window.addEventListener("keydown", (e) => {
    if (e.target instanceof HTMLInputElement) return;
    const byKey = PIECE_CATALOG.find((p) => p.key === e.key);
    if (byKey) {
      activePropId = null;
      activePresetId = null;
      activeCategory = PIECE_TO_CATEGORY[byKey.id] ?? activeCategory;
      renderPieces();
      builder.setActivePiece(byKey.id);
      refreshStatus();
      return;
    }
    if (e.code === "KeyR") {
      builder.flip();
      refreshStatus();
    } else if (e.code === "KeyQ" && builder.freePlaceMode && builder.isBuildMode()) {
      builder.rotateFreeYaw(Math.PI / 12);
      refreshStatus();
    } else if (e.code === "KeyE" && builder.freePlaceMode && builder.isBuildMode()) {
      if (e.shiftKey) builder.setPlacementGizmoMode("rotate");
      else builder.rotateFreeYaw(-Math.PI / 12);
      refreshStatus();
    } else if (e.code === "KeyW" && builder.freePlaceMode && builder.isBuildMode()) {
      builder.setPlacementGizmoMode("translate");
      refreshStatus();
    } else if (e.code === "Enter" || e.code === "Space") {
      if (builder.isBuildMode()) {
        e.preventDefault();
        builder.place();
        refreshStatus();
      }
    } else if (e.code === "Backspace") {
      e.preventDefault();
      builder.undo();
      refreshStatus();
    }
  });

  /**
   * Select a piece BY ID and put the palette in the matching state — the same
   * thing clicking its tile does.
   *
   * Exists because the piece HOTKEYS live in roadGame.js (it takes the keyboard
   * in the capture phase so the v3 editor's own shortcuts cannot reach us, which
   * leaves the listener below dead), and from out there the three `active*`
   * variables and `activeCategory` are unreachable — the palette only ever
   * exported {refreshStatus, renderPieces, syncEdgesBtn}. So its hotkey handler
   * called `builder.setActivePiece()` and could do nothing about the rest, and
   * the palette went on describing the PREVIOUS selection:
   *   • the status line showed the preset's label, because renderPieces() clears
   *     activePropId and activeMoverId but not activePresetId;
   *   • no tile highlighted, since that test requires all three to be null;
   *   • the grid stayed on the old category, so the piece could be off-screen.
   * You were placing one piece while the UI named another.
   *
   * @returns {boolean} false if `id` is not a real piece
   */
  function selectPieceById(id) {
    if (!PIECE_BY_ID.has(id)) return false;
    onPickPiece?.(); // hotkeys cancel a live prop brush, same as clicking a tile
    activePropId = null;
    activeMoverId = null;
    activePresetId = null;
    activeCategory = PIECE_TO_CATEGORY[id] ?? activeCategory;
    builder.setActivePiece(id);
    renderPieces(); // re-renders the grid for the (possibly new) category
    refreshStatus();
    return true;
  }

  /** Drop the prop/mover brush highlight — the game calls this when the brush
   *  is cancelled from its side (Escape, right-click, leaving build mode). */
  function clearBrushHighlight() {
    if (!activePropId && !activeMoverId) return;
    activePropId = null;
    activeMoverId = null;
    refreshStatus();
  }

  return { refreshStatus, renderPieces, syncEdgesBtn, selectPieceById, clearBrushHighlight };
}
