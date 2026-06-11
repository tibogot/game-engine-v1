/**
 * BillboardGrassRenderer — one InstancedMesh per slot, single draw, capacity-grown.
 *
 * Per-frame: tick uTime, update fade-distance uniforms, rebuild instance matrices
 * only when the store's _globalGen advances. No per-chunk/per-LOD pools.
 *
 * Distance fade is driven in-shader by camera position; world-wide bounding sphere
 * lets Three frustum-cull the whole mesh when off-screen.
 */
import * as THREE from "three";
import { texture, uv } from "three/tsl";
import * as BufferGeometryUtils from "three/addons/utils/BufferGeometryUtils.js";
import { createWindTexture } from "../../core/foliage/windTexture.js";
import { detectAlphaChannel } from "../foliage/foliageMaterial.js";
import {
  createBillboardGrassMaterial,
  applyBillboardGrassUniforms,
} from "./billboardGrassMaterial.js";

function stableHash01(i, seed) {
  const x = Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453123;
  return x - Math.floor(x);
}

function planeYawRadians(i, count, spread) {
  if (count <= 0) return 0;
  if (spread === "half") return (i / count) * Math.PI;
  return (i / count) * Math.PI * 2;
}

function planeTiltRadians(i, count, tilt, tiltMode, seed) {
  if (tiltMode === "symmetric") {
    if (count <= 1) return 0;
    const u = i / (count - 1);
    return (u - 0.5) * 2 * tilt;
  }
  return (stableHash01(i, seed) - 0.5) * 2 * tilt;
}

export class BillboardGrassRenderer {
  constructor(scene, config) {
    this.scene = scene;
    this.config = config;
    this.group = new THREE.Group();
    this.group.name = "BillboardGrass";
    scene.add(this.group);

    this.slotRender = [];
    this._windTex = createWindTexture();
    this._sunDir = new THREE.Vector3(0.5, 0.8, 0.3).normalize();

    this._worldMat = new THREE.Matrix4();
    this._pos = new THREE.Vector3();
    this._quat = new THREE.Quaternion();
    this._scl = new THREE.Vector3();
    this._yAxis = new THREE.Vector3(0, 1, 0);

    this._lastStoreGen = -1;
  }

  _buildGeometry(slot) {
    const geometries = [];
    const n = Math.max(1, Math.floor(slot.planeCount));
    for (let i = 0; i < n; i++) {
      const p = new THREE.PlaneGeometry(slot.width, slot.height);
      p.translate(0, slot.height / 2, 0);
      p.rotateY(planeYawRadians(i, n, slot.planeSpread));
      p.rotateX(planeTiltRadians(i, n, slot.tilt, slot.tiltMode, slot.structureSeed));
      geometries.push(p);
    }
    const merged = BufferGeometryUtils.mergeGeometries(geometries, false);
    for (const g of geometries) g.dispose();
    return merged;
  }

  _wideBounds() {
    const half = this.config.world.size * 0.5;
    return {
      sphere: new THREE.Sphere(
        new THREE.Vector3(0, 100, 0),
        Math.hypot(half, half) + 100,
      ),
      box: new THREE.Box3(
        new THREE.Vector3(-half - 10, -200, -half - 10),
        new THREE.Vector3(half + 10, 600, half + 10),
      ),
    };
  }

  _applyMaskChannel(uniforms, tex) {
    if (!uniforms?.maskInAlpha || !tex?.image) return;
    uniforms.maskInAlpha.value = detectAlphaChannel(tex.image) ? 1.0 : 0.0;
  }

  _createSlotMaterial(slot, prevTex) {
    const slotForMat =
      prevTex != null ? { ...slot, _maskNode: texture(prevTex, uv()) } : slot;
    const { material, uniforms } = createBillboardGrassMaterial(
      slotForMat,
      this._windTex,
      this._sunDir,
    );
    this._applyMaskChannel(uniforms, prevTex);
    return { material, uniforms };
  }

  _ensureCapacity(slotIdx, capacity) {
    const sr = this.slotRender[slotIdx];
    if (!sr) return null;
    if (sr.mesh && sr.capacity >= capacity) return sr.mesh;
    if (sr.mesh) {
      this.group.remove(sr.mesh);
      sr.mesh.dispose();
    }
    const cap = Math.max(capacity, 256);
    const bounds = this._wideBounds();
    sr.geometry.boundingSphere = bounds.sphere;
    sr.geometry.boundingBox = bounds.box;
    const im = new THREE.InstancedMesh(sr.geometry, sr.material, cap);
    im.castShadow = false;
    im.receiveShadow = false;
    im.frustumCulled = true;
    im.count = 0;
    this.group.add(im);
    sr.mesh = im;
    sr.capacity = cap;
    return im;
  }

  rebuildSlot(slotIdx, slot) {
    const prevTex = this.slotRender[slotIdx]?.textureObj ?? null;
    const prev = this.slotRender[slotIdx];
    if (prev) {
      if (prev.mesh) {
        this.group.remove(prev.mesh);
        prev.mesh.dispose();
      }
      prev.geometry?.dispose();
      prev.material?.dispose();
    }
    while (this.slotRender.length <= slotIdx) this.slotRender.push(null);
    this.slotRender[slotIdx] = null;

    if (!slot?.enabled) return;

    const geometry = this._buildGeometry(slot);
    const { material, uniforms } = this._createSlotMaterial(slot, prevTex);

    this.slotRender[slotIdx] = {
      geometry,
      material,
      uniforms,
      mesh: null,
      capacity: 0,
      textureObj: prevTex,
    };
    this._lastStoreGen = -1;
  }

  setSlotTexture(slotIdx, tex, slotConfig = null) {
    const sr = this.slotRender[slotIdx];
    if (!sr) return;
    if (tex) {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.generateMipmaps = true;
      tex.needsUpdate = true;
    }
    sr.textureObj = tex;
    const { material, uniforms } = this._createSlotMaterial(slotConfig || {}, tex);
    sr.material.dispose();
    sr.material = material;
    sr.uniforms = uniforms;
    if (sr.mesh) sr.mesh.material = material;
  }

  updateSlotUniforms(slotIdx, slot) {
    const sr = this.slotRender[slotIdx];
    if (!sr?.uniforms) return;
    applyBillboardGrassUniforms(sr.uniforms, slot);
    if (slot.alphaTest != null) sr.material.alphaTest = slot.alphaTest;
    if (sr.textureObj) this._applyMaskChannel(sr.uniforms, sr.textureObj);
  }

  _rebuildAllInstances(grassStore) {
    const bySlot = new Map();
    for (const items of grassStore.chunks.values()) {
      for (const f of items) {
        let arr = bySlot.get(f.slotIdx);
        if (!arr) {
          arr = [];
          bySlot.set(f.slotIdx, arr);
        }
        arr.push(f);
      }
    }
    for (let i = 0; i < this.slotRender.length; i++) {
      const sr = this.slotRender[i];
      if (!sr) continue;
      const list = bySlot.get(i) ?? [];
      const mesh = this._ensureCapacity(i, list.length);
      if (!mesh) continue;
      const n = list.length;
      for (let k = 0; k < n; k++) {
        const f = list[k];
        this._pos.set(f.x, f.y ?? 0, f.z);
        this._quat.setFromAxisAngle(this._yAxis, f.rotY);
        this._scl.setScalar(f.scale);
        this._worldMat.compose(this._pos, this._quat, this._scl);
        mesh.setMatrixAt(k, this._worldMat);
      }
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /**
   * @param {import("../../core/billboardGrass/billboardGrassStore.js").BillboardGrassStore} grassStore
   * @param {THREE.Camera} camera
   * @param {{ lod0Distance?: number, lod1Distance?: number, fadeOutDistance?: number, aerialFadeStrength?: number, lodHysteresis?: number }} lodCfg
   * @param {object[]} _grassSlots — kept for call-site compatibility
   * @param {{ aerialStrict?: boolean }} [perfOpts]
   */
  update(grassStore, camera, lodCfg, _grassSlots, perfOpts = {}) {
    const camY = camera.position.y;
    const fadeEnd = lodCfg.fadeOutDistance ?? 280;
    const aerial = lodCfg.aerialFadeStrength ?? 1;
    const boost = perfOpts?.aerialStrict ? 1.35 : 1;
    const alt = Math.max(0, camY - 25);
    const fEnd = Math.max(fadeEnd / (1 + alt * 0.012 * aerial * boost), fadeEnd * 0.45);
    const fStart = fEnd * 0.75;

    for (const sr of this.slotRender) {
      if (!sr?.uniforms) continue;
      if (sr.uniforms.fadeStart) sr.uniforms.fadeStart.value = fStart;
      if (sr.uniforms.fadeEnd) sr.uniforms.fadeEnd.value = fEnd;
    }

    const gen = grassStore._globalGen;
    if (gen !== this._lastStoreGen) {
      this._rebuildAllInstances(grassStore);
      this._lastStoreGen = gen;
    }
  }

  updateTime(t) {
    for (const sr of this.slotRender) {
      if (!sr?.uniforms?.time) continue;
      sr.uniforms.time.value = t;
    }
  }

  updateSunDirection(dir) {
    this._sunDir.copy(dir);
    for (const sr of this.slotRender) {
      if (!sr?.uniforms?.sunDir) continue;
      sr.uniforms.sunDir.value.copy(dir);
    }
  }

  dispose() {
    for (let i = 0; i < this.slotRender.length; i++) {
      const sr = this.slotRender[i];
      if (!sr) continue;
      if (sr.mesh) {
        this.group.remove(sr.mesh);
        sr.mesh.dispose();
      }
      sr.geometry?.dispose();
      sr.material?.dispose();
    }
    this.slotRender.length = 0;
    this.scene.remove(this.group);
    this._windTex?.dispose();
  }
}
