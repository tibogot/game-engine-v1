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

    /** Anchor gizmo state (pos + yaw) for the active chain. */
    this.freePlaceMode = true;
    this.freeYaw = 0;
    this._freePos = new THREE.Vector3(0, 0, 0);

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
      this.placementGizmo.addEventListener("dragging-changed", (e) => {
        if (this.orbit) this.orbit.enabled = !e.value && this.isBuildMode();
      });
      this.placementGizmo.addEventListener("change", () => this._onPlacementGizmoChange());
    }

    this.refreshGhost();
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
    this.refreshGhost();
    this._notify();
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
    this.freeYaw = yaw != null ? yaw : 0;
    if (atPos) this._freePos.copy(atPos);
    else if (this.orbit?.target) this._freePos.copy(this.orbit.target);
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

  /** Switch the active (append) chain and move the gizmo + ghost to it. */
  selectChain(chainId) {
    const chain = this.chains.find((c) => c.id === chainId);
    if (!chain) return;
    this.activeChainId = chainId;
    this.freePlaceMode = true;
    // Seed the gizmo from the chain's anchor (pos + yaw).
    this._freePos.setFromMatrixPosition(chain.anchor);
    const e = new THREE.Euler().setFromRotationMatrix(chain.anchor, "YXZ");
    this.freeYaw = e.y;
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
    if (!this.placementGizmo || !this.freePlaceMode) return;
    this.placementGizmo.setMode(mode);
    this._notify();
  }

  /** True while dragging / hovering the free-placement gizmo (suppress LMB place). */
  isUsingPlacementGizmo() {
    return (
      this.freePlaceMode &&
      this.placementGizmo &&
      (this.placementGizmo.dragging || this.placementGizmo.axis != null)
    );
  }

  _showPlacementGizmo() {
    if (!this.placementGizmo) return;
    this.placementPivot.position.copy(this._freePos);
    this.placementPivot.rotation.set(0, this.freeYaw, 0);
    this.placementGizmo.attach(this.placementPivot);
    this.placementGizmo.setMode("translate");
    this.placementGizmo.enabled = true;
    this.placementGizmo.visible = true;
  }

  _hidePlacementGizmo() {
    if (!this.placementGizmo) return;
    this.placementGizmo.detach();
    this.placementGizmo.enabled = false;
    this.placementGizmo.visible = false;
  }

  _onPlacementGizmoChange() {
    if (!this.freePlaceMode) return;
    this._freePos.copy(this.placementPivot.position);
    this.freeYaw = this.placementPivot.rotation.y;
    this.placementPivot.rotation.set(0, this.freeYaw, 0);
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
    if (yaw !== undefined) this.freeYaw = yaw;
    this.placementPivot.position.copy(this._freePos);
    this.placementPivot.rotation.set(0, this.freeYaw, 0);
    const chain = this._activeChain();
    if (chain) chain.anchor = this._anchorFromFree();
    this.rebuildAll();
  }

  rotateFreeYaw(delta) {
    if (!this.freePlaceMode) return;
    this.freeYaw += delta;
    this.placementPivot.rotation.set(0, this.freeYaw, 0);
    const chain = this._activeChain();
    if (chain) chain.anchor = this._anchorFromFree();
    this.rebuildAll();
  }

  /** Build a connector matrix from the gizmo's pos + yaw. */
  _anchorFromFree() {
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.freeYaw);
    const travel = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    return socketMatrix(this._freePos, travel, new THREE.Vector3(0, 1, 0));
  }

  /** Rebuild the translucent ghost at the current open connector. */
  refreshGhost() {
    const { geometry, world } = buildPiece(
      this.activePieceId,
      this.currentConnector,
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
    if (on && this.freePlaceMode) this._showPlacementGizmo();
    else this._hidePlacementGizmo();
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
        if (m) m.visible = !this.instancingEnabled && !m.userData.noRender;
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

  /** Place the active piece onto the open end. */
  place() {
    const connectorIn = this.currentConnector.clone();
    const edges = guardrailParams.enabled;
    const built = buildPiece(
      this.activePieceId,
      connectorIn,
      pieceParams,
      roadParams,
      guardrailParams,
      edges,
    );
    const mesh = this._makeMesh(built.geometry, this.material, built.world);
    mesh.userData.pieceId = this.activePieceId;
    if (built.def.noMesh) {
      mesh.userData.noCollision = true;
      mesh.userData.noRender = true; // gap = invisible spacer, nothing to instance
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

    this.pieces.push({
      id: this.activePieceId,
      chainId: this.activeChainId,
      pp: this._snapshotParams(),
      edges,
      mesh,
      railMesh,
      shellMesh,
      decorMesh,
      connectorIn,
      connectorOut: built.connectorOut.clone(),
    });
    this.currentConnector = built.connectorOut.clone();
    this._rebuildInstances();
    // Keep the anchor gizmo on the active chain so the whole chain stays movable.
    this._showPlacementGizmo();
    this.refreshGhost();
    this._notify();
    return mesh;
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
    this._showPlacementGizmo();
    this.refreshGhost();
    this._notify();
    return true;
  }

  clear() {
    for (const p of this.pieces) this._removePiece(p);
    this.pieces = [];
    this._rebuildInstances();
    this.chains = [{ id: 0, anchor: initialConnector() }];
    this.chainSeq = 1;
    this.activeChainId = 0;
    this.freePlaceMode = true;
    this._freePos.set(0, 0, 0);
    this.freeYaw = 0;
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

      this.pieces.push({
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
      });
    }
    this._rebuildInstances();
    // Reconstruct chains from the loaded pieces (anchor = first piece's entry).
    const seen = new Map();
    for (const p of this.pieces) {
      if (!seen.has(p.chainId)) seen.set(p.chainId, { id: p.chainId, anchor: p.connectorIn.clone() });
    }
    this.chains = seen.size ? [...seen.values()] : [{ id: 0, anchor: initialConnector() }];
    this.chainSeq = Math.max(-1, ...this.chains.map((c) => c.id)) + 1;
    this.activeChainId = this.chains[this.chains.length - 1].id;
    this.freePlaceMode = true;
    const a = this.chains[this.chains.length - 1].anchor;
    this._freePos.setFromMatrixPosition(a);
    this.freeYaw = new THREE.Euler().setFromRotationMatrix(a, "YXZ").y;
    this._syncCurrentConnector();
    this._hidePlacementGizmo();
    this.refreshGhost();
    this._notify();
  }

  /** Load a few pieces so the page isn't empty on first open. */
  loadDemo() {
    this.clear();
    const demo = ["straight", "curve", "slope", "straight", "curve"];
    const savedDir = pieceParams.curveDir;
    for (const id of demo) {
      this.activePieceId = id;
      this.place();
    }
    pieceParams.curveDir = savedDir;
    this.activePieceId = PIECE_CATALOG[0].id;
    this.refreshGhost();
    this._notify();
  }

  /**
   * Load a large, coherent CLOSED circuit — a flowing flat lap that returns
   * exactly onto its own start line. The design rules that make it work:
   *
   *  - **Canonical pieces only.** Every corner is a true 90° / 45° curve at a
   *    fixed radius — no bespoke angles — so each piece matches a preset and
   *    stays GPU-instanceable. This relies on the kit's exact connector tangents
   *    (see applyEndTangents): a 90° curve really does turn 90°, so four of them
   *    sum to 360° and the loop closes on its labelled angles.
   *
   *  - **Exact closure via 180° rotational symmetry.** The lap is two identical
   *    halves; each turns exactly 180° (two 90° corners; the chicane's opposite
   *    45°s net 0°), so placing the half twice turns a full 360° and lands back
   *    on the start — the position closes automatically, no hand-tuned lengths.
   *
   *  - **Dead flat, so it can never go underground.** Banked corners would sink
   *    their low edge below ground at deck level, so corners stay flat. Variety
   *    comes from the sweepers, a chicane, a tunnel, and the game lines.
   *    (Elevation belongs on the open, non-closed chains the free demo builds.)
   */
  loadBigCircuit() {
    this.clear();
    const saved = { ...pieceParams };
    const put = (id, overrides = {}) => {
      Object.assign(pieceParams, overrides);
      this.activePieceId = id;
      this.place();
    };

    const R = 34; // sweeping corner radius (m)
    const Rc = 22; // tighter chicane radius (m)

    // One half-lap: turns exactly 180° (two 90° corners; the chicane nets 0°)
    // and stays perfectly flat. `gameId` opens the half with its game line.
    const half = (gameId) => {
      put(gameId, { gameLineLength: 22 }); // start / finish line on the straight
      put("straight", { straightLength: 36 });
      put("straight", { straightLength: 30 });
      put("curve", { curveRadius: R, curveAngle: 90, curveDir: 1 }); // corner (90°)
      put("straight", { straightLength: 28 });
      // Chicane: equal-and-opposite curves → an S-kink that nets exactly 0°.
      put("curve", { curveRadius: Rc, curveAngle: 45, curveDir: -1 });
      put("curve", { curveRadius: Rc, curveAngle: 45, curveDir: 1 });
      put("straight", { straightLength: 24 });
      put("checkpoint", { gameLineLength: 16 }); // mid-half checkpoint
      put("tunnel", { straightLength: 30 }); // enclosed section
      put("straight", { straightLength: 28 });
      put("curve", { curveRadius: R, curveAngle: 90, curveDir: 1 }); // corner (90°)
    };

    half("start"); // first half opens on the start line
    half("finish"); // second half opens on the finish line, then closes onto start

    Object.assign(pieceParams, saved);
    this.activePieceId = PIECE_CATALOG[0].id;
    this.refreshGhost();
    this._notify();
  }

  /** @returns {{id:string, chainId:number, pp:object, edges:boolean, connectorIn:number[]}[]} */
  exportTrackPieces() {
    return this.pieces.map((p) => ({
      id: p.id,
      chainId: p.chainId ?? 0,
      pp: { ...p.pp },
      edges: p.edges ?? true,
      connectorIn: p.connectorIn.toArray(),
    }));
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
  tunnel: "straight",
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
  { id: "obstacles", label: "Obstacles" },
  { id: "moving", label: "Moving" },
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
      id: "bank_short_turn",
      label: "Short Turn",
      base: "banked",
      params: { curveRadius: 18, curveAngle: 60, bankAngle: 22, curveDir: 1 },
      preview: `<svg viewBox="0 0 80 80"><path d="M22 68 L22 40 Q22 22 44 22 L66 22" ${_RS}/></svg>`,
    },
    {
      id: "bank_long_turn",
      label: "Long Turn",
      base: "banked",
      params: { curveRadius: 30, curveAngle: 90, bankAngle: 22, curveDir: 1 },
      preview: `<svg viewBox="0 0 80 80"><path d="M18 70 L18 40 Q18 18 40 18 L70 18" ${_RS}/></svg>`,
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
    onEdgesChange = null,
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
        if (item.isProp && onAddProp) {
          activePropId = item.id;
          activeMoverId = null;
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
        if (item.isPreset) {
          activePropId = null;
          activeMoverId = null;
          activePresetId = item.id;
          builder.setActivePreset(item.preset);
          refreshStatus();
          return;
        }
        activePropId = null;
        activeMoverId = null;
        activePresetId = null;
        builder.setActivePiece(item.id);
        refreshStatus();
      });

      grid.appendChild(btn);
      const suffix = item.isProp ? ":prop" : item.isMover ? ":mover" : item.isPreset ? ":preset" : "";
      pieceTiles.set(item.id + suffix, btn);
    }
    refreshStatus();
  }

  function refreshStatus() {
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
      statusEl.textContent = `${builder.count} placed · ${label}${
        curveIds.has(builder.activePieceId) ? " (" + dir + ")" : ""
      }${chainInfo} · anchor gizmo drags whole chain`;
    }
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
    builder.loadDemo();
    refreshStatus();
  });
  document.getElementById("road-circuit")?.addEventListener("click", () => {
    builder.loadBigCircuit();
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

  return { refreshStatus, renderPieces, syncEdgesBtn };
}
