import * as THREE from "three";
import { generateRoadGeometry } from "../../core/road/roadMesh.js";
import { buildLabNetworkGeometry } from "../../core/road/roadNetworkLabGeometry.js";
import { buildChunkedKerbGroup } from "../../core/road/kerbChunkGeometry.js";
import {
  createRoadUniforms,
  createRoadMaterial,
  syncRoadUniforms,
  createLabLineMarkingMaterials,
} from "../../core/road/roadMaterial.js";
import { createDecalMaterial } from "./roadDecalMaterial.js";

const DIFFUSE_TEX_PATH = "../textures/pbr_materials/asphalt_track/asphalt_track_diff_2k.jpg";
const ARM_TEX_PATH = "../textures/pbr_materials/asphalt_track/asphalt_track_arm_2k.jpg";
const NORMAL_TEX_PATH = "../textures/pbr_materials/asphalt_track/asphalt_track_nor_gl_2k.jpg";

const STYLE_KEYS = [
  "lineColor", "lineWidth", "lineSoftness", "lineInset",
  "edgeBlendWidth", "edgeBlendNoise",
  "centerLine", "centerLineColor", "centerLineWidth", "centerLineSoftness",
  "centerLineDashed", "centerLineDashScale",
  "doubleCenterLine", "centerLineGap",
  "centerLeftEnabled", "centerLeftColor", "centerLeftDashed",
  "centerRightEnabled", "centerRightColor", "centerRightDashed",
  "laneLines", "laneLineWidth", "laneDashScale",
  "colorTint", "colorBrightness",
  "asphaltDark", "asphaltLight", "grainScale", "grainStrength",
  "enhanced", "normalStrength", "roughnessBase", "reflectStrength",
  "mixBlur", "mixStrength", "mixContrast", "normalDistort",
  "dirtAmount", "dirtScale", "dirtContrast", "dirtTint", "edgeDirtBoost",
  "wearAmount", "wearScale", "wearContrast", "wearDarken",
  "scratchAmount", "scratchScale", "scratchThinness",
  "lineScratchAmount", "lineScratchScale", "lineScratchStretch",
  "lineScratchThreshold", "lineScratchSoftness", "lineScratchWarp",
  "lineScratchDetail", "lineScratchEdge",
  "roughnessDirtBoost", "roughnessWearReduce",
  "wetAmount", "wetCoverage", "puddleAmount", "puddleScale", "puddleContrast", "puddleEdgeBoost",
  "wetDarkening", "wetRoughnessMin", "puddleReflectStrength", "puddleSkySuppress", "puddleTint",
  "lodNear", "lodMid", "lodFar", "texScale",
];

function extractStyle(params) {
  const style = {};
  for (const key of STYLE_KEYS) style[key] = params[key];
  return style;
}

const EDGE_MARKING_STYLE_KEYS = new Set([
  "centerLine",
  "centerLineDashed",
  "laneLines",
  "doubleCenterLine",
  "centerLineGap",
  "centerLineWidth",
  "centerLeftEnabled",
  "centerRightEnabled",
  "centerLeftDashed",
  "centerRightDashed",
]);
const EDGE_MARKING_STYLE_BOOL = new Set([
  "centerLine",
  "centerLineDashed",
  "laneLines",
  "doubleCenterLine",
  "centerLeftEnabled",
  "centerRightEnabled",
  "centerLeftDashed",
  "centerRightDashed",
]);

function normalizeImportedEdgeStyle(raw) {
  if (!raw || typeof raw !== "object") return undefined;
  const st = {};
  for (const k of EDGE_MARKING_STYLE_KEYS) {
    if (raw[k] === undefined) continue;
    if (EDGE_MARKING_STYLE_BOOL.has(k)) st[k] = !!raw[k];
    else {
      const n = Number(raw[k]);
      if (Number.isFinite(n)) st[k] = n;
    }
  }
  return Object.keys(st).length ? st : undefined;
}

function cloneVec3Like(p) {
  return new THREE.Vector3(p.x, p.y, p.z);
}

function distSqXZ(a, b) {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return dx * dx + dz * dz;
}

function pointSegDistanceSqXZ(p, a, b) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const lenSq = dx * dx + dz * dz;
  let t = 0;
  if (lenSq > 1e-8) {
    t = ((p.x - a.x) * dx + (p.z - a.z) * dz) / lenSq;
    t = Math.max(0, Math.min(1, t));
  }
  const x = a.x + dx * t;
  const z = a.z + dz * t;
  const ex = p.x - x;
  const ez = p.z - z;
  return { dSq: ex * ex + ez * ez, t, x, z };
}

function normalizeXZ(v) {
  const len = Math.hypot(v.x, v.z);
  if (len < 1e-6) return new THREE.Vector3(1, 0, 0);
  return new THREE.Vector3(v.x / len, 0, v.z / len);
}

function perpXZ(dir) {
  return new THREE.Vector3(-dir.z, 0, dir.x);
}

function angleXZ(v) {
  return Math.atan2(v.z, v.x);
}

function makeRoadParams(params, style, markingsEnabled) {
  const merged = { ...params, ...style };
  if (!markingsEnabled) {
    merged.lineWidth = 0;
    merged.centerLine = false;
    merged.laneLines = false;
    merged.edgeBlendWidth = 0;
  }
  return merged;
}

export class FullRoadSystem {
  constructor({
    scene,
    toolState,
    getWorldHeight,
    reflectTex,
    terrainStore,
    chunkStream,
    useLabNetworkGeometry = false,
    graphMode = "fullRoad",
  }) {
    this.scene = scene;
    this.toolState = toolState;
    this.getWorldHeight = getWorldHeight;
    this._reflectTex = reflectTex ?? null;
    this.terrainStore = terrainStore ?? null;
    this.chunkStream = chunkStream ?? null;
    this.transformControls = null;
    /** When true, use `profile-road-lab0`-style piecewise network meshing (Smart Road). */
    this._useLabNetworkGeometry = useLabNetworkGeometry;
    /** Which editor mode shows handles for this system instance (`fullRoad` | `smartRoad`). */
    this._graphMode = graphMode;

    this.nodes = [];
    this.edges = [];
    this.selectedNodeId = null;
    /** Selected graph edge id (Smart Road segment overrides); null if none. */
    this.selectedEdgeId = null;
    this.dragging = false;
    this._nextNodeId = 1;
    this._nextEdgeId = 1;

    // Road accessories: { id, pathIdx, side, startT, endT }
    this.guardrails = [];
    this.kerbs = [];
    this.barriers = [];
    this.fences = [];
    this.tunnels = [];
    this._nextAccessoryId = 1;
    this._paintingAccessory = null; // Active painting state

    // Road decals: { id, type, x, z, rotation, width, length, params }
    this.decals = [];
    this._nextDecalId = 1;
    this._decalPreview = null;
    this.selectedDecalId = null;
    this._selectedDecalMesh = null;
    this._decalProxy = new THREE.Object3D();
    this._decalProxy.name = "FullRoadDecalProxy";
    scene.add(this._decalProxy); // Must be in scene graph for TransformControls

    this.meshGroup = new THREE.Group();
    this.meshGroup.name = "FullRoadMeshes";
    this.decalGroup = new THREE.Group();
    this.decalGroup.name = "FullRoadDecals";
    scene.add(this.meshGroup);
    this.accessoryGroup = new THREE.Group();
    this.accessoryGroup.name = "FullRoadAccessories";
    scene.add(this.accessoryGroup);
    scene.add(this.decalGroup);
    this.handleGroup = new THREE.Group();
    this.handleGroup.name = "FullRoadHandles";
    scene.add(this.handleGroup);
    this.handleMeshes = [];

    this._diffuseTex = null;
    this._armTex = null;
    this._normalTex = null;
    this._roadUniforms = null;
    this._roadMat = null;
    this._junctionUniforms = null;
    this._junctionMat = null;
    /** Smart Road lab mesh PBR (no reflection texture). */
    this._labPbrRoadMat = null;
    this._labPbrJuncMat = null;
    this._labPbrRoadUniforms = null;
    this._labPbrJuncUniforms = null;
    /** Last lab surface material bake: textures on vs procedural-only (must rebuild graph when this flips). */
    this._labShaderTexActive = null;
    this._lineMat = new THREE.LineBasicMaterial({ color: 0x62c4ff, transparent: true, opacity: 0.7 });
    this._junctionLineMat = new THREE.MeshBasicMaterial({
      color: 0xf2f2f2,
      side: THREE.DoubleSide,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -12,
      polygonOffsetUnits: -12,
    });
    this._junctionCenterLineMat = new THREE.MeshBasicMaterial({
      color: 0xf0c040,
      side: THREE.DoubleSide,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -13,
      polygonOffsetUnits: -13,
    });
    this._loadTextures();

    this.undoStack = [];
    this.redoStack = [];
  }

  _loadTextures() {
    const loader = new THREE.TextureLoader();
    let done = 0;
    const total = 3;
    const onDone = () => {
      done++;
      if (done >= total) {
        this._rebuildMaterials();
        this._rebuildVisual();
      }
    };
    loader.load(DIFFUSE_TEX_PATH, (tex) => {
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      this._diffuseTex = tex;
      onDone();
    }, undefined, onDone);
    loader.load(ARM_TEX_PATH, (tex) => {
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      this._armTex = tex;
      onDone();
    }, undefined, onDone);
    loader.load(NORMAL_TEX_PATH, (tex) => {
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      this._normalTex = tex;
      onDone();
    }, undefined, onDone);
  }

  _rebuildMaterials() {
    if (this._roadMat) this._roadMat.dispose();
    if (this._junctionMat) this._junctionMat.dispose();
    const p = this.toolState.fullRoad;
    const style = extractStyle(p);
    this._roadUniforms = createRoadUniforms(makeRoadParams(p, style, true));
    this._roadMat = createRoadMaterial(this._roadUniforms, this._diffuseTex, this._armTex, this._normalTex, this._reflectTex);
    this._junctionUniforms = createRoadUniforms(makeRoadParams(p, style, false));
    this._junctionMat = createRoadMaterial(this._junctionUniforms, this._diffuseTex, this._armTex, this._normalTex, this._reflectTex);
  }

  syncMaterial() {
    if (!this._roadMat || !this._junctionMat) this._rebuildMaterials();
    const p = this.toolState.fullRoad;
    const style = extractStyle(p);
    syncRoadUniforms(this._roadUniforms, makeRoadParams(p, style, true));
    syncRoadUniforms(this._junctionUniforms, makeRoadParams(p, style, false));
    this._junctionLineMat.color.set(p.lineColor ?? "#f2f2f2");
    this._junctionCenterLineMat.color.set(p.centerLineColor ?? "#f0c040");
    this._roadMat.needsUpdate = true;
    this._junctionMat.needsUpdate = true;
    if (this._useLabNetworkGeometry && this._labPbrRoadUniforms && this._labPbrJuncUniforms) {
      const base = makeRoadParams(p, style, false);
      Object.assign(base, { enhanced: false, reflectStrength: 0 });
      syncRoadUniforms(this._labPbrRoadUniforms, base);
      syncRoadUniforms(this._labPbrJuncUniforms, {
        ...base,
        colorBrightness: (p.colorBrightness ?? 0.62) * 0.94,
      });
      this._labPbrRoadMat.needsUpdate = true;
      this._labPbrJuncMat.needsUpdate = true;
    }
  }

  _pushUndo() {
    this.undoStack.push(this._snapshot());
    this.redoStack.length = 0;
    if (this.undoStack.length > 50) this.undoStack.shift();
  }

  _snapshot() {
    return {
      nodes: this.nodes.map(n => ({ id: n.id, x: n.position.x, y: n.position.y, z: n.position.z, forceJunction: !!n.forceJunction })),
      edges: this.edges.map(e => {
        const row = { id: e.id, a: e.a, b: e.b };
        if (e.style && Object.keys(e.style).length) row.style = { ...e.style };
        return row;
      }),
      selectedNodeId: this.selectedNodeId,
      selectedEdgeId: this.selectedEdgeId,
      nextNodeId: this._nextNodeId,
      nextEdgeId: this._nextEdgeId,
    };
  }

  _restore(snap) {
    this.nodes = snap.nodes.map(n => ({
      id: n.id,
      position: new THREE.Vector3(n.x, n.y, n.z),
      forceJunction: !!n.forceJunction,
    }));
    this.edges = snap.edges.map(e => {
      const edge = { id: e.id, a: e.a, b: e.b };
      if (e.style && Object.keys(e.style).length) edge.style = { ...e.style };
      return edge;
    });
    this.selectedNodeId = snap.selectedNodeId ?? null;
    const se = snap.selectedEdgeId ?? null;
    this.selectedEdgeId =
      se != null && this.edges.some((e) => e.id === se) ? se : null;
    this._nextNodeId = snap.nextNodeId ?? (Math.max(0, ...this.nodes.map(n => n.id)) + 1);
    this._nextEdgeId = snap.nextEdgeId ?? (Math.max(0, ...this.edges.map(e => e.id)) + 1);
    this._rebuildVisual();
    this._updateSelectedY();
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

  _nodeById(id) {
    return this.nodes.find(n => n.id === id) ?? null;
  }

  _degreeMap() {
    const degree = new Map(this.nodes.map(n => [n.id, 0]));
    for (const edge of this.edges) {
      degree.set(edge.a, (degree.get(edge.a) ?? 0) + 1);
      degree.set(edge.b, (degree.get(edge.b) ?? 0) + 1);
    }
    return degree;
  }

  _adjacencyMap() {
    const adj = new Map(this.nodes.map(n => [n.id, []]));
    for (const edge of this.edges) {
      adj.get(edge.a)?.push({ edge, otherId: edge.b });
      adj.get(edge.b)?.push({ edge, otherId: edge.a });
    }
    return adj;
  }

  _isJunctionNode(nodeId, degree = null) {
    const node = this._nodeById(nodeId);
    if (!node) return false;
    const deg = degree?.get(nodeId) ?? this.edges.filter(e => e.a === nodeId || e.b === nodeId).length;
    return node.forceJunction || deg >= 3;
  }

  _buildRoadPaths(degree = this._degreeMap()) {
    const adj = this._adjacencyMap();
    const visitedEdges = new Set();
    const paths = [];
    
    // At junctions, find "through" pairs (most opposite edges) so we can continue through them
    const throughPairs = new Map(); // nodeId -> Map<edgeId, oppositeEdgeId>
    for (const node of this.nodes) {
      if (!this._isJunctionNode(node.id, degree)) continue;
      const links = adj.get(node.id) ?? [];
      if (links.length < 2) continue;
      
      // Find the most opposite pair
      let bestPair = null;
      let bestDot = 0;
      for (let i = 0; i < links.length; i++) {
        for (let j = i + 1; j < links.length; j++) {
          const otherA = this._nodeById(links[i].otherId);
          const otherB = this._nodeById(links[j].otherId);
          if (!otherA || !otherB) continue;
          const dirA = normalizeXZ(otherA.position.clone().sub(node.position));
          const dirB = normalizeXZ(otherB.position.clone().sub(node.position));
          const dot = dirA.dot(dirB);
          if (dot < bestDot) {
            bestDot = dot;
            bestPair = [links[i].edge.id, links[j].edge.id];
          }
        }
      }
      if (bestPair && bestDot < -0.5) {
        const pairMap = new Map();
        pairMap.set(bestPair[0], bestPair[1]);
        pairMap.set(bestPair[1], bestPair[0]);
        throughPairs.set(node.id, pairMap);
      }
    }
    
    const isTerminal = (nodeId) => {
      const deg = degree.get(nodeId) ?? 0;
      if (deg === 1) return true; // Dead end
      if (deg === 2 && !this._nodeById(nodeId)?.forceJunction) return false; // Continue through
      return true; // Junction or forced junction
    };
    
    const canContinueThrough = (nodeId, fromEdgeId) => {
      const pairMap = throughPairs.get(nodeId);
      if (!pairMap) return null;
      const oppositeEdgeId = pairMap.get(fromEdgeId);
      if (oppositeEdgeId && !visitedEdges.has(oppositeEdgeId)) {
        return this.edges.find(e => e.id === oppositeEdgeId) ?? null;
      }
      return null;
    };

    const walk = (startId, firstLink, closed = false) => {
      const nodeIds = [startId];
      const edgeIds = [];
      let prevId = startId;
      let link = firstLink;
      let guard = 0;
      while (link && guard++ < this.edges.length + 2) {
        visitedEdges.add(link.edge.id);
        edgeIds.push(link.edge.id);
        const nextId = link.otherId;
        nodeIds.push(nextId);
        if (closed && nextId === startId) break;
        
        // Check if we can continue through a junction
        const throughEdge = canContinueThrough(nextId, link.edge.id);
        if (throughEdge) {
          link = { edge: throughEdge, otherId: throughEdge.a === nextId ? throughEdge.b : throughEdge.a };
          prevId = nextId;
          continue;
        }
        
        if (!closed && isTerminal(nextId)) break;
        
        const links = adj.get(nextId) ?? [];
        link = links.find(l => l.otherId !== prevId && !visitedEdges.has(l.edge.id));
        prevId = nextId;
      }
      if (nodeIds.length >= 2) paths.push({ nodeIds, edgeIds, closed });
    };

    // Start from terminals and dead ends
    for (const node of this.nodes) {
      const deg = degree.get(node.id) ?? 0;
      if (deg !== 1 && deg !== 0) continue; // Only start from dead ends
      for (const link of adj.get(node.id) ?? []) {
        if (!visitedEdges.has(link.edge.id)) walk(node.id, link, false);
      }
    }
    
    // Start from junctions for branches that weren't part of through-roads
    for (const node of this.nodes) {
      if (!this._isJunctionNode(node.id, degree)) continue;
      for (const link of adj.get(node.id) ?? []) {
        if (!visitedEdges.has(link.edge.id)) walk(node.id, link, false);
      }
    }

    // Handle closed loops
    for (const edge of this.edges) {
      if (visitedEdges.has(edge.id)) continue;
      walk(edge.a, { edge, otherId: edge.b }, true);
    }

    return paths;
  }

  _createNode(pos) {
    const node = {
      id: this._nextNodeId++,
      position: pos.clone(),
      forceJunction: false,
    };
    this.nodes.push(node);
    return node;
  }

  _createEdge(a, b, inheritedStyle) {
    if (a === b || this._edgeBetween(a, b)) return null;
    const edge = { id: this._nextEdgeId++, a, b };
    if (inheritedStyle && Object.keys(inheritedStyle).length) edge.style = { ...inheritedStyle };
    this.edges.push(edge);
    return edge;
  }

  _edgeBetween(a, b) {
    return this.edges.find(e => (e.a === a && e.b === b) || (e.a === b && e.b === a)) ?? null;
  }

  _findNearestNode(pos, radius) {
    const maxSq = radius * radius;
    let best = null;
    let bestSq = maxSq;
    for (const node of this.nodes) {
      const dSq = distSqXZ(pos, node.position);
      if (dSq <= bestSq) {
        best = node;
        bestSq = dSq;
      }
    }
    return best;
  }

  _findNearestEdge(pos, radius) {
    const maxSq = radius * radius;
    let best = null;
    let bestSq = maxSq;
    for (const edge of this.edges) {
      const hit = this._nearestPointOnEdgeCurve(pos, edge, 32);
      if (hit.dSq < bestSq && hit.t > 0.06 && hit.t < 0.94) {
        bestSq = hit.dSq;
        best = { edge, hit };
      }
    }
    return best;
  }

  /** Alt+click terrain — selects nearest edge for per-segment marking overrides (Smart Road lab mesh). */
  trySelectEdgeAt(worldPos, radius) {
    const hit = this._findNearestEdge(worldPos, radius);
    if (!hit) return false;
    this.selectedEdgeId = hit.edge.id;
    this.selectedNodeId = null;
    this._rebuildHandles();
    this._updateSelectedY();
    return true;
  }

  clearSelectedEdge() {
    if (this.selectedEdgeId == null) return;
    this.selectedEdgeId = null;
    this._rebuildHandles();
  }

  _selectedEdge() {
    if (this.selectedEdgeId == null) return null;
    return this.edges.find((e) => e.id === this.selectedEdgeId) ?? null;
  }

  /**
   * Merge marking overrides onto the selected edge. Pass `null` for a key to remove that override (inherit global).
   * Only keys in `EDGE_MARKING_STYLE_KEYS` are kept.
   */
  mergeSelectedEdgeStyle(patch) {
    const edge = this._selectedEdge();
    if (!edge || !patch || typeof patch !== "object") return;
    this._pushUndo();
    if (!edge.style) edge.style = {};
    for (const [k, v] of Object.entries(patch)) {
      if (!EDGE_MARKING_STYLE_KEYS.has(k)) continue;
      if (v === null || v === undefined) delete edge.style[k];
      else if (EDGE_MARKING_STYLE_BOOL.has(k)) edge.style[k] = !!v;
      else {
        const n = Number(v);
        if (Number.isFinite(n)) edge.style[k] = n;
      }
    }
    if (Object.keys(edge.style).length === 0) delete edge.style;
    this._rebuildVisual();
    this._updateSelectedY();
  }

  clearSelectedEdgeStyle() {
    const edge = this._selectedEdge();
    if (!edge?.style) return;
    this._pushUndo();
    delete edge.style;
    this._rebuildVisual();
    this._updateSelectedY();
  }

  _splitEdge(edge, pos) {
    const idx = this.edges.indexOf(edge);
    if (idx < 0) return null;
    const a = this._nodeById(edge.a);
    const b = this._nodeById(edge.b);
    if (!a || !b) return null;
    const hit = this._nearestPointOnEdgeCurve(pos, edge, 48);
    const y = hit.y;
    const node = this._createNode(new THREE.Vector3(hit.x, y, hit.z));
    node.forceJunction = true;
    const inherited = edge.style ? { ...edge.style } : null;
    this.edges.splice(idx, 1);
    if (this.selectedEdgeId === edge.id) this.selectedEdgeId = null;
    this._createEdge(a.id, node.id, inherited);
    this._createEdge(node.id, b.id, inherited);
    return node;
  }

  _resolveAnchor(pos) {
    const p = this.toolState.fullRoad;
    const snapNode = this._findNearestNode(pos, Math.max(0.1, p.nodeSnapRadius));
    if (snapNode) return snapNode;
    
    // Use path curve (CatmullRom) for snapping, not edge curve (bezier)
    // This ensures the split point lies exactly on the rendered road
    const pathHit = this._findNearestPathPoint(pos, Math.max(0.1, p.branchSnapRadius));
    if (pathHit) {
      return this._splitEdgeAtPosition(pathHit.edge, pathHit);
    }
    
    return this._createNode(pos);
  }
  
  _splitEdgeAtPosition(edge, hit) {
    const idx = this.edges.indexOf(edge);
    if (idx < 0) return null;
    const a = this._nodeById(edge.a);
    const b = this._nodeById(edge.b);
    if (!a || !b) return null;
    
    // Use the exact position from the path curve hit
    const node = this._createNode(new THREE.Vector3(hit.x, hit.y, hit.z));
    node.forceJunction = true;
    const inherited = edge.style ? { ...edge.style } : null;
    this.edges.splice(idx, 1);
    if (this.selectedEdgeId === edge.id) this.selectedEdgeId = null;
    this._createEdge(a.id, node.id, inherited);
    this._createEdge(node.id, b.id, inherited);
    return node;
  }

  _edgeCurveInfo(edge) {
    const a = this._nodeById(edge.a);
    const b = this._nodeById(edge.b);
    if (!a || !b) return null;
    const adj = this._adjacencyMap();
    const degree = this._degreeMap();
    const len = Math.max(1e-6, a.position.distanceTo(b.position));

    const prev = this._smoothNeighbor(a.id, b.id, adj, degree);
    const next = this._smoothNeighbor(b.id, a.id, adj, degree);
    const dirA = prev
      ? normalizeXZ(b.position.clone().sub(prev.position))
      : normalizeXZ(b.position.clone().sub(a.position));
    const dirB = next
      ? normalizeXZ(next.position.clone().sub(a.position))
      : normalizeXZ(b.position.clone().sub(a.position));
    const handle = Math.min(len * 0.38, Math.max(2, this.toolState.fullRoad.width * 0.8));
    const c1 = a.position.clone().add(dirA.clone().multiplyScalar(handle));
    const c2 = b.position.clone().sub(dirB.clone().multiplyScalar(handle));
    const curve = new THREE.CubicBezierCurve3(a.position, c1, c2, b.position);
    return { curve, a, b, dirA, dirB };
  }

  _smoothNeighbor(nodeId, excludeId, adj, degree) {
    if (this._isJunctionNode(nodeId, degree)) return null;
    const links = adj.get(nodeId) ?? [];
    if (links.length !== 2) return null;
    const link = links.find(l => l.otherId !== excludeId);
    return link ? this._nodeById(link.otherId) : null;
  }

  _nearestPointOnEdgeCurve(pos, edge, samples) {
    const info = this._edgeCurveInfo(edge);
    if (!info) return { dSq: Infinity, t: 0, x: pos.x, y: pos.y, z: pos.z };
    const pts = info.curve.getSpacedPoints(samples);
    let best = { dSq: Infinity, t: 0, x: pts[0].x, y: pts[0].y, z: pts[0].z };
    for (let i = 0; i < pts.length - 1; i++) {
      const hit = pointSegDistanceSqXZ(pos, pts[i], pts[i + 1]);
      if (hit.dSq >= best.dSq) continue;
      const globalT = (i + hit.t) / Math.max(1, pts.length - 1);
      const y = pts[i].y * (1 - hit.t) + pts[i + 1].y * hit.t;
      best = { ...hit, t: globalT, y };
    }
    return best;
  }
  
  // Find nearest point on any PATH curve (CatmullRom), not edge curve (bezier)
  // This ensures split points lie exactly on the rendered road
  _findNearestPathPoint(pos, radius) {
    const maxSq = radius * radius;
    const paths = this._buildRoadPaths();
    let best = null;
    
    for (const path of paths) {
      const curve = this._curveForPath(path);
      if (!curve) continue;
      
      const pts = curve.getSpacedPoints(Math.max(32, path.nodeIds.length * 16));
      for (let i = 0; i < pts.length - 1; i++) {
        const hit = pointSegDistanceSqXZ(pos, pts[i], pts[i + 1]);
        if (hit.dSq >= maxSq || (best && hit.dSq >= best.dSq)) continue;
        
        const globalT = (i + hit.t) / Math.max(1, pts.length - 1);
        // Don't allow splits too close to path endpoints
        if (globalT < 0.05 || globalT > 0.95) continue;
        
        const y = pts[i].y * (1 - hit.t) + pts[i + 1].y * hit.t;
        
        // Find which edge in the path this t value corresponds to
        const edgeCount = path.edgeIds.length;
        const edgeIndex = Math.min(edgeCount - 1, Math.floor(globalT * edgeCount));
        const edgeId = path.edgeIds[edgeIndex];
        const edge = this.edges.find(e => e.id === edgeId);
        
        // Check t is not too close to nodes within the edge
        const localT = (globalT * edgeCount) - edgeIndex;
        if (localT < 0.06 || localT > 0.94) continue;
        
        if (edge) {
          best = {
            dSq: hit.dSq,
            x: hit.x,
            y,
            z: hit.z,
            edge,
            path,
            globalT,
          };
        }
      }
    }
    return best;
  }

  addOrConnect(pos) {
    this._pushUndo();
    if (!this.nodes.length) {
      const first = this._createNode(pos);
      this.selectedNodeId = first.id;
      this._rebuildVisual();
      this._updateSelectedY();
      return;
    }
    const anchor = this._resolveAnchor(pos);
    if (!anchor) return;
    if (this.selectedNodeId != null && this.selectedNodeId !== anchor.id) {
      this._createEdge(this.selectedNodeId, anchor.id);
    }
    this.selectedNodeId = anchor.id;
    this._rebuildVisual();
    this._updateSelectedY();
  }

  startBranch() {
    this.selectedNodeId = null;
    this.selectedEdgeId = null;
    this._rebuildHandles();
    this._updateSelectedY();
  }

  toggleSelectedJunction() {
    const node = this._nodeById(this.selectedNodeId);
    if (!node) return;
    this._pushUndo();
    node.forceJunction = !node.forceJunction;
    this._rebuildVisual();
  }

  pickNode(raycaster) {
    const hits = raycaster.intersectObjects(this.handleMeshes, false);
    if (hits.length === 0) return null;
    return hits[0].object.userData.nodeId ?? null;
  }

  moveSelected(pos) {
    const node = this._nodeById(this.selectedNodeId);
    if (!node) return;
    const y = node.position.y;
    node.position.copy(pos);
    node.position.y = y;
    this._rebuildVisual();
  }

  setSelectedPointY(y) {
    const node = this._nodeById(this.selectedNodeId);
    if (!node) return;
    node.position.y = y;
    this._rebuildVisual();
    this._updateSelectedY();
  }

  snapSelectedYToTerrain() {
    const node = this._nodeById(this.selectedNodeId);
    if (!node) return;
    this._pushUndo();
    node.position.y = this.getWorldHeight(node.position.x, node.position.z);
    this._rebuildVisual();
    this._updateSelectedY();
  }

  deleteSelected() {
    if (this.selectedNodeId == null) return;
    this._pushUndo();
    this.edges = this.edges.filter(e => e.a !== this.selectedNodeId && e.b !== this.selectedNodeId);
    this.nodes = this.nodes.filter(n => n.id !== this.selectedNodeId);
    this.selectedNodeId = this.nodes.at(-1)?.id ?? null;
    if (!this.edges.some((e) => e.id === this.selectedEdgeId)) this.selectedEdgeId = null;
    this._rebuildVisual();
    this._updateSelectedY();
  }

  clearAll() {
    if (!this.nodes.length && !this.edges.length) return;
    this._pushUndo();
    this.nodes = [];
    this.edges = [];
    this.selectedNodeId = null;
    this.selectedEdgeId = null;
    this._rebuildVisual();
  }

  /** Merged Full Road mesh + terrain flatten: segment count scales with curve length, capped by `fullRoad.segments`. */
  _effectiveMeshSegments(curve) {
    const p = this.toolState.fullRoad;
    const len = Math.max(1e-6, curve.getLength());
    const perM = p.meshSegmentsPerMeter ?? 1.0;
    const cap = Math.max(6, Math.min(2000, Math.max(6, p.segments | 0)));
    const raw = Math.round(len * perM);
    return Math.max(6, Math.min(cap, Math.max(6, raw)));
  }

  flattenTerrainUnderRoads() {
    if (!this.terrainStore || !this.chunkStream) return;
    const p = this.toolState.fullRoad;
    const dirtyChunks = new Map();
    for (const path of this._buildRoadPaths()) {
      const curve = this._curveForPath(path);
      if (!curve) continue;
      const segs = this._effectiveMeshSegments(curve);
      this.terrainStore.flattenUnderRoad(curve, p.width, segs, p.heightOffset, dirtyChunks);
    }
    if (dirtyChunks.size > 0) this.chunkStream.markDirtyRects(dirtyChunks);
  }

  _curveForEdge(edge) {
    return this._edgeCurveInfo(edge)?.curve ?? null;
  }

  _curveForPath(path) {
    const pts = path.nodeIds
      .map(id => this._nodeById(id)?.position)
      .filter(Boolean);
    if (pts.length < 2) return null;
    return new THREE.CatmullRomCurve3(pts, !!path.closed, "catmullrom", 0.5);
  }

  rebuildAllMeshes() {
    this._clearGroup(this.meshGroup);
    if (!this._roadMat) this._rebuildMaterials();
    if (this._useLabNetworkGeometry) {
      this._rebuildLabNetworkMeshes();
      return;
    }
    const p = this.toolState.fullRoad;
    const degree = this._degreeMap();

    // Collect all road geometries and merge into ONE mesh
    // This completely eliminates z-fighting since it's one unified surface
    
    const roadPaths = this._buildRoadPaths(degree);
    const geometries = [];
    
    for (const path of roadPaths) {
      const curve = this._curveForPath(path);
      if (!curve) continue;

      const geo = generateRoadGeometry(
        curve,
        p.width,
        this._effectiveMeshSegments(curve),
        p.heightOffset,
        this.getWorldHeight,
        null,
        {
          adaptiveLift: p.adaptiveLift,
          slopeLift: p.slopeLift,
          liftMax: p.liftMax,
          startT: 0,
          endT: 1,
          arcOffset: 0,
        },
      );
      geometries.push(geo);
    }
    
    if (geometries.length === 0) return;
    
    // Merge all geometries into one
    const mergedGeo = this._mergeGeometries(geometries);
    if (!mergedGeo) return;
    
    // Mark vertices near junction nodes with aJunction = 1.0 to hide lines
    this._markJunctionVertices(mergedGeo, degree, p.width);
    
    const mesh = new THREE.Mesh(mergedGeo, this._roadMat);
    mesh.name = "FullRoadMerged";
    mesh.receiveShadow = true;
    mesh.renderOrder = 3;
    this.meshGroup.add(mesh);
    
    // Dispose individual geometries
    for (const geo of geometries) geo.dispose();
  }

  _sampleSlope01Lab(x, z, eps) {
    const hL = this.getWorldHeight(x - eps, z);
    const hR = this.getWorldHeight(x + eps, z);
    const hD = this.getWorldHeight(x, z - eps);
    const hU = this.getWorldHeight(x, z + eps);
    const nx = hL - hR;
    const ny = 2 * eps;
    const nz = hD - hU;
    const invLen = 1 / Math.max(1e-6, Math.hypot(nx, ny, nz));
    const normalY = ny * invLen;
    return Math.max(0, Math.min(1, 1 - normalY));
  }

  _roadSurfaceYLab(x, z, p) {
    const h = this.getWorldHeight(x, z);
    const slopeEps = Math.max(0.35, Math.min(2.5, p.width * 0.1));
    if (!p.adaptiveLift) return h + p.heightOffset;
    const slope01 = this._sampleSlope01Lab(x, z, slopeEps);
    const extra = Math.min(p.liftMax, slope01 * p.slopeLift);
    return h + p.heightOffset + extra;
  }

  _rebuildLabNetworkMeshes() {
    const p = this.toolState.fullRoad;
    if (!this.nodes.length || !this.edges.length) return;

    const nodes2 = this.nodes.map((n) => ({
      id: n.id,
      x: n.position.x,
      z: n.position.z,
      forceJunction: !!n.forceJunction,
    }));
    const edges2 = this.edges.map((e) => ({
      id: e.id,
      a: e.a,
      b: e.b,
      style: e.style,
    }));

    const { pieces, markings } = buildLabNetworkGeometry(nodes2, edges2, {
      width: p.width,
      lanesPerDir: p.lanesPerDir ?? 1,
      junctionRadius: p.junctionRadius,
      curveSegments: Math.max(8, Math.min(96, p.segments | 0 || 34)),
      junctionSegments: Math.max(3, p.junctionSegments | 0 || 14),
      twoRoadNodes: p.twoRoadNodes ?? "smooth",
      endCapStyle: p.endCapStyle ?? "flat",
      centerLine: p.centerLine !== false,
      laneLines: !!p.laneLines,
      doubleCenterLine: !!p.doubleCenterLine,
      centerLineGap: p.centerLineGap ?? 0.012,
      centerLineWidth: p.centerLineWidth ?? 0.02,
      centerLeftEnabled: p.centerLeftEnabled !== false,
      centerRightEnabled: p.centerRightEnabled !== false,
      centerLineDashed: p.centerLineDashed !== false,
      centerLeftDashed: p.centerLeftDashed !== false,
      centerRightDashed: p.centerRightDashed !== false,
      centerLineDashScale: p.centerLineDashScale ?? 0.08,
      laneDashScale: p.laneDashScale ?? 0.08,
      profilePreset: p.profilePreset ?? "flat",
      profileScale: p.profileScale ?? 1,
    });

    // Lab road surface + line marking materials (TSL); markings need the same uniforms for line scratch.
    const texActive = !!p.usePbrTextures && !!(this._diffuseTex && this._armTex && this._normalTex);
    if (!this._labPbrRoadMat || this._labShaderTexActive !== texActive) {
      this._labRebuildPbrLabMaterials(texActive);
    } else if (!this._labCenterLineMat) {
      this._labRebuildLineMarkingMaterials();
    }
    const surfJuncMat = this._labPbrJuncMat;
    const surfRoadMat = this._labPbrRoadMat;

    const roadW = Math.max(1e-6, p.width ?? 16);

    for (const piece of pieces) {
      if (!piece.polygon || piece.polygon.length < 3) continue;
      const mat = piece.isJunctionCore ? surfJuncMat : surfRoadMat;
      const geo = piece.grid
        ? this._labGridToGeometry(piece.grid, p, 0, piece.gridProfile)
        : this._labPolygon2DToPlaneGeometry(piece.polygon, p);
      if (geo) {
        const mesh = new THREE.Mesh(geo, mat);
        mesh.renderOrder = 3;
        mesh.receiveShadow = true;
        this.meshGroup.add(mesh);
      }

      // Edge stripes (white): inset + width match Full Road shader (lineInset / lineWidth × road width).
      const ew = Math.max(0, p.lineWidth ?? 0);
      const insetNorm = Math.max(0, p.lineInset ?? 0.055);
      if (ew > 1e-6 && piece.polygon?.length >= 3) {
        let insetDist = (insetNorm + ew * 0.5) * roadW;
        insetDist = Math.min(insetDist, roadW * 0.42);
        const halfEdge = Math.max(0.004, ew * roadW * 0.5);
        if (piece.left?.path?.length >= 2) {
          const offsetPath = this._labOffsetPathTowardInterior(piece.left.path, piece.polygon, insetDist, false);
          const stripe = this._labPathToStripeMesh3D(offsetPath, p, this._labDividerLineMat, halfEdge, false);
          if (stripe) {
            stripe.renderOrder = 5;
            this.meshGroup.add(stripe);
          }
        }
        if (piece.right?.path?.length >= 2) {
          const offsetPath = this._labOffsetPathTowardInterior(piece.right.path, piece.polygon, insetDist, false);
          const stripe = this._labPathToStripeMesh3D(offsetPath, p, this._labDividerLineMat, halfEdge, false);
          if (stripe) {
            stripe.renderOrder = 5;
            this.meshGroup.add(stripe);
          }
        }
        // Junction cores / caps: no left/right paths. Do NOT trace the full fill polygon — it includes
        // mouth chords (perpendicular across each road), which become transverse white bands. Use
        // outlineSegments (fillets only), same idea as lab0 purple when seams are hidden.
        if (piece.isJunctionCore && piece.polygon.length >= 3) {
          const edgePaths = this._labJunctionCoreOuterEdgePaths(piece);
          for (const path2d of edgePaths) {
            if (!path2d || path2d.length < 2) continue;
            const offsetPath = this._labOffsetPathTowardInterior(path2d, piece.polygon, insetDist, false);
            const stripe = this._labPathToStripeMesh3D(offsetPath, p, this._labDividerLineMat, halfEdge, false);
            if (stripe) {
              stripe.renderOrder = 5;
              this.meshGroup.add(stripe);
            }
          }
        }
      }
    }

    // Lane markings (colors / dash pattern match Smart Road tweakpane → Full Road defaults)
    for (const m of markings || []) {
      if (!m.path || m.path.length < 2) continue;
      const mat = this._labMatForMarkingType(m.type);
      if (!mat) continue;
      const { dashed, dashScale } = this._labDashOptsForMarking(m.type, p, m);
      const paths = dashed ? this._labDashFragments2d(m.path, dashScale) : [m.path];
      const usePaths = paths.length ? paths : [m.path];
      const halfStripe = this._labMarkingHalfWidthWorld(m.type, roadW, p);
      for (const path2d of usePaths) {
        if (!path2d || path2d.length < 2) continue;
        const stripe = this._labPathToStripeMesh3D(path2d, p, mat, halfStripe);
        if (stripe) {
          stripe.renderOrder = 4;
          this.meshGroup.add(stripe);
        }
      }
    }

    if (this._labPbrRoadUniforms && this._labPbrJuncUniforms) {
      const style = extractStyle(p);
      const base = makeRoadParams(p, style, false);
      Object.assign(base, { enhanced: false, reflectStrength: 0 });
      syncRoadUniforms(this._labPbrRoadUniforms, base);
      syncRoadUniforms(this._labPbrJuncUniforms, {
        ...base,
        colorBrightness: (p.colorBrightness ?? 0.62) * 0.94,
      });
      this._labPbrRoadMat.needsUpdate = true;
      this._labPbrJuncMat.needsUpdate = true;
    }
  }

  _labPolygonCentroid2d(poly) {
    if (!poly?.length) return { x: 0, y: 0 };
    let sx = 0;
    let sy = 0;
    for (const pt of poly) {
      sx += pt.x;
      sy += pt.y;
    }
    const n = poly.length;
    return { x: sx / n, y: sy / n };
  }

  /**
   * Open polylines along the outer road edge for junction caps, excluding mouth chords.
   * Multi-way junctions: `outlineSegments` from roadNetworkLabGeometry (corner fillets only).
   * Flat dead-end: quad [L,R,Rb,Lb] — omit edge L–R. Round dead-end: arc chain only.
   */
  _labJunctionCoreOuterEdgePaths(piece) {
    const segs = piece.outlineSegments;
    if (Array.isArray(segs) && segs.length > 0) {
      return segs.filter((s) => s?.length >= 2);
    }
    const poly = piece.polygon;
    if (!poly || poly.length < 3) return [];
    // Flat cap quad [L,R,Rb,Lb]: omit mouth L–R and the rear chord Rb–Lb (full-width bar reads as a “cap” line).
    if (poly.length === 4) {
      const L = poly[0];
      const R = poly[1];
      const Rb = poly[2];
      const Lb = poly[3];
      return [
        [R, Rb],
        [Lb, L],
      ];
    }
    return [poly.slice()];
  }

  _labPolylineTangent2d(path2d, i, closed) {
    const n = path2d.length;
    if (n < 2) return { dx: 1, dy: 0 };
    let iPrev;
    let iNext;
    if (closed && n >= 3) {
      iPrev = (i - 1 + n) % n;
      iNext = (i + 1) % n;
    } else if (i === 0) {
      iPrev = 0;
      iNext = 1;
    } else if (i === n - 1) {
      iPrev = n - 2;
      iNext = n - 1;
    } else {
      iPrev = i - 1;
      iNext = i + 1;
    }
    let dx = path2d[iNext].x - path2d[iPrev].x;
    let dz = path2d[iNext].y - path2d[iPrev].y;
    let len = Math.hypot(dx, dz);
    if (len < 1e-8) {
      dx = path2d[Math.min(i + 1, n - 1)].x - path2d[Math.max(i - 1, 0)].x;
      dz = path2d[Math.min(i + 1, n - 1)].y - path2d[Math.max(i - 1, 0)].y;
      len = Math.hypot(dx, dz) || 1;
    }
    return { dx, dy: dz, len };
  }

  /** Shift boundary path toward piece interior (same plane as lab xz). */
  _labOffsetPathTowardInterior(path2d, polygon2d, distance, closed = false) {
    if (!path2d?.length || distance < 1e-8) return path2d;
    const centroid =
      polygon2d?.length >= 3 ? this._labPolygonCentroid2d(polygon2d) : this._labPolygonCentroid2d(path2d);

    const out = [];
    const n = path2d.length;
    for (let i = 0; i < n; i++) {
      const { dx, dy: dz } = this._labPolylineTangent2d(path2d, i, closed && n >= 3);
      let len = Math.hypot(dx, dz);
      if (len < 1e-8) len = 1;
      let ux = -dz / len;
      let uy = dx / len;
      const vx = centroid.x - path2d[i].x;
      const vy = centroid.y - path2d[i].y;
      if (ux * vx + uy * vy < 0) {
        ux *= -1;
        uy *= -1;
      }
      out.push({ x: path2d[i].x + ux * distance, y: path2d[i].y + uy * distance });
    }
    return out;
  }

  /** Half-width in world meters (Full Road uses stripe width ≈ normalized × road width). */
  _labMarkingHalfWidthWorld(type, roadWidth, p) {
    const cw = Math.max(1e-6, p.centerLineWidth ?? 0.012);
    const lw = Math.max(1e-6, p.laneLineWidth ?? 0.004);
    switch (type) {
      case "center":
      case "centerLeft":
      case "centerRight":
        return Math.max(0.004, cw * roadWidth * 0.5);
      case "divider":
      case "junctionCenter":
      default:
        return Math.max(0.004, lw * roadWidth * 0.5);
    }
  }

  /** Ribbon mesh along lab 2D polyline (y → world Z), extruded ±halfWidth in XZ. */
  _labPathToStripeMesh3D(path2d, p, material, halfWidthWorld, closed = false) {
    const hw = Math.max(0.004, halfWidthWorld);
    const n = path2d.length;
    if (n < 2) return null;
    const isClosed = closed && n >= 3;

    const left = [];
    const right = [];
    for (let i = 0; i < n; i++) {
      const { dx, dy: dz } = this._labPolylineTangent2d(path2d, i, isClosed);
      let len = Math.hypot(dx, dz);
      if (len < 1e-8) len = 1;
      const px = (-dz / len) * hw;
      const py = (dx / len) * hw;
      left.push({ x: path2d[i].x + px, y: path2d[i].y + py });
      right.push({ x: path2d[i].x - px, y: path2d[i].y - py });
    }

    const cum = new Float32Array(n);
    for (let i = 1; i < n; i++) {
      const a = path2d[i - 1];
      const b = path2d[i];
      cum[i] = cum[i - 1] + Math.hypot(b.x - a.x, b.y - a.y);
    }
    // Same convention as generateRoadGeometry (roadMesh.js): uv.x = arc length in meters along the strip.
    // Line scratch uses arcLen in _lineScratchMask; scaling x by 0.1 vs full road made scratches stretch
    // along the marking tangent.
    const uvs = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const u = cum[i];
      const o = i * 4;
      uvs[o] = u;
      uvs[o + 1] = 0;
      uvs[o + 2] = u;
      uvs[o + 3] = 1;
    }

    const usePbrStripe =
      !!p.usePbrTextures && !!(this._diffuseTex && this._armTex && this._normalTex);
    const lift = usePbrStripe ? 0.08 : 0.055;
    const yAt = (x, z) => this._roadSurfaceYLab(x, z, p) + lift;

    const positions = new Float32Array(n * 2 * 3);
    let pi = 0;
    for (let i = 0; i < n; i++) {
      // Height per ribbon edge so geometry stays above the triangulated road surface (spine-only Y
      // dipped below the mesh on slopes / at depth precision limits and failed the depth test).
      const yL = yAt(left[i].x, left[i].y);
      const yR = yAt(right[i].x, right[i].y);
      positions[pi++] = left[i].x;
      positions[pi++] = yL;
      positions[pi++] = left[i].y;
      positions[pi++] = right[i].x;
      positions[pi++] = yR;
      positions[pi++] = right[i].y;
    }

    const indices = [];
    const segCount = isClosed ? n : n - 1;
    for (let i = 0; i < segCount; i++) {
      const j = isClosed ? (i + 1) % n : i + 1;
      const b = i * 2;
      const bj = j * 2;
      indices.push(b, bj, b + 1, b + 1, bj, bj + 1);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    return new THREE.Mesh(geo, material);
  }

  _labMatForMarkingType(type) {
    switch (type) {
      case "center":
        return this._labCenterLineMat;
      case "centerLeft":
        return this._labCenterLeftMat;
      case "centerRight":
        return this._labCenterRightMat;
      case "divider":
      case "junctionCenter":
        return this._labDividerLineMat;
      default:
        return this._labDividerLineMat;
    }
  }

  _labDashOptsForMarking(type, p, marking) {
    const laneDash = p.laneDashScale ?? 0.08;
    const centerDash = p.centerLineDashScale ?? 0.08;
    if (marking && marking.dashed !== undefined) {
      const dashScale = marking.dashScale ?? (type === "divider" ? laneDash : centerDash);
      return { dashed: !!marking.dashed, dashScale };
    }
    switch (type) {
      case "divider":
        return { dashed: !!p.laneLines, dashScale: laneDash };
      case "center":
        return { dashed: !!p.centerLineDashed, dashScale: centerDash };
      case "centerLeft":
        return { dashed: !!p.centerLeftDashed, dashScale: centerDash };
      case "centerRight":
        return { dashed: !!p.centerRightDashed, dashScale: centerDash };
      default:
        return { dashed: false, dashScale: centerDash };
    }
  }

  _labPolylineDense2d(points2d, stepMeters) {
    const out = [];
    if (!points2d?.length) return out;
    out.push(points2d[0]);
    const step = Math.max(0.05, Math.min(0.35, stepMeters));
    for (let i = 0; i < points2d.length - 1; i++) {
      const a = points2d[i];
      const b = points2d[i + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const segLen = Math.hypot(dx, dy);
      const n = Math.max(1, Math.ceil(segLen / step));
      for (let k = 1; k <= n; k++) {
        const t = k / n;
        out.push({ x: a.x + dx * t, y: a.y + dy * t });
      }
    }
    return out;
  }

  /** Split polyline using same dash mask as Full Road: visible when fract(s·scale) ≥ 0.5 */
  _labDashFragments2d(points2d, dashScale) {
    if (!points2d || points2d.length < 2 || !(dashScale > 1e-9)) return [];
    const dense = this._labPolylineDense2d(points2d, 0.14);
    if (dense.length < 2) return [];
    const cum = [0];
    for (let i = 1; i < dense.length; i++) {
      const a = dense[i - 1];
      const b = dense[i];
      cum[i] = cum[i - 1] + Math.hypot(b.x - a.x, b.y - a.y);
    }
    const frags = [];
    let run = [];
    const dashOn = (s) => {
      const ph = s * dashScale;
      const frac = ph - Math.floor(ph);
      return frac >= 0.5 - 1e-7;
    };
    for (let i = 0; i < dense.length; i++) {
      const on = dashOn(cum[i]);
      if (i === 0) {
        if (on) run.push(dense[i]);
        continue;
      }
      const prevOn = dashOn(cum[i - 1]);
      if (on !== prevOn) {
        if (prevOn && run.length >= 2) frags.push(run);
        run = [];
        if (on) run.push(dense[i - 1], dense[i]);
      } else if (on) {
        run.push(dense[i]);
      }
    }
    if (run.length >= 2) frags.push(run);
    return frags.length ? frags : [];
  }

  /** Convert lab 2D polygon (x,y where y=worldZ) to flat 3D PlaneGeometry on terrain. */
  _labPolygon2DToPlaneGeometry(polygon, p, yBias = 0) {
    if (!polygon || polygon.length < 3) return null;

    // Use earcut for robust triangulation
    const flatVerts = [];
    for (const pt of polygon) {
      flatVerts.push(pt.x, pt.y);
    }
    const indices = THREE.ShapeUtils.triangulateShape(
      polygon.map((pt) => new THREE.Vector2(pt.x, pt.y)),
      []
    );

    const positions = [];
    const uvs = [];
    const yOff = Number(yBias) || 0;
    for (const [i0, i1, i2] of indices) {
      for (const idx of [i0, i1, i2]) {
        const x = polygon[idx].x;
        const z = polygon[idx].y; // lab y -> world z
        const y = this._roadSurfaceYLab(x, z, p) + yOff;
        positions.push(x, y, z);
        uvs.push(x / 10, z / 10);
      }
    }

    if (positions.length === 0) return null;

    const nVert = positions.length / 3;
    const junc = new Float32Array(nVert);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    geo.setAttribute("aJunction", new THREE.Float32BufferAttribute(junc, 1));
    geo.computeVertexNormals();
    return geo;
  }

  _labGridToGeometry(grid, p, yBias = 0, gridProfile = null) {
    const rows = grid.length;
    if (rows < 2) return null;
    const cols = grid[0].length;
    if (cols < 2) return null;

    const nVert = rows * cols;
    const positions = new Float32Array(nVert * 3);
    const uvs = new Float32Array(nVert * 2);
    const junc = new Float32Array(nVert);
    const yOff = Number(yBias) || 0;
    let pi = 0, ui = 0;

    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < cols; j++) {
        const pt = grid[i][j];
        const x = pt.x;
        const z = pt.y;
        const profY = gridProfile ? (gridProfile[j] || 0) : 0;
        const y = this._roadSurfaceYLab(x, z, p) + yOff + profY;
        positions[pi++] = x;
        positions[pi++] = y;
        positions[pi++] = z;
        uvs[ui++] = x / 10;
        uvs[ui++] = z / 10;
      }
    }

    const indexCount = (rows - 1) * (cols - 1) * 6;
    const indices = new Uint32Array(indexCount);
    let ii = 0;
    for (let i = 0; i < rows - 1; i++) {
      for (let j = 0; j < cols - 1; j++) {
        const a = i * cols + j;
        const b = a + 1;
        const c = (i + 1) * cols + j;
        const d = c + 1;
        indices[ii++] = a;
        indices[ii++] = c;
        indices[ii++] = b;
        indices[ii++] = b;
        indices[ii++] = c;
        indices[ii++] = d;
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    geo.setAttribute("aJunction", new THREE.BufferAttribute(junc, 1));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    geo.computeVertexNormals();
    return geo;
  }

  _labDisposeLineMarkingMaterials() {
    if (this._labCenterLineMat) {
      this._labCenterLineMat.dispose();
      this._labCenterLineMat = null;
    }
    if (this._labCenterLeftMat) {
      this._labCenterLeftMat.dispose();
      this._labCenterLeftMat = null;
    }
    if (this._labCenterRightMat) {
      this._labCenterRightMat.dispose();
      this._labCenterRightMat = null;
    }
    if (this._labDividerLineMat) {
      this._labDividerLineMat.dispose();
      this._labDividerLineMat = null;
    }
  }

  _labRebuildLineMarkingMaterials() {
    this._labDisposeLineMarkingMaterials();
    if (!this._labPbrRoadUniforms) return;
    const m = createLabLineMarkingMaterials(this._labPbrRoadUniforms);
    this._labCenterLineMat = m.center;
    this._labCenterLeftMat = m.centerLeft;
    this._labCenterRightMat = m.centerRight;
    this._labDividerLineMat = m.divider;
  }

  _labDisposePbrMats() {
    this._labDisposeLineMarkingMaterials();
    if (this._labPbrRoadMat) {
      this._labPbrRoadMat.dispose();
      this._labPbrRoadMat = null;
    }
    if (this._labPbrJuncMat) {
      this._labPbrJuncMat.dispose();
      this._labPbrJuncMat = null;
    }
    this._labPbrRoadUniforms = null;
    this._labPbrJuncUniforms = null;
    this._labShaderTexActive = null;
  }

  /**
   * Smart Road lab surface: TSL road material, optional diffuse/ARM/normal when `texActive`.
   * Procedural asphalt + aging when maps are off or toggle is disabled.
   */
  _labRebuildPbrLabMaterials(texActive) {
    const p = this.toolState.fullRoad;
    const style = extractStyle(p);
    const baseParams = makeRoadParams(p, style, false);
    Object.assign(baseParams, { enhanced: false, reflectStrength: 0 });
    const juncParams = { ...baseParams, colorBrightness: (p.colorBrightness ?? 0.62) * 0.94 };
    this._labDisposePbrMats();
    this._labPbrRoadUniforms = createRoadUniforms(baseParams);
    this._labPbrJuncUniforms = createRoadUniforms(juncParams);
    const d = texActive ? this._diffuseTex : null;
    const a = texActive ? this._armTex : null;
    const n = texActive ? this._normalTex : null;
    this._labPbrRoadMat = createRoadMaterial(
      this._labPbrRoadUniforms,
      d,
      a,
      n,
      null,
      { skipUvSpaceFade: true, labPiecewiseUvs: true },
    );
    this._labPbrJuncMat = createRoadMaterial(
      this._labPbrJuncUniforms,
      d,
      a,
      n,
      null,
      { skipUvSpaceFade: true, labPiecewiseUvs: true },
    );
    this._labShaderTexActive = texActive;
    this._labRebuildLineMarkingMaterials();
  }

  /** Convert lab 2D path to 3D Line on terrain. */
  _labPathToLine3D(path, p, material) {
    if (!path || path.length < 2) return null;
    const pts = [];
    for (const pt of path) {
      const x = pt.x;
      const z = pt.y; // lab y -> world z
      const y = this._roadSurfaceYLab(x, z, p) + 0.05; // slight lift above road surface
      pts.push(new THREE.Vector3(x, y, z));
    }
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    return new THREE.Line(geo, material);
  }

  _markJunctionVertices(geo, degree, roadWidth) {
    const junctionAttr = geo.getAttribute("aJunction");
    const posAttr = geo.getAttribute("position");
    if (!junctionAttr || !posAttr) return;
    
    // Collect junction node positions
    const junctionPositions = [];
    for (const node of this.nodes) {
      if (this._isJunctionNode(node.id, degree)) {
        junctionPositions.push(node.position);
      }
    }
    if (junctionPositions.length === 0) return;
    
    const junctionRadiusSq = (roadWidth * 0.8) ** 2;
    const fadeRadiusSq = (roadWidth * 1.5) ** 2;
    const juncArr = junctionAttr.array;
    const posArr = posAttr.array;
    
    // Track which vertices are near junctions and by how much
    const liftAmounts = new Float32Array(posAttr.count);
    
    for (let i = 0; i < posAttr.count; i++) {
      const vx = posArr[i * 3];
      const vz = posArr[i * 3 + 2];
      
      for (const jp of junctionPositions) {
        const dx = vx - jp.x;
        const dz = vz - jp.z;
        const distSq = dx * dx + dz * dz;
        
        if (distSq < junctionRadiusSq) {
          juncArr[i] = 1.0;
          // Slight lift to prevent z-fighting (smooth falloff from center)
          const dist = Math.sqrt(distSq);
          const juncRadius = roadWidth * 0.8;
          const lift = 0.02 * (1 - dist / juncRadius);
          liftAmounts[i] = Math.max(liftAmounts[i], lift);
          break;
        } else if (distSq < fadeRadiusSq) {
          const t = (distSq - junctionRadiusSq) / (fadeRadiusSq - junctionRadiusSq);
          juncArr[i] = Math.max(juncArr[i], 1.0 - t);
          // Small lift in fade zone too
          const lift = 0.01 * (1 - t);
          liftAmounts[i] = Math.max(liftAmounts[i], lift);
        }
      }
    }
    
    // Apply lifts
    for (let i = 0; i < posAttr.count; i++) {
      if (liftAmounts[i] > 0) {
        posArr[i * 3 + 1] += liftAmounts[i];
      }
    }
    
    junctionAttr.needsUpdate = true;
    posAttr.needsUpdate = true;
  }
  
  _mergeGeometries(geometries) {
    if (geometries.length === 0) return null;
    if (geometries.length === 1) return geometries[0].clone();
    
    // Collect all attributes
    let totalVerts = 0;
    let totalIndices = 0;
    for (const geo of geometries) {
      totalVerts += geo.getAttribute("position").count;
      totalIndices += geo.index ? geo.index.count : 0;
    }
    
    const positions = new Float32Array(totalVerts * 3);
    const uvs = new Float32Array(totalVerts * 2);
    const junctions = new Float32Array(totalVerts);
    const indices = [];
    
    let vertOffset = 0;
    let idxOffset = 0;
    
    for (const geo of geometries) {
      const pos = geo.getAttribute("position");
      const uv = geo.getAttribute("uv");
      const junc = geo.getAttribute("aJunction");
      const idx = geo.index;
      
      // Copy positions
      for (let i = 0; i < pos.count; i++) {
        positions[(vertOffset + i) * 3] = pos.getX(i);
        positions[(vertOffset + i) * 3 + 1] = pos.getY(i);
        positions[(vertOffset + i) * 3 + 2] = pos.getZ(i);
      }
      
      // Copy UVs
      if (uv) {
        for (let i = 0; i < uv.count; i++) {
          uvs[(vertOffset + i) * 2] = uv.getX(i);
          uvs[(vertOffset + i) * 2 + 1] = uv.getY(i);
        }
      }
      
      // Copy junction attribute
      if (junc) {
        for (let i = 0; i < junc.count; i++) {
          junctions[vertOffset + i] = junc.getX(i);
        }
      }
      
      // Copy indices with offset
      if (idx) {
        for (let i = 0; i < idx.count; i++) {
          indices.push(idx.getX(i) + vertOffset);
        }
      }
      
      vertOffset += pos.count;
    }
    
    const merged = new THREE.BufferGeometry();
    merged.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    merged.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    merged.setAttribute("aJunction", new THREE.Float32BufferAttribute(junctions, 1));
    merged.setIndex(indices);
    merged.computeVertexNormals();
    
    return merged;
  }

  _junctionLinks(node) {
    const p = this.toolState.fullRoad;
    return this.edges
      .filter(edge => edge.a === node.id || edge.b === node.id)
      .map((edge) => {
        const atStart = edge.a === node.id;
        const other = this._nodeById(atStart ? edge.b : edge.a);
        if (!other) return null;
        const outward = normalizeXZ(other.position.clone().sub(node.position));
        const side = perpXZ(outward);
        const trim = Math.max(p.junctionRadius, p.width * 0.65);
        const center = node.position.clone().add(outward.clone().multiplyScalar(trim));
        return {
          angle: angleXZ(outward),
          outward,
          center,
          left: center.clone().add(side.clone().multiplyScalar(p.width * 0.5)),
          right: center.clone().add(side.clone().multiplyScalar(-p.width * 0.5)),
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.angle - b.angle);
  }

  _makeJunctionGeometry(node, links, _segments) {
    const p = this.toolState.fullRoad;
    if (links.length < 2) return null;

    const boundary = this._junctionBoundary(node, links);
    if (boundary.length < 3) return null;

    const center = this._polygonCentroid(boundary, node.position);
    const positions = [center.x, this.getWorldHeight(center.x, center.z) + p.heightOffset, center.z];
    const uvs = [0.5, 0.5];
    const junction = [1];
    const indices = [];
    const maxRadius = Math.max(p.width, p.junctionRadius) * 1.5;
    for (const bp of boundary) {
      const dx = bp.x - center.x;
      const dz = bp.z - center.z;
      const x = bp.x;
      const z = bp.z;
      positions.push(x, this.getWorldHeight(x, z) + p.heightOffset, z);
      uvs.push(0.5 + dx / maxRadius * 0.5, 0.5 + dz / maxRadius * 0.5);
      junction.push(1);
    }
    for (let i = 0; i < boundary.length; i++) {
      const next = i === boundary.length - 1 ? 1 : i + 2;
      indices.push(0, i + 1, next);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    geo.setAttribute("aJunction", new THREE.Float32BufferAttribute(junction, 1));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    return geo;
  }

  _junctionBoundary(node, links) {
    if (links.length === 4 && this._isGridLikeJunction(links)) {
      return this._gridJunctionRect(node, links);
    }
    const pts = [];
    for (const link of links) pts.push(link.right, link.left);
    return this._convexHullXZ(pts);
  }

  _isGridLikeJunction(links) {
    let oppositePairs = 0;
    for (let i = 0; i < links.length; i++) {
      for (let j = i + 1; j < links.length; j++) {
        if (links[i].outward.dot(links[j].outward) < -0.82) oppositePairs++;
      }
    }
    return oppositePairs >= 2;
  }

  _gridJunctionRect(node, links) {
    const axisU = links[0].outward.clone();
    let axisV = links[1].outward.clone();
    let bestAbsDot = Math.abs(axisU.dot(axisV));
    for (let i = 1; i < links.length; i++) {
      const absDot = Math.abs(axisU.dot(links[i].outward));
      if (absDot < bestAbsDot) {
        axisV = links[i].outward.clone();
        bestAbsDot = absDot;
      }
    }
    const u = normalizeXZ(axisU);
    const v = normalizeXZ(axisV.sub(u.clone().multiplyScalar(axisV.dot(u))));
    const pts = links.flatMap(link => [link.left, link.right]);
    let extentU = 0;
    let extentV = 0;
    for (const pt of pts) {
      const rel = pt.clone().sub(node.position);
      extentU = Math.max(extentU, Math.abs(rel.dot(u)));
      extentV = Math.max(extentV, Math.abs(rel.dot(v)));
    }
    extentU += 0.2;
    extentV += 0.2;
    return [
      node.position.clone().add(u.clone().multiplyScalar(extentU)).add(v.clone().multiplyScalar(extentV)),
      node.position.clone().add(u.clone().multiplyScalar(-extentU)).add(v.clone().multiplyScalar(extentV)),
      node.position.clone().add(u.clone().multiplyScalar(-extentU)).add(v.clone().multiplyScalar(-extentV)),
      node.position.clone().add(u.clone().multiplyScalar(extentU)).add(v.clone().multiplyScalar(-extentV)),
    ];
  }

  _convexHullXZ(points) {
    if (points.length <= 3) return [...points];
    const sorted = [...points].sort((a, b) => a.x === b.x ? a.z - b.z : a.x - b.x);
    const cross = (o, a, b) => (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);
    const lower = [];
    for (const p of sorted) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
      lower.push(p);
    }
    const upper = [];
    for (let i = sorted.length - 1; i >= 0; i--) {
      const p = sorted[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
      upper.push(p);
    }
    lower.pop();
    upper.pop();
    return lower.concat(upper);
  }

  _polygonCentroid(points, fallback) {
    if (!points.length) return fallback.clone();
    const c = new THREE.Vector3();
    for (const p of points) c.add(p);
    return c.multiplyScalar(1 / points.length);
  }

  _makeJunctionMarkings(_node, links) {
    const p = this.toolState.fullRoad;
    const meshes = [];
    const used = new Set();
    const lineWidth = Math.max(0.08, p.lineWidth * p.width);
    const centerWidth = Math.max(0.08, p.centerLineWidth * p.width);
    for (let i = 0; i < links.length; i++) {
      if (used.has(i)) continue;
      let bestJ = -1;
      let bestDot = -0.72;
      for (let j = i + 1; j < links.length; j++) {
        if (used.has(j)) continue;
        const dot = links[i].outward.dot(links[j].outward);
        if (dot < bestDot) {
          bestDot = dot;
          bestJ = j;
        }
      }
      if (bestJ < 0) continue;
      used.add(i);
      used.add(bestJ);
      const a = links[i];
      const b = links[bestJ];
      if (p.lineWidth > 0) {
        meshes.push(this._makeLineStrip(a.left, b.right, lineWidth, this._junctionLineMat));
        meshes.push(this._makeLineStrip(a.right, b.left, lineWidth, this._junctionLineMat));
      }
      if (p.centerLine) {
        meshes.push(this._makeLineStrip(a.center, b.center, centerWidth, this._junctionCenterLineMat));
      }
    }
    return meshes.filter(Boolean);
  }

  _makeLineStrip(a, b, width, material) {
    const dir = normalizeXZ(b.clone().sub(a));
    const side = perpXZ(dir).multiplyScalar(width * 0.5);
    const yLift = this.toolState.fullRoad.heightOffset + 0.035;
    const p0 = a.clone().add(side);
    const p1 = a.clone().sub(side);
    const p2 = b.clone().add(side);
    const p3 = b.clone().sub(side);
    const positions = [
      p0.x, this.getWorldHeight(p0.x, p0.z) + yLift, p0.z,
      p2.x, this.getWorldHeight(p2.x, p2.z) + yLift, p2.z,
      p1.x, this.getWorldHeight(p1.x, p1.z) + yLift, p1.z,
      p1.x, this.getWorldHeight(p1.x, p1.z) + yLift, p1.z,
      p2.x, this.getWorldHeight(p2.x, p2.z) + yLift, p2.z,
      p3.x, this.getWorldHeight(p3.x, p3.z) + yLift, p3.z,
    ];
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    const mesh = new THREE.Mesh(geo, material);
    mesh.name = "FullRoadJunctionMarking";
    mesh.renderOrder = 6;
    return mesh;
  }

  _rebuildHandles() {
    this._clearGroup(this.handleGroup);
    this.handleMeshes = [];
    const degree = this._degreeMap();
    const selected = this.selectedNodeId;
    for (const path of this._buildRoadPaths(degree)) {
      const curve = this._curveForPath(path);
      if (!curve) continue;
      const geo = new THREE.BufferGeometry().setFromPoints(curve.getSpacedPoints(32));
      const line = new THREE.Line(geo, this._lineMat);
      line.raycast = () => {};
      this.handleGroup.add(line);
    }
    for (const node of this.nodes) {
      const deg = degree.get(node.id) ?? 0;
      const isJunction = node.forceJunction || deg >= 3;
      const color = node.id === selected ? 0xffff00 : isJunction ? 0xbd6cff : 0x44b8ff;
      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(isJunction ? 0.78 : 0.58, 12, 8),
        new THREE.MeshBasicMaterial({ color }),
      );
      sphere.position.copy(node.position);
      sphere.userData.nodeId = node.id;
      this.handleGroup.add(sphere);
      this.handleMeshes.push(sphere);
    }
    this._syncHandlesVisibility();
  }

  _syncHandlesVisibility() {
    this.handleGroup.visible =
      this.toolState.mode === this._graphMode && this.toolState.fullRoad.showHandles;
  }

  _rebuildVisual() {
    this.rebuildAllMeshes();
    this.rebuildAllGuardrails();
    this.rebuildAllDecals();
    this._rebuildHandles();
  }

  _clearGroup(group) {
    while (group.children.length) {
      const child = group.children[0];
      group.remove(child);
      if (child.geometry) child.geometry.dispose();
      if (
        child.material &&
        child.material !== this._roadMat &&
        child.material !== this._junctionMat &&
        child.material !== this._lineMat &&
        child.material !== this._junctionLineMat &&
        child.material !== this._junctionCenterLineMat &&
        child.material !== this._labCenterLineMat &&
        child.material !== this._labCenterLeftMat &&
        child.material !== this._labCenterRightMat &&
        child.material !== this._labDividerLineMat &&
        child.material !== this._labPbrRoadMat &&
        child.material !== this._labPbrJuncMat
      ) {
        child.material.dispose();
      }
    }
  }

  _updateSelectedY() {
    const node = this._nodeById(this.selectedNodeId);
    if (node) this.toolState.fullRoad.selectedPointY = node.position.y;
  }

  getRoadMeshes() {
    return this.meshGroup.children.filter(child => child.isMesh);
  }

  getAverageY() {
    if (!this.nodes.length) return 0;
    return this.nodes.reduce((sum, n) => sum + n.position.y, 0) / this.nodes.length;
  }

  hasReflectiveRoads() {
    const p = this.toolState.fullRoad;
    return (p.reflectStrength ?? 0) > 0 && this.edges.length > 0;
  }

  updateReflectVP(matrix) {
    if (this._roadUniforms) this._roadUniforms.uReflectVP.value.copy(matrix);
    if (this._junctionUniforms) this._junctionUniforms.uReflectVP.value.copy(matrix);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // GUARDRAIL PAINTING SYSTEM
  // ─────────────────────────────────────────────────────────────────────────────

  _findNearestRoadEdgePoint(pos, maxDist = 20, edgeOffset = null) {
    const paths = this._buildRoadPaths();
    const p = this.toolState.fullRoad;
    const halfWidth = p.width * 0.5;
    const offset = edgeOffset ?? p.guardrailEdgeOffset ?? 0.3;
    const lateralDist = halfWidth + offset;
    
    let best = null;
    
    for (let pathIdx = 0; pathIdx < paths.length; pathIdx++) {
      const path = paths[pathIdx];
      const curve = this._curveForPath(path);
      if (!curve) continue;
      
      const samples = Math.max(64, path.nodeIds.length * 32);
      const pts = curve.getSpacedPoints(samples);
      
      for (let i = 0; i < pts.length - 1; i++) {
        const t = i / (pts.length - 1);
        const tangent = curve.getTangentAt(t);
        const perp = perpXZ(normalizeXZ(tangent));
        
        // Check both sides
        for (const sideSign of [1, -1]) {
          const edgeX = pts[i].x + perp.x * lateralDist * sideSign;
          const edgeZ = pts[i].z + perp.z * lateralDist * sideSign;
          const dx = pos.x - edgeX;
          const dz = pos.z - edgeZ;
          const distSq = dx * dx + dz * dz;
          
          if (distSq < maxDist * maxDist && (!best || distSq < best.distSq)) {
            best = {
              distSq,
              pathIdx,
              path,
              curve,
              t,
              side: sideSign > 0 ? "left" : "right",
              x: edgeX,
              y: pts[i].y,
              z: edgeZ,
            };
          }
        }
      }
    }
    
    return best;
  }

  _findNearestRoadCenterPoint(pos, maxDist = 20) {
    const paths = this._buildRoadPaths();
    let best = null;

    for (let pathIdx = 0; pathIdx < paths.length; pathIdx++) {
      const path = paths[pathIdx];
      const curve = this._curveForPath(path);
      if (!curve) continue;

      const samples = Math.max(64, path.nodeIds.length * 32);
      const pts = curve.getSpacedPoints(samples);

      for (let i = 0; i < pts.length; i++) {
        const t = i / Math.max(1, pts.length - 1);
        const dx = pos.x - pts[i].x;
        const dz = pos.z - pts[i].z;
        const distSq = dx * dx + dz * dz;

        if (distSq < maxDist * maxDist && (!best || distSq < best.distSq)) {
          best = {
            distSq,
            pathIdx,
            path,
            curve,
            t,
            side: "center",
            x: pts[i].x,
            y: pts[i].y,
            z: pts[i].z,
          };
        }
      }
    }

    return best;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // GENERIC ACCESSORY PAINTING (guardrails, kerbs, barriers, fences)
  // ─────────────────────────────────────────────────────────────────────────────

  _getAccessoryEdgeOffset(type) {
    const p = this.toolState.fullRoad;
    switch (type) {
      case "guardrail": return p.guardrailEdgeOffset ?? 0.3;
      case "kerb": return p.kerbEdgeOffset ?? 0.0;
      case "barrier": return p.barrierEdgeOffset ?? 0.5;
      case "fence": return p.fenceEdgeOffset ?? 0.5;
      case "tunnel": return 0;
      default: return 0.3;
    }
  }

  _getAccessorySide(type) {
    const p = this.toolState.fullRoad;
    switch (type) {
      case "guardrail": return p.guardrailSide ?? "right";
      case "kerb": return p.kerbSide ?? "right";
      case "barrier": return p.barrierSide ?? "right";
      case "fence": return p.fenceSide ?? "right";
      case "tunnel": return "center";
      default: return "right";
    }
  }

  _getAccessoryArray(type) {
    switch (type) {
      case "guardrail": return this.guardrails;
      case "kerb": return this.kerbs;
      case "barrier": return this.barriers;
      case "fence": return this.fences;
      case "tunnel": return this.tunnels;
      default: return this.guardrails;
    }
  }

  startAccessoryPaint(pos, type = null) {
    const p = this.toolState.fullRoad;
    const accessoryType = type || p.accessoryType || "guardrail";
    const edgeOffset = this._getAccessoryEdgeOffset(accessoryType);
    const hit = accessoryType === "tunnel"
      ? this._findNearestRoadCenterPoint(pos, 20)
      : this._findNearestRoadEdgePoint(pos, 20, edgeOffset);
    if (!hit) return false;
    
    const side = this._getAccessorySide(accessoryType);
    this._paintingAccessory = {
      type: accessoryType,
      pathIdx: hit.pathIdx,
      side: side === "auto" ? hit.side : side,
      startT: hit.t,
      endT: hit.t,
      curve: hit.curve,
      path: hit.path,
    };
    
    this._updateAccessoryPreview();
    return true;
  }

  continueAccessoryPaint(pos) {
    if (!this._paintingAccessory) return false;
    
    const pa = this._paintingAccessory;
    const curve = pa.curve;
    if (!curve) return false;
    
    const p = this.toolState.fullRoad;
    const halfWidth = p.width * 0.5;
    const edgeOffset = this._getAccessoryEdgeOffset(pa.type);
    const lateralDist = halfWidth + edgeOffset;
    const sideSign = pa.side === "left" ? 1 : -1;
    
    const samples = 128;
    let bestT = pa.endT;
    let bestDistSq = Infinity;
    
    for (let i = 0; i <= samples; i++) {
      const t = i / samples;
      const pt = curve.getPointAt(t);
      const tangent = curve.getTangentAt(t);
      const perp = perpXZ(normalizeXZ(tangent));
      
      const edgeX = pa.type === "tunnel" ? pt.x : pt.x + perp.x * lateralDist * sideSign;
      const edgeZ = pa.type === "tunnel" ? pt.z : pt.z + perp.z * lateralDist * sideSign;
      const dx = pos.x - edgeX;
      const dz = pos.z - edgeZ;
      const distSq = dx * dx + dz * dz;
      
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        bestT = t;
      }
    }
    
    pa.endT = bestT;
    this._updateAccessoryPreview();
    return true;
  }

  endAccessoryPaint() {
    if (!this._paintingAccessory) return null;
    
    const pa = this._paintingAccessory;
    const startT = Math.min(pa.startT, pa.endT);
    const endT = Math.max(pa.startT, pa.endT);
    
    if (endT - startT < 0.02) {
      this._paintingAccessory = null;
      this._clearAccessoryPreview();
      return null;
    }
    
    const accessory = {
      id: this._nextAccessoryId++,
      type: pa.type,
      pathIdx: pa.pathIdx,
      side: pa.side,
      startT,
      endT,
    };
    
    this._getAccessoryArray(pa.type).push(accessory);
    this._paintingAccessory = null;
    this._clearAccessoryPreview();
    this.rebuildAllAccessories();
    
    return accessory;
  }

  cancelAccessoryPaint() {
    this._paintingAccessory = null;
    this._clearAccessoryPreview();
  }

  _updateAccessoryPreview() {
    this._clearAccessoryPreview();
    if (!this._paintingAccessory) return;
    
    const pa = this._paintingAccessory;
    const mesh = this._buildAccessoryMesh(pa.type, pa.curve, pa.side, pa.startT, pa.endT, true);
    if (mesh) {
      mesh.name = "AccessoryPreview";
      this.accessoryGroup.add(mesh);
    }
  }

  _clearAccessoryPreview() {
    const preview = this.accessoryGroup.children.find(c => c.name === "AccessoryPreview");
    if (preview) {
      this.accessoryGroup.remove(preview);
      if (preview.traverse) {
        preview.traverse(obj => {
          if (obj.geometry) obj.geometry.dispose();
          if (obj.material) obj.material.dispose();
        });
      }
    }
  }

  rebuildAllAccessories() {
    const toRemove = this.accessoryGroup.children.filter(c => c.name !== "AccessoryPreview");
    for (const child of toRemove) {
      this.accessoryGroup.remove(child);
      if (child.traverse) {
        child.traverse(obj => {
          if (obj.geometry) obj.geometry.dispose();
          if (obj.material) obj.material.dispose();
        });
      }
    }
    
    const paths = this._buildRoadPaths();
    
    const buildAll = (arr, type) => {
      for (const item of arr) {
        const path = paths[item.pathIdx];
        if (!path) continue;
        const curve = this._curveForPath(path);
        if (!curve) continue;
        
        const group = this._buildAccessoryMesh(type, curve, item.side, item.startT, item.endT, false);
        if (group) {
          group.userData.accessoryId = item.id;
          group.userData.accessoryType = type;
          this.accessoryGroup.add(group);
        }
      }
    };
    
    buildAll(this.guardrails, "guardrail");
    buildAll(this.kerbs, "kerb");
    buildAll(this.barriers, "barrier");
    buildAll(this.fences, "fence");
    buildAll(this.tunnels, "tunnel");
  }

  // Backwards compatibility
  rebuildAllGuardrails() { this.rebuildAllAccessories(); }
  startGuardrailPaint(pos) { return this.startAccessoryPaint(pos, "guardrail"); }
  continueGuardrailPaint(pos) { return this.continueAccessoryPaint(pos); }
  endGuardrailPaint() { return this.endAccessoryPaint(); }
  cancelGuardrailPaint() { this.cancelAccessoryPaint(); }

  _buildAccessoryMesh(type, curve, side, startT, endT, isPreview = false) {
    switch (type) {
      case "guardrail": return this._buildGuardrailMesh(curve, side, startT, endT, isPreview);
      case "kerb": return this._buildKerbMesh(curve, side, startT, endT, isPreview);
      case "barrier": return this._buildBarrierMesh(curve, side, startT, endT, isPreview);
      case "fence": return this._buildFenceMesh(curve, side, startT, endT, isPreview);
      case "tunnel": return this._buildTunnelMesh(curve, startT, endT, isPreview);
      default: return null;
    }
  }

  _buildGuardrailMesh(curve, side, startT, endT, isPreview = false) {
    const p = this.toolState.fullRoad;
    const halfWidth = p.width * 0.5;
    const edgeOffset = p.guardrailEdgeOffset ?? 0.3;
    const lateralDist = halfWidth + edgeOffset;
    const sideSign = side === "left" ? 1 : -1;
    
    // Sample points along the road edge
    const tMin = Math.min(startT, endT);
    const tMax = Math.max(startT, endT);
    const segCount = Math.max(8, Math.ceil((tMax - tMin) * p.guardrailPathSegments));
    
    const edgePoints = [];
    for (let i = 0; i <= segCount; i++) {
      const t = tMin + (tMax - tMin) * (i / segCount);
      const pt = curve.getPointAt(t);
      const tangent = curve.getTangentAt(t);
      const perp = perpXZ(normalizeXZ(tangent));
      
      const groundY = this.getWorldHeight(
        pt.x + perp.x * lateralDist * sideSign,
        pt.z + perp.z * lateralDist * sideSign,
      );
      
      edgePoints.push(new THREE.Vector3(
        pt.x + perp.x * lateralDist * sideSign,
        groundY,
        pt.z + perp.z * lateralDist * sideSign,
      ));
    }
    
    if (edgePoints.length < 2) return null;
    
    const railCurve = new THREE.CatmullRomCurve3(edgePoints, false, "catmullrom", 0.5);
    
    // Build guardrail profile (W-beam shape)
    const height = p.guardrailHeight;
    const depth = p.guardrailDepth;
    const crown = p.guardrailCrownDepth;
    const profile = [
      { y: -0.5 * height, z: 0.5 },
      { y: -0.16 * height, z: 0.35 },
      { y: 0.0, z: -crown / Math.max(depth, 0.001) },
      { y: 0.16 * height, z: 0.35 },
      { y: 0.5 * height, z: 0.5 },
    ];
    
    const railGeo = this._buildGuardrailProfileGeometry(railCurve, segCount, profile, depth);
    const railMat = new THREE.MeshStandardMaterial({
      color: p.guardrailColor ?? "#9aa0a8",
      roughness: 0.45,
      metalness: 0.85,
      side: THREE.DoubleSide,
      transparent: isPreview,
      opacity: isPreview ? 0.6 : 1.0,
    });
    
    const group = new THREE.Group();
    const rail = new THREE.Mesh(railGeo, railMat);
    rail.position.y = p.guardrailRailYOffset;
    rail.castShadow = true;
    rail.receiveShadow = true;
    group.add(rail);
    
    // Add posts
    const postMat = new THREE.MeshStandardMaterial({
      color: p.guardrailColor ?? "#9aa0a8",
      roughness: 0.55,
      metalness: 0.7,
      transparent: isPreview,
      opacity: isPreview ? 0.6 : 1.0,
    });
    
    const length = railCurve.getLength();
    const postCount = Math.max(2, Math.floor(length / Math.max(0.5, p.guardrailPostSpacing)) + 1);
    
    for (let i = 0; i < postCount; i++) {
      const t = i / Math.max(1, postCount - 1);
      const pos = railCurve.getPointAt(t);
      const tangent = railCurve.getTangentAt(t);
      
      const groundY = this.getWorldHeight(pos.x, pos.z) - p.guardrailPostSink;
      const railBottomY = pos.y + p.guardrailRailYOffset - height * 0.5;
      const postHeight = Math.max(p.guardrailPostHeight, railBottomY - groundY + p.guardrailThickness * 0.5);
      
      const postGeo = new THREE.BoxGeometry(p.guardrailPostWidth, postHeight, p.guardrailPostDepth);
      const post = new THREE.Mesh(postGeo, postMat);
      post.position.set(pos.x, groundY + postHeight * 0.5, pos.z);
      post.rotation.y = Math.atan2(tangent.x, tangent.z);
      post.castShadow = true;
      post.receiveShadow = true;
      group.add(post);
    }
    
    return group;
  }

  _buildGuardrailProfileGeometry(curve, pathSegs, profile, depth) {
    const segs = Math.max(8, pathSegs | 0);
    const prof = Array.isArray(profile) && profile.length >= 2 ? profile : [
      { y: -0.5, z: 0.5 },
      { y: 0.5, z: 0.5 },
    ];
    const profLen = prof.length;
    const pts = curve.getSpacedPoints(segs);
    const totalVerts = (segs + 1) * profLen;
    const positions = new Float32Array(totalVerts * 3);
    const uvs = new Float32Array(totalVerts * 2);
    const tangent = new THREE.Vector3();
    const right = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    
    let vIdx = 0;
    let uvIdx = 0;
    let arcLen = 0;
    
    for (let i = 0; i <= segs; i++) {
      if (i > 0) arcLen += pts[i].distanceTo(pts[i - 1]);
      const t = i / segs;
      tangent.copy(curve.getTangentAt(Math.min(t, 1)));
      right.crossVectors(up, tangent).normalize();
      
      for (let j = 0; j < profLen; j++) {
        const pj = prof[j];
        const px = pts[i].x + right.x * pj.z * depth;
        const py = pts[i].y + pj.y;
        const pz = pts[i].z + right.z * pj.z * depth;
        positions[vIdx++] = px;
        positions[vIdx++] = py;
        positions[vIdx++] = pz;
        uvs[uvIdx++] = arcLen;
        uvs[uvIdx++] = j / (profLen - 1);
      }
    }
    
    const indices = [];
    for (let i = 0; i < segs; i++) {
      for (let j = 0; j < profLen - 1; j++) {
        const a = i * profLen + j;
        const b = a + profLen;
        const c = b + 1;
        const d = a + 1;
        indices.push(a, b, d);
        indices.push(b, c, d);
      }
    }
    
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    
    return geo;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // KERB MESH (Racing curbs - red/white stripes)
  // ─────────────────────────────────────────────────────────────────────────────

  _buildKerbMesh(curve, side, startT, endT, isPreview = false) {
    const p = this.toolState.fullRoad;
    const halfWidth = p.width * 0.5;
    const edgeOffset = p.kerbEdgeOffset ?? 0.0;
    const lateralDist = halfWidth + edgeOffset;
    const sideSign = side === "left" ? 1 : -1;
    const tMin = Math.min(startT, endT);
    const tMax = Math.max(startT, endT);
    return buildChunkedKerbGroup({
      curve,
      startT: tMin,
      endT: tMax,
      sideSign,
      lateralDist,
      kerbWidth: p.kerbWidth ?? 0.8,
      kerbHeight: p.kerbHeight ?? 0.12,
      lipHeight: p.kerbLipHeight ?? 0.03,
      squareSize: p.kerbStripeLength ?? 0.8,
      colorA: p.kerbColorA ?? "#cc2222",
      colorB: p.kerbColorB ?? "#f2f2f2",
      getWorldHeight: (x, z) => this.getWorldHeight(x, z),
      isPreview,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // CONCRETE BARRIER MESH (Jersey barriers)
  // ─────────────────────────────────────────────────────────────────────────────

  _buildBarrierMesh(curve, side, startT, endT, isPreview = false) {
    const p = this.toolState.fullRoad;
    const halfWidth = p.width * 0.5;
    const edgeOffset = p.barrierEdgeOffset ?? 0.5;
    const lateralDist = halfWidth + edgeOffset;
    const sideSign = side === "left" ? 1 : -1;
    
    const tMin = Math.min(startT, endT);
    const tMax = Math.max(startT, endT);
    const segCount = Math.max(16, Math.ceil((tMax - tMin) * 60));
    
    const height = p.barrierHeight ?? 0.85;
    const topWidth = p.barrierTopWidth ?? 0.15;
    const bottomWidth = p.barrierBottomWidth ?? 0.45;
    
    // Jersey barrier profile (trapezoidal with slight curves)
    const profile = [
      { y: 0, z: -bottomWidth * 0.5 },
      { y: height * 0.3, z: -bottomWidth * 0.35 },
      { y: height * 0.7, z: -topWidth * 0.6 },
      { y: height, z: -topWidth * 0.5 },
      { y: height, z: topWidth * 0.5 },
      { y: height * 0.7, z: topWidth * 0.6 },
      { y: height * 0.3, z: bottomWidth * 0.35 },
      { y: 0, z: bottomWidth * 0.5 },
    ];
    
    const edgePoints = [];
    for (let i = 0; i <= segCount; i++) {
      const t = tMin + (tMax - tMin) * (i / segCount);
      const pt = curve.getPointAt(t);
      const tangent = curve.getTangentAt(t);
      const perp = perpXZ(normalizeXZ(tangent));
      
      const groundY = this.getWorldHeight(
        pt.x + perp.x * lateralDist * sideSign,
        pt.z + perp.z * lateralDist * sideSign,
      );
      
      edgePoints.push(new THREE.Vector3(
        pt.x + perp.x * lateralDist * sideSign,
        groundY,
        pt.z + perp.z * lateralDist * sideSign,
      ));
    }
    
    if (edgePoints.length < 2) return null;
    
    const barrierCurve = new THREE.CatmullRomCurve3(edgePoints, false, "catmullrom", 0.5);
    const geo = this._buildGuardrailProfileGeometry(barrierCurve, segCount, profile, 1.0);
    
    const mat = new THREE.MeshStandardMaterial({
      color: p.barrierColor ?? "#7d7d7d",
      roughness: 0.85,
      metalness: 0.0,
      side: THREE.DoubleSide,
      transparent: isPreview,
      opacity: isPreview ? 0.6 : 1.0,
    });
    
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    
    const group = new THREE.Group();
    group.add(mesh);
    return group;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // FENCE MESH (Posts + horizontal rails)
  // ─────────────────────────────────────────────────────────────────────────────

  _buildFenceMesh(curve, side, startT, endT, isPreview = false) {
    const p = this.toolState.fullRoad;
    const halfWidth = p.width * 0.5;
    const edgeOffset = p.fenceEdgeOffset ?? 0.5;
    const lateralDist = halfWidth + edgeOffset;
    const sideSign = side === "left" ? 1 : -1;
    
    const tMin = Math.min(startT, endT);
    const tMax = Math.max(startT, endT);
    
    const fenceHeight = p.fenceHeight ?? 1.5;
    const postSpacing = p.fencePostSpacing ?? 2.5;
    const postWidth = p.fencePostWidth ?? 0.06;
    const postDepth = p.fencePostDepth ?? 0.04;
    const railCount = p.fenceRailCount ?? 3;
    const railThick = p.fenceRailThickness ?? 0.04;
    
    const edgePoints = [];
    const segCount = Math.max(16, Math.ceil((tMax - tMin) * 60));
    
    for (let i = 0; i <= segCount; i++) {
      const t = tMin + (tMax - tMin) * (i / segCount);
      const pt = curve.getPointAt(t);
      const tangent = curve.getTangentAt(t);
      const perp = perpXZ(normalizeXZ(tangent));
      
      const groundY = this.getWorldHeight(
        pt.x + perp.x * lateralDist * sideSign,
        pt.z + perp.z * lateralDist * sideSign,
      );
      
      edgePoints.push(new THREE.Vector3(
        pt.x + perp.x * lateralDist * sideSign,
        groundY,
        pt.z + perp.z * lateralDist * sideSign,
      ));
    }
    
    if (edgePoints.length < 2) return null;
    
    const fenceCurve = new THREE.CatmullRomCurve3(edgePoints, false, "catmullrom", 0.5);
    const length = fenceCurve.getLength();
    
    const mat = new THREE.MeshStandardMaterial({
      color: p.fenceColor ?? "#5a5a5a",
      roughness: 0.6,
      metalness: 0.3,
      transparent: isPreview,
      opacity: isPreview ? 0.6 : 1.0,
    });
    
    const group = new THREE.Group();
    
    // Posts
    const postCount = Math.max(2, Math.floor(length / postSpacing) + 1);
    for (let i = 0; i < postCount; i++) {
      const t = i / Math.max(1, postCount - 1);
      const pos = fenceCurve.getPointAt(t);
      const tangent = fenceCurve.getTangentAt(t);
      const groundY = this.getWorldHeight(pos.x, pos.z);
      
      const postGeo = new THREE.BoxGeometry(postWidth, fenceHeight, postDepth);
      const post = new THREE.Mesh(postGeo, mat);
      post.position.set(pos.x, groundY + fenceHeight * 0.5, pos.z);
      post.rotation.y = Math.atan2(tangent.x, tangent.z);
      post.castShadow = true;
      post.receiveShadow = true;
      group.add(post);
    }
    
    // Horizontal rails (using tube geometry for smooth curves)
    for (let r = 0; r < railCount; r++) {
      const railY = fenceHeight * (0.2 + 0.6 * r / Math.max(1, railCount - 1));
      const railPoints = [];
      
      for (let i = 0; i <= segCount; i++) {
        const t = i / segCount;
        const pos = fenceCurve.getPointAt(t);
        const groundY = this.getWorldHeight(pos.x, pos.z);
        railPoints.push(new THREE.Vector3(pos.x, groundY + railY, pos.z));
      }
      
      const railCurve = new THREE.CatmullRomCurve3(railPoints, false, "catmullrom", 0.5);
      const tubeGeo = new THREE.TubeGeometry(railCurve, segCount, railThick * 0.5, 6, false);
      const rail = new THREE.Mesh(tubeGeo, mat);
      rail.castShadow = true;
      rail.receiveShadow = true;
      group.add(rail);
    }
    
    return group;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // TUNNEL MESH (centerline tube)
  // ─────────────────────────────────────────────────────────────────────────────

  _buildTunnelMesh(curve, startT, endT, isPreview = false) {
    const p = this.toolState.fullRoad;
    const tMin = Math.min(startT, endT);
    const tMax = Math.max(startT, endT);
    const span = Math.max(0.001, tMax - tMin);
    const segCount = Math.max(16, Math.ceil(span * (p.tunnelPathSegments ?? 160)));
    const radius = Math.max(0.5, p.tunnelRadius ?? 6);
    const radialSegments = Math.max(6, p.tunnelRadialSegments | 0);
    const yOffset = p.tunnelYOffset ?? 0;

    const centerPoints = [];
    for (let i = 0; i <= segCount; i++) {
      const t = tMin + span * (i / segCount);
      const pt = curve.getPointAt(t);
      centerPoints.push(new THREE.Vector3(
        pt.x,
        pt.y + (p.heightOffset ?? 0) + yOffset,
        pt.z,
      ));
    }

    if (centerPoints.length < 2) return null;

    const tunnelCurve = new THREE.CatmullRomCurve3(centerPoints, false, "catmullrom", 0.5);
    const geo = new THREE.TubeGeometry(tunnelCurve, segCount, radius, radialSegments, false);
    const mat = new THREE.MeshStandardMaterial({
      color: p.tunnelColor ?? "#6c727a",
      roughness: 0.88,
      metalness: 0.04,
      side: THREE.DoubleSide,
      transparent: isPreview,
      opacity: isPreview ? 0.45 : 1.0,
    });

    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.renderOrder = 2;

    const group = new THREE.Group();
    group.add(mesh);

    // No separate collision geometry needed - car sweep fix allows entering tunnels now.
    // The visual mesh is used directly for BVH collision.

    return group;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // DELETE / CLEAR ACCESSORIES
  // ─────────────────────────────────────────────────────────────────────────────

  deleteAccessory(id, type = null) {
    const arrays = type 
      ? [this._getAccessoryArray(type)]
      : [this.guardrails, this.kerbs, this.barriers, this.fences, this.tunnels];
    
    for (const arr of arrays) {
      const idx = arr.findIndex(g => g.id === id);
      if (idx >= 0) {
        arr.splice(idx, 1);
        this.rebuildAllAccessories();
        return true;
      }
    }
    return false;
  }

  clearAllAccessories(type = null) {
    if (type) {
      this._getAccessoryArray(type).length = 0;
    } else {
      this.guardrails.length = 0;
      this.kerbs.length = 0;
      this.barriers.length = 0;
      this.fences.length = 0;
      this.tunnels.length = 0;
    }
    this._paintingAccessory = null;
    this.rebuildAllAccessories();
  }

  // Backwards compatibility
  deleteGuardrail(id) { return this.deleteAccessory(id, "guardrail"); }
  clearAllGuardrails() { this.clearAllAccessories("guardrail"); }

  // ─────────────────────────────────────────────────────────────────────────────
  // ROAD DECALS SYSTEM
  // ─────────────────────────────────────────────────────────────────────────────

  _findRoadSurfacePoint(pos) {
    const paths = this._buildRoadPaths();
    const p = this.toolState.fullRoad;
    const halfWidth = p.width * 0.5;
    
    let best = null;
    
    for (let pathIdx = 0; pathIdx < paths.length; pathIdx++) {
      const path = paths[pathIdx];
      const curve = this._curveForPath(path);
      if (!curve) continue;
      
      const samples = Math.max(64, path.nodeIds.length * 32);
      const pts = curve.getSpacedPoints(samples);
      
      for (let i = 0; i < pts.length; i++) {
        const t = i / (pts.length - 1);
        const pt = pts[i];
        const dx = pos.x - pt.x;
        const dz = pos.z - pt.z;
        const distSq = dx * dx + dz * dz;
        
        // Check if within road width
        if (distSq < halfWidth * halfWidth && (!best || distSq < best.distSq)) {
          const tangent = curve.getTangentAt(t);
          const rotation = Math.atan2(tangent.x, tangent.z);
          best = {
            distSq,
            pathIdx,
            t,
            x: pt.x,
            y: pt.y + p.heightOffset + 0.05,
            z: pt.z,
            rotation,
          };
        }
      }
    }
    
    return best;
  }

  updateDecalPreview(pos) {
    this._clearDecalPreview();
    
    const p = this.toolState.fullRoad;
    const hit = this._findRoadSurfacePoint(pos);
    
    // Use road surface point if found, otherwise fallback to terrain click position
    const x = hit ? hit.x : pos.x;
    const y = hit ? hit.y : pos.y + p.heightOffset + 0.05;
    const z = hit ? hit.z : pos.z;
    const rotation = p.decalSnapToRoad && hit 
      ? hit.rotation 
      : p.decalRotation * Math.PI / 180;
    
    const mesh = this._createDecalMesh(
      p.decalType,
      x, y, z,
      rotation,
      p.decalWidth,
      p.decalLength,
      p.decalColor,
      p.decalStripeCount,
      true
    );
    
    if (mesh) {
      mesh.name = "DecalPreview";
      this.decalGroup.add(mesh);
      this._decalPreview = mesh;
    }
  }

  _clearDecalPreview() {
    if (this._decalPreview) {
      this.decalGroup.remove(this._decalPreview);
      if (this._decalPreview.geometry) this._decalPreview.geometry.dispose();
      if (this._decalPreview.material) this._decalPreview.material.dispose();
      this._decalPreview = null;
    }
  }

  placeDecal(pos) {
    const p = this.toolState.fullRoad;
    const hit = this._findRoadSurfacePoint(pos);
    
    // Use road surface point if found, otherwise fallback to terrain click position
    const x = hit ? hit.x : pos.x;
    const y = hit ? hit.y : pos.y + p.heightOffset + 0.05;
    const z = hit ? hit.z : pos.z;
    const rotation = p.decalSnapToRoad && hit 
      ? hit.rotation 
      : p.decalRotation * Math.PI / 180;
    
    const decal = {
      id: this._nextDecalId++,
      type: p.decalType,
      x, y, z,
      rotation,
      width: p.decalWidth,
      length: p.decalLength,
      color: p.decalColor,
      stripeCount: p.decalStripeCount,
    };
    
    this.decals.push(decal);
    this._clearDecalPreview();
    this.rebuildAllDecals();
    
    return decal;
  }

  deleteDecal(id) {
    const idx = this.decals.findIndex(d => d.id === id);
    if (idx < 0) return false;
    this.decals.splice(idx, 1);
    this.rebuildAllDecals();
    return true;
  }

  clearAllDecals() {
    this.decals.length = 0;
    this._clearDecalPreview();
    this.rebuildAllDecals();
  }

  rebuildAllDecals() {
    // Clear existing decals (except preview)
    const toRemove = this.decalGroup.children.filter(c => c.name !== "DecalPreview");
    for (const child of toRemove) {
      this.decalGroup.remove(child);
      if (child.geometry) child.geometry.dispose();
      if (child.material) child.material.dispose();
    }
    
    // Rebuild all decals
    for (const decal of this.decals) {
      const mesh = this._createDecalMesh(
        decal.type,
        decal.x,
        decal.y,
        decal.z,
        decal.rotation,
        decal.width,
        decal.length,
        decal.color,
        decal.stripeCount,
        false
      );
      
      if (mesh) {
        mesh.userData.decalId = decal.id;
        this.decalGroup.add(mesh);
      }
    }
  }

  _createDecalMesh(type, x, y, z, rotation, width, length, color, stripeCount, isPreview) {
    const material = createDecalMaterial(type, { color, stripeCount }, isPreview);
    
    const geometry = new THREE.PlaneGeometry(width, length);
    const mesh = new THREE.Mesh(geometry, material);
    
    // Position slightly above the road surface to avoid z-fighting
    mesh.position.set(x, y + 0.02, z);
    mesh.rotation.x = -Math.PI / 2; // Lay flat
    mesh.rotation.z = rotation;
    mesh.renderOrder = 15; // Higher than road (10)
    
    return mesh;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // DECAL SELECTION & TRANSFORM
  // ─────────────────────────────────────────────────────────────────────────────

  pickDecal(raycaster) {
    const meshes = this.decalGroup.children.filter(c => c.name !== "DecalPreview" && c.isMesh);
    const hits = raycaster.intersectObjects(meshes, false);
    if (hits.length > 0) {
      const decalId = hits[0].object.userData.decalId;
      return this.decals.find(d => d.id === decalId) || null;
    }
    return null;
  }

  _findDecalMesh(decalId) {
    return this.decalGroup.children.find(c => c.userData.decalId === decalId);
  }

  selectDecal(decalId) {
    const decal = this.decals.find(d => d.id === decalId);
    if (!decal) return false;

    this.selectedDecalId = decalId;
    this._selectedDecalMesh = this._findDecalMesh(decalId);
    
    if (!this._selectedDecalMesh) return false;
    
    // Attach transform controls directly to the mesh
    if (this.transformControls) {
      this.transformControls.attach(this._selectedDecalMesh);
      this.transformControls.setMode(this.toolState.fullRoad.decalTransformMode || "translate");
      this.transformControls.enabled = true;
      this.transformControls.visible = true;
    }
    
    return true;
  }

  deselectDecal() {
    this.selectedDecalId = null;
    this._selectedDecalMesh = null;
    if (this.transformControls) {
      this.transformControls.detach();
      this.transformControls.enabled = false;
      this.transformControls.visible = false;
    }
  }

  handleDecalTransformChange() {
    // Nothing needed during drag - mesh is directly attached to controls
  }

  handleDecalTransformEnd() {
    if (this.selectedDecalId == null || !this._selectedDecalMesh) return;
    
    const decal = this.decals.find(d => d.id === this.selectedDecalId);
    if (!decal) return;
    
    // Save final position from mesh to data
    decal.x = this._selectedDecalMesh.position.x;
    decal.y = this._selectedDecalMesh.position.y - 0.02; // Remove render offset
    decal.z = this._selectedDecalMesh.position.z;
    decal.rotation = this._selectedDecalMesh.rotation.z;
  }

  deleteSelectedDecal() {
    if (this.selectedDecalId == null) return false;
    const success = this.deleteDecal(this.selectedDecalId);
    if (success) {
      this.deselectDecal();
    }
    return success;
  }

  setTransformControls(tc) {
    this.transformControls = tc;
  }

  exportData() {
    const serializeAccessories = (arr) => arr.map(a => ({
      id: a.id,
      type: a.type,
      pathIdx: a.pathIdx,
      side: a.side,
      startT: a.startT,
      endT: a.endT,
    }));
    
    return {
      nodes: this.nodes.map(n => ({
        id: n.id,
        x: n.position.x,
        y: n.position.y,
        z: n.position.z,
        forceJunction: !!n.forceJunction,
      })),
      edges: this.edges.map((e) => {
        const row = { id: e.id, a: e.a, b: e.b };
        if (e.style && Object.keys(e.style).length) row.style = { ...e.style };
        return row;
      }),
      guardrails: serializeAccessories(this.guardrails),
      kerbs: serializeAccessories(this.kerbs),
      barriers: serializeAccessories(this.barriers),
      fences: serializeAccessories(this.fences),
      tunnels: serializeAccessories(this.tunnels),
      decals: this.decals.map(d => ({
        id: d.id,
        type: d.type,
        x: d.x,
        y: d.y,
        z: d.z,
        rotation: d.rotation,
        width: d.width,
        length: d.length,
        color: d.color,
        stripeCount: d.stripeCount,
      })),
      selectedNodeId: this.selectedNodeId,
      selectedEdgeId: this.selectedEdgeId,
      nextNodeId: this._nextNodeId,
      nextEdgeId: this._nextEdgeId,
      nextAccessoryId: this._nextAccessoryId,
      nextDecalId: this._nextDecalId,
    };
  }

  importData(data) {
    const parseAccessories = (arr) => Array.isArray(arr)
      ? arr.map(a => ({
        id: Number(a.id),
        type: a.type,
        pathIdx: Number(a.pathIdx),
        side: a.side,
        startT: Number(a.startT),
        endT: Number(a.endT),
      })).filter(a => Number.isFinite(a.id) && Number.isFinite(a.pathIdx))
      : [];
    
    this.nodes = Array.isArray(data?.nodes)
      ? data.nodes.map(n => ({
        id: Number(n.id),
        position: cloneVec3Like(n),
        forceJunction: !!n.forceJunction,
      })).filter(n => Number.isFinite(n.id))
      : [];
    const nodeIds = new Set(this.nodes.map(n => n.id));
    this.edges = Array.isArray(data?.edges)
      ? data.edges
        .map((e) => {
          const edge = { id: Number(e.id), a: Number(e.a), b: Number(e.b) };
          const st = normalizeImportedEdgeStyle(e.style);
          if (st) edge.style = st;
          return edge;
        })
        .filter(e => Number.isFinite(e.id) && nodeIds.has(e.a) && nodeIds.has(e.b) && e.a !== e.b)
      : [];
    
    this.guardrails = parseAccessories(data?.guardrails);
    this.kerbs = parseAccessories(data?.kerbs);
    this.barriers = parseAccessories(data?.barriers);
    this.fences = parseAccessories(data?.fences);
    this.tunnels = parseAccessories(data?.tunnels);
    
    this.selectedNodeId = nodeIds.has(data?.selectedNodeId) ? data.selectedNodeId : null;
    const se = data?.selectedEdgeId;
    this.selectedEdgeId =
      se != null && Number.isFinite(Number(se)) && this.edges.some((e) => e.id === Number(se))
        ? Number(se)
        : null;
    this._nextNodeId = Math.max(data?.nextNodeId ?? 1, Math.max(0, ...this.nodes.map(n => n.id)) + 1);
    this._nextEdgeId = Math.max(data?.nextEdgeId ?? 1, Math.max(0, ...this.edges.map(e => e.id)) + 1);
    
    const allAccessoryIds = [
      ...this.guardrails, ...this.kerbs, ...this.barriers, ...this.fences, ...this.tunnels
    ].map(a => a.id);
    this._nextAccessoryId = Math.max(data?.nextAccessoryId ?? 1, Math.max(0, ...allAccessoryIds) + 1);
    
    // Import decals
    this.decals = Array.isArray(data?.decals)
      ? data.decals.map(d => ({
        id: Number(d.id),
        type: d.type,
        x: Number(d.x),
        y: Number(d.y),
        z: Number(d.z),
        rotation: Number(d.rotation),
        width: Number(d.width),
        length: Number(d.length),
        color: d.color,
        stripeCount: Number(d.stripeCount),
      })).filter(d => Number.isFinite(d.id))
      : [];
    this._nextDecalId = Math.max(data?.nextDecalId ?? 1, Math.max(0, ...this.decals.map(d => d.id)) + 1);
    
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this._rebuildVisual();
    this._updateSelectedY();
  }

  /**
   * BVH integration hook — mirrors SplineSystem so the manual "Rebake BVH"
   * button can include collidable Full Road accessories.
   */
  forEachMeshInstance(cb) {
    const collidableTypes = new Set(["guardrail", "barrier", "fence", "tunnel"]);

    for (const child of this.accessoryGroup.children) {
      const accessoryType = child.userData?.accessoryType;
      if (!collidableTypes.has(accessoryType)) continue;

      child.updateMatrixWorld(true);
      child.traverse((obj) => {
        if (!obj.isMesh || !obj.geometry) return;
        cb(obj.geometry, obj.matrixWorld);
      });
    }
  }

  dispose() {
    this._clearGroup(this.meshGroup);
    this._clearGroup(this.handleGroup);
    this._clearAccessoryGroup();
    this._clearDecalGroup();
    this.scene.remove(this.meshGroup);
    this.scene.remove(this.handleGroup);
    this.scene.remove(this.accessoryGroup);
    this.scene.remove(this.decalGroup);
    this.scene.remove(this._decalProxy);
    if (this._roadMat) this._roadMat.dispose();
    if (this._junctionMat) this._junctionMat.dispose();
    this._labDisposePbrMats();
    this._lineMat.dispose();
    this._junctionLineMat.dispose();
    this._junctionCenterLineMat.dispose();
  }

  _clearDecalGroup() {
    while (this.decalGroup.children.length) {
      const child = this.decalGroup.children[0];
      this.decalGroup.remove(child);
      if (child.geometry) child.geometry.dispose();
      if (child.material) child.material.dispose();
    }
  }

  _clearAccessoryGroup() {
    while (this.accessoryGroup.children.length) {
      const child = this.accessoryGroup.children[0];
      this.accessoryGroup.remove(child);
      if (child.traverse) {
        child.traverse(obj => {
          if (obj.geometry) obj.geometry.dispose();
          if (obj.material) obj.material.dispose();
        });
      }
    }
  }
}
