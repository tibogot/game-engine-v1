/**
 * Decal authoring: place, select, transform, conform-to-terrain, JSON + project hooks.
 * Renders via DecalBatcher (instanced per texture+opacity). Conformed decals become solo meshes.
 */

import * as THREE from "three";
import { DecalBatcher, matrixFromDecal, decalFromMatrix } from "./decalBatcher.js";

const _ray = new THREE.Raycaster();
const _ndc = new THREE.Vector2();
const _mx = new THREE.Matrix4();
const _up = new THREE.Vector3(0, 1, 0);
const _n = new THREE.Vector3();
const _qAlign = new THREE.Quaternion();
const DECAL_RENDER_ORDER = 20;
const DECAL_POLY_OFFSET_FACTOR = -8;
const DECAL_POLY_OFFSET_UNITS = -8;

function createDecalRecord({
  id,
  textureSrc,
  px, py, pz,
  qx = 0, qy = 0, qz = 0, qw = 1,
  sx = 4, sy = 1, sz = 4,
  opacity = 1,
  soloMesh = null,
}) {
  return {
    id,
    textureSrc,
    px, py, pz,
    qx, qy, qz, qw,
    sx, sy, sz,
    opacity,
    soloMesh,
  };
}

export class DecalSystem {
  /**
   * @param {object} deps
   * @param {THREE.Scene} deps.scene
   * @param {object} deps.toolState
   * @param {THREE.TransformControls} deps.transformControls
   * @param {() => number} deps.getWorldHeight
   * @param {import("../road/roadSystem.js").RoadSystem} deps.roadSystem
   * @param {import("../../core/streaming/chunkStreamManager.js").ChunkStreamManager} deps.chunkStream
   */
  constructor({ scene, toolState, transformControls, getWorldHeight, roadSystem, chunkStream }) {
    this.scene = scene;
    this._ts = toolState;
    this._tc = transformControls;
    this._getH = getWorldHeight;
    this._road = roadSystem;
    this._chunks = chunkStream;

    this._batcher = new DecalBatcher(scene);
    /** @type {ReturnType<typeof createDecalRecord>[]} */
    this.decals = [];
    this._nextId = 1;
    this._selectedIndex = -1;

    /** @type {Map<string, THREE.Texture>} */
    this._textures = new Map();

    this.proxyObject = new THREE.Object3D();
    this.proxyObject.name = "DecalProxy";
    scene.add(this.proxyObject);

    /** Active brush texture (data URL or path) for new placements */
    this.activeTextureSrc = null;
    this._activeTexObj = null;

    this._loader = new THREE.TextureLoader();
  }

  get selectedIndex() {
    return this._selectedIndex;
  }

  _rebuild() {
    this._batcher.rebuild(this.decals, this._textures);
  }

  /**
   * @param {THREE.Camera} camera
   */
  pickSurface(camera, clientX, clientY, domElement) {
    const rect = domElement.getBoundingClientRect();
    _ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    _ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    _ray.setFromCamera(_ndc, camera);

    const targets = [...this._chunks.raycastMeshes(), ...this._road.getRoadMeshes()];
    if (targets.length === 0) return null;
    const hits = _ray.intersectObjects(targets, false);
    if (hits.length === 0) return null;
    const h = hits[0];
    const normal = h.face
      ? _n.copy(h.face.normal).transformDirection(h.object.matrixWorld).normalize()
      : _up.clone();
    if (normal.lengthSq() < 1e-8) normal.set(0, 1, 0);
    return { point: h.point.clone(), normal };
  }

  ensureTextureLoaded(src) {
    if (!src) return Promise.resolve(null);
    const cached = this._textures.get(src);
    if (cached) return Promise.resolve(cached);
    if (this._pending && this._pending.has(src)) return this._pending.get(src);

    const p = new Promise((resolve, reject) => {
      this._loader.load(
        src,
        (tex) => {
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.needsUpdate = true;
          this._textures.set(src, tex);
          this._pending?.delete(src);
          resolve(tex);
        },
        undefined,
        (err) => {
          this._pending?.delete(src);
          reject(err);
        },
      );
    });
    if (!this._pending) this._pending = new Map();
    this._pending.set(src, p);
    return p;
  }

  loadImageFromFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result;
        this.ensureTextureLoaded(dataUrl)
          .then((tex) => {
            this.activeTextureSrc = dataUrl;
            this._activeTexObj = tex;
            resolve(tex);
          })
          .catch(reject);
      };
      reader.onerror = () => reject(new Error("read fail"));
      reader.readAsDataURL(file);
    });
  }

  openImagePicker() {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = "image/*";
    inp.onchange = () => {
      const f = inp.files?.[0];
      if (f) this.loadImageFromFile(f).catch((e) => console.warn("[Decals] load image", e));
    };
    inp.click();
  }

  placeAt(hit) {
    const src = this.activeTextureSrc;
    if (!src) {
      console.warn("[Decals] Load an image first (Decals pane).");
      return null;
    }
    const p = this._ts.decal;
    const { point, normal } = hit;
    const yOff = p.heightOffset;
    const useAlign = p.alignToNormal;

    let qx = 0, qy = 0, qz = 0, qw = 1;
    if (useAlign) {
      _qAlign.setFromUnitVectors(_up, normal);
      qx = _qAlign.x;
      qy = _qAlign.y;
      qz = _qAlign.z;
      qw = _qAlign.w;
    }

    const sc = p.defaultScale;
    const rec = createDecalRecord({
      id: this._nextId++,
      textureSrc: src,
      px: point.x,
      py: point.y + yOff,
      pz: point.z,
      qx, qy, qz, qw,
      sx: sc,
      sy: 1,
      sz: sc,
      opacity: p.opacity,
    });

    this.ensureTextureLoaded(src)
      .then(() => {
        this.decals.push(rec);
        this._rebuild();
        this.selectByIndex(this.decals.length - 1);
      })
      .catch((e) => console.warn("[Decals] texture load failed", e));
    return rec;
  }

  selectByIndex(i) {
    if (i < 0 || i >= this.decals.length) {
      this.deselect();
      return;
    }
    this._selectedIndex = i;
    const d = this.decals[i];
    if (d.soloMesh) {
      this._tc.attach(d.soloMesh);
    } else {
      matrixFromDecal(d, _mx);
      _mx.decompose(
        this.proxyObject.position,
        this.proxyObject.quaternion,
        this.proxyObject.scale,
      );
      this._tc.attach(this.proxyObject);
    }
    this._tc.enabled = true;
    this._tc.visible = true;
    this._tc.setMode(this._ts.decal.transformMode || "translate");
  }

  deselect() {
    this._selectedIndex = -1;
    this._tc.detach();
    if (this._ts.mode !== "decals") {
      this._tc.enabled = false;
      this._tc.visible = false;
    }
  }

  handlePointerDown(camera, clientX, clientY, domElement) {
    if (this._tc.dragging) return false;

    const rect = domElement.getBoundingClientRect();
    _ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    _ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    _ray.setFromCamera(_ndc, camera);

    const pick = this._batcher.raycast(_ray, this.decals);
    if (pick) {
      this.selectByIndex(pick.index);
      return true;
    }

    const surf = this.pickSurface(camera, clientX, clientY, domElement);
    if (surf) {
      this.placeAt(surf);
      return true;
    }
    return false;
  }

  handleTransformChange() {
    const i = this._selectedIndex;
    if (i < 0) return;
    const d = this.decals[i];
    if (d.soloMesh) return;

    _mx.compose(
      this.proxyObject.position,
      this.proxyObject.quaternion,
      this.proxyObject.scale,
    );
    decalFromMatrix(d, _mx);
    this._batcher.writeInstanceMatrix(i, _mx);
  }

  handleTransformEnd() {
    const i = this._selectedIndex;
    if (i < 0) return;
    const d = this.decals[i];
    if (d.soloMesh) {
      d.px = d.soloMesh.position.x;
      d.py = d.soloMesh.position.y;
      d.pz = d.soloMesh.position.z;
      d.qx = d.soloMesh.quaternion.x;
      d.qy = d.soloMesh.quaternion.y;
      d.qz = d.soloMesh.quaternion.z;
      d.qw = d.soloMesh.quaternion.w;
      d.sx = d.soloMesh.scale.x;
      d.sy = d.soloMesh.scale.y;
      d.sz = d.soloMesh.scale.z;
      return;
    }
    _mx.compose(
      this.proxyObject.position,
      this.proxyObject.quaternion,
      this.proxyObject.scale,
    );
    decalFromMatrix(d, _mx);
    this._rebuild();
    this.selectByIndex(i);
  }

  deleteSelected() {
    const i = this._selectedIndex;
    if (i < 0) return;
    const d = this.decals[i];
    if (d.soloMesh) {
      this._batcher.soloParent.remove(d.soloMesh);
      d.soloMesh.geometry?.dispose();
      if (d.soloMesh.material) {
        d.soloMesh.material.map = null;
        d.soloMesh.material.dispose();
      }
      d.soloMesh = null;
    }
    const tex = this._textures.get(d.textureSrc);
    this.decals.splice(i, 1);
    this._rebuild();
    const still = this.decals.some((x) => x.textureSrc === d.textureSrc);
    if (!still && tex && d.textureSrc !== this.activeTextureSrc) {
      tex.dispose();
      this._textures.delete(d.textureSrc);
    }
    this.deselect();
  }

  clearAll() {
    for (const d of this.decals) {
      if (d.soloMesh) {
        d.soloMesh.geometry?.dispose();
        if (d.soloMesh.material) {
          d.soloMesh.material.map = null;
          d.soloMesh.material.dispose();
        }
      }
    }
    this.decals.length = 0;
    for (const [, t] of this._textures) {
      t.dispose();
    }
    this._textures.clear();
    this.activeTextureSrc = null;
    this._activeTexObj = null;
    this._rebuild();
    this.deselect();
  }

  refitSelectedToTerrain() {
    const i = this._selectedIndex;
    if (i < 0) return;
    const d = this.decals[i];
    const p = this._ts.decal;
    const yOff = p.heightOffset;
    const tex = this._textures.get(d.textureSrc);
    if (!tex) return;

    matrixFromDecal(d, _mx);
    const tmp = new THREE.Object3D();
    _mx.decompose(tmp.position, tmp.quaternion, tmp.scale);
    tmp.updateMatrixWorld(true);

    const subdiv = Math.max(4, Math.min(64, p.conformSubdiv ?? 32));
    const geo = new THREE.PlaneGeometry(1, 1, subdiv, subdiv);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const v = new THREE.Vector3();
    for (let k = 0; k < pos.count; k++) {
      v.set(pos.getX(k), pos.getY(k), pos.getZ(k));
      tmp.localToWorld(v);
      v.y = this._getH(v.x, v.z) + yOff;
      tmp.worldToLocal(v);
      pos.setXYZ(k, v.x, v.y, v.z);
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();

    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      opacity: d.opacity,
      alphaTest: 0.02,
      depthTest: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: DECAL_POLY_OFFSET_FACTOR,
      polygonOffsetUnits: DECAL_POLY_OFFSET_UNITS,
      side: THREE.DoubleSide,
    });
    const newMesh = new THREE.Mesh(geo, mat);
    newMesh.renderOrder = DECAL_RENDER_ORDER;
    newMesh.matrix.copy(tmp.matrixWorld);
    newMesh.matrix.decompose(newMesh.position, newMesh.quaternion, newMesh.scale);

    if (d.soloMesh) {
      this._batcher.soloParent.remove(d.soloMesh);
      d.soloMesh.geometry.dispose();
      d.soloMesh.material.map = null;
      d.soloMesh.material.dispose();
    }
    d.soloMesh = newMesh;
    newMesh.userData.decalId = d.id;
    this._batcher.soloParent.add(newMesh);

    d.px = newMesh.position.x;
    d.py = newMesh.position.y;
    d.pz = newMesh.position.z;
    d.qx = newMesh.quaternion.x;
    d.qy = newMesh.quaternion.y;
    d.qz = newMesh.quaternion.z;
    d.qw = newMesh.quaternion.w;
    d.sx = newMesh.scale.x;
    d.sy = newMesh.scale.y;
    d.sz = newMesh.scale.z;

    this._rebuild();
    this.selectByIndex(i);
  }

  applyOpacityToSelected() {
    const i = this._selectedIndex;
    if (i < 0) return;
    const d = this.decals[i];
    d.opacity = this._ts.decal.opacity;
    if (d.soloMesh && d.soloMesh.material) d.soloMesh.material.opacity = d.opacity;
    this._rebuild();
    this.selectByIndex(i);
  }

  setTransformMode(mode) {
    this._ts.decal.transformMode = mode;
    this._tc.setMode(mode);
  }

  exportData() {
    return this.decals.map((d) => ({
      textureSrc: d.textureSrc,
      px: d.px,
      py: d.py,
      pz: d.pz,
      qx: d.qx,
      qy: d.qy,
      qz: d.qz,
      qw: d.qw,
      sx: d.sx,
      sy: d.sy,
      sz: d.sz,
      opacity: d.opacity,
    }));
  }

  async importData(arr) {
    this.clearAll();
    if (!Array.isArray(arr)) return;
    for (const item of arr) {
      const src = item.textureSrc ?? item.textureUrl;
      if (!src) continue;
      let qx = item.qx;
      let qy = item.qy;
      let qz = item.qz;
      let qw = item.qw;
      if (qx == null && item.rx != null) {
        const eu = new THREE.Euler(item.rx, item.ry, item.rz, "XYZ");
        _qAlign.setFromEuler(eu);
        qx = _qAlign.x;
        qy = _qAlign.y;
        qz = _qAlign.z;
        qw = _qAlign.w;
      }
      const rec = createDecalRecord({
        id: this._nextId++,
        textureSrc: src,
        px: item.px ?? item.x,
        py: item.py ?? item.y,
        pz: item.pz ?? item.z,
        qx: qx ?? 0,
        qy: qy ?? 0,
        qz: qz ?? 0,
        qw: qw ?? 1,
        sx: item.sx ?? 4,
        sy: item.sy ?? 1,
        sz: item.sz ?? 4,
        opacity: item.opacity ?? 1,
      });
      try {
        await this.ensureTextureLoaded(rec.textureSrc);
      } catch {
        continue;
      }
      this.decals.push(rec);
    }
    this._rebuild();
    this.deselect();
  }

  undo() {}
  redo() {}

  dispose() {
    this.clearAll();
    this._batcher.dispose();
    this.scene.remove(this.proxyObject);
  }
}
