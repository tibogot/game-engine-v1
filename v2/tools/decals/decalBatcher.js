/**
 * Instanced decal rendering: one InstancedMesh per (texture + opacity bucket).
 * Invisible hit proxies for reliable ray picking. Solo meshes for conformed decals.
 */

import * as THREE from "three";

const _planeGeo = new THREE.PlaneGeometry(1, 1);
_planeGeo.rotateX(-Math.PI / 2);

const _hitGeo = new THREE.BoxGeometry(1, 0.14, 1);
const _hitMat = new THREE.MeshBasicMaterial({ visible: false });

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const DECAL_RENDER_ORDER = 20;
const DECAL_POLY_OFFSET_FACTOR = -8;
const DECAL_POLY_OFFSET_UNITS = -8;

function bucketKey(textureSrc, opacity) {
  return `${textureSrc}\n${opacity.toFixed(4)}`;
}

function matrixFromDecal(d, target) {
  _p.set(d.px, d.py, d.pz);
  _q.set(d.qx, d.qy, d.qz, d.qw);
  _s.set(d.sx, d.sy, d.sz);
  return target.compose(_p, _q, _s);
}

function decalFromMatrix(d, matrix) {
  matrix.decompose(_p, _q, _s);
  d.px = _p.x;
  d.py = _p.y;
  d.pz = _p.z;
  d.qx = _q.x;
  d.qy = _q.y;
  d.qz = _q.z;
  d.qw = _q.w;
  d.sx = _s.x;
  d.sy = _s.y;
  d.sz = _s.z;
}

export class DecalBatcher {
  constructor(scene) {
    this.root = new THREE.Group();
    this.root.name = "DecalBatcher";
    scene.add(this.root);

    this.soloParent = new THREE.Group();
    this.soloParent.name = "DecalSolo";
    this.root.add(this.soloParent);

    /** @type {Map<string, { visual: THREE.InstancedMesh, hit: THREE.InstancedMesh, mat: THREE.MeshBasicMaterial, indices: number[] }>} */
    this._buckets = new Map();
    /** global decal index -> { visual, hit, slot } */
    this._indexToSlot = new Map();
  }

  /**
   * @param {Array<object>} decals — records with px..sz, qx..qw, opacity, textureSrc; soloMesh skips batch
   * @param {Map<string, THREE.Texture>} textures — must include every batched decal's textureSrc
   */
  rebuild(decals, textures) {
    this.disposeBuckets();

    for (const d of decals) {
      if (d.soloMesh) {
        if (d.soloMesh.parent !== this.soloParent) this.soloParent.add(d.soloMesh);
      }
    }

    const groups = new Map();
    for (let i = 0; i < decals.length; i++) {
      const d = decals[i];
      if (d.soloMesh) continue;
      const tex = textures.get(d.textureSrc);
      if (!tex) continue;
      const key = bucketKey(d.textureSrc, d.opacity);
      if (!groups.has(key)) groups.set(key, { tex, opacity: d.opacity, indices: [] });
      groups.get(key).indices.push(i);
    }

    for (const [bkey, { tex, opacity, indices }] of groups) {
      const n = indices.length;
      const mat = new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        opacity,
        alphaTest: 0.02,
        depthTest: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: DECAL_POLY_OFFSET_FACTOR,
        polygonOffsetUnits: DECAL_POLY_OFFSET_UNITS,
        side: THREE.DoubleSide,
      });
      if (tex.colorSpace !== THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;

      const visual = new THREE.InstancedMesh(_planeGeo, mat, n);
      const hit = new THREE.InstancedMesh(_hitGeo, _hitMat, n);
      visual.count = n;
      hit.count = n;
      visual.frustumCulled = false;
      hit.frustumCulled = false;
      visual.renderOrder = DECAL_RENDER_ORDER;
      visual.castShadow = false;
      visual.receiveShadow = false;

      for (let j = 0; j < n; j++) {
        const d = decals[indices[j]];
        matrixFromDecal(d, _m);
        visual.setMatrixAt(j, _m);
        hit.setMatrixAt(j, _m);
        this._indexToSlot.set(indices[j], { visual, hit, slot: j });
      }
      visual.instanceMatrix.needsUpdate = true;
      hit.instanceMatrix.needsUpdate = true;

      visual.userData._decalIndices = indices;
      hit.userData._decalIndices = indices;

      this.root.add(visual);
      this.root.add(hit);
      this._buckets.set(bkey, { visual, hit, mat, indices });
    }
  }

  disposeBuckets() {
    for (const { visual, hit, mat } of this._buckets.values()) {
      this.root.remove(visual);
      this.root.remove(hit);
      mat.dispose();
    }
    this._buckets.clear();
    this._indexToSlot.clear();
  }

  /**
   * @param {number} globalIdx
   * @param {THREE.Matrix4} matrix
   */
  writeInstanceMatrix(globalIdx, matrix) {
    const slot = this._indexToSlot.get(globalIdx);
    if (!slot) return;
    slot.visual.setMatrixAt(slot.slot, matrix);
    slot.hit.setMatrixAt(slot.slot, matrix);
    slot.visual.instanceMatrix.needsUpdate = true;
    slot.hit.instanceMatrix.needsUpdate = true;
  }

  /**
   * @param {THREE.Raycaster} raycaster
   * @param {Array<object>} decals
   * @returns {{ index: number } | null}
   */
  raycast(raycaster, decals) {
    let best = null;
    let bestD = Infinity;

    for (const { hit, indices } of this._buckets.values()) {
      const hits = raycaster.intersectObject(hit, false);
      if (hits.length && hits[0].distance < bestD) {
        bestD = hits[0].distance;
        const slot = hits[0].instanceId;
        const gIdx = indices[slot];
        if (gIdx != null) best = { index: gIdx };
      }
    }

    for (let i = 0; i < decals.length; i++) {
      const d = decals[i];
      if (!d.soloMesh) continue;
      const hits = raycaster.intersectObject(d.soloMesh, false);
      if (hits.length && hits[0].distance < bestD) {
        bestD = hits[0].distance;
        best = { index: i };
      }
    }

    return best;
  }

  dispose() {
    this.disposeBuckets();
    const solo = [...this.soloParent.children];
    for (const m of solo) {
      this.soloParent.remove(m);
      if (m.geometry) m.geometry.dispose();
      if (m.material) {
        m.material.map = null;
        m.material.dispose();
      }
    }
    this.root.parent?.remove(this.root);
  }
}

export { matrixFromDecal, decalFromMatrix };
