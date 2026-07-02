import * as THREE from "three";
import { createJumpRampGeometry } from "../../v2/core/props/jumpRampGeometry.js";

const DEG    = Math.PI / 180;
const _dummy = new THREE.Object3D();
const _boxCenter = new THREE.Vector3();
const _proxyMat = new THREE.Matrix4();
const _centerMat = new THREE.Matrix4();

/** One box (12 tris) per prop instance for BVH — not full render mesh × instance count. */
function _proxyGeoFromMergedBox(mergedBox) {
  const size = new THREE.Vector3();
  mergedBox.getSize(size);
  size.x = Math.max(size.x, 0.001);
  size.y = Math.max(size.y, 0.001);
  size.z = Math.max(size.z, 0.001);
  return new THREE.BoxGeometry(size.x, size.y, size.z);
}

function _ensureProxyGeo(type) {
  if (!type?.mergedBox || type.proxyGeo) return;
  type.proxyGeo = _proxyGeoFromMergedBox(type.mergedBox);
}

// ── Primitive geometry factory ────────────────────────────────────────────────
const PRIMITIVE_SHAPES = ["Cube","Sphere","Cylinder","Plane","Cone","Torus","Jump ramp"];

function _makePrimitiveGeo(shape) {
  switch (shape) {
    case "Cube":     return new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    case "Sphere":   return new THREE.SphereGeometry(0.5, 16, 12).translate(0, 0.5, 0);
    case "Cylinder": return new THREE.CylinderGeometry(0.5, 0.5, 1, 16).translate(0, 0.5, 0);
    case "Plane":    return new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    case "Cone":     return new THREE.ConeGeometry(0.5, 1, 16).translate(0, 0.5, 0);
    case "Torus":    return new THREE.TorusGeometry(0.4, 0.12, 8, 24).translate(0, 0.52, 0);
    case "Jump ramp": return createJumpRampGeometry();
    default:         return null;
  }
}

export { PRIMITIVE_SHAPES };

export class PropStore {
  constructor() {
    this.types     = [];
    this.instances = [];
    this._gen      = 0;
  }

  get gen() { return this._gen; }
  _bump()   { this._gen++; }

  isLiveType(typeIdx) {
    return !!this.types[typeIdx]?.live;
  }

  // ── GLB type ────────────────────────────────────────────────────────────────

  registerType(gltfScene, name) {
    const entries   = [];
    const mergedBox = new THREE.Box3();
    gltfScene.updateMatrixWorld(true);
    const rootInv = new THREE.Matrix4().copy(gltfScene.matrixWorld).invert();

    gltfScene.traverse((child) => {
      if (!child.isMesh) return;
      const localMatrix = new THREE.Matrix4().multiplyMatrices(rootInv, child.matrixWorld);
      const geo = child.geometry;
      if (!geo.boundingBox) geo.computeBoundingBox();
      mergedBox.union(geo.boundingBox.clone().applyMatrix4(localMatrix));
      entries.push({ geometry: geo, material: child.material, localMatrix });
    });

    if (entries.length === 0) return -1;
    const idx = this.types.length;
    this.types.push({ name, entries, lod1Entries: null, lod2Entries: null, mergedBox, isPrimitive: false, live: false });
    _ensureProxyGeo(this.types[idx]);
    return idx;
  }

  registerTypeLod(typeIdx, lod, gltfScene) {
    const type = this.types[typeIdx];
    if (!type || type.live) return;
    const entries = [];
    gltfScene.updateMatrixWorld(true);
    const rootInv = new THREE.Matrix4().copy(gltfScene.matrixWorld).invert();
    gltfScene.traverse((child) => {
      if (!child.isMesh) return;
      entries.push({
        geometry:    child.geometry,
        material:    child.material,
        localMatrix: new THREE.Matrix4().multiplyMatrices(rootInv, child.matrixWorld),
      });
    });
    if (entries.length) type[lod === 1 ? "lod1Entries" : "lod2Entries"] = entries;
  }

  // ── Primitive type ──────────────────────────────────────────────────────────

  registerPrimitive(name, geometryOrShape, material = null) {
    let geometry;
    let mat;
    let shapeName = name;
    if (geometryOrShape instanceof THREE.BufferGeometry) {
      geometry = geometryOrShape;
      mat = material;
    } else {
      shapeName = geometryOrShape ?? name;
      geometry = _makePrimitiveGeo(shapeName);
      if (!geometry) return -1;
      mat = new THREE.MeshStandardMaterial({ color: 0xb8b8b8, roughness: 0.6, metalness: 0.0 });
    }
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    const yShift = -geometry.boundingBox.min.y;
    if (yShift !== 0) geometry.translate(0, yShift, 0);
    geometry.computeBoundingBox();
    const localMatrix = new THREE.Matrix4();
    const entry = { geometry, material: mat, localMatrix };
    const box = geometry.boundingBox.clone();
    const idx = this.types.length;
    this.types.push({
      name: shapeName,
      entries: [entry],
      lod1Entries: null,
      lod2Entries: null,
      mergedBox: box,
      isPrimitive: true,
      live: false,
      builtin: true,
      primShape: shapeName,
    });
    _ensureProxyGeo(this.types[idx]);
    return idx;
  }

  // ── Live / Procedural type ─────────────────────────────────────────────────
  // These are rendered by LivePropManager (THREE.Group), not InstancedMesh.

  registerLiveType(name, factoryId, defaultParams) {
    const box = new THREE.Box3(new THREE.Vector3(-0.5, 0, -0.5), new THREE.Vector3(0.5, 1, 0.5));
    const idx = this.types.length;
    this.types.push({ name, entries: [], lod1Entries: null, lod2Entries: null, mergedBox: box, isPrimitive: false, live: true, factoryId, defaultParams: { ...defaultParams } });
    return idx;
  }

  // ── Remove a type ───────────────────────────────────────────────────────────

  removeType(typeIdx) {
    // Remove all instances that use this type
    this.instances = this.instances.filter(inst => inst.typeIdx !== typeIdx);
    // Remap typeIdx for remaining instances
    for (const inst of this.instances) {
      if (inst.typeIdx > typeIdx) inst.typeIdx--;
    }
    this.types.splice(typeIdx, 1);
    this._bump();
  }

  // ── Instance management ────────────────────────────────────────────────────

  addInstance(typeIdx, px, py, pz, transform) {
    const type = this.types[typeIdx];
    const t    = transform ?? {};
    const idx  = this.instances.length;
    const inst = {
      typeIdx, px, py, pz,
      rx: t.rx ?? 0, ry: t.ry ?? 0, rz: t.rz ?? 0,
      sx: t.sx ?? 1, sy: t.sy ?? 1, sz: t.sz ?? 1,
    };
    if (type?.live) inst.liveParams = { ...type.defaultParams };
    this.instances.push(inst);
    this._bump();
    return idx;
  }

  duplicateInstance(srcIdx) {
    const src = this.instances[srcIdx];
    if (!src) return -1;
    const copy = { ...src, px: src.px + 0.6, pz: src.pz + 0.6 };
    if (src.liveParams) copy.liveParams = { ...src.liveParams };
    const idx = this.instances.length;
    this.instances.push(copy);
    this._bump();
    return idx;
  }

  removeInstance(instIdx) {
    const last = this.instances.length - 1;
    if (instIdx !== last) this.instances[instIdx] = this.instances[last];
    this.instances.pop();
    this._bump();
  }

  updateInstance(instIdx, patch) {
    const inst = this.instances[instIdx];
    if (!inst) return;
    Object.assign(inst, patch);
    this._bump();
  }

  computeInstanceMatrix(inst) {
    _dummy.position.set(inst.px, inst.py, inst.pz);
    _dummy.rotation.order = "XYZ";
    _dummy.rotation.set(inst.rx * DEG, inst.ry * DEG, inst.rz * DEG);
    _dummy.scale.set(inst.sx, inst.sy, inst.sz);
    _dummy.updateMatrix();
    return _dummy.matrix;
  }

  /**
   * BVH hook — one axis-aligned box proxy per static instance (12 tris), using
   * each type's merged bounds. Matches propInstancer hitbox placement.
   * Solid types (cliffs) are excluded — they collide with their real triangles
   * via SolidCollider instead of a box proxy.
   */
  forEachMeshInstance(cb) {
    for (const inst of this.instances) {
      const type = this.types[inst.typeIdx];
      if (!type || type.live || type.solid) continue;
      _ensureProxyGeo(type);
      if (!type.proxyGeo) continue;

      const M = this.computeInstanceMatrix(inst);
      type.mergedBox.getCenter(_boxCenter);
      _centerMat.makeTranslation(_boxCenter.x, _boxCenter.y, _boxCenter.z);
      _proxyMat.multiplyMatrices(M, _centerMat);
      cb(type.proxyGeo, _proxyMat);
    }
  }

  hasNearby(px, pz, minDist) {
    const d2 = minDist * minDist;
    for (const inst of this.instances) {
      const dx = inst.px - px; const dz = inst.pz - pz;
      if (dx * dx + dz * dz < d2) return true;
    }
    return false;
  }

  removeInRadius(wx, wz, radius) {
    const r2 = radius * radius;
    let removed = false;
    for (let i = this.instances.length - 1; i >= 0; i--) {
      const inst = this.instances[i];
      const dx = inst.px - wx; const dz = inst.pz - wz;
      if (dx * dx + dz * dz < r2) {
        const last = this.instances.length - 1;
        if (i !== last) this.instances[i] = this.instances[last];
        this.instances.pop();
        removed = true;
      }
    }
    if (removed) this._bump();
    return removed;
  }

  get totalCount() { return this.instances.length; }

  snapshot()              { return this.instances.map(i => ({ ...i, liveParams: i.liveParams ? { ...i.liveParams } : undefined })); }
  restoreFromSnapshot(s)  { this.instances = s.map(i => ({ ...i, liveParams: i.liveParams ? { ...i.liveParams } : undefined })); this._bump(); }
  clear()                 { this.instances.length = 0; this._bump(); }

  exportData() {
    return {
      types:     this.types.map(t => ({ name: t.name, live: t.live ?? false, solid: t.solid ?? false, factoryId: t.factoryId })),
      instances: this.instances.map(i => ({ ...i })),
    };
  }

  importData(data, typeNameToIdx) {
    for (const saved of data.instances) {
      const typeName  = data.types[saved.typeIdx]?.name;
      const mappedIdx = typeNameToIdx?.[typeName];
      if (mappedIdx == null) continue;
      this.instances.push({ ...saved, typeIdx: mappedIdx });
    }
    this._bump();
  }
}
