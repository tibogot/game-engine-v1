import * as THREE from "three";
import {
  chunkKey,
  chunkMinWorldX,
  chunkMinWorldZ,
  getChunkCountPerAxis,
  getChunkDataIndex,
  worldToChunkIndex,
} from "../../core/terrain/chunkMath.js";
import { createKerbStripNodeMaterial } from "./kerbStripMaterial.js";
import { buildChunkedKerbGroup } from "../../core/road/kerbChunkGeometry.js";
import {
  buildWallGeometry,
  buildBarrierGeometry,
  buildFenceGeometry,
} from "./splineLinearMesh.js";

const KERB_DIFFUSE_TEX_PATH = "../textures/pbr_materials/asphalt_track/asphalt_track_diff_2k.jpg";
const KERB_ARM_TEX_PATH = "../textures/pbr_materials/asphalt_track/asphalt_track_arm_2k.jpg";
const KERB_NORMAL_TEX_PATH = "../textures/pbr_materials/asphalt_track/asphalt_track_nor_gl_2k.jpg";
let _kerbTexLoadStarted = false;
let _kerbDiffuseTex = null;
let _kerbArmTex = null;
let _kerbNormalTex = null;
let _kerbFbDiffuse = null;
let _kerbFbArm = null;
let _kerbFbNormal = null;

function _ensureKerbPlaceholderTextures() {
  if (_kerbFbDiffuse) return;
  const d = new Uint8Array([235, 235, 235, 255]);
  _kerbFbDiffuse = new THREE.DataTexture(d, 1, 1);
  _kerbFbDiffuse.colorSpace = THREE.SRGBColorSpace;
  _kerbFbDiffuse.needsUpdate = true;
  const a = new Uint8Array([255, Math.round(0.92 * 255), 0, 255]);
  _kerbFbArm = new THREE.DataTexture(a, 1, 1);
  _kerbFbArm.colorSpace = THREE.LinearSRGBColorSpace;
  _kerbFbArm.needsUpdate = true;
  const n = new Uint8Array([128, 128, 255, 255]);
  _kerbFbNormal = new THREE.DataTexture(n, 1, 1);
  _kerbFbNormal.colorSpace = THREE.LinearSRGBColorSpace;
  _kerbFbNormal.needsUpdate = true;
}

export class SplineSystem {
  constructor({
    scene,
    toolState,
    config,
    terrainStore,
    chunkStream,
    treeStore,
    propStore,
    getWorldHeight,
    getRoadSegments,
    onVolumesChange,
  }) {
    this.onVolumesChange = onVolumesChange || (() => {});
    this.scene = scene;
    this.toolState = toolState;
    this.config = config;
    this.terrainStore = terrainStore;
    this.chunkStream = chunkStream;
    this.treeStore = treeStore;
    this.propStore = propStore;
    this.getWorldHeight = getWorldHeight;
    this.getRoadSegments = getRoadSegments || (() => []);

    this.points = [];
    this.selectedIdx = -1;
    this.dragging = false;
    this.pointMeshes = [];
    this._curve = null;
    this._curveLength = 0;
    this._trainT = 0;
    this.tunnels = [];
    this.guardrails = [];
    this.kerbs = [];
    this.linearFeatures = [];

    this.handleGroup = new THREE.Group();
    this.handleGroup.name = "SplineHandles";
    scene.add(this.handleGroup);

    this.previewGroup = new THREE.Group();
    this.previewGroup.name = "SplinePreview";
    scene.add(this.previewGroup);

    this.trainMesh = new THREE.Mesh(
      new THREE.BoxGeometry(1.8, 0.8, 3.2),
      new THREE.MeshBasicMaterial({ color: 0x00ccff, transparent: true, opacity: 0.9 }),
    );
    this.trainMesh.visible = false;
    scene.add(this.trainMesh);

    this.undoStack = [];
    this.redoStack = [];
  }

  _snapshot() {
    return {
      points: this.points.map((p) => ({ x: p.x, y: p.y, z: p.z })),
      selectedIdx: this.selectedIdx,
    };
  }

  _pushUndo() {
    this.undoStack.push(this._snapshot());
    this.redoStack.length = 0;
    if (this.undoStack.length > 40) this.undoStack.shift();
  }

  _restore(snap) {
    this.points = snap.points.map((p) => new THREE.Vector3(p.x, p.y, p.z));
    this.selectedIdx = snap.selectedIdx;
    this.dragging = false;
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

  _makeCurve() {
    if (this.points.length < 2) return null;
    return new THREE.CatmullRomCurve3(
      this.points,
      !!this.toolState.spline.closed,
      "catmullrom",
      0.5,
    );
  }

  _disposeGroup(group) {
    while (group.children.length) {
      const child = group.children[0];
      group.remove(child);
      if (child.geometry) child.geometry.dispose();
      if (child.material) child.material.dispose();
    }
  }

  _syncVisibility() {
    const inMode = this.toolState.mode === "spline";
    this.handleGroup.visible = inMode && this.toolState.spline.showHandles;
    if (!inMode) this.dragging = false;
  }

  _rebuildVisual() {
    this._disposeGroup(this.handleGroup);
    this.pointMeshes = [];
    this._curve = null;
    this._curveLength = 0;

    if (this.points.length >= 2) {
      this._curve = this._makeCurve();
      this._curveLength = this._curve?.getLength() ?? 0;
      if (this._curve) {
        const pts = this._curve.getPoints(Math.max(60, this.points.length * 20));
        const line = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(pts),
          new THREE.LineBasicMaterial({ color: 0x00ccff }),
        );
        this.handleGroup.add(line);
      }
    }

    for (let i = 0; i < this.points.length; i++) {
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(0.45, 10, 8),
        new THREE.MeshBasicMaterial({ color: i === this.selectedIdx ? 0xffff00 : 0xff4400 }),
      );
      mesh.position.copy(this.points[i]);
      this.handleGroup.add(mesh);
      this.pointMeshes.push(mesh);
    }

    this._syncVisibility();
  }

  _updateSelectedY() {
    if (this.selectedIdx >= 0 && this.selectedIdx < this.points.length) {
      this.toolState.spline.selectedPointY = this.points[this.selectedIdx].y;
    }
  }

  setClosed(closed) {
    this.toolState.spline.closed = !!closed;
    this._rebuildVisual();
  }

  setSelectedPointY(y) {
    if (this.selectedIdx < 0 || this.selectedIdx >= this.points.length) return;
    this.points[this.selectedIdx].y = y;
    this._rebuildVisual();
  }

  addPoint(pos) {
    this._pushUndo();
    this.points.push(pos.clone());
    this.selectedIdx = this.points.length - 1;
    this._rebuildVisual();
    this._updateSelectedY();
  }

  moveSelected(pos) {
    if (this.selectedIdx < 0 || this.selectedIdx >= this.points.length) return;
    const y = this.points[this.selectedIdx].y;
    this.points[this.selectedIdx].copy(pos);
    this.points[this.selectedIdx].y = y;
    this._rebuildVisual();
  }

  deleteSelected() {
    if (this.selectedIdx < 0 || this.selectedIdx >= this.points.length) return;
    this._pushUndo();
    this.points.splice(this.selectedIdx, 1);
    this.selectedIdx = Math.min(this.selectedIdx, this.points.length - 1);
    this._rebuildVisual();
    this._updateSelectedY();
  }

  clearAll() {
    if (this.points.length === 0) return;
    this._pushUndo();
    this.points = [];
    this.selectedIdx = -1;
    this.dragging = false;
    this.clearPreview();
    this._rebuildVisual();
  }

  pickPoint(raycaster) {
    const hits = raycaster.intersectObjects(this.pointMeshes, false);
    if (hits.length === 0) return -1;
    return this.pointMeshes.indexOf(hits[0].object);
  }

  _samples() {
    const curve = this._makeCurve();
    if (!curve) return [];
    const spacing = Math.max(0.25, this.toolState.spline.spacing);
    const total = curve.getLength();
    const count = Math.max(1, Math.floor(total / spacing));
    const out = [];
    for (let i = 0; i <= count; i++) {
      const t = i / count;
      const pos = curve.getPoint(t);
      const tan = curve.getTangent(t);
      out.push({ pos, angleY: Math.atan2(tan.x, tan.z) });
    }
    return out;
  }

  preview() {
    this.clearPreview();
    const samples = this._samples();
    if (samples.length === 0) return;
    const geo = new THREE.SphereGeometry(0.32, 8, 6);
    const mat = new THREE.MeshBasicMaterial({ color: 0x00ff88, depthTest: false });
    for (const { pos } of samples) {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(pos.x, pos.y + 0.45, pos.z);
      this.previewGroup.add(mesh);
    }
  }

  clearPreview() {
    this._disposeGroup(this.previewGroup);
  }

  _buildTunnelGeometry(curve, pathSegs, radialSegs, radius, closed) {
    const segs = Math.max(8, pathSegs | 0);
    const rSegs = Math.max(6, radialSegs | 0);
    const frames = curve.computeFrenetFrames(segs, closed);
    const ringVerts = rSegs + 1;
    const rings = segs + 1;
    const positions = new Float32Array(rings * ringVerts * 3);
    const normals = new Float32Array(rings * ringVerts * 3);
    const uvs = new Float32Array(rings * ringVerts * 2);
    const indexCount = segs * rSegs * 6;
    const indices = (rings * ringVerts > 65535)
      ? new Uint32Array(indexCount)
      : new Uint16Array(indexCount);

    let vi3 = 0;
    let vi2 = 0;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const center = curve.getPointAt(t);
      const n = frames.normals[i];
      const b = frames.binormals[i];
      for (let j = 0; j <= rSegs; j++) {
        const a = (j / rSegs) * Math.PI * 2;
        const c = Math.cos(a);
        const s = Math.sin(a);
        const rx = n.x * c + b.x * s;
        const ry = n.y * c + b.y * s;
        const rz = n.z * c + b.z * s;
        positions[vi3] = center.x + rx * radius;
        positions[vi3 + 1] = center.y + ry * radius;
        positions[vi3 + 2] = center.z + rz * radius;
        normals[vi3] = rx;
        normals[vi3 + 1] = ry;
        normals[vi3 + 2] = rz;
        uvs[vi2] = t * Math.max(1, segs * radius * 0.08);
        uvs[vi2 + 1] = j / rSegs;
        vi3 += 3;
        vi2 += 2;
      }
    }

    let ii = 0;
    for (let i = 0; i < segs; i++) {
      const r0 = i * ringVerts;
      const r1 = (i + 1) * ringVerts;
      for (let j = 0; j < rSegs; j++) {
        const a = r0 + j;
        const b = r1 + j;
        const c = r0 + j + 1;
        const d = r1 + j + 1;
        indices[ii++] = a;
        indices[ii++] = b;
        indices[ii++] = c;
        indices[ii++] = c;
        indices[ii++] = b;
        indices[ii++] = d;
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    geo.computeBoundingSphere();
    return geo;
  }

  _buildGuardrailProfileGeometry(curve, pathSegs, profile, depth, closed) {
    const segs = Math.max(16, pathSegs | 0);
    const prof = Array.isArray(profile) && profile.length >= 2 ? profile : [
      { y: -0.5, z: 0.5 },
      { y: 0.5, z: 0.5 },
    ];
    const ringVerts = prof.length;
    const rings = segs + 1;
    const positions = new Float32Array(rings * ringVerts * 3);
    const normals = new Float32Array(rings * ringVerts * 3);
    const uvs = new Float32Array(rings * ringVerts * 2);
    const indexCount = segs * (ringVerts - 1) * 6;
    const indices = (rings * ringVerts > 65535)
      ? new Uint32Array(indexCount)
      : new Uint16Array(indexCount);
    const frames = curve.computeFrenetFrames(segs, closed);
    const up = new THREE.Vector3();
    const out = new THREE.Vector3();
    let vi3 = 0;
    let vi2 = 0;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const center = curve.getPointAt(t);
      const centerY = this.getWorldHeight(center.x, center.z);
      const n = frames.normals[i];
      const b = frames.binormals[i];
      for (let j = 0; j < ringVerts; j++) {
        const p = prof[j];
        up.copy(n).multiplyScalar(p.y);
        out.copy(b).multiplyScalar(p.z * depth);
        positions[vi3] = center.x + up.x + out.x;
        positions[vi3 + 1] = centerY + up.y + out.y;
        positions[vi3 + 2] = center.z + up.z + out.z;
        normals[vi3] = b.x;
        normals[vi3 + 1] = b.y;
        normals[vi3 + 2] = b.z;
        uvs[vi2] = t * Math.max(1, segs * 0.2);
        uvs[vi2 + 1] = j / Math.max(1, ringVerts - 1);
        vi3 += 3;
        vi2 += 2;
      }
    }
    let ii = 0;
    for (let i = 0; i < segs; i++) {
      const r0 = i * ringVerts;
      const r1 = (i + 1) * ringVerts;
      for (let j = 0; j < ringVerts - 1; j++) {
        const a = r0 + j;
        const b = r1 + j;
        const c = r0 + j + 1;
        const d = r1 + j + 1;
        indices[ii++] = a;
        indices[ii++] = b;
        indices[ii++] = c;
        indices[ii++] = c;
        indices[ii++] = b;
        indices[ii++] = d;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    return geo;
  }

  _buildKerbStripGeometry(curve, pathSegs, width, height, lipHeight, topInset, closed) {
    const segs = Math.max(16, pathSegs | 0);
    const ringVerts = 4;
    const rings = segs + 1;
    const positions = new Float32Array(rings * ringVerts * 3);
    const normals = new Float32Array(rings * ringVerts * 3);
    const uvs = new Float32Array(rings * ringVerts * 2);
    const indexCount = segs * (ringVerts - 1) * 6;
    const indices = (rings * ringVerts > 65535)
      ? new Uint32Array(indexCount)
      : new Uint16Array(indexCount);
    const frames = curve.computeFrenetFrames(segs, closed);
    const up = new THREE.Vector3();
    const right = new THREE.Vector3();
    const sign = Math.sign(width || 1);
    const absW = Math.max(0.001, Math.abs(width));
    const insetRatio = THREE.MathUtils.clamp(topInset ?? 0, 0, 0.98);
    const topX = sign * (absW * (1 - insetRatio));
    const profile = [
      { y: 0, x: 0.0 },
      { y: 0, x: width },
      { y: lipHeight, x: width },
      { y: height, x: topX },
    ];
    let vi3 = 0;
    let vi2 = 0;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const center = curve.getPointAt(t);
      const centerY = this.getWorldHeight(center.x, center.z);
      const n = frames.normals[i];
      const b = frames.binormals[i];
      for (let j = 0; j < ringVerts; j++) {
        const p = profile[j];
        up.copy(n).multiplyScalar(p.y);
        right.copy(b).multiplyScalar(p.x);
        positions[vi3] = center.x + up.x + right.x;
        positions[vi3 + 1] = centerY + up.y + right.y;
        positions[vi3 + 2] = center.z + up.z + right.z;
        normals[vi3] = n.x;
        normals[vi3 + 1] = n.y;
        normals[vi3 + 2] = n.z;
        uvs[vi2] = t;
        uvs[vi2 + 1] = j / (ringVerts - 1);
        vi3 += 3;
        vi2 += 2;
      }
    }
    let ii = 0;
    for (let i = 0; i < segs; i++) {
      const r0 = i * ringVerts;
      const r1 = (i + 1) * ringVerts;
      for (let j = 0; j < ringVerts - 1; j++) {
        const a = r0 + j;
        const b = r1 + j;
        const c = r0 + j + 1;
        const d = r1 + j + 1;
        indices[ii++] = a;
        indices[ii++] = b;
        indices[ii++] = c;
        indices[ii++] = c;
        indices[ii++] = b;
        indices[ii++] = d;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    return geo;
  }

  _createGuardrailFromCurrentSpline() {
    const curve = this._makeCurve();
    if (!curve) return false;
    const s = this.toolState.spline;
    const scaleMid = Math.max(0.05, (Math.max(0.05, s.scaleMin) + Math.max(0.05, s.scaleMax)) * 0.5);
    const height = Math.max(0.05, s.guardrailHeight * scaleMid);
    const depth = Math.max(0.05, s.guardrailDepth * scaleMid);
    const thickness = Math.max(0.01, s.guardrailThickness * scaleMid);
    const crown = Math.max(0, s.guardrailCrownDepth * scaleMid);
    const profile = [
      { y: -0.5 * height, z: 0.5 },
      { y: -0.16 * height, z: 0.35 },
      { y: 0.0, z: -crown / Math.max(depth, 1e-6) },
      { y: 0.16 * height, z: 0.35 },
      { y: 0.5 * height, z: 0.5 },
    ];
    const guardrail = {
      points: this.points.map((p) => ({ x: p.x, y: p.y, z: p.z })),
      closed: !!s.closed,
      pathSegs: Math.max(40, s.guardrailPathSegments | 0),
      height,
      depth,
      thickness,
      crown,
      railYOffset: Math.max(0, s.guardrailRailYOffset * scaleMid),
      postSpacing: Math.max(
        0.5,
        s.guardrailPostSpacing * Math.max(1, s.guardrailFromRoadPostSpacingMul ?? 1),
      ),
      postWidth: Math.max(0.03, s.guardrailPostWidth * scaleMid),
      postDepth: Math.max(0.03, s.guardrailPostDepth * scaleMid),
      postHeight: Math.max(0.2, s.guardrailPostHeight * scaleMid),
      postSink: Math.max(0, s.guardrailPostSink * scaleMid),
      color: s.guardrailColor,
      profile,
      group: null,
    };
    this._buildGuardrailMesh(guardrail);
    this.guardrails.push(guardrail);
    return true;
  }

  _buildLinearFeatureMesh(item) {
    if (item.mesh) {
      this.scene.remove(item.mesh);
      item.mesh.geometry.dispose();
      item.mesh.material.dispose();
      item.mesh = null;
    }
    const groundedPoints = item.points.map((p) => new THREE.Vector3(
      p.x,
      this.getWorldHeight(p.x, p.z),
      p.z,
    ));
    const curve = new THREE.CatmullRomCurve3(
      groundedPoints,
      item.closed,
      "catmullrom",
      0.5,
    );
    const gh = (x, z) => this.getWorldHeight(x, z);
    let geo;
    if (item.kind === "wall") {
      geo = buildWallGeometry(gh, curve, item.pathSegs, item.width, item.height, item.closed);
    } else if (item.kind === "barrier") {
      geo = buildBarrierGeometry(gh, curve, item.pathSegs, item.depth, item.height, item.closed);
    } else if (item.kind === "fence") {
      geo = buildFenceGeometry(
        gh,
        curve,
        item.closed,
        item.postSpacing,
        item.postW,
        item.postD,
        item.height,
        item.railThick,
      );
    } else {
      return;
    }
    const mat = new THREE.MeshStandardMaterial({
      color: item.color ?? "#7a7d82",
      roughness: item.kind === "fence" ? 0.58 : 0.82,
      metalness: item.kind === "fence" ? 0.12 : 0.04,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.renderOrder = 3;
    item.mesh = mesh;
    this.scene.add(mesh);
  }

  syncLinearFeaturesToGround() {
    if (this.linearFeatures.length === 0) return;
    for (const item of this.linearFeatures) {
      this._buildLinearFeatureMesh(item);
    }
  }

  _createWallFromSpline() {
    const curve = this._makeCurve();
    if (!curve) return false;
    const s = this.toolState.spline;
    const scaleMid = Math.max(0.05, (Math.max(0.05, s.scaleMin) + Math.max(0.05, s.scaleMax)) * 0.5);
    const item = {
      kind: "wall",
      points: this.points.map((p) => ({ x: p.x, y: p.y, z: p.z })),
      closed: !!s.closed,
      pathSegs: Math.max(16, s.splineWallPathSegs | 0),
      height: Math.max(0.2, s.splineWallHeight * scaleMid),
      width: Math.max(0.02, s.splineWallWidth * scaleMid),
      color: s.splineWallColor,
      mesh: null,
    };
    this._buildLinearFeatureMesh(item);
    this.linearFeatures.push(item);
    return true;
  }

  _createFenceFromSpline() {
    const curve = this._makeCurve();
    if (!curve) return false;
    const s = this.toolState.spline;
    const scaleMid = Math.max(0.05, (Math.max(0.05, s.scaleMin) + Math.max(0.05, s.scaleMax)) * 0.5);
    const item = {
      kind: "fence",
      points: this.points.map((p) => ({ x: p.x, y: p.y, z: p.z })),
      closed: !!s.closed,
      postSpacing: Math.max(0.4, s.splineFencePostSpacing * scaleMid),
      postW: Math.max(0.02, s.splineFencePostWidth * scaleMid),
      postD: Math.max(0.02, s.splineFencePostDepth * scaleMid),
      height: Math.max(0.35, s.splineFenceHeight * scaleMid),
      railThick: Math.max(0.015, s.splineFenceRailThick * scaleMid),
      color: s.splineFenceColor,
      mesh: null,
    };
    this._buildLinearFeatureMesh(item);
    this.linearFeatures.push(item);
    return true;
  }

  _createBarrierFromSpline() {
    const curve = this._makeCurve();
    if (!curve) return false;
    const s = this.toolState.spline;
    const scaleMid = Math.max(0.05, (Math.max(0.05, s.scaleMin) + Math.max(0.05, s.scaleMax)) * 0.5);
    const item = {
      kind: "barrier",
      points: this.points.map((p) => ({ x: p.x, y: p.y, z: p.z })),
      closed: !!s.closed,
      pathSegs: Math.max(16, s.splineBarrierPathSegs | 0),
      height: Math.max(0.12, s.splineBarrierHeight * scaleMid),
      depth: Math.max(0.08, s.splineBarrierDepth * scaleMid),
      color: s.splineBarrierColor,
      mesh: null,
    };
    this._buildLinearFeatureMesh(item);
    this.linearFeatures.push(item);
    return true;
  }

  clearLinearFeatures() {
    for (const item of this.linearFeatures) {
      if (!item.mesh) continue;
      this.scene.remove(item.mesh);
      item.mesh.geometry.dispose();
      item.mesh.material.dispose();
      item.mesh = null;
    }
    this.linearFeatures.length = 0;
  }

  _slicePointsByRange(points, startT, endT) {
    if (!Array.isArray(points) || points.length < 2) return [];
    const a = THREE.MathUtils.clamp(Math.min(startT, endT), 0, 1);
    const b = THREE.MathUtils.clamp(Math.max(startT, endT), 0, 1);
    if (b - a < 1e-4) return [];
    const n = points.length;
    const i0 = Math.max(0, Math.floor(a * (n - 1)));
    const i1 = Math.min(n - 1, Math.ceil(b * (n - 1)));
    if (i1 - i0 < 1) return [];
    return points.slice(i0, i1 + 1);
  }

  _offsetPointsBySide(points, sideSign, lateralOffset) {
    const out = [];
    const tangent = new THREE.Vector3();
    const next = new THREE.Vector3();
    const prev = new THREE.Vector3();
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (i === 0) {
        next.copy(points[Math.min(points.length - 1, i + 1)]).sub(p);
        tangent.copy(next);
      } else if (i === points.length - 1) {
        prev.copy(p).sub(points[Math.max(0, i - 1)]);
        tangent.copy(prev);
      } else {
        prev.copy(p).sub(points[i - 1]);
        next.copy(points[i + 1]).sub(p);
        tangent.copy(prev.add(next));
      }
      const len = Math.hypot(tangent.x, tangent.z);
      let nx = 0;
      let nz = 0;
      if (len > 1e-6) {
        const tx = tangent.x / len;
        const tz = tangent.z / len;
        nx = tz * sideSign;
        nz = -tx * sideSign;
      }
      out.push({
        x: p.x + nx * lateralOffset,
        y: p.y,
        z: p.z + nz * lateralOffset,
      });
    }
    return out;
  }

  suggestKerbFromRoadCurvature() {
    const s = this.toolState.spline;
    const roads = this.getRoadSegments();
    if (!Array.isArray(roads) || roads.length === 0) return false;
    const roadIdx = THREE.MathUtils.clamp(s.kerbFromRoadIndex | 0, 0, roads.length - 1);
    const road = roads[roadIdx];
    const roadPoints = Array.isArray(road?.points) ? road.points : [];
    if (roadPoints.length < 3) return false;
    const curve = new THREE.CatmullRomCurve3(
      roadPoints.map((p) => new THREE.Vector3(p.x, p.y, p.z)),
      !!this.toolState.road?.closed,
      "catmullrom",
      0.5,
    );
    const sampleCount = Math.max(80, (s.kerbPathSegments | 0));
    const turn = new Float32Array(sampleCount + 1);
    const tangentA = new THREE.Vector3();
    const tangentB = new THREE.Vector3();
    let maxAbsTurn = 0;
    for (let i = 1; i < sampleCount; i++) {
      const t0 = (i - 1) / sampleCount;
      const t1 = i / sampleCount;
      const t2 = (i + 1) / sampleCount;
      tangentA.copy(curve.getTangentAt(t0)).setY(0).normalize();
      tangentB.copy(curve.getTangentAt(t2)).setY(0).normalize();
      const crossY = tangentA.x * tangentB.z - tangentA.z * tangentB.x;
      const dot = THREE.MathUtils.clamp(tangentA.dot(tangentB), -1, 1);
      const angle = Math.acos(dot);
      turn[i] = crossY * angle;
      maxAbsTurn = Math.max(maxAbsTurn, Math.abs(turn[i]));
    }
    if (maxAbsTurn < 1e-5) return false;

    const threshold = maxAbsTurn * 0.55;
    let bestStart = -1;
    let bestEnd = -1;
    let bestScore = -Infinity;
    let i = 1;
    while (i < sampleCount) {
      if (Math.abs(turn[i]) < threshold) {
        i++;
        continue;
      }
      const start = i;
      let sumAbs = 0;
      let sumSigned = 0;
      while (i < sampleCount && Math.abs(turn[i]) >= threshold) {
        sumAbs += Math.abs(turn[i]);
        sumSigned += turn[i];
        i++;
      }
      const end = i - 1;
      const len = end - start + 1;
      const score = sumAbs * Math.max(1, len * 0.15);
      if (score > bestScore) {
        bestScore = score;
        bestStart = start;
        bestEnd = end;
      }
      if (bestScore > -Infinity) {
        s.kerbFromRoadSide = sumSigned >= 0 ? "left" : "right";
      }
    }
    if (bestStart < 0 || bestEnd < 0) return false;

    const pad = Math.max(2, Math.floor((bestEnd - bestStart + 1) * 0.15));
    const startI = Math.max(0, bestStart - pad);
    const endI = Math.min(sampleCount, bestEnd + pad);
    s.kerbFromRoadStart = THREE.MathUtils.clamp(startI / sampleCount, 0, 1);
    s.kerbFromRoadEnd = THREE.MathUtils.clamp(endI / sampleCount, 0, 1);
    return true;
  }

  _createGuardrailFromRoad() {
    const s = this.toolState.spline;
    const roads = this.getRoadSegments();
    if (!Array.isArray(roads) || roads.length === 0) return false;
    const roadIdx = THREE.MathUtils.clamp(s.guardrailFromRoadIndex | 0, 0, roads.length - 1);
    const road = roads[roadIdx];
    const roadPoints = Array.isArray(road?.points) ? road.points : [];
    if (roadPoints.length < 2) return false;
    const baseCurve = new THREE.CatmullRomCurve3(
      roadPoints.map((p) => new THREE.Vector3(p.x, p.y, p.z)),
      !!this.toolState.road?.closed,
      "catmullrom",
      0.5,
    );
    const sampleCount = Math.max(24, (s.guardrailPathSegments | 0) + 1);
    const sampled = baseCurve.getSpacedPoints(sampleCount);
    const sliced = this._slicePointsByRange(
      sampled,
      s.guardrailFromRoadStart ?? 0,
      s.guardrailFromRoadEnd ?? 1,
    );
    if (sliced.length < 2) return false;

    const scaleMid = Math.max(0.05, (Math.max(0.05, s.scaleMin) + Math.max(0.05, s.scaleMax)) * 0.5);
    const halfRoadW = Math.max(0.25, (this.toolState.road?.width ?? 8) * 0.5);
    const edgeOffset = s.guardrailFromRoadEdgeOffset ?? 0;
    const lateralOffset = Math.max(0.1, halfRoadW + edgeOffset);
    const sides = s.guardrailFromRoadSide === "both"
      ? [1, -1]
      : [s.guardrailFromRoadSide === "left" ? 1 : -1];

    let placed = 0;
    for (const sideSign of sides) {
      const pts = this._offsetPointsBySide(sliced, sideSign, lateralOffset);
      if (pts.length < 2) continue;
      const height = Math.max(0.05, s.guardrailHeight * scaleMid);
      const depth = Math.max(0.05, s.guardrailDepth * scaleMid);
      const thickness = Math.max(0.01, s.guardrailThickness * scaleMid);
      const crown = Math.max(0, s.guardrailCrownDepth * scaleMid);
      const profile = [
        { y: -0.5 * height, z: 0.5 },
        { y: -0.16 * height, z: 0.35 },
        { y: 0.0, z: -crown / Math.max(depth, 1e-6) },
        { y: 0.16 * height, z: 0.35 },
        { y: 0.5 * height, z: 0.5 },
      ];
      const guardrail = {
        points: pts,
        closed: false,
        pathSegs: Math.max(40, s.guardrailPathSegments | 0),
        height,
        depth,
        thickness,
        crown,
        railYOffset: Math.max(0, s.guardrailRailYOffset * scaleMid),
        postSpacing: Math.max(0.5, s.guardrailPostSpacing * Math.max(1, s.guardrailFromRoadPostSpacingMul ?? 1)),
        postWidth: Math.max(0.03, s.guardrailPostWidth * scaleMid),
        postDepth: Math.max(0.03, s.guardrailPostDepth * scaleMid),
        postHeight: Math.max(0.2, s.guardrailPostHeight * scaleMid),
        postSink: Math.max(0, s.guardrailPostSink * scaleMid),
        color: s.guardrailColor,
        profile,
        group: null,
      };
      this._buildGuardrailMesh(guardrail);
      this.guardrails.push(guardrail);
      placed++;
    }
    return placed > 0;
  }

  _buildGuardrailMesh(guardrail) {
    if (guardrail.group) {
      this.scene.remove(guardrail.group);
      guardrail.group.traverse((obj) => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) obj.material.dispose();
      });
      guardrail.group = null;
    }
    const groundedPoints = guardrail.points.map((p) => new THREE.Vector3(
      p.x,
      this.getWorldHeight(p.x, p.z),
      p.z,
    ));
    const curve = new THREE.CatmullRomCurve3(
      groundedPoints,
      guardrail.closed,
      "catmullrom",
      0.5,
    );
    const railMat = new THREE.MeshStandardMaterial({
      color: guardrail.color ?? "#9aa0a8",
      roughness: 0.45,
      metalness: 0.85,
      side: THREE.DoubleSide,
    });
    const postMat = new THREE.MeshStandardMaterial({
      color: guardrail.color ?? "#9aa0a8",
      roughness: 0.55,
      metalness: 0.7,
    });
    const group = new THREE.Group();
    const railOuterGeo = this._buildGuardrailProfileGeometry(
      curve,
      guardrail.pathSegs,
      guardrail.profile,
      guardrail.depth,
      guardrail.closed,
    );
    const railOuter = new THREE.Mesh(railOuterGeo, railMat);
    railOuter.castShadow = true;
    railOuter.receiveShadow = true;
    group.add(railOuter);
    if (guardrail.thickness > 0.002) {
      const innerDepth = Math.max(0.01, guardrail.depth - guardrail.thickness * 2);
      const innerHeight = Math.max(0.02, guardrail.height - guardrail.thickness * 2);
      const innerProfile = [
        { y: -0.5 * innerHeight, z: 0.44 },
        { y: -0.16 * innerHeight, z: 0.31 },
        { y: 0.0, z: -guardrail.crown / Math.max(guardrail.depth, 1e-6) },
        { y: 0.16 * innerHeight, z: 0.31 },
        { y: 0.5 * innerHeight, z: 0.44 },
      ];
      const railInnerGeo = this._buildGuardrailProfileGeometry(
        curve,
        guardrail.pathSegs,
        innerProfile,
        innerDepth,
        guardrail.closed,
      );
      const railInner = new THREE.Mesh(railInnerGeo, postMat);
      railInner.castShadow = true;
      railInner.receiveShadow = true;
      group.add(railInner);
    }
    railOuter.position.y += guardrail.railYOffset;
    if (group.children[1]) group.children[1].position.y += guardrail.railYOffset;

    const length = curve.getLength();
    const postCount = Math.max(2, Math.floor(length / Math.max(0.5, guardrail.postSpacing)) + 1);
    const tangent = new THREE.Vector3();
    for (let i = 0; i < postCount; i++) {
      const t = guardrail.closed ? (i / postCount) : (i / Math.max(1, postCount - 1));
      const pos = curve.getPointAt(t);
      tangent.copy(curve.getTangentAt(t));
      const groundY = this.getWorldHeight(pos.x, pos.z) - guardrail.postSink;
      const railBottomY = pos.y + guardrail.railYOffset - (guardrail.height * 0.5);
      const postHeight = Math.max(guardrail.postHeight, railBottomY - groundY + guardrail.thickness * 0.5);
      const postGeo = new THREE.BoxGeometry(
        guardrail.postWidth,
        postHeight,
        guardrail.postDepth,
      );
      const post = new THREE.Mesh(postGeo, postMat);
      post.position.set(pos.x, groundY + postHeight * 0.5, pos.z);
      post.rotation.y = Math.atan2(tangent.x, tangent.z);
      post.castShadow = true;
      post.receiveShadow = true;
      group.add(post);
    }

    guardrail.group = group;
    this.scene.add(group);
  }

  _createKerbFromRoad() {
    const s = this.toolState.spline;
    const roads = this.getRoadSegments();
    if (!Array.isArray(roads) || roads.length === 0) return false;
    const roadIdx = THREE.MathUtils.clamp(s.kerbFromRoadIndex | 0, 0, roads.length - 1);
    const road = roads[roadIdx];
    const roadPoints = Array.isArray(road?.points) ? road.points : [];
    if (roadPoints.length < 2) return false;
    const baseCurve = new THREE.CatmullRomCurve3(
      roadPoints.map((p) => new THREE.Vector3(p.x, p.y, p.z)),
      !!this.toolState.road?.closed,
      "catmullrom",
      0.5,
    );
    const sampleCount = Math.max(24, (s.kerbPathSegments | 0) + 1);
    const sampled = baseCurve.getSpacedPoints(sampleCount);
    const sliced = this._slicePointsByRange(
      sampled,
      s.kerbFromRoadStart ?? 0,
      s.kerbFromRoadEnd ?? 1,
    );
    if (sliced.length < 2) return false;

    const halfRoadW = Math.max(0.25, (this.toolState.road?.width ?? 8) * 0.5);
    const edgeOffset = s.kerbFromRoadEdgeOffset ?? 0;
    const lateralOffset = halfRoadW + edgeOffset;
    const sides = s.kerbFromRoadSide === "both"
      ? [1, -1]
      : [s.kerbFromRoadSide === "left" ? 1 : -1];
    let placed = 0;
    for (const sideSign of sides) {
      const pts = this._offsetPointsBySide(sliced, sideSign, lateralOffset);
      if (pts.length < 2) continue;
      const kerb = {
        points: pts,
        closed: false,
        pathSegs: Math.max(40, s.kerbPathSegments | 0),
        width: Math.max(0.05, s.kerbWidth),
        height: Math.max(0.01, s.kerbHeight),
        lipHeight: Math.max(0, Math.min(s.kerbHeight, s.kerbLipHeight)),
        topInset: THREE.MathUtils.clamp(s.kerbTopInset ?? 0, 0, 0.98),
        stripeLength: Math.max(0.1, s.kerbStripeLength),
        squareStripes: s.kerbSquareStripes !== false,
        stripeSharpness: THREE.MathUtils.clamp(s.kerbStripeSharpness ?? 0.98, 0.5, 1.0),
        normalStrength: Math.max(0, s.kerbNormalStrength ?? 0.45),
        roughnessMul: Math.max(0.2, s.kerbRoughnessMul ?? 1.0),
        metalness: THREE.MathUtils.clamp(s.kerbMetalness ?? 0.02, 0, 1),
        colorA: s.kerbColorA,
        colorB: s.kerbColorB,
        sideSign,
        meshStyle: s.kerbMeshStyle === "chunk" ? "chunk" : "strip",
        ...this._kerbTexFieldsFromSplineState(),
        mesh: null,
      };
      this._buildKerbMesh(kerb);
      this.kerbs.push(kerb);
      placed++;
    }
    this.toolState.spline.activeKerbIndex = Math.max(0, this.kerbs.length - 1);
    this._syncToolStateFromActiveKerb();
    return placed > 0;
  }

  _createKerbFromCurrentSpline() {
    const s = this.toolState.spline;
    const curve = this._makeCurve();
    if (!curve) return false;
    const sampleCount = Math.max(24, (s.kerbPathSegments | 0) + 1);
    const sampled = curve.getSpacedPoints(sampleCount);
    const basePts = sampled.map((p) => ({ x: p.x, y: p.y, z: p.z }));
    if (basePts.length < 2) return false;
    const lateral = s.kerbSplineLateralOffset ?? 0;
    const sides = s.kerbSplineSide === "both"
      ? [1, -1]
      : [s.kerbSplineSide === "left" ? 1 : -1];
    let placed = 0;
    for (const sideSign of sides) {
      const pts = this._offsetPointsBySide(basePts, sideSign, lateral);
      if (pts.length < 2) continue;
      const kerb = {
        points: pts,
        closed: !!s.closed,
        pathSegs: Math.max(40, s.kerbPathSegments | 0),
        width: Math.max(0.05, s.kerbWidth),
        height: Math.max(0.01, s.kerbHeight),
        lipHeight: Math.max(0, Math.min(s.kerbHeight, s.kerbLipHeight)),
        topInset: THREE.MathUtils.clamp(s.kerbTopInset ?? 0, 0, 0.98),
        stripeLength: Math.max(0.1, s.kerbStripeLength),
        squareStripes: s.kerbSquareStripes !== false,
        stripeSharpness: THREE.MathUtils.clamp(s.kerbStripeSharpness ?? 0.98, 0.5, 1.0),
        normalStrength: Math.max(0, s.kerbNormalStrength ?? 0.45),
        roughnessMul: Math.max(0.2, s.kerbRoughnessMul ?? 1.0),
        metalness: THREE.MathUtils.clamp(s.kerbMetalness ?? 0.02, 0, 1),
        colorA: s.kerbColorA,
        colorB: s.kerbColorB,
        sideSign,
        meshStyle: s.kerbMeshStyle === "chunk" ? "chunk" : "strip",
        splineBasePoints: basePts.map((p) => ({ x: p.x, y: p.y, z: p.z })),
        splineLateralOffset: lateral,
        ...this._kerbTexFieldsFromSplineState(),
        mesh: null,
      };
      this._buildKerbMesh(kerb);
      this.kerbs.push(kerb);
      placed++;
    }
    this.toolState.spline.activeKerbIndex = Math.max(0, this.kerbs.length - 1);
    this._syncToolStateFromActiveKerb();
    return placed > 0;
  }

  _kerbTexFieldsFromSplineState() {
    const s = this.toolState.spline;
    return {
      texUvScaleU: Math.max(0.05, s.kerbTexUvScaleU ?? 1),
      texUvScaleV: Math.max(0.05, s.kerbTexUvScaleV ?? 1),
      texUvOffsetU: s.kerbTexUvOffsetU ?? 0,
      texUvOffsetV: s.kerbTexUvOffsetV ?? 0,
      texBrightness: s.kerbTexBrightness ?? 0,
      texContrast: Math.max(0.05, s.kerbTexContrast ?? 1),
      texSaturation: THREE.MathUtils.clamp(s.kerbTexSaturation ?? 1, 0, 3),
    };
  }

  _buildKerbMesh(kerb) {
    this._disposeKerbRoot(kerb);

    const groundedPoints = kerb.points.map((p) => new THREE.Vector3(
      p.x,
      this.getWorldHeight(p.x, p.z),
      p.z,
    ));
    const curve = new THREE.CatmullRomCurve3(
      groundedPoints,
      kerb.closed,
      "catmullrom",
      0.5,
    );

    const roadLift = Math.max(0.01, Math.min(0.03, (this.toolState.road?.heightOffset ?? 0.12) * 0.25));
    const sideSign = Math.sign(kerb.sideSign || 1);

    if (kerb.meshStyle === "chunk") {
      const group = buildChunkedKerbGroup({
        curve,
        startT: 0,
        endT: 1,
        sideSign,
        lateralDist: 0,
        kerbWidth: kerb.width,
        kerbHeight: kerb.height,
        lipHeight: kerb.lipHeight,
        squareSize: Math.max(0.1, kerb.stripeLength ?? 0.8),
        colorA: kerb.colorA ?? "#c92c2c",
        colorB: kerb.colorB ?? "#f2f2f2",
        getWorldHeight: (x, z) => this.getWorldHeight(x, z),
        isPreview: false,
      });
      group.position.y += roadLift;
      group.renderOrder = 4;
      kerb.mesh = group;
      this.scene.add(group);
      return;
    }

    const geo = this._buildKerbStripGeometry(
      curve,
      kerb.pathSegs,
      kerb.width * Math.sign(kerb.sideSign || 1),
      kerb.height,
      kerb.lipHeight,
      kerb.topInset,
      kerb.closed,
    );
    this._ensureKerbTexturesLoaded();
    _ensureKerbPlaceholderTextures();
    try {
      geo.computeTangents();
    } catch (_) {
      /* narrow strips can fail tangent generation */
    }
    const diffuseT = _kerbDiffuseTex || _kerbFbDiffuse;
    const armT = _kerbArmTex || _kerbFbArm;
    const normT = _kerbNormalTex || _kerbFbNormal;
    const { material: mat } = createKerbStripNodeMaterial({
      diffuseTex: diffuseT,
      armTex: armT,
      normalTex: normT,
      kerb,
    });
    const uv = geo.getAttribute("uv");
    const color = new Float32Array(uv.count * 3);
    const a = new THREE.Color(kerb.colorA ?? "#c92c2c").convertSRGBToLinear();
    const b = new THREE.Color(kerb.colorB ?? "#f2f2f2").convertSRGBToLinear();
    const stripeLength = (kerb.squareStripes !== false)
      ? Math.max(0.1, Math.abs(kerb.width ?? 1))
      : Math.max(0.1, kerb.stripeLength ?? 1);
    const curveLength = Math.max(0.1, curve.getLength());
    const stripes = Math.max(1, curveLength / stripeLength);
    const edge = THREE.MathUtils.clamp((1 - (kerb.stripeSharpness ?? 0.98)) * 0.08, 0.0001, 0.02);
    for (let i = 0; i < uv.count; i++) {
      const u = uv.getX(i);
      const local = (u * stripes) % 1;
      const blend = THREE.MathUtils.smoothstep(local, 0.5 - edge, 0.5 + edge);
      const ci = i * 3;
      color[ci] = THREE.MathUtils.lerp(a.r, b.r, blend);
      color[ci + 1] = THREE.MathUtils.lerp(a.g, b.g, blend);
      color[ci + 2] = THREE.MathUtils.lerp(a.b, b.b, blend);
    }
    geo.setAttribute("color", new THREE.BufferAttribute(color, 3));
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y += roadLift;
    mesh.renderOrder = 4;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    kerb.mesh = mesh;
    this.scene.add(mesh);
  }

  _ensureKerbTexturesLoaded() {
    if (_kerbTexLoadStarted) return;
    _kerbTexLoadStarted = true;
    const loader = new THREE.TextureLoader();
    const applyDefaults = (tex) => {
      if (!tex) return;
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.anisotropy = 8;
    };
    loader.load(KERB_DIFFUSE_TEX_PATH, (tex) => {
      applyDefaults(tex);
      tex.colorSpace = THREE.SRGBColorSpace;
      _kerbDiffuseTex = tex;
      this.syncKerbsToGround();
    });
    loader.load(KERB_ARM_TEX_PATH, (tex) => {
      applyDefaults(tex);
      tex.colorSpace = THREE.LinearSRGBColorSpace;
      _kerbArmTex = tex;
      this.syncKerbsToGround();
    });
    loader.load(KERB_NORMAL_TEX_PATH, (tex) => {
      applyDefaults(tex);
      tex.colorSpace = THREE.LinearSRGBColorSpace;
      _kerbNormalTex = tex;
      this.syncKerbsToGround();
    });
  }

  syncGuardrailsToGround() {
    if (this.guardrails.length === 0) return;
    for (const guardrail of this.guardrails) {
      this._buildGuardrailMesh(guardrail);
    }
  }

  syncKerbsToGround() {
    if (this.kerbs.length === 0) return;
    for (const kerb of this.kerbs) {
      this._buildKerbMesh(kerb);
    }
  }

  _activeKerb() {
    if (this.kerbs.length === 0) return null;
    const i = THREE.MathUtils.clamp(this.toolState.spline.activeKerbIndex | 0, 0, this.kerbs.length - 1);
    this.toolState.spline.activeKerbIndex = i;
    return this.kerbs[i];
  }

  _syncToolStateFromActiveKerb() {
    const k = this._activeKerb();
    if (!k) return false;
    const s = this.toolState.spline;
    s.kerbWidth = k.width;
    s.kerbHeight = k.height;
    s.kerbLipHeight = k.lipHeight;
    s.kerbTopInset = k.topInset ?? 0;
    s.kerbPathSegments = k.pathSegs;
    s.kerbStripeLength = k.stripeLength;
    s.kerbSquareStripes = k.squareStripes !== false;
    s.kerbStripeSharpness = k.stripeSharpness ?? 0.98;
    s.kerbNormalStrength = k.normalStrength ?? 0.45;
    s.kerbRoughnessMul = k.roughnessMul ?? 1.0;
    s.kerbMetalness = k.metalness ?? 0.02;
    s.kerbColorA = k.colorA;
    s.kerbColorB = k.colorB;
    s.kerbTexUvScaleU = k.texUvScaleU ?? 1;
    s.kerbTexUvScaleV = k.texUvScaleV ?? 1;
    s.kerbTexUvOffsetU = k.texUvOffsetU ?? 0;
    s.kerbTexUvOffsetV = k.texUvOffsetV ?? 0;
    s.kerbTexBrightness = k.texBrightness ?? 0;
    s.kerbTexContrast = k.texContrast ?? 1;
    s.kerbTexSaturation = k.texSaturation ?? 1;
    s.kerbMeshStyle = k.meshStyle === "chunk" ? "chunk" : "strip";
    if (Array.isArray(k.splineBasePoints) && k.splineBasePoints.length >= 2) {
      s.kerbSplineLateralOffset = k.splineLateralOffset ?? 0;
      s.kerbSplineSide = Math.sign(k.sideSign || 1) >= 0 ? "left" : "right";
    }
    return true;
  }

  selectActiveKerb() {
    return this._syncToolStateFromActiveKerb();
  }

  syncActiveKerbFromToolState() {
    const k = this._activeKerb();
    if (!k) return false;
    const s = this.toolState.spline;
    if (Array.isArray(k.splineBasePoints) && k.splineBasePoints.length >= 2) {
      const lat = s.kerbSplineLateralOffset ?? 0;
      let sign = Math.sign(k.sideSign || 1);
      if (s.kerbSplineSide === "left") sign = 1;
      else if (s.kerbSplineSide === "right") sign = -1;
      k.points = this._offsetPointsBySide(k.splineBasePoints, sign, lat);
      k.sideSign = sign;
      k.splineLateralOffset = lat;
    }
    k.width = Math.max(0.05, s.kerbWidth);
    k.height = Math.max(0.01, s.kerbHeight);
    k.lipHeight = Math.max(0, Math.min(k.height, s.kerbLipHeight));
    k.topInset = THREE.MathUtils.clamp(s.kerbTopInset ?? 0, 0, 0.98);
    k.pathSegs = Math.max(40, s.kerbPathSegments | 0);
    k.stripeLength = Math.max(0.1, s.kerbStripeLength);
    k.squareStripes = s.kerbSquareStripes !== false;
    k.stripeSharpness = THREE.MathUtils.clamp(s.kerbStripeSharpness ?? 0.98, 0.5, 1.0);
    k.normalStrength = Math.max(0, s.kerbNormalStrength ?? 0.45);
    k.roughnessMul = Math.max(0.2, s.kerbRoughnessMul ?? 1.0);
    k.metalness = THREE.MathUtils.clamp(s.kerbMetalness ?? 0.02, 0, 1);
    k.colorA = s.kerbColorA;
    k.colorB = s.kerbColorB;
    k.texUvScaleU = Math.max(0.05, s.kerbTexUvScaleU ?? 1);
    k.texUvScaleV = Math.max(0.05, s.kerbTexUvScaleV ?? 1);
    k.texUvOffsetU = s.kerbTexUvOffsetU ?? 0;
    k.texUvOffsetV = s.kerbTexUvOffsetV ?? 0;
    k.texBrightness = s.kerbTexBrightness ?? 0;
    k.texContrast = Math.max(0.05, s.kerbTexContrast ?? 1);
    k.texSaturation = THREE.MathUtils.clamp(s.kerbTexSaturation ?? 1, 0, 3);
    k.meshStyle = s.kerbMeshStyle === "chunk" ? "chunk" : "strip";
    this._buildKerbMesh(k);
    return true;
  }

  deleteActiveKerb() {
    if (this.kerbs.length === 0) return false;
    const idx = THREE.MathUtils.clamp(this.toolState.spline.activeKerbIndex | 0, 0, this.kerbs.length - 1);
    const k = this.kerbs[idx];
    this._disposeKerbRoot(k);
    this.kerbs.splice(idx, 1);
    this.toolState.spline.activeKerbIndex = Math.max(0, Math.min(idx, this.kerbs.length - 1));
    this._syncToolStateFromActiveKerb();
    return true;
  }

  duplicateActiveKerb() {
    const src = this._activeKerb();
    if (!src) return false;
    const dup = {
      points: src.points.map((p) => ({ x: p.x, y: p.y, z: p.z })),
      closed: !!src.closed,
      pathSegs: src.pathSegs,
      width: src.width,
      height: src.height,
      lipHeight: src.lipHeight,
      topInset: src.topInset ?? 0,
      stripeLength: src.stripeLength,
      squareStripes: src.squareStripes !== false,
      stripeSharpness: src.stripeSharpness ?? 0.98,
      normalStrength: src.normalStrength ?? 0.45,
      roughnessMul: src.roughnessMul ?? 1.0,
      metalness: src.metalness ?? 0.02,
      colorA: src.colorA,
      colorB: src.colorB,
      sideSign: Math.sign(src.sideSign || 1),
      splineBasePoints: Array.isArray(src.splineBasePoints)
        ? src.splineBasePoints.map((p) => ({ x: p.x, y: p.y, z: p.z }))
        : undefined,
      splineLateralOffset: src.splineLateralOffset,
      texUvScaleU: Math.max(0.05, src.texUvScaleU ?? 1),
      texUvScaleV: Math.max(0.05, src.texUvScaleV ?? 1),
      texUvOffsetU: src.texUvOffsetU ?? 0,
      texUvOffsetV: src.texUvOffsetV ?? 0,
      texBrightness: src.texBrightness ?? 0,
      texContrast: Math.max(0.05, src.texContrast ?? 1),
      texSaturation: THREE.MathUtils.clamp(src.texSaturation ?? 1, 0, 3),
      meshStyle: src.meshStyle === "chunk" ? "chunk" : "strip",
      mesh: null,
    };
    this._buildKerbMesh(dup);
    this.kerbs.push(dup);
    this.toolState.spline.activeKerbIndex = this.kerbs.length - 1;
    this._syncToolStateFromActiveKerb();
    return true;
  }

  _createTunnelFromCurrentSpline() {
    const curve = this._makeCurve();
    if (!curve) return false;
    const s = this.toolState.spline;
    const scaleMid = Math.max(0.05, (Math.max(0.05, s.scaleMin) + Math.max(0.05, s.scaleMax)) * 0.5);
    const radius = Math.max(0.5, s.tunnelRadius * scaleMid);
    const radialSegs = Math.max(6, s.tunnelRadialSegments | 0);
    const pathSegs = Math.max(40, s.tunnelPathSegments | 0);
    const closed = !!s.closed;
    const points = this.points.map((p) => ({ x: p.x, y: p.y, z: p.z }));
    const tunnel = {
      points,
      closed,
      radius,
      radialSegs,
      pathSegs,
      color: s.tunnelColor,
      capStart: !!s.tunnelCapStart,
      capEnd: !!s.tunnelCapEnd,
      mesh: null,
    };
    this._buildTunnelMesh(tunnel);
    this.tunnels.push(tunnel);
    this.onVolumesChange();
    return true;
  }

  /**
   * Public API — create a tunnel from explicit points (used by tunnel mode).
   * Rides the exact same record shape as `_createTunnelFromCurrentSpline`, so
   * serialization, BVH collision (`forEachMeshInstance`) and interior lighting
   * all pick it up with no extra plumbing. Returns the tunnel record.
   */
  addTunnel({
    points,
    radius = 6,
    radialSegs = 20,
    pathSegs = 220,
    color = "#6c727a",
    outerColor = "#cc2222",
    innerColor = "#2a2a32",
    capStart = false,
    capEnd = false,
    closed = false,
  }) {
    if (!Array.isArray(points) || points.length < 2) return null;
    const tunnel = {
      points: points.map((p) => ({ x: p.x, y: p.y, z: p.z })),
      closed: !!closed,
      radius: Math.max(0.5, radius),
      radialSegs: Math.max(6, radialSegs | 0),
      pathSegs: Math.max(40, pathSegs | 0),
      color,
      outerColor,
      innerColor,
      capStart: !!capStart,
      capEnd: !!capEnd,
      mesh: null,
      collisionMesh: null,
    };
    this._buildTunnelMesh(tunnel);
    this.tunnels.push(tunnel);
    this.onVolumesChange();
    return tunnel;
  }

  /** Public API — remove a tunnel record previously returned by `addTunnel`. */
  removeTunnel(tunnel) {
    const idx = this.tunnels.indexOf(tunnel);
    if (idx < 0) return false;
    if (tunnel.mesh) {
      this._disposeTunnelRoot(tunnel.mesh);
      tunnel.mesh = null;
      tunnel.collisionMesh = null;
    }
    this.tunnels.splice(idx, 1);
    this.onVolumesChange();
    return true;
  }

  _disposeTunnelRoot(root) {
    if (!root) return;
    this.scene.remove(root);
    const geos = new Set();
    root.traverse((obj) => {
      if (obj.geometry) geos.add(obj.geometry);
      if (obj.material) {
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of mats) m.dispose();
      }
    });
    for (const g of geos) g.dispose();
  }

  _buildTunnelMesh(tunnel) {
    if (tunnel.mesh) {
      this._disposeTunnelRoot(tunnel.mesh);
      tunnel.mesh = null;
      tunnel.collisionMesh = null;
    }
    const curve = new THREE.CatmullRomCurve3(
      tunnel.points.map((p) => new THREE.Vector3(p.x, p.y, p.z)),
      tunnel.closed,
      "catmullrom",
      0.5,
    );
    const geo = this._buildTunnelGeometry(
      curve,
      tunnel.pathSegs,
      tunnel.radialSegs,
      tunnel.radius,
      tunnel.closed,
    );
    // Two single-sided shells sharing one open-ended tube — avoids DoubleSide
    // z-fighting (the "shader flicker") and keeps the mouth rings hollow.
    const outerMat = new THREE.MeshStandardMaterial({
      color: tunnel.outerColor ?? tunnel.color ?? "#cc2222",
      roughness: 0.82,
      metalness: 0.03,
      side: THREE.FrontSide,
      depthWrite: true,
      depthTest: true,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    const innerMat = new THREE.MeshStandardMaterial({
      color: tunnel.innerColor ?? "#2a2a32",
      roughness: 0.96,
      metalness: 0,
      side: THREE.BackSide,
      depthWrite: true,
      depthTest: true,
    });
    const outerMesh = new THREE.Mesh(geo, outerMat);
    const innerMesh = new THREE.Mesh(geo, innerMat);
    outerMesh.castShadow = true;
    outerMesh.receiveShadow = true;
    innerMesh.receiveShadow = true;

    const group = new THREE.Group();
    group.renderOrder = 3;
    group.add(outerMesh);
    group.add(innerMesh);
    tunnel.mesh = group;
    tunnel.collisionMesh = outerMesh;
    this.scene.add(group);

    // One collision shell — same geometry the car/player BVH already used.
  }

  bakePlacement() {
    const samples = this._samples();
    if (samples.length === 0) return { placed: 0 };

    this._pushUndo();
    const worldHalf = this.config.world.size * 0.5;
    const s = this.toolState.spline;
    const scaleRange = Math.max(0, s.scaleMax - s.scaleMin);
    let placed = 0;

    if (s.objectType === "trees") {
      const slotIdx = this.toolState.treePaint.activeSlot | 0;
      const minSpacing = Math.max(0, this.toolState.treePaint.minSpacing || 0);
      for (const { pos, angleY } of samples) {
        const x = THREE.MathUtils.clamp(pos.x, -worldHalf, worldHalf);
        const z = THREE.MathUtils.clamp(pos.z, -worldHalf, worldHalf);
        if (minSpacing > 0 && this.treeStore.hasTreeNearby(x, z, minSpacing)) continue;
        const y = this.getWorldHeight(x, z);
        const scale = s.scaleMin + Math.random() * scaleRange;
        const rotY = s.alignToPath ? angleY : Math.random() * Math.PI * 2;
        this.treeStore.addTree(x, z, y, rotY, scale, slotIdx);
        placed++;
      }
    } else if (s.objectType === "props") {
      const slot = this.toolState.propSlots[this.toolState.props.activeSlot];
      const typeIdx = slot?.typeIdx;
      if (typeIdx == null) return { placed: 0 };
      const minSpacing = Math.max(0, this.toolState.props.minSpacing || 0);
      const sinkOffset = this.toolState.props.sinkOffset || 0;
      for (const { pos, angleY } of samples) {
        const x = THREE.MathUtils.clamp(pos.x, -worldHalf, worldHalf);
        const z = THREE.MathUtils.clamp(pos.z, -worldHalf, worldHalf);
        if (minSpacing > 0 && this.propStore.hasNearby(x, z, minSpacing)) continue;
        const scale = s.scaleMin + Math.random() * scaleRange;
        const rotY = s.alignToPath ? THREE.MathUtils.radToDeg(angleY) : Math.random() * 360;
        const y = this.getWorldHeight(x, z) - sinkOffset;
        this.propStore.instances.push({
          typeIdx,
          px: x, py: y, pz: z,
          rx: 0, ry: rotY, rz: 0,
          sx: scale, sy: scale, sz: scale,
        });
        placed++;
      }
      if (placed > 0) this.propStore._bump();
    } else if (s.objectType === "tunnel") {
      const ok = this._createTunnelFromCurrentSpline();
      if (ok) placed = 1;
    } else if (s.objectType === "guardrail") {
      const ok = this._createGuardrailFromCurrentSpline();
      if (ok) placed = 1;
    } else if (s.objectType === "guardrailFromRoad") {
      const ok = this._createGuardrailFromRoad();
      if (ok) placed = 1;
    } else if (s.objectType === "wallSpline") {
      const ok = this._createWallFromSpline();
      if (ok) placed = 1;
    } else if (s.objectType === "fenceSpline") {
      const ok = this._createFenceFromSpline();
      if (ok) placed = 1;
    } else if (s.objectType === "barrierSpline") {
      const ok = this._createBarrierFromSpline();
      if (ok) placed = 1;
    } else if (s.objectType === "kerbSpline") {
      const ok = this._createKerbFromCurrentSpline();
      if (ok) placed = 1;
    } else if (s.objectType === "kerbFromRoad") {
      const ok = this._createKerbFromRoad();
      if (ok) placed = 1;
    }

    this.clearPreview();
    this.clearAll();
    return { placed };
  }

  applyPlateau() {
    const closed = !!this.toolState.spline.closed;
    if (closed && this.points.length < 3) return false;
    if (!closed && this.points.length < 2) return false;

    const curve = this._makeCurve();
    if (!curve) return false;

    const samples = curve.getPoints(Math.max(96, this.points.length * 32));
    const px = [];
    const pz = [];
    for (const p of samples) {
      px.push(p.x);
      pz.push(p.z);
    }
    if (closed && px.length >= 2) {
      const li = px.length - 1;
      const dx = px[li] - px[0];
      const dz = pz[li] - pz[0];
      if (dx * dx + dz * dz < 1e-6) {
        px.pop();
        pz.pop();
      }
    }

    const n = px.length;
    if (closed && n < 3) return false;
    if (!closed && n < 2) return false;

    let minX = px[0], maxX = px[0], minZ = pz[0], maxZ = pz[0];
    for (let i = 1; i < n; i++) {
      minX = Math.min(minX, px[i]);
      maxX = Math.max(maxX, px[i]);
      minZ = Math.min(minZ, pz[i]);
      maxZ = Math.max(maxZ, pz[i]);
    }

    const halfW = Math.max(0.25, this.toolState.spline.plateauHalfWidth);
    const falloff = Math.max(0, this.toolState.spline.plateauFalloff);
    const targetY = this.toolState.spline.plateauHeight;
    const step = this.config.world.chunkSize / this.config.world.dataResolution;
    const pad = (closed ? falloff : halfW + falloff) + step * 2;
    const worldHalf = this.config.world.size * 0.5;
    minX = THREE.MathUtils.clamp(minX - pad, -worldHalf, worldHalf);
    maxX = THREE.MathUtils.clamp(maxX + pad, -worldHalf, worldHalf);
    minZ = THREE.MathUtils.clamp(minZ - pad, -worldHalf, worldHalf);
    maxZ = THREE.MathUtils.clamp(maxZ + pad, -worldHalf, worldHalf);

    const pointInPolygon = (x, z) => {
      let inside = false;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const xi = px[i], zi = pz[i];
        const xj = px[j], zj = pz[j];
        const cross = (zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi + 1e-12) + xi;
        if (cross) inside = !inside;
      }
      return inside;
    };

    const distPointSegment2D = (x, z, ax, az, bx, bz) => {
      const abx = bx - ax;
      const abz = bz - az;
      const apx = x - ax;
      const apz = z - az;
      const ab2 = abx * abx + abz * abz;
      let t = ab2 > 1e-20 ? (apx * abx + apz * abz) / ab2 : 0;
      t = Math.max(0, Math.min(1, t));
      const qx = ax + t * abx;
      const qz = az + t * abz;
      return Math.hypot(x - qx, z - qz);
    };

    const distToClosedRing = (x, z) => {
      let d = Infinity;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        d = Math.min(d, distPointSegment2D(x, z, px[i], pz[i], px[j], pz[j]));
      }
      return d;
    };

    const distToOpenPolyline = (x, z) => {
      let d = Infinity;
      for (let i = 0; i < n - 1; i++) {
        d = Math.min(d, distPointSegment2D(x, z, px[i], pz[i], px[i + 1], pz[i + 1]));
      }
      return d;
    };

    const weightAt = (x, z) => {
      if (closed) {
        if (!pointInPolygon(x, z)) return 0;
        if (falloff <= 1e-6) return 1;
        const d = distToClosedRing(x, z);
        return THREE.MathUtils.smoothstep(d, 0, falloff);
      }
      const d = distToOpenPolyline(x, z);
      const outer = halfW + falloff;
      if (d > outer) return 0;
      if (falloff <= 1e-6) return d <= halfW ? 1 : 0;
      if (d <= halfW) return 1;
      return 1 - THREE.MathUtils.smoothstep(halfW, outer, d);
    };

    const minCi = worldToChunkIndex(minX, minZ, this.config);
    const maxCi = worldToChunkIndex(maxX, maxZ, this.config);
    const maxChunk = getChunkCountPerAxis(this.config) - 1;
    const minCx = THREE.MathUtils.clamp(minCi.cx, 0, maxChunk);
    const minCz = THREE.MathUtils.clamp(minCi.cz, 0, maxChunk);
    const maxCx = THREE.MathUtils.clamp(maxCi.cx, 0, maxChunk);
    const maxCz = THREE.MathUtils.clamp(maxCi.cz, 0, maxChunk);
    const res = this.config.world.dataResolution;
    const stride = res + 1;
    const clampMin = this.config.sculpt.sculptClampMin;
    const clampMax = this.config.sculpt.sculptClampMax;
    const dirtyChunks = new Map();

    this._pushUndo();
    let changedAny = false;

    const markDirty = (cx, cz, ix, iz) => {
      const k = chunkKey(cx, cz);
      const ex = dirtyChunks.get(k);
      if (!ex) {
        dirtyChunks.set(k, { minIx: ix, maxIx: ix, minIz: iz, maxIz: iz });
        return;
      }
      if (ix < ex.minIx) ex.minIx = ix;
      if (ix > ex.maxIx) ex.maxIx = ix;
      if (iz < ex.minIz) ex.minIz = iz;
      if (iz > ex.maxIz) ex.maxIz = iz;
    };

    for (let cz = minCz; cz <= maxCz; cz++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        const heights = this.terrainStore.ensureChunkData(cx, cz);
        const cminXw = chunkMinWorldX(cx, this.config);
        const cminZw = chunkMinWorldZ(cz, this.config);

        for (let iz = 0; iz <= res; iz++) {
          const wz = cminZw + iz * step;
          if (wz < minZ || wz > maxZ) continue;
          for (let ix = 0; ix <= res; ix++) {
            const wx = cminXw + ix * step;
            if (wx < minX || wx > maxX) continue;
            const w = weightAt(wx, wz);
            if (w < 1e-7) continue;
            const idx = getChunkDataIndex(ix, iz, this.config);
            const oldH = heights[idx];
            const mixed = THREE.MathUtils.lerp(oldH, targetY, w);
            const next = THREE.MathUtils.clamp(mixed, clampMin, clampMax);
            if (Math.abs(next - oldH) < 1e-9) continue;
            changedAny = true;
            heights[idx] = next;
            markDirty(cx, cz, ix, iz);

            const onL = ix === 0;
            const onR = ix === res;
            const onT = iz === 0;
            const onB = iz === res;
            if (onL && cx > 0) {
              const h = this.terrainStore.ensureChunkData(cx - 1, cz);
              h[iz * stride + res] = next;
              markDirty(cx - 1, cz, res, iz);
            }
            if (onR && cx < maxChunk) {
              const h = this.terrainStore.ensureChunkData(cx + 1, cz);
              h[iz * stride + 0] = next;
              markDirty(cx + 1, cz, 0, iz);
            }
            if (onT && cz > 0) {
              const h = this.terrainStore.ensureChunkData(cx, cz - 1);
              h[res * stride + ix] = next;
              markDirty(cx, cz - 1, ix, res);
            }
            if (onB && cz < maxChunk) {
              const h = this.terrainStore.ensureChunkData(cx, cz + 1);
              h[ix] = next;
              markDirty(cx, cz + 1, ix, 0);
            }
          }
        }
      }
    }

    if (!changedAny) return false;
    this.chunkStream.markDirtyRects(dirtyChunks);
    return true;
  }

  update(dtSec) {
    this._syncVisibility();
    const s = this.toolState.spline;
    if (!s.showTrain || !this._curve || this._curveLength <= 1e-6) {
      this.trainMesh.visible = false;
      return;
    }
    this.trainMesh.visible = true;
    this._trainT = (this._trainT + dtSec * Math.max(0.1, s.trainSpeed) / this._curveLength) % 1;
    const pos = this._curve.getPointAt(this._trainT);
    const tan = this._curve.getTangentAt(this._trainT).normalize();
    this.trainMesh.position.copy(pos).addScaledVector(new THREE.Vector3(0, 1, 0), 0.7);
    this.trainMesh.scale.setScalar(Math.max(0.1, s.trainScale));
    this.trainMesh.rotation.y = Math.atan2(tan.x, tan.z);
  }

  exportData() {
    return {
      points: this.points.map((p) => ({ x: p.x, y: p.y, z: p.z })),
      tunnels: this.tunnels.map((t) => ({
        points: t.points.map((p) => ({ x: p.x, y: p.y, z: p.z })),
        closed: !!t.closed,
        radius: t.radius,
        radialSegs: t.radialSegs,
        pathSegs: t.pathSegs,
        color: t.color ?? "#6c727a",
        outerColor: t.outerColor ?? t.color ?? "#cc2222",
        innerColor: t.innerColor ?? "#2a2a32",
        capStart: !!t.capStart,
        capEnd: !!t.capEnd,
      })),
      guardrails: this.guardrails.map((g) => ({
        points: g.points.map((p) => ({ x: p.x, y: p.y, z: p.z })),
        closed: !!g.closed,
        pathSegs: g.pathSegs,
        height: g.height,
        thickness: g.thickness,
        depth: g.depth,
        crown: g.crown,
        railYOffset: g.railYOffset,
        postSpacing: g.postSpacing,
        postWidth: g.postWidth,
        postDepth: g.postDepth,
        postHeight: g.postHeight,
        postSink: g.postSink,
        color: g.color ?? "#9aa0a8",
      })),
      kerbs: this.kerbs.map((k) => {
        const row = {
          points: k.points.map((p) => ({ x: p.x, y: p.y, z: p.z })),
          closed: !!k.closed,
          pathSegs: k.pathSegs,
          width: k.width,
          height: k.height,
          lipHeight: k.lipHeight,
          topInset: k.topInset ?? 0,
          stripeLength: k.stripeLength,
          squareStripes: k.squareStripes !== false,
          stripeSharpness: k.stripeSharpness ?? 0.98,
          normalStrength: k.normalStrength ?? 0.45,
          roughnessMul: k.roughnessMul ?? 1.0,
          metalness: k.metalness ?? 0.02,
          colorA: k.colorA ?? "#c92c2c",
          colorB: k.colorB ?? "#f2f2f2",
          sideSign: Math.sign(k.sideSign || 1),
          texUvScaleU: Math.max(0.05, k.texUvScaleU ?? 1),
          texUvScaleV: Math.max(0.05, k.texUvScaleV ?? 1),
          texUvOffsetU: k.texUvOffsetU ?? 0,
          texUvOffsetV: k.texUvOffsetV ?? 0,
          texBrightness: k.texBrightness ?? 0,
          texContrast: Math.max(0.05, k.texContrast ?? 1),
          texSaturation: THREE.MathUtils.clamp(k.texSaturation ?? 1, 0, 3),
        };
        if (Array.isArray(k.splineBasePoints) && k.splineBasePoints.length >= 2) {
          row.splineBasePoints = k.splineBasePoints.map((p) => ({ x: p.x, y: p.y, z: p.z }));
          row.splineLateralOffset = k.splineLateralOffset ?? 0;
        }
        if (k.meshStyle === "chunk") row.meshStyle = "chunk";
        return row;
      }),
      linearFeatures: this.linearFeatures.map((f) => {
        const row = {
          kind: f.kind,
          points: f.points.map((p) => ({ x: p.x, y: p.y, z: p.z })),
          closed: !!f.closed,
          color: f.color ?? "#7a7d82",
        };
        if (f.kind === "wall") {
          row.pathSegs = f.pathSegs;
          row.height = f.height;
          row.width = f.width;
        } else if (f.kind === "fence") {
          row.postSpacing = f.postSpacing;
          row.postW = f.postW;
          row.postD = f.postD;
          row.height = f.height;
          row.railThick = f.railThick;
        } else if (f.kind === "barrier") {
          row.pathSegs = f.pathSegs;
          row.height = f.height;
          row.depth = f.depth;
        }
        return row;
      }),
    };
  }

  importData(data) {
    const pts = Array.isArray(data?.points) ? data.points : [];
    this.clearTunnels();
    this.clearGuardrails();
    this.clearKerbs();
    this.clearLinearFeatures();
    this.points = pts.map((p) => new THREE.Vector3(p.x, p.y, p.z));
    const tunnels = Array.isArray(data?.tunnels) ? data.tunnels : [];
    for (const t of tunnels) {
      if (!Array.isArray(t.points) || t.points.length < 2) continue;
      const tunnel = {
        points: t.points.map((p) => ({ x: p.x, y: p.y, z: p.z })),
        closed: !!t.closed,
        radius: Math.max(0.5, t.radius ?? 6),
        radialSegs: Math.max(6, t.radialSegs ?? 20),
        pathSegs: Math.max(40, t.pathSegs ?? 220),
        color: t.color ?? "#6c727a",
        outerColor: t.outerColor ?? t.color ?? "#cc2222",
        innerColor: t.innerColor ?? "#2a2a32",
        capStart: !!t.capStart,
        capEnd: !!t.capEnd,
        mesh: null,
        collisionMesh: null,
      };
      this._buildTunnelMesh(tunnel);
      this.tunnels.push(tunnel);
    }
    this.onVolumesChange();
    const guardrails = Array.isArray(data?.guardrails) ? data.guardrails : [];
    for (const g of guardrails) {
      if (!Array.isArray(g.points) || g.points.length < 2) continue;
      const guardrail = {
        points: g.points.map((p) => ({ x: p.x, y: p.y, z: p.z })),
        closed: !!g.closed,
        pathSegs: Math.max(40, g.pathSegs ?? 260),
        height: Math.max(0.05, g.height ?? 0.36),
        thickness: Math.max(0.01, g.thickness ?? 0.03),
        depth: Math.max(0.05, g.depth ?? 0.22),
        crown: Math.max(0, g.crown ?? 0.08),
        railYOffset: Math.max(0, g.railYOffset ?? 0.68),
        postSpacing: Math.max(0.5, g.postSpacing ?? 2.25),
        postWidth: Math.max(0.03, g.postWidth ?? 0.12),
        postDepth: Math.max(0.03, g.postDepth ?? 0.1),
        postHeight: Math.max(0.2, g.postHeight ?? 0.95),
        postSink: Math.max(0, g.postSink ?? 0.08),
        color: g.color ?? "#9aa0a8",
        profile: [
          { y: -0.5 * Math.max(0.05, g.height ?? 0.36), z: 0.5 },
          { y: -0.16 * Math.max(0.05, g.height ?? 0.36), z: 0.35 },
          { y: 0.0, z: -Math.max(0, g.crown ?? 0.08) / Math.max(Math.max(0.05, g.depth ?? 0.22), 1e-6) },
          { y: 0.16 * Math.max(0.05, g.height ?? 0.36), z: 0.35 },
          { y: 0.5 * Math.max(0.05, g.height ?? 0.36), z: 0.5 },
        ],
        group: null,
      };
      this._buildGuardrailMesh(guardrail);
      this.guardrails.push(guardrail);
    }
    const kerbs = Array.isArray(data?.kerbs) ? data.kerbs : [];
    for (const k of kerbs) {
      if (!Array.isArray(k.points) || k.points.length < 2) continue;
      const kerb = {
        points: k.points.map((p) => ({ x: p.x, y: p.y, z: p.z })),
        closed: !!k.closed,
        pathSegs: Math.max(40, k.pathSegs ?? 260),
        width: Math.max(0.05, k.width ?? 0.95),
        height: Math.max(0.01, k.height ?? 0.14),
        lipHeight: Math.max(0, Math.min(Math.max(0.01, k.height ?? 0.14), k.lipHeight ?? 0.04)),
        topInset: THREE.MathUtils.clamp(k.topInset ?? 0.0, 0, 0.98),
        stripeLength: Math.max(0.1, k.stripeLength ?? 1.4),
        squareStripes: k.squareStripes !== false,
        stripeSharpness: THREE.MathUtils.clamp(k.stripeSharpness ?? 0.98, 0.5, 1.0),
        normalStrength: Math.max(0, k.normalStrength ?? 0.45),
        roughnessMul: Math.max(0.2, k.roughnessMul ?? 1.0),
        metalness: THREE.MathUtils.clamp(k.metalness ?? 0.02, 0, 1),
        colorA: k.colorA ?? "#c92c2c",
        colorB: k.colorB ?? "#f2f2f2",
        sideSign: Math.sign(k.sideSign || 1),
        splineBasePoints: Array.isArray(k.splineBasePoints) && k.splineBasePoints.length >= 2
          ? k.splineBasePoints.map((p) => ({ x: p.x, y: p.y, z: p.z }))
          : undefined,
        splineLateralOffset: Array.isArray(k.splineBasePoints) && k.splineBasePoints.length >= 2
          ? (k.splineLateralOffset ?? 0)
          : undefined,
        texUvScaleU: Math.max(0.05, k.texUvScaleU ?? 1),
        texUvScaleV: Math.max(0.05, k.texUvScaleV ?? 1),
        texUvOffsetU: k.texUvOffsetU ?? 0,
        texUvOffsetV: k.texUvOffsetV ?? 0,
        texBrightness: k.texBrightness ?? 0,
        texContrast: Math.max(0.05, k.texContrast ?? 1),
        texSaturation: THREE.MathUtils.clamp(k.texSaturation ?? 1, 0, 3),
        meshStyle: k.meshStyle === "chunk" ? "chunk" : "strip",
        mesh: null,
      };
      this._buildKerbMesh(kerb);
      this.kerbs.push(kerb);
    }
    const linearFeatures = Array.isArray(data?.linearFeatures) ? data.linearFeatures : [];
    for (const lf of linearFeatures) {
      const kind = lf.kind;
      if (kind !== "wall" && kind !== "fence" && kind !== "barrier") continue;
      if (!Array.isArray(lf.points) || lf.points.length < 2) continue;
      const base = {
        kind,
        points: lf.points.map((p) => ({ x: p.x, y: p.y, z: p.z })),
        closed: !!lf.closed,
        color: lf.color ?? "#7a7d82",
        mesh: null,
      };
      let item;
      if (kind === "wall") {
        item = {
          ...base,
          pathSegs: Math.max(16, lf.pathSegs ?? 80),
          height: Math.max(0.2, lf.height ?? 3),
          width: Math.max(0.02, lf.width ?? 0.25),
        };
      } else if (kind === "fence") {
        item = {
          ...base,
          postSpacing: Math.max(0.4, lf.postSpacing ?? 2.2),
          postW: Math.max(0.02, lf.postW ?? 0.06),
          postD: Math.max(0.02, lf.postD ?? 0.04),
          height: Math.max(0.35, lf.height ?? 1.4),
          railThick: Math.max(0.015, lf.railThick ?? 0.04),
        };
      } else {
        item = {
          ...base,
          pathSegs: Math.max(16, lf.pathSegs ?? 72),
          height: Math.max(0.12, lf.height ?? 0.78),
          depth: Math.max(0.08, lf.depth ?? 0.55),
        };
      }
      this._buildLinearFeatureMesh(item);
      this.linearFeatures.push(item);
    }
    this.toolState.spline.activeKerbIndex = 0;
    this._syncToolStateFromActiveKerb();
    this.selectedIdx = -1;
    this.dragging = false;
    this.clearPreview();
    this._rebuildVisual();
  }

  clearTunnels() {
    for (const t of this.tunnels) {
      if (t.mesh) {
        this._disposeTunnelRoot(t.mesh);
        t.mesh = null;
        t.collisionMesh = null;
      }
    }
    this.tunnels.length = 0;
    this.onVolumesChange();
  }

  clearGuardrails() {
    for (const g of this.guardrails) {
      if (!g.group) continue;
      this.scene.remove(g.group);
      g.group.traverse((obj) => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) obj.material.dispose();
      });
      g.group = null;
    }
    this.guardrails.length = 0;
  }

  _disposeKerbRoot(kerb) {
    if (!kerb?.mesh) return;
    this.scene.remove(kerb.mesh);
    if (kerb.mesh.isGroup) {
      kerb.mesh.traverse((obj) => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) obj.material.dispose();
      });
    } else {
      if (kerb.mesh.geometry) kerb.mesh.geometry.dispose();
      if (kerb.mesh.material) kerb.mesh.material.dispose();
    }
    kerb.mesh = null;
  }

  clearKerbs() {
    for (const k of this.kerbs) {
      this._disposeKerbRoot(k);
    }
    this.kerbs.length = 0;
  }

  /**
   * BVH integration hook — same shape used by CliffStore/PropStore.
   * Feeds baked tunnel triangle meshes into CliffBvh.bake(..., extraStores).
   */
  forEachMeshInstance(cb) {
    for (const t of this.tunnels) {
      const col = t.collisionMesh;
      if (!col?.geometry) continue;
      col.updateMatrixWorld(true);
      cb(col.geometry, col.matrixWorld);
    }
    for (const g of this.guardrails) {
      if (!g.group) continue;
      g.group.updateMatrixWorld(true);
      g.group.traverse((obj) => {
        if (!obj.isMesh || !obj.geometry) return;
        cb(obj.geometry, obj.matrixWorld);
      });
    }
    for (const k of this.kerbs) {
      const root = k.mesh;
      if (!root) continue;
      root.updateMatrixWorld(true);
      if (root.isGroup) {
        root.traverse((obj) => {
          if (!obj.isMesh || !obj.geometry) return;
          cb(obj.geometry, obj.matrixWorld);
        });
      } else if (root.isMesh && root.geometry) {
        cb(root.geometry, root.matrixWorld);
      }
    }
    for (const f of this.linearFeatures) {
      const mesh = f.mesh;
      if (!mesh || !mesh.geometry) continue;
      mesh.updateMatrixWorld(true);
      cb(mesh.geometry, mesh.matrixWorld);
    }
  }

  dispose() {
    this.clearTunnels();
    this.clearGuardrails();
    this.clearKerbs();
    this.clearLinearFeatures();
    this._disposeGroup(this.handleGroup);
    this._disposeGroup(this.previewGroup);
    this.scene.remove(this.handleGroup);
    this.scene.remove(this.previewGroup);
    this.scene.remove(this.trainMesh);
    this.trainMesh.geometry.dispose();
    this.trainMesh.material.dispose();
  }
}

