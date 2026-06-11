import * as THREE from "three";
import { generateRoadGeometry } from "../../core/road/roadMesh.js";
import { createRoadUniforms, createRoadMaterial, syncRoadUniforms } from "../../core/road/roadMaterial.js";

const DIFFUSE_TEX_PATH = "../textures/pbr_materials/asphalt_track/asphalt_track_diff_2k.jpg";
const ARM_TEX_PATH = "../textures/pbr_materials/asphalt_track/asphalt_track_arm_2k.jpg";
const NORMAL_TEX_PATH = "../textures/pbr_materials/asphalt_track/asphalt_track_nor_gl_2k.jpg";

const SNAP_THRESHOLD = 3.0;

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
  "lodNear", "lodMid", "lodFar", "texScale",
];

function extractStyle(rp) {
  const s = {};
  for (const k of STYLE_KEYS) s[k] = rp[k];
  return s;
}

function applyStyle(rp, style) {
  for (const k of STYLE_KEYS) {
    if (k in style) rp[k] = style[k];
  }
}

function mergeStyleWithDefaults(style, rp) {
  const merged = extractStyle(rp);
  if (style) {
    for (const k of STYLE_KEYS) {
      if (k in style) merged[k] = style[k];
    }
  }
  if (merged.centerLeftColor == null) merged.centerLeftColor = merged.centerLineColor;
  if (merged.centerRightColor == null) merged.centerRightColor = merged.centerLineColor;
  return merged;
}

function normalizeStyleSpans(rawSpans, fallbackStyle, rp) {
  const source = Array.isArray(rawSpans) && rawSpans.length > 0
    ? rawSpans
    : [{ start: 0, style: fallbackStyle }];
  const spans = source
    .map((span) => ({
      start: Math.max(0, Math.min(1, Number(span.start) || 0)),
      style: mergeStyleWithDefaults(span.style ?? fallbackStyle, rp),
      mesh: null,
      uniforms: null,
      mat: null,
    }))
    .sort((a, b) => a.start - b.start);
  spans[0].start = 0;
  const deduped = [];
  for (const span of spans) {
    const prev = deduped[deduped.length - 1];
    if (prev && Math.abs(prev.start - span.start) < 1e-4) {
      prev.style = span.style;
    } else {
      deduped.push(span);
    }
  }
  return deduped;
}

export class RoadSystem {
  constructor({ scene, camera, toolState, getWorldHeight, reflectTex, terrainStore, chunkStream }) {
    this.scene = scene;
    this.camera = camera;
    this.toolState = toolState;
    this.getWorldHeight = getWorldHeight;
    this._reflectTex = reflectTex ?? null;
    this.terrainStore = terrainStore ?? null;
    this.chunkStream = chunkStream ?? null;

    this.segments = [];
    this.selectedIdx = -1;
    this.dragging = false;

    this.handleGroup = new THREE.Group();
    this.handleGroup.name = "RoadHandles";
    scene.add(this.handleGroup);
    this.handleMeshes = [];

    this._diffuseTex = null;
    this._armTex = null;
    this._normalTex = null;
    this._matReady = false;
    this._loadTextures();

    this.undoStack = [];
    this.redoStack = [];
  }

  _loadTextures() {
    const loader = new THREE.TextureLoader();
    let loaded = 0;
    const total = 3;
    const onLoaded = () => {
      loaded++;
      if (loaded >= total) {
        this._matReady = true;
        for (const seg of this.segments) {
          for (const span of seg.styleSpans ?? []) this._rebuildSpanMaterial(span);
        }
        this._rebuildVisual();
      }
    };
    loader.load(DIFFUSE_TEX_PATH, (tex) => {
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      this._diffuseTex = tex;
      onLoaded();
    }, undefined, () => onLoaded());
    loader.load(ARM_TEX_PATH, (tex) => {
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      this._armTex = tex;
      onLoaded();
    }, undefined, () => onLoaded());
    loader.load(NORMAL_TEX_PATH, (tex) => {
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      this._normalTex = tex;
      onLoaded();
    }, undefined, () => onLoaded());
  }

  _createSegMaterial(style) {
    const params = { ...this.toolState.road, ...style };
    const uniforms = createRoadUniforms(params);
    const mat = createRoadMaterial(uniforms, this._diffuseTex, this._armTex, this._normalTex, this._reflectTex);
    return { uniforms, mat };
  }

  _rebuildSpanMaterial(span) {
    if (span.mat) span.mat.dispose();
    const { uniforms, mat } = this._createSegMaterial(span.style);
    span.uniforms = uniforms;
    span.mat = mat;
  }

  _createSegment(style) {
    const styleSpans = normalizeStyleSpans(null, style, this.toolState.road);
    for (const span of styleSpans) this._rebuildSpanMaterial(span);
    return { points: [], meshes: [], styleSpans };
  }

  _activeIdx() {
    if (this.segments.length === 0) return -1;
    return Math.max(0, Math.min(this.toolState.road.activeRoadIndex | 0, this.segments.length - 1));
  }

  _clampActive() {
    if (this.segments.length === 0) {
      this.toolState.road.activeRoadIndex = 0;
      return;
    }
    this.toolState.road.activeRoadIndex = Math.max(0, Math.min(this.toolState.road.activeRoadIndex | 0, this.segments.length - 1));
  }

  _clampActiveStyleSection() {
    const seg = this.segments[this._activeIdx()];
    const count = seg?.styleSpans?.length ?? 0;
    if (count === 0) {
      this.toolState.road.activeStyleSectionIndex = 0;
      return;
    }
    this.toolState.road.activeStyleSectionIndex = Math.max(
      0,
      Math.min(this.toolState.road.activeStyleSectionIndex | 0, count - 1),
    );
  }

  _activeStyleSpan() {
    const seg = this.segments[this._activeIdx()];
    if (!seg) return null;
    this._clampActiveStyleSection();
    return seg.styleSpans[this.toolState.road.activeStyleSectionIndex | 0] ?? null;
  }

  _pushUndo() {
    this.undoStack.push(this._snapshot());
    this.redoStack.length = 0;
    if (this.undoStack.length > 40) this.undoStack.shift();
  }

  _snapshot() {
    return {
      segments: this.segments.map(s => ({
        points: s.points.map(p => ({ x: p.x, y: p.y, z: p.z })),
        styleSpans: (s.styleSpans ?? []).map(span => ({
          start: span.start,
          style: { ...span.style },
        })),
      })),
      activeRoadIndex: this.toolState.road.activeRoadIndex,
      activeStyleSectionIndex: this.toolState.road.activeStyleSectionIndex,
      selectedIdx: this.selectedIdx,
    };
  }

  _restore(snap) {
    this._disposeAllFull();
    this.segments = snap.segments.map(s => {
      const fallbackStyle = mergeStyleWithDefaults(s.style, this.toolState.road);
      const styleSpans = normalizeStyleSpans(s.styleSpans, fallbackStyle, this.toolState.road);
      for (const span of styleSpans) this._rebuildSpanMaterial(span);
      return {
        points: s.points.map(p => new THREE.Vector3(p.x, p.y, p.z)),
        meshes: [],
        styleSpans,
      };
    });
    this.toolState.road.activeRoadIndex = snap.activeRoadIndex;
    this.toolState.road.activeStyleSectionIndex = snap.activeStyleSectionIndex ?? 0;
    this.selectedIdx = snap.selectedIdx;
    this._clampActive();
    this._clampActiveStyleSection();
    this._rebuildVisual();
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

  _findNearestEndpoint(pos, excludeIdx) {
    let bestDist = SNAP_THRESHOLD;
    let bestPoint = null;
    for (let i = 0; i < this.segments.length; i++) {
      if (i === excludeIdx) continue;
      const pts = this.segments[i].points;
      if (pts.length === 0) continue;
      const first = pts[0];
      const last = pts[pts.length - 1];
      const d0 = Math.hypot(pos.x - first.x, pos.z - first.z);
      if (d0 < bestDist) { bestDist = d0; bestPoint = first; }
      const d1 = Math.hypot(pos.x - last.x, pos.z - last.z);
      if (d1 < bestDist) { bestDist = d1; bestPoint = last; }
    }
    return bestPoint;
  }

  addPoint(pos) {
    this._pushUndo();
    if (this.segments.length === 0) {
      this.segments.push(this._createSegment(extractStyle(this.toolState.road)));
      this.toolState.road.activeRoadIndex = 0;
    }
    this._clampActive();
    const ai = this._activeIdx();
    const pts = this.segments[ai].points;

    const snap = this._findNearestEndpoint(pos, ai);
    const finalPos = snap ? snap.clone() : pos.clone();

    pts.push(finalPos);
    this.selectedIdx = pts.length - 1;
    this._rebuildVisual();
    this._updateSelectedY();
  }

  deleteSelected() {
    const ai = this._activeIdx();
    if (ai < 0 || this.selectedIdx < 0) return;
    const pts = this.segments[ai].points;
    if (this.selectedIdx >= pts.length) return;
    this._pushUndo();
    pts.splice(this.selectedIdx, 1);
    this.selectedIdx = Math.min(this.selectedIdx, pts.length - 1);
    this._rebuildVisual();
    this._updateSelectedY();
  }

  moveSelected(pos) {
    const ai = this._activeIdx();
    if (ai < 0 || this.selectedIdx < 0) return;
    const pts = this.segments[ai].points;
    if (this.selectedIdx >= pts.length) return;
    const currentY = pts[this.selectedIdx].y;
    pts[this.selectedIdx].copy(pos);
    pts[this.selectedIdx].y = currentY;
    this._rebuildVisual();
  }

  snapSelectedYToTerrain() {
    const ai = this._activeIdx();
    if (ai < 0 || this.selectedIdx < 0) return;
    const pts = this.segments[ai].points;
    if (this.selectedIdx >= pts.length) return;
    this._pushUndo();
    const p = pts[this.selectedIdx];
    p.y = this.getWorldHeight(p.x, p.z);
    this._rebuildVisual();
    this._updateSelectedY();
  }

  startNewRoad() {
    this._pushUndo();
    this.segments.push(this._createSegment(extractStyle(this.toolState.road)));
    this.toolState.road.activeRoadIndex = this.segments.length - 1;
    this.toolState.road.activeStyleSectionIndex = 0;
    this.selectedIdx = -1;
    this._rebuildVisual();
  }

  deleteActiveRoad() {
    const ai = this._activeIdx();
    if (ai < 0) return;
    this._pushUndo();
    this._disposeSegFull(this.segments[ai]);
    this.segments.splice(ai, 1);
    this.selectedIdx = -1;
    this.dragging = false;
    this._clampActive();
    this._clampActiveStyleSection();
    if (this.segments.length > 0) this.loadActiveStyle();
    this._rebuildVisual();
  }

  pickPoint(raycaster) {
    const spheres = this.handleMeshes.filter(m => m.isMesh);
    if (spheres.length === 0) return -1;
    const hits = raycaster.intersectObjects(spheres, false);
    if (hits.length === 0) return -1;
    return this.handleMeshes.indexOf(hits[0].object);
  }

  saveActiveStyle() {
    const span = this._activeStyleSpan();
    if (!span) return;
    const rp = this.toolState.road;
    for (const k of STYLE_KEYS) span.style[k] = rp[k];
  }

  loadActiveStyle() {
    const span = this._activeStyleSpan();
    if (!span) return;
    applyStyle(this.toolState.road, span.style);
  }

  syncMaterial() {
    const span = this._activeStyleSpan();
    if (!span?.uniforms) return;
    syncRoadUniforms(span.uniforms, this.toolState.road);
    span.mat.needsUpdate = true;
  }

  _selectedPointStart01() {
    const ai = this._activeIdx();
    if (ai < 0 || this.selectedIdx < 0) return null;
    const pts = this.segments[ai].points;
    if (this.selectedIdx <= 0 || this.selectedIdx >= pts.length) return this.selectedIdx <= 0 ? 0 : 1;
    let total = 0;
    let before = 0;
    for (let i = 1; i < pts.length; i++) {
      const d = pts[i].distanceTo(pts[i - 1]);
      total += d;
      if (i <= this.selectedIdx) before += d;
    }
    if (total <= 1e-6) return 0;
    return Math.max(0, Math.min(1, before / total));
  }

  createStyleSectionAtSelected() {
    const ai = this._activeIdx();
    const start = this._selectedPointStart01();
    if (ai < 0 || start == null || start <= 1e-4 || start >= 0.9999) return;
    this._pushUndo();
    const seg = this.segments[ai];
    const styleSpans = normalizeStyleSpans(seg.styleSpans, extractStyle(this.toolState.road), this.toolState.road);
    let insertIdx = styleSpans.findIndex(span => Math.abs(span.start - start) < 1e-4);
    if (insertIdx >= 0) {
      styleSpans[insertIdx].style = extractStyle(this.toolState.road);
    } else {
      styleSpans.push({
        start,
        style: extractStyle(this.toolState.road),
        mesh: null,
        uniforms: null,
        mat: null,
      });
      styleSpans.sort((a, b) => a.start - b.start);
      insertIdx = styleSpans.findIndex(span => Math.abs(span.start - start) < 1e-4);
    }
    for (const span of seg.styleSpans ?? []) this._disposeSpanFull(span);
    seg.styleSpans = styleSpans;
    for (const span of seg.styleSpans) this._rebuildSpanMaterial(span);
    this.toolState.road.activeStyleSectionIndex = Math.max(0, insertIdx);
    this.loadActiveStyle();
    this._rebuildVisual();
  }

  deleteActiveStyleSection() {
    const ai = this._activeIdx();
    if (ai < 0) return;
    const seg = this.segments[ai];
    if (!seg.styleSpans || seg.styleSpans.length <= 1) return;
    this._pushUndo();
    this._clampActiveStyleSection();
    const idx = this.toolState.road.activeStyleSectionIndex | 0;
    const [removed] = seg.styleSpans.splice(idx, 1);
    this._disposeSpanFull(removed);
    if (idx === 0) seg.styleSpans[0].start = 0;
    this._clampActiveStyleSection();
    this.loadActiveStyle();
    this._rebuildVisual();
  }

  flattenTerrainUnderRoads() {
    if (!this.terrainStore || !this.chunkStream) return;
    const rp = this.toolState.road;
    const dirtyChunks = new Map();
    for (const seg of this.segments) {
      if (seg.points.length < 2) continue;
      const curve = new THREE.CatmullRomCurve3(seg.points, !!rp.closed, "catmullrom", 0.5);
      this.terrainStore.flattenUnderRoad(curve, rp.width, rp.segments, rp.heightOffset, dirtyChunks);
    }
    if (dirtyChunks.size > 0) {
      this.chunkStream.markDirtyRects(dirtyChunks);
    }
  }

  rebuildAllMeshes() {
    const rp = this.toolState.road;

    // Build extended point arrays: inject one neighbor control point at each
    // shared endpoint so both curves have matching tangents and overlap slightly.
    const extPoints = [];
    for (let i = 0; i < this.segments.length; i++) {
      const seg = this.segments[i];
      this._disposeSegMesh(seg);
      if (seg.points.length < 2) { extPoints.push(null); continue; }

      const pts = [...seg.points];
      const first = pts[0];
      const last = pts[pts.length - 1];

      for (let j = 0; j < this.segments.length; j++) {
        if (j === i) continue;
        const oP = this.segments[j].points;
        if (oP.length < 2) continue;
        if (first.distanceToSquared(oP[oP.length - 1]) < _EPS2) { pts.unshift(oP[oP.length - 2]); break; }
        if (first.distanceToSquared(oP[0]) < _EPS2) { pts.unshift(oP[1]); break; }
      }
      for (let j = 0; j < this.segments.length; j++) {
        if (j === i) continue;
        const oP = this.segments[j].points;
        if (oP.length < 2) continue;
        if (last.distanceToSquared(oP[0]) < _EPS2) { pts.push(oP[1]); break; }
        if (last.distanceToSquared(oP[oP.length - 1]) < _EPS2) { pts.push(oP[oP.length - 2]); break; }
      }

      extPoints.push(pts);
    }

    const curves = extPoints.map(pts =>
      pts ? new THREE.CatmullRomCurve3(pts, !!rp.closed, "catmullrom", 0.5) : null,
    );

    for (let i = 0; i < this.segments.length; i++) {
      const seg = this.segments[i];
      const curve = curves[i];
      if (!curve) continue;
      const totalLen = Math.max(1e-6, curve.getLength());
      const otherCurves = [];
      const ptsI = this.segments[i].points;
      for (let j = 0; j < curves.length; j++) {
        if (j === i || !curves[j]) continue;
        const ptsJ = this.segments[j].points;
        if (_sharesEndpoint(ptsI, ptsJ)) continue;
        otherCurves.push({ curve: curves[j], segments: rp.segments });
      }
      if (!seg.styleSpans || seg.styleSpans.length === 0) {
        seg.styleSpans = normalizeStyleSpans(null, extractStyle(this.toolState.road), this.toolState.road);
      }
      seg.styleSpans.sort((a, b) => a.start - b.start);
      seg.styleSpans[0].start = 0;
      const spans = seg.styleSpans;
      seg.meshes = [];
      for (let si = 0; si < spans.length; si++) {
        const span = spans[si];
        if (!span.mat) this._rebuildSpanMaterial(span);
        const startT = Math.max(0, Math.min(1, span.start));
        const endT = Math.max(startT, Math.min(1, spans[si + 1]?.start ?? 1));
        if (endT - startT < 1e-4) continue;
        const spanSegments = Math.max(4, Math.round(rp.segments * (endT - startT)));
        const geo = generateRoadGeometry(
          curve,
          rp.width,
          spanSegments,
          rp.heightOffset,
          this.getWorldHeight,
          otherCurves,
          {
            adaptiveLift: rp.adaptiveLift,
            slopeLift: rp.slopeLift,
            liftMax: rp.liftMax,
            startT,
            endT,
            arcOffset: totalLen * startT,
          },
        );
        span.mesh = new THREE.Mesh(geo, span.mat);
        span.mesh.receiveShadow = true;
        span.mesh.renderOrder = 3;
        seg.meshes.push(span.mesh);
        this.scene.add(span.mesh);
      }
    }
  }

  _rebuildHandles() {
    while (this.handleGroup.children.length) {
      const child = this.handleGroup.children[0];
      this.handleGroup.remove(child);
      if (child.geometry) child.geometry.dispose();
      if (child.material) child.material.dispose();
    }
    this.handleMeshes = [];

    const ai = this._activeIdx();
    if (ai < 0) {
      this._syncHandlesVisibility();
      return;
    }
    const pts = this.segments[ai].points;

    // Show snap-target indicators on other roads' endpoints (visual only, not pickable)
    for (let i = 0; i < this.segments.length; i++) {
      if (i === ai) continue;
      const oPts = this.segments[i].points;
      if (oPts.length === 0) continue;
      for (const ep of [oPts[0], oPts[oPts.length - 1]]) {
        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(SNAP_THRESHOLD * 0.5, 0.08, 6, 16),
          new THREE.MeshBasicMaterial({ color: 0x44ff88, transparent: true, opacity: 0.5 }),
        );
        ring.position.copy(ep);
        ring.rotation.x = Math.PI / 2;
        ring.raycast = () => {};
        this.handleGroup.add(ring);
      }
    }

    for (let i = 0; i < pts.length; i++) {
      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(0.5, 8, 8),
        new THREE.MeshBasicMaterial({ color: i === this.selectedIdx ? 0xffff00 : 0x886644 }),
      );
      sphere.position.copy(pts[i]);
      this.handleGroup.add(sphere);
      this.handleMeshes.push(sphere);
    }

    if (pts.length >= 2) {
      const curve = new THREE.CatmullRomCurve3(pts, !!this.toolState.road.closed, "catmullrom", 0.5);
      const lineGeo = new THREE.BufferGeometry().setFromPoints(curve.getPoints(60));
      const line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: 0xaa7744 }));
      this.handleGroup.add(line);
      this.handleMeshes.push(line);
    }

    this._syncHandlesVisibility();
  }

  _syncHandlesVisibility() {
    this.handleGroup.visible = this.toolState.mode === "road" && this.toolState.road.showHandles;
  }

  _rebuildVisual() {
    this.rebuildAllMeshes();
    this._rebuildHandles();
  }

  _disposeSegMesh(seg) {
    for (const span of seg.styleSpans ?? []) {
      if (span.mesh) {
        this.scene.remove(span.mesh);
        span.mesh.geometry.dispose();
        span.mesh = null;
      }
    }
    seg.meshes = [];
  }

  _disposeSegFull(seg) {
    this._disposeSegMesh(seg);
    for (const span of seg.styleSpans ?? []) this._disposeSpanFull(span);
  }

  _disposeSpanFull(span) {
    if (!span) return;
    if (span.mesh) {
      this.scene.remove(span.mesh);
      span.mesh.geometry.dispose();
      span.mesh = null;
    }
    if (span.mat) {
      span.mat.dispose();
      span.mat = null;
    }
    span.uniforms = null;
  }

  _disposeAllMeshes() {
    for (const seg of this.segments) this._disposeSegMesh(seg);
  }

  _disposeAllFull() {
    for (const seg of this.segments) this._disposeSegFull(seg);
  }

  _updateSelectedY() {
    const ai = this._activeIdx();
    if (ai >= 0 && this.selectedIdx >= 0 && this.selectedIdx < this.segments[ai].points.length) {
      this.toolState.road.selectedPointY = this.segments[ai].points[this.selectedIdx].y;
    }
  }

  setSelectedPointY(y) {
    const ai = this._activeIdx();
    if (ai < 0 || this.selectedIdx < 0) return;
    const pts = this.segments[ai].points;
    if (this.selectedIdx >= pts.length) return;
    pts[this.selectedIdx].y = y;
    this._rebuildVisual();
  }

  getRoadMeshes() {
    return this.segments.flatMap(s => s.meshes ?? []);
  }

  getSegmentsSnapshot() {
    return this.segments.map((s) => ({
      points: s.points.map((p) => ({ x: p.x, y: p.y, z: p.z })),
    }));
  }

  getAverageY() {
    let sum = 0, count = 0;
    for (const seg of this.segments) {
      for (const p of seg.points) {
        sum += p.y;
        count++;
      }
    }
    return count > 0 ? sum / count : 0;
  }

  hasReflectiveRoads() {
    return this.segments.some(seg =>
      (seg.styleSpans ?? []).some(span => span.style.enhanced && (span.style.reflectStrength ?? 0) > 0),
    );
  }

  updateReflectVP(matrix) {
    for (const seg of this.segments) {
      for (const span of seg.styleSpans ?? []) {
        if (span.uniforms) span.uniforms.uReflectVP.value.copy(matrix);
      }
    }
  }

  exportData() {
    return this.segments.map(s => ({
      points: s.points.map(p => ({ x: p.x, y: p.y, z: p.z })),
      styleSpans: (s.styleSpans ?? []).map(span => ({
        start: span.start,
        style: { ...span.style },
      })),
    }));
  }

  importData(data) {
    this._disposeAllFull();
    this.segments = data.map(s => {
      const fallbackStyle = mergeStyleWithDefaults(s.style, this.toolState.road);
      const styleSpans = normalizeStyleSpans(s.styleSpans, fallbackStyle, this.toolState.road);
      for (const span of styleSpans) this._rebuildSpanMaterial(span);
      return {
        points: Array.isArray(s.points) ? s.points.map(p => new THREE.Vector3(p.x, p.y, p.z)) : [],
        meshes: [],
        styleSpans,
      };
    });
    this.selectedIdx = -1;
    this.dragging = false;
    this._clampActive();
    this._clampActiveStyleSection();
    if (this.segments.length > 0) this.loadActiveStyle();
    this._rebuildVisual();
  }

  dispose() {
    this._disposeAllFull();
    while (this.handleGroup.children.length) {
      const child = this.handleGroup.children[0];
      this.handleGroup.remove(child);
      if (child.geometry) child.geometry.dispose();
      if (child.material) child.material.dispose();
    }
    this.scene.remove(this.handleGroup);
  }
}

const _EPS2 = 0.01 * 0.01;
function _sharesEndpoint(ptsA, ptsB) {
  if (ptsA.length === 0 || ptsB.length === 0) return false;
  const aFirst = ptsA[0], aLast = ptsA[ptsA.length - 1];
  const bFirst = ptsB[0], bLast = ptsB[ptsB.length - 1];
  return (
    aFirst.distanceToSquared(bFirst) < _EPS2 ||
    aFirst.distanceToSquared(bLast) < _EPS2 ||
    aLast.distanceToSquared(bFirst) < _EPS2 ||
    aLast.distanceToSquared(bLast) < _EPS2
  );
}
