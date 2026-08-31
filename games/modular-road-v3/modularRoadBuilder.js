import * as THREE from "three";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import {
  PIECE_CATALOG,
  PIECE_BY_ID,
  isHandedPiece,
  roadParams,
  pieceParams,
  guardrailParams,
  buildPiece,
  pieceEndTakesTubeCap,
  initialConnector,
  socketMatrix,
  linkCurvature,
  isLaterallyTileable,
  convexVerticalRadius,
  followSpeed,
  heldSpeed,
  isFollowRoad,
  PIECE_PARAM_DEFAULTS,
} from "./modularRoadKit.js";
import { solveGapArc } from "./gapArc.js";
import { sparse, resolve } from "./modularRoadTrackIO.js";

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
 *
 * The snapshot now lives in the kit, beside the object it is a snapshot OF, so
 * that the save format and the placement path diff against the SAME baseline —
 * two independently-taken copies of "the shipped numbers" is exactly the kind
 * of near-duplicate that drifts apart quietly. It is frozen and `onChange`-free;
 * nothing here ever wrote to it, only spread it.
 */
const PIECE_DEFAULTS = PIECE_PARAM_DEFAULTS;

/**
 * A saved piece's sparse `pp`, back to the full set the builder works in.
 *
 * @param {object} saved sparse overrides from the track file
 * @param {Set<string>|null} drop keys to take from the defaults regardless
 */
function resolvePieceParams(saved, drop) {
  const pp = resolve(PIECE_DEFAULTS, saved);
  if (drop) for (const key of drop) pp[key] = PIECE_DEFAULTS[key];
  return pp;
}

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
const _POSE = new THREE.Matrix4();
const _A_Q2 = new THREE.Quaternion();
const _A_V = new THREE.Vector3();
const _A_V2 = new THREE.Vector3();
const _UNIT_SCALE = new THREE.Vector3(1, 1, 1);
/** Never mutated — the entry pose a piece is built at to read back its own
 *  entry→exit transform. See `_localTransform`. */
const _IDENTITY = new THREE.Matrix4();
const _CAP_P = new THREE.Vector3();
const _CAP_Q = new THREE.Vector3();
const _CAP_M = new THREE.Matrix4();

/** Spare instance slots kept in every road batch, so appending one piece to a
 *  chain rewrites matrices instead of reallocating the buffer. */
const INSTANCE_SLACK = 8;
const _isIdentityQuat = (q) => Math.abs(q.w) > 0.9999999;

/** How close a chain's head has to sit to a branch socket or another chain's
 *  tail to count as JOINED there (and so not an open end you may prepend onto).
 *  Same tolerance the branch "used" test has always applied, for the same
 *  reason: seams are welded by position, not by a stored link. */
const HEAD_JOIN_EPS = 1.0;

/** Sweep-prism pieces whose open ends need a lid. Tubes close the wall
 *  cavity on their own path; custom plates and gaps have no prism. */
function pieceTakesSlabCaps(id) {
  const def = PIECE_BY_ID.get(id);
  return !!(def && !def.geometry && !def.profile && !def.tubeEndCaps && !def.noMesh);
}

function pieceTakesTubeCaps(id) {
  const def = PIECE_BY_ID.get(id);
  return !!(def?.tubeEndCaps && !def.geometry);
}

/** Neighbour must be at least this close in half-width (m) to count as covering
 *  a mouth. A 44 m platform against a 16 m straight leaves 14 m of wing on each
 *  side — that leftover prism stays lidded. */
const SLAB_COVER_EPS = 0.05;
/** Metres of edge curl. A held-bank mouth is a 0.9 m U; a straight is flat.
 *  Same width is not a nest. */
const SLAB_CURL_EPS = 0.08;
/** Radians of end lean. Level sockets do not carry roll, so 22° against 0°
 *  is two different cuts in the same plane. */
const SLAB_LEAN_EPS = 3 * Math.PI / 180;

/** Deck half-width the kit would sweep for this piece — same rule as buildPiece. */
function pieceHalfWidth(id, pp, rp = roadParams) {
  const def = PIECE_BY_ID.get(id);
  if (!def || def.noMesh) return 0;
  if (typeof def.width === "function") return def.width(pp) / 2;
  if (def.profile) {
    const data = def.profile(pp, rp);
    return data?.hw ?? 0;
  }
  return rp.width / 2;
}

function pieceEndCurlM(id, pp, end) {
  const def = PIECE_BY_ID.get(id);
  const amt = Math.max(0, pp?.bankCurl ?? pieceParams.bankCurl ?? 0);
  if (!def?.curl || amt < 1e-4) return 0;
  const t = end === "exit" ? 1 : 0;
  return amt * def.curl(t, pp);
}

function pieceEndLean(id, pp, end) {
  const def = PIECE_BY_ID.get(id);
  if (!def?.roll) return 0;
  return def.roll(end === "exit" ? 1 : 0, pp);
}

/** Raised kerb on this mouth — `edges` on and the piece actually sweeps one.
 *  A platform / plate (`noKerb`) or Edges-Off piece is a flat cut. */
function pieceHasRaisedKerbs(p, rp = roadParams) {
  if (!p || p.edges === false) return false;
  const def = PIECE_BY_ID.get(p.id);
  if (!def || def.noKerb) return false;
  return (rp.railHeight ?? 0) > 1e-4;
}

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
 * How far out from a piece's centreline the cursor must be, as a fraction of
 * its half-width, before pointing at it means "put one BESIDE this".
 *
 * Pointing at the middle of a road means you are looking at the road, and
 * snapping the ghost sideways there would make it skitter across the track
 * every time the cursor crossed it. The outer third is unambiguous: nothing
 * else in the builder claims that gesture.
 */
const LATERAL_EDGE_FRACTION = 0.66;

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
 * Deep equality over PLAIN JSON-ish data — what the history layers serialize to
 * (arrays of `{type, position:[…], quaternion:[…], …}`), and nothing else.
 *
 * Exists to answer "did this layer really change?", which a reference compare
 * cannot: a manager fires its change callback on every gizmo mouseUp, including
 * the one where you clicked a handle and let go without dragging. Left alone
 * that pushed an undo step in which nothing differs, so Ctrl+Z did nothing —
 * the same dead-step bug `_sameStructure` was written to keep off the stack.
 *
 * Exact number equality is the point: bit-identical means the user did not move
 * it. Only ever called on a layer that reported a change, so it costs nothing on
 * the road edits that make up most commits.
 */
function plainEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!plainEqual(a[i], b[i])) return false;
    return true;
  }
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!plainEqual(a[k], b[k])) return false;
  }
  return true;
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
   * @param {THREE.Material} [o.vaultShellMaterial] vaulted road-tunnel shell
   * @param {THREE.Material} [o.tunnelGlowMaterial] vault LED battens (bloom)
   * @param {THREE.Material} [o.decorMaterial] start/finish/checkpoint decor
   * @param {THREE.Material} [o.decorGateMaterial] start_new / finish_new gantry frame
   * @param {THREE.Material} [o.decorGlowMaterial] start_new gantry bloom stroke
   * @param {THREE.Material} [o.finishGlowMaterial] finish_new gantry bloom stroke (pink)
   * @param {THREE.Material} [o.checkpointGlowMaterial] checkpoint_new yellow line
   * @param {THREE.Material} [o.glassMaterial] shared pane material (glass road)
   * @param {THREE.Material} [o.tubeMaterial] cheap dedicated shader for rideable tubes
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
    vaultShellMaterial = null,
    tunnelGlowMaterial = null,
    decorMaterial = null,
    decorGateMaterial = null,
    decorGlowMaterial = null,
    finishGlowMaterial = null,
    checkpointGlowMaterial = null,
    glassMaterial = null,
    tubeMaterial = null,
    hazardPadMaterial = null,
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
    this.vaultShellMaterial = vaultShellMaterial;
    this.tunnelGlowMaterial = tunnelGlowMaterial;
    this.decorMaterial = decorMaterial;
    this.decorGateMaterial = decorGateMaterial;
    this.decorGlowMaterial = decorGlowMaterial;
    this.finishGlowMaterial = finishGlowMaterial;
    this.checkpointGlowMaterial = checkpointGlowMaterial;
    this.glassMaterial = glassMaterial;
    this.tubeMaterial = tubeMaterial;
    this.hazardPadMaterial = hazardPadMaterial;
    this.orbit = orbit;
    this.isBuildMode = isBuildMode;
    this.onChange = onChange;
    /** True when a gizmo drag rebuilt the track but deferred bakeCollision. */
    this._collisionDeferred = false;
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

    /** Handles down while a placement brush owns the pointer. See suspendGizmo. */
    this._gizmoSuspended = false;

    /** @type {object|null} The gizmo's piece, and the end a range measures from. */
    this.selectedPiece = null;
    /** @type {object[]} Everything selected, INCLUDING the anchor. Single-select
     *  is just this with one entry, so every bulk op has one code path. */
    this.selectedPieces = [];
    this.activePieceId = PIECE_CATALOG[0].id;
    /**
     * The numbers the NEXT piece will be built from — this selection's own copy,
     * never the shared `pieceParams`. See PIECE_DEFAULTS: this is what makes a
     * palette tile mean one fixed thing instead of an edit to global state.
     */
    this.activeParams = { ...PIECE_DEFAULTS };
    /**
     * WHICH WAY CORNERS GO — a mode, not a property of the selection.
     *
     * +1 right, -1 left, applied to every handed piece you pick until you flip
     * it (R). This is what lets the palette ship one tile per shape instead of a
     * mirror pair: see flip(). Editor state, deliberately NOT saved with a track
     * — each piece already stores its own `curveDir` in its params snapshot, so
     * a track's corners are fixed by the track, not by how the editor was set
     * when it was reopened.
     */
    this.hand = 1;
    /** @type {{id:string, chainId:number, pp:object, mesh:THREE.Mesh, railMesh:THREE.Mesh|null, shellMesh:THREE.Mesh|null, decorMesh:THREE.Mesh|null, decorGateMesh:THREE.Mesh|null, decorGlowMesh:THREE.Mesh|null, glassMesh:THREE.Mesh|null, connectorIn:THREE.Matrix4, connectorOut:THREE.Matrix4}[]} */
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

    /**
     * EXTERNAL HISTORY LAYERS — props, movers, portals.
     *
     * The track is FOUR authored layers, not one, and only this class owned a
     * history. So Ctrl+Z after moving an obstacle undid a ROAD PIECE somewhere
     * else on the map, and "Clear track" left every prop hanging in the air over
     * the road it used to sit on.
     *
     * They are folded in here rather than into a new history object above the
     * builder because the commit rules are already all here — `_sameStructure`,
     * `_markCursor`, `_asOneEdit`, the cursor-only fold — and duplicating them
     * one level up is how the two histories would drift apart again.
     *
     * Each layer supplies capture/restore/clear. The managers already had the
     * first two under other names (`exportInstances` / `importInstances`), which
     * is what makes this cheap: a layer snapshot is the same plain array the
     * save file holds.
     *
     * PERFORMANCE, and the reason for `dirty`/`cache`: `capture()` allocates one
     * plain object per instance, and a commit fires on EVERY piece placement and
     * EVERY gizmo drag-end. Serializing three hundred props each time a road
     * piece is laid would be pure waste, since they did not move. So a layer is
     * only re-serialized after it says it changed; otherwise the snapshot takes
     * the previous array BY REFERENCE. That makes "did this layer change?" a
     * pointer compare, and lets `_restore` skip layers that are already correct —
     * the same reuse discipline `rebuildAll({reuse})` uses for pieces.
     * @type {{name:string, capture:()=>any, restore:(v:any)=>void, clear:(()=>void)|null, cache:any, dirty:boolean}[]}
     */
    this._histLayers = [];
    /** True while `_restore` is putting a snapshot back. Layer restores make the
     *  managers fire their own change callbacks, and those call
     *  `commitLayerEdit` — which would push the state we are restoring FROM back
     *  onto the stack, mid-undo. */
    this._histRestoring = false;

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
    /** True while the ghost is parked on a piece's SIDE socket (lateral snap). */
    this.ghostOnLateral = false;
    /** @type {{side:string,piece:object,matrix:THREE.Matrix4}|null} the socket
     *  the ghost is parked on, so placement knows which side to open up. */
    this.lateralNeighbour = null;
    /** Half-width of the piece the ghost is currently previewing (see refreshGhost). */
    this._ghostHw = null;
    /** Point at a piece's edge to place one beside it. Off = the old behaviour. */
    this.lateralSnapEnabled = true;
    /**
     * WHICH END of the active chain the ghost is working on: "tail" appends (the
     * original and still the default), "head" PREPENDS — the piece goes in front
     * of the chain and the anchor moves back to meet it.
     * @type {"tail"|"head"}
     */
    this.ghostEnd = "tail";
    /** @type {Map<string, THREE.Matrix4>} memo for `_localTransform`. */
    this._localXfCache = new Map();
    /**
     * Memo for `refreshGhost` — see the note there.
     *
     * `{ geometry, fromConn }` per (piece id + params + edges). A piece's
     * geometry is authored in PIECE space and does not depend on the connector
     * it is placed at (that is the same property `_relocatePiece` exploits), so
     * moving the ghost is a matrix multiply, not a rebuild.
     *
     * The GHOST DOES NOT OWN what it draws once this is live: every geometry it
     * holds belongs to this map, so `refreshGhost` must not dispose the outgoing
     * one and eviction must not free the one currently on screen.
     * @type {Map<string, {geometry: THREE.BufferGeometry, fromConn: THREE.Matrix4}>}
     */
    this._ghostGeoCache = new Map();
    /** Evicted-but-still-drawn ghost geometry, freed on the next refresh.
     *  @type {THREE.BufferGeometry|null} */
    this._ghostOrphanGeo = null;
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
    /** The same batches, by (role + geometry hash), so a rebuild can find and
     *  REUSE one instead of allocating a new buffer — see _rebuildInstances.
     *  @type {Map<string, THREE.InstancedMesh>} */
    this._instByKey = new Map();
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
    /** Empty stand-in until the first `refreshGhost`. Held so teardown can free
     *  it: from that point on the ghost only ever borrows cache-owned geometry
     *  and must not dispose what it is holding. */
    this._ghostPlaceholderGeo = new THREE.BufferGeometry();
    this.ghost = new THREE.Mesh(this._ghostPlaceholderGeo, this.ghostMat);
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
          // Piece/chain drags rebuild every frame but skip the BVH until the
          // pointer comes up — see rebuildAll. Ghost-only drags never set the
          // flag, so this does not rebake on a cursor nudge.
          if (this._collisionDeferred) {
            this._collisionDeferred = false;
            this._notify();
          }
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

  _notify(info = {}) {
    this.onChange?.(info);
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
    // The hand outlives the selection — that is what makes it a mode. Without
    // this line every pick would silently snap back to right-handed.
    this.activeParams.curveDir = this.hand;
    this._ensureGizmoOnGhost();
    this.refreshGhost();
    this._notify({ collision: false });
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
    // AN EXPLICIT curveDir WINS. Palette tiles no longer carry one, so they take
    // the sticky hand — but the demo/track loaders below (loadBigCircuit,
    // loadPresetTrack, tools/buildParkourTrack) name the direction they want,
    // and a track that builds itself differently depending on which way the
    // editor happened to be pointing is not a track.
    if (preset.params?.curveDir === undefined) this.activeParams.curveDir = this.hand;
    this._ensureGizmoOnGhost();
    this.refreshGhost();
    this._notify({ collision: false });
  }

  /**
   * Set the active GAP's span and drop directly (metres).
   *
   * On the selection, like every other tile parameter — the shared `pieceParams`
   * is not written. Exists because a gap's size is the one thing that should be
   * MEASURED rather than picked: see gapToLanding in roadGame.js.
   */
  setGapSize(length, drop) {
    this.activeParams = {
      ...this.activeParams,
      gapLength: Math.max(2, length),
      gapDrop: drop,
    };
    this.refreshGhost();
    this._notify({ collision: false });
  }

  /**
   * Flip the sticky HAND — and it is the hand, not just this selection.
   *
   * It used to write `activeParams.curveDir` and nothing else, which meant the
   * flip survived exactly until your next tile click: `setActivePreset` replaces
   * activeParams wholesale, and every tile shipped `curveDir: 1`. So "press R
   * once, then build a run of left-handers" did not work — you had to press R
   * again after every single click. That is why the palette carried an L tile
   * beside every R tile: 94 of 195 tiles were one half of a mirror pair, and
   * pairs were the only way left-handed building was usable at all.
   *
   * Now the hand is a MODE the palette applies to whatever you pick, so one
   * tile per shape is enough (195 → 148) and one keypress covers the whole run.
   */
  flip() {
    this.hand = this.hand >= 0 ? -1 : 1;
    this.activeParams.curveDir = this.hand;
    this.refreshGhost();
    this._notify({ collision: false });
  }

  /** Set the hand outright. Scripts that build a fixed track want this rather
   *  than counting flips. */
  setHand(dir) {
    const h = dir >= 0 ? 1 : -1;
    if (h === this.hand) return;
    this.hand = h;
    this.activeParams.curveDir = h;
    this.refreshGhost();
    this._notify({ collision: false });
  }

  /** Is the hand doing anything to what is selected? The toggle greys out when
   *  it is not — an inert control that looks live is worse than no control. */
  get activePieceHanded() {
    return isHandedPiece(this.activePieceId);
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
    this._notify({ collision: false });
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
    this._notify({ collision: false });
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
      this._notify({ collision: false });
      return true;
    }
    const canHead = this._openConnectors()
      .some((oc) => oc.chainId === this.activeChainId && oc.end === "head");
    if (!canHead) return false;
    this._syncGizmoToOpenEnd({ end: "head" });
    this.refreshGhost();
    this._notify({ collision: false });
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
    this.rebuildAll({ reuse: true });
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

  // ── BULK EDITS ON A SELECTION ──────────────────────────────────────────────
  // Each of these is ONE undo step and ONE rebuild, not one per piece: the
  // history is snapshot-based, so a bulk op is naturally atomic, and rebuilding
  // per piece on a 40-piece selection would be forty full chain walks.

  /** Delete everything selected. */
  deleteSelected() {
    const doomed = this.selectedPieces.filter((p) => this.pieces.includes(p));
    if (!doomed.length) return 0;
    this._markCursor();
    this.activeChainId = doomed[0].chainId;
    this.selectedPiece = null;
    this.selectedPieces = [];
    this._updateSelectionHighlight(); // drop the geometry refs BEFORE disposing
    for (const p of doomed) {
      const i = this.pieces.indexOf(p);
      if (i >= 0) this.pieces.splice(i, 1);
      this._removePiece(p);
    }
    this.rebuildAll({ reuse: true });
    this._commit();
    this._notify();
    return doomed.length;
  }

  /** Guardrails and kerbs on or off, per piece, across the selection. */
  setSelectedEdges(on) {
    const sel = this.selectedPieces.filter((p) => this.pieces.includes(p));
    if (!sel.length) return 0;
    for (const p of sel) p.edges = !!on;
    this.rebuildAll({ reuse: true });
    this._updateSelectionHighlight();
    this._commit();
    this._notify();
    return sel.length;
  }

  /** Zero every selected tilt. Safe and unambiguous — no compounding question,
   *  which is why it is the one bulk angle op with nothing to decide. */
  levelSelected() {
    const sel = this.selectedPieces.filter((p) => this.pieces.includes(p));
    if (!sel.length) return 0;
    for (const p of sel) p.tilt.identity();
    this.rebuildAll({ reuse: true });
    this._updateSelectionHighlight();
    this._commit();
    this._notify();
    return sel.length;
  }

  /** Swap every selected piece's TYPE, keeping its slot in the chain. */
  replaceSelected(newId, pp = this._snapshotParams()) {
    if (!PIECE_BY_ID.has(newId)) return 0;
    const sel = this.selectedPieces.filter((p) => this.pieces.includes(p));
    if (!sel.length) return 0;
    this._markCursor();
    for (const p of sel) {
      p.id = newId;
      p.pp = { ...pp };
      this._applyPiecePresence(p);
    }
    this.rebuildAll({ reuse: true });
    this._updateSelectionHighlight();
    this._commit();
    this._notify();
    return sel.length;
  }

  /**
   * BANK / PITCH / YAW A WHOLE SECTION — enter the turn at the start, come out
   * of it at the end.
   *
   * WHY NOT JUST WRITE THE ANGLE ON EVERY PIECE. A piece's `tilt` is applied at
   * its entry seam and the running connector carries it forward (see rebuildAll),
   * so tilts ACCUMULATE down a chain. Setting roll = 15° on five pieces gives
   * 15, 30, 45, 60, 75 — you ask for a banked section and get a corkscrew.
   *
   * So the section gets the angle ONCE, at its first piece, which is all it takes
   * — propagation banks the rest for free. The piece immediately AFTER the run
   * gets the inverse, which brings the track back level past the section instead
   * of leaving the whole remaining chain tipped over. That is what a real banked
   * corner is: roll in, roll out.
   *
   * A delta, not an absolute, so it composes with repeated presses exactly like
   * the single-piece nudge does.
   */
  tiltSection(axis, radians) {
    const sel = this._selectionInOrder();
    if (!sel.length) return { ok: false, reason: "nothing selected" };
    const chainId = sel[0].chainId;
    if (sel.some((p) => p.chainId !== chainId)) {
      return { ok: false, reason: "a section has to be within one chain" };
    }
    const local = axis === "pitch" ? _A_V.set(1, 0, 0)
      : axis === "roll" ? _A_V.set(0, 0, 1)
        : _A_V.set(0, 1, 0);
    _A_Q.setFromAxisAngle(local, radians);

    const first = sel[0];
    const after = this._nextInChain(sel[sel.length - 1]);
    this._markCursor();
    first.tilt.multiply(_A_Q);
    // Only if the run has something after it — a section that ends the chain has
    // nothing left to bring back level.
    if (after) after.tilt.multiply(_A_Q2.copy(_A_Q).invert());
    this.rebuildAll({ reuse: true });
    this._updateSelectionHighlight();
    this._commit();
    this._notify();
    return {
      ok: true, target: "section", count: sel.length, levelledAfter: !!after,
      ...this.pieceTiltDeg(first),
    };
  }

  // ── NUDGING AN ANGLE FROM THE KEYBOARD ─────────────────────────────────────
  // Yaw already had Q/E. Pitch and roll had nothing but a gizmo drag, which is
  // the imprecise half of the editor: banking a landing strip to a repeatable
  // angle meant dragging and reading a number back. Arrow keys give all three
  // axes an exact, countable step — press it three times at 15° and you have 45.
  //
  // The step is `snapYawDeg`, the SAME setting the rotate gizmo snaps to. Q/E
  // were hardcoded to 15° and so disagreed with the gizmo the moment you touched
  // the Angle step slider.

  /** The angle step in radians — one press, one gizmo snap increment. */
  get angleStep() {
    return THREE.MathUtils.degToRad(this.snapYawDeg || 15);
  }

  /**
   * Turn whatever the gizmo is on by one step about a LOCAL axis.
   *
   * `axis` is "yaw" | "pitch" | "roll", which in a connector's own frame are Y,
   * X and Z — travel is −Z, so roll is about travel and pitch about the lateral
   * axis, matching what the rotate gizmo produces.
   *
   * Routes by target, because "rotate" means three different things here:
   *  • a selected PIECE  → its entry tilt, which banks it AND everything after
   *    it in the chain (that is the banked-landing-strip tool, not a bug)
   *  • a chain ANCHOR    → the whole chain turns rigidly
   *  • the GHOST         → yaw only, because every socket in the kit is level by
   *    convention and a pitched ghost would hand the next piece a seam it cannot
   *    honour. Pitch/roll there are declined rather than silently ignored.
   *
   * @returns {{ok:boolean, target?:string, reason?:string, pitch?:number, roll?:number, yaw?:number}}
   */
  nudgeAngle(axis, dir = 1) {
    const step = this.angleStep * (dir < 0 ? -1 : 1);
    const local = axis === "pitch" ? _A_V.set(1, 0, 0)
      : axis === "roll" ? _A_V.set(0, 0, 1)
        : _A_V.set(0, 1, 0);
    _A_Q.setFromAxisAngle(local, step);

    // A SECTION turns as a section — angle in at the front, out at the back —
    // rather than the same angle written onto every piece, which would compound
    // down the chain into a corkscrew. Same keys, so the gesture scales.
    if (this.selectedPieces.length > 1) return this.tiltSection(axis, step);

    const p = this.selectedPiece;
    if (p) {
      // Compose on the RIGHT: the tilt is expressed in the seam's own frame, so
      // this turns the piece about its own axes rather than the world's.
      _A_Q2.copy(p.tilt).multiply(_A_Q);
      this.setPieceTilt(p, _A_Q2);
      const t = this.pieceTiltDeg(p);
      return { ok: true, target: "piece", ...t };
    }

    if (this._gizmoTarget === "ghost") {
      if (axis !== "yaw") {
        return { ok: false, reason: "the next piece is yaw-only — kit sockets are level" };
      }
      this.rotateFreeYaw(step);
      return { ok: true, target: "ghost", yaw: THREE.MathUtils.radToDeg(this._ghostYaw) };
    }

    if (!this.freePlaceMode) return { ok: false, reason: "nothing selected" };
    if (axis === "yaw") {
      this.rotateFreeYaw(step); // spins about WORLD up, preserving any bank
    } else {
      this._freeQuat.multiply(_A_Q);
      this.freeYaw = _A_E.setFromQuaternion(this._freeQuat, "YXZ").y;
      if (this.placementGizmo) this.placementPivot.quaternion.copy(this._freeQuat);
      const chain = this._activeChain();
      if (chain) { chain.anchor = this._anchorFromFree(); this.rebuildAll({ reuse: true }); }
    }
    this._commit();
    return { ok: true, target: "chain", ...this.anchorTiltDeg() };
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
    this._notify({ collision: false });
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
    this._notify({ collision: false });
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

  /**
   * Which other piece occupies this socket, if any. Same 1 m weld as
   * `_openConnectors` — seams are by position, not a stored link.
   * @returns {{ piece: object, end: "entry"|"exit"|"branch" } | null}
   */
  _socketMate(matrix, self) {
    if (!matrix) return null;
    const p = _CAP_P.setFromMatrixPosition(matrix);
    for (const o of this.pieces) {
      if (o === self) continue;
      if (o.connectorIn && _CAP_Q.setFromMatrixPosition(o.connectorIn).distanceTo(p) < HEAD_JOIN_EPS) {
        return { piece: o, end: "entry" };
      }
      if (o.connectorOut && _CAP_Q.setFromMatrixPosition(o.connectorOut).distanceTo(p) < HEAD_JOIN_EPS) {
        return { piece: o, end: "exit" };
      }
      for (const b of o.branches ?? []) {
        if (_CAP_Q.setFromMatrixPosition(b.matrix).distanceTo(p) < HEAD_JOIN_EPS) {
          return { piece: o, end: "branch" };
        }
      }
    }
    return null;
  }

  _socketOccupied(matrix, self) {
    return !!this._socketMate(matrix, self);
  }

  _endTakesTubeCap(piece, end) {
    return !!(piece && pieceEndTakesTubeCap(piece.id, end, piece.pp, roadParams));
  }

  /** Occupied by another thick-wall mouth — the ring would z-fight. A road
   *  neighbour does not fill the 0.6 m cavity, so that does not count. */
  _spatialTubeWallMate(matrix, self) {
    const mate = this._socketMate(matrix, self);
    if (!mate || mate.end === "branch") return false;
    return this._endTakesTubeCap(mate.piece, mate.end);
  }

  _pieceHw(p) {
    if (p?.hw > 0) return p.hw;
    return p ? pieceHalfWidth(p.id, p.pp) : 0;
  }

  /** Does this neighbour's mouth cover `selfHw`? Wider leftover wings stay open
   *  unless the neighbour is as wide or wider. */
  _coversSlabMouth(neighbor, selfHw) {
    if (!(selfHw > 0) || !neighbor) return false;
    return this._pieceHw(neighbor) + SLAB_COVER_EPS >= selfHw;
  }

  /**
   * Neighbour fills this mouth: same (or wider) cut, same curl and lean, and
   * the raised kerb if this mouth has one. Width alone treated a held-bank U
   * as a nest against a flat straight; a platform (or Edges-Off) plate is
   * wider and flat but does not plug the kerb cavities.
   */
  _neighborFillsEnd(self, selfEnd, neighbor, neighborEnd) {
    if (!self || !neighbor || !pieceTakesSlabCaps(neighbor.id)) return false;
    if (!this._coversSlabMouth(neighbor, this._pieceHw(self))) return false;
    const nEnd = neighborEnd === "exit" ? "exit" : "entry";
    const sEnd = selfEnd === "exit" ? "exit" : "entry";
    if (Math.abs(pieceEndCurlM(neighbor.id, neighbor.pp, nEnd)
      - pieceEndCurlM(self.id, self.pp, sEnd)) > SLAB_CURL_EPS) return false;
    if (Math.abs(pieceEndLean(neighbor.id, neighbor.pp, nEnd)
      - pieceEndLean(self.id, self.pp, sEnd)) > SLAB_LEAN_EPS) return false;
    if (pieceHasRaisedKerbs(self) && !pieceHasRaisedKerbs(neighbor)) return false;
    return true;
  }

  /**
   * Lid any mouth the neighbour does not actually fill.
   * Equal-width joins still drop both lids when the cuts match. A wider piece
   * against a narrower one keeps its lid; a curled / rolled bank mouth against
   * a flat one keeps its lid too.
   */
  /**
   * Where this piece's exit WILL be once it is rebuilt at `conn`.
   *
   * `p.connectorOut` is only restamped AFTER the piece is built, so during a
   * rebuild walk it still holds the exit from before the chain moved. The cap
   * flags are decided BEFORE the build, and they ask "is another piece parked
   * on my exit?" — against a stale exit that lands on whatever now occupies the
   * old spot, which drops a lid that should have stayed. Undoing a delete at
   * the head of a chain did exactly this: every piece slid one length forward
   * and the tail lost its end lid (930 -> 900 verts, a see-through mouth).
   *
   * The piece's own entry→exit offset is already stamped and is unaffected by
   * the move, so `conn x outFromConn` is the exit it is about to have. Only
   * trusted while the shape is unchanged — otherwise the offset itself is stale
   * and `connectorOut` is no worse.
   */
  _prospectiveExit(p, conn) {
    const b = p._builtFrom;
    if (!conn || !b?.outFromConn) return p.connectorOut;
    if (b.id !== p.id || b.pp !== p.pp || !!b.edges !== !!(p.edges ?? true)) return p.connectorOut;
    return _CAP_M.copy(conn).multiply(b.outFromConn);
  }

  _slabCapFlags(p, conn) {
    if (!pieceTakesSlabCaps(p.id)) return { capEntry: false, capExit: false };
    const run = this._chainPieces(p.chainId);
    const i = run.indexOf(p);
    if (i < 0) return { capEntry: false, capExit: false };
    const prev = i > 0 ? run[i - 1] : null;
    const next = i < run.length - 1 ? run[i + 1] : null;
    const chainEntry = !p.detached && prev && !prev.detached
      && this._neighborFillsEnd(p, "entry", prev, "exit");
    const chainExit = !p.detached && next && !next.detached
      && this._neighborFillsEnd(p, "exit", next, "entry");
    const mateIn = this._socketMate(conn, p);
    const mateOut = this._socketMate(this._prospectiveExit(p, conn), p);
    return {
      capEntry: !chainEntry && !this._neighborFillsEnd(p, "entry", mateIn?.piece, mateIn?.end),
      capExit: !chainExit && !this._neighborFillsEnd(p, "exit", mateOut?.piece, mateOut?.end),
    };
  }

  /**
   * Tube wall rings: drop only when the facing mouth is also a wall.
   * Chain neighbours are consulted even before their matrices have walked
   * forward this rebuild (an insert would otherwise leave a leftover ring
   * on the piece processed first). Spatial occupancy still catches loops
   * and two chains butted together. A road neighbour keeps the ring.
   */
  _tubeCapFlags(p, conn) {
    if (!pieceTakesTubeCaps(p.id)) return { capEntry: false, capExit: false };
    const run = this._chainPieces(p.chainId);
    const i = run.indexOf(p);
    if (i < 0) return { capEntry: false, capExit: false };
    const prev = i > 0 ? run[i - 1] : null;
    const next = i < run.length - 1 ? run[i + 1] : null;
    const chainEntry = !p.detached && prev && !prev.detached && this._endTakesTubeCap(prev, "exit");
    const chainExit = !p.detached && next && !next.detached && this._endTakesTubeCap(next, "entry");
    return {
      capEntry: !chainEntry && !this._spatialTubeWallMate(conn, p),
      capExit: !chainExit && !this._spatialTubeWallMate(this._prospectiveExit(p, conn), p),
    };
  }

  _endCapFlags(p, conn) {
    if (pieceTakesSlabCaps(p.id)) return this._slabCapFlags(p, conn);
    if (pieceTakesTubeCaps(p.id)) return this._tubeCapFlags(p, conn);
    return { capEntry: false, capExit: false };
  }

  _ghostCapFlags() {
    const id = this.activePieceId;
    if (this.ghostDetached) {
      if (pieceTakesSlabCaps(id) || pieceTakesTubeCaps(id)) {
        return { capEntry: true, capExit: true };
      }
      return { capEntry: false, capExit: false };
    }
    const run = this._chainPieces(this.activeChainId);
    if (!run.length) {
      if (pieceTakesSlabCaps(id) || pieceTakesTubeCaps(id)) {
        return { capEntry: true, capExit: true };
      }
      return { capEntry: false, capExit: false };
    }
    if (pieceTakesSlabCaps(id)) {
      const ghost = {
        id,
        pp: this.activeParams,
        hw: pieceHalfWidth(id, this.activeParams),
        edges: guardrailParams.enabled,
      };
      if (this.ghostEnd === "head") {
        const host = run[0];
        return {
          capEntry: true,
          capExit: !this._neighborFillsEnd(ghost, "exit", host, "entry"),
        };
      }
      const host = run[run.length - 1];
      return {
        capEntry: !this._neighborFillsEnd(ghost, "entry", host, "exit"),
        capExit: true,
      };
    }
    if (pieceTakesTubeCaps(id)) {
      // Keep the ring unless the mouth we are about to mate is also a wall.
      if (this.ghostEnd === "head") {
        return { capEntry: true, capExit: !this._endTakesTubeCap(run[0], "entry") };
      }
      return { capEntry: !this._endTakesTubeCap(run[run.length - 1], "exit"), capExit: true };
    }
    return { capEntry: false, capExit: false };
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
      this._applyGizmoSuspend();
      this._applyGizmoAxes();
    }
    this._refreshBranchMarkers();
    this.refreshGhost();
  }

  // ── LATERAL SNAP (side-by-side pieces) ─────────────────────────────────────
  // Snapping a copy of a piece one deck-width across turns two ramps into one
  // wide ramp. The whole feature is a CONNECTOR POSE, exactly like a junction
  // branch: `world = currentConnector * entryLocal^-1`, so feeding buildPiece an
  // entry seam shifted along its own X gives the same piece, same orientation,
  // one width over. Nothing about the chain model or the save format changes —
  // a lateral neighbour is simply a new chain that happens to start beside an
  // old one.
  //
  // WHY THIS IS NOT A BRANCH. Branches are enumerated by branchConnectors(),
  // which is O(pieces x branches x chains x chain-length) and runs on EVERY
  // pointer move via aimAtCursor. That is affordable only because junctions are
  // rare. Publishing two sockets on every piece would put ~400k operations on
  // each mouse move of a 200-piece track, so side sockets are never enumerated
  // globally — they are derived on demand for the ONE piece under the cursor.

  /** Is `p` something a neighbour can sit beside at all? */
  _lateralWidth(p) {
    return p && isLaterallyTileable(p.id) && p.hw > 0 ? p.hw * 2 : 0;
  }

  /**
   * Centre-to-centre distance from `p` to a neighbour placed beside it.
   *
   * Their two half-widths, NOT twice one of them: `narrow` (hw 4) beside
   * `straight` (hw 8) must land 12 m over, and 2*p.hw would leave a 4 m seam.
   * Falls back to the piece's own width until the ghost has been built once.
   */
  _lateralOffset(p) {
    const gw = this._ghostHw > 0 ? this._ghostHw : p.hw;
    return p.hw + gw;
  }

  /**
   * The two side sockets of one placed piece: its entry seam translated a full
   * width along its own lateral axis, orientation untouched.
   * @returns {{side:"left"|"right", matrix:THREE.Matrix4, piece:object}[]}
   */
  lateralSockets(p) {
    const W = this._lateralWidth(p);
    if (!W) return [];
    // The seam BEFORE any tilt would put the neighbour somewhere the piece is
    // not; connectorIn is where the piece actually sits.
    const d = this._lateralOffset(p);
    return [-1, 1].map((s) => ({
      side: s < 0 ? "left" : "right",
      piece: p,
      matrix: p.connectorIn.clone().multiply(new THREE.Matrix4().makeTranslation(s * d, 0, 0)),
    }));
  }

  /**
   * Which side socket the cursor is over, or null.
   *
   * Deliberately only fires in the OUTER HALF of a piece: pointing at the
   * middle of the road means "I am looking at the road", and hijacking the
   * ghost there would make it skitter sideways whenever the cursor crossed the
   * track. Pointing at its edge is an unambiguous "put one next to this".
   */
  lateralAimAt(clientX, clientY) {
    if (!this._camera || !this._domElement) return null;
    const rect = this._domElement.getBoundingClientRect();
    this._pickNdc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this._raycaster.setFromCamera(this._pickNdc, this._camera);
    this.root.updateMatrixWorld(true);
    // Reused, not reallocated — this runs on every pointer move.
    const targets = (this._lateralPickTargets ??= []);
    targets.length = 0;
    for (const p of this.pieces) {
      if (this._lateralWidth(p) && p.mesh?.geometry?.attributes?.position) targets.push(p.mesh);
    }
    if (!targets.length) return null;
    for (const h of this._raycaster.intersectObjects(targets, false)) {
      const p = h.object.userData.piece;
      if (!p) continue;
      const W = this._lateralWidth(p);
      if (!W) continue;
      // Hit point in the piece's own entry frame: x is lateral, by construction
      // of socketMatrix (x = up cross z).
      const local = _A_V.copy(h.point).applyMatrix4(_A_M.copy(p.connectorIn).invert());
      const half = W / 2;
      if (Math.abs(local.x) < half * LATERAL_EDGE_FRACTION) return null; // middle of the road
      const side = local.x < 0 ? -1 : 1;
      const d = this._lateralOffset(p);
      return {
        side: side < 0 ? "left" : "right",
        piece: p,
        matrix: p.connectorIn.clone().multiply(new THREE.Matrix4().makeTranslation(side * d, 0, 0)),
      };
    }
    return null;
  }

  /** Park the ghost on a side socket. Detached, so place() forks a new chain
   *  beside the piece — the same mechanism a junction branch uses. */
  _putGhostOnLateral(sock) {
    this._gizmoTarget = "ghost";
    this.ghostEnd = "tail";
    this.ghostDetached = true;
    this.ghostOnBranch = false;
    this.ghostOnLateral = true;
    this.lateralNeighbour = sock;
    this._ghostPos.setFromMatrixPosition(sock.matrix);
    _A_M.extractRotation(sock.matrix);
    this._ghostQuat.setFromRotationMatrix(_A_M);
    this.freeYaw = this._ghostYaw = _A_E.setFromQuaternion(this._ghostQuat, "YXZ").y;
    if (this.placementGizmo) {
      this.placementPivot.position.copy(this._ghostPos);
      this.placementPivot.quaternion.copy(this._ghostQuat);
      this.placementGizmo.attach(this.placementPivot);
      this._applyGizmoSuspend();
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
    // NO OPEN END IN RANGE ⇒ ARE WE POINTING AT THE SIDE OF A PIECE?
    //
    // Deliberately a fallback and not a peer: an open end is always the more
    // likely intent, and the raycast is the more expensive test, so it only
    // runs when the cheap screen-space search has already come up empty.
    if (!best) {
      if (!this.lateralSnapEnabled) return false;
      const sock = this.lateralAimAt(clientX, clientY);
      if (!sock) return false;
      const lkey = `lateral|${sock.piece.uid}|${sock.side}`;
      if (lkey === this._lastAimKey) return false;
      this._lastAimKey = lkey;
      this._putGhostOnLateral(sock);
      return true;
    }

    const key = `${best.oc.chainId}|${best.oc.end}|${
      best.oc.branch ? best.oc.branch.pos.toArray().join(",") : ""}`;
    if (key === this._lastAimKey) return false; // same end, nothing to redraw
    this._lastAimKey = key;
    this._clearLateral();
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
        this._notify({ collision: false });
        return true;
      }
    }
    // Not on a branch yet: the nearest one to where you are building is the
    // right first answer.
    const from = new THREE.Vector3().setFromMatrixPosition(this.currentConnector);
    let best = free[0];
    for (const b of free) if (b.pos.distanceTo(from) < best.pos.distanceTo(from)) best = b;
    this._putGhostOnBranch(best.matrix);
    this._notify({ collision: false });
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
    // Turning the ghost by hand takes it off the side socket too: the socket's
    // whole meaning is "parallel to that piece", which a yaw edit contradicts.
    this._clearLateral();
  }

  /** Forget the side socket the ghost was parked on. */
  _clearLateral() {
    this.ghostOnLateral = false;
    this.lateralNeighbour = null;
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
    // attach() always sets the helper visible. Drive mode still wants the
    // pivot parked on the open end (B back to build should land there), but
    // not the arrows — see deselectPiece / toggleMode.
    if (!this.isBuildMode()) {
      this._hidePlacementGizmo();
      return;
    }
    this.placementGizmo.attach(this.placementPivot);
    this._applyGizmoSuspend();
    this._applyGizmoAxes();
  }

  /**
   * Put the placement handles down while a PROP BRUSH owns the pointer, without
   * losing the chain/piece the gizmo is on.
   *
   * TransformControls' pickers are invisible meshes far fatter than the drawn
   * arrows, scaled to a constant screen size (`factor * size / 4`, i.e.
   * 0.2375 * size * canvasHeight px per gizmo unit). At size 1.15 on a 900 px
   * canvas the arms reach ~147 px and are ~49 px thick — and merely HOVERING one
   * sets `axis`, which is what isUsingPlacementGizmo() reports and what makes
   * roadGame refuse the place-click. Dropping a cone next to the build cursor was
   * therefore impossible.
   */
  suspendGizmo(on) {
    this._gizmoSuspended = !!on;
    if (!this.placementGizmo) return;
    // pointerHover early-returns while disabled, so an axis the pointer was
    // already over would stay latched and keep eating clicks.
    if (on) this.placementGizmo.axis = null;
    this._applyGizmoSuspend();
  }

  /** Push the suspend state onto the gizmo — `attach()` always shows the helper. */
  _applyGizmoSuspend() {
    const g = this.placementGizmo;
    if (!g) return;
    const live = g.object != null && !this._gizmoSuspended && this.isBuildMode();
    // `enabled` BEFORE `visible`: writing `enabled` dispatches TransformControls'
    // "change", and _onPlacementGizmoChange gates on `visible` to ignore exactly
    // that setup traffic. Flipping the order would let the show-time event
    // through as if it were a drag.
    g.enabled = live;
    // NOT a TransformControls property — a flag of ours that rides along on the
    // controls object, and the one _onPlacementGizmoChange reads. The HELPER is
    // what actually hides the arrows (and what roadGame's syncGizmoAttachment
    // watches to keep an idle gizmo out of updateMatrixWorld).
    g.visible = live;
    g.getHelper().visible = live;
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
    if (!this.isBuildMode()) {
      this._hidePlacementGizmo();
      return;
    }
    this.placementGizmo.attach(this.placementPivot);
    this._applyGizmoSuspend();
    this._applyGizmoAxes();
  }

  _hidePlacementGizmo() {
    if (!this.placementGizmo) return;
    this.placementGizmo.detach();
    this.placementGizmo.enabled = false;
    this.placementGizmo.visible = false; // read by _onPlacementGizmoChange
    this.placementGizmo.getHelper().visible = false;
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

    this.rebuildAll({ reuse: true });
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
      this.rebuildAll({ reuse: true });
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
    this.rebuildAll({ reuse: true });
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
    this.rebuildAll({ reuse: true });
  }

  /** Reset the active chain's anchor tilt to level (keeps position + yaw). */
  levelAnchor() {
    if (!this.freePlaceMode) return false;
    this._freeQuat.setFromAxisAngle(_YUP, this.freeYaw);
    if (this.placementGizmo) this.placementPivot.quaternion.copy(this._freeQuat);
    const chain = this._activeChain();
    if (chain) { chain.anchor = this._anchorFromFree(); this.rebuildAll({ reuse: true }); }
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

  /**
   * Re-pose the translucent ghost at the open connector (or the detached pose).
   *
   * MOVING THE GHOST IS A MATRIX WRITE, NOT A REBUILD. This used to call a full
   * `buildPiece` and keep only `geometry`, and it is called from ~24 places —
   * including the end of `rebuildAll`, which the placement gizmo's `change`
   * event fires EVERY FRAME of a drag. So dragging a piece rebuilt its deck,
   * its guardrail, that rail's collision stand-in, that rail's mirror image, the
   * tunnel shell, the decor overlay, the glazing and the deck collision proxy,
   * sixty times a second, and threw all but the deck away.
   *
   * Measured (tools/perfAudit2.mjs): 2.7 ms a frame for a straight, 10.1 ms for
   * a loop, 84–99% of it guardrail the ghost does not even have.
   *
   * Two independent halves, both needed:
   *
   *   `deckOnly` stops building what is discarded          → 9–90× (kit-side)
   *   this memo stops rebuilding what has not changed      → the rest
   *
   * The memo is the one that matters for a DRAG. A drag moves the connector and
   * changes nothing else, and geometry is connector-independent, so every frame
   * after the first is `world = conn · fromConn` and a matrix copy. It also
   * stops handing three a brand-new BufferGeometry every frame, which on WebGPU
   * means a new vertex buffer and a new bind group every frame — the same churn
   * `_rebuildInstances` was guilty of.
   *
   * Keyed by VALUE, not by object identity, matching `_localTransform` above:
   * `toggleCurveDirection` mutates `activeParams` in place, so a reference key
   * would miss the one edit most likely to be spammed from the keyboard.
   */
  refreshGhost() {
    const conn = this._placementConnector();
    const edges = guardrailParams.enabled;
    const caps = this._ghostCapFlags();
    const key = `${this.activePieceId}|${edges ? 1 : 0}|${caps.capEntry ? 1 : 0}${caps.capExit ? 1 : 0}|${JSON.stringify(this.activeParams)}`;

    let hit = this._ghostGeoCache.get(key);
    if (!hit) {
      // Built at IDENTITY so `world` comes back as the piece-local entry
      // transform directly — no inverse needed to recover `fromConn`.
      const built = buildPiece(
        this.activePieceId,
        _IDENTITY,
        this.activeParams,
        roadParams,
        guardrailParams,
        edges,
        { deckOnly: true, ...caps },
      );
      // `hw` rides along because the lateral snap needs the GHOST's half-width
      // as well as the neighbour's: the gap between two pieces of different
      // widths is p.hw + ghost.hw, and using 2*p.hw would silently leave a
      // seam (or an overlap) whenever they differ — `narrow` beside `straight`.
      hit = { geometry: built.geometry, fromConn: built.world.clone(), hw: built.hw ?? null };
      // Bounded for the same reason `_localXfCache` is: params change
      // continuously while a slider is dragged. Never evict what is on screen.
      if (this._ghostGeoCache.size > 32) this._evictGhostGeoCache();
      this._ghostGeoCache.set(key, hit);
    }

    this._ghostHw = hit.hw;
    // NOT disposed — it belongs to the cache, and the ghost is only borrowing.
    this.ghost.geometry = hit.geometry;
    this.ghost.matrix.copy(conn).multiply(hit.fromConn);
    this.ghost.visible = this.isBuildMode();

    // FREE THE ORPHAN LAST, AND READ IT HERE RATHER THAN AT THE TOP.
    //
    // An eviction parks the geometry the ghost was mid-draw of (see
    // _evictGhostGeoCache), and eviction can happen inside THIS call — the miss
    // branch above trips the size cap. Latching the pointer on entry would then
    // leave `_ghostOrphanGeo` still holding a buffer this call already freed,
    // and the next refresh would free it a second time. Reading it after the
    // swap means the pointer and the release always come from the same moment.
    //
    // The identity test is what makes it safe at all: the ghost is pointed at
    // `hit.geometry` two lines up, so anything else is genuinely unreachable.
    const orphan = this._ghostOrphanGeo;
    this._ghostOrphanGeo = null;
    if (orphan && orphan !== this.ghost.geometry) orphan.dispose();
  }

  /**
   * Empty the ghost memo.
   *
   * EVERY entry leaves the map, including the one currently on screen — a
   * survivor would be handed straight back by the `refreshGhost` that follows,
   * which is the whole reason the cache is being dropped. Its BUFFER cannot go
   * with it (the ghost is still drawing it this instant), so it is parked in
   * `_ghostOrphanGeo` and freed at the end of the next `refreshGhost`, once the
   * ghost has been pointed at something else.
   */
  _evictGhostGeoCache() {
    const live = this.ghost?.geometry;
    for (const v of this._ghostGeoCache.values()) {
      if (v.geometry === live) this._ghostOrphanGeo = v.geometry;
      else v.geometry.dispose();
    }
    this._ghostGeoCache.clear();
  }

  /**
   * Forget every memo derived from the GLOBAL road/guardrail params.
   *
   * Neither cache key can see `roadParams` or `guardrailParams` — they are
   * module state in the kit, not arguments — so a width or kerb change makes
   * both stale. `rebuildAll()` without `reuse` is exactly the signal that
   * something global moved (see the note on its `reuse` flag), so it clears
   * them there rather than every caller having to remember.
   */
  _invalidateShapeCaches() {
    this._localXfCache.clear();
    this._evictGhostGeoCache();
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
   * Glow stroke material + kind for a piece. Vault LEDs, start gantry (green)
   * and finish gantry (pink) share the decorGlow mesh slot, so the kind is what
   * instancing and drive-mode merge key off.
   */
  _glowKind(def) {
    if (def?.shell === "vault") return "tunnel";
    if (def?.game === "finish" || def?.game === "finish_new") return "finish";
    if (def?.game === "checkpoint_new") return "checkpoint";
    return null;
  }

  _glowMaterial(def) {
    const kind = this._glowKind(def);
    if (kind === "tunnel") return this.tunnelGlowMaterial || this.decorGlowMaterial;
    if (kind === "finish") return this.finishGlowMaterial || this.decorGlowMaterial;
    if (kind === "checkpoint") return this.checkpointGlowMaterial || this.decorGlowMaterial;
    return this.decorGlowMaterial;
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
      for (const m of [p.mesh, p.railMesh, p.shellMesh, p.decorMesh, p.decorGateMesh, p.decorGlowMesh, p.glassMesh]) {
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
    if (!this.instancingEnabled) {
      this._dropInstances(); // proxies render directly instead
      return;
    }

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
      add(p.mesh, this._deckMaterial(p.id), this._isTubePiece(p.id) ? "tube" : "road");
      add(p.railMesh, this.railMaterial, "rail");
      add(p.shellMesh, p.shellMesh?.userData.vault ? this.vaultShellMaterial : this.shellMaterial,
        p.shellMesh?.userData.vault ? "vaultShell" : "shell");
      add(p.decorMesh, this.decorMaterial, "decor");
      add(p.decorGateMesh, this.decorGateMaterial, "decorGate");
      add(p.decorGlowMesh, this._glowMaterial(PIECE_BY_ID.get(p.id)),
        p.decorGlowMesh?.userData.glowKind === "tunnel" ? "tunnelGlow"
          : p.decorGlowMesh?.userData.glowKind === "finish" ? "finishGlow"
            : p.decorGlowMesh?.userData.glowKind === "checkpoint" ? "checkpointGlow"
              : "decorGlow");
      add(p.glassMesh, this.glassMaterial, "glass");
    }
    // ── REUSE THE BATCHES, REWRITE THE MATRICES ──────────────────────────────
    //
    // This used to dispose every InstancedMesh and build a fresh set on each
    // call — and it is called from the end of `rebuildAll`, which the placement
    // gizmo drives EVERY FRAME of a drag. So a drag destroyed and recreated all
    // ~30-50 batches sixty times a second.
    //
    // On WebGPU that is worse than the allocation it looks like. A new
    // InstancedMesh is a new instance buffer, which means a new GPU buffer and a
    // new bind group, per batch, per frame — the backend has to re-record work
    // it had already prepared, and there is nothing to reuse across the frame
    // boundary because the objects it was keyed on no longer exist.
    //
    // A drag changes only WHERE the pieces are. Geometry identity is stable
    // (`_relocatePiece` restamps matrices and never touches `p.mesh.geometry`),
    // so the grouping is stable too, and the whole update collapses to writing
    // the same matrices into buffers that are already there.
    //
    // A batch is reusable when its geometry AND material are the same objects
    // and its buffer is big enough. Anything else — a piece replaced, the kerbs
    // toggled, a remesh from a width change — falls back to building it, which
    // is the old path and is still correct.
    const keep = new Set();
    for (const [key, grp] of groups) {
      const n = grp.mats.length;
      let im = this._instByKey.get(key);
      const capacity = im?.instanceMatrix?.count ?? 0;
      if (!im || im.geometry !== grp.geometry || im.material !== grp.material || capacity < n) {
        if (im) { this.instGroup.remove(im); im.dispose(); }
        // SLACK, so appending one piece to a chain does not reallocate the whole
        // batch — placing pieces one after another is the single most common
        // thing anyone does in here.
        im = new THREE.InstancedMesh(grp.geometry, grp.material, n + INSTANCE_SLACK);
        im.matrixAutoUpdate = false; // root/instGroup at origin → instance mats are world
        im.frustumCulled = false; // a track spans a large area; skip per-mesh culling
        // Neither flat markings nor a window should cast — see the note where
        // the per-piece glass mesh is born.
        im.castShadow = grp.role !== "decor" && grp.role !== "glass";
        im.receiveShadow = true;
        this.instGroup.add(im);
        this._instByKey.set(key, im);
      }
      for (let i = 0; i < n; i++) im.setMatrixAt(i, grp.mats[i]);
      // Draw only the live ones; the slack tail is allocated, not rendered.
      im.count = n;
      im.instanceMatrix.needsUpdate = true;
      keep.add(key);
    }

    // Batches whose shape no longer exists on the track at all.
    for (const [key, im] of this._instByKey) {
      if (keep.has(key)) continue;
      this.instGroup.remove(im);
      im.dispose();
      this._instByKey.delete(key);
    }

    this._instMeshes.length = 0;
    for (const im of this._instByKey.values()) this._instMeshes.push(im);
  }

  /** Tear every instanced batch down — instancing switched off, or a clear. */
  _dropInstances() {
    for (const im of this._instByKey.values()) {
      this.instGroup.remove(im);
      im.dispose();
    }
    this._instByKey.clear();
    this._instMeshes.length = 0;
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
    const mesh = this._makeMesh(built.geometry, this._deckMaterial(id), built.world);
    // Deck collision proxy — half tubes strip rim caps; full tubes keep the
    // uncapped sweep so the new end rings are visual-only.
    // Same three-birth-sites rule as the rail proxy below.
    mesh.userData.collisionGeometry = built.deckCollision ?? null;
    // ROAD YOU FOLLOW — the deck BVH bakes this into a per-vertex tag, and the
    // car uses it to decide whether it may stick to a convex crest instead of
    // being launched off it. Stamped here because this is the one place that
    // knows both the piece id and the mesh. See FOLLOW_ROAD in the kit and
    // ROAD_HOLD in the vehicle.
    mesh.userData.roadHold = isFollowRoad(id);
    const railMesh =
      built.railGeometry && this.railMaterial
        ? this._makeMesh(built.railGeometry, this.railMaterial, built.world)
        : null;
    // The cheap stand-in the BVH bakes instead of the rail you can see — rides
    // along on the mesh so nothing downstream needs a new field to plumb.
    if (railMesh) railMesh.userData.collisionGeometry = built.railCollision ?? null;
    // NOTHING HOLDS A MIRRORED RAIL any more. It used to ride along here for the
    // life of the piece — 280,330 vertices across a track, ~8.5 MB, sampled only
    // while the road is wet AND only while driving (see buildPiece's note). It is
    // now built on demand by `buildMirrorRails` and thrown away after the merge.
    // ...and the POSTS, which are poses rather than geometry now — see
    // `railPosts` in buildPiece. They ride on the piece rather than the mesh
    // because roadGame draws them from `builder.pieces`, in both modes, and the
    // per-piece rail mesh is hidden while driving.
    if (railMesh) railMesh.userData.railPosts = built.railPosts ?? null;
    const shellMat = built.def.shell === "vault"
      ? (this.vaultShellMaterial || this.shellMaterial)
      : this.shellMaterial;
    const shellMesh = built.shellGeometry && shellMat
      ? this._makeMesh(built.shellGeometry, shellMat, built.world)
      : null;
    if (shellMesh && built.def.shell === "vault") shellMesh.userData.vault = true;
    if (shellMesh) shellMesh.userData.collisionGeometry = built.shellCollision ?? null;
    const decorMesh =
      built.decorGeometry && this.decorMaterial
        ? this._makeMesh(built.decorGeometry, this.decorMaterial, built.world)
        : null;
    if (decorMesh) decorMesh.castShadow = false; // flat markings don't cast
    const decorGateMesh =
      built.decorGateGeometry && this.decorGateMaterial
        ? this._makeMesh(built.decorGateGeometry, this.decorGateMaterial, built.world)
        : null;
    if (decorGateMesh) {
      decorGateMesh.castShadow = true;
      decorGateMesh.receiveShadow = false;
    }
    const glowMat = this._glowMaterial(built.def);
    const decorGlowMesh = built.decorGlowGeometry && glowMat
      ? this._makeMesh(built.decorGlowGeometry, glowMat, built.world)
      : null;
    if (decorGlowMesh) {
      decorGlowMesh.castShadow = false;
      decorGlowMesh.receiveShadow = false;
      decorGlowMesh.userData.isGlow = true;
      const kind = this._glowKind(built.def);
      if (kind) decorGlowMesh.userData.glowKind = kind;
    }
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
      decorGateMesh,
      decorGlowMesh,
      glassMesh,
      connectorIn: connectorIn.clone(),
      connectorOut: built.connectorOut.clone(),
      /** Junction side sockets in WORLD space (empty for every other piece). */
      branches: built.branchesOut ?? [],
      /** Half-width of the section this piece swept — the lateral snap offsets
       *  a neighbour by 2*hw, and `narrow` (8 m) and `platform` (44 m) are not
       *  the global road width. Null on pieces that build their own plate. */
      hw: built.hw ?? null,
      /** Per-piece entry tilt (local-frame rotation, propagates downstream). */
      tilt: new THREE.Quaternion(),
      /** Entry seam BEFORE the tilt — filled by rebuildAll, used by the edit gizmo. */
      _baseIn: connectorIn.clone(),
      /** Free-placed? Then `pinnedIn` replaces the chain's running connector. */
      detached: false,
      /** @type {THREE.Matrix4|null} absolute entry seam while detached. */
      pinnedIn: null,
    };
    for (const m of [mesh, railMesh, shellMesh, decorMesh, decorGateMesh, decorGlowMesh, glassMesh]) {
      if (m) m.userData.piece = piece;
    }
    this._applyPiecePresence(piece);
    // Record what this geometry was built FROM, exactly as rebuildAll does.
    // Without it a freshly placed piece looks un-built to the reuse check, so the
    // first restore after any placement rebuilds the whole track — measured as
    // undo costing 100–243 ms while redo, on identical data, cost 1 ms.
    piece._builtFrom = this._stampBuiltFrom(
      connectorIn, id, piece.pp, edges, built.world, built.connectorOut, built.branchesOut);
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
  /**
   * Swap the road material on every existing piece.
   *
   * Exists because the road's material CLASS is not fixed: a dry track runs on
   * MeshStandardNodeMaterial and a wet one on MeshPhysicalNodeMaterial, since
   * three only compiles the clearcoat lobe when `clearcoatNode` is set (see
   * createRoadMaterial). Turning the weather on therefore replaces the object,
   * not a uniform, and every piece has to be re-pointed at it.
   *
   * Routed through `_applyPiecePresence` rather than assigning `mesh.material`
   * directly so the gap-spacer rule survives the swap — those pieces wear
   * `gapMaterial` and must keep wearing it.
   */
  setRoadMaterial(material) {
    if (!material || material === this.material) return;
    this.material = material;
    for (const p of this.pieces) if (p.mesh) this._applyPiecePresence(p);
  }

  _isTubePiece(id) {
    return !!PIECE_BY_ID.get(id)?.tubeShader;
  }

  /** Deck draw material: gap marker, cheap tube shader, or the shared asphalt. */
  _deckMaterial(id) {
    if (PIECE_BY_ID.get(id)?.noMesh) return this.gapMaterial;
    if (this._isTubePiece(id) && this.tubeMaterial) return this.tubeMaterial;
    if (PIECE_BY_ID.get(id)?.hazardPad && this.hazardPadMaterial) return this.hazardPadMaterial;
    return this.material;
  }

  _applyPiecePresence(p) {
    const gap = !!PIECE_BY_ID.get(p.id)?.noMesh;
    p.mesh.userData.pieceId = p.id;
    p.mesh.userData.noCollision = gap;
    p.mesh.userData.noRender = gap;   // gap spacer: no road, no instance/merge
    p.mesh.material = this._deckMaterial(p.id);
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
        this.rebuildAll({ reuse: true });
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
    this._clearLateral();       // and the side socket is now occupied
    // Cap flags on the previous last piece change (it is no longer a free
    // end), and the new piece needs lids / rings. reuse skips the middles.
    this.rebuildAll({ reuse: true });
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

  /**
   * The same pick, but reporting HOW FAR the hit is — the road's answer to the
   * shared right-click arbiter (see roadGame). Props, movers, portals and this
   * all answer in the same shape and the nearest one wins, so a boost pad on a
   * road selects the pad and the deck beside it selects the road.
   */
  pickPieceHit(clientX, clientY) {
    if (!this._camera || !this._domElement) return null;
    const rect = this._domElement.getBoundingClientRect();
    this._pickNdc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this._raycaster.setFromCamera(this._pickNdc, this._camera);
    this.root.updateMatrixWorld(true);
    const targets = [];
    for (const p of this.pieces) {
      if (p.mesh?.geometry?.attributes?.position) targets.push(p.mesh);
      for (const m of [p.railMesh, p.shellMesh]) {
        if (m && !m.userData.noRender && m.geometry?.attributes?.position) targets.push(m);
      }
    }
    for (const h of this._raycaster.intersectObjects(targets, false)) {
      const piece = h.object.userData.piece;
      if (piece) return { dist: h.distance, hit: piece };
    }
    return null;
  }

  /** Highlight a placed piece and put the transform gizmo ON it (null clears).
   *  Focuses the piece's chain so appends/gizmo follow it. Rotate the gizmo (E)
   *  to tilt the piece + downstream; translate (W) to move the whole chain. */
  selectPiece(p) {
    this.selectedPiece = p && this.pieces.includes(p) ? p : null;
    this.selectedPieces = this.selectedPiece ? [this.selectedPiece] : [];
    if (this.selectedPiece) {
      this.activeChainId = this.selectedPiece.chainId;
      this._syncCurrentConnector();
      this._showPieceGizmo(this.selectedPiece);
    }
    this._updateSelectionHighlight();
    this._notify({ collision: false });
  }

  // ── SELECTING A SECTION ────────────────────────────────────────────────────
  // The editor had exactly two granularities: one piece, or a whole chain.
  // "This section" — the thing you actually want to delete, un-rail, or bank —
  // could not be said at all.
  //
  // A RANGE, not a pick-list, because a chain is a linear array: the pieces
  // between two indices IS the natural unit, and it takes one gesture instead of
  // one per piece. Ctrl+click is there for the odd exception.

  /**
   * Extend the selection to `p`, taking everything between it and the anchor.
   * Both have to be in the same chain — a "range" across two chains has no
   * meaning, so that falls back to a plain select rather than guessing.
   */
  selectRangeTo(p) {
    if (!p || !this.pieces.includes(p)) return false;
    const from = this.selectedPiece;
    if (!from || from.chainId !== p.chainId) { this.selectPiece(p); return true; }
    const run = this._chainPieces(p.chainId);
    const a = run.indexOf(from);
    const b = run.indexOf(p);
    if (a < 0 || b < 0) { this.selectPiece(p); return true; }
    this.selectedPieces = run.slice(Math.min(a, b), Math.max(a, b) + 1);
    // The anchor stays put, so Shift+clicking again re-measures from the same
    // end rather than walking away from it.
    this._updateSelectionHighlight();
    this._notify({ collision: false });
    return true;
  }

  /** Add or remove one piece from the selection (Ctrl+click). */
  toggleSelected(p) {
    if (!p || !this.pieces.includes(p)) return false;
    const i = this.selectedPieces.indexOf(p);
    if (i >= 0) {
      this.selectedPieces.splice(i, 1);
      if (this.selectedPiece === p) this.selectedPiece = this.selectedPieces[0] ?? null;
      if (!this.selectedPiece) { this.deselectPiece(); return true; }
      this._showPieceGizmo(this.selectedPiece);
    } else {
      if (!this.selectedPiece) return this.selectPiece(p), true;
      this.selectedPieces.push(p);
    }
    this._updateSelectionHighlight();
    this._notify({ collision: false });
    return true;
  }

  /** The selection in CHAIN ORDER, which is the order every bulk op needs. */
  _selectionInOrder() {
    const byChain = new Map();
    for (const p of this.selectedPieces) {
      if (!byChain.has(p.chainId)) byChain.set(p.chainId, this._chainPieces(p.chainId));
    }
    return [...this.selectedPieces].sort((x, y) => {
      if (x.chainId !== y.chainId) return x.chainId - y.chainId;
      return byChain.get(x.chainId).indexOf(x) - byChain.get(y.chainId).indexOf(y);
    });
  }

  get selectionCount() {
    return this.selectedPieces.length;
  }

  deselectPiece() {
    if (!this.selectedPiece && !this.selectedPieces.length) return;
    this.selectedPiece = null;
    this.selectedPieces = [];
    this._updateSelectionHighlight();
    // Park the cursor on the open end so B-back-to-build is coherent. In build
    // mode that also summons the helper (Escape = stop editing, go back to
    // placing). In drive mode _showGizmoAt/_showPlacementGizmo refuse to
    // attach — attach() always shows the helper, which is how a selected piece
    // used to leave arrows on screen for the whole race.
    this._syncGizmoToOpenEnd();
    if (!this.isBuildMode()) this._hidePlacementGizmo();
    this._notify({ collision: false });
  }

  /** Attach the transform gizmo to a selected piece, at its entry connector. */
  _showPieceGizmo(p) {
    if (!this.placementGizmo) return;
    if (!this.isBuildMode()) return;
    this._gizmoTarget = "piece";
    this.ghostDetached = false;
    this.placementPivot.position.setFromMatrixPosition(p.connectorIn);
    _A_M.extractRotation(p.connectorIn);
    this.placementPivot.quaternion.setFromRotationMatrix(_A_M);
    this.placementGizmo.attach(this.placementPivot);
    this._applyGizmoSuspend();
    this._applyGizmoAxes();
  }

  /** A translucent gold overlay of the exact selected piece, drawn on top
   *  (depthTest off) so it reads through other geometry. Shares the piece's
   *  geometry — never disposes it. */
  _updateSelectionHighlight() {
    if (!this._selGroup) {
      this._selGroup = new THREE.Group();
      this._selGroup.name = "ModularRoadSelection";
      this.scene.add(this._selGroup);
      // Two materials: the ANCHOR of the selection (the piece the gizmo is on,
      // and the one a range extends FROM) is brighter than the rest, so a
      // multi-piece selection still tells you where the next Shift+click will
      // measure from.
      this._selMatAnchor = new THREE.MeshBasicMaterial({
        color: 0xffd24a, transparent: true, opacity: 0.4,
        depthWrite: false, depthTest: false, side: THREE.DoubleSide,
      });
      this._selMatMember = new THREE.MeshBasicMaterial({
        color: 0xff9a3c, transparent: true, opacity: 0.26,
        depthWrite: false, depthTest: false, side: THREE.DoubleSide,
      });
    }
    const g = this._selGroup;
    const sel = this.selectedPieces.filter((p) => p.mesh?.geometry);
    // Pooled, like the end markers: a selection changes on every right-click and
    // allocating meshes per click would churn.
    while (g.children.length > sel.length) g.remove(g.children[g.children.length - 1]);
    while (g.children.length < sel.length) {
      const m = new THREE.Mesh(_EMPTY_GEO, this._selMatMember);
      m.matrixAutoUpdate = false;
      m.renderOrder = 999;
      m.frustumCulled = false;
      g.add(m);
    }
    for (let i = 0; i < sel.length; i++) {
      const m = g.children[i];
      m.geometry = sel[i].mesh.geometry; // SHARED — never dispose these
      m.matrix.copy(sel[i].mesh.matrix);
      m.material = sel[i] === this.selectedPiece ? this._selMatAnchor : this._selMatMember;
      m.visible = true;
    }
    g.visible = sel.length > 0;
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
    this.rebuildAll({ reuse: true });
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
    this.rebuildAll({ reuse: true });
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
    this.rebuildAll({ reuse: true });
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
    this.rebuildAll({ reuse: true });
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
    this.rebuildAll({ reuse: true });
    if (this.selectedPiece === p) this._updateSelectionHighlight();
    this._commit();
    return true;
  }

  /** Reset a piece's tilt to none (downstream re-levels from here). */
  levelPiece(p) {
    if (this.pieces.indexOf(p) < 0) return false;
    p.tilt.identity();
    this.rebuildAll({ reuse: true });
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
    this.rebuildAll({ reuse: true });
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
      p.shellMesh.userData.collisionGeometry?.dispose();
    }
    if (p.decorMesh) {
      this.root.remove(p.decorMesh);
      p.decorMesh.geometry.dispose();
    }
    if (p.decorGateMesh) {
      this.root.remove(p.decorGateMesh);
      p.decorGateMesh.geometry.dispose();
    }
    if (p.decorGlowMesh) {
      this.root.remove(p.decorGlowMesh);
      p.decorGlowMesh.geometry.dispose();
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

  /**
   * Put a non-road layer (props / movers / portals) under this history.
   *
   * @param {string} name stable key — it is what a snapshot stores the layer under
   * @param {object} o
   * @param {() => any} o.capture serialize the layer (the manager's export*)
   * @param {(v:any) => void} o.restore put a captured value back (the manager's import*)
   * @param {() => void} [o.clear] wipe the layer for `clearAll()`
   * @param {() => number} [o.count] how many objects it holds, for `trackCounts()`
   */
  registerHistoryLayer(name, { capture, restore, clear = null, count = null }) {
    if (this._histLayers.some((l) => l.name === name)) return;
    this._histLayers.push({ name, capture, restore, clear, count, cache: null, dirty: true });
    // The baseline was seeded in the constructor, BEFORE this layer existed, so
    // its `layers` has no entry for it. Left alone, the first prop edit would
    // commit a baseline whose props are `undefined`, and undoing back to it
    // would restore nothing — the layer would silently sit outside history for
    // exactly one step. Re-capture so the starting state is complete.
    if (this._baseline) this._baseline.layers = this._captureLayers();
  }

  /**
   * A registered layer changed — record it as an edit.
   *
   * This is what the managers' `onChange` calls. It must run at the END of a
   * user-visible edit for the same reason `_commit` does: a gizmo drag that
   * committed every frame would bury the stack.
   */
  commitLayerEdit(name) {
    // Mid-undo. The manager is only firing because WE just restored it.
    if (this._histRestoring) return;
    const layer = this._histLayers.find((l) => l.name === name);
    if (!layer) return;
    layer.dirty = true;
    this._commit();
  }

  /** True while an undo/redo is being applied — for callers whose change
   *  handlers want to skip work the undo itself will do once at the end. */
  get isRestoringHistory() { return this._histRestoring; }

  /** Serialize every layer that says it changed; reuse the rest by reference. */
  _captureLayers() {
    if (!this._histLayers.length) return null;
    const out = {};
    for (const layer of this._histLayers) {
      if (layer.dirty) {
        const next = layer.capture();
        // KEEP THE OLD REFERENCE when the data is identical. A gizmo mouseUp
        // with no drag reports a change but moved nothing; holding the previous
        // array is what makes `_sameLayers` see "no edit" and fold the commit
        // away, instead of pushing a step that undoes to the same picture.
        if (!plainEqual(layer.cache, next)) layer.cache = next;
        layer.dirty = false;
      }
      out[layer.name] = layer.cache;
    }
    return out;
  }

  /** Reference compare per layer — see the `dirty`/`cache` note in the ctor. */
  _sameLayers(a, b) {
    for (const layer of this._histLayers) {
      if (a?.layers?.[layer.name] !== b?.layers?.[layer.name]) return false;
    }
    return true;
  }

  /**
   * Re-import only the layers that actually differ from what is on screen.
   *
   * The skip matters: `importInstances` disposes and re-`make()`s every instance
   * in the layer, so restoring all three on every undo would rebuild hundreds of
   * props to undo a road piece that never touched them.
   */
  _restoreLayers(snap) {
    if (!snap.layers) return;
    for (const layer of this._histLayers) {
      const v = snap.layers[layer.name];
      if (v === undefined) continue;
      // `dirty` means the layer moved since we last serialized it, so `cache` is
      // stale and cannot vouch for what is on screen — restore regardless.
      if (!layer.dirty && layer.cache === v) continue;
      layer.restore(v);
      // Set AFTER the restore: the manager's change callback fires from inside
      // it, and `_histRestoring` is what stops that re-dirtying the layer.
      layer.cache = v;
      layer.dirty = false;
    }
  }

  /** True when two snapshots describe the same TRACK — cursor ignored. Used to
   *  keep cursor-only commits (every gizmo drag-end fires one) off the stack. */
  _sameStructure(a, b) {
    return this._sameRoad(a, b) && this._sameLayers(a, b);
  }

  /** True when two snapshots describe the same ROAD — layers and cursor ignored.
   *  Split out from `_sameStructure` so an undo can tell an object-only step
   *  from one that moved the track, and skip the road rebuild for the former. */
  _sameRoad(a, b) {
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
      // Props / movers / portals. Unchanged layers come back by reference, so
      // this line is free on the road edits that make up most commits.
      layers: this._captureLayers(),
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

  /**
   * Put the track back into a snapshotted state, rebuilding only what moved.
   *
   * @param {object} snap
   * @param {boolean} [restoreRoad] false for an OBJECT-ONLY step (a prop moved,
   *   nothing on the road did). Skipping the road there is not a micro-saving:
   *   `rebuildAll` ends in a full notify, and the listener's half of that is
   *   `applyRailReflectionMembers` — which world-bakes and merges every piece's
   *   mirrored rail, 280,330 vertices on rushline. Undoing a cone drag has no
   *   business re-merging the guardrails.
   */
  _restore(snap, restoreRoad = true) {
    const outer = this._histRestoring;
    this._histRestoring = true;
    try { this._restoreInner(snap, restoreRoad); } finally { this._histRestoring = outer; }
  }

  _restoreInner(snap, restoreRoad) {
    if (!restoreRoad) {
      // The cursor still travels with the step even when the road does not —
      // it is where the user WAS, and it is cheap.
      this._applyCursor(snap.cursor);
      this._showGizmoForCursor();
      this._restoreLayers(snap);
      return;
    }
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

    // AFTER the road, not before: a layer's restore fires the manager's change
    // callback, which is where the collision re-bake and the flag/physics
    // re-sync hang — and those should see the rebuilt deck, not the old one.
    this._restoreLayers(snap);
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
    // Force a fresh serialize of every layer. A load replaces the props and
    // movers wholesale, and the caller may well have imported them without ever
    // going through `commitLayerEdit` — so the cached arrays describe the
    // PREVIOUS track. Re-capturing costs one pass per layer, once per load, and
    // is what stops the new baseline from being a lie.
    for (const layer of this._histLayers) layer.dirty = true;
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
    const from = this._baseline ?? this._snapshot();
    this._redoStack.push(from);
    this._applyStep(from, this._undoStack.pop());
    return true;
  }

  redo() {
    if (!this._redoStack.length) return false;
    const from = this._baseline ?? this._snapshot();
    this._undoStack.push(from);
    this._applyStep(from, this._redoStack.pop());
    return true;
  }

  /**
   * Walk from one committed state to another — the shared half of undo/redo.
   *
   * `_baseline` is by contract what is on screen, so comparing it with the step
   * we are moving to says whether the ROAD is involved at all. An object-only
   * step (the common one once props are in history) then costs a layer import
   * and nothing else.
   */
  _applyStep(from, to) {
    const roadChanged = !this._sameRoad(from, to);
    this._restore(to, roadChanged);
    this._baseline = to;
    // `rebuildAll` fires its own full notify, so re-firing one here would merge
    // the mirror rails TWICE per undo. The one case it cannot cover is an undo
    // pressed mid-drag, where it deliberately passes `collision: false`.
    // Everything else only needs the cheap half — the status line and the rail
    // posts — since the geometry it would recompute did not move.
    const alreadySettled = !roadChanged || !this.placementGizmo?.dragging;
    this._notify(alreadySettled ? { collision: false } : {});
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

  /** What is on the track right now, split the way the user thinks about it:
   *  road pieces vs everything standing on them.
   *  @returns {{pieces:number, objects:number}} */
  trackCounts() {
    let objects = 0;
    for (const layer of this._histLayers) objects += layer.count?.() ?? 0;
    return { pieces: this.pieces.length, objects };
  }

  /**
   * WIPE THE WHOLE TRACK — road pieces AND every registered layer — as ONE undo
   * step. This is what the palette's "Clear track" button means.
   *
   * `clear()` stays road-only on purpose: `importTrackPieces`, `loadDemo`,
   * `loadBigCircuit` and `dispose` all call it as an internal "reset the
   * chains" step, and a load that wiped the props a moment before importing
   * them would be a race waiting to happen.
   *
   * @returns {{pieces:number, objects:number}} what was removed
   */
  clearAll() {
    const removed = this.trackCounts();
    // Out here, not inside: `clear()` does this itself, but `_asOneEdit` has
    // suspended history by then and `_markCursor` deliberately no-ops while
    // suspended — so the undo step would record the post-clear cursor.
    this._markCursor();
    // ONE entry, not one per layer: `clear()` commits, and so does every
    // manager's change callback, so without this a single button press would
    // cost four presses of Ctrl+Z to walk back.
    this._asOneEdit(() => {
      this.clear();
      for (const layer of this._histLayers) layer.clear?.();
    });
    return removed;
  }

  /**
   * Re-walk every chain and rebuild the pieces from it.
   *
   * Pieces are re-chained sequentially (each entry = the previous exit), so
   * moving a chain anchor or editing a piece flows down the rest of that chain.
   *
   * `reuse` skips `buildPiece` when a piece's shape is unchanged (id, params,
   * edges). Same entry seam ⇒ keep the mesh as-is. New entry seam ⇒ restamp
   * world matrices from the stored local pose (the deck is authored in piece
   * space; only the connector moved). That is what makes a prepend, a mid-chain
   * delete, or a tilt cheap: downstream pieces slide, they are not remeshed.
   *
   * OFF BY DEFAULT, deliberately. The signature cannot see `roadParams` or
   * `guardrailParams`, so a plain `rebuildAll()` — which is what every width,
   * kerb and rail slider calls — must still remesh unconditionally or the track
   * would silently ignore them. Only callers that know nothing global changed
   * pass `reuse`.
   */
  rebuildAll({ reuse = false } = {}) {
    // A full remesh is the one moment we know a GLOBAL param may have changed —
    // that is precisely why `reuse` defaults to false. The shape memos key on
    // piece id + params only and cannot see roadParams/guardrailParams, so this
    // is where they have to be dropped. See _invalidateShapeCaches.
    if (!reuse) this._invalidateShapeCaches();
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
        const caps = this._endCapFlags(p, conn);
        // Unchanged inputs ⇒ the geometry it already carries is still correct.
        // `pp` is compared by REFERENCE, which is sound because a piece's params
        // are cloned once at placement and never mutated afterwards.
        const b = p._builtFrom;
        const sameShape = reuse && b && b.id === p.id && b.edges === edges && b.pp === p.pp
          && !!b.capEntry === caps.capEntry && !!b.capExit === caps.capExit;
        if (sameShape && b.conn.equals(conn)) {
          conn = p.connectorOut.clone();
          continue;
        }
        if (sameShape && this._relocatePiece(p, conn)) {
          conn = p.connectorOut.clone();
          continue;
        }
        const built = buildPiece(p.id, conn, p.pp, roadParams, guardrailParams, edges, caps);
        this._applyBuilt(p, built);
        p.hw = built.hw ?? null; // params can change the section, so re-read it
        p.connectorOut = built.connectorOut.clone();
        p._builtFrom = this._stampBuiltFrom(
          conn, p.id, p.pp, edges, built.world, built.connectorOut, built.branchesOut, caps);
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
    // Live gizmo drags rebuild every frame. The BVH bake is the expensive half
    // and nothing drives on a stale tree mid-drag, so defer it until pointerup
    // (see dragging-changed). Palette / ghost notifies pass collision: false
    // themselves; this path is the one that actually moved the road.
    if (this.placementGizmo?.dragging) this._collisionDeferred = true;
    this._notify({ collision: !this.placementGizmo?.dragging });
  }

  /**
   * The mirrored guardrail for every piece, built HERE AND NOW.
   *
   * Transient by contract: the caller owns every geometry it gets back and must
   * dispose it. Nothing is cached, and nothing is kept on the pieces — that is
   * the whole point. A mirrored rail is 280,330 vertices across a 41-piece
   * track (ten times the visible rail, now the posts are instanced), it is only
   * sampled while the road is WET, and only while DRIVING, and the one consumer
   * merges the lot into a single mesh and never looks at the parts again.
   *
   * Returned with the piece's world matrix rather than pre-transformed so the
   * caller can bake it in place — it owns the geometry, so it does not need the
   * defensive clone the old path made.
   *
   * @returns {{geometry: THREE.BufferGeometry, matrix: THREE.Matrix4}[]}
   */
  buildMirrorRails() {
    const out = [];
    for (const p of this.pieces) {
      // A gap spacer draws no rail, so it reflects none either.
      if (!p.railMesh || p.railMesh.userData.noRender) continue;
      const built = buildPiece(
        p.id, p.connectorIn, p.pp, roadParams, guardrailParams, p.edges ?? true,
        { mirrorOnly: true },
      );
      // mirrorOnly still sweeps the deck (it is cheap and shares the frames),
      // so free it rather than leaking one per piece per pass.
      built.geometry?.dispose();
      if (built.railMirrorGeometry) {
        // matrixWorld, not matrix — `root` is at the origin today, so they agree,
        // but the old path read matrixWorld and there is no reason to make this
        // quietly depend on the root never moving. The caller refreshes it.
        out.push({
          geometry: built.railMirrorGeometry,
          matrix: p.railMesh.matrixWorld,
          // Posts, as poses. `posts.template` is the SHARED one — do not free it
          // with the geometry beside it.
          posts: built.railMirrorPosts,
        });
      }
    }
    return out;
  }

  /**
   * Local pose of a built piece, relative to the connector it was swept at.
   * `world = conn · fromConn`, so a later walk can restamp matrices without
   * calling buildPiece when only the chain moved.
   */
  _stampBuiltFrom(conn, id, pp, edges, world, connectorOut, branches, caps = {}) {
    const inv = conn.clone().invert();
    return {
      conn: conn.clone(),
      id,
      pp,
      edges,
      capEntry: !!caps.capEntry,
      capExit: !!caps.capExit,
      fromConn: inv.clone().multiply(world),
      outFromConn: inv.clone().multiply(connectorOut),
      branchFromConn: (branches ?? []).map((br) => inv.clone().multiply(br.matrix)),
    };
  }

  /**
   * Move an existing piece to a new entry seam without remeshing. Geometry is
   * piece-local; only world matrices and world-space sockets change.
   */
  _relocatePiece(p, conn) {
    const b = p._builtFrom;
    if (!b?.fromConn || !b.outFromConn) return false;
    const br = p.branches ?? [];
    const locals = b.branchFromConn ?? [];
    if (br.length !== locals.length) return false;
    const world = _POSE.copy(conn).multiply(b.fromConn);
    p.mesh.matrix.copy(world);
    p.mesh.matrixWorldNeedsUpdate = true;
    for (const m of [p.railMesh, p.shellMesh, p.decorMesh, p.decorGateMesh, p.decorGlowMesh, p.glassMesh]) {
      if (!m) continue;
      m.matrix.copy(world);
      m.matrixWorldNeedsUpdate = true;
    }
    p.connectorOut.copy(conn).multiply(b.outFromConn);
    for (let i = 0; i < br.length; i++) br[i].matrix.copy(conn).multiply(locals[i]);
    b.conn.copy(conn);
    return true;
  }

  /** Update a placed piece's meshes from a freshly built result. */
  _applyBuilt(p, built) {
    p.mesh.geometry.dispose();
    p.mesh.geometry = built.geometry;
    p.mesh.matrix.copy(built.world);
    p.mesh.matrixWorldNeedsUpdate = true;
    p.mesh.userData.collisionGeometry?.dispose();
    p.mesh.userData.collisionGeometry = built.deckCollision ?? null;
    // Branch sockets are world matrices, so they move with the piece.
    p.branches = built.branchesOut ?? [];

    if (built.railGeometry && this.railMaterial) {
      if (p.railMesh) {
        p.railMesh.geometry.dispose();
        p.railMesh.geometry = built.railGeometry;
        p.railMesh.matrix.copy(built.world);
        p.railMesh.matrixWorldNeedsUpdate = true;
      } else {
        p.railMesh = this._makeMesh(built.railGeometry, this.railMaterial, built.world);
      }
      p.railMesh.userData.collisionGeometry?.dispose();
      p.railMesh.userData.collisionGeometry = built.railCollision ?? null;
      // Poses, not geometry — nothing to dispose. The template they point at is
      // shared and owned by modularRoadRail.js's cache.
      p.railMesh.userData.railPosts = built.railPosts ?? null;
    } else if (p.railMesh) {
      this.root.remove(p.railMesh);
      p.railMesh.geometry.dispose();
      p.railMesh = null;
    }

    if (built.shellGeometry) {
      const shellMat = built.def.shell === "vault"
        ? (this.vaultShellMaterial || this.shellMaterial)
        : this.shellMaterial;
      if (p.shellMesh) {
        p.shellMesh.geometry.dispose();
        p.shellMesh.userData.collisionGeometry?.dispose();
        p.shellMesh.geometry = built.shellGeometry;
        p.shellMesh.material = shellMat;
        p.shellMesh.matrix.copy(built.world);
        p.shellMesh.matrixWorldNeedsUpdate = true;
      } else if (shellMat) {
        p.shellMesh = this._makeMesh(built.shellGeometry, shellMat, built.world);
      }
      if (p.shellMesh) {
        p.shellMesh.userData.vault = built.def.shell === "vault";
        p.shellMesh.userData.collisionGeometry = built.shellCollision ?? null;
      }
    } else if (p.shellMesh) {
      this.root.remove(p.shellMesh);
      p.shellMesh.geometry.dispose();
      p.shellMesh.userData.collisionGeometry?.dispose();
      p.shellMesh = null;
    }

    if (built.glassGeometry && this.glassMaterial) {
      if (p.glassMesh) {
        p.glassMesh.geometry.dispose();
        p.glassMesh.geometry = built.glassGeometry;
        p.glassMesh.matrix.copy(built.world);
        p.glassMesh.matrixWorldNeedsUpdate = true;
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
        p.decorMesh.matrixWorldNeedsUpdate = true;
      } else {
        p.decorMesh = this._makeMesh(built.decorGeometry, this.decorMaterial, built.world);
        p.decorMesh.castShadow = false;
      }
    } else if (p.decorMesh) {
      this.root.remove(p.decorMesh);
      p.decorMesh.geometry.dispose();
      p.decorMesh = null;
    }

    if (built.decorGateGeometry && this.decorGateMaterial) {
      if (p.decorGateMesh) {
        p.decorGateMesh.geometry.dispose();
        p.decorGateMesh.geometry = built.decorGateGeometry;
        p.decorGateMesh.matrix.copy(built.world);
        p.decorGateMesh.matrixWorldNeedsUpdate = true;
      } else {
        p.decorGateMesh = this._makeMesh(built.decorGateGeometry, this.decorGateMaterial, built.world);
        p.decorGateMesh.castShadow = true;
        p.decorGateMesh.receiveShadow = false;
      }
    } else if (p.decorGateMesh) {
      this.root.remove(p.decorGateMesh);
      p.decorGateMesh.geometry.dispose();
      p.decorGateMesh = null;
    }

    if (built.decorGlowGeometry) {
      const glowMat = this._glowMaterial(built.def);
      if (p.decorGlowMesh) {
        p.decorGlowMesh.geometry.dispose();
        p.decorGlowMesh.geometry = built.decorGlowGeometry;
        p.decorGlowMesh.material = glowMat;
        p.decorGlowMesh.matrix.copy(built.world);
        p.decorGlowMesh.matrixWorldNeedsUpdate = true;
      } else if (glowMat) {
        p.decorGlowMesh = this._makeMesh(built.decorGlowGeometry, glowMat, built.world);
        p.decorGlowMesh.castShadow = false;
        p.decorGlowMesh.receiveShadow = false;
        p.decorGlowMesh.userData.isGlow = true;
      }
      if (p.decorGlowMesh) {
        p.decorGlowMesh.userData.glowKind = this._glowKind(built.def);
      }
    } else if (p.decorGlowMesh) {
      this.root.remove(p.decorGlowMesh);
      p.decorGlowMesh.geometry.dispose();
      p.decorGlowMesh = null;
    }
  }

  /**
   * Replace all chains from saved pieces (supports disconnected chains via
   * stored chainId + connectors).
   * @param {{id:string, chainId?:number, pp:object, edges?:boolean, connectorIn:number[]}[]} entries
   */
  /**
   * @param {object[]} entries piece records, already migrated to the current
   *   track version by modularRoadTrackIO — this method never sees a v1 file.
   * @param {object} [opts]
   * @param {Set<string>|null} [opts.dropKeys] params to IGNORE from the file and
   *   take from PIECE_DEFAULTS instead. This is the "rebase" half of the legacy
   *   -pin story: a v1 track's defaults-of-the-day snapshot cannot be told apart
   *   from a real choice once it is loaded, so the decision is made out in
   *   importTrack (which can still see the v1 shape) and handed down as a key
   *   list.
   */
  importTrackPieces(entries, { dropKeys = null } = {}) {
    this.clear();
    if (!Array.isArray(entries)) return;
    for (const e of entries) {
      const id = e.id === "checkpoint" ? "checkpoint_new" : e.id;
      if (!PIECE_BY_ID.has(id) || !Array.isArray(e.connectorIn) || e.connectorIn.length !== 16) continue;
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
      // tracks loaded from disk, so the history tests — which build with place()
      // — never saw it.
      // RESOLVED TO A FULL SET before it goes anywhere near the piece record.
      // `pp` is sparse in the FILE only: buildPiece reads plenty of params
      // without a `?? pieceParams` fallback, and every piece in memory is
      // expected to carry a complete set, so the sparse shape stops at this
      // line rather than leaking into the builder.
      const pp = resolvePieceParams(e.pp, dropKeys);
      const piece = this._makePieceEntry(id, e.chainId ?? 0, connectorIn, pp, e.edges ?? true);
      // Saved absolute pin for a free-placed piece; the tilt recovery below reads
      // it, and rebuildAll uses it in place of the running connector.
      piece.detached = !!e.detached;
      piece.pinnedIn = Array.isArray(e.pinnedIn) && e.pinnedIn.length === 16
        ? new THREE.Matrix4().fromArray(e.pinnedIn)
        : null;
      this.pieces.push(piece);
    }
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
    // Caps are derived (occupancy + matching mouths), not stored in the file.
    // _makePieceEntry built every piece unlidded (tubes: both rings). Without
    // this remesh a reload looks hollow on free ends and double-lidded on
    // tube joints. reuse is off: _builtFrom still says "no caps" for tubes
    // whose mesh already has both rings, so a reuse walk would skip middles.
    this.rebuildAll();
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
   * Avoids loops / tubes / twists — those need hand-tuned placement.
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
    // A GRADED climb, not a `slope`. The slope this replaced gained 8 m over
    // 30 m, which is a 37 m convex crest — a takeoff ramp above ~70 km/h,
    // under a demo whose own refSpeed is 100. The Tight set holds 112 km/h and
    // gains more height (~11 m); the middle straight is what climbs, at zero
    // vertical curvature. See the gradeAngle block in modularRoadKit.js.
    put("grade_in", { gradeAngle: 14, gradeRadius: 50 });
    put("grade", { gradeLength: 20 });
    put("grade_out", { gradeAngle: 14, gradeRadius: 50 });
    put("straight", { straightLength: 18 });
    put("checkpoint_new", { gameLineLength: 16 });
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
    put("tunnel_lit", { straightLength: 28, tunnelHeight: 7.2 });
    put("curve", { curveRadius: R, curveAngle: 90, curveDir: -1 });

    // ── Precision + exit ────────────────────────────────────────────────────
    put("straight", { straightLength: 16 });
    put("narrow", { straightLength: 22, narrowWidth: 8 });
    put("curve", { curveRadius: Rtight, curveAngle: 45, curveDir: 1 });
    put("curve", { curveRadius: Rtight, curveAngle: 45, curveDir: 1 });
    // A brow the car crosses rather than launches off. 24 m / 4 m is an 11 m
    // radius over the top, which unaided is air above 40 km/h on a straight the
    // car arrives at 100+ on; road hold carries it to ~155 (see ROAD_HOLD), and
    // a little length on top of that puts it out of reach entirely.
    put("crest", { slopeLength: 44, slopeRise: 4 });
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

    // Radii / lengths match CATEGORY_PRESETS tiles (Tube Turn, Road Tunnel Turn, etc.).
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
      put("checkpoint_new", { gameLineLength: 16 });

      // Tubes → Road Tunnel, another Tube, then Road Tunnel Turn
      put("tunnel_lit", { straightLength: 26, tunnelHeight: 7.2 });
      put("tube", { straightLength: 26, tubeRadius: tubeR, tubeWall: 0.6 });
      put("straight", { straightLength: 14 }); // Straight → Short
      put("tunnel_lit_curve", {
        curveRadius: R, curveAngle: 90, curveDir: 1, tunnelHeight: 7.2,
      }); // 90°

      put("narrow", { straightLength: 24, narrowWidth: 8 }); // Straight → Narrow
      // Slopes → Hill. 32 m / 8 m (the old figure, now shipped as "Hill Jump")
      // crests on a 10 m radius, which even with road hold launches the car
      // above ~149 km/h — fine as a feature, wrong as the thing standing between
      // two halves of a circuit that has to close. Length is free here: the
      // halves are identical and each still turns exactly 180°.
      put("crest", { slopeLength: 44, slopeRise: 4 });
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
  /**
   * Piece records in the track-file shape.
   *
   * `pp` goes out SPARSE — only the params that differ from PIECE_DEFAULTS.
   * Every piece record in memory carries the full set (see _makePieceEntry, and
   * the note on PIECE_DEFAULTS about why a tile resolves to a complete object),
   * so this is the one place the two representations meet.
   *
   * The saving is not the point, though it is large: rushline's 41 pieces wrote
   * 74 params each and only 10 of those keys ever differed between pieces. The
   * point is that an OMITTED key means "no opinion", so a later retune of
   * `bankCurl` or `jumpAngle` reaches this track instead of being overruled by
   * a copy of the value it happened to have on the day it was saved.
   *
   * `edges` is written only when false for the same reason — `?? true` on the
   * way back in is the default, so storing it means storing a choice.
   */
  exportTrackPieces() {
    return this.pieces.map((p) => {
      const e = {
        id: p.id,
        chainId: p.chainId ?? 0,
        pp: sparse(p.pp, PIECE_DEFAULTS),
        connectorIn: p.connectorIn.toArray(),
      };
      if (p.edges === false) e.edges = false;
      if (p.detached && p.pinnedIn) {
        e.detached = true;
        e.pinnedIn = p.pinnedIn.toArray();
      }
      return e;
    });
  }

  dispose() {
    this.clear();
    // `clear()` empties the batches through _rebuildInstances, but only while
    // instancing is ON. Explicit here so a teardown from the OFF state does not
    // strand the buffers.
    this._dropInstances();
    this._hidePlacementGizmo();
    this.placementGizmo?.dispose();
    this.scene.remove(this.placementGizmo?.getHelper());
    this.scene.remove(this.placementPivot);
    this.scene.remove(this.ghost);
    // The ghost BORROWS its geometry from `_ghostGeoCache` (see refreshGhost),
    // so freeing `this.ghost.geometry` here would double-free whichever entry it
    // happens to be showing. Drop the cache instead — it owns every one of them,
    // including the one on screen, which is why the eviction guard is skipped.
    for (const v of this._ghostGeoCache.values()) v.geometry.dispose();
    this._ghostGeoCache.clear();
    this._ghostOrphanGeo?.dispose();
    this._ghostOrphanGeo = null;
    this._ghostPlaceholderGeo.dispose();
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
  platform_hazard: "straight",
  narrow: "straight",
  holed: "straight",
  glass_road: "straight",
  dual: "straight",
  rounded_end: "straight",
  rounded_start: "straight",
  tunnel: "tubes",
  tunnel_curve: "tubes",
  tunnel_lit: "tubes",
  tunnel_lit_curve: "tubes",
  tube: "tubes",
  tube_curve: "tubes",
  tube_in: "tubes",
  tube_out: "tubes",
  half_tube: "tubes",
  half_tube_curve: "tubes",
  half_tube_in: "tubes",
  half_tube_out: "tubes",
  half_pipe: "tubes",
  half_pipe_curve: "tubes",
  tube_slope: "tubes",
  tube_crest: "tubes",
  tube_spiral: "tubes",
  half_tube_slope: "tubes",
  half_tube_crest: "tubes",
  half_tube_spiral: "tubes",
  half_pipe_slope: "tubes",
  tube_scurve: "tubes",
  half_tube_scurve: "tubes",
  tube_launch: "tubes",
  half_tube_launch: "tubes",
  tube_reduce: "tubes",
  half_tube_reduce: "tubes",
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
  grade_in: "slopes",
  grade: "slopes",
  grade_out: "slopes",
  spiral: "slopes",
  banked: "banked",
  banked_climb: "banked",
  banktilt: "banked",
  bankin: "banked",
  bankswap: "banked",
  bankout: "banked",
  loop: "loop",
  loop_half: "loop",
  loop_spiral: "loop",
  quarterpipe: "loop",
  quarterpipe_down: "loop",
  start_new: "game",
  finish_new: "game",
  checkpoint_new: "game",
  start: "game",
  finish: "game",
  junction_split: "junctions",
  junction_merge: "junctions",
  junction_y: "junctions",
  junction_t: "junctions",
  junction_cross: "junctions",
  junction_roundabout: "junctions",
};

export const PALETTE_CATEGORIES = [
  { id: "game", label: "Game" },
  { id: "straight", label: "Straight" },
  { id: "turns", label: "Turns" },
  { id: "junctions", label: "Junctions" },
  { id: "ramps", label: "Ramps" },
  { id: "slopes", label: "Slopes" },
  { id: "banked", label: "Banked" },
  { id: "tubes", label: "Tubes" },
  // Loop belongs with the other things you ride the INSIDE of, not at the end
  // of the rail past the scenery. It was last because it was added last; tubes,
  // loops and quarter-pipes are one family and you pick between them by reading
  // them together.
  { id: "loop", label: "Loop" },
  { id: "obstacles", label: "Obstacles" },
  { id: "parkour", label: "Parkour" },
  { id: "scenery", label: "Scenery" },
  { id: "moving", label: "Moving" },
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
      label: "Up",
      base: "bankin",
      params: { bankRampLength: 44, bankAngle: 22 },
    },
    {
      id: "bank_straight_right",
      label: "Straight",
      base: "banktilt",
      params: { straightLength: 32, bankAngle: 22 },
    },
    {
      id: "bank_road_tilted",
      label: "Road Tilted",
      base: "banktilt",
      params: { straightLength: 32, bankAngle: 35 },
    },
    {
      id: "bank_down_right",
      label: "Down",
      base: "bankout",
      params: { bankRampLength: 44, bankAngle: 22 },
    },
    {
      id: "bank_short_turn",
      label: "Short Turn",
      base: "banked",
      params: { curveRadius: 34, curveAngle: 60, bankAngle: 22 },
    },
    {
      id: "bank_long_turn",
      label: "Long Turn",
      base: "banked",
      params: { curveRadius: 58, curveAngle: 90, bankAngle: 22 },
    },
    // CLIMBING BANKS. Until now a banked corner held one altitude for its whole
    // length, so every banked section in a track sat on a single flat plane and
    // you had to un-bank, climb, and re-bank to leave it. 14 m over a 91 m arc
    // is a 23% peak grade, and the climb is smoothstepped so the exit is still
    // level — chain one straight onto a held-bank turn.
    {
      id: "bank_climb_right",
      label: "Climb Turn",
      base: "banked_climb",
      params: { curveRadius: 58, curveAngle: 90, bankAngle: 22, bankRise: 14 },
    },
    {
      id: "bank_drop_right",
      label: "Drop Turn",
      base: "banked_climb",
      params: { curveRadius: 58, curveAngle: 90, bankAngle: 22, bankRise: -14 },
    },
    /*
     * THE CHICANE. Right-hand banked turn → this → left-hand banked turn, with
     * the deck never passing through flat road.
     *
     * The alternative was Bank down → Bank up: settle the lean to nothing, drive
     * a stretch of level road, then roll it up the other way. Two pieces, twice
     * the length, and a flat spot in the middle of what should read as one
     * continuous change of direction.
     *
     * Sized at 44 m like the other transitions, but it does twice the work in
     * that length — 22° to −22° instead of 22° to 0 — so the roll rate is double
     * a Bank up. That is the piece's character rather than a defect: a chicane
     * is a flick. The 12° tile is there for when it should not be.
     */
    {
      id: "bank_chicane",
      label: "Chicane",
      base: "bankswap",
      params: { bankRampLength: 44, bankAngle: 22 },
    },
    {
      id: "bank_chicane_gentle",
      label: "Chicane 12°",
      base: "bankswap",
      params: { bankRampLength: 40, bankAngle: 12 },
    },
    {
      id: "bank_chicane_steep",
      label: "Chicane 38°",
      base: "bankswap",
      // LONGER, for the same reason the 38° transitions are: rolling 76° of
      // total swap in 44 m is a snap, not a lean.
      params: { bankRampLength: 64, bankAngle: 38 },
    },
    // QUICK TRANSITIONS. bankRampLength 44 is sized so the curl reads as a shape
    // developing, and that is right for a sweeper — but it also meant a section
    // shorter than ~90 m could not be banked at all, because the two transitions
    // alone did not fit. 20 m folds rather than rolls; that is the trade, and it
    // is now a choice instead of the absence of one.
    {
      id: "bank_up_right_quick",
      label: "Up Quick",
      base: "bankin",
      params: { bankRampLength: 20, bankAngle: 22 },
    },
    {
      id: "bank_down_right_quick",
      label: "Down Quick",
      base: "bankout",
      params: { bankRampLength: 20, bankAngle: 22 },
    },

    // ── THE ANGLE LADDER ──────────────────────────────────────────────────
    //
    // Everything above is 22°, so every banked corner in every track anyone has
    // built leans by the same amount. These are the same four pieces at a
    // gentler and a steeper lean.
    //
    // A COMPLETE SET PER ANGLE, deliberately — Up, Straight, Turn and Down, in
    // both hands. A bank section is Up → (Straight | Turn)* → Down and every
    // piece in it has to carry the SAME bankAngle, or the deck steps at the
    // seam: the held-bank pieces share one raised/rolled cross-section and that
    // section is a function of the angle. Half a ladder would be tiles that look
    // usable and are not.
    //
    // 12° is highway camber — enough to feel, not enough to commit to. 38° is
    // past the 35° Road Tilted, so it reads as a corner you drop into.
    {
      id: "bank_up_right_gentle",
      label: "Up 12°",
      base: "bankin",
      params: { bankRampLength: 32, bankAngle: 12 },
    },
    {
      id: "bank_straight_right_gentle",
      label: "Straight 12°",
      base: "banktilt",
      params: { straightLength: 32, bankAngle: 12 },
    },
    {
      id: "bank_turn_right_gentle",
      label: "Turn 12°",
      base: "banked",
      params: { curveRadius: 58, curveAngle: 90, bankAngle: 12 },
    },
    {
      id: "bank_down_right_gentle",
      label: "Down 12°",
      base: "bankout",
      params: { bankRampLength: 32, bankAngle: 12 },
    },
    // The steep set gets LONGER transitions, not shorter: the ramp has to roll
    // 38° instead of 22° in the same piece, so holding 44 m would raise the roll
    // rate by three quarters — the exact fold this length exists to avoid.
    {
      id: "bank_up_right_steep",
      label: "Up 38°",
      base: "bankin",
      params: { bankRampLength: 56, bankAngle: 38 },
    },
    {
      id: "bank_straight_right_steep",
      label: "Straight 38°",
      base: "banktilt",
      params: { straightLength: 32, bankAngle: 38 },
    },
    {
      id: "bank_turn_right_steep",
      label: "Turn 38°",
      base: "banked",
      params: { curveRadius: 44, curveAngle: 90, bankAngle: 38 },
    },
    {
      id: "bank_down_right_steep",
      label: "Down 38°",
      base: "bankout",
      params: { bankRampLength: 56, bankAngle: 38 },
    },
  ],
  tubes: [
    // ENTRY FIRST, because that is the order you build in. A tube dropped
    // straight off a flat road is a 14.5 m plate butted onto an 8 m bore: a
    // step at the seam and a wall the car meets with no warning. These two
    // roll the deck up into the bore and back out of it, and they carry the
    // SAME tubeRadius / tubeWall as the tubes beside them so the far seam
    // matches vertex for vertex — change one, change all of them.
    {
      id: "tube_entry",
      label: "Tube Entry",
      base: "tube_in",
      params: { tubeEntryLength: 26, tubeRadius: 8, tubeWall: 0.6 },
    },
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
      params: { curveRadius: 26, curveAngle: 90, tubeRadius: 8, tubeWall: 0.6 },
    },
    // TURN SIZES. There used to be exactly ONE tube corner in the game — 90° at
    // R26 — so every tube corner anyone had ever built was the same corner.
    // These are the identical piece at the sizes the flat Turns tab already
    // offers; `curveDir` is what "R flips L/R" acts on.
    {
      id: "tube_turn_45",
      label: "Tube Turn 45",
      base: "tube_curve",
      params: { curveRadius: 26, curveAngle: 45, tubeRadius: 8, tubeWall: 0.6 },
    },
    {
      id: "tube_turn_30",
      label: "Tube Turn 30",
      base: "tube_curve",
      params: { curveRadius: 26, curveAngle: 30, tubeRadius: 8, tubeWall: 0.6 },
    },
    {
      id: "tube_turn_wide",
      label: "Tube Turn Wide",
      base: "tube_curve",
      params: { curveRadius: 48, curveAngle: 90, tubeRadius: 8, tubeWall: 0.6 },
    },
    // S-BENDS. A pure sidestep: out by 40° and back, so the heading the piece
    // hands on is the heading it was given. Dodging something used to cost two
    // 45° corners, which leaves the whole rest of the chain rotated.
    {
      id: "tube_s_right",
      label: "Tube S",
      base: "tube_scurve",
      params: { curveRadius: 26, curveAngle: 40, tubeRadius: 8, tubeWall: 0.6 },
    },
    // VERTICALITY. Level at both ends (smoothstep), so these drop into an
    // existing tube run without rotating anything — which is the whole point:
    // rotating a piece rotates its exit plane and drags the rest of the chain.
    {
      id: "tube_up",
      label: "Tube Up",
      base: "tube_slope",
      params: { slopeLength: 32, slopeRise: 10, tubeRadius: 8, tubeWall: 0.6 },
    },
    {
      id: "tube_down",
      label: "Tube Down",
      base: "tube_slope",
      params: { slopeLength: 32, slopeRise: -10, tubeRadius: 8, tubeWall: 0.6 },
    },
    {
      id: "tube_hill",
      label: "Tube Hill",
      base: "tube_crest",
      params: { slopeLength: 36, slopeRise: 8, tubeRadius: 8, tubeWall: 0.6 },
    },
    {
      id: "tube_dip",
      label: "Tube Dip",
      base: "tube_crest",
      params: { slopeLength: 36, slopeRise: -8, tubeRadius: 8, tubeWall: 0.6 },
    },
    {
      // Half a turn at R26 is 82 m of bore for 14 m of climb — a 17% grade the
      // car carries without losing the run — and the climb eases flat at both
      // ends, so two of these stack to exactly 28 m with an upright exit.
      id: "tube_helix_r",
      label: "Tube Helix",
      base: "tube_spiral",
      params: { loopSpiralRadius: 26, loopSpiralTurns: 0.5, loopSpiralRise: 14, tubeRadius: 8, tubeWall: 0.6 },
    },
    {
      id: "tube_exit",
      label: "Tube Exit",
      base: "tube_out",
      params: { tubeEntryLength: 26, tubeRadius: 8, tubeWall: 0.6 },
    },
    {
      // THE CANNON. Every tube run used to end by putting you back on level
      // road; this is the same unwrap on a ramp. 18° is a shade over the jump's
      // 12° because you arrive with the bore's speed already in hand.
      id: "tube_cannon",
      label: "Tube Launch",
      base: "tube_launch",
      params: { tubeEntryLength: 26, jumpAngle: 18, tubeRadius: 8, tubeWall: 0.6 },
    },

    // ── THE BIG BORE (R12) ────────────────────────────────────────────────
    // A second SIZE, which the tab could not have before: with no way to get
    // from one radius to another, a big tube would have been an island. The
    // reducers below are what make it a family rather than a novelty — and the
    // radii here are exactly the two the reducers join, so a Big Tube always has
    // a way back down to the R8 run everything else is built at.
    {
      id: "big_tube_entry",
      label: "Big Tube Entry",
      base: "tube_in",
      params: { tubeEntryLength: 34, tubeRadius: 12, tubeWall: 0.6 },
    },
    {
      id: "big_tube_str",
      label: "Big Tube",
      base: "tube",
      params: { straightLength: 34, tubeRadius: 12, tubeWall: 0.6 },
    },
    {
      id: "big_tube_turn",
      label: "Big Tube Turn",
      base: "tube_curve",
      params: { curveRadius: 34, curveAngle: 90, tubeRadius: 12, tubeWall: 0.6 },
    },
    {
      id: "big_tube_exit",
      label: "Big Tube Exit",
      base: "tube_out",
      params: { tubeEntryLength: 34, tubeRadius: 12, tubeWall: 0.6 },
    },
    {
      id: "tube_expand",
      label: "Tube 8 → 12",
      base: "tube_reduce",
      params: { tubeEntryLength: 30, tubeRadius: 8, tubeRadius2: 12, tubeWall: 0.6 },
    },
    {
      id: "tube_narrow",
      label: "Tube 12 → 8",
      base: "tube_reduce",
      params: { tubeEntryLength: 30, tubeRadius: 12, tubeRadius2: 8, tubeWall: 0.6 },
    },
    {
      id: "half_tube_entry",
      label: "Half Tube Entry",
      base: "half_tube_in",
      params: { tubeEntryLength: 26, tubeRadius: 8, tubeWall: 0.6, halfTubeSpan: 180 },
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
      params: { curveRadius: 26, curveAngle: 90, tubeRadius: 8, tubeWall: 0.6, halfTubeSpan: 180 },
    },
    {
      id: "half_tube_deep",
      label: "Deep Half Tube",
      base: "half_tube",
      params: { straightLength: 26, tubeRadius: 8, tubeWall: 0.6, halfTubeSpan: 240 },
    },
    {
      id: "half_tube_turn_45",
      label: "Half Tube Turn 45",
      base: "half_tube_curve",
      params: { curveRadius: 26, curveAngle: 45, tubeRadius: 8, tubeWall: 0.6, halfTubeSpan: 180 },
    },
    {
      id: "half_tube_turn_wide",
      label: "Half Tube Turn Wide",
      base: "half_tube_curve",
      params: { curveRadius: 48, curveAngle: 90, tubeRadius: 8, tubeWall: 0.6, halfTubeSpan: 180 },
    },
    {
      id: "half_tube_up",
      label: "Half Tube Up",
      base: "half_tube_slope",
      params: { slopeLength: 32, slopeRise: 10, tubeRadius: 8, tubeWall: 0.6, halfTubeSpan: 180 },
    },
    {
      id: "half_tube_down",
      label: "Half Tube Down",
      base: "half_tube_slope",
      params: { slopeLength: 32, slopeRise: -10, tubeRadius: 8, tubeWall: 0.6, halfTubeSpan: 180 },
    },
    {
      id: "half_tube_hill",
      label: "Half Tube Hill",
      base: "half_tube_crest",
      params: { slopeLength: 36, slopeRise: 8, tubeRadius: 8, tubeWall: 0.6, halfTubeSpan: 180 },
    },
    {
      id: "half_tube_dip",
      label: "Half Tube Dip",
      base: "half_tube_crest",
      params: { slopeLength: 36, slopeRise: -8, tubeRadius: 8, tubeWall: 0.6, halfTubeSpan: 180 },
    },
    {
      id: "half_tube_helix_r",
      label: "Half Tube Helix",
      base: "half_tube_spiral",
      params: { loopSpiralRadius: 26, loopSpiralTurns: 0.5, loopSpiralRise: 14, tubeRadius: 8, tubeWall: 0.6, halfTubeSpan: 180 },
    },
    {
      id: "half_tube_s_right",
      label: "Half Tube S",
      base: "half_tube_scurve",
      params: { curveRadius: 26, curveAngle: 40, tubeRadius: 8, tubeWall: 0.6, halfTubeSpan: 180 },
    },
    {
      id: "half_tube_exit",
      label: "Half Tube Exit",
      base: "half_tube_out",
      params: { tubeEntryLength: 26, tubeRadius: 8, tubeWall: 0.6, halfTubeSpan: 180 },
    },
    {
      id: "half_tube_cannon",
      label: "Half Tube Launch",
      base: "half_tube_launch",
      params: { tubeEntryLength: 26, jumpAngle: 18, tubeRadius: 8, tubeWall: 0.6, halfTubeSpan: 180 },
    },
    {
      id: "half_tube_expand",
      label: "Half Tube 8 → 12",
      base: "half_tube_reduce",
      params: { tubeEntryLength: 30, tubeRadius: 8, tubeRadius2: 12, tubeWall: 0.6, halfTubeSpan: 180 },
    },
    {
      id: "half_tube_narrow",
      label: "Half Tube 12 → 8",
      base: "half_tube_reduce",
      params: { tubeEntryLength: 30, tubeRadius: 12, tubeRadius2: 8, tubeWall: 0.6, halfTubeSpan: 180 },
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
      // THE PIPE THAT KEEPS YOUR SPEED. The Park Pipes above are dead flat, so
      // a run of hits gets slower every time — every carve up the wall is speed
      // spent and the floor gives nothing back. Real pipes are cut into a
      // hillside at 16-18° for exactly this reason. 16 m over 90 m smoothsteps
      // to a 27% peak grade (15°), and it still enters and leaves level so it
      // drops into a flat run without pitching anything after it.
      id: "half_pipe_park_slope",
      label: "Park Pipe Slope",
      base: "half_pipe_slope",
      params: { slopeLength: 90, slopeRise: -16, tubeRadius: 26, tubeWall: 0.6, halfPipeFlat: 12, halfPipeVert: 17 },
    },
    {
      id: "half_pipe_park_turn",
      label: "Park Pipe Turn",
      base: "half_pipe_curve",
      params: { curveRadius: 60, curveAngle: 60, tubeRadius: 26, tubeWall: 0.6, halfPipeFlat: 12, halfPipeVert: 17 },
    },
    {
      id: "vault_str",
      label: "Road Tunnel",
      base: "tunnel_lit",
      params: { straightLength: 26, tunnelHeight: 7.2 },
    },
    {
      id: "vault_turn",
      label: "Road Tunnel Turn",
      base: "tunnel_lit_curve",
      params: { curveRadius: 26, curveAngle: 90, tunnelHeight: 7.2 },
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
      params: { curveRadius: 26, curveAngle: 90, channelRadius: 4 },
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
      id: "straight_rounded_end",
      label: "Rounded end",
      base: "rounded_end",
      params: { roundEndLength: 8 },
    },
    {
      id: "straight_rounded_start",
      label: "Rounded start",
      base: "rounded_start",
      params: { roundEndLength: 8 },
    },
    {
      id: "straight_long",
      label: "Long",
      base: "straight",
      params: { straightLength: 32 },
    },
    {
      id: "platform_pad",
      label: "Platform",
      base: "platform",
      params: { platformLength: 24, platformWidth: 44 },
    },
    {
      id: "platform_hazard_pad",
      label: "Hazard pad",
      base: "platform_hazard",
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
    {
      id: "dual_boards",
      label: "Dual boards",
      base: "dual",
      params: { dualLength: 32, dualWidth: 4.4, dualGap: 0.9 },
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
    // ── GAPS ────────────────────────────────────────────────────────────────
    // Every other family in this category had a row of sizes and the Gap had
    // NONE — `G` gave you the base piece at a flat 44 m × 6 m drop, and no UI
    // anywhere could change either number. Labelled in METRES, unlike the ramps'
    // size classes, because that is what the piece is: a measured hole.
    //
    // Sizes are a starting point, not the answer. A gap's length is a
    // consequence of the jump, not a choice — "Gap → jump" in the Gap/Jump panel
    // measures it off the real trajectory, which is what you want whenever the
    // car has to land somewhere specific.
    {
      id: "gap_20",
      label: "Gap 20 m",
      base: "gap",
      params: { gapLength: 20, gapDrop: 0 },
    },
    {
      id: "gap_40",
      label: "Gap 40 m",
      base: "gap",
      params: { gapLength: 40, gapDrop: 0 },
    },
    {
      id: "gap_60",
      label: "Gap 60 m",
      base: "gap",
      params: { gapLength: 60, gapDrop: 0 },
    },
    {
      id: "gap_drop",
      label: "Gap 40 ↓8",
      base: "gap",
      params: { gapLength: 40, gapDrop: 8 },
    },
    {
      id: "gap_chasm",
      label: "Gap 90 ↓20",
      base: "gap",
      params: { gapLength: 90, gapDrop: 20 },
    },
  ],
  slopes: [
    /*
     * THE GRADED CLIMB — Grade in → Climb ×N → Grade out.
     *
     * THE TILES TO REACH FOR WHEN YOU ACTUALLY WANT TO CHANGE ALTITUDE, and the
     * reason they exist is that `slope` cannot do that job at speed. A slope
     * gains its height and returns to level inside one piece, so its whole rise
     * is spent turning the car, and what throws the car off a hill is curvature:
     * holding a convex radius R at v needs v²/R, and past gravity plus
     * downforce the wheels leave. Every shipped slope crested tighter than 30 m
     * — a takeoff ramp above 40–60 km/h, in a car that reaches 175.
     *
     * Splitting it fixes it. The transitions are sized by RADIUS rather than
     * length, and the middle is a straight that inherits the grade from the
     * connector — zero curvature, so it is followable at any speed and it is
     * what gains the height. Stack as many Climbs as you need.
     *
     * Radii, and the speed each holds to (tools/gradeFollowTest.mjs):
     *   Fast    R 160   the full 175 km/h — use it on a main line
     *   Medium  R  90   ~130 km/h, two thirds the length
     *   Tight   R  50   ~95 km/h, compact — a technical climb
     */
    {
      id: "grade_in_fast",
      label: "Grade in",
      base: "grade_in",
      params: { gradeAngle: 10, gradeRadius: 160 },
    },
    {
      id: "grade_climb",
      label: "Climb",
      base: "grade",
      params: { gradeLength: 40 },
    },
    {
      id: "grade_out_fast",
      label: "Grade out",
      base: "grade_out",
      params: { gradeAngle: 10, gradeRadius: 160 },
    },
    {
      id: "grade_in_tight",
      label: "Grade in Tight",
      base: "grade_in",
      params: { gradeAngle: 14, gradeRadius: 50 },
    },
    {
      id: "grade_climb_short",
      label: "Climb Short",
      base: "grade",
      params: { gradeLength: 20 },
    },
    {
      id: "grade_out_tight",
      label: "Grade out Tight",
      base: "grade_out",
      params: { gradeAngle: 14, gradeRadius: 50 },
    },
    /*
     * COMPACT SLOPES — one piece, level to level. Still useful, and no longer
     * secretly a jump: the profile is two parabolic vertical curves (slopeShape)
     * rather than the smoothstep it started as.
     *
     * SIZED AGAINST THREE CEILINGS, and the third one is why these got longer
     * again after the first pass at them:
     *
     *  • CONVEX curvature decides whether the car flies off the crest. ROAD_HOLD
     *    covers up to 12.7 g of it.
     *  • CONCAVE curvature decides whether the car is driven THROUGH the road at
     *    the bottom of the climb. Nothing covers that but the strut, which runs
     *    out at 14.5 g — and the first version of these presets sailed past it
     *    (16.3 g on Up Steep) and put the wheels 31 cm inside the deck. See
     *    SLOPE_CONCAVE_FRAC.
     *  • peak GRADE (2·H/L here) decides whether the car can climb it at all;
     *    RWD runs out of rear tyre near 42° (tools/slopeClimbLimit.mjs).
     *
     * These sit at 4–7.5 g on the first two with the grade well inside the
     * third, so nothing is at its limit. That costs length — a 14 m rise wants
     * 42 m of run rather than 26 — and length is exactly what a compact slope
     * was trying not to spend. If you want the height without the road, that is
     * what the graded climb above is for.
     */
    {
      id: "slope_up_gentle",
      label: "Up Gentle",
      base: "slope",
      params: { slopeLength: 34, slopeRise: 5 },
    },
    {
      id: "slope_up_medium",
      label: "Up Medium",
      base: "slope",
      params: { slopeLength: 36, slopeRise: 10 },
    },
    {
      id: "slope_up_steep",
      label: "Up Steep",
      base: "slope",
      params: { slopeLength: 42, slopeRise: 14 },
    },
    // Descents — same shape, negative rise (the split mirrors with it, so a
    // descent is exactly the climb driven backwards).
    {
      id: "slope_down_gentle",
      label: "Down Gentle",
      base: "slope",
      params: { slopeLength: 34, slopeRise: -5 },
    },
    {
      id: "slope_down_medium",
      label: "Down Medium",
      base: "slope",
      params: { slopeLength: 36, slopeRise: -10 },
    },
    {
      id: "slope_down_steep",
      label: "Down Steep",
      base: "slope",
      params: { slopeLength: 42, slopeRise: -14 },
    },
    // Crests — net-zero bump / dip (rise to the middle, level at both ends).
    // A crest MUST turn the car up and back down inside its own length, so it is
    // a jump if you build it short and tall. Hill is sized not to be; Hill Jump
    // is the old 32/8 kept on purpose, because sometimes that is what you want.
    {
      id: "slope_hill",
      label: "Hill",
      base: "crest",
      params: { slopeLength: 56, slopeRise: 7 },
    },
    {
      id: "slope_dip",
      label: "Dip",
      base: "crest",
      params: { slopeLength: 56, slopeRise: -7 },
    },
    {
      id: "slope_hill_jump",
      label: "Hill Jump",
      base: "crest",
      params: { slopeLength: 32, slopeRise: 8 },
    },
    /*
     * CLIMBING TURNS — stack to gain height, and now they actually do.
     *
     * This tile used to ride `spiral`, whose own hint says "stack to gain
     * height" and which does not. `spiralPoints` climbs at a CONSTANT rate, so
     * its entry tangent is pitched up; dropped on a level connector, buildPiece
     * rotates the whole piece to bring that tangent down and tips the helix axis
     * off vertical. MEASURED at this tile's exact old params (R18 / 180° /
     * rise 10), stacking three:
     *
     *     after 1   y = 9.77   up = (-0.52, 0.81, -0.29)   <- 36° of roll
     *     after 2   y = 0.75   <- climbed, then came back DOWN
     *     after 3   y = 9.13
     *
     * `loop_spiral` is the same shape built the way that works: the climb is
     * smoothstepped so both ends are level, and loopSpiralFixFrames pins up to
     * world-up so no roll can accumulate. Same size, same half turn, same 10 m,
     * and it measures 10 → 20 → 30 with an upright exit every time.
     *
     * R18 is the compact helix — inner kerb ~10 m on a 16 m road, still a
     * hairpin on the inside. Helix Wide (R40, half turn, 14 m) is the parking
     * ramp you can actually carry speed on. The Loop tab used to ship a third
     * copy at R12 / 1 turn / 32 m, which was a corkscrew; that tile is gone.
     * The `loop_spiral` PIECE stays in the catalog so old tracks keep loading.
     *
     * The `spiral` PIECE stays in the catalog — a track saved outside this repo
     * may contain one, and dropping a catalog entry is how those stop loading.
     * It just has no tile any more. See tools/turnLadderTest.mjs for the guard.
     */
    {
      id: "slope_helix", // id kept: it is the tile people have muscle memory for
      label: "Helix Up",
      base: "loop_spiral",
      params: { loopSpiralRadius: 18, loopSpiralTurns: 0.5, loopSpiralRise: 10 },
    },
    {
      id: "slope_helix_down_r",
      label: "Helix Down",
      base: "loop_spiral",
      params: { loopSpiralRadius: 18, loopSpiralTurns: 0.5, loopSpiralRise: -10 },
    },
    // R40 is the Turns tab's Medium corner (~81 km/h). Half a turn is ~126 m of
    // deck for 14 m of climb — ~11% average, ~17% at mid-helix after smoothstep.
    // Inner kerb sits at R32, so the hole is a hole and the car is not
    // pirouetting around its own inner wheels.
    {
      id: "slope_helix_wide",
      label: "Helix Wide Up",
      base: "loop_spiral",
      params: { loopSpiralRadius: 40, loopSpiralTurns: 0.5, loopSpiralRise: 14 },
    },
    {
      id: "slope_helix_wide_down_r",
      label: "Helix Wide Down",
      base: "loop_spiral",
      params: { loopSpiralRadius: 40, loopSpiralTurns: 0.5, loopSpiralRise: -14 },
    },
  ],
  turns: [
    /*
     * THE CORNER LADDER — five radii, and the radius IS the corner speed.
     *
     * A flat corner is grip-limited: v_max = sqrt(R · a). MEASURED on the real
     * vehicle over a flat plane, holding a steering angle and reading v·omega
     * once it settles (tools/turnLadderTest.mjs), sustained cornering is
     * 1.26–1.30 g — flat across every speed from 15 to 40 m/s, measured by
     * tools/turnLadderTest.mjs, which is what keeps this honest. The vehicle
     * file's own comment assumes 1.5 g, so its corner speeds are ~7% optimistic;
     * the numbers below use the measured 1.3. Anything much above that in a rig
     * like this is a PIROUETTE — an early version of the measurement reported
     * 8.4 g at a 3 m radius, which is a car rotating on the spot.
     *
     * A high reading can also be a car that has stopped cornering and started
     * PLOUGHING: gripRear was 1.5 for two days and this measured 2.25 g, but at
     * a 74 m radius instead of 6 m. Read the radius next to the g before
     * believing either.
     *
     * That gives the ladder its reason to exist, because the old tab could not
     * span the car. The straights run to 48.3 m/s (174 km/h) and the widest
     * corner on offer was R34 — an 81 km/h corner. EVERY corner in the game was
     * a heavy brake zone, with nothing between "brake hard" and "straight". A
     * corner you can take flat out needs R ≈ 183 m; the Kink at 130 gets within
     * a lift of it.
     *
     *     R= 12   12.4 m/s    45 km/h   Hairpin — stop-and-go, big brake zone
     *     R= 24   17.5 m/s    63 km/h   Tight   — second-gear corner
     *     R= 40   22.6 m/s    81 km/h   Medium  — the old tab's widest
     *     R= 70   29.9 m/s   108 km/h   Sweeper — a corner you carry speed through
     *     R=130   40.7 m/s   147 km/h   Kink    — a lift, not a brake
     *
     * BOTH HANDS, EVERY RUNG. This tab had exactly one left-hand tile (and that
     * one is mislabelled — see the S-curves at the bottom). `R` flips curveDir
     * live, but every other tab ships pairs, and a corner you have to remember
     * to flip is a corner you get wrong.
     *
     * The angles per rung are the ones that suit it: a hairpin is 90° or more
     * or it is not a hairpin, and a kink is 45° or less or you have built a
     * quarter of a circle 130 m across.
     */
    // ── Hairpin, R12 — 45 km/h ───────────────────────────────────────────
    {
      id: "turn_sharp_small", // kept: the id `buildParkourTrack` reaches for
      label: "Hairpin 90",
      base: "curve",
      params: { curveRadius: 12, curveAngle: 90 },
    },
    {
      id: "turn_hairpin_135_r",
      label: "Hairpin 135",
      base: "curve",
      params: { curveRadius: 12, curveAngle: 135 },
    },
    {
      id: "turn_hairpin_180_r",
      label: "Hairpin 180",
      base: "curve",
      params: { curveRadius: 12, curveAngle: 180 },
    },
    // ── Tight, R24 — 63 km/h ─────────────────────────────────────────────
    {
      id: "turn_smooth_small", // kept: `buildParkourTrack` reaches for this one
      label: "Tight 45",
      base: "curve",
      params: { curveRadius: 24, curveAngle: 45 },
    },
    {
      id: "turn_smooth_long",
      label: "Tight 90",
      base: "curve",
      params: { curveRadius: 24, curveAngle: 90 },
    },
    {
      id: "turn_tight_135_r",
      label: "Tight 135",
      base: "curve",
      params: { curveRadius: 24, curveAngle: 135 },
    },
    // ── Medium, R40 — 81 km/h ────────────────────────────────────────────
    {
      id: "turn_medium_30_r",
      label: "Medium 30",
      base: "curve",
      params: { curveRadius: 40, curveAngle: 30 },
    },
    {
      id: "turn_medium_45_r",
      label: "Medium 45",
      base: "curve",
      params: { curveRadius: 40, curveAngle: 45 },
    },
    {
      id: "turn_medium_90_r",
      label: "Medium 90",
      base: "curve",
      params: { curveRadius: 40, curveAngle: 90 },
    },
    // ── Sweeper, R70 — 108 km/h ──────────────────────────────────────────
    {
      id: "turn_sweeper_30_r",
      label: "Sweeper 30",
      base: "curve",
      params: { curveRadius: 70, curveAngle: 30 },
    },
    {
      id: "turn_sweeper_45_r",
      label: "Sweeper 45",
      base: "curve",
      params: { curveRadius: 70, curveAngle: 45 },
    },
    {
      id: "turn_sweeper_90_r",
      label: "Sweeper 90",
      base: "curve",
      params: { curveRadius: 70, curveAngle: 90 },
    },
    // ── Kink, R130 — 147 km/h ────────────────────────────────────────────
    {
      id: "turn_kink_15_r",
      label: "Kink 15",
      base: "curve",
      params: { curveRadius: 130, curveAngle: 15 },
    },
    {
      id: "turn_kink_30_r",
      label: "Kink 30",
      base: "curve",
      params: { curveRadius: 130, curveAngle: 30 },
    },
    {
      id: "turn_kink_45_r",
      label: "Kink 45",
      base: "curve",
      params: { curveRadius: 130, curveAngle: 45 },
    },
    /*
     * ⚠ THESE TWO ARE EACH OTHER'S, and they are left that way ON PURPOSE.
     *
     * `sCurvePoints` is handed the opposite way round from every other piece in
     * the kit. MEASURED at R20 / 38° / curveDir +1, exit x: `curve` and `banked`
     * land at +4.24 (right — travel is −Z and up is +Y, so right is +X) while
     * `scurve` lands at −8.48. So "S Right" below builds a left-hand S-bend.
     *
     * The fix is a sign flip in sCurvePoints, not a swap here — but it mirrors
     * the two scurve pieces in apex-parkour.json and everything downstream of
     * them, which is a call for whoever owns that track. Until then the tiles
     * stay consistent with the piece rather than with their own names, and the
     * tube S-bends in the Tubes tab follow the same convention so at least the
     * whole palette is wrong in one direction. No further S-curve sizes are
     * added here for the same reason: more tiles is more to re-label later.
     */
    {
      id: "turn_s_right",
      label: "S-bend",
      base: "scurve",
      params: { curveRadius: 20, curveAngle: 38 },
    },
  ],
  // JUNCTIONS. Every tile is the same handful of plate shapes at different
  // sizes / sides; `curveDir` is what "R flips L/R" acts on, so the left-hand
  // variants are the identical preset with curveDir: -1.
  junctions: [
    {
      id: "junction_split_r",
      label: "Split",
      base: "junction_split",
      params: { splitAngle: 24, splitLength: 40, splitArm: 30, splitStart: 8 },
    },
    {
      id: "junction_split_wide",
      label: "Split wide",
      base: "junction_split",
      params: { splitAngle: 40, splitLength: 44, splitArm: 34, splitStart: 6 },
    },
    {
      id: "junction_merge_r",
      label: "Merge",
      base: "junction_merge",
      params: { splitAngle: 24, splitLength: 40, splitArm: 30, splitStart: 8 },
    },
    {
      id: "junction_y_r",
      label: "Y fork",
      base: "junction_y",
      params: { forkAngle: 30, forkArm: 34, forkThroat: 6 },
    },
    {
      id: "junction_y_wide",
      label: "Y fork wide",
      base: "junction_y",
      params: { forkAngle: 55, forkArm: 30, forkThroat: 4 },
    },
    {
      id: "junction_t_r",
      label: "T",
      base: "junction_t",
      params: { junctionLength: 34, junctionStub: 24, junctionFillet: 6 },
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
      params: { loopRadius: 25, loopOffset: 16, loopFlat: 12, loopSpread: 1, loopLean: 0, loopTighten: 0, loopStretch: 0, loopHalf: "full" },
    },
    {
      // TRACKMANIA OFFSET LOOPING: the compact looping's feet sit 16 m apart
      // under a planar ring, so start and end read as one split circle. This
      // one is the same generator with the sideways gap opened to several road
      // widths and spread 0 (even helix, not two feet slid apart). The ring
      // stays a full circle in YZ — stretching it along the track is what made
      // the first attempt look MORE compact (the backswing collapsed and the
      // hole shrank). No half tile yet.
      id: "looping_offset",
      label: "Offset looping",
      base: "loop",
      params: { loopRadius: 25, loopOffset: 56, loopFlat: 12, loopSpread: 0, loopLean: 0, loopTighten: 0, loopStretch: 0, loopHalf: "full" },
    },
    {
      id: "loop_half_right",
      label: "Ring half (in)",
      base: "loop_half",
      params: { loopRadius: 25, loopOffset: 16, loopFlat: 12, loopSpread: 1, loopHalf: "in" },
    },
    {
      id: "loop_half_left",
      label: "Ring half (out)",
      base: "loop_half",
      params: { loopRadius: 25, loopOffset: 16, loopFlat: 12, loopSpread: 1, loopHalf: "out" },
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
      id: "quarterpipe_down_std",
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
  if (catId === "obstacles" || catId === "scenery" || catId === "parkour") {
    return propCatalog.find((p) => (p.category ?? "obstacles") === catId)?.id ?? null;
  }
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
  } = opts;
  const catList = document.getElementById("category-list");
  const grid = document.getElementById("piece-grid");
  const titleEl = document.getElementById("category-title");
  const statusEl = document.getElementById("road-status");
  const selectedNameEl = document.getElementById("selected-piece-name");
  const selectedCatEl = document.getElementById("selected-piece-cat");
  const handBtn = document.getElementById("hand-toggle");
  const handVal = document.getElementById("hand-toggle-val");
  const edgesBtn = document.getElementById("edges-toggle");
  const collapseTab = document.getElementById("palette-collapse-tab");
  const palette = document.getElementById("palette");

  /** @type {Map<string, HTMLButtonElement>} */
  const pieceTiles = new Map();
  /** @type {Map<string, HTMLButtonElement>} */
  const catBtns = new Map();

  let activeCategory = "game";
  let activePropId = null;
  let activeMoverId = null;
  let activePresetId = null;
  let activePortalId = null;
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

  /**
   * A category's icon is a baked thumbnail of the first tile in it, so it can
   * fail exactly the way a piece tile's can — and a rail of 14 identical grey
   * placeholder plates with no captions is unusable in the same way. `unbaked`
   * is the same flag the tiles use and buys the same fallback: the name comes
   * back only while the picture cannot do its job. See .cat-btn.unbaked.
   */
  function fillCategoryIcon(el, catId) {
    const key = categoryThumbnailKey(catId, propCatalog, moverCatalog);
    const sprite = key ? thumbSprite(key) : null;
    if (sprite) el.replaceChildren(sprite);
    else el.innerHTML = placeholderSvg();
    el.closest(".cat-btn")?.classList.toggle("unbaked", !sprite);
  }

  function piecesInCategory(catId) {
    // Props split across tabs by their own `category`, defaulting to obstacles.
    if (catId === "obstacles" || catId === "scenery" || catId === "parkour") {
      const items = propCatalog
        .filter((p) => (p.category ?? "obstacles") === catId)
        .map((p) => ({ id: p.id, label: p.label, isProp: true, hint: "" }));
      // Portal doors use their own pairing system, but they belong with
      // obstacles — not a whole palette tab for one tile. Placement is the
      // same cursor brush as the other obstacles.
      if (catId === "obstacles") {
        items.push({
          id: "portal_door",
          label: "Portal door",
          isPortal: true,
          hint: "Adds a door (pairs up in twos)",
        });
      }
      return items;
    }
    if (catId === "moving") {
      return moverCatalog.map((m) => ({ id: m.id, label: m.label, isMover: true, hint: "" }));
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

  /**
   * "Up Medium — holds at any speed (crest R 33 m)", for the tile's tooltip.
   *
   * THE ONE NUMBER THAT WAS INVISIBLE. A vertical piece looks fine in the
   * thumbnail and in the editor at walking pace, and then throws the car off at
   * racing speed — so from the palette there was no way to tell a hill from a
   * jump ramp except by driving it. This says it before you place it.
   *
   * WHICH LIMIT IT QUOTES DEPENDS ON THE PIECE, and it has to. A piece on the
   * FOLLOW_ROAD list gets road hold, so its limit is what the hold can carry
   * (heldSpeed) — for anything with a radius over ~23 m that is "any speed", and
   * saying "follow to 67 km/h" there would be a straight lie about a car that
   * holds it at 173. A piece off that list is on its own against gravity, so it
   * gets the unaided figure (followSpeed). Same tooltip, different physics,
   * because they really are different pieces.
   *
   * Only for pieces that HAVE a convex vertical curve; everything else (and
   * everything meant to launch) gets the plain label, because a follow limit on
   * a jump ramp is noise. See convexVerticalRadius.
   */
  function tileTitle(item) {
    const pp = item.preset ? { ...PIECE_DEFAULTS, ...item.preset.params } : PIECE_DEFAULTS;
    const base = item.preset?.base ?? item.id;
    const R = convexVerticalRadius(base, pp);
    if (!R) return item.label;
    const held = isFollowRoad(base);
    const v = held ? heldSpeed(R) : followSpeed(R);
    const speed = Number.isFinite(v)
      ? `${held ? "launches above" : "follow to"} ${Math.round(v * 3.6)} km/h`
      : "holds at any speed";
    return `${item.label} — ${speed} (crest R ${Math.round(R)} m)`;
  }

  function syncEdgesBtn() {
    if (!edgesBtn) return;
    const on = guardrailParams.enabled;
    edgesBtn.classList.toggle("on", on);
    edgesBtn.innerHTML = on ? "Edges<br>On" : "Edges<br>Off";
  }

  function setActiveCategory(catId) {
    if (activeCategory === catId) return;
    activeCategory = catId;
    renderPieces();
  }

  function renderPieces() {
    grid.innerHTML = "";
    pieceTiles.clear();
    // Browsing a tab must not disarm a prop/mover brush. renderPieces used to
    // null these, which was invisible on click-to-switch and a landmine once
    // the rail selects on hover: sweeping the mouse down the rail would drop
    // a live cone under you. The strip and highlight stay on the selection
    // (see activeCategoryLabel); only picking a tile in THIS grid, a hotkey,
    // or clearBrushHighlight cancels the brush.

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
      if (item.isPortal) btn.dataset.isPortal = "1";
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
      // The caption is now the BAKE-FAILED fallback, not furniture: with a
      // sprite the tile is a picture you recognise and the name lives in
      // #selected-piece, but a placeholder plate with no name is one of 167
      // identical grey buttons. setThumbnails() clears this when a bake lands.
      if (!sprite) btn.classList.add("unbaked");
      // So the name is always one hover away, whichever state the tile is in —
      // plus, on a vertical piece, the speed the car can follow it at.
      btn.title = tileTitle(item);

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
          activePortalId = null;
          activePresetId = null;
          builder.setActivePiece(builder.activePieceId);
          onAddProp(item.id);
          refreshStatus();
          return;
        }
        if (item.isMover && onAddMover) {
          activeMoverId = item.id;
          activePropId = null;
          activePortalId = null;
          activePresetId = null;
          builder.setActivePiece(builder.activePieceId);
          onAddMover(item.id);
          refreshStatus();
          return;
        }
        if (item.isPortal && onAddPortal) {
          activePortalId = item.id;
          activePropId = null;
          activeMoverId = null;
          activePresetId = null;
          builder.setActivePiece(builder.activePieceId);
          onAddPortal();
          refreshStatus();
          return;
        }
        if (item.isPreset) {
          activePropId = null;
          activeMoverId = null;
          activePortalId = null;
          activePresetId = item.id;
          onPickPiece?.();
          builder.setActivePreset(item.preset);
          refreshStatus();
          return;
        }
        activePropId = null;
        activeMoverId = null;
        activePortalId = null;
        activePresetId = null;
        onPickPiece?.(); // choosing a road piece cancels a prop brush
        builder.setActivePiece(item.id);
        refreshStatus();
      });

      grid.appendChild(btn);
      const suffix = item.isProp ? ":prop" : item.isMover ? ":mover" : item.isPortal ? ":portal" : item.isPreset ? ":preset" : "";
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
      } else if (key.endsWith(":portal")) {
        active = activePortalId === key.slice(0, -7);
      } else if (key.endsWith(":preset")) {
        active = activePresetId === key.slice(0, -7);
      } else {
        active = !activePropId && !activeMoverId && !activePortalId && !activePresetId && key === builder.activePieceId;
      }
      btn.classList.toggle("active", active);
    }
    for (const [id, btn] of catBtns) {
      btn.classList.toggle("active", id === activeCategory);
    }
  }

  /**
   * The name of whatever the palette is currently holding — prop brush, mover
   * brush, preset tile or raw piece, in the order they take precedence.
   *
   * Its own function because two places need the same answer and used to derive
   * it separately: the status line, and #selected-piece (where the per-tile
   * captions went when the grid went to three columns). Two copies of this is
   * how you get a strip that says "Straight" while the status line says you are
   * carrying a traffic cone.
   */
  function activeLabel() {
    if (activePortalId) return "Portal door";
    if (activePropId || activeMoverId) {
      const src = activePropId ? propCatalog : moverCatalog;
      const id = activePropId ?? activeMoverId;
      return src.find((p) => p.id === id)?.label ?? id;
    }
    if (activePresetId) {
      const all = Object.values(CATEGORY_PRESETS).flat();
      return all.find((p) => p.id === activePresetId)?.label ?? activePresetId;
    }
    return PIECE_BY_ID.get(builder.activePieceId)?.label ?? builder.activePieceId;
  }

  /**
   * The category the SELECTED PIECE belongs to — which is not always the tab
   * you are looking at.
   *
   * DERIVED FROM THE SELECTION, never read off `activeCategory`, and that is the
   * whole point of the function. Browsing to Tubes without clicking anything
   * leaves the junction you picked as the thing you will place, so a strip
   * driven by the visible tab would say "TUBES · Split R" — confidently wrong
   * about the half you cannot otherwise check. Deriving it also means the strip
   * stays right for selections the tabs never made: a piece hotkey, the `R`
   * flip, or selectPieceById from a right-click on the track.
   */
  function activeCategoryLabel() {
    let id;
    if (activePropId) {
      id = propCatalog.find((p) => p.id === activePropId)?.category ?? "obstacles";
    } else if (activeMoverId) {
      id = "moving";
    } else if (activePortalId) {
      id = "obstacles";
    } else if (activePresetId) {
      id = Object.keys(CATEGORY_PRESETS)
        .find((cat) => CATEGORY_PRESETS[cat].some((p) => p.id === activePresetId));
    } else {
      id = PIECE_TO_CATEGORY[builder.activePieceId];
    }
    return PALETTE_CATEGORIES.find((c) => c.id === id)?.label ?? "";
  }

  /**
   * The hand chip, and the hand suffix on the strip.
   *
   * The suffix is the whole reason dropping the L tiles is safe: the tile no
   * longer names a direction, so this is the only place that says which way the
   * thing you are about to place will go (the ghost shows it, but the strip is
   * where you read it). It appears ONLY on pieces the hand does anything to —
   * "Straight L" would be a lie.
   */
  function refreshHand() {
    const on = !activePropId && !activeMoverId && !activePortalId && builder.activePieceHanded;
    if (handVal) handVal.textContent = builder.hand >= 0 ? "R" : "L";
    if (handBtn) {
      handBtn.classList.toggle("inert", !on);
      handBtn.title = on
        ? `Corners go ${builder.hand >= 0 ? "right" : "left"} — press R to flip`
        : "This piece has no left or right";
    }
    return on ? (builder.hand >= 0 ? " R" : " L") : "";
  }

  function refreshStatus() {
    // Set before the branches below, so the strip is right in every mode —
    // including the prop/mover early return.
    const hand = refreshHand();
    if (selectedNameEl) selectedNameEl.textContent = activeLabel() + hand;
    if (selectedCatEl) selectedCatEl.textContent = activeCategoryLabel();

    // A prop/mover brush is a MODE, and the status line is the only thing that
    // says so — without this it goes on naming the road piece while the mouse is
    // carrying a cone, which is the same class of lie selectPieceById fixed.
    if (statusEl && (activePropId || activeMoverId || activePortalId)) {
      const label = activeLabel();
      statusEl.textContent =
        `${builder.count} placed · ${label} — click to place, Esc to cancel`;
      syncTiles();
      return;
    }
    if (statusEl) {
      const label = activeLabel();
      // ONE SOURCE FOR "IS THIS PIECE HANDED", shared with the hand chip and the
      // strip. This used to be a hand-typed list of ten ids that had drifted:
      // it missed the whole tube family, the bank ramps and the loop,
      // so the status line silently stopped reporting the direction for half the
      // pieces it applies to. isHandedPiece is derived and covered by a test.
      const dir = builder.hand >= 0 ? "R" : "L";
      const chainInfo =
        builder.chainCount > 1 ? ` · chain ${builder.activeChainIndex + 1}/${builder.chainCount}` : "";
      // A MULTI-SELECTION CHANGES WHAT THE KEYS DO — Del, Enter, L, U and the
      // arrows all act on the whole run — so the count has to be on screen.
      const selInfo = builder.selectionCount > 1
        ? ` · ${builder.selectionCount} pieces selected (Del · Enter replace · L level · U edges · arrows bank · . orbit)`
        : "";
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
        builder.activePieceHanded ? " (" + dir + ")" : ""
      }${sizeInfo}${chainInfo}${selInfo}${endInfo}${branchInfo} · ${gizmoHint}`;
    }
    syncTiles();
  }

  // Category rail — hover opens the tab, click still does it immediately.
  // Instant hover-select is a trap: Edges and Hand sit ABOVE this list, so the
  // mouse path from the piece grid to those chips crosses every category, and
  // rebuilding the grid on each flyover is churn nobody asked for. Dwell
  // filters that. Click stays for touch (no hover) and for "this one, NOW".
  //
  // ARMED FROM pointermove, NOT pointerenter — the difference is the scroll.
  // The rail overflows (13 buttons at ~100px each beat any screen), so a wheel
  // over it drags buttons UNDER a stationary cursor, and every one of those
  // fires a real pointerenter. Enter-armed, you change category by scrolling,
  // having pointed at nothing. Move-armed, you cannot: no movement, no
  // candidate. It also recovers on the first pixel of genuine movement after
  // the scroll, where "ignore enters for 250ms" would leave the tab under the
  // cursor stuck shut — the pointer is already inside it and gets no second
  // enter until you leave and come back.
  //
  // ONE delegated listener on the list, not two per button: it only runs while
  // the cursor is actually in the 104px rail, and it is a closest() plus a
  // string compare that returns on all but the first move onto a new button.
  let catHoverTimer = 0;
  /** The button the dwell is armed for (or null) — so repeat moves inside one
   *  button do not keep restarting its own timer, which would mean the tab only
   *  ever opened once the mouse stopped dead. */
  let catHoverPending = null;
  const CAT_HOVER_MS = 120;
  const catHoverSelects = typeof window !== "undefined"
    && !!window.matchMedia?.("(hover: hover) and (pointer: fine)")?.matches;

  function armCatHover(catId) {
    if (catId === catHoverPending) return;
    clearTimeout(catHoverTimer);
    catHoverPending = catId;
    if (!catId || catId === activeCategory) return;
    catHoverTimer = window.setTimeout(() => setActiveCategory(catId), CAT_HOVER_MS);
  }

  if (catList) {
    for (const cat of PALETTE_CATEGORIES) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "cat-btn";
      btn.dataset.categoryId = cat.id;
      // The label is the bake-failed fallback (CSS hides it otherwise); `title`
      // is how you get the name of a category you have NOT selected, since
      // #category-title only ever names the active one.
      btn.title = cat.label;
      btn.innerHTML = `
        <span class="cat-btn-icon"></span>
        <span class="cat-btn-label">${cat.label}</span>
      `;
      // After innerHTML, so `unbaked` can find the button via closest().
      fillCategoryIcon(btn.querySelector(".cat-btn-icon"), cat.id);
      btn.addEventListener("click", () => {
        clearTimeout(catHoverTimer);
        catHoverPending = cat.id;
        setActiveCategory(cat.id);
      });
      catList.appendChild(btn);
      catBtns.set(cat.id, btn);
    }
    if (catHoverSelects) {
      catList.addEventListener("pointermove", (e) => {
        // A hybrid touch laptop answers "(hover: hover) and (pointer: fine)"
        // truthfully — its MOUSE can hover — and then a finger tap comes
        // through this same handler. Only the click should speak for a finger.
        if (e.pointerType === "touch") return;
        const btn = e.target instanceof Element ? e.target.closest(".cat-btn") : null;
        // The gaps between buttons disarm too: passing over one on the way
        // somewhere else should not leave a tab opening behind you.
        armCatHover(btn?.dataset.categoryId ?? null);
      });
      catList.addEventListener("pointerleave", () => {
        clearTimeout(catHoverTimer);
        catHoverPending = null;
      });
    }
  }

  handBtn?.addEventListener("click", () => {
    builder.flip();
    refreshStatus();
  });

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

  // THE PIECE HOTKEYS, GENERATED FROM THE CATALOG. Typed by hand this list is
  // guaranteed to rot — it already had: the panel advertised "1…9 0 pieces" and
  // said nothing at all about the ten LETTER keys (C D F G H L M P S T), so the
  // Gap spacer on `G` looked like a bug rather than a shortcut.
  const legendKeys = document.getElementById("legend-piece-keys");
  if (legendKeys) {
    const withKeys = PIECE_CATALOG.filter((p) => p.key);
    const digits = withKeys.filter((p) => /[0-9]/.test(p.key));
    const letters = withKeys.filter((p) => !/[0-9]/.test(p.key));
    const kbd = (k) => `<kbd>${k.toUpperCase()}</kbd>`;
    legendKeys.innerHTML =
      `pieces ${digits.map((p) => kbd(p.key)).join("")}` +
      `${letters.map((p) => kbd(p.key)).join("")}` +
      ` <span class="legend-dim">— hover a tile, or ? for the list</span>`;
    // The tooltip names every one, so the panel can stay a single line.
    legendKeys.title = withKeys
      .map((p) => `${p.key.toUpperCase()}  ${p.label ?? p.id}`)
      .join("\n");
  }

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
  // NO Demo / Big-circuit buttons any more — they, and the three JSON presets
  // beside them, were all authored against OLDER roadParams and so are
  // misleading to debug against. audittest.json is the single reference track.
  //
  // `builder.loadDemo()` and `builder.loadBigCircuit()` REMAIN, and must: they
  // are procedural (not stale saved geometry), which makes them good
  // deterministic fixtures, and three tests build their world with them —
  // tools/builderHistoryTest.mjs, tools/landingPlacementTest.mjs and
  // tools/tileIsABlockTest.mjs. Only the UI wiring is gone.
  document.getElementById("road-clear")?.addEventListener("click", () => {
    // CLEARS THE OBJECTS TOO. It used to take only the road pieces, which left
    // every prop, mover and portal hanging in the air over the track that used
    // to hold them up — "clear track" has to mean the track.
    //
    // The confirm appears ONLY when there is something beyond the road to lose.
    // A road-only clear feels exactly as it always did (this button gets pressed
    // a lot while iterating), and the dialog shows up precisely in the case that
    // used to surprise people — naming the object count is what teaches them the
    // button reaches both.
    const { pieces, objects } = builder.trackCounts();
    if (objects > 0) {
      const parts = [`${pieces} road piece${pieces === 1 ? "" : "s"}`,
        `${objects} object${objects === 1 ? "" : "s"}`];
      if (!window.confirm(`Clear ${parts.join(" and ")}?\n\nCtrl+Z undoes this.`)) return;
    }
    builder.clearAll();
    refreshStatus();
  });

  window.addEventListener("keydown", (e) => {
    if (e.target instanceof HTMLInputElement) return;
    const byKey = PIECE_CATALOG.find((p) => p.key === e.key);
    if (byKey) {
      activePropId = null;
      activeMoverId = null;
      activePortalId = null;
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
   *   • the status line showed the preset's label (activePresetId was never
   *     cleared from outside);
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
    activePortalId = null;
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
   * lands a couple of seconds into the session, and a full grid rebuild would
   * flicker the tiles under a live brush even though browsing no longer disarms it.
   */
  function setThumbnails(next) {
    thumbs = next;
    for (const [id, btn] of catBtns) {
      const icon = btn.querySelector(".cat-btn-icon");
      if (icon) fillCategoryIcon(icon, id);
    }
    for (const [key, btn] of pieceTiles) {
      const sprite = thumbSprite(key.replace(/:(prop|mover|portal|preset)$/, ""));
      if (sprite) {
        btn.querySelector(".piece-tile-preview")?.replaceChildren(sprite);
        // The picture can speak for itself now, so drop the caption it was
        // standing in for. Tiles the bake could not produce keep theirs.
        btn.classList.remove("unbaked");
      }
    }
  }

  /** Drop the prop/mover brush highlight — the game calls this when the brush
   *  is cancelled from its side (Escape, right-click, leaving build mode). */
  function clearBrushHighlight() {
    if (!activePropId && !activeMoverId && !activePortalId) return;
    activePropId = null;
    activeMoverId = null;
    activePortalId = null;
    refreshStatus();
  }

  return { refreshStatus, renderPieces, syncEdgesBtn, selectPieceById, clearBrushHighlight, setThumbnails };
}
