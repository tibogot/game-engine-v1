/**
 * v3/tools/tunnelSystem.js — Tunnel mode (O key).
 *
 * Click the terrain to drop nodes; the tunnel is a walkable tube swept along
 * them (see tunnelPath.js for the maths). The two END nodes set the floor
 * height at each mouth; middle nodes follow a straight grade between them
 * unless their floor height is set (pinned). So: click one side of a hill,
 * the far side, and you have a tunnel through it.
 *
 * What one tunnel owns, all rebuilt from its nodes, so an edit can never leave
 * scars behind:
 *   - its mesh (rock shell, floor, portal rings) — render, shadows, collision
 *   - its share of the TOOL hole source in the splat map (splatMap.holeProc),
 *     which opens the terrain wherever the ground passes through the tube.
 *     Painted holes are a separate source and are never touched.
 *
 * Handles and the centreline draw through the terrain (depthTest off), because
 * the interesting part of a tunnel is inside a mountain.
 *
 * Undo is a JSON snapshot of the node lists; every restore rebuilds meshes and
 * holes from scratch.
 */
import * as THREE from "three";
import { MeshStandardNodeMaterial } from "three/webgpu";
import { attribute, mix, uniform } from "three/tsl";
import {
  TUNNEL_DEFAULTS, buildTunnelGeometry, rasterizeTunnelHoles, sampleTunnel, resolveNodeHeights, FLOOR_LIFT,
} from "./tunnelPath.js";

const COL_IDLE = 0x8a8f99;
const COL_ACTIVE = 0xffa640;
const COL_PINNED = 0xffd54a;
const COL_SELECTED = 0xffffff;
const MAX_UNDO = 64;

export function createTunnelToolState() {
  return {
    tunnel: {
      showHandles: true,
      newWidth: TUNNEL_DEFAULTS.width,
      newHeight: TUNNEL_DEFAULTS.height,
      newThickness: TUNNEL_DEFAULTS.thickness,
      // Mirrors of the selection, for the panel sliders.
      selFloor: 0,
      selWidth: TUNNEL_DEFAULTS.width,
      selHeight: TUNNEL_DEFAULTS.height,
      selThickness: TUNNEL_DEFAULTS.thickness,
      wallColor: "#6f675c",
      floorColor: "#4a4239",
    },
  };
}

export class TunnelSystem {
  /**
   * @param {object} o
   * @param {THREE.Scene} o.scene
   * @param {{ tunnel: object }} o.toolState
   * @param {import("../terrain/splatMap.js").SplatMap} o.splatMap
   * @param {(wx:number, wz:number) => number} o.heightAt  ground height (metres)
   * @param {number} o.worldSize
   * @param {number} o.splatRes
   * @param {() => THREE.Camera} o.getCamera
   * @param {() => void} [o.onChanged]  tunnels or their holes changed
   */
  constructor({ scene, toolState, splatMap, heightAt, worldSize, splatRes, getCamera, onChanged }) {
    this.scene = scene;
    this.params = toolState.tunnel;
    this.splatMap = splatMap;
    this.heightAt = heightAt;
    this.worldSize = worldSize;
    this.splatRes = splatRes;
    this.getCamera = getCamera;
    this.onChanged = onChanged ?? (() => {});

    /** @type {{ nodes:{x,z,y,pinned}[], width:number, height:number, thickness:number, mesh?:THREE.Mesh }[]} */
    this.tunnels = [];
    this.activeIndex = -1;
    /** @type {{ tunnelIdx:number, nodeIdx:number } | null} */
    this.selected = null;
    this.dragging = false;
    this._dragBefore = null;
    this._dragMoved = false;
    this._editActive = false;
    this.undoStack = [];
    this.redoStack = [];

    this.group = new THREE.Group();
    this.group.name = "Tunnels";
    scene.add(this.group);
    this.handleGroup = new THREE.Group();
    this.handleGroup.name = "TunnelHandles";
    this.handleGroup.visible = false;
    scene.add(this.handleGroup);

    this._geoNode = new THREE.SphereGeometry(1, 12, 8);
    this._handleMats = new Map();
    this._lineMat = new THREE.LineBasicMaterial({ color: COL_ACTIVE, depthTest: false, transparent: true, opacity: 0.9, fog: false });
    this._lineMatIdle = new THREE.LineBasicMaterial({ color: COL_IDLE, depthTest: false, transparent: true, opacity: 0.6, fog: false });
    this._lines = [];

    this._uWall = uniform(new THREE.Color(this.params.wallColor));
    this._uFloor = uniform(new THREE.Color(this.params.floorColor));
    this._holesDueAt = 0;
    this.material = this._buildMaterial();
  }

  // ── Material ─────────────────────────────────────────────────────────────

  /**
   * Stylised rock: two flat colours (wall / floor) times a brightness baked
   * per vertex from world-space noise (aShade), so the tube needs no texture,
   * has no seams, and pays nothing per pixel for the variation.
   */
  _buildMaterial() {
    const m = new MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0 });
    const base = mix(this._uWall, this._uFloor, attribute("aFloor", "float"));
    m.colorNode = base.mul(attribute("aShade", "float"));
    return m;
  }

  syncMaterialColors() {
    this._uWall.value.set(this.params.wallColor);
    this._uFloor.value.set(this.params.floorColor);
  }

  // ── Queries ──────────────────────────────────────────────────────────────

  get activeTunnel() { return this.tunnels[this.activeIndex] ?? null; }

  /** For the collider store: one feature per built tunnel. */
  get colliderFeatures() {
    return this.tunnels.filter((t) => t.mesh).map((t) => ({ kind: "tunnel", mesh: t.mesh }));
  }

  _selectedNode() {
    const s = this.selected;
    const t = s && this.tunnels[s.tunnelIdx];
    const nd = t?.nodes[s.nodeIdx];
    return nd ? { tunnel: t, node: nd, ...s } : null;
  }

  /** Copy the selection's values into the panel's mirrored state. */
  syncSelectionToState() {
    const p = this.params;
    const t = this.activeTunnel;
    if (t) { p.selWidth = t.width; p.selHeight = t.height; p.selThickness = t.thickness; }
    const sel = this._selectedNode();
    if (sel) p.selFloor = resolveNodeHeights(sel.tunnel.nodes)[sel.nodeIdx];
  }

  // ── Authoring ────────────────────────────────────────────────────────────

  setEditActive(on) {
    this._editActive = !!on;
    this.refreshVisibility();
    if (!on) this.cancelDrag();
  }

  refreshVisibility() {
    this.handleGroup.visible = this._editActive && this.params.showHandles;
  }

  startNewTunnel() {
    this.activeIndex = -1;
    this.selected = null;
    this._rebuildHandles();
  }

  _newTunnel() {
    const p = this.params;
    const t = { nodes: [], width: p.newWidth, height: p.newHeight, thickness: p.newThickness };
    this.tunnels.push(t);
    this.activeIndex = this.tunnels.length - 1;
    return t;
  }

  /** Click on terrain: append a node to the active tunnel (prepend if node 0 is selected). */
  addNode(hit) {
    this._pushUndo();
    const t = this.activeTunnel ?? this._newTunnel();
    const nd = { x: hit.x, z: hit.z, y: hit.y, pinned: false };
    let at = t.nodes.length;
    if (this.selected && this.selected.tunnelIdx === this.activeIndex && this.selected.nodeIdx === 0 && t.nodes.length > 1) at = 0;
    t.nodes.splice(at, 0, nd);
    this.selected = { tunnelIdx: this.activeIndex, nodeIdx: at };
    this._rebuildTunnel(this.activeIndex, { holes: true });
    this._rebuildHandles();
  }

  /** Alt-click: insert a node into the nearest span of the active tunnel (XZ). */
  insertNodeNear(hit) {
    const t = this.activeTunnel;
    if (!t || t.nodes.length < 2) return false;
    let best = -1, bestD = Infinity;
    for (let i = 0; i < t.nodes.length - 1; i++) {
      const a = t.nodes[i], b = t.nodes[i + 1];
      const dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz;
      const u = l2 > 1e-9 ? Math.max(0, Math.min(1, ((hit.x - a.x) * dx + (hit.z - a.z) * dz) / l2)) : 0;
      const d = Math.hypot(hit.x - (a.x + dx * u), hit.z - (a.z + dz * u));
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best < 0) return false;
    this._pushUndo();
    const ys = resolveNodeHeights(t.nodes);
    t.nodes.splice(best + 1, 0, { x: hit.x, z: hit.z, y: (ys[best] + ys[best + 1]) * 0.5, pinned: false });
    this.selected = { tunnelIdx: this.activeIndex, nodeIdx: best + 1 };
    this._rebuildTunnel(this.activeIndex, { holes: true });
    this._rebuildHandles();
    return true;
  }

  pick(raycaster) {
    if (!this.handleGroup.visible) return null;
    // Node spheres only — the centreline Line lives in the same group and a ray
    // would otherwise "pick" it anywhere along the tunnel.
    const nodes = this.handleGroup.children.filter((o) => o.userData?.kind === "node");
    const hits = raycaster.intersectObjects(nodes, false);
    return hits.length ? hits[0].object.userData : null;
  }

  beginDrag(picked) {
    this.selected = { tunnelIdx: picked.tunnelIdx, nodeIdx: picked.nodeIdx };
    this.activeIndex = picked.tunnelIdx;
    this._dragBefore = this._snapshot();
    this._dragMoved = false;
    this.dragging = true;
    this._rebuildHandles();
  }

  /** Node drag follows the terrain. An END node's floor follows it too. */
  dragTo({ terrainHit }) {
    const sel = this._selectedNode();
    if (!this.dragging || !sel || !terrainHit) return;
    const { tunnel, node, nodeIdx } = sel;
    node.x = terrainHit.x;
    node.z = terrainHit.z;
    const isEnd = nodeIdx === 0 || nodeIdx === tunnel.nodes.length - 1;
    if (isEnd || !node.pinned) node.y = terrainHit.y;
    this._dragMoved = true;
    // Geometry only while dragging; holes and collision settle on release.
    this._rebuildTunnel(sel.tunnelIdx, { holes: false });
    this._rebuildHandles();
  }

  endDrag() {
    if (!this.dragging) return false;
    this.dragging = false;
    if (this._dragMoved) {
      this._pushUndo(this._dragBefore);
      this.rebuildHoles();
    }
    this._dragBefore = null;
    return true;
  }

  cancelDrag() {
    if (!this.dragging) return;
    this.dragging = false;
    if (this._dragMoved && this._dragBefore) this._restore(this._dragBefore);
    this._dragBefore = null;
  }

  deleteSelected() {
    const sel = this._selectedNode();
    if (!sel) return false;
    this._pushUndo();
    sel.tunnel.nodes.splice(sel.nodeIdx, 1);
    if (sel.tunnel.nodes.length === 0) {
      this._removeTunnelAt(sel.tunnelIdx);
      this.selected = null;
    } else {
      this.selected = { tunnelIdx: sel.tunnelIdx, nodeIdx: Math.max(0, sel.nodeIdx - 1) };
      this._rebuildTunnel(sel.tunnelIdx, { holes: false });
    }
    this.rebuildHoles();
    this._rebuildHandles();
    return true;
  }

  deleteActiveTunnel() {
    if (this.activeIndex < 0) return;
    this._pushUndo();
    this._removeTunnelAt(this.activeIndex);
    this.selected = null;
    this.rebuildHoles();
    this._rebuildHandles();
  }

  clearAll() {
    if (!this.tunnels.length) return;
    this._pushUndo();
    this._disposeAll();
    this.rebuildHoles();
    this._rebuildHandles();
  }

  setActiveIndex(i) {
    this.activeIndex = Math.max(-1, Math.min(this.tunnels.length - 1, i | 0));
    this.selected = null;
    this._rebuildHandles();
  }

  /** Set the selected node's floor height. A middle node becomes pinned. */
  setSelectedFloor(y) {
    const sel = this._selectedNode();
    if (!sel || !Number.isFinite(y)) return;
    this._pushUndoCoalesced("floor");
    sel.node.y = y;
    sel.node.pinned = true;
    this._rebuildTunnel(sel.tunnelIdx, { holes: false });
    this._scheduleHoles();
    this._rebuildHandles();
  }

  /** Hand a middle node back to the straight grade. */
  releaseSelectedFloor() {
    const sel = this._selectedNode();
    if (!sel || !sel.node.pinned) return;
    this._pushUndo();
    sel.node.pinned = false;
    this._rebuildTunnel(sel.tunnelIdx, { holes: true });
    this._rebuildHandles();
  }

  /** Width / height / wall thickness of the ACTIVE tunnel. */
  setActiveSection({ width, height, thickness }) {
    const t = this.activeTunnel;
    if (!t) return;
    this._pushUndoCoalesced("section");
    if (Number.isFinite(width)) t.width = width;
    if (Number.isFinite(height)) t.height = height;
    if (Number.isFinite(thickness)) t.thickness = thickness;
    this._rebuildTunnel(this.activeIndex, { holes: false });
    this._scheduleHoles();
  }

  /** Raise or lower every node of the active tunnel. */
  nudgeActiveTunnel(dy) {
    const t = this.activeTunnel;
    if (!t) return;
    this._pushUndo();
    for (const nd of t.nodes) nd.y += dy;
    this._rebuildTunnel(this.activeIndex, { holes: true });
    this._rebuildHandles();
  }

  // ── Build ────────────────────────────────────────────────────────────────

  _rebuildTunnel(i, { holes }) {
    const t = this.tunnels[i];
    if (!t) return;
    if (t.mesh) {
      this.group.remove(t.mesh);
      t.mesh.geometry.dispose();
      t.mesh = null;
    }
    const sampled = sampleTunnel(t);
    if (sampled) {
      const mesh = new THREE.Mesh(buildTunnelGeometry(sampled, t), this.material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = `Tunnel ${i + 1}`;
      this.group.add(mesh);
      mesh.updateMatrixWorld(true);
      t.mesh = mesh;
    }
    t._sampled = sampled;
    this._rebuildLines();
    if (holes) this.rebuildHoles();
    else this.onChanged();
  }

  rebuildAll() {
    for (let i = 0; i < this.tunnels.length; i++) this._rebuildTunnel(i, { holes: false });
    this.rebuildHoles();
    this._rebuildHandles();
  }

  /**
   * Recompute every tunnel's terrain opening into the splat map's TOOL hole
   * source. Needs current heights — after a sculpt, call once the CPU height
   * mirror has caught up.
   */
  rebuildHoles() {
    const res = this.splatRes;
    if (!this.tunnels.some((t) => t._sampled)) {
      if (this._hadHoles) { this.splatMap.setProcHoles(null); this._hadHoles = false; }
      this.onChanged();
      return;
    }
    const buf = new Uint8Array(res * res);
    for (const t of this.tunnels) {
      if (t._sampled) rasterizeTunnelHoles(t._sampled, t, this.heightAt, buf, res, this.worldSize);
    }
    this._holesDueAt = 0;
    this.splatMap.setProcHoles(buf);
    this._hadHoles = true;
    this.onChanged();
  }

  _removeTunnelAt(i) {
    const t = this.tunnels[i];
    if (!t) return;
    if (t.mesh) { this.group.remove(t.mesh); t.mesh.geometry.dispose(); }
    this.tunnels.splice(i, 1);
    this.activeIndex = Math.min(this.activeIndex, this.tunnels.length - 1);
    if (this.activeIndex === i) this.activeIndex = this.tunnels.length - 1;
    this._rebuildLines();
  }

  _disposeAll() {
    for (const t of this.tunnels) {
      if (t.mesh) { this.group.remove(t.mesh); t.mesh.geometry.dispose(); }
    }
    this.tunnels = [];
    this.activeIndex = -1;
    this.selected = null;
    this._rebuildLines();
  }

  // ── Handles / centreline ─────────────────────────────────────────────────

  _handleMat(col) {
    let m = this._handleMats.get(col);
    if (!m) {
      m = new THREE.MeshBasicMaterial({ color: col, depthTest: false, transparent: true, fog: false });
      this._handleMats.set(col, m);
    }
    return m;
  }

  _handleScale(pos) {
    const cam = this.getCamera?.();
    if (!cam) return 1;
    return Math.min(8, Math.max(0.35, cam.position.distanceTo(pos) / 80));
  }

  _rebuildHandles() {
    for (let i = this.handleGroup.children.length - 1; i >= 0; i--) this.handleGroup.remove(this.handleGroup.children[i]);
    for (const line of this._lines) this.handleGroup.add(line);
    if (!this.params.showHandles) return;
    for (let ti = 0; ti < this.tunnels.length; ti++) {
      const t = this.tunnels[ti];
      const ys = resolveNodeHeights(t.nodes);
      const active = ti === this.activeIndex;
      for (let ni = 0; ni < t.nodes.length; ni++) {
        const nd = t.nodes[ni];
        const isSel = this.selected && this.selected.tunnelIdx === ti && this.selected.nodeIdx === ni;
        const isEnd = ni === 0 || ni === t.nodes.length - 1;
        const col = isSel ? COL_SELECTED : (nd.pinned && !isEnd) ? COL_PINNED : active ? COL_ACTIVE : COL_IDLE;
        const m = new THREE.Mesh(this._geoNode, this._handleMat(col));
        m.position.set(nd.x, ys[ni] + FLOOR_LIFT, nd.z);
        m.userData = { kind: "node", tunnelIdx: ti, nodeIdx: ni, active };
        m.renderOrder = 960;
        this.handleGroup.add(m);
      }
    }
    this._scaleHandles();
  }

  _scaleHandles() {
    for (const m of this.handleGroup.children) {
      if (!m.isMesh) continue;
      m.scale.setScalar(this._handleScale(m.position) * (m.userData.active ? 1 : 0.75));
    }
  }

  /** Floor centreline of every tunnel, drawn through the ground. */
  _rebuildLines() {
    for (const l of this._lines) { this.handleGroup.remove(l); l.geometry.dispose(); }
    this._lines = [];
    this.tunnels.forEach((t, ti) => {
      const s = t._sampled;
      if (!s) return;
      const arr = new Float32Array(s.points.length * 3);
      s.points.forEach((p, k) => { arr[k * 3] = p.x; arr[k * 3 + 1] = p.y; arr[k * 3 + 2] = p.z; });
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(arr, 3));
      const line = new THREE.Line(g, ti === this.activeIndex ? this._lineMat : this._lineMatIdle);
      line.renderOrder = 959;
      line.frustumCulled = false;
      this._lines.push(line);
      this.handleGroup.add(line);
    });
  }

  /** Slider drags rebuild the mesh live but recompute holes once they settle. */
  _scheduleHoles(delayMs = 250) {
    this._holesDueAt = performance.now() + delayMs;
  }

  update() {
    if (this.handleGroup.visible) this._scaleHandles();
    if (this._holesDueAt && performance.now() >= this._holesDueAt && !this.dragging) {
      this._holesDueAt = 0;
      this.rebuildHoles();
    }
  }

  // ── Undo ─────────────────────────────────────────────────────────────────

  _snapshot() {
    return JSON.stringify({
      tunnels: this.tunnels.map((t) => ({ nodes: t.nodes, width: t.width, height: t.height, thickness: t.thickness })),
      activeIndex: this.activeIndex,
    });
  }

  _restore(json) {
    const d = JSON.parse(json);
    this._disposeAll();
    this.tunnels = d.tunnels.map((t) => ({ ...t, nodes: t.nodes.map((n) => ({ ...n })) }));
    this.activeIndex = Math.min(d.activeIndex, this.tunnels.length - 1);
    this.selected = null;
    this.rebuildAll();
  }

  _pushUndo(snap = this._snapshot()) {
    this.undoStack.push(snap);
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
    this.redoStack.length = 0;
    this._coalesceKey = null;
  }

  /** One undo step for a whole slider drag, not one per input event. */
  _pushUndoCoalesced(key) {
    const now = performance.now();
    if (this._coalesceKey === key && now - this._coalesceAt < 800) { this._coalesceAt = now; return; }
    this._pushUndo();
    this._coalesceKey = key;
    this._coalesceAt = now;
  }

  undo() {
    if (!this.undoStack.length) return false;
    this.redoStack.push(this._snapshot());
    this._restore(this.undoStack.pop());
    return true;
  }

  redo() {
    if (!this.redoStack.length) return false;
    this.undoStack.push(this._snapshot());
    this._restore(this.redoStack.pop());
    return true;
  }

  // ── Persistence ──────────────────────────────────────────────────────────

  exportData() {
    if (!this.tunnels.length) return null;
    return {
      version: 1,
      wallColor: this.params.wallColor,
      floorColor: this.params.floorColor,
      tunnels: this.tunnels.map((t) => ({
        width: t.width, height: t.height, thickness: t.thickness,
        nodes: t.nodes.map((n) => ({ x: n.x, z: n.z, y: n.y, pinned: !!n.pinned })),
      })),
    };
  }

  /** Replace everything with saved data (null clears). Rebuilds holes too. */
  importData(data) {
    this._disposeAll();
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    const list = Array.isArray(data?.tunnels) ? data.tunnels : [];
    const num = (v, d) => (Number.isFinite(v) ? v : d);
    this.tunnels = list
      .map((t) => ({
        width: num(t.width, TUNNEL_DEFAULTS.width),
        height: num(t.height, TUNNEL_DEFAULTS.height),
        thickness: num(t.thickness, TUNNEL_DEFAULTS.thickness),
        nodes: (t.nodes ?? [])
          .filter((n) => Number.isFinite(n?.x) && Number.isFinite(n?.z) && Number.isFinite(n?.y))
          .map((n) => ({ x: n.x, z: n.z, y: n.y, pinned: n.pinned === true })),
      }))
      .filter((t) => t.nodes.length > 0);
    if (typeof data?.wallColor === "string") this.params.wallColor = data.wallColor;
    if (typeof data?.floorColor === "string") this.params.floorColor = data.floorColor;
    this.syncMaterialColors();
    this.activeIndex = this.tunnels.length - 1;
    this.rebuildAll();
  }
}
