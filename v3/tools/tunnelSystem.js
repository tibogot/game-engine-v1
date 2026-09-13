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
 * STYLES: "tunnel" (clean horseshoe) or "cave" (rough, organic shell). Any
 * tunnel can be closed at either end (a dome — a cave with one entrance), and
 * any node can be sized up into a chamber. An open end can be DUG IN: the mouth
 * drops below the ground and a ramp cutting leads down to it. Lighting (lamps,
 * daylight at the mouths) is baked into the mesh.
 *
 * Undo is a JSON snapshot of the tunnel list; every restore rebuilds meshes and
 * holes from scratch.
 */
import * as THREE from "three";
import { MeshStandardNodeMaterial } from "three/webgpu";
import { attribute, mix, uniform } from "three/tsl";
import {
  TUNNEL_DEFAULTS, CAVE_DEFAULTS, CUT_DEFAULTS, LIGHT_DEFAULTS, MIN_NODE_SCALE, MAX_NODE_SCALE,
  buildTunnelGeometry, computeCuttings, rasterizeTunnelHoles, sampleTunnel, resolveNodeHeights, FLOOR_LIFT,
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
      newStyle: "tunnel",
      newWidth: TUNNEL_DEFAULTS.width,
      newHeight: TUNNEL_DEFAULTS.height,
      newThickness: TUNNEL_DEFAULTS.thickness,
      // Mirrors of the selection, for the panel sliders.
      selFloor: 0,
      selWidth: TUNNEL_DEFAULTS.width,
      selHeight: TUNNEL_DEFAULTS.height,
      selThickness: TUNNEL_DEFAULTS.thickness,
      selStyle: "tunnel",
      selRoughness: CAVE_DEFAULTS.roughness,
      selClosedStart: false,
      selClosedEnd: false,
      selScale: 1,
      // Mirrors of the active tunnel's entrance + lighting settings.
      selDigStart: false,
      selDigEnd: false,
      selCutCover: CUT_DEFAULTS.cover,
      selCutLength: CUT_DEFAULTS.length,
      selCutSlope: CUT_DEFAULTS.slope,
      selLamps: true,
      selLampSpacing: LIGHT_DEFAULTS.lampSpacing,
      selLampIntensity: LIGHT_DEFAULTS.lampIntensity,
      selLampColor: LIGHT_DEFAULTS.lampColor,
      selDaylight: LIGHT_DEFAULTS.daylight,
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
    const albedo = base.mul(attribute("aShade", "float"));
    m.colorNode = albedo;
    // Baked interior light (lamp pools, daylight at the mouths) lights the rock;
    // the lamp fixtures glow on their own.
    m.emissiveNode = albedo.mul(attribute("aEmit", "vec3")).add(attribute("aGlow", "vec3"));
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
    if (t) {
      p.selWidth = t.width; p.selHeight = t.height; p.selThickness = t.thickness;
      p.selStyle = t.style; p.selRoughness = t.roughness;
      p.selClosedStart = t.closedStart; p.selClosedEnd = t.closedEnd;
      p.selDigStart = t.digStart; p.selDigEnd = t.digEnd;
      p.selCutCover = t.cutCover; p.selCutLength = t.cutLength; p.selCutSlope = t.cutSlope;
      p.selLamps = t.lamps; p.selLampSpacing = t.lampSpacing; p.selLampIntensity = t.lampIntensity;
      p.selLampColor = t.lampColor; p.selDaylight = t.daylight;
    }
    const sel = this._selectedNode();
    if (sel) {
      p.selFloor = resolveNodeHeights(sel.tunnel.nodes, sel.tunnel)[sel.nodeIdx];
      p.selScale = sel.node.scale ?? 1;
    }
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
    const t = _parseTunnel({
      nodes: [], width: p.newWidth, height: p.newHeight, thickness: p.newThickness, style: p.newStyle,
      lamps: p.newStyle !== "cave",
    });
    this.tunnels.push(t);
    this.activeIndex = this.tunnels.length - 1;
    return t;
  }

  /** Click on terrain: append a node to the active tunnel (prepend if node 0 is selected). */
  addNode(hit) {
    this._pushUndo();
    const t = this.activeTunnel ?? this._newTunnel();
    const nd = { x: hit.x, z: hit.z, y: hit.y, pinned: false, scale: 1 };
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
    const ys = resolveNodeHeights(t.nodes, t);
    const sc = ((t.nodes[best].scale ?? 1) + (t.nodes[best + 1].scale ?? 1)) * 0.5;
    t.nodes.splice(best + 1, 0, { x: hit.x, z: hit.z, y: (ys[best] + ys[best + 1]) * 0.5, pinned: false, scale: sc });
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
    // An OPEN end is a mouth: its floor follows the ground where it is dropped.
    const openEnd = (nodeIdx === 0 && !tunnel.closedStart) || (nodeIdx === tunnel.nodes.length - 1 && !tunnel.closedEnd);
    if (openEnd) node.pinned = false;
    if (openEnd || !node.pinned) node.y = terrainHit.y;
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

  /** Size of the selected node (1 = the tunnel's section; 3 = a chamber three times as big). */
  setSelectedScale(scale) {
    const sel = this._selectedNode();
    if (!sel || !Number.isFinite(scale)) return;
    this._pushUndoCoalesced("scale");
    sel.node.scale = Math.min(MAX_NODE_SCALE, Math.max(MIN_NODE_SCALE, scale));
    this._rebuildTunnel(sel.tunnelIdx, { holes: false });
    this._rebuildHandles();
    this._scheduleHoles();
  }

  /** Tunnel or cave. Switching to a cave with the tunnel defaults keeps its size. */
  setActiveStyle(style) {
    const t = this.activeTunnel;
    if (!t || (style !== "tunnel" && style !== "cave") || t.style === style) return;
    this._pushUndo();
    t.style = style;
    this._rebuildTunnel(this.activeIndex, { holes: true });
  }

  /** Cave wall roughness, metres of outward push at most. */
  setActiveRoughness(r) {
    const t = this.activeTunnel;
    if (!t || !Number.isFinite(r)) return;
    this._pushUndoCoalesced("rough");
    t.roughness = Math.max(0, r);
    this._rebuildTunnel(this.activeIndex, { holes: false });
    this._scheduleHoles();
  }

  /** Close either end into a dome (a dead end). */
  setActiveClosed({ start, end }) {
    const t = this.activeTunnel;
    if (!t) return;
    this._pushUndo();
    if (typeof start === "boolean") t.closedStart = start;
    if (typeof end === "boolean") t.closedEnd = end;
    this._rebuildTunnel(this.activeIndex, { holes: true });
  }

  /**
   * Entrance and lighting settings of the active tunnel, e.g.
   * { digStart: true } or { lampSpacing: 10 }. Toggles are one undo step each;
   * slider drags coalesce.
   */
  setActiveOptions(patch) {
    const t = this.activeTunnel;
    if (!t) return;
    const keys = Object.keys(patch);
    const toggle = keys.every((k) => typeof patch[k] === "boolean");
    if (toggle) this._pushUndo(); else this._pushUndoCoalesced("opt:" + keys.join(","));
    for (const k of keys) t[k] = patch[k];
    // Digging changes where the floor is, and so the openings.
    const affectsHoles = keys.some((k) => k.startsWith("dig") || k.startsWith("cut"));
    this._rebuildTunnel(this.activeIndex, { holes: false });
    if (affectsHoles) { if (toggle) this.rebuildHoles(); else this._scheduleHoles(); }
    this._rebuildHandles();
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
      t._cuts = computeCuttings(sampled, t, this.heightAt);
      const mesh = new THREE.Mesh(buildTunnelGeometry(sampled, t, { cuts: t._cuts }), this.material);
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
      if (t._sampled) rasterizeTunnelHoles(t._sampled, t, this.heightAt, buf, res, this.worldSize, { cuts: t._cuts ?? [] });
    }
    this._holesDueAt = 0;
    this.splatMap.setProcHoles(buf);
    this._hadHoles = true;
    this.onChanged();
  }

  /**
   * The ground changed (sculpt, erosion, load...). Openings are re-cut; a
   * dug-in entrance's walls follow the ground, so those tunnels rebuild too.
   */
  onTerrainChanged() {
    let any = false;
    for (let i = 0; i < this.tunnels.length; i++) {
      const t = this.tunnels[i];
      if ((t.digStart && !t.closedStart) || (t.digEnd && !t.closedEnd)) { this._rebuildTunnel(i, { holes: false }); any = true; }
    }
    this.rebuildHoles();
    if (any) this._rebuildHandles();
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
      const ys = resolveNodeHeights(t.nodes, t);
      const active = ti === this.activeIndex;
      for (let ni = 0; ni < t.nodes.length; ni++) {
        const nd = t.nodes[ni];
        const isSel = this.selected && this.selected.tunnelIdx === ti && this.selected.nodeIdx === ni;
        const isAnchorEnd = (ni === 0 && !t.closedStart) || (ni === t.nodes.length - 1 && !t.closedEnd);
        const col = isSel ? COL_SELECTED : (nd.pinned && !isAnchorEnd) ? COL_PINNED : active ? COL_ACTIVE : COL_IDLE;
        const m = new THREE.Mesh(this._geoNode, this._handleMat(col));
        m.position.set(nd.x, ys[ni] + FLOOR_LIFT, nd.z);
        m.userData = { kind: "node", tunnelIdx: ti, nodeIdx: ni, active, size: Math.sqrt(nd.scale ?? 1) };
        m.renderOrder = 960;
        this.handleGroup.add(m);
      }
    }
    this._scaleHandles();
  }

  _scaleHandles() {
    for (const m of this.handleGroup.children) {
      if (!m.isMesh) continue;
      m.scale.setScalar(this._handleScale(m.position) * (m.userData.active ? 1 : 0.75) * (m.userData.size ?? 1));
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
      tunnels: this.tunnels.map(_serializeTunnel),
      activeIndex: this.activeIndex,
    });
  }

  _restore(json) {
    const d = JSON.parse(json);
    this._disposeAll();
    this.tunnels = d.tunnels.map(_parseTunnel);
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
      version: 3,
      wallColor: this.params.wallColor,
      floorColor: this.params.floorColor,
      tunnels: this.tunnels.map(_serializeTunnel),
    };
  }

  /** Replace everything with saved data (null clears). Rebuilds holes too. */
  importData(data) {
    this._disposeAll();
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    const list = Array.isArray(data?.tunnels) ? data.tunnels : [];
    this.tunnels = list.map(_parseTunnel).filter((t) => t.nodes.length > 0);
    if (typeof data?.wallColor === "string") this.params.wallColor = data.wallColor;
    if (typeof data?.floorColor === "string") this.params.floorColor = data.floorColor;
    this.syncMaterialColors();
    this.activeIndex = this.tunnels.length - 1;
    this.rebuildAll();
  }
}

// ── Serialisation (undo snapshots and project files share it) ─────────────────

function _serializeTunnel(t) {
  return {
    style: t.style, width: t.width, height: t.height, thickness: t.thickness,
    roughness: t.roughness, closedStart: t.closedStart, closedEnd: t.closedEnd,
    digStart: t.digStart, digEnd: t.digEnd, cutCover: t.cutCover, cutLength: t.cutLength, cutSlope: t.cutSlope,
    lamps: t.lamps, lampSpacing: t.lampSpacing, lampIntensity: t.lampIntensity, lampColor: t.lampColor, daylight: t.daylight,
    nodes: t.nodes.map((n) => ({ x: n.x, z: n.z, y: n.y, pinned: !!n.pinned, scale: n.scale ?? 1 })),
  };
}

/** Tolerant: fills anything missing (older files have no style, sizes or ends). */
function _parseTunnel(t) {
  const num = (v, d) => (Number.isFinite(v) ? v : d);
  const style = t?.style === "cave" ? "cave" : "tunnel";
  return {
    style,
    width: num(t?.width, TUNNEL_DEFAULTS.width),
    height: num(t?.height, TUNNEL_DEFAULTS.height),
    thickness: num(t?.thickness, TUNNEL_DEFAULTS.thickness),
    roughness: Math.max(0, num(t?.roughness, CAVE_DEFAULTS.roughness)),
    closedStart: t?.closedStart === true,
    closedEnd: t?.closedEnd === true,
    digStart: t?.digStart === true,
    digEnd: t?.digEnd === true,
    cutCover: Math.max(0, num(t?.cutCover, CUT_DEFAULTS.cover)),
    cutLength: Math.max(0, num(t?.cutLength, CUT_DEFAULTS.length)),
    cutSlope: Math.max(0, num(t?.cutSlope, CUT_DEFAULTS.slope)),
    // Older files had no lighting: tunnels get lamps, caves do not.
    lamps: typeof t?.lamps === "boolean" ? t.lamps : style !== "cave",
    lampSpacing: Math.max(4, num(t?.lampSpacing, LIGHT_DEFAULTS.lampSpacing)),
    lampIntensity: Math.max(0, num(t?.lampIntensity, LIGHT_DEFAULTS.lampIntensity)),
    lampColor: typeof t?.lampColor === "string" ? t.lampColor : LIGHT_DEFAULTS.lampColor,
    daylight: Math.max(0, num(t?.daylight, LIGHT_DEFAULTS.daylight)),
    nodes: (t?.nodes ?? [])
      .filter((n) => Number.isFinite(n?.x) && Number.isFinite(n?.z) && Number.isFinite(n?.y))
      .map((n) => ({
        x: n.x, z: n.z, y: n.y, pinned: n.pinned === true,
        scale: Math.min(MAX_NODE_SCALE, Math.max(MIN_NODE_SCALE, num(n.scale, 1))),
      })),
  };
}
