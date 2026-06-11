import * as THREE from "three";
import { MeshBasicNodeMaterial } from "three";
import {
  Fn,
  abs,
  clamp,
  cos,
  dot,
  floor,
  fract,
  length,
  max,
  min,
  mix,
  pow,
  sin,
  smoothstep,
  float,
  uniform,
  uv,
  vec2,
  vec4,
} from "three/tsl";
import { generateRiverGeometry } from "../../core/river/riverMesh.js";

export class RiverSystem {
  constructor({ scene, toolState, getWorldHeight }) {
    this.scene = scene;
    this.toolState = toolState;
    this.getWorldHeight = getWorldHeight;

    this.segments = [];
    this.selectedIdx = -1;
    this.dragging = false;

    this.handleGroup = new THREE.Group();
    this.handleGroup.name = "RiverHandles";
    this.scene.add(this.handleGroup);
    this.handleMeshes = [];

    this.undoStack = [];
    this.redoStack = [];

    this._time = 0;
    this._initNodeMaterials();
  }

  _initNodeMaterials() {
    this.uRiverTime = uniform(0.0);
    this.uRiverFlowSpeed = uniform(this.toolState.river.flowSpeed ?? 0.15);
    this.uRiverDeepColor = uniform(new THREE.Color(this.toolState.river.deepColor ?? "#1a4a6a"));
    this.uRiverShallowColor = uniform(new THREE.Color(this.toolState.river.shallowColor ?? "#5dbfaa"));
    this.uRiverHighlight = uniform(new THREE.Color(this.toolState.river.highlightColor ?? "#c8ecff"));
    this.uRiverFoamColor = uniform(new THREE.Color(this.toolState.river.foamColor ?? "#ffffff"));
    this.uRiverFoamWidth = uniform(this.toolState.river.foamWidth ?? 0.18);
    this.uRiverOpacity = uniform(this.toolState.river.opacity ?? 0.88);

    this.rsU = {
      flowSpeed: uniform(0.05),
      darkColor: uniform(new THREE.Color(0x041820)),
      bodyColor: uniform(new THREE.Color(0x30989f)),
      depthScaleU: uniform(1.5),
      depthScaleV: uniform(0.8),
      depthStrength: uniform(0.55),
      bodyBright: uniform(1.0),
      bodyContrast: uniform(1.0),
      streakEnabled: uniform(1.0),
      streakScaleV: uniform(12.0),
      streakScaleU: uniform(8.0),
      streakWarpStr: uniform(0.25),
      streakWarpSc: uniform(1.5),
      streakContrast: uniform(4.0),
      streakThresh: uniform(0.12),
      streakSharp: uniform(0.03),
      streakColor: uniform(new THREE.Color(0xffffff)),
      streakStr: uniform(0.9),
      foamAEnabled: uniform(1.0),
      foamBEnabled: uniform(1.0),
      foamWidth: uniform(0.18),
      foamScaleV: uniform(10.0),
      foamScaleU: uniform(6.0),
      foamJitter: uniform(0.9),
      foamOctaves: uniform(3.0),
      foamLac: uniform(2.35),
      foamGain: uniform(0.41),
      foamWarpStr: uniform(1.2),
      foamWarpSc: uniform(1.6),
      foamContrast: uniform(2.5),
      foamThresh: uniform(0.12),
      foamSharp: uniform(0.02),
      foamAColor: uniform(new THREE.Color("#ffffff")),
      foamAStr: uniform(0.5),
      foamBColor: uniform(new THREE.Color("#ffffff")),
      foamBStr: uniform(0.8),
      shimEnabled: uniform(1.0),
      shimNScV: uniform(12.0),
      shimNScU: uniform(12.0),
      shimNoiseAmt: uniform(0.3),
      shimSharp: uniform(0.02),
      shimColor: uniform(new THREE.Color("#00fff4")),
      shimStr: uniform(0.08),
      shimFlowSpd: uniform(1.5),
      opacity: uniform(this.toolState.river.opacity ?? 0.88),
    };

    const _wfGradientNoise = Fn(([p]) => {
      const i = floor(p).toVar();
      const f = fract(p).toVar();
      const uu = f.mul(f).mul(f).mul(f.mul(f.mul(6).sub(15)).add(10));
      const rg = Fn(([ip]) => {
        const a = fract(sin(dot(ip, vec2(127.1, 311.7))).mul(43758.5453)).mul(Math.PI * 2);
        return vec2(cos(a), sin(a));
      });
      return mix(
        mix(dot(rg(i), f), dot(rg(i.add(vec2(1, 0))), f.sub(vec2(1, 0))), uu.x),
        mix(
          dot(rg(i.add(vec2(0, 1))), f.sub(vec2(0, 1))),
          dot(rg(i.add(vec2(1, 1))), f.sub(vec2(1, 1))),
          uu.x,
        ),
        uu.y,
      ).mul(0.5).add(0.5);
    });
    const _wfVoroF1 = Fn(([p, jitter]) => {
      const ip = floor(p).toVar();
      const fp = fract(p).toVar();
      const md = float(10).toVar();
      for (const [nx, ny] of [[-1, -1], [0, -1], [1, -1], [-1, 0], [0, 0], [1, 0], [-1, 1], [0, 1], [1, 1]]) {
        const off = vec2(float(nx), float(ny));
        const h = vec2(
          fract(sin(dot(ip.add(off), vec2(127.1, 311.7))).mul(43758.5453)),
          fract(sin(dot(ip.add(off), vec2(269.5, 183.3))).mul(43758.5453)),
        );
        md.assign(min(md, length(off.add(mix(vec2(0.5), h, jitter)).sub(fp))));
      }
      return md;
    });
    const _wfVoroFbm = Fn(([pIn, jitter, octaves, lac, gain]) => {
      const p = pIn.toVar();
      const val = float(0).toVar();
      const amp = float(1).toVar();
      const total = float(0).toVar();
      val.addAssign(amp.mul(_wfVoroF1(p, jitter)));
      total.addAssign(amp);
      p.mulAssign(lac);
      amp.mulAssign(gain);
      const d2 = smoothstep(float(1), float(2), octaves);
      val.addAssign(amp.mul(_wfVoroF1(p, jitter)).mul(d2));
      total.addAssign(amp.mul(d2));
      p.mulAssign(lac);
      amp.mulAssign(gain);
      const d3 = smoothstep(float(2), float(3), octaves);
      val.addAssign(amp.mul(_wfVoroF1(p, jitter)).mul(d3));
      total.addAssign(amp.mul(d3));
      p.mulAssign(lac);
      amp.mulAssign(gain);
      const d4 = smoothstep(float(3), float(4), octaves);
      val.addAssign(amp.mul(_wfVoroF1(p, jitter)).mul(d4));
      total.addAssign(amp.mul(d4));
      return val.div(total);
    });
    const _wfBandMask = Fn(([y, low, high, n, noiseAmt, sharpness]) => {
      const nLow = low.add(n.sub(0.5).mul(noiseAmt.mul(2)));
      const nHigh = high.add(n.sub(0.5).mul(noiseAmt.mul(2)));
      return smoothstep(nLow.sub(sharpness), nLow.add(sharpness), y)
        .mul(smoothstep(nHigh.add(sharpness), nHigh.sub(sharpness), y));
    });
    const _wfVoroLayer = Fn(([v, scaleX, scaleY, offX, offY, jitter, octaves, lac, gain, warpStr, warpScale, contrast]) => {
      const p = vec2(v.x.mul(scaleX).add(offX), v.y.mul(scaleY).add(offY)).toVar();
      const wx = _wfGradientNoise(p.mul(warpScale)).sub(0.5);
      const wy = _wfGradientNoise(p.mul(warpScale).add(vec2(3.7, 8.3))).sub(0.5);
      p.addAssign(vec2(wx, wy).mul(warpStr));
      return pow(_wfVoroFbm(p, jitter, octaves, lac, gain), contrast);
    });
    const _wNHash = Fn(([p]) => {
      const pp = fract(p.mul(vec2(127.1, 311.7)));
      const d = dot(pp, pp.add(45.32));
      return fract(pp.x.add(d).mul(pp.y.add(d)));
    });
    const _wVNoise = Fn(([p]) => {
      const i = floor(p);
      const f = fract(p);
      const uu = f.mul(f).mul(float(3).sub(f.mul(2)));
      return mix(
        mix(_wNHash(i), _wNHash(i.add(vec2(1, 0))), uu.x),
        mix(_wNHash(i.add(vec2(0, 1))), _wNHash(i.add(vec2(1, 1))), uu.x),
        uu.y,
      );
    });
    const _wFbm2 = Fn(([p]) => {
      const v = _wVNoise(p).mul(0.5).toVar();
      v.addAssign(_wVNoise(p.mul(2)).mul(0.25));
      return v;
    });

    const buildRiverFrag = Fn(() => {
      const uvCoord = uv();
      const flowU = uvCoord.x.sub(this.uRiverTime.mul(this.uRiverFlowSpeed));
      const animUV = vec2(flowU, uvCoord.y);
      const wave1 = _wFbm2(animUV.mul(6.0));
      const wave2 = _wFbm2(animUV.mul(3.0).add(vec2(1.7, 3.1)));
      const wave = wave1.mul(0.6).add(wave2.mul(0.4));
      const centerDist = abs(uvCoord.y.sub(0.5)).mul(2.0);
      const depthColor = mix(this.uRiverDeepColor, this.uRiverShallowColor, pow(centerDist, float(0.6)));
      const shimmer = wave.sub(0.5).mul(0.18);
      const surfaceColor = mix(depthColor, this.uRiverHighlight, clamp(shimmer.add(0.5), float(0), float(1)));
      const leftFoam = smoothstep(this.uRiverFoamWidth, float(0), uvCoord.y);
      const rightFoam = smoothstep(float(1).sub(this.uRiverFoamWidth), float(1), uvCoord.y);
      const bankFoam = max(leftFoam, rightFoam);
      const finalColor = mix(surfaceColor, this.uRiverFoamColor, bankFoam.mul(0.85));
      return vec4(finalColor, this.uRiverOpacity);
    });

    const buildRiverStylizedFrag = Fn(() => {
      const uvCoord = uv();
      const fUV = vec2(uvCoord.y, uvCoord.x.sub(this.uRiverTime.mul(this.rsU.flowSpeed)));
      const depthN = _wfGradientNoise(vec2(fUV.x.mul(this.rsU.depthScaleV), fUV.y.mul(this.rsU.depthScaleU)));
      const col = mix(this.rsU.darkColor, this.rsU.bodyColor, depthN.mul(this.rsU.depthStrength)).toVar();
      col.assign(col.sub(0.5).mul(this.rsU.bodyContrast).add(0.5).mul(this.rsU.bodyBright).clamp(0, 1));
      const shimN = _wfGradientNoise(
        vec2(
          fUV.x.mul(this.rsU.shimNScV),
          fUV.y.mul(this.rsU.shimNScU).add(this.uRiverTime.mul(this.rsU.shimFlowSpd)),
        ),
      );
      const shimBand = _wfBandMask(uvCoord.y, float(0.2), float(0.8), shimN, this.rsU.shimNoiseAmt, this.rsU.shimSharp);
      col.assign(mix(col, this.rsU.shimColor, shimBand.mul(this.rsU.shimStr).mul(this.rsU.shimEnabled).clamp(0, 1)));
      const foamAMask = smoothstep(this.rsU.foamWidth, float(0), uvCoord.y).clamp(0, 1);
      const foamADynThresh = mix(float(1.2), this.rsU.foamThresh, foamAMask);
      const foamAF1 = _wfVoroLayer(
        fUV, this.rsU.foamScaleV, this.rsU.foamScaleU, float(0), float(0),
        this.rsU.foamJitter, this.rsU.foamOctaves, this.rsU.foamLac, this.rsU.foamGain,
        this.rsU.foamWarpStr, this.rsU.foamWarpSc, this.rsU.foamContrast,
      );
      const foamA = smoothstep(foamADynThresh.sub(this.rsU.foamSharp), foamADynThresh.add(this.rsU.foamSharp), foamAF1);
      col.assign(mix(col, this.rsU.foamAColor, foamA.mul(this.rsU.foamAStr).mul(this.rsU.foamAEnabled).clamp(0, 1)));
      const foamBMask = smoothstep(float(1).sub(this.rsU.foamWidth), float(1), uvCoord.y).clamp(0, 1);
      const foamBDynThresh = mix(float(1.2), this.rsU.foamThresh, foamBMask);
      const foamBF1 = _wfVoroLayer(
        fUV, this.rsU.foamScaleV, this.rsU.foamScaleU, float(5.3), float(2.7),
        this.rsU.foamJitter, this.rsU.foamOctaves, this.rsU.foamLac, this.rsU.foamGain,
        this.rsU.foamWarpStr, this.rsU.foamWarpSc, this.rsU.foamContrast,
      );
      const foamB = smoothstep(foamBDynThresh.sub(this.rsU.foamSharp), foamBDynThresh.add(this.rsU.foamSharp), foamBF1);
      col.assign(mix(col, this.rsU.foamBColor, foamB.mul(this.rsU.foamBStr).mul(this.rsU.foamBEnabled).clamp(0, 1)));
      const sUV = vec2(fUV.x.mul(this.rsU.streakScaleV), fUV.y.mul(this.rsU.streakScaleU)).toVar();
      const sWarpT = this.uRiverTime.mul(this.rsU.flowSpeed).mul(float(0.4));
      const sWx = _wfGradientNoise(vec2(sUV.x.mul(this.rsU.streakWarpSc), sUV.y.mul(this.rsU.streakWarpSc).add(sWarpT))).sub(0.5);
      const sWy = _wfGradientNoise(
        vec2(
          sUV.x.mul(this.rsU.streakWarpSc).add(float(3.7)),
          sUV.y.mul(this.rsU.streakWarpSc).add(float(8.3)).add(sWarpT),
        ),
      ).sub(0.5);
      sUV.addAssign(vec2(sWx, sWy).mul(this.rsU.streakWarpStr));
      const streakRaw = pow(_wfVoroFbm(sUV, float(1), float(2), float(2), float(0.4)), this.rsU.streakContrast);
      const streak = smoothstep(this.rsU.streakThresh.sub(this.rsU.streakSharp), this.rsU.streakThresh.add(this.rsU.streakSharp), streakRaw);
      col.assign(mix(col, this.rsU.streakColor, streak.mul(this.rsU.streakStr).mul(this.rsU.streakEnabled).clamp(0, 1)));
      return vec4(col, this.rsU.opacity);
    });

    this._basicMat = new MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    {
      const f = buildRiverFrag();
      this._basicMat.colorNode = f.rgb;
      this._basicMat.opacityNode = f.a;
    }
    this._stylizedMat = new MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    {
      const f = buildRiverStylizedFrag();
      this._stylizedMat.colorNode = f.rgb;
      this._stylizedMat.opacityNode = f.a;
    }
  }

  _isStylized() {
    return this.toolState.river.shaderStyle === "Stylized";
  }

  _activeMaterial() {
    return this._isStylized() ? this._stylizedMat : this._basicMat;
  }

  _activeIdx() {
    if (this.segments.length === 0) return -1;
    return Math.max(0, Math.min(this.toolState.river.activeRiverIndex | 0, this.segments.length - 1));
  }

  _clampActive() {
    if (this.segments.length === 0) {
      this.toolState.river.activeRiverIndex = 0;
      return;
    }
    this.toolState.river.activeRiverIndex = Math.max(0, Math.min(this.toolState.river.activeRiverIndex | 0, this.segments.length - 1));
  }

  _snapshot() {
    return {
      segments: this.segments.map((s) => ({
        points: s.points.map((p) => ({ x: p.x, y: p.y, z: p.z })),
      })),
      activeRiverIndex: this.toolState.river.activeRiverIndex,
      selectedIdx: this.selectedIdx,
    };
  }

  _pushUndo() {
    this.undoStack.push(this._snapshot());
    this.redoStack.length = 0;
    if (this.undoStack.length > 40) this.undoStack.shift();
  }

  _restore(snap) {
    this._disposeAllMeshes();
    this.segments = snap.segments.map((s) => ({
      points: s.points.map((p) => new THREE.Vector3(p.x, p.y, p.z)),
      mesh: null,
    }));
    this.toolState.river.activeRiverIndex = snap.activeRiverIndex;
    this.selectedIdx = snap.selectedIdx;
    this._clampActive();
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

  syncMaterial() {
    const p = this.toolState.river;
    this.uRiverFlowSpeed.value = p.flowSpeed;
    this.uRiverDeepColor.value.set(p.deepColor);
    this.uRiverShallowColor.value.set(p.shallowColor);
    this.uRiverHighlight.value.set(p.highlightColor ?? "#c8ecff");
    this.uRiverFoamColor.value.set(p.foamColor ?? "#ffffff");
    this.uRiverFoamWidth.value = p.foamWidth ?? 0.18;
    this.uRiverOpacity.value = p.opacity;

    this.rsU.flowSpeed.value = p.flowSpeed;
    this.rsU.bodyColor.value.set(p.shallowColor);
    this.rsU.darkColor.value.set(p.deepColor);
    this.rsU.foamAColor.value.set(p.foamColor ?? "#ffffff");
    this.rsU.foamBColor.value.set(p.foamColor ?? "#ffffff");
    this.rsU.foamWidth.value = p.foamWidth ?? 0.18;
    this.rsU.opacity.value = p.opacity;

    const mat = this._activeMaterial();
    for (const seg of this.segments) {
      if (seg.mesh && seg.mesh.material !== mat) seg.mesh.material = mat;
    }
  }

  startNewRiver() {
    this._pushUndo();
    this.segments.push({ points: [], mesh: null });
    this.toolState.river.activeRiverIndex = this.segments.length - 1;
    this.selectedIdx = -1;
    this._rebuildVisual();
  }

  deleteActiveRiver() {
    const ai = this._activeIdx();
    if (ai < 0) return;
    this._pushUndo();
    this._disposeSegMesh(this.segments[ai]);
    this.segments.splice(ai, 1);
    this.selectedIdx = -1;
    this.dragging = false;
    this._clampActive();
    this._rebuildVisual();
  }

  addPoint(pos) {
    this._pushUndo();
    if (this.segments.length === 0) {
      this.segments.push({ points: [], mesh: null });
      this.toolState.river.activeRiverIndex = 0;
    }
    this._clampActive();
    const ai = this._activeIdx();
    const pts = this.segments[ai].points;
    pts.push(pos.clone());
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

  setSelectedPointY(y) {
    const ai = this._activeIdx();
    if (ai < 0 || this.selectedIdx < 0) return;
    const pts = this.segments[ai].points;
    if (this.selectedIdx >= pts.length) return;
    pts[this.selectedIdx].y = y;
    this._rebuildVisual();
  }

  pickPoint(raycaster) {
    const spheres = this.handleMeshes.filter((m) => m.isMesh);
    if (spheres.length === 0) return -1;
    const hits = raycaster.intersectObjects(spheres, false);
    if (hits.length === 0) return -1;
    return this.handleMeshes.indexOf(hits[0].object);
  }

  rebuildAllMeshes() {
    const rp = this.toolState.river;
    for (let i = 0; i < this.segments.length; i++) {
      const seg = this.segments[i];
      this._disposeSegMesh(seg);
      if (seg.points.length < 2) continue;
      const curve = new THREE.CatmullRomCurve3(seg.points, !!rp.closed, "catmullrom", 0.5);
      const geo = generateRiverGeometry(
        curve,
        rp.width,
        rp.segments,
        rp.heightOffset,
        this.getWorldHeight,
      );
      seg.mesh = new THREE.Mesh(geo, this._activeMaterial());
      seg.mesh.renderOrder = 2;
      this.scene.add(seg.mesh);
    }
  }

  update(dtSec) {
    this._time += dtSec;
    this.uRiverTime.value = this._time;
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
    for (let i = 0; i < pts.length; i++) {
      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(0.5, 8, 8),
        new THREE.MeshBasicMaterial({ color: i === this.selectedIdx ? 0xffff00 : 0x0088ff }),
      );
      sphere.position.copy(pts[i]);
      this.handleGroup.add(sphere);
      this.handleMeshes.push(sphere);
    }

    if (pts.length >= 2) {
      const curve = new THREE.CatmullRomCurve3(pts, !!this.toolState.river.closed, "catmullrom", 0.5);
      const lineGeo = new THREE.BufferGeometry().setFromPoints(curve.getPoints(80));
      const line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: 0x00aaff }));
      this.handleGroup.add(line);
      this.handleMeshes.push(line);
    }
    this._syncHandlesVisibility();
  }

  _syncHandlesVisibility() {
    this.handleGroup.visible = this.toolState.mode === "river" && this.toolState.river.showHandles;
  }

  _rebuildVisual() {
    this.rebuildAllMeshes();
    this._rebuildHandles();
  }

  _updateSelectedY() {
    const ai = this._activeIdx();
    if (ai >= 0 && this.selectedIdx >= 0 && this.selectedIdx < this.segments[ai].points.length) {
      this.toolState.river.selectedPointY = this.segments[ai].points[this.selectedIdx].y;
    }
  }

  _disposeSegMesh(seg) {
    if (!seg.mesh) return;
    this.scene.remove(seg.mesh);
    seg.mesh.geometry.dispose();
    seg.mesh = null;
  }

  _disposeAllMeshes() {
    for (const seg of this.segments) this._disposeSegMesh(seg);
  }

  exportData() {
    return this.segments.map((s) => ({
      points: s.points.map((p) => ({ x: p.x, y: p.y, z: p.z })),
    }));
  }

  importData(data) {
    this._disposeAllMeshes();
    this.segments = (Array.isArray(data) ? data : []).map((s) => ({
      points: Array.isArray(s.points) ? s.points.map((p) => new THREE.Vector3(p.x, p.y, p.z)) : [],
      mesh: null,
    }));
    this.selectedIdx = -1;
    this.dragging = false;
    this._clampActive();
    this._rebuildVisual();
  }

  dispose() {
    this._disposeAllMeshes();
    while (this.handleGroup.children.length) {
      const child = this.handleGroup.children[0];
      this.handleGroup.remove(child);
      if (child.geometry) child.geometry.dispose();
      if (child.material) child.material.dispose();
    }
    this.scene.remove(this.handleGroup);
    this._basicMat.dispose();
    this._stylizedMat.dispose();
  }
}

