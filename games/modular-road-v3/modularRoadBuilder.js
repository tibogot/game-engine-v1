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
  linkCurvature,
} from "./modularRoadKit.js";
import { solveGapArc } from "./gapArc.js";

/**
 * THE KIT'S SHIPPED NUMBERS, snapshotted at import — before anything can write
 * to the live `pieceParams`, which a track load does.
 *
 * A TILE IS A BLOCK. Every palette tile now resolves to `{...PIECE_DEFAULTS,
 * ...tile.params}`, so clicking "Long" gives a 32 m straight every time,
 * whatever you clicked before it. It used to `Object.assign` its numbers into
 * the one shared `pieceParams` and leave them there, which made a tile's effect
 * depend on click history: fourteen tiles that are not straights at all write
 * `straightLength`, so picking Banked → "Straight Right" silently turned your
 * next Straight from 22 m into 32 m. On a point-to-point stunt track that is a
 * run-up length — i.e. the speed you arrive at a jump with — changing under you
 * with nothing on screen to say so.
 *
 * `pieceParams` itself is left alone: the piece lab drives it, and the save
 * format still carries it. Nothing on the PLACEMENT path reads it any more.
 */
const PIECE_DEFAULTS = { ...pieceParams };

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
/** Never mutated — the entry pose a piece is built at to read back its own
 *  entry→exit transform. See `_localTransform`. */
const _IDENTITY = new THREE.Matrix4();
const _isIdentityQuat = (q) => Math.abs(q.w) > 0.9999999;

/** How close a chain's head has to sit to a branch socket or another chain's
 *  tail to count as JOINED there (and so not an open end you may prepend onto).
 *  Same tolerance the branch "used" test has always applied, for the same
 *  reason: seams are welded by position, not by a stored link. */
const HEAD_JOIN_EPS = 1.0;

/**
 * How near the cursor has to be to an open end, IN SCREEN PIXELS, for the next
 * piece to jump there (see `aimAtCursor`).
 *
 * Pixels, not metres, on purpose. The gizmo's own magnet is a 6 m sphere, which
 * on a kit of 22–44 m pieces is about a quarter of one straight — invisibly
 * small when the camera is pulled back over a whole circuit, and clumsily large
 * when you are nosed right up to a seam. A screen radius is the same gesture at
 * every zoom: "near the thing I am looking at".
 */
const AIM_PIXEL_RADIUS = 90;

/**
 * Tightest corner radius (m) a generated link may have before the builder
 * declines to make it.
 *
 * This is a GEOMETRY guard, not a driveability one — below a few metres the
 * swept deck folds through itself and the result is not a road at all, which is
 * what a Hermite gives you when the target sits behind you (measured: 0.1–1.5 m
 * on hairpin asks). Whether a legal join is *comfortable* is a separate
 * question, and `linkTo` returns the radius so the caller can say so; the kit's
 * own sharpest authored turn is 12 m for reference.
 */
const LINK_MIN_RADIUS = 6;

/**
 * Flat chevron for a junction branch marker, in socket-local space: a socket's
 * −Z axis is the way out (see socketMatrix), so the arrow is drawn pointing −Z
 * and floats a little above the deck.
 */
function _makeBranchMarkerGeometry() {
  const s = 2.2;
  const y = 1.2;
  const v = [
    0, y, -3.4 * s, // tip
    -1.9 * s, y, -1.0 * s,
    -0.7 * s, y, -1.0 * s,
    -0.7 * s, y, 1.6 * s,
    0.7 * s, y, 1.6 * s,
    0.7 * s, y, -1.0 * s,
    1.9 * s, y, -1.0 * s,
  ];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(v, 3));
  geo.setIndex([0, 1, 2, 0, 2, 5, 0, 5, 6, 2, 3, 4, 2, 4, 5]);
  geo.computeVertexNormals();
  return geo;
}

/** Ballistic landing for demo jumps — THE SAME SOLVER the red arc draws, so a
 *  generated demo track lands where the preview says it would. It used to be a
 *  hand-rolled copy of the parabola here, which silently stopped matching the
 *  moment the preview learned about drag.
 *
 *  `dragK` is passed rather than imported so this module keeps no dependency on
 *  the vehicle; the caller supplies AERO.drag / CHASSIS.mass. */
function _ballisticLanding(connector, speed, g, landingDrop, dragK = 0) {
  const land = solveGapArc(connector, speed, { gravity: g, dragK, landingDrop });
  if (!land) return null;
  const e = connector.elements;
  const dir = new THREE.Vector3(-e[8], -e[9], -e[10]).normalize();
  // Match beginNewChain yaw: travel = R_y(yaw)·(0,0,-1) = (−sin, 0, −cos).
  return { pos: land.pos, yaw: Math.atan2(-dir.x, -dir.z) };
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
   * @param {THREE.Material} [o.glassMaterial] shared pane material (glass road)
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
    glassMaterial = null,
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
    this.glassMaterial = glassMaterial;
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
    /**
     * Which axes the placement gizmo drags on: "world" (aligned with the build
     * grid, and the right frame for dropping a chain somewhere tidy) or "local"
     * (along the connector's own travel / lateral / up — what you want after a
     * jump). See setPlacementGizmoSpace.
     *
     * Declared HERE and not beside the gizmo, because the gizmo only exists when
     * a camera and a DOM element were supplied — headless there is none, and
     * `_snapDelta` reads this either way.
     * @type {"world"|"local"}
     */
    this.gizmoSpace = "world";

    this.activePieceId = PIECE_CATALOG[0].id;
    /**
     * The numbers the NEXT piece will be built from — this selection's own copy,
     * never the shared `pieceParams`. See PIECE_DEFAULTS: this is what makes a
     * palette tile mean one fixed thing instead of an edit to global state.
     */
    this.activeParams = { ...PIECE_DEFAULTS };
    /** @type {{id:string, chainId:number, pp:object, mesh:THREE.Mesh, railMesh:THREE.Mesh|null, shellMesh:THREE.Mesh|null, decorMesh:THREE.Mesh|null, glassMesh:THREE.Mesh|null, connectorIn:THREE.Matrix4, connectorOut:THREE.Matrix4}[]} */
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

    // Undo/redo. `_baseline` is the state as of the last commit: it is what a
    // redo returns to, and what the next commit pushes onto the undo stack.
    /** @type {object[]} */ this._undoStack = [];
    /** @type {object[]} */ this._redoStack = [];
    /** Seeded below, once the placement cursor exists: the first edit must have
     *  a state to return TO, or it can never be undone and the whole stack sits
     *  one step behind. */
    this._baseline = null;
    /** While true, edits do not commit — see `_asOneEdit`. */
    this._histSuspend = false;

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
    /** FULL ghost orientation. Free placement can only ever produce a yaw (kit
     *  sockets are level), but a JUNCTION BRANCH hands over the junction's own
     *  pose — including whatever pitch/roll the junction inherited from its
     *  chain — and a yaw-only ghost would silently flatten the side road at the
     *  seam. `_ghostYaw` stays in sync for the readouts. */
    this._ghostQuat = new THREE.Quaternion();
    /** True while the ghost is parked on a junction branch (see branchConnectors). */
    this.ghostOnBranch = false;
    /**
     * WHICH END of the active chain the ghost is working on: "tail" appends (the
     * original and still the default), "head" PREPENDS — the piece goes in front
     * of the chain and the anchor moves back to meet it.
     * @type {"tail"|"head"}
     */
    this.ghostEnd = "tail";
    /** @type {Map<string, THREE.Matrix4>} memo for `_localTransform`. */
    this._localXfCache = new Map();
    /** Which open end the cursor last snapped to, so a mousemove that stays on
     *  the same one does no work at all. @type {string|null} */
    this._lastAimKey = null;

    // Seeded HERE, not up with the stacks: a snapshot carries the placement
    // cursor, and every field it reads is declared above this line.
    this._baseline = this._snapshot();

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

    // ── JUNCTION BRANCH MARKERS ──────────────────────────────────────────────
    // A branch is an open connector with nothing standing on it, so unlike a
    // chain's open end (which has the ghost sitting on it) there is nothing on
    // screen to say it exists. These floating arrows are that signal: one per
    // UNUSED branch, pointing the way the side road would run, gone the moment a
    // chain starts there. Build-mode only — drive mode hides builder.root, and
    // this group rides it.
    this.branchMarkers = new THREE.Group();
    this.branchMarkers.name = "ModularRoadEndMarkers";
    this.root.add(this.branchMarkers);
    this.branchMarkerGeo = _makeBranchMarkerGeometry();
    /**
     * One arrow per OPEN END, coloured by what it is. Branches have always had
     * a marker; chain ends never did, so the only way to find out where you
     * could build was to move the cursor around and watch the ghost twitch —
     * which got worse, not better, once pointing at an end started doing
     * something (see `aimAtCursor`).
     *
     * Every arrow points the way a piece placed there would GROW, which is why
     * a head's socket has to be turned around before it is drawn: a head faces
     * INTO its chain, and an arrow pointing back down the road you already built
     * would say the opposite of what prepending does.
     */
    this.endMarkerMats = {
      /** Junction side exit — start a new chain here. */
      branch: new THREE.MeshBasicMaterial({
        color: 0xffc93c, transparent: true, opacity: 0.55,
        depthWrite: false, side: THREE.DoubleSide,
      }),
      /** Chain tail — the ordinary "keep going this way" end. */
      tail: new THREE.MeshBasicMaterial({
        color: 0x54d6ff, transparent: true, opacity: 0.42,
        depthWrite: false, side: THREE.DoubleSide,
      }),
      /** Chain head — building here PREPENDS, so it gets its own colour. */
      head: new THREE.MeshBasicMaterial({
        color: 0xb98cff, transparent: true, opacity: 0.42,
        depthWrite: false, side: THREE.DoubleSide,
      }),
      /** Whichever end the next piece is actually aimed at. Opaque and drawn on
       *  top: of all the arrows on screen, this is the one that answers "where
       *  will this piece land if I click now". */
      aimed: new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0.95,
        depthWrite: false, depthTest: false, side: THREE.DoubleSide,
      }),
    };
    this.branchMarkerMat = this.endMarkerMats.branch; // back-compat for disposal

    /** Pivot + gizmo for free-chain placement (N). */
    this.placementPivot = new THREE.Object3D();
    this.placementPivot.name = "RoadPlacementPivot";
    scene.add(this.placementPivot);
    this.placementGizmo = null;
    if (camera && domElement) {
      this.placementGizmo = new TransformControls(camera, domElement);
      this.placementGizmo.setMode("translate");
      this.placementGizmo.setSpace(this.gizmoSpace);
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
          // ONE HISTORY ENTRY PER DRAG, not one per frame. `change` fires every
          // frame while dragging and the handlers mutate as they go (a translate
          // even calls detachPiece, which commits), so without this a single
          // gizmo move would bury the undo stack under hundreds of steps and
          // Ctrl+Z would crawl back a pixel at a time.
          this._histSuspend = true;
        } else {
          this._histSuspend = false;
          this._commit();
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
    // ONLY THE CHAIN ANCHOR ROUNDS ITS ABSOLUTE POSITION, and that is the whole
    // authored-vs-derived distinction: dropping a new chain somewhere tidy is
    // authoring, and landing it on a cell is exactly what lets two separately
    // built chains meet. A selected PIECE and the next-piece GHOST are both
    // already somewhere — put there by the chain, or seated on a computed
    // ballistic landing — so rounding them absolutely teleports them off it.
    // Those two snap the DRAG DELTA instead (see _onPieceGizmoChange and the
    // detach branch of _onPlacementGizmoChange), which keeps them where they are
    // and still moves in tidy steps.
    const absoluteSnapOk = this._gizmoTarget === "chain";
    g.translationSnap = this.snapEnabled && absoluteSnapOk ? this.snapStep : null;
    g.rotationSnap = this.snapEnabled ? THREE.MathUtils.degToRad(this.snapYawDeg) : null;
  }

  /** Snap a world position onto the build grid (in place). */
  snapPos(v) {
    if (!this.snapEnabled) return v;
    const s = this.snapStep;
    v.set(Math.round(v.x / s) * s, Math.round(v.y / s) * s, Math.round(v.z / s) * s);
    return v;
  }

  /**
   * Snap a DRAG DELTA (in place).
   *
   * World space rounds each component, which is what "move in grid steps" means
   * when the axes are the grid's. LOCAL space cannot: a drag along a local axis
   * has arbitrary world components, and rounding them separately knocks the move
   * off the very axis the handle was there to hold. So round the DISTANCE and
   * keep the direction.
   */
  _snapDelta(v) {
    if (!this.snapEnabled) return v;
    if (this.gizmoSpace !== "local") return this.snapPos(v);
    const len = v.length();
    if (len < 1e-6) return v;
    return v.setLength(Math.round(len / this.snapStep) * this.snapStep);
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
    return { ...this.activeParams };
  }

  _notify() {
    this.onChange?.();
  }

  /**
   * Select a BASE piece — the canonical block, at the kit's own numbers.
   *
   * Resetting to PIECE_DEFAULTS is the point, not a side effect: this is what
   * makes "Straight" mean 22 m however you got here. Before, it only set the id
   * and inherited whatever the last preset had written globally, so the same
   * hotkey gave a different-sized piece depending on click history.
   */
  setActivePiece(id) {
    if (!PIECE_BY_ID.has(id)) return;
    this.activePieceId = id;
    this.activeParams = { ...PIECE_DEFAULTS };
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
      // On a branch the ghost carries the junction's FULL pose, so put that on
      // the pivot too — otherwise picking a different piece would quietly level
      // the gizmo while the ghost itself stayed tilted.
      if (this.ghostOnBranch) this.placementPivot.quaternion.copy(this._ghostQuat);
    } else {
      // Keep the END you were building from. Picking a different SHAPE is not a
      // decision about where it goes, and defaulting to the tail here quietly
      // threw you back to the far end of the chain mid-prepend.
      this._syncGizmoToOpenEnd({ end: this.ghostEnd });
    }
  }

  /**
   * Select a palette tile: its base piece, at ITS OWN numbers over the kit
   * defaults. The generator is unchanged — a tile is a named param snapshot, so
   * placing it builds identical local geometry every time (instancing-friendly).
   *
   * Resolved fresh from PIECE_DEFAULTS rather than layered onto whatever is
   * current, so a tile that only sets `straightLength` cannot inherit a
   * `curveRadius` from the tile you clicked before it.
   * @param {{base:string, params:object}} preset
   */
  setActivePreset(preset) {
    if (!preset || !PIECE_BY_ID.has(preset.base)) return;
    this.activePieceId = preset.base;
    this.activeParams = { ...PIECE_DEFAULTS, ...preset.params };
    this._ensureGizmoOnGhost();
    this.refreshGhost();
    this._notify();
  }

  /** Flip curve direction (only meaningful for the curve piece). */
  flip() {
    // On THIS SELECTION, not the shared params — flipping a turn must not
    // reach out and reverse the next piece someone else picks.
    this.activeParams.curveDir = this.activeParams.curveDir >= 0 ? -1 : 1;
    this.refreshGhost();
    this._notify();
  }

  /**
   * Start a new disconnected chain at `atPos` and make it active.
   *
   * `exact` skips the build grid, and the distinction it draws is the important
   * part: grid snapping is right for a point you are AUTHORING (drop a chain
   * somewhere tidy so two of them can meet) and wrong for a point that was
   * DERIVED (this is where the car lands). One global `snapEnabled` used to
   * govern both, so a computed ballistic landing was rounded to the nearest 8 m
   * cell and 15° — measured at 2.95 m and 4.44 m out on ordinary jumps, up to
   * 5.66 m horizontally and 7.5° in the worst case. The pad ended up metres from
   * where the car actually comes down. See snapLanding() in roadGame.js.
   */
  beginNewChain(atPos = null, yaw = null, { exact = false } = {}) {
    this._markCursor();
    this.freePlaceMode = true;
    this._gizmoTarget = "chain";
    this.ghostDetached = false;
    this.ghostEnd = "tail";
    const y = yaw != null ? yaw : 0;
    this.freeYaw = exact ? y : this.snapYaw(y);
    this._freeQuat.setFromAxisAngle(_YUP, this.freeYaw); // new chains start level
    if (atPos) this._freePos.copy(atPos);
    else if (this.orbit?.target) this._freePos.copy(this.orbit.target);
    if (!exact) this.snapPos(this._freePos); // land the new chain on the build grid
    // REUSE AN EMPTY CHAIN INSTEAD OF STACKING ANOTHER ONE ON TOP OF IT.
    // A chain with no pieces is nothing but an anchor, so "start a new chain
    // here" and "move the empty chain I already have here" are the same act.
    // Without this the boot seeded a second chain over the constructor's own
    // empty chain 0, and a fresh editor opened reading "chain 2/2" with nothing
    // placed — an empty chain that could never be reached, filled or removed,
    // and that every [ / ] cycle then stepped through forever.
    const reuse = this.chains.find((c) => !this.pieces.some((p) => p.chainId === c.id));
    const anchor = this._anchorFromFree();
    if (reuse) {
      reuse.anchor = anchor;
      this.activeChainId = reuse.id;
    } else {
      const id = this.chainSeq++;
      this.chains.push({ id, anchor });
      this.activeChainId = id;
    }
    this.currentConnector = anchor.clone();
    this._showPlacementGizmo();
    this.refreshGhost();
    this._commit();
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

  /**
   * Flip which END of the active chain the next piece goes on — the keyboard
   * counterpart to dragging the ghost onto the other end.
   *
   * Refuses on a chain whose head is already joined to something (a junction
   * branch, or another chain's tail): `_openConnectors` does not offer that head
   * as open, and prepending there would tear the chain off what it was built
   * onto. Returns false so the caller can say why nothing happened.
   */
  toggleBuildEnd() {
    if (this._gizmoTarget === "piece") this.deselectPiece();
    if (this.ghostEnd === "head") {
      this._syncGizmoToOpenEnd({ end: "tail" });
      this.refreshGhost();
      this._notify();
      return true;
    }
    const canHead = this._openConnectors()
      .some((oc) => oc.chainId === this.activeChainId && oc.end === "head");
    if (!canHead) return false;
    this._syncGizmoToOpenEnd({ end: "head" });
    this.refreshGhost();
    this._notify();
    return true;
  }

  /** Which end the next piece lands on — for the status line. */
  get buildEnd() {
    return this.ghostDetached ? "free" : this.ghostEnd;
  }

  /**
   * How far the active piece would take you: `span` is entry→exit distance in
   * metres, `rise` the height it gains.
   *
   * MEASURED, not looked up. Every piece is a different shape and there is no
   * one parameter that means "size" across 45 of them — but they all have an
   * exit, and `_localTransform` already knows where it is (memoised, so this is
   * free after the first call per parameter set).
   *
   * Worth showing because the palette tiles are PRESETS over one shared
   * `pieceParams`: "Short" and "Long" are the same `straight` piece with
   * `straightLength` set to 14 or 32, `Object.assign`ed into that shared object
   * and never put back. So the piece the editor boots on is 22 m, no tile
   * offers 22, and clicking an unrelated tile (a Banked preset also writes
   * `straightLength: 32`) silently resizes your next straight. With the number
   * on screen that is obvious; without it, it is invisible — a circuit that
   * refuses to close by exactly one piece length, for no reason you can see.
   */
  get activePieceMetrics() {
    const L = this._localTransform(this.activePieceId, this.activeParams, guardrailParams.enabled);
    const v = new THREE.Vector3().setFromMatrixPosition(L);
    return { span: v.length(), rise: v.y };
  }

  /** Can the active chain be grown from its head? (button enablement) */
  get canBuildFromHead() {
    return this._openConnectors()
      .some((oc) => oc.chainId === this.activeChainId && oc.end === "head");
  }

  // ── CLOSING A GAP: the LINK ────────────────────────────────────────────────
  // A chain is a rigid sequence, so its end-to-end transform is fixed by the
  // pieces in it: you can weld ONE end onto a target and not the other. Joining
  // an alternate route back into a merge pins both, so something has to solve
  // for the leftover — that is the `link` piece, and this is what aims it.

  /**
   * Every open end a link could legally aim AT, from the end you are on now.
   * Excludes the active chain's own ends: a road cannot close a gap to itself,
   * and offering it just puts a degenerate piece in the list.
   */
  linkTargets() {
    return this._openConnectors().filter((oc) => oc.chainId !== this.activeChainId);
  }

  /**
   * Build a link from the active chain's open end to `target`, and append it.
   *
   * The gap is measured in the ENTRY'S LOCAL FRAME (`T = A⁻¹·B`), which is
   * exactly the form the piece's params want — so the link stays a pure function
   * of its params and rebuildAll re-derives it like anything else.
   *
   * @returns {{ok:boolean, reason?:string, gap?:number, radius?:number}}
   */
  /**
   * The pose a road must be in to ARRIVE at an open end, as opposed to leave it.
   *
   * Every open connector has an OUTWARD direction — the way a piece placed there
   * would grow. A tail and a junction branch point outward already; a head faces
   * into its chain, so its outward is the reverse (the same 180° the head marker
   * is drawn with). Arriving is outward reversed, so:
   *
   *   tail / branch → matrix · 180°     head → matrix
   *
   * Getting this wrong is not a cosmetic detail. Aimed ALONG a merge socket
   * instead of into it, the link has to leave the route going one way and arrive
   * going back up the track — a hairpin, measured at a 0 m radius, i.e. a cusp.
   * Reversed, the same join is an ordinary sweeping curve.
   */
  _arrivalPose(oc) {
    const m = oc.matrix.clone();
    return oc.end === "head" ? m : m.multiply(_A_M.makeRotationY(Math.PI));
  }

  linkTo(target) {
    if (!target?.matrix) return { ok: false, reason: "no target" };
    if (this.ghostEnd === "head") {
      // Prepending grows the chain backwards; a link has to leave FROM an end,
      // and the head's outward direction is the reverse of the chain's travel.
      // Rather than guess, say so — the tail is what you want to link from.
      return { ok: false, reason: "switch to the chain's far end (O) before linking" };
    }
    const A = this.currentConnector.clone();
    const T = A.invert().multiply(this._arrivalPose(target)); // gap in A's local frame

    _A_V.setFromMatrixPosition(T);
    _A_M.extractRotation(T);
    // Heading of the target IN A's FRAME. Travel is −Z (socketMatrix), so the
    // yaw that reproduces it is atan2(−x, −z) of the rotated travel axis.
    _A_TRAVEL.set(0, 0, -1).applyMatrix4(_A_M);
    const yaw = Math.atan2(-_A_TRAVEL.x, -_A_TRAVEL.z);

    const pp = {
      ...this.activeParams,
      linkX: _A_V.x, linkY: _A_V.y, linkZ: _A_V.z,
      linkYawDeg: THREE.MathUtils.radToDeg(yaw),
    };
    const gap = _A_V.length();
    if (gap < 0.5) return { ok: false, reason: "those ends are already touching" };

    // REFUSE A CUSP. Two poses can always be joined by a Hermite, but if the
    // target sits behind you — or barely to one side — the only curve that hits
    // both is a hairpin, and the sweep of a 1 m radius is a self-intersecting
    // mess no car could take. Measured on a two-piece stub 18.5 m from a merge
    // it pointed away from: radius 1 m. The fix is not a cleverer solver, it is
    // to build a bit further before joining, so say that.
    const radius = linkCurvature(pp);
    if (radius < LINK_MIN_RADIUS) {
      return {
        ok: false,
        gap,
        radius,
        reason: `too tight to bridge (${radius.toFixed(0)} m radius) — build further before linking`,
      };
    }

    this._markCursor();
    const piece = this._makePieceEntry(
      "link", this.activeChainId, this.currentConnector, pp, guardrailParams.enabled);
    this.pieces.push(piece);
    this.rebuildAll();
    this._syncGizmoToOpenEnd();
    this._commit();
    this._notify();
    return { ok: true, gap, radius };
  }

  /** Link to the nearest legal end — the no-aim version, for a key or button. */
  linkToNearestEnd() {
    const targets = this.linkTargets();
    if (!targets.length) return { ok: false, reason: "nothing else to join to" };
    const from = _A_V2.setFromMatrixPosition(this.currentConnector);
    let best = null;
    const p = new THREE.Vector3();
    for (const t of targets) {
      const d = p.setFromMatrixPosition(t.matrix).distanceTo(from);
      if (!best || d < best.d) best = { t, d };
    }
    return this.linkTo(best.t);
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

  /**
   * WORLD or LOCAL axes for the placement gizmo.
   *
   * World was the only option, and after a jump it is the wrong one. A takeoff
   * points wherever the last corner left you, so "slide the landing pad a bit
   * further along the flight line" came out as a mix of an X drag and a Z drag
   * with no way to hold the line. In local space the blue arrow IS the direction
   * of travel, the red one is lateral, and the green one is up — so nudging a
   * pad along the arc, or widening a gap, is one drag on one axis.
   *
   * World stays the default: it is the right frame for the ordinary job of
   * dropping a chain on the build grid, and the grid is world-aligned.
   */
  setPlacementGizmoSpace(space) {
    if (!this.placementGizmo) return;
    this.gizmoSpace = space === "local" ? "local" : "world";
    this.placementGizmo.setSpace(this.gizmoSpace);
    this._notify();
  }

  togglePlacementGizmoSpace() {
    this.setPlacementGizmoSpace(this.gizmoSpace === "local" ? "world" : "local");
    return this.gizmoSpace;
  }

  /** "chain" (gizmo moves the whole chain) or "ghost" (gizmo moves the next piece). */
  get gizmoMode() {
    return this._gizmoTarget;
  }

  // ── BUILDING FROM EITHER END ───────────────────────────────────────────────
  // A chain is a linear array walked FORWARD from its anchor, so for a long time
  // the only place a piece could go was the tail. Growing the head is the same
  // walk run one step earlier: put the piece at the front of the array and move
  // the anchor back by exactly that piece's own transform, so its exit lands on
  // the old anchor and everything downstream is untouched.
  //
  // That works because a piece's exit is a fixed local transform of its entry —
  // `exit = entry · L`, with L a pure function of (id, params). Measured across
  // all 45 kit pieces at 6 random entry poses: worst elementwise drift 5.7e-14.
  // So the new anchor is exactly `oldHead · L⁻¹`, with no fitting or search.

  /**
   * `L` — a piece's entry→exit transform, in the entry's local frame.
   *
   * CACHED, because the only way to get it is to build the piece, and the ghost
   * asks for it on every drag frame while it is parked on a head. The cache key
   * is the params by value: `pieceParams` is a live object that the sliders
   * mutate in place, so a reference key would go stale silently.
   */
  _localTransform(id, pp, edges) {
    const key = `${id}|${edges ? 1 : 0}|${JSON.stringify(pp)}`;
    let L = this._localXfCache.get(key);
    if (!L) {
      L = buildPiece(id, _IDENTITY, pp, roadParams, guardrailParams, edges).connectorOut.clone();
      // Bounded: params change continuously while a slider is dragged, so this
      // would otherwise grow without limit over a session.
      if (this._localXfCache.size > 128) this._localXfCache.clear();
      this._localXfCache.set(key, L);
    }
    return L;
  }

  /**
   * Where a chain BEGINS, as a connector pointing into the chain.
   *
   * Not simply `chain.anchor`: if the first piece is DETACHED it ignores the
   * anchor and sits at its own `pinnedIn` (see rebuildAll), so that pin is the
   * real head. Prepending against the anchor there would leave the new piece
   * dangling in front of a piece that had already jumped elsewhere.
   */
  _chainHead(chainId) {
    const chain = this.chains.find((c) => c.id === chainId);
    if (!chain) return null;
    const first = this._chainPieces(chainId)[0];
    return first?.detached && first.pinnedIn ? first.pinnedIn : chain.anchor;
  }

  /**
   * Open ends: every chain's TAIL and HEAD, plus every junction branch nothing
   * has been built on. These are the places a piece can legally go, which is
   * exactly what the ghost's magnet wants.
   *
   * A head only counts as open when nothing is already joined to it — a chain
   * that starts on a junction branch, or head-to-tail against another chain, is
   * CONNECTED there, and offering to prepend would silently tear it off the
   * thing it was built onto. An empty chain has no head distinct from its tail,
   * so it publishes one entry, not two.
   */
  _openConnectors() {
    const out = [];
    const p = new THREE.Vector3();
    const q = new THREE.Vector3();
    const branches = this.branchConnectors();
    for (const chain of this.chains) {
      const last = this._lastPieceOfChain(chain.id);
      out.push({ chainId: chain.id, end: "tail", matrix: last ? last.connectorOut : chain.anchor });
      if (!last) continue; // empty chain: head IS the tail, already published
      const head = this._chainHead(chain.id);
      p.setFromMatrixPosition(head);
      const joined =
        branches.some((b) => b.pos.distanceTo(p) < HEAD_JOIN_EPS) ||
        this.chains.some((c) => {
          if (c.id === chain.id) return false;
          const l = this._lastPieceOfChain(c.id);
          return q.setFromMatrixPosition(l ? l.connectorOut : c.anchor).distanceTo(p) < HEAD_JOIN_EPS;
        });
      if (!joined) out.push({ chainId: chain.id, end: "head", matrix: head });
    }
    for (const b of branches) {
      if (!b.used) out.push({ chainId: null, end: "branch", matrix: b.matrix, branch: b });
    }
    return out;
  }

  // ── JUNCTIONS ──────────────────────────────────────────────────────────────
  // A junction is an ordinary chain piece — the chain flows in its entry and out
  // its exit like any other. What makes it a junction is the EXTRA sockets it
  // publishes (`built.branchesOut`), each of which is a valid start for a NEW
  // chain. That is the whole model: no piece ever has two successors, so the
  // linear chain walk in rebuildAll (and the snapshot history built on it) is
  // untouched — the side road is simply its own chain that happens to begin at
  // a branch. It saves and loads with no format change for the same reason.

  /**
   * Every branch socket on the track, flagged with whether a chain already
   * starts there. "Used" is decided by POSITION rather than by a stored link,
   * so it keeps working across a save/load, an undo, or a chain dragged off the
   * junction by hand — there is no bookkeeping to get out of step.
   */
  branchConnectors() {
    const out = [];
    const bp = new THREE.Vector3();
    const cp = new THREE.Vector3();
    for (const p of this.pieces) {
      for (const b of p.branches ?? []) {
        bp.setFromMatrixPosition(b.matrix);
        let used = false;
        for (const c of this.chains) {
          const ps = this._chainPieces(c.id);
          if (!ps.length) continue; // an empty chain claims nothing
          // EITHER END COUNTS. A branch is taken whether a road STARTS there
          // (its anchor lands on the socket) or ARRIVES there (its last exit
          // does) — which is exactly what a merge is, and what the link piece
          // builds. Testing only the anchor left a merge that a route had
          // already joined still advertising itself as free, arrow and all.
          if (cp.setFromMatrixPosition(c.anchor).distanceTo(bp) < HEAD_JOIN_EPS
            || cp.setFromMatrixPosition(ps[ps.length - 1].connectorOut).distanceTo(bp) < HEAD_JOIN_EPS) {
            used = true;
            break;
          }
        }
        out.push({ piece: p, label: b.label, matrix: b.matrix, pos: bp.clone(), used });
      }
    }
    return out;
  }

  /** How many branches are still free (status line / UI enablement). */
  get openBranchCount() {
    return this.branchConnectors().filter((b) => !b.used).length;
  }

  /** Park the next-piece ghost on a branch pose (full orientation — a junction
   *  on a banked chain hands its own tilt to the side road). */
  _putGhostOnBranch(matrix) {
    this._gizmoTarget = "ghost";
    this.ghostEnd = "tail"; // a branch starts a NEW chain — nothing to prepend to
    // DETACHED, deliberately: place() forks a new chain wherever a detached
    // ghost sits, which is precisely what starting a side road means.
    this.ghostDetached = true;
    this.ghostOnBranch = true;
    this._ghostPos.setFromMatrixPosition(matrix);
    _A_M.extractRotation(matrix);
    this._ghostQuat.setFromRotationMatrix(_A_M);
    this.freeYaw = this._ghostYaw = _A_E.setFromQuaternion(this._ghostQuat, "YXZ").y;
    if (this.placementGizmo) {
      this.placementPivot.position.copy(this._ghostPos);
      this.placementPivot.quaternion.copy(this._ghostQuat);
      this.placementGizmo.attach(this.placementPivot);
      this.placementGizmo.enabled = true;
      this.placementGizmo.visible = true;
      this._applyGizmoAxes();
    }
    this._refreshBranchMarkers();
    this.refreshGhost();
  }

  /**
   * Park the ghost on one open end — the single place that decides what
   * "snapped to the track" means. Shared by the gizmo's magnet and by pointing
   * at it with the mouse, so the two can never drift apart.
   */
  _snapGhostTo(oc) {
    if (oc.branch) {
      // A junction branch takes the ghost pose and all, and stays DETACHED, so
      // placing forks a new chain there.
      this._putGhostOnBranch(oc.matrix);
      return;
    }
    this.activeChainId = oc.chainId;
    this.ghostEnd = oc.end === "head" ? "head" : "tail";
    this._syncCurrentConnector();
    this.ghostDetached = false;
    const socket = this.ghostEnd === "head" ? this._chainHead(oc.chainId) : this.currentConnector;
    this._ghostPos.setFromMatrixPosition(socket);
    this._setGhostYaw(new THREE.Euler().setFromRotationMatrix(socket, "YXZ").y);
    if (this.placementGizmo?.visible) {
      this.placementPivot.position.copy(this._ghostPos);
      this.placementPivot.rotation.set(0, this._ghostYaw, 0);
    }
    this._refreshBranchMarkers(); // the white "you are aimed here" arrow moved
    this.refreshGhost();
  }

  /**
   * AIM BY POINTING AT THE TRACK — the interaction props have always had (their
   * ghost rides the cursor) and road pieces never did.
   *
   * Until this, the only way to move the next piece was to drag the placement
   * gizmo, which translates on the three WORLD axes and has nothing to do with
   * the road's direction, and then hope to land inside a 6 m magnet sphere — on
   * a kit whose pieces are 22–44 m long, with a grid step of 8 m that divides
   * none of them. It read as "free-fly the piece in 3D", not as snapping.
   *
   * So: hover within `AIM_PIXEL_RADIUS` of any open end (either end of any
   * chain, or a free junction branch) and the ghost goes there. Measuring in
   * SCREEN PIXELS rather than world metres is the point — a fixed world radius
   * is enormous zoomed in and unhittable zoomed out, while "near the thing I can
   * see" is the same gesture at every zoom.
   *
   * Nothing near the cursor leaves the ghost exactly where it is, so a piece you
   * deliberately free-placed is not stolen back by an idle mouse move, and the
   * gizmo remains the tool for putting a piece somewhere there is no track yet.
   *
   * @returns {boolean} true only when the aim actually MOVED — the caller uses
   *   that to refresh the status line without doing DOM work on every mousemove.
   */
  aimAtCursor(clientX, clientY) {
    if (!this._camera || !this._domElement) return false;
    if (!this.isBuildMode()) return false;
    // A live gizmo drag owns the ghost, and editing a placed piece is a
    // different mode entirely — neither wants the cursor second-guessing it.
    if (this._gizmoTarget === "piece" || this.isUsingPlacementGizmo()) return false;

    const rect = this._domElement.getBoundingClientRect();
    let best = null;
    for (const oc of this._openConnectors()) {
      _A_V.setFromMatrixPosition(oc.matrix).project(this._camera);
      if (_A_V.z > 1) continue; // behind the camera: the projection wraps around
      const sx = rect.left + (_A_V.x * 0.5 + 0.5) * rect.width;
      const sy = rect.top + (-_A_V.y * 0.5 + 0.5) * rect.height;
      const d = Math.hypot(sx - clientX, sy - clientY);
      if (d <= AIM_PIXEL_RADIUS && (!best || d < best.d)) best = { oc, d };
    }
    if (!best) return false;

    const key = `${best.oc.chainId}|${best.oc.end}|${
      best.oc.branch ? best.oc.branch.pos.toArray().join(",") : ""}`;
    if (key === this._lastAimKey) return false; // same end, nothing to redraw
    this._lastAimKey = key;
    this._snapGhostTo(best.oc);
    return true;
  }

  /**
   * Jump the ghost to the next unused branch (the K key / palette button).
   * Dragging the ghost onto a branch marker does the same thing; this is the
   * version that needs no aim.
   */
  snapGhostToNearestBranch() {
    const free = this.branchConnectors().filter((b) => !b.used);
    if (!free.length) return false;

    // IT CYCLES. It used to re-pick the branch nearest `currentConnector` every
    // time — and jumping to a branch does not move `currentConnector`, so
    // pressing K three times on a crossroads landed on the SAME arm three times
    // (measured). The second arm was unreachable from the keyboard until you had
    // built on the first one and it stopped counting as free.
    //
    // `branchConnectors()` walks pieces in placement order, so its order is
    // stable frame to frame, which is what makes stepping through it coherent.
    if (this.ghostOnBranch) {
      const at = free.findIndex((b) => b.pos.distanceTo(this._ghostPos) < HEAD_JOIN_EPS);
      if (at >= 0) {
        const next = free[(at + 1) % free.length];
        this._putGhostOnBranch(next.matrix);
        this._notify();
        return true;
      }
    }
    // Not on a branch yet: the nearest one to where you are building is the
    // right first answer.
    const from = new THREE.Vector3().setFromMatrixPosition(this.currentConnector);
    let best = free[0];
    for (const b of free) if (b.pos.distanceTo(from) < best.pos.distanceTo(from)) best = b;
    this._putGhostOnBranch(best.matrix);
    this._notify();
    return true;
  }

  /**
   * Which open end the next piece is currently aimed at, as a stable key.
   *
   * Read off the LIVE ghost state rather than remembered from the last aim, so
   * it stays right however the ghost got there — cursor, gizmo magnet, K, O,
   * chain cycling, or an undo restoring the cursor.
   */
  _aimedEndKey() {
    if (this._gizmoTarget !== "ghost") return null;
    if (this.ghostOnBranch) return `branch|${this._ghostPos.x.toFixed(2)},${this._ghostPos.z.toFixed(2)}`;
    if (this.ghostDetached) return null; // parked in free space, on no end at all
    return `${this.activeChainId}|${this.ghostEnd}`;
  }

  /** Key for one entry of `_openConnectors()`, in the same shape. */
  _endKey(oc) {
    if (oc.branch) return `branch|${oc.branch.pos.x.toFixed(2)},${oc.branch.pos.z.toFixed(2)}`;
    return `${oc.chainId}|${oc.end}`;
  }

  /**
   * A floating arrow on EVERY open end — both ends of every chain plus each
   * free junction branch — with the one you are aimed at picked out in white.
   *
   * This is what makes the cursor aim legible. Without it the next piece jumped
   * whenever the pointer strayed within 90 px of something invisible, which
   * reads as a glitch rather than as a tool.
   */
  _refreshBranchMarkers() {
    const g = this.branchMarkers;
    if (!g) return;
    const ends = this._openConnectors();
    const aimed = this._aimedEndKey();
    while (g.children.length > ends.length) {
      g.remove(g.children[g.children.length - 1]);
    }
    while (g.children.length < ends.length) {
      const m = new THREE.Mesh(this.branchMarkerGeo, this.endMarkerMats.branch);
      m.matrixAutoUpdate = false;
      m.frustumCulled = false;
      m.castShadow = m.receiveShadow = false;
      g.add(m);
    }
    for (let i = 0; i < ends.length; i++) {
      const oc = ends[i];
      const mesh = g.children[i];
      const isAimed = aimed !== null && this._endKey(oc) === aimed;
      const kind = oc.branch ? "branch" : oc.end === "head" ? "head" : "tail";
      mesh.material = isAimed ? this.endMarkerMats.aimed : this.endMarkerMats[kind];
      // The aimed arrow also draws over the road (depthTest off on its material),
      // so it stays findable when the camera is low and the deck is in the way.
      mesh.renderOrder = isAimed ? 998 : 0;
      mesh.matrix.copy(oc.matrix);
      // A HEAD faces into its chain; turn it round so the arrow points the way a
      // prepended piece would actually grow.
      if (!oc.branch && oc.end === "head") {
        mesh.matrix.multiply(_A_M.makeRotationY(Math.PI));
      }
      // The aimed arrow is bigger as well as brighter. Colour alone was not
      // enough to pick it out: the spawn marker is another pale arrow floating
      // over the deck, and at a glance the two read the same.
      if (isAimed) mesh.matrix.multiply(_A_M.makeScale(1.6, 1.6, 1.6));
    }
    g.visible = this.isBuildMode() && ends.length > 0;
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

  /** Set the ghost's heading from a yaw (the free-placement case — level). */
  _setGhostYaw(yaw) {
    this._ghostYaw = yaw;
    this._ghostQuat.setFromAxisAngle(_YUP, yaw);
    this.ghostOnBranch = false;
  }

  /** Connector matrix from the detached ghost pose. Yaw-only for free
   *  placement; the junction's full orientation when parked on a branch. */
  _anchorFromGhost() {
    _A_TRAVEL.set(0, 0, -1).applyQuaternion(this._ghostQuat);
    _A_UP.set(0, 1, 0).applyQuaternion(this._ghostQuat);
    return socketMatrix(this._ghostPos, _A_TRAVEL, _A_UP);
  }

  /**
   * Bind the gizmo to the next piece at the active chain's open end (the default
   * state after selecting or placing a piece). Empty chains keep the "chain"
   * anchor target instead — same pose, and dragging it is what N expects.
   */
  _syncGizmoToOpenEnd({ end } = {}) {
    // Default back to the tail — the caller has to ASK to stay on the head, so
    // that selecting a piece or switching chains cannot leave the ghost silently
    // prepending when the user expects to append.
    this.ghostEnd = end === "head" ? "head" : "tail";
    const last = this._lastPieceOfChain(this.activeChainId);
    if (!last) {
      this.ghostEnd = "tail"; // an empty chain has only the one end
      this._gizmoTarget = "chain";
      this.ghostDetached = false;
      this._showPlacementGizmo();
      return;
    }
    this._gizmoTarget = "ghost";
    this.ghostDetached = false;
    // The gizmo sits on the SOCKET at either end; on a head the piece previews
    // behind it (see _placementConnector).
    const socket = this.ghostEnd === "head"
      ? this._chainHead(this.activeChainId)
      : this.currentConnector;
    this._ghostPos.setFromMatrixPosition(socket);
    this._setGhostYaw(new THREE.Euler().setFromRotationMatrix(socket, "YXZ").y);
    this._showGizmoAt(this._ghostPos, this._ghostYaw);
    this._refreshBranchMarkers();
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
        this._snapDelta(_A_V);   // world = per-axis, local = along the drag
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
        // Snapping onto a chain end also picks WHICH END: drop the ghost on a
        // head and the next piece is prepended, on a tail and it is appended.
        // That is the whole "build from either end" gesture — no mode to switch.
        // Shared with the cursor aim so the two agree by construction.
        this._snapGhostTo(hit);
        this._lastAimKey = null; // a drag overrides where the cursor last aimed
        return; // ghost moves never touch placed geometry — no rebuild/rebake
      }
      this.ghostDetached = true;
      this.ghostEnd = "tail";
      // SNAP THE DELTA, NOT THE ABSOLUTE POSE — the same lesson `_applyGizmoSnap`
      // and `_onPieceGizmoChange` already learned for a SELECTED piece, which
      // this path never got.
      //
      // Rounding the absolute position is right while you are inventing a spot
      // out of nothing, and destructive the moment the ghost is somewhere it was
      // PUT: a landing pad seated on a computed ballistic point is never on a
      // grid cell, so one touch of the gizmo yanked it back onto the lattice and
      // away from where the car comes down. Snapping the movement keeps it put
      // and still moves in tidy steps.
      _A_V.copy(pos).sub(this._dragStartPos);
      this._snapDelta(_A_V);
      this._ghostPos.copy(this._dragStartPos).add(_A_V);
      this._setGhostYaw(this.snapYaw(this.placementPivot.rotation.y));
      this.placementPivot.position.copy(this._ghostPos);
      this.placementPivot.rotation.set(0, this._ghostYaw, 0);
      this._lastAimKey = null;
      this._refreshBranchMarkers(); // no end is aimed any more — drop the white one
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
        this._setGhostYaw(new THREE.Euler().setFromRotationMatrix(this.currentConnector, "YXZ").y);
      }
      // Turning the ghost by hand takes it off the branch it was parked on (it
      // no longer matches that socket), so this falls back to a level yaw.
      this._setGhostYaw(this._ghostYaw + delta);
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

  /**
   * The seam the next piece would be BUILT from — which is not the same as the
   * socket the ghost is parked on when prepending.
   *
   * Appending, the two coincide: the piece starts at the open end and grows
   * forward. Prepending, the piece has to END on the chain's head, so it starts
   * one piece-length back at `head · L⁻¹`. Previewing at the head itself would
   * draw a piece heading off in the wrong direction and — worse for a curve —
   * the wrong shape entirely, since the curve that ARRIVES at a seam is the
   * mirror of the one that leaves it.
   */
  _placementConnector() {
    if (this._gizmoTarget === "ghost" && this.ghostDetached) return this._anchorFromGhost();
    if (this._gizmoTarget === "ghost" && this.ghostEnd === "head") {
      const head = this._chainHead(this.activeChainId);
      if (head && this._chainPieces(this.activeChainId).length) {
        const L = this._localTransform(this.activePieceId, this.activeParams, guardrailParams.enabled);
        return head.clone().multiply(_A_M.copy(L).invert());
      }
    }
    return this.currentConnector;
  }

  /** Rebuild the translucent ghost at the open connector (or the detached pose). */
  refreshGhost() {
    const conn = this._placementConnector();
    const { geometry, world } = buildPiece(
      this.activePieceId,
      conn,
      this.activeParams,
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
    if (this.branchMarkers) this.branchMarkers.visible = on && this.branchMarkers.children.length > 0;
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
      for (const m of [p.mesh, p.railMesh, p.shellMesh, p.decorMesh, p.glassMesh]) {
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
      add(p.glassMesh, this.glassMaterial, "glass");
    }
    for (const grp of groups.values()) {
      const im = new THREE.InstancedMesh(grp.geometry, grp.material, grp.mats.length);
      for (let i = 0; i < grp.mats.length; i++) im.setMatrixAt(i, grp.mats[i]);
      im.instanceMatrix.needsUpdate = true;
      im.matrixAutoUpdate = false; // root/instGroup at origin → instance mats are world
      im.frustumCulled = false; // a track spans a large area; skip per-mesh culling
      // Neither flat markings nor a window should cast — see the note where the
      // per-piece glass mesh is born.
      im.castShadow = grp.role !== "decor" && grp.role !== "glass";
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
    // Deck collision proxy — only the half tubes have one (rim caps stripped).
    // Same three-birth-sites rule as the rail proxy below.
    mesh.userData.collisionGeometry = built.deckCollision ?? null;
    const railMesh =
      built.railGeometry && this.railMaterial
        ? this._makeMesh(built.railGeometry, this.railMaterial, built.world)
        : null;
    // The cheap stand-in the BVH bakes instead of the rail you can see — rides
    // along on the mesh so nothing downstream needs a new field to plumb.
    if (railMesh) railMesh.userData.collisionGeometry = built.railCollision ?? null;
    const shellMesh =
      built.shellGeometry && this.shellMaterial
        ? this._makeMesh(built.shellGeometry, this.shellMaterial, built.world)
        : null;
    const decorMesh =
      built.decorGeometry && this.decorMaterial
        ? this._makeMesh(built.decorGeometry, this.decorMaterial, built.world)
        : null;
    if (decorMesh) decorMesh.castShadow = false; // flat markings don't cast
    const glassMesh =
      built.glassGeometry && this.glassMaterial
        ? this._makeMesh(built.glassGeometry, this.glassMaterial, built.world)
        : null;
    // A transparent pane casting an opaque shadow would put a black square on
    // whatever is under the road — the exact opposite of what a window does.
    if (glassMesh) glassMesh.castShadow = false;

    const piece = {
      /** Stable identity across a history restore — array position is not one,
       *  because inserts and deletes renumber everything after them. */
      uid: ++_uidSeq,
      id,
      chainId,
      pp: { ...pp },
      edges,
      mesh,
      railMesh,
      shellMesh,
      decorMesh,
      glassMesh,
      connectorIn: connectorIn.clone(),
      connectorOut: built.connectorOut.clone(),
      /** Junction side sockets in WORLD space (empty for every other piece). */
      branches: built.branchesOut ?? [],
      /** Per-piece entry tilt (local-frame rotation, propagates downstream). */
      tilt: new THREE.Quaternion(),
      /** Entry seam BEFORE the tilt — filled by rebuildAll, used by the edit gizmo. */
      _baseIn: connectorIn.clone(),
      /** Free-placed? Then `pinnedIn` replaces the chain's running connector. */
      detached: false,
      /** @type {THREE.Matrix4|null} absolute entry seam while detached. */
      pinnedIn: null,
    };
    for (const m of [mesh, railMesh, shellMesh, decorMesh, glassMesh]) {
      if (m) m.userData.piece = piece;
    }
    this._applyPiecePresence(piece);
    // Record what this geometry was built FROM, exactly as rebuildAll does.
    // Without it a freshly placed piece looks un-built to the reuse check, so the
    // first restore after any placement rebuilds the whole track — measured as
    // undo costing 100–243 ms while redo, on identical data, cost 1 ms.
    piece._builtFrom = { conn: connectorIn.clone(), id, pp: piece.pp, edges };
    return piece;
  }

  /**
   * Sync the flags that live on the MESH rather than in the geometry: whether
   * this piece renders and whether it collides at all. They follow `p.id`, and
   * `rebuildAll`/`_applyBuilt` only ever swap geometry — so anything that
   * changes a piece's TYPE has to call this.
   *
   * Two callers, and the second is the one that was missing: `replacePiece`
   * (which had these lines inline) and `_restore`. Undoing a makeGap therefore
   * put `p.id` back to "straight" while the mesh kept noRender + noCollision +
   * the gap material — road you cannot see and fall straight through, saved to
   * the track file in that state.
   */
  _applyPiecePresence(p) {
    const gap = !!PIECE_BY_ID.get(p.id)?.noMesh;
    p.mesh.userData.pieceId = p.id;
    p.mesh.userData.noCollision = gap;
    p.mesh.userData.noRender = gap;   // gap spacer: no road, no instance/merge
    p.mesh.material = gap ? this.gapMaterial : this.material; // faint build marker
    p.mesh.visible = gap ? true : !this.instancingEnabled;
  }

  /**
   * Put the active piece IN FRONT of its chain: it becomes the new first piece,
   * and the anchor moves back by exactly this piece's own transform so the
   * piece's exit lands on the old head. Nothing downstream moves — this is the
   * whole point, and it is what `insertPieceBefore` on the first piece could
   * never do (that pins the head and shoves the entire track forward instead).
   */
  _prepend() {
    const chainId = this.activeChainId;
    const chain = this.chains.find((c) => c.id === chainId);
    const first = this._chainPieces(chainId)[0];
    if (!chain || !first) return null;

    const pp = this._snapshotParams();
    const edges = guardrailParams.enabled;
    const head = this._chainHead(chainId).clone();
    // entry = head · L⁻¹ ⇒ entry · L = head, i.e. the new piece ENDS on the old
    // head. Exact, not fitted: see the note above _localTransform.
    const entry = head.multiply(
      _A_M.copy(this._localTransform(this.activePieceId, pp, edges)).invert(),
    );

    const piece = this._makePieceEntry(this.activePieceId, chainId, entry, pp, edges);
    // The anchor is where rebuildAll STARTS the walk, so it has to become the new
    // piece's entry — even when the old first piece was detached and the head
    // came from its pin instead. The pinned piece still resets the running
    // connector to that pin, which is precisely where this piece now ends.
    chain.anchor = entry.clone();
    this.pieces.splice(this.pieces.indexOf(first), 0, piece);
    return piece;
  }

  /** Place the active piece — onto the open end (either end of the chain), or
   *  wherever the detached ghost sits (which starts a new chain there). */
  place() {
    // Record the aim BEFORE placing moves it — undo then returns the ghost to
    // the pose this piece was placed from, so pressing place again puts the
    // same piece back in the same spot.
    this._markCursor();
    // PREPEND: growing the chain backwards from its head. Everything else about
    // placement is unchanged, including the history step and the rebuild.
    // Gated on the GHOST target, not on `ghostEnd` alone: the "chain" target
    // (an empty chain, N, or a chain picked with [ / ]) means the gizmo is on
    // the anchor, and a stale `head` must not silently prepend there.
    if (this._gizmoTarget === "ghost" && !this.ghostDetached && this.ghostEnd === "head") {
      const piece = this._prepend();
      if (piece) {
        this.rebuildAll();
        this._refreshBranchMarkers();
        this._syncGizmoToOpenEnd({ end: "head" }); // stay on the head, ready for the next
        this.refreshGhost();
        this._commit();
        this._notify();
        return piece.mesh;
      }
      this.ghostEnd = "tail"; // empty chain: nothing to prepend to, so append
    }
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
    this.ghostOnBranch = false; // the branch (if that's where this went) is taken
    this._rebuildInstances();
    this._refreshBranchMarkers();
    // Hand the gizmo to the NEXT piece at the fresh open end.
    this._syncGizmoToOpenEnd();
    this.refreshGhost();
    this._commit();
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
    this._markCursor(); // this moves the append target; undo has to move it back
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
    this._commit();
    return true;
  }

  /** Swap a placed piece's TYPE in place (keeps its slot in the chain); the rest
   *  of the chain re-flows from the new piece's exit. */
  replacePiece(p, newId, pp = this._snapshotParams()) {
    if (this.pieces.indexOf(p) < 0 || !PIECE_BY_ID.has(newId)) return false;
    this._markCursor();
    p.id = newId;
    p.pp = { ...pp };
    // A piece can gain/lose its render+collision presence across the swap (e.g.
    // to/from a gap) — rebuildAll only replaces geometry, not these flags.
    this._applyPiecePresence(p);
    this.rebuildAll();
    this._updateSelectionHighlight();
    this._commit();
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
    this._commit();
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
    return this.replacePiece(p, "gap", pp); // replacePiece commits
  }

  /** Turn this piece's guardrails/kerbs on or off — PER PIECE, independent of
   *  the palette's global "new pieces get edges" default. */
  setPieceEdges(p, on) {
    if (this.pieces.indexOf(p) < 0) return false;
    p.edges = !!on;
    this.rebuildAll();
    if (this.selectedPiece === p) this._updateSelectionHighlight();
    this._commit();
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
    this._commit();
    return true;
  }

  /** Re-join the chain: snap back onto the previous piece's exit. */
  attachPiece(p) {
    if (this.pieces.indexOf(p) < 0 || !p.detached) return false;
    p.detached = false;
    p.pinnedIn = null;
    this.rebuildAll();
    if (this.selectedPiece === p) this._updateSelectionHighlight();
    this._commit();
    return true;
  }

  /** Reset a piece's tilt to none (downstream re-levels from here). */
  levelPiece(p) {
    if (this.pieces.indexOf(p) < 0) return false;
    p.tilt.identity();
    this.rebuildAll();
    if (this.selectedPiece === p) this._updateSelectionHighlight();
    this._commit();
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
    this._markCursor();
    // rebuildAll re-derives the transform from the chain walk, so p.connectorIn
    // here is only a placeholder for the initial build.
    const entry = this._makePieceEntry(newId, p.chainId, p.connectorIn, pp, guardrailParams.enabled);
    this.pieces.splice(idx, 0, entry);
    this.activeChainId = p.chainId;
    this.rebuildAll();
    this.selectPiece(entry);
    this._commit();
    return true;
  }

  _removePiece(p) {
    this.root.remove(p.mesh);
    p.mesh.geometry.dispose();
    p.mesh.userData.collisionGeometry?.dispose();
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
    if (p.glassMesh) {
      this.root.remove(p.glassMesh);
      p.glassMesh.geometry.dispose();
    }
  }

  // ══ HISTORY ════════════════════════════════════════════════════════════════
  //
  // SNAPSHOT/RESTORE, NOT COMMAND/INVERSE. Every edit here already funnels
  // through `rebuildAll`, which DERIVES each piece's entry seam by walking its
  // chain from the anchor — so a piece's geometry is a pure function of a small
  // structural record (order, id, chain, params, edges, tilt, detached pin) plus
  // the chain anchors. Capturing that record captures everything, including
  // operations added later, with no inverse to write and none to get wrong.
  //
  // The usual objection to snapshots is cost, and it does not apply once the
  // record holds no geometry: an undo step is a few hundred bytes, and restoring
  // one rebuilds only the pieces that actually differ (see `reuse` above), which
  // for a normal edit is one.

  /**
   * WHERE THE USER IS, as opposed to what the track is: the placement gizmo's
   * target, the ghost's pose, the free anchor, and which chain new pieces append
   * to. None of it is geometry, and all of it decides where the NEXT piece goes.
   *
   * It rides in the snapshot but is NOT part of `_sameStructure`, which gives
   * the two behaviours you want out of one mechanism:
   *  • moving the ghost is not an edit, so it never adds an undo step;
   *  • undoing an edit puts the cursor back where it was when you made it, so
   *    pressing place again rebuilds the SAME piece in the SAME spot.
   * Without it, `_restore` fell through to `_syncGizmoToOpenEnd()` and threw the
   * ghost onto whatever chain happened to be active — so the piece you undid
   * came back somewhere else entirely.
   */
  _cursor() {
    return {
      activeChainId: this.activeChainId,
      freePlaceMode: this.freePlaceMode,
      gizmoTarget: this._gizmoTarget,
      ghostDetached: this.ghostDetached,
      ghostOnBranch: this.ghostOnBranch,
      ghostEnd: this.ghostEnd,
      ghostPos: this._ghostPos.clone(),
      ghostQuat: this._ghostQuat.clone(),
      freePos: this._freePos.clone(),
      freeQuat: this._freeQuat.clone(),
    };
  }

  _applyCursor(c) {
    if (!c) return;
    // The chain may have been deleted by the state we are restoring INTO (undo
    // of a free placement drops the chain it created), so never trust the id.
    this.activeChainId = this.chains.some((ch) => ch.id === c.activeChainId)
      ? c.activeChainId
      : (this.chains.at(-1)?.id ?? 0);
    this.freePlaceMode = c.freePlaceMode;
    this._gizmoTarget = c.gizmoTarget;
    this.ghostDetached = c.ghostDetached;
    this.ghostOnBranch = c.ghostOnBranch;
    this.ghostEnd = c.ghostEnd ?? "tail";
    this._ghostPos.copy(c.ghostPos);
    this._ghostQuat.copy(c.ghostQuat);
    this._ghostYaw = _A_E.setFromQuaternion(this._ghostQuat, "YXZ").y;
    this._freePos.copy(c.freePos);
    this._freeQuat.copy(c.freeQuat);
    this.freeYaw = _A_E.setFromQuaternion(this._freeQuat, "YXZ").y;
  }

  /** Re-seat the placement gizmo on the cursor we just restored. The plain
   *  `_syncGizmoToOpenEnd()` cannot do this: it means "forget where you were
   *  and go to the chain end", which is the bug this exists to avoid. */
  _showGizmoForCursor() {
    if (this._gizmoTarget === "ghost" && this.ghostDetached) {
      this._showGizmoAt(this._ghostPos, this._ghostYaw);
      this.refreshGhost();
    } else if (this._gizmoTarget === "chain") {
      this._showPlacementGizmo();
      this.refreshGhost();
    } else {
      // Attached ghost (or a "piece" target whose selection is gone): the open
      // end IS the right answer, and it just moved. `ghostEnd` came back with
      // the cursor, so an undo lands you on the end you were building from.
      this._syncGizmoToOpenEnd({ end: this.ghostEnd });
    }
  }

  /** True when two snapshots describe the same TRACK — cursor ignored. Used to
   *  keep cursor-only commits (every gizmo drag-end fires one) off the stack. */
  _sameStructure(a, b) {
    if (!a || !b) return false;
    if (a.chainSeq !== b.chainSeq) return false;
    if (a.chains.length !== b.chains.length) return false;
    if (a.pieces.length !== b.pieces.length) return false;
    for (let i = 0; i < a.chains.length; i++) {
      if (a.chains[i].id !== b.chains[i].id) return false;
      if (!a.chains[i].anchor.equals(b.chains[i].anchor)) return false;
    }
    for (let i = 0; i < a.pieces.length; i++) {
      const x = a.pieces[i], y = b.pieces[i];
      // `pp` by reference, exactly as the rebuild's reuse check compares it —
      // params are cloned once at placement and never mutated in place.
      if (x.uid !== y.uid || x.id !== y.id || x.chainId !== y.chainId
        || x.edges !== y.edges || x.pp !== y.pp || x.detached !== y.detached) return false;
      if (!x.tilt.equals(y.tilt)) return false;
      if (!!x.pinnedIn !== !!y.pinnedIn) return false;
      if (x.pinnedIn && !x.pinnedIn.equals(y.pinnedIn)) return false;
    }
    return true;
  }

  /** Structural state — everything `rebuildAll` needs, and nothing derived. */
  _snapshot() {
    return {
      cursor: this._cursor(),
      // Restored too: `clear()` resets it to 1, so without this an undo of Clear
      // brought back chains 1..n while the next new chain was handed id 1 again,
      // and two chains sharing an id silently merge.
      chainSeq: this.chainSeq,
      chains: this.chains.map((c) => ({ id: c.id, anchor: c.anchor.clone() })),
      // `pp` by reference: cloned once at placement, never mutated, so sharing it
      // is safe and keeps a snapshot to a few hundred bytes instead of 50 numbers
      // per piece.
      pieces: this.pieces.map((p) => ({
        uid: p.uid, id: p.id, chainId: p.chainId, edges: p.edges ?? true, pp: p.pp,
        tilt: p.tilt.clone(),
        detached: !!p.detached,
        pinnedIn: p.pinnedIn ? p.pinnedIn.clone() : null,
      })),
    };
  }

  /** Put the track back into a snapshotted state, rebuilding only what moved. */
  _restore(snap) {
    const byUid = new Map(this.pieces.map((p) => [p.uid, p]));
    const keep = new Set(snap.pieces.map((e) => e.uid));
    for (const p of this.pieces) if (!keep.has(p.uid)) this._removePiece(p);

    this.chains = snap.chains.map((c) => ({ id: c.id, anchor: c.anchor.clone() }));
    this.chainSeq = snap.chainSeq ?? this.chainSeq;
    this._applyCursor(snap.cursor);
    this.pieces = snap.pieces.map((e) => {
      let p = byUid.get(e.uid);
      if (!p) {
        // Gone from the scene (an undone delete): rebuild it. The entry seam is
        // recomputed by rebuildAll, so any matrix will do to construct it.
        p = this._makePieceEntry(e.id, e.chainId, new THREE.Matrix4(), e.pp, e.edges);
        p.uid = e.uid;
      }
      p.id = e.id; p.chainId = e.chainId; p.edges = e.edges; p.pp = e.pp;
      p.tilt.copy(e.tilt);
      p.detached = e.detached;
      p.pinnedIn = e.pinnedIn ? e.pinnedIn.clone() : null;
      // The id may have changed under us (undo of a replace / makeGap), and the
      // render + collision flags follow the id, not the geometry.
      this._applyPiecePresence(p);
      return p;
    });

    if (this.selectedPiece && !keep.has(this.selectedPiece.uid)) this.deselectPiece();
    this.rebuildAll({ reuse: true });
    // rebuildAll re-derives `currentConnector` from the restored active chain and
    // may have dragged an ATTACHED ghost with it, so put the cursor back last.
    this._applyCursor(snap.cursor);
    this._showGizmoForCursor();
  }

  /**
   * Record the state as of the last commit and start a new one. Call at the END
   * of a user-visible edit — never inside one, or a single action lands on the
   * stack in pieces and Ctrl+Z only half-undoes it.
   */
  _commit() {
    if (this._histSuspend) return;
    const now = this._snapshot();
    // CURSOR-ONLY CHANGE ⇒ NOT AN EDIT. Every gizmo drag-end commits, and most
    // drags only move the ghost — which used to push a snapshot identical to the
    // baseline, so Ctrl+Z spent step after step appearing to do nothing at all.
    // Fold it into the baseline instead: the cursor recorded there is now the
    // one the user was at, and the next REAL edit carries it onto the stack.
    if (this._sameStructure(this._baseline, now)) {
      if (this._baseline) this._baseline.cursor = now.cursor;
      return;
    }
    if (this._baseline) {
      this._undoStack.push(this._baseline);
      if (this._undoStack.length > HISTORY_LIMIT) this._undoStack.shift();
    }
    this._baseline = now;
    this._redoStack.length = 0; // a new edit forks the timeline
  }

  /**
   * Stamp the CURRENT cursor onto the outgoing baseline. Call at the top of any
   * edit that moves the cursor as a side effect (placing hands the ghost to the
   * next open end), so the undo step records where you were when you acted
   * rather than where the edit left you.
   */
  _markCursor() {
    if (!this._histSuspend && this._baseline) this._baseline.cursor = this._cursor();
  }

  /** Drop the history — for a load/import, where "undo" across the boundary
   *  would restore pieces from a track the user is no longer editing. */
  resetHistory() {
    this._undoStack.length = 0;
    this._redoStack.length = 0;
    this._baseline = this._snapshot();
  }

  /** Run `fn` as ONE history entry, however many edits it makes internally. */
  _asOneEdit(fn) {
    const outer = this._histSuspend;
    this._histSuspend = true;
    try { fn(); } finally { this._histSuspend = outer; }
    this._commit();
  }

  canUndo() { return this._undoStack.length > 0; }
  canRedo() { return this._redoStack.length > 0; }

  undo() {
    if (!this._undoStack.length) return false;
    this._redoStack.push(this._baseline ?? this._snapshot());
    const snap = this._undoStack.pop();
    this._restore(snap);
    this._baseline = snap;
    this._notify();
    return true;
  }

  redo() {
    if (!this._redoStack.length) return false;
    this._undoStack.push(this._baseline ?? this._snapshot());
    const snap = this._redoStack.pop();
    this._restore(snap);
    this._baseline = snap;
    this._notify();
    return true;
  }

  clear() {
    this._markCursor();
    this.selectedPiece = null;
    this._updateSelectionHighlight();
    for (const p of this.pieces) this._removePiece(p);
    this.pieces = [];
    this._rebuildInstances();
    this._refreshBranchMarkers();
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
    this._commit();
    this._notify();
  }

  /**
   * Rebuild every chain from its anchor: pieces are re-chained sequentially
   * (each piece's entry = the previous piece's exit), so moving a chain anchor
   * or editing a piece flows correctly down the rest of that chain.
   */
  /**
   * Re-walk every chain and rebuild the pieces from it.
   *
   * `reuse` skips the buildPiece call for any piece whose INPUTS are unchanged
   * (entry seam, id, params, edges) and keeps the geometry it already has. That
   * is what makes undo/redo instant: restoring a snapshot usually differs by one
   * piece, and rebuilding all of them costs 150 ms on a 300-piece track and
   * 480 ms if it is full of loops and tubes — measured, and far too slow to sit
   * behind Ctrl+Z.
   *
   * OFF BY DEFAULT, deliberately. The signature cannot see `roadParams` or
   * `guardrailParams`, so a plain `rebuildAll()` — which is what every width,
   * kerb and rail slider calls — must still rebuild unconditionally or the track
   * would silently ignore them. Only callers that know nothing global changed
   * pass `reuse`.
   */
  rebuildAll({ reuse = false } = {}) {
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
        // Unchanged inputs ⇒ the geometry it already carries is still correct.
        // `pp` is compared by REFERENCE, which is sound because a piece's params
        // are cloned once at placement and never mutated afterwards.
        const b = p._builtFrom;
        if (reuse && b && b.id === p.id && b.edges === edges && b.pp === p.pp
          && b.conn.equals(conn)) {
          conn = p.connectorOut.clone();
          continue;
        }
        const built = buildPiece(p.id, conn, p.pp, roadParams, guardrailParams, edges);
        this._applyBuilt(p, built);
        p.connectorOut = built.connectorOut.clone();
        p._builtFrom = { conn: conn.clone(), id: p.id, pp: p.pp, edges };
        conn = built.connectorOut.clone();
      }
    }
    this._rebuildInstances();
    this._syncCurrentConnector();
    // A rebuild moves the open end; if the gizmo is riding the (attached)
    // ghost, keep it glued to the new end — the SAME end, head or tail.
    if (this._gizmoTarget === "ghost" && !this.ghostDetached && this.placementGizmo?.visible) {
      this._syncGizmoToOpenEnd({ end: this.ghostEnd });
    }
    // The selected piece may have moved (an anchor drag or an upstream edit flows
    // down the chain), so keep its highlight glued to it.
    if (this.selectedPiece) this._updateSelectionHighlight();
    this._refreshBranchMarkers();
    this.refreshGhost();
    this._notify();
  }

  /** Update a placed piece's meshes from a freshly built result. */
  _applyBuilt(p, built) {
    p.mesh.geometry.dispose();
    p.mesh.geometry = built.geometry;
    p.mesh.matrix.copy(built.world);
    p.mesh.userData.collisionGeometry?.dispose();
    p.mesh.userData.collisionGeometry = built.deckCollision ?? null;
    // Branch sockets are world matrices, so they move with the piece.
    p.branches = built.branchesOut ?? [];

    if (built.railGeometry && this.railMaterial) {
      if (p.railMesh) {
        p.railMesh.geometry.dispose();
        p.railMesh.geometry = built.railGeometry;
        p.railMesh.matrix.copy(built.world);
      } else {
        p.railMesh = this._makeMesh(built.railGeometry, this.railMaterial, built.world);
      }
      p.railMesh.userData.collisionGeometry?.dispose();
      p.railMesh.userData.collisionGeometry = built.railCollision ?? null;
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

    if (built.glassGeometry && this.glassMaterial) {
      if (p.glassMesh) {
        p.glassMesh.geometry.dispose();
        p.glassMesh.geometry = built.glassGeometry;
        p.glassMesh.matrix.copy(built.world);
      } else {
        p.glassMesh = this._makeMesh(built.glassGeometry, this.glassMaterial, built.world);
        p.glassMesh.castShadow = false;
      }
    } else if (p.glassMesh) {
      this.root.remove(p.glassMesh);
      p.glassMesh.geometry.dispose();
      p.glassMesh = null;
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
      // THROUGH _makePieceEntry, NOT A HAND-BUILT LITERAL. This used to assemble
      // the piece record inline — the same forty lines as _makePieceEntry, kept in
      // step by hand — and it had silently fallen behind on the two fields that
      // are not geometry: `uid` and `_builtFrom`.
      //
      // A missing uid is not cosmetic. _restore keys the entire rebuild off it
      // (`byUid.get(e.uid)`), so with every loaded piece at `undefined` one undo
      // mapped all 41 slots of rushline onto ONE piece object: the track came back
      // scrambled, and 40 of the 41 meshes vanished from pickPiece's raycast set,
      // which is why right-click stopped selecting anything. It only ever affected
      // tracks loaded from disk, so the history tests — which build with place() —
      // never saw it.
      const piece = this._makePieceEntry(e.id, e.chainId ?? 0, connectorIn, e.pp, e.edges ?? true);
      // Saved absolute pin for a free-placed piece; the tilt recovery below reads
      // it, and rebuildAll uses it in place of the running connector.
      piece.detached = !!e.detached;
      piece.pinnedIn = Array.isArray(e.pinnedIn) && e.pinnedIn.length === 16
        ? new THREE.Matrix4().fromArray(e.pinnedIn)
        : null;
      this.pieces.push(piece);
    }
    this._rebuildInstances();
    this._refreshBranchMarkers();
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
    this.resetHistory(); // a load is not an edit — see resetHistory()
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
   * @param {{ startPos?: THREE.Vector3, yaw?: number, refSpeed?: number,
   *           dragK?: number }} [opts]
   *        `startPos` seats the anchor in the sky (terrain + buildHeight from the
   *        game). Without it the track starts at the origin like the old demo.
   *        `refSpeed` is the approach speed the jump landing is sized for —
   *        keep it BELOW top speed; after a climb you rarely arrive at 40+.
   *        `dragK` is AERO.drag / CHASSIS.mass; the game passes it so the demo's
   *        landing platform sits where the red arc says it will (0 = vacuum).
   */
  loadDemo(opts = {}) {
    this.clear();
    // 28 m/s ≈ 100 km/h: reachable after the climb. A long platform then covers
    // overshoot up to ~40 m/s so a hot approach still lands on deck.
    const { startPos = null, yaw = 0, refSpeed = 28, dragK = 0 } = opts;
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

    // Each piece resolves from the KIT DEFAULTS plus its own overrides, so a
    // demo track builds the same shape no matter what the palette was set to
    // when you pressed the button. (It used to layer overrides onto the live
    // shared params, which meant the demo inherited your last tile click.)
    const saved = { ...this.activeParams };
    const put = (id, overrides = {}) => {
      this.activeParams = { ...PIECE_DEFAULTS, ...overrides };
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
    const landNear = _ballisticLanding(this.currentConnector, refSpeed, 9.81, 0, dragK);
    const landFar = _ballisticLanding(this.currentConnector, Math.max(refSpeed + 12, 40), 9.81, 0, dragK);
    if (landNear) {
      // `exact` for the reason this used to toggle snapEnabled by hand: the grid
      // would nudge a computed ballistic point off the place the car lands.
      this.beginNewChain(landNear.pos, landNear.yaw, { exact: true });
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

    this.activeParams = saved;
    this.activePieceId = PIECE_CATALOG[0].id;
    this.deselectPlacement?.();
    this.refreshGhost();
    this.resetHistory(); // a load is not an edit — see resetHistory()
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

    // Each piece resolves from the KIT DEFAULTS plus its own overrides, so a
    // demo track builds the same shape no matter what the palette was set to
    // when you pressed the button. (It used to layer overrides onto the live
    // shared params, which meant the demo inherited your last tile click.)
    const saved = { ...this.activeParams };
    const put = (id, overrides = {}) => {
      this.activeParams = { ...PIECE_DEFAULTS, ...overrides };
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

    this.activeParams = saved;
    this.activePieceId = PIECE_CATALOG[0].id;
    this.deselectPlacement?.();
    this.refreshGhost();
    this.resetHistory(); // a load is not an edit — see resetHistory()
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
    this.branchMarkers?.clear();
    this.branchMarkerGeo?.dispose();
    for (const m of Object.values(this.endMarkerMats ?? {})) m.dispose();
    this.scene.remove(this.root);
  }
}

/**
 * TrackMania-style palette categories. Tiles are baked 3D thumbnails — see
 * modularRoadThumbnails.js — with placeholderSvg() standing in only when a bake
 * has not happened or has failed.
 */
const PIECE_TO_CATEGORY = {
  straight: "straight",
  platform: "straight",
  narrow: "straight",
  holed: "straight",
  glass_road: "straight",
  tunnel: "tubes",
  tunnel_curve: "tubes",
  tube: "tubes",
  tube_curve: "tubes",
  half_tube: "tubes",
  half_tube_curve: "tubes",
  half_pipe: "tubes",
  half_pipe_curve: "tubes",
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
  junction_split: "junctions",
  junction_merge: "junctions",
  junction_y: "junctions",
  junction_t: "junctions",
  junction_cross: "junctions",
  junction_roundabout: "junctions",
};

export const PALETTE_CATEGORIES = [
  { id: "straight", label: "Straight" },
  { id: "turns", label: "Turns" },
  { id: "junctions", label: "Junctions" },
  { id: "game", label: "Game" },
  { id: "ramps", label: "Ramps" },
  { id: "slopes", label: "Slopes" },
  { id: "banked", label: "Banked" },
  { id: "tubes", label: "Tubes" },
  { id: "obstacles", label: "Obstacles" },
  { id: "scenery", label: "Scenery" },
  { id: "moving", label: "Moving" },
  { id: "portals", label: "Portals" },
  { id: "loop", label: "Loop" },
];

/**
 * The one placeholder a tile shows when it has no baked thumbnail.
 *
 * There used to be ~130 hand-drawn SVGs here — a bespoke silhouette per piece,
 * per preset and per category. Every one of them was dead art: with the bake
 * cached, all 135 tiles the palette can show come up as sprites, so the
 * drawings were only ever on screen for the ~1.5 s of a cold bake, and the
 * real cost was that adding a piece meant drawing one more of them (which
 * nobody would ever check against what the piece actually builds).
 *
 * What is left is the thing that mattered: if the bake FAILS the palette still
 * has to be usable, and a tile with a plate and its name under it is that. The
 * label was always there — see .piece-tile-name.
 */
function placeholderSvg() {
  return `<svg viewBox="0 0 80 80" aria-hidden="true">
    <rect x="14" y="30" width="52" height="20" rx="3"
          fill="#2a2e36" stroke="#4a515c" stroke-width="1.6"/>
    <line x1="20" y1="40" x2="60" y2="40"
          stroke="#5c6470" stroke-width="2" stroke-dasharray="6 5"/>
  </svg>`;
}

/**
 * Curated "kit" presets — premade pieces (TrackMania-style) layered over the
 * parametric generator. Each preset is a named snapshot of pieceParams on a base
 * piece (the generator stays the authoring tool). Identical presets place the
 * same local geometry, so they're instancing-friendly later. Categories listed
 * here render presets instead of raw parametric pieces; categories absent here
 * fall back to the raw PIECE_CATALOG (converted step by step).
 *
 * A preset needs no artwork: its palette tile is a render of the piece these
 * params actually build, baked by modularRoadThumbnails.js off `base` + `params`.
 * @type {Record<string, {id:string,label:string,base:string,params:object}[]>}
 */
export const CATEGORY_PRESETS = {
  // The Apex-Rush Banks palette: Up/Down transitions curl the deck up from the
  // plane, Straight/Turn tiles HOLD the lean. Level sockets keep every piece
  // upright wherever it's dropped.
  //
  // SIZED LONG ON PURPOSE. The Up/Down tiles were 18 m, which is 18 m to roll
  // the deck 22° AND lift its edge 0.8 m — the transition arrived and was over
  // before it read as one, and it looked like a corner had been folded rather
  // than banked. A bank is a shape you see develop; at 40 m the roll rate more
  // than halves and the curl has room to grow. The turns are opened out for the
  // same reason: a banked sweeper is a long piece, and a tight one just reads
  // as a tipped-over curve.
  banked: [
    {
      id: "bank_up_right",
      label: "Up Right",
      base: "bankin",
      params: { bankRampLength: 44, bankAngle: 22, curveDir: 1 },
    },
    {
      id: "bank_up_left",
      label: "Up Left",
      base: "bankin",
      params: { bankRampLength: 44, bankAngle: 22, curveDir: -1 },
    },
    {
      id: "bank_straight_right",
      label: "Straight Right",
      base: "banktilt",
      params: { straightLength: 32, bankAngle: 22, curveDir: 1 },
    },
    {
      id: "bank_straight_left",
      label: "Straight Left",
      base: "banktilt",
      params: { straightLength: 32, bankAngle: 22, curveDir: -1 },
    },
    {
      id: "bank_road_tilted",
      label: "Road Tilted",
      base: "banktilt",
      params: { straightLength: 32, bankAngle: 35, curveDir: 1 },
    },
    {
      id: "bank_down_right",
      label: "Down Right",
      base: "bankout",
      params: { bankRampLength: 44, bankAngle: 22, curveDir: 1 },
    },
    {
      id: "bank_down_left",
      label: "Down Left",
      base: "bankout",
      params: { bankRampLength: 44, bankAngle: 22, curveDir: -1 },
    },
    {
      id: "bank_short_turn",
      label: "Short Turn",
      base: "banked",
      params: { curveRadius: 34, curveAngle: 60, bankAngle: 22, curveDir: 1 },
    },
    {
      id: "bank_long_turn",
      label: "Long Turn",
      base: "banked",
      params: { curveRadius: 58, curveAngle: 90, bankAngle: 22, curveDir: 1 },
    },
    {
      id: "wall_ride_right",
      label: "Wall Ride R",
      base: "wallride",
      params: { wallRideLength: 70, wallAngle: 70, wallRamp: 0.38, curveDir: 1 },
    },
    {
      id: "wall_ride_left",
      label: "Wall Ride L",
      base: "wallride",
      params: { wallRideLength: 70, wallAngle: 70, wallRamp: 0.38, curveDir: -1 },
    },
  ],
  tubes: [
    {
      id: "tube_str",
      label: "Tube",
      base: "tube",
      params: { straightLength: 26, tubeRadius: 8, tubeWall: 0.6 },
    },
    {
      id: "tube_long",
      label: "Tube Long",
      base: "tube",
      params: { straightLength: 44, tubeRadius: 8, tubeWall: 0.6 },
    },
    {
      id: "tube_turn",
      label: "Tube Turn",
      base: "tube_curve",
      params: { curveRadius: 26, curveAngle: 90, curveDir: 1, tubeRadius: 8, tubeWall: 0.6 },
    },
    {
      id: "half_tube_str",
      label: "Half Tube",
      base: "half_tube",
      params: { straightLength: 26, tubeRadius: 8, tubeWall: 0.6, halfTubeSpan: 180 },
    },
    {
      id: "half_tube_long",
      label: "Half Tube Long",
      base: "half_tube",
      params: { straightLength: 44, tubeRadius: 8, tubeWall: 0.6, halfTubeSpan: 180 },
    },
    {
      id: "half_tube_turn",
      label: "Half Tube Turn",
      base: "half_tube_curve",
      params: { curveRadius: 26, curveAngle: 90, curveDir: 1, tubeRadius: 8, tubeWall: 0.6, halfTubeSpan: 180 },
    },
    {
      id: "half_tube_deep",
      label: "Deep Half Tube",
      base: "half_tube",
      params: { straightLength: 26, tubeRadius: 8, tubeWall: 0.6, halfTubeSpan: 240 },
    },
    {
      // THE SNOWBOARD PIPE. Same piece as the half tubes above — this is not a
      // new shape, it is the only SCALE at which the shape behaves like a pipe.
      //
      // What makes a pipe different from a quarter-pipe is that you ride ALONG
      // it and carve UP it, so only the sideways part of your speed becomes
      // height; the speed down the pipe is kept. That is why a pipe gives 1–2 s
      // pops at any speed while a bowl gives one 6 s rocket — and why it needs a
      // wall the car can only just reach. At the stock tubeRadius of 8 the wall
      // is 8 m, a car carving into it has 60+ m of climb in hand, and it simply
      // leaves: MEASURED at R=8, the car escaped the pipe at every speed and
      // every steering input tried.
      //
      // A PIPE IS NOT AN ARC, and that is the whole reason this uses half_pipe
      // rather than the half tube next to it. On a bare arc the only vertical
      // point is the very top, so where you leave it decides where you go — and
      // the first version of this preset was a 200° half tube, which curls the
      // rim back over you so you leave moving INWARD. MEASURED, launch x against
      // landing x on a 26 m pipe: leaves at +25.4, lands at -21.4. It threw the
      // car clean across the pipe to the far wall, which is what got reported:
      // "the car falls back at the centre, it should fall on the slope."
      //
      // With a VERT — the wall carrying on straight up above the transition —
      // sideways velocity is zero for the whole last stretch, so the car leaves
      // going straight up and drops back onto the wall it left: leaves at -31.1,
      // lands at -30.6. Same wall, just under the lip, on the transition. That is
      // what a snowboarder does, and it is why real pipes have vert.
      //
      // THE VERT HEIGHT IS ALSO THE HEIGHT CONTROL, because the flight only
      // starts at the lip. The car arrives with a fixed amount of climb in it
      // (it apexes at 47–52 m however the pipe is built), so raising the lip
      // eats the difference. MEASURED at Rt=26, apex over the lip / air time:
      //
      //     vert  4    +17.7 to +21.4 m    4.2–4.7 s
      //     vert 12    +9.8 to +13.4 m     2.7–4.0 s
      //     vert 17    +4.3 to +9.3 m      1.4–2.4 s   <- this preset
      //     vert 20    +3.8 to +5.4 m      1.2–1.7 s, but 28 m/s can't reach it
      //
      // Held over a 12-run grid of 28/34/40 m/s against carves from 0.3 to 0.9:
      // 10 of 12 land back on the same wall at the lip. The two that do not are
      // both the shallowest carve, and that is authentic rather than a defect —
      // going up at a lazy angle is a wall-ride, not a pipe hit, and it fires you
      // out over the deck on snow too. Turn INTO the wall.
      id: "half_pipe_park",
      label: "Park Pipe",
      base: "half_pipe",
      params: { straightLength: 60, tubeRadius: 26, tubeWall: 0.6, halfPipeFlat: 12, halfPipeVert: 17 },
    },
    {
      id: "half_pipe_park_long",
      label: "Park Pipe Long",
      base: "half_pipe",
      params: { straightLength: 110, tubeRadius: 26, tubeWall: 0.6, halfPipeFlat: 12, halfPipeVert: 17 },
    },
    {
      id: "half_pipe_park_turn",
      label: "Park Pipe Turn",
      base: "half_pipe_curve",
      params: { curveRadius: 60, curveAngle: 60, curveDir: 1, tubeRadius: 26, tubeWall: 0.6, halfPipeFlat: 12, halfPipeVert: 17 },
    },
    {
      id: "tunnel_str",
      label: "Arch Tunnel",
      base: "tunnel",
      params: { straightLength: 26, tunnelHeight: 7 },
    },
    {
      id: "tunnel_turn",
      label: "Arch Turn",
      base: "tunnel_curve",
      params: { curveRadius: 26, curveAngle: 90, curveDir: 1, tunnelHeight: 7 },
    },
    {
      id: "channel_str",
      label: "Half-pipe",
      base: "channel",
      params: { straightLength: 26, channelRadius: 4 },
    },
    {
      id: "channel_turn",
      label: "Half-pipe Turn",
      base: "channel_curve",
      params: { curveRadius: 26, curveAngle: 90, curveDir: 1, channelRadius: 4 },
    },
  ],
  straight: [
    {
      // THE DEFAULT BLOCK, and it had no tile at all. The editor boots holding
      // this piece at the kit's 22 m, but the palette only offered 14 (Short)
      // and 32 (Long) — so the moment you clicked either one, the size your
      // first pieces were built at was off the menu for good.
      id: "straight_std",
      label: "Straight",
      base: "straight",
      params: { straightLength: 22 },
    },
    {
      id: "straight_short",
      label: "Short",
      base: "straight",
      params: { straightLength: 14 },
    },
    {
      id: "straight_long",
      label: "Long",
      base: "straight",
      params: { straightLength: 32 },
    },
    {
      id: "straight_tunnel",
      label: "Tunnel",
      base: "tunnel",
      params: { straightLength: 22, tunnelHeight: 7 },
    },
    {
      id: "platform_pad",
      label: "Platform",
      base: "platform",
      params: { platformLength: 24, platformWidth: 44 },
    },
    {
      id: "narrow_run",
      label: "Narrow",
      base: "narrow",
      params: { straightLength: 24, narrowWidth: 8 },
    },
    {
      id: "glass_str",
      label: "Glass Road",
      base: "glass_road",
      params: { glassLength: 32, glassWidth: 16, glassHole: 9 },
    },
    {
      id: "glass_str_wide",
      label: "Glass Road XL",
      base: "glass_road",
      params: { glassLength: 36, glassWidth: 26, glassHole: 16 },
    },
    {
      id: "hole_road",
      label: "Hole Road",
      base: "holed",
      params: { holedLength: 32, holedWidth: 16, holeRadius: 5 },
    },
    {
      id: "hole_road_xl",
      label: "Hole Road XL",
      base: "holed",
      params: { holedLength: 36, holedWidth: 26, holeRadius: 9 },
    },
  ],
  ramps: [
    {
      id: "ramp_10",
      label: "Ramp 10",
      base: "jump",
      params: { jumpLength: 12, jumpAngle: 18 },
    },
    {
      id: "ramp_20",
      label: "Ramp 20",
      base: "jump",
      params: { jumpLength: 18, jumpAngle: 24 },
    },
    {
      id: "ramp_40",
      label: "Ramp 40",
      base: "jump",
      params: { jumpLength: 26, jumpAngle: 30 },
    },
    {
      id: "ramp_100",
      label: "Ramp 100",
      base: "jump",
      params: { jumpLength: 44, jumpAngle: 36 },
    },
    {
      id: "ramp_mega",
      label: "Mega ramp",
      base: "jump",
      params: { jumpLength: 56, jumpAngle: 44 },
    },
    {
      id: "dive_10",
      label: "Dive 10",
      base: "dive",
      params: { diveLength: 12, diveAngle: 18 },
    },
    {
      id: "dive_20",
      label: "Dive 20",
      base: "dive",
      params: { diveLength: 18, diveAngle: 24 },
    },
    {
      id: "dive_40",
      label: "Dive 40",
      base: "dive",
      params: { diveLength: 26, diveAngle: 30 },
    },
    {
      id: "dive_100",
      label: "Dive 100",
      base: "dive",
      params: { diveLength: 44, diveAngle: 36 },
    },
    {
      id: "drop_vert",
      label: "Vert drop",
      base: "dive",
      params: { diveLength: 30, diveAngle: 78 },
    },
    {
      id: "land_10",
      label: "Land 10",
      base: "landing",
      params: { landLength: 12, landAngle: 18 },
    },
    {
      id: "land_20",
      label: "Land 20",
      base: "landing",
      params: { landLength: 18, landAngle: 24 },
    },
    {
      id: "land_40",
      label: "Land 40",
      base: "landing",
      params: { landLength: 26, landAngle: 30 },
    },
    {
      id: "land_100",
      label: "Land 100",
      base: "landing",
      params: { landLength: 44, landAngle: 36 },
    },
    {
      id: "brow_10",
      label: "Brow 10",
      base: "brow",
      params: { browLength: 12, browAngle: 18 },
    },
    {
      id: "brow_20",
      label: "Brow 20",
      base: "brow",
      params: { browLength: 18, browAngle: 24 },
    },
    {
      id: "brow_40",
      label: "Brow 40",
      base: "brow",
      params: { browLength: 26, browAngle: 30 },
    },
    {
      id: "brow_100",
      label: "Brow 100",
      base: "brow",
      params: { browLength: 44, browAngle: 36 },
    },
  ],
  slopes: [
    // Climbs — slope base levels off (smoothstep) at both ends, so they chain cleanly.
    {
      id: "slope_up_gentle",
      label: "Up Gentle",
      base: "slope",
      params: { slopeLength: 30, slopeRise: 5 },
    },
    {
      id: "slope_up_medium",
      label: "Up Medium",
      base: "slope",
      params: { slopeLength: 28, slopeRise: 10 },
    },
    {
      id: "slope_up_steep",
      label: "Up Steep",
      base: "slope",
      params: { slopeLength: 26, slopeRise: 16 },
    },
    // Descents — same shape, negative rise.
    {
      id: "slope_down_gentle",
      label: "Down Gentle",
      base: "slope",
      params: { slopeLength: 30, slopeRise: -5 },
    },
    {
      id: "slope_down_medium",
      label: "Down Medium",
      base: "slope",
      params: { slopeLength: 28, slopeRise: -10 },
    },
    {
      id: "slope_down_steep",
      label: "Down Steep",
      base: "slope",
      params: { slopeLength: 26, slopeRise: -16 },
    },
    // Crests — net-zero bump / dip (rise to the middle, level at both ends).
    {
      id: "slope_hill",
      label: "Hill",
      base: "crest",
      params: { slopeLength: 32, slopeRise: 8 },
    },
    {
      id: "slope_dip",
      label: "Dip",
      base: "crest",
      params: { slopeLength: 32, slopeRise: -8 },
    },
    // Climbing turn — stack to gain height.
    {
      id: "slope_helix",
      label: "Helix",
      base: "spiral",
      params: { spiralRadius: 18, spiralAngle: 180, spiralRise: 10, curveDir: 1 },
    },
  ],
  turns: [
    {
      id: "turn_smooth_small",
      label: "Smooth Small",
      base: "curve",
      params: { curveRadius: 24, curveAngle: 45, curveDir: 1 },
    },
    {
      id: "turn_smooth_long",
      label: "Smooth Long",
      base: "curve",
      params: { curveRadius: 24, curveAngle: 90, curveDir: 1 },
    },
    {
      id: "turn_smooth_longer",
      label: "Smooth Longer",
      base: "curve",
      params: { curveRadius: 30, curveAngle: 135, curveDir: 1 },
    },
    {
      id: "turn_smooth_longest",
      label: "Smooth Longest",
      base: "curve",
      params: { curveRadius: 34, curveAngle: 180, curveDir: 1 },
    },
    {
      id: "turn_sharp_small",
      label: "Sharp Small",
      base: "curve",
      params: { curveRadius: 12, curveAngle: 90, curveDir: 1 },
    },
    {
      id: "turn_s_left",
      label: "S Left",
      base: "scurve",
      params: { curveRadius: 20, curveAngle: 38, curveDir: -1 },
    },
    {
      id: "turn_s_right",
      label: "S Right",
      base: "scurve",
      params: { curveRadius: 20, curveAngle: 38, curveDir: 1 },
    },
  ],
  // JUNCTIONS. Every tile is the same handful of plate shapes at different
  // sizes / sides; `curveDir` is what "R flips L/R" acts on, so the left-hand
  // variants are the identical preset with curveDir: -1.
  junctions: [
    {
      id: "junction_split_r",
      label: "Split R",
      base: "junction_split",
      params: { splitAngle: 24, splitLength: 40, splitArm: 30, splitStart: 8, curveDir: 1 },
    },
    {
      id: "junction_split_l",
      label: "Split L",
      base: "junction_split",
      params: { splitAngle: 24, splitLength: 40, splitArm: 30, splitStart: 8, curveDir: -1 },
    },
    {
      id: "junction_split_wide",
      label: "Split wide",
      base: "junction_split",
      params: { splitAngle: 40, splitLength: 44, splitArm: 34, splitStart: 6, curveDir: 1 },
    },
    {
      id: "junction_merge_r",
      label: "Merge R",
      base: "junction_merge",
      params: { splitAngle: 24, splitLength: 40, splitArm: 30, splitStart: 8, curveDir: 1 },
    },
    {
      id: "junction_merge_l",
      label: "Merge L",
      base: "junction_merge",
      params: { splitAngle: 24, splitLength: 40, splitArm: 30, splitStart: 8, curveDir: -1 },
    },
    {
      id: "junction_y_r",
      label: "Y fork R",
      base: "junction_y",
      params: { forkAngle: 30, forkArm: 34, forkThroat: 6, curveDir: 1 },
    },
    {
      id: "junction_y_l",
      label: "Y fork L",
      base: "junction_y",
      params: { forkAngle: 30, forkArm: 34, forkThroat: 6, curveDir: -1 },
    },
    {
      id: "junction_y_wide",
      label: "Y fork wide",
      base: "junction_y",
      params: { forkAngle: 55, forkArm: 30, forkThroat: 4, curveDir: 1 },
    },
    {
      id: "junction_t_r",
      label: "T right",
      base: "junction_t",
      params: { junctionLength: 34, junctionStub: 24, junctionFillet: 6, curveDir: 1 },
    },
    {
      id: "junction_t_l",
      label: "T left",
      base: "junction_t",
      params: { junctionLength: 34, junctionStub: 24, junctionFillet: 6, curveDir: -1 },
    },
    {
      id: "junction_cross_std",
      label: "Crossroads",
      base: "junction_cross",
      params: { junctionLength: 34, junctionStub: 24, junctionFillet: 6 },
    },
    {
      id: "junction_cross_big",
      label: "Crossroads XL",
      base: "junction_cross",
      params: { junctionLength: 48, junctionStub: 36, junctionFillet: 10 },
    },
    {
      id: "junction_roundabout_std",
      label: "Roundabout",
      base: "junction_roundabout",
      params: { roundaboutRadius: 22, roundaboutStub: 10 },
    },
    {
      id: "junction_roundabout_big",
      label: "Roundabout XL",
      base: "junction_roundabout",
      params: { roundaboutRadius: 34, roundaboutStub: 14 },
    },
  ],
  loop: [
    {
      id: "looping_full",
      label: "Looping",
      base: "loop",
      params: { loopRadius: 25, loopOffset: 16, loopFlat: 12, loopSpread: 1, loopLean: 0, loopTighten: 0, loopHalf: "full", curveDir: 1 },
    },
    {
      id: "loop_half_right",
      label: "Ring half (in)",
      base: "loop_half",
      params: { loopRadius: 25, loopOffset: 16, loopFlat: 12, loopSpread: 1, loopHalf: "in", curveDir: 1 },
    },
    {
      id: "loop_half_left",
      label: "Ring half (out)",
      base: "loop_half",
      params: { loopRadius: 25, loopOffset: 16, loopFlat: 12, loopSpread: 1, loopHalf: "out", curveDir: 1 },
    },
    {
      id: "loop_spiral_right",
      label: "Spiral ramp (R)",
      base: "loop_spiral",
      params: { loopSpiralRadius: 12, loopSpiralTurns: 1, loopSpiralRise: 32, curveDir: 1 },
    },
    {
      id: "loop_spiral_left",
      label: "Spiral ramp (L)",
      base: "loop_spiral",
      params: { loopSpiralRadius: 12, loopSpiralTurns: 1, loopSpiralRise: 32, curveDir: -1 },
    },
    {
      id: "quarterpipe_full",
      label: "Quarter-pipe",
      base: "quarterpipe",
      params: { qpRadius: 16, qpAngle: 90 },
    },
    {
      id: "quarterpipe_kick",
      label: "Wall kicker",
      base: "quarterpipe",
      params: { qpRadius: 13, qpAngle: 72 },
    },
    {
      // SKATEPARK RE-ENTRY: ride up, pop off the lip, drop back onto the SAME
      // face. The shape for that was always the quarter-pipe; what was missing
      // was the SCALE.
      //
      // A transition can only trade speed for height, v²/2 = g·h, so the climb
      // that brings the car to rest at the lip is h = v²/(2g) — and for a
      // quarter circle that IS the radius. This car arrives at a park section at
      // 40–46 m/s, which is 86–108 m of climb. Against that, the 16 m and 13 m
      // presets below are barely a kerb: the car is still doing 31 m/s at the
      // lip, gets 7 s of hangtime, and lands 11 m PAST the ramp every time.
      // MEASURED at 16 m: never once caught, at five lip angles and two radii.
      //
      // Big enough to actually bleed the speed and it works. Measured entering
      // at 46 m/s: R=30 still overshoots; R=45 catches it low on the face; R=55
      // to 70 drops it back in right at the lip; R=100 never gets airborne at
      // all — the car stalls short of the lip and rolls back down, which is also
      // exactly what a skatepark does.
      //
      // 60 m is the middle of that window. Scale it to the speed you want to
      // arrive at: roughly half to three-quarters of v²/(2g). Too small and you
      // fly past the ramp; too large and you never leave the surface.
      //
      // THE LIP STAYS AT 90°, AND THE LANDING STAYS ON THE COPING. That reads
      // like the known defect it is — the back tyre grazes the top edge on the
      // way back in — so here is why the obvious fix is not one, measured, to
      // stop it being tried a third time.
      //
      // A vertical lip throws the car STRAIGHT up, so it comes straight back
      // down onto the lip it just left: landing point 0.99–1.00 along the face
      // at every radius from 40 m to 78 m and every speed. Instrumented at R=60
      // the car arrives nose-up at 85° and the rear tyres touch at y = 59.98
      // against a lip at 60.00 — the last two centimetres of ramp. Not tuning
      // noise; it is what a vertical launch means, and no radius changes it.
      //
      // Tipping the lip past vertical DOES move the landing down the face, and
      // it is far too coarse to be useful, because near the lip the face is
      // vertical — a few centimetres of backward drift means falling the whole
      // vertical section before finding surface. MEASURED at R=60, how far under
      // the lip the car touches down (negative = on top of the rim):
      //
      //                 46 m/s    42 m/s
      //     A=90.0°     -1.6 m    -1.6 m     on the rim, both
      //     A=90.5°     +6.3 m    -1.7 m     fixed fast, unchanged slow
      //     A=91.0°    +14.3 m    -1.6 m
      //     A=92.0°    +23.4 m   +11.8 m
      //     A=96.0°    +42.0 m   +27.3 m     shipped once; "falls back far
      //                                      from the top, doesn't feel nice"
      //
      // There is no angle that lands it a few metres under the rim at BOTH
      // speeds. Half a degree swings the fast case from on-the-rim to 6 m under.
      // The landing point is not the lever — the lip GEOMETRY is, and that is a
      // change to quarterPipePoints (a rounded coping or a deck at the top), not
      // to this number.
      id: "quarterpipe_bowl",
      label: "Park bowl",
      base: "quarterpipe",
      params: { qpRadius: 60, qpAngle: 90 },
    },
    {
      // The same re-entry on a smaller wall — and 40 m IS the smallest that works.
      // Not a style choice: below it the car leaves the lip too fast and lands
      // beyond the ramp however the rest of the track is built.
      //
      // MEASURED as where it lands along the face (1.00 = back at the lip, >1 =
      // past the ramp entirely), against the speed it arrives at:
      //
      //              46     42     38     34
      //     R=25m   1.29   1.30   1.40   1.03      <- past it at every real speed
      //     R=30m   1.25   1.29   0.54   0.98
      //     R=40m   0.47   1.02   0.99   1.00      <- catches across the whole band
      //     R=60m   0.99   1.00  stall  stall
      //
      // This shipped as R=25 first, on the theory that a smaller bowl just needed a
      // slower approach. It does — but "slower" turned out to mean 30 m/s, which is
      // not a speed you arrive at unless the whole section is built for it, so in
      // practice it never caught the car and was reported that way. 40 m needs no
      // special approach.
      //
      // At full speed it lands mid-face (0.47) rather than at the lip; that is the
      // trade for the smaller wall, and it is still a re-entry.
      //
      // The apex does NOT shrink with the bowl — that is v²/(2g), with the ramp
      // height cancelling out. Only arriving slower lowers the flight.
      //
      // 90°, and it lands on the coping like the big one — see the measured
      // table there for why an over-vertical lip cannot fix that without
      // throwing the car most of the way back down the face.
      id: "quarterpipe_bowl_small",
      label: "Park bowl (small)",
      base: "quarterpipe",
      params: { qpRadius: 40, qpAngle: 90 },
    },
    {
      // THE SHORT-FLIGHT BOWL. The two above launch the car 90 m up and hold it
      // there for 6–7 s, which reads as a rocket rather than a trick.
      //
      // The apex above the GROUND cannot be tuned — it is v²/(2g), ~90 m at the
      // 47 m/s the car arrives at, and it measures 90–96 m at every radius from
      // 40 m to 78 m. What CAN be tuned is how much of that climb happens on the
      // ramp instead of in the air, because the flight only starts at the lip:
      // apex above the lip is v²/(2g) − R. A taller wall eats more of the speed
      // before letting go. MEASURED at full throttle:
      //
      //     R=60   35.6 m over the lip   5.3 s of air
      //     R=66   28.3 m                4.7 s
      //     R=70   23.5 m                4.2 s
      //     R=74   18.6 m                3.7 s      <- this preset
      //     R=78   13.8 m                3.1 s
      //
      // The cost, and it is a real one: the stall point is v²/(2g) minus what
      // friction takes over a 116 m arc, and MEASURED that lands right on top of
      // the speeds the car actually arrives at — 46 m/s gives 18.6 m and 3.7 s,
      // 44 m/s only 6.5 m and 2.0 s, and 42 m/s stalls outright (the car climbs,
      // runs out short of the lip and rolls back down). Authentic, but it means
      // this preset only pops when the car arrives flat out, and the size of the
      // pop is very sensitive to how flat out that is. Use the 60 m bowl wherever
      // the approach is not guaranteed.
      //
      // It does NOT fix the rear tyre grazing the coping on the way back in —
      // nothing does; see the note on "Park bowl" above. It only shortens the
      // flight.
      id: "quarterpipe_bowl_tall",
      label: "Park bowl XL",
      base: "quarterpipe",
      params: { qpRadius: 74, qpAngle: 90 },
    },
    {
      id: "quarterpipe_down",
      label: "Quarter-pipe down",
      base: "quarterpipe_down",
      params: { qpRadius: 16, qpAngle: 90 },
    },
  ],
};

/** Undo depth. A snapshot is structural only (no geometry), so this is cheap —
 *  a few hundred bytes per step even on a large track. */
const HISTORY_LIMIT = 100;
let _uidSeq = 0;

/** Thumbnail map key for the first tile shown in a palette category. */
export function categoryThumbnailKey(catId, propCatalog = [], moverCatalog = []) {
  if (catId === "moving") return moverCatalog[0]?.id ?? null;
  if (catId === "obstacles" || catId === "scenery") {
    return propCatalog.find((p) => (p.category ?? "obstacles") === catId)?.id ?? null;
  }
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
  /** Swappable: on a cold cache the game paints the palette with the SVG
   *  fallbacks immediately and hands the baked tiles over later, through
   *  setThumbnails(), rather than making startup wait for the bake. */
  let thumbs = thumbnails;

  /**
   * A baked tile is one cell of a sprite sheet, so it is painted as a
   * background on its own square element rather than being an <img> — see
   * createThumbnailSprites(). Returns null when nothing was baked for `key`,
   * which is the caller's cue to fall back to the hand-drawn SVG.
   */
  function thumbSprite(key) {
    if (!thumbs?.has(key)) return null;
    const el = document.createElement("div");
    el.className = "tile-sprite";
    return thumbs.apply(el, key) ? el : null;
  }

  function fillCategoryIcon(el, catId) {
    const key = categoryThumbnailKey(catId, propCatalog, moverCatalog);
    const sprite = key ? thumbSprite(key) : null;
    if (sprite) el.replaceChildren(sprite);
    else el.innerHTML = placeholderSvg();
  }

  function piecesInCategory(catId) {
    // Props split across two tabs by their own `category`, defaulting to
    // obstacles — so adding a prop needs no edit here, and an older catalog
    // entry with no category still lands where it always did.
    if (catId === "obstacles" || catId === "scenery") {
      return propCatalog
        .filter((p) => (p.category ?? "obstacles") === catId)
        .map((p) => ({ id: p.id, label: p.label, isProp: true, hint: "" }));
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
      const sprite = thumbSprite(item.id);
      if (sprite) {
        preview.appendChild(sprite);
      } else {
        preview.innerHTML = placeholderSvg();
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
      const dir = builder.activeParams.curveDir >= 0 ? "R" : "L";
      const curveIds = new Set([
        "curve", "banked", "scurve", "spiral", "loop_half", "loop_spiral",
        "junction_split", "junction_merge", "junction_y", "junction_t",
      ]);
      const chainInfo =
        builder.chainCount > 1 ? ` · chain ${builder.activeChainIndex + 1}/${builder.chainCount}` : "";
      const gizmoHint =
        builder.gizmoMode === "ghost"
          ? builder.ghostOnBranch
            ? "on a junction branch — place to start the side road"
            : builder.ghostDetached
              ? "free piece — drag near an open end to snap"
              : "drag gizmo to move the piece anywhere"
          : "anchor gizmo drags whole chain";
      // WHICH END the next piece lands on. Named even when it is the ordinary
      // tail: the whole point of being able to build backwards is that "where
      // does this go" now has two answers, and a label that only appears in the
      // unusual case leaves you guessing in the usual one.
      const endInfo =
        builder.gizmoMode === "ghost" && !builder.ghostDetached
          ? builder.buildEnd === "head"
            ? " · ◂ HEAD (building backwards, O)"
            : builder.canBuildFromHead ? " · TAIL ▸ (O for the other end)" : " · TAIL ▸"
          : "";
      // HOW BIG THE PIECE ACTUALLY IS. The tiles are presets over one shared
      // pieceParams — "Short" and "Long" are the same `straight` with a
      // different `straightLength`, written into that shared object and never
      // put back — so the size of the piece named in this line depends on which
      // tile you last clicked, including tiles for completely different pieces.
      // Printing it is the cheap half of the fix: it turns "my circuit refuses
      // to close by exactly one piece length" from a mystery into a number you
      // watched change.
      let sizeInfo = "";
      try {
        const { span, rise } = builder.activePieceMetrics;
        if (span >= 0.05) sizeInfo = ` · ${span.toFixed(span < 10 ? 1 : 0)} m`;
        if (Math.abs(rise) >= 0.5) sizeInfo += `${sizeInfo ? " " : " · "}${rise > 0 ? "↑" : "↓"}${Math.abs(rise).toFixed(0)} m`;
      } catch { /* a piece that cannot build right now simply has no readout */ }
      // Only mentioned when there ARE loose branches: a floating arrow on screen
      // with nothing telling you what it is, or how to get to it, is worse than
      // no marker at all.
      const open = builder.openBranchCount;
      const branchInfo = open && !builder.ghostOnBranch ? ` · ${open} open branch${open > 1 ? "es" : ""} (K)` : "";
      statusEl.textContent = `${builder.count} placed · ${label}${
        curveIds.has(builder.activePieceId) ? " (" + dir + ")" : ""
      }${sizeInfo}${chainInfo}${endInfo}${branchInfo} · ${gizmoHint}`;
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
        <span class="cat-btn-icon"></span>
        <span class="cat-btn-label">${cat.label}</span>
      `;
      fillCategoryIcon(btn.querySelector(".cat-btn-icon"), cat.id);
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
  // Redo has no button of its own — Ctrl+Y / Ctrl+Shift+Z only. Right-clicking
  // the Undo button is the discoverable pair for it without adding chrome.
  document.getElementById("road-undo")?.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    builder.redo();
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

  /**
   * Adopt a (re)baked thumbnail set — Map(id -> image src).
   *
   * Patches the live DOM in place instead of calling renderPieces(): the bake
   * lands a couple of seconds into the session, by which time a prop brush may
   * be armed, and a re-render clears activePropId/activeMoverId — the tiles
   * would change under a brush that then had no highlight.
   */
  function setThumbnails(next) {
    thumbs = next;
    for (const [id, btn] of catBtns) {
      const icon = btn.querySelector(".cat-btn-icon");
      if (icon) fillCategoryIcon(icon, id);
    }
    for (const [key, btn] of pieceTiles) {
      const sprite = thumbSprite(key.replace(/:(prop|mover|preset)$/, ""));
      if (sprite) btn.querySelector(".piece-tile-preview")?.replaceChildren(sprite);
    }
  }

  /** Drop the prop/mover brush highlight — the game calls this when the brush
   *  is cancelled from its side (Escape, right-click, leaving build mode). */
  function clearBrushHighlight() {
    if (!activePropId && !activeMoverId) return;
    activePropId = null;
    activeMoverId = null;
    refreshStatus();
  }

  return { refreshStatus, renderPieces, syncEdgesBtn, selectPieceById, clearBrushHighlight, setThumbnails };
}
