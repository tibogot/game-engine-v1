import * as THREE from "three";
import { buildLabNetworkGeometry, ROAD_PROFILES } from "../../core/road/roadNetworkLabGeometry.js";

/**
 * Smart Road system — the proven `v2/smart-road-lab.html` brain as a reusable,
 * host-agnostic module. The lab and the v2 editor both drive it: the host owns
 * the scene, terrain height sampling, camera, and input; this class owns the
 * network model, mesh/marking/handle building, and the editing operations.
 *
 * Terrain conform (vertical easing + flatten) is intentionally NOT here yet —
 * roads drape directly on `getHeight` (raw terrain). That's the "editing first"
 * port stage; conform lands next and only changes the height function.
 *
 * Host contract:
 *   - `getHeight(x, z) => y` — world terrain height (v2: getWorldHeight).
 *   - call `update()` once per frame (does the throttled rebuild).
 *   - route picking via `pickHandle(raycaster)` and drive the editing ops.
 */

export { ROAD_PROFILES };

export const SMART_ROAD_DEFAULTS = {
  width: 14,
  lanesPerDir: 1,
  junctionRadius: 14,
  roundaboutRadius: 16,
  curveSegments: 34,
  junctionSegments: 14,
  twoRoadNodes: "smooth",
  endCapStyle: "round",
  profilePreset: "flat",
  profileScale: 1,
  spanLongStep: 2,
  lateralCols: 5,
  centerLine: true,
  centerLineDashed: true,
  doubleCenterLine: false,
  laneLines: false,
  lineWidth: 0.02,
  centerLineWidth: 0.022,
  centerLineGap: 0.012,
  dashScale: 0.08,
  clearance: 0.1,
  showHandles: true,
  handleLift: 1.0,
};

export class SmartRoadLabSystem {
  /**
   * @param {object}   opts
   * @param {THREE.Object3D} opts.scene      parent to add road/handle groups to
   * @param {(x:number,z:number)=>number} opts.getHeight world terrain height
   * @param {object}  [opts.params]          merged over SMART_ROAD_DEFAULTS
   * @param {object}  [opts.materials]       { asphalt, junction, white, yellow } overrides
   */
  constructor({ scene, getHeight, params = {}, materials = {} }) {
    this.scene = scene;
    this.getHeight = getHeight || (() => 0);
    this.params = { ...SMART_ROAD_DEFAULTS, ...params };

    this.nodes = []; // { id, x, z, forceJunction, roundabout }
    this.edges = []; // { a, b, bend }
    this.selectedNodeId = null;
    this._nextNodeId = 1;

    this.roadGroup = new THREE.Group();
    this.roadGroup.name = "SmartRoadMeshes";
    this.handleGroup = new THREE.Group();
    this.handleGroup.name = "SmartRoadHandles";
    scene.add(this.roadGroup);
    scene.add(this.handleGroup);

    this._handleMeshes = [];
    this._edgeHandleMeshes = [];
    this._rebuildQueued = false;
    this._lastRebuildAt = 0;
    this._rebuildThrottleMs = 60;

    this._handleGeo = new THREE.SphereGeometry(2.0, 16, 12);
    this._edgeHandleGeo = new THREE.SphereGeometry(1.3, 12, 10);

    const lineProps = {
      roughness: 0.85, metalness: 0, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    };
    this._mat = {
      asphalt: materials.asphalt || new THREE.MeshStandardMaterial({ color: 0x2c3138, roughness: 0.92, metalness: 0, side: THREE.DoubleSide }),
      junction: materials.junction || new THREE.MeshStandardMaterial({ color: 0x2c3138, roughness: 0.92, metalness: 0, side: THREE.DoubleSide }),
      white: materials.white || new THREE.MeshStandardMaterial({ color: 0xe9e9e9, ...lineProps }),
      yellow: materials.yellow || new THREE.MeshStandardMaterial({ color: 0xe8c33c, ...lineProps }),
    };
    this._matHandle = new THREE.MeshBasicMaterial({ color: 0x62c4ff });
    this._matHandleSel = new THREE.MeshBasicMaterial({ color: 0xffd24a });
    this._matHandleJunc = new THREE.MeshBasicMaterial({ color: 0xff7a5c });
    this._matHandleRound = new THREE.MeshBasicMaterial({ color: 0x4ad0a0 });
    this._matHandleEdge = new THREE.MeshBasicMaterial({ color: 0xb98fff });
    this._matEdgeLine = new THREE.LineBasicMaterial({ color: 0x62c4ff, transparent: true, opacity: 0.55 });
  }

  // ── Network model ──────────────────────────────────────────────────────────
  setNetwork(nodes, edges) {
    this.nodes = (nodes || []).map((n) => ({
      id: Number(n.id), x: +n.x, z: +n.z,
      forceJunction: !!n.forceJunction, roundabout: !!n.roundabout,
    }));
    this.edges = (edges || []).map((e) => ({ a: Number(e.a), b: Number(e.b), bend: Number(e.bend) || 0 }));
    this._nextNodeId = Math.max(0, ...this.nodes.map((n) => n.id)) + 1;
    this.selectedNodeId = null;
    this.queueRebuild();
  }

  exportData() {
    return {
      nodes: this.nodes.map((n) => ({ id: n.id, x: n.x, z: n.z, forceJunction: !!n.forceJunction, roundabout: !!n.roundabout })),
      edges: this.edges.map((e) => ({ a: e.a, b: e.b, bend: e.bend || 0 })),
      nextNodeId: this._nextNodeId,
      selectedNodeId: this.selectedNodeId,
    };
  }

  importData(data) {
    if (!data || !Array.isArray(data.nodes) || !Array.isArray(data.edges)) return;
    this.setNetwork(data.nodes, data.edges);
    if (Number.isFinite(data.nextNodeId)) this._nextNodeId = data.nextNodeId;
  }

  _node(id) { return this.nodes.find((n) => n.id === id); }

  // ── Editing operations (host input drives these) ────────────────────────────
  selectNode(id) {
    this.selectedNodeId = id;
    this._refreshHandleColors();
  }
  clearSelection() {
    this.selectedNodeId = null;
    this._refreshHandleColors();
  }
  moveNode(id, x, z) {
    const n = this._node(id);
    if (n) { n.x = x; n.z = z; this.queueRebuild(); }
  }
  addNode(x, z, connectToSelected = true) {
    const node = { id: this._nextNodeId++, x, z, forceJunction: false, roundabout: false };
    this.nodes.push(node);
    if (connectToSelected && this.selectedNodeId !== null) {
      this.edges.push({ a: this.selectedNodeId, b: node.id, bend: 0 });
    }
    this.selectedNodeId = node.id;
    this.queueRebuild();
    return node.id;
  }
  /** Toggle an edge between two nodes; returns true if an edge now exists. */
  toggleEdge(a, b) {
    if (a === b) return false;
    const idx = this.edges.findIndex((e) => (e.a === a && e.b === b) || (e.a === b && e.b === a));
    if (idx >= 0) { this.edges.splice(idx, 1); this.queueRebuild(); return false; }
    this.edges.push({ a, b, bend: 0 });
    this.queueRebuild();
    return true;
  }
  setEdgeBend(edge, bend) {
    edge.bend = bend;
    this.queueRebuild();
  }
  deleteNode(id) {
    this.nodes = this.nodes.filter((n) => n.id !== id);
    this.edges = this.edges.filter((e) => e.a !== id && e.b !== id);
    if (this.selectedNodeId === id) this.selectedNodeId = null;
    this.queueRebuild();
  }
  /** Cycle the selected node: normal → forced junction → roundabout → normal. */
  cycleNodeType(id) {
    const n = this._node(id);
    if (!n) return;
    if (n.roundabout) { n.roundabout = false; n.forceJunction = false; }
    else if (n.forceJunction) { n.forceJunction = false; n.roundabout = true; }
    else { n.forceJunction = true; }
    this.queueRebuild();
  }

  /** Chord midpoint + unit perpendicular for an edge (curve passes mid + perp·bend). */
  edgeMidFrame(e) {
    const a = this._node(e.a);
    const b = this._node(e.b);
    if (!a || !b) return null;
    const dx = b.x - a.x, dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    return { mx: (a.x + b.x) / 2, mz: (a.z + b.z) / 2, px: -dz / len, pz: dx / len, chord: len };
  }

  /** Pick a node handle or edge handle under the ray. Returns { nodeId } | { edge } | null. */
  pickHandle(raycaster) {
    const nodeHit = raycaster.intersectObjects(this._handleMeshes, false)[0];
    if (nodeHit) return { nodeId: nodeHit.object.userData.nodeId };
    const edgeHit = raycaster.intersectObjects(this._edgeHandleMeshes, false)[0];
    if (edgeHit) return { edge: edgeHit.object.userData.edge };
    return null;
  }

  get handleMeshes() { return this._handleMeshes; }
  get edgeHandleMeshes() { return this._edgeHandleMeshes; }

  // ── Frame update / rebuild throttle ─────────────────────────────────────────
  queueRebuild() { this._rebuildQueued = true; }
  update() {
    if (!this._rebuildQueued) return;
    const now = performance.now();
    if (now - this._lastRebuildAt < this._rebuildThrottleMs) return;
    this._rebuildQueued = false;
    this._lastRebuildAt = now;
    this.rebuild();
  }

  setVisible(on) {
    this.roadGroup.visible = on;
    this.handleGroup.visible = on;
  }
  setHandlesVisible(on) {
    this.params.showHandles = on;
    this.queueRebuild();
  }

  _drapeY(x, z) { return this.getHeight(x, z) + this.params.clearance; }

  _disposeGroup(group) {
    for (const child of [...group.children]) {
      group.remove(child);
      if (child.geometry && child.geometry !== this._handleGeo && child.geometry !== this._edgeHandleGeo) {
        child.geometry.dispose();
      }
    }
  }

  _refreshHandleColors() {
    for (const mesh of this._handleMeshes) {
      const n = this._node(mesh.userData.nodeId);
      mesh.material = n && n.id === this.selectedNodeId
        ? this._matHandleSel
        : n?.roundabout ? this._matHandleRound : n?.forceJunction ? this._matHandleJunc : this._matHandle;
    }
  }

  // ── Build (port of the lab rebuildRoad, draped on getHeight) ─────────────────
  rebuild() {
    const P = this.params;
    this._disposeGroup(this.roadGroup);
    this._disposeGroup(this.handleGroup);
    this._handleMeshes = [];
    this._edgeHandleMeshes = [];

    const result = buildLabNetworkGeometry(
      this.nodes.map((n) => ({ id: n.id, x: n.x, z: n.z, forceJunction: !!n.forceJunction, roundabout: !!n.roundabout })),
      this.edges.map((e) => ({ a: e.a, b: e.b, bend: e.bend || 0 })),
      {
        width: P.width,
        lanesPerDir: P.lanesPerDir,
        junctionRadius: P.junctionRadius,
        roundaboutRadius: P.roundaboutRadius,
        edgeLineInset: Math.min((0.055 + P.lineWidth * 0.5) * P.width, P.width * 0.42),
        curveSegments: P.curveSegments,
        junctionSegments: P.junctionSegments,
        twoRoadNodes: P.twoRoadNodes,
        endCapStyle: P.endCapStyle,
        lateralCols: P.lateralCols,
        spanLongStep: P.spanLongStep,
        profilePreset: P.profilePreset,
        profileScale: P.profileScale,
        centerLine: P.centerLine,
        centerLineDashed: P.centerLineDashed,
        doubleCenterLine: P.doubleCenterLine,
        centerLineGap: P.centerLineGap,
        centerLineWidth: P.centerLineWidth,
        laneLines: P.laneLines,
        centerLineDashScale: P.dashScale,
        laneDashScale: P.dashScale,
      },
    );

    const hw = P.width * 0.5;
    const insetDist = Math.min((0.055 + P.lineWidth * 0.5) * P.width, P.width * 0.42);
    const edgeHalf = Math.max(0.004, P.lineWidth * P.width * 0.5);

    for (const piece of result.pieces) {
      const surfGeo = piece.grid
        ? this._gridToGeometry(piece.grid, piece.gridProfile)
        : this._polygonToGeometry(piece.polygon);
      if (surfGeo) {
        const mesh = new THREE.Mesh(surfGeo, piece.isJunctionCore ? this._mat.junction : this._mat.asphalt);
        mesh.receiveShadow = true;
        this.roadGroup.add(mesh);
      }

      if (P.lineWidth > 1e-6 && !piece.suppressEdgeStripes && !piece.networkConnector) {
        if (piece.center?.length >= 2 && !piece.isJunctionCore) {
          for (const sign of [1, -1]) {
            const path = this._offsetPath2d(piece.center, sign * (hw - insetDist));
            const stripe = this._stripeMesh(path, edgeHalf, this._mat.white, 0.03);
            if (stripe) this.roadGroup.add(stripe);
          }
        } else if (piece.isJunctionCore && Array.isArray(piece.outlineSegments)) {
          let cx = 0, cy = 0;
          for (const pt of piece.polygon) { cx += pt.x; cy += pt.y; }
          cx /= piece.polygon.length; cy /= piece.polygon.length;
          for (const seg of piece.outlineSegments) {
            if (!seg || seg.length < 2) continue;
            const plus = this._offsetPath2d(seg, insetDist);
            const minus = this._offsetPath2d(seg, -insetDist);
            const m = (seg.length / 2) | 0;
            const dPlus = Math.hypot(plus[m].x - cx, plus[m].y - cy);
            const dMinus = Math.hypot(minus[m].x - cx, minus[m].y - cy);
            const inset = dPlus < dMinus ? plus : minus;
            const stripe = this._stripeMesh(inset, edgeHalf, this._mat.white, 0.03);
            if (stripe) this.roadGroup.add(stripe);
          }
        }
      }
    }

    for (const mk of result.markings || []) {
      if (!mk.path || mk.path.length < 2) continue;
      const mat = mk.type === "divider" || mk.type === "edge" ? this._mat.white : this._mat.yellow;
      const half = (mk.type === "divider" || mk.type === "edge" ? 0.018 : P.centerLineWidth) * P.width * 0.5;
      const dashed = mk.dashed !== undefined ? mk.dashed : (mk.type === "divider" ? true : P.centerLineDashed);
      const dl = Math.max(0.6, (mk.dashScale ?? P.dashScale) * P.width * 2.5);
      const paths = dashed ? this._dashSplit(mk.path, dl, dl * 1.6) : [mk.path];
      for (const path of paths) {
        const stripe = this._stripeMesh(path, half, mat, 0.04);
        if (stripe) this.roadGroup.add(stripe);
      }
    }

    if (P.showHandles) this._buildHandles();
  }

  _buildHandles() {
    const P = this.params;
    for (const n of this.nodes) {
      const mat = n.id === this.selectedNodeId
        ? this._matHandleSel
        : n.roundabout ? this._matHandleRound : n.forceJunction ? this._matHandleJunc : this._matHandle;
      const mesh = new THREE.Mesh(this._handleGeo, mat);
      mesh.position.set(n.x, this._drapeY(n.x, n.z) + P.handleLift + 0.2, n.z);
      mesh.userData.nodeId = n.id;
      this.handleGroup.add(mesh);
      this._handleMeshes.push(mesh);
    }
    for (const e of this.edges) {
      const f = this.edgeMidFrame(e);
      if (!f) continue;
      const bend = e.bend || 0;
      const hx = f.mx + f.px * bend;
      const hz = f.mz + f.pz * bend;
      const mesh = new THREE.Mesh(this._edgeHandleGeo, this._matHandleEdge);
      mesh.position.set(hx, this._drapeY(hx, hz) + P.handleLift, hz);
      mesh.userData.edge = e;
      this.handleGroup.add(mesh);
      this._edgeHandleMeshes.push(mesh);
    }
    const linePts = [];
    for (const e of this.edges) {
      const a = this._node(e.a);
      const b = this._node(e.b);
      if (!a || !b) continue;
      linePts.push(new THREE.Vector3(a.x, this._drapeY(a.x, a.z) + P.handleLift, a.z));
      linePts.push(new THREE.Vector3(b.x, this._drapeY(b.x, b.z) + P.handleLift, b.z));
    }
    if (linePts.length) {
      const lines = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(linePts), this._matEdgeLine);
      this.handleGroup.add(lines);
    }
  }

  // ── Geometry helpers (ported from the lab; (x,y) plane → world (x,z)) ────────
  _gridToGeometry(grid, gridProfile) {
    const rows = grid.length;
    const cols = grid[0].length;
    const pos = new Float32Array(rows * cols * 3);
    let k = 0;
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < cols; j++) {
        const pt = grid[i][j];
        const profY = gridProfile ? (gridProfile[j] || 0) : 0;
        pos[k++] = pt.x;
        pos[k++] = this._drapeY(pt.x, pt.y) + profY;
        pos[k++] = pt.y;
      }
    }
    const idx = [];
    for (let i = 0; i < rows - 1; i++) {
      for (let j = 0; j < cols - 1; j++) {
        const a = i * cols + j, b = a + 1, c = a + cols, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    return geo;
  }

  _polygonToGeometry(rawPoly) {
    if (!rawPoly || rawPoly.length < 3) return null;
    const poly = this._resamplePath2d([...rawPoly, rawPoly[0]], 1.5);
    if (poly.length > 1) {
      const f = poly[0], l = poly[poly.length - 1];
      if (Math.hypot(l.x - f.x, l.y - f.y) < 1e-6) poly.pop();
    }
    if (poly.length < 3) return null;
    let cx = 0, cy = 0;
    for (const pt of poly) { cx += pt.x; cy += pt.y; }
    cx /= poly.length; cy /= poly.length;
    const n = poly.length;
    const RINGS = 3;
    const pos = new Float32Array((n * RINGS + 1) * 3);
    let k = 0;
    for (let r = 0; r < RINGS; r++) {
      const t = r / RINGS;
      for (let i = 0; i < n; i++) {
        const x = poly[i].x + (cx - poly[i].x) * t;
        const y = poly[i].y + (cy - poly[i].y) * t;
        pos[k++] = x; pos[k++] = this._drapeY(x, y); pos[k++] = y;
      }
    }
    pos[k++] = cx; pos[k++] = this._drapeY(cx, cy); pos[k++] = cy;
    const centroidIdx = n * RINGS;
    const idx = [];
    for (let r = 0; r < RINGS - 1; r++) {
      const a0 = r * n, b0 = (r + 1) * n;
      for (let i = 0; i < n; i++) {
        const i1 = (i + 1) % n;
        idx.push(a0 + i, a0 + i1, b0 + i, a0 + i1, b0 + i1, b0 + i);
      }
    }
    const last = (RINGS - 1) * n;
    for (let i = 0; i < n; i++) idx.push(centroidIdx, last + i, last + ((i + 1) % n));
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    return geo;
  }

  _resamplePath2d(path, step) {
    if (!path || path.length < 2) return path;
    const out = [path[0]];
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1], b = path[i];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const subdiv = Math.ceil(len / step);
      for (let s = 1; s <= subdiv; s++) {
        const t = s / subdiv;
        out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      }
    }
    return out;
  }

  _offsetPath2d(path, off) {
    const n = path.length;
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const p0 = path[Math.max(0, i - 1)];
      const p1 = path[Math.min(n - 1, i + 1)];
      let tx = p1.x - p0.x, ty = p1.y - p0.y;
      const len = Math.hypot(tx, ty) || 1;
      tx /= len; ty /= len;
      out[i] = { x: path[i].x + -ty * off, y: path[i].y + tx * off };
    }
    return out;
  }

  _dashSplit(path, dashLen, gapLen) {
    const frags = [];
    let current = [path[0]];
    let drawing = true;
    let remaining = dashLen;
    for (let i = 1; i < path.length; i++) {
      let ax = path[i - 1].x, ay = path[i - 1].y;
      const bx = path[i].x, by = path[i].y;
      let segLen = Math.hypot(bx - ax, by - ay);
      while (segLen > remaining) {
        const t = remaining / segLen;
        const mx = ax + (bx - ax) * t, my = ay + (by - ay) * t;
        if (drawing) {
          current.push({ x: mx, y: my });
          if (current.length >= 2) frags.push(current);
        }
        current = [{ x: mx, y: my }];
        drawing = !drawing;
        ax = mx; ay = my;
        segLen -= remaining;
        remaining = drawing ? dashLen : gapLen;
      }
      remaining -= segLen;
      if (drawing) current.push({ x: bx, y: by });
      else current = [{ x: bx, y: by }];
    }
    if (drawing && current.length >= 2) frags.push(current);
    return frags;
  }

  _stripeMesh(rawPath, hw, mat, lift) {
    if (!rawPath || rawPath.length < 2) return null;
    const path = this._resamplePath2d(rawPath, 2.0);
    const left = this._offsetPath2d(path, hw);
    const right = this._offsetPath2d(path, -hw);
    const n = path.length;
    const pos = new Float32Array(n * 2 * 3);
    let k = 0;
    for (let i = 0; i < n; i++) {
      pos[k++] = left[i].x; pos[k++] = this._drapeY(left[i].x, left[i].y) + lift; pos[k++] = left[i].y;
      pos[k++] = right[i].x; pos[k++] = this._drapeY(right[i].x, right[i].y) + lift; pos[k++] = right[i].y;
    }
    const idx = [];
    for (let i = 0; i < n - 1; i++) {
      const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
      idx.push(a, c, b, b, c, d);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 4;
    return mesh;
  }

  dispose() {
    this._disposeGroup(this.roadGroup);
    this._disposeGroup(this.handleGroup);
    this.scene.remove(this.roadGroup);
    this.scene.remove(this.handleGroup);
    this._handleGeo.dispose();
    this._edgeHandleGeo.dispose();
  }
}
