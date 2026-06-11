import * as THREE from "three";
import { MeshBasicNodeMaterial, MeshStandardNodeMaterial } from "three";
import {
  Fn,
  abs,
  clamp,
  dot,
  floor,
  fract,
  length,
  max,
  min,
  mix,
  mx_noise_float,
  pow,
  sin,
  smoothstep,
  float,
  uniform,
  uv,
  vec2,
  positionLocal,
  normalLocal,
} from "three/tsl";

export class WaterfallSystem {
  constructor({ scene, toolState, transformControls }) {
    this.scene = scene;
    this.toolState = toolState;
    this.transformControls = transformControls;
    this.waterfallObjects = [];
    this.splashCapObjects = [];
    this.selectedWaterfall = null;
    this.selectedSplashCap = null;
    this._time = 0;
    this._raycaster = new THREE.Raycaster();

    this._buildMaterials();
    this._applySplashVisibility();
  }

  _buildMaterials() {
    const wf = this.toolState.waterfall;
    this.wfFlowTime = uniform(0.0);
    this.wfU = {
      darkColor: uniform(new THREE.Color("#00544c")),
      bodyColor: uniform(new THREE.Color("#38d0d0")),
      depthScaleX: uniform(2.0),
      depthScaleY: uniform(1.65),
      depthStrength: uniform(0.5),
      bodyBrightness: uniform(1.0),
      bodyContrast: uniform(1.0),
      cyan_enabled: uniform(1.0),
      cyan_bandLow: uniform(0.3),
      cyan_bandHigh: uniform(0.8),
      cyan_nScaleX: uniform(12.0),
      cyan_nScaleY: uniform(12.0),
      cyan_noiseAmt: uniform(0.3),
      cyan_bandSharp: uniform(0.02),
      cyan_color: uniform(new THREE.Color("#00fff4")),
      cyan_strength: uniform(0.1),
      cyan_flowSpeed: uniform(3.0),
      red_enabled: uniform(1.0),
      red_bandLow: uniform(0.35),
      red_bandHigh: uniform(0.93),
      red_scaleX: uniform(7.0),
      red_scaleY: uniform(4.0),
      red_offsetX: uniform(0.0),
      red_offsetY: uniform(0.0),
      red_jitter: uniform(0.55),
      red_octaves: uniform(3.0),
      red_lac: uniform(2.35),
      red_gain: uniform(0.41),
      red_warpStr: uniform(0.83),
      red_warpScale: uniform(1.6),
      red_contrast: uniform(1.2),
      red_threshold: uniform(0.12),
      red_sharpness: uniform(0.02),
      red_color: uniform(new THREE.Color("#c8f0ee")),
      red_strength: uniform(0.3),
      green_enabled: uniform(1.0),
      green_bandLow: uniform(0.45),
      green_bandHigh: uniform(0.82),
      green_scaleX: uniform(7.0),
      green_scaleY: uniform(4.0),
      green_offsetX: uniform(0.0),
      green_offsetY: uniform(0.0),
      green_jitter: uniform(0.55),
      green_octaves: uniform(3.0),
      green_lac: uniform(2.35),
      green_gain: uniform(0.41),
      green_warpStr: uniform(0.83),
      green_warpScale: uniform(1.6),
      green_contrast: uniform(1.2),
      green_threshold: uniform(0.12),
      green_sharpness: uniform(0.02),
      green_color: uniform(new THREE.Color("#ffffff")),
      green_strength: uniform(1.0),
      drip_enabled: uniform(1.0),
      drip_bandLow: uniform(0.0),
      drip_bandHigh: uniform(1.0),
      drip_nScaleX: uniform(6.0),
      drip_nScaleY: uniform(2.0),
      drip_noiseAmt: uniform(0.08),
      drip_bandSharp: uniform(0.04),
      drip_scaleX: uniform(14.0),
      drip_scaleY: uniform(1.8),
      drip_offsetX: uniform(0.0),
      drip_offsetY: uniform(0.0),
      drip_jitter: uniform(1.0),
      drip_octaves: uniform(2.0),
      drip_lac: uniform(2.0),
      drip_gain: uniform(0.4),
      drip_warpStr: uniform(0.25),
      drip_warpScale: uniform(1.5),
      drip_contrast: uniform(4.0),
      drip_threshold: uniform(0.12),
      drip_sharpness: uniform(0.03),
      drip_color: uniform(new THREE.Color(0xffffff)),
      drip_strength: uniform(0.9),
      wfFlowSpeed: uniform(0.5),
      wfOpacity: uniform(0.92),
    };

    const _wfGradientNoise = Fn(([p]) => {
      const i = floor(p).toVar();
      const f = fract(p).toVar();
      const uu = f.mul(f).mul(f).mul(f.mul(f.mul(6).sub(15)).add(10));
      const rg = Fn(([ip]) => {
        const a = fract(sin(dot(ip, vec2(127.1, 311.7))).mul(43758.5453)).mul(Math.PI * 2);
        return vec2(a.cos(), a.sin());
      });
      return mix(
        mix(dot(rg(i), f), dot(rg(i.add(vec2(1, 0))), f.sub(vec2(1, 0))), uu.x),
        mix(dot(rg(i.add(vec2(0, 1))), f.sub(vec2(0, 1))), dot(rg(i.add(vec2(1, 1))), f.sub(vec2(1, 1))), uu.x),
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
      p.mulAssign(lac); amp.mulAssign(gain);
      const d2 = smoothstep(float(1), float(2), octaves);
      val.addAssign(amp.mul(_wfVoroF1(p, jitter)).mul(d2)); total.addAssign(amp.mul(d2));
      p.mulAssign(lac); amp.mulAssign(gain);
      const d3 = smoothstep(float(2), float(3), octaves);
      val.addAssign(amp.mul(_wfVoroF1(p, jitter)).mul(d3)); total.addAssign(amp.mul(d3));
      return val.div(total.max(0.0001));
    });
    const _wfBandMask = Fn(([y, low, high, n, noiseAmt, sharpness]) => {
      const nLow = low.add(n.sub(0.5).mul(noiseAmt.mul(2)));
      const nHigh = high.add(n.sub(0.5).mul(noiseAmt.mul(2)));
      return smoothstep(nLow.sub(sharpness), nLow.add(sharpness), y).mul(
        smoothstep(nHigh.add(sharpness), nHigh.sub(sharpness), y),
      );
    });
    const _wfVoroLayer = Fn(([v, scaleX, scaleY, offX, offY, jitter, octaves, lac, gain, warpStr, warpScale, contrast]) => {
      const p = vec2(v.x.mul(scaleX).add(offX), v.y.mul(scaleY).add(offY)).toVar();
      const wx = _wfGradientNoise(p.mul(warpScale)).sub(0.5);
      const wy = _wfGradientNoise(p.mul(warpScale).add(vec2(3.7, 8.3))).sub(0.5);
      p.addAssign(vec2(wx, wy).mul(warpStr));
      return pow(_wfVoroFbm(p, jitter, octaves, lac, gain), contrast);
    });

    const waterfallColorNode = Fn(() => {
      const v = uv();
      const wfU = this.wfU;
      const depthN = _wfGradientNoise(vec2(v.x.mul(wfU.depthScaleX), v.y.mul(wfU.depthScaleY).add(this.wfFlowTime.mul(float(0.5)))));
      const col = mix(wfU.darkColor, wfU.bodyColor, depthN.mul(wfU.depthStrength)).toVar();
      col.assign(col.sub(0.5).mul(wfU.bodyContrast).add(0.5).mul(wfU.bodyBrightness).clamp(0, 1));
      const cyanN = _wfGradientNoise(vec2(v.x.mul(wfU.cyan_nScaleX), v.y.mul(wfU.cyan_nScaleY).add(this.wfFlowTime.mul(wfU.cyan_flowSpeed))));
      const cyanBand = _wfBandMask(v.y, wfU.cyan_bandLow, wfU.cyan_bandHigh, cyanN, wfU.cyan_noiseAmt, wfU.cyan_bandSharp);
      col.assign(mix(col, wfU.cyan_color, cyanBand.mul(wfU.cyan_strength).mul(wfU.cyan_enabled).clamp(0, 1)));
      const redCorner = smoothstep(wfU.red_bandLow, wfU.red_bandHigh, v.y).mul(smoothstep(wfU.red_bandHigh, wfU.red_bandLow, v.y)).mul(4.0).clamp(0, 1);
      const redDynThresh = mix(float(1.2), wfU.red_threshold, redCorner);
      const redF1 = _wfVoroLayer(v, wfU.red_scaleX, wfU.red_scaleY, wfU.red_offsetX, wfU.red_offsetY.add(this.wfFlowTime), wfU.red_jitter, wfU.red_octaves, wfU.red_lac, wfU.red_gain, wfU.red_warpStr, wfU.red_warpScale, wfU.red_contrast);
      const redFoam = smoothstep(redDynThresh.sub(wfU.red_sharpness), redDynThresh.add(wfU.red_sharpness), redF1);
      col.assign(mix(col, wfU.red_color, redFoam.mul(wfU.red_strength).mul(wfU.red_enabled).clamp(0, 1)));
      const greenCorner = smoothstep(wfU.green_bandLow, wfU.green_bandHigh, v.y).mul(smoothstep(wfU.green_bandHigh, wfU.green_bandLow, v.y)).mul(4.0).clamp(0, 1);
      const greenDynThresh = mix(float(1.2), wfU.green_threshold, greenCorner);
      const greenF1 = _wfVoroLayer(v, wfU.green_scaleX, wfU.green_scaleY, wfU.green_offsetX, wfU.green_offsetY.add(this.wfFlowTime), wfU.green_jitter, wfU.green_octaves, wfU.green_lac, wfU.green_gain, wfU.green_warpStr, wfU.green_warpScale, wfU.green_contrast);
      const greenFoam = smoothstep(greenDynThresh.sub(wfU.green_sharpness), greenDynThresh.add(wfU.green_sharpness), greenF1);
      col.assign(mix(col, wfU.green_color, greenFoam.mul(wfU.green_strength).mul(wfU.green_enabled).clamp(0, 1)));
      const dripN = _wfGradientNoise(vec2(v.x.mul(wfU.drip_nScaleX), v.y.mul(wfU.drip_nScaleY)));
      const dripBand = _wfBandMask(v.y, wfU.drip_bandLow, wfU.drip_bandHigh, dripN, wfU.drip_noiseAmt, wfU.drip_bandSharp);
      const dripF1 = _wfVoroLayer(v, wfU.drip_scaleX, wfU.drip_scaleY, wfU.drip_offsetX, wfU.drip_offsetY.add(this.wfFlowTime), wfU.drip_jitter, wfU.drip_octaves, wfU.drip_lac, wfU.drip_gain, wfU.drip_warpStr, wfU.drip_warpScale, wfU.drip_contrast);
      const dripFoam = smoothstep(wfU.drip_threshold.sub(wfU.drip_sharpness), wfU.drip_threshold.add(wfU.drip_sharpness), dripF1);
      col.assign(mix(col, wfU.drip_color, dripFoam.mul(dripBand).mul(wfU.drip_strength).mul(wfU.drip_enabled).clamp(0, 1)));
      return col;
    });

    this.waterfallMat = new MeshStandardNodeMaterial({
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: false,
      roughness: 0.9,
      metalness: 0.0,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    this.waterfallMat.colorNode = waterfallColorNode();
    this.waterfallMat.opacityNode = this.wfU.wfOpacity;

    this.ifTime = uniform(0);
    this.ifOpacity = uniform(wf.splashOpacity);
    this.ifNoiseScale = uniform(wf.splashNoiseScale);
    this.ifFlow = uniform(wf.splashFlow);
    this.ifDisp = uniform(wf.splashDisp);
    this.ifColorA = uniform(new THREE.Color(wf.splashColorA));
    this.ifColorB = uniform(new THREE.Color(wf.splashColorB));

    const splashPosNode = Fn(() => {
      const t = this.ifTime;
      const xz = positionLocal.xz.mul(this.ifNoiseScale);
      const scroll = vec2(t.mul(this.ifFlow), t.mul(this.ifFlow.mul(0.74)));
      const n1 = mx_noise_float(xz.add(scroll));
      const n2 = mx_noise_float(xz.mul(2.12).sub(vec2(scroll.y, scroll.x.mul(0.9))));
      const n3 = mx_noise_float(xz.mul(0.48).add(vec2(t.mul(-0.52), t.mul(0.61))));
      const d = n1.mul(0.38).add(n2.mul(0.34)).add(n3.mul(0.28));
      return positionLocal.add(normalLocal.mul(d.mul(this.ifDisp)));
    });

    const splashColorNode = Fn(() => {
      const t = this.ifTime;
      const xz = positionLocal.xz.mul(this.ifNoiseScale.mul(0.88));
      const scroll = vec2(t.mul(this.ifFlow.mul(0.92)), t.mul(this.ifFlow.mul(0.58)));
      const f1 = mx_noise_float(xz.add(scroll)).mul(0.5).add(0.5);
      const f2 = mx_noise_float(xz.mul(2.95).sub(scroll)).mul(0.5).add(0.5);
      const rn = length(positionLocal.xz).div(max(float(0.001), float(this.toolState.waterfall.splashRadius)));
      const rim = smoothstep(float(0.22), float(0.98), rn);
      const base = mix(this.ifColorA, this.ifColorB, rim);
      return mix(base, this.ifColorA, f1.mul(0.32).add(f2.mul(0.2)).clamp(0, 1));
    });

    this.splashMat = new MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    this.splashMat.positionNode = splashPosNode();
    this.splashMat.colorNode = splashColorNode();
    this.splashMat.opacityNode = this.ifOpacity;
  }

  _buildWaterfallGeometry() {
    const p = this.toolState.waterfall;
    const geo = new THREE.PlaneGeometry(p.width, p.totalHeight, 1, p.segments);
    const pos = geo.attributes.position;
    const vv = new THREE.Vector3();
    const curveStart = p.totalHeight - p.topLength;
    const curveEnd = curveStart - p.radius;
    for (let i = 0; i < pos.count; i++) {
      vv.fromBufferAttribute(pos, i);
      const cy = vv.y + p.totalHeight * 0.5;
      if (cy >= curveStart) {
        vv.y = cy;
        vv.z = 0;
      } else if (cy > curveEnd) {
        const a = ((curveStart - cy) / Math.max(0.01, p.radius)) * (Math.PI / 2);
        vv.y = curveStart - Math.sin(a) * p.radius;
        vv.z = -(p.radius - Math.cos(a) * p.radius);
      } else {
        vv.y = curveStart - p.radius;
        vv.z = -p.radius - (curveEnd - cy);
      }
      pos.setXYZ(i, vv.x, vv.y, vv.z);
    }
    geo.computeVertexNormals();
    return geo;
  }

  _buildSplashGeometry() {
    const p = this.toolState.waterfall;
    const R = Math.max(0.35, p.splashRadius);
    const phi = Math.max(0.08, Math.min(0.48, p.splashCapAngle));
    return new THREE.SphereGeometry(R, 56, 40, 0, Math.PI * 2, 0, Math.PI * phi);
  }

  placeWaterfall(point) {
    const mesh = new THREE.Mesh(this._buildWaterfallGeometry(), this.waterfallMat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.copy(point);
    mesh.renderOrder = 2;
    mesh.receiveShadow = true;
    this.scene.add(mesh);
    this.waterfallObjects.push(mesh);
    this.selectWaterfall(mesh);
  }

  placeSplashCap(point) {
    const mesh = new THREE.Mesh(this._buildSplashGeometry(), this.splashMat);
    mesh.name = "SplashCap";
    mesh.userData.isSplashCap = true;
    mesh.rotation.x = 0;
    mesh.position.copy(point);
    mesh.position.y += this.toolState.waterfall.splashYOffset;
    mesh.renderOrder = 4;
    mesh.visible = this.toolState.waterfall.splashVisible;
    this.scene.add(mesh);
    this.splashCapObjects.push(mesh);
    this.selectSplashCap(mesh);
  }

  _applySplashVisibility() {
    for (const m of this.splashCapObjects) m.visible = this.toolState.waterfall.splashVisible;
    if (this.selectedSplashCap && !this.toolState.waterfall.splashVisible) this.deselect();
  }

  selectWaterfall(mesh) {
    this.selectedSplashCap = null;
    this.selectedWaterfall = mesh;
    if (!mesh) {
      this.deselect();
      return;
    }
    this.transformControls.attach(mesh);
    this.transformControls.enabled = true;
    this.transformControls.visible = true;
  }

  selectSplashCap(mesh) {
    this.selectedWaterfall = null;
    this.selectedSplashCap = mesh;
    if (!mesh) {
      this.deselect();
      return;
    }
    this.transformControls.attach(mesh);
    this.transformControls.enabled = true;
    this.transformControls.visible = true;
  }

  deselect() {
    this.selectedWaterfall = null;
    this.selectedSplashCap = null;
    this.transformControls.detach();
    this.transformControls.enabled = false;
    this.transformControls.visible = false;
  }

  handlePointerDown(pointerNdc, camera, terrainHit) {
    if (this.transformControls.dragging) return false;
    this._raycaster.setFromCamera(pointerNdc, camera);
    const targets = [...this.waterfallObjects, ...this.splashCapObjects];
    const hits = this._raycaster.intersectObjects(targets, false);
    if (hits.length > 0) {
      const obj = hits[0].object;
      if (obj.userData?.isSplashCap) this.selectSplashCap(obj);
      else this.selectWaterfall(obj);
      return true;
    }
    if (terrainHit) {
      if (this.toolState.waterfall.placeTool === "splashCap") this.placeSplashCap(terrainHit);
      else this.placeWaterfall(terrainHit);
      return true;
    }
    return false;
  }

  deleteSelected() {
    if (this.selectedWaterfall) {
      const idx = this.waterfallObjects.indexOf(this.selectedWaterfall);
      if (idx >= 0) {
        const m = this.waterfallObjects[idx];
        this.scene.remove(m);
        m.geometry.dispose();
        this.waterfallObjects.splice(idx, 1);
      }
    } else if (this.selectedSplashCap) {
      const idx = this.splashCapObjects.indexOf(this.selectedSplashCap);
      if (idx >= 0) {
        const m = this.splashCapObjects[idx];
        this.scene.remove(m);
        m.geometry.dispose();
        this.splashCapObjects.splice(idx, 1);
      }
    }
    this.deselect();
  }

  clearAll() {
    for (const m of this.waterfallObjects) {
      this.scene.remove(m);
      m.geometry.dispose();
    }
    for (const m of this.splashCapObjects) {
      this.scene.remove(m);
      m.geometry.dispose();
    }
    this.waterfallObjects = [];
    this.splashCapObjects = [];
    this.deselect();
  }

  refreshMeshesFromParams() {
    for (const m of this.waterfallObjects) {
      const old = m.geometry;
      m.geometry = this._buildWaterfallGeometry();
      old.dispose();
    }
    for (const m of this.splashCapObjects) {
      const old = m.geometry;
      m.geometry = this._buildSplashGeometry();
      old.dispose();
    }
    this._applySplashVisibility();
  }

  syncMaterial() {
    const p = this.toolState.waterfall;
    this.wfU.wfFlowSpeed.value = p.flowSpeed;
    this.wfU.wfOpacity.value = p.opacity;
    this.wfU.darkColor.value.set(p.colorA);
    this.wfU.bodyColor.value.set(p.colorB);
    this.wfU.red_color.value.set(p.colorC);

    this.ifOpacity.value = p.splashOpacity;
    this.ifNoiseScale.value = p.splashNoiseScale;
    this.ifFlow.value = p.splashFlow;
    this.ifDisp.value = p.splashDisp;
    this.ifColorA.value.set(p.splashColorA);
    this.ifColorB.value.set(p.splashColorB);
    this._applySplashVisibility();
  }

  update(dtSec) {
    if (this.waterfallObjects.length === 0 && this.splashCapObjects.length === 0) return;
    this._time += dtSec;
    this.wfFlowTime.value = this._time * this.wfU.wfFlowSpeed.value;
    this.ifTime.value = this._time;
  }

  exportData() {
    return {
      waterfalls: this.waterfallObjects.map((m) => ({
        x: m.position.x, y: m.position.y, z: m.position.z,
        rx: m.rotation.x, ry: m.rotation.y, rz: m.rotation.z,
        sx: m.scale.x, sy: m.scale.y, sz: m.scale.z,
      })),
      splashCaps: this.splashCapObjects.map((m) => ({
        x: m.position.x, y: m.position.y, z: m.position.z,
        rx: m.rotation.x, ry: m.rotation.y, rz: m.rotation.z,
        sx: m.scale.x, sy: m.scale.y, sz: m.scale.z,
      })),
    };
  }

  importData(data) {
    this.clearAll();
    const waterfalls = Array.isArray(data)
      ? data
      : Array.isArray(data?.waterfalls)
        ? data.waterfalls
        : [];
    const splashCaps = Array.isArray(data?.splashCaps) ? data.splashCaps : [];
    for (const d of waterfalls) {
      const mesh = new THREE.Mesh(this._buildWaterfallGeometry(), this.waterfallMat);
      mesh.position.set(d.x, d.y, d.z);
      mesh.rotation.set(d.rx, d.ry, d.rz);
      mesh.scale.set(d.sx, d.sy, d.sz);
      mesh.renderOrder = 2;
      this.scene.add(mesh);
      this.waterfallObjects.push(mesh);
    }
    for (const d of splashCaps) {
      const mesh = new THREE.Mesh(this._buildSplashGeometry(), this.splashMat);
      mesh.name = "SplashCap";
      mesh.userData.isSplashCap = true;
      mesh.position.set(d.x, d.y, d.z);
      mesh.rotation.set(d.rx, d.ry, d.rz);
      mesh.scale.set(d.sx, d.sy, d.sz);
      mesh.renderOrder = 4;
      this.scene.add(mesh);
      this.splashCapObjects.push(mesh);
    }
    this._applySplashVisibility();
  }

  forEachMeshInstance(cb) {
    const M = new THREE.Matrix4();
    for (const m of this.waterfallObjects) {
      m.updateMatrixWorld(true);
      M.copy(m.matrixWorld);
      cb(m.geometry, M);
    }
    for (const m of this.splashCapObjects) {
      m.updateMatrixWorld(true);
      M.copy(m.matrixWorld);
      cb(m.geometry, M);
    }
  }

  // unified system API compatibility
  undo() {}
  redo() {}

  dispose() {
    this.clearAll();
    this.waterfallMat.dispose();
    this.splashMat.dispose();
  }
}

